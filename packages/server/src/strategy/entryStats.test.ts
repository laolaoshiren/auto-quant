import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryFillStats } from './entryStats.js';

/* -------------------------------------------------------------------------- */
/*  挂单成交率：模型看不到的那个反馈                                            */
/* -------------------------------------------------------------------------- */

test('★ 挂单成交率 —— 模型每轮挂"回踩位"，但它不知道自己 64% 的挂单从没成交', () => {
  /*
   * ## 为什么要算这个（用户 2026-10-01 的观察）
   *
   * 用户的原话：「为什么每次开单都是限价单…而且经常挂了都无法成交，
   * 因为看不了取消记录，我估计都是挂了又取消根本没成交，怎么奇奇怪怪的感觉，
   * 好像在浪费时间和 token，浪费服务器资源」。
   *
   * 拉出真实数据，**他的估计是对的**：
   *
   *     入场单：LIMIT CANCELED 78 / LIMIT FILLED 44  → 撤单率 64%
   *             MARKET FILLED 19                     → 市价单 100% 成交
   *
   * 系统**已经告诉过它**"挂满 45 分钟会自动撤"（提示词里有），但它从没看到
   * **"我过去挂的单六成都没成交"** 这个统计 —— 而那是它调整挂单方式的唯一依据。
   * 于是它每轮都在重复"挂回踩位 → 超时撤掉 → 下一轮再挂"。
   *
   * 这个函数只给**事实**：成交率、撤单平均等了多久。
   * 要不要改挂法（挂近一点 / 用市价 / 干脆不挂）仍然是它的判断。
   */
  const stats = entryFillStats([
    ...Array.from({ length: 78 }, () => ({ type: 'LIMIT', status: 'CANCELED', waitMinutes: 45 })),
    ...Array.from({ length: 44 }, () => ({ type: 'LIMIT', status: 'FILLED', waitMinutes: 30 })),
    ...Array.from({ length: 19 }, () => ({ type: 'MARKET', status: 'FILLED', waitMinutes: 0 })),
  ]);

  assert.equal(stats.limitCanceled, 78);
  assert.equal(stats.limitFilled, 44);
  assert.ok(
    stats.fillRatePercent !== null && Math.abs(stats.fillRatePercent - 36.07) < 0.1,
    `成交率应为 44/122 ≈ 36%，实际 ${stats.fillRatePercent}`,
  );
  assert.equal(stats.avgCanceledWaitMinutes, 45, '撤单平均等了多久 —— 判断"是不是差一点就成交"');
});

test('市价单不计入成交率 —— 它必然成交，混进来会把比例抬高', () => {
  /*
   * 市价单没有"挂不挂得上"这个问题。把它算进去，成交率会被人为抬高，
   * 而那个数字正是模型判断"我的挂法有没有问题"的依据 —— 虚高就等于骗它。
   */
  const stats = entryFillStats([
    { type: 'LIMIT', status: 'CANCELED', waitMinutes: 45 },
    { type: 'MARKET', status: 'FILLED', waitMinutes: 0 },
    { type: 'MARKET', status: 'FILLED', waitMinutes: 0 },
  ]);
  assert.equal(stats.fillRatePercent, 0, '唯一的限价单被撤了 → 成交率 0%');
  assert.equal(stats.marketFilled, 2, '市价单另算，不能丢');
});

test('没有任何限价单样本时返回 null —— 不编一个"0%"', () => {
  /*
   * 0% 和"没有样本"是两件事：前者说"你全挂了"，后者说"你还没挂过"。
   * 把后者显示成 0% 会让模型以为自己一直在失败。
   */
  const stats = entryFillStats([{ type: 'MARKET', status: 'FILLED', waitMinutes: 0 }]);
  assert.equal(stats.fillRatePercent, null);
  assert.equal(stats.avgCanceledWaitMinutes, null, '没有撤单样本时同样是 null');
  assert.equal(stats.marketFilled, 1);
});

test('还在挂着的（NEW）既不算成交也不算撤单', () => {
  const stats = entryFillStats([
    { type: 'LIMIT', status: 'NEW', waitMinutes: 10 },
    { type: 'LIMIT', status: 'FILLED', waitMinutes: 5 },
  ]);
  assert.equal(stats.fillRatePercent, 100, '只统计有结论的那些');
  assert.equal(stats.limitFilled, 1);
  assert.equal(stats.limitCanceled, 0);
});

test('被拒的限价单不计入分母 —— 那是"没挂上"，不是"没成交"', () => {
  const stats = entryFillStats([
    { type: 'LIMIT', status: 'REJECTED', waitMinutes: 0 },
    { type: 'LIMIT', status: 'FILLED', waitMinutes: 5 },
  ]);
  assert.equal(stats.fillRatePercent, 100);
  assert.equal(stats.limitRejected, 1);
});
