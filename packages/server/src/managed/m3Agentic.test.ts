/**
 * 里程碑 3（M3）全链路单元与端到端集成测试：
 *   - M3.1 持仓论点 `thesis` 持久化 + 30s 确定性机器硬检查（`thesis_mae_stop` & `thesis_time_stop`，绝不误杀已盈利赢家）
 *   - M3.2 持仓战术仪表盘（R 倍数、ATR 距离、+50% 金字塔加仓合并均价 & 零风险保本止损、入场后动能衰减判定）
 *   - M3.3 反例衰减笔记（按标的替换、强制可验证数字条件、counterexamples 衰减与 3 次淘汰、7天/离池24h自动退休）
 *   - M3.4 原生 function-calling 三段式循环（`plan → update_notes / update_thesis → finalize` 永不空决策 + 接入 AutoTrader）
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import {
  CLOSE_REASON_LABELS,
  unboundedAiManagedConfig,
  type Kline,
  type MarketSnapshot,
  type PositionView,
  type StrategyConfig,
} from '@aq/shared';

import { SymbolRegistry } from '../binance/symbols.js';
import type { BinanceExchangeInfo } from '../binance/types.js';
import { closeDb, getDb, initDb } from '../db/index.js';
import type { ChatMessage, ToolCall } from '../llm/types.js';
import type { MarketPort } from '../market/port.js';
import type { MarketDataService } from '../market/service.js';
import { scoreAi500Symbol, type RadarUniverseRow } from '../radar/ai500.js';
import {
  aiModels,
  decisions as decisionStore,
  positions as positionStore,
  traders,
  trades as tradeStore,
} from '../store/repositories.js';
import { AutoTrader, type DecisionModel } from '../trader/autoTrader.js';
import type { BrokerPort } from '../trader/brokerPort.js';
import { runManagedAgenticLoop } from './engine.js';
import {
  hasVerifiableTrigger,
  managedNotesStore,
  noteEffectiveWeight,
} from './notes.js';
import { managedRadarStore } from './radarStore.js';
import { computePositionTactics, formatPositionTacticsLines } from './tactics.js';
import { evaluateThesisHardCheck, managedThesisStore } from './thesis.js';

let workDir: string;
let modelId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-m3-'));
  initDb(path.join(workDir, 'm3.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  for (const table of [
    'managed_theses',
    'managed_notes',
    'managed_radar_latest',
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
    label: 'm3-model',
    model: 'deepseek-v4.1-flash',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 0,
  }).id;
});

function createPaperTrader(name = 'm3-bot'): ReturnType<typeof traders.create> {
  return traders.create({
    name,
    exchangeAccountId: null,
    aiModelId: modelId,
    strategyId: null,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
    paperStartingBalance: 1000,
    mode: 'ai_managed',
    dryRun: true,
  });
}

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

function makeSeries(
  count: number,
  startPrice: number,
  stepPct: number,
  intervalMs: number,
  quoteVol = 3_000_000,
  takerBuyRatio = 0.62,
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

/* -------------------------------------------------------------------------- */
/*  M3.1: Thesis Hard Check (Pure + 30s Guard Integration)                     */
/* -------------------------------------------------------------------------- */

test('★ M3.1 持仓论点硬检查：触及 MAE 或超时无进展立即平仓；超时但已盈利 ≥ minProgressR 的赢家绝不误杀', () => {
  assert.equal(CLOSE_REASON_LABELS.thesis_time_stop, '论点时间止损');
  assert.equal(CLOSE_REASON_LABELS.thesis_mae_stop, '论点最大偏移止损');

  const baseThesis = {
    symbol: 'SOLUSDT',
    side: 'long' as const,
    entryPrice: 100,
    initialStopLoss: 96, // 1R = 4
    timeStopAt: '2026-11-24T12:00:00.000Z',
    minProgressR: 0.3,
    maxAdverseExcursionPct: 2.5,
    peakR: 0.2,
    worstAdversePct: 0.5,
  };

  // 1) 触及 MAE：跌到 97.4（逆向 2.6% ≥ 2.5%）→ 立即触发 thesis_mae_stop
  const vMae = evaluateThesisHardCheck(baseThesis, {
    markPrice: 97.4,
    nowMs: Date.parse('2026-11-24T10:00:00.000Z'),
  });
  assert.equal(vMae.shouldClose, true);
  assert.equal(vMae.closeReason, 'thesis_mae_stop');
  assert.equal(vMae.nextWorstAdversePct, 2.6);

  // 2) 到时间止损且进展不足（100.4 = +0.10R < 0.3R）→ 触发 thesis_time_stop
  const vTime = evaluateThesisHardCheck(baseThesis, {
    markPrice: 100.4,
    nowMs: Date.parse('2026-11-24T12:01:00.000Z'),
  });
  assert.equal(vTime.shouldClose, true);
  assert.equal(vTime.closeReason, 'thesis_time_stop');

  // 3) 到时间止损但已走出利润（104.8 = +1.20R ≥ 0.3R）→ 放行赢家奔跑！
  const vWinner = evaluateThesisHardCheck(baseThesis, {
    markPrice: 104.8,
    nowMs: Date.parse('2026-11-24T12:05:00.000Z'),
  });
  assert.equal(vWinner.shouldClose, false);
  assert.equal(vWinner.nextPeakR, 1.2);
});

