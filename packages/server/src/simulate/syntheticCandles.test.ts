/**
 * 确定性 K 线夹具的形状。
 *
 * ## 为什么这些用例存在
 *
 * `npm run sim` 里有两条校验断言"止损 / 止盈真的被触发并入账"。它们的成败
 * 只取决于夹具的一个几何性质：**开仓后的下一根 K 线，影线必须够得到保护位**。
 *
 * 这个性质有两侧，而两侧的失效方式完全不同：
 *
 * - **方向性影线太短** → 保护位够不到 → 那两条校验变红，而红的原因与代码无关。
 *   这正是修掉它之前的状态：行情安静时 `价格穿越止损 0 次`，读起来像缺陷、
 *   其实是天气。**一个因为外部原因变红的校验，会训练人忽略红色。**
 *
 * - **反向影线太长** → 同一根 K 线同时跨越止损与止盈 → `SimulatedExchange`
 *   按「止损优先」结算（它的注释写明这是保守假设）→ **止盈那条路径永远不会
 *   被走到，而校验可能仍然是绿的**（止损确实触发了）。
 *
 * 第二侧尤其阴险：它让覆盖悄悄消失，而不是让测试变红。所以两侧都要钉，
 * 而"交替方向"也要钉 —— 只有两个方向都在，止损与止盈才都会被走到。
 *
 * 阈值取自 `scripts/simulate.ts` 里脚本化模型提出的保护距离（紧保护档
 * 0.4–0.5% 止损 / 0.7–0.9% 止盈）。**改那里就要回来看这里。**
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SYNTHETIC_FIXTURE_SHAPE, TIMEFRAME_MS, buildSyntheticMarket } from './syntheticCandles.js';
import { TIMEFRAMES, type Kline, type Timeframe } from '@aq/shared';

/** 脚本化模型在紧保护档提出的最宽止盈（`tight` 数组里的最大值）。 */
const TIGHT_WIDEST_TARGET = 0.9;
/** 同上，最紧的止损 —— 反向影线必须明显短于它。 */
const TIGHT_TIGHTEST_STOP = 0.4;

const START = Date.UTC(2026, 0, 1, 0, 0, 0);
const PRIMARY: Timeframe = '5m';

function build(count = 40) {
  return buildSyntheticMarket({
    symbols: ['BTCUSDT'],
    timeframes: ['5m', '15m', '1h'],
    primary: PRIMARY,
    candlesPerTimeframe: count,
    startTime: START,
    basePrices: { BTCUSDT: 100_000 },
  });
}

const bars = (count = 40): Kline[] => build(count).get('BTCUSDT')!.klines.get(PRIMARY)!;

/* -------------------------------------------------------------------------- */

test('方向性影线够得到最紧的止盈 —— 否则"止盈会被触发"这条校验就是在赌行情', () => {
  const candles = bars();
  const wick = SYNTHETIC_FIXTURE_SHAPE.directionalWick * 100;

  assert.ok(
    wick > TIGHT_WIDEST_TARGET,
    `方向性影线 ${wick}% 必须大于最宽止盈 ${TIGHT_WIDEST_TARGET}%，否则行情平静时保护位够不到`,
  );

  /* 逐根核对，而不是只看常量：常量对了但没被用上，是另一回事。 */
  for (const [i, candle] of candles.entries()) {
    const body = Math.max(candle.open, candle.close);
    const wickSide = i % 2 === 0 ? candle.high / body : body / candle.low;
    const percent = (wickSide - 1) * 100;
    assert.ok(
      percent >= TIGHT_WIDEST_TARGET,
      `第 ${i} 根的方向性影线只有 ${percent.toFixed(3)}%，够不到 ${TIGHT_WIDEST_TARGET}% 的止盈`,
    );
  }
});

test('反向影线远短于最紧的止损 —— 否则同一根 K 线会同时跨越止损与止盈，止盈路径静默消失', () => {
  const candles = bars();
  const opposite = SYNTHETIC_FIXTURE_SHAPE.oppositeWick * 100;

  assert.ok(
    opposite < TIGHT_TIGHTEST_STOP,
    `反向影线 ${opposite}% 必须小于最紧止损 ${TIGHT_TIGHTEST_STOP}%：` +
      'SimulatedExchange 在同一根内按止损优先结算，反向影线一旦越过止损，' +
      '止盈那条路径就再也不会被走到，而校验仍可能是绿的',
  );

  for (const [i, candle] of candles.entries()) {
    const body = Math.min(candle.open, candle.close);
    const wickSide = i % 2 === 0 ? body / candle.low : candle.high / body;
    const percent = (wickSide - 1) * 100;
    assert.ok(percent < TIGHT_TIGHTEST_STOP, `第 ${i} 根的反向影线 ${percent.toFixed(3)}% 越过了止损距离`);
  }
});

test('影线方向逐根交替 —— 只有两个方向都在，止损与止盈才都会被走到', () => {
  const candles = bars();
  for (const [i, candle] of candles.entries()) {
    const bodyTop = Math.max(candle.open, candle.close);
    const bodyBottom = Math.min(candle.open, candle.close);
    const upWick = candle.high / bodyTop;
    const downWick = bodyBottom / candle.low;

    if (i % 2 === 0) {
      assert.ok(upWick > downWick, `第 ${i} 根应为上影线`);
    } else {
      assert.ok(downWick > upWick, `第 ${i} 根应为下影线`);
    }
  }
});

