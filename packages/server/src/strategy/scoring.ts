/**
 * 候选评分：**在花 token 之前先决定"谁值得看"**。
 *
 * ## 为什么需要它
 *
 * 监控期实测：单次决策 **58,266 tokens、48 秒延迟、每小时 270 万 tokens**，
 * 而那个策略**扣费前毛盈亏 ≈ 0**。
 *
 * 我原来的假设是"给模型更多数据 = 更好的判断"。**实测没有支持这个假设。**
 * 更省的解释是：**信号淹没在 5.8 万 token 里本身就会让判断变差**，不只是变贵。
 *
 * 所以改成两段式：
 *
 *     选币（池子里有谁） → **评分（这一轮谁值得看）** → 提示词 → 模型
 *
 * **它与选币不是一回事，也不该合并**：选币按成交量/波动率筛出可交易的标的，
 * 评分判断**当下这个时点哪个方向值得下手**。同一个标的在不同时刻分数不同。
 *
 * ## 设计上的一个要点：有减分项
 *
 * 四个分量里 **`volatilityPenalty` 是减分**。这比加分项更重要 ——
 * 它把"**什么样的行情不该做**"写成了可检验的规则，而不是留给模型在一堆指标里
 * 自己权衡。
 *
 * ## 为什么是纯函数
 *
 * 没有数据库、没有网络、没有时钟（§5.4）。这样它能被穷举测试 ——
 * 尤其是**每个分量各自的边界**：趋势向下时趋势分该为负、波动过大时惩罚要生效、
 * 分数必须钳在 0–100。
 *
 * ⚠️ **测试里不要用真实 K 线做断言。** 那会变成一个"市场数据依赖"的假测试 ——
 * 本会话已经踩过一次（`npm run sim` 的止盈校验回放真实 K 线，时过时不过）。
 * 用构造出来的 K 线，断言的是**规则**，不是市场的脸色。
 */

import type { Kline } from '@aq/shared';

import { atr, ema, last } from '../market/indicators.js';

/* -------------------------------------------------------------------------- */
/*  权重                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 各分量的权重。**总和不必是 100** —— 最后会钳到 0–100。
 *
 * 数值取"趋势与量能占大头、整理是中性的加分、波动是减分"这个相对关系，
 * 而不是精确的最优解。**最优解要靠 A/B 测出来**（见 `PROPOSAL-scoring-gate.md` 第 4 节）。
 *
 * ⚠️ **这四项目前是硬编码的，AI 调不到它们。**
 *
 * 这里原来写着"这些权重在 AI 托管模式下是 AI 可以调的参数"—— **那句话是假的**：
 * `SCORE_WEIGHTS` 只在 `scoring.ts` 内部被用到，从来没有进过 `StrategyConfig`，
 * 而 AI 的 `set_params` 只能改配置里有的字段。它**顶多能调门槛值 `minScore`**。
 *
 * 把权重暴露出去是另一件事（要进 schema、要过守卫、要重算 `estimateCandidateChars`
 * 的预算），在没做之前，注释不该说它已经能调 —— **一条描述不存在行为的注释，
 * 会让下一个读它的人以为自己错了**（这个仓库里已经出现过三次同类问题）。
 */
export const SCORE_WEIGHTS = {
  trend: 40,
  breakoutVolume: 35,
  consolidation: 15,
  volatilityPenalty: 30,
} as const;

/** 判定"整理"时用的窗口长度（15m 根数）。 */
const CONSOLIDATION_WINDOW = 10;
/** 判定"放量"时，当前量相对均量的倍数门槛。 */
const VOLUME_SURGE_MULTIPLE = 1.5;

/* -------------------------------------------------------------------------- */
/*  分量                                                                       */
/* -------------------------------------------------------------------------- */

/** 取收盘价序列。 */
const closes = (klines: readonly Kline[]): number[] => klines.map((k) => k.close);

