import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageRoundTripCostPercent } from './costs.js';

/* -------------------------------------------------------------------------- */
/*  往返成本：模型决定"止损该放哪"时必须知道的数字                              */
/* -------------------------------------------------------------------------- */

test('★ 往返成本率 = 手续费 ÷ 名义价值（用真实成交反推）', () => {
  /*
   * ## 这个函数为什么存在（2026-09-30 的真实事故）
   *
   * 模型自己写了条「保本/锁盈上移」规则（5.1/5.2），判据是**价格浮盈的百分比**。
   * 它把 ZECUSDT 空头的止损从结构位 1427.5 上移到 **1412.32** —— 相对入场价 1413
   * 只锁住 **0.048%** 的价格浮盈。
   *
   * 而那笔的往返成本是 **0.070%**（手续费 0.0148 ÷ 名义 21.20）。
   * 于是止损被扫掉时：毛 +0.0042、手续费 0.0148 → **净 -0.0106**。
   * **数学上必然亏**：锁住的浮盈比摩擦成本还小。
   *
   * 最刺眼的是模型**自己的复盘两次**都写下了正确结论
   * （「保本止损必须设在覆盖往返成本之上」），但决策那一刻它手里
   * **没有这个数字** —— 只能靠它想起来。
   *
   * 所以系统把**事实**给它（不是规则、不是结论）：从它自己的历史成交反推的实测均值。
   */
  const pct = averageRoundTripCostPercent([
    { entryPrice: 1413, quantity: 0.015, fee: 0.0148 }, // 名义 21.195 → 0.0698%
    { entryPrice: 85.961, quantity: 0.24, fee: 0.0206 }, // 名义 20.63  → 0.0999%
  ]);
  assert.ok(pct !== null);
  /* 两笔平均 ≈ 0.0849% */
  assert.ok(Math.abs(pct - 0.0849) < 0.005, `实际算出 ${pct}`);
});

test('名义价值为零或负的样本必须被丢掉 —— 否则会算出 Infinity 污染均值', () => {
  /*
   * `entryPrice = 0` 或 `quantity = 0` 在真实数据里会出现（脏行、测试夹具、
   * 以及"还没成交"的回合）。让它们进均值会得到 `Infinity` 或 `NaN`，
   * 而**一个 NaN 会被渲染成"往返成本 ≈NaN%"，看起来像数据又像乱码**。
   */
  const pct = averageRoundTripCostPercent([
    { entryPrice: 0, quantity: 1, fee: 0.01 },
    { entryPrice: 100, quantity: 0, fee: 0.01 },
    { entryPrice: 100, quantity: 1, fee: 0.1 }, // 唯一有效：0.1%
  ]);
  assert.equal(pct, 0.1, '只有一条有效样本时结果就是它');
});

test('样本不足时返回 null —— 不猜，也不编一个默认值', () => {
  /*
   * 没有成交时无法反推成本。返回 `null` 让调用方**不渲染这一行** ——
   * 比编一个"行业标准 0.1%"要好：那是**别处**的成本，不是这个账户的。
   */
  assert.equal(averageRoundTripCostPercent([]), null);
  assert.equal(
    averageRoundTripCostPercent([{ entryPrice: 100, quantity: 0, fee: 1 }]),
    null,
    '全部样本都无效时同样是 null',
  );
});

test('只取最近 limit 笔 —— 费率会随 maker/taker 与活动变化', () => {
  /*
   * 挂单成交（maker）与吃单成交（taker）的费率差一倍（实测 0.070% vs 0.100%）。
   * 用全部历史会让很久以前的费率主导当前判断，所以按"最近 N 笔"算。
   *
   * ⚠️ **约定：样本数组是"新的在前"**（调用方 `tradeStore.list()` 按 `id DESC` 返回）。
   * 这条用例第一版把最新的放在数组**末尾**，于是断言失败 —— 实现是对的，测试构造错了。
   */
  const old = Array.from({ length: 50 }, () => ({ entryPrice: 100, quantity: 1, fee: 0.5 })); // 0.5%
  const recent = { entryPrice: 100, quantity: 1, fee: 0.07 }; // 0.07%
  const pct = averageRoundTripCostPercent([recent, ...old], 1);
  assert.equal(pct, 0.07, 'limit=1 时只应看最近那一笔');
});

test('无效的 limit（0 / 负数 / NaN）退回默认值，而不是返回 null', () => {
  const samples = [{ entryPrice: 100, quantity: 1, fee: 0.07 }];
  assert.equal(averageRoundTripCostPercent(samples, 0), 0.07);
  assert.equal(averageRoundTripCostPercent(samples, -5), 0.07);
  assert.equal(averageRoundTripCostPercent(samples, Number.NaN), 0.07);
});
