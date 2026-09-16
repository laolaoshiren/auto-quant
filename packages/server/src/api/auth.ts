import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '../logger.js';

const log = createLogger('auth');

/* -------------------------------------------------------------------------- */
/*  Minimal HS256 JWT                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A dependency-free HS256 JWT.
 *
 * The format is small and fully specified (RFC 7519), and hand-rolling it keeps
 * the dependency surface of a program that holds exchange credentials as small
 * as possible.
 */

export interface TokenPayload {
  sub: number;
  username: string;
  role: 'owner' | 'user';
  /**
   * 签发这张令牌时，该账户的「凭据变更时间戳」。
   *
   * 0 表示签发时账户从未改过凭据。校验时与数据库里的当前值**按等值比较**，
   * 不等即视为已撤销 —— 见 `isTokenRevoked()` 里对"为什么不是比大小"的说明。
   */
  credAt: number;
  /** Expiry, seconds since epoch. */
  exp: number;
  iat: number;
}

/**
 * 会话有效期。
 *
 * 原先写死 7 天，对一台「登进去就能下真实订单」的控制台来说太长了：
 * 令牌一旦泄漏（浏览器残留、代理日志、备份），攻击者有一个完整工作周的时间窗口。
 * 这里改成 12 小时 —— 覆盖一整天的交易时段，操作员不需要中途重新登录，
 * 而泄漏的令牌最多活半天。配合 `credAt` 撤销（改密码即作废全部旧令牌），
 * 长尾风险由「可撤销」兜住，而不是靠 TTL 兜。
 */
export const TOKEN_TTL_SECONDS = 12 * 3600;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signToken(
  payload: Omit<TokenPayload, 'exp' | 'iat'>,
  secret: string,
  ttlSeconds = TOKEN_TTL_SECONDS,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, iat, exp: iat + ttlSeconds } satisfies TokenPayload));
  const signature = sign(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

/**
 * 这张令牌是否已被「凭据变更」作废。
 *
 * 本项目的 JWT 原本**不可撤销**：改完密码，旧令牌在其 7 天有效期内依然能用。
 * 于是「改密码」这个唯一的补救动作在最需要它的时候（令牌泄漏、设备丢失）是无效的。
 *
 * 判据是**等值**而不是「iat 早于变更时间」：时间戳只到秒，
 * 而改密码与重新签发令牌发生在同一秒内，用大小比较会让刚刚签发的令牌
 * 立刻自判过期（或者反过来，给旧令牌留出一秒的宽限窗口）。
 * 签发时把当时的时间戳写进令牌，变更时数据库里的值就变了，
 * 于是所有更早的令牌立刻失配 —— 精确、无窗口、不依赖时钟粒度。
 */
export function isTokenRevoked(
  payload: TokenPayload,
  credentialsChangedAtMs: number | null,
): boolean {
  return (payload.credAt ?? 0) !== (credentialsChangedAtMs ?? 0);
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];

  const expected = sign(`${header}.${body}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Request authentication                                                     */
/* -------------------------------------------------------------------------- */

export interface AuthedRequest extends FastifyRequest {
  user?: TokenPayload;
}

/**
 * 取请求里的会话令牌。
 *
 * 查询参数里的令牌**默认不接受**，只有 WebSocket 升级那一条路径显式打开。
 * 原因：URL 会进入反向代理的 access log、浏览器历史、以及外链的 `Referer` 头，
 * 而本项目的部署文档就是让人把控制台放在反向代理后面 —— 也就是说
 * 一个 `?token=` 会让长期有效的会话凭据落在最多人能看到的地方。
 * 之前所有路由都接受它，等于把「一个 HTTP 客户端的小方便」换成了凭据泄漏面。
 */
export function extractToken(
  request: FastifyRequest,
  options: { allowQueryToken?: boolean } = {},
): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
  // 浏览器的 WebSocket 构造函数无法设置请求头，因此只有这条传输通道需要兜底。
  if (options.allowQueryToken) {
    const query = request.query as { token?: string } | undefined;
    if (query?.token) return query.token;
  }
  return null;
}

/**
 * Build a Fastify `preHandler` that rejects unauthenticated requests.
 *
 * `/api/health` and the auth endpoints are registered outside this guard so a
 * monitoring probe can always reach the process.
 *
 * `isRevoked` 是可选的口子，用来在不把存储层拖进这个模块的前提下做**撤销**校验
 * （auth.ts 只做令牌本身的事，不碰数据库）。调用方传入的判定为真时，
 * 令牌签名有效但已被凭据变更作废 —— 必须按未认证处理。
 */
export function requireAuth(secret: string, isRevoked?: (payload: TokenPayload) => boolean) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = extractToken(request);
    if (!token) {
      await reply.code(401).send({ error: '需要登录' });
      return;
    }
    const payload = verifyToken(token, secret);
    if (!payload) {
      await reply.code(401).send({ error: '登录状态已过期或无效' });
      return;
    }
    if (isRevoked?.(payload)) {
      await reply.code(401).send({ error: '登录状态已失效（账户凭据已变更），请重新登录' });
      return;
    }
    (request as AuthedRequest).user = payload;
  };
}

/** Generate a readable, high-entropy password for the first-run account. */
export function generatePassword(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * Generate a username for the first-run account.
 *
 * 不以固定的 `admin` 作为默认用户名：那样等于把「用户名已知」这一半信息白送给攻击者，
 * 剩下的安全性全压在一个密码上。加随机后缀不增加使用负担（用户登录后可以改），
 * 但让暴力尝试必须先猜对用户名。
 *
 * 用十六进制而不是 base64：用户名要能手输，`0/O`、`l/1` 这类歧义字符越少越好。
 */
export function generateUsername(): string {
  return `admin_${randomBytes(3).toString('hex')}`;
}

export { log as authLogger };
