/**
 * 舰队合计：共享钱包的**本金只能算一次**。
 *
 * ## 为什么这些用例存在（这个模块存在的全部理由）
 *
 * 实盘上量到的数字就在 `fleetTotals.ts` 的文件头里，三个机器人共用同一个交易所账户：
 *
 *     #4 测试机器人1    初始  9.9865   本机器人净盈亏 0.000000  → 归属权益  9.9865
 *     #5 测试2          初始  9.9865   本机器人净盈亏 0.437526  → 归属权益 10.4240
 *     #6 实盘3小时验证  初始 10.2586   本机器人净盈亏 0.000000  → 归属权益 10.2586
 *     ─────────────────────────────────────────────────────────────────────────
 *     Σ 归属权益 = 30.6690      Σ 初始权益 = 30.2316      账户里实际只有 10.4180
 *
 * 控制台于是显示「总归属权益 30.67 USDT / 初始投入 $30.23」—— **约为真实资金的 3 倍**，
 * 而 `30.2316 − 10.4180 = 19.81` **就是被数了三遍的那笔本金**（三个机器人各自都
 * 带着同一份起始资金，而钱包只有一个）。
 *
 * 所以这里钉的**不是"函数返回什么"**，而是两个口径不能混：
 *
 *   · **账户里的钱** —— 每个账户只算一次（共享钱包下数一遍就够）
 *   · **机器人各自的净盈亏** —— 可加（每个机器人只认自己挂过的订单，`AGENTS.md` §2.3）
 *
 * `attributedEquitySum` 保留在结构里**只为说明"它不等于账户里的钱"**，
 * 而下面有一条用例专门钉住这一点 —— 否则它迟早会被某个页面当成余额。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { EquitySnapshot, TraderStats } from '@aq/shared';

import { committedCapitalOf, fleetTotals, groupTradersByAccount } from './fleetTotals';
import type { TraderRow } from './api';

/* -------------------------------------------------------------------------- */
/*  夹具                                                                       */
/* -------------------------------------------------------------------------- */

const trader = (over: Partial<TraderRow> & Pick<TraderRow, 'id'>): TraderRow =>
  ({
    name: `t${over.id}`,
    exchangeAccountId: 1,
    aiModelId: 1,
    strategyId: 1,
    cycleIntervalMinutes: 15,
    initialEquity: 10,
    status: 'stopped',
    lastCycleAt: null,
    lastCycleNumber: 0,
    lastError: null,
    consecutiveFailures: 0,
    agentConfigJson: null,
    mode: 'strategy',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    isRunning: false,
    ...over,
  }) as TraderRow;

const stats = (over: Partial<TraderStats> = {}): TraderStats =>
  ({
    traderId: 1,
    equity: 10,
    initialEquity: 10,
    totalReturnPercent: 0,
    realizedPnl: 0,
    grossRealizedPnl: 0,
    totalFees: 0,
    totalFunding: 0,
    unrealizedPnl: 0,
    accountEquity: 0,
    totalTrades: 0,
    winRatePercent: 0,
    wins: 0,
    losses: 0,
    profitFactor: 0,
    avgWin: 0,
    avgLoss: 0,
    maxDrawdownPercent: 0,
    sharpeRatio: null,
    bestTrade: 0,
    worstTrade: 0,
    openPositions: 0,
    cyclesRun: 0,
    uptimeHours: 0,
    ...over,
  }) as TraderStats;

const snapshot = (timestamp: string, accountEquity: number): EquitySnapshot =>
  ({ timestamp, accountEquity, equity: accountEquity, accountUnrealizedPnl: 0, unrealizedPnl: 0, openPositions: 0 }) as EquitySnapshot;

/** 实盘上那三个共用账户的机器人 —— 文件头里的真实数字。 */
const REAL_THREE = [
  trader({ id: 4, initialEquity: 9.9865, createdAt: '2026-09-15T15:55:03.000Z' }),
  trader({ id: 5, initialEquity: 9.9865, createdAt: '2026-09-15T22:30:00.000Z' }),
  trader({ id: 6, initialEquity: 10.2586, createdAt: '2026-09-16T01:00:00.000Z' }),
];

/* -------------------------------------------------------------------------- */
/*  分组与本金                                                                 */
/* -------------------------------------------------------------------------- */

test('按交易所账户分组 —— 这是"账户里的钱"必须过的第一道门', () => {
  const groups = groupTradersByAccount([
    trader({ id: 1, exchangeAccountId: 1 }),
    trader({ id: 2, exchangeAccountId: 1 }),
    trader({ id: 3, exchangeAccountId: 2 }),
  ]);
  assert.equal(groups.size, 2);
  assert.deepEqual(groups.get(1)?.map((t) => t.id), [1, 2]);
  assert.deepEqual(groups.get(2)?.map((t) => t.id), [3]);
});

