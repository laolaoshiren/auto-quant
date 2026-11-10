/**
 * **Gate 连接创建的契约** —— 重点钉住"环境由账户的 testnet 字段决定"，
 * 以及阶段 2 新增的行情层 / 交易注册表在**创建连接时**就绪。
 *
 * ## 为什么这个测试存在
 *
 * Gate 与币安的"环境"概念不同：币安用 query 参数切测试网，Gate 是**独立域名**
 * （`api-testnet.gateapi.io` vs `api.gateio.ws`）。如果哪里写死成全局 env 或
 * `dryRun`，症状是"测试网账户连了正式网" —— 不报错、只是钱是真的。
 *
 * 这里钉住：
 * ① `environment` 参数直通端点（testnet / live 两个主机名）；
 * ② 创建出的是 `GateBroker` / `GateContractRegistry` / `GateMarket`（不是币安实现）；
 * ③ 交易循环用的 `registry` 是**同步 `SymbolRegistry`**（由 Gate 合约映射），
 *    并且默认在创建连接时就拉合约、构建好（取不到 → 抛错，不带着空表启动）；
 * ④ `apiKey` 真的进了签名请求头（不是空串占位）；
 * ⑤ 启动预检 `gateStartupChecks()` 对"账户可读 + 有余额 + 注册表非空"给 ok，
 *    对"账户读不到 / 余额 0 / 注册表空"给 blocking error。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { SymbolInfo } from '@aq/shared';
import { GateContractRegistry } from './account.js';
import { GateBroker } from './broker.js';
import {
  connectGate,
  gateEnvironmentOf,
  gateStartupChecks,
  type ConnectGateOptions,
  type GateMarketPort,
} from './connection.js';
import { GateMarket } from './market.js';
import { GateRest } from './rest.js';
import { SymbolRegistry } from '../binance/symbols.js';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** 与 `gate/symbols.test.ts` 同一份实测口径的合约（只保留构建注册表/行情用到的字段）。 */
const REAL_CONTRACTS = [
  {
    name: 'BTC_USDT',
    status: 'trading',
    in_delisting: false,
    quanto_multiplier: '0.0001',
    order_price_round: '0.1',
    order_size_min: 1,
    order_size_max: 1000000,
    leverage_max: '125',
    taker_fee_rate: '0.00075',
    maker_fee_rate: '-0.0001',
    funding_next_apply: 1794355200,
    interest_rate: '0.0003',
    position_size: 30228906096,
  },
];

const BTC_SYMBOL_INFO: SymbolInfo = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  pricePrecision: 1,
  quantityPrecision: 4,
  tickSize: 0.1,
  stepSize: 0.0001,
  minQty: 0.0001,
  maxQty: 100,
  minNotional: 0.0001,
  contractSize: 1,
};

/** 账户实测响应（测试网 776.26 USDT）。 */
const ACCOUNT_BODY = { total: '776.26', unrealised_pnl: '0', available: '776.26', margin: '0', currency: 'USDT' };

