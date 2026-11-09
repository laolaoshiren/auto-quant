/**
 * 总览页的表现层：紧凑权益条、系统事实、机器人快照表。
 *
 * 从 `OverviewPage.tsx` 拆出来，好让那一页读起来是**结构**（什么放在哪里、
 * 按什么顺序），而不是一整片 Tailwind。这里除了 `useRecentTrades` 之外不做任何
 * 数据请求 —— 那个 hook 也在这里，因为只有「最近平仓」这一列用它。
 *
 * 两处与 LAYOUT.md 直接对应的决定：
 *
 * 1. **图表永远展开、高度固定**（§4）。曲线本身在 `EquityCurveChart.tsx`
 *    （懒加载，把 recharts 挡在首屏之外）；这一页不再按"数据够不够厚"决定
 *    展开还是收成缩略线 —— 那会让版面随数据变高变矮（见 `OverviewPage` 里的说明）。
 * 2. **表格行要密**（§2）。这里把所有单元格压到 `py-1.5` + 两行以内，
 *    并砍掉不挣宽度的那一列（见 `TradersSnapshotTable` 的注释）。
 */
import { Link, type NavigateFunction } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { TraderStats, TradeRecord, TraderStatus } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { closeReasonLabel } from '../lib/summaries';
import type { FleetTotals } from '../lib/fleetTotals';
import { usePolled } from '../lib/hooks';
import { Button, Badge, Panel, cn } from '../components/ui';
import { SideBadge, TraderStatusBadge } from '../components/Badges';
import { ModeBadge } from '../components/TeamRoster';
import { TraderAvatar } from '../components/TraderAvatar';
import { pnlFormulaText, statsCosts } from '../components/PnlBreakdown';
import { BALANCE_LABEL, fmtInt, fmtPercent, fmtUsd, fmtUsdSigned, pnlColor, timeAgo } from '../lib/format';
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
          // 只要最新的一条：`traderTrades` 现在是 `{ limit, before, signal }` 的选项式签名
          // （与 `traderDecisions` 一致，游标分页要能传 `before`）。
          const trades = await api.traderTrades(id, { limit: 1, signal });
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
    <div className="text-right" title={`${fmtPercent(trade.pnlPercent)} · ${closeReasonLabel(trade.closeReason, trade.netPnl)}`}>
      <div className="flex items-center justify-end gap-1.5">
        <span className="num text-sm text-ink-mid">{trade.symbol}</span>
        <SideBadge side={trade.side} />
        {/* 净，带符号：`fmtUsdSigned` 自己带正负号，颜色只是辅助（DESIGN.md §2） */}
        <span className={cn('num text-xs', pnlColor(trade.netPnl))}>净 {fmtUsdSigned(trade.netPnl, 2)}</span>
      </div>
      <div className="num truncate text-xs text-ink-faint">
        {closeReasonLabel(trade.closeReason, trade.netPnl)} · {timeAgo(trade.closedAt)}
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
 *
 * 归属权益这一列**只讲这个机器人自己的账**，而且它上面的合计已经不再用它：
 * 共用同一个交易所账户的机器人各自带着同一笔本金，把这一列加起来会把钱包数 N 遍
 * （实测 Σ30.6690 vs 账户里 10.4180，多算 19.81 —— 见 `lib/fleetTotals.ts`）。
 * 所以行内的 title 改成说清"它属于哪个账户、那个账户里有多少钱"，
 * 原来那句「占全部归属权益的 X%」也删掉了：在共用账户下它本来就不是一个占比。
 */
