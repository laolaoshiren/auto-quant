/**
 * 交易所错误码的中文翻译。
 *
 * ## 为什么这些用例存在
 *
 * 订单记录里原本直接显示原始字符串：
 *
 *     Binance -4130: An open stop or take profit order with GTC...
 *
 * **那是给开发者看的。** 操作员看到英文技术报错时，既不知道发生了什么、
 * 也不知道该不该动手 —— 而那一栏存在的唯一意义就是回答这两个问题。
 *
 * 两个方向都要钉：
 *   · **认得出的码**要翻译成人话，并且**保留原始码**（排查靠它）
 *   · **认不出的码**要原样显示，**不能猜** —— 按错误的理解去处理比不翻译更糟
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { exchangeErrorCode, exchangeErrorLabel } from './domain.js';

test('实测撞到的 -4130 被翻译成可行动的一句话', () => {
  /*
   * 这条码是这一轮从订单记录里发现的：保本止损"先挂新再撤旧"，
   * 而币安不允许同一仓位存在两张条件单 —— 于是连刷四条拒绝。
   *
   * 翻译必须说清**该怎么办**（先撤掉原来那张），而不只是说"重复了"。
   */
  const raw = "Binance -4130: An open stop or take profit order with GTC would be triggered immediately.";
  const out = exchangeErrorLabel(raw);
  assert.match(out, /已有止损或止盈单/, '要翻译成中文');
  assert.match(out, /先撤掉/, '要说清怎么办 —— 否则操作员知道发生了什么也不知道该做什么');
  assert.match(out, /-4130/, '**原始码必须保留** —— 排查与对交易所文档都要靠它');
  assert.ok(!/An open stop/.test(out), '不该把英文原文留在给操作员的文案里');
});

test('-4164（取整后名义不足）也被翻译', () => {
  const out = exchangeErrorLabel(
    "Binance -4164: Order's notional must be no smaller than 5 (unless you choose reduce only).",
  );
  assert.match(out, /名义价值/, '要说是名义价值的问题');
  assert.match(out, /-4164/);
});

test('-4061（持仓模式不匹配）也被翻译 —— 它是「整个机器人瘫持」而不是「这一笔失败」', () => {
  /*
   * 这一条原来是缺的，于是界面上显示的是交易所的英文原文：
   *
   *     ✕ 执行失败
   *     币安错误 -4061：Order's position side does not match user's setting.
   *
   * 而它比其它错误码**更**需要看懂：双向持仓模式下**连平仓单都会被拒**
   * （`reduceOnly` 不豁免 `positionSide`），所以不是"少赚一笔"，
   * 是开不了、平不了、保护位也挂不上 —— 整个机器人不动了。
   *
   * 而且**解法不在机器人这边**：它一律发 `positionSide=BOTH`，
   * 要去交易所端把持仓模式改回单向。文案必须把这一点说清楚，
   * 否则操作员会反复重启机器人而问题一直在。
   */
  const raw =
    "Binance -4061: Order's position side does not match user's setting.";
  const out = exchangeErrorLabel(raw);
  assert.match(out, /持仓模式/, '要指出是持仓模式的问题');
  assert.match(out, /单向持仓/, '要说清**改成什么** —— 这是操作员唯一要做的事');
  assert.match(out, /-4061/, '原始码必须保留');
  assert.ok(
    !/does not match/.test(out),
    '不该把英文原文留在给操作员的文案里 —— 那正是这条错误码被补上的原因',
  );
});

test('认不出的错误码**原样返回**，绝不猜', () => {  /*
   * 猜一个不认识的码的含义，比不翻译更糟：它会让操作员按错误的理解去处理，
   * 而原始字符串里其实带着交易所的完整说明。
   */
  const raw = 'Binance -9999: Something nobody has seen before.';
  assert.equal(exchangeErrorLabel(raw), raw, '认不出时必须原样返回');
});

test('不含错误码的字符串原样返回', () => {
  for (const raw of ['', '网络超时', 'fetch failed']) {
    assert.equal(exchangeErrorLabel(raw), raw);
  }
});

test('错误码提取：带与不带 Binance 前缀都能取到', () => {
  assert.equal(exchangeErrorCode('Binance -4130: x'), '-4130');
  assert.equal(exchangeErrorCode('-4164: x'), '-4164');
  assert.equal(exchangeErrorCode('没有码'), null);
});
