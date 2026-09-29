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
reducePercent: null,
reduceQuantity: null,
    setupScore: null,
    setupScoreBasis: '',
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
    /**
     * Mirrors `SymbolRegistry.roundQuantityUp` —— 与 `quantityFor` 相反的那个方向。
     *
     * 引擎只在"向下取整掉到最低名义之下"时才用它，而且进位后的名义还要过
     * 名义比例上限与保证金上限两道检查（见 `reviewOpen` 第 12 步）。
     */
    quantityUpFor: (_symbol, quantity) => (Math.floor(quantity * 1e6 + 1e-6) + 1) / 1e6,
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

test('★ 向下取整掉到最低名义之下时，上取一档而不是直接拒', () => {
  /*
   * Why this test exists —— 用户的原话：
   *
   *   「⚠ 被风控拒绝：取整后的数量（0.007）价值 $19.47，低于最低要求 $20.00。
   *     仅仅差了 0.53，这是不是模型计算问题？这种系统是否给一定容错帮他补齐？
   *     （不然导致错失机会？）」
   *
   * 那一笔是真实的：ETHUSDT 报 $22.00 名义、价格 2768.18、交易所 `stepSize` 0.001
   * —— `$22 / 2768.18 = 0.007947`，向下取整 **0.007 = $19.47**，差 $0.53 没够到
   * 门槛；而**上取一档 0.008 = $22.15**，只比模型要的多 0.7%。
   *
   * 这个用例把那笔交易原样复现（步长 0.001、价格 2768.18、名义 $22、门槛 $20）。
   * 注意测试默认的 `quantityFor` 步长是 1e-6，**太细**，进位永远不生效 ——
   * 所以这里显式换成 0.001，否则用例会"通过"却什么都没测到。
   */
  const symbol = 'ETHUSDT';
  const price = 2768.18;
  const step = 0.001;
  const config = configWith({
    riskControl: { ...defaultStrategyConfig().riskControl, minPositionSize: 20 },
  });
  const verdict = engine.review(
    [
      openDecision({
        symbol,
        positionSizeUsd: 22,
        /*
         * 止损放宽到 0.5%（2768.18 → 2754.34）：截图里那笔用的是 2764（0.151%），
         * 而**这个仓库另有一条独立的规则**会因此拒绝它（止损距离必须 ≥ 往返成本的
         * 3 倍）—— 那条规则与本次要测的"取整方向"是两件事，混在一起就测不到重点。
         */
        stopLoss: price * 0.995,
        takeProfit: 2833,
      }),
    ],
    environment({
      config,
      snapshots: new Map([[symbol, snapshot(symbol, price)]]),
      quantityFor: (_s, notionalUsd, p) => Math.floor(notionalUsd / p / step) * step,
      quantityUpFor: (_s, q) => (Math.floor(Math.round(q / step) + 1e-9) + 1) * step,
    }),
  );

  assert.equal(
    verdict.approved.length,
    1,
    `这一笔应当被放行，实际被拒的理由：${JSON.stringify(verdict.rejected.map((r) => r.reason))}`,
  );
  const approved = verdict.approved[0]!;
  assert.ok(
    Math.abs(approved.positionSizeUsd - 0.008 * price) < 1e-6,
    `期望上取一档到 0.008（$${(0.008 * price).toFixed(2)}），实际 $${approved.positionSizeUsd.toFixed(2)}`,
  );
  assert.match(
    approved.adjustments.join('；'),
    /上取一档/,
    '进位这件事必须写进 adjustments —— 否则账上多出来的那点名义没有出处',
  );
});

