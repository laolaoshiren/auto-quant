import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, TriangleAlert, X } from 'lucide-react';
import type { Decision, ExecutionLogEntry } from '@aq/shared';
import {
  FIGURE_PILL_STYLE,
  FIGURE_TITLE,
  figureParts,
  type FigureContext,
} from '../../lib/decisionFigures';
import { fmtUsd } from '../../lib/format';
import { plainText } from '../../lib/plainText';
import { humanizeToolNames } from '../../lib/toolLabels';
import { CoinIcon } from '../CoinIcon';
import { ActionBadge, STATUS_LABELS, actionLabel } from '../DecisionAudit';
import {
  ManagedStageActionBar,
  isManagedTrajectoryEntry,
  resolveManagedStageChips,
} from '../PowerlineTrajectory';
import { Badge, cn } from '../ui';

function isClickableSymbol(symbol: string | null | undefined): boolean {
  const s = (symbol ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{2,24}$/.test(s) && s !== 'ALL' && s !== 'NONE';
}

/** 动作对应的左侧色条，用于一秒区分开仓 / 平仓 / 持有 / 等待 / 跳过。 */
function actionRailClass(action: Decision['action']): string {
  switch (action) {
    case 'open_long':
      return 'border-l-up/85';
    case 'open_short':
      return 'border-l-down/85';
    case 'close_long':
    case 'close_short':
      return 'border-l-warn/85';
    case 'hold':
      return 'border-l-sky-400/75';
    case 'wait':
      return 'border-l-violet-400/55';
    case 'skip':
      return 'border-l-base-600/60';
    default:
      return 'border-l-accent/70';
  }
}

/** 置信度微胶囊配色（深浅主题均可读）。 */
function confidenceChipClass(confidence: number): string {
  if (confidence >= 70) {
    return 'bg-up/12 text-up';
  }
  if (confidence >= 50) {
    return "bg-sky-500/12 text-sky-300 [[data-skin='light']_&]:bg-sky-500/10 [[data-skin='light']_&]:text-sky-700";
  }
  return 'bg-warn/12 text-warn';
}

/**
 * 轻量量化文本语义高亮：不改写模型原话，只把涨跌百分比（+X% / -X%）、AI500 评分、
 * ATR / 净RR / 量比等关键量化锚点柔和提亮，消除大段纯灰文字墙的阅读疲劳。
 */
const REASONING_HIGHLIGHT_RE =
  /([+-]\d+(?:\.\d+)?%|\b\d{2,3}\s*分(?!钟)|(?:\d+(?:\.\d+)?×ATR)|(?:ATR15m\s*\d+(?:\.\d+)?%)|(?:净?RR\s*[≈<>≤≥]=?\s*\d+(?:\.\d+)?(?::\d+(?:\.\d+)?)?)|(?:量比\s*(?:仅|约)?\s*\d+(?:\.\d+)?x))/g;

function FormattedReasoning({ text }: { text: string }) {
  const cleaned = plainText(text);
  const parts = cleaned.split(REASONING_HIGHLIGHT_RE);
  return (
    <p className="mt-1.5 min-w-0 break-words text-[12.5px] leading-[1.68] tracking-[0.005em] text-ink-mid">
      {parts.map((part, idx) => {
        if (!part) return null;
        if (/^\+\d+(?:\.\d+)?%$/.test(part)) {
          return (
            <span key={idx} className="num font-medium text-up">
              {part}
            </span>
          );
        }
        if (/^-\d+(?:\.\d+)?%$/.test(part)) {
          return (
            <span key={idx} className="num font-medium text-down">
              {part}
            </span>
          );
        }
        if (/^\d{2,3}\s*分$/.test(part)) {
          const score = Number.parseInt(part, 10);
          const tone =
            score >= 75
              ? 'bg-up/12 text-up'
              : score >= 65
                ? 'bg-warn/12 text-warn'
                : 'bg-base-800 text-ink-hi';
          return (
            <span
              key={idx}
              className={cn('num mx-0.5 inline-block rounded px-1 py-px text-[11.5px] font-semibold leading-tight', tone)}
            >
              {part}
            </span>
          );
        }
        if (
          /×ATR$/.test(part) ||
          /^ATR15m/.test(part) ||
          /^净?RR/.test(part) ||
          /^量比/.test(part)
        ) {
          return (
            <span key={idx} className="num font-medium text-ink-hi/95">
              {part}
            </span>
          );
        }
        return <span key={idx}>{part}</span>;
      })}
    </p>
  );
}

export function DecisionRow({
  decision,
  price,
  outcome,
  figureContext,
  duplicate,
  onSelectSymbol,
}: {
  decision: Decision;
  price: number | null;
  outcome: ExecutionLogEntry | null;
  figureContext?: FigureContext | null;
  duplicate?: { nth: number; total: number };
  onSelectSymbol?: (symbol: string) => void;
}) {
  const figures = figureParts(decision, price, figureContext);
  const canSelect = Boolean(onSelectSymbol && isClickableSymbol(decision.symbol));
  /* 调整保护位成功且无额外风控推翻时，把「✓ 已执行」直接并入参数胶囊同一行，省去重复的整行说明。 */
  const inlineAdjustOk =
    figures.length > 0 &&
    decision.action === 'adjust_protection' &&
    outcome?.status === 'ok' &&
    ((outcome.adjustments?.length ? outcome.adjustments : decision.adjustments) ?? []).length === 0;

  return (
    <div className={cn('min-w-0 border-l-2 pl-2.5', actionRailClass(decision.action))}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {canSelect ? (
          <button
            type="button"
            onClick={() => onSelectSymbol!(decision.symbol.trim().toUpperCase())}
            title={`点击在左侧行情图表查看 ${decision.symbol}`}
            className="group -mx-1 inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition hover:bg-base-800/80"
          >
            <CoinIcon symbol={decision.symbol} />
            <span className="min-w-0 truncate font-mono text-[14px] font-bold tracking-tight text-ink-hi underline-offset-2 transition-colors group-hover:text-accent group-hover:underline">
              {decision.symbol}
            </span>
          </button>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-2">
            <CoinIcon symbol={decision.symbol} />
            <span className="min-w-0 truncate font-mono text-[14px] font-bold tracking-tight text-ink-hi">
              {decision.symbol}
            </span>
          </span>
        )}

        {decision.confidence == null ? (
          <span
            className="shrink-0 text-[11px] text-ink-faint/80"
            title="模型这一条决策里没有给出 confidence 字段。"
          >
            置信度 未给出
          </span>
        ) : (
          <span
            className={cn(
              'num shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none',
              confidenceChipClass(decision.confidence),
            )}
            title={`模型对本条决策的置信度评估：${decision.confidence}%`}
          >
            置信度 {decision.confidence}%
          </span>
        )}

        {duplicate && duplicate.total > 1 && (
          <span
            className="shrink-0 rounded bg-base-800 px-1.5 py-0.5 text-[10px] text-ink-lo"
            title={
              `模型这一轮对 ${decision.symbol} 给了 ${duplicate.total} 条决策 —— ` +
              '下面这些是它的原话，没有被去重（去重等于替模型改写记录）。'
            }
          >
            第 {duplicate.nth}/{duplicate.total} 条
          </span>
        )}

        <ActionBadge action={decision.action} reasoning={decision.reasoning} className="ml-auto shrink-0" />
      </div>

      {decision.reasoning && <FormattedReasoning text={decision.reasoning} />}

      {figures.length > 0 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs leading-relaxed text-ink-lo">
          {figures.map((part, index) => {
            const style = FIGURE_PILL_STYLE[part.key];
            return (
              <span
                key={`${part.label}-${part.value}-${index}`}
                className={cn(
                  'inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5',
                  style.box,
                )}
                data-aq-tip={part.tooltip ?? FIGURE_TITLE[part.key]}
              >
                {part.label && <span className={cn('text-[11px]', style.label)}>{part.label}</span>}
                <span className={cn('num break-all text-[13px] font-semibold', style.value)}>
                  {part.value}
                </span>
                {part.sub && (
                  <span className={cn('num text-[11px] font-medium', style.label)}>
                    {part.sub}
                  </span>
                )}
              </span>
            );
          })}
          {inlineAdjustOk && outcome && (
            <Badge
              tone="up"
              className="shrink-0"
              data-aq-tip={plainText(humanizeToolNames(outcome.detail ?? '已调整保护位'))}
            >
              ✓ {STATUS_LABELS.ok}
            </Badge>
          )}
        </p>
      )}

      {/* 这一条决策在运行时到底发生了什么（含风控干预与命中熔断的原因）。 */}
      {!inlineAdjustOk && <DecisionOutcome decision={decision} entry={outcome} hasFigures={figures.length > 0} />}
    </div>
  );
}

