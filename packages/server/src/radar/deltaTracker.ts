/**
 * 15 分钟环比增量追踪器（`packages/server/src/radar/deltaTracker.ts`）
 *
 * 按机器人 + 标的缓存上一轮雷达与筹码快照，本轮自动计算环比增量 Δ：
 *   - `AI500 Δ`（综合评分在加速抬升还是退潮？）
 *   - `OI Δ%`（合约资金是在继续涌入还是撤退？）
 *   - `Taker 净流 Δ`（主动买入占比百分点变化 `pp`）
 *   - `POC 偏移 Δ`（现价相对筹码密集区在拉开还是回落？）
 *   - `现价 Δ%`
 *
 * 超过 `maxAgeMs`（默认 90 分钟）的旧快照自动失效，不输出失真的陈旧增量。
 */

import type { RadarBias } from './ai500.js';

/* -------------------------------------------------------------------------- */
/*  Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface RadarSnapshotPoint {
  symbol: string;
  timestampMs: number;
  score: number;
  bias: RadarBias;
  price: number;
  openInterestUsd: number | null;
  /** 1h Taker 主动买入占比（0–1） */
  takerBuyRatio1h: number;
  /** POC 相对现价的 % 偏移（可为 null） */
  pocOffsetPct: number | null;
}

export type DeltaMomentumState = 'initial' | 'accelerating' | 'steady' | 'fading' | 'reversing';

export interface RadarDelta {
  symbol: string;
  /** 距上次观测的分钟数（首次观测为 null）。 */
  elapsedMinutes: number | null;
  /** AI500 评分变化（正=走强，负=退潮）。 */
  scoreDelta: number | null;
  /** 现价变化百分比（%）。 */
  priceDeltaPct: number | null;
  /** OI（USDT）环比变化百分比（%）。 */
  oiDeltaPct: number | null;
  /** Taker 主动买盘占比变化（百分点 pp，如 +4.5 表示从 52% → 56.5%）。 */
  takerBuyDeltaPp: number | null;
  /** POC 偏移变化（百分点 pp）。 */
  pocOffsetDeltaPp: number | null;
  /** 方向是否反转（例如上轮 long 本轮 short）。 */
  biasChanged: boolean;
  /** 综合动能状态结论 */
  state: DeltaMomentumState;
}

/* -------------------------------------------------------------------------- */
/*  Pure Diff                                                                  */
/* -------------------------------------------------------------------------- */

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 纯函数计算两轮观测快照之间的增量 Δ。
 */
export function computeRadarDelta(
  prev: RadarSnapshotPoint | null,
  curr: RadarSnapshotPoint,
  maxAgeMs = 90 * 60_000,
): RadarDelta {
  if (!prev || curr.timestampMs <= prev.timestampMs || curr.timestampMs - prev.timestampMs > maxAgeMs) {
    return {
      symbol: curr.symbol,
      elapsedMinutes: null,
      scoreDelta: null,
      priceDeltaPct: null,
      oiDeltaPct: null,
      takerBuyDeltaPp: null,
      pocOffsetDeltaPp: null,
      biasChanged: false,
      state: 'initial',
    };
  }

  const elapsedMinutes = Math.max(1, Math.round((curr.timestampMs - prev.timestampMs) / 60_000));
  const scoreDelta = Math.round(curr.score - prev.score);
  const priceDeltaPct =
    prev.price > 0 && Number.isFinite(curr.price)
      ? round2(((curr.price - prev.price) / prev.price) * 100)
      : null;

  const oiDeltaPct =
    prev.openInterestUsd !== null &&
    curr.openInterestUsd !== null &&
    prev.openInterestUsd > 0 &&
    Number.isFinite(curr.openInterestUsd)
      ? round2(((curr.openInterestUsd - prev.openInterestUsd) / prev.openInterestUsd) * 100)
      : null;

  const takerBuyDeltaPp =
    Number.isFinite(prev.takerBuyRatio1h) && Number.isFinite(curr.takerBuyRatio1h)
      ? round1((curr.takerBuyRatio1h - prev.takerBuyRatio1h) * 100)
      : null;

  const pocOffsetDeltaPp =
    prev.pocOffsetPct !== null &&
    curr.pocOffsetPct !== null &&
    Number.isFinite(prev.pocOffsetPct) &&
    Number.isFinite(curr.pocOffsetPct)
      ? round2(curr.pocOffsetPct - prev.pocOffsetPct)
      : null;

  const biasChanged = prev.bias !== 'neutral' && curr.bias !== 'neutral' && prev.bias !== curr.bias;

  let state: DeltaMomentumState = 'steady';
  if (biasChanged) {
    state = 'reversing';
  } else if (scoreDelta >= 5 || (scoreDelta >= 2 && (oiDeltaPct ?? 0) >= 1.5)) {
    state = 'accelerating';
  } else if (scoreDelta <= -5 || (scoreDelta <= -2 && (oiDeltaPct ?? 0) <= -1.5)) {
    state = 'fading';
  }

  return {
    symbol: curr.symbol,
    elapsedMinutes,
    scoreDelta,
    priceDeltaPct,
    oiDeltaPct,
    takerBuyDeltaPp,
    pocOffsetDeltaPp,
    biasChanged,
    state,
  };
}

