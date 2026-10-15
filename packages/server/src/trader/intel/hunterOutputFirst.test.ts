/**
 * **猎手必须先写数组，再去搜更多**（2026-10-15）
 *
 * ## 事故：41 / 277 轮撞上轮数上限，且**产出为零**
 *
 * ```
 *   含 "Reached max turns" 的轮次: 41 / 277（15%）
 *   其中【有部分产出】的:          0 / 41
 * ```
 * 线上原文（第 277 轮，`newscaster` 角色自述）：
 * ```
 *   全部四个猎手（news_hunter、flow_hunter、community_hunter、macro_hunter）
 *   均因 Reached max turns (12) 报错，未返回任何新闻条目、来源链接或发布时间
 * ```
 *
 * ## 根因与裁决官那次**完全同形**
 *
 * ```
 *   裁决官：把推理写在数组前面 → 预算用尽时从末尾砍 → 数组被砍掉
 *   猎手：  把"搜完所有来源"排在"写结论"前面 → 轮数用尽 → 什么都没写
 * ```
 * 两次都是**机器读的东西排在最后**，而截断发生在最后。
 *
 * ## 判据
 *
 * `buildHunterTask()` 产出的任务文本里，**"先输出数组"必须出现在
 * "优先看这些来源"之前**（顺序即优先级）。
 *
 * ⚠️ 只断言"提到了先写数组"不够 —— 若它写在最后，模型读到的最后一条
 * 指令仍然是"多搜来源"。所以判据是**位置**，不是**存在**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHunterTask, HUNTERS } from './hunters.js';

test('★★★ 猎手任务必须把"先写数组"排在"看来源"之前', () => {
  const task = buildHunterTask(HUNTERS[0]!, ['BTCUSDT', 'ETHUSDT']);
  const atWrite = task.indexOf('先输出 JSON 数组');
  const atSources = task.indexOf('优先看这些来源');
  assert.ok(atWrite >= 0, '★ 任务里必须写明"先输出 JSON 数组，再继续搜"');
  assert.ok(atSources >= 0, '★ 任务里应当保留来源清单');
  assert.ok(
    atWrite < atSources,
    `★ "先输出数组"必须排在"看来源"之前（顺序即优先级）——\n` +
      `   实际：写数组在 ${atWrite} 字处，来源清单在 ${atSources} 字处`,
  );
});

test('★★★ 猎手任务必须说明"轮数用尽会被截断"（给出理由，不只是命令）', () => {
  /*
   * ⚠️ 本仓库的提示词惯例：**给理由，不只是命令**。
   * 模型对"为什么"的遵从性明显高于对"必须"的遵从性（多次实测）。
   */
  const task = buildHunterTask(HUNTERS[0]!, ['BTCUSDT']);
  assert.ok(/轮数/.test(task), '★ 必须说明"搜索轮数有限"');
  assert.ok(/截断/.test(task), '★ 必须说明"用尽时会被截断"');
});

test('★★ 猎手任务不能因为这次改动而放松"不许编造"', () => {
  /*
   * ⚠️ 反向守卫：最容易犯的错是"为了让它先输出"而把"不许编造"弱化 ——
   * 那会让猎手编一条假新闻来满足"先写数组"，比零产出糟得多。
   */
  const task = buildHunterTask(HUNTERS[0]!, ['BTCUSDT']);
  assert.ok(/只写你真实查到的/.test(task), '★ "只写真实查到的"必须保留');
  assert.ok(/不要用常识或推测填充/.test(task), '★ "不许编造"必须保留');
  assert.ok(/来源链接/.test(task), '★ 必须仍然要求来源链接');
});

test('★★★ 每个猎手都要拿到这条纪律（不是只改了一个）', () => {
  for (const h of HUNTERS) {
    const task = buildHunterTask(h, ['BTCUSDT']);
    assert.ok(
      task.indexOf('先输出 JSON 数组') >= 0 &&
        task.indexOf('先输出 JSON 数组') < task.indexOf('优先看这些来源'),
      `★ 猎手 ${h.id} 的任务里"先写数组"没排在来源之前`,
    );
  }
});
