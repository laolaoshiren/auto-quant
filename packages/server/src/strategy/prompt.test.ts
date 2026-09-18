import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  STRATEGY_PRESETS,
  defaultStrategyConfig,
  type MarketSnapshot,
  type StrategyConfig,
} from '@aq/shared';
import { closeDb, getDb, initDb } from '../db/index.js';
import {
  aiModels,
  exchanges,
  strategies as strategyStore,
  traders,
  trades as tradeStore,
} from '../store/repositories.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  candidateBudget,
  emptyPromptMemory,
  estimateCandidateChars,
  estimateTokens,
  PROMPT_PERFORMANCE_WINDOW_HOURS,
  PROMPT_RECENT_CLOSE_COUNT,
  PROMPT_TOKEN_BUDGET,
  type PromptContext,
  type PromptMemory,
} from './prompt.js';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function configFromPreset(presetId: string): StrategyConfig {
  const preset = STRATEGY_PRESETS.find((p) => p.id === presetId);
  return { ...defaultStrategyConfig(), ...(preset?.patch as Partial<StrategyConfig>) };
}

/**
 * 一个最小但完整的行情快照。
 *
 * 记忆区块的测试需要一个**真的像提示词**的上下文：候选行情是提示词的主体，少了它，
 * 量出来的 token 数会被记忆区块主导，而"大小不随历史增长"这件事就不再是那个意思了。
 */
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
      closes: [price, price * 1.001, price * 0.999],
      volumes: [1, 2, 3],
      ema: { '20': [price, price], '50': [price, price] },
      rsi: { '7': [55, 54] },
      atr: { '14': [100, 101] },
      macd: null,
    },
    isMajor: symbol === 'BTCUSDT' || symbol === 'ETHUSDT',
    timeframes: [],
    derivatives: {
      openInterest: 1000,
      openInterestUsd: price * 1000,
      openInterestAvg: 900,
      openInterestChangePercent: { '1h': 2 },
      fundingRate: 0.0001,
      nextFundingTime: null,
      markPrice: price,
      indexPrice: price,
    },
    quant: null,
  };
}

/** 一份"有账本"的提示词上下文；`memory` 由每个用例自己造。 */
function contextWith(memory: PromptMemory, candidates?: MarketSnapshot[]): PromptContext {
  const config = defaultStrategyConfig();
  return {
    traderName: 'test',
    cycleNumber: 1,
    now: BASE_NOW,
    config,
    account: {
      equity: 1000,
      availableBalance: 800,
      unrealizedPnl: 0,
      marginUsed: 200,
      positionCount: 0,
    },
    positions: [],
    candidates: candidates ?? [snapshot('BTCUSDT', 68_000), snapshot('ETHUSDT', 2_500)],
    oiRanking: [],
    memory,
  };
}

/** 一个"还没有任何成交"的记忆区块，用例在它上面改字段。 */
function blankMemory(): PromptMemory {
  return emptyPromptMemory(defaultStrategyConfig());
}

const BASE_NOW = new Date('2026-01-02T00:00:00.000Z');

/* -------------------------------------------------------------------------- */
/*  Token estimation                                                           */
/* -------------------------------------------------------------------------- */

test('the token estimate reflects the measured density, not the English rule of thumb', () => {
  // Ground truth from a real call: 207,328 characters produced 128,073 tokens.
  const measured = 128_073;
  const actualChars = 207_328;
  const estimate = estimateTokens('x'.repeat(actualChars));

  // The usual "4 characters per token" heuristic would say ~52k — less than half
  // the truth, which is precisely how an oversized prompt escaped a size check.
  assert.ok(
    estimate > measured * 0.9 && estimate < measured * 1.15,
    `estimate ${estimate} should be within ~15% of the measured ${measured}`,
  );
  assert.ok(estimate > actualChars / 4, 'must not use the English prose ratio');
});

/* -------------------------------------------------------------------------- */
/*  Per-candidate cost                                                         */
/* -------------------------------------------------------------------------- */

