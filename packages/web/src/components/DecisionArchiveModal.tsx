/**
 * 本机器人「全量决策档案」弹层（替代原来无用的 `/data` 日志跳转）。
 *
 * 能力：
 * - 仅拉取当前机器人的完整历史决策记录，支持滚到底部自动加载更早轮次（IntersectionObserver）；
 * - 按日期快速筛选（默认当前 / 近 1 天 / 近 3 天 / 近 7 天）+ 动作分类筛选 + 币种/周期/理由检索；
 * - 实时汇总已加载样本的动作分布、平均耗时、缓存命中率；
 * - 单轮可直接展开看完整理由/参数，或一键跳转单轮深度审计页 `/traders/:id/decisions/:recordId`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { Decision, DecisionRecord } from '@aq/shared';
import { api } from '../lib/api';
import { fmtInt, fmtLatency, fmtPriceUsd, fmtUsd, isNum } from '../lib/format';
import { plainText } from '../lib/plainText';
import { isPendingDecisionRecord } from '../lib/decisionPending';
import { ActionBadge, isOpenAction } from './DecisionAudit';
import { CoinIcon } from './CoinIcon';
import { Button, Modal, Spinner3, cn } from './ui';

type FilterKind = 'all' | 'trades' | 'wait' | 'skip' | 'error';
type DateRangeId = 'current' | '1d' | '3d' | '7d';

const PAGE_SIZE = 30;
const DAY_MS = 24 * 60 * 60_000;

const FILTER_TABS: Array<{ id: FilterKind; label: string }> = [
  { id: 'all', label: '全部周期' },
  { id: 'trades', label: '交易动作' },
  { id: 'wait', label: '观望等待' },
  { id: 'skip', label: '仅跳过' },
  { id: 'error', label: '异常/失败' },
];

const DATE_RANGES: Array<{ id: DateRangeId; label: string; days: number | null }> = [
  { id: 'current', label: '当前', days: null },
  { id: '1d', label: '1 天', days: 1 },
  { id: '3d', label: '3 天', days: 3 },
  { id: '7d', label: '7 天', days: 7 },
];

function isTradeAction(action: Decision['action']): boolean {
  return action !== 'wait' && action !== 'skip' && action !== 'hold';
}

function formatClock(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export function DecisionArchiveModal({
  traderId,
  open,
  onClose,
}: {
  traderId: number;
  open: boolean;
  onClose: () => void;
}) {
  const [records, setRecords] = useState<DecisionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKind>('all');
  const [dateRange, setDateRange] = useState<DateRangeId>('current');
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.traderDecisions(traderId, { limit: PAGE_SIZE });
      setRecords(page.filter((row) => !isPendingDecisionRecord(row)));
      setHasMore(page.length >= PAGE_SIZE);
    } catch (err) {
      setError((err as Error).message || '读取历史决策失败');
    } finally {
      setLoading(false);
    }
  }, [traderId]);

  const loadMore = useCallback(async () => {
    const oldest = records[records.length - 1];
    if (!oldest || loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await api.traderDecisions(traderId, { limit: PAGE_SIZE, before: oldest.id });
      setRecords((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        const merged = [...prev];
        for (const row of page) {
          if (!seen.has(row.id)) merged.push(row);
        }
        return merged;
      });
      setHasMore(page.length >= PAGE_SIZE);
    } catch (err) {
      setError((err as Error).message || '加载更早记录失败');
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [traderId, records, hasMore]);

  useEffect(() => {
    if (!open) return;
    void loadInitial();
  }, [open, loadInitial]);

  // 触底自动翻页：滚到列表底部附近自动拉取下一批更早周期，不再需要手点按钮。
  useEffect(() => {
    if (!open || loading || !hasMore) return;
    const root = listRef.current;
    const target = sentinelRef.current;
    if (!root || !target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void loadMore();
        }
      },
      { root, rootMargin: '140px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [open, loading, hasMore, loadMore]);

  const cutoffMs = useMemo(() => {
    const def = DATE_RANGES.find((d) => d.id === dateRange);
    if (!def || def.days === null) return null;
    return Date.now() - def.days * DAY_MS;
  }, [dateRange]);

  const normalizedQuery = query.trim().toUpperCase();

  const dateScopedRecords = useMemo(() => {
    if (cutoffMs === null) return records;
    return records.filter((rec) => {
      const ts = Date.parse(rec.timestamp);
      return Number.isFinite(ts) ? ts >= cutoffMs : true;
    });
  }, [records, cutoffMs]);

  const filtered = useMemo(() => {
    return dateScopedRecords.filter((rec) => {
      const list = rec.decisions ?? [];
      if (filter === 'trades' && !list.some((d) => isTradeAction(d.action))) return false;
      if (filter === 'wait' && !list.some((d) => d.action === 'wait')) return false;
      if (filter === 'skip' && !list.every((d) => d.action === 'skip')) return false;
      if (filter === 'error' && rec.success && !rec.error) return false;
      if (normalizedQuery) {
        const symHit = list.some((d) => d.symbol.toUpperCase().includes(normalizedQuery));
        const cycleHit = `#${rec.cycleNumber}`.includes(normalizedQuery);
        const textHit = list.some((d) => (d.reasoning ?? '').toUpperCase().includes(normalizedQuery));
        if (!symHit && !cycleHit && !textHit) return false;
      }
      return true;
    });
  }, [dateScopedRecords, filter, normalizedQuery]);

  const stats = useMemo(() => {
    let tradeCycles = 0;
    let latencySum = 0;
    let latencyCnt = 0;
    let cacheSum = 0;
    let cacheCnt = 0;
    for (const r of dateScopedRecords) {
      if ((r.decisions ?? []).some((d) => isTradeAction(d.action))) tradeCycles += 1;
      if (r.aiLatencyMs > 0) {
        latencySum += r.aiLatencyMs;
        latencyCnt += 1;
      }
      if (r.cachedTokens != null && r.promptTokens != null && r.promptTokens > 0) {
        cacheSum += (r.cachedTokens / r.promptTokens) * 100;
        cacheCnt += 1;
      }
    }
    return {
      total: dateScopedRecords.length,
      tradeCycles,
      avgLatencyMs: latencyCnt > 0 ? Math.round(latencySum / latencyCnt) : 0,
      avgCachePct: cacheCnt > 0 ? Math.round(cacheSum / cacheCnt) : null,
    };
  }, [dateScopedRecords]);

  return (
    <Modal open={open} onClose={onClose} title="决策档案与审计筛选" width="max-w-4xl">
      <div className="flex max-h-[76vh] flex-col gap-2.5">
        {/* 顶部统计 + 日期快选 + 搜索栏 */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-base-750 bg-base-850/70 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-lo">
            <span>
              已加载 <strong className="num text-ink-hi">{stats.total}</strong> 轮
            </span>
            <span>
              含交易动作 <strong className="num text-up">{stats.tradeCycles}</strong> 轮
            </span>
            {stats.avgLatencyMs > 0 && (
              <span>
                均耗时{' '}
                <strong className="num text-sky-300 [[data-skin='light']_&]:text-sky-700">
                  {fmtLatency(stats.avgLatencyMs)}
                </strong>
              </span>
            )}
            {stats.avgCachePct !== null && (
              <span>
                均缓存 <strong className="num text-up">{stats.avgCachePct}%</strong>
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* 日期快选（默认当前 / 1天 / 3天 / 7天） */}
            <div
              role="group"
              aria-label="按日期范围筛选"
              className="inline-flex items-center gap-0.5 rounded-lg border border-base-700 bg-base-950/70 p-0.5"
            >
              <Calendar aria-hidden className="mx-1 h-3 w-3 shrink-0 text-ink-faint" />
              {DATE_RANGES.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={dateRange === d.id}
                  onClick={() => setDateRange(d.id)}
                  className={cn(
                    'rounded-md px-2 py-0.5 text-[11px] font-medium transition',
                    dateRange === d.id
                      ? 'bg-accent/18 text-accent'
                      : 'text-ink-lo hover:text-ink-hi',
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>

            {/* 独立弹性搜索框：图标与输入框分列，永不与全局 .input padding 冲突重叠 */}
            <div className="flex h-7 w-full items-center gap-1.5 rounded-lg border border-base-700 bg-base-900/90 px-2.5 transition focus-within:border-accent sm:w-52">
              <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜币种 / 周期号 / 理由…"
                className="min-w-0 flex-1 bg-transparent text-xs text-ink-hi outline-none placeholder:text-ink-faint"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="清空搜索"
                  className="shrink-0 text-ink-faint hover:text-ink-hi"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 动作分类分段 */}
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTER_TABS.map((t) => {
            const active = filter === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setFilter(t.id)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs font-medium transition',
                  active
                    ? 'border-accent/45 bg-accent/15 text-accent'
                    : 'border-base-750 bg-base-850/60 text-ink-lo hover:border-base-600 hover:text-ink-hi',
                )}
              >
                {t.label}
              </button>
            );
          })}
          <span className="ml-auto text-xs text-ink-faint">
            匹配 <span className="num font-medium text-ink-mid">{filtered.length}</span> 条
          </span>
        </div>

        {/* 内容列表（触底自动加载） */}
        <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {loading ? (
            <Spinner3 label="正在加载历史决策档案" />
          ) : error ? (
            <div className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-xs text-down">
              {error}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border border-base-750 bg-base-850/40 px-4 py-8 text-center text-xs text-ink-faint">
              当前筛选条件下暂无匹配的决策记录。
              {hasMore && '向下滚动或切换日期范围可自动加载更早周期。'}
            </div>
          ) : (
            filtered.map((rec) => {
              const decisions = rec.decisions ?? [];
              const expanded = expandedId === rec.id;
              const cachePct =
                rec.cachedTokens != null && rec.promptTokens != null && rec.promptTokens > 0
                  ? Math.round((rec.cachedTokens / rec.promptTokens) * 100)
                  : null;
              const highlightDecisions = decisions.filter((d) => d.action !== 'skip');
              const shownSummary = highlightDecisions.length > 0 ? highlightDecisions : decisions.slice(0, 3);

              return (
                <div
                  key={rec.id}
                  className="rounded-lg border border-base-750 bg-base-850/80 transition hover:border-base-600"
                >
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : rec.id)}
                      className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
                    >
                      {expanded ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                      )}
                      <span className="num rounded bg-accent/12 px-1.5 py-0.5 text-xs font-semibold text-accent">
                        #{rec.cycleNumber}
                      </span>
                      <span className="num text-xs text-ink-lo">{formatClock(rec.timestamp)}</span>
                      {!rec.success && (
                        <span className="inline-flex items-center gap-1 rounded bg-down/12 px-1.5 py-0.5 text-[11px] font-medium text-down">
                          <TriangleAlert className="h-3 w-3" />
                          异常
                        </span>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {shownSummary.map((d, idx) => (
                          <span
                            key={`${d.symbol}-${idx}`}
                            className="inline-flex items-center gap-1 rounded-md bg-base-900/80 px-1.5 py-0.5"
                          >
                            <CoinIcon symbol={d.symbol} className="h-3.5 w-3.5 text-[8px]" />
                            <span className="font-mono text-xs font-semibold text-ink-hi">
                              {d.symbol.replace(/USDT$/i, '')}
                            </span>
                            <ActionBadge action={d.action} reasoning={d.reasoning} className="px-1 py-0 text-[10px]" />
                          </span>
                        ))}
                        {decisions.length > shownSummary.length && (
                          <span className="text-[11px] text-ink-faint">
                            +{decisions.length - shownSummary.length} 跳过
                          </span>
                        )}
                      </div>
                    </button>

                    <div className="flex shrink-0 items-center gap-2 text-[11px]">
                      {cachePct !== null && (
                        <span className={cn('num', cachePct >= 50 ? 'text-up' : 'text-warn')}>
                          缓存 {cachePct}%
                        </span>
                      )}
                      {rec.aiLatencyMs > 0 && (
                        <span className="num text-ink-lo">{fmtLatency(rec.aiLatencyMs)}</span>
                      )}
                      <Link
                        to={`/traders/${traderId}/decisions/${rec.id}`}
                        onClick={onClose}
                        className="inline-flex items-center gap-1 rounded-md border border-base-700 bg-base-900/70 px-2 py-0.5 text-xs text-ink-mid transition hover:border-accent/50 hover:text-accent"
                        title="打开本轮完整决策审计详情页"
                      >
                        详情
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </div>
                  </div>

                  {expanded && (
                    <div className="space-y-2 border-t border-base-750/80 px-3 py-2.5 text-xs">
                      {rec.error && (
                        <p className="rounded bg-down/10 px-2 py-1 text-down">{rec.error}</p>
                      )}
                      {decisions.map((d, idx) => (
                        <div
                          key={`${d.symbol}-${idx}`}
                          className="rounded-md bg-base-900/60 px-2.5 py-2"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <CoinIcon symbol={d.symbol} className="h-4 w-4 text-[9px]" />
                            <span className="font-mono font-semibold text-ink-hi">{d.symbol}</span>
                            {d.confidence != null && (
                              <span className="num text-[11px] text-accent">置信度 {d.confidence}%</span>
                            )}
                            {isOpenAction(d.action) && (
                              <span className="num text-[11px] text-ink-lo">
                                仓位 {fmtUsd(d.positionSizeUsd, 2)}
                                {isNum(d.positionSizeUsd) && d.positionSizeUsd > 0 && isNum(d.leverage) && d.leverage > 0
                                  ? ` · 保证金 ${fmtUsd(d.positionSizeUsd / d.leverage, 2)}`
                                  : ''}
                                {isNum(d.stopLoss) ? ` · 止损 ${fmtPriceUsd(d.stopLoss)}` : ''}
                                {isNum(d.takeProfit) ? ` · 止盈 ${fmtPriceUsd(d.takeProfit)}` : ''}
                                {d.leverage > 0 ? ` · 杠杆 ${d.leverage}x` : ''}
                              </span>
                            )}
                            <ActionBadge action={d.action} reasoning={d.reasoning} className="ml-auto" />
                          </div>
                          {d.reasoning && (
                            <p className="mt-1 leading-relaxed text-ink-mid">{plainText(d.reasoning)}</p>
                          )}
                        </div>
                      ))}
                      {rec.promptTokens != null && (
                        <div className="num text-[11px] text-ink-faint">
                          Token 用量：输入 {fmtInt(rec.promptTokens)} · 输出 {fmtInt(rec.completionTokens ?? 0)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* 触底自动加载哨兵 */}
          <div ref={sentinelRef} aria-hidden className="h-2 w-full" />
          {loadingMore && (
            <div className="flex items-center justify-center gap-1.5 py-2 text-xs text-ink-faint">
              <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
              正在自动加载更早周期…
            </div>
          )}
          {!loading && !hasMore && records.length > 0 && (
            <p className="py-1 text-center text-[11px] text-ink-faint">已加载全部历史周期</p>
          )}
        </div>

        {/* 底部极简栏 */}
        <div className="flex items-center justify-between border-t border-base-750 pt-2">
          <span className="text-xs text-ink-faint">
            向下滚动触底自动加载更早记录，点单轮「详情」可进入 16:9 完整审计视图。
          </span>
          <Button size="sm" variant="primary" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
}
