/**
 * M4.3 成交归因反哺 AI500 因子权重与准入红线校准（`packages/server/src/radar/attribution.ts`）
 *
 * 设计目标：
 *   1. 纯函数统计引擎 `computeAi500Attribution()`：将每笔已平仓交易的入场 6 维 AI500 评分与
 *      实际净盈亏 / R 倍数对齐，计算每个子因子的皮尔逊相关系数 `r`、赢单/亏单均值差 `edge`、
 *      高分组 vs 低分组胜率与平均 R，以及各准入档位（`strong` / `watch` / `skip`）的期望表现；
 *   2. 严格防过拟合护栏：
 *      - 最小样本门槛 `MIN_CALIBRATION_SAMPLES = 15`：样本不足时只输出诊断报告，不改权重；
 *      - 样本收缩系数 `min(1, sampleSize / 40)` + 单因子相对基准最大偏移 `±4` + 绝对边界 `[8, 30]`
 *        + 精确归一至总和 `100`；
 *      - 准入红线有界微调：`strongThreshold ∈ [70, 85]`、`watchThreshold ∈ [60, 72]`、
 *        且恒保证 `strongThreshold - watchThreshold ≥ 8`；
 *   3. SQLite 仓库 `managedAttributionStore`：在每笔 `ai_managed` 平仓入账后自动重算并落盘，
 *      下一轮 `runManagedRadarCycle()` 自动读取生效权重与红线。
 */

import { getDb } from '../db/index.js';
import {
  AI500_DEFAULTS,
  DEFAULT_AI500_WEIGHTS,
  type Ai500DimensionScores,
  type Ai500Weights,
  type RadarTier,
} from './ai500.js';

/* -------------------------------------------------------------------------- */
/*  Public Types & Constants                                                   */
/* -------------------------------------------------------------------------- */

export type Ai500FactorKey = keyof Ai500DimensionScores;

export const AI500_FACTOR_KEYS: readonly Ai500FactorKey[] = [
  'trend',
  'breakout',
  'oiFlow',
  'takerFlow',
  'funding',
  'alphaPosition',
] as const;

export const AI500_FACTOR_LABELS: Record<Ai500FactorKey, string> = {
  trend: '多周期趋势',
  breakout: '放量突破',
  oiFlow: 'OI资金流',
  takerFlow: 'Taker净流',
  funding: '费率挤压',
  alphaPosition: 'RS与位置',
};

/** 启用自动权重校准所需的最小已归因成交笔数（防小样本噪声过拟合）。 */
export const MIN_CALIBRATION_SAMPLES = 15;

export interface AttributionSample {
  tradeId: number | null;
  symbol: string;
  side: 'long' | 'short';
  entryScore: number | null;
  entryTier: RadarTier | 'untracked';
  dimensions: Ai500DimensionScores | null;
  netPnl: number;
  realizedR: number;
  closeReason: string | null;
  closedAt: string;
}

export interface DimensionAttribution {
  key: Ai500FactorKey;
  label: string;
  baselineWeight: number;
  recommendedWeight: number;
  deltaWeight: number;
  /** 该因子归一化得分（0–1）与实际 realizedR 的皮尔逊相关系数（[-1, 1]）。 */
  correlationR: number;
  /** 盈利单平均归一化得分（0–100%）。 */
  winMeanPct: number;
  /** 亏损单平均归一化得分（0–100%）。 */
  lossMeanPct: number;
  /** 盈利单与亏损单均值差（百分点）。 */
  edgePct: number;
  /** 高半区样本胜率（0–100%）。 */
  highBucketWinRate: number;
  /** 低半区样本胜率（0–100%）。 */
  lowBucketWinRate: number;
  /** 高半区平均 R 倍数。 */
  highBucketAvgR: number;
  /** 低半区平均 R 倍数。 */
  lowBucketAvgR: number;
}

