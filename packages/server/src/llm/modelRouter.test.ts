/**
 * 模型中枢的测试 —— **重点钉住用户最关心的那条：额度不足时自动向下平替**。
 *
 * 用户 2026-10-12 的原话：
 *
 * > 「万一claude额度不足了，系统能智能把主管模型换成向下平替。保证系统不中断，持续工作」
 *
 * 所以这里不是测"函数返回了什么"，而是测**系统在故障下还能不能干活**。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { MODEL_PROFILES, ladderForTier, profileOf, type ModelProfile } from './modelCatalog.js';
import { ModelHealthRegistry, classifyFailure, pickAvailable } from './modelHealth.js';
import { ModelRouter, budgetFor, retryBudgetFor, type CallModel } from './modelRouter.js';

/* -------------------------------------------------------------------------- */
/*  模型档案                                                                   */
/* -------------------------------------------------------------------------- */

test('★ 每个档位都有候选链，且 T1/T2 必须有免费兜底（额度见底时的生命线）', () => {
  /*
   * 实测事实：`workbuddy-ai` 只剩 3.13/350 credits、`cline` 只剩 $0.50。
   * 所以"没有免费兜底"的档位 = 额度一尽就停摆。
   */
  for (const tier of ['T1_fast', 'T2_mid', 'T3_deep'] as const) {
    const ladder = ladderForTier(tier);
    assert.ok(ladder.length > 0, `档位 ${tier} 不能是空的`);
    assert.ok(
      ladder.some((m) => m.free),
      `★ 档位 ${tier} 必须有免费候选 —— 否则额度用尽时系统会停摆`,
    );
  }
});

test('★ T1 的候选链把【最快的】排在前面（实测修正：速度比免费更重要）', () => {
  /*
   * ⚠️ **这条断言在 2026-10-12 被实测推翻并改写过。**
   *
   * 原来断言的是"T1 首选应当免费"（理由：体力活不该烧付费额度）。
   * 但实测发现那样排出来的链是这样的：
   *
   *     nemotron-free(3.2s, 思维链) → muse-spark-free(4.1s, 思维链) → big-pickle-free(4.3s) → deepseek-v4.1-flash(1.5s)
   *
   * 前三个都是**思维链模型**，在真实提示词（20 个标的）下要 **47–59 秒**；
   * 而最快的那个（1.5 秒）因为"要花钱"被排到第 4 位。整轮决策因此要数分钟。
   *
   * **对 7×24 持续工作来说，快本身就是产出** —— 省下的时间能做更多轮决策。
   * 所以现在 T1 的首选是**最快的那个**（是否免费只是加分项）。
   *
   * 完整的排序口径见 `modelCatalog.scoreFor()`。
   */
  const t1 = ladderForTier('T1_fast');
  assert.ok(
    (t1[0]!.measuredMs ?? 1e9) < 3_000,
    `★ T1 首选应当是快的（实际 ${t1[0]!.id} ${t1[0]!.measuredMs}ms）`,
  );
  assert.equal(t1[0]!.reasoning, false, '★ T1 首选不该是思维链模型（它们又慢又容易被推理带偏）');
});

test('T3 的候选链把强模型排在前面（辩论与裁决需要智商）', () => {
  const t3 = ladderForTier('T3_deep');
  assert.equal(t3[0]!.free, false, 'T3 首选应当是最强的，不是免费的');
});

