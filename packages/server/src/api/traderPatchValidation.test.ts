/**
 * 2026-11-10 审计回归：
 *
 *  · #3  `PATCH /api/traders/:id` 必须复用创建时的模式/策略/模型规则：
 *        传 `mode` 不能静默 200；AI 驱动模式不能绑回策略；固定策略不能置空策略；
 *        不存在的策略 / 模型给出可读的 400，而不是 SQLite 外键错误。
 *  · #21 `POST /api/traders/:id/agent-review` 被拒时，原因必须放进 `error`
 *        （前端 `request()` 以 `error` 为准，只给 `note` 时页面只显示「HTTP 409」）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { defaultStrategyConfig } from '@aq/shared';

import type { ExchangeConnection } from '../binance/bootstrap.js';
import { Vault, hashPassword } from '../crypto/vault.js';
import { closeDb, initDb } from '../db/index.js';
import type { BalanceService } from '../services/balance.js';
import { aiModels, strategies, traders, users } from '../store/repositories.js';
import type { TraderManager } from '../trader/manager.js';
import { buildServer, type ApiDependencies } from './server.js';

const OWNER = 'admin_patch_validation';
const PASSWORD = 'patch-validation-password-42';
const JWT_SECRET = 'patch-validation-test-secret-not-real';

let workDir: string;
let app: FastifyInstance;
let token = '';
let modelId = 0;
let strategyId = 0;
/** 桩 manager 的审视结果 —— 每条用例自己设定。 */
let reviewBehaviour: () => { accepted: boolean; note: string } = () => ({ accepted: true, note: 'ok' });

function stubDependencies(): ApiDependencies {
  return {
    vault: new Vault(randomBytes(32)),
    manager: {
      runningSince: () => new Map<number, number>(),
      isRunning: () => false,
      stopTrader: async () => {},
      requestAgentReview: () => reviewBehaviour(),
    } as unknown as TraderManager,
    jwtSecret: JWT_SECRET,
    publicConnection: { environment: 'demo' } as unknown as ExchangeConnection,
    balance: {} as unknown as BalanceService,
  };
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-patch-validation-'));
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
  const db = initDb(path.join(workDir, 'test.sqlite'));
  db.exec(
    'DELETE FROM users; DELETE FROM traders; DELETE FROM ai_models; DELETE FROM strategies; DELETE FROM exchange_accounts;',
  );
  users.create(OWNER, hashPassword(PASSWORD), 'owner');
  modelId = aiModels.create({
    provider: 'custom',
    label: '夹具模型',
    model: 'fixture-model',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKeyEnc: new Vault(randomBytes(32)).encrypt('fixture-llm-key'),
    temperature: 0.2,
    maxTokens: 1024,
    timeoutSeconds: 30,
    maxRetries: 0,
  }).id;
  strategyId = strategies.create({
    name: '夹具策略',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  }).id;
  reviewBehaviour = () => ({ accepted: true, note: 'ok' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: OWNER, password: PASSWORD },
  });
  token = (res.json() as { token: string }).token;
  assert.ok(token.length > 0, '登录必须成功');
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function createTrader(mode: 'ai_managed' | 'strategy'): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/traders',
    headers: auth(),
    payload: {
      name: `patch-${mode}`,
      exchangeAccountId: null,
      aiModelId: modelId,
      strategyId: mode === 'strategy' ? strategyId : null,
      cycleIntervalMinutes: 15,
      mode,
      paperStartingBalance: 1000,
    },
  });
  assert.equal(res.statusCode, 200, res.payload);
  return (res.json() as { id: number }).id;
}

async function patch(id: number, payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'PATCH', url: `/api/traders/${id}`, headers: auth(), payload });
  return { status: res.statusCode, body: res.payload };
}

/* ---------------------------------- #3 ---------------------------------- */

test('#3 PATCH 传了不同的 mode → 400，不能静默 200', async () => {
  const id = await createTrader('ai_managed');
  const res = await patch(id, { mode: 'strategy' });
  assert.equal(res.status, 400, res.body);
  assert.match(res.body, /模式/);
  assert.equal(traders.get(id)?.mode, 'ai_managed');
});

test('#3 PATCH 原样带回当前 mode → 仍可正常改其它字段', async () => {
  const id = await createTrader('ai_managed');
  const res = await patch(id, { mode: 'ai_managed', name: '改名了' });
  assert.equal(res.status, 200, res.body);
  assert.equal(traders.get(id)?.name, '改名了');
});

test('#3 智能托管不能被 PATCH 绑回一个策略', async () => {
  const id = await createTrader('ai_managed');
  const res = await patch(id, { strategyId });
  assert.equal(res.status, 400, res.body);
  assert.equal(traders.get(id)?.strategyId, null);
});

test('#3 固定策略不能被 PATCH 置成无策略', async () => {
  const id = await createTrader('strategy');
  const res = await patch(id, { strategyId: null });
  assert.equal(res.status, 400, res.body);
  assert.equal(traders.get(id)?.strategyId, strategyId);
});

test('#3 不存在的策略 / 模型 → 可读的 400，而不是外键错误', async () => {
  const id = await createTrader('strategy');
  const badStrategy = await patch(id, { strategyId: 999_999 });
  assert.equal(badStrategy.status, 400, badStrategy.body);
  assert.match(badStrategy.body, /未知的策略/);
  const badModel = await patch(id, { aiModelId: 999_999 });
  assert.equal(badModel.status, 400, badModel.body);
  assert.match(badModel.body, /未知的 AI 模型/);
  assert.doesNotMatch(badModel.body, /FOREIGN KEY/);
});

test('#3 固定策略换成另一个存在的策略 → 照常成功', async () => {
  const id = await createTrader('strategy');
  const other = strategies.create({ name: '另一个', description: '', config: defaultStrategyConfig(), presetId: null });
  const res = await patch(id, { strategyId: other.id });
  assert.equal(res.status, 200, res.body);
  assert.equal(traders.get(id)?.strategyId, other.id);
});

/* ---------------------------------- #21 --------------------------------- */

test('#21 agent-review 被拒（409）时原因放在 error 字段', async () => {
  const id = await createTrader('ai_managed');
  reviewBehaviour = () => ({ accepted: false, note: '机器人没有在运行 —— 先启动它。' });
  const res = await app.inject({ method: 'POST', url: `/api/traders/${id}/agent-review`, headers: auth() });
  assert.equal(res.statusCode, 409);
  const body = res.json() as { ok: boolean; error?: string; note?: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, '机器人没有在运行 —— 先启动它。');
  assert.equal(body.note, '机器人没有在运行 —— 先启动它。', 'note 保留，兼容既有读者');
});

test('#21 agent-review 抛错（400）时原因放在 error 字段', async () => {
  const id = await createTrader('ai_managed');
  reviewBehaviour = () => {
    throw new Error('只有智能托管模式支持审视');
  };
  const res = await app.inject({ method: 'POST', url: `/api/traders/${id}/agent-review`, headers: auth() });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { ok: boolean; error?: string; note?: string };
  assert.equal(body.error, '只有智能托管模式支持审视');
  assert.equal(body.note, '只有智能托管模式支持审视');
});
