/**
 * 本机器人「全量决策档案」弹层（替代原来无用的 `/data` 日志跳转）。
 *
 * 能力：
 * - 仅拉取当前机器人的完整历史决策记录，支持游标分页继续加载更早轮次；
 * - 按动作分类筛选（全部 / 交易动作 / 等待 / 跳过 / 异常失败）+ 币种关键词检索；
 * - 实时汇总已加载样本的动作分布、平均耗时、缓存命中率；
 * - 单轮可直接展开看完整理由/参数，或一键跳转单轮深度审计页 `/traders/:id/decisions/:recordId`。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
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
import { ActionBadge, isOpenAction } from './DecisionAudit';
import { CoinIcon } from './CoinIcon';
import { Button, Modal, Spinner3, cn } from './ui';

type FilterKind = 'all' | 'trades' | 'wait' | 'skip' | 'error';

const PAGE_SIZE = 30;

const FILTER_TABS: Array<{ id: FilterKind; label: string }> = [
  { id: 'all', label: '全部周期' },
  { id: 'trades', label: '交易动作' },
  { id: 'wait', label: '观望等待' },
  { id: 'skip', label: '仅跳过' },
  { id: 'error', label: '异常/失败' },
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
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.traderDecisions(traderId, { limit: PAGE_SIZE });
      setRecords(page);
      setHasMore(page.length >= PAGE_SIZE);
    } catch (err) {
      setError((err as Error).message || '读取历史决策失败');
    } finally {
      setLoading(false);
    }
  }, [traderId]);

  const loadMore = useCallback(async () => {
    const oldest = records[records.length - 1];
    if (!oldest || loadingMore || !hasMore) return;
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
      setLoadingMore(false);
    }
  }, [traderId, records, loadingMore, hasMore]);

  useEffect(() => {
    if (!open) return;
    void loadInitial();
  }, [open, loadInitial]);

  const normalizedQuery = query.trim().toUpperCase();

  const filtered = useMemo(() => {
    return records.filter((rec) => {
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
  }, [records, filter, normalizedQuery]);

  const stats = useMemo(() => {
    let tradeCycles = 0;
    let latencySum = 0;
    let latencyCnt = 0;
    let cacheSum = 0;
    let cacheCnt = 0;
    for (const r of records) {
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
      total: records.length,
      tradeCycles,
      avgLatencyMs: latencyCnt > 0 ? Math.round(latencySum / latencyCnt) : 0,
      avgCachePct: cacheCnt > 0 ? Math.round(cacheSum / cacheCnt) : null,
    };
  }, [records]);

  return (
    <Modal open={open} onClose={onClose} title="决策档案与审计筛选" width="max-w-4xl">
      <div className="flex max-h-[76vh] flex-col gap-3">
        {/* 顶部统计 + 筛选栏 */}
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
                均耗时 <strong className="num text-sky-300 [[data-skin='light']_&]:text-sky-700">{fmtLatency(stats.avgLatencyMs)}</strong>
              </span>
            )}
            {stats.avgCachePct !== null && (
              <span>
                均缓存 <strong className="num text-up">{stats.avgCachePct}%</strong>
              </span>
            )}
          </div>

          <div className="relative flex w-full items-center sm:w-56">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-ink-faint" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜币种 / 周期号 / 理由…"
              className="input h-7 py-0 pl-8 pr-7 text-xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="清空搜索"
                className="absolute right-2 text-ink-faint hover:text-ink-hi"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* 分类分段 */}
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

        {/* 内容列表 */}
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {loading ? (
            <Spinner3 label="正在加载历史决策档案" />
          ) : error ? (
            <div className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-xs text-down">
              {error}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border border-base-750 bg-base-850/40 px-4 py-8 text-center text-xs text-ink-faint">
              当前筛选条件下暂无匹配的决策记录。
              {hasMore && '可以点击下方「加载更多更早周期」继续扩大检索范围。'}
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
                            <ActionBadge action={d.action} className="px-1 py-0 text-[10px]" />
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
                                {isNum(d.stopLoss) ? ` · 止损 ${fmtPriceUsd(d.stopLoss)}` : ''}
                                {isNum(d.takeProfit) ? ` · 止盈 ${fmtPriceUsd(d.takeProfit)}` : ''}
                                {d.leverage > 0 ? ` · 杠杆 ${d.leverage}x` : ''}
                              </span>
                            )}
                            <ActionBadge action={d.action} className="ml-auto" />
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
        </div>

        {/* 底部翻页 */}
        <div className="flex items-center justify-between border-t border-base-750 pt-2">
          <span className="text-xs text-ink-faint">
            支持按周期游标翻阅更早的历史记录，点击单轮「详情」可进入完整审计页。
          </span>
          <div className="flex items-center gap-2">
            {hasMore && (
              <Button size="sm" variant="ghost" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                加载更多更早周期
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={onClose}>
              关闭
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
