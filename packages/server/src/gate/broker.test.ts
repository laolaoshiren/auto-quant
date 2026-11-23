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
import type { BrokerPort } from '../trader/brokerPort.js';

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

test('订单映射：部分成交 → PARTIALLY_FILLED；已撤（status=cancelled 或 status=finished+finish_as=cancelled/ioc）→ CANCELED', () => {
  assert.equal(gateOrderToBinanceResponse({ ...limitOrder, left: 40 }, BTC).status, 'PARTIALLY_FILLED');
  assert.equal(gateOrderToBinanceResponse({ ...limitOrder, status: 'cancelled' }, BTC).status, 'CANCELED');
  /* Gate v4 真实撤单与 IOC 未成交均返回 status="finished" + finish_as="cancelled"/"ioc"。 */
  assert.equal(
    gateOrderToBinanceResponse({ ...limitOrder, status: 'finished', finish_as: 'cancelled', left: 100 }, BTC).status,
    'CANCELED',
  );
  assert.equal(
    gateOrderToBinanceResponse({ ...limitOrder, price: '0', status: 'finished', finish_as: 'ioc', left: 100 }, BTC).status,
    'CANCELED',
  );
  assert.equal(
    gateOrderToBinanceResponse({ ...limitOrder, status: 'finished', finish_as: 'liquidated', left: 100 }, BTC).status,
    'EXPIRED',
  );
});

test('★ 条件单映射：触发价进 triggerPrice，close 语义进 closePosition，状态为合法 BinanceAlgoStatus', () => {
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
  assert.equal(raw.algoStatus, 'NEW', '必须用合法 BinanceAlgoStatus NEW，不再强转非法的 WORKING');
  assert.equal(raw.actualOrderId, undefined);

  /* Gate 条件单撤销后 status="finished" + finish_as="cancelled" → 单 L 的 CANCELED。 */
  const cancelledAlgo = gatePriceOrderToAlgoResponse(
    { ...algo, status: 'finished', finish_as: 'cancelled', finish_time: '1700000100' },
    BTC,
  );
  assert.equal(cancelledAlgo.algoStatus, 'CANCELED');
  assert.equal(cancelledAlgo.actualOrderId, undefined, '撤销的条件单不得填 actualOrderId');

  const expiredAlgo = gatePriceOrderToAlgoResponse({ ...algo, status: 'finished', finish_as: 'expired' }, BTC);
  assert.equal(expiredAlgo.algoStatus, 'EXPIRED');
  const failedAlgo = gatePriceOrderToAlgoResponse({ ...algo, status: 'finished', finish_as: 'failed' }, BTC);
  assert.equal(failedAlgo.algoStatus, 'REJECTED');
});

