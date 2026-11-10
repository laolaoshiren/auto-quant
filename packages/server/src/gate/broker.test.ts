import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GateBroker,
  gateBookToIncome,
  gateFillToUserTrade,
  gateOrderToBinanceResponse,
  gatePriceOrderToAlgoResponse,
} from './broker.js';
import type { GateFuturesContract, GateFuturesOrder } from './types.js';

const BTC: GateFuturesContract = {
  name: 'BTC_USDT',
  quanto_multiplier: '0.0001',
  order_size_min: '1',
  order_price_round: '0.1',
  leverage_max: '125',
};

const limitOrder: GateFuturesOrder = {
  id: 9001,
  text: 'aq-entry-1',
  contract: 'BTC_USDT',
  size: 100,
  left: 100,
  price: '70000',
  status: 'open',
  create_time: '1700000000',
};

test('★ 订单映射：限价单 → 币安形状（数量换算成币数、状态 NEW）', () => {
  const raw = gateOrderToBinanceResponse(limitOrder, BTC);
  assert.equal(raw.orderId, 9001);
  assert.equal(raw.clientOrderId, 'aq-entry-1');
  assert.equal(raw.symbol, 'BTCUSDT');
  assert.equal(raw.side, 'BUY');
  assert.equal(raw.type, 'LIMIT');
  assert.equal(raw.origQty, '0.01');
  assert.equal(raw.price, '70000');
  assert.equal(raw.status, 'NEW');
  assert.equal(raw.timeInForce, 'GTC');
});

test('订单映射：市价单（price=0）→ MARKET + IOC；已成交 → FILLED', () => {
  const market: GateFuturesOrder = { ...limitOrder, price: '0', status: 'finished', left: 0, fill_price: '70100' };
  const raw = gateOrderToBinanceResponse(market, BTC);
  assert.equal(raw.type, 'MARKET');
  assert.equal(raw.timeInForce, 'IOC');
  assert.equal(raw.status, 'FILLED');
  assert.equal(raw.executedQty, '0.01');
  assert.equal(raw.avgPrice, '70100');
});

test('订单映射：部分成交 → PARTIALLY_FILLED；已撤 → CANCELED', () => {
  assert.equal(gateOrderToBinanceResponse({ ...limitOrder, left: 40 }, BTC).status, 'PARTIALLY_FILLED');
  assert.equal(gateOrderToBinanceResponse({ ...limitOrder, status: 'cancelled' }, BTC).status, 'CANCELED');
});

test('★ 条件单映射：触发价进 triggerPrice，close 语义进 closePosition', () => {
  const algo: GateFuturesOrder = {
    ...limitOrder,
    id: 777,
    size: -100,
    left: -100,
    price: '0',
    status: 'open',
    is_close: true,
    is_reduce_only: true,
    trigger: { price: '73650', rule: 2 },
  };
  const raw = gatePriceOrderToAlgoResponse(algo, BTC);
  assert.equal(raw.algoId, 777);
  assert.equal(raw.symbol, 'BTCUSDT');
  assert.equal(raw.side, 'SELL');
  assert.equal(raw.triggerPrice, '73650');
  assert.equal(raw.closePosition, true);
  assert.equal(raw.quantity, '0.01');
  assert.equal(raw.algoStatus, 'WORKING');
  assert.equal(raw.actualOrderId, undefined);
});

test('★★★ 价格保护单响应：契约/数量/价格在 initial 嵌套里（顶层没有）', () => {
  const priceOrder = {
    id: 555,
    contract: '',
    size: 0,
    left: 0,
    price: '0',
    status: 'open',
    create_time: '1700000000',
    initial: { contract: 'BTC_USDT', size: 100, price: '0', tif: 'ioc', reduce_only: false, close: true },
    trigger: { price: '72466', rule: 2 },
  } as unknown as GateFuturesOrder;
  const raw = gatePriceOrderToAlgoResponse(priceOrder, BTC);
  assert.equal(raw.symbol, 'BTCUSDT');
  assert.equal(raw.quantity, '0.01');
  assert.equal(raw.side, 'BUY');
  assert.equal(raw.closePosition, true);
  assert.equal(raw.triggerPrice, '72466');
});

test('成交映射：方向、数量换算、手续费、时间（秒→毫秒）', () => {
  const trade = gateFillToUserTrade(
    { id: 5, create_time: 1700000100, contract: 'BTC_USDT', size: -50, price: '70000', fee: '0.35' },
    BTC,
  );
  assert.equal(trade.symbol, 'BTCUSDT');
  assert.equal(trade.side, 'SELL');
  assert.equal(trade.qty, '0.005');
  assert.equal(trade.commission, '0.35');
  assert.equal(trade.commissionAsset, 'USDT');
  assert.equal(trade.time, 1700000100000);
});

test('流水映射：funding/fee/realised_pnl → 币安 incomeType', () => {
  assert.equal(gateBookToIncome({ time: 1, change: '-0.12', type: 'funding', contract: 'BTC_USDT' }).incomeType, 'FUNDING_FEE');
  assert.equal(gateBookToIncome({ time: 1, change: '-0.5', type: 'fee', contract: 'BTC_USDT' }).incomeType, 'COMMISSION');
  assert.equal(gateBookToIncome({ time: 1, change: '3.2', type: 'realised_pnl', contract: 'BTC_USDT' }).incomeType, 'REALIZED_PNL');
});

