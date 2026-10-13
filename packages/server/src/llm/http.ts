import {
  abortError,
  classifyHttpError,
  classifyMinimaxBaseResp,
  connectionError,
  timeoutError,
} from './errors.js';
import { checkOutboundUrl, parseHostAllowlist } from './urlGuard.js';
import { env } from '../env.js';
import type { LlmProviderId } from '@aq/shared';
import type { OutboundRequest } from './types.js';
import { mergeOpenAiStreamChunks, readOpenAiStreamLines } from './stream.js';

/** 需要跟着走的重定向状态码。304 不在内 —— 它不是跳转。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 重定向的上限。
 *
 * `fetch` 默认 `redirect: 'follow'`，而**每一次跳转都不再过 `urlGuard`** ——
 * 那层校验只看了我们拼出来的第一个 URL。后果正是 `urlGuard.ts` 文件头要防的
 * 那个升级路径：`baseUrl` 填一个**合法的公网地址**（校验通过），它回一个
 * `302 Location: http://169.254.169.254/latest/meta-data/iam/security-credentials/`，
 * undici 就带着我们的密钥打到云元数据服务上，而没有任何一道闸拦得住。
 *
 * 所以这里改成**手动跟随**：每一跳都重跑 `checkOutboundUrl`。
 * 合法用途（网关换域名、http→https 归一）继续可用，因为它们的目标同样是公网地址；
 * 打到回环 / 链路本地 / RFC1918 的那一跳会被拒绝，与直接填写该地址的结果一致。
 *
 * 上限的存在是为了不让一个互相指向的网关把我们挂死在重定向里。
 */
const MAX_REDIRECTS = 5;

/**
 * 发出一次出站请求，并**在每一跳重定向上都重跑出站地址白名单**。
 *
 * ⚠️ **跨主机跳转时不带原始请求头。**
 *
 * 不只是防止密钥进日志 —— 这里的风险是请求头被**转发到另一台主机**：
 * `x-api-key` / `api-key` / `x-goog-api-key` / `Authorization` 都是各家鉴权头，
 * 跳到 `169.254.169.254` 或 `127.0.0.1` 时，它们会被一起带过去。
 * 同主机的 http→https 归一（同一组端点）保留鉴权头，否则那一跳会直接 401。
 */
export async function fetchGuarded(url: string, init: RequestInit): Promise<Response> {
  const allowPrivateHosts = parseHostAllowlist(env.allowPrivateLlmHosts);
  let current = url;
  let headers = init.headers;

  for (let hop = 0; ; hop += 1) {
    const verdict = checkOutboundUrl(current, allowPrivateHosts);
    if (!verdict.allowed) {
      throw connectionError('outbound', new Error(`出站地址被拒绝：${verdict.reason ?? current}`));
    }

    const response = await fetch(current, { ...init, headers, redirect: 'manual' });

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    /*
     * 从这一行往下，`response` 只是我们要跟着走的中转站 —— 它的 body 必须丢掉：
     * 不消费它，那一跳的连接就一直挂着不释放，而这是一台 7x24 常在的服务器，
     * 跳转次数累积起来就是 fd 泄漏。`cancel()` 失败（已经结束）时忽略即可，
     * 它只是清理，不是业务逻辑。
     *
     * **放在所有提前 return / throw 之前**，是为了让"带个响应体离开这个分支"的
     * 每条路径都经过它 —— 否则迟早会有一条忘了 cancel。
     */
    void response.body?.cancel().catch(() => undefined);

    const location = response.headers.get('location');
    if (!location) return response;
    if (hop >= MAX_REDIRECTS) {
      throw connectionError('outbound', new Error(`重定向超过 ${MAX_REDIRECTS} 跳，已放弃`));
    }

    // 相对 Location 要按当前 URL 解析，否则换路径的网关会丢整段 base。
    const next = new URL(location, current).toString();
    if (new URL(next).host !== new URL(current).host) {
      // 跨主机：丢掉全部请求头（见上面那段为什么）。
      headers = undefined;
    }
    current = next;
  }
}

