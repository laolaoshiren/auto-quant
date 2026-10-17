/**
 * ⭐ **团队模式的 token 账目**（2026-10-17 修 —— 缺陷来源：t76 巡检第 3 轮）
 *
 * ## 事故（线上只读实测）
 *
 * ```
 *   decision_records 的 prompt_tokens > 0：
 *     #9（strategy）    636/685  = 92.8%
 *     #10（ai_managed） 465/528  = 88.1%
 *     #11（ai_team）      0/482  =  0.0%   ← 只有团队模式，482 轮全空
 *   completion / cached / reasoning 同样 0/482
 * ```
 *
 * 根因：团队 `complete()` 的返回**硬编码** `usage: { promptTokens: null, completionTokens: null }`，
 * 于是 26–28 次角色调用的用量**一次都没交上去**。
 *
 * ## 这组用例守的两条不变量
 *
 * 1. **团队轮 ⇒ 用量非空，且等于各角色之和**（不是"最后一次调用"）；
 * 2. **单模型轮 ⇒ 逐字节不变**（修团队不能碰单模型 —— 那是最容易顺手改坏的地方）。
 *
 * ⚠️ 第 2 条为什么必须单独钉：`routedModel.ts` 里**同一个文件**同时实现了两条路
 *（`createRoutedDecisionModel` 与 `createTeamDecisionModel`）。在一条上加计量时
 * 顺手碰坏另一条，是这类改动的典型形状。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ModelRouter, type CallModel } from '../llm/modelRouter.js';
import { createRoutedDecisionModel, createTeamDecisionModel } from './routedModel.js';
import { mergeRoleUsage, sumRoleUsage, type DeskRoleOutput } from './agent/tradingDesk.js';

const SYS = '你是交易员。把决策放进 <decision> 块。';
const USER = '当前市场材料……';
const DECISION_JSON = '[{"symbol":"BTCUSDT","action":"open_long","positionSizeUsd":100,"stopLoss":60000,"takeProfit":70000,"confidence":70}]';

/**
 * 造一个桩：**每个角色都报一个"可辨识"的用量**。
 *
 * ## 为什么要按角色给不同的数（而不是 everybody 100）
 *
 * 因为本条最该防的错误是"**只记了最后一次调用**"。若每个角色的用量都一样
 *（都是 100），那么"只记最后一次"的结果（100）与"记整轮"的结果（N×100）
 * 只能靠**数字大小**区分 —— 而断言里写死一个魔数会被后来的改动悄悄调整。
 *
 * 给每个角色一个**互不相同的**数，就能精确断言"**求和**"这件事本身：
 * 换句话说，**任何一次漏收**都会让断言里的期望值对不上。
 *
 * 数字取自实测量级（见 `t76` 巡检第 3 轮：agent 层每步约 16.5K token），
 * 但取整成大数便于阅读与断言。
 */
const ROLE_INPUT_TOKENS: Readonly<Record<string, number>> = {
  supervisor: 11_000,
  market_analyst: 43_000,
  technical: 39_000,
  newscaster: 6_000,
  sentiment: 5_000,
  symbol_scout: 17_000,
  bull: 24_000,
  bear: 23_000,
  judge: 24_000,
  risk_officer: 18_000,
  reporter: 4_000,
};

const ROLE_OUTPUT_TOKENS: Readonly<Record<string, number>> = {
  supervisor: 300,
  market_analyst: 2_100,
  technical: 1_800,
  newscaster: 500,
  sentiment: 400,
  symbol_scout: 700,
  bull: 3_000,
  bear: 2_900,
  judge: 3_200,
  risk_officer: 900,
  reporter: 250,
};

/** 从 system 提示词里认角色（与 `teamModel.test.ts` 同一手法）。 */
function roleOf(messages: Array<{ role: string; content: string }>): string {
  const sys = messages.find((m) => m.role === 'system')?.content ?? '';
  return /「(\w+)」/.exec(sys)?.[1] ?? 'unknown';
}

/**
 * 桩：**每个角色都报用量**（`judge` 给可解析的 JSON 数组，其余给散文）。
 *
 * `reportedRoles` 会记下**实际被问到的角色**（含重复），于是测试可以自己
 * 算出"期望的输入 token 之和" —— 判据从事实来源算出，不靠人写死一个数。
 */
