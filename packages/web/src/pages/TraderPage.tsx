import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Play,
  RefreshCw,
  RotateCw,
  Settings2,
  Square,
} from 'lucide-react';
import type { EquitySnapshot } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { useApp, useEvents } from '../lib/store';
import { useSummaries } from '../lib/summaries';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { useReconcile, useRunOnce } from '../lib/actions';
import { Badge, Button, Empty, ErrorNote, Panel, Spinner3, cn } from '../components/ui';
import { TraderStatusBadge } from '../components/Badges';
import { PageShell, Metric, MetricGroup } from '../components/shell';
import { DecisionFeed } from '../components/DecisionFeed';
import { TraderTables, type TraderTabId } from '../components/TraderTables';
import { NET_PNL_FORMULA, PnlBreakdown, pnlFormulaText, statsCosts } from '../components/PnlBreakdown';
import { DashboardEquityChart, WinLossBar } from '../components/DashboardCharts';
import {
  EQUITY_RANGES,
  filterByRange,
  hasEquityVariation,
  type EquityRange,
} from '../components/equityCurve';
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

/**
 * 决策流的可视高度。
 *
 * 它是这一页的**主要内容**（见 `LAYOUT.md` §1），所以按视口给高度而不是写死像素：
 * 1600×900 上一眼能看到最近几轮，4K 上也不会缩在角落。下限 380px 是为了矮窗口
 * —— 高度归零的话，决策流就退化成"要点开才能看"的东西，那正是这次改造要修的。
 */
const FEED_HEIGHT = 'max(380px, calc(100vh - 18rem))';

/**
 * 展开后的权益曲线高度。
 *
 * 220px 在 900px 视口上约 24% 屏高（`LAYOUT.md` §6 的上限是 30%）：有形状时
 * 够看清趋势，没形状时根本不会画出来（见 `EquityMiniStrip`）。
 */
