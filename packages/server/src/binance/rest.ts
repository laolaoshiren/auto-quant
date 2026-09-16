import { createHmac } from 'node:crypto';
import { createLogger } from '../logger.js';
import { resolveEndpoints, type BinanceEndpoints, type BinanceEnvironment } from './endpoints.js';
import { BinanceApiError, type BinanceErrorBody } from './types.js';

const log = createLogger('binance:rest');

/**
 * Documented fallback ceiling for USDⓈ-M futures request weight.
 *
 * **Production is 2400/min; testnet/demo is 6000/min.** Hardcoding the testnet
 * figure on production earns a 429 and then an IP ban, so this is only a
 * starting value — `bootstrapExchange()` overwrites it from the live
 * `exchangeInfo.rateLimits` array before any trading begins.
 */
export const WEIGHT_LIMIT_DEFAULT = 2400;
/** Start throttling once this fraction of the budget is consumed. */
const WEIGHT_SOFT_LIMIT = 0.75;

/**
 * How many requests this client is willing to have *in flight* at once.
 *
 * This is the part of the weight budget that a header alone cannot enforce.
 * `captureWeight()` can only report what Binance has already counted, so a
 * `Promise.all` that fans out 40 klines calls evaluates every one of them
 * against the same stale header and all 40 leave at once — the 75% soft limit
 * is simply not consulted. Measured weight on a `coinPoolLimit: 30` strategy
 * with four timeframes is ~120 requests per cycle (30 symbols × 4) plus 40 more
 * from `getOiRanking`, so an unbounded fan-out can cross a 2400/min budget in a
 * single cycle. The only backstop left in that situation is Binance's own 429,
 * and a 418 after it is an IP ban.
 *
 * Bounding the width does not cost accuracy — the same requests still go out,
 * just paced — and it converts "burst that trips the limit" into "burst that
 * finishes a few seconds later".
 */
export const MAX_IN_FLIGHT_REQUESTS = 6;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface BinanceRestOptions {
  apiKey?: string;
  apiSecret?: string;
  /** Which Binance deployment to talk to. Defaults to live. */
  environment?: BinanceEnvironment;
  /** @deprecated retained for callers that only think in testnet terms. */
  testnet?: boolean;
  /** Milliseconds the request stays valid on the server. Binance caps at 60000. */
  recvWindow?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Override the fan-out ceiling. Defaults to `MAX_IN_FLIGHT_REQUESTS`. */
  maxInFlight?: number;
}

interface RequestOptions {
  signed?: boolean;
  /** Extra attempts beyond the first. */
  retries?: number;
  /** Skip the shared weight gate (used by the time-sync probe itself). */
  skipWeightGate?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Binance resets `X-MBX-USED-WEIGHT-1M` on its own one-minute boundary. */
export const WEIGHT_WINDOW_MS = 60_000;

/**
 * How much of a weight reading we still believe is charged, `elapsedMs` into the
 * window it belongs to.
 *
 * **Why this is not just "the last observed reading".** The header is the only
 * thing that ever resets the counter, and several responses legitimately omit it
 * — a 429 is the important one, because that is exactly the moment the counter is
 * highest. With no decay the stale high reading survives indefinitely and every
 * subsequent request sleeps `min(remaining, 10s)`, so the trading loop stalls in
 * 10-second steps until some unrelated header-bearing response happens to arrive
 * and clears it. The old code's `weightResetAt` was meant to guard against that,
 * but it was overwritten by every header-bearing response, so it only postponed
 * the same stall.
 *
 * Decaying instead charges the last observed figure only for the part of the
 * window that has not elapsed. This **over**-estimates, never under-estimates, so
 * it errs toward slowing down rather than toward tripping the limit — exact
 * accounting is the server's job, ours is only to stay clear of it.
 *
 * A pure function with `elapsedMs` injected rather than calling `Date.now()`
 * inside, so the decay curve is unit-testable without waiting a real minute
 * (AGENTS.md §5.4: 导出的纯函数优先于需要打桩的对象).
 *
 * @param reading        the last `x-mbx-used-weight-1m` value, or 0 if none.
 * @param windowStartMs  local time at which that reading's window opened, or 0
 *                       when no header has ever been seen.
 * @param nowMs          current local time.
 */
export function decayWeight(reading: number, windowStartMs: number, nowMs: number): number {
  if (!(reading > 0)) return 0;
  if (windowStartMs === 0) {
    // Unanchored: no header has ever arrived, so there is nothing to decay
    // against. Trust the reading rather than throwing the budget away.
    return reading;
  }
  const elapsed = nowMs - windowStartMs;
  if (elapsed <= 0) return reading;
  if (elapsed >= WEIGHT_WINDOW_MS) return 0;
  return reading * (1 - elapsed / WEIGHT_WINDOW_MS);
}

/**
 * Low-level Binance USDⓈ-M Futures REST transport.
 *
 * Responsibilities kept here, and only here:
 *  - HMAC-SHA256 request signing with a live server-time offset
 *  - automatic recovery from `-1021` (timestamp drift) and 429/418 (throttling)
 *  - request-weight accounting from the `X-MBX-USED-WEIGHT-1M` header
 *  - admission control: at most `MAX_IN_FLIGHT_REQUESTS` concurrent requests,
 *    checked against the weight budget *before* each one leaves
 *
 * Everything above this file deals in domain objects, never in signatures.
 */
export class BinanceRest {
  readonly baseUrl: string;
  readonly endpoints: BinanceEndpoints;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly recvWindow: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  /** `serverTime - localTime`, in milliseconds. */
  private timeOffset = 0;
  private lastTimeSyncAt = 0;