test('档案里的实测数据自洽（有耗时的都应是已验证）', () => {
  for (const m of MODEL_PROFILES) {
    if (m.measuredMs !== null) {
      assert.equal(m.verified, true, `${m.id} 有实测耗时却没标记 verified`);
      assert.ok(m.measuredMs > 0, `${m.id} 的耗时必须是正数`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  失败分类 —— 决定"重试"还是"降级"                                            */
/* -------------------------------------------------------------------------- */

test('★ 429 有两种含义，必须靠 message 区分（实测结论）', () => {
  /*
   * 实测：magpie 用 429 同时表达"限流"与"端点不可用/额度尽"。
   * 只看状态码会把"额度尽"误判成"限流"，于是永远在原地重试、永不降级。
   */
  const quota = classifyFailure({
    status: 429,
    message: 'OpenCode Zen Free: Upstream request failed: Endpoint is unavailable.',
  });
  assert.equal(quota.kind, 'endpoint_down', '★ 429 + Endpoint unavailable 必须判为降级');
  assert.equal(quota.shouldFallback, true);

  const limited = classifyFailure({ status: 429, message: 'rate limit exceeded, retry later' });
  assert.equal(limited.kind, 'rate_limited', '429 + rate limit 应判为限流');
  assert.equal(limited.shouldFallback, false, '限流应当先退避重试，不是立刻换模型');
  assert.equal(limited.shouldRetry, true);
});

test('★ HTTP 200 + 空内容 + finish=length → 先加预算重试，失败后【换模型】', () => {
  /*
   * ## 这条判据改过三次，最终依据是实测（2026-10-12）
   *
   * ### 原设计：`shouldFallback: false`
   *
   * 理由："思维链吃光预算是加预算能修的，换模型会白丢最强模型。"
   *
   * ### 实测：**只对小材料成立**
   *
   * 真实角色材料 55,014 字符，同一路由组：
   * ```
   *   max_tokens=1024 → 15.7s · finish=length · content=   0 字 · reasoning= 2239 字
   *   max_tokens=2048 → 27.7s · finish=length · content=   0 字 · reasoning= 2649 字
   *   max_tokens=4096 → 47.5s · finish=length · content=   0 字 · reasoning= 9632 字
   * ```
   * **加预算完全无效 —— 它只是"想得更久"，永远不写正式回答。**
   *
   * 而同一模型在小输入下完全正常：
   * ```
   *   小输入 + 描述任务 → 6.8s · finish=stop · content=126 字   ✅
   * ```
   *
   * ### 所以：`shouldFallback: true`
   *
   * 判据里**拿不到"材料多大"**，所以选更安全的行为：
   * **换模型**（代价：多一次调用；收益：不至于整条链冷却、角色缺席）。
   *
   * ⚠️ `shouldRetry: true` 保留 —— 先加预算重试一次仍然值得
   *（小材料那种情况它能修好），失败后**再换**。两种场景都覆盖。
   */
  const v = classifyFailure({ status: 200, message: '', emptyContent: true, finishReason: 'length' });
  assert.equal(v.kind, 'empty_content');
  assert.equal(v.shouldFallback, true, '★ 大材料场景下加预算修不了，必须允许换模型');
  assert.equal(v.shouldRetry, true, '★ 但仍先加预算重试一次（小材料场景它能修）');
});

test('★ 400 请求错【不降级】—— 降级会掩盖真正的 bug', () => {
  const v = classifyFailure({ status: 400, message: 'invalid request: model must be a nonempty string' });
  assert.equal(v.kind, 'bad_request');
  assert.equal(v.shouldFallback, false);
  assert.equal(v.shouldRetry, false);
});

test('404 knows no model → 立刻降级', () => {
  const v = classifyFailure({ status: 404, message: 'magpie knows no model "x"; did you mean…' });
  assert.equal(v.kind, 'model_missing');
  assert.equal(v.shouldFallback, true);
  assert.equal(v.shouldRetry, false);
});

/* -------------------------------------------------------------------------- */
/*  健康注册表 —— 冷却而不是永久拉黑                                             */
/* -------------------------------------------------------------------------- */

test('★ 单次失败不冷却（实测：同一模型可用性会波动）', () => {
  /*
   * 实测 `ling-3.1-flash-free`：mt=512 成功、mt=16/128/2048 失败。
   * 如果一次失败就拉黑，一个瞬时抖动会把好模型永久踢出候选链。
   */
  let now = 1_000_000;
  const h = new ModelHealthRegistry(2, 60_000, () => now);
  h.recordFailure('m1', 'boom');
  assert.equal(h.isAvailable('m1'), true, '★ 第一次失败不该冷却');
  h.recordFailure('m1', 'boom');
  assert.equal(h.isAvailable('m1'), false, '连续第二次失败才冷却');
  now += 60_001;
  assert.equal(h.isAvailable('m1'), true, '冷却到期后应恢复可用');
});

test('成功会清零连续失败计数', () => {
  const h = new ModelHealthRegistry(2, 60_000, () => 1_000_000);
  h.recordFailure('m1', 'x');
  h.recordSuccess('m1');
  h.recordFailure('m1', 'x');
  assert.equal(h.isAvailable('m1'), true, '成功之后重新计数');
});

/* -------------------------------------------------------------------------- */
/*  路由器 —— 端到端：额度不足时自动平替                                          */
/* -------------------------------------------------------------------------- */

/** 造一个可控的调用桩：按模型名决定成功还是失败。 */
function stubCall(behavior: Record<string, { ok: boolean; status?: number; message?: string; text?: string }>): CallModel {
  return async (modelId) => {
    const b = behavior[modelId] ?? { ok: true, text: '默认成功' };
    if (!b.ok) {
      const err = new Error(b.message ?? 'boom') as Error & { status?: number };
      if (b.status !== undefined) err.status = b.status;
      throw err;
    }
    return {
      text: b.text ?? '成功',
      latencyMs: 10,
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  };
}

test('★★ 核心用例：首选模型额度耗尽 → 自动平替到下一个，系统不中断', async () => {
  /*
   * 这是用户最关心的场景：
   *   「万一claude额度不足了，系统能智能把主管模型换成向下平替。保证系统不中断，持续工作」
   *
   * 首选（最强的那个）返回"额度尽"，路由器应当自动换到下一个候选并成功。
   */
  const ladder = ladderForTier('T3_deep').map((m) => m.id);
  const first = ladder[0]!;
  const second = ladder[1]!;

  const router = new ModelRouter({
    call: stubCall({
      [first]: { ok: false, status: 429, message: 'You have insufficient credits to make this request.' },
      [second]: { ok: true, text: '平替成功' },
    }),
  });

  const result = await router.callByTier('T3_deep', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 100 });

  assert.equal(result.text, '平替成功', '★ 必须拿到内容 —— 系统不能因为首选额度尽就停摆');
  assert.equal(result.modelId, second, '★ 应当自动换到第二候选');
  assert.equal(result.attempts.length, 2, '应当能看到"试了两个模型"');
  assert.equal(result.attempts[0]!.ok, false, '★ 第一次尝试的失败必须被记录（可观测）');
  assert.equal(result.attempts[1]!.ok, true);
});

test('★ 首选 404（模型下线）也能平替', async () => {
  const ladder = ladderForTier('T1_fast').map((m) => m.id);
  const router = new ModelRouter({
    call: stubCall({
      [ladder[0]!]: { ok: false, status: 404, message: 'magpie knows no model "x"' },
      [ladder[1]!]: { ok: true, text: 'ok' },
    }),
  });
  const r = await router.callByTier('T1_fast', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 64 });
  assert.equal(r.modelId, ladder[1]!);
});

test('★ 400 请求错必须原样抛出，【不许】靠换模型掩盖', async () => {
  const ladder = ladderForTier('T1_fast').map((m) => m.id);
  const router = new ModelRouter({
    call: stubCall({
      [ladder[0]!]: { ok: false, status: 400, message: 'invalid request: json: cannot unmarshal' },
      [ladder[1]!]: { ok: true, text: '不该走到这里' },
    }),
  });
  await assert.rejects(
    () => router.callByTier('T1_fast', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 64 }),
    /invalid request/,
    '★ 400 是代码 bug，换模型只会掩盖它',
  );
});

test('★ 空内容会重试并最终成功（不是立刻失败）', async () => {
  const ladder = ladderForTier('T2_mid').map((m) => m.id);
  let call = 0;
  const router = new ModelRouter({
    call: async (modelId) => {
      call += 1;
      if (call === 1) return { text: '   ', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 0 } };
      return { text: '第二次有内容了', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  });
  const r = await router.callByTier('T2_mid', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 64 });
  assert.equal(r.text, '第二次有内容了');
  assert.equal(r.attempts[0]!.ok, false, '第一次的空内容要被记录');
});

test('★ 整条链都不可用时【抛出】，不假装成功', async () => {
  /*
   * P2 原则（最终决定权由代码强制）：没有可用模型时必须报出来，
   * 而不是静默返回一个空结果 —— 那会让上层以为"模型说没事"。
   */
  const ladder = ladderForTier('T1_fast').map((m) => m.id);
  const behavior: Record<string, { ok: boolean; status?: number; message?: string }> = {};
  for (const id of ladder) behavior[id] = { ok: false, status: 429, message: 'insufficient credits' };

  const router = new ModelRouter({ call: stubCall(behavior), maxFallbacks: 3 });
  await assert.rejects(
    () => router.callByTier('T1_fast', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 64 }),
    /候选链全部处于冷却期|都失败/,
  );
});

test('T0_code 档不调用模型（这类工作必须由代码完成）', async () => {
  const router = new ModelRouter({ call: stubCall({}) });
  await assert.rejects(
    () => router.callByTier('T0_code', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 64 }),
    /T0_code/,
  );
});

/* -------------------------------------------------------------------------- */
/*  输出预算                                                                   */
/* -------------------------------------------------------------------------- */

test('★ 思维链模型的输出预算被放大（否则实测会得到 content=null）', () => {
  const reasoningModel = MODEL_PROFILES.find((m) => m.reasoning && m.tier === 'T3_deep');
  assert.ok(reasoningModel, '档案里应当有思维链模型');
  const budget = budgetFor(reasoningModel, 100);
  assert.ok(budget > 100, `★ 思维链模型预算应放大，实际 ${budget}`);

  const plain = MODEL_PROFILES.find((m) => !m.reasoning);
  assert.ok(plain);
  assert.equal(budgetFor(plain, 100), 100, '非思维链模型不该被放大');
});

/* -------------------------------------------------------------------------- */
/*  候选挑选                                                                   */
/* -------------------------------------------------------------------------- */

test('pickAvailable 跳过冷却中的模型', () => {
  const h = new ModelHealthRegistry(1, 60_000, () => 1_000_000);
  h.recordFailure('a', 'x');
  assert.equal(pickAvailable(['a', 'b'], h), 'b');
  assert.equal(pickAvailable(['a'], h), null, '全冷却时返回 null（由调用方决定怎么办）');
});

test('profileOf 能按 id 取到档案', () => {
  assert.ok(profileOf('workbuddy-ai/deepseek-v4.1-flash'));
  assert.equal(profileOf('不存在的模型'), undefined);
});

/* -------------------------------------------------------------------------- */
/*  复核发现的问题的回归测试（2026-10-12）—— 每条都对应一个真实缺陷              */
/* -------------------------------------------------------------------------- */

test('★★ budgetFor 绝不能【缩小】预算（复核发现的 P1-D）', () => {
  /*
   * 第一版的 `Math.min(maxOutput, base*4)` 在 `maxOutput < base*4` 时
   * 返回的比 base 还小 —— 例如 big-pickle（maxOutput=32000）配 base=131072
   * → 返回 32000（base 的 0.24 倍），**正好制造它要防的 `content: null`**。
   *
   * 原来的测试用 `find(m => m.reasoning && m.tier === 'T3_deep')` 取到 kimi-k3，
   * 而它 `maxOutputTokens === 0`（走 base×4 那条路）——
   * **测试恰好只覆盖了唯一不会暴露 bug 的那个模型**。
   *
   * 所以这里**遍历所有思维链模型**，而不是挑一个。
   */
  const reasoning = MODEL_PROFILES.filter((m) => m.reasoning);
  assert.ok(reasoning.length > 0);
  for (const m of reasoning) {
    const base = 131_072;
    const budget = budgetFor(m, base);
    assert.ok(
      budget >= base,
      `★ ${m.id}（maxOutput=${m.maxOutputTokens}）的预算 ${budget} 小于基准 ${base} —— 绝不能缩小`,
    );
  }
});

test('★ budgetFor 对【报了上限】的思维链模型仍然放大，但不超过上限', () => {
  const withLimit = MODEL_PROFILES.find((m) => m.reasoning && m.maxOutputTokens > 0);
  assert.ok(withLimit, '档案里应当有"报了输出上限"的思维链模型');
  const budget = budgetFor(withLimit, 1000);
  assert.ok(budget > 1000, '★ 应当放大');
  assert.ok(budget <= withLimit.maxOutputTokens, '★ 不超过供应商声明的上限');
});
/* -------------------------------------------------------------------------- */
/*  T1_fast 整链全灭（2026-10-17 线上实测）—— 未登记模型的预算放大               */
/* -------------------------------------------------------------------------- */

test('★★★ 未登记档案的模型【也必须放大】预算 —— 否则整条 T1 链被思维链吃光', () => {
  /*
   * ## 线上事故（2026-10-17 16:37:36，团队 #11）
   *
   * ```
   *   并行分析 失败：档位 T1_fast 试了 4 个模型都失败：
   *     opencode-zen-free/beam-free         → 输出被 token 上限截断（思维链占满了预算）
   *     opencode-zen-free/beam-free         → 同上（第二次）
   *     opencode-zen-free/space-bunny-free  → 同上
   *     group/auto-space-bunny-free         → 同上
   * ```
   *
   * ## 根因
   *
   * `budgetFor` 原来是 `if (profile?.reasoning !== true) return baseMaxTokens;` ——
   * **`profileOf()` 对不在 `MODEL_PROFILES` 里的模型返回 `undefined`，于是一律不放大。**
   * 而 `T1_fast` 链上 5 个候选里**只有 `space-bunny-free` 在档案里**，
   * 其余 4 个（`beam-free` / `group/auto-space-bunny-free` / `group/team-grunt` /
   * `group/team-analyst`）都不在 —— 而它们**全都写思维链**。
   *
   * ## 服务器侧量化（28,500 字符材料，`beam-free`）
   *
   * ```
   *   max_tokens=1024 → finish=length · reasoning=1023 · content=  0 字  ← 线上实际发的
   *   max_tokens=2048 → finish=length · reasoning=2047 · content=  0 字  ← 旧重试倍数(×2)
   *   max_tokens=4096 → finish=stop   · reasoning=2336 · content=2244 字  ✅
   * ```
   */
  const base = 1024;
  assert.equal(
    budgetFor(undefined, base),
    base * 4,
    '★ 未知档案必须按"可能带思维链"放大（否则 1024 全被推理吃光）',
  );
});

test('★★★ 只有【明确 reasoning=false】才不放大（已知非思维链模型的行为不变）', () => {
  /*
   * ⚠️ 反向守卫：不能为了修 T1 而把所有模型的预算都翻倍 ——
   * 那会让已知的非思维链模型（如 `workbuddy-ai/fast-model`）白烧一倍额度。
   * 判据是"**明确知道**它不是思维链"才算数，`undefined` 不算。
   */
  const plain = { ...MODEL_PROFILES.find((m) => !m.reasoning)! };
  assert.equal(budgetFor(plain, 1024), 1024, '★ 明确 reasoning=false 时不放大');
});

test('★★★ 截断重试的倍数必须 ≥4 —— ×2 在真实材料规模下必然救不回来', () => {
  /*
   * 实测（同一材料、同一模型）：
   * ```
   *   1024（首次）  → content=0
   *   2048（×2）    → content=0     ← 旧倍数
   *   4096（×4）    → content=2244  ✅
   * ```
   * 而"只重试一次"这条纪律不变（不改成反复加倍）——
   * 变的是"这一次给多少"，不是"可以试几次"。
   */
  const src = readFileSync(new URL('./modelRouter.ts', import.meta.url), 'utf8');
  const m = /const EMPTY_CONTENT_RETRY_MULTIPLIER = (\d+);/.exec(src);
  assert.ok(m, '★ 必须能找到这个常量');
  assert.ok(
    Number(m[1]) >= 4,
    `★ 截断重试倍数必须 ≥4（实测 ×2 = 2048 时 content 仍是 0 字），实际 ${m[1]}`,
  );
  /* 仍然只重试一次（不许变成"反复加倍"）。 */
  assert.ok(
    /budgetBoosted === null/.test(src),
    '★ 必须仍然只在"还没放大过"时重试一次（防无界重试）',
  );
});

test('★★ 反向校准：把 budgetFor 改回"未登记不放大"，这套判据必须报错', () => {
  /*
   * ⚠️ 防"恒真断言"：如果 `budgetFor(undefined, x)` 恰好总是等于 `x*4`，
   * 那上面那条测试就没有意义。这里用一个人造实现跑同一套判据，
   * 确认它**会**失败。
   */
  const oldBehavior = (profile: { reasoning?: boolean } | undefined, base: number): number =>
    profile?.reasoning !== true ? base : base * 4;
  const base = 1024;
  assert.equal(oldBehavior(undefined, base), base, '旧实现确实不放大（这就是被修掉的行为）');
  assert.notEqual(
    oldBehavior(undefined, base),
    budgetFor(undefined, base),
    '★ 新旧实现必须不同 —— 否则这条守卫是空的',
  );
});

test('★ 冷却【到期后会清零失败计数】（复核发现的 P1-E）', () => {
  /*
   * 原来只在 recordSuccess 里清零，于是到期后 `consecutiveFailures` 仍是阈值，
   * **下一次单点失败立刻又冷却** —— 一个"每 5 分钟试一次就再关 5 分钟"的模型
   * 实际可用率接近 0，与本类"单次失败不足以判死"的承诺相反。
   */
  let now = 1_000_000;
  const h = new ModelHealthRegistry(2, 60_000, () => now);
  h.recordFailure('m', 'a');
  h.recordFailure('m', 'b');
  assert.equal(h.isAvailable('m'), false, '连续两次失败应冷却');

  now += 60_001;
  assert.equal(h.isAvailable('m'), true, '到期后应恢复');
  /* ★ 关键：到期后**一次**失败不该立刻又冷却 */
  h.recordFailure('m', 'c');
  assert.equal(h.isAvailable('m'), true, '★ 到期后计数必须已清零 —— 单次失败不该立刻重新冷却');
});

test('★★ 被 token 上限截断 → 加大预算【重试同一个模型】（复核发现的 P1-C）', async () => {
  /*
   * `classifyFailure` 对 `empty_content + finishReason='length'` 明确返回
   * `shouldRetry: true, shouldFallback: false`，理由写的是"加大 max_tokens 重试"。
   * 但第一版的实现是"换下一个候选"—— 循环顶部跳过了 `tried`，
   * **同一个模型永远不会被第二次选中**，那条分支等于白写。
   *
   * 而换模型会白白丢掉最强的那个（它只是这次话说得多了一点，不是坏了）。
   */
  const calls: Array<{ model: string; maxTokens: number }> = [];
  const router = new ModelRouter({
    call: async (modelId, _msgs, options) => {
      calls.push({ model: modelId, maxTokens: options.maxTokens });
      /* 第一次（小预算）被截断，第二次（大预算）成功 */
      if (calls.length === 1) {
        return { text: '', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 0 }, finishReason: 'length' };
      }
      return { text: '成功了', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' };
    },
  });

  const r = await router.callByTier('T3_deep', [{ role: 'user', content: 'hi' }], { baseMaxTokens: 4096 });

  assert.equal(r.text, '成功了');
  assert.equal(calls.length, 2, '应当重试了一次');
  assert.equal(calls[1]!.model, calls[0]!.model, '★ 必须重试【同一个】模型，而不是换模型');
  assert.ok(
    calls[1]!.maxTokens > calls[0]!.maxTokens,
    `★ 第二次的预算必须【更大】（${calls[0]!.maxTokens} → ${calls[1]!.maxTokens}）`,
  );
});

test('★ 空内容但【不是】被截断 → 走降级路径（不与截断混淆）', async () => {
  /*
   * 区分这两种情况是 `finishReason` 存在**唯一**的理由：
   *   · 被截断 → 加大预算重试同一模型（它没坏）
   *   · 真空回复 → 重试/降级（可能真的坏了）
   */
  const calls: string[] = [];
  const ladder = ladderForTier('T1_fast').map((m) => m.id);
  const router = new ModelRouter({
    call: async (modelId) => {
      calls.push(modelId);
      if (calls.length === 1) {
        /* 空内容，但 finishReason 不是 length → 真空回复 */
        return { text: '', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 0 }, finishReason: 'stop' };
      }
      return { text: 'ok', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 1 }, finishReason: 'stop' };
    },
  });
  const r = await router.callByTier('T1_fast', [{ role: 'user', content: 'x' }], { baseMaxTokens: 512 });
  assert.equal(r.modelId, ladder[1]!, '★ 真空回复应当换模型，而不是原地重试');
});

