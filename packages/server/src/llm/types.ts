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
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
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

  return {
    promptTokens: prompt,
    completionTokens: completion,
    // Deriving the total is better than reporting `null` when both halves are known.
    totalTokens: total ?? (prompt !== null && completion !== null ? prompt + completion : null),
  };
}