/* -------------------------------------------------------------------------- */
/*  M3.2: Tactics Dashboard (R, ATR, +50% Pyramid Breakeven, Decay)            */
/* -------------------------------------------------------------------------- */

test('★ M3.2 持仓战术面板：准确计算 +50% 金字塔合并均价与零风险保本止损，并在动能衰减时切入锁利减仓提示', () => {
  const pos: PositionView = {
    id: 1,
    traderId: 1,
    symbol: 'SOLUSDT',
    side: 'long',
    quantity: 2,
    entryPrice: 100,
    markPrice: 106, // +1.5R (SL=96 → risk=4, move=+6)
    leverage: 3,
    liquidationPrice: null,
    unrealizedPnl: 12,
    unrealizedPnlPercent: 18,
    peakPnlPercent: 18,
    marginUsed: 66.67,
    notional: 212,
    stopLoss: 96,
    takeProfit: 116,
    openedAt: '2026-11-24T09:00:00.000Z',
    openReasoning: 'breakout',
  };
  const k15 = makeSeries(60, 96, 0.0015, 15 * 60_000, 3_000_000, 0.62);
  const k4h = makeSeries(40, 82, 0.006, 4 * 3600_000, 30_000_000, 0.6);
  const strongRadar = scoreAi500Symbol({
    symbol: 'SOLUSDT',
    price: 106,
    quoteVolume24h: 600_000_000,
    changePercent24h: 7,
    fundingRate: -0.0001,
    klines15m: k15,
    klines4h: k4h,
    openInterestUsd: 220_000_000,
    oiChange1hPct: 3,
    oiChange4hPct: 6,
    btcReturn4hPct: 0.2,
  });

  const thesis = managedThesisStore.upsertActive({
    traderId: createPaperTrader('m3-tactics').id,
    symbol: 'SOLUSDT',
    side: 'long',
    entryPrice: 100,
    initialStopLoss: 96,
    entryBasis: '放量突破',
    addTrigger: '≥1R突破105',
    reduceTarget: '2R减半',
    invalidation: '跌破96',
    entryRadarScore: strongRadar.score - 2,
    entryOiUsd: 200_000_000,
    entryTakerBuyRatio: 0.58,
  });

  const t1 = computePositionTactics({
    position: pos,
    thesis,
    radar: strongRadar,
    atr15m: 1.2,
    roundTripFeeRate: 0.001,
  });
  assert.equal(t1.currentR, 1.5);
  assert.ok(Math.abs(t1.pyramid50.mergedEntryPrice - 102) < 1e-6, '加仓50%合并均价应精确为 (100+0.5*106)/1.5 = 102');
  assert.ok(t1.pyramid50.zeroRiskBreakevenStop > 102.1, '保本止损必须含双边手续费缓冲');
  assert.equal(t1.pyramid50.canZeroRiskPyramid, true, '1.5R + 强劲动能 + 充足 ATR 缓冲应判定可无风险金字塔加仓');
  assert.equal(t1.stage, 'pyramid_ready');

  const lines = formatPositionTacticsLines(t1, thesis);
  assert.match(lines.join('\n'), /★可无风险加仓/);
  assert.match(lines.join('\n'), /\+50%加仓模拟/);

  // 若入场后评分暴跌 -18 分 → 应识别动能衰减并转为锁利减仓阶段
  const fadedThesis = { ...thesis, entryRadarScore: strongRadar.score + 18 };
  const t2 = computePositionTactics({
    position: pos,
    thesis: fadedThesis,
    radar: strongRadar,
    atr15m: 1.2,
  });
  assert.equal(t2.decay.isFading, true);
  assert.equal(t2.pyramid50.canZeroRiskPyramid, false);
  assert.equal(t2.stage, 'scale_out_lock');
});

/* -------------------------------------------------------------------------- */
/*  M3.3: Counterexample-Decaying Notes                                        */
/* -------------------------------------------------------------------------- */

