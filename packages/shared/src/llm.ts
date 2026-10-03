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
     * `maxTokens` **65536**。
     *
     * ## 为什么从 16384 提到这里（实测逼出来的，不是调优）
     *
     * 原来的理由是「官方最大输出 384K，而实测输出峰值 11487 —— 2 倍余量」。
     * **那个"峰值"是在没有截断问题的时候测的**，而它漏掉了一件后来才看清的事：
     *
     * **带思考的模型，思考会先吃掉绝大部分输出预算。** 实测一轮失败的长这样：
     *
     * ```
     * completion_tokens 38670（两次调用之和）
     * 思考             93%
     * 两次正文分别      0 与 1743 字符
     * ```
     *
     * 也就是说 16384 里**只剩约 1,150 token 留给正文** —— 写不出那个必须结尾的
     * `<decision>` 块。机器人于是报「模型输出被截断」，而**它其实一直在正常思考**，
     * 只是没有预算把结论写出来。
     *
     * 实测这个网关对四档都返回 200（16384 / 32768 / 65536 / 131072），所以
     * 65536 既能容下 93% 的思考、也留出足够的正文空间。
     *
     * ⚠️ **不要只因为"更大更安全"就继续调大**：超出模型上限的 `max_tokens` 会被
     * 服务商直接拒掉，而那种失败比截断更难查（请求根本没发出去）。
     */
    defaults: { temperature: 0.2, maxTokens: 65536, timeoutSeconds: 300, maxRetries: 2 },
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
    /*
     * Command Code —— 聚合网关（一个 Key 转发多家模型）。
     *
     * 配置项**全部来自实测**（2026-09-19 用真实 Key 调过），不是照文档抄的：
     *
     *   · `GET {base}/models` → **HTTP 200，71 个模型**
     *   · 认证：`Authorization: Bearer <key>`
     *   · 模型名形如 `deepseek/deepseek-v4.1-flash`、`claude-sonnet-5`
     *
     * 它此前只能靠 `custom` 手工填 baseUrl 才能用 —— 而生产上确实就是这么跑的。
     * 做成内置之后，用户只要填一个 Key。
     */
    id: 'commandcode',
    label: 'Command Code（聚合网关）',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    authStyle: 'bearer',
    /*
     * **故意留空。** 71 个模型、而且会随上游变动（列表里 12 个里就有
     * `gpt-5.6-sol` / `claude-opus-5` 这种刚发布的）——
     * 手抄一份必然过期，而**过期的模型名只在运行时失败**。
     * 有 Key 时走 `/models` 的实时结果即可。
     */
    models: [],
    openAiCompatible: true,
    jsonMode: 'json_object',
    docsUrl: 'https://commandcode.ai/docs/provider',
    modelsPath: '/models',
    modelsAuth: 'bearer',
    /*
     * 与 `custom` 同档：网关背后常常是推理模型，而思考与回答**共用同一个
     * 输出预算**。实测这个项目的决策输出峰值 11487 —— 8192 会把回答截断成空，
     * 那看起来像密钥坏了，不像预算不够。
     */
    defaults: { temperature: 0.2, maxTokens: 16384, timeoutSeconds: 240, maxRetries: 2 },
    supportsThinking: true,
  },
  {
    /*
     * ── OpenCode GO（2026-10-04 内置）────────────────────────────────────
     *
     * 用户的原话：「**AI 提供商内置一个 opencode go** …… 如图所示，我使用自定义添加的
     * 无法使用，**你根据文档内置一个，以后我只用填 KEY 就能正常使用**」。
     *
     * ## 为什么"自定义 OpenAI 兼容端点"填不出可用配置
     *
     * 他试过，报的是：
     *
     * ```text
     * Request is missing x-opencode-session and cannot be routed efficiently.
     * ```
     *
     * 那个头**自定义端点填不了** —— 那里只有 API Key + 基础 URL 两个输入框。
     *
     * ## 但那一轮排查还发现了一件更重要的事
     *
     * 他当时填的 `base_url` 是 **`https://opencode.ai/zen/go/v1/chat/completions`**，
     * 而客户端会在这个基址后面**再拼一次** `/chat/completions` —— 于是变成
     * `.../v1/chat/completions/chat/completions`。**路径错了，而服务端回的是
     * 那句关于 session 头的报错，把人引向了错误的方向。**
     *
     * 我用 `https://opencode.ai/zen/go/v1` 直接实测（2026-10-04，用他当时存的那把 Key）：
     *
     * ```text
     * GET  /v1/models             → 200（带与不带 session 头都通）
     * POST /v1/chat/completions   → 200（带 session 头，正常返回 deepseek-flash）
     * ```
     *
     * 所以内置值把**两件事都定好**：正确的基址 + 那个头。
     * **用户只需要填 Key。**
     *
     * ## 关于 `x-opencode-session` 的值
     *
     * 它的用途是**会话粘性路由** —— 把同一个会话的请求送到同一个后端
     * （多个上游实现都在补这个头，见 `earendil-works/pi#9230`、
     * `openclaw/openclaw#137464`）。所以**任意稳定、非空的字符串**即可，
     * 关键是"每次请求都一样"。这里用固定的 `auto-quant`：单实例部署下，
     * 所有请求本就属于同一个会话，而且重启后仍然一致。
     *
     * ⚠️ 实测**不带这个头也能通**（至少在那天、那台服务器上）。但既然文档明确要求、
     * 而代价只是多一个 header，就照文档带上 —— 这类"上游随时可能收紧"的隐性要求，
     * 等它真的变成硬要求时才发现，表现会是"昨天还好好的"。
     */
    id: 'opencode',
    label: 'OpenCode GO',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    authStyle: 'bearer',
    /*
     * 留给"还没填 Key"时展示。有 Key 时以 `/models` 的实时结果为准 ——
     * 实测它返回的第一批是 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 等，
     * 而 `deepseek-flash` 这个别名也是可用的（实测路径走通的就是它）。
     */
    models: ['deepseek-flash'],
    openAiCompatible: true,
    jsonMode: 'json_object',
    docsUrl: 'https://opencode.ai/docs/go/',
    modelsPath: '/models',
    modelsAuth: 'bearer',
    /* 与聊天请求同一个头 —— 见 `openaiCompatible.buildRequest` 里的说明。 */
    modelsHeaders: { 'x-opencode-session': 'auto-quant' },
    /*
     * 与 `commandcode` / `custom` 同档：网关背后是推理模型，**思考与正文共用输出预算**，
     * 而本系统的提示词很大（实测 5 万–28 万 tokens）且以 high 推理强度运行。
     * 16k 会被思考吃满、正文一个字不剩，而那看起来像"这一轮没什么可做的"。
     */
    defaults: { temperature: 0.2, maxTokens: 65536, timeoutSeconds: 600, maxRetries: 2 },
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
    // 64k：**推理与正文共用这个额度**，而本系统的提示词很大（实测 5 万–28 万
    // tokens）且以 `reasoningEffort: high` 运行 —— 推理量随之增长。16k 实测会被
    // 推理吃满、正文一个字不剩（`completion_tokens === reasoning_tokens === 16384`），
    // 而那在操作台上看起来只是"这一轮没什么可做的"，不像一次截断。
    // 这个数只是**上限**，不会让正常调用变贵。
    //
    // ⚠️ **超时从 240 提到 600（2026-10-01）。** 240 秒撞到过真实请求：
    // 一轮提示词约 190K tokens + 2 万推理 tokens，实测单次耗时 45s–332s，
    // 而超时被归类成"AI 服务不可用"（`#1621` 的原始错误是
    // `commandcode request exceeded 240000ms`）—— 操作员读到的却是"上游故障"，
    // 于是他单独用 API 测上游时发现它是好的。**"我们跑得慢"和"上游挂了"
    // 是两条完全不同的诊断路径，不该共用一个错误文案。**
    defaults: { temperature: 0.2, maxTokens: 65536, timeoutSeconds: 600, maxRetries: 2 },
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
       * 兜底值也与上面各 provider 对齐到 65536（原来是 16384）。
       *
       * 当前**用不到**它（10 个 provider 全都声明了 `defaults`），所以这里
       * 改的是一个"将来会生效"的值：有人加了新 provider 却忘了写 defaults 时，
       * 一个偏小的值会让这个机器人的决策被推理吃空 —— 而那种故障
       * **看起来像密钥坏了**，不像是从这里的数字来的。
       *
       * 65536 而不是 16384：16384 已被实盘证明不够（见上面 `custom` 那条注释）。
       */
      maxTokens: 65536,
      /* 兜底也提到 300：与各 provider 的实际取值（300–600）保持同一量级。 */
      timeoutSeconds: 300,
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
