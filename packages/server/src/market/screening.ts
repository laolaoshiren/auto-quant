/**
 * 第 3 层「索取」的筛选器 —— 让**模型自己**按条件找标的。
 *
 * ## 为什么需要它（用户 2026-09-30 的原话）
 *
 * > 「币安支持的币种我觉得都应该在模型判断得范围」
 * > 「**模型是大脑，系统只是他的手脚**」
 *
 * 第 0 层「全景」让它**看见**全部标的；第 1 层「聚焦」给出各维度的头部。
 * 但这两层都是**系统选好的视角** —— 模型没法说
 * 「我要看成交额 5000 万–2 亿、24h 波动大于 5% 的那一批」。
 *
 * 这个纯函数就是给它那个能力：**条件由它给，系统只负责筛**。
 *
 * ## 边界（"手脚"该守的那条线）
 *
 * `limit` 有上限：它可能说"给我看全部"（527 个），那会把提示词预算挤爆、
 * 把真正该看的东西挤掉。**要哪些由它决定，最多给几个由系统把关。**
 */

/** 可参与筛选的一行 —— 由调用方从全市场快照摊平而来。 */
export interface ScreenableSymbol {
  symbol: string;
  changePercent24h: number;
  quoteVolume24h: number;
  /** 24h 振幅（百分数，例如 `6.5` 表示 6.5%）。 */
  amplitudePercent: number;
}

/**
 * 筛选条件 —— **全部可选**。
 *
 * 全可选是有意的：模型可以只给一个下限（"成交额大于 5000 万"），
 * 也可以给完整区间（"成交额 5000万–2亿 且 波动 3%–10%"）。系统不预设它该怎么想。
 */
export interface ScreenCriteria {
  minQuoteVolume24h?: number;
  maxQuoteVolume24h?: number;
  minChangePercent?: number;
  maxChangePercent?: number;
  minAmplitudePercent?: number;
  maxAmplitudePercent?: number;
  /** 模型希望的条数；会被压到 `maxLimit` 以内。 */
  limit?: number;
}

export function screenSymbols(input: {
  symbols: readonly ScreenableSymbol[];
  criteria: ScreenCriteria;
  /** 模型没给 `limit` 时用几行。 */
  defaultLimit: number;
  /** 硬上限 —— 系统把关的那条线。 */
  maxLimit: number;
}): ScreenableSymbol[] {
  const c = input.criteria;

  const rows = input.symbols.filter((s) => {
    /* 涨跌幅无效的标的一律跳过 —— 混进来等于给模型一个假事实。 */
    if (!Number.isFinite(s.changePercent24h)) return false;
    if (!Number.isFinite(s.quoteVolume24h)) return false;

    if (c.minQuoteVolume24h !== undefined && s.quoteVolume24h < c.minQuoteVolume24h) return false;
    if (c.maxQuoteVolume24h !== undefined && s.quoteVolume24h > c.maxQuoteVolume24h) return false;
    if (c.minChangePercent !== undefined && s.changePercent24h < c.minChangePercent) return false;
    if (c.maxChangePercent !== undefined && s.changePercent24h > c.maxChangePercent) return false;
    if (
      c.minAmplitudePercent !== undefined &&
      (!Number.isFinite(s.amplitudePercent) || s.amplitudePercent < c.minAmplitudePercent)
    ) {
      return false;
    }
    if (c.maxAmplitudePercent !== undefined && s.amplitudePercent > c.maxAmplitudePercent) return false;
    return true;
  });

  /* 成交额降序：同样符合条件的，先给最活跃的 —— 那也是最能做得动的。 */
  rows.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);

  const wanted = c.limit !== undefined && Number.isFinite(c.limit) ? Math.floor(c.limit) : input.defaultLimit;
  const capped = Math.max(1, Math.min(wanted, input.maxLimit));
  return rows.slice(0, capped);
}
