/**
 * models.dev 接入的测试。
 *
 * ## 夹具从哪来（这一段的目的是让下一个人能**复核**，而不是盲信）
 *
 * 下面 `REAL_FIXTURE` 里的每一条都是 **2026-10-14 对
 * `https://models.dev/api.json` 实际拉取后原样摘录**的（不是手抄、不是凭记忆）。
 * 实测规模：229 个 provider / 8,831 个模型 / 5,634,155 字节。
 *
 * 为什么坚持用真实片段而不是手写"形状对"的假数据 —— 本仓库的既有纪律
 *（`docs/AGENTS.md` §3.4「测试里写观测到的真实值」）。这条纪律在本次任务里
 * 立刻见效：`limit` 是**嵌套对象**、`cost` 的键是 `cache_read` 而非 `cache`、
 * `modalities` 是**对象**而非数组 —— 三个都极易写错，而手写夹具会把
 * **同一个错误**同时写进实现与测试，于是测试永远是绿的。
 *
 * ## 这个文件在防什么
 *
 * | 用例组 | 防的失败 |
 * |---|---|
 * | 解析 | 字段名写错（`limit` 嵌套 / `cost` 键名 / `modalities` 形状）|
 * | 归一化 | 只剥 `group/auto-` 而不是通用 `auto-`（后者会让 `auto-model` 变成 `model`）|
 * | 4 级阶梯 | 每一级的判定条件，以及"对不上必须 unknown"|
 * | `qfmodel` | 模糊匹配的噪声被当真（实测边界，见 `modelsDevAlias.ts`）|
 * | 命中率 | **7 个线上真名必须命中**（这是本任务最初的目标）|
 * | 快照 | 304 分支、失败保留旧快照、原子替换 |
 * | 覆盖顺序 | **models.dev 绝不覆盖 `/v1/models` 的实测值** |
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FUZZY_MIN_SIMILARITY,
  ModelsDevStore,
  fetchModelsDev,
  matchModel,
  normalizeGatewayName,
  parseModelsDev,
  readSnapshot,
  snapshotPath,
  versionTokens,
  writeSnapshotAtomic,
  type ModelsDevIndex,
} from './modelsDev.js';
import { mergeDiscovered, parseWireModels, type DiscoveredModel } from './modelDiscovery.js';

/* -------------------------------------------------------------------------- */
/*  夹具：2026-10-14 实测摘录                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 任务给出的两个真实片段（**逐字节照抄**，含全部字段）。
 *
 * 它的作用是把"三个最容易写错的地方"钉死：
 * - `limit: { context, output }` —— 不是顶层
 * - `cost: { input, output, cache_read, cache_write }` —— 不是 `cache`
 * - `modalities: { input: [...], output: [...] }` —— 不是数组
 */
const TASK_SNIPPET = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'https://api.anthropic.com',
    models: {
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5 (latest)',
        family: 'claude-sonnet',
        attachment: true,
        reasoning: true,
        tool_call: true,
        structured_output: true,
        temperature: true,
        knowledge: '2025-07-31',
        release_date: '2025-09-29',
        last_updated: '2025-09-29',
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        open_weights: false,
        limit: { context: 200000, output: 64000 },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        canonical_model_id: 'anthropic/claude-sonnet-4-5',
      },
    },
  },
  'alibaba-cn': {
    id: 'alibaba-cn',
    name: 'Alibaba (China)',
    api: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: {
      'deepseek-v4.1-flash': {
        id: 'deepseek-v4.1-flash',
        limit: { context: 1000000, output: 384000 },
        tool_call: true,
        reasoning: true,
        cost: { input: 0.29754, output: 1.19015, cache_read: 0.01488 },
      },
    },
  },
};

/**
 * 7 个线上真名的命中来源（实测摘录）。
 *
 * ⚠️ **关键事实**：`deepseek-v4.1-flash` **不在**官方 `deepseek` provider 里 ——
 * 实测官方 provider 只有 4 个模型（`deepseek-v4-flash` / `deepseek-flash` /
 * `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`）。
 * 所以匹配**必须跨全部 provider 查**，只查官方 provider 会漏掉它。
 */
const REAL_FIXTURE = {
  /* 官方 deepseek：只有 4 个模型，**没有** v4.1-flash（测试会把这一点钉住）。 */
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: true,
        tool_call: true,
        knowledge: '2025-05',
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, output: 393216 },
        cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
      },
    },
  },
  'alibaba-token-plan': {
    id: 'alibaba-token-plan',
    name: 'Alibaba Token Plan',
    models: {
      'deepseek-v4.1-flash': {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        reasoning: true,
        tool_call: true,
        structured_output: false,
        knowledge: '2025-05',
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, output: 384000 },
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
      },
    },
  },
  'nano-gpt': {
    id: 'nano-gpt',
    name: 'NanoGPT',
    models: {
      'deepseek/deepseek-v4.1-flash': {
        id: 'deepseek/deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        reasoning: true,
        tool_call: true,
        structured_output: true,
        knowledge: '2025-05',
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, input: 1000000, output: 384000 },
        cost: { input: 0.13, output: 0.52, cache_read: 0.006 },
        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
      },
      'moonshotai/kimi-k3': {
        id: 'moonshotai/kimi-k3',
        name: 'Kimi K3',
        reasoning: true,
        tool_call: true,
        structured_output: true,
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        limit: { context: 1048576, input: 1048576, output: 943718 },
        cost: { input: 2, output: 10, cache_read: 0.2 },
        canonical_model_id: 'moonshotai/kimi-k3',
      },
      'z-ai/glm-5.3-flash': {
        id: 'z-ai/glm-5.3-flash',
        name: 'GLM 5.3 Flash',
        reasoning: true,
        tool_call: true,
        structured_output: true,
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        limit: { context: 1048576, input: 1048576, output: 131072 },
        cost: { input: 0.1, output: 0.3, cache_read: 0.025 },
        canonical_model_id: 'zhipuai/glm-5.3-flash',
      },
      'openai/gpt-6-astra': {
        id: 'openai/gpt-6-astra',
        name: 'GPT 6 Astra',
        reasoning: true,
        tool_call: true,
        structured_output: true,
        knowledge: '2026-04-30',
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 1050000, input: 1050000, output: 128000 },
        cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
        canonical_model_id: 'openai/gpt-6-astra',
      },
      'deepseek/deepseek-v4-flash': {
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: true,
        tool_call: true,
        structured_output: true,
        knowledge: '2025-05',
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 1048576, input: 1048576, output: 384000 },
        cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
        canonical_model_id: 'deepseek/deepseek-v4-flash',
      },
      'minimax/minimax-m2.5': {
        id: 'minimax/minimax-m2.5',
        name: 'MiniMax M2.5',
        reasoning: true,
        tool_call: true,
        structured_output: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 204800, input: 204800, output: 131072 },
        cost: { input: 0.3, output: 1.2, cache_read: 0.15 },
        canonical_model_id: 'minimax/MiniMax-M2.5',
      },
      /*
       * ⚠️ **诱饵**：`auto-model` 是 nano-gpt 的"自动挑后端"路由别名，**不是模型**。
       * 它与网关的 `group/auto-qfmodel` 只差一个前缀 —— 若不剥 `group/auto-`
       * 就通用地剥 `auto-`，它会变成名为 `model` 的普通条目，
       * 与 `qfmodel` 的相似度升到 0.8000（离 0.85 门槛只差 0.05）。
       */
      'auto-model': {
        id: 'auto-model',
        name: 'Auto model',
        reasoning: false,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 1000000, input: 1000000, output: 1000000 },
        cost: { input: 0, output: 0 },
      },
    },
  },
  /* 真实 provider 上的同名模型（证明组内多数派归并是必要的）。 */
  modelscope: {
    id: 'modelscope',
    name: 'ModelScope',
    models: {
      'kimi-k3': {
        id: 'kimi-k3',
        name: 'Kimi K3',
        reasoning: true,
        modalities: { input: ['text'], output: ['text'] },
        /* 与 nano-gpt 那条的 1048576 不同 —— 组内必须有归并规则。 */
        limit: { context: 262144, output: 262144 },
        cost: { input: 3, output: 15 },
        canonical_model_id: 'moonshotai/kimi-k3',
      },
      'glm-5.3-flash': {
        id: 'glm-5.3-flash',
        name: 'GLM-5.3-Flash',
        reasoning: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 1000000, output: 131072 },
        cost: { input: 0.15, output: 0.5 },
        canonical_model_id: 'zhipuai/glm-5.3-flash',
      },
    },
  },
  /* 官方 provider（用于证明 -free 后缀不会被误剥成不同的东西）。 */
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    models: {
      'ling-3.1-flash-free': {
        id: 'ling-3.1-flash-free',
        name: 'Ling 3.1 Flash Free',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 262144, output: 32768 },
        cost: { input: 0, output: 0, cache_read: 0 },
        canonical_model_id: 'inclusionai/ling-3.1-flash',
      },
    },
  },
};