/** 用假 fetch 响应所有请求；`routes` 按 URL 片段匹配。 */
function fetchServing(routes: Array<{ match: RegExp; body: unknown; status?: number }>) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const hit = routes.find((r) => r.match.test(url));
    return new Response(JSON.stringify(hit?.body ?? {}), {
      status: hit?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

/**
 * 离线连接：注入空的同步注册表 + 行情层桩，避免测试发任何网络请求。
 *
 * 生产默认会在创建连接时拉一次合约（见 `connectGate` 的注释），那属于**启动期**
 * 行为；环境/字段这类契约测试没理由依赖网络。
 */
function offlineOptions(over: Partial<ConnectGateOptions> = {}): ConnectGateOptions {
  return {
    apiKey: 'k',
    apiSecret: 's',
    environment: 'testnet',
    createMarket: () => ({}) as unknown as GateMarket,
    createRegistry: async () => new SymbolRegistry([BTC_SYMBOL_INFO]),
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/*  环境 / 组件                                                                */
/* -------------------------------------------------------------------------- */

test('★★★ 环境由入参决定：testnet 走测试网域名、live 走正式网域名', async () => {
  const testnet = await connectGate(offlineOptions({ environment: 'testnet' }));
  assert.equal(testnet.environment, 'testnet');
  assert.ok(
    testnet.rest.endpoints.rest.includes('api-testnet.gateapi.io'),
    `testnet 的 REST 主机不对：${testnet.rest.endpoints.rest}`,
  );

  const live = await connectGate(offlineOptions({ environment: 'live' }));
  assert.equal(live.environment, 'live');
  assert.ok(
    live.rest.endpoints.rest.includes('api.gateio.ws'),
    `live 的 REST 主机不对：${live.rest.endpoints.rest}`,
  );
});

test('★★★ 创建出 GateBroker / 合约注册表 / GateMarket / 同步 SymbolRegistry', async () => {
  /* 这条要验证**默认路径**会造出真实的 `GateMarket`（而不是注入的桩）。 */
  const connection = await connectGate(offlineOptions({ createMarket: undefined }));

  assert.equal(connection.exchange, 'gate', 'manager 靠它做分派（union 收窄）');
  assert.ok(connection.broker instanceof GateBroker, '必须是 GateBroker，不是币安实现');
  assert.ok(connection.contracts instanceof GateContractRegistry, 'Gate 原生合约表');
  assert.ok(connection.rest instanceof GateRest);
  /*
   * 交易循环用的 `registry` 是**同步 SymbolRegistry**（不是 GateContractRegistry）：
   * 取整/最小名义/数量换算全部复用币安那套实现，不重写第二套。
   */
  assert.ok(connection.registry instanceof SymbolRegistry);
  assert.equal(connection.registry.size, 1);
  assert.equal(connection.registry.require('BTCUSDT').tickSize, 0.1);
  assert.ok(connection.market instanceof GateMarket);
  /* Gate 用请求级时间戳，没有全局校时；字段保留只为让 manager 的统一日志可用。 */
  assert.equal(connection.clockOffsetMs, 0);
});

test('★★ createMarket / createRegistry 工厂可注入（连接层不各建一套）', async () => {
  let marketCalled = 0;
  let registryCalled = 0;
  const market = {} as unknown as GateMarketPort;

  const connection = await connectGate({
    ...offlineOptions(),
    createMarket: (rest, contracts) => {
      marketCalled += 1;
      assert.ok(rest instanceof GateRest);
      assert.ok(contracts instanceof GateContractRegistry);
      return market as unknown as GateMarket;
    },
    createRegistry: async (contracts, injectedMarket) => {
      registryCalled += 1;
      assert.ok(contracts instanceof GateContractRegistry);
      assert.equal(injectedMarket, market, '注册表工厂拿到的必须是同一个行情实例');
      return new SymbolRegistry([BTC_SYMBOL_INFO]);
    },
  });

  assert.equal(marketCalled, 1, '行情层工厂必须只调用一次');
  assert.equal(registryCalled, 1, '注册表工厂必须只调用一次');
  assert.equal(connection.market, market, '注入后 market 必须就是那个实例');
});

test('★★★ 默认在创建连接时拉合约并构建注册表（启动期；取不到就抛错）', async () => {
  /*
   * 交易循环只认同步注册表；空表会让之后每一次行情/下单都失败，而启动看起来成功
   *（静默失能）。所以默认路径必须**启动期**构建，且失败即抛错。
   */
  const { fetchImpl, seen } = fetchServing([{ match: /\/futures\/usdt\/contracts/, body: REAL_CONTRACTS }]);
  const connection = await connectGate({
    apiKey: 'k',
    apiSecret: 's',
    environment: 'testnet',
    fetchImpl,
  });
  assert.ok(seen.some((s) => /\/futures\/usdt\/contracts/.test(s.url)), '必须拉一次合约列表');
  assert.equal(connection.registry.size, 1);
  assert.equal(connection.registry.require('BTCUSDT').tickSize, 0.1);

  /* 合约端点返回坏形状 → 拒绝启动，而不是带着空注册表继续。 */
  const broken = fetchServing([{ match: /\/futures\/usdt\/contracts/, body: { error: 'oops' } }]);
  await assert.rejects(
    () =>
      connectGate({ apiKey: 'k', apiSecret: 's', environment: 'testnet', fetchImpl: broken.fetchImpl }),
    /Gate 返回的可交易合约数为 0|not iterable|is not a function/i,
  );
});

test('★★★ apiKey 真的进了签名请求头（KEY 头 + 测试网 URL）', async () => {
  /*
   * 用假的 `fetch` 截一次签名请求：Gate 的签名依赖 `KEY` 头与 URL 里的 path。
   * 这条同时证明 `connectGate` 把 apiKey/apiSecret **透传**给了 `GateRest`。
   */
  const { fetchImpl, seen } = fetchServing([]);
  const connection = await connectGate(
    offlineOptions({ apiKey: 'test-key', apiSecret: 'test-secret', fetchImpl }),
  );
  await connection.rest.signed('GET', '/futures/usdt/accounts');

  assert.equal(seen.length, 1);
  assert.ok(
    seen[0]!.url.startsWith('https://api-testnet.gateapi.io/api/v4'),
    `请求 URL 必须是测试网：${seen[0]!.url}`,
  );
  assert.equal(seen[0]!.headers.KEY, 'test-key', 'KEY 头必须是账户的 apiKey');
  /* HMAC-SHA512 → 128 位 hex；空串说明签名没算（会被 Gate 拒）。 */
  assert.ok(seen[0]!.headers.SIGN && seen[0]!.headers.SIGN.length === 128, 'SIGN 头必须是 128 位 hex');
});

test('★★ gateEnvironmentOf 是唯一映射：账户 testnet=true → testnet、false → live', () => {
  assert.equal(gateEnvironmentOf(true), 'testnet');
  assert.equal(gateEnvironmentOf(false), 'live');
});

/* -------------------------------------------------------------------------- */
/*  启动预检（阶段 2 放开启动的判据）                                            */
/* -------------------------------------------------------------------------- */

test('★★★ 启动预检：账户可读 + 有余额 + 注册表非空 → 没有任何 blocking', async () => {
  const { fetchImpl } = fetchServing([
    { match: /\/futures\/usdt\/accounts$/, body: ACCOUNT_BODY },
  ]);
  const connection = await connectGate(offlineOptions({ apiKey: 'test-key', fetchImpl }));

  const checks = await gateStartupChecks(connection);
  const blocking = checks.filter((c) => !c.ok && c.blocking);
  assert.deepEqual(blocking, [], `不应有阻断项：${JSON.stringify(blocking)}`);

  const names = checks.map((c) => c.name);
  assert.ok(names.includes('账户访问'), `预检必须报告账户读取，实际：${names.join('/')}`);
  assert.ok(names.includes('交易余额'));
  assert.ok(names.includes('合约元数据'));
  assert.ok(names.includes('测试环境提示'), '测试网必须提示"假钱、真实撮合"');
  const testnetNotice = checks.find((c) => c.name === '测试环境提示');
  assert.equal(testnetNotice?.severity, 'warn', '测试网提示是 warn，不阻断启动');
  assert.equal(testnetNotice?.blocking, false);
});

test('★★ 启动预检：账户读不到 → blocking error（不能带着坏凭据跑循环）', async () => {
  const { fetchImpl } = fetchServing([
    { match: /\/futures\/usdt\/accounts$/, body: { label: 'INVALID_KEY' }, status: 401 },
  ]);
  const connection = await connectGate(offlineOptions({ apiKey: 'bad-key', fetchImpl }));

  const checks = await gateStartupChecks(connection);
  const accountCheck = checks.find((c) => c.name === '账户访问');
  assert.ok(accountCheck);
  assert.equal(accountCheck!.severity, 'error');
  assert.equal(accountCheck!.blocking, true);
});

test('★★ 启动预检：可用余额为 0 → blocking error（开不了仓就别让它跑）', async () => {
  const { fetchImpl } = fetchServing([
    {
      match: /\/futures\/usdt\/accounts$/,
      body: { total: '0', unrealised_pnl: '0', available: '0', margin: '0', currency: 'USDT' },
    },
  ]);
  const connection = await connectGate(offlineOptions({ fetchImpl }));

  const checks = await gateStartupChecks(connection);
  const balance = checks.find((c) => c.name === '交易余额');
  assert.ok(balance);
  assert.equal(balance!.severity, 'error');
  assert.equal(balance!.blocking, true);
});

test('★★ 启动预检：合约注册表为空 → blocking error（所有标的都会 Unknown symbol）', async () => {
  const { fetchImpl } = fetchServing([{ match: /\/futures\/usdt\/accounts$/, body: ACCOUNT_BODY }]);
  const connection = await connectGate(
    offlineOptions({ fetchImpl, createRegistry: async () => new SymbolRegistry([]) }),
  );

  const checks = await gateStartupChecks(connection);
  const registryCheck = checks.find((c) => c.name === '合约元数据');
  assert.ok(registryCheck);
  assert.equal(registryCheck!.severity, 'error');
  assert.equal(registryCheck!.blocking, true);
});
