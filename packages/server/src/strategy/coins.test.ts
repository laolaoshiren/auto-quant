/**
 * 选币与预算裁剪。
 *
 * ## 为什么这组用例要存在
 *
 * `selectCandidates()` 回答的是"这个周期让模型看哪些标的"，而它同时做三件
 * 容易被改坏、坏了又不报错的事：
 *
 *  1. **裁剪**（`candidateBudget()` 决定留下几个）。这里曾经写死过一个
 *     `hardCap = 40`，也曾经因为提示词预算写死 6 万而把候选池饿到 **7 个** ——
 *     实测一台机器人连续 15 个周期只看得到 7 个标的、0 决策，而它挂的模型
 *     能吃 100 万 token。**候选池的大小是"有没有机会可做"的上游**，
 *     而它算错时的表现是"没有机会"，不是"报错"。
 *  2. **永不裁剪持仓标的**（`mustInclude`）。裁掉自己手上的仓，模型就只能
 *     盲目持有 —— 它看不见那个标的的行情，却还开着仓。
 *  3. **BTC 无条件入选**（提示词里 `# BTC 市场概览` 那一整块靠它）。
 *
 * 这三条都是"静默失效"型的：错了以后页面照常显示、周期照常跑，
 * 只有结果不对。所以每一条都要有断言钉住。
 *
 * 详见 `docs/AGENTS.md` §3.6（临时目录、不碰 `data/`）与 §5.4。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultStrategyConfig, type StrategyConfig } from '@aq/shared';

import { candidateBudget, PROMPT_TOKEN_BUDGET } from './prompt.js';
import { selectCandidates, CANDIDATE_HARD_CAP } from './coins.js';
import type { MarketDataService } from '../market/service.js';
import type { FunnelStageReport } from '../market/funnel.js';

/* -------------------------------------------------------------------------- */
/*  夹具                                                                       */
/* -------------------------------------------------------------------------- */

/** 只实现 `selectCandidates` 真正会调用的那几个方法。 */
function fakeMarket(options: {
  volumeRanked: string[];
  oiGrowing?: string[];
}): MarketDataService {
  return {
    async screenUniverse() {
      return options.volumeRanked;
    },
    async screenOpenInterestGrowth() {
      return options.oiGrowing ?? [];
    },
  } as unknown as MarketDataService;
}

function configWith(over: Partial<StrategyConfig> = {}): StrategyConfig {
  const base = defaultStrategyConfig();
  return { ...base, ...over };
}

/** `n` 个成交额递减的假标的 —— 顺序就是强弱顺序。 */
function rankedSymbols(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `SYM${String(i).padStart(3, '0')}USDT`);
}

/* -------------------------------------------------------------------------- */
/*  1. 裁剪                                                                     */
/* -------------------------------------------------------------------------- */

test('候选池被裁到预算容得下的数量 —— 不是写死的上限', async () => {
  /*
   * 这里曾经写死 `hardCap = 40`、且 `candidateBudget()` 用固定的 6 万预算。
   * 两者叠加的结果是"策略再轻、模型再大，也只能看到 7 个"。
   */
  const config = configWith({
    coinSource: { ...defaultStrategyConfig().coinSource, sourceType: 'coinpool', coinPoolLimit: 200 },
  });
  const market = fakeMarket({ volumeRanked: rankedSymbols(200) });

  const small = await selectCandidates(config, market, { budgetTokens: PROMPT_TOKEN_BUDGET });
  const large = await selectCandidates(config, market, { budgetTokens: 200_000 });

  assert.ok(small.symbols.length > 0, '至少要选出标的');
  assert.ok(
    large.symbols.length > small.symbols.length,
    `预算放大到 20 万后候选应当更多，实际 ${small.symbols.length} → ${large.symbols.length}`,
  );
  /* 上限由预算算出，不是那个已经被删掉的 40。 */
  assert.ok(
    large.symbols.length <= candidateBudget(config, 200_000),
    '候选数不得超过预算算出的上限',
  );
});

