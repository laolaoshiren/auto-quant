/**
 * **models.dev —— 模型档案的第三个数据源**（2026-10-14）。
 *
 * ## 为什么需要它（前两个数据源各自缺什么）
 *
 * 见 `modelDiscovery.ts` 文件头那张表。一句话复述：
 *
 * ```
 *   GET /v1/models          有 context / max_output / reasoning / 思考等级
 *                           ✗ 没有 cost，✗ 没有知识截止，✗ 没有 tool_call
 *   plugin-providers.json   有 free / rate / released / fast
 *                           ✗ 是网关自己的配置，模型一换就与上游脱节
 * ```
 *
 * 用户要的是「**自动发现、自动调研判断、自动应用**」，所以还需要一个
 * **上游的、客观的、持续更新的**参数来源。models.dev 就是它。
 *
 * ## 实测事实（2026-10-14 实际拉取确认，不是凭记忆）
 *
 * | 项 | 实测值 |
 * |---|---|
 * | 端点 | `https://models.dev/api.json` |
 * | 大小 | 5,634,155 字节（gzip 后约 0.54MB） |
 * | 条件请求 | 响应带 `ETag: W/"..."`，带 `If-None-Match` 实测返回 **304** |
 * | 规模 | 229 个 provider / 8,831 个模型 |
 * | 许可 | MIT（`docs/LEGAL.md` §1b 有完整声明） |
 *
 * ## ⚠️⚠️ 三个最容易写错的地方（实测纠正，宁可写在这里也不靠记忆）
 *
 * ### ① `context` / `output` **不在顶层**，嵌在 `limit` 里
 *
 * ```
 *   ✗ m.context         ✅ m.limit.context
 *   ✗ m.output          ✅ m.limit.output
 * ```
 *
 * 读错的后果很隐蔽：`m.context` 恒为 `undefined` → 走数值默认值 0 →
 * **所有模型都变成"没有上下文窗口"**，而 0 在 `buildCatalog` 里恰好是
 * "元数据缺失"的判据 → 整批模型被降权到最后。**不报错，只是全线变差。**
 *
 * ### ② `cost` 的键是 `input` / `output` / `cache_read` / `cache_write`
 *
 * 写 `cache` 会拿到 `undefined`，于是缓存价被静默记成 0。
 *
 * ### ③ `modalities` 是**对象** `{input, output}`，不是数组
 *
 * 当成数组遍历会得到 `undefined`，图片能力判定恒为 false。
 *
 * 单位：`cost` 是 **USD / 每百万 token**。
 *
 * ## 名字匹配：4 级阶梯 + 一道硬闸门
 *
 * ```
 *   ⛔ 已知无法归一（qfmodel 等）        → unknown（不写任何参数）
 *   L1 人工别名表 modelsDevAlias.ts      → 'alias'
 *   L2 归一化 + 精确匹配                 → 'exact'
 *   L3 canonical 反查（多数派参数）       → 'canonical'
 *   L4 相似度 ≥0.85 且版本号 token 全等   → 'fuzzy'（低置信）
 *   ↓ 全部失败
 *   unknown → 不写任何参数
 * ```
 *
 * ### ⚠️ 为什么必须容忍"查不到"（这是设计，不是退让）
 *
 * 网关真实存在的 `group/auto-qfmodel` 是 **magpie 的路由聚合别名**，不是模型。
 * 实测：models.dev 全量 8,831 个模型里含 `qfmodel` 的条目数为 **0**，
 * 而相似度算法给出的最近候选是 `auto-model`（0.5333）—— 若不剥 `group/auto-`
 * 前缀则更糟：`model`（0.8000）。**两个候选都是纯噪声。**
 *
 * 如果代码照单全收，会给它填上 `nano-gpt/auto-model` 的
 * **1,000,000 上下文窗口与 0 定价** —— 风控模型拿到荒谬的窗口，
 * 而"免费"会让调度器把大量活派给它。**对不上就返回 unknown，这比填错安全得多。**
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';
import {
  MODELS_DEV_ALIASES,
  MODELS_DEV_UNRESOLVABLE,
  type ModelsDevAliasRule,
} from './modelsDevAlias.js';

/** 日志 scope —— 与 `llm:discovery` 同一命名法（`llm:<模块>`）。 */
const log = createLogger('llm:modelsdev');

/** 数据源地址（编译期常量 —— 这是本模块**不需要**走 `fetchGuarded` 的理由：没有任何用户输入能进到这里）。 */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/**
 * 单次请求超时。
 *
 * 5.6MB 的 JSON 在慢网络上要几秒，所以给得比普通 API 宽松；但它**必须有上限** ——
 * 没有超时的话，一个挂住的连接会让"刷新模型档案"这件事永远不返回，
 * 而它是要跑在 7×24 常驻进程里的。
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/*  类型                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 定价。**单位：USD / 每百万 token**（实测确认，不是每 1K）。
 *
 * ⚠️ 这个值**只用于调度加权**（"用便宜的"），**绝不进入任何金额算术** ——
 * 本项目的金额口径只有一处（`trades.insert()`），而交易成本来自**交易所的成交记录**，
 * 不是这里。把它和真实手续费混在一起会让对账彻底对不上。
 */
export interface ModelsDevCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** models.dev 里的一条模型条目（只保留我们用到的字段）。 */
export interface ModelsDevEntry {
  /** models.dev 的 provider id（如 `alibaba-cn`）。 */
  provider: string;
  /** models.dev 的模型 id（原样，如 `deepseek-v4.1-flash`）。 */
  id: string;
  name: string;
  /** `limit.context`。**缺失记 0**（0 = 不知道，不是"窗口为 0"）。 */
  contextTokens: number;
  /** `limit.output`。缺失记 0。 */
  maxOutputTokens: number;
  /** `cost` 对象整个缺失时为 `null`（**不是全 0** —— `null` 与"免费"不能混）。 */
  cost: ModelsDevCost | null;
  /** `knowledge`（知识截止）；空字符串 = 不知道。 */
  knowledge: string;
  /** `tool_call`；`null` = 该条目没写这个字段。 */
  toolCall: boolean | null;
  /** `structured_output`；`null` = 没写。 */
  structuredOutput: boolean | null;
  /** 是否思维链模型（来自 models.dev，**仅作参考**：运行时的实测值优先）。 */
  reasoning: boolean;
  /** `canonical_model_id`（上游归并后的规范 id）；`null` = 没写。 */
  canonicalId: string | null;
  /** 输入/输出模态。**它是对象，不是数组**（见文件头 ③）。 */
  modalities: { input: string[]; output: string[] };
}

