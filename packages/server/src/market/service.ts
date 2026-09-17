import {
  type DerivativeContext,
  type IndicatorConfig,
  type Kline,
  type MarketSnapshot,
  type OiRankRow,
  type QuantContext,
  type Timeframe,
  type TimeframeIndicators,
} from '@aq/shared';
import type { BinanceMarketData } from '../binance/market.js';
import type { SymbolRegistry } from '../binance/symbols.js';
import { normalizeSymbol } from '../binance/symbols.js';
import type { BinancePremiumIndex, BinanceTicker24h } from '../binance/types.js';
import { createLogger } from '../logger.js';
import { computeTimeframeIndicators } from './indicators.js';
import { scoreSymbol } from '../strategy/scoring.js';

const log = createLogger('market:service');

/* -------------------------------------------------------------------------- */
/*  Universe snapshot                                                          */
/* -------------------------------------------------------------------------- */

interface UniverseSnapshot {
  fetchedAt: number;
  tickers: Map<string, BinanceTicker24h>;
  premiums: Map<string, BinancePremiumIndex>;
}

/** The universe-wide ticker/premium pair is reused for every symbol in a cycle. */
const UNIVERSE_TTL_MS = 20_000;

/* -------------------------------------------------------------------------- */
/*  Service                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Assembles the market picture the model actually sees.
 *
 * Two efficiency decisions matter here:
 *
 *  1. `/fapi/v1/ticker/24hr` and `/fapi/v1/premiumIndex` are fetched **without**
 *     a symbol, returning the whole universe in a single call each. That turns
 *     a 2N-request cycle into 2 requests plus one per configured timeframe.
 *  2. The universe snapshot is cached for a few seconds so that several symbols
 *     in the same cycle — and concurrent traders — share one fetch.
 */
export class MarketDataService {
  private universe: UniverseSnapshot | null = null;
  private readonly klineCache = new Map<string, { at: number; klines: Kline[] }>();

  constructor(
    private readonly market: BinanceMarketData,
    private readonly registry: SymbolRegistry,
  ) {}

  /** Universe-wide tickers and funding/mark prices, cached for a few seconds. */
  private async getUniverse(force = false): Promise<UniverseSnapshot> {
    if (!force && this.universe && Date.now() - this.universe.fetchedAt < UNIVERSE_TTL_MS) {
      return this.universe;
    }

    const [tickers, premiums] = await Promise.all([
      this.market.ticker24h().catch((error) => {
        log.warn(`universe ticker fetch failed: ${(error as Error).message}`);
        return [] as BinanceTicker24h[];
      }),
      this.market.premiumIndex().catch((error) => {
        log.warn(`universe premium fetch failed: ${(error as Error).message}`);
        return [] as BinancePremiumIndex[];
      }),
    ]);

    const snapshot: UniverseSnapshot = {
      fetchedAt: Date.now(),
      tickers: new Map(tickers.map((t) => [t.symbol, t])),
      premiums: new Map(premiums.map((p) => [p.symbol, p])),
    };
    this.universe = snapshot;
    return snapshot;
  }

  /**
   * Closed klines with a short cache.
   *
   * The live candle is always excluded: feeding a partial candle into EMA/RSI
   * makes indicators jitter on every poll and manufactures phantom crossovers.
   */
  private async getKlines(symbol: string, timeframe: Timeframe, count: number): Promise<Kline[]> {
    const key = `${symbol}:${timeframe}:${count}`;
    const cached = this.klineCache.get(key);
    // A candle closes at most once per timeframe; 15s is safely within that.
    if (cached && Date.now() - cached.at < 15_000) return cached.klines;

    const klines = await this.market.fetchClosedKlines(symbol, timeframe, count);
    this.klineCache.set(key, { at: Date.now(), klines });
    return klines;
  }

  /** Drop caches so the next cycle reads fresh data. */
  invalidate(): void {
    this.universe = null;
    this.klineCache.clear();
  }

