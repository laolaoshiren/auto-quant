import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Play, RefreshCw, RotateCw, Settings2, Square } from 'lucide-react';
import type { EquitySnapshot } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { useApp, useEvents } from '../lib/store';
import { useSummaries } from '../lib/summaries';
import { useDocumentTitle, usePolled, useTicker } from '../lib/hooks';
import { useReconcile, useRunOnce } from '../lib/actions';
import { Badge, Button, Dot, Empty, ErrorNote, Panel, Spinner3, cn } from '../components/ui';
import { TraderStatusBadge } from '../components/Badges';
import { DecisionFeed } from '../components/DecisionFeed';
import { TraderTables, type TraderTabId } from '../components/TraderTables';
import { NET_PNL_FORMULA, PnlBreakdown, pnlFormulaText, statsCosts } from '../components/PnlBreakdown';
import {
  DashboardEquityChart,
  WinLossBar,
} from '../components/DashboardCharts';
import { EQUITY_RANGES, type EquityRange } from '../components/equityCurve';
import { CandlestickChart } from '../components/CandlestickChart';
import { StartTraderModal } from '../components/TraderModals';
import { TraderConfigModal } from '../components/TraderConfigModal';
import { TraderAccountStrip, type TraderAccountState } from '../components/BalanceCells';
import {
  DEFAULT_SETTLE_ASSET,
  fmtAsset,
  fmtCompact,
  fmtDateTime,
  fmtInt,
  fmtNum,
  fmtPercent,
  fmtProfitFactor,
  fmtUsd,
  fmtUsdSigned,
  pnlColor,
  timeAgo,
} from '../lib/format';

type ChartTab = 'equity' | 'candles';

/** One day, in ms — the window behind the 今日盈亏 KPI. */
const DAY_MS = 24 * 3600 * 1000;

/** How tall the decision feed scrolls before it scrolls internally. */
const FEED_HEIGHT = 720;

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Narrow the untyped `/traders/:id/account` payload.
 *
 * The endpoint returns the exchange's own account object, whose shape is owned
 * by the backend; only the balance fields are read here, and anything missing
 * stays `undefined` so the panel shows `—` instead of a fabricated zero.
 */
function toAccountState(raw: Record<string, unknown> | null): TraderAccountState | null {
  if (!raw) return null;
  const equity = num(raw.equity);
  const walletBalance = num(raw.walletBalance);
  const availableBalance = num(raw.availableBalance);
  if (equity === undefined || walletBalance === undefined || availableBalance === undefined) {
    return null;
  }
  return {
    equity,
    walletBalance,
    availableBalance,
    unrealizedPnl: num(raw.unrealizedPnl) ?? 0,
    marginUsed: num(raw.marginUsed) ?? 0,
    openOrderMargin: num(raw.openOrderMargin),
  };
}

/**
 * The running-bot dashboard.
 *
 * Laid out in descending order of what an operator reads, per DESIGN.md §4:
 *
 *   1. who this is + what it is doing (header + actions)
 *   2. the five numbers that answer "am I up or down" (KPI band, full width)
 *   3. the equity curve — the shape of that answer over time
 *   4. the decision feed — a full-width *section*, not a sidebar: each cycle now
 *      renders its decisions in full, so at rail width the cards were wrapping
 *      into unreadable columns
 *   5. the tables, which are reference material rather than something watched
 *
 * The old layout put the feed in a 48% column and the tables beside it. Both
 * lost: the tables were clipped at five rows and the feed's decision cards were
 * squeezed. Stacking them gives each the width its content actually needs.
 */