test('a candidate costs more when more timeframes or indicators are enabled', () => {
  const lean: StrategyConfig = {
    ...defaultStrategyConfig(),
    indicators: {
      ...defaultStrategyConfig().indicators,
      kline: { primaryTimeframe: '5m', selectedTimeframes: ['5m', '15m'], primaryCount: 60 },
      enableEma: true,
      enableMacd: false,
      enableRsi: false,
      enableAtr: false,
      enableVolume: false,
    },
  };
  const heavy: StrategyConfig = {
    ...lean,
    indicators: {
      ...lean.indicators,
      kline: { primaryTimeframe: '5m', selectedTimeframes: ['5m', '15m', '1h', '4h'], primaryCount: 60 },
      enableMacd: true,
      enableRsi: true,
      enableAtr: true,
      enableVolume: true,
    },
  };

  assert.ok(
    estimateCandidateChars(heavy) > estimateCandidateChars(lean) * 2,
    'four timeframes with every indicator must cost far more than two with EMA only',
  );
});

test('rendered points are capped, so a huge candle count does not scale the cost linearly', () => {
  const base = configFromPreset('conservative');
  const with60: StrategyConfig = {
    ...base,
    indicators: { ...base.indicators, kline: { ...base.indicators.kline, primaryCount: 60 } },
  };
  const with300: StrategyConfig = {
    ...base,
    indicators: { ...base.indicators, kline: { ...base.indicators.kline, primaryCount: 300 } },
  };
  assert.equal(
    estimateCandidateChars(with60),
    estimateCandidateChars(with300),
    'past the render cap the prompt stops growing, even though indicators still compute over the full window',
  );
});

/* -------------------------------------------------------------------------- */
/*  Budget                                                                     */
/* -------------------------------------------------------------------------- */

test('the scalping preset is the heavy case and gets a small candidate budget', () => {
  // This is the exact configuration that produced a 128k-token prompt and an
  // empty model response: three timeframes, every indicator, 25 candidates.
  const scalping = configFromPreset('scalping');
  const budget = candidateBudget(scalping);

  assert.ok(budget >= 1, 'a strategy must always see at least one symbol');
  assert.ok(
    budget < 25,
    `the scalping config must not be allowed 25 candidates (got ${budget}) — that is what overflowed the context`,
  );
  // Sanity: the budget must actually fit.
  const perCandidate = estimateTokens('x'.repeat(estimateCandidateChars(scalping)));
  assert.ok(
    perCandidate * budget <= PROMPT_TOKEN_BUDGET * 1.1,
    `budget ${budget} × ${perCandidate} tokens must stay near the ${PROMPT_TOKEN_BUDGET} budget`,
  );
});

test('a light strategy is allowed a much larger universe than a heavy one', () => {
  const light: StrategyConfig = {
    ...defaultStrategyConfig(),
    indicators: {
      ...defaultStrategyConfig().indicators,
      kline: { primaryTimeframe: '1h', selectedTimeframes: ['1h'], primaryCount: 60 },
      enableMacd: false,
      enableRsi: false,
      enableAtr: false,
      enableVolume: false,
    },
  };
  assert.ok(
    candidateBudget(light) > candidateBudget(configFromPreset('scalping')),
    'a single-timeframe, single-indicator strategy should afford more candidates',
  );
});

