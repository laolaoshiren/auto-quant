/**
 * **错误信息不能被当成产出**（2026-10-15）
 *
 * ## 事故：`research_cache` 说"4/4 个猎手有产出"，而每节都是错误
 *
 * 线上原文：
 * ```
 *   ## 消息面调研（4/4 个猎手有产出）
 *   ### 新闻猎手（news_hunter）
 *   Error: Reached max turns (12)
 *   ### 资金猎手（flow_hunter）
 *   Error: Reached max turns (12)
 *   …
 * ```
 *
 * ## 根因：`harness.ts` 的判据是 `text.length > 0`
 *
 * `claude --print` 撞上限时把 `Error: Reached max turns (N)` **写到 stdout**，
 * 于是 `text` 非空 ⇒ 判成 `ok: true` ⇒ 那句错误被当成"有效产出"。
 *
 * ⇒ **这是"把故障说成正常"的第四次**（前三次：决策详情页、`<risk>` 块、猎手零产出），
 * 而这一次最靠底层：它让**下游所有角色**都以为"消息面调研成功了"。
 *
 * ## 判据（两层，都要守）
 * ```
 *   harness 层   ：剥掉错误行后还有实质内容 → ok:true；否则 ok:false 且 text 清空
 *   merge 层     ：标题的"N/M 有产出"按【实质内容】数，不按 r.ok
 * ```
 * ⚠️ 而且 merge 层**必须仍然区分三件事**（既有测试钉住的语义）：
 * ```
 *   ① ok:false              → 「未产出」（没跑成 —— 我们不知道那边有什么）
 *   ② ok:true + 文本为空     → 「未查到相关消息」（跑了，那边确实没消息）
 *   ③ ok:true + 有实质内容   → 正常展示
 * ```
 * 把 ① 与 ② 合并会让下游把"我不知道"当成"那边没事"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeHunterReports, type HunterReport } from './hunters.js';

const rep = (over: Partial<HunterReport>): HunterReport => ({
  hunterId: 'news_hunter',
  label: '新闻猎手',
  ok: true,
  text: '',
  latencyMs: 1,
  ...over,
});

test('★★★ 只有错误行的"产出"必须算作未产出（不能进标题的分子）', () => {
  const reports: HunterReport[] = [
    rep({ text: 'Error: Reached max turns (12)' }),
    rep({ hunterId: 'flow_hunter', label: '资金猎手', text: 'Error: Reached max turns (12)' }),
  ];
  const merged = mergeHunterReports(reports);
  assert.ok(
    merged.includes('0/2 个猎手有产出'),
    `★ 标题必须说 0/2（它们一个字都没写），实际：\n${merged.slice(0, 300)}`,
  );
  /* ⚠️ 错误行本身不能出现在"产出"的位置 —— 它必须显示成未产出。 */
  assert.ok(/未产出/.test(merged), '★ 必须显示成"未产出"');
});

test('★★★ 有实质内容 + 尾部错误行 → 仍算有产出（不能把好产出丢掉）', () => {
  /*
   * ⚠️ 反向守卫：`harness.ts` 那条"撞上限但有内容就收下"的修法**不能被我改坏**。
   * 真实情形是"搜到了几条，然后轮数用尽"—— 那些内容是有效的。
   */
  const reports: HunterReport[] = [
    rep({
      text:
        '[{"summary":"SOL ETF 连续 7 日净流出","sourceUrl":"https://example.com/a","hoursAgo":3}]\n' +
        'Error: Reached max turns (12)',
    }),
  ];
  const merged = mergeHunterReports(reports);
  assert.ok(merged.includes('1/1 个猎手有产出'), '★ 有实质内容就要算有产出');
  assert.ok(merged.includes('SOL ETF'), '★ 实质内容必须原样保留');
});

test('★★★ 三种状态必须区分（这是既有语义，不能合并）', () => {
  const reports: HunterReport[] = [
    /* ① 没跑成 */
    rep({ hunterId: 'a', label: '新闻猎手', ok: false, text: '', error: '超时' }),
    /* ② 跑了但那边没消息 */
    rep({ hunterId: 'b', label: '资金猎手', ok: true, text: '   ' }),
    /* ③ 有内容 */
    rep({ hunterId: 'c', label: '社区猎手', ok: true, text: '[{"summary":"x"}]' }),
  ];
  const merged = mergeHunterReports(reports);
  assert.ok(/未产出/.test(merged), '★ ① 必须说"未产出"');
  assert.ok(/未查到相关消息/.test(merged), '★ ② 必须说"未查到"（不是"未产出"）');
  assert.ok(merged.includes('1/3 个猎手有产出'), '★ 只有 ③ 算有产出');
});