/**
 * 解析后的索引。
 *
 * 两个映射的分工：
 * - `byId` —— 完整 id（`provider/model`）→ 条目。给人工别名表用（它的 `to` 可能写全名）。
 * - `byLeafName` —— **归一化后的叶子名** → 条目列表。给 L2 用。
 *
 * ⚠️ 为什么要"叶子 + 列表"：实测 `deepseek-v4.1-flash` 这个名字在 **76 个 provider**
 * 上都有，它们的窗口/定价**并不一致**。所以匹配到的是一个**组**，
 * 参数要按多数派归并（见 `mergeGroup`），而不是取第一条。
 */
export interface ModelsDevIndex {
  byId: Map<string, ModelsDevEntry>;
  byLeafName: Map<string, ModelsDevEntry[]>;
}

/** 空索引 —— 只在"还没拉到数据"时用。 */
const EMPTY_INDEX: ModelsDevIndex = { byId: new Map(), byLeafName: new Map() };

/** 匹配到的那一级。 */
export type MatchSource = 'alias' | 'exact' | 'canonical' | 'fuzzy';

/** 一次成功匹配的结果。 */
export interface ModelsDevMatch {
  source: MatchSource;
  /** 匹配到的参数（组内**多数派**归并后）。 */
  entry: ModelsDevEntry;
  /** 相似度（`alias` / `exact` / `canonical` 记 1；`fuzzy` 记真实分数）。 */
  score: number;
}

/* -------------------------------------------------------------------------- */
/*  名字归一化                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * **写法后缀** —— 供应商写法差异，不代表不同的模型。
 *
 * ⚠️ 这些是**实测出现过的**写法差异，不是想当然加的：
 * 网关暴露 `group/auto-ling-3.1-flash-free`，而 models.dev 上是
 * `inclusionai/ling-3.1-flash`（`opencode/ling-3.1-flash-free` 也有，
 * 但它被标了 `deprecated`）。不剥 `-free` 就匹配不上。
 */
const WRITING_SUFFIXES: readonly string[] = ['-free', '-latest', '-thinking'];

/**
 * 归一化一个网关模型名，用于跨来源匹配。
 *
 * 规则（**顺序有意义**）：
 * ```
 *   ① 剥 `group/auto-` 前缀  —— 只剥这一种，见下面的 ⚠️
 *   ② 取叶子（最后一个 `/` 之后）—— 供应商前缀与"这是哪个模型"无关
 *   ③ 剥 `@region` 后缀      —— 实测 `deepseek-v4.1-flash@eu`
 *   ④ `-_.` 与空白统一为 `-`  —— 实测网关用 `-`、上游用 `.`
 *   ⑤ 剥写法后缀（循环剥，`-x-latest-free` 要全剥掉）
 *   ⑥ 转小写、去掉首尾分隔符
 * ```
 *
 * ## ⚠️⚠️ 为什么【只】剥 `group/auto-`，绝不通用地剥 `auto-`
 *
 * 这一条差一点就写错，而后果很具体（2026-10-14 实测）：
 *
 * ```
 *   通用剥 `auto-`：`nano-gpt/auto-model` → `model`
 *   而网关的 `group/auto-qfmodel` 归一化后 → `qfmodel`
 *   两者相似度 = 0.8000（离 0.85 的门槛只差 0.05）
 * ```
 *
 * 一旦通用剥 `auto-`，`auto-model`（nano-gpt 的"自动挑后端"路由别名，
 * 一个**不是模型**的东西）就会变成一个名为 `model` 的普通条目。
 * 虽然 0.80 < 0.85 仍然被挡住，但把门槛往下调一点点就会立刻漏进来 ——
 * 而"门槛被谁调松"这种事无法用测试永远挡住。
 *
 * 只剥 `group/auto-` 就把这条路彻底封死：`auto-model` 保持原名，
 * 与 `qfmodel` 的相似度只有 **0.5333**，离门槛有足够余量。
 *
 * ⚠️ 顺带一提：`group/auto-*` 在实测里**只是静态别名**（"按模型名自动挑一个供应商"），
 * 没有额度感知、也没有故障转移 —— 但在模型身份的层面它与被指向的模型是同一个，
 * 所以剥掉前缀去匹配 models.dev 是**正确**的。
 */
export function normalizeGatewayName(id: string): string {
  let s = id.trim().toLowerCase();

  /* ① 只剥 magpie 路由组的前缀（见上面那段为什么不能通用剥 `auto-`）。 */
  if (s.startsWith('group/auto-')) s = s.slice('group/auto-'.length);

  /* ② 取叶子 —— `provider/model` 的供应商部分不参与匹配。 */
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);

  /*
   * ③ `@region` 后缀（实测 `requesty/deepseek-v4.1-flash@eu`）。
   *
   * ⚠️ **刻意不剥 `:variant`**（实测有 `:thinking` / `:free` / `:fast`）——
   * 那些是**同一个 provider 上的不同条目**，剥掉会让它们互相覆盖。
   * `@region` 不同：它是同一个模型的区域部署点。
   */
  s = s.replace(/@[a-z0-9_-]+$/, '');

  /* ④ 分隔符统一。 */
  s = s.replace(/[._\s]+/g, '-').replace(/-+/g, '-');

  /* ⑤ 写法后缀（循环 —— `something-latest-free` 要剥两次）。 */
  for (const suffix of WRITING_SUFFIXES) {
    while (s.length > suffix.length && s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  }

  /* ⑥ 收尾。 */
  return s.replace(/^-+|-+$/g, '');
}

