/**
 * **模拟盘的限价单必须真的"等价格"**（2026-11-09）。
 *
 * ## 这条测试防的那个 BUG
 *
 * 在此之前 `BinanceBroker.simulateStandard` 对 LIMIT 也返回 `FILLED`、
 * `avgPrice = markPrice` —— 也就是说模拟盘上：
 *
 * ```
 *   限价买 67,000（现价 68,000）→ 立刻成交，而且成交价是 68,000
 * ```
 *
 * 两个后果：
 *
 *   1. **"限价入场"这个策略在模拟盘上不存在** —— 它永远变成市价入场，
 *      而"等一个更好的价位"正是限价入场的全部意义；
 *   2. 风控按 `limitPrice` 计价（`reviewOpen` 的 `entryPrice` 口径），
 *      模拟成交却按 `markPrice` —— 同一笔交易两边口径不同，
 *      于是**模拟盘的盈亏与实盘不可比**。而本项目的后续开发以本地模拟盘为主。
 *
 * ## 现在的语义（最小撮合，不是真实撮合器）
 *
 * ```
 *   下单时价格已经穿过 → 立即成交（成交价 = 委托价，保守口径）
 *   没穿过             → NEW，挂进本地模拟账
 *   之后被查询时       → 按当时标记价再判一次；触及 → FILLED，成交价 = 委托价
 * ```
 *
 * ⚠️ **成交价用委托价**而不是"更好的成交价"：模拟器按保守方向记账，
 * 才不会让模拟盘看起来比实盘容易赚。
 *
 * ⚠️ 局限（别把这里当成真实撮合）：只在查询时推进、不模拟部分成交/滑点/排队。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BinanceBroker } from './broker.js';
import type { BinanceRest } from './rest.js';
import type { BinanceMarketData } from './market.js';
import { SymbolRegistry } from './symbols.js';
import type { BinanceExchangeInfo } from './types.js';

/* -------------------------------------------------------------------------- */
/*  Doubles                                                                    */
/* -------------------------------------------------------------------------- */

/** 记录每一次 REST 调用；dry-run 的断言是"一次签名请求都不能发"。 */
function fakeRest() {
  const calls: Array<{ method: string; path: string }> = [];
  const rest = {
    hasCredentials: true,
    usedWeight1m: 0,
    weightLimitPerMinute: 2400,
    baseUrl: 'https://fapi.binance.com',
    endpoints: { environment: 'production' },
    async syncTime() {
      return 0;
    },
    async publicGet(path: string) {
      calls.push({ method: 'GET', path });
      return {};
    },
    async signedRequest(method: string, path: string) {
      calls.push({ method, path });
      return {};
    },
    async keyedRequest(method: string, path: string) {
      calls.push({ method, path });
      return {};
    },
  };
  return { rest: rest as unknown as BinanceRest, calls };
}

/** 可变的标记价 —— 撮合推进完全由它决定，所以测试能精确控制"触没触及"。 */
function fakeMarket(initialMarkPrice: number) {
  const state = { markPrice: initialMarkPrice, unavailable: false };
  const market = {
    async premiumIndex() {
      if (state.unavailable) throw new Error('premiumIndex unavailable');
      return [{ symbol: 'BTCUSDT', markPrice: String(state.markPrice) }];
    },
    async ticker24h() {
      if (state.unavailable) throw new Error('ticker24h unavailable');
      return [{ symbol: 'BTCUSDT', lastPrice: String(state.markPrice) }];
    },
  };
  return { market: market as unknown as BinanceMarketData, state };
}

