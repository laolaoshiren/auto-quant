import { joinUrl } from './http.js';
import { emptyCompletionError, LlmError } from './errors.js';
import {
  normalizeUsage,
  splitSystem,
  type ChatMessage,
  type FinishReason,
  type OutboundRequest,
  type WireUsage,
} from './types.js';

/**
 * Native Gemini `generateContent` (B.4).
 *
 * Everything about this dialect differs from the OpenAI one: the credential
 * travels as a query parameter, the conversation lives in `contents` with
 * `parts` (and role `model`, never `assistant`), the system prompt is a
 * top-level `systemInstruction`, and schema types are SCREAMING-CASE.
 */

export interface GeminiBodyOptions {
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
/*  Schema translation                                                         */
/* -------------------------------------------------------------------------- */

/** JSON Schema `type` values Gemini accepts, in its SCREAMING-CASE spelling. */
const SCREAMING_TYPES = new Set(['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'OBJECT']);

/**
 * Keys Gemini's OpenAPI-subset `Schema` rejects outright with a 400. Forwarding
 * a schema written for OpenAI/Anthropic therefore fails, so they are dropped.
 */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'additionalProperties',
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'allOf',
  'oneOf',
  'const',
  'patternProperties',
  'unevaluatedProperties',
  'dependentRequired',
  'dependentSchemas',
]);

/**
 * Rewrite a canonical (lowercase) JSON Schema into Gemini's dialect.
 *
 * Gemini documents SCREAMING-CASE type names, requires `format: 'enum'`
 * alongside `enum`, and rejects `additionalProperties`/`$ref`/`allOf`. The
 * `propertyOrdering` side-channel is populated from `properties` order because
 * it is the only ordering hint Gemini honours.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => toGeminiSchema(entry));
  const record = asObject(schema);
  if (!record) return schema;

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(record)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;

    if (key === 'type') {
      const upper = typeof value === 'string' ? value.toUpperCase() : '';
      out['type'] = SCREAMING_TYPES.has(upper) ? upper : value;
      continue;
    }

    if (key === 'properties') {
      const properties = asObject(value);
      if (!properties) continue;
      const rewritten: JsonObject = {};
      for (const [name, subschema] of Object.entries(properties)) {
        rewritten[name] = toGeminiSchema(subschema);
      }
      out['properties'] = rewritten;
      // Gemini ignores object key order otherwise, which changes the emitted
      // JSON field order and confuses a downstream positional parser.
      out['propertyOrdering'] = Object.keys(rewritten);
      continue;
    }

    if (key === 'items' || key === 'anyOf' || key === 'not') {
      out[key] = toGeminiSchema(value);
      continue;
    }

    out[key] = value;
  }

  // An enum is only honoured when flagged as such.
  if (Array.isArray(out['enum']) && out['format'] === undefined) {
    out['format'] = 'enum';
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Request building                                                           */
/* -------------------------------------------------------------------------- */

export function buildBody(
  messages: ChatMessage[],
  options: GeminiBodyOptions = {},
): JsonObject {
  const { system, messages: turns } = splitSystem(messages);

  const body: JsonObject = {
    contents: turns.map((m) => ({
      // Role `model` — the string `assistant` is not a valid Gemini role.
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
  };

  if (system !== undefined) {
    body['systemInstruction'] = { parts: [{ text: system }] };
  }

  const generationConfig: JsonObject = {};
  if (options.temperature !== undefined) generationConfig['temperature'] = options.temperature;
  if (options.maxTokens !== undefined) generationConfig['maxOutputTokens'] = options.maxTokens;

  if (options.jsonMode === true) {
    if (options.jsonSchema) {
      // `responseMimeType` and the schema must be set together.
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = toGeminiSchema(options.jsonSchema);
    } else {
      generationConfig['responseMimeType'] = 'application/json';
    }
  }

  if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;
  return body;
}

/**
 * The API key goes in the `key` query parameter on this endpoint. The header
 * form (`x-goog-api-key`) is documented too, but the query form is the one the
 * REST examples use and works identically for `generateContent`.
 */
export function buildRequest(
  apiKey: string,
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  options: GeminiBodyOptions = {},
): OutboundRequest {
  const normalized = model.startsWith('models/') ? model : `models/${model}`;
  const url = `${joinUrl(baseUrl, `${normalized}:generateContent`)}?key=${encodeURIComponent(apiKey)}`;
  return {
    url,
    headers: { 'content-type': 'application/json' },
    body: buildBody(messages, options),
  };
}

/* -------------------------------------------------------------------------- */
/*  Response parsing                                                           */
/* -------------------------------------------------------------------------- */

/** Concatenate the text parts of a candidate's `content`. */
export function extractText(content: unknown): string {
  const record = asObject(content);
  if (!record) return '';
  const parts = record['parts'];
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      const block = asObject(part);
      if (!block) return '';
      // Thinking parts are flagged; their text is not the answer.
      if (block['thought'] === true) return '';
      return typeof block['text'] === 'string' ? block['text'] : '';
    })
    .join('');
}

/** True when any part is a `functionCall` — Gemini's only tool-call signal. */
export function hasFunctionCall(content: unknown): boolean {
  const record = asObject(content);
  const parts = record?.['parts'];
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => asObject(part)?.['functionCall'] !== undefined);
}

/**
 * Gemini's `finishReason` enum, normalised (B.12). Note there is no
 * `tool_calls` value in it at all: a function call is signalled by the presence
 * of a `functionCall` part, so `parseResponse` overrides this.
 */
export function normalizeFinishReason(raw: unknown): FinishReason {
  switch (typeof raw === 'string' ? raw.toUpperCase().trim() : '') {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'RECITATION':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
    case 'IMAGE_RECITATION':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
    case 'UNEXPECTED_TOOL_CALL':
    case 'TOO_MANY_TOOL_CALLS':
    case 'LANGUAGE':
    case 'NO_IMAGE':
    case 'IMAGE_OTHER':
    case 'OTHER':
      return 'error';
    case 'FINISH_REASON_UNSPECIFIED':
    case '':
      return 'unknown';
    default:
      return 'error';
  }
}

export interface GeminiParsedResponse {
  text: string;
  finishReason: FinishReason;
  usage: ReturnType<typeof normalizeUsage>;
  model: string | null;
  isEmpty: boolean;
}

export function parseResponse(body: unknown, fallbackModel: string): GeminiParsedResponse {
  const root = asObject(body);
  if (!root) throw emptyCompletionError('gemini', body);

  // A blocked prompt returns no candidates at all; report it as a content
  // filter rather than as an empty successful answer.
  const feedback = asObject(root['promptFeedback']);
  const blockReason = feedback?.['blockReason'];
  if (typeof blockReason === 'string' && blockReason !== '' && blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
    throw new LlmError(
      `Prompt blocked by Gemini safety filters (${blockReason})`,
      200,
      'gemini',
      false,
      body,
      { kind: 'content_filter' },
    );
  }

  const candidates = root['candidates'];
  const first = Array.isArray(candidates) ? asObject(candidates[0]) : null;
  if (!first) throw emptyCompletionError('gemini', body);

  const content = first['content'];
  const text = extractText(content);
  // Gemini never reports `tool_calls` as a finish reason, so the parts decide.
  const finishReason: FinishReason = hasFunctionCall(content)
    ? 'tool_calls'
    : normalizeFinishReason(first['finishReason']);

  return {
    text,
    finishReason,
    usage: normalizeUsage(asObject(root['usageMetadata']) as WireUsage | null),
    model: typeof root['modelVersion'] === 'string' ? String(root['modelVersion']) : fallbackModel,
    isEmpty: text.trim() === '',
  };
}