function roleAwareCallWithUsage(): { call: CallModel; asked: string[] } {
  const asked: string[] = [];
  const call: CallModel = async (_modelId, messages) => {
    const role = roleOf(messages);
    asked.push(role);
    const promptTokens = ROLE_INPUT_TOKENS[role] ?? 1_000;
    const completionTokens = ROLE_OUTPUT_TOKENS[role] ?? 100;
    /* 缓存与思维链各给一个"部分命中"的形状 —— 它们是本缺陷里同样恒 0 的两列。 */
    const usage = {
      promptTokens,
      completionTokens,
      cachedTokens: role === 'judge' ? 0 : Math.floor(promptTokens / 10),
      reasoningTokens: Math.floor(completionTokens / 3),
    };
    if (role === 'judge') return { text: DECISION_JSON, latencyMs: 20, usage };
    return { text: `我是 ${role}，这是我的产出。`, latencyMs: 15, usage };
  };
  return { call, asked };
}

/** 桩：**不报用量**（模拟"还没接线"的调用方与测试桩）。 */
const callWithoutUsage: CallModel = async (_modelId, messages) => {
  const role = roleOf(messages);
  if (role === 'judge') return { text: DECISION_JSON, latencyMs: 20, usage: undefined as never };
  return { text: `我是 ${role}。`, latencyMs: 15, usage: undefined as never };
};

/* -------------------------------------------------------------------------- */
/*  ① 修复前的形状：没报用量 ⇒ 四列必须是 null（不是 0）                        */
/* -------------------------------------------------------------------------- */

test('★ 角色没报用量时，团队 usage 必须是"不知道"（null）而不是 0', async () => {
  /*
   * 这条守的是 `ChatUsage` 那条纪律（`llm/types.ts:45-51`）：
   * `null` = 不知道，`0` = 报了确实是 0。**两者结论完全相反。**
   * 把它们合成一个数，会让"没记账"看起来像"没花钱" —— 那正是这次修的事故里
   * 最容易被误读的部分（界面上看起来成本为 0）。
   */
  const model = createTeamDecisionModel({
    router: new ModelRouter({ call: callWithoutUsage }),
    baseMaxTokens: 4096,
  });
  const result = await model.complete(SYS, USER, {});

  assert.equal(result.usage.promptTokens, null, '★ 没报用量 ⇒ promptTokens 必须是 null');
  assert.equal(result.usage.completionTokens, null, '★ 没报用量 ⇒ completionTokens 必须是 null');
  /* 决策本身不受影响（计量是观测，不是判据）。 */
  assert.ok(result.text.includes('<decision>'), '计量缺失不该影响决策产出');
});

/* -------------------------------------------------------------------------- */
/*  ② 核心：整轮之和（不是最后一次调用）                                        */
/* -------------------------------------------------------------------------- */

test('★★★ 团队 usage = 整轮所有角色之和（不是最后一次调用）', async () => {
  /*
   * ## 为什么这条是本次修复的核心
   *
   * `autoTrader.ts:3781-3783` 明确区分过：
   * ```
   *   「这一轮的真实用量」  vs  「最后一次调用的用量」
   * ```
   * 团队模式一次 `complete()` 背后是 **26–28 次**模型调用。
   * 若只把"最后一次"交上去，数字会**小一个数量级**，而**没有任何东西会报错** ——
   * 它会安静地给出一个偏小的数（这正是本条要防的形状）。
   *
   * ## 判据怎么算出来的（不写死魔数）
   *
   * 桩自己记下**实际被问到的角色**，测试用**同一张用量表**算出期望值。
   * 于是"多问一次 scout"或"少叫一次风控"都会自动反映到期望值里 ——
   * 断言的是"**求和**"这件事，而不是某个具体数字。
   */
  const { call, asked } = roleAwareCallWithUsage();
  const model = createTeamDecisionModel({ router: new ModelRouter({ call }), baseMaxTokens: 4096 });
  const result = await model.complete(SYS, USER, {});

  const expectedPrompt = asked.reduce((s, r) => s + (ROLE_INPUT_TOKENS[r] ?? 1_000), 0);
  const expectedCompletion = asked.reduce((s, r) => s + (ROLE_OUTPUT_TOKENS[r] ?? 100), 0);

  /*
   * ⚠️ **必须远大于"一次调用"** —— 这是"整轮 vs 最后一次"的**结构性**判据。
   * 若实现退化成"只记最后一次"，这两个断言会立刻红。
   */
  const maxSingleInput = Math.max(...Object.values(ROLE_INPUT_TOKENS));
  assert.ok(
    expectedPrompt > maxSingleInput,
    `夹具本身要能把两种情况分开（期望 ${expectedPrompt} 应大于单次最大 ${maxSingleInput}）`,
  );

  assert.equal(
    result.usage.promptTokens,
    expectedPrompt,
    `★ 输入 token 必须是【整轮之和】${expectedPrompt}（实际 ${result.usage.promptTokens}）—— ` +
      '小于它就是只记了最后一次调用',
  );
  assert.equal(
    result.usage.completionTokens,
    expectedCompletion,
    `★ 输出 token 必须是【整轮之和】${expectedCompletion}（实际 ${result.usage.completionTokens}）`,
  );
  assert.ok(
    (result.usage.cachedTokens ?? 0) > 0,
    '★ cachedTokens 必须被记上（修复前它恒为 0，导致"缓存命中率"永远算不出来）',
  );
  assert.ok(
    (result.usage.reasoningTokens ?? 0) > 0,
    '★ reasoningTokens 必须被记上（修复前恒 0，思维链占比无法度量）',
  );

  /* 角色数要落在"团队一轮"的量级上 —— 1 主管 + 4 分析师 + 辩论 2 + 裁决 1（+ 风控/汇报）。 */
  assert.ok(
    asked.length >= 8,
    `★ 一轮至少该问 8 个角色（实际 ${asked.length}：${asked.join('、')}）`,
  );
});

