/**
 * M3.4 智能托管 2.0 雷达 AI500 评分 + 持仓论点 `thesis` + 反例衰减笔记紧凑面板。
 *
 * 严格遵循 Quill 设计原则：高信息密度、语义彩色标签、零多余装饰、不抢图表高度、窄屏零横向溢出。
 * 仅在 `trader.mode === 'ai_managed'` 的详情页渲染。
 */

import { useCallback, useState } from 'react';
import { fmtBeijingTime } from '@aq/shared';

import { api, type ManagedIntelView, type ManagedRadarItemView } from '../lib/api';
import { usePolled } from '../lib/hooks';
import { Badge, cn, Panel } from './ui';

interface ManagedIntelPanelProps {
  traderId: number;
  onSelectSymbol?: (symbol: string) => void;
  /** 为真时撑满外部容器并在内容区内部滚动（手动上下拖动图表分割条时启用）。 */
  fillHeight?: boolean;
}

function shortSym(symbol: string): string {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
}

function formatRemaining(iso: string | null): string {
  if (!iso) return '未设';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return '已到期';
  const mins = Math.round(ms / 60_000);
  if (mins >= 60) return `剩 ${(mins / 60).toFixed(1)}h`;
  return `剩 ${mins}m`;
}

function radarBadgeTone(item: ManagedRadarItemView): 'up' | 'down' | 'warn' | 'muted' {
  if (item.tier === 'strong') return item.bias === 'short' ? 'down' : 'up';
  if (item.tier === 'watch') return 'warn';
  return 'muted';
}

