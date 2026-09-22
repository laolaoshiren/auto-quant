/**
 * Lightweight per-trader summary cache.
 *
 * The overview table needs equity / return / win-rate for every trader, but
 * those come from one endpoint per trader. Rather than have each row fetch
 * independently (and refetch on every re-render), a single poller walks the
 * trader list on an interval and fans the results into this map. The trader
 * dashboard also writes into it, so navigating back to the overview is instant.
 */
import { create } from 'zustand';
import {
  closeReasonLabel as sharedCloseReasonLabel,
  type CircuitBreakerReading,
  type TraderStats,
} from '@aq/shared';
import { api } from './api';

/**
 * 概览表与机器人页共用的"一个机器人的摘要"。
 *
 * 它比 `TraderStats` 多一项**熔断读数** —— 那个数由服务端从运行时组装，
 * 不属于仓储层的纯统计（见 `/api/traders/:id/stats` 上的说明）。
 *
 * ⚠️ 它被声明成**可选**，因为这个 map 有两个写入方：
 *   · `fetchOne` —— 走那个端点，熔断读数一定有（可能是 `null`，见下）
 *   · `put`      —— WebSocket 推来的单条统计，**没有**熔断读数
 *
 * 用可选而不是让 `put` 的调用方编一个假值：**"不知道"与"没有熔断"是两件事** ——
 * 前者不该渲染成"一切正常"。
 */
/**
 * `maxLeverage` 是**这台机器人生效配置里的杠杆天花板**（AI 托管时取
 * `agent_config_json`，否则取策略）。有效杠杆表盘用它当刻度。
 *
 * `null` = 读不到 —— 前端显示"不知道"，**不要当成 0**：0 会让表盘看起来像
 * "完全没加杠杆"，而那恰好是最容易被误读成安全的状态。
 */
export type TraderSummary = TraderStats & {
  circuitBreaker?: CircuitBreakerReading | null;
  maxLeverage?: number | null;
  /**
   * **这个机器人自己**在不在纸面模式（`true` = 订单只在本地撮合）。
   *
   * 与 `circuitBreaker` 同一类字段：服务端从运行时组装，不属于仓储层的纯统计。
   *
   * ⚠️ 它与顶栏那个徽章（读进程级的 `env.dryRun`）**可以不一致** ——
   * `POST /traders/:id/start` 的 `dryRun` 是每次启动单独传的。实测有人（我）
   * 忘了传 `{"dryRun": false}`，机器人就在纸面模式下跑了一轮，而顶栏写着「实盘」。
   *
   * `null` / 缺省 = 它没在运行，**读不到** —— 不要渲染成「实盘」。
   */
  dryRun?: boolean | null;
};

interface SummaryState {
  stats: Record<number, TraderSummary>;
  /** Trader ids with a request currently in flight. */
  pending: Record<number, boolean>;
  lastRefresh: number | null;
  errors: Record<number, string>;

  fetchOne: (traderId: number) => Promise<TraderSummary | null>;
  refreshMany: (traderIds: number[]) => Promise<void>;
  prune: (traderIds: number[]) => void;
  put: (stats: TraderSummary) => void;
}

export const useSummaries = create<SummaryState>((set, get) => ({
  stats: {},
  pending: {},
  lastRefresh: null,
  errors: {},

  fetchOne: async (traderId) => {
    if (get().pending[traderId]) return get().stats[traderId] ?? null;
    set((state) => ({ pending: { ...state.pending, [traderId]: true } }));
    try {
      const stats = await api.traderStats(traderId);
      set((state) => ({
        stats: { ...state.stats, [traderId]: stats },
        errors: { ...state.errors, [traderId]: '' },
      }));
      return stats;
    } catch (error) {
      set((state) => ({ errors: { ...state.errors, [traderId]: (error as Error).message } }));
      return null;
    } finally {
      set((state) => ({ pending: { ...state.pending, [traderId]: false }, lastRefresh: Date.now() }));
    }
  },

  refreshMany: async (traderIds) => {
    // Plain loop: a handful of traders, and we would rather not burst the API.
    for (const id of traderIds) {
      await get().fetchOne(id);
    }
    set({ lastRefresh: Date.now() });
  },

  prune: (traderIds) => {
    const keep = new Set(traderIds);
    set((state) => {
      const next: Record<number, TraderStats> = {};
      for (const [key, value] of Object.entries(state.stats)) {
        if (keep.has(Number(key))) next[Number(key)] = value;
      }
      return { stats: next };
    });
  },

  put: (stats) => set((state) => ({ stats: { ...state.stats, [stats.traderId]: stats } })),
}));

/* -------------------------------------------------------------------------- */
/*  Enum labels                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `trade.closeReason` is a stable machine code persisted by the backend (see
 * `CLOSE_REASONS` in `@aq/shared`) — never display text.
 *
 * The label map itself lives in `@aq/shared` because the server log lines, the
 * prompt sent to the model and this console all render the same codes; keeping
 * one map means a new reason cannot be added without every surface showing it.
 */
export function closeReasonLabel(reason: string | null | undefined, netPnl?: number | null): string {
  // The console shows an em-dash for "nothing recorded" rather than an empty cell.
  if (!reason) return '—';
  /*
   * ⚠️ **把盈亏传下去。** 否则「触发止损」这一格会在**显示盈利**的那一行里出现，
   * 读起来像自相矛盾 —— 而它其实是一次**被上移到成本之上的止损**（保本离场）。
   * 实测操作员正是这样误判的。见 `closeReasonLabel` 在 `@aq/shared` 里的说明。
   */
  return sharedCloseReasonLabel(reason, netPnl);
}