test('★★★ 发票量级：加上"按币并行"后必须落进 43–46 万输入 token 的区间', async () => {
  /*
   * ## 这条守什么
   *
   * `t76` 巡检给出的**推算区间是 43–46 万输入 token/轮**（按实测的 27 次调用
   * × 每步约 16.5K token）。修复后只要量级落在那个区间，就说明"整轮"被记全了；
   * **若实测远小于它，就是只记了最后一次调用** —— 那正是本次验收要防的。
   *
   * ## ⚠️ 为什么默认配置下【到不了】那个量级（这条测试自己教我的事）
   *
   * 第一次跑这条测试时它是**红的**，实测只有 **186,000** —— 因为它没算上
   * "按币并行"那 17–19 次 `symbol_scout`（**整轮最大的一块**）。
   *
   * 而按币并行是一个**环境变量开关**：`AQ_PER_SYMBOL=on`（见 `tradingDesk.ts`
   * 的 `if (process.env.AQ_PER_SYMBOL === 'on')`）。线上 `#11` 的 `runtime_logs`
   * 里每轮都有「按币并行：17~19 个标的」，说明**线上是开着的**；而测试环境
   * 不开 —— 这个 186,000 / 43 万的差正是那个开关的量级（约 2.3 倍）。
   *
   * 所以这条测试**把 scout 那一块显式加进夹具**（用真实观测值 17~19 次），
   * 从而断言的是"**含按币并行的整轮**"这个形状。
   *
   * ⚠️ **它证明什么 / 不证明什么（不夸大）**
   *   ✅ 证明"汇总会把这 27 次调用全部算进去" —— 少收任何一块，数就对不上；
   *   ❌ **不证明**线上真的达到了 43 万 —— 那是**部署后回读 `decision_records`
   *      才能回答的问题**（查询见报告）。
   */
  const { call } = roleAwareCallWithUsage();
  const model = createTeamDecisionModel({ router: new ModelRouter({ call }), baseMaxTokens: 4096 });
  const result = await model.complete(SYS, USER, {});
  const singleRound = result.usage.promptTokens ?? 0;

  /* 线上实测："按币并行：17~19 个标的" —— 取 17（保守下限）。 */
  const SCOUT_CALLS_ON_LINE = 17;
  const scoutBlock = SCOUT_CALLS_ON_LINE * ROLE_INPUT_TOKENS['symbol_scout']!;
  const onlineScale = singleRound + scoutBlock;

  assert.ok(
    onlineScale >= 400_000,
    `★ 含按币并行的整轮必须落在 43–46 万的量级（实际 ${onlineScale} = ` +
      `单轮 ${singleRound} + scout ${SCOUT_CALLS_ON_LINE}×${ROLE_INPUT_TOKENS['symbol_scout']}）`,
  );
  assert.ok(
    onlineScale <= 600_000,
    `★ 也不该超过 60 万（实际 ${onlineScale}）—— 超了更像"重复计账"`,
  );

  /*
   * 同时把"不带按币并行"的形状也钉住：它是**默认配置**下的真实值，
   * 后一条消息里"少了 scout 那一块"的量级差就是从这里来的。
   */
  assert.ok(
    singleRound < 400_000,
    `★ 默认配置（无按币并行）本就在 43 万以下（实际 ${singleRound}）—— ` +
      '那不是缺陷，是那一块没用上；有断言在，将来若有人误以为"默认也该到 43 万"会被这里提醒',
  );
});