test('every preset produces a budget that fits inside the token ceiling', () => {
  for (const preset of STRATEGY_PRESETS) {
    const config = configFromPreset(preset.id);
    const perCandidate = estimateTokens('x'.repeat(estimateCandidateChars(config)));
    const fitted = perCandidate * candidateBudget(config);
    assert.ok(
      fitted <= PROMPT_TOKEN_BUDGET * 1.1,
      `preset "${preset.id}" would produce ${fitted} tokens, over the ${PROMPT_TOKEN_BUDGET} budget`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  绩效区块（§2.1）                                                             */
/* -------------------------------------------------------------------------- */

test('绩效区块：把"你在亏"翻译成"你该少做"，而倍数由真实数字算出来', () => {
  /*
   * Why this test exists —— §2.1 的最后一行是**反过度交易的核心信号**：它把"你在亏"
   * 直接翻译成"你该少做"，而不是让模型自己从一堆数字里推断。它成立的唯一前提是那个
   * 倍数按真实数字算。
   *
   * 数字取自实盘那 15 笔成交：毛 -0.0294、手续费 0.2894 → 0.2894 / 0.0294 = 9.8 倍。
   * 如果这一行被写成固定文案，模型只要发现一次它对不上自己的账，整块记忆就废了。
   */
  const memory = blankMemory();
  memory.performance = {
    windowHours: 24,
    totalTrades: 15,
    wins: 5,
    losses: 10,
    grossPnl: -0.0294,
    totalFees: 0.2894,
    totalFunding: 0,
    netPnl: -0.3188,
    avgWin: 0.15,
    avgLoss: 0.18,
    realizedPayoffRatio: 0.83,
    roundTripFeeRate: 0.001,
  };

  const prompt = buildUserPrompt(contextWith(memory));

  assert.match(prompt, /# 你的交易绩效/);
  assert.match(prompt, /最近 24 小时：15 笔（5 胜 10 负）· 毛 -0\.03 · 手续费 -0\.29 · 净 -0\.32/);
  assert.match(prompt, /平均盈利 \+0\.15 · 平均亏损 -0\.18 · 实际盈亏比 0\.83（新开仓要求 ≥ 3）/);
  assert.match(prompt, /每次往返成本约 0\.10%（名义价值）/);
  assert.match(prompt, /\*\*手续费是毛盈亏的 9\.8 倍 —— 减少交易次数是当前唯一有效的改进方向。\*\*/);
});

test('绩效区块：账户真的在赚钱时，不会仍然说"减少交易次数是唯一方向"', () => {
  /*
   * 同一个模板必须随着事实变化。毛 +3.00、手续费 0.30（0.1 倍）时，成本已经不再是
   * 主要矛盾 —— 此时仍然输出"减少交易次数是当前唯一有效的改进方向"，就是一句
   * 与事实相反的指令，而一句被证伪的指令会让整个区块失去可信度（模型会连真实的那
   * 部分一起忽略）。倍数照算，只是不再附上那句指令。
   */
  const memory = blankMemory();
  memory.performance = {
    windowHours: 24,
    totalTrades: 4,
    wins: 3,
    losses: 1,
    grossPnl: 3,
    totalFees: 0.3,
    totalFunding: 0,
    netPnl: 2.7,
    avgWin: 1.2,
    avgLoss: 0.6,
    realizedPayoffRatio: 2,
    roundTripFeeRate: 0.001,
  };

  const prompt = buildUserPrompt(contextWith(memory));
  assert.match(prompt, /手续费是毛盈亏的 0\.1 倍。/);
  assert.doesNotMatch(prompt, /减少交易次数是当前唯一有效的改进方向/);
});

test('绩效区块：资金费非 0 时必须出现在行里，否则净额对不上', () => {
  /*
   * `净 = 毛 − 手续费 − 资金费` 是这个平台唯一允许的盈亏口径（§2.5）。资金费被结算过、
   * 却不在这一行里露面的账，模型无论怎么加都对不上 —— 而一个对不上的账本会让人
   * （和模型）不再相信里面任何一个数字。
   */
  const memory = blankMemory();
  memory.performance = {
    windowHours: 24,
    totalTrades: 2,
    wins: 1,
    losses: 1,
    grossPnl: 0.5,
    totalFees: 0.2,
    totalFunding: 0.05,
    netPnl: 0.25,
    avgWin: 0.6,
    avgLoss: 0.35,
    realizedPayoffRatio: 1.71,
    roundTripFeeRate: 0.001,
  };

  const prompt = buildUserPrompt(contextWith(memory));
  assert.match(prompt, /毛 \+0\.50 · 手续费 -0\.20 · 资金费 -0\.05 · 净 \+0\.25/);
});

/* -------------------------------------------------------------------------- */
/*  最近平仓（§2.2）与行为余量（§2.3）                                           */
/* -------------------------------------------------------------------------- */

test('最近平仓区块：把模型当时的理由和实际结果放在一起，理由只占一行', () => {
  /*
   * Why this test exists —— §2.2 的**第二行才是重点**。
   *
   * 模型看不到"它刚在 4 分钟前平掉了一笔、而且是同一个理由"。把"当时的理由"和
   * "实际结果"并排放，是它唯一能形成"我某个判断模式不奏效"的机制。这里同时钉住三件
   * 事：理由必须出现、必须被压成一行（全文是 O(n) 的，且会把区块撑成不定长）、
   * 没有理由时如实写"未记录"而不是编一个。
   */
  const memory = blankMemory();
  memory.recentCloses = [
    {
      id: 3,
      traderId: 1,
      symbol: 'SYNUSDT',
      side: 'long',
      quantity: 99,
      entryPrice: 0.1805,
      exitPrice: 0.1802,
      leverage: 5,
      pnl: -0.04,
      entryFee: 0.004,
      exitFee: 0.004,
      fee: 0.008,
      fundingFee: 0,
      netPnl: -0.048,
      pnlPercent: -1.2,
      closeReason: 'take_profit',
      source: 'bot',
      openedAt: new Date(BASE_NOW.getTime() - 3 * 60_000).toISOString(),
      closedAt: new Date(BASE_NOW.getTime() - 3 * 60_000).toISOString(),
      holdMinutes: 4.3,
      entryReason: '1M 放量刷新低点，RSI7 12 超卖\n(模型当时还写了一整段推演，不该进提示词)',
    },
    {
      id: 2,
      traderId: 1,
      symbol: 'LSKUSDT',
      side: 'short',
      quantity: 35,
      entryPrice: 1.2,
      exitPrice: 1.19,
      leverage: 10,
      pnl: 0.7,
      entryFee: 0.01,
      exitFee: 0.01,
      fee: 0.02,
      fundingFee: 0,
      netPnl: 0.66674843,
      pnlPercent: 2,
      closeReason: 'reconciled',
      source: 'reconciled',
      openedAt: new Date(BASE_NOW.getTime() - 90 * 60_000).toISOString(),
      closedAt: new Date(BASE_NOW.getTime() - 60 * 60_000).toISOString(),
      holdMinutes: 30,
      entryReason: null,
    },
  ];

  const prompt = buildUserPrompt(contextWith(memory));

  assert.match(prompt, /# 最近平仓（最新在前）/);
  assert.match(prompt, /- SYNUSDT 多 5x @0\.180500→0\.180200  净 -0\.048  触发止盈  \(3 分钟前\)/);
  assert.match(
    prompt,
    /你当时的理由：1M 放量刷新低点，RSI7 12 超卖 \(模型当时还写了一整段推演，不该进提示词\)/,
  );
  // 对账补录的回合没有对应的持仓行，理由就该是"未记录"，而不是猜一个。
  assert.match(prompt, /- LSKUSDT 空 10x @1\.2000→1\.1900  净 \+0\.667  对账补录  \(1 小时前\)\n  你当时的理由：（未记录）/);
});

test('本周期约束区块：把已经在强制执行、但模型看不见的节流与冷却说出来', () => {
  /*
   * Why this test exists —— §2.3：看不见的约束等于不存在。
   *
   * 节流与再入场冷却**已经在代码里强制执行**，但模型看不见，于是它会反复提出必然
   * 被拒的请求：浪费一次调用，也浪费一次决策机会。这一块只是让约束可见，不改变任何
   * 判定 —— 判定仍然在风控与 `isInCooldown()` 里。
   */
  const memory = blankMemory();
  memory.throttle = {
    entriesThisHour: 2,
    maxEntriesPerHour: 3,
    minutesSinceLastExit: 4,
    reentryCooldownMinutes: 20,
  };
  assert.match(
    buildUserPrompt(contextWith(memory)),
    /# 本周期约束\n本小时已开仓 2 \/ 3 笔 · 上次平仓在 4 分钟前（再入场冷却 20 分钟，还剩 16 分钟）/,
  );

  // 冷却已过：不能再报"还剩多少"，否则模型会以为现在不能入场（或反之）。
  memory.throttle = { ...memory.throttle, minutesSinceLastExit: 45 };
  assert.match(buildUserPrompt(contextWith(memory)), /再入场冷却 20 分钟，已满/);

  // 从未平过仓：如实说，不编一个剩余时间出来。
  memory.throttle = { ...memory.throttle, minutesSinceLastExit: null };
  assert.match(buildUserPrompt(contextWith(memory)), /本机器人还没有平过仓/);
});

test('止损手续费门槛出现在系统提示词里，且用的是与风控同一个费率', () => {
  /*
   * 一条模型看不见的硬性约束，会以"模型反复提出注定被拒的提案"的形式浪费决策机会。
   * 所以 §5 的门槛必须写进硬性约束，而且数字要与 `RiskEngine.reviewOpen()` 第 6b 步
   * 一致：有成交按实测，没有按配置兜底。
   */
  const memory = blankMemory();
  const withoutFills = buildSystemPrompt(contextWith(memory));
  assert.match(withoutFills, /必须至少是往返手续费的 3 倍（按配置的兜底费率，往返成本约 0\.10%，即止损幅度不得小于 0\.30%）/);

  memory.performance = { ...memory.performance, roundTripFeeRate: 0.0005 };
  const withFills = buildSystemPrompt(contextWith(memory));
  assert.match(withFills, /按近期成交实测，往返成本约 0\.05%，即止损幅度不得小于 0\.15%/);
});

/* -------------------------------------------------------------------------- */
/*  §4 的 O(1) 性质：提示词大小不随历史成交数增长                                 */
/* -------------------------------------------------------------------------- */

/*
 * 这一组测试需要一个临时数据库（§3.6：不碰 `data/`，用 mkdtempSync 建临时目录）。
 * 它必须走**真实的仓储与真实的提示词组装**：把行拉进内存再自己拼一个聚合对象，
 * 证明的只是"渲染函数是 O(1)"，而这条承诺要覆盖的是整条链路 ——
 * 跑一年之后提示词还会不会撑爆上下文，取决于 SQL 里聚合了什么。
 */
let workDir: string;
/**
 * 只属于这一组用例的机器人。
 *
 * 必须真的造出这条实体链（凭据 → 模型 → 策略 → 机器人）：`trades.trader_id` 上有外键
 * （`PRAGMA foreign_keys = ON`），拿一个不存在的 id 写成交会被数据库直接拒掉 —— 而那时
 * 用例失败的原因是"外键不存在"，不是它要验的那条性质。
 */
let o1TraderId = 0;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-prompt-'));
  initDb(path.join(workDir, 'prompt.sqlite'));

  const account = exchanges.create({
    exchange: 'binance',
    label: 'prompt-test',
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: 'prompt-test',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 120,
    maxRetries: 1,
  });
  const strategy = strategyStore.create({
    name: 'prompt-test',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  o1TraderId = traders.create({
    name: 'prompt-test',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * 造 `count` 笔形状完全相同的回合，返回**真实路径**组装出来的提示词。
 *
 * 每一笔都落在 24 小时窗口内（间隔 40 秒），并且按"最新的总是第 40 秒"排列 ——
 * 于是两个用例的「最近平仓」区块逐字相同（都被 N=5 钉满），唯一的差别是历史长度：
 * 数字的位数会多几个字符。
 *
 * ⚠️ 对比的短历史必须**已经喂满** `PROMPT_RECENT_CLOSE_COUNT`：拿 3 笔去比 2000 笔，
 * 差出来的那一截是"明细从 3 行长到 5 行"，而不是"随历史增长" —— 那样量出来的是
 * 假信号，还会把真正的泄漏淹掉。
 */
function promptForHistory(count: number): { text: string; tokens: number } {
  // `exec` 而不是 `run`：`run()` 只执行第一条语句，剩下的会被静默丢掉。
  getDb().exec('DELETE FROM trades; DELETE FROM positions;');

  for (let i = 0; i < count; i += 1) {
    const closedAt = new Date(BASE_NOW.getTime() - (count - i) * 40_000).toISOString();
    const win = i % 2 === 0;
    tradeStore.insert({
      traderId: o1TraderId,
      symbol: i % 3 === 0 ? 'BTCUSDT' : 'SYNUSDT',
      side: 'long',
      quantity: 555.5,
      entryPrice: 0.18,
      exitPrice: win ? 0.1818 : 0.1789,
      leverage: 5,
      grossPnl: win ? 1 : -0.6,
      // 名义价值约 100 USDT、两腿各 0.05：往返成本 0.1%，与实盘实测同量级。
      entryFee: 0.05,
      exitFee: 0.05,
      closeReason: win ? 'take_profit' : 'stop_loss',
      openedAt: new Date(Date.parse(closedAt) - 5 * 60_000).toISOString(),
      closedAt,
    });
  }

  const since = new Date(
    BASE_NOW.getTime() - PROMPT_PERFORMANCE_WINDOW_HOURS * 3_600_000,
  ).toISOString();
  const performance = tradeStore.performanceSince(o1TraderId, since);
  const memory: PromptMemory = {
    recentRejections: [],
    performance: {
      windowHours: PROMPT_PERFORMANCE_WINDOW_HOURS,
      totalTrades: performance.totalTrades,
      wins: performance.wins,
      losses: performance.losses,
      grossPnl: performance.grossPnl,
      totalFees: performance.totalFees,
      totalFunding: performance.totalFunding,
      netPnl: performance.netPnl,
      avgWin: performance.avgWin,
      avgLoss: performance.avgLoss,
      realizedPayoffRatio: performance.avgLoss > 0 ? performance.avgWin / performance.avgLoss : null,
      roundTripFeeRate: performance.roundTripFeeRate,
    },
    recentCloses: tradeStore.recentWithReason(o1TraderId, PROMPT_RECENT_CLOSE_COUNT),
    throttle: {
      entriesThisHour: 2,
      maxEntriesPerHour: 3,
      minutesSinceLastExit: 4,
      reentryCooldownMinutes: 20,
    },
  };

  const ctx = contextWith(memory);
  const user = buildUserPrompt(ctx);
  return { text: user, tokens: estimateTokens(buildSystemPrompt(ctx)) + estimateTokens(user) };
}

test('提示词大小不随历史成交数增长（§4 的 O(1) 性质）', () => {
  /*
   * Why this test exists —— 这是"7×24 运行"这句话唯一可验证的形式。
   *
   * 绩效与最近平仓是提示词里**唯一会随时间累积**的内容（行情每轮都是新的、账户与持仓
   * 是当前状态），所以它们必须全部在 SQL 里聚合成固定大小的结果再进来。哪天有人为了
   * "让模型记得更清楚"把明细拼进提示词 —— 哪怕只是"每天一行汇总" —— 跑一年之后提示词
   * 就会线性膨胀到撑爆上下文，而在那一天到来之前不会有任何报错。
   */
  const short = promptForHistory(PROMPT_RECENT_CLOSE_COUNT);
  const long = promptForHistory(2000);
  const growth = Math.abs(long.tokens - short.tokens) / short.tokens;

  assert.ok(
    growth < 0.05,
    `提示词大小必须与历史长度无关：${PROMPT_RECENT_CLOSE_COUNT} 笔时 ${short.tokens} tokens，2000 笔时 ${long.tokens} tokens（增长 ${(growth * 100).toFixed(1)}%）`,
  );

  /*
   * 也不能靠"什么都不渲染"通过：三个区块必须在，而且逐笔明细必须被钉死在
   * `PROMPT_RECENT_CLOSE_COUNT` 行 —— 2000 笔历史里也只能出现 5 条理由。
   */
  for (const text of [short.text, long.text]) {
    assert.match(text, /# 你的交易绩效/);
    assert.match(text, /# 最近平仓/);
    assert.match(text, /# 本周期约束/);
  }
  const reasons = long.text.match(/你当时的理由：/g) ?? [];
  assert.equal(
    reasons.length,
    PROMPT_RECENT_CLOSE_COUNT,
    `逐笔明细必须固定为 ${PROMPT_RECENT_CLOSE_COUNT} 条，实际 ${reasons.length} 条`,
  );
  // 聚合数字确实跟着历史变了（否则这个用例可能只是在测"两次都没读到数据"）。
  assert.match(short.text, new RegExp(`最近 24 小时：${PROMPT_RECENT_CLOSE_COUNT} 笔`));
  assert.match(long.text, /最近 24 小时：2000 笔/);
});

test('预算裁剪只丢候选标的，绝不丢绩效与历史区块（§3）', () => {
  /*
   * Why this test exists —— §3 的取舍方向是刻意的，而且是**单向**的：
   *
   *   行情是"这一轮的机会"，记忆是"我一直在亏钱"。
   *   丢掉前者只是错过一次机会；丢掉后者会让系统永远重复同一个错误。
   *
   * 所以预算紧张时必须从最弱的候选开始丢，而绩效、最近平仓、约束一个字段都不能少。
   * 一个把候选池撑到爆的提示词在这里被强制压回预算内 —— 用 1 token 的预算，让守卫
   * 必须裁到底。
   */
  const memory = blankMemory();
  memory.performance = {
    windowHours: 24,
    totalTrades: 15,
    wins: 5,
    losses: 10,
    grossPnl: -0.0294,
    totalFees: 0.2894,
    totalFunding: 0,
    netPnl: -0.3188,
    avgWin: 0.15,
    avgLoss: 0.18,
    realizedPayoffRatio: 0.83,
    roundTripFeeRate: 0.001,
  };
  memory.throttle = {
    entriesThisHour: 2,
    maxEntriesPerHour: 3,
    minutesSinceLastExit: 4,
    reentryCooldownMinutes: 20,
  };
  const candidates = [snapshot('BTCUSDT', 68_000), snapshot('ETHUSDT', 2_500), snapshot('SOLUSDT', 150)];

  const prompt = buildUserPrompt(contextWith(memory, candidates), 1);

  // 记忆区块一个字段都不能少。
  assert.match(prompt, /手续费是毛盈亏的 9\.8 倍/);
  assert.match(prompt, /# 最近平仓/);
  assert.match(prompt, /本小时已开仓 2 \/ 3 笔/);
  // 候选被裁到最少一个，而且如实说明裁过。
  assert.match(prompt, /# 候选标的（1 个，已因上下文预算从 3 个裁剪）/);
  const remaining = prompt.match(/### \d+\. /g) ?? [];
  assert.equal(remaining.length, 1, `候选区块必须只剩 1 个，实际 ${remaining.length} 个`);
});

test('提示词必须告诉模型它能移动止损 —— 否则这个动作等于不存在', () => {
  /*
   * `adjust_protection` 这个动作在一段时间里**根本没被实现**：
   * 模型只能开或平，止损止盈在开仓那一刻定死。
   *
   * 而"实现了但没写进提示词"是同一个病的另一种形态：
   * 模型不知道有这个动作，自然不会用 —— **等于没实现**。
   * 所以这条用例钉的是"提示词把三个要点都说了"：
   *   1. 动作名在枚举里
   *   2. 说清它是"管理已有仓位的主要手段"（给它一个使用的理由）
   *   3. 决策流程里有一句话提醒它去看（否则它会一直只想着开新仓）
   */
  const text = buildSystemPrompt(contextWith(blankMemory()));

  assert.match(text, /adjust_protection/, '动作枚举里必须有它');
  assert.match(
    text,
    /移动一个已有持仓的止损或止盈/,
    '要说清它做什么 —— 只说名字，模型不知道该拿它干什么',
  );
  assert.match(
    text,
    /管理已有仓位的主要手段/,
    '要给出使用的理由；缺少这一句，模型会倾向于只做"开"和"平"',
  );
  assert.match(
    text,
    /有多少是被保护住的/,
    '决策流程里要有一句话提醒它检查浮盈的保护情况',
  );
});

