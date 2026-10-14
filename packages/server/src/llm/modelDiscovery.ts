/**
 * **模型自动发现与自动分档** —— 让系统在模型变化时自己跟上，不靠人维护。
 *
 * ## 用户的原话（这是本模块存在的全部理由）
 *
 * > 「例如现在我添加到 magpie 里面的 OpenCode Zen Free 供应商，里面模型基本都是免费不限量
 * >  供应使用，但是**时效性不固定**，万一今天能用，明天不能用、改了名字或者限量了，
 * >  又或者**突然上线了什么模型**（假如系统运行中这个提供商增加了一个模型，很好用智商高，
 * >  **系统是否会自动发现，自动调研判断模型档次，然后应用到相应的智能体中**）……
 * >  那么系统如何保证能不中断，能正常用」
 * >
 * > 「现在这么多模型，哪些不限量使用，哪些是限量的，其实**不用你手动探测，
 * >  你去 magpie 里面看，上面应该有些会标注**」
 *
 * ## 实测数据源（三个，各补各的缺口）
 *
 * | 来源 | 有什么 | 缺什么 |
 * |---|---|---|
 * | `GET /v1/models`（运行时可达）| context / max_output / **reasoning** / **supported_reasoning_levels** / modalities | **没有 `free`、没有 `cost`** |
 * | `plugin-providers.json`（配置文件）| **`free`** / **`rate`** / **`cost`** / `released` / `variants` / `fast` | 需要读文件 |
 * | **models.dev**（上游目录，2026-10-14 接入）| **`cost`（USD/百万 token）** / **`knowledge`** / **`tool_call`** / **`structured_output`** / `canonical_model_id` | 是**上游**目录，与我们网关的实际能力无关 |
 *
 * **所以必须合并** —— 只用 `/v1/models` 就分不出"免费还是烧积分"，
 * 而那正是用户要的"合理安排使用"的依据。
 *
 * ## ⚠️ 优先级不可覆盖（三个来源的取值口径完全不同）
 *
 * ```
 *   运行时 /v1/models 实测  >  人工 MODEL_PROFILES  >  models.dev 补齐  >  保守默认
 * ```
 *
 * `/v1/models` 反映的是**我们自己的网关此刻**的能力；models.dev 是上游挂牌的目录。
 * 网关可能做了截断、代理了另一个版本、或干脆换了模型 —— 所以
 * **models.dev 只填运行时拿不到的空缺，绝不覆盖实测值**。
 *（这条规则的具体代价见 `mergeDiscovered` 的说明，那里有一次 242 秒的实测。）
 */

import { readFileSync } from 'node:fs';
import { filterSuperseded } from './modelFamilies.js';
import type { ModelsDevMatch } from './modelsDev.js';

/** 单个**成员**（某个供应商上的某个模型）的限额事实 —— 这里是布尔，因为成员是确定的。 */
export interface MemberLimit {
  free: boolean | null;
  rate: number | null;
  released: string;
  fast: boolean;
}
type MemberLimits = Map<string, MemberLimit>;

/**
 * 免费状态。
 *
 * - `all`     —— 全部成员免费（**放心当体力活主力用**）
 * - `some`    —— 部分成员免费（有机会不烧额度，但可能被路由到付费成员）
 * - `none`    —— 全部付费
 * - `unknown` —— 配置里查不到（**不是付费**，只是不知道）
 */
export type FreeStatus = 'all' | 'some' | 'none' | 'unknown';

/** 从 magpie 发现的原始模型信息（两处数据合并后）。 */
export interface DiscoveredModel {
  /** magpie 上的调用 id（`provider/model` 或 `group/auto-*`）。 */
  id: string;
  displayName: string;
  /** 供应商 id（`owned_by` 或 id 前缀）。 */
  provider: string;
  contextTokens: number;
  maxOutputTokens: number;
  /** 是否思维链模型 —— **决定输出预算要放大几倍**（实测：不放大就得到 content=null）。 */
  reasoning: boolean;
  /** 支持的思考等级（如 `['low','high','max']`）。空数组 = 不支持指定等级。 */
  reasoningLevels: string[];
  /** 是否支持图片输入。 */
  image: boolean;
  /**
   * **免费状态** —— 四态，不是布尔。
   *
   * ## 为什么必须是四态（实测逼出来的）
   *
   * `deepseek-v4.1-flash` 这个模型在 magpie 里有 **8 个成员**，
   * 其中**只有 `workbuddy-ai` 那一个是免费**的，其余 7 个都要额度：
   *
   *     workbuddy-ai  deepseek-v4.1-flash      free=true    ← 不限量
   *     workbuddy-ai  deepseek-v4.1-flash-sg   free=false   rate=0.03
   *     workbuddy     deepseek-v4.1-flash      free=false
   *     cline / factory / devin …              free=false
   *
   * 所以网关上的 `group/auto-deepseek-v4-1-flash` **既不是"免费"也不是"付费"**
   * —— 它**有一部分免费容量**（magpie 的 smart 路由会优先用有额度的成员）。
   *
   * 用布尔表示只能二选一，两种都错：
   *   · 判 `true` → 以为不烧额度，实际可能被路由到付费成员（**烧钱**）；
   *   · 判 `false` → 完全避开它，**白白放弃一个不限量的通道**（用户明确说这个不限量）。
   *
   * 所以分四态，并且**`unknown` 与 `none` 绝不合并**（`unknown` 是"没查到"，
   * 合并会让新上线的免费模型被当成付费的而排到最后）。
   */
  free: FreeStatus;
  /** 消耗费率（`rate`）；`null` = 不知道。 */
  rate: number | null;
  /** 发布日期（`released`）；空字符串 = 未知。用于判断"是不是新上线的"。 */
  released: string;
  /** 是否快速档（`fast`）。 */
  fast: boolean;

