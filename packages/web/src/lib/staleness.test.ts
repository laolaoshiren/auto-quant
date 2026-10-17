/**
 * 「状态停更 N 秒」这句话什么时候出现（2026-10-17 · 台账 FRD-01）。
 *
 * 三条边界都值得钉住，因为它们各自对应一种**错误的话**：
 * ```
 *   从没成功过   → 说"停更 0 秒"是编的（首屏本来就在加载）
 *   刚好在阈值上 → 阈值是"3 × 轮询间隔"，取不取等号决定了抖动时会不会闪红
 *   早过期       → 必须把"N 秒"和"最后成功 HH:MM:SS"一起给出来，
 *                  只说"停更"而不说多久，操作员无法判断该不该现在动手
 * ```
 * 期望值全部**写死在用例里**（不从 `STALE_POLL_MULTIPLIER` 派生）——
 * 从被测对象自身派生期望值，会让"声明与实现一起错"仍然全绿。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { STALE_POLL_MULTIPLIER, staleness } from './staleness';

const NOW = Date.parse('2026-10-17T08:00:00+08:00'); // 本地时区 08:00:00

test('★ 从没成功过时不判"停更"，但读取失败要说出来', () => {
  const idle = staleness(null, null, 10_000, NOW);
  assert.deepEqual(idle, { seconds: null, stale: false, failed: false, label: null });

  const failed = staleness(null, '连接被拒绝', 10_000, NOW);
  assert.equal(failed.stale, false, '从没成功过不是"停更"');
  assert.equal(failed.label, '状态读取失败：连接被拒绝', '失败本身仍要说');
});

test('★ 阈值内不吭声（一次抖动不该让状态栏变红）', () => {
  const fresh = staleness(NOW - 2_000, null, 10_000, NOW);
  assert.equal(fresh.seconds, 2);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.label, null);

  /* 推送断开时轮询是 4 秒 → 阈值 12 秒；11 秒仍在阈值内。 */
  const justInside = staleness(NOW - 11_000, '读取超时', 4_000, NOW);
  assert.equal(justInside.stale, false, '阈值内不报停更（虽然这一次失败了）');
  assert.equal(justInside.failed, true, '但"这一次失败"这个事实要带出去');
  assert.equal(justInside.label, null, '阈值内先不打扰');
});

test('★ 超过 3 × 轮询间隔 → 给出"N 秒 + 最后成功时刻"', () => {
  const stale = staleness(NOW - 31_000, '读取超时', 10_000, NOW);
  assert.equal(stale.stale, true);
  assert.equal(stale.seconds, 31);
  assert.equal(stale.label, '状态停更 31 秒 · 最后成功 07:59:29');
});

test('★ 阈值就是 3 倍（改这个倍数必须改本用例）', () => {
  assert.equal(STALE_POLL_MULTIPLIER, 3);
  /* 4 秒轮询、12 秒整：边界上（不取等号）仍算阈值内。 */
  assert.equal(staleness(NOW - 12_000, null, 4_000, NOW).stale, false, '恰好 3 倍不算停更');
  assert.equal(staleness(NOW - 12_001, 'x', 4_000, NOW).stale, true, '超过 3 倍才算');
});

test('★ 时钟倒流（负数秒）不产生负读数', () => {
  const future = staleness(NOW + 5_000, null, 10_000, NOW);
  assert.equal(future.seconds, 0, '本地时钟回拨时显示 0 秒，不显示 -5 秒');
  assert.equal(future.stale, false);
});