export interface TierAttribution {
  tier: RadarTier | 'untracked';
  count: number;
  wins: number;
  winRatePct: number;
  avgR: number;
  totalNetPnl: number;
  profitFactor: number | null;
}

export interface Ai500CalibrationReport {
  sampleSize: number;
  minSamplesRequired: number;
  /** 是否已达到样本门槛并将校准权重投入实盘雷达使用。 */
  applied: boolean;
  reason: string;
  weights: Ai500Weights;
  baselineWeights: Ai500Weights;
  strongThreshold: number;
  watchThreshold: number;
  dimensions: DimensionAttribution[];
  tiers: TierAttribution[];
  summaryLine: string;
  updatedAt: string;
}

export interface ActiveRadarCalibration {
  weights: Ai500Weights;
  strongThreshold: number;
  watchThreshold: number;
  applied: boolean;
  sampleSize: number;
}

/* -------------------------------------------------------------------------- */
/*  Math Helpers                                                               */
/* -------------------------------------------------------------------------- */

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const vx = xs[i]! - mx;
    const vy = ys[i]! - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  const denom = Math.sqrt(dx * dy);
  if (denom <= 1e-9) return 0;
  return clamp(num / denom, -1, 1);
}

/**
 * 将一组浮点目标权重在 `[minW, maxW]` 区间内归一为精确求和 100 的整数权重。
 */
function normalizeIntegerWeights(
  raw: Record<Ai500FactorKey, number>,
  minW = 8,
  maxW = 30,
  baseline?: Ai500Weights,
): Ai500Weights {
  const clamped: Record<Ai500FactorKey, number> = {
    trend: clamp(raw.trend, minW, maxW),
    breakout: clamp(raw.breakout, minW, maxW),
    oiFlow: clamp(raw.oiFlow, minW, maxW),
    takerFlow: clamp(raw.takerFlow, minW, maxW),
    funding: clamp(raw.funding, minW, maxW),
    alphaPosition: clamp(raw.alphaPosition, minW, maxW),
  };

  const sumRaw = AI500_FACTOR_KEYS.reduce((s, k) => s + clamped[k], 0);
  const scaled: Record<Ai500FactorKey, number> = { ...clamped };
  if (sumRaw > 0) {
    for (const k of AI500_FACTOR_KEYS) {
      scaled[k] = clamp((clamped[k] / sumRaw) * 100, minW, maxW);
    }
  }

  const rounded: Ai500Weights = {
    trend: Math.round(scaled.trend),
    breakout: Math.round(scaled.breakout),
    oiFlow: Math.round(scaled.oiFlow),
    takerFlow: Math.round(scaled.takerFlow),
    funding: Math.round(scaled.funding),
    alphaPosition: Math.round(scaled.alphaPosition),
  };

  let diff = 100 - AI500_FACTOR_KEYS.reduce((s, k) => s + rounded[k], 0);
  // BUG-8 修复：补余优先分配给与 diff 同向调整的因子（避免把 +1 补余加回被负向调减的弱因子，造成小样本死区）
  const order = [...AI500_FACTOR_KEYS].sort((a, b) => {
    if (baseline) {
      const aDelta = scaled[a] - baseline[a];
      const bDelta = scaled[b] - baseline[b];
      const aAligned = diff > 0 ? aDelta >= 0 : aDelta <= 0;
      const bAligned = diff > 0 ? bDelta >= 0 : bDelta <= 0;
      if (aAligned !== bAligned) return aAligned ? -1 : 1;
    }
    return diff > 0
      ? (scaled[b] - rounded[b]) - (scaled[a] - rounded[a])
      : (scaled[a] - rounded[a]) - (scaled[b] - rounded[b]);
  });
  let guard = 0;
  while (diff !== 0 && guard < 32) {
    let moved = false;
    for (const k of order) {
      if (diff === 0) break;
      if (diff > 0 && rounded[k] < maxW) {
        rounded[k] += 1;
        diff -= 1;
        moved = true;
      } else if (diff < 0 && rounded[k] > minW) {
        rounded[k] -= 1;
        diff += 1;
        moved = true;
      }
    }
    if (!moved) break;
    guard += 1;
  }

  return rounded;
}

