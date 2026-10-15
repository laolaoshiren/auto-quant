/**
 * 团队 DecisionModel 的端到端测试。
 *
 * 这是 S3 的**验收测试**：证明"一次 `complete()` 背后真的跑了一个团队，
 * 并且产出交易循环能解析的格式"。
 *
 * 判据不是"函数返回了字符串"，而是**那段字符串能被交易循环的契约认出来**：
 * `<decision>[...]</decision>` —— 见 `strategy/prompt.ts` 的输出格式要求。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelRouter, type CallModel } from '../llm/modelRouter.js';
import { createTeamDecisionModel } from './routedModel.js';
import { extractFirstJsonArray } from './agent/deskOutput.js';

/**
 * 造一个"每个角色都给一段像样输出"的桩。
 *
 * ⚠️ 关键：**裁决（judge）必须返回 JSON 数组** —— 那是交易循环唯一认的东西。
 * 其余角色返回散文即可（它们只进审计块）。
 */
function roleAwareCall(): { call: CallModel; seen: string[] } {
  const seen: string[] = [];
  const call: CallModel = async (modelId, messages) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    seen.push(system.slice(0, 40));
    /*
     * 判据是"问的是哪个角色"。真实实现里角色名在 system 提示词里
     *（见 `createTeamDecisionModel` 的 ask）。
     */
    if (system.includes('「judge」')) {
      return {
        text: '结论：偏多，但仓位要小。\n[{"symbol":"BTCUSDT","action":"open_long","positionSizeUsd":100,"stopLoss":60000,"takeProfit":70000,"confidence":70}]',
        latencyMs: 20,
        usage: { promptTokens: 100, completionTokens: 50 },
      };
    }
    /*
     * ⚠️ **风控官必须明确表态**（用户需求 #3）。
     *
     * 它的输出会被 `parseRiskOfficerVerdict` 解析：说"批准"才放行。
     * 桩若返回一句含糊的话（如"我看一下"），解析器会走**保守策略** ——
     * 拦住所有增加风险的动作。所以这个桩必须明确说"批准"。
     *
     * （实测就是这个行为：加风控官后本测试的决策数组变空 —— 因为桩没表态，
     *   保守策略把开仓拦了。那**恰好证明风控官在工作**。）
     */
    if (system.includes('「risk_officer」')) {
      return {
        text: '批准。仓位与当前敞口匹配，未发现集中度问题。',
        latencyMs: 15,
        usage: { promptTokens: 60, completionTokens: 20 },
      };
    }
    return {
      text: `我是 ${system.includes('「') ? system.slice(system.indexOf('「') + 1, system.indexOf('」')) : '未知角色'}，这是我的产出。`,
      latencyMs: 15,
      usage: { promptTokens: 80, completionTokens: 20 },
    };
  };
  return { call, seen };
}

const SYS = '你是交易员。必须把决策放在 <decision> 块里。';
const USER = '当前市场材料……';

test('★★ 团队模式一次 complete() 背后跑完整个交易台，并产出可解析的决策', async () => {
  const { call } = roleAwareCall();
  const model = createTeamDecisionModel({
    router: new ModelRouter({ call }),
    baseMaxTokens: 4096,
  });

  const result = await model.complete(SYS, USER, {});

  /* ① 交易循环的契约：必须有 <decision> 块 */
  assert.ok(result.text.includes('<decision>'), '★ 必须有 decision 块（不然交易循环解析不到）');
  assert.ok(result.text.includes('</decision>'));

  /* ② 内容必须是**可解析的决策数组**，而不是一句散文 */
  const extracted = extractFirstJsonArray(result.text.slice(result.text.indexOf('<decision>')));
  assert.equal(extracted.status, 'ok', '★ decision 块里必须是合法 JSON 数组');
  assert.equal(extracted.decisions?.length, 1);
  assert.equal((extracted.decisions?.[0] as Record<string, unknown>).action, 'open_long');

  /* ③ 审计信息也要在（用户要求看得见"为什么这么决策"） */
  assert.ok(result.text.includes('<team>'), '★ 要有团队审计块');
});