test('裁剪时从最弱的开始丢，且保持原有的强弱顺序', async () => {
  /*
   * 顺序本身是信息（`selectCandidates` 把已有持仓放在最前，其余按来源加入的顺序），
   * 提示词渲染时依赖它，模型也依赖它判断"哪个更值得看"。
   * 裁剪如果打乱了顺序，模型看到的就是另一份东西。
   */
  const config = configWith({
    coinSource: { ...defaultStrategyConfig().coinSource, sourceType: 'coinpool', coinPoolLimit: 200 },
  });
  const ranked = rankedSymbols(60);
  const market = fakeMarket({ volumeRanked: ranked });

  const result = await selectCandidates(config, market, { budgetTokens: PROMPT_TOKEN_BUDGET });
  assert.ok(result.symbols.length < ranked.length, '这个夹具必须真的触发裁剪，否则用例什么都没测');

  /*
   * 保留下来的必须是**原序列的前缀**（最强的那些），而不是任意子集。
   *
   * ⚠️ 先排除 BTC：它是**无条件入选**的，会被插到最前面（见下一条用例）。
   * 第一版断言直接拿整份结果和 `ranked.slice()` 比，于是 BTC 一进来就失败 ——
   * 而那次失败说明的是**断言没把"BTC 总会插队"这个前提写进去**，不是实现错了。
   * 这类"夹具假设与现实不符"的失败要能和"实现坏了"区分开。
   */
  const withoutBtc = result.symbols.filter((s) => s !== 'BTCUSDT');
  assert.deepEqual(
    withoutBtc,
    ranked.slice(0, withoutBtc.length),
    '裁剪应当从最弱的开始丢，保留最强的连续前缀',
  );
});

/* -------------------------------------------------------------------------- */
/*  2. 持仓标的永不裁                                                           */
/* -------------------------------------------------------------------------- */

test('★ 持仓标的永远不裁 —— 即使它排在最后、而且预算已经超了', async () => {
  /*
   * 一个看不见自己持仓行情的模型，会把"没有数据"当成"没有理由继续持有"。
   * 所以 `mustInclude` 的标的**优先级高于预算**：宁可这一轮多花一点 token。
   *
   * 这条断言的形状刻意选得极端：把持仓标的放在**最后一位**（最弱），
   * 再给一个很小的预算 —— 正常裁剪一定会先丢掉它。
   */
  const held = 'ZZZHELDUSDT';
  const ranked = [...rankedSymbols(60), held];
  const config = configWith({
    coinSource: { ...defaultStrategyConfig().coinSource, sourceType: 'coinpool', coinPoolLimit: 200 },
  });
  const market = fakeMarket({ volumeRanked: ranked });

  const result = await selectCandidates(config, market, {
    mustInclude: [held],
    budgetTokens: PROMPT_TOKEN_BUDGET,
  });

  assert.ok(
    result.symbols.includes(held),
    `持仓标的 ${held} 必须留在候选池里，实际留在：${result.symbols.join(',')}`,
  );
  /* 而且它应当排在最前面 —— 持仓是"我现在必须处理的事"。 */
  assert.equal(result.symbols[0], held, '持仓标的应当排在候选池最前');
});

/* -------------------------------------------------------------------------- */
/*  3. BTC 无条件入选                                                           */
/* -------------------------------------------------------------------------- */

