/**
 * Dependency-free technical indicators.
 *
 * Every public series function returns an array that is exactly as long as its
 * input, with `null` in the bars that cannot be computed yet. Two invariants are
 * deliberately preserved everywhere below, because the bot makes trading
 * decisions from the *tail* of these arrays:
 *
 *  1. **No look-ahead.** `out[i]` is a pure function of the input up to and
 *     including index `i`. A single peek at `i + 1` would silently turn live
 *     decisions — and any back-test — into fantasy.
 *  2. **Fixed-length alignment.** Series stay indexed by candle instead of being
 *     compressed to their valid range, so `closes[i]` and `rsi["14"][i]` always
 *     describe the same candle. Compressing the warm-up away is how off-by-N
 *     alignment bugs get introduced.
 *
 * The smoothed averages follow Wilder's original definitions ("New Concepts in
 * Technical Trading Systems") rather than an EMA shortcut: RSI and ATR drive
 * stop placement, and the two smoothing rules genuinely disagree on the first
 * few dozen bars.
 */

import type { IndicatorConfig, Kline, Timeframe, TimeframeIndicators } from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/** A period only makes sense as a positive integer; anything else yields nulls. */
function isUsablePeriod(period: number): boolean {
  return Number.isInteger(period) && period >= 1;
}

/** An input-length series where every slot starts out un-computable. */
function emptySeries(length: number): Array<number | null> {
  return new Array<number | null>(length).fill(null);
}

/**
 * De-duplicate and validate configured periods.
 *
 * Config comes from user-editable JSON across an HTTP boundary, so a `0`, a
 * `2.5` or a duplicated `20` must degrade to "this series is empty" rather than
 * producing `NaN` or overwriting a good key with a broken one.
 */
function normalisePeriods(periods: readonly number[] | undefined): number[] {
  const unique = new Set<number>();
  for (const period of periods ?? []) {
    if (isUsablePeriod(period)) unique.add(period);
  }
  return [...unique];
}

/**
 * RSI from a pair of Wilder averages.
 *
 * A zero average loss means the window contained no down moves at all: the
 * indicator is pinned at 100 (or 50 when the window was completely flat, which
 * is genuinely undefined and conventionally reported as neutral).
 */
function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/* -------------------------------------------------------------------------- */
/*  Primitive series                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Exponential moving average, seeded with the simple mean of the first `period`
 * values (index `period - 1`), then `k = 2 / (period + 1)`.
 *
 * Seeding with a plain average instead of `values[0]` matters: a seed of the
 * first tick lets one outlier dominate the series for dozens of bars, which on
 * a 20-period EMA of a volatile altcoin is the difference between a usable
 * trend filter and noise.
 *
 * Indices `0 .. period - 2` are `null`; a period longer than the input yields an
 * all-null series of the input's length.
 */
export function ema(values: number[], period: number): Array<number | null> {
  const out = emptySeries(values.length);
  if (!isUsablePeriod(period) || values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i += 1) {
    const v = values[i];
    if (v === undefined) return out; // dense input: unreachable
    seed += v;
  }

  const k = 2 / (period + 1);
  let previous = seed / period;
  out[period - 1] = previous;

  for (let i = period; i < values.length; i += 1) {
    const v = values[i];
    if (v === undefined) return out;
    previous = v * k + previous * (1 - k);
    out[i] = previous;
  }

  return out;
}

/**
 * Simple moving average over a trailing window of exactly `period` values.
 *
 * Runs a rolling sum (add the entering value, subtract the leaving one) so the
 * cost stays O(n) regardless of period. The first window is summed directly,
 * which keeps the float error from compounding over a long series.
 *
 * Indices `0 .. period - 2` are `null`.
 */
export function sma(values: number[], period: number): Array<number | null> {
  const out = emptySeries(values.length);
  if (!isUsablePeriod(period) || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v === undefined) return out;
    sum += v;

    if (i >= period) {
      const leaving = values[i - period];
      if (leaving === undefined) return out;
      sum -= leaving;
    }
    if (i >= period - 1) out[i] = sum / period;
  }

  return out;
}