/** 夹具索引（模块级算一次 —— 解析是纯函数，没有共享可变状态）。 */
const INDEX: ModelsDevIndex = parseModelsDev({
  ...TASK_SNIPPET,
  ...REAL_FIXTURE,
});

/* -------------------------------------------------------------------------- */
/*  解析：三个最容易写错的地方                                                    */
/* -------------------------------------------------------------------------- */

test('★★ `context` / `output` 嵌在 `limit` 里（**不是顶层字段**）', () => {
  /*
   * ## 为什么这条必须单独测
   *
   * 写成 `m.context` 会得到 `undefined` → 走数值默认 0。而 0 在本项目里
   * 恰好是"元数据缺失"的判据（`buildCatalog` 的 `metaOf`）→ **整批模型被降权**。
   * 症状是"全线变慢变笨"，**不报错**，极难定位。
   *
   * 依据是任务给出的真实片段：`"limit": { "context": 200000, "output": 64000 }`。
   */
  const index = parseModelsDev(TASK_SNIPPET);
  const entry = index.byId.get('anthropic/claude-sonnet-4-5');
  assert.ok(entry, 'claude-sonnet-4-5 必须被解析出来');
  assert.equal(entry.contextTokens, 200000, '★ 必须从 limit.context 读到 200000');
  assert.equal(entry.maxOutputTokens, 64000, '★ 必须从 limit.output 读到 64000');
});

test('★★ `cost` 的键是 input/output/cache_read/cache_write', () => {
  /*
   * 真实片段：`"cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }`
   *
   * 写成 `cache` 会拿到 `undefined` → 缓存价静默记成 0，而缓存价是
   * "长上下文反复推理"的主要成本项。单位是 **USD / 每百万 token**。
   */
  const index = parseModelsDev(TASK_SNIPPET);
  const entry = index.byId.get('anthropic/claude-sonnet-4-5');
  assert.deepEqual(
    entry?.cost,
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    '★ cost 的四个键都要读到（缓存价的键名是 cache_read / cache_write）',
  );
});

