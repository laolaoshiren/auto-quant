/**
 * System overview — the landing page, and the only screen that has to answer
 * "how is my money doing?" in the first second.
 *
 * The structure is `LAYOUT.md` §1: a page-level header row, then a **left metric
 * rail** (280px) beside the main content. It used to be one flat vertical flow —
 * four equal-weight figures, then a 300px chart that often drew a horizontal
 * line — which is exactly the "no hierarchy, constant scrolling" complaint this
 * change answers.
 *
 *   1. 页头 — greeting, data freshness, and the page's primary action;
 *   2. 左栏 — the account-level figures, grouped 账户 / 交易. `MetricGroup`
 *      supplies the grouping, which *is* the hierarchy: one `size="lg"` lead
 *      figure (账户权益合计) and everything else clearly secondary. The groups
 *      are now also the **口径** boundary: 账户 is the shared exchange wallet
 *      (counted once per account), 交易 is what each bot itself is doing (adds up).
 *      The per-bot 归属权益 never appears as a total — that sum counted one
 *      wallet once per bot and read ~3× high (see `lib/fleetTotals.ts`);
 *   3. 主区 — the equity curve, which is the primary visual **only when the
 *      series has shape** (≥3 points with real variation, `equityShape`). A flat
 *      or thin series collapses to a 36px strip (§4: never spend a third of the
 *      viewport drawing a straight line). It plots the **account-basis** curve;
 *      each bot's attributed curve lives on its own dashboard;
 *   4. 机器人明细 — the dense per-bot table;
 *   5. 运行环境 — a footer, at the smallest size on the page, holding status
 *      only. Internal diagnostics (clock offset, API weight) appear **only when
 *      they are out of bounds**, with the consequence rather than the raw value
 *      (§3).
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
import { accountEquityContributor, fleetTotals } from '../lib/fleetTotals';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { useRunOnce } from '../lib/actions';
import { Button, Empty, ErrorNote, Panel, Spinner3 } from '../components/ui';
import { Metric, MetricGroup, PageShell, SectionLabel } from '../components/shell';
import { NewTraderModal, StartTraderModal } from '../components/TraderModals';
import { EQUITY_RANGES, mergeEquityCurves, rangeSpanMs, type EquityRange } from '../components/equityCurve';
import {
  EquitySkeleton,
  EquityStrip,
  SystemFact,
  TradersSnapshotTable,
  equityShape,
  useRecentTrades,
} from './overviewParts';
import {
  BALANCE_LABEL,
  fmtAsset,
  fmtClockOffset,
  fmtInt,
  fmtNum,
  fmtPercent,
  fmtUsd,
  fmtUsdSigned,
  timeAgo,
} from '../lib/format';

/**
 * The chart is its own chunk, reached only through `lazy`.
 *
 * `recharts` is the largest dependency in the app and the overview page is the
 * first thing loaded after login — importing the chart statically would put the
 * whole library in front of the first paint of the headline numbers. The shell
 * and the rail render immediately; the curve lands a moment later.
 *
 * It is reached only when `equityShape` says there is something to draw, so a
 * flat or brand-new account never downloads it at all.
 */
const EquityCurveChart = lazy(() =>
  import('../components/EquityCurveChart').then((module) => ({ default: module.EquityCurveChart })),
);

/** Per-bot rows shown before the page links out to 「机器人」. */
const SNAPSHOT_ROWS = 5;

/** 图表高度。LAYOUT.md §6：单张图不超过 30% 屏高，900px 视口下 240 正好在线内。 */
const CHART_HEIGHT = 240;

/** 时钟偏移超过这个绝对值就会被币安用 -1021 拒绝 —— 到这时它才值得占用一行。 */
const CLOCK_WARN_MS = 2000;