test('★★★ 条件单重启无状态恢复：按 initial.text 前缀区分止盈/止损，closePosition(size=0) 正确反推平空 BUY', () => {
  const shortStop: GateFuturesOrder = {
    id: 881,
    contract: '',
    size: 0,
    left: 0,
    price: '0',
    status: 'open',
    create_time: '1700000000',
    initial: { contract: 'BTC_USDT', size: 0, price: '0', tif: 'ioc', reduce_only: false, close: true, text: 't-sl-abc123' },
    trigger: { price: '75000', rule: 1 },
  };
  const shortTp: GateFuturesOrder = {
    id: 882,
    contract: '',
    size: 0,
    left: 0,
    price: '0',
    status: 'open',
    create_time: '1700000000',
    initial: { contract: 'BTC_USDT', size: 0, price: '0', tif: 'ioc', reduce_only: false, close: true, text: 't-tp-abc123' },
    trigger: { price: '68000', rule: 2 },
  };
  const stopMapped = gatePriceOrderToAlgoResponse(shortStop, BTC);
  assert.equal(stopMapped.orderType, 'STOP_MARKET');
  assert.equal(stopMapped.side, 'BUY', '空头止损 rule=1 + size=0 必须反推出 BUY');
  assert.equal(stopMapped.clientAlgoId, 't-sl-abc123');

  const tpMapped = gatePriceOrderToAlgoResponse(shortTp, BTC);
  assert.equal(tpMapped.orderType, 'TAKE_PROFIT_MARKET', '重启无内存 Map 时仍须识别为止盈单，不可当成止损');
  assert.equal(tpMapped.side, 'BUY', '空头止盈 rule=2 + size=0 必须反推出 BUY');
  assert.equal(tpMapped.clientAlgoId, 't-tp-abc123');
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

test('成交映射：方向、数量换算、手续费、时间（秒→毫秒）且 realizedPnl 留空串交由 roundTrips 按均价核算', () => {
  const trade = gateFillToUserTrade(
    { id: 5, create_time: 1700000100, contract: 'BTC_USDT', size: -50, price: '70000', fee: '0.35' },
    BTC,
  );
  assert.equal(trade.symbol, 'BTCUSDT');
  assert.equal(trade.side, 'SELL');
  assert.equal(trade.qty, '0.005');
  assert.equal(trade.commission, '0.35');
  assert.equal(trade.commissionAsset, 'USDT');
  assert.equal(trade.realizedPnl, '', 'Gate 成交行不含 realizedPnl，必须留空串而非 "0" 以防覆写清零账本');
  assert.equal(trade.time, 1700000100000);
});

test('★★★ 流水映射：Gate v4 官方枚举 fund→FUNDING_FEE / pnl→REALIZED_PNL / dnw→TRANSFER / fee→COMMISSION', () => {
  assert.equal(gateBookToIncome({ time: 1, change: '-0.12', type: 'fund', contract: 'BTC_USDT' }).incomeType, 'FUNDING_FEE');
  assert.equal(gateBookToIncome({ time: 1, change: '3.2', type: 'pnl', contract: 'BTC_USDT' }).incomeType, 'REALIZED_PNL');
  assert.equal(gateBookToIncome({ time: 1, change: '100', type: 'dnw' }).incomeType, 'TRANSFER');
  assert.equal(gateBookToIncome({ time: 1, change: '-0.5', type: 'fee', contract: 'BTC_USDT' }).incomeType, 'COMMISSION');
  /* 历史别名保持兼容 */
  assert.equal(gateBookToIncome({ time: 1, change: '-0.12', type: 'funding', contract: 'BTC_USDT' }).incomeType, 'FUNDING_FEE');
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
  /* Gate 要求自定义单号以 `t-` 开头（实测 400 INVALID_PARAM_VALUE）。 */
  assert.equal(body.text, 't-aq-x');
});

test('★★★ 触发价必须按 order_price_round 取整（实测浮点长尾被 Gate 400 拒）', async () => {
  const { rest, calls } = fakeRest();
  const broker = new GateBroker(rest, fakeContracts());
  /* 2026-11-11 线上真实坏价格：69.02236585365898（浮点长尾）。BTC 的 tick 是 0.1。 */
  await broker.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    quantity: 0.001,
    triggerPrice: 69.02236585365898,
    closePosition: true,
  });
  const body = calls[0]!.body as { trigger: { price: string } };
  assert.equal(body.trigger.price, '69', '应取整到 tick 0.1 的整数倍');

  /* 第二个真实坏价格：74.4715000000005 → 74.5 */
  await broker.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'TAKE_PROFIT_MARKET',
    quantity: 0.001,
    triggerPrice: 74.4715000000005,
    closePosition: true,
  });
  const body2 = calls[1]!.body as { trigger: { price: string } };
  assert.equal(body2.trigger.price, '74.5');
});

test('★★★ 客户端单号：t- 前缀 + 总长 ≤ 30（Gate 实测限长 30）', async () => {
  const { rest, calls } = fakeRest();
  const broker = new GateBroker(rest, fakeContracts());
  /* 币安侧 makeClientId 生成 36 字符，直接传会被 Gate 拒。 */
  const longId = 'entry-abc123xyz-ETHUSDT-0123456789ab';
  await broker.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.01, clientOrderId: longId });
  const body = calls[0]!.body as Record<string, unknown>;
  const text = String(body.text);
  assert.ok(text.startsWith('t-'), '必须以 t- 开头');
  assert.ok(text.length <= 30, `长度应 ≤30，实际 ${text.length}`);
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
  /*
   * 参数形状必须与 `BrokerPort`（= BinanceBroker）一致：`(symbol, orderId, kind)`。
   * 交易循环的撤单调用点手里只有单号、没有 PlacedOrder —— 旧的 `(order)` 形状
   * 会让 `connection.broker` 无法当 BrokerPort 用（阶段 2 接入时才暴露）。
   */
  assert.equal(await broker.cancelOrder('BTCUSDT', '1', 'order'), true);
  assert.equal(await broker.cancelOrder('BTCUSDT', '2', 'algo'), true);
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

