import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { IndicatorConfig, Kline } from '@aq/shared';
import {
  atr,
  computeTimeframeIndicators,
  ema,
  last,
  latestIndicatorSnapshot,
  macd,
  rsi,
  sma,
} from './indicators.js';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Minimal synthetic candle. Only close/high/low/volume are consulted here. */
function bar(close: number, high = close + 1, low = close - 1, volume = 1): Kline {
  return {
    openTime: 0,
    open: close,
    high,
    low,
    close,
    volume,
    closeTime: 0,
    quoteVolume: 0,
    trades: 0,
    takerBuyBase: 0,
    takerBuyQuote: 0,
  };
}

/**
 * A fully-populated `IndicatorConfig`, written out by hand (instead of going
 * through the zod schema) so these unit tests stay hermetic: the indicators
 * module only needs the fields below, and typing the literal against
 * `IndicatorConfig` makes the compiler prove that the shape is still correct.
 */
function indicatorConfig(overrides: Partial<IndicatorConfig> = {}): IndicatorConfig {
  return {
    kline: { primaryTimeframe: '5m', selectedTimeframes: ['5m', '15m', '1h', '4h'], promptPoints: 30, primaryCount: 30 },
    enableEma: true,
    emaPeriods: [20, 50],
    enableMacd: true,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    enableRsi: true,
    rsiPeriods: [7, 14],
    enableAtr: true,
    atrPeriods: [14],
    enableVolume: true,
    enableOi: true,
    enableFundingRate: true,
    enableQuantData: false,
    enableOiRanking: false,
    ...overrides,
  };
}

/** The classic 20-close series used by every published Wilder RSI walkthrough. */
const WILDER_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
  46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
];

/** Deterministic, non-monotonic series — enough structure to exercise smoothing. */
const WAVE = Array.from({ length: 80 }, (_, i) => 100 + 6 * Math.sin(i / 4) + (i % 5));

/* -------------------------------------------------------------------------- */
/*  ema                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `noUncheckedIndexedAccess` widens an indexed read to `T | undefined`, so the
 * tests need explicit narrowing before doing arithmetic on a series slot.
 */
function isMissing(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** Assert that a series slot is computable and narrow it to `number`. */
function assertNumber(value: number | null | undefined, message?: string): asserts value is number {
  assert.ok(!isMissing(value), message ?? 'expected a computed number, got null');
}

test('ema: seeds with the simple mean and reproduces the reference values', () => {
  const series = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);

  assert.equal(series.length, 10);
  assert.equal(series[4], 3); // mean(1..5), exact in binary floating point

  const tail = series[9];
  assertNumber(tail, 'index 9 should be computable');
  assert.ok(Math.abs(tail - 8) < 1e-9, `index 9 should be ~8, got ${tail}`);

  // The recursion must be the standard 2/(p+1) smoothing, checked independently.
  let expected = 3;
  const k = 2 / (5 + 1);
  for (const value of [6, 7, 8, 9, 10]) expected = value * k + expected * (1 - k);
  assert.ok(Math.abs(tail - expected) < 1e-12);
});

/* -------------------------------------------------------------------------- */
/*  Null padding / warm-up                                                     */
/* -------------------------------------------------------------------------- */

