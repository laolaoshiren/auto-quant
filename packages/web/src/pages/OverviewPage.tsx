/**
 * System overview — the landing page, and the only screen that has to answer
 * "how is my money doing?" in the first second.
 *
 * Structure, in deliberate order of visual weight (DESIGN.md §4):
 *
 *   1. 头条数字 — 总归属权益 / 今日盈亏 / 总收益率 / 浮动盈亏 at `text-3xl`–`text-4xl`,
 *      full width, one row, nothing else competing with them;
 *   2. 资金曲线 — the whole width and 300px tall. It is the only thing on the
 *      page that shows *shape* rather than a snapshot, so it gets real height;
 *   3. 机器人明细 — smaller and denser; every per-bot control still lives on
 *      「机器人」, this is a read-only snapshot with the two shortcuts an operator
 *      actually wants on arrival;
 *   4. 运行环境 — a footer, at the smallest size on the page.
 *
 * The presentational pieces are in `overviewParts.tsx` so this file stays
 * readable as structure rather than as markup.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bot, CircleAlert, RefreshCw } from 'lucide-react';
import type { EquitySnapshot, TraderStatus } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { useApp, useEvents } from '../lib/store';
import { useSummaries } from '../lib/summaries';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { useRunOnce } from '../lib/actions';
import { Button, Empty, ErrorNote, Panel, Spinner3 } from '../components/ui';
import { SectionHeading, TraderStatusBadge } from '../components/Badges';
import { NewTraderModal, StartTraderModal } from '../components/TraderModals';
import { pnlFormulaText, statsCosts } from '../components/PnlBreakdown';
import { EQUITY_RANGES, mergeEquityCurves, rangeSpanMs, type EquityRange } from '../components/equityCurve';
import { EquitySkeleton, HeadlineMetric, SystemFact, TradersSnapshotTable, useRecentTrades } from './overviewParts';
import {
  fmtAsset,
  fmtClockOffset,
  fmtInt,
  fmtNum,
  fmtPercent,
  fmtUsd,
  fmtUsdSigned,
  pnlColor,
  timeAgo,
} from '../lib/format';

/**
 * The chart is its own chunk, reached only through `lazy`.
 *
 * `recharts` is the largest dependency in the app and the overview page is the
 * first thing loaded after login — importing the chart statically would put the
 * whole library in front of the first paint of the headline numbers. The shell
 * and the four figures render immediately; the curve lands a moment later.
 */
const EquityCurveChart = lazy(() =>
  import('../components/EquityCurveChart').then((module) => ({ default: module.EquityCurveChart })),
);

/** Per-bot rows shown before the page links out to 「机器人」. */
const SNAPSHOT_ROWS = 5;

