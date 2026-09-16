import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultStrategyConfig,
  type Decision,
  type MarketSnapshot,
  type PositionView,
  type StrategyConfig,
} from '@aq/shared';
import {
  RiskEngine,
  checkCircuitBreakers,
  shouldCloseForDrawdown,
  type RiskEnvironment,
} from './engine.js';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function configWith(patch: Partial<StrategyConfig>): StrategyConfig {
  return { ...defaultStrategyConfig(), ...patch };
}

/** A minimal but complete market snapshot priced at `price`. */
function snapshot(symbol: string, price: number): MarketSnapshot {
  return {
    symbol,
    sources: ['static'],
    price,
    quoteVolume24h: 1_000_000_000,
    priceChangePercent24h: 1,
    high24h: price * 1.02,
    low24h: price * 0.98,
    primary: {
      timeframe: '5m',
      klines: [],
      closes: [price],
      volumes: [1],
      ema: {},
      rsi: {},
      atr: {},
      macd: null,
    },
    isMajor: symbol === 'BTCUSDT' || symbol === 'ETHUSDT',
    timeframes: [],
    derivatives: {
      openInterest: null,
      openInterestUsd: null,
      openInterestAvg: null,
      openInterestChangePercent: {},
      fundingRate: null,
      nextFundingTime: null,
      markPrice: price,
      indexPrice: price,
    },
    quant: null,
  };
}

/**
 * A long at 68 000 with a stop 2 000 below and a target 6 000 above.
 *
 * The 1:3 reward:risk is deliberate: the default strategy enforces a 1:3 floor,
 * so a fixture that did not clear it would be rejected before the behaviour
 * under test was ever reached.
 */
function openDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    symbol: 'BTCUSDT',
    action: 'open_long',
    leverage: 5,
    positionSizeUsd: 500,
    stopLoss: 66_000,
    takeProfit: 74_000,
    confidence: 90,
    riskUsd: 20,
    reasoning: 'test',
    adjustments: [],
    ...overrides,
  };
}

function position(overrides: Partial<PositionView> = {}): PositionView {
  return {
    id: 1,
    traderId: 1,
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 0.01,
    entryPrice: 68_000,
    markPrice: 69_000,
    leverage: 5,
    liquidationPrice: 55_000,
    unrealizedPnl: 10,
    unrealizedPnlPercent: 1.47,
    peakPnlPercent: 2,
    marginUsed: 136,
    notional: 690,
    stopLoss: 64_000,
    takeProfit: 72_000,
    openedAt: new Date(Date.now() - 3_600_000).toISOString(),
    openReasoning: 'test',
    ...overrides,
  };
}

function environment(overrides: Partial<RiskEnvironment> = {}): RiskEnvironment {
  const symbol = 'BTCUSDT';
  return {
    config: defaultStrategyConfig(),
    account: { equity: 1000, availableBalance: 900, marginUsed: 0, positionCount: 0 },
    positions: new Map(),
    snapshots: new Map([[symbol, snapshot(symbol, 68_000)]]),
    minNotionalOf: () => 5,
    /**
     * Mirrors `SymbolRegistry.notionalToQuantity`, which **floors** to the
     * exchange lot step. Flooring matters: rounding to nearest could leave the
     * final notional marginally *above* the risk cap, which is the one direction
     * a cap must never leak in.
     */
    quantityFor: (_symbol, notionalUsd, price) => Math.floor((notionalUsd / price) * 1e6) / 1e6,
    entriesThisCycle: 0,
    entriesLastHour: 0,
    ...overrides,
  };
}

const engine = new RiskEngine();

/* -------------------------------------------------------------------------- */
/*  Confidence                                                                 */
/* -------------------------------------------------------------------------- */

test('rejects an entry below the confidence floor', () => {
  const config = configWith({});
  const verdict = engine.review([openDecision({ confidence: 10 })], environment({ config }));
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /置信度 10/);
});

