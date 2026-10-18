/**
 * **Jev 实验的判据计算器**（2026-10-18）。
 *
 * ## 它回答的唯一问题
 *
 * > **Jev 保留的标的，是不是真的比它筛掉的更值得交易？**
 *
 * 这是"保留还是移除"这个决定的**唯一硬证据**。
 *
 * ## 为什么需要专门写一个
 *
 * 直觉上有三个陷阱，都会得出错误结论：
 *
 * | 陷阱 | 为什么错 |
 * |---|---|
 * | "筛掉的标的在跌 ⇒ Jev 对" | 团队可能本来就**只做多强势**，弱势币不进候选也一样不碰 |
 * | "保留的赚了 ⇒ Jev 对" | 一笔止盈可能只是运气，样本 1 不行 |
 * | "耗时降了 ⇒ Jev 好" | 省时间是好事，但**如果省时间的同时挑错了标的，那叫漏钱** |
 *
 * ⇒ 正确判据是**同口径对照**：在**同一个时间窗**里，
 *   「被保留标的」与「被筛除标的」各自的实际结果。
 *
 * ## 但"实际结果"拿不到（没开的仓没有结果）
 *
 * 所以我们用**市场自己的结果**做代理：
 *   `24h 涨跌幅` / `ATR 是否在可执行区间` —— 那是"如果做了会怎样"的最接近近似。
 *
 * 结论口径：
 * ```
 *   保留组的平均 |24h涨幅| 明显高于筛除组   ⇒ Jev 在挑"更有波动的"⇒ 正向
 *   筛除组的平均 |24h涨幅| 明显更高         ⇒ Jev 在丢掉机会      ⇒ 负向
 *   两组接近                                 ⇒ Jev 没提供信息     ⇒ 无价值
 * ```
 */

/** 一次 Jev 判定的结果（从日志里解析出来的）。 */
export interface JevDecisionRecord {
  at: number;
  total: number;
  kept: number;
  highest: number | null;
  lowest: number | null;
  elapsedMs: number;
  /** 被筛除的标的与分数。 */
  dropped: Array<{ symbol: string; score: number }>;
  /** 被保留的标的与分数（从 `筛除` 的反面推不出来，所以由调用方单独提供）。 */
  keptSymbols: string[];
}

/** 一个标的在某个时间窗的市场表现。 */
export interface SymbolOutcome {
  symbol: string;
  /** 24 小时涨跌幅（百分数，正=涨）。 */
  change24hPercent: number;
  /** ATR 占价格的百分比（波动率代理）。 */
  atrPercent: number | null;
}

export interface Verdict {
  /** 有市场数据的保留标的数。 */
  keptCount: number;
  /** 有市场数据的筛除标的数。 */
  droppedCount: number;
  /** 保留组的平均 |24h 涨跌幅|。 */
  keptAvgAbsChange: number | null;
  /** 筛除组的平均 |24h 涨跌幅|。 */
  droppedAvgAbsChange: number | null;
  /**
   * 判据结论：
   * ```
   *   'positive'  → 保留组明显更有波动（Jev 在挑对的）
   *   'negative'  → 筛除组明显更有波动（Jev 在丢机会）
   *   'neutral'   → 两组接近（Jev 没提供信息）
   *   'insufficient' → 样本不足以下结论
   * ```
   */
  outcome: 'positive' | 'negative' | 'neutral' | 'insufficient';
  /** 人话解释（给台账用）。 */
  reason: string;
}

/**
 * 计算判据。
 *
 * ## 阈值为什么是 1.5 倍
 *
 * 两组 |涨跌幅| 中位数相差不到 1.5 倍时，那点差别完全可能来自"当天行情随机分布"。
 * 1.5 倍是个**保守**的门槛：宁可说"没价值"，也不要因为噪音把实验功能留下。
 *
 * ## 为什么用 |涨幅| 而不是净收益
 *
 * 因为团队**双向都能做**（`open_long` / `open_short`）。
 * 一个跌 3% 的标的对做空是机会、对做多是陷阱 —— 而 Jev 的任务是
 * "挑出**有波动**的标的给 LLM 深看"，方向由 LLM 判断。
 * ⇒ 用波动幅度作代理是对的；用涨跌方向会算出错误结论。
 */