function exchangeInfo(): BinanceExchangeInfo {
  const symbol = (name: string): BinanceExchangeInfo['symbols'][number] => ({
    symbol: name,
    pair: name,
    contractType: 'PERPETUAL',
    deliveryDate: 0,
    status: 'TRADING',
    baseAsset: name.replace('USDT', ''),
    quoteAsset: 'USDT',
    marginAsset: 'USDT',
    pricePrecision: 2,
    quantityPrecision: 3,
    baseAssetPrecision: 8,
    quotePrecision: 8,
    underlyingType: 'COIN',
    orderTypes: [],
    timeInForce: [],
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
      { filterType: 'MIN_NOTIONAL', notional: '50' },
    ],
  });
  return {
    exchangeFilters: [],
    rateLimits: [],
    serverTime: 0,
    symbols: [symbol('BTCUSDT'), symbol('ETHUSDT')],
  };
}

function dryRunSetup(markPrice = 68_000) {
  const { rest, calls } = fakeRest();
  const { market, state } = fakeMarket(markPrice);
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());
  const broker = new BinanceBroker(rest, market, registry, { dryRun: true });
  return { broker, calls, state };
}

/* -------------------------------------------------------------------------- */
/*  LIMIT matching                                                             */
/* -------------------------------------------------------------------------- */

test('★★★ 价格未触及的限价买单【不成交】，挂进本地模拟账', async () => {
  const { broker, calls } = dryRunSetup(68_000);

  const placed = await broker.placeOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    quantity: 0.01,
    price: 67_000,
    timeInForce: 'GTC',
  });

  assert.equal(placed.status, 'NEW', '限价 67,000 而现价 68,000 —— 买单不该成交');
  assert.equal(placed.terminal, false);
  assert.equal(placed.executedQty, 0, '一张没成交的单不能报成交量');
  assert.equal(placed.avgPrice, 0, '没成交就没有成交价（不能拿标记价冒充）');
  assert.equal(calls.length, 0, '模拟盘下单不能发签名请求');

  const open = await broker.getOpenOrders('BTCUSDT');
  assert.equal(open.length, 1, '它还挂着，必须出现在挂单列表里');
  assert.equal(open[0]!.status, 'NEW');

  const queried = await broker.getOrder('BTCUSDT', placed.id);
  assert.equal(queried?.status, 'NEW');
});

test('★★★ 价格触及后按【委托价】成交（不是标记价）', async () => {
  const { broker, state } = dryRunSetup(68_000);

  const placed = await broker.placeOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    quantity: 0.01,
    price: 67_000,
  });
  assert.equal(placed.terminal, false);

  /* 价格跌到委托价之下 —— 埋着的买单成交。 */
  state.markPrice = 66_900;
  const filled = await broker.getOrder('BTCUSDT', placed.id);
  assert.equal(filled?.status, 'FILLED');
  assert.equal(filled?.executedQty, '0.01');
  assert.equal(
    filled?.avgPrice,
    String(67_000),
    '成交价必须是委托价 —— 模拟器不假设"限价单以更优价格成交"',
  );

  const open = await broker.getOpenOrders('BTCUSDT');
  assert.equal(open.length, 0, '成交后不再出现在挂单列表里');
});

test('★★★ 卖单方向相反：价格涨过委托价才成交', async () => {
  const { broker, state } = dryRunSetup(68_000);

  const placed = await broker.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'LIMIT',
    quantity: 0.01,
    price: 69_000,
  });
  assert.equal(placed.status, 'NEW', '限价卖 69,000 而现价 68,000 —— 不该成交');

  state.markPrice = 68_900;
  assert.equal((await broker.getOrder('BTCUSDT', placed.id))?.status, 'NEW', '还差一点，不成交');

  state.markPrice = 69_100;
  const filled = await broker.getOrder('BTCUSDT', placed.id);
  assert.equal(filled?.status, 'FILLED');
  assert.equal(filled?.avgPrice, String(69_000), '成交价 = 委托价');
});