test('★ 向上取一档也会越界时，理由必须说清「不存在合规数量」', () => {
  /*
   * 用户的原话：
   *   「连续两次被风控（同一个币种），AI 好像没有记忆？
   *     头一次知道了低于最低要求 $20.00 为什么第二次还是犯错？」
   *
   * 实盘那一对（周期 #233，两次）：BNBUSDT、报 $21.00、价格 785.34、
   * `stepSize` 0.01、门槛 **$20**（交易所对该标的的最小名义，比配置里的
   * `minPositionSize: 12` 更高）、名义上限 **$21.97**（权益 21.97 × 比例 1）——
   *
   *     向下取整 0.02 → $15.71   < 门槛            ✗
   *     上取一档 0.03 → $23.56   > 名义上限 $21.97  ✗
   *
   * **这个标的在那个账户规模下不存在任何合规数量。**
   *
   * 而原来的理由只有前半句（"取整后低于最低要求"），模型读到的是
   * "再提一点名义就行" —— 它照做了（$21 已经贴着上限），当然还是被拒。
   * **差距不在它的记忆**（拒绝理由是通过执行回执回传给它的），
   * 而在理由里**没有它能采取的行动**。
   *
   * 契约：理由必须说明进位也试过了、越的是哪个界，并给出"这个标的做不了"的结论。
   */
  const symbol = 'BNBUSDT';
  const price = 785.34;
  const step = 0.01;
  const config = configWith({
    riskControl: {
      ...defaultStrategyConfig().riskControl,
      minPositionSize: 20,
      altcoinMaxPositionValueRatio: 1,
    },
  });
  const verdict = engine.review(
    [
      openDecision({
        symbol,
        positionSizeUsd: 21,
        stopLoss: price * 0.99,
        takeProfit: price * 1.03,
      }),
    ],
    environment({
      config,
      account: { equity: 21.97, availableBalance: 21.97, marginUsed: 0, positionCount: 0 },
      snapshots: new Map([[symbol, snapshot(symbol, price)]]),
      quantityFor: (_s, notionalUsd, p) => Math.floor(notionalUsd / p / step) * step,
      quantityUpFor: (_s, q) => (Math.floor(Math.round(q / step) + 1e-9) + 1) * step,
    }),
  );

  assert.equal(verdict.approved.length, 0, '那一笔确实开不出来');
  const reason = verdict.rejected[0]!.reason;
  assert.match(reason, /上一档/, '必须说清"进位也试过了"，否则模型只会继续加大名义');
  assert.match(reason, /会超过/, '必须说清它越的是哪一个界');
  assert.match(reason, /不存在任何合规的数量/, '必须给出"这个标的做不了"的结论，而不是只报前半句');
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
  assert.equal(verdict.kind, 'none');
});

test('★ 两种熔断必须报告不同的 kind —— 它们的解除方式完全不同', () => {
  /*
   * 实测代价：一个被**总回撤**熔断的机器人，连续 15 个周期每一轮都在
   * `executionLog` 里写着「熔断按单日结算，跨过零点后自动恢复」。
   *
   * 而总回撤熔断**没有"按日"这个概念** —— 它比较的是历史最高水位与当前权益，
   * 要等权益涨回门槛以内才解除。**空仓时权益不会自己变化，所以它永远不会恢复。**
   *
   * 那句错误的信息会让操作员**安心地不去处理**。所以判定结果必须能区分两者，
   * 调用方才有机会给出正确的解除条件。
   */
  const config = configWith({
    circuitBreaker: {
      ...defaultStrategyConfig().circuitBreaker,
      maxTotalDrawdownPercent: 20,
      maxDailyLossPercent: 5,
    },
  });

  // 总回撤：权益较峰值跌了 21%，但当日没有已实现亏损
  const total = checkCircuitBreakers(config, 790, { dailyRealizedPnl: 0, highWaterEquity: 1000 });
  assert.equal(total.blocked, true);
  assert.equal(total.kind, 'total_drawdown');

  // 单日亏损：距峰值只有 1%（没触发总回撤），但当日已实现亏损 6%
  const daily = checkCircuitBreakers(config, 990, { dailyRealizedPnl: -60, highWaterEquity: 1000 });
  assert.equal(daily.blocked, true);
  assert.equal(daily.kind, 'daily_loss');

  /*
   * ★ 关键断言：两者**必须不同**。如果哪天有人把 kind 合并成一个，
   * 或者调用方又退回用 `blocked` 这一个布尔值去决定文案，
   * 「跨过零点后自动恢复」那句错话就会回来。
   */
  assert.notEqual(total.kind, daily.kind);
});

