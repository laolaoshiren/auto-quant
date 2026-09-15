import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { EquitySnapshot } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { useApp, useEvents } from '../lib/store';
import { useSummaries } from '../lib/summaries';
import { useDocumentTitle, usePolled, useTicker } from '../lib/hooks';
import { useReconcile, useRunOnce } from '../lib/actions';
import { Badge, Button, Dot, Empty, ErrorNote, Panel, Spinner3 } from '../components/ui';
import { TraderStatusBadge } from '../components/Badges';
import { DecisionFeed } from '../components/DecisionFeed';
import { TraderTables, type TraderTabId } from '../components/TraderTables';
import { NET_PNL_FORMULA, PnlBreakdown, statsCosts } from '../components/PnlBreakdown';
import {
  DashboardEquityChart,
  EQUITY_RANGES,
  LeverageGauge,
  MetricCard,
  WinLossBar,
  type EquityRange,
} from '../components/DashboardCharts';
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
  fmtPercent,
  fmtUsd,
  fmtUsdSigned,
  pnlColor,
  timeAgo,
} from '../lib/format';

type ChartTab = 'equity' | 'candles';

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
 * Two-column split: the operational surface on the left (header, headline
 * metrics, chart, tables) and the decision rail on the right — "what is the
 * model thinking right now" is the question the operator actually has.
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
   * The settlement unit the exchange reports, reused by the header's 起始余额 /
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
        <p className="text-xs text-ink-lo">
          {tradersQuery.error ?? `没有 id 为 ${traderId} 的机器人。它可能已被删除。`}
        </p>
        <Button className="mt-3" onClick={() => navigate('/traders')}>
          返回机器人列表
        </Button>
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      {/* Breadcrumb + live strip ------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to="/traders" className="text-xs text-ink-lo transition hover:text-accent">
          ← 机器人
        </Link>
        <span className="num text-2xs text-ink-faint">
          周期 #{trader.lastCycleNumber} · 每 {trader.cycleIntervalMinutes}m · 最近 {timeAgo(trader.lastCycleAt)} · 失败{' '}
          <span className={trader.consecutiveFailures > 0 ? 'text-warn' : undefined}>{trader.consecutiveFailures}</span>
        </span>
        <span className="ml-auto flex items-center gap-2 text-2xs text-ink-faint">
          <Badge tone={socketOpen ? 'up' : 'warn'}>
            <Dot tone={socketOpen ? 'up' : 'warn'} pulse={!socketOpen} />
            {socketOpen ? '实时事件' : 'REST 轮询'}
          </Badge>
          {tick > 0 && (
            <span className="num">时刻 {new Date(tick).toLocaleTimeString('en-GB', { hour12: false })}</span>
          )}
        </span>
      </div>

      {/* A. Bot header ----------------------------------------------------- */}
      <Panel padded={false} bodyClassName="px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-accent/40 bg-accent/15 text-lg font-bold text-accent">
            {trader.name.slice(0, 1).toUpperCase()}
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-wide text-ink-hi">{trader.name}</h1>
              <TraderStatusBadge status={status} live={trader.isRunning} />
              <Badge tone="muted">#{trader.id}</Badge>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-ink-lo">
              <span>
                AI 模型{' '}
                <Link to="/models" className="num text-accent hover:underline">
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
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {trader.isRunning && (
              <Button
                variant="primary"
                busy={runOnceBusyId === trader.id}
                title="立即强制执行一个决策周期，无需等待间隔"
                onClick={() => void runOnce(trader.id, trader.name)}
              >
                ⟳ 立即运行
              </Button>
            )}
            {trader.isRunning ? (
              <Button variant="danger" busy={busy} onClick={() => void stop()}>
                ■ 停止
              </Button>
            ) : (
              <Button variant="success" onClick={() => setStartOpen(true)}>
                ▶ 启动
              </Button>
            )}
            <Button onClick={() => setConfigOpen(true)} disabled={trader.isRunning} title="请先停止该机器人再编辑">
              配置
            </Button>
            <Button
              busy={reconcileBusyId === trader.id}
              title="从交易所自己的成交历史重建本机器人的账本（不下任何订单）：补录漏记的平仓、修正手续费与资金费。机器人停止时也可用。"
              onClick={() => void onReconcile()}
            >
              对账
            </Button>
          </div>
        </div>

        {actionError && <ErrorNote className="mt-2">{actionError}</ErrorNote>}

        {status === 'safe_mode' && (
          <div className="mt-2 rounded border border-warn/60 bg-warn/10 px-3 py-2 text-xs text-warn">
            <span className="font-semibold">已进入安全模式。</span> 连续的模型或执行失败超过了熔断阈值。循环仍在运行，
            但只会每隔几个周期探测一次模型，直到再次成功。
          </div>
        )}

        {status === 'error' && trader.lastError && (
          <div className="mt-2 rounded border border-down/60 bg-down/10 px-3 py-2 text-xs text-down">
            <span className="font-semibold">最近错误：</span> <span className="num">{trader.lastError}</span>
          </div>
        )}

        <div className="num mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-base-800 pt-1.5 text-xs text-ink-lo">
          {/*
            起始余额 sits immediately before 权益 on purpose: it is a baseline,
            not a balance, and the only way that reads correctly is next to the
            current figure it is the baseline *for*.
          */}
          <span
            title="起始余额：创建该机器人时从交易所读取的钱包余额，是总收益率与盈亏的计算基准，不是当前余额。"
          >
            起始余额{' '}
            <span className="text-ink-mid">{fmtAsset(trader.initialEquity, settleAsset, 4)}</span>
          </span>
          <span title="当前权益（保证金余额 = 钱包 + 未实现盈亏）；紧随其后的百分比是相对起始余额的总收益率。">
            权益 <span className="text-ink-hi">{fmtAsset(equity, settleAsset, 4)}</span>
            {stats && (
              <span className={pnlColor(stats.totalReturnPercent)}> {fmtPercent(stats.totalReturnPercent)}</span>
            )}
          </span>
          <span>
            持仓 <span className="text-ink-hi">{positions.length || stats?.openPositions || 0}</span>
          </span>
          <span>
            浮动盈亏 <span className={pnlColor(unrealized)}>{fmtUsdSigned(unrealized, 2)}</span>
          </span>
          <span>
            创建于 <span className="text-ink-mid">{fmtDateTime(trader.createdAt)}</span>
          </span>
          <Link to="/exchanges" className="text-accent hover:underline">
            凭证余额 →
          </Link>
        </div>

        {/*
          Live exchange view. Labelled from the same vocabulary as the 余额 column
          on the 交易所 page, so 钱包余额 / 可用 / 未实现 / 保证金占用 mean one thing
          across both screens.
        */}
        <TraderAccountStrip
          account={accountState}
          asset={settleAsset}
          busy={accountQuery.loading}
          error={accountQuery.error}
          onRefresh={accountQuery.reload}
        />
      </Panel>

      {/* Two-column split -------------------------------------------------- */}
      {/* The decision rail gets close to half the width: decisions are now
          always visible there rather than hidden behind a per-cycle click, so it
          carries far more information than it used to. */}
      <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-[52fr_48fr]">
        {/* Left ----------------------------------------------------------- */}
        <div className="min-w-0 space-y-2.5">
          {/* B. Stat cards ------------------------------------------------ */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="胜率"
              value={stats ? `${stats.winRatePercent.toFixed(1)}%` : '—'}
              sub={stats ? `${fmtInt(stats.totalTrades)} 笔已平仓` : undefined}
            >
              <WinLossBar wins={wins} losses={losses} />
            </MetricCard>

            <MetricCard
              label="已实现盈亏（30日）"
              value={fmtUsdSigned(realized, 2)}
              tone={pnlColor(realized)}
              sub={
                stats ? (
                  <>
                    <span className="block">
                      <PnlBreakdown costs={statsCosts(stats)} />
                    </span>
                    <span className="block">
                      浮动 {fmtUsdSigned(stats.unrealizedPnl, 2)} · {fmtInt(stats.totalTrades)} 笔
                    </span>
                  </>
                ) : undefined
              }
              title={`${NET_PNL_FORMULA}。卡片上的净额已经扣掉开仓与平仓两侧的手续费和资金费；服务端暂不按 30 日窗口切分。`}
            />

            <MetricCard label="已用保证金" value={fmtUsd(marginUsed, 2)} sub={`总名义价值 ${fmtUsd(notional, 2)}`} />

            <MetricCard label="有效杠杆" title="总名义价值 ÷ 权益">
              <div className="mt-0.5 flex items-center justify-center">
                <LeverageGauge value={effectiveLeverage} />
              </div>
            </MetricCard>
          </div>

          {/* C. Equity / candles ------------------------------------------ */}
          <Panel
            padded={false}
            bodyClassName="p-0"
            title={
              <span className="flex items-center gap-0.5">
                <ChartTabButton active={chartTab === 'equity'} onClick={() => setChartTab('equity')}>
                  账户净值曲线
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
                          ? 'rounded border border-accent/60 bg-accent/15 px-1.5 py-0.5 text-2xs font-semibold text-accent'
                          : 'rounded border border-transparent px-1.5 py-0.5 text-2xs text-ink-lo transition hover:border-base-700 hover:text-ink-mid'
                      }
                    >
                      {item.label}
                    </button>
                  ))}
                </span>
              ) : (
                <span className="num text-2xs text-ink-faint">最近持仓标的</span>
              )
            }
          >
            {chartTab === 'equity' ? (
              <div className="px-3 pb-1.5 pt-1.5">
                <EquityHeader snapshots={snapshots} equity={equity} />
                <DashboardEquityChart
                  snapshots={snapshots}
                  range={range}
                  baseline={trader.initialEquity}
                  /* Deliberately short: the curve communicates trend, and the
                     table below it is where the detail lives. */
                  height={175}
                />
              </div>
            ) : (
              <CandlesPanel symbol={positions[0]?.symbol} />
            )}
          </Panel>

          {/* D. Tables ---------------------------------------------------- */}
          <TraderTables
            traderId={traderId}
            tab={tableTab}
            onChange={setTableTab}
            positionCount={positions.length || stats?.openPositions || 0}
            openOrderCount={openOrders.length}
            refreshToken={tradesToken}
          />
        </div>

        {/* Right: decision feed ------------------------------------------- */}
        <div className="min-w-0">
          <div className="xl:sticky xl:top-2">
            <DecisionFeed traderId={traderId} height={860} />
          </div>
        </div>
      </div>

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
      className={
        active
          ? 'panel-title rounded border border-base-700 bg-base-800 px-2 py-0.5 text-ink-hi'
          : 'panel-title rounded border border-transparent px-2 py-0.5 transition hover:text-ink-mid'
      }
    >
      {children}
    </button>
  );
}