export function computeVerdict(
  inputs: {
    keptSymbols: readonly string[];
    dropped: ReadonlyArray<{ symbol: string; score: number }>;
    outcomes: ReadonlyMap<string, SymbolOutcome>;
  },
  options: { ratioThreshold?: number; minSamples?: number } = {},
): Verdict {
  const ratioThreshold = options.ratioThreshold ?? 1.5;
  const minSamples = options.minSamples ?? 3;

  const keptOut = inputs.keptSymbols
    .map((s) => inputs.outcomes.get(s))
    .filter((x): x is SymbolOutcome => x !== undefined);
  const droppedOut = inputs.dropped
    .map((d) => inputs.outcomes.get(d.symbol))
    .filter((x): x is SymbolOutcome => x !== undefined);

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **用中位数，不用平均值**（2026-10-18 · 被一次实测打脸后改）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 第一版用平均值，而线上真实数据里有一个 +92.66% 的标的（QUSDT）——
   * 它一个人就把保留组的平均从 10.94% 拉到 24.56%，于是：
   *
   * ```
   *   平均值（含极值）：保留 24.56% vs 筛除 12.65% ⇒ 1.94 倍 ⇒ positive
   *   剔除那个极值    ：保留 10.94% vs 筛除 12.65% ⇒ 0.86 倍 ⇒ NEGATIVE
   *   中位数          ：保留  8.24% vs 筛除  7.81% ⇒ 1.06 倍 ⇒ neutral
   * ```
   *
   * **三个算法三个结论**，而真相是中位数那个（两组几乎相同）。
   * 加密行情里单日翻倍的标的很常见 ⇒ **平均值在这个场景下是不可用的统计量**。
   *
   * ⇒ 改用中位数：它对极值天然免疫，且"典型标的的波动"正是我们要比的东西。
   */
  const medianAbs = (rows: readonly SymbolOutcome[]): number | null => {
    if (rows.length === 0) return null;
    const values = rows.map((r) => Math.abs(r.change24hPercent)).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    /* 偶数个取中间两个的均值（标准中位数定义）。 */
    return values.length % 2 === 1
      ? values[mid]!
      : (values[mid - 1]! + values[mid]!) / 2;
  };

  const keptAvg = medianAbs(keptOut);
  const droppedAvg = medianAbs(droppedOut);

  /*
   * 样本不足：两组都至少要有 `minSamples` 个带数据的标的。
   * 用 minSamples 而不是"大于 0" —— 2 个标的的平均值什么都说明不了。
   */
  if (keptOut.length < minSamples || droppedOut.length < minSamples) {
    return {
      keptCount: keptOut.length,
      droppedCount: droppedOut.length,
      keptAvgAbsChange: keptAvg,
      droppedAvgAbsChange: droppedAvg,
      outcome: 'insufficient',
      reason:
        `样本不足（保留组 ${keptOut.length} 个、筛除组 ${droppedOut.length} 个，` +
        `各需至少 ${minSamples} 个）—— 继续观察，不要下结论。`,
    };
  }

  /* 两组都平稳（都很小）时，比值的分母接近 0，比值不可靠 ⇒ 用绝对差。 */
  const EPSILON = 0.05; /* 0.05% —— 小于这个的涨跌幅等于没动 */
  const droppedIsZeroish = (droppedAvg ?? 0) < EPSILON;
  const keptIsZeroish = (keptAvg ?? 0) < EPSILON;

  if (droppedIsZeroish && keptIsZeroish) {
    return {
      keptCount: keptOut.length,
      droppedCount: droppedOut.length,
      keptAvgAbsChange: keptAvg,
      droppedAvgAbsChange: droppedAvg,
      outcome: 'neutral',
      reason: '两组都几乎没有波动（|24h 涨跌| 中位数 都 < 0.05%）—— 这段行情本身没有可比较的信息。',
    };
  }

  const ratio = droppedIsZeroish ? Number.POSITIVE_INFINITY : (keptAvg ?? 0) / (droppedAvg ?? 0);

  if (ratio >= ratioThreshold) {
    return {
      keptCount: keptOut.length,
      droppedCount: droppedOut.length,
      keptAvgAbsChange: keptAvg,
      droppedAvgAbsChange: droppedAvg,
      outcome: 'positive',
      reason:
        `保留组波动中位数 ${keptAvg!.toFixed(2)}%，筛除组 ${droppedAvg!.toFixed(2)}% —— ` +
        `保留组是筛除组的 ${ratio === Number.POSITIVE_INFINITY ? '∞' : ratio.toFixed(2)} 倍` +
        `（阈值 ${ratioThreshold} 倍）⇒ Jev 确实在挑更有机会的标的。`,
    };
  }

  if (!keptIsZeroish && ratio <= 1 / ratioThreshold) {
    return {
      keptCount: keptOut.length,
      droppedCount: droppedOut.length,
      keptAvgAbsChange: keptAvg,
      droppedAvgAbsChange: droppedAvg,
      outcome: 'negative',
      reason:
        `筛除组波动中位数 ${droppedAvg!.toFixed(2)}% 反而高于保留组 ${keptAvg!.toFixed(2)}% —— ` +
        `Jev 在丢掉更有机会的标的 ⇒ **建议移除**。`,
    };
  }

  return {
    keptCount: keptOut.length,
    droppedCount: droppedOut.length,
    keptAvgAbsChange: keptAvg,
    droppedAvgAbsChange: droppedAvg,
    outcome: 'neutral',
    reason:
      `两组波动接近（保留 ${keptAvg!.toFixed(2)}% vs 筛除 ${droppedAvg!.toFixed(2)}%，` +
      `比值 ${ratio.toFixed(2)} 未达 ${ratioThreshold} 倍）⇒ Jev 没有提供有效区分信息。`,
  };
}
