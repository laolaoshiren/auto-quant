import type { Timeframe } from './strategy.js';

/* -------------------------------------------------------------------------- */
/*  Raw market primitives                                                      */
/* -------------------------------------------------------------------------- */

/** A normalised USDT-M futures candlestick. */
export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  /** Taker buy base-asset volume — the free proxy for order-flow direction. */
  takerBuyBase: number;
  takerBuyQuote: number;
}

/** Exchange symbol metadata, mirroring `/fapi/v1/exchangeInfo` filters. */
export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: number;
  stepSize: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
  /** Contract multiplier; 1 for standard USDT-M perps. */
  contractSize: number;
}

/** Everything derived for one timeframe of one symbol. */
export interface TimeframeIndicators {
  timeframe: Timeframe;
  klines: Kline[];
  closes: number[];
  volumes: number[];
  /** period → series aligned with `closes` (leading entries are `null`). */
  ema: Record<string, Array<number | null>>;
  rsi: Record<string, Array<number | null>>;
  atr: Record<string, Array<number | null>>;
  macd: {
    fast: number;
    slow: number;
    signal: number;
    line: Array<number | null>;
    signalLine: Array<number | null>;
    histogram: Array<number | null>;
  } | null;
}

/** Open-interest and funding context for a symbol. */
export interface DerivativeContext {
  openInterest: number | null;
  /** Notional open interest in USDT, when derivable. */
  openInterestUsd: number | null;
  openInterestAvg: number | null;
  openInterestChangePercent: Partial<Record<'1h' | '4h' | '24h', number>>;
  fundingRate: number | null;
  nextFundingTime: number | null;
  markPrice: number | null;
  indexPrice: number | null;
}

/** Taker-flow data standing in for a paid net-flow feed. */
export interface QuantContext {
  /** Taker buy minus taker sell, base asset, over the last hour. */
  netflow1h: number;
  netflow4h: number;
  /** Buy volume / total volume, 0-1. >0.5 means aggressive buying. */
  takerBuyRatio1h: number;
  takerBuyRatio4h: number;
  priceChangePercent: Partial<Record<'1h' | '4h' | '24h', number>>;
}

/** The complete market picture handed to the model for one symbol. */
export interface MarketSnapshot {
  symbol: string;
  /** Which universe sources nominated this symbol, e.g. `['coinpool','oi_top']`. */
  sources: string[];
  price: number;
  /** 24h ticker stats. */
  quoteVolume24h: number;
  priceChangePercent24h: number;
  high24h: number;
  low24h: number;
  primary: TimeframeIndicators;
  /** Whether this symbol counts as a BTC/ETH-class major for risk purposes. */
  isMajor: boolean;
  timeframes: TimeframeIndicators[];
  derivatives: DerivativeContext;
  quant: QuantContext | null;
  /**
   * 候选评分（0–100）与各分量。
   *
   * 在**建快照时**算好 —— 那是唯一同时拿得到 15m 与 4h K 线的地方，
   * 而评分必须两个周期都要：只看小周期会被日内噪声带走，只看大周期会错过入场点。
   *
   * 用途是**在构建提示词之前筛掉不值得看的标的**。实测单次决策的提示词是
   * 69,678 字符 / 48,005 tokens，而其中相当一部分标的是陪跑的。
   *
   * 可选：不经过评分路径的调用点没有它，那种情况下门槛判据按**放行**处理
   * （宁可多看，也不要把可能的机会静默滤掉）。
   */
  score?: {
    total: number;
    parts: { trend: number; breakoutVolume: number; consolidation: number; volatilityPenalty: number };
  };
  /**
   * ⚠️ **这个标的在"当前账户规模"下能不能真的开出仓。**
   *
   * ## 为什么要有它（实测：每轮都在给模型看一个它永远开不了的标的）
   *
   * BTCUSDT 的交易所最小名义是 **$50**，而账户约 22 USDT 时模型按风险算出的名义只有 **$20** ——
   * 实测 `#1462` 就是被这句拒掉的：「仓位名义价值 $20.00 低于最低要求 $50.00」。
   *
   * 而 `coins.ts` 把 BTCUSDT **无条件**放进候选池（它提供「大盘背景」，`mustKeep` 还专门保护它），
   * 于是它每轮都排在候选**第一位**、拿到约 **10KB** 的完整多周期序列 ——
   * 那些数据模型永远用不上，却占着提示词预算，还让它以为"BTC 是一个可以做的候选"。
   *
   * 有了这个字段，渲染层就能**只给摘要 + 写明原因**：大盘背景仍然在，
   * 但不再为一个做不了的仓位付 10KB 的 token。
   *
   * 可选：不经过账户规模判断的调用点（测试、回放）没有它，那种情况下按**可交易**处理。
   */
  tradability?: {
    ok: boolean;
    /** 不能交易时给模型看的一句话（要含具体数字）。 */
    reason?: string;
  };
}

/** One row of the cross-sectional open-interest ranking table. */
export interface OiRankRow {
  symbol: string;
  openInterestUsd: number;
  changePercent: number;
  priceChangePercent: number;
}

/** The union of every source that nominated a candidate. */
export interface CandidateCoin {
  symbol: string;
  sources: string[];
}
