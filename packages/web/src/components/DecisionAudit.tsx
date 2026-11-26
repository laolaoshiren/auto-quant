/**
 * Shared decision-audit presentation.
 *
 * The same primitives are needed in three places — the full audit route, the
 * trader dashboard's decision rail, and the strategy health check — so the
 * action vocabulary, the execution-log rows and the copyable prompt panel live
 * here rather than being duplicated per surface.
 */
import { type ReactNode } from 'react';
import type { DecisionAction, DecisionRecord, ExecutionLogEntry } from '@aq/shared';
import { Badge, Button, Collapsible, CopyButton, cn, type Tone } from './ui';
import { useCopy } from '../lib/hooks';
import { fmtInt, fmtUsd } from '../lib/format';
import { plainText } from '../lib/plainText';
import { humanizeToolNames } from '../lib/toolLabels';
import { parseTeamTrace } from '../lib/teamTrace';

/* -------------------------------------------------------------------------- */
/*  Action vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 动作的机器码 → 中文标签。
 *
 * ## ⚠️ 类型是 `Record<DecisionAction, string>`，**不是 `Record<string, string>`**
 *
 * 原来它是 `Record<string, string>` —— 于是**漏登记一个动作不会有任何提示**，
 * `actionLabel()` 会把机器码原样显示到界面上：
 *
 *     置信度: 0%              adjust_protection      ← 操作员看到的
 *
 * 那正是这次真实发生的事：`adjust_protection` / `add_to_position` /
 * `reduce_position` 三个动作加进来了，而这张表没跟上。
 *
 * **改成按 `DecisionAction` 收窄之后，漏一个就编译不过** ——
 * 这条纪律从此由 `tsc` 保证，而不是靠"下次记得"。
 *
 * ## 只允许 `DecisionAction` 里有的键
 *
 * `skip_cycle` 不在 `DecisionAction` 里（它是整轮跳过，不是某个标的上的动作），
 * 所以它按 `satisfies` 的规则额外加在下面。它登记的原因是**万一别处渲染到它**
 * 也不再漏出英文，而不是指望每个调用点都记得特判。
 */
export const ACTION_LABELS: Record<DecisionAction, string> = {
  open_long: '开多',
  open_short: '开空',
  close_long: '平多',
  close_short: '平空',
  adjust_protection: '调整保护',
  cancel_pending: '撤单',
  add_to_position: '加仓',
  reduce_position: '减仓',
  hold: '持有',
  wait: '等待',
  /*
   * 「看过了，不做」。
   *
   * 它不是"等待"（那是**挂着的限价单在等成交**），也不是"持有"（那是有仓位）。
   * 它是模型对候选池里**没动**的那些标的留下的一条结构化记录 ——
   * 带 `setup_score`，用来让它的入场门槛**可被自己校准**。
   * 详见 `DecisionActionSchema` 里 `skip` 那段。
   */
  skip: '跳过',
};

/*
 * 整轮跳过的通知码。它不属于任何标的上的动作，所以单独一张表 ——
 * 但同样要走中文，理由见上。
 */
export const EXTRA_ACTION_LABELS: Record<string, string> = {
  skip_cycle: '跳过本轮',
};

export const ACTION_TONES: Record<DecisionAction, Tone> = {
  open_long: 'up',
  open_short: 'down',
  close_long: 'warn',
  close_short: 'warn',
  /* 仓位管理动作都不改变方向，用中性色 —— 它们既不是"看多"也不是"看空"。 */
  adjust_protection: 'neutral',
  /* 撤单是**降低风险**，同样中性：它不表达方向，只表达"这笔不再等了"。 */
  cancel_pending: 'neutral',
  add_to_position: 'neutral',
  reduce_position: 'neutral',
  /* `hold` 表示有在途仓位或挂单正在守护，视觉权重高于纯观望的 `wait` 与 `skip`。 */
  hold: 'accent',
  wait: 'muted',
  /* `skip` 是"什么都没做"，用最弱的色调 —— 它在决策流里会很频繁。 */
  skip: 'muted',
};

/**
 * 动作徽章的精细差异化配色（深浅主题均达 WCAG AA 对比度）。
 *
 * 将「持有（青蓝：有仓/挂单守护中）」「等待（淡紫：观察待机）」「跳过（低调灰）」
 * 明确拉开层次，避免全员灰牌导致决策流里看不出哪些标的真正持仓。
 */
