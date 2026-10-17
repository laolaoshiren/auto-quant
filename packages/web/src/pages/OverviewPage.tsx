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
 *   3. 主区 — the equity curve, **always drawn at full height**. It used to
 *      collapse to a 36px strip when the series was flat or thin (§4: never
 *      spend a third of the viewport drawing a straight line), but that made
 *      the page change height as data arrived — the user asked for a stable
 *      layout ("不管有没有数据都要保持展开状态一致"). It plots the
 *      **account-basis** curve; each bot's attributed curve lives on its own
 *      dashboard;
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
import type { EquitySnapshot, TraderMode, TraderStatus } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { MODE_HINT, MODE_LABEL } from '../lib/glossary';
import { useApp, useEvents } from '../lib/store';
import { useSummaries } from '../lib/summaries';
import { accountEquityContributor, attributedEquityOf, fleetTotals } from '../lib/fleetTotals';
import { pairEquityByTrader } from '../lib/equityPairing';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { Button, Empty, ErrorNote, Panel, Spinner3 } from '../components/ui';
import { Metric, MetricGroup, PageShell, SectionLabel } from '../components/shell';
import { PageActions } from '../templates/lib/PageActions';
import { NewTraderModal, StartTraderModal } from '../components/TraderModals';
import { ConfirmStopTrader } from '../components/ConfirmStopTrader';
import { EQUITY_RANGES, mergeEquityCurves, rangeSpanMs, type EquityRange } from '../components/equityCurve';
import {
  EquitySkeleton,
  SystemFact,
  TradersSnapshotTable,
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
 * ⚠️ 这条 `lazy` 现在**每次都会加载**：曲线不再按数据形状收起，所以一个全新的
 * 账户也会去下载它。这是刻意的取舍 —— 分块仍在（它不阻塞首屏标题数字的绘制，
 * 外壳与左栏先渲染、曲线稍后落位），但"数据薄时省掉这次下载"换不来稳定版面。
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
  /**
   * 已请求确认停止的机器人。
   *
   * ⚠️ 这个状态存在的理由（外部 issue #121）：总览页那个「停止」按钮原先
   * **单击即停**，而停止**不会平仓** —— 误停一台持有杠杆仓位的机器人，
   * 那些仓位就从此没人管保护位了。而同一个操作在列表页是有确认的。
   *
   * 顺带一提：那一格与「启动」按钮并排放着，一红一绿，
   * 很容易被当成「启动 / 停止」开关误点 —— 所以确认在这里尤其必要。
   */
  const [stopTarget, setStopTarget] = useState<TraderRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [range, setRange] = useState<EquityRange>('7D');
  const [refreshing, setRefreshing] = useState(false);
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
  const equityQuery = usePolled<Record<number, EquitySnapshot[]>>(
    async (signal) => {
      const ids = traderIds ? traderIds.split(',').map(Number) : [];
      const pairs = await Promise.all(
        ids.map(async (id) => ({ id, rows: await api.traderEquity(id, 360, signal) })),
      );
      /*
       * ⚠️ **按 id 配对，而不是按数组下标。**
       *
       * 旧写法是 `Promise.all(ids.map(...))` —— 一个**位置数组**，`data[i]` 属于
       * *发出那次请求时*的 ids。下游却按**当前** `traders` 的下标取用
       * （`data[index]`），机器人增删/改序之后两者错位：A 的曲线被记到 B 头上。
       *
       * 而 `usePolled` 的 `setData` 只在**成功**时调用、失败时保留旧 data
       * （`lib/hooks.ts` 的 catch 分支），所以一次失败的轮询会让这批旧顺序的数组
       * 无限期地留在位置上，而 `traders` 已经是新的 —— 错配的窗口不是一瞬，是
       * 直到下一次成功请求为止。这里代入的是**权益数字**，会直接错报舰队合计、
       * 区间盈亏与曲线（首屏那几栏）。
       *
       * 走 id 之后，错配只剩"这一轮没请求到某个 id"（正确留空），不再有'张冠李戴'。
       */
      return pairEquityByTrader(pairs);
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
  for (const trader of traders) {
    equitySnapshots[trader.id] = [
      ...(equityQuery.data?.[trader.id] ?? []),
      ...(liveByTrader[trader.id]?.equity ?? []),
    ];
  }
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
  const fleet = fleetTotals({
    traders,
    stats: statsMap,
    snapshots: equitySnapshots,
    /* ⚠️ 模拟盘不校准（exchangeNet 恒为 0）—— 见 `isLedgerSuspect`。 */
    dryRun: Object.fromEntries(traders.map((t) => [t.id, statsMap[t.id]?.dryRun ?? null])),
  });

  /**
   * 单行的归属权益：**只是这个机器人自己的账**，不能相加。
   *
   * ## ⚠️ 2026-10-14：账本不可信时改用**交易所校准值**（用户报"图4 也一样"）
   *
   * 用户的原话：
   * > 「列表和详情要正确对齐数字，别整无意义的垃圾数据，还有首页总览的图表-图4也是一样」
   *
   * ## 事实（线上 `#10`）
   *
   * ```
   *   账本推算的归属权益  $104.89  ← 起始 100.05 + trades.net_pnl +4.84
   *   交易所真实账户权益  $92.34
   *   差 12.56
   * ```
   * 差额的来源是 `trades.net_pnl` 被对账重建写坏（39 笔 `source='reconciled'`
   * 里 16 笔 `pnl=0`，本该有盈亏，合计虚高 9.13）。
   *
   * ## 判据与详情页 / 机器人列表页**完全一致**
   *
   * ```
   *   ledger.gap ≥ 0.01 → 用交易所的成交流水（exchangeNet）校准
   *   否则              → 用账本（它与交易所一致）
   * ```
   * ⚠️ 三处（首页 / 机器人列表 / 详情页）必须给出**同一个数**，
   * 而"同一个数"的唯一保证是**同一套判据** —— 所以阈值一字不差地复制过来。
   * 改一处必须改三处（这是本项目"同一个算术不要写两遍"那条教训的例外：
   * 三处判据必须一致，而共享它们需要跨页面的模块 —— 那超出本次改动范围，
   * 但**不一致的代价更大**，所以先保证一致）。
   */
  /*
   * ⚠️⚠️ **改用共享实现**（2026-10-14）。
   *
   * 原来这里是"账本 vs 交易所"判据的**第三个副本**，而且它漏了
   * `incomeReadFailed` 那道判据（那时 `exchangeNet` 是残缺读数）。
   *
   * 用户报「你做事情只做一半？？」的直接原因就是这一类复制：
   * 我修了机器人列表页两处，首页这一处没修。
   * 现在判据只有一份（`lib/fleetTotals.ts`），**改一处即三处生效**。
   *
   * ⚠️ 2026-10-15 又加了一道：**模拟盘不校准**（那时 exchangeNet 恒为 0）。
   * 所以 `dryRun` 也要一路传下去。
   */
  const dryRunOf = (id: number): boolean | null | undefined => statsMap[id]?.dryRun;

  const equityOf = (trader: TraderRow): number =>
    attributedEquityOf(trader, statsMap[trader.id], dryRunOf(trader.id));

  const accountEquity = fleet.accountEquityFleet;
  const committedCapital = fleet.committedCapitalFleet;
  const totalReturnPercent = fleet.accountReturnPercent;
  const totalOpen = fleet.openPositionsFleet;
  const unrealized = fleet.unrealizedPnlFleet;
  /*
   * Σ 各机器人自己的净已实现盈亏 —— 这一项本来就是可加的。
   *
   * ⚠️ `fleet.realizedPnlFleet` 现在**已经按交易所校准过**（在 `fleetTotals`
   * 里逐机器人调 `realizedPnlOf`）。所以这里直接用，不要再减一次：
   * ```
   *   #10 校准前 +5.66（坏账本）· 校准后 -7.00（交易所）· 差 12.6
   * ```
   */
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
      <MetricGroup title="账户" columns={2}>
        <Metric
          label={`${BALANCE_LABEL.equity}合计`}
          size="lg"
          tone="strong"
          value={accountCount > 0 ? fmtAsset(accountEquity, 'USDT', 2) : '—'}
          sub={accountCount > 0 ? `按账户口径 · ${fmtInt(accountCount)} 个账户` : '还没有交易所账户'}
          title={`所有交易所账户（共享钱包）的${BALANCE_LABEL.equity}之和 —— 每个账户只算一次。共用同一个账户的机器人读的是同一个钱包，所以它们的「归属权益」不能相加：实盘实测三个机器人 Σ归属权益 30.6690、Σ初始权益 30.2316，而账户里只有 10.4180，其中 19.81 是被数了三遍的同一笔本金。各机器人自己挣了多少见下表「归属权益」列，单个账户的钱见「交易所」页。`}
        />

        <Metric
          label="累计净盈亏"
          tone={pnlTone(realizedPnl)}
          value={fmtUsdSigned(realizedPnl, 2)}
          sub="各机器人自己的净额之和"
          title="Σ(每个机器人自己的已平仓净盈亏)，净 = 毛 − 手续费 − 资金费。这一项可以相加：每个机器人只认自己挂过的订单对应的回合（归属闸门），共享账户不会让它重复计入别人的盈亏。它不含持仓浮盈。"
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
          title="（账户权益合计 − 账户起始资金）÷ 账户起始资金。本金按账户算：共享账户取该账户被接入时的起始资金（最早那个机器人建号时从交易所读到的钱包余额），不是各机器人 initialEquity 之和 —— 后者在同一账户下会把同一笔本金数很多遍（实测 Σ初始权益 30.2316 vs 账户里 10.4180，多算 19.81 USDT）。各机器人自己的收益率见下表。入金/出金也计入本比率。"
        />
      </MetricGroup>

      {/* 并排时（sm–xl）这组不在上一组的下方，那条分隔线会变成一根悬空的横线 */}
      <MetricGroup title="交易" columns={2} className="sm:border-t-0 sm:pt-0 xl:border-t xl:pt-3">
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
          title="所有机器人自己的持仓个数之和。同一账户下多个机器人看到的是同一个钱包，但持仓归属各自独立。"
        />
        <Metric
          label="浮动盈亏"
          tone={pnlTone(unrealized)}
          value={fmtUsdSigned(unrealized, 2)}
          sub={`${fmtInt(totalOpen)} 个持仓 · 未落袋`}
          title="所有机器人自己的持仓的未实现盈亏合计（不是交易所账户的总浮盈 —— 账户的总浮盈在同一账户下的每个机器人身上都是同一个数）。它随时在变，且尚未计入已实现盈亏。"
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
        {/*
          动作走**统一接口**：控制台模板把它们收进工具栏，经典模板就地渲染
          （下面这一屏就是原版的样子）。见 `templates/lib/PageActions.tsx`。

          ⚠️ 这一层容器的类名**原样保留**，它是"经典模板下和改版前逐字一致"
          的关键：`PageActions` 就地渲染时**不加包裹层**，直接把自己那两个
          子项交给这个 `flex` 容器排版（`ml-auto` 把整组推到右边、`gap-1.5`
          给按钮之间留缝）。控制台模板下这个容器是空的 —— 两个子项被 portal
          进工具栏了，而 `flex` 容器没有子项时宽度为 0，不影响标题行。
        */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <PageActions
            start={
              <>
                <Button small variant="ghost" busy={refreshing} onClick={refreshAll} title="重新读取机器人列表、统计与系统状态">
                  <RefreshCw aria-hidden className="h-3.5 w-3.5" />
                  刷新
                </Button>
                <Link to="/traders" className="btn btn-ghost btn-xs">
                  管理机器人
                </Link>
              </>
            }
            end={
              <Button small variant="primary" onClick={() => setNewOpen(true)}>
                新建机器人
              </Button>
            }
          />
        </div>
      </header>

      <PageShell aside={rail}>
        {/*
          **运行模式分布**（用户 2026-10-12 要求三种模式在 UI 上分开）。

          用户的原话：
          > 「既然现在有 3 种模式了（普通、智能、团队），那么 **UI 上面也要加上相应得显示**，
          >  并且 3 种模式进去以后看板 UI 显示内容什么的**也应该是要分开的**」

          ## 为什么总览页需要这一块

          总览页此前把所有机器人**混在一起**统计（"共 N 个机器人"）——
          而三种模式的运行方式、成本、风险完全不同：

          | 模式 | 谁在决策 | 一轮要多久 |
          |---|---|---|
          | 普通 | 固定策略，**不用 AI** | 秒级 |
          | 智能托管 | **一个**模型 | 1–10 分钟 |
          | AI 团队 | **一队**模型（开会） | 数分钟 |

          混在一起时，"有 3 个在跑"看不出**有多少个在烧模型额度**。

          ## 为什么不做成"分模式各显示一套指标"

          那会让总览页在只有一种模式时**显得残缺**（大块空白区域），
          而用户要的是**增量**：现有模式的表现**一点都不能变**。
          所以这里只是**加一块**分布视图，不动任何既有指标。
        */}
        <ModeBreakdown traders={traders} onOpen={(id) => navigate(`/traders/${id}`)} />

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
          ) : (
            /*
             * ⚠️ **永远画完整曲线，不再按数据形状决定展开还是收成一条缩略线。**
             *
             * 原来的规则是"有形状（≥3 点且有波动）才展开，否则塌成 36px 的
             * `EquityStrip`"。理由本身没错（§4：不要拿三分之一屏去画一条直线），
             * 但它带来一个更糟的问题：**同一块版面会随数据变高变矮** ——
             * 机器人还没跑够两个周期时是一行缩略线，跑够了突然长成 240px 图表，
             * 整页其它区块跟着上下跳。用户的原话是「这个图标默认就要展开显示，
             * 不管有没有数据都要保持展开状态一致」。
             *
             * 高度稳定比"省那 200px"重要：这一页是首屏，它会跳就意味着每次
             * 刷新都要重新找一遍"我的机器人在哪"。
             *
             * 数据不足时的提示没有丢：曲线没有点可画时 `EquityCurveChart`
             * 自己会给空态说明。
             */
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
              navigate={navigate}
              onStop={setStopTarget}
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

      {/* 与列表页 / 详情页 / 命令面板共用同一个确认组件，文案只有一份。 */}
      <ConfirmStopTrader
        trader={stopTarget}
        open={stopTarget !== null}
        busy={stopTarget !== null && busyId === stopTarget.id}
        onCancel={() => setStopTarget(null)}
        onConfirm={() => {
          const target = stopTarget;
          setStopTarget(null);
          if (target) void stop(target);
        }}
      />
    </div>
  );
}


/**
 * **运行模式分布** —— 三种模式在总览页分开显示（用户 2026-10-12 要求）。
 *
 * ## 为什么需要它
 *
 * 总览页此前把所有机器人**混在一起**统计（"共 N 个机器人"）——
 * 而三种模式的运行方式与成本完全不同：
 *
 * | 模式 | 谁在决策 | 一轮要多久 |
 * |---|---|---|
 * | 普通 | 固定策略，**不用 AI** | 秒级 |
 * | 智能托管 | **一个**模型 | 1–10 分钟 |
 * | AI 团队 | **一队**模型（开会） | 数分钟 |
 *
 * 混在一起时，"有 3 个在跑"看不出**有多少个在烧模型额度**。
 *
 * ## 为什么三种模式【都列】，即使数量为 0
 *
 * 只列有机器人的模式，会让"这个系统支持三种模式"这件事**看不出来** ——
 * 而用户的原话正是「**UI 上面也要加上相应得显示**」。
 * 数量为 0 时显示成灰的，而不是隐藏。
 *
 * ## 为什么不做成"分模式各一套指标"
 *
 * 那会让总览页在只有一种模式时**显得残缺**（大块空白），
 * 而用户要的是**增量**：现有模式的表现**一点都不能变**。
 * 所以这里只**加一块**分布视图，不动任何既有指标。
 */
function ModeBreakdown({
  traders,
  onOpen,
}: {
  traders: TraderRow[];
  onOpen: (id: number) => void;
}): React.ReactElement {
  const groups: Array<{ mode: TraderMode; label: string; hint: string }> = [
    /* 名字登记在 `lib/glossary.ts`（唯一登记处）—— 这里不许再写字面量。 */
    { mode: 'strategy', label: MODE_LABEL.strategy, hint: MODE_HINT.strategy },
    { mode: 'ai_managed', label: MODE_LABEL.ai_managed, hint: MODE_HINT.ai_managed },
    { mode: 'ai_team', label: MODE_LABEL.ai_team, hint: MODE_HINT.ai_team },
  ];

  return (
    <section aria-labelledby="overview-modes">
      <SectionLabel title="运行模式" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {groups.map((g) => {
          const mine = traders.filter((t) => t.mode === g.mode);
          const running = mine.filter((t) => t.status === 'running');
          return (
            <Panel key={g.mode} className="p-3">
              <div className="flex items-baseline gap-2">
                <span className="text-base font-medium text-ink-hi">{g.label}</span>
                <span className="num text-sm text-ink-soft">{mine.length}</span>
                {running.length > 0 && <span className="text-xs text-up">运行中 {running.length}</span>}
              </div>
              <p className="mt-0.5 text-xs text-ink-faint">{g.hint}</p>
              {mine.length === 0 ? (
                <p className="mt-1.5 text-xs text-ink-faint">（暂无）</p>
              ) : (
                <ul className="mt-1.5 space-y-0.5">
                  {mine.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(t.id)}
                        className="flex w-full items-center gap-1.5 text-left text-xs hover:text-ink-hi"
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            t.status === 'running' ? 'bg-up' : 'bg-ink-faint/50'
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate text-ink-lo">{t.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          );
        })}
      </div>
    </section>
  );
}