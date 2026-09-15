import { joinUrl } from './http.js';
import { emptyCompletionError } from './errors.js';
import {
  normalizeUsage,
  splitSystem,
  type ChatMessage,
  type FinishReason,
  type OutboundRequest,
  type WireUsage,
} from './types.js';

/**
 * Native Anthropic Messages API (`POST /v1/messages`).
 *
 * Three structural differences from the OpenAI dialect drive this file: auth is
 * `x-api-key` + `anthropic-version` with no bearer, the system prompt is a
 * top-level field rather than a message, and the response body is an array of
 * typed content blocks.
 */

export const ANTHROPIC_VERSION = '2023-06-01';

/** `max_tokens` is required by the API, so a caller that omits it still gets a valid body. */
const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicBodyOptions {
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
/*  Model capability                                                           */
/* -------------------------------------------------------------------------- */

/** Single-digit major version from an id like `claude-opus-5` or `claude-sonnet-4-5-20250929`. */
function generationOf(model: string): { major: number; minor: number } | null {
  const match = /claude-[a-z]+-(\d+)(?:[.-](\d+))?/i.exec(model);
  if (!match || match[1] === undefined) return null;
  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  return Number.isFinite(major) ? { major, minor } : null;
}

/**
 * Models after Opus 4.6 deprecate `temperature`/`top_p`/`top_k`: `temperature`
 * accepts only `1.0` and `top_p` only ≥ 0.99, everything else is a 400 (B.3).
 * A provider-agnostic layer that forwards the user's temperature breaks on
 * current Claude models, so sampling knobs are dropped for these.
 */
export function rejectsSamplingParameters(model: string): boolean {
  if (/fable|mythos/i.test(model)) return true;
  const generation = generationOf(model);
  if (!generation) return false;
  if (generation.major >= 5) return true;
  if (generation.major === 4) return generation.minor >= 7;
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Request building                                                           */
/* -------------------------------------------------------------------------- */

export function buildBody(
  model: string,
  messages: ChatMessage[],
  options: AnthropicBodyOptions = {},
): JsonObject {
  const { system, messages: turns } = splitSystem(messages);

  // Consecutive same-role turns are merged server-side; the first message must
  // be `user`, which the strategy engine's prompt construction already ensures.
  const wireMessages = turns.map((m) => ({ role: m.role, content: m.content }));

  const body: JsonObject = {
    model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: wireMessages,
    stream: false,
  };

  // `system` is top-level. There is no `system` role in `messages` at all.
  if (system !== undefined) body['system'] = system;

  if (options.temperature !== undefined && !rejectsSamplingParameters(model)) {
    body['temperature'] = options.temperature;
  }

  // Anthropic's native structured output. Note it takes the schema directly,
  // unlike OpenAI's `json_schema: {name, strict, schema}` wrapper. With no
  // schema there is no native JSON mode at all — JSON has to be requested in
  // the prompt — so nothing is emitted rather than a degenerate empty schema
  // that would force `{}` as the answer.
  if (options.jsonMode === true && options.jsonSchema) {
    body['output_config'] = {
      format: { type: 'json_schema', schema: options.jsonSchema },
    };
  }

  return body;
}

export function buildRequest(
  apiKey: string,
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  options: AnthropicBodyOptions = {},
): OutboundRequest {
  return {
    url: joinUrl(baseUrl, 'messages'),
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: buildBody(model, messages, options),
  };
}

/* -------------------------------------------------------------------------- */
/*  Response parsing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Join only the blocks whose `type === 'text'`.
 *
 * `content` is an array of typed blocks and a `thinking` or `redacted_thinking`
 * block can come first, so `content[0].text` is not the assistant answer
 * (Anthropic's own docs use `next(b.text for b in content if b.type == 'text')`).
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asObject(block);
      if (!record || record['type'] !== 'text') return '';
      return typeof record['text'] === 'string' ? record['text'] : '';
    })
    .join('');
}

/** Collapse `stop_reason` onto the canonical set (B.12). */
export function normalizeStopReason(raw: unknown): FinishReason {
  switch (typeof raw === 'string' ? raw.toLowerCase().trim() : '') {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case 'pause_turn':
      // A server-tool pause is not a completed answer.
      return 'error';
    case '':
      return 'unknown';
    default:
      return 'error';
  }
}

export interface AnthropicParsedResponse {
  text: string;
  finishReason: FinishReason;
  usage: ReturnType<typeof normalizeUsage>;
  model: string | null;
  isEmpty: boolean;
}

export function parseResponse(
  body: unknown,
  fallbackModel: string,
): AnthropicParsedResponse {
  const root = asObject(body);
  if (!root) throw emptyCompletionError('anthropic', body);

  const usage = normalizeUsage(asObject(root['usage']) as WireUsage | null);
  const model = typeof root['model'] === 'string' ? String(root['model']) : fallbackModel;
  const text = extractText(root['content']);

  return {
    text,
    finishReason: normalizeStopReason(root['stop_reason']),
    usage,
    model,
    isEmpty: text.trim() === '',
  };
}
