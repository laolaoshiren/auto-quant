/**
 * 毛 − 手续费 − 资金费 = 净，**在屏幕上那三个数字上也要成立**。
 *
 * ## 为什么这些用例存在
 *
 * 用户看着「历史成交」说"对不上"。他做的是最自然的一件事：把屏幕上那三个数，
 * 按屏幕上那句公式算一遍 ——
 *
 *     毛 +1.2766  ·  手续费 -0.2071  ·  资金费 -0.0092        净额 +$1.06
 *
 * 而他算出来是 1.0787，与 1.06 **差 0.0187，正好是资金费的两倍**。
 *
 * 原因是两套符号约定混在了同一行里：`PnlCosts.funding` 当时存的是交易所口径
 * （付出为**负**），而恒等式那串字符串写的是「− 资金费」。同一类错误在
 * `netPnlOf()` 里已经犯过一次（见 `binance/income.ts` 的长注释）—— 那一次让平台
 * 每轮报一条假的账目告警，而这一次让操作员怀疑整本账。
 *
 * 所以这里钉的**不是"渲染成什么字符串"**，而是那个等式：屏幕上看到的三个数字，
 * 按屏幕上看到的那句公式算，必须等于屏幕上那个净额。第一条用例用的就是实盘上
 * 真实的一行（`#102 XRPUSDT`），最后一条用的是用户截图那一刻的舰队合计。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { pnlFormulaText, statsCosts, tradeCosts } from './PnlBreakdown';

/** 屏幕上那三个数按屏幕上那句公式算出来，与净额的一致程度。 */
function identityGap(costs: { gross: number; fees: number; funding: number; net: number }): number {
  return costs.gross - costs.fees - costs.funding - costs.net;
}

test('实盘成交行：屏幕上的 毛 − 手续费 − 资金费 必须等于净额', () => {
  // 实盘 `trades` #102（XRPUSDT 13 @ 1.5130 → 1.5189，5x）：
  // 毛 +0.0767、两腿手续费 0.01380665、资金费 −0.00197379（交易所口径）、净 +0.06091956。
  const costs = tradeCosts({
    pnl: 0.0767,
    fee: 0.01380665,
    fundingFee: -0.00197379,
    netPnl: 0.06091956,
  });

  assert.equal(costs.funding, 0.00197379, '付出 0.00197379 的资金费，按"成本为正"存成正数');
  assert.ok(
    Math.abs(identityGap(costs)) < 1e-12,
    `毛 − 手续费 − 资金费 必须等于净：算出 ${costs.gross - costs.fees - costs.funding}，净额 ${costs.net}`,
  );
});

test('资金费是收入时，符号跟着翻，等式同样成立', () => {
  const costs = tradeCosts({
    pnl: -0.5,
    fee: 0.02,
    fundingFee: 0.006, // 收到
    netPnl: -0.514,
  });

  assert.equal(costs.funding, -0.006, '收到的资金费是负成本');
  assert.ok(Math.abs(identityGap(costs)) < 1e-12);
});

test('用户截图那一刻的舰队合计：三个数按公式算就是那个净额', () => {
  /*
   * 就是他看到的那一行：13 笔成交、毛 +1.2766、手续费 0.2071、资金费 -0.0092、
   * 净额 +$1.06。数字取自当时的 `trades` 行，不是编的。
   */
  const costs = statsCosts({
    realizedPnl: 1.06030779,
    grossRealizedPnl: 1.27659,
    totalFees: 0.20712065,
    totalFunding: -0.00916156,
  });

  assert.ok(
    Math.abs(identityGap(costs)) < 1e-9,
    `按公式算出来必须落在净额的舍入范围里，实际差 ${identityGap(costs)}`,
  );
  assert.equal(Number(costs.net.toFixed(2)), 1.06, '显示出来的净额就是 +1.06');
});

test('tooltip 里不得把负号留在数字里（那会与前面的减号读成双重否定）', () => {
  const costs = tradeCosts({
    pnl: 0.0767,
    fee: 0.01380665,
    fundingFee: -0.00197379,
    netPnl: 0.06091956,
  });
  const text = pnlFormulaText(costs);

  assert.ok(text.includes('− 资金费 0.0020'), `资金费要写成「− 资金费 0.0020」，实际：${text}`);
  assert.ok(!/资金费\s*-/.test(text), `负号不得留在数字里：${text}`);
  assert.ok(text.includes('毛盈亏 − 手续费 − 资金费'), `公式本身也要在：${text}`);
});