/* -------------------------------------------------------------------------- */
/*  Pure Deterministic Attribution & Calibration Engine                        */
/* -------------------------------------------------------------------------- */

export function computeAi500Attribution(
  samples: readonly AttributionSample[],
  options: { nowIso?: string; minSamples?: number } = {},
): Ai500CalibrationReport {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const minSamples = Math.max(5, options.minSamples ?? MIN_CALIBRATION_SAMPLES);
  const baselineWeights: Ai500Weights = { ...DEFAULT_AI500_WEIGHTS };

  const withDims = samples.filter((s) => s.dimensions !== null);
  const sampleSize = withDims.length;
  const applied = sampleSize >= minSamples;

  // 1) 逐因子统计相关性、赢亏均值差与高低分组胜率
  const shrinkage = applied ? clamp(sampleSize / 40, 0.35, 1) : 0;
  const rawTargets: Record<Ai500FactorKey, number> = { ...baselineWeights };
  const dimRows: DimensionAttribution[] = [];

  for (const key of AI500_FACTOR_KEYS) {
    const baseMax = baselineWeights[key];
    const xs: number[] = [];
    const rs: number[] = [];
    const winXs: number[] = [];
    const lossXs: number[] = [];

    for (const s of withDims) {
      const dimVal = s.dimensions![key];
      const norm = clamp(dimVal / Math.max(1, baseMax), 0, 1);
      xs.push(norm);
      // 钳制单笔极端 R 在 [-3, 5] 内，防单笔异常值主导线性相关
      const boundedR = clamp(s.realizedR, -3, 5);
      rs.push(boundedR);
      if (s.netPnl > 0) winXs.push(norm);
      else lossXs.push(norm);
    }

    const corr = round2(pearson(xs, rs));
    const winMeanPct = round1(mean(winXs) * 100);
    const lossMeanPct = round1(mean(lossXs) * 100);
    const edgePct = round1(winMeanPct - lossMeanPct);

    // 按中位数切高/低半区评估胜率与平均 R
    const sorted = [...xs].sort((a, b) => a - b);
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0.5;
    const highSamples = withDims.filter((s) => clamp(s.dimensions![key] / Math.max(1, baseMax), 0, 1) >= median);
    const lowSamples = withDims.filter((s) => clamp(s.dimensions![key] / Math.max(1, baseMax), 0, 1) < median);

    const highWinRate =
      highSamples.length > 0
        ? round1((highSamples.filter((s) => s.netPnl > 0).length / highSamples.length) * 100)
        : 0;
    const lowWinRate =
      lowSamples.length > 0
        ? round1((lowSamples.filter((s) => s.netPnl > 0).length / lowSamples.length) * 100)
        : 0;
    const highAvgR = round2(mean(highSamples.map((s) => s.realizedR)));
    const lowAvgR = round2(mean(lowSamples.map((s) => s.realizedR)));

    // 合成信号强度：相关系数占 70% + 赢亏均值差占 30%，单因子相对基准最多偏移 ±4 分
    const edgeNorm = clamp(edgePct / 30, -1, 1);
    const signal = clamp(corr * 0.7 + edgeNorm * 0.3, -1, 1);
    rawTargets[key] = baseMax + signal * 4 * shrinkage;

    dimRows.push({
      key,
      label: AI500_FACTOR_LABELS[key],
      baselineWeight: baseMax,
      recommendedWeight: baseMax, // 归一后回填
      deltaWeight: 0,
      correlationR: corr,
      winMeanPct,
      lossMeanPct,
      edgePct,
      highBucketWinRate: highWinRate,
      lowBucketWinRate: lowWinRate,
      highBucketAvgR: highAvgR,
      lowBucketAvgR: lowAvgR,
    });
  }

  const finalWeights = applied
    ? normalizeIntegerWeights(rawTargets, 8, 30, baselineWeights)
    : { ...baselineWeights };
  for (const row of dimRows) {
    row.recommendedWeight = finalWeights[row.key];
    row.deltaWeight = finalWeights[row.key] - row.baselineWeight;
  }

  // 2) 按准入档位统计期望，并有界微调 strong / watch 红线
  const tierOrder: Array<RadarTier | 'untracked'> = ['strong', 'watch', 'skip', 'untracked'];
  const tiers: TierAttribution[] = [];
  for (const tier of tierOrder) {
    const bucket = samples.filter((s) => s.entryTier === tier);
    if (bucket.length === 0) continue;
    const wins = bucket.filter((s) => s.netPnl > 0).length;
    const grossWin = bucket.filter((s) => s.netPnl > 0).reduce((s, x) => s + x.netPnl, 0);
    const grossLoss = bucket.filter((s) => s.netPnl <= 0).reduce((s, x) => s + Math.abs(x.netPnl), 0);
    tiers.push({
      tier,
      count: bucket.length,
      wins,
      winRatePct: round1((wins / bucket.length) * 100),
      avgR: round2(mean(bucket.map((s) => s.realizedR))),
      totalNetPnl: round2(bucket.reduce((s, x) => s + x.netPnl, 0)),
      profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : grossWin > 0 ? 99 : null,
    });
  }

  let strongThreshold: number = AI500_DEFAULTS.strongThreshold;
  let watchThreshold: number = AI500_DEFAULTS.watchThreshold;
  if (applied) {
    const strongTier = tiers.find((t) => t.tier === 'strong');
    const watchTier = tiers.find((t) => t.tier === 'watch');
    // 若 watch 档位明显负期望（≥5 笔且 avgR < -0.15），抬高观察门槛防低分假突破
    if (watchTier && watchTier.count >= 5) {
      if (watchTier.avgR < -0.15) watchThreshold = clamp(watchThreshold + 3, 60, 72);
      else if (watchTier.avgR > 0.45 && watchTier.winRatePct >= 55) watchThreshold = clamp(watchThreshold - 2, 60, 72);
    }
    // 若 strong 档位盈利强而 watch 弱，维持或微调强关注红线；若 strong 档位也偏弱则收紧红线
    if (strongTier && strongTier.count >= 5) {
      if (strongTier.avgR < 0) strongThreshold = clamp(strongThreshold + 3, 70, 85);
      else if (strongTier.avgR > 0.6 && strongTier.winRatePct >= 60) strongThreshold = clamp(strongThreshold - 2, 70, 85);
    }
    // 恒保证 strong 与 watch 至少留 8 分梯度
    if (strongThreshold - watchThreshold < 8) {
      strongThreshold = clamp(watchThreshold + 8, 70, 85);
    }
  }

  const sortedByCorr = [...dimRows].sort((a, b) => b.correlationR - a.correlationR);
  const topFactor = sortedByCorr[0];
  const weakFactor = sortedByCorr[sortedByCorr.length - 1];

  const reason = applied
    ? `基于 ${sampleSize} 笔已归因成交完成因子权重与红线校准（强关注 ≥${strongThreshold} / 观察 ≥${watchThreshold}）。`
    : `已归因样本 ${sampleSize}/${minSamples} 笔，暂维持基准权重（20/20/15/15/15/15）防小样本过拟合。`;

  const summaryLine =
    sampleSize >= 3 && topFactor && weakFactor
      ? `${reason} 最强正相关因子：${topFactor.label}(r=${topFactor.correlationR.toFixed(2)})；最弱因子：${weakFactor.label}(r=${weakFactor.correlationR.toFixed(2)})。`
      : reason;

  return {
    sampleSize,
    minSamplesRequired: minSamples,
    applied,
    reason,
    weights: finalWeights,
    baselineWeights,
    strongThreshold,
    watchThreshold,
    dimensions: dimRows,
    tiers,
    summaryLine,
    updatedAt: nowIso,
  };
}

