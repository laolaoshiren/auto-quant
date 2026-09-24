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
  buildUserPromptParts,
  candidateBudget,
  DETAILED_CANDIDATE_COUNT,
  detailedCandidateCount,
  emptyPromptMemory,
  estimateCandidateChars,
  estimateTokens,
  PROMPT_PERFORMANCE_WINDOW_HOURS,
  PROMPT_RECENT_CLOSE_COUNT,
  PROMPT_TOKEN_BUDGET,
  promptTokenBudget,
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
    /* 默认不裁剪；需要测"选币阶段裁过"的用例自己覆盖它。 */
    universeTrimmedFrom: null,
    pendingEntries: [],
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
      kline: { primaryTimeframe: '5m', selectedTimeframes: ['5m', '15m'], promptPoints: 30, primaryCount: 60 },
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
      kline: { primaryTimeframe: '5m', selectedTimeframes: ['5m', '15m', '1h', '4h'], promptPoints: 30, primaryCount: 60 },
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
    indicators: { ...base.indicators, kline: { ...base.indicators.kline, promptPoints: 30, primaryCount: 60 } },
  };
  const with300: StrategyConfig = {
    ...base,
    indicators: { ...base.indicators, kline: { ...base.indicators.kline, promptPoints: 30, primaryCount: 300 } },
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

test('★ 预算按模型能力算：能力优先，但输出必须留得下', () => {
  /*
   * 用户的原则（原话）：
   *   「在**最大化发挥模型能力**的前提下，才考虑优化模型成本 …… 这个模型最大
   *     上下文是 1M，那么要**最大化利用模型能力、上下文**（当然也考虑安全冗余，
   *     我记得是 80%）」
   *
   * ⚠️ **这个函数原来写的是 `上限 × 0.5`**，理由是"输出（含推理）占比很高"。
   * 占比确实高（实测 `reasoning_tokens` 占 `completion_tokens` 的 80%+），
   * **但绝对量很小**：推理峰值 28,590，而窗口是 1,000,000。
   * 把 3% 的占比当成 50% 来预留，等于**无条件扔掉一半上下文** ——
   * 那与"最大化利用"正好相反。**省钱的保守不等于安全的保守。**
   *
   * 下面这几个数都是**实测**来的：provider 的 `/models` 报
   * `context_length: 1000000`，而 `max_tokens` 的硬上限是 393216
   * （传 1000000 被拒："the valid range of max_tokens is [1, 393216]"）。
   */
  assert.equal(
    promptTokenBudget(1_000_000),
    800_000,
    '1M 的模型应当能用 80% —— 用户明确的安全冗余，而不是原来的一半',
  );

  /*
   * `上限 − 输出预留` 在小窗口上会变成负数 —— 那时必须落回保守下限，
   * 而不是硬塞。这条保证"给输出留空间"**永远不会被利用率那条压过**：
   * 一个 128k 的模型减掉 128k 的输出预留之后没有余量，只能用兜底值。
   */
  assert.equal(
    promptTokenBudget(128_000),
    PROMPT_TOKEN_BUDGET,
    '128k 的窗口放不下"预留 128k 给输出"，必须落回保守下限',
  );

  /* 两条约束真的在**取小**，而不是只看利用率。 */
  assert.equal(
    promptTokenBudget(600_000),
    468_928,
    '600k 的窗口：利用率算出 480000，但留给输出后只有 468928 —— 取小的那个',
  );

  /* 不知道模型能吃多少时（`input_token_limit = 0`）用保守值，不猜。 */
  assert.equal(promptTokenBudget(0), PROMPT_TOKEN_BUDGET);
  assert.equal(promptTokenBudget(Number.NaN), PROMPT_TOKEN_BUDGET);
});

test('★ 上下文还有空间时告诉模型 —— 但吃满时闭嘴', () => {
  /*
   * 用户的原则：「在**最大化发挥模型能力**的前提下，才考虑优化模型成本……
   * 要**最大化利用模型能力、上下文**」。
   *
   * 之前预算是**单向**的：它在拦候选池（`buildUserPromptParts` 里的裁剪循环），
   * 而模型**不知道自己有多少空间** —— 于是它不会去用。实测那台机器人
   * `coinPoolLimit = 20`，而 80 万的预算能放约 **106 个候选**：**87% 的上下文空着**。
   *
   * 这一条钉住两件事：**该说时说清"空间是有的"**，以及**吃满时闭嘴**
   * （吃满时那段话没有任何可执行的动作，只是噪音 + 花 token）。
   */
  const memory = blankMemory();
  const few = [snapshot('BTCUSDT', 68_000), snapshot('ETHUSDT', 2_500)];

  /* ① 候选很少、预算很大 —— 必须说，而且要点明"卡住它的是配置，不是上下文"。 */
  const roomy = buildUserPrompt(contextWith(memory, few), 800_000);
  assert.match(roomy, /你的上下文空间/);
  assert.match(roomy, /最多能放约 \d+ 个候选/, '要给出具体的空间数字，模型自己推不出来');
  assert.match(roomy, /不是上下文/, '必须说清卡住它的是配置而不是预算');
  assert.match(roomy, /coinPoolLimit/, '要指出该调哪个参数');

  /* ② 候选已经吃满预算 —— 不该出现（否则每轮多一段无法执行的建议）。 */
  const tight = buildUserPrompt(contextWith(memory, few), 1);
  assert.doesNotMatch(tight, /你的上下文空间/, '池子已经贴着上限时不该再催促');
});

test('★ 主动告诉模型它的输出空间 —— 一条过时的自我约束比没有约束更糟', () => {
  /*
   * 实盘观察：这台机器人给**自己**定了一条规则（写在它自己维护的
   * `promptSections.decisionProcess` 里）：
   *
   *     「⚠️ 输出预算很紧：分析文字总计不超过 150 字 …… 历史上已出现过整轮因
   *       输出被截断而报废」
   *
   * **那句话在写下的时候是对的**：当时 `max_tokens = 16384`，而推理与正文
   * 共享这个额度（实测推理峰值 28,590），库里有 8 次正文被吃光。
   *
   * 现在上限已抬到 131072（`MIN_MAX_TOKENS_FOR_REASONING`），**而它不会自己
   * 知道** —— 于是继续按一个已经不存在的限制压缩分析。用户的要求是
   * 「**最大化发挥模型能力**」，所以提示词必须主动更新这个事实。
   */
  const prompt = buildSystemPrompt(contextWith(blankMemory()));
  assert.match(prompt, /你的输出空间/, '必须主动说，否则它会继续自我压缩');
  assert.match(prompt, /131072/, '要给具体数字，而不是"空间很大"这种空话');
  assert.match(prompt, /已经不成立/, '要点明那条旧限制的过时性 —— 否则它没有理由改掉习惯');
});

test('★ 详细行情给几个，按预算算 —— 不再写死 5', () => {
  /*
   * 用户的原则：「**最大化利用模型能力、上下文**」。
   *
   * `DETAILED_CANDIDATE_COUNT = 5` 是照着**20 万**预算定的账（一个详细区块约
   * 6,000 token）。而预算现在按模型能力算 —— 1M 上下文的模型拿到 **80 万**，
   * 20 个候选全给详细也只有 12 万 token（占 15%）。
   *
   * 那段注释里还有个循环论证：「模型实测通常只深入看 1–2 个」——
   * **但它当时只能看到 5 个的详细序列**。把供给限制当成了需求证据。
   */
  const config = defaultStrategyConfig();
  assert.ok(
    detailedCandidateCount(config, 800_000, 100) > 20,
    '80 万预算下应当能给出远多于 5 个完整序列',
  );
  assert.equal(
    detailedCandidateCount(config, 1, 100),
    DETAILED_CANDIDATE_COUNT,
    '极小预算也必须保留原来的 5 个下限 —— 这个改动不该让任何情况变差',
  );
  assert.equal(detailedCandidateCount(config, 800_000, 3), 3, '候选只有 3 个时不该报出更多');
});

test('★ 大预算下提示词真的把更多候选给成完整序列（不只是算了个数）', () => {
  /*
   * 反面保险：只断言 `detailedCandidateCount()` 的返回值，无法证明**渲染路径真的用了它**。
   * 这一条读提示词本身 —— 那句"前 N 个给出完整指标序列"里的 N 才是模型实际看到的东西。
   */
  const memory = blankMemory();
  const many = Array.from({ length: 30 }, (_, i) => snapshot(`SYM${i}USDT`, 100 + i));

  const roomy = buildUserPrompt(contextWith(memory, many), 800_000);
  const bigNote = /前 (\d+) 个给出完整指标序列/.exec(roomy);
  assert.ok(bigNote, '候选区块必须说明给了几个完整序列');
  assert.ok(Number(bigNote[1]) > 5, `80 万预算下应当给多于 5 个，实际 ${bigNote[1]}`);

  const tight = buildUserPrompt(contextWith(memory, many.slice(0, 3)), 10_000);
  const smallNote = /前 (\d+) 个给出完整指标序列/.exec(tight);
  assert.ok(smallNote, '候选没被预算裁掉时要说明给了几个完整序列');
  assert.equal(
    Number(smallNote[1]),
    3,
    '3 个候选时最多只能给 3 个完整序列（下限 5 不该被撑破候选总数）',
  );
});

test('★ stable 段必须与「现在几点」无关 —— 否则缓存每轮都失效', () => {
  /*
   * 实测抓到的缓存杀手：「最近平仓」原来把时间渲染成「3 小时前」
   * （`humanDuration(now - closedAt)`）。而 `now` 每轮都在变 —— 45 分钟之后
   * 「3 小时前」变成「4 小时前」，**整个 stable 段从那一行起就与上一轮分叉**。
   * 而缓存要求**前缀逐字节相同** —— 后面那几万 token 全部按全价计费。
   *
   * 证据在那份命中率里：**没有平仓记录时**（那一块是常量文案）命中
   * **59,000**；**一旦有平仓记录**，命中掉到 **8,000**（只剩系统提示词）。
   * 同一份结构、同样的候选池，差别只在这一行。
   *
   * 契约：**同一个记忆 + 两个不同的"现在" → stable 段必须逐字节相同。**
   * 这既是缓存能否命中的判据，也是这一块"稳定"二字的定义。
   */
  const memory: PromptMemory = {
    ...blankMemory(),
    recentCloses: [
      {
        id: 1,
        traderId: 1,
        symbol: 'BTCUSDT',
        side: 'long',
        quantity: 1,
        entryPrice: 68_000,
        exitPrice: 68_400,
        leverage: 5,
        pnl: 0.5,
        entryFee: 0.01,
        exitFee: 0.01,
        fee: 0.02,
        fundingFee: 0,
        netPnl: 0.48,
        pnlPercent: 0.6,
        closeReason: 'take_profit',
        source: 'bot',
        openedAt: '2026-01-01T18:00:00.000Z',
        closedAt: '2026-01-01T20:00:00.000Z',
        holdMinutes: 120,
        entryReason: '测试用的入场理由',
      },
    ],
  };
  const at = new Date('2026-01-02T00:00:00.000Z');
  const stableA = buildUserPromptParts({ ...contextWith(memory), now: at }, 200_000).stable;
  const stableB = buildUserPromptParts(
    { ...contextWith(memory), now: new Date(at.getTime() + 45 * 60_000) },
    200_000,
  ).stable;

  assert.equal(stableA, stableB, '两轮的 stable 段必须逐字节相同，否则缓存永远命中不了');
  /* 反过来也要说清它渲染成了什么 —— 绝对时间戳，而不是"X 前"。 */
  assert.match(stableA, /\d{2}-\d{2} \d{2}:\d{2} UTC/, '平仓时刻要渲染成绝对时间戳');
  assert.doesNotMatch(stableA, /\d+\s*小时前|\d+\s*分钟前/, 'stable 段里不许出现相对时间');
});

test('a light strategy is allowed a much larger universe than a heavy one', () => {
  const light: StrategyConfig = {
    ...defaultStrategyConfig(),
    indicators: {
      ...defaultStrategyConfig().indicators,
      kline: { primaryTimeframe: '1h', selectedTimeframes: ['1h'], promptPoints: 30, primaryCount: 60 },
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
    idleCycles: 0,
  };

  const prompt = buildUserPrompt(contextWith(memory));

  assert.match(prompt, /# 你的交易绩效/);
  assert.match(prompt, /最近 24 小时：15 笔（5 胜 10 负）· 毛 -0\.03 · 手续费 -0\.29 · 净 -0\.32/);
  assert.match(prompt, /平均盈利 \+0\.15 · 平均亏损 -0\.18 · 实际盈亏比 0\.83（新开仓要求 ≥ 3）/);
  assert.match(prompt, /每次往返成本约 0\.10%（名义价值）/);
  assert.match(prompt, /\*\*手续费是毛盈亏的 9\.8 倍 —— 减少交易次数是当前唯一有效的改进方向。\*\*/);
});

test('★ 教训区块：AI 自己复盘出来的结论真的进得了决策提示词', () => {
  /*
   * 这条用例存在的理由：`agent_memory` 写进库之后的**唯一**读者曾经是复盘员
   * 自己（再喂给下一轮复盘）与测试 —— **没有任何决策路径读它**。
   *
   * 于是一条教训要影响下一笔交易，只能绕道让策略师把它变成一个参数改动：
   * 间接、有损，还得恰好被策略师读进上下文。那正是"越跑越厉害"断掉的地方 ——
   * AI 每一轮看到的都是"干净的行情 + 干净的账户"，看不见自己上一笔为什么亏。
   *
   * 断言分两半：有教训时整块都在（标的、平仓原因、**净**额、结论），
   * 没有教训时**不产生空区块** —— 一个永远写着"无"的区块会占预算，
   * 还会让模型学会跳过它。
   */
  const memory = emptyPromptMemory(defaultStrategyConfig());
  memory.lessons = [
    {
      symbol: 'BTCUSDT',
      closeReason: 'stop_loss',
      netPnl: -0.42,
      lesson: '止损挂在 0.4% 处，被正常波动扫掉了 —— 这个标的的日内噪声大于这个距离。',
    },
  ];

  const prompt = buildUserPrompt(contextWith(memory));

  assert.match(prompt, /# 你自己复盘出来的教训/);
  assert.match(prompt, /BTCUSDT（平仓原因 stop_loss，净 -0\.4200 USDT）/);
  assert.match(prompt, /日内噪声大于这个距离/);
  /* 教训是"具体情形"而不是通用规则 —— 这条提醒必须一起进去，否则模型会照搬。 */
  assert.match(prompt, /不是通用规则/);

  const without = buildUserPrompt(contextWith(emptyPromptMemory(defaultStrategyConfig())));
  assert.doesNotMatch(without, /# 你自己复盘出来的教训/);
});

test('★ 候选池在选币阶段被裁过时会告诉模型，而不是让它以为市场里就这些', () => {
  /*
   * 这条用例存在的理由：候选池**被裁了两次**，而模型原来只被告知其中一次。
   *
   *   · 第一次在 `coins.ts`：按 `candidateBudget(config)` 的上限截断候选池
   *     （`selectCandidates` 会返回截断前的数量，但调用方把它丢了）；
   *   · 第二次在 `buildUserPrompt`：按 token 预算再砍一轮（那次一直都会写进标题）。
   *
   * 于是模型看到"候选标的（11 个）"而配置里是 25 个，**它无从知道池子被裁过**。
   * 而提示词第 9 条又明确鼓动它"如果连续几轮在同样的标的上找不到机会，问题可能
   * 在你选标的的方式"—— 它会在一个**被静默裁过的池子**上做归因，然后去改一个
   * 本来没问题的参数。
   */
  const ctx = contextWith(emptyPromptMemory(defaultStrategyConfig()));
  ctx.universeTrimmedFrom = 25;

  const prompt = buildUserPrompt(ctx);
  assert.match(prompt, /选币阶段已按候选上限从 25 个截断/);
  /* 必须点明"不是市场里没有" —— 否则模型仍然会把"池子小"读成"行情差"。 */
  assert.match(prompt, /不是"市场里没有"/);

  const clean = buildUserPrompt(contextWith(emptyPromptMemory(defaultStrategyConfig())));
  assert.doesNotMatch(clean, /选币阶段已按候选上限/, '没裁过时不该出现那句话（会白占预算）');
});

test('★ 空转够久时绩效区块必须点出来 —— 否则模型只会继续等', () => {
  /*
   * 这条用例存在的理由：绩效区块原来在"没有成交"时只说一句
   * 「最近 N 小时没有已平仓的交易」，而那句话**区分不出两种完全不同的处境**：
   *
   *   · 刚跑两轮，还没等到机会（正常）；
   *   · 已经连着二十几轮把候选全部否掉（系统性问题）。
   *
   * 实测就是后一种：某机器人连续 28 个周期 0 决策，推理质量很高 ——
   * 每一轮都在认真分析，**只是看不到"我已经这样很多轮了"**。
   * 它因此一直在等一个"更好的信号"，而真正该做的是回头检查门槛 / 标的池 / 标准。
   */
  const memory = emptyPromptMemory(defaultStrategyConfig());
  memory.performance.idleCycles = 28;

  const prompt = buildUserPrompt(contextWith(memory));
  assert.match(prompt, /你已连续 28 轮没有做出任何决策/);
  /* 必须指明出处 —— 只指出问题而不给可用的动作，等于把焦虑丢回给模型。 */
  assert.match(prompt, /set_params/);

  /* 反向：空转没到阈值时不该出现那句话（每轮都喊等于没喊）。 */
  const calm = emptyPromptMemory(defaultStrategyConfig());
  calm.performance.idleCycles = 2;
  assert.doesNotMatch(
    buildUserPrompt(contextWith(calm)),
    /轮没有做出任何决策/,
    '刚开始跑就说"你已空转很久"，会让这句话失去意义',
  );
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
    idleCycles: 0,
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
    idleCycles: 0,
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
  /*
   * ⚠️ 平仓时刻现在是**绝对时间戳**（`MM-DD HH:mm UTC`），不是「3 分钟前」。
   * 原因见上面那条「stable 段必须与「现在几点」无关」的用例：相对时间每轮都变，
   * 会让整个 stable 段的缓存前缀失效。
   *
   * `BASE_NOW` 是 `2026-01-02T00:00:00.000Z`，所以"3 分钟前" = `01-01 23:57 UTC`。
   */
  assert.match(prompt, /- SYNUSDT 多 5x @0\.180500→0\.180200  净 -0\.048  触发止盈  \(01-01 23:57 UTC\)/);
  assert.match(
    prompt,
    /你当时的理由：1M 放量刷新低点，RSI7 12 超卖 \(模型当时还写了一整段推演，不该进提示词\)/,
  );
  /*
   * 这种回合没有对应的持仓行，理由就该是"未记录"，而不是猜一个。
   *
   * ⚠️ 标签是「机器人未运行时平仓」而**不是「对账补录」** —— 后者描述的是
   * 系统怎么知道的，而提示词里这句话要和成交列表上看到的是同一个说法。
   */
  assert.match(
    prompt,
    /- LSKUSDT 空 10x @1\.2000→1\.1900  净 \+0\.667  机器人未运行时平仓  \(01-01 23:00 UTC\)\n  你当时的理由：（未记录）/,
  );
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
    lessons: [],
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
      idleCycles: 0,
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
    idleCycles: 0,
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


test('提示词要提醒模型：候选池本身也可以改', () => {
  /*
   * 用户实测观察：「做的币种始终是那几个热门币，似乎没有机会很大的山寨币」。
   *
   * 查证：候选池按 coinSource.coinPoolRank 排，生产上设的是 quote_volume
   * （成交额榜）—— 天然只有最热门的那些。而 coinSource.* 本来就在 set_params
   * 的可调范围里。**能力一直在，缺的是一个去用它的理由。**
   *
   * 这与"只做多"那条是同一个病：**能力存在，但提示词没让它想到要用。**
   */
  const text = buildSystemPrompt(contextWith(blankMemory()));
  assert.match(text, /coinPoolRank/, '要写出那个参数的名字，否则模型不知道改什么');
  assert.match(
    text,
    /怎么选标的|怎么选/,
    '要说清"问题可能不在标的、而在选择方式"——只列出参数名不够',
  );
  assert.match(text, /波动率|资金费/, '要给它一个具体的替代方向，而不只是"你可以改"');
});

test('指标序列的渲染长度归 AI 调 —— 它以前是写死的 30', () => {
  /*
   * 实测：每轮约 49,700 个 prompt token，**主体是每个候选标的约 10,200 字
   * 的逐根 K 线数字数组**。而那个长度原来是
   * `series(values, decimals, maxPoints = 30)` 里的一个默认参数 —— **没有配置项**。
   *
   * 于是"给它更多历史还是更少"这个取舍，由代码替 AI 做了。
   * 那违背了 AI 托管的前提：**代码不知道它这轮要做形态判断还是粗略的方向确认。**
   */
  const base = configFromPreset('conservative');
  const withConfig = (points: number): StrategyConfig => ({
    ...base,
    indicators: { ...base.indicators, kline: { ...base.indicators.kline, promptPoints: points } },
  });

  const lean = estimateCandidateChars(withConfig(8));
  const heavy = estimateCandidateChars(withConfig(30));

  assert.ok(
    heavy > lean,
    `promptPoints 必须真的影响成本：8 点 ${lean} 字，30 点 ${heavy} 字`,
  );
  const ratio = heavy / lean;
  /* 大致成比例即可：差一个数量级说明参数没接上渲染那条路径。 */
  assert.ok(ratio > 1.5 && ratio < 6, `成本应当随点数放大约 3–4 倍，实际 ${ratio.toFixed(2)}`);
});

test('提示词要告诉 AI：输入长度本身是一笔可以权衡的成本', () => {
  const text = buildSystemPrompt(contextWith(blankMemory()));
  assert.match(text, /promptPoints/, '要写出参数名，否则模型不知道改什么');
  assert.match(
    text,
    /成本|都是有成本/,
    '要说清它是成本 —— 只列出参数名，模型没有理由去调它',
  );
  /*
   * **刻意不给建议值**：「该给多少」正是要 AI 自己回答的问题。
   * 用例在这里钉住这一点，防止后来者"顺手"加一句推荐值。
   */
  assert.ok(
    !/建议.*(10|15|20) 点|推荐.*(10|15|20) 点/.test(text),
    '不该给出推荐点数 —— 那等于把取舍又替它做了',
  );
});

/* -------------------------------------------------------------------------- */
/*  AI 托管：不替它预设交易性格                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 这一组守的是**「智能模式里不能有写死的性格」**。
 *
 * 实测 `#9` 修之前，同一个意思在系统提示词里出现了**三次**：
 *
 * ```
 * # 角色
 * …并且对资金保持保守。                       ← DEFAULT_ROLE
 * # 模式：稳健
 * 保住本金压倒一切。宁可交易更少、质量更高。      ← MODE_GUIDANCE.conservative
 * （加上它自己写的 entryStandards 里那句「保守模式」—— 那条是它的自主权，测试不管）
 * ```
 *
 * 而 AI 托管模式的全部意义是**由它自己决定该稳健还是该进取**。
 * 三层都在替它回答同一个问题，等于把那个判断拿走了。
 */
test('★ AI 托管时不再注入写死的交易性格 —— 改成把判断交给它', () => {
  const text = buildSystemPrompt({ ...contextWith(blankMemory()), aiManaged: true });

  assert.ok(
    !/保住本金压倒一切/.test(text),
    '★ AI 托管时不该出现 MODE_GUIDANCE 的写死内容 —— 那是在替它定性格',
  );
  assert.ok(
    !/模式：稳健|模式：进取|模式：短线/.test(text),
    '★ 三档写死的模式标签都该消失，而不只是默认那一档',
  );
  assert.ok(
    /由你自己判断/.test(text),
    '★ 换掉不等于不说 —— 必须明确告诉它「这归你判断」，否则它会保留上一段留下的印象',
  );
  assert.ok(
    /set_params/.test(text),
    '★ 还要说清改到哪里去（它自己的 entryStandards / tradingFrequency），否则那个判断没有落点',
  );
});

test('固定策略仍然按它选的那一档执行 —— 不能因为改 AI 托管而顺手删掉', () => {
  const text = buildSystemPrompt({ ...contextWith(blankMemory()), aiManaged: false });
  assert.ok(
    /模式：稳健/.test(text),
    '非 AI 托管的策略：写策略的人确实选了那一档，照旧注入',
  );
});

test('两种角色句里都不该出现「保守」—— 那是它要自己得出的结论', () => {
  const fixed = buildSystemPrompt({ ...contextWith(blankMemory()), aiManaged: false });
  const ai = buildSystemPrompt({ ...contextWith(blankMemory()), aiManaged: true });

  /*
   * 固定策略的角色句里保留「对资金保持保守」是**准确的**（写策略的人就是那么选的），
   * 所以这一条只钉 AI 托管那一份。
   */
  assert.ok(
    !/保持保守|偏保守/.test(ai.split('\n# 交易风格')[0] ?? ai),
    `★ AI 托管的角色段里不该替它写「保守」。实际开头：${ai.slice(0, 220)}`,
  );
  /* 而固定策略那一份不必改 —— 把它写出来是为了说明"两者有意不同"。 */
  assert.ok(/保持保守/.test(fixed), '固定策略的角色句照旧（它描述的是写策略那个人的选择）');
});

test('拿掉性格不等于拿掉安全边界', () => {
  const text = buildSystemPrompt({ ...contextWith(blankMemory()), aiManaged: true });
  /*
   * ⚠️ 这一条是防止有人把「不预设性格」误读成「不用管风险」。
   * 硬性约束那一段与交易性格是两回事，**一条都不该少**。
   */
  assert.ok(/硬性约束/.test(text), '硬性约束那一段必须还在');
  assert.ok(/最大杠杆/.test(text), '杠杆上限照旧');
  assert.ok(/保证金模式/.test(text), '保证金模式照旧');
});

/* -------------------------------------------------------------------------- */
/*  可调参数必须说清「当前值 + 你可以改」                                           */
/* -------------------------------------------------------------------------- */

test('★ 系统选定的默认值要交代来历，而不是只陈述事实', () => {
  /*
   * ⚠️ 保本那一条要在**开启**状态下才说「不要为此去调整它」——
   * 关闭时保本守卫根本不动止损，那句话没有对象。
   * 而 `defaultStrategyConfig()` 里 `breakevenTriggerPercent` 默认是 0（关闭），
   * 所以这里显式给一个开启的配置（生产上 `#9` 就把它改成了 1）。
   */
  const base = defaultStrategyConfig();
  const text = buildSystemPrompt({
    ...contextWith(blankMemory()),
    aiManaged: true,
    config: { ...base, riskControl: { ...base.riskControl, breakevenTriggerPercent: 1 } },
  });

  /*
   * ## 这条守的是「陈述事实」与「交代来历」的差别
   *
   * 同一个参数有两种写法，而它们对模型的效果完全不同：
   *
   *   · 只写「保证金模式：逐仓」        → 读起来像**环境**（"这里就是这样"）
   *   · 加上「系统给的起点，你可以改」   → 读起来像**选项**
   *
   * 而 `priceProtectOnStop` 更极端：它**在提示词里完全没出现过** ——
   * 一个「AI 能改、而 AI 不知道它存在」的参数。**那比写死更糟**：
   * 写死至少是一个明确的决定，而这是一个没人知道的选择。
   *
   * 第三个是 `breakevenTriggerPercent`：AI 改过它（`#18` 设成 1），所以它知道
   * 这个字段存在，但提示词里没写**当前值** —— 于是它会看到止损"自己动了"
   * （保本守卫移的），可能去"修正"，而下一轮守卫又移一次。**两方来回改同一个止损位。**
   */
  assert.ok(
    /保证金模式[\s\S]{0,400}系统给的起点/.test(text),
    '★ 保证金模式要说清"这是起点、你可以改" —— 只陈述事实读起来像环境',
  );
  assert.ok(
    /触发价格保护/.test(text),
    '★ priceProtectOnStop 必须出现在提示词里 —— 它以前完全没出现过（能改而不知道它存在）',
  );
  assert.ok(
    /保本止损[\s\S]{0,300}\d+(\.\d+)?%/.test(text),
    '★ 保本止损要写**当前值** —— 否则它会与保本守卫来回改同一个止损位',
  );
  assert.ok(
    /不要为此去调整它/.test(text),
    '★ 还要告诉它"止损自己动了是那条规则做的，不是你错了" —— 否则它会去"修正"',
  );
});
