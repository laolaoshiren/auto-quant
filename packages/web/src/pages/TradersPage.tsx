import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { ModeBadge } from '../components/TeamRoster';
import { ManagedRiskBadge } from '../components/ManagedRiskProfileControl';
import { Link, useNavigate } from 'react-router-dom';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  Activity,
  ArrowUpRight,
  CircleStop,
  Layers,
  LayoutGrid,
  List,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import type { EquitySnapshot, TraderStatus } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { isPaperView } from '../lib/glossary';
import { useApp, useEvents } from '../lib/store';
import { useSummaries, type TraderSummary } from '../lib/summaries';
import { attributedEquityOf, fleetTotals, isLedgerSuspect, realizedPnlOf } from '../lib/fleetTotals';
import { pairEquityByTrader } from '../lib/equityPairing';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { Button, ErrorNote, Modal, Spinner3, cn } from '../components/ui';
import { SectionHeading, TraderStatusBadge } from '../components/Badges';
import { MoneyBadge } from './overviewParts';
import { TraderAvatar } from '../components/TraderAvatar';
import { ExchangeAccountChip, accountOf } from '../components/ExchangeAccountChip';
import { NewTraderModal } from '../components/TraderModals';
import { TraderConfigModal } from '../components/TraderConfigModal';
import { NET_PNL_FORMULA, PnlBreakdown, pnlFormulaText, statsCosts, type PnlCosts } from '../components/PnlBreakdown';
import {
  fmtDrawdownPercent,
  fmtDuration,
  fmtInt,
  fmtPercent,
  fmtProfitFactor,
  fmtUsd,
  fmtUsdSigned,
  pnlColor,
  timeAgo,
} from '../lib/format';

/**
 * Rows rendered in the fleet console.
 */
const MAX_ROWS = 100;

/** 乐观「启动中」状态的最长兜底时长（30 秒），防止后端静默回落时按钮永久卡死。 */
const OPTIMISTIC_START_TIMEOUT_MS = 30_000;

type TradersViewMode = 'cards' | 'list';
type TradersStatusFilter = 'all' | 'running' | 'stopped';
const VIEW_STORAGE_KEY = 'aq.traders.view';

function loadSavedViewMode(): TradersViewMode {
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw === 'list' || raw === 'cards') return raw;
  } catch {
    // ignore storage errors
  }
  return 'cards';
}

/** Which destructive action a confirmation dialog is currently guarding. */
type PendingAction = { kind: 'stop' | 'delete'; trader: TraderRow } | null;

/**
 * 机器人舰队控制台。
 *
 * 自然文档流布局（不再套 `page-fill` 空撑整屏导致下半屏出现大块空洞）；
 * 默认采用高信息密度的「舰队指挥卡」视图（含实时权益迷你曲线、核心财务指标、
 * 5 格运行遥测与一键进入面板/启停操作），同时提供「精简列表」切换满足多机对比需求。
 */