/** API 权重是**按分钟滚动**的，等到 100% 就已经在被拒绝了；70% 开始预警。 */
const WEIGHT_WARN_PERCENT = 70;

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
   * 曲线与合计都走**账户口径** —— 这是本次修掉的 bug 的核心（LAYOUT.md §7：
   * 文字说的必须是事实）。
   *
   * 每个机器人的快照记的是它自己的归属权益，它**自带一份本金**；同一个交易所
   * 账户下的多个机器人各自都带着同一笔本金，所以把归属权益相加等于把钱包数 N 遍。
   * 实盘实测（三个机器人共用账户 #1）：Σ归属权益 30.6690、Σ初始权益 30.2316，而账户里
   * 只有 10.4180 —— 其中 19.81 USDT 是被数了三遍的同一笔本金，总览因此显示
   * 30.67（约 3 倍）。完整的数字与推导见 `lib/fleetTotals.ts` 顶部。
   *
   * 于是：先按 `exchangeAccountId` 分组，账户**之间**相加、账户**内部**只算一次。
   * 每机器人的归属权益仍然照旧出现在下面的表格里（"哪个机器人挣的"），
   * 只是不再参与舰队合计。
   *
   * 快照仍然来自原来的三个来源：REST、socket 推来的新点，以及每个账户的起始资金
   * （`accountEquityContributor` 用它把曲线在第一条快照之前垫平）。
   */
  const equitySnapshots: Record<number, EquitySnapshot[]> = {};
  traders.forEach((trader, index) => {
    const live = liveByTrader[trader.id]?.equity ?? [];
    equitySnapshots[trader.id] = [...(equityQuery.data?.[index] ?? []), ...live];
  });
  const merged = mergeEquityCurves([accountEquityContributor(traders, equitySnapshots)]);

  /*
   * 去掉开头那段"没有读数"的点。
   *
   * `mergeEquityCurves` 的第一个桶是 `floor(最早快照时间)`，因此**没有任何样本
   * ≤ 它**，于是首桶的合计是 0 —— 这是它在首桶上的已知边界，旧的每机器人曲线
   * 一样有这个 0（实测两种写法首点都是 0）。但 0 在权益里不是"账户没钱"，
   * 而是"这一桶还没有读数"：留着它，`equityChange = 账户权益 − 窗口起点` 就会
   * 等于**整个账户权益**（实测页面显示「区间盈亏 +$10.42 / 还没有权益快照」，
   * 而真实变化是 +$0.03），正好违反 LAYOUT.md §7。
   *
   * 根因在 `components/equityCurve.ts`（不在本次改动的文件范围内），已上报；
   * 这里只中和它的后果：丢掉开头这一段非正的点。若一条正读数都没有，就返回空
   * 曲线 —— 那种情况下页面应该说的是"还没有权益快照"，而不是"账户是 0"。
   */
  const firstReading = merged.findIndex((point) => point.equity > 0);
  const curve = firstReading === -1 ? [] : merged.slice(firstReading);

  const runningCount = traders.filter((t) => t.isRunning).length;

  /** 舰队合计（账户口径与机器人归属口径分开算，见 `lib/fleetTotals.ts`）。 */
  const fleet = fleetTotals({ traders, stats: statsMap, snapshots: equitySnapshots });

  /** 单行的归属权益：**只是这个机器人自己的账**，不能相加。 */
  const equityOf = (trader: TraderRow): number => statsMap[trader.id]?.equity ?? trader.initialEquity;

  const accountEquity = fleet.accountEquityFleet;
  const committedCapital = fleet.committedCapitalFleet;
  const totalReturnPercent = fleet.accountReturnPercent;
  const totalOpen = fleet.openPositionsFleet;
  const unrealized = fleet.unrealizedPnlFleet;
  /** Σ 各机器人自己的净已实现盈亏 —— 这一项本来就是可加的。 */
  const realizedPnl = fleet.realizedPnlFleet;
  const withStats = fleet.tradersWithStats;
  const statsPending = fleet.traderCount > 0 && withStats < fleet.traderCount;
  const accountCount = fleet.accounts.length;

  /*
   * Closed-trade counts are **summed, never divided**: `wins` / `losses` are real
   * counts and `winRatePercent` is a server figure. Deriving an account-level
   * rate from the two counts would be inventing a number the API never returned,
   * so the rail shows the counts themselves (hard rule in the task brief).
   */
  const totalWins = fleet.winsFleet;
  const totalLosses = fleet.lossesFleet;

  /**
   * Start of the selected window, plus whether that start is really the start of
   * the window or merely the oldest snapshot there is.
   *
   * `windowStartValue` comes off the same curve that is drawn, so the change shown
   * in the rail and the shape of the curve can never disagree. When the window
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
  const equityChange = windowStartValue === null ? null : accountEquity - windowStartValue;
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

  /* --- 曲线形态：决定主区是画图表、还是收成一条紧凑的缩略线（§4） ------- */
  const shape = equityShape(curve);
  const rangeLabel = range === 'ALL' ? '全部区间' : `近 ${range}`;

  const pnlTone = (value: number): 'default' | 'up' | 'down' =>
    value > 0 ? 'up' : value < 0 ? 'down' : 'default';

  /* --- 诊断值只在越界时出现（§3） --------------------------------------- */
  const clockWarn = Math.abs(system?.clockOffsetMs ?? 0) > CLOCK_WARN_MS;
  const weightPercent =
    system?.weightLimit && system.weightLimit > 0
      ? Math.round(((system.weightUsed ?? 0) / system.weightLimit) * 100)
      : 0;
  const weightWarn = weightPercent >= WEIGHT_WARN_PERCENT;

  /*
   * 左指标栏。分两组（账户 / 交易），组本身就是层级 —— 这正是改造前
   * 四个同等大小的数字并排时缺的东西。
   *
   * 分组的界线现在是**口径**，不只是主题：
   *
   * - 「账户」= 交易所共享钱包的钱（按账户算一次）。权益、收益率、区间盈亏都在这里，
   *   它们回答"一共有多少钱、赚了多少"；
   * - 「交易」= 各机器人自己的账：持仓数、自己的浮盈、自己的笔数。它们回答
   *   "是哪些机器人在动、谁挣的"，因此可以相加。
   *
   * 归属权益（每个机器人自带本金的那一项）只在下面的表格里按行出现 —— 把它合计
   * 出来就是本次修掉的 3 倍 bug（见文件顶部与 `lib/fleetTotals.ts`）。
   *
   * 布局随断点变（LAYOUT.md §1）：
   * - `xl` 及以上：一列，就是那根 280px 的指标栏；
   * - `sm`–`xl`：两组并排，占两列 —— 这样塌陷到内容上方时只有三四行高，
   *   而不是八个指标一条长龙把主区顶到屏幕外（150% 缩放正落在这个区间）；
   * - `< sm`：单列堆叠。
   */
  const rail = (
    <div className="grid grid-cols-1 gap-4 rounded-lg border border-base-750 bg-base-900 p-3.5 shadow-panel sm:grid-cols-2 xl:grid-cols-1">
      <MetricGroup title="账户">
        <Metric
          label={`${BALANCE_LABEL.equity}合计`}
          size="lg"
          tone="strong"
          value={accountCount > 0 ? fmtAsset(accountEquity, 'USDT', 2) : '—'}
          sub={accountCount > 0 ? `按账户口径 · ${fmtInt(accountCount)} 个账户` : '还没有交易所账户'}
          title={`所有交易所账户（共享钱包）的${BALANCE_LABEL.equity}之和 —— **每个账户只算一次**。共用同一个账户的机器人读的是同一个钱包，所以它们的「归属权益」不能相加：实盘实测三个机器人 Σ归属权益 30.6690、Σ初始权益 30.2316，而账户里只有 10.4180，其中 19.81 是被数了三遍的同一笔本金。各机器人自己挣了多少见下表「归属权益」列，单个账户的钱见「交易所」页。`}
        />

        <Metric
          label="累计净盈亏"
          tone={pnlTone(realizedPnl)}
          value={fmtUsdSigned(realizedPnl, 2)}
          sub="各机器人自己的净额之和"
          title="Σ(每个机器人自己的已平仓净盈亏)，净 = 毛 − 手续费 − 资金费。这一项**可以相加**：每个机器人只认自己挂过的订单对应的回合（归属闸门），共享账户不会让它重复计入别人的盈亏。它不含持仓浮盈。"
        />

        <Metric
          /*
           * ⚠️ **不叫「今日盈亏」。**
           *
           * 这张卡显示的是**所选窗口**内的变化，而 `range = '1D'` 是
           * **滚动 24 小时**（`Date.now() - 24h`），不是自然日。
           *
           * 原来它写着「今日盈亏」，于是北京时间凌晨打开这一页时，
           * 这个数字覆盖的是「昨天大半天 + 今天凌晨」—— 名字和内容对不上。
           * 操作员问"今天赚了多少"，得到的是另一段时间的答案。
           *
           * 机器人详情页那张「今日盈亏」已经改成**北京时间自然日**；
           * 这张是区间卡（1D / 7D / 30D / ALL 可切），所以它的 1D 就该
           * 老老实实叫「近 24 小时」—— **一个会随窗口变化的数字，
           * 不该顶着一个固定时间范围的名字。**
           */
          label={has24hCoverage ? `近 ${range}` : '区间盈亏'}
          tone={equityChange === null ? 'default' : pnlTone(equityChange)}
          value={equityChange === null ? '—' : fmtUsdSigned(equityChange, 2)}
          sub={
            equityChangePercent === null
              ? '还没有权益快照'
              : `${has24hCoverage ? '24 小时' : `较${range === 'ALL' ? '起始' : `近 ${range}`}`} · ${fmtPercent(equityChangePercent)}`
          }
          title="账户权益（账户口径）在窗口内的变化，含已实现与浮动盈亏；入金/出金同样会推动它 —— 它说的是「账户里的钱怎么变」，策略自己赚的那部分看「累计净盈亏」。快照不足所选窗口时改显示自最早一条快照以来的变化。（这里按滚动窗口算，不是自然日 —— 自然日的「今日盈亏」在机器人详情页。）"
        />

        <Metric
          label="总收益率（账户口径）"
          tone={committedCapital > 0 ? pnlTone(totalReturnPercent) : 'default'}
          value={committedCapital > 0 ? fmtPercent(totalReturnPercent) : '—'}
          sub={`初始投入 ${fmtUsd(committedCapital, 2)}`}
          title="（账户权益合计 − 账户起始资金）÷ 账户起始资金。本金按**账户**算：共享账户取该账户被接入时的起始资金（最早那个机器人建号时从交易所读到的钱包余额），不是各机器人 initialEquity 之和 —— 后者在同一账户下会把同一笔本金数很多遍（实测 Σ初始权益 30.2316 vs 账户里 10.4180，多算 19.81 USDT）。各机器人自己的收益率见下表。入金/出金也计入本比率。"
        />
      </MetricGroup>

      {/* 并排时（sm–xl）这组不在上一组的下方，那条分隔线会变成一根悬空的横线 */}
      <MetricGroup title="交易" className="sm:border-t-0 sm:pt-0 xl:border-t xl:pt-3">
        <Metric
          label="运行中机器人"
          value={`${fmtInt(runningCount)} / ${fmtInt(traders.length)}`}
          sub={traders.length === 0 ? '还没有机器人' : '循环已启动 / 已配置'}
          title="分母是已配置的机器人数量，分子是循环正在跑的。停止的机器人不会产生新的决策。"
        />
        <Metric
          label="持仓（个）"
          value={fmtInt(totalOpen)}
          sub="各机器人自己的持仓合计"
          title="所有机器人**自己的**持仓个数之和。同一账户下多个机器人看到的是同一个钱包，但持仓归属各自独立。"
        />
        <Metric
          label="浮动盈亏"
          tone={pnlTone(unrealized)}
          value={fmtUsdSigned(unrealized, 2)}
          sub={`${fmtInt(totalOpen)} 个持仓 · 未落袋`}
          title="所有机器人**自己的**持仓的未实现盈亏合计（不是交易所账户的总浮盈 —— 账户的总浮盈在同一账户下的每个机器人身上都是同一个数）。它随时在变，且尚未计入已实现盈亏。"
        />
        <Metric
          label="平仓记录"
          value={withStats > 0 ? `${fmtInt(totalWins)} 盈 / ${fmtInt(totalLosses)} 亏` : '—'}
          sub={withStats > 0 ? '按各机器人统计求和' : '统计读取中…'}
          title="已平仓的盈利笔数与亏损笔数之和（真实计数）。账户级胜率不在这里换算 —— 各机器人自己的胜率见下表与机器人页。"
        />
      </MetricGroup>
    </div>
  );

  return (
    <div className="space-y-4">
      <ErrorNote>{actionError}</ErrorNote>

      {/* ------------------------------------------------------------------ */}
      {/*  页头：标题 + 状态 + 主要操作（LAYOUT.md §1）                        */}
      {/* ------------------------------------------------------------------ */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          {/* `h2` 而不是 `h1`：页面级标题由应用外壳的顶栏提供，这里不重复一层 */}
          <h2 className="truncate text-lg font-semibold tracking-tight text-ink-hi">
            欢迎回来{user?.username ? `，${user.username}` : ''}
          </h2>
          <p className="num mt-0.5 truncate text-xs text-ink-faint">
            更新于 {timeAgo(tradersQuery.updatedAt ? new Date(tradersQuery.updatedAt).toISOString() : null)}
            {statsPending && ` · 正在读取 ${fmtInt(traders.length - withStats)} 个机器人的统计…`}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button small variant="ghost" busy={refreshing} onClick={refreshAll} title="重新读取机器人列表、统计与系统状态">
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
            刷新
          </Button>
          <Link to="/traders" className="btn btn-ghost btn-xs">
            管理机器人
          </Link>
          <Button small variant="primary" onClick={() => setNewOpen(true)}>
            新建机器人
          </Button>
        </div>
      </header>

      <PageShell aside={rail}>
        {/* ---------------------------------------------------------------- */}
        {/*  1. 资金曲线 —— 有形状才展开成图表（§4）                          */}
        {/* ---------------------------------------------------------------- */}
        <section aria-labelledby="overview-equity">
          <SectionLabel
            title={`${BALANCE_LABEL.equity}曲线`}
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
          />
          <h2 id="overview-equity" className="sr-only">
            所有交易所账户的{BALANCE_LABEL.equity}之和（按账户口径，共用钱包只算一次）
          </h2>

          {equityQuery.error ? (
            <ErrorNote>{equityQuery.error}</ErrorNote>
          ) : equityQuery.loading && equityQuery.data === null ? (
            <EquitySkeleton />
          ) : shape.hasShape ? (
            <Panel padded={false} bodyClassName="p-3">
              <Suspense fallback={<EquitySkeleton />}>
                <EquityCurveChart
                  points={curve}
                  range={range}
                  height={CHART_HEIGHT}
                  baseline={committedCapital > 0 ? committedCapital : undefined}
                  primaryLabel={BALANCE_LABEL.equity}
                />
              </Suspense>
            </Panel>
          ) : (
            <EquityStrip
              points={curve}
              change={equityChange}
              changePercent={equityChangePercent}
              rangeLabel={rangeLabel}
              flat={shape.flat}
            />
          )}
        </section>

        {/* ---------------------------------------------------------------- */}
        {/*  2. 机器人明细                                                     */}
        {/* ---------------------------------------------------------------- */}
        <section aria-labelledby="overview-traders">
          <SectionLabel
            title="机器人"
            count={`${fmtInt(traders.length)} 个 · ${fmtInt(runningCount)} 运行中`}
            actions={
              <Link to="/traders" className="btn btn-ghost btn-xs">
                全部机器人
              </Link>
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
              fleet={fleet}
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
      </PageShell>

      {/* ------------------------------------------------------------------ */}
      {/*  3. 运行环境（页脚，全页最小字号；只放状态，诊断值越界才出现）        */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="overview-system" className="rounded-lg border border-base-800 bg-base-900/60 px-3.5 py-3">
        <SectionLabel title="运行环境" className="mb-2" />
        <h2 id="overview-system" className="sr-only">
          运行环境
        </h2>
        <dl className="num grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 xl:grid-cols-4">
          <SystemFact label="环境" value={system?.environmentLabel ?? '—'} />
          <SystemFact
            label="模式"
            value={system ? (system.dryRun ? '模拟' : '实盘资金') : '—'}
            sub={system?.tradingDisabled ? '交易已禁用' : '交易已启用'}
            tone={system ? (system.dryRun ? 'text-accent' : 'text-warn') : undefined}
          />
          <SystemFact label="可交易对" value={fmtInt(system?.tradableSymbols)} sub="USDT-M 永续" />
          <SystemFact
            label="推送"
            value={socketOpen ? '实时' : '轮询'}
            sub={socketOpen ? 'WebSocket 已连接' : '已退回轮询'}
            tone={socketOpen ? 'text-up' : 'text-warn'}
          />
          {/*
            时钟偏移与 API 权重是**内部诊断值**（LAYOUT.md §3）：正常运行时它们
            永远"没事"，看一百次有九十九次拿不到信息。所以只在越界时出现，
            并且带后果而不是原始数值。
          */}
          {clockWarn && (
            <SystemFact
              label="⚠ 时钟偏差"
              value={fmtClockOffset(system?.clockOffsetMs)}
              sub="签名请求会被拒（-1021）"
              tone="text-warn"
            />
          )}
          {weightWarn && (
            <SystemFact
              label="⚠ API 权重"
              value={`${fmtInt(weightPercent)}%`}
              sub="继续升高会被封 IP（418）"
              tone="text-warn"
            />
          )}
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