/* -------------------------------------------------------------------------- */
/*  SQLite Repository                                                          */
/* -------------------------------------------------------------------------- */

interface ThesisAttributionRow {
  closed_trade_id: number | null;
  symbol: string;
  side: string;
  entry_radar_score: number | null;
  entry_tier: string | null;
  entry_dimensions_json: string | null;
  realized_net_pnl: number | null;
  realized_r: number | null;
  close_reason: string | null;
  updated_at: string;
}

interface CalibrationDbRow {
  trader_id: number;
  weights_json: string;
  strong_threshold: number;
  watch_threshold: number;
  sample_size: number;
  applied: number;
  report_json: string;
  updated_at: string;
}

function parseDimensions(raw: string | null): Ai500DimensionScores | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<Ai500DimensionScores>;
    if (
      typeof obj.trend === 'number' &&
      typeof obj.breakout === 'number' &&
      typeof obj.oiFlow === 'number' &&
      typeof obj.takerFlow === 'number' &&
      typeof obj.funding === 'number' &&
      typeof obj.alphaPosition === 'number'
    ) {
      return {
        trend: obj.trend,
        breakout: obj.breakout,
        oiFlow: obj.oiFlow,
        takerFlow: obj.takerFlow,
        funding: obj.funding,
        alphaPosition: obj.alphaPosition,
      };
    }
  } catch {
    /* ignore malformed legacy json */
  }
  return null;
}