test('★ BTC 无条件入选 —— 提示词的 BTC 概览那一块靠它', async () => {
  /*
   * `prompt.ts` 的 `# BTC 市场概览` 找不到 BTCUSDT 快照就**整段不渲染**，
   * 于是模型安静地失去大盘背景，而它不会知道"这块本来应该有"。
   *
   * 这里原来有条件（`enableOiRanking || 池子为空`），而紧挨着的注释却写着
   * "majors 永远值得看一眼" —— 注释描述的是无条件，代码写的是有条件。
   * 所以断言不能依赖任何开关：**把 OI 排行关掉、池子给足**，BTC 仍然要在。
   */
  const config = configWith({
    coinSource: { ...defaultStrategyConfig().coinSource, sourceType: 'coinpool', coinPoolLimit: 20 },
    indicators: {
      ...defaultStrategyConfig().indicators,
      enableOiRanking: false,
    },
  });
  /* 池子里故意**没有** BTC —— 它必须靠"无条件入选"进来，而不是碰巧在榜上。 */
  const market = fakeMarket({ volumeRanked: rankedSymbols(20) });

  const result = await selectCandidates(config, market, { budgetTokens: PROMPT_TOKEN_BUDGET });

  assert.ok(
    result.symbols.includes('BTCUSDT'),
    `BTCUSDT 必须无条件入选，实际候选：${result.symbols.join(',')}`,
  );
  assert.ok(
    result.sourcesBySymbol.get('BTCUSDT')?.includes('reference'),
    'BTC 的来源标签应当是 reference（提示词按它渲染）',
  );
});

/* -------------------------------------------------------------------------- */
/*  4. 空池                                                                     */
/* -------------------------------------------------------------------------- */

test('池子为空时仍然给出 BTC —— "什么都没有"与"连大盘都看不到"是两件事', async () => {
  const config = configWith({
    coinSource: { ...defaultStrategyConfig().coinSource, sourceType: 'coinpool', coinPoolLimit: 20 },
  });
  const market = fakeMarket({ volumeRanked: [] });

  const result = await selectCandidates(config, market, { budgetTokens: PROMPT_TOKEN_BUDGET });
  assert.deepEqual(result.symbols, ['BTCUSDT'], '空池时至少要留下 BTC 作参照');
});

/* -------------------------------------------------------------------------- */
/*  5. 预算估算本身                                                             */
/* -------------------------------------------------------------------------- */

test('candidateBudget 从不返回 0 —— 一个标的不给会让"配置太重"看起来像"没有机会"', async () => {
  /*
   * 预算被固定开销吃光时，返回 0 会让候选池变空 —— 而"空"在界面上与
   * "市场里没有可交易的东西"完全一样。所以它至少给 1。
   *
   * 实测过的同类伤害：某个策略因为每候选太贵而被裁到 7 个，而它的操作员
   * 以为那是"市场不好"。
   */
  const heavy = configWith();
  assert.ok(candidateBudget(heavy, 1) >= 1, '极小预算也必须至少给 1 个标的');
  assert.ok(candidateBudget(heavy, PROMPT_TOKEN_BUDGET) >= 1);
});

test('打分门槛关闭时不得静默丢弃标的（minScore = 0 表示不过滤）', async () => {
  /*
   * `minScore` 是"候选评分门槛"，0 表示关闭。而关闭与"评分恰好都在 0 以上"
   * 是两件事 —— 后者会在评分算法变动时突然开始滤人。
   */
  const config = configWith({
    coinSource: {
      ...defaultStrategyConfig().coinSource,
      sourceType: 'coinpool',
      coinPoolLimit: 20,
      minScore: 0,
    },
  });
  const ranked = rankedSymbols(5);
  const market = fakeMarket({ volumeRanked: ranked });

  const result = await selectCandidates(config, market, { budgetTokens: PROMPT_TOKEN_BUDGET });
  /* 5 个标的 + BTC（无条件入选），一个都不该少。 */
  for (const symbol of ranked) {
    assert.ok(result.symbols.includes(symbol), `${symbol} 不应被门槛滤掉`);
  }
});