test('★★ 下单时价格已经穿过 → 立即成交，成交价仍是委托价（保守口径）', async () => {
  const { broker } = dryRunSetup(68_000);

  const placed = await broker.placeOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    quantity: 0.01,
    price: 68_100,
  });

  assert.equal(placed.status, 'FILLED', '买价高于现价 = 一挂上就成交');
  assert.equal(placed.terminal, true);
  assert.equal(placed.executedQty, 0.01);
  assert.equal(
    placed.avgPrice,
    68_100,
    '按委托价记账：保守方向（不把市价 68,000 的更好成交价当成自己的）',
  );
});

test('★★ 撤销后的模拟挂单不能再成交', async () => {
  const { broker, state } = dryRunSetup(68_000);

  const placed = await broker.placeOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    quantity: 0.01,
    price: 67_000,
  });
  assert.equal(await broker.cancelOrder('BTCUSDT', placed.id, 'order'), true);

  /* 撤掉之后价格才跌到委托价 —— 它已经不存在了，不能凭空成交。 */
  state.markPrice = 66_000;
  const queried = await broker.getOrder('BTCUSDT', placed.id);
  assert.equal(queried?.status, 'CANCELED');
  assert.equal(queried?.executedQty, '0', '撤掉的单不能有成交量');
  assert.equal((await broker.getOpenOrders('BTCUSDT')).length, 0);
});

test('★★ cancelAllOrders 只撤该标的的模拟挂单', async () => {
  const { broker } = dryRunSetup(68_000);

  const btc = await broker.placeOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    quantity: 0.01,
    price: 67_000,
  });
  const eth = await broker.placeOrder({
    symbol: 'ETHUSDT',
    side: 'BUY',
    type: 'LIMIT',
    quantity: 0.1,
    price: 3_000,
  });

  await broker.cancelAllOrders('BTCUSDT');
  assert.equal((await broker.getOrder('BTCUSDT', btc.id))?.status, 'CANCELED');
  assert.equal(
    (await broker.getOrder('ETHUSDT', eth.id))?.status,
    'NEW',
    '另一个标的的模拟挂单不该被牵连',
  );
});

test('★★ 标记价读不到时保持 NEW（读不到 ≠ 成交）', async () => {
  const { broker, state } = dryRunSetup(68_000);
  const placed = await broker.placeOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    quantity: 0.01,
    price: 67_000,
  });

  state.unavailable = true;
  assert.equal(
    (await broker.getOrder('BTCUSDT', placed.id))?.status,
    'NEW',
    '行情读不到时不能凭空成交 —— 那一侧没有新信息',
  );
});

test('★ 不认识的模拟单号返回 null（不编造状态）', async () => {
  const { broker } = dryRunSetup(68_000);
  assert.equal(await broker.getOrder('BTCUSDT', '999999'), null);
});

/* -------------------------------------------------------------------------- */
/*  dryRun query guards — "读到的空"不能伪装成交易所的事实                       */
/* -------------------------------------------------------------------------- */

test('★★★ dryRun 下持仓/挂单/条件单/流水/成交查询都不碰交易所', async () => {
  const { broker, calls } = dryRunSetup(68_000);

  assert.deepEqual(await broker.getPositions(), [], '模拟盘持仓真相在本地台账（effectivePositions）');
  assert.deepEqual(await broker.getOpenAlgoOrders('BTCUSDT'), [], '模拟盘的保护单从未发到交易所');
  assert.deepEqual(await broker.getIncome({ startTime: 0 }), []);
  assert.deepEqual(await broker.getUserTrades('BTCUSDT'), []);
  assert.deepEqual(await broker.getOpenOrders(), []);

  assert.deepEqual(
    calls,
    [],
    '模拟盘的查询一次签名请求都不能发 —— 否则绑了真实账户时会读到别人的数据',
  );
});

test('★★ dryRun 下撤单/撤全部挂单也不碰交易所', async () => {
  const { broker, calls } = dryRunSetup(68_000);

  assert.equal(await broker.cancelOrder('BTCUSDT', '123', 'order'), true);
  await broker.cancelAllOrders('BTCUSDT');
  assert.deepEqual(calls, []);
});
