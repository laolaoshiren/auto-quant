/**
 * **"为什么没审风控"必须说实话**（2026-10-15）
 *
 * ## 事故：把"设计内跳过"说成"未启用或调用失败"
 *
 * 审计块的 `<risk>` 块原来对所有"没审阅"都写同一句：
 * ```
 *   ⚠️ 本轮未经风控官审阅（风控角色未启用或调用失败）—— 决策按裁决官结论直接放行。
 * ```
 * 而实测（`#11`，272 轮）**74% 的轮次**都是这一句，它们的真实原因是：
 * ```
 *   裁决官给的决策【全是 skip】→ 设计内跳过
 *   （`askRiskOfficer` 里那条 `!hasAction` 分支：没有动作就没有风险敞口可审，
 *     省一次约 120 秒的调用 —— 这是【有意优化】，不是失败）
 * ```
 *
 * ⇒ **操作员会去查一个不存在的问题。**
 *
 * 这与"把故障说成观望"（`decisionZeroState.ts` 那条）是**同一类病、方向相反**：
 * ```
 *   那条：故障 → 说成正常（让人不去查该查的）
 *   这条：正常 → 说成故障（让人去查不该查的）
 * ```
 * 两者都让审计记录失去可信度。
 *
 * ## 判据
 *
 * ```
 *   全是 skip/hold/wait  → 文案必须说"无需审阅 / 设计内的省略"，且【不出现】"失败"
 *   有真实动作但没审     → 文案必须说"未审阅"（那才需要查）
 * ```
 * ⚠️ 关键是**互斥性**：正常的那条不能出现"失败"字样，否则等于没改。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderDeskOutcome } from './deskOutput.js';
import { allNonAction } from './nonAction.js';
import type { DeskOutcome } from './tradingDesk.js';

/** 造一个最小的 outcome：裁决官给出给定的决策数组。 */
function outcomeWith(decisions: unknown[]): DeskOutcome {
  return {
    analyses: [],
    bull: null,
    bear: null,
    verdict: {
      role: 'judge',
      modelId: 'test-model',
      data: null,
      raw: `\`\`\`json\n${JSON.stringify(decisions)}\n\`\`\``,
      latencyMs: 1,
      ok: true,
    },
    callsUsed: 9,
    truncatedByBudget: false,
    summary: '分析师 4/4 成功 · 已裁决',
  };
}

test('★★★ 全是 skip 时，文案必须说"无需审阅"，且不能说"失败"', () => {
  const text = renderDeskOutcome(
    outcomeWith([
      { symbol: 'AAAUSDT', action: 'skip', confidence: 80, reasoning: 'D 不足' },
      { symbol: 'BBBUSDT', action: 'skip', confidence: 70, reasoning: 'ATR 过高' },
    ]),
    null,
  );
  assert.ok(/无需风控官审阅/.test(text), `★ 应当说"无需审阅"，实际：\n${text.slice(0, 400)}`);
  /*
   * ⚠️ 互斥性：这是最关键的一条 —— 只加新文案不够，旧的误导性措辞必须消失。
   */
  assert.ok(
    !/调用失败/.test(text),
    '★ 全是 skip 是【设计内跳过】，文案里不能出现"调用失败"（那会让人白查）',
  );
  assert.ok(
    !/未启用/.test(text),
    '★ 全是 skip 时不能出现"未启用"（风控官是启用的，只是没东西可审）',
  );
});

test('★★★ 有真实动作却没审时，文案必须说"未审阅"（那才需要查）', () => {
  const text = renderDeskOutcome(
    outcomeWith([{ symbol: 'AAAUSDT', action: 'open_long', confidence: 80, reasoning: '合格' }]),
    null,
  );
  assert.ok(
    /未经风控官审阅/.test(text),
    `★ 有动作却没审是【真问题】，必须明说未审阅，实际：\n${text.slice(0, 400)}`,
  );
  /* 反过来：不能说"无需审阅" —— 那是在给真问题开脱。 */
  assert.ok(!/无需风控官审阅/.test(text), '★ 有真实动作时不能说"无需审阅"');
});

test('★★★ 判据与 askRiskOfficer 共用同一个（防止两处漂移）', () => {
  /*
   * ⚠️ 这条守的是"判据只有一份"。
   * `askRiskOfficer` 用 `!hasAction`（即 `allNonAction`）决定跳过，
   * 而渲染层用同一个函数决定文案 —— 若哪天有人各写一份，就会出现
   * "跳过是因为全是 skip、文案却说调用失败"的自相矛盾审计记录。
   */
  assert.equal(allNonAction([{ action: 'skip' }, { action: 'hold' }]), true);
  assert.equal(allNonAction([{ action: 'skip' }, { action: 'open_long' }]), false);
  /* ⚠️ 空数组是"没有决策"，不是"全是 skip" —— 两者要分开。 */
  assert.equal(allNonAction([]), false, '★ 空数组不是"全不行动"');
  /* ⚠️ 未知动作必须 fail-closed（送去风控），不能默认跳过。 */
  assert.equal(allNonAction([{ action: 'some_future_action' }]), false, '★ 未知动作必须送去风控');
});

test('★★ 未启用/失败时如实说，不猜原因', () => {
  const text = renderDeskOutcome(
    outcomeWith([{ symbol: 'AAAUSDT', action: 'open_long', confidence: 80, reasoning: 'x' }]),
    null,
    { skipReason: 'call_failed' },
  );
  assert.ok(/调用失败/.test(text), '★ 传了 call_failed 就应当说"调用失败"');
});