/** 记录请求的假 rest。 */
function fakeRest(): { rest: ConstructorParameters<typeof GateBroker>[0]; calls: Array<{ method: string; path: string; body?: unknown; params?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown; params?: unknown }> = [];
  const rest = {
    signed: async (method: string, path: string, options: { body?: unknown; params?: unknown } = {}) => {
      calls.push({ method, path, body: options.body, params: options.params });
      if (path === '/futures/usdt/orders') return { ...limitOrder, id: 1001 };
      if (path === '/futures/usdt/price_orders') return { ...limitOrder, id: 2002, trigger: { price: '73650', rule: 2 }, is_close: true, size: 100 };
      throw new Error(`unexpected ${method} ${path}`);
    },
    publicGet: async () => [],
  } as unknown as ConstructorParameters<typeof GateBroker>[0];
  return { rest, calls };
}

function fakeContracts(): ConstructorParameters<typeof GateBroker>[1] {
  return {
    get: async (name: string) => {
      if (name !== 'BTC_USDT') throw new Error(`unknown ${name}`);
      return BTC;
    },
    all: async () => new Map([[BTC.name, BTC]]),
  } as unknown as ConstructorParameters<typeof GateBroker>[1];
}

test('★★★ 市价下单：张数换算 + price=0 + tif=ioc', async () => {
  const { rest, calls } = fakeRest();
  const broker = new GateBroker(rest, fakeContracts());
  await broker.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.01 });
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(calls[0]!.path, '/futures/usdt/orders');
  assert.equal(body.size, 100);
  assert.equal(body.price, '0');
  assert.equal(body.tif, 'ioc');
});

test('限价下单：gtc + 显式价格 + 客户端单号', async () => {
  const { rest, calls } = fakeRest();
  const broker = new GateBroker(rest, fakeContracts());
  await broker.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'LIMIT',
    quantity: 0.01,
    price: 71000,
    reduceOnly: true,
    clientOrderId: 'aq-x',
  });
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.size, -100);
  assert.equal(body.price, '71000');
  assert.equal(body.tif, 'gtc');
  assert.equal(body.reduce_only, true);
  assert.equal(body.text, 'aq-x');
});

test('★★★ 条件单触发方向：多止损=下穿(2)、空止损=上穿(1)、多止盈=上穿(1)、空止盈=下穿(2)', async () => {
  const cases: Array<{ side: 'BUY' | 'SELL'; type: string; expectedRule: number }> = [
    { side: 'SELL', type: 'STOP_MARKET', expectedRule: 2 },
    { side: 'BUY', type: 'STOP_MARKET', expectedRule: 1 },
    { side: 'SELL', type: 'TAKE_PROFIT_MARKET', expectedRule: 1 },
    { side: 'BUY', type: 'TAKE_PROFIT_MARKET', expectedRule: 2 },
  ];
  for (const item of cases) {
    const { rest, calls } = fakeRest();
    const broker = new GateBroker(rest, fakeContracts());
    await broker.placeOrder({
      symbol: 'BTCUSDT',
      side: item.side,
      type: item.type as never,
      quantity: 0.01,
      triggerPrice: 73650,
      closePosition: true,
    });
    const body = calls[0]!.body as {
      trigger: { rule: number; price: string };
      initial: { close: boolean; reduce_only: boolean; size: number };
    };
    assert.equal(calls[0]!.path, '/futures/usdt/price_orders');
    /* 2026-11-11 测试网实测：close 单 size 必须是 0，否则 AUTO_INVALID_PARAM_INITIAL_SIZE。 */
    assert.equal(body.initial.size, 0, 'closePosition 条件单必须传 size=0');
    assert.equal(body.trigger.rule, item.expectedRule, `${item.side} ${item.type} 的触发方向错了`);
    assert.equal(body.trigger.price, '73650');
    assert.equal(body.initial.close, true);
    /* close 单：不传 reduce_only（close 与 reduce_only 互斥，Gate 只认 close 语义）。 */
    assert.equal(body.initial.reduce_only, false);
  }
});

test('撤单：普通单走 orders/{id}，条件单走 price_orders/{id}；已不存在视为成功', async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const rest = {
    signed: async (method: string, path: string) => {
      calls.push({ method, path });
      throw new Error('Gate API 失败（HTTP 404 · INVALID_ORDER）：order not found');
    },
    publicGet: async () => [],
  } as unknown as ConstructorParameters<typeof GateBroker>[0];
  const broker = new GateBroker(rest, fakeContracts());
  assert.equal(await broker.cancelOrder({ kind: 'order', id: '1' } as never), true);
  assert.equal(await broker.cancelOrder({ kind: 'algo', id: '2' } as never), true);
  assert.equal(calls[0]!.path, '/futures/usdt/orders/1');
  assert.equal(calls[1]!.path, '/futures/usdt/price_orders/2');
});

test('行情：mark_price 取自 tickers', async () => {
  const rest = {
    publicGet: async () => [{ contract: 'BTC_USDT', mark_price: '73959.9' }],
  } as unknown as ConstructorParameters<typeof GateBroker>[0];
  const broker = new GateBroker(rest, fakeContracts());
  assert.equal(await broker.getMarkPrice('BTCUSDT'), 73959.9);
});

test('isDryRun 恒为 false —— Gate 的模拟盘是测试网账户，不是本地模拟', () => {
  assert.equal(new GateBroker(fakeRest().rest, fakeContracts()).isDryRun, false);
});