export function TradersPage() {
  useDocumentTitle('机器人');
  const navigate = useNavigate();
  const system = useApp((s) => s.system);
  const setTraders = useApp((s) => s.setTraders);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const socketOpen = useEvents((s) => s.status) === 'open';
  const liveByTrader = useEvents((s) => s.byTrader);

  const tradersQuery = usePolled((signal) => api.traders(signal), {
    intervalMs: socketOpen ? 8000 : 4000,
  });
  const traders = useMemo(() => tradersQuery.data ?? [], [tradersQuery.data]);
  const reloadTraders = tradersQuery.reload;
  /*
   * 用户 2026-11-11：「列表页要能清楚看到机器人使用的是什么交易所什么钱包
   * （有测试网的也要清楚看到）」。账户信息单独拉一份（慢轮询：它几乎不变）。
   */
  const exchangeAccountsQuery = usePolled((signal) => api.exchangeAccounts(signal), { intervalMs: 20_000 });

  const statsMap = useSummaries((s) => s.stats);
  /*
   * ⚠️ **`errors` 必须有人消费**（2026-10-17 · 台账 FRD-01 验收 ③）。
   *
   * `useSummaries.fetchOne` 失败时一直只写 `errors[id]`，而**全仓没有一处读它** ——
   * 那意味着"这台机器人的统计读不到"这件事在界面上完全不存在：列表里那一行的
   * 权益/收益率停在最后一次成功的值上，看起来和"刚更新过"一模一样。
   *
   * 现在它在这里消费（列表是"一眼看全舰队"的地方，陈旧读数必须能一眼看出）。
   */
  const summaryErrors = useSummaries((s) => s.errors);
  const refreshMany = useSummaries((s) => s.refreshMany);

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️ **必须把快照喂给 `fleetTotals`，否则它只能"取最大值"兜底**
   *      （2026-10-14 自查发现我上一轮修得不完整）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 上一轮我把手算的 `.find()` 换成 `fleetTotals({ traders, stats })` ——
   * **但没传 `snapshots`**。而 `fleetTotals` 拿不到快照时会走这条兜底：
   * ```
   *   const fromStats = group.reduce((max, t) => Math.max(max, stats[t.id]?.accountEquity ?? 0), 0);
   * ```
   * 「取组内最大值」在**账户亏损时会把旧的高点当成当前的钱** ——
   * 正是 `latestAccountReading()` 的注释里点明要避免的那种错。
   *
   * 所以这里照搬 `OverviewPage` 的成熟做法（它一直是传快照的）：
   * 两个来源合并 —— REST 的 `traderEquity` + socket 推来的新点。
   *
   * ⚠️ 间隔用 60 秒（不是 `traders` 的 4–8 秒）：快照只在**决策周期结束时**
   * 写一次（分钟级），按列表的节奏轮询等于每个机器人都多花几倍请求去重画同一条线。
   */
  const equityQuery = usePolled<Record<number, EquitySnapshot[]>>(
    async (signal) => {
      const ids = traders.map((t) => t.id);
      const pairs = await Promise.all(
        ids.map(async (id) => ({ id, rows: await api.traderEquity(id, 360, signal) })),
      );
      return pairEquityByTrader(pairs);
    },
    { intervalMs: 60_000, enabled: traders.length > 0, deps: [traders.map((t) => t.id).join(',')] },
  );
  const equitySnapshots: Record<number, EquitySnapshot[]> = {};
  for (const trader of traders) {
    equitySnapshots[trader.id] = [
      ...(equityQuery.data?.[trader.id] ?? []),
      ...(liveByTrader[trader.id]?.equity ?? []),
    ];
  }

  const [newOpen, setNewOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TraderRow | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  /**
   * **点了"启动"之后、服务端确认 running 之前的本地乐观状态**。
   *
   * 用户 2026-11-10：「点机器以后，按钮应该马上实时反馈状态（让用户知道是什么状态、
   * 是否在启动中），防误触、防歧义得做好」。
   *
   * 启动是异步的（`POST /start` 返回 200 后服务端才 stopped → starting → running，
   * 预检/建连接/对账常要 2–10 秒）。这期间按钮若还显示可点的「启动」，操作员会
   * 以为没点上、再点一次（服务端会拒，但界面看起来像没反应）。
   * 所以点击的一瞬间就把这一行标记为"启动中"，并轮询到服务端给出结论。
   */
  const [optimisticStarting, setOptimisticStarting] = useState<
    ReadonlyMap<number, { startedAt: number; sawStarting: boolean }>
  >(() => new Map());
  const [actionError, setActionError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<TradersViewMode>(() => loadSavedViewMode());
  const [statusFilter, setStatusFilter] = useState<TradersStatusFilter>('all');

  const updateViewMode = (mode: TradersViewMode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, mode);
    } catch {
      // ignore storage errors
    }
  };

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

  /**
   * Run whichever confirmed action the dialog was opened for.
   *
   * The dialog stays open while the request is in flight: closing it first would
   * leave the operator with no feedback on an action that stops a loop trading
   * real money, and a failure would then have nowhere to report itself.
   */
  const runPending = async () => {
    if (!pending) return;
    const { kind, trader } = pending;
    setBusyId(trader.id);
    setActionError(null);
    try {
      if (kind === 'stop') await api.stopTrader(trader.id);
      else await api.deleteTrader(trader.id);
      tradersQuery.reload();
      refreshSystem();
      setPending(null);
    } catch (err) {
      setActionError((err as Error).message);
      setPending(null);
    } finally {
      setBusyId(null);
    }
  };

  /**
   * **启动 = 点击即启动 + 立刻反馈"启动中"**（用户 2026-11-10）。
   *
   * 两件事必须同时做到：
   *  ① 点击后**立刻**把这一行切成"启动中"（不可再点）—— 防误触、防歧义；
   *  ② 轮询到服务端给出结论（running / error / safe_mode）才交回真实状态。
   *
   * 启动是异步的（`stopped → starting → running`），预检/建连接/对账常要 2–10 秒；
   * 只靠一次 reload 会在中间显示回「启动」，操作员会以为没点上、再点一次。
   */
  const startNow = async (trader: TraderRow) => {
    if (optimisticStarting.has(trader.id)) return; /* 防重复点击 */
    setOptimisticStarting((prev) => {
      const next = new Map(prev);
      next.set(trader.id, { startedAt: Date.now(), sawStarting: false });
      return next;
    });
    setBusyId(trader.id);
    setActionError(null);
    const clearOptimistic = () =>
      setOptimisticStarting((prev) => {
        if (!prev.has(trader.id)) return prev;
        const next = new Map(prev);
        next.delete(trader.id);
        return next;
      });
    try {
      const result = await api.startTrader(trader.id);
      const blocking = (result.preflight ?? []).filter((check) => !check.ok && check.blocking);
      if (!result.ok || blocking.length > 0) {
        clearOptimistic();
        setActionError(
          `「${trader.name}」未通过预检：` +
            (blocking.map((check) => check.name).join('、') || result.error || '启动被拒绝。'),
        );
      }
      reloadTraders();
      refreshSystem();
    } catch (err) {
      clearOptimistic();
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  /*
   * 启动中的行：每 2 秒刷一次列表，直到服务端给出明确结论。
   * 仅依赖布尔值与稳定的 `reloadTraders` 引用，避免每次重渲染重置 2 秒定时器。
   */
  const hasOptimisticStarting = optimisticStarting.size > 0;
  useEffect(() => {
    if (!hasOptimisticStarting) return;
    const timer = window.setInterval(() => void reloadTraders(), 2000);
    return () => window.clearInterval(timer);
  }, [hasOptimisticStarting, reloadTraders]);

  /*
   * 服务端状态已明确（running / error / safe_mode，或经历 starting 后回落到 stopped），
   * 或超过 30 秒超时兜底时自动清理乐观标记，防止按钮永久卡死在「启动中」。
   */
  useEffect(() => {
    if (optimisticStarting.size === 0) return;
    const now = Date.now();
    setOptimisticStarting((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [id, entry] of prev) {
        const row = traders.find((t) => t.id === id);
        if (!row) {
          next.delete(id);
          changed = true;
          continue;
        }
        const liveStatus = liveByTrader[id]?.status;
        const effectiveStatus: TraderStatus = liveStatus ?? row.status;
        if (effectiveStatus === 'starting' && !entry.sawStarting) {
          next.set(id, { ...entry, sawStarting: true });
          changed = true;
          continue;
        }
        const timedOut = now - entry.startedAt >= OPTIMISTIC_START_TIMEOUT_MS;
        const fellBackStopped = entry.sawStarting && effectiveStatus === 'stopped';
        if (
          row.isRunning ||
          effectiveStatus === 'running' ||
          effectiveStatus === 'error' ||
          effectiveStatus === 'safe_mode' ||
          fellBackStopped ||
          timedOut
        ) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    let soonestRemaining = Number.POSITIVE_INFINITY;
    for (const entry of optimisticStarting.values()) {
      const remaining = entry.startedAt + OPTIMISTIC_START_TIMEOUT_MS - now;
      if (remaining < soonestRemaining) soonestRemaining = remaining;
    }
    if (!Number.isFinite(soonestRemaining)) return;
    const timer = window.setTimeout(
      () => {
        const cutoff = Date.now() - OPTIMISTIC_START_TIMEOUT_MS;
        setOptimisticStarting((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const [id, entry] of prev) {
            if (entry.startedAt <= cutoff) {
              next.delete(id);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      Math.max(50, soonestRemaining),
    );
    return () => window.clearTimeout(timer);
  }, [traders, liveByTrader, optimisticStarting]);

  const runningCount = traders.filter((t) => {
    const liveStatus = liveByTrader[t.id]?.status;
    return liveStatus ? liveStatus === 'running' || liveStatus === 'safe_mode' : t.isRunning;
  }).length;

  /*
   * 统一用 `isPaperView()` 三级回落判断模拟盘（运行时 → 持久化 `trader.dryRun` → 进程级 `system.dryRun`），
   * 避免停机时 `stats.dryRun === null` 把模拟盘历史盈亏静默清零或混入实盘账户统计。
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

  const fleetTotal = fleetTotals({
    traders,
    stats: statsMap,
    snapshots: equitySnapshots,
    /*
     * ⚠️ `dryRun` 要传进来 —— 模拟盘上 exchangeNet 恒为 0，
     * 拿它校准会把正确的账本替换成 0（见 `isLedgerSuspect`）。
     */
    dryRun: dryRunById,
  });
  const totalEquity = fleetTotal.accountEquityFleet;
  const paperOnlyFleet = fleetTotal.accounts.length === 0 && fleetTotal.paper.traderCount > 0;
  /** 读数已过期的账户（机器人全停了 → 没有新快照）。见上面那个 Metric 的说明。 */
  const staleAccounts = fleetTotal.accounts.filter((a) => a.accountEquityStale);
  const dryRunOf = (id: number): boolean | null | undefined => dryRunById[id];

  const equityOf = (trader: TraderRow, stats: TraderSummary): number =>
    attributedEquityOf(trader, stats, dryRunOf(trader.id));

  const calibratedOf = (
    trader: TraderRow,
    stats: TraderSummary,
  ): { realizedPnl: number; returnPercent: number } => {
    const realizedPnl = realizedPnlOf(trader, stats, dryRunOf(trader.id));
    const returnPercent =
      trader.initialEquity > 0 ? (realizedPnl / trader.initialEquity) * 100 : 0;
    return { realizedPnl, returnPercent };
  };

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **顶部汇总也必须用同一套校准**（2026-10-14 用户报"只做一半"）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事实（线上）
   *
   * ```
   *   顶部「已实现盈亏」显示  +5.91（账本合计）
   *   交易所口径真实          -7.03
   *   → 差 12.9 USDT（显示盈利，实际亏损）
   * ```
   *
   * ## 为什么这里要用 `calibratedOf`
   *
   * 它是**逐机器人**的校准（与本页表格那一列、详情页「交易盈亏」同一个判据）——
   * 然后**求和**。这样：
   * ```
   *   顶部合计 = 各行之和（用户能自己加出来）
   *   与本页每一行、与详情页三处一致
   * ```
   * ⚠️ 直接对 `equityOf` 求和是**错的**（共享账户会把本金数多遍，见 `fleetTotals`）；
   * 而净已实现盈亏是可加的 —— 所以这一项可以求和。
   */
  const totalRealized = traders.reduce(
    (sum, trader) => {
      const s = statsMap[trader.id];
      return sum + (s ? calibratedOf(trader, s).realizedPnl : 0);
    },
    0,
  );
  const openPositions = traders.reduce((sum, trader) => sum + (statsMap[trader.id]?.openPositions ?? 0), 0);

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️ **账本不可信时，归属权益改用交易所校准值**（2026-10-14）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 用户的原话
   *
   * > 「和里面数据不一致为什么还没修复？……列表和详情要正确对齐数字，
   * >   别整无意义的垃圾数据」
   *
   * ## 事实（线上 `#10`）
   *
   * ```
   *   列表页「归属权益」  $104.89  ← 起始 100.05 + trades.net_pnl +4.84（账本推算）
   *   详情页「账户余额」  $92.34   ← 交易所真实读数
   *   差 12.56
   * ```
   * 差额的来源：`trades.net_pnl` **被对账重建写坏了** ——
   * 39 笔 `source='reconciled'` 的记录里 16 笔 `pnl=0`（本该有盈亏），合计虚高 9.13。
   *
   * ## 为什么必须在这里修，而不是加说明
   *
   * 我上一轮只是在指标卡加了一行「账目与交易所差 +12.55」—— **那是错的**。
   * 本项目反复记着同一条原则：
   * > **「把数字改对，比在说明里解释它为什么错要好。」**
   *
   * ## 判据与详情页**完全一致**（`TraderPage` 的 `realized = ledger.exchangeNet`）
   *
   * ```
   *   ledger.gap 超容差（≥ 0.01）→ 用交易所的成交流水（exchangeNet）为准
   *   否则                        → 用账本（它与交易所一致，没必要绕）
   * ```
   * ⚠️ **同一个判据写在两个页面**是有意的（而不是各自发明一套）：
   * 两个页面必须给出同一个数，而"同一个数"的唯一保证是**同一套判据**。
   * 阈值 0.01 与详情页的 `ledgerSuspect` 一字不差 —— 改一处必须改两处。
   */

  /*
   * Fleet-wide gross → net bridge.
   *
   * Only traders whose stats have actually loaded are counted — `known` keeps an
   * empty table from claiming a confident `毛 0 · 手续费 0`.
   */
  const fleet = traders.reduce<{ costs: PnlCosts; known: boolean }>(
    (acc, trader) => {
      const stats = statsMap[trader.id];
      if (!stats) return acc;
      const row = statsCosts(stats);
      return {
        known: true,
        costs: {
          gross: acc.costs.gross + row.gross,
          fees: acc.costs.fees + row.fees,
          funding: acc.costs.funding + row.funding,
          net: acc.costs.net + row.net,
        },
      };
    },
    { costs: { gross: 0, fees: 0, funding: 0, net: 0 }, known: false },
  );

  const isTraderLiveRunning = (trader: TraderRow): boolean => {
    const live = liveByTrader[trader.id];
    return live?.status !== null && live?.status !== undefined
      ? live.status === 'running' || live.status === 'safe_mode'
      : trader.isRunning;
  };

  const stoppedCount = Math.max(0, traders.length - runningCount);
  const filteredTraders = useMemo(() => {
    const checkRunning = (trader: TraderRow): boolean => {
      const live = liveByTrader[trader.id];
      return live?.status !== null && live?.status !== undefined
        ? live.status === 'running' || live.status === 'safe_mode'
        : trader.isRunning;
    };
    if (statusFilter === 'running') return traders.filter(checkRunning);
    if (statusFilter === 'stopped') return traders.filter((t) => !checkRunning(t));
    return traders;
  }, [traders, statusFilter, liveByTrader]);

  const shown = filteredTraders.slice(0, MAX_ROWS);

  const fleetEquityTooltip = paperOnlyFleet
    ? '当前仅有模拟盘机器人：此处为各模拟盘本地模拟权益之和（与真实钱包无关）。'
    : staleAccounts.length > 0
      ? `账户 ${staleAccounts.map((a) => `#${a.exchangeAccountId}`).join('、')} 下所有机器人当前均已停止，此处展示停机前的最近一次权益快照。`
      : '按实盘交易所账户合计的权益：同一账户下的多个机器人共用同一个钱包，只算一次；模拟盘不混入。每台机器人的「归属权益」是它自己的贡献。';

  return (
    <div className="page-pad flex w-full flex-col gap-4">
      <SectionHeading
        title="机器人"
        sub="管理所有模拟盘与实盘自动化交易实例，实时追踪归属权益、净盈亏与决策节拍。"
        right={
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            <Plus aria-hidden className="h-3.5 w-3.5" />
            新建机器人
          </Button>
        }
      />

      {/* 舰队汇总 KPI 卡片栏：4 张信息层级分明的概览卡片，窄屏 2 列、宽屏 4 列 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-base-750/90 bg-base-900/80 px-4 py-3">
          <div className="flex items-center justify-between gap-2 text-xs text-ink-faint">
            <span>运行状态</span>
            <Activity aria-hidden className={cn('h-3.5 w-3.5', runningCount > 0 ? 'text-up' : 'text-ink-faint')} />
          </div>
          <div className="num mt-1.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold tracking-tight text-ink-strong">{runningCount}</span>
            <span className="text-sm font-medium text-ink-faint">/ {traders.length}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-ink-faint">
            <span className={cn('inline-block h-1.5 w-1.5 rounded-full', runningCount > 0 ? 'bg-up' : 'bg-base-600')} />
            <span className="num">
              {runningCount} 运行中 · {stoppedCount} 已停止
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-base-750/90 bg-base-900/80 px-4 py-3">
          <div className="flex items-center justify-between gap-2 text-xs text-ink-faint">
            <span className="cursor-help" data-aq-tip={fleetEquityTooltip}>
              {paperOnlyFleet ? '模拟权益合计' : '账户权益合计'}
            </span>
            <Wallet aria-hidden className="h-3.5 w-3.5 text-ink-faint" />
          </div>
          <div className="num mt-1.5 text-2xl font-bold tracking-tight text-ink-strong">
            {fmtUsd(paperOnlyFleet ? fleetTotal.paper.equity : totalEquity, 2)}
          </div>
          <div className="num mt-1 truncate text-xs text-ink-faint">
            {paperOnlyFleet
              ? `模拟盘 · ${fmtInt(fleetTotal.paper.traderCount)} 台`
              : staleAccounts.length > 0
                ? `已停机 · 末次快照（${staleAccounts.length} 个账户）`
                : `按账户去重 · ${fmtInt(fleetTotal.accounts.length)} 个账户`}
          </div>
        </div>

        <div className="rounded-xl border border-base-750/90 bg-base-900/80 px-4 py-3">
          <div className="flex items-center justify-between gap-2 text-xs text-ink-faint">
            <span className="cursor-help" data-aq-tip={`${NET_PNL_FORMULA}。此处为所有机器人已平仓成交的净盈亏合计。`}>
              已实现净盈亏
            </span>
            <TrendingUp
              aria-hidden
              className={cn(
                'h-3.5 w-3.5',
                totalRealized > 0 ? 'text-up' : totalRealized < 0 ? 'text-down' : 'text-ink-faint',
              )}
            />
          </div>
          <div
            className={cn(
              'num mt-1.5 text-2xl font-bold tracking-tight',
              totalRealized > 0 ? 'text-up' : totalRealized < 0 ? 'text-down' : 'text-ink-strong',
            )}
          >
            {fmtUsdSigned(totalRealized, 2)}
          </div>
          <div className="mt-1 truncate text-xs text-ink-faint">
            {fleet.known ? <PnlBreakdown costs={fleet.costs} /> : '所有机器人合计'}
          </div>
        </div>

        <div className="rounded-xl border border-base-750/90 bg-base-900/80 px-4 py-3">
          <div className="flex items-center justify-between gap-2 text-xs text-ink-faint">
            <span>当前持仓</span>
            <Layers aria-hidden className={cn('h-3.5 w-3.5', openPositions > 0 ? 'text-accent' : 'text-ink-faint')} />
          </div>
          <div
            className={cn(
              'num mt-1.5 text-2xl font-bold tracking-tight',
              openPositions > 0 ? 'text-accent' : 'text-ink-strong',
            )}
          >
            {fmtInt(openPositions)}
          </div>
          <div className="mt-1 text-xs text-ink-faint">所有机器人的未平仓合约数</div>
        </div>
      </div>

      {actionError && <ErrorNote>{actionError}</ErrorNote>}

      {/* 工具条：状态筛选 + 卡片/列表视图切换 */}
      {traders.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            role="tablist"
            aria-label="机器人状态筛选"
            className="inline-flex items-center gap-0.5 rounded-lg border border-base-800 bg-base-900/70 p-0.5 text-xs"
          >
            {(
              [
                { id: 'all', label: '全部', count: traders.length },
                { id: 'running', label: '运行中', count: runningCount },
                { id: 'stopped', label: '已停止', count: stoppedCount },
              ] as const
            ).map((tab) => {
              const active = statusFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStatusFilter(tab.id)}
                  className={cn(
                    'num inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition',
                    active
                      ? 'bg-base-800 text-ink-hi shadow-sm'
                      : 'text-ink-faint hover:text-ink-mid',
                  )}
                >
                  <span>{tab.label}</span>
                  <span className={cn('text-[11px]', active ? 'text-ink-mid' : 'text-ink-faint/80')}>
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>

          <div
            role="group"
            aria-label="列表展示方式"
            className="inline-flex items-center gap-0.5 rounded-lg border border-base-800 bg-base-900/70 p-0.5 text-xs"
          >
            <button
              type="button"
              aria-pressed={viewMode === 'cards'}
              onClick={() => updateViewMode('cards')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition',
                viewMode === 'cards'
                  ? 'bg-base-800 text-ink-hi shadow-sm'
                  : 'text-ink-faint hover:text-ink-mid',
              )}
            >
              <LayoutGrid aria-hidden className="h-3.5 w-3.5" />
              卡片
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'list'}
              onClick={() => updateViewMode('list')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition',
                viewMode === 'list'
                  ? 'bg-base-800 text-ink-hi shadow-sm'
                  : 'text-ink-faint hover:text-ink-mid',
              )}
            >
              <List aria-hidden className="h-3.5 w-3.5" />
              列表
            </button>
          </div>
        </div>
      )}

      {/* 主体内容区 */}
      {tradersQuery.loading && traders.length === 0 ? (
        <div className="rounded-xl border border-base-750 bg-base-900/70 py-10">
          <Spinner3 label="正在加载机器人" />
        </div>
      ) : traders.length === 0 ? (
        <div className="rounded-xl border border-base-750 bg-base-900/70 px-5 py-6">
          <p className="text-base text-ink-mid">
            还没有机器人。先创建一个：模式在创建时选定，模拟盘无需交易所密钥即可放心运行。
          </p>
          <Button variant="primary" className="mt-3" onClick={() => setNewOpen(true)}>
            <Plus aria-hidden className="h-3.5 w-3.5" />
            新建机器人
          </Button>
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-base-750 bg-base-900/70 px-4 py-4 text-sm text-ink-lo">
          <span>当前筛选条件下没有机器人。</span>
          <Button size="sm" variant="ghost" onClick={() => setStatusFilter('all')}>
            查看全部 ({traders.length})
          </Button>
        </div>
      ) : viewMode === 'cards' ? (
        <div
          className={cn(
            'grid gap-4',
            shown.length === 1 ? 'grid-cols-1' : 'grid-cols-1 xl:grid-cols-2',
          )}
        >
          {shown.map((trader) => {
            const stats = statsMap[trader.id];
            const live = liveByTrader[trader.id];
            const status: TraderStatus = live?.status ?? trader.status;
            const isLiveRunning = isTraderLiveRunning(trader);
            const rowBusy = busyId === trader.id;
            const starting = status === 'starting' || optimisticStarting.has(trader.id);
            const account = accountOf(exchangeAccountsQuery.data, trader.exchangeAccountId);
            const snapshots = equitySnapshots[trader.id] ?? [];
            const pnlTip = stats
              ? (isLedgerSuspect(trader.ledger, dryRunOf(trader.id))
                  ? '平台账本与交易所的成交流水对不上，所以这一行改用交易所的流水校准。'
                  : `${pnlFormulaText(statsCosts(stats))}。`) +
                `\n· 浮动盈亏（未计入本行）：${fmtUsdSigned(stats.unrealizedPnl, 2)}`
              : undefined;
            const totalClosed = stats ? stats.wins + stats.losses : 0;
            const winSharePct = totalClosed > 0 && stats ? (stats.wins / totalClosed) * 100 : null;
            const topStripeTone =
              status === 'error'
                ? 'bg-down/80'
                : starting || status === 'safe_mode'
                  ? 'bg-warn/80'
                  : isLiveRunning
                    ? 'bg-up/80'
                    : 'bg-base-700/80';

            return (
              <article
                key={trader.id}
                className="group relative overflow-hidden rounded-xl border border-base-750 bg-base-900/95 transition-colors hover:border-base-600"
              >
                {/* 顶部 2px 状态色带 */}
                <div className={cn('h-[2px] w-full', topStripeTone)} />

                {/* 1) 头部：身份标识 + 模式/账户元信息 + 主操作 */}
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-base-800/80 px-4 py-3.5">
                  <div className="flex min-w-0 items-start gap-3">
                    <Link to={`/traders/${trader.id}`} className="mt-0.5 shrink-0">
                      <TraderAvatar id={trader.id} size={38} className="rounded-xl ring-1 ring-base-700/70" />
                    </Link>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to={`/traders/${trader.id}`}
                          className="truncate text-base font-semibold tracking-tight text-ink-strong transition hover:text-accent"
                          title={trader.name}
                        >
                          {trader.name}
                        </Link>
                        <TraderStatusBadge status={status} live={isLiveRunning} />
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <MoneyBadge dryRun={trader.dryRun} />
                        <ModeBadge mode={trader.mode} />
                        {trader.mode === 'ai_managed' && (
                          <ManagedRiskBadge profile={trader.managedRiskProfile} />
                        )}
                        <span aria-hidden className="text-base-600">
                          ·
                        </span>
                        <ExchangeAccountChip account={account} />
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Link
                      to={`/traders/${trader.id}`}
                      className="btn btn-ghost btn-xs"
                    >
                      进入面板
                      <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
                    </Link>
                    <TraderRowActions
                      trader={trader}
                      starting={starting}
                      isLiveRunning={isLiveRunning}
                      rowBusy={rowBusy}
                      stopPending={pending?.kind === 'delete'}
                      onStart={() => void startNow(trader)}
                      onStop={() => setPending({ kind: 'stop', trader })}
                      onOpen={() => navigate(`/traders/${trader.id}`)}
                      onEdit={() => setEditTarget(trader)}
                      onDelete={() => setPending({ kind: 'delete', trader })}
                    />
                  </div>
                </div>

                {/* 异常 / 统计读数告警条（仅异常时出现） */}
                {(trader.consecutiveFailures > 0 || summaryErrors[trader.id]) && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-warn/25 bg-warn/10 px-4 py-1.5 text-xs text-warn">
                    {trader.consecutiveFailures > 0 && (
                      <span className="num font-medium">
                        连续失败 ×{trader.consecutiveFailures}（超过熔断阈值将进入安全模式）
                      </span>
                    )}
                    {summaryErrors[trader.id] && (
                      <span>
                        {stats ? '统计读取失败（当前展示最近一次成功读数）' : '统计读取失败（暂无数据）'}
                      </span>
                    )}
                  </div>
                )}

                {/* 2) 核心财务区：归属权益 + 收益率/净盈亏 + 迷你权益曲线 */}
                <div className="grid grid-cols-1 items-center gap-4 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(220px,1.25fr)]">
                  <div className="min-w-0">
                    <div className="text-xs text-ink-faint">归属权益</div>
                    <div
                      className={cn(
                        'num mt-1 text-2xl font-bold tracking-tight',
                        stats ? 'text-ink-strong' : 'text-ink-faint',
                      )}
                    >
                      {stats ? fmtUsd(equityOf(trader, stats), 2) : '—'}
                    </div>
                    <div className="num mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-faint">
                      <span>初始 {fmtUsd(trader.initialEquity, 2)}</span>
                      {stats && Math.abs(stats.unrealizedPnl) >= 0.005 ? (
                        <span className={pnlColor(stats.unrealizedPnl)}>
                          浮盈 {fmtUsdSigned(stats.unrealizedPnl, 2)}
                        </span>
                      ) : (
                        <span>浮盈 $0.00</span>
                      )}
                    </div>
                    {stats && isLedgerSuspect(trader.ledger, dryRunOf(trader.id)) && (
                      <div
                        className="mt-0.5 text-[11px] font-normal text-ink-faint"
                        title={
                          '这个数按交易所的实际成交算，不是按平台自己的记录 —— ' +
                          `平台记录与交易所差 ${fmtUsdSigned(trader.ledger!.gap, 4)}（平台有几笔记错了）。` +
                          '详情页的「交易盈亏」用的是同一个数。'
                        }
                      >
                        按交易所实际成交计
                      </div>
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="text-xs text-ink-faint">已实现收益 / 净盈亏</div>
                    <div className="num mt-1 flex flex-wrap items-baseline gap-2.5">
                      <span
                        className={cn(
                          'text-2xl font-bold tracking-tight',
                          stats ? pnlColor(calibratedOf(trader, stats).returnPercent) : 'text-ink-faint',
                        )}
                      >
                        {stats ? fmtPercent(calibratedOf(trader, stats).returnPercent) : '—'}
                      </span>
                      {stats && (
                        <span
                          className={cn(
                            'rounded-md border px-2 py-0.5 text-xs font-semibold',
                            calibratedOf(trader, stats).realizedPnl > 0
                              ? 'border-up/30 bg-up/10 text-up'
                              : calibratedOf(trader, stats).realizedPnl < 0
                                ? 'border-down/30 bg-down/10 text-down'
                                : 'border-base-750 bg-base-850 text-ink-mid',
                            pnlTip && 'cursor-help',
                          )}
                          data-aq-tip={pnlTip}
                        >
                          净 {fmtUsdSigned(calibratedOf(trader, stats).realizedPnl, 2)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 truncate text-xs text-ink-faint">
                      {stats ? <PnlBreakdown costs={statsCosts(stats)} /> : '等待首次平仓统计'}
                    </div>
                  </div>

                  <TraderSparkline
                    snapshots={snapshots}
                    positive={stats ? calibratedOf(trader, stats).realizedPnl >= 0 : true}
                  />
                </div>

                {/* 3) 底部 5 格运行遥测条 */}
                <div className="px-4 pb-4">
                  <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-base-800/80 bg-base-800/70 sm:grid-cols-3 lg:grid-cols-5">
                    <div className="bg-base-950/60 px-3 py-2.5">
                      <div className="text-[11px] text-ink-faint">胜率</div>
                      <div className="num mt-0.5 text-sm font-semibold text-ink-hi">
                        {stats ? `${stats.winRatePercent.toFixed(1)}%` : '—'}
                      </div>
                      {winSharePct !== null && stats ? (
                        <>
                          <div className="mt-1.5 flex h-1 overflow-hidden rounded-full bg-down/45">
                            <div className="h-full bg-up" style={{ width: `${winSharePct}%` }} />
                          </div>
                          <div className="num mt-1 text-[11px] text-ink-faint">
                            {fmtInt(stats.wins)} 盈 · {fmtInt(stats.losses)} 亏
                          </div>
                        </>
                      ) : (
                        <div className="mt-1 text-[11px] text-ink-faint">暂无平仓</div>
                      )}
                    </div>

                    <div className="bg-base-950/60 px-3 py-2.5">
                      <div className="text-[11px] text-ink-faint">盈利因子 PF</div>
                      <div className="num mt-0.5 text-sm font-semibold text-ink-hi">
                        {stats ? fmtProfitFactor(stats.profitFactor) : '—'}
                      </div>
                      <div className="num mt-1 text-[11px] text-ink-faint">
                        {stats ? `最大回撤 ${fmtDrawdownPercent(stats.maxDrawdownPercent)}` : '—'}
                      </div>
                    </div>

                    <div className="bg-base-950/60 px-3 py-2.5">
                      <div className="text-[11px] text-ink-faint">当前持仓</div>
                      <div
                        className={cn(
                          'num mt-0.5 text-sm font-semibold',
                          stats && stats.openPositions > 0 ? 'text-accent' : 'text-ink-hi',
                        )}
                      >
                        {stats ? `${fmtInt(stats.openPositions)} 笔` : '—'}
                      </div>
                      <div className="num mt-1 text-[11px] text-ink-faint">
                        {stats && stats.openPositions > 0
                          ? `浮盈 ${fmtUsdSigned(stats.unrealizedPnl, 2)}`
                          : '空仓待机'}
                      </div>
                    </div>

                    <div className="bg-base-950/60 px-3 py-2.5">
                      <div className="text-[11px] text-ink-faint">决策周期</div>
                      <div className="num mt-0.5 text-sm font-semibold text-ink-hi">
                        #{fmtInt(trader.lastCycleNumber)}
                      </div>
                      <div className="num mt-1 text-[11px] text-ink-faint">
                        每 {trader.cycleIntervalMinutes} 分钟
                      </div>
                    </div>

                    <div className="col-span-2 bg-base-950/60 px-3 py-2.5 sm:col-span-1">
                      <div className="text-[11px] text-ink-faint">运行时长</div>
                      <div className="num mt-0.5 text-sm font-semibold text-ink-hi">
                        {stats ? fmtDuration(stats.uptimeHours * 60) : '—'}
                      </div>
                      <div className="num mt-1 text-[11px] text-ink-faint">
                        最近 {timeAgo(trader.lastCycleAt)}
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        /* 精简列表视图（8 列紧凑归组，供多机横向对比） */
        <div className="overflow-hidden rounded-xl border border-base-750 bg-base-900">
          <div className="scroll-x">
            <table className="w-full min-w-[920px] border-collapse">
              <thead className="border-b border-base-800 bg-base-900">
                <tr>
                  <th className="th">机器人</th>
                  <th className="th">策略与账户</th>
                  <th className="th">状态</th>
                  <th className="th text-right">归属权益</th>
                  <th className="th text-right">收益 / 净盈亏</th>
                  <th className="th text-right">胜率 / PF</th>
                  <th className="th text-right">持仓 / 周期</th>
                  <th className="th col-action-sticky">操作</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((trader) => {
                  const stats = statsMap[trader.id];
                  const live = liveByTrader[trader.id];
                  const status: TraderStatus = live?.status ?? trader.status;
                  const isLiveRunning = isTraderLiveRunning(trader);
                  const rowBusy = busyId === trader.id;
                  const starting = status === 'starting' || optimisticStarting.has(trader.id);
                  const account = accountOf(exchangeAccountsQuery.data, trader.exchangeAccountId);
                  const pnlTip = stats
                    ? (isLedgerSuspect(trader.ledger, dryRunOf(trader.id))
                        ? '平台账本与交易所的成交流水对不上，所以这一行改用交易所的流水校准。'
                        : `${pnlFormulaText(statsCosts(stats))}。`) +
                      `\n· 浮动盈亏（未计入本行）：${fmtUsdSigned(stats.unrealizedPnl, 2)}`
                    : undefined;

                  return (
                    <tr key={trader.id} className="row-hover border-b border-base-850/80 last:border-b-0">
                      <td className="td">
                        <div className="flex items-center gap-2.5">
                          <Link to={`/traders/${trader.id}`} className="shrink-0">
                            <TraderAvatar id={trader.id} size={30} className="rounded-lg" />
                          </Link>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <Link
                                to={`/traders/${trader.id}`}
                                className="max-w-[150px] truncate text-sm font-semibold text-ink-hi transition hover:text-accent"
                                title={trader.name}
                              >
                                {trader.name}
                              </Link>
                              <MoneyBadge dryRun={trader.dryRun} />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="td">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ModeBadge mode={trader.mode} />
                          {trader.mode === 'ai_managed' && (
                            <ManagedRiskBadge profile={trader.managedRiskProfile} />
                          )}
                        </div>
                        <div className="mt-1">
                          <ExchangeAccountChip account={account} />
                        </div>
                      </td>
                      <td className="td">
                        <TraderStatusBadge status={status} live={isLiveRunning} />
                        {trader.consecutiveFailures > 0 && (
                          <div className="num mt-0.5 text-xs text-warn">失败 ×{trader.consecutiveFailures}</div>
                        )}
                        {summaryErrors[trader.id] && (
                          <div className="mt-0.5 text-xs text-warn">{stats ? '统计旧值' : '统计失败'}</div>
                        )}
                      </td>
                      <td className="td num text-right">
                        <div className={cn('font-semibold', stats ? 'text-ink-hi' : 'text-ink-faint')}>
                          {stats ? fmtUsd(equityOf(trader, stats), 2) : '—'}
                        </div>
                        {stats && isLedgerSuspect(trader.ledger, dryRunOf(trader.id)) ? (
                          <div className="text-[11px] font-normal text-ink-faint">按交易所实际成交计</div>
                        ) : (
                          <div className="text-[11px] text-ink-faint">
                            初始 {fmtUsd(trader.initialEquity, 2)}
                          </div>
                        )}
                      </td>
                      <td className="td num text-right">
                        <div
                          className={cn(
                            'font-semibold',
                            stats ? pnlColor(calibratedOf(trader, stats).returnPercent) : 'text-ink-faint',
                          )}
                        >
                          {stats ? fmtPercent(calibratedOf(trader, stats).returnPercent) : '—'}
                        </div>
                        <div
                          className={cn(
                            'text-xs',
                            stats ? pnlColor(calibratedOf(trader, stats).realizedPnl) : 'text-ink-faint',
                          )}
                        >
                          {stats ? (
                            <span className={pnlTip ? 'cursor-help' : undefined} data-aq-tip={pnlTip}>
                              净 {fmtUsdSigned(calibratedOf(trader, stats).realizedPnl, 2)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </div>
                      </td>
                      <td className="td num text-right">
                        {stats ? (
                          <>
                            <div className="font-medium text-ink-hi">
                              {stats.winRatePercent.toFixed(1)}%
                              <span className="ml-1.5 text-xs font-normal text-ink-faint">
                                PF {fmtProfitFactor(stats.profitFactor)}
                              </span>
                            </div>
                            <div className="text-xs text-ink-faint">
                              {fmtInt(stats.wins)} 盈 · {fmtInt(stats.losses)} 亏
                            </div>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="td num text-right">
                        <div className="text-xs text-ink-mid">
                          <span
                            className={cn(
                              'font-semibold',
                              stats && stats.openPositions > 0 ? 'text-accent' : 'text-ink-hi',
                            )}
                          >
                            {stats ? `${fmtInt(stats.openPositions)} 持仓` : '—'}
                          </span>
                          <span className="mx-1 text-base-600">·</span>
                          <span>#{fmtInt(trader.lastCycleNumber)}</span>
                          <span className="ml-1 text-ink-faint">/{trader.cycleIntervalMinutes}m</span>
                        </div>
                        <div className="mt-0.5 text-xs text-ink-faint">
                          {stats ? `${fmtDuration(stats.uptimeHours * 60)} · ${timeAgo(trader.lastCycleAt)}` : timeAgo(trader.lastCycleAt)}
                        </div>
                      </td>
                      <td className="td col-action-sticky">
                        <TraderRowActions
                          trader={trader}
                          starting={starting}
                          isLiveRunning={isLiveRunning}
                          rowBusy={rowBusy}
                          stopPending={pending?.kind === 'delete'}
                          onStart={() => void startNow(trader)}
                          onStop={() => setPending({ kind: 'stop', trader })}
                          onOpen={() => navigate(`/traders/${trader.id}`)}
                          onEdit={() => setEditTarget(trader)}
                          onDelete={() => setPending({ kind: 'delete', trader })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filteredTraders.length > shown.length && (
            <p className="border-t border-base-800 px-4 py-2 text-xs text-ink-faint">
              只渲染前 {shown.length} 个，共 {filteredTraders.length} 个机器人。
            </p>
          )}
        </div>
      )}

      <p className="text-xs leading-relaxed text-ink-faint">
        启动机器人时总会先执行预检；阻断性失败会以红色显示，并阻止该循环交易。停止是立即生效的。
        {system?.tradingDisabled ? ' 当前服务端已设置 GLOBAL_TRADING_DISABLED，所有启动请求都会被拒绝。' : ''}
      </p>

      {/*
        Destructive actions are confirmed in a real dialog rather than
        `window.confirm`: the native one cannot be styled, cannot show a loading
        state, and blocks the whole tab — and here the confirmation has to state
        the consequence, which a single line of plain text does poorly.
      */}
      <Modal
        open={pending !== null}
        onClose={() => (busyId === null ? setPending(null) : undefined)}
        title={pending?.kind === 'delete' ? `删除“${pending.trader.name}”` : `停止“${pending?.trader.name ?? ''}”`}
        width="max-w-lg"
        footer={
          <>
            <Button onClick={() => setPending(null)} disabled={busyId !== null}>
              取消
            </Button>
            <Button
              variant="danger"
              busy={busyId !== null}
              autoFocus
              onClick={() => void runPending()}
            >
              {pending?.kind === 'delete' ? '确认删除' : '确认停止'}
            </Button>
          </>
        }
      >
        {pending?.kind === 'delete' ? (
          <div className="space-y-2">
            <div className="rounded-md border border-down/50 bg-down/10 px-3 py-2 text-base font-semibold text-down">
              该操作不可撤销。
            </div>
            <p className="text-base leading-relaxed text-ink-mid">
              机器人 <span className="font-semibold text-ink-hi">{pending.trader.name}</span>{' '}
              及其<strong className="font-semibold text-ink-hi">全部</strong>成交记录、委托记录与决策记录（含提示词与思维链）
              会一并从数据库中删除。交易所上的持仓与挂单{' '}
              <strong className="font-semibold text-ink-hi">不会</strong>被平掉 — 它只是不再有人管理。
            </p>
            <p className="text-base leading-relaxed text-ink-mid">
              如果只是想让它停下来，请改用「停止」。
            </p>
            {pending.trader.isRunning && (
              <p className="text-xs text-warn">
                该机器人当前正在运行，删除会立即中断正在执行的决策周期。
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-base leading-relaxed text-ink-mid">
              停止 <span className="font-semibold text-ink-hi">{pending?.trader.name}</span> 会立即结束当前循环。
            </p>
            <p className="text-base leading-relaxed text-ink-mid">
              后果：该机器人不再开新仓，也不再有模型决策；
              <strong className="font-semibold text-ink-hi">已有的持仓与交易所侧挂单保持不变</strong>
              ，不会自动平仓。重新启动后需要再次通过预检。
            </p>
          </div>
        )}
      </Modal>

      <NewTraderModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => {
          setNewOpen(false);
          void tradersQuery.reload();
          refreshSystem();
          /*
           * ⚠️ **创建 = 创建，不自动弹"启动"**（用户 2026-11-10：「创建-运行不能混在一起」）。
           *
           * 新机器人以 `stopped` 落库。创建成功后自动打开启动弹窗（那个弹窗已删除）
           * 会让"创建"这个动作看起来像"创建并运行"——用户以为点一下就直接开始交易。
           * 什么时候启动是另一个独立决定，由操作员在列表里自己点。
           */
        }}
      />

      <TraderConfigModal
        trader={editTarget}
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          void tradersQuery.reload();
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  行的主操作 + 溢出菜单                                                      */
/* -------------------------------------------------------------------------- */

function TraderRowActions({
  trader,
  starting,
  isLiveRunning,
  rowBusy,
  stopPending,
  onStart,
  onStop,
  onOpen,
  onEdit,
  onDelete,
}: {
  trader: TraderRow;
  starting: boolean;
  isLiveRunning: boolean;
  rowBusy: boolean;
  stopPending: boolean;
  onStart: () => void;
  onStop: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-1.5">
      {starting ? (
        <Button
          size="sm"
          variant="success"
          className="btn-row-success"
          disabled
          data-aq-tip="启动中：服务端正在执行预检并拉起循环。状态会自动更新为「运行中」；若失败会显示在状态列。"
        >
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
          启动中
        </Button>
      ) : isLiveRunning ? (
        <Button
          size="sm"
          variant="danger"
          className="btn-row-danger"
          busy={rowBusy && !stopPending}
          data-aq-tip="停止循环（需二次确认）"
          onClick={onStop}
        >
          <CircleStop aria-hidden className="h-3.5 w-3.5" />
          停止
        </Button>
      ) : (
        <Button size="sm" variant="success" className="btn-row-success" busy={rowBusy} onClick={onStart}>
          <Play aria-hidden className="h-3.5 w-3.5" />
          启动
        </Button>
      )}
      <TraderRowMenu trader={trader} onOpen={onOpen} onEdit={onEdit} onDelete={onDelete} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  行的溢出菜单                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 每行一个"更多操作"。
 *
 * 打开面板 / 编辑 / 删除都是低频动作，平铺在行里会把 11 列挤得更紧，而且它们的
 * 存在感与「立即运行」一样强 —— 删除这种危险动作不该和主操作长得一样醒目。
 *
 * 用 Radix Popover 而不是手写的绝对定位 div（DESIGN.md §5）：Esc 关闭、点外部
 * 关闭、焦点管理都已经正确，这里只负责外观 —— 与 `settings/AiModelsSection.tsx`
 * 里的模型选择器同一套做法。
 */
function TraderRowMenu({
  trader,
  onOpen,
  onEdit,
  onDelete,
}: {
  trader: TraderRow;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);

  /** 每个动作做完就收起菜单，否则它会盖住下一行的反馈。 */
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button size="icon" variant="ghost" title="更多操作" aria-label={`${trader.name} 的更多操作`}>
          <MoreHorizontal aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={4}
          role="menu"
          aria-label={`${trader.name} 的操作`}
          className="z-50 w-44 overflow-hidden rounded-md border border-base-600 bg-base-900 py-1 shadow-overlay"
        >
          <RowMenuItem icon={<ArrowUpRight aria-hidden className="h-3.5 w-3.5" />} label="打开面板" onClick={run(onOpen)} />
          <RowMenuItem
            icon={<Pencil aria-hidden className="h-3.5 w-3.5" />}
            label="编辑配置"
            disabled={trader.status === 'starting'}
            title={
              trader.status === 'starting'
                ? '启动中，请稍候再修改配置。'
                : trader.isRunning
                  ? '运行中可直接在线修改风险档位、名称、周期等配置（下一轮生效）'
                  : '编辑名称、风险档位、模型、策略与周期间隔'
            }
            onClick={run(onEdit)}
          />
          <RowMenuItem
            icon={<Trash2 aria-hidden className="h-3.5 w-3.5" />}
            label="删除机器人"
            danger
            title={`删除“${trader.name}” — 需要确认`}
            onClick={run(onDelete)}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function RowMenuItem({
  icon,
  label,
  onClick,
  disabled,
  title,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-2 py-2 text-left text-base transition disabled:cursor-not-allowed disabled:opacity-40',
        danger ? 'text-down hover:bg-down/10' : 'text-ink-mid hover:bg-base-850 hover:text-ink-hi',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  迷你权益曲线（卡片内置 SVG Sparkline）                                       */
/* -------------------------------------------------------------------------- */

function TraderSparkline({
  snapshots,
  positive,
}: {
  snapshots: EquitySnapshot[];
  positive: boolean;
}) {
  const gradId = useId();
  const series = useMemo(() => {
    const raw: number[] = [];
    for (const snap of snapshots) {
      const val =
        typeof snap.equity === 'number' && Number.isFinite(snap.equity)
          ? snap.equity
          : typeof snap.accountEquity === 'number' && Number.isFinite(snap.accountEquity)
            ? snap.accountEquity
            : null;
      if (val !== null) raw.push(val);
    }
    if (raw.length <= 72) return raw;
    const step = (raw.length - 1) / 71;
    const sampled: number[] = [];
    for (let i = 0; i < 72; i++) {
      const idx = Math.min(raw.length - 1, Math.round(i * step));
      const v = raw[idx];
      if (v !== undefined) sampled.push(v);
    }
    return sampled;
  }, [snapshots]);

  const width = 240;
  const height = 50;
  const padX = 4;
  const padY = 5;

  if (series.length < 2) {
    return (
      <div className="rounded-lg border border-base-800/80 bg-base-950/50 px-3 py-2">
        <div className="flex items-center justify-between text-[11px] text-ink-faint">
          <span>权益曲线</span>
          <span>等待快照</span>
        </div>
        <div className="mt-1.5 flex h-[46px] items-center justify-center">
          <div className="h-px w-full border-t border-dashed border-base-750" />
        </div>
      </div>
    );
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of series) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const coords = series.map((v, idx) => {
    const x = padX + (idx / (series.length - 1)) * innerW;
    const y = span > 1e-9 ? padY + (1 - (v - min) / span) * innerH : height / 2;
    return { x, y };
  });

  const linePath = coords
    .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(' ');
  const firstPt = coords[0]!;
  const lastPt = coords[coords.length - 1]!;
  const areaPath = `${linePath} L${lastPt.x.toFixed(1)},${height} L${firstPt.x.toFixed(1)},${height} Z`;
  const strokeColor = positive ? 'var(--aq-up)' : 'var(--aq-down)';

  return (
    <div className="rounded-lg border border-base-800/80 bg-base-950/50 px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-[11px] text-ink-faint">
        <span>权益曲线</span>
        <span className="num truncate">
          {fmtUsd(min, 2)} – {fmtUsd(max, 2)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="mt-1.5 block h-[46px] w-full overflow-visible"
        aria-hidden
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.26" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0.01" />
          </linearGradient>
        </defs>
        <line
          x1={padX}
          y1={firstPt.y}
          x2={width - padX}
          y2={firstPt.y}
          stroke="var(--aq-base-700)"
          strokeWidth="1"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={lastPt.x} cy={lastPt.y} r="3" fill={strokeColor} />
      </svg>
    </div>
  );
}
