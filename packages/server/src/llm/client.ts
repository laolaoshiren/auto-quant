import { getProvider, type LlmProviderId, type LlmProviderDescriptor } from '@aq/shared';
import { createLogger } from '../logger.js';
import { maskSecret } from '../crypto/vault.js';
import { LlmError, emptyCompletionError, isRetryable } from './errors.js';
import { executeJsonRequest } from './http.js';
import * as openai from './openaiCompatible.js';
import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';
import { EMPTY_USAGE, type ChatMessage, type ChatResult, type OutboundRequest } from './types.js';
import { checkOutboundUrl } from './urlGuard.js';

const log = createLogger('llm');

/** Anthropic and Gemini both publish long generation ceilings; 120s is a sane default. */
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_RETRIES = 3;
/** Full-jitter backoff bounds from B.14 (`base ≈ 500ms`, cap ≈ 30s). */
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
/**
 * The probe must be cheap but not *this* cheap: a 1-token cap leaves reasoning
 * models with empty visible content at `finish_reason: length`, which the
 * empty-answer guard would report as a connectivity failure.
 */
/**
 * Output budget for the connectivity probe.
 *
 * Deliberately not tiny. A reasoning model burns output tokens on its thinking
 * before emitting any text, so a 16-token probe comes back empty with
 * `finish_reason: length` — which looks like a broken key to the operator when
 * nothing is wrong. 256 is still negligible in cost and gives such a model room
 * to think and then answer.
 */
const PROBE_MAX_TOKENS = 256;

export interface LlmClientOptions {
  provider: LlmProviderId;
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  maxRetries?: number;
  jsonMode?: boolean;
  jsonSchema?: Record<string, unknown>;
}

export interface ConnectionProbe {
  ok: boolean;
  message: string;
  latencyMs: number;
  modelEcho?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full jitter, not a deterministic exponential delay: after a shared outage
 * every instance would otherwise retry at the same instants and re-trigger the
 * overload (B.14).
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * Provider-agnostic chat client.
 *
 * Dispatches on the descriptor's `openAiCompatible` flag, then applies one
 * shared policy for timeouts, retries and logging so every provider behaves
 * the same way under failure.
 */
export class LlmClient {
  readonly provider: LlmProviderId;
  readonly descriptor: LlmProviderDescriptor;
  readonly model: string;
  readonly baseUrl: string;

  private readonly apiKey: string;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly jsonMode: boolean;
  private readonly jsonSchema: Record<string, unknown> | undefined;
  /** Never logged in full; kept only so an operator can tell which key is live. */
  private readonly keyHint: string;

  constructor(options: LlmClientOptions) {
    this.descriptor = getProvider(options.provider);
    this.provider = options.provider;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? this.descriptor.baseUrl).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.timeoutMs = (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.jsonMode = options.jsonMode === true;
    this.jsonSchema = options.jsonSchema;
    this.keyHint = this.apiKey === '' ? '<empty>' : maskSecret(this.apiKey);

    if (this.baseUrl === '') {
      throw new LlmError(
        `Provider ${this.provider} requires an explicit baseUrl`,
        null,
        this.provider,
        false,
      );
    }

    /*
     * 出站地址白名单也放在构造函数里，因为这里是**所有**模型请求的必经之路：
     * 交易循环、连接探测、策略体检、模型列表发现全都从 `LlmClient` 出去。
     * 放在这里还有一层意义 —— 数据库里**已经存着**的旧地址（本次改动之前写入的）
     * 同样会被拦下，而只在 API 层校验做不到这一点。
     *
     * 不重试、直接失败：这不是网络抖动，重试只会把同一个内网请求再发一遍。
     */
    const verdict = checkOutboundUrl(this.baseUrl);
    if (!verdict.allowed) {
      throw new LlmError(
        `baseUrl 不被允许：${verdict.reason}`,
        null,
        this.provider,
        false,
        undefined,
        { kind: 'bad_request' },
      );
    }
  }

  /**
   * Cheap capability probe used by the launch preflight (B.16): one tiny
   * completion validates the key, the base URL, the model id and the auth
   * header together, turning a mid-session 401 into a startup failure.
   */
  async testConnection(): Promise<ConnectionProbe> {
    const startedAt = Date.now();
    try {
      const result = await this.chat([{ role: 'user', content: 'Reply with the word: pong' }], {
        probe: true,
      });

      const latencyMs = Date.now() - startedAt;

      // A reasoning model spends output budget on its thinking before it emits a
      // single character. A stingy probe budget therefore returns an *empty*
      // completion with `finish_reason: length` — which reads like a failure even
      // though the key, URL and model are all fine. Say so explicitly instead of
      // reporting a bare "(empty reply)".
      if (result.text.trim() === '') {
        const truncated = result.finishReason === 'length';
        return {
          ok: true,
          message: truncated
            ? `已连接 ${this.descriptor.label}（${result.model}）。探测请求的输出预算被推理过程耗尽而返回空内容 —— 这不影响正式调用，但请在高级设置中确认「最大输出 Token」足够大。`
            : `已连接 ${this.descriptor.label}（${result.model}），但模型返回了空内容。若用于正式决策请留意。`,
          latencyMs,
          modelEcho: result.model,
        };
      }

      return {
        ok: true,
        message: `已连接 ${this.descriptor.label}（${result.model}），响应正常。`,
        latencyMs,
        modelEcho: result.model,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`connection probe failed for ${this.provider}`, {
        provider: this.provider,
        model: this.model,
        baseUrl: this.baseUrl,
        apiKey: this.keyHint,
        error: message,
      });
      return { ok: false, message, latencyMs: Date.now() - startedAt };
    }
  }

