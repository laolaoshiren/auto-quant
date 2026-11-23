/**
 * **运行模式（模拟盘 / 实盘）在创建时固定** —— 回归测试（2026-11-10 用户要求）。
 *
 * 用户原话：「实盘/模拟 的根本逻辑得改一下：应该是由创建机器人的时候决定固定，
 * 而不是运行启动机器人的时候来决定。」
 *
 * 这条测试钉住四件事：
 *  1. 创建不传 `dryRun` → 固定为模拟盘（安全默认）；
 *  2. 创建传 `dryRun: false` 但没绑账户 → 拒绝（实盘必须有账户）；
 *  3. **启动请求里的 `dryRun` 被忽略** —— 以创建时固定的为准（核心诉求）；
 *  4. 老数据（`dry_run = NULL`）首次启动补写一次，之后不再变；
 *  5. `PATCH` 不允许改运行模式（改它等于把实盘机器人偷偷变成模拟盘，或反过来）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import type { ExchangeConnection } from '../binance/bootstrap.js';
import { Vault, hashPassword } from '../crypto/vault.js';
import { closeDb, initDb } from '../db/index.js';
import type { BalanceService } from '../services/balance.js';
import { aiModels, exchanges, traders, users } from '../store/repositories.js';
import type { TraderManager } from '../trader/manager.js';
import { buildServer, type ApiDependencies } from './server.js';

const OWNER = 'admin_fixed_mode';
const PASSWORD = 'fixed-mode-password-42';
const JWT_SECRET = 'fixed-mode-test-secret-not-real';

let workDir: string;
let app: FastifyInstance;
let token = '';
/** 桩 manager 收到的启动参数 —— 用它证明"启动请求里的 dryRun 没有被使用"。 */
const started: Array<{ id: number; dryRun: boolean }> = [];

function stubDependencies(): ApiDependencies {
  return {
    vault: new Vault(randomBytes(32)),
    manager: {
      runningSince: () => new Map<number, number>(),
      isRunning: () => false,
      isStarting: () => false,
      invalidateConnectionsForAccount: () => 0,
      startTraderAsync: (id: number, dryRun: boolean) => {
        started.push({ id, dryRun });
        return { ok: true, preflight: [] };
      },
      stopTrader: async () => {},
    } as unknown as TraderManager,
    jwtSecret: JWT_SECRET,
    publicConnection: { environment: 'demo' } as unknown as ExchangeConnection,
    balance: {} as unknown as BalanceService,
  };
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-fixed-dryrun-'));
  initDb(path.join(workDir, 'test.sqlite'));
  app = await buildServer(stubDependencies());
  await app.ready();
});