test('★ M3.3 反例衰减笔记：拒绝空话、按标的替换、反例权重衰减至 3 次淘汰、7天及离池 24h 自动退休', () => {
  const trader = createPaperTrader('m3-notes');
  const t0 = Date.UTC(2026, 10, 24, 10, 0, 0);

  // 1) 空泛口号必须拒绝
  assert.equal(hasVerifiableTrigger('谨慎观望等待合适机会'), false);
  const bad = managedNotesStore.upsertNote({
    traderId: trader.id,
    symbol: 'SOLUSDT',
    note: '看起来不错',
    triggerCondition: '等待确认再进场',
    nowMs: t0,
  });
  assert.equal(bad.ok, false);

  // 2) 带数字可验证条件入库，且二次写入按标的替换（不叠加多行）
  const r1 = managedNotesStore.upsertNote({
    traderId: trader.id,
    symbol: 'SOLUSDT',
    note: '首次观察结构',
    triggerCondition: '15m 站稳 152.5 且量比 > 1.8x',
    bias: 'long',
    nowMs: t0,
  });
  assert.equal(r1.ok, true);
  const r2 = managedNotesStore.upsertNote({
    traderId: trader.id,
    symbol: 'SOLUSDT',
    note: '替换后的最新观察',
    triggerCondition: '回踩 POC 149.8 缩量企稳',
    bias: 'long',
    nowMs: t0 + 60_000,
  });
  assert.equal(r2.ok, true);
  const list1 = managedNotesStore.listActive(trader.id, t0 + 120_000);
  assert.equal(list1.length, 1);
  assert.equal(list1[0]!.note, '替换后的最新观察');

  // 3) 反例计数：1 → 权重 0.50；2 → 权重 0.33；3 → 自动退休删除
  assert.equal(noteEffectiveWeight(0), 1);
  assert.equal(noteEffectiveWeight(1), 0.5);
  assert.equal(noteEffectiveWeight(2), 0.33);
  assert.equal(noteEffectiveWeight(3), 0);

  const ce1 = managedNotesStore.recordCounterexample(trader.id, 'SOLUSDT', '假突破回落', t0 + 180_000);
  assert.equal(ce1.retired, false);
  assert.equal(ce1.counterexamples, 1);
  const ce2 = managedNotesStore.recordCounterexample(trader.id, 'SOLUSDT', '二次跌破', t0 + 240_000);
  assert.equal(ce2.retired, false);
  const ce3 = managedNotesStore.recordCounterexample(trader.id, 'SOLUSDT', '三次证伪', t0 + 300_000);
  assert.equal(ce3.retired, true);
  assert.equal(managedNotesStore.listActive(trader.id, t0 + 360_000).length, 0);

  // 4) 标的离池超过 24 小时自动退休
  managedNotesStore.upsertNote({
    traderId: trader.id,
    symbol: 'AVAXUSDT',
    note: '观察空头破位',
    triggerCondition: '跌破 39.2 放量',
    bias: 'short',
    nowMs: t0,
  });
  const pruned = managedNotesStore.syncPoolAndPrune(
    trader.id,
    new Set(['BTCUSDT']), // AVAXUSDT 不在池中
    t0 + 25 * 3600_000,
  );
  assert.equal(pruned.pruned, 1);
  assert.equal(managedNotesStore.listActive(trader.id, t0 + 25 * 3600_000).length, 0);
});

/* -------------------------------------------------------------------------- */
/*  M3.4: Three-Stage Agentic Loop + End-to-End AutoTrader Integration         */
/* -------------------------------------------------------------------------- */

