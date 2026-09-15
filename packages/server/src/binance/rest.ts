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

/**
 * Low-level Binance USDⓈ-M Futures REST transport.
 *
 * Responsibilities kept here, and only here:
 *  - HMAC-SHA256 request signing with a live server-time offset
 *  - automatic recovery from `-1021` (timestamp drift) and 429/418 (throttling)
 *  - request-weight accounting from the `X-MBX-USED-WEIGHT-1M` header
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
  private weightResetAt = 0;

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
    }

    throw lastError instanceof Error ? lastError : new Error(`Request to ${path} failed`);
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
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) {
        this.usedWeight1m = parsed;
        this.weightResetAt = Date.now() + 60_000;
      }
    }
  }

  /** Proactively slow down before Binance starts rejecting us. */
  private async respectWeightBudget(): Promise<void> {
    if (this.usedWeight1m >= this.weightLimitPerMinute * WEIGHT_SOFT_LIMIT) {
      const remaining = this.weightResetAt - Date.now();
      if (remaining > 0) {
        log.warn(
          `weight budget ${this.usedWeight1m}/${this.weightLimitPerMinute} consumed; pausing ${remaining}ms`,
        );
        await sleep(Math.min(remaining, 10_000));
      } else {
        this.usedWeight1m = 0;
      }
    }
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