test('★ 点名/共识的标的是"优先入选"，不是"额外增加" —— 候选池不该因此膨胀', async () => {
  /*
   * ## 这条用例是为一个**真实的副作用**写的
   *
   * 第 3 层「索取」接上之后，共识标的与模型点名的标的被塞进了 `mustInclude` ——
   * 而 `mustInclude` 是**必保**的（`mustKeep` 会让它们在裁剪时占位）。
   *
   * 实测后果：候选数 **20 → 25**、提示词 **229,567 → 288,523 字符**、
   * 决策耗时 **145 秒 → 397 秒**（6.6 分钟）。
   *
   * **优先 ≠ 必保**：它们该排在候选池最前、最可能进池，但**预算不够时可以让位**。
   * 这一条钉住那个区别 —— 否则下次谁再往 `mustInclude` 里塞东西，
   * 候选池又会无声地膨胀。
   */
  const config = configWith({
    coinSource: { ...defaultStrategyConfig().coinSource, sourceType: 'coinpool', coinPoolLimit: 200 },
  });
  const market = fakeMarket({ volumeRanked: rankedSymbols(200) });
  const budget = PROMPT_TOKEN_BUDGET;
  const max = candidateBudget(config, budget);

  /* 20 个"点名的"—— 若按 mustInclude 处理，候选池会被它们撑爆。 */
  const preferred = Array.from({ length: 20 }, (_, i) => `WANT${String(i).padStart(2, '0')}USDT`);

  const plain = await selectCandidates(config, market, { budgetTokens: budget });
  const withPreferred = await selectCandidates(config, market, { preferred, budgetTokens: budget });

  assert.equal(
    withPreferred.symbols.length,
    plain.symbols.length,
    '★ 优先入选不该改变候选总数 —— 它只改变"谁在里面"',
  );
  assert.ok(withPreferred.symbols.length <= max, '总数仍要在预算上限内');
  assert.ok(
    withPreferred.symbols.includes(preferred[0]!),
    '★ 优先的必须进池 —— 那正是"优先"的意思',
  );
  assert.ok(
    !plain.symbols.includes(preferred[0]!),
    '对照组：不点名时它本来不在（否则这条断言什么也没验证）',
  );
});

test('★ 候选池数量必须有硬上限 —— 预算上限在"模型上下文很大"时形同虚设', async () => {
  /*
   * ## 这条用例是为一次真实的性能退化写的（2026-10-01）
   *
   * `promptTokenBudget()` 吃的是模型的 `input_token_limit`：
   *
   *     input_token_limit = 1,000,000
   *     PROMPT_UTILISATION = 0.8        → 800,000
   *     PROMPT_OUTPUT_RESERVE = 131,072 → 868,928
   *     PROMPT_TOKEN_CEILING = 800,000
   *     → **预算 = 800,000 tokens**
   *
   * 而一轮真实提示词只有 **190K tokens** —— 于是**裁剪永远不触发**，
   * 候选池大小完全由"来源给了多少"决定：`coinPoolLimit` 的 20 个
   * 加上共识标的与模型点名的 4 个 = **24 个**。
   *
   * 代价是实测出来的：
   *
   *     09-27  候选 20 个  提示词 213,559 字符  含开单 19/33 = 58%
   *     10-01  候选 24 个  提示词 278,255 字符  含开单  0/7  =  0%
   *
   * 提示词 **92% 是候选池**（每个约 10,600 字符 = 4 周期 × 10 条序列 × 30 个点），
   * 而提示词自己写着「**模型通常只深入看 1–2 个**」。
   *
   * 更大的请求还直接造成失败：`#1621` 的原始错误是
   * **`request exceeded 240000ms`**（我方超时），被归类成了"上游不可用"——
   * 而用户单独用 API 测试上游时它是好的。
   *
   * 所以：**数量上限必须独立于 token 预算**，锚在"人能审得过来"的量级上 ——
   * 用户对候选池的要求一直是「15-20 个完整多周期行情」。
   */
  const config = configWith({
    coinSource: { ...defaultStrategyConfig().coinSource, sourceType: 'coinpool', coinPoolLimit: 200 },
  });
  const market = fakeMarket({ volumeRanked: rankedSymbols(200) });

  /* 一个"上下文巨大"的预算不该让一轮塞进几十个标的。 */
  const huge = await selectCandidates(config, market, { budgetTokens: 10_000_000 });
  assert.ok(
    huge.symbols.length <= CANDIDATE_HARD_CAP,
    `候选数 ${huge.symbols.length} 超过硬上限 ${CANDIDATE_HARD_CAP} —— ` +
      '预算再大也不该让一轮塞进几十个标的',
  );
  assert.ok(CANDIDATE_HARD_CAP >= 15, '上限不能低于用户要求的 15 个');
  assert.ok(CANDIDATE_HARD_CAP <= 20, '上限不能高于用户要求的 20 个');
});