export function TraderPage() {
  const params = useParams();
  const traderId = Number(params.id);
  const navigate = useNavigate();
  const system = useApp((s) => s.system);
  const socketOpen = useEvents((s) => s.status) === 'open';
  const live = useEvents((s) => (Number.isFinite(traderId) ? s.byTrader[traderId] : undefined));
  const liveStatus = live?.status ?? null;
  const statsMap = useSummaries((s) => s.stats);
  const fetchStats = useSummaries((s) => s.fetchOne);

  const [startOpen, setStartOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tableTab, setTableTab] = useState<TraderTabId>('positions');
  const [chartTab, setChartTab] = useState<ChartTab>('equity');
  const [range, setRange] = useState<EquityRange>('ALL');
  // Bumped after a manual 对账 so the tables refetch instead of waiting out
  // their 15-second poll.
  const [tradesToken, setTradesToken] = useState(0);
  const tick = useTicker(5000);
  const { runOnce, busyId: runOnceBusyId } = useRunOnce();
  const { reconcile, busyId: reconcileBusyId } = useReconcile();

  const tradersQuery = usePolled((signal) => api.traders(signal), {
    intervalMs: socketOpen ? 8000 : 4000,
  });
  const modelsQuery = usePolled((signal) => api.aiModels(signal), { intervalMs: 60_000 });
  const strategiesQuery = usePolled((signal) => api.strategies(signal), { intervalMs: 60_000 });
  const equityQuery = usePolled((signal) => api.traderEquity(traderId, 2000, signal), {
    intervalMs: 20_000,
    enabled: Number.isFinite(traderId),
    deps: [traderId],
  });

  // The exchange's own view of the account. `fetchAccountState` reads live from
  // the exchange, so this is polled only while the tab is visible and rarely —
  // the running loop fetches the same figures every cycle anyway.
  const [tabVisible, setTabVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  useEffect(() => {
    const onVisibility = () => setTabVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const accountQuery = usePolled((signal) => api.traderAccount(traderId, signal), {
    intervalMs: 60_000,
    enabled: Number.isFinite(traderId) && tabVisible,
    deps: [traderId, tabVisible],
  });

  const accountState = toAccountState(accountQuery.data?.account ?? null);

  /*
   * The settlement unit the exchange reports, reused by the KPI band's 起始余额 /
   * 权益 pair so both read in the same unit as the account strip underneath.
   * Falls back to USDT, which is what every payload we have actually uses.
   */
  const rawAsset = accountQuery.data?.account?.asset;
  const settleAsset = typeof rawAsset === 'string' && rawAsset.trim() ? rawAsset.trim() : DEFAULT_SETTLE_ASSET;

  const trader: TraderRow | null = tradersQuery.data?.find((row) => row.id === traderId) ?? null;
  const status = liveStatus ?? trader?.status ?? 'stopped';
  const stats = statsMap[traderId] ?? null;

  useDocumentTitle(trader?.name ?? `机器人 ${params.id}`);

  useEffect(() => {
    if (!Number.isFinite(traderId)) return;
    void fetchStats(traderId);
    const timer = window.setInterval(() => void fetchStats(traderId), socketOpen ? 12_000 : 6_000);
    return () => window.clearInterval(timer);
  }, [traderId, fetchStats, socketOpen]);

  /* --- derived headline numbers ----------------------------------------- */

  const positions = live?.positions ?? [];
  const openOrders = (live?.orders ?? []).filter(
    (order) => !/FILLED|CANCELED|CANCELLED|REJECTED|EXPIRED/i.test(order.status),
  );

  // A REST page wins, but the socket appends snapshots between polls, so both
  // are merged and de-duplicated by timestamp.
  const snapshots: EquitySnapshot[] = useMemo(() => {
    const merged = new Map<string, EquitySnapshot>();
    for (const row of equityQuery.data ?? []) merged.set(row.timestamp, row);
    for (const row of live?.equity ?? []) merged.set(row.timestamp, row);
    return [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [equityQuery.data, live?.equity]);

  const equity = stats?.equity ?? snapshots[snapshots.length - 1]?.equity ?? trader?.initialEquity ?? 0;
  const marginUsed = positions.reduce((sum, p) => sum + p.marginUsed, 0);
  const notional = positions.reduce((sum, p) => sum + p.notional, 0);
  const effectiveLeverage = equity > 0 ? notional / equity : 0;
  const unrealized = stats?.unrealizedPnl ?? positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const realized = stats?.realizedPnl ?? 0;
  // Real counts straight from the API. Deriving them from `winRatePercent` was
  // both lossy and, once the unit was misread, wildly wrong.
  const wins = stats?.wins ?? 0;
  const losses = stats?.losses ?? 0;
  const openPositionCount = positions.length || stats?.openPositions || 0;

  /*
   * 今日盈亏 against the last snapshot from *before* the 24-hour window.
   *
   * The newest snapshot older than 24h is deliberately preferred over the
   * oldest one inside the window: with a 15-minute cycle the in-window
   * comparison is only two hours old, which would report a session move as a
   * day's PnL. Falls back to the oldest snapshot when the account is younger
   * than a day, and to 0 when there is nothing to compare against.
   */
  const dayAgoEquity = useMemo(() => {
    if (snapshots.length === 0) return undefined;
    const cutoff = Date.now() - DAY_MS;
    let before: EquitySnapshot | undefined;
    for (const snapshot of snapshots) {
      if (new Date(snapshot.timestamp).getTime() < cutoff) before = snapshot;
      else break;
    }
    // `snapshots[0]` is defined here — an empty list returned above — but the
    // index signature cannot say so, hence the explicit fallback.
    return (before ?? snapshots[0])?.equity;
  }, [snapshots]);

  const todayPnl = dayAgoEquity === undefined ? 0 : equity - dayAgoEquity;
  const todayPercent = dayAgoEquity ? (todayPnl / Math.abs(dayAgoEquity)) * 100 : 0;

  const model = modelsQuery.data?.find((row) => row.id === trader?.aiModelId) ?? null;
  const strategy = strategiesQuery.data?.find((row) => row.id === trader?.strategyId) ?? null;

  const stop = async () => {
    if (!trader) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.stopTrader(trader.id);
      await tradersQuery.reload();
      void fetchStats(trader.id);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Rebuild the books from the exchange's own fill history.
   *
   * Works while the bot is stopped — that is the point: a position closed by an
   * exchange-side take-profit while the process was down is only recoverable
   * this way. Never places an order.
   */
  const onReconcile = async () => {
    if (!trader) return;
    const outcome = await reconcile(trader.id, trader.name);
    if (!outcome.ok) {
      setActionError(outcome.message);
      return;
    }
    setActionError(null);
    setTradesToken((n) => n + 1);
    await fetchStats(trader.id);
    await tradersQuery.reload();
  };

  if (!Number.isFinite(traderId)) return <ErrorNote>机器人 ID 无效。</ErrorNote>;
  if (tradersQuery.loading && !trader) return <Spinner3 label="正在加载机器人" />;

  if (!trader) {
    return (
      <Panel title="未找到机器人">
        <p className="text-base text-ink-lo">
          {tradersQuery.error ?? `没有 id 为 ${traderId} 的机器人。它可能已被删除。`}
        </p>
        <Button className="mt-3" onClick={() => navigate('/traders')}>
          返回机器人列表
        </Button>
      </Panel>
    );
  }

  const statsCost = stats ? statsCosts(stats) : null;

  return (
    // `max-w` only for the ultra-wide case: past ~1760px the equity curve and
    // the tables stretch into unreadable spans. Everything below 3xl is fluid.
    <div className="mx-auto w-full max-w-[110rem] space-y-3">
      {/* A. Identity + controls ------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          to="/traders"
          className="inline-flex items-center gap-1 text-base text-ink-lo transition hover:text-accent"
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
          机器人
        </Link>

        <span className="h-4 w-px bg-base-700" aria-hidden />

        <h1 className="min-w-0 truncate text-xl font-semibold tracking-wide text-ink-hi">{trader.name}</h1>
        <Badge tone="muted">#{trader.id}</Badge>
        <TraderStatusBadge status={status} live={trader.isRunning} />
        {trader.consecutiveFailures > 0 && (
          <Badge tone="warn" title="连续的模型或执行失败次数；超过熔断阈值会进入安全模式。">
            {trader.consecutiveFailures} 次连续失败
          </Badge>
        )}

        <span className="ml-auto flex flex-wrap items-center gap-2 text-xs text-ink-faint">
          <Badge tone={socketOpen ? 'up' : 'warn'}>
            <Dot tone={socketOpen ? 'up' : 'warn'} pulse={!socketOpen} />
            {socketOpen ? '实时事件' : 'REST 轮询'}
          </Badge>
          {tick > 0 && (
            <span className="num" title="本地时钟，每 5 秒刷新">
              时刻 {new Date(tick).toLocaleTimeString('en-GB', { hour12: false })}
            </span>
          )}
        </span>
      </div>

      {/* B. The controls, and the one-line provenance of the numbers below */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="num flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-lo">
          <span title="该机器人已完成的决策周期数（跨重启连续编号）。">
            周期 <span className="text-ink-mid">#{fmtInt(trader.lastCycleNumber)}</span>
          </span>
          <span>
            间隔 <span className="text-ink-mid">每 {trader.cycleIntervalMinutes}m</span>
          </span>
          <span>
            最近周期 <span className="text-ink-mid">{timeAgo(trader.lastCycleAt)}</span>
          </span>
          <span title="模型与策略决定它看什么、怎么下单。">
            AI{' '}
            <Link to="/models" className="text-accent hover:underline">
              {model ? `${model.label}（${model.model}）` : `#${trader.aiModelId}`}
            </Link>
          </span>
          <span>
            策略{' '}
            <Link to={`/strategy/${trader.strategyId}`} className="text-accent hover:underline">
              {strategy?.name ?? `#${trader.strategyId}`}
            </Link>
          </span>
          <span>
            环境 <span className="text-ink-mid">{system?.environmentLabel ?? '—'}</span>
          </span>
          <span>
            创建于 <span className="text-ink-mid">{fmtDateTime(trader.createdAt)}</span>
          </span>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {trader.isRunning && (
            <Button
              variant="primary"
              busy={runOnceBusyId === trader.id}
              title="立即强制执行一个决策周期，无需等待间隔"
              onClick={() => void runOnce(trader.id, trader.name)}
            >
              <RotateCw aria-hidden className="h-3.5 w-3.5" />
              立即运行
            </Button>
          )}
          {trader.isRunning ? (
            <Button variant="danger" busy={busy} onClick={() => void stop()}>
              <Square aria-hidden className="h-3.5 w-3.5" />
              停止
            </Button>
          ) : (
            <Button variant="success" onClick={() => setStartOpen(true)}>
              <Play aria-hidden className="h-3.5 w-3.5" />
              启动
            </Button>
          )}
          <Button onClick={() => setConfigOpen(true)} disabled={trader.isRunning} title="请先停止该机器人再编辑">
            <Settings2 aria-hidden className="h-3.5 w-3.5" />
            配置
          </Button>
          <Button
            busy={reconcileBusyId === trader.id}
            title="从交易所自己的成交历史重建本机器人的账本（不下任何订单）：补录漏记的平仓、修正手续费与资金费。机器人停止时也可用。"
            onClick={() => void onReconcile()}
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
            对账
          </Button>
        </div>
      </div>

      {actionError && <ErrorNote>{actionError}</ErrorNote>}

      {status === 'safe_mode' && (
        <div className="rounded-md border border-warn/60 bg-warn/10 px-3 py-2 text-base text-warn">
          <span className="font-semibold">已进入安全模式。</span> 连续的模型或执行失败超过了熔断阈值。循环仍在运行，
          但只会每隔几个周期探测一次模型，直到再次成功。
        </div>
      )}

      {status === 'error' && trader.lastError && (
        <div className="rounded-md border border-down/60 bg-down/10 px-3 py-2 text-base text-down">
          <span className="font-semibold">最近错误：</span> <span className="num">{trader.lastError}</span>
        </div>
      )}

      {/* C. KPI band ------------------------------------------------------- */}
      {/*
        The most prominent thing on the page, per DESIGN.md §4: five numbers,
        each on its own cell, `text-3xl` against `text-xs` labels. Nothing else
        on this page is allowed to compete with them.
      */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
        <Kpi
          label={`归属权益（${settleAsset}）`}
          value={fmtNum(equity, 4)}
          tone="text-ink-strong"
          sub={
            <>
              {stats ? (
                <span className={pnlColor(stats.totalReturnPercent)}>
                  总收益率 {fmtPercent(stats.totalReturnPercent)}
                </span>
              ) : (
                '等待统计'
              )}
              {/*
                起始余额 sits in the same cell as 权益 on purpose: it is a
                baseline, not a balance, and the only way that reads correctly is
                right next to the current figure it is the baseline *for*.
              */}
              <span className="block" title="创建该机器人时从交易所读取的钱包余额，是总收益率与盈亏的计算基准。">
                起始余额 <span className="text-ink-lo">{fmtAsset(trader.initialEquity, settleAsset, 4)}</span>
              </span>
            </>
          }
          title="归属权益 = 初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈。它只包含这个机器人自己的交易；下面的「交易所账户」一栏才是共用的钱包余额。"
        />

        <Kpi
          label="今日盈亏"
          value={fmtUsdSigned(todayPnl, 2)}
          tone={pnlColor(todayPnl)}
          sub={
            <>
              <span className={pnlColor(todayPnl)}>{fmtPercent(todayPercent)}</span>
              <span className="block" title="相对 24 小时前最近一个权益快照的变化。">
                基准 {fmtNum(dayAgoEquity ?? equity, 2)} {settleAsset}
              </span>
            </>
          }
        />

        <Kpi
          label="胜率"
          value={stats ? `${stats.winRatePercent.toFixed(1)}%` : '—'}
          sub={
            stats ? (
              <>
                <span className="block">
                  {fmtInt(stats.totalTrades)} 笔已平仓 · PF {fmtProfitFactor(stats.profitFactor)}
                </span>
                <span className="block">
                  <WinLossBar wins={wins} losses={losses} />
                </span>
              </>
            ) : (
              '等待统计'
            )
          }
        />

        <Kpi
          label="持仓数"
          value={fmtInt(openPositionCount)}
          sub={
            <>
              <span className="block">
                {openOrders.length} 个挂单
              </span>
              <span className={pnlColor(unrealized)}>浮动 {fmtUsdSigned(unrealized, 2)}</span>
            </>
          }
        />

        <Kpi
          label={`保证金（${settleAsset}）`}
          value={fmtNum(marginUsed, 2)}
          sub={
            <>
              <span>
                名义 <span className="text-ink-lo">{fmtUsd(notional, 2)}</span>
              </span>
              <span className="block" title="有效杠杆 = 本机器人总名义价值 ÷ 归属权益。满仓 10x 时读数最高。">
                有效杠杆 <span className="text-ink-mid">{effectiveLeverage.toFixed(2)}x</span>
              </span>
            </>
          }
        />
      </div>

      {/* D. Live exchange account ----------------------------------------- */}
      {/*
        Kept outside the KPI band because it is the exchange's own view, read on
        demand: it is the reconciliation surface for the equity above, not a
        second opinion about it.
      */}
      <TraderAccountStrip
        account={accountState}
        asset={settleAsset}
        busy={accountQuery.loading}
        error={accountQuery.error}
        onRefresh={accountQuery.reload}
      />

      {/* E. Equity / candles ---------------------------------------------- */}
      <Panel
        padded={false}
        bodyClassName="p-0"
        title={
          <span className="flex items-center gap-1">
            <ChartTabButton active={chartTab === 'equity'} onClick={() => setChartTab('equity')}>
              归属权益曲线
            </ChartTabButton>
            <ChartTabButton active={chartTab === 'candles'} onClick={() => setChartTab('candles')}>
              行情图表
            </ChartTabButton>
          </span>
        }
        actions={
          chartTab === 'equity' ? (
            <span className="flex items-center gap-0.5">
              {EQUITY_RANGES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setRange(item.id)}
                  className={
                    range === item.id
                      ? 'rounded border border-accent/60 bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent'
                      : 'rounded border border-transparent px-2 py-0.5 text-xs text-ink-lo transition hover:border-base-700 hover:text-ink-mid'
                  }
                >
                  {item.label}
                </button>
              ))}
            </span>
          ) : (
            <span className="text-xs text-ink-faint">最近持仓标的</span>
          )
        }
      >
        {chartTab === 'equity' ? (
          <div className="px-4 pb-2 pt-3">
            <EquityHeader snapshots={snapshots} equity={equity} asset={settleAsset} />
            <DashboardEquityChart
              snapshots={snapshots}
              range={range}
              baseline={trader.initialEquity}
              /* A real height, not a thumbnail: the curve is the only place the
                 shape of this bot's day is visible. The tables below it are
                 where the per-trade detail lives. */
              height={260}
            />
          </div>
        ) : (
          <CandlesPanel symbol={positions[0]?.symbol} />
        )}
      </Panel>

      {/* F. Decision feed — full width ------------------------------------ */}
      <DecisionFeed traderId={traderId} height={FEED_HEIGHT} />

      {/* G. Tables -------------------------------------------------------- */}
      <TraderTables
        traderId={traderId}
        tab={tableTab}
        onChange={setTableTab}
        positionCount={openPositionCount}
        openOrderCount={openOrders.length}
        refreshToken={tradesToken}
      />

      {/*
        The net-PnL bridge, spelled out once below the tables. Every 净 figure on
        this page is 毛 − 手续费 − 资金费, and this is the line that makes that
        checkable against the exchange rather than a number the operator has to
        take on faith.
      */}
      {statsCost && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-base-800 bg-base-900/60 px-3 py-2 text-xs">
          <span className="font-semibold text-ink-lo">已实现盈亏（净额）</span>
          <span className={cn('num text-md font-semibold', pnlColor(realized))}>{fmtUsdSigned(realized, 2)}</span>
          <PnlBreakdown costs={statsCost} />
          <span className="num ml-auto text-ink-faint" title={pnlFormulaText(statsCost)}>
            {NET_PNL_FORMULA}
          </span>
        </div>
      )}

      <StartTraderModal
        trader={trader}
        open={startOpen}
        onClose={() => setStartOpen(false)}
        initialDryRun={system?.dryRun ?? true}
        onStarted={() => {
          void tradersQuery.reload();
          void fetchStats(trader.id);
        }}
      />

      <TraderConfigModal
        trader={configOpen ? trader : null}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onSaved={() => {
          setConfigOpen(false);
          void tradersQuery.reload();
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  KPI cell                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One cell of the headline band.
 *
 * Hand-rolled rather than `ui.Stat` because the band is the one place on the
 * page allowed to use `text-3xl` and `ink-strong`, and `Stat` is deliberately
 * tuned for the denser `text-2xl` cards used elsewhere. The treatment matches
 * `HeadlineMetric` on the overview page — a muted surface, no border — so the
 * same kind of figure does not change costume between two screens.
 */
function Kpi({
  label,
  value,
  tone = 'text-ink-hi',
  sub,
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  sub?: ReactNode;
  /** 说明这个数字的口径（例如"权益"到底是归属权益还是账户权益）。 */
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-base-850/40 px-4 py-3.5" title={title}>
      <div className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-ink-lo" title={title ?? label}>
        {label}
      </div>
      {/* break-all, not truncate: a 7-figure equity must wrap rather than be
          clipped — a wrong-looking number is worse than a two-line one. */}
      <div className={cn('num mt-1.5 break-all text-3xl font-semibold leading-tight', tone)}>{value}</div>
      {sub && <div className="mt-1.5 space-y-0.5 text-xs leading-snug text-ink-faint">{sub}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Chart helpers                                                              */
/* -------------------------------------------------------------------------- */

function ChartTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded border px-2.5 py-1 text-base transition',
        active
          ? 'border-base-700 bg-base-800 font-semibold text-ink-hi'
          : 'border-transparent text-ink-lo hover:text-ink-mid',
      )}
    >
      {children}
    </button>
  );
}

/** 归属权益 + absolute and percentage change over the visible window. */
function EquityHeader({
  snapshots,
  equity,
  asset,
}: {
  snapshots: EquitySnapshot[];
  equity: number;
  asset: string;
}) {
  const first = snapshots[0]?.equity ?? equity;
  const delta = equity - first;
  const percent = first !== 0 ? (delta / Math.abs(first)) * 100 : 0;
  const tone = pnlColor(delta);

  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <div className="flex items-baseline gap-2">
        <span
          className="text-xs font-semibold tracking-[0.08em] text-ink-lo"
          title="本机器人的归属权益曲线（初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈）。共用同一账户的其他机器人不在其中。"
        >
          归属权益
        </span>
        <span className="num text-3xl font-semibold leading-none text-ink-hi">{fmtNum(equity, 2)}</span>
        <span className="text-xs text-ink-faint">{asset}</span>
      </div>
      <div className={cn('num text-base', tone)} title="相对可见区间第一个快照的变化。">
        {fmtUsdSigned(delta, 2)} <span className="text-xs">({fmtPercent(percent)})</span>
      </div>
      <span className="num ml-auto text-xs text-ink-faint">{fmtInt(snapshots.length)} 个快照</span>
    </div>
  );
}

/** The trader's most recent position symbol, as a candlestick chart. */
function CandlesPanel({ symbol }: { symbol?: string }) {
  const [interval, setIntervalValue] = useState('15m');
  const query = usePolled((signal) => api.marketKlines(symbol ?? '', interval, 400, signal), {
    intervalMs: 15_000,
    enabled: Boolean(symbol),
    deps: [symbol, interval],
  });

  if (!symbol) {
    return <Empty message="该机器人当前没有持仓。" hint="开仓后这里会显示其行情图表。" />;
  }

  const candles = query.data ?? [];
  const last = candles[candles.length - 1];

  return (
    <div className="p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold text-ink-hi">{symbol}</span>
        {last && <span className="num text-base text-ink-mid">{fmtCompact(last.close)}</span>}
        <span className="ml-auto flex items-center gap-0.5">
          {['5m', '15m', '1h', '4h'].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setIntervalValue(value)}
              aria-pressed={interval === value}
              className={
                interval === value
                  ? 'rounded border border-accent/60 bg-accent/15 px-2 py-0.5 text-xs text-accent'
                  : 'rounded border border-transparent px-2 py-0.5 text-xs text-ink-lo transition hover:text-ink-mid'
              }
            >
              {value}
            </button>
          ))}
        </span>
      </div>
      {query.error ? (
        <ErrorNote>{query.error}</ErrorNote>
      ) : query.loading && candles.length === 0 ? (
        <Spinner3 label="正在加载K线" />
      ) : candles.length === 0 ? (
        <Empty message="该交易对没有返回K线。" />
      ) : (
        <CandlestickChart candles={candles} height={360} />
      )}
    </div>
  );
}