/**
 * 一条决策的**执行结果**。
 *
 * ## 为什么它必须长在决策行上
 *
 * "为什么什么都没发生？"是操作者最常问的问题，而答案几乎总是这条决策被执行阶段
 * 拦住了 —— 熔断、冷却、安全模式、没有行情、没有持仓可平。这些原因以前一条都
 * 不显示（只过滤了 `rejected` / `failed`），于是屏幕上只剩一行像是在下单的提案。
 *
 * ## 四种状态刻意长得不一样
 *
 * - `ok`：安静的 `✓ 已执行` + 成交金额。**不需要抢注意力** —— 真正成交了，
 *   下面的持仓与成交表会说得更详细。
 * - `rejected`：`⚠ 被风控拒绝`，黄色。风控引擎在读模型之前的裁决。
 * - `failed`：`✕ 执行失败`，红色。**试过了**，订单/网络/交易所出了问题，
 *   这是要人去查的事故。
 * - `skipped`：`⊘ 未执行`，中性灰。**没有失败，是我们选择不动手** ——
 *   把它们染成红色会在一次正常的熔断上拉响一次假警报
 *   （`DESIGN.md`：状态不能只靠颜色表达，图标与文字同样要能区分）。
 *
 * ## 没有执行记录时也要说话
 *
 * "运行时没有留下执行记录"本身就是一条信息：它意味着这一条决策**没走到执行那一步**
 * （在解析、风控之前就被丢掉了，或者记录不完整）。留白会让操作者以为"大概是
 * 在排队执行" —— 而这恰恰是这次要修的那类误读。
 */
