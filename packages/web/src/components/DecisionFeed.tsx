/**
 * 最近决策 — the decision feed rail.
 *
 * The centrepiece of the trader dashboard. Each entry is one decision *cycle*
 * (a cycle can emit several decisions plus refusals), grouped so the operator
 * can see what the model proposed and what the runtime actually did.
 *
 * ## Layout rule
 *
 * **Decisions are always visible; only the reasoning is collapsed.** The feed is
 * a scrolling stack of cycle modules, not an accordion:
 *
 * ```
 * 周期 #5316  ·  in 32657 out 7396          ← metadata only, not a toggle
 *   ZECUSDT  平仓   置信度 62%   "跌破 EMA20…"
 *   AINUSDT  观望   置信度 79%   "持有吃趋势…"      ← always rendered
 *   FFUSDT   等待   置信度 80%   "通道量能萎缩…"
 *   思考过程 ▾ │ 提示词        [复制] [审计]        ← collapsed by default
 * ```
 *
 * The previous version hid the decisions behind a per-cycle expand/collapse, so
 * the rail showed nothing but headers until you clicked one. That is backwards:
 * "what did it decide" is the information an operator is watching continuously,
 * while the chain of thought is something you open deliberately when a decision
 * looks wrong.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DecisionRecord, Decision, ExecutionLogEntry } from '@aq/shared';
import { api, type MarketSymbol } from '../lib/api';
import { useEvents } from '../lib/store';
import { useCopy, usePolled } from '../lib/hooks';
import { Badge, Button, CopyButton, Empty, Panel, Spinner3 } from './ui';
import {
  ActionBadge,
  DecisionMetrics,
  MiniTabs,
  PromptBlock,
  RejectedCard,
  actionLabel,
  isOpenAction,
} from './DecisionAudit';
import { fmtInt, fmtLatency, timeAgo } from '../lib/format';

const ACTION_STRIPE: Record<string, string> = {
  open_long: 'border-l-up',
  open_short: 'border-l-down',
  close_long: 'border-l-warn',
  close_short: 'border-l-warn',
  hold: 'border-l-base-600',
  wait: 'border-l-base-600',
};

export function DecisionFeed({ traderId, height = 720 }: { traderId: number; height?: number }) {
  const live = useEvents((s) => s.byTrader[traderId]?.decisions);
  const query = usePolled((signal) => api.traderDecisions(traderId, 50, signal), {
    intervalMs: 20_000,
    deps: [traderId],
  });

  // The market list is what turns "stop 74434.8" into "-2.50% from entry".
  const symbolsQuery = usePolled((signal) => api.marketSymbols(signal), { intervalMs: 20_000 });

  // Live records win, but a REST page can be newer after a reload.
  const records = useMemo(() => {
    const merged = new Map<number, DecisionRecord>();
    for (const record of query.data ?? []) merged.set(record.id, record);
    for (const record of live ?? []) merged.set(record.id, record);
    return [...merged.values()].sort((a, b) => b.cycleNumber - a.cycleNumber);
  }, [query.data, live]);

  if (query.loading && records.length === 0) {
    return (
      <Panel title="最近决策" padded={false} bodyClassName="p-0">
        <Spinner3 label="正在加载决策" />
      </Panel>
    );
  }

  return (
    <Panel
      padded={false}
      bodyClassName="p-0"
      title={
        <span className="flex items-center gap-2">
          最近决策
          <Badge tone="muted">{records.length}</Badge>
        </span>
      }
      actions={
        <span className="flex items-center gap-1.5">
          <Button small variant="ghost" busy={query.loading} onClick={() => query.reload()} title="重新拉取决策记录">
            ⟳
          </Button>
          <Link to={`/data`} className="btn btn-ghost btn-xs">
            全部记录
          </Link>
        </span>
      }
    >
      {records.length === 0 ? (
        <Empty
          message="暂无决策记录。"
          hint="每个周期都会连同完整提示词与原始响应一起持久化 — 运行一次后这里就会填满。"
        />
      ) : (
        // One scroll container. Every cycle renders its decisions in full; only
        // the reasoning block inside each module is collapsible.
        <div className="overflow-y-auto" style={{ maxHeight: height }}>
          {records.map((record) => (
            <CycleBlock
              key={record.id}
              record={record}
              traderId={traderId}
              symbols={symbolsQuery.data ?? []}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/*  One cycle module                                                           */
