/**
 * 智能托管 2.0 轻量异动雷达提前唤醒（`packages/server/src/managed/anomalyWake.ts`）
 *
 * 设计目标：
 *   - 常规周期默认 15 分钟（对齐 15m K 线收盘），但后台每 3 分钟跑一次纯数学轻量扫描（零 LLM 成本）；
 *   - 仅在捕捉到三类高价值重大异动时提前唤醒 LLM 决策：
 *       1. **当前持仓剧烈异动**（最新 15m K 线实体位移或振幅 ≥ 2.0×ATR15m 且达最低幅度底线）
 *       2. **大盘 BTC 剧烈异动**（最新 15m K 线实体位移或振幅 ≥ 2.0×ATR15m 且 ≥ 1.2%）
 *       3. **全市场新突发起爆机会**（未持仓、未挂单、非冷却标的，AI500 评分 ≥ 78 且带 `早期放量起爆`，或 ≥ 82 且 15m 量比 ≥ 1.8x）
 *   - 内置四道防刷屏护栏：距上轮完成 ≥ 3m、全局唤醒冷却 ≥ 5m、原定周期 ≤ 90s 时不重复唤醒、同标的 15m 冷却。
 */

import type { Kline, StrategyConfig } from '@aq/shared';

import { createLogger } from '../logger.js';
import { atr, last } from '../market/indicators.js';
import type { MarketDataService } from '../market/service.js';
import {
  AI500_DEFAULTS,
  computeReturnPct,
  filterRadarUniverse,
  scoreAi500Symbol,
  selectPrescreenSymbols,
  type Ai500Candidate,
  type Ai500Weights,
} from '../radar/ai500.js';

const log = createLogger('managed:anomaly');

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const ANOMALY_WATCH_DEFAULT_SECONDS = 180;
export const ANOMALY_MIN_SINCE_CYCLE_MS = 3 * 60_000;
export const ANOMALY_GLOBAL_COOLDOWN_MS = 5 * 60_000;
export const ANOMALY_SYMBOL_COOLDOWN_MS = 15 * 60_000;
export const ANOMALY_SKIP_IF_NEXT_CYCLE_WITHIN_MS = 90_000;
export const ANOMALY_WAKE_DELAY_MS = 5_000;

export const ANOMALY_BREAKOUT_MIN_SCORE = 78;
export const ANOMALY_STRONG_BREAKOUT_MIN_SCORE = 82;
export const ANOMALY_STRONG_BREAKOUT_MIN_VOL_RATIO = 1.8;

export const ANOMALY_SHOCK_ATR_MULTIPLE = 2.0;
export const ANOMALY_BTC_MIN_SHOCK_PCT = 1.2;
export const ANOMALY_ALT_MIN_SHOCK_PCT = 2.0;

const ANOMALY_PRESCREEN_LIMIT = 12;
const ANOMALY_CONCURRENCY = 4;

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface BarShockResult {
  shocked: boolean;
  multiple: number;
  movePct: number;
  rangePct: number;
  direction: 'up' | 'down';
}

export type ManagedAnomalyKind = 'position_shock' | 'btc_shock' | 'breakout_ignition';

export interface ManagedAnomalyTrigger {
  kind: ManagedAnomalyKind;
  symbol: string;
  reason: string;
  score?: number;
  bias?: Ai500Candidate['bias'];
}

export interface ManagedAnomalyScanGateInput {
  mode: string;
  running: boolean;
  cycleInFlight: boolean;
  scanInFlight: boolean;
  nowMs: number;
  lastCycleFinishedAtMs: number;
  lastAnomalyWakeAtMs: number;
  nextCycleAtMs: number | null;
}

export interface ManagedAnomalyScanInput {
  config: StrategyConfig;
  marketData: MarketDataService;
  heldSymbols: readonly string[];
  pendingSymbols: readonly string[];
  cooldownUntilBySymbol: ReadonlyMap<string, number>;
  calibration?: {
    weights?: Partial<Ai500Weights>;
    strongThreshold?: number;
    watchThreshold?: number;
  };
  nowMs?: number;
}

/* -------------------------------------------------------------------------- */
/*  Pure Gate & Detection Logic                                                */
/* -------------------------------------------------------------------------- */

/**
 * 扫描前轻量闸门（零网络调用）：满足防刷屏护栏才去拉行情，避免浪费权重或连环唤醒。
 */
