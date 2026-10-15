/**
 * **风控官的结构化 `verdict` 必须被认出来**（2026-10-15）
 *
 * ## 事故：`tighten` 被判成「否决」，于是有机会也不出手
 *
 * `roles.ts` 的风控官输出契约是**结构化 JSON**：
 * ```
 *   {"verdict":"approve|tighten|reject",
 *    "lossScenarios":[{"scenario":"…","likelihood":"…","severity":"…"}],
 *    "checked":"…"}
 * ```
 * 并明说：「你**只能**否决（reject）或要求收紧（tighten）。你没有"放宽"这个选项。」
 *
 * 而解析器只认**中文散文**（`/批准|放行|同意/` 与 `/否决|拒绝|不同意/`）——
 * `"verdict":"tighten"` **两边都不命中** ⇒ 判不出表态 ⇒ 走保守兜底。
 *
 * ## 实测代价（`#11` 最近 60 轮）
 *
 * ```
 *   verdict 分布: tighten=5 · approve=5 · reject=1
 *   那 5 次 tighten 全部渲染成：
 *     <risk> 否决（…）：（风控官未给出理由）   ← 判成"否决"
 *     <decision> []                            ← 所有决策被清空
 *   而 judge 原本提议: close_short / open_long / open_long …
 * ```
 * ⇒ **风控官说"要求收紧"，系统读成"否决"** —— 真实动作被全部拦下。
 *
 * ## 语义（必须与提示词一致）
 * ```
 *   approve  → 放行
 *   tighten  → 放行 + 削减（【不是否决】）
 *   reject   → 否决
 * ```
 * ⚠️ 把 `tighten` 当成否决，等于**每一次风控官想保守一点都变成完全不出手**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRiskOfficerVerdict } from './riskOfficer.js';
import type { Decision } from '@aq/shared';

const openLong = (usd: number): Decision =>
  ({ symbol: 'AAAUSDT', action: 'open_long', leverage: 5, positionSizeUsd: usd, confidence: 70 }) as Decision;

test('★★★ `verdict:"tighten"` 必须是【放行+削减】，不是否决', () => {
  /*
   * ⚠️ 这是线上真实出现过的形状（`担心：{...}` 那一行里嵌着 JSON）。
   */
  const text = '担心：{"verdict":"tighten","lossScenarios":[{"scenario":"止损仅为 ATR 的 0.34 倍","likelihood":"high","severity":"moderate"}],"checked":"止损位置、ATR 倍数"}';
  const v = parseRiskOfficerVerdict(text, [openLong(11)]);
  assert.equal(v.approved, true, '★ tighten 是"要求收紧"，不是否决 —— 必须放行');
  assert.equal(v.reduced, true, '★ tighten 必须触发削减');
  assert.ok(v.adjusted !== null, '★ 削减后应当有 adjusted');
  assert.ok(
    (v.adjusted?.[0]?.positionSizeUsd ?? 11) < 11,
    '★ 削减后的仓位必须小于原值',
  );
});

test('★★★ `verdict:"reject"` 是否决（决策清空）', () => {
  const text = '{"verdict":"reject","lossScenarios":[{"scenario":"x","likelihood":"high","severity":"severe"}],"checked":"y"}';
  const v = parseRiskOfficerVerdict(text, [openLong(11)]);
  assert.equal(v.approved, false, '★ reject 必须否决');
});

test('★★★ `verdict:"approve"` 是放行且不削减', () => {
  const text = '{"verdict":"approve","lossScenarios":[],"checked":"止损、方向、仓位"}';
  const v = parseRiskOfficerVerdict(text, [openLong(11)]);
  assert.equal(v.approved, true, '★ approve 必须放行');
  assert.equal(v.reduced, false, '★ approve 不该削减');
});

test('★★★ 理由必须从 JSON 里取（不能显示"未给出理由"）', () => {
  /*
   * ⚠️ 线上原文：「否决（group/auto-qfmodel）：（风控官未给出理由）」
   * —— **它明明给了理由**（`lossScenarios` 里写着），只是取不到。
   */
  const text = '{"verdict":"tighten","lossScenarios":[{"scenario":"ETH空单止损1.5%仅为ATR14的2.1倍，单根插针即可触及","likelihood":"high","severity":"moderate"}],"checked":"止损距离与ATR倍数"}';
  const v = parseRiskOfficerVerdict(text, [openLong(11)]);
  assert.ok(
    !/未给出理由/.test(v.reason),
    `★ 不能显示"未给出理由"（JSON 里有）—— 实际：${v.reason}`,
  );
  assert.ok(v.reason.length > 5, '★ 理由必须有内容');
});

test('★★★ 散文格式仍然要走原来的正则判据（不能因为加了 JSON 分支而坏掉）', () => {
  /*
   * ⚠️ 反向守卫：模型不一定总给 JSON。散文格式的判据（含"否决优先"）
   * 必须原样保留 —— 那几条既有测试钉的就是它。
   */
  const approve = parseRiskOfficerVerdict('## 风控审批结论：**批准** ✅\n止损合理。', [openLong(11)]);
  assert.equal(approve.approved, true, '★ 散文"批准"必须放行');

  const reject = parseRiskOfficerVerdict('## 风控审批结论：**否决**\n风险过高。', [openLong(11)]);
  assert.equal(reject.approved, false, '★ 散文"否决"必须拦下');

  /* ⚠️ 条件句里的"否决"不能把批准读成否决（`c155` 实测的边界）。 */
  const conditional = parseRiskOfficerVerdict(
    '## 风险审查结论：**批准** ✅（附强制条件）\n条件：若跌破止损位则否决本次开仓并立即平仓。',
    [openLong(11)],
  );
  assert.equal(conditional.approved, true, '★ 条件句里的"否决"不该命中（第一行有表态就用第一行）');
});
