/**
 * Presentational parts of the overview page: the headline figures, the system
 * strip, and the per-bot 最近平仓 cell.
 *
 * Split out of `OverviewPage.tsx` so that page reads as structure — what goes
 * where and in which order — rather than as a wall of Tailwind. These pieces
 * carry no data fetching of their own except `useRecentTrades`, which is here
 * because only 最近平仓 uses it.
 */
import type { ReactNode } from 'react';
import { Link, type NavigateFunction } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { TraderStats, TradeRecord, TraderStatus } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { closeReasonLabel } from '../lib/summaries';
import { usePolled } from '../lib/hooks';
import { Button, Panel } from '../components/ui';
import { SideBadge, TraderStatusBadge } from '../components/Badges';
import { pnlFormulaText, statsCosts } from '../components/PnlBreakdown';
import { fmtInt, fmtPercent, fmtUsd, fmtUsdSigned, pnlColor, timeAgo } from '../lib/format';

/* -------------------------------------------------------------------------- */
/*  Headline metric                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One of the four numbers at the top of the page.
 *
 * The value is `text-3xl` (28px) and steps up to `text-4xl` (36px) only from
 * `sm` where there is room: DESIGN.md reserves the largest size for the single
 * most important figure on the first screen, and forcing 36px into a 320px
 * column would wrap the number instead of enlarging it.
 *
 * `loading` draws a pulsing dot beside the label rather than blanking the value.
 * Hiding a number that is already on screen (a poll in flight) makes the page
 * flash; the dot says "this may be a second old" without moving anything.
 */
