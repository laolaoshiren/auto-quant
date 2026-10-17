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
 *
 * ## ⚠️ 兜底句「账本与交易所一致」只在**真的什么都没发生**时才能用（2026-10-17 · t101）
 *
 * 后端 `6a39c46` 把 `corrected` 从"尝试次数"改成"**生效**次数"，并新增
 * `correctedAttempted` / `correctedKept`。本函数当时没跟上，于是
 * 「尝试 3 笔、0 笔生效、3 笔因边界存疑保留」这个场景里：
 *
 * ```
 *   后端（manager.ts 的 warn）  「尝试修正 3 笔，一笔都没真的生效 —— 全部因"重建腿边界存疑"保留本地口径」
 *   前端（本函数，修复前）      「对账完成：账本与交易所一致，无需补录或修正。」   ← 说反话
 * ```
 *
 * 两个输出**只能有一个是真的**，而后端那个是对的（差异确实还在，只是不敢擅自改）。
 * 所以这里把 `correctedKept` 纳入判据：
 *
 * ```
 *   corrected > 0            → 「修正 N 笔」（真的生效了）
 *   corrected === 0 && kept>0 → 「尝试修正 N 笔，但一笔都没生效（因边界存疑保留本地 K 笔）」
 *   recovered===0 && corrected===0 && correctedKept===0 && funding===0
 *                            → 才允许说「账本与交易所一致，无需补录或修正」
 * ```
 *
 * ⚠️ **两个新字段是必填参数**（不是可选）：它们是"能不能说一致"的必要输入，
 * 做成可选就意味着下一个调用点可以漏传、然后**再次**说反话。
 */
export function reconcileSummary(result: {
  recovered: number;
  corrected: number;
  correctedAttempted: number;
  correctedKept: number;
  funding: number;
}): string {
  /*
   * ⚠️ **拿不到 `correctedKept` 时不许替它断言"一致"。**
   *
   * 类型上它是必填（见上面的说明），生产路径一定带着它。但真正会出问题的是
   * **漏传**：任何按旧形状调它的地方（本仓库实测就有 —— `t95` 那份最小复现脚本
   * 写的还是 `{recovered, corrected, funding}`）都会得到 `undefined`，
   * 而 `undefined > 0` 恒为 false ⇒ 于是**又**悄悄落回兜底句说"一致"。
   * 那正是本条要修的病，不能留一条没被堵住的同形通道。
   *
   * 所以这里显式分辨"确实是 0"与"根本没收到"：后者只陈述已知的事，
   * 不对账实是否一致下结论。
   */
  const keptKnown = Number.isFinite(result.correctedKept);
  const kept = keptKnown ? result.correctedKept : 0;
  const attempted = Number.isFinite(result.correctedAttempted)
    ? result.correctedAttempted
    : result.corrected + kept;

  /*
   * ── 零生效、但有东西被保留：**这一支就是本次回归的修复点** ──────────────
   *
   * 必须显式说"一笔都没生效"（与后端那句同向），绝不能让 `corrected === 0`
   * 直接掉进下面的兜底句 —— 那会让"判不出来、保持原样"读成"账实相符"。
   */
  if (result.corrected === 0 && kept > 0) {
    const zeroEffective: string[] = [];
    if (result.recovered > 0) zeroEffective.push(`补录 ${result.recovered} 笔`);
    zeroEffective.push(
      `尝试修正 ${attempted} 笔，但一笔都没生效（因边界存疑保留本地 ${kept} 笔）`,
    );
    if (result.funding !== 0) zeroEffective.push(`资金费 ${fmtSigned(result.funding)}`);
    return `对账完成：${zeroEffective.join('，')}`;
  }

  const parts: string[] = [];
  if (result.recovered > 0) parts.push(`补录 ${result.recovered} 笔`);
  if (result.corrected > 0) parts.push(`修正 ${result.corrected} 笔`);
  /*
   * 有生效、同时也有被保留的：两个数都要说。
   *
   * 只报"修正 N 笔"会让操作员以为差额已经清干净了 —— 而 `kept` 的那几笔
   * 下一轮还会撞上同一批（后端注释的原话）。
   */
  if (kept > 0) parts.push(`因边界存疑保留本地 ${kept} 笔`);
  // Funding is money, not a count — it only shows up when it is not zero.
  if (result.funding !== 0) parts.push(`资金费 ${fmtSigned(result.funding)}`);
  if (parts.length === 0) {
    return keptKnown
      ? '对账完成：账本与交易所一致，无需补录或修正。'
      : '对账完成：本轮没有补录或修正（未收到"边界存疑保留"计数，不判断账实是否一致）。';
  }
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

