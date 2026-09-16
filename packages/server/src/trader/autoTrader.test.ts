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
import type { BinanceAlgoOrderResponse, BinanceOrderResponse } from '../binance/types.js';
import type { SymbolRegistry } from '../binance/symbols.js';
import { closeDb, initDb } from '../db/index.js';
import { eventBus } from '../events.js';
import type { MarketDataService } from '../market/service.js';
import {
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
import { AutoTrader, type DecisionModel } from './autoTrader.js';

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
      equity: 1000 + unrealized,
      walletBalance: 1000,
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
        // A reduce-only order removes only what it actually filled. Modelling a
        // partial exit as a full flatten would hide the very state under test.
        const quantity = request.quantity ?? 0;
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
    return [];
  }

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
   */
  simulateUnrealizedPnl(value: number): void {
    this.positions = this.positions.map((p) => ({ ...p, unrealizedPnl: value }));
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

function buildTrader(broker: FakeBroker, text: string, model?: DecisionModel): AutoTrader {
  const trader = traders.get(traderId);
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

  // The account peaked at 1100 with nothing unrealised...
  equityStore.insert({
    traderId,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    equity: 1100,
    availableBalance: 800,
    unrealizedPnl: 0,
    marginUsed: 0,
    openPositions: 0,
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
