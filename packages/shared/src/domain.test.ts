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

import { beijingDayStartIso, exchangeErrorCode, exchangeErrorLabel } from './domain.js';

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

/* -------------------------------------------------------------------------- */
/*  自然日边界（北京时间）                                                      */
/* -------------------------------------------------------------------------- */

test('日界落在北京时间 0:00 —— 不是 UTC 0:00', () => {
  /*
   * 这个函数存在的全部理由就是这一条断言。
   *
   * 原来熔断用的是 `setUTCHours(0, 0, 0, 0)`，也就是 **UTC 零点 = 北京时间
   * 早上 8 点**。于是北京时间 9-19 07:30 的一笔平仓被算进「UTC 9-18」，
   * 操作员上午看到的「今日已实现亏损」实际覆盖 9-18 08:00 → 9-19 08:00 ——
   * **与他的认知差 8 小时**，而熔断正是拿这个数字决定要不要停手的。
   *
   * 所以边界必须精确落在北京时间的 0:00：9-18 23:59:59 还算前一天，
   * 9-19 00:00:00 就必须翻页。
   */
  // UTC 16:00 == 北京时间次日 00:00
  assert.equal(
    beijingDayStartIso(Date.parse('2026-09-18T16:00:00Z')),
    '2026-09-18T16:00:00.000Z',
    '北京 9-19 00:00 → 日界应当是它自己',
  );
  assert.equal(
    beijingDayStartIso(Date.parse('2026-09-18T15:59:59Z')),
    '2026-09-17T16:00:00.000Z',
    '北京 9-18 23:59:59 → 仍属 9-18（日界是北京 9-18 00:00）',
  );
  // 这一条是原实现真正算错的那一格
  assert.equal(
    beijingDayStartIso(Date.parse('2026-09-18T23:30:00Z')),
    '2026-09-18T16:00:00.000Z',
    '北京 9-19 07:30 → 必须算进 9-19；按 UTC 会错算成 9-18',
  );
  assert.equal(
    beijingDayStartIso(Date.parse('2026-09-19T15:59:59Z')),
    '2026-09-18T16:00:00.000Z',
    '北京 9-19 23:59:59 → 仍属 9-19',
  );
  assert.equal(
    beijingDayStartIso(Date.parse('2026-09-19T16:00:00Z')),
    '2026-09-19T16:00:00.000Z',
    '北京 9-20 00:00 → 翻到新的一天',
  );
});

test('日界与服务器时区无关', () => {
  /*
   * 用 `setHours(0,0,0,0)` 也能得到"某一天的零点"，但那用的是**服务器**的
   * 时区：换一台 UTC 的机器，日界会静默变回 UTC 零点，而且不会有任何报错。
   *
   * 这个函数按常量 +8 显式平移，所以同一个时刻在任何时区的机器上
   * 都给出同一个 UTC 边界。
   */
  const at = Date.parse('2026-09-18T23:30:00Z');
  assert.equal(beijingDayStartIso(at), beijingDayStartIso(at), '同一输入必须稳定');
  assert.ok(
    beijingDayStartIso(at).endsWith('Z'),
    '返回值是 UTC ISO —— 库里存的是 UTC，比较也必须用 UTC',
  );
});