/**
 * Canonical error type and retryability classifier for the LLM layer.
 *
 * B.16 calls error normalisation "the highest-value adapter work": it is what
 * lets a single retry policy and a single circuit breaker serve every provider.
 * All the vendor-specific judgement therefore lives here rather than in the
 * adapters.
 */

/** Coarse failure classes; the retry decision keys off these, not off prose. */
export type LlmErrorKind =
  | 'auth'
  | 'permission'
  | 'bad_request'
  | 'not_found'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'overloaded'
  | 'server'
  | 'timeout'
  | 'content_filter'
  | 'unknown';

export class LlmError extends Error {
  override readonly name = 'LlmError';

  /**
   * Server-provided `Retry-After`, in milliseconds. Populated by the transport
   * and preferred over any locally computed backoff (B.14 rule 1).
   */
  retryAfterMs: number | null = null;

  /** Vendor-specific identifier, e.g. an HTTP status or MiniMax `status_code`. */
  readonly providerCode: string | number | null;

  /** Coarse class of the failure. */
  readonly kind: LlmErrorKind;

  constructor(
    message: string,
    readonly status: number | null,
    readonly provider: string,
    readonly retryable: boolean,
    readonly body?: unknown,
    options: { kind?: LlmErrorKind; providerCode?: string | number | null } = {},
  ) {
    super(message);
    // Keep `instanceof` working when compiled down: subclassing a built-in
    // loses the prototype link on some targets unless it is re-pinned.
    Object.setPrototypeOf(this, LlmError.prototype);
    this.kind = options.kind ?? 'unknown';
    this.providerCode = options.providerCode ?? status;
  }
}

/** True when the error is safe to retry after a backoff. */
export function isRetryable(error: unknown): boolean {
  return error instanceof LlmError && error.retryable;
}

/* -------------------------------------------------------------------------- */
/*  Quota-exhaustion detection                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A 429 is not automatically transient. Several providers multiplex
 * "slow down" and "you are out of money" onto the same status, and retrying a
 * quota exhaustion is pure waste (B.14). These markers identify the permanent
 * case.
 */
const QUOTA_MARKERS = [
  'credit_balance_exhausted',
  'spend_limit_exceeded',
  'insufficient_balance',
  'insufficient_quota',
  'exceeded_current_quota_error',
  'payment_required',
  'quota_exceeded',
  'billing_error',
];

/** MiniMax `base_resp.status_code` values that map onto a canonical kind. */
const MINIMAX_CODES: Record<number, LlmErrorKind> = {
  1001: 'timeout',
  1002: 'rate_limit',
  1004: 'auth',
  1008: 'quota_exhausted',
  1024: 'server',
  1026: 'content_filter',
  1027: 'content_filter',
  1033: 'server',
  1039: 'bad_request',
  1041: 'rate_limit',
  2013: 'bad_request',
};

/**
 * Phrases that mean "try again in a moment", even when the provider wrapped them
 * in a 4xx.
 *
 * Observed live: a gateway returned **HTTP 400** with the body
 * `模型不可用：deepseek-flash` — literally "model unavailable" — for what was a
 * transient availability blip. The direct call succeeded seconds later. Because
 * 400 maps to `bad_request`, which is correctly non-retryable in general, the
 * request was abandoned and the operator saw a hard failure for a condition that
 * would have cleared on one retry.
 *
 * 4xx is still treated as permanent *by default*; only these explicit
 * availability phrases are exempt. That keeps a genuinely malformed request from
 * becoming a hot retry loop.
 */
const TRANSIENT_BAD_REQUEST_MARKERS = [
  '模型不可用',
  'model unavailable',
  'model not available',
  'no available',
  'temporarily unavailable',
  'overloaded',
  'try again',
  'please retry',
  'capacity',
  'busy',
];

export function kindForStatus(status: number | null, haystack = ''): LlmErrorKind {
  if (status === null) return 'unknown';
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 504) return 'timeout';
  if (status === 429) {
    return haystack.length > 0 && QUOTA_MARKERS.some((m) => haystack.includes(m))
      ? 'quota_exhausted'
      : 'rate_limit';
  }
  if (status === 529) return 'overloaded';
  if (status === 503 || status === 502) {
    return haystack.includes('overload') || haystack.includes('no provider')
      ? 'overloaded'
      : 'server';
  }
  // 501 (not implemented) and 505 (version unsupported) are client/protocol
  // problems, not transient server faults, so they must not be retried (B.14).
  if (status === 501 || status === 505) return 'bad_request';
  if (status >= 500) return 'server';
  if (status >= 400) {
    const lower = haystack.toLowerCase();
    const transient = TRANSIENT_BAD_REQUEST_MARKERS.some((m) => lower.includes(m.toLowerCase()));
    return transient ? 'overloaded' : 'bad_request';
  }
  return 'unknown';
}