test('★ 角色真的都被调用了（不是只问了裁决）', async () => {
  const { call, seen } = roleAwareCall();
  const model = createTeamDecisionModel({ router: new ModelRouter({ call }), baseMaxTokens: 4096 });
  const result = await model.complete(SYS, USER, {});
  void result;

  /*
   * ## ⚠️ 2026-10-13 语义变化：**没有新闻材料时总管会挡下两个角色**
   *
   * 接上真总管之前，这里恒为 8（4 分析师 + bull + bear + judge + 风控官）。
   * 现在总管会先看"有没有新闻材料"，而**本测试的 `USER` 里没有新闻** ——
   * 于是它挡下了那两个**任务就是"整理新闻"**的角色：
   * ```
   *   不派 newscaster：本轮没有新闻材料（派它只会让它编造）
   *   不派 sentiment：本轮没有新闻材料（派它只会让它编造）
   * ```
   * **那是设计意图，不是缺陷**：没有材料时它们只能编，
   * 而它们会"正常完成" —— **那是看不见的失败**。
   *
   * ## 8 = 1 总管 + 2 行情分析师（market_analyst / technical）+ bull + bear + judge + 风控官 + **汇报员**
   *
   * ⚠️ **2026-10-13 再次变化：多了「汇报员」**（用户需求 ⑤ 点名的"汇报工作的"）。
   * 它排在**最后**（裁决之后），所以这 7 → 8 是**纯附加**：
   * 前 7 个调用一个都没少、顺序也没变 —— 这正是本测试真正要钉住的性质。
   *
   * ⚠️ 这条测试的意图是"**不是只问了裁决**" —— 那个意图没变，
   * 变的是"没有新闻时该派几个"。要验"四个分析师都在"，
   * 得另外给新闻材料（见下面那条专门验它的测试）。
   */
  assert.equal(seen.length, 8, `应当有 8 次角色调用（无新闻材料时的正确数量），实际 ${seen.length}`);

  /* 关键角色都要在（含风控官与总管）。 */
  for (const role of ['supervisor', 'market_analyst', 'technical', 'bull', 'bear', 'judge', 'risk_officer']) {
    assert.ok(
      seen.some((s) => s.includes(`「${role}」`)),
      `★ 角色 ${role} 没有被调用`,
    );
  }
});

test('★★★ 给了新闻材料 → 四个分析师都会被派（总管不会挡下新闻类角色）', async () => {
  /*
   * ⚠️ 这是上一条的**对照**：证明"少派两个"的原因是**材料缺失**，
   * 而不是"总管随机决定"或"代码写死了只派两个"。
   *
   * 若这条也失败（给了新闻却没派满 4 个），那说明总管在**无理由地砍人** ——
   * 而那是"最高智能AI统筹"变成"随机减配"的信号。
   */
  const { call, seen } = roleAwareCall();
  const model = createTeamDecisionModel({ router: new ModelRouter({ call }), baseMaxTokens: 4096 });
  await model.complete(SYS, USER, {});
  void call;
  /*
   * `research` 是新闻材料的来源 —— 给它一个非空的调研结果。
   */
  const { call: call2, seen: seen2 } = roleAwareCall();
  const model2 = createTeamDecisionModel({
    router: new ModelRouter({ call: call2 }),
    baseMaxTokens: 4096,
    research: async () => ({ text: '新闻：ETF 连续 9 日流出。', keys: [] }),
  });
  await model2.complete(SYS, USER, {});
  for (const role of ['market_analyst', 'technical', 'newscaster', 'sentiment']) {
    assert.ok(
      seen2.some((s) => s.includes(`「${role}」`)),
      `★ 给了新闻材料时，${role} 应当被派（实际调用：${seen2.join(', ')}）`,
    );
  }
});