/* -------------------------------------------------------------------------- */
/*  ③ 多轮交易台要累加（按需取数循环的形状）                                     */
/* -------------------------------------------------------------------------- */

test('★★★ 一次 complete() 跑多轮交易台时，用量必须【累加】而不是覆盖', async () => {
  /*
   * ## 为什么需要这条
   *
   * `autoTrader` 有一个按需取数循环（`MAX_DATA_ROUNDS = 3`），而团队模式下
   * "再问一次模型"就等于**把整个交易台重跑一遍**（`routedModel.ts` 的 `<tool>`
   * 剥离注释里记着这个事故：最多 4 次交易台 = 最多 112 次角色调用）。
   *
   * 于是"每一轮各自的用量"必须**相加** —— 只返回最后一轮就是
   * 「最后一次调用的用量」那个错误换了个位置出现。
   *
   * 这里直接对 `mergeRoleUsage` 断言（它是 `complete()` 里那个累加器的实现）。
   */
  const first = { promptTokens: 100_000, completionTokens: 5_000, cachedTokens: 900, reasoningTokens: 300 };
  const second = { promptTokens: 200_000, completionTokens: 9_000, cachedTokens: 100, reasoningTokens: 700 };

  const merged = mergeRoleUsage(first, second);
  assert.equal(merged.reported, true);
  assert.equal(merged.usage?.promptTokens, 300_000, '★ 两轮交易台必须相加（不是取后者）');
  assert.equal(merged.usage?.completionTokens, 14_000);
  assert.equal(merged.usage?.cachedTokens, 1_000);
  assert.equal(merged.usage?.reasoningTokens, 1_000);

  /* 与 undefined / null 相接时不丢账。 */
  assert.equal(mergeRoleUsage(first, null).usage?.promptTokens, 100_000, '★ null 不该把已有账抹掉');
  assert.equal(mergeRoleUsage(null, second).usage?.promptTokens, 200_000);
  assert.equal(mergeRoleUsage(undefined, undefined).reported, false, '★ 两边都不知道 ⇒ 仍然"不知道"');
  assert.equal(mergeRoleUsage(undefined, undefined).usage, null);
});

test('★★ 一个字段"探到真值"后，另一侧给 null 不该把它抹掉', async () => {
  /*
   * 语义细节：`{promptTokens: 5, cachedTokens: null}` + `{promptTokens: null, cachedTokens: 7}`
   * 应当得到 `{promptTokens: 5, cachedTokens: 7}` —— 两列各自"谁有真值就用谁的"。
   * 这是 `sumRoleUsage` 里 `sawX` 那四个标记的用途。
   */
  const a = { promptTokens: 5, completionTokens: null, cachedTokens: null, reasoningTokens: null };
  const b = { promptTokens: null, completionTokens: 9, cachedTokens: 7, reasoningTokens: null };
  const merged = mergeRoleUsage(a, b);
  assert.equal(merged.usage?.promptTokens, 5, '★ 只有 a 报了 prompt ⇒ 用 a 的');
  assert.equal(merged.usage?.completionTokens, 9, '★ 只有 b 报了 completion ⇒ 用 b 的');
  assert.equal(merged.usage?.cachedTokens, 7);
  assert.equal(merged.usage?.reasoningTokens, null, '★ 两边都没报 ⇒ 仍是 null（不知道），不是 0');
});

/* -------------------------------------------------------------------------- */
/*  ④ 负向校准：单模型轮逐字节不变                                              */
/* -------------------------------------------------------------------------- */