  async chat(messages: ChatMessage[], options: { probe?: boolean } = {}): Promise<ChatResult> {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      log.debug(`chat request → ${this.provider}`, {
        provider: this.provider,
        model: this.model,
        baseUrl: this.baseUrl,
        // Never the key itself, only enough to identify which one is in use.
        apiKey: this.keyHint,
        attempt,
        messages: messages.length,
        jsonMode: this.jsonMode,
        timeoutMs: this.timeoutMs,
      });

      try {
        const result = await this.attempt(messages, startedAt, startedAtIso, options.probe === true);
        log.info(`chat ok ${this.provider}/${result.model}`, {
          provider: this.provider,
          model: result.model,
          finishReason: result.finishReason,
          latencyMs: result.latencyMs,
          usage: result.usage,
        });
        return result;
      } catch (error) {
        lastError = error;
        const retryable = isRetryable(error);
        const canRetry = retryable && attempt < this.maxRetries;

        const detail = {
          provider: this.provider,
          model: this.model,
          attempt,
          status: error instanceof LlmError ? error.status : null,
          kind: error instanceof LlmError ? error.kind : 'unknown',
          retryable,
          willRetry: canRetry,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };

        if (!canRetry) {
          if (retryable) log.error(`chat failed for ${this.provider} — retries exhausted`, detail);
          else log.error(`chat failed for ${this.provider} — not retryable`, detail);
          throw error;
        }

        // Prefer the server's Retry-After over our own backoff when present.
        const retryAfterMs = error instanceof LlmError ? error.retryAfterMs : null;
        const delayMs = retryAfterMs ?? backoffDelayMs(attempt);
        log.warn(`chat retry ${attempt + 1}/${this.maxRetries} for ${this.provider} in ${delayMs}ms`, {
          ...detail,
          retryAfterMs,
        });
        await sleep(delayMs);
      }
    }

    throw lastError ?? new Error(`chat exhausted retries for ${this.provider}`);
  }

  /** Convenience wrapper matching how the strategy engine calls it. */
  async complete(systemPrompt: string, userPrompt: string): Promise<ChatResult> {
    return this.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);
  }

  /* ---------------------------------------------------------------------- */
  /*  Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private buildRequest(messages: ChatMessage[], probe: boolean): OutboundRequest {
    // A probe must be as cheap as possible and must not request a schema. It
    // keeps the sampling temperature so it exercises the real request path.
    const bodyOptions: openai.OpenAiBodyOptions = probe
      ? {
          maxTokens: PROBE_MAX_TOKENS,
          ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        }
      : {
          ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
          ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
          jsonMode: this.jsonMode,
          ...(this.jsonSchema !== undefined ? { jsonSchema: this.jsonSchema } : {}),
        };

    if (this.descriptor.openAiCompatible) {
      return openai.buildRequest(
        this.provider,
        this.apiKey,
        this.baseUrl,
        this.model,
        messages,
        bodyOptions,
      );
    }
    if (this.provider === 'anthropic') {
      return anthropic.buildRequest(
        this.apiKey,
        this.baseUrl,
        this.model,
        messages,
        bodyOptions,
      );
    }
    if (this.provider === 'gemini') {
      return gemini.buildRequest(this.apiKey, this.baseUrl, this.model, messages, bodyOptions);
    }
    throw new LlmError(`No adapter for provider ${this.provider}`, null, this.provider, false);
  }

  private async attempt(
    messages: ChatMessage[],
    startedAt: number,
    startedAtIso: string,
    probe: boolean,
  ): Promise<ChatResult> {
    const request = this.buildRequest(messages, probe);
    const response = await executeJsonRequest(this.provider, request, {
      signal: AbortSignal.timeout(this.timeoutMs),
      timeoutMs: this.timeoutMs,
      // MiniMax reports errors inside HTTP 200 bodies; every other provider
      // leaves this off so a `base_resp`-shaped field is never mis-read.
      failFastOnMinimaxBaseResp: this.provider === 'minimax',
    });

    const parsed = this.parse(response.body);
    const latencyMs = Date.now() - startedAt;

    // An empty answer is only acceptable when the provider says the output was
    // capped; otherwise it is a degenerate completion worth retrying.
    if (parsed.isEmpty && parsed.finishReason !== 'length') {
      throw emptyCompletionError(this.provider, response.body);
    }

    if (parsed.finishReason === 'length' && parsed.isEmpty) {
      log.warn(`empty completion with finish_reason=length for ${this.provider}`, {
        provider: this.provider,
        model: parsed.model ?? this.model,
        startedAt: startedAtIso,
        hint: 'reasoning tokens likely consumed the whole output budget',
      });
    }

    // The concrete model the provider actually served. This differs from the
    // configured id on OpenRouter aliases and xAI `latest`, so it is logged.
    if (parsed.model && parsed.model !== this.model) {
      log.info(`model echo differs from request for ${this.provider}`, {
        requested: this.model,
        served: parsed.model,
      });
    }

    return {
      text: parsed.text,
      finishReason: parsed.finishReason,
      usage: parsed.usage ?? EMPTY_USAGE,
      model: parsed.model ?? this.model,
      latencyMs,
      raw: response.body,
    };
  }

  private parse(body: unknown): {
    text: string;
    finishReason: ChatResult['finishReason'];
    usage: ChatResult['usage'];
    model: string | null;
    isEmpty: boolean;
  } {
    if (this.descriptor.openAiCompatible) {
      return openai.parseResponse(this.provider, body, this.model);
    }
    if (this.provider === 'anthropic') return anthropic.parseResponse(body, this.model);
    if (this.provider === 'gemini') return gemini.parseResponse(body, this.model);
    throw new LlmError(`No adapter for provider ${this.provider}`, null, this.provider, false);
  }
}

export type { ChatMessage, ChatResult } from './types.js';
