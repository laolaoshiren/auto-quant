/**
 * 候选链排序的测试。
 *
 * ## 为什么这里要测得具体（实测踩到的性能问题）
 *
 * 原来的排序是"**先按免费分组，再按速度排**"。于是实测：
 *
 * ```
 *   T1_fast 候选链：
 *     1. nemotron-3.5-lightning-free   free=true  reasoning=Y  3246ms
 *     2. muse-spark-...-free           free=true  reasoning=Y  4140ms
 *     3. big-pickle                    free=true  reasoning=Y  4314ms
 *     4. deepseek-v4.1-flash           free=false reasoning=-  1505ms  ← 最快却排第 4
 * ```
 *
 * **前三个都是思维链模型**，真实提示词（20 个标的）下单个角色要 **47–59 秒**；
 * 而最快的两个（约 1.5 秒）因为"要花钱"被排到后面。整轮决策因此要数分钟。
 *
 * 对 7×24 持续工作来说，**快本身就是产出** —— 省下的时间能做更多轮决策。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MODEL_PROFILES, ladderForTier, profileOf, registerDiscoveredProfiles, clearRuntimeProfiles, runtimeProfileCount } from './modelCatalog.js';
import { budgetFor } from './modelRouter.js';

test('★★ T1（体力活）候选链的第 1 位必须是【最快的那个】', () => {
  /*
   * 这是实测修正的核心：体力活的瓶颈是**速度**，不是钱。
   * 实测思维链模型要 47–59 秒，非思维链的约 1.5 秒 —— 差 30 倍。
   */
  const ladder = ladderForTier('T1_fast');
  const first = ladder[0]!;
  const fastest = [...MODEL_PROFILES.filter((m) => m.tier === 'T1_fast' && m.verified)].sort(
    (a, b) => (a.measuredMs ?? 1e9) - (b.measuredMs ?? 1e9),
  )[0]!;

  assert.equal(first.id, fastest.id, `★ T1 首选应当是最快的（实际 ${first.id} ${first.measuredMs}ms）`);
  assert.ok(
    (first.measuredMs ?? 1e9) < 3_000,
    `★ T1 首选的实测耗时应当 <3 秒，实际 ${first.measuredMs}ms —— 否则整轮会很慢`,
  );
});

test('★★ T1 的首选不能是思维链模型（它们在体力活上又慢又被自己的推理带偏）', () => {
  const first = ladderForTier('T1_fast')[0]!;
  assert.equal(first.reasoning, false, `★ T1 首选不该是思维链模型（实际 ${first.id}）`);
});

test('★★ T3（判断）候选链不能被"免费"压制 —— 质量直接决定盈亏', () => {
  /*
   * 辩论与裁决的质量直接影响交易结果。把它们让位给免费模型是**省小钱亏大钱**。
   * （额度耗尽时由健康记录与降级链兜底，那是运行期的事。）
   */
  const ladder = ladderForTier('T3_deep');
  assert.equal(ladder[0]!.free, false, '★ T3 首选应当是最强的付费模型，而不是免费的');
});

test('★ 每个档位仍然保留免费兜底（额度见底时不能停摆）', () => {
  /*
   * 这条与上面"速度优先"不矛盾：
   * **首选要快/要强，但链上必须还有免费的** —— 否则额度一尽就停摆。
   */
  for (const tier of ['T1_fast', 'T2_mid', 'T3_deep'] as const) {
    const ladder = ladderForTier(tier);
    assert.ok(
      ladder.some((m) => m.free),
      `★ 档位 ${tier} 的候选链里必须有免费模型`,
    );
  }
});

test('★ 兜底档优先选免费的（要能长期靠得住）', () => {
  /*
   * T1 的降级路径是 `T1 → T2`，而 T2 那一段是"兜底段"。
   * 兜底段应当免费优先 —— 付费额度留给主力。
   */
  const ladder = ladderForTier('T1_fast');
  const t2Part = ladder.filter((m) => m.tier === 'T2_mid');
  if (t2Part.length > 0) {
    assert.equal(t2Part[0]!.free, true, '★ 兜底段应当免费优先');
  }
});

