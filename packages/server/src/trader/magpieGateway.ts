/**
 * **magpie 网关调用工厂** —— 把 `ModelRouter` 的"按模型名调用"接到真实网络上。
 *
 * ## 为什么需要它（架构上的一个真实缺口）
 *
 * 现有 `LlmClient` 是「**一条 `ai_models` 记录 = 一个供应商 + 一个模型**」的形态：
 * `provider` / `apiKey` / `baseUrl` / `model` 都来自那一行。
 *
 * 而 magpie 是**一个网关 + 705 个模型**：同一个 baseUrl 与 key，
 * 靠**请求体里的 model 名**（`workbuddy-ai/gpt-6-astra` 这种 `provider/model` 形式）
 * 切换目标。**一对多的关系用一对一的记录表达不了** ——
 * 那就是本文件要补的东西。
 *
 * ## 设计：一个"网关记录" + 动态模型名
 *
 * 用户只需在「AI 模型」里加**一条** magpie 记录
 *（baseUrl=`http://127.0.0.1:3425/v1`、key=网关 key、model 随便填一个占位），
 * 团队模式就拿它当**出口**，模型名由角色路由在运行时决定。
 *
 * 这样做的理由：
 *
 *   · **不重复造轮子** —— 模型列表、额度、路由、协议翻译全在 magpie 里（用户已配好）；
 *   · **不新增配置概念** —— 复用现有的 `ai_models` 表与界面，用户不用学新东西；
 *   · **可回退** —— 网关挂了/想换供应商，改那一条记录即可，代码不用动。
 *
 * ## 协议选择：统一走 OpenAI 兼容
 *
 * magpie 会把 OpenAI Chat / Responses / Anthropic / Gemini **互相翻译**
 *（实测确认：调研报告记录了四种协议互转）。
 * 所以这里**统一用 OpenAI 兼容端点**，由 magpie 负责翻译 ——
 * 我们不需要按模型名去猜该用哪种协议（那正是 2026-10-10 那个 bug 的来源：
 * 按模型名前缀改道，把非 opencode 的网关也一起改坏了）。
 */

import { LlmClient } from '../llm/client.js';
import type { CallModel } from '../llm/modelRouter.js';
import { buildCatalog, type DiscoveredCatalog, type ModelsDevLookup } from '../llm/modelDiscovery.js';

/** magpie 网关的连接参数（来自一条 `ai_models` 记录）。 */
export interface MagpieGatewayConfig {
  /** 网关基址，如 `http://127.0.0.1:3425/v1`。 */
  baseUrl: string;
  /** 网关 key（`sk-magpie-…`）。 */
  apiKey: string;
  /** 单次请求超时（秒）。 */
  timeoutSeconds: number;
  /** 单模型内的重试次数（跨模型的降级由 `ModelRouter` 负责）。 */
  maxRetries: number;
  /** 温度。 */
  temperature: number;
  /**
   * `plugin-providers.json` 的路径 —— **限量/不限量的标注只在那里**。
   *
   * `/v1/models` 只给 context / reasoning / 思考等级，**没有 `free` 也没有 `cost`**
   *（2026-10-12 实测确认）。所以自动发现必须两处数据合并，否则分不出
   * "免费不限量"与"消耗积分"—— 而那正是"合理安排使用"的依据。
   *
   * `null` = 读不到（降级为"不知道"，`free` 为 `unknown`，不猜）。
   */
  pluginProvidersPath?: string | null;
}

/**
 * 从网关拉一次模型目录 —— **自动发现的入口**。
 *
 * ## 它解决的是用户提的哪个问题
 *
 * 用户 2026-10-12 的原话：
 *
 * > 「万一今天能用，明天不能用、改了名字或者限量了，又或者**突然上线了什么模型**
 * >  （假如系统运行中这个提供商增加了一个模型，很好用智商高，**系统是否会自动发现，
 * >  自动调研判断模型档次，然后应用到相应的智能体中**）」
 *
 * 这个函数负责前两步（发现 + 分档）。第三步"应用到智能体"由调用方
 * （`manager.buildTeamModel`）把结果喂给 `ModelRouter` 完成。
 *
 * ## 为什么失败不抛错
 *
 * 拉目录是一次网络请求，失败原因（网关重启、key 失效）都不该让机器人起不来 ——
 * 与 `buildModel` 探测失败同一个原则（用户 2026-10-10：「模型用尽那你启动以后
 * 页面上提示就行了」）。**返回 `null` = 用静态档案兜底。**
 */