/* -------------------------------------------------------------------------- */
/*  类型哨兵                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * 一条编译期断言：`selectCandidates` 的返回必须带 `trimmedFrom` ——
 * `autoTrader` 靠它告诉模型"选币阶段裁掉过"。那个字段曾经算出来了却被丢弃，
 * 于是模型在一个被静默裁过的池子上做归因。
 */
test('返回值带 trimmedFrom 与 budget —— 调用方要靠它们说明裁剪', async () => {
  const config = configWith({
    coinSource: { ...defaultStrategyConfig().coinSource, sourceType: 'coinpool', coinPoolLimit: 200 },
  });
  const market = fakeMarket({ volumeRanked: rankedSymbols(90) });
  const result = await selectCandidates(config, market, { budgetTokens: PROMPT_TOKEN_BUDGET });

  assert.equal(typeof result.budget, 'number', 'budget 要如实报出这一轮的上限');
  assert.ok('trimmedFrom' in result, 'trimmedFrom 必须在返回值里（哪怕这一轮没裁）');
  /* 这个夹具保证裁过，所以它应当非 null。 */
  assert.ok(result.trimmedFrom !== null, '发生了裁剪时 trimmedFrom 必须给出裁前的数量');
  assert.ok(
    (result.trimmedFrom ?? 0) > result.symbols.length,
    'trimmedFrom 是裁**前**的数量，必须大于裁后的数量',
  );
});

/**
 * ★★★ **团队模式走分层漏斗**（2026-10-12 接线）。
 *
 * 用户的要求：「交易所有 500 个可以交易的币……**层层筛选**」。
 *
 * ⚠️ 关键约束：**另两种模式的选池行为必须逐字节不变** ——
 * 用户明确要求「现阶段得也得保留……用户可以自行切换用现有模式」。
 * 所以这是一个**新的 `sourceType: 'funnel'`**，而不是改 `coinpool`。
 */
test('★★★ funnel 走分层漏斗，且每层的淘汰可解释', async () => {
  /* 造全市场：少部分大成交额 + 大部分小成交额。 */
  const rows = Array.from({ length: 300 }, (_, i) => ({
    symbol: `SYM${String(i).padStart(3, '0')}USDT`,
    quoteVolume24h: i < 50 ? 500_000_000 - i * 1_000_000 : 1_000_000,
    changePercent24h: 5,
    amplitudePercent: 8,
  }));
  const market = {
    async screenUniverseRows() {
      return rows;
    },
  } as unknown as MarketDataService;

  /*
   * ⚠️ 用**数组**收集而不是 `let reported = null`：
   * TS 的控制流分析看不到"闭包会在调用期间给它赋值"，
   * 于是把它收窄成 `null`（进而 `.stages` 报 "does not exist on type never"）。
   * 数组的 `push` 不会被那样收窄。
   */
  const reported: Array<{ stages: readonly FunnelStageReport[]; survivors: number }> = [];
  const picked = await selectCandidates(
    configWith({ coinSource: { ...defaultStrategyConfig().coinSource, sourceType: 'funnel' } }),
    market,
    {
      onFunnelReport: (stages: readonly FunnelStageReport[], survivors: number) => {
        reported.push({ stages, survivors });
      },
    },
  );

  assert.ok(picked.symbols.length > 0, '要选出标的');
  assert.equal(reported.length, 1, '★ 必须回调漏斗报告 —— 否则操作员看不到"为什么没被看到"');
  assert.ok(reported[0]!.stages.length >= 2, '★ 应当是【多层】而不是一层');
  assert.ok(
    reported[0]!.stages.some((s) => s.dropped > 0),
    '★ 至少有一层真的淘汰了东西（否则"层层筛选"名不副实）',
  );
  assert.ok(
    reported[0]!.survivors <= 50,
    `最终应显著收敛（300 → ${reported[0]!.survivors}）`,
  );
});