/* -------------------------------------------------------------------------- */

function CycleBlock({
  record,
  traderId,
  symbols,
}: {
  record: DecisionRecord;
  traderId: number;
  symbols: MarketSymbol[];
}) {
  const rejected = record.executionLog.filter((entry) => entry.status === 'rejected');
  const failed = record.executionLog.filter((entry) => entry.status === 'failed');

  const tokenText =
    record.promptTokens !== null || record.completionTokens !== null
      ? `in ${fmtInt(record.promptTokens ?? 0)} out ${fmtInt(record.completionTokens ?? 0)}`
      : `延迟 ${fmtLatency(record.aiLatencyMs)}`;

  return (
    <div className="border-b border-base-850 last:border-b-0">
      {/* Cycle header: metadata only. It is deliberately *not* a toggle — the
          decisions below are always shown, so there is nothing to expand here. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 bg-base-900/40 px-2.5 py-1.5">
        <span className="num text-2xs text-ink-lo" title={record.timestamp}>
          {timeAgo(record.timestamp)}
        </span>
        <span className="num text-xs font-semibold text-ink-hi">周期 #{record.cycleNumber}</span>
        <Badge tone={record.success ? 'up' : 'down'}>{record.success ? '成功' : '失败'}</Badge>
        <span className="num text-2xs text-ink-faint">{tokenText}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {rejected.length > 0 && <Badge tone="warn">{rejected.length} 拒绝</Badge>}
          {failed.length > 0 && <Badge tone="down">{failed.length} 失败</Badge>}
        </span>
      </div>

      {/* Decisions — always visible. */}
      <div className="space-y-1.5 px-2.5 py-2">
        {record.error && (
          <div className="rounded border border-down/50 bg-down/10 px-2 py-1 text-2xs text-down">
            周期错误：{record.error}
          </div>
        )}

        {record.decisions.length === 0 && rejected.length === 0 && failed.length === 0 && (
          <p className="text-2xs text-ink-faint">本周期模型没有给出任何决策。</p>
        )}

        {record.decisions.map((decision, index) => (
          <DecisionCard
            key={`${decision.symbol}-${index}`}
            decision={decision}
            price={priceOf(symbols, decision.symbol)}
          />
        ))}

        {/* Refusals explain "why did it do nothing", so they belong here. */}
        {rejected.map((entry, index) => (
          <RejectedCard key={`rej-${index}`} entry={entry} />
        ))}

        {failed.map((entry, index) => (
          <FailedCard key={`fail-${index}`} entry={entry} />
        ))}
      </div>

      {/* Reasoning — collapsed by default, per cycle. */}
      <CycleReasoning record={record} traderId={traderId} />

      {/* Footer */}
      <div className="flex items-center justify-between px-2.5 pb-2 pt-1">
        <span className="num text-2xs text-ink-faint">
          {record.candidateSymbols.length} 个候选 · 延迟 {fmtLatency(record.aiLatencyMs)}
        </span>
        <Link to={`/traders/${traderId}/decisions/${record.id}`} className="btn btn-ghost btn-xs">
          审计
        </Link>
      </div>
    </div>
  );
}

function priceOf(symbols: MarketSymbol[], symbol: string): number | null {
  const row = symbols.find((s) => s.symbol === symbol);
  return row ? row.price : null;
}

/** Two-line clamp that does not depend on the line-clamp plugin. */
function ClampedText({ text }: { text: string }) {
  return (
    <p
      className="mt-1 overflow-hidden text-2xs leading-relaxed text-ink-mid"
      style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
      title={text}
    >
      {text}
    </p>
  );
}

