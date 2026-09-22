/**
 * 「待对账」这个标记什么时候该出现。
 *
 * ## 为什么值得一个用例
 *
 * 用户连着两次报到这里，两次都不是对账不够快，而是**这个标记本身在误报**：
 *
 *   · 第一次：HYPE/SOL 的止损在交易所触发了，账本因为「成交推送只当日志」
 *     还没跟上 —— 那次标记是对的（随后用 #65 修好了根因）。
 *   · 第二次：一张 **03:23:14 刚挂出的限价入场单**，因为"整本账没有持仓"
 *     被标成「已挂单（待对账）」。而限价单**在成交之前本来就没有持仓** ——
 *     那是它的正常状态。他问：「这个不是系统应该自动自主实时处理的吗？」
 *
 * 所以这里的用例钉的是**边界**：什么情况下这个警告应该出现、什么时候
 * 它只是在制造噪音。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { needsReconcileFlag } from './orderFlags';

/** 一张还挂着的委托的默认形状。 */
const open = { onlyOpen: true, stillOpen: true, purpose: 'stop_loss', positionCount: 0 };

test('★ 限价入场单还挂着时**不**标「待对账」—— 它在成交前本来就没有持仓', () => {
  assert.equal(
    needsReconcileFlag({ ...open, purpose: 'entry' }),
    false,
    '刚刚挂出的限价单没有持仓，是正常状态；标上警告会一直挂到它成交或被撤',
  );
});

test('有止损挂着、而整本账没有持仓 —— 这才该标', () => {
  // 保护单应该随持仓一起消失。它还挂着而持仓没了，就是"委托与持仓对不上"。
  assert.equal(needsReconcileFlag({ ...open, purpose: 'stop_loss' }), true);
  assert.equal(needsReconcileFlag({ ...open, purpose: 'take_profit' }), true);
  // 市价平仓单几乎瞬间成交，停在挂单状态同样不正常。
  assert.equal(needsReconcileFlag({ ...open, purpose: 'exit' }), true);
});

test('有持仓时一律不标 —— 保护单本来就该挂在那里', () => {
  for (const purpose of ['entry', 'exit', 'stop_loss', 'take_profit']) {
    assert.equal(
      needsReconcileFlag({ ...open, purpose, positionCount: 1 }),
      false,
      `有持仓时 ${purpose} 不该被标`,
    );
  }
});

test('已经终态的单、或列表里本来就混着历史单时，都不标', () => {
  assert.equal(needsReconcileFlag({ ...open, stillOpen: false }), false, '已成交/已撤的单不标');
  assert.equal(needsReconcileFlag({ ...open, onlyOpen: false }), false, '混着历史记录的列表不标');
});