/* -------------------------------------------------------------------------- */
/*  Leverage                                                                   */
/* -------------------------------------------------------------------------- */

test('clamps altcoin leverage to the altcoin cap, not the BTC/ETH cap', () => {
  const config = configWith({
    riskControl: {
      ...defaultStrategyConfig().riskControl,
      btcEthMaxLeverage: 20,
      altcoinMaxLeverage: 3,
    },
  });
  const symbol = 'SOLUSDT';
  const env = environment({
    config,
    snapshots: new Map([[symbol, snapshot(symbol, 150)]]),
  });
  const verdict = engine.review(
    [openDecision({ symbol, leverage: 50, positionSizeUsd: 500, stopLoss: 130, takeProfit: 250 })],
    env,
  );
  assert.equal(verdict.approved.length, 1);
  assert.equal(verdict.approved[0]!.leverage, 3);
  assert.match(verdict.approved[0]!.adjustments.join(' '), /杠杆已从 50x 压到上限 3x/);
});

test('applies default leverage when the model omits it', () => {
  const config = configWith({
    riskControl: { ...defaultStrategyConfig().riskControl, defaultLeverage: 4 },
  });
  const verdict = engine.review(
    [openDecision({ leverage: 0 })],
    environment({ config }),
  );
  assert.equal(verdict.approved[0]!.leverage, 4);
  assert.match(verdict.approved[0]!.adjustments.join(' '), /模型未给出杠杆/);
});

/* -------------------------------------------------------------------------- */
/*  Stop loss and take profit                                                  */
/* -------------------------------------------------------------------------- */

test('applies fallback protection when the model omits both', () => {
  const config = configWith({
    riskControl: {
      ...defaultStrategyConfig().riskControl,
      fallbackStopLossPercent: 2,
      fallbackTakeProfitPercent: 8,
    },
  });
  const verdict = engine.review(
    [openDecision({ stopLoss: null, takeProfit: null })],
    environment({ config }),
  );
  assert.equal(verdict.approved.length, 1);
  const decision = verdict.approved[0]!;
  assert.ok(decision.stopLoss! < 68_000, 'fallback stop must sit below the entry for a long');
  assert.ok(decision.takeProfit! > 68_000, 'fallback target must sit above the entry for a long');
  assert.match(decision.adjustments.join(' '), /模型未给出止损/);
  assert.match(decision.adjustments.join(' '), /模型未给出止盈/);
});

test('rejects a long whose stop is above the current price', () => {
  const verdict = engine.review(
    [openDecision({ stopLoss: 70_000, takeProfit: 80_000 })],
    environment(),
  );
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /多头止损无效/);
});

test('rejects a short whose target is above the current price', () => {
  const verdict = engine.review(
    [openDecision({ action: 'open_short', stopLoss: 72_000, takeProfit: 75_000 })],
    environment(),
  );
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /空头止盈无效/);
});

/* -------------------------------------------------------------------------- */
/*  手续费感知的止损门槛（提案 §5）                                              */
/* -------------------------------------------------------------------------- */