/**
 * 将环比增量格式化为简洁单行提示词摘要。
 */
export function formatRadarDeltaLine(delta: RadarDelta): string {
  if (delta.state === 'initial' || delta.elapsedMinutes === null) {
    return '15mΔ: 首轮观测（下轮起输出环比增量）';
  }

  const stateCn: Record<DeltaMomentumState, string> = {
    initial: '首轮',
    accelerating: '加速',
    steady: '平稳',
    fading: '退潮',
    reversing: '方向反转',
  };

  const parts: string[] = [];
  if (delta.scoreDelta !== null) {
    parts.push(`AI500 ${delta.scoreDelta >= 0 ? '+' : ''}${delta.scoreDelta}(${stateCn[delta.state]})`);
  }
  if (delta.priceDeltaPct !== null) {
    parts.push(`价 ${delta.priceDeltaPct >= 0 ? '+' : ''}${delta.priceDeltaPct.toFixed(2)}%`);
  }
  if (delta.oiDeltaPct !== null) {
    parts.push(`OI ${delta.oiDeltaPct >= 0 ? '+' : ''}${delta.oiDeltaPct.toFixed(2)}%`);
  }
  if (delta.takerBuyDeltaPp !== null) {
    parts.push(`Taker买比 ${delta.takerBuyDeltaPp >= 0 ? '+' : ''}${delta.takerBuyDeltaPp.toFixed(1)}pp`);
  }
  if (delta.pocOffsetDeltaPp !== null) {
    parts.push(`POC偏移 ${delta.pocOffsetDeltaPp >= 0 ? '+' : ''}${delta.pocOffsetDeltaPp.toFixed(2)}pp`);
  }

  return `环比Δ(${delta.elapsedMinutes}m前): ${parts.join(' · ')}`;
}

/* -------------------------------------------------------------------------- */
/*  Stateful Per-Trader Tracker                                                */
/* -------------------------------------------------------------------------- */

/**
 * 内存增量追踪器（每个机器人实例独立维护，避免跨机器人串台）。
 */
export class RadarDeltaTracker {
  private readonly lastBySymbol = new Map<string, RadarSnapshotPoint>();

  constructor(private readonly maxAgeMs = 90 * 60_000) {}

  /**
   * 写入本轮快照并返回与上一轮的环比增量 Δ；顺带清理超时陈旧键防止内存增长。
   */
  observe(point: RadarSnapshotPoint): RadarDelta {
    const prev = this.lastBySymbol.get(point.symbol) ?? null;
    const delta = computeRadarDelta(prev, point, this.maxAgeMs);
    this.lastBySymbol.set(point.symbol, point);
    this.prune(point.timestampMs);
    return delta;
  }

  /** 只读查询上次快照（主要用于测试与调试）。 */
  peek(symbol: string): RadarSnapshotPoint | null {
    return this.lastBySymbol.get(symbol) ?? null;
  }

  /** 清理超过 `maxAgeMs * 2` 未更新的标的。 */
  private prune(nowMs: number): void {
    const cutoff = nowMs - this.maxAgeMs * 2;
    for (const [sym, snap] of this.lastBySymbol) {
      if (snap.timestampMs < cutoff) this.lastBySymbol.delete(sym);
    }
  }
}
