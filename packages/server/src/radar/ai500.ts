/**
 * AI500 六维量化多因子选币雷达（`packages/server/src/radar/ai500.ts`）
 *
 * 目标：在全市场数百个 USDT 永续合约中，通过纯确定性量化模型筛选出最具短期起爆潜力的
 * Top 3–5 标的（原生支持多空双向顺势），剔除低流动垃圾币与已过度拉伸的追高陷阱，
 * 把真正高信噪比的候选交给 `ai_managed` 2.0 大脑决策。
 *
 * 六维评分体系（满分 100，严格无前视偏差）：
 *   1. 多周期趋势共振（20 分）：4h + 1h（可由 15m 聚合）+ 15m EMA 排列与斜率一致度
 *   2. 放量真突破 & K 线实体饱满度（20 分）：量比放大 + 区间突破/蓄势 + 过滤长影线插针
 *   3. 合约资金流共振（15 分）：价格方向与 OI 增仓同向确认，区分真资金进场与空心拉盘
 *   4. Taker 主动买卖盘净流 & CVD（15 分）：直接利用 K 线 `takerBuyQuote`/`quoteVolume` 计算主动流向与加速度
 *   5. 资金费率挤压与拥挤度（15 分）：奖励轧空/轧多燃料，惩罚极端拥挤单边追仓
 *   6. 相对 BTC 超额强弱（RS Alpha）+ 启动位置性价比（15 分）：奖励强势领涨/领跌龙头，严惩偏离 EMA20 > 2.5×ATR 追高
 */

import { isStableBaseAsset, type Kline } from '@aq/shared';

import { atr, ema, last } from '../market/indicators.js';

/* -------------------------------------------------------------------------- */
/*  Public types                                                               */
/* -------------------------------------------------------------------------- */

export type RadarBias = 'long' | 'short' | 'neutral';

export type RadarTier = 'strong' | 'watch' | 'skip';

export interface RadarUniverseRow {
  symbol: string;
  price: number;
  quoteVolume24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  fundingRate: number | null;
  openInterestUsd?: number | null;
}

export interface RadarLiquidityOptions {
  /** 24h 成交额硬下限（USDT，默认 30,000,000）。 */
  minQuoteVolume24h?: number;
  /** 持仓量硬下限（USDT，默认 5,000,000；若未提供 OI 则不因缺失误杀）。 */
  minOpenInterestUsd?: number;
  /** 是否排除稳定币（默认 true）。 */
  excludeStablecoins?: boolean;
  /** 永远豁免保留的标的（例如当前持仓与 BTC 基准）。 */
  alwaysInclude?: ReadonlySet<string>;
}

export interface Ai500ScoreInput {
  symbol: string;
  price: number;
  quoteVolume24h: number;
  changePercent24h: number;
  fundingRate: number | null;
  /** 已收盘 15m K 线（建议 60–96 根，用于 15m 形态、Taker 流与聚合 1h 趋势）。 */
  klines15m: readonly Kline[];
  /** 已收盘 4h K 线（建议 30–60 根，用于大趋势背景）。 */
  klines4h: readonly Kline[];
  /** 可选已收盘 1h K 线；缺省时自动由 `klines15m` 每 4 根聚合。 */
  klines1h?: readonly Kline[];
  /** 可选当前合约持仓量（USDT）。 */
  openInterestUsd?: number | null;
  /** 可选 1h / 4h OI 变化百分比（如 +4.5 表示增仓 4.5%）。 */
  oiChange1hPct?: number | null;
  oiChange4hPct?: number | null;
  /** 市场基准 BTC 同窗口涨跌幅（%），用于计算相对强弱 RS Alpha。 */
  btcReturn1hPct?: number | null;
  btcReturn4hPct?: number | null;
}

export interface Ai500DimensionScores {
  /** 1. 多周期趋势共振（0–20） */
  trend: number;
  /** 2. 放量真突破 & 实体饱满度（0–20） */
  breakout: number;
  /** 3. 合约资金流 OI 共振（0–15） */
  oiFlow: number;
  /** 4. Taker 主动买卖盘净流 & CVD（0–15） */
  takerFlow: number;
  /** 5. 资金费率挤压与拥挤度（0–15） */
  funding: number;
  /** 6. RS Alpha + 启动位置性价比（0–15） */
  alphaPosition: number;
}

/** M4.3 六维因子权重配置（默认总和 = 100）。 */
export type Ai500Weights = Ai500DimensionScores;

export const DEFAULT_AI500_WEIGHTS: Readonly<Ai500Weights> = {
  trend: 20,
  breakout: 20,
  oiFlow: 15,
  takerFlow: 15,
  funding: 15,
  alphaPosition: 15,
} as const;

export interface Ai500Metrics {
  price: number;
  quoteVolume24h: number;
  change1hPct: number;
  change4hPct: number;
  change24hPct: number;
  rsAlpha1hPct?: number | null;
  rsAlpha4hPct: number | null;
  volRatio15m: number;
  bodyRatio15m: number;
  atr15mPct: number;
  distEma20Atr: number;
  takerBuyRatio1h: number;
  takerBuyRatio4h: number;
  cvdTrend: 'rising' | 'falling' | 'flat';
  openInterestUsd: number | null;
  oiChange1hPct: number | null;
  oiChange4hPct: number | null;
  fundingRatePct: number | null;
}

export interface Ai500Candidate {
  symbol: string;
  /** 综合评分（0–100 整数） */
  score: number;
  /** 准入分级：strong（≥75）/ watch（65–74）/ skip（<65） */
  tier: RadarTier;
  /** 主导顺势方向（原生支持多空双向） */
  bias: RadarBias;
  dimensions: Ai500DimensionScores;
  metrics: Ai500Metrics;
  /** 简明结构化触发/警示标签 */
  tags: string[];
}

export interface Ai500RankOptions {
  /** 最终保留 Top N（默认 5，建议 3–5）。 */
  topN?: number;
  /** 强关注准入红线（默认 75）。 */
  strongThreshold?: number;
  /** 观察准入红线（默认 65）。 */
  watchThreshold?: number;
}