/* -------------------------------------------------------------------------- */
/*  adjust_protection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 「调整保护位」这个动作在一段时间里是**结构性缺失**的：模型只能开或平，
 * 止损止盈在开仓那一刻定死，之后只有代码里那个固定阈值的回撤守卫能动它。
 * 用户的原话是「没有动态加仓、减仓、调整」——这是"调整"那一半。
 *
 * 这些用例钉住的是**它不能变成新的伤害来源**：调保护位不占保证金、不改数量，
 * 看起来无害，但它能把止损移到错误的一侧（等于立刻市价平仓）、
 * 或者移到贴脸的位置（下一根 K 线就扫掉，结局由噪音决定）。
 */
function adjustDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    symbol: 'BTCUSDT',
    action: 'adjust_protection',
    leverage: 5,
    positionSizeUsd: 690,
    stopLoss: 67_000,
    takeProfit: null,
    confidence: 70,
    riskUsd: 10,
    reasoning: '把止损提到成本附近',
reducePercent: null,
reduceQuantity: null,
    setupScore: null,
    setupScoreBasis: '',
    adjustments: [],
    ...overrides,
  };
}

test('adjust_protection：把多头止损往上移会被放行', () => {
  const env = environment({
    positions: new Map([['BTCUSDT', position({ side: 'long', stopLoss: 64_000 })]]),
  });
  /* 现价 68,000（`environment` 的默认快照）：移到 67,000 是收紧保护。 */
  const verdict = engine.review([adjustDecision({ stopLoss: 67_000 })], env);
  assert.equal(verdict.approved.length, 1, `应当放行，实际：${JSON.stringify(verdict.rejected)}`);
  assert.equal(verdict.approved[0]!.stopLoss, 67_000);
});

test('adjust_protection：把多头止损往下移会被拒 —— 那是主动扩大风险', () => {
  const env = environment({
    positions: new Map([['BTCUSDT', position({ side: 'long', stopLoss: 66_000 })]]),
  });
  const verdict = engine.review([adjustDecision({ stopLoss: 65_000 })], env);
  assert.equal(verdict.approved.length, 0, '往下移止损必须被拒');
  assert.match(verdict.rejected[0]!.reason, /只能往上移/);
});

test('adjust_protection：止损放到现价之上会被拒 —— 那等于立刻市价平仓', () => {
  const env = environment({
    positions: new Map([['BTCUSDT', position({ side: 'long', stopLoss: 60_000 })]]),
  });
  /* 现价 68,000；止损 69,000 在多头上意味着"一碰就平"。 */
  const verdict = engine.review([adjustDecision({ stopLoss: 69_000 })], env);
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /必须在现价/);
});

test('adjust_protection：止损贴得太近会被拒 —— 与开仓用同一把尺子', () => {
  /*
   * 往返成本默认 0.10%（fallback）、minStopLossFeeMultiple 默认 3
   * ⇒ 最小止损距离 0.30%。现价 68,000 的 0.1% 是 68 点，会低于门槛。
   */
  const env = environment({
    positions: new Map([['BTCUSDT', position({ side: 'long', stopLoss: 60_000 })]]),
  });
  const verdict = engine.review([adjustDecision({ stopLoss: 67_950 })], env);
  assert.equal(verdict.approved.length, 0, '贴脸的止损必须被拒');
  assert.match(verdict.rejected[0]!.reason, /往返成本/);
});

