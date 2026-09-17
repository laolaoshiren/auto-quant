import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinanceBroker, normalizeAlgo, normalizeStandard } from './broker.js';
import { roundDownToStep, roundPrice, stepDecimals, SymbolRegistry } from './symbols.js';
import type { BinanceRest } from './rest.js';
import type { BinanceMarketData } from './market.js';
import type {
  BinanceAlgoOrderResponse,
  BinanceExchangeInfo,
  BinanceOrderResponse,
} from './types.js';

/* -------------------------------------------------------------------------- */
/*  Doubles                                                                    */
/* -------------------------------------------------------------------------- */

interface CapturedCall {
  method: string;
  path: string;
  params: Record<string, unknown>;
}

/**
 * A stand-in for `BinanceRest` that records every call instead of making it.
 *
 * The point of these tests is to assert *which endpoint and which parameter
 * names* the broker uses. Sending a conditional order to the wrong endpoint is
 * rejected by Binance with `-4120`, and the practical consequence is an open
 * position with no stop loss — so the routing decision is worth pinning down.
 */
function fakeRest(response: unknown = {}) {
  const calls: CapturedCall[] = [];
  const rest = {
    hasCredentials: true,
    usedWeight1m: 0,
    weightLimitPerMinute: 2400,
    baseUrl: 'https://fapi.binance.com',
    endpoints: { environment: 'production' },
    async syncTime() {
      return 0;
    },
    async publicGet(path: string, params: Record<string, unknown> = {}) {
      calls.push({ method: 'GET', path, params });
      return response;
    },
    async signedRequest(method: string, path: string, params: Record<string, unknown> = {}) {
      calls.push({ method, path, params });
      return Object.keys(params).length === 0 && response === undefined ? {} : response;
    },
    async keyedRequest(method: string, path: string, params: Record<string, unknown> = {}) {
      calls.push({ method, path, params });
      return response;
    },
  };
  return { rest: rest as unknown as BinanceRest, calls };
}

const fakeMarket = {
  async premiumIndex() {
    return [{ symbol: 'BTCUSDT', markPrice: '68000', indexPrice: '68000', lastFundingRate: '0.0001', nextFundingTime: 0, time: 0, estimatedSettlePrice: '0', interestRate: '0' }];
  },
  async ticker24h() {
    return [{ symbol: 'BTCUSDT', lastPrice: '68000' }];
  },
} as unknown as BinanceMarketData;

/** Minimal exchangeInfo with one symbol, enough to build a registry. */
function exchangeInfo(overrides: Partial<{ tickSize: string; stepSize: string; minNotional: string }> = {}): BinanceExchangeInfo {
  return {
    exchangeFilters: [],
    rateLimits: [],
    serverTime: 0,
    symbols: [
      {
        symbol: 'BTCUSDT',
        pair: 'BTCUSDT',
        contractType: 'PERPETUAL',
        deliveryDate: 0,
        status: 'TRADING',
        baseAsset: 'BTC',
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
          { filterType: 'PRICE_FILTER', tickSize: overrides.tickSize ?? '0.10' },
          { filterType: 'LOT_SIZE', stepSize: overrides.stepSize ?? '0.001', minQty: '0.001', maxQty: '1000' },
          { filterType: 'MIN_NOTIONAL', notional: overrides.minNotional ?? '50' },
        ],
      },
    ],
  };
}

function broker(response?: unknown) {
  const { rest, calls } = fakeRest(response);
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());
  return { broker: new BinanceBroker(rest, fakeMarket, registry), calls, registry };
}

/* -------------------------------------------------------------------------- */
/*  Endpoint routing — the -4120 hazard                                        */
/* -------------------------------------------------------------------------- */