export const AI500_DEFAULTS = {
  minQuoteVolume24h: 30_000_000,
  minOpenInterestUsd: 5_000_000,
  strongThreshold: 75,
  watchThreshold: 65,
  topN: 5,
  prescreenLimit: 30,
} as const;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 从 K 线尾部计算 N 根跨度的收盘价涨跌幅（%）。 */
export function computeReturnPct(klines: readonly Kline[], barsBack: number): number {
  if (klines.length < 2 || barsBack < 1) return 0;
  const end = klines[klines.length - 1]!.close;
  const startIdx = Math.max(0, klines.length - 1 - barsBack);
  const start = klines[startIdx]!.close;
  if (!Number.isFinite(end) || !Number.isFinite(start) || start <= 0) return 0;
  return ((end - start) / start) * 100;
}

/** 将 15m 已收盘 K 线每 4 根聚合成 1h K 线（免额外 API 权重，严格按时间对齐）。 */
export function aggregate15mTo1h(klines15m: readonly Kline[]): Kline[] {
  if (klines15m.length < 4) return [];
  const out: Kline[] = [];
  // 从末尾反推完整 4 根分组，确保最后一根 1h 与最新 15m 结束时间对齐
  const rem = klines15m.length % 4;
  for (let i = rem; i + 3 < klines15m.length; i += 4) {
    const a = klines15m[i]!;
    const b = klines15m[i + 1]!;
    const c = klines15m[i + 2]!;
    const d = klines15m[i + 3]!;
    out.push({
      openTime: a.openTime,
      closeTime: d.closeTime,
      open: a.open,
      high: Math.max(a.high, b.high, c.high, d.high),
      low: Math.min(a.low, b.low, c.low, d.low),
      close: d.close,
      volume: a.volume + b.volume + c.volume + d.volume,
      quoteVolume: a.quoteVolume + b.quoteVolume + c.quoteVolume + d.quoteVolume,
      trades: a.trades + b.trades + c.trades + d.trades,
      takerBuyBase: a.takerBuyBase + b.takerBuyBase + c.takerBuyBase + d.takerBuyBase,
      takerBuyQuote: a.takerBuyQuote + b.takerBuyQuote + c.takerBuyQuote + d.takerBuyQuote,
    });
  }
  return out;
}

/** 计算单个周期的趋势方向分（-1 空头共振 … +1 多头共振）。 */
function timeframeTrendSignal(klines: readonly Kline[]): number {
  if (klines.length < 10) return 0;
  const closes = klines.map((k) => k.close);
  const price = closes[closes.length - 1]!;
  const fastPeriod = Math.min(9, Math.max(3, Math.floor(closes.length / 3)));
  const midPeriod = Math.min(20, Math.max(5, Math.floor(closes.length / 2)));
  const slowPeriod = Math.min(50, closes.length);

  const emaFast = ema(closes, fastPeriod);
  const emaMid = ema(closes, midPeriod);
  const emaSlow = ema(closes, slowPeriod);

  const f = last(emaFast);
  const m = last(emaMid);
  const s = last(emaSlow);
  const mPrevIdx = Math.max(0, emaMid.length - 4);
  const mPrev = emaMid[mPrevIdx] ?? m;

  let vote = 0;
  if (f !== null && m !== null) {
    if (price > f && f > m) vote += 0.45;
    else if (price < f && f < m) vote -= 0.45;
    else if (price > m) vote += 0.15;
    else if (price < m) vote -= 0.15;
  }
  if (m !== null && s !== null) {
    if (m > s) vote += 0.3;
    else if (m < s) vote -= 0.3;
  }
  if (m !== null && mPrev !== null && mPrev > 0) {
    const slopePct = ((m - mPrev) / mPrev) * 100;
    if (slopePct > 0.12) vote += 0.25;
    else if (slopePct < -0.12) vote -= 0.25;
  }
  return clamp(vote, -1, 1);
}

/** 计算一段 K 线的 Taker 主动买入占比（0–1），无数据时中性返回 0.5。 */
function takerBuyRatioOf(slice: readonly Kline[]): number {
  let buy = 0;
  let total = 0;
  for (const k of slice) {
    if (k.quoteVolume > 0 && Number.isFinite(k.takerBuyQuote)) {
      buy += clamp(k.takerBuyQuote, 0, k.quoteVolume);
      total += k.quoteVolume;
    } else if (k.volume > 0 && Number.isFinite(k.takerBuyBase)) {
      buy += clamp(k.takerBuyBase, 0, k.volume);
      total += k.volume;
    }
  }
  return total > 0 ? buy / total : 0.5;
}

/** 从最近若干根 15m K 线判断主动净买盘 CVD 走势。 */
function detectCvdTrend(klines15m: readonly Kline[]): 'rising' | 'falling' | 'flat' {
  const window = klines15m.slice(-16);
  if (window.length < 6) return 'flat';
  const half = Math.floor(window.length / 2);
  const firstHalf = takerBuyRatioOf(window.slice(0, half));
  const secondHalf = takerBuyRatioOf(window.slice(half));
  const recentDelta = secondHalf - firstHalf;
  if (secondHalf >= 0.53 && recentDelta >= 0.015) return 'rising';
  if (secondHalf <= 0.47 && recentDelta <= -0.015) return 'falling';
  if (secondHalf >= 0.56) return 'rising';
  if (secondHalf <= 0.44) return 'falling';
  return 'flat';
}

/* -------------------------------------------------------------------------- */
/*  1. Liquidity filter & pre-screen                                           */
/* -------------------------------------------------------------------------- */

/**
 * 流动性硬过滤：剔除稳定币、异常价格、低成交额及低持仓量垃圾币。
 * `alwaysInclude`（例如当前持仓与 BTC 基准）会豁免过滤以防管理盲区。
 */
