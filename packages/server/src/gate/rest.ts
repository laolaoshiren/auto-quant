/**
 * Gate.io API v4 的 HTTP 客户端（USDT 本位永续）。
 *
 * ## 职责边界（与 `binance/rest.ts` 同一条纪律）
 *
 * 这一层只做四件事：**签名、发请求、错误映射、并发限制**。
 * 上层（`account.ts` / `orders.ts`）只拿领域对象，永远看不到签名。
 *
 * ## Gate 的签名形式（与币安完全不同，容易写错）
 *
 * ```
 *   签名字符串 = METHOD + "\n"
 *              + URL    + "\n"     ← 是 path（含 /api/v4），不含协议与域名
 *              + QUERY  + "\n"     ← 参数字符串（无参数时为空串）
 *              + HexEncode(SHA512(requestBody)) + "\n"   ← 无 body 时是空串的 SHA512
 *              + Timestamp                       ← **秒级**
 *   签名 = HexEncode(HMAC_SHA512(secret, 签名字符串))
 * ```
 *
 * 请求头：`KEY`、`Timestamp`、`SIGN`。时间戳超过约 60 秒就会被拒
 * （`INVALID_HEADER_VALUE` / `REQUEST_EXPIRED`），所以这里每次请求都取当前时间，
 * 不做缓存 —— 跟币安那种"同步一次服务器时间再用偏移"的策略不同（Gate 是
 * 请求级时间戳，同步一次的收益很小）。
 */
import { createHash, createHmac } from 'node:crypto';
import { createLogger } from '../logger.js';
import { resolveGateEndpoints, type GateEnvironment } from './endpoints.js';
import { GateApiError, type GateErrorBody } from './types.js';

const log = createLogger('gate:rest');

/** 单次请求超时。与币安那层一致（交易所列表接口通常 < 1 秒）。 */
export const GATE_TIMEOUT_MS = 15_000;

/** 同时在途的请求上限（Gate 对私有接口有限频；并发太高会撞 `TOO_MANY_REQUESTS`）。 */
export const GATE_MAX_IN_FLIGHT = 6;

/**
 * 空字符串的 SHA512 hex。
 *
 * Gate 文档把它当常量给出来；这里**自己算**而不是抄常量 —— 抄错一位的话
 * 所有无 body 的 GET 请求都会签名失败，而错误信息只会说"签名不匹配"，
 * 排查方向会被带偏。
 */
export const EMPTY_BODY_SHA512 = createHash('sha512').update('').digest('hex');

export type GateHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface GateRestOptions {
  apiKey: string;
  apiSecret: string;
  environment?: GateEnvironment | string | null;
  /** 测试注入用。默认全局 `fetch`。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 已排序并编码好的查询串（签名与请求 URL 用同一份，避免两处不一致）。 */
export function buildQueryString(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const parts: string[] = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/**
 * 计算 Gate API v4 的签名字符串（不含 HMAC）。
 *
 * 单独导出来是为了**能直接测**：签名串拼错时，HMAC 结果一定是错的，
 * 但"错在哪一段"只有把中间值拿出来才看得见。
 */
export function gateSignString(input: {
  method: GateHttpMethod;
  /** 含 `/api/v4` 前缀的 path，例如 `/api/v4/futures/usdt/accounts`。 */
  url: string;
  query: string;
  /** 原始请求体文本（无 body 时传空串）。 */
  body: string;
  /** **秒级**时间戳。 */
  timestamp: number;
}): string {
  const bodyHash = input.body === '' ? EMPTY_BODY_SHA512 : createHash('sha512').update(input.body).digest('hex');
  return [input.method.toUpperCase(), input.url, input.query, bodyHash, String(input.timestamp)].join('\n');
}

/** 对签名字符串做 HMAC-SHA512，返回 hex。 */
export function gateSignature(input: {
  method: GateHttpMethod;
  url: string;
  query: string;
  body: string;
  timestamp: number;
  secret: string;
}): string {
  return createHmac('sha512', input.secret).update(gateSignString(input)).digest('hex');
}

/** 一个极简的并发闸门：超过上限就排队。 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export class GateRest {
  readonly endpoints = resolveGateEndpoints(undefined);
  private readonly baseUrl: string;
  /** 签名用的 API 前缀（`/api/v4`）——从 base URL 的 path 里取，不硬编码。 */
  private readonly apiPrefix: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly gate = new Semaphore(GATE_MAX_IN_FLIGHT);

  constructor(options: GateRestOptions) {
    const endpoints = resolveGateEndpoints(options.environment);
    this.endpoints = endpoints;
    this.baseUrl = endpoints.rest.replace(/\/+$/, '');
    this.apiPrefix = new URL(this.baseUrl).pathname.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? GATE_TIMEOUT_MS;
  }

  /** 公开接口（行情/合约信息），不需要签名。 */
  async publicGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>('GET', path, { params });
  }

  /**
   * 私有接口（账户/持仓/订单）。
   *
   * 默认签名；`signed: false` 只留给真正的公开端点（账号相关永远不会用它）。
   */
  async signed<T>(
    method: GateHttpMethod,
    path: string,
    options: { params?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    return this.request<T>(method, path, { ...options, signed: true });
  }

  private async request<T>(
    method: GateHttpMethod,
    path: string,
    options: { params?: Record<string, unknown>; body?: unknown; signed?: boolean },
  ): Promise<T> {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const query = buildQueryString(options.params);
    const bodyText = options.body === undefined ? '' : JSON.stringify(options.body);
    const url = `${this.baseUrl}${normalized}${query ? `?${query}` : ''}`;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (bodyText !== '') headers['Content-Type'] = 'application/json';
    if (options.signed) {
      const timestamp = Math.floor(Date.now() / 1000);
      headers.KEY = this.apiKey;
      headers.Timestamp = String(timestamp);
      headers.SIGN = gateSignature({
        method,
        url: `${this.apiPrefix}${normalized}`,
        query,
        body: bodyText,
        timestamp,
        secret: this.apiSecret,
      });
    }

    return this.gate.run(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: bodyText === '' ? undefined : bodyText,
          signal: controller.signal,
        });
        const text = await response.text();
        let parsed: unknown = null;
        if (text.trim() !== '') {
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            /* 非 JSON 响应按原始文本处理（网关 502 时就是 HTML）。 */
          }
        }
        if (!response.ok) {
          const error = (parsed ?? {}) as GateErrorBody;
          const detail = error.detail ?? error.message ?? text.slice(0, 200);
          const label = error.label ?? '';
          throw new GateApiError(
            `Gate API ${method} ${normalized} 失败（HTTP ${response.status}${label ? ` · ${label}` : ''}）：${detail}`,
            response.status,
            label,
          );
        }
        return parsed as T;
      } catch (error) {
        if (error instanceof GateApiError) throw error;
        const message = (error as Error).name === 'AbortError'
          ? `Gate API ${method} ${normalized} 超时（${this.timeoutMs}ms）`
          : `Gate API ${method} ${normalized} 请求失败：${(error as Error).message}`;
        log.warn(message);
        throw new GateApiError(message, 0);
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