/**
 * **版本号 token** —— L4 模糊匹配的硬性前提。
 *
 * 把 `v4.1` / `5.3` / `k3` 这类版本片段抽成 token 数组：
 * ```
 *   deepseek-v4-1-flash   → ['4','1']
 *   glm-5-3-flash         → ['5','3']
 *   kimi-k3               → ['3']       （单字母+数字，实测 `kimi-k3` 就是这种）
 *   gpt-6-astra           → ['6']
 *   qfmodel               → []          （没有版本号）
 * ```
 *
 * ## 为什么模糊匹配必须要求它**完全一致**
 *
 * 相似度对"尾部多一个短后缀"极不敏感 —— 实测：
 *
 * ```
 *   deepseek-v4-1-flash  vs  deepseek-v4-1-flash-sg   → 0.9189（过 0.85）
 *   kimi-k3              vs  kimi-k3-sg               → 0.8000（不过）
 * ```
 *
 * 也就是说 `-sg`（新加坡区域节点）这类**不同资源**会被相似度放进来。
 * 版本号 token 一致就把"`v4.1` 匹配到 `v5`"这种最荒谬的错挡在门外；
 * 剩下的 `-sg` / `-fp4` 这类差异由匹配结果的**低置信处理**兜住
 *（见 `modelDiscovery.mergeDiscovered`：`fuzzy` 只补参考字段，不补长度上限）。
 *
 * ⚠️ 后缀里的日期段（`deepseek-v4-flash-0731` 的 `0731`）会成为一个 token，
 * 所以 `...-flash` 与 `...-flash-0731` 的 token 不同 → **不匹配**。
 * 这是有意的：带日期的通常是另一个快照版本。
 */
export function versionTokens(normalizedName: string): string[] {
  const out: string[] = [];
  for (const segment of normalizedName.split('-')) {
    /* `v4` / `4` / `4.1`（已归一化成 `4-1`）—— 纯数字或 `v` + 数字。 */
    const numeric = /^(?:v)?(\d+(?:\.\d+)*)$/.exec(segment);
    if (numeric?.[1] !== undefined) {
      out.push(...numeric[1].split('.'));
      continue;
    }
    /* `k3` / `m2` 这种"单字母 + 数字"（实测 `kimi-k3` / `minimax-m2.5`）。 */
    const letter = /^[a-z](\d+)$/.exec(segment);
    if (letter?.[1] !== undefined) out.push(letter[1]);
  }
  return out;
}

/**
 * 字符 bigram 的 Dice 系数（0–1）。
 *
 * 选它而不是编辑距离：**它对词序不敏感、对长度差惩罚温和**，
 * 而且计算是 O(n) —— 8,831 个条目 × 每个网关模型都要算一遍，
 * 复杂度是要考虑的（O(n·m) 的编辑距离在这个规模上会明显变慢）。
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length <= 2) {
    if (s.length > 0) out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/* -------------------------------------------------------------------------- */
/*  解析                                                                       */
/* -------------------------------------------------------------------------- */

/** 数值收窄：非有限数一律给默认值。 */
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 未知值当对象看（本仓库既有的 `asObject` 风格，不用 `any`）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 读一个字符串数组字段；非数组或含非字符串项时，只保留字符串项。 */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string');
}

/**
 * 解析 `cost`。
 *
 * ⚠️ **整个对象缺失 → `null`**，而不是全 0。
 * `0` 的意思是"免费"，`null` 的意思是"不知道" —— 这两者在本项目里**绝不能混**
 *（同一个原则见 `modelDiscovery.parseWireModels` 的 `free: 'unknown'` 注释：
 * 把"不知道"当成"付费"会让白送的模型被排到最后）。
 *
 * 结构里已给出 `cost` 但缺某个键（实测 `cache_write` 常常没有）时，那一项记 0 ——
 * 因为在"这个模型的缓存价是 0.3"这个前提下，缺 `cache_write` 只可能是"没有这个档"。
 */
function parseCost(value: unknown): ModelsDevCost | null {
  const cost = asRecord(value);
  if (!cost) return null;
  const keys = ['input', 'output', 'cache_read', 'cache_write'] as const;
  if (!keys.some((k) => typeof cost[k] === 'number')) return null;
  return {
    input: num(cost['input']),
    output: num(cost['output']),
    cacheRead: num(cost['cache_read']),
    cacheWrite: num(cost['cache_write']),
  };
}

/**
 * 解析整份 `api.json`。
 *
 * 顶层形状（实测）：`{ [providerId]: { id, name, env, npm, api, doc, models: {...} } }`
 *
 * **全程防御性解析**：任何一个 provider/model 结构不对就跳过它，
 * 绝不让一条脏数据把整份目录变成空 —— 后者会让所有模型同时失去参数补齐
 *（而"静默地全线失效"正是这个仓库反复记录的失败形态）。
 */