const ACTION_BADGE_CLASS: Partial<Record<DecisionAction, string>> = {
  hold: "border-sky-500/40 bg-sky-500/12 text-sky-300 [[data-skin='light']_&]:border-sky-700/35 [[data-skin='light']_&]:bg-sky-500/12 [[data-skin='light']_&]:text-sky-800",
  wait: "border-violet-400/35 bg-violet-500/10 text-violet-300 [[data-skin='light']_&]:border-violet-700/30 [[data-skin='light']_&]:bg-violet-500/10 [[data-skin='light']_&]:text-violet-800",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action as DecisionAction] ?? EXTRA_ACTION_LABELS[action] ?? action;
}

export function actionTone(action: string): Tone {
  return ACTION_TONES[action as DecisionAction] ?? 'neutral';
}

export function isOpenAction(action: string): boolean {
  return action.startsWith('open_');
}

export const STATUS_TONE: Record<ExecutionLogEntry['status'], Tone> = {
  ok: 'up',
  /* 已挂单未成交 —— 不是"做成了"，但也不是失败。用中性色，别让人误读成仓位。 */
  submitted: 'muted',
  rejected: 'warn',
  failed: 'down',
  skipped: 'muted',
  data: 'muted',
};

/** `executionLog[].status` is a stable machine code — never display it raw. */
export const STATUS_LABELS: Record<ExecutionLogEntry['status'], string> = {
  ok: '已执行',
  submitted: '已挂单',
  rejected: '已拒绝',
  failed: '失败',
  skipped: '已跳过',
  /* 模型主动要了数据 —— 纯读取，不是一次交易动作（见 `domain.ts` 里的说明）。 */
  data: '已取数',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as ExecutionLogEntry['status']] ?? status;
}

/** Tailwind classes for an execution-log status. */
export const EXEC_ROW_CLASS: Record<ExecutionLogEntry['status'], string> = {
  ok: 'border-base-800 bg-base-850/50',
  submitted: 'border-base-700 bg-base-850/60',
  rejected: 'border-warn/50 bg-warn/10',
  failed: 'border-down/50 bg-down/10',
  skipped: 'border-base-800 bg-base-850/40',
  /* 取数是纯读取，不是结果 —— 用与"跳过"同级的低调样式。 */
  data: 'border-base-800 bg-base-850/40',
};

export const EXEC_TEXT_CLASS: Record<ExecutionLogEntry['status'], string> = {
  ok: 'text-ink-lo',
  submitted: 'text-ink-lo',
  rejected: 'text-warn/90',
  failed: 'text-down/90',
  skipped: 'text-ink-faint',
  data: 'text-ink-faint',
};

/* -------------------------------------------------------------------------- */
/*  Action badge                                                               */
/* -------------------------------------------------------------------------- */

const PENDING_ORDER_WAIT_RE =
  /(?:(?:保留|维持|继续等待?|继续持有|留着|暂不撤|原价保留).{0,24}(?:挂单|限价[多空单]?|委托)|(?:挂单|限价[多空单]|待成交|委托).{0,64}(?:继续等|保留继续|保留不撤|原价保留|未成交|等待成交|暂不撤|不撤不重挂|挂着)|(?:离挂单价|撤单重挂|原价保留不撤|不撤不重挂|挂单尚未|委托尚未|待成交限价))/;
const FILLED_POSITION_RE = /(?:浮盈|浮亏|未实现盈亏|持仓均价|开仓均价|ROE|持仓\s*\d+[mh]|已成交持仓)/;

/**
 * 识别「未成交限价委托继续等待」语义（既兼容历史记录里模型误吐的 `hold`，也区分于空仓观望的 `wait`）。
 */
export function isPendingOrderWaitDecision(action: string, reasoning?: string | null): boolean {
  if (action !== 'hold' && action !== 'wait') return false;
  if (!reasoning) return false;
  if (FILLED_POSITION_RE.test(reasoning)) return false;
  return PENDING_ORDER_WAIT_RE.test(reasoning);
}

