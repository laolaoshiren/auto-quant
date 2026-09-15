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
import { closeReasonLabel as sharedCloseReasonLabel, type TraderStats } from '@aq/shared';
import { api } from './api';

interface SummaryState {
  stats: Record<number, TraderStats>;
  /** Trader ids with a request currently in flight. */
  pending: Record<number, boolean>;
  lastRefresh: number | null;
  errors: Record<number, string>;

  fetchOne: (traderId: number) => Promise<TraderStats | null>;
  refreshMany: (traderIds: number[]) => Promise<void>;
  prune: (traderIds: number[]) => void;
  put: (stats: TraderStats) => void;
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
export function closeReasonLabel(reason: string | null | undefined): string {
  // The console shows an em-dash for "nothing recorded" rather than an empty cell.
  if (!reason) return '—';
  return sharedCloseReasonLabel(reason);
}