test('MARKET orders go to /fapi/v1/order', async () => {
  const { broker: b, calls } = broker({
    orderId: 1, clientOrderId: 'c', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET',
    status: 'FILLED', avgPrice: '68000', executedQty: '0.01', origQty: '0.01',
    price: '0', cumQty: '0.01', cumQuote: '680', reduceOnly: false, positionSide: 'BOTH',
    stopPrice: '0', closePosition: false, timeInForce: 'GTC', origType: 'MARKET',
    updateTime: 0, workingType: 'MARK_PRICE', priceProtect: false,
  } satisfies BinanceOrderResponse);

  await b.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.01 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, '/fapi/v1/order');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.params.type, 'MARKET');
});

test('STOP_MARKET orders go to /fapi/v1/algoOrder, never /fapi/v1/order', async () => {
  const { broker: b, calls } = broker({
    algoId: 7, clientAlgoId: 'sl-1', algoType: 'CONDITIONAL', orderType: 'STOP_MARKET',
    symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', timeInForce: 'GTC',
    quantity: '0', algoStatus: 'NEW', triggerPrice: '64000', price: '0',
    closePosition: true, reduceOnly: false, workingType: 'MARK_PRICE', priceProtect: true,
    createTime: 0, updateTime: 0, triggerTime: 0,
  } satisfies BinanceAlgoOrderResponse);

  await b.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    triggerPrice: 64_000,
    closePosition: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, '/fapi/v1/algoOrder', 'conditional orders must use the Algo API');
  assert.equal(calls[0]!.params.algoType, 'CONDITIONAL');
  assert.equal(calls[0]!.params.triggerPrice, 64_000, 'the Algo API parameter is triggerPrice');
  assert.equal(calls[0]!.params.stopPrice, undefined, 'stopPrice is response-only now');
});

test('TAKE_PROFIT_MARKET orders also go to the Algo API', async () => {
  const { broker: b, calls } = broker({
    algoId: 8, clientAlgoId: 'tp-1', algoType: 'CONDITIONAL', orderType: 'TAKE_PROFIT_MARKET',
    symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', timeInForce: 'GTC',
    quantity: '0', algoStatus: 'NEW', triggerPrice: '74000', price: '0',
    closePosition: true, reduceOnly: false, workingType: 'MARK_PRICE', priceProtect: true,
    createTime: 0, updateTime: 0, triggerTime: 0,
  } satisfies BinanceAlgoOrderResponse);

  await b.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'TAKE_PROFIT_MARKET',
    triggerPrice: 74_000,
    closePosition: true,
  });

  assert.equal(calls[0]!.path, '/fapi/v1/algoOrder');
  assert.equal(calls[0]!.params.triggerPrice, 74_000);
});

test('closePosition strips quantity and reduceOnly, which Binance forbids combining', async () => {
  const { broker: b, calls } = broker({
    algoId: 9, clientAlgoId: 'sl-2', algoType: 'CONDITIONAL', orderType: 'STOP_MARKET',
    symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', timeInForce: 'GTC',
    quantity: '0', algoStatus: 'NEW', triggerPrice: '64000', price: '0',
    closePosition: true, reduceOnly: false, workingType: 'MARK_PRICE', priceProtect: true,
    createTime: 0, updateTime: 0, triggerTime: 0,
  } satisfies BinanceAlgoOrderResponse);

  await b.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    triggerPrice: 64_000,
    closePosition: true,
    quantity: 0.01,
    reduceOnly: true,
  });

  assert.equal(calls[0]!.params.closePosition, true);
  assert.equal(calls[0]!.params.quantity, undefined, 'quantity must not be sent with closePosition');
  assert.equal(calls[0]!.params.reduceOnly, undefined, 'reduceOnly must not be sent with closePosition');
});