test('★★★ 持仓模式查询走账户响应的 in_dual_mode（Gate 没有 GET dual_mode —— 实测 405）', async () => {
  const paths: string[] = [];
  const rest = {
    signed: async (_method: string, path: string) => {
      paths.push(path);
      if (path === '/futures/usdt/accounts') {
        return { total: '100', unrealised_pnl: '0', available: '100', in_dual_mode: true };
      }
      throw new Error(`unexpected ${path}`);
    },
    publicGet: async () => [],
  } as unknown as ConstructorParameters<typeof GateBroker>[0];
  const broker = new GateBroker(rest, fakeContracts());
  assert.equal(await broker.isHedgeMode(), true);
  assert.ok(paths.every((p) => !p.includes('dual_mode')), '不得请求 GET dual_mode（那个端点不存在，405）');
});

test('持仓模式读取失败 → 按单向处理（不让机器人整轮停摆）', async () => {
  const rest = {
    signed: async () => {
      throw new Error('Gate API GET /futures/usdt/accounts 失败（HTTP 500）');
    },
    publicGet: async () => [],
  } as unknown as ConstructorParameters<typeof GateBroker>[0];
  assert.equal(await new GateBroker(rest, fakeContracts()).isHedgeMode(), false);
});

test('isDryRun 恒为 false —— Gate 的模拟盘是测试网账户，不是本地模拟', () => {
  assert.equal(new GateBroker(fakeRest().rest, fakeContracts()).isDryRun, false);
});

/* -------------------------------------------------------------------------- */
/*  与 BrokerPort 的形状对齐（阶段 2 放开交易循环的前置条件）                      */
/* -------------------------------------------------------------------------- */

test('★★★ GateBroker 必须满足 BrokerPort（否则 connection.broker 不能直接喂给 AutoTrader）', () => {
  /*
   * Why this test exists：`BrokerPort = Pick<BinanceBroker, 19 方法>`，交易循环按它
   * 调用 broker。GateBroker 只要有一个方法签名对不上，`connection.broker` 就无法
   * 赋值给 `AutoTrader` 的 `broker` —— 阶段 2 放开启动时 typecheck 直接红。
   *
   * 这条是**编译期**断言（`tsc` 负责判），运行时开销为零；写在这里是为了让
   * "形状对齐"成为可被单个测试文件发现的事实，而不是等到 manager 集成才暴露。
   * 实际暴露过的两处：`setLeverage` 返回 boolean（应为 {ok,leverage}）、
   * `cancelOrder(order)`（应为 `(symbol, orderId, kind)`）。
   */
  const broker: BrokerPort = new GateBroker(fakeRest().rest, fakeContracts());
  void broker;
});

test('★★ setLeverage 采用全仓 leverage=0 + cross_leverage_limit，并返回 { ok, leverage }', async () => {
  const calls: Array<{ path: string; params?: unknown }> = [];
  const rest = {
    signed: async (_method: string, path: string, options?: { params?: unknown }) => {
      calls.push({ path, ...(options === undefined ? {} : { params: options.params }) });
      return { leverage: '0', cross_leverage_limit: '8' };
    },
  } as unknown as ConstructorParameters<typeof GateBroker>[0];
  const broker = new GateBroker(rest, fakeContracts());

  const result = await broker.setLeverage('BTCUSDT', 10);
  assert.deepEqual(result, { ok: true, leverage: 8 }, '必须回传交易所实际给的全仓杠杆上限');
  assert.equal(calls[0]!.path, '/futures/usdt/positions/BTC_USDT/leverage');
  assert.deepEqual(calls[0]!.params, { leverage: '0', cross_leverage_limit: '10' });
});