test('rejects an entry whose stop is closer than K times the round-trip fee', () => {
  /*
   * Why this test exists —— 这就是 §5 要挡的那类交易：**盈亏比达标但仍然必亏**。
   *
   * 下面这个多头"看起来没问题"：置信度 90、仓位 500、盈亏比刚好 1:3（止损 136 点、
   * 止盈 408 点），旧风控的每一条都会放行。但止损只有 0.20%，而实测往返手续费是名义
   * 价值的 0.10% —— 价格必须先走完 0.1% 的成本才开始挣钱，而止损在 0.2% 就被扫掉。
   * 止损幅度等于手续费时，胜率再高也只是在给交易所打工。
   *
   * 两件事一并钉住：
   *   1. 它必须被拒，且理由里带具体数字（§5.4：`杠杆超限` 那种话没有用）；
   *   2. 拒绝必须来自**这条**校验，而不是盈亏比 —— 理由里出现「盈亏比」会让操作者
   *      以为把盈亏比调低就能做，方向完全反了。
   */
  const config = configWith({
    riskControl: { ...defaultStrategyConfig().riskControl, minStopLossFeeMultiple: 3 },
  });
  const verdict = engine.review(
    [openDecision({ stopLoss: 67_864, takeProfit: 68_408 })],
    environment({ config, roundTripFeeRate: 0.001 }),
  );

  assert.equal(verdict.approved.length, 0, '止损比往返成本还近的交易不得被放行');
  const reason = verdict.rejected[0]!.reason;
  assert.match(reason, /往返手续费/);
  assert.match(reason, /0\.200%/, '拒绝理由要带上这一笔真实的止损幅度');
  assert.match(reason, /0\.3000%/, '拒绝理由要带上这个费率下允许的最小止损幅度');
  assert.doesNotMatch(reason, /盈亏比/, '这条校验排在盈亏比之前，理由是止损距离本身');
});

test('a stop exactly K times the round-trip fee is allowed, and the check is recorded', () => {
  /*
   * "至少 K 倍"要按字面执行：止损幅度**恰好**等于 K × 往返成本时必须通过。
   *
   * 边界不能凭感觉收紧：0.30% 正是这个费率下允许的最小止损，而它也是
   * `npm run sim` 里脚本化模型用的那一档。把边界判死会让门槛比它宣称的更严，
   * 操作者按提示词里的数字去做反而被拒 —— 那比没有这条规则更糟。
   */
  const config = configWith({
    riskControl: { ...defaultStrategyConfig().riskControl, minStopLossFeeMultiple: 3 },
  });
  // 68000 → 67796 是 0.300%；止盈 68612 是 0.900%，盈亏比 1:3。
  const verdict = engine.review(
    [openDecision({ stopLoss: 67_796, takeProfit: 68_612 })],
    environment({ config, roundTripFeeRate: 0.001 }),
  );

  assert.equal(verdict.approved.length, 1, `正好卡在门槛上的止损必须通过：${verdict.rejected[0]?.reason ?? ''}`);
  assert.match(
    verdict.approved[0]!.adjustments.join(' '),
    /止损距离 0\.300% ≥ 往返成本 0\.1000% 的 3 倍/,
    '每一次运行时的判断都要留在 adjustments 里，操作者才看得出这条校验跑过',
  );
});

test('falls back to the configured fee rate while the account has no fills yet', () => {
  /*
   * 一个刚建的机器人还没有任何成交，`trades.performanceSince()` 给不出实测费率
   * （它回 null，而不是编一个数）。此时必须用配置里的兜底费率：这道门槛最需要生效的
   * 时刻，恰恰是账户还没有任何反馈、模型最容易开始高频试错的时候。
   */
  const config = configWith({
    riskControl: {
      ...defaultStrategyConfig().riskControl,
      fallbackRoundTripFeeRate: 0.002,
      minStopLossFeeMultiple: 3,
    },
  });
  // 兜底 0.20% × 3 = 0.60%；这里的止损只有 0.40%（68000 → 67728）。
  const verdict = engine.review(
    [openDecision({ stopLoss: 67_728, takeProfit: 70_000 })],
    environment({ config }),
  );

  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /配置的兜底费率/);
  assert.match(verdict.rejected[0]!.reason, /0\.6000%/);
});

test('a stop far wider than the fee floor is untouched', () => {
  /*
   * 反方向也要钉住：这条门槛不能把正常交易一起拒掉。
   *
   * 默认策略的兜底止损是 2.5%（手续费的 25 倍），下面这个 fixture 是 2.94% ——
   * 它必须原样通过，否则"新增一条校验"就变成了"顺手改了所有交易的入场条件"。
   */
  const verdict = engine.review([openDecision()], environment());
  assert.equal(verdict.approved.length, 1);
});

