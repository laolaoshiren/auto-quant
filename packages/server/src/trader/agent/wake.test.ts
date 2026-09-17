/**
 * 唤醒判据与实验结算。
 *
 * ## 为什么这些用例存在
 *
 * 这一层的两个失效方式都比"多花点钱"严重，而且**都不会报错**：
 *
 * - **抖动**：每笔平仓都唤醒 —— 一串止损会唤醒五次，大脑看到同一份数据
 *   做出五次互相矛盾的调整
 * - **饿死**：事件稀疏时长时间不醒 —— 一个"每笔亏一点点、从不触发阈值"的账户
 *   会在无人审视的情况下慢慢失血
 *
 * 所以每条判据的两侧都要钉住：该醒的必须醒（否则饿死），
 * 不该醒的必须不醒（否则抖动）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { decideSettle, decideWake, DEFAULT_WAKE_POLICY, type WakeFacts } from './wake.js';

/** 一份"什么都不值得醒"的事实。 */
const quiet = (over: Partial<WakeFacts> = {}): WakeFacts => ({
  minutesSinceLastWake: 20,
  newClosedTrades: 0,
  netPnlSinceLastWake: 0,
  losingStreak: 0,
  equityDriftPercent: 0,
  rejectionsSinceLastWake: 0,
  callsThisHour: 0,
  lastDecisionWasNoChange: false,
  ...over,
});

test('平静无事时不唤醒，并说清"确实没有值得醒的事"', () => {
  const d = decideWake(quiet());
  assert.equal(d.wake, false);
  assert.equal(d.trigger, 'none');
  assert.match(d.why, /没有值得唤醒/, '理由必须说明是"查过了没事"，而不是一句空话');
});

/* -------------------------------------------------------------------------- */
/*  防抖动（约束层）                                                           */
/* -------------------------------------------------------------------------- */

test('冷却期内一律不唤醒 —— 哪怕事件很"值得"', () => {
  /*
   * 这是防抖动的核心。一串止损会在几分钟内连着触发，没有冷却的话
   * 大脑会被同一件事唤醒五次，看到同一份数据，做出五次互相矛盾的调整。
   */
  const d = decideWake(quiet({ minutesSinceLastWake: 3, losingStreak: 9, equityDriftPercent: -8 }));

  assert.equal(d.wake, false, '冷却应当压过事件');
  assert.match(d.why, /冷却/, '必须说清是被冷却挡住的 —— 否则看起来像"系统没反应"');
  assert.match(d.why, /3 分钟/, '要把实际值写进去，方便排查');
});

test('超预算时不唤醒，且理由说清是预算', () => {
  const d = decideWake(quiet({ callsThisHour: 40 }));
  assert.equal(d.wake, false);
  assert.match(d.why, /预算/);
  assert.match(d.why, /40/, '要写出上限值');
});

test('预算判据优先于冷却：两条都挡时先说预算', () => {
  /*
   * 顺序是刻意的。反过来写（先看事件再看约束）会让日志里出现
   * 「因为连亏所以醒（但被冷却挡了）」这种自相矛盾的记录。
   */
  const d = decideWake(quiet({ callsThisHour: 99, minutesSinceLastWake: 0 }));
  assert.match(d.why, /预算/);
});

/* -------------------------------------------------------------------------- */
/*  该醒的必须醒（否则饿死）                                                   */
/* -------------------------------------------------------------------------- */

test('权益显著回撤时唤醒', () => {
  const d = decideWake(quiet({ equityDriftPercent: -3.5 }));
  assert.equal(d.wake, true);
  assert.equal(d.trigger, 'drawdown');
  assert.match(d.why, /回撤/);
});

test('权益新高也唤醒 —— 仓位需要重新评估，不只是回撤才值得看', () => {
  const d = decideWake(quiet({ equityDriftPercent: 4 }));
  assert.equal(d.wake, true);
  assert.equal(d.trigger, 'drawdown');
  assert.match(d.why, /新高/, '涨上去的理由要说清是新高，不是回撤');
});

test('连亏到阈值时唤醒', () => {
  const d = decideWake(quiet({ losingStreak: 3 }));
  assert.equal(d.wake, true);
  assert.equal(d.trigger, 'losing_streak');
});

test('连亏差一笔时不唤醒（阈值两侧都要钉）', () => {
  const d = decideWake(quiet({ losingStreak: 2 }));
  assert.equal(d.wake, false, '阈值是 3，2 笔不该醒');
});

test('被风控连续拒绝时唤醒 —— 那是参数与市场脱节的信号', () => {
  const d = decideWake(quiet({ rejectionsSinceLastWake: 5 }));
  assert.equal(d.wake, true);
  assert.equal(d.trigger, 'rejections');
  assert.match(d.why, /脱节/, '要说清这个信号意味着什么');
});