export function shouldRunAnomalyScan(
  input: ManagedAnomalyScanGateInput,
): { run: boolean; reason: string } {
  if (!input.running) return { run: false, reason: '机器人未在运行' };
  if (input.mode !== 'ai_managed') return { run: false, reason: '仅智能托管 2.0 启用异动雷达唤醒' };
  if (input.cycleInFlight) return { run: false, reason: '常规决策轮次正在执行' };
  if (input.scanInFlight) return { run: false, reason: '上一次异动扫描尚未结束' };

  if (
    input.lastCycleFinishedAtMs > 0 &&
    input.nowMs - input.lastCycleFinishedAtMs < ANOMALY_MIN_SINCE_CYCLE_MS
  ) {
    return { run: false, reason: '距上一轮决策刚结束不足 3 分钟' };
  }

  if (
    input.lastAnomalyWakeAtMs > 0 &&
    input.nowMs - input.lastAnomalyWakeAtMs < ANOMALY_GLOBAL_COOLDOWN_MS
  ) {
    return { run: false, reason: '距上次异动唤醒不足 5 分钟全局冷却' };
  }

  if (
    input.nextCycleAtMs !== null &&
    input.nextCycleAtMs - input.nowMs <= ANOMALY_SKIP_IF_NEXT_CYCLE_WITHIN_MS
  ) {
    return { run: false, reason: '原定常规轮次将在 90 秒内自动运行' };
  }

  return { run: true, reason: 'ok' };
}

/**
 * 检测最新一根 15m K 线是否出现突发急拉/急砸（以**之前** 14 根 Wilder ATR 为基准，防当根异动拉高分母掩盖自身）。
 */
export function detectBarShock(
  klines15m: readonly Kline[],
  symbol: string,
): BarShockResult | null {
  if (klines15m.length < 16) return null;
  const current = klines15m[klines15m.length - 1]!;
  if (!Number.isFinite(current.open) || current.open <= 0) return null;

  const prior = klines15m.slice(0, -1);
  const atrVal = last(atr(prior, 14));
  if (atrVal === null || !Number.isFinite(atrVal) || atrVal <= 0) return null;

  const atrPct = (atrVal / current.open) * 100;
  const movePct = ((current.close - current.open) / current.open) * 100;
  const absMovePct = Math.abs(movePct);
  const rangePct = ((current.high - current.low) / current.open) * 100;
  const effectivePct = Math.max(absMovePct, rangePct * 0.85);
  const multiple = atrPct > 0 ? effectivePct / atrPct : 0;

  const isMajor = symbol === 'BTCUSDT' || symbol === 'ETHUSDT';
  const minPctFloor = isMajor ? ANOMALY_BTC_MIN_SHOCK_PCT : ANOMALY_ALT_MIN_SHOCK_PCT;
  const shocked = multiple >= ANOMALY_SHOCK_ATR_MULTIPLE && effectivePct >= minPctFloor;

  return {
    shocked,
    multiple: Math.round(multiple * 100) / 100,
    movePct: Math.round(movePct * 100) / 100,
    rangePct: Math.round(rangePct * 100) / 100,
    direction: movePct >= 0 ? 'up' : 'down',
  };
}

/**
 * 按优先级评估本轮轻量扫描结果：持仓剧变 > BTC 剧变 > 全市场新起爆机会。
 */
