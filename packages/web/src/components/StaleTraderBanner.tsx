/**
 * **机器人停摆横幅** —— 让"已经在 `/api/health` 里算出来的信号"真的有人看见。
 *
 * ## 为什么需要它（2026-10-17 · t99 · 本批最贵的一次教训）
 *
 * ```
 *   #10「赚大钱」（dry_run=0，真实资金）
 *   连续失败 9 轮 / 331 分钟 ≈ 5.5 小时，零决策
 * ```
 *
 * **系统知道**这件事 —— `/api/health` 一直在返回：
 * ```
 *   {"ok":false,
 *    "staleTraders":[{"id":10,"name":"赚大钱","staleForMs":2144782,…}],
 *    "reason":"有 1 个正在运行的机器人已超过各自周期的 2 倍仍未完成一轮决策。"}
 * ```
 * 而 `ok:false` 的唯一消费者是**容器编排器**（本部署是 systemd，没人读它），
 * 控制台**连 `staleTraders` 这个字段都没有**。队长是在做"部署后回读"时
 * **偶然**发现那 5.5 小时的。
 *
 * ## 与 `manager.ts` 那半边的分工
 *
 * | | 做什么 | 什么时候 |
 * |---|---|---|
 * | 本组件 | **持续状态**：每次轮询都拿最新的 `staleForMs` | 页面开着就每 60 秒一次 |
 * | `manager.auditStaleTraders()` | **留痕**：进入/恢复各一条可检索日志 | 自检 sweep（约 30 分钟一次） |
 *
 * 两者读的是**同一个判据**（`evaluateTraderHealth`），所以永远说同一件事。
 *
 * ## ⚠️ 只对会影响真实资金的事发强信号
 *
 * `dry_run=1`（模拟盘）停摆同样值得知道，但不该把真事的强度稀释掉 ——
 * 所以只把**确证 `dry_run=0`** 的画成红色横幅，其余留给日志与自检。
 * 判据用 `trader.dryRun ?? health.dryRun`，与 `manager.ts` 的
 * `trader.dryRun ?? env.dryRun` **同一口径**（机器人自己记的优先，没有才回落进程级）。
 * ⚠️ 取不到（行不存在、或两个来源都是 `undefined`）时**不升级** ——
 * 宁可不显示，也不要把一堆模拟盘停摆报成红色（那会训练操作员忽略它）。
 *
 * ## 为什么不做成"可关闭"
 *
 * 用户要的是"持续状态"。一个能关掉的告警，在它在最该被看见的时刻（停摆几小时）
 * 往往已经被关掉了 —— 与本仓库反复记的那条同源：
 * **"一个每轮都响的告警等于没有告警"，而一个能被顺手关掉的告警更糟**。
 */

import { Link } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';

import { api, type Health } from '../lib/api';
import { usePolled } from '../lib/hooks';

/** 一条要在横幅上显示的停摆（**已经过实盘过滤**）。 */
export interface StaleEntry {
  id: number;
  name: string;
  minutes: number;
  awaitingFirstCycle: boolean;
}

/**
 * 从 `health` + `traders` 里挑出**该升级为显眼状态**的停摆（纯函数，便于直接断言）。
 *
 * ⚠️ 两个来源缺一不可：
 *   · `health.staleTraders` —— 谁卡住了、卡了多久（服务端算好的判据）；
 *   · `traders` 的 `dryRun` —— **是不是真钱**（`health` 里没有这个信息）。
 */
export function staleEntriesFrom(
  health: Health | null | undefined,
  traders: ReadonlyArray<{ id: number; dryRun?: boolean }> | null | undefined,
): StaleEntry[] {
  if (health === null || health === undefined) return [];
  /* `ok:true` ⇒ 服务端判"没有正在运行的机器人卡住" ⇒ 无事可报。 */
  if (health.ok) return [];
  const stale = health.staleTraders;
  if (stale === undefined || stale.length === 0) return [];

  const byId = new Map((traders ?? []).map((row) => [row.id, row]));
  const out: StaleEntry[] = [];
  for (const entry of stale) {
    /*
     * ⚠️ **只有确证"真钱"才升级**：`=== false` 而不是 `!== true`。
     * `!== true` 会把"不知道是不是真钱"也画成红色横幅 —— 那正是
     * `health.ts` 里反复警告的"误报会让运维对告警脱敏"。
     */
    const realMoney = (byId.get(entry.id)?.dryRun ?? health.dryRun) === false;
    if (!realMoney) continue;
    out.push({
      id: entry.id,
      name: entry.name,
      minutes: Math.round((entry.staleForMs ?? 0) / 60_000),
      awaitingFirstCycle: entry.awaitingFirstCycle,
    });
  }
  return out;
}

/** 一条停摆的短句（`#10 赚大钱 · 36 分钟未完成一轮决策`）。 */
export function staleEntryText(entry: StaleEntry): string {
  const what = entry.awaitingFirstCycle ? '启动后一直没有跑完一轮' : '没有完成一轮决策';
  return `#${entry.id} ${entry.name} · ${entry.minutes} 分钟${what}`;
}

/**
 * 全局常驻横幅（挂在 `App.tsx` 的最顶层 —— **跨页面可见**）。
 *
 * 挂顶层而不是某个页面顶部：停摆是**跨页面**的事，人停在别的页面时
 * 照样要看见（否则"信号在没人看的地方"这个问题只是换了个地方发生）。
 *
 * ⚠️ 它**只读** `/api/health` 与 `/api/traders`，不发任何写请求 ——
 * 与"不得改变任何交易行为"一致。
 */
export function StaleTraderBanner(): React.ReactElement | null {
  /*
   * 一个 loader 同时取两份数据：判据要 `health.staleTraders`，
   * 而"是不是真钱"只在 `traders` 行上（`health` 里没有这个字段）。
   * 60 秒一次：停摆是"几十分钟到几小时"量级的事，不需要更密。
   */
  const query = usePolled(
    async () => ({
      health: await api.health(),
      traders: await api.traders(),
    }),
    { intervalMs: 60_000 },
  );

  const entries = staleEntriesFrom(query.data?.health, query.data?.traders);
  if (entries.length === 0) return null;

  return (
    <div
      role="alert"
      data-testid="stale-trader-banner"
      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-down/60 bg-down/15 px-3 py-1.5 text-xs text-down"
    >
      <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0 self-center" />
      <span className="font-semibold">
        {entries.length} 个正在运行的实盘机器人已停摆（已卡住，未在产出决策）
      </span>
      {entries.map((entry) => (
        <Link
          key={entry.id}
          to={`/traders/${entry.id}`}
          className="num underline decoration-down/50 underline-offset-2 hover:decoration-down"
        >
          {staleEntryText(entry)}
        </Link>
      ))}
      <span className="text-down/80">
        —— 卡的判据是「超过各自决策周期的 2 倍仍未跑完一轮」（与 /api/health 同一口径）
      </span>
    </div>
  );
}