test('a sized reduce-only conditional keeps its quantity', async () => {
  const { broker: b, calls } = broker({
    algoId: 10, clientAlgoId: 'tp-2', algoType: 'CONDITIONAL', orderType: 'TAKE_PROFIT_MARKET',
    symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', timeInForce: 'GTC',
    quantity: '0.005', algoStatus: 'NEW', triggerPrice: '74000', price: '0',
    closePosition: false, reduceOnly: true, workingType: 'MARK_PRICE', priceProtect: true,
    createTime: 0, updateTime: 0, triggerTime: 0,
  } satisfies BinanceAlgoOrderResponse);

  await b.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'TAKE_PROFIT_MARKET',
    triggerPrice: 74_000,
    quantity: 0.005,
    reduceOnly: true,
  });

  assert.equal(calls[0]!.params.quantity, 0.005);
  assert.equal(calls[0]!.params.reduceOnly, true);
  assert.equal(calls[0]!.params.closePosition, undefined);
});

/* -------------------------------------------------------------------------- */
/*  Cancellation must cover both identity spaces                               */
/* -------------------------------------------------------------------------- */

test('cancelAllOrders cancels regular AND algo orders', async () => {
  const { broker: b, calls } = broker({});

  await b.cancelAllOrders('BTCUSDT');

  const paths = calls.map((c) => c.path);
  assert.ok(paths.includes('/fapi/v1/allOpenOrders'), 'regular orders must be cancelled');
  assert.ok(
    paths.includes('/fapi/v1/algoOpenOrders'),
    'algo orders need their own endpoint — allOpenOrders does not touch them',
  );
});

test('cancelOrder targets the algo endpoint for an algo order', async () => {
  const { broker: b, calls } = broker({ code: '200', msg: 'success' });

  await b.cancelOrder('BTCUSDT', 42, 'algo');

  assert.equal(calls[0]!.path, '/fapi/v1/algoOrder');
  assert.equal(calls[0]!.method, 'DELETE');
  assert.equal(calls[0]!.params.algoId, 42);
});

/* -------------------------------------------------------------------------- */
/*  Normalisation                                                              */
/* -------------------------------------------------------------------------- */

test('normalizeStandard reports terminal state for a filled order', () => {
  const order = normalizeStandard({
    orderId: 1, clientOrderId: 'c', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET',
    status: 'FILLED', avgPrice: '68000', executedQty: '0.01', origQty: '0.01',
    price: '0', cumQty: '0.01', cumQuote: '680', reduceOnly: false, positionSide: 'BOTH',
    stopPrice: '0', closePosition: false, timeInForce: 'GTC', origType: 'MARKET',
    updateTime: 0, workingType: 'MARK_PRICE', priceProtect: false,
  } satisfies BinanceOrderResponse);

  assert.equal(order.kind, 'order');
  assert.equal(order.id, '1');
  assert.equal(order.avgPrice, 68_000);
  assert.equal(order.executedQty, 0.01);
  assert.equal(order.terminal, true);
});

test('an untriggered algo order is not terminal', () => {
  const order = normalizeAlgo({
    algoId: 5, clientAlgoId: 'sl', algoType: 'CONDITIONAL', orderType: 'STOP_MARKET',
    symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', timeInForce: 'GTC',
    quantity: '0', algoStatus: 'NEW', triggerPrice: '64000', price: '0',
    closePosition: true, reduceOnly: false, workingType: 'MARK_PRICE', priceProtect: true,
    createTime: 0, updateTime: 0, triggerTime: 0,
  } satisfies BinanceAlgoOrderResponse);

  assert.equal(order.kind, 'algo');
  assert.equal(order.status, 'NEW');
  assert.equal(order.terminal, false);
  assert.equal(order.executedQty, 0);
});

test('TRIGGERED is not terminal — the resulting order still has to fill', () => {
  const order = normalizeAlgo({
    algoId: 6, clientAlgoId: 'sl', algoType: 'CONDITIONAL', orderType: 'STOP_MARKET',
    symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', timeInForce: 'GTC',
    quantity: '0', algoStatus: 'TRIGGERED', triggerPrice: '64000', price: '0',
    closePosition: true, reduceOnly: false, workingType: 'MARK_PRICE', priceProtect: true,
    createTime: 0, updateTime: 0, triggerTime: 1, actualOrderId: '99', actualPrice: '63990', actualQty: '0.01',
  } satisfies BinanceAlgoOrderResponse);

  assert.equal(order.terminal, false);
  assert.equal(order.avgPrice, 63_990);
  assert.equal(order.executedQty, 0.01);
});

