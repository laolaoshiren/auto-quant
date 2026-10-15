/**
 * **智能体审计面板** —— 让操作员看到"团队到底做了什么、学到了什么"。
 *
 * ## 用户的要求（2026-10-12）
 *
 * > 「我理想中这次更新以后的效果：开启以后，整个智能体团队就开始并发工作，有主管、
 * >  分析账户的、有调查新闻的、有监控社区的、有查市场情绪的、有维护系统的程序员、
 * >  **有汇报工作的**、有文员、有交易员、有风控员等等」
 * >
 * > 「团队模式下，决策看板应该很大区别于前两种了，看板应该直观显示有哪些智能体，
 * >  都是什么分工，都在做什么，**时间、决策**，等等一切你觉得有必要的显示在上面」
 *
 * 这个面板就是那个「**汇报工作的**」—— 它把三张此前**前端完全不可见**的表
 *（`agent_runs` / `agent_experiments` / `agent_memory`）呈现出来。
 *
 * ## 为什么这三张表重要
 *
 * | 表 | 回答的问题 |
 * |---|---|
 * | `agent_runs` | **谁跑了、跑了多久、花了多少 token** —— 成本与活跃度 |
 * | `agent_experiments` | **改了什么参数、真实结果如何** —— "自我迭代"的审计线索 |
 * | `agent_memory` | **从每笔平仓里学到了什么** —— 它有没有在变聪明 |
 *
 * 三张表缺一张，操作员就只能看到"它在跑"，看不到"它在学"。
 *
 * ## 为什么对非团队模式也显示
 *
 * 这三张表是 `ai_managed` 模式就有的（AI 自己调参 + 复盘）。
 * 所以面板**不按模式隐藏** —— 只有"有没有数据"决定显示什么。
 * 团队模式会往 `agent_runs` 里写更多（每个角色一条），于是内容更丰富。
 */

import { useState } from 'react';

import { api, type AgentAudit } from '../lib/api';
import { fmtSigned, pnlColor } from '../lib/format';
import { usePolled } from '../lib/hooks';
import { plainText } from '../lib/plainText';
import { Panel } from './ui';

/** 把 ISO 时刻显示成 `MM-DD HH:MM`。 */
function stamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 大数字可读化（token 常常是六位数）。 */
function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 秒数可读化。 */
function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}分`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}秒`;
  return `${Math.round(ms)}毫秒`;
}