test('★ 连续被截断时【只放大一次】，不无限重试（防死循环）', async () => {
  /*
   * MAST 分类法实测「步骤重复」是最高频失败模式（15.7%）。
   * "预算越大、思维链写得越长"会收敛不了 —— 所以只放大一次。
   */
  let callCount = 0;
  const router = new ModelRouter({
    call: async () => {
      callCount += 1;
      return { text: '', latencyMs: 1, usage: { promptTokens: 1, completionTokens: 0 }, finishReason: 'length' };
    },
    maxFallbacks: 2,
  });
  await assert.rejects(
    () => router.callByTier('T1_fast', [{ role: 'user', content: 'x' }], { baseMaxTokens: 512 }),
    /都失败/,
    '★ 应当以失败收场，而不是无限重试',
  );
  /* 4 个候选（maxFallbacks=2 → 至多 3 个）+ 至多 1 次放大重试 */
  assert.ok(callCount <= 5, `★ 调用次数必须有界，实际 ${callCount}`);
});
/* -------------------------------------------------------------------------- */
/*  自动发现真的驱动模型选择（复核发现 P2-L：发现曾是"孤岛"）                     */
/* -------------------------------------------------------------------------- */

test('★★ 发现到的候选链【真的】被用于选择模型（"应用到智能体"那一步）', async () => {
  /*
   * 复核发现：`modelDiscovery` 曾经只在测试里被引用 —— **它是座孤岛**。
   * 用户 2026-10-12 要求的「自动发现 → 判断档次 → **应用到相应的智能体中**」，
   * 第三步当时没有实现。
   *
   * 这条测试就是那一步的执行者：给路由器一份"发现结果"，
   * 它必须**优先用发现到的模型**，而不是静态档案。
   */
  const called: string[] = [];
  const router = new ModelRouter({
    call: async (modelId) => {
      called.push(modelId);
      return { text: 'ok', latencyMs: 1, usage: { promptTokens: 0, completionTokens: 0 } };
    },
    /* 一个档案里【没有】的模型名 —— 只有用发现结果才可能被调到 */
    discoveredLadders: { T3_deep: ['newprov/shiny-new-model'] },
  });

  const r = await router.callByTier('T3_deep', [{ role: 'user', content: 'x' }], { baseMaxTokens: 128 });
  assert.equal(r.modelId, 'newprov/shiny-new-model', '★ 必须用发现到的模型（新上线的那个）');
  assert.deepEqual(called, ['newprov/shiny-new-model']);
});