test('null padding: series keep the input length and only the warm-up is null', () => {
  const values = [10, 11, 12, 13, 14, 15, 16, 17];

  const emaSeries = ema(values, 3);
  const smaSeries = sma(values, 3);
  const rsiSeries = rsi(values, 3);

  for (const series of [emaSeries, smaSeries, rsiSeries]) {
    assert.equal(series.length, values.length, 'series must stay aligned with the input');
  }

  assert.deepEqual(emaSeries.slice(0, 2), [null, null]);
  assert.deepEqual(smaSeries.slice(0, 2), [null, null]);
  // RSI needs period *changes*, so it starts one bar later than an EMA/SMA.
  assert.deepEqual(rsiSeries.slice(0, 3), [null, null, null]);

  assert.equal(smaSeries[2], 11); // mean(10, 11, 12)
  assert.equal(smaSeries[3], 12);
  assert.equal(smaSeries[7], 16);
  // EMA(3) seeds at 11 = mean(10, 11, 12), then k = 0.5: it trails a rising
  // series by one bar while it catches up to the raw values.
  assert.deepEqual(emaSeries.slice(2), [11, 12, 13, 14, 15, 16]);

  // A period longer than the series is "not enough history", never a throw.
  const allNull = new Array<number | null>(values.length).fill(null);
  assert.deepEqual(ema(values, 50), allNull);
  assert.deepEqual(sma(values, 50), allNull);
  assert.deepEqual(rsi(values, 50), allNull);
  assert.deepEqual(rsi(values, 8), allNull); // exactly period changes are required

  // Nonsense periods degrade the same way instead of producing NaN.
  assert.deepEqual(ema(values, 0), allNull);
  assert.deepEqual(ema(values, 2.5), allNull);
  assert.deepEqual(sma(values, -3), allNull);
});

test('rsi: pins at the extremes when one side of the window is empty', () => {
  assert.equal(rsi([10, 11, 12, 13], 3)[3], 100); // only gains, average loss is 0
  assert.equal(rsi([13, 12, 11, 10], 3)[3], 0); // only losses, average gain is 0
  assert.equal(rsi([5, 5, 5, 5, 5], 3)[4], 50); // completely flat is undefined → neutral
});

/* -------------------------------------------------------------------------- */
/*  rsi — published Wilder reference table                                     */
/* -------------------------------------------------------------------------- */

test('rsi: reproduces the published Wilder reference table', () => {
  const series = rsi(WILDER_CLOSES, 14);

  // The first six RSI(14) rows of the classic walkthrough, as published.
  const published: Array<[number, number]> = [
    [14, 70.46],
    [15, 66.25],
    [16, 66.48],
    [17, 69.35],
    [18, 66.29],
    [19, 57.92],
  ];

  for (const [index, expected] of published) {
    const actual = series[index];
    assertNumber(actual, `rsi(14) at index ${index} should be computable`);
    assert.ok(
      Math.abs(actual - expected) < 0.01,
      `rsi(14) at index ${index}: expected ~${expected}, got ${actual}`,
    );
  }

  // Everything before the seed is un-computable, not zero.
  assert.deepEqual(series.slice(0, 14), new Array<number | null>(14).fill(null));
});

test('rsi: index 19 is the sixth table row (57.92), not 62.93', () => {
  const series = rsi(WILDER_CLOSES, 14);
  const value = series[19];
  assertNumber(value, 'index 19 should be computable');
  assert.ok(Math.abs(value - 57.915) < 1e-3, `expected 57.915 at index 19, got ${value}`);

  // Note for future readers: the task brief quoted 62.93 for index 19. Wilder
  // smoothing on these 20 closes cannot produce it — 62.93 is the *next* row of
  // the published table, which needs a 21st candle. The assertion below keeps an
  // off-by-one row shift from ever being "fixed" by fudging the recursion.
  assert.ok(Math.abs(value - 62.93) > 1, 'index 19 must not be the seventh table row');
});

/* -------------------------------------------------------------------------- */
/*  No look-ahead                                                              */
/* -------------------------------------------------------------------------- */