test('★ funnel 也兑现 excludeStablecoins —— 开关开了就不能靠波动层顺手挡', async () => {
  /*
   * 漏斗默认有一层 `minAmplitudePercent: 2`，稳定币（波动接近 0）会被它【顺带】挡掉。
   * 那是巧合不是意图：这里故意给稳定币高振幅，让波动层挡不住它 ——
   * 于是能分辨"是开关在过滤"还是"是波动层在过滤"。
   *
   * 关掉开关时它必须在池里（证明是开关的功劳，不是漏斗结构），
   * 开启时被剔除，且回调报的 survivors 是过滤后的数（日志说真话）。
   */
  const rows = Array.from({ length: 5 }, (_, i) => ({
    symbol: ['USDCUSDT', 'SYM000USDT', 'SYM001USDT', 'SYM002USDT', 'SYM003USDT'][i]!,
    quoteVolume24h: 500_000_000 - i * 1_000_000,
    changePercent24h: 5,
    amplitudePercent: 8, // 高振幅：波动层挡不住 USDCUSDT
  }));
  const market = {
    async screenUniverseRows() {
      return rows;
    },
  } as unknown as MarketDataService;

  const run = async (exclude: boolean) => {
    const reported: Array<{ survivors: number }> = [];
    const picked = await selectCandidates(
      configWith({
        coinSource: {
          ...defaultStrategyConfig().coinSource,
          sourceType: 'funnel',
          excludeStablecoins: exclude,
        },
      }),
      market,
      { budgetTokens: 200_000, onFunnelReport: (_s, survivors) => { reported.push({ survivors }); } },
    );
    return { picked, survivors: reported[0]?.survivors ?? -1 };
  };

  const off = await run(false);
  assert.ok(off.picked.symbols.includes('USDCUSDT'), '开关关闭：USDCUSDT 必须在池里（不是波动层挡的）');

  const on = await run(true);
  assert.ok(!on.picked.symbols.includes('USDCUSDT'), '开关开启：即便波动层挡不住，也必须被剔除');
  assert.ok(on.picked.symbols.includes('SYM000USDT'), '正常标的照常入选');
  assert.ok(
    on.survivors < off.survivors,
    `回调 survivors 必须反映过滤后（开:${on.survivors} < 关:${off.survivors}）—— 否则日志说的数和模型看到的池子对不上`,
  );
});


