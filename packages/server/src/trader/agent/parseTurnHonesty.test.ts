/**
 * **错误信息必须说真话** —— 工具循环的 `parseTurn` 报错判据（2026-10-15）
 *
 * ## 事故
 *
 * 实测失败原文（`agent_runs` #820，`strategy/single`，烧掉 2–6 万 tokens **零产出**）：
 * ```
 *   模型连续两轮没有输出可解析的工具调用：
 *     无法从回复里解析出 JSON 对象（前 120 字符：
 *     {"thought":"综合分析：1) 24h 30笔交易,胜率30%,SL均亏-3.98%,TP均赚+8.73%,
 *      净PnL≈-0.048——数学上接近盈亏平衡,6连亏在70%失败率下概率11.8%,属统计噪声…"）
 * ```
 * **那段文本是合法 JSON。** 真实原因是"它只写了 thought、没说要调哪个工具"。
 *
 * ## 真实形状（复刻出来的，不是推测）
 *
 * ```
 *   多个对象、且第一个没有 tool：
 *     parseRoleOutput(整段) → value=null（多对象对它是歧义，必须失败）
 *                             error="无法从回复里解析出 JSON 对象…"  ← 【就是这句在说谎】
 *     firstBalancedObject() → 取到第一个对象，但它没有 tool 字段
 *     ⇒ 旧代码沿用 parsed.error ⇒ 报出"解析失败"
 * ```
 *
 * ## 为什么这比"报错不准确"严重
 *
 * ```
 *   ① 给模型的纠正提示是错的
 *      → 它去**重新整理格式**（格式本来没问题）→ 下一轮同样形状 → 连续两轮 → failed
 *   ② 给操作员的日志是错的
 *      → "无法解析 JSON" 让人查解析器/编码/转义，而真相是协议没被遵守
 * ```
 * 这个仓库反复记过：**一个说错话的错误信息比没有信息更糟。**
 *
 * ## 判据
 *
 * 取到对象（`firstBalancedObject` 非 null）⇒ 缺的一定是 `tool`，
 * 报错必须说"没有 tool 字段"；**只有连对象都取不到**才允许报"无法解析"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTurn } from './loop.js';

test('★★★ 多对象+第一个无 tool：必须报"没有 tool 字段"，不能报"无法解析 JSON"', () => {
  /*
   * ⚠️ 这是**实测失败的真实形状**。旧代码在这里报"无法从回复里解析出 JSON 对象"，
   * 而那段文本是合法 JSON —— 错误信息在说谎。
   */
  const text =
    '{"thought":"综合分析：1) 24h 30笔交易,胜率30%,SL均亏-3.98%,TP均赚+8.73%","summary":"结论"}\n' +
    '{"thought":"另一个","tool":"finish","args":{}}';
  const r = parseTurn(text);

  assert.equal(r.action, null, '缺 tool 就是失败（不猜它想干什么）');
  assert.ok(r.error !== null, '必须有错误说明');
  assert.ok(
    /没有 tool 字段/.test(r.error),
    `★ 必须说清缺的是 tool，实际：${r.error}`,
  );
  assert.ok(
    !/无法从回复里解析出 JSON 对象/.test(r.error),
    `★ 【不能说谎】JSON 是合法的，不能报"解析失败"。实际：${r.error}`,
  );
  /* 纠正提示必须给出**可执行的下一步**，否则模型只能瞎猜。 */
  assert.ok(/finish/.test(r.error), '★ 必须告诉它"要给结论就调用 finish"');
});

test('★★★ 单个对象无 tool：同样必须报"没有 tool 字段"', () => {
  const r = parseTurn('{"thought":"分析…","summary":"结论"}');
  assert.equal(r.action, null);
  assert.ok(/没有 tool 字段/.test(r.error ?? ''), `★ 实际：${r.error}`);
  assert.ok(!/无法从回复里解析出 JSON 对象/.test(r.error ?? ''), '★ 不能说谎');
});

test('★★ <decision> 包着数组：也说"没有 tool 字段"，不说"解析失败"', () => {
  /*
   * 实测 panel 档的两次失败就是这个形状（模型在工具循环里回了决策块）。
   */
  const r = parseTurn('<decision>\n[{"symbol":"BTCUSDT","action":"skip"}]\n</decision>');
  assert.equal(r.action, null);
  assert.ok(/没有 tool 字段/.test(r.error ?? ''), `★ 实际：${r.error}`);
});

test('★★★ 对照：正常工具调用必须仍然成功（不能为了报错把好的也拒了）', () => {
  const r = parseTurn('{"thought":"先看绩效","tool":"get_performance","args":{"window":"7d"}}');
  assert.ok(r.action !== null, `★ 正常调用被判失败：${r.error}`);
  assert.equal(r.action!.tool, 'get_performance');
  assert.deepEqual(r.action!.args, { window: '7d' });
});

test('★★★ 对照：多对象但第一个【有】tool → 取第一个，仍成功', () => {
  /*
   * 这是 `firstBalancedObject` 存在的原因（实测 37 次 failed 全是这个形状）。
   * 改报错文案不能把它弄坏。
   */
  const r = parseTurn(
    '{"thought":"a","tool":"get_lessons","args":{}}\n{"thought":"b","tool":"finish","args":{}}',
  );
  assert.ok(r.action !== null, `★ 应当取第一个对象，实际：${r.error}`);
  assert.equal(r.action!.tool, 'get_lessons');
});

test('★★ 连对象都取不到时，才允许报"无法解析"', () => {
  /*
   * 这条是**反向守卫**：上面几条要求"取到对象就说没有 tool"，
   * 但不能因此把"真的没解析出来"也说成"没有 tool 字段" —— 那会变成另一种说谎。
   */
  const r = parseTurn('我无法回答这个问题，因为没有可用的数据。');
  assert.equal(r.action, null);
  assert.ok(r.error !== null);
  assert.ok(
    !/没有 tool 字段/.test(r.error),
    `★ 没有对象时不该说"缺 tool 字段"，实际：${r.error}`,
  );
});
