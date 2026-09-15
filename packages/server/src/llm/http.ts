import {
  abortError,
  classifyHttpError,
  classifyMinimaxBaseResp,
  connectionError,
  timeoutError,
} from './errors.js';
import type { LlmProviderId } from '@aq/shared';
import type { OutboundRequest } from './types.js';

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
    response = await fetch(request.url, {
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

/** Non-throwing variant for `testConnection`, which reports instead of throwing. */
export async function executeJsonRequestSafe(
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