test('★ M3.4 三段式原生 function calling（plan → update_notes/update_thesis → finalize）+ 永不空决策 + 30s MAE 硬平仓闭环', async () => {
  const prevBudget = process.env.AQ_ENFORCE_RISK_BUDGET;
  process.env.AQ_ENFORCE_RISK_BUDGET = 'false';
  try {
    const trader = createPaperTrader('m3-e2e');
    const registry = makeRegistry(['BTCUSDT', 'SOLUSDT', 'AVAXUSDT']);
    const cfg: StrategyConfig = {
      ...unboundedAiManagedConfig(),
      coinSource: {
        ...unboundedAiManagedConfig().coinSource,
        sourceType: 'coinpool',
        minQuoteVolume24h: 30_000_000,
      },
    };

    const universe: RadarUniverseRow[] = [
      { symbol: 'BTCUSDT', price: 68000, quoteVolume24h: 6_000_000_000, changePercent24h: 0.5, high24h: 68500, low24h: 67500, fundingRate: 0.0001 },
      { symbol: 'SOLUSDT', price: 150, quoteVolume24h: 950_000_000, changePercent24h: 8.0, high24h: 153, low24h: 138, fundingRate: -0.0002 },
      { symbol: 'AVAXUSDT', price: 40, quoteVolume24h: 450_000_000, changePercent24h: -6.5, high24h: 44, low24h: 39.5, fundingRate: 0.0003 },
    ];
    const klineMap: Record<string, { '4h': Kline[]; '15m': Kline[]; '1m': Kline[] }> = {
      BTCUSDT: {
        '4h': makeSeries(45, 67500, 0.0001, 4 * 3600_000, 80_000_000, 0.51),
        '15m': makeSeries(96, 67800, 0.00003, 15 * 60_000, 12_000_000, 0.51),
        '1m': makeSeries(30, 67980, 0.00001, 60_000, 800_000, 0.51),
      },
      SOLUSDT: {
        '4h': makeSeries(45, 118, 0.0055, 4 * 3600_000, 35_000_000, 0.62),
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

    const currentMarks: Record<string, number> = { BTCUSDT: 68000, SOLUSDT: 150, AVAXUSDT: 40 };
    const marketData = {
      async getUniverseOverview() { return universe; },
      async getKlines(symbol: string, tf: '4h' | '15m' | '1m', count: number) { return (klineMap[symbol]?.[tf] ?? []).slice(-count); },
      async buildSnapshot(symbol: string) { return klineMap[symbol] ? makeSnap(symbol) : null; },
      async buildSnapshots(list: string[]) { return list.filter((s) => klineMap[s]).map(makeSnap); },
      async screenUniverse() { return ['BTCUSDT', 'SOLUSDT', 'AVAXUSDT']; },
      async getOiRanking() { return []; },
      async fullMarketOverview() { return []; },
      async topRankings() { return undefined; },
      async getFundingRate() { return 0.0001; },
      async markPricesOf() { return new Map(Object.entries(currentMarks)); },
    } as unknown as MarketDataService;

    const market = {
      async openInterest() { return 1_500_000; },
      async openInterestHist() {
        return [{ sumOpenInterest: '1400000' }, { sumOpenInterest: '1450000' }, { sumOpenInterest: '1500000' }];
      },
    } as unknown as MarketPort;

    let seq = 3000;
    const broker = {
      isDryRun: true,
      async ensureOneWayMode() { return { changed: false }; },
      async getAccountState() {
        return { equity: 1000, walletBalance: 1000, availableBalance: 900, unrealizedPnl: 0, marginUsed: 0, openOrderMargin: 0 };
      },
      async getPositions() { return []; },
      async getMarkPrice(symbol: string) { return currentMarks[symbol] ?? 100; },
      async getMaxLeverage() { return 20; },
      async setLeverage(_s: string, l: number) { return { ok: true, leverage: l }; },
      async setMarginType() { return { ok: true }; },
      async placeOrder(req: { symbol: string; type: string; side: string; quantity?: number; price?: number }) {
        seq += 1;
        const mark = currentMarks[req.symbol] ?? 100;
        const isAlgo = req.type === 'STOP_MARKET' || req.type === 'TAKE_PROFIT_MARKET';
        return {
          id: String(seq),
          clientOrderId: `m3-${seq}`,
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
      async getOrder() { return null; },
      async getAlgoOrder() { return null; },
      async getOpenOrders() { return []; },
      async getOpenAlgoOrders() { return []; },
      async cancelOrder() { return true; },
      async cancelAlgoOrder() { return true; },
      async cancelAllOrders() { return 0; },
      async cancelAllAlgoOrders() { return 0; },
      async getUserTrades() { return []; },
      async getIncome() { return []; },
      async waitForFill(symbol: string, orderId: string, initial?: unknown) {
        if (initial && typeof initial === 'object' && 'avgPrice' in initial) return initial;
        return { id: orderId, status: 'FILLED', terminal: true, executedQty: 2, avgPrice: currentMarks[symbol] ?? 150 };
      },
    } as unknown as BrokerPort;

    // 模拟真实原生 function calling 三段式交互：Turn1(plan + update_notes) → Turn2(finalize 开仓 SOLUSDT 并带 thesis 参数)
    let chatTurn = 0;
    const model: DecisionModel = {
      async complete() {
        return { text: '<decision>{"decisions":[]}</decision>', latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1 } };
      },
      async chat(messages: ChatMessage[], options) {
        chatTurn += 1;
        // 若收到执行回执追问（无 tools），直接收尾
        if (!options?.tools || options.tools.length === 0) {
          return {
            text: '<reasoning>已确认成交</reasoning><decision>{"decisions":[]}</decision>',
            latencyMs: 5,
            usage: { promptTokens: 100, completionTokens: 20 },
          };
        }
        if (chatTurn === 1) {
          const calls: ToolCall[] = [
            {
              id: 'c_plan',
              name: 'plan',
              arguments: JSON.stringify({ market_regime: '多空分化，SOL 放量起爆，AVAX 观察空头破位' }),
            },
            {
              id: 'c_note',
              name: 'update_notes',
              arguments: JSON.stringify({
                op: 'upsert',
                symbol: 'AVAXUSDT',
                note: '空头顺势关注跌破前低',
                trigger_condition: '15m 跌破 39.4 且量比 > 1.6x',
                bias: 'short',
                confidence: 76,
              }),
            },
          ];
          return {
            text: '',
            toolCalls: calls,
            latencyMs: 12,
            usage: { promptTokens: 3200, completionTokens: 110, cachedTokens: 800, reasoningTokens: 40 },
          };
        }
        assert.ok(messages.some((m) => m.role === 'tool' && m.toolName === 'update_notes'));
        const calls: ToolCall[] = [
          {
            id: 'c_fin',
            name: 'finalize',
            arguments: JSON.stringify({
              summary: 'SOLUSDT AI500 86分多头放量突破，开多并绑定 6h 时间止损与 2.0% MAE 硬线。',
              decisions: [
                {
                  symbol: 'SOLUSDT',
                  action: 'open_long',
                  leverage: 3,
                  position_size_usd: 300,
                  stop_loss: 142,
                  take_profit: 174,
                  confidence: 85,
                  reasoning: '三周期多头共振+放量突破',
                  add_trigger: '盈利≥1R且突破155放量',
                  reduce_target: '2R/166减半锁利',
                  invalidation: '跌破142前低',
                  time_stop_hours: 6,
                  min_progress_r: 0.4,
                  max_adverse_excursion_pct: 2.0,
                },
              ],
            }),
          },
        ];
        return {
          text: '',
          toolCalls: calls,
          latencyMs: 15,
          usage: { promptTokens: 3500, completionTokens: 180, cachedTokens: 3000, reasoningTokens: 60 },
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

    await at.runOnce();

    // 1) 验证雷达快照、观察笔记、持仓论点全部落库
    const savedRadar = managedRadarStore.get(trader.id);
    assert.ok(savedRadar && savedRadar.items.length >= 2, '最新 AI500 雷达快照必须持久化供前端展示');
    const savedNotes = managedNotesStore.listActive(trader.id);
    assert.equal(savedNotes.length, 1);
    assert.equal(savedNotes[0]!.symbol, 'AVAXUSDT');
    const savedThesis = managedThesisStore.getActive(trader.id, 'SOLUSDT');
    assert.ok(savedThesis, '开仓成交后必须立即绑定结构化持仓论点');
    assert.equal(savedThesis.maxAdverseExcursionPct, 2.0);
    assert.equal(savedThesis.minProgressR, 0.4);
    assert.equal(savedThesis.addTrigger, '盈利≥1R且突破155放量');

    // 2) 验证永不空决策：finalize 只写了 SOLUSDT，但引擎自动为其余展开候选（AVAXUSDT/BTCUSDT）补齐 wait
    const rec = decisionStore.list(trader.id, 1)[0]!;
    assert.ok(rec.decisions.some((d) => d.symbol === 'AVAXUSDT' && d.action === 'wait'));

    // 3) 模拟价格逆向跌破 2.0% MAE 硬线（150 → 146.5 = -2.33%），30s 守卫必须机器自动平仓并记 thesis_mae_stop！
    currentMarks['SOLUSDT'] = 146.5;
    const internals = at as unknown as { running: boolean; runGuardTick: () => Promise<void> };
    internals.running = true;
    await internals.runGuardTick();

    assert.equal(positionStore.open(trader.id).length, 0, '触及 MAE 硬线后 30s 守卫必须自动平仓');
    assert.equal(managedThesisStore.getActive(trader.id, 'SOLUSDT'), null, '平仓后对应论点必须标 closed');
    const closedTrades = tradeStore.list(trader.id);
    assert.equal(closedTrades.length, 1);
    assert.equal(closedTrades[0]!.closeReason, 'thesis_mae_stop');
  } finally {
    if (prevBudget === undefined) delete process.env.AQ_ENFORCE_RISK_BUDGET;
    else process.env.AQ_ENFORCE_RISK_BUDGET = prevBudget;
  }
});

test('★ M3.4 直接单元验证 runManagedAgenticLoop：支持 update_thesis 修改已有持仓论点并补齐遗漏持仓 hold', async () => {
  const trader = createPaperTrader('m3-engine-direct');
  managedThesisStore.upsertActive({
    traderId: trader.id,
    symbol: 'ETHUSDT',
    side: 'long',
    entryPrice: 3000,
    initialStopLoss: 2900,
    maxAdverseExcursionPct: 3.0,
  });

  let turn = 0;
  const res = await runManagedAgenticLoop({
    traderId: trader.id,
    baseMessages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ],
    openPositions: [
      {
        id: 2,
        traderId: trader.id,
        symbol: 'ETHUSDT',
        side: 'long',
        quantity: 0.5,
        entryPrice: 3000,
        markPrice: 3120,
        leverage: 3,
        liquidationPrice: null,
        unrealizedPnl: 60,
        unrealizedPnlPercent: 12,
        peakPnlPercent: 12,
        marginUsed: 500,
        notional: 1560,
        stopLoss: 2900,
        takeProfit: 3300,
        openedAt: '2026-11-24T09:00:00.000Z',
        openReasoning: 'eth breakout',
      },
    ],
    candidateSymbols: ['SOLUSDT'],
    model: {
      async chat() {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [
              {
                id: 't1',
                name: 'update_thesis',
                arguments: JSON.stringify({
                  symbol: 'ETHUSDT',
                  reduce_target: '到达 3250 阻力墙减半锁利',
                  max_adverse_excursion_pct: 1.8,
                }),
              },
            ],
            latencyMs: 5,
            usage: { promptTokens: 500, completionTokens: 50 },
          };
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 't2',
              name: 'finalize',
              arguments: JSON.stringify({
                summary: 'ETH 趋势健康持有，SOL 继续观望',
                decisions: [], // 刻意留空，测试永不空决策兜底
              }),
            },
          ],
          latencyMs: 5,
          usage: { promptTokens: 600, completionTokens: 40 },
        };
      },
    },
  });

  assert.equal(res.usedFinalizeTool, true);
  assert.equal(res.usage.promptTokens, 1100);
  const updated = managedThesisStore.getActive(trader.id, 'ETHUSDT')!;
  assert.equal(updated.maxAdverseExcursionPct, 1.8);
  assert.equal(updated.reduceTarget, '到达 3250 阻力墙减半锁利');
  assert.match(res.text, /"symbol":"ETHUSDT","action":"hold"/);
  assert.match(res.text, /"symbol":"SOLUSDT","action":"wait"/);
});

test('★ 实盘回归（Cycle #51）：进入最终回合时仅暴露 finalize 工具并提示拍板，防止模型在末轮调 plan/notes 导致静默丢单', async () => {
  const trader = createPaperTrader('m3-engine-final-turn-lock');
  const seenToolCounts: number[] = [];
  const seenToolNamesPerTurn: string[][] = [];

  let turn = 0;
  const res = await runManagedAgenticLoop({
    traderId: trader.id,
    maxRounds: 3,
    baseMessages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ],
    openPositions: [],
    candidateSymbols: ['XRPUSDT'],
    model: {
      async chat(_msgs, opts) {
        turn += 1;
        seenToolCounts.push(opts?.tools?.length ?? 0);
        seenToolNamesPerTurn.push((opts?.tools ?? []).map((t) => t.name));
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: 'plan', arguments: JSON.stringify({ market_regime: '偏空' }) }],
            latencyMs: 5,
            usage: { promptTokens: 100, completionTokens: 20 },
          };
        }
        if (turn === 2) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'c2',
                name: 'update_notes',
                arguments: JSON.stringify({
                  op: 'upsert',
                  symbol: 'XRPUSDT',
                  note: '等反抽挂空',
                  trigger_condition: '反抽 0.9165 限价空',
                  bias: 'short',
                  confidence: 70,
                }),
              },
            ],
            latencyMs: 5,
            usage: { promptTokens: 120, completionTokens: 30 },
          };
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 'c3',
              name: 'finalize',
              arguments: JSON.stringify({
                summary: '挂 XRP 空单',
                decisions: [
                  {
                    symbol: 'XRPUSDT',
                    action: 'open_short',
                    entry_type: 'limit',
                    limit_price: 0.9165,
                    leverage: 10,
                    position_size_usd: 80,
                    stop_loss: 0.9228,
                    take_profit: 0.903,
                    confidence: 72,
                    reasoning: '结构反抽空',
                  },
                ],
              }),
            },
          ],
          latencyMs: 5,
          usage: { promptTokens: 150, completionTokens: 40 },
        };
      },
    },
  });

  assert.equal(res.usedFinalizeTool, true);
  assert.deepEqual(seenToolCounts, [5, 5, 1], '前两轮保持完整 5 工具维持缓存，末轮仅暴露 finalize');
  assert.deepEqual(seenToolNamesPerTurn[2], ['finalize']);
  assert.match(res.text, /"symbol":"XRPUSDT","action":"open_short"/);
});