test('adjust_protection：空头的方向判断是镜像的', () => {
  const env = environment({
    positions: new Map([
      ['BTCUSDT', position({ side: 'short', entryPrice: 68_000, stopLoss: 72_000 })],
    ]),
  });
  /* 空头止损往下移是收紧保护 —— 放行。 */
  const ok = engine.review([adjustDecision({ stopLoss: 69_000 })], env);
  assert.equal(ok.approved.length, 1, `空头往下移应当放行：${JSON.stringify(ok.rejected)}`);

  /* 空头止损放到现价之下 —— 一碰就平，拒绝。 */
  const bad = engine.review([adjustDecision({ stopLoss: 67_000 })], env);
  assert.equal(bad.approved.length, 0);
  assert.match(bad.rejected[0]!.reason, /必须在现价/);
});

test('adjust_protection：没有持仓时被拒', () => {
  const env = environment({ positions: new Map() });
  const verdict = engine.review([adjustDecision()], env);
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /没有持仓/);
});

test('adjust_protection：两个价位都不给会被拒 —— 那是没有内容的动作', () => {
  const env = environment({
    positions: new Map([['BTCUSDT', position()]]),
  });
  const verdict = engine.review([adjustDecision({ stopLoss: null, takeProfit: null })], env);
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /都没给/);
});

test('adjust_protection 在开仓之前执行 —— 先弄安全，再冒险', () => {
  /*
   * 顺序不是风格问题：如果开仓先跑，这一轮的资金与额度可能被新仓吃掉，
   * 而那个该保护的老仓位一直裸着。
   */
  const env = environment({
    positions: new Map([['BTCUSDT', position({ side: 'long', stopLoss: 64_000 })]]),
  });
  const verdict = engine.review(
    [openDecision({ symbol: 'BTCUSDT', stopLoss: 64_000 }), adjustDecision({ stopLoss: 67_000 })],
    env,
  );
  assert.ok(verdict.approved.length >= 1);
  assert.equal(
    verdict.approved[0]!.action,
    'adjust_protection',
    `调保护位必须排在开仓之前，实际顺序：${verdict.approved.map((d) => d.action).join('、')}`,
  );
});


/* -------------------------------------------------------------------------- */
/*  add_to_position / reduce_position                                          */
/* -------------------------------------------------------------------------- */

/**
 * 用户的原话是「没有动态加仓、减仓、调整」。
 * 这些用例钉的是**它们不能变成新的伤害来源**。
 *
 * 加仓的独特风险是"敞口变大而保护没跟上"，
 * 减仓的独特风险是"减完之后剩下一个既挂不了保护单也减不动的残仓"。
 */
function addDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    symbol: 'BTCUSDT',
    action: 'add_to_position',
    leverage: 5,
    positionSizeUsd: 100,
    /*
     * 现价 68,000（`environment` 的默认快照）：止损距 2,000、止盈距 6,000
     * ⇒ **盈亏比 1:3**，恰好是默认门槛。差一点就会被风控正确拒掉。
     */
    stopLoss: 66_000,
    takeProfit: 74_000,
    /* 默认 minConfidence 是 75 —— 用例填低了会被风控正确拒掉。 */
    confidence: 85,
    riskUsd: 10,
    reducePercent: null,
    reduceQuantity: null,
    reasoning: '结构仍成立，加一点',
    setupScore: null,
    setupScoreBasis: '',
    adjustments: [],
    ...overrides,
  };
}

function reduceDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    symbol: 'BTCUSDT',
    action: 'reduce_position',
    leverage: 5,
    positionSizeUsd: 0,
    stopLoss: null,
    takeProfit: null,
    confidence: 60,
    riskUsd: 0,
    reducePercent: 50,
    reduceQuantity: null,
    reasoning: '先落袋一半',
    setupScore: null,
    setupScoreBasis: '',
    adjustments: [],
    ...overrides,
  };
}

/** 现价 68,000（`environment` 的默认快照），持仓 0.01 BTC ≈ $680。 */
function withPosition(overrides: Partial<PositionView> = {}): RiskEnvironment {
  return environment({
    positions: new Map([['BTCUSDT', position({ side: 'long', ...overrides })]]),
  });
}

