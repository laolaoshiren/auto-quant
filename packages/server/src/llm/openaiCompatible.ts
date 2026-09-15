import { getProvider, type LlmProviderId } from '@aq/shared';
import { joinUrl } from './http.js';
import { LlmError, emptyCompletionError } from './errors.js';
import {
  normalizeUsage,
  splitSystem,
  type ChatMessage,
  type FinishReason,
  type OutboundRequest,
  type WireUsage,
} from './types.js';

/**
 * One adapter for OpenAI and every provider whose descriptor sets
 * `openAiCompatible: true` (DeepSeek, Qwen, Grok, Kimi, MiniMax, OpenRouter,
 * custom). The dialect is shared; the deviations are not, so each one is
 * handled explicitly below rather than being "just forwarded".
 */

export interface OpenAiBodyOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  jsonSchema?: Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/* -------------------------------------------------------------------------- */
/*  Per-provider capability flags                                              */
/* -------------------------------------------------------------------------- */

/**
 * Kimi documents `temperature`, `top_p`, `n` and both penalties as
 * unmodifiable on current models: "passing other values returns an error"
 * (B.7). `n` and the penalties are never sent by this layer, so only
 * temperature needs gating.
 */
export function rejectsSamplingParameters(provider: LlmProviderId): boolean {
  return provider === 'kimi';
}

/**
 * MiniMax's OpenAI-compatible endpoint has **no** `response_format` in its
 * schema (B.8), so sending one is at best ignored and at worst a 400. The
 * layer therefore never claims structured output for it.
 */
export function supportsResponseFormat(provider: LlmProviderId): boolean {
  return provider !== 'minimax';
}

/** Providers that accept `response_format: {type:'json_schema'}` (B.15). */
export function supportsStrictSchema(provider: LlmProviderId): boolean {
  switch (provider) {
    case 'openai':
    case 'grok':
    case 'kimi':
    case 'qwen':
      return true;
    // DeepSeek has no strict schema at all; MiniMax's only lives on the native
    // v2 endpoint; OpenRouter merely passes the schema through unenforced.
    case 'deepseek':
    case 'minimax':
    case 'openrouter':
    case 'custom':
    default:
      return false;
  }
}

/**
 * Token-cap parameter name.
 *
 * OpenAI, xAI, MiniMax and Kimi deprecate `max_tokens` in favour of
 * `max_completion_tokens`; OpenAI's variant is also the only one accepted by
 * the o-series. DeepSeek, Qwen and OpenRouter still document `max_tokens`, and
 * DeepSeek's range (1–393216) only exists there.
 */
export function maxTokensField(provider: LlmProviderId): 'max_completion_tokens' | 'max_tokens' {
  switch (provider) {
    case 'openai':
    case 'grok':
    case 'minimax':
    case 'kimi':
      return 'max_completion_tokens';
    default:
      return 'max_tokens';
  }
}

/* -------------------------------------------------------------------------- */
/*  Request building                                                           */
/* -------------------------------------------------------------------------- */

export function buildBody(
  provider: LlmProviderId,
  model: string,
  messages: ChatMessage[],
  options: OpenAiBodyOptions = {},
): JsonObject {
  const { system, messages: turns } = splitSystem(messages);

  // Qwen accepts the system role only at `messages[0]`, so the canonical
  // "system is separate" split maps onto it exactly.
  const wireMessages: JsonObject[] = turns.map((m) => ({ role: m.role, content: m.content }));
  if (system !== undefined) wireMessages.unshift({ role: 'system', content: system });

  const body: JsonObject = { model, messages: wireMessages, stream: false };

  if (options.temperature !== undefined && !rejectsSamplingParameters(provider)) {
    body['temperature'] = options.temperature;
  }

  if (options.maxTokens !== undefined) {
    body[maxTokensField(provider)] = options.maxTokens;
  }

  if (supportsResponseFormat(provider)) {
    if (options.jsonMode === true) {
      // A strict schema supersedes loose JSON mode where both are requested.
      if (options.jsonSchema && supportsStrictSchema(provider)) {
        body['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            strict: true,
            schema: options.jsonSchema,
          },
        };
      } else {
        body['response_format'] = { type: 'json_object' };
      }
    }
  }

  return body;
}

