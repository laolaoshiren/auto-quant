/**
 * **团队模式的关键决策行** —— 决策滚动区里的一条。
 *
 * ## 用户的要求（2026-10-12，这是本组件存在的理由）
 *
 * > 「**3 决策那边怎么还是像以前一样一定时间一轮的展示**，在我想象中应该是
 * >  固定展示 AI 工作流，一部分**滚动展示最终决策**等关键信息」
 *
 * > 「还有为什么还原封不动保留了 **思考过程、提示词查看功能**（这模式不是团队了吗？
 * >  …应该是上面固定展示各智能体工作状态和摘要，**用户有需要可以手动点击打开查看详情**）」
 *
 * ## 折叠态就是"关键信息"，一个都不缺
 *
 * `时间 · 动作 · 标的 · 置信度 · 依据摘要 · 执行结果` —— 六样**同屏**。
 * 用户原话是「滚动展示最终决策**等关键信息**」，所以这一行不能再要求点开才看懂。
 *
 * ## 展开态是"这一条是怎么来的"，而不是"模型的思维链"
 *
 * 这是与前两种模式**最本质的差别**：
 *
 * | | 前两种模式 | **团队模式** |
 * |---|---|---|
 * | 点开看什么 | ✨思考过程（一个模型的 `<reasoning>`）<br>🔒提示词 | **谁参与了、各自说了什么、用的什么模型**<br>风控官的结论 → 然后才是原料 |
 *
 * 理由：团队模式下"这一条怎么来的"的答案是**分工与辩论**，不是某一次调用的
 * 思维链。原始原料（思维链 / 提示词 / 原始响应）当然要保留可查 ——
 * 它们是排查用的东西 —— 但**降到最后一级**，不与"谁说了什么"并列。
 *
 * ## 为什么原料是**懒加载**的
 *
 * 服务端列表接口为了不让一页 2.7 MB 的提示词卡死浏览器，把 `systemPrompt` /
 * `userPrompt` 剥成了空串（见 `/api/traders/:id/decisions` 的注释）。
 * 所以"点开才去取单条详情"本来就是正确且必要的姿势 —— 不点就一个字节都不传。
 */