  /* ---------------------------------------------------------------------- */
  /*  Snapshot assembly                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Build one symbol's complete market snapshot.
   *
   * Never throws for a single symbol: a data hiccup on one candidate should
   * degrade that candidate, not abort the whole decision cycle.
   */
  async buildSnapshot(
    symbolInput: string,
    config: IndicatorConfig,
    sources: string[] = [],
  ): Promise<MarketSnapshot | null> {
    const symbol = normalizeSymbol(symbolInput);

    let info;
    try {
      info = this.registry.require(symbol);
    } catch {
      log.debug(`skipping unknown symbol ${symbol}`);
      return null;
    }

    const timeframes = config.kline.selectedTimeframes;
    const count = config.kline.primaryCount;

    const klineResults = await Promise.all(
      timeframes.map(async (tf) => {
        try {
          return { tf, klines: await this.getKlines(symbol, tf, count) };
        } catch (error) {
          log.warn(`klines(${symbol}, ${tf}) failed: ${(error as Error).message}`);
          return { tf, klines: [] as Kline[] };
        }
      }),
    );

    const computed: TimeframeIndicators[] = klineResults.map(({ tf, klines }) =>
      computeTimeframeIndicators(tf, klines, config),
    );

    const primaryIndex = Math.max(
      0,
      timeframes.indexOf(config.kline.primaryTimeframe),
    );
    const primary = computed[primaryIndex] ?? computed[0];
    if (!primary || primary.klines.length === 0) {
      log.debug(`no usable klines for ${symbol}`);
      return null;
    }

    const universe = await this.getUniverse();
    const ticker = universe.tickers.get(symbol);
    const premium = universe.premiums.get(symbol);

    const lastClose = primary.klines[primary.klines.length - 1]?.close ?? 0;
    const markPrice = premium ? Number(premium.markPrice) : NaN;
    const price = Number.isFinite(markPrice) && markPrice > 0 ? markPrice : lastClose;

    const derivatives = await this.buildDerivatives(symbol, price, premium, config);

    /*
     * 候选评分。
     *
     * 在这里算而不是在调用方算，是因为**只有这里同时拿得到 15m 与 4h 的原始 K 线** ——
     * 快照里只带算好的指标，带不了 K 线（那会让快照大得多）。
     * 而评分必须两个周期都要：只看小周期会被日内噪声带走，只看大周期会错过入场点。
     */
    const klinesOf = (tf: string): Kline[] => klineResults.find((r) => r.tf === tf)?.klines ?? [];
    const score = scoreSymbol(klinesOf('15m'), klinesOf('4h'));

    return {
      symbol,
      sources,
      price,
      quoteVolume24h: Number(ticker?.quoteVolume ?? 0),
      priceChangePercent24h: Number(ticker?.priceChangePercent ?? 0),
      high24h: Number(ticker?.highPrice ?? 0),
      low24h: Number(ticker?.lowPrice ?? 0),
      primary,
      isMajor: this.registry.isMajor(symbol),
      timeframes: computed,
      derivatives,
      quant: config.enableQuantData ? await this.buildQuant(symbol, primary) : null,
      score,
    };
  }

  /** Batch variant. Failures yield fewer snapshots rather than an exception. */
  async buildSnapshots(
    symbols: string[],
    config: IndicatorConfig,
    sourcesBySymbol: Map<string, string[]> = new Map(),
  ): Promise<MarketSnapshot[]> {
    const results = await Promise.all(
      symbols.map((symbol) => this.buildSnapshot(symbol, config, sourcesBySymbol.get(symbol) ?? [])),
    );
    return results.filter((s): s is MarketSnapshot => s !== null);
  }

  /* ---------------------------------------------------------------------- */
  /*  Derivatives context                                                    */
  /* ---------------------------------------------------------------------- */