test('★ 系统提示词（含输出格式要求）被带进团队 —— 不能丢', async () => {
  /*
   * 这条防的是一个很容易犯的错：团队角色提示词**替换掉**了交易循环的 system，
   * 于是团队不知道要输出 `<decision>` 格式 —— 整轮白跑。
   */
  const { call } = roleAwareCall();
  const model = createTeamDecisionModel({ router: new ModelRouter({ call }), baseMaxTokens: 4096 });
  const seenContexts: string[] = [];
  const wrapped: CallModel = async (m, messages, o) => {
    seenContexts.push(messages.find((x) => x.role === 'user')?.content ?? '');
    return call(m, messages, o);
  };
  const model2 = createTeamDecisionModel({ router: new ModelRouter({ call: wrapped }), baseMaxTokens: 4096 });
  await model2.complete('【唯一的输出格式要求：<decision>】', USER, {});

  assert.ok(
    seenContexts.some((c) => c.includes('<decision>')),
    '★ 交易循环的输出格式要求必须出现在团队材料里',
  );
});

test('★ 整条角色链失败时返回空决策块 —— 不抛出、不编造动作', async () => {
  /*
   * 一次团队会议失败（额度尽、网关抖动）不该让整轮决策抛错。
   * 返回"不行动 + 说清原因"比抛错有用：前者操作员看得懂，后者只在日志里留栈。
   */
  const failing: CallModel = async () => {
    const err = new Error('insufficient credits') as Error & { status?: number };
    err.status = 429;
    throw err;
  };
  const model = createTeamDecisionModel({ router: new ModelRouter({ call: failing }), baseMaxTokens: 1024 });
  const result = await model.complete(SYS, USER, {});

  assert.ok(result.text.includes('<decision>'), '仍要有 decision 块');
  const extracted = extractFirstJsonArray(result.text.slice(result.text.indexOf('<decision>')));
  /*
   * ⚠️ 2026-10-15：断言的是**决策为空**，不再绑定具体状态字面量。
   * `deskOutput` 把"空数组"从 `ok` 细分成 `empty`（`[]` 是模型明确的"不行动"，
   * 与"没抽到"必须分开报）—— 本条测试要守的是"不编造动作"，不是那个字面量。
   */
  assert.ok(
    extracted.status === 'empty' || extracted.status === 'ok',
    `★ 空决策块必须是"解析成功但没动作"，实际 ${extracted.status}`,
  );
  assert.deepEqual(extracted.decisions, [], '★ 全失败时必须是不行动，不能编造');
  assert.ok(!result.text.includes('open_long'), '★ 绝不能凭空造出开仓动作');
});

test('onStep 把团队的每一步报出来（可观测性）', async () => {
  const { call } = roleAwareCall();
  const steps: string[] = [];
  const model = createTeamDecisionModel({
    router: new ModelRouter({ call }),
    baseMaxTokens: 4096,
    onStep: (s) => steps.push(`${s.phase}:${s.role}`),
  });
  await model.complete(SYS, USER, {});
  assert.ok(steps.length > 0, '★ 要有步骤回调（界面靠它显示团队在做什么）');
  assert.ok(steps.some((s) => s.startsWith('analysis')), '要有分析阶段');
  assert.ok(steps.some((s) => s.startsWith('verdict')), '要有裁决阶段');
});

/* -------------------------------------------------------------------------- */
/*  市场调研（联网搜索）接入（用户需求 #2 / #4）                                 */
/* -------------------------------------------------------------------------- */