/**
 * 趋势分：**大周期（4h）的方向与强度**。
 *
 * 用 EMA 的斜率而不是"价格在均线之上"：后者在均线附近会来回翻，
 * 而斜率要求方向**已经持续了一段**。
 *
 * 返回 **−1 到 +1**：向上为正、向下为负。**允许负分是刻意的** ——
 * "下行趋势"是一个有价值的信息，压缩成 0 会把它和"没有趋势"混为一谈。
 */
function trendScore(klines4h: readonly Kline[]): number {
  if (klines4h.length < 30) return 0;
  const line = ema(closes(klines4h), 21);
  const now = last(line);
  const prev = line.length >= 6 ? (line[line.length - 6] ?? null) : null;
  if (now === null || prev === null || prev === 0) return 0;

  const slope = (now - prev) / Math.abs(prev);
  // 斜率 0.5% 以上算"有方向"；再往上递增到满分的 1.5%。
  const magnitude = Math.min(1, Math.abs(slope) / 0.015);
  return Math.sign(slope) * magnitude;
}

/**
 * 突破量能分：**当前是否是一次带量的突破**。
 *
 * 两根条件同时成立才给分：**价格创近端新高/新低** 且 **成交量显著放大**。
 * 只有价格没有量的突破，在合约里更容易是插针。
 *
 * 返回 **0 到 1**（不给负分：没突破就是没突破，不是坏消息）。
 */
function breakoutVolumeScore(klines: readonly Kline[]): number {
  if (klines.length < 25) return 0;
  const window = klines.slice(-20);
  const current = klines[klines.length - 1];
  if (!current) return 0;

  const priorHigh = Math.max(...window.slice(0, -1).map((k) => k.high));
  const priorLow = Math.min(...window.slice(0, -1).map((k) => k.low));
  const brokeUp = current.close > priorHigh;
  const brokeDown = current.close < priorLow;
  if (!brokeUp && !brokeDown) return 0;

  const avgVolume = window.slice(0, -1).reduce((s, k) => s + k.volume, 0) / (window.length - 1);
  if (avgVolume <= 0) return 0;
  const ratio = current.volume / avgVolume;
  if (ratio < VOLUME_SURGE_MULTIPLE) return 0;

  // 量能 1.5 倍起步，3 倍封顶。
  const volumePart = Math.min(1, (ratio - VOLUME_SURGE_MULTIPLE) / (3 - VOLUME_SURGE_MULTIPLE));
  return 0.5 + 0.5 * volumePart;
}

/**
 * 整理分：**是否在窄幅蓄势**。
 *
 * 横盘整理本身不是入场理由，但它是"**突破可能快来了**"的前置条件，
 * 所以给一个较低权重的加分。
 *
 * 返回 **0 到 1**。
 */
function consolidationScore(klines: readonly Kline[]): number {
  if (klines.length < CONSOLIDATION_WINDOW + 1) return 0;
  const window = klines.slice(-CONSOLIDATION_WINDOW);
  const avg = window.reduce((s, k) => s + k.close, 0) / window.length;
  if (avg <= 0) return 0;

  // 平均实体占价格的比例 —— 越小越"安静"。
  const bodies = window.map((k) => Math.abs(k.close - k.open) / k.close);
  const meanBody = bodies.reduce((s, b) => s + b, 0) / bodies.length;

  // 实体 ≤0.15% 算很安静（满分），≥0.6% 算很吵（0 分）。
  if (meanBody <= 0.0015) return 1;
  if (meanBody >= 0.006) return 0;
  return 1 - (meanBody - 0.0015) / (0.006 - 0.0015);
}

/**
 * 波动惩罚：**波动过大时扣分**。
 *
 * 这是四个分量里唯一的**减分项**，也是最重要的一项：它把"什么样的行情不该做"
 * 写成了规则。ATR 相对价格的占比过高意味着**止损会被正常噪声打掉** ——
 * 而本系统实测的亏损里，手续费与"被噪声扫掉"占了大头。
 *
 * 返回 **0 到 1**（1 表示扣满）。
 */