test('加仓：同向、额度足够时放行，且 action 保持为 add_to_position', () => {
  const verdict = engine.review([addDecision({ positionSizeUsd: 50 })], withPosition());
  assert.equal(verdict.approved.length, 1, `应当放行：${JSON.stringify(verdict.rejected)}`);
  /*
   * **action 必须保持 add_to_position。**
   *
   * `reviewAdd` 内部借用了 `reviewOpen` 的判据，而它会返回一个 action 被改成
   * `open_long` 的 decision。忘了改回去的话，执行层会把它当**新开仓**处理 ——
   * 那个标的已经有仓了，本地会插入第二行持仓，账目从此错位。
   */
  assert.equal(verdict.approved[0]!.action, 'add_to_position');
});

test('加仓：没有持仓时被拒 —— 那应该用 open_long', () => {
  const verdict = engine.review([addDecision()], environment({ positions: new Map() }));
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /没有持仓/);
});

test('加仓：与新开仓共享同一批上限（保证金不足时被拒）', () => {
  /*
   * 这是加仓最容易漏的一条：它看起来"只是加一点"，但占用的是同一份保证金预算。
   * 用一个大到必然超出预算的名义值来验证。
   */
  const verdict = engine.review([addDecision({ positionSizeUsd: 999_999 })], withPosition());
  /* 会被削到上限而不是直接拒绝 —— 两种都行，但**不能原样放行**。 */
  if (verdict.approved.length > 0) {
    assert.ok(
      verdict.approved[0]!.positionSizeUsd < 999_999,
      '超出额度的加仓必须被削，不能原样通过',
    );
  }
});

test('加仓：持仓数已满时仍然放行 —— 它不占新的仓位名额', () => {
  /*
   * `account.positionCount` 已达 `maxPositions`，但这笔加仓用的是**已有的名额**。
   * `reviewAdd` 把 positionCount 减 1 再交给 reviewOpen 就是为了这个。
   * 不这么做的话，持满仓位的机器人永远加不了仓。
   */
  const env = environment({
    config: configWith({ riskControl: { ...defaultStrategyConfig().riskControl, maxPositions: 1 } }),
    account: { equity: 1000, availableBalance: 900, marginUsed: 200, positionCount: 1 },
    positions: new Map([['BTCUSDT', position({ side: 'long' })]]),
  });
  const verdict = engine.review([addDecision({ positionSizeUsd: 30 })], env);
  assert.equal(
    verdict.approved.length,
    1,
    `持满名额时加仓不该被"最大持仓数"挡住：${JSON.stringify(verdict.rejected)}`,
  );
});

test('减仓：给出比例时放行，并把要减的名义算出来', () => {
  const verdict = engine.review([reduceDecision({ reducePercent: 50 })], withPosition());
  assert.equal(verdict.approved.length, 1, `应当放行：${JSON.stringify(verdict.rejected)}`);
  const size = verdict.approved[0]!.positionSizeUsd;
  /* 持仓 0.01 × 50% × 68,000 = 340 */
  assert.ok(Math.abs(size - 340) < 1, `要减的名义应当约 340，实际 ${size}`);
});

test('减仓：比例达到 100% 被拒 —— 那应该用 close_long', () => {
  const verdict = engine.review([reduceDecision({ reducePercent: 100 })], withPosition());
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /close_long|close_short|100%/);
});

test('减仓：两个字段都不给时被拒，且说清该给什么', () => {
  const verdict = engine.review(
    [reduceDecision({ reducePercent: null, reduceQuantity: null })],
    withPosition(),
  );
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /reduce_percent|reduce_quantity/);
});

