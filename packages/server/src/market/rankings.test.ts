import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankUniverse, type RankableTicker } from './rankings.js';

/* -------------------------------------------------------------------------- */
/*  聚焦层：一次算出所有榜                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 构造一个可控的小宇宙。
 *
 * 每个标的的设计意图都写在注释里 —— 断言的是**规则**（谁该排在谁前面），
 * 而不是"某个真实市场的脸色"（`scoring.ts` 的注释里记过这个教训）。
 */
function ticker(
  symbol: string,
  opts: {
    changePercent24h: number;
    quoteVolume24h: number;
    /** 24h 振幅 = (high - low) / low，用 low 与振幅反推 high。 */
    amplitudePercent?: number;
    fundingRate?: number;
  },
): RankableTicker {
  const low = 100;
  const amplitude = (opts.amplitudePercent ?? 1) / 100;
  return {
    symbol,
    price: low,
    low24h: low,
    high24h: low * (1 + amplitude),
    changePercent24h: opts.changePercent24h,
    quoteVolume24h: opts.quoteVolume24h,
    fundingRate: opts.fundingRate ?? 0,
  };
}

test('★ 聚焦层：一次算出五个榜，而不是分五次拉数据', () => {
  /*
   * ## 为什么是"一次算完"
   *
   * 五个维度（成交额/涨幅/跌幅/波动率/资金费极值）**用的是同一份全市场 ticker**。
   * 而 `screenUniverse()` 内部走的是 `getUniverse(true)` —— **强制刷新**。
   * 按维度调五次 = **五次强制拉全市场 ticker（weight 40 × 5）**，纯浪费。
   *
   * 所以这一层做成**纯函数**：调用方拉一次 ticker，这里一次算出所有榜。
   */
  const universe: RankableTicker[] = [
    ticker('BIGUSDT', { changePercent24h: 1, quoteVolume24h: 900_000_000 }),
    ticker('PUMPUSDT', { changePercent24h: 42, quoteVolume24h: 300_000_000 }),
    ticker('DUMPUSDT', { changePercent24h: -31, quoteVolume24h: 200_000_000 }),
    ticker('WILDUSDT', { changePercent24h: 3, quoteVolume24h: 150_000_000, amplitudePercent: 45 }),
    ticker('FUNDUSDT', { changePercent24h: 2, quoteVolume24h: 120_000_000, fundingRate: -0.019 }),
    /* 成交额不达标 —— 不该出现在任何榜里（僵尸币霸榜会挤掉真正可做的机会）。 */
    ticker('TINYUSDT', { changePercent24h: 99, quoteVolume24h: 500_000, amplitudePercent: 80 }),
  ];

  const r = rankUniverse({ tickers: universe, limit: 3, minQuoteVolume24h: 10_000_000 });

  assert.equal(r.quoteVolume[0]!.symbol, 'BIGUSDT', '成交额榜第一是最大的');
  assert.equal(r.gainers[0]!.symbol, 'PUMPUSDT', '涨幅榜第一是涨最多的');
  assert.equal(r.losers[0]!.symbol, 'DUMPUSDT', '跌幅榜第一是跌最多的');
  assert.equal(r.volatility[0]!.symbol, 'WILDUSDT', '波动率榜第一是振幅最大的');
  assert.equal(
    r.fundingExtreme[0]!.symbol,
    'FUNDUSDT',
    '资金费极值榜按 |资金费率| 排 —— 极端资金费本身就是机会/风险的信号',
  );

  /* 门槛必须生效：TINYUSDT 虽然涨 99%、振幅 80%，但它不可做，不该来挤位置。 */
  const all = [...r.quoteVolume, ...r.gainers, ...r.losers, ...r.volatility, ...r.fundingExtreme];
  assert.ok(
    !all.some((x) => x.symbol === 'TINYUSDT'),
    '★ 成交额不达标的标的不得上榜（否则"涨得最多"永远是那些做不动的币）',
  );

  /* 每个榜都不超过 limit。 */
  for (const [name, rows] of Object.entries(r)) {
    assert.ok(rows.length <= 3, `${name} 榜不该超过 limit（实际 ${rows.length}）`);
  }
});

test('★ 每个榜都带上"跨榜可比"的数字 —— 模型要靠它判断值不值得深看', () => {
  /*
   * 只给符号没用：模型看到 `XYZUSDT` 排在某榜第一，却不知道它是"涨 42%"还是"涨 0.4%"。
   * 所以每行都带上涨跌幅与成交额 —— 那正是决定"值不值得深看"的两个数字。
   */
  const r = rankUniverse({
    tickers: [ticker('AUSDT', { changePercent24h: 7.5, quoteVolume24h: 50_000_000 })],
    limit: 5,
    minQuoteVolume24h: 10_000_000,
  });
  const row = r.gainers[0]!;
  assert.equal(row.changePercent24h, 7.5, '要带 24h 涨跌幅');
  assert.equal(row.quoteVolume24h, 50_000_000, '要带成交额');
});

test('空宇宙与全被门槛滤掉时返回空榜，而不是抛错', () => {
  const empty = rankUniverse({ tickers: [], limit: 5, minQuoteVolume24h: 0 });
  for (const [name, rows] of Object.entries(empty)) {
    assert.equal(rows.length, 0, `${name} 应为空数组`);
  }
  const filtered = rankUniverse({
    tickers: [ticker('TINYUSDT', { changePercent24h: 99, quoteVolume24h: 1 })],
    limit: 5,
    minQuoteVolume24h: 10_000_000,
  });
  assert.equal(filtered.gainers.length, 0, '全被滤掉时给空数组，让上层决定怎么交代');
});

test('数据缺失的标的被跳过，而不是当成 0 混进榜里', () => {
  /*
   * 交易所偶尔会给出 `lastPrice = 0` 或缺失字段的条目（下架中的合约）。
   * 把它当成"涨 0%"塞进榜里，会让模型以为市场里有个一直不动的标的 —— 那是假事实。
   */
  const broken: RankableTicker = {
    symbol: 'BROKENUSDT',
    price: 0,
    low24h: 0,
    high24h: 0,
    changePercent24h: Number.NaN,
    quoteVolume24h: 500_000_000,
    fundingRate: Number.NaN,
  };
  const r = rankUniverse({
    tickers: [broken, ticker('OKUSDT', { changePercent24h: 1, quoteVolume24h: 100_000_000 })],
    limit: 5,
    minQuoteVolume24h: 10_000_000,
  });
  assert.equal(r.quoteVolume.length, 1, '价格无效的标的该被跳过');
  assert.equal(r.quoteVolume[0]!.symbol, 'OKUSDT');
});