test('★ 路线①②：尾仓（已减仓≥2次或剩余名义过小）进入 runner_hold 禁止继续切碎；顺势加仓给出动态顺延 TP', () => {
  const k15Bear = makeSeries(60, 0.145, -0.0012, 15 * 60_000, 2_000_000, 0.38);
  const k4hBear = makeSeries(40, 0.165, -0.004, 4 * 3600_000, 20_000_000, 0.4);
  const strongRadar = scoreAi500Symbol({
    symbol: 'ADAUSDT',
    price: 0.1376,
    quoteVolume24h: 250_000_000,
    changePercent24h: -6.2,
    fundingRate: 0.0002,
    klines15m: k15Bear,
    klines4h: k4hBear,
    openInterestUsd: 120_000_000,
    oiChange1hPct: 2.5,
    oiChange4hPct: 5.0,
    btcReturn4hPct: -0.5,
  });
  const basePos = {
    id: 10,
    traderId: 1,
    symbol: 'ADAUSDT',
    side: 'short' as const,
    quantity: 666,
    entryPrice: 0.1402,
    markPrice: 0.1376, // +1.73R (initial risk 0.0015)
    leverage: 10,
    liquidationPrice: null,
    unrealizedPnl: 1.73,
    unrealizedPnlPercent: 18.5,
    peakPnlPercent: 20,
    marginUsed: 9.3,
    notional: 93,
    stopLoss: 0.1402,
    takeProfit: 0.1352,
    openedAt: '2026-11-25T12:00:00.000Z',
    openReasoning: 'ada short',
  };
  const thesis = {
    id: 1,
    traderId: 1,
    symbol: 'ADAUSDT',
    side: 'short' as const,
    entryPrice: 0.1402,
    initialStopLoss: 0.1417,
    entryBasis: '空头共振',
    addTrigger: '',
    reduceTarget: '',
    invalidation: '',
    timeStopAt: null,
    minProgressR: 0.3,
    maxAdverseExcursionPct: 1.2,
    peakR: 1.73,
    worstAdversePct: 0.2,
    entryRadarScore: 76,
    entryOiUsd: 100_000_000,
    entryTakerBuyRatio: 0.42,
    status: 'active' as const,
    createdAt: '2026-11-25T12:00:00.000Z',
    updatedAt: '2026-11-25T12:00:00.000Z',
  };

  // 1) 未减过仓且强趋势 +1.73R → 可顺势加仓并给出顺延 TP（低于旧 TP 或外推目标）
  const pyramid = computePositionTactics({
    position: basePos,
    thesis,
    radar: strongRadar,
    atr15m: 0.0008,
    minNotionalUsd: 12,
    partialCloseCount: 0,
  });
  assert.equal(pyramid.stage, 'pyramid_ready');
  assert.equal(pyramid.pyramid50.canZeroRiskPyramid, true);
  assert.ok(pyramid.pyramid50.suggestedExtendedTp < basePos.markPrice);
  assert.match(pyramid.guidance, /顺延拓展/);

  // 2) 已减仓 2 次 → 强制进入 runner_hold，严禁继续碎片化减仓
  const tailByCount = computePositionTactics({
    position: { ...basePos, quantity: 200, notional: 28 },
    thesis,
    radar: strongRadar,
    atr15m: 0.0008,
    minNotionalUsd: 12,
    partialCloseCount: 2,
  });
  assert.equal(tailByCount.isTailRunner, true);
  assert.equal(tailByCount.stage, 'runner_hold');
  assert.match(tailByCount.guidance, /严禁继续碎片化/);

  // 3) 剩余名义 < 2.2 × minNotional（如 $11 < $26.4）→ 即使只减过 1 次也进入 runner_hold
  const tailBySize = computePositionTactics({
    position: { ...basePos, quantity: 80, notional: 11 },
    thesis,
    radar: strongRadar,
    atr15m: 0.0008,
    minNotionalUsd: 12,
    partialCloseCount: 1,
  });
  assert.equal(tailBySize.isTailRunner, true);
  assert.equal(tailBySize.stage, 'runner_hold');
});