/**
 * Wilder's RSI.
 *
 * Smoothing is Wilder's, *not* a plain EMA: the first average gain/loss is the
 * simple mean of the first `period` changes, and every later step is
 * `avg = (prevAvg * (period - 1) + current) / period`. Substituting an EMA here
 * makes the 14-period value drift a point or two away from every published
 * reference, which in turn shifts the overbought/oversold thresholds the model
 * is prompted with.
 *
 * Because a change needs two closes, the first computable value sits at index
 * `period` — one bar later than an EMA of the same period.
 */
export function rsi(values: number[], period: number): Array<number | null> {
  const out = emptySeries(values.length);
  if (!isUsablePeriod(period) || values.length <= period) return out;

  // Seed: simple mean of the first `period` changes (closes[0] → closes[period]).
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const current = values[i];
    const previous = values[i - 1];
    if (current === undefined || previous === undefined) return out;
    const change = current - previous;
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const current = values[i];
    const previous = values[i - 1];
    if (current === undefined || previous === undefined) return out;
    const change = current - previous;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }

  return out;
}

/**
 * Wilder's Average True Range.
 *
 * True range is `max(high - low, |high - prevClose|, |low - prevClose|)`; bar 0
 * has no previous close, so its true range is just `high - low`.
 *
 * The seed mirrors RSI's: the simple mean of the first `period` true ranges
 * *from index 1*, which puts the first ATR at index `period`. That matches
 * TA-Lib's `period` lookback and keeps ATR's warm-up identical to RSI's (both
 * need `period + 1` candles), which matters when the prompt prints both and the
 * bot must not compare a live ATR against a still-warming RSI.
 */
export function atr(klines: Kline[], period: number): Array<number | null> {
  const out = emptySeries(klines.length);
  if (!isUsablePeriod(period) || klines.length <= period) return out;

  // True range for every bar, including bar 0's high-low special case.
  const trueRange = new Array<number>(klines.length).fill(0);
  for (let i = 0; i < klines.length; i += 1) {
    const bar = klines[i];
    if (bar === undefined) return out;
    const range = bar.high - bar.low;
    if (i === 0) {
      trueRange[i] = range;
      continue;
    }
    const previous = klines[i - 1];
    if (previous === undefined) return out;
    trueRange[i] = Math.max(
      range,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    );
  }

  let previousAtr = 0;
  for (let i = 1; i <= period; i += 1) {
    const tr = trueRange[i];
    if (tr === undefined) return out;
    previousAtr += tr;
  }
  previousAtr /= period;
  out[period] = previousAtr;

  for (let i = period + 1; i < klines.length; i += 1) {
    const tr = trueRange[i];
    if (tr === undefined) return out;
    previousAtr = (previousAtr * (period - 1) + tr) / period;
    out[i] = previousAtr;
  }

  return out;
}

/**
 * Moving Average Convergence Divergence.
 *
 * `line = ema(fast) - ema(slow)`, so it is `null` wherever either leg still is.
 * The signal line is the EMA of the *valid* portion of `line`, mapped back onto
 * the original indices — computing it over the raw `line` array would feed the
 * leading `null`s in as zeros and drag the first several signal values toward
 * zero, which is the classic MACD alignment bug.
 *
 * Defaults follow the conventional 12 / 26 / 9.
 */
export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { line: Array<number | null>; signalLine: Array<number | null>; histogram: Array<number | null> } {
  const line = emptySeries(values.length);
  const signalLine = emptySeries(values.length);
  const histogram = emptySeries(values.length);

  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);

  // Compact the valid part of `line`, remembering where each value came from.
  const dense: number[] = [];
  const denseIndices: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const f = fastLine[i];
    const s = slowLine[i];
    if (f === null || f === undefined || s === null || s === undefined) continue;
    const value = f - s;
    line[i] = value;
    dense.push(value);
    denseIndices.push(i);
  }

  const denseSignal = ema(dense, signal);
  for (let j = 0; j < denseIndices.length; j += 1) {
    const index = denseIndices[j];
    const value = denseSignal[j];
    if (index === undefined || value === null || value === undefined) continue;
    signalLine[index] = value;

    const lineValue = line[index];
    if (lineValue !== null && lineValue !== undefined) {
      histogram[index] = lineValue - value;
    }
  }

  return { line, signalLine, histogram };
}