export function OverviewPage() {
  useDocumentTitle('总览');
  const navigate = useNavigate();
  const user = useApp((s) => s.user);
  const system = useApp((s) => s.system);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const setTraders = useApp((s) => s.setTraders);
  const socketOpen = useEvents((s) => s.status) === 'open';
  const liveByTrader = useEvents((s) => s.byTrader);

  const tradersQuery = usePolled((signal) => api.traders(signal), {
    intervalMs: socketOpen ? 8000 : 4000,
  });
  const traders = tradersQuery.data ?? [];

  const statsMap = useSummaries((s) => s.stats);
  const refreshMany = useSummaries((s) => s.refreshMany);

  const [newOpen, setNewOpen] = useState(false);
  const [startTarget, setStartTarget] = useState<TraderRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [range, setRange] = useState<EquityRange>('7D');
  const [refreshing, setRefreshing] = useState(false);
  const { runOnce, busyId: runOnceBusyId } = useRunOnce();

  useEffect(() => {
    if (tradersQuery.data) setTraders(tradersQuery.data);
  }, [tradersQuery.data, setTraders]);

  const traderIds = traders.map((t) => t.id).join(',');

  useEffect(() => {
    const ids = traderIds ? traderIds.split(',').map(Number) : [];
    if (ids.length === 0) return;
    void refreshMany(ids);
    const timer = window.setInterval(() => void refreshMany(ids), socketOpen ? 10_000 : 5000);
    return () => window.clearInterval(timer);
  }, [traderIds, refreshMany, socketOpen]);

  /*
   * A deliberate 60s poll, slower than everything else on the page.
   *
   * Snapshots are only written at the end of a decision cycle (minutes apart),
   * so polling them at the trader-list cadence would spend one request per
   * trader every few seconds to redraw an identical curve.
   */
  const equityQuery = usePolled<EquitySnapshot[][]>(
    async (signal) => {
      const ids = traderIds ? traderIds.split(',').map(Number) : [];
      return Promise.all(ids.map((id) => api.traderEquity(id, 360, signal)));
    },
    { intervalMs: 60_000, enabled: traders.length > 0, deps: [traderIds] },
  );

  /*
   * The combined curve is assembled from three sources, in one place:
   *
   * - the REST snapshots (drawn even before the socket connects);
   * - whatever the live socket has pushed since (far fresher than a 60s poll, so
   *   the curve grows while the operator is watching instead of stepping once a
   *   minute);
   * - each trader's `initialEquity`, used only to hold that trader's line flat
   *   back to the start of the window — see `mergeEquityCurves`.
   */
  const equityStored: Record<number, EquitySnapshot[]> = {};
  const equityLive: Record<number, EquitySnapshot[]> = {};
  const equityBaseline: Record<number, number> = {};
  traders.forEach((trader, index) => {
    equityStored[trader.id] = equityQuery.data?.[index] ?? [];
    equityBaseline[trader.id] = trader.initialEquity;
    const live = liveByTrader[trader.id]?.equity;
    if (live && live.length > 0) equityLive[trader.id] = live;
  });
  const curve = mergeEquityCurves([{ series: equityStored, live: equityLive, baseline: equityBaseline }]);

  const runningCount = traders.filter((t) => t.isRunning).length;
  /** Falls back to `initialEquity` until the first stats response lands, so the total never reads 0. */
  const equityOf = (trader: TraderRow): number => statsMap[trader.id]?.equity ?? trader.initialEquity;
  const totalEquity = traders.reduce((sum, trader) => sum + equityOf(trader), 0);
  const totalBaseline = traders.reduce((sum, trader) => sum + trader.initialEquity, 0);
  const totalOpen = traders.reduce((sum, trader) => sum + (statsMap[trader.id]?.openPositions ?? 0), 0);
  const unrealized = traders.reduce((sum, trader) => sum + (statsMap[trader.id]?.unrealizedPnl ?? 0), 0);
  const withStats = traders.filter((trader) => statsMap[trader.id] !== undefined).length;
  const statsPending = traders.length > 0 && withStats < traders.length;
  const totalReturnPercent = totalBaseline > 0 ? ((totalEquity - totalBaseline) / totalBaseline) * 100 : 0;

  /**
   * Start of the selected window, plus whether that start is really the start of
   * the window or merely the oldest snapshot there is.
   *
   * `windowStartValue` comes off the same curve that is drawn, so the change shown
   * above the chart and the shape of the chart can never disagree. When the window
   * holds fewer than two points it falls back to the earliest recorded value — and
   * the label has to say so, otherwise a young account's whole history gets
   * presented as "今日盈亏". `null` means there is nothing recorded at all, in
   * which case the page says that instead of printing an invented 0.
   */
  const dayStart = Date.now() - rangeSpanMs('1D');
  const inDay = curve.find((point) => point.t >= dayStart);
  const windowStartValue = (() => {
    const span = rangeSpanMs(range);
    if (!Number.isFinite(span) || curve.length === 0) return curve[0]?.equity ?? null;
    const cutoff = Date.now() - span;
    return curve.find((point) => point.t >= cutoff)?.equity ?? curve[0]?.equity ?? null;
  })();
  const equityChange = windowStartValue === null ? null : totalEquity - windowStartValue;
  const equityChangePercent =
    windowStartValue !== null && windowStartValue !== 0 && equityChange !== null
      ? (equityChange / Math.abs(windowStartValue)) * 100
      : null;
  /** The 24h window is genuinely covered, so the figure can be called 今日. */
  const has24hCoverage = inDay !== undefined && inDay.t <= dayStart + 5 * 60_000;

  /*
   * Only the traders actually rendered, and only the running ones.
   *
   * There is no bulk endpoint for trades, so this is one request per id — keyed
   * to what the table can display keeps the page's request count bounded no
   * matter how many bots are saved.
   */
  const snapshotRows = traders.slice(0, SNAPSHOT_ROWS);
  const recentTrades = useRecentTrades(
    snapshotRows.filter((trader) => trader.isRunning).map((trader) => trader.id),
  );

  /** Last status pushed over the socket, per trader — newer than anything REST has. */
  const liveStatus: Record<number, TraderStatus | null> = {};
  for (const trader of traders) liveStatus[trader.id] = liveByTrader[trader.id]?.status ?? null;

  const stop = async (trader: TraderRow) => {
    setBusyId(trader.id);
    setActionError(null);
    try {
      await api.stopTrader(trader.id);
      await tradersQuery.reload();
      refreshSystem();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  /**
   * One manual refresh that cannot mislead: it is busy-labelled and it reloads
   * every region on the page, so an operator who has just placed a trade does
   * not have to guess whether the numbers in front of them are current.
   */
  const refreshAll = () => {
    setRefreshing(true);
    tradersQuery.reload();
    refreshSystem();
    const ids = traderIds ? traderIds.split(',').map(Number) : [];
    if (ids.length > 0) void refreshMany(ids);
    window.setTimeout(() => setRefreshing(false), 600);
  };

  const listFailed = tradersQuery.error !== null && tradersQuery.data === null;

  return (
    <div className="space-y-5">
      <ErrorNote>{actionError}</ErrorNote>

      {/* ------------------------------------------------------------------ */}
      {/*  1. 头条数字                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="overview-headline"
        className="rounded-lg border border-base-750 bg-base-900 px-4 py-4 shadow-panel sm:px-5 sm:py-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 id="overview-headline" className="text-md font-semibold text-ink-hi">
            欢迎回来{user?.username ? `，${user.username}` : ''}
          </h2>
          <div className="flex items-center gap-2">
            <span className="num text-xs text-ink-faint">
              更新于 {timeAgo(tradersQuery.updatedAt ? new Date(tradersQuery.updatedAt).toISOString() : null)}
            </span>
            <Button
              small
              variant="ghost"
              busy={refreshing}
              onClick={refreshAll}
              title="重新读取机器人列表、统计与系统状态"
            >
              <RefreshCw aria-hidden className="h-3.5 w-3.5" />
              刷新
            </Button>
          </div>
        </div>

        {/* 权益 leads and is the widest cell: it is the number an operator checks
            first, and giving it the same weight as 浮动盈亏 would flatten the page. */}
        <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-[1.35fr_1fr_1fr_1fr]">
          <HeadlineMetric
            label="总归属权益"
            value={fmtAsset(totalEquity, 'USDT', 2)}
            valueClass="text-ink-strong"
            loading={tradersQuery.loading && tradersQuery.data === null}
            sub={
              equityChange === null ? (
                '还没有权益快照'
              ) : (
                <>
                  <span className={pnlColor(equityChange)}>
                    {fmtUsdSigned(equityChange, 2)}
                    {equityChangePercent !== null && ` · ${fmtPercent(equityChangePercent)}`}
                  </span>{' '}
                  <span className="text-ink-faint">{has24hCoverage ? '24 小时' : `较${range === 'ALL' ? '起始' : `近 ${range}`}`}</span>
                </>
              )
            }
            title="各机器人归属权益之和 = Σ(初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈)。共用同一个交易所账户的机器人各自独立归属，所以这个合计不等于账户里的钱（账户权益在机器人页与交易所凭证页）。"
          />

          <HeadlineMetric
            /* The honest label changes with the data: calling a two-hour-old
               account's entire history "今日盈亏" would misreport it by orders of
               magnitude on the one number the page exists to show. */
            label={has24hCoverage ? '今日盈亏' : '区间盈亏'}
            value={equityChange === null ? '—' : <span className={pnlColor(equityChange)}>{fmtUsdSigned(equityChange, 2)}</span>}
            sub={
              equityChangePercent === null
                ? '还没有权益快照'
                : has24hCoverage
                  ? `24 小时 · ${fmtPercent(equityChangePercent)}`
                  : `自最早快照 · ${fmtPercent(equityChangePercent)}`
            }
            title="归属权益最近 24 小时的变化（按快照口径）。它同时包含已实现与浮动盈亏，因此不再分别累加，避免重复计算。快照不足 24 小时时改显示自最早一条快照以来的变化。"
          />

          <HeadlineMetric
            label="总收益率"
            value={
              <span className={traders.length > 0 ? pnlColor(totalReturnPercent) : undefined}>
                {traders.length > 0 ? fmtPercent(totalReturnPercent) : '—'}
              </span>
            }
            sub={`初始投入 ${fmtUsd(totalBaseline, 2)}`}
            loading={statsPending}
            title="（当前总归属权益 − 初始投入）÷ 初始投入。初始投入取各机器人的 initialEquity 之和。"
          />

          <HeadlineMetric
            label="浮动盈亏"
            value={<span className={pnlColor(unrealized)}>{fmtUsdSigned(unrealized, 2)}</span>}
            valueClass={pnlColor(unrealized)}
            sub={`${fmtInt(totalOpen)} 个持仓 · 未落袋`}
            loading={statsPending}
            title="所有机器人**自己的**持仓的未实现盈亏合计（不是交易所账户的总浮盈 —— 账户的总浮盈在同一账户下的每个机器人身上都是同一个数）。它随时在变，且尚未计入已实现盈亏。"
          />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/*  2. 资金曲线                                                        */}
      {/* ------------------------------------------------------------------ */}
      <Panel
        padded={false}
        bodyClassName="p-3"
        title="各机器人的归属权益曲线之和"
        actions={
          <div role="group" aria-label="曲线时间范围" className="flex items-center gap-1">
            {EQUITY_RANGES.map((item) => (
              <Button
                key={item.id}
                small
                variant={range === item.id ? 'primary' : 'ghost'}
                aria-pressed={range === item.id}
                onClick={() => setRange(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        }
      >
        {equityQuery.error ? (
          <ErrorNote>{equityQuery.error}</ErrorNote>
        ) : (
          <Suspense fallback={<EquitySkeleton height={300} />}>
            <EquityCurveChart
              points={curve}
              range={range}
              height={300}
              baseline={totalBaseline > 0 ? totalBaseline : undefined}
              primaryLabel="总归属权益"
            />
          </Suspense>
        )}
        <p className="num mt-1.5 text-xs text-ink-faint">
          {equityQuery.loading && equityQuery.data !== null
            ? '正在更新曲线…'
            : `共 ${fmtInt(curve.length)} 个快照点 · 每个决策周期结束记录一次`}
        </p>
      </Panel>

      {/* ------------------------------------------------------------------ */}
      {/*  3. 机器人明细                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="overview-traders">
        <SectionHeading
          title="机器人"
          sub={
            <span className="num">
              {fmtInt(traders.length)} 个已配置 · {fmtInt(runningCount)} 个运行中 · {fmtInt(totalOpen)} 个持仓
            </span>
          }
          right={
            <>
              <Link to="/traders" className="btn btn-ghost">
                管理机器人
              </Link>
              <Button variant="primary" onClick={() => setNewOpen(true)}>
                新建机器人
              </Button>
            </>
          }
        />
        <h2 id="overview-traders" className="sr-only">
          机器人明细
        </h2>

        {listFailed ? (
          <Panel>
            <ErrorNote>{tradersQuery.error}</ErrorNote>
            <Button className="mt-2" onClick={tradersQuery.reload}>
              重试
            </Button>
          </Panel>
        ) : tradersQuery.loading && tradersQuery.data === null ? (
          <Panel>
            <Spinner3 label="正在读取机器人" />
          </Panel>
        ) : traders.length === 0 ? (
          <Panel>
            <Empty
              icon={<Bot aria-hidden className="h-5 w-5" />}
              message="还没有机器人，先创建一个。"
              hint="创建后默认以「模拟」模式运行：不需要交易所密钥、不下真实订单，可以先看几轮决策再决定是否切到实盘。"
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button variant="primary" onClick={() => setNewOpen(true)}>
                    新建机器人
                  </Button>
                  <Link to="/exchanges" className="btn btn-ghost">
                    先去配置交易所
                  </Link>
                </div>
              }
            />
          </Panel>
        ) : (
          <TradersSnapshotTable
            traders={snapshotRows}
            statsMap={statsMap}
            liveStatus={liveStatus}
            totalEquity={totalEquity}
            equityOf={equityOf}
            recentTrades={recentTrades}
            busyId={busyId}
            runOnceBusyId={runOnceBusyId}
            navigate={navigate}
            onRunOnce={(trader) => void runOnce(trader.id, trader.name)}
            onStop={(trader) => void stop(trader)}
            onStart={setStartTarget}
            extraCount={traders.length - snapshotRows.length}
          />
        )}

        {!listFailed && tradersQuery.error && (
          <ErrorNote className="mt-2">最近一次刷新失败，下面是上一次的数据：{tradersQuery.error}</ErrorNote>
        )}
        {statsPending && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-faint">
            <CircleAlert aria-hidden className="h-3.5 w-3.5" />
            正在读取 {traders.length - withStats} 个机器人的统计…
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/*  4. 运行环境（页脚，全页最小字号）                                   */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="overview-system" className="rounded-lg border border-base-800 bg-base-900/60 px-4 py-3">
        <h2 id="overview-system" className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-lo">
          运行环境
        </h2>
        <dl className="num mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3 xl:grid-cols-6">
          <SystemFact label="环境" value={system?.environmentLabel ?? '—'} sub={system?.environment} />
          <SystemFact
            label="模式"
            value={system ? (system.dryRun ? '模拟' : '实盘资金') : '—'}
            sub={system?.tradingDisabled ? '交易已禁用' : '交易已启用'}
            tone={system ? (system.dryRun ? 'text-accent' : 'text-warn') : undefined}
          />
          <SystemFact
            label="时钟偏移"
            value={fmtClockOffset(system?.clockOffsetMs)}
            sub="本地 − 交易所"
            tone={(system?.clockOffsetMs ?? 0) > 2000 ? 'text-warn' : undefined}
          />
          <SystemFact
            label="API 权重"
            value={`${fmtNum(system?.weightUsed ?? 0, 0)} / ${fmtNum(system?.weightLimit ?? 0, 0)}`}
            sub="当前分钟"
          />
          <SystemFact label="可交易对" value={fmtInt(system?.tradableSymbols)} sub="USDT-M 永续" />
          <SystemFact
            label="推送"
            value={socketOpen ? '实时' : '轮询'}
            sub={socketOpen ? 'WebSocket 已连接' : '已退回轮询'}
            tone={socketOpen ? 'text-up' : 'text-warn'}
          />
        </dl>

        {system?.tradingDisabled && (
          <div className="mt-3 rounded-md border border-down/60 bg-down/10 px-3 py-2">
            <div className="flex items-center gap-1.5 text-base font-semibold text-down">
              <CircleAlert aria-hidden className="h-4 w-4 shrink-0" />
              全局交易已禁用
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-mid">
              服务端已设置 <span className="num text-ink-hi">GLOBAL_TRADING_DISABLED</span>
              ：所有启动请求都会返回 HTTP 503，且无法下任何订单，但平仓与对账仍然可用。要恢复交易，请从服务端环境中移除该变量并重启。
            </p>
          </div>
        )}

        {!system && <Spinner3 label="正在读取系统状态" />}
      </section>

      <NewTraderModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(trader) => {
          setNewOpen(false);
          void tradersQuery.reload();
          refreshSystem();
          setStartTarget(trader);
        }}
      />

      <StartTraderModal
        trader={startTarget}
        open={startTarget !== null}
        onClose={() => setStartTarget(null)}
        initialDryRun={system?.dryRun ?? true}
        onStarted={() => {
          void tradersQuery.reload();
          refreshSystem();
        }}
      />
    </div>
  );
}