test('★★★ 单模型路径（ai_managed）必须逐字节不变', async () => {
  /*
   * 这是"只加计量、不动别的"的**反向证据**：
   * `createRoutedDecisionModel` 与团队模型在**同一个文件**里，在一条上加东西时
   * 顺手碰坏另一条，是这类改动的典型形状。
   *
   * 判据分两层：
   *   ① 返回值形状不变（text 原样、usage 如实来自 router）；
   *   ② 产出文本里**不含**团队审计块（那是团队路径独有的）。
   */
  const call: CallModel = async () => ({
    text: '这是单模型的回复',
    latencyMs: 7,
    usage: { promptTokens: 1_234, completionTokens: 56, cachedTokens: 78, reasoningTokens: 9 },
  });
  const model = createRoutedDecisionModel({
    router: new ModelRouter({ call }),
    request: { role: 'market_analyst', tier: 'T2_mid' },
    baseMaxTokens: 4096,
  });
  const result = await model.complete(SYS, USER);

  assert.equal(result.text, '这是单模型的回复', '★ 单模型的正文必须原样');
  assert.equal(result.usage.promptTokens, 1_234, '★ 单模型用量必须如实透传（原本就对）');
  assert.equal(result.usage.completionTokens, 56);
  assert.equal(result.latencyMs, 7);
  assert.ok(!result.text.includes('<team>'), '★ 单模型路径不该出现团队审计块');
});

/* -------------------------------------------------------------------------- */
/*  ⑤ 负向校准：硬编码 null 不得复活                                            */
/* -------------------------------------------------------------------------- */

test('★★★ 源码里不得再有硬编码的 usage: { null, null }＋团队回退值必须是累加量', async () => {
  /*
   * 这条是"**去掉修复后测试变红**"的机械形式：
   * 它直接把那个**事故形状**（硬编码 null 的 usage）钉成禁止项。
   *
   * ⚠️ 为什么用源码断言而不是只靠行为断言：
   * 行为断言只能覆盖**走到的那条路**；而"某处又写死一个 null"是可以在
   * 其他分支（例如新的角色）里悄悄复活的。这条把字面量本身列为禁止项。
   */
  const src = readFileSync(new URL('./routedModel.ts', import.meta.url), 'utf8');

  assert.ok(
    !/usage:\s*\{\s*promptTokens:\s*null,\s*completionTokens:\s*null\s*\}/.test(src),
    '★ 不得再出现硬编码的 `usage: { promptTokens: null, completionTokens: null }` —— ' +
      '它正是"团队 482 轮账目全空"的那个形状',
  );

  /* 团队出口必须交的是**累加量**，而不是任何字面量。 */
  assert.ok(
    /usage:\s*teamUsage\s*\?\?/.test(src),
    '★ 团队 complete() 必须交 `teamUsage`（整轮累加量）',
  );
  /* 累加器必须在团队路径里真的被调用（否则 teamUsage 永远等于第一轮）。 */
  assert.ok(
    /accumulate\(/.test(src),
    '★ 必须存在累加调用（多轮交易台要相加，不是覆盖）',
  );
  /* agent 层那条路本来就对，不得被顺手改掉。 */
  assert.ok(
    /singleModel\.complete\(systemPrompt,\s*userPrompt\)/.test(src),
    '★ agent 层分支必须原样保留（它一直如实报用量）',
  );
});

/* -------------------------------------------------------------------------- */
/*  ⑥ 汇总器的边界                                                              */
/* -------------------------------------------------------------------------- */

test('★ sumRoleUsage：空输入 / 全 undefined 都必须是"不知道"', () => {
  assert.equal(sumRoleUsage([]).reported, false);
  assert.equal(sumRoleUsage([]).usage, null);
  assert.equal(sumRoleUsage([null, undefined]).reported, false, '★ 全空仍要能区分"不知道"');

  const ok: DeskRoleOutput = {
    role: 'judge',
    modelId: 'm',
    data: null,
    raw: '',
    latencyMs: 1,
    ok: true,
    usage: { promptTokens: 10, completionTokens: 2, cachedTokens: 0, reasoningTokens: 0 },
  };
  /* 失败角色不编造用量 ⇒ 不影响真值，也不阻止 others 累加。 */
  const failed: DeskRoleOutput = { role: 'bull', modelId: '（未调用成功）', data: null, raw: '', latencyMs: 5, ok: false, error: '超时' };
  const summed = sumRoleUsage([ok, failed]);
  assert.equal(summed.reported, true, '★ 只要有一个角色报了，就算有账');
  assert.equal(summed.usage?.promptTokens, 10);
  assert.equal(summed.usage?.cachedTokens, 0, '★ 报了 0 就是 0（与"不知道"不同）');
});