function volatilityPenalty(klines: readonly Kline[]): number {
  if (klines.length < 20) return 0;
  const atr14 = last(atr([...klines], 14));
  const current = klines[klines.length - 1];
  if (atr14 === null || !current || current.close <= 0) return 0;

  const atrPercent = atr14 / current.close;
  // ≤0.3% 不罚；≥1.2% 扣满。合约 15m 上这大致对应"温和"与"剧烈"。
  if (atrPercent <= 0.003) return 0;
  if (atrPercent >= 0.012) return 1;
  return (atrPercent - 0.003) / (0.012 - 0.003);
}

/* -------------------------------------------------------------------------- */
/*  总分                                                                       */
/* -------------------------------------------------------------------------- */

export interface SymbolScore {
  /** 0–100，已钳位。 */
  total: number;
  /** 各分量，便于解释"这个分是怎么来的"。**调参时要看的就是它。** */
  parts: {
    trend: number;
    breakoutVolume: number;
    consolidation: number;
    volatilityPenalty: number;
  };
}

/**
 * 给一个标的打分。
 *
 * @param klines15m 小周期 K 线（**升序**，最后一根是当前）。主导择时。
 * @param klines4h  大周期 K 线（**升序**）。主导方向。
 *
 * 两个周期都要：**只看小周期会被日内噪声带走，只看大周期会错过入场点。**
 */
export function scoreSymbol(klines15m: readonly Kline[], klines4h: readonly Kline[]): SymbolScore {
  const trend = trendScore(klines4h);
  const breakoutVolume = breakoutVolumeScore(klines15m);
  const consolidation = consolidationScore(klines15m);
  const penalty = volatilityPenalty(klines15m);

  /*
   * ⚠️ **总分里取趋势的绝对值 —— 方向不是质量。**
   *
   * `trendScore` 返回**有符号**的方向，那个符号是有价值的信息，所以
   * `parts.trend` 原样保留它（`scoring.test.ts` 有一条用例专门钉住"下行给负分"）。
   *
   * **但把它直接加权进总分是错的。** 总分回答的问题是
   * "**这个标的值不值得放进提示词**"，而"4h 明确向下"与"4h 明确向上"一样是
   * **可交易的结构**（一个做多、一个做空）—— 它不是"质量差"。
   *
   * 实测伤害（交付记录里的原文）：
   *
   *     | BTC（4H 偏空）  | 负 × 40 → 钳到 0 | **被滤掉**
   *     | ZEC（24h +17%） | 满分 → +40       | **入选**
   *
   * 用两条对称的测试行情量一下（同一段 15m，只把 4h 换成上行 / 下行）：
   *
   *     trend 分量：上行 +0.319、下行 −0.349
   *     按**有符号**加权：总分差 **26.72 分**   ← 修前
   *     按**绝对值**加权：总分差 **1.18 分**    ← 修后
   *
   * 26.72 分在 0–100 的评分里足以把一个"可以做空"的标的整段滤掉。修后剩下的
   * 1.18 分来自 `trendScore` 里 `slope = (now - prev) / |prev|` 的分母：上行的
   * `prev` 大、下行的 `prev` 小，同样的绝对变化在下行那边算出略大的比率 ——
   * 那是斜率定义的固有性质，不是方向偏见。
   *
   * 这也和 `breakoutVolumeScore` 从一开始就是双向的（`brokeUp || brokeDown`）
   * 是同一条道理 —— 现在两者一致了。
   *
   * 影响面：门槛（`coinSource.minScore`）默认是 **0（关闭）**，所以这个修正
   * **不改变当前行为**；它改变的是"门槛可以被安全打开"这件事。
   */
  const raw =
    Math.abs(trend) * SCORE_WEIGHTS.trend +
    breakoutVolume * SCORE_WEIGHTS.breakoutVolume +
    consolidation * SCORE_WEIGHTS.consolidation -
    penalty * SCORE_WEIGHTS.volatilityPenalty;

  return {
    total: Math.round(Math.max(0, Math.min(100, raw)) * 100) / 100,
    // ⚠️ `trend` 在这里**保持原符号** —— 它是方向信息，不是质量分。
    parts: { trend, breakoutVolume, consolidation, volatilityPenalty: penalty },
  };
}
