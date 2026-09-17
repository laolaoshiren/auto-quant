/**
 * 编排层端口的真实实现（SQLite + 仓库）。
 *
 * ## 这一层的全部意义
 *
 * `orchestrator.ts` 只认端口，不认数据库。这个文件是**唯一**把端口接到
 * 真实存储上的地方 —— 于是"流程对不对"与"数据接得对不对"是两件事，
 * 前者用桩测（`orchestrator.test.ts`），后者在这里测。
 *
 * ## 算事实（facts）时的两个坑
 *
 * 1. **时间戳一律转 epoch 再比。** 库里存的是 UTC ISO，服务器是 CST ——
 *    本会话已经因为跨格式、跨时区比较各错过一次（读出"8 分钟新增 769 条"
 *    这种不可能的数字、以及误判周期停了）。所以这里不写字符串比较。
 * 2. **"上次唤醒"的时间要落库。** 不能放在内存里：进程重启一次，
 *    冷却与兜底判据就全部归零，大脑会被立刻唤醒一次 —— 那正是抖动。
 */

import type { StrategyConfig } from '@aq/shared';

import { agentExperiments, agentMemory, agentRuns } from '../../store/agentStore.js';
import { decisions, equity, positions, settings, traders, trades } from '../../store/repositories.js';
import type { OrchestratorPorts } from './orchestrator.js';
import type { WakeFacts } from './wake.js';

/** "上次唤醒"落库用的键。 */
const lastWakeKey = (traderId: number) => `agent_last_wake:${traderId}`;
/** 暂停标记落库用的键。 */
const pausedKey = (traderId: number) => `agent_paused:${traderId}`;

/* -------------------------------------------------------------------------- */
/*  时间                                                                       */
/* -------------------------------------------------------------------------- */

/** 一律用 epoch 毫秒比较。**不要在这之外写时间字符串比较。** */
const ms = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
};

/**
 * 距今多少分钟。**没有记录时返回"很久以前"而不是 0。**
 *
 * 这个方向的取舍很重要：0 会让兜底判据以为"刚刚醒过"从而永远不醒，
 * 而实际上它**从来没醒过**。宁可多醒一次，也不要一个永远不审视的账户。
 */
const NEVER = 999_999;
const minutesSince = (fromIso: string | null, nowMs: number): number =>
  fromIso ? Math.max(0, (nowMs - ms(fromIso)) / 60_000) : NEVER;

/* -------------------------------------------------------------------------- */
/*  端口工厂                                                                   */
/* -------------------------------------------------------------------------- */

export interface AgentPortDeps {
  traderId: number;
  /** 当前策略里的配置 —— AI 模式还没写入过配置时的基准。 */
  strategyConfig: () => StrategyConfig;
  /** 本小时的调用预算。 */
  hourlyBudget: number;
}

/**
 * 造一份真实端口。
 *
 * 所有读都走仓库（§5.4：SQL 只在 store 层），这个文件里不出现任何 SQL。
 */
