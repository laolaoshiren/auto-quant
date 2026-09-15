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
import type { MarketDataService } from '../market/service.js';
import {
  decisions as decisionStore,
  equity as equityStore,
  exchanges,
  aiModels,
  orders as orderStore,
  positions as positionStore,
  strategies,
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
  const strategy = strategies.create({
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

    if (!isConditional) {
      // Market orders fill instantly and update the simulated position book.
      if (request.reduceOnly) {
        this.positions = this.positions.filter((p) => p.symbol !== request.symbol);
      } else {
        const quantity = request.quantity ?? 0;
        this.positions.push({
          symbol: request.symbol,
          side: request.side === 'BUY' ? 'long' : 'short',
          quantity,
          entryPrice: MARK_PRICE,
          markPrice: MARK_PRICE,
          leverage: 3,
          liquidationPrice: null,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          marginUsed: (quantity * MARK_PRICE) / 3,
          notional: quantity * MARK_PRICE,
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

    const filledQty = request.quantity ?? 0;
    const raw: BinanceOrderResponse = {
      orderId: Number(id),
      clientOrderId: request.clientOrderId ?? id,
      symbol: request.symbol,
      side: request.side,
      type: request.type as BinanceOrderResponse['type'],
      status: 'FILLED',
      avgPrice: String(MARK_PRICE),
      executedQty: String(filledQty),
      origQty: String(filledQty),
      price: '0',
      cumQty: String(filledQty),
      cumQuote: String(filledQty * MARK_PRICE),
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
      status: 'FILLED',
      avgPrice: MARK_PRICE,
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

  async getMarkPrice() {
    return MARK_PRICE;
  }

  async getOpenAlgoOrders() {
    return [];
  }

  /** Test helper: make the position vanish as if the exchange closed it. */
  simulateExchangeClose(): void {
    this.positions = [];
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

/** Only the two methods the trader actually uses. */
const fakeRegistry = {
  minNotional: () => 5,
  notionalToQuantity: (_symbol: string, notionalUsd: number, price: number) =>
    Math.floor((notionalUsd / price) * 1e6) / 1e6,
} as unknown as SymbolRegistry;

function modelReturning(text: string): DecisionModel {
  return {
    async complete() {
      return { text, latencyMs: 42, usage: { promptTokens: 100, completionTokens: 50 } };
    },
  };
}

function buildTrader(broker: FakeBroker, text: string): AutoTrader {
  const trader = traders.get(traderId);
  const strategy = strategies.get(trader!.strategyId);
  return new AutoTrader({
    trader: trader!,
    config: strategy!.config,
    registry: fakeRegistry,
    market: {} as never,
    marketData: fakeMarketData,
    broker: broker as unknown as BinanceBroker,
    model: modelReturning(text),
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
