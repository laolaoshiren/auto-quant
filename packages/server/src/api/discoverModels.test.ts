/**
 * `/api/ai-models/discover` 的回归测试（真实 Fastify 应用 + 真实数据库，`app.inject()` 不打网络）。
 *
 * 钉住的是一条**功能性缺陷**：编辑一个已保存的模型时，界面刻意把 API Key 输入框留空
 * （提示写着"留空则保留已存储的密钥"），但请求体里只有 `apiKey: ''`，
 * 服务端没有任何办法表达"用那条记录里已存的密钥" —— 于是**任何一个已保存的模型**
 * 点「获取可用模型」都只会得到"请先填写 API Key"，而界面上方的密钥标签
 * 正显示着"当前已存储"。修法是给请求体加一个可选的 `modelId`。
 *
 * 另一个必须钉住的边界：**密钥永远不能出现在响应体里**。所以这里每一条断言
 * 都顺带检查序列化结果里不含那把明文密钥 —— 这条路径本来就是最容易被
 * 顺手 `JSON.stringify` 出去的一条。
 *
 * 全程不打真实网络：`fetch` 被替换成一个记录器。`discoverModels()` 就是靠
 * `fetch` 出站/验证密钥的，所以"它究竟把哪把密钥发了出去"可以在这里被直接观察到 ——
 * 这正是本测试要证明的东西。
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import type { ExchangeConnection } from '../binance/bootstrap.js';
import { Vault } from '../crypto/vault.js';
import { closeDb, initDb } from '../db/index.js';
import type { BalanceService } from '../services/balance.js';
import { aiModels, users } from '../store/repositories.js';
import type { TraderManager } from '../trader/manager.js';
import { signToken } from './auth.js';
import { buildServer, type ApiDependencies } from './server.js';

/**
 * 已存储的那把密钥 —— 请求里绝不可以出现它。
 *
 * 刻意不写成 `sk-…` 的形状：密钥扫描器按该模式拦截，**而它拦对了** ——
 * 宁可误报也不能漏过真密钥，所以不为了夹具方便去放宽规则。
 * 夹具只需要两个**互不相同**、且能被断言"没出现在请求里"的字符串。
 */
const STORED_KEY = 'test-fixture-stored-credential';
/** 用户在编辑框里新输入的那把。 */
const TYPED_KEY = 'test-fixture-typed-credential';
const JWT_SECRET = 'discover-test-secret-not-a-real-key';
const OWNER = 'admin_discover';

let workDir: string;
let app: FastifyInstance;
let vault: Vault;
let token: string;

