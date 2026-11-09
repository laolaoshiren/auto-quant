/**
 * **信号健康度报告必须真的从归因数据得出结论** —— 这条测试钉住接线，而不是钉住算法。
 *
 * ## 为什么这个测试存在（2026-11-09 审计）
 *
 * `signalHealth.ts` 的 `assessSignal()` 与 `attribution.ts` 的
 * `tradesForSignal()` / `signalsWithEnoughSamples()` 从写出来那天起**只有测试引用**：
 * 生产代码里没有任何一处读 `trades.intel_keys`，所以失效检测**永远返回
 * `insufficient_data`**。代码在跑、测试全绿、日志正常 —— 它只是从未下过一次结论。
 *
 * 这里用**纯函数**（`buildSignalHealthReport()`）直接喂 fixture：
 * ① 样本不足时必须**不下结论**（`summary === null`，而不是"一切健康"）；
 * ② 样本够了就必须给出 `failed` / `decaying` / `effective` 的真实结论；
 * ③ 一笔成交引用多个信号时要分别计入、同一个键重复出现时**不能虚增样本**；
 * ④ 日志去重键只随"需要关注的部分"变化，不随每笔新成交的胜率数字变化。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { TradeIntelAttributionRow } from '../../store/repositories.js';
import { SIGNAL_LIMITS } from './signalHealth.js';
import {
  buildSignalHealthReport,
  SIGNAL_HEALTH_WINDOW_DAYS,
  signalHealthStateKey,
} from './signalHealthReport.js';

const WINDOW_START = '2025-01-01T00:00:00.000Z';

/** 造一行归因成交；`day` 只用来给 `closedAt` 一个确定、递增的时间。 */
function row(returnPct: number, intelKeys: string[], day: number): TradeIntelAttributionRow {
  return {
    intelKeys,
    returnPct,
    closedAt: new Date(Date.UTC(2026, 0, 1) + day * 86_400_000).toISOString(),
  };
}

const WIN = 0.02;
const LOSS = -0.02;

function reportOf(rows: readonly TradeIntelAttributionRow[]) {
  return buildSignalHealthReport(rows, { windowStart: WINDOW_START, generatedAt: WINDOW_START });
}

/* -------------------------------------------------------------------------- */
/*  ① 样本不足：不下结论，而不是"健康"                                            */
/* -------------------------------------------------------------------------- */

test('★★★ 样本不足时不下结论 —— summary 为 null，而不是"一切正常"', () => {
  /*
   * `assessSignal()` 的保守分支返回 `insufficient_data`，而报告层必须把它翻译成
   * **"没有结论"**（summary = null），不能翻译成"健康" —— 后者是编造（§3.2）。
   */
  const rows: TradeIntelAttributionRow[] = [];
  for (let i = 0; i < SIGNAL_LIMITS.MIN_SAMPLES - 1; i += 1) {
    rows.push(row(WIN, ['coindesk.com|bullish|BTCUSDT'], i));
  }

  const report = reportOf(rows);
  assert.equal(report.signals.length, 0, '样本不足的信号不该出现在结论列表里');
  assert.equal(report.belowSampleSignals, 1);
  assert.equal(report.summary, null, '★ 样本不足必须"没有结论"，绝不能写成"健康"');
  assert.equal(report.attributedTrades, rows.length);
});

/* -------------------------------------------------------------------------- */
/*  ② 三种真实结论                                                               */
/* -------------------------------------------------------------------------- */

test('★★★ 连续亏损到停用线 → failed（且摘要里有具体数字）', () => {
  /*
   * 20 笔盈利打底，再连续 10 笔亏损 —— `SIGNAL_LIMITS.STREAK_DISABLE` 是 10。
   * 若接线断了（assessSignal 没被调用），这里只会得到 `insufficient_data` 或
   * 一个空列表。
   */
  const rows: TradeIntelAttributionRow[] = [];
  for (let i = 0; i < 20; i += 1) rows.push(row(WIN, ['coindesk.com|bullish|BTCUSDT'], i));
  for (let i = 0; i < SIGNAL_LIMITS.STREAK_DISABLE; i += 1) {
    rows.push(row(LOSS, ['coindesk.com|bullish|BTCUSDT'], 100 + i));
  }

  const report = reportOf(rows);
  assert.equal(report.signals.length, 1);
  const verdict = report.signals[0]!.verdict;
  assert.equal(verdict.health, 'failed');
  assert.equal(verdict.losingStreak, SIGNAL_LIMITS.STREAK_DISABLE);
  assert.ok(verdict.reason.includes(String(SIGNAL_LIMITS.STREAK_DISABLE)), '结论要带具体数字');
  assert.ok(report.summary?.includes('失效'), `摘要必须报失效：${report.summary}`);
});

test('★★★ 连续亏损到降权线 → decaying', () => {
  const rows: TradeIntelAttributionRow[] = [];
  for (let i = 0; i < 14; i += 1) rows.push(row(WIN, ['coindesk.com|bullish|BTCUSDT'], i));
  for (let i = 0; i < SIGNAL_LIMITS.STREAK_REDUCE; i += 1) {
    rows.push(row(LOSS, ['coindesk.com|bullish|BTCUSDT'], 100 + i));
  }

  const report = reportOf(rows);
  assert.equal(report.signals[0]!.verdict.health, 'decaying');
  assert.ok(report.summary?.includes('衰减中'), `摘要必须报衰减：${report.summary}`);
});