test('FINISHED is terminal for an algo order', () => {
  const order = normalizeAlgo({
    algoId: 6, clientAlgoId: 'sl', algoType: 'CONDITIONAL', orderType: 'STOP_MARKET',
    symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', timeInForce: 'GTC',
    quantity: '0', algoStatus: 'FINISHED', triggerPrice: '64000', price: '0',
    closePosition: true, reduceOnly: false, workingType: 'MARK_PRICE', priceProtect: true,
    createTime: 0, updateTime: 0, triggerTime: 1,
  } satisfies BinanceAlgoOrderResponse);

  assert.equal(order.terminal, true);
});

/* -------------------------------------------------------------------------- */
/*  Dry-run simulation                                                         */
/* -------------------------------------------------------------------------- */

function dryRunBroker() {
  const { rest, calls } = fakeRest({});
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());
  return {
    broker: new BinanceBroker(rest, fakeMarket, registry, { dryRun: true }),
    calls,
    registry,
  };
}

test('dry run fills a market order without ever calling a signed endpoint', async () => {
  const { broker: b, calls } = dryRunBroker();

  const placed = await b.placeOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'MARKET',
    quantity: 0.01,
  });

  assert.equal(placed.kind, 'order');
  assert.equal(placed.status, 'FILLED');
  assert.equal(placed.executedQty, 0.01);
  assert.equal(placed.avgPrice, 68_000, 'the simulated fill prices at the live mark price');
  assert.equal(placed.terminal, true);

  const signed = calls.filter((c) => c.path.startsWith('/fapi/v1/order'));
  assert.equal(signed.length, 0, 'dry run must not place real orders');
});

test('dry run leaves a conditional order resting, exactly like the real thing', async () => {
  const { broker: b } = dryRunBroker();

  const placed = await b.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    triggerPrice: 64_000,
    closePosition: true,
  });

  assert.equal(placed.kind, 'algo');
  assert.equal(placed.status, 'NEW');
  assert.equal(placed.terminal, false, 'an untriggered stop is not terminal');
  assert.equal(placed.executedQty, 0);
});

test('dry run leverage and cancellation succeed without touching the exchange', async () => {
  const { broker: b, calls } = dryRunBroker();

  const lev = await b.setLeverage('BTCUSDT', 5);
  assert.equal(lev.ok, true);
  await b.cancelAllOrders('BTCUSDT');

  assert.equal(calls.length, 0, 'no request may leave the process in dry-run mode');
  assert.equal(b.isDryRun, true);
});

/* -------------------------------------------------------------------------- */
/*  Trigger-price precision — the -1111 hazard                                 */
/* -------------------------------------------------------------------------- */

test('a trigger price is snapped to the symbol tick', () => {
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());
  // BTCUSDT tickSize is 0.10 in the fixture; a raw percentage-derived stop like
  // 67199.99999 is rejected by Binance with -1111 and the position is left
  // unprotected. This is the exact live failure.
  const trigger = registry.roundTriggerPrice('BTCUSDT', 67_199.999_99, 'STOP_MARKET', 'SELL', 68_000);
  assert.equal(trigger, 67_200);
  assert.equal(Number((trigger / 0.1).toFixed(6)) % 1, 0, 'must be an exact multiple of tickSize');
});

