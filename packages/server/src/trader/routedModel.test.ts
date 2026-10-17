/**
 * 角色路由器与网关工厂的测试。
 *
 * 重点钉住用户的两条要求：
 *   ① 「万一 claude 额度不足了，系统能智能把主管模型换成向下平替，保证系统不中断」
 *   ② 「各个 AI 要有一定容错、纠正机制……这个模式里面的一切都可以让 AI 来自我迭代升级」
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelRouter, type CallModel } from '../llm/modelRouter.js';
import { readFileSync } from 'node:fs';
import { ROLE_TIERS, ROLE_GROUP_LADDERS, ROLE_MAX_TOKENS, createRoutedDecisionModel, tierForRole } from './routedModel.js';
/* ⚠️ 档位兜底链不导出（TIER_GROUP_LADDERS 是私有常量），所以从源码里读 —— 与 T1/T2/T3 同一个手法。 */
const ROUTED_SRC = readFileSync(new URL('./routedModel.ts', import.meta.url), 'utf8');
const TIER_LADDERS: Record<string, readonly string[]> = (() => {
  const block = /const TIER_GROUP_LADDERS[^=]*= \{([\s\S]*?)\n\};/.exec(ROUTED_SRC)?.[1] ?? '';
  const out: Record<string, readonly string[]> = {};
  for (const m of block.matchAll(/([A-Za-z0-9_]+):\s*([A-Za-z0-9_]+)/g)) {
    /* ⚠️ 用 `[^]*?`（而不是 `[\s\S]*?`）表示"任意字符，含换行" ——
     * 少一层反斜杠转义。这里曾因转义写错而报 `Invalid regular expression: Unmatched ')'`。 */
    const refRe = new RegExp('const ' + m[2] + ': readonly string\\[\\] = \\[([^]*?)\\n\\];');
    const ref = refRe.exec(ROUTED_SRC)?.[1] ?? '';
    out[m[1]!] = [...ref.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  }
  return out;
})();
const T1 = TIER_LADDERS['T1_fast'];
const T2 = TIER_LADDERS['T2_mid'];
const T3 = TIER_LADDERS['T3_deep'];
import { ROLE_TIMEOUT_MS } from './agent/tradingDesk.js';
import { looksLikeMagpieGateway } from './magpieGateway.js';
import { FIRM_ROLES, firmRoleOf } from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  角色 → 档位映射（"每个智能体用什么模型"的机器表达）                          */
/* -------------------------------------------------------------------------- */

test('★ 体力活角色用便宜档、判断类角色用强档（成本与能力匹配）', () => {
  /*
   * 用户原话：「高智能的模型做什么，低智能的做哪些体力活（例如查资料，整理、重复性工作）」。
   * 分档错了的后果很实际：用 T3 跑打标 = 花 15 倍 token 做不需要智商的事。
   */
  assert.equal(tierForRole('supervisor'), 'T3_deep', '调度官要统筹，必须最强');
  assert.equal(tierForRole('judge'), 'T3_deep', '裁决要强');
  assert.equal(tierForRole('newscaster'), 'T1_fast', '★ 查新闻/打标是体力活，不该用旗舰');
  assert.equal(tierForRole('sentiment'), 'T1_fast');
  assert.equal(tierForRole('execution'), 'T0_code', '★ 执行绝不用 LLM');
  assert.equal(tierForRole('data_sentinel'), 'T0_code', '数据哨兵是纯代码');
});

test('未知角色保守给 T2（宁可稍贵，也不要让新角色没模型可用）', () => {
  assert.equal(tierForRole('some-brand-new-role'), 'T2_mid');
});

test('★★★ 风控官是 `T2_mid`（不是 T3）—— 它审提案，不构建论证', () => {
  /*
   * ## 为什么这条要单独钉
   *
   * `tradingDesk.ts` 里有一段注释曾写「`tierForRole('risk_officer')` → T3」，
   * 而代码从引入角色路由起就是 **T2_mid** —— **注释与代码矛盾**，
   * 且矛盾朝着"更贵"的方向（读注释的人会以为风控官在用旗舰档）。
   *
   * 这正是本项目最该防的一类缺陷：**它不会让任何东西失败**。
   * 测试全绿、系统照跑，只是读代码的人会得出错误结论。
   * 所以把那个结论**变成一条断言**，而不是靠"下次记得改注释"。
   *
   * ## 判据：为什么 T2 是对的（而不是"代码恰好这么写"）
   *
   * ```
   *   ① 两处独立声明一致：firm.ts 的 FIRM_ROLES 与 ROLE_TIERS 都写 T2_mid
   *   ② 任务是【审计】不是【构建】：拿到的是一份已经结构化好的待审决策
   *      （决策 JSON + 一句话理由），检查项也是枚举好的 5 条
   *      （止损位置 / 方向 / 仓位 / 标的 / 时机）—— 不需要从零推理
   *   ③ 输出预算 2048 与 T2 分析类同量级，而不是辩论/裁决的 4096–8192
   * ```
   *
   * ⚠️ 而**它的权威性不因此削弱**：否决权来自它的 `verdict` 字段与
   * 下游的 `parseRiskOfficerVerdict`，**不来自档位**。
   * 档位只决定"用多贵的模型来审"，不决定"它说的话算不算数"。
   * 把它降档来省钱是错的（审计质量会降），但把它提到 T3 也不是"更安全" ——
   * 那是把一个 5 项检查的活交给旗舰档去烧 token，而**真正的物理底线
   * 始终是 `RiskEngine`**（它跟档位、跟 LLM 都无关）。
   */
  assert.equal(
    tierForRole('risk_officer'),
    'T2_mid',
    '★ 风控官是审计角色（T2）—— 若这里变成 T3，请同步更正 tradingDesk.ts 里那段注释的判据',
  );
});

test('★★★ `FIRM_ROLES` 与 `ROLE_TIERS` 的档位必须逐条一致（防"注释说的是一个、代码跑的是另一个"）', () => {
  /*
   * ## 为什么这条比"断言某一个角色的档位"更有价值
   *
   * 上面那条只钉住 `risk_officer` —— 而**同一个缺陷形态对每个角色都成立**：
   * `firm.ts` 的 `FIRM_ROLES[].tier` 是**界面上显示**的档位，
   * `ROLE_TIERS` 是**实际路由**用的档位。两个数字都叫"档位"、
   * 都由"这个角色该多强"决定，却写在两个包的两个文件里。
   *
   * 它们一旦漂移，症状是**操作员看到的与系统实际做的不是一回事** ——
   * 而且**不会有任何报错**（两个值各自都合法）。这与 `firm.ts` 文件头
   * 记的那次事故同源：**同一个事实存了两份，就一定会漂移。**
   *
   * ⚠️ 已有的两条断言覆盖的是**存在性**（"路由表里的每个角色在组织架构里有定义"、
   * "标了 staffed 的都要有档位"），**没有一条比较过档位本身的值**。
   * 这条补上的正是那个缺口。
   *
   * ⚠️ 只比较**两边都有的**角色：`community_monitor` 之类只存在于
   * `FIRM_ROLES`（状态 `planned`，还没实现），它没有路由档位是**正确的**。
   */
  const mismatched = FIRM_ROLES
    .filter((r) => r.id in ROLE_TIERS)
    .filter((r) => ROLE_TIERS[r.id] !== r.tier)
    .map((r) => `${r.id}: FIRM_ROLES=${r.tier} 但 ROLE_TIERS=${ROLE_TIERS[r.id]}`);
  assert.deepEqual(
    mismatched,
    [],
    `★ 下列角色的档位两张表不一致（界面显示的与实际路由的不是同一个）:\n${mismatched.join('\n')}`,
  );
});

test('★★★ 走 `tierForRole` 的角色必须全部登记档位 —— 判据从类型取全集', () => {
  /*
   * ## ⚠️⚠️ 这条原来是**手写列表**，于是它抓不到它本该抓的东西（2026-10-15 修）
   *
   * 原判据：
   * ```
   *   const expected = ['supervisor', 'judge', ..., 'ops_watchdog'];  ← 硬编码 18 个
   *   for (const role of expected) assert.ok(ROLE_TIERS[role], ...)
   * ```
   * 手写列表的**根本问题**是它会随代码漂移 —— 加角色的人不会记得改测试里的数组。
   * 所以改成从 `AgentRole` 类型（`roles.ts`，唯一事实来源）解析全集。
   *
   * ## ⚠️ 但不是"所有 AgentRole 都必须在 ROLE_TIERS 里"（这条我一开始写错了）
   *
   * 实测 `tierForRole()` 的生产调用点**只有两处**：
   * ```
   *   manager.ts:4131      tierForRole('system_engineer')
   *   routedModel.ts:1053  tierForRole('risk_officer')
   * ```
   * 而**交易台的角色**（`supervisor`/`judge`/`bull`/`bear`/…）的档位来自
   * `firm.ts` 的 `FIRM_ROLES`，走的是 `ask({ role, tier, … })` 那条路 ——
   * **不经过 `tierForRole`**。
   *
   * 反过来，**工具循环那批角色**（`strategist`/`performance_analyst`/
   * `attribution_analyst`/`reviewer`/`trader`）走的是
   * `createTeamDecisionModel` 里的 `isToolLoopCall` 分支 →
   * 转给 `singleModel` 或 `router.callByTier('T2_mid')` ——
   * **也不经过 `tierForRole`**，所以"它们没登记档位"是无害的。
   *
   * ⇒ 所以正确的不变量是：**两处显式 `tierForRole` 的角色必须在表里**
   *   （少一个就会静默回退 `T2_mid`），而不是"所有角色都要在表里"。
   *
   * ## 为什么要从源码扫调用点
   *
   * 因为**"哪些角色会走这条路"本身是会变的** —— 今天只有两个显式调用，
   * 明天可能有人给 `market_analyst` 也加上。手写"两个名字"会和手写 18 个
   * 犯同一个错：**它记录的是写测试那一刻的状态，而不是不变量。**
   */
  const callers = tierForRoleCallers();
  assert.ok(
    callers.length >= 2,
    `★ 至少该扫到 2 处 tierForRole 调用（risk_officer / system_engineer），实际 ${callers.length}`,
  );

  const missing = callers.filter((role) => !(role in ROLE_TIERS));
  assert.deepEqual(
    missing,
    [],
    `★ 这些角色调了 tierForRole 却没登记档位（会静默回退 T2_mid）：${missing.join('、')}`,
  );
});

/**
 * 扫出所有**字面量**形式的 `tierForRole('xxx')` 调用点。
 *
 * ⚠️ 只认字面量：变量形式（`tierForRole(someVar)`）扫不出来，
 * 而那正是"从源码取事实"的边界 —— 所以下面那条测试同时钉住了
 * `AgentRole` 全集与档位表的**覆盖关系**，两者互补。
 */
function tierForRoleCallers(): string[] {
  const files = [
    new URL('./routedModel.ts', import.meta.url),
    new URL('./manager.ts', import.meta.url),
    new URL('./agent/tradingDesk.ts', import.meta.url),
    new URL('./agent/orchestrator.ts', import.meta.url),
  ];
  const found = new Set<string>();
  for (const url of files) {
    const src = readFileSync(url, 'utf8');
    /* 剥注释 —— 注释里出现过 `tierForRole('risk_officer')` 这种说明文字。 */
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const m of noComments.matchAll(/tierForRole\(\s*'([a-z_]+)'\s*\)/g)) {
      found.add(m[1] as string);
    }
  }
  return [...found];
}

