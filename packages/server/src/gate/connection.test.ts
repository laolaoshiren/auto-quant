/**
 * **Gate 连接创建的契约** —— 重点钉住"环境由账户的 testnet 字段决定"。
 *
 * ## 为什么这个测试存在
 *
 * Gate 与币安的"环境"概念不同：币安用 query 参数切测试网，Gate 是**独立域名**
 *（`api-testnet.gateapi.io` vs `api.gateio.ws`）。如果哪里写死成全局 env 或
 * `dryRun`，症状是"测试网账户连了正式网" —— 不报错、只是钱是真的。
 *
 * 这里钉住四件事：
 * ① `environment` 参数直通端点（testnet / live 两个主机名）；
 * ② 创建出的是 `GateBroker` + `GateContractRegistry`（不是币安实现）；
 * ③ 行情层默认缺省（`gate/market.ts` 由并发任务提供），注入工厂后才挂上；
 * ④ `apiKey` 真的进了签名请求头（不是空串占位）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GateContractRegistry } from './account.js';
import { GateBroker } from './broker.js';
import { connectGate, gateEnvironmentOf, type GateMarketPort } from './connection.js';
import { GateRest } from './rest.js';

test('★★★ 环境由入参决定：testnet 走测试网域名、live 走正式网域名', () => {
  const testnet = connectGate({ apiKey: 'k', apiSecret: 's', environment: 'testnet' });
  assert.equal(testnet.environment, 'testnet');
  assert.ok(
    testnet.rest.endpoints.rest.includes('api-testnet.gateapi.io'),
    `testnet 的 REST 主机不对：${testnet.rest.endpoints.rest}`,
  );

  const live = connectGate({ apiKey: 'k', apiSecret: 's', environment: 'live' });
  assert.equal(live.environment, 'live');
  assert.ok(
    live.rest.endpoints.rest.includes('api.gateio.ws'),
    `live 的 REST 主机不对：${live.rest.endpoints.rest}`,
  );
});

test('★★★ 创建出 GateBroker + 合约注册表；未注入行情工厂时 market 为 null', () => {
  const connection = connectGate({ apiKey: 'k', apiSecret: 's', environment: 'testnet' });
  assert.equal(connection.exchange, 'gate', 'manager 靠它做分派（union 收窄）');
  assert.ok(connection.broker instanceof GateBroker, '必须是 GateBroker，不是币安实现');
  assert.ok(connection.registry instanceof GateContractRegistry);
  assert.ok(connection.rest instanceof GateRest);
  /*
   * `gate/market.ts`（task-15）尚未落地 —— 这里是**显式**缺省，不是"忘了接"。
   * manager 见到 null 会明确拒绝启动（见 `requireTradingConnection`）。
   */
  assert.equal(connection.market, null);
  /* Gate 用请求级时间戳，没有全局校时；字段保留只为让 manager 的统一日志可用。 */
  assert.equal(connection.clockOffsetMs, 0);
});

test('★★ createMarket 工厂可以注入行情层（等 gate/market.ts 落地后直接用）', () => {
  let called = 0;
  const market = {} as unknown as GateMarketPort;

  const connection = connectGate({
    apiKey: 'k',
    apiSecret: 's',
    environment: 'testnet',
    createMarket: (rest, registry) => {
      called += 1;
      /* 工厂拿到的必须是"同一条连接"的 REST 与注册表（否则行情层与订单层会各连一套）。 */
      assert.ok(rest instanceof GateRest);
      assert.ok(registry instanceof GateContractRegistry);
      return market;
    },
  });

  assert.equal(called, 1, '工厂必须被调用一次（而不是每次读 market 都 new 一个）');
  assert.equal(connection.market, market, '注入后 market 必须就是那个实例');
});

test('★★★ apiKey 真的进了签名请求头（KEY 头 + 测试网 URL）', async () => {
  /*
   * 用假的 `fetch` 截一次签名请求：Gate 的签名依赖 `KEY` 头与 URL 里的 path。
   * 这条同时证明 `connectGate` 把 apiKey/apiSecret **透传**给了 `GateRest`。
   */
  const seen: Array<{ url: string; key?: string; sign?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: String(input), key: headers.KEY, sign: headers.SIGN });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const connection = connectGate({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    environment: 'testnet',
    fetchImpl,
  });
  await connection.rest.signed('GET', '/futures/usdt/accounts');

  assert.equal(seen.length, 1);
  assert.ok(
    seen[0]!.url.startsWith('https://api-testnet.gateapi.io/api/v4'),
    `请求 URL 必须是测试网：${seen[0]!.url}`,
  );
  assert.equal(seen[0]!.key, 'test-key', 'KEY 头必须是账户的 apiKey');
  /* HMAC-SHA512 → 128 位 hex；空串说明签名没算（会被 Gate 拒）。 */
  assert.ok(seen[0]!.sign && seen[0]!.sign.length === 128, 'SIGN 头必须是 128 位 hex');
});

test('★★ gateEnvironmentOf 是唯一映射：账户 testnet=true → testnet、false → live', () => {
  assert.equal(gateEnvironmentOf(true), 'testnet');
  assert.equal(gateEnvironmentOf(false), 'live');
});