  private async buildDerivatives(
    symbol: string,
    price: number,
    premium: BinancePremiumIndex | undefined,
    config: IndicatorConfig,
  ): Promise<DerivativeContext> {
    const context: DerivativeContext = {
      openInterest: null,
      openInterestUsd: null,
      openInterestAvg: null,
      openInterestChangePercent: {},
      fundingRate: premium ? Number(premium.lastFundingRate) : null,
      nextFundingTime: premium?.nextFundingTime ?? null,
      markPrice: premium ? Number(premium.markPrice) : null,
      indexPrice: premium ? Number(premium.indexPrice) : null,
    };

    if (!config.enableFundingRate) context.fundingRate = null;
    if (!config.enableOi) {
      context.nextFundingTime = null;
      return context;
    }

    const [current, hist] = await Promise.all([
      this.market.openInterest(symbol),
      this.market.openInterestHist(symbol, '1h', 25),
    ]);

    context.openInterest = current;
    if (current !== null && price > 0) context.openInterestUsd = current * price;

    if (hist.length > 0) {
      const values = hist.map((h) => Number(h.sumOpenInterest)).filter((v) => Number.isFinite(v));
      if (values.length > 0) {
        context.openInterestAvg = values.reduce((a, b) => a + b, 0) / values.length;
        const latest = values[values.length - 1] as number;
        context.openInterestUsd = price > 0 ? latest * price : context.openInterestUsd;

        // The history series is hourly and oldest-first, so index arithmetic
        // gives the change over each window directly.
        const changeOver = (hours: number): number | undefined => {
          const idx = values.length - 1 - hours;
          if (idx < 0) return undefined;
          const past = values[idx] as number;
          if (past <= 0) return undefined;
          return ((latest - past) / past) * 100;
        };

        context.openInterestChangePercent = {
          '1h': changeOver(1),
          '4h': changeOver(4),
          '24h': changeOver(24),
        };
      }
    }

    return context;
  }

