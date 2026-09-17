/**
 * 保本止损的方向与棘轮。
 *
 * ## 为什么这些用例存在
 *
 * 这段逻辑写错的两种方式，**都会让一笔赚到钱的单变成亏损单**：
 *
 * - **方向搞反**（做空时抬高止损）→ 盈利时把止损设到亏损侧，等于主动拉近风险
 * - **单向棘轮失效**（允许回退）→ 价格回落时止损退回原地，**保本看起来在工作、
 *   其实没生效** —— 而那种失效最难发现
 *
 * 所以每条的分量两侧都要钉。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldMoveStopToBreakeven, type BreakevenInput } from './breakeven.js';

const base = (over: Partial<BreakevenInput> = {}): BreakevenInput => ({
  side: 'long',
  entryPrice: 100,
  currentStop: 98,
  markPrice: 108,
  unrealizedPnlPercent: 8,
  triggerPercent: 8,
  ...over,
});

/* -------------------------------------------------------------------------- */
/*  方向 —— 两个方向都要对                                                     */
/* -------------------------------------------------------------------------- */

test('做多：浮盈够时把止损从下方抬到开仓价', () => {
  const v = shouldMoveStopToBreakeven(base());
  assert.equal(v.move, true);
  assert.equal(v.newStop, 100, '做多的保本止损应当在开仓价，而不是更高或更低');
  assert.match(v.reason, /保本阈值/, '理由要说清为什么动');
});

test('做空：浮盈够时把止损从上方压到开仓价', () => {
  /*
   * 这是最容易写反的一条。做空的止损在**上方**，
   * 所以"移到开仓价"是往下压，不是往上抬。
   */
  const v = shouldMoveStopToBreakeven(base({ side: 'short', currentStop: 102 }));
  assert.equal(v.move, true);
  assert.equal(v.newStop, 100, '做空的保本止损同样在开仓价');
});

/* -------------------------------------------------------------------------- */
/*  棘轮 —— 只往有利方向移                                                     */
/* -------------------------------------------------------------------------- */

test('做多：止损已经在开仓价或更好时不动（绝不回退）', () => {
  /*
   * 允许回退是最坏的一种"自作聪明"：操作员手动设了更紧的止损（比如 102），
   * 保本逻辑如果把它"退回"到 100，等于**主动放宽了风险**。
   */
  for (const currentStop of [100, 101, 105]) {
    const v = shouldMoveStopToBreakeven(base({ currentStop }));
    assert.equal(v.move, false, `做多且止损 ${currentStop} 已在保本或更好 —— 不该动`);
    assert.match(v.reason, /只往有利方向移/, '理由要说明这是棘轮，不是漏掉了');
  }
});

test('做空：止损已经在开仓价或更好时不动', () => {
  for (const currentStop of [100, 99, 95]) {
    const v = shouldMoveStopToBreakeven(base({ side: 'short', currentStop }));
    assert.equal(v.move, false, `做空且止损 ${currentStop} 已在保本或更好 —— 不该动`);
  }
});

/* -------------------------------------------------------------------------- */
/*  阈值两侧                                                                   */
/* -------------------------------------------------------------------------- */

test('浮盈刚好到阈值时动 —— 边界取"大于等于"', () => {
  const v = shouldMoveStopToBreakeven(base({ unrealizedPnlPercent: 8 }));
  assert.equal(v.move, true, '等于阈值应当触发，否则门槛的实际含义与配置不符');
});

test('浮盈差一点时不动', () => {
  const v = shouldMoveStopToBreakeven(base({ unrealizedPnlPercent: 7.99 }));
  assert.equal(v.move, false);
  assert.match(v.reason, /7\.99/, '理由里要有实际值 —— 排查时靠它');
});

test('阈值为 0 表示关闭这条规则（与其它风控字段同一约定）', () => {
  for (const triggerPercent of [0, -1]) {
    const v = shouldMoveStopToBreakeven(base({ triggerPercent, unrealizedPnlPercent: 50 }));
    assert.equal(v.move, false, `阈值 ${triggerPercent} 应当表示关闭`);
    assert.match(v.reason, /未启用/);
  }
});

/* -------------------------------------------------------------------------- */
/*  数据不完整 / 缺止损                                                        */
/* -------------------------------------------------------------------------- */

test('没有止损时不代劳 —— 那是 §2.6 的路径，不该被静默掩盖', () => {
  /*
   * 一个没有止损的杠杆仓位是**最糟的状态**，它需要一个显式的错误处理路径
   * （挂保护单，或立刻平仓）。
   *
   * 保本逻辑如果顺手替它补一个，会把"这个仓位缺止损"这个信号**掩盖掉** ——
   * 而那个信号本身才是要处理的东西。
   */
  const v = shouldMoveStopToBreakeven(base({ currentStop: null }));
  assert.equal(v.move, false);
  assert.match(v.reason, /保护单路径/, '理由要指向正确的处理路径，而不是含糊带过');
});

test('价格非法时不动，且不抛异常', () => {
  for (const bad of [
    { entryPrice: 0 },
    { entryPrice: Number.NaN },
    { markPrice: Number.NaN },
    { entryPrice: -5 },
  ]) {
    const v = shouldMoveStopToBreakeven(base(bad));
    assert.equal(v.move, false, `${JSON.stringify(bad)} 应当被拒绝`);
    assert.ok(v.reason.length > 0);
  }
});

/* -------------------------------------------------------------------------- */
/*  一律给出理由                                                               */
/* -------------------------------------------------------------------------- */

test('无论动不动都给出理由 —— 「为什么没动」同样是信息', () => {
  /*
   * 一个静默什么都不做的保护机制，操作员会以为它坏了 ——
   * 或者更糟，以为它在工作。
   */
  const cases: BreakevenInput[] = [
    base(),
    base({ unrealizedPnlPercent: 1 }),
    base({ currentStop: 101 }),
    base({ currentStop: null }),
    base({ triggerPercent: 0 }),
  ];
  for (const c of cases) {
    const v = shouldMoveStopToBreakeven(c);
    assert.ok(v.reason.length > 10, `这一组缺少可读的理由：${JSON.stringify(c)}`);
  }
});
