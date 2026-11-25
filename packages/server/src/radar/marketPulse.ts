/**
 * 全市场零 REST 权重 WS 实时脉冲雷达（`packages/server/src/radar/marketPulse.ts`）
 *
 * 设计目标：
 *   - 仅用 1 条免费 WebSocket 连接订阅币安全市场 `!miniTicker@arr`（0 REST 权重、内存 < 5MB），
 *     实时监听全部 400+ 个 USDT 永续合约最近 5m / 15m 的突发价格与成交额脉冲；
 *   - 专门补齐 `ticker/24hr` 的结构性盲区——抓住「过去 23 小时横盘不动、最近 5–15 分钟突然点火」的暗马，
 *     第一时间提名进入 AI500 前 30 深度打分池与 3 分钟异动唤醒池；
 *   - 严格守住 ≥3,000 万 USDT 流动性底线（绝不放低门槛引入垃圾小币），过滤上下插针假波动与末期透支妖币；
 *   - WS 断线、未热身或单测环境下静默返回空列表，100% 无感回退原有初筛逻辑，零副作用。
 */

import { isStableBaseAsset } from '@aq/shared';

import { buildMarketStreamUrl, type BinanceEndpoints } from '../binance/endpoints.js';
import { ResilientStream, type StreamState } from '../binance/ws.js';
import { createLogger } from '../logger.js';

const log = createLogger('radar:pulse');

/* -------------------------------------------------------------------------- */
/*  Types & Constants                                                          */
/* -------------------------------------------------------------------------- */

/** Binance `!miniTicker@arr` 单条标的原始帧结构。 */
export interface BinanceMiniTickerItem {
  /** 事件类型，通常为 `24hrMiniTicker` */
  e?: string;
  /** 事件时间戳（ms） */
  E?: number;
  /** 合约标的，例如 `SOLUSDT` */
  s: string;
  /** 最新成交价 */
  c: string | number;
  /** 24h 开盘价 */
  o: string | number;
  /** 24h 最高价 */
  h: string | number;
  /** 24h 最低价 */
  l: string | number;
  /** 24h 成交量（基础资产） */
  v?: string | number;
  /** 24h 成交额（计价资产 USDT） */
  q: string | number;
}

interface MinuteBucket {
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 本分钟内正向增量成交额下界估计（USDT）。 */
  deltaQuoteVol: number;
}

interface SymbolPulseState {
  symbol: string;
  buckets: MinuteBucket[];
  lastPrice: number;
  open24h: number;
  high24h: number;
  low24h: number;
  quoteVolume24h: number;
  lastQuoteVolume24h: number;
  lastEventAtMs: number;
}

export interface MarketPulseSignal {
  symbol: string;
  direction: 'long' | 'short';
  pulseScore: number;
  ret5mPct: number;
  ret15mPct: number;
  volSurge5m: number;
  volSurge15m: number;
  efficiency5m: number;
  efficiency15m: number;
  quoteVolume24h: number;
}

export interface MarketPulseQueryOptions {
  /** 最多返回多少个脉冲提名标的（默认 8）。 */
  limit?: number;
  /** 24h 成交额硬下限（默认 30,000,000 USDT，绝不放宽流动性底线）。 */
  minQuoteVolume24h?: number;
  /** 当前时间戳（ms，缺省用 `Date.now()`）。 */
  nowMs?: number;
}

export interface MarketPulseStatus {
  running: boolean;
  streamState: StreamState;
  trackedSymbols: number;
  warmedSymbols: number;
  lastFrameAtMs: number;
  framesReceived: number;
}

const MAX_BUCKETS_PER_SYMBOL = 20;
const STALE_SYMBOL_TTL_MS = 30 * 60_000;
const FRESH_SIGNAL_MAX_AGE_MS = 3 * 60_000;
const MIN_WARMUP_BUCKETS = 3;
const PRUNE_INTERVAL_MS = 5 * 60_000;

/* -------------------------------------------------------------------------- */
/*  Pure In-Memory Pulse Tracker                                               */
/* -------------------------------------------------------------------------- */

function toNum(v: string | number | undefined): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 纯内存全市场 5m/15m 脉冲检测器（零 I/O，支持离线单元测试）。
 */