test('★ `cost` 缺 cache_write 时记 0，**整个 cost 缺失时是 null**', () => {
  /*
   * `null` 与"全 0"绝不能混：
   *   · `null` = 不知道（不该参与"挑便宜的"排序）
   *   · `0` = 免费（**应该**优先用它）
   *
   * 与 `modelDiscovery.parseWireModels` 里 `free: 'unknown'` 是同一条原则：
   * 把"不知道"当成"付费/贵"会让白送的模型被排到最后。
   */
  const index = parseModelsDev({
    p: {
      id: 'p',
      models: {
        'no-cost': { id: 'no-cost', limit: { context: 1000 } },
        'partial': { id: 'partial', cost: { input: 1, output: 2 } },
      },
    },
  });
  assert.equal(index.byId.get('p/no-cost')?.cost, null, '★ 整个 cost 缺失 = null（不知道）');
  assert.deepEqual(
    index.byId.get('p/partial')?.cost,
    { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    '已给出 cost 但缺键 → 那一项记 0（在这个前提下它只能是"没有这一档"）',
  );
});

test('★★ `modalities` 是**对象** `{input, output}`，不是数组', () => {
  /*
   * 真实片段：`"modalities": { "input": ["text","image","pdf"], "output": ["text"] }`
   *
   * 当成数组遍历会得到 `undefined` → 图片能力判定恒为 false →
   * 视觉类任务永远不会被派给支持图片的模型。
   */
  const index = parseModelsDev(TASK_SNIPPET);
  const entry = index.byId.get('anthropic/claude-sonnet-4-5');
  assert.deepEqual(entry?.modalities.input, ['text', 'image', 'pdf'], '★ 输入模态是对象的 input 数组');
  assert.deepEqual(entry?.modalities.output, ['text']);
});

test('★ 解析真实的 `alibaba-cn/deepseek-v4.1-flash`（任务片段里的小数定价）', () => {
  /*
   * 这一条同时验证"小数定价不被取整/丢失" —— 真实值是 0.29754 / 1.19015，
   * 用 `parseInt` 之类会变成 0 / 1，而那样"挑便宜的"排序会失真。
   */
  const index = parseModelsDev(TASK_SNIPPET);
  const entry = index.byId.get('alibaba-cn/deepseek-v4.1-flash');
  assert.equal(entry?.contextTokens, 1000000);
  assert.equal(entry?.maxOutputTokens, 384000);
  assert.equal(entry?.cost?.input, 0.29754, '★ 小数必须原样保留');
  assert.equal(entry?.cost?.cacheRead, 0.01488);
  assert.equal(entry?.toolCall, true);
  assert.equal(entry?.reasoning, true);
});

test('★ 脏数据不会把整份目录变成空（防御性解析）', () => {
  /*
   * 这个项目反复栽在"静默地全线失效"上。一条畸形记录不该让
   * **所有**模型同时失去参数补齐 —— 那正是"目录变空"的后果。
   */
  const index = parseModelsDev({
    good: { id: 'good', models: { m: { id: 'm', limit: { context: 100 } } } },
    broken: null,
    alsoBroken: { id: 'alsoBroken', models: 'not-an-object' },
    weird: { id: 'weird', models: { ok: { id: 'ok', limit: 'not-an-object', cost: 42 } } },
  });
  assert.equal(index.byId.get('good/m')?.contextTokens, 100, '正常记录必须被解析');
  /* `limit` 不是对象时按"缺失"处理，而不是抛错。 */
  assert.equal(index.byId.get('weird/ok')?.contextTokens, 0);
  assert.equal(index.byId.get('weird/ok')?.cost, null);
});

test('★ 顶层不是对象时返回空索引（不抛错）', () => {
  /* 上游回了一个 HTML 错误页 / 数组 / null 时，解析必须是"空"而不是"崩"。 */
  for (const payload of [null, undefined, 'error', 42, []]) {
    const index = parseModelsDev(payload);
    assert.equal(index.byLeafName.size, 0);
  }
});

/* -------------------------------------------------------------------------- */
/*  归一化                                                                      */
/* -------------------------------------------------------------------------- */

test('★★ 归一化：剥 `group/auto-` 前缀、统一分隔符、剥写法后缀', () => {
  /*
   * 规则来自实测：网关用 `group/auto-deepseek-v4-1-flash`（连字符 + 前缀），
   * 而 models.dev 上是 `deepseek-v4.1-flash`（点号 + 无前缀）。
   */
  assert.equal(normalizeGatewayName('group/auto-deepseek-v4-1-flash'), 'deepseek-v4-1-flash');
  assert.equal(normalizeGatewayName('group/auto-deepseek-v4.1-flash'), 'deepseek-v4-1-flash');
  assert.equal(normalizeGatewayName('deepseek-v4.1-flash'), 'deepseek-v4-1-flash');
  assert.equal(normalizeGatewayName('group/auto-ling-3.1-flash-free'), 'ling-3-1-flash');
  assert.equal(normalizeGatewayName('group/auto-deepseek-v4-flash-latest'), 'deepseek-v4-flash');
  assert.equal(normalizeGatewayName('group/auto-kimi-k3-thinking'), 'kimi-k3');
  /* `@region` 后缀（实测 `requesty/deepseek-v4.1-flash@eu`）。 */
  assert.equal(normalizeGatewayName('requesty/deepseek-v4.1-flash@eu'), 'deepseek-v4-1-flash');
  /* 大小写不敏感。 */
  assert.equal(normalizeGatewayName('MiniMax-M2.5'), 'minimax-m2-5');
});

test('★★★ 归一化【只】剥 `group/auto-`，不通用地剥 `auto-`', () => {
  /*
   * ## 这条测试防的是一个"差一点就写错"的实现
   *
   * 若通用地剥 `auto-`：
   * ```
   *   nano-gpt/auto-model  →  model
   *   而 group/auto-qfmodel 归一化后 →  qfmodel
   *   两者相似度 = 0.8000   ← 离 0.85 的门槛只差 0.05
   * ```
   *
   * 虽然 0.80 仍被门槛挡住，但"门槛被谁调松"是无法用测试永远防住的事。
   * 只剥 `group/auto-` 就把这条路彻底封死（0.5333，余量充足）。
   *
   * ⚠️ 顺带说明：`group/auto-*` 在实测里**只是静态别名**（按模型名自动挑供应商，
   * 没有额度感知与故障转移），但在**模型身份**层面它与被指向的模型是同一个 ——
   * 所以剥掉前缀去匹配 models.dev 是正确的。
   */
  assert.equal(normalizeGatewayName('nano-gpt/auto-model'), 'auto-model', '★ 不能变成 model');
  assert.equal(normalizeGatewayName('auto-model'), 'auto-model');
  /* 反向：真正的 group/auto- 前缀必须被剥掉。 */
  assert.equal(normalizeGatewayName('group/auto-model'), 'model', 'group/auto- 仍要剥');
});

test('★ 归一化不剥 `:variant`（那些是同一 provider 上的不同条目）', () => {
  /*
   * 实测 models.dev 里同时存在 `nano-gpt/deepseek/deepseek-v4.1-flash:thinking`
   * 与不带后缀的那条。剥掉 `:thinking` 会让两条**互相覆盖**，
   * 于是"哪个参数是哪个模型"就说不清了。
   */
  assert.equal(normalizeGatewayName('deepseek-v4.1-flash:thinking'), 'deepseek-v4-1-flash:thinking');
});

test('★ 版本号 token 的抽取（`v4.1` / `k3` / 无版本号）', () => {
  assert.deepEqual(versionTokens('deepseek-v4-1-flash'), ['4', '1']);
  assert.deepEqual(versionTokens('deepseek-v4-flash'), ['4']);
  assert.deepEqual(versionTokens('glm-5-3-flash'), ['5', '3']);
  assert.deepEqual(versionTokens('kimi-k3'), ['3'], '★ 单字母+数字也算版本（实测 kimi-k3）');
  assert.deepEqual(versionTokens('minimax-m2-5'), ['2', '5']);
  assert.deepEqual(versionTokens('gpt-6-astra'), ['6']);
  assert.deepEqual(versionTokens('qfmodel'), [], '没有版本号 → 空');
});

/* -------------------------------------------------------------------------- */
/*  4 级阶梯                                                                    */
/* -------------------------------------------------------------------------- */

test('★★ L2 精确匹配（归一化后）—— 最高频的一级', () => {
  const match = matchModel('group/auto-deepseek-v4-1-flash', INDEX);
  assert.ok(match);
  assert.equal(match.source, 'exact');
  assert.equal(match.score, 1);
});

test('★★ L3 canonical 反查：只有 canonical 关系、没有同名条目时也能补', () => {
  /*
   * 构造方式（贴近实测形态）：`grand/x` 的 `canonical_model_id` 指向一个
   * **没有任何 provider 直接提供**的规范名 `canon/spec-model`。
   * 这在实测里真实存在 —— canonical 叶子有 509 个，其中 20 个
   * 在 byLeafName 里查不到（例如 `granite-4-h-micro` / `seed-2-1-pro`）。
   *
   * 此时应走 L3：拿"指向该 canonical 的条目组"的多数派参数。
   */
  const index = parseModelsDev({
    grand: {
      id: 'grand',
      models: {
        x: {
          id: 'x',
          name: 'X',
          limit: { context: 131000, output: 131000 },
          cost: { input: 0.017, output: 0.112 },
          canonical_model_id: 'canon/spec-model',
        },
      },
    },
  });
  const match = matchModel('canon/spec-model', index);
  assert.ok(match, 'canonical 反查必须能命中');
  assert.equal(match.source, 'canonical');
  assert.equal(match.entry.contextTokens, 131000, '★ 拿到的是 canonical 组的参数');
});

test('★★ L3 用**多数派**参数（组内不一致时不能靠遍历顺序）', () => {
  /*
   * 实测：同一个 canonical（如 `zhipuai/glm-5.3-flash`）下有 **99 个条目**，
   * 而它们的 context 有两种（1000000×50 / 1048576×37）。
   *
   * "取第一条"会让结果取决于目录里的**遍历顺序** —— 不可复现。
   * 多数派是这组数据里唯一有意义的估计。
   *
   * ⚠️ 这里同时钉住"平局取较小值"这条规则（`modeNumber`）。
   */
  const index = parseModelsDev({
    a: { id: 'a', models: { m: { id: 'm', limit: { context: 1000 }, canonical_model_id: 'c/spec' } } },
    b: { id: 'b', models: { m: { id: 'm', limit: { context: 2000 }, canonical_model_id: 'c/spec' } } },
    c: { id: 'c', models: { m: { id: 'm', limit: { context: 2000 }, canonical_model_id: 'c/spec' } } },
  });
  const match = matchModel('c/spec', index);
  assert.ok(match);
  /* 2000 出现两次（多数派）→ 必须取 2000，而不是第一条的 1000。 */
  assert.equal(match.entry.contextTokens, 2000, '★ 多数派（2000×2 > 1000×1）');

  /* 平局（1:1）取较小值 —— 长度上限填小是可承受的方向，填大会让输出被截断。 */
  const tie = parseModelsDev({
    a: { id: 'a', models: { m: { id: 'm', limit: { context: 500 }, canonical_model_id: 'c/tie' } } },
    b: { id: 'b', models: { m: { id: 'm', limit: { context: 900 }, canonical_model_id: 'c/tie' } } },
  });
  assert.equal(matchModel('c/tie', tie)?.entry.contextTokens, 500, '★ 平局取较小值（保守方向）');
});

test('★★ L4 模糊匹配：相似度 ≥0.85 且版本号 token 全等', () => {
  /*
   * 实测候选：`deepseek-v4-1-flash-sg`（网关上的区域节点）与
   * `deepseek-v4-1-flash` 的相似度是 **0.9189**，版本 token 都是 `[4,1]` → 过 L4。
   *
   * ⚠️ 过了 L4 **不代表**参数可以全信 —— 见下面"fuzzy 只补参考字段"那条测试。
   */
  const match = matchModel('group/auto-deepseek-v4-1-flash-sg', INDEX);
  assert.ok(match, 'L4 应该命中（实测相似度 0.9189）');
  assert.equal(match.source, 'fuzzy');
  assert.ok(match.score >= FUZZY_MIN_SIMILARITY, `相似度 ${match.score} 应 ≥ ${FUZZY_MIN_SIMILARITY}`);
  assert.ok(match.score < 1, '模糊匹配的分数必须严格小于 1（用来区分置信度）');
});

test('★★ L4 必须挡住"版本号不同"的候选（哪怕相似度很高）', () => {
  /*
   * 版本号 token 全等是 L4 的硬前提 —— 它挡掉的是"`v4.1` 匹配到 `v5`"这类
   * 最荒谬的错。相似度对"数字差一位"并不敏感，光靠 0.85 拦不住。
   */
  const index = parseModelsDev({
    p: { id: 'p', models: { 'model-v5': { id: 'model-v5', limit: { context: 100 } } } },
  });
  /* `model-v4` 与 `model-v5` 的字符串相似度很高，但版本 token 不同。 */
  assert.equal(matchModel('p/model-v4', index), null, '★ 版本号不同必须 unknown');
  /* 对照组：完全同名时正常命中。 */
  assert.ok(matchModel('p/model-v5', index), '同名仍然要命中（否则上面那条就没意义）');
});

test('★★ L4 平局取字典序最小的键（同一输入必须永远同一结果）', () => {
  /*
   * 目录每天重新拉，**遍历顺序不该影响匹配结果**。
   * 两个候选同分时若任由 `Map` 的插入顺序决定，同一天的不同次刷新可能给出
   * 不同参数 —— 那种"偶尔变一下"的行为在排查时是最难的一类。
   *
   * ## 夹具是**构造**的（不是实测数据），这里说明为什么
   *
   * 要让两个候选**同分且都过门槛**，需要它们与查询名的编辑距离相同 ——
   * 实测目录里很难凑出这种巧合。所以用一对对称的名字：
   *
   * ```
   *   查询   model-v4-flash           （不在索引里 → 走 L4）
   *   候选 A a-model-v4-flash  context=111
   *   候选 B b-model-v4-flash  context=222
   * ```
   *
   * 两者与查询的非共享 bigram 都只有一个（`a-` / `b-`），
   * 所以相似度**精确相等**（0.9286），版本 token 也都是 `['4']`。
   * 字典序最小的是 A → 必须选中 A 的参数。
   */
  const index = parseModelsDev({
    p: {
      id: 'p',
      models: {
        'a-model-v4-flash': { id: 'a-model-v4-flash', limit: { context: 111 } },
        'b-model-v4-flash': { id: 'b-model-v4-flash', limit: { context: 222 } },
      },
    },
  });

  const first = matchModel('p/model-v4-flash', index);
  assert.ok(first, '两个候选都该过 L4 门槛');
  assert.equal(first.source, 'fuzzy');
  assert.equal(first.entry.contextTokens, 111, '★ 平局取字典序最小的键（a- 在 b- 之前）');

  /* 反复调用结果必须完全一致（确定性）。 */
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(matchModel('p/model-v4-flash', index), first, '同一输入必须给同一结果');
  }

  /* 把索引里的插入顺序颠倒 —— 结果**不该**因此改变。 */
  const reversed = parseModelsDev({
    p: {
      id: 'p',
      models: {
        'b-model-v4-flash': { id: 'b-model-v4-flash', limit: { context: 222 } },
        'a-model-v4-flash': { id: 'a-model-v4-flash', limit: { context: 111 } },
      },
    },
  });
  assert.equal(
    matchModel('p/model-v4-flash', reversed)?.entry.contextTokens,
    111,
    '★ 插入顺序不该改变匹配结果',
  );
});

