import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCycleDelayMs, FAILED_CYCLE_RETRY_MS } from './cycleSchedule.js';

/* -------------------------------------------------------------------------- */
/*  下一轮什么时候跑 —— 失败时不该等一整个周期                                  */
/* -------------------------------------------------------------------------- */

test('★ 模型调用失败后要【短间隔重试】，而不是等一整个周期', () => {
  /*
   * ## 这条用例是为用户 2026-10-01 的截图写的
   *
   * 控制台上连着两条：
   *
   *     33 分钟前 | 周期 #543 | 失败 · AI 服务不可用
   *      1 小时前 | 周期 #542 | 失败 · AI 服务不可用
   *
   * 上游是**偶发**故障（同轮内已重试 2 次、共 3 次尝试都撞上同一段窗口），
   * 而系统的行为是"失败 → 等一整个周期（默认 30 分钟）→ 下一轮"。
   * 于是**服务商抖动几分钟，代价是一小时**：用户连丢两轮，什么也没发生。
   *
   * 实测同一份日志：#1777 在 05:15 就成功了 —— 上游恢复得很快，
   * 只是没人早一点再问它一次。
   *
   * ⚠️ **这不是"退避"**（退避是"失败了就慢下来"），而是"把一次抖动的影响
   * 限制在几分钟内"。它是**只提前、不推后**：正常轮次仍按周期走。
   */
  const retry = nextCycleDelayMs({ failed: true, cycleIntervalMinutes: 30 });
  assert.equal(retry, FAILED_CYCLE_RETRY_MS);
  assert.ok(retry < 30 * 60_000, '必须比正常周期短，否则这一条就没意义');
  assert.ok(retry >= 60_000, '也不能短到疯狂空转 —— 上游不会在几秒内恢复');
});

test('正常轮次仍按配置的周期走 —— 这条改动不碰成功路径', () => {
  /*
   * 用户在周期长度上有一条明确的原则（"让模型决定用什么时间，不要系统写死"），
   * 所以这里只是**失败时的例外**，成功轮次必须原样使用 `cycleIntervalMinutes`。
   */
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 30 }), 30 * 60_000);
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 5 }), 5 * 60_000);
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 1440 }), 1440 * 60_000);
});

test('周期配置非法时退回 1 分钟下限，而不是算出 NaN/负数', () => {
  /*
   * 下游是 `setTimeout`：`NaN` 会被当成 0（**立刻重跑**，疯狂空转），
   * 负数同理。原来那行 `Math.max(1, minutes) * 60_000` 就是为这个存在的，
   * 抽出来之后这条保护不能丢。
   */
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 0 }), 60_000);
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: -5 }), 60_000);
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: Number.NaN }), 60_000);
});

test('失败重试也不比正常周期更晚 —— 短周期机器人不该被拖慢', () => {
  /*
   * 一个周期设成 2 分钟的机器人，失败后不该等 5 分钟。
   * 取两者较小的那个：**"提前"永远不该变成"推后"**。
   */
  assert.equal(nextCycleDelayMs({ failed: true, cycleIntervalMinutes: 2 }), 2 * 60_000);
  assert.equal(nextCycleDelayMs({ failed: true, cycleIntervalMinutes: 30 }), FAILED_CYCLE_RETRY_MS);
});