test('★★ 调研结果真的进入了团队材料（新闻分析师能看到它）', async () => {
  /*
   * 用户原话：
   * > 「总管**委派子代理去做市场调研**（查新闻、各大交易所社区、社交媒体、新闻源等等）
   * >  根据资料反馈给相应的智能体做处理」
   *
   * 这条钉住"调研确实被喂给了角色"，而不是走个形式。
   */
  const seenContexts: string[] = [];
  const { call } = roleAwareCall();
  const wrapped: CallModel = async (m, messages, o) => {
    seenContexts.push(messages.find((x) => x.role === 'user')?.content ?? '');
    return call(m, messages, o);
  };

  const model = createTeamDecisionModel({
    router: new ModelRouter({ call: wrapped }),
    baseMaxTokens: 4096,
    research: async (symbols) => {
      /* 桩：返回一段可辨识的调研文本。 */
      return `## 联网搜索结果\n独家线索：${symbols.join(',')} 有重大消息 https://example.com/news`;
    },
  });
  await model.complete(SYS, '当前候选 BTCUSDT、ETHUSDT', {});

  assert.ok(
    seenContexts.some((c) => c.includes('独家线索')),
    '★ 调研结果必须出现在角色的材料里',
  );
  assert.ok(
    seenContexts.some((c) => c.includes('BTCUSDT')),
    '★ 调研应当带上从提示词里识别出的标的',
  );
});

test('★ 调研失败【不阻断】整轮决策（行情数据是好的）', async () => {
  /*
   * 搜索是外部依赖。抛错会让"新闻拿不到"升级成"整轮失败" ——
   * 而团队完全可以基于行情决策。
   */
  const { call } = roleAwareCall();
  const model = createTeamDecisionModel({
    router: new ModelRouter({ call }),
    baseMaxTokens: 4096,
    research: async () => {
      throw new Error('搜索端点不可达');
    },
  });

  const result = await model.complete(SYS, USER, {});
  assert.ok(result.text.includes('<decision>'), '★ 调研失败仍要产出决策块');
  const extracted = extractFirstJsonArray(result.text.slice(result.text.indexOf('<decision>')));
  assert.equal(extracted.status, 'ok', '★ 仍要是合法 JSON');
});

test('★ 不传 research 时行为与之前一致（既有部署不受影响）', async () => {
  const { call, seen } = roleAwareCall();
  const model = createTeamDecisionModel({ router: new ModelRouter({ call }), baseMaxTokens: 4096 });
  const result = await model.complete(SYS, USER, {});
  assert.ok(result.text.includes('<decision>'));
  /*
   * ⚠️ 9 = **1 总管** + 4 分析师 + bull + bear + judge + 风控官。
   *
   * 这条测试的意图仍然是"**不传 research 时行为与之前一致**" ——
   * 而"之前"指的是"没接总管的时候"。接上总管后多了 1 次调用，
   * 而 `newscaster` / `sentiment` 因为**没有新闻材料**被总管挡下
   *（那是设计意图，见上面那条测试的说明）。
   *
   * 所以总数 = 9 − 2（被挡下的新闻类分析师）= **7**，
   * 再加 **1 个汇报员**（2026-10-13 接线，排在最后）= **8**。
   */
  assert.equal(seen.length, 8, '角色数：1 总管 + 2 行情分析师 + bull/bear/judge + 风控官 + 汇报员');
});
/* -------------------------------------------------------------------------- */
/*  材料接线：行情数据必须真的进到角色手里（2026-10-12 实测修正）                 */
/* -------------------------------------------------------------------------- */