after(async () => {
  await app.close();
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  started.length = 0;
  const db = initDb(path.join(workDir, 'test.sqlite'));
  db.exec('DELETE FROM users; DELETE FROM traders; DELETE FROM ai_models; DELETE FROM exchange_accounts;');
  users.create(OWNER, hashPassword(PASSWORD), 'owner');
  const vault = new Vault(randomBytes(32));
  aiModels.create({
    provider: 'custom',
    label: 'magpie（测试）',
    model: 'workbuddy/deepseek-v4.1-flash',
    baseUrl: 'http://127.0.0.1:3425/v1',
    apiKeyEnc: vault.encrypt('test-placeholder-key'),
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 120,
    maxRetries: 1,
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: OWNER, password: PASSWORD },
  });
  token = (res.json() as { token: string }).token;
  assert.ok(token.length > 0, '登录必须成功');
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function createTrader(extra: Record<string, unknown>): Promise<{ id: number; status: number; body: string }> {
  const model = aiModels.list()[0]!;
  const res = await app.inject({
    method: 'POST',
    url: '/api/traders',
    headers: auth(),
    payload: {
      name: '模式测试',
      exchangeAccountId: null,
      aiModelId: model.id,
      strategyId: null,
      cycleIntervalMinutes: 15,
      mode: 'ai_managed',
      ...extra,
    },
  });
  const body = res.payload;
  const parsed = res.statusCode < 400 ? (res.json() as { id: number }) : { id: 0 };
  return { id: parsed.id, status: res.statusCode, body };
}

test('★ 创建时不传 dryRun → 固定为模拟盘（安全默认）', async () => {
  const created = await createTrader({});
  assert.equal(created.status, 200, created.body);
  assert.equal(traders.get(created.id)?.dryRun, true, '不传时必须默认模拟盘');
});

test('★ 创建时传 dryRun=false 但没有账户 → 拒绝', async () => {
  const created = await createTrader({ dryRun: false });
  assert.equal(created.status, 400);
  assert.match(created.body, /实盘/);
});

test('★★ 启动请求里的 dryRun 被忽略：以创建时固定的为准（核心诉求）', async () => {
  const created = await createTrader({});
  const res = await app.inject({
    method: 'POST',
    url: `/api/traders/${created.id}/start`,
    headers: auth(),
    payload: { dryRun: false },
  });
  assert.equal(res.statusCode, 200, res.payload);
  assert.deepEqual(
    started.at(-1),
    { id: created.id, dryRun: true },
    '创建时固定为模拟盘 —— 启动时传 false 不得覆盖它',
  );
});

test('★★ 老数据（dry_run=NULL）首次启动补写固定一次，之后不再变', async () => {
  const created = await createTrader({});
  const db = initDb(path.join(workDir, 'test.sqlite'));
  db.exec(`UPDATE traders SET dry_run = NULL WHERE id = ${created.id}`);

  const first = await app.inject({
    method: 'POST',
    url: `/api/traders/${created.id}/start`,
    headers: auth(),
    payload: { dryRun: false },
  });
  assert.equal(first.statusCode, 200, first.payload);
  assert.equal(traders.get(created.id)?.dryRun, false, '首次启动用请求值补写');
  assert.deepEqual(started.at(-1), { id: created.id, dryRun: false });

  const second = await app.inject({
    method: 'POST',
    url: `/api/traders/${created.id}/start`,
    headers: auth(),
    payload: { dryRun: true },
  });
  assert.equal(second.statusCode, 200, second.payload);
  assert.deepEqual(started.at(-1), { id: created.id, dryRun: false }, '第二次启动不得再改运行模式');
});

test('★ 编辑不允许修改运行模式', async () => {
  const created = await createTrader({});
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/traders/${created.id}`,
    headers: auth(),
    payload: { dryRun: false },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.payload, /运行模式/);
});

test('★★★ 创建时拒绝「Gate 正式网 + 模拟盘」，避免造出永远无法启动也无法编辑修复的死机器人', async () => {
  const vault = new Vault(randomBytes(32));
  const gateLive = exchanges.create({
    exchange: 'gate',
    label: 'Gate 正式网',
    apiKey: 'gk-live',
    apiSecretEnc: vault.encrypt('gs-live'),
    testnet: false,
    canTrade: true,
  });
  const created = await createTrader({ exchangeAccountId: gateLive.id, dryRun: true, initialEquity: 500 });
  assert.equal(created.status, 400);
  assert.match(created.body, /Gate 正式网/);

  const gateTest = exchanges.create({
    exchange: 'gate',
    label: 'Gate 测试网',
    apiKey: 'gk-test',
    apiSecretEnc: vault.encrypt('gs-test'),
    testnet: true,
    canTrade: true,
  });
  const testDryRun = await createTrader({ exchangeAccountId: gateTest.id, dryRun: true, initialEquity: 500 });
  assert.equal(testDryRun.status, 400, 'Gate 测试网同样不支持本地模拟盘');
  const testDefault = await createTrader({ exchangeAccountId: gateTest.id, initialEquity: 500 });
  assert.equal(testDefault.status, 200, 'Gate 测试网不传 dryRun 时默认落库为 false（测试网撮合）');
  assert.equal(traders.get(testDefault.id)?.dryRun, false);
});

test('★★★ 老数据启动补写 dryRun 必须校验布尔值，传入 0 等 falsy 非布尔值不得误固化为实盘', async () => {
  const created = await createTrader({});
  const db = initDb(path.join(workDir, 'test.sqlite'));
  db.exec(`UPDATE traders SET dry_run = NULL WHERE id = ${created.id}`);

  const res = await app.inject({
    method: 'POST',
    url: `/api/traders/${created.id}/start`,
    headers: auth(),
    payload: { dryRun: 0 },
  });
  assert.equal(res.statusCode, 200, res.payload);
  assert.equal(traders.get(created.id)?.dryRun, true, '非布尔值必须安全回落模拟盘');
});
