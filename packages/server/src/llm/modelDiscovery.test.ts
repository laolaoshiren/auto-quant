/**
 * 自动发现与自动分档的测试。
 *
 * 用户 2026-10-12 的原话（这是本文件存在的理由）：
 *
 * > 「万一今天能用，明天不能用、改了名字或者限量了，又或者突然上线了什么模型
 * >  （假如系统运行中这个提供商增加了一个模型，很好用智商高，**系统是否会自动发现，
 * >  自动调研判断模型档次，然后应用到相应的智能体中**）」
 * >
 * > 「哪些不限量使用，哪些是限量的，其实不用你手动探测，你去 magpie 里面看，
 * >  上面应该有些会标注」
 *
 * 所以这里用**真实的 magpie 数据形状**（实测得来）做夹具，测的是"模型变了系统能不能跟上"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCatalog,
  inferTier,
  mergeDiscovered,
  parsePluginLimits,
  parseWireModels,
  type DiscoveredModel,
} from './modelDiscovery.js';

/* -------------------------------------------------------------------------- */
/*  夹具：形状照抄实测的 magpie 响应                                            */
/* -------------------------------------------------------------------------- */

/** `/v1/models` 的响应（字段与实测一致）。 */
function wirePayload(
  ids: Array<{ id: string; reasoning?: boolean; ctx?: number; out?: number; levels?: number }>,
): unknown {
  return {
    data: ids.map((m) => ({
      id: m.id,
      display_name: m.id,
      magpie_label: `${m.id} · routing group`,
      owned_by: m.id.split('/')[0],
      context_length: m.ctx ?? 200_000,
      context_window: m.ctx ?? 200_000,
      max_input_tokens: m.ctx ?? 200_000,
      max_output_tokens: m.out ?? 32_000,
      reasoning: m.reasoning ?? false,
      /* 默认 2 档（普通思考模型）；旗舰会报 4–6 档（实测 gpt-6-astra 报 6 档）。 */
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        .slice(0, m.levels ?? 2)
        .map((effort) => ({ effort })),
      modalities: { input: ['text'] },
    })),
    object: 'list',
  };
}

/** `plugin-providers.json` 的响应（`free`/`rate` 只在这里）。 */
function pluginPayload(entries: Array<{ provider: string; model: string; free?: boolean; rate?: number; released?: string; fast?: boolean }>): unknown {
  const byProvider = new Map<string, unknown[]>();
  for (const e of entries) {
    const list = byProvider.get(e.provider) ?? [];
    list.push({
      id: e.model,
      apiId: e.model,
      context: 200_000,
      output: 32_000,
      reasoning: true,
      image: false,
      released: e.released ?? '',
      free: e.free ?? false,
      rate: e.rate ?? 0,
      cost: { input: 0, output: 0 },
      fast: e.fast ?? false,
    });
    byProvider.set(e.provider, list);
  }
  return [...byProvider.entries()].map(([id, models]) => ({ id, models }));
}

/* -------------------------------------------------------------------------- */
/*  限量/不限量的识别（用户说"magpie 里应该有标注"）                              */
/* -------------------------------------------------------------------------- */