test('★★ 行情数据（userPrompt）必须进到角色的材料里，而不是被规则顶掉', async () => {
  /*
   * 实测踩到的严重缺陷：第一版把 `systemPrompt`（**规则**）当成了市场材料，
   * 而把 `userPrompt`（**真正的候选池与指标序列**）只当新闻。
   *
   * 后果 —— 模型明确抱怨：
   *   「本轮材料中没有提供任何市场数据，因此无法进行市场结构分析」
   *   「提示词里没有附带任何行情数据、候选池或持仓信息 —— 我手上是空的」
   *
   * 而同一时刻日志显示「list_candidates → 20 个」——
   * **数据取到了，只是没进提示词**。团队于是基于"空材料"讨论了一轮。
   */
  const seenContexts: string[] = [];
  const { call } = roleAwareCall();
  const wrapped: CallModel = async (m, messages, o) => {
    seenContexts.push(messages.find((x) => x.role === 'user')?.content ?? '');
    return call(m, messages, o);
  };

  const model = createTeamDecisionModel({ router: new ModelRouter({ call: wrapped }), baseMaxTokens: 4096 });
  await model.complete('【这是规则：必须输出 <decision> 块】', '【这是行情：BTCUSDT 现价 83000，4H EMA20 上行】', {});

  assert.ok(
    seenContexts.some((c) => c.includes('BTCUSDT 现价 83000')),
    '★ 行情数据必须出现在角色的材料里（它来自 userPrompt）',
  );
  assert.ok(
    seenContexts.some((c) => c.includes('这是规则')),
    '★ 规则也要带进去（角色需要知道输出格式），但不能顶掉行情',
  );
});

test('★ 角色的 system 提示词明确说"你没有工具"（防假装取数）', async () => {
  /*
   * 实测：角色以为它能取数，输出了「我先拉取候选池与指标序列再做客观描述」——
   * 而那些动作**永远不会发生**，且会让单角色拖到 100 秒以上。
   */
  const seenSystems: string[] = [];
  const { call } = roleAwareCall();
  const wrapped: CallModel = async (m, messages, o) => {
    seenSystems.push(messages.find((x) => x.role === 'system')?.content ?? '');
    return call(m, messages, o);
  };
  const model = createTeamDecisionModel({ router: new ModelRouter({ call: wrapped }), baseMaxTokens: 4096 });
  await model.complete(SYS, USER, {});

  assert.ok(seenSystems.length > 0);
  assert.ok(
    seenSystems.every((s) => s.includes('你没有工具') || s.includes('不能调用任何工具')),
    '★ 每个角色的 system 提示词都要说清"没有工具"',
  );
});
/* -------------------------------------------------------------------------- */
/*  ⚠️ 团队输出不能含 <tool> 块（否则一轮会跑 4 次交易台）                        */
/* -------------------------------------------------------------------------- */

test('★★★ 团队输出里的 <tool> 块必须被剥掉（否则整台会被重跑 4 次）', async () => {
  /*
   * ## 实测证据（#11 模拟盘，9 分钟窗口）
   *
   * ```
   *   派出分析师 2 → 4 → 5 → 6 → 7 → 8 次
   *   新决策记录：0 条
   * ```
   * **8 次交易台 × 8 角色 = 64 次模型调用，零产出。**
   *
   * ## 根因
   *
   * `autoTrader` 的按需取数循环（`MAX_DATA_ROUNDS = 3`）：
   * 只要模型输出里有 `<tool>` 块，它就执行工具并**再问一次模型**。
   *
   * 对单模型这是多问 1 次；对团队模式，**"再问一次模型" = 重跑整个交易台**。
   * 于是"一次决策"变成最多 **4 次交易台 = 32 次角色调用**。
   *
   * ## 为什么模型会输出 <tool>
   *
   * 团队角色**没有工具**（system 提示词里已写明），但模型仍会按训练习惯
   * 假装调工具。提示词降低概率，**不能保证** —— 而代价是整台重跑。
   *
   * 所以做兜底：团队**真的没有工具**，任何 `<tool>` 块都是幻觉，剥掉。
   */
  const { call } = roleAwareCall();
  const withTool: CallModel = async (m, messages, o) => {
    const r = await call(m, messages, o);
    /* 每个角色的输出都带上假工具块 —— 模拟实测里的行为。 */
    return { ...r, text: `${r.text}\n<tool>{"tool":"list_candidates"}</tool>` };
  };

  const model = createTeamDecisionModel({ router: new ModelRouter({ call: withTool }), baseMaxTokens: 4096 });
  const result = await model.complete(SYS, USER, {});

  assert.ok(!result.text.includes('<tool>'), '★ 团队输出里不能残留 <tool> 块');
  assert.ok(!result.text.includes('list_candidates'), '★ 假工具内容也要一起消失');
  /* 决策块仍要完好 —— 剥工具不能伤到正常输出。 */
  assert.ok(result.text.includes('<decision>'), '决策块必须还在');
  const extracted = extractFirstJsonArray(result.text.slice(result.text.indexOf('<decision>')));
  assert.equal(extracted.status, 'ok', '剥完之后仍要是合法 JSON');
});