test('★ 发现失败（没给候选链）时回退静态档案 —— 不能因此瘫痪', async () => {
  const router = new ModelRouter({
    call: async (modelId) => ({ text: `来自 ${modelId}`, latencyMs: 1, usage: { promptTokens: 0, completionTokens: 0 } }),
  });
  const r = await router.callByTier('T1_fast', [{ role: 'user', content: 'x' }], { baseMaxTokens: 128 });
  assert.ok(r.modelId.length > 0, '没有发现结果时仍要能选出模型');
});

test('★ 空的发现结果不覆盖静态档案（空数组不等于"没有可用模型"）', async () => {
  /*
   * 边界：发现成功但该档位恰好为空（例如网关只暴露了少量模型）。
   * 这时应当回退档案，而不是直接报"没有候选模型"。
   */
  const router = new ModelRouter({
    call: async (modelId) => ({ text: `来自 ${modelId}`, latencyMs: 1, usage: { promptTokens: 0, completionTokens: 0 } }),
    discoveredLadders: { T1_fast: [] },
  });
  const r = await router.callByTier('T1_fast', [{ role: 'user', content: 'x' }], { baseMaxTokens: 128 });
  assert.ok(r.modelId.length > 0, '空发现结果应回退档案');
});
test('★★ "Credits exhausted" 必须触发降级（自检 AI 层报出的实测缺陷）', () => {
  /*
   * ## 这是自检的 AI 层报出来的真实缺陷（2026-10-12）
   *
   * 自检每 30 分钟跑一次，它的 AI 层报：
   *
   * ```
   *   [自检/ai] AI 层调用失败：WorkBuddy AI: Credits exhausted.
   *   Please visit the link below to purchase add-on packs and get more credits
   * ```
   *
   * 这句话里**没有** `quota` / `insufficient` / `额度` 任何一个词 ——
   * 于是判据没认出来，**没有换模型**，调用就这么失败了。
   *
   * 后果比"一次失败"更大：那个供应商的模型会**一直**被选中、**一直**失败，
   * 直到有人去看日志 —— 而这正是降级链本该解决的问题。
   */
  const v = classifyFailure({
    status: 200,
    message:
      'WorkBuddy AI: Credits exhausted. Please visit the link below to purchase add-on packs and get more credits',
  });
  assert.equal(v.shouldFallback, true, '★ 额度耗尽必须换下一个候选');
  assert.equal(v.shouldRetry, false, '重试同一个模型没用（额度不会自己回来）');
});

