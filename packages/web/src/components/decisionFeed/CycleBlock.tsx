import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  Lock,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  calculateTokenCost,
  fmtCompactTokens,
  fmtTokenCostUsd,
  formatCycleCostTooltip,
  type Decision,
  type DecisionRecord,
  type ExecutionLogEntry,
  type TokenPricingPerMillion,
  type TraderMode,
  type TraderTokenBillingSummary,
} from '@aq/shared';
import type { MarketSymbol } from '../../lib/api';
import { resolveFigureContext } from '../../lib/decisionFigures';
import { fmtInt, fmtLatency, timeAgo } from '../../lib/format';
import { actionLabel } from '../DecisionAudit';
import { isManagedTrajectoryEntry, resolveManagedStageChips } from '../PowerlineTrajectory';
import { cn } from '../ui';
import { CycleDetails, type DetailTab } from './CycleDetails';
import { DecisionRow, LogLine } from './DecisionRowView';

/* -------------------------------------------------------------------------- */
/*  连续相同轮次的压缩                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 一轮的**内容签名** —— 只由"发生了什么"决定，**不含周期号与时间**。
 *
 * 返回 `null` 表示这一轮不参与合并。
 */
export function cycleSignature(record: DecisionRecord): string | null {
  // 失败的轮次永远单独显示：要读的是那一次具体的错误，不是"又失败了一次"。
  if (record.error !== null) return null;

  /*
   * ⚠️ **两个数组都要兜底**（2026-10-12 实测抓到的真 BUG）。
   *
   * 原来只有 `executionLog` 有 `?? []`，而 `decisions` 直接读 —— 于是
   * 一条**缺 `decisions` 的历史记录**会让这里抛
   * `Cannot read properties of undefined (reading 'length')`，
   * 而这发生在**渲染路径**上：`FeedErrorBoundary` 于是把**整块决策看板**
   * 换成一张错误卡（实测现象就是"最近决策"里出现"这一块渲染失败"，
   * 团队看板完全不显示）。
   *
   * 为什么历史记录会缺字段：决策记录是**跨版本累积**的，
   * 早先的写入路径/测试数据未必带全字段（实测本地库里就有一条
   * `[{"symbol":"BTCUSDT","action":"open_long"}]` —— 缺 `confidence`）。
   * **看板必须容忍旧数据**，否则一次版本升级就会让历史全部打不开。
   */
  const log = record.executionLog ?? [];
  const decisions = record.decisions ?? [];
  // 完全空白的一轮也不合并 —— 它本身信息就少，再折起来等于让它消失。
  if (decisions.length === 0 && log.length === 0) return null;

  return JSON.stringify([
    decisions.map((decision) => [decision.action, decision.symbol, decision.confidence]),
    log.map((entry) => [entry.status, entry.action, entry.symbol, entry.detail]),
  ]);
}

interface CycleRun {
  record: DecisionRecord;
  /** 紧随其后、内容**完全**相同的轮次（不含 `record` 自己），最近的在前。 */
  repeats: DecisionRecord[];
}

/**
 * 把列表里**连续且内容完全相同**的轮次压成一段。
 *
 * ## 为什么需要它
 *
 * 熔断、冷却、安全模式这类**持续状态**每一轮都会写一条决策记录，而记录的内容
 * 一字不差。实测 AI 托管机器人 #8 的右栏连着 5 条都是同一句
 * 「总回撤熔断…本轮没有向模型提问，也没有下单」—— 操作者翻多少屏都是同一句话，
 * **真正有信息量的那一轮反而被淹掉**。这是评估报告里标为"最影响可用性"的一条，
 * 而它对 AI 托管模式尤其要紧：那一栏正是操作员看"它在想什么"的唯一窗口。
 *
 * ## 为什么折叠是安全的
 *
 * 判据是**内容签名完全相同**，不是"看起来差不多"：被折起来的轮次没有携带
 * 任何这一条没有的信息。周期号范围仍然显示出来，因为"从第几轮开始变成这样"
 * 本身就是信息。
 *
 * ## 为什么不合并到数据层
 *
 * `decision_records` 是**审计记录**：每一轮都必须落库，那是可复现的凭证链
 * （`AGENTS.md` §2）。压缩只发生在**展示**这一层 —— 数据一条都不能少。
 */
export function groupCycles(records: DecisionRecord[]): CycleRun[] {
  const runs: Array<CycleRun & { signature: string | null }> = [];
  for (const record of records) {
    const signature = cycleSignature(record);
    const last = runs[runs.length - 1];
    if (last && signature !== null && last.signature === signature) {
      last.repeats.push(record);
      continue;
    }
    runs.push({ record, signature, repeats: [] });
  }
  return runs;
}

/**
 * 「同样的内容还有 N 轮」。
 *
 * 缩进一格、灰字、一行 —— 它是**注解**而不是内容，不该和决策本身抢注意力。
 */
