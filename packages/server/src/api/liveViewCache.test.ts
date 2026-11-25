/**
 * 控制台实时视图缓存、轻量 `/positions` 路径与 `MarketDataService` 并发去重测试。
 *
 * 锁定 2026-11-25 线上排查出来的币安 API 权重泄漏问题：
 *   1. `GET /api/traders/:id/positions` 只调用 `getPositions()`（5 权重），绝不附带
 *      40 权重的全量 `getOpenOrders()` 与 `getAccountState()`；
 *   2. 短 TTL 缓存 + 并发合并（in-flight dedup）让多标签页同时轮询只向交易所发 1 次请求；
 *   3. `GET /api/traders/:id/account` 顺带回填 `/positions` 缓存；
 *   4. 交易所异常（503）绝不缓存，下一次请求立刻重试恢复；
 *   5. 写操作（如 `/reconcile`）立即失效缓存；
 *   6. `MarketDataService` 并发调用 `getKlines` / `markPricesOf` 共享同一在途请求。
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { defaultStrategyConfig, type Kline } from '@aq/shared';
import type { ExchangeConnection } from '../binance/bootstrap.js';
import { SymbolRegistry } from '../binance/symbols.js';
import { Vault, hashPassword } from '../crypto/vault.js';
import { closeDb, initDb } from '../db/index.js';
import { MarketDataService } from '../market/service.js';
import type { MarketPort } from '../market/port.js';
import { aiModels, exchanges, strategies, traders, users } from '../store/repositories.js';
import type { TraderManager } from '../trader/manager.js';
import { signToken } from './auth.js';
import { buildServer, type ApiDependencies } from './server.js';

const JWT_SECRET = 'test-live-view-cache-secret-0123456789abcdef';

let workDir = '';
let app: FastifyInstance;
let vault: Vault;
let token = '';
let traderId = 0;

type MockPosition = Awaited<ReturnType<ExchangeConnection['broker']['getPositions']>>[number];

const exchange = {
  positions: [] as MockPosition[],
  fail: false,
  delayMs: 0,
};
let calls: string[] = [];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeConnection(): ExchangeConnection {
  return {
    environment: 'production',
    broker: {
      getAccountState: async () => {
        calls.push('getAccountState');
        if (exchange.delayMs > 0) await delay(exchange.delayMs);
        if (exchange.fail) throw new Error('测试：账户读数失败');
        return {
          asset: 'USDT',
          walletBalance: 500,
          availableBalance: 450,
          unrealizedPnl: 0,
          equity: 500,
          marginUsed: 50,
        };
      },
      getPositions: async () => {
        calls.push('getPositions');
        if (exchange.delayMs > 0) await delay(exchange.delayMs);
        if (exchange.fail) throw new Error('测试：持仓读数失败');
        return exchange.positions;
      },
      getOpenOrders: async () => {
        calls.push('getOpenOrders');
        if (exchange.delayMs > 0) await delay(exchange.delayMs);
        return [];
      },
    },
    market: {
      premiumIndex: async () => [],
    },
  } as unknown as ExchangeConnection;
}

function managerStub(): TraderManager {
  return {
    isRunning: () => true,
    isStarting: () => false,
    dryRunOf: () => false,
    startedAtOf: () => null,
    statusOf: () => 'running',
    readCircuitBreaker: () => null,
    leverageCap: () => 20,
    paperStartingBalanceOf: () => 500,
    reconcileTrader: async () => ({
      inserted: 0,
      updated: 0,
      attempted: 0,
      skippedSuspicious: 0,
      fundingUsdt: 0,
    }),
    stopTrader: async () => undefined,
  } as unknown as TraderManager;
}

const get = (url: string) =>
  app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });

const post = (url: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-live-view-cache-'));
  initDb(path.join(workDir, 'test.sqlite'));
  vault = new Vault(randomBytes(32));

  app = await buildServer({
    vault,
    manager: managerStub(),
    jwtSecret: JWT_SECRET,
    publicConnection: fakeConnection(),
    balance: {
      get: async () => ({ ok: false, error: 'stub' }),
      getAll: async () => new Map(),
      invalidate: () => undefined,
      invalidateAll: () => undefined,
      walletBalanceOf: async () => null,
    },
    openReadOnlyConnection: async () => fakeConnection(),
    liveViewCacheTtlMs: 5_000,
  } as unknown as ApiDependencies);
  await app.ready();
});

after(async () => {
  await app.close();
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  exchange.positions = [
    {
      symbol: 'BTCUSDT',
      side: 'long',
      quantity: 0.01,
      entryPrice: 90_000,
      markPrice: 91_000,
      leverage: 10,
      liquidationPrice: 82_000,
      unrealizedPnl: 10,
      unrealizedPnlPercent: 11.1,
      marginUsed: 90,
      marginType: 'isolated',
      notional: 910,
    },
  ];
  exchange.fail = false;
  exchange.delayMs = 0;
  calls = [];

  initDb(path.join(workDir, 'test.sqlite')).exec(
    'DELETE FROM positions; DELETE FROM orders; DELETE FROM trades; DELETE FROM traders;' +
      ' DELETE FROM strategies; DELETE FROM ai_models; DELETE FROM exchange_accounts; DELETE FROM users;',
  );

  const user = users.create('admin_cache', hashPassword('irrelevant'), 'owner');
  token = signToken(
    {
      sub: user.id,
      username: user.username,
      role: 'owner',
      credAt: users.credentialsChangedAt(user.id) ?? 0,
    },
    JWT_SECRET,
  );

  const accountId = exchanges.create({
    exchange: 'binance',
    label: '测试实盘',
    apiKey: 'fixture-key',
    apiSecretEnc: vault.encrypt('fixture-secret'),
    testnet: false,
    canTrade: true,
  }).id;
  const modelId = aiModels.create({
    provider: 'deepseek',
    label: '测试模型',
    model: 'deepseek-chat',
    baseUrl: '',
    apiKeyEnc: vault.encrypt('k'),
    maxTokens: 1024,
    temperature: 0.2,
    timeoutSeconds: 30,
    maxRetries: 0,
  }).id;
  const strategyId = strategies.create({
    name: '测试策略',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  }).id;
  traderId = traders.create({
    name: '缓存测试机器人',
    aiModelId: modelId,
    exchangeAccountId: accountId,
    strategyId,
    cycleIntervalMinutes: 15,
    initialEquity: 500,
  }).id;
  traders.setDryRun(traderId, false);

  // 确保每个用例从干净缓存开始
  await post(`/api/traders/${traderId}/reconcile`);
  calls = [];
});

describe('liveExchangeView / livePositionsView 权重优化', () => {
  it('GET /positions 只调用 getPositions()，不附带 40 权重的 getOpenOrders() 与 getAccountState()', async () => {
    const res = await get(`/api/traders/${traderId}/positions`);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, ['getPositions']);
  });

  it('并发与 TTL 内的重复 /positions 请求合并为 1 次交易所调用', async () => {
    exchange.delayMs = 30;
    const responses = await Promise.all([
      get(`/api/traders/${traderId}/positions`),
      get(`/api/traders/${traderId}/positions`),
      get(`/api/traders/${traderId}/positions`),
      get(`/api/traders/${traderId}/positions`),
    ]);
    for (const res of responses) assert.equal(res.statusCode, 200);
    // 再紧跟一次命中 TTL 缓存
    const cached = await get(`/api/traders/${traderId}/positions`);
    assert.equal(cached.statusCode, 200);
    assert.deepEqual(calls, ['getPositions']);
  });

  it('GET /account 成功后顺带回填 /positions 缓存，避免紧跟一次重复查询', async () => {
    const accRes = await get(`/api/traders/${traderId}/account`);
    assert.equal(accRes.statusCode, 200);
    assert.equal(calls.filter((c) => c === 'getPositions').length, 1);

    const posRes = await get(`/api/traders/${traderId}/positions`);
    assert.equal(posRes.statusCode, 200);
    assert.equal(calls.filter((c) => c === 'getPositions').length, 1);
  });

  it('交易所失败（503）永不缓存，恢复后下一次请求立刻成功', async () => {
    exchange.fail = true;
    const failed = await get(`/api/traders/${traderId}/positions`);
    assert.equal(failed.statusCode, 503);

    exchange.fail = false;
    const recovered = await get(`/api/traders/${traderId}/positions`);
    assert.equal(recovered.statusCode, 200);
    assert.equal(calls.filter((c) => c === 'getPositions').length, 2);
  });

  it('POST /reconcile 立即失效缓存，下一次 /positions 拿到最新数据', async () => {
    await get(`/api/traders/${traderId}/positions`);
    assert.equal(calls.length, 1);

    await post(`/api/traders/${traderId}/reconcile`);
    exchange.positions = [];

    const afterReconcile = await get(`/api/traders/${traderId}/positions`);
    assert.equal(afterReconcile.statusCode, 200);
    assert.deepEqual(afterReconcile.json(), []);
    assert.equal(calls.length, 2);
  });
});

describe('MarketDataService 并发在途去重', () => {
  it('并发 markPricesOf 与 getKlines 只发 1 次底层请求', async () => {
    let tickerCalls = 0;
    let premiumCalls = 0;
    let klineCalls = 0;
    const fakeKline: Kline = {
      openTime: 1_700_000_000_000,
      closeTime: 1_700_000_899_999,
      open: 100,
      high: 105,
      low: 99,
      close: 104,
      volume: 1000,
      quoteVolume: 100_000,
      trades: 100,
      takerBuyBase: 500,
      takerBuyQuote: 50_000,
    };
    const fakeMarket = {
      ticker24h: async () => {
        tickerCalls += 1;
        await delay(25);
        return [];
      },
      premiumIndex: async () => {
        premiumCalls += 1;
        await delay(25);
        return [{ symbol: 'BTCUSDT', markPrice: '91000', lastFundingRate: '0.0001' }];
      },
      fetchClosedKlines: async () => {
        klineCalls += 1;
        await delay(25);
        return [fakeKline];
      },
    } as unknown as MarketPort;

    const svc = new MarketDataService(
      fakeMarket,
      SymbolRegistry.fromExchangeInfo({
        serverTime: Date.now(),
        rateLimits: [],
        exchangeFilters: [],
        symbols: [],
      }),
    );
    const [m1, m2, m3] = await Promise.all([
      svc.markPricesOf(['BTCUSDT']),
      svc.markPricesOf(['BTCUSDT']),
      svc.markPricesOf(['BTCUSDT']),
    ]);
    assert.equal(tickerCalls, 1);
    assert.equal(premiumCalls, 1);
    assert.equal(m1.get('BTCUSDT'), 91000);
    assert.equal(m2.get('BTCUSDT'), 91000);
    assert.equal(m3.get('BTCUSDT'), 91000);

    const [k1, k2, k3] = await Promise.all([
      svc.getKlines('BTCUSDT', '15m', 50),
      svc.getKlines('BTCUSDT', '15m', 50),
      svc.getKlines('BTCUSDT', '15m', 50),
    ]);
    assert.equal(klineCalls, 1);
    assert.equal(k1.length, 1);
    assert.equal(k2.length, 1);
    assert.equal(k3.length, 1);
  });
});
