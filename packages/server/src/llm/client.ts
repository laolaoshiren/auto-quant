import { getProvider, type LlmProviderId, type LlmProviderDescriptor } from '@aq/shared';
import { createLogger } from '../logger.js';
import { maskSecret } from '../crypto/vault.js';
import { LlmError, emptyCompletionError, isRetryable } from './errors.js';
import { executeJsonRequest, executeStreamRequest } from './http.js';
import { nextReasoningEffort } from './effortFallback.js';
import * as openai from './openaiCompatible.js';
import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';
import { EMPTY_USAGE, type ChatMessage, type ChatResult, type OutboundRequest } from './types.js';
import { checkOutboundUrl } from './urlGuard.js';

const log = createLogger('llm');

/**
 * 默认的单次请求超时（秒）。
 *
 * ⚠️ **120 秒对"大提示词 + 推理模型"是不够的（2026-10-01 实测）。**
 *
 * 这个机器人的一轮请求是 **约 190K prompt tokens + 20K 推理 tokens**，
 * 实测单次耗时在 45s–332s 之间波动。原来的 240 秒上限会被正常的大请求撞到，
 * 而**超时被归类成"AI 服务不可用"**（`#1621` 的原始错误是
 * `commandcode request exceeded 240000ms`）—— 于是：
 *
 *   · 操作员看到"上游故障"，而**他单独用 API 测上游时它是好的**；
 *   · 系统在那一轮白白失败，等一整个周期才再试。
 *
 * 更大的超时不解决问题（真正的病根是提示词太大，见 `CANDIDATE_HARD_CAP`），
 * 但它**避免把"我们跑得慢"误报成"上游挂了"** —— 那是两条完全不同的诊断路径。
 */
const DEFAULT_TIMEOUT_SECONDS = 300;
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
  /**
   * 思考等级。默认 `high` —— 见 `ChatRequest.reasoningEffort` 上的说明。
   *
   * 设成 `undefined` 就完全不发这个参数（给"确认不支持"的 provider 用）。
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
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
/**
 * 这个**模型**该不该走 Anthropic Messages 协议。
 *
 * ## 为什么要有这个判断（2026-10-08 用户实测）
 *
 * 用户报「OpenCode GO 选 claude 用不了」。查它的文档
 * （<https://opencode.ai/docs/zh-cn/go/>）有一张**端点表**：一个 baseUrl 下
 * 按模型分三种协议 ——
 *
 * | 端点 | 模型 |
 * | --- | --- |
 * | `/v1/chat/completions` | DeepSeek / GLM / Kimi / MiMo / LongCat / Hy3 / Space Bunny |
 * | **`/v1/messages`** | **Claude Haiku 5.5** / MiniMax M3 · M2.7 / Qwen3.8 Max · Flash / Qwen3.7 Plus |
 * | `/v1/responses` | Grok 4.6 · 4.7 / GPT 6 Luna · GPT 5.6 Luna / Muse Spark |
 *
 * 而原来的分发**只看供应商**（`descriptor.openAiCompatible`）——
 * `opencode` 是 OpenAI 兼容，于是**所有模型都被发到 `/chat/completions`**，
 * claude 被网关拒收并回 `Model does not support this protocol.`。
 * **端点表就在文档上，我们没照着实现。**（适配器 `llm/anthropic.ts` 早就写好了。）
 *
 * ## 为什么是纯函数
 *
 * 判定是"供应商 + 模型 id → 协议"的纯映射，与 `LlmClient` 实例无关。
 * 抽出来就能**直接断言**，不必去 mock 网络 —— 而网络 mock 出来的绿勾
 * 证明不了"真的发到了 `/messages`"（这一条正是被这个 bug 咬过的教训）。
 *
 * ## 尚未实现的一类
 *
 * `/v1/responses`（Grok / GPT Luna / Muse Spark）还没有适配器，
 * 它们仍会走 `/chat/completions` 并失败。**那是已知缺口，不是静默容忍** ——
 * 等有需求时在这里加第二条分支。
 */