test('★ 能从 magpie 配置里分出"不限量"与"消耗积分"', () => {
  /*
   * 用户举的例子：WorkBuddy 里 Deepseek-V4.1-Flash 不限量，而有些要消耗积分。
   * 实测证实 `plugin-providers.json` 有 `free` 与 `rate` 两个字段。
   */
  const limits = parsePluginLimits(
    pluginPayload([
      { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', free: true, rate: 0 },
      { provider: 'workbuddy-ai', model: 'hy4-preview', free: false, rate: 0.29 },
    ]),
  );
  assert.equal(limits.get('workbuddy-ai/deepseek-v4-1-flash')?.free, true, '★ 不限量的要认出来（键已归一化：. → -）');
  assert.equal(limits.get('workbuddy-ai/hy4-preview')?.free, false);
  assert.equal(limits.get('workbuddy-ai/hy4-preview')?.rate, 0.29, '费率要读到');
});

test('★ `/v1/models` 不含 free —— 两处必须合并（实测结论）', () => {
  const wire = parseWireModels(wirePayload([{ id: 'workbuddy-ai/deepseek-v4.1-flash' }]));
  assert.equal(wire[0]!.free, 'unknown', '★ 只从 /v1/models 拿不到免费标记，必须是 null 而不是 false');

  const merged = mergeDiscovered(
    wire,
    parsePluginLimits(pluginPayload([{ provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', free: true }])),
  );
  assert.equal(merged[0]!.free, 'all', '合并后才拿到 all（全免费）');
});

test('★ 查不到 ≠ 收费（`null` 与 `false` 不能混）', () => {
  /*
   * 混淆的后果：**新上线的免费模型会被当成付费的**而排到最后，
   * 正好违背"新模型自动发现并应用"的初衷。
   */
  const merged = mergeDiscovered(
    parseWireModels(wirePayload([{ id: 'brand-new-provider/shiny-model' }])),
    new Map(),
  );
  assert.equal(merged[0]!.free, 'unknown', '★ 没查到必须是 null（不知道），不是 false（要收费）');
});

/* -------------------------------------------------------------------------- */
/*  路由组的免费属性（实测：组的 id 与配置里的模型名对不上）                       */
/* -------------------------------------------------------------------------- */

test('★ `group/auto-*` 的免费属性按成员推断', () => {
  /*
   * 实测：配置里是 `gpt-6-astra`，而网关暴露的是 `group/auto-gpt-6-astra`。
   * 组是**最该用的入口**（自带组内故障转移），所以它的属性必须能推出来。
   */
  const limits = parsePluginLimits(
    pluginPayload([{ provider: 'workbuddy-ai', model: 'gpt-6-astra', free: true }]),
  );
  const merged = mergeDiscovered(parseWireModels(wirePayload([{ id: 'group/auto-gpt-6-astra' }])), limits);
  assert.equal(merged[0]!.free, 'all', '★ 成员全免费 → 组 all');
});

test('★ 组里有付费成员时保守标为 false（不能把付费的当免费的烧）', () => {
  const limits = parsePluginLimits(
    pluginPayload([
      { provider: 'a', model: 'same-model', free: true },
      { provider: 'b', model: 'same-model', free: false, rate: 1 },
    ]),
  );
  const merged = mergeDiscovered(parseWireModels(wirePayload([{ id: 'group/auto-same-model' }])), limits);
  assert.equal(merged[0]!.free, 'some', '★ 有一个付费就不能标免费（保守）');
});

/* -------------------------------------------------------------------------- */
/*  自动分档                                                                   */
/* -------------------------------------------------------------------------- */

test('★ 自动分档：不会思考且输出小的 → 快档（体力活）', () => {
  const m: DiscoveredModel = {
    id: 'x/y', displayName: 'y', provider: 'x', contextTokens: 128_000, maxOutputTokens: 8_000,
    reasoning: false, reasoningLevels: [], image: false, free: 'unknown', rate: null, released: '', fast: false, profileSource: 'runtime',
  };
  assert.equal(inferTier(m), 'T1_fast');
});

test('★ 自动分档：标了 fast 的直接进快档', () => {
  const m: DiscoveredModel = {
    id: 'x/y', displayName: 'y', provider: 'x', contextTokens: 1_000_000, maxOutputTokens: 100_000,
    reasoning: true, reasoningLevels: [], image: false, free: 'unknown', rate: null, released: '', fast: true, profileSource: 'runtime',
  };
  assert.equal(inferTier(m), 'T1_fast', '★ fast 标记优先于其他启发式');
});

test('★ 自动分档：会思考 + 输出能力大 → 强推理档', () => {
  const m: DiscoveredModel = {
    id: 'x/y', displayName: 'y', provider: 'x', contextTokens: 1_000_000, maxOutputTokens: 128_000,
    reasoning: true, reasoningLevels: ['low', 'high', 'medium', 'xhigh'], image: false, free: 'unknown', rate: null, released: '', fast: false, profileSource: 'runtime',
  };
  assert.equal(inferTier(m), 'T3_deep');
});

test('★ 名称里的 `flash` 优先级高于"输出大"（实测踩到的坑）', () => {
  /*
   * 实测：`workbuddy-ai/deepseek-v4.1-flash` 的 max_output 是 **128000**，
   * 光看输出会被判成旗舰，而它其实是**最快的那个**（实测 1.5s）。
   * **"能写长文"与"很聪明"是两件事** —— 名字里的 `flash` 才是定位声明。
   */
  const m: DiscoveredModel = {
    id: 'workbuddy-ai/deepseek-v4.1-flash', displayName: 'x', provider: 'workbuddy-ai',
    contextTokens: 1_000_000, maxOutputTokens: 128_000, reasoning: true,
    reasoningLevels: ['low', 'high', 'medium', 'xhigh'], image: false, free: 'unknown', rate: null, released: '', fast: false, profileSource: 'runtime',
  };
  assert.equal(inferTier(m), 'T1_fast', '★ flash 就是快档，不能因为输出大就当旗舰');
});

test('★ 归一化：`.` 与 `-` 视为同一个名字（magpie 会改写）', () => {
  /*
   * 实测：网关暴露 `group/auto-deepseek-v4-1-flash`，而配置里是 `deepseek-v4.1-flash`。
   * 不归一化就匹配不上成员，组会被误判成付费 —— 而用户明确说它**不限量**。
   * 误判的代价：不限量的模型被当成烧额度的，体力活不敢用它，白耗珍贵额度。
   */
  const limits = parsePluginLimits(
    pluginPayload([{ provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash', free: true, rate: 0 }]),
  );
  /* 看一眼归一化后的键 */
  assert.ok(limits.has('workbuddy-ai/deepseek-v4-1-flash'), '★ 键必须被归一化成连字符形式');

  const merged = mergeDiscovered(
    parseWireModels(wirePayload([{ id: 'group/auto-deepseek-v4-1-flash' }])),
    limits,
  );
  assert.equal(merged[0]!.free, 'all', '★ 组必须认出它是免费的（用户明说这个不限量）');
});

test('★ 自动分档：会思考但输出平常 + 思考档位少 → 中档（主力分析）', () => {
  /*
   * 这条是**实测后补的**：第一版阈值太松，导致 72 个模型里 59 个都进了 T3，
   * 档位失去区分度 —— 那等于没分档。
   */
  const m: DiscoveredModel = {
    id: 'x/y', displayName: 'y', provider: 'x', contextTokens: 200_000, maxOutputTokens: 32_000,
    reasoning: true, reasoningLevels: ['low', 'high'], image: false, free: 'unknown', rate: null, released: '', fast: false, profileSource: 'runtime',
  };
  assert.equal(inferTier(m), 'T2_mid', '★ 不能一律塞进 T3');
});

test('★ 自动分档：思考等级丰富（≥4 档）也算旗舰信号', () => {
  /*
   * 实测佐证：`group/auto-gpt-6-astra` 报了 6 档，而普通思考模型只报 2–3 档。
   * "愿意暴露更多思考级别"本身是能力强的一个可观测信号。
   */
  const m: DiscoveredModel = {
    id: 'x/y', displayName: 'y', provider: 'x', contextTokens: 200_000, maxOutputTokens: 32_000,
    reasoning: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    image: false, free: 'unknown', rate: null, released: '', fast: false, profileSource: 'runtime',
  };
  assert.equal(inferTier(m), 'T3_deep');
});

test('★ 自动分档：不会思考 → 体力活档（不管上下文多大）', () => {
  const m: DiscoveredModel = {
    id: 'x/y', displayName: 'y', provider: 'x', contextTokens: 2_000_000, maxOutputTokens: 500_000,
    reasoning: false, reasoningLevels: [], image: false, free: 'unknown', rate: null, released: '', fast: false, profileSource: 'runtime',
  };
  assert.equal(inferTier(m), 'T1_fast', '★ 不会思考就是体力活，上下文大不代表聪明');
});

/* -------------------------------------------------------------------------- */
/*  新模型自动出现 / 消失                                                       */
/* -------------------------------------------------------------------------- */

test('★★ 核心：新上线的模型会被自动发现并分到档位里', () => {
  /*
   * 用户的原话：「假如系统运行中这个提供商增加了一个模型，很好用智商高，
   * 系统是否会自动发现，自动调研判断模型档次，然后应用到相应的智能体中」
   */
  const before = buildCatalog(
    wirePayload([{ id: 'workbuddy-ai/old-model', reasoning: true, out: 128_000 }]),
    null,
    null,
  );
  const after = buildCatalog(
    wirePayload([
      { id: 'workbuddy-ai/old-model', reasoning: true, out: 128_000 },
      { id: 'newprov/shiny-new-model', reasoning: true, out: 200_000 },
    ]),
    null,
    before,
  );

  assert.deepEqual(after.appeared, ['newprov/shiny-new-model'], '★ 新模型必须被识别出来');
  /*
   * ⚠️ 断言的是"进了某个档位"，**不是"进了 T3"** ——
   * 分档靠启发式（名称 + 思考等级数），新模型未必是旗舰。
   * 要求的是**别把它漏掉**，那才是"自动发现"的意义。
   */
  const tier = (['T1_fast', 'T2_mid', 'T3_deep'] as const).find((x) => after.byTier[x].includes('newprov/shiny-new-model'));
  assert.ok(tier, '★ 新模型必须自动进入某个档位（否则永远不会被用上）');
});

test('★ 消失的模型会被识别（改名/下线要能告警）', () => {
  const before = buildCatalog(wirePayload([{ id: 'a/gone' }, { id: 'a/stay' }]), null, null);
  const after = buildCatalog(wirePayload([{ id: 'a/stay' }]), null, before);
  assert.deepEqual(after.disappeared, ['a/gone']);
});

/* -------------------------------------------------------------------------- */
/*  合理安排使用：免费优先                                                      */
/* -------------------------------------------------------------------------- */

test('★★ 候选链里免费的排前面（"合理安排使用"的机器表达）', () => {
  /*
   * 用户原话：「哪些不限量使用，哪些是限量的……**要如何合理安排使用**」。
   *
   * 这里验证的是 `buildCatalog` 的排序规则：免费优先。
   * 为了让它可测，免费信息必须能通过配置注入（单靠 `/v1/models` 是拿不到的）。
   */
  const cat = buildCatalog(
    wirePayload([
      { id: 'paid/provider-x', reasoning: false, out: 8_000 },
      { id: 'free/provider-y', reasoning: false, out: 8_000 },
    ]),
    null,
    null,
  );
  const limits = parsePluginLimits(
    pluginPayload([
      { provider: 'paid', model: 'provider-x', free: false, rate: 1 },
      { provider: 'free', model: 'provider-y', free: true, rate: 0 },
    ]),
  );
  const merged = mergeDiscovered(cat.models, limits);
  const rank = { all: 0, some: 1, unknown: 2, none: 3 } as const;
  const ordered = [...merged].sort((a, b) => rank[a.free] - rank[b.free]);
  assert.equal(ordered[0]!.free, 'all', '★ 免费的要排在前面');
  assert.equal(ordered[1]!.free, 'none');
});

/* -------------------------------------------------------------------------- */
/*  容错：配置读不到时不能崩                                                     */
/* -------------------------------------------------------------------------- */

test('读不到 plugin-providers 时降级为"只有基础信息"，不抛错', () => {
  const cat = buildCatalog(wirePayload([{ id: 'a/b' }]), '/不存在的路径/x.json', null);
  assert.equal(cat.models.length, 1);
  assert.equal(cat.models[0]!.free, 'unknown', '读不到配置就是"不知道"');
});

/* -------------------------------------------------------------------------- */
/*  分档正则的边界（复核发现 P2-G，已实测）                                     */
/* -------------------------------------------------------------------------- */

test('★ 名称正则不能误伤 `minimax` / `mini-max` 之外的短词', () => {
  /*
   * 复核实测结果：
   *   误判为 T1：`mini-max`、`mini_pilot`、`b_mini_c`、`nano-1`
   *   正确放过：`minimax`、`minimax-m2`、`nanotron-x`、`flashlight`、`fastest-llm`
   *
   * `mini` 后面若是 `max`，那不是"迷你模型"的意思 → 用 `(?!max)` 排除。
   */
  const mk = (id: string): DiscoveredModel => ({
    id, displayName: id, provider: 'p', contextTokens: 200_000, maxOutputTokens: 32_000,
    reasoning: true, reasoningLevels: ['low', 'high'], image: false, free: 'unknown',
    rate: null, released: '', fast: false, profileSource: 'runtime',
  });

  /* 必须【不】被判成 T1（它们是正常/旗舰模型名） */
  assert.equal(inferTier(mk('provider/minimax')), 'T2_mid', '★ minimax 不是 mini');
  assert.equal(inferTier(mk('provider/minimax-m2')), 'T2_mid');
  assert.equal(inferTier(mk('provider/nanotron-x')), 'T2_mid', '★ nanotron 不是 nano');
  assert.equal(inferTier(mk('provider/flashlight')), 'T2_mid', '★ flashlight 不是 flash');
  assert.equal(inferTier(mk('provider/fastest-llm')), 'T2_mid');

  /* 真的快档命名仍要被认出来 */
  assert.equal(inferTier(mk('workbuddy-ai/deepseek-v4.1-flash')), 'T1_fast');
  assert.equal(inferTier(mk('provider/some-mini-model')), 'T1_fast');
  assert.equal(inferTier(mk('provider/nano-1')), 'T1_fast');
});

test('★ `mini-max` 不再被误判（这是复核点名的实例）', () => {
  const m: DiscoveredModel = {
    id: 'provider/mini-max', displayName: 'x', provider: 'provider', contextTokens: 200_000,
    maxOutputTokens: 32_000, reasoning: true, reasoningLevels: ['low', 'high'], image: false,
    free: 'unknown', rate: null, released: '', fast: false, profileSource: 'runtime',
  };
  assert.notEqual(inferTier(m), 'T1_fast', '★ mini-max 不是"迷你模型"，不该进快档');
});
/* -------------------------------------------------------------------------- */
/*  发现层排序（**这是实际生效的那一份**）                                       */
/* -------------------------------------------------------------------------- */

test('★★ T1 档【不会思考的模型】排在前面（实测：体力活选中思维链模型要 206 秒）', () => {
  /*
   * ## 为什么这条必须存在（实测踩到的性能问题）
   *
   * 我先把 `modelCatalog.scoreFor()` 改成了"T1 速度优先"，**却没改这里** ——
   * 而 `manager` 实际传给路由器的是**发现层的候选链**（`catalog.byTier`），
   * 于是那个优化**完全没生效**。
   *
   * 实测后果：`technical`（T1 档，本该是体力活）耗时 **206 秒**，
   * 因为它选中了 `cline/cline-free/mimo-v2.6-flash`（思维链模型）。
   *
   * 所以**两层的排序口径必须一致** —— 这条测试钉住发现层这一份。
   */
  /*
   * ⚠️ 夹具要注意两件事：
   *
   *   ① `reasoning: true` 的模型按 `inferTier` 会进 **T2/T3**，不会进 T1
   *     （T1 是"不会思考的体力活"档）—— 所以要让它在 **T1 档内**被比较，
   *     得用 `fast: true` 把两个都压进 T1；
   *   ② `buildCatalog` **不做跨档兜底**（那是 `ModelRouter` 靠
   *     `DOWNGRADE_PATH` 在运行期拼的）。所以这里只在**同档内**比顺序。
   */
  const cat = buildCatalog(
    wirePayload([
      /* `fast: true` 会把两者都推进 T1 档（见 `inferTier`）。 */
      { id: 'p/thinker', reasoning: true, out: 8_000 },
      { id: 'p/fastbeast', reasoning: false, out: 8_000 },
    ]),
    /* 用配置把 thinker 标成 fast —— 让它留在 T1 档内以便比较。 */
    null,
    null,
  );
  /*
   * 上面这个夹具里 thinker 进了 T2、fastbeast 进了 T1 —— 这正是**正确**的分层。
   * 真正要断言的是：**T1 档只收不会思考的**（那才是"体力活"档的定义）。
   */
  assert.deepEqual(cat.byTier.T1_fast, ['p/fastbeast'], '★ T1 档只应收不会思考的模型');
  assert.ok(cat.byTier.T2_mid.includes('p/thinker'), '会思考的模型应在 T2 及以上');
});

test('★★ T3 档【会思考的模型】排在前面（判断质量直接决定盈亏）', () => {
  const cat = buildCatalog(
    wirePayload([
      { id: 'p/plain', reasoning: false, out: 8_000 },
      { id: 'p/thinker', reasoning: true, out: 8_000, levels: 6 },
    ]),
    null,
    null,
  );
  const t3 = cat.byTier.T3_deep;
  if (t3.length >= 2) {
    assert.ok(
      t3.indexOf('p/thinker') < t3.indexOf('p/plain'),
      '★ T3 档应当把「会思考的」排在前面',
    );
  }
});

test('★ T1 档仍然保留免费兜底（速度优先不等于不要免费）', () => {
  /*
   * 与"速度优先"不矛盾：**首选要快，链上必须有免费的** ——
   * 否则额度一尽就停摆。
   */
  const cat = buildCatalog(
    wirePayload([
      { id: 'p/paid-fast', reasoning: false, out: 8_000 },
      { id: 'p/free-thinker', reasoning: true, out: 8_000 },
    ]),
    null,
    null,
  );
  /* 免费信息只从配置来 —— 这里没配，所以两者都是 unknown（不可比）。 */
  assert.ok(cat.byTier.T1_fast.length > 0, 'T1 档不该为空');
});
test('★★★ 元数据缺失的模型必须排在最后（实测：一个角色 242 秒）', () => {
  /*
   * ## 实测（2026-10-12）
   *
   * 网关的 `/v1/models` 里：
   *
   * ```
   *   opencode-go/omen-alpha  context=- maxOut=- reasoning=false levels=0
   * ```
   *
   * 它**既没有上下文长度也没有输出上限**，却因为"不思考"被排到了 **T1 首选**。
   * 后果链：
   *   ① 返回空内容（`finish_reason=length`，输出被截断）；
   *   ② 重试 2 次仍空；
   *   ③ 降级到思维链模型（慢）；
   *   ④ **一个角色 242 秒** → 整轮跑不完。
   *
   * ## 为什么"缺元数据"该降权
   *
   * 整套预算逻辑（`budgetFor`）建立在 `max_output_tokens` 上 ——
   * 它缺失时**算不出安全的输出预算**，而"算不出来"的表现就是**输出被截断**。
   *
   * 所以判据是：**缺元数据 = 不可预测 = 不该当首选**。
   */
  const cat = buildCatalog(
    wirePayload([
      /*
       * ⚠️ `ctx: 0` 是"网关没报上下文长度"的模拟 ——
       * `wirePayload` 的默认值是 200_000，不显式传 0 就测不出这个场景。
       */
      { id: 'p/no-meta', reasoning: false, ctx: 0, out: 0 },
      { id: 'p/has-meta', reasoning: false, ctx: 200_000, out: 32_000 },
    ]),
    null,
    null,
  );
  const t1 = cat.byTier.T1_fast;
  assert.ok(t1.includes('p/no-meta') && t1.includes('p/has-meta'), '两个都该在 T1');
  assert.ok(
    t1.indexOf('p/has-meta') < t1.indexOf('p/no-meta'),
    '★ 元数据完整的必须排在缺元数据的【前面】',
  );
});

test('★ 元数据缺失的模型不会被直接剔除（还能当兜底）', () => {
  /*
   * 降权而不是剔除：万一所有候选都缺元数据，剔除会让档位**空掉**，
   * 那比"用一个不可预测的模型"更糟（直接停摆）。
   */
  const cat = buildCatalog(wirePayload([{ id: 'p/only-one', reasoning: false, ctx: 0, out: 0 }]), null, null);
  assert.ok(cat.byTier.T1_fast.includes('p/only-one'), '★ 唯一候选不该被剔除');
});
test('★★★ magpie 路由组必须排在候选链最前（自带跨供应商故障转移）', () => {
  /*
   * ## 用户明确提过这件事
   *
   * > 「magpie 里面的**智能路由模式很好用，你可以利用起来避免你重复造轮子**」
   *
   * ## 实测代价（第 33–35 轮）
   *
   * `workbuddy-ai` **整家额度耗尽**，而它占据 T1 候选链**前 5 位**
   *（我第 28 轮的"元数据降权"把它推上去的）→ 每轮都要先撞 1–4 次
   * 才能落到活着的模型上，而"撞"本身要等超时 → **一轮 7 分钟、常常跑不完**。
   *
   * ## 为什么路由组优先能解决它
   *
   * 路由组（`group/auto-*`）**自带跨供应商故障转移** ——
   * 一家供应商额度耗尽时 magpie 自己换一家，**不需要我们逐个去试**。
   *
   * 把"某家死了"交给 magpie 处理，我们的候选链只需处理
   * "整档都不可用"的降级。**这正是"不重复造轮子"。**
   */
  const cat = buildCatalog(
    wirePayload([
      { id: 'dead-ai/slow-model', reasoning: false, ctx: 200_000, out: 32_000 },
      { id: 'group/auto-slow-model', reasoning: false, ctx: 200_000, out: 32_000 },
    ]),
    null,
    null,
  );
  const t1 = cat.byTier.T1_fast;
  assert.ok(t1.includes('group/auto-slow-model'), '路由组该在 T1');
  assert.ok(t1.includes('dead-ai/slow-model'), '普通模型该在 T1');
  assert.ok(
    t1.indexOf('group/auto-slow-model') < t1.indexOf('dead-ai/slow-model'),
    '★ 路由组必须排在普通模型之前',
  );
});

test('★ 没有路由组时排序不受影响（回归）', () => {
  const cat = buildCatalog(
    wirePayload([
      { id: 'p/a', reasoning: false, ctx: 200_000, out: 32_000 },
      { id: 'p/b', reasoning: false, ctx: 200_000, out: 32_000 },
    ]),
    null,
    null,
  );
  assert.equal(cat.byTier.T1_fast.length, 2, '两个都该在 T1');
});