export function parseModelsDev(payload: unknown): ModelsDevIndex {
  const byId = new Map<string, ModelsDevEntry>();
  const byLeafName = new Map<string, ModelsDevEntry[]>();

  const root = asRecord(payload);
  if (!root) return { byId, byLeafName };

  for (const [providerId, rawProvider] of Object.entries(root)) {
    const provider = asRecord(rawProvider);
    if (!provider) continue;
    const models = asRecord(provider['models']);
    if (!models) continue;

    for (const [modelKey, rawModel] of Object.entries(models)) {
      const model = asRecord(rawModel);
      if (!model) continue;

      const id = typeof model['id'] === 'string' && model['id'].length > 0 ? model['id'] : modelKey;
      if (id.length === 0) continue;

      /* ⚠️ `context` / `output` 在 `limit` 里，不在顶层（见文件头 ①）。 */
      const limit = asRecord(model['limit']);
      const modalities = asRecord(model['modalities']);

      const entry: ModelsDevEntry = {
        provider: providerId,
        id,
        name: typeof model['name'] === 'string' ? model['name'] : id,
        contextTokens: num(limit?.['context']),
        maxOutputTokens: num(limit?.['output']),
        cost: parseCost(model['cost']),
        knowledge: typeof model['knowledge'] === 'string' ? model['knowledge'] : '',
        toolCall: typeof model['tool_call'] === 'boolean' ? model['tool_call'] : null,
        structuredOutput:
          typeof model['structured_output'] === 'boolean' ? model['structured_output'] : null,
        reasoning: model['reasoning'] === true,
        canonicalId: typeof model['canonical_model_id'] === 'string' ? model['canonical_model_id'] : null,
        modalities: {
          input: stringArray(modalities?.['input']),
          output: stringArray(modalities?.['output']),
        },
      };

      byId.set(`${providerId}/${id}`, entry);

      const leaf = normalizeGatewayName(id);
      if (leaf.length === 0) continue;
      const list = byLeafName.get(leaf);
      if (list) list.push(entry);
      else byLeafName.set(leaf, [entry]);
    }
  }

  return { byId, byLeafName };
}

/* -------------------------------------------------------------------------- */
/*  组内多数派归并                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 数值众数；平局取**较小值**。
 *
 * ## 为什么平局取小的（不是随大流取大的）
 *
 * 长度上限（`limit.context` / `limit.output`）填大了会**超出模型真实能力** ——
 * 而我们整套输出预算（`budgetFor`）建立在它之上：填大了就是"以为能输出 200k、
 * 实际被截断"，症状是 `finish_reason=length` + 空内容 —— 也就是
 * `modelDiscovery.ts` 里记录过的那次「一个角色 242 秒、整轮跑不完」。
 *
 * 填小了的代价只是"少用一点窗口"，是**可以承受**的方向。
 * 所以平局往小的那边倒。
 *
 * ⚠️ 对 `cost` 而言"取小"意味着"看起来更便宜"，方向上不保守 —— 但定价
 * **只用于调度加权**（绝无金额算术，见 `ModelsDevCost` 的说明），
 * 而且平局本来就意味着两个值分量相同，所以这里统一用同一个确定性规则，
 * 而不是给每个字段编一套 —— **可预测比微调更重要**。
 */
function modeNumber(values: readonly number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0]!;
  let bestCount = counts.get(best) ?? 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** 字符串众数；平局取**字典序最小**（同样只是为了确定性）。 */