test('★ 路线③：runManagedAgenticLoop 拦截已展开标的的重复 get_klines，并将雷达外 K 线查验限流至 maxKlineCalls', async () => {
  const trader = createPaperTrader('m3-engine-klines-cap');
  let fetchedCount = 0;
  let turn = 0;
  const toolReplies: string[] = [];

  const res = await runManagedAgenticLoop({
    traderId: trader.id,
    maxRounds: 4,
    maxKlineCalls: 2,
    expandedSymbols: ['SOLUSDT'],
    baseMessages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ],
    openPositions: [],
    candidateSymbols: ['SOLUSDT'],
    getKlines: async () => {
      fetchedCount += 1;
      return [
        {
          openTime: 1,
          closeTime: 2,
          open: 10,
          high: 11,
          low: 9.5,
          close: 10.5,
          volume: 1000,
          quoteVolume: 10500,
          trades: 10,
          takerBuyBase: 600,
          takerBuyQuote: 6300,
        },
      ];
    },
    model: {
      async chat(msgs) {
        turn += 1;
        for (const m of msgs) {
          if (m.role === 'tool' && typeof m.content === 'string') toolReplies.push(m.content);
        }
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [
              // 1) 已展开标的的 15m → 应被直接拦截不调 getKlines
              { id: 'k1', name: 'get_klines', arguments: JSON.stringify({ symbol: 'SOLUSDT', timeframe: '15m' }) },
              // 2-3) 两个雷达外标的 → 允许执行（耗尽 maxKlineCalls=2）
              { id: 'k2', name: 'get_klines', arguments: JSON.stringify({ symbol: 'DOGEUSDT', timeframe: '15m' }) },
              { id: 'k3', name: 'get_klines', arguments: JSON.stringify({ symbol: 'XRPUSDT', timeframe: '15m' }) },
              // 4) 第 3 次雷达外查验 → 应被限流拦截
              { id: 'k4', name: 'get_klines', arguments: JSON.stringify({ symbol: 'LINKUSDT', timeframe: '15m' }) },
            ],
            latencyMs: 5,
            usage: { promptTokens: 100, completionTokens: 20 },
          };
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 'f1',
              name: 'finalize',
              arguments: JSON.stringify({ summary: '完成', decisions: [] }),
            },
          ],
          latencyMs: 5,
          usage: { promptTokens: 120, completionTokens: 20 },
        };
      },
    },
  });

  assert.equal(res.usedFinalizeTool, true);
  assert.equal(fetchedCount, 2, '已展开标的免拉取 + 超出 maxKlineCalls=2 的请求必须被拦截');
  assert.ok(toolReplies.some((t) => t.includes('已在上方标的档案中完整提供')));
  assert.ok(toolReplies.some((t) => t.includes('已达上限（2 次）')));
});

