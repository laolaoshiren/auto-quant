import { useCallback, useState } from 'react';
import { api } from './api';
import { useEvents } from './store';
import { fmtSigned } from './format';

/**
 * "Run now" — force one decision cycle immediately instead of waiting for the
 * interval. Returns the cycle summary as a toast; the cycle's own events arrive
 * over the WebSocket as usual.
 */
export function useRunOnce(): {
  runOnce: (traderId: number, traderName: string) => Promise<void>;
  busyId: number | null;
} {
  const [busyId, setBusyId] = useState<number | null>(null);
  const notify = useEvents((s) => s.notify);

  const runOnce = useCallback(
    async (traderId: number, traderName: string) => {
      setBusyId(traderId);
      try {
        const result = await api.runTraderOnce(traderId);
        notify({
          kind: 'ok',
          title: `${traderName}：周期完成`,
          body: result.summary,
          traderId,
        });
      } catch (error) {
        const message = (error as Error).message;
        notify({
          kind: 'error',
          title: `${traderName}：单次运行失败`,
          body: message,
          traderId,
        });
      } finally {
        setBusyId(null);
      }
    },
    [notify],
  );

  return { runOnce, busyId };
}

/**
 * 「让 AI 审视」—— 让 AI **现在**做一次策略审视，不等事件、不等兜底超时。
 *
 * ## 与 `useRunOnce` 是两件事，别混
 *
 *   `useRunOnce`  跑一个**决策周期** —— 机器人按当前参数决策一次
 *   这个          跑一次**策略审视** —— AI 反思绩效与复盘，决定要不要改参数
 *
 * 后者**下不了单**，但确实会改参数（受结构守卫约束：风险面只能收紧）。
 *
 * ## 为什么提示语说的是"已请求"而不是"正在审视"
 *
 * 审视是异步的（可能跑几十秒），而且**仍然可能被每小时预算挡下**。
 * 说"正在审视"是编造 —— 服务端返回的就是"请求已发出、结果去哪里看"。
 */
export function useAgentReview(): {
  requestReview: (traderId: number, traderName: string) => Promise<void>;
  busyId: number | null;
} {
  const [busyId, setBusyId] = useState<number | null>(null);
  const notify = useEvents((s) => s.notify);

  const requestReview = useCallback(
    async (traderId: number, traderName: string) => {
      setBusyId(traderId);
      try {
        const result = await api.agentReview(traderId);
        notify({
          kind: 'ok',
          title: `${traderName}：已请求 AI 审视`,
          body: result.note,
          traderId,
        });
      } catch (error) {
        const message = (error as Error).message;
        notify({
          kind: 'error',
          title: `${traderName}：请求 AI 审视失败`,
          body: message,
          traderId,
        });
      } finally {
        setBusyId(null);
      }
    },
    [notify],
  );

  return { requestReview, busyId };
}

/**
 * `对账完成：补录 1 笔，修正 3 笔` — zero parts are dropped, because
 * "修正 0 笔" reads like a failure rather than like nothing to do.
 */
export function reconcileSummary(result: {
  recovered: number;
  corrected: number;
  funding: number;
}): string {
  const parts: string[] = [];
  if (result.recovered > 0) parts.push(`补录 ${result.recovered} 笔`);
  if (result.corrected > 0) parts.push(`修正 ${result.corrected} 笔`);
  // Funding is money, not a count — it only shows up when it is not zero.
  if (result.funding !== 0) parts.push(`资金费 ${fmtSigned(result.funding)}`);
  if (parts.length === 0) return '对账完成：账本与交易所一致，无需补录或修正。';
  return `对账完成：${parts.join('，')}`;
}

/** Outcome of one manual reconcile, for the caller's own inline error note. */
export interface ReconcileOutcome {
  ok: boolean;
  /** The exact sentence shown in the toast. */
  message: string;
}

/**
 * Manual 对账.
 *
 * Deliberately not gated on the bot running: the endpoint places no orders and
 * only corrects the books, and a close that happened while the process was down
 * is exactly the case it exists for. Returns whether the books changed, so the
 * caller can force the stats and trades queries to reload.
 */
export function useReconcile(): {
  reconcile: (traderId: number, traderName: string) => Promise<ReconcileOutcome>;
  busyId: number | null;
} {
  const [busyId, setBusyId] = useState<number | null>(null);
  const notify = useEvents((s) => s.notify);

  const reconcile = useCallback(
    async (traderId: number, traderName: string): Promise<ReconcileOutcome> => {
      setBusyId(traderId);
      try {
        const result = await api.reconcileTrader(traderId);
        if (!result.ok) throw new Error(result.error);
        const message = reconcileSummary(result);
        notify({ kind: 'ok', title: message, body: traderName, traderId });
        return { ok: true, message };
      } catch (error) {
        const message = (error as Error).message;
        notify({ kind: 'error', title: `${traderName}：对账失败`, body: message, traderId });
        return { ok: false, message };
      } finally {
        setBusyId(null);
      }
    },
    [notify],
  );

  return { reconcile, busyId };
}

