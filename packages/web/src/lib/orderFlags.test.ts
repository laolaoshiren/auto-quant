/**
 * 这条"读数可能对不上"的标记什么时候该出现。
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
 *   · 第三次（2026-10-17 · `ORD-01` / 用户实测 `U-3`）：**模拟盘**的保护单
 *     100% 命中 —— 模拟盘的订单永远不出现在交易所，那个"持仓数"恒为 0。
 *     于是屏幕上又出现了「已挂单（待对账）」，而用户早就说过
 *     **这个术语不该出现在网站上**。
 *
 * 所以这里的用例钉的是**边界**：什么情况下该提醒、什么时候它只是在制造噪音，
 * 以及**它出现在屏幕上的哪一部分**（`title` 而不是状态词）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { needsReconcileFlag, reconcileNoteTitle } from './orderFlags';

/** 一张还挂着的委托的默认形状（**实盘** —— 模拟盘由下面的专门用例覆盖）。 */
const open = { onlyOpen: true, stillOpen: true, purpose: 'stop_loss', positionCount: 0, paper: false };

test('★ 限价入场单还挂着时**不**标 —— 它在成交前本来就没有持仓', () => {
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

test('★★★ 模拟盘一律不标 —— 交易所永远不会确认它的委托（用户实测 U-3 的正根）', () => {
  /*
   * 模拟盘的订单从不出现在交易所（`broker.ts` 的 `simulateStandard`），
   * 所以"本地有挂单、交易所对不上"这个判据**问的是一个不存在的问题**：
   * 每一张保护单都会被判成对不上。这是用户在控制台上看到的那个术语的来源。
   *
   * ⚠️ 这条判据要能**改坏后变红**：把 `orderFlags.ts` 里的 `if (input.paper) return false;`
   * 删掉，这里就红（下面四条覆盖了三种用途 + 一个"看起来最可疑"的组合）。
   */
  for (const purpose of ['entry', 'exit', 'stop_loss', 'take_profit']) {
    assert.equal(
      needsReconcileFlag({ ...open, paper: true, purpose }),
      false,
      `模拟盘上 ${purpose} 不该被标：交易所侧根本没有这张单的读数`,
    );
  }
  assert.equal(
    needsReconcileFlag({ ...open, paper: true, purpose: 'stop_loss', positionCount: 0 }),
    false,
    '这正是模拟盘 100% 命中的形状（保护单 + 本地持仓读数恒为 0）',
  );
});

test('★★ 给操作员看的那句话里**不许出现**「待对账」这个术语', () => {
  /*
   * `ORD-01` 的第 1 条验收：状态列不再渲染这个内部术语。
   * 术语允许活在代码标识符里（`needsReconcileFlag`），但**不允许**出现在
   * 任何给用户看的字符串里 —— 这条用例盯的就是那句话。
   *
   * ⚠️ 负向校准：把 `reconcileNoteTitle` 的返回值改成含「待对账」的文案，这里立刻红。
   */
  const title = reconcileNoteTitle('NEW');
  assert.ok(!title.includes('待对账'), `这句话里不能出现内部术语：${title}`);
  assert.ok(title.includes('NEW'), '它必须把交易所给的那个状态说出来');
  assert.ok(/对账会确认/.test(title), '它必须说清"谁去弄明白"（服务端对账，不需要操作员动手）');
});