export function ManagedIntelPanel({ traderId, onSelectSymbol, fillHeight = false }: ManagedIntelPanelProps) {
  const [notesOpen, setNotesOpen] = useState(false);
  const [intelOpen, setIntelOpen] = useState(false);

  const fetcher = useCallback(
    (signal: AbortSignal) => api.traderManagedIntel(traderId, signal),
    [traderId],
  );
  const query = usePolled<ManagedIntelView>(fetcher, {
    intervalMs: 20_000,
    deps: [traderId],
  });

  const data = query.data;
  const radar = data?.radar ?? null;
  const theses = data?.theses ?? [];
  const notes = data?.notes ?? [];
  const attribution = data?.attribution ?? null;
  const readiness = data?.readiness ?? null;

  if (!radar && theses.length === 0 && notes.length === 0 && !attribution && !readiness) {
    return null;
  }

  return (
    <Panel
      className={fillHeight ? 'flex h-full min-h-0 flex-col' : 'shrink-0'}
      bodyClassName={fillHeight ? 'min-h-0 flex-1 overflow-y-auto' : undefined}
      title="AI500 雷达与持仓论点"
      actions={
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
          {radar?.btcBenchmark && (
            <span className="hidden truncate sm:inline" title={radar.btcBenchmark}>
              {radar.btcBenchmark}
            </span>
          )}
          {(attribution || readiness) && (
            <button
              type="button"
              onClick={() => setIntelOpen((v) => !v)}
              className="rounded px-1.5 py-0.5 text-xs text-ink-lo transition hover:bg-base-800 hover:text-ink-hi"
              title={readiness?.summary ?? attribution?.summaryLine}
            >
              归因/就绪
              {readiness && (
                <span
                  className={cn(
                    'ml-1 inline-block h-1.5 w-1.5 rounded-full align-middle',
                    readiness.overall === 'pass'
                      ? 'bg-up'
                      : readiness.overall === 'warn'
                        ? 'bg-warn'
                        : 'bg-down',
                  )}
                />
              )}{' '}
              {intelOpen ? '▴' : '▾'}
            </button>
          )}
          {notes.length > 0 && (
            <button
              type="button"
              onClick={() => setNotesOpen((v) => !v)}
              className="rounded px-1.5 py-0.5 text-xs text-ink-lo transition hover:bg-base-800 hover:text-ink-hi"
            >
              观察笔记 ({notes.length}) {notesOpen ? '▴' : '▾'}
            </button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-2.5 text-xs">
        {/* 1) AI500 雷达 Top 候选彩色标签条 */}
        {radar && radar.items.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {radar.items.slice(0, 6).map((item) => {
              const dirCn = item.bias === 'long' ? '多' : item.bias === 'short' ? '空' : '中';
              const deltaTxt =
                item.scoreDelta !== null && item.scoreDelta !== 0
                  ? `${item.scoreDelta > 0 ? '+' : ''}${item.scoreDelta}`
                  : '';
              const activeWeights =
                attribution?.applied && attribution.weights
                  ? attribution.weights
                  : { trend: 20, breakout: 20, oiFlow: 15, takerFlow: 15, funding: 15, alphaPosition: 15 };
              const tip = [
                `${item.symbol} AI500：${item.score}/100（${dirCn}）`,
                `· 趋势 / 突破：${item.dimensions.trend}/${activeWeights.trend} · ${item.dimensions.breakout}/${activeWeights.breakout}`,
                `· OI / Taker：${item.dimensions.oiFlow}/${activeWeights.oiFlow} · ${item.dimensions.takerFlow}/${activeWeights.takerFlow}`,
                `· 费率 / Alpha：${item.dimensions.funding}/${activeWeights.funding} · ${item.dimensions.alphaPosition}/${activeWeights.alphaPosition}`,
                item.vpSummary ? `· 筹码：${item.vpSummary}` : '',
                item.tags.length > 0 ? `· 标签：${item.tags.join(' | ')}` : '',
              ]
                .filter(Boolean)
                .join('\n');

              return (
                <button
                  key={item.symbol}
                  type="button"
                  data-aq-tip={tip}
                  onClick={() => onSelectSymbol?.(item.symbol)}
                  className="inline-flex max-w-full items-center gap-1 rounded border border-base-700/70 bg-base-900/60 px-2 py-1 text-left transition hover:border-accent/60 hover:bg-base-800/80"
                >
                  <span className="font-medium text-ink-hi">{shortSym(item.symbol)}</span>
                  <Badge tone={radarBadgeTone(item)}>
                    {item.score}·{dirCn}
                    {deltaTxt ? `(${deltaTxt})` : ''}
                  </Badge>
                  {item.tags[0] && (
                    <span className="hidden max-w-[9rem] truncate text-ink-faint md:inline">
                      {item.tags[0]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* 2) 活跃持仓论点 thesis 紧凑列表 */}
        {theses.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-base-800/80 pt-2">
            {theses.map((t) => {
              const maeRatio =
                t.maxAdverseExcursionPct && t.maxAdverseExcursionPct > 0
                  ? Math.min(100, Math.round((t.worstAdversePct / t.maxAdverseExcursionPct) * 100))
                  : null;
              return (
                <div
                  key={t.id}
                  className="flex flex-col gap-1 rounded border border-base-800/80 bg-base-900/40 px-2.5 py-1.5"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onSelectSymbol?.(t.symbol)}
                      className="font-semibold text-ink-hi hover:text-accent"
                    >
                      {shortSym(t.symbol)}
                    </button>
                    <Badge tone={t.side === 'long' ? 'up' : 'down'}>
                      {t.side === 'long' ? '多头论点' : '空头论点'}
                    </Badge>
                    <Badge tone="muted">峰值 {t.peakR >= 0 ? '+' : ''}{t.peakR.toFixed(2)}R</Badge>
                    <Badge
                      tone={
                        t.timeStopAt && Date.parse(t.timeStopAt) <= Date.now() ? 'warn' : 'accent'
                      }
                      className={t.timeStopAt ? 'cursor-help' : undefined}
                      data-aq-tip={t.timeStopAt ? `时间止损截止：${fmtBeijingTime(t.timeStopAt)}（要求进展 ≥ ${t.minProgressR}R）` : undefined}
                    >
                      时间止损 {formatRemaining(t.timeStopAt)}
                    </Badge>
                    {t.maxAdverseExcursionPct !== null && (
                      <Badge
                        tone={maeRatio !== null && maeRatio >= 75 ? 'down' : 'muted'}
                        className="cursor-help"
                        data-aq-tip={`历史最大不利偏移 ${t.worstAdversePct.toFixed(2)}% / 硬线 ${t.maxAdverseExcursionPct.toFixed(2)}%`}
                      >
                        MAE {t.worstAdversePct.toFixed(1)}%/{t.maxAdverseExcursionPct.toFixed(1)}%
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-ink-lo">
                    {t.entryBasis && (
                      <span className="max-w-full truncate" title={t.entryBasis}>
                        依据：{t.entryBasis}
                      </span>
                    )}
                    {t.addTrigger && (
                      <span className="max-w-full truncate text-up" title={t.addTrigger}>
                        加仓：{t.addTrigger}
                      </span>
                    )}
                    {t.reduceTarget && (
                      <span className="max-w-full truncate text-accent" title={t.reduceTarget}>
                        减仓：{t.reduceTarget}
                      </span>
                    )}
                    {t.invalidation && (
                      <span className="max-w-full truncate text-down" title={t.invalidation}>
                        失效：{t.invalidation}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 3) 可折叠的反例衰减观察笔记 */}
        {notesOpen && notes.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-base-800/80 pt-2">
            {notes.map((n) => (
              <div
                key={n.id}
                className="flex flex-wrap items-center gap-1.5 text-ink-lo"
              >
                <button
                  type="button"
                  onClick={() => onSelectSymbol?.(n.symbol)}
                  className="font-medium text-ink-hi hover:text-accent"
                >
                  {shortSym(n.symbol)}
                </button>
                <Badge tone={n.bias === 'long' ? 'up' : n.bias === 'short' ? 'down' : 'muted'}>
                  {n.bias === 'long' ? '偏多' : n.bias === 'short' ? '偏空' : '中性'}
                </Badge>
                {n.counterexamples > 0 && (
                  <Badge tone="warn">
                    反例×{n.counterexamples} (权重{Math.round(n.effectiveWeight * 100)}%)
                  </Badge>
                )}
                <span className={cn('truncate text-ink-hi')} title={n.triggerCondition}>
                  触发[{n.triggerCondition}]
                </span>
                <span className="truncate text-ink-faint" title={n.note}>
                  {n.note}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* 4) 可折叠的 M4.3 因子归因校准与 M4.1/M4.2 实盘就绪门禁 */}
        {intelOpen && (attribution || readiness) && (
          <div className="flex flex-col gap-2 border-t border-base-800/80 pt-2">
            {attribution && (
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-ink-hi">AI500 因子归因</span>
                  <Badge tone={attribution.applied ? 'up' : 'muted'}>
                    {attribution.applied
                      ? `已校准 (${attribution.sampleSize}笔)`
                      : `基准权重 (${attribution.sampleSize}/${attribution.minSamplesRequired}笔)`}
                  </Badge>
                  <Badge tone="accent">
                    红线 ≥{attribution.strongThreshold} / ≥{attribution.watchThreshold}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {attribution.dimensions.map((d) => (
                    <Badge
                      key={d.key}
                      tone={
                        d.deltaWeight > 0
                          ? 'up'
                          : d.deltaWeight < 0
                            ? 'down'
                            : d.correlationR >= 0.2
                              ? 'accent'
                              : 'muted'
                      }
                      title={`${d.label}：权重 ${d.recommendedWeight}（基准 ${d.baselineWeight}）· 相关系数 r=${d.correlationR.toFixed(2)} · 赢单均分 ${d.winMeanPct}% vs 亏单 ${d.lossMeanPct}%`}
                    >
                      {d.label} {d.recommendedWeight}
                      {d.deltaWeight !== 0 ? `(${d.deltaWeight > 0 ? '+' : ''}${d.deltaWeight})` : ''}
                      {attribution.sampleSize >= 3 ? ` · r=${d.correlationR.toFixed(2)}` : ''}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {readiness && (
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-ink-hi">
                    近 {readiness.metrics.windowHours}h 运行门禁
                  </span>
                  <Badge
                    tone={
                      readiness.overall === 'pass'
                        ? 'up'
                        : readiness.overall === 'warn'
                          ? 'warn'
                          : 'down'
                    }
                  >
                    {readiness.summary}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {readiness.checks.map((c) => (
                    <Badge
                      key={c.id}
                      tone={c.status === 'pass' ? 'up' : c.status === 'warn' ? 'warn' : 'down'}
                      title={c.detail}
                    >
                      {c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✕'} {c.label}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
