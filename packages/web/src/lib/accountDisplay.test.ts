import { test } from 'node:test';
import assert from 'node:assert/strict';

import { displayAvailable, displayMarginUsed, type AccountDisplayInput } from './accountDisplay';

/**
 * 2026-10-04 用户报的两个 BUG —— 它们其实是同一个：
 *
 * > 「明明现在没有持仓和挂单，但是居然显示：保证金占用（USDT）23.63」
 * > 「可用 74.57，和交易所里面实际的也对不上」
 *
 * 一张卡上主数字来自**停止前的账户快照**（当时还持有两笔），
 * 副行"当前无持仓"来自**实时持仓** —— 两个时效混在一起。
 */

/** 事故现场：快照是"还持有两笔仓"时留下的，而实时已经空仓。 */
const SCENE: AccountDisplayInput = {
  liveUnavailable: false,
  positionCount: 0,
  openOrderCount: 0,
  snapshotMarginUsed: 23.63,
  snapshotAvailableBalance: 74.57,
  walletBalance: 97.94,
};

test('★ 空仓时，保证金占用必须是 0 —— 不能显示停止前快照里的 23.63', () => {
  assert.equal(
    displayMarginUsed(SCENE),
    0,
    '★ 没有持仓、没有挂单 ⇒ 占用必然是 0（那是这个量的定义推出来的，不是估计）',
  );
});

test('★ 空仓时，可用余额等于钱包 —— 不能显示快照里的 74.57', () => {
  /* 会计恒等式：可用 = 钱包 − 占用；占用为 0 ⇒ 可用 = 钱包 = 97.94。 */
  assert.equal(displayAvailable(SCENE), 97.94, '★ 空仓时可用应当等于钱包余额');
});

test('⚠️ 只判"没有持仓"不够 —— 光有挂单也占着保证金（2026-09-29 踩过）', () => {
  /*
   * 那次现场：两笔限价挂单在手，卡片显示「保证金占用 10.24 / 当前无持仓」。
   * 若不看挂单就推算成 0，会把真实的占用抹掉 —— 那比显示陈旧值更危险。
   */
  const pendingOnly: AccountDisplayInput = {
    ...SCENE,
    positionCount: 0,
    openOrderCount: 2, // ← 有挂单
  };
  assert.equal(
    displayMarginUsed(pendingOnly),
    23.63,
    '★ 有挂单时不能推算成 0 —— 要退回账户快照的权威值',
  );
  assert.equal(displayAvailable(pendingOnly), 74.57, '有挂单时可用也不是钱包');
});

test('有持仓时照常用账户快照 —— 推算只在"真的什么都没有"时生效', () => {
  const holding: AccountDisplayInput = { ...SCENE, positionCount: 1 };
  assert.equal(displayMarginUsed(holding), 23.63);
  assert.equal(displayAvailable(holding), 74.57);
});

test('★ 读不到时给 null（界面显示 —），绝不给 0 —— "不知道"不是"零"', () => {
  const unreadable: AccountDisplayInput = { ...SCENE, liveUnavailable: true };
  assert.equal(
    displayMarginUsed(unreadable),
    null,
    '★ 机器人停止/交易所读不到时，`0` 会被读成"我问过了，是零"',
  );
  assert.equal(displayAvailable(unreadable), null);
});

test('快照自己缺少字段时给 null，而不是编一个 0', () => {
  /* 有持仓时占用来自快照 —— 快照没这个数就给 `null`（界面 `—`）。 */
  assert.equal(
    displayMarginUsed({ ...SCENE, positionCount: 1, snapshotMarginUsed: null }),
    null,
    '有持仓时快照缺这个字段 ⇒ 我们不知道 ⇒ `—`，不是 0',
  );
  /* 有持仓时可用同样来自快照。 */
  assert.equal(
    displayAvailable({ ...SCENE, positionCount: 1, snapshotAvailableBalance: null }),
    null,
  );
  /* 空仓时可用是【钱包】—— 所以那时缺的是钱包，缺了就还是 `—`。 */
  assert.equal(
    displayAvailable({ ...SCENE, walletBalance: null }),
    null,
    '空仓时可用要拿钱包来推算；钱包也缺就仍然是"不知道"',
  );
});