export function filterRadarUniverse(
  rows: readonly RadarUniverseRow[],
  options: RadarLiquidityOptions = {},
): RadarUniverseRow[] {
  const minVol = options.minQuoteVolume24h ?? AI500_DEFAULTS.minQuoteVolume24h;
  const minOi = options.minOpenInterestUsd ?? AI500_DEFAULTS.minOpenInterestUsd;
  const excludeStables = options.excludeStablecoins ?? true;
  const always = options.alwaysInclude ?? new Set<string>();

  return rows.filter((row) => {
    if (!Number.isFinite(row.price) || row.price <= 0) return false;
    if (always.has(row.symbol)) return true;
    if (excludeStables && isStableBaseAsset(row.symbol)) return false;
    if (!Number.isFinite(row.quoteVolume24h) || row.quoteVolume24h < minVol) return false;
    if (
      row.openInterestUsd !== undefined &&
      row.openInterestUsd !== null &&
      Number.isFinite(row.openInterestUsd) &&
      row.openInterestUsd < minOi
    ) {
      return false;
    }
    return true;
  });
}

/**
 * 从全市场过滤后的标的中，选出最多 `limit` 个高活跃候选进入深度 K 线打分阶段。
 *
 * 组合策略（抓早不抓晚，避免单一涨幅榜追高）：
 *   - 永远优先保留 `alwaysInclude`（当前持仓 + BTCUSDT）
 *   - 早期突破前沿队列（`byEarlyBreakout`）：24h 温和涨跌 2.5%–28%、价格贴近 24h 极值边缘（≥80% / ≤20%）、尚未拉爆
 *   - 成交额头部（流动性核心）
 *   - 24h 温和-强势涨跌榜（排除 >45% 极端末期暴涨/暴跌币）
 *   - 非透支波动率 / 资金费率异动标的（排除 |24h|>55% 或振幅 >65% 的末期妖币霸榜）
 */
export function selectPrescreenSymbols(
  rows: readonly RadarUniverseRow[],
  options: {
    limit?: number;
    alwaysInclude?: ReadonlySet<string>;
    /** 来自全市场零 REST WS 脉冲雷达的突发点火提名（按脉冲强度降序，仅接受已过流动性过滤且非透支的标的）。 */
    pulseSymbols?: readonly string[];
  } = {},
): string[] {
  const limit = Math.max(1, options.limit ?? AI500_DEFAULTS.prescreenLimit);
  const always = options.alwaysInclude ?? new Set<string>();
  const picked = new Set<string>();

  const add = (sym: string): void => {
    if (picked.size < limit) picked.add(sym);
  };

  // 1) 必选标的（持仓、观察名单、BTC 基准）
  for (const sym of always) {
    if (rows.some((r) => r.symbol === sym)) picked.add(sym);
  }

  const ampPctOf = (r: RadarUniverseRow): number =>
    r.low24h > 0 ? ((r.high24h - r.low24h) / r.low24h) * 100 : 0;

  const isBlowoffRow = (r: RadarUniverseRow): boolean =>
    Math.abs(r.changePercent24h) > 55 || ampPctOf(r) > 65;

  const rangePos24h = (r: RadarUniverseRow): number => {
    const span = r.high24h - r.low24h;
    if (!Number.isFinite(span) || span <= 0) return 0.5;
    return clamp((r.price - r.low24h) / span, 0, 1);
  };

  // 2) 多维轮询取头：WS 突发脉冲提名（若在线）+ 早期突破前沿排在最前，确保刚点火的暗马第一时间进深扫
  const rowBySymbol = new Map(rows.map((r) => [r.symbol, r]));
  const byPulse: RadarUniverseRow[] = [];
  if (options.pulseSymbols && options.pulseSymbols.length > 0) {
    for (const sym of options.pulseSymbols) {
      const row = rowBySymbol.get(sym);
      if (row && !isBlowoffRow(row)) {
        byPulse.push(row);
      }
    }
  }

  const byEarlyBreakout = [...rows]
    .filter((r) => {
      if (isBlowoffRow(r)) return false;
      const absChg = Math.abs(r.changePercent24h);
      const amp = ampPctOf(r);
      if (absChg < 2.5 || absChg > 28 || amp < 4 || amp > 38) return false;
      const pos = rangePos24h(r);
      return (r.changePercent24h > 0 && pos >= 0.8) || (r.changePercent24h < 0 && pos <= 0.2);
    })
    .sort((a, b) => {
      const scoreOf = (r: RadarUniverseRow): number => {
        const pos = rangePos24h(r);
        const extremity = r.changePercent24h > 0 ? pos : 1 - pos;
        const volWeight = Math.log10(Math.max(r.quoteVolume24h, 1_000_000));
        const momWeight = 1 + Math.min(Math.abs(r.changePercent24h), 18) / 25;
        return extremity * volWeight * momWeight;
      };
      return scoreOf(b) - scoreOf(a);
    });

  const byVolume = [...rows].sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
  const byGainers = [...rows]
    .filter((r) => r.changePercent24h > 0 && r.changePercent24h <= 45)
    .sort((a, b) => b.changePercent24h - a.changePercent24h);
  const byLosers = [...rows]
    .filter((r) => r.changePercent24h < 0 && r.changePercent24h >= -45)
    .sort((a, b) => a.changePercent24h - b.changePercent24h);
  const byAmplitude = [...rows]
    .filter((r) => !isBlowoffRow(r))
    .sort((a, b) => ampPctOf(b) - ampPctOf(a));
  const byFunding = [...rows]
    .filter((r) => !isBlowoffRow(r) && r.fundingRate !== null && Number.isFinite(r.fundingRate))
    .sort((a, b) => Math.abs(b.fundingRate ?? 0) - Math.abs(a.fundingRate ?? 0));

  const queues = [byPulse, byEarlyBreakout, byVolume, byGainers, byLosers, byAmplitude, byFunding];
  let cursor = 0;
  while (picked.size < limit) {
    let addedInPass = false;
    for (const q of queues) {
      const item = q[cursor];
      if (item) {
        add(item.symbol);
        addedInPass = true;
      }
      if (picked.size >= limit) break;
    }
    if (!addedInPass) break;
    cursor += 1;
  }

  return [...picked];
}

/* -------------------------------------------------------------------------- */
/*  2. Core 6-Factor AI500 Scoring Engine (Pure)                               */
/* -------------------------------------------------------------------------- */

/**
 * 对单个标的执行 6 维 AI500 量化评分（0–100，多空双向对称）。
 * 纯函数、零 I/O、零随机性，可直接离线回测与单元测试。
 */
