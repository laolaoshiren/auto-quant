/**
 * 智能托管 2.0 周期编排层（`packages/server/src/managed/cycle.ts`）
 *
 * 将「AI500 六维全市场雷达扫描 → Top 3–5 + 持仓黄金三周期 K 线拉取 → 筹码结构 & 清算磁吸计算 →
 * 15m 环比增量 Δ → 快照回补」封装在 `managed/` 独立目录内。
 *
 * `autoTrader.ts` 仅需在 `mode === 'ai_managed'` 处做极薄委托，不往 1.47 万行主文件堆业务代码。
 */

import type { Kline, MarketSnapshot, StrategyConfig } from '@aq/shared';

import type { SymbolRegistry } from '../binance/symbols.js';
import { createLogger } from '../logger.js';
import type { MarketPort } from '../market/port.js';
import type { MarketDataService } from '../market/service.js';
import {
  AI500_DEFAULTS,
  computeReturnPct,
  filterRadarUniverse,
  rankAi500Candidates,
  scoreAi500Symbol,
  selectPrescreenSymbols,
  type Ai500Candidate,
  type Ai500Weights,
  type RadarUniverseRow,
} from '../radar/ai500.js';
import type { RadarDeltaTracker } from '../radar/deltaTracker.js';
import { getSharedMarketPulse } from '../radar/marketPulse.js';
import { computeVolumeProfile, formatCompactPrice } from '../radar/volumeProfile.js';
import { MANAGED_KLINE_BARS, type ManagedSymbolDossier } from './prompt.js';

const log = createLogger('managed:cycle');

const CONCURRENCY = 6;
const TOP_RADAR_PICKS = 4; // 展开 Top 4 高分候选 + 全部当前持仓，让 Prompt 稳稳落在 18K–26K 甜点区

/* -------------------------------------------------------------------------- */
/*  Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface ManagedCycleInput {
  config: StrategyConfig;
  market: MarketPort;
  marketData: MarketDataService;
  registry: SymbolRegistry;
  deltaTracker: RadarDeltaTracker;
  /** 本轮当前持仓标的（必须无条件展开）。 */
  heldSymbols: readonly string[];
  /** 观察名单标的（优先进入初筛）。 */
  watchedSymbols: readonly string[];
  /** 上游已有快照（用于 static 模式或测试替身无缝降级）。 */
  existingSnapshots: readonly MarketSnapshot[];
  /** 标的单笔最小名义额与杠杆上限映射（可选，用于提示词）。 */
  leverageCaps?: ReadonlyMap<string, number>;
  /** M4.3：来自成交归因引擎的校准权重与准入红线（缺省沿用基准）。 */
  calibration?: {
    weights?: Partial<Ai500Weights>;
    strongThreshold?: number;
    watchThreshold?: number;
  };
  nowMs?: number;
}

export interface ManagedCycleResult {
  /** 已组装好的深度展开标的档案（持仓在前 + Top 雷达高分在后）。 */
  dossiers: ManagedSymbolDossier[];
  /** 全市场雷达 Top 10 极简榜。 */
  radarLeaderboard: Ai500Candidate[];
  /** 需要并入本轮 `snapshots` 以通过风控与解析器校验的完整快照列表。 */
  snapshots: MarketSnapshot[];
  /** BTC 市场基准单行摘要。 */
  btcBenchmarkLine: string | null;
  /** 写入运行日志与审计摘要的一句话雷达战报。 */
  radarSummaryLine: string;
}

/* -------------------------------------------------------------------------- */
/*  Bounded Concurrency Helper                                                 */
/* -------------------------------------------------------------------------- */

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const current = idx;
      idx += 1;
      out[current] = await worker(items[current]!);
    }
  });
  await Promise.all(runners);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Core Orchestrator                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 执行一次 `ai_managed` 2.0 雷达扫描与标的档案组装。
 *
 * 两条路径自动适配：
 *  - **实时动态全市场路径**（生产与动态源）：通过 `marketData.getUniverseOverview()` 扫描全市场永续合约，
 *    过滤流动性 → 初筛 Top 24 活跃标的 → 并发拉取 `15m(96)` + `4h(60)` + OI 变化 → AI500 六维打分 →
 *    选出 Top 4 + 全部持仓 → 仅对展开标的补拉 `1m(30)` + 计算筹码结构 + 15m Δ。
 *  - **静态 / 单测降级路径**（`sourceType === 'static'` 或 mock 未提供全市场视图）：
 *    直接对 `existingSnapshots` 执行完整 AI500 评分 + 筹码结构 + 15m Δ，零报错兼容所有测试夹具。
 */
