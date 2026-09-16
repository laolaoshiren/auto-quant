import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  STRATEGY_PRESETS,
  defaultStrategyConfig,
  type MarketSnapshot,
  type StrategyConfig,
} from '@aq/shared';
import type { BinanceBroker, ExchangePosition, PlacedOrder } from '../binance/broker.js';
import { BinanceApiError, type BinanceAlgoOrderResponse, type BinanceOrderResponse, type BinanceUserTrade } from '../binance/types.js';
import type { SymbolRegistry } from '../binance/symbols.js';
import { closeDb, getDb, initDb } from '../db/index.js';
import { eventBus } from '../events.js';
import { classifyHttpError, LlmError } from '../llm/errors.js';
import type { MarketDataService } from '../market/service.js';
import {
  computeTraderStats,
  decisions as decisionStore,
  equity as equityStore,
  exchanges,
  aiModels,
  orders as orderStore,
  positions as positionStore,
  strategies as strategyStore,
  traders,
  trades as tradeStore,
} from '../store/repositories.js';
import { AutoTrader, describeCycleFailure, type DecisionModel } from './autoTrader.js';

/* -------------------------------------------------------------------------- */
/*  Harness                                                                    */
/* -------------------------------------------------------------------------- */

let workDir: string;
const SYMBOL = 'BTCUSDT';
const MARK_PRICE = 68_000;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-integration-'));
  initDb(path.join(workDir, 'test.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

let traderId = 0;

beforeEach(() => {
  // A clean slate per test: the in-memory database is shared across the file.
  const db = initDb(path.join(workDir, 'test.sqlite'));
  db.exec(`
    DELETE FROM trades; DELETE FROM orders; DELETE FROM positions;
    DELETE FROM decision_records; DELETE FROM equity_snapshots;
    DELETE FROM trade_events; DELETE FROM traders; DELETE FROM strategies;
    DELETE FROM ai_models; DELETE FROM exchange_accounts;
  `);

  const account = exchanges.create({
    exchange: 'binance',
    label: 'test',
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: 'test',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 120,
    maxRetries: 3,
  });
  const strategy = strategyStore.create({
    name: 'test',
    description: '',
    config: permissiveConfig(),
    presetId: null,
  });
  traderId = traders.create({
    name: 'integration',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;
});

/** Loosened limits so a cycle can actually place an order. */
function permissiveConfig(): StrategyConfig {
  const base = { ...defaultStrategyConfig(), ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>) };
  return {
    ...base,
    riskControl: {
      ...base.riskControl,
      maxPositions: 3,
      minConfidence: 50,
      minRiskRewardRatio: 1.5,
      maxMarginUsage: 100,
      minPositionSize: 5,
      btcEthMaxPositionValueRatio: 10,
      altcoinMaxPositionValueRatio: 5,
    },
    throttle: { minHoldMinutes: 0, reentryCooldownMinutes: 0, maxEntriesPerCycle: 3, maxEntriesPerHour: 10 },
    circuitBreaker: {
      maxDailyLossPercent: 0,
      maxTotalDrawdownPercent: 0,
      safeModeAfterFailures: 3,
      safeModeProbeCycles: 3,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Doubles                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * An in-memory exchange.
 *
 * Tracks positions so that open → protect → close can be exercised without a
 * network call, and records which endpoints/parameters the trader asked for.
 */
class FakeBroker {
  readonly placed: Array<Parameters<BinanceBroker['placeOrder']>[0]> = [];
  readonly cancelledSymbols: string[] = [];
  readonly leverageCalls: Array<{ symbol: string; leverage: number }> = [];
  /** Mutable mark price: price drift between the decision and execution is D1. */
  markPrice = MARK_PRICE;
  /**
   * 钱包（已结算）余额。
   *
   * 默认是 fixture 一直用的 1000；共账户的用例需要它随已实现盈亏变化 ——
   * 那正是"账户里有多少钱"与"这个机器人挣了多少"分道扬镳的地方。
   */
  walletBalance = 1000;
  /** Set to make conditional orders fail, as a stop on the wrong side does. */
  rejectStops = false;
  /** Set to make the next reduce-only market order fill only this fraction. */
  partialFillRatio: number | null = null;
  /** `/fapi/v1/income` events, for funding attribution. */
  income: Array<{ symbol: string; incomeType: string; income: string; time: number }> = [];
  private positions: ExchangePosition[] = [];
  private nextId = 1000;

  async getAccountState() {
    const unrealized = this.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    return {
      equity: this.walletBalance + unrealized,
      walletBalance: this.walletBalance,
      availableBalance: 800,
      unrealizedPnl: unrealized,
      marginUsed: 200,
      openOrderMargin: 0,
    };
  }

  async getPositions(symbol?: string) {
    return symbol ? this.positions.filter((p) => p.symbol === symbol) : [...this.positions];
  }

  async setLeverage(symbol: string, leverage: number) {
    this.leverageCalls.push({ symbol, leverage });
    return { ok: true, leverage };
  }

  async ensureOneWayMode() {
    return { changed: false, warning: null };
  }

  async placeOrder(request: Parameters<BinanceBroker['placeOrder']>[0]): Promise<PlacedOrder> {
    this.placed.push(request);
    const id = String(this.nextId++);
    const isConditional = request.type === 'STOP_MARKET' || request.type === 'TAKE_PROFIT_MARKET';

    if (isConditional && this.rejectStops) {
      // Mirrors the real broker: a conditional order whose trigger is already on
      // the wrong side of the market is refused with `-2021` before it is sent.
      throw new Error(
        `${request.symbol} 的 ${request.type} 触发价 ${request.triggerPrice} 会立即触发（当前标记价 ${this.markPrice}），已拒绝下单`,
      );
    }

    /*
     * The fill ratio for a reduce-only order, consumed exactly once.
     *
     * Non-reduce-only orders must leave it alone: an opening market order that
     * cleared the flag would silently let the following exit fill in full and
     * make every partial-fill test pass vacuously.
     */
    const ratio = request.reduceOnly ? this.partialFillRatio : null;
    if (ratio !== null) this.partialFillRatio = null;
    const partial = ratio !== null;

    if (!isConditional) {
      // Market orders fill instantly and update the simulated position book.
      if (request.reduceOnly) {
        /*
         * 已结算盈亏真的会进钱包。
         *
         * `getAccountState()` 的权益因此会随着平仓变化，而不是永远 1000 + 浮盈 ——
         * 这正是"账户里有多少钱"与"这个机器人挣了多少"分道扬镳的地方，共账户的
         * 用例要靠这个区别才能证明归属权益不是账户权益。
         *
         * A reduce-only order removes only what it actually filled. Modelling a
         * partial exit as a full flatten would hide the very state under test.
         */
        const quantity = request.quantity ?? 0;
        const closing = this.positions.find((p) => p.symbol === request.symbol);
        const filled = closing ? Math.min(quantity, closing.quantity) : 0;
        if (closing && filled > 0) {
          const direction = closing.side === 'long' ? 1 : -1;
          this.walletBalance += (this.markPrice - closing.entryPrice) * filled * direction;
        }
        const remainder = quantity * (1 - (ratio ?? 1));
        if (remainder <= 1e-12) {
          this.positions = this.positions.filter((p) => p.symbol !== request.symbol);
        } else {
          this.positions = this.positions.map((p) =>
            p.symbol === request.symbol ? { ...p, quantity: remainder } : p,
          );
        }
      } else {
        const quantity = request.quantity ?? 0;
        this.positions.push({
          symbol: request.symbol,
          side: request.side === 'BUY' ? 'long' : 'short',
          quantity,
          entryPrice: this.markPrice,
          markPrice: this.markPrice,
          leverage: 3,
          liquidationPrice: null,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          marginUsed: (quantity * this.markPrice) / 3,
          notional: quantity * this.markPrice,
          marginType: 'cross',
        });
      }
    }

    if (isConditional) {
      const raw: BinanceAlgoOrderResponse = {
        algoId: Number(id),
        clientAlgoId: request.clientOrderId ?? id,
        algoType: 'CONDITIONAL',
        orderType: request.type as BinanceAlgoOrderResponse['orderType'],
        symbol: request.symbol,
        side: request.side,
        positionSide: 'BOTH',
        timeInForce: 'GTC',
        quantity: String(request.quantity ?? 0),
        algoStatus: 'NEW',
        triggerPrice: String(request.triggerPrice ?? 0),
        price: '0',
        closePosition: request.closePosition ?? false,
        reduceOnly: request.reduceOnly ?? false,
        workingType: request.workingType ?? 'MARK_PRICE',
        priceProtect: request.priceProtect ?? true,
        createTime: 0,
        updateTime: 0,
        triggerTime: 0,
      };
      return {
        kind: 'algo',
        id,
        clientId: raw.clientAlgoId,
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        status: 'NEW',
        avgPrice: 0,
        executedQty: 0,
        // Untriggered: the stop is resting, not filled.
        terminal: false,
        raw,
      };
    }

    const requestedQty = request.quantity ?? 0;
    // A timed-out exit comes back partly filled: the runtime must not treat the
    // requested size as the executed size.
    const filledQty = partial ? requestedQty * ratio! : requestedQty;
    const status = partial ? 'PARTIALLY_FILLED' : 'FILLED';
    const raw: BinanceOrderResponse = {
      orderId: Number(id),
      clientOrderId: request.clientOrderId ?? id,
      symbol: request.symbol,
      side: request.side,
      type: request.type as BinanceOrderResponse['type'],
      status: status as BinanceOrderResponse['status'],
      avgPrice: String(this.markPrice),
      executedQty: String(filledQty),
      origQty: String(requestedQty),
      price: '0',
      cumQty: String(filledQty),
      cumQuote: String(filledQty * this.markPrice),
      reduceOnly: request.reduceOnly ?? false,
      positionSide: 'BOTH',
      stopPrice: '0',
      closePosition: false,
      timeInForce: 'GTC',
      origType: request.type as BinanceOrderResponse['origType'],
      updateTime: 0,
      workingType: 'MARK_PRICE',
      priceProtect: false,
    };

    return {
      kind: 'order',
      id,
      clientId: raw.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status,
      avgPrice: this.markPrice,
      executedQty: filledQty,
      terminal: true,
      raw,
    };
  }

  async waitForFill(order: PlacedOrder) {
    return order;
  }

  async cancelAllOrders(symbol: string) {
    this.cancelledSymbols.push(symbol);
  }

  async getUserTrades() {
    return this.userTrades;
  }

  /** 一次性探针用：交易所成交历史。 */
  userTrades: BinanceUserTrade[] = [];

  async getIncome() {
    return this.income;
  }

  async getMarkPrice() {
    return this.markPrice;
  }

  async getOpenAlgoOrders() {
    return [];
  }

  /** Test helper: make the position vanish as if the exchange closed it. */
  simulateExchangeClose(): void {
    this.positions = [];
  }

  /**
   * Test helper: move the open position's mark-to-market, as a price wick does.
   *
   * Only the *unrealised* figure moves — the wallet balance is untouched — which
   * is exactly the shape that used to poison the circuit breaker's watermark.
   *
   * 标记价是唯一能推动未实现盈亏的东西：快照里的浮动盈亏现在是**按本机器人持仓的
   * 开仓价与标记价算出来**的（不再抄账户的 `unrealizedPnl`），所以这里必须把价格
   * 一起移动 —— 只改那个字段而价格不动，算出来（正确地）是 0，测试就会在到达被测
   * 行为之前先失效。平仓成交价同样取自标记价，价格不动就永远平在开仓价上。
   */
  simulateUnrealizedPnl(value: number): void {
    this.positions = this.positions.map((p) => {
      const direction = p.side === 'long' ? 1 : -1;
      const markPrice = p.quantity > 0 ? p.entryPrice + direction * (value / p.quantity) : p.markPrice;
      return { ...p, markPrice, unrealizedPnl: value };
    });
    const single = this.positions.length === 1 ? this.positions[0]!.markPrice : null;
    if (single !== null) this.markPrice = single;
  }
}

function snapshot(): MarketSnapshot {
  return {
    symbol: SYMBOL,
    sources: ['static'],
    price: MARK_PRICE,
    quoteVolume24h: 1_000_000_000,
    priceChangePercent24h: 1,
    high24h: MARK_PRICE * 1.02,
    low24h: MARK_PRICE * 0.98,
    primary: {
      timeframe: '5m',
      klines: [],
      closes: [MARK_PRICE],
      volumes: [1],
      ema: { '20': [MARK_PRICE] },
      rsi: { '7': [55] },
      atr: { '14': [100] },
      macd: null,
    },
    isMajor: true,
    timeframes: [],
    derivatives: {
      openInterest: 1000,
      openInterestUsd: MARK_PRICE * 1000,
      openInterestAvg: 900,
      openInterestChangePercent: { '1h': 2 },
      fundingRate: 0.0001,
      nextFundingTime: null,
      markPrice: MARK_PRICE,
      indexPrice: MARK_PRICE,
    },
    quant: null,
  };
}

const fakeMarketData = {
  async buildSnapshots() {
    return [snapshot()];
  },
  async getOiRanking() {
    return [];
  },
} as unknown as MarketDataService;

/** Only the methods the trader actually uses. */
const fakeRegistry = {
  minNotional: () => 5,
  notionalToQuantity: (_symbol: string, notionalUsd: number, price: number) =>
    Math.floor((notionalUsd / price) * 1e6) / 1e6,
  /**
   * Reconciliation skips a symbol the registry does not know, so a missing or
   * empty `get()` makes the whole ledger pass a no-op — which would silently
   * hollow out any test that inspects it.
   */
  get: (symbol: string) => ({
    symbol,
    tickSize: 0.1,
    stepSize: 0.001,
    minQty: 0.001,
    maxQty: 1000,
    minNotional: 5,
  }),
  /**
   * Mirrors `SymbolRegistry.isValidTrigger`, and is load-bearing for D1: the
   * runtime decides whether a stop can still rest by asking the registry. A stub
   * that always said yes would hide the whole failure mode.
   */
  isValidTrigger: (triggerPrice: number, type: string, side: 'BUY' | 'SELL', marketPrice: number) => {
    if (!(triggerPrice > 0) || !(marketPrice > 0)) return false;
    const isStop = type === 'STOP' || type === 'STOP_MARKET';
    const mustBeBelow = isStop ? side === 'SELL' : side === 'BUY';
    return mustBeBelow ? triggerPrice < marketPrice : triggerPrice > marketPrice;
  },
} as unknown as SymbolRegistry;

function modelReturning(text: string): DecisionModel {
  return {
    async complete() {
      return { text, latencyMs: 42, usage: { promptTokens: 100, completionTokens: 50 } };
    },
  };
}

function buildTrader(
  broker: FakeBroker,
  text: string,
  model?: DecisionModel,
  /** 默认是 `beforeEach` 建的那个机器人；共账户的用例需要给第二个机器人也建一个。 */
  id = traderId,
): AutoTrader {
  const trader = traders.get(id);
  const strategy = strategyStore.get(trader!.strategyId);
  return new AutoTrader({
    trader: trader!,
    config: strategy!.config,
    registry: fakeRegistry,
    market: {} as never,
    marketData: fakeMarketData,
    broker: broker as unknown as BinanceBroker,
    model: model ?? modelReturning(text),
  });
}

const OPEN_LONG_RESPONSE = `<reasoning>Clean setup.</reasoning>
<decision>
[
  {
    "symbol": "BTCUSDT",
    "action": "open_long",
    "leverage": 3,
    "position_size_usd": 600,
    "stop_loss": 66000,
    "take_profit": 74000,
    "confidence": 85,
    "risk_usd": 20,
    "reasoning": "Breakout with rising OI."
  }
]
</decision>`;

const CLOSE_LONG_RESPONSE = `<reasoning>Target reached.</reasoning>
<decision>[{"symbol":"BTCUSDT","action":"close_long","confidence":90,"reasoning":"Thesis complete."}]</decision>`;

/* -------------------------------------------------------------------------- */
/*  Opening                                                                    */
/* -------------------------------------------------------------------------- */

test('a cycle opens a position and places exchange-side protection', async () => {
  const broker = new FakeBroker();
  const trader = buildTrader(broker, OPEN_LONG_RESPONSE);

  const summary = await trader.runOnce();

  assert.match(summary, /开仓 1/);

  // Leverage was set before the entry.
  assert.ok(broker.leverageCalls.some((c) => c.symbol === SYMBOL && c.leverage === 3));

  // Entry first, then stop, then target — all on the right endpoints.
  const entry = broker.placed.find((p) => p.type === 'MARKET');
  const stop = broker.placed.find((p) => p.type === 'STOP_MARKET');
  const target = broker.placed.find((p) => p.type === 'TAKE_PROFIT_MARKET');

  assert.ok(entry, 'a market entry must be placed');
  assert.equal(entry.side, 'BUY');
  assert.ok(stop, 'a stop loss MUST be placed after entry');
  assert.equal(stop.triggerPrice, 66_000);
  assert.equal(stop.closePosition, true, 'the stop must cover the whole position');
  assert.equal(stop.side, 'SELL');
  assert.ok(target, 'a take profit must be placed');
  assert.equal(target.triggerPrice, 74_000);
  assert.equal(target.closePosition, true);

  // Local book keeping.
  const open = positionStore.open(traderId);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.symbol, SYMBOL);
  assert.equal(open[0]!.side, 'long');
  assert.equal(open[0]!.stop_loss, 66_000);
  assert.equal(open[0]!.take_profit, 74_000);
  assert.ok(open[0]!.stop_order_id, 'the stop algo id must be recorded');

  // Orders and audit record.
  assert.ok(orderStore.list(traderId).length >= 3, 'entry, stop and target must all be recorded');

  const records = decisionStore.list(traderId);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.cotTrace, 'Clean setup.');
  assert.equal(records[0]!.success, true);
  assert.ok(records[0]!.systemPrompt.length > 500);
  assert.ok(records[0]!.userPrompt.length > 200);
  assert.equal(records[0]!.aiLatencyMs, 42);
  assert.equal(records[0]!.promptTokens, 100);
  assert.deepEqual(records[0]!.candidateSymbols, [SYMBOL]);

  // Equity snapshot for the curve.
  assert.ok(equityStore.list(traderId).length >= 1);
});

test('a cycle that decides to wait places no orders', async () => {
  const broker = new FakeBroker();
  const trader = buildTrader(
    broker,
    '<reasoning>Nothing to do.</reasoning><decision>[{"symbol":"BTCUSDT","action":"wait"}]</decision>',
  );

  const summary = await trader.runOnce();

  assert.match(summary, /开仓 0/);
  assert.equal(broker.placed.length, 0);
  assert.equal(positionStore.open(traderId).length, 0);
});

/* -------------------------------------------------------------------------- */
/*  Closing                                                                    */
/* -------------------------------------------------------------------------- */

test('a close cancels protection before flattening', async () => {
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  assert.equal(positionStore.open(traderId).length, 1);

  broker.placed.length = 0;
  const summary = await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  assert.match(summary, /平仓 1/);

  // Cancelling first is what stops a surviving closePosition algo order from
  // firing into a flat book and opening a position in the opposite direction.
  assert.deepEqual(broker.cancelledSymbols, [SYMBOL]);

  const exit = broker.placed.find((p) => p.type === 'MARKET');
  assert.ok(exit);
  assert.equal(exit.side, 'SELL');
  assert.equal(exit.reduceOnly, true);

  assert.equal(positionStore.open(traderId).length, 0);
  const closed = tradeStore.list(traderId);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.closeReason, 'model_decision');
});

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                             */
/* -------------------------------------------------------------------------- */

test('a position that vanishes is detected and booked as a trade', async () => {
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  assert.equal(positionStore.open(traderId).length, 1);

  // The exchange-side stop fires: the position is gone and our algo order is no
  // longer resting. Nothing told us directly.
  broker.simulateExchangeClose();
  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  assert.equal(positionStore.open(traderId).length, 0, 'the stale local record must be cleared');
  const closed = tradeStore.list(traderId);
  assert.equal(closed.length, 1, 'the vanished position must be booked exactly once');
});

test('an untracked exchange position is adopted rather than ignored', async () => {
  const broker = new FakeBroker();
  // Someone opened a position by hand; the bot has never seen it.
  await broker.placeOrder({ symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: 0.01 });

  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  const open = positionStore.open(traderId);
  assert.equal(open.length, 1, 'the manual position must be adopted');
  assert.match(open[0]!.open_reasoning, /机器人之外/);
});

/* -------------------------------------------------------------------------- */
/*  一个回合只能记一次账（§2.5 的幂等）                                          */
/* -------------------------------------------------------------------------- */

/**
 * 把某一回合的两条交易所成交按顺序接进 `getUserTrades`。
 *
 * 入场成交量故意与本地持仓量**不同**：这正是实盘上对账重复记账的触发条件 ——
 * 本地记的是持仓行的数量，交易所重建的是实际成交量（多笔成交的加权），两者
 * 一旦不等，`findRoundTrip()` 就认不出这一回合。
 */
function feedRoundTrip(
  broker: FakeBroker,
  input: {
    localQuantity: number;
    exchangeQuantity: number;
    entryOrderId: string;
    exitOrderId: string;
    entryTime: number;
    exitTime: number;
    entryPrice: number;
    exitPrice: number;
    grossPnl: number;
  },
): void {
  broker.userTrades = [
    {
      symbol: SYMBOL,
      id: 1,
      orderId: Number(input.entryOrderId),
      side: 'BUY',
      positionSide: 'BOTH',
      price: String(input.entryPrice),
      qty: String(input.exchangeQuantity),
      quoteQty: String(input.entryPrice * input.exchangeQuantity),
      realizedPnl: '0',
      marginAsset: 'USDT',
      commission: '0.24',
      commissionAsset: 'USDT',
      time: input.entryTime,
      maker: false,
      buyer: true,
    },
    {
      symbol: SYMBOL,
      id: 2,
      orderId: Number(input.exitOrderId),
      side: 'SELL',
      positionSide: 'BOTH',
      price: String(input.exitPrice),
      qty: String(input.exchangeQuantity),
      quoteQty: String(input.exitPrice * input.exchangeQuantity),
      realizedPnl: String(input.grossPnl),
      marginAsset: 'USDT',
      commission: '0.24',
      commissionAsset: 'USDT',
      time: input.exitTime,
      maker: false,
      buyer: false,
    },
  ];
  // `localQuantity` 只是断言上的说明，不参与喂数：交易所那侧永远只认成交量。
  void input.localQuantity;
}

test('运行期已记账的回合，对账不得再插一行（重复记账 = 凭空多出一份盈亏）', async () => {
  /*
   * Why this test exists —— 这个用例防的就是 §2.5「对账是幂等的：重复执行只修正、
   * 不重复插入」被破坏的那个 bug。
   *
   * 实盘上量到的三组重复行（其余字段逐字节相同，只有 id / source / opened_at 不同）：
   *
   *   #17 reconciled / #18 take_profit   SYNUSDT  99  -0.047554650
   *   #11 reconciled / #12 stop_loss     SYNUSDT 169  -0.75613135
   *   #9  reconciled / #10 take_profit   LSKUSDT  35  +0.66674843
   *
   * 12 行里 4 行是 reconciled，多出来的 6 行凭空造出 **+0.4954** 的净盈亏，
   * 因为毛、手续费、资金费都被算了两遍。
   *
   * 机制：运行期按**本地持仓行的数量**记账，对账按**交易所实际成交量**重建。
   * 两个口径一旦不等（这次就是），`reconcileTradeHistory` 的严格键
   * （symbol+qty+入场价+入口订单号）和只按描述匹配的回退键**同时**落空，
   * 于是它既没认出那一行、也没有任何唯一性约束拦它 —— 两条路各插一行。
   * `orders.exchangeOrderIds()` 那道归属闸门在这里帮不上忙：它回答的是"这个回合
   * 是不是本机器人开的"，而不是"这一回合是不是已经记过账了"。
   *
   * 契约：两条路径描述同一个真实回合时，`trades` 里**有且只有一行**。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const open = positionStore.open(traderId)[0]!;
  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  const booked = tradeStore.list(traderId);
  assert.equal(booked.length, 1, '运行期先记了一行（这是前提，否则用例证明不了什么）');
  const runtimeRow = booked[0]!;

  /*
   * 交易所的成交记录：实际成交量比本地持仓行多一点 —— 这正是 `findRoundTrip()`
   * 认不出这一回合的原因（它按 symbol+数量+入场价匹配），于是运行期记下的那一行
   * 没有入口订单号，对账的严格键与描述回退键也会一起落空。
   *
   * 平仓时间取**运行期记下的那一刻**：两条路径读的是交易所同一笔平仓成交，
   * 实盘上那三组重复行的 `closed_at` 正是逐字节相同的。这个时间就是幂等判据里
   * 唯一能把"同一回合被记两次"和"两笔真实成交"分开的东西（`closed_at` 相同时
   * 再用数量与入场价收窄）。
   */
  feedRoundTrip(broker, {
    localQuantity: runtimeRow.quantity,
    exchangeQuantity: runtimeRow.quantity + 0.0001,
    entryOrderId: '1000',
    exitOrderId: '1003',
    entryTime: Date.parse(runtimeRow.openedAt),
    exitTime: Date.parse(runtimeRow.closedAt),
    entryPrice: runtimeRow.entryPrice,
    exitPrice: runtimeRow.entryPrice + 100,
    grossPnl: 0.88,
  });

  const result = await buildTrader(broker, '<decision>[]</decision>').runReconcile();

  const after = tradeStore.list(traderId);
  assert.equal(
    after.length,
    1,
    `同一回合必须只有一行；实际 ${after.length} 行：${JSON.stringify(
      after.map((t) => ({ id: t.id, source: t.source, qty: t.quantity, net: t.netPnl })),
    )}`,
  );
  // 保留的是运行期那一行（它是先写的），并把交易所的权威口径修正上去 —— 这正是
  // "只修正、不重复插入"。
  assert.equal(after[0]!.id, runtimeRow.id, '不得新增行，应由对账修正原行');
  assert.equal(result.recovered, 0, '没有漏记的回合，补录数必须是 0');
  assert.ok(
    Math.abs(after[0]!.quantity - (runtimeRow.quantity + 0.0001)) < 1e-9,
    '交易所的成交量是权威口径，应当被修正到那一行上',
  );
});

test('运行期确实没记的回合，对账必须补录（#4 POWERUSDT 那种）', async () => {
  /*
   * Why this test exists —— 它是上一个用例的**反面**，用来防止"把对账修坏"。
   *
   * 12 行里 4 行 reconciled，只有 3 行是重复的；`#4 POWERUSDT 131` 没有对应的
   * 运行期行 —— 机器人当时没在跑，那一回合是**真的漏记**了，正是对账存在的理由。
   * 所以修复绝不能变成"凡 reconciled 就不记"或"删掉所有 reconciled"：
   * 那会把 +0.6563 那一笔彻底丢掉，账面反而比账户少。
   *
   * 契约：本地账本里没有这一回合时，reconciliation 仍然插一行，且标成
   * `source: 'reconciled'`（对账补录是"记账漏了"的信号，必须能看出来）。
   */
  const broker = new FakeBroker();
  // 开仓后不经过任何平仓路径：交易所自己平掉了，本地什么都没记。
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  assert.equal(tradeStore.list(traderId).length, 0, '前提：这一回合运行时没有记过账');

  const open = positionStore.open(traderId)[0]!;
  broker.simulateExchangeClose();
  feedRoundTrip(broker, {
    localQuantity: open.quantity,
    exchangeQuantity: open.quantity,
    entryOrderId: '1000',
    exitOrderId: '1003',
    entryTime: Date.parse(open.opened_at),
    exitTime: Date.parse(open.opened_at) + 300_000,
    entryPrice: open.entry_price,
    exitPrice: open.entry_price + 100,
    grossPnl: 0.6563,
  });

  const result = await buildTrader(broker, '<decision>[]</decision>').runReconcile();

  const rows = tradeStore.list(traderId);
  assert.equal(rows.length, 1, '漏记的回合必须被补录，恰好一行');
  assert.equal(result.recovered, 1);
  assert.equal(rows[0]!.source, 'reconciled', '补录行必须标出来源，否则"漏记"这个信号就没了');
  assert.equal(rows[0]!.closeReason, 'reconciled');
  assert.ok(Math.abs(rows[0]!.pnl - 0.6563) < 1e-9, '毛盈亏取自交易所，不得重算');
});

test('对账重复执行是幂等的：第二遍不再插手', async () => {
  /*
   * Why this test exists —— §2.5 的原话是「对账是幂等的：重复执行只修正、不重复插入」。
   *
   * 对账在每个周期开头都会跑一遍（`runCycleBody` 第 2 步），所以"跑两次"不是假设，
   * 而是常态。如果第二遍又插一行，操作员每次点「对账」都会让盈亏膨胀一次。
   *
   * 契约：同一份交易所成交历史上跑第二遍，`recovered` 与 `corrected` 都是 0，
   * 行数与每一行都不动。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  const open = positionStore.open(traderId)[0]!;
  broker.simulateExchangeClose();
  feedRoundTrip(broker, {
    localQuantity: open.quantity,
    exchangeQuantity: open.quantity,
    entryOrderId: '1000',
    exitOrderId: '1003',
    entryTime: Date.parse(open.opened_at),
    exitTime: Date.parse(open.opened_at) + 300_000,
    entryPrice: open.entry_price,
    exitPrice: open.entry_price + 100,
    grossPnl: 0.5,
  });

  const first = await buildTrader(broker, '<decision>[]</decision>').runReconcile();
  assert.equal(first.recovered, 1, '第一遍负责补录，否则第二遍什么都没得比');
  const afterFirst = tradeStore.list(traderId).map((t) => ({ id: t.id, net: t.netPnl }));

  const second = await buildTrader(broker, '<decision>[]</decision>').runReconcile();
  assert.equal(second.recovered, 0, '重复执行不得再补录');
  assert.deepEqual(
    tradeStore.list(traderId).map((t) => ({ id: t.id, net: t.netPnl })),
    afterFirst,
    '第二遍必须什么都不改',
  );
});

/**
 * 直接写一行"历史重复行"。
 *
 * 为什么要绕过仓储：`trades.insert()` 在修复之后是幂等的，它会认出重复并返回已有行，
 * 所以"已经落库的重复行"只能靠原始 SQL 造出来。这个助手只服务于那个检测用例。
 */
function insertDuplicateRow(input: {
  traderId: number;
  symbol: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  grossPnl: number;
  fee: number;
  openedAt: string;
  closedAt: string;
  netPnl: number;
}): number {
  const { lastInsertRowid } = getDb().run(
    `INSERT INTO trades (trader_id, symbol, side, quantity, entry_price, exit_price, leverage,
       pnl, pnl_percent, fee, close_reason, opened_at, closed_at, hold_minutes,
       entry_fee, funding_fee, net_pnl, source)
     VALUES (?, ?, 'long', ?, ?, ?, ?, ?, 0, ?, 'reconciled', ?, ?, 0, 0, 0, ?, 'reconciled')`,
    input.traderId,
    input.symbol,
    input.quantity,
    input.entryPrice,
    input.exitPrice,
    input.leverage,
    input.grossPnl,
    input.fee,
    input.openedAt,
    input.closedAt,
    input.netPnl,
  );
  return lastInsertRowid;
}

test('重复行只被报告出来，不被自动删除', async () => {
  /*
   * Why this test exists —— 已经落库的重复行要由**人**决定怎么处理。
   *
   * 删除会计历史是不可以自动化的事情：删错一行就永久改写了对账依据。所以修复只做
   * 两件事 —— 今后不再产生重复、以及把疑似重复**报出来**给操作者复核。
   * 这个用例钉住报告口径：必须成对、一 reconciled 一非 reconciled，且字段取自数据库。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  const open = positionStore.open(traderId)[0]!;
  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();
  const runtimeRow = tradeStore.list(traderId)[0]!;

  // 直接构造出实盘那三组重复行的形状（修复之后正常路径不会再产生它，历史行仍在）。
  /*
   * 直接写 SQL 造出这一对：**不能**走 `tradeStore.insert()` —— 修复之后它自己就会
   * 认出重复并返回已有行（那正是上一个用例钉住的行为）。这里要模拟的是**已经落库的
   * 历史行**，所以必须绕过写入路径，否则这个用例永远造不出它要检测的形状。
   */
  const duplicateId = insertDuplicateRow({
    traderId,
    symbol: SYMBOL,
    quantity: open.quantity,
    entryPrice: open.entry_price,
    exitPrice: runtimeRow.exitPrice,
    leverage: runtimeRow.leverage,
    grossPnl: runtimeRow.pnl,
    fee: runtimeRow.fee,
    openedAt: new Date(Date.parse(runtimeRow.openedAt) - 368).toISOString(),
    closedAt: runtimeRow.closedAt,
    netPnl: runtimeRow.netPnl,
  });

  const suspects = tradeStore.duplicateSuspects(traderId);
  assert.equal(suspects.length, 1, '这一对重复行必须被报出来');
  assert.deepEqual(
    [suspects[0]!.idA, suspects[0]!.idB].sort((a, b) => a - b),
    [runtimeRow.id, duplicateId].sort((a, b) => a - b),
  );
  assert.equal(suspects[0]!.symbol, SYMBOL);
  assert.ok(
    [suspects[0]!.reasonA, suspects[0]!.reasonB].includes('reconciled'),
    '一对里必须恰好有一行来自对账，否则就不是重复，而是两笔真实成交',
  );

  // 报告不等于删除：两行都还在。
  assert.equal(tradeStore.list(traderId).length, 2, '检测不得顺手删任何一行');
});

/* -------------------------------------------------------------------------- */
/*  Audit trail on failure                                                     */
/* -------------------------------------------------------------------------- */

test('a model failure leaves the position state untouched and reports the error', async () => {
  const broker = new FakeBroker();
  const trader = buildTrader(broker, '');
  // Replace the model with one that throws.
  (trader as unknown as { deps: { model: DecisionModel } }).deps.model = {
    async complete() {
      throw new Error('provider unavailable');
    },
  };

  await assert.rejects(() => trader.runOnce(), /provider unavailable/);
  assert.equal(broker.placed.length, 0);
  assert.equal(positionStore.open(traderId).length, 0);
});

test('a response that violates the risk rules is rejected and recorded', async () => {
  const broker = new FakeBroker();
  // Confidence below the configured floor, and a stop on the wrong side.
  const trader = buildTrader(
    broker,
    `<decision>[{"symbol":"BTCUSDT","action":"open_long","leverage":3,"position_size_usd":600,
      "stop_loss":70000,"take_profit":80000,"confidence":20}]</decision>`,
  );

  await trader.runOnce();

  assert.equal(broker.placed.length, 0, 'an invalid entry must not reach the exchange');
  assert.equal(positionStore.open(traderId).length, 0);

  const record = decisionStore.list(traderId)[0]!;
  assert.ok(record.executionLog.length > 0, 'the rejection must be recorded in the audit trail');
  assert.equal(record.executionLog[0]!.status, 'rejected');
});

/* -------------------------------------------------------------------------- */
/*  Protection that cannot be placed                                           */
/* -------------------------------------------------------------------------- */

test('an entry whose stop is already breached is flattened and booked, not left naked', async () => {
  /*
   * Why this test exists (D1).
   *
   * The risk engine approves a stop against the price in its own snapshot, and
   * the entry executes against a *later* mark price. Between those two moments
   * the mark can move through the stop level — a normal stop becomes a trigger
   * that would fire the instant it is placed.
   *
   * Binance refuses such an order with `-2021 Order would immediately trigger`,
   * `placeProtection` returns null, and the runtime flattens the position. The
   * bug was *how* it got there: `roundTriggerPrice` would happily nudge the
   * trigger to the other side of the market to make it placeable, which silently
   * turns the stop the risk engine sized the trade around into a different,
   * wider one. A stop that immediately triggers protects nothing anyway, so the
   * honest answer is: the thesis is dead, exit now.
   *
   * The observable contract this pins: the position is flat, the stop is
   * **never** re-priced onto the safe side, and the account event is booked.
   */
  const broker = new FakeBroker();
  // The mark is below the approved stop by the time the stop would be placed.
  broker.markPrice = 65_000;

  const trader = buildTrader(broker, OPEN_LONG_RESPONSE);
  const summary = await trader.runOnce();

  assert.match(summary, /开仓 0/, 'an instantly-triggering entry must not count as a held entry');

  // No stop was ever sent. Sending one at a moved level would be the silent
  // stop-widening that §4.2 forbids.
  assert.equal(
    broker.placed.filter((p) => p.type === 'STOP_MARKET').length,
    0,
    'a stop that would immediately trigger must not be placed at all',
  );

  // The entry was flattened and the position is flat everywhere.
  assert.equal(positionStore.open(traderId).length, 0);
  const flatten = broker.placed.find((p) => p.type === 'MARKET' && p.reduceOnly === true);
  assert.ok(flatten, 'the naked position must be market-closed immediately');

  // The exit is a real account event: it must exist in `trades`.
  const trades = tradeStore.list(traderId);
  assert.equal(trades.length, 1, 'the flatten must be booked exactly once');
  assert.equal(trades[0]!.symbol, SYMBOL);
  assert.equal(trades[0]!.closeReason, 'protection_unavailable');
});

test('a failed stop placement still books the emergency flatten', async () => {
  /*
   * Why this test exists (D3).
   *
   * The emergency path used to `return` immediately after flattening, before
   * `positionStore.insert` / `tradeStore.insert` ever ran. The exchange then held
   * a complete entry + exit round-trip that the `trades` table knew nothing
   * about: `reconcilePositions` cannot recover it (no local position) and
   * `reconstructRoundTrips` reports nothing for an already-closed round-trip it
   * was never told about. The platform's PnL read *better* than the account's —
   * a direct breach of §2.3.
   *
   * Here the stop fails for a reason other than drift (the exchange rejects the
   * order), which is the other half of the same branch.
   */
  const broker = new FakeBroker();
  broker.rejectStops = true;

  const trader = buildTrader(broker, OPEN_LONG_RESPONSE);
  await trader.runOnce();

  assert.equal(positionStore.open(traderId).length, 0, 'the naked position must be flattened');
  assert.ok(
    broker.placed.some((p) => p.type === 'MARKET' && p.reduceOnly === true),
    'the emergency flatten must reach the exchange',
  );

  const trades = tradeStore.list(traderId);
  assert.equal(trades.length, 1, 'the emergency close must be booked, not silently dropped');
  assert.equal(trades[0]!.closeReason, 'protection_unavailable');
  assert.ok(trades[0]!.exitPrice > 0, 'the recorded exit must carry a real price');

  // Both orders of the round-trip are in the audit trail.
  const purposes = orderStore.list(traderId).map((o) => o.purpose);
  assert.ok(purposes.includes('entry'), 'the entry order must be recorded');
  assert.ok(purposes.includes('exit'), 'the flatten order must be recorded');
});

/* -------------------------------------------------------------------------- */
/*  Unconfirmed fills                                                          */
/* -------------------------------------------------------------------------- */

test('a partially filled exit is not booked as a full close', async () => {
  /*
   * Why this test exists (D4).
   *
   * `waitForFill` gives up after its timeout and returns the last state it saw,
   * which can be a partial fill. The exit path used `executedQty || local.quantity`,
   * so a timeout was booked as a **full** close: the remainder stayed open at the
   * exchange, the next `reconcilePositions` saw the position still there, and the
   * same round-trip was booked a second time. The ledger showed a trade that had
   * not completed while the account still carried the position.
   *
   * Unconfirmed means unconfirmed: no `trades` row, and the local position stays
   * open so reconciliation can settle the truth from the exchange.
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  assert.equal(positionStore.open(traderId).length, 1);
  const before = positionStore.open(traderId)[0]!;

  // Only a third of the exit fills before the poll gives up. Armed *after* the
  // entry so the next reduce-only market order — the exit — is the one that
  // comes back partial.
  broker.partialFillRatio = 1 / 3;
  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  assert.equal(tradeStore.list(traderId).length, 0, 'a partial exit must not be booked as a close');
  const stillOpen = positionStore.open(traderId);
  assert.equal(stillOpen.length, 1, 'the remainder is still a real position and must stay recorded');
  assert.equal(stillOpen[0]!.quantity, before.quantity, 'the local quantity is left for reconciliation');

  // The attempt itself is still auditable.
  const exitOrder = orderStore.list(traderId).find((o) => o.purpose === 'exit');
  assert.ok(exitOrder, 'the partial exit attempt must still be recorded as an order');
  assert.equal(exitOrder.status, 'PARTIALLY_FILLED');
});

/* -------------------------------------------------------------------------- */
/*  Funding on the live close path                                             */
/* -------------------------------------------------------------------------- */

test('funding is attributed when the bot closes the position itself', async () => {
  /*
   * Why this test exists (D5).
   *
   * Funding settles every 8 hours and appears in **no** fill, so it can only come
   * from `/fapi/v1/income`. It used to be attributed on the reconcile path alone,
   * which only touches a row it can match — so a close booked live could keep
   * `funding_fee = 0` forever and the platform's net PnL read better than the
   * account's. `trades.setFundingFee()` was dead code (no callers), which is why
   * the value has to be passed into `insert()` instead.
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const opened = positionStore.open(traderId)[0]!;
  // A settlement *inside* the position's lifetime. Funding can only be attributed
  // to the round-trip's own window, so a fixture dated after the close would
  // (correctly) be excluded and the test would prove nothing.
  broker.income = [
    {
      symbol: SYMBOL,
      incomeType: 'FUNDING_FEE',
      income: '-0.0231',
      time: new Date(opened.opened_at).getTime(),
    },
  ];

  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  const [trade] = tradeStore.list(traderId);
  assert.ok(trade, 'the close must be booked');
  assert.ok(
    Math.abs(trade.fundingFee - -0.0231) < 1e-12,
    `funding must be read from the income ledger, got ${trade.fundingFee}`,
  );
  // Net is derived in one place and must include the funding.
  assert.ok(
    Math.abs(trade.netPnl - (trade.pnl - trade.fee - trade.fundingFee)) < 1e-12,
    'net PnL must equal gross − fees − funding',
  );
});

/* -------------------------------------------------------------------------- */
/*  Circuit-breaker watermark                                                  */
/* -------------------------------------------------------------------------- */

test('an unrealised spike does not permanently trip the drawdown breaker', async () => {
  /*
   * Why this test exists (D2).
   *
   * The watermark was `max(equityStore.highWaterMark, account.equity)`, and
   * `account.equity` is the **margin balance** — it includes unrealised PnL. One
   * unrealised spike therefore raised the watermark permanently: when the price
   * wick retraced, equity came back to baseline, `maxTotalDrawdownPercent`
   * calculated a drawdown that never happened, and the bot refused to open
   * anything — forever, with only a log line to explain it.
   *
   * The watermark is now the realised peak (`equity − unrealized_pnl`). This test
   * runs the exact sequence: open, wick up, wick back.
   */
  const broker = new FakeBroker();
  // A configured breaker, unlike the permissive default of the other tests.
  strategyStore.update(traders.get(traderId)!.strategyId, {
    config: {
      ...permissiveConfig(),
      circuitBreaker: {
        maxDailyLossPercent: 0,
        maxTotalDrawdownPercent: 5,
        safeModeAfterFailures: 3,
        safeModeProbeCycles: 3,
      },
    },
  });

  // Cycle 1: opens the position; the equity snapshot carries no unrealised PnL.
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  // Cycle 2: the position wicks up +100. This is the snapshot that used to
  // poison the watermark.
  broker.simulateUnrealizedPnl(100);
  await buildTrader(broker, '<decision>[]</decision>').runOnce();
  assert.ok(
    equityStore.list(traderId).some((s) => Math.abs(s.equity - 1100) < 1e-9),
    'the wick must actually be recorded, or the test proves nothing',
  );

  // Cycle 3: the wick retraces and the model tries to open again.
  broker.simulateUnrealizedPnl(0);
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const records = decisionStore.list(traderId);
  const log = records.flatMap((r) => r.executionLog.map((e) => e.detail));
  assert.ok(
    !log.some((d) => d.includes('总回撤熔断')),
    `a retraced unrealised spike must not trip the breaker, got: ${log.join(' | ')}`,
  );
  // And the entry must actually have been attempted, so the assertion above
  // cannot pass merely because no entry was proposed.
  assert.ok(
    log.some((d) => d.includes('已开仓')),
    `the entry must reach execution after the spike retraces, got: ${log.join(' | ')}`,
  );
});

test('a genuine realised loss still trips the drawdown breaker', async () => {
  /*
   * Companion to the test above, and the reason the watermark fix is not a
   * loosening: a change in *realised* equity must still stop new entries. The
   * watermark is seeded directly here because the point under test is the
   * comparison, not how the loss was produced.
   */
  const broker = new FakeBroker();
  strategyStore.update(traders.get(traderId)!.strategyId, {
    config: {
      ...permissiveConfig(),
      circuitBreaker: {
        maxDailyLossPercent: 0,
        maxTotalDrawdownPercent: 5,
        safeModeAfterFailures: 3,
        safeModeProbeCycles: 3,
      },
    },
  });

  // The account peaked at 1100 with nothing unrealised. 高水位读的是**账户**两列
  // （`account_equity − account_unrealized_pnl`），`equity` 自 M4 起是本机器人归属
  // 口径 —— 风控的输入因此保持不变（§4.2）。
  equityStore.insert({
    traderId,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    equity: 1100,
    availableBalance: 800,
    unrealizedPnl: 0,
    marginUsed: 0,
    openPositions: 0,
    accountEquity: 1100,
    accountUnrealizedPnl: 0,
  });
  // ...and the broker now reports the baseline 1000, a real 9.1% drawdown.
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const log = decisionStore
    .list(traderId)
    .flatMap((r) => r.executionLog.map((e) => e.detail));
  assert.ok(
    log.some((d) => d.includes('总回撤熔断')),
    `a real drawdown must still block entries, got: ${log.join(' | ')}`,
  );
  assert.equal(positionStore.open(traderId).length, 0, 'no entry may be opened while blocked');
});

/* -------------------------------------------------------------------------- */
/*  Serialisation against the running cycle                                     */
/* -------------------------------------------------------------------------- */

test('stopping a trader waits for the cycle already in flight', async () => {
  /*
   * Why this test exists (D7/D8).
   *
   * `stop()` cleared the timer and returned immediately. Ctrl+C landing between
   * "entry filled" and "stop placed" therefore exited the process with a naked
   * leveraged position on the exchange and no timer left to fix it — the state
   * §2.6 exists to forbid. Stopping must now drain the cycle.
   */
  const broker = new FakeBroker();
  const trader = buildTrader(broker, OPEN_LONG_RESPONSE, {
    async complete() {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { text: OPEN_LONG_RESPONSE, latencyMs: 150, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  });

  await trader.start();
  await trader.stop('测试：停机');

  assert.ok(
    broker.placed.some((p) => p.type === 'STOP_MARKET'),
    'stop() must not return before the in-flight cycle has placed its protection',
  );
  const open = positionStore.open(traderId);
  assert.equal(open.length, 1);
  assert.ok(open[0]!.stop_order_id, 'the position must be protected by the time stop() resolves');
});

test('a reconcile pass does not run while a cycle is in flight', async () => {
  /*
   * Why this test exists (D7).
   *
   * `/reconcile` built a **second** `AutoTrader` over the same account and ran it
   * concurrently with the live one. Both reconciled the same positions and the
   * same `trades` rows: both could see a position gone, both could book the
   * close, one could close a local row the other had just corrected.
   *
   * The observable contract: the reconcile pass starts only after the cycle has
   * finished — the ledger reads it makes cannot happen while a cycle is running.
   */
  const broker = new FakeBroker();
  const ledgerReads: string[] = [];
  let cycleRunning = false;

  eventBus.subscribe((event) => {
    if (event.type === 'cycle_start') cycleRunning = true;
    if (event.type === 'cycle_end') cycleRunning = false;
  });

  const model: DecisionModel = {
    async complete() {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        text: '<decision>[]</decision>',
        latencyMs: 150,
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
  };

  /*
   * `getIncome` is the first thing the ledger pass does, and it is called
   * unconditionally — unlike the per-symbol fill reads, which only happen for
   * symbols the trader has traded. Instrumenting it is what makes "did the pass
   * start while a cycle was running?" observable.
   */
  const originalGetIncome = broker.getIncome.bind(broker);
  broker.getIncome = async (...args: Parameters<FakeBroker['getIncome']>) => {
    if (!cycleRunning) ledgerReads.push('reconcile');
    return originalGetIncome(...args);
  };

  const trader = buildTrader(broker, '<decision>[]</decision>', model);
  await trader.start();
  try {
    await trader.runReconcile();

    assert.ok(
      ledgerReads.length > 0,
      'the reconcile pass must actually read the ledger, or the test proves nothing',
    );
    // Every ledger read outside a cycle belongs to the reconcile pass, and the
    // first of them can only happen after `cycle_end`.
    assert.equal(
      ledgerReads[0],
      'reconcile',
      'reconciliation must not read the ledger while the cycle is still running',
    );
  } finally {
    // The interval would otherwise keep the test process alive for 15 minutes.
    await trader.stop('测试结束');
  }
});

/* -------------------------------------------------------------------------- */
/*  一个交易所账户、两个机器人                                                  */
/* -------------------------------------------------------------------------- */

test('共用一个交易所账户的两个机器人：不交易的那个必须一直是平的，且不随另一个交易而变动', async () => {
  /*
   * Why this test exists —— 这就是本次修复针对的那个 bug。
   *
   * `equity_snapshots.equity` 过去写的是 `broker.getAccountState().equity`，也就是
   * **共享钱包**的保证金余额；同一个账户下的机器人共用一份凭据，于是它们每个人
   * 的每一行记的都是同一个数。实盘上量到的三个机器人（都挂在同一个账户上）：
   *
   *   #4 测试机器人1   0 笔平仓、净 0.000000 → 显示 +2.67%
   *   #5 测试2         4 笔平仓、净 +0.272133 → 显示 +2.67%
   *   #6 实盘3小时验证  0 笔平仓、净 0.000000 → 显示 −0.06%
   *
   * #4 从来没有成交过，却显示了别的机器人挣来的 +2.67%，而且和 #5 一模一样 ——
   * 因为它们读的是同一个钱包。`unrealizedPnl` 是同一个病的第二个字段：它抄的是
   * 账户的总浮盈，所以两个机器人显示同一个浮动盈亏。
   *
   * 这个用例钉住两件事：
   *   1. 不交易的机器人读数是平的（恰好等于自己的 initialEquity），账户里的浮盈
   *      一分钱都不算它的；
   *   2. 另一个机器人继续交易时，它的每一个数字都**一动不动**。
   */
  const base = traders.get(traderId)!;
  const idleId = traders.create({
    name: 'idle',
    exchangeAccountId: base.exchangeAccountId,
    aiModelId: base.aiModelId,
    strategyId: base.strategyId,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;

  const broker = new FakeBroker();

  /*
   * 交易的机器人先完成一个回合，把 +1 USDT 的已实现盈亏落进**共享钱包**。
   *
   * 用已实现而不是浮盈，是因为共用账户时两个机器人的 `positions` 是共享的行情状态：
   * 不交易的那个会在自己的周期里"收养"对方开着的仓位（`reconcilePositions` 的既有
   * 行为）。平掉之后再观察，账户里变化的是钱，而不是谁名下的持仓。
   */
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  broker.simulateUnrealizedPnl(1);
  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  const traded = computeTraderStats(traderId);
  assert.ok(
    traded.realizedPnl > 0.9,
    `交易的机器人必须真的挣到了钱，否则这个用例证明不了任何事，得到 ${traded.realizedPnl}`,
  );
  assert.ok(Math.abs(traded.equity - 1001) < 0.01, `期望归属权益约 1001，得到 ${traded.equity}`);
  assert.ok(
    Math.abs((await broker.getAccountState()).equity - 1001) < 0.01,
    '共享钱包里应当已经有这 1 USDT（否则下面测的还是同一个数）',
  );

  /*
   * 不交易的机器人跑一轮：它自己的周期会写权益快照，而这条路径正是污染进入它账本
   * 的地方 —— 旧代码在这里把共享钱包的 1001 写成了它的权益，于是它显示 +0.1% 的
   * 收益率，而它的 `trades` 是空的。
   */
  await buildTrader(broker, '<decision>[]</decision>', undefined, idleId).runOnce();

  const idleFlat = computeTraderStats(idleId);
  assert.equal(idleFlat.equity, 1000, '没成交过的机器人必须停在初始权益上，而不是账户权益');
  assert.equal(idleFlat.totalReturnPercent, 0, '别人的钱不是它的收益率');
  assert.equal(idleFlat.unrealizedPnl, 0, '别人的浮盈不是它的浮盈');
  assert.equal(idleFlat.realizedPnl, 0);
  assert.equal(idleFlat.totalTrades, 0);
  assert.equal(idleFlat.maxDrawdownPercent, 0);
  // 共享钱包单独汇报，而且**不等于**归属权益 —— 这两个数以前是同一个。
  assert.ok(
    Math.abs(idleFlat.accountEquity - 1001) < 1e-9,
    `账户（共享钱包）权益应当单独给出（期望 1001），得到 ${idleFlat.accountEquity}`,
  );
  assert.notEqual(idleFlat.accountEquity, idleFlat.equity);

  /** 只取参与归属判断的字段：`uptimeHours` 每次调用都会变，不该参与比较。 */
  const shapeOf = (id: number) => {
    const stats = computeTraderStats(id);
    return {
      equity: stats.equity,
      totalReturnPercent: stats.totalReturnPercent,
      realizedPnl: stats.realizedPnl,
      unrealizedPnl: stats.unrealizedPnl,
      totalTrades: stats.totalTrades,
      openPositions: stats.openPositions,
      maxDrawdownPercent: stats.maxDrawdownPercent,
    };
  };
  const idleBefore = shapeOf(idleId);
  const idleSnapshotsBefore = equityStore.list(idleId).length;

  // 交易的机器人再做一个回合（钱包涨到 1003），不交易的机器人一动不动。
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  broker.simulateUnrealizedPnl(2);
  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  assert.ok(
    computeTraderStats(traderId).realizedPnl > traded.realizedPnl,
    '交易的机器人必须继续在挣钱，否则"另一个没动"可能只是因为它也没动',
  );
  assert.ok(
    (await broker.getAccountState()).equity > 1002,
    '共享钱包必须继续变化，否则"没动"可能只是因为账户也没动',
  );
  assert.deepEqual(
    shapeOf(idleId),
    idleBefore,
    '邻居交易时，不交易的机器人的每一个数字都必须原样不动',
  );
  assert.equal(
    equityStore.list(idleId).length,
    idleSnapshotsBefore,
    '不交易的机器人不该被别人的周期改写快照',
  );

  /*
   * 已停止的机器人在「对账」时也不该被改写快照。
   *
   * 这一遍原来无条件写一条账户权益，于是控制台上一个 stopped 的机器人的数字会
   * 随着它自己的对账（以及邻居的交易）继续变化 —— 停止的机器人，历史必须停止移动。
   * 它对账刚补录的成交仍然会立刻显示出来，因为权益是按 `trades` 现算的，不靠快照。
   */
  const idleTrader = buildTrader(broker, '<decision>[]</decision>', undefined, idleId);
  await idleTrader.runReconcile();
  assert.equal(
    equityStore.list(idleId).length,
    idleSnapshotsBefore,
    '已停止的机器人对账后不该多出一条快照',
  );
  assert.deepEqual(shapeOf(idleId), idleBefore, '对账也不该让停止的机器人的数字移动');
});

/* -------------------------------------------------------------------------- */
/*  关闭流程不得伪装成"操作员停止"                                              */
/* -------------------------------------------------------------------------- */

test('shutdown does not mark the trader as operator-stopped', async () => {
  /*
   * Why this test exists.
   *
   * `AutoTrader.stop()` used to always write `stopped` to the database. That is
   * correct for an operator clicking 停止, and wrong for the process shutting
   * down — because `resumePersisted()` treats `stopped` as **a human decision**
   * and deliberately refuses to resume it.
   *
   * The consequence was silent and total: every deploy or restart turned every
   * running bot into "manually stopped", and it never came back. Nothing looked
   * wrong on the console — the status read `stopped`, exactly as if someone had
   * clicked it. It was found only by restarting a live instance and noticing the
   * bot had not resumed.
   *
   * So the contract is: shutdown stops the loop but leaves `running` on disk;
   * only an explicit operator stop may write `stopped`.
   */
  const broker = new FakeBroker();
  const trader = buildTrader(broker, '<decision>[]</decision>');

  // Start so the persisted status becomes `running`, exactly as a real start does.
  await trader.start();
  assert.equal(
    traders.get(traderId)?.status,
    'running',
    'starting must persist `running`, otherwise nothing is ever resumable',
  );

  // Shutdown path.
  await trader.stop('服务器正在关闭', false);
  assert.equal(
    traders.get(traderId)?.status,
    'running',
    'shutdown must leave `running` on disk so the next boot resumes the bot',
  );

  // Operator path — the default must still mark it stopped.
  await trader.stop('操作员手动停止');
  assert.equal(
    traders.get(traderId)?.status,
    'stopped',
    'an explicit operator stop must persist `stopped`, or resumePersisted would resurrect a bot the human stopped',
  );
});

/* -------------------------------------------------------------------------- */
/*  失败的周期必须留下记录                                                      */
/* -------------------------------------------------------------------------- */

test('模型调用抛错的周期：仍然写出恰好一条失败记录，并带上已经拿到的进度', async () => {
  /*
   * Why this test exists —— 这就是本次修复针对的那个 bug。
   *
   * 审计记录原来是周期的第 11 步，位置在模型调用与执行**之后**，而且硬编码
   * `success: true, error: null`。于是模型调用一旦抛错，`runCycle()` 就直接退出，
   * **一条记录都不写**：决策流里什么都看不到。实盘上正在发生的就是这件事 ——
   * 一个欠费的模型供应商让每一轮都被拒，而操作员在控制台上看不到任何迹象。
   * `decision_records.success` / `error` 两列一直都在，只是从来没有被写过。
   *
   * 这个用例钉住三件事：
   *   1. 失败也要落库，而且**恰好一条**（不能一条都不写，也不能写两条）；
   *   2. `error` 是能照着做的中文说明，而不是堆栈，并且带上服务商原文；
   *   3. 已经拿到的部分（提示词、候选标的）必须一起留下 —— 否则操作员还是看不出
   *      "这一轮原本要问什么"。
   *
   * 状态码用的是 429 + `insufficient_quota`：欠费在真实服务商那里就是这么回报的
   * （见 `llm/errors.ts` 的 QUOTA_MARKERS），而不是靠推理编一个。
   */
  const broker = new FakeBroker();
  const trader = buildTrader(broker, '', {
    async complete() {
      throw classifyHttpError('deepseek', 429, { error: { message: 'insufficient_quota' } });
    },
  });

  await assert.rejects(() => trader.runOnce(), /insufficient_quota/);

  const records = decisionStore.list(traderId);
  assert.equal(records.length, 1, '失败的周期必须留下恰好一条记录');
  const record = records[0]!;
  assert.equal(record.success, false, '失败必须写成 success = false，而不是硬编码的 true');
  assert.ok(record.error, '失败必须带一条 error');
  assert.match(record.error!, /AI 服务额度不足/, '类别要能一眼看出是欠费');
  assert.match(record.error!, /insufficient_quota/, '要带上服务商原文，否则没人知道是谁拒的');
  assert.match(record.error!, /充值/, '说明必须可执行');

  // 部分进度：提示词在发请求之前就写进了审计记录。
  assert.ok(record.systemPrompt.length > 500, '失败记录仍要带上系统提示词');
  assert.ok(record.userPrompt.length > 200, '失败记录仍要带上用户提示词');
  assert.deepEqual(record.candidateSymbols, [SYMBOL]);

  // 失败没有下单，也没有留下持仓。
  assert.equal(broker.placed.length, 0);
  assert.equal(positionStore.open(traderId).length, 0);
});

test('再失败一轮也只有新的一条记录：一个周期一条，不多不少', async () => {
  /*
   * "恰好一条"必须在**多轮**上也成立：记录写在不同位置（早退 / 抛错 / 正常结束）时，
   * 很容易变成"某一轮写两条"。这里跑两轮失败，断言总数正好是 2。
   */
  const broker = new FakeBroker();
  const trader = buildTrader(broker, '', {
    async complete() {
      throw classifyHttpError('deepseek', 401, { error: { message: 'invalid api key' } });
    },
  });

  await assert.rejects(() => trader.runOnce());
  await assert.rejects(() => trader.runOnce());

  const records = decisionStore.list(traderId);
  assert.equal(records.length, 2, '两轮失败 = 两条记录');
  for (const record of records) {
    assert.equal(record.success, false);
    assert.match(record.error!, /AI 服务拒绝/);
  }
});

test('风控裁决抛错的周期：记录里保留提示词、思维链与模型决策', async () => {
  /*
   * Why this test exists.
   *
   * 失败记录不能只有一句错误 —— 如果模型回答已经拿到、只是后面某一步抛了，那么
   * 提示词、思维链、决策与执行日志都必须照样落库。否则操作员看到的是"什么都没发生"，
   * 那正是这次要修的观测空洞的另一种形态。
   *
   * 这里让交易所的最小名义价值查询抛错：它在风控第 10 步被调用，而那时解析已经完成。
   */
  const broker = new FakeBroker();
  const registry = {
    ...fakeRegistry,
    minNotional: () => {
      throw new Error('symbol filters unavailable');
    },
  } as unknown as SymbolRegistry;

  const trader = new AutoTrader({
    trader: traders.get(traderId)!,
    config: strategyStore.get(traders.get(traderId)!.strategyId)!.config,
    registry,
    market: {} as never,
    marketData: fakeMarketData,
    broker: broker as unknown as BinanceBroker,
    model: modelReturning(OPEN_LONG_RESPONSE),
  });

  await assert.rejects(() => trader.runOnce(), /symbol filters unavailable/);

  const records = decisionStore.list(traderId);
  assert.equal(records.length, 1, '抛错也恰好一条');
  const record = records[0]!;
  assert.equal(record.success, false);
  assert.match(record.error!, /决策处理失败/);
  // 已经拿到的部分全在。
  assert.equal(record.cotTrace, 'Clean setup.');
  assert.equal(record.decisions.length, 1);
  assert.equal(record.decisions[0]!.action, 'open_long');
  assert.ok(record.rawResponse.includes('open_long'), '原始响应也要留下');
  assert.ok(record.systemPrompt.length > 500);
  // 风控在抛错前没有放行任何订单。
  assert.equal(broker.placed.length, 0);
});

test('行情为空的一轮：也留下恰好一条记录，但不推进连续失败计数', async () => {
  /*
   * Why this test exists.
   *
   * 取不到行情时 `runCycle()` 原本**直接 return**，同样一条记录都不写 —— 决策流里
   * 看不出机器人已经好几轮什么都没做。现在它写一条 `success = false` 的记录。
   *
   * 但它**刻意不抛错**：抛错会被 `tick()` 记成一次连续失败、并可能把机器人推进安全
   * 模式。行情空窗是策略层面的正常状态（候选全被过滤掉也会这样），不是模型 / 交易所
   * 故障 —— 所以这里同时钉住"有记录"和"失败计数没有被动过"。
   */
  const broker = new FakeBroker();
  /*
   * 行情服务"连得上但什么都给不出"：选币返回空、快照也是空 —— 这正是行情接口
   * 大面积失败时真实的样子（`market/service.ts` 对单个标的失败是降级而不是抛错）。
   */
  const emptyMarketData = {
    async screenUniverse() {
      return [];
    },
    async screenOpenInterestGrowth() {
      return [];
    },
    async buildSnapshots() {
      return [];
    },
    async getOiRanking() {
      return [];
    },
  } as unknown as MarketDataService;

  const trader = new AutoTrader({
    trader: traders.get(traderId)!,
    config: strategyStore.get(traders.get(traderId)!.strategyId)!.config,
    registry: fakeRegistry,
    market: {} as never,
    marketData: emptyMarketData,
    broker: broker as unknown as BinanceBroker,
    model: modelReturning('<decision>[]</decision>'),
  });

  /*
   * 走**真正的 tick 路径**（start() 会立刻跑一轮）：只有这样"连续失败计数"与
   * 机器人状态才是真的被观察的，而不是靠 runOnce 绕开失败策略。
   */
  await trader.start();
  await trader.stop('测试：行情空窗', false);

  assert.equal(broker.placed.length, 0);

  const records = decisionStore.list(traderId);
  assert.equal(records.length, 1, '什么都没做的一轮同样要留下一条记录');
  assert.equal(records[0]!.success, false);
  assert.match(records[0]!.error!, /行情数据不可用/);

  // 行情空窗**不是**失败：机器人的状态与连续失败计数都不该被它推动。
  assert.equal(traders.get(traderId)!.consecutiveFailures, 0, '行情空窗不该推进连续失败计数');
  assert.equal(
    traders.get(traderId)!.status,
    'running',
    '行情空窗不该把机器人推进 error / safe_mode —— 那会是行为变更，而不是补记录',
  );
});

test('describeCycleFailure：每一类失败都给一句可执行的中文说明，且类别写在第一个全角冒号之前', async () => {
  /*
   * Why this test exists.
   *
   * 这句话是操作员在决策流里唯一会读到的失败信息，所以它必须说清"谁失败了、意味着
   * 什么、要不要做点什么"。同时它必须只用 `llm/errors.ts` 已经判好的 `kind`，**不能**
   * 在这里按 HTTP 状态码再判一次：那个文件里记着一次实测事故 —— 网关在 HTTP 400 里
   * 返回 `模型不可用：deepseek-flash`，而"400 就是参数错误、不可重试"的通用规则让一次
   * 本可成功的请求被放弃。这里钉住"展示层不会把那个 bug 复制一遍"。
   *
   * 最后一条断言钉的是决策流的展示契约：元数据行取第一个全角冒号之前的类别
   * （`DecisionFeed.failureCategory()`），所以每一句话都必须以 `类别：` 开头。
   */
  const quota = describeCycleFailure(
    classifyHttpError('deepseek', 429, { error: { message: 'insufficient_quota' } }),
    'model',
  );
  assert.match(quota, /AI 服务额度不足/);
  assert.match(quota, /充值/);

  const unavailable = describeCycleFailure(
    classifyHttpError('deepseek', 400, { message: '模型不可用：deepseek-flash' }),
    'model',
  );
  assert.match(unavailable, /AI 服务不可用/, 'HTTP 400 里的"模型不可用"是临时不可用');
  assert.doesNotMatch(unavailable, /请求参数错误/);

  const badRequest = describeCycleFailure(
    classifyHttpError('deepseek', 400, { message: 'invalid model id' }),
    'model',
  );
  assert.match(badRequest, /AI 服务拒绝：请求参数错误/);

  const empty = describeCycleFailure(
    new LlmError('No assistant text in deepseek response', null, 'deepseek', true),
    'parse',
  );
  assert.match(empty, /AI 响应无法解析/);

  const market = describeCycleFailure(new Error('fetch failed'), 'market');
  assert.match(market, /行情数据不可用/);

  const exchange = describeCycleFailure(
    new BinanceApiError(-2019, 'Margin is insufficient.', 400, null, '/fapi/v1/order'),
    'execute',
  );
  assert.match(exchange, /交易所拒绝/);
  assert.match(exchange, /保证金不足/);

  const unknown = describeCycleFailure(new Error('boom'), 'bookkeeping');
  assert.match(unknown, /未知错误/);

  // 元数据行的展示契约：`类别：说明`，类别在 12 字以内（一行小字放得下）。
  for (const message of [quota, unavailable, badRequest, empty, market, exchange, unknown]) {
    assert.match(message, /^[^：]{2,12}：/, `类别必须写在第一个全角冒号之前：${message}`);
  }
});