test('★ "exhausted" 单独出现也要能识别', () => {
  assert.equal(classifyFailure({ status: 429, message: 'monthly allowance exhausted' }).shouldFallback, true);
});

test('★ 已有的额度判据没被破坏（回归）', () => {
  for (const msg of ['insufficient balance', 'quota exceeded', '额度已尽', 'endpoint is unavailable']) {
    assert.equal(classifyFailure({ status: 429, message: msg }).shouldFallback, true, `「${msg}」应当触发降级`);
  }
});
/* -------------------------------------------------------------------------- */
/*  空内容重试的预算（实测：翻倍被 budgetFor 吃掉，成了空转）                     */
/* -------------------------------------------------------------------------- */

test('★★★ 重试的预算不得低于首次（实测真缺陷：思维链模型首次 16384、重试 8192）', () => {
  /*
   * ## 实测缺陷（2026-10-12）
   *
   * `budgetFor` 第一行是 `if (profile?.reasoning !== true) return baseMaxTokens;`
   * —— 对首次调用正确，但让"空内容重试"**空转**：
   *
   *   ① 模型（实测 `stepfun/step-5-preview`，网关报 `reasoning=false`）返回空内容
   *      （`finish_reason=length`，被截断）；
   *   ② `ModelRouter` 把预算设成 `baseMaxTokens × 2`（**真的翻倍了**）；
   *   ③ 重试时**又走 `budgetFor`** → 返回 `baseMaxTokens`；
   *   ④ 重试用同一份预算 → **必然再次被截断**。
   *
   * 净效果：**白花一次调用，什么都没改变。**
   *
   * 而这类模型在本项目的 magpie 部署里很常见（网关报 `reasoning=false`
   * 或干脆不报元数据）。
   */
  const nonReasoning: ModelProfile = {
    id: 'p/x',
    tier: 'T1_fast',
    free: true,
    reasoning: false,
    verified: true,
    measuredMs: 1000,
    maxOutputTokens: 32_000,
    contextTokens: 200_000,
  } as ModelProfile;

  /* 首次调用：用 base（不放大）—— 这是对的行为，要保住。 */
  assert.equal(budgetFor(nonReasoning, 4_096), 4_096, '首次调用不该放大');

  /* 重试：**必须**用更大的预算，而不是被 reasoning 判断吃掉。 */
  const boosted = 4_096 * 2;
  assert.equal(
    retryBudgetFor(nonReasoning, boosted, 4_096),
    boosted,
    '★ 翻倍重试必须真的用 8192，而不是退回 4096（那正是空转）',
  );

  /*
   * ⚠️ **反面对照：这条注释原来写错了，被测试当场纠正。**
   *
   * 我原以为"非思维链模型走 `budgetFor` 会退回 `baseMaxTokens`，于是翻倍空转"。
   * 实测：`budgetFor(nonReasoning, 8192)` 返回的**就是 8192** ——
   * 因为那个分支是 `return baseMaxTokens`，而"重试路径"传进去的
   * `baseMaxTokens` 参数**本身就是翻倍后的值**。
   *
   * 所以**非思维链模型的翻倍重试本来就没坏**。
   * 真正坏掉的是**思维链模型**那条路径（见下面那条测试：首次 16384、
   * 而 `budgetBoosted` 只用 `baseMaxTokens × 2 = 8192` → **比首次还小**）。
   */
  assert.equal(
    budgetFor(nonReasoning, boosted),
    boosted,
    '非思维链模型会原样采用传入的预算（所以翻倍生效）',
  );
});

