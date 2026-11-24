/**
 * M2.4 单元测试 & 端到端集成测试：
 *   1. `buildManagedPrompts` 严格 ≤ 30,000 字符硬红线（常规 5 标的 + 极端 10 持仓压测）
 *   2. 输出包含黄金三周期（4h/15m/1m）、AI500 六维拆解、筹码结构、清算磁吸、15m Δ 与前缀缓存拆分
 *   3. 端到端接入 `AutoTrader`（`mode: 'ai_managed'`）：动态全市场雷达选币 → 精简 Prompt → 风控开仓 → 次轮产出真实 15m Δ
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import {
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
import { scoreAi500Symbol, type RadarUniverseRow } from '../radar/ai500.js';
import { computeRadarDelta } from '../radar/deltaTracker.js';
import { computeVolumeProfile } from '../radar/volumeProfile.js';
import {
  aiModels,
  decisions as decisionStore,
  traders,
} from '../store/repositories.js';
import { AutoTrader, type DecisionModel } from '../trader/autoTrader.js';
import type { BrokerPort } from '../trader/brokerPort.js';
import {
  buildManagedPrompts,
  MANAGED_PROMPT_CHAR_LIMIT,
  type ManagedSymbolDossier,
} from './prompt.js';

function makeSeries(
  count: number,
  startPrice: number,
  stepPct: number,
  intervalMs: number,
  quoteVol = 2_000_000,
  takerBuyRatio = 0.6,
): Kline[] {
  const out: Kline[] = [];
  const base = Date.UTC(2026, 10, 24, 0, 0, 0);
  let p = startPrice;
  for (let i = 0; i < count; i += 1) {
    const o = p;
    const c = o * (1 + stepPct);
    const h = Math.max(o, c) * 1.003;
    const l = Math.min(o, c) * 0.997;
    const v = quoteVol / c;
    out.push({
      openTime: base + i * intervalMs,
      closeTime: base + (i + 1) * intervalMs - 1,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v,
      quoteVolume: quoteVol,
      trades: 80,
      takerBuyBase: v * takerBuyRatio,
      takerBuyQuote: quoteVol * takerBuyRatio,
    });
    p = c;
  }
  return out;
}

function makeDossier(symbol: string, price: number, isHeld: boolean): ManagedSymbolDossier {
  const k15 = makeSeries(96, price * 0.95, 0.0006, 15 * 60_000, 3_000_000, 0.61);
  const k4h = makeSeries(40, price * 0.85, 0.004, 4 * 3600_000, 30_000_000, 0.59);
  const k1m = makeSeries(30, price * 0.996, 0.00015, 60_000, 300_000, 0.58);
  const radar = scoreAi500Symbol({
    symbol,
    price,
    quoteVolume24h: 600_000_000,
    changePercent24h: 6.5,
    fundingRate: -0.00015,
    klines15m: k15,
    klines4h: k4h,
    openInterestUsd: 240_000_000,
    oiChange1hPct: 2.8,
    oiChange4hPct: 5.4,
    btcReturn1hPct: 0.2,
    btcReturn4hPct: 0.4,
  });
  const vp = computeVolumeProfile(k15, price);
  const delta = computeRadarDelta(
    {
      symbol,
      timestampMs: Date.UTC(2026, 10, 24, 12, 0, 0),
      score: Math.max(50, radar.score - 6),
      bias: radar.bias,
      price: price * 0.99,
      openInterestUsd: 230_000_000,
      takerBuyRatio1h: 0.55,
      pocOffsetPct: (vp?.pocOffsetPct ?? 0) + 0.4,
    },
    {
      symbol,
      timestampMs: Date.UTC(2026, 10, 24, 12, 15, 0),
      score: radar.score,
      bias: radar.bias,
      price,
      openInterestUsd: 240_000_000,
      takerBuyRatio1h: radar.metrics.takerBuyRatio1h,
      pocOffsetPct: vp?.pocOffsetPct ?? null,
    },
  );
  return {
    symbol,
    isHeld,
    radar,
    volumeProfile: vp,
    delta,
    klines: { '4h': k4h.slice(-30), '15m': k15.slice(-30), '1m': k1m.slice(-30) },
    minNotionalUsd: 5,
    maxLeverage: 10,
  };
}

test('★ M2.4 常规 4 候选 + 1 持仓与极端 10 持仓压测均严格满足 User Prompt ≤ 30,000 字符', () => {
  const cfg = unboundedAiManagedConfig();
  const baseDossiers = [
    makeDossier('SOLUSDT', 150, true),
    makeDossier('ETHUSDT', 3200, false),
    makeDossier('AVAXUSDT', 42, false),
    makeDossier('SUIUSDT', 3.4, false),
    makeDossier('LINKUSDT', 18.5, false),
  ];

  const normal = buildManagedPrompts({
    traderName: 'ai-managed-2',
    cycleNumber: 12,
    now: new Date('2026-11-24T12:15:00Z'),
    config: cfg,
    account: { equity: 1000, availableBalance: 850, unrealizedPnl: 12.5, marginUsed: 150, positionCount: 1 },
    positions: [],
    pendingEntries: [],
    dossiers: baseDossiers,
    radarLeaderboard: baseDossiers.map((d) => d.radar),
    btcBenchmarkLine: 'BTCUSDT 68500.0 · 1h +0.3% · 4h +0.8% · 24h +1.5%',
    cycleIntervalMinutes: 15,
    roundTripCostPercent: 0.1,
    memory: {
      performance: {
        windowHours: 24,
        totalTrades: 2,
        wins: 1,
        losses: 1,
        grossPnl: 19.7,
        totalFees: 1.2,
        totalFunding: 0,
        netPnl: 18.5,
        avgWin: 23.7,
        avgLoss: 5.2,
        realizedPayoffRatio: 4.56,
        roundTripFeeRate: 0.001,
        byCloseReason: [],
        idleCycles: 0,
      },
      recentCloses: [],
      throttle: { entriesThisHour: 0, maxEntriesPerHour: 10, minutesSinceLastExit: null, reentryCooldownMinutes: 0 },
      recentRejections: [],
      lessons: [
        { symbol: 'SOLUSDT', closeReason: 'stop_loss', netPnl: -5.2, lesson: 'SOL 放量突破前高时 15m 回踩 POC 胜率更高' },
      ],
    },
  });

  assert.ok(
    normal.userPrompt.length <= MANAGED_PROMPT_CHAR_LIMIT,
    `常规 Prompt 必须 ≤ ${MANAGED_PROMPT_CHAR_LIMIT}，实际 ${normal.userPrompt.length}`,
  );
  assert.ok(normal.userPrompt.length > 4000, '应包含完整多周期结构化数据，而非空壳');
  assert.ok(normal.stablePrompt.length > 0 && normal.volatilePrompt.length > 0, '必须拆分为稳定段与变动段以命中前缀缓存');
  assert.match(normal.userPrompt, /AI500/);
  assert.match(normal.userPrompt, /POC /);
  assert.match(normal.userPrompt, /环比Δ\(15m前\)/);
  assert.match(normal.userPrompt, /\[4h ×/);
  assert.match(normal.userPrompt, /\[15m ×/);
  assert.match(normal.userPrompt, /\[1m ×/);

  // 极端压测：10 个持仓 + 5 个候选，自动逐级压缩，绝对不能超 30,000 字符
  const heavyDossiers = Array.from({ length: 15 }, (_, i) =>
    makeDossier(`SYM${i}USDT`, 10 + i * 3, i < 10),
  );
  const heavy = buildManagedPrompts({
    traderName: 'ai-managed-stress',
    cycleNumber: 99,
    now: new Date('2026-11-24T12:30:00Z'),
    config: cfg,
    account: { equity: 10000, availableBalance: 2000, unrealizedPnl: 220, marginUsed: 8000, positionCount: 10 },
    positions: [],
    pendingEntries: [],
    dossiers: heavyDossiers,
    radarLeaderboard: heavyDossiers.map((d) => d.radar),
    btcBenchmarkLine: 'BTCUSDT 68500.0',
    cycleIntervalMinutes: 15,
  });
  assert.ok(
    heavy.userPrompt.length <= MANAGED_PROMPT_CHAR_LIMIT,
    `15 标的极端压测必须 ≤ ${MANAGED_PROMPT_CHAR_LIMIT}，实际 ${heavy.userPrompt.length}`,
  );
  assert.ok(heavy.stats.compactionLevel >= 1, '极端场景应自动触发压缩档位');
});

/* -------------------------------------------------------------------------- */
/*  End-to-End AutoTrader Integration (ai_managed 2.0)                         */
/* -------------------------------------------------------------------------- */