/* -------------------------------------------------------------------------- */
/*  ⚠️ 核心安全边界：对不上必须 unknown                                          */
/* -------------------------------------------------------------------------- */

test('★★★ `group/auto-qfmodel` 必须 unknown（实测：最近候选是纯噪声）', () => {
  /*
   * ## 这条测试为什么是整个任务里最重要的一条
   *
   * 实测（2026-10-14，全量 229 provider / 8831 模型）：
   * ```
   *   含 "qfmodel" 的条目 = 0
   *   最近候选 `model`       相似度 0.8000（未剥 group/auto- 时）
   *   最近候选 `auto-model`  相似度 0.5333（剥了之后）
   * ```
   *
   * `qfmodel` 是**网关的路由聚合别名**（按名字自动挑供应商），不是模型。
   * 若照单全收，会给它填上 `nano-gpt/auto-model` 的
   * **1,000,000 上下文 + 0 定价** —— 风控模型拿到荒谬的窗口。
   *
   * **对不上就 unknown，这比填错安全得多。**
   */
  assert.equal(matchModel('group/auto-qfmodel', INDEX), null, '★ 必须 unknown');
});

test('★★★ 陌生名字一律 unknown（不做低分模糊匹配的自动写入）', () => {
  /*
   * 这一条把"宁缺毋滥"钉成**行为**而不是注释。四个真实形态：
   *   · 网关自造名（`qfmodel` 类路由别名）
   *   · 完全陌生的名字
   *   · 名字太短没有信息量（`x/y`）
   *   · 相似但版本号不同（上面单独测过）
   */
  for (const name of [
    'group/auto-qfmodel',
    'group/auto-totally-made-up-router',
    'provider/unknown-model-xyz',
    'x/y',
    'some/random',
  ]) {
    assert.equal(matchModel(name, INDEX), null, `★ "${name}" 必须 unknown（不写任何参数）`);
  }
});