test('★ runManagedAgenticLoop 多轮调用累加总耗时并对各轮首字延迟 TTFT 取平均值', async () => {
  let round = 0;
  const res = await runManagedAgenticLoop({
    traderId: 21,
    baseMessages: [{ role: 'user', content: 'test' }],
    openPositions: [],
    candidateSymbols: ['BTCUSDT'],
    model: {
      chat: async () => {
        round += 1;
        if (round === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'p1', name: 'plan', arguments: JSON.stringify({ summary: '先规划' }) }],
            latencyMs: 12000,
            ttftMs: 900,
            usage: { promptTokens: 1000, completionTokens: 200, cachedTokens: 500, reasoningTokens: 100 },
          };
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 'f1',
              name: 'finalize',
              arguments: JSON.stringify({
                summary: '完成',
                decisions: [{ symbol: 'BTCUSDT', action: 'wait', confidence: 65, reasoning: '观望' }],
              }),
            },
          ],
          latencyMs: 18500,
          ttftMs: 1500,
          usage: { promptTokens: 1200, completionTokens: 300, cachedTokens: 900, reasoningTokens: 150 },
        };
      },
    },
  });

  assert.equal(res.latencyMs, 30500, '多轮总耗时必须完整累加（12000 + 18500）');
  assert.equal(res.ttftMs, 1200, '多轮首字延迟必须取平均值（(900 + 1500) / 2 = 1200）');
  assert.deepEqual(res.ttftSamples, [900, 1500]);
});