  /* ────────────────────────────────────────────────────────────────────────
   *  以下字段来自 **models.dev**（第三个数据源，2026-10-14 接入）
   *
   *  ⚠️ 全部是**可选**的。它们**只补 `/v1/models` 与 `MODEL_PROFILES` 都没有的空缺**，
   *  绝不覆盖任何实测值 —— 优先级见 `mergeDiscovered` 的说明。
   * ──────────────────────────────────────────────────────────────────────── */

  /**
   * 定价（**USD / 每百万 token**）。
   *
   * ⚠️ **只用于调度加权，绝不进入任何金额算术** —— 本项目的金额口径只有一处
   *（`trades.insert()`），而真实交易成本来自交易所的成交记录。把上游目录的
   * 挂牌价混进对账会让账目彻底对不上。
   */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 知识截止（`2025-07-31` 这类）；空 = 未知。 */
  knowledge?: string;
  /** 是否支持工具调用。**注意**：它不决定"我们要不要给它工具"，只是档案信息。 */
  toolCall?: boolean;
  /** 是否支持结构化输出（JSON schema）。 */
  structuredOutput?: boolean;
  /** 上游的规范 id（`canonical_model_id`），用于排查"这条参数来自哪个模型"。 */
  canonicalId?: string;

  /**
   * **这个模型的档案是哪来的** —— 排查"参数为什么是这几个数"的唯一线索。
   *
   * | 值 | 含义 |
   * |---|---|
   * | `runtime` | `/v1/models` 的实测值（**最高优先级**）|
   * | `manual` | 人工 `MODEL_PROFILES` |
   * | `modelsdev` | models.dev 补齐（低置信时仍有值，但只补参考字段）|
   * | `default` | 谁都没给，用的是保守默认 |
   *
   * ## 为什么必须有这一列（而不是"反正有值就行"）
   *
   * 这个项目反复栽在"**说了但不生效**"上。当某个模型的上下文窗口明显不对时，
   * 第一个要回答的问题是"**这个数字是谁给的**" —— 没有这一列就只能靠猜，
   * 而三个数据源的取值口径完全不同（实测值 / 人工档案 / 上游目录）。
   */
  profileSource: 'runtime' | 'manual' | 'modelsdev' | 'default';
}

/** `/v1/models` 里一条记录的形状（只声明我们用到的字段）。 */
interface WireModel {
  id?: unknown;
  display_name?: unknown;
  magpie_label?: unknown;
  owned_by?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
  reasoning?: unknown;
  supported_reasoning_levels?: unknown;
  modalities?: unknown;
}

/** `plugin-providers.json` 里一条模型的形状。 */
interface PluginModel {
  id?: unknown;
  apiId?: unknown;
  context?: unknown;
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  image?: unknown;
  released?: unknown;
  free?: unknown;
  rate?: unknown;
  cost?: unknown;
  fast?: unknown;
}

interface PluginProvider {
  id?: unknown;
  models?: unknown;
}

/** 数值转换，非法值给默认。 */
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 从 `/v1/models` 的响应体解析出基础信息。 */
export function parseWireModels(payload: unknown): DiscoveredModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const raw of data) {
    const m = raw as WireModel;
    if (typeof m.id !== 'string' || m.id.length === 0) continue;
    const provider =
      typeof m.owned_by === 'string' && m.owned_by.length > 0
        ? m.owned_by
        : m.id.includes('/')
          ? m.id.split('/')[0]!
          : 'unknown';
    const levels: string[] = [];
    if (Array.isArray(m.supported_reasoning_levels)) {
      for (const lv of m.supported_reasoning_levels) {
        const effort = (lv as { effort?: unknown })?.effort;
        if (typeof effort === 'string') levels.push(effort);
      }
    }
    const modalities = m.modalities as { input?: unknown } | undefined;
    const image = Array.isArray(modalities?.input) && modalities.input.includes('image');
    out.push({
      id: m.id,
      displayName: typeof m.display_name === 'string' ? m.display_name : m.id,
      provider,
      contextTokens: num(m.context_length ?? m.context_window ?? m.max_input_tokens),
      maxOutputTokens: num(m.max_output_tokens),
      reasoning: m.reasoning === true,
      reasoningLevels: levels,
      image,
      /* 这两列要等合并 plugin-providers 才知道 —— 先用 `unknown`（**不是 `none`**）。 */
      free: 'unknown' as FreeStatus,
      rate: null,
      released: '',
      fast: false,
      /*
       * ⚠️ 这一条是**运行时的实测值**，所以标 `runtime` ——
       * 它是三个数据源里优先级最高的那个（见 `mergeDiscovered`）。
       */
      profileSource: 'runtime' as const,
    });
  }
  return out;
}