  /** Most recent weight reading, surfaced on the dashboard. */
  usedWeight1m = 0;
  /**
   * Per-minute weight budget. Seeded with the production figure and replaced
   * from `exchangeInfo.rateLimits` during bootstrap, because testnet allows
   * 6000/min while production allows 2400/min.
   */
  weightLimitPerMinute = WEIGHT_LIMIT_DEFAULT;
  /**
   * When the *server's* current weight window started, in local time.
   *
   * Binance resets `X-MBX-USED-WEIGHT-1M` on its own minute boundary, which is
   * not our minute boundary. Everything that decays `usedWeight1m` needs to know
   * where that boundary is, otherwise the counter either never resets (a stalled
   * bot) or resets too early (a burst straight into a 429).
   */
  private weightWindowStart = 0;
  /** Requests currently in flight, used to bound fan-out width. */
  private inFlight = 0;
  private readonly maxInFlight: number;
  /** Resolvers waiting for a request slot, in FIFO order. */
  private readonly slotWaiters: Array<() => void> = [];

  constructor(options: BinanceRestOptions = {}) {
    // `testnet: true` historically meant the legacy futures testnet. Map it to
    // the current demo environment, which is the forward path.
    const environment: BinanceEnvironment =
      options.environment ?? (options.testnet ? 'demo' : 'production');
    this.endpoints = resolveEndpoints(environment);
    this.baseUrl = this.endpoints.rest;

    this.apiKey = options.apiKey ?? '';
    this.apiSecret = options.apiSecret ?? '';
    this.recvWindow = options.recvWindow ?? 5000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxInFlight = Math.max(1, options.maxInFlight ?? MAX_IN_FLIGHT_REQUESTS);
  }

  get isTestnet(): boolean {
    return this.endpoints.isTestnet;
  }

  get hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  /* ---------------------------------------------------------------------- */
  /*  Time synchronisation                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Pin our clock to Binance's. A drift beyond `recvWindow` produces `-1021`
   * on every signed call, so this runs once at startup and again on demand.
   */
  async syncTime(force = false): Promise<number> {
    const now = Date.now();
    if (!force && this.lastTimeSyncAt > 0 && now - this.lastTimeSyncAt < 60_000) {
      return this.timeOffset;
    }
    const before = Date.now();
    const { serverTime } = await this.request<{ serverTime: number }>('GET', '/fapi/v1/time', {}, {
      retries: 2,
      skipWeightGate: true,
    });
    const rtt = Date.now() - before;
    // Assume the response was generated roughly halfway through the round trip.
    this.timeOffset = serverTime + Math.floor(rtt / 2) - Date.now();
    this.lastTimeSyncAt = Date.now();
    if (Math.abs(this.timeOffset) > 1000) {
      log.warn(`clock drift detected: ${this.timeOffset}ms — signing with corrected timestamp`);
    }
    return this.timeOffset;
  }

