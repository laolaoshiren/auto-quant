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
import { aiModels, exchanges, strategies, traders, users } from '../store/repositories.js';
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

/** 桩 manager 是否报告"正在启动途中" —— 每条用例自己设定。 */
let starting = false;
/** 桩 manager 是否报告"运行中" —— 每条用例自己设定。 */
let running = false;
/** 记录热更新回调的入参，断言运行中改配置真正推送到了内存实例。 */
let liveUpdates: Array<{ traderId: number; patch: Record<string, unknown> }> = [];

function stubDependencies(): ApiDependencies {
  return {
    vault: new Vault(randomBytes(32)),
    manager: {
      runningSince: () => new Map<number, number>(),
      isRunning: () => running,
      isStarting: () => starting,
      invalidateConnectionsForAccount: () => 0,
      stopTrader: async () => {},
      requestAgentReview: () => reviewBehaviour(),
      applyLiveUpdate: (traderId: number, patch: Record<string, unknown>) => {
        liveUpdates.push({ traderId, patch });
        return running;
      },
    } as unknown as TraderManager,
    jwtSecret: JWT_SECRET,
    publicConnection: { environment: 'demo' } as unknown as ExchangeConnection,
    balance: { invalidate: () => {} } as unknown as BalanceService,
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
  starting = false;
  running = false;
  liveUpdates = [];
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

/* ------------------------- 2026-11-11：启动途中的守卫 ------------------------- */

test('启动途中 PATCH → 409，改动不落库（isRunning 此时还是 false）', async () => {
  const id = await createTrader('ai_managed');
  starting = true;
  const res = await patch(id, { name: '启动中改名' });
  assert.equal(res.status, 409, res.body);
  assert.match(res.body, /正在启动/, '文案要说清是"启动中"，而不是让一台显示已停止的机器人"请先停止"');
  assert.equal(traders.get(id)?.name, 'patch-ai_managed', '被拒的改动不能写进库');
});

test('启动在等待期内被取消 → DELETE 等到后正常删除', async () => {
  const id = await createTrader('ai_managed');
  starting = true;
  setTimeout(() => {
    starting = false;
  }, 300);
  const res = await app.inject({ method: 'DELETE', url: `/api/traders/${id}`, headers: auth() });
  assert.equal(res.statusCode, 200, res.payload);
  assert.ok(!traders.get(id), '启动收尾后应当删掉');
});

test('等待期内启动反而成功进入运行 → DELETE 409，机器人行还在', async () => {
  const id = await createTrader('ai_managed');
  starting = true;
  setTimeout(() => {
    starting = false;
    running = true;
  }, 300);
  const res = await app.inject({ method: 'DELETE', url: `/api/traders/${id}`, headers: auth() });
  assert.equal(res.statusCode, 409, res.payload);
  assert.ok(traders.get(id), '一台在跑的机器人不能被删行');
});

test('启动迟迟不收尾时 DELETE → 409，机器人行还在（不能留下幽灵机器人；本条会等满约 4 秒）', async () => {
  const id = await createTrader('ai_managed');
  starting = true;
  const res = await app.inject({ method: 'DELETE', url: `/api/traders/${id}`, headers: auth() });
  assert.equal(res.statusCode, 409, res.payload);
  assert.ok(traders.get(id), '启动还没收尾就删行，会让在途的启动对着不存在的机器人继续跑');
});

test('未在启动 / 运行时 DELETE → 照常删除', async () => {
  const id = await createTrader('ai_managed');
  const res = await app.inject({ method: 'DELETE', url: `/api/traders/${id}`, headers: auth() });
  assert.equal(res.statusCode, 200, res.payload);
  assert.ok(!traders.get(id), '行应当已被删除');
});

/* ---------------- 2026-11-24：智能托管统一预设模型 ---------------- */

test('★★★ 智能托管创建时可不传 aiModelId（即使 ai_models 为空也能自动补占位）', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/traders',
    headers: auth(),
    payload: {
      name: '智能托管-免选模型',
      exchangeAccountId: null,
      strategyId: null,
      cycleIntervalMinutes: 15,
      mode: 'ai_managed',
      paperStartingBalance: 1000,
    },
  });
  assert.equal(res.statusCode, 200, res.payload);
  const created = res.json() as { id: number; mode: string; aiModelId: number };
  assert.equal(created.mode, 'ai_managed');
  assert.ok(created.aiModelId > 0, '外键占位 id 必须有效');
});