test('候选链里没有重复模型', () => {
  for (const tier of ['T1_fast', 'T2_mid', 'T3_deep'] as const) {
    const ids = ladderForTier(tier).map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `★ 档位 ${tier} 的候选链有重复`);
  }
});

/* -------------------------------------------------------------------------- */
/*  动态发现的模型也要有 profile（2026-10-17，修 T1 整链全灭）                    */
/* -------------------------------------------------------------------------- */

/** 一个真实的"动态发现"条目（服务器 /v1/models 实测值，2026-10-17）。 */
const DISCOVERED_BEAM = {
  id: 'opencode-zen-free/beam-free',
  reasoning: true,
  contextTokens: 1_048_576,
  maxOutputTokens: 131_072,
};

test('★★★ 动态发现的模型注册后，profileOf 必须能取到（否则 budgetFor 拿不到 reasoning）', () => {
  /*
   * ## 这条修的是"整链全灭"的**第③环**
   *
   * 因果链（每一环都实测过）：
   * ```
   *   ① T1_fast 的候选是动态发现的免费模型
   *   ② 它们不在 MODEL_PROFILES 里（grep 'beam-free' modelCatalog.ts → 0 命中）
   *   ③ profileOf() 返回 undefined
   *   ④ budgetFor(undefined, …) 拿不到 reasoning ⇒ 不知道要不要放大
   *   ⑤ 思维链吃光预算 ⇒ content=0 ⇒ 整链全灭
   * ```
   * t117 修的是 ④ 的**兜底**（undefined 也盲放大 ×4）。
   * 本条修的是 ③ —— **让 profile 真的存在**，于是 ④ 有依据、能夹上限。
   */
  clearRuntimeProfiles();
  try {
    assert.equal(profileOf(DISCOVERED_BEAM.id), undefined, '注册前应当是 undefined（这就是缺陷现场）');
    registerDiscoveredProfiles([DISCOVERED_BEAM]);
    const p = profileOf(DISCOVERED_BEAM.id);
    assert.ok(p !== undefined, '★ 注册后必须能取到');
    assert.equal(p!.reasoning, true, '★ reasoning 必须来自发现层（不是猜的）');
    assert.equal(p!.maxOutputTokens, 131_072, '★ 输出上限必须来自发现层');
    assert.equal(p!.contextTokens, 1_048_576, '★ 上下文必须来自发现层');
  } finally {
    clearRuntimeProfiles();
  }
});

test('★★★ 静态档案优先 —— 运行期注册不能覆盖人写的字段', () => {
  /*
   * ⚠️ 静态档案里有人写的 `measuredMs` 与 `goodFor`（排序与提示词要用）。
   * 若运行期注册覆盖它，那两列会变成 null/占位 —— 排序会退化。
   */
  clearRuntimeProfiles();
  try {
    const existing = MODEL_PROFILES.find((m) => m.id === 'opencode-zen-free/space-bunny-free');
    assert.ok(existing, '静态档案里应当有 space-bunny-free');
    registerDiscoveredProfiles([
      { id: existing!.id, reasoning: false, contextTokens: 1, maxOutputTokens: 1 },
    ]);
    const p = profileOf(existing!.id);
    assert.equal(p!.reasoning, existing!.reasoning, '★ 静态档案的 reasoning 不能被覆盖');
    assert.equal(p!.measuredMs, existing!.measuredMs, '★ 静态档案的实测耗时不能被覆盖');
    assert.equal(runtimeProfileCount(), 0, '★ 静态已存在的 id 不该进运行期表');
  } finally {
    clearRuntimeProfiles();
  }
});

