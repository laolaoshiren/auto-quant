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
  /** Expiry, seconds since epoch. */
  exp: number;
  iat: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signToken(
  payload: Omit<TokenPayload, 'exp' | 'iat'>,
  secret: string,
  ttlSeconds = 7 * 24 * 3600,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, iat, exp: iat + ttlSeconds } satisfies TokenPayload));
  const signature = sign(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
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

export function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
  // The WebSocket upgrade cannot set headers from a browser, so a query token
  // is accepted for that one transport.
  const query = request.query as { token?: string } | undefined;
  if (query?.token) return query.token;
  return null;
}

/**
 * Build a Fastify `preHandler` that rejects unauthenticated requests.
 *
 * `/api/health` and the auth endpoints are registered outside this guard so a
 * monitoring probe can always reach the process.
 */
export function requireAuth(secret: string) {
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