test('★★★ 智能托管 PATCH 尝试切换 aiModelId → 明确 400 拒绝，原样带回或省略照常成功', async () => {
  const id = await createTrader('ai_managed');
  const current = traders.get(id)!;
  const otherModel = aiModels.create({
    provider: 'deepseek',
    label: '其他模型',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });

  const denied = await patch(id, { aiModelId: otherModel.id });
  assert.equal(denied.status, 400, denied.body);
  assert.match(denied.body, /workbuddy\/deepseek-v4\.1-flash/);
  assert.equal(traders.get(id)?.aiModelId, current.aiModelId, '被拒的改模型不得落库');

  const sameOk = await patch(id, { aiModelId: current.aiModelId, name: '智能托管改名' });
  assert.equal(sameOk.status, 200, sameOk.body);
  assert.equal(traders.get(id)?.name, '智能托管改名');
});

/* ----------- 2026-11-25：智能托管三档风险护栏 + 运行中热更新 ----------- */

test('★★★ 智能托管默认使用平衡档（20x/10x），支持创建时指定进取档（30x/15x）', async () => {
  const defaultId = await createTrader('ai_managed');
  const defaultCfg = JSON.parse(traders.get(defaultId)!.agentConfigJson!) as {
    managedRiskProfile: string;
    riskControl: { btcEthMaxLeverage: number; altcoinMaxLeverage: number; maxMarginUsage: number };
  };
  assert.equal(defaultCfg.managedRiskProfile, 'balanced');
  assert.equal(defaultCfg.riskControl.btcEthMaxLeverage, 20);
  assert.equal(defaultCfg.riskControl.altcoinMaxLeverage, 10);
  assert.equal(defaultCfg.riskControl.maxMarginUsage, 80);

  const aggRes = await app.inject({
    method: 'POST',
    url: '/api/traders',
    headers: auth(),
    payload: {
      name: '进取小资金',
      exchangeAccountId: null,
      strategyId: null,
      cycleIntervalMinutes: 15,
      mode: 'ai_managed',
      managedRiskProfile: 'aggressive',
      paperStartingBalance: 50,
    },
  });
  assert.equal(aggRes.statusCode, 200, aggRes.payload);
  const aggBody = aggRes.json() as { id: number; managedRiskProfile: string };
  assert.equal(aggBody.managedRiskProfile, 'aggressive');
  const aggCfg = JSON.parse(traders.get(aggBody.id)!.agentConfigJson!) as {
    riskControl: { btcEthMaxLeverage: number; altcoinMaxLeverage: number; maxMarginUsage: number };
  };
  assert.equal(aggCfg.riskControl.btcEthMaxLeverage, 30);
  assert.equal(aggCfg.riskControl.altcoinMaxLeverage, 15);
  assert.equal(aggCfg.riskControl.maxMarginUsage, 85);
});

test('★★★ 运行中支持直接热更新智能托管风险档位、名称与周期，且立即推送至运行实例', async () => {
  const id = await createTrader('ai_managed');
  running = true;

  const res = await patch(id, {
    name: '印钞机-在线改名',
    cycleIntervalMinutes: 10,
    managedRiskProfile: 'aggressive',
  });
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body) as { name: string; cycleIntervalMinutes: number; managedRiskProfile: string };
  assert.equal(body.name, '印钞机-在线改名');
  assert.equal(body.cycleIntervalMinutes, 10);
  assert.equal(body.managedRiskProfile, 'aggressive');

  const cfg = JSON.parse(traders.get(id)!.agentConfigJson!) as {
    managedRiskProfile: string;
    riskControl: { btcEthMaxLeverage: number; altcoinMaxLeverage: number };
  };
  assert.equal(cfg.managedRiskProfile, 'aggressive');
  assert.equal(cfg.riskControl.btcEthMaxLeverage, 30);
  assert.equal(cfg.riskControl.altcoinMaxLeverage, 15);

  assert.equal(liveUpdates.length, 1, '运行中热更新必须通知 TraderManager.applyLiveUpdate');
  assert.equal(liveUpdates[0]!.traderId, id);
  assert.ok(liveUpdates[0]!.patch.config, '必须携带新 StrategyConfig 替换运行实例 activeConfig');
});

