import { getProvider, type DiscoveredModel, type LlmProviderId } from '@aq/shared';
import { createLogger } from '../logger.js';
import { classifyHttpError } from './errors.js';

const log = createLogger('llm:discovery');

/* -------------------------------------------------------------------------- */
/*  Result                                                                    */
/* -------------------------------------------------------------------------- */

export interface DiscoverModelsResult {
  ok: boolean;
  models: DiscoveredModel[];
  source: 'live' | 'fallback';
  message: string;
}

/* -------------------------------------------------------------------------- */
/*  Provider response shapes                                                   */
/* -------------------------------------------------------------------------- */

/** `GET /models` on any OpenAI-compatible API, and on OpenRouter. */
interface OpenAiModelsBody {
  data?: Array<{
    id?: string;
    name?: string;
    context_length?: number;
    context_window?: number;
  }>;
}

/** `GET /v1/models` on Anthropic. */
interface AnthropicModelsBody {
  data?: Array<{ id?: string; display_name?: string }>;
}

/** `GET /v1beta/models` on Google Gemini. */
interface GeminiModelsBody {
  models?: Array<{
    name?: string;
    displayName?: string;
    inputTokenLimit?: number;
    supportedGenerationMethods?: string[];
  }>;
}

/* -------------------------------------------------------------------------- */
/*  Discovery                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ask a provider which models the given API key can actually use.
 *
 * This is the primary way the console learns about models, and it exists because
 * static lists rot: a hardcoded default silently becomes an invalid model id that
 * only fails once a trader tries to make a decision. Asking the provider is
 * always current, and it also catches a key that is valid but not entitled to
 * the model the user typed.
 *
 * On any failure we fall back to the built-in hints so the user still has
 * something to click — but the result is labelled `fallback` so the UI never
 * pretends a guess is authoritative.
 */
export async function discoverModels(options: {
  provider: LlmProviderId;
  apiKey: string;
  baseUrl?: string;
}): Promise<DiscoverModelsResult> {
  const descriptor = getProvider(options.provider);
  const baseUrl = (options.baseUrl || descriptor.baseUrl).replace(/\/+$/, '');

  const fallback = (message: string): DiscoverModelsResult => ({
    ok: false,
    models: descriptor.models.map((id) => ({ id, discovered: false })),
    source: 'fallback',
    message,
  });

  if (!baseUrl) {
    return fallback('请先填写基础 URL，然后才能获取模型列表。');
  }
  if (!options.apiKey) {
    return fallback('请先填写 API Key，然后才能获取模型列表。');
  }

  const url = new URL(`${baseUrl}${descriptor.modelsPath}`);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'auto-quant/0.1',
  };

  switch (descriptor.modelsAuth) {
    case 'bearer':
      headers.Authorization = `Bearer ${options.apiKey}`;
      break;
    case 'x-api-key':
      headers['x-api-key'] = options.apiKey;
      break;
    case 'query-key':
      url.searchParams.set('key', options.apiKey);
      break;
  }
  for (const [key, value] of Object.entries(descriptor.modelsHeaders ?? {})) {
    headers[key] = value;
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();

    if (!response.ok) {
      const error = classifyHttpError(descriptor.id, response.status, text, text);
      // A 401/403 here is genuinely useful information: the key is wrong, and
      // saying so now saves a confusing cycle failure later.
      const hint =
        response.status === 401 || response.status === 403
          ? 'API Key 被拒绝 —— 请确认密钥正确，且该密钥有权限访问模型列表。'
          : error.message;
      return fallback(hint);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fallback('模型接口返回的不是 JSON，无法解析。');
    }

    const models = extractModels(descriptor.id, parsed);
    if (models.length === 0) {
      return fallback('模型接口返回了空列表 —— 请确认该 API Key 已开通任何模型。');
    }

    return {
      ok: true,
      models,
      source: 'live',
      message: `已从 ${descriptor.label} 获取到 ${models.length} 个可用模型。`,
    };
  } catch (error) {
    const message = (error as Error).message;
    log.warn(`模型列表获取失败（${descriptor.id}）：${message}`);
    return fallback(`无法连接模型接口：${message}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Response normalisation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalise the three response dialects into one list.
 *
 * The differences that matter: Gemini prefixes ids with `models/` and reports a
 * capability list, and its `/models` endpoint returns both chat and embedding
 * models — offering `text-embedding-004` as a chat model would be a confusing
 * dead end, so the capability filter is not optional.
 */
function extractModels(provider: LlmProviderId, payload: unknown): DiscoveredModel[] {
  if (provider === 'gemini') {
    const body = payload as GeminiModelsBody;
    return (body.models ?? [])
      .filter((m) => {
        const methods = m.supportedGenerationMethods ?? [];
        // Older deployments omit the field entirely; in that case keep the model.
        return methods.length === 0 || methods.includes('generateContent');
      })
      .map((m) => ({
        // `models/gemini-2.5-flash` → `gemini-2.5-flash`, which is what the
        // generateContent path expects when the client builds the URL itself.
        id: (m.name ?? '').replace(/^models\//, ''),
        ...(m.displayName ? { label: m.displayName } : {}),
        ...(m.inputTokenLimit ? { contextLength: m.inputTokenLimit } : {}),
        discovered: true,
      }))
      .filter((m) => m.id.length > 0);
  }

  if (provider === 'anthropic') {
    const body = payload as AnthropicModelsBody;
    return (body.data ?? [])
      .map((m) => ({
        id: m.id ?? '',
        ...(m.display_name ? { label: m.display_name } : {}),
        discovered: true,
      }))
      .filter((m) => m.id.length > 0);
  }

  // OpenAI-compatible, including OpenRouter (which adds `name`/`context_length`).
  const body = payload as OpenAiModelsBody;
  const rows = Array.isArray(body.data)
    ? body.data
    : // A few gateways return a bare array.
      Array.isArray(payload)
      ? (payload as OpenAiModelsBody['data'])
      : [];

  return (rows ?? [])
    .map((m) => {
      const id = m.id ?? '';
      const context = m.context_length ?? m.context_window;
      return {
        id,
        ...(m.name && m.name !== id ? { label: m.name } : {}),
        ...(context ? { contextLength: context } : {}),
        discovered: true,
      };
    })
    .filter((m) => m.id.length > 0)
    // Embedding and moderation models are never usable for chat completions, and
    // the OpenAI-compatible `/models` listing is full of them.
    .filter((m) => !/(embedding|embed|whisper|tts|dall-e|moderation|image|audio|rerank)/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
