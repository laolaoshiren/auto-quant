/**
 * **基础安全响应头** —— 结构守卫（审计 2026-11-10）。
 *
 * ## 为什么这个测试存在
 *
 * 这个控制台能下单、平仓、删凭据。也就是说一次 **点击劫持（clickjacking）**
 * 就能让操作员在不知情的情况下点掉一个仓位或者删掉一个账户 —— 而在此之前，
 * 所有响应都没有任何安全头，浏览器允许任何站点把控制台放进 iframe。
 *
 * 三个头都是零功能影响的：
 *
 * ```
 *   X-Frame-Options: SAMEORIGIN   防跨站 iframe（点击劫持的载体）
 *   X-Content-Type-Options: nosniff 防 MIME 嗅探（JSON 被当脚本执行）
 *   Referrer-Policy: no-referrer    URL 不外泄给第三方
 * ```
 *
 * ## 边界（诚实说明）
 *
 * · 这里**没有** CSP —— 那需要真实浏览器逐页验证构建产物里有没有 inline
 *   script/style，凭空加会让控制台白屏。它留在审计报告里；
 * · 测试只断言"头存在且值正确"，不验证浏览器侧的实际效果。
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';

import type { ExchangeConnection } from '../binance/bootstrap.js';
import { Vault } from '../crypto/vault.js';
import { closeDb, initDb } from '../db/index.js';
import type { BalanceService } from '../services/balance.js';
import type { TraderManager } from '../trader/manager.js';
import { buildServer, type ApiDependencies } from './server.js';

let workDir: string;
let app: FastifyInstance;

function stubDependencies(): ApiDependencies {
  return {
    vault: new Vault(randomBytes(32)),
    manager: { runningSince: () => new Map<number, number>() } as unknown as TraderManager,
    jwtSecret: 'security-headers-test-secret-0123456789',
    publicConnection: { environment: 'demo' } as unknown as ExchangeConnection,
    balance: {} as unknown as BalanceService,
  };
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-security-headers-'));
  initDb(path.join(workDir, 'test.sqlite'));
  app = await buildServer(stubDependencies());
  await app.ready();
});

after(async () => {
  await app.close();
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

function assertSecurityHeaders(headers: OutgoingHttpHeaders, where: string): void {
  assert.equal(headers['x-content-type-options'], 'nosniff', `${where}: 缺 nosniff`);
  assert.equal(headers['x-frame-options'], 'SAMEORIGIN', `${where}: 缺 X-Frame-Options`);
  assert.equal(headers['referrer-policy'], 'no-referrer', `${where}: 缺 Referrer-Policy`);
}

test('★ 成功响应带安全头（未认证的 health 也必须带）', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assertSecurityHeaders(response.headers, '/api/health');
});

test('★ 认证失败响应也带安全头（401 页面同样不该能被 iframe 套住）', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
  assert.equal(response.statusCode, 401);
  assertSecurityHeaders(response.headers, '401');
});

test('★ 不存在的 API 路径（404）也带安全头', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
  assert.equal(response.statusCode, 404);
  assertSecurityHeaders(response.headers, '404');
});
