import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingTimeoutMinutes } from './pendingTimeout.js';

/* -------------------------------------------------------------------------- */
/*  挂单时限：按"走到挂价要多久"算，而不是固定 45 分钟                         */
/* -------------------------------------------------------------------------- */

test('★ 时限要跟着「挂价距离」走 —— 固定值会让挂远的单必然被撤', () => {
  /*
   * ## 这条用例是为 2026-10-01 那 78 张被撤的限价单写的
   *
   * 线上实例：DOGEUSDT 挂 0.095241，现价 0.095860 → 距离 **0.646%**；
   * 而 15m ATR ≈ 0.212%。
   *
   * 按随机游走，走到 `0.646 / 0.212 ≈ 3.05` 倍 ATR 的位置，预期需要
   * `3.05² ≈ 9.3` 根 15m K 线 = **139 分钟**。而系统给的时限是 **45 分钟**：
   *
   *     → 那张单在数学上**必然**等不到，45 分钟后被自动撤掉
   *     → 模型下一轮再挂同一个价位，循环
   *     → 实测 78 撤 / 44 成交，最近一次成交是 20 小时前
   *
   * 「挂多远」是**模型的判断**（它选了结构位回踩，那是合理的交易方式）；
   * 系统该做的是**给那个判断足够的时间去验证**，而不是用一刀切的时限否定它。
   */
  const need = pendingTimeoutMinutes({
    baseMinutes: 45,
    distancePercent: 0.646,
    atrPercent: 0.212,
  });
  assert.ok(need > 139, `应当至少覆盖预期所需的 139 分钟，实际 ${need}`);
  assert.ok(need <= 480, '但也要有上限 —— 不能让一张单永远占着持仓名额');
});

test('挂得近的单不该被无故延长 —— 近就是快', () => {
  /*
   * 距离小于 ATR 时预期只需不到一根 K 线。此时**配置值就是答案**，
   * 不该因为"能算出一个更小的数"就把时限缩到几分钟：
   * 那会让模型正常的挂单被系统提前砍掉，方向正好相反。
   */
  const need = pendingTimeoutMinutes({
    baseMinutes: 45,
    distancePercent: 0.05, // 远小于 ATR 0.212%
    atrPercent: 0.212,
  });
  assert.equal(need, 45, '小于等于基准时限时就用基准值');
});

test('数据缺失（ATR 为 0/NaN）时退回配置值，而不是算出 Infinity', () => {
  /*
   * `atrPercent = 0` 会让 `distance / atr` 变成 `Infinity`，
   * 而 `Infinity²` 再乘分钟数就是 `Infinity` —— 那个值传给定时器等于"永不过期"，
   * 一张单会永久占着持仓名额。**不知道就退回配置**，这是唯一安全的默认。
   */
  for (const atrPercent of [0, Number.NaN, -1]) {
    assert.equal(
      pendingTimeoutMinutes({ baseMinutes: 45, distancePercent: 0.6, atrPercent }),
      45,
      `atrPercent=${atrPercent} 时应退回 45`,
    );
  }
  for (const distancePercent of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      pendingTimeoutMinutes({ baseMinutes: 45, distancePercent, atrPercent: 0.2 }),
      45,
      `distancePercent=${distancePercent} 时应退回 45`,
    );
  }
});

test('时限有硬上限 —— 否则一张单会永久占着 maxPositions 的名额', () => {
  /*
   * 挂得极远时算出来的分钟数可以很大（10 倍 ATR → 100 根 ≈ 25 小时）。
   * 而 `maxPositions` 只有 3 —— 一张永不过期的单等于**永久占用一个名额**，
   * 那比"撤掉重挂"更糟。
   */
  const huge = pendingTimeoutMinutes({
    baseMinutes: 45,
    distancePercent: 20, // 20% 的距离
    atrPercent: 0.2,
  });
  assert.equal(huge, 480, '封顶 8 小时');
});

test('基准时限为 0（模型关掉这条规则）时不做任何延长', () => {
  /*
   * `pendingEntryTimeoutMinutes = 0` 在本项目是"关闭这条规则"的既有约定
   * （见 `breakevenTriggerPercent` 等同类字段）。**关闭就该是关闭**，
   * 不能因为"算出来需要更久"又把它启用回来。
   */
  assert.equal(
    pendingTimeoutMinutes({ baseMinutes: 0, distancePercent: 2, atrPercent: 0.2 }),
    0,
  );
});
