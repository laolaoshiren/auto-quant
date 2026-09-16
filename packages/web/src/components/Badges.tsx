/**
 * Status chips, check lists and section headers — shared across the whole app.
 *
 * Everything exported here is public API: 13 files import this module, so the
 * exports only ever grow or gain optional props. A renamed export or a narrowed
 * prop type is a compile error in somebody else's page.
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Check, TriangleAlert, X } from 'lucide-react';
import type { TraderStatus } from '@aq/shared';
import { traderStatusLabel } from '@aq/shared';
import { Badge, Dot, type Tone } from './ui';
import type { PreflightCheck } from '../lib/api';

/**
 * Status → tone.
 *
 * `running` is `up` (green) and not `accent`: green is the terminal-wide signal
 * for "this is live and making money", and a blue running dot next to a green
 * equity figure reads as two different states.
 */
const STATUS_TONE: Record<TraderStatus, Tone> = {
  running: 'up',
  stopped: 'muted',
  starting: 'warn',
  error: 'down',
  safe_mode: 'warn',
};

/*
 * 状态标签来自 `@aq/shared`，不在组件里本地定义。
 *
 * 本地定义过一份，结果是组件之外的地方（例如状态变化的 toast）只能拿到
 * 原始机器码，界面上出现 `机器人 #6 → stopped`。
 * 一份映射、一个来源，才不会再有第二个地方漏掉。
 */

/**
 * The pulse is reserved for a status that is *changing right now*.
 *
 * `live` (the trader object's `isRunning`) can be true while the status is
 * `error` or `safe_mode` — the loop is scheduled but not healthy. Pulsing then
 * would put the "live" signal on a badge that says 错误, which is worse than no
 * animation at all.
 */
function pulses(status: TraderStatus, live?: boolean): boolean {
  return live === true && (status === 'running' || status === 'starting');
}

export function TraderStatusBadge({ status, live }: { status: TraderStatus; live?: boolean }) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  const label = traderStatusLabel(status);

  return (
    <Badge
      tone={tone}
      /*
       * `animate-pulse-soft`, **not** `animate-pulseSoft`.
       *
       * tailwind.config.js declares the animation as `'pulse-soft'`; the class
       * used to be written in camelCase, and Tailwind does not error on a class
       * it does not know — it silently generates nothing. The badge looked
       * correct and simply never pulsed, which defeats the only reason it is
       * animated: signalling "live, right now" without a colour change.
       */
      className={pulses(status, live) ? 'animate-pulse-soft' : undefined}
      title={live === true ? `${label} — 循环已启动` : label}
    >
      <Dot tone={tone} pulse={pulses(status, live)} />
      {label}
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
 *
 * The three row marks are `lucide-react` icons rather than `✓ ! ✕`: a font's
 * glyph for those characters varies by platform, and on Windows the fallback is
 * noticeably misaligned against the row's text baseline.
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
              'flex items-start gap-2 rounded px-2 py-1.5',
              failed
                ? 'border border-down/60 bg-down/10'
                : severity === 'warn'
                  ? 'border border-warn/50 bg-warn/10'
                  : 'border border-up/30 bg-up/5',
            )}
          >
            <span
              className={clsx(
                'mt-0.5 shrink-0',
                failed ? 'text-down' : severity === 'warn' ? 'text-warn' : 'text-up',
              )}
              /* The mark is the only thing carrying pass/fail in this column, so
                 it cannot be aria-hidden — a screen reader would hear the check
                 name with no verdict. */
              role="img"
              aria-label={failed ? '未通过' : severity === 'warn' ? '需确认' : '通过'}
            >
              {failed ? (
                <X aria-hidden className="h-3.5 w-3.5" />
              ) : severity === 'warn' ? (
                <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
              ) : (
                <Check aria-hidden className="h-3.5 w-3.5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
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

/**
 * Section header: title, optional sub-line, optional right-hand actions.
 *
 * `title` goes up to `text-xl` (small heading) from `text-sm`. On a page whose
 * body text is `text-md`, a `text-sm` heading is *smaller* than the content it
 * introduces — the sections stopped reading as sections. `right` is aligned to
 * the last baseline so a button and a line of text sit on the same rule.
 *
 * `sub` is `ReactNode`, not `string`: the overview page's sub-line is a row of
 * `.num` figures (they have to stay tabular), and wrapping it in a plain string
 * would drop that styling. A `string` still satisfies the type, so every
 * existing caller is unaffected.
 */
export function SectionHeading({
  title,
  right,
  sub,
}: {
  title: string;
  right?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
      <div className="min-w-0">
        <h2 className="truncate text-xl font-semibold tracking-tight text-ink-hi">{title}</h2>
        {sub && <p className="mt-0.5 text-xs text-ink-lo">{sub}</p>}
      </div>
      {right && <div className="flex shrink-0 flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

/**
 * Underlined tab strip.
 *
 * Kept as plain buttons rather than Radix Tabs: the caller owns the active id
 * and renders the panel itself, so `role="tablist"`/`aria-selected` are all the
 * accessibility surface there is to get right — Radix's roving-focus model would
 * fight the callers that re-render the strip with a different tab set.
 */
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
    <div role="tablist" className="scroll-x flex items-center gap-0.5 border-b border-base-800">
      {tabs.map((tab) => {
        const selected = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={clsx(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-base font-medium transition',
              selected
                ? 'border-accent text-ink-hi'
                : 'border-transparent text-ink-lo hover:border-base-600 hover:text-ink-mid',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={clsx('num ml-1.5 text-xs', selected ? 'text-accent' : 'text-ink-faint')}>
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