/** 总净值 + absolute and percentage change over the visible window. */
function EquityHeader({ snapshots, equity }: { snapshots: EquitySnapshot[]; equity: number }) {
  const first = snapshots[0]?.equity ?? equity;
  const delta = equity - first;
  const percent = first !== 0 ? (delta / Math.abs(first)) * 100 : 0;
  const tone = delta > 0 ? 'text-up' : delta < 0 ? 'text-down' : 'text-ink-mid';

  return (
    <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold tracking-[0.08em] text-ink-lo">总净值</span>
        <span className="num text-2xl leading-none text-ink-hi">{fmtUsd(equity, 2)}</span>
      </div>
      <div className={`num text-sm ${tone}`}>
        {fmtUsdSigned(delta, 2)} <span className="text-xs">({fmtPercent(percent)})</span>
      </div>
      <span className="num ml-auto text-xs text-ink-faint">{snapshots.length} 个快照</span>
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
    <div className="p-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-ink-hi">{symbol}</span>
        {last && <span className="num text-xs text-ink-mid">{fmtCompact(last.close)}</span>}
        <span className="ml-auto flex items-center gap-0.5">
          {['5m', '15m', '1h', '4h'].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setIntervalValue(value)}
              className={
                interval === value
                  ? 'rounded border border-accent/60 bg-accent/15 px-1.5 py-0.5 text-2xs text-accent'
                  : 'rounded border border-transparent px-1.5 py-0.5 text-2xs text-ink-lo transition hover:text-ink-mid'
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
        <CandlestickChart candles={candles} height={280} />
      )}
    </div>
  );
}
