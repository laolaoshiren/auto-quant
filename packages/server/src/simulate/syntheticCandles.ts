/**
 * Deterministic candle fixture for the lifecycle simulation.
 *
 * ## Why this exists
 *
 * `npm run sim` used to replay **whatever candles the market happened to be
 * producing at the moment it ran**. Everything else in that harness is
 * deterministic — the model is scripted, the exchange is simulated — so the two
 * checks that assert *"a stop-loss / take-profit actually fired and was booked"*
 * were the only ones whose outcome depended on luck:
 *
 *     [失败] 止损会被真实触发并正确记账
 *            价格穿越止损 0 次，已作为 close_reason=stop_loss 的交易入账。
 *
 * The scripted model deliberately proposes **tight** protection (0.4–0.5% stop,
 * 0.7–0.9% target, see `simulate.ts`), on the assumption that "crypto moves that
 * far within a few 5-minute candles". In a quiet market that assumption is
 * simply false, and the harness reports a red check that describes the weather
 * rather than a defect. A check that fails for reasons outside the code is worse
 * than no check: it trains the reader to ignore red.
 *
 * So the market is now a **fixture**: fixed candles, fixed outcome. The harness
 * tests the seams it was built for — protection gets attached, fires, and is
 * booked — and stops testing the weather.
 *
 * ## The shape of the fixture, and why
 *
 * Real candles are not needed to exercise a stop: what matters is that price
 * *reaches* the protection. The fixture therefore does two things on purpose:
 *
 *  1. **Every candle carries an oversized wick in a direction that alternates
 *     candle by candle.** The wick is 1.7% of price, comfortably past the widest
 *     tight target in the scripted plan (0.9%) and well clear of the fee-aware
 *     stop floor (`minStopLossFeeMultiple` — see `RiskEngine.reviewOpen` step 6b).
 *     Whichever candle follows an entry, it therefore reaches that position's
 *     stop **or** its target on the next bar.
 *
 *  2. **The body drifts along a slow sine wave (±0.3%, period 24 candles).**
 *     This is what keeps the two directions in play: an entry taken before a
 *     bullish wick banks a *take-profit* if it is long (and stops out if it is
 *     short), and the mirror image happens before a bearish wick. The scripted
 *     model has no idea which is coming, so it ends up covering both paths.
 *
 *     The sine also keeps the price series non-constant. A flat series makes the
 *     indicators degenerate — RSI divides by an average move of zero — and the
 *     snapshot would carry `NaN`s that have nothing to do with what is under test.
 *
 * Deliberately **not** oversized: the body. A fixture whose price ran away would
 * bankrupt the simulated account, and a harness that blows up is testing
 * liquidation, not protection.
 *
 * ## Where the wick must NOT reach
 *
 * `SimulatedExchange.findTrigger` resolves a stop **before** a target when one
 * candle spans both (`simulatedExchange.ts` — "the conservative assumption, and
 * the one that avoids flattering the results"). The opposite wick is therefore
 * kept tiny (0.1%), so a bullish candle can only ever reach a target for a long
 * and a stop for a short — never both. If that tiny wick ever grew past the
 * tight stop distance, every entry would resolve as a stop-loss and the
 * take-profit path would silently stop being covered.
 *
 * ## Timeframe alignment
 *
 * Live candles for each timeframe are fetched independently and all end at *now*,
 * so the 1h series reaches further back than the 5m one. That matters: the replay
 * starts at index `WARMUP_CANDLES` of the 5m series, and the 1h indicators need
 * their own warm-up behind that point (MACD(26,9) needs 35 bars).
 *
 * The fixture reproduces those relative horizons by building one long primary
 * series and aggregating it, then taking the **last** `candlesPerTimeframe` bars
 * of each timeframe. Aggregation keeps the timeframes mutually consistent — a 1h
 * bar really is the 12 five-minute bars inside it — which independently generated
 * series could not guarantee.
 */

import type { Kline, Timeframe } from '@aq/shared';
import type { ReplaySource } from './replayMarketData.js';