function parseTier(raw: string | null, score: number | null): RadarTier | 'untracked' {
  if (raw === 'strong' || raw === 'watch' || raw === 'skip') return raw;
  if (score !== null && Number.isFinite(score)) {
    if (score >= AI500_DEFAULTS.strongThreshold) return 'strong';
    if (score >= AI500_DEFAULTS.watchThreshold) return 'watch';
    return 'skip';
  }
  return 'untracked';
}

export const managedAttributionStore = {
  /** 从 `managed_theses` 汇总已平仓成交归因，重算并持久化 AI500 因子校准结果。 */
  recompute(traderId: number, nowMs = Date.now()): Ai500CalibrationReport {
    const db = getDb();
    const rows = db.all<ThesisAttributionRow>(
      `SELECT closed_trade_id, symbol, side, entry_radar_score, entry_tier,
              entry_dimensions_json, realized_net_pnl, realized_r, close_reason, updated_at
       FROM managed_theses
       WHERE trader_id = ? AND status = 'closed' AND realized_net_pnl IS NOT NULL
       ORDER BY id DESC
       LIMIT 200`,
      traderId,
    );

    const samples: AttributionSample[] = rows.map((r) => ({
      tradeId: r.closed_trade_id,
      symbol: r.symbol,
      side: r.side === 'short' ? 'short' : 'long',
      entryScore: r.entry_radar_score,
      entryTier: parseTier(r.entry_tier, r.entry_radar_score),
      dimensions: parseDimensions(r.entry_dimensions_json),
      netPnl: r.realized_net_pnl ?? 0,
      realizedR: r.realized_r ?? 0,
      closeReason: r.close_reason,
      closedAt: r.updated_at,
    }));

    const report = computeAi500Attribution(samples, { nowIso: new Date(nowMs).toISOString() });

    db.run(
      `INSERT INTO managed_radar_calibration (
         trader_id, weights_json, strong_threshold, watch_threshold,
         sample_size, applied, report_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trader_id) DO UPDATE SET
         weights_json = excluded.weights_json,
         strong_threshold = excluded.strong_threshold,
         watch_threshold = excluded.watch_threshold,
         sample_size = excluded.sample_size,
         applied = excluded.applied,
         report_json = excluded.report_json,
         updated_at = excluded.updated_at`,
      traderId,
      JSON.stringify(report.weights),
      report.strongThreshold,
      report.watchThreshold,
      report.sampleSize,
      report.applied ? 1 : 0,
      JSON.stringify(report),
      report.updatedAt,
    );

    return report;
  },

  /** 读取已落盘的校准报告；若无记录则实时基于现有数据计算返回（只读不强写）。 */
  get(traderId: number): Ai500CalibrationReport {
    const db = getDb();
    const row = db.get<CalibrationDbRow>(
      `SELECT * FROM managed_radar_calibration WHERE trader_id = ?`,
      traderId,
    );
    if (row) {
      try {
        return JSON.parse(row.report_json) as Ai500CalibrationReport;
      } catch {
        /* fall through to recompute */
      }
    }
    const rows = db.all<ThesisAttributionRow>(
      `SELECT closed_trade_id, symbol, side, entry_radar_score, entry_tier,
              entry_dimensions_json, realized_net_pnl, realized_r, close_reason, updated_at
       FROM managed_theses
       WHERE trader_id = ? AND status = 'closed' AND realized_net_pnl IS NOT NULL
       ORDER BY id DESC
       LIMIT 200`,
      traderId,
    );
    const samples: AttributionSample[] = rows.map((r) => ({
      tradeId: r.closed_trade_id,
      symbol: r.symbol,
      side: r.side === 'short' ? 'short' : 'long',
      entryScore: r.entry_radar_score,
      entryTier: parseTier(r.entry_tier, r.entry_radar_score),
      dimensions: parseDimensions(r.entry_dimensions_json),
      netPnl: r.realized_net_pnl ?? 0,
      realizedR: r.realized_r ?? 0,
      closeReason: r.close_reason,
      closedAt: r.updated_at,
    }));
    return computeAi500Attribution(samples);
  },

  /** 供 `runManagedRadarCycle` 读取当前生效权重与准入红线。 */
  getActiveOptions(traderId: number): ActiveRadarCalibration {
    const db = getDb();
    const row = db.get<CalibrationDbRow>(
      `SELECT * FROM managed_radar_calibration WHERE trader_id = ?`,
      traderId,
    );
    if (!row || row.applied !== 1) {
      return {
        weights: { ...DEFAULT_AI500_WEIGHTS },
        strongThreshold: AI500_DEFAULTS.strongThreshold,
        watchThreshold: AI500_DEFAULTS.watchThreshold,
        applied: false,
        sampleSize: row?.sample_size ?? 0,
      };
    }
    try {
      const parsed = JSON.parse(row.weights_json) as Partial<Ai500Weights>;
      const weights: Ai500Weights = {
        trend: typeof parsed.trend === 'number' ? parsed.trend : DEFAULT_AI500_WEIGHTS.trend,
        breakout: typeof parsed.breakout === 'number' ? parsed.breakout : DEFAULT_AI500_WEIGHTS.breakout,
        oiFlow: typeof parsed.oiFlow === 'number' ? parsed.oiFlow : DEFAULT_AI500_WEIGHTS.oiFlow,
        takerFlow: typeof parsed.takerFlow === 'number' ? parsed.takerFlow : DEFAULT_AI500_WEIGHTS.takerFlow,
        funding: typeof parsed.funding === 'number' ? parsed.funding : DEFAULT_AI500_WEIGHTS.funding,
        alphaPosition:
          typeof parsed.alphaPosition === 'number'
            ? parsed.alphaPosition
            : DEFAULT_AI500_WEIGHTS.alphaPosition,
      };
      return {
        weights,
        strongThreshold: row.strong_threshold,
        watchThreshold: row.watch_threshold,
        applied: true,
        sampleSize: row.sample_size,
      };
    } catch {
      return {
        weights: { ...DEFAULT_AI500_WEIGHTS },
        strongThreshold: AI500_DEFAULTS.strongThreshold,
        watchThreshold: AI500_DEFAULTS.watchThreshold,
        applied: false,
        sampleSize: row.sample_size,
      };
    }
  },
};
