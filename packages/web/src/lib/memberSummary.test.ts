/**
 * **岗位行的摘要必须可读**（2026-10-14 两次用户反馈之间的平衡点）
 *
 * ## 两次反馈
 *
 * ```
 *   第一版：message = member.text（产出全文）
 *     → 用户看到裸 JSON：```json [ {"symbol":"BTWUSDT","action":"ski…
 *
 *   第二版：message = '完成'
 *     → 用户：「全是完成，展开看到也是完成何意味？」
 * ```
 * **两次都错**：一次是把全文塞进去，一次是把信息全删掉。
 * 正确的是**提取**一段摘要。
 *
 * ## 本文件钉住的判据
 *
 * ```
 *   ① 裸 JSON / 代码围栏不能出现
 *   ② 不能只有"完成"两个字（除非产出真的是空的）
 *   ③ 开场白要跳过（"让我…"、"第一步："、"首先"）
 *   ④ JSON 产出要抽出 `reasoning` 字段（那是"它为什么这么判"）
 *   ⑤ 长度有上限（一行放得下）
 *   ⑥ 空产出兜底"完成"
 * ```
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY_SUMMARY, summarizeMemberOutput } from './memberSummary.js';

test('★★★ 不能把裸 JSON / 代码围栏当摘要（第一版的事故）', () => {
  const out = summarizeMemberOutput('```json [ {"symbol":"BTWUSDT","action":"skip"} ] ```');
  assert.ok(!out.includes('```'), '★ 不能有代码围栏');
  assert.ok(!out.includes('{"symbol"'), '★ 不能有裸 JSON 片段');
});

test('★★★ 不能只有"完成"两个字（第二版的事故）', () => {
  /*
   * ⚠️ 这是用户第二次反馈的原话：「全是完成，展开看到也是完成何意味？」
   */
  const out = summarizeMemberOutput('市场偏多，1h 结构完好，回踩不破 60k，可以做多。');
  assert.notEqual(out, EMPTY_SUMMARY, '★ 有内容时不能退化成"完成"');
  assert.ok(out.includes('市场偏多'), '★ 要提取出实质内容');
});

test('★★★ 开场白必须跳过（"让我…" / "第一步：" / "首先"）', () => {
  for (const opener of ['让我按决策流程走一遍。', '第一步：扫描触发。', '首先我需要看一下材料。']) {
    const out = summarizeMemberOutput(`${opener}BTCUSDT 位移 0.07%，无触发。`);
    assert.ok(
      out.includes('BTCUSDT') || out.includes('位移'),
      `★ 应跳过开场白「${opener}」，实际得到「${out}」`,
    );
  }
});

test('★★★ JSON 产出要抽出 reasoning（否则裁决官那行只能是"完成"）', () => {
  const out = summarizeMemberOutput(
    '```json [ {"symbol":"BTWUSDT","action":"skip","reasoning":"D=4.57% 超过 2.5% 上限，禁止入场"} ] ```',
  );
  assert.ok(out.includes('D=4.57%'), '★ 必须抽出 reasoning 字段的内容');
  assert.notEqual(out, EMPTY_SUMMARY, '★ 有 reasoning 就不能退化成"完成"');
});

test('★★ 长度有上限（一行放得下）', () => {
  const long = `${'这是一段很长的推理。'.repeat(30)}`;
  const out = summarizeMemberOutput(long);
  assert.ok(out.length <= 90, `★ 摘要要有上限（实际 ${out.length} 字）`);
});

test('★★ 空产出兜底"完成"（显示空比显示"完成"更糟）', () => {
  assert.equal(summarizeMemberOutput(''), EMPTY_SUMMARY);
  assert.equal(summarizeMemberOutput('   \n\n  '), EMPTY_SUMMARY);
});

test('★★ 机器标签要剥掉（<reasoning> 是包装，不是内容）', () => {
  const out = summarizeMemberOutput('<reasoning>市场偏空，样本不足，不做。</reasoning>');
  assert.ok(!out.includes('<reasoning>'), '★ 不能残留机器标签');
  assert.ok(out.includes('市场偏空'), '★ 标签里的内容要保留');
});