test('减仓：减完只剩残仓（低于最小下单量）时被拒', () => {
  /*
   * 那会让剩下的那半既挂不了保护单也减不动 —— 只能靠全部平掉来收拾。
   * 与其让操作员事后发现，不如当场拒绝并说清。
   */
  const env = environment({
    positions: new Map([['BTCUSDT', position({ side: 'long', quantity: 0.001 })]]),
    /* 最小名义 5，现价 68,000 ⇒ 最小数量 ≈ 0.0000735；减 99% 之后剩 0.00001。 */
    minNotionalOf: () => 5,
  });
  const verdict = engine.review([reduceDecision({ reducePercent: 99 })], env);
  assert.equal(verdict.approved.length, 0, '残仓必须被拒绝');
  assert.match(verdict.rejected[0]!.reason, /最小下单量|残仓/);
});

test('减仓：没有持仓时被拒', () => {
  const verdict = engine.review([reduceDecision()], environment({ positions: new Map() }));
  assert.equal(verdict.approved.length, 0);
  assert.match(verdict.rejected[0]!.reason, /没有持仓/);
});

/* -------------------------------------------------------------------------- */
/*  限价入场：盈亏比与方向校验都要按「挂单价」                                    */
/* -------------------------------------------------------------------------- */

test('★ 限价单的盈亏比要按挂单价算 —— 按市价算会把它误杀', () => {
  /*
   * ## 这条用的是生产上的真实数字（`#116`，2026-09-21 20:47 UTC）
   *
   *     模型提的：open_long BNBUSDT  entry_type=limit  limit_price=800.5
   *               止损 793.5   止盈 821.5
   *     实际结果：rejected — 盈亏比 1:1.82 低于要求的 1:3
   *
   * 而按挂单价算，它是 **1:3.00** —— 刚好达标：
   *
   *     (821.5 - 800.5) / (800.5 - 793.5) = 21.0 / 7.0 = 3.00
   *
   * **模型做对了，而风控用错了参考价** —— 于是**限价入场这条链路自上线以来
   * 一次都没成功过**：每一次都被这条判据拦下，而拦它的理由是基于一个这笔交易
   * 根本不会成交的价位算出来的。
   */
  const symbol = 'BNBUSDT';
  const env = environment({
    snapshots: new Map([[symbol, snapshot(symbol, 803.4)]]), // 当前市价
    config: configWith({
      riskControl: {
        ...defaultStrategyConfig().riskControl,
        minRiskRewardRatio: 3,
        minStopLossFeeMultiple: 0, // 这一条测的是盈亏比，手续费门槛另行关闭
      },
    }),
  });

  const limitOrder = openDecision({
    symbol,
    action: 'open_long',
    entryType: 'limit',
    limitPrice: 800.5,
    stopLoss: 793.5,
    takeProfit: 821.5,
    positionSizeUsd: 60,
    leverage: 3,
  });

  const approved = engine.review([limitOrder], env);
  assert.equal(
    approved.rejected.length,
    0,
    `★ 按挂单价 800.5 算盈亏比是 1:3.00（刚好达标），不该被拒。实际理由：${approved.rejected[0]?.reason ?? '（无）'}`,
  );

  /*
   * 反面：**同一个单，如果按市价算就该被拒** —— 那证明判据真的变了参考价，
   * 而不是"阈值被放松了"。
   */
  const asMarket = engine.review([{ ...limitOrder, entryType: 'market', limitPrice: null }], env);
  assert.equal(asMarket.approved.length, 0, '按市价 803.4 算的话，这个单确实不达标 —— 那正是原来的误杀');
  assert.match(asMarket.rejected[0]!.reason, /盈亏比/, '拒绝理由应当还是盈亏比');
});

