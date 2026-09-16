/**
 * 最近决策 — the decision feed.
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
 *   思考过程 ▾ │ 提示词        [复制] [新标签打开]   ← collapsed by default
 * ```
 *
 * The previous version hid the decisions behind a per-cycle expand/collapse, so
 * the feed showed nothing but headers until you clicked one. That is backwards:
 * "what did it decide" is the information an operator is watching continuously,
 * while the chain of thought is something you open deliberately when a decision
 * looks wrong.
 *
 * ## The collapsed header must still answer the question
 *
 * With the decisions always rendered the *header* is the only thing an operator
 * reads while scanning, so it carries a summary of what is below it
 * (`开多 BTCUSDT · 3 条决策 · 2 条被拒`) rather than a neutral label like
 * 思考过程. Scanning the header row alone is enough to spot a cycle that
 * refused everything.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, ExternalLink, RotateCw } from 'lucide-react';
import type { DecisionRecord, Decision, ExecutionLogEntry } from '@aq/shared';
import { api, type MarketSymbol } from '../lib/api';
import { useEvents } from '../lib/store';
import { useCopy, usePolled } from '../lib/hooks';
import { Badge, Button, CopyButton, Empty, Panel, Spinner3, cn } from './ui';
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

/**
 * How many cycles are rendered.
 *
 * The endpoint answers with 50 and the socket can append more; either way the
 * list is capped so a long-running bot cannot turn this panel into a thousand
 * DOM nodes. `全部记录` in the header is the way to see the rest.
 */
const FEED_LIMIT = 50;

/**
 * 决策流。它住在交易页的**右栏**（`LAYOUT.md` §2）。
 *
 * ## 高度：填满所在的那一栏，而不是自己算一个视口高度
 *
 * 这里曾经有一个 `height` 参数，交易页传的是 `max(380px, calc(100vh - 18rem))`。
 * 那个写法在"左指标栏 + 主内容"的旧骨架里是唯一可行的做法 —— 决策流是主内容区里
 * 的**第一块**，它上面的页头有多高只有页面自己知道，于是只能靠手算一个 `18rem`
 * 去凑。骨架改成两栏之后这个数就没法对了：右栏的顶边等于内容区顶边，要减多少
 * 完全由外壳（顶栏高度 + 页面内边距）决定，页面再算一次必然算错。
 *
 * 现在分成两件事：
 *
 * - **`xl` 及以上**：`PageShell` 的右栏在 `h-full` 的高度链上拿到了"可视区 − 顶栏"
 *   这份确定高度，所以面板 `h-full`、表头 `shrink-0`、卡片区 `flex-1 min-h-0
 *   overflow-y-auto` —— 决策流自己撑满整栏，滚动条只有一条（在卡片区），
 *   「最近决策」这一行钉在顶上不跟着滚走。
 * - **`xl` 以下**：两栏塌成一列，右栏落到主内容下面，父级高度是 `auto`，
 *   `h-full` 会解析成 `auto`。这时 `max-h-[calc(100dvh-16rem)]` 兜底 ——
 *   没有它，50 个周期会把整页撑成一条长条，正是 §2 要避免的。
 *   `xl:max-h-none` 把上限交还给上面那条 flex 高度链。
 */
