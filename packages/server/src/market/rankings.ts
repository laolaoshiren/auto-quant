/**
 * 聚焦层（第 1 层）：把一份全市场 ticker **一次**算成多个维度的 Top 榜。
 *
 * ## 为什么是纯函数（而不是给 `MarketDataService` 加个方法）
 *
 * ① **§5.4 的偏好**：纯函数可穷举测试，不需要网络、时钟与桩对象 —— 断言的是**规则**，
 *    不是"某个真实市场的脸色"。
 * ② **性能**：这几个维度用的是**同一份 ticker**，而 `screenUniverse()` 每次调用都会
 *    `getUniverse(true)`（**强制刷新**）—— 按维度调五次就是**五次全市场拉取**（weight 40 × 5）。
 *    这里"输入一次、输出五个榜"，调用方拉一次就够。
 *
 * ## 这一层为什么重要（用户 2026-09-30 的原话）
 *
 * > 「币安支持的币种我觉得都应该在模型判断得范围」
 *
 * 第 0 层「全景」让模型**看见**全部标的；这一层告诉它**哪里在动** ——
 * 涨幅/跌幅/波动率/资金费极值/成交额，每个维度取前几名。
 * 两者合起来，模型才谈得上"自己决定看什么"（用户的原则：**模型是大脑，系统只是手脚**）。
 */

/** 参与排名的原始行 —— 由调用方从全市场 ticker 摊平而来。 */
export interface RankableTicker {
  symbol: string;
  price: number;
  low24h: number;
  high24h: number;
  changePercent24h: number;
  quoteVolume24h: number;
  /** 当期资金费率（小数，例如 `-0.0001`）；读不到给 0。 */
  fundingRate: number;
}

/** 一个榜里的一行。 */
export interface RankingRow {
  symbol: string;
  /**
   * 该维度的**语义值**（不是排序键）：
   * 成交额榜是成交额、涨跌榜是涨跌幅（带符号）、波动率榜是振幅、资金费榜是费率本身。
   */
  value: number;
  changePercent24h: number;
  quoteVolume24h: number;
}

export interface UniverseRankings {
  quoteVolume: RankingRow[];
  gainers: RankingRow[];
  losers: RankingRow[];
  volatility: RankingRow[];
  fundingExtreme: RankingRow[];
}

export function rankUniverse(input: {
  tickers: readonly RankableTicker[];
  /** 每个榜取前几名。 */
  limit: number;
  /**
   * 成交额门槛。
   *
   * ⚠️ **它必须存在**：没有它，"涨幅榜"永远是那些成交额几十万的僵尸币 ——
   * 模型会以为市场里遍地是机会，而实际上那些标的根本做不动（滑点吃掉全部利润）。
   * 门槛把"看得到"与"做得到"对齐。
   */
  minQuoteVolume24h: number;
}): UniverseRankings {
  const usable = input.tickers.filter(
    (t) =>
      /* 下架中的合约会给出 price = 0 —— 把它当成"涨 0%"混进榜里就是假事实。 */
      t.price > 0 &&
      Number.isFinite(t.changePercent24h) &&
      Number.isFinite(t.quoteVolume24h) &&
      t.quoteVolume24h >= input.minQuoteVolume24h,
  );

  const rows = usable.map((t) => ({
    symbol: t.symbol,
    changePercent24h: t.changePercent24h,
    quoteVolume24h: t.quoteVolume24h,
    amplitude: t.low24h > 0 ? (t.high24h - t.low24h) / t.low24h : 0,
    fundingRate: Number.isFinite(t.fundingRate) ? t.fundingRate : 0,
  }));

  /**
   * 按 `score` 取前 `limit` 名，`valueOf` 决定**每行带出去的语义值**。
   *
   * 两者分开是必要的：跌幅榜的排序键是 `-涨跌幅`，但它该带出去的值仍是**涨跌幅本身**
   * （模型要看的是"跌了多少"，不是"负的跌幅"）。
   */
  const top = (
    score: (row: (typeof rows)[number]) => number,
    valueOf: (row: (typeof rows)[number]) => number,
  ): RankingRow[] =>
    [...rows]
      .sort((a, b) => score(b) - score(a))
      .slice(0, input.limit)
      .map((row) => ({
        symbol: row.symbol,
        value: valueOf(row),
        changePercent24h: row.changePercent24h,
        quoteVolume24h: row.quoteVolume24h,
      }));

  return {
    quoteVolume: top(
      (r) => r.quoteVolume24h,
      (r) => r.quoteVolume24h,
    ),
    gainers: top(
      (r) => r.changePercent24h,
      (r) => r.changePercent24h,
    ),
    losers: top(
      (r) => -r.changePercent24h,
      (r) => r.changePercent24h,
    ),
    volatility: top(
      (r) => r.amplitude,
      (r) => r.amplitude,
    ),
    /* 资金费看**绝对值**：极度为正（多头拥挤）与极度为负（空头拥挤）都是信号。 */
    fundingExtreme: top(
      (r) => Math.abs(r.fundingRate),
      (r) => r.fundingRate,
    ),
  };
}
