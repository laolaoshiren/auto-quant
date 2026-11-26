/**
 * 智能托管 2.0 周期动作胶囊条 + 可点击展开的内联详情抽屉。
 *
 * 2026-11-26 重构（替代旧版无交互彩虹 Powerline 尖箭头条）：
 * - 彻底移除重复/无信息量的「步骤」占位与「提交(N)」重复计数（下方/上方已展示完整决策列表）；
 * - 仅保留真正有业务价值的过程动作：大盘定调（含真实格局摘要）、观察笔记写入/反例/清理、
 *   持仓论点修订、补查 K 线、提前复查预约（<15m）以及轮次上限兜底告警；
 * - 每个胶囊都是真实可点击按钮：点击在下方原地展开结构化详情（完整正文、高亮触发条件、
 *   方向/信心度、轮次，以及一键「查看 K 线」跳转图表）；
 * - 若旧版历史周期只有裸 `plan → finalize(N)` 且无任何笔记/论点/K 线，则整条安静隐藏不占版面。
 */
import { useState } from 'react';
import type { ExecutionLogEntry, ManagedStageStep, ManagedStageStepKind } from '@aq/shared';
import {
  Activity,
  AlertTriangle,
  Bookmark,
  ChevronDown,
  Clock,
  Compass,
  Flag,
  LineChart,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from './ui';

export interface ResolvedStageChip {
  id: string;
  kind: ManagedStageStepKind | 'early_check';
  /** 胶囊短文案 */
  label: string;
  /** 可选方向圆点（仅笔记更新偏多/偏空时显示） */
  biasDot?: 'long' | 'short';
  /** 抽屉主标题 */
  heading: string;
  /** 关联标的（存在时可一键跳转看 K 线） */
  symbol?: string;
  round?: number;
  summary?: string;
  meta?: Array<{ label: string; value: string }>;
  /** 是否为升级前的旧版纯文本回退记录（无正文持久化） */
  legacy?: boolean;
}

const TRAJECTORY_PREFIX_RE = /三段式决策轨迹[：:]\s*(.+)$/;

function shortSymbol(sym: string): string {
  return sym.replace(/USDT$/i, '');
}

function truncateText(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}…`;
}

/** 判断一条执行日志是否为三段式决策轨迹条目。 */
export function isManagedTrajectoryEntry(entry: ExecutionLogEntry): boolean {
  if (entry.status !== 'data') return false;
  if (Array.isArray(entry.stageSteps) && entry.stageSteps.length > 0) return true;
  return TRAJECTORY_PREFIX_RE.test((entry.detail ?? '').trim());
}

/** 从结构化 `stageSteps` 或旧版 `三段式决策轨迹：...` 文本中提炼出真正有信息量的可交互胶囊。 */
export function resolveManagedStageChips(
  entry: ExecutionLogEntry,
  options?: { includeFinalizeSummary?: boolean },
): ResolvedStageChip[] {
  if (entry.status !== 'data') return [];

  if (Array.isArray(entry.stageSteps) && entry.stageSteps.length > 0) {
    return buildChipsFromStructured(entry.stageSteps, options);
  }
  return buildChipsFromLegacyDetail(entry.detail ?? '');
}

function buildChipsFromStructured(
  steps: readonly ManagedStageStep[],
  options?: { includeFinalizeSummary?: boolean },
): ResolvedStageChip[] {
  const chips: ResolvedStageChip[] = [];

  steps.forEach((step, idx) => {
    if (step.kind === 'plan') {
      const regime = step.summary?.trim();
      if (!regime && (!step.meta || step.meta.length === 0)) return;
      chips.push({
        id: `plan-${idx}`,
        kind: 'plan',
        label: regime ? `大盘 · ${truncateText(regime, 18)}` : '大盘定调',
        heading: '本轮大盘定调与聚焦',
        round: step.round,
        summary: regime,
        meta: step.meta,
      });
      return;
    }

    if (step.kind === 'note') {
      const sym = step.symbol;
      const biasVal = step.meta?.find((m) => m.label === '方向')?.value;
      const biasDot = biasVal === '偏多' ? 'long' : biasVal === '偏空' ? 'short' : undefined;
      chips.push({
        id: `note-${sym ?? idx}-${idx}`,
        kind: 'note',
        label: sym ? `笔记 ${shortSymbol(sym)}` : step.title,
        biasDot,
        heading: sym ? `${sym} · 观察笔记` : step.title,
        symbol: sym,
        round: step.round,
        summary: step.summary,
        meta: step.meta,
      });
      return;
    }

    if (step.kind === 'note_ce') {
      const sym = step.symbol;
      chips.push({
        id: `note_ce-${sym ?? idx}-${idx}`,
        kind: 'note_ce',
        label: step.title,
        heading: sym ? `${sym} · 笔记反例` : step.title,
        symbol: sym,
        round: step.round,
        summary: step.summary,
        meta: step.meta,
      });
      return;
    }

    if (step.kind === 'note_del') {
      const sym = step.symbol;
      chips.push({
        id: `note_del-${sym ?? idx}-${idx}`,
        kind: 'note_del',
        label: step.title,
        heading: sym ? `${sym} · 清理观察笔记` : step.title,
        symbol: sym,
        round: step.round,
        summary: step.summary,
      });
      return;
    }

    if (step.kind === 'thesis') {
      const sym = step.symbol;
      chips.push({
        id: `thesis-${sym ?? idx}-${idx}`,
        kind: 'thesis',
        label: sym ? `论点 ${shortSymbol(sym)}` : step.title,
        heading: sym ? `${sym} · 持仓论点修订` : step.title,
        symbol: sym,
        round: step.round,
        summary: step.summary,
        meta: step.meta,
      });
      return;
    }

    if (step.kind === 'klines' || step.kind === 'klines_dup' || step.kind === 'klines_cap') {
      const sym = step.symbol;
      chips.push({
        id: `${step.kind}-${sym ?? idx}-${idx}`,
        kind: step.kind,
        label: step.title,
        heading: sym ? `${sym} · K 线查验` : step.title,
        symbol: sym,
        round: step.round,
        summary: step.summary,
      });
      return;
    }

    if (step.kind === 'finalize') {
      const nextCheckItem = step.meta?.find((m) => m.label === '下次复查');
      const isEarlyCheck = Boolean(nextCheckItem?.value.startsWith('提前'));
      if (isEarlyCheck && nextCheckItem) {
        chips.push({
          id: `early-check-${idx}`,
          kind: 'early_check',
          label: `${nextCheckItem.value}复查`,
          heading: '动态提前复查预约',
          round: step.round,
          summary:
            step.summary ??
            '模型判断标的临近关键位或存在待成交挂单，主动缩短下一轮看盘间隔。',
          meta: step.meta,
        });
      } else if (options?.includeFinalizeSummary && step.meta && step.meta.length > 0) {
        const roundItem = step.meta.find((m) => m.label === '工具轮次');
        chips.push({
          id: `finalize-${idx}`,
          kind: 'finalize',
          label: roundItem ? `多轮协作 · ${roundItem.value}` : step.title,
          heading: '本轮工具协作摘要',
          round: step.round,
          summary: step.summary,
          meta: step.meta,
        });
      }
      return;
    }

    if (step.kind === 'fallback') {
      chips.push({
        id: `fallback-${idx}`,
        kind: 'fallback',
        label: '轮次上限兜底',
        heading: '达到工具轮次上限 · 安全兜底',
        round: step.round,
        summary: step.summary,
      });
    }
  });

  return chips;
}

function buildChipsFromLegacyDetail(raw: string): ResolvedStageChip[] {
  const m = TRAJECTORY_PREFIX_RE.exec(raw.trim());
  if (!m?.[1]) return [];
  const tokens = m[1]
    .split(/\s*→\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return [];

  const chips: ResolvedStageChip[] = [];

  tokens.forEach((tok, idx) => {
    // 旧版纯文本里 `plan` 和 `finalize(N)` 没有任何正文信息，且下方已展示全部决策，直接过滤掉避免多余噪音
    if (tok === 'plan' || /^finalize(?:\(\d+\))?$/i.test(tok) || tok === 'direct_decision') {
      return;
    }

    const noteMatch = /^note:(.+)$/i.exec(tok);
    if (noteMatch?.[1]) {
      const sym = noteMatch[1].trim();
      chips.push({
        id: `legacy-note-${sym}-${idx}`,
        kind: 'note',
        label: `笔记 ${shortSymbol(sym)}`,
        heading: `${sym} · 更新观察笔记`,
        symbol: sym,
        legacy: true,
        summary: '本轮模型更新了该标的的跨轮观察笔记与触发条件。',
      });
      return;
    }

    const ceMatch = /^note_ce:([^(]+)(?:\(#(\d+)\))?$/i.exec(tok);
    if (ceMatch?.[1]) {
      const sym = ceMatch[1].trim();
      const count = ceMatch[2];
      chips.push({
        id: `legacy-ce-${sym}-${idx}`,
        kind: 'note_ce',
        label: count ? `反例 ${shortSymbol(sym)} #${count}` : `反例 ${shortSymbol(sym)}`,
        heading: `${sym} · 记录观察反例`,
        symbol: sym,
        legacy: true,
        summary: count
          ? `原有观察假设被市场证伪，反例计数累加至第 ${count} 次。`
          : '原有观察假设被市场证伪，已记录反例衰减。',
      });
      return;
    }

    const delMatch = /^note_del:(.+)$/i.exec(tok);
    if (delMatch?.[1]) {
      const sym = delMatch[1].trim();
      chips.push({
        id: `legacy-del-${sym}-${idx}`,
        kind: 'note_del',
        label: `清笔记 ${shortSymbol(sym)}`,
        heading: `${sym} · 清理失效笔记`,
        symbol: sym,
        legacy: true,
        summary: '本轮清理了该标的已失效的观察笔记。',
      });
      return;
    }

    const thesisMatch = /^thesis:(.+)$/i.exec(tok);
    if (thesisMatch?.[1]) {
      const sym = thesisMatch[1].trim();
      chips.push({
        id: `legacy-thesis-${sym}-${idx}`,
        kind: 'thesis',
        label: `论点 ${shortSymbol(sym)}`,
        heading: `${sym} · 修订持仓论点`,
        symbol: sym,
        legacy: true,
        summary: '本轮更新了该持仓的结构化论点（加减仓条件 / 时间止损 / MAE 硬线）。',
      });
      return;
    }

    const klineMatch = /^(klines|kline|klines_dup|klines_cap):(.+)$/i.exec(tok);
    if (klineMatch?.[1] && klineMatch[2]) {
      const rawKind = klineMatch[1].toLowerCase();
      const kind: ManagedStageStepKind =
        rawKind === 'klines_dup' ? 'klines_dup' : rawKind === 'klines_cap' ? 'klines_cap' : 'klines';
      const [rawSym, tf] = klineMatch[2].split(':');
      const sym = rawSym?.trim() || undefined;
      const short = sym ? shortSymbol(sym) : klineMatch[2];
      chips.push({
        id: `legacy-kline-${tok}-${idx}`,
        kind,
        label:
          kind === 'klines'
            ? `K线 ${short}${tf ? ` ${tf}` : ''}`
            : kind === 'klines_dup'
              ? `拦截重复K线 ${short}`
              : `查K限流 ${short}`,
        heading: `${sym ?? klineMatch[2]} · K 线查验`,
        symbol: sym,
        legacy: true,
        summary:
          kind === 'klines'
            ? `模型主动补查了 ${sym ?? ''} ${tf ?? ''} K 线用于辅助判断。`
            : kind === 'klines_dup'
              ? '该周期 K 线已在档案中提供，系统拦截重复拉取。'
              : '本轮额外 K 线查验达到次数上限。',
      });
      return;
    }

    if (tok === 'fallback_hold_wait') {
      chips.push({
        id: `legacy-fallback-${idx}`,
        kind: 'fallback',
        label: '轮次上限兜底',
        heading: '达到工具轮次上限 · 安全兜底',
        legacy: true,
        summary: '工具调用达到轮次上限未及时提交，系统自动按高观望纪律保持原仓位与观望。',
      });
    }
  });

  return chips;
}