export function RepeatedCycles({ repeats }: { repeats: DecisionRecord[] }) {
  const numbers = repeats.map((row) => row.cycleNumber);
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  const range = low === high ? `#${low}` : `#${low}–#${high}`;
  return (
    <p className="pl-2 pt-1 text-xs text-ink-faint">
      ⤷ 同样的内容还有 {repeats.length} 轮（周期 {range}）
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/*  One cycle module                                                           */
/* -------------------------------------------------------------------------- */

function priceOf(symbols: MarketSymbol[], symbol: string): number | null {
  const row = symbols.find((item) => item.symbol === symbol);
  return row ? row.price : null;
}

/**
 * 一轮周期：**一行纯文字元数据 + 一个盒子 + 两个纯文字按钮**。
 *
 * 盒子里按顺序排这一轮的每一条决策（扁平行，不再给每条决策套卡片），
 * **每条决策都带着它自己的执行结果**（见 `DecisionOutcome`）—— 被风控拒绝、
 * 执行失败、运行时跳过、已执行，四种状态全部落在决策那一行上，一条都不会消失
 * （`DECISION-FEED.md` §7：拒绝与失败必须仍然可见，并说明原因）。
 *
 * `export` 只是为了 SSR 验证脚本能够直接渲染它（`scripts/ssr-decision-feed.tsx`）。
 * 它在页面里的唯一调用点是下面的 `DecisionFeed`。
 */
export function CycleBlock({
  record,
  symbols,
  mode = 'strategy',
  pricing = null,
  onSelectSymbol,
}: {
  record: DecisionRecord;
  symbols: MarketSymbol[];
  mode?: TraderMode;
  pricing?: TokenPricingPerMillion | null;
  onSelectSymbol?: (symbol: string) => void;
}) {
  /*
   * ⚠️ **这两个字段要在这里兜一次底，不能假设它们一定存在。**
   *
   * 数据有两个来源，形状**不一样**：
   *
   *   · **库里的记录**（`GET /traders/:id/decisions`）—— `decisions` 与
   *     `executionLog` 一定存在（服务端把 `NULL` 归一成了 `[]`）；
   *   · **WebSocket 实时推送**的周期 —— 它由服务端在周期进行中逐段发出，
   *     尚未落库，所以这两个字段都可能**还没有**。
   *
   * 实测（示例数据 + `/traders/:id`）：`undefined` 在这里抛
   * `Cannot read properties of undefined`，而它抛在**渲染期** ——
   * 整页白屏（`#root` 变空），连外壳都不剩，三套模板全部复现。
   */
  const decisions = record.decisions ?? [];
  const executionLog = record.executionLog ?? [];

  /*
   * 把执行日志按 `action` + `symbol` 配到各自的决策上。
   *
   * 为什么不是 `filter(status === 'skipped')` 那种写法：那样的结果是"结果"与"决策"
   * 分居盒子上下两处，操作者要把上面的提案和下面的小字自己对起来 ——
   * 而熔断真正拦下的是**那一条**提案，答案必须写在那一条旁边。
   */
  const plan = planExecution(executionLog, decisions);
  const skipped = plan.counts.skipped;
  const rejected = plan.counts.rejected;
  const failed = plan.counts.failed;

  /*
   * ── `skip` 折叠 ────────────────────────────────────────────────────────
   *
   * 提示词现在要求模型对**每一个候选标的**都留一条决策（不做的用 `skip`，带
   * `setup_score`，见 `decision.ts` 里那段）—— 那是为了让它能校准自己的入场门槛。
   * 但一轮有二十个候选，**决策流于是被十几条"跳过"刷满**，真正该看的那一两条
   * 被挤到看不见的地方。用户的原话：「显示太多币种（把那些置信度低的或者你看看
   * 用什么做参考把不重要的隐藏了，只保留重要的）」。
   *
   * 所以：**有动作的照旧逐张显示；`skip` 收进一个可展开的折叠块**。
   * 信息一条没丢（展开就在，而且每条的评分与理由都在），首屏只剩需要看的东西。
   *
   * ⚠️ **必须带着原下标一起过滤。** `plan.outcomes` 是**按 `record.decisions`
   * 的下标对齐**的（见 `planExecution` 的说明），过滤之后下标会错位 ——
   * 那样"这张卡片的结果"就会挂到别的决策上去。折叠块里那批也一样要带。
   */
  const visible = decisions
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decision.action !== 'skip');

  /*
   * ## 同一标的出现多条时，标出"第几条 / 共几条"
   *
   * 用户 2026-10-03 的反馈（附截图）：「ETHUSDT 为什么一周期出现 2 次？」
   *
   * 核实：**那两条都是模型的真实输出** —— 一轮里它对 ETHUSDT 给了两条 `hold`
   * （一条讲"止损离现价太近"、一条讲"持仓名额已满"）。渲染层如实显示了两条，
   * 那是审计该有的行为，**不该被去重掉**：隐藏它等于替模型改写记录。
   *
   * 但"同一个币突然出现两行"确实让人以为界面出了 bug。所以补一个**计数标注** ——
   * 一行解释成本，换来"这是模型给了两条，不是界面重复"。
   */
  const totalBySymbol = new Map<string, number>();
  for (const { decision } of visible) {
    totalBySymbol.set(decision.symbol, (totalBySymbol.get(decision.symbol) ?? 0) + 1);
  }
  const seenOrder = new Map<string, number>();
  const visibleRows = visible.map(({ decision, index }) => {
    const nth = (seenOrder.get(decision.symbol) ?? 0) + 1;
    seenOrder.set(decision.symbol, nth);
    return { decision, index, nth, total: totalBySymbol.get(decision.symbol) ?? 1 };
  });

  const skippedRows = decisions
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decision.action === 'skip');
  /** 被跳过的那批里分最高的一个 —— 折叠标题上给一个可比较的数，省得非展开不可。 */
  const topSkippedScore = skippedRows.reduce<number | null>(
    (best, { decision }) =>
      typeof decision.setupScore === 'number' && (best === null || decision.setupScore > best)
        ? decision.setupScore
        : best,
    null,
  );

  return (
    /*
     * `data-record-id` 是**给滚动锚点用的 DOM 标记**（见 `DecisionFeed` 里那个
     * `useLayoutEffect`）：新周期插到顶部时，要靠它认出"上一次的第一条"这一个元素、
     * 量出它被推下去多少像素，才能把 `scrollTop` 补偿回去。它不是样式钩子，
     * 不要用它写 CSS。
     */
    <article className="min-w-0" data-record-id={record.id}>
      <CycleMeta record={record} pricing={pricing} />

      {/*
        ══════════════════════════════════════════════════════════════════════
         ⚠️ **团队模式不再走 `CycleBlock`**（2026-10-12 重做）
         ══════════════════════════════════════════════════════════════════════

         `DecisionFeed` 里那个分支是
         `mode === 'ai_team' ? <TeamCycleBlock/> : <CycleBlock/>` ——
         所以团队模式下下面那对「思考过程 · 提示词」按钮**不会被渲染**。

         它的职责没有丢，被 `TeamCycleBlock` + `TeamDecisionRow` 接过去了，
         而且**换了位置**：
         · `<team>` 块的各角色产出 → 团队决策行展开后的「各角色产出」
           （带中文角色名与模型名，比这里原来显示 role id 更可读）；
         · 多空辩论 → 同上（多头/空头/裁决就是三个角色）；
         · 思考过程 / 提示词 → 团队决策行展开后的「原始材料」，
           而且要**再点一次**才取（懒加载）—— 它们是排查用的原料，不是主视图。

         留在 `CycleBlock` 里是因为**另两种模式仍然用它**，
         删掉会破坏 `strategy` / `ai_managed` 的现有界面（用户要求旧模式完全不变）。
      */}

      {/*
        决策盒子：**一轮只有这一个**边框。每条决策只是里面的一段，没有自己的边框。

        ⚠️ 底色必须是 `bg-base-850` 而不是 `bg-base-900`。
        面板（Panel）本身就是 `bg-base-900` —— 盒子用同色等于**没有边界**，
        几十轮决策连成一片，分不清哪一条属于哪一轮（操作者原话：
        "肉眼看不出来每一期决策"）。

        `base-850` 比面板抬升一层，盒子就浮出来了；配合边框，
        一眼能看出"这一轮到这里结束"。
      */}
      <div className="min-w-0 rounded-xl border border-base-700/90 bg-base-850/95 px-3.5 py-3 transition-colors hover:border-base-600/80">
        {record.error && (
          <p
            className={`mb-2 flex items-start gap-1.5 rounded-lg px-2.5 py-2 text-xs leading-relaxed ${
              record.error.startsWith('本轮被中断')
                ? 'bg-base-900/60 text-ink-faint'
                : 'border border-down/25 bg-down/10 text-down'
            }`}
          >
            {record.error.startsWith('本轮被中断') ? (
              <span aria-hidden className="mt-0.5 shrink-0">⏸</span>
            ) : (
              <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 break-words">{record.error}</span>
          </p>
        )}

        {record.error === null && decisions.length === 0 && executionLog.length === 0 && (
          <p className="text-xs text-ink-faint">本周期模型没有给出任何决策。</p>
        )}

        {decisions.length > 0 && (
          <div className="divide-y divide-base-750/80">
            {visibleRows.map(({ decision, index, nth, total }) => {
              const rowOutcome = plan.outcomes[index] ?? null;
              return (
                <div key={`${decision.symbol}-${index}`} className="py-2.5 first:pt-0 last:pb-0">
                  <DecisionRow
                    decision={decision}
                    price={priceOf(symbols, decision.symbol)}
                    outcome={rowOutcome}
                    figureContext={resolveFigureContext(record.userPrompt, decision.symbol, rowOutcome)}
                    duplicate={{ nth, total }}
                    onSelectSymbol={onSelectSymbol}
                  />
                </div>
              );
            })}
            {skippedRows.length > 0 && (
              <div className="pt-2.5 first:pt-0">
                <details className="group rounded-lg border border-base-750/90 bg-base-900/55 px-2.5 py-2 transition-colors hover:border-base-600/70">
                  <summary className="flex cursor-pointer list-none select-none flex-wrap items-center gap-1.5 text-xs text-ink-lo [&::-webkit-details-marker]:hidden">
                    <ChevronRight
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-150 group-open:rotate-90"
                    />
                    <span className="shrink-0 font-medium text-ink-mid">
                      跳过 {skippedRows.length} 个标的
                    </span>
                    {topSkippedScore !== null && (
                      <span className="num shrink-0 rounded bg-base-800 px-1.5 py-0.5 text-[11px] text-ink-lo">
                        最高 {topSkippedScore} 分
                      </span>
                    )}
                    <span className="flex flex-wrap items-center gap-1">
                      {skippedRows.slice(0, 8).map(({ decision }, i) => (
                        <span
                          key={`${decision.symbol}-${i}`}
                          className="rounded bg-base-800/90 px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-mid"
                        >
                          {decision.symbol}
                        </span>
                      ))}
                      {skippedRows.length > 8 && (
                        <span className="text-[11px] text-ink-faint">
                          +{skippedRows.length - 8}
                        </span>
                      )}
                    </span>
                    <span className="ml-auto hidden text-[11px] text-ink-faint group-open:hidden sm:inline">
                      展开理由
                    </span>
                    <span className="ml-auto hidden text-[11px] text-ink-faint sm:group-open:inline">
                      收起理由
                    </span>
                  </summary>
                  <div className="mt-2.5 divide-y divide-base-750/70 border-t border-base-750/70 pt-2.5">
                    {skippedRows.map(({ decision, index }) => {
                      const rowOutcome = plan.outcomes[index] ?? null;
                      return (
                        <div key={`skip-${decision.symbol}-${index}`} className="py-2 first:pt-0 last:pb-0">
                          <DecisionRow
                            decision={decision}
                            price={priceOf(symbols, decision.symbol)}
                            outcome={rowOutcome}
                            figureContext={resolveFigureContext(record.userPrompt, decision.symbol, rowOutcome)}
                            onSelectSymbol={onSelectSymbol}
                          />
                        </div>
                      );
                    })}
                  </div>
                </details>
              </div>
            )}
          </div>
        )}

        {(() => {
          const visibleLeftover = plan.leftover.filter(
            (entry) => !isManagedTrajectoryEntry(entry) || resolveManagedStageChips(entry).length > 0,
          );
          if (visibleLeftover.length === 0) return null;
          return (
            <ul className="mt-2.5 space-y-1.5 border-t border-base-750/80 pt-2">
              {visibleLeftover.map((entry, index) => (
                <LogLine key={`leftover-${index}`} entry={entry} onSelectSymbol={onSelectSymbol} />
              ))}
            </ul>
          );
        })()}
      </div>

      {/*
        ⚠️ **团队模式不显示这两个按钮**（用户 2026-10-12 的反馈）。

        用户的原话：
        > 「为什么还原封不动保留了**思考过程、提示词查看功能**（这模式不是团队了吗？
        >  这个就很莫名其妙，如之前我所说应该是**上面固定展示各智能体工作状态和摘要**，
        >  用户**有需要可以手动点击打开查看详情**）」

        **他说得对**：团队模式该看的是"谁在干什么、结论是什么"，
        而"某个模型这一轮的思维链"是**排查用的原料**，不是主视图。

        它并没有丢 —— 团队的 `<team>` 审计块里**每个角色都有自己的产出**
        （见 `TeamTraceBlock`），那才是团队模式下"打开详情"该看到的东西。
        融合两种模式的原料视图会让主视图永远停在"怎么做出来的"而不是"做了什么"。
      */}
      {mode !== 'ai_team' && (
        <CycleDetails
          record={record}
          counts={{ failed, rejected, skipped }}
        />
      )}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  执行日志 → 决策 的配对                                                      */
/* -------------------------------------------------------------------------- */

/** 一条执行日志配到哪条决策上（`null` = 这条决策在运行时没有任何记录）。 */
interface ExecutionPlan {
  /** 与 `decisions` **同下标**：第 i 条决策的结果，`null` 表示没有对应记录。 */
  outcomes: Array<ExecutionLogEntry | null>;
  /** 没有配上任何决策的日志条目（防御性兜底，正常为空）。 */
  leftover: ExecutionLogEntry[];
  counts: Record<ExecutionLogEntry['status'], number>;
}

/** 决策与执行日志的配对键。用 `\u0000`：币种符号与动作里都不可能含这个字符。 */
function pairKey(action: string, symbol: string): string {
  return `${action}\u0000${symbol}`;
}

/**
 * 把执行日志配到决策上。
 *
 * ## 为什么需要一个函数、而不是两个 `filter`
 *
 * 契约要求"每条决策都写出结果"，而 `executionLog` 是一个**扁平数组**：
 * 它既没有决策下标，也没有决策 id。唯一稳的对应关系是 `action` + `symbol`。
 *
 * ## 同一个币种出现多条决策时怎么办（这是最容易做错的地方）
 *
 * 用**队列**而不是查找：策略允许一轮里对同一个币种给出多条决策
 * （平多之后立刻开空是很常见的组合）。队列的规则是"**先提出的先配上**" ——
 * 这正是服务端的行为：`rejected` 按 `sortDecisions()` 的顺序推、执行按
 * `verdict.approved` 的顺序推，两者与 `record.decisions` 是同一个顺序。
 *
 * 队列只能一对一占用：同符号的两条决策**不可能**都拿到同一条日志
 * （那会让一条"被拒"同时写给两条决策，等于凭空多出一次拒绝）。
 *
 * 配不上的决策拿到 `null`（界面会明说"运行时没有留下执行记录"），
 * 配不上的日志进 `leftover`（界面照旧列出来，一条都不丢）。
 */
function planExecution(log: ExecutionLogEntry[], decisions: Decision[]): ExecutionPlan {
  /*
   * ⚠️ **两个参数都要防 `undefined`，不能只防一个。**
   *
   * 调用方在 826 行已经写了 `record.executionLog ?? []`，但那只保护了
   * **库里读出来的记录**。而 `DecisionFeed` 还有第二条数据来源：
   * **WebSocket 实时推送**的记录（`useEvents` 的 `byTrader[].decisions`）——
   * 它由服务端在周期进行中逐段发出，**形状与库里那条不同**（尚未落库，
   * 所以 `executionLog` / `decisions` 都可能还没填）。
   *
   * 实测（用示例数据打开 `/traders/:id`）：这里读到 `undefined` 就抛
   * `Cannot read properties of undefined (reading 'length')`，而它在
   * **渲染期**抛出 —— 整页白屏（`<div id="root">` 变空），连外壳都不剩。
   * 三套模板**全都**复现，所以它不是某个模板的问题。
   *
   * 修在这里而不是调用处：`planExecution` 是一个纯函数，它的契约就该是
   * "给什么都能算出结果"，而不是"调用方必须保证参数完整" ——
   * 后者每加一条数据来源就要重新检查一遍。
   */
  const safeLog = log ?? [];
  const safeDecisions = decisions ?? [];

  /** 每个配对键下**还没被认领**的日志下标，按出现顺序排队。 */
  const queue = new Map<string, number[]>();
  for (let index = 0; index < safeLog.length; index += 1) {
    const entry = safeLog[index];
    if (!entry) continue;
    const key = pairKey(entry.action, entry.symbol);
    const bucket = queue.get(key);
    if (bucket) bucket.push(index);
    else queue.set(key, [index]);
  }

  const outcomes: Array<ExecutionLogEntry | null> = [];
  const claimed = new Set<number>();
  for (const decision of safeDecisions) {
    const bucket = queue.get(pairKey(decision.action, decision.symbol));
    // 每认领一条就把它从队列头移走：同一个币种的第二条决策因此拿到**下一条**日志。
    const index = bucket?.shift();
    if (index === undefined) {
      outcomes.push(null);
      continue;
    }
    claimed.add(index);
    outcomes.push(safeLog[index] ?? null);
  }

  const counts: Record<ExecutionLogEntry['status'], number> = {
    ok: 0,
    submitted: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
    data: 0,
  };
  for (const entry of safeLog) counts[entry.status] += 1;

  return {
    outcomes,
    leftover: safeLog.filter((_, index) => !claimed.has(index)),
    counts,
  };
}

/**
 * 周期头：一行纯文字。
 *
 * 内容与顺序照参考：`相对时间 │ 周期 #N │ in N · out N`。
 * **没有**边框、底色、`成功` 徽章、`N 个候选`、`N 条决策` —— 那些都要读第二眼
 * 才明白在说什么，而这一行的作用是让操作者扫过去就知道"这是第几轮、多久以前"。
 *
 * 失败的周期在这一行末尾多一小段 `⚠ 失败 · <类别>`：`§2` 要求失败"能被看见"，但用
 * **一行小字**表达，不做徽章行 —— 参考产品那一行也是 `失败 · AI 决策` 这个样子。
 * 类别取自服务端写在错误文案第一个全角冒号之前的那一段（见 `failureCategory`）。
 *
 * 完整时间戳放在 `title` 里：相对时间适合扫读，但对账时需要精确时刻。
 */
export function TokenBillingHeaderBadge({
  billing,
  open,
  onToggle,
}: {
  billing: TraderTokenBillingSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const totalTok = billing.promptTokens + billing.completionTokens;
  const label = billing.pricing?.free
    ? 'Token 免费'
    : billing.totalCostUsd !== null
      ? `累计 ${fmtTokenCostUsd(billing.totalCostUsd, { approx: true })}`
      : `累计 ${fmtCompactTokens(totalTok)}`;

  const cycleNote =
    billing.meteredCycles === billing.totalCycles
      ? `共 ${billing.totalCycles} 轮 · 点击${open ? '收起' : '展开'}明细条`
      : `共 ${billing.totalCycles} 轮 / ${billing.meteredCycles} 轮已计费 · 点击${open ? '收起' : '展开'}明细条`;

  const tooltipLines = [
    billing.pricing?.free
      ? `累计 Token 估算费用：免费（${cycleNote}）`
      : billing.totalCostUsd !== null
        ? `累计 Token 估算费用：${fmtTokenCostUsd(billing.totalCostUsd)}（${cycleNote}）`
        : `累计 Token 用量：${fmtCompactTokens(totalTok)}（${cycleNote}）`,
    billing.totalCostUsd !== null
      ? `· 今日估算：${fmtTokenCostUsd(billing.todayCostUsd)}（${billing.todayCycles} 轮）`
      : '· 单价状态：当前模型暂无公开单价',
    `· 累计输入：${fmtCompactTokens(billing.promptTokens)}（缓存 ${fmtCompactTokens(billing.cachedTokens)}）`,
    `· 累计输出：${fmtCompactTokens(billing.completionTokens)}${billing.reasoningTokens > 0 ? `（思考 ${fmtCompactTokens(billing.reasoningTokens)}）` : ''}`,
    ...(billing.savedByCacheUsd != null && billing.savedByCacheUsd > 0
      ? [`· 缓存已省：${fmtTokenCostUsd(billing.savedByCacheUsd, { approx: true })}`]
      : []),
  ];

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-aq-tip={tooltipLines.join('\n')}
      className={cn(
        'num inline-flex h-[22px] shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium leading-none transition',
        open
          ? "border-amber-400/60 bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/30 [[data-skin='light']_&]:border-amber-700/55 [[data-skin='light']_&]:bg-amber-500/20 [[data-skin='light']_&]:text-amber-950"
          : "border-amber-400/30 bg-amber-500/10 text-amber-300/95 hover:border-amber-400/55 hover:bg-amber-500/16 [[data-skin='light']_&]:border-amber-700/40 [[data-skin='light']_&]:bg-amber-500/15 [[data-skin='light']_&]:text-amber-900",
      )}
    >
      <Coins aria-hidden className="h-3 w-3 shrink-0 opacity-85" />
      <span>{label}</span>
      <ChevronDown
        aria-hidden
        className={cn('h-2.5 w-2.5 shrink-0 opacity-70 transition-transform', open && 'rotate-180')}
      />
    </button>
  );
}

export function TokenBillingSummaryStrip({
  billing,
  onClose,
}: {
  billing: TraderTokenBillingSummary;
  onClose: () => void;
}) {
  const cacheRate =
    billing.promptTokens > 0 ? Math.round((billing.cachedTokens / billing.promptTokens) * 100) : null;
  const pricing = billing.pricing;

  return (
    <div className="shrink-0 border-b border-base-800 bg-base-900/75 px-3 py-2 text-[11.5px] leading-relaxed">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="num flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            <span className="text-ink-faint">累计({billing.totalCycles}轮) </span>
            <span className="font-semibold text-amber-300 [[data-skin='light']_&]:text-amber-800">
              {pricing?.free
                ? '$0.00 (免费)'
                : billing.totalCostUsd !== null
                  ? fmtTokenCostUsd(billing.totalCostUsd, { approx: true })
                  : '单价未知'}
            </span>
          </span>
          <span>
            <span className="text-ink-faint">今日({billing.todayCycles}轮) </span>
            <span className="font-medium text-ink-hi">
              {pricing?.free
                ? '$0.00'
                : billing.todayCostUsd !== null
                  ? fmtTokenCostUsd(billing.todayCostUsd, { approx: true })
                  : '—'}
            </span>
          </span>
          {billing.savedByCacheUsd != null && billing.savedByCacheUsd > 0 && (
            <span className="text-up">
              缓存已省 {fmtTokenCostUsd(billing.savedByCacheUsd, { approx: true })}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="收起 Token 计费统计"
          className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-ink-faint transition hover:bg-base-800 hover:text-ink-hi"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
      <div className="num mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-ink-lo">
        <span>
          入 <span className="text-ink-mid">{fmtCompactTokens(billing.promptTokens)}</span>
          {cacheRate !== null && (
            <span className="text-up">（缓存 {cacheRate}%）</span>
          )}
        </span>
        <span>
          出{' '}
          <span className="text-sky-300 [[data-skin='light']_&]:text-sky-700">
            {fmtCompactTokens(billing.completionTokens)}
          </span>
          {billing.reasoningTokens > 0 && (
            <span className="text-violet-300 [[data-skin='light']_&]:text-violet-700">
              （思考 {fmtCompactTokens(billing.reasoningTokens)}）
            </span>
          )}
        </span>
        {pricing ? (
          <span className="text-ink-faint">
            · 单价/1M：入 ${pricing.input} / 缓存 ${pricing.cacheRead} / 出 ${pricing.output}（{pricing.source}）
          </span>
        ) : (
          <span className="text-ink-faint">· 暂无 {billing.model || '当前模型'} 公开单价</span>
        )}
      </div>
    </div>
  );
}

function CycleMeta({
  record,
  pricing = null,
}: {
  record: DecisionRecord;
  pricing?: TokenPricingPerMillion | null;
}) {
  /*
   * token 数与耗时**各自独立**显示。
   *
   * 原来它们是「二选一」的兜底关系 —— 有 token 计数就不显示耗时。
   * 但这两个数字回答的是不同问题：
   *
   *   · token 数 = 这一轮**花了多少钱**
   *   · 耗时      = 这一轮**等了多久**
   *
   * 3 分钟周期下后者尤其重要：一次 15 秒的调用吃掉周期的 8%，
   * 连续几轮变慢意味着模型服务在恶化 —— 那是要提前发现的事。
   * 合并成"有 A 就不显示 B"，等于逼操作者在两个都关心的数字里挑一个。
   */
  const hasTokens = record.promptTokens !== null || record.completionTokens !== null;
  /*
   * **用量那一格要带上缓存命中率。**
   *
   * 「in N · out N」只说了"花了多少"，没说"花得值不值"。而这个项目
   * 实测缓存命中 99.6%、成本 93.5% 来自输出 —— 两个数字都不是从
   * token 总量能看出来的。
   *
   * 命中率**只在服务商报了 `cachedTokens` 时才显示**：
   * `null` 是"不知道"（这个供应商没上报），`0` 是"确实没命中"。
   * 把前者显示成 0% 会让人去查一个根本不存在的问题。
   */
  const cachePct =
    record.cachedTokens != null && record.promptTokens != null && record.promptTokens > 0
      ? Math.round((record.cachedTokens / record.promptTokens) * 100)
      : null;
  /*
   * 思考占比同理：输出价是缓存命中输入价的 200 倍，
   * 所以"这一轮 4,439 个输出里有多少是在想"直接决定这一轮值不值。
   */
  const thinkPct =
    record.reasoningTokens != null && record.completionTokens != null && record.completionTokens > 0
      ? Math.round((record.reasoningTokens / record.completionTokens) * 100)
      : null;

  const cycleCost =
    hasTokens && pricing
      ? calculateTokenCost(
          {
            promptTokens: record.promptTokens,
            completionTokens: record.completionTokens,
            cachedTokens: record.cachedTokens,
            reasoningTokens: record.reasoningTokens,
          },
          pricing,
        )
      : null;

  const latencyTone =
    record.aiLatencyMs > 75_000
      ? 'text-down bg-down/12'
      : record.aiLatencyMs > 45_000
        ? "text-orange-300 bg-orange-500/14 [[data-skin='light']_&]:text-orange-700 [[data-skin='light']_&]:bg-orange-500/12"
        : 'text-ink-hi bg-base-800/85';

  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-0.5 text-[11.5px] leading-none text-ink-lo">
      <span
        className="num inline-flex items-center rounded-md bg-accent/12 px-1.5 py-0.5 font-semibold text-accent"
        title={`第 ${record.cycleNumber} 轮决策周期`}
      >
        #{record.cycleNumber}
      </span>

      <span className="font-medium text-ink-mid" title={new Date(record.timestamp).toLocaleString()}>
        {timeAgo(record.timestamp)}
      </span>

      <span aria-hidden className="text-ink-faint/60">
        ·
      </span>

      {hasTokens ? (
        <span
          className="num inline-flex items-center gap-1 rounded-md bg-base-850/90 px-1.5 py-0.5 text-[11px]"
          title={`输入 ${fmtInt(record.promptTokens ?? 0)} tokens · 输出 ${fmtInt(record.completionTokens ?? 0)} tokens`}
        >
          <span className="text-ink-faint">in</span>
          <span className="font-medium text-ink-mid">{fmtInt(record.promptTokens ?? 0)}</span>
          <span className="text-ink-faint/60">/</span>
          <span className="text-ink-faint">out</span>
          <span className="font-medium text-sky-300 [[data-skin='light']_&]:text-sky-700">
            {fmtInt(record.completionTokens ?? 0)}
          </span>
        </span>
      ) : (
        <span className="text-[11px] text-ink-faint">用量未回传</span>
      )}

      {cachePct !== null && (
        <span
          className={cn(
            'num inline-flex cursor-help items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
            cachePct >= 50 ? 'bg-up/10 text-up' : 'bg-warn/12 text-warn',
          )}
          data-aq-tip={
            `输入里有 ${fmtInt(record.cachedTokens ?? 0)} 个 token 命中了上下文缓存` +
            `（占 ${cachePct}%）。\n` +
            '缓存命中的输入价比未命中便宜约 50 倍，所以这个数字直接决定输入成本。'
          }
        >
          缓存 {cachePct}%
        </span>
      )}

      {thinkPct !== null && (
        <span
          className="num inline-flex cursor-help items-center rounded-md bg-violet-500/12 px-1.5 py-0.5 text-[11px] font-medium text-violet-300 [[data-skin='light']_&]:bg-violet-500/10 [[data-skin='light']_&]:text-violet-700"
          data-aq-tip={
            `输出里有 ${fmtInt(record.reasoningTokens ?? 0)} 个 token 花在思考上` +
            `（占 ${thinkPct}%）。\n` +
            '输出价比缓存命中的输入价贵约 200 倍，所以这是本轮成本的主要部分。'
          }
        >
          思考 {thinkPct}%
        </span>
      )}

      {cycleCost && pricing && (
        <span
          className="num inline-flex cursor-help items-center rounded-md border border-amber-400/25 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-300 [[data-skin='light']_&]:border-amber-700/40 [[data-skin='light']_&]:bg-amber-500/15 [[data-skin='light']_&]:text-amber-900"
          data-aq-tip={formatCycleCostTooltip(cycleCost, pricing)}
        >
          {pricing.free ? '免费' : fmtTokenCostUsd(cycleCost.totalCostUsd, { approx: true })}
        </span>
      )}

      {record.aiTtftMs != null && record.aiTtftMs > 0 && (
        <span
          className={cn(
            'num inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
            record.aiTtftMs > 15_000
              ? 'bg-down/12 text-down'
              : "bg-cyan-500/10 text-cyan-300 [[data-skin='light']_&]:bg-cyan-500/10 [[data-skin='light']_&]:text-cyan-700",
          )}
          title={`LLM 首字延迟（TTFT）：${fmtLatency(record.aiTtftMs)}（若本周期内部有多轮调用，则取各轮首字延迟平均值）`}
        >
          首字 {fmtLatency(record.aiTtftMs)}
        </span>
      )}

      {(record.aiLatencyMs > 0 || record.success) && (
        <span
          className={cn(
            'num inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
            latencyTone,
          )}
          title={`本周期全部 LLM 调用累计耗时：${fmtLatency(record.aiLatencyMs)}（含多轮工具交互与执行回执追问）`}
        >
          {fmtLatency(record.aiLatencyMs)}
        </span>
      )}

      {!record.success && (
        record.error?.startsWith('本轮被中断') ? (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-base-800 px-1.5 py-0.5 text-[11px] font-medium text-ink-faint">
            <span aria-hidden>⏸</span>
            <span className="min-w-0 truncate">已中断</span>
          </span>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-down/12 px-1.5 py-0.5 text-[11px] font-medium text-down">
            <TriangleAlert aria-hidden className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">失败{failureCategory(record.error)}</span>
          </span>
        )
      )}
    </div>
  );
}

/**
 * 失败类别：服务端把类别写在错误文案的**第一个全角冒号之前**，冒号之后是给操作员的
 * 具体说明（见 `packages/server/src/trader/autoTrader.ts` 的 `describeCycleFailure()`）。
 *
 * 元数据行只放类别，完整说明留在下面的盒子里 —— 这一行的作用是让人扫一眼就知道
 * "这一轮是哪种失败"，而不是把整段话挤进一行小字。
 *
 * 没有冒号、或者冒号前那一段长得不像类别（老记录、别的写入方）时只显示 `失败`：
 * 截一半的句子比不截更糟。
 */
function failureCategory(error: string | null): string {
  if (!error) return '';
  const head = error.split('：')[0]?.trim() ?? '';
  return head !== '' && head.length <= 12 && !head.includes('\n') ? ` · ${head}` : '';
}

/**
 * 一条决策 = 三行，左对齐在同一条缩进线上。
 *
 * 图标固定 `h-5 w-5`（20px），第二、三行用 `pl-5` 对齐到符号下方 —— 缩进宽度就是
 * 图标宽度，两处改动必须一起改，否则三行会错开。
 *
 * 行 1 用 `flex` 而不是 grid：符号与右侧动作徽章分别 `shrink-0`，中间没有需要
 * 分配的空间，`ml-auto` 就够了。徽章必须 `shrink-0` —— `chip` 自带 `whitespace`
 * 无关的 `font-mono`，一旦被压窄，`开多` 两个字会折成两行、把行高顶起来。
 *
 * 第四段（`outcome`）是**这一条决策的执行结果**：`null` 表示运行时一条记录都没留下。
 * 它由 `planExecution` 从 `executionLog` 里配出来，见上面的说明。
 */