test('★ runManagedAgenticLoop 记录结构化 stageSteps（大盘定调、笔记触发条件、提前复查）', async () => {
  const trader = createPaperTrader('m3-stage-steps');
  let round = 0;
  const res = await runManagedAgenticLoop({
    traderId: trader.id,
    baseMessages: [{ role: 'user', content: 'test' }],
    openPositions: [],
    candidateSymbols: ['ZECUSDT'],
    model: {
      chat: async () => {
        round += 1;
        if (round === 1) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'p1',
                name: 'plan',
                arguments: JSON.stringify({
                  market_regime: 'BTC 窄幅震荡，山寨诱多偏多，维持高观望纪律',
                  focus_candidates: [{ symbol: 'ZECUSDT', view: '假跌破后观察反包确认' }],
                }),
              },
              {
                id: 'n1',
                name: 'update_notes',
                arguments: JSON.stringify({
                  op: 'upsert',
                  symbol: 'ZECUSDT',
                  note: '06:00 放量砸破后被买盘收复，空头失效',
                  trigger_condition: '15m 放量跌破 755 且量比 >= 1.8x 再评估做空',
                  bias: 'short',
                  confidence: 62,
                }),
              },
            ],
            latencyMs: 5000,
            ttftMs: 800,
            usage: { promptTokens: 500, completionTokens: 120, cachedTokens: 200, reasoningTokens: 40 },
          };
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 'f1',
              name: 'finalize',
              arguments: JSON.stringify({
                summary: '大盘横盘，继续观望等待确认。',
                next_check_in_minutes: 6,
                decisions: [{ symbol: 'ZECUSDT', action: 'wait', confidence: 62, reasoning: '观望' }],
              }),
            },
          ],
          latencyMs: 6000,
          ttftMs: 900,
          usage: { promptTokens: 600, completionTokens: 140, cachedTokens: 400, reasoningTokens: 50 },
        };
      },
    },
  });

  assert.equal(res.stageSteps.length, 3);
  assert.equal(res.stageSteps[0]?.kind, 'plan');
  assert.ok(res.stageSteps[0]?.summary?.includes('BTC 窄幅震荡'));
  assert.ok(res.stageSteps[0]?.meta?.some((m) => m.label === '聚焦 ZEC'));

  assert.equal(res.stageSteps[1]?.kind, 'note');
  assert.equal(res.stageSteps[1]?.symbol, 'ZECUSDT');
  assert.ok(res.stageSteps[1]?.meta?.some((m) => m.label === '方向' && m.value === '偏空'));
  assert.ok(res.stageSteps[1]?.meta?.some((m) => m.label === '触发条件' && m.value.includes('755')));

  assert.equal(res.stageSteps[2]?.kind, 'finalize');
  assert.ok(res.stageSteps[2]?.meta?.some((m) => m.label === '下次复查' && m.value === '提前 6 分钟'));
});
