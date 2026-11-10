/**
 * **Gate 合约 → 同步 `SymbolRegistry` 适配**（阶段 2 放开交易循环的关键一步）。
 *
 * ## 为什么这个测试存在
 *
 * 交易循环的取整/最小名义/数量换算只认 `binance/symbols.ts` 的 `SymbolRegistry`。
 * Gate 的原始数据是"张数 + quanto_multiplier"（1 张 BTC_USDT = 0.0001 BTC），
 * 映射错一位的表现是**所有数量差 10000 倍**（或者止损触发价取整成 0、永远挂不上），
 * 而运行时不会抛错 —— 只会静默下错单。所以这里把换算口径逐项钉死。
 *
 * ## 夹具来源
 *
 * 合约字段取自 **2026-11-11 Gate 测试网实测响应**（`/futures/usdt/contracts`），
 * 只保留构建注册表用到的字段。特别地：实测里 `order_size_min` 是**数字 1**
 *（不是字符串），而且**没有 `order_size_step` 字段** —— 张数恒为整数。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { SymbolInfo } from '@aq/shared';
import { GateContractRegistry } from './account.js';
import {
  buildGateSymbolRegistry,
  gateContractInfoToSymbolInfo,
  splitGateContractName,
} from './symbols.js';
import { toGateContractInfo, type GateContractInfo } from './market.js';
import type { GateRest } from './rest.js';

/* -------------------------------------------------------------------------- */
/*  Fixtures（实测截断，2026-11-11 测试网）                                       */
/* -------------------------------------------------------------------------- */

const CONTRACTS = [
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
  {
    /* 1 张 = 0.01 ETH —— 用来验证"不同 multiplier 下步长/精度都跟着变"。 */
    name: 'ETH_USDT',
    status: 'trading',
    in_delisting: false,
    quanto_multiplier: '0.01',
    order_price_round: '0.01',
    order_size_min: 1,
    order_size_max: 100000,
    leverage_max: '100',
    taker_fee_rate: '0.00075',
    maker_fee_rate: '-0.0001',
    funding_next_apply: 1794355200,
    interest_rate: '0.0003',
    position_size: 1000,
  },
  {
    /* 已下线的合约 —— 不得进入可交易名单。 */
    name: 'OLD_USDT',
    status: 'delisted',
    in_delisting: true,
    quanto_multiplier: '1',
    order_price_round: '0.001',
    order_size_min: 1,
    order_size_max: 1000,
    leverage_max: '10',
    funding_next_apply: 0,
    interest_rate: '0',
    position_size: 0,
  },
  {
    /* 坏合约：没有价格精度 —— 必须被排除（tickSize=0 会让所有取整变 0）。 */
    name: 'BROKEN_USDT',
    status: 'trading',
    in_delisting: false,
    quanto_multiplier: '1',
    order_price_round: '',
    order_size_min: 1,
    order_size_max: 10,
    leverage_max: '5',
  },
];

function fakeRest(contracts: unknown = CONTRACTS) {
  const calls: string[] = [];
  const rest = {
    publicGet: async (path: string) => {
      calls.push(path);
      return contracts;
    },
  } as unknown as GateRest;
  return { rest, calls };
}

/* -------------------------------------------------------------------------- */
/*  纯映射                                                                      */
/* -------------------------------------------------------------------------- */

test('★★★ 合约名拆分：BTC_USDT → BTC / USDT；1000PEPE_USDT → 1000PEPE / USDT', () => {
  assert.deepEqual(splitGateContractName('BTC_USDT'), { baseAsset: 'BTC', quoteAsset: 'USDT' });
  assert.deepEqual(splitGateContractName('1000PEPE_USDT'), {
    baseAsset: '1000PEPE',
    quoteAsset: 'USDT',
  });
  assert.deepEqual(splitGateContractName('ETHBTC'), { baseAsset: 'ETHBTC', quoteAsset: 'USDT' });
});

test('★★★ 单合约映射：tick/步长/最小量全部按"张数 × 面值"换算成币数', () => {
  const info = toGateContractInfo(CONTRACTS[0] as never);
  const symbolInfo = gateContractInfoToSymbolInfo(info);
  assert.ok(symbolInfo);

  assert.equal(symbolInfo!.symbol, 'BTCUSDT', '符号必须去掉下划线');
  assert.equal(symbolInfo!.baseAsset, 'BTC');
  assert.equal(symbolInfo!.quoteAsset, 'USDT');
  assert.equal(symbolInfo!.tickSize, 0.1, 'order_price_round → tickSize');
  assert.equal(symbolInfo!.stepSize, 0.0001, '1 张步长 × 0.0001 = 0.0001 币');
  assert.equal(symbolInfo!.minQty, 0.0001);
  assert.equal(symbolInfo!.maxQty, 1_000_000 * 0.0001);
  assert.equal(symbolInfo!.pricePrecision, 1);
  assert.equal(symbolInfo!.quantityPrecision, 4);
  assert.equal(symbolInfo!.contractSize, 1, '本系统数量是币数；张数换算在 broker 内部');
  /* 任务约定的口径：minNotional = 最小张数 × 面值（量纲是币数，只可能更宽松）。 */
  assert.equal(symbolInfo!.minNotional, 0.0001);
});

