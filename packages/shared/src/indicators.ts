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
