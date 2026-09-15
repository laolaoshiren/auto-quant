/**
 * Shared decision-audit presentation.
 *
 * The same primitives are needed in three places — the full audit route, the
 * trader dashboard's decision rail, and the strategy health check — so the
 * action vocabulary, the execution-log rows and the copyable prompt panel live
 * here rather than being duplicated per surface.
 */
import { type ReactNode } from 'react';
import type { Decision, DecisionRecord, ExecutionLogEntry } from '@aq/shared';
import { Badge, Button, Collapsible, CopyButton, type Tone } from './ui';
import { useCopy } from '../lib/hooks';
import { clamp, fmtInt, fmtUsd } from '../lib/format';

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

/** `OrderRecord.purpose` is a stable machine code — never display it raw. */
const PURPOSE_LABELS: Record<string, string> = {
  entry: '开仓',
  exit: '平仓',
  stop_loss: '止损',
  take_profit: '止盈',
  adjustment: '调整',
};

export function purposeLabel(purpose: string): string {
  return PURPOSE_LABELS[purpose] ?? purpose;
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

/**
 * Distance from entry, as a percentage.
 *
 * The decision itself carries no entry price — the feed resolves the symbol's
 * current price separately — so this returns `null` rather than guessing when
 * there is no reference price to measure against.
 */
export function distancePercent(entry: number | null, level: number | null): string | null {
  if (entry === null || level === null || entry === 0) return null;
  const percent = ((level - entry) / entry) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

export function DecisionMetrics({ decision, price }: { decision: Decision; price: number | null }) {
  const stopDistance = distancePercent(price, decision.stopLoss);
  const targetDistance = distancePercent(price, decision.takeProfit);
  const reward =
    price !== null && decision.stopLoss !== null && decision.takeProfit !== null
      ? Math.abs(decision.takeProfit - price) / Math.max(Math.abs(price - decision.stopLoss), 1e-9)
      : null;

  return (
    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-base-800 bg-base-850/40 px-3 py-2 sm:grid-cols-3">
      <Metric label="数量（USDT）" value={`${fmtUsd(decision.positionSizeUsd, 2)}`} />
      <Metric label="开仓价格" value={price !== null ? fmtPriceShort(price) : '—'} />
      <Metric
        label="止损"
        value={decision.stopLoss !== null ? fmtPriceShort(decision.stopLoss) : '无'}
        tone="text-down"
        suffix={stopDistance ?? undefined}
      />
      <Metric
        label="止盈"
        value={decision.takeProfit !== null ? fmtPriceShort(decision.takeProfit) : '无'}
        tone="text-up"
        suffix={targetDistance ?? undefined}
      />
      <Metric label="风险回报比" value={`1:${reward !== null && Number.isFinite(reward) ? reward.toFixed(2) : '—'}`} />
      <Metric label="杠杆" value={`${decision.leverage}x`} />
    </div>
  );
}

function Metric({ label, value, tone, suffix }: { label: string; value: string; tone?: string; suffix?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs uppercase tracking-wide text-ink-faint">{label}</div>
      {/* nowrap: a wrapped price in a dense grid reads as two different numbers. */}
      <div className={`num whitespace-nowrap text-base ${tone ?? 'text-ink-hi'}`}>
        {value}
        {suffix && <span className="ml-1 text-xs text-ink-faint">{suffix}</span>}
      </div>
    </div>
  );
}

/** Prices read better than a full float in a feed card; the audit page shows the rest. */
function fmtPriceShort(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 4 : 6;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/* -------------------------------------------------------------------------- */
/*  Execution log                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One execution-log entry.
 *
 * `entry.action` is a stable machine code and is rendered verbatim — the
 * Chinese vocabulary lives in `ACTION_LABELS`, and applying it here would make
 * the log disagree with the audit record an operator greps in the database.
 */
export function ExecutionRow({ entry }: { entry: ExecutionLogEntry }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${EXEC_ROW_CLASS[entry.status] ?? EXEC_ROW_CLASS.ok}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[entry.status] ?? 'neutral'}>{statusLabel(entry.status)}</Badge>
        <span className="num text-base font-semibold text-ink-hi">{entry.action}</span>
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

/** Small helper so callers do not each re-derive a clamped percentage. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(value, 0, 100);
}