export function scoreAi500Symbol(
  input: Ai500ScoreInput,
  thresholds: {
    strongThreshold?: number;
    watchThreshold?: number;
    weights?: Partial<Ai500Weights>;
  } = {},
): Ai500Candidate {
  const strongThreshold = thresholds.strongThreshold ?? AI500_DEFAULTS.strongThreshold;
  const watchThreshold = thresholds.watchThreshold ?? AI500_DEFAULTS.watchThreshold;
  const weights: Ai500Weights = {
    trend: thresholds.weights?.trend ?? DEFAULT_AI500_WEIGHTS.trend,
    breakout: thresholds.weights?.breakout ?? DEFAULT_AI500_WEIGHTS.breakout,
    oiFlow: thresholds.weights?.oiFlow ?? DEFAULT_AI500_WEIGHTS.oiFlow,
    takerFlow: thresholds.weights?.takerFlow ?? DEFAULT_AI500_WEIGHTS.takerFlow,
    funding: thresholds.weights?.funding ?? DEFAULT_AI500_WEIGHTS.funding,
    alphaPosition: thresholds.weights?.alphaPosition ?? DEFAULT_AI500_WEIGHTS.alphaPosition,
  };
  const weightSum =
    weights.trend +
    weights.breakout +
    weights.oiFlow +
    weights.takerFlow +
    weights.funding +
    weights.alphaPosition;
  const useCustomWeights =
    weightSum > 0 &&
    (weights.trend !== DEFAULT_AI500_WEIGHTS.trend ||
      weights.breakout !== DEFAULT_AI500_WEIGHTS.breakout ||
      weights.oiFlow !== DEFAULT_AI500_WEIGHTS.oiFlow ||
      weights.takerFlow !== DEFAULT_AI500_WEIGHTS.takerFlow ||
      weights.funding !== DEFAULT_AI500_WEIGHTS.funding ||
      weights.alphaPosition !== DEFAULT_AI500_WEIGHTS.alphaPosition);

  const k15 = input.klines15m;
  const k4h = input.klines4h;
  const k1h = input.klines1h && input.klines1h.length >= 10 ? input.klines1h : aggregate15mTo1h(k15);

  const last15 = k15[k15.length - 1];
  const price =
    Number.isFinite(input.price) && input.price > 0
      ? input.price
      : (last15?.close ?? k4h[k4h.length - 1]?.close ?? 0);

  const change1hPct = computeReturnPct(k15, 4);
  const change4hPct = k15.length >= 17 ? computeReturnPct(k15, 16) : computeReturnPct(k4h, 1);

  // --- 确定主导顺势方向（多空对称）---
  const sig4h = timeframeTrendSignal(k4h);
  const sig1h = timeframeTrendSignal(k1h);
  const sig15m = timeframeTrendSignal(k15);
  const compositeDir = sig4h * 0.45 + sig1h * 0.3 + sig15m * 0.25;

  let bias: RadarBias = 'neutral';
  if (compositeDir >= 0.18) bias = 'long';
  else if (compositeDir <= -0.18) bias = 'short';
  else if (Math.abs(change4hPct) >= 1.2) bias = change4hPct > 0 ? 'long' : 'short';

  const dir = bias === 'long' ? 1 : bias === 'short' ? -1 : 0;
  const tags: string[] = [];

  /* ── 维度 1：多周期趋势共振（0–20） ───────────────────────────────────── */
  let trendScore = 0;
  if (dir !== 0) {
    const a4h = Math.max(0, sig4h * dir);
    const a1h = Math.max(0, sig1h * dir);
    const a15 = Math.max(0, sig15m * dir);
    // 权重：4h 45% + 1h 30% + 15m 25%
    trendScore = (a4h * 0.45 + a1h * 0.3 + a15 * 0.25) * 20;
    // 若 4h 明显逆势（与主导方向相反），扣分防逆势摸顶抄底
    if (sig4h * dir < -0.3) trendScore = Math.max(0, trendScore - 5);
    if (a4h >= 0.55 && a1h >= 0.5 && a15 >= 0.45) {
      tags.push(dir > 0 ? '三周期多头共振' : '三周期空头共振');
    }
  }
  trendScore = clamp(round1(trendScore), 0, 20);

  /* ── 公共波动与均线基线（供维度 2 与维度 6 共享，避免重复计算） ────────── */
  const closes15 = k15.map((k) => k.close);
  const ema20Series = ema(closes15, Math.min(20, Math.max(5, closes15.length)));
  const ema20Now = last(ema20Series) ?? price;
  const atrSeries = atr([...k15], Math.min(14, Math.max(3, k15.length - 1)));
  const atrNow = last(atrSeries) ?? price * 0.01;
  // 用前一根收盘时的常规 ATR 兜底比较，防止单根暴力插针把自身 ATR 拉大从而掩盖追高偏离
  const atrPrev = atrSeries.length >= 2 ? (atrSeries[atrSeries.length - 2] ?? atrNow) : atrNow;
  const baselineAtr = Math.min(atrNow, atrPrev > 0 ? atrPrev : atrNow);
  const atr15mPct = price > 0 ? (atrNow / price) * 100 : 1;
  const distEma20Atr = baselineAtr > 0 ? Math.abs(price - ema20Now) / baselineAtr : 0;

  /* ── 维度 2：放量真突破 & K 线实体饱满度（0–20） ─────────────────────── */
  let volRatio15m = 1;
  let bodyRatio15m = 0.5;
  let breakoutScore = 0;
  let badRejection = false;
  let distributionDump = false;

  if (k15.length >= 6 && last15) {
    const baseWindow = k15.slice(-21, -1);
    const avgVol =
      baseWindow.length > 0
        ? baseWindow.reduce((s, k) => s + k.quoteVolume, 0) / baseWindow.length
        : last15.quoteVolume;
    const recent2Avg =
      k15.length >= 2 ? (k15[k15.length - 1]!.quoteVolume + k15[k15.length - 2]!.quoteVolume) / 2 : last15.quoteVolume;
    volRatio15m = avgVol > 0 ? Math.max(last15.quoteVolume, recent2Avg) / avgVol : 1;

    // 最近 2 根合体或最新 1 根实体饱满度
    const range = Math.max(last15.high - last15.low, 1e-12);
    const rawBody = Math.abs(last15.close - last15.open) / range;
    const candleDir = last15.close >= last15.open ? 1 : -1;
    bodyRatio15m = rawBody;

    // 区间位置 / 突破判断（相对前 20 根高低点）
    const priorHigh = baseWindow.length > 0 ? Math.max(...baseWindow.map((k) => k.high)) : last15.high;
    const priorLow = baseWindow.length > 0 ? Math.min(...baseWindow.map((k) => k.low)) : last15.low;
    const priorSpan = Math.max(priorHigh - priorLow, price * 0.005);

    const brokeDir =
      dir > 0
        ? price >= priorHigh * 0.998 || (priorHigh - price) / priorSpan <= 0.15
        : dir < 0
          ? price <= priorLow * 1.002 || (price - priorLow) / priorSpan <= 0.15
          : false;

    const strongBreak =
      dir > 0 ? price > priorHigh * 1.0005 : dir < 0 ? price < priorLow * 0.9995 : false;

    // 逆向插针惩罚：多头出现超长上影（>55% 振幅）或空头出现超长下影
    const upperWickRatio = (last15.high - Math.max(last15.open, last15.close)) / range;
    const lowerWickRatio = (Math.min(last15.open, last15.close) - last15.low) / range;
    badRejection = (dir > 0 && upperWickRatio > 0.55) || (dir < 0 && lowerWickRatio > 0.55);

    // 近期放量反砸/派发检测：最近 3 根 15m 出现放量逆向大实体砸盘/拉盘，且现价距 3 根极值已回吐 ≥1.2×ATR
    if (dir !== 0 && k15.length >= 8 && baselineAtr > 0) {
      const recent3 = k15.slice(-3);
      const recent3Extreme =
        dir > 0 ? Math.max(...recent3.map((k) => k.high)) : Math.min(...recent3.map((k) => k.low));
      const pullOff = dir > 0 ? recent3Extreme - price : price - recent3Extreme;
      const hasHeavyCounterBar = recent3.some((bar) => {
        const bRange = Math.max(bar.high - bar.low, 1e-12);
        const bBody = Math.abs(bar.close - bar.open);
        const bBodyRatio = bBody / bRange;
        const bDir = bar.close >= bar.open ? 1 : -1;
        const bVolRatio = avgVol > 0 ? bar.quoteVolume / avgVol : 1;
        const reclaimed = dir > 0 ? price > bar.open : price < bar.open;
        return (
          bDir === -dir &&
          bVolRatio >= 1.6 &&
          bBodyRatio >= 0.55 &&
          bBody >= baselineAtr * 0.85 &&
          !reclaimed
        );
      });
      distributionDump = hasHeavyCounterBar && pullOff >= baselineAtr * 1.2;
    }

    // 突破后黄金缩量回踩确认（前一根放量实体真突破 + 当前根缩量窄幅回踩守住突破位，防误杀最佳二次上车点）
    let goldenRetest = false;
    if (dir !== 0 && k15.length >= 8 && !badRejection && !distributionDump) {
      const prev15 = k15[k15.length - 2]!;
      const prevBase = k15.slice(-22, -2);
      if (prevBase.length >= 5) {
        const prevPriorHigh = Math.max(...prevBase.map((k) => k.high));
        const prevPriorLow = Math.min(...prevBase.map((k) => k.low));
        const prevRange = Math.max(prev15.high - prev15.low, 1e-12);
        const prevBodyLen = Math.abs(prev15.close - prev15.open);
        const prevBodyRatio = prevBodyLen / prevRange;
        const prevDir = prev15.close >= prev15.open ? 1 : -1;
        const prevVolRatio = avgVol > 0 ? prev15.quoteVolume / avgVol : 1;
        const prevBroke =
          dir > 0 ? prev15.close > prevPriorHigh * 1.0002 : prev15.close < prevPriorLow * 0.9998;
        const retestPullback = candleDir !== dir || rawBody < 0.45;
        const retestLowVol = last15.quoteVolume <= prev15.quoteVolume * 0.78;
        const retestHolding =
          dir > 0
            ? last15.close >= prevPriorHigh * 0.997 &&
              last15.close >= prev15.open + prevBodyLen * 0.4
            : last15.close <= prevPriorLow * 1.003 &&
              last15.close <= prev15.open - prevBodyLen * 0.4;
        const retestTight =
          Math.abs(last15.close - last15.open) <= Math.max(prevBodyLen * 0.55, baselineAtr * 0.9);
        goldenRetest =
          prevBroke &&
          prevDir === dir &&
          prevVolRatio >= 1.7 &&
          prevBodyRatio >= 0.52 &&
          retestPullback &&
          retestLowVol &&
          retestHolding &&
          retestTight;
      }
    }

    // 放量分（0–8）
    const volPts =
      volRatio15m >= 2.2 ? 8 : volRatio15m >= 1.5 ? 6 : volRatio15m >= 1.15 ? 4 : volRatio15m >= 0.85 ? 2 : 0.5;
    // 突破/临界分（0–6）
    const levelPts = strongBreak ? 6 : goldenRetest ? 5.5 : brokeDir ? 4.5 : 1.5;
    // 实体饱满分（0–6）：同向饱满加分，黄金缩量回踩保分，长逆向影线/插针严扣
    let bodyPts = 0;
    if (dir !== 0 && candleDir === dir) {
      bodyPts = rawBody >= 0.65 ? 6 : rawBody >= 0.45 ? 4.5 : rawBody >= 0.25 ? 2.5 : 0.5;
    } else if (goldenRetest) {
      bodyPts = 4.5; // 前一根放量突破后的健康缩量回踩
    } else if (rawBody < 0.25) {
      bodyPts = 1; // 十字星犹豫
    } else {
      bodyPts = 1.5; // 普通逆向回调线
    }
    if (goldenRetest) {
      bodyPts = Math.max(bodyPts, 4.5);
    }

    // 低波蓄势箱体 → 首根放量扩张突破（抓主升/主跌第一根起爆点）
    const priorAvgRange =
      baseWindow.length > 0
        ? baseWindow.reduce((s, k) => s + Math.max(k.high - k.low, 0), 0) / baseWindow.length
        : range;
    const priorBoxPct = price > 0 ? (priorSpan / price) * 100 : 99;
    const squeezeExpansion =
      dir !== 0 &&
      !badRejection &&
      !distributionDump &&
      baseWindow.length >= 12 &&
      strongBreak &&
      candleDir === dir &&
      volRatio15m >= 1.6 &&
      rawBody >= 0.55 &&
      atr15mPct >= 0.3 &&
      atr15mPct <= 3.0 &&
      priorAvgRange > 0 &&
      range >= priorAvgRange * 1.45 &&
      priorBoxPct <= Math.max(atr15mPct * 5.0, 4.5);

    breakoutScore = volPts + levelPts + bodyPts;
    if (squeezeExpansion) {
      breakoutScore += 2.5;
      tags.push('蓄势放量突破');
    } else if (goldenRetest) {
      tags.push('突破回踩确认');
    }

    if (distributionDump) {
      breakoutScore = Math.max(0, breakoutScore - 5);
      tags.push('放量反砸警惕');
    }
    if (badRejection) {
      breakoutScore = Math.max(0, breakoutScore - 6);
      tags.push(dir > 0 ? '长上影插针警惕' : '长下影插针警惕');
    } else if (!distributionDump && !squeezeExpansion && !goldenRetest && volRatio15m >= 1.5 && brokeDir && rawBody >= 0.5) {
      tags.push(`放量实体突破(${volRatio15m.toFixed(1)}x)`);
    } else if (volRatio15m < 0.7 && strongBreak) {
      breakoutScore = Math.max(0, breakoutScore - 4);
      tags.push('缩量假突破警惕');
    }
  }
  breakoutScore = clamp(round1(breakoutScore), 0, 20);

  /* ── 维度 3：合约资金流 OI 共振（0–15） ────────────────────────────────── */
  const oiUsd = input.openInterestUsd ?? null;
  const oiCh1h = input.oiChange1hPct ?? null;
  const oiCh4h = input.oiChange4hPct ?? null;
  let oiFlowScore = 7.5; // 无 OI 数据时保持中性，不畸变

  if (oiCh1h !== null || oiCh4h !== null) {
    const ch1 = oiCh1h ?? 0;
    const ch4 = oiCh4h ?? ch1;
    const alignedMove = dir !== 0 && (change4hPct * dir > 0.3 || change1hPct * dir > 0.2);

    if (alignedMove) {
      // 真资金同向增仓：价格顺向走 + OI 同步扩张
      if (ch1 >= 2.5 || ch4 >= 5) {
        oiFlowScore = 15;
        tags.push(`OI增仓共振(${(ch4 >= ch1 ? ch4 : ch1) >= 0 ? '+' : ''}${(ch4 >= ch1 ? ch4 : ch1).toFixed(1)}%)`);
      } else if (ch1 >= 1.0 || ch4 >= 2.0) {
        oiFlowScore = 12;
        tags.push(`OI温和增仓(+${Math.max(ch1, ch4).toFixed(1)}%)`);
      } else if (ch1 >= 0 && ch4 >= -0.5) {
        oiFlowScore = 8.5;
      } else {
        // 价格动了但 OI 明显下降 → 空头回补/多头止损引发的空心波动
        oiFlowScore = ch4 <= -3 ? 2.5 : 4.5;
        tags.push('OI背离(空心波动)');
      }
    } else {
      // 蓄势阶段：价格未起爆但 OI 悄悄堆高
      oiFlowScore = ch4 >= 3 ? 11 : ch4 >= 1 ? 8.5 : 6;
    }

    // 极低 OI/成交额健康度微调
    if (oiUsd !== null && input.quoteVolume24h > 0 && oiUsd < AI500_DEFAULTS.minOpenInterestUsd) {
      oiFlowScore = Math.max(0, oiFlowScore - 3);
    }
  }
  oiFlowScore = clamp(round1(oiFlowScore), 0, 15);

  /* ── 维度 4：Taker 主动买卖盘净流 & CVD（0–15） ───────────────────────── */
  const takerBuyRatio1h = takerBuyRatioOf(k15.slice(-4));
  const takerBuyRatio4h = takerBuyRatioOf(k15.slice(-16));
  const cvdTrend = detectCvdTrend(k15);
  let takerFlowScore = 7.5;

  if (dir !== 0 && k15.length >= 4) {
    // 统一成「顺向主动占比」：多头看买入占比，空头看卖出占比（1 - buyRatio）
    const fav1h = dir > 0 ? takerBuyRatio1h : 1 - takerBuyRatio1h;
    const fav4h = dir > 0 ? takerBuyRatio4h : 1 - takerBuyRatio4h;
    const weighted = fav1h * 0.6 + fav4h * 0.4;

    if (weighted >= 0.59) takerFlowScore = 13.5;
    else if (weighted >= 0.55) takerFlowScore = 11.5;
    else if (weighted >= 0.52) takerFlowScore = 9.5;
    else if (weighted >= 0.48) takerFlowScore = 6.5;
    else takerFlowScore = 2.5; // 主动流向与趋势相反（出货/吸筹背离）

    const cvdAligned = (dir > 0 && cvdTrend === 'rising') || (dir < 0 && cvdTrend === 'falling');
    const cvdOpposite = (dir > 0 && cvdTrend === 'falling') || (dir < 0 && cvdTrend === 'rising');
    if (cvdAligned) takerFlowScore += 1.5;
    else if (cvdOpposite) takerFlowScore -= 2.5;

    if (weighted >= 0.55) {
      tags.push(dir > 0 ? `Taker净买${Math.round(fav1h * 100)}%` : `Taker净卖${Math.round(fav1h * 100)}%`);
    } else if (weighted < 0.46) {
      tags.push('主动买卖背离');
    }
  }
  takerFlowScore = clamp(round1(takerFlowScore), 0, 15);

  /* ── 维度 5：资金费率挤压与拥挤度（0–15） ────────────────────────────── */
  const frPct = input.fundingRate !== null && Number.isFinite(input.fundingRate) ? input.fundingRate * 100 : null;
  let fundingScore = 8; // 无费率时中性

  if (frPct !== null && dir !== 0) {
    if (dir > 0) {
      // 多头：负费率 = 轧空燃料（最优）；轻微正费率 = 正常；极端正费率 = 多头过挤风险
      if (frPct <= -0.02) {
        fundingScore = 15;
        tags.push(`负费率轧空(${frPct.toFixed(3)}%)`);
      } else if (frPct < 0) {
        fundingScore = 13;
      } else if (frPct <= 0.015) {
        fundingScore = 10.5;
      } else if (frPct <= 0.035) {
        fundingScore = 7;
      } else {
        fundingScore = 2;
        tags.push(`多头拥挤(费率+${frPct.toFixed(3)}%)`);
      }
    } else {
      // 空头：偏高正费率 = 挤多燃料（最优）；轻微负费率 = 正常；极端负费率 = 轧空风险
      if (frPct >= 0.025) {
        fundingScore = 15;
        tags.push(`高正费率挤多(+${frPct.toFixed(3)}%)`);
      } else if (frPct > 0.005) {
        fundingScore = 12;
      } else if (frPct >= -0.015) {
        fundingScore = 10;
      } else if (frPct >= -0.035) {
        fundingScore = 6.5;
      } else {
        fundingScore = 2;
        tags.push(`空头拥挤(费率${frPct.toFixed(3)}%)`);
      }
    }
  }
  fundingScore = clamp(round1(fundingScore), 0, 15);

  /* ── 维度 6：相对 BTC 超额强弱（RS Alpha 1h+4h）+ 启动位置性价比（0–15） ─ */
  const rsAlpha1hPct =
    input.btcReturn1hPct !== undefined && input.btcReturn1hPct !== null && Number.isFinite(input.btcReturn1hPct)
      ? round1(change1hPct - input.btcReturn1hPct)
      : null;
  const rsAlpha4hPct =
    input.btcReturn4hPct !== undefined && input.btcReturn4hPct !== null && Number.isFinite(input.btcReturn4hPct)
      ? round1(change4hPct - input.btcReturn4hPct)
      : null;

  // 子项 6a：RS Alpha（0–8），融合 1h 突发领涨/领跌（×1.15 灵敏度）与 4h 持续强弱，第一时间发现刚起势龙头
  let rsPts = 4;
  if ((rsAlpha4hPct !== null || rsAlpha1hPct !== null) && dir !== 0) {
    const alpha4h = rsAlpha4hPct !== null ? rsAlpha4hPct * dir : null;
    const alpha1h = rsAlpha1hPct !== null ? rsAlpha1hPct * dir : null;
    const effectiveAlpha =
      alpha4h !== null && alpha1h !== null
        ? Math.max(alpha4h, alpha1h * 1.15)
        : alpha4h !== null
          ? alpha4h
          : alpha1h! * 1.15;

    if (effectiveAlpha >= 3.0) {
      rsPts = 8;
    } else if (effectiveAlpha >= 1.2) {
      rsPts = 6.5;
    } else if (effectiveAlpha >= 0) {
      rsPts = 4.5;
    } else if (effectiveAlpha >= -1.5) {
      rsPts = 2.5;
    } else {
      rsPts = 1;
    }

    if (alpha1h !== null && alpha1h >= 2.2 && (alpha4h === null || alpha1h * 1.15 >= alpha4h)) {
      tags.push(`1h强势${dir > 0 ? '领涨' : '领跌'}(${rsAlpha1hPct! >= 0 ? '+' : ''}${rsAlpha1hPct!.toFixed(1)}%)`);
    } else if (alpha4h !== null && alpha4h >= 3.0) {
      tags.push(`跑${dir > 0 ? '赢' : '输'}BTC(${rsAlpha4hPct! >= 0 ? '+' : ''}${rsAlpha4hPct!.toFixed(1)}%)`);
    }
  }

  // 子项 6b：启动位置性价比（0–7），严惩 >2.5×ATR 追高/追空
  const movedAlongDir = dir !== 0 ? (price - ema20Now) * dir > 0 : false;
  let posPts = 4;
  if (movedAlongDir) {
    if (distEma20Atr >= 0.25 && distEma20Atr <= 1.6) {
      posPts = 7; // 刚起爆或回踩均线起跳的黄金甜点
    } else if (distEma20Atr < 0.25) {
      posPts = 5.5;
    } else if (distEma20Atr <= 2.5) {
      posPts = 3.5;
    } else {
      // 严惩追高/追空
      posPts = 0;
      tags.push(`追单风险(${distEma20Atr.toFixed(1)}×ATR)`);
    }
  } else {
    // 回调靠近均线下方但未破大结构，中等位置分
    posPts = distEma20Atr <= 1.5 ? 5 : 2;
  }

  let alphaPositionScore = rsPts + posPts;
  /*
   * 实盘校准（2026-11-26 AI500 2.0 抓早不抓晚）：
   *   1) 早期放量起爆加权（+3）：ATR 尚未拉爆（0.45%–3.2%）、24h 涨幅未透支（≤45%）、
   *      无插针/无放量反砸、刚离均线（0.25–1.6×ATR）放量实体起爆时抢先浮出榜单；
   *   2) 末期高波动 / 日内透支阶梯降权（最高 -16）：
   *      · ATR15m > 4.5% 且 |24h| > 35% → -10 分（如 MANTRA +96%/ATR 5.5%、BIGTIME +60%/ATR 5.8%）
   *      · 否则 ATR15m > 5.0% → -6 分
   *      · |24h| > 60% 额外 -6 分（日内透支警示），彻底让末期巨震妖币让位给早期真突破龙头。
   */
  const abs24h = Math.abs(input.changePercent24h);
  const earlyIgnition =
    dir !== 0 &&
    movedAlongDir &&
    !badRejection &&
    !distributionDump &&
    abs24h <= 45 &&
    volRatio15m >= 1.8 &&
    bodyRatio15m >= 0.5 &&
    distEma20Atr >= 0.25 &&
    distEma20Atr <= 1.6 &&
    atr15mPct >= 0.45 &&
    atr15mPct <= 3.2;
  if (earlyIgnition) {
    breakoutScore = clamp(round1(breakoutScore + 3), 0, 20);
    // 置顶于正向标签前列，避免被 orderedTags.slice(0, 6) 截断
    tags.unshift('早期放量起爆');
  }

  let lateBlowoffPenalty = 0;
  if (atr15mPct > 4.5 && abs24h > 35) {
    lateBlowoffPenalty += 10;
    tags.push(`高波动警示(ATR ${atr15mPct.toFixed(1)}%)`);
  } else if (atr15mPct > 5.0) {
    lateBlowoffPenalty += 6;
    tags.push(`高波动警示(ATR ${atr15mPct.toFixed(1)}%)`);
  }
  if (abs24h > 60) {
    lateBlowoffPenalty += 6;
    tags.push(`日内透支警示(${input.changePercent24h >= 0 ? '+' : ''}${round1(input.changePercent24h)}%)`);
  }
  lateBlowoffPenalty = Math.min(16, lateBlowoffPenalty);

  // 极端追高（>3.2×ATR）进一步扣除总分，防止高分误导模型追在尖顶
  const overextendedPenalty = movedAlongDir && distEma20Atr > 3.2 ? 8 : 0;
  const totalPenalty = overextendedPenalty + lateBlowoffPenalty;
  alphaPositionScore = clamp(round1(alphaPositionScore), 0, 15);

  const rawTotal = useCustomWeights
    ? ((trendScore / DEFAULT_AI500_WEIGHTS.trend) * weights.trend +
        (breakoutScore / DEFAULT_AI500_WEIGHTS.breakout) * weights.breakout +
        (oiFlowScore / DEFAULT_AI500_WEIGHTS.oiFlow) * weights.oiFlow +
        (takerFlowScore / DEFAULT_AI500_WEIGHTS.takerFlow) * weights.takerFlow +
        (fundingScore / DEFAULT_AI500_WEIGHTS.funding) * weights.funding +
        (alphaPositionScore / DEFAULT_AI500_WEIGHTS.alphaPosition) * weights.alphaPosition) *
        (100 / weightSum) -
      totalPenalty
    : trendScore +
      breakoutScore +
      oiFlowScore +
      takerFlowScore +
      fundingScore +
      alphaPositionScore -
      totalPenalty;

  const score = Math.round(clamp(rawTotal, 0, 100));
  const tier: RadarTier =
    score >= strongThreshold ? 'strong' : score >= watchThreshold ? 'watch' : 'skip';

  // 风险警示标签排在前面，确保追单/插针/反砸/高波动警示/OI背离/拥挤警示绝不会被截断
  const isWarning = (t: string): boolean => /风险|警惕|警示|背离|拥挤/.test(t);
  const orderedTags = [...tags.filter(isWarning), ...tags.filter((t) => !isWarning(t))].slice(0, 6);

  return {
    symbol: input.symbol,
    score,
    tier,
    bias,
    dimensions: {
      trend: trendScore,
      breakout: breakoutScore,
      oiFlow: oiFlowScore,
      takerFlow: takerFlowScore,
      funding: fundingScore,
      alphaPosition: alphaPositionScore,
    },
    metrics: {
      price,
      quoteVolume24h: input.quoteVolume24h,
      change1hPct: round1(change1hPct),
      change4hPct: round1(change4hPct),
      change24hPct: round1(input.changePercent24h),
      rsAlpha1hPct,
      rsAlpha4hPct,
      volRatio15m: round1(volRatio15m),
      bodyRatio15m: Math.round(bodyRatio15m * 100) / 100,
      atr15mPct: Math.round(atr15mPct * 100) / 100,
      distEma20Atr: round1(distEma20Atr),
      takerBuyRatio1h: Math.round(takerBuyRatio1h * 1000) / 1000,
      takerBuyRatio4h: Math.round(takerBuyRatio4h * 1000) / 1000,
      cvdTrend,
      openInterestUsd: oiUsd,
      oiChange1hPct: oiCh1h !== null ? round1(oiCh1h) : null,
      oiChange4hPct: oiCh4h !== null ? round1(oiCh4h) : null,
      fundingRatePct: frPct !== null ? Math.round(frPct * 10000) / 10000 : null,
    },
    tags: orderedTags,
  };
}