test('★ 空索引 / 空名字时必须返回 null（不能崩）', () => {
  assert.equal(matchModel('group/auto-deepseek-v4-1-flash', parseModelsDev(null)), null, '没有数据 → unknown');
  assert.equal(matchModel('', INDEX), null);
  /* 只由分隔符组成的名字归一化后为空 → unknown（而不是拿空串去查表）。 */
  assert.equal(matchModel('group/auto-', INDEX), null);
});

/* -------------------------------------------------------------------------- */
/*  ★ 实测命中率：7 个线上真名                                                   */
/* -------------------------------------------------------------------------- */

test('★★★ 7 个线上网关真名必须命中；qfmodel 必须 unknown（命中率 ≥7/8）', () => {
  /*
   * ## 这 8 个名字是线上网关的真实存在（2026-10-14 调研实测）
   *
   * 这是本任务最初的验收标准。⚠️ 注意其中一个**陷阱**：
   * models.dev 的官方 `deepseek` provider **只有 4 个模型**，
   * **没有 `deepseek-v4.1-flash`**（它只在 `alibaba-token-plan` / `nano-gpt` /
   * `alibaba-cn` 之类）。所以匹配**必须跨全部 provider 查**。
   *
   * 本测试的夹具里**故意只放了一个官方 deepseek 模型**，因此
   * `group/auto-deepseek-v4-1-flash` 若无跨 provider 查询就会失败 ——
   * 这正是"只查官方 provider"那个坑的回归钉。
   */
  const shouldHit = [
    'group/auto-deepseek-v4-1-flash',
    'workbuddy-ai/kimi-k3',
    'group/auto-glm-5.3-flash',
    'group/auto-gpt-6-astra',
    'group/auto-ling-3.1-flash-free',
    'group/auto-deepseek-v4-flash',
    'group/auto-minimax-m2.5',
  ];
  const shouldMiss = ['group/auto-qfmodel'];

  const hits: string[] = [];
  const misses: string[] = [];
  for (const name of shouldHit) {
    const match = matchModel(name, INDEX);
    if (match) hits.push(`${name} → ${match.source}`);
    else misses.push(name);
  }

  /*
   * 断言 1：7 个真名**全部**命中（≥7/7）。实测在**真实全量目录**上也是 7/7，
   * 且全部落在 L2 精确匹配 —— 连 L3/L4 都不需要。
   */
  assert.equal(misses.length, 0, `★ 这些真名没命中：${misses.join(', ')}（命中：${hits.join(' | ')}）`);
  assert.ok(hits.length >= 7, `★ 命中率必须 ≥7/8，实际 ${hits.length}/8`);

  /*
   * 断言 2：`qfmodel` 必须落在 unknown 一侧。
   * "命中率 ≥7/8" 与 "这一条必须不命中" 合起来才是完整的验收条件 ——
   * 只看命中率会奖励"什么都往回填"的实现，而那正是要防的。
   */
  for (const name of shouldMiss) {
    assert.equal(matchModel(name, INDEX), null, `★ ${name} 必须不命中`);
  }
});

test('★ 跨 provider 查询：官方 deepseek provider 里没有 v4.1-flash', () => {
  /*
   * 把上面那段"陷阱"单独钉一条 —— 它是**数据事实**，值得独立断言：
   * 官方 `deepseek` provider 只有 4 个模型，`deepseek-v4.1-flash` 不在其中。
   *
   * 所以任何"只查官方 provider"的实现都会漏掉它，
   * 而它恰恰是线上最常用的模型之一（`group/auto-deepseek-v4-1-flash`）。
   */
  const deepseekEntries = [...INDEX.byLeafName.entries()]
    .flatMap(([, list]) => list)
    .filter((e) => e.provider === 'deepseek');
  assert.ok(deepseekEntries.length > 0, '夹具里应有官方 deepseek 的模型');
  assert.ok(
    !deepseekEntries.some((e) => normalizeGatewayName(e.id) === 'deepseek-v4-1-flash'),
    '★ 官方 deepseek provider 里确实没有 v4.1-flash（这正是必须跨 provider 查的理由）',
  );

  /* 但它仍然要能匹配到 —— 从别的 provider 那里。 */
  const match = matchModel('group/auto-deepseek-v4-1-flash', INDEX);
  assert.ok(match, '★ 必须跨全部 provider 查到它');
});

/* -------------------------------------------------------------------------- */
/*  ★ 覆盖顺序：models.dev 绝不覆盖运行时实测值                                   */
/* -------------------------------------------------------------------------- */

/** 造一条 `/v1/models` 记录（字段与实测一致）。 */
function wireModel(overrides: Record<string, unknown> = {}): DiscoveredModel {
  return parseWireModels({
    data: [
      {
        id: 'group/auto-deepseek-v4-1-flash',
        display_name: 'x',
        owned_by: 'group',
        context_length: 512_000,
        max_output_tokens: 16_000,
        reasoning: true,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
        modalities: { input: ['text'] },
        ...overrides,
      },
    ],
  })[0]!;
}

/** 一个"什么都给"的 models.dev 查询桩（数值故意与运行时值**不同**）。 */
function lookupStub(): (id: string) => ReturnType<typeof matchModel> {
  const index = parseModelsDev({
    p: {
      id: 'p',
      models: {
        'deepseek-v4.1-flash': {
          id: 'deepseek-v4.1-flash',
          name: 'D',
          reasoning: true,
          tool_call: true,
          structured_output: true,
          knowledge: '2025-05',
          limit: { context: 1_000_000, output: 384_000 },
          cost: { input: 0.3, output: 1.2, cache_read: 0.03, cache_write: 0 },
          canonical_model_id: 'deepseek/deepseek-v4.1-flash',
        },
      },
    },
  });
  return (id: string) => matchModel(id, index);
}

test('★★★ models.dev 【不覆盖】 `/v1/models` 已给出的实测值', () => {
  /*
   * ## 优先级（不可覆盖）
   *
   * ```
   *   运行时 /v1/models 实测  >  人工 MODEL_PROFILES  >  models.dev 补齐  >  保守默认
   * ```
   *
   * ## 为什么这一条是硬约束（不是"更好的做法"）
   *
   * `/v1/models` 反映的是**我们自己的网关此刻**的能力，models.dev 是**上游目录**。
   * 网关可能做了上下文截断、代理了另一个版本、或干脆换了模型。
   *
   * 实测代价就在 `modelDiscovery.ts` 里记着：`opencode-go/omen-alpha` 在网关的
   * `/v1/models` 里**既没有 context 也没有 max_output** —— 如果我们反过来
   * 用上游值去"修正"网关，就会给一个**网关侧没有申报预算能力**的模型算出安全预算，
   * 而那次实测的结局是 `finish_reason=length` + 空内容 + **一个角色 242 秒**。
   *
   * 本用例的桩故意给出**与运行时不同**的值（1,000,000 vs 512,000），
   * 所以"覆盖了"与"没覆盖"是**可区分**的 —— 若两边给同一个数，这条测试就没意义。
   */
  const wire = wireModel();
  const merged = mergeDiscovered([wire], new Map(), lookupStub());
  const m = merged[0]!;

  assert.equal(m.contextTokens, 512_000, '★ 运行时实测的 512000 必须保留，不能被上游的 1000000 覆盖');
  assert.equal(m.maxOutputTokens, 16_000, '★ 运行时实测的 16000 必须保留');
  assert.equal(m.reasoning, true, '运行时说它支持思维链，保持');

  /* 而运行时**没有**的字段应当被补上。 */
  assert.equal(m.knowledge, '2025-05', '知识截止（运行时拿不到）应当补上');
  assert.equal(m.toolCall, true, 'tool_call（运行时拿不到）应当补上');
  assert.equal(m.structuredOutput, true);
  assert.equal(m.canonicalId, 'deepseek/deepseek-v4.1-flash');
  assert.deepEqual(m.cost, { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 }, '定价应当补上');
  assert.equal(m.profileSource, 'modelsdev', '补上了东西 → 来源标记为 modelsdev');
});