/* -------------------------------------------------------------------------- */
/*  Reward / risk                                                             */
/* -------------------------------------------------------------------------- */

test('rejects a setup whose reward:risk is below the floor', () => {
  const config = configWith({
    riskControl: { ...defaultStrategyConfig().riskControl, minRiskRewardRatio: 3 },
  });
  // Risk 1000 (68000→67000), reward 500 (68000→68500) => 1:0.5, far below 1:3.
  const verdict = engine.review(
    [openDecision({ stopLoss: 67_000, takeProfit: 68_500 })],
    environment({ config }),
  );
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /盈亏比 1:0.50/);
});

/* -------------------------------------------------------------------------- */
/*  Position sizing                                                            */
/* -------------------------------------------------------------------------- */

test('caps notional at the BTC/ETH position-value ratio', () => {
  const config = configWith({
    riskControl: {
      ...defaultStrategyConfig().riskControl,
      btcEthMaxPositionValueRatio: 2,
    },
  });
  // Equity 1000 => cap 2000, but 5000 requested.
  const verdict = engine.review(
    [openDecision({ positionSizeUsd: 5_000 })],
    environment({ config }),
  );
  assert.equal(verdict.approved.length, 1);
  assert.ok(verdict.approved[0]!.positionSizeUsd <= 2000 + 1e-6);
  assert.match(verdict.approved[0]!.adjustments.join(' '), /上限为权益的 2 倍/);
});

test('uses the tighter altcoin ratio for a non-major symbol', () => {
  const config = configWith({
    riskControl: {
      ...defaultStrategyConfig().riskControl,
      btcEthMaxPositionValueRatio: 10,
      altcoinMaxPositionValueRatio: 0.5,
    },
  });
  const symbol = 'SOLUSDT';
  const verdict = engine.review(
    [openDecision({ symbol, positionSizeUsd: 5_000, stopLoss: 130, takeProfit: 250 })],
    environment({ config, snapshots: new Map([[symbol, snapshot(symbol, 150)]]) }),
  );
  assert.ok(verdict.approved[0]!.positionSizeUsd <= 500 + 1e-6);
});

test('rejects a position that rounds below the minimum notional', () => {
  const config = configWith({
    riskControl: { ...defaultStrategyConfig().riskControl, minPositionSize: 100 },
  });
  const verdict = engine.review(
    [openDecision({ positionSizeUsd: 10 })],
    environment({ config }),
  );
  // The ratio cap does not block it; the minimum does.
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /低于最低要求/);
});

test('shrinks the notional to fit the available margin', () => {
  const config = configWith({
    riskControl: {
      ...defaultStrategyConfig().riskControl,
      btcEthMaxLeverage: 10,
      btcEthMaxPositionValueRatio: 50,
      maxMarginUsage: 100,
    },
  });
  // Only 50 USDT of margin is available, at 10x that is 500 USDT of notional.
  const verdict = engine.review(
    [openDecision({ positionSizeUsd: 9_000, leverage: 10 })],
    environment({
      config,
      account: { equity: 1000, availableBalance: 50, marginUsed: 950, positionCount: 0 },
    }),
  );
  assert.equal(verdict.approved.length, 1);
  assert.ok(verdict.approved[0]!.positionSizeUsd <= 500 + 1e-6);
  assert.match(verdict.approved[0]!.adjustments.join(' '), /以适配可用保证金/);
});

