/**
 * 里程碑 1（M1）端到端集成回归测试：
 *   - M1.2 智能托管按需取数（get_klines）自选池外标的自动热加入可执行池（含流动性门槛与模式隔离）
 *   - M1.3 挂限价入场单前止损穿透拦截 + 30s 实时守卫结清已成交限价单
 *   - M1.4 模拟盘跨 8 小时结算平仓记入真实资金费估算
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import {
  defaultStrategyConfig,
  unboundedAiManagedConfig,
  type Kline,
  type MarketSnapshot,
  type StrategyConfig,
} from '@aq/shared';

import { SymbolRegistry } from '../binance/symbols.js';
import type { BinanceExchangeInfo } from '../binance/types.js';
import { closeDb, getDb, initDb } from '../db/index.js';
import type { MarketPort } from '../market/port.js';
import type { MarketDataService } from '../market/service.js';
import {
  aiModels,
  decisions as decisionStore,
  exchanges,
  orders as orderStore,
  positions as positionStore,
  strategies,
  traders,
  trades as tradeStore,
} from '../store/repositories.js';
import { AutoTrader, type DecisionModel } from './autoTrader.js';
import type { BrokerPort } from './brokerPort.js';

let workDir: string;
let accountId: number;
let modelId: number;
let strategyId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-m1-'));
  initDb(path.join(workDir, 'm1.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  for (const table of [
    'trade_events',
    'trades',
    'orders',
    'positions',
    'decision_records',
    'equity_snapshots',
    'runtime_logs',
    'traders',
    'strategies',
    'ai_models',
    'exchange_accounts',
  ]) {
    db.run(`DELETE FROM ${table}`);
  }
  accountId = exchanges.create({
    exchange: 'binance',
    label: 'm1-acc',
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  }).id;
  modelId = aiModels.create({
    provider: 'deepseek',
    label: 'm1-model',
    model: 'deepseek-v4.1-flash',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 0,
  }).id;
  strategyId = strategies.create({
    name: 'm1-strat',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  }).id;
});

function makeRegistry(): SymbolRegistry {
  const sym = (name: string): BinanceExchangeInfo['symbols'][number] => ({
    symbol: name,
    pair: name,
    contractType: 'PERPETUAL',
    deliveryDate: 0,
    status: 'TRADING',
    baseAsset: name.replace('USDT', ''),
    quoteAsset: 'USDT',
    marginAsset: 'USDT',
    pricePrecision: 4,
    quantityPrecision: 3,
    baseAssetPrecision: 8,
    quotePrecision: 8,
    underlyingType: 'COIN',
    orderTypes: [],
    timeInForce: [],
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.001' },
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100000' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ],
  });
  return SymbolRegistry.fromExchangeInfo({
    exchangeFilters: [],
    rateLimits: [],
    serverTime: 0,
    symbols: [sym('BTCUSDT'), sym('SOLUSDT'), sym('ILLIQUSDT')],
  });
}

function makeKline(price: number): Kline {
  return {
    openTime: Date.now() - 300_000,
    closeTime: Date.now(),
    open: price * 0.995,
    high: price * 1.005,
    low: price * 0.99,
    close: price,
    volume: 1000,
    quoteVolume: 1000 * price,
    trades: 10,
    takerBuyBase: 500,
    takerBuyQuote: 500 * price,
  };
}

function makeFakeMarket(marks: Record<string, number>): MarketPort {
  return {
    async getKlines(symbol: string) {
      const p = marks[symbol] ?? 100;
      return [makeKline(p), makeKline(p * 1.002), makeKline(p * 1.004)];
    },
    async getTickers24h() {
      return [];
    },
    async getPremiumIndexes() {
      return [];
    },
    async getOpenInterest() {
      return 0;
    },
    async getOpenInterestHist() {
      return [];
    },
    async getOrderBook() {
      return { bids: [], asks: [] };
    },
    async getMarkPrice(symbol: string) {
      return marks[symbol] ?? 100;
    },
    async getLongShortRatio() {
      return [];
    },
  } as unknown as MarketPort;
}

function makeSnapshot(symbol: string, price: number, quoteVolume24h: number): MarketSnapshot {
  const kline = makeKline(price);
  return {
    symbol,
    sources: ['static'],
    price,
    quoteVolume24h,
    priceChangePercent24h: 2.5,
    high24h: price * 1.04,
    low24h: price * 0.96,
    primary: {
      timeframe: '5m',
      klines: [kline],
      closes: [price],
      volumes: [1000],
      ema: { ema20: [price * 0.99] },
      rsi: { rsi7: [55] },
      atr: { atr14: [price * 0.01] },
      macd: null,
    },
    isMajor: symbol === 'BTCUSDT',
    timeframes: [],
    derivatives: {
      openInterest: 100_000,
      openInterestUsd: 50_000_000,
      openInterestAvg: 100_000,
      openInterestChangePercent: {},
      fundingRate: 0.0001,
      nextFundingTime: null,
      markPrice: price,
      indexPrice: price,
    },
    quant: null,
  };
}

function makeFakeBroker(options: {
  dryRun?: boolean;
  marks: Record<string, number>;
  restingOrder?: { id: string; symbol: string; avgPrice: number; qty: number; filled: boolean };
}) {
  let seq = 1000;
  const placed: Array<{ symbol: string; type: string; side: string; price?: number; triggerPrice?: number }> = [];
  const broker = {
    isDryRun: options.dryRun ?? true,
    async ensureOneWayMode() {
      return { changed: false };
    },
    async getAccountState() {
      return {
        equity: 1000,
        walletBalance: 1000,
        availableBalance: 900,
        unrealizedPnl: 0,
        marginUsed: 0,
        openOrderMargin: 0,
      };
    },
    async getPositions() {
      return [];
    },
    async getMarkPrice(symbol: string) {
      return options.marks[symbol] ?? 100;
    },
    async getMaxLeverage() {
      return 20;
    },
    async setLeverage(_symbol: string, leverage: number) {
      return { ok: true, leverage };
    },
    async setMarginType() {
      return { ok: true };
    },
    async placeOrder(req: { symbol: string; type: string; side: string; quantity?: number; price?: number; triggerPrice?: number }) {
      seq += 1;
      placed.push({
        symbol: req.symbol,
        type: req.type,
        side: req.side,
        price: req.price,
        triggerPrice: req.triggerPrice,
      });
      const mark = options.marks[req.symbol] ?? 100;
      const isAlgo = req.type === 'STOP_MARKET' || req.type === 'TAKE_PROFIT_MARKET';
      return {
        id: String(seq),
        clientOrderId: `c-${seq}`,
        symbol: req.symbol,
        side: req.side,
        type: req.type,
        status: isAlgo ? 'NEW' : 'FILLED',
        terminal: !isAlgo,
        executedQty: isAlgo ? 0 : (req.quantity ?? 0),
        avgPrice: isAlgo ? 0 : (req.price ?? mark),
        cumQuote: isAlgo ? 0 : (req.quantity ?? 0) * (req.price ?? mark),
        raw: {},
      };
    },
    async getOrder(symbol: string, orderId: string) {
      if (options.restingOrder && options.restingOrder.id === orderId && options.restingOrder.symbol === symbol) {
        return {
          status: options.restingOrder.filled ? 'FILLED' : 'NEW',
          executedQty: options.restingOrder.filled ? String(options.restingOrder.qty) : '0',
          avgPrice: options.restingOrder.filled ? String(options.restingOrder.avgPrice) : '0',
        };
      }
      return null;
    },
    async getOpenOrders() {
      return [];
    },
    async getOpenAlgoOrders() {
      return [];
    },
    async cancelOrder() {
      return true;
    },
    async cancelAlgoOrder() {
      return true;
    },
    async cancelAllOrders() {
      return 0;
    },
    async cancelAllAlgoOrders() {
      return 0;
    },
    async getAlgoOrder() {
      return null;
    },
    async getUserTrades() {
      return [];
    },
    async getIncome() {
      return [];
    },
    async waitForFill(_s: string, orderId: string, initial?: unknown) {
      return initial ?? { id: orderId, status: 'FILLED', terminal: true, executedQty: 1, avgPrice: 100 };
    },
  };
  return { broker: broker as unknown as BrokerPort, placed };
}

test('★ M1.2 智能托管通过 get_klines 查验过的池外高流动性标的自动热加入本轮可执行池；低流动性标的不加入；固定策略不热加入', async () => {
  const prevBudget = process.env.AQ_ENFORCE_RISK_BUDGET;
  process.env.AQ_ENFORCE_RISK_BUDGET = 'false';
  try {
    const registry = makeRegistry();
    const baseSnapshots = [makeSnapshot('BTCUSDT', 68_000, 5_000_000_000)];
    const extraSnapshots: Record<string, MarketSnapshot> = {
      SOLUSDT: makeSnapshot('SOLUSDT', 150, 250_000_000), // 高于 100M 门槛 → 应热加入
      ILLIQUSDT: makeSnapshot('ILLIQUSDT', 1, 5_000_000), // 低于 100M 门槛 → 拒绝热加入
    };

    const marketData = {
      async buildSnapshots() {
        return baseSnapshots.map((s) => ({ ...s }));
      },
      async buildSnapshot(symbol: string) {
        return extraSnapshots[symbol] ? { ...extraSnapshots[symbol]! } : null;
      },
      async getOiRanking() {
        return [];
      },
      async fullMarketOverview() {
        return [];
      },
      async topRankings() {
        return undefined;
      },
      async getKlines(symbol: string) {
        const snap = extraSnapshots[symbol] ?? baseSnapshots[0]!;
        return snap.primary.klines;
      },
      async getFundingRate() {
        return 0.0001;
      },
      async markPricesOf() {
        return new Map([['BTCUSDT', 68_000], ['SOLUSDT', 150], ['ILLIQUSDT', 1]]);
      },
    } as unknown as MarketDataService;

    // 1) ai_managed：先调用 get_klines 查 SOLUSDT & ILLIQUSDT，再同时提议开仓两者
    const managedTrader = traders.create({
      name: 'm1-managed',
      exchangeAccountId: null,
      aiModelId: modelId,
      strategyId: null,
      cycleIntervalMinutes: 15,
      initialEquity: 1000,
      paperStartingBalance: 1000,
      mode: 'ai_managed',
      dryRun: true,
    });
    const managedCfg: StrategyConfig = {
      ...unboundedAiManagedConfig(),
      coinSource: {
        ...unboundedAiManagedConfig().coinSource,
        sourceType: 'static',
        staticCoins: ['BTCUSDT'],
        useCoinPool: false,
        useOITop: false,
        minQuoteVolume24h: 100_000_000,
      },
    };
    const { broker: b1, placed: placed1 } = makeFakeBroker({
      dryRun: true,
      marks: { BTCUSDT: 68_000, SOLUSDT: 150, ILLIQUSDT: 1 },
    });

    let round1 = 0;
    const model1: DecisionModel = {
      async complete() {
        round1 += 1;
        if (round1 === 1) {
          return {
            text:
              '<tool>{"tool":"get_klines","args":{"symbol":"SOLUSDT","timeframe":"15m","count":30}}</tool>\n' +
              '<tool>{"tool":"get_klines","args":{"symbol":"ILLIQUSDT","timeframe":"15m","count":30}}</tool>',
            latencyMs: 5,
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        return {
          text:
            '<reasoning>SOL 达标、ILLIQ 流动性不足</reasoning>\n' +
            '<decision>{"decisions":[' +
            '{"symbol":"SOLUSDT","action":"open_long","leverage":3,"position_size_usd":300,"stop_loss":142,"take_profit":174,"confidence":80,"reasoning":"ok"},' +
            '{"symbol":"ILLIQUSDT","action":"open_long","leverage":3,"position_size_usd":300,"stop_loss":0.92,"take_profit":1.24,"confidence":80,"reasoning":"illiq"}' +
            ']}</decision>',
          latencyMs: 5,
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const market = makeFakeMarket({ BTCUSDT: 68_000, SOLUSDT: 150, ILLIQUSDT: 1 });
    const at1 = new AutoTrader({
      trader: managedTrader,
      config: managedCfg,
      broker: b1,
      market,
      marketData,
      registry,
      model: model1,
    });
    await at1.runOnce();

    assert.ok(
      placed1.some((p) => p.symbol === 'SOLUSDT' && p.type === 'MARKET'),
      'SOLUSDT 通过 get_klines 且满足流动性门槛，应热加入并成功开仓',
    );
    assert.ok(
      !placed1.some((p) => p.symbol === 'ILLIQUSDT'),
      'ILLIQUSDT 低于流动性门槛，绝不可热加入开仓',
    );
    const rec1 = decisionStore.list(managedTrader.id, 1)[0]!;
    assert.ok(rec1.candidateSymbols.includes('SOLUSDT'), '审计记录候选池应包含热加入的 SOLUSDT');
    assert.ok(!rec1.candidateSymbols.includes('ILLIQUSDT'));

    // 2) strategy（固定策略模式）：同样查了 SOLUSDT，但固定策略不得绕开静态白名单热加入
    const stratTrader = traders.create({
      name: 'm1-strategy',
      exchangeAccountId: accountId,
      aiModelId: modelId,
      strategyId,
      cycleIntervalMinutes: 15,
      initialEquity: 1000,
      mode: 'strategy',
      dryRun: true,
    });
    const stratCfg: StrategyConfig = {
      ...defaultStrategyConfig(),
      coinSource: {
        ...defaultStrategyConfig().coinSource,
        sourceType: 'static',
        staticCoins: ['BTCUSDT'],
        useCoinPool: false,
        useOITop: false,
      },
    };
    const { broker: b2, placed: placed2 } = makeFakeBroker({
      dryRun: true,
      marks: { BTCUSDT: 68_000, SOLUSDT: 150 },
    });
    let round2 = 0;
    const model2: DecisionModel = {
      async complete() {
        round2 += 1;
        if (round2 === 1) {
          return {
            text: '<tool>{"tool":"get_klines","args":{"symbol":"SOLUSDT","timeframe":"15m","count":30}}</tool>',
            latencyMs: 5,
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        return {
          text:
            '<reasoning>try sol</reasoning>\n' +
            '<decision>{"decisions":[{"symbol":"SOLUSDT","action":"open_long","leverage":3,"position_size_usd":300,"stop_loss":142,"take_profit":174,"confidence":85,"reasoning":"try"}]}</decision>',
          latencyMs: 5,
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };
    const at2 = new AutoTrader({
      trader: stratTrader,
      config: stratCfg,
      broker: b2,
      market,
      marketData,
      registry,
      model: model2,
    });
    await at2.runOnce();
    assert.equal(
      placed2.filter((p) => p.symbol === 'SOLUSDT').length,
      0,
      '固定策略模式不得热加入池外标的',
    );
  } finally {
    if (prevBudget === undefined) delete process.env.AQ_ENFORCE_RISK_BUDGET;
    else process.env.AQ_ENFORCE_RISK_BUDGET = prevBudget;
  }
});

test('★ M1.3 限价单挂出前若实时标记价已穿止损则直接拦下 + 30s 守卫能及时结清已成交限价单挂上保护单', async () => {
  const prevBudget = process.env.AQ_ENFORCE_RISK_BUDGET;
  process.env.AQ_ENFORCE_RISK_BUDGET = 'false';
  try {
    const registry = makeRegistry();
    const trader = traders.create({
      name: 'm1-limit',
      exchangeAccountId: null,
      aiModelId: modelId,
      strategyId: null,
      cycleIntervalMinutes: 15,
      initialEquity: 1000,
      paperStartingBalance: 1000,
      mode: 'ai_managed',
      dryRun: true,
    });
    const cfg: StrategyConfig = {
      ...unboundedAiManagedConfig(),
      coinSource: {
        ...unboundedAiManagedConfig().coinSource,
        sourceType: 'static',
        staticCoins: ['SOLUSDT'],
        useCoinPool: false,
        useOITop: false,
      },
    };

    // 场景 A：快照价 150（风控放行空单限价 152 / 止损 156），但下单瞬间标记价已跳到 157（穿越止损）
    const { broker: bA, placed: placedA } = makeFakeBroker({
      dryRun: true,
      marks: { SOLUSDT: 157 },
    });
    const marketDataA = {
      async buildSnapshots() {
        return [makeSnapshot('SOLUSDT', 150, 250_000_000)];
      },
      async getOiRanking() {
        return [];
      },
      async fullMarketOverview() {
        return [];
      },
      async topRankings() {
        return undefined;
      },
      async getKlines() {
        return [];
      },
      async getFundingRate() {
        return 0.0001;
      },
      async markPricesOf() {
        return new Map([['SOLUSDT', 157]]);
      },
    } as unknown as MarketDataService;
    const modelA: DecisionModel = {
      async complete() {
        return {
          text:
            '<reasoning>limit short</reasoning>\n' +
            '<decision>{"decisions":[{"symbol":"SOLUSDT","action":"open_short","entry_type":"limit","limit_price":152,"leverage":3,"position_size_usd":300,"stop_loss":156,"take_profit":140,"confidence":80,"reasoning":"limit"}]}</decision>',
          latencyMs: 5,
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };
    const marketA = makeFakeMarket({ SOLUSDT: 157 });
    const atA = new AutoTrader({
      trader,
      config: cfg,
      broker: bA,
      market: marketA,
      marketData: marketDataA,
      registry,
      model: modelA,
    });
    await atA.runOnce();
    assert.equal(placedA.length, 0, '标记价已穿止损时绝不可发出限价单');
    assert.ok(
      orderStore.list(trader.id).some((o) => o.status === 'REJECTED' && String(o.error ?? '').includes('止损已失效')),
      '拒绝原因必须留痕到 orders 表',
    );

    // 场景 B：存在已成交的 pending 限价单，runGuardTick（30s 实时守卫）应立即转正并挂上止损+止盈
    const { broker: bB, placed: placedB } = makeFakeBroker({
      dryRun: true,
      marks: { SOLUSDT: 149 },
      restingOrder: { id: 'LIM-99', symbol: 'SOLUSDT', avgPrice: 150, qty: 2, filled: true },
    });
    positionStore.insert({
      traderId: trader.id,
      symbol: 'SOLUSDT',
      side: 'short',
      quantity: 2,
      entryPrice: 150,
      leverage: 3,
      liquidationPrice: null,
      marginUsed: 100,
      stopLoss: 156,
      takeProfit: 138,
      stopOrderId: null,
      tpOrderId: null,
      openReasoning: 'resting limit',
      entryOrderId: 'LIM-99',
      status: 'pending',
    });
    const atB = new AutoTrader({
      trader,
      config: cfg,
      broker: bB,
      market: makeFakeMarket({ SOLUSDT: 149 }),
      marketData: marketDataA,
      registry,
      model: modelA,
    });
    const internals = atB as unknown as { running: boolean; runGuardTick: () => Promise<void> };
    internals.running = true;
    await internals.runGuardTick();
    assert.equal(positionStore.pending(trader.id).length, 0, '30s 实时守卫应已结清 pending 限价单');
    assert.equal(positionStore.open(trader.id).length, 1, '已转正为真实持仓');
    assert.ok(
      placedB.some((p) => p.type === 'STOP_MARKET' && p.triggerPrice === 156),
      '转正同时应立即挂上止损单',
    );
    assert.ok(
      placedB.some((p) => p.type === 'TAKE_PROFIT_MARKET' && p.triggerPrice === 138),
      '转正同时应立即挂上止盈单',
    );
  } finally {
    if (prevBudget === undefined) delete process.env.AQ_ENFORCE_RISK_BUDGET;
    else process.env.AQ_ENFORCE_RISK_BUDGET = prevBudget;
  }
});

test('★ M1.4 模拟盘持仓跨过 8 小时结算点平仓时，按标的资金费率记入 funding_fee', async () => {
  const registry = makeRegistry();
  const trader = traders.create({
    name: 'm1-funding',
    exchangeAccountId: null,
    aiModelId: modelId,
    strategyId: null,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
    paperStartingBalance: 1000,
    mode: 'ai_managed',
    dryRun: true,
  });
  const cfg = unboundedAiManagedConfig();
  const { broker } = makeFakeBroker({ dryRun: true, marks: { SOLUSDT: 150 } });
  const marketData = {
    async buildSnapshots() {
      return [];
    },
    async getFundingRate() {
      return 0.0002; // +0.02% 每 8h
    },
  } as unknown as MarketDataService;
  const dummyModel: DecisionModel = {
    async complete() {
      return { text: '<decision>{"decisions":[]}</decision>', latencyMs: 1, usage: { promptTokens: 0, completionTokens: 0 } };
    },
  };

  // 插入一笔 10 小时前（必然跨越至少 1 个 8h UTC 结算点）的多头模拟仓：名义 1500 U
  const openedAt = new Date(Date.now() - 10 * 3600_000).toISOString();
  positionStore.insert({
    traderId: trader.id,
    symbol: 'SOLUSDT',
    side: 'long',
    quantity: 10,
    entryPrice: 150,
    leverage: 3,
    liquidationPrice: null,
    marginUsed: 500,
    stopLoss: 140,
    takeProfit: 180,
    stopOrderId: null,
    tpOrderId: null,
    openReasoning: 'test funding',
  });
  getDb().run('UPDATE positions SET opened_at = ? WHERE trader_id = ?', openedAt, trader.id);

  const at = new AutoTrader({
    trader,
    config: cfg,
    broker,
    market: makeFakeMarket({ SOLUSDT: 150 }),
    marketData,
    registry,
    model: dummyModel,
  });
  const closed = await at.closeManually('SOLUSDT');
  assert.ok(closed, '手工平仓应成功');
  const rows = tradeStore.list(trader.id);
  assert.equal(rows.length, 1);
  assert.ok(
    rows[0]!.fundingFee < 0,
    `正费率多头持仓 10h 应支出负资金费，实际 fundingFee=${rows[0]!.fundingFee}`,
  );
});
