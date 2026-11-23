import { joinUrl } from './http.js';
import { emptyCompletionError, LlmError } from './errors.js';
import {
  normalizeUsage,
  splitSystem,
  type ChatMessage,
  type FinishReason,
  type OutboundRequest,
  type ToolCall,
  type ToolSpec,
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
  /** 原生 function calling 的工具清单（2026-10-23，见 `types.ts` 的 `ChatRequest.tools`）。 */
  tools?: readonly ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
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
      if (Object.keys(rewritten).length > 0) {
        out['properties'] = rewritten;
        // Gemini ignores object key order otherwise, which changes the emitted
        // JSON field order and confuses a downstream positional parser.
        out['propertyOrdering'] = Object.keys(rewritten);
      }
      continue;
    }

    if (key === 'items' || key === 'anyOf' || key === 'not') {
      out[key] = toGeminiSchema(value);
      continue;
    }

    out[key] = value;
  }

  // Gemini rejects `type: 'OBJECT'` with missing or empty `properties`
  // ("properties: should be non-empty for OBJECT type"). Convert freeform
  // object schemas (such as `set_params.patch`) into a JSON-object STRING
  // schema so Gemini accepts the declaration and can emit arbitrary patch keys.
  if (out['type'] === 'OBJECT') {
    const props = asObject(out['properties']);
    if (!props || Object.keys(props).length === 0) {
      delete out['properties'];
      delete out['propertyOrdering'];
      delete out['required'];
      out['type'] = 'STRING';
      const desc = typeof out['description'] === 'string' ? out['description'] : '';
      if (!/json/i.test(desc)) {
        out['description'] = desc ? `${desc} (JSON object string)` : 'JSON object string';
      }
    }
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

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️ **Gemini 的工具消息形状是三家差别最大的**（2026-10-23）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * | | OpenAI | Gemini |
   * |---|---|---|
   * | 模型发起调用 | `message.tool_calls[]` | `parts[]` 里 `{functionCall:{name,args}}` |
   * | 回传结果 | `role:'tool'` | `role:'user'`，parts 里 `{functionResponse:{name,response}}` |
   * | 工具声明 | `tools:[{type:'function',…}]` | `tools:[{functionDeclarations:[…]}]` |
   *
   * ⚠️ **Gemini 没有 `tool` 角色**（只有 `user` / `model`）—— 工具结果要以
   * `user` 身份、以 `functionResponse` part 的形式回传。
   *
   * ⚠️ **`functionResponse` 用 `name` 而不是 `id` 关联** —— 这是与 OpenAI
   * 最大的语义差异：OpenAI 靠 `tool_call_id`，Gemini 靠**工具名**。
   * 所以同名工具一轮内不能并行调两次（我们的工具集没有这种情况，
   * 但若以后加了就必须改协议）。
   */
  /*
   * 连续多条 `role: 'tool'` 消息必须合并进紧跟 model 之后的**单条 `user` 消息**
   * 的 `parts[]` 里：Gemini 要求同一轮并行 `functionCall` 的所有 `functionResponse`
   * 在同一条 `user` turn 中一起回传，拆成多条连续 `user` turn 会被拒。
   */
  const contents: JsonObject[] = [];
  for (const m of turns) {
    if (m.role === 'tool') {
      const part: JsonObject = {
        functionResponse: {
          name: m.toolName ?? m.toolCallId ?? '',
          response: safeParseObject(m.content),
        },
      };
      const prev = contents[contents.length - 1];
      const prevParts = prev && prev['role'] === 'user' && Array.isArray(prev['parts'])
        ? (prev['parts'] as JsonObject[])
        : null;
      if (prevParts !== null && prevParts[prevParts.length - 1]?.['functionResponse'] !== undefined) {
        prevParts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      const parts: JsonObject[] = [];
      if (m.content !== '') parts.push({ text: m.content });
      for (const c of m.toolCalls) {
        parts.push({
          functionCall: { name: c.name, args: safeParseObject(c.arguments) },
        });
      }
      // Role `model` — the string `assistant` is not a valid Gemini role.
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({
      // Role `model` — the string `assistant` is not a valid Gemini role.
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }
  const body: JsonObject = { contents };

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

  /*
   * 原生 function calling（2026-10-23）。
   *
   * Gemini 的声明包在 `functionDeclarations` 里，schema 走 `parameters`，
   * 且**必须过 `toGeminiSchema`** —— 直接丢 OpenAI 的 JSON Schema 进去会被
   * 400 拒（`additionalProperties` / `$ref` / 大写的 `type` 都不认）。
   *
   * ⚠️ 与 `responseMimeType: application/json` 互斥：那边强制"只输出 JSON"，
   * 这边要求"可以选调工具"，同时发会让模型永远不调工具。
   */
  if (options.tools !== undefined && options.tools.length > 0) {
    body['tools'] = [
      {
        functionDeclarations: options.tools.map((t) => {
          const decl: JsonObject = {
            name: t.name,
            description: t.description,
          };
          const rawParams = asObject(t.parameters);
          const rawProps = rawParams ? asObject(rawParams['properties']) : null;
          const isEmptyObjectParams =
            rawParams !== null &&
            typeof rawParams['type'] === 'string' &&
            rawParams['type'].toUpperCase() === 'OBJECT' &&
            (!rawProps || Object.keys(rawProps).length === 0);
          /*
           * 无参工具（如 `get_current_params`）的 `parameters` 若传空 OBJECT，
           * Gemini 会报 400 (`properties: should be non-empty for OBJECT type`)；
           * 按 Gemini 规范直接省略 `parameters`。
           */
          if (!isEmptyObjectParams) {
            decl['parameters'] = toGeminiSchema(t.parameters);
          }
          return decl;
        }),
      },
    ];
    /*
     * `toolConfig.functionCallingConfig.mode`：
     *   AUTO（默认） / ANY（必须调一个） / NONE（不许调）
     *
     * ⚠️ 只在 `required` 时显式写 —— `AUTO` 是默认值，写了反而多一个
     * 网关可能不认的字段（各家兼容层对 toolConfig 的支持不一致）。
     */
    if (options.toolChoice === 'required') {
      body['toolConfig'] = { functionCallingConfig: { mode: 'ANY' } };
    } else if (options.toolChoice === 'none') {
      body['toolConfig'] = { functionCallingConfig: { mode: 'NONE' } };
    }
    delete generationConfig['responseMimeType'];
    delete generationConfig['responseSchema'];
    if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;
    else delete body['generationConfig'];
  }

  return body;
}

/**
 * 把工具参数字符串解析成对象；失败时返回 `{ raw: … }` 而不是抛。
 *
 * Gemini 要求 `args` 必须是对象。模型偶尔吐出不合法的 JSON，
 * 那时让它抛会让**整轮决策失败**，而包成 `{raw}` 至少能让工具看到
 * 原始输入、也让模型在下一轮知道"参数没被正确解析"。
 */
function safeParseObject(text: string): JsonObject {
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    const record = asObject(parsed);
    return record ?? { value: parsed };
  } catch {
    return { raw: text };
  }
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
  /** 原生 function calling 的产出（2026-10-23）。`undefined` = 这一轮没调工具。 */
  toolCalls?: ToolCall[];
}

/**
 * 从 Gemini 的 `content.parts[]` 里取出 `functionCall` 块（2026-10-23）。
 *
 * ```jsonc
 *   {"content":{"parts":[
 *     {"text":"我先看一下…"},
 *     {"functionCall":{"name":"get_performance","args":{"window":"7d"}}}
 *   ]}}
 * ```
 *
 * ⚠️ **Gemini 不给调用 id** —— 它是靠工具名关联结果的（见 `buildBody` 那段）。
 * 这里合成一个稳定 id（`gemini_<i>_<name>`）填进 `ToolCall.id`，
 * 好让上游的 `ChatMessage.toolCallId` 字段有值可放；真正回传时 Gemini 只用
 * `toolName`。**合成 id 而不是留空**：留空会让上游的去重/匹配逻辑
 * 把所有 Gemini 调用当成同一次。
 */
export function extractToolCalls(content: unknown): ToolCall[] | undefined {
  const record = asObject(content);
  if (!record) return undefined;
  const parts = record['parts'];
  if (!Array.isArray(parts)) return undefined;

  const out: ToolCall[] = [];
  for (const [index, part] of parts.entries()) {
    const block = asObject(part);
    if (!block) continue;
    const call = asObject(block['functionCall']);
    if (!call) continue;
    const name = typeof call['name'] === 'string' ? call['name'] : '';
    if (name === '') continue;
    const args = call['args'];
    const argsText =
      typeof args === 'string' ? args : args === undefined || args === null ? '{}' : JSON.stringify(args);
    out.push({ id: `gemini_${index}_${name}`, name, arguments: argsText });
  }
  return out.length > 0 ? out : undefined;
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
  const toolCalls = extractToolCalls(content);
  // Gemini never reports `tool_calls` as a finish reason, so the parts decide.
  const finishReason: FinishReason = hasFunctionCall(content)
    ? 'tool_calls'
    : normalizeFinishReason(first['finishReason']);

  return {
    text,
    finishReason,
    usage: normalizeUsage(asObject(root['usageMetadata']) as WireUsage | null),
    model: typeof root['modelVersion'] === 'string' ? String(root['modelVersion']) : fallbackModel,
    /* 只发起工具调用、没有说话，是工具循环的正常一轮 —— 不是空回复。 */
    isEmpty: text.trim() === '' && toolCalls === undefined,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
}
