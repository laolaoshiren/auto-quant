import type { LlmProviderDescriptor, LlmProviderId } from './domain.js';

/**
 * Provider catalogue.
 *
 * ## Why most model lists here are empty on purpose
 *
 * Model identifiers churn fast — a hardcoded list is stale within months, and a
 * stale default fails only at runtime, which is the worst time to find out. So
 * every provider declares **how to list its own models** (`modelsPath` +
 * `modelsAuth`), and the console calls that endpoint with the user's own API
 * key. The `models` array is only a hint for the moment before a key exists.
 *
 * ## 填了值的那些，每条都要写清「核对来源 + 核对日期」
 *
 * 这是这次补充的规则。原来 deepseek / gemini / qwen 三个有值、却**一个注释
 * 都没有** —— 没人知道那是哪一天从哪儿核对的，于是它过期时没人发现，
 * 而**过期的模型名只在运行时失败**。
 *
 * 实测过期的严重程度：gemini 那一条停在 2.5 一代，而当时已经是 3.8；
 * deepseek 用的是一个已被官方标为 legacy 的名字变体。
 *
 * 所以每条都写：**来源 URL + 核对日期 + 官方页面上的关键原文**。
 * 下次有人核对时，他知道上一次是什么时候、该去看哪一页。
 *
 * ## `modelsAuth` mapping
 *
 *  - `bearer`    — `Authorization: Bearer <key>` (every OpenAI-compatible API)
 *  - `x-api-key` — `x-api-key: <key>` plus `anthropic-version` (Anthropic)
 *  - `query-key` — `?key=<key>` (Google Gemini)
 */