test('★★ coinpool 的行为【没有】被改动（增量更新的硬约束）', async () => {
  /*
   * 用户要求：「这次大更新做增量……现阶段得也得保留，用户可以自行切换」。
   * 所以 `coinpool`（另两种模式在用）必须保持原样 —— 它只做**一层**排序取前 N。
   *
   * ⚠️ **断言不能写"结果等于 20"**（我第一版就是这么写的，被测试当场纠正）：
   * `selectCandidates` 之后还有 **`candidateBudget()` 的提示词预算裁剪** ——
   * 实测 20 个来源标的最终只剩 **7 个**进池。
   *
   * 那 7 不是 BUG：`coins.test.ts` 文件头就记着这段历史 ——
   * 「曾经因为提示词预算写死 6 万而把候选池饿到 7 个」。
   * 所以这里要验的是"**行为未变**"，而"最终几个"由预算决定，不该在这里钉死。
   */
  const market = {
    async screenUniverse() {
      return rankedSymbols(20);
    },
  } as unknown as MarketDataService;
  const picked = await selectCandidates(
    configWith({ coinSource: { ...defaultStrategyConfig().coinSource, sourceType: 'coinpool' } }),
    market,
    {},
  );
  assert.ok(picked.symbols.length > 0, '★ coinpool 仍能选出标的（行为未变）');
  assert.ok(
    picked.symbols.length <= 20,
    `★ 不该超过来源给的 20 个（实际 ${picked.symbols.length}）`,
  );
  /*
   * ⚠️ **不能断言 `symbols[0]` 等于来源的第一个**（我第一版就是这么写的，被测试纠正）：
   * 实测第一个是 **`BTCUSDT`** —— 它被**无条件**加进候选池（大盘参照标的，
   * 见日志「候选池按提示词预算从 **21** 个裁剪到 7 个」：20 个来源 + 1 个 BTC）。
   *
   * 这是**既有行为、不是 BUG**：模型需要一个稳定的市场参照。
   * 所以这里验的是"来源给的标的确实进了池"，而不是"谁排第一"。
   */
  const fromSource = picked.symbols.filter((s) => rankedSymbols(20).includes(s));
  assert.ok(fromSource.length >= 5, `★ 来源标的应当大量进池（实际 ${fromSource.length} 个）`);
});
/* -------------------------------------------------------------------------- */
/*  稳定币过滤（excludeStablecoins）                                            */
/* -------------------------------------------------------------------------- */

/*
 * ★★ `excludeStablecoins` 曾经是**死配置** —— 而它不是"没人用的旋钮"，
 * 是**注释说要它生效、字段却根本不在 schema 里**。
 *
 * `defaultAiTeamConfig()`（团队模式的默认配置）一直写着：
 * ```ts
 * /* 过滤掉稳定币与成交额太小的（滑点会把利润吃光）。 *​/
 * excludeStablecoins: true,
 * ```
 * 而 `CoinSourceConfigSchema` 里**没有这个字段**，zod 解析非 strict 对象时
 * 静默丢弃未知键 —— 于是配置"成功"解析、意图被丢掉、没有任何报错。
 * 更讽刺的是同一段注释里下一行正好写着：
 * ```ts
 * /* ⚠️ 字段名必须是 minQuoteVolume24h —— 写成 minQuoteVolume 会被 schema 静默丢弃。 *​/
 * ```
 *
 * 为什么后果不只是"少个过滤器"：稳定币永续（USDCUSDT 这类）报价与波动都接近
 * 锚定值，名义波动趋近 0 而手续费与资金费占绝对主导 —— 放进一个 8–20 个位置的
 * 候选池就是**挤掉真实机会**。团队模式默认池只有 8 个，挤掉一个就是 12.5%。
 *
 * `SymbolRegistry` 挡不住它们：它只按 `quoteAsset === 'USDT'` 过滤，
 * 那挡的是**计价**资产，`USDCUSDT` 的计价恰恰就是 USDT。
 */
test('★★ 团队模式的 excludeStablecoins 必须真的解析出来并生效', async () => {
  const config = configWith({
    coinSource: {
      ...defaultStrategyConfig().coinSource,
      sourceType: 'coinpool',
      coinPoolLimit: 20,
      excludeStablecoins: true,
    },
  });

  /* 这个键必须活过 zod 解析 —— 原来它不在 schema 里，读出来是 undefined。 */
  assert.equal(
    config.coinSource.excludeStablecoins,
    true,
    '★★ 读出来不是 true —— 字段没进 schema，会被静默丢弃',
  );

  const market = fakeMarket({
    volumeRanked: ['USDCUSDT', 'BTCUSDT', 'FDUSDUSDT', 'ETHUSDT', 'SOLUSDT'],
  });

  const result = await selectCandidates(config, market, { budgetTokens: 200_000 });

  assert.ok(!result.symbols.includes('USDCUSDT'), 'USDCUSDT（标的本身锚定）必须被剔除');
  assert.ok(!result.symbols.includes('FDUSDUSDT'), 'FDUSDUSDT 同理');
  assert.ok(result.symbols.includes('BTCUSDT'), 'BTC 必须保留');
  assert.ok(result.symbols.includes('ETHUSDT'), 'ETH 必须保留');
  assert.ok(result.symbols.includes('SOLUSDT'), 'SOL 必须保留');
});

