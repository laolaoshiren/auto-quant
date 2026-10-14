/**
 * **风控官说"无需削减"时不能削仓位**（2026-10-15 修，一次真钱事故）
 *
 * ## 事故
 *
 * `riskOfficer.ts` 的 reduce 正则**没有否定式排除**：
 * ```
 *   const reduce = /削减|减半|降低仓位|reduce/i.test(scope);
 * ```
 * 于是风控官明确说"不用削"时，仓位照样被砍一半。
 *
 * ## 线上铁证（`cyc 153`，`2026-10-14T03:15:21Z`）
 * ```
 *   <risk>  削减后放行：## 裁决：批准（无需削减）       ← 它说的是"无需"
 *   <decision>  QUSDT open_long positionSizeUsd:5.5     ← 实际砍了一半
 *   judge 原始:  QUSDT open_long positionSizeUsd:11
 *   reasoning: "[风控官削减 50%] …"                      ← 还留了一条假痕
 * ```
 * `cyc 148` 同样（说"批准"，6 砍成 3）。
 *
 * ## 为什么这比"少削一次"严重
 *
 * ```
 *   ① 直接后果：仓位被无故减半 —— 这改变真实盈亏（真钱）
 *   ② 更糟的是【留痕是假的】：审计块写"削减后放行"，
 *      而"事后能说清当时为什么这么做"正是审计块唯一的用途
 *   ③ 它与 `approveRe` 的 `(?<!不)同意` 是【同一种缺陷】，
 *      而那一处早就修了 —— 这一处被漏掉（"只做一半"的又一次）
 * ```
 *
 * ⚠️ 用**消去法**（先把否定短语从文本里去掉再匹配）而不是给每个动词加后顾断言：
 * 后者要为「削减/减半/降低仓位/reduce」各写一份，漏一个就是同一个 bug 再来一次。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRiskOfficerVerdict } from './riskOfficer.js';
import type { Decision } from '@aq/shared';

/** 一份最小可用的提案（11 USDT —— 与线上 cyc 153 同量级）。 */
function proposal(over: Partial<Decision> = {}): Decision {
  return {
    symbol: 'QUSDT',
    action: 'open_long',
    leverage: 5,
    positionSizeUsd: 11,
    stopLoss: 0.04,
    takeProfit: 0.05,
    confidence: 60,
    riskUsd: 0.22,
    reasoning: '原始论证',
    reducePercent: null,
    reduceQuantity: null,
    setupScore: null,
    setupScoreBasis: '',
    adjustments: [],
    ...over,
  } as Decision;
}

test('★★★ 风控官说"无需削减"时，仓位【不能被砍】', () => {
  /*
   * ⚠️ 这三条措辞都是**线上真实出现过的**（审计给出的原文）。
   */
  for (const text of [
    '## 裁决：批准（无需削减）',
    '## 审批结论：批准，无需削减仓位',
    '## 风险审查结论：**批准**（不建议削减）',
  ]) {
    const v = parseRiskOfficerVerdict(text, [proposal()]);
    assert.equal(v.reduced, false, `★ 「${text}」不该判成削减`);
    assert.equal(
      v.adjusted?.[0]?.positionSizeUsd ?? 11,
      11,
      `★ 「${text}」的仓位必须保持 11（不能砍成 5.5）`,
    );
  }
});

test('★★★ 风控官【真的】要削时，必须削 —— 修否定式不能把真削减一起关掉', () => {
  /*
   * 这是上一条的**反向守卫**：最容易犯的错是"为了修误判把整个削减关掉"。
   */
  for (const text of [
    '## 裁决：批准，但削减 50%',
    '## 裁决：减半仓位后放行',
    '## 裁决：批准，降低仓位至 5 USDT',
  ]) {
    const v = parseRiskOfficerVerdict(text, [proposal()]);
    assert.equal(v.reduced, true, `★ 「${text}」必须判成削减`);
    assert.equal(
      v.adjusted?.[0]?.positionSizeUsd,
      5.5,
      `★ 「${text}」的仓位必须砍半到 5.5`,
    );
  }
});

test('★★ "无需"与"削减"分离在不同句子里时，仍然不削', () => {
  /*
   * 消去法的边界：模型可能写
   * ```
   *   ## 裁决：批准
   *   无需任何调整。若后续波动加剧可考虑削减仓位。
   * ```
   * 那种情况**第一行有表态**（批准），而 `scope` 取的是表态区 ——
   * 这条钉住"结论行优先"这条既有纪律在削减判定上同样成立。
   */
  const text = '## 裁决：批准（无需削减）\n若波动加剧可考虑削减仓位。';
  const v = parseRiskOfficerVerdict(text, [proposal()]);
  assert.equal(v.reduced, false, '★ 结论行说"无需削减"，就不该因为后面的条件句而削减');
});