test('本金取"最早创建"的那一个，不是求和 —— 求和就是 19.81 那个 bug', () => {
  const group = [
    trader({ id: 5, initialEquity: 9.9865, createdAt: '2026-09-15T22:30:00.000Z' }),
    trader({ id: 4, initialEquity: 9.9865, createdAt: '2026-09-15T15:55:03.000Z' }),
    trader({ id: 6, initialEquity: 10.2586, createdAt: '2026-09-16T01:00:00.000Z' }),
  ];
  // 传入顺序被打乱，答案仍必须是最早那个（#4）的本金。
  assert.equal(committedCapitalOf(group), 9.9865);
  // 明确钉住"不是这三个的和" —— 那正是 bug 的形状。
  assert.notEqual(committedCapitalOf(group), 9.9865 + 9.9865 + 10.2586);
});

test('同一时刻创建时按 id 决胜 —— 顺序不确定不能让本金跟着抖', () => {
  const group = [
    trader({ id: 9, initialEquity: 50, createdAt: '2026-09-15T00:00:00.000Z' }),
    trader({ id: 7, initialEquity: 20, createdAt: '2026-09-15T00:00:00.000Z' }),
  ];
  assert.equal(committedCapitalOf(group), 20, '同一时刻应按 id 最小的那个');
});

test('最早那个读不到本金（余额读数失败）时退回组内最大正值，而不是 0', () => {
  /*
   * 退回 0 会让收益率除零、或者凭空变成无限大 —— 而 `EquitySource: 'unavailable'`
   * 在早期行里真的出现过（建号时余额没读回来）。
   */
  const group = [
    trader({ id: 1, initialEquity: 0, createdAt: '2026-09-15T00:00:00.000Z' }),
    trader({ id: 2, initialEquity: 12.5, createdAt: '2026-09-16T00:00:00.000Z' }),
    trader({ id: 3, initialEquity: 8, createdAt: '2026-09-17T00:00:00.000Z' }),
  ];
  assert.equal(committedCapitalOf(group), 12.5);
});

test('全都没有本金时返回 0（页面据此显示 — ，而不是"账户是空的"）', () => {
  assert.equal(committedCapitalOf([trader({ id: 1, initialEquity: 0 })]), 0);
  assert.equal(committedCapitalOf([]), 0);
});

/* -------------------------------------------------------------------------- */
/*  合计：两个口径                                                             */
/* -------------------------------------------------------------------------- */

test('★ 共享同一个钱包：本金只算一次，归属权益之和不得当成余额', () => {
  /*
   * 这是整个模块的存在理由，用实盘量到的数字直接钉住。
   */
  const totals = fleetTotals({
    traders: REAL_THREE,
    stats: {
      4: stats({ equity: 9.9865, realizedPnl: 0, accountEquity: 10.418 }),
      5: stats({ equity: 10.424, realizedPnl: 0.437526, accountEquity: 10.418 }),
      6: stats({ equity: 10.2586, realizedPnl: 0, accountEquity: 10.418 }),
    },
  });

  // 只有一个账户，所以合计应当等于该账户那一条。
  assert.equal(totals.accounts.length, 1);
  assert.equal(totals.byTrader[5]?.exchangeAccountId, 1);

  // 本金：**9.9865，不是 30.2316**。这 20.245 的差额就是那个 bug。
  assert.equal(totals.committedCapitalFleet, 9.9865);

  // 归属权益之和仍然是 30.669 —— 保留它只为说明"它不等于账户里的钱"。
  assert.ok(
    Math.abs(totals.attributedEquitySumFleet - 30.669) < 0.001,
    `Σ归属权益应为 30.669，实际 ${totals.attributedEquitySumFleet}`,
  );

  // 而账户里的钱来自 `accountEquity` 读数：**不是 30.67**。
  assert.ok(
    Math.abs(totals.accountEquityFleet - 10.418) < 0.001,
    `账户口径应为 10.418，实际 ${totals.accountEquityFleet}`,
  );

  /*
   * ★ 关键断言：两个口径**必须不同**。
   * 如果哪天有人把 `accountEquityFleet` 改成 `attributedEquitySumFleet`，
   * 上面两条会同时成立（都是 30.669）—— 所以这一条单独把它钉死。
   */
  assert.notEqual(
    totals.accountEquityFleet,
    totals.attributedEquitySumFleet,
    '账户口径与归属口径被混成了一个 —— 那正是 3 倍那个 bug',
  );

  // 已实现盈亏是**可加**的，与账户口径无关。
  assert.ok(Math.abs(totals.realizedPnlFleet - 0.437526) < 1e-9);
});

test('不同账户是本金各自算一次、可以相加 —— 那才是对的', () => {
  const totals = fleetTotals({
    traders: [
      trader({ id: 1, exchangeAccountId: 1, initialEquity: 10, createdAt: '2026-09-15T00:00:00.000Z' }),
      trader({ id: 2, exchangeAccountId: 2, initialEquity: 25, createdAt: '2026-09-15T00:00:00.000Z' }),
    ],
    stats: {
      1: stats({ equity: 10, realizedPnl: 1, accountEquity: 11 }),
      2: stats({ equity: 25, realizedPnl: -2, accountEquity: 23 }),
    },
  });
  assert.equal(totals.accounts.length, 2);
  assert.equal(totals.committedCapitalFleet, 35, '两个钱包的本金本来就该相加');
  assert.equal(totals.accountEquityFleet, 34);
  assert.equal(totals.realizedPnlFleet, -1);
});