/* -------------------------------------------------------------------------- */
/*  Timeframes                                                                 */
/* -------------------------------------------------------------------------- */

/** Periods in milliseconds. Exported so callers (and tests) align to the same table. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
};

/* -------------------------------------------------------------------------- */
/*  Fixture shape                                                              */
/* -------------------------------------------------------------------------- */

/** Wick as a fraction of price, in the candle's own direction. 1.7%. */
const DIRECTIONAL_WICK = 0.017;
/**
 * Wick on the *other* side. 0.1% — see the header: it must stay well under the
 * tightest stop the scripted model proposes (0.4%).
 */
const OPPOSITE_WICK = 0.001;
/** Body amplitude of the sine wave, ±0.3%. */
const BODY_AMPLITUDE = 0.003;
/** Body wave period, in primary candles. 24 × 5m = two hours. */
const BODY_PERIOD = 24;

export interface SyntheticMarketOptions {
  symbols: readonly string[];
  timeframes: readonly Timeframe[];
  /** The timeframe whose candles are built directly; the rest are aggregated. */
  primary: Timeframe;
  /** How many candles of *each* timeframe to expose, matching the live fetch. */
  candlesPerTimeframe: number;
  /** Open time of the very first primary candle (epoch ms). */
  startTime: number;
  /** Reference price per symbol. Magnitude only — the fixture is self-contained. */
  basePrices: Readonly<Record<string, number>>;
  /** Volume per primary candle, in base asset units. Defaults to 100. */
  baseVolume?: number;
}

/* -------------------------------------------------------------------------- */
/*  Primary series                                                             */
/* -------------------------------------------------------------------------- */

/** Price of the sine-wave body at primary-candle index `i`. */
function bodyPrice(basePrice: number, index: number): number {
  return basePrice * (1 + BODY_AMPLITUDE * Math.sin((2 * Math.PI * index) / BODY_PERIOD));
}