const CHIP_STYLE: Record<
  ResolvedStageChip['kind'],
  { idle: string; active: string; icon: typeof Compass }
> = {
  plan: {
    idle: "border-sky-400/25 bg-sky-500/8 text-sky-300/90 hover:border-sky-400/50 hover:bg-sky-500/15 [[data-skin='light']_&]:border-sky-700/25 [[data-skin='light']_&]:bg-sky-500/8 [[data-skin='light']_&]:text-sky-800 [[data-skin='light']_&]:hover:bg-sky-500/15",
    active:
      "border-sky-400/65 bg-sky-500/18 text-sky-200 ring-1 ring-sky-400/30 [[data-skin='light']_&]:border-sky-700/55 [[data-skin='light']_&]:bg-sky-500/18 [[data-skin='light']_&]:text-sky-900",
    icon: Compass,
  },
  note: {
    idle: "border-violet-400/25 bg-violet-500/8 text-violet-300/90 hover:border-violet-400/50 hover:bg-violet-500/15 [[data-skin='light']_&]:border-violet-700/25 [[data-skin='light']_&]:bg-violet-500/8 [[data-skin='light']_&]:text-violet-800 [[data-skin='light']_&]:hover:bg-violet-500/15",
    active:
      "border-violet-400/65 bg-violet-500/18 text-violet-200 ring-1 ring-violet-400/30 [[data-skin='light']_&]:border-violet-700/55 [[data-skin='light']_&]:bg-violet-500/18 [[data-skin='light']_&]:text-violet-900",
    icon: Bookmark,
  },
  note_ce: {
    idle: "border-amber-400/30 bg-amber-500/10 text-amber-300/90 hover:border-amber-400/55 hover:bg-amber-500/16 [[data-skin='light']_&]:border-amber-700/25 [[data-skin='light']_&]:bg-amber-500/10 [[data-skin='light']_&]:text-amber-800",
    active:
      "border-amber-400/70 bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/30 [[data-skin='light']_&]:border-amber-700/60 [[data-skin='light']_&]:bg-amber-500/20 [[data-skin='light']_&]:text-amber-900",
    icon: AlertTriangle,
  },
  note_del: {
    idle: 'border-down/25 bg-down/8 text-down/90 hover:border-down/50 hover:bg-down/15',
    active: 'border-down/60 bg-down/18 text-down ring-1 ring-down/30',
    icon: Trash2,
  },
  thesis: {
    idle: 'border-up/30 bg-up/10 text-up/90 hover:border-up/55 hover:bg-up/16',
    active: 'border-up/65 bg-up/18 text-up ring-1 ring-up/30',
    icon: Flag,
  },
  klines: {
    idle: "border-cyan-400/25 bg-cyan-500/8 text-cyan-300/90 hover:border-cyan-400/50 hover:bg-cyan-500/15 [[data-skin='light']_&]:border-cyan-700/25 [[data-skin='light']_&]:bg-cyan-500/8 [[data-skin='light']_&]:text-cyan-800",
    active:
      "border-cyan-400/65 bg-cyan-500/18 text-cyan-200 ring-1 ring-cyan-400/30 [[data-skin='light']_&]:border-cyan-700/55 [[data-skin='light']_&]:bg-cyan-500/18 [[data-skin='light']_&]:text-cyan-900",
    icon: Activity,
  },
  klines_dup: {
    idle: 'border-base-700 bg-base-850/70 text-ink-lo hover:border-base-600 hover:text-ink-hi',
    active: 'border-base-600 bg-base-800 text-ink-hi ring-1 ring-base-600/40',
    icon: Activity,
  },
  klines_cap: {
    idle: 'border-base-700 bg-base-850/70 text-ink-lo hover:border-base-600 hover:text-ink-hi',
    active: 'border-base-600 bg-base-800 text-ink-hi ring-1 ring-base-600/40',
    icon: AlertTriangle,
  },
  early_check: {
    idle: "border-amber-400/30 bg-amber-500/10 text-amber-300/90 hover:border-amber-400/55 hover:bg-amber-500/16 [[data-skin='light']_&]:border-amber-700/25 [[data-skin='light']_&]:bg-amber-500/10 [[data-skin='light']_&]:text-amber-800",
    active:
      "border-amber-400/70 bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/30 [[data-skin='light']_&]:border-amber-700/60 [[data-skin='light']_&]:bg-amber-500/20 [[data-skin='light']_&]:text-amber-900",
    icon: Clock,
  },
  finalize: {
    idle: 'border-base-700 bg-base-850/70 text-ink-lo hover:border-base-600 hover:text-ink-hi',
    active: 'border-base-600 bg-base-800 text-ink-hi ring-1 ring-base-600/40',
    icon: Compass,
  },
  fallback: {
    idle: 'border-down/30 bg-down/10 text-down hover:border-down/55 hover:bg-down/16',
    active: 'border-down/65 bg-down/20 text-down ring-1 ring-down/35',
    icon: AlertTriangle,
  },
};