export async function discoverFromGateway(
  gateway: MagpieGatewayConfig,
  options: { signal?: AbortSignal; modelsDev?: ModelsDevLookup | null } = {},
): Promise<DiscoveredCatalog | null> {
  try {
    /* `/v1/models` 的路径：baseUrl 可能带 `/v1` 也可能不带。 */
    const base = gateway.baseUrl.replace(/\/+$/, '');
    const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${gateway.apiKey}` },
      signal: options.signal ?? AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const payload: unknown = await res.json();
    /*
     * ⚠️ **第 4 个参数是 models.dev 的查询函数**（2026-10-14 接上）。
     *
     * 它补的是**运行时拿不到的客观参数**：`cost`（定价）、`knowledge`（知识截止）、
     * `tool_call`、`structured_output`、`canonical_model_id`。
     * `modelDiscovery.ts` 文件头的表格已经把缺口写清楚了：
     * ```
     *   GET /v1/models（运行时可达）| context / max_output / reasoning / modalities
     *                             | 【没有 free、没有 cost】
     * ```
     *
     * ⚠️ **它只填空缺，绝不覆盖 `/v1/models` 已给出的值** —— 那有实测代价为据：
     * `opencode-go/omen-alpha` 在网关侧 `context=- maxOut=-`，若拿上游目录去
     * "修正"网关值，会给一个**网关没申报预算能力**的模型算出安全预算，
     * 结果是 `finish_reason=length` + 空内容 + 一个角色卡 242 秒。
     * 见 `mergeDiscovered` 里 `applyModelsDev` 的注释。
     *
     * ⚠️ 传 `null` 是完全合法的（还没拉到快照时）—— 那只是"这次不补参数"，
     * 不是错误。所以调用方不需要 try/catch，也不该因此让机器人起不来。
     */
    return buildCatalog(payload, gateway.pluginProvidersPath ?? null, null, options.modelsDev ?? null);
  } catch {
    return null;
  }
}


/**
 * 输出预算的**下限**。
 *
 * ⚠️ 实测：思维链模型的 `reasoning_content` 与正文**共享** `max_tokens`，
 * 预算太小会得到 `content: null`（`gpt-6-astra` 在 mt=16/128 时就是这样）。
 * `ModelRouter.budgetFor` 会对思维链模型再乘一个倍数，这里保证起点不至于太小。
 */
const MIN_OUTPUT_BUDGET = 2_048;

/**
 * 造一个"按模型名调用 magpie"的函数。
 *
 * ⚠️ **每个模型名一个 `LlmClient` 实例，并缓存起来。**
 *
 * 为什么必须缓存：`LlmClient` 有**实例内状态** —— `timeoutCount`（超时计数，
 * 驱动思考等级降档）与 `streamDisabled`（流式被拒后自我降级）。
 * 每轮新建实例会让这些状态永远归零，于是"同一个模型反复超时"永远不会被记住，
 * 思考等级也永远不会降档。**那些降级机制会静默失效。**
 *
 * 但缓存**不跨模型**：一个模型的状态不该影响另一个（这正是
 * 考古报告 H2「单模型单客户端」要修的东西）。
 */
export function createMagpieCallFactory(gateway: MagpieGatewayConfig): CallModel {
  const clients = new Map<string, LlmClient>();

  const clientFor = (modelId: string): LlmClient => {
    const cached = clients.get(modelId);
    if (cached) return cached;
    const client = new LlmClient({
      /*
       * `custom` = 纯 OpenAI 兼容（见文件头「协议选择」）：
       * **不按模型名猜协议**，由 magpie 自己翻译。
       */
      provider: 'custom' as never,
      apiKey: gateway.apiKey,
      model: modelId,
      baseUrl: gateway.baseUrl,
      temperature: gateway.temperature,
      timeoutSeconds: gateway.timeoutSeconds,
      maxRetries: gateway.maxRetries,
    });
    clients.set(modelId, client);
    return client;
  };

  return async (modelId, messages, options) => {
    const client = clientFor(modelId);
    const result = await client.chat(messages, {
      ...(options.signal ? { signal: options.signal } : {}),
      maxTokens: Math.max(options.maxTokens, MIN_OUTPUT_BUDGET),
    });
    return {
      text: result.text,
      latencyMs: result.latencyMs,
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        cachedTokens: result.usage.cachedTokens,
        reasoningTokens: result.usage.reasoningTokens,
      },
      /*
       * ⚠️ **必须透传 `finishReason`** —— 它是路由器区分两种"空内容"的唯一依据：
       *
       *   · `'length'` → 被 token 上限截断 → **加大预算重试同一模型**
       *   · 其他       → 真的空回复       → 重试，仍空则降级
       *
       * 漏掉这一行，路由器那条"被截断就加大预算"的分支**永远不会命中**
       *（因为它只看得到 `undefined`）—— 而症状是"最强那个模型总是被跳过"，
       * 从表面完全看不出原因。
       */
      finishReason: result.finishReason ?? null,
    };
  };
}

/**
 * 判断一条 `ai_models` 记录**是不是 magpie 网关**。
 *
 * ## 为什么要判这个（而不是让用户去配一个"模式"开关）
 *
 * 判据是 **baseUrl 指向 magpie 网关** —— 这是**可从配置推断的事实**，
 * 不需要用户多勾一个复选框。多一个开关就多一个"配错了还不知道为什么"的机会
 *（本项目反复出现的失败形态）。
 *
 * 认两种写法：显式端口 `:3425`，或路径含 `/mcp/magpie`（用户给的搜索 MCP 地址
 * 也是这个网关的）。
 */
export function looksLikeMagpieGateway(baseUrl: string): boolean {
  const url = baseUrl.trim().toLowerCase();
  if (url.length === 0) return false;
  return url.includes(':3425') || url.includes('/magpie/');
}