const EQUITY_CHART_HEIGHT = 220;

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `Metric` 的色调用有限联合，这里把"盈亏正负"翻译过去（0 走默认色）。 */
function toneOf(value: number): 'up' | 'down' | 'default' {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'default';
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
 * 版式按 `LAYOUT.md` §1 重排：**左指标栏 + 主内容区**。
 *
 * - 页头只留一行"我是谁、什么状态、能做什么"；变化很慢的配置收进 `ConfigSummary`。
 * - 左栏 280px，按 账户 / 交易 / 系统 分组 —— 分组本身就是层级，比八段同权重文字
 *   有用得多（操作者原话："扫一眼不知道哪个重要"）。
 * - 主区先给**决策流**：它是这一页最该被盯着的部分，以前被一张占 40% 屏高的
 *   平线权益图挤到了屏幕底部。
 * - 权益曲线只在**真有形状**时才画成图表，否则压成 36px 的缩略条（§4）。
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
  /**
   * 手动覆盖"要不要展开曲线"。
   *
   * `null` = 交给数据判断（有形状就展开，平线就收起）；`true` = 操作者自己点开了
   * 一条平线；`false` = 自己收起了有形状的曲线。切区间时清空覆盖，重新按数据判断 ——
   * 换一段窗口本来就该重新看一眼。
   */
  const [chartOverride, setChartOverride] = useState<boolean | null>(null);
  // Bumped after a manual 对账 so the tables refetch instead of waiting out
  // their 15-second poll.
  const [tradesToken, setTradesToken] = useState(0);
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
   * The settlement unit the exchange reports, reused by the rail's 起始余额 and the
   * account strip underneath, so both read in the same unit.
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

  /*
   * 图表与缩略条共用同一份"可见区间"数据。
   *
   * `filterByRange` 必须在这里调用一次，而不是让图表自己筛：收起与否取决于
   * **当前区间**里有没有形状，两处各筛一次就会出现"图表画的是 7D、判断用的是全部"
   * 这种自相矛盾的状态。
   */
  const windowed = useMemo(() => filterByRange(snapshots, range), [snapshots, range]);
  const windowFirst = windowed[0]?.equity ?? equity;
  const windowDelta = equity - windowFirst;
  const windowPercent = windowFirst !== 0 ? (windowDelta / Math.abs(windowFirst)) * 100 : 0;
  const curveHasShape = useMemo(
    () => hasEquityVariation(windowed.map((snapshot) => snapshot.equity)),
    [windowed],
  );
  const curveCollapsed = chartOverride ?? !curveHasShape;

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

  /*
   * 左指标栏。三条规矩（`LAYOUT.md` §1/§3）：
   *
   * 1. 按语义分组，组内紧凑、组间留白 —— 分组本身就是层级；
   * 2. 每个分组最多一个 `size="lg"`：所有数字一样大等于没有重点；
   * 3. **只放状态，不放诊断值** —— 没有 token 数、没有快照数、没有本地时钟。
   *    "此刻几点"和"权重还剩多少"在正常运行时永远没事（§3 的教训），
   *    它们只会把真正要看的数字稀释掉。
   */
  const rail = (
    /*
     * 窄屏 2 列，不是 3 列。
     *
     * 3 列时每列只有约 200px，`实盘验证 — SOL/XRP/DOG…` 这类值会被截断 ——
     * 而策略名被截断意味着操作者认不出自己在看哪个策略。宁可两列排三行。
     */
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-1">
      <MetricGroup title="账户">
        <Metric
          label={`归属权益（${settleAsset}）`}
          value={fmtNum(equity, 4)}
          size="lg"
          tone="strong"
          title="归属权益 = 初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈。它只包含这个机器人自己的交易；共用的钱包见页面顶部的「交易所账户」。"
          sub={
            <>
              {stats ? (
                <span className={pnlColor(stats.totalReturnPercent)}>
                  总收益率 {fmtPercent(stats.totalReturnPercent)}
                </span>
              ) : (
                '等待统计'
              )}
              <span title="创建该机器人时从交易所读取的钱包余额，是总收益率与盈亏的计算基准。">
                {' · '}起始 {fmtAsset(trader.initialEquity, settleAsset, 4)}
              </span>
            </>
          }
        />
        <Metric
          label="今日盈亏"
          value={fmtUsdSigned(todayPnl, 2)}
          tone={toneOf(todayPnl)}
          sub={`${fmtPercent(todayPercent)} · 基准 ${fmtNum(dayAgoEquity ?? equity, 2)}`}
          title="相对 24 小时前最近一个权益快照的变化。"
        />
      </MetricGroup>

      <MetricGroup title="交易">
        {/*
          没有已平仓交易时，**不摆一排零**。
          
          原来这里恒定显示 `胜率 0.0%` + `0 盈/0 亏` + `PF 0.00 · 0 笔已平仓` ——
          对一个从未成交的机器人，四行零占了左栏最显眼的一段，而它们不含任何信息：
          0% 的胜率和"还没交易过"是完全不同的两件事，前者会让人以为策略很烂。
          
          有交易时按原来的三行显示；没有时只说一句实话。
        */}
        {stats && stats.totalTrades > 0 ? (
          <Metric
            label="胜率"
            value={`${stats.winRatePercent.toFixed(1)}%`}
            title="winRatePercent 本身就是 0–100 的百分数；盈/亏笔数直接来自后端，不由胜率反推。"
            sub={
              <>
                <WinLossBar wins={wins} losses={losses} />
                <span>
                  PF {fmtProfitFactor(stats.profitFactor)} · {fmtInt(stats.totalTrades)} 笔已平仓
                </span>
              </>
            }
          />
        ) : (
          <Metric
            label="已平仓交易"
            value="尚无"
            title="这个机器人还没有完成过任何一次开仓—平仓回合，所以胜率与盈亏比都没有意义。"
            sub={stats ? '完成第一个回合后这里会显示胜率与盈亏比' : '等待统计'}
          />
        )}
        <Metric
          label="持仓 / 挂单"
          value={`${fmtInt(openPositionCount)} / ${fmtInt(openOrders.length)}`}
          sub={
            <>
              浮动 <span className={pnlColor(unrealized)}>{fmtUsdSigned(unrealized, 2)}</span>
            </>
          }
        />
        <Metric
          label={`保证金（${settleAsset}）`}
          value={fmtNum(marginUsed, 2)}
          title="有效杠杆 = 本机器人总名义价值 ÷ 归属权益。满仓 10x 时读数最高。"
          sub={
            <>
              名义 {fmtUsd(notional, 2)} · 有效杠杆 {effectiveLeverage.toFixed(2)}x
            </>
          }
        />
      </MetricGroup>

      <MetricGroup title="系统">
        <Metric
          label="AI 模型"
          value={
            <Link to="/models" className="text-accent hover:underline">
              {model ? model.label : `#${trader.aiModelId}`}
            </Link>
          }
          sub={model?.model}
          title="决定它看什么、怎么下单的模型。"
        />
        <Metric
          label="策略"
          value={
            <Link to={`/strategy/${trader.strategyId}`} className="text-accent hover:underline">
              {strategy?.name ?? `#${trader.strategyId}`}
            </Link>
          }
          title="决定候选交易对、杠杆与风控阈值的策略。"
        />
        <Metric
          label="数据源"
          value={socketOpen ? '实时事件' : 'REST 轮询'}
          tone={socketOpen ? 'default' : 'warn'}
          sub={socketOpen ? '推送在线' : '推送断开，按 4 秒轮询兜底'}
          title="页面上的持仓、委托与决策是从推送来的还是轮询来的 —— 它决定你看到的数字有多新。"
        />
      </MetricGroup>
    </div>
  );

  return (
    // `max-w` only for the ultra-wide case: past ~1760px the curve and the tables
    // stretch into unreadable spans. Everything below 3xl is fluid.
    <div className="mx-auto w-full max-w-[110rem] space-y-3">
      {/* A. 页头：我是谁 + 什么状态 + 能做什么，常驻一行 --------------- */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          to="/traders"
          className="inline-flex items-center gap-1 text-base text-ink-lo transition hover:text-accent"
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
          机器人
        </Link>

        <span className="h-4 w-px bg-base-700" aria-hidden />

        <h1 className="min-w-0 max-w-[24rem] truncate text-xl font-semibold tracking-wide text-ink-hi">
          {trader.name}
        </h1>
        <Badge tone="muted">#{trader.id}</Badge>
        <TraderStatusBadge status={status} live={trader.isRunning} />
        <Badge tone="muted" title="该机器人所在的交易环境，由服务端配置决定。">
          {system?.environmentLabel ?? '—'}
        </Badge>
        {trader.consecutiveFailures > 0 && (
          <Badge tone="warn" title="连续的模型或执行失败次数；超过熔断阈值会进入安全模式。">
            {trader.consecutiveFailures} 次连续失败
          </Badge>
        )}

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
      </header>

      {/* A2. 配置摘要：次要信息折起来，但永远点得到 -------------------- */}
      <ConfigSummary trader={trader} />

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

      {/*
        B. 交易所账户。

        放在骨架**外面**横跨整页，因为它描述的是一个**共用钱包**（同一账户下所有
        机器人读数是同一个数），不属于这个机器人；左栏只放归属这个机器人的数字。
        以前它和归属权益混在一起，于是一个从未成交的机器人看起来也"有余额"。
      */}
      <TraderAccountStrip
        account={accountState}
        asset={settleAsset}
        busy={accountQuery.loading}
        error={accountQuery.error}
        onRefresh={accountQuery.reload}
      />

      <PageShell rail={rail}>
        {/* C. 决策流 —— 主内容，占满剩余宽度并给足高度 --------------- */}
        <DecisionFeed traderId={traderId} height={FEED_HEIGHT} />

        {/* D. 权益 / 行情 -------------------------------------------- */}
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
                    onClick={() => {
                      setRange(item.id);
                      // 换区间就重新按数据判断收起与否，别把上一段的展开状态带过来。
                      setChartOverride(null);
                    }}
                    aria-pressed={range === item.id}
                    className={
                      range === item.id
                        ? 'rounded border border-accent/60 bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent'
                        : 'rounded border border-transparent px-2 py-0.5 text-xs text-ink-lo transition hover:border-base-700 hover:text-ink-mid'
                    }
                  >
                    {item.label}
                  </button>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={!curveCollapsed}
                  title={curveCollapsed ? '展开完整权益曲线' : '把曲线收成一行，给决策流让出高度'}
                  onClick={() => setChartOverride(!curveCollapsed)}
                >
                  {curveCollapsed ? '展开' : '收起'}
                </Button>
              </span>
            ) : (
              <span className="text-xs text-ink-faint">最近持仓标的</span>
            )
          }
        >
          {chartTab === 'equity' ? (
            curveCollapsed ? (
              /*
                数据太薄时压成一行（§4）。**不是把曲线藏起来**：这条序列本身仍然
                画在这里，只是 36px 高、不要坐标轴 —— 一条平线本来就不需要 220px。
                "展开"始终在工具栏上，所以没有任何数据是拿不到的。
              */
              <EquityMiniStrip
                values={windowed.map((snapshot) => snapshot.equity)}
                delta={windowDelta}
                percent={windowPercent}
                asset={settleAsset}
                note={
                  windowed.length === 0
                    ? '还没有权益快照，每个决策周期结束时会记录一次'
                    : windowed.length < 3
                      ? `仅 ${fmtInt(windowed.length)} 个快照，连不成曲线`
                      : '这段区间内权益几乎没变化'
                }
                onExpand={() => setChartOverride(true)}
              />
            ) : (
              <div className="px-3.5 pb-2.5 pt-2">
                <EquityWindowLine
                  snapshots={windowed}
                  equity={equity}
                  delta={windowDelta}
                  percent={windowPercent}
                  asset={settleAsset}
                />
                <DashboardEquityChart
                  snapshots={snapshots}
                  range={range}
                  baseline={trader.initialEquity}
                  height={EQUITY_CHART_HEIGHT}
                />
              </div>
            )
          ) : (
            <CandlesPanel symbol={positions[0]?.symbol} />
          )}
        </Panel>

        {/* E. 表格：参考材料，不是盯盘对象 --------------------------- */}
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
      </PageShell>

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
/*  配置摘要                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 次要配置摘要 —— 默认收起的那一半页头。
 *
 * 改版前这里是一个平铺的 flex 行：周期、间隔、最近周期、AI、策略、环境、创建于
 * 七段文字和机器人名字**同等字重**地挤在顶部（操作者原话："八段同等权重的文字，
 * 扫一眼不知道哪个重要"）。问题的解法不是把字调小，而是分层：
 *
 * - 名称 / 状态 / 环境留在页头第一行；
 * - 模型与策略（"它是什么"）进左栏「系统」组，常驻可见；
 * - **周期编号、间隔、最近周期、创建于**这些变化很慢的配置收在这里，点一下展开。
 *
 * 收起态只留一个按钮 —— 它不占高度，也不会因为"没东西"而让页头看起来像坏了。
 */
function ConfigSummary({ trader }: { trader: TraderRow }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="-mt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-ink-lo transition hover:text-ink-mid"
      >
        {open ? (
          <ChevronUp aria-hidden className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown aria-hidden className="h-3.5 w-3.5" />
        )}
        配置摘要
        <span className="num text-ink-faint">周期 #{fmtInt(trader.lastCycleNumber)} · 每 {trader.cycleIntervalMinutes}m</span>
      </button>

      {open && (
        <div className="num mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-lo">
          <span title="该机器人已完成的决策周期数（跨重启连续编号）。">
            周期编号 <span className="text-ink-mid">#{fmtInt(trader.lastCycleNumber)}</span>
          </span>
          <span>
            间隔 <span className="text-ink-mid">每 {trader.cycleIntervalMinutes} 分钟</span>
          </span>
          <span>
            最近周期 <span className="text-ink-mid">{timeAgo(trader.lastCycleAt)}</span>
          </span>
          <span>
            创建于 <span className="text-ink-mid">{fmtDateTime(trader.createdAt)}</span>
          </span>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Chart helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 数据太薄时的紧凑权益条。
 *
 * 为什么是"画出来"而不是"藏起来"：曲线讲的是形状，而这里要回答的正是
 * "为什么没有形状"。一条 36px 的缩略线把这件事一次说完 —— 走平就是走平，
 * 两个点就是两个点，不需要 220px 的坐标轴来证明（`LAYOUT.md` §4）。
 *
 * 为什么就画在这个文件里，而不是复用总览页的 `EquityStrip`
 * （`pages/overviewParts.tsx`）：那一页的点是**多机器人合并**后的序列，形状不同、
 * 这一页要显示的口径也不同（归属权益 vs 总权益），跨页互引会让两个页面必须一起改。
 */
function EquityMiniStrip({
  values,
  delta,
  percent,
  asset,
  note,
  onExpand,
}: {
  values: number[];
  delta: number;
  percent: number;
  asset: string;
  /** 为什么收起了 —— 一句话说清，比"暂无数据"有用。 */
  note: string;
  onExpand: () => void;
}) {
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const span = max - min;
  const last = values.length - 1;

  /*
   * `viewBox="0 0 100 100"` + `preserveAspectRatio="none"` 把线拉满整宽，所以
   * `strokeWidth` 必须配 `vectorEffect="non-scaling-stroke"`：非等比缩放会把线宽
   * 一起压成细丝或拉成色块。
   */
  const path = values
    .map((value, index) => {
      const x = last <= 0 ? 0 : (index / last) * 100;
      // 走平时按中线画：贴在盒子边缘的一条线看起来像被裁掉了。
      const y = span === 0 ? 50 : 100 - ((value - min) / span) * 100;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2">
      {values.length >= 2 ? (
        <div className={cn('h-9 min-w-[8rem] flex-1', pnlColor(delta))}>
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="h-full w-full"
            role="img"
            aria-label={`收益曲线缩略线，共 ${fmtInt(values.length)} 个快照`}
          >
            <path d={path} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      ) : (
        <span className="min-w-[8rem] flex-1 text-xs text-ink-faint">{note}</span>
      )}

      <div className="shrink-0 text-right">
        <div className={cn('num text-base leading-tight', pnlColor(delta))}>
          {fmtUsdSigned(delta, 2)} <span className="text-xs text-ink-faint">{asset}</span>
        </div>
        <div className="num text-xs text-ink-faint">
          {values.length >= 2 && `${note} · `}
          {fmtPercent(percent)}
        </div>
      </div>

      <Button size="sm" variant="ghost" onClick={onExpand} aria-expanded={false} title="展开完整权益曲线">
        <ChevronRight aria-hidden className="h-3.5 w-3.5" />
        展开
      </Button>
    </div>
  );
}

/**
 * 展开态下图表上方的一行口径说明。
 *
 * 只讲**这一段窗口里涨跌了多少**：当前归属权益本身常驻在左栏，在这里再放一个
 * `text-3xl` 会让同一个数字在一屏里出现两次，而且都比别的东西显眼（DESIGN.md §4
 * "不要把所有东西做成一样大"）。
 */
function EquityWindowLine({
  snapshots,
  equity,
  delta,
  percent,
  asset,
}: {
  snapshots: EquitySnapshot[];
  equity: number;
  delta: number;
  percent: number;
  asset: string;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span className="text-ink-lo" title="相对可见区间第一个快照的变化。">
        本段变化
      </span>
      <span className={cn('num text-base font-semibold', pnlColor(delta))}>
        {fmtUsdSigned(delta, 2)} {asset}
      </span>
      <span className={cn('num', pnlColor(delta))}>({fmtPercent(percent)})</span>
      <span className="num ml-auto text-ink-faint" title="快照数决定这条曲线有多细，也解释了它为什么会被收成一行。">
        {fmtInt(snapshots.length)} 个快照
      </span>
      {/* `equity` 只用来兜底没有快照时的比较基准，与图表内部口径一致。 */}
      <span className="sr-only">当前归属权益 {fmtNum(equity, 2)}</span>
    </div>
  );
}

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
        <CandlestickChart candles={candles} height={300} />
      )}
    </div>
  );
}