/** Map a coarse kind onto the retry policy from B.14. */
export function isRetryableKind(kind: LlmErrorKind): boolean {
  switch (kind) {
    case 'rate_limit':
    case 'overloaded':
    case 'server':
    case 'timeout':
      return true;
    // Auth, permission, bad request, not found, quota exhaustion and content
    // filtering are all deterministic: a retry cannot change the outcome.
    case 'auth':
    case 'permission':
    case 'bad_request':
    case 'not_found':
    case 'quota_exhausted':
    case 'content_filter':
      return false;
    case 'unknown':
      // Ambiguous. Default to not retrying so an unrecognised permanent
      // failure cannot turn into a hot loop against the provider.
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Error body extraction                                                      */
/* -------------------------------------------------------------------------- */

/** Every provider puts the useful sentence somewhere slightly different. */
export function extractMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string') return body.trim() || fallback;
  if (body === null || typeof body !== 'object') return fallback;

  const record = body as Record<string, unknown>;

  const direct = record['message'] ?? record['detail'] ?? record['error_description'];
  if (typeof direct === 'string' && direct.trim() !== '') return direct;

  const error = record['error'];
  if (typeof error === 'string' && error.trim() !== '') return error;
  if (error !== null && typeof error === 'object') {
    const inner = error as Record<string, unknown>;
    const message = inner['message'] ?? inner['detail'];
    if (typeof message === 'string' && message.trim() !== '') return message;
  }

  const baseResp = record['base_resp'] ?? record['baseResp'];
  if (baseResp !== null && typeof baseResp === 'object') {
    const statusMsg = (baseResp as Record<string, unknown>)['status_msg'];
    if (typeof statusMsg === 'string' && statusMsg.trim() !== '') return statusMsg;
  }

  return fallback;
}

/** Flatten the body into a searchable haystack for the sub-type checks. */
export function bodyHaystack(body: unknown, rawText: string): string {
  let json = '';
  try {
    json = JSON.stringify(body) ?? '';
  } catch {
    json = '';
  }
  return `${rawText}\n${json}`.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/*  Constructors                                                               */
/* -------------------------------------------------------------------------- */

/** Build an `LlmError` from an HTTP status plus whatever body came with it. */
export function classifyHttpError(
  provider: string,
  status: number,
  body: unknown,
  rawText = '',
): LlmError {
  const haystack = bodyHaystack(body, rawText);
  const kind = kindForStatus(status, haystack);
  const message = extractMessage(body, `HTTP ${status} from ${provider}`);
  return new LlmError(message, status, provider, isRetryableKind(kind), body, { kind });
}

/**
 * MiniMax reports failures inside an HTTP 200 body via `base_resp`. A generic
 * "2xx means success" check turns a rate limit, an auth failure or an empty
 * balance into a successful completion with empty content — the single most
 * dangerous provider behaviour in the research document (B.8).
 */
export function classifyMinimaxBaseResp(
  provider: string,
  body: unknown,
  httpStatus: number,
): LlmError | null {
  if (body === null || typeof body !== 'object') return null;
  const baseResp = (body as Record<string, unknown>)['base_resp'];
  if (baseResp === null || typeof baseResp !== 'object') return null;

  const record = baseResp as Record<string, unknown>;
  const code = record['status_code'] ?? record['statusCode'];
  const numeric = typeof code === 'number' ? code : typeof code === 'string' ? Number(code) : NaN;
  if (!Number.isFinite(numeric) || numeric === 0) return null;

  const kind: LlmErrorKind = MINIMAX_CODES[numeric] ?? 'unknown';
  const message = extractMessage(body, `MiniMax error ${numeric}`);
  return new LlmError(message, httpStatus, provider, isRetryableKind(kind), body, {
    kind,
    providerCode: numeric,
  });
}

/** A provider returned HTTP 200 but no usable assistant text. */
export function emptyCompletionError(provider: string, body: unknown): LlmError {
  return new LlmError(
    `No assistant text in ${provider} response`,
    null,
    provider,
    // An empty body is usually a transient reasoning-budget or moderation
    // artifact, so a bounded retry is reasonable.
    true,
    body,
    { kind: 'unknown' },
  );
}

export function timeoutError(provider: string, timeoutMs: number): LlmError {
  return new LlmError(
    `${provider} request exceeded ${timeoutMs}ms`,
    null,
    provider,
    true,
    undefined,
    { kind: 'timeout' },
  );
}

export function connectionError(provider: string, cause: unknown): LlmError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new LlmError(`Cannot reach ${provider}: ${message}`, null, provider, true, undefined, {
    kind: 'unknown',
  });
}

/** Aborted by the *caller*, not by our timeout: never retry a cancelled call. */
export function abortError(provider: string, cause: unknown): LlmError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new LlmError(`Aborted: ${message}`, null, provider, false, undefined, { kind: 'unknown' });
}
