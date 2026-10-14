/**
 * **岗位行显示的是"在做什么"，不是"产出了什么"**
 *（2026-10-14 用户报：那一行末尾出现了裸 JSON）
 *
 * ## 事故
 *
 * 用户截图：
 * ```
 *   ● 裁决官  进行中  深度思考  汇总多空论证，给出**唯一**结论（有权决定"…
 *              ```json [ {"symbol":"BTWUSDT","action":"ski…  17:26:38
 * ```
 * 那一行的末尾把**模型的原始输出**（JSON 数组）当成了摘要显示。
 *
 * ## 根因
 *
 * `DecisionFeed` 的 `latestTeamSteps` 原来写的是 `message: member.text` ——
 * 而 `member.text` 是 `parseTeamTrace` 从 `<team>` 块里解出的**角色产出正文**：
 * ```
 *   可能是 JSON（裁决官）、可能是一段长文（分析师）、可能是 markdown 表格
 * ```
 * 而 `TeamBoard` 用 `message` 当**单行摘要**（`truncate` + `title`）。
 * 两者是完全不同的东西：
 * ```
 *   message（该是）: "汇总辩论并裁决"   ← 一行、给人扫的
 *   member.text   : 模型的全部产出       ← 几百到几千字，给详情看的
 * ```
 *
 * ## 修法
 *
 * 岗位行只说"完成"；产出全文留在「展开详情 → 各角色产出」（那里有「展开全文」）。
 *
 * ⚠️ **不要截断产出当摘要** —— 截出来的开头（`{"symbol":…` 或 ```` ```json ````）
 * 既不是信息也不可读。用户看到的就是那个。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnlyCss as codeOnly } from '../testUtils/cssText.js';

const FEED = readFileSync(new URL('./DecisionFeed.tsx', import.meta.url), 'utf8');
const ROW = readFileSync(new URL('./TeamBoard/TeamDecisionRow.tsx', import.meta.url), 'utf8');

/**
 * ⚠️ **必须剥掉注释再判** —— 我在那段修复的说明里**引用了** `message: member.text`
 * 这句话（"原来写的是 `message: member.text`"），于是判据会命中注释、永远失败。
 *
 * 这是本项目反复踩的同一个坑（`>本轮未参与<` 查 JSX 文本、
 * `requestEarlyCycle('有成交')` 查源码、`if (!algo) return null` 查注释）——
 * **判据必须只扫代码**。
 */
function feedCodeBlock(): string {
  const code = codeOnly(FEED);
  const at = code.indexOf('const latestTeamSteps');
  return code.slice(at, at + 2000);
}

test('★★★ 岗位行的 message 必须是【提取的摘要】（既不是全文也不是"完成"）', () => {
  const block = feedCodeBlock();
  assert.ok(
    !/message:\s*member\.text/.test(block),
    '★ 不能把产出全文当 message —— 那正是用户看到的裸 JSON',
  );
  /*
   * ⚠️ **也不能只写 `'完成'`** —— 那是我的第二版，用户当场反馈：
   * > 「全是完成，展开看到也是完成何意味？」
   *
   * 正确的做法是 `summarizeMemberOutput(member.text)`：
   * 从产出里**提取**一段可读的结论。
   */
  assert.ok(
    /message:\s*summarizeMemberOutput\(member\.text\)/.test(block),
    '★ message 必须是提取的摘要（不是全文、也不是"完成"）',
  );
  assert.ok(
    !/message:\s*'完成'/.test(block),
    '★ 不能退回"完成"两个字 —— 那等于把这一行的信息量降到零',
  );
});

test('★★★ 产出全文仍必须在详情区可见（不能因为修岗位行就把它弄丢）', () => {
  /*
   * ⚠️ 修"岗位行"不该顺手把"产出"也删掉 —— 那是两个不同的展示位。
   */
  assert.ok(
    /member\.text/.test(ROW),
    '★ TeamDecisionRow 仍必须渲染 member.text（各角色产出 + 展开全文）',
  );
  assert.ok(
    /展开全文/.test(ROW),
    '★ 详情区的「展开全文」必须还在',
  );
});

test('★★ 不能靠截断产出当摘要（截出来的开头既不是信息也不可读）', () => {
  const block = FEED.slice(FEED.indexOf('const latestTeamSteps'), FEED.indexOf('const latestTeamSteps') + 2000);
  assert.ok(
    !/member\.text\.slice\(/.test(block),
    '★ 不要在岗位行截断产出 —— 开头是 `{"symbol":…` 或 ```json，不可读',
  );
});