test('★★ 全部盈利 → effective（这条是"真的在算"的反面证据）', () => {
  const rows: TradeIntelAttributionRow[] = [];
  for (let i = 0; i < SIGNAL_LIMITS.MIN_SAMPLES; i += 1) {
    rows.push(row(WIN, ['coindesk.com|bullish|BTCUSDT'], i));
  }

  const report = reportOf(rows);
  assert.equal(report.signals[0]!.verdict.health, 'effective');
  assert.ok(report.summary?.includes('有效'), `摘要必须报有效：${report.summary}`);
});

/* -------------------------------------------------------------------------- */
/*  ③ 归因展开：多信号分别计入、同键不虚增样本                                      */
/* -------------------------------------------------------------------------- */

test('★★★ 一笔成交引用多个信号 → 每个信号各得一个样本', () => {
  const keys = ['coindesk.com|bullish|BTCUSDT', 'reuters.com|bearish|ETHUSDT'];
  const rows: TradeIntelAttributionRow[] = [];
  for (let i = 0; i < SIGNAL_LIMITS.MIN_SAMPLES; i += 1) {
    rows.push(row(i % 2 === 0 ? WIN : LOSS, keys, i));
  }

  const report = reportOf(rows);
  assert.equal(report.signals.length, 2, '两个键都必须积累到样本');
  assert.equal(report.belowSampleSignals, 0);
  assert.equal(report.attributedTrades, rows.length, 'attributedTrades 是成交笔数，不是信号样本数');
});

test('★★★ 同一个键在一行里重复出现 → 只算一个样本（不能虚增到门槛）', () => {
  /*
   * 若不去重，10 行 × 每行把同一个键写两次 = 20 个样本 → 会提前达到
   * `MIN_SAMPLES` 并给出一个真实样本量只有 10 的"结论" —— 那是虚假的置信度。
   * 去重后 10 个样本 < 20，必须留在"样本不足"。
   */
  const key = 'coindesk.com|bullish|BTCUSDT';
  const rows: TradeIntelAttributionRow[] = [];
  for (let i = 0; i < SIGNAL_LIMITS.MIN_SAMPLES / 2; i += 1) {
    rows.push(row(WIN, [key, key], i));
  }

  const report = reportOf(rows);
  assert.equal(report.signals.length, 0, '★ 重复键不能把样本数抬到门槛以上');
  assert.equal(report.belowSampleSignals, 1);
});

/* -------------------------------------------------------------------------- */
/*  ④ 排序与日志去重键                                                            */
/* -------------------------------------------------------------------------- */

test('★★ 结论按严重程度排序：failed 在 decaying/effective 之前', () => {
  const rows: TradeIntelAttributionRow[] = [];
  /* A：20 赢 → effective。 */
  for (let i = 0; i < 20; i += 1) rows.push(row(WIN, ['good.com|bullish|BTCUSDT'], i));
  /* B：20 赢 + 10 亏 → failed。 */
  for (let i = 0; i < 20; i += 1) rows.push(row(WIN, ['bad.com|bullish|ETHUSDT'], 100 + i));
  for (let i = 0; i < 10; i += 1) rows.push(row(LOSS, ['bad.com|bullish|ETHUSDT'], 200 + i));

  const report = reportOf(rows);
  assert.equal(report.signals.length, 2);
  assert.equal(report.signals[0]!.signalKey, 'bad.com|bullish|ETHUSDT', '最严重的必须排最前');
  assert.equal(report.signals[0]!.verdict.health, 'failed');
});

test('★★★ 日志去重键只随"需要关注的部分"变化 —— 胜率数字变化不该刷屏', () => {
  /*
   * 这个键是 `emitOnChange()` 的 `stateKey`：拿 summary（含胜率/样本数）当键的话，
   * 每出现一笔新成交都会写一条日志，真正的告警会被埋掉（`emitOnChange` 的注释里
   * 记录过一次"每轮都写一条 error，上百条"的事故）。
   */
  const keyFor = (rows: readonly TradeIntelAttributionRow[]): string =>
    signalHealthStateKey(reportOf(rows));

  const base: TradeIntelAttributionRow[] = [];
  for (let i = 0; i < SIGNAL_LIMITS.MIN_SAMPLES; i += 1) {
    base.push(row(WIN, ['coindesk.com|bullish|BTCUSDT'], i));
  }
  const effective = keyFor(base);
  assert.equal(effective, 'all-effective');

  /* 再赢一笔：结论仍是 effective → 键不能变（否则又写一条日志）。 */
  const moreWins = [...base, row(WIN, ['coindesk.com|bullish|BTCUSDT'], 500)];
  assert.equal(keyFor(moreWins), effective, '★ 仅仅是样本增加不能改变去重键');

  /* 连亏 10 笔 → failed：键必须变（病情加重不能漏报）。 */
  const failing = [...base];
  for (let i = 0; i < SIGNAL_LIMITS.STREAK_DISABLE; i += 1) {
    failing.push(row(LOSS, ['coindesk.com|bullish|BTCUSDT'], 600 + i));
  }
  const failedKey = keyFor(failing);
  assert.notEqual(failedKey, effective);
  assert.ok(failedKey.includes('coindesk.com|bullish|BTCUSDT=failed'), `键应带档位：${failedKey}`);
});

/* -------------------------------------------------------------------------- */
/*  ⑤ 窗口常量                                                                    */
/* -------------------------------------------------------------------------- */

test('★ 回看窗口必须足够长到能积累 MIN_SAMPLES —— 否则失效检测永远停在 insufficient_data', () => {
  assert.ok(SIGNAL_HEALTH_WINDOW_DAYS >= 30, `窗口 ${SIGNAL_HEALTH_WINDOW_DAYS} 天太短`);
});
