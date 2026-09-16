/**
 * Shared decision-audit presentation.
 *
 * The same primitives are needed in three places — the full audit route, the
 * trader dashboard's decision rail, and the strategy health check — so the
 * action vocabulary, the execution-log rows and the copyable prompt panel live
 * here rather than being duplicated per surface.
 */
import { type ReactNode } from 'react';
import type { DecisionRecord, ExecutionLogEntry } from '@aq/shared';
import { orderPurposeLabel } from '@aq/shared';
import { Badge, Button, Collapsible, CopyButton, type Tone } from './ui';
import { useCopy } from '../lib/hooks';
import { fmtInt, fmtUsd } from '../lib/format';

/* -------------------------------------------------------------------------- */
/*  Action vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/** Stable machine code → Chinese label. */
export const ACTION_LABELS: Record<string, string> = {
  open_long: '开多',
  open_short: '开空',
  close_long: '平多',
  close_short: '平空',
  hold: '持有',
  wait: '等待',
  /*
   * 整轮被跳过的通知（`AGENTS.md` §5.2：机器码可以是英文，但**面向操作员的
   * 文本必须走中文标签** —— 未登记的动作会被 `actionLabel()` 原样显示，
   * 界面上就会出现 `skip_cycle` 这种机器码）。
   *
   * 正常情况下 `DecisionFeed` 的 `LogLine` 对这条根本不显示动作（它不是
   * 某个标的上的动作，见那里的注释）；这里登记是为了**万一别处渲染到它**
   * 也不再漏出英文，而不是指望每个调用点都记得特判。
   */
  skip_cycle: '跳过本轮',
};

export const ACTION_TONES: Record<string, Tone> = {
  open_long: 'up',
  open_short: 'down',
  close_long: 'warn',
  close_short: 'warn',
  hold: 'muted',
  wait: 'muted',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function actionTone(action: string): Tone {
  return ACTION_TONES[action] ?? 'neutral';
}

export function isOpenAction(action: string): boolean {
  return action.startsWith('open_');
}

export const STATUS_TONE: Record<ExecutionLogEntry['status'], Tone> = {
  ok: 'up',
  rejected: 'warn',
  failed: 'down',
  skipped: 'muted',
};

/** `executionLog[].status` is a stable machine code — never display it raw. */
export const STATUS_LABELS: Record<ExecutionLogEntry['status'], string> = {
  ok: '已执行',
  rejected: '已拒绝',
  failed: '失败',
  skipped: '已跳过',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as ExecutionLogEntry['status']] ?? status;
}

/**
 * `OrderRecord.purpose` 是稳定机器码 —— 永远不要把原码打在界面上。
 *
 * 标签表本身在 `@aq/shared`（`orderPurposeLabel`）里：服务端日志、提示词和
 * 这个控制台读的是同一批码。这里保留同名导出只是为了让老调用点不用改，
 * **不再自带一份 map** —— 两份 map 迟早会分叉，而分叉的那天没人会发现。
 */
export function purposeLabel(purpose: string): string {
  return orderPurposeLabel(purpose);
}

/** Tailwind classes for an execution-log status. */
export const EXEC_ROW_CLASS: Record<ExecutionLogEntry['status'], string> = {
  ok: 'border-base-800 bg-base-850/50',
  rejected: 'border-warn/50 bg-warn/10',
  failed: 'border-down/50 bg-down/10',
  skipped: 'border-base-800 bg-base-850/40',
};

export const EXEC_TEXT_CLASS: Record<ExecutionLogEntry['status'], string> = {
  ok: 'text-ink-lo',
  rejected: 'text-warn/90',
  failed: 'text-down/90',
  skipped: 'text-ink-faint',
};

/* -------------------------------------------------------------------------- */
/*  Action badge                                                               */
/* -------------------------------------------------------------------------- */

/** Compact left badge used by the feed: 开多 / 平空 / 持有 … */
export function ActionBadge({ action, className }: { action: string; className?: string }) {
  return (
    // The machine code goes in the tooltip rather than being translated away:
    // an unknown action renders as its raw code on purpose, and the operator
    // needs to be able to grep for it in the record.
    <Badge tone={actionTone(action)} className={className} title={action}>
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
          {entry.detail}
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
            — {entry.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Rejected proposal card (rail)                                              */
/* -------------------------------------------------------------------------- */

export function RejectedCard({ entry }: { entry: ExecutionLogEntry }) {
  return (
    <div className="min-w-0 rounded-md border border-warn/50 bg-warn/10 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">被拒绝</Badge>
        <span className="text-base font-semibold text-ink-hi">{entry.symbol}</span>
        <span className="text-xs text-ink-lo">{actionLabel(entry.action)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-warn/90">{entry.detail}</p>
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
  return (
    <div className="space-y-2">
      <PromptBlock title="系统提示词" body={record.systemPrompt} onExpand={onExpand} />
      <PromptBlock title="用户提示词" body={record.userPrompt} onExpand={onExpand} />
      <PromptBlock title="原始模型响应" body={record.rawResponse} defaultOpen={false} onExpand={onExpand} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Small segmented tabs — 思考过程 / 提示词 in the decision feed               */
/* -------------------------------------------------------------------------- */

export function MiniTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={
            active === tab.id
              ? 'rounded border border-accent/60 bg-accent/15 px-2.5 py-1 text-xs font-semibold text-accent'
              : 'rounded border border-transparent px-2.5 py-1 text-xs text-ink-lo transition hover:border-base-700 hover:text-ink-mid'
          }
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