test('每个周期都给出请求的根数（否则回放会在中途没数据）', () => {
  const count = 40;
  const sources = build(count);
  for (const tf of ['5m', '15m', '1h'] as Timeframe[]) {
    const series = sources.get('BTCUSDT')!.klines.get(tf)!;
    assert.equal(series.length, count, `${tf} 应有 ${count} 根`);
  }
});

test('K 线的时间戳与周期对齐，且 closeTime 紧跟 openTime', () => {
  const count = 40;
  const sources = build(count);
  for (const tf of ['5m', '15m', '1h'] as Timeframe[]) {
    const step = TIMEFRAME_MS[tf]!;
    const series = sources.get('BTCUSDT')!.klines.get(tf)!;
    for (const candle of series) {
      assert.equal(candle.openTime % step, 0, `${tf} 的 openTime 未对齐到周期边界`);
      assert.equal(candle.closeTime, candle.openTime + step - 1, `${tf} 的 closeTime 不等于周期末`);
    }
    /* 相邻两根必须衔接：中间的空洞本身就是一次人造的价格跳空。 */
    for (let i = 1; i < series.length; i += 1) {
      assert.equal(series[i]!.openTime, series[i - 1]!.openTime + step, `${tf} 第 ${i} 根与上一根不衔接`);
    }
  }
});

test('聚合出来的高周期确实是若干低周期之和（否则多周期看到的不是同一段行情）', () => {
  const sources = build(40);
  const five = sources.get('BTCUSDT')!.klines.get('5m')!;
  const hour = sources.get('BTCUSDT')!.klines.get('1h')!;

  /* 取最后一根 1h（一定对应 12 根完整的 5m），按 openTime 找出它的成员。 */
  const last = hour[hour.length - 1]!;
  const members = five.filter((k) => k.openTime >= last.openTime && k.closeTime <= last.closeTime);
  assert.equal(members.length, 12, '一根 1h 应由 12 根 5m 聚合而成');

  assert.equal(last.open, members[0]!.open, '1h 开盘价应等于首根 5m 的开盘价');
  assert.equal(last.close, members[members.length - 1]!.close, '1h 收盘价应等于末根 5m 的收盘价');
  assert.equal(
    last.high,
    Math.max(...members.map((k) => k.high)),
    '1h 最高价应等于成员的最高价 —— 影线必须被传递，否则高周期的波动是假的',
  );
  assert.equal(last.low, Math.min(...members.map((k) => k.low)), '1h 最低价应等于成员的最低价');
  const volume = members.reduce((sum, k) => sum + k.volume, 0);
  assert.ok(Math.abs(last.volume - volume) < 1e-6, '1h 成交量应是成员之和');
});

test('价格序列不是常数 —— 完全平的序列会让 RSI/ATR 退化成 NaN', () => {
  const closes = bars().map((k) => k.close);
  assert.ok(new Set(closes).size > 10, '收盘价至少要有十种取值，否则指标没有可算的变化');
  for (const value of closes) {
    assert.ok(Number.isFinite(value) && value > 0, '收盘价必须是正的有限数');
  }
});

test('OHLC 自洽：影线包住实体', () => {
  const candles = bars();
  for (const [i, candle] of candles.entries()) {
    const top = Math.max(candle.open, candle.close);
    const bottom = Math.min(candle.open, candle.close);
    assert.ok(candle.high >= top, `第 ${i} 根 high 低于实体顶部`);
    assert.ok(candle.low <= bottom, `第 ${i} 根 low 高于实体底部`);
    assert.ok(candle.high >= candle.low, `第 ${i} 根 high < low`);
  }
});

test('缺少基准价时立刻报错，而不是产出一段来路不明的行情', () => {
  assert.throws(
    () =>
      buildSyntheticMarket({
        symbols: ['BTCUSDT', 'DOGEUSDT'],
        timeframes: ['5m'],
        primary: PRIMARY,
        candlesPerTimeframe: 10,
        startTime: START,
        basePrices: { BTCUSDT: 100_000 },
      }),
    /DOGEUSDT/,
  );
});

test('比主周期更细的周期被明确拒绝，而不是静默产出一段空序列', () => {
  /*
   * 空序列走到回放里，表现是"这个周期还没有可见的 K 线" —— 一个看起来像预热
   * 问题的现象，而真正的原因是夹具根本生成不出来。**静默的空比报错贵得多。**
   */
  assert.throws(
    () =>
      buildSyntheticMarket({
        symbols: ['BTCUSDT'],
        timeframes: ['1m'],
        primary: PRIMARY,
        candlesPerTimeframe: 5,
        startTime: START,
        basePrices: { BTCUSDT: 100_000 },
      }),
    /1m/,
  );
});

test('主周期及更粗的周期都能构造出来（夹具覆盖 TIMEFRAMES 里 >= primary 的那些）', () => {
  const primaryMs = TIMEFRAME_MS[PRIMARY]!;
  const coarser = TIMEFRAMES.filter((tf) => TIMEFRAME_MS[tf]! >= primaryMs);

  const sources = buildSyntheticMarket({
    symbols: ['BTCUSDT'],
    timeframes: coarser,
    primary: PRIMARY,
    candlesPerTimeframe: 5,
    startTime: START,
    basePrices: { BTCUSDT: 100_000 },
  });
  const klines = sources.get('BTCUSDT')!.klines;
  for (const tf of coarser) {
    assert.equal(klines.get(tf)?.length, 5, `${tf} 未生成`);
  }
});