/**
 * Most recent computable value of a series, or `null` when the series is empty
 * or still warming up. Callers only care about "what is the indicator right
 * now", and the tail is exactly where the warm-up `null`s are not.
 */
export function last<T>(series: Array<T | null>): T | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Aggregation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Compute every configured indicator for one timeframe.
 *
 * Disabled groups are omitted entirely (empty records / `null` MACD) rather than
 * populated and ignored, so the prompt builder can branch on presence and the
 * payload stays as small as the configuration allows.
 *
 * Volume is exported raw: it is a fact about the market, not a derived
 * indicator, and `enableVolume` is a presentation choice owned by the prompt
 * builder.
 *
 * Degenerate inputs never throw. An empty `klines` array yields empty series of
 * length 0, and a period longer than the candle count yields an all-`null`
 * series — the caller decides whether that is "not enough history yet" or a
 * misconfiguration.
 */
export function computeTimeframeIndicators(
  timeframe: Timeframe,
  klines: Kline[],
  config: IndicatorConfig,
): TimeframeIndicators {
  const closes = klines.map((kline) => kline.close);
  const volumes = klines.map((kline) => kline.volume);

  const emaSeries: Record<string, Array<number | null>> = {};
  if (config.enableEma) {
    for (const period of normalisePeriods(config.emaPeriods)) {
      emaSeries[String(period)] = ema(closes, period);
    }
  }

  const rsiSeries: Record<string, Array<number | null>> = {};
  if (config.enableRsi) {
    for (const period of normalisePeriods(config.rsiPeriods)) {
      rsiSeries[String(period)] = rsi(closes, period);
    }
  }

  const atrSeries: Record<string, Array<number | null>> = {};
  if (config.enableAtr) {
    for (const period of normalisePeriods(config.atrPeriods)) {
      atrSeries[String(period)] = atr(klines, period);
    }
  }

  const macdSeries = config.enableMacd
    ? {
        fast: config.macdFast,
        slow: config.macdSlow,
        signal: config.macdSignal,
        ...macd(closes, config.macdFast, config.macdSlow, config.macdSignal),
      }
    : null;

  return {
    timeframe,
    klines,
    closes,
    volumes,
    ema: emaSeries,
    rsi: rsiSeries,
    atr: atrSeries,
    macd: macdSeries,
  };
}

/**
 * Flatten one timeframe into the single line the prompt prints.
 *
 * The last close doubles as the current price (the newest candle is the live
 * one), and an empty timeframe reports a price of 0 rather than `null` — the
 * prompt already has to handle "no data" for every other field, and keeping
 * `price` a plain number avoids stringifying `null` into the model's context.
 */
export function latestIndicatorSnapshot(tf: TimeframeIndicators): {
  price: number;
  ema: Record<string, number | null>;
  rsi: Record<string, number | null>;
  atr: Record<string, number | null>;
  macd: { line: number | null; signal: number | null; histogram: number | null } | null;
  volume: number | null;
} {
  const tailOf = (series: Record<string, Array<number | null>>): Record<string, number | null> => {
    const snapshot: Record<string, number | null> = {};
    for (const [period, values] of Object.entries(series)) {
      snapshot[period] = last(values);
    }
    return snapshot;
  };

  return {
    price: last(tf.closes) ?? 0,
    ema: tailOf(tf.ema),
    rsi: tailOf(tf.rsi),
    atr: tailOf(tf.atr),
    macd:
      tf.macd === null
        ? null
        : {
            line: last(tf.macd.line),
            signal: last(tf.macd.signalLine),
            histogram: last(tf.macd.histogram),
          },
    volume: last(tf.volumes),
  };
}
