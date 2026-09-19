import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Play,
  Settings2,
  Square,
  Zap,
} from 'lucide-react';
import { beijingDayStartMs, type EquitySnapshot } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { useApp, useEvents } from '../lib/store';
import { useSummaries } from '../lib/summaries';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { useRunOnce } from '../lib/actions';
import { Badge, Button, Empty, ErrorNote, Panel, Spinner3, cn } from '../components/ui';
import { TraderStatusBadge } from '../components/Badges';
import { PageShell, Metric } from '../components/shell';
import { DecisionFeed } from '../components/DecisionFeed';
import { isOpenOrder, TraderTables, type TraderTabId } from '../components/TraderTables';
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
  fmtSigned,
  fmtUsd,
  fmtUsdSigned,
  pnlColor,
  timeAgo,
} from '../lib/format';

type ChartTab = 'equity' | 'candles';


/**
 * 展开后的权益曲线高度。
 *
 * 220px 在 900px 视口上约 24% 屏高：有形状时够看清趋势，没形状时根本不会画出来
 * （见 `EquityMiniStrip`，`LAYOUT.md` §3「图表只在有数据可看时才占大块」）。
 *
 * 决策流**不再有对应的常量**：它住在右栏，高度由外壳那份"可视区 − 顶栏"给，
 * 页面手算一个视口高度必然算错（见 `DecisionFeed` 顶部注释）。
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
 * 版式按 `LAYOUT.md` §0/§2/§3：**左边主内容（约 60%）+ 右边决策栏（约 40%）**。
 *
 * - 主栏内部顺序固定：对象头 → 指标行 → 图表 → 表格（§3）。页头只留一行
 *   "我是谁、什么状态、能做什么"；变化很慢的配置收进 `ConfigSummary`。
 * - 指标从 280px 的**竖排**左栏改成**横排 4 张卡**（§0 规则 3）：竖排会让每个指标
 *   白占一整行宽度，而它们的数值都很短。
 * - **决策流搬到右栏**并自己撑满屏高、自己滚动（§2）—— 它是这一页最该被盯着的
 *   部分，以前被一张占 40% 屏高的平线权益图挤到了页面底部。
 * - 权益曲线只在**真有形状**时才画成图表，否则压成 36px 的缩略条。
 */
