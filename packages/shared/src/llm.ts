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
    models: ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-reasoner'],
    openAiCompatible: true,
    jsonMode: 'json_object',
    docsUrl: 'https://api-docs.deepseek.com/',
    modelsPath: '/models',
    modelsAuth: 'bearer',
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
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
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
    models: ['qwen-max', 'qwen-plus'],
    openAiCompatible: true,
    jsonMode: 'json_object',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/',
    modelsPath: '/models',
    modelsAuth: 'bearer',
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
    docsUrl: 'https://docs.x.ai/api',
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
    models: [],
    openAiCompatible: true,
    jsonMode: 'json_object',
    docsUrl: 'https://platform.moonshot.cn/docs/api/chat',
    modelsPath: '/models',
    modelsAuth: 'bearer',
    // Kimi rejects temperature/top_p outright on current models and the client
    // omits them; the value here only seeds the form.
    defaults: { temperature: 0.2, maxTokens: 8192, timeoutSeconds: 180, maxRetries: 2 },
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
      maxTokens: 8192,
      timeoutSeconds: 180,
      maxRetries: 2,
    }
  );
}

/**
 * Heuristic for "is this likely one of the slow reasoning models?".
 *
 * Used to raise the suggested timeout — and, more importantly, to warn when the
 * output cap is small enough that the model would spend the whole budget on its
 * thinking and return nothing. That failure looks like an empty completion and
 * is otherwise very confusing to debug.
 */
export function looksLikeReasoningModel(modelId: string): boolean {
  return /(^|[-_/])(o[1-9]|r1|reasoner|reason|think|thinking|deepseek-v\d+-pro|opus|qwq)/i.test(
    modelId,
  );
}