function DecisionCard({ decision, price }: { decision: Decision; price: number | null }) {
  return (
    <div
      className={`rounded border border-base-750 border-l-2 bg-base-850/50 px-2.5 py-2 ${
        ACTION_STRIPE[decision.action] ?? 'border-l-base-600'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ActionBadge action={decision.action} />
        <span className="text-xs font-semibold text-ink-hi">{decision.symbol}</span>
        <span className="num ml-auto text-2xs text-ink-lo">置信度 {decision.confidence}%</span>
      </div>

      {decision.reasoning && <ClampedText text={decision.reasoning} />}

      {isOpenAction(decision.action) && <DecisionMetrics decision={decision} price={price} />}

      {decision.adjustments.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {decision.adjustments.map((note, index) => (
            <li key={index} className="text-2xs text-warn/90">
              • {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FailedCard({ entry }: { entry: ExecutionLogEntry }) {
  return (
    <div className="rounded border border-down/50 bg-down/10 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="down">失败</Badge>
        <span className="text-xs font-semibold text-ink-hi">{entry.symbol}</span>
        <span className="text-2xs text-ink-lo">{actionLabel(entry.action)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-2xs leading-relaxed text-down/90">{entry.detail}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Per-cycle reasoning: 思考过程 / 提示词                                      */
/* -------------------------------------------------------------------------- */

/**
 * The collapsible part of a cycle module.
 *
 * Collapsed by default because the chain of thought is long and is only needed
 * when a decision needs explaining. Each cycle owns its own open state, so
 * opening one does not close another — the operator can leave several expanded
 * while comparing how the model reasoned across cycles.
 */
function CycleReasoning({ record, traderId }: { record: DecisionRecord; traderId: number }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'cot' | 'prompt'>('cot');
  const cot = useCopy();
  const prompt = useCopy();

  const combinedPrompt = `${record.systemPrompt}\n\n${'─'.repeat(40)}\n\n${record.userPrompt}`;

  /** Selecting a tab both switches to it and opens the panel. */
  const selectTab = (next: 'cot' | 'prompt'): void => {
    setTab(next);
    setOpen(true);
  };

  const hasCot = record.cotTrace.trim().length > 0;

  return (
    <div className="px-2.5 pb-1">
      <div className="flex flex-wrap items-center gap-2">
        <MiniTabs
          tabs={[
            { id: 'cot', label: '思考过程' },
            { id: 'prompt', label: '提示词' },
          ]}
          active={tab}
          onChange={(id) => selectTab(id as 'cot' | 'prompt')}
        />

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? '收起' : '展开'}
          className="num rounded px-1 text-2xs text-ink-faint transition hover:text-accent"
        >
          {open ? '▴' : '▾'}
        </button>

        {!open && (
          <span className="truncate text-2xs text-ink-faint">
            {hasCot ? `${record.cotTrace.length} 字符` : '无思考过程'}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          <CopyButton
            copied={tab === 'cot' ? cot.copied : prompt.copied}
            onCopy={() => (tab === 'cot' ? cot.copy(record.cotTrace) : prompt.copy(combinedPrompt))}
          />
          <a
            href={`/traders/${traderId}/decisions/${record.id}`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost btn-xs"
          >
            展开
          </a>
        </span>
      </div>

      {open && (
        <div className="mt-1.5">
          {tab === 'cot' ? (
            <ScrollPre body={record.cotTrace} empty="本周期模型未返回 <reasoning> 块。" height={260} />
          ) : (
            <div className="space-y-2">
              <PromptBlock title="系统提示词" body={record.systemPrompt} />
              <PromptBlock title="用户提示词" body={record.userPrompt} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScrollPre({ body, empty, height = 220 }: { body: string; empty: string; height?: number }) {
  if (!body) return <p className="px-1 py-3 text-xs text-ink-faint">{empty}</p>;
  return (
    <pre
      className="overflow-auto whitespace-pre-wrap break-words rounded border border-base-800 bg-base-950 px-2.5 py-2 font-mono text-2xs leading-relaxed text-ink-mid"
      style={{ maxHeight: height }}
    >
      {body}
    </pre>
  );
}
