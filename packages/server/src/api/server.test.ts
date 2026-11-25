/**
 * API / 安全 / 运行时协调审计修复的端到端回归测试。
 *
 * 覆盖：
 *  1. P1 #5: resetAdminPassword.ts 重置密码后必须调用 users.markCredentialsChanged()；
 *  2. P1 #6: DELETE /api/exchange-accounts/:id 必须检查 manager.isRunning(t.id)（即使 DB 状态是 error/safe_mode）；
 *  3. P1 #7: PATCH /api/strategies/:id 修改 config 时必须向运行中的 strategy 模式机器人推送 applyLiveUpdate；
 *  4. P1 #18: GET /api/traders 的 ledger 载荷必须透传 incomeReadFailed；
 *  5. P2 安全：
 *     - 新安装账户（credentialsChangedAt === null）正常通过鉴权，但被删除账户的旧 JWT 在 HTTP 与 WS 均被拒绝；
 *     - 修改密码/用户名时立即断开该用户已连接的 /api/events WebSocket（1008）；
 *     - /api/events 限制单帧 maxPayload <= 64 KiB（超限断开 1009）；
 *     - 未捕获 500 错误不向客户端泄露内部异常原文。
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { defaultStrategyConfig } from '@aq/shared';

import type { ExchangeConnection } from '../binance/bootstrap.js';
import { Vault, hashPassword } from '../crypto/vault.js';
import { closeDb, getDb, initDb } from '../db/index.js';
import type { BalanceService } from '../services/balance.js';
import { aiModels, exchanges, settings, strategies, traders, users } from '../store/repositories.js';
import type { TraderManager } from '../trader/manager.js';
import { signToken } from './auth.js';
import { buildServer, type ApiDependencies } from './server.js';

const OWNER = 'admin_server_audit';
const PASSWORD = 'server-audit-password-42';
const NEW_PASSWORD = 'server-audit-password-99';
const JWT_SECRET = 'server-audit-test-secret-not-real';

let workDir: string;
let app: FastifyInstance;
let token = '';
let userId = 0;
let wsBaseUrl = '';

let runningSet = new Set<number>();
let startingSet = new Set<number>();
let throwOnRunningIds = false;
let liveUpdates: Array<{ traderId: number; patch: Record<string, unknown> }> = [];

function stubDependencies(): ApiDependencies {
  return {
    vault: new Vault(randomBytes(32)),
    manager: {
      runningSince: () => new Map<number, number>(),
      runningIds: () => {
        if (throwOnRunningIds) {
          throw new Error('INTERNAL_SQLITE_SECRET_LEAK_TOKEN');
        }
        return [...runningSet];
      },
      statusOf: (id: number) => (runningSet.has(id) ? 'running' : 'stopped'),
      nextCycleAtOf: () => null,
      isRunning: (id: number) => runningSet.has(id),
      isStarting: (id: number) => startingSet.has(id),
      invalidateConnectionsForAccount: () => 0,
      applyLiveUpdate: (traderId: number, patch: Record<string, unknown>) => {
        liveUpdates.push({ traderId, patch });
        return runningSet.has(traderId);
      },
    } as unknown as TraderManager,
    jwtSecret: JWT_SECRET,
    publicConnection: { environment: 'demo' } as unknown as ExchangeConnection,
    balance: {
      invalidate: () => undefined,
      invalidateAll: () => undefined,
      getAll: async () => new Map(),
      get: async () => ({ ok: false as const, error: 'stub' }),
      walletBalanceOf: async () => null,
    } as unknown as BalanceService,
  };
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-server-audit-'));
  initDb(path.join(workDir, 'test.sqlite'));
  app = await buildServer(stubDependencies());
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const port = new URL(address).port;
  wsBaseUrl = `ws://127.0.0.1:${port}/api/events`;
});

after(async () => {
  await app.close();
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const db = getDb();
  db.exec(
    'DELETE FROM settings; DELETE FROM positions; DELETE FROM orders; DELETE FROM trades;' +
      ' DELETE FROM traders; DELETE FROM strategies; DELETE FROM ai_models; DELETE FROM exchange_accounts; DELETE FROM users;',
  );
  runningSet = new Set();
  startingSet = new Set();
  throwOnRunningIds = false;
  liveUpdates = [];

  const created = users.create(OWNER, hashPassword(PASSWORD), 'owner');
  userId = created.id;
  token = signToken(
    { sub: created.id, username: created.username, role: 'owner', credAt: 0 },
    JWT_SECRET,
  );
});

const auth = (t = token) => ({ authorization: `Bearer ${t}` });

function seedModel(): number {
  return aiModels.create({
    provider: 'deepseek',
    label: 'm',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 1024,
    timeoutSeconds: 30,
    maxRetries: 0,
  }).id;
}

function seedAccount(): number {
  return exchanges.create({
    exchange: 'binance',
    label: 'sub-account',
    apiKey: 'test-api-key-long-enough',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  }).id;
}

test('P1 #5: resetAdminPassword.ts 重置密码后调用 markCredentialsChanged 撤销旧 JWT', () => {
  const src = readFileSync(new URL('../scripts/resetAdminPassword.ts', import.meta.url), 'utf8');
  const updateAt = src.indexOf('users.updatePassword(owner.id');
  const markAt = src.indexOf('users.markCredentialsChanged(owner.id)');
  assert.ok(updateAt > 0, '应存在 users.updatePassword');
  assert.ok(markAt > updateAt, 'resetAdminPassword 必须在更新密码后调用 users.markCredentialsChanged(owner.id)');
});

test('P1 #6: DELETE /api/exchange-accounts/:id 挡住 DB 为 error/safe_mode 但内存仍在运行的机器人', async () => {
  const accountId = seedAccount();
  const modelId = seedModel();
  const strat = strategies.create({
    name: 's',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  const trader = traders.create({
    name: 'bot-error-running',
    exchangeAccountId: accountId,
    aiModelId: modelId,
    strategyId: strat.id,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
    mode: 'strategy',
    dryRun: false,
  });

  // DB 状态为 error（usageCount 只数 status='running' → 0），但内存中仍在运行
  traders.setStatus(trader.id, 'error', 'transient error');
  runningSet.add(trader.id);

  const res = await app.inject({
    method: 'DELETE',
    url: `/api/exchange-accounts/${accountId}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 409, res.payload);
  assert.ok(exchanges.get(accountId), '凭据绝不能被删除');
  assert.equal(traders.get(trader.id)?.exchangeAccountId, accountId, '运行中机器人绝不能被解绑');

  // safe_mode 同理
  traders.setStatus(trader.id, 'safe_mode');
  const resSafe = await app.inject({
    method: 'DELETE',
    url: `/api/exchange-accounts/${accountId}`,
    headers: auth(),
  });
  assert.equal(resSafe.statusCode, 409, resSafe.payload);
  assert.ok(exchanges.get(accountId));
});

test('P1 #7: PATCH /api/strategies/:id 同步新配置到运行中的 strategy 模式机器人', async () => {
  const modelId = seedModel();
  const strat = strategies.create({
    name: '趋势策略',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  const otherStrat = strategies.create({
    name: '其他策略',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });

  const runningStrategyBot = traders.create({
    name: 'running-strategy',
    exchangeAccountId: null,
    aiModelId: modelId,
    strategyId: strat.id,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
    mode: 'strategy',
    dryRun: true,
  });
  const stoppedStrategyBot = traders.create({
    name: 'stopped-strategy',
    exchangeAccountId: null,
    aiModelId: modelId,
    strategyId: strat.id,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
    mode: 'strategy',
    dryRun: true,
  });
  const runningOtherStrategyBot = traders.create({
    name: 'running-other',
    exchangeAccountId: null,
    aiModelId: modelId,
    strategyId: otherStrat.id,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
    mode: 'strategy',
    dryRun: true,
  });
  const runningManagedBot = traders.create({
    name: 'running-managed',
    exchangeAccountId: null,
    aiModelId: modelId,
    strategyId: null,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
    mode: 'ai_managed',
    dryRun: true,
  });

  runningSet.add(runningStrategyBot.id);
  runningSet.add(runningOtherStrategyBot.id);
  runningSet.add(runningManagedBot.id);

  const nextCfg = defaultStrategyConfig();
  nextCfg.riskControl.maxPositions = 2;

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/strategies/${strat.id}`,
    headers: auth(),
    payload: { config: nextCfg },
  });
  assert.equal(res.statusCode, 200, res.payload);

  assert.equal(liveUpdates.length, 1, '仅应推送给绑定该策略且运行中的 strategy 模式机器人');
  assert.equal(liveUpdates[0]!.traderId, runningStrategyBot.id);
  const pushedCfg = liveUpdates[0]!.patch.config as { riskControl: { maxPositions: number } };
  assert.equal(pushedCfg.riskControl.maxPositions, 2);
  assert.ok(!liveUpdates.some((u) => u.traderId === stoppedStrategyBot.id));
  assert.ok(!liveUpdates.some((u) => u.traderId === runningOtherStrategyBot.id));
  assert.ok(!liveUpdates.some((u) => u.traderId === runningManagedBot.id));
});

test('P1 #18: GET /api/traders 透传 ledger.incomeReadFailed，避免前端误把盈亏校准成 0', async () => {
  const modelId = seedModel();
  const trader = traders.create({
    name: 'ledger-bot',
    exchangeAccountId: null,
    aiModelId: modelId,
    strategyId: null,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
    mode: 'ai_managed',
    dryRun: true,
  });

  settings.set(
    `ledger_check:${trader.id}`,
    JSON.stringify({
      platformNet: 12.34,
      exchangeNet: 0,
      gap: 12.34,
      checkedAt: '2026-11-25T00:00:00.000Z',
      incomeReadFailed: true,
    }),
  );

  const res = await app.inject({ method: 'GET', url: '/api/traders', headers: auth() });
  assert.equal(res.statusCode, 200, res.payload);
  const rows = res.json() as Array<{
    id: number;
    ledger?: { platformNet: number; exchangeNet: number; gap: number; checkedAt: string; incomeReadFailed?: boolean } | null;
  }>;
  const row = rows.find((r) => r.id === trader.id);
  assert.ok(row?.ledger);
  assert.equal(row.ledger.incomeReadFailed, true);
  assert.equal(row.ledger.platformNet, 12.34);
});

test('P2 安全: 新安装账户(credentialsChangedAt=null)正常放行，但已删除账户的旧 JWT 在 HTTP 与 WS 均被拒绝', async () => {
  // 首次安装未改过密码：credentialsChangedAt 为 null，仍必须放行
  assert.equal(users.credentialsChangedAt(userId), null);
  const okRes = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth() });
  assert.equal(okRes.statusCode, 200);

  // 删除该用户后，credAt=0 的旧令牌绝不可因 credentialsChangedAt===null 而放行
  getDb().run('DELETE FROM users WHERE id = ?', userId);

  const deniedHttp = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth() });
  assert.equal(deniedHttp.statusCode, 401);

  const wsCode = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`${wsBaseUrl}?token=${token}`);
    ws.on('close', (code) => resolve(code));
  });
  assert.equal(wsCode, 1008);
});

test('P2 安全: 修改密码后立刻踢断该用户活跃的 /api/events WebSocket 连接', async () => {
  const ws = new WebSocket(`${wsBaseUrl}?token=${token}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const closePromise = new Promise<number>((resolve) => {
    ws.once('close', (code) => resolve(code));
  });

  const change = await app.inject({
    method: 'PATCH',
    url: '/api/auth/account',
    headers: auth(),
    payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  assert.equal(change.statusCode, 200, change.payload);

  const closeCode = await Promise.race([
    closePromise,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error('修改密码后未在 2 秒内断开已有 WS 连接')), 2000),
    ),
  ]);
  assert.equal(closeCode, 1008);
});

test('P2 安全: /api/events 限制单帧 maxPayload 为 64 KiB，超限消息断开连接', async () => {
  const ws = new WebSocket(`${wsBaseUrl}?token=${token}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  // 正常小消息不断连
  ws.send('ping-small');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ws.readyState, WebSocket.OPEN, '正常小帧不应触发断连');

  // 超过 64 KiB 的消息应立刻被服务端断开（ws 发送 1009 并关闭底层连接，Windows loopback 下可能先观测到 1006）
  const closeCode = await new Promise<number>((resolve) => {
    ws.once('close', (code) => resolve(code));
    ws.send(Buffer.alloc(65 * 1024, 0x41));
  });
  assert.ok(
    closeCode === 1009 || closeCode === 1006,
    `超过 64 KiB 的消息应被服务端断开（1009/1006），实际 ${closeCode}`,
  );
});

test('P2 安全: 未捕获 500 响应不向客户端回显内部异常原文', async () => {
  throwOnRunningIds = true;
  const res = await app.inject({ method: 'GET', url: '/api/traders', headers: auth() });
  assert.equal(res.statusCode, 500);
  const body = res.json() as { error: string };
  assert.ok(!body.error.includes('INTERNAL_SQLITE_SECRET_LEAK_TOKEN'), '500 响应泄露了内部错误详情');
  assert.equal(body.error, '服务器内部错误，请稍后重试');
});