/* -------------------------------------------------------------------------- */
/*  3. Ranking & Top-N Selection                                               */
/* -------------------------------------------------------------------------- */

export interface Ai500RankResult {
  /** 全量排序结果（分值降序） */
  ranked: Ai500Candidate[];
  /** 最终入选 Top N（默认 3–5 个），用于展开三周期 K 线 */
  topCandidates: Ai500Candidate[];
  /** 强关注标的数（score >= strongThreshold） */
  strongCount: number;
  /** 观察标的数（watchThreshold <= score < strongThreshold） */
  watchCount: number;
}

/**
 * 按 AI500 综合分降序排列，选出 Top N（默认 5）候选并统计各档位分布。
 */
export function rankAi500Candidates(
  candidates: readonly Ai500Candidate[],
  options: Ai500RankOptions = {},
): Ai500RankResult {
  const topN = Math.max(1, options.topN ?? AI500_DEFAULTS.topN);
  const strongThreshold = options.strongThreshold ?? AI500_DEFAULTS.strongThreshold;
  const watchThreshold = options.watchThreshold ?? AI500_DEFAULTS.watchThreshold;

  const ranked = [...candidates]
    .map((c) => ({
      ...c,
      tier: (c.score >= strongThreshold ? 'strong' : c.score >= watchThreshold ? 'watch' : 'skip') as RadarTier,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.metrics.quoteVolume24h - a.metrics.quoteVolume24h;
    });

  const strongCount = ranked.filter((c) => c.tier === 'strong').length;
  const watchCount = ranked.filter((c) => c.tier === 'watch').length;

  return {
    ranked,
    topCandidates: ranked.slice(0, topN),
    strongCount,
    watchCount,
  };
}