/**
 * **模型名归一化**（用于跨来源匹配）。
 *
 * ## 为什么必须归一化（实测踩到的坑）
 *
 * magpie 暴露的路由组 id 与 `plugin-providers.json` 里的模型名**写法不一致**：
 *
 *     网关暴露：`group/auto-deepseek-v4-1-flash`   ← 全是连字符
 *     配置文件：`deepseek-v4.1-flash`              ← 中间是点
 *
 * 实测后果：组的免费属性匹配不上成员，`group/auto-deepseek-v4-1-flash`
 * 被误判成 `free=false`（付费），而用户明确说它**不限量**
 *（原话：「WorkBuddy AI 提供商里面的 Deepseek-V4.1-Flash 就是不限量无限使用」）。
 *
 * 误判的代价很实在：一个不限量的模型被当成烧额度的，于是**体力活不敢用它**，
 * 白白消耗珍贵的付费额度 —— 正好与"合理安排使用"的目标相反。
 *
 * 所以把 `.` `_` 统一成 `-`、转小写、压掉重复分隔符再比。
 */
function normalizeModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[._\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * 从 `plugin-providers.json` 解析出"限量/不限量"等**只在配置里才有**的信息。
 *
 * 返回归一化后的 `provider/model → { free, rate, released, fast }` 映射。
 */
export function parsePluginLimits(payload: unknown): MemberLimits {
  const map: MemberLimits = new Map();
  const providers = Array.isArray(payload) ? payload : ((payload as { providers?: unknown })?.providers ?? []);
  if (!Array.isArray(providers)) return map;

  for (const raw of providers) {
    const p = raw as PluginProvider;
    const providerId = typeof p.id === 'string' ? p.id : null;
    if (!providerId || !Array.isArray(p.models)) continue;
    for (const rawModel of p.models) {
      const m = rawModel as PluginModel;
      const modelId = typeof m.apiId === 'string' && m.apiId.length > 0
        ? m.apiId
        : typeof m.id === 'string'
          ? m.id
          : null;
      if (!modelId) continue;
      map.set(`${providerId}/${normalizeModelName(modelId)}`, {
        free: typeof m.free === 'boolean' ? m.free : null,
        rate: typeof m.rate === 'number' && Number.isFinite(m.rate) ? m.rate : null,
        released: typeof m.released === 'string' ? m.released : '',
        fast: m.fast === true,
      });
    }
  }
  return map;
}

/**
 * **models.dev 的查询入口** —— 一个函数，而不是在 `mergeDiscovered` 内部联网。
 *
 * ## 为什么必须注入（而不是让本模块自己去查）
 *
 * `mergeDiscovered` 是本仓库最核心的一处纯函数（两处数据源在此汇合），
 * 而 `docs/AGENTS.md` §5.4 的既有约定是「**导出的纯函数优先于需要打桩的对象**」——
 * 在这里 `fetch` 会把"合并规则"与"网络"耦合在一起，测试就必须打桩。
 *
 * 传入函数之后：测试给一个查表函数即可，**不需要网络也不需要磁盘**
 *（`modelsDev.test.ts` 就是这么测的）。
 */
export type ModelsDevLookup = (gatewayId: string) => ModelsDevMatch | null;

/**
 * 合并三处数据。
 *
 * ## 优先级（**不可覆盖**，这是本函数唯一的硬约束）
 *
 * ```
 *   运行时 /v1/models 实测  >  人工 MODEL_PROFILES  >  models.dev 补齐  >  保守默认
 * ```
 *
 * ### 为什么"绝不覆盖运行时实测值"
 *
 * `/v1/models` 反映的是**我们自己的网关此刻**的能力，而 models.dev 是**上游目录**。
 * 两者测的不是同一件事：
 *
 * ```
 *   网关可能做了上下文截断、代理了另一个版本、或者干脆把模型换掉了
 * ```
 *
 * 实测佐证就在本文件里：`opencode-go/omen-alpha` 在网关的 `/v1/models` 里
 * **既没有 context 也没有 max_output**（`context=- maxOut=-`），
 * 而它在上游显然是有窗口的。如果我们反过来用上游值去"修正"网关，
 * 就会给一个**网关侧没有申报预算能力**的模型算出安全预算 —— 而那次实测的
 * 结局是 `finish_reason=length` + 空内容 + **一个角色 242 秒**。
 *
 * 所以：**实测值非空时一律不动它**；只有在它缺失（数值为 0 / 字段不存在，
 * 即"网关没告诉我们"）时才允许低优先级来源补上。
 *
 * ### ⚠️ `fuzzy`（模糊匹配）只补*参考字段*，不补长度上限
 *
 * 实测：`deepseek-v4.1-flash` 与 `deepseek-v4.1-flash-sg` 的相似度是 **0.9189**
 *（过了 0.85 的门槛），而它们是**不同资源** —— 网关上 `-sg` 是独立成员，
 * 有独立的额度（`free=false, rate=0.03`，而主模型 `free=true`）。
 *
 * 相似度能认出"这是同一家族的写法变体"，但**认不出"它是不是同一个部署"**。
 * 而长度上限填错的后果是实打实的（预算算错 → 输出被截断）：
 *
 * | 字段 | fuzzy 能否补 | 为什么 |
 * |---|---|---|
 * | `cost` / `knowledge` / `toolCall` / `structuredOutput` / `canonicalId` | **能** | 参考信息；错了最多是调度加权偏一点，不会让输出被截断 |
 * | `contextTokens` / `maxOutputTokens` | **不能** | 直接决定 `budgetFor` 的输出预算；宁可留 0（走"元数据缺失"降权那条**已知安全**的路径）|
 *
 * 高置信的三级（`alias` / `exact` / `canonical`）则可以补长度上限。
 */
export function mergeDiscovered(
  wire: readonly DiscoveredModel[],
  limits: MemberLimits,
  modelsDev?: ModelsDevLookup | null,
): DiscoveredModel[] {
  /* 先按"模型名"（去掉 provider 前缀、归一化）索引免费信息，供组推断使用。 */
  const byModelName = new Map<string, MemberLimit[]>();
  for (const [key, value] of limits) {
    const slash = key.indexOf('/');
    const modelName = slash >= 0 ? key.slice(slash + 1) : key;
    const list = byModelName.get(modelName) ?? [];
    list.push(value);
    byModelName.set(modelName, list);
  }

  return wire.map((m) => {
    const slash = m.id.indexOf('/');
    const providerPart = slash >= 0 ? m.id.slice(0, slash) : '';
    const modelPart = slash >= 0 ? m.id.slice(slash + 1) : m.id;

    /*
     * ① 精确匹配（**归一化后**比 —— magpie 会用 `-` 替换 `.`）。
     *
     * ⚠️ 这一步与 models.dev **无关**：它用的是网关自己的 `plugin-providers.json`，
     * 也就是"我们自己的部署事实"，优先级高于上游目录。
     */
    const exact = limits.get(`${providerPart}/${normalizeModelName(modelPart)}`);
    let base: DiscoveredModel;
    if (exact) {
      base = {
        ...m,
        free: exact.free === true ? 'all' : exact.free === false ? 'none' : 'unknown',
        rate: exact.rate,
        released: exact.released,
        fast: exact.fast,
      };
    } else {
      /* ② 路由组：`group/auto-<name>` → 用 `<name>` 的成员信息推断。 */
      const groupMembers = m.id.startsWith('group/auto-')
        ? byModelName.get(normalizeModelName(m.id.slice('group/auto-'.length)))
        : undefined;
      base = groupMembers && groupMembers.length > 0 ? inferGroupFromMembers(m, groupMembers) : m;
    }

    /* ③ models.dev 补齐 —— 只填空缺，且按置信度决定能填哪些字段。 */
    if (!modelsDev) return base;
    const match = modelsDev(base.id);
    if (!match) return base;

    return applyModelsDev(base, match);
  });
}

/**
 * **从成员推断路由组（`group/auto-*`）的属性**。
 *
 * ## 为什么组要单独处理
 *
 * 实测：`group/auto-gpt-6-astra` 这类**路由组**的 id 与 `plugin-providers.json` 里的
 * 模型名对不上（后者是 `gpt-6-astra`，没有 `group/auto-` 前缀）。
 * 而组恰恰是最该用的调用入口（magpie 在多个供应商提供同名模型时自动建组）。
 *
 * 所以组的免费属性**按它的成员推断**，并且方向是**保守**的：
 * 只要有一个成员是付费的，就不标"免费" —— 宁可少用一个免费组，
 * 也不能把付费的当免费的用（那会烧额度，见 `FreeStatus` 的四态说明）。
 */
function inferGroupFromMembers(m: DiscoveredModel, members: readonly MemberLimit[]): DiscoveredModel {
  const freeCount = members.filter((x) => x.free === true).length;
  const paidCount = members.filter((x) => x.free === false).length;
  const anyKnown = freeCount + paidCount > 0;
  /*
   * 四态判定：全免费 = `all`；有免费也有付费 = `some`（**有机会不烧额度**）；
   * 全付费 = `none`；一个都没查到 = `unknown`。
   */
  const freeStatus: FreeStatus = !anyKnown
    ? 'unknown'
    : paidCount === 0
      ? 'all'
      : freeCount === 0
        ? 'none'
        : 'some';
  const bestRate = members.reduce<number | null>((min, x) => {
    if (x.rate === null) return min;
    return min === null ? x.rate : Math.min(min, x.rate);
  }, null);
  return {
    ...m,
    free: freeStatus,
    rate: bestRate,
    released: members.map((x) => x.released).filter(Boolean).sort().pop() ?? '',
    fast: members.some((x) => x.fast),
  };
}

/**
 * 把一次 models.dev 匹配的结果**补进**档案（只填空缺）。
 *
 * 单独抽出来是为了让"哪些字段能补"这条规则**只有一份**，
 * 而且可以脱离 `mergeDiscovered` 的组推断逻辑单独测。
 */
function applyModelsDev(target: DiscoveredModel, match: ModelsDevMatch): DiscoveredModel {
  const entry = match.entry;
  const out: DiscoveredModel = { ...target };

  /*
   * 长度上限：**只有高置信匹配才能补**（理由见 `mergeDiscovered` 的 `fuzzy` 那一段）。
   * 判据用 `<= 0` 而不是 `=== 0`：负数是畸形输入，按"没有"处理。
   */
  const highConfidence = match.source !== 'fuzzy';
  let filledByModelsDev = false;

  if (highConfidence && out.contextTokens <= 0 && entry.contextTokens > 0) {
    out.contextTokens = entry.contextTokens;
    filledByModelsDev = true;
  }
  if (highConfidence && out.maxOutputTokens <= 0 && entry.maxOutputTokens > 0) {
    out.maxOutputTokens = entry.maxOutputTokens;
    filledByModelsDev = true;
  }

  /*
   * 参考字段：**没有就填**。它们与"网关此刻能不能输出"无关，
   * 所以模糊匹配也可以填（错了只是调度加权偏一点）。
   */
  if (out.cost === undefined && entry.cost) {
    out.cost = entry.cost;
    filledByModelsDev = true;
  }
  if (out.knowledge === undefined && entry.knowledge.length > 0) {
    out.knowledge = entry.knowledge;
    filledByModelsDev = true;
  }
  if (out.toolCall === undefined && entry.toolCall !== null) {
    out.toolCall = entry.toolCall;
    filledByModelsDev = true;
  }
  if (out.structuredOutput === undefined && entry.structuredOutput !== null) {
    out.structuredOutput = entry.structuredOutput;
    filledByModelsDev = true;
  }
  if (out.canonicalId === undefined && entry.canonicalId !== null) {
    out.canonicalId = entry.canonicalId;
    filledByModelsDev = true;
  }

  /*
   * `profileSource` 只在**真的补上了东西**时才改成 `modelsdev` ——
   * 否则它仍是 `runtime`（这个模型的档案整体上来自网关实测）。
   *
   * ⚠️ 刻意**不做**"逐字段来源"的记账：那会让这个类型膨胀成
   * `{ contextTokens: {value, source}, … }` 而收益很小 ——
   * 真正要回答的问题是"这个模型的参数可信吗"，聚合到模型一级就够了。
   */
  if (filledByModelsDev) out.profileSource = 'modelsdev';
  return out;
}

/**
 * **自动分档** —— 把发现的模型映射到能力档位。
 *
 * ## 为什么用启发式而不是查表
 *
 * 用户要求"自动调研判断模型档次"。**做不到真正测量智商**（那需要跑基准测试，
 * 代价极高且会随版本漂移），所以这里用**可观测的代理指标**。
 *
 * ## 阈值是怎么定的（第一版太宽松，实测后收紧）
 *
 * 第一版用 `reasoning && maxOutputTokens >= 64_000` 判 T3，结果 **72 个模型里
 * 59 个进了 T3** —— 因为现代模型的输出上限普遍很大（`group/*` 动辄 128k+），
 * 于是"顶级推理"这个档位失去了区分度，等于没分。
 *
 * 收紧后的判据（每条都对应一个可观测事实）：
 *
 * | 条件 | 档位 | 理由 |
 * |---|---|---|
 * | `fast === true` | **T1** | 供应商自己标了"快"，不跟它争 |
 * | 名字里有 `flash`/`mini`/… | **T1** | 供应商的命名就是定位声明（实测：`deepseek-v4.1-flash` 输出 128k 但实测 1.5s）|
 * | `reasoning === false` | **T1** | 不会思考 = 体力活（打标、摘要、字段映射）|
 * | `reasoning` 且**思考等级 ≥4 档** | **T3** | 提供了丰富的思考级别 = 旗舰 |
 * | 其余 `reasoning` | **T2** | 会思考但输出能力一般 = 主力分析 |
 *
 * ## ⚠️ 为什么【不用】输出上限判旗舰（这条注释曾经与代码不符）
 *
 * 第一版用「输出 ≥128k」判 T3，后来**去掉了**，但注释没同步删 —— 于是
 * 文档承诺了一条代码不执行的条件（复核发现）。
 *
 * 去掉它的实测理由：现代模型的输出上限普遍很大（`group/*` 动辄 128k+），
 * 用它判 T3 会让 **72 个模型里 59 个进 T3**，档位失去区分度。
 * **"能写长文"与"很聪明"是两件事。**
 *
 * ⚠️ **这仍然只是"初判"**：真正的档位由运行期的**实测延迟与成功率**修正
 *（见 `ModelHealthRegistry`）。启发式只负责"新模型上线时先给它一个合理位置"，
 * 避免"新模型没人用"或"新模型被当成顶级模型去辩论"。
 */
export function inferTier(m: DiscoveredModel): 'T1_fast' | 'T2_mid' | 'T3_deep' {
  /* 供应商自己标了"快"—— 尊重它，不进推理档。 */
  if (m.fast) return 'T1_fast';

  /*
   * **名称信号**：供应商给模型起的名字就是它的定位声明。
   *
   * 加这一条的直接原因是实测：`workbuddy-ai/deepseek-v4.1-flash` 的
   * `max_output_tokens` 是 **128000**，仅凭"输出大"会被判成 T3（旗舰），
   * 而它其实是**最快的那个**（实测 1.5s）—— 名字里的 `flash` 才是真相。
   *
   * **只看输出上限会把"能写长文"误当成"很聪明"**，这两件事无关。
   */
  const name = m.id.toLowerCase().replace(/\./g, '-');
  /*
   * ⚠️ **短词要收窄，否则会误伤**（复核发现 P2-G，已实测）：
   *
   *   误判为 T1：`provider/mini-max`、`provider/mini_pilot`、`a/b_mini_c`、`provider/nano-1`
   *   正确放过：`minimax`、`minimax-m2`、`nanotron-x`、`flashlight`、`fastest-llm`
   *
   * `mini` 后面若接 `max`（无论中间有没有分隔符），那都不是"迷你模型"的意思 ——
   * 所以用 `(?![\-_]?max)` 把 `minimax` 与 `mini-max` **两种写法都排除**。
   *
   * （第一版只写了 `(?!max)`，实测漏掉了 `mini-max` —— 因为它的 `mini` 后面
   *  是 `-` 而不是 `m`。**两种写法都得挡**，否则这种命名一上线就会被塞进快档
   *  去干需要智商的活。）
   */
  if (/(^|[/\-_])(flash|mini(?![\-_]?max)|lite|lightning|turbo|fast|small|nano)([/\-_]|$)/.test(name)) {
    return 'T1_fast';
  }

  /* 不会思考就是体力活。 */
  if (!m.reasoning) return 'T1_fast';

  /*
   * 旗舰判据：给了丰富的思考等级（≥4 档）。
   *
   * 实测佐证：`group/auto-gpt-6-astra` 报了 **6 档**
   *（low/medium/high/xhigh/max/ultra），而普通思考模型只报 2–3 档 ——
   * "愿意暴露更多思考级别"是能力的一个可观测信号，且**比输出上限可靠**
   *（输出上限普遍很大，没有区分度）。
   */
  if (m.reasoningLevels.length >= 4) return 'T3_deep';

  /* 其余会思考的归中档（主力分析）。 */
  return 'T2_mid';
}

/** 发现结果 + 分档，供 `modelCatalog` 动态构建候选链。 */
export interface DiscoveredCatalog {
  models: DiscoveredModel[];
  /** 档位 → 模型 id 列表（按"免费优先 + 上下文能力"排序）。 */
  byTier: Record<'T1_fast' | 'T2_mid' | 'T3_deep', string[]>;
  /** 发现时刻（epoch ms）。 */
  discoveredAt: number;
  /** 这一轮发现里的新面孔（相对上一次），用于"自动发现新模型"。 */
  appeared: string[];
  /** 这一轮消失的模型（相对上一次），用于告警。 */
  disappeared: string[];
  /**
   * **被判定为"过时/重复"而剔除的模型**（2026-10-13 加）。
   *
   * 用户报过「我看到很多这种**调用过时模型**的情况」——
   * 所以"剔了谁、被谁取代、为什么"必须留痕，否则那件事仍然无法追溯。
   */
  superseded: Array<{ id: string; by: string; reason: string }>;
}

/**
 * 从**三个**数据源构建目录。
 *
 * @param wirePayload `GET /v1/models` 的响应体
 * @param pluginProvidersPath `plugin-providers.json` 的路径；读不到时降级为"只有基础信息"
 * @param previous 上一次的目录（用于算 `appeared` / `disappeared`）
 * @param modelsDev **models.dev 的查询入口**（可选）。
 *
 * ## ⚠️ 为什么它排在最后且可选
 *
 * 它是**第三优先级**的来源（只补前两者拿不到的空缺），而"没有它"必须是一个
 * **完全可用**的状态 —— 离线部署、拉取失败、还没建快照，都会走到这条路径。
 * 所以它不能在参数表中间（那样会逼着所有调用点都传一个 `null`），
 * 也不能影响任何既有行为（既有测试全部不传它，行为必须逐字不变）。
 */
export function buildCatalog(
  wirePayload: unknown,
  pluginProvidersPath: string | null,
  previous?: DiscoveredCatalog | null,
  modelsDev?: ModelsDevLookup | null,
): DiscoveredCatalog {
  const wire = parseWireModels(wirePayload);
  let limits = new Map<string, { free: boolean | null; rate: number | null; released: string; fast: boolean }>();
  if (pluginProvidersPath !== null) {
    try {
      limits = parsePluginLimits(JSON.parse(readFileSync(pluginProvidersPath, 'utf8')));
    } catch {
      /* 读不到配置不是致命错误 —— 只是分不出免费/付费（`free` 保持 null）。 */
      limits = new Map();
    }
  }
  const models = mergeDiscovered(wire, limits, modelsDev ?? null);

  const byTier: DiscoveredCatalog['byTier'] = { T1_fast: [], T2_mid: [], T3_deep: [] };
  for (const m of models) {
    /* 路由组也进候选链 —— 它自带 magpie 的组内故障转移。 */
    byTier[inferTier(m)].push(m.id);
  }
  /*
   * ── 排序（**这是实际生效的那一份**）────────────────────────────────────
   *
   * ## ⚠️ 第一版的排序被实测推翻（2026-10-12）
   *
   * 原来是「**免费优先 → 上下文大**」。实测后果很具体：
   *
   * ```
   *   technical（T1 档，本该是体力活）实测耗时 206 秒
   * ```
   *
   * 因为它选中了 `cline/cline-free/mimo-v2.6-flash` —— 一个**思维链模型**。
   * 而"上下文大"这个判据与"快"**毫无关系**（甚至负相关：上下文大的模型
   * 往往更重）。于是体力活被派给了最慢的那一批。
   *
   * ## 现在的口径：**先按"会不会思考"分层，再按免费与上下文**
   *
   * | 档位 | 排序键 |
   * |---|---|
   * | **T1**（体力活）| **不会思考的优先** → 免费 → 上下文 |
   * | **T2**（分析）| 免费 → 不会思考的优先 → 上下文 |
   * | **T3**（判断）| 会思考的优先 → 上下文（免费只是加分）|
   *
   * 为什么 T1 把"不会思考"放第一位：思维链模型在打标/摘要这类活上**既慢
   * 又容易被自己的推理带偏**（实测它们会把"我先去取数"写进输出）。
   * 而 T1 的工作量最大（每轮 4 个分析师），它的速度**直接决定整轮耗时**。
   */
  const freeOf = new Map(models.map((m) => [m.id, m.free]));
  const ctxOf = new Map(models.map((m) => [m.id, m.contextTokens]));
  const reasoningOf = new Map(models.map((m) => [m.id, m.reasoning]));

  /*
   * ⚠️ **元数据缺失的模型要降权**（2026-10-12 实测踩到）。
   *
   * 实测：`opencode-go/omen-alpha` 在网关的 `/v1/models` 里
   * **既没有 `context_length` 也没有 `max_output_tokens`**：
   *
   * ```
   *   opencode-go/omen-alpha  context=- maxOut=- reasoning=false levels=0
   * ```
   *
   * 而它因为"不思考"被排到了 **T1 首选**，然后：
   *   ① 返回空内容（`finish_reason=length`，输出被长度上限截断）；
   *   ② 重试 2 次仍空；
   *   ③ 降级到思维链模型（慢）；
   *   ④ **一个角色耗时 242 秒** —— 整轮因此跑不完。
   *
   * ## 为什么"缺元数据"该降权
   *
   * 我们的整套预算逻辑（`budgetFor`）建立在 `max_output_tokens` 上 ——
   * 它缺失时我们**无法为这个模型算出一个安全的输出预算**，
   * 而"算不出来"的表现就是**输出被截断**（空内容）。
   *
   * 换句话说：**缺元数据 = 不可预测**。不可预测的模型不该当首选。
   *
   * 判据用 `contextTokens > 0`：网关给了上下文长度说明它**至少报了基本能力**。
   */
  const metaOf = new Map(models.map((m) => [m.id, m.contextTokens > 0]));

  /* `all`（全免费）→ `some`（有免费容量）→ `unknown` → `none`。 */
  const rank: Record<FreeStatus, number> = { all: 0, some: 1, unknown: 2, none: 3 };

  for (const tier of Object.keys(byTier) as Array<keyof typeof byTier>) {
    byTier[tier].sort((a, b) => {
      const ra = reasoningOf.get(a) === true ? 1 : 0;
      const rb = reasoningOf.get(b) === true ? 1 : 0;
      const fa = rank[freeOf.get(a) ?? 'unknown'];
      const fb = rank[freeOf.get(b) ?? 'unknown'];
      /*
       * ⚠️ **元数据缺失的一律排最后** —— 见上面 `metaOf` 的说明。
       *
       * 放在所有其它判据**之前**：一个连上下文长度都不报的模型，
       * 无论它"看起来"多快、多免费，都**不可预测** ——
       * 而实测代价是"一个角色 242 秒 + 整轮跑不完"。
       */
      const ma = metaOf.get(a) === true ? 0 : 1;
      const mb = metaOf.get(b) === true ? 0 : 1;
      if (ma !== mb) return ma - mb;

      /*
       * ── ⭐ **magpie 路由组优先**（2026-10-12，用户明确提过这件事）────────
       *
       * 用户的原话：
       *
       * > 「magpie 里面的**智能路由模式很好用，你可以利用起来避免你重复造轮子**」
       *
       * ## 为什么它该排最前
       *
       * 路由组（`group/auto-*`）**自带跨供应商故障转移** ——
       * 一家供应商额度耗尽时，magpie 自己会换一家，**不需要我们逐个去试**。
       *
       * 实测代价（第 33–35 轮）：`workbuddy-ai` 整家额度耗尽，而它占据
       * T1 候选链前 5 位 → 每轮都要先撞 1–4 次才能落到活着的模型上，
       * 而"撞"本身要等超时 → **一轮 7 分钟、常常跑不完**。
       *
       * 把路由组排前面之后，这种"某家死了"的情况**由 magpie 处理**，
       * 我们的候选链只需要处理"整档都不可用"的降级。
       *
       * **这正是"不重复造轮子"** —— 故障转移是 magpie 的原生能力。
       */
      const ga = a.startsWith('group/') ? 0 : 1;
      const gb = b.startsWith('group/') ? 0 : 1;
      if (ga !== gb) return ga - gb;

      if (tier === 'T1_fast') {
        /* 体力活：**速度优先** —— 不会思考的排前面。 */
        if (ra !== rb) return ra - rb;
        if (fa !== fb) return fa - fb;
      } else if (tier === 'T2_mid') {
        /* 分析：免费与速度并重。 */
        if (fa !== fb) return fa - fb;
        if (ra !== rb) return ra - rb;
      } else {
        /* T3：**能力优先** —— 会思考的排前面（质量直接决定盈亏）。 */
        if (ra !== rb) return rb - ra;
        if (fa !== fb) return fa - fb;
      }
      return (ctxOf.get(b) ?? 0) - (ctxOf.get(a) ?? 0);
    });
  }

  /*
   * ══════════════════════════════════════════════════════════════════════
   *  ⭐ **剔除"过时版本"与"同供应商别名"**（2026-10-13）
   * ══════════════════════════════════════════════════════════════════════
   *
   * ## 用户的要求（原话）
   *
   * > 「我看到很多这种**调用过时模型**的情况…**不能使用过时淘汰的模型**
   * >  （这个功能需要**你自己想办法解决**，因为模型随时都会更新新版本，
   * >  **我不可能一直盯着出新版本让你改，而是系统会自己发现，自己更改，自动替换淘汰**）」
   *
   * ## 为什么放在这里（而不是维护一份硬编码清单）
   *
   * 这个函数是**唯一的模型清单入口** —— 它每次从网关实时拉。
   * 所以在这里按"清单里有什么"做判断，就**天然满足"系统自己发现"**：
   * 模型一更新，下一次刷新就自动生效，**不需要任何人改代码**。
   *
   * 判据全部在 `modelFamilies.ts`（纯函数、10 条测试），规则是：
   * ```
   *   ① 同一供应商 + 同家族 + 同型号 → 只留最高版本
   *   ② 同一供应商的无版本别名 → 与它的最高版本重复，剔掉
   * ```
   * ⚠️ **跨供应商不算重复** —— 它们是冗余（各有额度），必须都留。
   *
   * ## 为什么要过滤 `models` 与 `byTier` **两者**
   *
   * `byTier` 是候选链的实际来源；而 `models` 是"目录"（界面上会显示、
   * 别处也会读）。**只过滤一个会导致"目录里看得到、候选链里没有"** 这种
   * 自相矛盾 —— 而那正是本项目反复踩过的那类问题（说了但不生效）。
   */
  const { kept, removed } = filterSuperseded(models.map((m) => m.id));
  const keptSet = new Set(kept);
  const liveModels = models.filter((m) => keptSet.has(m.id));
  for (const tier of Object.keys(byTier) as Array<keyof typeof byTier>) {
    byTier[tier] = byTier[tier]!.filter((id) => keptSet.has(id));
  }
  /*
   * ⚠️ **剔除明细要留痕** —— 否则"某个模型为什么不在候选链里"无法追溯，
   * 而那正是用户这次报的问题（他只看到"调用了过时模型"，看不到原因）。
   */
  const superseded = removed.map((r) => ({ id: r.id, by: r.by, reason: r.reason }));

  const prevIds = new Set((previous?.models ?? []).map((m) => m.id));
  const nowIds = new Set(liveModels.map((m) => m.id));

  return {
    models: liveModels,
    byTier,
    discoveredAt: Date.now(),
    appeared: previous ? liveModels.filter((m) => !prevIds.has(m.id)).map((m) => m.id) : [],
    disappeared: previous ? [...prevIds].filter((id) => !nowIds.has(id)) : [],
    superseded,
  };
}