test('★★★ 负向校准：不注册时 budgetFor 只能靠盲放大（拿不到 maxOutputTokens）', () => {
  /*
   * ## 这条是队长要求的"负向校准"
   *
   * 构造"动态模型 + profile undefined"的场景，断言：
   * ```
   *   不注册 → budgetFor 仍然放大（t117 的兜底），但**无法夹上限**
   *   注册后 → budgetFor 放大**且**按 maxOutputTokens 夹
   * ```
   * 若两者**完全一样**，说明本改动没有实际效果 —— 那这条守卫就是空的。
   *
   * ⚠️ 用一个大到会被夹的 base（200_000）来暴露差异：
   * `beam-free` 的 maxOutputTokens 是 131_072，所以放大后会被夹到 131_072。
   */
  clearRuntimeProfiles();
  try {
    const base = 200_000;
    const withoutProfile = budgetFor(undefined, base);
    assert.equal(withoutProfile, base * 4, '不注册时：盲放大 ×4（t117 的兜底，没有上限可夹）');

    registerDiscoveredProfiles([DISCOVERED_BEAM]);
    registerDiscoveredProfiles([DISCOVERED_BEAM]);
    const withProfile = budgetFor(profileOf(DISCOVERED_BEAM.id), base);
    /*
     * ⚠️ 这里断言的是 `max(base, min(maxOut, base*4))` —— **不是** `min(maxOut, base*4)`。
     * 因为 `budgetFor` 有一条"永不小于 base"的保底（`Math.max(baseMaxTokens, …)`），
     * 那是 2026-10-12 修 P1-D 时加的（防"上限比 base 小就把预算缩下去"）。
     * 所以 base=200_000 > maxOut=131_072 时，结果是 **200_000（= base）**。
     *
     * 我第一版断言 `withProfile > base`，被测试当场抓出 —— 那是我把
     * "夹上限"与"保底"混为一谈了。**保底优先是对的**：调用方显式要了 20 万预算，
     * 不该因为档案里的上限更低就偷偷减半（供应商会自己拒超限请求）。
     */
    assert.equal(withProfile, base, '★ 注册后：maxOut(131072) < base(200000) ⇒ 保底生效，返回 base');
    assert.equal(withoutProfile, base * 4, '不注册时：盲放大 4 倍，无上限可夹');
    /*
     * ⚠️ 这一条才是"有 profile"真正带来的差异：
     * **当 base 较小、放大后会被 maxOut 夹住时**，注册与不注册结果不同。
     */
    const smallBase = 40_000;
    const noProfileSmall = budgetFor(undefined, smallBase);
    const withProfileSmall = budgetFor(profileOf(DISCOVERED_BEAM.id), smallBase);
    assert.equal(noProfileSmall, smallBase * 4, '不注册：盲放大到 160000（超过 maxOut 也不管）');
    assert.equal(
      withProfileSmall,
      DISCOVERED_BEAM.maxOutputTokens,
      '★ 注册后：被 maxOutputTokens 夹到 131072（这正是 profile 带来的信息）',
    );
    assert.notEqual(withProfileSmall, noProfileSmall, '★ 注册与不注册必须有可观测差异');
    assert.notEqual(
      withProfile,
      withoutProfile,
      '★ 注册与不注册必须有可观测差异 —— 否则这条守卫是空的',
    );
  } finally {
    clearRuntimeProfiles();
  }
});

test('★★ 注册是幂等的（重复调用不报错、不重复计数）', () => {
  clearRuntimeProfiles();
  try {
    registerDiscoveredProfiles([DISCOVERED_BEAM]);
    registerDiscoveredProfiles([DISCOVERED_BEAM]);
    assert.equal(runtimeProfileCount(), 1, '★ 同一个 id 重复注册应当只占一条');
  } finally {
    clearRuntimeProfiles();
  }
});

test('★ 空列表/非法条目不会污染运行期档案', () => {
  clearRuntimeProfiles();
  try {
    registerDiscoveredProfiles([]);
    assert.equal(runtimeProfileCount(), 0);
    registerDiscoveredProfiles([{ id: '', reasoning: true, contextTokens: 1, maxOutputTokens: 1 }]);
    assert.equal(runtimeProfileCount(), 0, '★ 空 id 应当被跳过');
  } finally {
    clearRuntimeProfiles();
  }
});
