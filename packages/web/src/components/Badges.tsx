import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { TraderStatus } from '@aq/shared';
import { Badge, Dot, type Tone } from './ui';
import type { PreflightCheck } from '../lib/api';

const STATUS_TONE: Record<TraderStatus, Tone> = {
  running: 'up',
  stopped: 'muted',
  starting: 'warn',
  error: 'down',
  safe_mode: 'warn',
};

const STATUS_LABEL: Record<TraderStatus, string> = {
  running: '运行中',
  stopped: '已停止',
  starting: '启动中',
  error: '错误',
  safe_mode: '安全模式',
};

export function TraderStatusBadge({ status, live }: { status: TraderStatus; live?: boolean }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} className={live ? 'animate-pulseSoft' : undefined}>
      <Dot tone={STATUS_TONE[status] ?? 'neutral'} />
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function SideBadge({ side }: { side: string }) {
  const long = side === 'long' || side === 'BUY';
  return <Badge tone={long ? 'up' : 'down'}>{long ? '多' : '空'}</Badge>;
}

/**
 * Renders `preflight` / connection-test rows.
 *
 * Severity drives the styling, not `ok` alone. There is a genuine third state:
 * a check can be "not a failure, but confirm this" — the withdrawal-permission
 * notice on a sub-account key is the motivating case. Rendering those as green
 * passes hides real advice, and rendering them as red failures trains operators
 * to ignore the panel; amber is the honest middle.
 */
export function CheckList({ checks }: { checks: PreflightCheck[] }) {
  if (checks.length === 0) {
    return <p className="text-2xs text-ink-faint">未返回任何检查项。</p>;
  }

  /** Falls back to `ok` when an older payload omits `severity`. */
  const severityOf = (check: PreflightCheck): 'ok' | 'warn' | 'error' =>
    check.severity ?? (check.ok ? 'ok' : check.blocking ? 'error' : 'warn');

  const blockingFailed = checks.filter((check) => severityOf(check) === 'error' && check.blocking).length;

  return (
    <div className="space-y-1">
      {checks.map((check, index) => {
        const severity = severityOf(check);
        const failed = severity === 'error';
        return (
          <div
            key={`${check.name}-${index}`}
            className={clsx(
              'flex items-start gap-2 rounded border px-2 py-1.5',
              failed
                ? 'border-down/60 bg-down/10'
                : severity === 'warn'
                  ? 'border-warn/50 bg-warn/10'
                  : 'border-up/30 bg-up/5',
            )}
          >
            <span
              className={clsx(
                'mt-px w-3 shrink-0 text-center text-xs font-bold',
                failed ? 'text-down' : severity === 'warn' ? 'text-warn' : 'text-up',
              )}
            >
              {failed ? '✕' : severity === 'warn' ? '!' : '✓'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-ink-hi">{check.name}</span>
                {failed && check.blocking && <Badge tone="down">阻断</Badge>}
                {failed && !check.blocking && <Badge tone="warn">警告</Badge>}
                {severity === 'warn' && <Badge tone="warn">请确认</Badge>}
              </div>
              {check.detail && <div className="mt-0.5 break-words text-2xs text-ink-lo">{check.detail}</div>}
            </div>
          </div>
        );
      })}
      {blockingFailed > 0 && (
        <p className="pt-1 text-2xs font-semibold text-down">
          {blockingFailed} 项阻断检查未通过 — 通过之前该循环不会交易。
        </p>
      )}
    </div>
  );
}

export function SectionHeading({ title, right, sub }: { title: string; right?: ReactNode; sub?: string }) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-ink-hi">{title}</h2>
        {sub && <p className="text-2xs text-ink-faint">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 border-b border-base-800">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={clsx(
            '-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition',
            active === tab.id
              ? 'border-accent text-ink-hi'
              : 'border-transparent text-ink-lo hover:border-base-600 hover:text-ink-mid',
          )}
        >
          {tab.label}
          {tab.count !== undefined && <span className="num ml-1.5 text-2xs text-ink-faint">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
