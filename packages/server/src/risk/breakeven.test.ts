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
  /*
   * `0` = 只保本、不追踪 —— **这是这个文件的既有语义**。
   *
   * 下面那些用例钉的是"方向"与"棘轮"两件事，它们在纯保本模式下就该成立，
   * 所以默认关掉追踪，免得新参数悄悄改变它们的含义。
   * 追踪本身另有一组用例（见 `trace` 那一段）。
   */
  trailPercent: 0,
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

/* -------------------------------------------------------------------------- */
/*  追踪止损（trailPercent）                                                    */
/* -------------------------------------------------------------------------- */

/*
 * ## 为什么这一组用例存在
 *
 * 只保本的止损停在**开仓价**，锁不住任何利润。实测那 12 笔"保本离场"：
 *
 *     峰值浮盈合计 52.3%  →  最终落袋 38.2%     回吐 14.1 个百分点（27%）
 *     #113 NEARUSDT  峰值 5.81% → 最终 2.40%
 *     #132 XRPUSDT   峰值 6.44% → 最终 3.63%
 *
 * 而同期唯一一笔真正止盈的单赚了 +0.7204，**比 21 笔止损加起来还多 3.4 倍**。
 * 用户的原话是「**这不是白玩吗**」。
 *
 * 追踪止损要把"峰值到成本价之间那段敞口"关掉。下面钉三件事：
 *   ① 做多时**只上移**、做空时**只下移**（方向）
 *   ② 至少保本（不能为了追踪把止损放到亏损侧）
 *   ③ 价格回落时**不回退**（棘轮 —— 这靠"与现有止损取更有利者"实现）
 */

test('追踪（做多）：止损跟到"价格回撤 trail%"的位置，且至少保本', () => {
  const v = shouldMoveStopToBreakeven(
    base({ entryPrice: 100, currentStop: 99, markPrice: 110, unrealizedPnlPercent: 20, triggerPercent: 8, trailPercent: 2 }),
  );
  assert.equal(v.move, true);
  /* 110 × (1 − 2%) = 107.8 —— 高于开仓价 100，所以取它。 */
  assert.equal(v.newStop, 107.8, '止损应当跟到 107.8，而不是停在开仓价 100');
  assert.match(v.reason, /107\.8/, '理由里要写出实际移到哪');
});

test('追踪（做多）：价格还没走远时，追踪值低于开仓价 → 仍取开仓价（至少保本）', () => {
  /*
   * 100.5 × (1 − 2%) = 98.49 < 开仓价 100。
   *
   * 这时**必须**取开仓价 —— 否则"追踪"会把止损放到亏损侧，
   * 那比不追踪危险得多（等于主动拉近爆仓距离）。
   */
  const v = shouldMoveStopToBreakeven(
    base({ entryPrice: 100, currentStop: 97, markPrice: 100.5, unrealizedPnlPercent: 8, triggerPercent: 8, trailPercent: 2 }),
  );
  assert.equal(v.move, true);
  assert.equal(v.newStop, 100, '追踪值低于开仓价时必须回落到开仓价 —— 至少保本');
});

test('追踪（做空）：方向必须相反 —— 止损往下跟，且不高于开仓价', () => {
  const v = shouldMoveStopToBreakeven(
    base({
      side: 'short',
      entryPrice: 100,
      currentStop: 101,
      markPrice: 90,
      unrealizedPnlPercent: 20,
      triggerPercent: 8,
      trailPercent: 2,
    }),
  );
  assert.equal(v.move, true);
  /* 90 × (1 + 2%) = 91.8 —— 低于开仓价 100，取它。 */
  assert.equal(v.newStop, 91.8, '做空的追踪止损应当在价格上方 2%，即 91.8');
});

test('追踪：价格回落时不回退（棘轮）—— 候选值变小了，但现有止损更有利，所以不动', () => {
  /*
   * 这是追踪止损最容易写错的地方：如果每轮都无条件用 `价格 ∓ trail%` 覆盖，
   * 那么价格一回落，止损就跟着退回去 —— **看起来在追踪，其实什么都没锁住**。
   */
  const v = shouldMoveStopToBreakeven(
    base({
      entryPrice: 100,
      currentStop: 107.8, // 上一轮已经跟到的位置
      markPrice: 105, // 价格回落了
      unrealizedPnlPercent: 12,
      triggerPercent: 8,
      trailPercent: 2,
    }),
  );
  assert.equal(v.move, false, '★ 候选值 102.9 不比现有止损 107.8 有利 —— 绝不能回退');
  assert.match(v.reason, /只往有利方向移/, '理由要说清为什么没动');
});

test('追踪距离非法（≥100 或负数）：回退到纯保本，绝不照单全收', () => {
  /*
   * `trailPercent = 150` 会让候选止损落到价格另一侧（做多时是负数）——
   * 那是比"不追踪"危险得多的错。所以非法值回退成 0（纯保本），而不是照用。
   */
  for (const bad of [150, -3, Number.NaN]) {
    const v = shouldMoveStopToBreakeven(
      base({ entryPrice: 100, currentStop: 98, markPrice: 110, unrealizedPnlPercent: 20, triggerPercent: 8, trailPercent: bad }),
    );
    assert.equal(v.move, true, `trailPercent=${String(bad)} 应当仍能保本`);
    assert.equal(v.newStop, 100, `trailPercent=${String(bad)} 必须回退到开仓价 100，而不是照用非法距离`);
  }
});

test('trailPercent = 0：退回旧的纯保本行为（向后兼容）', () => {
  const v = shouldMoveStopToBreakeven(
    base({ entryPrice: 100, currentStop: 98, markPrice: 110, unrealizedPnlPercent: 20, triggerPercent: 8, trailPercent: 0 }),
  );
  assert.equal(v.move, true);
  assert.equal(v.newStop, 100, '0 表示不追踪 —— 止损停在开仓价');
});