export async function runManagedRadarCycle(input: ManagedCycleInput): Promise<ManagedCycleResult> {
  const nowMs = input.nowMs ?? Date.now();
  const heldSet = new Set(input.heldSymbols);
  const alwaysSet = new Set<string>([...input.heldSymbols, ...input.watchedSymbols, 'BTCUSDT']);

  const snapshotBySymbol = new Map<string, MarketSnapshot>(
    input.existingSnapshots.map((s) => [s.symbol, s]),
  );

  // 1) 判断是否走全市场雷达扫描（static 模式尊重显式静态白名单）
  const useUniverseScan =
    input.config.coinSource.sourceType !== 'static' &&
    typeof (input.marketData as { getUniverseOverview?: unknown }).getUniverseOverview === 'function';

  let universeRows: RadarUniverseRow[] = [];
  if (useUniverseScan) {
    universeRows = await input.marketData.getUniverseOverview().catch((err) => {
      log.warn(`AI500 雷达全市场拉取失败，降级使用基础候选快照：${(err as Error).message}`);
      return [];
    });
  }

  // 若全市场视图可用且非空 → 全市场 AI500 扫描；否则无缝降级到已有快照
  const rawInputs = new Map<
    string,
    {
      row: RadarUniverseRow;
      klines15m: Kline[];
      klines4h: Kline[];
      openInterestUsd: number | null;
      oiChange1hPct: number | null;
      oiChange4hPct: number | null;
    }
  >();

  const safeGetKlines = async (sym: string, tf: '4h' | '15m' | '1m', count: number): Promise<Kline[]> => {
    try {
      if (typeof input.marketData.getKlines === 'function') {
        const res = await input.marketData.getKlines(sym, tf, count);
        if (Array.isArray(res) && res.length > 0) return res;
      }
    } catch {
      /* 降级用已有快照 K 线 */
    }
    const snap = snapshotBySymbol.get(sym);
    if (!snap) return [];
    const match = snap.timeframes.find((t) => t.timeframe === tf);
    if (match && match.klines.length > 0) return match.klines;
    if (snap.primary.timeframe === tf) return snap.primary.klines;
    // 测试夹具可能只有 primary 5m K 线，仅在 15m/4h 全缺时作最后兜底
    return tf === '15m' ? snap.primary.klines : [];
  };

  const safeGetOi = async (
    sym: string,
    price: number,
  ): Promise<{ oiUsd: number | null; ch1h: number | null; ch4h: number | null }> => {
    const snap = snapshotBySymbol.get(sym);
    if (snap?.derivatives?.openInterestUsd) {
      return {
        oiUsd: snap.derivatives.openInterestUsd,
        ch1h: snap.derivatives.openInterestChangePercent?.['1h'] ?? null,
        ch4h: snap.derivatives.openInterestChangePercent?.['4h'] ?? null,
      };
    }
    if (
      typeof input.market?.openInterest !== 'function' ||
      typeof input.market?.openInterestHist !== 'function'
    ) {
      return { oiUsd: null, ch1h: null, ch4h: null };
    }
    try {
      const [oi, hist] = await Promise.all([
        input.market.openInterest(sym).catch(() => null),
        input.market.openInterestHist(sym, '1h', 6).catch(() => []),
      ]);
      const oiUsd = oi !== null && price > 0 ? oi * price : null;
      let ch1h: number | null = null;
      let ch4h: number | null = null;
      const vals = hist.map((h) => Number(h.sumOpenInterest)).filter((v) => Number.isFinite(v) && v > 0);
      if (vals.length >= 2) {
        const latest = vals[vals.length - 1]!;
        const prev1 = vals[vals.length - 2]!;
        ch1h = ((latest - prev1) / prev1) * 100;
        if (vals.length >= 5) {
          const prev4 = vals[vals.length - 5]!;
          ch4h = ((latest - prev4) / prev4) * 100;
        }
      }
      return { oiUsd, ch1h, ch4h };
    } catch {
      return { oiUsd: null, ch1h: null, ch4h: null };
    }
  };

  if (universeRows.length > 0) {
    const minVol = Math.max(
      AI500_DEFAULTS.minQuoteVolume24h,
      input.config.coinSource.minQuoteVolume24h ?? 0,
    );
    const liquid = filterRadarUniverse(universeRows, {
      minQuoteVolume24h: minVol,
      excludeStablecoins: input.config.coinSource.excludeStablecoins ?? true,
      alwaysInclude: alwaysSet,
    });
    const pulseSymbols = getSharedMarketPulse().getHotSymbols({
      limit: 8,
      minQuoteVolume24h: minVol,
      nowMs,
    });
    const prescreened = selectPrescreenSymbols(liquid, {
      limit: AI500_DEFAULTS.prescreenLimit,
      alwaysInclude: alwaysSet,
      pulseSymbols,
    });
    if (pulseSymbols.length > 0) {
      log.debug(`AI500 WS 脉冲提名 ${pulseSymbols.length} 标的：${pulseSymbols.join(', ')}`);
    }
    const rowBySym = new Map(liquid.map((r) => [r.symbol, r]));

    await mapConcurrent(prescreened, CONCURRENCY, async (sym) => {
      const row = rowBySym.get(sym);
      if (!row) return;
      const [k15, k4h, oi] = await Promise.all([
        safeGetKlines(sym, '15m', 96),
        safeGetKlines(sym, '4h', 60),
        safeGetOi(sym, row.price),
      ]);
      if (k15.length === 0 && k4h.length === 0) return;
      rawInputs.set(sym, {
        row,
        klines15m: k15,
        klines4h: k4h,
        openInterestUsd: oi.oiUsd,
        oiChange1hPct: oi.ch1h,
        oiChange4hPct: oi.ch4h,
      });
    });
  } else {
    // 静态 / 降级路径：直接复用 existingSnapshots
    for (const snap of input.existingSnapshots) {
      const [k15, k4h] = await Promise.all([
        safeGetKlines(snap.symbol, '15m', 96),
        safeGetKlines(snap.symbol, '4h', 60),
      ]);
      rawInputs.set(snap.symbol, {
        row: {
          symbol: snap.symbol,
          price: snap.price,
          quoteVolume24h: snap.quoteVolume24h,
          changePercent24h: snap.priceChangePercent24h,
          high24h: snap.high24h,
          low24h: snap.low24h,
          fundingRate: snap.derivatives?.fundingRate ?? null,
          openInterestUsd: snap.derivatives?.openInterestUsd ?? null,
        },
        klines15m: k15.length > 0 ? k15 : snap.primary.klines,
        klines4h: k4h,
        openInterestUsd: snap.derivatives?.openInterestUsd ?? null,
        oiChange1hPct: snap.derivatives?.openInterestChangePercent?.['1h'] ?? null,
        oiChange4hPct: snap.derivatives?.openInterestChangePercent?.['4h'] ?? null,
      });
    }
  }

  // 2) 计算 BTC 市场基准涨跌幅（用于 RS Alpha）
  const btcEntry = rawInputs.get('BTCUSDT');
  const btcReturn1hPct = btcEntry ? computeReturnPct(btcEntry.klines15m, 4) : null;
  const btcReturn4hPct = btcEntry
    ? btcEntry.klines15m.length >= 17
      ? computeReturnPct(btcEntry.klines15m, 16)
      : computeReturnPct(btcEntry.klines4h, 1)
    : null;
  const btcBenchmarkLine = btcEntry
    ? `BTCUSDT ${formatCompactPrice(btcEntry.row.price)} · 1h ${btcReturn1hPct !== null ? `${btcReturn1hPct >= 0 ? '+' : ''}${btcReturn1hPct.toFixed(1)}%` : 'N/A'} · 4h ${btcReturn4hPct !== null ? `${btcReturn4hPct >= 0 ? '+' : ''}${btcReturn4hPct.toFixed(1)}%` : 'N/A'} · 24h ${btcEntry.row.changePercent24h >= 0 ? '+' : ''}${btcEntry.row.changePercent24h.toFixed(1)}%`
    : null;

  // 3) 执行六维 AI500 评分并排序
  const scored: Ai500Candidate[] = [];
  for (const [sym, item] of rawInputs) {
    // 若配置了严格流动性底线，OI 显著低于 5M 的非持仓山寨跳过
    if (
      !heldSet.has(sym) &&
      item.openInterestUsd !== null &&
      item.openInterestUsd < AI500_DEFAULTS.minOpenInterestUsd &&
      universeRows.length > 0
    ) {
      continue;
    }
    scored.push(
      scoreAi500Symbol(
        {
          symbol: sym,
          price: item.row.price,
          quoteVolume24h: item.row.quoteVolume24h,
          changePercent24h: item.row.changePercent24h,
          fundingRate: item.row.fundingRate,
          klines15m: item.klines15m,
          klines4h: item.klines4h,
          openInterestUsd: item.openInterestUsd,
          oiChange1hPct: item.oiChange1hPct,
          oiChange4hPct: item.oiChange4hPct,
          btcReturn1hPct,
          btcReturn4hPct,
        },
        {
          strongThreshold: input.calibration?.strongThreshold,
          watchThreshold: input.calibration?.watchThreshold,
          weights: input.calibration?.weights,
        },
      ),
    );
  }

  const rankResult = rankAi500Candidates(scored, {
    topN: TOP_RADAR_PICKS,
    strongThreshold: input.calibration?.strongThreshold,
    watchThreshold: input.calibration?.watchThreshold,
  });
  const scoreBySym = new Map(rankResult.ranked.map((c) => [c.symbol, c]));

  // 最终展开集合：全部当前持仓 + Top 4 雷达高分标的（去重）
  const expandOrder: string[] = [];
  const seen = new Set<string>();
  for (const sym of input.heldSymbols) {
    if (scoreBySym.has(sym) && !seen.has(sym)) {
      seen.add(sym);
      expandOrder.push(sym);
    }
  }
  for (const c of rankResult.topCandidates) {
    if (!seen.has(c.symbol)) {
      seen.add(c.symbol);
      expandOrder.push(c.symbol);
    }
  }

  // 4) 仅对展开标的并发补拉 1m(30) K 线 + 确保对应 MarketSnapshot 就绪（供风控与下单使用）
  const dossiers = await mapConcurrent(expandOrder, CONCURRENCY, async (sym) => {
    const item = rawInputs.get(sym)!;
    const radar = scoreBySym.get(sym)!;
    const [k1m, ensuredSnap] = await Promise.all([
      safeGetKlines(sym, '1m', MANAGED_KLINE_BARS),
      snapshotBySymbol.has(sym)
        ? Promise.resolve(snapshotBySymbol.get(sym)!)
        : typeof input.marketData.buildSnapshot === 'function'
          ? input.marketData
              .buildSnapshot(sym, input.config.indicators, ['ai500_radar'])
              .catch(() => null)
          : Promise.resolve(null),
    ]);

    if (ensuredSnap) snapshotBySymbol.set(sym, ensuredSnap);

    const vpKlines = item.klines15m.length >= 3 ? item.klines15m : item.klines4h;
    const volumeProfile = computeVolumeProfile(vpKlines, radar.metrics.price);
    const delta = input.deltaTracker.observe({
      symbol: sym,
      timestampMs: nowMs,
      score: radar.score,
      bias: radar.bias,
      price: radar.metrics.price,
      openInterestUsd: radar.metrics.openInterestUsd,
      takerBuyRatio1h: radar.metrics.takerBuyRatio1h,
      pocOffsetPct: volumeProfile?.pocOffsetPct ?? null,
    });

    const symInfo = input.registry.get(sym);
    const dossier: ManagedSymbolDossier = {
      symbol: sym,
      isHeld: heldSet.has(sym),
      radar,
      volumeProfile,
      delta,
      klines: {
        '4h': item.klines4h.slice(-MANAGED_KLINE_BARS),
        '15m': item.klines15m.slice(-MANAGED_KLINE_BARS),
        '1m': k1m.slice(-MANAGED_KLINE_BARS),
      },
      minNotionalUsd: symInfo?.minNotional,
      maxLeverage: input.leverageCaps?.get(sym),
    };
    return dossier;
  });

  // 保证返回给 AutoTrader 的 snapshots 包含所有展开标的 + 原有快照（持仓/雷达优先）
  const finalSnapshots: MarketSnapshot[] = [];
  const addedSnap = new Set<string>();
  for (const d of dossiers) {
    const s = snapshotBySymbol.get(d.symbol);
    if (s && !addedSnap.has(s.symbol)) {
      addedSnap.add(s.symbol);
      finalSnapshots.push(s);
    }
  }
  for (const s of input.existingSnapshots) {
    if (!addedSnap.has(s.symbol)) {
      addedSnap.add(s.symbol);
      finalSnapshots.push(s);
    }
  }

  const topSummary = rankResult.topCandidates
    .map((c) => `${c.symbol} ${c.score}分(${c.bias === 'long' ? '多' : c.bias === 'short' ? '空' : '中'})`)
    .join(' · ');
  const radarSummaryLine =
    `[AI500雷达] 扫描 ${rawInputs.size} 标的 → 强关注(≥75) ${rankResult.strongCount} · 观察(≥65) ${rankResult.watchCount}` +
    (topSummary ? ` · Top: ${topSummary}` : '');

  return {
    dossiers,
    radarLeaderboard: rankResult.ranked.slice(0, 10),
    snapshots: finalSnapshots,
    btcBenchmarkLine,
    radarSummaryLine,
  };
}