export function TradersSnapshotTable({
  traders,
  statsMap,
  liveStatus,
  fleet,
  equityOf,
  recentTrades,
  busyId,
  navigate,
  onStop,
  onStart,
  extraCount,
}: {
  traders: TraderRow[];
  statsMap: Record<number, TraderStats>;
  liveStatus: Record<number, TraderStatus | null>;
  /**
   * 舰队合计（账户口径）。这里**只读**每行的账户信息，绝不把它当成一行一行的
   * 归属权益之和 —— 那个和就是本页修掉的 bug。
   */
  fleet: FleetTotals;
  equityOf: (trader: TraderRow) => number;
  recentTrades: { byTrader: Record<number, TradeRecord>; loading: boolean };
  busyId: number | null;
  navigate: NavigateFunction;
  /*
   * 这里原来还有 `runOnceBusyId` 与 `onRunOnce` —— 它们只服务于那个被删掉的
   * 「立即运行」按钮。留一个没人用的 prop 会让下一个读这段代码的人以为
   * "总览页能跑一轮"，而那正是被删掉的那件事。
   */
  onStop: (trader: TraderRow) => void;
  onStart: (trader: TraderRow) => void;
  /** Rows that exist but are not rendered, so the footer link can say how many. */
  extraCount: number;
}) {
  return (
    <>
      <Panel padded={false}>
        {/*
          ⚠️ **不再用 `scroll-x`**（2026-11-10 用户：「不许出现横向滚动条」）。
          7 列在 1280 宽的主栏里放不下，之前的做法是内部横滚 —— 右边界被切、
          底下一根滚动条，而"胜率"这种辅助信息不值得换来一根滚动条。
          现在 `table-fixed` + 按列宽百分比 + 窄屏隐藏辅助列：
            · 平仓胜率 → `2xl`（≥1536）才显示；
            · 最近平仓 → `xl`（≥1280）才显示；
          其余列用 `truncate` 保证不撑宽。
        */}
        <div>
          <table className="w-full table-fixed border-collapse">
            <caption className="sr-only">机器人归属权益与运行状态快照</caption>
            <thead className="border-b border-base-800 bg-base-850/60">
              <tr>
                <th scope="col" className="th w-[25%] px-2 py-1.5">
                  机器人
                </th>
                <th scope="col" className="th w-[10%] px-2 py-1.5">
                  状态
                </th>
                <th scope="col" className="th w-[28%] px-2 py-1.5 text-right">
                  <span title="归属权益 = 初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈。只是这个机器人自己的账，同一账户下其他机器人挣的钱不算在内；反过来，共用同一个账户的机器人各自都带着同一笔本金，所以这一列不能相加（相加会把钱包数 N 遍）。账户里的钱看左栏「账户权益合计」。">
                    归属权益
                  </span>
                </th>
                <th scope="col" className="th w-[9%] px-2 py-1.5 text-right">
                  持仓
                </th>
                <th scope="col" className="th hidden w-[12%] px-2 py-1.5 text-right 2xl:table-cell">
                  平仓胜率
                </th>
                <th scope="col" className="th hidden w-[18%] px-2 py-1.5 text-right xl:table-cell">
                  最近平仓
                </th>
                <th scope="col" className="th w-[9%] px-2 py-1.5 text-right">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {traders.map((trader) => {
                const stats = statsMap[trader.id];
                const status: TraderStatus = liveStatus[trader.id] ?? trader.status;
                const equity = equityOf(trader);
                /*
                 * 这一行的账户上下文。
                 *
                 * 原来这里算的是「占全部归属权益的 X%」—— 在共用账户下那个分母本来就是
                 * 错的（同一笔本金被数了三遍），一个从没成交的机器人也能"占 32%"。改成
                 * 说明它属于哪个账户、那个账户里有多少钱：同样的宽度，说的是真事。
                 */
                const account = fleet.byTrader[trader.id];
                const accountNote = account
                  ? `它属于交易所账户 #${account.exchangeAccountId}（共享钱包，${BALANCE_LABEL.equity} ${fmtUsd(
                      account.accountEquity,
                      2,
                    )}）；该账户下共 ${fmtInt(account.traderIds.length)} 个机器人共用这一个钱包，所以各行的归属权益不能相加。`
                  : '';
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
                        className="group flex min-w-0 items-center gap-2"
                      >
                        <TraderAvatar id={trader.id} size={26} className="shrink-0 rounded-md" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base font-semibold text-ink-hi group-hover:text-accent">
                            {trader.name}
                          </span>
                          <span className="num block truncate text-xs text-ink-faint">
                            周期 {trader.lastCycleNumber} · 每 {trader.cycleIntervalMinutes}m
                          </span>
                          {/*
                           * **总览快照也要一眼看出模式与模拟/实盘**（用户 2026-11-10：
                           * 「也要显示是模拟\实盘」）。列表页已有，总览页当时漏了 ——
                           * 而总览是用户第一眼看的页面，恰恰最需要这两个信息。
                           */}
                          <span className="mt-0.5 flex flex-wrap items-center gap-1">
                            <ModeBadge mode={trader.mode} />
                            <Badge
                              tone="muted"
                              className={
                                trader.dryRun === false
                                  ? 'border-warn/40 bg-warn/15 text-warn'
                                  : trader.dryRun === true
                                    ? 'border-accent/30 bg-accent/10 text-accent'
                                    : 'border-base-700 bg-base-800 text-ink-faint'
                              }
                              title={
                                trader.dryRun === false
                                  ? '实盘：真实资金下单'
                                  : trader.dryRun === true
                                    ? '模拟盘：本地撮合，不涉及真实资金'
                                    : '运行模式未指定（老数据，首次启动时固定）'
                              }
                            >
                              {trader.dryRun === false ? '实盘' : trader.dryRun === true ? '模拟' : '模式未定'}
                            </Badge>
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="td px-2 py-1.5">
                      <TraderStatusBadge status={status} live={trader.isRunning} />
                      {trader.consecutiveFailures > 0 && (
                        <div className="num truncate text-xs text-warn">{trader.consecutiveFailures} 次连续失败</div>
                      )}
                    </td>
                    <td
                      className="td px-2 py-1.5 text-right"
                      title={
                        stats
                          ? `归属权益 = 初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈（只是这个机器人自己的账）。${accountNote}${pnlFormulaText(
                              statsCosts(stats),
                            )}。浮动盈亏 ${fmtUsdSigned(stats.unrealizedPnl, 2)} 未计入本行。`
                          : undefined
                      }
                    >
                      {/*
                        ⚠️ **`truncate` 是必须的**：`table-fixed` 下单元格内容超长会
                        **溢出到相邻列**（不是把列撑宽），两个数字叠在一起看着像 BUG。
                        副行 `+6.47% · 净 +$412.37` 在 1280 宽的主栏里正好卡在边界上。
                      */}
                      <div className={cn('num truncate', stats ? 'text-ink-hi' : 'text-ink-faint')}>
                        {stats ? fmtUsd(equity, 2) : '—'}
                      </div>
                      {stats && (
                        /* 净领先、毛在 title 里：差额就是成本，而小账户上成本才是重点。
                           总收益率与权益合成一格，因为它们是同一个故事。 */
                        <div className={cn('num truncate text-xs', pnlColor(stats.totalReturnPercent))}>
                          {fmtPercent(stats.totalReturnPercent)} · 净 {fmtUsdSigned(stats.realizedPnl, 2)}
                        </div>
                      )}
                    </td>
                    <td className="td num px-2 py-1.5 text-right">
                      <div className="truncate">{stats ? fmtInt(stats.openPositions) : '—'}</div>
                      {stats && stats.unrealizedPnl !== 0 && (
                        /* 刻意中性：这一格已经有符号，两个彩色盈亏数字并排会读成
                           一个被拆成两格的数。 */
                        <div className="truncate text-xs text-ink-faint">浮 {fmtUsdSigned(stats.unrealizedPnl, 2)}</div>
                      )}
                    </td>
                    <td className="td num hidden px-2 py-1.5 text-right 2xl:table-cell">
                      {/* `winRatePercent` 与 `wins`/`losses` 都是服务端的读数，
                          这里只并排显示，绝不互相推算（硬规则）。 */}
                      {stats ? `${stats.winRatePercent.toFixed(1)}%` : '—'}
                      {stats && (
                        <div className="text-xs text-ink-faint">
                          {fmtInt(stats.wins)} 盈 / {fmtInt(stats.losses)} 亏
                        </div>
                      )}
                    </td>
                    <td className="td hidden px-2 py-1.5 text-right xl:table-cell">
                      <RecentClose trade={recentTrades.byTrader[trader.id]} pending={recentTrades.loading} />
                    </td>
                    <td className="td px-2 py-1.5 text-right">
                      <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
                        {/*
                          ⚠️ **这里原来还有一个「立即运行」按钮，已删除。**

                          它做的是"强制执行一个决策周期"（跑一轮分析），**而文案写的是
                          「立即运行」** —— 读起来就是"启动这台机器人"。更糟的是它
                          **和「停止」并排、一绿一红**，那个组合看起来就是「启动 / 停止」
                          这一对开关。操作员很容易以为自己点的是"开始交易"。

                          同一件事在机器人详情页叫「立即分析」（`TraderPage.tsx` 里那段
                          注释自己写着「旧名字『立即运行』把这两件事混成一件」）——
                          当时只改了详情页，这里和「机器人」列表页漏了。

                          而**总览页本来就不该放这个操作**：它要的是"一眼看清每台机器在
                          什么状态"，动作有两个（停止 / 启动）已经够了；真要立刻跑一轮，
                          点进那台机器人即可。去掉之后这一格是干净的**两态**：
                          在跑 → 停止；没在跑 → 启动。
                        */}
                        {/*
                          ⚠️ **`starting` 必须单独占一个分支**（2026-11-10 回归实测）。

                          启动接口是异步的（`stopped → starting → running`，预检/连交易所要几秒到几十秒）。
                          之前这里只判 `isRunning`，于是**已经点过启动之后**这一格仍显示可点的
                          「启动」（回归实测这个窗口约 7 秒）—— 再点一次会被服务端拒绝
                          「正在启动中」，而界面上只看到一个红条，像"点了没反应"。
                          列表页（`TradersPage`）早就有这个分支，总览页漏了。
                        */}
                        {trader.isRunning ? (
                          <Button
                            small
                            variant="danger"
                            busy={busyId === trader.id}
                            title="立即停止：会取消尚未执行的周期，但不会平掉已有持仓"
                            onClick={() => onStop(trader)}
                          >
                            停止
                          </Button>
                        ) : trader.status === 'starting' ? (
                          <Button small variant="success" disabled title="启动中：服务端正在执行预检并拉起循环，状态会自动更新。">
                            启动中
                          </Button>
                        ) : (
                          <Button
                            small
                            variant="success"
                            busy={busyId === trader.id}
                            disabled={busyId === trader.id}
                            onClick={() => onStart(trader)}
                          >
                            {busyId === trader.id ? '启动中…' : '启动'}
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