test('★ 裁决必须带上算好的数量 —— 下单路径不许再自己算一遍', () => {
  /*
   * 数量原来由**两条路径各算一次**：引擎第 12 步算一遍（校验最低名义、写进
   * `adjustments`），下单路径再拿 `positionSizeUsd` 除以价格算一遍。
   * 两处口径一旦不同就分叉 —— 实测三次真实失败：引擎按市价放行、下单按挂单价
   * 取整，`0.275 × 72.55 = 19.9513 < 20`，整笔被交易所拒绝，白丢一次机会。
   *
   * 所以引擎必须把数量一起交出来（`Decision.quantity`），下单路径直接用它。
   * 这条用例守的是"那个字段真的被填了" —— 它一消失，两条路径就又各算各的。
   */
  const verdict = engine.review(
    [
      openDecision({
        symbol: 'BTCUSDT',
        action: 'open_long',
        positionSizeUsd: 100,
        leverage: 3,
        stopLoss: 66_000,
        /* 入场 68000：跌 2000 / 涨 6000 = 1:3 —— 满足 `minRiskRewardRatio` 的前置条件。 */
        takeProfit: 74_000,
      }),
    ],
    environment(),
  );

  assert.equal(
    verdict.rejected.length,
    0,
    `不该被拒：${verdict.rejected[0]?.reason ?? '（无）'}`,
  );
  const approved = verdict.approved[0]!;
  assert.ok(
    typeof approved.quantity === 'number' && approved.quantity > 0,
    `★ 开仓裁决必须带 quantity（实得 ${String(approved.quantity)}）—— ` +
      '否则下单路径只能自己再算一遍，两处口径会分叉',
  );
});

test('★ 限价单的数量必须按挂单价算 —— 否则引擎放行、交易所按挂单价拒绝', () => {
  /*
   * 实测三次真实失败（2026-09-24 ~ 09-26），原文：
   *
   *     LTCUSDT 的名义价值不足：0.275 × 72.55 = 19.9513 USDT，
   *     低于交易所下限 20 USDT。（数量 0.275 按步长取整为 0.275 之后才不足
   *     —— 调整仓位时要把这一步算进去。）
   *
   * 而引擎当时是按**市价**（约 71.05）算的数量与名义：`floor(20 / 71.05)` 那一档
   * 的名义是 $20.00 —— **引擎放行、交易所按挂单价拒绝**，同一个函数里两个口径。
   * 第 13 步（钳制保护位）早就统一用 `entryPrice` 了，第 12 步漏了。
   *
   * 这个用例把两个口径的差异钉死：按市价会得到 0.281491、按挂单价才是 0.275673。
   */
  const symbol = 'LTCUSDT';
  const env = environment({
    snapshots: new Map([[symbol, snapshot(symbol, 71.05)]]), // 市价
    minNotionalOf: () => 20,
    config: configWith({
      riskControl: { ...defaultStrategyConfig().riskControl, minStopLossFeeMultiple: 0 },
    }),
  });

  const decision = openDecision({
    symbol,
    action: 'open_long',
    entryType: 'limit',
    limitPrice: 72.55, // 挂单价比市价高（等突破）
    stopLoss: 71,
    takeProfit: 78,
    positionSizeUsd: 20,
    leverage: 3,
  });

  const result = engine.review([decision], env);
  assert.equal(
    result.rejected.length,
    0,
    `不该被拒：${result.rejected[0]?.reason ?? '（无）'}`,
  );

  /*
   * 引擎**不把数量放进裁决结果**（它只做校验），所以按 `adjustments` 里记下的
   * 数量来断言 —— 那句话是它实际用来过门槛的那个数量。
   * 按市价会写 0.281492，按挂单价才写 0.275673。
   */
  const adjustments = result.approved[0]!.adjustments.join(' ');
  assert.match(
    adjustments,
    /数量 0\.275/,
    `★ 数量必须按挂单价 72.55 算（实则：${adjustments}）—— 按市价会算成 0.281491，` +
      '而实际下单按挂单价取整就只有 0.275，报给交易所的名义不够，整笔白丢一次机会',
  );
});
test('限价单的方向校验也按挂单价 —— 否则一笔正确的挂单会被判成"止损放反了"', () => {  /*
   * 挂单价低于市价时，一个"贴在市价下方"的止损**相对挂单价是在正确的一侧**、
   * 相对市价却可能在错误的一侧。用市价校验会把一笔合规的挂单拒掉，
   * 而理由（"止损未低于当前价"）与"这笔亏不亏钱"毫无关系。
   */
  const symbol = 'BNBUSDT';
  const env = environment({
    snapshots: new Map([[symbol, snapshot(symbol, 803.4)]]),
    config: configWith({
      riskControl: {
        ...defaultStrategyConfig().riskControl,
        minRiskRewardRatio: 0, // 这一条测的是方向校验
        minStopLossFeeMultiple: 0,
      },
    }),
  });

  /* 止损 801 在挂单价 800.5 **上方** —— 对做多而言是错的，必须被拒。 */
  const wrongSide = engine.review(
    [
      openDecision({
        symbol,
        action: 'open_long',
        entryType: 'limit',
        limitPrice: 800.5,
        stopLoss: 801,
        takeProfit: 821.5,
        positionSizeUsd: 60,
      }),
    ],
    env,
  );
  assert.equal(wrongSide.approved.length, 0, '止损在挂单价上方 —— 做多的止损放反了，必须拒');
  assert.match(wrongSide.rejected[0]!.reason, /止损无效/, '理由要说清是止损位置的问题');
});

