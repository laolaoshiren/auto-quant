/**
 * 决策提示词记忆、持仓视图与空转计数构建器（从 `autoTrader.ts` 阶段 1 纯搬抽出，行为逐字节一致）。
 */
import type { MarketSnapshot, PositionView, StrategyConfig } from '@aq/shared';

import { agentMemory } from '../store/agentStore.js';
import {
  decisions as decisionStore,
  positions as positionStore,
  tradeEvents,
  trades as tradeStore,
} from '../store/repositories.js';

type PositionRow = ReturnType<typeof positionStore.open>[number];
import {
  closeReasonBreakdown,
  PROMPT_PERFORMANCE_WINDOW_HOURS,
  PROMPT_RECENT_CLOSE_COUNT,
  type PromptLesson,
  type PromptMemory,
  type PromptPosition,
  type PromptRejection,
} from '../strategy/prompt.js';

/** 提示词里给模型看多少条自己复盘出来的教训（按时间倒序取最新 N 条）。 */
export const PROMPT_LESSON_LIMIT = 8;

/** 提示词里"你自己复盘出来的教训"的一条。 */
export interface PromptLessonLike {
  symbol: string;
  closeReason: string;
  netPnl: number;
  lesson: string;
}

/** 从 `agent_memory` 的按时间倒序快照里挑要进提示词的最新教训。 */
export function selectPromptLessons(
  recent: readonly PromptLessonLike[],
  limit: number = PROMPT_LESSON_LIMIT,
): PromptLessonLike[] {
  return recent.slice(0, Math.max(0, limit)).map((m) => ({
    symbol: m.symbol,
    closeReason: m.closeReason,
    netPnl: m.netPnl,
    lesson: m.lesson,
  }));
}

/** 取最近 N 条按时间倒序的复盘教训。 */
export function buildPromptLessons(traderId: number): PromptLesson[] {
  return selectPromptLessons(agentMemory.recent(traderId, PROMPT_LESSON_LIMIT));
}

/** 取最近被风控拒绝的提议（不含系统执行异常 `failed`），最多 3 条。 */
export function buildPromptRejections(traderId: number): PromptRejection[] {
  try {
    const recent = decisionStore.list(traderId, 20);
    const out: PromptRejection[] = [];
    for (const rec of recent) {
      for (const entry of rec.executionLog) {
        if (entry.status !== 'rejected') continue;
        const decision = rec.decisions.find((d) => d.symbol === entry.symbol);
        out.push({
          symbol: entry.symbol,
          positionSizeUsd: decision?.positionSizeUsd ?? 0,
          reason: entry.detail,
        });
        if (out.length >= 3) return out;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 连续多少轮没有做出任何决策（扫固定最近 50 条，O(1) 窗口）。 */
export function countIdleCycles(traderId: number): number {
  try {
    const recent = decisionStore.list(traderId, 50);
    let idle = 0;
    for (const rec of recent) {
      if (rec.decisions.length > 0) break;
      idle += 1;
    }
    return idle;
  } catch {
    return 0;
  }
}

/** 组装喂给模型的历史记忆区块（绩效窗口、最近平仓、节流冷却、风控拦截与复盘教训）。 */
export function buildPromptMemory(
  traderId: number,
  config: StrategyConfig,
  entriesThisHour: number,
): PromptMemory {
  const since = new Date(Date.now() - PROMPT_PERFORMANCE_WINDOW_HOURS * 3_600_000).toISOString();
  const performance = tradeStore.performanceSince(traderId, since);
  const lastExitAt = tradeEvents.lastExit(traderId);
  const lastExitMs = lastExitAt ? Date.parse(lastExitAt) : Number.NaN;

  return {
    performance: {
      windowHours: PROMPT_PERFORMANCE_WINDOW_HOURS,
      totalTrades: performance.totalTrades,
      wins: performance.wins,
      losses: performance.losses,
      grossPnl: performance.grossPnl,
      totalFees: performance.totalFees,
      totalFunding: performance.totalFunding,
      netPnl: performance.netPnl,
      avgWin: performance.avgWin,
      avgLoss: performance.avgLoss,
      realizedPayoffRatio:
        performance.avgLoss > 0 ? performance.avgWin / performance.avgLoss : null,
      roundTripFeeRate: performance.roundTripFeeRate,
      idleCycles: countIdleCycles(traderId),
      byCloseReason: closeReasonBreakdown(tradeStore.recent(traderId, 200)),
    },
    recentCloses: tradeStore.recentWithReason(traderId, PROMPT_RECENT_CLOSE_COUNT),
    throttle: {
      entriesThisHour,
      maxEntriesPerHour: config.throttle.maxEntriesPerHour,
      minutesSinceLastExit: Number.isFinite(lastExitMs)
        ? Math.max(0, (Date.now() - lastExitMs) / 60_000)
        : null,
      reentryCooldownMinutes: config.throttle.reentryCooldownMinutes,
    },
    recentRejections: buildPromptRejections(traderId),
    lessons: buildPromptLessons(traderId),
  };
}

/** 把本地 `PositionRow` 结合实时快照组装为提示词与风控共用的 `PositionView`。 */
export function toPositionView(row: PositionRow, snapshots: Map<string, MarketSnapshot>): PositionView {
  const snapshot = snapshots.get(row.symbol);
  const markPrice = snapshot?.price ?? row.entry_price;
  const isLong = row.side === 'long';
  const unrealizedPnl =
    (isLong ? markPrice - row.entry_price : row.entry_price - markPrice) * row.quantity;

  return {
    id: row.id,
    traderId: row.trader_id,
    symbol: row.symbol,
    side: isLong ? 'long' : 'short',
    quantity: row.quantity,
    entryPrice: row.entry_price,
    markPrice,
    leverage: row.leverage,
    liquidationPrice: row.liquidation_price,
    unrealizedPnl,
    unrealizedPnlPercent: row.margin_used > 0 ? (unrealizedPnl / row.margin_used) * 100 : 0,
    peakPnlPercent: row.peak_pnl_percent,
    marginUsed: row.margin_used,
    notional: row.quantity * markPrice,
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    openedAt: row.opened_at,
    openReasoning: row.open_reasoning,
  };
}

/** 组装喂给模型的当前持仓列表（含快照与持仓时长）。 */
export function buildPromptPositions(
  localPositions: PositionRow[],
  snapshots: Map<string, MarketSnapshot>,
): PromptPosition[] {
  return localPositions.map((p) => ({
    position: toPositionView(p, snapshots),
    snapshot: snapshots.get(p.symbol) ?? null,
    holdingMinutes: (Date.now() - new Date(p.opened_at).getTime()) / 60_000,
  }));
}
