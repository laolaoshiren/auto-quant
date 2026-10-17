/**
 * **团队模式的一轮** —— 决策滚动区里的一块。
 *
 * ## 与前两种模式的决策块有什么不同（用户原话）
 *
 * > 「**3 决策那边怎么还是像以前一样一定时间一轮的展示**，在我想象中应该是
 * >  固定展示 AI 工作流，一部分**滚动展示最终决策**等关键信息」
 *
 * 他说得对，而差别不只是"排版"：
 *
 * | | 前两种模式（`CycleBlock`） | **团队模式（本组件）** |
 * |---|---|---|
 * | 一轮的元数据 | 相对时间 `│` 周期 `#N` `│` in/out token `│` 缓存 `│` 思考占比 `│` 耗时 | **绝对时刻 + 这一轮的结论一行**（成本明细移到悬停说明里） |
 * | 主视图 | 决策行 + 跳过折叠 | **决策行**（时间/动作/标的/置信度/依据/结果），跳过折叠 |
 * | 详情 | ✨思考过程 `│` 🔒提示词（一个模型的原料） | **风控官结论 → 各角色产出 → 原始材料**（团队的来龙去脉） |
 *
 * ## 为什么元数据行要"减负"
 *
 * 用户对决策区的抱怨是「不直观、不是给人看的」，而前两种模式的元数据行有
 * **六个数字**（token 数、缓存命中率、思考占比、耗时…）。那些是**成本诊断**，
 * 属于"这个机器人在花多少钱"，不属于"它决定了什么"。
 *
 * 团队模式下操作员要一眼看到的是一轮**结论**：它是做多了、做空了、还是空仓。
 * 所以这一行改成 `时刻 │ 周期 #N │ 结论摘要`，六个诊断数字进 `title`
 * （**一个都没丢** —— 丢了就没法排查成本了，见 `AGENTS.md` §3.2 的同一条道理）。
 *
 * ## 为什么不做"周期性"的视觉暗示
 *
 * 用户特别指出「怎么还是像以前一样**一定时间一轮**的展示」。团队模式是
 * **7×24 不间断**（成交后立即唤醒、AI 自己决定下次什么时候看），
 * 所以这里**不显示"下一轮倒计时"**（那在 `DecisionFeed` 的头部已经去掉了），
 * 元数据行也不写"距上一轮 N 分钟" —— 那会把"有人有活就干"说成"到点才干活"。
 */

import { useMemo } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { Decision, DecisionRecord, ExecutionLogEntry } from '@aq/shared';

import type { MarketSymbol } from '../../lib/api';
import { fmtInt, fmtLatency, timeAgo } from '../../lib/format';
/**
 * ⚠️ **`actionLabel` 不能省。**
 *
 * `executionLog[].action` 是**稳定机器码**（`wait` / `get_klines` / `open_long`），
 * 而用户明确抱怨过「**有英文**…感觉不是给人看的」。
 *
 * 实测（2026-10-12）：孤立日志那一行原来直接写 `{entry.action}`，
 * 于是屏幕上出现了一行光秃秃的 `wait` —— 一个没有中文标签、没有上下文、
 * 连"这是动作名"都看不出来的英文单词。
 *
 * `ACTION_LABELS` 是**按 `DecisionAction` 收窄的** `Record`（见 `DecisionAudit.tsx`
 * 的注释），所以将来加动作时漏登记会**编译不过**，而不是静默漏出英文。
 */
import { actionLabel } from '../DecisionAudit';
import { plainText } from '../../lib/plainText';
import { TeamDecisionDetails, TeamDecisionRow } from './TeamDecisionRow';

/**
 * 孤立日志里那个动作码的中文标签。
 *
 * 单独一层小包装是为了**兜底可见**：`actionLabel()` 对未登记的码会原样返回
 * 机器码（那是刻意的 —— 见 `DecisionAudit.tsx` 的说明，排查时要能 grep 到它），
 * 所以这里不吞掉它，只是把统一入口收在一处。
 */
function logActionLabel(action: string): string {
  return actionLabel(action);
}

/* -------------------------------------------------------------------------- */
/*  执行日志 → 决策 的配对                                                      */
/* -------------------------------------------------------------------------- */

