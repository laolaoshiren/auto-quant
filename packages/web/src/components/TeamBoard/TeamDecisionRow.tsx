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
 */
const ROLE_LABEL: Record<string, string> = {
  supervisor: '总管',
  judge: '裁决官',
  reporter: '汇报员',
  market_analyst: '市场分析师',
  technical: '技术面分析',
  newscaster: '新闻调查员',
  sentiment: '市场情绪',
  bull: '多头研究员',
  bear: '空头研究员',
  onchain_analyst: '链上分析',
  community_monitor: '社区监控',
  risk_officer: '风控官',
  red_team: '红队',
  portfolio_manager: '组合经理',
  execution: '交易员（执行层）',
  memory_curator: '复盘员',
  data_sentinel: '数据看门狗',
  ops_watchdog: '运维看门狗',
  clerk: '文员',
  system_engineer: '系统工程师',
};

/** 角色 id → 界面标签（未登记的返回 `null`，由调用处决定怎么显示）。 */
export function roleLabel(role: string): string | null {
  return ROLE_LABEL[role] ?? null;
}

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
   */
  const text = detail ?? '';
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
          • {note}
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
 */
function TeamDecisionDetails({
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
                {risk.text}
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
              <RawTabButton icon={<FileText aria-hidden className="h-3 w-3" />} label="原始响应" active={tab === 'raw'} onClick={() => setTab('raw')} />
            </div>
            <div className="mt-1.5">
              {tab === 'cot' && <LazyPre title="思考过程" field="cot" record={record} empty="这一轮没有留下思维链。" />}
              {tab === 'prompt' && (
                <div className="space-y-1.5">
                  <LazyPre title="系统提示词" field="system" record={record} empty="（空）" />
                  <LazyPre title="用户提示词" field="user" record={record} empty="（空）" />
                </div>
              )}
              {tab === 'raw' && <Pre body={record.rawResponse} empty="（空）" />}
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
      <p className="min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">{body}</p>
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