/**
 * Shared HTTP plumbing for every adapter.
 *
 * Deliberately small: URL joining, JSON body reading, and the translation of
 * transport-level failures into `LlmError`. Retry, backoff and timeout policy
 * live in `client.ts` so all providers share one implementation.
 */

/** Vendors with an trailing slash in their descriptor would otherwise produce `//chat`. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Kimi answers a gateway timeout with an HTML error page (B.7), and OpenRouter
 * masks its 5xx messages, so a JSON parse failure must never mask the status.
 */
export function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Hand the raw text back so error extraction still sees something useful.
    return text;
  }
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  body: unknown;
  rawText: string;
  retryAfterMs: number | null;
}

/**
 * Parse `Retry-After` in both documented forms (delta-seconds and HTTP-date)
 * and clamp it, so a hostile or buggy value cannot stall the bot for hours
 * (B.14 rule 1).
 */
export function parseRetryAfter(value: string | null, maxMs = 60_000): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxMs);

  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), maxMs);
  return null;
}

/**
 * Issue one HTTP call.
 *
 * `failFastOnMinimaxBaseResp` must stay true for MiniMax, which reports errors
 * inside an HTTP 200 body. Any 2xx with a non-zero `base_resp.status_code` is
 * raised as an `LlmError` here rather than being returned as a completion.
 */
export async function executeJsonRequest(
  provider: LlmProviderId | string,
  request: OutboundRequest,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    failFastOnMinimaxBaseResp?: boolean;
  } = {},
): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetchGuarded(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // An abort raised by our own timeout is a retryable slow generation; an
    // abort raised by the caller is a cancellation and must not be retried.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw timeoutError(String(provider), options.timeoutMs ?? 0);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw abortError(String(provider), error);
    }
    throw connectionError(String(provider), error);
  }

  const rawText = await response.text();
  const body = safeJsonParse(rawText);
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

  if (options.failFastOnMinimaxBaseResp === true) {
    const baseRespError = classifyMinimaxBaseResp(String(provider), body, response.status);
    if (baseRespError) {
      baseRespError.retryAfterMs = retryAfterMs;
      throw baseRespError;
    }
  }

  if (!response.ok) {
    const error = classifyHttpError(String(provider), response.status, body, rawText);
    error.retryAfterMs = retryAfterMs;
    throw error;
  }

  return { status: response.status, ok: response.ok, body, rawText, retryAfterMs };
}

/**
 * ⚠️ **流式版本 —— 响应头一回来就拿到，而不是等整个响应生成完。**
 *
 * ## 为什么需要它（2026-10-01，`HTTP 524`）
 *
 * `executeJsonRequest` 用的是 `await response.text()`：那要等**完整响应**。
 * 而链路上的网关（Cloudflare）等 **100 秒**还没看到**响应头**就发 `HTTP 524` ——
 * 实测我们的请求要 **60–205 秒**（100K tokens 的一次 220 秒），
 * 于是**整轮决策作废**（一轮 8 轮里 4 次）。
 *
 * 流式下源站**一连上就返回响应头**（`200 text/event-stream`），
 * 之后才慢慢吐 token —— 网关的计时不再是问题。而本函数仍然读到流结束才返回，
 * 所以**对上层完全透明**。
 *
 * 返回值与 `executeJsonRequest` 同形状：SSE 分片已经被
 * `mergeOpenAiStreamChunks` **重组成非流式的 JSON 形状**，
 * 因此 `client.ts` 的 `parse()` 一行都不用改。
 *
 * （把客户端 `timeout_seconds` 提到 600 秒解决不了这个问题：
 * 那个计时器在客户端，限制在中间的网关那里。）
 */