export function evaluateAnomalyCandidates(input: {
  candidates: readonly Ai500Candidate[];
  shockBySymbol: ReadonlyMap<string, BarShockResult>;
  heldSymbols: ReadonlySet<string>;
  pendingSymbols: ReadonlySet<string>;
  cooldownUntilBySymbol: ReadonlyMap<string, number>;
  nowMs: number;
}): ManagedAnomalyTrigger | null {
  const isCooling = (symbol: string): boolean => {
    const until = input.cooldownUntilBySymbol.get(symbol);
    return until !== undefined && until > input.nowMs;
  };

  // 1) 最高优先级：当前持仓标的突发急拉/急砸（第一时间锁利或风控止损）
  for (const sym of input.heldSymbols) {
    if (isCooling(sym)) continue;
    const shock = input.shockBySymbol.get(sym);
    if (shock?.shocked) {
      const dirCn = shock.direction === 'up' ? '急拉' : '急砸';
      return {
        kind: 'position_shock',
        symbol: sym,
        reason: `持仓 ${sym} 15m 突发${dirCn} ${shock.movePct >= 0 ? '+' : ''}${shock.movePct.toFixed(2)}%（振幅 ${shock.rangePct.toFixed(2)}%，达 ${shock.multiple.toFixed(1)}×ATR）`,
      };
    }
  }

  // 2) 次优先级：大盘 BTC 突发剧烈异动
  if (!isCooling('BTCUSDT')) {
    const btcShock = input.shockBySymbol.get('BTCUSDT');
    if (btcShock?.shocked) {
      const dirCn = btcShock.direction === 'up' ? '急拉' : '急砸';
      return {
        kind: 'btc_shock',
        symbol: 'BTCUSDT',
        reason: `大盘 BTCUSDT 15m 突发${dirCn} ${btcShock.movePct >= 0 ? '+' : ''}${btcShock.movePct.toFixed(2)}%（振幅 ${btcShock.rangePct.toFixed(2)}%，达 ${btcShock.multiple.toFixed(1)}×ATR）`,
      };
    }
  }

  // 3) 全市场新突发起爆机会（仅从未持仓、未挂单、非冷却标的里挑选最高分）
  let best: Ai500Candidate | null = null;
  for (const c of input.candidates) {
    if (input.heldSymbols.has(c.symbol) || input.pendingSymbols.has(c.symbol)) continue;
    if (isCooling(c.symbol)) continue;
    if (c.bias === 'neutral') continue;
    const isEarlyIgnition = c.score >= ANOMALY_BREAKOUT_MIN_SCORE && c.tags.includes('早期放量起爆');
    const isUltraStrongBreakout =
      c.score >= ANOMALY_STRONG_BREAKOUT_MIN_SCORE &&
      c.metrics.volRatio15m >= ANOMALY_STRONG_BREAKOUT_MIN_VOL_RATIO;
    if (!isEarlyIgnition && !isUltraStrongBreakout) continue;
    if (!best || c.score > best.score) {
      best = c;
    }
  }

  if (best) {
    const dirCn = best.bias === 'long' ? '多' : '空';
    const tagSummary = best.tags.slice(0, 3).join(' / ') || '强突破';
    return {
      kind: 'breakout_ignition',
      symbol: best.symbol,
      score: best.score,
      bias: best.bias,
      reason: `发现新起爆标的 ${best.symbol}（AI500 ${best.score}分·${dirCn}，15m量比 ${best.metrics.volRatio15m}x，${tagSummary}）`,
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*  Lightweight Network Scanner (Zero LLM Cost)                                */
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

/**
 * 执行一次纯数学轻量异动扫描（只拉 Top 12 活跃标的 + BTC + 当前持仓的 15m/4h K 线，零 LLM 调用）。
 */
export async function scanManagedAnomaly(
  input: ManagedAnomalyScanInput,
): Promise<ManagedAnomalyTrigger | null> {
  if (
    input.config.coinSource.sourceType === 'static' ||
    typeof (input.marketData as { getUniverseOverview?: unknown }).getUniverseOverview !== 'function'
  ) {
    return null;
  }

  const nowMs = input.nowMs ?? Date.now();
  const heldSet = new Set(input.heldSymbols);
  const pendingSet = new Set(input.pendingSymbols);
  const alwaysSet = new Set<string>(['BTCUSDT', ...input.heldSymbols]);

  const universeRows = await input.marketData.getUniverseOverview().catch((err) => {
    log.debug(`异动雷达全市场快照拉取跳过：${(err as Error).message}`);
    return [];
  });
  if (universeRows.length === 0) return null;

  const minVol = Math.max(
    AI500_DEFAULTS.minQuoteVolume24h,
    input.config.coinSource.minQuoteVolume24h ?? 0,
  );
  const liquid = filterRadarUniverse(universeRows, {
    minQuoteVolume24h: minVol,
    excludeStablecoins: input.config.coinSource.excludeStablecoins ?? true,
    alwaysInclude: alwaysSet,
  });
  const prescreened = selectPrescreenSymbols(liquid, {
    limit: ANOMALY_PRESCREEN_LIMIT,
    alwaysInclude: alwaysSet,
  });
  const rowBySym = new Map(liquid.map((r) => [r.symbol, r]));

  const fetched = new Map<
    string,
    {
      row: (typeof liquid)[number];
      klines15m: Kline[];
      klines4h: Kline[];
    }
  >();

  await mapConcurrent(prescreened, ANOMALY_CONCURRENCY, async (sym) => {
    const row = rowBySym.get(sym);
    if (!row) return;
    const [k15, k4h] = await Promise.all([
      input.marketData.getKlines(sym, '15m', 96).catch(() => [] as Kline[]),
      input.marketData.getKlines(sym, '4h', 60).catch(() => [] as Kline[]),
    ]);
    if (k15.length === 0) return;
    fetched.set(sym, { row, klines15m: k15, klines4h: k4h });
  });

  const shockBySymbol = new Map<string, BarShockResult>();
  for (const sym of alwaysSet) {
    const item = fetched.get(sym);
    if (!item) continue;
    const shock = detectBarShock(item.klines15m, sym);
    if (shock) shockBySymbol.set(sym, shock);
  }

  const btcEntry = fetched.get('BTCUSDT');
  const btcReturn1hPct = btcEntry ? computeReturnPct(btcEntry.klines15m, 4) : null;
  const btcReturn4hPct = btcEntry
    ? btcEntry.klines15m.length >= 17
      ? computeReturnPct(btcEntry.klines15m, 16)
      : computeReturnPct(btcEntry.klines4h, 1)
    : null;

  const candidates: Ai500Candidate[] = [];
  for (const [sym, item] of fetched) {
    candidates.push(
      scoreAi500Symbol(
        {
          symbol: sym,
          price: item.row.price,
          quoteVolume24h: item.row.quoteVolume24h,
          changePercent24h: item.row.changePercent24h,
          fundingRate: item.row.fundingRate,
          klines15m: item.klines15m,
          klines4h: item.klines4h,
          openInterestUsd: item.row.openInterestUsd ?? null,
          oiChange1hPct: null,
          oiChange4hPct: null,
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

  return evaluateAnomalyCandidates({
    candidates,
    shockBySymbol,
    heldSymbols: heldSet,
    pendingSymbols: pendingSet,
    cooldownUntilBySymbol: input.cooldownUntilBySymbol,
    nowMs,
  });
}