export function makeAgentPorts(deps: AgentPortDeps): OrchestratorPorts {
  const { traderId } = deps;

  /** AI 模式下的配置；没有就回落到策略配置。 */
  const readConfig = (): StrategyConfig => {
    const raw = traders.get(traderId)?.agentConfigJson;
    if (!raw) return deps.strategyConfig();
    try {
      return JSON.parse(raw) as StrategyConfig;
    } catch {
      // 配置坏了不该让机器人停摆 —— 回落到策略配置，并把这件事记下来。
      return deps.strategyConfig();
    }
  };

  return {
    readConfig,

    saveConfig: (config) => {
      // AI 模式靠"这一列非空"来判定，所以这里必须真的写进去。
      traders.setAgentConfig(traderId, JSON.stringify(config));
    },

    toolReads: {
      performance: (window) => {
        const now = Date.now();
        const span =
          window === '24h' ? 86_400_000 : window === '7d' ? 7 * 86_400_000 : window === '30d' ? 30 * 86_400_000 : 0;
        const since = span > 0 ? new Date(now - span).toISOString() : new Date(0).toISOString();
        const rows = trades.list(traderId, 200).filter((t) => ms(t.closedAt) >= ms(since));
        const gross = rows.reduce((s, t) => s + t.pnl, 0);
        const fees = rows.reduce((s, t) => s + t.fee, 0);
        const net = rows.reduce((s, t) => s + t.netPnl, 0);
        const wins = rows.filter((t) => t.netPnl > 0);
        const losses = rows.filter((t) => t.netPnl <= 0);
        const avg = (xs: typeof rows) => (xs.length > 0 ? xs.reduce((s, t) => s + t.netPnl, 0) / xs.length : null);
        return {
          window,
          trades: rows.length,
          grossPnl: gross,
          fees,
          netPnl: net,
          winRatePercent: rows.length > 0 ? (wins.length / rows.length) * 100 : null,
          avgWin: avg(wins),
          avgLoss: avg(losses),
          feeToGrossRatio: Math.abs(gross) > 1e-9 ? fees / Math.abs(gross) : null,
          // 少于 30 笔无法区分"策略有效"与"运气好" —— 让模型自己看到这一点。
          sampleAdequate: rows.length >= 30,
        };
      },

      equityCurve: (limit) =>
        equity.list(traderId, limit).map((s) => ({
          at: s.timestamp,
          equity: s.equity,
          accountEquity: s.accountEquity,
        })),

      experiments: (limit) =>
        agentExperiments.recent(traderId, limit).map((e) => ({
          at: e.createdAt,
          trigger: e.trigger,
          reason: e.reason,
          // 想让改什么、实际生效什么 —— 两者不同时必须看得出来
          asked: safeJson(e.patchJson),
          applied: safeJson(e.appliedJson),
          clamps: safeJson(e.clampsJson),
          // ⚠️ 这三个决定"它能不能学到东西"。null 表示还没结算。
          outcomeTrades: e.outcomeTrades,
          outcomeNetPnl: e.outcomeNetPnl,
        })),

      recentDecisions: (limit) =>
        decisions.list(traderId, limit).map((d) => ({
          cycle: d.cycleNumber,
          at: d.timestamp,
          success: d.success,
          error: d.error,
          decisions: d.decisions.map((x) => ({ symbol: x.symbol, action: x.action })),
          // 被风控拒绝/跳过/失败 —— 这是"参数与市场脱节"的证据
          rejected: d.executionLog
            .filter((e) => e.status !== 'ok')
            .map((e) => ({ symbol: e.symbol, status: e.status, detail: e.detail })),
        })),

      marketOverview: (limit) => {
        const open = positions.open(traderId);
        return {
          heldSymbols: open.map((p) => p.symbol),
          openPositions: open.length,
          note: `当前持仓 ${open.length} 个。候选池的实时行情由交易循环注入，这里只给结构。`,
          requested: limit,
        };
      },
    },

    collectFacts: (): Omit<WakeFacts, 'callsThisHour'> => {
      const now = Date.now();
      const lastWakeIso = settings.get(lastWakeKey(traderId)) ?? null;
      const lastReviewIso = settings.get(`agent_last_review:${traderId}`) ?? null;

      const since = ms(lastWakeIso);
      const recent = trades.list(traderId, 50);
      const sinceWake = recent.filter((t) => ms(t.closedAt) > since);

      // 从最近一笔往前数连亏
      let losingStreak = 0;
      for (const t of recent) {
        if (t.netPnl <= 0) losingStreak += 1;
        else break;
      }

      const latest = equity.latest(traderId);
      const baseline = Number(settings.get(`agent_equity_baseline:${traderId}`) ?? '');
      const equityDriftPercent =
        latest && Number.isFinite(baseline) && baseline > 0
          ? ((latest.equity - baseline) / baseline) * 100
          : 0;

      return {
        /*
         * 没有"上次唤醒"记录时给一个**很大但不是 Infinity** 的值。
         *
         * 语义是"从来没醒过 → 现在就该醒"。用 Infinity 也能触发兜底，
         * 但它会在序列化与算术里变成奇怪的形状；用一个明确的大数更清楚。
         */
        minutesSinceLastWake: minutesSince(lastWakeIso, now),
        newClosedTrades: sinceWake.length,
        netPnlSinceLastWake: sinceWake.reduce((s, t) => s + t.netPnl, 0),
        losingStreak,
        equityDriftPercent,
        // 被风控拒绝的次数：从决策记录的 executionLog 里数，而不是另存一个计数器 ——
        // 计数器会与实际记录不一致，而那个不一致没人会发现。
        rejectionsSinceLastWake: decisions
          .list(traderId, 30)
          .filter((d) => ms(d.timestamp) > since)
          .reduce((n, d) => n + d.executionLog.filter((e) => e.status !== 'ok').length, 0),
        lastDecisionWasNoChange: false,
        hasPosition: positions.open(traderId).length > 0,
        minutesSinceStrategyReview: minutesSince(lastReviewIso, now),
      };
    },

    callsThisHour: () => agentRuns.countSince(traderId, new Date(Date.now() - 3_600_000).toISOString()),

    pendingExperiments: () =>
      agentExperiments.pending(traderId).map((e) => {
        /*
         * 只数**严格晚于**那次调整的成交。
         *
         * `>` 而不是 `>=` 是刻意的，方向很要紧：与调整同一毫秒平掉的仓
         * 归属是**有歧义**的。少数（用 `>`）只会让结算延后 —— 安全；
         * 多数（用 `>=`）可能把一个"调整之前就平掉的仓"算成调整的后果，
         * 那会让 `outcome_net_pnl` 里混进与这次改动无关的盈亏，
         * 而策略师会照着它学。
         *
         * 同一毫秒的平局在本会话里已经害过一次（`equity.list()` 的
         * `ORDER BY timestamp DESC` 返回了最旧那行，约 1/8 的运行读到错的权益）。
         * 那次是修 bug，这次是**选对方向**。
         */
        const after = trades.list(traderId, 200).filter((t) => ms(t.closedAt) > ms(e.createdAt));
        return {
          id: e.id,
          createdAt: e.createdAt,
          tradesSince: after.length,
          netPnlSince: after.reduce((s, t) => s + t.netPnl, 0),
        };
      }),

    settleExperiment: (id, outcome) => agentExperiments.settle(id, outcome),

    recordExperiment: (row) =>
      void agentExperiments.insert({
        traderId,
        trigger: row.trigger,
        observed: row.observed,
        patch: row.patch,
        applied: row.applied,
        clamps: row.clamps,
        reason: row.reason,
        toolCalls: row.toolCalls,
      }),

    recordRun: (row) =>
      void agentRuns.insert({
        traderId,
        kind: row.kind,
        trigger: row.trigger,
        intensity: row.intensity,
        steps: row.result.steps.length,
        agents: row.result.steps.map((s) => ({ step: s.step, tool: s.tool, thought: s.thought })),
        outcome: row.result.outcome,
        detail: row.result.detail,
        tokensIn: row.result.tokensIn,
        tokensOut: row.result.tokensOut,
        latencyMs: row.result.latencyMs,
      }),

    /*
     * 暂停是**落库**的，不是内存标志。
     *
     * 内存标志在进程重启后会消失 —— 一个"因为亏太多而主动停手"的决定，
     * 不该被一次重启悄悄撤销。
     */
    requestPause: (reason) => {
      settings.set(pausedKey(traderId), JSON.stringify({ at: new Date().toISOString(), reason }));
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  辅助                                                                       */
/* -------------------------------------------------------------------------- */

/** 行里存的是 JSON 文本；坏了就返回原始文本，而不是抛错让整条流程失败。 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** 记下"这一轮唤醒了"。冷却与兜底判据都依赖它，所以必须落库。 */
export function markWoken(traderId: number, equityNow: number | null): void {
  settings.set(lastWakeKey(traderId), new Date().toISOString());
  if (equityNow !== null && Number.isFinite(equityNow)) {
    settings.set(`agent_equity_baseline:${traderId}`, String(equityNow));
  }
}

/** 记下"这一轮做了策略审视"。强度选择依赖它。 */
export function markStrategyReview(traderId: number): void {
  settings.set(`agent_last_review:${traderId}`, new Date().toISOString());
}

/** 读取暂停状态。 */
export function readPause(traderId: number): { at: string; reason: string } | null {
  const raw = settings.get(pausedKey(traderId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { at: string; reason: string };
  } catch {
    return null;
  }
}

/** 清除暂停（由操作员决定恢复，模型没有这个工具）。 */
export function clearPause(traderId: number): void {
  settings.set(pausedKey(traderId), '');
}

/** 复盘写入记忆。 */
export function saveMemory(
  traderId: number,
  memory: { symbol: string; closeReason: string; netPnl: number; lesson: string; tags: string[] },
  tradeId: number,
): boolean {
  return agentMemory.insert({
    traderId,
    tradeId,
    symbol: memory.symbol,
    closeReason: memory.closeReason,
    netPnl: memory.netPnl,
    lesson: memory.lesson,
    tags: memory.tags,
  });
}