/**
 * 流式请求的**"卡住"阈值**（毫秒）：多久没有收到任何字节才算断了。
 *
 * ## 为什么不是"总时长"（2026-10-10，用户实测）
 *
 * 用户的原话：「我实测换了其他模型\第三方提供商，模型速度慢、有时候不通……只要重试\等待
 * 基本能正常使用的情况下，系统会判定为失败……在我看来不管是什么模型\提供商，
 * **只要请求上游在吐字返回**，偶发失败都是正常情况，系统应当正常运行下去」。
 *
 * 原来的做法是给整条流式请求套一个总时长超时（`AbortSignal.timeout`），
 * 而那个值是按当年的 `v4.1-flash`（约 300 tok/s）设计的。换成约 30 tok/s 的模型，
 * 一次长回答的总时长涨十倍，于是**它一边正常吐字、一边被判超时**。
 *
 * 所以判据换成"**有没有在动**"：只要还收到数据就重置计时器，真的静默这么久才中止。
 * 外层还有轮次硬超时（60 分钟）兜底，不会真的无限等。
 *
 * 180 秒是留足前置（prefill）的：大提示词在慢提供商上可能几十秒才吐第一个字。
 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000;
export async function executeStreamRequest(
  provider: LlmProviderId | string,
  request: OutboundRequest,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<JsonResponse> {
  /*
   * 流式用"卡住超时"而不是"总时长超时" —— 见 `STREAM_IDLE_TIMEOUT_MS` 的说明。
   */
  const idleMs = Math.max(STREAM_IDLE_TIMEOUT_MS, options.timeoutMs ?? 0);
  const stall = new AbortController();
  let idleTimer: NodeJS.Timeout | null = null;
  const bumpIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stall.abort(new Error('stream idle')), idleMs);
    idleTimer.unref?.();
  };
  bumpIdle();
  const signals = options.signal ? [stall.signal, options.signal] : [stall.signal];
  const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

  let response: Response;
  try {
    response = await fetchGuarded(request.url, {
      method: 'POST',
      headers: { ...request.headers, accept: 'text/event-stream' },
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (error) {
    if (idleTimer) clearTimeout(idleTimer);
    /* 我们自己因为"卡住"而中止的算**可重试的超时**（它是慢，不是坏）。 */
    if (stall.signal.aborted) throw timeoutError(String(provider), idleMs);
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw timeoutError(String(provider), options.timeoutMs ?? 0);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw abortError(String(provider), error);
    }
    throw connectionError(String(provider), error);
  }

  /*
   * 非 2xx 时上游发的是普通 JSON 错误体（不是 SSE），所以照 `executeJsonRequest`
   * 那条路解析与分类 —— 错误分类逻辑必须只有一份。
   */
  if (!response.ok) {
    const rawText = await response.text().catch(() => '');
    const error = classifyHttpError(String(provider), response.status, safeJsonParse(rawText), rawText);
    error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    throw error;
  }

  let lines: string[];
  try {
    /* 每收到一块数据就重置"卡住"计时器 —— 慢模型因此不会被总时长误杀。 */
    lines = await readOpenAiStreamLines(response, bumpIdle);
  } catch (error) {
    if (stall.signal.aborted) throw timeoutError(String(provider), idleMs);
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
  const merged = mergeOpenAiStreamChunks(lines);
  return {
    status: response.status,
    ok: response.ok,
    body: merged,
    rawText: '',
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  };
}

/** Non-throwing variant for `testConnection`, which reports instead of throwing. */export async function executeJsonRequestSafe(
  provider: LlmProviderId | string,
  request: OutboundRequest,
  options: { signal?: AbortSignal; timeoutMs?: number; failFastOnMinimaxBaseResp?: boolean } = {},
): Promise<{ response: JsonResponse | null; error: Error | null }> {
  try {
    return { response: await executeJsonRequest(provider, request, options), error: null };
  } catch (error) {
    return { response: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
