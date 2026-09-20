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
import { selectCandidates } from './coins.js';
import type { MarketDataService } from '../market/service.js';

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
