/**
 * M3.1 持仓论点 `thesis` 持久化与 30 秒确定性机器硬检查（`packages/server/src/managed/thesis.ts`）
 *
 * 解决的问题：
 *   1. 每笔开仓不再只有一句模糊的 `open_reasoning`，而是绑定结构化交易论点：
 *      开仓依据、加仓触发条件、减仓/止盈目标、结构失效位、**时间止损（`time_stop_at`）**、
 *      以及 **最大不利偏移硬线（`max_adverse_excursion_pct`, MAE）**；
 *   2. 30 秒实时守卫对所有活跃论点执行**确定性机器硬检查**：
 *      - 不利偏移 ≥ `maxAdverseExcursionPct` → 立即平仓（`thesis_mae_stop`）；
 *      - 超过 `timeStopAt` 且当前 R 倍数仍 < `minProgressR`（默认 0.3R）→ 立即平仓（`thesis_time_stop`），
 *        彻底杜绝“死扛 10 小时小亏变大亏”，同时绝不误杀已走出利润的大赢家。
 */

import { fmtBeijingTime, isMajorSymbol, normalizeSymbol, type CloseReason } from '@aq/shared';

import { getDb } from '../db/index.js';
import type { Ai500DimensionScores, RadarTier } from '../radar/ai500.js';

/* -------------------------------------------------------------------------- */
/*  Public Types                                                               */
/* -------------------------------------------------------------------------- */