test('no look-ahead: appending candles never rewrites earlier values', () => {
  const klines = WAVE.map((close, i) => bar(close, close + 1 + (i % 3), close - 1 - (i % 2)));

  for (const period of [3, 14, 26]) {
    const fullEma = ema(WAVE, period);
    const fullRsi = rsi(WAVE, period);
    const fullAtr = atr(klines, period);

    for (const cut of [period + 1, 40, WAVE.length - 1]) {
      const prefixEma = ema(WAVE.slice(0, cut), period);
      const prefixRsi = rsi(WAVE.slice(0, cut), period);
      const prefixAtr = atr(klines.slice(0, cut), period);

      for (let i = 0; i < cut; i += 1) {
        assert.equal(prefixEma[i], fullEma[i], `ema(${period}) changed at index ${i} when cut to ${cut}`);
        assert.equal(prefixRsi[i], fullRsi[i], `rsi(${period}) changed at index ${i} when cut to ${cut}`);
        assert.equal(prefixAtr[i], fullAtr[i], `atr(${period}) changed at index ${i} when cut to ${cut}`);
      }
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  atr — hand-computed                                                        */
/* -------------------------------------------------------------------------- */

test('atr: hand-computed Wilder values on a five-candle series', () => {
  // close / high / low, chosen so every true range is a clean number:
  //   bar 0: high-low                     = 2   (no previous close)
  //   bar 1: max(3, |12-9|,  |9-9|)       = 3
  //   bar 2: max(3, |13-11|, |10-11|)     = 3
  //   bar 3: max(4, |14-10.5|, |10-10.5|) = 4
  //   bar 4: max(4, |15-13|, |11-13|)     = 4
  const klines = [bar(9, 10, 8), bar(11, 12, 9), bar(10.5, 13, 10), bar(13, 14, 10), bar(14, 15, 11)];

  // Period 2: seed = mean(TR1, TR2) = 3 at index 2, then Wilder smoothing.
  assert.deepEqual(atr(klines, 2), [null, null, 3, 3.5, 3.75]);

  // Period 3: seed = mean(TR1, TR2, TR3) = 10/3 at index 3.
  const period3 = atr(klines, 3);
  assert.deepEqual(period3.slice(0, 3), [null, null, null]);
  assert.ok(Math.abs((period3[3] ?? 0) - 10 / 3) < 1e-12);
  // Then (10/3 * 2 + TR4) / 3 = 32/9 — RSI-style smoothing, not a plain average.
  assert.ok(Math.abs((period3[4] ?? 0) - 32 / 9) < 1e-12);
});

test('atr: bar 0 uses high - low, and a period beyond the data is all null', () => {
  const klines = [bar(9, 10, 8), bar(11, 12, 9)];
  // A 1-period ATR has nothing to smooth, so it is simply TR from index 1 on.
  assert.deepEqual(atr(klines, 1), [null, 3]);
  assert.deepEqual(atr(klines, 2), [null, null]);
  assert.deepEqual(atr([], 14), []);
});

/* -------------------------------------------------------------------------- */
/*  macd                                                                       */
/* -------------------------------------------------------------------------- */

test('macd: re-aligns the signal line onto the original indices', () => {
  const values = Array.from({ length: 60 }, (_, i) => 100 + 10 * Math.sin(i / 5) + i * 0.3);
  const result = macd(values, 3, 5, 4);

  assert.equal(result.line.length, values.length);
  assert.equal(result.signalLine.length, values.length);
  assert.equal(result.histogram.length, values.length);

  // line = ema(fast) - ema(slow), null while either leg is still warming up.
  const fastLeg = ema(values, 3);
  const slowLeg = ema(values, 5);
  for (let i = 0; i < values.length; i += 1) {
    const f = fastLeg[i];
    const s = slowLeg[i];
    if (isMissing(f) || isMissing(s)) assert.equal(result.line[i], null, `line[${i}] should be null`);
    else assert.equal(result.line[i], f - s, `line[${i}] must equal ema(3) - ema(5)`);
  }
  assert.equal(result.line[3], null); // slow leg (5) is still null at index 3
  assert.ok(result.line[4] !== null);

  // The signal is the EMA of the *valid* portion of line, mapped back by index.
  // (Feeding the leading nulls in as zeros is the classic misalignment bug.)
  const dense = result.line.filter((value): value is number => value !== null);
  const denseSignal = ema(dense, 4);
  let denseIndex = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (result.line[i] === null) {
      assert.equal(result.signalLine[i], null, `signalLine[${i}] should be null`);
      assert.equal(result.histogram[i], null, `histogram[${i}] should be null`);
      continue;
    }
    assert.equal(result.signalLine[i], denseSignal[denseIndex], `signalLine[${i}] misaligned`);
    denseIndex += 1;
  }

  // 4 signal inputs need 4 valid line values, so the first signal sits at index 7.
  assert.deepEqual(result.signalLine.slice(0, 7), new Array<number | null>(7).fill(null));
  assert.ok(result.signalLine[7] !== null);

  // histogram = line - signal, wherever both exist.
  for (let i = 0; i < values.length; i += 1) {
    const l = result.line[i];
    const s = result.signalLine[i];
    if (isMissing(l) || isMissing(s)) assert.equal(result.histogram[i], null);
    else assert.equal(result.histogram[i], l - s);
  }
});

test('macd: defaults to 12 / 26 / 9 and stays all-null on short inputs', () => {
  const shortValues = Array.from({ length: 20 }, (_, i) => 100 + i);
  const short = macd(shortValues);
  const allNull = new Array<number | null>(shortValues.length).fill(null);
  assert.deepEqual(short.line, allNull);
  assert.deepEqual(short.signalLine, allNull);
  assert.deepEqual(short.histogram, allNull);

  const longValues = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3));
  assert.deepEqual(macd(longValues), macd(longValues, 12, 26, 9));

  const defaults = macd(longValues);
  assert.deepEqual(defaults.line.slice(0, 25), new Array<number | null>(25).fill(null));
  assert.ok(defaults.line[25] !== null); // first slow-EMA value
  assert.deepEqual(defaults.signalLine.slice(0, 33), new Array<number | null>(33).fill(null));
  assert.ok(defaults.signalLine[33] !== null); // 9 signal inputs after line starts at 25

  assert.deepEqual(macd([], 12, 26, 9), { line: [], signalLine: [], histogram: [] });
});

/* -------------------------------------------------------------------------- */
/*  last                                                                       */
/* -------------------------------------------------------------------------- */

test('last: returns the most recent non-null value', () => {
  assert.equal(last([null, null, 1, 2, null]), 2);
  assert.equal(last([null, null]), null);
  assert.equal(last([]), null);
  assert.equal(last([0, null]), 0); // 0 is a value, not a missing one
});

/* -------------------------------------------------------------------------- */
/*  computeTimeframeIndicators                                                 */
/* -------------------------------------------------------------------------- */

test('computeTimeframeIndicators: honours the enable flags', () => {
  const klines = Array.from({ length: 40 }, (_, i) => bar(100 + i, 101 + i, 99 + i, 1 + i));
  const tf = computeTimeframeIndicators(
    '15m',
    klines,
    indicatorConfig({
      enableEma: false,
      enableRsi: false,
      enableAtr: false,
      enableMacd: false,
    }),
  );

  assert.equal(tf.timeframe, '15m');
  assert.equal(tf.klines, klines);
  assert.deepEqual(tf.ema, {});
  assert.deepEqual(tf.rsi, {});
  assert.deepEqual(tf.atr, {});
  assert.equal(tf.macd, null);

  // Volume is raw regardless of `enableVolume` — that flag belongs to the prompt.
  assert.equal(tf.closes.length, 40);
  assert.equal(tf.volumes.length, 40);
  assert.equal(tf.closes[39], 139);
  assert.equal(tf.volumes[39], 40);
});

test('computeTimeframeIndicators: keys periods as strings and matches the primitives', () => {
  const klines = Array.from({ length: 40 }, (_, i) => bar(100 + i, 101 + i, 99 + i, 1 + i));
  const tf = computeTimeframeIndicators(
    '5m',
    klines,
    indicatorConfig({ emaPeriods: [5, 20], rsiPeriods: [7], atrPeriods: [14] }),
  );
  const closes = klines.map((kline) => kline.close);

  assert.deepEqual(Object.keys(tf.ema), ['5', '20']);
  assert.deepEqual(Object.keys(tf.rsi), ['7']);
  assert.deepEqual(Object.keys(tf.atr), ['14']);

  assert.deepEqual(tf.ema['5'], ema(closes, 5));
  assert.deepEqual(tf.ema['20'], ema(closes, 20));
  assert.deepEqual(tf.rsi['7'], rsi(closes, 7));
  assert.deepEqual(tf.atr['14'], atr(klines, 14));

  const reference = macd(closes, 12, 26, 9);
  assert.ok(tf.macd !== null);
  assert.equal(tf.macd.fast, 12);
  assert.equal(tf.macd.slow, 26);
  assert.equal(tf.macd.signal, 9);
  assert.deepEqual(tf.macd.line, reference.line);
  assert.deepEqual(tf.macd.signalLine, reference.signalLine);
  assert.deepEqual(tf.macd.histogram, reference.histogram);
});

test('computeTimeframeIndicators: oversized and malformed periods stay null', () => {
  const klines = Array.from({ length: 10 }, (_, i) => bar(100 + i));
  const tf = computeTimeframeIndicators(
    '1h',
    klines,
    indicatorConfig({ emaPeriods: [200, 0, 5, 5, 2.5], rsiPeriods: [200], atrPeriods: [200] }),
  );

  const allNull = new Array<number | null>(10).fill(null);
  // Malformed and duplicated periods are dropped; an oversized-but-valid period
  // is kept as a key whose series is entirely null ("not enough history yet").
  assert.deepEqual(Object.keys(tf.ema), ['5', '200']);
  assert.deepEqual(tf.ema['5'], ema(klines.map((k) => k.close), 5));
  assert.deepEqual(tf.ema['200'], allNull);
  assert.deepEqual(tf.rsi['200'], allNull);
  assert.deepEqual(tf.atr['200'], allNull);
  assert.deepEqual(tf.macd?.line, allNull);
  assert.deepEqual(tf.macd?.signalLine, allNull);
});

test('computeTimeframeIndicators: empty input yields a well-formed empty structure', () => {
  const tf = computeTimeframeIndicators('4h', [], indicatorConfig());

  assert.deepEqual(tf.klines, []);
  assert.deepEqual(tf.closes, []);
  assert.deepEqual(tf.volumes, []);
  assert.deepEqual(tf.ema, { '20': [], '50': [] });
  assert.deepEqual(tf.rsi, { '7': [], '14': [] });
  assert.deepEqual(tf.atr, { '14': [] });
  assert.deepEqual(tf.macd, { fast: 12, slow: 26, signal: 9, line: [], signalLine: [], histogram: [] });
});

/* -------------------------------------------------------------------------- */
/*  latestIndicatorSnapshot                                                    */
/* -------------------------------------------------------------------------- */

test('latestIndicatorSnapshot: reads the tail of every series', () => {
  const klines = Array.from({ length: 60 }, (_, i) => bar(100 + i, 101 + i, 99 + i, 2 + i));
  const tf = computeTimeframeIndicators(
    '1h',
    klines,
    indicatorConfig({ emaPeriods: [10], rsiPeriods: [14], atrPeriods: [14] }),
  );
  const snapshot = latestIndicatorSnapshot(tf);

  assert.equal(snapshot.price, 159);
  assert.equal(snapshot.volume, 61);
  assert.equal(snapshot.ema['10'], last(tf.ema['10'] ?? []));
  assert.equal(snapshot.rsi['14'], last(tf.rsi['14'] ?? []));
  assert.equal(snapshot.atr['14'], last(tf.atr['14'] ?? []));
  assert.ok(snapshot.ema['10'] !== null && snapshot.rsi['14'] !== null && snapshot.atr['14'] !== null);

  assert.deepEqual(snapshot.macd, {
    line: last(tf.macd?.line ?? []),
    signal: last(tf.macd?.signalLine ?? []),
    histogram: last(tf.macd?.histogram ?? []),
  });
  assert.ok(snapshot.macd !== null && snapshot.macd.line !== null && snapshot.macd.signal !== null);

  // A timeframe with MACD disabled reports null, and an empty timeframe reports
  // price 0 / volume null instead of throwing.
  const withoutMacd = latestIndicatorSnapshot(
    computeTimeframeIndicators('1h', klines, indicatorConfig({ enableMacd: false })),
  );
  assert.equal(withoutMacd.macd, null);

  const empty = latestIndicatorSnapshot(computeTimeframeIndicators('1m', [], indicatorConfig()));
  assert.equal(empty.price, 0);
  assert.equal(empty.volume, null);
  assert.deepEqual(empty.ema, { '20': null, '50': null });
  assert.equal(empty.macd?.line, null);
});