export class MarketPulseTracker {
  private readonly states = new Map<string, SymbolPulseState>();
  private lastFrameAtMs = 0;
  private framesReceived = 0;
  private lastPruneAtMs = 0;

  /** 吞入一帧 `!miniTicker@arr` 数组（每秒一次，O(N) 轻量更新）。 */
  ingestBatch(items: readonly BinanceMiniTickerItem[], fallbackNowMs = Date.now()): void {
    if (!Array.isArray(items) || items.length === 0) return;
    this.framesReceived += 1;
    this.lastFrameAtMs = fallbackNowMs;

    for (const item of items) {
      if (!item || typeof item.s !== 'string') continue;
      const symbol = item.s.toUpperCase();
      if (!symbol.endsWith('USDT')) continue;
      if (isStableBaseAsset(symbol)) continue;

      const price = toNum(item.c);
      const open24h = toNum(item.o);
      const high24h = toNum(item.h);
      const low24h = toNum(item.l);
      const quoteVolume24h = toNum(item.q);
      if (!(price > 0) || !(quoteVolume24h >= 0)) continue;

      const eventMs =
        typeof item.E === 'number' && Number.isFinite(item.E) && item.E > 0
          ? item.E
          : fallbackNowMs;
      const minute = Math.floor(eventMs / 60_000);

      let st = this.states.get(symbol);
      if (!st) {
        st = {
          symbol,
          buckets: [
            {
              minute,
              open: price,
              high: price,
              low: price,
              close: price,
              deltaQuoteVol: 0,
            },
          ],
          lastPrice: price,
          open24h: open24h > 0 ? open24h : price,
          high24h: high24h > 0 ? high24h : price,
          low24h: low24h > 0 ? low24h : price,
          quoteVolume24h,
          lastQuoteVolume24h: quoteVolume24h,
          lastEventAtMs: eventMs,
        };
        this.states.set(symbol, st);
        continue;
      }

      // 忽略乱序旧时间戳
      if (eventMs < st.lastEventAtMs - 5_000) continue;

      // 24h 滚动成交额增量：新成交远大于 24h 前滚出量时呈明显正值，作为保守的瞬时成交额下界
      const deltaVol = Math.max(0, quoteVolume24h - st.lastQuoteVolume24h);
      st.lastPrice = price;
      if (open24h > 0) st.open24h = open24h;
      if (high24h > 0) st.high24h = high24h;
      if (low24h > 0) st.low24h = low24h;
      st.quoteVolume24h = quoteVolume24h;
      st.lastQuoteVolume24h = quoteVolume24h;
      st.lastEventAtMs = eventMs;

      const lastBucket = st.buckets[st.buckets.length - 1];
      if (lastBucket && lastBucket.minute === minute) {
        if (price > lastBucket.high) lastBucket.high = price;
        if (price < lastBucket.low) lastBucket.low = price;
        lastBucket.close = price;
        lastBucket.deltaQuoteVol += deltaVol;
      } else if (!lastBucket || minute > lastBucket.minute) {
        st.buckets.push({
          minute,
          open: lastBucket ? lastBucket.close : price,
          high: price,
          low: price,
          close: price,
          deltaQuoteVol: deltaVol,
        });
        if (st.buckets.length > MAX_BUCKETS_PER_SYMBOL) {
          st.buckets.splice(0, st.buckets.length - MAX_BUCKETS_PER_SYMBOL);
        }
      }
    }

    if (fallbackNowMs - this.lastPruneAtMs >= PRUNE_INTERVAL_MS) {
      this.pruneStale(fallbackNowMs);
      this.lastPruneAtMs = fallbackNowMs;
    }
  }

  /** 清理超过 30 分钟无推送的下架/静默标的，防止内存缓增。 */
  pruneStale(nowMs = Date.now()): void {
    for (const [sym, st] of this.states) {
      if (nowMs - st.lastEventAtMs > STALE_SYMBOL_TTL_MS) {
        this.states.delete(sym);
      }
    }
  }