function buildPrimarySeries(
  symbol: string,
  basePrice: number,
  count: number,
  startTime: number,
  stepMs: number,
  baseVolume: number,
): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < count; i += 1) {
    const openTime = startTime + i * stepMs;
    // The body walks the sine wave; consecutive candles share an endpoint so the
    // series is continuous (a gap would be its own artificial price move).
    const open = bodyPrice(basePrice, i);
    const close = bodyPrice(basePrice, i + 1);
    const top = Math.max(open, close);
    const bottom = Math.min(open, close);

    // Alternating direction is what gets both paths covered; see the header.
    const bullish = i % 2 === 0;
    const high = bullish ? top * (1 + DIRECTIONAL_WICK) : top * (1 + OPPOSITE_WICK);
    const low = bullish ? bottom * (1 - OPPOSITE_WICK) : bottom * (1 - DIRECTIONAL_WICK);

    const volume = baseVolume * (1 + 0.1 * Math.sin((2 * Math.PI * i) / 12));
    out.push({
      openTime,
      open,
      high,
      low,
      close,
      volume,
      closeTime: openTime + stepMs - 1,
      quoteVolume: volume * close,
      trades: 1_000,
      // Slight taker-buy skew, so the order-flow block renders a plausible ratio
      // rather than a suspiciously exact 0.5.
      takerBuyBase: volume * 0.52,
      takerBuyQuote: volume * 0.52 * close,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Aggregation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Roll primary candles up into `targetMs` buckets.
 *
 * Only **complete** buckets are emitted: a trailing partial bucket would produce
 * a candle whose high/low cover less time than its neighbours, and the replay
 * clock is driven by the primary series — a short last bar is a lie about the
 * window it summarises.
 */
function aggregate(primary: readonly Kline[], targetMs: number, stepMs: number): Kline[] {
  const out: Kline[] = [];
  let bucketStart: number | null = null;
  let bucket: Kline[] = [];

  const flush = (): void => {
    if (bucket.length === 0 || bucketStart === null) return;
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    const high = Math.max(...bucket.map((k) => k.high));
    const low = Math.min(...bucket.map((k) => k.low));
    const volume = bucket.reduce((sum, k) => sum + k.volume, 0);
    out.push({
      openTime: bucketStart,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      closeTime: bucketStart + targetMs - 1,
      quoteVolume: bucket.reduce((sum, k) => sum + k.quoteVolume, 0),
      trades: bucket.reduce((sum, k) => sum + k.trades, 0),
      takerBuyBase: bucket.reduce((sum, k) => sum + k.takerBuyBase, 0),
      takerBuyQuote: bucket.reduce((sum, k) => sum + k.takerBuyQuote, 0),
    });
  };

  for (const candle of primary) {
    const start = Math.floor(candle.openTime / targetMs) * targetMs;
    if (bucketStart === null) {
      bucketStart = start;
    } else if (start !== bucketStart) {
      // Only emit the previous bucket if it was actually filled; otherwise it was
      // truncated at the head of the series.
      if (bucket.length * stepMs === targetMs) flush();
      bucketStart = start;
      bucket = [];
    }
    bucket.push(candle);
  }
  if (bucket.length * stepMs === targetMs) flush();

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build a complete `ReplaySource` map for the simulation.
 *
 * The primary series is generated long enough to back-fill the longest requested
 * timeframe, then each timeframe exposes the **last** `candlesPerTimeframe` bars
 * — mirroring "each timeframe is fetched independently and ends at now".
 */
export function buildSyntheticMarket(options: SyntheticMarketOptions): Map<string, ReplaySource> {
  const {
    symbols,
    timeframes,
    primary,
    candlesPerTimeframe,
    startTime,
    basePrices,
    baseVolume = 100,
  } = options;

  const primaryMs = TIMEFRAME_MS[primary];
  /*
   * A timeframe finer than the primary cannot be aggregated — there is nothing
   * to aggregate *from*. It must fail loudly rather than yield an empty series:
   * an empty series reaches the replay as "no candles are visible yet", which
   * looks like a warm-up problem somewhere else entirely.
   */
  for (const tf of timeframes) {
    if (TIMEFRAME_MS[tf] < primaryMs) {
      throw new Error(
        `合成行情无法生成比主周期更细的周期：primary=${primary}（${primaryMs}ms），请求了 ${tf}（${TIMEFRAME_MS[tf]}ms）。` +
          '请把 primary 换成更细的周期。',
      );
    }
  }

  const longestMs = Math.max(...timeframes.map((tf) => TIMEFRAME_MS[tf]));
  const ratio = Math.max(1, Math.round(longestMs / primaryMs));

  /*
   * Enough primary candles to fill `candlesPerTimeframe` bars of the longest
   * timeframe, plus one extra bucket so the tail bucket is always complete.
   */
  const totalPrimary = (candlesPerTimeframe + 1) * ratio;

  const out = new Map<string, ReplaySource>();
  for (const symbol of symbols) {
    const basePrice = basePrices[symbol];
    if (!(typeof basePrice === 'number' && basePrice > 0)) {
      throw new Error(`合成行情缺少 ${symbol} 的基准价（basePrices）`);
    }

    const series = buildPrimarySeries(symbol, basePrice, totalPrimary, startTime, primaryMs, baseVolume);

    const klines = new Map<Timeframe, Kline[]>();
    for (const tf of timeframes) {
      const tfMs = TIMEFRAME_MS[tf];
      const bars = tfMs === primaryMs ? series : aggregate(series, tfMs, primaryMs);
      // Truncation from the head matches a live fetch: the newest bars are what a
      // running bot actually sees.
      klines.set(tf, bars.slice(-candlesPerTimeframe));
    }

    out.set(symbol, { klines });
  }

  return out;
}

/** Exported for tests: the exact wick geometry the fixture guarantees. */
export const SYNTHETIC_FIXTURE_SHAPE = {
  directionalWick: DIRECTIONAL_WICK,
  oppositeWick: OPPOSITE_WICK,
  bodyAmplitude: BODY_AMPLITUDE,
  bodyPeriod: BODY_PERIOD,
} as const;