test('a trigger that rounds onto the market is stepped back to the safe side', () => {
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());
  // Rounding 68000.04 to the nearest tick lands on 68000.0, which is not
  // strictly below the mark, and Binance answers -2021.
  const trigger = registry.roundTriggerPrice('BTCUSDT', 68_000.04, 'STOP_MARKET', 'SELL', 68_000);
  assert.ok(trigger < 68_000, `stop must stay below the market, got ${trigger}`);
  assert.equal(Number((trigger / 0.1).toFixed(6)) % 1, 0);
});

test('a take-profit is kept above the market for a long', () => {
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());
  const trigger = registry.roundTriggerPrice('BTCUSDT', 68_000.02, 'TAKE_PROFIT_MARKET', 'SELL', 68_000);
  assert.ok(trigger > 68_000, `target must stay above the market, got ${trigger}`);
  assert.equal(Number((trigger / 0.1).toFixed(6)) % 1, 0);
});

test('trigger side semantics follow the order type and direction', () => {
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());

  // STOP: BUY triggers above, SELL below.
  assert.equal(registry.isValidTrigger(68_100, 'STOP_MARKET', 'BUY', 68_000), true);
  assert.equal(registry.isValidTrigger(68_100, 'STOP_MARKET', 'SELL', 68_000), false);
  // TAKE_PROFIT: BUY triggers below, SELL above.
  assert.equal(registry.isValidTrigger(67_900, 'TAKE_PROFIT_MARKET', 'BUY', 68_000), true);
  assert.equal(registry.isValidTrigger(67_900, 'TAKE_PROFIT_MARKET', 'SELL', 68_000), false);
  // Equality is never valid: the order would fire immediately.
  assert.equal(registry.isValidTrigger(68_000, 'STOP_MARKET', 'BUY', 68_000), false);
});

test('a buy limit does not round up and a sell limit does not round down', () => {
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());
  assert.equal(registry.roundLimitPrice('BTCUSDT', 68_000.07, 'down'), 68_000);
  assert.equal(registry.roundLimitPrice('BTCUSDT', 68_000.01, 'up'), 68_000.1);
});

test('the broker normalises quantity and trigger before sending', async () => {
  const { broker: b, calls } = broker({
    algoId: 11, clientAlgoId: 'sl', algoType: 'CONDITIONAL', orderType: 'STOP_MARKET',
    symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', timeInForce: 'GTC',
    quantity: '0', algoStatus: 'NEW', triggerPrice: '67200', price: '0',
    closePosition: true, reduceOnly: false, workingType: 'MARK_PRICE', priceProtect: true,
    createTime: 0, updateTime: 0, triggerTime: 0,
  } satisfies BinanceAlgoOrderResponse);

  await b.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    triggerPrice: 67_199.999_99,
    closePosition: true,
  });

  const sent = calls.find((c) => c.path === '/fapi/v1/algoOrder');
  assert.ok(sent, 'the algo endpoint must be called');
  assert.equal(sent.params.triggerPrice, 67_200, 'triggerPrice must be tick-aligned before sending');
});

test('the broker refuses a trigger that would fire immediately', async () => {
  const { broker: b, calls } = broker({});

  await assert.rejects(
    () =>
      b.placeOrder({
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'STOP_MARKET',
        triggerPrice: 70_000, // above the 68 000 mark: wrong side for a sell stop
        closePosition: true,
      }),
    /会立即触发/,
  );
  assert.equal(
    calls.filter((c) => c.path === '/fapi/v1/algoOrder').length,
    0,
    'nothing may be sent when the trigger is invalid',
  );
});

test('the broker floors an over-precise quantity before sending', async () => {
  const { broker: b, calls } = broker({
    orderId: 1, clientOrderId: 'c', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET',
    status: 'FILLED', avgPrice: '68000', executedQty: '0.014', origQty: '0.014',
    price: '0', cumQty: '0.014', cumQuote: '952', reduceOnly: false, positionSide: 'BOTH',
    stopPrice: '0', closePosition: false, timeInForce: 'GTC', origType: 'MARKET',
    updateTime: 0, workingType: 'MARK_PRICE', priceProtect: false,
  } satisfies BinanceOrderResponse);

  await b.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.0147 });

  const sent = calls.find((c) => c.path === '/fapi/v1/order');
  assert.equal(sent?.params.quantity, 0.014, 'quantity must be floored to stepSize 0.001');
});