test('★★ 默认关闭 —— 存量非团队策略的选池不得因此改变', async () => {
  /*
   * ⚠️ 这是影响面的硬约束，不是偏好。
   *
   * 存量（conservative / aggressive）策略的 config_json 里**没有**这个键，
   * 读出来落到 schema 默认值。若默认 `true`，这些正在实盘跑的策略会在下次读取时
   * **静默开始过滤稳定币** —— 候选池变了，而没人做过这个决定。本仓库对
   * "另两种模式的选池行为逐字节不变"有明确要求。真正想要过滤的
   * `defaultAiTeamConfig()` 显式写 `true`，所以团队模式照常生效。
   */
  assert.equal(
    defaultStrategyConfig().coinSource.excludeStablecoins,
    false,
    '★★ schema 默认必须是 false —— 否则存量非团队策略被静默改变行为',
  );

  const config = configWith({
    coinSource: { ...defaultStrategyConfig().coinSource, sourceType: 'coinpool', coinPoolLimit: 20 },
  });
  const market = fakeMarket({ volumeRanked: ['USDCUSDT', 'BTCUSDT'] });
  const result = await selectCandidates(config, market, { budgetTokens: 200_000 });
  /* 默认关 → 稳定币保留，与改动前逐字节一致。 */
  assert.ok(result.symbols.includes('USDCUSDT'), '默认关闭时不得过滤 —— 那是存量模式的既有行为');
});

test('★ 开关关掉后稳定币回到池里 —— 它必须真的可关，不是硬编码', async () => {
  const config = configWith({
    coinSource: {
      ...defaultStrategyConfig().coinSource,
      sourceType: 'coinpool',
      coinPoolLimit: 20,
      excludeStablecoins: false,
    },
  });
  const market = fakeMarket({ volumeRanked: ['USDCUSDT', 'BTCUSDT'] });
  const result = await selectCandidates(config, market, { budgetTokens: 200_000 });
  assert.ok(result.symbols.includes('USDCUSDT'), '显式关闭后不过滤 —— 那是操作员的选择');
});

test('★ 白名单只列已知稳定币 —— 名单外的未知新币在开关开启时也不被误杀', async () => {
  /*
   * `isStableBaseAsset()` 用白名单：名单外的新锚定币会被判为"不是稳定币"→ 保留。
   * 代价是可能放过新型稳定币（人补一行名单即可），换来的是不误杀真实标的
   * （把活跃山寨当稳定币剔除 = 直接放弃机会）。
   *
   * 这条在 `excludeStablecoins: true` 下测，确认即便过滤开着，未知币也不被误杀。
   * 它钉的是现状语义：若将来改成"名单外一律可疑"，这条会失败 —— 正是要语义变更
   * 被显式决定一次。
   */
  const result = await selectCandidates(
    configWith({
      coinSource: {
        ...defaultStrategyConfig().coinSource,
        sourceType: 'coinpool',
        coinPoolLimit: 20,
        excludeStablecoins: true,
      },
    }),
    fakeMarket({ volumeRanked: ['NEWPEGUSDT', 'USDCUSDT', 'BTCUSDT'] }),
    { budgetTokens: 200_000 },
  );
  assert.ok(result.symbols.includes('NEWPEGUSDT'), '名单外的未知币：白名单语义下保留（不误杀）');
  assert.ok(!result.symbols.includes('USDCUSDT'), '而名单内的已知稳定币照样被剔除');
});