  /* ---------------------------------------------------------------------- */
  /*  Order-flow context                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Taker buy/sell flow derived from candle data we already have.
   *
   * `takerBuyBase` is present on every kline, so this costs zero extra requests
   * and still gives the model a genuine read on which side is aggressing.
   */
  private async buildQuant(
    symbol: string,
    primary: TimeframeIndicators,
  ): Promise<QuantContext | null> {
    const klines = primary.klines;
    if (klines.length === 0) return null;

    const windowFor = (hours: number): Kline[] => {
      const perHour = klinesPerHour(primary.timeframe);
      const count = Math.max(1, Math.round(perHour * hours));
      return klines.slice(-count);
    };

    const summarise = (slice: Kline[]): { net: number; buyRatio: number } => {
      let buy = 0;
      let sell = 0;
      for (const k of slice) {
        buy += k.takerBuyBase;
        sell += k.volume - k.takerBuyBase;
      }
      const total = buy + sell;
      return { net: buy - sell, buyRatio: total > 0 ? buy / total : 0.5 };
    };

    const one = summarise(windowFor(1));
    const four = summarise(windowFor(4));

    const changeOver = (hours: number): number | undefined => {
      const perHour = klinesPerHour(primary.timeframe);
      const bars = Math.max(1, Math.round(perHour * hours));
      const idx = klines.length - 1 - bars;
      if (idx < 0) return undefined;
      const past = klines[idx]?.close ?? 0;
      const latest = klines[klines.length - 1]?.close ?? 0;
      if (past <= 0) return undefined;
      return ((latest - past) / past) * 100;
    };

    return {
      netflow1h: one.net,
      netflow4h: four.net,
      takerBuyRatio1h: one.buyRatio,
      takerBuyRatio4h: four.buyRatio,
      priceChangePercent: {
        '1h': changeOver(1),
        '4h': changeOver(4),
        '24h': changeOver(24),
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Cross-sectional screens                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Liquidity / momentum screen over the whole universe.
   *
   * Returns symbols ordered by the requested ranking, filtered by turnover and
   * open interest so the model never wastes attention on illiquid contracts.
   */
  async screenUniverse(options: {
    rank: 'quote_volume' | 'gainers' | 'losers' | 'volatility' | 'funding_extreme';
    limit: number;
    minQuoteVolume24h: number;
    minOpenInterestUsd: number;
    exclude?: ReadonlySet<string>;
  }): Promise<string[]> {
    const universe = await this.getUniverse(true);

    const candidates: Array<{ symbol: string; score: number }> = [];

    for (const [symbol, ticker] of universe.tickers) {
      if (!this.registry.get(symbol)) continue; // not a tradable USDT-M perp
      if (options.exclude?.has(symbol)) continue;

      const quoteVolume = Number(ticker.quoteVolume);
      if (!Number.isFinite(quoteVolume) || quoteVolume < options.minQuoteVolume24h) continue;

      const high = Number(ticker.highPrice);
      const low = Number(ticker.lowPrice);
      const changePercent = Number(ticker.priceChangePercent);
      if (!Number.isFinite(changePercent)) continue;

      let score: number;
      switch (options.rank) {
        case 'quote_volume':
          score = quoteVolume;
          break;
        case 'gainers':
          score = changePercent;
          break;
        case 'losers':
          score = -changePercent;
          break;
        case 'volatility':
          score = low > 0 ? (high - low) / low : 0;
          break;
        case 'funding_extreme': {
          const funding = Number(universe.premiums.get(symbol)?.lastFundingRate ?? 0);
          score = Number.isFinite(funding) ? Math.abs(funding) : 0;
          break;
        }
        default:
          score = quoteVolume;
      }

      candidates.push({ symbol, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, options.limit).map((c) => c.symbol);
  }

  /**
   * Symbols with the fastest open-interest growth.
   *
   * Open-interest history costs one request per symbol, so this is deliberately
   * bounded: pre-filter to the most liquid symbols, then rank by OI change.
   */
  async screenOpenInterestGrowth(options: {
    limit: number;
    windowHours: number;
    minQuoteVolume24h: number;
    minOpenInterestUsd: number;
    prefilterSize?: number;
    exclude?: ReadonlySet<string>;
  }): Promise<string[]> {
    const prefilterSize = options.prefilterSize ?? Math.max(options.limit * 4, 20);

    const liquid = await this.screenUniverse({
      rank: 'quote_volume',
      limit: prefilterSize,
      minQuoteVolume24h: options.minQuoteVolume24h,
      minOpenInterestUsd: options.minOpenInterestUsd,
      ...(options.exclude ? { exclude: options.exclude } : {}),
    });

    const period = options.windowHours <= 1 ? '5m' : options.windowHours <= 4 ? '1h' : '4h';
    const pointsNeeded = options.windowHours <= 1 ? 13 : options.windowHours <= 4 ? 5 : 7;

    const measured = await Promise.all(
      liquid.map(async (symbol) => {
        const hist = await this.market.openInterestHist(symbol, period, pointsNeeded + 2);
        if (hist.length < 2) return { symbol, growth: 0 };
        const first = Number(hist[0]?.sumOpenInterest ?? 0);
        const last = Number(hist[hist.length - 1]?.sumOpenInterest ?? 0);
        if (first <= 0) return { symbol, growth: 0 };
        return { symbol, growth: ((last - first) / first) * 100 };
      }),
    );

    return measured
      .filter((m) => m.growth > 0)
      .sort((a, b) => b.growth - a.growth)
      .slice(0, options.limit)
      .map((m) => m.symbol);
  }

  /** Ranking table appended to the prompt when `enableOiRanking` is on. */
  async getOiRanking(limit: number, excludeMajor = false): Promise<OiRankRow[]> {
    const universe = await this.getUniverse();
    const rows: OiRankRow[] = [];

    const symbols = [...universe.tickers.keys()]
      .filter((s) => this.registry.get(s))
      .filter((s) => !excludeMajor || !this.registry.isMajor(s))
      .slice(0, 40);

    const history = await Promise.all(
      symbols.map(async (symbol) => {
        const hist = await this.market.openInterestHist(symbol, '1h', 5).catch(() => []);
        if (hist.length < 2) return null;
        const first = Number(hist[0]?.sumOpenInterest ?? 0);
        const last = Number(hist[hist.length - 1]?.sumOpenInterest ?? 0);
        if (first <= 0) return null;
        const price = Number(universe.tickers.get(symbol)?.lastPrice ?? 0);
        return {
          symbol,
          openInterestUsd: last * price,
          changePercent: ((last - first) / first) * 100,
          priceChangePercent: Number(universe.tickers.get(symbol)?.priceChangePercent ?? 0),
        } satisfies OiRankRow;
      }),
    );

    for (const row of history) {
      if (row) rows.push(row);
    }

    return rows.sort((a, b) => b.changePercent - a.changePercent).slice(0, limit);
  }
}

/** Bars per hour for a timeframe, used to size rolling windows. */
function klinesPerHour(timeframe: Timeframe): number {
  switch (timeframe) {
    case '1m':
      return 60;
    case '3m':
      return 20;
    case '5m':
      return 12;
    case '15m':
      return 4;
    case '30m':
      return 2;
    case '1h':
      return 1;
    case '2h':
      return 0.5;
    case '4h':
      return 0.25;
    case '6h':
      return 1 / 6;
    case '12h':
      return 1 / 12;
    case '1d':
      return 1 / 24;
    default:
      return 12;
  }
}