test('★ 重试预算不超过模型自己报的上限（超过没意义）', () => {
  const small: ModelProfile = {
    id: 'p/small',
    tier: 'T1_fast',
    free: true,
    reasoning: false,
    verified: true,
    measuredMs: 1000,
    maxOutputTokens: 8_000,
    contextTokens: 32_000,
  } as ModelProfile;
  /* 要求 16384，但模型只支持 8000 → 用 8000。 */
  assert.equal(retryBudgetFor(small, 16_384, 4_096), 8_000);
});

test('★ 模型没报上限时，重试预算原样使用（不猜）', () => {
  const noMeta: ModelProfile = {
    id: 'p/none',
    tier: 'T1_fast',
    free: true,
    reasoning: false,
    verified: true,
    measuredMs: 1000,
    maxOutputTokens: 0,
    contextTokens: 0,
  } as ModelProfile;
  assert.equal(retryBudgetFor(noMeta, 8_192, 4_096), 8_192, '没上限就别夹');
});
test('★★★ 一家供应商额度耗尽 → 熔断它的【全部】模型（实测 T1 试 4 个全撞同一家）', () => {
  /*
   * ## 实测缺陷（2026-10-12）
   *
   * `T1_fast` 档试了 **4 个模型全失败**：
   *
   * ```
   *   [analysis] sentiment：失败：档位 T1_fast 试了 4 个模型都失败：
   *              workbuddy-ai/deepseek-v4.1-flash-…
   * ```
   *
   * 根因：T1 候选链前 5 位**全是 `workbuddy-ai`** —— 而那家**额度已耗尽**
   *（自检早先报过 `WorkBuddy AI: Credits exhausted`）。
   *
   * 为什么原来的 `recordFailure` 拦不住：它要**连续失败**达到阈值才冷却，
   * 而这 5 个模型**各失败 1 次**就换下一个 —— 谁都没到阈值 →
   * **永远不冷却**，每轮都把那 4 次调用浪费在同一家死掉的供应商上。
   *
   * ## 判据
   *
   * "credits exhausted" 说的是**那家供应商的账**，不是某个模型坏了 ——
   * 所以同前缀的模型应当**一起**进入冷却。
   */
  const registry = new ModelHealthRegistry();
  /* 先让这几个模型被登记（`pickAvailable` 会创建条目）。 */
  const ladder = ['workbuddy-ai/a', 'workbuddy-ai/b', 'workbuddy-ai/c', 'other-ai/d'];

  /* 一家额度耗尽。 */
  const affected = registry.recordProviderFailure('workbuddy-ai/a', 'Credits exhausted', ladder);

  assert.ok(affected >= 3, `★ 应当熔断该供应商的至少 3 个模型（实际 ${affected}）`);

  /* 同供应商的都被熔断。 */
  for (const id of ['workbuddy-ai/a', 'workbuddy-ai/b', 'workbuddy-ai/c']) {
    assert.equal(registry.isAvailable(id), false, `★ ${id} 应当已被熔断`);
  }
  /* 别家不受影响 —— 否则一次额度耗尽会把整个路由掐死。 */
  assert.equal(registry.isAvailable('other-ai/d'), true, '★ 别家供应商不该被牵连');
});
test('★★★ 供应商熔断的冷却必须【长于一轮】——否则每轮都重撞同一家死掉的供应商', () => {
  /*
   * ## 实测（2026-10-12）
   *
   * 复验日志：
   * ```
   *   第 1 轮：technical / sentiment / newscaster 失败（workbuddy-ai/deepseek-v4.1-flash-sg）
   *   第 2 轮：technical / sentiment / newscaster 失败（workbuddy-ai/primary-model）
   *   第 3 轮：全部成功 ✅
   * ```
   *
   * **为什么熔断没拦住第 2 轮**：模型级冷却是 **5 分钟**，
   * 而团队模式**一轮要 7 分钟** —— 冷却**在下一轮开始之前就到期了**。
   *
   * 代价：每轮浪费 4 次调用 + 整轮决策失败。
   *
   * 判据：**额度耗尽不是抖动** —— 5 分钟不会让账上多出钱。
   */
  let t = 1_000_000;
  const registry = new ModelHealthRegistry(2, 5 * 60_000, () => t);
  const ladder = ['dead-ai/a', 'dead-ai/b', 'dead-ai/c'];

  registry.recordProviderFailure('dead-ai/a', 'Credits exhausted', ladder);
  assert.equal(registry.isAvailable('dead-ai/b'), false, '熔断立即生效');

  /* 一轮团队决策要 7 分钟 —— 7 分钟后**仍然必须**是冷却状态。 */
  t += 7 * 60_000;
  assert.equal(
    registry.isAvailable('dead-ai/b'),
    false,
    '★ 7 分钟后（一轮的长度）仍应处于熔断 —— 否则每轮都会重撞',
  );

  /* 但也**不能永久**熔断：30 分钟之后应当恢复试探。 */
  t += 30 * 60_000;
  assert.equal(registry.isAvailable('dead-ai/b'), true, '冷却终究会到期（不该永久踢出）');
});