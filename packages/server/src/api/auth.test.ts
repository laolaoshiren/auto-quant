/**
 * 会话令牌的回归测试：有效期、撤销判定、以及"查询参数里的令牌"的适用范围。
 *
 * 三个测试分别对应一个真实缺陷：
 *
 * 1. 令牌原本是 **7 天不可撤销**的。改密码在最需要它的时候（令牌泄漏）
 *    救不了任何东西 —— 旧令牌在剩下的有效期内照样能下单。
 * 2. `extractToken()` 原本在**所有**路由上接受 `?token=`。
 *    URL 会进反向代理日志、浏览器历史和 `Referer`，等于把长期凭据抄送到多个地方。
 * 3. 用户名不存在时登录不做口令派生，401 早几十毫秒返回 —— 那是一个
 *    **用户名枚举预言机**，而随机用户名（`generateUsername()`）的全部价值
 *    就是让攻击者必须先猜对用户名。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';

import {
  TOKEN_TTL_SECONDS,
  extractToken,
  isTokenRevoked,
  signToken,
  verifyToken,
  type TokenPayload,
} from './auth.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../crypto/vault.js';

const SECRET = 'test-secret-not-a-real-key';

function mint(overrides: Partial<Omit<TokenPayload, 'exp' | 'iat'>> = {}): string {
  return signToken({ sub: 1, username: 'admin_abc123', role: 'owner', credAt: 0, ...overrides }, SECRET);
}

/** 把 JWT 的载荷解出来，用于断言有效期这类只能从载荷上看到的性质。 */
function payloadOf(token: string): TokenPayload {
  const body = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
}

/* -------------------------------------------------------------------------- */
/*  签发与校验                                                                 */
/* -------------------------------------------------------------------------- */

test('签发的令牌可以通过校验，并且带回凭据时间戳', () => {
  const payload = verifyToken(mint({ credAt: 1_700_000_000_000 }), SECRET);
  assert.ok(payload);
  assert.equal(payload.sub, 1);
  assert.equal(payload.username, 'admin_abc123');
  assert.equal(payload.credAt, 1_700_000_000_000);
});

test('默认有效期是 12 小时 —— 不是原来的 7 天', () => {
  const token = mint();
  const payload = payloadOf(token);
  assert.equal(payload.exp - payload.iat, TOKEN_TTL_SECONDS);
  assert.equal(TOKEN_TTL_SECONDS, 12 * 3600);
});

test('过期令牌被拒绝', () => {
  // 直接签一张一秒就过期的，避免测试里真的等
  const expired = signToken({ sub: 1, username: 'u', role: 'owner', credAt: 0 }, SECRET, -10);
  assert.equal(verifyToken(expired, SECRET), null);
});

test('签名被篡改的令牌被拒绝', () => {
  const [header, body] = mint().split('.');
  const forged = `${header}.${body}.${'A'.repeat(43)}`;
  assert.equal(verifyToken(forged, SECRET), null);
  // 换密钥同样不通过
  assert.equal(verifyToken(mint(), 'another-secret'), null);
});

/* -------------------------------------------------------------------------- */
/*  撤销                                                                       */
/* -------------------------------------------------------------------------- */

test('从未改过凭据的账户：令牌不会被撤销', () => {
  const payload = payloadOf(mint({ credAt: 0 }));
  assert.equal(isTokenRevoked(payload, null), false);
});

test('凭据变更后，变更之前签发的令牌全部作废', () => {
  // credAt 为 0 就是"签发时账户还没改过凭据"——改过之后它再也对不上
  const oldToken = payloadOf(mint({ credAt: 0 }));
  assert.equal(isTokenRevoked(oldToken, 1_700_000_000_000), true);
});

test('凭据变更后重新签发的令牌继续有效', () => {
  const changedAt = 1_700_000_000_000;
  const fresh = payloadOf(mint({ credAt: changedAt }));
  assert.equal(isTokenRevoked(fresh, changedAt), false);

  // 再来一次变更：这一张也应当立刻作废
  assert.equal(isTokenRevoked(fresh, changedAt + 1), true);
});

test('判定是等值比较，不受时钟粒度影响', () => {
  // 用 iat 比大小时，改密码与重新签发发生在同一秒内，
  // 新令牌会带着与变更时间相同的秒数 —— 大于/小于都会错（要么新令牌自杀，
  // 要么旧令牌白得一秒宽限）。等值比较没有这个问题。
  const changedAt = 1_700_000_000_500;
  const signedInSameSecond = payloadOf(mint({ credAt: changedAt }));
  assert.equal(isTokenRevoked(signedInSameSecond, changedAt), false);
});

/* -------------------------------------------------------------------------- */
/*  令牌来源                                                                   */
/* -------------------------------------------------------------------------- */

function requestWith(headers: Record<string, string>, query: Record<string, string> = {}): FastifyRequest {
  return { headers, query } as unknown as FastifyRequest;
}

test('Authorization 头始终被接受', () => {
  const request = requestWith({ authorization: 'Bearer header-token' });
  assert.equal(extractToken(request), 'header-token');
});

test('查询参数里的令牌默认被忽略（HTTP 路由不接受 ?token=）', () => {
  // 这是本次修复的核心：URL 会落进代理日志、浏览器历史与 Referer，
  // 之前所有路由都接受它，等于给凭据泄漏开了一条静默通道。
  const request = requestWith({}, { token: 'leaked-token' });
  assert.equal(extractToken(request), null);
});

test('只有 WebSocket 升级路径显式打开查询参数令牌', () => {
  const request = requestWith({}, { token: 'events-token' });
  assert.equal(extractToken(request, { allowQueryToken: true }), 'events-token');
});

/* -------------------------------------------------------------------------- */
/*  时间侧信道                                                                 */
/* -------------------------------------------------------------------------- */

test('时间均衡用的假哈希与真实哈希参数完全一致', () => {
  // 这个断言是"用户名枚举时间侧信道"能被防住的前提：
  // 两条分支必须跑**同样参数**的 scrypt，否则 CPU 成本不同，时间差又回来了。
  const real = hashPassword('whatever').split('$');
  const dummy = DUMMY_PASSWORD_HASH.split('$');

  assert.equal(real[0], 'scrypt');
  assert.deepEqual(dummy.slice(0, 4), real.slice(0, 4));
  assert.equal(dummy[4]!.length, real[4]!.length, '盐长度必须一致');
  assert.equal(dummy[5]!.length, real[5]!.length, '摘要长度必须一致');
});

test('假哈希永远不会通过校验', () => {
  for (const candidate of ['', 'password', 'admin', '0'.repeat(64)]) {
    assert.equal(verifyPassword(candidate, DUMMY_PASSWORD_HASH), false);
  }
});

test('非字符串口令返回 false 而不是抛异常', () => {
  // 曾经：PATCH /api/auth/account 传一个数字 currentPassword 会让 scryptSync
  // 抛 TypeError，变成一条 HTTP 500。没有绕过风险，但不该是 500。
  assert.equal(verifyPassword(123 as unknown as string, hashPassword('x')), false);
});
