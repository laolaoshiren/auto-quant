import type { Kline, Timeframe } from '@aq/shared';
import { createLogger } from '../logger.js';
import type { BinanceRest } from './rest.js';
import { normalizeSymbol } from './symbols.js';
import type {
  BinanceKlineTuple,
  BinanceOpenInterest,
  BinanceOpenInterestHist,
  BinancePremiumIndex,
  BinanceTicker24h,
} from './types.js';

const log = createLogger('binance:market');

/** Public market-data endpoints. No credentials required. */
export class BinanceMarketData {
  constructor(private readonly rest: BinanceRest) {}

  /**
   * Candlesticks. Binance caps `limit` at 1500 and returns them oldest-first.
   *
   * The final candle is *in progress*; callers that compute indicators must
   * decide explicitly whether to drop it (we do, see `fetchClosedKlines`).
   */
  async klines(symbol: string, interval: Timeframe, limit = 100): Promise<Kline[]> {
    const rows = await this.rest.publicGet<BinanceKlineTuple[]>('/fapi/v1/klines', {
      symbol: normalizeSymbol(symbol),
      interval,
      limit: Math.min(limit, 1500),
    });
    return rows.map(toKline);
  }

  /**
   * Klines with the live, unfinished candle removed.
   *
   * Feeding a partial candle into EMA/RSI/MACD makes indicators jitter on every
   * poll and produces phantom crossovers, so every indicator path uses this.
   */
  async fetchClosedKlines(symbol: string, interval: Timeframe, limit = 100): Promise<Kline[]> {
    const rows = await this.klines(symbol, interval, limit + 1);
    if (rows.length === 0) return [];
    const now = Date.now();
    return rows.filter((k) => k.closeTime < now);
  }

  async ticker24h(symbol?: string): Promise<BinanceTicker24h[]> {
    const response = await this.rest.publicGet<BinanceTicker24h[] | BinanceTicker24h>(
      '/fapi/v1/ticker/24hr',
      symbol ? { symbol: normalizeSymbol(symbol) } : {},
    );
    return Array.isArray(response) ? response : [response];
  }

  /**
   * Mark price, index price and the current funding rate.
   * With no symbol, Binance returns the whole universe in one weighted call.
   */
  async premiumIndex(symbol?: string): Promise<BinancePremiumIndex[]> {
    const response = await this.rest.publicGet<BinancePremiumIndex[] | BinancePremiumIndex>(
      '/fapi/v1/premiumIndex',
      symbol ? { symbol: normalizeSymbol(symbol) } : {},
    );
    return Array.isArray(response) ? response : [response];
  }

  async openInterest(symbol: string): Promise<number | null> {
    try {
      const response = await this.rest.publicGet<BinanceOpenInterest>('/fapi/v1/openInterest', {
        symbol: normalizeSymbol(symbol),
      });
      const value = Number(response.openInterest);
      return Number.isFinite(value) ? value : null;
    } catch (error) {
      log.debug(`openInterest failed for ${symbol}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Historical open interest. Only the last 30 days are available and the
   * granularity is limited (`5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `12h`,
   * `1d`). Requesting more than 500 points in one call is rejected.
   */
  async openInterestHist(
    symbol: string,
    period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d' = '1h',
    limit = 48,
  ): Promise<BinanceOpenInterestHist[]> {
    try {
      return await this.rest.publicGet<BinanceOpenInterestHist[]>('/futures/data/openInterestHist', {
        symbol: normalizeSymbol(symbol),
        period,
        limit: Math.min(limit, 500),
      });
    } catch (error) {
      log.debug(`openInterestHist failed for ${symbol}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Taker buy/sell volume, used as a free stand-in for paid order-flow feeds.
   * Returns rows oldest-first.
   */
  async takerBuySellVolume(
    symbol: string,
    period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d' = '1h',
    limit = 24,
  ): Promise<Array<{ buyVol: number; sellVol: number; timestamp: number }>> {
    try {
      // Payload: [{ buySellRatio, buyVol, sellVol, timestamp }, ...]
      const rows = await this.rest.publicGet<
        Array<{ buySellRatio: string; buyVol: string; sellVol: string; timestamp: number }>
      >('/futures/data/takerlongshortRatio', {
        symbol: normalizeSymbol(symbol),
        period,
        limit: Math.min(limit, 500),
      });
      return rows.map((r) => {
        const buyVol = Number(r.buyVol);
        const sellVol = Number(r.sellVol);
        return {
          buyVol: Number.isFinite(buyVol) ? buyVol : 0,
          sellVol: Number.isFinite(sellVol) ? sellVol : 0,
          timestamp: r.timestamp,
        };
      });
    } catch (error) {
      log.debug(`takerBuySellVolume failed for ${symbol}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Long/short account ratio — a useful sentiment input that costs one call.
   */
  async longShortRatio(
    symbol: string,
    period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d' = '1h',
    limit = 24,
  ): Promise<Array<{ longAccount: number; shortAccount: number; timestamp: number }>> {
    try {
      const rows = await this.rest.publicGet<
        Array<{ longAccount: string; shortAccount: string; timestamp: number }>
      >('/futures/data/globalLongShortAccountRatio', {
        symbol: normalizeSymbol(symbol),
        period,
        limit: Math.min(limit, 500),
      });
      return rows.map((r) => ({
        longAccount: Number(r.longAccount),
        shortAccount: Number(r.shortAccount),
        timestamp: r.timestamp,
      }));
    } catch (error) {
      log.debug(`longShortRatio failed for ${symbol}: ${(error as Error).message}`);
      return [];
    }
  }
}

/** Positional kline tuple → named object. */
export function toKline(row: BinanceKlineTuple): Kline {
  return {
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: row[6],
    quoteVolume: Number(row[7]),
    trades: row[8],
    takerBuyBase: Number(row[9]),
    takerBuyQuote: Number(row[10]),
  };
}
