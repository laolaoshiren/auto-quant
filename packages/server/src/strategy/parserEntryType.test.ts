/**
 * **非法的 `entry_type` 不能把整条决策带走**（2026-10-15 修）
 *
 * ## 事故：模型写错一个枚举值，**整条决策凭空消失**
 *
 * `RawDecisionSchema.entry_type` 是 `z.enum(['market','limit'])`，
 * 而 `coerceRawDecision` 原来把模型给的字符串**原样透传** —— 于是：
 * ```
 *   模型写 "entryType":"skip"
 *   → LenientDecisionSchema.safeParse 失败
 *   → coerceRawDecision 返回 null
 *   → 调用点 `if (!coerced) continue;`（只有一行 log.debug）
 *   → 【既不入 decisions，也不入 rejected】
 *   ⇒ 界面上只显示"本轮无动作"，而模型明明给了决策
 * ```
 *
 * ## 线上铁证
 *
 * ```
 *   12 条命中：cyc 70 六条、cyc 84 六条（全是 "entryType":"skip"）
 *   那两轮的 decisions_json 都是 []，而 <decision> 块里明明有 6 条决策
 * ```
 * ⚠️ **线上恰好只命中 `skip`（损失为零）**，但同样的形状命中开仓就是**丢单**。
 *
 * ## 为什么"降级为市价"是正确方向
 *
 * `entry_type` 是"**怎么**进"的提示，不是"**要不要**进"的决定：
 * ```
 *   · 省略它            → 市价（既有行为，schema 注释写明了）
 *   · 给它认不出的值     → 与"省略"最接近的语义就是【按默认的市价走】
 *   · 丢弃整条          → 把"怎么进"的分歧升级成"不进"，那是越权
 * ```
 *
 * ## 两条独立的守卫
 * ```
 *   ① 非法 entry_type → 归一成市价（保住决策）+ 写进 adjustments（留痕）
 *   ② 整条真的解析不出 → 进 rejected（不再静默）
 * ```
 * ⚠️ ② 同样重要：`rejected` 的用途就是"说清模型要了什么、系统为什么没做"。
 * 一条既不执行、也不解释的决策，让操作员**无法分辨**
 * "模型这一轮真的没给"与"给了但被解析器吃掉了"—— 而这两件事的处理方式相反。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDecisionResponse, type ParseContext } from './parser.js';

function ctx(): ParseContext {
  return {
    candidateSymbols: new Set(['BTCUSDT', 'ETHUSDT']),
    openPositions: new Map<string, 'long' | 'short'>(),
    allowUnlistedCloses: true,
  } as ParseContext;
}

function parse(decisions: unknown[]) {
  return parseDecisionResponse(JSON.stringify({ decisions }), ctx());
}

/** 一条完整的开仓（字段齐全，只有 `entryType` 是我们要测的那个变量）。 */
function openLong(entryType?: string): Record<string, unknown> {
  return {
    symbol: 'BTCUSDT',
    action: 'open_long',
    leverage: 5,
    positionSizeUsd: 100,
    stopLoss: 60000,
    takeProfit: 70000,
    confidence: 70,
    ...(entryType === undefined ? {} : { entryType }),
  };
}

test('★★★ 非法 entry_type 不能让开仓决策消失（线上丢单风险）', () => {
  /*
   * ⚠️ 这是**最要紧**的一条：线上只命中过 skip（无损），
   * 但 `open_long` + 非法 entryType 就是**一笔真实开仓被吞掉**。
   */
  const r = parse([openLong('skip')]);
  assert.equal(
    r.decisions.length,
    1,
    '★ 决策必须保住 —— 一个入场方式的拼写问题不该让开仓意图消失',
  );
  assert.equal(r.decisions[0]?.action, 'open_long', '★ 动作必须原样保留');
  assert.equal(
    r.decisions[0]?.entryType,
    'market',
    '★ 认不出的入场方式必须退回市价（与"省略"同一语义）',
  );
});

test('★★★ 降级必须留痕（走 adjustments，不能只写日志）', () => {
  const r = parse([openLong('skip')]);
  const adj = r.decisions[0]?.adjustments ?? [];
  assert.ok(
    adj.some((a) => a.includes('skip') && a.includes('市价')),
    `★ 降级必须写进 adjustments（那才进数据库与界面）—— 实际：${JSON.stringify(adj)}`,
  );
});

test('★★★ 线上真实形状：`skip` 决策带非法 entryType 时也必须保住', () => {
  /* cyc 70 / cyc 84 的原文形状。 */
  const r = parse([
    { symbol: 'BTCUSDT', action: 'skip', entryType: 'skip' },
    { symbol: 'ETHUSDT', action: 'skip', entryType: 'skip' },
  ]);
  assert.equal(r.decisions.length, 2, '★ 两条都必须保住（修复前是 0 条）');
  assert.equal(r.rejected.length, 0, '★ 它们不该被拒 —— 降级后是合法的');
});

test('★★★ 合法的 entry_type 完全不受影响（修 bug 不能改对的行为）', () => {
  const limit = parse([{ ...openLong('limit'), limitPrice: 65000 }]);
  assert.equal(limit.decisions[0]?.entryType, 'limit', '★ limit 必须仍然是 limit');
  assert.equal(limit.decisions[0]?.limitPrice, 65000, '★ 限价必须带上');
  assert.deepEqual(limit.decisions[0]?.adjustments, [], '★ 合法输入不该产生任何 adjustment');

  const market = parse([openLong('market')]);
  assert.equal(market.decisions[0]?.entryType, 'market');
  assert.deepEqual(market.decisions[0]?.adjustments, [], '★ 合法输入不该产生 adjustment');
});

test('★★★ 省略 entry_type 的行为与改动前一致（增量更新的硬要求）', () => {
  const r = parse([openLong()]);
  assert.equal(r.decisions[0]?.entryType, 'market', '★ 省略 = 市价（既有约定）');
  assert.deepEqual(r.decisions[0]?.adjustments, [], '★ 省略不是"降级"，不该留痕');
});

test('★★★ 整条真的解析不出时必须进 rejected（不能再静默）', () => {
  /*
   * 连 `symbol` 都没有 → 无法构造一条决策。
   * 此时**必须留痕**，否则操作员分不清
   * "模型没给" 与 "给了但被解析器吃掉了"。
   */
  const r = parse([{ action: 'open_long' }]);
  assert.equal(r.decisions.length, 0, '★ 确实无法执行');
  assert.equal(r.rejected.length, 1, '★ 但必须出现在 rejected 里 —— 修复前是 0（完全静默）');
  assert.ok(
    String(r.rejected[0]?.reason).length > 10,
    '★ rejected 的理由要有信息量（不能是一句空话）',
  );
});
