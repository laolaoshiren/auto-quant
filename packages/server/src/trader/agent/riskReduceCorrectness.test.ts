/**
 * **风控官削减的三个正确性条件**（2026-10-15 修，两个真钱/留痕事故）
 *
 * ## 事故 A：snake_case 下"数值没动，却留痕说削了"
 *
 * `routedModel.ts` 把裁决官的**原始 JSON** 交给风控官，而模型惯用 snake_case
 *（`position_size_usd` / `risk_usd`）。而 `reduceDecisions` 原来只改 camelCase：
 * ```
 *   裁决官用 snake_case → 11 USDT 原样通过（【没削】）
 *   而 reasoning 已被加上 "[风控官削减 50%]"
 *   ⇒ 事后看审计块会以为"风控官削过了"，实际仓位是原值
 * ```
 * 线上实测：225 轮里 **10 轮用 snake_case**、26 轮用 camelCase；
 * 削减生效的 5 轮**全部是 camelCase** —— 两种形状都已出现，只是还没撞在一起。
 *
 * ## 事故 B：`skip` / `hold` 被加上「削减 50%」假痕
 *
 * 削减分支原来只判 `isRiskReducing`（只认 `close_*`/`reduce_position`/`adjust_protection`），
 * 于是 `skip`/`hold`/`wait` 也走了进去，被加前缀 —— 而它们**没有仓位可削**。
 * 线上实测：**20 条 `skip` 带这个前缀**。
 *
 * ## 为什么"假痕"比"没削"严重
 *
 * 审计块唯一的用途是「事后能说清当时为什么这么做」。
 * 一条说「削减了 50%」而实际没削的记录，**让审计块说谎** ——
 * 那比不削更糟，因为它会误导后续所有基于它的判断。
 *
 * ## 判据（三条，缺一不可）
 * ```
 *   ① 两个键名都要改（camelCase + snake_case）
 *   ② 只有「能削的动作」才进削减分支（open_long / open_short / add_to_position）
 *   ③ 没真的改到字段就不留痕
 * ```
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRiskOfficerVerdict } from './riskOfficer.js';
import type { Decision } from '@aq/shared';

const VERDICT = '## 裁决：批准，削减 50%';

function decision(over: Record<string, unknown> = {}): Decision {
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
  } as unknown as Decision;
}

test('★★★ snake_case 的仓位也必须被削（否则数值没动、留痕却是假的）', () => {
  const snake = decision({ positionSizeUsd: undefined, riskUsd: undefined, position_size_usd: 11, risk_usd: 0.22 });
  const v = parseRiskOfficerVerdict(VERDICT, [snake]);
  const a = v.adjusted?.[0] as unknown as Record<string, unknown>;
  assert.equal(a?.['position_size_usd'], 5.5, '★ snake_case 必须被削半（11 → 5.5）');
  assert.equal(a?.['risk_usd'], 0.11, '★ risk_usd 同理');
});

test('★★★ camelCase 仍然必须被削（修 snake_case 不能把这条弄坏）', () => {
  const v = parseRiskOfficerVerdict(VERDICT, [decision()]);
  assert.equal(v.adjusted?.[0]?.positionSizeUsd, 5.5, '★ camelCase 必须仍然削半');
});

test('★★★ `skip` / `hold` 不能被加上「削减 50%」假痕（它们无仓位可削）', () => {
  for (const action of ['skip', 'hold'] as const) {
    const v = parseRiskOfficerVerdict(VERDICT, [decision({ action, positionSizeUsd: 0, riskUsd: 0 })]);
    const reasoning = String(v.adjusted?.[0]?.reasoning ?? '');
    assert.ok(
      !reasoning.includes('风控官削减'),
      `★ ${action} 不该带削减留痕（线上有 20 条这种假痕）—— 实际：${reasoning}`,
    );
  }
});

test('★★★ 没真的改到字段时，不留痕（留假痕比不削更糟）', () => {
  /*
   * 模型没给仓位字段（两个都是 undefined）→ 削减分支无从下手。
   * 此时**必须不写前缀** —— 否则审计块会说「削减了 50%」而实际什么都没削。
   */
  const bare = decision({ positionSizeUsd: undefined, riskUsd: undefined });
  const v = parseRiskOfficerVerdict(VERDICT, [bare]);
  const reasoning = String(v.adjusted?.[0]?.reasoning ?? '');
  assert.ok(
    !reasoning.includes('风控官削减'),
    `★ 没改到就不该留痕 —— 实际：${reasoning}`,
  );
});

test('★★ 降低风险的动作仍然原样保留（削减它们等于让仓位更危险）', () => {
  for (const action of ['close_long', 'close_short', 'reduce_position', 'adjust_protection'] as const) {
    const v = parseRiskOfficerVerdict(VERDICT, [decision({ action })]);
    const a = v.adjusted?.[0];
    assert.equal(a?.positionSizeUsd, 11, `★ ${action} 的仓位不该被削`);
    assert.ok(
      !String(a?.reasoning ?? '').includes('风控官削减'),
      `★ ${action} 不该带削减留痕`,
    );
  }
});
