/**
 * Internal, provider-neutral contract for the LLM layer.
 *
 * Everything above this directory speaks these types only; each adapter is
 * responsible for translating them into one vendor's wire dialect and back.
 * See `docs/research/binance-ws-and-llm-apis.md` Part B for the per-provider
 * detail being absorbed here.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for machine-readable JSON when it supports it. */
  jsonMode?: boolean;
  /** Optional JSON schema, used only where the provider supports strict schemas (see B.15). */
  jsonSchema?: Record<string, unknown>;
  /**
   * 请求模型在回答前思考多久。
   *
   * ## 为什么这是一个交易参数，而不是一个技术开关
   *
   * 这个机器人的每一轮决策都是「看一遍行情、判断该不该动」——
   * 一次判断的代价可能是一笔真实的盈亏。**思考预算花在这里是值得的**：
   * 多花几秒和几百个 token，换一个更审慎的判断。
   *
   * ## 名字沿用各家 API 的叫法
   *
   * OpenAI 系把它叫 `reasoning_effort`。这里保留同一个词，
   * 免得又多一个「我们自己发明的名字」需要对照。
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /**
   * `promptTokens` 里有多少**命中了上下文缓存**。
   *
   * `null` = 服务商没报这个字段（**不知道**）；`0` = 报了，确实没命中。
   * 两者的结论完全相反，**绝不能合成一个数**。
   */
  cachedTokens: number | null;
  /** `completionTokens` 里有多少花在思考上。计入 completion。 */
  reasoningTokens: number | null;
}

/** Canonical stop reasons; every provider enum in B.12 collapses into these. */
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error' | 'unknown';

export interface ChatResult {
  text: string;
  /** Normalised across providers — see B.12. */
  finishReason: FinishReason;
  usage: ChatUsage;
  model: string;
  latencyMs: number;
  /** Raw provider payload, kept for the audit trail. */
  raw: unknown;
}

/** Usage as every provider eventually spells it, before normalisation. */
export interface WireUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** Gemini reports `responseTokenCount`; older payloads use the snake_case twin. */
  candidatesTokenCount?: number | null;
  candidates_token_count?: number | null;
  /** The typedoc name for Gemini's output-token count; either name may arrive. */
  responseTokenCount?: number | null;
  promptTokenCount?: number | null;
  totalTokenCount?: number | null;
  /**
   * OpenAI 系把缓存命中与思考 token 放在**嵌套对象**里，
   * 而且这两个对象**只有部分服务商返回**。
   *
   * 所以它们是可选的，且读不到时归一化成 `null`（不知道）而不是 `0`。
   */
  prompt_tokens_details?: {
    cached_tokens?: number | null;
  } | null;
  completion_tokens_details?: {
    reasoning_tokens?: number | null;
  } | null;
}

/** A fully-formed HTTP call, ready for `fetch`. Produced by each adapter. */
export interface OutboundRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Non-empty system prompt, if the caller supplied one. */
export interface ConversationParts {
  system?: string;
  messages: ChatMessage[];
}

export const EMPTY_USAGE: ChatUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  cachedTokens: null,
  reasoningTokens: null,
};

/** Split a canonical message list into its system prompt and turn list. */
export function splitSystem(messages: ChatMessage[]): ConversationParts {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .trim();
  return {
    system: system.length > 0 ? system : undefined,
    messages: messages.filter((m) => m.role !== 'system'),
  };
}

/** Provider counters are optional and sometimes strings; keep `null` for "not reported". */
export function toTokenCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Normalise the many usage spellings into the canonical triple. */
export function normalizeUsage(usage: WireUsage | null | undefined): ChatUsage {
  if (!usage) return { ...EMPTY_USAGE };

  const prompt = toTokenCount(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? null,
  );
  const completion = toTokenCount(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.candidatesTokenCount ??
      usage.candidates_token_count ??
      // Gemini's own docs disagree on this name, so both are accepted rather
      // than hard-coding one and silently reporting null.
      usage.responseTokenCount ??
      null,
  );
  const total = toTokenCount(usage.total_tokens ?? usage.totalTokenCount ?? null);

  /*
   * **缓存命中与思考 token。**
   *
   * ## `null` 和 `0` 是两件事，绝不能混
   *
   *   · `0`  —— 服务商报了，这一轮**确实一个 token 都没命中缓存**
   *   · `null` —— 服务商**根本没报这个字段**，我们不知道
   *
   * 把它们合成 `?? 0` 会让"不支持上报的 provider"看起来像"缓存全没命中"，
   * 而这两件事的结论完全相反：前者该换供应商，后者该查提示词。
   *
   * ## 为什么值得单独记
   *
   * 缓存命中价与未命中价**差 50 倍**（DeepSeek flash：$0.003 对 $0.15
   * 每百万 token）。少了这个字段，成本问题就只能靠猜 ——
   * 实测这个项目**命中率 99.6%**，而在此之前没有任何地方能看到这个数字。
   *
   * `reasoning_tokens` 同理：它会计入 `completion_tokens`，
   * 而输出价是缓存命中输入价的 **200 倍**，所以"钱花在思考上还是花在正文上"
   * 是一个必须能分开看的账。
   */
  const cached = toTokenCount(usage.prompt_tokens_details?.cached_tokens ?? null);
  const reasoning = toTokenCount(usage.completion_tokens_details?.reasoning_tokens ?? null);

  return {
    promptTokens: prompt,
    completionTokens: completion,
    // Deriving the total is better than reporting `null` when both halves are known.
    totalTokens: total ?? (prompt !== null && completion !== null ? prompt + completion : null),
    cachedTokens: cached,
    reasoningTokens: reasoning,
  };
}