  /** 计算当前处于突发点火状态的优质高流动性标的列表（按脉冲强度降序）。 */
  getHotSignals(options: MarketPulseQueryOptions = {}): MarketPulseSignal[] {
    const limit = Math.max(1, options.limit ?? 8);
    const minVol = options.minQuoteVolume24h ?? 30_000_000;
    const nowMs = options.nowMs ?? Date.now();
    const nowMinute = Math.floor(nowMs / 60_000);

    const out: MarketPulseSignal[] = [];

    for (const st of this.states.values()) {
      if (st.quoteVolume24h < minVol) continue;
      if (nowMs - st.lastEventAtMs > FRESH_SIGNAL_MAX_AGE_MS) continue;
      if (st.buckets.length < MIN_WARMUP_BUCKETS) continue;

      // 过滤已极端透支的末期妖币（与 AI500 2.0 保持同一道防火墙）
      const chg24hPct = st.open24h > 0 ? ((st.lastPrice - st.open24h) / st.open24h) * 100 : 0;
      const amp24hPct = st.low24h > 0 ? ((st.high24h - st.low24h) / st.low24h) * 100 : 0;
      if (Math.abs(chg24hPct) > 55 || amp24hPct > 65) continue;

      const win5 = st.buckets.filter((b) => b.minute >= nowMinute - 4);
      const win15 = st.buckets.filter((b) => b.minute >= nowMinute - 14);
      if (win5.length < 2) continue;

      const closeNow = st.lastPrice;
      const open5 = win5[0]!.open;
      const open15 = win15.length >= 2 ? win15[0]!.open : open5;
      if (!(open5 > 0) || !(open15 > 0)) continue;

      const ret5mPct = ((closeNow - open5) / open5) * 100;
      const ret15mPct = ((closeNow - open15) / open15) * 100;

      const high5 = Math.max(...win5.map((b) => b.high));
      const low5 = Math.min(...win5.map((b) => b.low));
      const range5 = Math.max(high5 - low5, 1e-12);
      const efficiency5m = Math.abs(closeNow - open5) / range5;

      const high15 = Math.max(...win15.map((b) => b.high));
      const low15 = Math.min(...win15.map((b) => b.low));
      const range15 = Math.max(high15 - low15, 1e-12);
      const efficiency15m = Math.abs(closeNow - open15) / range15;

      // 成交额脉冲倍率：按当前窗口覆盖分钟数等比例对比 24h 分钟均量，避免热身期分母偏大
      const mins5 = Math.max(1, win5.length);
      const mins15 = Math.max(1, win15.length);
      const avgPerMin = st.quoteVolume24h / 1440;
      const vol5 = win5.reduce((s, b) => s + b.deltaQuoteVol, 0);
      const vol15 = win15.reduce((s, b) => s + b.deltaQuoteVol, 0);
      const volSurge5m = avgPerMin > 0 ? vol5 / (avgPerMin * mins5) : 0;
      const volSurge15m = avgPerMin > 0 ? vol15 / (avgPerMin * mins15) : 0;

      // 触发条件：必须有清晰实体方向效率（过滤来回插针画门）+ 放量或强势单边推进
      const ignition5m =
        Math.abs(ret5mPct) >= 1.2 && volSurge5m >= 1.8 && efficiency5m >= 0.45;
      const ignition15m =
        win15.length >= 5 &&
        Math.abs(ret15mPct) >= 2.0 &&
        volSurge15m >= 1.6 &&
        efficiency15m >= 0.45;
      // 兜底：若 24h 前恰好有巨量滚出掩盖了 24h 滚动增量 Δq，纯高效率单边强拉/强砸也能捕获
      const strongPureMove =
        (Math.abs(ret5mPct) >= 2.2 && efficiency5m >= 0.6) ||
        (win15.length >= 5 && Math.abs(ret15mPct) >= 3.2 && efficiency15m >= 0.6);

      if (!ignition5m && !ignition15m && !strongPureMove) continue;

      const primaryRet =
        Math.abs(ret5mPct) * 1.4 >= Math.abs(ret15mPct) ? ret5mPct : ret15mPct;
      const bestSurge = Math.max(volSurge5m, volSurge15m);
      const bestEff = Math.max(efficiency5m, efficiency15m);
      const pulseScore =
        Math.max(Math.abs(ret5mPct) * 1.4, Math.abs(ret15mPct)) *
        (1 + Math.min(bestSurge, 6) * 0.25) *
        (0.6 + 0.4 * bestEff);

      out.push({
        symbol: st.symbol,
        direction: primaryRet >= 0 ? 'long' : 'short',
        pulseScore: round2(pulseScore),
        ret5mPct: round2(ret5mPct),
        ret15mPct: round2(ret15mPct),
        volSurge5m: round1(volSurge5m),
        volSurge15m: round1(volSurge15m),
        efficiency5m: round2(efficiency5m),
        efficiency15m: round2(efficiency15m),
        quoteVolume24h: st.quoteVolume24h,
      });
    }

    out.sort((a, b) => b.pulseScore - a.pulseScore);
    return out.slice(0, limit);
  }