test('★ 运行时值缺失（0）时才允许 models.dev 补长度上限', () => {
  /*
   * 实测形态：网关对某些模型**不报** context / max_output（`context=- maxOut=-`）。
   * 那种情况下用上游目录补上是**净收益** —— 但仍要标 `modelsdev` 让人知道
   * 这个数字的来源不是网关实测。
   */
  const wire = wireModel({ context_length: 0, max_output_tokens: 0 });
  const m = mergeDiscovered([wire], new Map(), lookupStub())[0]!;
  assert.equal(m.contextTokens, 1_000_000, '网关没报 → 用上游补');
  assert.equal(m.maxOutputTokens, 384_000);
  assert.equal(m.profileSource, 'modelsdev');
});

test('★ 没有 models.dev 时行为完全不变（离线 / 拉取失败时的路径）', () => {
  /*
   * 这一条是**向后兼容的回归钉**：`modelsDev` 是可选参数，
   * 不传它时 `mergeDiscovered` 的行为必须与接入前**逐字一致**。
   * 离线部署、快照还没建、拉取失败 —— 都会走这条路径。
   */
  const wire = wireModel();
  const withoutSource = mergeDiscovered([wire], new Map());
  const withNull = mergeDiscovered([wire], new Map(), null);

  assert.equal(withoutSource[0]!.contextTokens, 512_000);
  assert.equal(withoutSource[0]!.knowledge, undefined, '没有来源时不补任何 models.dev 字段');
  assert.equal(withoutSource[0]!.cost, undefined);
  assert.equal(withoutSource[0]!.profileSource, 'runtime', '来源仍是运行时');
  assert.deepEqual(withNull, withoutSource, '传 null 与不传必须等价');
});

test('★★ `fuzzy`（模糊匹配）只补参考字段，**不补长度上限**', () => {
  /*
   * ## 为什么模糊匹配不能补长度上限
   *
   * 实测：`deepseek-v4.1-flash` 与 `deepseek-v4.1-flash-sg` 的相似度是 **0.9189**
   *（过 0.85 门槛），而它们是**不同资源** —— 网关上 `-sg` 是独立成员，
   * 有独立额度（`free=false, rate=0.03`，而主模型 `free=true`）。
   *
   * 相似度能认出"同一家族的写法变体"，**认不出"是不是同一个部署"**。
   * 而长度上限填错的后果是实打实的（预算算错 → 输出被截断）：
   *
   * | 字段 | fuzzy 能否补 | 为什么 |
   * |---|---|---|
   * | cost / knowledge / toolCall / … | **能** | 参考信息；错了只是调度加权偏一点 |
   * | contextTokens / maxOutputTokens | **不能** | 直接决定输出预算 |
   *
   * 留 0 会让它走"元数据缺失 → 降权"那条**已知且安全**的路径。
   */
  /* 网关上的区域节点：自己没报长度上限。 */
  const wire = parseWireModels({
    data: [{ id: 'group/auto-deepseek-v4-1-flash-sg', owned_by: 'group', context_length: 0, max_output_tokens: 0 }],
  })[0]!;
  const merged = mergeDiscovered([wire], new Map(), lookupStub());
  const m = merged[0]!;

  assert.equal(m.contextTokens, 0, '★ 模糊匹配**不得**补上下文上限');
  assert.equal(m.maxOutputTokens, 0, '★ 模糊匹配**不得**补输出上限');
  /* 但参考字段可以补 —— 它们不会让输出被截断。 */
  assert.equal(m.knowledge, '2025-05', '知识截止可以补（参考信息）');
  assert.deepEqual(m.cost, { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 }, '定价可以补');
});

test('★ 对不上时绝不写入任何参数（unknown 路径）', () => {
  /*
   * `qfmodel` 走完 4 级都不命中 → 一个新字段都不该出现。
   * 这一条与上面"必须 unknown"配对：前者测匹配层，这里测**合并层**。
   */
  const wire = parseWireModels({
    data: [{ id: 'group/auto-qfmodel', owned_by: 'group', context_length: 0, max_output_tokens: 0 }],
  })[0]!;
  const merged = mergeDiscovered([wire], new Map(), lookupStub());
  const m = merged[0]!;

  assert.equal(m.contextTokens, 0, '★ 不写参数 → 上下文仍是"不知道"');
  assert.equal(m.cost, undefined, '★ 不写参数 → 定价必须保持 undefined');
  assert.equal(m.knowledge, undefined);
  assert.equal(m.toolCall, undefined);
  assert.equal(m.canonicalId, undefined);
  assert.equal(m.profileSource, 'runtime', '一个字段都没补 → 来源不该变成 modelsdev');
});

test('★ 补了 models.dev 之后仍然能正确分档与排序（端到端）', () => {
  /*
   * 接入第三个数据源**不该改变分档口径**（T1/T2/T3 是本项目的业务判断，
   * models.dev 不提供）—— 这条测的是"补齐参数后分档逻辑不受影响"。
   */
  const wire = parseWireModels({
    data: [
      {
        id: 'group/auto-deepseek-v4-1-flash',
        owned_by: 'group',
        context_length: 512_000,
        max_output_tokens: 16_000,
        reasoning: true,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      },
    ],
  });
  const merged = mergeDiscovered(wire, new Map(), lookupStub());
  assert.equal(merged[0]!.reasoning, true, '推理标记来自运行时，未被上游改掉');
  /* 思维链 + 2 档 → T2（不是 T3，因为思考档位 < 4）。 */
  assert.equal(merged[0]!.knowledge, '2025-05');
});

/* -------------------------------------------------------------------------- */
/*  网络：条件请求（304）                                                        */
/* -------------------------------------------------------------------------- */

/** 造一个可编程的 `fetch` 桩。 */
function fetchStub(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init ?? {})) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