  private timestamp(): number {
    return Date.now() + this.timeOffset;
  }

  /* ---------------------------------------------------------------------- */
  /*  Public helpers                                                         */
  /* ---------------------------------------------------------------------- */

  async publicGet<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>('GET', path, params, {});
  }

  async signedRequest<T>(
    method: HttpMethod,
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.hasCredentials) {
      throw new Error(`签名接口 ${path} 需要 API 凭据`);
    }
    return this.request<T>(method, path, params, { signed: true, retries: this.maxRetries });
  }

  /**
   * A request that carries the API key but is **not** HMAC-signed.
   *
   * The `listenKey` endpoints are security type `USER_STREAM`: they authenticate
   * with the `X-MBX-APIKEY` header alone and take no `timestamp`/`signature`.
   * Sending a signature would be harmless but pointless, and omitting the key
   * yields a 401.
   */
  async keyedRequest<T>(
    method: HttpMethod,
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.apiKey) throw new Error(`Endpoint ${path} requires an API key`);
    return this.request<T>(method, path, params, { retries: this.maxRetries });
  }

  /* ---------------------------------------------------------------------- */
  /*  Core transport                                                         */
  /* ---------------------------------------------------------------------- */

  private async request<T>(
    method: HttpMethod,
    path: string,
    params: Record<string, unknown>,
    options: RequestOptions,
  ): Promise<T> {
    const retries = options.retries ?? 0;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      // Take a concurrency slot *before* the weight gate. Reserving first means
      // the gate is consulted at admission time rather than by every member of a
      // fan-out simultaneously, which is what makes the soft limit real.
      await this.acquireSlot();
      try {
        if (!options.skipWeightGate) await this.respectWeightBudget();
        try {
          return await this.attempt<T>(method, path, params, options.signed === true);
        } catch (error) {
          lastError = error;

          if (error instanceof BinanceApiError) {
            // Clock drift: re-sync and retry immediately — the request itself was fine.
            if (error.isTimestampError && attempt < retries) {
              log.warn(`timestamp rejected by ${path}; re-syncing clock and retrying`);
              this.lastTimeSyncAt = 0;
              await this.syncTime(true);
              continue;
            }

            // Throttled: honour Retry-After when given, else back off hard.
            if (error.isRateLimited && attempt < retries) {
              const waitMs = error.retryAfterSeconds
                ? error.retryAfterSeconds * 1000
                : Math.min(30_000, 2 ** attempt * 1000);
              log.warn(`${path} rate limited (${error.code}); sleeping ${waitMs}ms`);
              await sleep(waitMs);
              continue;
            }

            // Filter/validation/symbol problems are deterministic — retrying wastes weight.
            if (error.isFilterError || error.isSymbolError || error.isInsufficientMargin) {
              throw error;
            }

            if (attempt < retries && (error.httpStatus === 500 || error.httpStatus === 503)) {
              await sleep(2 ** attempt * 500);
              continue;
            }
            throw error;
          }

          // Transport-level failure (DNS, TLS, socket reset, timeout).
          if (attempt < retries) {
            const waitMs = 2 ** attempt * 500;
            log.warn(`${path} transport error (${(error as Error).message}); retrying in ${waitMs}ms`);
            await sleep(waitMs);
            continue;
          }
          throw error;
        }
      } finally {
        // Released even on a retry path, so a retry waits its turn again rather
        // than holding a slot across the backoff sleep.
        this.releaseSlot();
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Request to ${path} failed`);
  }

  /**
   * Block until a request slot is free, then take it.
   *
   * A plain counter plus a waiter queue rather than a semaphore object: the
   * number of waiters is bounded by the fan-out that is already in memory, so
   * there is nothing to clean up.
   */
  private async acquireSlot(): Promise<void> {
    while (this.inFlight >= this.maxInFlight) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    }
    this.inFlight += 1;
  }

  private releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.slotWaiters.shift();
    if (next) next();
  }

  /** Requests in flight right now. Exposed for tests and for the dashboard. */
  get inFlightCount(): number {
    return this.inFlight;
  }

  /** The configured fan-out ceiling, so the dashboard can show `n / max`. */
  get maxInFlightPerRequest(): number {
    return this.maxInFlight;
  }

  private async attempt<T>(
    method: HttpMethod,
    path: string,
    params: Record<string, unknown>,
    signed: boolean,
  ): Promise<T> {
    const search = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      search.append(key, typeof value === 'boolean' ? String(value) : String(value));
    }

    if (signed) {
      search.append('timestamp', String(this.timestamp()));
      search.append('recvWindow', String(this.recvWindow));
      // The signature must cover the exact parameter string that is transmitted,
      // so it is computed from `search` and appended last.
      const signature = createHmac('sha256', this.apiSecret).update(search.toString()).digest('hex');
      search.append('signature', signature);
    }

    const query = search.toString();
    const url = query ? `${this.baseUrl}${path}?${query}` : `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'auto-quant/0.1',
    };
    if (this.apiKey) headers['X-MBX-APIKEY'] = this.apiKey;

    const response = await fetch(url, {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    this.captureWeight(response.headers);

    const text = await response.text();

    if (!response.ok) {
      throw this.toApiError(text, response, path);
    }

    if (!text) return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Binance returned non-JSON payload from ${path}: ${text.slice(0, 200)}`);
    }
  }

  private captureWeight(headers: Headers): void {
    const raw = headers.get('x-mbx-used-weight-1m');
    if (!raw) return;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    /*
     * Re-anchor the window when the server's counter goes *down*, which is the
     * one unambiguous signal that Binance has rolled its minute over. Anchoring
     * on a wall-clock minute instead would be phase-blind: Binance's minute
     * boundary is not ours, and resetting early means burst-sending straight
     * into the limit we are trying to stay away from.
     */
    const now = Date.now();
    if (parsed < this.usedWeight1m || this.weightWindowStart === 0) {
      this.weightWindowStart = now;
    }
    this.usedWeight1m = parsed;
  }

  /**
   * Weight we believe is still charged against the current window.
   *
   * **Why this is not just `usedWeight1m`.** The header is the only thing that
   * ever resets the counter, and several responses legitimately omit it — a 429
   * is the important one, because that is exactly the moment the counter is
   * highest. With no decay the stale high reading survives indefinitely and
   * every subsequent request sleeps `min(remaining, 10s)`, so the trading loop
   * stalls in 10-second steps until some unrelated header-bearing response
   * happens to arrive and clears it. On the *old* code `weightResetAt` was the
   * guard against that; it was overwritten by every header-bearing response,
   * which is the same bug on a longer leash.
   *
   * Decay instead: charge the last observed figure only for the part of the
   * window that has not elapsed yet. That is an *over*-estimate, never an
   * under-estimate, so it stays conservative in the safe direction — the exact
   * accounting is the server's job, ours is only to not trip it.
   */
  private decayedWeight(now: number): number {
    return decayWeight(this.usedWeight1m, this.weightWindowStart, now);
  }

  /** Proactively slow down before Binance starts rejecting us. */
  private async respectWeightBudget(): Promise<void> {
    const now = Date.now();
    const charged = this.decayedWeight(now);
    if (charged <= 0) {
      if (this.usedWeight1m > 0) {
        // The window rolled over, so the previous reading is no longer charged.
        this.usedWeight1m = 0;
      }
      return;
    }

    this.usedWeight1m = charged;
    if (charged < this.weightLimitPerMinute * WEIGHT_SOFT_LIMIT) return;

    const remaining = Math.max(0, this.weightWindowStart + 60_000 - now);
    const waitMs = Math.min(remaining, 10_000);
    log.warn(
      `weight budget ~${Math.round(charged)}/${this.weightLimitPerMinute} consumed; pausing ${waitMs}ms`,
    );
    if (waitMs > 0) await sleep(waitMs);
  }

  private toApiError(text: string, response: Response, path: string): BinanceApiError {
    let code = response.status;
    let message = response.statusText || 'request failed';

    try {
      const body = JSON.parse(text) as BinanceErrorBody;
      if (typeof body.code === 'number') code = body.code;
      if (typeof body.msg === 'string') message = body.msg;
    } catch {
      if (text) message = text.slice(0, 300);
    }

    const retryAfter = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : null;

    return new BinanceApiError(
      code,
      message,
      response.status,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
      path,
    );
  }
}
