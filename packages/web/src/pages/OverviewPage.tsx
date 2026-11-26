/**
 * 系统总览 —— 16:9 量化作战实时预览大屏（War-Room Command Center）。
 *
 * 定位（2026-11-26 用户明确）：
 * 「重构，做成一个非常酷炫好看的预览大屏，各种数据、动画、特效、琳琅满目都可以用上，
 * 饱满充斥，实时动态的感觉（做这个意义主要在于情绪价值，功能实用性为辅）」
 *
 * 架构与口径纪律不变：
 * - 账户口径与模拟盘口径仍然严格走 `lib/fleetTotals.ts`（同一钱包不重复计数）；
 * - 曲线与表格高度稳定、绝不出现横向滚动条；
 * - 全部动态视觉走主题 CSS 变量（`--aq-*`），深/浅色双主题皆清晰锐利，并尊重 `prefers-reduced-motion`；
 * - 所有实时数据源复用现有只读接口（`traders` / `traderEquity` / `marketSymbols` / `traderManagedIntel` / `traderDecisions` / `useEvents`），零新增后端依赖。
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowUpRight,
  Cpu,
  Flame,
  Plus,
  Radar,
  Radio,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from 'lucide-react';
import type { DecisionRecord, EquitySnapshot, TraderMode, TraderStatus } from '@aq/shared';
import {
  api,
  type ManagedIntelView,
  type MarketSymbol,
  type TraderRow,
} from '../lib/api';
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
import { Badge, Button, ErrorNote, Panel, Spinner3, cn } from '../components/ui';
import { CoinIcon } from '../components/CoinIcon';
import { ModeBadge } from '../components/TeamRoster';
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
  fmtCompactAmount,
  fmtInt,
  fmtPercent,
  fmtPriceUsd,
  fmtUsd,
  fmtUsdSigned,
  pnlColor,
  timeAgo,
} from '../lib/format';

const EquityCurveChart = lazy(() =>
  import('../components/EquityCurveChart').then((module) => ({ default: module.EquityCurveChart })),
);

const SNAPSHOT_ROWS = 6;
const CHART_HEIGHT = 252;
const CLOCK_WARN_MS = 2000;
const WEIGHT_WARN_PERCENT = 70;
const NO_SYMBOLS: MarketSymbol[] = [];
const NO_DECISIONS: DecisionRecord[] = [];
const NO_TRADERS: TraderRow[] = [];

const DECISION_ACTION_META: Record<string, { label: string; cls: string }> = {
  open_long: { label: '开多', cls: 'border-up/40 bg-up/15 text-up' },
  open_short: { label: '开空', cls: 'border-down/40 bg-down/15 text-down' },
  add_long: { label: '加多', cls: 'border-up/40 bg-up/15 text-up' },
  add_short: { label: '加空', cls: 'border-down/40 bg-down/15 text-down' },
  close_long: { label: '平多', cls: 'border-amber-400/40 bg-amber-400/15 text-amber-300' },
  close_short: { label: '平空', cls: 'border-amber-400/40 bg-amber-400/15 text-amber-300' },
  reduce_long: { label: '减多', cls: 'border-amber-400/40 bg-amber-400/15 text-amber-300' },
  reduce_short: { label: '减空', cls: 'border-amber-400/40 bg-amber-400/15 text-amber-300' },
  update_sl_tp: { label: '调保护', cls: 'border-sky-400/40 bg-sky-400/15 text-sky-300' },
  cancel_pending: { label: '撤挂单', cls: 'border-amber-400/35 bg-amber-400/10 text-amber-300' },
  hold: { label: '持仓', cls: 'border-sky-400/35 bg-sky-400/10 text-sky-300' },
  wait: { label: '观望', cls: 'border-base-700 bg-base-850 text-ink-lo' },
  skip: { label: '跳过', cls: 'border-base-700 bg-base-850 text-ink-faint' },
};

function useLiveClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now.toLocaleTimeString('zh-CN', { hour12: false });
}

export function OverviewPage() {
  useDocumentTitle(PAGE_LABEL.overview);
  const navigate = useNavigate();
  const system = useApp((s) => s.system);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const setTraders = useApp((s) => s.setTraders);
  const socketOpen = useEvents((s) => s.status) === 'open';
  const liveByTrader = useEvents((s) => s.byTrader);
  const liveClock = useLiveClock();

  const tradersQuery = usePolled((signal) => api.traders(signal), {
    intervalMs: socketOpen ? 8000 : 4000,
  });
  const traders = tradersQuery.data ?? NO_TRADERS;

  const statsMap = useSummaries((s) => s.stats);
  const refreshMany = useSummaries((s) => s.refreshMany);

  const [newOpen, setNewOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [stopTarget, setStopTarget] = useState<TraderRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [range, setRange] = useState<EquityRange>('7D');
  const [moverTab, setMoverTab] = useState<'gainers' | 'losers' | 'volume'>('gainers');

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

  /* --- 权益曲线（60s 轮询） ------------------------------------------------- */
  const equityQuery = usePolled<Record<number, EquitySnapshot[]>>(
    async (signal) => {
      const ids = traderIds ? traderIds.split(',').map(Number) : [];
      const pairs = await Promise.all(
        ids.map(async (id) => ({ id, rows: await api.traderEquity(id, 360, signal) })),
      );
      return pairEquityByTrader(pairs);
    },
    { intervalMs: 60_000, enabled: traders.length > 0, deps: [traderIds] },
  );

  /* --- 全市场实时行情快照（用于顶部跑马灯、市场情绪温度计、异动榜） ----------- */
  const marketQuery = usePolled((signal) => api.marketSymbols(signal, 'binance'), {
    intervalMs: socketOpen ? 25_000 : 15_000,
  });
  const marketSymbols = marketQuery.data ?? NO_SYMBOLS;

  /* --- 主力机器人（优先运行中的智能托管）的 AI500 雷达与最新决策脉冲 ---------- */
  const primaryManagedTrader = useMemo(() => {
    return (
      traders.find((t) => t.isRunning && t.mode === 'ai_managed') ??
      traders.find((t) => t.mode === 'ai_managed') ??
      null
    );
  }, [traders]);

  const primaryActiveTrader = useMemo(() => {
    return traders.find((t) => t.isRunning) ?? traders[0] ?? null;
  }, [traders]);

  const intelQuery = usePolled<ManagedIntelView>(
    (signal) => api.traderManagedIntel(primaryManagedTrader!.id, signal),
    {
      intervalMs: 30_000,
      enabled: primaryManagedTrader !== null,
      deps: [primaryManagedTrader?.id ?? 0],
    },
  );

  const recentDecisionsQuery = usePolled<DecisionRecord[]>(
    (signal) => api.traderDecisions(primaryActiveTrader!.id, { limit: 6, signal }),
    {
      intervalMs: socketOpen ? 30_000 : 15_000,
      enabled: primaryActiveTrader !== null,
      deps: [primaryActiveTrader?.id ?? 0],
    },
  );

  /* --- 账户口径与模拟盘口径汇总（严守 fleetTotals 单一事实源） ---------------- */
  const equitySnapshots: Record<number, EquitySnapshot[]> = {};
  for (const trader of traders) {
    equitySnapshots[trader.id] = [
      ...(equityQuery.data?.[trader.id] ?? []),
      ...(liveByTrader[trader.id]?.equity ?? []),
    ];
  }

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

  const fleet = fleetTotals({
    traders,
    stats: statsMap,
    snapshots: equitySnapshots,
    dryRun: dryRunById,
  });

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
  const totalClosed = totalWins + totalLosses;
  const fleetWinRate = totalClosed > 0 ? (totalWins / totalClosed) * 100 : null;

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
  const hasRangeCoverage =
    range === 'ALL'
      ? curve.length > 0
      : Number.isFinite(selectedSpan) &&
        curve.length > 0 &&
        (curve[0]?.t ?? Number.POSITIVE_INFINITY) <= Date.now() - selectedSpan + 5 * 60_000;
  const rangeCopy = RANGE_COPY[range];

  const curveStats = (() => {
    if (curve.length === 0) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (const p of curve) {
      if (p.equity > hi) hi = p.equity;
      if (p.equity < lo) lo = p.equity;
    }
    return { hi, lo, count: curve.length };
  })();

  /* --- 市场广度、跑马灯、异动榜派生数据 ------------------------------------- */
  const marketStats = useMemo(() => {
    if (marketSymbols.length === 0) {
      return {
        upCount: 0,
        downCount: 0,
        bullPct: 50,
        btc: null as MarketSymbol | null,
        tickerItems: [] as MarketSymbol[],
        gainers: [] as MarketSymbol[],
        losers: [] as MarketSymbol[],
        topVolume: [] as MarketSymbol[],
      };
    }
    let upCount = 0;
    let downCount = 0;
    let btc: MarketSymbol | null = null;
    for (const s of marketSymbols) {
      if (s.changePercent24h >= 0) upCount += 1;
      else downCount += 1;
      if (s.symbol === 'BTCUSDT') btc = s;
    }
    const bullPct = Math.round((upCount / marketSymbols.length) * 100);
    const byVol = [...marketSymbols].sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
    const liquid = marketSymbols.filter((s) => s.quoteVolume24h >= 10_000_000);
    const pool = liquid.length >= 12 ? liquid : marketSymbols;
    const byGain = [...pool].sort((a, b) => b.changePercent24h - a.changePercent24h);
    const byLoss = [...pool].sort((a, b) => a.changePercent24h - b.changePercent24h);

    return {
      upCount,
      downCount,
      bullPct,
      btc,
      tickerItems: byVol.slice(0, 18),
      gainers: byGain.slice(0, 5),
      losers: byLoss.slice(0, 5),
      topVolume: byVol.slice(0, 5),
    };
  }, [marketSymbols]);

  /* --- 合并实时决策脉冲（WS 优先，REST 补底） ------------------------------- */
  const pulseDecisions = useMemo(() => {
    const rest = recentDecisionsQuery.data ?? NO_DECISIONS;
    const live = primaryActiveTrader ? (liveByTrader[primaryActiveTrader.id]?.decisions ?? []) : [];
    const seen = new Set<number>();
    const out: DecisionRecord[] = [];
    for (const item of [...live, ...rest]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      if (out.length >= 5) break;
    }
    return out;
  }, [recentDecisionsQuery.data, primaryActiveTrader, liveByTrader]);

  const snapshotRows = traders.slice(0, SNAPSHOT_ROWS);
  const recentTrades = useRecentTrades(
    snapshotRows.filter((trader) => trader.isRunning).map((trader) => trader.id),
  );

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
  const clockWarn = Math.abs(system?.clockOffsetMs ?? 0) > CLOCK_WARN_MS;
  const weightPercent =
    system?.weightLimit && system.weightLimit > 0
      ? Math.round(((system.weightUsed ?? 0) / system.weightLimit) * 100)
      : 0;
  const weightWarn = weightPercent >= WEIGHT_WARN_PERCENT;

  const radarItems = intelQuery.data?.radar?.items?.slice(0, 4) ?? [];
  const activeMovers =
    moverTab === 'gainers'
      ? marketStats.gainers
      : moverTab === 'losers'
        ? marketStats.losers
        : marketStats.topVolume;

  const modeGroups: Array<{ mode: TraderMode; hint: string }> = [
    { mode: 'ai_managed', hint: MODE_HINT.ai_managed },
    { mode: 'strategy', hint: MODE_HINT.strategy },
    { mode: 'ai_team', hint: MODE_HINT.ai_team },
  ];

  return (
    <div className="space-y-3">
      <ErrorNote>{actionError}</ErrorNote>

      {/* ================================================================== */}
      {/*  1. 作战指挥顶栏（Hero Command Banner + 实时时钟 + 市场情绪温度计）  */}
      {/* ================================================================== */}
      <header className="aq-war-hero rounded-xl border border-base-750/90 bg-base-900/95 px-4 py-3 shadow-panel">
        {/* 顶部扫光细线 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] overflow-hidden bg-gradient-to-r from-transparent via-accent/40 to-transparent"
        >
          <div className="aq-shimmer-line h-full w-1/3 bg-gradient-to-r from-transparent via-up/90 to-transparent" />
        </div>

        <div className="relative flex flex-wrap items-center justify-between gap-3">
          {/* 左：标题 + LIVE 呼吸灯 + 实时遥测胶囊 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <div className="flex items-center gap-2.5">
              <span className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-accent/35 bg-accent/12 text-accent shadow-inner">
                <Cpu className="h-4 w-4" aria-hidden />
                {runningCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-up" />
                  </span>
                )}
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-bold tracking-tight text-ink-strong">量化作战总览</h1>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider',
                      runningCount > 0
                        ? 'border-up/40 bg-up/12 text-up'
                        : 'border-base-700 bg-base-850 text-ink-lo',
                    )}
                  >
                    <span className={cn('h-1.5 w-1.5 rounded-full', runningCount > 0 ? 'bg-up animate-pulse' : 'bg-ink-faint')} />
                    {runningCount > 0 ? 'LIVE TELEMETRY' : 'STANDBY'}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                      system?.dryRun
                        ? 'border-accent/35 bg-accent/10 text-accent'
                        : 'border-warn/40 bg-warn/12 text-warn',
                    )}
                  >
                    <Zap className="h-3 w-3" aria-hidden />
                    {system ? (system.dryRun ? '模拟沙盘' : '实盘资金') : '读取中'}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-lo">
                  <span className="inline-flex items-center gap-1 text-ink-mid">
                    <Radio className={cn('h-3 w-3', socketOpen ? 'text-up' : 'text-warn')} aria-hidden />
                    {socketOpen ? 'WS 实时脉搏' : '轮询同步'}
                  </span>
                  <span>
                    全市场 <strong className="text-ink-hi">{fmtInt(system?.tradableSymbols ?? marketSymbols.length)}</strong> 合约
                  </span>
                  {marketStats.btc && (
                    <span className="inline-flex items-center gap-1">
                      <CoinIcon symbol="BTCUSDT" className="h-3.5 w-3.5" />
                      <span>BTC</span>
                      <strong className="text-ink-hi">{fmtPriceUsd(marketStats.btc.price)}</strong>
                      <span className={pnlColor(marketStats.btc.changePercent24h)}>
                        {fmtPercent(marketStats.btc.changePercent24h)}
                      </span>
                    </span>
                  )}
                  <span className="hidden text-ink-faint sm:inline">
                    更新 {timeAgo(tradersQuery.updatedAt ? new Date(tradersQuery.updatedAt).toISOString() : null)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 右：全市场多空情绪条 + 实时电子钟 + 快捷按钮 */}
          <div className="flex flex-wrap items-center gap-2.5">
            {marketSymbols.length > 0 && (
              <div
                className="hidden items-center gap-2 rounded-lg border border-base-750/90 bg-base-950/60 px-2.5 py-1.5 md:flex"
                title={`全市场 24h 涨跌家数：${marketStats.upCount} 涨 / ${marketStats.downCount} 跌`}
              >
                <span className="text-[11px] text-ink-lo">市场广度</span>
                <div className="flex h-2 w-20 overflow-hidden rounded-full bg-down/35">
                  <div
                    className="h-full bg-gradient-to-r from-up/80 to-up transition-all duration-500"
                    style={{ width: `${marketStats.bullPct}%` }}
                  />
                </div>
                <span className="num text-[11px] font-semibold text-up">{marketStats.bullPct}%</span>
                <span className="num text-[10px] text-ink-faint">
                  {marketStats.upCount}↑/{marketStats.downCount}↓
                </span>
              </div>
            )}

            <div className="hidden items-center gap-1.5 rounded-lg border border-base-750/80 bg-base-950/60 px-2.5 py-1.5 font-mono text-xs text-ink-hi sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
              <span className="num font-semibold tracking-wider">{liveClock}</span>
              <span className="text-[10px] text-ink-faint">CST</span>
            </div>

            <Link to="/market" className="btn btn-ghost btn-xs h-8 px-2.5 text-xs">
              <Activity className="h-3.5 w-3.5 text-accent" aria-hidden />
              行情终端
            </Link>
            <Button variant="primary" className="h-8 px-3 text-xs shadow-sm" onClick={() => setNewOpen(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              新建机器人
            </Button>
          </div>
        </div>

        {/* 仅异常越界时显露的系统预警条 */}
        {(clockWarn || weightWarn || system?.tradingDisabled) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-base-800/80 pt-2 text-xs">
            {clockWarn && (
              <span className="inline-flex items-center gap-1 rounded border border-warn/40 bg-warn/10 px-2 py-0.5 text-warn">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                时钟偏差 {fmtClockOffset(system?.clockOffsetMs)}（可能触发 -1021 拒单）
              </span>
            )}
            {weightWarn && (
              <span className="inline-flex items-center gap-1 rounded border border-warn/40 bg-warn/10 px-2 py-0.5 text-warn">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                API 权重 {weightPercent}%（接近限频上限）
              </span>
            )}
            {system?.tradingDisabled && (
              <span className="inline-flex items-center gap-1 rounded border border-down/40 bg-down/10 px-2 py-0.5 text-down">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                全局交易已禁用：新开仓与启动被拦截，平仓与对账正常
              </span>
            )}
          </div>
        )}
      </header>

      {/* ================================================================== */}
      {/*  2. 全市场实时永续合约跑马灯（悬停暂停，点击跳行情页）               */}
      {/* ================================================================== */}
      {marketStats.tickerItems.length > 0 && (
        <div
          className="aq-marquee-wrap relative flex h-9 items-center overflow-hidden rounded-lg border border-base-750/85 bg-base-900/90"
          aria-label="实时主流永续合约行情条"
        >
          <div className="z-10 flex h-full shrink-0 items-center gap-1.5 border-r border-base-750 bg-base-900 px-3 text-[11px] font-semibold text-ink-mid">
            <Flame className="h-3.5 w-3.5 text-amber-400" aria-hidden />
            <span>实时行情</span>
          </div>

          <div className="relative flex-1 overflow-hidden">
            <div className="aq-marquee-track items-center gap-2 px-2">
              {[...marketStats.tickerItems, ...marketStats.tickerItems].map((sym, idx) => {
                const up = sym.changePercent24h >= 0;
                return (
                  <Link
                    key={`${sym.symbol}-${idx}`}
                    to="/market"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-base-800/90 bg-base-950/55 px-2.5 py-1 text-xs transition hover:border-accent/45 hover:bg-base-850"
                  >
                    <CoinIcon symbol={sym.symbol} className="h-4 w-4" />
                    <span className="font-mono font-semibold text-ink-hi">{sym.baseAsset}</span>
                    <span className="num text-ink-mid">{fmtPriceUsd(sym.price)}</span>
                    <span
                      className={cn(
                        'num rounded px-1 py-px text-[11px] font-semibold',
                        up ? 'bg-up/12 text-up' : 'bg-down/12 text-down',
                      )}
                    >
                      {fmtPercent(sym.changePercent24h)}
                    </span>
                  </Link>
                );
              })}
            </div>
            {/* 左右边缘渐变淡出 */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-base-900 to-transparent"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-base-900 to-transparent"
            />
          </div>
        </div>
      )}

      {/* ================================================================== */}
      {/*  3. 五联霓虹 KPI 作战指标带（含 SVG 胜率环形表盘 + 动态心电柱）       */}
      {/* ================================================================== */}
      <section aria-label="核心账户与舰队指标" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {/* Card 1: 总账户权益 */}
        <div
          className="aq-war-card col-span-2 rounded-xl border border-accent/30 bg-base-900 p-3.5 shadow-panel lg:col-span-1"
          style={{
            backgroundImage:
              'radial-gradient(220px circle at 100% 0%, rgb(var(--aq-accent-rgb) / 0.16), transparent 68%)',
          }}
          title={
            paperOnlyFleet
              ? '当前仅有模拟盘机器人：此处为各模拟盘本地模拟权益之和（与真实钱包无关）。'
              : `所有实盘交易所账户（共享钱包）的${BALANCE_LABEL.equity}之和 —— 每个账户只算一次，模拟盘不混入。`
          }
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink-lo">
              {paperOnlyFleet ? '模拟权益合计' : `${BALANCE_LABEL.equity}合计`}
            </span>
            <Wallet className="h-4 w-4 text-accent" aria-hidden />
          </div>
          <div className="num mt-2 text-2xl font-bold tracking-tight text-ink-strong">
            {accountCount > 0 || paperOnlyFleet ? fmtAsset(accountEquity, 'USDT', 2) : '—'}
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-ink-lo">
            <span className="truncate">
              {paperOnlyFleet
                ? `模拟口径 · ${fmtInt(fleet.paper.traderCount)} 台`
                : accountCount > 0
                  ? `${fmtInt(accountCount)} 个实盘账户`
                  : '尚未接入实盘'}
            </span>
            {committedCapital > 0 && (
              <span className="num shrink-0 text-ink-faint">本金 {fmtUsd(committedCapital, 2)}</span>
            )}
          </div>
        </div>

        {/* Card 2: 累计净盈亏 & 总收益率 */}
        <div
          className={cn(
            'aq-war-card rounded-xl border bg-base-900 p-3.5 shadow-panel',
            realizedPnl > 0
              ? 'border-up/30'
              : realizedPnl < 0
                ? 'border-down/30'
                : 'border-base-750',
          )}
          style={{
            backgroundImage:
              realizedPnl > 0
                ? 'radial-gradient(220px circle at 100% 0%, rgb(var(--aq-up-rgb) / 0.16), transparent 70%)'
                : realizedPnl < 0
                  ? 'radial-gradient(220px circle at 100% 0%, rgb(var(--aq-down-rgb) / 0.16), transparent 70%)'
                  : undefined,
          }}
          title="Σ(各机器人自己的已平仓净盈亏)，净 = 毛 − 手续费 − 资金费。右上胶囊为账户口径总收益率。"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink-lo">累计净盈亏</span>
            {committedCapital > 0 ? (
              <span
                className={cn(
                  'num inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold',
                  totalReturnPercent > 0
                    ? 'border-up/35 bg-up/12 text-up'
                    : totalReturnPercent < 0
                      ? 'border-down/35 bg-down/12 text-down'
                      : 'border-base-700 bg-base-850 text-ink-lo',
                )}
              >
                {fmtPercent(totalReturnPercent)}
              </span>
            ) : (
              <TrendingUp className="h-4 w-4 text-ink-faint" aria-hidden />
            )}
          </div>
          <div className={cn('num mt-2 text-2xl font-bold tracking-tight', pnlColor(realizedPnl))}>
            {fmtUsdSigned(realizedPnl, 2)}
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-lo">
            <span>{paperOnlyFleet ? '模拟已落袋净额' : '实盘已落袋净额'}</span>
            <span className={cn('num', pnlColor(unrealized))}>浮盈 {fmtUsdSigned(unrealized, 2)}</span>
          </div>
        </div>

        {/* Card 3: 所选区间权益波动 */}
        <div
          className="aq-war-card rounded-xl border border-base-750 bg-base-900 p-3.5 shadow-panel"
          title="所选时间窗口内的权益变化（含已实现与浮动盈亏）。"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink-lo">
              {range === 'ALL' ? rangeCopy.label : hasRangeCoverage ? rangeCopy.label : '区间盈亏'}
            </span>
            <span className="rounded border border-base-750 bg-base-850 px-1.5 py-px font-mono text-[10px] text-ink-lo">
              {range}
            </span>
          </div>
          <div
            className={cn(
              'num mt-2 text-2xl font-bold tracking-tight',
              equityChange === null ? 'text-ink-hi' : pnlColor(equityChange),
            )}
          >
            {equityChange === null ? '—' : fmtUsdSigned(equityChange, 2)}
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-1 text-[11px]">
            <span className="truncate text-ink-lo">
              {hasRangeCoverage ? rangeCopy.coveredSub : rangeCopy.partialSub}
            </span>
            <span
              className={cn(
                'num shrink-0 font-semibold',
                equityChangePercent === null ? 'text-ink-faint' : pnlColor(equityChangePercent),
              )}
            >
              {equityChangePercent === null ? '暂无快照' : fmtPercent(equityChangePercent)}
            </span>
          </div>
        </div>

        {/* Card 4: 舰队综合胜率 SVG 环形表盘 */}
        <div
          className="aq-war-card rounded-xl border border-base-750 bg-base-900 p-3.5 shadow-panel"
          title="已平仓的盈利笔数与亏损笔数之和（按各机器人统计汇总）。"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-ink-lo">平仓战绩</div>
              <div className="num mt-1.5 text-xl font-bold leading-tight text-ink-strong">
                {withStats > 0 ? (
                  <>
                    <span className="text-up">{fmtInt(totalWins)}</span>
                    <span className="mx-1 text-xs font-normal text-ink-faint">盈 /</span>
                    <span className="text-down">{fmtInt(totalLosses)}</span>
                    <span className="ml-1 text-xs font-normal text-ink-faint">亏</span>
                  </>
                ) : (
                  '—'
                )}
              </div>
              <div className="mt-1.5 text-[11px] text-ink-lo">
                共 <span className="num text-ink-hi">{fmtInt(totalClosed)}</span> 笔已平仓
              </div>
            </div>

            {/* SVG 环形胜率表盘 */}
            <WinRateGauge percent={fleetWinRate} />
          </div>
        </div>

        {/* Card 5: 舰队引擎实时脉冲 */}
        <div
          className={cn(
            'aq-war-card rounded-xl border bg-base-900 p-3.5 shadow-panel',
            runningCount > 0 ? 'border-up/30' : 'border-base-750',
          )}
          style={{
            backgroundImage:
              runningCount > 0
                ? 'radial-gradient(200px circle at 100% 100%, rgb(var(--aq-up-rgb) / 0.14), transparent 68%)'
                : undefined,
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink-lo">作战引擎</span>
            {/* 4 根跳动音频/脉搏柱 */}
            <div className="flex h-4 items-end gap-[2.5px]" aria-hidden>
              <span
                className={cn(
                  'w-[3px] rounded-full',
                  runningCount > 0 ? 'aq-eq-bar-1 h-4 bg-up' : 'h-1.5 bg-base-700',
                )}
              />
              <span
                className={cn(
                  'w-[3px] rounded-full',
                  runningCount > 0 ? 'aq-eq-bar-2 h-4 bg-up' : 'h-2 bg-base-700',
                )}
              />
              <span
                className={cn(
                  'w-[3px] rounded-full',
                  runningCount > 0 ? 'aq-eq-bar-3 h-4 bg-accent' : 'h-1.5 bg-base-700',
                )}
              />
              <span
                className={cn(
                  'w-[3px] rounded-full',
                  runningCount > 0 ? 'aq-eq-bar-4 h-4 bg-up' : 'h-2.5 bg-base-700',
                )}
              />
            </div>
          </div>
          <div className="num mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold text-ink-strong">{fmtInt(runningCount)}</span>
            <span className="text-sm text-ink-faint">/ {fmtInt(traders.length)} 运行中</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-lo">
            <span>
              当前持仓 <strong className="num text-ink-hi">{fmtInt(totalOpen)}</strong> 个
            </span>
            <span className={socketOpen ? 'text-up' : 'text-warn'}>
              {socketOpen ? '● 实时在线' : '○ 轮询中'}
            </span>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/*  4. 16:9 双栏 12-Col Bento 作战主区（左 8 曲线+舰队 / 右 4 雷达+异动） */}
      {/* ================================================================== */}
      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-12">
        {/* ---------------- 左 8 栏：权益曲线 + 机器人作战矩阵 ---------------- */}
        <div className="flex min-w-0 flex-col gap-3.5 xl:col-span-8">
          {/* A. 账户权益曲线指挥图 */}
          <section aria-labelledby="overview-equity" className="panel aq-war-grid overflow-hidden rounded-xl border-base-750/90">
            <h2 id="overview-equity" className="sr-only">
              所有交易所账户的{BALANCE_LABEL.equity}之和（按账户口径，共用钱包只算一次）
            </h2>

            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-800/90 bg-base-900/90 px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-ink-hi">
                  <Sparkles className="h-4 w-4 text-accent" aria-hidden />
                  {paperOnlyFleet ? '模拟权益曲线' : `${BALANCE_LABEL.equity}实时曲线`}
                </span>
                {curveStats && (
                  <div className="hidden items-center gap-2 font-mono text-[11px] text-ink-lo md:flex">
                    <span className="rounded bg-base-850/90 px-1.5 py-0.5">
                      峰值 <strong className="text-up">{fmtUsd(curveStats.hi, 2)}</strong>
                    </span>
                    <span className="rounded bg-base-850/90 px-1.5 py-0.5">
                      谷值 <strong className="text-ink-hi">{fmtUsd(curveStats.lo, 2)}</strong>
                    </span>
                    <span className="text-ink-faint">{fmtInt(curveStats.count)} 点</span>
                  </div>
                )}
              </div>

              <div role="group" aria-label="曲线时间范围" className="flex items-center gap-1 rounded-lg border border-base-800 bg-base-950/60 p-0.5">
                {EQUITY_RANGES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={range === item.id}
                    onClick={() => setRange(item.id)}
                    className={cn(
                      'rounded-md px-2.5 py-1 font-mono text-[11px] font-medium transition',
                      range === item.id
                        ? 'bg-accent text-white shadow-sm'
                        : 'text-ink-lo hover:bg-base-850 hover:text-ink-hi',
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-3">
              {equityQuery.error ? (
                <ErrorNote>{equityQuery.error}</ErrorNote>
              ) : equityQuery.loading && equityQuery.data === null ? (
                <EquitySkeleton />
              ) : (
                <Suspense fallback={<EquitySkeleton />}>
                  <EquityCurveChart
                    points={curve}
                    range={range}
                    height={CHART_HEIGHT}
                    baseline={committedCapital > 0 ? committedCapital : undefined}
                    primaryLabel={paperOnlyFleet ? '模拟权益' : BALANCE_LABEL.equity}
                  />
                </Suspense>
              )}
            </div>
          </section>

          {/* B. 机器人作战阵列 */}
          <section aria-labelledby="overview-traders" className="space-y-2">
            <h2 id="overview-traders" className="sr-only">
              机器人明细
            </h2>

            <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-ink-hi">机器人作战阵列</span>
                <Badge tone={runningCount > 0 ? 'up' : 'muted'}>
                  {fmtInt(runningCount)} / {fmtInt(traders.length)} 运行中
                </Badge>
                {/* 紧凑运行模式分布胶囊 */}
                <div className="hidden items-center gap-1.5 sm:flex">
                  {modeGroups.map((g) => {
                    const count = traders.filter((t) => t.mode === g.mode).length;
                    return (
                      <Link
                        key={g.mode}
                        to="/traders"
                        title={g.hint}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition',
                          count > 0
                            ? 'border-base-750 bg-base-900 hover:border-base-600'
                            : 'border-base-850 bg-base-900/40 opacity-60 hover:opacity-100',
                        )}
                      >
                        <ModeBadge mode={g.mode} />
                        <span className="num font-semibold text-ink-hi">{count}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>

              <Link
                to="/traders"
                className="inline-flex items-center gap-1 text-xs text-ink-lo transition hover:text-accent"
              >
                进入机器人指挥台
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>

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
              <Panel className="py-5 text-center">
                <p className="text-sm font-medium text-ink-hi">舰队待命中，还没有机器人</p>
                <p className="mt-1 text-xs text-ink-lo">
                  创建后默认以「模拟」运行，零风险观察 AI500 雷达与决策链路。
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <Button variant="primary" onClick={() => setNewOpen(true)}>
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    新建机器人
                  </Button>
                  <Link to="/exchanges" className="btn btn-ghost">
                    先去配置交易所
                  </Link>
                </div>
              </Panel>
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
              <ErrorNote>最近一次刷新失败，下面是上一次的数据：{tradersQuery.error}</ErrorNote>
            )}
          </section>
        </div>

        {/* ---------------- 右 4 栏：AI500 雷达扫描仪 + 异动榜 + AI 脉冲 ---------------- */}
        <aside className="flex min-w-0 flex-col gap-3.5 xl:col-span-4">
          {/* C. AI500 神经扫描雷达卡 */}
          <section className="panel relative overflow-hidden rounded-xl border-base-750/90">
            <div className="flex items-center justify-between gap-2 border-b border-base-800/90 px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <Radar className="h-4 w-4 text-up" aria-hidden />
                <span className="text-sm font-semibold text-ink-hi">AI500 雷达扫描</span>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border border-up/35 bg-up/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-up">
                <span className="h-1.5 w-1.5 rounded-full bg-up animate-ping" />
                SCANNING
              </span>
            </div>

            <div className="p-3.5">
              {/* 雷达动画视觉 + 实时摘要 */}
              <div className="flex items-center gap-3.5">
                <RadarDish active={runningCount > 0 || marketSymbols.length > 0} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs text-ink-lo">监控池规模</span>
                    <span className="num text-base font-bold text-ink-strong">
                      {fmtInt(system?.tradableSymbols ?? marketSymbols.length)} 标的
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs text-ink-lo">多空情绪</span>
                    <span className={cn('num text-xs font-semibold', marketStats.bullPct >= 50 ? 'text-up' : 'text-down')}>
                      {marketStats.bullPct >= 55 ? '偏多活跃' : marketStats.bullPct <= 45 ? '偏空承压' : '多空均衡'} · {marketStats.bullPct}%
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs text-ink-lo">活跃哨兵</span>
                    <span className="truncate text-xs font-medium text-accent">
                      {primaryManagedTrader ? primaryManagedTrader.name : '未启用托管'}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-base-850">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-accent via-up to-emerald-300 transition-all duration-700"
                      style={{ width: `${Math.max(12, marketStats.bullPct)}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* AI500 雷达高分热点列表 */}
              {radarItems.length > 0 && (
                <div className="mt-3 space-y-1.5 border-t border-base-800/80 pt-2.5">
                  <div className="flex items-center justify-between text-[11px] text-ink-lo">
                    <span>最新雷达高分聚焦</span>
                    {primaryManagedTrader && (
                      <Link to={`/traders/${primaryManagedTrader.id}`} className="text-accent hover:underline">
                        完整榜单 →
                      </Link>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {radarItems.map((item) => {
                      const tierCls =
                        item.tier === 'strong'
                          ? 'border-up/40 bg-up/12 text-up'
                          : item.tier === 'watch'
                            ? 'border-warn/40 bg-warn/12 text-warn'
                            : 'border-base-700 bg-base-850 text-ink-lo';
                      return (
                        <Link
                          key={item.symbol}
                          to={primaryManagedTrader ? `/traders/${primaryManagedTrader.id}` : '/market'}
                          className="flex items-center justify-between gap-2 rounded-lg border border-base-800/90 bg-base-950/55 px-2.5 py-1.5 transition hover:border-accent/40 hover:bg-base-850/80"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <CoinIcon symbol={item.symbol} className="h-[18px] w-[18px]" />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-xs font-semibold text-ink-hi">
                                  {item.symbol.replace(/USDT$/, '')}
                                </span>
                                <span
                                  className={cn(
                                    'rounded px-1 py-px text-[10px] font-medium',
                                    item.bias === 'long'
                                      ? 'bg-up/15 text-up'
                                      : item.bias === 'short'
                                        ? 'bg-down/15 text-down'
                                        : 'bg-base-800 text-ink-lo',
                                  )}
                                >
                                  {item.bias === 'long' ? '偏多' : item.bias === 'short' ? '偏空' : '中性'}
                                </span>
                              </div>
                              <div className="num text-[10px] text-ink-faint">
                                {fmtPriceUsd(item.price)} · 4h{' '}
                                <span className={pnlColor(item.change4hPct)}>{fmtPercent(item.change4hPct)}</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-2">
                            <div className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-base-800 sm:block">
                              <div
                                className={cn(
                                  'h-full rounded-full',
                                  item.score >= 75 ? 'bg-up' : item.score >= 65 ? 'bg-amber-400' : 'bg-ink-faint',
                                )}
                                style={{ width: `${Math.min(100, Math.max(8, item.score))}%` }}
                              />
                            </div>
                            <span className={cn('num rounded border px-1.5 py-0.5 text-[11px] font-bold', tierCls)}>
                              {Math.round(item.score)}
                            </span>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* D. 全市场实时异动榜（领涨 / 领跌 / 成交额） */}
          <section className="panel overflow-hidden rounded-xl border-base-750/90">
            <div className="flex items-center justify-between gap-2 border-b border-base-800/90 px-3.5 py-2">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-ink-hi">
                <Flame className="h-4 w-4 text-amber-400" aria-hidden />
                全市场异动榜
              </span>
              <div className="flex items-center gap-1 rounded-md border border-base-800 bg-base-950/60 p-0.5 text-[11px]">
                {(
                  [
                    { id: 'gainers', label: '领涨' },
                    { id: 'losers', label: '领跌' },
                    { id: 'volume', label: '热钱' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setMoverTab(tab.id)}
                    className={cn(
                      'rounded px-2 py-0.5 font-medium transition',
                      moverTab === tab.id
                        ? 'bg-accent text-white'
                        : 'text-ink-lo hover:text-ink-hi',
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="divide-y divide-base-850/80 px-3 py-1">
              {activeMovers.length === 0 ? (
                <div className="py-5 text-center text-xs text-ink-faint">正在接入全市场实时异动流…</div>
              ) : (
                activeMovers.map((sym, i) => {
                  const up = sym.changePercent24h >= 0;
                  const barPct = Math.min(100, Math.max(8, Math.abs(sym.changePercent24h) * 3.5));
                  return (
                    <Link
                      key={sym.symbol}
                      to="/market"
                      className="flex items-center justify-between gap-2 py-1.5 transition hover:bg-base-850/40"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="num w-4 text-center text-[11px] font-semibold text-ink-faint">{i + 1}</span>
                        <CoinIcon symbol={sym.symbol} className="h-[18px] w-[18px]" />
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs font-semibold text-ink-hi">{sym.baseAsset}</div>
                          <div className="num text-[10px] text-ink-faint">额 {fmtCompactAmount(sym.quoteVolume24h, 'USDT')}</div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2.5">
                        <div className="text-right">
                          <div className="num text-xs font-medium text-ink-hi">{fmtPriceUsd(sym.price)}</div>
                          <div className="mt-0.5 ml-auto h-1 w-14 overflow-hidden rounded-full bg-base-850">
                            <div
                              className={cn('h-full rounded-full', up ? 'bg-up' : 'bg-down')}
                              style={{ width: `${barPct}%` }}
                            />
                          </div>
                        </div>
                        <span
                          className={cn(
                            'num inline-flex w-16 items-center justify-end gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold',
                            up ? 'bg-up/12 text-up' : 'bg-down/12 text-down',
                          )}
                        >
                          {up ? <TrendingUp className="h-3 w-3" aria-hidden /> : <TrendingDown className="h-3 w-3" aria-hidden />}
                          {fmtPercent(sym.changePercent24h)}
                        </span>
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
          </section>

          {/* E. AI 决策实时脉冲流 */}
          {primaryActiveTrader && (
            <section className="panel overflow-hidden rounded-xl border-base-750/90">
              <div className="flex items-center justify-between gap-2 border-b border-base-800/90 px-3.5 py-2">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-ink-hi">
                  <Activity className="h-4 w-4 text-accent" aria-hidden />
                  AI 决策脉冲
                </span>
                <Link
                  to={`/traders/${primaryActiveTrader.id}`}
                  className="text-[11px] text-ink-lo transition hover:text-accent"
                >
                  {primaryActiveTrader.name} →
                </Link>
              </div>

              <div className="divide-y divide-base-850/80 px-3 py-1">
                {pulseDecisions.length === 0 ? (
                  <div className="py-4 text-center text-xs text-ink-faint">等待下一轮 AI 决策脉搏…</div>
                ) : (
                  pulseDecisions.slice(0, 4).map((rec) => {
                    const top =
                      rec.decisions.find((d) => d.action !== 'wait' && d.action !== 'skip') ??
                      rec.decisions[0];
                    const meta = top
                      ? (DECISION_ACTION_META[top.action] ?? {
                          label: top.action,
                          cls: 'border-base-700 bg-base-850 text-ink-lo',
                        })
                      : { label: '观望', cls: 'border-base-700 bg-base-850 text-ink-lo' };
                    return (
                      <Link
                        key={rec.id}
                        to={`/traders/${rec.traderId}/decisions/${rec.id}`}
                        className="flex items-center justify-between gap-2 py-2 transition hover:bg-base-850/40"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="num rounded bg-base-850 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink-mid">
                            #{rec.cycleNumber}
                          </span>
                          {top?.symbol && <CoinIcon symbol={top.symbol} className="h-4 w-4" />}
                          <span className="truncate font-mono text-xs font-semibold text-ink-hi">
                            {top?.symbol ? top.symbol.replace(/USDT$/, '') : '全市场'}
                          </span>
                          <span className={cn('rounded border px-1.5 py-px text-[10px] font-semibold', meta.cls)}>
                            {meta.label}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-ink-faint">
                          {typeof top?.confidence === 'number' && top.confidence > 0 && (
                            <span className="text-ink-mid">{Math.round(top.confidence)}%</span>
                          )}
                          <span>{timeAgo(rec.timestamp)}</span>
                        </div>
                      </Link>
                    );
                  })
                )}
              </div>
            </section>
          )}
        </aside>
      </div>

      <NewTraderModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => {
          setNewOpen(false);
          void tradersQuery.reload();
          refreshSystem();
        }}
      />

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

/* -------------------------------------------------------------------------- */
/*  视觉子组件：SVG 胜率环形仪表盘 + 动态雷达扫描盘                              */
/* -------------------------------------------------------------------------- */

function WinRateGauge({ percent }: { percent: number | null }) {
  const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const r = 20;
  const c = 2 * Math.PI * r;
  const dash = (clamped / 100) * c;
  const strokeColor =
    percent === null
      ? 'rgb(var(--aq-base-700-rgb))'
      : clamped >= 55
        ? 'rgb(var(--aq-up-rgb))'
        : clamped >= 40
          ? 'rgb(var(--aq-warn-rgb))'
          : 'rgb(var(--aq-down-rgb))';

  return (
    <div className="relative flex h-13 w-13 shrink-0 items-center justify-center">
      <svg width="52" height="52" viewBox="0 0 52 52" className="-rotate-90" aria-hidden>
        <circle
          cx="26"
          cy="26"
          r={r}
          fill="none"
          stroke="rgb(var(--aq-base-800-rgb))"
          strokeWidth="4.5"
        />
        <circle
          cx="26"
          cy="26"
          r={r}
          fill="none"
          stroke={strokeColor}
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          className="transition-all duration-700"
        />
      </svg>
      <span className="num absolute text-[11px] font-bold text-ink-hi">
        {percent === null ? '—' : `${Math.round(percent)}%`}
      </span>
    </div>
  );
}

function RadarDish({ active }: { active: boolean }) {
  return (
    <div
      className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full border border-up/35 bg-base-950/90 shadow-inner"
      aria-hidden
    >
      {/* 同心圆网格 */}
      <div className="absolute inset-2 rounded-full border border-up/15" />
      <div className="absolute inset-5 rounded-full border border-up/20" />
      <div className="absolute inset-x-0 top-1/2 h-px bg-up/15" />
      <div className="absolute inset-y-0 left-1/2 w-px bg-up/15" />

      {/* 旋转扫描扇叶 */}
      {active && <div className="aq-radar-sweep absolute inset-0 rounded-full" />}

      {/* 闪烁目标光点 */}
      <span className="absolute right-4 top-4 h-1.5 w-1.5 rounded-full bg-up shadow-[0_0_8px_rgb(var(--aq-up-rgb))] animate-pulse" />
      <span className="absolute bottom-5 left-4 h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_rgb(var(--aq-accent-rgb))] animate-pulse" />
      <span className="absolute bottom-3.5 right-6 h-1 w-1 rounded-full bg-amber-400" />

      {/* 中心核心点 */}
      <span className="relative z-10 h-2 w-2 rounded-full bg-up shadow-[0_0_10px_rgb(var(--aq-up-rgb))]" />
    </div>
  );
}
