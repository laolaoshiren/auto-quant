/**
 * 总览页的表现层：紧凑权益条、系统事实、机器人快照表。
 *
 * 从 `OverviewPage.tsx` 拆出来，好让那一页读起来是**结构**（什么放在哪里、
 * 按什么顺序），而不是一整片 Tailwind。这里除了 `useRecentTrades` 之外不做任何
 * 数据请求 —— 那个 hook 也在这里，因为只有「最近平仓」这一列用它。
 *
 * 两处与 LAYOUT.md 直接对应的决定：
 *
 * 1. **数据太薄时不画整张图**（§4）。少于 3 个快照点、或权益完全走平时，
 *    `EquityStrip` 用一条 36px 的缩略线替代 240px 的图表 —— 而且因为那条线是
 *    纯 SVG，走平时连 recharts 那个 chunk 都不会下载。
 * 2. **表格行要密**（§2）。这里把所有单元格压到 `py-1.5` + 两行以内，
 *    并砍掉不挣宽度的那一列（见 `TradersSnapshotTable` 的注释）。
 */
import { Link, type NavigateFunction } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { TraderStats, TradeRecord, TraderStatus } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { closeReasonLabel } from '../lib/summaries';
import { usePolled } from '../lib/hooks';
import { Button, Panel, cn } from '../components/ui';
import { SideBadge, TraderStatusBadge } from '../components/Badges';
import { pnlFormulaText, statsCosts } from '../components/PnlBreakdown';
import { fmtInt, fmtPercent, fmtUsd, fmtUsdSigned, pnlColor, timeAgo } from '../lib/format';
import type { EquityPoint } from '../components/equityCurve';

/* -------------------------------------------------------------------------- */
/*  Equity shape                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 低于这个绝对值的变化（不足一分钱）不叫"有形状"。
 *
 * 用绝对值而不是纯相对值，是因为一个 0.00 的账户上任何浮点噪声都会变成
 * 相对意义上的"巨大波动"。
 */
const EQUITY_FLAT_EPS = 0.005;

/**
 * 这条曲线值不值得画成图表。
 *
 * LAYOUT.md §4 的原话是"没有数据的图表自动收起成一行小图" —— 判据有两条：
 * **点太少**（少于 3 个点连不成曲线，只能连成一条线段）和**完全走平**
 * （用三分之一屏高画一条水平线，是这一页最被诟病的浪费）。
 *
 * 相对阈值同样必要：大账户上几美分的抖动，画进 `[min - pad, max + pad]`
 * 的坐标轴里也是一条直线，但按绝对阈值它会通过。
 */
export function equityShape(points: EquityPoint[]): { hasShape: boolean; flat: boolean } {
  const values = points.map((point) => point.equity).filter((value) => Number.isFinite(value));
  if (values.length === 0) return { hasShape: false, flat: false };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min;
  const threshold = Math.max(Math.abs(max) * 0.0002, EQUITY_FLAT_EPS);
  const flat = spread <= threshold;

  return { hasShape: values.length >= 3 && !flat, flat };
}

/* -------------------------------------------------------------------------- */
/*  Compact equity strip                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 数据太薄时的紧凑替代品。
 *
 * 两种形态各自说真话：没有快照时给一句"还没有"，并说明多久之后会有；
 * 有快照但没有形状时给一条缩略线 —— 它**就是**那张图，只是不需要 240px。
 */