/** Compact left badge used by the feed: 开多 / 平空 / 持有 / 待成交 … */
export function ActionBadge({
  action,
  reasoning,
  className,
}: {
  action: string;
  reasoning?: string | null;
  className?: string;
}) {
  const pendingWait = isPendingOrderWaitDecision(action, reasoning);
  if (pendingWait) {
    return (
      <Badge
        tone="warn"
        className={cn(
          "border-amber-400/40 bg-amber-500/12 text-amber-300 [[data-skin='light']_&]:border-amber-700/35 [[data-skin='light']_&]:bg-amber-500/12 [[data-skin='light']_&]:text-amber-800",
          className,
        )}
        title={`${action}（限价委托待成交）`}
      >
        待成交
      </Badge>
    );
  }
  return (
    // The machine code goes in the tooltip rather than being translated away:
    // an unknown action renders as its raw code on purpose, and the operator
    // needs to be able to grep for it in the record.
    <Badge
      tone={actionTone(action)}
      className={cn(ACTION_BADGE_CLASS[action as DecisionAction], className)}
      title={action}
    >
      {actionLabel(action)}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/*  Metric block for open proposals                                            */
/* -------------------------------------------------------------------------- */

/*
 * ⚠️ 这里原本有一个 `DecisionMetrics`：6 格数字表（数量 / 开仓价 / 止损 / 止盈 /
 * 风险回报比 / 杠杆）+ 容器查询切 2/3 列，以及配套的 `distancePercent` 与
 * `Metric` 帮助组件。**已按 `DECISION-FEED.md` §6 删除。**
 *
 * 删掉的原因不是"参考里没有"这么简单，而是它连续三轮出溢出 bug：grid 的列有
 * 最小内容宽度，而决策流在右栏里只有约 40% 宽，一个 `0.176800` 加上 `+26.67%`
 * 就能撑破格子、把文字挤进相邻列。决策流现在把同样的数字打成**一行会折行的小字**
 * （见 `DecisionFeed.tsx` 的 `figureParts`）—— 一行文本没有最小宽度，横向永不溢出。
 *
 * 如果将来别的页面（例如决策详情页）需要这张表，请在那里重新实现，**不要再放回
 * 决策流** —— 那个位置容不下固定列宽的东西。
 */

/* -------------------------------------------------------------------------- */
/*  Execution log                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One execution-log entry.
 *
 * `entry.action` is a stable machine code, so the operator reads the Chinese
 * label while the **raw code stays in the tooltip** — the audit trail and the
 * risk engine both store the code, and someone grepping the database for
 * `open_long` must still be able to find which row they are looking at.
 */
export function ExecutionRow({ entry }: { entry: ExecutionLogEntry }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${EXEC_ROW_CLASS[entry.status] ?? EXEC_ROW_CLASS.ok}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[entry.status] ?? 'neutral'}>{statusLabel(entry.status)}</Badge>
        <span className="num text-base font-semibold text-ink-hi" title={entry.action}>
          {actionLabel(entry.action)}
        </span>
        <span className="num text-xs text-ink-lo">{entry.symbol}</span>
        {entry.notionalUsd !== undefined && (
          <span className="num ml-auto text-xs text-ink-lo" title="名义价值（USDT）">
            {fmtUsd(entry.notionalUsd, 2)}
          </span>
        )}
      </div>
      {entry.detail && (
        <p className={`mt-1 whitespace-pre-wrap text-xs leading-relaxed ${EXEC_TEXT_CLASS[entry.status] ?? 'text-ink-lo'}`}>
          {plainText(humanizeToolNames(entry.detail))}
        </p>
      )}
      {entry.orderId && <p className="num mt-0.5 text-xs text-ink-faint">委托 {entry.orderId}</p>}
    </div>
  );
}

export function ExecutionList({ log, empty }: { log: ExecutionLogEntry[]; empty?: string }) {
  if (log.length === 0) {
    return <p className="px-1 py-3 text-base text-ink-faint">{empty ?? '本周期没有执行任何操作。'}</p>;
  }
  return (
    <div className="space-y-1.5">
      {log.map((entry, index) => (
        <ExecutionRow key={`${entry.action}-${entry.symbol}-${index}`} entry={entry} />
      ))}
    </div>
  );
}

/**
 * Rejected proposals, surfaced rather than buried.
 *
 * "Why did the bot do nothing?" is the most common operator question, and a
 * refusal by the risk engine is the answer far more often than a model error.
 */