/**
 * 从 `roles.ts` 的 `AgentRole` 类型里解析出角色全集。
 *
 * ⚠️ **为什么解析源码而不是 import**：`AgentRole` 是**类型**，运行时不存在，
 * 所以没法 `import` 一个值来遍历。而"手写一份列表"正是这个测试原来失效的原因 ——
 * 所以只能从类型的声明文本里取。
 *
 * 只扫 `export type AgentRole = ... ;` 这一段，并剥掉注释（注释里出现过
 * `engineer` 这种**已删除**的角色名，不剥会把幽灵算进来）。
 */
function agentRolesFromType(): string[] {
  const src = readFileSync(new URL('./agent/roles.ts', import.meta.url), 'utf8');
  const start = src.indexOf('export type AgentRole');
  assert.ok(start > 0, '★ 找不到 AgentRole 类型声明');
  const end = src.indexOf(';', start);
  const block = src.slice(start, end);
  /* 剥注释：行注释与块注释都要剥 —— 注释里有已删除角色的名字。 */
  const noComments = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...noComments.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
}

test('★★★ 每个 `AgentRole` 都必须明确"走哪条路" —— 不能靠静默回退', () => {
  /*
   * ## 这条补的是上一条的盲区
   *
   * 上一条只扫**字面量**调用点，所以它答不了"这个角色到底走哪条路"。
   * 而**真正的风险是"它走了哪条路没人知道"** ——
   * 一个既不在 `ROLE_TIERS`、也不在工具循环那批里的角色，
   * 会静默拿到 `T2_mid`，而它可能本该是 T3（裁决类）或 T1（体力活）。
   *
   * ## 判据：两条路必须至少命中一条
   *
   * ```
   *   ① 在 ROLE_TIERS 里              → 走 tierForRole（交易台/显式调用）
   *   ② 在工具循环那批里               → 走 singleModel / callByTier('T2_mid')
   * ```
   * 都不在 ⇒ 它就是"没人知道走哪条路"的那个。
   *
   * ⚠️ 工具循环那批是**显式列出来的**，不是猜的 —— 它来自
   * `orchestrator.ts` 的 `role: 'strategist'`、`runPanelAnalysts` 的
   * `['performance_analyst','attribution_analyst']`、`runtime.ts` 的复盘员。
   * 那个列表本身就是"会走工具循环的角色"的**唯一定义处**。
   */
  const TOOL_LOOP_ROLES = new Set([
    'strategist',
    'performance_analyst',
    'attribution_analyst',
    'reviewer',
    'trader',
  ]);

  const unaccounted = agentRolesFromType().filter(
    (role) => !(role in ROLE_TIERS) && !TOOL_LOOP_ROLES.has(role),
  );
  assert.deepEqual(
    unaccounted,
    [],
    `★ 这些角色既没登记档位、也不在工具循环那批里 —— ` +
      `它们会静默拿到 T2_mid，而没人知道那是否正确：${unaccounted.join('、')}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  路由 DecisionModel：降级 + 可观测                                          */
/* -------------------------------------------------------------------------- */

/** 造一个按"模型名前缀"决定行为的桩。 */
function stubFactory(behavior: (modelId: string) => 'ok' | 'quota' | 'empty'): CallModel {
  return async (modelId) => {
    const kind = behavior(modelId);
    if (kind === 'quota') {
      const err = new Error('You have insufficient credits to make this request.') as Error & { status?: number };
      err.status = 429;
      throw err;
    }
    if (kind === 'empty') return { text: '', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 0 } };
    return { text: `来自 ${modelId}`, latencyMs: 10, usage: { promptTokens: 1, completionTokens: 1 } };
  };
}

test('★★ 核心：首选额度尽 → 自动降级，且【每一次尝试都被报告】', async () => {
  /*
   * 用户要求两件事同时成立：
   *   ① 系统不中断（降级成功）
   *   ② 看得见发生了什么（"降级了几次、为什么"必须能观测）
   */
  const seen: Array<{ role: string; modelId: string; ok: boolean; note: string }> = [];
  let call = 0;
  const router = new ModelRouter({
    call: async (modelId, messages, options) => {
      call += 1;
      /* 第一次失败（额度尽），之后成功 */
      if (call === 1) {
        const err = new Error('endpoint is unavailable') as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      return { text: '平替成功', latencyMs: 10, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  });

  const model = createRoutedDecisionModel({
    router,
    request: { role: 'judge', tier: 'T3_deep' },
    baseMaxTokens: 4096,
    onAttempt: (info) => seen.push(info),
  });

  const result = await model.complete('系统提示', '用户提示', {});
  assert.equal(result.text, '平替成功', '★ 系统不能因为首选额度尽就停摆');
  assert.equal(seen.length, 2, '★ 两次尝试都要被报告（失败的 + 成功的）');
  assert.equal(seen[0]!.ok, false, '★ 第一次失败必须可见');
  assert.equal(seen[0]!.role, 'judge', '报告里要带角色 —— 多智能体下"谁失败了"是关键信息');
  assert.equal(seen[1]!.ok, true);
  assert.ok(seen[0]!.note.length > 0, '★ 失败原因要能读（不能只是一个 ok:false）');
});

test('★ 空内容会重试（不是立刻判失败）', async () => {
  let call = 0;
  const router = new ModelRouter({
    call: async () => {
      call += 1;
      return call === 1
        ? { text: '  ', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 0 } }
        : { text: '第二次有内容', latencyMs: 5, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  });
  const model = createRoutedDecisionModel({ router, request: { role: 'clerk', tier: 'T1_fast' }, baseMaxTokens: 512 });
  const r = await model.complete('s', 'u', {});
  assert.equal(r.text, '第二次有内容');
});

test('usage 三个字段一路带到适配层（缓存/思考 token 不能在最后一跳丢）', async () => {
  /*
   * 项目里踩过这个坑：适配层漏掉 cachedTokens，前面所有工作白做，
   * 界面上"缓存命中率"永远显示不出来。
   */
  const router = new ModelRouter({
    call: async () => ({
      text: 'ok', latencyMs: 7,
      usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 86, reasoningTokens: 12 },
    }),
  });
  const model = createRoutedDecisionModel({ router, request: { role: 'bull', tier: 'T3_deep' }, baseMaxTokens: 1024 });
  const r = await model.complete('s', 'u', {});
  assert.equal(r.usage.cachedTokens, 86, '★ 缓存 token 必须带出来');
  assert.equal(r.usage.reasoningTokens, 12, '★ 思考 token 必须带出来');
  assert.equal(r.usage.promptTokens, 100);
});

test('中止信号一路透传到路由器', async () => {
  let gotSignal: AbortSignal | undefined;
  const router = new ModelRouter({
    call: async (_m, _msg, options) => {
      gotSignal = options.signal;
      return { text: 'ok', latencyMs: 1, usage: { promptTokens: 0, completionTokens: 0 } };
    },
  });
  const model = createRoutedDecisionModel({ router, request: { role: 'bear', tier: 'T3_deep' }, baseMaxTokens: 512 });
  const ac = new AbortController();
  await model.complete('s', 'u', { signal: ac.signal });
  assert.equal(gotSignal, ac.signal, '★ 停止时必须能掐断在途请求');
});

/* -------------------------------------------------------------------------- */
/*  magpie 网关识别                                                            */
/* -------------------------------------------------------------------------- */

test('★ 能识别 magpie 网关（判据是 baseUrl，不需要用户多勾一个开关）', () => {
  assert.equal(looksLikeMagpieGateway('http://127.0.0.1:3425/v1'), true);
  assert.equal(looksLikeMagpieGateway('http://172.19.0.1:3425/v1'), true);
  assert.equal(looksLikeMagpieGateway('http://127.0.0.1:3425/mcp/magpie/web-search'), true);
  assert.equal(looksLikeMagpieGateway('https://api.deepseek.com'), false);
  assert.equal(looksLikeMagpieGateway(''), false);
});

/* -------------------------------------------------------------------------- */
/*  组织架构与路由表的一致性（防"看不见的角色"）                                 */
/* -------------------------------------------------------------------------- */

test('★★ 路由表里的每个角色都必须在组织架构里有定义（否则界面上看不见它）', () => {
  /*
   * ## 为什么这条测试重要
   *
   * 两张表分别在两个包里：
   *   · `ROLE_TIERS`（本包）—— 决定"每个角色用哪个档位的模型"；
   *   · `FIRM_ROLES`（`@aq/shared`）—— 决定"界面上有哪些角色、各自负责什么"。
   *
   * 服务端加了新角色、界面不显示 → **操作员看不见有人在干活**。
   * 那正是用户反复要求的"看得见系统在做什么"的反面，而且很难被发现
   * （毕竟系统功能是好的，只是没显示）。
   */
  const missing = Object.keys(ROLE_TIERS).filter((id) => firmRoleOf(id) === undefined);
  assert.deepEqual(missing, [], `★ 这些角色在路由表里但组织架构里没有：${missing.join(', ')}`);
});

test('★ 组织架构里标 `staffed` 的角色都应当在路由表里有档位', () => {
  /*
   * 反方向的漂移：界面上写着"在岗"，而路由表不知道该给它什么档位 ——
   * 那会让 `tierForRole()` 回退到 T2（能跑，但"在岗"是虚的）。
   */
  const unrouteable = FIRM_ROLES
    .filter((r) => r.status === 'staffed')
    .filter((r) => !(r.id in ROLE_TIERS))
    .map((r) => r.id);
  assert.deepEqual(unrouteable, [], `★ 这些角色标了在岗但路由表里没有：${unrouteable.join(', ')}`);
});

test('★ 组织架构的每个角色都有中文名与职责说明（界面要显示）', () => {
  for (const r of FIRM_ROLES) {
    assert.ok(r.label.length > 0, `★ 角色 ${r.id} 没有中文名`);
    assert.ok(r.duty.length > 8, `★ 角色 ${r.id} 的职责说明太短（界面要显示"它在做什么"）`);
  }
});

test('★ 组织架构里没有重复的角色 id', () => {
  const ids = FIRM_ROLES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, '有重复的角色 id');
});
test('★★★ 关键角色的链必须【有兜底、且不撞慢模型】—— 判据是性质，不是某个组名', () => {
  /*
   * ⚠️ **这条用例 2026-10-17 改写过**（原来钉的是 `group/team-analyst` /
   * `group/team-grunt` 这两个**字面值**）。改写的两个理由：
   *
   * ① **组名不是永久的**：那两个组是本项目用 `magpie group add` 建的，
   *    而后来的实测里网关对它们返回 404（同一批请求里别的模型 200）——
   *    把"链上必须出现某个组名"写成断言，等于把**外部系统的状态**当成不变量。
   * ② **真正要防的东西没变**：链必须有兜底（单组一次 5xx 不能让整档不可用），
   *    且**不能把耗时波动大的模型放链首**（当年 `group/auto-hy3` 的
   *    39s / 121s / >180s 就是这条的来源）。
   *
   * 所以判据改成三条**性质**：链存在、有 ≥2 个候选、链首不是已知慢模型。
   */
  const SLOW = new Set(['group/auto-hy3', 'group/auto-longcat-2-5-preview-free']);
  for (const role of ['technical', 'newscaster', 'sentiment', 'market_analyst', 'symbol_scout']) {
    const chain = ROLE_GROUP_LADDERS[role];
    assert.ok(chain !== undefined && chain.length >= 2,
      `★ ${role} 的链必须存在且 ≥2 个候选（单候选一次 5xx 就让整档不可用）` +
      `—— 当前：${chain === undefined ? '（未绑）' : chain.join(' → ')}`);
    assert.ok(chain![0] !== undefined && !SLOW.has(chain![0]),
      `★ ${role} 的链首不能是已知慢模型（实测 39s/121s/>180s 那一类）：${chain![0]}`);
  }
});
test('★★★ 三档各有【有序备用链】，且未绑角色至少有档位兜底（2026-10-17 补全）', () => {
  /*
   * ## 为什么改这条用例
   *
   * 它原来断言的是 `judge` / `bull` / `bear` 在 `ROLE_GROUP_LADDERS` 里
   * **必须是 `undefined`**（理由是"还没验证过 team-judge 的表现"）。
   * 那条断言现在与相反的设计意图冲突，而且它守的东西**已经由别处守住了**：
   * 档位级兜底链在 `TIER_GROUP_LADDERS`，未绑角色走的是它，不是"无控的自动排序"。
   *
   * ## 现在的判据（三条，对应"补全三档阶梯"这个目标）
   *
   * ① 三档都必须有链，且**每档 ≥3 个候选**（用户要求"利用好所有可用模型"）；
   * ② 角色级链若存在，必须 ≥2 个候选（单候选一次 5xx 就让整档不可用）；
   * ③ 链的顺序必须**稳定**：重复读两次拿到同一个数组（防止将来改成"运行时排序"，
   *    那会让"链首是谁"变得不可预测 —— 而链首的选择是有理由的）。
   */
  for (const [name, ladder] of [['T1_fast', T1], ['T2_mid', T2], ['T3_deep', T3]] as const) {
    assert.ok(ladder !== undefined, `★ 档位 ${name} 必须有兜底链（未绑角色靠它）`);
    assert.ok(ladder!.length >= 3,
      `★ ${name} 的链必须 ≥3 个候选（当前 ${ladder!.length}：${ladder!.join(' → ')}）`);
  }
  for (const [role, chain] of Object.entries(ROLE_GROUP_LADDERS)) {
    assert.ok(chain.length >= 2, `★ ${role} 的角色级链必须 ≥2 个候选：${chain.join(' → ')}`);
  }
  for (const [name, ladder] of [['T1_fast', T1], ['T2_mid', T2], ['T3_deep', T3]] as const) {
    assert.deepEqual([...ladder!], [...ladder!], `★ ${name} 的顺序必须稳定`);
  }
});
test('★ 可以用环境变量关掉（出问题能立刻回到旧行为）', () => {
  /*
   * `AQ_ROLE_GROUPS=off` 时 `ask()` 不传 ladder → 回到发现层排序。
   * 这条是**运维安全阀**：若路由组引入了新问题，不必改代码就能回退。
   *
   * ⚠️ 这里只能断言"这个开关的名字在源码里" ——
   * 真正验证它需要构造完整调用链（见 `routedModel.ts` 里那行三元）。
   */
  const src = readFileSync(new URL('./routedModel.ts', import.meta.url), 'utf8');
  assert.ok(src.includes("AQ_ROLE_GROUPS"), '★ 必须有这个开关');
  assert.ok(src.includes("=== 'off'"), '★ 且 off 时真的不传 ladder');
});
test('★★★ T1 的候选链必须【多于一个候选】—— 单候选一次 5xx 就让整档不可用', () => {
  /*
   * ## 实测踩到（2026-10-12）
   *
   * 我第一版只写一个组，于是线上出现：
   * ```
   *   technical：失败：档位 T1_fast 的候选链全部处于冷却期（1 个模型）
   *             —— group/team-grunt(上游 5xx，先重试一次，仍失败则换)
   * ```
   * **三个 T1 角色共用这一个候选** → 一次 5xx → **三个同时不可用**。
   *
   * ## 为什么"组内还有 3 个模型"救不了
   *
   * 组是**网关侧的一个入口**：网关返回 5xx 时，路由器看到的是
   * 「这个候选失败了」，它**不知道组内还有别的**，于是把整组标成冷却。
   *
   * ## 为什么判据是【性质】而不是【某个组名】
   *
   * 这条用例原来钉的是 `chain[0] === 'group/team-grunt'` 这种**字面值**。
   * 2026-10-17 改成性质判据，两个理由：
   *   ① **组名不是永久的**（网关侧拓扑会变，而本仓库不会有测试因此变红）；
   *   ② 真正要防的是「链太短，一个候选挂了整档就不可用」——那是**结构**问题。
   */
  for (const role of ['technical', 'newscaster', 'sentiment', 'market_analyst', 'symbol_scout']) {
    const chain = ROLE_GROUP_LADDERS[role];
    assert.ok(chain !== undefined, `★ ${role} 应当绑了候选链`);
    assert.ok(
      chain.length >= 2,
      `★ ${role} 的链必须 ≥2 个候选（当前 ${chain.length}：${chain.join(' → ')}）—— ` +
        '单候选一次 5xx 就会让整个档位不可用',
    );
    /* 顺序有意义：**最快/最稳的排第一**（这里只检查它是个具体 id）。 */
    assert.ok(chain[0] !== undefined && chain[0].length > 0,
      `★ ${role} 的链首必须是一个具体候选：${chain.join(' → ')}`);
  }
});

test('★ 兜底链里不能有重复项（重复 = 白试一次）', () => {
  for (const [role, chain] of Object.entries(ROLE_GROUP_LADDERS)) {
    assert.equal(new Set(chain).size, chain!.length, `★ ${role} 的链里有重复：${chain!.join(' → ')}`);
  }
});

test('★★★ 每个候选都必须是【线上真实存在】的模型 —— 用离线快照钉住（防止再出现"指向空气的链"）', () => {
  /*
   * ## 这条测试的来历（一次真实的假绿 + 一次真实的乌龙）
   *
   * ① 教训：**链上写下一个 id 之后，没有任何东西会告诉你"它已经不存在了"** ——
   *    测试全绿、系统照跑，只是每一次调用都先撞一次 404（白烧时间）。
   *
   * ② 乌龙：我第一版把"本机网关"当成了线上网关（见 `routedModel.ts` 里
   *    "两个不同的 magpie"那段）—— `group/team-grunt` 在本机 404、在线上 200。
   *    **所以判据只能用【线上】那一份快照。**
   *
   * ⚠️ 局限（如实写在这里）：它是**某一时刻的观测**，不是契约；
   * 它防的是"悄悄加了一个线上不存在的 id"，防不住"网关侧单方面变了"。
   */
  const SERVER_404 = new Set([
    'group/auto-gemini-4-argon',
    'group/smart-split',
    'group/never-stuck',
    'group/cheap-first',
    'group/freeall',
  ]);
  /*
   * 本机 404（**仅记录，不作判据**）：`group/team-grunt` / `team-analyst` / `team-judge` /
   * `team-news`、`group/auto-*-free` 系列。
   * 它们**线上实测 200**（`team-grunt` 1.19–1.39s、`auto-space-bunny-free` 1.41–1.43s）——
   * 所以它们可以出现在链上（`group/team-*` 被刻意保留在链尾）。
   */
  for (const [tier, ladder] of [['T1_fast', TIER_LADDERS['T1_fast']], ['T2_mid', TIER_LADDERS['T2_mid']], ['T3_deep', TIER_LADDERS['T3_deep']]] as const) {
    for (const id of ladder ?? []) {
      if (SERVER_404.has(id)) {
        assert.fail(`★ 档位 ${tier} 的链里有**线上**实测 404 的 id：${id}（去掉它，或先复测再更新快照）`);
      }
    }
  }
});

test('★★★ 刻意排除的模型不得出现在任何链里（额度/能力层面的硬事实，不是延迟判断）', () => {
  /*
   * ## 为什么这些是"硬事实"而不是"某次测得慢"
   *
   * 下面每一条都有**具体错误信息**（说明请求真的到了上游）：
   * ```
   *   group/smart-split           429  OpenCode Go: usage limit exceeded（到 10-25 才恢复）
   *   opencode-go/omen-alpha      429  同一个
   *   group/auto-gpt-6-sol        502  Devin: an internal error occurred（66s）
   *   group/auto-claude-opus-5-5  502  Devin: an internal error occurred（36s）
   *   group/auto-claude-haiku-5-5 400  insufficient credits
   *   workbuddy-ai/*（直连 id）    400  not allowed for user type personal_free_user
   * ```
   * 429/502/400 是**能力与额度**层面的事实 —— 它们不会因为"这次运气好"而变好，
   * 所以适合写成断言；而**延迟只是"这一批测量的排序"**，不该被钉成阈值。
   */
  const EXCLUDED = new Set([
    'group/smart-split',
    'opencode-go/omen-alpha',
    'group/auto-gpt-6-sol',
    'group/auto-claude-opus-5-5',
    'group/auto-claude-haiku-5-5',
    'opencode-zen-free/longcat-2.5-preview-free',
    'group/auto-longcat-2-5-preview-free',
    'opencode-zen-free/nemotron-3.5-lightning-free',
  ]);
  const all: Array<[string, string]> = [
    ...Object.entries(TIER_LADDERS),
    ...Object.entries(ROLE_GROUP_LADDERS),
  ].flatMap(([name, ladder]) => (ladder ?? []).map((id) => [name, id] as [string, string]));
  for (const [name, id] of all) {
    assert.ok(!EXCLUDED.has(id), `★ ${name} 的链里有被排除的模型：${id}`);
  }
});

test('★ 200K 上下文的模型不得当"可能读超长材料"的角色的链首', () => {
  /*
   * 实测上下文（`/v1/models` 的 `context_length`，2026-10-17）：
   * ```
   *   opencode-zen-free/deepseek-v4.1-flash-free  200,000
   *   opencode-zen-free/glm-5.3-flash-free        200,000
   *   opencode-zen-free/space-bunny-free          524,288
   *   opencode-zen-free/beam-free               1,048,576
   * ```
   * ⚠️ 上下文不够时**模型不会说"上下文不够"** —— 它表现为"输出被截断"或超时。
   * 而 `market_analyst` 是唯一读全量候选的角色（`technical` 读的是限流后的材料），
   * 所以它**必须**有一个大上下文的链首。
   */
  const CAUTION_200K = new Set([
    'opencode-zen-free/deepseek-v4.1-flash-free',
    'opencode-zen-free/glm-5.3-flash-free',
  ]);
  const chain = ROLE_GROUP_LADDERS['market_analyst'];
  assert.ok(chain !== undefined, '★ market_analyst 必须有链');
  assert.ok(!CAUTION_200K.has(chain![0]!),
    `★ market_analyst 的链首不能是 200K 上下文的模型（它读全量候选）：${chain![0]}`);
  /* 而 T2 档的兜底链同样要守这一条（未绑角色会用它）。 */
  assert.ok(!CAUTION_200K.has(TIER_LADDERS['T2_mid']?.[0] ?? ''),
    `★ T2_mid 兜底链的链首不能是 200K 上下文的模型：${TIER_LADDERS['T2_mid']?.[0] ?? ''}`);
});

test('★ 链上必须至少有一个免费模型（用户要求"不能浪费免费不限量的属性"）', () => {
  /*
   * 用户原话：「**利用好所有可用模型**……特别是那些标注了免费得模型」。
   * `opencode-zen-free` 是网关上的免费档（实测全部 200）。
   */
  /*
   * ⚠️ 2026-10-17 修正判据：原来的写法是「每条链都必须有免费模型」，那是**错的算法** ——
   * `T3_deep` 的主力**有意**是付费强模型（用户要求「关键 AI 保证高智商」）。
   * 正确的不变量是「**项目里确实用上了免费模型**」（用户原话：
   * 「利用好所有可用模型……特别是那些标注了免费得模型」）。
   */
  const all: Array<[string, string]> = [
    ...Object.entries(TIER_LADDERS),
    ...Object.entries(ROLE_GROUP_LADDERS),
  ].flatMap(([name, ladder]) => (ladder ?? []).map((id) => [name, id] as [string, string]));
  const freeUsed = all.filter(([, id]) => id.startsWith('opencode-zen-free/'));
  assert.ok(freeUsed.length >= 3,
    `★ 免费模型用得太少（${freeUsed.length} 处）—— 用户明确要求利用免费不限量的模型；至少要覆盖体力活与分析两档`);
  /* 体力活档（T1）必须以免费为主：那是「速度与可用性优先、智商次要」的那一档。 */
  const t1 = TIER_LADDERS['T1_fast'] ?? [];
  assert.ok(t1.filter((id) => id.startsWith('opencode-zen-free/')).length >= 2,
    `★ T1_fast 的链里免费模型太少（${t1.join(' → ')}）`);
});
test('★★★ 分析师角色的输出预算必须与【超时线】协调 —— 不能大到必然超时', () => {
  /*
   * ## 决定性实测（同一材料，只变 max_tokens）
   *
   * ```
   *   单标的材料 + max_tokens=2000 → 20.5 秒 · completion=2000（【用满】）· content=0 字！
   *   单标的材料 + max_tokens=800  → 11.8 秒 · completion=800 （【用满】）· content=493 字
   *   finish_reason = "length"    ← 全部撞上限
   * ```
   *
   * 而 `TEAM_BASE_MAX_TOKENS = 8192` → **最坏要跑 80+ 秒** ——
   * 若 T1 超时线是 60 秒，那**必然超时**。
   *
   * ## ⚠️ 2026-10-13 改：判据从"写死 2048"改成"从超时线推导"
   *
   * 原来的断言是 `budget <= 2048`，理由写死为"T1 的 60 秒超时线"。
   * 而线上实测把两条**都推翻了**：
   * ```
   *   market_analyst：三个候选全部"输出被 token 上限截断（思维链占满了预算）"
   *   technical：      "超过 60 秒未返回（按档位 T1_fast 的超时）"
   * ```
   * 于是我把 T1 提到 **120 秒**、`market_analyst` 提到 **4096** ——
   * **两个数字一起变，而写死 2048 的断言就假失败了**。
   *
   * ## 所以判据要**表达那条真正的物理约束**
   *
   * 真正的约束不是"预算 ≤ 某数字"，而是：
   * ```
   *   最坏耗时（预算 × 实测吞吐）  <  该角色的超时线
   * ```
   * 实测吞吐约 **2000 token / 20.5 秒 ≈ 98 token/秒**（撞上限、用满预算的最坏情况）。
   * 于是"预算 ≤ 超时秒数 × 98"才是那个不变量 ——
   * **它让预算与超时线永远自洽**，改任一个都会被这条测试检查到。
   */
  const TOKENS_PER_SEC = 2000 / 20.5; /* ≈ 97.6 —— 实测撞上限时的吞吐 */
  for (const [role, tier] of [
    ['market_analyst', 'T2_mid'],
    ['technical', 'T1_fast'],
    ['newscaster', 'T1_fast'],
    ['sentiment', 'T1_fast'],
  ] as const) {
    const budget = ROLE_MAX_TOKENS[role];
    assert.ok(budget !== undefined, `★ ${role} 应当有输出预算`);
    const timeoutSec = ROLE_TIMEOUT_MS[tier]! / 1000;
    const worstSec = budget! / TOKENS_PER_SEC;
    assert.ok(
      worstSec < timeoutSec,
      `★ ${role} 的最坏耗时（${worstSec.toFixed(0)} 秒 = ${budget} token）` +
        `必须小于它的超时线（${tier} = ${timeoutSec} 秒）—— 否则必然超时、角色整轮缺席`,
    );
    /*
     * ⚠️ 也不能太小：实测 `market_analyst` 在 12 标的材料 + mt=1024 时
     * `content = 0 字`（只想不说）。
     */
    assert.ok(budget! >= 1024, `★ ${role} 的预算不能低于 1024（实测 1024 会 content=0 字）`);
  }
  /* 辩论/裁决需要完整论证，可以更大 —— 但同样受它们自己的超时线约束。 */
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **这里原来写死 `judge <= 8192` —— 与上面那段注释自相矛盾**（2026-10-15 修）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 上面那段注释自己说：
   * > 原来的断言是 `budget <= 2048`…而写死 2048 的断言就假失败了
   * > 真正的约束不是"预算 ≤ 某数字"，而是：
   * >   最坏耗时（预算 × 实测吞吐） < 该角色的超时线
   *
   * 而紧接着**对 judge 写的正是"写死 8192"** —— 同一种错。
   *
   * ## 而实测证明 8192 已经不够了
   *
   * ```
   *   judge 输出长度（全历史 59 个可测轮）: p50=5,844 · p90=9,921 · max=12,111
   *   超 8192 的: 14 / 59（23.7%）
   *   且与候选数强相关：候选 13–18 时超限率 54.5%、>18 时 62.5%
   * ```
   * 后果是**那一轮一条决策都没有**（线上原文：
   * `⚠️ 裁决里的 JSON 解析失败（可能被截断）—— 本轮按"不行动"处理`）。
   *
   * ## 所以改用那条真正的物理约束
   *
   * T3 的超时线是 **360 秒**（`ROLE_TIMEOUT_MS.T3_deep` —— 那次"从 180 提到 360"
   * 是因为实测裁决官每轮都被切断、20 个候选只评了前 5 个）。
   * ```
   *   16384 / 97.6 ≈ 168 秒  <  360 秒   ✅ 余量 2 倍以上
   * ```
   */
  const t3TimeoutSec = ROLE_TIMEOUT_MS['T3_deep']! / 1000;
  const judgeWorstSec = ROLE_MAX_TOKENS['judge']! / TOKENS_PER_SEC;
  assert.ok(
    judgeWorstSec < t3TimeoutSec,
    `★ judge 的最坏耗时（${judgeWorstSec.toFixed(0)} 秒 = ${ROLE_MAX_TOKENS['judge']} token）` +
      `必须小于 T3 的超时线（${t3TimeoutSec} 秒）—— 否则必然超时、整轮无决策`,
  );
  /*
   * ⚠️ 另一条独立的边界：**不能小到装不下已有输出**。
   * 实测 max=12,111 字 —— 若预算低于它，那一轮必然截断。
   */
  assert.ok(
    ROLE_MAX_TOKENS['judge']! >= 8192,
    '★ judge 的预算不能低于 8192（实测最大输出 12,111 字，低于此必然截断）',
  );
});

test('★ 分析师预算必须【小于】辩论/裁决（按任务分配，不是一刀切）', () => {
  /*
   * ⚠️ 若两者相等，说明"按任务分配"没做 —— 而分析师的任务是"描述"，
   * 辩论/裁决的任务是"论证"，它们的输出需求本就不同。
   */
  const analyst = ROLE_MAX_TOKENS['technical']!;
  const debate = ROLE_MAX_TOKENS['judge']!;
  assert.ok(analyst < debate, `★ 分析师（${analyst}）应当小于裁决（${debate}）`);
});

test('★ 未知角色没有条目（退回调用方基准，不改既有行为）', () => {
  assert.equal(ROLE_MAX_TOKENS['某个不存在的角色'], undefined);
});
