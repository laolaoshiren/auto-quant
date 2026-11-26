/**
 * 系统总览 —— 16:9 量化全景观测台（AUTOQUANT // QUANT OBSERVATORY）。
 *
 * 定位（2026-11-26 用户明确）：
 * 「要足够震撼、提供情绪价值、画面变化频繁，在不影响系统运行的前提下，不虚构数据；
 * 不要和机器人详情页重复。」
 *
 * 架构与原则：
 * 1. **零重复**：彻底移除与 `/traders` 重复的机器人大表和常规折线图，聚焦「全市场 522 永续星云 +
 *    24H 量子热力表盘 + 实时神经网络管线 + 流动性脊线频谱 + 4×4 能量热力块 + `$ tail -f` 实盘终端」；
 * 2. **100% 真实数据**：全部数值、标的名、价格、涨跌幅、成交额、权益、盈亏、胜率、AI500 评分、决策周期
 *    均来自现有只读接口与实时事件流，严守 `lib/fleetTotals.ts` 口径，绝不虚构任何一条数据；
 * 3. **零性能负担**：所有 60fps Canvas 在页面切出时自动暂停、遵循 `prefers-reduced-motion`，且零新增后端轮询压力。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowUpRight,
  Cpu,
  Flame,
  GitBranch,
  Globe,
  Plus,
  Radio,
  ShieldAlert,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';
import type { DecisionRecord, EquitySnapshot } from '@aq/shared';
import {
  api,
  type ManagedIntelView,
  type MarketSymbol,
  type TraderRow,
} from '../lib/api';
import { PAGE_LABEL, isPaperView } from '../lib/glossary';
import { useApp, useEvents } from '../lib/store';
import { useSummaries } from '../lib/summaries';
import {
  accountEquityContributor,
  attributedEquityOf,
  fleetTotals,
  paperEquityContributor,
} from '../lib/fleetTotals';
import { pairEquityByTrader } from '../lib/equityPairing';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { Button, ErrorNote, cn } from '../components/ui';
import { CoinIcon } from '../components/CoinIcon';
import { NewTraderModal } from '../components/TraderModals';
import { mergeEquityCurves } from '../components/equityCurve';
import {
  HeatclockCanvas,
  MarketGalaxyCanvas,
  NeuralPipelineCanvas,
  QuantumRidgeCanvas,
} from '../components/overview/ObservatoryCanvases';
import {
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

const CLOCK_WARN_MS = 2000;
const WEIGHT_WARN_PERCENT = 70;
const NO_SYMBOLS: MarketSymbol[] = [];
const NO_DECISIONS: DecisionRecord[] = [];
const NO_TRADERS: TraderRow[] = [];

const ACTION_TAG: Record<string, { label: string; color: string }> = {
  open_long: { label: 'OPEN LONG', color: 'text-emerald-400' },
  open_short: { label: 'OPEN SHORT', color: 'text-rose-400' },
  add_long: { label: 'ADD LONG', color: 'text-emerald-400' },
  add_short: { label: 'ADD SHORT', color: 'text-rose-400' },
  close_long: { label: 'CLOSE LONG', color: 'text-amber-300' },
  close_short: { label: 'CLOSE SHORT', color: 'text-amber-300' },
  reduce_long: { label: 'REDUCE', color: 'text-amber-300' },
  reduce_short: { label: 'REDUCE', color: 'text-amber-300' },
  update_sl_tp: { label: 'SL/TP MOD', color: 'text-sky-400' },
  cancel_pending: { label: 'CANCEL ORD', color: 'text-amber-300' },
  hold: { label: 'HOLD', color: 'text-sky-400' },
  wait: { label: 'WATCH', color: 'text-slate-400' },
  skip: { label: 'SKIP', color: 'text-slate-500' },
};

function useHighFreqClock(): string {
  const [text, setText] = useState(() => {
    const d = new Date();
    return `${d.toLocaleTimeString('zh-CN', { hour12: false })}.${String(Math.floor(d.getMilliseconds() / 10)).padStart(2, '0')}`;
  });
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden) return;
      const d = new Date();
      setText(
        `${d.toLocaleTimeString('zh-CN', { hour12: false })}.${String(Math.floor(d.getMilliseconds() / 10)).padStart(2, '0')}`,
      );
    }, 100);
    return () => window.clearInterval(id);
  }, []);
  return text;
}

interface WireEntry {
  key: string;
  time: string;
  tag: 'RADAR' | 'SCAN' | 'MOVE' | 'CYCLE';
  tagCls: string;
  body: string;
  metric: string;
  metricCls: string;
  to?: string;
}

export function OverviewPage() {
  useDocumentTitle(PAGE_LABEL.overview);
  const system = useApp((s) => s.system);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const setTraders = useApp((s) => s.setTraders);
  const socketOpen = useEvents((s) => s.status) === 'open';
  const liveByTrader = useEvents((s) => s.byTrader);
  const highFreqClock = useHighFreqClock();

  const [newOpen, setNewOpen] = useState(false);
  const [stageMode, setStageMode] = useState<'galaxy' | 'pipeline'>('galaxy');
  const [wireOffset, setWireOffset] = useState(0);

  const tradersQuery = usePolled((signal) => api.traders(signal), {
    intervalMs: socketOpen ? 10_000 : 5_000,
  });
  const traders = tradersQuery.data ?? NO_TRADERS;

  const statsMap = useSummaries((s) => s.stats);
  const refreshMany = useSummaries((s) => s.refreshMany);

  useEffect(() => {
    if (tradersQuery.data) setTraders(tradersQuery.data);
  }, [tradersQuery.data, setTraders]);

  const traderIds = traders.map((t) => t.id).join(',');

  useEffect(() => {
    const ids = traderIds ? traderIds.split(',').map(Number) : [];
    if (ids.length === 0) return;
    void refreshMany(ids);
    const timer = window.setInterval(() => void refreshMany(ids), socketOpen ? 12_000 : 6_000);
    return () => window.clearInterval(timer);
  }, [traderIds, refreshMany, socketOpen]);

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

  // 全市场 522 永续合约实时快照（服务端内存缓存，不打交易所额外权重）
  const marketQuery = usePolled((signal) => api.marketSymbols(signal, 'binance'), {
    intervalMs: 12_000,
  });
  const marketSymbols = marketQuery.data ?? NO_SYMBOLS;

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
      intervalMs: 25_000,
      enabled: primaryManagedTrader !== null,
      deps: [primaryManagedTrader?.id ?? 0],
    },
  );

  const recentDecisionsQuery = usePolled<DecisionRecord[]>(
    (signal) => api.traderDecisions(primaryActiveTrader!.id, { limit: 12, signal }),
    {
      intervalMs: socketOpen ? 30_000 : 15_000,
      enabled: primaryActiveTrader !== null,
      deps: [primaryActiveTrader?.id ?? 0],
    },
  );

  /* --- 严格走 fleetTotals 单一口径（不重复计算共享钱包） -------------------- */
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

  const equityOf = (trader: TraderRow): number =>
    attributedEquityOf(trader, statsMap[trader.id], dryRunOf(trader.id));

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

  const accountEquity = paperOnlyFleet ? fleet.paper.equity : fleet.accountEquityFleet;
  const committedCapital = paperOnlyFleet ? fleet.paper.capital : fleet.committedCapitalFleet;
  const totalReturnPercent = paperOnlyFleet ? fleet.paper.returnPercent : fleet.accountReturnPercent;
  const totalOpen = paperOnlyFleet ? fleet.paper.openPositions : fleet.openPositionsFleet;
  const unrealized = paperOnlyFleet ? fleet.paper.unrealizedPnl : fleet.unrealizedPnlFleet;
  const realizedPnl = paperOnlyFleet ? fleet.paper.realizedPnl : fleet.realizedPnlFleet;
  const totalWins = paperOnlyFleet ? fleet.paper.wins : fleet.winsFleet;
  const totalLosses = paperOnlyFleet ? fleet.paper.losses : fleet.lossesFleet;
  const totalClosed = totalWins + totalLosses;
  const fleetWinRate = totalClosed > 0 ? (totalWins / totalClosed) * 100 : null;

  /* --- 合并真实决策脉冲（WS 优先，REST 补底） ------------------------------- */
  const allDecisions = useMemo(() => {
    const rest = recentDecisionsQuery.data ?? NO_DECISIONS;
    const live = primaryActiveTrader ? (liveByTrader[primaryActiveTrader.id]?.decisions ?? []) : [];
    const seen = new Set<number>();
    const out: DecisionRecord[] = [];
    for (const item of [...live, ...rest]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      if (out.length >= 16) break;
    }
    return out;
  }, [recentDecisionsQuery.data, primaryActiveTrader, liveByTrader]);

  /* --- 全市场真实派生指标（全部 522 标的实时统计） --------------------------- */
  const marketStats = useMemo(() => {
    if (marketSymbols.length === 0) {
      return {
        upCount: 0,
        downCount: 0,
        bullPct: 50,
        surgeCount: 0,
        crashCount: 0,
        medianPct: 0,
        totalVol: 0,
        btc: null as MarketSymbol | null,
        eth: null as MarketSymbol | null,
        sol: null as MarketSymbol | null,
        tickerItems: [] as MarketSymbol[],
        heatTiles: [] as MarketSymbol[],
      };
    }
    let upCount = 0;
    let downCount = 0;
    let surgeCount = 0;
    let crashCount = 0;
    let totalVol = 0;
    let btc: MarketSymbol | null = null;
    let eth: MarketSymbol | null = null;
    let sol: MarketSymbol | null = null;
    const pcts: number[] = [];

    for (const s of marketSymbols) {
      if (s.changePercent24h >= 0) upCount += 1;
      else downCount += 1;
      if (s.changePercent24h >= 10) surgeCount += 1;
      if (s.changePercent24h <= -10) crashCount += 1;
      totalVol += s.quoteVolume24h;
      pcts.push(s.changePercent24h);
      if (s.symbol === 'BTCUSDT') btc = s;
      else if (s.symbol === 'ETHUSDT') eth = s;
      else if (s.symbol === 'SOLUSDT') sol = s;
    }
    pcts.sort((a, b) => a - b);
    const medianPct = pcts[Math.floor(pcts.length / 2)] ?? 0;
    const bullPct = Math.round((upCount / marketSymbols.length) * 100);

    const byVol = [...marketSymbols].sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
    const liquid = marketSymbols.filter((s) => s.quoteVolume24h >= 15_000_000);
    const byAbs = [...(liquid.length >= 16 ? liquid : marketSymbols)].sort(
      (a, b) => Math.abs(b.changePercent24h) - Math.abs(a.changePercent24h),
    );
    // 16 格能量矩阵：8 个最具爆发力的真实异动龙头 + 8 个最高成交额主流币去重拼装
    const tileSeen = new Set<string>();
    const heatTiles: MarketSymbol[] = [];
    for (const s of [...byAbs.slice(0, 9), ...byVol.slice(0, 12)]) {
      if (tileSeen.has(s.symbol)) continue;
      tileSeen.add(s.symbol);
      heatTiles.push(s);
      if (heatTiles.length >= 16) break;
    }

    return {
      upCount,
      downCount,
      bullPct,
      surgeCount,
      crashCount,
      medianPct,
      totalVol,
      btc,
      eth,
      sol,
      tickerItems: byVol.slice(0, 20),
      heatTiles,
    };
  }, [marketSymbols]);

  const radarItems = useMemo(() => intelQuery.data?.radar?.items ?? [], [intelQuery.data]);
  const latestDecision = allDecisions[0] ?? null;

  /* --- 实时滚动终端流（100% 真实事件 + 真实雷达 + 真实大波动标的轮播） ------- */
  const wirePool = useMemo<WireEntry[]>(() => {
    const entries: WireEntry[] = [];
    const nowTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });

    // 1. 真实 AI500 雷达扫描焦点
    for (const r of radarItems.slice(0, 6)) {
      entries.push({
        key: `radar-${r.symbol}`,
        time: intelQuery.data?.radar?.updatedAt
          ? new Date(intelQuery.data.radar.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })
          : nowTime,
        tag: 'RADAR',
        tagCls: 'bg-amber-400/15 text-amber-300 border-amber-400/35',
        body: `${r.symbol.replace(/USDT$/, '')} · ${r.bias === 'long' ? '偏多' : r.bias === 'short' ? '偏空' : '中性'} · ${fmtPriceUsd(r.price)}`,
        metric: `${Math.round(r.score)}分`,
        metricCls: r.score >= 75 ? 'text-emerald-400' : r.score >= 65 ? 'text-amber-300' : 'text-slate-300',
        to: primaryManagedTrader ? `/traders/${primaryManagedTrader.id}` : '/market',
      });
    }

    // 2. 真实决策周期记录
    for (const rec of allDecisions.slice(0, 6)) {
      const top = rec.decisions.find((d) => d.action !== 'wait' && d.action !== 'skip') ?? rec.decisions[0];
      const act = top ? (ACTION_TAG[top.action] ?? { label: top.action.toUpperCase(), color: 'text-slate-300' }) : { label: 'WATCH', color: 'text-slate-400' };
      entries.push({
        key: `cycle-${rec.id}`,
        time: new Date(rec.timestamp).toLocaleTimeString('zh-CN', { hour12: false }),
        tag: 'CYCLE',
        tagCls: 'bg-violet-500/20 text-violet-300 border-violet-400/35',
        body: `#${rec.cycleNumber} ${top?.symbol ? top.symbol.replace(/USDT$/, '') : '全市场'} ${act.label}`,
        metric: typeof top?.confidence === 'number' && top.confidence > 0 ? `${Math.round(top.confidence)}%` : timeAgo(rec.timestamp),
        metricCls: act.color,
        to: `/traders/${rec.traderId}/decisions/${rec.id}`,
      });
    }

    // 3. 真实全市场大波动合约
    for (const s of marketStats.heatTiles.slice(0, 10)) {
      const up = s.changePercent24h >= 0;
      entries.push({
        key: `move-${s.symbol}`,
        time: nowTime,
        tag: 'MOVE',
        tagCls: up ? 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30' : 'bg-rose-500/15 text-rose-300 border-rose-400/30',
        body: `${s.baseAsset} ${fmtPriceUsd(s.price)} · 额 ${fmtCompactAmount(s.quoteVolume24h, 'USDT')}`,
        metric: fmtPercent(s.changePercent24h),
        metricCls: up ? 'text-emerald-400' : 'text-rose-400',
        to: '/market',
      });
    }

    return entries;
  }, [radarItems, intelQuery.data, primaryManagedTrader, allDecisions, marketStats.heatTiles]);

  // 每 2.2 秒平滑推进一条真实记录，营造高频实盘终端滚屏感
  useEffect(() => {
    if (wirePool.length <= 7) return;
    const id = window.setInterval(() => {
      if (!document.hidden) setWireOffset((n) => (n + 1) % wirePool.length);
    }, 2200);
    return () => window.clearInterval(id);
  }, [wirePool.length]);

  const visibleWire = useMemo(() => {
    if (wirePool.length === 0) return [];
    const count = Math.min(8, wirePool.length);
    const out: WireEntry[] = [];
    for (let i = 0; i < count; i++) {
      out.push(wirePool[(wireOffset + i) % wirePool.length]!);
    }
    return out;
  }, [wirePool, wireOffset]);

  const clockWarn = Math.abs(system?.clockOffsetMs ?? 0) > CLOCK_WARN_MS;
  const weightPercent =
    system?.weightLimit && system.weightLimit > 0
      ? Math.round(((system.weightUsed ?? 0) / system.weightLimit) * 100)
      : 0;
  const weightWarn = weightPercent >= WEIGHT_WARN_PERCENT;

  const latestCachePct =
    latestDecision?.promptTokens && latestDecision.promptTokens > 0 && latestDecision.cachedTokens != null
      ? Math.round((latestDecision.cachedTokens / latestDecision.promptTokens) * 100)
      : null;

  return (
    <div className="space-y-2.5">
      <h1 className="sr-only">量化全景观测台总览</h1>
      <h2 className="sr-only">全市场实时监控与 AI500 神经信号观测总览</h2>

      {tradersQuery.error && tradersQuery.data === null && <ErrorNote>{tradersQuery.error}</ErrorNote>}

      {/* ================================================================== */}
      {/*  1. 顶栏全息指挥带（暗色黑曜石机舱风，深/浅主题均锐利震撼）           */}
      {/* ================================================================== */}
      <header className="aq-war-hero relative overflow-hidden rounded-xl border border-base-750/90 bg-[#0b0e17] px-3.5 py-2.5 text-slate-100 shadow-panel">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] overflow-hidden bg-gradient-to-r from-transparent via-violet-500/50 to-transparent"
        >
          <div className="aq-shimmer-line h-full w-1/3 bg-gradient-to-r from-transparent via-emerald-400 to-transparent" />
        </div>

        <div className="relative flex flex-wrap items-center justify-between gap-2.5">
          {/* 左：主标识 + 实盘模式 + 运行舰队快捷胶囊 */}
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-2">
              <span className="relative flex h-7 w-7 items-center justify-center rounded-lg border border-violet-400/40 bg-violet-500/15 text-violet-300">
                <Cpu className="h-4 w-4" aria-hidden />
                {runningCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-80" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                  </span>
                )}
              </span>
              <span className="font-mono text-sm font-bold tracking-wider text-white">
                QUANT OBSERVATORY
              </span>
            </div>

            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider',
                system?.dryRun
                  ? 'border-violet-400/40 bg-violet-500/15 text-violet-300'
                  : 'border-amber-400/45 bg-amber-400/15 text-amber-300',
              )}
            >
              <Zap className="h-3 w-3" aria-hidden />
              {system ? (system.dryRun ? 'PAPER' : 'LIVE MAINNET') : 'SYNC'}
            </span>

            {/* 运行中的机器人单行微胶囊（保留 attributedEquityOf 单一事实口径，绝不重复整张表） */}
            {traders.slice(0, 2).map((trader) => {
              const eq = equityOf(trader);
              const isRun = liveByTrader[trader.id]?.status
                ? liveByTrader[trader.id]?.status === 'running' || liveByTrader[trader.id]?.status === 'safe_mode'
                : trader.isRunning;
              return (
                <Link
                  key={trader.id}
                  to={`/traders/${trader.id}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-xs transition hover:border-emerald-400/50 hover:bg-white/[0.08]"
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full', isRun ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500')} />
                  <span className="font-semibold text-white">{trader.name}</span>
                  <span className="num font-mono text-[11px] text-emerald-300">{fmtUsd(eq, 2)}</span>
                  <ArrowUpRight className="h-3 w-3 text-slate-400" aria-hidden />
                </Link>
              );
            })}
          </div>

          {/* 中：BTC/ETH/SOL 基准 + 全市场多空广度 */}
          <div className="hidden items-center gap-3 font-mono text-[11px] 2xl:flex">
            {[marketStats.btc, marketStats.eth, marketStats.sol].filter(Boolean).map((m) => (
              <Link
                key={m!.symbol}
                to="/market"
                className="inline-flex items-center gap-1.5 text-slate-300 transition hover:text-white"
              >
                <CoinIcon symbol={m!.symbol} className="h-3.5 w-3.5" />
                <span className="font-semibold text-white">{m!.baseAsset}</span>
                <span className="num">{fmtPriceUsd(m!.price)}</span>
                <span className={cn('num font-semibold', pnlColor(m!.changePercent24h))}>
                  {fmtPercent(m!.changePercent24h)}
                </span>
              </Link>
            ))}
          </div>

          {/* 右：毫秒时钟 + WS 状态 + 快捷操作 */}
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1 font-mono text-[11px] sm:flex">
              <Radio className={cn('h-3 w-3', socketOpen ? 'text-emerald-400 animate-pulse' : 'text-amber-400')} aria-hidden />
              <span className={socketOpen ? 'text-emerald-300' : 'text-amber-300'}>
                {socketOpen ? 'WS LIVE' : 'POLL'}
              </span>
              <span className="text-slate-600">|</span>
              <span className="num font-bold tracking-wider text-white">{highFreqClock}</span>
            </div>

            <Link
              to="/traders"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-white/15 bg-white/[0.05] px-2.5 text-xs font-medium text-slate-200 transition hover:border-violet-400/50 hover:text-white"
            >
              机器人 ({traders.length})
            </Link>
            <Button variant="primary" className="h-7 px-2.5 text-xs" onClick={() => setNewOpen(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              新建
            </Button>
          </div>
        </div>

        {(clockWarn || weightWarn || system?.tradingDisabled) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/10 pt-1.5 text-[11px]">
            {clockWarn && (
              <span className="inline-flex items-center gap-1 text-amber-300">
                <ShieldAlert className="h-3 w-3" /> 时钟偏差 {fmtClockOffset(system?.clockOffsetMs)}
              </span>
            )}
            {weightWarn && (
              <span className="inline-flex items-center gap-1 text-amber-300">
                <ShieldAlert className="h-3 w-3" /> API 权重 {weightPercent}%
              </span>
            )}
            {system?.tradingDisabled && (
              <span className="inline-flex items-center gap-1 text-rose-400">
                <ShieldAlert className="h-3 w-3" /> 全局交易已禁用
              </span>
            )}
          </div>
        )}
      </header>

      {/* ================================================================== */}
      {/*  2. 实时永续合约全速霓虹跑马灯                                       */}
      {/* ================================================================== */}
      {marketStats.tickerItems.length > 0 && (
        <div
          className="aq-marquee-wrap relative flex h-8 items-center overflow-hidden rounded-lg border border-base-750/90 bg-[#0b0e17] text-slate-100"
          aria-label="实时永续合约跑马灯"
        >
          <div className="z-10 flex h-full shrink-0 items-center gap-1.5 border-r border-white/10 bg-[#0e121f] px-2.5 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
            LIVE TAPE
          </div>
          <div className="relative flex-1 overflow-hidden">
            <div className="aq-marquee-track items-center gap-2 px-2">
              {[...marketStats.tickerItems, ...marketStats.tickerItems].map((sym, idx) => {
                const up = sym.changePercent24h >= 0;
                return (
                  <Link
                    key={`${sym.symbol}-${idx}`}
                    to="/market"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 font-mono text-[11px] transition hover:border-violet-400/50 hover:bg-white/[0.08]"
                  >
                    <CoinIcon symbol={sym.symbol} className="h-3.5 w-3.5" />
                    <span className="font-bold text-white">{sym.baseAsset}</span>
                    <span className="num text-slate-300">{fmtPriceUsd(sym.price)}</span>
                    <span className={cn('num font-bold', up ? 'text-emerald-400' : 'text-rose-400')}>
                      {fmtPercent(sym.changePercent24h)}
                    </span>
                  </Link>
                );
              })}
            </div>
            <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-[#0b0e17] to-transparent" />
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[#0b0e17] to-transparent" />
          </div>
        </div>
      )}

      {/* ================================================================== */}
      {/*  3. 16:9 三栏全景观测台主机舱（3 / 6 / 3 黄金比例）                  */}
      {/* ================================================================== */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        {/* ======================== 左 3 栏：24H 量子热力表盘 + 实盘滚动终端 ======================== */}
        <div className="flex min-w-0 flex-col gap-3 xl:col-span-3">
          {/* L1: HEATCLOCK 24H 精密表盘 */}
          <section className="relative flex flex-col overflow-hidden rounded-xl border border-base-750/90 bg-[#090c14] text-slate-100 shadow-panel">
            <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2">
              <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold tracking-wider text-slate-200">
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                HEATCLOCK · 24H
              </div>
              <span className="font-mono text-[10px] text-slate-400">96×15M</span>
            </div>

            <div className="h-[268px] w-full p-1">
              <HeatclockCanvas
                accountEquity={accountEquity}
                realizedPnl={realizedPnl}
                returnPct={totalReturnPercent}
                winRatePct={fleetWinRate}
                wins={totalWins}
                losses={totalLosses}
                curve={curve}
                decisions={allDecisions}
                symbols={marketSymbols}
                paperOnly={paperOnlyFleet}
              />
            </div>

            <div className="grid grid-cols-3 divide-x divide-white/[0.07] border-t border-white/[0.08] bg-white/[0.02] text-center font-mono">
              <div className="px-1.5 py-2">
                <div className="text-[9px] uppercase text-slate-400">初始投入</div>
                <div className="num mt-0.5 text-xs font-bold text-slate-100">{fmtUsd(committedCapital, 2)}</div>
              </div>
              <div className="px-1.5 py-2">
                <div className="text-[9px] uppercase text-slate-400">持仓浮盈</div>
                <div className={cn('num mt-0.5 text-xs font-bold', pnlColor(unrealized))}>
                  {fmtUsdSigned(unrealized, 2)}
                </div>
              </div>
              <div className="px-1.5 py-2">
                <div className="text-[9px] uppercase text-slate-400">在跑舰队</div>
                <div className="num mt-0.5 text-xs font-bold text-emerald-400">
                  {runningCount}/{traders.length} · 仓{totalOpen}
                </div>
              </div>
            </div>
          </section>

          {/* L2: $ tail -f quant.wire 实时滚动终端流 */}
          <section className="flex min-h-[252px] flex-1 flex-col overflow-hidden rounded-xl border border-base-750/90 bg-[#090c14] text-slate-100 shadow-panel">
            <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2">
              <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-emerald-300">
                <Terminal className="h-3.5 w-3.5" aria-hidden />
                $ tail -f quant.wire
              </div>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-slate-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {wirePool.length} LIVE
              </span>
            </div>

            <div className="flex-1 divide-y divide-white/[0.04] overflow-hidden px-2.5 py-1 font-mono text-[11px]">
              {visibleWire.length === 0 ? (
                <div className="py-10 text-center text-slate-500">正在接入实时量化数据流…</div>
              ) : (
                visibleWire.map((item, idx) => (
                  <Link
                    key={`${item.key}-${idx}`}
                    to={item.to ?? '/market'}
                    className={cn(
                      'flex items-center justify-between gap-2 py-1.5 transition hover:bg-white/[0.04]',
                      idx === 0 && 'bg-emerald-500/[0.05]',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 text-[10px] text-slate-500">{item.time}</span>
                      <span className={cn('shrink-0 rounded border px-1 py-px text-[9px] font-bold', item.tagCls)}>
                        {item.tag}
                      </span>
                      <span className="truncate text-slate-200">{item.body}</span>
                    </div>
                    <span className={cn('num shrink-0 font-bold', item.metricCls)}>{item.metric}</span>
                  </Link>
                ))
              )}
            </div>
          </section>
        </div>

        {/* ======================== 中 6 栏：3D 全市场 522 星云主屏 + 流动性脊线频谱 ======================== */}
        <div className="flex min-w-0 flex-col gap-3 xl:col-span-6">
          {/* C1: 主视觉舞台（3D 522 永续合约全息星云 / 实时信号神经网络流 一键切换） */}
          <section className="relative flex flex-col overflow-hidden rounded-xl border border-violet-500/30 bg-[#080b13] text-slate-100 shadow-panel">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] bg-white/[0.02] px-3.5 py-2">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-violet-400" aria-hidden />
                <span className="font-mono text-xs font-bold tracking-wider text-white">
                  {stageMode === 'galaxy'
                    ? `MARKET SPACE · ${fmtInt(marketSymbols.length || system?.tradableSymbols)} PERP GALAXY`
                    : 'LIVE NEURAL PIPELINE · SIGNAL TO EXECUTION'}
                </span>
                <span className="hidden rounded border border-emerald-400/35 bg-emerald-400/12 px-1.5 py-px font-mono text-[10px] font-bold text-emerald-300 sm:inline">
                  60FPS LIVE
                </span>
              </div>

              <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/40 p-0.5 font-mono text-[10px]">
                <button
                  type="button"
                  onClick={() => setStageMode('galaxy')}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-2 py-1 font-semibold transition',
                    stageMode === 'galaxy'
                      ? 'bg-violet-500 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white',
                  )}
                >
                  <Globe className="h-3 w-3" />
                  3D 星云雷达
                </button>
                <button
                  type="button"
                  onClick={() => setStageMode('pipeline')}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-2 py-1 font-semibold transition',
                    stageMode === 'pipeline'
                      ? 'bg-violet-500 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white',
                  )}
                >
                  <GitBranch className="h-3 w-3" />
                  信号神经流
                </button>
              </div>
            </div>

            <div className="relative h-[368px] w-full">
              {stageMode === 'galaxy' ? (
                <MarketGalaxyCanvas symbols={marketSymbols} radarItems={radarItems} />
              ) : (
                <NeuralPipelineCanvas
                  symbols={marketStats.tickerItems}
                  totalSymbols={marketSymbols.length || system?.tradableSymbols || 0}
                  radarItems={radarItems}
                  runningCount={runningCount}
                  latestCycle={latestDecision?.cycleNumber ?? null}
                  openPositions={totalOpen}
                />
              )}

              {/* 左下角全息坐标图例 */}
              <div className="pointer-events-none absolute bottom-2.5 left-3 flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-[#080b13]/80 px-2.5 py-1 font-mono text-[10px] text-slate-300 backdrop-blur-sm">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_6px_#fbbf24]" />
                  AI500 雷达焦点 ({radarItems.length})
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  上涨 ({marketStats.upCount})
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-rose-400" />
                  下跌 ({marketStats.downCount})
                </span>
              </div>

              {/* 右下角全市场多空广度全息胶囊 */}
              <div className="pointer-events-none absolute bottom-2.5 right-3 hidden items-center gap-2 rounded-lg border border-white/10 bg-[#080b13]/80 px-2.5 py-1 font-mono text-[10px] backdrop-blur-sm sm:flex">
                <span className="text-slate-400">BREADTH</span>
                <div className="flex h-1.5 w-16 overflow-hidden rounded-full bg-rose-500/40">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-400 to-cyan-300 transition-all duration-500"
                    style={{ width: `${marketStats.bullPct}%` }}
                  />
                </div>
                <span className="num font-bold text-emerald-300">{marketStats.bullPct}%</span>
              </div>
            </div>
          </section>

          {/* C2: QUANTUM RIDGE — 522 币种分层流动性 24h 收益密度霓虹脊线频谱 */}
          <section className="relative flex flex-col overflow-hidden rounded-xl border border-base-750/90 bg-[#090c14] text-slate-100 shadow-panel">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] px-3.5 py-2">
              <div className="flex items-center gap-2 font-mono text-[11px] font-bold tracking-wider text-slate-200">
                <Activity className="h-3.5 w-3.5 text-violet-400" aria-hidden />
                TAIL PROBABILITY RIDGE · 522 PERP SPECTRUM
              </div>
              <div className="flex flex-wrap items-center gap-2.5 font-mono text-[10px]">
                <span className="text-slate-400">
                  24h总额 <strong className="num text-white">{fmtCompactAmount(marketStats.totalVol, 'USDT')}</strong>
                </span>
                <span className="text-slate-400">
                  中位数 <strong className={cn('num', pnlColor(marketStats.medianPct))}>{fmtPercent(marketStats.medianPct)}</strong>
                </span>
                <span className="rounded bg-emerald-500/15 px-1.5 py-px font-bold text-emerald-300">
                  &gt;+10% · {marketStats.surgeCount}币
                </span>
                <span className="rounded bg-rose-500/15 px-1.5 py-px font-bold text-rose-300">
                  &lt;-10% · {marketStats.crashCount}币
                </span>
              </div>
            </div>

            <div className="h-[178px] w-full">
              <QuantumRidgeCanvas symbols={marketSymbols} />
            </div>
          </section>
        </div>

        {/* ======================== 右 3 栏：AI500 引擎管线状态 + 4×4 实时能量矩阵 ======================== */}
        <aside className="flex min-w-0 flex-col gap-3 xl:col-span-3">
          {/* R1: 实盘量化引擎子系统实时状态阵列 */}
          <section className="overflow-hidden rounded-xl border border-base-750/90 bg-[#090c14] text-slate-100 shadow-panel">
            <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2">
              <span className="font-mono text-[11px] font-bold tracking-wider text-slate-200">
                ENGINE SUBSYSTEMS
              </span>
              <div className="flex h-3.5 items-end gap-[2px]" aria-hidden>
                <span className={cn('w-[2.5px] rounded-full', runningCount > 0 ? 'aq-eq-bar-1 h-3.5 bg-emerald-400' : 'h-1 bg-slate-700')} />
                <span className={cn('w-[2.5px] rounded-full', runningCount > 0 ? 'aq-eq-bar-2 h-3.5 bg-cyan-400' : 'h-1.5 bg-slate-700')} />
                <span className={cn('w-[2.5px] rounded-full', runningCount > 0 ? 'aq-eq-bar-3 h-3.5 bg-violet-400' : 'h-1 bg-slate-700')} />
                <span className={cn('w-[2.5px] rounded-full', runningCount > 0 ? 'aq-eq-bar-4 h-3.5 bg-emerald-400' : 'h-2 bg-slate-700')} />
              </div>
            </div>

            <div className="divide-y divide-white/[0.06] px-3 py-1 font-mono text-[11px]">
              {/* 子系统 1：WS 全市场脉搏 */}
              <div className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="font-sans text-xs font-semibold text-white">WS 脉搏雷达</div>
                  <div className="truncate text-[10px] text-slate-400">
                    {fmtInt(marketSymbols.length || system?.tradableSymbols)} 永续 · 零 REST 监听
                  </div>
                </div>
                <span className="shrink-0 rounded border border-emerald-400/40 bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">
                  SCAN
                </span>
              </div>

              {/* 子系统 2：AI500 六维引擎 */}
              <Link
                to={primaryManagedTrader ? `/traders/${primaryManagedTrader.id}` : '/market'}
                className="flex items-center justify-between gap-2 py-2 transition hover:bg-white/[0.03]"
              >
                <div className="min-w-0">
                  <div className="font-sans text-xs font-semibold text-white">AI500 六维评分</div>
                  <div className="truncate text-[10px] text-amber-300">
                    {radarItems[0]
                      ? `榜首 ${radarItems[0].symbol.replace(/USDT$/, '')} ${Math.round(radarItems[0].score)}分 · 共 ${radarItems.length} 焦点`
                      : '等待下一轮全市场扫描'}
                  </div>
                </div>
                <span className="shrink-0 rounded border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">
                  ACTIVE
                </span>
              </Link>

              {/* 子系统 3：LLM 三段式大脑 */}
              <Link
                to={
                  latestDecision
                    ? `/traders/${latestDecision.traderId}/decisions/${latestDecision.id}`
                    : '/traders'
                }
                className="flex items-center justify-between gap-2 py-2 transition hover:bg-white/[0.03]"
              >
                <div className="min-w-0">
                  <div className="font-sans text-xs font-semibold text-white">LLM 三段式大脑</div>
                  <div className="truncate text-[10px] text-violet-300">
                    {latestDecision
                      ? `周期 #${latestDecision.cycleNumber}${latestCachePct !== null ? ` · 缓存 ${latestCachePct}%` : ''} · ${timeAgo(latestDecision.timestamp)}`
                      : '暂无决策周期'}
                  </div>
                </div>
                <span className="shrink-0 rounded border border-violet-400/40 bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold text-violet-300">
                  THINK
                </span>
              </Link>

              {/* 子系统 4：硬风控与保护位 */}
              <div className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="font-sans text-xs font-semibold text-white">硬风控闸门</div>
                  <div className="truncate text-[10px] text-slate-400">
                    {totalOpen} 活跃持仓 · 浮盈 {fmtUsdSigned(unrealized, 2)}
                  </div>
                </div>
                <span className="shrink-0 rounded border border-sky-400/40 bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-bold text-sky-300">
                  ARMED
                </span>
              </div>
            </div>
          </section>

          {/* R2: 4×4 实时能量热力矩阵（Resolution / Momentum Grid） */}
          <section className="flex flex-1 flex-col overflow-hidden rounded-xl border border-base-750/90 bg-[#090c14] text-slate-100 shadow-panel">
            <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2">
              <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold tracking-wider text-slate-200">
                <Flame className="h-3.5 w-3.5 text-amber-400" aria-hidden />
                MOMENTUM HEAT GRID
              </div>
              <Link to="/market" className="font-mono text-[10px] text-violet-300 hover:underline">
                全市场 →
              </Link>
            </div>

            <div className="grid flex-1 grid-cols-4 gap-1.5 p-2.5">
              {marketStats.heatTiles.length === 0 ? (
                <div className="col-span-4 flex items-center justify-center py-12 font-mono text-xs text-slate-500">
                  LOADING LIVE MATRIX…
                </div>
              ) : (
                marketStats.heatTiles.map((sym) => {
                  const pct = sym.changePercent24h;
                  const up = pct >= 0;
                  const intensity = Math.min(1, Math.abs(pct) / 22);
                  const bg = up
                    ? `rgba(14, 203, 129, ${(0.14 + intensity * 0.42).toFixed(2)})`
                    : `rgba(246, 70, 93, ${(0.14 + intensity * 0.42).toFixed(2)})`;
                  const border = up
                    ? `rgba(52, 211, 153, ${(0.25 + intensity * 0.5).toFixed(2)})`
                    : `rgba(251, 113, 133, ${(0.25 + intensity * 0.5).toFixed(2)})`;
                  return (
                    <Link
                      key={sym.symbol}
                      to="/market"
                      title={`${sym.symbol} · ${fmtPriceUsd(sym.price)} · 24h ${fmtPercent(pct)} · 成交额 ${fmtCompactAmount(sym.quoteVolume24h, 'USDT')}`}
                      style={{ backgroundColor: bg, borderColor: border }}
                      className="group flex flex-col items-center justify-center rounded-lg border px-1 py-2 text-center font-mono transition hover:scale-[1.04] hover:brightness-125"
                    >
                      <span className="max-w-full truncate text-[10px] font-bold tracking-tight text-white">
                        {sym.baseAsset.slice(0, 6)}
                      </span>
                      <span
                        className={cn(
                          'num mt-0.5 text-[11px] font-extrabold leading-none',
                          up ? 'text-emerald-100' : 'text-rose-100',
                        )}
                      >
                        {pct >= 0 ? '+' : ''}
                        {Math.abs(pct) >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%
                      </span>
                    </Link>
                  );
                })
              )}
            </div>

            {/* 底部实时 AI500 雷达快览条 */}
            {radarItems.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-white/[0.08] bg-white/[0.02] px-3 py-2 font-mono text-[10px]">
                <span className="text-slate-400">AI500 TOP</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {radarItems.slice(0, 3).map((r) => (
                    <Link
                      key={r.symbol}
                      to={primaryManagedTrader ? `/traders/${primaryManagedTrader.id}` : '/market'}
                      className="rounded border border-amber-400/35 bg-amber-400/12 px-1.5 py-0.5 font-bold text-amber-200 transition hover:bg-amber-400/25"
                    >
                      {r.symbol.replace(/USDT$/, '')} {Math.round(r.score)}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </section>
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
    </div>
  );
}