/** 出站请求的记录器：既是断言对象，也保证这里不会真的打网络。 */
interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}
let calls: RecordedCall[] = [];
let originalFetch: typeof globalThis.fetch;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-discover-'));
  initDb(path.join(workDir, 'test.sqlite'));

  vault = new Vault(randomBytes(32));
  const dependencies: ApiDependencies = {
    vault,
    // 只实现被测路由会碰到的成员；其余留空但**不能抛错**，
    // 否则失败会以一条 500 出现，而不是以断言失败告诉你行为变了。
    manager: { runningSince: () => new Map<number, number>() } as unknown as TraderManager,
    jwtSecret: JWT_SECRET,
    publicConnection: { environment: 'demo' } as unknown as ExchangeConnection,
    balance: {} as unknown as BalanceService,
  };

  // 先把 fetch 换掉再建服务：任何一次意外的真实出站都会命中记录器，
  // 而不是带着一把真实密钥跑到互联网上。
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url: String(input), headers });
    return new Response(JSON.stringify({ data: [{ id: 'stub-model-a' }, { id: 'stub-model-b' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  app = await buildServer(dependencies);
  await app.ready();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  // `DELETE` 而不重建库：`initDb` 是单例，且 `buildServer` 已经持有依赖。
  initDb(path.join(workDir, 'test.sqlite')).exec('DELETE FROM ai_models; DELETE FROM users;');

  const user = users.create(OWNER, 'irrelevant-for-this-test', 'owner');
  token = signToken(
    { sub: user.id, username: user.username, role: 'owner', credAt: users.credentialsChangedAt(user.id) ?? 0 },
    JWT_SECRET,
  );
});

/** 建一个"已保存"的模型：密钥在库里是密文，对外只有掩码。 */
function saveModel(apiKey = STORED_KEY) {
  return aiModels.create({
    provider: 'deepseek',
    label: '已保存的模型',
    model: 'deepseek-chat',
    baseUrl: '',
    apiKeyEnc: vault.encryptOptional(apiKey),
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 120,
    maxRetries: 2,
  });
}

async function discover(payload: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/ai-models/discover',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown>, raw: response.body };
}

/** 断言响应里没有泄漏那把密钥 —— 掩码是唯一允许的密钥表示形式。 */
function assertNoKeyLeak(raw: string, key: string) {
  assert.ok(!raw.includes(key), `响应里出现了明文密钥：${raw.slice(0, 200)}`);
  // 掩码只保留头尾，长度必然显著短于原文；出现等长片段同样说明它没被掩。
  assert.ok(!raw.includes(key.slice(0, 12)), '响应里出现了密钥的前缀');
}

describe('/api/ai-models/discover 复用已存储的密钥', () => {
  it('apiKey 为空 + 有效 modelId：用该模型已存储的密钥去问提供商', async () => {
    const model = saveModel();

    const result = await discover({ provider: 'deepseek', baseUrl: '', apiKey: '', modelId: model.id });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.ok, true, JSON.stringify(result.body));
    assert.equal(result.body.source, 'live');

    // 直接观察出站请求：密钥确实来自那条记录，而不是空字符串。
    assert.equal(calls.length, 1, '应当恰好发出一次模型列表请求');
    assert.equal(calls[0]!.headers.authorization, `Bearer ${STORED_KEY}`);
    assert.equal(calls[0]!.url, 'https://api.deepseek.com/models');

    assertNoKeyLeak(result.raw, STORED_KEY);
  });

  it('同时给了 modelId 和输入密钥时，优先用用户输入的那把', async () => {
    const model = saveModel();

    await discover({ provider: 'deepseek', baseUrl: '', apiKey: TYPED_KEY, modelId: model.id });

    assert.equal(calls[0]!.headers.authorization, `Bearer ${TYPED_KEY}`);
    // 用户刚输入的密钥属于请求体，不属于响应；响应里同样不能出现任何一把。
    assert.equal(calls.length, 1);
  });

  it('apiKey 为空且没有 modelId：给出中文提示，且**不**调用提供商', async () => {
    const result = await discover({ provider: 'deepseek', baseUrl: '', apiKey: '' });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.source, 'fallback');
    assert.equal(result.body.message, '请先填写 API Key，然后才能获取模型列表。');
    // 带着空密钥去问提供商毫无意义，只会换来一个 401 —— 必须在本地就拦住。
    assert.equal(calls.length, 0, '空密钥不应产生任何出站请求');
  });

  it('modelId 指向一个没有存储密钥的模型：同样给中文提示而不是出站', async () => {
    const keyless = saveModel('');

    const result = await discover({ provider: 'deepseek', baseUrl: '', apiKey: '', modelId: keyless.id });

    assert.equal(result.body.ok, false);
    assert.equal(result.body.message, '请先填写 API Key，然后才能获取模型列表。');
    assert.equal(calls.length, 0);
  });

  it('modelId 不存在时不会 500，也不会出站', async () => {
    const result = await discover({ provider: 'deepseek', baseUrl: '', apiKey: '', modelId: 987_654 });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.message, '请先填写 API Key，然后才能获取模型列表。');
    assert.equal(calls.length, 0);
  });
});

describe('/api/ai-models/discover 的访问边界', () => {
  it('未认证的调用方拿不到密钥：401，且没有任何出站', async () => {
    const model = saveModel();

    const response = await app.inject({
      method: 'POST',
      url: '/api/ai-models/discover',
      payload: { provider: 'deepseek', baseUrl: '', apiKey: '', modelId: model.id },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(calls.length, 0, '未认证的请求绝不可以触发一次带密钥的出站调用');
    assertNoKeyLeak(response.body, STORED_KEY);
  });

  it('密钥从不出现在已保存模型的任何返回里，只有掩码与 hasKey', async () => {
    saveModel();

    const response = await app.inject({
      method: 'GET',
      url: '/api/ai-models',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.statusCode, 200);
    assertNoKeyLeak(response.body, STORED_KEY);

    const rows = response.json() as Array<{ hasKey: boolean; apiKeyMasked: string }>;
    assert.equal(rows[0]!.hasKey, true);
    assert.ok(rows[0]!.apiKeyMasked.includes('…'), '对外只提供掩码形式');
  });
});