/* -------------------------------------------------------------------------- */
/*  Filter rounding                                                            */
/* -------------------------------------------------------------------------- */

test('stepDecimals reads the precision implied by a step string', () => {
  assert.equal(stepDecimals('0.001'), 3);
  assert.equal(stepDecimals('0.10'), 1);
  assert.equal(stepDecimals('1'), 0);
  assert.equal(stepDecimals('10'), 0);
  assert.equal(stepDecimals('1.000'), 0);
  assert.equal(stepDecimals('0.00001'), 5);
});

test('quantities are floored, never rounded up', () => {
  // Rounding up would request more than the account can afford (-2019).
  assert.equal(roundDownToStep(0.0079999, 0.001, 3), 0.007);
  assert.equal(roundDownToStep(0.0071, 0.001, 3), 0.007);
  assert.equal(roundDownToStep(1.0, 0.1, 1), 1);
  assert.equal(roundDownToStep(0.2999, 0.1, 1), 0.2, 'a genuinely smaller quantity must floor down');
});

test('floating-point artefacts do not cost a whole lot step', () => {
  // 0.3 / 0.1 evaluates to 2.9999999999999996 in binary floating point. Flooring
  // that naively would round 0.3 down to 0.2 — an entire step lost to a rounding
  // artefact, on every single order. The tiny epsilon in roundDownToStep absorbs
  // this deliberately; it is far below any real exchange lot granularity.
  assert.equal(roundDownToStep(0.3, 0.1, 1), 0.3);
  assert.equal(roundDownToStep(0.7, 0.1, 1), 0.7);
  assert.equal(roundDownToStep(2.1, 0.1, 1), 2.1);
  assert.equal(roundDownToStep(0.06, 0.01, 2), 0.06);
});

test('prices round toward the requested direction', () => {
  assert.equal(roundPrice(64_000.07, 0.1, 1, 'nearest'), 64_000.1);
  assert.equal(roundPrice(64_000.07, 0.1, 1, 'down'), 64_000.0);
  assert.equal(roundPrice(64_000.01, 0.1, 1, 'up'), 64_000.1);
});

test('the registry floors a notional into a tradable quantity', () => {
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());
  // 1000 / 68000 = 0.01470588…, floored to the 0.001 step.
  assert.equal(registry.notionalToQuantity('BTCUSDT', 1000, 68_000), 0.014);
});

test('the registry returns zero when the notional is below one lot', () => {
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());
  assert.equal(registry.notionalToQuantity('BTCUSDT', 1, 68_000), 0);
});

test('the registry exposes the per-symbol minimum notional from exchangeInfo', () => {
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());
  assert.equal(registry.minNotional('BTCUSDT'), 50, 'MIN_NOTIONAL is per-symbol, not a constant 5');
});

test('the registry normalises loosely written symbols', () => {
  const registry = SymbolRegistry.fromExchangeInfo(exchangeInfo());
  assert.ok(registry.get('btc/usdt'));
  assert.ok(registry.get('BTC-USDT'));
  assert.ok(registry.get('btcusdt'));
  assert.equal(registry.get('BTCUSDT.P')?.symbol, 'BTCUSDT');
  assert.equal(registry.get('NOPEUSDT'), undefined);
});

test('only USDT-margined perpetuals enter the registry', () => {
  const info = exchangeInfo();
  info.symbols.push({
    ...info.symbols[0]!,
    symbol: 'BTCUSDT_250627',
    contractType: 'CURRENT_QUARTER',
  });
  info.symbols.push({
    ...info.symbols[0]!,
    symbol: 'BTCUSD_PERP',
    quoteAsset: 'USD',
  });
  const registry = SymbolRegistry.fromExchangeInfo(info);
  assert.equal(registry.size, 1, 'delivery futures and non-USDT quotes must be excluded');
  assert.ok(registry.get('BTCUSDT'));
  assert.equal(registry.get('BTCUSDT_250627'), undefined);
  assert.equal(registry.get('BTCUSD_PERP'), undefined);
});

