/**
 * 挂单时限 —— 按"走到挂价需要多久"算，而不是一个固定值。
 *
 * ## 为什么固定值是个设计缺陷（2026-10-01 实测）
 *
 * 线上实例：DOGEUSDT 挂 0.095241，现价 0.095860 → 距离 **0.646%**；
 * 15m ATR ≈ **0.212%**。按随机游走，走到 `0.646 / 0.212 ≈ 3.05` 倍 ATR 的位置，
 * 预期需要 `3.05² ≈ 9.3` 根 15m K 线 = **139 分钟**。
 *
 * 而系统给的时限是 **45 分钟** —— 那张单在数学上**必然**等不到就被撤掉，
 * 模型下一轮再挂同一个价位：
 *
 *     78 张限价单被撤 / 44 张成交，最近一次成交在 20 小时前
 *
 * 「挂多远」是**模型的判断**（结构位回踩是一种合理的交易方式）。
 * 系统该做的是**给那个判断足够的时间去验证**，而不是用一刀切的时限否定它 ——
 * 那正是用户说的「系统要最大化配合模型」。
 *
 * ## 口径
 *
 * 随机游走（不是线性外推）：走到 `x` 倍 ATR 的距离，预期需要 `x²` 根 K 线。
 * 线性外推（`x` 根）在 3 倍 ATR 上会把时间低估 3 倍 —— **一个让挂单过早被撤的
 * 数字比不给更糟**，因为它看起来还算过。
 */

/** 每根 K 线的分钟数（本函数的距离/ATR 都按 15m 口径）。 */
export const BAR_MINUTES = 15;

/**
 * 时限的硬上限（8 小时）。
 *
 * 挂得极远时算出来的分钟数可以很大（10 倍 ATR → 100 根 ≈ 25 小时）。
 * 而 `maxPositions` 通常只有 3 —— 一张永不过期的单等于**永久占用一个名额**，
 * 那比"撤掉重挂"更糟。
 */
export const PENDING_TIMEOUT_MAX_MINUTES = 480;

/**
 * 安全系数：给"预期所需时间"留一点余量。
 *
 * 随机游走是**期望值**，实际达到某个价位的时间分布很散（重尾）。
 * 1.5 而不是 2：宁可略早撤、让模型重新决定，也不要让一张单占名额一整天。
 */
const SAFETY_FACTOR = 1.5;

/**
 * 算出某张挂单的时限（分钟）。
 *
 * @param baseMinutes     配置里的 `pendingEntryTimeoutMinutes`（模型可调）
 * @param distancePercent 挂价与现价的距离（绝对值，百分比）
 * @param atrPercent      15m ATR 占现价的百分比
 *
 * 规则：**取"配置值"与"预期所需时间 × 安全系数"的较大者，再封顶**。
 * 永远不缩短配置值 —— 那会让正常的近价挂单被系统提前砍掉，方向正好相反。
 */
export function pendingTimeoutMinutes(input: {
  baseMinutes: number;
  distancePercent: number;
  atrPercent: number;
}): number {
  const base = Number.isFinite(input.baseMinutes) ? input.baseMinutes : 0;
  /* `0` = 关闭这条规则（本项目同类字段的既有约定），关闭就该是关闭。 */
  if (base <= 0) return 0;

  const distance = input.distancePercent;
  const atr = input.atrPercent;
  /*
   * ⚠️ 数据不完整时**退回配置值**，不要算。
   * `atr = 0` 会让比值变成 `Infinity`，而 `Infinity` 传给定时器等于"永不过期"。
   */
  if (!Number.isFinite(distance) || !Number.isFinite(atr) || atr <= 0 || distance <= 0) {
    return base;
  }

  const inAtrs = distance / atr;
  const bars = inAtrs * inAtrs; // 随机游走：x 倍 ATR 需要 x² 根
  const needed = bars * BAR_MINUTES * SAFETY_FACTOR;

  return Math.min(PENDING_TIMEOUT_MAX_MINUTES, Math.max(base, Math.ceil(needed)));
}