export interface PositionThesis {
  id: number;
  traderId: number;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  initialStopLoss: number;
  entryBasis: string;
  addTrigger: string;
  reduceTarget: string;
  invalidation: string;
  /** ISO 时间戳：到期若未达到 `minProgressR` 则机器硬平仓。 */
  timeStopAt: string | null;
  /** 到时间止损点时要求的最低 R 进展（默认 0.3R）。 */
  minProgressR: number;
  /** 价格口径最大不利偏移硬线（%，例如 2.5 表示逆向波动 ≥ 2.5% 强制平仓）。 */
  maxAdverseExcursionPct: number | null;
  /** 持仓期间观测到的最高 R 倍数。 */
  peakR: number;
  /** 持仓期间观测到的最大不利偏移（%，正数表示逆向幅度）。 */
  worstAdversePct: number;
  /** 入场快照指标：供 M3.2 战术面板衡量持仓期间动能/资金流衰减与 M4.3 成交归因。 */
  entryRadarScore: number | null;
  entryOiUsd: number | null;
  entryTakerBuyRatio: number | null;
  entryDimensions?: Ai500DimensionScores | null;
  entryTier?: RadarTier | null;
  status: 'active' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface UpsertThesisInput {
  traderId: number;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  initialStopLoss: number;
  entryBasis?: string;
  addTrigger?: string;
  reduceTarget?: string;
  invalidation?: string;
  timeStopAt?: string | null;
  /** 便捷参数：相对当前时间多少小时后触发时间止损（会被钳制在 1–72 小时）。 */
  timeStopHours?: number | null;
  minProgressR?: number;
  maxAdverseExcursionPct?: number | null;
  entryRadarScore?: number | null;
  entryOiUsd?: number | null;
  entryTakerBuyRatio?: number | null;
  entryDimensions?: Ai500DimensionScores | null;
  entryTier?: RadarTier | null;
  nowMs?: number;
}

export interface ThesisHardCheckVerdict {
  shouldClose: boolean;
  closeReason: CloseReason | null;
  detail: string;
  /** 本次测得当前 R 倍数（无有效初始止损时为 0）。 */
  currentR: number;
  /** 本次测得当前不利偏移 %（正数 = 逆向浮亏，0 = 浮盈）。 */
  adversePct: number;
  /** 更新后的最高 R 水位。 */
  nextPeakR: number;
  /** 更新后的最大不利偏移水位。 */
  nextWorstAdversePct: number;
}

/* -------------------------------------------------------------------------- */
/*  Pure Deterministic Hard-Check Engine                                       */
/* -------------------------------------------------------------------------- */

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 纯函数评估单个持仓论点的 30s 确定性硬检查（MAE + Time Stop）。
 * 零 I/O，可直接单元测试与回放。
 */
export function evaluateThesisHardCheck(
  thesis: Pick<
    PositionThesis,
    | 'symbol'
    | 'side'
    | 'entryPrice'
    | 'initialStopLoss'
    | 'timeStopAt'
    | 'minProgressR'
    | 'maxAdverseExcursionPct'
    | 'peakR'
    | 'worstAdversePct'
  >,
  observation: { markPrice: number; nowMs?: number },
): ThesisHardCheckVerdict {
  const nowMs = observation.nowMs ?? Date.now();
  const mark = observation.markPrice;
  if (!Number.isFinite(mark) || mark <= 0 || !Number.isFinite(thesis.entryPrice) || thesis.entryPrice <= 0) {
    return {
      shouldClose: false,
      closeReason: null,
      detail: '',
      currentR: 0,
      adversePct: 0,
      nextPeakR: thesis.peakR,
      nextWorstAdversePct: thesis.worstAdversePct,
    };
  }

  const favorableMove = thesis.side === 'long' ? mark - thesis.entryPrice : thesis.entryPrice - mark;
  const adverseMove = Math.max(0, -favorableMove);
  const adversePct = round2((adverseMove / thesis.entryPrice) * 100);

  const initialRisk = Math.abs(thesis.entryPrice - thesis.initialStopLoss);
  /*
   * 保本移损后补建论点时 `initialStopLoss === entryPrice`（initialRisk === 0）。
   * 若直接记 currentR = 0，时间止损会把已大幅浮盈的赢家误判为"无进展"强平；
   * 此时改用入场价 1% 作为名义 1R 基准衡量进展，并杜绝 NaN。
   */
  const effectiveRisk = initialRisk > 0 ? initialRisk : thesis.entryPrice * 0.01;
  const currentR = effectiveRisk > 0 ? round2(favorableMove / effectiveRisk) : 0;

  const nextPeakR = Math.max(thesis.peakR, currentR);
  const nextWorstAdversePct = Math.max(thesis.worstAdversePct, adversePct);

  // 1) MAE 硬检查（最高优先级：防止论点失效前硬扛超额逆向波动）
  if (
    thesis.maxAdverseExcursionPct !== null &&
    Number.isFinite(thesis.maxAdverseExcursionPct) &&
    thesis.maxAdverseExcursionPct > 0 &&
    adversePct >= thesis.maxAdverseExcursionPct
  ) {
    return {
      shouldClose: true,
      closeReason: 'thesis_mae_stop',
      detail:
        `${thesis.symbol} 触及论点 MAE 硬线：逆向偏移 ${adversePct.toFixed(2)}% ≥ 上限 ${thesis.maxAdverseExcursionPct.toFixed(2)}%` +
        `（入场 ${thesis.entryPrice} → 现价 ${mark}，R=${currentR.toFixed(2)}R），机器自动平仓止损。`,
      currentR,
      adversePct,
      nextPeakR,
      nextWorstAdversePct,
    };
  }

  // 2) 时间止损硬检查：到期且未走出最低盈利进展（minProgressR）则自动离场；已走出利润的赢家不误杀
  if (thesis.timeStopAt) {
    const deadlineMs = Date.parse(thesis.timeStopAt);
    if (Number.isFinite(deadlineMs) && nowMs >= deadlineMs) {
      const minR = Number.isFinite(thesis.minProgressR) ? thesis.minProgressR : 0.3;
      if (currentR < minR) {
        return {
          shouldClose: true,
          closeReason: 'thesis_time_stop',
          detail:
            `${thesis.symbol} 触及论点时间止损（截止 ${fmtBeijingTime(thesis.timeStopAt)} UTC+8）：当前进展 ${currentR.toFixed(2)}R < 最低要求 ${minR.toFixed(2)}R` +
            `（历史峰值 ${nextPeakR.toFixed(2)}R），行情未按预期展开，机器自动离场释放保证金。`,
          currentR,
          adversePct,
          nextPeakR,
          nextWorstAdversePct,
        };
      }
    }
  }

  return {
    shouldClose: false,
    closeReason: null,
    detail: '',
    currentR,
    adversePct,
    nextPeakR,
    nextWorstAdversePct,
  };
}

/**
 * 为新开仓位生成合理的默认论点参数（当模型未显式传入 `time_stop_hours`/`mae` 时兜底）：
 *   - 主流币（BTC/ETH）默认时间止损 12h，山寨币默认 8h；
 *   - 默认 MAE 设为初始止损距离的 92%（且落在 0.8%–8% 区间），既不抢在正常噪音里误触发，
 *     又能拦截止损未触发前的极端逆向拖拽。
 */
export function buildDefaultThesisBounds(params: {
  symbol: string;
  entryPrice: number;
  stopLoss: number | null;
  nowMs?: number;
}): { timeStopAt: string; maxAdverseExcursionPct: number | null; minProgressR: number } {
  const nowMs = params.nowMs ?? Date.now();
  const hours = isMajorSymbol(params.symbol) ? 12 : 8;
  const timeStopAt = new Date(nowMs + hours * 3600_000).toISOString();

  let maxAdverseExcursionPct: number | null = null;
  if (
    params.stopLoss !== null &&
    Number.isFinite(params.stopLoss) &&
    params.stopLoss > 0 &&
    params.entryPrice > 0
  ) {
    const slDistPct = (Math.abs(params.entryPrice - params.stopLoss) / params.entryPrice) * 100;
    if (slDistPct >= 0.6) {
      maxAdverseExcursionPct = round2(Math.max(0.8, Math.min(8.0, slDistPct * 0.95)));
    }
  }
  return { timeStopAt, maxAdverseExcursionPct, minProgressR: 0.3 };
}

/* -------------------------------------------------------------------------- */
/*  SQLite Repository                                                          */
/* -------------------------------------------------------------------------- */

interface ThesisRow {
  id: number;
  trader_id: number;
  symbol: string;
  side: string;
  entry_price: number;
  initial_stop_loss: number;
  entry_basis: string;
  add_trigger: string;
  reduce_target: string;
  invalidation: string;
  time_stop_at: string | null;
  min_progress_r: number;
  max_adverse_excursion_pct: number | null;
  peak_r: number;
  worst_adverse_pct: number;
  entry_radar_score: number | null;
  entry_oi_usd: number | null;
  entry_taker_buy_ratio: number | null;
  entry_dimensions_json?: string | null;
  entry_tier?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function parseEntryDimensions(raw: string | null | undefined): Ai500DimensionScores | null {
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
    /* ignore */
  }
  return null;
}

function toThesis(row: ThesisRow): PositionThesis {
  const tier =
    row.entry_tier === 'strong' || row.entry_tier === 'watch' || row.entry_tier === 'skip'
      ? row.entry_tier
      : null;
  return {
    id: row.id,
    traderId: row.trader_id,
    symbol: row.symbol,
    side: row.side === 'short' ? 'short' : 'long',
    entryPrice: row.entry_price,
    initialStopLoss: row.initial_stop_loss,
    entryBasis: row.entry_basis,
    addTrigger: row.add_trigger,
    reduceTarget: row.reduce_target,
    invalidation: row.invalidation,
    timeStopAt: row.time_stop_at,
    minProgressR: row.min_progress_r,
    maxAdverseExcursionPct: row.max_adverse_excursion_pct,
    peakR: row.peak_r,
    worstAdversePct: row.worst_adverse_pct,
    entryRadarScore: row.entry_radar_score,
    entryOiUsd: row.entry_oi_usd,
    entryTakerBuyRatio: row.entry_taker_buy_ratio,
    entryDimensions: parseEntryDimensions(row.entry_dimensions_json),
    entryTier: tier,
    status: row.status === 'closed' ? 'closed' : 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clipText(text: string | undefined, maxLen = 280): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

export const managedThesisStore = {
  /** 获取机器人全部活跃持仓论点。 */
  listActive(traderId: number): PositionThesis[] {
    const db = getDb();
    const rows = db.all<ThesisRow>(
      `SELECT * FROM managed_theses WHERE trader_id = ? AND status = 'active' ORDER BY updated_at DESC`,
      traderId,
    );
    return rows.map(toThesis);
  },

  /** 获取某个标的当前活跃论点。 */
  getActive(traderId: number, symbol: string): PositionThesis | null {
    const norm = normalizeSymbol(symbol);
    const db = getDb();
    const row = db.get<ThesisRow>(
      `SELECT * FROM managed_theses WHERE trader_id = ? AND symbol = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
      traderId,
      norm,
    );
    return row ? toThesis(row) : null;
  },

  /**
   * 写入或更新某标的的活跃持仓论点：
   *   - 若已存在 active 论点，保留 `entryPrice`/`initialStopLoss`/`peakR`/`worstAdversePct`/`entryRadar*`，
   *     覆盖模型新修订的战术条件与时间止损/MAE（严格校验合法区间）；
   *   - 若不存在，则新建一条 active 论点。
   */
  upsertActive(input: UpsertThesisInput): PositionThesis {
    const norm = normalizeSymbol(input.symbol);
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const db = getDb();

    let resolvedTimeStopAt: string | null | undefined = input.timeStopAt;
    if (
      resolvedTimeStopAt === undefined &&
      input.timeStopHours !== undefined &&
      input.timeStopHours !== null &&
      Number.isFinite(input.timeStopHours)
    ) {
      const clampedHours = Math.max(1, Math.min(72, input.timeStopHours));
      resolvedTimeStopAt = new Date(nowMs + clampedHours * 3600_000).toISOString();
    }

    const clampedMae =
      input.maxAdverseExcursionPct !== undefined &&
      input.maxAdverseExcursionPct !== null &&
      Number.isFinite(input.maxAdverseExcursionPct) &&
      input.maxAdverseExcursionPct > 0
        ? round2(Math.max(0.4, Math.min(15, input.maxAdverseExcursionPct)))
        : input.maxAdverseExcursionPct === null
          ? null
          : undefined;

    const clampedMinR =
      input.minProgressR !== undefined && Number.isFinite(input.minProgressR)
        ? round2(Math.max(-0.5, Math.min(3.0, input.minProgressR)))
        : undefined;

    const existing = this.getActive(input.traderId, norm);
    if (existing) {
      db.run(
        `UPDATE managed_theses
         SET entry_basis = ?,
             add_trigger = ?,
             reduce_target = ?,
             invalidation = ?,
             time_stop_at = ?,
             min_progress_r = ?,
             max_adverse_excursion_pct = ?,
             updated_at = ?
         WHERE id = ?`,
        input.entryBasis !== undefined ? clipText(input.entryBasis) : existing.entryBasis,
        input.addTrigger !== undefined ? clipText(input.addTrigger) : existing.addTrigger,
        input.reduceTarget !== undefined ? clipText(input.reduceTarget) : existing.reduceTarget,
        input.invalidation !== undefined ? clipText(input.invalidation) : existing.invalidation,
        resolvedTimeStopAt !== undefined ? resolvedTimeStopAt : existing.timeStopAt,
        clampedMinR !== undefined ? clampedMinR : existing.minProgressR,
        clampedMae !== undefined ? clampedMae : existing.maxAdverseExcursionPct,
        nowIso,
        existing.id,
      );
      return this.getActive(input.traderId, norm)!;
    }

    const defaults = buildDefaultThesisBounds({
      symbol: norm,
      entryPrice: input.entryPrice,
      stopLoss: input.initialStopLoss > 0 ? input.initialStopLoss : null,
      nowMs,
    });

    db.run(
      `INSERT INTO managed_theses (
        trader_id, symbol, side, entry_price, initial_stop_loss,
        entry_basis, add_trigger, reduce_target, invalidation,
        time_stop_at, min_progress_r, max_adverse_excursion_pct,
        peak_r, worst_adverse_pct,
        entry_radar_score, entry_oi_usd, entry_taker_buy_ratio,
        entry_dimensions_json, entry_tier,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      input.traderId,
      norm,
      input.side,
      input.entryPrice,
      input.initialStopLoss,
      clipText(input.entryBasis),
      clipText(input.addTrigger),
      clipText(input.reduceTarget),
      clipText(input.invalidation),
      resolvedTimeStopAt !== undefined ? resolvedTimeStopAt : defaults.timeStopAt,
      clampedMinR !== undefined ? clampedMinR : defaults.minProgressR,
      clampedMae !== undefined ? clampedMae : defaults.maxAdverseExcursionPct,
      input.entryRadarScore ?? null,
      input.entryOiUsd ?? null,
      input.entryTakerBuyRatio ?? null,
      input.entryDimensions ? JSON.stringify(input.entryDimensions) : null,
      input.entryTier ?? null,
      nowIso,
      nowIso,
    );
    return this.getActive(input.traderId, norm)!;
  },

  /**
   * BUG-5 修复：限价挂单提交时持久化 `status='pending'` 论点与雷达快照，
   * 避免跨周期成交或进程重启后丢失 `add_trigger / reduce_target / invalidation / entryDimensions`。
   */
  savePending(input: UpsertThesisInput): void {
    const db = getDb();
    const norm = normalizeSymbol(input.symbol);
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();

    let resolvedTimeStopAt: string | null = null;
    if (input.timeStopAt !== undefined) {
      resolvedTimeStopAt = input.timeStopAt;
    } else if (
      input.timeStopHours !== undefined &&
      input.timeStopHours !== null &&
      Number.isFinite(input.timeStopHours) &&
      input.timeStopHours > 0
    ) {
      const clampedH = Math.max(0.5, Math.min(72, input.timeStopHours));
      resolvedTimeStopAt = new Date(nowMs + clampedH * 3_600_000).toISOString();
    }

    const clampedMae =
      input.maxAdverseExcursionPct !== undefined &&
      input.maxAdverseExcursionPct !== null &&
      Number.isFinite(input.maxAdverseExcursionPct) &&
      input.maxAdverseExcursionPct > 0
        ? round2(Math.max(0.4, Math.min(15, input.maxAdverseExcursionPct)))
        : null;

    const clampedMinR =
      input.minProgressR !== undefined && Number.isFinite(input.minProgressR)
        ? round2(Math.max(-0.5, Math.min(3.0, input.minProgressR)))
        : 0.3;

    // 同一标的只保留最新一条 pending 论点草稿
    db.run(
      `DELETE FROM managed_theses WHERE trader_id = ? AND symbol = ? AND status = 'pending'`,
      input.traderId,
      norm,
    );
    db.run(
      `INSERT INTO managed_theses (
        trader_id, symbol, side, entry_price, initial_stop_loss,
        entry_basis, add_trigger, reduce_target, invalidation,
        time_stop_at, min_progress_r, max_adverse_excursion_pct,
        peak_r, worst_adverse_pct,
        entry_radar_score, entry_oi_usd, entry_taker_buy_ratio,
        entry_dimensions_json, entry_tier,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      input.traderId,
      norm,
      input.side,
      input.entryPrice,
      input.initialStopLoss,
      clipText(input.entryBasis),
      clipText(input.addTrigger),
      clipText(input.reduceTarget),
      clipText(input.invalidation),
      resolvedTimeStopAt,
      clampedMinR,
      clampedMae,
      input.entryRadarScore ?? null,
      input.entryOiUsd ?? null,
      input.entryTakerBuyRatio ?? null,
      input.entryDimensions ? JSON.stringify(input.entryDimensions) : null,
      input.entryTier ?? null,
      nowIso,
      nowIso,
    );
  },

  /** 读取并消费限价挂单预存的 `status='pending'` 论点（成交转正时调用）。 */
  consumePending(traderId: number, symbol: string): PositionThesis | null {
    const db = getDb();
    const norm = normalizeSymbol(symbol);
    const row = db.get<ThesisRow>(
      `SELECT * FROM managed_theses WHERE trader_id = ? AND symbol = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
      traderId,
      norm,
    );
    if (!row) return null;
    db.run(
      `DELETE FROM managed_theses WHERE trader_id = ? AND symbol = ? AND status = 'pending'`,
      traderId,
      norm,
    );
    return toThesis(row);
  },

  /** 挂单撤销/过期后清理对应的 `status='pending'` 论点草稿。 */
  cancelPending(traderId: number, symbol: string): void {
    const db = getDb();
    db.run(
      `DELETE FROM managed_theses WHERE trader_id = ? AND symbol = ? AND status = 'pending'`,
      traderId,
      normalizeSymbol(symbol),
    );
  },

  /** BUG-8 修复：加仓后同步更新活跃论点的加权入场均价（保持与 positions.entry_price 一致）。 */
  updateEntryPrice(traderId: number, symbol: string, newEntryPrice: number, nowMs = Date.now()): void {
    if (!Number.isFinite(newEntryPrice) || newEntryPrice <= 0) return;
    const db = getDb();
    db.run(
      `UPDATE managed_theses SET entry_price = ?, updated_at = ? WHERE trader_id = ? AND symbol = ? AND status = 'active'`,
      newEntryPrice,
      new Date(nowMs).toISOString(),
      traderId,
      normalizeSymbol(symbol),
    );
  },

  /** 更新持仓期间观测到的最高 R 与最大不利偏移水位。 */
  recordExcursion(id: number, peakR: number, worstAdversePct: number, nowMs = Date.now()): void {
    const db = getDb();
    db.run(
      `UPDATE managed_theses SET peak_r = ?, worst_adverse_pct = ?, updated_at = ? WHERE id = ?`,
      round2(peakR),
      round2(worstAdversePct),
      new Date(nowMs).toISOString(),
      id,
    );
  },

  /** 平仓后关闭对应论点。 */
  markClosed(traderId: number, symbol: string, nowMs = Date.now()): void {
    const norm = normalizeSymbol(symbol);
    const db = getDb();
    db.run(
      `UPDATE managed_theses SET status = 'closed', updated_at = ? WHERE trader_id = ? AND symbol = ? AND status = 'active'`,
      new Date(nowMs).toISOString(),
      traderId,
      norm,
    );
  },

  /** M4.3：平仓后关闭活跃论点并回填真实成交归因（净盈亏、实际 R 倍数、平仓原因）。 */
  markClosedWithOutcome(
    traderId: number,
    symbol: string,
    outcome: {
      tradeId: number | null;
      netPnl: number;
      exitPrice: number;
      closeReason: string | null;
      /** 分批平仓时传入按全回合净/毛盈亏折算的加权 R，避免仅按尾仓单价算导致与 realized_net_pnl 口径分裂。 */
      realizedR?: number | null;
      nowMs?: number;
    },
  ): void {
    const norm = normalizeSymbol(symbol);
    const active = this.getActive(traderId, norm);
    if (!active) return;
    const initialRisk = Math.abs(active.entryPrice - active.initialStopLoss);
    const favorableMove =
      active.side === 'long'
        ? outcome.exitPrice - active.entryPrice
        : active.entryPrice - outcome.exitPrice;
    const computedR =
      initialRisk > 0 && Number.isFinite(outcome.exitPrice) && outcome.exitPrice > 0
        ? round2(favorableMove / initialRisk)
        : 0;
    const realizedR =
      outcome.realizedR !== undefined &&
      outcome.realizedR !== null &&
      Number.isFinite(outcome.realizedR)
        ? round2(outcome.realizedR)
        : computedR;
    const db = getDb();
    db.run(
      `UPDATE managed_theses
       SET status = 'closed',
           closed_trade_id = ?,
           realized_net_pnl = ?,
           realized_r = ?,
           close_reason = ?,
           updated_at = ?
       WHERE id = ?`,
      outcome.tradeId,
      round2(outcome.netPnl),
      realizedR,
      outcome.closeReason,
      new Date(outcome.nowMs ?? Date.now()).toISOString(),
      active.id,
    );
  },

  /** 清理孤儿论点（仓位已不存在但论点仍标 active 的情况）。 */
  closeMissingPositions(traderId: number, openSymbols: ReadonlySet<string>, nowMs = Date.now()): number {
    const active = this.listActive(traderId);
    let closed = 0;
    for (const t of active) {
      if (!openSymbols.has(t.symbol)) {
        this.markClosed(traderId, t.symbol, nowMs);
        closed += 1;
      }
    }
    return closed;
  },
};
