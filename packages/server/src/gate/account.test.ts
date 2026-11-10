import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GateAccountReader,
  GateContractRegistry,
  gateContractToSymbol,
  mapBalance,
  mapPosition,
  num,
  symbolToGateContract,
} from './account.js';
import type { GateFuturesContract } from './types.js';

const BTC: GateFuturesContract = {
  name: 'BTC_USDT',
  quanto_multiplier: '0.0001',
  order_size_min: '1',
  order_size_step: '1',
  order_price_round: '0.1',
};

test('symbol 互转：BTC_USDT ↔ BTCUSDT', () => {
  assert.equal(gateContractToSymbol('BTC_USDT'), 'BTCUSDT');
  assert.equal(gateContractToSymbol('1000PEPE_USDT'), '1000PEPEUSDT');
  assert.equal(symbolToGateContract('BTCUSDT'), 'BTC_USDT');
  assert.equal(symbolToGateContract('btcusdt'), 'BTC_USDT');
  assert.equal(symbolToGateContract('ETHBTC'), 'ETHBTC');
});

test('num：字符串数值、空串、非法值都安全', () => {
  assert.equal(num('1.2345'), 1.2345);
  assert.equal(num('-3'), -3);
  assert.equal(num(2.5), 2.5);
  assert.equal(num(''), 0);
  assert.equal(num(undefined), 0);
  assert.equal(num('abc'), 0);
});

test('★ 账户映射：equity=total，钱包余额反算 total−未实现盈亏', () => {
  const state = mapBalance({ total: '1050.5', unrealised_pnl: '12.25', available: '800.25', margin: '250.25' });
  assert.equal(state.equity, 1050.5);
  assert.equal(state.unrealizedPnl, 12.25);
  assert.equal(state.walletBalance, 1050.5 - 12.25);
  assert.equal(state.availableBalance, 800.25);
  assert.equal(state.marginUsed, 250.25);
  assert.equal(state.openOrderMargin, 0);
});

test('账户映射：没有 margin 字段时用 total−available 兜底，且不为负', () => {
  assert.equal(mapBalance({ total: '1000', unrealised_pnl: '0', available: '700' }).marginUsed, 300);
  assert.equal(mapBalance({ total: '1000', unrealised_pnl: '100', available: '1200' }).marginUsed, 0);
});

test('★★★ 持仓映射：张数 × quanto_multiplier = 币数，符号位转 side', () => {
  const long = mapPosition(
    {
      contract: 'BTC_USDT',
      size: '100',
      entry_price: '70000',
      mark_price: '70100',
      leverage: '10',
      unrealised_pnl: '10',
      margin: '700.1',
      liq_price: '63000',
    },
    BTC,
  );
  assert.ok(long);
  /* 100 张 × 0.0001 = 0.01 BTC */
  assert.equal(long.quantity, 0.01);
  assert.equal(long.side, 'long');
  assert.equal(long.symbol, 'BTCUSDT');
  assert.equal(long.entryPrice, 70000);
  assert.equal(long.markPrice, 70100);
  assert.equal(long.notional, 0.01 * 70100);
  assert.equal(long.unrealizedPnl, 10);
  assert.equal(long.liquidationPrice, 63000);

  const short = mapPosition(
    { contract: 'BTC_USDT', size: '-200', entry_price: '70000', mark_price: '69900', leverage: '5', unrealised_pnl: '20', margin: '279.6' },
    BTC,
  );
  assert.ok(short);
  assert.equal(short.quantity, 0.02);
  assert.equal(short.side, 'short');
});

test('★ 平掉的仓位（size=0 / contract 空）不映射 —— 否则界面出现 0 数量持仓', () => {
  assert.equal(
    mapPosition({ contract: '', size: '0', entry_price: '0', mark_price: '0', leverage: '1', unrealised_pnl: '0' }, BTC),
    null,
  );
  assert.equal(
    mapPosition({ contract: 'BTC_USDT', size: '0', entry_price: '0', mark_price: '0', leverage: '1', unrealised_pnl: '0' }, BTC),
    null,
  );
});

test('收益率：优先 Gate 的 unrealised_pnl_rate，缺失时用 盈亏/保证金', () => {
  const withRate = mapPosition(
    { contract: 'BTC_USDT', size: '1', entry_price: '100', mark_price: '101', leverage: '10', unrealised_pnl: '1', margin: '10', unrealised_pnl_rate: '10' },
    BTC,
  );
  assert.equal(withRate?.unrealizedPnlPercent, 10);

  const noRate = mapPosition(
    { contract: 'BTC_USDT', size: '1', entry_price: '100', mark_price: '99', leverage: '10', unrealised_pnl: '-1', margin: '10' },
    BTC,
  );
  assert.equal(noRate?.unrealizedPnlPercent, -10);
});

test('数量换算：币数 → 张数（向下取整到 step，过小返回 0）', async () => {
  const registry = new GateContractRegistry(
    { publicGet: async () => [BTC] } as unknown as ConstructorParameters<typeof GateContractRegistry>[0],
  );
  /* 0.01 BTC = 100 张 */
  assert.equal(await registry.quantityToSize('BTC_USDT', 0.01), 100);
  /* 0.00999 BTC = 99.9 张 → 向下取整 99 张 */
  assert.equal(await registry.quantityToSize('BTC_USDT', 0.00999), 99);
  /* 比最小张数还小 → 0（调用方据此拒绝下单，而不是偷偷开一张） */
  assert.equal(await registry.quantityToSize('BTC_USDT', 0.00001), 0);
});

test('账户读取器：余额与持仓都走同一套映射', async () => {
  const rest = {
    signed: async (method: string, path: string) => {
      if (path === '/futures/usdt/accounts') return { total: '1000', unrealised_pnl: '0', available: '900', margin: '100' };
      if (path === '/futures/usdt/positions') {
        return [
          { contract: 'BTC_USDT', size: '50', entry_price: '70000', mark_price: '70100', leverage: '10', unrealised_pnl: '5', margin: '350.5' },
          { contract: '', size: '0', entry_price: '0', mark_price: '0', leverage: '1', unrealised_pnl: '0' },
        ];
      }
      throw new Error(`unexpected path ${method} ${path}`);
    },
    publicGet: async () => [BTC],
  } as unknown as ConstructorParameters<typeof GateAccountReader>[0];
  const registry = new GateContractRegistry(rest as unknown as ConstructorParameters<typeof GateContractRegistry>[0]);
  const reader = new GateAccountReader(rest, registry);
  const balance = await reader.balance();
  assert.equal(balance.equity, 1000);
  const positions = await reader.positions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0]!.quantity, 0.005);
  assert.equal(positions[0]!.symbol, 'BTCUSDT');
});
