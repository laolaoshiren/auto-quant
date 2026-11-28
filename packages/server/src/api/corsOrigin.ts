/**
 * CORS Origin 白名单判定（AQ-2022）。
 *
 * 设计目标：
 * 1. 默认拒绝任意第三方站点带凭证跨域访问控制台 API（替代原来的 `origin: true`）；
 * 2. 同源请求（无 `Origin` 头，或 `Origin` 的 host 与当前请求 `Host`/`X-Forwarded-Host` 一致）始终放行，
 *    使线上反代部署在零配置下正常可用；
 * 3. 本地开发回环地址（`localhost` / `127.0.0.1` / `[::1]`）始终放行，避免影响 Vite 开发联调；
 * 4. 额外的跨站前端域名可通过 `CORS_ALLOWED_ORIGINS`（逗号或空白分隔）显式声明。
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function parseCorsAllowedOrigins(raw: string | undefined): Set<string> {
  const allowed = new Set<string>();
  if (!raw) return allowed;
  for (const part of raw.split(/[\s,]+/)) {
    const normalized = normalizeOrigin(part);
    if (normalized) allowed.add(normalized);
  }
  return allowed;
}

export interface CorsCheckContext {
  /** 当前请求的 Host（已兼容反向代理的 X-Forwarded-Host），例如 `console.example.com` 或 `127.0.0.1:27137`。 */
  requestHost?: string | null;
  /** 由 `CORS_ALLOWED_ORIGINS` 解析出的显式白名单。 */
  extraAllowedOrigins?: ReadonlySet<string>;
}

export function isCorsOriginAllowed(
  origin: string | undefined,
  ctx: CorsCheckContext = {},
): boolean {
  // 非浏览器请求或浏览器同源导航（无 Origin 头）直接放行
  if (!origin) return true;

  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;

  if (ctx.extraAllowedOrigins) {
    if (ctx.extraAllowedOrigins.has('*') || ctx.extraAllowedOrigins.has(normalized)) {
      return true;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }

  // 本地开发回环地址放行（支持任意本地开发端口，如 Vite 5173 / API 27137 / 开发实例 3200）
  if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return true;
  }

  // 同源请求放行（现代浏览器在同源 POST/PUT/DELETE 时会附带 Origin）
  const reqHost = ctx.requestHost?.trim().toLowerCase();
  if (reqHost && parsed.host.toLowerCase() === reqHost) {
    return true;
  }

  return false;
}