/** 一张小表。 */
function Section({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-base-700 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-base-850"
      >
        <span className="text-base font-medium text-ink-hi">{title}</span>
        <span className="num text-xs text-ink-faint">{count}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">{hint}</span>
        <span className="shrink-0 text-xs text-ink-faint">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

/**
 * 审计面板。
 *
 * ⚠️ **没有数据时显示一句"还没有"，而不是一个空壳** ——
 * 空表会让操作员以为"功能坏了"，而真相是"这个机器人还没跑过"。
 */
export function AgentAuditPanel({ traderId }: { traderId: number }): React.ReactElement {
  const query = usePolled((signal) => api.traderAgentAudit(traderId, 20, signal), { intervalMs: 30_000 });
  const data: AgentAudit | null | undefined = query.data;

  const runs = data?.runs ?? [];
  const experiments = data?.experiments ?? [];
  const memory = data?.memory ?? [];
  const total = runs.length + experiments.length + memory.length;

  /*
   * ── **整个面板默认收起**（2026-10-13 用户要求）────────────────────────
   *
   * 用户的原话：
   * > 「这一块功能有存在的价值吗？（我作为真人来说没有看出来这个有什么用，
   * >  也不知道他是干嘛的，你先做**最小化调整改动，做成默认收缩隐藏**）」
   *
   * ## 他说得对：默认展开时它只是占地方
   *
   * 默认展开的样子是「标题 + 一句说明 + 三个都收起的行」——
   * **一个字的有用信息都没给，却占了一整屏的宽度与高度**。
   * 而三张表各自**本来就是收起**的（`Section` 的 `useState(false)`），
   * 所以用户看到的就是一个"什么都没显示的大框"。
   *
   * ## 为什么保留它（而不是删掉）
   *
   * 它是用户 2026-10-12 明确要求的「**汇报工作的**」那一环 ——
   * 数据是真的（`#10` 上 runs 280 / experiments 24 / memory 90），
   * 只是**默认不该占地方**。
   *
   * ⚠️ 收起时把**条数**显示在标题上（`智能体审计 · 3 类记录`）——
   * 否则"收起了"与"没数据"在界面上长得一样。
   */
  const [open, setOpen] = useState(false);

  return (
    <Panel>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-base-850"
        title="团队做过什么、改了什么、学到了什么 —— 点开查看"
      >
        <span className="text-base font-medium text-ink-hi">智能体审计</span>
        <span className="num text-xs text-ink-faint">
          {total === 0 ? '暂无记录' : `${total} 条记录`}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
          团队做过什么、改了什么、学到了什么
        </span>
        <span className="shrink-0 text-xs text-ink-faint">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="border-t border-base-700">
          {query.loading && data === undefined ? (
            <div className="px-3 py-3 text-base text-ink-faint">正在读取…</div>
          ) : total === 0 ? (
            <div className="px-3 py-3 text-base text-ink-faint">
              还没有审计记录。机器人跑过一轮、或 AI 调整过一次参数之后，这里就会有内容。
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-base-700">
              <Section title="运行轨迹" hint="谁跑了、多久、花了多少 token" count={runs.length}>
                {runs.length === 0 ? (
                  <p className="text-xs text-ink-faint">还没有运行记录。</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-ink-faint">
                        <th className="py-1 font-normal">时刻</th>
                        <th className="py-1 font-normal">类型</th>
                        <th className="py-1 font-normal">触发</th>
                        <th className="py-1 font-normal">结果</th>
                        <th className="py-1 text-right font-normal">token</th>
                        <th className="py-1 text-right font-normal">耗时</th>
                      </tr>
                    </thead>
                    <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-t border-base-700/40">
                      <td className="num py-1 whitespace-nowrap text-ink-faint">{stamp(r.createdAt)}</td>
                      <td className="py-1 text-ink-soft">{r.kind}</td>
                      <td className="py-1 text-ink-soft">{r.trigger}</td>
                      <td className={`py-1 ${r.outcome === 'ok' ? 'text-up' : 'text-warn'}`} title={plainText(r.detail)}>
                        {r.outcome}
                      </td>
                      <td className="num py-1 text-right text-ink-faint">
                        {fmtTokens(r.tokensIn)}/{fmtTokens(r.tokensOut)}
                      </td>
                      <td className="num py-1 text-right text-ink-faint">{fmtMs(r.latencyMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section
            title="参数实验"
            hint="AI 改了什么 + 真实结果（自我迭代的线索）"
            count={experiments.length}
          >
            {experiments.length === 0 ? (
              <p className="text-xs text-ink-faint">还没有参数实验记录。</p>
            ) : (
              <ul className="space-y-2">
                {experiments.map((e) => (
                  <li key={e.id} className="rounded border border-base-700/50 px-2 py-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-3 text-xs">
                      <span className="num text-ink-faint">{stamp(e.createdAt)}</span>
                      <span className="text-ink-soft">{e.trigger}</span>
                      {/*
                        结果**必须区分"还没结算"与"结算了是 0"** ——
                        `outcomeTrades` 为 null 是"等结果中"，而 0 是"结果就是没交易"。
                        混在一起会让操作员以为"这个实验没效果"。
                      */}
                      {e.outcomeTrades === null ? (
                        <span className="text-ink-faint">等结果中</span>
                      ) : (
                        /*
                         * 颜色走 `pnlColor`：它把 **0 当中性色**，而这里原来是手写的
                         * `>= 0 ? 'text-up' : 'text-down'` —— 净盈亏恰好为 0 的实验
                         * 会被染成盈利绿。原因是**同一个失效模式**在本组件里出现了两次
                         *（另一处在下面的「教训记忆」，见那条注释）。
                         */
                        <span className={pnlColor(e.outcomeNetPnl)}>
                          {e.outcomeTrades} 笔 · 净 {fmtSigned(e.outcomeNetPnl)}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-soft">{plainText(e.reason)}</div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="教训记忆" hint="从每笔平仓里学到了什么" count={memory.length}>
            {memory.length === 0 ? (
              <p className="text-xs text-ink-faint">还没有教训记录（每笔平仓后会写一条）。</p>
            ) : (
              <ul className="space-y-1.5">
                {memory.map((m) => (
                  <li key={m.id} className="flex gap-2 text-xs">
                    <span className="num w-20 shrink-0 text-ink-faint">{stamp(m.createdAt)}</span>
                    <span className="w-24 shrink-0 truncate font-medium text-ink-soft" title={m.symbol}>
                      {m.symbol}
                    </span>
                    {/*
                      ⚠️ **保本平仓不能显示成绿色盈利。**
                      这里原来写的是 `m.netPnl >= 0 ? 'text-up' : 'text-down'` 与
                      `m.netPnl >= 0 ? '+' : ''` —— 两处都把 0 算进了"盈利"那一侧，
                      于是一笔净盈亏恰好为 0 的回合被渲染成**绿色的 `+0.00`**。
                      而"保本"的真实含义是"这一场白干"，操作员会把没赚钱读成小赚。

                      颜色改用 `pnlColor`（`lib/format.ts`，注释首行就是
                      "Zero is neutral"），符号改用 `fmtSigned`（它天然不给 0 加符号）。
                      两处必须一起改：只改颜色的话 `+0.00` 还在，只改符号的话绿色还在 ——
                      这正是本仓库反复记录的那类"两处各自正确、合起来失效"。
                    */}
                    <span className={`num w-16 shrink-0 ${pnlColor(m.netPnl)}`}>
                      {fmtSigned(m.netPnl)}
                    </span>
                    <span className="min-w-0 flex-1 text-ink-lo">{m.lesson}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
