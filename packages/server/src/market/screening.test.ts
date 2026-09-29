import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenSymbols, type ScreenableSymbol } from './screening.js';

/* -------------------------------------------------------------------------- */
/*  模型自己筛币                                                                 */
/* -------------------------------------------------------------------------- */

const s = (
  symbol: string,
  changePercent24h: number,
  quoteVolume24h: number,
  amplitudePercent: number,
): ScreenableSymbol => ({ symbol, changePercent24h, quoteVolume24h, amplitudePercent });

const UNIVERSE: ScreenableSymbol[] = [
  s('BTCUSDT', -0.3, 10_400_000_000, 1.2), // 巨无霸、几乎不动
  s('MIDUSDT', 4.2, 120_000_000, 6.5), // 中盘、有波动 ← 目标
  s('MID2USDT', -5.1, 80_000_000, 8.1), // 中盘、跌得多 ← 目标
  s('BIGUSDT', 1.0, 3_000_000_000, 2.0), // 大盘、波动小
  s('TINYUSDT', 33.0, 4_000_000, 70.0), // 涨得多、振幅大，但成交额太小 ← 做不动
  s('HUGEUSDT', 0.5, 900_000_000, 3.0), // 大盘
];

test('★ 筛币：模型能按自己的条件找标的，而不是只能看系统给的榜', () => {
  /*
   * ## 这一层为什么必须存在（用户 2026-09-30 的原话）
   *
   * > 「币安支持的币种我觉得都应该在模型判断得范围」
   * > 「**模型是大脑，系统只是他的手脚**」
   *
   * 第 0 层让它**看见**全部标的；第 1 层给出各维度的头部。
   * 但两者都是**系统选好的视角** —— 模型没法说"我要看成交额 5000万–2亿、
   * 波动大于 5% 的那一批"。这个工具就是给它那个能力：
   * **条件由它给，系统只负责筛。**
   */
  const rows = screenSymbols({
    symbols: UNIVERSE,
    criteria: {
      minQuoteVolume24h: 50_000_000,
      maxQuoteVolume24h: 200_000_000,
      minAmplitudePercent: 5,
    },
    defaultLimit: 10,
    maxLimit: 50,
  });
  assert.deepEqual(
    rows.map((r) => r.symbol),
    ['MIDUSDT', 'MID2USDT'],
    '只该剩下"中盘 + 有波动"那两个，且按成交额降序（MIDUSDT 1.2 亿 > MID2USDT 8 千万）',
  );
});

test('★ limit 有上限 —— 模型不能一次要走整个市场', () => {
  /*
   * 它可能说"给我看全部"（527 个）—— 那会把提示词预算挤爆、把真正该看的东西挤掉。
   * 上限由**系统**把关（这是"手脚"的职责），而"要哪些"仍由它决定。
   */
  const rows = screenSymbols({
    symbols: UNIVERSE,
    criteria: {},
    defaultLimit: 10,
    maxLimit: 2,
  });
  assert.equal(rows.length, 2, '超过上限时按上限截断');
  assert.deepEqual(
    rows.map((r) => r.symbol),
    ['BTCUSDT', 'BIGUSDT'],
    '无条件时按成交额降序 —— 最活跃的在最前',
  );
});

test('不给 limit 时用默认值', () => {
  const rows = screenSymbols({ symbols: UNIVERSE, criteria: {}, defaultLimit: 3, maxLimit: 50 });
  assert.equal(rows.length, 3);
});

test('模型给的 limit 超过上限时被压到上限', () => {
  const rows = screenSymbols({
    symbols: UNIVERSE,
    criteria: { limit: 999 },
    defaultLimit: 10,
    maxLimit: 4,
  });
  assert.equal(rows.length, 4, '★ 上限由系统把关，模型要不走更多');
});

test('★ 涨跌幅可以双向限（找"跌得多的"与"涨得多的"用同一套条件）', () => {
  const up = screenSymbols({
    symbols: UNIVERSE,
    criteria: { minChangePercent: 3, minQuoteVolume24h: 50_000_000 },
    defaultLimit: 10,
    maxLimit: 50,
  });
  assert.deepEqual(up.map((r) => r.symbol), ['MIDUSDT'], '涨幅 ≥3% 且成交额达标的');

  const down = screenSymbols({
    symbols: UNIVERSE,
    criteria: { maxChangePercent: -3, minQuoteVolume24h: 50_000_000 },
    defaultLimit: 10,
    maxLimit: 50,
  });
  assert.deepEqual(down.map((r) => r.symbol), ['MID2USDT'], '跌幅 ≤-3% 的那一个');
});

test('无条件时返回全部（按成交额降序），而不是空', () => {
  const rows = screenSymbols({ symbols: UNIVERSE, criteria: {}, defaultLimit: 10, maxLimit: 50 });
  assert.equal(rows.length, UNIVERSE.length);
  assert.equal(rows[0]!.symbol, 'BTCUSDT', '成交额最大的在最前');
});

test('没有符合条件的返回空数组，让模型知道"这个条件现在什么也没有"', () => {
  const rows = screenSymbols({
    symbols: UNIVERSE,
    criteria: { minQuoteVolume24h: 999_000_000_000 },
    defaultLimit: 10,
    maxLimit: 50,
  });
  assert.equal(rows.length, 0);
});

test('数据无效的标的被跳过，而不是当成 0 混进结果', () => {
  const rows = screenSymbols({
    symbols: [s('BROKENUSDT', Number.NaN, 500_000_000, 3)],
    criteria: {},
    defaultLimit: 10,
    maxLimit: 50,
  });
  assert.equal(rows.length, 0, '涨跌幅是 NaN 的标的不能混进来');
});