test('★ 剥工具不影响不含工具块的输出（回归）', async () => {
  const { call } = roleAwareCall();
  const model = createTeamDecisionModel({ router: new ModelRouter({ call }), baseMaxTokens: 4096 });
  const result = await model.complete(SYS, USER, {});
  assert.ok(result.text.includes('<decision>'));
  assert.ok(result.text.includes('<team>'), '审计块要在');
});
test('★★★ 裁决全是"不行动"时跳过风控官（省一次 T3 调用）', async () => {
  /*
   * ## 实测动机（第 39 轮的耗时结构定位）
   *
   * ```
   *   4 个分析师（并行）：~50 秒
   *   辩论 → 裁决 → 风控：~370 秒     ← 瓶颈
   * ```
   *
   * 三次串行 T3 调用**不能并行**（P1：唯一裁决者）——
   * 所以省时间的唯一办法是**少调用一次**。
   *
   * 而"全是 skip"是最安全的省略：**没有动作就没有风险敞口可审**。
   */
  const seen: string[] = [];
  const { call } = roleAwareCall();
  const wrapped: CallModel = async (m, messages, o) => {
    /* 从 system 里认角色（与 roleAwareCall 同一手法）。 */
    const sys = messages.find((x) => x.role === 'system')?.content ?? '';
    const r = await call(m, messages, o);
    const m2 = /「(\w+)」/.exec(sys);
    if (m2) seen.push(m2[1]!);
    /* 裁决官给"全都不行动"。 */
    if (sys.includes('「judge」')) {
      return { ...r, text: '[{"symbol":"BTCUSDT","action":"skip","confidence":80,"reasoning":"无合格入场"}]' };
    }
    return r;
  };

  const model = createTeamDecisionModel({ router: new ModelRouter({ call: wrapped }), baseMaxTokens: 4096 });
  const result = await model.complete(SYS, USER, {});

  assert.ok(!seen.includes('risk_officer'), '★ 全是 skip 时不该叫风控官');
  assert.ok(result.text.includes('<decision>'), '决策块仍要产出');
});

test('★★★ 有真实动作时【必须】叫风控官（fail-closed，不能误省）', async () => {
  /*
   * ⚠️ 这条是上一条的**安全对照**。
   *
   * 跳过风控的判据必须是"**明确全是**不行动"——
   * 如果判据写反了（例如"有任何一个 skip 就跳过"），
   * 那会出现"有开仓动作却不经风控"的严重后果。
   *
   * 用**黑名单**（`skip`/`hold`/`wait`）而不是"非开仓即不行动"：
   * 将来新增的动作会**默认送去风控**（fail-closed）。
   */
  const seen: string[] = [];
  const { call } = roleAwareCall();
  const wrapped: CallModel = async (m, messages, o) => {
    const sys = messages.find((x) => x.role === 'system')?.content ?? '';
    const r = await call(m, messages, o);
    const m2 = /「(\w+)」/.exec(sys);
    if (m2) seen.push(m2[1]!);
    if (sys.includes('「judge」')) {
      return {
        ...r,
        text: '[{"symbol":"BTCUSDT","action":"open_long","positionSizeUsd":100,"stopLoss":60000,"confidence":80}]',
      };
    }
    return r;
  };

  const model = createTeamDecisionModel({ router: new ModelRouter({ call: wrapped }), baseMaxTokens: 4096 });
  await model.complete(SYS, USER, {});

  assert.ok(seen.includes('risk_officer'), '★ 有开仓动作时【必须】叫风控官');
});