/** 判断一条风控备注是常规通过/步长取整提示，还是必须醒目展示的风控推翻/硬限制。 */
function splitAdjustmentNotes(notes: ReadonlyArray<string>): {
  overrides: string[];
  routine: string[];
  riskSummary: string | null;
} {
  const overrides: string[] = [];
  const routine: string[] = [];
  let riskSummary: string | null = null;
  for (const raw of notes) {
    const text = raw.trim();
    if (!text) continue;
    const riskMatch = text.match(/^本笔交易风险\s*(\$[\d,.]+)\s*[（(]占权益\s*([\d.]+%)[）)]/);
    if (riskMatch) {
      riskSummary = `风险 ${riskMatch[1]} (${riskMatch[2]})`;
      routine.push(text);
      continue;
    }
    if (
      /^止损距离\s+[\d.]+%\s*[≥>=]/.test(text) ||
      /^名义价值已调整为.*匹配交易所最小下单单位/.test(text)
    ) {
      routine.push(text);
      continue;
    }
    overrides.push(text);
  }
  return { overrides, routine, riskSummary };
}

function DecisionOutcome({
  decision,
  entry,
  hasFigures = false,
}: {
  decision: Decision;
  entry: ExecutionLogEntry | null;
  hasFigures?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const notes = (entry?.adjustments?.length ? entry.adjustments : decision.adjustments) ?? [];

  if (!entry) {
    // 观望 / 跳过 / 维持持有本身不会下单执行，无需在卡片底部刷屏重复提示；
    // 只有真正的可执行动作（开仓/平仓/加减仓/调保护/撤单）缺少执行记录时才显式提醒。
    if (decision.action === 'wait' || decision.action === 'skip' || decision.action === 'hold') {
      return null;
    }
    return (
      <div className="mt-1.5 text-xs leading-relaxed text-ink-faint">
        运行时没有留下这条决策的执行记录 —— 它没有进入执行阶段。
      </div>
    );
  }

  const { label, tone } = outcomeBadge(entry.status);
  const detail = plainText(humanizeToolNames(entry.detail ?? ''));
  const cut = detail.search(/[。；]/);
  const lead = cut >= 0 ? detail.slice(0, cut + 1) : detail;
  const rest = cut >= 0 ? detail.slice(cut + 1).trim() : '';

  const { overrides, routine, riskSummary } = splitAdjustmentNotes(notes);

  /*
   * 限价挂单（`submitted`）上方胶囊已经写明了「限价 X」，徽章也写明了「已挂单（等成交）」，
   * 再另起一行写「已挂限价单 @ X（现价 Y），等待成交；」完全重复；这里只提炼出有用的「现价 Y」
   * 与状态徽章合并在同一行，完整文案收进「详情」按需展开。
   */
  const isRedundantSubmittedLead =
    hasFigures && entry.status === 'submitted' && /^已挂限价单\s*@/.test(lead);
  const submittedMarketPrice = isRedundantSubmittedLead
    ? (lead.match(/[（(]现价\s*([\d,.]+)[）)]/)?.[1] ?? null)
    : null;
  const isRedundantAdjustLead =
    hasFigures &&
    decision.action === 'adjust_protection' &&
    entry.status === 'ok' &&
    /^已调整保护位[：:]/.test(lead);

  const inlineLead = isRedundantSubmittedLead || isRedundantAdjustLead ? '' : lead;
  const hiddenDetail = isRedundantSubmittedLead || isRedundantAdjustLead ? detail : rest;
  const hasMore = hiddenDetail.length > 0 || routine.length > 0;

  return (
    <div className="mt-1.5 min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Badge
          tone={tone}
          className="inline-flex shrink-0 items-center"
          data-aq-tip={!inlineLead && detail ? detail : undefined}
        >
          {label}
        </Badge>
        {entry.notionalUsd !== undefined && (
          <span className="num text-ink-lo" data-aq-tip="实际成交名义价值（USDT）">
            {fmtUsd(entry.notionalUsd, 2)}
          </span>
        )}
        {submittedMarketPrice && (
          <span className="num text-ink-lo" data-aq-tip="挂单当时的最新市场参考价">
            现价 {submittedMarketPrice}
          </span>
        )}
        {riskSummary && (
          <span className="num text-ink-lo" data-aq-tip="按止损距离折算的本笔最大预估亏损及占账户权益比">
            {riskSummary}
          </span>
        )}
        {entry.orderId && (
          <span className="num text-ink-faint" data-aq-tip={`交易所委托号 ${entry.orderId}`}>
            委托 {entry.orderId}
          </span>
        )}
        {inlineLead && (
          <span className="min-w-0 break-words leading-relaxed text-ink-mid">{inlineLead}</span>
        )}
        {hasMore && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="shrink-0 rounded px-1 text-[11px] text-ink-faint transition hover:text-ink-hi"
            data-aq-tip={expanded ? '收起风控与执行明细' : '展开风控校验与完整执行说明'}
          >
            {expanded ? '收起' : '明细'}
          </button>
        )}
      </div>

      {/* 真正的风控推翻/截断（如杠杆或仓位被风控压低）必须始终醒目可见。 */}
      {overrides.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {overrides.map((note, index) => (
            <li key={index} className="break-words text-xs leading-relaxed text-warn/90">
              • {note}
            </li>
          ))}
        </ul>
      )}

      {expanded && hasMore && (
        <div className="mt-1 space-y-0.5 rounded-md border border-base-800/90 bg-base-900/55 px-2 py-1.5 text-[11.5px] leading-relaxed text-ink-lo">
          {hiddenDetail && <p className="break-words text-ink-mid">{hiddenDetail}</p>}
          {routine.length > 0 && (
            <ul className="space-y-0.5">
              {routine.map((note, index) => (
                <li key={index} className="break-words">
                  • {note}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 执行状态 → 徽章。**四种状态都必须在这里有名字**。
 *
 * 这里的 `switch` 而不是一张 `Record` 表：`executionLog[].status` 是服务端与
 * `@aq/shared` 共有的四值联合，将来加第五种状态时，`switch` 的穷尽性检查
 * （`never` 那一支）会直接编译不过 —— 而一张表只会静默地少一个键，
 * 然后那个状态又会像 `skipped` 这次一样从界面上消失。
 *
 * 文案对得上 `DecisionAudit` 的 `STATUS_LABELS`（那三个字是状态码的中文名），
 * 但**语气是决策流自己的**：`skipped` 在这里叫"未执行"而不是"已跳过" ——
 * 操作者要判断的是"这一单有没有下出去"，而"跳过"听起来像一件已经发生过的事，
 * 于是被跳过的那一单看起来就像已经处理完了。
 */
function outcomeBadge(status: ExecutionLogEntry['status']): {
  key: ExecutionLogEntry['status'];
  label: string;
  tone: 'up' | 'warn' | 'down' | 'muted';
} {
  switch (status) {
    case 'ok':
      return { key: status, label: `✓ ${STATUS_LABELS.ok}`, tone: 'up' };
    /*
     * 已挂单、尚未成交（限价入场）。
     *
     * ⚠️ **不能显示成"已执行"** —— 这一轮**没有产生持仓**，而执行摘要里
     * "开仓 N" 数的是 `ok`。说"已执行"会让人去持仓列表找一个不存在的仓位。
     */
    case 'submitted':
      return { key: status, label: `⧗ ${STATUS_LABELS.submitted}（等成交）`, tone: 'muted' };
    case 'rejected':
      return { key: status, label: `⚠ 被风控拒绝`, tone: 'warn' };
    case 'failed':
      return { key: status, label: `✕ 执行失败`, tone: 'down' };
    case 'skipped':
      return { key: status, label: `⊘ 未执行（${STATUS_LABELS.skipped}）`, tone: 'muted' };
    /*
     * ⚠️ **模型主动要了数据 —— 这是"它在主动工作"最直接的可见证据。**
     *
     * 用户 2026-10-02：「我打开网页，就能方便快捷**看到模型在做什么**」。
     * 而在这之前，"它去要了 K 线"只活在实时事件流里，**翻历史一条都查不到** ——
     * 于是操作员无法分辨"这一轮它只是把系统给的候选看了一遍"与
     * "它自己动手去挖了数据"。
     */
    case 'data':
      return { key: status, label: `⇣ ${STATUS_LABELS.data}`, tone: 'muted' };
    default: {
      // 穷尽性检查：`status` 只能是上面六种。少写一种，这一行会编译报错。
      const exhaustive: never = status;
      return { key: exhaustive, label: status, tone: 'muted' };
    }
  }
}

/* `figureParts` / `FIGURE_TITLE` / `FIGURE_PILL_STYLE` 已抽出至 `../lib/decisionFigures.ts`（供决策流与单轮审计详情页共用）。 */

/**
 * 一条**没有配上决策**的执行记录，一行小字。
 *
 * 正常路径上这个组件不会被调用（见 `CycleBlock` 里 `plan.leftover` 的说明）：
 * 每一条执行记录现在都挂在它对应的决策行上，连同原因一起。这里保留它，
 * 是为了让"配不上决策的条目"仍然可见 —— 丢掉它们就等于又一次让界面
 * 对已经发生过的事情沉默。
 *
 * 四种状态全在这里有名字：`skipped` 以前会和 `failed` 一起被当成"执行失败"，
 * 那是两种完全不同的事件。
 */
export function LogLine({
  entry,
  onSelectSymbol,
}: {
  entry: ExecutionLogEntry;
  onSelectSymbol?: (symbol: string) => void;
}) {
  const { label, tone } = logLineStyle(entry.status);
  const [expanded, setExpanded] = useState(false);

  /*
   * `skip_cycle` 是**整轮被跳过**的通知，不属于任何标的。
   *
   * 它没有真实的 action / symbol 可显示 —— 硬拼出来只会得到
   * `skip_cycle — — <说明>`：一个没登记标签的机器码、一个占位破折号，
   * 再加一个分隔符破折号。而 `detail` 已经把话说完（为什么跳过、什么时候恢复），
   * 所以这类条目直接给说明。见 `AGENTS.md` §5.2：机器码可以是英文，
   * **但面向操作员的文本必须走中文标签**，不能把机器码原样显示出来。
   */
  const isCycleNotice =
    entry.action === 'skip_cycle' ||
    (entry.status === 'data' && (!entry.symbol || entry.symbol === '-'));

  /*
   * ⚠️ **折叠规则与 `DecisionOutcome` 相同：第一句始终可见，其余收起。**
   *
   * 这里是**文字墙真正的来源**，不是 `DecisionOutcome`。整轮被跳过时
   * `decisions` 是空数组，于是这条记录配不到任何决策，落到 `plan.leftover`
   * 走这个组件；而它的 `detail` 实测有四行：
   *
   *   总回撤熔断：权益较最高水位 $9.54 回撤了 21.00%（上限 20%）。注意：总回撤熔断
   *   不按日重置 —— …（例如入金，或调整这一上限）。且当前没有任何持仓。本轮没有向
   *   模型提问、也没有下单 —— …跳过请求是为了不产生无谓的 token 开销。
   *
   * 而它**每一轮都出现**，连续几十轮一字不差。第一句就是操作者要的答案
   * （"这一轮为什么什么都没做"），后面全是补充说明与建议。
   *
   * 改这里之前先在那台跑着的控制台上看一眼右栏 —— 那次我改了 `DecisionOutcome`
   * 就以为完事了，而屏幕上的文字墙一行都没少。
   */
  /* ⚠️ `plainText`：理由里的 `**` 是写给模型/维护者的强调符，不该露给用户（见 `lib/plainText.ts`）。 */
  const detail = plainText(humanizeToolNames(entry.detail ?? ''));
  if (isManagedTrajectoryEntry(entry)) {
    const chips = resolveManagedStageChips(entry);
    if (chips.length === 0) return null;
    return (
      <li className="min-w-0">
        <ManagedStageActionBar chips={chips} onSelectSymbol={onSelectSymbol} />
      </li>
    );
  }

  const cut = detail.search(/[。；]/);
  const lead = cut >= 0 ? detail.slice(0, cut + 1) : detail;
  const rest = cut >= 0 ? detail.slice(cut + 1).trim() : '';

  return (
    <li className="min-w-0 text-xs leading-relaxed">
      <div className="flex min-w-0 items-start gap-1.5">
        <span className={cn('shrink-0', tone)}>{label}</span>
        <span className="min-w-0 break-words text-ink-lo">
          {!isCycleNotice && (
            <span className="num text-ink-mid">
              {actionLabel(entry.action)} {entry.symbol}
            </span>
          )}
          {lead ? `${isCycleNotice ? '' : ' — '}${lead}` : ''}
          {rest && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              title={expanded ? '收起剩余说明' : '展开剩余说明'}
              className="ml-1 shrink-0 text-ink-faint transition hover:text-ink-hi"
            >
              {expanded ? '收起' : '详情'}
            </button>
          )}
        </span>
      </div>
      {expanded && rest && (
        <p className="mt-0.5 min-w-0 break-words pl-1 text-ink-mid">{rest}</p>
      )}
    </li>
  );
}

/** `LogLine` 的标记与颜色。五种状态各自可辨，见 `outcomeBadge` 的同一条理由。 */
function logLineStyle(status: ExecutionLogEntry['status']): { label: string; tone: string } {
  switch (status) {
    case 'ok':
      return { label: `✓ ${STATUS_LABELS.ok}`, tone: 'text-up' };
    case 'submitted':
      return { label: `⧗ ${STATUS_LABELS.submitted}`, tone: 'text-ink-lo' };
    case 'rejected':
      return { label: `⚠ 被风控拒绝`, tone: 'text-warn' };
    case 'failed':
      return { label: `✕ 执行失败`, tone: 'text-down' };
    case 'skipped':
      return { label: `⊘ 未执行`, tone: 'text-ink-lo' };
    /* 模型主动取数 —— 它在主动工作，而不是只把系统给的候选看了一遍。 */
    case 'data':
      return { label: `⇣ ${STATUS_LABELS.data}`, tone: 'text-ink-lo' };
    default: {
      const exhaustive: never = status;
      return { label: exhaustive, tone: 'text-ink-lo' };
    }
  }
}