import { useEffect, useState } from 'react';
import {
  Ban,
  Check,
  ChevronRight,
  FileText,
  LoaderCircle,
  Lock,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { Decision, DecisionRecord, ExecutionLogEntry } from '@aq/shared';

import { api } from '../../lib/api';
import { fmtPriceUsd, fmtUsd, timeAgo } from '../../lib/format';
import { ActionBadge, statusLabel } from '../DecisionAudit';
import { parseTeamTrace, type TeamMemberOutput } from '../../lib/teamTrace';
import { plainText } from '../../lib/plainText';
import { INK, SURFACE } from './roster';

/* -------------------------------------------------------------------------- */
/*  执行结果                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 执行结果的标记 —— **四种状态各自可辨**，且都不是"失败"。
 *
 * 与决策流主组件里那张表口径一致（`STATUS_LABELS` 是同一份中文名），
 * 但图标刻意分开：`rejected`（风控裁决）与 `failed`（事故）是两件事，
 * 混用一个感叹号等于把它们合并回去。
 */
function outcomeStyle(status: ExecutionLogEntry['status']): {
  label: string;
  cls: string;
  Icon: typeof Check;
} {
  switch (status) {
    case 'ok':
      return { label: `✓ ${statusLabel(status)}`, cls: 'text-up', Icon: Check };
    case 'submitted':
      return { label: `⧗ ${statusLabel(status)}（等成交）`, cls: 'text-ink-lo', Icon: LoaderCircle };
    case 'rejected':
      return { label: '⚠ 被风控拒绝', cls: 'text-warn', Icon: TriangleAlert };
    case 'failed':
      return { label: '✕ 执行失败', cls: 'text-down', Icon: X };
    case 'skipped':
      return { label: `⊘ 未执行（${statusLabel(status)}）`, cls: 'text-ink-lo', Icon: Ban };
    case 'data':
      return { label: `⇣ ${statusLabel(status)}`, cls: 'text-ink-lo', Icon: FileText };
    default: {
      /* 穷尽性检查：`status` 只能是上面六种。少写一种这里会编译报错。 */
      const exhaustive: never = status;
      return { label: String(exhaustive), cls: 'text-ink-lo', Icon: FileText };
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  角色中文名                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 角色 id → 中文名。
 *
 * ⚠️ **必须有一份兜底，而且兜底不能吞掉信息**：后端将来加了角色、这张表还没跟上时，
 * 界面上要能看出"这是个还没登记的角色"（显示 id + 提示），**绝不能显示成空白**
 * （那会让操作员以为"这一轮没人说话"）。
 *
 * ## ⚠️ 这张表**必须覆盖 `FIRM_ROLES` 的每一个 id**（2026-10-17，t52 的 B3）
 *
 * t52 的清单本来建议把它收紧成 `Record<FirmRole['id'], string>` 让 typecheck 兜住 ——
 * **但 `FirmRole.id` 的类型是 `string`，不是字面量联合**（`firm.ts` 的接口定义），
 * 所以那个写法**没有任何收紧效果**（`Record<string, string>` 与之等价）。
 * 收紧 id 的类型属 `shared/firm.ts`，超出本任务范围。
 *
 * 于是改用**测试**承担同一件事（`roleLabels.test.ts`）：遍历 `FIRM_ROLES`，
 * 断言每个 id 都在这里登记过。后端加角色而这里漏登记 → **测试变红**。
 *
 * ## 实测：`symbol_scout` 曾经就是漏的那个
 *
 * 它是 `firm.ts` 里 `status: 'staffed'` 的正式岗位（2026-10-14 接线，
 * `AQ_PER_SYMBOL=on` 时按币并行），**但这张表里没有它** ——
 * 于是它一产出，成员行就渲染成
 * `symbol_scout（界面未登记这个角色）`：屏幕上出现一串英文 id，
 * 而它其实是"标的侦查员"。用户报的「出现英文字符」正是这一个形状。
 */
/*
 * 角色名表已**搬到** `./roleLabels.ts`（2026-10-17 · t108）。
 *
 * 因为 `roster.ts` 也要用它（看板编制表 **+ 编制表之外的兜底行**），
 * 而本文件已经 import 了 `roster`（要 `INK` / `SURFACE`）——
 * 反向 import 会成**循环依赖**。抽成独立模块后两个使用方都从那里拿，
 * 「角色名只有一份」这件事就在文件层面成立了。
 *
 * 这里保留同名导出，是为了让既有调用点与测试（`roleLabels.test.ts`）一个字都不用改。
 *
 * ⚠️ `import` 与 `export` **两行都要写**：`export { x } from '...'` 只把名字**转发出去**，
 * **不会**把它带进本文件的作用域 —— 只写那一行，下面 `MemberLine` 里的 `roleLabel()`
 * 会直接 `TS2304: Cannot find name`（我第一次就只写了一行，typecheck 当场抓到）。
 */
import { registeredRoleIds, roleLabel } from './roleLabels';

export { registeredRoleIds, roleLabel };

/**
 * 取一个**真的有值**的数值，否则 `null`。
 *
 * ## ⚠️ 为什么不能写 `x !== null`（2026-10-12 实测抓到的真 BUG）
 *
 * `Decision` 的字段在**类型上**是 `number | null`，但决策记录是**跨版本累积**的、
 * 而且是从模型输出解析来的 —— 运行时完全可能是 `undefined`
 *（老记录缺字段、模型没给那个键）。
 *
 * `undefined !== null` 是 **`true`**，于是判据放行、渲染一个 `undefined`：
 * 屏幕上出现的是 `置信度 %`（数字没了、百分号还在）、
 * `名义 —`、`止损 —` —— 而它们看起来像"这个数据是空的"，
 * 掩盖了真正的真相"**这个字段根本不存在**"。
 *
 * 同一个 bug 在 `DecisionFeed.tsx` 的 `num()` 里也犯过，本仓库已经修过一次。
 * 这里用 `typeof` + `Number.isFinite` 一并挡掉 `null` / `undefined` / `NaN`
 * （`NaN` 同样会让 `fmtUsd` 输出 `—`，而 `—` 会被读成"没有这个数据"）。
 */
function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/* -------------------------------------------------------------------------- */
/*  决策行                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 一条团队决策（折叠态一行，展开态一块）。
 *
 * @param decision 这一条决策
 * @param outcome 它在运行时的执行记录（`null` = 没走到执行阶段）
 * @param record 它所属的那一轮（展开"各角色产出/原料"时要读 `rawResponse`）
 */
export function TeamDecisionRow({
  decision,
  outcome,
  record,
  price,
}: {
  decision: Decision;
  outcome: ExecutionLogEntry | null;
  record: DecisionRecord;
  /** 当前价（用来把"止损 74434.8"变成"离现价多远"）。拿不到就是 `null`。 */
  price: number | null;
}): React.ReactElement {
  return (
    <div className={`rounded-md border ${SURFACE.borderSoft} ${SURFACE.raised} px-2.5 py-2`}>
      {/* ① 关键信息行：时间 · 动作 · 标的 · 置信度 · 结果 */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ActionBadge action={decision.action} className="shrink-0" />
        <span className="num min-w-0 truncate text-base font-semibold text-ink-hi">{decision.symbol}</span>

        {/*
          置信度。**模型没给时显示"未给出"，不显示 0%** —— 0 分与"没给"是两件事，
          显示成同一个数就是在说谎（这个坑本项目踩过：模型漏了 `confidence` 字段，
          屏幕上每个标的都写着"置信度: 0%"，看起来像它对每个判断都毫无把握）。
        */}
        <span className="text-xs text-ink-lo">
          置信度{' '}
          {numOrNull(decision.confidence) === null ? (
            <span className="text-ink-faint" title="模型这一条决策里没有给出 confidence 字段。">
              未给出
            </span>
          ) : (
            <span className="num text-accent">{numOrNull(decision.confidence)}%</span>
          )}
        </span>

        {outcome !== null ? (
          <OutcomeChip status={outcome.status} detail={outcome.detail} notionalUsd={outcome.notionalUsd} />
        ) : (
          <span
            className="text-xs text-ink-faint"
            title="这一条决策没有进入执行阶段 —— 它在解析或风控之前就被丢掉了，或者记录不完整。"
          >
            未进入执行
          </span>
        )}

        <span className="num ml-auto shrink-0 text-xs tabular-nums text-ink-faint" title={record.timestamp}>
          {timeAgo(record.timestamp)}
        </span>
      </div>

      {/* ② 依据摘要 —— 允许折行，**不给它设固定列宽**（历史上有三轮溢出 bug 都源于此） */}
      {decision.reasoning && (
        <p className="mt-1 min-w-0 break-words text-xs leading-relaxed text-ink-mid">
          {plainText(decision.reasoning)}
        </p>
      )}

      {/* ③ 关键价位（只在实际开仓/调仓时才有）*/}
      <KeyFigures decision={decision} price={price} />

      {/*
        ④ 风控干预**始终可见**，不跟着"详情"折起来。
        `AGENTS.md` §2.1：每一次运行时推翻模型都要留下痕迹 —— 那是这个产品
        可被信任的前提，一眼扫过时它必须在场。
      */}
      <Adjustments notes={outcome?.adjustments?.length ? outcome.adjustments : (decision.adjustments ?? [])} />

      {/* ⑤ 详情：默认收起，点开才看"这一条是怎么来的" */}
      <TeamDecisionDetails record={record} outcome={outcome} />
    </div>
  );
}

/** 执行结果的紧凑标记。 */
function OutcomeChip({
  status,
  detail,
  notionalUsd,
}: {
  status: ExecutionLogEntry['status'];
  detail: string | null;
  notionalUsd?: number;
}): React.ReactElement {
  const { label, cls, Icon } = outcomeStyle(status);
  /*
   * 第一句放在标记旁边（它是"为什么"的答案），其余收进 `title`。
   * 服务端写的这些句子本身就以中文句号断句（`单日亏损熔断：…（上限 5%）。`）。
   *
   * ⚠️ 末尾是 `plainText` 而不是裸 `detail`：这里显示的正是 `parser.ts` 写的拒单理由
   *（`它**没有被执行**，但也不是"模型没给"`）—— 不剥的话用户会看到 `**`。
   * 在**取值这一步**剥，`lead` 与 `title` 就都干净了（只此一处，不必改两遍）。
   */
  const text = plainText(detail ?? '');
  const cut = text.search(/[。；]/);
  const lead = cut >= 0 ? text.slice(0, cut + 1) : text;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs" title={text}>
      <span className={`flex shrink-0 items-center gap-1 font-medium ${cls}`}>
        <Icon aria-hidden className="h-3 w-3 shrink-0" />
        {label}
      </span>
      {notionalUsd !== undefined && (
        <span className="num shrink-0 text-ink-lo" title="名义价值（USDT）">
          {fmtUsd(notionalUsd, 2)}
        </span>
      )}
      {lead && lead !== label && <span className="min-w-0 break-words text-ink-lo">{lead}</span>}
    </span>
  );
}

/** 风控干预（每次推翻模型都留痕，见 `AGENTS.md` §2.1）。 */
function Adjustments({ notes }: { notes: readonly string[] }): React.ReactElement | null {
  if (notes.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {notes.map((note, index) => (
        <li key={index} className="break-words text-xs leading-relaxed text-warn">
          • {plainText(note)}
        </li>
      ))}
    </ul>
  );
}

/**
 * 关键价位。
 *
 * ## ⚠️ 为什么是一行会折行的小字，而不是表格
 *
 * 这里原来是 6 格 grid，连续三轮出溢出 bug：grid 的列有最小内容宽度，
 * 而决策区在右栏里只有约 40% 宽，一个 `0.176800` 加一个 `+26.67%` 就能撑破格子、
 * 把文字挤进相邻列。**一行文本没有最小宽度，横向永不溢出。**
 * 这条教训在 `DecisionFeed.tsx` 的 `figureParts` 上写了很长的注释，不要退回去。
 */
function KeyFigures({ decision, price }: { decision: Decision; price: number | null }): React.ReactElement | null {
  const parts: Array<{ label: string; value: string; title: string }> = [];
  const isOpen = decision.action.startsWith('open_');

  /*
   * ⚠️ **全部经 `numOrNull` 收口**（2026-10-12 实测抓到的真 BUG）。
   *
   * 这里原来写的是 `decision.stopLoss !== null`。而运行时 `stopLoss` 可能是
   * **`undefined`**（老记录缺字段 / 模型没给那个键），`undefined !== null` 为真 ——
   * 于是判据放行，`fmtPriceUsd(undefined)` 渲染出一个 `—`。
   *
   * **屏幕上的后果是**：`名义 — · 现价 83,554.90 · 止损 — · 止盈 —`
   * 看起来像"这一单没有设止损止盈"，而真相是"这几个字段根本不存在"。
   * 对一个会动用真金的系统来说，这两种情况**必须可区分**。
   */
  const size = numOrNull(decision.positionSizeUsd);
  const stop = numOrNull(decision.stopLoss);
  const target = numOrNull(decision.takeProfit);
  const leverage = numOrNull(decision.leverage);
  const livePrice = numOrNull(price);

  if (isOpen) {
    if (size !== null) parts.push({ label: '名义', value: fmtUsd(size, 2), title: '名义价值（USDT）' });
    if (livePrice !== null) parts.push({ label: '现价', value: fmtPriceUsd(livePrice), title: '当前价格' });
    if (stop !== null) parts.push({ label: '止损', value: fmtPriceUsd(stop), title: '止损价' });
    if (target !== null) parts.push({ label: '止盈', value: fmtPriceUsd(target), title: '止盈价' });
    if (livePrice !== null && stop !== null && target !== null) {
      /* `Math.abs` 两侧：做空时价格在止损之上、止盈之下，直接相减会得到负的盈亏比。 */
      const risk = Math.abs(livePrice - stop);
      const reward = Math.abs(target - livePrice);
      if (risk > 0) parts.push({ label: '盈亏比', value: `1:${(reward / risk).toFixed(2)}`, title: '到止盈的距离 ÷ 到止损的距离' });
    }
    if (leverage !== null && leverage > 0) parts.push({ label: '杠杆', value: `${leverage}x`, title: '杠杆倍数' });
  } else if (decision.action === 'adjust_protection') {
    if (stop !== null) parts.push({ label: '止损 →', value: fmtPriceUsd(stop), title: '调整后的止损价' });
    if (target !== null) parts.push({ label: '止盈 →', value: fmtPriceUsd(target), title: '调整后的止盈价' });
  } else if (decision.action === 'reduce_position') {
    const percent = numOrNull(decision.reducePercent);
    const quantity = numOrNull(decision.reduceQuantity);
    if (percent !== null) {
      /* ⚠️ `reducePercent` 是**百分数**（服务端 `/100` 才是比例）—— 不要再除 100。 */
      parts.push({ label: '减仓', value: `${percent.toFixed(1)}%`, title: '按持仓数量计的百分比' });
    } else if (quantity !== null) {
      parts.push({ label: '减仓', value: String(quantity), title: '要卖出的数量' });
    }
  } else if (decision.action === 'add_to_position') {
    if (size !== null) parts.push({ label: '加仓', value: fmtUsd(size, 2), title: '再投入的金额（USDT）' });
  }

  if (parts.length === 0) return null;
  return (
    <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs leading-relaxed text-ink-lo">
      {parts.map((part, index) => (
        <span key={`${part.label}-${index}`} className="flex items-baseline gap-1" title={part.title}>
          <span className="text-ink-faint">{part.label}</span>
          <span className="num break-all">{part.value}</span>
        </span>
      ))}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/*  详情（默认收起）                                                           */
/* -------------------------------------------------------------------------- */

type RawTab = 'cot' | 'prompt' | 'raw';

/**
 * 「这一条是怎么来的」—— 默认收起。
 *
 * 展开后的**顺序**是刻意的，也是团队模式与前两种模式的分界：
 *
 *   1. **风控官结论**（裁决之后唯一有权否决的角色）
 *   2. **各角色产出**（按谁说了什么，带模型名）
 *   3. **原始原料**（思考过程 / 提示词 / 原始响应）—— 最后的、排查用的
 *
 * 前两项来自 `rawResponse` 里本来就有的 `<team>` / `<risk>` 块，
 * **不需要给数据库加列**（迁移要动挂着实盘的 `traders` 表，风险不值得）。
 *
 * ⚠️ 2026-10-17：**它被导出给 `TeamCycleBlock` 用**（台账 UI-03）。
 * 本轮**没有任何决策**时（典型的失败轮：`record.error !== null`），
 * 界面上原来一个"展开详情"按钮都没有 —— 因为那个按钮挂在**决策行**上。
 * 于是团队模式最需要排查的那一轮，恰恰看不到各角色产出。
 */
export function TeamDecisionDetails({
  record,
  outcome,
}: {
  record: DecisionRecord;
  outcome: ExecutionLogEntry | null;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<RawTab>('cot');

  const trace = parseTeamTrace(record.rawResponse);
  const risk = extractRiskBlock(record.rawResponse);

  /*
   * 有没有可展开的东西？
   *
   * 什么都没有时**不渲染这个开关** —— 一个点开是空的"详情"比没有更让人困惑
   * （同一个教训见 `DecisionFeed` 里那两个死按钮的注释）。
   */
  const hasAnything =
    trace !== null ||
    risk !== null ||
    record.cotTrace.trim() !== '' ||
    record.systemPrompt.trim() !== '' ||
    record.userPrompt.trim() !== '' ||
    record.rawResponse.trim() !== '' ||
    (outcome?.detail ?? '').length > 0;
  if (!hasAnything) return null;

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? '收起这一条的来龙去脉' : '展开：风控官结论、各角色产出、以及原始材料'}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-ink-lo transition hover:bg-base-800 hover:text-ink-hi"
      >
        <ChevronRight
          aria-hidden
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {open ? '收起详情' : '展开详情'}
        {trace !== null && (
          <span className="text-ink-faint">（{trace.members.length} 个角色有产出）</span>
        )}
      </button>

      {open && (
        <div className="mt-1.5 space-y-2 border-t border-base-800 pt-2">
          {/* ── ① 风控官结论 ─────────────────────────────────────────── */}
          {risk !== null && (
            <section>
              <h4 className="mb-1 text-xs font-semibold text-warn">风控官结论</h4>
              <p
                className={`whitespace-pre-wrap break-words rounded border ${SURFACE.borderSoft} ${SURFACE.sunken} px-2 py-1.5 text-xs leading-relaxed ${
                  risk.approved ? 'text-ink-mid' : 'text-down'
                }`}
              >
                {/*
                  ⚠️ **数据里的 markdown 强调符必须在这里剥掉**（台账 UI-08 的"正文"那一半）。
                  这段文字来自**服务端写进 `raw_response` 的 `<risk>` 块**，而
                  `deskOutput.ts` 的模板里本来就有 `**`（例如「本轮**未经风控官审阅**」）——
                  界面是纯文本、不是 markdown 渲染器。实测（t47 浏览器取证）：
                  不剥的话这一块原样显示星号。
                  `plainText` 是**数据侧**的统一出口（我们自己写的字面量由
                  `lib/markdownLiteral.test.ts` 守着，两道各管一半）。
                */}
                {plainText(risk.text)}
              </p>
            </section>
          )}

          {/* ── ② 各角色产出 ─────────────────────────────────────────── */}
          {trace !== null && trace.members.length > 0 && (
            <section>
              <h4 className="mb-1 text-xs font-semibold text-ink-mid">
                各角色产出
                {trace.summary !== null && <span className="ml-1 font-normal text-ink-faint">· {trace.summary}</span>}
              </h4>
              <ul className="space-y-1.5">
                {trace.members.map((m) => (
                  <MemberLine key={`${m.role}-${m.text.slice(0, 12)}`} member={m} />
                ))}
              </ul>
            </section>
          )}

          {/* ── ③ 原始材料（最后的、排查用的）─────────────────────────── */}
          <section>
            <h4 className="mb-1 text-xs font-semibold text-ink-lo">
              原始材料
              <span className="ml-1 font-normal text-ink-faint">—— 排查用；主视图不看这些</span>
            </h4>
            <div className="flex flex-wrap items-center gap-1">
              <RawTabButton icon={<Sparkles aria-hidden className="h-3 w-3" />} label="思考过程" active={tab === 'cot'} onClick={() => setTab('cot')} />
              <RawTabButton icon={<Lock aria-hidden className="h-3 w-3" />} label="提示词" active={tab === 'prompt'} onClick={() => setTab('prompt')} />
              {/*
                ⚠️ **这一格不叫「原始响应」**（2026-10-17 · 用户实测）。
                它渲染的是 `deskOutput.ts` 在后端拼好的 `<decision>/<risk>/<team>` 三块，
                **不是模型的原始输出**。叫"原始响应"是把"我们的渲染结果"说成"模型的话"。
                改成如实的名字，并把内容按块拆开（见 `splitRawResponse`）。
              */}
              <RawTabButton
                icon={<FileText aria-hidden className="h-3 w-3" />}
                label="服务端拼出的完整响应"
                active={tab === 'raw'}
                onClick={() => setTab('raw')}
              />
            </div>
            <div className="mt-1.5">
              {tab === 'cot' && <LazyPre title="思考过程" field="cot" record={record} empty="这一轮没有留下思维链。" />}
              {tab === 'prompt' && (
                <div className="space-y-1.5">
                  <LazyPre title="系统提示词" field="system" record={record} empty="（空）" />
                  <LazyPre title="用户提示词" field="user" record={record} empty="（空）" />
                </div>
              )}
              {tab === 'raw' && <ReadableResponse rawResponse={record.rawResponse} />}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * **一个角色的产出**（2026-10-14 加「展开全文」）。
 *
 * ## 为什么需要折叠
 *
 * 用户第三次反馈（同一处）：
 * > 「展开后只有 300 字，看不清它在想什么」
 *
 * 而**前端拿不到更长的版本** —— `teamTrace.ts` 解析的是后端 `deskOutput`
 * 写进 `rawResponse` 的内容。所以修法分两步：
 * ```
 *   后端：截断上限 300 → 2,000（数据里真的有全文）
 *   前端：默认只显示前 300 字 + 「展开全文」（版面不被长文挤爆）
 * ```
 *
 * ⚠️ **后端截断时会留痕**（`…（已截断，完整 N 字）`）—— 所以这里不需要
 * 自己判断"有没有更多"，直接看文本里有没有那个标记即可。
 * 若数据本身就只有 300 字（没留痕），就**不渲染按钮** ——
 * 一个点开没有变化的按钮比没有按钮更让人困惑（本项目已有先例）。
 */
function MemberLine({ member }: { member: TeamMemberOutput }): React.ReactElement {
  const label = roleLabel(member.role);
  const [open, setOpen] = useState(false);

  /*
   * 后端留痕的形态：`…（已截断，完整 1234 字）`
   * ⚠️ 用 `includes` 而不是正则：那个标记是固定文案，正则只会更难读。
   */
  const TRUNCATED = '…（已截断，完整 ';
  const truncated = member.text.includes(TRUNCATED);
  /* 折叠时显示到留痕处之前（去掉那半句），展开时显示全文。 */
  const preview = truncated ? `${member.text.slice(0, member.text.indexOf(TRUNCATED))}…` : member.text;
  const body = open || !truncated ? member.text : preview;

  return (
    <li className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={`text-xs font-semibold ${INK.hi}`}>
          {label ?? `${member.role}（界面未登记这个角色）`}
        </span>
        {member.modelId !== null && member.modelId.length > 0 && (
          /* 模型名是技术标识符，保留原样（`AGENTS.md` §5.2）。 */
          <span className="num min-w-0 truncate text-[11px] text-ink-faint" title={`这个角色用的模型：${member.modelId}`}>
            {member.modelId}
          </span>
        )}
        {truncated && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="shrink-0 rounded px-1 text-[11px] text-ink-lo transition hover:bg-base-800 hover:text-ink-hi"
          >
            {open ? '收起' : '展开全文'}
          </button>
        )}
      </div>
      {/*
        ⚠️ **角色产出是"数据"，里面会有 markdown 强调符** —— 必须过 `plainText`
        （台账 UI-08 的"正文"那一半；t3 实测这些星号原样显示在屏幕上）。

        `preview` / `body` 是**摘要与全文的取舍**（那部分由 `memberSummary` 与
        这里的留痕判据负责），而 `plainText` 只做一件事：把不属于纯文本的
        装饰符号去掉。两者职责不同，**都要做**。
      */}
      <p className="min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">
        {plainText(body)}
      </p>
    </li>
  );
}

/** 原料标签按钮。 */
function RawTabButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition ${
        active ? 'bg-base-800 font-semibold text-ink-hi' : 'text-ink-lo hover:bg-base-800 hover:text-ink-mid'
      }`}
    >
      {icon}
      {label}
      {active && <Check aria-hidden className="h-3 w-3 shrink-0 text-up" />}
    </button>
  );
}

/**
 * 懒加载的原料块。
 *
 * ⚠️ **列表接口不给全文**：服务端为了不让一页 2.7 MB 的提示词卡死浏览器，
 * 把 `systemPrompt` / `userPrompt` 剥离成空串（见 `/api/traders/:id/decisions`）。
 * 所以这里在**展开时才**去取单条详情 —— 不点就一个字节都不传。
 * `body` 有内容时直接用（兼容未剥离的调用点，例如决策详情页）。
 */
function LazyPre({
  title,
  field,
  record,
  empty,
}: {
  title: string;
  field: 'cot' | 'system' | 'user';
  record: DecisionRecord;
  empty: string;
}): React.ReactElement {
  const inline = field === 'cot' ? record.cotTrace : field === 'system' ? record.systemPrompt : record.userPrompt;
  const [loaded, setLoaded] = useState<string | null>(inline.trim() ? inline : null);

  useEffect(() => {
    if (loaded !== null) return;
    let alive = true;
    api
      .traderDecision(record.traderId, record.id)
      .then((full) => {
        if (!alive) return;
        setLoaded(field === 'cot' ? full.cotTrace : field === 'system' ? full.systemPrompt : full.userPrompt);
      })
      .catch(() => {
        /* 取不到就说"取不到"，**不要把它显示成"（空）"** —— 那是两件事。 */
        if (alive) setLoaded('');
      });
    return () => {
      alive = false;
    };
  }, [loaded, record.traderId, record.id, field]);

  if (loaded === null) {
    return (
      <p className="flex items-center gap-1.5 px-1 py-2 text-xs text-ink-faint">
        <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
        正在读取{title}…
      </p>
    );
  }
  return <Pre body={loaded} empty={empty} />;
}

/** 可滚动的等宽文本块。`break-words` 保证超长 JSON 行不会顶出横向滚动条。 */
function Pre({ body, empty }: { body: string; empty: string }): React.ReactElement {
  if (!body.trim()) return <p className="px-1 py-2 text-xs text-ink-faint">{empty}</p>;
  return (
    <pre className={`max-h-72 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded border ${SURFACE.borderSoft} ${SURFACE.sunken} px-2 py-1.5 font-mono text-xs leading-relaxed text-ink-mid`}>
      {body}
    </pre>
  );
}

/**
 * **「服务端拼出的完整响应」的人话版**（2026-10-17 · 用户实测）。
 *
 * ## 它替代了什么
 *
 * 原来这里是一整块 `<Pre>{record.rawResponse}</Pre>` —— 屏幕上就是
 * `<decision>[]</decision><risk>…</risk><team>## 本轮汇报（给人看）{"account":…}</team>`
 * 一坨。用户原话是"根本不可读"。
 *
 * ## 现在长什么样
 * ```
 *   本轮决策      [ ]（没有决策 → 一句人话）
 *   团队过程      ## 本轮汇报（给人看）
 *                 ┌─────────┬──────────────────────────────┐
 *                 │ account │ 权益 20.7519，可用 20.7519（100%） │
 *                 │ decision│ 按不行动处理——裁决 judge 超时未返回… │
 *                 └─────────┴──────────────────────────────┘
 *                 （其余行照常显示）
 *   ▸ 查看原始    ← 默认收起，原始字节一个不丢
 * ```
 *
 * ## 三条纪律
 *  ① **解析失败回落纯文本**：汇报被 `oneLine` 截断到 2000 字符后不是合法 JSON，
 *     那时按原文显示（`parseReportObject` 返回 `null`），**绝不丢内容**；
 *  ② **渲染前过 `plainText()`**：内部文本里带 `**`（`deskOutput` 的模板就有），
 *     JSX 不解析 markdown，不剥就会把星号画在屏幕上；
 *  ③ **原始字节可查**：底部「查看原始」默认收起 —— 排查时仍然要看得到原文。
 */
function ReadableResponse({ rawResponse }: { rawResponse: string }): React.ReactElement {
  if (!rawResponse.trim()) return <p className="px-1 py-2 text-xs text-ink-faint">（空）</p>;

  const blocks = splitRawResponse(rawResponse);

  return (
    <div className="space-y-2">
      {blocks.map((block) => {
        /* 「团队过程」里那一行汇报 JSON 单独抽出来做键值表。 */
        const reportLine = block.title === '团队过程' ? extractReportLine(block.body) : null;
        const rows = reportLine === null ? null : parseReportObject(reportLine.report);

        return (
          <section key={block.title} className="min-w-0">
            <h5 className="mb-1 text-[11px] font-semibold text-ink-lo">{block.title}</h5>

            {reportLine !== null && rows !== null ? (
              <>
                {reportLine.before !== '' && (
                  <p className="mb-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">
                    {plainText(reportLine.before)}
                  </p>
                )}
                <table className="w-full table-fixed border-collapse text-xs">
                  <tbody>
                    {rows.map(([key, value]) => (
                      <tr key={key} className="border-b border-base-800 last:border-b-0">
                        <th
                          scope="row"
                          className="w-[7.5rem] shrink-0 whitespace-nowrap py-1 pr-2 text-left align-top font-normal text-ink-faint"
                        >
                          {plainText(key)}
                        </th>
                        <td className="break-words py-1 align-top text-ink-mid">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {reportLine.after !== '' && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">
                    {plainText(reportLine.after)}
                  </p>
                )}
              </>
            ) : reportLine !== null ? (
              /*
               * ⚠️ **解析失败分支**（最容易漏的那条）：汇报被截断/本来就不是 JSON。
               * 按原文显示 —— 用户至少能看到"它说了什么"，而不是一个空白或一张错误卡。
               */
              <>
                {reportLine.before !== '' && (
                  <p className="mb-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">
                    {plainText(reportLine.before)}
                  </p>
                )}
                <Pre body={plainText(reportLine.report)} empty="（空）" />
                <p className="mt-1 text-[11px] text-ink-faint">
                  这段汇报不是完整的 JSON 对象（可能被服务端的 2000 字上限截断），按原文显示。
                </p>
                {reportLine.after !== '' && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">
                    {plainText(reportLine.after)}
                  </p>
                )}
              </>
            ) : (
              <Pre body={plainText(block.body)} empty="（空）" />
            )}
          </section>
        );
      })}

      {/* 原始字节仍然可查：默认收起，点开就是服务端写进来的原文（一个字节都不少）。 */}
      <details className="rounded border border-base-800 px-2 py-1.5">
        <summary className="cursor-pointer select-none text-[11px] text-ink-faint">
          查看原始（服务端写入的完整文本，未加工）
        </summary>
        <div className="mt-1.5">
          <Pre body={rawResponse} empty="（空）" />
        </div>
      </details>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  内部拼接 → 人话（2026-10-17 · 用户实测：这一格原来叫「原始响应」）           */
/* -------------------------------------------------------------------------- */

/**
 * **一个 JSON 对象 → 键值两列表格**；不是合法 JSON 就 `null`（由调用方回落纯文本）。
 *
 * ## 为什么必须容忍"不是合法 JSON"
 *
 * `deskOutput.ts` 的 `oneLine(outcome.report, 2_000)` **先压单行、再截断到 2000 字符**。
 * 被截断的那一份**不是合法 JSON**（末尾停在半个值上），`JSON.parse` 会抛。
 * 这是本函数唯一容易写错的地方：不 `try/catch` 的话，一条长汇报会让整块详情
 * **渲染崩掉**（被 `FeedErrorBoundary` 换成一张错误卡）。
 *
 * 所以解析失败**不是错误**，是"这份内容不适合做表格"——调用方回落纯文本。
 * 与 `teamTrace.ts` 的 `parseTeamTrace` 返回 `null` 是同一套契约。
 */
export function parseReportObject(text: string): Array<[string, string]> | null {
  const trimmed = text.trim();
  /* 只有对象才做表格：数组/标量即便合法，摊成两列也没有意义。 */
  if (!trimmed.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const rows: Array<[string, string]> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    /* 值可能是对象/数组（汇报里偶尔有）—— 原样 JSON 化，**不丢信息**。 */
    const shown = typeof raw === 'string' ? raw : JSON.stringify(raw);
    rows.push([key, plainText(shown ?? '')]);
  }
  return rows.length > 0 ? rows : null;
}

/**
 * **把内部拼接的 `rawResponse` 按块拆开**，每块给人话。
 *
 * ## 这一格原来叫什么、为什么叫错了
 *
 * 原来的标签是「**原始响应**」，渲染 `record.rawResponse` 全文 ——
 * 而那一整段**全是后端 `deskOutput.ts` 渲染出来的**：
 * ```
 *   <decision>[…]</decision>   ← deskOutput 重新排过（不是模型的原文）
 *   <risk>…</risk>             ← deskOutput 拼的
 *   <team>…</team>             ← deskOutput 拼的，report 还被 oneLine 压成单行
 * ```
 * 于是屏幕上是一串 `<decision>` / `<risk>` / `<team>` 标签 + 一段压成一行的 JSON：
 * 既不是"原始输出"，也不像人话。
 *
 * ## 拆成几块（顺序 = 这一轮怎么走过来的）
 * ```
 *   本轮决策   ← <decision> 块
 *   团队过程   ← <team> 块（其中的汇报 JSON 由调用方单独做键值表）
 * ```
 * 没有 XML 骨架（老记录 / 非团队模式）时**整段作为一块**，不编结构。
 *
 * ⚠️ **只做展示**：不改 `rawResponse` 的存储格式，解析失败原样回落，一个字节都不丢。
 */
export function splitRawResponse(rawResponse: string): Array<{ title: string; body: string }> {
  const blocks: Array<{ title: string; body: string }> = [];
  const grab = (tag: string): string | null => {
    const open = rawResponse.indexOf(`<${tag}>`);
    if (open < 0) return null;
    const start = open + tag.length + 2;
    const close = rawResponse.indexOf(`</${tag}>`, start);
    const body = (close < 0 ? rawResponse.slice(start) : rawResponse.slice(start, close)).trim();
    return body.length > 0 ? body : null;
  };

  const decision = grab('decision');
  if (decision !== null) blocks.push({ title: '本轮决策', body: decision });

  const team = grab('team');
  if (team !== null) blocks.push({ title: '团队过程', body: team });

  if (blocks.length === 0) {
    const plain = rawResponse.trim();
    if (plain.length > 0) blocks.push({ title: '服务端渲染的完整响应', body: plain });
  }
  return blocks;
}

/**
 * **「团队过程」里那段汇报 JSON** —— 抽出来单独做键值表。
 *
 * 形态（`deskOutput.ts`）：`## 本轮汇报（给人看）` 之后有一行压成单行的 JSON。
 * 找不到就返回 `null`（调用方按普通文本渲染整块）。
 */
export function extractReportLine(
  teamBody: string,
): { before: string; report: string; after: string } | null {
  const lines = teamBody.split('\n');
  const at = lines.findIndex((line) => line.trim().startsWith('{'));
  if (at < 0) return null;
  return {
    before: lines.slice(0, at).join('\n').trim(),
    report: lines[at]!.trim(),
    after: lines.slice(at + 1).join('\n').trim(),
  };
}

/* -------------------------------------------------------------------------- */
/*  <risk> 块                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 从 `rawResponse` 里抽出风控官的结论。
 *
 * 返回 `null` = 这一轮没有 `<risk>` 块（老记录 / 非团队模式），**不是错误**。
 *
 * ⚠️ `approved` 的判据是**文本开头那两个字**，而不是"有没有 `<risk>` 块"：
 * 服务端写的是 `放行（模型名）：理由` / `削减后放行（模型名）：理由` / `否决（模型名）：理由`
 * （见 `deskOutput.ts` 的 `renderDeskOutcome`）。
 * 把"否决"读成"放行"会**把一次风控否决显示成一次批准** —— 那是这个界面
 * 最不能出的一种错。
 */
export function extractRiskBlock(rawResponse: string): { approved: boolean; text: string } | null {
  const open = rawResponse.indexOf('<risk>');
  if (open < 0) return null;
  const close = rawResponse.indexOf('</risk>', open);
  const body = (close < 0 ? rawResponse.slice(open + '<risk>'.length) : rawResponse.slice(open + '<risk>'.length, close)).trim();
  if (body.length === 0) return null;
  /* 只有明确以「否决」开头才算否决；其余（放行 / 削减后放行 / 未审阅）都不当成否决。 */
  return { approved: !body.startsWith('否决'), text: body };
}