export function DecisionFeed({ traderId }: { traderId: number }) {
  const live = useEvents((s) => s.byTrader[traderId]?.decisions);
  const query = usePolled((signal) => api.traderDecisions(traderId, FEED_LIMIT, signal), {
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
      // 加载态也占满整栏：否则数据一到位，这一栏会突然从一小条跳成整屏高。
      <Panel title="最近决策" padded={false} className="flex h-full min-h-0 flex-col" bodyClassName="flex min-h-0 flex-1 flex-col p-0">
        <Spinner3 label="正在加载决策" />
      </Panel>
    );
  }

  const shown = records.slice(0, FEED_LIMIT);

  return (
    <Panel
      padded={false}
      /* 填满右栏：面板 `h-full` + 一个 `min-h-0` 的纵向 flex，卡片区才能拿到
         "剩下的高度"并自己滚动（见组件顶部注释）。 */
      className="flex h-full min-h-0 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
      title={
        <span className="flex items-center gap-2">
          最近决策
          <Badge tone="muted">{records.length}</Badge>
        </span>
      }
      actions={
        <span className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            busy={query.loading}
            onClick={() => query.reload()}
            title="重新拉取决策记录"
          >
            <RotateCw aria-hidden className="h-3.5 w-3.5" />
            刷新
          </Button>
          <Link to="/data" className="btn btn-ghost btn-xs">
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
        //
        // `flex-1 min-h-0`：高度来自右栏（`h-full` 的确定高度），不是 `max-height`。
        // `min-h-0` 不能省 —— flex 子项默认 `min-height: auto`，那一项会让滚动区
        // 永远不肯比内容矮，于是滚动条跑到整栏外面去。
        //
        // `max-h-[calc(100dvh-16rem)]` 只在 `xl` 以下生效：那时右栏塌到主内容下面，
        // 高度是内容高度，没有这个上限就会把整页撑长。
        //
        // `space-y-2.5` 而不是相邻的 `border-b`：40 个周期用一条接一条的分隔线排下来，
        // 会连成一整片、分不清哪里是上一个周期的结尾。让每个周期成为**独立的一张卡**，
        // 靠间距和卡片边界来分组，扫读时才知道自己在看哪一轮。
        //
        // 间距按设计规范收紧（卡内与间隙各减 2px）：这一页是操作者会一直
        // 滚的地方，同样的屏幕高度里多挤进一轮就多一分用。
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5 max-h-[calc(100dvh-16rem)] xl:max-h-none">
          {shown.map((record) => (
            <CycleBlock
              key={record.id}
              record={record}
              traderId={traderId}
              symbols={symbolsQuery.data ?? []}
            />
          ))}
          {records.length > shown.length && (
            <p className="pt-1 text-xs text-ink-faint">
              只显示最近 {shown.length} 个周期，共 {records.length} 个。完整历史在
              <Link to="/data" className="ml-1 text-accent hover:underline">
                决策记录
              </Link>
              。
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/*  One cycle module                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What the cycle decided, in one line, for the collapsed header.
 *
 * The operator scans the header row without expanding anything, so the header
 * has to say *what happened* — `wait` with no refusals is a very different cycle
 * from `open_long` with two refusals, and the old header rendered both as
 * nothing but a cycle number.
 */
function summarize(record: DecisionRecord, rejected: number, failed: number): string {
  const parts: string[] = [];
  const first = record.decisions[0];

  if (first) {
    const label = actionLabel(first.action);
    // `wait 3` reads as a count of nothing; naming a symbol is what tells the
    // operator the model at least looked somewhere specific. The decision count
    // is stated separately because one 开多 and five 开多 are different cycles.
    parts.push(record.decisions.length === 1 ? `${label} ${first.symbol}` : `${label} ${first.symbol} 等`);
    parts.push(`${record.decisions.length} 条决策`);
  }
  if (rejected > 0) parts.push(`${rejected} 条被拒`);
  if (failed > 0) parts.push(`${failed} 条失败`);

  // One decision and one refusal-free cycle collapses to `开多 BTCUSDT` — the
  // count adds nothing when it is visibly the only card below the header.
  if (parts.length === 0) return '本周期没有决策';
  if (parts.length === 1) return parts[0] as string;
  return parts.join(' · ');
}

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
      ? `输入 ${fmtInt(record.promptTokens ?? 0)} / 输出 ${fmtInt(record.completionTokens ?? 0)} tokens`
      : `延迟 ${fmtLatency(record.aiLatencyMs)}`;

  /*
   * 每个周期是一张**独立的卡**，不是列表里的一行。
   *
   * 原来用相邻的 `border-b` 分隔，40 个周期排下来会连成一片 —— 上下两个周期的
   * 决策、按钮、元数据混在同一个视觉块里，扫读时分不清在哪一轮。
   *
   * 左边那条色条表达这一轮的**结果**（有失败→红，有拒绝→黄，正常→绿），
   * 不必读文字就能看出哪几轮出过问题。
   */
  const accent = failed.length > 0 ? 'bg-down' : rejected.length > 0 ? 'bg-warn' : 'bg-up';

  return (
    <article className="relative overflow-hidden rounded-lg border border-base-750 bg-base-900 shadow-panel">
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', accent)} />

      {/* Cycle header: metadata only. It is deliberately *not* a toggle — the
          decisions below are always shown, so there is nothing to expand here. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-base-800 bg-base-850/60 py-2 pl-3.5 pr-3">
        <span className="num text-sm font-semibold text-ink-hi">周期 #{record.cycleNumber}</span>
        <Badge tone={record.success ? 'up' : 'down'}>{record.success ? '成功' : '失败'}</Badge>
        {/* The collapsed-header summary: the whole point of the header row. */}
        <span
          className={cn(
            'num truncate text-base',
            rejected.length > 0 ? 'text-warn' : failed.length > 0 ? 'text-down' : 'text-ink-mid',
          )}
          title="本周期做出了什么决定 — 不需要展开就能看到。"
        >
          {summarize(record, rejected.length, failed.length)}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-ink-faint">
          {failed.length > 0 && <Badge tone="down">{failed.length} 失败</Badge>}
          {rejected.length > 0 && <Badge tone="warn">{rejected.length} 被拒</Badge>}
          <span className="num">{record.candidateSymbols.length} 个候选</span>
          <span className="num">{tokenText}</span>
          <span className="num" title={record.timestamp}>
            {timeAgo(record.timestamp)}
          </span>
        </span>
      </div>

      {/* Decisions — always visible. */}
      <div className="space-y-1.5 px-3.5 py-2.5">
        {record.error && (
          <div className="rounded-md border border-down/50 bg-down/10 px-2.5 py-1.5 text-xs text-down">
            周期错误：{record.error}
          </div>
        )}

        {record.decisions.length === 0 && rejected.length === 0 && failed.length === 0 && (
          <p className="text-xs text-ink-faint">本周期模型没有给出任何决策。</p>
        )}

        {/*
          Two columns from `lg` up. The feed is full width now, and a single
          column of decision cards across 1400px would put the reasoning text
          and the confidence badge a screen apart.
        */}
        {record.decisions.length > 0 && (
          /*
           * `items-start` 是必需的，不是可选的美化。
           *
           * Grid 默认 `align-items: stretch`，同一行的卡片会被**撑成等高**。
           * 于是「平多 ARBUSDT · 置信度 0%」这种内容极少的卡片，会被拉高到和
           * 旁边一张写满说明与数字的卡片一样高 —— 中间留下一大片空白，
           * 看起来就是"卡片错位、东倒西歪"。在宽屏（≥1536px，卡片变三列）时最明显。
           *
           * 每张卡只占自己内容的高度，行高由这一行最高的那张决定，其余保持自然高度。
           */
          <div className="grid grid-cols-1 items-start gap-2 lg:grid-cols-2 2xl:grid-cols-3">
            {record.decisions.map((decision, index) => (
              <DecisionCard
                key={`${decision.symbol}-${index}`}
                decision={decision}
                price={priceOf(symbols, decision.symbol)}
              />
            ))}
          </div>
        )}

        {/* Refusals explain "why did it do nothing", so they belong here. */}
        {(rejected.length > 0 || failed.length > 0) && (
          <div className="grid grid-cols-1 items-start gap-2 lg:grid-cols-2 2xl:grid-cols-3">
            {rejected.map((entry, index) => (
              <RejectedCard key={`rej-${index}`} entry={entry} />
            ))}
            {failed.map((entry, index) => (
              <FailedCard key={`fail-${index}`} entry={entry} />
            ))}
          </div>
        )}
      </div>

      {/* Reasoning — collapsed by default, per cycle. */}
      <CycleReasoning record={record} traderId={traderId} />
    </article>
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
      className="mt-1 overflow-hidden text-xs leading-relaxed text-ink-mid"
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
      className={cn(
        'min-w-0 rounded-md border border-base-750 border-l-2 bg-base-850/50 px-3 py-2',
        ACTION_STRIPE[decision.action] ?? 'border-l-base-600',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ActionBadge action={decision.action} />
        <span className="text-base font-semibold text-ink-hi">{decision.symbol}</span>
        <span className="num ml-auto text-xs text-ink-lo" title="模型对该决策的自评置信度。">
          置信度 {decision.confidence}%
        </span>
      </div>

      {decision.reasoning && <ClampedText text={decision.reasoning} />}

      {isOpenAction(decision.action) && <DecisionMetrics decision={decision} price={price} />}

      {decision.adjustments.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {decision.adjustments.map((note, index) => (
            <li key={index} className="text-xs text-warn/90">
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
    <div className="min-w-0 rounded-md border border-down/50 bg-down/10 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="down">失败</Badge>
        <span className="text-base font-semibold text-ink-hi">{entry.symbol}</span>
        <span className="text-xs text-ink-lo">{actionLabel(entry.action)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-down/90">{entry.detail}</p>
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
    /*
     * 一条工具栏，所有操作都在同一行、同一高度。
     *
     * 原来的排布是反人类的：展开是一个只有 14px 的小三角（既看不清也点不准），
     * 而"审计"在下面的另一行又出现了一次 —— 同一个动作两个入口、垂直节奏还错开，
     * 每次都要在屏幕上找。现在左边是"看什么"（分段控件 + 展开），
     * 右边是"拿走什么"（复制 + 审计），一行结束。
     */
    <div className="border-t border-base-800 bg-base-850/30 px-3.5 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <MiniTabs
          tabs={[
            { id: 'cot', label: '思考过程' },
            { id: 'prompt', label: '提示词' },
          ]}
          active={tab}
          onChange={(id) => selectTab(id as 'cot' | 'prompt')}
        />

        {/*
          唯一的展开/收起，只管推理部分。上面的决策不在它后面 —— 见模块顶部注释。
          用 `btn btn-ghost btn-xs` 而不是裸三角：它是这条工具栏里最主要的动作，
          尺寸必须和"复制""审计"一致，否则用户找不到。
        */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? '收起思考过程与提示词' : '展开思考过程与提示词'}
          className="btn btn-ghost btn-xs"
        >
          {open ? (
            <ChevronUp aria-hidden className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown aria-hidden className="h-3.5 w-3.5" />
          )}
          {open ? '收起' : '展开'}
        </button>

        {!open && (
          <span className="truncate text-xs text-ink-faint">
            {hasCot ? `${fmtInt(record.cotTrace.length)} 字符思考过程` : '无思考过程'}
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
            title="在新标签页打开这条记录的完整审计视图"
          >
            <ExternalLink aria-hidden className="h-3.5 w-3.5" />
            审计
          </a>
        </span>
      </div>

      {open && (
        <div className="mt-2">
          {tab === 'cot' ? (
            <ScrollPre body={record.cotTrace} empty="本周期模型未返回 <reasoning> 块。" height={320} />
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

function ScrollPre({ body, empty, height = 260 }: { body: string; empty: string; height?: number }) {
  if (!body) return <p className="px-1 py-3 text-base text-ink-faint">{empty}</p>;
  return (
    <pre
      className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-base-800 bg-base-950 px-3 py-2 font-mono text-xs leading-relaxed text-ink-mid"
      style={{ maxHeight: height }}
    >
      {body}
    </pre>
  );
}