/* -------------------------------------------------------------------------- */
/*  取整之后的名义价值 —— -4164 的那个坑                                        */
/* -------------------------------------------------------------------------- */

test('取整后名义跌破交易所下限时，本地拒绝并说清三个数字', async () => {
  /*
   * 实测撞到过：模型提议名义 6 USDT、风控校验「6 ≥ 5」通过，
   * 而按步长向下取整之后真正发出去的名义已经低于 5 —— 交易所拒单：
   * `-4164 Order's notional must be no smaller than 5`。
   *
   * **风控只保证方向与量级，不保证精度** —— 同样的道理在类注释里
   * 已经为触发价写过一次。这个用例把它钉在名义价值上。
   *
   * 为什么本地判定比让交易所拒绝更重要：`-4164` 看不出是取整造成的，
   * 也看不出差多少。这里把实际名义、下限、步长一次说清。
   */
  const registry = SymbolRegistry.fromExchangeInfo(
    exchangeInfo({ stepSize: '1', minNotional: '50' }),
  );
  const { rest, calls } = fakeRest({ orderId: 1 });
  const b = new BinanceBroker(rest, fakeMarket, registry);

  // 数量 0.7 → 按步长 1 向下取整为 0……那就先撞到"取整为 0"。
  // 改用数量 1.7 → 取整为 1，价格 40 → 名义 40 < 50。
  await assert.rejects(
    () => b.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1.7, price: 40 }),
    (err: Error) => {
      assert.match(err.message, /名义价值不足/, '要说清是名义价值的问题');
      assert.match(err.message, /40/, '要有实际名义');
      assert.match(err.message, /50/, '要有交易所下限');
      return true;
    },
  );
  assert.equal(calls.length, 0, '本地就该拒绝，不能把注定失败的订单发出去');
});

test('取整后名义达标时正常放行', async () => {
  const registry = SymbolRegistry.fromExchangeInfo(
    exchangeInfo({ stepSize: '1', minNotional: '50' }),
  );
  const { rest, calls } = fakeRest({ orderId: 1 });
  const b = new BinanceBroker(rest, fakeMarket, registry);

  // 数量 2 → 取整仍为 2，价格 40 → 名义 80 ≥ 50
  await b.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 2, price: 40 });
  assert.equal(calls.length, 1, '达标的订单必须能发出去');
});

test('closePosition 的单一律豁免 —— 拒掉止损单会让仓位失去保护', async () => {
  /*
   * ⚠️ 这条比上面两条更要紧，方向相反。
   *
   * 币安那句「unless you choose reduce only」就是这个意思：`closePosition: true`
   * 的条件单只用于平掉既有仓位，**不受名义下限约束**。
   *
   * 我们的止损/止盈正是这么挂的。如果这个检查把它们一起拒掉，
   * **仓位会失去保护** —— 那是 §2.6 说的最糟状态，
   * 比「名义太小下不出去」严重得多。
   */
  const registry = SymbolRegistry.fromExchangeInfo(
    exchangeInfo({ stepSize: '1', minNotional: '50', tickSize: '0.10' }),
  );
  const { rest, calls } = fakeRest({ orderId: 1 });
  const b = new BinanceBroker(rest, fakeMarket, registry);

  // 名义 1 × 40 = 40 < 50，但因为是 closePosition，必须放行
  await b.placeOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    quantity: 1,
    triggerPrice: 40,
    closePosition: true,
  });
  assert.equal(calls.length, 1, 'closePosition 的止损单不得被名义检查拦下');
});