export function EquityStrip({
  points,
  change,
  changePercent,
  rangeLabel,
  flat,
}: {
  points: EquityPoint[];
  change: number | null;
  changePercent: number | null;
  /** 当前选中的区间标签（`7D` / `全部`…），用来说清这条线是哪一段。 */
  rangeLabel: string;
  flat: boolean;
}) {
  if (points.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-base-750 bg-base-900/60 px-3 py-2.5">
        <p className="text-base text-ink-lo">还没有权益快照，暂时没有曲线可画。</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">
          每个决策周期结束时会记录一次 —— 机器人跑完两个周期后，这里会自动展开成完整曲线。
        </p>
      </div>
    );
  }

  const values = points.map((point) => point.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const last = points.length - 1;

  /*
   * 缩略线用 `viewBox="0 0 100 100"` + `preserveAspectRatio="none"` 拉满整宽，
   * 所以 `strokeWidth` 必须配 `vectorEffect="non-scaling-stroke"` —— 否则
   * 非等比缩放会把线宽也一起压成细丝或拉成色块。
   */
  const path = points
    .map((point, index) => {
      const x = last === 0 ? 0 : (index / last) * 100;
      // 走平时按中线画：贴在盒子边缘的一条线看起来像被裁掉了。
      const y = span === 0 ? 50 : 100 - ((point.equity - min) / span) * 100;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const stroke = change === null || change === 0 ? 'text-ink-lo' : change > 0 ? 'text-up' : 'text-down';

  return (
    <div className="flex items-center gap-3 rounded-lg border border-base-750 bg-base-900 px-3 py-2">
      <div className={cn('h-9 min-w-0 flex-1', stroke)}>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label={`${rangeLabel} 归属权益缩略线`}
        >
          <path d={path} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <div className="shrink-0 text-right">
        <div className={cn('num text-base leading-tight', pnlColor(change))}>
          {change === null ? '—' : fmtUsdSigned(change, 2)}
        </div>
        {/*
          不说"共 N 个快照点"：快照数量是内部诊断值（LAYOUT.md §3），正常运行时
          看它一百次也拿不到信息。这里要说的是**为什么没有展开成图表**。
        */}
        <div className="num text-xs text-ink-faint">
          {flat ? `${rangeLabel} 权益持平` : '采样点不足，暂不展开曲线'}
          {changePercent !== null && ` · ${fmtPercent(changePercent)}`}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  System fact                                                                */
/* -------------------------------------------------------------------------- */

/** 页脚里的一条 `label / value / unit`。全页最小的字号 —— 它是最不重要的内容。 */
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
      <dt className="truncate text-xs text-ink-lo">{label}</dt>
      <dd className={cn('num mt-0.5 truncate text-base', tone ?? 'text-ink-hi')} title={value}>
        {value}
      </dd>
      {sub && <dd className="truncate text-xs text-ink-faint">{sub}</dd>}
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

/**
 * 最近一次平仓。
 *
 * 两行封顶（原来是三行）：这一列在总览表里是最长的一段文字，而密度不足
 * 正是本次要修的问题（LAYOUT.md §2）。`pnlPercent` 挪进 `title`，因为它与
 * 旁边的净额是同一次平仓的同一个故事。
 */
export function RecentClose({ trade, pending }: { trade: TradeRecord | undefined; pending: boolean }) {
  if (!trade) {
    return <span className="text-xs text-ink-faint">{pending ? '读取中…' : '暂无平仓'}</span>;
  }
  return (
    <div className="text-right" title={`${fmtPercent(trade.pnlPercent)} · ${closeReasonLabel(trade.closeReason)}`}>
      <div className="flex items-center justify-end gap-1.5">
        <span className="num text-sm text-ink-mid">{trade.symbol}</span>
        <SideBadge side={trade.side} />
        {/* 净，带符号：`fmtUsdSigned` 自己带正负号，颜色只是辅助（DESIGN.md §2） */}
        <span className={cn('num text-xs', pnlColor(trade.netPnl))}>净 {fmtUsdSigned(trade.netPnl, 2)}</span>
      </div>
      <div className="num truncate text-xs text-ink-faint">
        {closeReasonLabel(trade.closeReason)} · {timeAgo(trade.closedAt)}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Suspense fallback                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 曲线 chunk 下载期间的占位。
 *
 * 刻意做成**紧凑**的一条而不是 240px 的空盒子：下载完成前我们并不知道这条
 * 曲线值不值得展开（见 `equityShape`），先撑满一屏高再塌回去比不撑更糟。
 */
export function EquitySkeleton() {
  return (
    <div
      className="flex h-11 animate-pulse-soft items-center gap-3 rounded-lg border border-dashed border-base-750 px-3"
      role="status"
      aria-label="正在加载权益曲线"
    >
      <div className="h-1.5 flex-1 rounded bg-base-850" />
      <span className="shrink-0 text-xs text-ink-faint">正在加载权益曲线…</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Per-bot snapshot table                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The dense per-bot table.
 *
 * Density is the whole point (LAYOUT.md §2), so three things changed together:
 *
 * - **`px-2 py-1.5` instead of the `.td` default `px-3 py-2`.** Eight columns at
 *   16px of side padding each is 256px of the row spent on air, and DESIGN.md §4
 *   forbids horizontal scrolling at 150% zoom. Between padding and information, a
 *   dense financial grid can afford tighter gutters.
 * - **总收益率 folded into 归属权益.** They are one story — the value and how far
 *   it has moved from the initial deposit — and two columns of two lines each
 *   cost more width than the second number was worth. The full
 *   `净 = 毛 − 手续费 − 资金费` identity stays reachable on hover.
 * - **The share bar dropped, 打开 dropped.** The 64px bar was decoration under an
 *   already-coloured number (the share moved into the `title`), and 打开 only
 *   duplicated the row itself — DESIGN.md §6 wants the whole row clickable, not a
 *   small button.
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
            <caption className="sr-only">机器人归属权益与运行状态快照</caption>
            <thead className="border-b border-base-800 bg-base-850/60">
              <tr>
                <th scope="col" className="th px-2 py-1.5">
                  机器人
                </th>
                <th scope="col" className="th px-2 py-1.5">
                  状态
                </th>
                <th scope="col" className="th px-2 py-1.5 text-right">
                  <span title="归属权益 = 初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈。同一账户下其他机器人挣的钱不算在内。">
                    归属权益
                  </span>
                </th>
                <th scope="col" className="th px-2 py-1.5 text-right">
                  持仓
                </th>
                <th scope="col" className="th px-2 py-1.5 text-right">
                  平仓胜率
                </th>
                <th scope="col" className="th px-2 py-1.5 text-right">
                  最近平仓
                </th>
                <th scope="col" className="th px-2 py-1.5 text-right">
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
                const target = `/traders/${trader.id}`;
                return (
                  <tr
                    key={trader.id}
                    className="row-hover cursor-pointer"
                    title="打开该机器人的详情"
                    onClick={() => navigate(target)}
                  >
                    <td className="td px-2 py-1.5">
                      {/* 名称是真正的链接：整行可点，但键盘与"新标签页打开"仍然可用 */}
                      <Link
                        to={target}
                        onClick={(event) => event.stopPropagation()}
                        className="group block min-w-0"
                      >
                        <span className="block truncate text-base font-semibold text-ink-hi group-hover:text-accent">
                          {trader.name}
                        </span>
                        <span className="num block truncate text-xs text-ink-faint">
                          #{trader.id} · 周期 {trader.lastCycleNumber} · 每 {trader.cycleIntervalMinutes}m
                        </span>
                      </Link>
                    </td>
                    <td className="td px-2 py-1.5">
                      <TraderStatusBadge status={status} live={trader.isRunning} />
                      {trader.consecutiveFailures > 0 && (
                        <div className="num mt-0.5 text-xs text-warn">{trader.consecutiveFailures} 次连续失败</div>
                      )}
                    </td>
                    <td
                      className="td px-2 py-1.5 text-right"
                      title={
                        stats
                          ? `归属权益 = 初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈。占全部归属权益的 ${share.toFixed(
                              1,
                            )}%。${pnlFormulaText(statsCosts(stats))}。浮动盈亏 ${fmtUsdSigned(
                              stats.unrealizedPnl,
                              2,
                            )} 未计入本行。`
                          : undefined
                      }
                    >
                      <div className={cn('num', stats ? 'text-ink-hi' : 'text-ink-faint')}>
                        {stats ? fmtUsd(equity, 2) : '—'}
                      </div>
                      {stats && (
                        /* 净领先、毛在 title 里：差额就是成本，而小账户上成本才是重点。
                           总收益率与权益合成一格，因为它们是同一个故事。 */
                        <div className={cn('num text-xs', pnlColor(stats.totalReturnPercent))}>
                          {fmtPercent(stats.totalReturnPercent)} · 净 {fmtUsdSigned(stats.realizedPnl, 2)}
                        </div>
                      )}
                    </td>
                    <td className="td num px-2 py-1.5 text-right">
                      {stats ? fmtInt(stats.openPositions) : '—'}
                      {stats && stats.unrealizedPnl !== 0 && (
                        /* 刻意中性：这一格已经有符号，两个彩色盈亏数字并排会读成
                           一个被拆成两格的数。 */
                        <div className="text-xs text-ink-faint">浮 {fmtUsdSigned(stats.unrealizedPnl, 2)}</div>
                      )}
                    </td>
                    <td className="td num px-2 py-1.5 text-right">
                      {/* `winRatePercent` 与 `wins`/`losses` 都是服务端的读数，
                          这里只并排显示，绝不互相推算（硬规则）。 */}
                      {stats ? `${stats.winRatePercent.toFixed(1)}%` : '—'}
                      {stats && (
                        <div className="text-xs text-ink-faint">
                          {fmtInt(stats.wins)} 盈 / {fmtInt(stats.losses)} 亏
                        </div>
                      )}
                    </td>
                    <td className="td px-2 py-1.5 text-right">
                      <RecentClose trade={recentTrades.byTrader[trader.id]} pending={recentTrades.loading} />
                    </td>
                    <td className="td px-2 py-1.5 text-right">
                      <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
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
      )}
    </>
  );
}