test('★★ `fetchModelsDev` 带 `If-None-Match`，304 返回 `notModified`', async () => {
  /*
   * 实测（2026-10-14）：`https://models.dev/api.json` 的响应带 `ETag: W/"..."`，
   * 带上 `If-None-Match` 时返回 **304 Not Modified**。
   *
   * 为什么必须用它：这份目录 **5,634,155 字节**，而刷新要长期跑 ——
   * 无条件请求就是每天白拉 5.6MB。条件请求把"没有变化"的代价降到响应头。
   */
  let seenEtag: string | null = null;
  const result = await fetchModelsDev({
    etag: 'W/"abc123"',
    fetchImpl: fetchStub((_url, init) => {
      const headers = new Headers(init.headers as Record<string, string>);
      seenEtag = headers.get('if-none-match');
      return new Response(null, { status: 304 });
    }),
  });

  assert.equal(seenEtag, 'W/"abc123"', '★ 必须把 ETag 作为 If-None-Match 发出去');
  assert.deepEqual(result, { notModified: true }, '★ 304 → notModified（**不带 payload**）');
});

test('★ 没有 ETag 时不发 `If-None-Match`（首次拉取）', async () => {
  let hasHeader = false;
  await fetchModelsDev({
    fetchImpl: fetchStub((_url, init) => {
      hasHeader = new Headers(init.headers as Record<string, string>).has('if-none-match');
      return jsonResponse({ p: { id: 'p', models: {} } });
    }),
  });
  assert.equal(hasHeader, false, '首次拉取不该带条件头');
});

test('★ 200 时返回 payload 与**新的** ETag（下次要用它）', async () => {
  const payload = { p: { id: 'p', models: { m: { id: 'm', limit: { context: 7 } } } } };
  const result = await fetchModelsDev({
    fetchImpl: fetchStub(() => jsonResponse(payload, 200, { etag: 'W/"new"' })),
    now: () => 1_700_000_000_000,
  });
  assert.equal(result.notModified, false);
  if (result.notModified) return; /* 类型收窄。 */
  assert.deepEqual(result.payload, payload);
  assert.equal(result.etag, 'W/"new"');
  assert.equal(result.fetchedAt, 1_700_000_000_000, '拉取时刻用注入的时钟（可测）');
});

test('★ HTTP 非 2xx 时抛错（调用方据此保留旧快照）', async () => {
  await assert.rejects(
    () => fetchModelsDev({ fetchImpl: fetchStub(() => new Response('nope', { status: 503 })) }),
    /503/,
    '★ 5xx 必须抛错，而不是返回一个"空目录"',
  );
});

/* -------------------------------------------------------------------------- */
/*  快照：原子替换 / 失败保留旧快照                                               */
/* -------------------------------------------------------------------------- */

/** 建一个临时数据目录（模式照抄 `autoTrader.test.ts`，不碰真实 `data/`）。 */
function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'aq-modelsdev-'));
}