let workDir: string;
let modelId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-m2-'));
  initDb(path.join(workDir, 'm2.sqlite'));
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
    'ai_models',
  ]) {
    db.run(`DELETE FROM ${table}`);
  }
  modelId = aiModels.create({
    provider: 'deepseek',
    label: 'm2-model',
    model: 'deepseek-v4.1-flash',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 0,
  }).id;
});

function makeRegistry(symbols: string[]): SymbolRegistry {
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
    symbols: symbols.map(sym),
  });
}

test('★ M2 端到端集成：ai_managed 走全市场 AI500 雷达 → ≤3万字三周期 Prompt → 成功风控开仓 → 次轮输出环比 Δ', async () => {
  const prevBudget = process.env.AQ_ENFORCE_RISK_BUDGET;
  process.env.AQ_ENFORCE_RISK_BUDGET = 'false';
  try {
    const syms = ['BTCUSDT', 'SOLUSDT', 'AVAXUSDT', 'TINYUSDT', 'USDCUSDT'];
    const registry = makeRegistry(syms);
    const trader = traders.create({
      name: 'm2-e2e',
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
        sourceType: 'coinpool',
        minQuoteVolume24h: 30_000_000,
      },
    };

    const universe: RadarUniverseRow[] = [
      { symbol: 'BTCUSDT', price: 68000, quoteVolume24h: 6_000_000_000, changePercent24h: 0.6, high24h: 68500, low24h: 67500, fundingRate: 0.0001 },
      { symbol: 'SOLUSDT', price: 150, quoteVolume24h: 950_000_000, changePercent24h: 8.2, high24h: 153, low24h: 138, fundingRate: -0.00022 },
      { symbol: 'AVAXUSDT', price: 40, quoteVolume24h: 450_000_000, changePercent24h: -7.1, high24h: 44, low24h: 39.5, fundingRate: 0.00028 },
      { symbol: 'TINYUSDT', price: 0.2, quoteVolume24h: 2_000_000, changePercent24h: 15, high24h: 0.22, low24h: 0.18, fundingRate: 0.0001 },
      { symbol: 'USDCUSDT', price: 1.0, quoteVolume24h: 800_000_000, changePercent24h: 0.0, high24h: 1.001, low24h: 0.999, fundingRate: 0 },
    ];

    const klineMap: Record<string, { '4h': Kline[]; '15m': Kline[]; '1m': Kline[] }> = {
      BTCUSDT: {
        '4h': makeSeries(45, 67500, 0.0001, 4 * 3600_000, 80_000_000, 0.51),
        '15m': makeSeries(96, 67800, 0.00003, 15 * 60_000, 12_000_000, 0.51),
        '1m': makeSeries(30, 67980, 0.00001, 60_000, 800_000, 0.51),
      },
      SOLUSDT: {
        '4h': makeSeries(45, 118, 0.0055, 4 * 3600_000, 35_000_000, 0.61),
        '15m': makeSeries(96, 134, 0.0012, 15 * 60_000, 4_000_000, 0.63),
        '1m': makeSeries(30, 149.2, 0.0002, 60_000, 350_000, 0.62),
      },
      AVAXUSDT: {
        '4h': makeSeries(45, 51, -0.0052, 4 * 3600_000, 22_000_000, 0.38),
        '15m': makeSeries(96, 44.5, -0.0011, 15 * 60_000, 2_500_000, 0.37),
        '1m': makeSeries(30, 40.3, -0.0002, 60_000, 220_000, 0.39),
      },
    };

    const makeSnap = (symbol: string): MarketSnapshot => {
      const row = universe.find((u) => u.symbol === symbol)!;
      const k15 = klineMap[symbol]!['15m'];
      return {
        symbol,
        sources: ['ai500_radar'],
        price: row.price,
        quoteVolume24h: row.quoteVolume24h,
        priceChangePercent24h: row.changePercent24h,
        high24h: row.high24h,
        low24h: row.low24h,
        primary: {
          timeframe: '15m',
          klines: k15,
          closes: k15.map((k) => k.close),
          volumes: k15.map((k) => k.volume),
          ema: { ema20: [row.price * 0.99] },
          rsi: { rsi7: [58] },
          atr: { atr14: [row.price * 0.01] },
          macd: null,
        },
        isMajor: symbol === 'BTCUSDT',
        timeframes: [],
        derivatives: {
          openInterest: 1_500_000,
          openInterestUsd: 225_000_000,
          openInterestAvg: 1_400_000,
          openInterestChangePercent: { '1h': 3.2, '4h': 6.0 },
          fundingRate: row.fundingRate,
          nextFundingTime: null,
          markPrice: row.price,
          indexPrice: row.price,
        },
        quant: null,
      };
    };

    const marketData = {
      async getUniverseOverview() {
        return universe;
      },
      async getKlines(symbol: string, tf: '4h' | '15m' | '1m', count: number) {
        return (klineMap[symbol]?.[tf] ?? []).slice(-count);
      },
      async buildSnapshot(symbol: string) {
        return klineMap[symbol] ? makeSnap(symbol) : null;
      },
      async buildSnapshots(list: string[]) {
        return list.filter((s) => klineMap[s]).map(makeSnap);
      },
      async screenUniverse() {
        return ['BTCUSDT', 'SOLUSDT', 'AVAXUSDT'];
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
      async getFundingRate(symbol: string) {
        return universe.find((u) => u.symbol === symbol)?.fundingRate ?? 0.0001;
      },
      async markPricesOf() {
        return new Map([['BTCUSDT', 68000], ['SOLUSDT', 150], ['AVAXUSDT', 40]]);
      },
    } as unknown as MarketDataService;

    const market = {
      async openInterest(symbol: string) {
        return symbol === 'BTCUSDT' ? 80_000 : 1_500_000;
      },
      async openInterestHist() {
        return [
          { sumOpenInterest: '1400000' },
          { sumOpenInterest: '1420000' },
          { sumOpenInterest: '1450000' },
          { sumOpenInterest: '1470000' },
          { sumOpenInterest: '1500000' },
        ];
      },
    } as unknown as MarketPort;

    const placed: Array<{ symbol: string; type: string; side: string }> = [];
    let seq = 2000;
    const broker = {
      isDryRun: true,
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
        return universe.find((u) => u.symbol === symbol)?.price ?? 100;
      },
      async getMaxLeverage() {
        return 20;
      },
      async setLeverage(_s: string, l: number) {
        return { ok: true, leverage: l };
      },
      async setMarginType() {
        return { ok: true };
      },
      async placeOrder(req: { symbol: string; type: string; side: string; quantity?: number; price?: number }) {
        seq += 1;
        placed.push({ symbol: req.symbol, type: req.type, side: req.side });
        const mark = universe.find((u) => u.symbol === req.symbol)?.price ?? 100;
        const isAlgo = req.type === 'STOP_MARKET' || req.type === 'TAKE_PROFIT_MARKET';
        return {
          id: String(seq),
          clientOrderId: `m2-${seq}`,
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
      async getOrder() {
        return null;
      },
      async getAlgoOrder() {
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
      async getUserTrades() {
        return [];
      },
      async getIncome() {
        return [];
      },
      async waitForFill(symbol: string, orderId: string, initial?: unknown) {
        if (initial) return initial;
        const mark = universe.find((u) => u.symbol === symbol)?.price ?? 100;
        return { id: orderId, status: 'FILLED', terminal: true, executedQty: 2, avgPrice: mark };
      },
    } as unknown as BrokerPort;

    const capturedPrompts: string[] = [];
    let openedOnce = false;
    const model: DecisionModel = {
      async complete(_sys, user) {
        const isReceiptFollowUp = user.includes('执行结果') || user.includes('执行回执');
        if (!isReceiptFollowUp) capturedPrompts.push(user);
        if (!isReceiptFollowUp && !openedOnce) {
          openedOnce = true;
          return {
            text:
              '<reasoning>SOLUSDT AI500 高分多头顺势起爆，结构位置合理</reasoning>\n' +
              '<decision>{"decisions":[{"symbol":"SOLUSDT","action":"open_long","leverage":3,"position_size_usd":300,"stop_loss":142,"take_profit":174,"confidence":84,"reasoning":"AI500 breakout"}]}</decision>',
            latencyMs: 10,
            usage: { promptTokens: 4500, completionTokens: 120 },
          };
        }
        return {
          text: '<reasoning>继续持有观察</reasoning>\n<decision>{"decisions":[]}</decision>',
          latencyMs: 10,
          usage: { promptTokens: 4600, completionTokens: 60 },
        };
      },
    };

    const at = new AutoTrader({
      trader,
      config: cfg,
      broker,
      market,
      marketData,
      registry,
      model,
    });

    // 第 1 轮：雷达扫描 + 精简 Prompt + 开仓 SOLUSDT
    await at.runOnce();
    const rec1 = decisionStore.list(trader.id, 1)[0]!;
    const p1 = rec1.userPrompt;
    assert.ok(p1.length <= MANAGED_PROMPT_CHAR_LIMIT, `第 1 轮 Prompt 超限：${p1.length}`);
    assert.match(p1, /SOLUSDT/);
    assert.match(p1, /AVAXUSDT/);
    assert.doesNotMatch(p1, /TINYUSDT/, '低流动性标的绝不可进入雷达展开');
    assert.doesNotMatch(p1, /USDCUSDT/, '稳定币绝不可进入雷达展开');
    assert.match(p1, /AI500/);
    assert.match(p1, /POC /);
    assert.match(p1, /\[4h ×/);
    assert.match(p1, /\[15m ×/);
    assert.match(p1, /\[1m ×/);
    assert.ok(
      placed.some((o) => o.symbol === 'SOLUSDT' && o.type === 'MARKET'),
      '雷达选出的 SOLUSDT 应顺利通过风控并下单',
    );
    assert.ok(rec1.candidateSymbols.includes('SOLUSDT'));

    // 第 2 轮：推进时间后再跑一轮，审计记录的 Prompt 必须包含真实 环比Δ 而不是首轮基准
    await new Promise((r) => setTimeout(r, 15));
    await at.runOnce();
    const rec2 = decisionStore.list(trader.id, 1)[0]!;
    const p2 = rec2.userPrompt;
    assert.ok(p2.length <= MANAGED_PROMPT_CHAR_LIMIT);
    assert.match(p2, /环比Δ\(/, '第 2 轮必须输出真实环比增量 Δ');
  } finally {
    if (prevBudget === undefined) delete process.env.AQ_ENFORCE_RISK_BUDGET;
    else process.env.AQ_ENFORCE_RISK_BUDGET = prevBudget;
  }
});