test('总收益率用**账户口径**：本金为 0 时是 0，不是 NaN / Infinity', () => {
  const zero = fleetTotals({ traders: [trader({ id: 1, initialEquity: 0 })], stats: {} });
  assert.equal(zero.accountReturnPercent, 0);
  assert.ok(Number.isFinite(zero.accountReturnPercent), '本金为 0 时不能算出 Infinity');

  const normal = fleetTotals({
    traders: [trader({ id: 1, initialEquity: 100 })],
    stats: { 1: stats({ equity: 110, accountEquity: 110, realizedPnl: 10 }) },
  });
  assert.equal(normal.accountReturnPercent, 10);
});

/* -------------------------------------------------------------------------- */
/*  账户权益的三个来源                                                         */
/* -------------------------------------------------------------------------- */

test('账户权益优先用**最新**的快照读数 —— 不是最早、也不是最大值', () => {
  /*
   * 取最大值在账户亏损时会把旧的高点当成当前的钱；取最早会显示接入时的余额。
   */
  const totals = fleetTotals({
    traders: [trader({ id: 1, initialEquity: 10 })],
    stats: { 1: stats({ accountEquity: 999 }) },
    snapshots: {
      1: [
        snapshot('2026-09-16T00:00:00.000Z', 20),
        snapshot('2026-09-18T00:00:00.000Z', 13), // 最新，但比 20 小 —— 必须是它
        snapshot('2026-09-17T00:00:00.000Z', 17),
      ],
    },
  });
  assert.equal(totals.accounts[0]?.accountEquity, 13);
  assert.equal(totals.accounts[0]?.equitySource, 'snapshot');
});

test('accountEquity 为 0 的快照是"没读到"，不能把账户拉到底', () => {
  const totals = fleetTotals({
    traders: [trader({ id: 1, initialEquity: 10 })],
    stats: { 1: stats({ accountEquity: 12 }) },
    snapshots: { 1: [snapshot('2026-09-18T00:00:00.000Z', 0), snapshot('2026-09-17T00:00:00.000Z', 12)] },
  });
  assert.equal(totals.accounts[0]?.accountEquity, 12);
});

test('没有快照时退回 stats 的 accountEquity', () => {
  const totals = fleetTotals({
    traders: [trader({ id: 1, initialEquity: 10 })],
    stats: { 1: stats({ accountEquity: 12.5 }) },
  });
  assert.equal(totals.accounts[0]?.accountEquity, 12.5);
  assert.equal(totals.accounts[0]?.equitySource, 'stats');
});

test('两边都没有时用「本金 + Σ净盈亏 + Σ浮盈」推算 —— 本金只取一次', () => {
  const totals = fleetTotals({
    traders: [
      trader({ id: 1, initialEquity: 10, createdAt: '2026-09-15T00:00:00.000Z' }),
      trader({ id: 2, initialEquity: 10, createdAt: '2026-09-16T00:00:00.000Z' }),
    ],
    stats: { 1: stats({ realizedPnl: 1, unrealizedPnl: 0.5 }), 2: stats({ realizedPnl: 2, unrealizedPnl: -0.5 }) },
  });
  const account = totals.accounts[0];
  assert.equal(account?.equitySource, 'derived');
  // 10 + (1+2) + (0.5-0.5) = 13 —— 本金 10 只加了一次（不是 20）。
  assert.equal(account?.accountEquity, 13);
});

test('连本金都没有时标记为 capital，页面据此显示 — 而不是"账户是空的"', () => {
  const totals = fleetTotals({ traders: [trader({ id: 1, initialEquity: 0 })], stats: {} });
  assert.equal(totals.accounts[0]?.equitySource, 'capital');
  assert.equal(totals.accounts[0]?.accountEquity, 0);
});

/* -------------------------------------------------------------------------- */
/*  空与部分输入                                                               */
/* -------------------------------------------------------------------------- */

test('没有机器人时不崩，且每个合计都是 0', () => {
  const totals = fleetTotals({ traders: [], stats: {} });
  assert.deepEqual(totals.accounts, []);
  assert.equal(totals.accountEquityFleet, 0);
  assert.equal(totals.committedCapitalFleet, 0);
  assert.equal(totals.accountReturnPercent, 0);
  assert.equal(totals.traderCount, 0);
  assert.equal(totals.tradersWithStats, 0);
});

test('统计还没回来时，归属权益退回该机器人的初始权益 —— 第一帧不该读成 0', () => {
  const totals = fleetTotals({
    traders: [trader({ id: 1, initialEquity: 9.5, exchangeAccountId: 1 })],
    stats: {},
    snapshots: { 1: [snapshot('2026-09-18T00:00:00.000Z', 11)] },
  });
  assert.equal(totals.tradersWithStats, 0, '没有任何统计回来');
  assert.equal(totals.attributedEquitySumFleet, 9.5, '退回初始权益，而不是 0');
  assert.equal(totals.accountEquityFleet, 11, '账户读数仍然可用');
});