test('★★ 快照写入是**原子替换**（先写临时文件再 rename）', () => {
  /*
   * ## 为什么不能直接 `writeFileSync` 覆写
   *
   * 这个进程是 7×24 常驻的，刷新时别处正在读它。直接覆写的坏窗口很具体：
   * ```
   *   打开文件 → 截断为 0 → 分块写入 5.6MB（几十毫秒）
   *                       ↑ 这期间读到的是【半个 JSON】
   * ```
   * 表现是 `JSON.parse` 抛错 → `readSnapshot` 返回 null →
   * **旧的可用快照被当成不存在**。
   *
   * `rename` 在同一文件系统内是原子的：读者要么看到完整的旧文件、
   * 要么看到完整的新文件，**没有中间态**。
   */
  const dir = tempDir();
  try {
    const first = { version: 1 as const, etag: 'W/"1"', fetchedAt: 1, payload: { a: 1 } };
    writeSnapshotAtomic(dir, first);
    assert.deepEqual(readSnapshot(dir), first, '第一次写入要能读回来');

    /* 覆盖第二次 —— 原子替换后内容必须是**完整的新内容**。 */
    const second = { version: 1 as const, etag: 'W/"2"', fetchedAt: 2, payload: { b: 2 } };
    writeSnapshotAtomic(dir, second);
    assert.deepEqual(readSnapshot(dir), second, '★ 覆盖后必须是完整的新快照');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 原子写入不留下临时文件', () => {
  const dir = tempDir();
  try {
    writeSnapshotAtomic(dir, { version: 1, etag: null, fetchedAt: 1, payload: {} });
    const dirPath = path.dirname(snapshotPath(dir));
    const files = readdirSync(dirPath);
    assert.deepEqual(files, ['snapshot.json'], `★ 不该有残留临时文件，实际：${files.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 快照坏掉时 `readSnapshot` 返回 null（不抛错）', () => {
  /*
   * 快照是**缓存**，不是数据源。一个坏掉的缓存文件不该把进程启动流程打断 ——
   * 它只意味着"需要重新拉一次"。
   */
  const dir = tempDir();
  try {
    const file = snapshotPath(dir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ not json', 'utf8');
    assert.equal(readSnapshot(dir), null, '★ 坏 JSON → null');

    writeFileSync(file, JSON.stringify({ version: 99, payload: {} }), 'utf8');
    assert.equal(readSnapshot(dir), null, '★ 版本不认识 → null');

    writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8');
    assert.equal(readSnapshot(dir), null, '★ 缺 payload → null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 没有快照文件时返回 null', () => {
  const dir = tempDir();
  try {
    assert.equal(readSnapshot(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/*  Store：304 / 失败保留旧快照 / 原子替换                                        */
/* -------------------------------------------------------------------------- */

test('★★★ 304 时**不碰**磁盘快照，内存索引保持可用', async () => {
  /*
   * ## 为什么这条必须存在
   *
   * 304 的意思是"本地那份还是最新的"。若代码把它当成"响应里没有 payload"
   * 而走 `parseModelsDev(undefined)` → 空索引 → 再写快照，
   * 那份**可用的快照就被清空了**，而且**不会报错**。
   *
   * 这是本次接入里最危险的一个分支 —— 因为它只在"目录没变化"时触发，
   * 也就是**绝大多数时候**。
   */
  const dir = tempDir();
  try {
    const payload = { p: { id: 'p', models: { m: { id: 'm', limit: { context: 123 } } } } };
    const store = new ModelsDevStore({
      dataDir: dir,
      fetchImpl: fetchStub(() => jsonResponse(payload, 200, { etag: 'W/"v1"' })),
    });

    /* 第一次：拉到新数据，写快照。 */
    const first = await store.refresh();
    assert.equal(first.status, 'updated');
    assert.equal(store.match('p/m')?.entry.contextTokens, 123);

    /* 第二次：服务端说没变（304）。 */
    const store304 = new ModelsDevStore({
      dataDir: dir,
      fetchImpl: fetchStub(() => new Response(null, { status: 304 })),
    });
    store304.load();
    const second = await store304.refresh();

    assert.equal(second.status, 'not_modified', '★ 304 必须报 not_modified（不是 failed）');
    /* 关键：索引仍然可用，快照仍然在。 */
    assert.equal(store304.match('p/m')?.entry.contextTokens, 123, '★ 304 之后索引必须仍然可用');
    assert.notEqual(readSnapshot(dir), null, '★ 304 绝不能清掉快照');

    /* 快照内容未被改写（fetchedAt 仍是第一次的那个）。 */
    assert.equal(readSnapshot(dir)?.fetchedAt, first.fetchedAt, '★ 304 不该更新 fetchedAt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★★ 拉取失败时**保留旧快照**（绝不清空）', async () => {
  /*
   * ## 这条防的是什么
   *
   * 一次网络抖动 / 一次 5xx / 一次中途断线，都不该让系统退化成
   * "**没有任何模型参数**"。而"失败就把缓存清掉"是最容易写出的实现
   *（`catch { writeFileSync(file, '{}') }` 之类）。
   *
   * 所以这条断言有两半：**索引仍可用** + **磁盘快照还在**。
   */
  const dir = tempDir();
  try {
    const payload = { p: { id: 'p', models: { m: { id: 'm', limit: { context: 456 } } } } };
    const ok = new ModelsDevStore({
      dataDir: dir,
      fetchImpl: fetchStub(() => jsonResponse(payload, 200, { etag: 'W/"good"' })),
    });
    await ok.refresh();
    const goodSnapshot = readSnapshot(dir);
    assert.notEqual(goodSnapshot, null);

    /* 换一个"总是失败"的 store，指向同一个数据目录。 */
    const failing = new ModelsDevStore({
      dataDir: dir,
      fetchImpl: fetchStub(() => {
        throw new Error('网络断了');
      }),
    });
    failing.load();
    const outcome = await failing.refresh();

    assert.equal(outcome.status, 'failed');
    assert.ok(outcome.error && outcome.error.length > 0, '失败必须带原因（给日志用）');
    assert.equal(failing.match('p/m')?.entry.contextTokens, 456, '★ 旧索引必须仍然可用');
    assert.deepEqual(readSnapshot(dir), goodSnapshot, '★ 磁盘快照必须逐字保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 拿到"解析后为空"的响应时也保留旧快照（不覆盖好数据）', async () => {
  /*
   * 一种比网络失败更阴的失败：HTTP 200，但结构完全变了
   *（例如上游换了 API 形状，返回 `{"data": [...]}` 而不是 `{provider: {...}}`）。
   *
   * 那种响应**解析成功**（`parseModelsDev` 不抛错，只是返回空索引），
   * 所以"只判断有没有抛错"的实现会拿它把好快照覆盖掉。
   * 判据必须是"**解析后是否有内容**"。
   */
  const dir = tempDir();
  try {
    const good = new ModelsDevStore({
      dataDir: dir,
      fetchImpl: fetchStub(() =>
        jsonResponse({ p: { id: 'p', models: { m: { id: 'm', limit: { context: 789 } } } } }, 200, { etag: 'W/"a"' }),
      ),
    });
    await good.refresh();
    const before = readSnapshot(dir);

    const weird = new ModelsDevStore({
      dataDir: dir,
      /* HTTP 200，但形状完全不同（像换了一套 API）。 */
      fetchImpl: fetchStub(() => jsonResponse({ data: [], object: 'list' }, 200, { etag: 'W/"b"' })),
    });
    weird.load();
    const outcome = await weird.refresh();

    assert.equal(outcome.status, 'failed', '★ 解析为空必须算失败，而不是"更新成功"');
    assert.deepEqual(readSnapshot(dir), before, '★ 好快照必须被保住');
    assert.equal(weird.match('p/m')?.entry.contextTokens, 789, '旧索引仍然可用');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 快照写入与内存索引保持一致（落盘成功后才换内存）', async () => {
  /*
   * 两处不一致会带来一个很难查的现象：重启后参数变了。
   * 所以顺序是**先落盘、再换内存** —— 落盘失败就不该有"内存里是新的"。
   */
  const dir = tempDir();
  try {
    const store = new ModelsDevStore({
      dataDir: dir,
      fetchImpl: fetchStub(() =>
        jsonResponse(
          { p: { id: 'p', models: { m: { id: 'm', limit: { context: 321 }, cost: { input: 1, output: 2 } } } } },
          200,
          { etag: 'W/"x"' },
        ),
      ),
    });
    await store.refresh();
    const snapshot = readSnapshot(dir);
    assert.notEqual(snapshot, null);
    assert.equal(store.currentEtag(), 'W/"x"', 'ETag 要与快照里的一致');
    assert.equal(snapshot?.etag, 'W/"x"');

    /* 重新装载（模拟进程重启）→ 参数必须与刷新后一致。 */
    const reloaded = new ModelsDevStore({ dataDir: dir });
    const index = reloaded.load();
    assert.notEqual(index, null, '★ 重启后必须能装载快照');
    assert.equal(reloaded.match('p/m')?.entry.contextTokens, 321, '★ 重启后参数不变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 没有快照时 `load()` 返回 null，`match()` 也返回 null（离线可用）', () => {
  /*
   * 离线部署 / 首次启动还没拉过 —— 这是**完全可用**的状态：
   * `match` 一律 null，于是 `mergeDiscovered` 一个字段都不补（走保守默认）。
   */
  const dir = tempDir();
  try {
    const store = new ModelsDevStore({ dataDir: dir });
    assert.equal(store.load(), null);
    assert.equal(store.current(), null);
    assert.equal(store.match('group/auto-deepseek-v4-1-flash'), null, '★ 没有数据 → unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 刷新循环：`unref()` 且启动时立即跑一次', async () => {
  /*
   * 风格照抄 `manager.startSelfCheckLoop`（不新造一套）：
   *
   * - **`unref()`**：这个定时器是**可丢弃的** —— 丢掉只是少刷新一次目录，
   *   不是丢数据。绝不能因为它把进程吊在退出前。
   * - **启动时立即跑一次**：`setInterval` 要等一整个间隔才首次触发，
   *   而"刚部署完"恰恰是最该确认数据新鲜的时刻
   *  （`staleOrderSettle.test.ts` 记录过这个坑：等了 30 分钟什么都没发生）。
   */
  const dir = tempDir();
  try {
    let calls = 0;
    const store = new ModelsDevStore({
      dataDir: dir,
      fetchImpl: fetchStub(() => {
        calls += 1;
        return jsonResponse({ p: { id: 'p', models: { m: { id: 'm', limit: { context: 1 } } } } });
      }),
    });
    store.startRefreshLoop(24);
    /* 等一次微任务，让"启动时立即跑一次"的那个 promise 落地。 */
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1, '★ 启动时必须立即刷一次（不等一整个间隔）');
    store.stopRefreshLoop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 重入守卫：并发刷新只打一次网络', async () => {
  /*
   * 与 `AutoTrader.cycleInFlight` 同一个理由：定时刷新与手动刷新可能撞上，
   * 而两个并发的 5.6MB 下载 + 两次 rename 完全是浪费。
   */
  const dir = tempDir();
  try {
    let calls = 0;
    const store = new ModelsDevStore({
      dataDir: dir,
      fetchImpl: fetchStub(() => {
        calls += 1;
        return jsonResponse({ p: { id: 'p', models: { m: { id: 'm', limit: { context: 1 } } } } });
      }),
    });
    /* 同时发起三次。 */
    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    assert.equal(calls, 1, '★ 并发刷新只应打一次网络');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