const HIGHLIGHT_META_LABELS = new Set(['触发条件', '加仓条件', '减仓目标', '失效条件']);

/**
 * 可交互的智能托管过程动作栏：
 * - 默认呈现为一行克制的语义小胶囊；
 * - 点击任意胶囊在下方原地展开结构化详情（完整正文、触发条件、一键看图）。
 */
export function ManagedStageActionBar({
  chips,
  onSelectSymbol,
  className,
}: {
  chips: ResolvedStageChip[];
  onSelectSymbol?: (symbol: string) => void;
  className?: string;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);

  if (chips.length === 0) return null;

  const activeChip = chips.find((c) => c.id === activeId) ?? null;

  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="本轮模型动作记录">
        {chips.map((chip) => {
          const style = CHIP_STYLE[chip.kind];
          const Icon = style.icon;
          const isOpen = activeChip?.id === chip.id;

          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => setActiveId((prev) => (prev === chip.id ? null : chip.id))}
              aria-expanded={isOpen}
              className={cn(
                'inline-flex h-[22px] max-w-full cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px] font-medium leading-none transition',
                isOpen ? style.active : style.idle,
              )}
            >
              <Icon className="h-3 w-3 shrink-0 opacity-85" aria-hidden />
              {chip.biasDot && (
                <span
                  aria-hidden
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    chip.biasDot === 'long' ? 'bg-up' : 'bg-down',
                  )}
                />
              )}
              <span className="truncate">{chip.label}</span>
              <ChevronDown
                aria-hidden
                className={cn(
                  'h-2.5 w-2.5 shrink-0 opacity-65 transition-transform duration-150',
                  isOpen && 'rotate-180 opacity-100',
                )}
              />
            </button>
          );
        })}
      </div>

      {activeChip && (
        <div className="mt-2 rounded-lg border border-base-750/90 bg-base-900/75 px-3 py-2.5 text-xs leading-relaxed">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-medium text-ink-hi">{activeChip.heading}</span>
              {activeChip.round != null && (
                <span className="rounded border border-base-700 bg-base-850 px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
                  第 {activeChip.round} 轮
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {activeChip.symbol && onSelectSymbol && (
                <button
                  type="button"
                  onClick={() => onSelectSymbol(activeChip.symbol!)}
                  className="inline-flex h-6 cursor-pointer items-center gap-1 rounded border border-base-700 bg-base-850 px-2 text-[11px] text-ink-mid transition hover:border-accent/50 hover:text-ink-hi"
                >
                  <LineChart className="h-3 w-3 text-accent" aria-hidden />
                  <span>看 K 线</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setActiveId(null)}
                aria-label="收起详情"
                className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-ink-faint transition hover:bg-base-800 hover:text-ink-hi"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>

          {activeChip.summary && (
            <p className="mt-1.5 break-words text-[12px] leading-relaxed text-ink-mid">
              {activeChip.summary}
            </p>
          )}

          {activeChip.meta && activeChip.meta.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              {/* 短标签元数据（方向 / 信心 / 轮次 / 时间止损 / MAE）横向排 */}
              {activeChip.meta.some((m) => !HIGHLIGHT_META_LABELS.has(m.label) && m.value.length <= 24) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {activeChip.meta
                    .filter((m) => !HIGHLIGHT_META_LABELS.has(m.label) && m.value.length <= 24)
                    .map((item, i) => (
                      <span
                        key={`${item.label}-${i}`}
                        className="inline-flex items-center gap-1 rounded border border-base-750 bg-base-850/80 px-1.5 py-0.5 text-[11px]"
                      >
                        <span className="text-ink-faint">{item.label}</span>
                        <span
                          className={cn(
                            'font-medium',
                            item.value === '偏多'
                              ? 'text-up'
                              : item.value === '偏空'
                                ? 'text-down'
                                : 'text-ink-hi',
                          )}
                        >
                          {item.value}
                        </span>
                      </span>
                    ))}
                </div>
              )}

              {/* 长文本结构化字段（触发条件 / 加仓条件 / 减仓目标 / 失效条件 / 持仓聚焦）单行清晰展示 */}
              {activeChip.meta
                .filter((m) => HIGHLIGHT_META_LABELS.has(m.label) || m.value.length > 24)
                .map((item, i) => {
                  const isTrigger = HIGHLIGHT_META_LABELS.has(item.label);
                  return (
                    <div
                      key={`${item.label}-row-${i}`}
                      className={cn(
                        'rounded-md border px-2.5 py-1.5 text-[11.5px] leading-relaxed',
                        isTrigger
                          ? "border-amber-400/25 bg-amber-500/8 [[data-skin='light']_&]:border-amber-700/25 [[data-skin='light']_&]:bg-amber-500/8"
                          : 'border-base-750/80 bg-base-850/60',
                      )}
                    >
                      <span
                        className={cn(
                          'mr-1.5 font-semibold',
                          isTrigger
                            ? "text-amber-300 [[data-skin='light']_&]:text-amber-800"
                            : 'text-ink-lo',
                        )}
                      >
                        {item.label}
                      </span>
                      <span className="break-words text-ink-hi">{item.value}</span>
                    </div>
                  );
                })}
            </div>
          )}

          {activeChip.legacy && (
            <p className="mt-1.5 text-[11px] text-ink-faint">
              历史旧版周期仅留存动作标记；升级后的新周期将直接在此展示完整大盘定调、笔记正文与数字触发条件（当前生效笔记可在上方「AI500 雷达 → 观察笔记」查看）。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