test('★★ 不同 quanto_multiplier → 步长/精度跟着走（ETH：1 张 = 0.01 ETH）', () => {
  const info = toGateContractInfo({
    name: 'ETH_USDT',
    quanto_multiplier: '0.01',
    order_price_round: '0.01',
    order_size_min: 2,
    order_size_max: 500,
  } as never);
  const symbolInfo = gateContractInfoToSymbolInfo(info);
  assert.ok(symbolInfo);
  assert.equal(symbolInfo!.tickSize, 0.01);
  assert.equal(symbolInfo!.stepSize, 0.01, '1 张 = 0.01 ETH');
  assert.equal(symbolInfo!.minQty, 0.02, '最小 2 张 = 0.02 ETH');
  assert.equal(symbolInfo!.maxQty, 5, '最大 500 张 = 5 ETH');
  assert.equal(symbolInfo!.pricePrecision, 2);
  assert.equal(symbolInfo!.quantityPrecision, 2);
});

test('★★★ 精度不可用的合约返回 null（绝不拿 tickSize=0 去下单）', () => {
  const broken: GateContractInfo = {
    ...toGateContractInfo(CONTRACTS[0] as never),
    contract: 'BROKEN_USDT',
    symbol: 'BROKENUSDT',
    priceTick: 0,
  };
  assert.equal(gateContractInfoToSymbolInfo(broken), null);

  const noMultiplier: GateContractInfo = {
    ...toGateContractInfo(CONTRACTS[0] as never),
    quantoMultiplier: 0,
  };
  assert.equal(gateContractInfoToSymbolInfo(noMultiplier), null);
});

/* -------------------------------------------------------------------------- */
/*  注册表构建                                                                  */
/* -------------------------------------------------------------------------- */

test('★★★ 构建注册表：复用币安取整逻辑、排除下线合约与坏合约', async () => {
  const { rest } = fakeRest();
  const contracts = new GateContractRegistry(rest);
  const registry = await buildGateSymbolRegistry(contracts);

  assert.equal(registry.size, 2, 'OLD（下线）与 BROKEN（精度 0）都不得进入名单');
  assert.deepEqual(registry.symbols().sort(), ['BTCUSDT', 'ETHUSDT']);
  assert.throws(() => registry.require('OLDUSDT'), /Unknown or non-tradable futures symbol/);

  /*
   * **复用币安取整逻辑**的具体证据：注册表自身的 `roundQuantity` /
   * `roundTriggerPrice` 直接生效，且按 Gate 的步长/跳数取整。
   */
  const btc = registry.require('BTCUSDT');
  assert.equal(btc.stepSize, 0.0001);
  /* 0.00015 向下取整到 0.0001（1 张），而不是原样保留。 */
  assert.equal(registry.roundQuantity('BTCUSDT', 0.00015), 0.0001);
  /* 低于最小张数 → 0（调用方据此拒单，不会下 0 张单）。 */
  assert.equal(registry.roundQuantity('BTCUSDT', 0.00005), 0);
  /* 触发价按 tickSize=0.1 取整，并保持"止损在下方"的方向。 */
  const trigger = registry.roundTriggerPrice('BTCUSDT', 73_650.04, 'STOP_MARKET', 'SELL', 73_650);
  assert.equal(Number((trigger / 0.1).toFixed(6)) % 1, 0, '触发价必须是 tickSize 的整数倍');
  assert.ok(trigger < 73_650, `止损必须留在市价下方：${trigger}`);
});

test('★★ 构建注册表：可注入 GateMarket（复用行情层的合约映射，只有一份转换）', async () => {
  const { rest, calls } = fakeRest();
  const contracts = new GateContractRegistry(rest);
  const marketLike = {
    contractInfos: async () => (await Promise.resolve([CONTRACTS[0], CONTRACTS[1]]))
      .map((raw) => toGateContractInfo(raw as never)),
  } as unknown as Parameters<typeof buildGateSymbolRegistry>[1];

  const registry = await buildGateSymbolRegistry(contracts, marketLike);
  assert.equal(registry.size, 2);
  assert.equal(calls.length, 0, '走 market 路径时不该重复请求合约列表');
});

test('★★★ 合约列表为空 → 抛错（绝不用空注册表启动交易循环）', async () => {
  const { rest } = fakeRest([]);
  const contracts = new GateContractRegistry(rest);
  await assert.rejects(
    () => buildGateSymbolRegistry(contracts),
    (error: Error) => /可交易合约数为 0/.test(error.message),
  );
});

test('★ 注册表的 SymbolInfo 形状可直接喂给现有币安取整函数（类型级）', async () => {
  const { rest } = fakeRest();
  const registry = await buildGateSymbolRegistry(new GateContractRegistry(rest));
  const info: SymbolInfo = registry.require('BTCUSDT');
  assert.equal(typeof info.tickSize, 'number');
  assert.equal(typeof info.minNotional, 'number');
});