/** 配对键。用 `\u0000`：币种符号与动作里都不可能含这个字符。 */
function pairKey(action: string, symbol: string): string {
  return `${action}\u0000${symbol}`;
}

/**
 * 把执行日志配到决策上。
 *
 * ## 为什么必须是"队列"而不是 `find`
 *
 * 策略允许一轮里对**同一个币种**给出多条决策（平多之后立刻开空是很常见的组合），
 * 而 `executionLog` 是一个扁平数组、没有决策下标。用 `find` 会让同符号的两条
 * 决策**都拿到同一条日志** —— 于是一次"被拒"被显示给两条决策，等于凭空多出
 * 一次拒绝。队列的规则是"**先提出的先配上**"，与服务端的推送顺序一致
 * （`rejected` 按 `sortDecisions()`、执行按 `verdict.approved`）。
 *
 * 配不上的决策拿到 `null`（界面会明说"未进入执行"），配不上的日志进 `leftover`
 * （界面照旧列出来，一条都不丢）。
 */
function pairOutcomes(
  log: readonly ExecutionLogEntry[],
  decisions: readonly Decision[],
): { outcomes: Array<ExecutionLogEntry | null>; leftover: ExecutionLogEntry[] } {
  const queue = new Map<string, number[]>();
  log.forEach((entry, index) => {
    const key = pairKey(entry.action, entry.symbol);
    const bucket = queue.get(key);
    if (bucket) bucket.push(index);
    else queue.set(key, [index]);
  });

  const claimed = new Set<number>();
  const outcomes = decisions.map((decision) => {
    const index = queue.get(pairKey(decision.action, decision.symbol))?.shift();
    if (index === undefined) return null;
    claimed.add(index);
    return log[index] ?? null;
  });

  return { outcomes, leftover: log.filter((_, index) => !claimed.has(index)) };
}

/* -------------------------------------------------------------------------- */
/*  一轮                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 团队模式的一轮。
 *
 * @param record 这一轮的落库记录
 * @param symbols 行情（提供当前价，用来算"离止损多远 / 盈亏比"）
 */