export function usesAnthropicProtocol(provider: string, model: string): boolean {
  if (provider === 'anthropic') return true;
  /*
   * 依据是**网关自己的模型 id**（文档逐条列了 id 与端点的对应），不是猜测。
   * 用前缀匹配而不是穷举名单：网关新增同族模型时不必改代码，
   * 而 `claude-` / `minimax-` / `qwen3.7-` / `qwen3.8-` 这几族在文档里**全部**属于 /messages。
   */
  return /^(claude-|minimax-|qwen3\.7-|qwen3\.8-)/i.test(model);
}
export class LlmClient {
  readonly provider: LlmProviderId;
  readonly descriptor: LlmProviderDescriptor;
  readonly model: string;
  readonly baseUrl: string;

  private readonly apiKey: string;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;
  private readonly timeoutMs: number;
  /**
   * 流式请求被网关拒绝后置位 —— 此后这一实例退回非流式。
   *
   * ⚠️ **不能让一个可选优化变成"每一轮都失败"。** 参数名是 `stream`，
   * 而 `OpenAI` 兼容网关的实现质量参差：有的不认 `stream_options`，
   * 有的把流式当成不同的端点。而 400 被正确归为"不可重试"，
   * 于是不降级就等于每轮都炸。
   */
  private streamDisabled = false;
  /**
   * 这一实例内已经发生过多少次"网关/请求超时"。
   *
   * ⚠️ 计入两类：我们自己的 `timeout`（`AbortSignal.timeout` 到期），
   * 以及 `HTTP 524` —— 那是 **Cloudflare 的"源站超时"**：网关等 100 秒
   * 没拿到响应头就放弃。实测一次 100K tokens 的请求要 220 秒、
   * 一轮 8 轮里 4 次这样失败（见 `effortFallback.ts`）。
   *
   * 这个计数只增不减：振荡（降了→成功→升回去→又超时）会让成功率
   * 取决于上一次的运气。
   */
  private timeoutCount = 0;
  private readonly maxRetries: number;
  private readonly jsonMode: boolean;
  private readonly jsonSchema: Record<string, unknown> | undefined;
  /**
   * 思考等级。**不是 `readonly`** —— 被 provider 拒绝时要在运行中清掉它。
   */
  private reasoningEffort: 'low' | 'medium' | 'high' | undefined;
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
    this.reasoningEffort = options.reasoningEffort;
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
      log.warn(`${this.provider} 的连通性探测失败`, {
        provider: this.provider,
        model: this.model,
        baseUrl: this.baseUrl,
        apiKey: this.keyHint,
        error: message,
      });
      return { ok: false, message, latencyMs: Date.now() - startedAt };
    }
  }

  async chat(
    messages: ChatMessage[],
    options: { probe?: boolean; signal?: AbortSignal } = {},
  ): Promise<ChatResult> {
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
        const result = await this.attempt(messages, startedAt, startedAtIso, options);
        log.info(`模型调用成功：${this.provider} / ${result.model}`, {
          provider: this.provider,
          model: result.model,
          finishReason: result.finishReason,
          latencyMs: result.latencyMs,
          usage: result.usage,
        });
        return result;
      } catch (error) {
        lastError = error;

        /*
         * ⚠️ **降级：`reasoning_effort` 被拒时，去掉它重来一次。**
         *
         * 这个参数不是所有 provider 都认。而 400 被正确地归为**不可重试**
         * （重试改变不了结果）—— 于是不支持的 provider 会让**每一轮决策都失败**。
         *
         * **这不是「重试同一个请求」，而是「换一个更保守的请求」**：
         * 去掉那个可能不被接受的参数。代价只是多一个往返，
         * 收益是「默认 high」这个要求不会变成一次全线故障。
         *
         * 只做一次（`effortDropped` 守住），而且**清掉之后就不再恢复** ——
         * 一个已经被拒的参数，下一轮再带上只会再被拒一次。
         * 这个判断活在客户端实例上，而实例是每个机器人一个、随进程存活。
         */
        if (
          this.reasoningEffort !== undefined &&
          error instanceof LlmError &&
          error.kind === 'bad_request'
        ) {
          const dropped = this.reasoningEffort;
          this.reasoningEffort = undefined;
          log.warn(
            `${this.provider} 拒绝了 reasoning_effort=${dropped}，已去掉该参数并立即重试 —— ` +
              '这次调用不会因为一个可选的思考等级而失败。',
            { provider: this.provider, model: this.model, status: error.status },
          );
          /*
           * ⚠️ **`continue` 会消耗一次重试预算 —— 注释原来写反了。**
           *
           * 这里是 `for (let attempt = 0; attempt <= this.maxRetries; attempt += 1)`，
           * 而 `for` 里的 `continue` **会执行 `attempt += 1`**。原来那句注释说
           * "`attempt` 不递增 —— 这次降级不算一次重试"，描述的语义并没有发生。
           *
           * 后果有限但不为零：`maxRetries: 3` 时少一次重试预算。真正会出事的是
           * `maxRetries: 0`（API 允许这么配）—— 那种情况下 `attempt` 直接变 1、
           * 循环条件不再成立，**去掉 `reasoning_effort` 的降级重试永远不会发生**，
           * `bad_request` 会原样抛出去。
           *
           * 这条注释改成陈述事实。要不要把"降级不计入重试"真的实现出来是另一个决定
           * （改循环结构），但那属于行为变更，不该顺手做。
           */
          continue;
        }

        /*
         * ⚠️ **流式被网关拒绝 → 退回非流式重来一次。**
         *
         * 与上面 `reasoning_effort` 的降级同一类：`stream` 是一个**可选优化**
         * （它解决网关 100 秒的源站超时，见 `stream.ts`），而某些 OpenAI 兼容
         * 网关不认 `stream` 或 `stream_options`，会返回 400 ——
         * 而 400 被正确归为"不可重试"，于是不降级就等于**每一轮都失败**。
         *
         * 只做一次（`streamDisabled` 守住），且**关掉就不再打开** ——
         * 一个已经拒绝过流式的端点，下一轮再试只会再被拒一次。
         * 这个标记活在客户端实例上，而实例是每个机器人一个、随进程存活。
         *
         * 注意：这里的 `continue` **会消耗一次重试预算**（见上面那条注释），
         * 所以它只在 `maxRetries >= 1` 时才有第二次机会 —— 而这正是
         * 本项目所有 provider 的默认值（2–3）。
         */
        if (
          this.descriptor.openAiCompatible &&
          !this.streamDisabled &&
          error instanceof LlmError &&
          error.kind === 'bad_request'
        ) {
          this.streamDisabled = true;
          log.warn(
            `${this.provider} 拒绝了流式请求（HTTP ${error.status}），已退回非流式并立即重试 —— ` +
              '这次调用不会因为一个可选优化而失败。',
            { provider: this.provider, model: this.model, status: error.status },
          );
          continue;
        }

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
          if (retryable) log.error(`${this.provider} 的模型调用失败 —— 重试次数已用尽`, detail);
          else log.error(`${this.provider} 的模型调用失败 —— 这类错误不会因重试而成功`, detail);
          throw error;
        }

        /*
         * ⚠️ **记下超时**：`524` 是 Cloudflare 的"源站超时"，`timeout` 是我们自己的
         * `AbortSignal` 到期 —— 两者都说明"这一次请求的生成耗时超过了链路的忍耐上限"。
         * 下一次请求会因此用更小的思考预算（见 `buildRequest` 与 `effortFallback.ts`）。
         */
        if (
          error instanceof LlmError &&
          (error.kind === 'timeout' || error.status === 524)
        ) {
          this.timeoutCount += 1;
        }

        // Prefer the server's Retry-After over our own backoff when present.
        const retryAfterMs = error instanceof LlmError ? error.retryAfterMs : null;
        const delayMs = retryAfterMs ?? backoffDelayMs(attempt);
        log.warn(`第 ${attempt + 1}/${this.maxRetries} 次重试 ${this.provider}，等待 ${delayMs}ms 后开始`, {
          ...detail,
          retryAfterMs,
        });
        await sleep(delayMs);
      }
    }

    throw lastError ?? new Error(`chat exhausted retries for ${this.provider}`);
  }

  /** Convenience wrapper matching how the strategy engine calls it. */
  async complete(
    systemPrompt: string,
    userPrompt: string,
    options?: { signal?: AbortSignal },
  ): Promise<ChatResult> {
    return this.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options,
    );
  }

  /* ---------------------------------------------------------------------- */
  /*  Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * 这个**模型**是否该走 Anthropic Messages 协议。
   *
   * ## 为什么按模型判而不是按供应商
   *
   * OpenCode Go 一个 baseUrl 下按模型分三种协议（见文档的端点表）。
   * 所以"供应商是不是 OpenAI 兼容"这个判断**粒度太粗** ——
   * `opencode` 既发 OpenAI 兼容的 deepseek，也发 Anthropic 协议的 claude。
   *
   * 判定依据是**模型 id**：`claude-*` 走 `/messages`。这是网关自己的命名，
   * 不是我们的猜测（文档的端点表逐条列了模型 ID 与端点的对应）。
   * 以后若要接 `/v1/responses`（grok / gpt-6-luna），在这里加第二条分支即可。
   */
  private usesAnthropicProtocol(): boolean {
    return usesAnthropicProtocol(this.provider, this.model);
  }

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
          /*
           * 思考等级。探测请求（`probe`）刻意**不带**它 ——
           * 探测只回答"这个端点通不通、这把钥匙对不对"，
           * 让一次连通性检查也去花思考预算是浪费。
           *
           * ⚠️ **超时过就把这一档降下来**（`effortFallback.ts`）。
           * 实测耗时几乎全在"想"上（一次 100K tokens 的请求 220 秒，
           * 其中推理占 2 万 tokens），而链路上的网关等 100 秒就发 `HTTP 524`。
           * 这不是"替模型决定想多深"，而是**把已经超时的那一轮救回来** ——
           * 判断内容一点没变。
           */
          ...(() => {
            const effort = nextReasoningEffort(this.reasoningEffort, this.timeoutCount);
            return effort !== undefined ? { reasoningEffort: effort } : {};
          })(),
        };

    /*
     * ⚠️ **同一个网关下，不同模型走不同协议 —— 必须按模型判，不能只看供应商。**
     *
     * 用户 2026-10-08 报「OpenCode GO 选 claude 用不了」。查它的文档
     * （<https://opencode.ai/docs/zh-cn/go/>）有一张端点表：
     *
     *   · `/v1/chat/completions` —— DeepSeek / GLM / Kimi / MiMo / LongCat…
     *   · `/v1/messages`         —— **Claude Haiku 5.5** / MiniMax / Qwen3.8
     *   · `/v1/responses`        —— Grok / GPT-6 Luna / Muse Spark
     *
     * 而原来这一行只看 `descriptor.openAiCompatible`（`opencode` 是 true），
     * 于是**所有模型都被发到 `/chat/completions`** —— claude 因此被网关拒收，
     * 报 `Model does not support this protocol.`。**端点表就在文档里，我们没照着实现。**
     *
     * 适配器本身**早就有了**（`llm/anthropic.ts`，`x-api-key` + `anthropic-version`
     * + `/messages`，与实测成功的请求完全一致）—— 缺的只是这一处分发。
     */
    if (this.usesAnthropicProtocol()) {
      return anthropic.buildRequest(
        this.apiKey,
        this.baseUrl,
        this.model,
        messages,
        bodyOptions,
        /* 供应商自定义头必须跟着走 —— opencode 缺了 x-opencode-session 会被直接拒。 */
        this.descriptor.modelsHeaders ?? {},
      );
    }
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
    options: { probe?: boolean; signal?: AbortSignal } = {},
  ): Promise<ChatResult> {
    const probe = options.probe === true;
    const request = this.buildRequest(messages, probe);
    /*
     * ⚠️ **OpenAI 兼容的 provider 默认走流式**（探测请求除外）。
     *
     * 非流式要等整个响应生成完才返回响应头，而链路上的网关等 100 秒就发
     * `HTTP 524`；我们的请求实测 60–205 秒 —— **整轮决策作废**
     * （2026-10-01 实测：一轮 8 轮里 4 次）。见 `stream.ts`。
     *
     * `streamDisabled` 是一次性的自我降级：若某个网关**不接受**流式参数
     * （返回 400），这一实例此后就退回非流式 —— 不能让一个可选优化
     * 变成"每一轮都失败"。
     */
    /*
     * ⚠️ **Anthropic 路径必须排除在流式之外。**
     *
     * `executeStreamRequest(this.provider, …)` 是**按供应商**选解析器的 ——
     * `opencode` 会拿到 OpenAI 的 SSE 解析器，而 `/v1/messages` 返回的是
     * Anthropic 自己的事件格式（`content_block_delta` 等）。硬走流式会解析出空内容。
     *
     * 代价：claude 走非流式，而那条路要等整段生成完才回响应头 ——
     * 链路上的网关等 100 秒会发 `HTTP 524`。Haiku 是快模型（实测 1.8–4.6 秒），
     * 但**我们的提示词很大**，真撞上 524 时的正解是补 Anthropic 的 SSE 解析，
     * 而不是把它塞进 OpenAI 的解析器。**先把协议发对，再谈流式。**
     */
    const useStream =
      this.descriptor.openAiCompatible &&
      !probe &&
      !this.streamDisabled &&
      !this.usesAnthropicProtocol();
    /*
     * ⚠️ **两个取消源要合并：本客户端自己的超时 + 调用方传来的 signal。**
     *
     * 只有前者时，调用方（`AutoTrader.inCycle` 的硬超时）`abort()` 了也没用 ——
     * 请求会一直挂到 300 秒的单次上限。而那个硬超时正是为了把"卡住的轮次"
     * 收掉（2026-10-02：这类僵尸轮次累积到把服务器内存耗尽），
     * 所以它必须能真正打断网络等待。
     *
     * `AbortSignal.any` 是 Node 20.3+ 的能力，本项目要求 ≥22.5，可以用。
     * 任一信号触发都会中止这一跳；重试循环会照常进入下一次尝试，
     * 而那时 `signal.aborted` 仍为真 —— 上层会看到这一轮被判定为失败。
     */
    const signal =
      options.signal === undefined
        ? AbortSignal.timeout(this.timeoutMs)
        : AbortSignal.any([AbortSignal.timeout(this.timeoutMs), options.signal]);
    const response = useStream
      ? await executeStreamRequest(this.provider, request, {
          signal,
          timeoutMs: this.timeoutMs,
        })
      : await executeJsonRequest(this.provider, request, {
          signal,
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
      log.warn(`${this.provider} 返回了空内容（finish_reason=length，输出被长度上限截断）`, {
        provider: this.provider,
        model: parsed.model ?? this.model,
        startedAt: startedAtIso,
        hint: 'reasoning tokens likely consumed the whole output budget',
      });
    }

    // The concrete model the provider actually served. This differs from the
    // configured id on OpenRouter aliases and xAI `latest`, so it is logged.
    if (parsed.model && parsed.model !== this.model) {
      log.info(`${this.provider} 回显的模型名与请求的不一致`, {
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
    if (this.provider === 'anthropic' || this.usesAnthropicProtocol()) return anthropic.parseResponse(body, this.model);
    if (this.provider === 'gemini') return gemini.parseResponse(body, this.model);
    throw new LlmError(`No adapter for provider ${this.provider}`, null, this.provider, false);
  }
}

export type { ChatMessage, ChatResult } from './types.js';