test('有新平仓结果时唤醒 —— 那是唯一能产生真实反馈的事件', () => {
  const d = decideWake(quiet({ newClosedTrades: 2, netPnlSinceLastWake: 0.4 }));
  assert.equal(d.wake, true);
  assert.equal(d.trigger, 'new_result');
});

test('事件优先级：跌倒 > 连亏 > 被拒 > 新结果', () => {
  /*
   * 单笔结果的信息量最低（一笔的盈亏几乎全是噪声），而它出现的频率最高。
   * 把它排前面会让大脑每次都醒在"最不值得醒"的时刻。
   */
  const all = quiet({ equityDriftPercent: -5, losingStreak: 9, rejectionsSinceLastWake: 9, newClosedTrades: 9 });
  assert.equal(decideWake(all).trigger, 'drawdown');

  const noDrift = quiet({ losingStreak: 9, rejectionsSinceLastWake: 9, newClosedTrades: 9 });
  assert.equal(decideWake(noDrift).trigger, 'losing_streak');

  const onlyRejections = quiet({ rejectionsSinceLastWake: 9, newClosedTrades: 9 });
  assert.equal(decideWake(onlyRejections).trigger, 'rejections');

  const onlyResults = quiet({ newClosedTrades: 9 });
  assert.equal(decideWake(onlyResults).trigger, 'new_result');
});

test('兜底超时：长时间没有任何事件也要醒一次（防饿死）', () => {
  /*
   * 没有这一条，一个"每笔都亏一点点、但从不触发任何阈值"的账户会在没有人
   * 审视的情况下慢慢失血 —— 而那正是最需要有人看一眼的情形。
   */
  const d = decideWake(quiet({ minutesSinceLastWake: 61 }));
  assert.equal(d.wake, true, '兜底必须生效');
  assert.equal(d.trigger, 'timeout');
  assert.match(d.why, /无人看管|兜底/, '理由要说明这是兜底而不是因为有事件');
});

test('兜底时间没到时仍然不醒', () => {
  assert.equal(decideWake(quiet({ minutesSinceLastWake: 59 })).wake, false);
});

test('策略可以调，且默认值本身自洽（兜底 > 冷却）', () => {
  const custom = { ...DEFAULT_WAKE_POLICY, losingStreakThreshold: 1 };
  assert.equal(decideWake(quiet({ losingStreak: 1 }), custom).wake, true, '阈值可调');

  assert.ok(
    DEFAULT_WAKE_POLICY.maxIdleMinutes > DEFAULT_WAKE_POLICY.cooldownMinutes,
    '兜底时间必须大于冷却，否则冷却永远压不住兜底 —— 那会让兜底变成每冷却一次就醒一次',
  );
});

/* -------------------------------------------------------------------------- */
/*  实验结算                                                                   */
/* -------------------------------------------------------------------------- */

const experimentAt = (minutesAgo: number) => ({
  id: 1,
  createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

test('结果笔数够时才结算', () => {
  const d = decideSettle(experimentAt(30), { tradesSince: 5, netPnlSince: 0.4, nowMs: Date.now() });
  assert.equal(d.settle, true);
  assert.deepEqual(d.outcome, { trades: 5, netPnl: 0.4 });
});

test('笔数不够时不结算 —— 用一两笔判断调参是否有效是在学噪声', () => {
  /*
   * 这一条是「越跑越厉害」能不能成立的关口。
   *
   * 调参之后第一笔恰好赚钱，不代表那次调参是对的。把一两笔结算进 outcome_net_pnl，
   * 而那个数字**会被回喂给策略师当作"上次这么改的效果"** ——
   * 于是它学到的是一堆噪声，而它自己无从分辨。
   */
  const d = decideSettle(experimentAt(30), { tradesSince: 1, netPnlSince: 0.9, nowMs: Date.now() });
  assert.equal(d.settle, false);
  assert.match(d.why, /噪声/, '拒绝结算的理由要说清为什么 —— 否则看起来像"忘了结算"');
});

test('等太久时即使笔数不够也结算，但如实说明样本不足', () => {
  /*
   * 一条永远挂在待结算里的实验，比一个不精确的数字更糟：
   * 它会让策略师永远看不到"上次改动的结果"，也就永远学不到东西。
   */
  const d = decideSettle(experimentAt(25 * 60), { tradesSince: 2, netPnlSince: -0.3, nowMs: Date.now() });
  assert.equal(d.settle, true);
  assert.match(d.why, /样本不足|只有 2 笔/, '要如实说明，不能含糊成一个正常结算');
  assert.deepEqual(d.outcome, { trades: 2, netPnl: -0.3 });
});

test('结算门槛可调', () => {
  const strict = { minTrades: 20, maxWaitMinutes: 60 };
  assert.equal(
    decideSettle(experimentAt(30), { tradesSince: 10, netPnlSince: 0, nowMs: Date.now() }, strict).settle,
    false,
  );
  assert.equal(
    decideSettle(experimentAt(30), { tradesSince: 20, netPnlSince: 0, nowMs: Date.now() }, strict).settle,
    true,
  );
});
