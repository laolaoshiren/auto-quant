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
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { EquitySnapshot, TraderMode, TraderStatus } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { MODE_HINT, PAGE_LABEL, isPaperView } from '../lib/glossary';
import { useApp, useEvents } from '../lib/store';
import { useSummaries } from '../lib/summaries';
import {
  accountEquityContributor,
  attributedEquityOf,
  fleetTotals,
  paperEquityContributor,
  realizedPnlOf,
} from '../lib/fleetTotals';
import { pairEquityByTrader } from '../lib/equityPairing';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { Button, ErrorNote, Panel, Spinner3, cn } from '../components/ui';
import { SectionHeading } from '../components/Badges';
import { ModeBadge } from '../components/TeamRoster';
import { Metric, MetricGroup, PageShell, SectionLabel } from '../components/shell';
import { NewTraderModal } from '../components/TraderModals';
import { ConfirmStopTrader } from '../components/ConfirmStopTrader';
import { EQUITY_RANGES, mergeEquityCurves, rangeSpanMs, type EquityRange } from '../components/equityCurve';
import {
  EquitySkeleton,
  TradersSnapshotTable,
  useRecentTrades,
} from './overviewParts';
import {
  BALANCE_LABEL,
  fmtAsset,
  fmtClockOffset,
  fmtInt,
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
  useDocumentTitle(PAGE_LABEL.overview);
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

  /*
   * 统一用 `isPaperView()` 三级回落（运行时 → 持久化 `trader.dryRun` → 进程级 `system.dryRun`），
   * 避免模拟盘停机后 `stats.dryRun === null` 被当成实盘，既污染账户统计又把模拟盈亏清零。
   */
  const dryRunById: Record<number, boolean> = Object.fromEntries(
    traders.map((t) => [
      t.id,
      isPaperView({
        runtimeDryRun: statsMap[t.id]?.dryRun,
        persistedDryRun: t.dryRun,
        processDryRun: system?.dryRun,
      }),
    ]),
  );
  const dryRunOf = (id: number): boolean | null | undefined => dryRunById[id];

  const runningCount = traders.filter((t) => {
    const liveStatusNow = liveByTrader[t.id]?.status;
    return liveStatusNow ? liveStatusNow === 'running' || liveStatusNow === 'safe_mode' : t.isRunning;
  }).length;

  /** 舰队合计（账户口径与模拟盘口径分开算，见 `lib/fleetTotals.ts`）。 */
  const fleet = fleetTotals({
    traders,
    stats: statsMap,
    snapshots: equitySnapshots,
    /* ⚠️ 模拟盘不校准（exchangeNet 恒为 0）且不混入实盘账户分组。 */
    dryRun: dryRunById,
  });

  /** 全舰队都是模拟盘（没有实盘账户）时，总览展示模拟盘合计与模拟曲线，而不是全 0。 */
  const paperOnlyFleet = fleet.accounts.length === 0 && fleet.paper.traderCount > 0;

  const merged = mergeEquityCurves([
    paperOnlyFleet
      ? paperEquityContributor(traders, equitySnapshots, dryRunById)
      : accountEquityContributor(traders, equitySnapshots, dryRunById),
  ]);
  const firstReading = merged.findIndex((point) => point.equity > 0);
  const curve = firstReading === -1 ? [] : merged.slice(firstReading);

  const equityOf = (trader: TraderRow): number =>
    attributedEquityOf(trader, statsMap[trader.id], dryRunOf(trader.id));

  const realizedOf = (trader: TraderRow): number =>
    realizedPnlOf(trader, statsMap[trader.id], dryRunOf(trader.id));

  const accountEquity = paperOnlyFleet ? fleet.paper.equity : fleet.accountEquityFleet;
  const committedCapital = paperOnlyFleet ? fleet.paper.capital : fleet.committedCapitalFleet;
  const totalReturnPercent = paperOnlyFleet ? fleet.paper.returnPercent : fleet.accountReturnPercent;
  const totalOpen = paperOnlyFleet ? fleet.paper.openPositions : fleet.openPositionsFleet;
  const unrealized = paperOnlyFleet ? fleet.paper.unrealizedPnl : fleet.unrealizedPnlFleet;
  const realizedPnl = paperOnlyFleet ? fleet.paper.realizedPnl : fleet.realizedPnlFleet;
  const withStats = paperOnlyFleet ? fleet.paper.tradersWithStats : fleet.tradersWithStats;
  const accountCount = fleet.accounts.length;

  const totalWins = paperOnlyFleet ? fleet.paper.wins : fleet.winsFleet;
  const totalLosses = paperOnlyFleet ? fleet.paper.losses : fleet.lossesFleet;

  const RANGE_COPY: Record<EquityRange, { label: string; coveredSub: string; partialSub: string }> = {
    '1D': { label: '近 24 小时', coveredSub: '24 小时', partialSub: '自最早快照' },
    '7D': { label: '近 7 天', coveredSub: '7 天', partialSub: '自最早快照' },
    '1M': { label: '近 30 天', coveredSub: '30 天', partialSub: '自最早快照' },
    '3M': { label: '近 90 天', coveredSub: '90 天', partialSub: '自最早快照' },
    ALL: { label: '累计变化', coveredSub: '全部区间', partialSub: '全部区间' },
  };
  const selectedSpan = rangeSpanMs(range);
  const windowStartValue = (() => {
    if (!Number.isFinite(selectedSpan) || curve.length === 0) return curve[0]?.equity ?? null;
    const cutoff = Date.now() - selectedSpan;
    return curve.find((point) => point.t >= cutoff)?.equity ?? curve[0]?.equity ?? null;
  })();
  const equityChange = windowStartValue === null ? null : accountEquity - windowStartValue;
  const equityChangePercent =
    windowStartValue !== null && windowStartValue !== 0 && equityChange !== null
      ? (equityChange / Math.abs(windowStartValue)) * 100
      : null;
  /** 所选周期是否被快照完整覆盖（`ALL` 有点即覆盖；其余检查首点是否早于窗口起点 + 5m 容差）。 */
  const hasRangeCoverage =
    range === 'ALL'
      ? curve.length > 0
      : Number.isFinite(selectedSpan) &&
        curve.length > 0 &&
        (curve[0]?.t ?? Number.POSITIVE_INFINITY) <= Date.now() - selectedSpan + 5 * 60_000;
  const rangeCopy = RANGE_COPY[range];

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
      tradersQuery.reload();
      refreshSystem();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const startTimersRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const timers = startTimersRef.current;
    return () => {
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
    };
  }, []);

  /**
   * **启动 = 点击即启动**（用户 2026-11-10：「点启动以后直接就运行，而不是又弹一个框」）。
   *
   * 运行模式在创建时固定，启动入口（列表 / 详情 / 总览 / 命令面板）都是**点击即启动**、
   * 不再有弹窗；失败原因走行内 `actionError`。
   */
  const startNow = async (trader: TraderRow) => {
    setBusyId(trader.id);
    setActionError(null);
    try {
      const result = await api.startTrader(trader.id);
      const blocking = (result.preflight ?? []).filter((check) => !check.ok && check.blocking);
      if (!result.ok || blocking.length > 0) {
        setActionError(
          `「${trader.name}」未通过预检：` +
            (blocking.map((check) => check.name).join('、') || result.error || '启动被拒绝。'),
        );
      }
      tradersQuery.reload();
      refreshSystem();
      /* 异步启动（stopped → starting → running）：1.5 秒后再对齐一次（卸载时自动清理）。 */
      const timerId = window.setTimeout(() => {
        startTimersRef.current.delete(timerId);
        void tradersQuery.reload();
        refreshSystem();
      }, 1500);
      startTimersRef.current.add(timerId);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
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
    <div className="grid grid-cols-1 gap-4 rounded-lg border border-base-750 bg-base-900 p-3 sm:grid-cols-2 xl:grid-cols-1">
      <MetricGroup title={paperOnlyFleet ? '模拟盘' : '账户'} columns={2}>
        <Metric
          label={paperOnlyFleet ? '模拟权益合计' : `${BALANCE_LABEL.equity}合计`}
          size="lg"
          tone="strong"
          value={accountCount > 0 || paperOnlyFleet ? fmtAsset(accountEquity, 'USDT', 2) : '—'}
          sub={
            paperOnlyFleet
              ? `模拟盘口径 · ${fmtInt(fleet.paper.traderCount)} 台机器人`
              : accountCount > 0
                ? `按账户口径 · ${fmtInt(accountCount)} 个账户${fleet.paper.traderCount > 0 ? `（另 ${fmtInt(fleet.paper.traderCount)} 台模拟）` : ''}`
                : '还没有交易所账户'
          }
          title={
            paperOnlyFleet
              ? '当前仅有模拟盘机器人：此处为各模拟盘本地模拟权益之和（与真实钱包无关）。接入实盘账户后将自动切回实盘账户口径。'
              : `所有实盘交易所账户（共享钱包）的${BALANCE_LABEL.equity}之和 —— 每个账户只算一次，模拟盘不混入。各机器人自己挣了多少见下表「归属权益」列，单个账户的钱见「交易所」页。`
          }
        />

        <Metric
          label="累计净盈亏"
          tone={pnlTone(realizedPnl)}
          value={fmtUsdSigned(realizedPnl, 2)}
          sub={paperOnlyFleet ? '各模拟盘净额之和' : '各实盘机器人净额之和'}
          title="Σ(各机器人自己的已平仓净盈亏)，净 = 毛 − 手续费 − 资金费。它不含持仓浮盈。"
        />

        <Metric
          label={range === 'ALL' ? rangeCopy.label : hasRangeCoverage ? rangeCopy.label : '区间盈亏'}
          tone={equityChange === null ? 'default' : pnlTone(equityChange)}
          value={equityChange === null ? '—' : fmtUsdSigned(equityChange, 2)}
          sub={
            equityChangePercent === null
              ? '还没有权益快照'
              : `${hasRangeCoverage ? rangeCopy.coveredSub : rangeCopy.partialSub} · ${fmtPercent(equityChangePercent)}`
          }
          title="所选时间窗口内的权益变化，含已实现与浮动盈亏。快照不足所选窗口时显示自最早一条快照以来的变化（自然日的「今日盈亏」在机器人详情页）。"
        />

        <Metric
          label={paperOnlyFleet ? '总收益率（模拟口径）' : '总收益率（账户口径）'}
          tone={committedCapital > 0 ? pnlTone(totalReturnPercent) : 'default'}
          value={committedCapital > 0 ? fmtPercent(totalReturnPercent) : '—'}
          sub={`${paperOnlyFleet ? '模拟本金' : '初始投入'} ${fmtUsd(committedCapital, 2)}`}
          title={
            paperOnlyFleet
              ? '（模拟权益合计 − 模拟本金之和）÷ 模拟本金之和。'
              : '（实盘账户权益合计 − 账户起始资金）÷ 账户起始资金。本金按账户去重计算，模拟盘不混入。'
          }
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
          sub="未落袋"
          title="所有机器人自己的持仓的未实现盈亏合计（不是交易所账户的总浮盈 —— 账户的总浮盈在同一账户下的每个机器人身上都是同一个数）。它随时在变，且尚未计入已实现盈亏。"
        />
        <Metric
          label="平仓记录"
          value={withStats > 0 ? `${fmtInt(totalWins)} 盈 / ${fmtInt(totalLosses)} 亏` : '—'}
          sub="按各机器人统计求和"
          title="已平仓的盈利笔数与亏损笔数之和（真实计数）。账户级胜率不在这里换算 —— 各机器人自己的胜率见下表与机器人页。"
        />
      </MetricGroup>

      {/*
        **运行环境** —— 原来是页面底部一整块面板（178px 高，而且把页脚推到了
        视口下面；用户 2026-11-10：「多余还有导致 UI BUG」）。它只是诊断信息，
        收进右栏底部一小段即可：模式 / 可交易对 / 推送；内部诊断值
        （时钟、权重）仍然只在越界时多一行，带后果。

        ⚠️ 这里**不再显示「环境」**：`environmentLabel` 自己就带「…（实盘）」
        /「…模拟盘」后缀，与紧挨着的「模式」说的是同一件事 —— 同一行里出现
        两次「模拟」，是用户点名要删的那类重复。
      */}
      <div className="border-t border-base-750 pt-2">
        <dl className="num flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <div className="flex items-baseline gap-1">
            <dt className="text-ink-faint">模式</dt>
            <dd className={system?.dryRun ? 'text-accent' : 'text-warn'}>
              {system ? (system.dryRun ? '模拟盘' : '实盘资金') : '—'}
            </dd>
          </div>
          <div className="flex items-baseline gap-1">
            <dt className="text-ink-faint">可交易对</dt>
            <dd className="text-ink-mid">{fmtInt(system?.tradableSymbols)}</dd>
          </div>
          <div className="flex items-baseline gap-1">
            <dt className="text-ink-faint">推送</dt>
            <dd className={socketOpen ? 'text-up' : 'text-warn'}>{socketOpen ? '实时' : '轮询'}</dd>
          </div>
        </dl>
        {clockWarn && (
          <p className="mt-1 text-xs text-warn">
            ⚠ 时钟偏差 {fmtClockOffset(system?.clockOffsetMs)} —— 签名请求会被拒（-1021）
          </p>
        )}
        {weightWarn && (
          <p className="mt-1 text-xs text-warn">⚠ API 权重 {weightPercent}% —— 继续升高会被封 IP（418）</p>
        )}
        {system?.tradingDisabled && (
          <p className="mt-1 text-xs text-down">全局交易已禁用：启动请求会被拒绝（503），平仓与对账仍可用。</p>
        )}
        {!system && <p className="mt-1 text-xs text-ink-faint">正在读取系统状态…</p>}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <ErrorNote>{actionError}</ErrorNote>

      {/* ------------------------------------------------------------------ */}
      {/*  页头：与其它页同一套骨架（ui-spec §1）                              */}
      {/* ------------------------------------------------------------------ */}
      {/*
        **`SectionHeading`：20px 标题 + 紧跟标题的动作 + 12px 说明另起一行。**

        原来这里只有「更新于 刚刚」+ 一个孤立按钮 —— 它既不是标题、也不在
        标题旁边（用户 2026-11-10：「别单独搞那么最右边…也会造成大量空白」）。
        现在与「机器人」「策略工作室」两页逐字同构：标题 → 主操作 → 说明。

        说明行写**自动刷新**而不是放一个刷新按钮：ui-spec §5 要求默认自动刷新。
      */}
      <SectionHeading
        title={PAGE_LABEL.overview}
        right={
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            新建机器人
          </Button>
        }
        sub={
          <>
            数据自动刷新（推送在线时实时）· 更新于{' '}
            {timeAgo(tradersQuery.updatedAt ? new Date(tradersQuery.updatedAt).toISOString() : null)}
          </>
        }
      />

      <PageShell aside={rail} fillHeight={false}>
        <ModeBreakdown traders={traders} />

        {/* ---------------------------------------------------------------- */}
        {/*  1. 资金曲线 —— 有形状才展开成图表（§4）                          */}
        {/* ---------------------------------------------------------------- */}
        <section aria-labelledby="overview-equity">
          <SectionLabel
            title={paperOnlyFleet ? '模拟权益曲线' : `${BALANCE_LABEL.equity}曲线`}
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
             * 缩略线"。理由本身没错（§4：不要拿三分之一屏去画一条直线），
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
                  primaryLabel={paperOnlyFleet ? '模拟权益' : BALANCE_LABEL.equity}
                />
              </Suspense>
            </Panel>
          )}
        </section>

        {/* ---------------------------------------------------------------- */}
        {/*  2. 机器人明细                                                     */}
        {/* ---------------------------------------------------------------- */}
        <section aria-labelledby="overview-traders">
          {/*
            ⚠️ **这里不再有「全部机器人」按钮**（原来挂在 `SectionLabel` 的
            `actions` 槽里，也就是被推到整页最右端）：
              · 左侧导航第一项就是「机器人」，它的功能与这个链接完全重复；
              · 表格下面在行数超限时本来就有「在「机器人」中查看全部 N 个」。
            用户 2026-11-10：「别单独搞那么最右边…也会造成大量空白」。
          */}
          <SectionLabel
            title="机器人"
            count={`${fmtInt(traders.length)} 个 · ${fmtInt(runningCount)} 运行中`}
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
            /* 空状态：一行说明 + 主操作，不画大盒子（ui-spec §1）。 */
            <div className="py-2">
              <p className="text-base text-ink-lo">还没有机器人。</p>
              <p className="mt-1 text-xs text-ink-faint">
                创建后默认以「模拟」运行：不需要交易所密钥、不下真实订单，可以先看几轮决策再决定是否切到实盘。
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={() => setNewOpen(true)}>
                  新建机器人
                </Button>
                <Link to="/exchanges" className="btn btn-ghost">
                  先去配置交易所
                </Link>
              </div>
            </div>
          ) : (
            <TradersSnapshotTable
              traders={snapshotRows}
              statsMap={statsMap}
              liveStatus={liveStatus}
              fleet={fleet}
              equityOf={equityOf}
              realizedOf={realizedOf}
              recentTrades={recentTrades}
              busyId={busyId}
              navigate={navigate}
              onStop={setStopTarget}
              onStart={(trader) => void startNow(trader)}
              extraCount={traders.length - snapshotRows.length}
            />
          )}

          {!listFailed && tradersQuery.error && (
            <ErrorNote className="mt-2">最近一次刷新失败，下面是上一次的数据：{tradersQuery.error}</ErrorNote>
          )}
          {/*
           * 机器人统计的加载提示不再常驻（理由见页头那段）：轮询每几秒一次，
           * 这行文字会让页面看起来一直在忙。缺统计的行本身显示 `—`。
           */}
        </section>
      </PageShell>


      <NewTraderModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => {
          setNewOpen(false);
          void tradersQuery.reload();
          refreshSystem();
          /* 创建后不自动启动（用户 2026-11-10：创建-运行不能混在一起）。 */
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
 * **运行模式分布** —— 一行紧凑统计，不再是大卡片（2026-11-10 用户反馈）。
 *
 * ## 为什么是"一行统计"而不是"四张说明卡"
 *
 * 用户的原话是「**重新设计 UI/UX，简单实用**」。改造前的四张卡片每张塞：
 * 模式名 + 数量 + 一句解释 + 全部机器人名字 —— 占了首屏一半高度，
 * 而信息量只有"每个模式有几台"。首屏该先回答的是「钱怎么样、谁在跑、
 * 最近发生了什么」，不是"模式说明"。
 *
 * ## 这一版的改动（2026-11-10 重设计）
 *
 * 1. **模式名改用 `ModeBadge`** —— 与机器人列表、详情页页头**同一个组件、
 *    同一套颜色**（团队=蓝 / 托管=绿 / 固定策略=灰 / JEV=黄）。原来这里自己
 *    画了"圆点 + 文字"，颜色与列表页对不上，同一个模式在两个页面长得不一样。
 * 2. **不再截断**：原来用的是 `MODE_LABEL.jev`（「JEV 模式（实验性）」），
 *    四等分之后被截成「JEV 模式（实…」；`ModeBadge` 的短名「JEV 实验」放得下。
 * 3. **去掉解释文字的占位**：解释进 `title`，行内只留「数量 + 运行中」。
 *
 * ## 仍然列出全部四种模式
 *
 * `mode='jev'` 曾经漏列（2026-10-19 用户报"显示不对"）：不在任何分组里的机器人
 * 会让总览看起来"少了一台"，而它其实在跑。所以数量为 0 的模式也占一格（灰掉）。
 */
function ModeBreakdown({ traders }: { traders: TraderRow[] }): React.ReactElement {
  /*
   * ⚠️ **这里必须列出每一种 TraderMode**。名字与颜色登记在
   * `components/TeamRoster.tsx` 的 `MODE_BADGE`，这里不许再写字面量。
   */
  const groups: Array<{ mode: TraderMode; hint: string }> = [
    { mode: 'strategy', hint: MODE_HINT.strategy },
    { mode: 'ai_managed', hint: MODE_HINT.ai_managed },
    { mode: 'ai_team', hint: MODE_HINT.ai_team },
    { mode: 'jev', hint: MODE_HINT.jev },
  ];

  return (
    <section aria-labelledby="overview-modes">
      <h2 id="overview-modes" className="sr-only">
        运行模式分布
      </h2>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {groups.map((g) => {
          const mine = traders.filter((t) => t.mode === g.mode);
          const running = mine.filter((t) => t.isRunning).length;
          const empty = mine.length === 0;
          return (
            <Link
              key={g.mode}
              to="/traders"
              title={`${g.hint}（点这里查看机器人列表）`}
              className={cn(
                'flex min-w-0 items-center gap-2 rounded-lg border px-2 py-2 transition',
                empty ? 'border-base-800 bg-base-900/40' : 'border-base-750 bg-base-900 hover:border-base-600',
              )}
            >
              <ModeBadge mode={g.mode} />
              <span className={cn('num text-base font-semibold', empty ? 'text-ink-faint' : 'text-ink-hi')}>
                {mine.length} 台
              </span>
              <span
                className={cn(
                  'num ml-auto truncate text-xs',
                  running > 0 ? 'text-up' : 'text-ink-faint',
                )}
              >
                {running > 0 ? `${running} 运行` : '未运行'}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}