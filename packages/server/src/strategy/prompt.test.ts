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
  type TimeframeIndicators,
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
  DETAILED_HARD_CAP,
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

/** 一个最小但**完整**的周期数据块 —— 没有它，候选区块根本渲染不出序列，断言会假绿。 */
function tf(): TimeframeIndicators {
  return {
    timeframe: '5m',
    klines: [],
    closes: [100, 101, 102],
    volumes: [1, 2, 3],
    ema: { '20': [100, 101], '50': [99, 100] },
    rsi: { '7': [55, 54] },
    atr: { '14': [1, 1.1] },
    macd: null,
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

/*
 * ══════════════════════════════════════════════════════════════════════════
 *  AI 自己设的"停手"状态必须进提示词
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用户 2026-10-04 的原话：
 *
 * > 「**页面上显示了开多，又显示 AI 已主动停手（pause_trading）：本轮不开新仓，
 * >  你完全就是自相矛盾** —— 既然 AI 要停手，那么为什么页面上要显示开仓了？」
 *
 * 而根因是**没人告诉它**：模型调完 `pause_trading` 之后，后续每一轮的提示词都
 * 没提这件事，于是它继续认真给开仓建议，执行层再把它们全拦下 ——
 * 页面同时显示「开多」与「本轮不开新仓」，而且白烧掉一整轮决策。
 *
 * 这几条钉住"告知"这件事：说了什么、以及有没有说清"你可以自己撤"。
 */


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
   * 6,000 token）。而预算现在按模型能力算 —— 1M 上下文的模型拿到 **80 万**。
   *
   * ⚠️ **但 2026-10-01 发现那个论证漏了一个约束：延迟。**
   *
   * 它只算了 token 预算（20 个候选全给详细约 12 万 token，占 15% —— 看起来绰绰有余），
   * 而 19 万 token 的请求实测要 **60–205 秒**，链路上的网关（Cloudflare）等 **100 秒**
   * 就以 `HTTP 524` 放弃 —— 实测一轮 8 轮里 **4 次**这样失败，**整轮作废**。
   *
   * 所以取向上限 10：**小预算仍保 5 个下限，大预算最多 10 个**。
   * 那仍然是"按预算算"，只是多了一层天花板 —— 而天花板保护的是
   * "这一轮能不能跑完"，比"多看几个完整序列"重要。
   */
  const config = defaultStrategyConfig();
  assert.equal(
    detailedCandidateCount(config, 800_000, 100),
    DETAILED_HARD_CAP,
    '预算再大也封顶在 DETAILED_HARD_CAP —— 见那里的 HTTP 524 说明',
  );
  assert.ok(
    DETAILED_HARD_CAP > DETAILED_CANDIDATE_COUNT,
    '上限必须高于原来的写死值 5，否则"按预算算"这个改动就白做了',
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
  assert.equal(
    Number(bigNote[1]),
    DETAILED_HARD_CAP,
    '30 个候选 + 大预算时应给满 DETAILED_HARD_CAP —— 而不是全部（那会撞上网关超时）',
  );
  assert.ok(
    Number(bigNote[1]) < 30,
    '必须真的少于候选总数，否则这条上限没有任何作用',
  );

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
    byCloseReason: [],
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
    byCloseReason: [],
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
    byCloseReason: [],
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
      byCloseReason: [],
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

test('★ 当前账户开不了的标的只给摘要、并写明原因（省 token，也免得以假候选误导模型）', () => {
  /*
   * 实测（2026-09-30）：`#1462` 真实被拒 —— 模型提 BTCUSDT open_short，
   * 交易所下限是 **$50**，而它按风险算出的名义只有 **$20**：
   *
   *     「仓位名义价值 $20.00 低于最低要求 $50.00」
   *
   * 而 `coins.ts` 把 BTCUSDT **无条件**放进候选池（它提供「大盘背景」，`mustKeep` 还保护它），
   * 于是它每轮都排在候选**第一位**、拿到约 10KB 的完整多周期序列 ——
   * 那些数据模型永远用不上（开不了这个仓位），却占着提示词预算，
   * 还让它以为"BTC 是一个可以做的候选"。
   *
   * 修法：`tradability.ok === false` 时只给摘要，并在那一块里写明原因。
   */
  const blocked = snapshot('BTCUSDT', 68_000);
  /*
   * ⚠️ **必须给它真实的周期数据** —— `snapshot()` 夹具的 `timeframes` 是空数组，
   * 那样**任何候选都渲染不出序列**，断言就会"假绿"（我第一次就踩了这个）。
   */
  blocked.timeframes = [tf()];
  blocked.tradability = { ok: false, reason: '最小名义 $50，超过你这个账户规模的上限（约 $33）' };
  const normal = snapshot('ETHUSDT', 2_500);
  normal.timeframes = [tf()];

  /* --- 对照组：没有 tradability 标记时，BTC 拿的是完整序列（那就是当时的浪费）--- */
  const unmarked = snapshot('BTCUSDT', 68_000);
  unmarked.timeframes = [tf()];
  const before = buildUserPrompt(contextWith(blankMemory(), [unmarked, normal]), 200_000);
  const beforeBtc = before.slice(before.indexOf('### 1. BTCUSDT'), before.indexOf('### 2. ETHUSDT'));
  assert.match(
    beforeBtc,
    /=== [0-9]+[MH] 周期（由旧到新）===/,
    '对照：标记之前 BTC 是拿完整序列的（这正是每轮约 10KB 的浪费）',
  );

  const prompt = buildUserPrompt(contextWith(blankMemory(), [blocked, normal]), 200_000);

  /* 1) 标的本身还在（它提供大盘背景），并且写明了为什么开不了。 */
  assert.match(prompt, /### 1\. BTCUSDT/, 'BTC 仍要出现在候选里（大盘背景）');
  assert.match(prompt, /最小名义 \$50/, '★ 必须写明为什么开不了，否则模型还会去试');

  /* 2) 它不该拿到完整的多周期序列 —— 那是约 10KB/轮的浪费。 */
  const btcBlock = prompt.slice(
    prompt.indexOf('### 1. BTCUSDT'),
    prompt.indexOf('### 2. ETHUSDT'),
  );
  assert.ok(btcBlock.length > 0, '前提：能切出 BTC 那一段');
  assert.doesNotMatch(
    btcBlock,
    /=== [0-9]+[MH] 周期（由旧到新）===/,
    '★ 开不了的标的只给摘要，不给完整序列',
  );

  /* 3) 可交易的标的照旧给完整序列 —— 不能因为这条改动让大家都降级。 */
  const ethBlock = prompt.slice(prompt.indexOf('### 2. ETHUSDT'));
  assert.match(
    ethBlock,
    /=== [0-9]+[MH] 周期（由旧到新）===/,
    '正常标的仍要拿到完整序列',
  );

  /* 4) 可交易的标的要写明它的最小名义 —— 这一条对 BTC 才真正有效。 */
  const withMin = snapshot('BTCUSDT', 68_000);
  withMin.timeframes = [tf()];
  withMin.tradability = { ok: true, minNotional: 50 };
  const minPrompt = buildUserPrompt(contextWith(blankMemory(), [withMin]), 200_000);
  assert.match(
    minPrompt,
    /最小名义价值是 \$50/,
    '★ 必须告诉模型这个标的的起步名义 —— 实测 #1462 就是因为它按 $20 的习惯提案而被拒',
  );
});

test('★ 账目差异按【相对大小】分级 —— 小差异不该让模型给自己的绩效打折', () => {
  /*
   * 实测（2026-09-30，线上真实提示词）：`gap = +0.0137`，而当时绩效净额 `1.1757` ——
   * 差异只占 **1.2%**，但提示词写的是：
   *
   *     「这意味着**上面「你的交易绩效」里的数字本身可能不准**」
   *
   * 后果：模型会**无谓地给自己的绩效打折**，而它正照着那份绩效调整策略 ——
   * 这正是用户说的"不能影响模型决策"（⑥）。
   *
   * 判据按**相对量级**分档：差异 / max(|净额|, 1) ≥ 5% 才说"数字可能不准"；
   * 低于那一档时如实给数字，但明确告诉它"不必因此调整"。
   */
  const small = contextWith(blankMemory());
  small.account = { ...small.account, ledgerGap: 0.0137 };
  /*
   * ⚠️ **必须显式给出绩效量级** —— `blankMemory()` 的 `netPnl` 是 0，
   * 而"净额为 0 却有差额"在新判据下**本来就该按大差异处理**（差异比绩效还大）。
   * 实测那一轮净额是 `1.1757`，差额占 **1.2%** —— 那才是"小差异"的场景。
   */
  small.memory = {
    ...small.memory,
    performance: { ...small.memory.performance, netPnl: 1.1757 },
  };
  /* ⚠️ 账目警告在 `volatileParts` 里 → 属于 `buildUserPrompt` 的输出，不是 system prompt。 */
  const smallText = buildUserPrompt(small);

  assert.match(smallText, /0\.0137/, '差异数额仍要如实给出 —— 不能瞒');
  assert.doesNotMatch(
    smallText,
    /数字本身可能不准/,
    '★ 1.2% 的差异不能说"绩效数字可能不准"（那会让它无谓地打折）',
  );
  assert.match(smallText, /不必因此调整/, '要明确告诉它"不用管"');

  /* 大差异（占绩效量级 ≥5%）才用强警告 —— 那种情况下绩效确实不能信。 */
  const big = contextWith(blankMemory());
  big.account = { ...big.account, ledgerGap: 0.5 };
  const bigText = buildUserPrompt(big);
  assert.match(bigText, /数字本身可能不准/, '大差异必须保持强警告');
  assert.match(bigText, /0\.5/, '大差异的数额也要如实给出');

  /*
   * ★ 边界：**差额与近期绩效同量级时，必须按大差异处理。**
   *
   * 实测（2026-09-30）：`gap = 0.01367`，而近 24h 净额只有 `0.0441` ——
   * 差异是绩效的 **31%**。第一版判据把分母固定为 `max(|净额|, 1)`，
   * 于是算出 1.37% 并归入"小差异"，**把该有的警惕抹掉了**。
   */
  const comparable = contextWith(blankMemory());
  comparable.account = { ...comparable.account, ledgerGap: 0.01367 };
  comparable.memory = {
    ...comparable.memory,
    performance: { ...comparable.memory.performance, netPnl: 0.0441 },
  };
  const comparableText = buildUserPrompt(comparable);
  assert.match(
    comparableText,
    /数字本身可能不准/,
    '★ 差额占绩效 31% 时必须按大差异处理，不能用固定分母把它算成 1.37%',
  );
});

test('★ 全市场概览：模型该看得见币安全部标的，而不只是候选池那 20 个', () => {
  /*
   * 用户 2026-09-30 的原话：
   *   「币安支持的币种我觉得都应该在模型判断得范围（当然不是一次性给所有币种行情数据）」
   *
   * 在此之前模型的视野**只有候选池那 20 个**（约占全市场 527 个的 3.8%），
   * 而它无从知道外面还有什么 —— 那是"只做大盘币、抓不住异动"的根源，
   * 也是"系统替模型做了决定"（用户原则：模型是大脑，系统只是手脚）。
   *
   * 这一段**不是候选**（只有符号 + 三个数字，没有指标序列），所以极便宜；
   * 模型据此发现外部世界，再点名要完整行情。
   */
  const overview = [
    { symbol: 'BTCUSDT', price: 83029.91, changePercent24h: -1.01, quoteVolume24h: 1_200_000_000 },
    { symbol: 'XYZUSDT', price: 0.0123, changePercent24h: 42.5, quoteVolume24h: 310_000_000 },
    { symbol: 'ZZZUSDT', price: 1.5, changePercent24h: -8.2, quoteVolume24h: 5_000_000 },
  ];
  const text = buildUserPrompt({ ...contextWith(blankMemory()), marketOverview: overview });

  assert.match(text, /# 全市场概览/, '要有这一段');
  /* ★ 关键：**不在候选池里的标的也必须出现** —— 这正是"扩大视野"的全部意义。 */
  assert.match(text, /XYZUSDT/, '★ 非候选标的也要出现在概览里');
  assert.match(
    text,
    /ZZZUSDT/,
    '成交额小的也要在 —— 用户要求覆盖币安全部标的（它可能开不了仓，但模型该知道它存在）',
  );
  assert.match(text, /42\.5/, '要带 24h 涨跌幅，否则看不出哪里在动');

  /* 它只增信息、不抢位置：候选区块必须原样还在。 */
  assert.match(text, /# 候选标的/, '候选池区块不受影响');

  /* 不传就不渲染 —— 向后兼容（回放/测试路径不需要它）。 */
  assert.doesNotMatch(
    buildUserPrompt(contextWith(blankMemory())),
    /# 全市场概览/,
    '不传 marketOverview 时不该凭空多出这一段',
  );
});

test('★ 市场聚焦：模型要一眼看到"哪里在动"（五个维度榜）', () => {
  /*
   * 用户 2026-09-30 的原则是「**模型是大脑，系统只是手脚**」：
   * 第 0 层「全景」让它看见全部标的，这一层告诉它**哪里在动** ——
   * 涨幅/跌幅/波动率/资金费极值/成交额，每个维度前几名。
   *
   * ⚠️ 这一层**不做任何筛选判断**：每个榜只按一个维度排序。
   * 它是"快照"，不是"推荐" —— 选哪个深看仍然是模型的事。
   */
  const rankings = {
    quoteVolume: [
      { symbol: 'BTCUSDT', value: 10_400_000_000, changePercent24h: -0.41, quoteVolume24h: 10_400_000_000 },
      { symbol: 'ETHUSDT', value: 9_600_000_000, changePercent24h: 0.02, quoteVolume24h: 9_600_000_000 },
    ],
    gainers: [
      { symbol: 'XYZUSDT', value: 42.5, changePercent24h: 42.5, quoteVolume24h: 310_000_000 },
    ],
    losers: [{ symbol: 'ABCUSDT', value: -31.2, changePercent24h: -31.2, quoteVolume24h: 200_000_000 }],
    volatility: [{ symbol: 'WILDUSDT', value: 0.45, changePercent24h: 3.1, quoteVolume24h: 150_000_000 }],
    fundingExtreme: [
      { symbol: 'FUNDUSDT', value: -0.019, changePercent24h: 2.2, quoteVolume24h: 120_000_000 },
    ],
  };
  const text = buildUserPrompt({ ...contextWith(blankMemory()), rankings });

  assert.match(text, /# 市场聚焦/, '要有这一段');
  /* 五个榜都要在，且各自的标的要出现。 */
  assert.match(text, /BTCUSDT/, '成交额榜');
  assert.match(text, /XYZUSDT/, '涨幅榜');
  assert.match(text, /ABCUSDT/, '跌幅榜');
  assert.match(text, /WILDUSDT/, '波动率榜');
  assert.match(text, /FUNDUSDT/, '资金费极值榜');
  /* 数字要带上 —— 光有符号，模型没法判断"值不值得深看"。 */
  assert.match(text, /42\.5/, '涨幅榜要带涨跌幅');
  assert.match(text, /31\.2/, '跌幅榜要带跌跌幅');

  /* 它只增信息：候选池必须原样还在。 */
  assert.match(text, /# 候选标的/, '候选池不受影响');

  /* 不传就不渲染 —— 向后兼容。 */
  assert.doesNotMatch(
    buildUserPrompt(contextWith(blankMemory())),
    /# 市场聚焦/,
    '不传 rankings 时不该凭空多出这一段',
  );
});

test('★ 持仓量增长榜：关着的时候要告诉模型"它存在、你能开"', () => {
  /*
   * 「持仓量增长」是第 1 层八个维度之一，而它的能力**早已存在**
   * （`getOiRanking()` + `screenOpenInterestGrowth()`），只是由策略参数
   * `indicators.enableOiRanking` 控制、**当前是 false**。
   *
   * ⚠️ **我不替模型打开它** —— 按用户的原则「模型是大脑，系统只是手脚」，
   * 那属于模型的判断（它能用 `set_params` 自己改）。
   * 但**它必须知道这个能力存在**，否则"能开而不知道"等于没有 ——
   * 那正是"系统把能力藏起来了"，与本项目的方向相反。
   */
  const empty = {
    quoteVolume: [],
    gainers: [],
    losers: [],
    volatility: [],
    fundingExtreme: [],
  };

  const off = buildUserPrompt({
    ...contextWith(blankMemory()),
    rankings: empty,
    oiRankingEnabled: false,
  });
  assert.match(off, /持仓量增长榜/, '要提到这个维度');
  assert.match(off, /enableOiRanking/, '★ 要点名那个参数 —— 否则它无从下手');
  assert.match(off, /关闭|false/i, '要如实说当前是关着的');

  const on = buildUserPrompt({
    ...contextWith(blankMemory()),
    rankings: empty,
    oiRankingEnabled: true,
  });
  assert.doesNotMatch(on, /当前是\*\*关闭\*\*/, '开着的时候不必再劝它开');
});

test('★ 本平台历史：告诉模型"你自己在哪些标的上赚过、哪些上总是亏"', () => {
  /*
   * 八个维度里唯一"关于自己"的一个 —— 交易所只给市场数据，
   * 而"**我**在这个标的上做过几笔、结果如何"只有平台知道。
   *
   * ⚠️ 两个方向都要给：只列"我赚过的"会让模型反复扑向同一个标的（可能是运气），
   * 而"我在这个标的上总是亏"同样有用（可能意味着它的波动特性与当前策略不合）。
   */
  const rows = [
    { symbol: 'SOLUSDT', trades: 8, netPnl: 0.42, winRate: 0.625 },
    { symbol: 'BNBUSDT', trades: 6, netPnl: -0.31, winRate: 0.333 },
  ];
  const text = buildUserPrompt({ ...contextWith(blankMemory()), platformHistory: rows });

  assert.match(text, /# 本平台历史/, '要有这一段');
  assert.match(text, /SOLUSDT/, '赚过的标的要在');
  assert.match(text, /8 笔/, '★ 必须带笔数 —— 那是"这个胜率可不可信"的唯一线索');
  assert.match(text, /BNBUSDT/, '★ 总是亏的标的也要在 —— 那是"该避开哪里"');
  assert.match(text, /笔数越少/, '要提醒样本量的意义，免得它把噪声当规律');

  /* 空数组不渲染（没有足够样本时不该凭空多一段）。 */
  assert.doesNotMatch(
    buildUserPrompt({ ...contextWith(blankMemory()), platformHistory: [] }),
    /# 本平台历史/,
  );
});

test('★ 必须把"决策周期多长"告诉模型 —— 否则它的时间规则会与实际节奏错配', () => {
  /*
   * ## 这条用例是为一次真实的"开仓就平"写的（2026-09-30）
   *
   * 模型自己写了条规则「5.5 无跟随时间止损」：**入场后第一次醒来检查时**，
   * 若峰值浮盈 < 0.25% 且当前 ≤ 0 → 市价全平。
   *
   * 而**这个机器人的周期是 30 分钟** —— 于是"第一次醒来"= 入场后约 30 分钟。
   * 实测（用最近 1000 根 5m K 线模拟"任一点入场后 30 分钟内能否浮盈 ≥0.25%"）：
   *
   *     BTCUSDT   21.3%      ← 78.7% 的情况下【必然】被判定"未获跟随"
   *     ETHUSDT   32.6%
   *     BNBUSDT   28.7%
   *     SOLUSDT   50.8%
   *
   * 用户在页面上看到的就是这个：**33 分钟开仓又平仓，毛 +0.01、手续费 0.0214、净亏**。
   * 规则本身没错（"没跟随就早退"是好纪律），**错的是它以为的"醒来"与实际周期不是一回事**。
   *
   * 把周期如实写进提示词，它才能自己算准这个时间尺度 ——
   * 这是"系统是手脚"该做的事：**给事实，不给命令**。
   */
  const text = buildUserPrompt({ ...contextWith(blankMemory()), cycleIntervalMinutes: 30 });
  assert.match(text, /决策周期/, '要说明这个机器人多久决策一次');
  assert.match(text, /30\s*分钟/, '要给出具体的分钟数 —— 否则模型无从换算');
});

test('★ 有持仓时，持仓区块必须给出「往返成本」与「止损距入场多远」', () => {
  /*
   * ## 这条用例是为 2026-09-30 的 ZECUSDT 写的
   *
   * 模型自己那类「保本/锁盈上移」规则（提示词 5.1/5.2）用**价格浮盈的百分比**做判据。
   * 它把 ZECUSDT 空头的止损从结构位 1427.5 上移到 **1412.32** —— 相对入场价 1413
   * 只锁住 **+0.048%**。而那笔的往返成本是 **0.070%**（手续费 0.0148 ÷ 名义 21.20）：
   *
   *     止损被扫掉 → 毛 +0.0042、手续费 0.0148 → **净 -0.0106**
   *
   * **数学上必然亏** —— 与方向判断对不对无关。
   *
   * 最刺眼的是模型**自己的复盘两次**都写下了正确结论
   * （「保本止损必须设在覆盖往返成本之上」），但它**决策那一刻手里没有这两个数字**：
   * 往返成本要它自己从历史成交反推，止损距离要它在脑子里换算。
   * 它在 09-30 的复盘里甚至明说「具体是原止损还是移动止损被扫，数据不足无法确定」。
   *
   * 所以系统把两个**事实**摆到它面前，判据仍然是它的。
   */
  const position = {
    position: {
      symbol: 'ZECUSDT',
      side: 'short' as const,
      entryPrice: 1413,
      markPrice: 1396.48,
      quantity: 0.015,
      notional: 21.2,
      leverage: 4,
      marginUsed: 5.3,
      unrealizedPnlPercent: 4.93,
      unrealizedPnl: 0.26,
      peakPnlPercent: 5.82,
      liquidationPrice: null,
      stopLoss: 1412.32,
      takeProfit: 1366,
    },
    snapshot: null,
    holdingMinutes: 138.6,
  };

  const text = buildUserPrompt({
    ...contextWith(blankMemory()),
    positions: [position as unknown as PromptContext['positions'][number]],
    roundTripCostPercent: 0.07,
  });

  assert.match(text, /往返成本 ≈0\.070%/, '★ 往返成本必须出现在持仓区块里');
  assert.match(
    text,
    /止损 1412\.32.*距入场 \+0\.048% 价格口径，锁盈侧/,
    '★ 止损距入场多远必须算好给它 —— 空头止损低于入场价，是锁盈侧',
  );
  /*
   * 两个数字放在一起时，读者（模型）可以直接比较：0.048% < 0.070% → 必然净亏。
   * 这正是它上一轮没能自己完成的那一步。
   */
  assert.match(text, /小于它时.*必然净亏/, '要说明这个数字的用途，而不只是罗列');
});

test('没有往返成本数据时不渲染那一行 —— 宁可不说，也不编一个默认值', () => {
  /*
   * `averageRoundTripCostPercent()` 在没有有效成交时返回 `null`。
   * 此时**不渲染**比渲染一个"行业标准 0.1%"要好：那是别处的成本，不是这个账户的。
   * 这条同样守住"不要为了好看而填充"（`docs/AGENTS.md` §3.2）。
   */
  const text = buildUserPrompt({ ...contextWith(blankMemory()), roundTripCostPercent: null });
  assert.doesNotMatch(text, /往返成本/);
});

test('★ 必须把「交易所对这个账户的实际杠杆授信」告诉模型 —— 否则换主账户后它不知道能上更高', () => {
  /*
   * ## 这条用例的来历（用户 2026-10-01 的原话）
   *
   * 「我准备用主账户交易了（没有合约 5X 限制，本金也会加到 100u 以上），
   *   你确保我使用主账户，系统能正常运作（不要无法识别 5X 以上什么的和现在一样
   *   AI 不知道能挂更高）」
   *
   * 币安的规则是：**能设的最大杠杆 = min(名义档位的 initialLeverage, 账户级限制, symbol 上限)**。
   * 而**账户级那一项对子账户是硬的** —— 官方 FAQ：新建子账户合约杠杆不超过 5x。
   * 所以同一份配置跑在主账户上能用 20x，跑在子账户上只能 5x。
   *
   * 系统其实**已经读了这个数**（`broker.getMaxLeverage()` → `leverageBracket`），
   * 但它只喂给风控引擎做钳制（`autoTrader.ts` 的 `exchangeMaxLeverageOf`），
   * **从没进过提示词**。于是模型只看到配置里写的 `最大杠杆 5x`，
   * 就**永远不会**想到"其实交易所允许更高，我可以把配置调上去"。
   *
   * 修法是把**事实**摆给它：交易所对这个账户的实际授信是多少。
   * 要不要据此调高 `btcEthMaxLeverage` / `altcoinMaxLeverage` 仍然是它的判断。
   */
  const text = buildUserPrompt({
    ...contextWith(blankMemory()),
    leverageCaps: { BTCUSDT: 5, ETHUSDT: 5, SOLUSDT: 5 },
  });

  assert.match(text, /交易所对该标的的杠杆档位上限/, '措辞要准：leverageBracket 给的是档位上限，不是账户级授信');
  assert.match(text, /BTCUSDT 5x/, '要给出具体标的与数值');
  assert.match(
    text,
    /子账户/,
    '要说明"调高后仍被压回 5x = 当前是子账户" —— 这是用户换主账户时唯一的自检依据',
  );
});

test('交易所杠杆档位读不到时不渲染那一行 —— 不猜', () => {
  const text = buildUserPrompt({ ...contextWith(blankMemory()), leverageCaps: {} });
  assert.doesNotMatch(text, /杠杆档位上限/);
});

test('★ 挂单成交统计必须出现在提示词里 —— 模型看不到自己的挂单成效', () => {
  /*
   * ## 用户 2026-10-01 的观察
   *
   * 「为什么每次开单都是限价单…而且经常挂了都无法成交，因为看不了取消记录，
   *   我估计都是挂了又取消根本没成交，怎么奇奇怪怪的感觉，
   *   好像在浪费时间和 token，浪费服务器资源」
   *
   * **他的估计完全正确**：限价入场单 78 撤 / 44 成交 = **撤单率 64%**，市价单 100% 成交。
   *
   * 模型知道"挂满 45 分钟会自动撤"，但它**从没看到**"我过去挂的单六成都没成交"。
   * 于是它每轮都在重复同一个动作 —— 而纠正它需要的只是把这个统计摆出来。
   */
  const text = buildUserPrompt({
    ...contextWith(blankMemory()),
    entryStats: {
      limitFilled: 44,
      limitCanceled: 78,
      limitRejected: 0,
      marketFilled: 19,
      fillRatePercent: 36.065573770491806,
      avgCanceledWaitMinutes: 45,
      canceledWouldFillPercent: 80,
      canceledChecked: 10,
    },
  });

  assert.match(text, /我的挂单成效/, '要有这一段');
  assert.match(text, /成交 44 张 \/ 撤单 78 张/, '两个数字都要给，不能只给比例');
  assert.match(text, /成交率 36%/, '给成交率');
  assert.match(text, /平均等了 45 分钟/, '撤单等了多久 —— 判断"是不是差一点就成交"');
  /*
   * ★ 不许再说"系统上限是 N 分钟"。
   *
   * 挂单时限早就是自适应的（按挂价距离与 ATR 推算）。而同一段里再写一个固定上限，
   * 实测线上出现过自相矛盾的一行：
   *
   *     被撤的那些**平均等了 187 分钟**（系统上限是 45 分钟）
   *
   * 187 > 45 —— 读起来像系统自己坏了，而模型据此判断"该等多久"时会用错基准。
   */
  assert.doesNotMatch(text, /系统上限是 \d+ 分钟/, '★ 时限是自适应的，不能再写一个固定上限');
  assert.match(text, /自适应/, '要说清时限是按什么算的');
  assert.match(text, /不是建议/, '要说明这只是统计，判据仍然是它的');
  /*
   * ★ 这一列推翻了原来那句话（"撤单是因为挂价离市价偏远"）。
   *
   * 实测最近 10 张被撤的限价单：8 张的价格**后来确实回到了挂价位**。
   * 所以真正的结论是"价挂对了、撤得太早" —— 而一个错的归因会让它
   * 去把挂价挪近，越改越偏。
   */
  assert.match(text, /后来又被价格碰到了/, '★ 要给出"撤单后价格又回来了"的比例');
  assert.match(text, /撤得太早/, '★ 要点出真正的症结是耐心，不是挂价');
  assert.doesNotMatch(
    text,
    /说明\*\*挂价离当时的市价偏远\*\*/,
    '★ 那句被数据推翻的归因必须删掉',
  );
});

test('没有限价单样本时不渲染挂单成效 —— 0% 与"还没挂过"是两件事', () => {
  const text = buildUserPrompt({
    ...contextWith(blankMemory()),
    entryStats: {
      limitFilled: 0,
      limitCanceled: 0,
      limitRejected: 0,
      marketFilled: 3,
      fillRatePercent: null,
      avgCanceledWaitMinutes: null,
      canceledWouldFillPercent: null,
      canceledChecked: 0,
    },
  });
  assert.doesNotMatch(text, /我的挂单成效/);
});

test('★ 挂单区块必须显示「挂价离现价多远」并告诉模型它【现在就能撤单】', () => {
  /*
   * ## 两个真缺陷（用户 2026-10-01：「13 小时 0 成交」）
   *
   * 实测：最近 20 轮里模型开单 6 次，**全部挂限价单、全部超时被撤**（撤单率 64%）。
   * 日志里那句是典型：
   *
   *     06:04:18 SOLUSDT 的限价挂单已等满 62 分钟（上限 45）仍未成交，已自动撤掉
   *
   * ### 缺陷 1：提示词自相矛盾，把"能撤单"说成"下一步才给"
   *
   * 挂单区块原来的结尾写着「**下一步我会给你撤单的能力**；在那之前，用 `wait` 说明你的判断即可」。
   * 而 `cancel_pending` **早就实现了**（同一个提示词的另一处就给了它的 JSON 范例）。
   * 于是模型以为自己只能干等时限 —— 而它明明可以立刻撤掉、把名额让给别的机会。
   *
   * ### 缺陷 2：看不到"挂价离现价多远"
   *
   * 挂单区块只给了挂价、数量、已等多久。而**能不能成交**取决于
   * "挂价与市价的距离 vs 这段时间市场能走多远" —— 后者它有 ATR，
   * 前者系统从没给过。缺了它，模型无法判断"我这个挂法现不现实"。
   */
  const snapshotSol = snapshot('SOLUSDT', 120);
  const text = buildUserPrompt({
    ...contextWith(blankMemory(), [snapshotSol]),
    pendingEntries: [
      {
        symbol: 'SOLUSDT',
        side: 'long',
        limitPrice: 118.53,
        quantity: 1,
        stopLoss: 116,
        takeProfit: 126,
        waitingMinutes: 62,
        reasoning: '回踩 15m EMA20',
      },
    ] as unknown as PromptContext['pendingEntries'],
  });

  /*
   * 措辞是「挂价**低于**现价 X%」而不是带正负号的「距现价 -X%」：
   * 做多挂低价、做空挂高价都是"等价格回来"，用一个方向词比一个符号更难读错。
   */
  assert.match(text, /挂价低于现价 1\.2/, '★ 要算出"挂价离现价多远"');
  assert.match(text, /价格要先走这么多才可能成交/, '要说明这个距离意味着什么');
  assert.match(text, /`cancel_pending`/, '★ 要明确它现在就能撤单');
  assert.doesNotMatch(text, /下一步我会给你撤单的能力/, '★ 那句过期的话必须删掉');
  assert.doesNotMatch(text, /下一步我会给你撤单的能力/, '★ 那句过期的话必须删掉');
});

test('★ 挂单区块必须把「挂价距离」与「这段时间价格预期能走多远」放在一起', () => {
  /*
   * ## 为什么光给"成交率 29%"不够（2026-10-01 实测）
   *
   * 上一轮我把「我的挂单成效」加进了提示词（成交 24 / 撤单 58 → 29%），
   * 而**最近 6 轮的思考里一次都没提过它** —— 模型看到了数字，但照旧挂限价。
   *
   * 因为它缺的不是"结果"，是**那笔账**：
   *
   *     我挂的价位离现价 1.225%
   *     而按当前 15m ATR，45 分钟内价格预期只能走约 0.3%
   *     → 这个价位等不到
   *
   * 前一个数我上一轮给了，后一个数**它有 ATR 但没人替它换算**。
   * 两个数放在同一行，比较就是一眼的事。
   *
   * ⚠️ 只给两个数字，**不给结论** —— "这个价位值不值得等"仍然是它的判断
   * （用户的原则：模型是大脑，系统只是手脚）。
   */
  const snapshotSol = snapshot('SOLUSDT', 120);
  const text = buildUserPrompt({
    ...contextWith(blankMemory(), [snapshotSol]),
    pendingEntries: [
      {
        symbol: 'SOLUSDT',
        side: 'long',
        limitPrice: 118.53,
        quantity: 1,
        stopLoss: 116,
        takeProfit: 126,
        waitingMinutes: 20,
        reasoning: '回踩 15m EMA20',
      },
    ] as unknown as PromptContext['pendingEntries'],
  });

  assert.match(text, /挂价低于现价 1\.2/, '挂价距离');
  /*
   * ⚠️ **断言口径在 2026-10-08 改了，因为原来那个数会骗人。**
   *
   * 原文是「45 分钟内价格预期能走约 0.3%」—— 而 45 只是**基础值**，
   * 真正撤单时用的是 `max(基础值, 预期所需 × 1.5)` 封顶 480。
   * 实测一张距离 1.56%、ATR 0.21% 的单真实上限顶到 480，而提示词告诉它 15 分钟 ——
   * 那是把模型往"这价位等不到、改用市价"推，方向正好相反。
   *
   * 所以现在钉两件事：**预期需要多久**，以及**这张单实际会给多久**。
   */
  assert.match(text, /预期需要约/, '★ 要给它"走到这个价位预期需要多久"');
  assert.match(text, /系统会给这张单/, '★ 还要给它"这张单实际会拿到多久"—— 否则那个基础值会骗它');
});

test('★ 时限必须按【这张单实际会拿到多久】说，而不是配置里的基础值', () => {
  /*
   * 用户 2026-10-08 的连环问题：「开单大多都是限价单，很多都是超时/超越预期价位，
   * 导致错失机会，模型自己知道吗？如果知道他会改吗？」
   *
   * 查下来它知道（成交率与"撤后又被碰到"都写在提示词里），但它**改不动** ——
   * 而且系统还在给它一个**错的时间预算**：说"基础值 N 分钟"，实际撤单器给的是
   * `max(基础值, 预期所需 × 1.5)`（封顶 480）。
   *
   * 这条用例钉住：**两个数都要出现**（预期需要多久 + 这张单实际会给多久）。
   */
  const snapshotSol = snapshot('SOLUSDT', 120);
  const base = buildUserPrompt({
    ...contextWith(blankMemory(), [snapshotSol]),
    pendingEntries: [
      {
        symbol: 'SOLUSDT',
        side: 'long',
        limitPrice: 118.53,
        quantity: 1,
        stopLoss: 116,
        takeProfit: 126,
        waitingMinutes: 20,
        reasoning: '回踩 15m EMA20',
        waitMinutes: null,
      },
    ] as unknown as PromptContext['pendingEntries'],
  });
  assert.match(base, /预期需要约/, '预期所需时间');
  assert.match(base, /系统会给这张单/, '★ 有效时限（不是基础值）');

  /* 模型自己申请了更久时，那个数要体现在"实际会给多久"里。 */
  const asked = buildUserPrompt({
    ...contextWith(blankMemory(), [snapshotSol]),
    pendingEntries: [
      {
        symbol: 'SOLUSDT',
        side: 'long',
        limitPrice: 118.53,
        quantity: 1,
        stopLoss: 116,
        takeProfit: 126,
        waitingMinutes: 20,
        reasoning: '回踩 15m EMA20',
        waitMinutes: 300,
      },
    ] as unknown as PromptContext['pendingEntries'],
  });
  assert.match(asked, /你要求等 300 分钟/, '★ 它自己申请过的耐心要回显 —— 否则它记不住自己说过');
});

test('★ 连续多轮 0 开仓必须说出来 —— 规则只增不减会让它最终排除一切', () => {
  /*
   * ## 模型自己的排除理由暴露出一个结构性缺陷（2026-10-01）
   *
   * 它逐轮排除候选，理由都很具体、也都站得住：
   *
   *     BTC：名义下限 $50，当前权益下取整 0 张
   *     ETH/XRP/NEAR：15m RSI 90/89/85，动能 climax
   *     ENA/PUMP/QNT：1.5×ATR 止损超类别带 1.4%
   *     SOL/HYPE/SUI：4h MACD hist 负
   *     WLD/SOON：15m/1h 与 4h 方向不一致
   *
   * 每一条都是**亏损复盘后加上的**。而规则**只增不减** ——
   * 它每次学到的都是"这类情况别做"，于是可做集合单调收缩。
   * 实测：连续 10+ 轮 0 开仓、最近一次成交在 21 小时前。
   *
   * 系统在这里不该替它删规则（那是它的判断），但必须把**这个事实**摆出来 ——
   * 它看不到"我已经连续 N 轮什么都没做"，因为每一轮的思考都是**局部**的。
   */
  const text = buildUserPrompt({
    ...contextWith(blankMemory()),
    idleCycles: 10,
    idleNetPnl: -0.04,
  });

  assert.match(text, /连续 10 轮/, '要给出连续的轮数');
  assert.match(text, /没有开过一次仓|0 开仓|一笔都没有/, '要明确说"什么都没做"');
  assert.match(
    text,
    /规则|门槛|过严|审视/,
    '要提示它去看自己的规则 —— 但仍然让它自己决定改不改',
  );
});

test('没有连续空转时不渲染那一段 —— 不制造噪声', () => {
  const text = buildUserPrompt({ ...contextWith(blankMemory()), idleCycles: 0 });
  assert.doesNotMatch(text, /连续 \d+ 轮/);
});

test('★ 连续观望时要把它自己的「规则规模」也报出来 —— 它没有刻度', () => {
  /*
   * ## 量化证据（2026-10-01）
   *
   * `agent_experiments` 每分钟记录一次"当前参数"，其中包含模型自己写的
   * `promptSections`。它的长度是：
   *
   *     #14  2026-09-20   1,841 字符
   *     ...
   *     #46  2026-09-30   9,618 字符      ← 增长 5.2 倍
   *
   * 同期开单率：09-26 是 48% → 10-01 是 8%。
   *
   * 「每次亏损复盘加一条规则」本身是对的，但**模型没有刻度** ——
   * 它看不到"我的规则已经比九天前大了五倍"，也看不到"这些规则合起来
   * 已经把市场里几乎所有情况都排除了"。给出规模，它才能自己判断要不要瘦身。
   */
  const text = buildUserPrompt({
    ...contextWith(blankMemory()),
    idleCycles: 8,
    ruleSizeChars: 6921,
    ruleCount: 5,
  });

  assert.match(text, /6,?921/, '要给出规则的字符规模');
  assert.match(text, /5 条/, '要给条数 —— 两个刻度比一个更难被忽略');
  assert.match(text, /只增不减|没有刻度|瘦身/, '要说明这件事意味着什么');
});

test('没有规则规模数据时不渲染那一行 —— 不编数字', () => {
  const text = buildUserPrompt({ ...contextWith(blankMemory()), idleCycles: 8 });
  assert.doesNotMatch(text, /规则的规模|规则的字符/);
});

test('★ 完整序列的数量必须有硬上限 —— 否则大请求会撞上网关的 100 秒超时', () => {
  /*
   * ## 决定性证据（2026-10-01，`HTTP 524`）
   *
   * 线上连续出现 `AI 服务不可用：服务商 5xx（HTTP 524）`，一轮 8 轮里 4 次失败。
   *
   * **`524` 不是"服务商 5xx"** —— 它是 **Cloudflare 的"源站超时"**：
   * 网关等了 **100 秒**都没拿到上游响应，于是放弃。而我们的请求实测耗时
   * **60–205 秒**（`#1772` 332 秒）—— **撞上它几乎必然**。
   *
   * 所以把 `timeout_seconds` 提到 600 秒**没有用**：那个限制在客户端，
   * 而中间的网关 100 秒就断了。**根因是请求太大 → 上游推理太久。**
   *
   * 一个 190K token 的请求里 **90% 是候选池**（每个候选的完整多周期序列约 10,600 字符），
   * 而提示词自己写着「**模型通常只深入看 1–2 个**」。
   *
   * ## 为什么这样可以减而不损失能力
   *
   * 用户对候选池的要求是「15-20 个完整多周期行情」—— **20 个标的仍然全部在**，
   * 只是"完整序列"给前 N 个，其余给**摘要**（最新值 + 最近 5 根走向），
   * 并且明确告诉它**想要哪个就用 `get_klines` 点名**（那段说明本来就在）。
   *
   * 也就是说：**信息没删，深度按需**。而换来的是**一半的轮次不再白费**。
   */
  const config = defaultStrategyConfig();
  /* 一个"上下文巨大、预算充裕"的配置不该让每个候选都吃完整序列。 */
  const count = detailedCandidateCount(config, 10_000_000, 20);
  assert.ok(
    count <= DETAILED_HARD_CAP,
    `完整序列数 ${count} 超过硬上限 ${DETAILED_HARD_CAP} —— ` +
      '20 个候选 × 10.6K 字符的请求会撞上网关超时',
  );
  assert.ok(DETAILED_HARD_CAP >= 5, '不能低于原来的 5 —— 那会让这个改动变成纯削减');
  assert.ok(
    DETAILED_HARD_CAP < 20,
    '必须真的低于候选池上限，否则这条约束没有任何作用',
  );
});

test('★ 连续观望时给出候选的波动率分布 —— 它只看逐个排除，从不统计"过了几个"', () => {
  /*
   * ## 实测（2026-10-01）
   *
   * 它连续 8 轮全 skip，每轮把 20 个候选逐个排除，理由都成立
   * （"BTC 名义不够"、"ETH RSI 90 climax"、"方向不一致"…）。
   *
   * 而我用真实行情算了一遍它最硬的那条门槛（`1.5×ATR 止损 ≤ 类别上限 1.4%`
   * ⇒ **ATR ≤ 0.93%**）：
   *
   *     成交额前 60 个标的：**43 个满足（72%）**，中位 ATR 只有 **0.667%**
   *     BTCUSDT 0.252% / ETHUSDT 0.328% / BNBUSDT 0.241% 都远在带内
   *
   * **也就是说"市场里没有机会"这个隐含前提是错的。** 它在逐个排除时看得到每个
   * 标的的不合格之处，却看不到"整体上合格面其实很宽" —— 那是视角的盲区。
   *
   * 系统不该替它做决定，但可以给它**这个统计**。
   */
  const candles = Array.from({ length: 20 }, (_, i) => snapshot(`SYM${i}USDT`, 100 + i));
  const text = buildUserPrompt({
    ...contextWith(blankMemory(), candles),
    idleCycles: 8,
  });

  assert.match(text, /15m ATR/, '要给出波动率的分布');
  assert.match(text, /中位/, '中位数比极值更能说明"整体上宽不宽"');
  assert.match(text, /合格|可做|门槛/, '要把它和"入场门槛"联系起来');
});

test('★ 不许再给「不做也算合格」的免责出口，且结论处必须提醒它有工具', () => {
  /*
   * ## 用户的原话（2026-10-02）
   *
   * 「不是**系统喂给 AI 什么，AI 就只能定时定点的去做**，这不是智能，也不是 AI，
   *   这是传统机器人了。」
   *
   * ## 实测证据（最近 200 轮）
   *
   *     screen_symbols         出现在 0 轮
   *     get_klines             出现在 0 轮
   *     request_deep_analysis  出现在 0 轮
   *     list_candidates        出现在 0 轮
   *
   * **我造的"手脚"，它一次都没用过。**
   *
   * ## 两个成因（其中一个我最初诊断错了，这里记下修正）
   *
   * 1. **「返回 `[]`…都是完全合格的答案」** —— 系统亲口告诉它"不做没问题"。
   *    而一个把"不做"定义为合格的系统，**必然得到"不做"**。
   *    这是**确凿的、在 user 提示词最后 490 字符里**的问题。
   *
   * 2. ~~工具说明在候选池之后~~ —— **这条我最初判断错了**：工具说明在 **system**
   *    （位置 15,847 / 18,204），而 system **整块**在 user 之前。所以它确实"读到了"。
   *    真正的问题是**时机与显著性**：它读工具说明是在 18K 固定前缀的后段，
   *    然后要穿过**11 万字符的候选池**（占 user 的 83%）才做结论 ——
   *    到那时"你可以主动要数据"早已不在近处，而**最后一句话**是"不做也可以"。
   *
   * ## 修法
   *
   * · 删掉免责句，改成"观望必须是一个**结论**，不是默认值"；
   * · 在**结论处**（它真正要落笔的地方）提醒工具箱存在，并说清
   *   **"找机会"是它的工作，不是系统的。**
   */
  const text = buildUserPrompt(contextWith(blankMemory()));

  assert.doesNotMatch(text, /都是完全合格的答案/, '★ 免责出口必须删掉');
  assert.match(text, /职责是找到|找机会是你的工作|发现机会是你的/, '★ 要说清"找机会"是它的职责');

  /*
   * 结论处必须点名工具箱 —— 断言"你的任务"这一段里提到过 `screen_symbols`。
   * 只断言全文含工具名是不够的：system 里有完整目录，而问题恰恰是
   * **它做结论的时候已经翻过十一万字符了**。
   */
  const taskIdx = text.lastIndexOf('# 你的任务');
  assert.ok(taskIdx > 0, '要有「你的任务」这一段');
  const task = text.slice(taskIdx);
  assert.match(
    task,
    /screen_symbols|get_klines|工具箱/,
    '★ 「你的任务」里必须提醒它手上有工具 —— 否则它读完十一万字符只会记得"不做也可以"',
  );
  assert.match(task, /扫过|试过|主动/, '要让它先自问"我是真的扫过了，还是只看了系统给的这些"');

  /*
   * ⚠️ **"下一次什么时候再看盘"也必须写在它落笔的地方。**
   *
   * 用户 2026-10-02：「会像真人一样，**决定何时做什么事情**。」
   * 而这层能力只有被它看见才会被用 —— 写在 system 的格式说明里
   * 离它落笔太远（中间隔着 11 万字符的候选池）。
   */
  assert.match(task, /next_check_in_minutes/, '★ 要告诉它可以自己定下一次看盘的时间');
  assert.match(task, /1–120|120 分钟/, '要给出允许范围，否则它会写一个越界的值');
});

test('★ 连续观望时要把「它覆盖掉的那条系统默认原则」摆回它面前', () => {
  /*
   * ## 2026-10-02：这是"长期全观望"的**机制性**成因
   *
   * 渲染逻辑是：
   *
   *     `# 入场标准\n${config.promptSections.entryStandards.trim() || DEFAULT_ENTRY_STANDARDS}`
   *
   * `||` 意味着**它自己写的那版会整个替换掉系统默认**（不是补充）。
   *
   * 而系统默认里有一条**专门为这个现象写下的**原则：
   *
   *   「**机会是分档的，不是"合格 / 不合格"两档。**」
   *
   * 它自己的注释里记着上一次同样的病 —— 连现象都逐字重合：
   *
   *   「实测：一个机器人连续 15 个周期、0 笔决策，而每一轮的推理都长达一千多字…
   *     结论一律是"没有一个能让我有底气向风控经理辩护"。
   *     **它的推理没问题，缺的是"小仓也是参与"这个选项。**」
   *
   * 那台机器人当时的 `entryStandards` 是空的（默认生效，所以有这一条）。
   * 而现在这台**自己写了 3,041 字符**，把这一条覆盖掉了 —— 于是同样的病复发，
   * 而它不可能记得自己什么时候去掉的那一条。
   *
   * 系统不替它改规则（用户的原则：模型是大脑），但**事实必须摆出来**。
   */
  const config = defaultStrategyConfig();
  const text = buildUserPrompt({
    ...contextWith(blankMemory()),
    idleCycles: 11,
    config: { ...config, promptSections: { ...config.promptSections, entryStandards: '我自己写的入场标准' } },
  });

  assert.match(text, /覆盖了系统默认/, '要指出它覆盖了默认那一版');
  assert.match(text, /分档/, '要把被覆盖掉的那条原则本身给出来');
  assert.match(text, /小仓|最小仓位/, '"小仓也是参与"是那条原则的核心');
  assert.match(text, /你自己的判断/, '仍然由它决定要不要写回去 —— 系统只给事实');
});

test('它没写 entryStandards（用默认）时不该渲染那段 —— 没有覆盖就没有提醒', () => {
  const config = defaultStrategyConfig();
  const text = buildUserPrompt({
    ...contextWith(blankMemory()),
    idleCycles: 11,
    config: { ...config, promptSections: { ...config.promptSections, entryStandards: '' } },
  });
  assert.doesNotMatch(text, /覆盖了系统默认/);
});

test('★ 系统要把「它自己规则联立后的解空间」算给它看', () => {
  /*
   * ## 2026-10-02：这是"长期全观望"的算术成因
   *
   * 它的 `entryStandards` 里三条硬约束互相咬合：
   *
   *   1. 单笔风险 ≤ 权益 2%；
   *   2. 止损 ≥ 1.5 × ATR14(15m)；
   *   3. 止损上限 = 风险预算 ÷ (名义 × 1.5)。
   *
   * 联立 2 与 3 → **ATR ≤ 上限 ÷ 1.5**。
   *
   * 实测（权益 21.92）：上限 = 0.44 ÷ (21 × 1.5) = 1.40% → **ATR ≤ 0.93%**。
   * 再叠加磁吸位缓冲 + 盈亏比 3 + 15m/1h 同向 + 两条独立证据，20 个候选里满足全部的是 **0 个**。
   *
   * 它每轮都在手算这道题，但**算到"这个不行"就停下** —— 看不见"空集是我自己的
   * 规则与风险参数共同造成的，而这两样都在我权限里"。系统把这道账算完并写出来。
   */
  const config = defaultStrategyConfig();
  /* 构造一批 ATR 普遍偏大的候选 —— 让它落在"几乎没有解"那一档。 */
  const wide = Array.from({ length: 20 }, (_, i) => snapshot(`SYM${i}USDT`, 100));
  const text = buildUserPrompt({
    ...contextWith(blankMemory(), wide),
    idleCycles: 11,
    config: {
      ...config,
      promptSections: { ...config.promptSections, entryStandards: '我自己写的入场标准' },
    },
  });

  assert.match(text, /先算一条最容易被忽略的硬门槛/, '要说明这是哪条门槛');
  assert.match(text, /单笔风险预算/, '要给出风险预算这个数');
  assert.match(text, /ATR 必须 ≤|ATR 在这个上限以内/, '要给出 ATR 上限这个结论');
  /*
   * ★ 这条是**准确性**的关键：实测 `#1813` 算出"13 个可做"而模型仍全观望 ——
   * 因为真正卡住它的是"方向一致 / 磁吸位 / 盈亏比 / 证据数量"，而这段没算那些。
   * 一个自称"联立了全部约束"却只算了一条的段落，会让模型以为
   * "13 个都合格而我什么都没做" —— **那是在制造假事实**。
   */
  assert.match(
    text,
    /这只是一条门槛|不等于/,
    '★ 必须声明"只算了一条门槛"，否则它会把这 N 个当成"N 个合格机会"',
  );
  /*
   * ★ 这张对照表是最后一块钥匙：把"那个 2%"的后果摊开。
   *
   * 实测（权益 21.9、名义 21）：
   *   2% → 止损带 1.38% → ATR ≤0.92%   ← 它现在用的
   *   5% → 止损带 3.45% → ATR ≤2.30%
   *  10% → 止损带 6.89% → ATR ≤4.60%
   *
   * 而它自己的止盈单平均要走 3.648%（随机游走口径下，ATR 0.92% 的标的需要约 3.75 小时，
   * 而它的止盈平均 77 分钟就到）—— **"只选低波动"与"要赚 3.6%"在数学上互相排斥**。
   *
   * 那个占比是它 `entryStandards` 里的数、是它权限内的东西。系统只给算术。
   */
  assert.match(text, /单笔风险占比|风险预算/, '要给出可调的旋钮');
  assert.match(text, /互相排斥|不相容/, '★ 要点出"低波动"与"3.6% 止盈"不相容');
  assert.match(text, /是你自己的判断|由你判断/, '仍然由它决定，系统只给算术');
});

test('★ 绩效里必须按「平仓原因」分组 —— 钱是在哪一类里漏掉的，它现在看不见', () => {
  /*
   * ## 用户 2026-10-02 的直观感受
   *
   *   「AI 是瞎子、傻子，**看不清订单**（开单又马上平仓，平白磨损）」
   *
   * 而实测（全历史 63 笔）数据是：
   *
   *     take_profit            3 笔  3胜  净 +2.2149  均持仓 77分  平均价格变动 3.648%
   *     protection_unavailable 5 笔  5胜  净 +0.5433  均持仓 80分  平均 0.855%
   *     stop_loss             38 笔 17胜  净 -0.8691  均持仓147分  平均 0.658%（毛 -0.28 / 费 0.58）
   *     model_decision        12 笔  4胜  净 -0.5524  均持仓 81分  平均 0.412%（毛 -0.37 / 费 0.18）
   *     drawdown_guard         5 笔  3胜  净 -0.1956  均持仓149分  平均 0.359%
   *
   * **它现在只看到"整体绩效"那一行数字** —— 看不到"钱是在哪一类里漏掉的"。
   * 而这张表把答案摆得很清楚：**赚钱的单子是价格走得多的那些（3.6%）**，
   * 而它主动平仓的单子平均只走了 0.4%，扣掉 0.07–0.1% 的往返成本所剩无几。
   *
   * 系统只给这张表，不给结论 —— 要不要改自己的退出规则是它的判断。
   */
  const memory = blankMemory();
  memory.performance.byCloseReason = [
    { reason: 'take_profit', trades: 3, wins: 3, netPnl: 2.2149, avgHoldMinutes: 77, avgMovePercent: 3.648 },
    { reason: 'model_decision', trades: 12, wins: 4, netPnl: -0.5524, avgHoldMinutes: 81, avgMovePercent: 0.412 },
    { reason: 'stop_loss', trades: 38, wins: 17, netPnl: -0.8691, avgHoldMinutes: 147, avgMovePercent: 0.658 },
  ];
  const text = buildUserPrompt(contextWith(memory));

  assert.match(text, /平仓原因/, '要有按平仓原因的分组');
  assert.match(text, /take_profit/, '要列出具体原因');
  assert.match(text, /3\.6|3\.648/, '要给出"赚钱那类的价格变动"');
  assert.match(text, /0\.4|0\.412/, '要给出"它主动平仓那类的价格变动" —— 对比才有信息量');
  /*
   * ★ 这个读法点破了"平仓太早"这个直觉的错处。
   *
   * 实测：主动平仓 14 笔均持仓 74 分钟 / 幅度 0.396%，止盈 3 笔均持仓 77 分钟 / 幅度 3.648%
   * —— **持仓时长几乎一样，幅度差 9 倍**。所以差别不在"什么时候平"，
   * 而在"入场时挑中的机会能不能走得动"。
   */
  assert.match(
    text,
    /两列之间|持仓时长接近/,
    '★ 要提示"时长接近而幅度差很多 → 差别在入场选择"，否则它会一直去改出场规则',
  );
});

test('没有已平仓交易时不渲染分组表 —— 不编造', () => {
  const text = buildUserPrompt(contextWith(blankMemory()));
  assert.doesNotMatch(text, /按平仓原因/);
});

test('★ 两栏 customPrompt 都要渲染 —— 防止误写到 promptSections 时被静默丢弃', () => {
  /*
   * ## 先说清这一段**不是**在修一个既有 BUG（我一度误判，这里记下来）
   *
   * 我最初以为"模型把长期指示写进了 `promptSections.customPrompt`，而系统不读"。
   * **那是错的。** `promptSections` 的 schema 只有四个字段
   * （`roleDefinition` / `tradingFrequency` / `entryStandards` / `decisionProcess`），
   * 而 `customPrompt` 一直是**顶层**字段 —— 工具说明里那句
   * "promptSections.… , **and customPrompt**" 里的 `customPrompt` 就是顶层那个。
   *
   * 数据库里那 629 字符的 `promptSections.customPrompt` 是**我自己**误写进去的
   * （备份文件证明它原本是 0）。
   *
   * ## 那为什么仍然保留"两栏都读"
   *
   * 因为**误写的代价是静默的**：字段名同名、顶层那栏还照常有内容（来自策略层继承），
   * 于是一份写错位置的文本会**无声无息地不生效**，而写的人以为自己已经下过指示。
   * 这正是本项目最忌讳的那类缺陷。读两栏的成本是一行代码，
   * 而它保证"无论写在哪一栏，都会被看见"。
   */
  const base = contextWith(blankMemory());
  const text = buildSystemPrompt({
    ...base,
    config: {
      ...base.config,
      customPrompt: '账户所有者的指示',
      /* 故意写一个 schema 之外的同名字段 —— 模拟"误写"。 */
      promptSections: {
        ...base.config.promptSections,
        customPrompt: '误写到 promptSections 里的文本',
      } as typeof base.config.promptSections,
    },
  });

  assert.match(text, /账户所有者的指示/, '顶层那一栏必须渲染');
  assert.match(
    text,
    /误写到 promptSections 里的文本/,
    '★ 即使写在 schema 之外的同名字段里，也必须被看见 —— 否则是静默丢弃',
  );
  assert.match(text, /你自己写下的长期指示/, '要标明归属，让它知道那一段可以改也可以删');
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
    byCloseReason: [],
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

test('★ 60 点必须比 30 点更重 —— 上限不该在 30 处截断', () => {
  /*
   * 上面那条用例只测到 **30**，所以它发现不了这件事：`MAX_RENDER_POINTS`
   * 原来就是 **30**，而 schema 允许 `promptPoints` 到 **120**。
   *
   * 后果是 AI 把 `promptPoints` 调到 60（它以为在"加厚历史依据"）时，
   * **渲染出来的点数一根都不会变** —— 而 `prompt.ts` 上那段注释记着，
   * 它会把这件事记成"我加厚了历史依据"并据此归因。**一个静默失效的参数
   * 比一个不存在的参数更糟**：后者它不会去调。
   *
   * 那个 30 诞生于 `PROMPT_TOKEN_CEILING` 还是 20 万的年代；现在预算按模型能力
   * 算（1M 的模型拿到 80 万），实测算过 20 个候选全给 120 点也仍在预算内。
   * 所以上限抬到与配置允许范围一致，"撑爆"交给 `buildUserPromptParts()`
   * 那道裁剪循环 —— **那一层才是唯一该管预算的地方**。
   */
  const base = configFromPreset('conservative');
  const withConfig = (points: number): StrategyConfig => ({
    ...base,
    indicators: {
      ...base.indicators,
      /* `primaryCount` 要给足，否则被它先截断，测不到 `MAX_RENDER_POINTS` 这一层。 */
      kline: { ...base.indicators.kline, promptPoints: points, primaryCount: 300 },
    },
  });

  const at30 = estimateCandidateChars(withConfig(30));
  const at60 = estimateCandidateChars(withConfig(60));
  const at120 = estimateCandidateChars(withConfig(120));

  assert.ok(
    at60 > at30,
    `60 点必须比 30 点更重（30 点 ${at30} 字、60 点 ${at60} 字）—— 否则上限仍卡在 30`,
  );
  assert.ok(at120 > at60, `120 点同理（60 点 ${at60} 字、120 点 ${at120} 字）`);
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
  /*
   * ⚠️ **光有"你可以改"不够 —— 实测它一次都没改过。**
   *
   * AI 的覆盖层里 `marginMode` 与策略基线**一字不差**，而那段"这是起点、不是规定"
   * 早就在提示词里了。缺的不是许可，是**判据**：什么时候该换、什么时候别换。
   *
   * 同一个模式在别处也出现过（`add_to_position` / `reduce_position`：范例齐全、
   * 使用 0 次）。所以这两条断言守的是"判据"和"不让它默认滑过去"的那个动作。
   */
  assert.ok(
    /什么时候值得考虑改成全仓/.test(text) && /什么时候保持逐仓/.test(text),
    '★ 保证金模式必须给**判据**（何时换 / 何时不换）—— 只说"你可以改"实测等于没改',
  );
  assert.ok(
    /每次复盘时用一句话说明/.test(text),
    '★ 要有"不能默认滑过去"的动作：复盘时说一句维持/改变它的理由',
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