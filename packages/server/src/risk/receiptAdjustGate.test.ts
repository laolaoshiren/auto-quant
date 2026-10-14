/**
 * **执行回执那一轮的 `adjust_protection` 必须过风控引擎**（外部 issue #117）。
 *
 * ## 缺陷形状
 *
 * `autoTrader.ts` 的 `followUpAfterExecution()`（执行回执）里：
 *
 * ```ts
 * for (const decision of parsed.decisions) {
 *   if (isAdjustAction(decision.action)) {
 *     followed.push(await this.executeAdjust(decision));   // ← 没有 risk.review()
 *   }
 * ```
 *
 * 而主决策路径（`runCycle`）是：
 *
 * ```ts
 * const verdict = this.risk.review(gatedDecisions, { … });
 * for (const decision of verdict.approved) { … }
 * ```
 *
 * 也就是说：**回执这一轮的 `adjust_protection` 从未经过风控**。
 *
 * ## 为什么这条特别要紧
 *
 * `RiskEngine.reviewAdjust()` 对 `adjust_protection` 有两条**别的层都没有**的校验 ——
 * 棘轮（ratchet）：
 *
 * ```
 *   多头止损只能往上移（往下 = 主动扩大风险）
 *   空头止损只能往下移
 * ```
 *
 * 它保护的是**已经锁到的浮盈**。允许反向移动意味着模型一句话就能把
 * 靠 `applyBreakevenGuard` / 移动止损攒下来的保护**放松掉**。
 *
 * 而回执这一轮恰恰是"模型刚看完成交回报、情绪与上下文最浓"的时刻
 *（`followUpAfterExecution` 自己的注释写了这一点），也是**唯一能改动
 * 止损止盈的两条路之一** —— 它绕过了唯一一道方向校验。
 *
 * 另外 `executeAdjust()` 内部**不记账 `adjustments`**，所以事后审计里
 * 看不出"风控曾经钳制过它" —— 违反 README 的「每一次钳制都留下记录」。
 *
 * ## 测试分两半
 *
 * 1. **风控确实有这道校验**（用真实 `RiskEngine` 跑，钉住棘轮语义）；
 * 2. **回执路径确实接上了它**（源码结构断言 —— `followUpAfterExecution` 里
 *    调 `executeAdjust` 之前必须先过 `risk.review`）。
 *
 * 第 2 半必须是结构断言：`followUpAfterExecution` 要真实模型客户端、
 * 交易所、持仓仓储才能驱动，而起半套桩去测"接线"会让被测的变成桩
 *（与 `trader/startCancellation.test.ts`、`api/traderStatsNotFound.test.ts` 同一判断）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  defaultStrategyConfig,
  type Decision,
  type MarketSnapshot,
  type PositionView,
} from '@aq/shared';
import { RiskEngine, type RiskEnvironment } from './engine.js';

const SRC = readFileSync(new URL('../trader/autoTrader.ts', import.meta.url), 'utf8');

/* -------------------------------------------------------------------------- */
/*  ① 风控确实有这道校验（真实引擎）                                             */
/* -------------------------------------------------------------------------- */

const engine = new RiskEngine();

function snap(symbol: string, price: number): MarketSnapshot {
  return {
    symbol,
    sources: ['static'],
    price,
    quoteVolume24h: 1_000_000_000,
    priceChangePercent24h: 1,
    high24h: price * 1.02,
    low24h: price * 0.98,
    primary: { timeframe: '5m', klines: [], closes: [price], volumes: [1], ema: {}, rsi: {}, atr: {}, macd: null },
    isMajor: symbol === 'BTCUSDT',
    timeframes: [],
  } as unknown as MarketSnapshot;
}

function longPosition(stopLoss: number): PositionView {
  return {
    id: 1,
    traderId: 1,
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 0.1,
    entryPrice: 68_000,
    leverage: 5,
    liquidationPrice: 55_000,
    marginUsed: 100,
    peakPnlPercent: 5,
    stopLoss,
    takeProfit: null,
    stopOrderId: null,
    tpOrderId: null,
    openReasoning: '',
    openedAt: new Date().toISOString(),
    status: 'open',
    realizedPartialPnl: 0,
    bookedPartialQty: 0,
  } as unknown as PositionView;
}

function adjustDecision(stopLoss: number): Decision {
  return {
    symbol: 'BTCUSDT',
    action: 'adjust_protection',
    leverage: 5,
    positionSizeUsd: 0,
    stopLoss,
    takeProfit: null,
    confidence: 90,
    riskUsd: 0,
    reasoning: 'test',
    reducePercent: null,
    reduceQuantity: null,
    setupScore: null,
    setupScoreBasis: '',
    adjustments: [],
  } as unknown as Decision;
}