export function RejectedBanner({ log, className }: { log: ExecutionLogEntry[]; className?: string }) {
  const rejected = log.filter((entry) => entry.status === 'rejected');
  if (rejected.length === 0) return null;
  return (
    <div className={`rounded-lg border border-warn/60 bg-warn/10 px-4 py-3 ${className ?? ''}`}>
      <div className="text-base font-bold uppercase tracking-wide text-warn">
        {rejected.length} 个提案被风控引擎拒绝
      </div>
      <ul className="mt-1.5 space-y-1">
        {rejected.map((entry, index) => (
          <li key={index} className="text-xs leading-relaxed text-warn/90">
            <span className="num font-semibold">
              {actionLabel(entry.action)} {entry.symbol}
            </span>{' '}
            — {plainText(humanizeToolNames(entry.detail))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Prompt / trace panels                                                      */
/* -------------------------------------------------------------------------- */

/** Scrollable monospace `<pre>` with nothing else attached. */
export function PrePanel({
  body,
  height = 320,
  empty = '（空）',
}: {
  body: string;
  height?: number;
  empty?: string;
}) {
  if (!body) return <p className="px-3 py-4 text-base text-ink-faint">{empty}</p>;
  return (
    <pre
      className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-base-800 bg-base-950 px-3 py-2 font-mono text-xs leading-relaxed text-ink-mid"
      style={{ maxHeight: height }}
    >
      {body}
    </pre>
  );
}

/**
 * Copyable, collapsible prompt block.
 *
 * `onExpand` opens the full audit route in a new tab when one exists; the
 * strategy check has no persisted record, so it passes nothing and the expand
 * control is simply absent.
 */
export function PromptBlock({
  title,
  body,
  defaultOpen = false,
  onExpand,
  actions,
}: {
  title: ReactNode;
  body: string;
  defaultOpen?: boolean;
  onExpand?: () => void;
  actions?: ReactNode;
}) {
  const { copied, copy } = useCopy();
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      title={<span className="font-semibold text-ink-mid">{title}</span>}
      meta={
        <span className="flex items-center gap-2">
          <span className="num text-xs text-ink-faint">
            {fmtInt(body.length)} 字符 · {body.split('\n').length} 行
          </span>
          {actions}
          <CopyButton copied={copied} onCopy={() => copy(body)} />
          {onExpand && (
            <Button size="sm" onClick={onExpand} title="在新标签页打开完整审计记录">
              展开
            </Button>
          )}
        </span>
      }
    >
      <PrePanel body={body} height={520} />
    </Collapsible>
  );
}

/** The full set of prompt/response blocks for a persisted decision record. */
export function PromptBlocks({ record, onExpand }: { record: DecisionRecord; onExpand?: () => void }) {
  /*
   * ⚠️ **第三块的标题不能叫「原始模型响应」**（2026-10-17 · 用户实测 · 与
   * `TeamDecisionRow` 里那一格是同一条错）。
   *
   * 团队模式下，`rawResponse` 里的 `<decision>` / `<risk>` / `<team>` 三块
   * **全是服务端 `deskOutput.ts` 渲染出来的**，汇报 JSON 还被 `oneLine` 压成单行、
   * 截断到 2000 字符 —— 它不是模型的原话，是"我们怎么把模型的话整理成这个样子"。
   * 把它叫"原始模型响应"，等于让排查的人拿一份二手材料当一手证据。
   *
   * 团队模式用如实的名字 + 一行说明；非团队模式保持原名（那边的 `rawResponse`
   * 就是模型原样输出，没有这三块骨架 —— 逐字节不变）。
   */
  const isTeam = parseTeamTrace(record.rawResponse ?? '') !== null;
  return (
    <div className="space-y-2">
      <PromptBlock title="系统提示词" body={record.systemPrompt ?? ''} onExpand={onExpand} />
      <PromptBlock title="用户提示词" body={record.userPrompt ?? ''} onExpand={onExpand} />
      <PromptBlock
        title={
          isTeam ? (
            <span className="flex flex-wrap items-baseline gap-x-2">
              服务端拼出的完整响应
              <span className="text-[11px] font-normal text-ink-faint">
                —— 团队模式：<span className="font-mono">{'<decision>'}</span>/
                <span className="font-mono">{'<risk>'}</span>/
                <span className="font-mono">{'<team>'}</span> 三块由服务端渲染，不是模型原文
              </span>
            </span>
          ) : (
            '原始模型响应'
          )
        }
        body={record.rawResponse ?? ''}
        defaultOpen={false}
        onExpand={onExpand}
      />
    </div>
  );
}