/* -------------------------------------------------------------------------- */
/*  盈亏比的浮点边界                                                             */
/* -------------------------------------------------------------------------- */

test('★ 盈亏比"刚好达标"必须通过 —— 浮点误差不该变成拒绝的理由', () => {
  /*
   * ## 这条用的是生产上的真实数字（`#87`，2026-09-21）
   *
   *     止损 111   止盈 115.8   市价 112.2
   *     下行 = 112.2 − 111   = 1.2
   *     上行 = 115.8 − 112.2 = 3.6
   *     盈亏比 = 3.6 / 1.2 = 2.999999999999988
   *
   * 而拒绝理由写的是：
   *
   *     > 盈亏比 1:3.00 低于要求的 1:3。
   *
   * **显示出来是相等的两个数，而判定是"低于"** —— `toFixed(2)` 把
   * 2.999999999999988 显示成 `3.00`，而比较是 `2.999999999999988 < 3`。
   *
   * 于是**一个数学上刚好达标的单被拒了**，而那正是提示词要求它做的
   * （「止盈 ≥ 止损幅度的 3 倍」）—— **"刚好 3 倍"是按规则算出来的结果。**
   */
  const symbol = 'SOLUSDT';
  const env = environment({
    snapshots: new Map([[symbol, snapshot(symbol, 112.2)]]),
    config: configWith({
      riskControl: {
        ...defaultStrategyConfig().riskControl,
        minRiskRewardRatio: 3,
        minStopLossFeeMultiple: 0,
      },
    }),
  });

  const verdict = engine.review(
    [
      openDecision({
        symbol,
        action: 'open_long',
        stopLoss: 111,
        takeProfit: 115.8,
        positionSizeUsd: 60,
        leverage: 3,
      }),
    ],
    env,
  );

  assert.equal(
    verdict.rejected.length,
    0,
    `★ 3.6 / 1.2 在数学上就是 3.00，不该因为浮点误差被拒。实际：${verdict.rejected[0]?.reason ?? '（无）'}`,
  );

  /*
   * 反面：**真的差一点就要拒**（2.99 而不是 2.999999999999988）——
   * 证明容差是 1e-9 而不是"把阈值放松了"。
   */
  const justShort = engine.review(
    [
      openDecision({
        symbol,
        action: 'open_long',
        stopLoss: 111,
        takeProfit: 115.79, // 3.59 / 1.2 = 2.9916…
        positionSizeUsd: 60,
        leverage: 3,
      }),
    ],
    env,
  );
  assert.equal(justShort.approved.length, 0, '真的不达标（2.99）必须照旧拒 —— 容差不是放松阈值');
  assert.match(justShort.rejected[0]!.reason, /盈亏比/, '理由应当还是盈亏比');
});



