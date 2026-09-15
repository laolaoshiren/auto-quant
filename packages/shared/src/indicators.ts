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