test('derives the notional from the stated risk budget', () => {
  const config = configWith({
    riskControl: {
      ...defaultStrategyConfig().riskControl,
      btcEthMaxPositionValueRatio: 50,
      maxMarginUsage: 100,
    },
  });
  // Risk 68 USDT with a 680-wide stop (68000→67320) => 0.1 units => 6800 notional.
  const verdict = engine.review(
    [openDecision({ positionSizeUsd: 0, riskUsd: 68, stopLoss: 67_320, takeProfit: 75_000 })],
    environment({
      config,
      account: { equity: 10_000, availableBalance: 10_000, marginUsed: 0, positionCount: 0 },
    }),
  );
  assert.equal(verdict.approved.length, 1);
  assert.match(verdict.approved[0]!.adjustments.join(' '), /按模型给出的风险金额/);
  assert.ok(
    verdict.approved[0]!.positionSizeUsd > 6000,
    `expected ~6800 notional, got ${verdict.approved[0]!.positionSizeUsd}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  Slots and throttles                                                        */
/* -------------------------------------------------------------------------- */

test('refuses a new position once maxPositions is reached', () => {
  const config = configWith({
    riskControl: { ...defaultStrategyConfig().riskControl, maxPositions: 1 },
  });
  const verdict = engine.review(
    [openDecision()],
    environment({ config, account: { equity: 1000, availableBalance: 900, marginUsed: 0, positionCount: 1 } }),
  );
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /已达最大同时持仓数/);
});

test('enforces the per-cycle entry throttle', () => {
  const config = configWith({
    throttle: { ...defaultStrategyConfig().throttle, maxEntriesPerCycle: 1 },
  });
  const verdict = engine.review([openDecision()], environment({ config, entriesThisCycle: 1 }));
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /本周期已开/);
});

test('enforces the hourly entry throttle', () => {
  const config = configWith({
    throttle: { ...defaultStrategyConfig().throttle, maxEntriesPerHour: 2 },
  });
  const verdict = engine.review([openDecision()], environment({ config, entriesLastHour: 2 }));
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /最近一小时内已开/);
});

test('a second open in the same batch sees the first one\'s margin consumption', () => {
  const config = configWith({
    riskControl: {
      ...defaultStrategyConfig().riskControl,
      btcEthMaxLeverage: 5,
      btcEthMaxPositionValueRatio: 50,
      maxPositions: 5,
      maxMarginUsage: 100,
      minPositionSize: 5,
    },
    throttle: { ...defaultStrategyConfig().throttle, maxEntriesPerCycle: 5, maxEntriesPerHour: 5 },
  });
  // 100 USDT of free margin at 5x supports 500 of notional in total.
  const verdict = engine.review(
    [
      openDecision({ symbol: 'BTCUSDT', positionSizeUsd: 400 }),
      openDecision({ symbol: 'ETHUSDT', positionSizeUsd: 400, stopLoss: 2_400, takeProfit: 2_800 }),
    ],
    environment({
      config,
      account: { equity: 1000, availableBalance: 100, marginUsed: 900, positionCount: 0 },
      snapshots: new Map([
        ['BTCUSDT', snapshot('BTCUSDT', 68_000)],
        ['ETHUSDT', snapshot('ETHUSDT', 2_500)],
      ]),
    }),
  );
  assert.equal(verdict.approved.length, 2);
  const totalNotional = verdict.approved.reduce((sum, d) => sum + d.positionSizeUsd, 0);
  assert.ok(totalNotional <= 500 + 1, `combined notional ${totalNotional} must fit the 500 budget`);
});

/* -------------------------------------------------------------------------- */
/*  Closes                                                                     */
/* -------------------------------------------------------------------------- */

test('blocks a close before the minimum hold time has elapsed', () => {
  const config = configWith({
    throttle: { ...defaultStrategyConfig().throttle, minHoldMinutes: 30 },
  });
  const verdict = engine.review(
    [openDecision({ action: 'close_long' })],
    environment({
      config,
      positions: new Map([['BTCUSDT', position({ openedAt: new Date(Date.now() - 60_000).toISOString() })]]),
    }),
  );
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /未满足最小持仓时间/);
});

test('allows a close once the hold time has elapsed', () => {
  const config = configWith({
    throttle: { ...defaultStrategyConfig().throttle, minHoldMinutes: 30 },
  });
  const verdict = engine.review(
    [openDecision({ action: 'close_long' })],
    environment({
      config,
      positions: new Map([['BTCUSDT', position({ openedAt: new Date(Date.now() - 3_600_000).toISOString() })]]),
    }),
  );
  assert.equal(verdict.approved.length, 1);
});

test('rejects a close for a symbol with no position', () => {
  const verdict = engine.review([openDecision({ action: 'close_short' })], environment());
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /没有可平仓的持仓/);
});

test('executes closes before opens regardless of input order', () => {
  const config = configWith({
    throttle: { ...defaultStrategyConfig().throttle, maxEntriesPerCycle: 1, minHoldMinutes: 0, maxEntriesPerHour: 5 },
  });
  const verdict = engine.review(
    [openDecision({ action: 'open_long' }), openDecision({ action: 'close_long' })],
    environment({ config, positions: new Map([['BTCUSDT', position()]]) }),
  );
  assert.equal(verdict.approved[0]!.action, 'close_long');
});

/* -------------------------------------------------------------------------- */
/*  Drawdown guard                                                             */
/* -------------------------------------------------------------------------- */

test('drawdown guard is inert below its activation threshold', () => {
  const config = defaultStrategyConfig();
  const verdict = shouldCloseForDrawdown(
    position({ peakPnlPercent: 0.5, unrealizedPnlPercent: 0.1 }),
    config,
  );
  assert.equal(verdict.close, false);
});

test('drawdown guard closes once enough of the peak has been given back', () => {
  const config = configWith({
    drawdownGuard: { enabled: true, activationPercent: 1, givebackRatio: 0.5 },
  });
  // Peaked at 4%, now at 1.5% => gave back 62.5% of the peak.
  const verdict = shouldCloseForDrawdown(
    position({ peakPnlPercent: 4, unrealizedPnlPercent: 1.5 }),
    config,
  );
  assert.equal(verdict.close, true);
  assert.match(verdict.reason, /已回吐峰值的/);
});

test('drawdown guard tolerates a small giveback', () => {
  const config = configWith({
    drawdownGuard: { enabled: true, activationPercent: 1, givebackRatio: 0.5 },
  });
  // Peaked at 4%, now at 3% => gave back 25%.
  const verdict = shouldCloseForDrawdown(
    position({ peakPnlPercent: 4, unrealizedPnlPercent: 3 }),
    config,
  );
  assert.equal(verdict.close, false);
});

test('drawdown guard closes a position that peaked then turned negative', () => {
  const config = configWith({
    drawdownGuard: { enabled: true, activationPercent: 1, givebackRatio: 0.5 },
  });
  const verdict = shouldCloseForDrawdown(
    position({ peakPnlPercent: 3, unrealizedPnlPercent: -0.4 }),
    config,
  );
  assert.equal(verdict.close, true);
});

/* -------------------------------------------------------------------------- */
/*  Circuit breakers                                                           */
/* -------------------------------------------------------------------------- */

test('total-drawdown breaker blocks new entries below the high-water mark', () => {
  const config = configWith({
    circuitBreaker: { ...defaultStrategyConfig().circuitBreaker, maxTotalDrawdownPercent: 10 },
  });
  const verdict = checkCircuitBreakers(config, 850, { dailyRealizedPnl: 0, highWaterEquity: 1000 });
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /总回撤熔断/);
});

test('daily-loss breaker blocks once the day\'s realised loss is too large', () => {
  const config = configWith({
    circuitBreaker: { ...defaultStrategyConfig().circuitBreaker, maxDailyLossPercent: 3 },
  });
  const verdict = checkCircuitBreakers(config, 1000, { dailyRealizedPnl: -40, highWaterEquity: 1000 });
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /单日亏损熔断/);
});

test('breakers stay clear when neither condition is met', () => {
  const config = defaultStrategyConfig();
  const verdict = checkCircuitBreakers(config, 1010, { dailyRealizedPnl: 5, highWaterEquity: 1000 });
  assert.equal(verdict.blocked, false);
});