  /** 便捷方法：直接返回按脉冲强度排序的标的符号列表。 */
  getHotSymbols(options: MarketPulseQueryOptions = {}): string[] {
    return this.getHotSignals(options).map((s) => s.symbol);
  }

  getStats(): {
    trackedSymbols: number;
    warmedSymbols: number;
    lastFrameAtMs: number;
    framesReceived: number;
  } {
    let warmedSymbols = 0;
    for (const st of this.states.values()) {
      if (st.buckets.length >= MIN_WARMUP_BUCKETS) warmedSymbols += 1;
    }
    return {
      trackedSymbols: this.states.size,
      warmedSymbols,
      lastFrameAtMs: this.lastFrameAtMs,
      framesReceived: this.framesReceived,
    };
  }

  clear(): void {
    this.states.clear();
    this.lastFrameAtMs = 0;
    this.framesReceived = 0;
    this.lastPruneAtMs = 0;
  }
}

/* -------------------------------------------------------------------------- */
/*  Resilient WS Wrapper + Process Singleton                                   */
/* -------------------------------------------------------------------------- */

export class BinanceMarketPulseStream {
  readonly tracker = new MarketPulseTracker();
  private stream: ResilientStream | null = null;
  private running = false;

  async start(endpoints: BinanceEndpoints): Promise<void> {
    if (this.running) return;
    this.running = true;
    const url = buildMarketStreamUrl(endpoints, ['!miniTicker@arr']);
    const stream = new ResilientStream({
      name: 'market-pulse',
      url: () => url,
      watchedStreams: () => ['!miniTicker@arr'],
      stalenessWindowMs: 60_000,
      onData: (_streamName, payload) => {
        if (Array.isArray(payload)) {
          this.tracker.ingestBatch(payload as BinanceMiniTickerItem[]);
        }
      },
      onStateChange: (state, detail) => {
        if (state === 'live') {
          log.info(`[market-pulse] 全市场实时脉冲流已就绪（${endpoints.label} · 0 REST 权重）`);
        } else if (state === 'reconnecting') {
          log.debug(`[market-pulse] 脉冲流重连中（${detail}），期间自动退回常规初筛`);
        }
      },
    });
    this.stream = stream;
    try {
      await stream.start();
    } catch (error) {
      log.warn(`[market-pulse] 启动失败（不影响交易，自动退回常规初筛）：${(error as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    const prev = this.stream;
    this.stream = null;
    if (prev) {
      await prev.stop().catch(() => undefined);
    }
  }

  getHotSignals(options: MarketPulseQueryOptions = {}): MarketPulseSignal[] {
    return this.tracker.getHotSignals(options);
  }

  getHotSymbols(options: MarketPulseQueryOptions = {}): string[] {
    return this.tracker.getHotSymbols(options);
  }

  getStatus(): MarketPulseStatus {
    const stats = this.tracker.getStats();
    return {
      running: this.running,
      streamState: this.stream?.currentState ?? 'idle',
      ...stats,
    };
  }
}

const sharedMarketPulse = new BinanceMarketPulseStream();

/** 获取进程级共享全市场脉冲雷达单例（全服仅 1 条 WS 连接）。 */
export function getSharedMarketPulse(): BinanceMarketPulseStream {
  return sharedMarketPulse;
}

/** 启动进程级共享全市场脉冲雷达（非阻塞，失败不影响交易主链路）。 */
export async function startSharedMarketPulse(endpoints: BinanceEndpoints): Promise<void> {
  await sharedMarketPulse.start(endpoints);
}

/** 优雅关闭进程级共享全市场脉冲雷达。 */
export async function stopSharedMarketPulse(): Promise<void> {
  await sharedMarketPulse.stop();
}