export function TeamCycleBlock({
  record,
  symbols,
}: {
  record: DecisionRecord;
  symbols: readonly MarketSymbol[];
}): React.ReactElement {
  /*
   * ⚠️ **两个数组都要 `useMemo` 兜底，不能直接写 `record.decisions ?? []`。**
   *
   * `?? []` 在字段缺失时**每次渲染都造一个新数组**，而它们又是下面几个
   * `useMemo` 的依赖 —— 引用每次都变，那几个 memo 于是等于没有（每渲染一次重算一次）。
   * 这条是 `react-hooks/exhaustive-deps` 报出来的，它是对的：
   * 依赖不稳定的 memo 不是优化，是**假装优化**。
   *
   * 顺带这也是**旧记录的兜底**：决策记录跨版本累积，
   * `decisions` / `executionLog` 可能缺字段（实测库里有），
   * 直接读 `.length` 会抛错并让 `FeedErrorBoundary` 把整块看板换成错误卡。
   */
  const decisions = useMemo(() => record.decisions ?? [], [record.decisions]);
  const log = useMemo(() => record.executionLog ?? [], [record.executionLog]);
  const { outcomes, leftover } = useMemo(() => pairOutcomes(log, decisions), [log, decisions]);

  /*
   * ⚠️ **`record.error` 也要按"有值"判，不能写 `!== null`。**
   *
   * 类型上是 `string | null`，但记录跨版本累积、运行时可能是 `undefined`。
   * `undefined !== null` 为真 → 界面会挂上「本轮失败」并把 `undefined` 渲染成空白 ——
   * **一次成功的轮次被标成失败**，而原因那栏什么都没有。
   * 这是最难查的一种：症状是"失败了但没说为什么"。
   */
  const errorText = typeof record.error === 'string' && record.error.length > 0 ? record.error : null;

  /* 跳过的那批（模型对候选池里没动的标的留的记录）—— 折叠，标题里给最高分。 */
  const actionable = decisions
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decision.action !== 'skip');
  const skipped = decisions
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decision.action === 'skip');
  const topSkippedScore = skipped.reduce<number | null>(
    (best, { decision }) =>
      typeof decision.setupScore === 'number' && (best === null || decision.setupScore > best)
        ? decision.setupScore
        : best,
    null,
  );

  const rejected = log.filter((e) => e.status === 'rejected').length;
  const failed = log.filter((e) => e.status === 'failed').length;
  const skippedExec = log.filter((e) => e.status === 'skipped').length;

  const priceOf = (symbol: string): number | null =>
    symbols.find((row) => row.symbol === symbol)?.price ?? null;

  /* ── 结论摘要：这一轮到底做了什么 ───────────────────────────────────── */
  const conclusion = useMemo(() => {
    if (errorText !== null) return '失败';
    if (decisions.length === 0 && log.length === 0) return '空仓（模型没有给出任何决策）';
    const opens = actionable.filter(({ decision }) => decision.action.startsWith('open_')).length;
    const closes = actionable.filter(({ decision }) => decision.action.startsWith('close_')).length;
    const parts: string[] = [];
    if (opens > 0) parts.push(`开仓 ${opens}`);
    if (closes > 0) parts.push(`平仓 ${closes}`);
    if (parts.length === 0) parts.push(actionable.length > 0 ? '持有 / 等待' : '未行动');
    if (skipped.length > 0) parts.push(`看过未做 ${skipped.length}`);
    return parts.join(' · ');
  }, [errorText, decisions.length, log.length, actionable, skipped.length]);

  /*
   * 六个成本诊断值进 `title`。
   *
   * ⚠️ **一个都不删**：它们是"这一轮花了多少钱、等了多少"的唯一出处，
   * 排查成本问题时要读。只是它们不该占着主视图的第一行 ——
   * 那一行属于"它决定了什么"。
   */
  const diagnostics = [
    `用量 in ${fmtInt(record.promptTokens ?? 0)} · out ${fmtInt(record.completionTokens ?? 0)}`,
    ...(record.cachedTokens != null && record.promptTokens != null && record.promptTokens > 0
      ? [`缓存命中 ${Math.round((record.cachedTokens / record.promptTokens) * 100)}%`]
      : []),
    ...(record.reasoningTokens != null && record.completionTokens != null && record.completionTokens > 0
      ? [`思考占输出 ${Math.round((record.reasoningTokens / record.completionTokens) * 100)}%`]
      : []),
    `模型耗时 ${fmtLatency(record.aiLatencyMs)}`,
    `完整时刻 ${record.timestamp}`,
  ].join('\n');

  return (
    <article className="min-w-0" data-record-id={record.id}>
      {/* ① 元数据行：时刻 │ 周期 │ 结论 —— 三个数，都是"人话" */}
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-xs text-ink-lo">
        <span title={diagnostics} className="cursor-help">
          {timeAgo(record.timestamp)}
        </span>
        <span aria-hidden className="text-ink-faint">
          │
        </span>
        <span className="num">周期 #{record.cycleNumber}</span>
        <span aria-hidden className="text-ink-faint">
          │
        </span>
        <span className={errorText !== null ? 'font-medium text-down' : 'text-ink-mid'}>结论：{conclusion}</span>

        {/*
          失败与风控拒绝**必须在元数据行就能看见**（`AGENTS.md` §2.7 / `LAYOUT.md` §7：
          界面不能对"发生了什么"说谎）。用一行小字，不做徽章行 —— 徽章行会
          把每一轮都染成彩色的，于是真正出事的那一轮反而看不出来。
        */}
        {errorText !== null && (
          <span className="flex min-w-0 items-center gap-1 font-medium text-down">
            <TriangleAlert aria-hidden className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">本轮失败</span>
          </span>
        )}
        {rejected > 0 && <span className="text-warn">{rejected} 条被风控拒绝</span>}
        {failed > 0 && <span className="text-down">{failed} 条执行失败</span>}
        {skippedExec > 0 && <span className="text-ink-faint">{skippedExec} 条未执行</span>}
      </div>

      {/* ② 盒子：一轮只有这一层边框 */}
      <div className="min-w-0 rounded-lg border border-base-700 bg-base-850 px-3 py-2.5">
        {errorText !== null && (
          <p className="mb-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-down">
            <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{plainText(errorText)}</span>
          </p>
        )}

        {/*
          「没有决策」要说清是哪一种没有：模型真的没给，还是**一轮执行了动作
          但模型没说话**（回撤守卫平仓）。把后者说成"模型没有给出任何决策"
          是把一次执行说成了模型的沉默。
        */}
        {errorText === null && decisions.length === 0 && log.length === 0 && (
          <p className="text-xs text-ink-faint">
            本轮团队没有给出任何决策 —— 展开下面的「本轮过程」看各岗位这一轮做了什么。
          </p>
        )}

        {/*
          ══════════════════════════════════════════════════════════════════════
           **轮次级「本轮过程」**（2026-10-17 · 台账 UI-03）
          ══════════════════════════════════════════════════════════════════════

          用户实测抓到的形状（t3 用真实浏览器量到）：
          ```
            失败轮（周期 #102）：这个卡片 buttons = []（一个按钮都没有）
            而同一记录 raw_response 里有 <team> 与 4 条角色产出（2 条是失败原因）
          ```
          **根因**：那个「展开详情」按钮挂在**决策行**上（`TeamDecisionRow` 里），
          而失败轮**一条决策都没有** —— 于是团队模式最需要排查的那一轮，
          界面上一片空白，只有一句"团队轮次失败：…"。

          **修法**：把同一段渲染提到**轮次**这一级。数据本来就在 `rawResponse` 里
          （`<team>` / `<risk>` 块），**不加列、不迁移**。
          `TeamDecisionDetails` 自己没有可展内容时会返回 `null`（不渲染死按钮），
          所以这里无条件挂上也不会出现"点开是空的"那种按钮。
        */}
        {actionable.length === 0 && skipped.length === 0 && (
          <TeamDecisionDetails record={record} outcome={leftover[0] ?? null} />
        )}

        {actionable.length > 0 && (
          <div className="space-y-2">
            {actionable.map(({ decision, index }) => (
              <TeamDecisionRow
                key={`${decision.symbol}-${decision.action}-${index}`}
                decision={decision}
                outcome={outcomes[index] ?? null}
                record={record}
                price={priceOf(decision.symbol)}
              />
            ))}
          </div>
        )}

        {/*
          跳过的那批用原生 `<details>`：**不需要任何状态**。
          折叠而不是删掉 —— 那十几条里有 `setup_score`，而"我把哪些标的打了几分"
          正是操作员核对模型判断时的原始材料。符号直接列在摘要行里：
          用户明确说过「不要让我点开才知道它看了哪些币」。
        */}
        {skipped.length > 0 && (
          <details className="mt-2 rounded-md border border-base-800 px-2.5 py-1.5">
            <summary className="cursor-pointer select-none text-xs text-ink-faint">
              另有 {skipped.length} 个标的看过未做
              {topSkippedScore !== null ? `（最高 ${topSkippedScore} 分）` : ''}：
              <span className="text-ink-mid">
                {skipped
                  .slice(0, 8)
                  .map(({ decision }) => decision.symbol)
                  .join('、')}
                {skipped.length > 8 ? ` 等 ${skipped.length} 个` : ''}
              </span>{' '}
              —— 展开可见各自评分与理由
            </summary>
            <div className="mt-2 space-y-2">
              {skipped.map(({ decision, index }) => (
                <TeamDecisionRow
                  key={`skip-${decision.symbol}-${index}`}
                  decision={decision}
                  outcome={outcomes[index] ?? null}
                  record={record}
                  price={priceOf(decision.symbol)}
                />
              ))}
            </div>
          </details>
        )}

        {/*
          配不上任何决策的日志。正常路径为空（每条日志都是从决策列表里长出来的），
          但"配不上"这件事不能因此丢掉 —— 老记录、被截断的记录都会留下孤立条目，
          而那正是最需要被看见的一类。
        */}
        {leftover.length > 0 && (
          <ul className="mt-2 space-y-1 border-t border-base-800 pt-2">
            {leftover.map((entry, index) => (
              <li key={`leftover-${index}`} className="flex min-w-0 items-start gap-1.5 text-xs">
                <span className="shrink-0 text-ink-lo">{logActionLabel(entry.action)}</span>
                <span className="num shrink-0 text-ink-mid">{entry.symbol}</span>
                <span className="min-w-0 break-words text-ink-lo">{plainText(entry.detail ?? '')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