export const LLM_PROVIDERS: readonly LlmProviderDescriptor[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    authStyle: 'bearer',
    // DeepSeek's base URL deliberately has no `/v1`, and `/models` sits at the root.
    /*
     * 内置建议 —— **不是权威值**，有 API Key 时以 `/models` 的实时结果为准。
     *
     * 核对来源：https://api-docs.deepseek.com/quick_start/pricing
     * 核对日期：2026-09-19
     *
     * 官方原文：「Use `deepseek-flash` as the model name. The legacy names
     * `deepseek-v4-flash` … are still accepted, but the corresponding models
     * have been retired」。
     *
     * 所以这里原来写的 `deepseek-v4.1-flash` 是一个**已退役名字的变体** ——
     * 它今天还能用（被转发到 flash），但依赖一个明确标为 legacy 的别名
     * 不是好主意。`deepseek-reasoner` 也已从定价页移除。
     */
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    openAiCompatible: true,
    jsonMode: 'json_object',
    docsUrl: 'https://api-docs.deepseek.com/',
    modelsPath: '/models',
    modelsAuth: 'bearer',
    /*
     * `maxTokens` 16384：官方模型表给出的最大输出是 **384K**，所以这个值
     * 离上限很远、不会被拒；而实测输出峰值 11487 —— 2 倍余量。
     */
    defaults: { temperature: 0.2, maxTokens: 16384, timeoutSeconds: 180, maxRetries: 2 },
    supportsThinking: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authStyle: 'bearer',
    // Deliberately empty. OpenAI's line-up changes constantly, so we ask the API
    // instead of guessing, and typing an id by hand always works too.
    models: [],
    openAiCompatible: true,
    jsonMode: 'json_schema',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    modelsPath: '/models',
    modelsAuth: 'bearer',
    defaults: { temperature: 0.2, maxTokens: 16384, timeoutSeconds: 180, maxRetries: 2 },
    supportsThinking: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    authStyle: 'x-api-key',
    models: [],
    openAiCompatible: false,
    jsonMode: 'none',
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
    modelsPath: '/models',
    modelsAuth: 'x-api-key',
    modelsHeaders: { 'anthropic-version': '2023-06-01' },
    defaults: { temperature: 0.2, maxTokens: 16384, timeoutSeconds: 180, maxRetries: 2 },
    supportsThinking: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authStyle: 'query-key',
    /*
     * 内置建议。核对来源：https://ai.google.dev/gemini-api/docs/models
     * 核对日期：2026-09-19 —— 当时已在 **3.8** 一代（原值 2.5 严重过期）。
     *
     * 取 stable 的 flash 与 preview 的 pro：前者是这个产品的主力
     * （低延迟、成本低），后者是能力上限。
     */
    models: ['gemini-3.8-flash', 'gemini-3.1-pro'],
    openAiCompatible: false,
    jsonMode: 'json_schema',
    docsUrl: 'https://ai.google.dev/api/generate-content',
    modelsPath: '/models',
    modelsAuth: 'query-key',
    defaults: { temperature: 0.2, maxTokens: 16384, timeoutSeconds: 180, maxRetries: 2 },
    supportsThinking: true,
  },
  {
    id: 'qwen',
    label: '阿里云通义千问（DashScope）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    authStyle: 'bearer',
    /*
     * 内置建议。核对来源：https://help.aliyun.com/zh/model-studio/models
     * 核对日期：2026-09-19 —— `qwen-max` / `qwen-plus` **仍然有效**（未过期）。
     *
     * 补上 `qwen-flash`：这个产品的每轮请求有 5 万 token 的提示词，
     * 单价比能力更值得考虑，而 flash 正是为这种场景准备的。
     */
    models: ['qwen-max', 'qwen-plus', 'qwen-flash'],
    openAiCompatible: true,
    jsonMode: 'json_object',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/',
    modelsPath: '/models',
    modelsAuth: 'bearer',
    /*
     * ⚠️ **`maxTokens` 留在 8192，而这对本项目可能不够。**
     *
     * 实测决策输出现峰值 **11487**（提示词 5 万 token，输出大部分是思考）。
     * 8192 会把这类回答截断成空内容，那一轮就没有任何决策。
     *
     * **没有按"应该更大"直接抬上去，是因为查不到这个模型的输出上限**：
     * 超出模型上限的 `max_tokens` 会被服务商直接拒掉，那比截断更难查
     * （截断至少留下 `finish_reason = length`）。
     *
     * 自查方式：核对官方模型表里这个模型的 max output，确认 ≥ 16384 之后
     * 再改这个值。
     */
    defaults: { temperature: 0.2, maxTokens: 8192, timeoutSeconds: 180, maxRetries: 2 },
    supportsThinking: false,
  },
  {
    id: 'grok',
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    authStyle: 'bearer',
    models: [],
    openAiCompatible: true,
    jsonMode: 'json_object',
    /*
     * 核对日期：2026-09-19 —— 原值 `https://docs.x.ai/api` 返回 **404**
     * （实测），`/overview` 返回 200。文档链接失效时用户会以为是自己配错了。
     */
    docsUrl: 'https://docs.x.ai/overview',
    modelsPath: '/models',
    modelsAuth: 'bearer',
    defaults: { temperature: 0.2, maxTokens: 16384, timeoutSeconds: 180, maxRetries: 2 },
    supportsThinking: true,
  },
  {
    id: 'kimi',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    authStyle: 'bearer',
    /*
     * 内置建议。核对来源：https://platform.kimi.ai/docs/models
     * 核对日期：2026-09-19。
     *
     * 注意官方页面上那一长串**弃用**名单：`kimi-k2.5` 与整个 `moonshot-v1`
     * 系列已于 2026-08-31 停用、`kimi-k2` 系列于 2026-05-25 停用。
     * 任何还记得旧名字的人（或缓存了旧文档的教程）都会踩这个坑。
     */
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    openAiCompatible: true,
    jsonMode: 'json_object',
    docsUrl: 'https://platform.moonshot.cn/docs/api/chat',
    modelsPath: '/models',
    modelsAuth: 'bearer',
    // Kimi rejects temperature/top_p outright on current models and the client
    // omits them; the value here only seeds the form.
    /*
     * `maxTokens` 从 8192 提到 16384 —— **这不是调优，是修一个会静默失效的值**。
     *
     * 实测这个机器人的 `completion_tokens` 最高到 **11487**（提示词 5 万 token，
     * 输出里大部分是思考）。8192 会把这类回答从中间截断，`finish_reason` 变成
     * `length`、内容为空 —— 而**那一轮就没有任何决策**。
     *
     * 16384 远低于 Kimi K3 的 128K 输出上限，所以不会因为超限被拒；
     * 它只是把一个"必然截断"的值抬到"够用且不浪费"。
     */
    defaults: { temperature: 0.2, maxTokens: 16384, timeoutSeconds: 180, maxRetries: 2 },
    supportsThinking: true,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    authStyle: 'bearer',
    models: [],
    openAiCompatible: true,
    jsonMode: 'none',
    docsUrl: 'https://platform.minimaxi.com/document/guides/chat-model/V2',
    modelsPath: '/models',
    modelsAuth: 'bearer',
    defaults: { temperature: 0.2, maxTokens: 8192, timeoutSeconds: 180, maxRetries: 2 },
    supportsThinking: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter（聚合平台）',
    baseUrl: 'https://openrouter.ai/api/v1',
    authStyle: 'bearer',
    models: [],
    openAiCompatible: true,
    jsonMode: 'json_object',
    docsUrl: 'https://openrouter.ai/docs/api-reference/chat-completion',
    modelsPath: '/models',
    modelsAuth: 'bearer',
    defaults: { temperature: 0.2, maxTokens: 16384, timeoutSeconds: 180, maxRetries: 2 },
    supportsThinking: true,
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容端点',
    baseUrl: '',
    authStyle: 'bearer',
    models: [],
    openAiCompatible: true,
    jsonMode: 'json_object',
    docsUrl: '',
    modelsPath: '/models',
    modelsAuth: 'bearer',
    // 16k rather than 8k: a custom endpoint frequently fronts a reasoning model,
    // and reasoning tokens are drawn from the same budget as the answer. With 8k
    // a heavy prompt leaves nothing for the reply and the call returns empty —
    // which looks like a broken key rather than an exhausted budget.
    defaults: { temperature: 0.2, maxTokens: 16384, timeoutSeconds: 240, maxRetries: 2 },
    supportsThinking: true,
  },
];