test('★★★ getUserTrades 必须按时间升序返回（抵消 Gate my_trades 默认倒序）', async () => {
  const rest = {
    signed: async () => [
      { id: 20, create_time: 1700000200, contract: 'BTC_USDT', size: -10, price: '71000', fee: '0.1' },
      { id: 10, create_time: 1700000100, contract: 'BTC_USDT', size: 10, price: '70000', fee: '0.1' },
    ],
  } as unknown as ConstructorParameters<typeof GateBroker>[0];
  const broker = new GateBroker(rest, fakeContracts());
  const fills = await broker.getUserTrades('BTCUSDT', 20);
  assert.equal(fills[0]!.id, 10);
  assert.equal(fills[1]!.id, 20);
});

test('★★★ placeConditional 止盈单返回 TAKE_PROFIT_MARKET 且 trigger 用 strategy_type + price_type=1', async () => {
  const { rest, calls } = fakeRest();
  const broker = new GateBroker(rest, fakeContracts());
  const placed = await broker.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'TAKE_PROFIT_MARKET',
    quantity: 0.01,
    triggerPrice: 75000,
    closePosition: true,
    clientOrderId: 'tp-abc',
  });
  const body = calls[0]!.body as {
    initial: { text: string };
    trigger: { strategy_type: number; price_type: number };
  };
  assert.equal((placed.raw as { orderType: string }).orderType, 'TAKE_PROFIT_MARKET');
  assert.ok(body.initial.text.startsWith('t-tp-'));
  assert.equal(body.trigger.strategy_type, 0);
  assert.equal(body.trigger.price_type, 1);
});

test('★★★ cancelOrder 失败返回 false；cancelAllOrders 失败必须抛错（对齐 BrokerPort 契约）', async () => {
  const rest = {
    signed: async () => {
      throw new Error('HTTP 500 internal error');
    },
  } as unknown as ConstructorParameters<typeof GateBroker>[0];
  const broker = new GateBroker(rest, fakeContracts());
  assert.equal(await broker.cancelOrder('BTCUSDT', '1', 'order'), false);
  await assert.rejects(() => broker.cancelAllOrders('BTCUSDT'));
});

test('★★ setLeverage 被交易所拒绝 → { ok:false, note }（本笔放弃，不拿未知杠杆开仓）', async () => {
  const rest = {
    signed: async () => {
      throw new Error('Gate API 失败（HTTP 400 · INVALID_LEVERAGE）：leverage exceeds limit');
    },
  } as unknown as ConstructorParameters<typeof GateBroker>[0];
  const broker = new GateBroker(rest, fakeContracts());

  const result = await broker.setLeverage('BTCUSDT', 20);
  assert.equal(result.ok, false);
  assert.equal(result.leverage, 0);
  assert.match(result.note ?? '', /INVALID_LEVERAGE/);
});

test('★★ getIncome 不传 endTime 时不能发出 NaN（接口可选性必须与币安一致）', async () => {
  /*
   * 交易循环多数调用点只传 `startTime`（`reconcileTradeHistory` / `fundingFor`）。
   * 若这里把 endTime 声明成必填、运行时直接除法，`Math.floor(undefined/1000)` = NaN
   * 会被 Gate 拒成 INVALID_PARAM —— 只在联调时暴露的接口不匹配。
   */
  const calls: Array<{ params?: Record<string, string> }> = [];
  const rest = {
    signed: async (_method: string, _path: string, options?: { params?: Record<string, string> }) => {
      calls.push({ ...(options?.params === undefined ? {} : { params: options.params }) });
      return [];
    },
  } as unknown as ConstructorParameters<typeof GateBroker>[0];
  const broker = new GateBroker(rest, fakeContracts());

  await broker.getIncome({ startTime: 1_700_000_000_000 });
  assert.ok(!/NaN/.test(JSON.stringify(calls[0]!.params)), `参数里不能有 NaN：${JSON.stringify(calls[0])}`);
  assert.equal(calls[0]!.params?.from, '1700000000');
  assert.ok(Number(calls[0]!.params?.to) > 0);
});