function modeString(values: readonly string[], fallback: string): string {
  const nonEmpty = values.filter((v) => v.length > 0);
  if (nonEmpty.length === 0) return fallback;
  const counts = new Map<string, number>();
  for (const v of nonEmpty) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = nonEmpty[0]!;
  let bestCount = counts.get(best) ?? 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** 布尔众数：只看**明确报过**的成员；过半为真。一个都没报 → `null`。 */
function modeBool(values: readonly (boolean | null)[]): boolean | null {
  const known = values.filter((v): v is boolean => v !== null);
  if (known.length === 0) return null;
  return known.filter(Boolean).length * 2 > known.length;
}

/**
 * 把一组同名条目归并成一条（**多数派参数**）。
 *
 * ## 为什么必须归并，而不是"取第一条"
 *
 * 实测（2026-10-14，全量目录）：
 *
 * ```
 *   deepseek-v4-1-flash   76 个成员：context 1048576×37 · 1000000×31 · 1050000×2 …
 *                         cost.input 0.3×22 · 0.15×13 · 0.2×5 · 0×5 …
 *   glm-5-3-flash         80 个成员，canonical 有 2 种
 *   deepseek-v4-flash     79 个成员，canonical 有 4 种
 * ```
 *
 * 网关的 `group/auto-*` 会**路由到其中任意一个**，所以"取第一条"等于
 * 让匹配结果取决于目录里的遍历顺序 —— 那是不可复现的。
 * 多数派是这组数据里唯一有意义的估计。
 *
 * ⚠️ 为什么不用**最小值**（看起来更保守）：实测 `kimi-k3` 的 86 个成员里有
 * 两个是 262144，而 70 个是 1048576 —— 取最小会把它按 262k 处理，
 * **白白浪费 4 倍上下文**。保守要在"填错的方向"上保守，不是一律往下压。
 */
function mergeGroup(entries: readonly ModelsDevEntry[]): ModelsDevEntry {
  const first = entries[0]!;
  if (entries.length === 1) return first;

  const costs = entries.map((e) => e.cost).filter((c): c is ModelsDevCost => c !== null);
  const cost: ModelsDevCost | null =
    costs.length === 0
      ? null
      : {
          input: modeNumber(costs.map((c) => c.input), 0),
          output: modeNumber(costs.map((c) => c.output), 0),
          cacheRead: modeNumber(costs.map((c) => c.cacheRead), 0),
          cacheWrite: modeNumber(costs.map((c) => c.cacheWrite), 0),
        };

  return {
    /* provider/id 只用于排查"这条参数是从谁那里来的"，取第一条即可（组内同名）。 */
    provider: first.provider,
    id: first.id,
    name: first.name,
    /* 只统计**报过的**成员：把"没报"当成 0 会把众数拉到 0（= "没有窗口"）。 */
    contextTokens: modeNumber(
      entries.map((e) => e.contextTokens).filter((v) => v > 0),
      0,
    ),
    maxOutputTokens: modeNumber(
      entries.map((e) => e.maxOutputTokens).filter((v) => v > 0),
      0,
    ),
    cost,
    knowledge: modeString(
      entries.map((e) => e.knowledge),
      '',
    ),
    toolCall: modeBool(entries.map((e) => e.toolCall)),
    structuredOutput: modeBool(entries.map((e) => e.structuredOutput)),
    /* 思维链：过半成员说是 → 是（与 `free` 的"保守取严"方向相反，理由见下）。 */
    reasoning: modeBool(entries.map((e) => e.reasoning)) ?? false,
    /*
     * ⚠️ canonical 取第一条，**不参与多数派** —— 它是"这条被归到哪个规范 id"，
     * 组内本来就可能有两三种（实测 `glm-5-3-flash` 有 2 种）。
     * 用它做**再一级**的匹配入口时，任意一个都指向同一批条目，所以取谁都等价。
     */
    canonicalId: first.canonicalId,
    modalities: {
      input: [...new Set(entries.flatMap((e) => e.modalities.input))].sort(),
      output: [...new Set(entries.flatMap((e) => e.modalities.output))].sort(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  canonical 索引（惰性、按索引对象缓存）                                        */
/* -------------------------------------------------------------------------- */

/**
 * canonical 叶子名 → 条目组。
 *
 * ## 为什么惰性算 + 用 `WeakMap` 缓存
 *
 * `parseModelsDev` 的返回形状是**对外契约**（测试与调用方都按 `byId` / `byLeafName` 用），
 * 不想为了一个派生索引去改它。而每次匹配都重算一遍是 8,831 次归一化 ——
 * 在几百个网关模型上就是百万级调用，没必要。
 *
 * `WeakMap` 让缓存跟着索引对象走：索引被回收，缓存自动消失，
 * **不需要任何显式的失效逻辑**（那正是陈旧缓存最爱出问题的地方）。
 */
const canonicalCache = new WeakMap<ModelsDevIndex, Map<string, ModelsDevEntry[]>>();

function canonicalGroups(index: ModelsDevIndex): Map<string, ModelsDevEntry[]> {
  const cached = canonicalCache.get(index);
  if (cached) return cached;

  const groups = new Map<string, ModelsDevEntry[]>();
  for (const entries of index.byLeafName.values()) {
    for (const entry of entries) {
      if (entry.canonicalId === null) continue;
      const key = normalizeGatewayName(entry.canonicalId);
      if (key.length === 0) continue;
      const list = groups.get(key);
      if (list) list.push(entry);
      else groups.set(key, [entry]);
    }
  }
  canonicalCache.set(index, groups);
  return groups;
}

/* -------------------------------------------------------------------------- */
/*  4 级阶梯                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 在索引里按一个**目标名**（人工别名表的 `to`）找条目。
 *
 * 允许写 `provider/model` 全名，也允许写裸模型名 —— 因为写表的人
 * 未必知道 models.dev 上的 provider id，强迫他写全名只会让人瞎填。
 */
function findByTarget(index: ModelsDevIndex, target: string): ModelsDevEntry | null {
  const exact = index.byId.get(target);
  if (exact) return exact;
  const leaf = normalizeGatewayName(target);
  const group = index.byLeafName.get(leaf);
  if (group && group.length > 0) return mergeGroup(group);
  return null;
}

/** L4 的相似度门槛。**改动它之前先读 `modelsDevAlias.ts` 的反例 ①。** */
export const FUZZY_MIN_SIMILARITY = 0.85;

/**
 * 归一化后的"永不参数化"集合。
 *
 * `MODELS_DEV_UNRESOLVABLE` 里存的是**已经归一化**的形式（那个文件刻意不导入本模块，
 * 以免形成循环依赖），所以这里不需要再归一化一遍 —— 代价是清单必须手写正确，
 * 而 `modelsDevAlias.test.ts` 有一条断言钉住这一点。
 */
const UNRESOLVABLE_KEYS: ReadonlySet<string> = new Set(MODELS_DEV_UNRESOLVABLE);

/**
 * 查人工别名。
 *
 * 两侧都归一化后比对，所以表里写 `deepseek-v4.1-flash` 还是
 * `deepseek-v4-1-flash` 都能命中同一个网关名 —— 写表的人不该需要知道归一化细节。
 */
function findAlias(gatewayId: string): ModelsDevAliasRule | null {
  const key = normalizeGatewayName(gatewayId);
  for (const rule of MODELS_DEV_ALIASES) {
    if (normalizeGatewayName(rule.from) === key) return rule;
  }
  return null;
}

/**
 * **名字匹配 4 级阶梯** —— 本模块的核心。
 *
 * @param gatewayId 网关上的调用名（`group/auto-*` / `provider/model` / 裸名都行）。
 * @param index `parseModelsDev` 的结果。省略时返回 `null`（没有任何数据可匹配）。
 * @returns 匹配结果；**对不上返回 `null`**（调用方据此**不写任何参数**）。
 *
 * ## 为什么最后一级是"宁缺毋滥"
 *
 * 4 级全部失败就是 `null`。这不是"功能没做完"，而是**刻意的**：
 * 网关上的路由聚合别名（实测 `group/auto-qfmodel`）在 models.dev 里
 * **根本不存在**，强行用相似度补一个只会得到噪声参数。
 * 而**参数填错的危害远大于参数缺失** —— 缺失时下游会按"元数据缺失"降权
 *（`buildCatalog` 里那条实测规则），是一个**已知且安全**的降级路径。
 */
export function matchModel(gatewayId: string, index: ModelsDevIndex = EMPTY_INDEX): ModelsDevMatch | null {
  if (typeof gatewayId !== 'string' || gatewayId.length === 0) return null;

  const key = normalizeGatewayName(gatewayId);
  if (key.length === 0) return null;

  /*
   * ⛔ 第 0 级：**已知无法归一的名字**，直接出局。
   *
   * 放在 4 级**之前**，是为了让任何一级都没有机会给它编出参数 ——
   * 也包括将来有人往别名表里误加一条（那也会被这里挡住）。
   */
  if (UNRESOLVABLE_KEYS.has(key)) return null;

  /* ── L1 人工别名（最高置信：人查过依据）──────────────────────────────── */
  const alias = findAlias(gatewayId);
  if (alias) {
    const entry = findByTarget(index, alias.to);
    /*
     * ⚠️ 别名指向的东西查不到时**继续往下一级走**，而不是返回一个空条目 ——
     * 后者会让下游写上一堆 0，那正是我们要避免的"假装有数据"。
     * （models.dev 是上游目录，它会变；别名写好了但目标被改名是**正常**情况。）
     */
    if (entry) return { source: 'alias', entry, score: 1 };
  }

  /* ── L2 归一化 + 精确匹配 ────────────────────────────────────────────── */
  const exactGroup = index.byLeafName.get(key);
  if (exactGroup && exactGroup.length > 0) {
    return { source: 'exact', entry: mergeGroup(exactGroup), score: 1 };
  }

  /* ── L3 canonical 反查（多数派参数）──────────────────────────────────── */
  const canonGroup = canonicalGroups(index).get(key);
  if (canonGroup && canonGroup.length > 0) {
    return { source: 'canonical', entry: mergeGroup(canonGroup), score: 1 };
  }

  /* ── L4 相似度 ≥0.85 且版本号 token 完全一致（低置信）────────────────── */
  const wanted = versionTokens(key);
  let bestKey: string | null = null;
  let bestScore = 0;
  for (const leaf of index.byLeafName.keys()) {
    /*
     * 先把最便宜的判据放前面：版本号 token 全等。
     * 它挡掉的是"`v4.1` 匹配到 `v5`"这类最荒谬的错，而成本几乎为零。
     */
    if (!sameTokens(wanted, versionTokens(leaf))) continue;
    const score = similarity(key, leaf);
    if (score < FUZZY_MIN_SIMILARITY) continue;
    /*
     * 平局取**字典序最小**的键 —— 只为了让"同一个输入永远给同一个结果"。
     * 目录是每天重新拉的，遍历顺序不该影响匹配结果。
     */
    if (score > bestScore || (score === bestScore && bestKey !== null && leaf < bestKey)) {
      bestKey = leaf;
      bestScore = score;
    }
  }
  if (bestKey !== null) {
    const group = index.byLeafName.get(bestKey);
    if (group && group.length > 0) {
      return { source: 'fuzzy', entry: mergeGroup(group), score: bestScore };
    }
  }

  /* 全部失败 → 不写任何参数。 */
  return null;
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/*  网络：条件请求                                                              */
/* -------------------------------------------------------------------------- */

/** 一次拉取的结果。 */
export type ModelsDevFetchResult =
  | { notModified: true }
  | { notModified: false; payload: unknown; etag: string | null; fetchedAt: number };

/** `fetchModelsDev` 的可注入项（测试用 —— **绝不在测试里打真实网络**）。 */
export interface FetchModelsDevOptions {
  /** 上一次拿到的 ETag；给了它就发 `If-None-Match`。 */
  etag?: string | null;
  url?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 注入 `fetch`（测试用）。默认用全局 `fetch`。 */
  fetchImpl?: typeof fetch;
  /** 注入时钟（测试用）。 */
  now?: () => number;
}

/**
 * 拉取 models.dev 目录，**带条件请求**。
 *
 * ## 为什么必须带 `If-None-Match`（实测确认有效）
 *
 * 实测（2026-10-14）：响应带 `ETag: W/"..."`，带上 `If-None-Match` 时
 * 服务端返回 **304 Not Modified**。这份目录是 5.6MB，
 * 而刷新是要长期跑的 —— 无条件请求等于每天白拉 5.6MB。
 * 带上它之后"没有变化"的代价降到几百字节的响应头。
 *
 * ⚠️ `304` 与 `200` 的处理**必须在调用方分开**：304 意味着"本地那份还是最新的"，
 * 所以**绝不能**拿它去覆盖快照（那会把快照清空）—— 见 `ModelsDevStore.refresh`。
 *
 * ## 为什么返回 `notModified` 而不是抛错
 *
 * "没有变化"是**成功**，不是失败。用异常表达它会让调用点不得不用 try/catch
 * 去区分"正常无事"与"真的坏了" —— 而那正是最容易写错的地方。
 *
 * @throws 网络失败 / 非 2xx / JSON 解析失败时抛出（调用方负责保留旧快照）。
 */
export async function fetchModelsDev(options: FetchModelsDevOptions = {}): Promise<ModelsDevFetchResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (typeof options.etag === 'string' && options.etag.length > 0) {
    headers['if-none-match'] = options.etag;
  }

  const response = await doFetch(options.url ?? MODELS_DEV_URL, {
    method: 'GET',
    headers,
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  /* 304：本地那份还是最新的。**没有 payload** —— 这是刻意的（见上面那段）。 */
  if (response.status === 304) return { notModified: true };

  if (!response.ok) {
    throw new Error(`models.dev 拉取失败：HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  return {
    notModified: false,
    payload,
    /* 弱 ETag（`W/"..."`）照原样存回 —— 那正是下次要发出去的值。 */
    etag: response.headers.get('etag'),
    fetchedAt: now(),
  };
}

/* -------------------------------------------------------------------------- */
/*  本地快照（原子替换）                                                         */
/* -------------------------------------------------------------------------- */

/** 快照文件里存的东西。 */
interface SnapshotFile {
  version: 1;
  etag: string | null;
  fetchedAt: number;
  payload: unknown;
}

/** 快照路径。 */
export function snapshotPath(dataDir: string): string {
  return path.join(dataDir, 'models-dev', 'snapshot.json');
}

/**
 * 读快照。文件不存在 / 坏掉 / 形状不对 → `null`。
 *
 * ⚠️ **绝不抛错**：快照是缓存，读不到只意味着"需要重新拉一次"。
 * 让一个坏掉的缓存文件把进程启动流程打断，是把缓存当成了数据源。
 */
export function readSnapshot(dataDir: string): SnapshotFile | null {
  try {
    const raw = readFileSync(snapshotPath(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const record = asRecord(parsed);
    if (!record) return null;
    if (record['version'] !== 1) return null;
    if (!('payload' in record)) return null;
    const etag = typeof record['etag'] === 'string' ? record['etag'] : null;
    const fetchedAt = num(record['fetchedAt'], 0);
    return { version: 1, etag, fetchedAt, payload: record['payload'] };
  } catch {
    return null;
  }
}

/**
 * **写快照：先写临时文件，再原子 `rename`**。
 *
 * ## 为什么必须这样写（而不是直接 `writeFileSync`）
 *
 * 这个进程是 7×24 常驻的，而且在**刷新时会被别处读**（`load()` 在读它）。
 * 直接覆写有一个真实的坏窗口：
 *
 * ```
 *   writeFileSync 打开文件 → 截断为 0 字节 → 分块写入 5.6MB（要几十毫秒）
 *                                        ↑ 这段时间里读到的是【半个 JSON】
 * ```
 *
 * 读到半个 JSON 的表现是 `JSON.parse` 抛错 → `readSnapshot` 返回 null →
 * **旧的可用快照被当成不存在**。而 `rename` 在同一文件系统内是原子的：
 * 读者要么看到完整的旧文件，要么看到完整的新文件，**没有中间态**。
 *
 * ## 失败时保留旧文件（绝不清空）
 *
 * 任何一步失败都直接抛出、**不碰目标文件**，并尽力删掉临时文件。
 * 调用方（`ModelsDevStore.refresh`）捕获后保留内存里与磁盘上的旧快照 ——
 * "拉取失败"绝不能让系统退化成"没有任何模型参数"。
 *
 * ⚠️ 覆盖面：**先校验再写**。一份解析后为空的结果（例如上游回了一个
 * 结构完全不同但 HTTP 200 的 JSON）不该覆盖掉手上这份好数据。
 */
export function writeSnapshotAtomic(dataDir: string, snapshot: SnapshotFile): void {
  const target = snapshotPath(dataDir);
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });

  /*
   * 临时文件名带 pid：并发运行两个进程（例如部署时的滚动重启）时，
   * 固定的 `.tmp` 会让两边互相覆盖，rename 出一个内容错乱的文件。
   */
  const tmp = `${target}.tmp-${process.pid}`;
  const body = JSON.stringify(snapshot);
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, target);
  } catch (error) {
    /* 清理临时文件；删不掉也不该掩盖真正的错误（它只是垃圾，不是状态）。 */
    try {
      unlinkSync(tmp);
    } catch {
      /* 忽略：临时文件不存在或已被清掉。 */
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/*  存储（内存索引 + 磁盘快照 + 刷新）                                            */
/* -------------------------------------------------------------------------- */

/** 一次刷新的结果，给日志用。 */
export interface RefreshOutcome {
  status: 'updated' | 'not_modified' | 'failed';
  /** 当前（刷新后）生效的 ETag。 */
  etag: string | null;
  fetchedAt: number | null;
  /** 失败原因（面向人的中文），成功时为 `undefined`。 */
  error?: string;
}

/** `ModelsDevStore` 的构造项。 */
export interface ModelsDevStoreOptions {
  /** 运行期数据目录（`env.dataDir`）—— 快照写在它下面的 `models-dev/`。 */
  dataDir: string;
  url?: string;
  timeoutMs?: number;
  /** 注入 `fetch`（测试用）。 */
  fetchImpl?: typeof fetch;
  /** 注入时钟（测试用）—— 与 `ModelHealthRegistry` 同一个做法。 */
  now?: () => number;
}

/**
 * **模型档案的第三个数据源**：内存索引 + 磁盘快照 + 条件刷新。
 *
 * ## 为什么是一个类（而不是一组纯函数）
 *
 * 因为"当前生效的是哪一份数据 / 它的 ETag 是什么"是**状态**，
 * 而这份状态必须和快照文件保持一致。散成模块级变量会让"测试之间互相污染"
 *（前一个用例写的快照被后一个读到），而这个仓库在数据库测试上已经确立了
 * 「每个用例用自己的临时目录」的纪律（见 `docs/AGENTS.md` §3.6）——
 * 一个实例 = 一份状态，天然满足它。
 *
 * ## 与 `ModelHealthRegistry` 一致的几处取舍
 *
 * - **构造时注入时钟**（`now`），使"快照过期没有"这类判断可测；
 * - **不落数据库** —— 这是**上游目录的缓存**，不是事实；
 *   落库会带来"重启后带着陈旧记录"的问题，而重启后重新拉一次本来就是对的。
 */
export class ModelsDevStore {
  private index: ModelsDevIndex | null = null;
  private etag: string | null = null;
  private fetchedAt: number | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private readonly now: () => number;

  constructor(private readonly options: ModelsDevStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * 从磁盘快照装载（同步、不联网）。
   *
   * ⚠️ **同步**：它是启动路径上的一步，而"启动时要等一次网络"是这个项目
   * 明确要避免的形态（见 `magpieGateway.discoverFromGateway` 的说明：
   * 拉目录失败不该让机器人起不来）。快照读不到就返回 `null`，
   * 由调用方决定是"先跑着、稍后刷新"还是"这次不补参数"。
   *
   * @returns 装载成功时的索引；没有可用快照时 `null`。
   */
  load(): ModelsDevIndex | null {
    const snapshot = readSnapshot(this.options.dataDir);
    if (!snapshot) return null;
    const index = parseModelsDev(snapshot.payload);
    if (index.byLeafName.size === 0) return null;
    this.index = index;
    this.etag = snapshot.etag;
    this.fetchedAt = snapshot.fetchedAt;
    return index;
  }

  /** 当前生效的索引；还没装载时 `null`。 */
  current(): ModelsDevIndex | null {
    return this.index;
  }

  /** 当前生效的 ETag。 */
  currentEtag(): string | null {
    return this.etag;
  }

  /** 快照的拉取时刻（epoch ms）；未知时 `null`。 */
  currentFetchedAt(): number | null {
    return this.fetchedAt;
  }

  /** 对一个网关模型名做 4 级阶梯匹配。没有数据时返回 `null`（不写任何参数）。 */
  match(gatewayId: string): ModelsDevMatch | null {
    if (!this.index) return null;
    return matchModel(gatewayId, this.index);
  }

  /**
   * 刷新一次。
   *
   * ## 三种结果的语义（调用方必须区别对待）
   *
   * | 结果 | 磁盘快照 | 含义 |
   * |---|---|---|
   * | `updated` | **原子替换** | 拉到了新数据 |
   * | `not_modified` | **不动** | 304，本地那份还是最新的（**不是失败**）|
   * | `failed` | **不动** | 网络/HTTP/JSON 出错 —— **保留旧快照，绝不清空** |
   *
   * ## 为什么失败也要返回而不是抛
   *
   * 刷新是**后台循环**里的事。抛出去只会让循环自己崩掉（或者被一个空的 catch
   * 吞掉，谁也不知道），而这里返回一个带原因的 `failed` 让调用方能**记一行日志**。
   * "失败了但没人知道"与"失败了但保留旧数据"是两种完全不同的运行状态。
   *
   * ## 重入守卫
   *
   * 与 `AutoTrader.cycleInFlight` 同一个理由：定时刷新与手动刷新可能撞上，
   * 而两个并发的 5.6MB 下载 + 两次 rename 完全是浪费。这里直接返回上一次的状态。
   */
  async refresh(): Promise<RefreshOutcome> {
    if (this.refreshing) {
      return { status: 'not_modified', etag: this.etag, fetchedAt: this.fetchedAt };
    }
    this.refreshing = true;
    try {
      /* 还没装载过就先读本地快照 —— 这样"刷新"总是建立在已有数据之上。 */
      if (!this.index) this.load();

      const result = await fetchModelsDev({
        etag: this.etag,
        ...(this.options.url !== undefined ? { url: this.options.url } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
        now: this.now,
      });

      if (result.notModified) {
        return { status: 'not_modified', etag: this.etag, fetchedAt: this.fetchedAt };
      }

      /* ⚠️ 先解析再落盘：解析为空的结果不该覆盖掉手上这份好数据。 */
      const parsed = parseModelsDev(result.payload);
      if (parsed.byLeafName.size === 0) {
        return {
          status: 'failed',
          etag: this.etag,
          fetchedAt: this.fetchedAt,
          error: '拿到的目录解析后为空（结构可能变了）—— 已保留旧快照。',
        };
      }

      writeSnapshotAtomic(this.options.dataDir, {
        version: 1,
        etag: result.etag,
        fetchedAt: result.fetchedAt,
        payload: result.payload,
      });

      /* 只有落盘成功之后才换内存索引 —— 两处必须一致。 */
      this.index = parsed;
      this.etag = result.etag;
      this.fetchedAt = result.fetchedAt;
      return { status: 'updated', etag: this.etag, fetchedAt: this.fetchedAt };
    } catch (error) {
      /*
       * **不碰任何既有状态**：磁盘上的旧快照与内存里的旧索引都留着。
       * 一次网络失败不该让系统失去全部模型参数。
       */
      return {
        status: 'failed',
        etag: this.etag,
        fetchedAt: this.fetchedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * 启动**每日刷新**循环。
   *
   * ## 风格照抄 `manager.startSelfCheckLoop`（不新造一套）
   *
   * ```
   *   setInterval(...)  →  timer.unref()  →  立即先跑一次
   * ```
   *
   * - **`unref()`**：这个定时器是**可丢弃的** —— 丢掉只是少刷新一次目录，
   *   不是丢数据。绝不能因为它把进程吊在退出前。
   * - **启动时立即跑一次**：`setInterval` 要等一整个间隔才首次触发，
   *   而"刚部署完"恰恰是最该确认数据新鲜的时刻
   *（`staleOrderSettle.test.ts` 记录过这个坑：等了 30 分钟什么都没发生）。
   * - **间隔可被环境变量覆盖**，并钳制在合理区间 —— 0 或负数会让
   *   `setInterval` 疯狂空转。
   *
   * 节奏取**一天一次**：上游目录不是分钟级变化的东西，而 `docs/LEGAL.md` §1b
   * 已经把"每日一次 + 条件请求"定为对上游的基本礼貌。
   */
  startRefreshLoop(intervalHours?: number): void {
    if (this.refreshTimer) return;
    const raw = intervalHours ?? Number(process.env['MODELS_DEV_REFRESH_HOURS'] ?? '');
    /* 钳制在 1–168 小时（一周）：与自检循环同一个做法与理由。 */
    const hours = Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 168) : 24;

    const timer = setInterval(() => {
      void this.refresh().then((outcome) => {
        /*
         * ⚠️ **失败必须留痕** —— "失败了但没人知道"与"失败了但保留旧数据"
         * 是两种完全不同的运行状态，而前者会让陈旧参数**安静地**一直用下去。
         */
        if (outcome.status === 'failed') {
          log.warn(`models.dev 刷新失败：${outcome.error ?? '未知原因'}（继续使用现有快照）`);
        }
      });
    }, hours * 3_600_000);
    timer.unref();
    this.refreshTimer = timer;

    /* 启动时立即一次（见上面那段为什么）。 */
    void this.refresh().then((outcome) => {
      log.info(
        outcome.status === 'updated'
          ? 'models.dev 目录已更新。'
          : outcome.status === 'not_modified'
            ? 'models.dev 目录没有变化（304）。'
            : `models.dev 首次刷新失败：${outcome.error ?? '未知原因'}`,
      );
    });
  }

  /** 停掉刷新循环（测试与优雅关闭用）。 */
  stopRefreshLoop(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * 返回一个可直接喂给 `buildCatalog` 的查询函数。
   *
   * ## 为什么需要这个"转接头"
   *
   * `buildCatalog` 要的是一个 `(gatewayId) => match | null` 的纯函数
   *（见 `modelDiscovery.ModelsDevLookup` 里为什么必须注入），
   * 而 store 的 `match` 恰好就是这个形状。少写一个箭头函数不算什么，
   * 但它把"哪两处必须对上"变成了**一个可 grep 的符号**。
   */
  lookup(): (gatewayId: string) => ModelsDevMatch | null {
    return (gatewayId: string) => this.match(gatewayId);
  }
}
