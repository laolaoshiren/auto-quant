/**
 * **猎手必须把 JSON 数组放在【最后一条消息】**（2026-10-17 改写）
 *
 * ## 这份测试原来守的是相反的东西（必须先说清为什么改）
 *
 * 它原来断言「"先输出数组"必须排在"看来源"之前」，理由是：
 * ```
 *   裁决官：把推理写在数组前面 → 预算用尽时从末尾砍 → 数组被砍掉
 *   猎手：  把"搜完所有来源"排在"写结论"前面 → 轮数用尽 → 什么都没写
 * ```
 * 那条类比**看着成立，实际不成立** —— 因为两者的截断机制不同：
 * ```
 *   裁决官：预算从【末尾】砍 ⇒ 先写的能活下来
 *   猎手：  claude --print 只输出【最后一条】assistant 消息
 *           ⇒ 先写的数组会被后续工具调用覆盖，永远到不了 stdout
 * ```
 *
 * ## 实测证据（2026-10-17，服务器侧同一台机器）
 *
 * 让模型「第一步写 [{"summary":"FIRST"}]，搜 2 次，最后写 [{"summary":"LAST"}]」：
 * ```
 *   --print（默认）              → 只吐 [{"summary":"LAST"}]
 *   会话 JSONL                   → assistant.text#1 = FIRST、#2 = LAST（两条都在）
 *   --output-format stream-json  → 两条都能拿到
 * ```
 *
 * 线上复现（20 个标的 = 线上候选池规模）：
 * ```
 *   旧措辞（数组在前）+ turns=24 → tool_use 48 次 → Reached max turns → stdout 29 字节
 *   新措辞（数组最后+写完就停）  → 3 次里 2 次拿到 4 条 / 10 条情报
 * ```
 *
 * ## 现在的判据（三条，对应"零产出"的三个成因）
 *
 * ① 数组要求必须在**来源清单之后**（"最后一条消息"）；
 * ② 必须写明**写完就停**（再调工具会覆盖交付）；
 * ③ 必须有**硬性的搜索次数上限**（只说"轮数有限"它仍会一直搜）。
 *
 * ⚠️ 并且必须**按主题搜**（20 个标的逐个搜必然用光预算）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHunterTask, HUNTERS } from './hunters.js';

test('★★★ 输出格式必须排在【来源清单之后】—— 数组是最后一条消息', () => {
  const task = buildHunterTask(HUNTERS[0]!, ['BTCUSDT', 'ETHUSDT']);
  const atFormat = task.indexOf('## 输出格式');
  const atSources = task.indexOf('优先看这些来源');
  assert.ok(atFormat >= 0, '★ 任务里必须有输出格式段');
  assert.ok(atSources >= 0, '★ 任务里应当保留来源清单');
  assert.ok(
    atFormat > atSources,
    `★ 输出格式必须排在来源清单**之后**（--print 只吐最后一条）——\n` +
      `   实际：来源在 ${atSources} 字处，输出格式在 ${atFormat} 字处`,
  );
});

test('★★★ 必须写明"写完数组就停，不要再调工具"', () => {
  /*
   * ⚠️ 这是本次修法的**核心机制**：多调一次工具就覆盖掉交付。
   * 只写"数组在最后"不够 —— 模型很可能"写完数组再补搜一次"，
   * 而那一补搜会让数组不再是最后一条。
   */
  const task = buildHunterTask(HUNTERS[0]!, ['BTCUSDT']);
  assert.ok(/绝对不要.*再调用任何工具|不要再调任何工具/.test(task), '★ 必须明令"写完就停"');
  assert.ok(/最后一条消息/.test(task), '★ 必须点破"只接收最后一条消息"这个机制');
  assert.ok(/覆盖/.test(task), '★ 必须说明"再调工具会覆盖掉交付"');
});

test('★★★ 必须有【硬性】搜索次数上限（3 次），不能只说"轮数有限"', () => {
  /*
   * ⚠️ 上一版只写"系统给你有限的搜索轮数" —— 实测那**不足以**让它停：
   * 它仍然一个来源接一个来源地搜（20 标的那次跑了 48 次 tool_use）。
   * 所以要给一个**具体数字**。
   */
  const task = buildHunterTask(HUNTERS[0]!, ['BTCUSDT']);
  assert.ok(/最多\s*3\s*次/.test(task), '★ 必须给出具体的搜索次数上限（3 次）');
  assert.ok(/硬上限|截断/.test(task), '★ 必须说明超了会被截断');
});

test('★★★ 必须要求【按主题搜】，而不是按标的逐个搜', () => {
  /*
   * ⚠️ 这是 20 标的场景能不能有产出的分水岭：
   * 逐标的搜 = 每个标的 2–3 次 = 40–60 次，任何轮数上限都不够。
   * 而同一批消息本来就会同时影响多个标的（`symbols` 是数组）。
   */
  const task = buildHunterTask(HUNTERS[0]!, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.ok(/按主题/.test(task), '★ 必须要求按主题搜');
  assert.ok(/不要\*\*为每个标的单独搜|不要为每个标的单独搜|不要按标的逐个搜/.test(task), '★ 必须明确禁止逐标的搜');
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
  assert.ok(/hoursAgo/.test(task), '★ 必须仍然要求 hoursAgo');
});

test('★★★ 每个猎手都要拿到这三条纪律（不是只改了一个）', () => {
  for (const h of HUNTERS) {
    const task = buildHunterTask(h, ['BTCUSDT', 'ETHUSDT']);
    const atFormat = task.indexOf('## 输出格式');
    const atSources = task.indexOf('优先看这些来源');
    assert.ok(atFormat > atSources, `★ 猎手 ${h.id}：输出格式没排在来源之后`);
    assert.ok(/最多\s*3\s*次/.test(task), `★ 猎手 ${h.id}：缺少搜索次数上限`);
    assert.ok(/不要再调任何工具/.test(task), `★ 猎手 ${h.id}：缺少"写完就停"`);
    assert.ok(/按主题/.test(task), `★ 猎手 ${h.id}：缺少"按主题搜"`);
  }
});

test('★★ 标的数量必须写进任务（让模型知道"逐个搜"根本不可能）', () => {
  /*
   * ⚠️ 只说"按主题搜"它可能仍不理解为什么。
   * 把"这 N 个标的"这个数字写进去，它才能自己算出"逐个搜不现实"。
   */
  const syms = ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT'];
  const task = buildHunterTask(HUNTERS[0]!, syms);
  assert.ok(task.includes('4 个标的'), `★ 必须写出标的数量（实际任务里没有"4 个标的"）`);
  for (const s of syms) assert.ok(task.includes(s), `★ 标的 ${s} 必须在任务里`);
});