export function HeadlineMetric({
  label,
  value,
  sub,
  tone,
  valueClass,
  loading = false,
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
  valueClass?: string;
  loading?: boolean;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-ink-lo">
        {label}
        {loading && <span aria-hidden className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent" />}
      </div>
      <div
        className={`num mt-1.5 min-w-0 break-words text-3xl leading-tight sm:text-4xl ${
          valueClass ?? tone ?? 'text-ink-hi'
        }`}
      >
        {value}
      </div>
      {sub && <div className="num mt-1 text-xs leading-snug text-ink-lo">{sub}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  System fact                                                                */
/* -------------------------------------------------------------------------- */

/** One `label / value / unit` triple in the footer. Smaller than anything above it. */
export function SystemFact({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-wide text-ink-lo">{label}</dt>
      <dd className={`num mt-0.5 truncate text-base ${tone ?? 'text-ink-hi'}`} title={value}>
        {value}
      </dd>
      {sub && <dd className="truncate text-2xs text-ink-faint">{sub}</dd>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Recent close                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The newest closed trade for each running bot.
 *
 * One request per **running** bot, never per configured bot: a stopped bot has
 * no recent activity to show, and on an installation with a dozen saved bots the
 * extra requests would be pure cost.
 *
 * The reason code goes through `closeReasonLabel`. `trade.closeReason` is a
 * stable machine code persisted in the database — it is never rendered raw and
 * never translated at this layer, only mapped.
 */
export function useRecentTrades(traderIds: number[]): {
  byTrader: Record<number, TradeRecord>;
  loading: boolean;
} {
  const key = traderIds.join(',');
  const query = usePolled<Record<number, TradeRecord>>(
    async (signal) => {
      const results = await Promise.all(
        traderIds.map(async (id): Promise<[number, TradeRecord | null]> => {
          const trades = await api.traderTrades(id, 1, signal);
          return [id, trades[0] ?? null];
        }),
      );
      const byTrader: Record<number, TradeRecord> = {};
      for (const [id, trade] of results) {
        if (trade) byTrader[id] = trade;
      }
      return byTrader;
    },
    // Slower than the equity poll on purpose: a close is a rare event, and the
    // socket already announces one in a toast the moment it happens.
    { intervalMs: 30_000, enabled: traderIds.length > 0, deps: [key] },
  );

  return { byTrader: query.data ?? {}, loading: traderIds.length > 0 && query.data === null };
}

export function RecentClose({ trade, pending }: { trade: TradeRecord | undefined; pending: boolean }) {
  if (!trade) {
    return <span className="text-xs text-ink-faint">{pending ? '读取中…' : '暂无平仓'}</span>;
  }
  return (
    <div className="text-right">
      <div className="flex items-center justify-end gap-1.5">
        <span className="text-base text-ink-mid">{trade.symbol}</span>
        <SideBadge side={trade.side} />
      </div>
      {/* Net, signed: `fmtPercent` already carries its own sign, and 净 leads
          because that is the number the balance actually moved by. */}
      <div className={`num text-2xs ${pnlColor(trade.netPnl)}`}>
        净 {fmtUsdSigned(trade.netPnl, 2)} · {fmtPercent(trade.pnlPercent)}
      </div>
      <div className="truncate text-2xs text-ink-faint">
        {closeReasonLabel(trade.closeReason)} · {timeAgo(trade.closedAt)}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Suspense fallback                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Holds the chart's exact height while its chunk downloads.
 *
 * Sizing it to match is the point: a shorter placeholder makes the whole page
 * jump upward when recharts arrives, which is exactly the "内容先塌成一条再弹回来"
 * failure the route-level fallback exists to prevent.
 */
export function EquitySkeleton({ height }: { height: number }) {
  return (
    <div
      className="flex animate-pulse-soft flex-col justify-end gap-2 rounded-md border border-dashed border-base-750 px-4 py-4"
      style={{ height }}
      role="status"
      aria-label="正在加载权益曲线"
    >
      <div className="h-1/2 w-full rounded bg-base-850" />
      <div className="h-1/4 w-2/3 rounded bg-base-850" />
      <span className="text-xs text-ink-faint">正在加载权益曲线…</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Per-bot snapshot table                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The dense per-bot table.
 *
 * `px-2` rather than the table class's default `px-3`: eight columns at 16px of
 * side padding each is 256px of the row spent on air, and DESIGN.md §4 requires
 * no horizontal scrolling at 150% zoom. Between padding and information, a dense
 * financial grid can afford tighter gutters — it cannot afford a column hidden
 * behind a scrollbar.
 *
 * `share` (the bar under 权益) is each bot's slice of the whole book, because
 * with several loops running "which one is carrying the account" is the first
 * question an operator asks.
 */
export function TradersSnapshotTable({
  traders,
  statsMap,
  liveStatus,
  totalEquity,
  equityOf,
  recentTrades,
  busyId,
  runOnceBusyId,
  navigate,
  onRunOnce,
  onStop,
  onStart,
  extraCount,
}: {
  traders: TraderRow[];
  statsMap: Record<number, TraderStats>;
  liveStatus: Record<number, TraderStatus | null>;
  totalEquity: number;
  equityOf: (trader: TraderRow) => number;
  recentTrades: { byTrader: Record<number, TradeRecord>; loading: boolean };
  busyId: number | null;
  runOnceBusyId: number | null;
  navigate: NavigateFunction;
  onRunOnce: (trader: TraderRow) => void;
  onStop: (trader: TraderRow) => void;
  onStart: (trader: TraderRow) => void;
  /** Rows that exist but are not rendered, so the footer link can say how many. */
  extraCount: number;
}) {
  return (
    <>
      <Panel padded={false}>
        <div className="scroll-x">
          <table className="w-full border-collapse">
            <caption className="sr-only">机器人权益与运行状态快照</caption>
            <thead className="border-b border-base-800 bg-base-850/60">
              <tr>
                <th scope="col" className="th px-2">
                  机器人
                </th>
                <th scope="col" className="th px-2">
                  状态
                </th>
                <th scope="col" className="th px-2 text-right">
                  权益
                </th>
                <th scope="col" className="th px-2 text-right">
                  总收益率
                </th>
                <th scope="col" className="th px-2 text-right">
                  持仓
                </th>
                <th scope="col" className="th px-2 text-right">
                  胜率
                </th>
                <th scope="col" className="th px-2 text-right">
                  最近平仓
                </th>
                <th scope="col" className="th px-2 text-right">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {traders.map((trader) => {
                const stats = statsMap[trader.id];
                const status: TraderStatus = liveStatus[trader.id] ?? trader.status;
                const equity = equityOf(trader);
                const share = totalEquity > 0 ? Math.max(0, Math.min(100, (equity / totalEquity) * 100)) : 0;
                return (
                  <tr key={trader.id} className="row-hover align-top">
                    <td className="td px-2">
                      <Link to={`/traders/${trader.id}`} className="group block">
                        <div className="text-base font-semibold text-ink-hi group-hover:text-accent">{trader.name}</div>
                        <div className="num text-2xs text-ink-faint">
                          #{trader.id} · 周期 {trader.lastCycleNumber} · 每 {trader.cycleIntervalMinutes}m
                        </div>
                      </Link>
                    </td>
                    <td className="td px-2">
                      <TraderStatusBadge status={status} live={trader.isRunning} />
                      {trader.consecutiveFailures > 0 && (
                        <div className="num mt-0.5 text-2xs text-warn">{trader.consecutiveFailures} 次连续失败</div>
                      )}
                    </td>
                    <td className="td px-2 text-right">
                      <div className={`num ${stats ? 'text-ink-hi' : 'text-ink-faint'}`}>
                        {stats ? fmtUsd(equity, 2) : '—'}
                      </div>
                      <div
                        className="ml-auto mt-1 h-1 w-16 overflow-hidden rounded-full bg-base-800"
                        title={`占全部权益的 ${share.toFixed(1)}%`}
                      >
                        <div className="h-full rounded-full bg-accent/70" style={{ width: `${share}%` }} />
                      </div>
                    </td>
                    <td className="td num px-2 text-right">
                      <div className={stats ? pnlColor(stats.totalReturnPercent) : 'text-ink-faint'}>
                        {stats ? fmtPercent(stats.totalReturnPercent) : '—'}
                      </div>
                      {stats && (
                        /* Net leads, gross follows: the difference is the costs, and on a
                           small account the costs are the whole story. */
                        <div
                          className="text-2xs text-ink-faint"
                          title={`${pnlFormulaText(statsCosts(stats))}。浮动盈亏 ${fmtUsdSigned(
                            stats.unrealizedPnl,
                            2,
                          )} 未计入本行。`}
                        >
                          净 {fmtUsdSigned(stats.realizedPnl, 2)} · 毛 {fmtUsdSigned(stats.grossRealizedPnl, 2)}
                        </div>
                      )}
                    </td>
                    <td className="td num px-2 text-right">
                      {stats ? fmtInt(stats.openPositions) : '—'}
                      {stats && stats.unrealizedPnl !== 0 && (
                        /* Neutral on purpose: this column is already signed, and two
                           coloured PnL figures side by side read as one number split
                           across two cells. */
                        <div className="text-2xs text-ink-faint">浮 {fmtUsdSigned(stats.unrealizedPnl, 2)}</div>
                      )}
                    </td>
                    <td className="td num px-2 text-right">
                      {stats ? `${stats.winRatePercent.toFixed(1)}%` : '—'}
                      {stats && (
                        <div className="text-2xs text-ink-faint">
                          {fmtInt(stats.wins)} 盈 / {fmtInt(stats.losses)} 亏
                        </div>
                      )}
                    </td>
                    <td className="td px-2 text-right">
                      <RecentClose trade={recentTrades.byTrader[trader.id]} pending={recentTrades.loading} />
                    </td>
                    <td className="td px-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button small onClick={() => navigate(`/traders/${trader.id}`)}>
                          打开
                        </Button>
                        {trader.isRunning ? (
                          <>
                            <Button
                              small
                              variant="primary"
                              busy={runOnceBusyId === trader.id}
                              title="立即强制执行一个决策周期"
                              onClick={() => onRunOnce(trader)}
                            >
                              立即运行
                            </Button>
                            <Button
                              small
                              variant="danger"
                              busy={busyId === trader.id}
                              title="立即停止：会取消尚未执行的周期，但不会平掉已有持仓"
                              onClick={() => onStop(trader)}
                            >
                              停止
                            </Button>
                          </>
                        ) : (
                          <Button small variant="success" onClick={() => onStart(trader)}>
                            启动
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {extraCount > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-ink-faint">
          仅显示前 {traders.length} 个机器人 —
          <Link to="/traders" className="inline-flex items-center gap-0.5 text-accent hover:underline">
            在「机器人」中查看全部 {traders.length + extraCount} 个
            <ArrowRight aria-hidden className="h-3 w-3" />
          </Link>
        </p>
      )}    </>
  );
}