export function buildRequest(
  provider: LlmProviderId,
  apiKey: string,
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  options: OpenAiBodyOptions = {},
): OutboundRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };

  // OpenRouter attribution headers. Harmless but only documented there, so
  // they are scoped to it instead of being sent to every vendor.
  if (provider === 'openrouter') {
    headers['http-referer'] = 'https://github.com/auto-quant';
    headers['x-openrouter-title'] = 'auto-quant';
  }

  return {
    url: joinUrl(baseUrl, 'chat/completions'),
    headers,
    body: buildBody(provider, model, messages, options),
  };
}

/* -------------------------------------------------------------------------- */
/*  Response parsing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `content` may be a string, an array of content parts (Qwen-VL and others),
 * or `null` when a refusal or a reasoning-only finish consumed the output.
 * Reading it as a bare string is a real failure mode.
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const record = asObject(part);
        if (!record) return '';
        const text = record['text'];
        if (typeof text === 'string') return text;
        const nested = asObject(text);
        return nested && typeof nested['value'] === 'string' ? String(nested['value']) : '';
      })
      .join('');
  }
  const record = asObject(content);
  if (record && typeof record['text'] === 'string') return String(record['text']);
  return '';
}

/**
 * MiniMax embeds thinking in `content` inside `<think>…</think>` unless
 * `reasoning_split` is set. Feeding that to a decision parser corrupts it, so
 * the tags are stripped and the reasoning is dropped (B.8).
 */
export function stripThinkTags(text: string): string {
  return text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').trim();
}

/** Collapse each provider's `finish_reason` enum onto the canonical set (B.12). */
export function normalizeFinishReason(raw: unknown): FinishReason {
  const value = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  switch (value) {
    case 'stop':
    case 'end_turn':
    case 'eos':
      return 'stop';
    case 'length':
    case 'max_tokens':
    case 'model_context_window_exceeded':
    case 'max_output_tokens':
      return 'length';
    case 'tool_calls':
    case 'tool_use':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
    case 'refusal':
    case 'safety':
    case 'prohibited_content':
    case 'blocklist':
    case 'recitation':
    case 'spii':
    case 'image_safety':
      return 'content_filter';
    // DeepSeek's two extras are abnormal terminations, not normal stops.
    case 'insufficient_system_resource':
    case 'aborted':
      return 'error';
    case 'error':
      return 'error';
    case '':
      return 'unknown';
    default:
      // Unknown values must not be silently dropped or crash the caller; they
      // map to `error` so a new provider enum surfaces loudly (B.12 trap 3).
      return 'error';
  }
}

export interface OpenAiParsedResponse {
  text: string;
  finishReason: FinishReason;
  usage: ReturnType<typeof normalizeUsage>;
  model: string | null;
  /** True when the provider returned HTTP 200 with no assistant text at all. */
  isEmpty: boolean;
}

export function parseResponse(
  provider: LlmProviderId,
  body: unknown,
  fallbackModel: string,
): OpenAiParsedResponse {
  const root = asObject(body);
  if (!root) throw emptyCompletionError(provider, body);

  const choices = root['choices'];
  const first = Array.isArray(choices) ? asObject(choices[0]) : null;
  if (!first) throw emptyCompletionError(provider, body);

  const message = asObject(first['message']) ?? {};
  let text = extractText(message['content']);
  if (provider === 'minimax') text = stripThinkTags(text);

  const usage = normalizeUsage(asObject(root['usage']) as WireUsage | null);
  const model = typeof root['model'] === 'string' ? String(root['model']) : fallbackModel;
  let finishReason = normalizeFinishReason(first['finish_reason']);

  // MiniMax severe moderation yields empty content flagged by these fields.
  if (
    text.trim() === '' &&
    (root['output_sensitive'] === true || message['output_sensitive'] === true)
  ) {
    throw new LlmError('Output blocked by provider moderation', 200, provider, false, body, {
      kind: 'content_filter',
    });
  }

  // A refusal arrives as HTTP 200 with `finish_reason: "stop"` and empty
  // content (B.1) — a naive parser reads that as a successful empty answer.
  if (text.trim() === '') {
    const refusal = message['refusal'];
    if (typeof refusal === 'string' && refusal.trim() !== '') {
      text = refusal;
      finishReason = 'content_filter';
    }
  }

  return { text, finishReason, usage, model, isEmpty: text.trim() === '' };
}

/** Convenience for the client: the descriptor default base URL when none is given. */
export function defaultBaseUrl(provider: LlmProviderId): string {
  return getProvider(provider).baseUrl;
}