function env(config = defaultStrategyConfig()): RiskEnvironment {
  return {
    config,
    account: { equity: 1000, availableBalance: 900, marginUsed: 100, positionCount: 1 },
    positions: new Map([['BTCUSDT', longPosition(67_000)]]),
    snapshots: new Map([['BTCUSDT', snap('BTCUSDT', 69_000)]]),
    minNotionalOf: () => 5,
    quantityFor: (_s: string, notionalUsd: number, price: number) =>
      Math.floor((notionalUsd / price) * 1e6) / 1e6,
    quantityUpFor: (_s: string, q: number) => (Math.floor(q * 1e6 + 1e-6) + 1) / 1e6,
    entriesThisCycle: 0,
    entriesLastHour: 0,
  } as unknown as RiskEnvironment;
}

test('★★★ 风控对"放松止损"确实有棘轮校验 —— 这是回执路径绕过的正是它', () => {
  /* 多头止损往下移（67_000 → 66_000）= 放松保护 → 必须拒。 */
  const down = engine.review([adjustDecision(66_000)], env());
  assert.equal(down.approved.length, 0, '★ 多头止损往下移必须被拒');
  assert.match(down.rejected[0]!.reason, /多头止损只能往上移/, '★ 拒绝理由要指明方向');

  /* 往上移（67_000 → 68_000）= 收紧保护 → 放行。 */
  const up = engine.review([adjustDecision(68_000)], env());
  assert.equal(up.approved.length, 1, '★ 多头止损往上移是收紧，必须放行');
});

test('★★ 空头是镜像的 —— 棘轮方向相反', () => {
  const shortEnv = {
    ...env(),
    positions: new Map([['BTCUSDT', { ...longPosition(71_000), side: 'short' as const }]]),
  } as unknown as RiskEnvironment;

  /* 空头止损往下移 = 收紧 → 放行。 */
  assert.equal(engine.review([adjustDecision(70_000)], shortEnv).approved.length, 1, '★ 空头往下是收紧');
  /* 空头止损往上移 = 放松 → 拒。 */
  const up = engine.review([adjustDecision(72_000)], shortEnv);
  assert.equal(up.approved.length, 0, '★ 空头止损往上移必须被拒');
  assert.match(up.rejected[0]!.reason, /空头止损只能往下移/);
});

/* -------------------------------------------------------------------------- */
/*  ② 回执路径确实接上了它（源码结构）                                           */
/* -------------------------------------------------------------------------- */

/** 剥掉行注释后匹配 —— 本仓库注释会逐字引用被讨论的代码。 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
}

test('★★★ 执行回执里的 adjust_protection 必须先过 risk.review（issue #117）', () => {
  /*
   * 取 `followUpAfterExecution` 的方法体（到下一个同级方法声明为止）。
   */
  const start = SRC.indexOf('private async followUpAfterExecution(');
  assert.ok(start > 0, '找不到 `followUpAfterExecution` —— 结构变了，请更新本测试');
  const nextMethod = SRC.indexOf('\n  private ', start + 10);
  const body = stripComments(SRC.slice(start, nextMethod > 0 ? nextMethod : SRC.length));

  const adjustIdx = body.indexOf('this.executeAdjust(decision)');
  assert.ok(adjustIdx > 0, '找不到 `executeAdjust(decision)` 调用');

  const reviewIdx = body.indexOf('this.risk.review(');
  assert.ok(
    reviewIdx > 0,
    '★★★ 回执这一轮必须先过 `this.risk.review(...)` 才能执行 `adjust_protection`。\n' +
      '    否则模型可以把已锁的浮盈保护**放松**（棘轮校验是唯一拦它的地方），\n' +
      '    而 `executeAdjust` 内部不做方向判断、也不记 `adjustments`（issue #117）。',
  );
  assert.ok(
    reviewIdx < adjustIdx,
    '★★★ `risk.review` 必须在 `executeAdjust` **之前** —— 放后面等于先执行再审查',
  );
});

test('★★★ 回执提示词不能说"这两个动作只降低风险" —— adjust_protection 可以放松', () => {
  /*
   * ⚠️ 原来的提示词写「只能用这两个动作（**它们只降低风险**，所以这一轮不再走
   * 那批开仓上限）」—— 这句话**对 adjust_protection 是错的**：
   * 把多头止损往下挪就是**扩大风险**。
   *
   * 提示词向模型承诺了一件代码不保证的事，而模型据此认为"我怎么改都安全"。
   */
  const start = SRC.indexOf('## 你现在可以做什么');
  assert.ok(start > 0, '找不到那段提示词');
  const block = stripComments(SRC.slice(start, start + 900));

  const mentionsRisk = /只降低风险|只减风险/.test(block);
  assert.equal(
    mentionsRisk,
    false,
    '★★★ 提示词不能笼统说"这两个动作只降低风险" —— `adjust_protection` 可以放松止损；\n' +
      '    而模型据此会以为"我怎么改都安全"。应当说清"放松保护位的方向会被风控拒绝"。',
  );
});