export function TraderPage() {
  const params = useParams();
  const traderId = Number(params.id);
  const navigate = useNavigate();
  const system = useApp((s) => s.system);
  const socketOpen = useEvents((s) => s.status) === 'open';
  /*
   * 平仓后用 REST 的结果覆盖 store 里的持仓 —— 见 `onPositionsChanged` 上的说明。
   * 这里取的是**动作**（引用稳定），不是状态，所以不会引起额外渲染。
   */
  const setLivePositions = useEvents((s) => s.setPositions);
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
  const { runOnce, busyId: runOnceBusyId } = useRunOnce();

  const tradersQuery = usePolled((signal) => api.traders(signal), {
    intervalMs: socketOpen ? 8000 : 4000,
  });
  const modelsQuery = usePolled((signal) => api.aiModels(signal), { intervalMs: 60_000 });
  const strategiesQuery = usePolled((signal) => api.strategies(signal), { intervalMs: 60_000 });
  /*
   * 交易所账户列表 —— 只为了页头能显示**这个机器人用的是哪个钱包**。
   *
   * 原来页头显示的是环境标签（「币安 USDT 本位合约（实盘）」），
   * 那说的是**平台**，不是**账户**。同一个平台下可能配了多个钱包，
   * 而"这台机器人花的是哪一笔钱"是操作员最需要一眼确认的事 ——
   * 尤其当多个机器人共用一个账户时。
   */
  const exchangeAccountsQuery = usePolled((signal) => api.exchangeAccounts(signal), {
    intervalMs: 300_000,
  });

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
   * 账户上的外部交易活动 —— 见 `api.foreignActivity` 上的说明。
   *
   * 轮询间隔比账户读数**慢得多**（它来自每 10 轮一次的深对账，快轮询没有意义），
   * 而且机器人在停止状态下也要能读到（那正是最需要它的时刻）。
   */
  const foreignQuery = usePolled((signal) => api.foreignActivity(traderId, signal), {
    intervalMs: 120_000,
    enabled: Number.isFinite(traderId),
    deps: [traderId],
  });
  const foreign = foreignQuery.data ?? null;

  /*
   * The settlement unit the exchange reports, reused by `ConfigSummary`'s 起始权益
   * and the account strip underneath, so both read in the same unit.
   * Falls back to USDT, which is what every payload we have actually uses.
   */
  const rawAsset = accountQuery.data?.account?.asset;
  const settleAsset = typeof rawAsset === 'string' && rawAsset.trim() ? rawAsset.trim() : DEFAULT_SETTLE_ASSET;

  const trader: TraderRow | null = tradersQuery.data?.find((row) => row.id === traderId) ?? null;
  /**
   * 这个机器人用的钱包名。取不到时回落到通用称呼，不显示空。
   *
   * ⚠️ **必须在 `trader` 之后**：这里引用了 `trader?.exchangeAccountId`，
   * 而它下面的 `.find()` 是**同步执行**的 —— 放在 `trader` 声明之前会撞上
   * 暂时性死区（`Cannot access before initialization`），整棵 React 树会卸载。
   * 类型检查抓不到它，因为引用包在箭头函数里、看起来像是稍后才跑。
   */
  const accountLabel = exchangeAccountsQuery.data?.find(
    (row) => row.id === trader?.exchangeAccountId,
  )?.label;
  const status = liveStatus ?? trader?.status ?? 'stopped';
  /*
   * 决策流用它决定要不要显示"正在请求模型"这一条。
   *
   * 取**并集**而不是只看 REST：REST 那一份最多滞后 8 秒，刚点下「启动」时它还是
   * `false`，而那时周期可能已经开始了；反过来，刚点「停止」时推送也还没到。
   * 两种口径都在说"在跑"才显示转圈，是为了不出现"停了还在转"的假状态
   * （`LAYOUT.md` §7）。`error` / `safe_mode` 下循环仍在，但连续失败本身就该
   * 被看见 —— 那个状态由页头的徽章与横幅负责，这里的转圈只属于正常周期。
   */
  const running =
    trader?.isRunning === true ||
    liveStatus === 'running' ||
    liveStatus === 'starting' ||
    liveStatus === 'safe_mode';
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

  /*
   * 行情图表当前显示的币种。
   *
   * 默认取第一个持仓（"我在盯什么"），而下方表格里的币种名可以点击把它换掉 ——
   * 用户看到某个陌生币种时，最自然的动作就是"让我看看它长什么样"。
   *
   * `undefined` 表示还没选过：那时跟随第一个持仓。**一旦用户点过就不再自动跟随** ——
   * 否则行情会因为持仓变动跳走，那比不跳更烦人。
   *
   * ⚠️ **只依赖 `positions`，而它在上面** —— 这个位置上不能引用任何在它之后声明的
   * 变量。我用 `.find(回调)` 引用过后面声明的 `trader`，撞上暂时性死区、整页白屏；
   * 类型检查抓不到那种错，因为引用包在回调里、看起来像是稍后才跑。
   */
  const [pickedSymbol, setPickedSymbol] = useState<string | undefined>(undefined);
  const chartSymbol = pickedSymbol ?? positions[0]?.symbol;
  /*
   * ⚠️ **必须用 `isOpenOrder`，不能自己写判定。**
   *
   * 这里原本是一个本地正则：`!/FILLED|CANCELED|.../i.test(order.status)`。
   * 而下方 `TraderTables` 的「当前委托 N」用的是 `isOpenOrder()` ——
   * **两套判定数出来的是两个数**，于是同一屏上「挂单 4」与「当前委托 2」
   * 互相矛盾（用户实际就是这样发现的）。
   *
   * 后者是对的：`isOpenOrder` 用的是完整的终态集合（含
   * `EXPIRED_IN_MATCH` / `EXPIRED_IN_FUTURES` 这两个**旧正则没覆盖**的状态），
   * 而 `TraderTables` 里有一段注释记录了他们为"已结算的止损单仍停留在委托里"
   * 这个问题专门建了它。
   *
   * **同一屏上的同一个概念只能有一个判定。** 两个"都对"的实现放在一起，
   * 结果就是两个都不可信。
   */
  const openOrders = (live?.orders ?? []).filter(isOpenOrder);

  // A REST page wins, but the socket appends snapshots between polls, so both
  // are merged and de-duplicated by timestamp.
  const snapshots: EquitySnapshot[] = useMemo(() => {
    const merged = new Map<string, EquitySnapshot>();
    for (const row of equityQuery.data ?? []) merged.set(row.timestamp, row);
    for (const row of live?.equity ?? []) merged.set(row.timestamp, row);
    return [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [equityQuery.data, live?.equity]);

  const equity = stats?.equity ?? snapshots[snapshots.length - 1]?.equity ?? trader?.initialEquity ?? 0;

  /*
   * 最近一条快照里的**交易所账户读数**。
   *
   * ## 为什么需要它
   *
   * 机器人停止时，`api.traderAccount()` 拿不到实时值，「交易所账户」那一行
   * 就只显示「暂无实时读数」。于是这一页上有两个**无法对照**的数字：
   *
   *     归属权益 9.4246     ← 初始 9.1 + 本机器人累计净 +0.3246
   *     交易所账户          ← 「暂无实时读数」
   *
   * 而同一个账户上另外两个机器人分别亏了 0.4005 与 0.4663 ——
   * **它们亏的钱是从同一个钱包扣的**，所以钱包里实际只有 7.54。
   * 操作员看到 9.42、去交易所看到 7.54，自然会问为什么对不上。
   *
   * 快照里存着当时的真实账户权益（`accountEquity`）与可用余额，
   * **数据在库里、界面却不说** —— 那才是困惑的来源。
   *
   * ## 取的是账户口径，不是归属口径
   *
   * `accountEquity` / `accountUnrealizedPnl` 是**账户级**的（共享钱包）；
   * 而 `equity` / `unrealizedPnl` 是**归属这个机器人**的。
   * 混用会让这一行和上面的指标卡对不上，那正是它要消除的问题。
   */
  const lastKnownAccount = useMemo(() => {
    const latest = snapshots[snapshots.length - 1];
    if (!latest) return null;
    return {
      at: latest.timestamp,
      account: {
        equity: latest.accountEquity,
        walletBalance: latest.accountEquity,
        availableBalance: latest.availableBalance,
        unrealizedPnl: latest.accountUnrealizedPnl,
        marginUsed: latest.marginUsed,
      },
    };
  }, [snapshots]);
  const marginUsed = positions.reduce((sum, p) => sum + p.marginUsed, 0);
  const notional = positions.reduce((sum, p) => sum + p.notional, 0);
  const effectiveLeverage = equity > 0 ? notional / equity : 0;
  const unrealized = stats?.unrealizedPnl ?? positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const realized = stats?.realizedPnl ?? 0;
  // Real counts straight from the API. Deriving them from `winRatePercent` was
  // both lossy and, once the unit was misread, wildly wrong.
  const wins = stats?.wins ?? 0;
  const losses = stats?.losses ?? 0;
  /*
   * 持仓数**只看本地那一份列表**，不再回落到 `stats.openPositions`。
   *
   * 原来是 `positions.length || stats?.openPositions || 0` —— 三层来源。
   * 于是本地列表为空、而服务端统计说还有 2 个时，卡片显示 2、
   * 下面的持仓表却是空的：**同一屏上同一个概念给出两个互相矛盾的数**。
   *
   * 这正是订单数那条 bug 的同一个成因（实测撞到过「挂单 4 / 当前委托 2」），
   * 只是换了一个概念。**回落看起来是"更健壮"，实际是把不一致引了进来。**
   *
   * 现在卡片与持仓表读的是同一个表达式（`live?.positions ?? []`）——
   * 要过期就一起过期，至少不会自相矛盾。
   */
  const openPositionCount = positions.length;

  /*
   * 「今日盈亏」= 当前归属权益 − **北京时间今天 0:00 时**的归属权益。
   *
   * ## 为什么不是「滚动 24 小时」
   *
   * 原来这里比的是 `Date.now() - 24h` 那条快照。那有两个毛病：
   *
   *   · **它不叫「今日」。** 在北京时间凌晨 0:35，滚动 24 小时实际覆盖的是
   *     「昨天 0:35 到现在」—— 操作员问"今天赚了多少"，得到的却是昨天大半天
   *     加上今天凌晨的数字。
   *   · **同一个页面上的两个数字口径不同。** 「归属权益」是累计值，
   *     而旁边的「今日盈亏」是滑动窗口，两者对不上时没人能一眼看出为什么。
   *
   * 自然日还有一个好处：它**跨刷新、跨重启都稳定** —— 同一个"今天"里
   * 中午看和晚上看，基准是同一个数。
   *
   * ## 基准怎么取
   *
   * 取**北京时间 0:00 之前的最后一条**快照。用"最后一条"而不是"第一条"：
   * 0:00 之后的第一条快照可能已经过了好几分钟（周期是 15 分钟），
   * 而那几分钟里的盈亏本来就该算在今天 —— 用日界之前的那条才不漏。
   *
   * 机器人今天才建、日界之前没有任何快照时，回落到**最早的一条**：
   * 那等于"从开始记录算起"，并在卡片上如实标注区间（见下面的 `todayIsPartial`）。
   */
  const todayBaseline = useMemo(() => {
    if (snapshots.length === 0) return undefined;
    const dayStart = beijingDayStartMs();
    let before: EquitySnapshot | undefined;
    for (const snapshot of snapshots) {
      if (new Date(snapshot.timestamp).getTime() < dayStart) before = snapshot;
      else break;
    }
    /*
     * `before` 存在 ⇒ 基准真的落在日界之前，覆盖完整。
     * 否则用最早那条（机器人今天才启动），此时**不能**叫它"今日"。
     */
    return before
      ? { equity: before.equity, full: true }
      : snapshots[0]
        ? { equity: snapshots[0].equity, full: false }
        : undefined;
  }, [snapshots]);

  const todayPnl = todayBaseline === undefined ? 0 : equity - todayBaseline.equity;
  const todayIsPartial = todayBaseline !== undefined && !todayBaseline.full;
  const todayBase = todayBaseline?.equity;
  const todayPercent = todayBase ? (todayPnl / Math.abs(todayBase)) * 100 : 0;

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

  /*
   * 这三个提前返回也要自己加内边距：外壳不再替页面留边（见文件末尾的注释），
   * 少了它，错误提示会贴着屏幕左上角。
   */
  if (!Number.isFinite(traderId)) {
    return (
      <div className="p-4">
        <ErrorNote>机器人 ID 无效。</ErrorNote>
      </div>
    );
  }
  if (tradersQuery.loading && !trader) {
    return (
      <div className="p-4">
        <Spinner3 label="正在加载机器人" />
      </div>
    );
  }

  if (!trader) {
    return (
      <div className="p-4">
        <Panel title="未找到机器人">
          <p className="text-base text-ink-lo">
            {tradersQuery.error ?? `没有 id 为 ${traderId} 的机器人。它可能已被删除。`}
          </p>
          <Button className="mt-3" onClick={() => navigate('/traders')}>
            返回机器人列表
          </Button>
        </Panel>
      </div>
    );
  }

  const statsCost = stats ? statsCosts(stats) : null;

  /**
   * 「立即分析」——**只跑一个决策周期，不启动机器人**。
   *
   * 启动是页头的「启动」。旧名字「立即运行」把这两件事混成一件，会让人以为点了
   * 就开始交易了；参考产品把同一个动作叫「立即分析」，这里照抄它。
   *
   * 它现在住在右栏决策流的**面板头**里（`DECISION-FEED.md` §1 的参考形态是
   * `最近决策   ⚡立即分析   ↻`）：结果就落在这个面板里，按钮放在结果旁边，
   * 点完不必再把视线挪回页头。为此它作为一个**元素**传给 `DecisionFeed`，
   * 决策流因此不需要知道 `useRunOnce`，也不需要知道忙的是哪个机器人。
   *
   * 仍然**只在机器人运行时出现**：`runCycleNow` 在找不到运行实例时会直接抛
   * 「该机器人当前未在运行。」（`manager.ts`），摆一个按下去必然报错的按钮，
   * 就是在界面上写一句不成立的话（`LAYOUT.md` §7）。忙闲、提示与 toast 全部沿用
   * `useRunOnce`（只跑一轮，不做别的）。
   */
  const runNowAction = running ? (
    <Button
      size="sm"
      variant="primary"
      busy={runOnceBusyId === trader.id}
      title="立即分析一次：强制执行一个决策周期，不等间隔。它不会启动机器人 —— 要开始交易请用页头的「启动」。"
      onClick={() => void runOnce(trader.id, trader.name)}
    >
      {/*
        闪电而不是循环箭头：面板头的「刷新」用的就是循环箭头，两个一样的图标并排会
        分不清哪个是刷新记录、哪个是跑一轮。参考产品这一格（`⚡立即分析`）也是闪电。
      */}
      <Zap aria-hidden className="h-3.5 w-3.5" />
      立即分析
    </Button>
  ) : null;

  /*
   * B. 指标行：4 个关键数字，**横排卡片**（`LAYOUT.md` §0 规则 3）。
   *
   * 旧版是 280px 的竖排左指标栏，八段同权重的文字分成三组堆了一列。竖排的代价是
   * 每个指标都占掉一整行宽度，而它们的数值都很短；横排之后一眼看完，右边那段宽度
   * 同时腾给了决策流。三条规矩：
   *
   * 1. **一行 4 个，不再多。** 保证金 / 名义 / 杠杆、模型、策略这些事实降级到下面
   *    一行小字（见 `secondaryFacts`）—— 超过 4 个就该分组，而不是把卡片缩小；
   * 2. 四张卡都是关键数字，所以都是 `size="lg"`；层次靠"卡片 vs 小字"来分，
   *    不靠把字号抖成一排不一样大（DESIGN.md §4）；
   * 3. **只放状态，不放诊断值** —— 没有 token 数、没有快照数、没有本地时钟。
   *    顶栏已经常驻显示推送状态，所以这里也不再重复一个「数据源」。
   */
  const metricCards = (
    /*
     * 指标卡**等高**（不加 `items-start`），这是刻意的。
     *
     * 与决策卡的规则相反，原因也相反：
     *
     * · **决策卡**内容差异极大（有的只有一行标题、有的写满说明与数字），
     *   撑等高会让短卡中间空出一大片 —— 那里用 `items-start` 是对的。
     * · **指标卡**是一组 KPI 方块，是**一个视觉单元**。高低不齐本身就是错的：
     *   操作者扫一眼这四个数，"胜率"那张因为多了进度条而比邻居高一截，
     *   会让人觉得它们不属于同一组。
     *
     * 等高由这一行最高的那张决定，其余三张把多出来的空间留在底部。
     */
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard>
        <Metric
          label={`归属权益（${settleAsset}）`}
          value={fmtNum(equity, 4)}
          size="lg"
          tone="strong"
          title="归属权益 = 初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈。它只包含这个机器人自己的交易；共用的钱包见下面的「交易所账户」，起始权益见上方配置摘要。"
          sub={
            stats ? (
              <span className={pnlColor(stats.totalReturnPercent)}>
                总收益率 {fmtPercent(stats.totalReturnPercent)}
              </span>
            ) : (
              '等待统计'
            )
          }
        />
      </MetricCard>

      <MetricCard>
        <Metric
          label="今日盈亏"
          value={fmtUsdSigned(todayPnl, 2)}
          size="lg"
          tone={toneOf(todayPnl)}
          sub={`${todayIsPartial ? '自启动 ' : ''}${fmtPercent(todayPercent)} · 基准 ${fmtNum(todayBase ?? equity, 2)}`}
          title={
            todayIsPartial
              ? '这个机器人今天才开始记录，日界之前没有快照 —— 基准取的是最早一条，' +
                '所以这里显示的是「自启动以来」的变化，不是完整的自然日。'
              : '相对**北京时间今天 0:00** 那个时刻的权益变化。「基准」就是日界之前最后一条快照上的权益。' +
                '用自然日而不是滚动 24 小时：凌晨看它时，得到的是「今天」而不是「昨天大半天加今天凌晨」。'
          }
        />
      </MetricCard>

      <MetricCard>
        {/*
          没有已平仓交易时，**不摆一排零**。
          
          原来这里恒定显示 `胜率 0.0%` + `0 盈/0 亏` + `PF 0.00 · 0 笔已平仓` ——
          对一个从未成交的机器人，这些零占了最显眼的一段，而它们不含任何信息：
          0% 的胜率和"还没交易过"是完全不同的两件事，前者会让人以为策略很烂。
          
          有交易时按原来的显示；没有时只说一句实话。
        */}
        {stats && stats.totalTrades > 0 ? (
          <Metric
            label="胜率"
            value={`${stats.winRatePercent.toFixed(1)}%`}
            size="lg"
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
            size="lg"
            title="这个机器人还没有完成过任何一次开仓—平仓回合，所以胜率与盈亏比都没有意义。"
            sub={stats ? '完成第一个回合后这里会显示胜率与盈亏比' : '等待统计'}
          />
        )}
      </MetricCard>

      <MetricCard>
        <Metric
          label="持仓"
          /*
           * 只显示持仓数，**不再显示挂单数**。
           *
           * 原来写「持仓 / 挂单」，而下面「当前委托」标签本来就报同一个数 ——
           * 同一屏上同一个概念出现两次，一旦两处的判定或数据源有一点差别，
           * 用户看到的就是两个互相矛盾的数（实测撞到过：挂单 4 与当前委托 2）。
           *
           * **多余的信息不只占地方，它会主动制造错误印象。**
           */
          value={fmtInt(openPositionCount)}
          size="lg"
          sub={
            <>
              浮动 <span className={pnlColor(unrealized)}>{fmtUsdSigned(unrealized, 2)}</span>
            </>
          }
        />
      </MetricCard>
    </div>
  );

  /*
   * 指标行下面的一行次要事实。
   *
   * 它们是**同一个口径的三个数**（保证金 / 名义 / 有效杠杆 —— 都由持仓推出），
   * 加上"这个机器人是什么"（模型 / 策略）。都要常驻可见，但不该和归属权益一样大，
   * 所以降级成一行小字而不是第 5、第 6 张卡（`LAYOUT.md` §0 规则 3：一行最多 4 个）。
   */
  const secondaryFacts = (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-1 text-xs text-ink-lo">
      <span title="本机器人持仓占用的保证金，与「交易所账户」里的保证金口径一致。">
        保证金{' '}
        <span className="num text-ink-mid">
          {fmtNum(marginUsed, 2)} {settleAsset}
        </span>
      </span>
      <span title="所有未平仓合约的名义价值之和。">
        名义 <span className="num text-ink-mid">{fmtUsd(notional, 2)}</span>
      </span>
      <span title="有效杠杆 = 本机器人总名义价值 ÷ 归属权益。满仓 10x 时读数最高。">
        有效杠杆 <span className="num text-ink-mid">{effectiveLeverage.toFixed(2)}x</span>
      </span>
      <span>
        AI 模型{' '}
        <Link to="/models" className="text-accent hover:underline" title="决定它看什么、怎么下单的模型。">
          {model ? model.label : `#${trader.aiModelId}`}
        </Link>
        {model?.model && <span className="ml-1 text-ink-faint">{model.model}</span>}
      </span>
      <span>
        {/*
          AI 托管模式下**不显示策略**。
          
          策略是"一组固定参数"，而 AI 模式的意思是"由 AI 实时设定并调整参数"——
          对这台机器人来说，`strategies` 表里那一行**不生效**（生效的是
          `agent_config_json`）。
          
          之前这里显示「策略 #8」并链到策略编辑页，那会让人以为改那里能影响它 ——
          **一个链到无效配置的链接，比没有链接更糟**：用户改完发现没效果，
          却不知道该怪谁。
        */}
        {trader.mode === 'ai_managed' ? (
          <span title="参数与交易提示词由 AI 自主设定并持续调整；生效的配置不在策略里。">
            智能托管
          </span>
        ) : (
          <>
            策略{' '}
            <Link
              to={`/strategy/${trader.strategyId}`}
              className="text-accent hover:underline"
              title="决定候选交易对、杠杆与风控阈值的策略。"
            >
              {strategy?.name ?? `#${trader.strategyId}`}
            </Link>
          </>
        )}
      </span>
      {/*
        推送断开时才出现。
        
        这是一个**越界**状态，而且带后果（数字最多滞后几秒）；正常运行时顶栏已经有
        一个「推送在线」，页面再常驻重复一遍就是 §5 说的那种"看一百次有九十九次
        拿不到信息"的值。
      */}
      {!socketOpen && (
        <span
          className="text-warn"
          title="实时事件推送断开，页面改为每 4 秒轮询一次；持仓、委托与权益最多可能滞后几秒。"
        >
          推送断开，按 4 秒轮询兜底
        </span>
      )}
    </div>
  );

  return (
    /*
     * 页面自己负责内边距：外壳（Layout.tsx）刻意不给内容区加 padding，因为右栏要的
     * 是"可视区 − 顶栏"那份**确定高度**，中间再夹一层边距就说不清那份高度属于谁。
     *
     * `h-full` 是那条高度链的起点：
     * 这里 → `PageShell` 的 `xl:h-full` → 右栏的 `max-h-full` → 决策流的 `h-full`。
     * 少了它，决策流只能拿到内容高度，"撑满屏高"就没了（LAYOUT.md §2）。
     *
     * 也不再设 `max-w`：§2 明确说主内容区不设最大宽度 —— 宽屏上把空间给图表和表格。
     */
    /*
     * 页面纵向切成两块：**上面是两栏（主内容 + 决策流），下面是全宽的表格区**。
     *
     * 为什么必须这样切：成交表有 11 列、需要约 1200px，而两栏布局只给它 60%
     * （1440px 视口下约 807px）。要让两者并存得靠约 2100px 的视口 —— 现实分辨率
     * 里不存在，所以表格只能脱离那两栏、占满整宽，否则永远要左右拖动。
     *
     * `min-h-0` 两个都不能省：flex 子项的默认 `min-height: auto` 会按内容撑高，
     * 于是 `flex-1` 失效、高度链断掉，决策流拿不到确定高度、内部滚动条随之消失。
     * 这条链是：这里 → `PageShell` 的 `xl:h-full` → 右栏 `max-h-full` → 决策流 `h-full`。
     */
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="min-h-0 flex-1">
      <PageShell
        aside={<DecisionFeed traderId={traderId} running={running} actions={runNowAction} />}
      >
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
          {/*
            显示**这个机器人用的是哪个钱包**，而不是交易环境标签。
            
            原来这里是「币安 USDT 本位合约（实盘）」—— 那说的是**平台**，
            不是**账户**。同一个平台下可能配了多个钱包，而
            「这台机器人花的是哪一笔钱」才是操作员需要一眼确认的事，
            尤其当几个机器人共用同一个账户时（那种情况下很容易看错）。
            
            环境（实盘/模拟）仍然有价值，但它降级到 title 里 ——
            它不随机器人变化，而钱包名会。
          */}
          <Badge
            tone="muted"
            title={
              `该机器人使用的交易所钱包。交易环境：${system?.environmentLabel ?? '未知'}（由服务端配置决定）。`
            }
          >
            {accountLabel ?? `${settleAsset} 账户`}
          </Badge>
          {trader.consecutiveFailures > 0 && (
            <Badge tone="warn" title="连续的模型或执行失败次数；超过熔断阈值会进入安全模式。">
              {trader.consecutiveFailures} 次连续失败
            </Badge>
          )}

          {/*
            页头只留「启动 / 停止」与「配置」。

            · 「立即分析」搬去了右栏决策流的面板头 —— 它跑出来的那一轮就落在那个面板里，
              摆在结果旁边比摆在页头更近（见上面 `runNowAction`）。
            · 「对账」删掉：对账是服务端**自己按周期做**的，不靠人按 —— 运行中的机器人
              每个决策周期都浅对账最近 30 天，并且每 24 轮做一次覆盖全生命周期的深对账
              （`autoTrader.ts` 的 `reconcileTradeHistory()` / `FULL_RECONCILE_EVERY_PASSES`），
              服务启动时再对所有机器人跑一次（`index.ts` 的 `reconcileAllTraders()`）。
              常驻一个手动按钮反而在暗示"不按就不对账"，那是假的。
              注意边界：**停止中**的机器人不在周期对账的覆盖范围内，它只在服务启动
              那一次被对账（或重新启动机器人之后）。接口仍然在
              （`POST /api/traders/:id/reconcile`、`lib/actions.ts` 的 `useReconcile`），
              只是控制台不再提供一个按钮。
          */}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
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
          </div>
        </header>

        {/* A2. 配置摘要：次要信息折起来，但永远点得到 -------------------- */}
        <ConfigSummary trader={trader} asset={settleAsset} />

        {actionError && <ErrorNote>{actionError}</ErrorNote>}

        {status === 'safe_mode' && (
          <div className="rounded-md border border-warn/60 bg-warn/10 px-3 py-2 text-base text-warn">
            <span className="font-semibold">已进入安全模式。</span> 连续的模型或执行失败超过了熔断阈值。循环仍在运行，
            但只会每隔几个周期探测一次模型，直到再次成功。
          </div>
        )}

        {/*
          账户上有不属于本平台的交易。

          **放在这里而不是塞进说明文字里**：它解释的是操作员最容易误解的那个现象 ——
          「机器人显示在赚钱，账户却在缩水」。两者都对，差额来自这些交易。

          用 `down` 色调而不是 `warn`：这不是"注意一下"，是**账户里的钱在减少、
          而原因可能不在你的机器人身上**（也可能是别人在用这个账户）。
        */}
        {foreign !== null && foreign.rounds > 0 && (
          <div className="rounded-md border border-down/60 bg-down/10 px-3 py-2 text-base text-ink-hi">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold text-down">账户上有不属于本平台的交易</span>
              <span className="num">
                {fmtInt(foreign.rounds)} 笔 · 净 {fmtSigned(foreign.net, 4)} USDT
              </span>
            </div>
            {/*
              ⚠️ **JSX 不解析 Markdown** —— 这里原来写的是 `**直接从交易所余额进出**`，
              那六个字符会原样出现在界面上。加粗必须用 <strong>。
              （这个坑在本仓库其它地方也踩过：`DecisionFeed` 里有一条同样的注释。）
            */}
            <p className="mt-1 text-sm text-ink-mid">
              这些成交不是这个平台下的单，它们的盈亏
              <strong className="text-ink-hi">直接从交易所余额进出</strong>
              ，不计入本机器人的绩效。所以「归属权益」与「交易所账户余额」对不上时，
              差额可能来自这里 —— <strong className="text-ink-hi">不是你的策略在亏。</strong>
            </p>
            {foreign.symbols.length > 0 && (
              <p className="num mt-1 text-sm text-ink-lo">
                涉及标的：{foreign.symbols.slice(0, 8).join("、")}
                {foreign.symbols.length > 8 ? ` 等 ${foreign.symbols.length} 个` : ""}
              </p>
            )}
            <p className="mt-1 text-sm text-warn">
              如果这不是你在别的程序或交易所端下的单，请立刻到交易所检查 API Key 与账户安全。
            </p>
          </div>
        )}
        {status === 'error' && trader.lastError && (
          <div className="rounded-md border border-down/60 bg-down/10 px-3 py-2 text-base text-down">
            <span className="font-semibold">最近错误：</span> <span className="num">{trader.lastError}</span>
          </div>
        )}

        {/* B. 指标行 + 一行次要事实（§3 的第 2 项） --------------------- */}
        {metricCards}
        {secondaryFacts}

        {/*
          C. 交易所账户（共享钱包）。

          它仍然**不改口径、不并进归属权益**：这是一个**共用钱包** —— 同一账户下所有
          机器人读数是同一个数 —— 而主栏上面的指标只放归属这个机器人的数字。

          位置从"骨架外面横跨整页"移到了主栏内部（右栏现在是决策流）。视觉上的区分
          没有变：它有自己的分组标题、上下边线，底色也和指标卡不同，所以扫一眼就知道
          这是另一组、另一个归属的数字。以前它无标题地贴在归属权益下面，于是一个从未
          成交的机器人看起来也"有余额"。
        */}
        <TraderAccountStrip
          account={accountState}
          asset={settleAsset}
          busy={accountQuery.loading}
          error={accountQuery.error}
          onRefresh={accountQuery.reload}
          /*
            实时读数拿不到时（机器人没在跑），回落到最近一条快照里的交易所读数 ——
            见 `lastKnownAccount` 上的说明。它让这一行与上面的「归属权益」能当面对照，
            而**不改变任何口径**：数字来自交易所，只是时间旧一点，且会标出来。
          */
          lastKnown={lastKnownAccount}
        />

        {/* D. 权益 / 行情（§3 的第 3 项：最大的一块，但只在有数据可看时才占大块） */}
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
                数据太薄时压成一行（`LAYOUT.md` §3：图表只在有数据可看时才占大块）。
                **不是把曲线藏起来**：这条序列本身仍然画在这里，只是 36px 高、
                不要坐标轴 —— 一条平线本来就不需要 220px。"展开"始终在工具栏上，
                所以没有任何数据是拿不到的。
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
            <CandlesPanel symbol={chartSymbol} />
          )}
        </Panel>

      </PageShell>
      </div>

      {/*
        E. 表格：参考材料，不是盯盘对象。

        放在**两栏之外、占满整宽** —— 成交表 11 列需要约 1200px，而两栏里的主栏
        只有 60%（1440px 视口下约 807px），放进去就永远要左右拖动。

        这里**不再传 `refreshToken`**。那个令牌原来只服务于「对账」按钮：按一下就在
        本地把它加一，逼三张表立刻重取，省下等下一次轮询的十几秒。按钮删掉之后令牌
        就没有生产者了。表格各自照常轮询 —— 持仓 5 秒、委托与成交各 15 秒（见
        `TraderTables` 里的 `usePolled`），推送在线时还会被 WebSocket 的快照覆盖，
        所以刷新路径没有丢，只是回到"它自己会更新"。
      */}
      {/*
        表格区**不再无约束地长高**。

        原来它没有任何高度约束，内容多高它就多高 —— 而上面那块是 `flex-1`，
        **于是被挤到几乎看不见**。用户的描述很准确：「这一块会挡住页面大部分，
        需要手动点当前持仓才能缩小」。

        表格内部本来就有 `max-h-[34vh] overflow-y-auto`（见 `TraderTables`），
        所以这里只需给外层一个上限，让整块（标签栏 + 表体 + 净额桥）
        不超视口的四成半 —— **上面那两块（指标卡与图表）才是盯盘要看的东西。**
      */}
      <div className="max-h-[46vh] space-y-4 overflow-y-auto">
        <TraderTables
          traderId={traderId}
          tab={tableTab}
          onChange={setTableTab}
          positionCount={openPositionCount}
          openOrderCount={openOrders.length}
          onSelectSymbol={setPickedSymbol}
          positionSymbols={positions.map((p) => p.symbol)}
          /*
           * 手工平仓成功后**立刻重取持仓并写进 store**。
           *
           * 不能只靠 WebSocket 推送：用户实测过「平仓提示成功、持仓里还显示着」——
           * 于是他会以为没平掉、再按一次。
           * **操作员按下平仓之后的界面状态，不能依赖推送的到达时间。**
           */
          onPositionsChanged={() => {
            void api
              .traderPositions(traderId)
              .then((rows) => setLivePositions(traderId, rows))
              .catch(() => undefined);
            // 图表盯着的那个币种可能已经被平掉了 —— 回到"跟随持仓"。
            setPickedSymbol(undefined);
          }}
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
 * - 保证金 / 名义 / 杠杆与模型、策略（"它是否在用钱、用的是什么"）留在指标行下面的
 *   那一行小字里，常驻可见；
 * - **周期编号、间隔、最近周期、创建于、起始权益**这些创建时就定下来、之后不再变的
 *   值收在这里，点一下展开。
 *
 * 收起态只留一个按钮 —— 它不占高度，也不会因为"没东西"而让页头看起来像坏了。
 */
function ConfigSummary({ trader, asset }: { trader: TraderRow; asset: string }) {
  /*
   * **直接摊平，不再做折叠。**
   *
   * 原来它默认收起、点一下才展开。但收起时按钮上已经显示「周期 #N · 每 3m」——
   * 也就是说**收起状态本身就占一行**，展开再占一行。**两行换一行信息，纯亏。**
   *
   * 这一块总共只有一行内容。摊平之后省掉一次点击，也省掉那一行按钮，
   * 上下空间反而更省。
   */
  return (
    <div className="num -mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-lo">
      <span title="该机器人已完成的决策周期数（跨重启连续编号）。">
        周期编号 <span className="text-ink-mid">#{fmtInt(trader.lastCycleNumber)}</span>
      </span>
      <span
        title={
          trader.mode === 'ai_managed'
            ? /*
               * ⚠️ 这一段曾经说的是反话，改回来过一次 —— 值得记下来。
               *
               * **先前**：AI 改不到决策周期（它是 `traders` 表上的一列、
               * 不在 `StrategyConfig` 里；而且调度器用 `setInterval`，
               * 启动时读一次就固定住）。那时如实标注「（固定）」。
               *
               * **现在**：两件事都补上了 ——
               *   · AI 有 `set_cycle_interval` 工具，能直接改这一列
               *   · 调度器换成**自续期的 `setTimeout` 链**，每轮重新读当前值，
               *     所以改完**下一轮就生效**，不需要重启
               *
               * 于是这个标注必须跟着改。**上一版的「（固定）」现在是假话** ——
               * 而一个说"AI 改不到"、实际它随时会改的标签，
               * 和不标注一样有害：操作员会基于错的前提去解读周期变化。
               */
              '决策间隔由 AI 自己决定，它可以在每轮决策时调整（1–1440 分钟），改完下一轮即生效。'
            : '该机器人每多久跑一次决策周期。'
        }
      >
        间隔{' '}
        <span className="text-ink-mid">
          每 {trader.cycleIntervalMinutes} 分钟
          {trader.mode === 'ai_managed' && <span className="text-ink-faint">（AI 可调）</span>}
        </span>
      </span>
      <span>
        最近周期 <span className="text-ink-mid">{timeAgo(trader.lastCycleAt)}</span>
      </span>
      {/*
        起始权益曾挂在指标行的「归属权益」下面。指标行改成 4 张卡之后，那一行
        放不下两个数（`Metric` 的 sub 会截断），而它本身是**创建时读到的钱包余额**、
        之后不再变化 —— 属于配置，不属于盯盘指标，所以留在这里。
      */}
      <span title="创建该机器人时从交易所读取的钱包余额，是总收益率与盈亏的计算基准。">
        起始权益 <span className="text-ink-mid">{fmtAsset(trader.initialEquity, asset, 4)}</span>
      </span>
      <span>
        创建于 <span className="text-ink-mid">{fmtDateTime(trader.createdAt)}</span>
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  指标卡                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 指标行里的一格。
 *
 * 为什么要有这层壳：`Metric` 是**指标**（标签 + 数值 + 说明），本身没有底色。
 * 从竖排指标栏改成横排之后，需要一层卡片边界才能一眼看出"这是 4 个并列的数字"，
 * 否则它们只是浮在页面底色上的四段文字（`LAYOUT.md` §0 规则 3 要的就是卡片）。
 *
 * 卡片不设固定高度，网格上也加了 `items-start`：每张卡只占自己内容的高度
 * （§6 —— 不写就会被 Grid 拉成等高，短的那个下面留一片空白）。
 */
function MetricCard({ children }: { children: ReactNode }) {
  return <div className="min-w-0 rounded-lg border border-base-750 bg-base-900 px-3.5 py-3">{children}</div>;
}

/* -------------------------------------------------------------------------- */
/*  Chart helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 数据太薄时的紧凑权益条。
 *
 * 为什么是"画出来"而不是"藏起来"：曲线讲的是形状，而这里要回答的正是
 * "为什么没有形状"。一条 36px 的缩略线把这件事一次说完 —— 走平就是走平，
 * 两个点就是两个点，不需要 220px 的坐标轴来证明（`LAYOUT.md` §3）。
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
 * 只讲**这一段窗口里涨跌了多少**：当前归属权益本身已经常驻在上面那张指标卡里，
 * 在这里再放一个 `text-3xl` 会让同一个数字在一屏里出现两次，而且都比别的东西显眼
 * （DESIGN.md §4 "不要把所有东西做成一样大"）。
 *
 * 这里**不再显示快照条数**：快照数量是内部指标（`LAYOUT.md` §5 点名的那一类），
 * 正常运行时它既不是状态、也没有后果 —— 曲线上有多少个点，看曲线本身就知道。
 * 真正需要解释"为什么这条曲线这么稀"的时候（快照太少、或一条平线被收成一行），
 * 说明就在 `EquityMiniStrip` 的 `note` 里，那里是**带结论**的一句话。
 */
function EquityWindowLine({
  equity,
  delta,
  percent,
  asset,
}: {
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
      {/* `equity` 只用来兜底没有快照时的比较基准，与图表内部口径一致；
          它是给屏幕阅读器的，不占视觉位置。 */}
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