export function getProvider(id: LlmProviderId): LlmProviderDescriptor {
  const found = LLM_PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`未知的 LLM 提供商：${id}`);
  return found;
}

/** Default inference settings for a provider. */
export function providerDefaults(id: LlmProviderId): {
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  maxRetries: number;
} {
  return (
    getProvider(id).defaults ?? {
      temperature: 0.2,
      /*
       * 兜底值也与上面各 provider 对齐到 16384。
       *
       * 当前**用不到**它（10 个 provider 全都声明了 `defaults`），所以这里
       * 改的是一个"将来会生效"的值：有人加了新 provider 却忘了写 defaults 时，
       * 8192 会让这个机器人的决策被截断成空响应 —— 而那种故障
       * **看起来像密钥坏了**，不像是从这里的数字来的。
       */
      maxTokens: 16384,
      timeoutSeconds: 180,
      maxRetries: 2,
    }
  );
}

/*
 * 这里原来有一个 `looksLikeReasoningModel(modelId)` —— 靠模型名正则猜
 * "这是不是一个会思考的模型"。**已删除**，理由如下。
 *
 * ## 1. 它从来没有被调用过
 *
 * 全仓库零调用点。注释里说它要用来自动抬高超时、并在输出预算可能被思考
 * 吃光时告警 —— 那两件事都没有实现。它是一段"想做但没做"的遗留。
 *
 * ## 2. 它要解决的问题已经由更好的机制承担
 *
 * "输出预算被思考吃光"的真实症状是 `finish_reason === 'length'` 且内容为空。
 * 现在有两处**从实际响应判断**的处理：
 *
 *   · `llm/client.ts` 的探测路径会识别 `truncated` 并给出明确提示；
 *   · 运行路径在 `finishReason === 'length' && isEmpty` 时记一条 warn，
 *     并附上 `reasoning tokens likely consumed the whole output budget`。
 *
 * **从响应判断**永远比**从名字猜**可靠：它是事实，不是启发式。
 *
 * ## 3. 而且这个正则对新模型名已经全部失效
 *
 * 2026-09-19 核对时，当前在用的 `deepseek-flash`、`kimi-k3`、
 * `gemini-3.8-flash` **一个都不匹配**那个模式。也就是说：即便把它接上，
 * 它对当下最主流的模型也不会生效 —— 而它会**静默地**返回 false，
 * 看起来像"这些模型不需要额外预算"。
 *
 * ## 需要能力信息时该用什么
 *
 *   · `LlmProviderDescriptor.supportsThinking` —— provider **声明**的能力
 *   · `reasoning_effort` 请求参数 —— 显式表达想要多少思考
 *   · `usage.reasoningTokens` —— **实测**值（`normalizeUsage` 会填）
 *
 * 三样都是事实或显式声明，没有一样需要从模型名字里猜。
 */

/* -------------------------------------------------------------------------- */
/*  协议码的中文标签                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Chinese labels for the two protocol codes the provider catalogue stores.
 *
 * Same rule as the `*_LABELS` maps in `domain.ts`: `authStyle` / `jsonMode` are
 * contract values shared with the server (`bearer`, `x-api-key`, `json_object`,
 * `json_schema`, `none`), so **only the display changes**. They live here, next to
 * the descriptors that define them, because that is the only place in the codebase
 * that produces them.
 *
 * The AI 模型 dialog used to render them raw — an operator configuring a custom
 * endpoint read `鉴权方式 bearer · JSON 模式 json_object`, two English codes with
 * no explanation of what they mean for the request being sent.
 */
export const AUTH_STYLE_LABELS: Record<string, string> = {
  bearer: 'Bearer 令牌（Authorization 头）',
  'x-api-key': 'x-api-key 请求头',
  'query-key': 'URL 查询参数',
};

export function authStyleLabel(style: string): string {
  return AUTH_STYLE_LABELS[style] ?? style;
}

export const JSON_MODE_LABELS: Record<string, string> = {
  json_object: 'JSON 对象模式',
  json_schema: 'JSON Schema 模式',
  none: '不支持 JSON 模式',
};

export function jsonModeLabel(mode: string): string {
  return JSON_MODE_LABELS[mode] ?? mode;
}