test('★★★ 运行中固定策略模式允许在线改名/改周期，但切换 AI 模型仍需先停止（409）', async () => {
  const id = await createTrader('strategy');
  const otherModel = aiModels.create({
    provider: 'deepseek',
    label: '新模型',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  running = true;

  const ok = await patch(id, { name: '策略在线改名', cycleIntervalMinutes: 20 });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(traders.get(id)?.name, '策略在线改名');

  const denied = await patch(id, { aiModelId: otherModel.id });
  assert.equal(denied.status, 409, denied.body);
  assert.match(denied.body, /切换 AI 模型需要先停止/);
  assert.equal(traders.get(id)?.aiModelId, modelId);

  const nonManagedProfile = await patch(id, { managedRiskProfile: 'aggressive' });
  assert.equal(nonManagedProfile.status, 400, nonManagedProfile.body);
});

test('★★★ GET /api/auth/me 必须返回账户 createdAt，刷新后操作员账户页不显示「—」', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth() });
  assert.equal(res.statusCode, 200, res.payload);
  const body = res.json() as { user: { id: number; username: string; role: string; createdAt?: string } };
  assert.equal(body.user.username, OWNER);
  assert.equal(body.user.role, 'owner');
  assert.ok(typeof body.user.createdAt === 'string' && body.user.createdAt.length > 0, '必须返回 createdAt');
});

test('★★★ Zod v4 PATCH 不得把省略字段回写成默认值（trader / strategy / exchange-account）', async () => {
  /* 1. Trader PATCH：只改 name 不得把 cycleIntervalMinutes 回写为 15，也不得把 mode 填成 strategy */
  const id = await createTrader('ai_managed');
  const set30 = await patch(id, { cycleIntervalMinutes: 30 });
  assert.equal(set30.status, 200, set30.body);
  assert.equal(traders.get(id)?.cycleIntervalMinutes, 30);

  const renameOnly = await patch(id, { name: '仅改名不覆写周期' });
  assert.equal(renameOnly.status, 200, renameOnly.body);
  assert.equal(traders.get(id)?.name, '仅改名不覆写周期');
  assert.equal(traders.get(id)?.cycleIntervalMinutes, 30, '省略 cycleIntervalMinutes 时不得回写默认值 15');
  assert.equal(traders.get(id)?.mode, 'ai_managed');

  /* 2. Strategy PATCH：只改 name 不得把 description 清空成默认空串 */
  const strat = strategies.create({
    name: '原策略名',
    description: '保留这份说明',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  const patchStrat = await app.inject({
    method: 'PATCH',
    url: `/api/strategies/${strat.id}`,
    headers: auth(),
    payload: { name: '新策略名' },
  });
  assert.equal(patchStrat.statusCode, 200, patchStrat.payload);
  assert.equal(strategies.get(strat.id)?.description, '保留这份说明', '省略 description 不得清空原说明');

  /* 3. ExchangeAccount PATCH：只改 label 不得把实盘账户（testnet=false）改回 testnet=true */
  const liveAcc = exchanges.create({
    exchange: 'binance',
    label: '实盘账户',
    apiKey: 'k-live',
    apiSecretEnc: 'v1:00:00:00',
    testnet: false,
    canTrade: false,
  });
  const patchAcc = await app.inject({
    method: 'PATCH',
    url: `/api/exchange-accounts/${liveAcc.id}`,
    headers: auth(),
    payload: { label: '实盘账户-重命名' },
  });
  assert.equal(patchAcc.statusCode, 200, patchAcc.payload);
  assert.equal(exchanges.get(liveAcc.id)?.testnet, false, '省略 testnet 不得把实盘账户改回测试网');
  assert.equal(exchanges.get(liveAcc.id)?.canTrade, false, '省略 canTrade 不得把只读账户改回可交易');

  /* 4. AiModel PATCH：只改 label 不得把自定义 baseUrl 清空或覆盖 */
  const customModel = aiModels.create({
    provider: 'custom',
    label: '自定义模型',
    model: 'my-model',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnc: 'v1:00:00:00',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const patchModel = await app.inject({
    method: 'PATCH',
    url: `/api/ai-models/${customModel.id}`,
    headers: auth(),
    payload: { label: '自定义模型-重命名' },
  });
  assert.equal(patchModel.statusCode, 200, patchModel.payload);
  assert.equal(
    aiModels.get(customModel.id)?.baseUrl,
    'https://api.example.com/v1',
    '省略 baseUrl 不得清空或覆写已有自定义端点',
  );
});
