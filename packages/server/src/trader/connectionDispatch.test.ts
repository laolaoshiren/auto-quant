/**
 * **manager 按交易所分派连接** —— 钉住"gate 账户 → GateBroker、binance 账户 → BinanceBroker"。
 *
 * ## 为什么这个测试存在（Gate 阶段 2）
 *
 * `manager.connectionFor()` 原来写死 `connectExchange(...)`（币安）。给一个 Gate
 * 账户启动机器人时，它会拿 Gate 的 key 去请求**币安** —— 签名必然失败，而错误
 * 信息还是币安口径的，排查方向会被完全带偏。
 *
 * 分派逻辑抽成 `createExchangeConnection()` 之后可以**不碰数据库、不发网络**
 * 地测：注入"记录调用并返回桩连接"的工厂，断言**哪个工厂被调用、拿到什么环境**。
 *
 * 另外钉住两条安全规则：
 * ① Gate 的"模拟盘"是测试网（真实撮合），**正式网账户 + dryRun 必须被拒绝**；
 * ② 未知交易所**不得回落到币安**（那会拿 A 的凭据去 B 下单）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { AccountState } from '../binance/account.js';
import type { ConnectOptions, ExchangeConnection } from '../binance/bootstrap.js';
import { BinanceBroker } from '../binance/broker.js';
import type { BinanceMarketData } from '../binance/market.js';
import type { BinanceRest } from '../binance/rest.js';
import { SymbolRegistry } from '../binance/symbols.js';
import { GateBroker } from '../gate/broker.js';
import { connectGate } from '../gate/connection.js';
import {
  accountExchangeKind,
  createExchangeConnection,
  isGateConnection,
  type CreateConnectionInput,
  type ExchangeConnectionFactories,
} from './manager.js';

/* -------------------------------------------------------------------------- */
/*  桩：真实 broker 实例，但不发网络请求                                          */
/* -------------------------------------------------------------------------- */

/** 一条"币安形状"的连接桩：broker 是真的 `BinanceBroker`（构造不联网）。 */
function fakeBinanceConnection(): ExchangeConnection {
  const rest = { hasCredentials: true } as unknown as BinanceRest;
  const market = {} as unknown as BinanceMarketData;
  const registry = { size: 0 } as unknown as SymbolRegistry;
  return {
    environment: 'demo',
    endpoints: {} as ExchangeConnection['endpoints'],
    rest,
    market,
    registry,
    broker: new BinanceBroker(rest, market, registry, { dryRun: true }),
    clockOffsetMs: 0,
  };
}

interface Recorded {
  binance: ConnectOptions[];
  gate: Array<Parameters<typeof connectGate>[0]>;
}

function recordingFactories(recorded: Recorded): ExchangeConnectionFactories {
  return {
    binance: (async (options: ConnectOptions) => {
      recorded.binance.push(options);
      return fakeBinanceConnection();
    }) as ExchangeConnectionFactories['binance'],
    gate: ((options: Parameters<typeof connectGate>[0]) => {
      recorded.gate.push(options);
      /*
       * 真实的 GateBroker / GateContractRegistry —— `connectGate` 除"启动期构建
       * 同步注册表"外不联网；而注册表在这里注入一个**空桩**，让分派测试不依赖
       * Gate 测试网（否则单测在无网环境会红，且每次跑测试都打外部接口）。
       */
      return connectGate({
        ...options,
        createRegistry: async () => new SymbolRegistry([]),
      });
    }) as ExchangeConnectionFactories['gate'],
  };
}

function newRecorder(): Recorded {
  return { binance: [], gate: [] };
}

function input(over: Partial<CreateConnectionInput>): CreateConnectionInput {
  return {
    traderId: 1,
    exchange: 'binance',
    apiKey: 'k',
    apiSecret: 's',
    testnet: false,
    dryRun: false,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/*  分派判据                                                                     */
/* -------------------------------------------------------------------------- */

test('★★★ `accountExchangeKind` 是唯一分派判据：binance / gate / 其它显式 unsupported', () => {
  assert.equal(accountExchangeKind('binance'), 'binance');
  assert.equal(accountExchangeKind('gate'), 'gate');
  /* 未知值不得默认成 binance —— 回落会让别的交易所凭据去币安下单。 */
  assert.equal(accountExchangeKind('okx'), 'unsupported');
  assert.equal(accountExchangeKind(''), 'unsupported');
});

/* -------------------------------------------------------------------------- */
/*  gate 账户 → GateBroker                                                       */
/* -------------------------------------------------------------------------- */

test('★★★ gate 账户（测试网 + 模拟盘）→ GateBroker，环境 testnet', async () => {
  const recorded = newRecorder();
  const connection = await createExchangeConnection(
    input({ exchange: 'gate', testnet: true, dryRun: true }),
    recordingFactories(recorded),
  );

  assert.equal(recorded.binance.length, 0, '★ gate 账户绝不能走币安工厂');
  assert.equal(recorded.gate.length, 1);
  /* 环境由**账户的 testnet 字段**决定（这里 testnet=true）。 */
  assert.equal(recorded.gate[0]!.environment, 'testnet');
  assert.ok(isGateConnection(connection), '必须是 Gate 连接（union 收窄靠它）');
  assert.ok(connection.broker instanceof GateBroker, '★★★ gate 账户必须造出 GateBroker');
});

test('★★★ gate 账户（正式网 + 实盘）→ 环境 live', async () => {
  const recorded = newRecorder();
  const connection = await createExchangeConnection(
    input({ exchange: 'gate', testnet: false, dryRun: false }),
    recordingFactories(recorded),
  );
  assert.equal(recorded.gate.length, 1);
  assert.equal(recorded.gate[0]!.environment, 'live');
  assert.ok(isGateConnection(connection));
  assert.ok(connection.broker instanceof GateBroker);
});

/* -------------------------------------------------------------------------- */
/*  binance 账户 → BinanceBroker（既有路径不破坏）                                 */
/* -------------------------------------------------------------------------- */

test('★★★ binance 账户（正式网）→ BinanceBroker，环境 production', async () => {
  const recorded = newRecorder();
  const connection = await createExchangeConnection(
    input({ exchange: 'binance', testnet: false, dryRun: false }),
    recordingFactories(recorded),
  );

  assert.equal(recorded.gate.length, 0, '币安账户不能走 Gate 工厂');
  assert.equal(recorded.binance.length, 1);
  assert.equal(recorded.binance[0]!.environment, 'production');
  assert.equal(isGateConnection(connection), false);
  assert.ok(connection.broker instanceof BinanceBroker, '★★★ binance 账户仍是 BinanceBroker');
});

test('★★ binance 账户（测试网）→ 环境 demo', async () => {
  const recorded = newRecorder();
  await createExchangeConnection(
    input({ exchange: 'binance', testnet: true, dryRun: true }),
    recordingFactories(recorded),
  );
  assert.equal(recorded.binance.length, 1);
  assert.equal(recorded.binance[0]!.environment, 'demo');
});

/* -------------------------------------------------------------------------- */
/*  安全规则                                                                     */
/* -------------------------------------------------------------------------- */

test('★★★ Gate 正式网账户 + dryRun 必须拒绝 —— 否则"模拟盘"拿真钱下单', async () => {
  /*
   * Gate 的"模拟盘"是官方测试网（真实撮合、假钱），`GateBroker.isDryRun` 恒 false。
   * 所以"dryRun + 非测试网账户"是一条**会亏真钱**的路径，必须硬性拒绝。
   */
  const recorded = newRecorder();
  await assert.rejects(
    () =>
      createExchangeConnection(
        input({ exchange: 'gate', testnet: false, dryRun: true }),
        recordingFactories(recorded),
      ),
    /Gate 账户不支持本地模拟盘/,
  );
  assert.equal(recorded.gate.length, 0, '被拒绝时不该建任何连接');
  assert.equal(recorded.binance.length, 0);
});

test('★★★ 未知交易所必须显式报错，且**不得回落到币安**', async () => {
  const recorded = newRecorder();
  await assert.rejects(
    () =>
      createExchangeConnection(
        input({ exchange: 'okx', testnet: false, dryRun: false }),
        recordingFactories(recorded),
      ),
    /暂不支持的交易所/,
  );
  assert.equal(recorded.binance.length, 0, '★ 回落会让 A 交易所的凭据去币安下单');
  assert.equal(recorded.gate.length, 0);
});

/* -------------------------------------------------------------------------- */
/*  模拟盘账户读数只在需要时传给币安                                               */
/* -------------------------------------------------------------------------- */

test('★★ dryRun 时才把 paperAccount 传给币安工厂（实盘不传）', async () => {
  const paperAccount = async (): Promise<AccountState> => ({}) as AccountState;

  const dry = newRecorder();
  await createExchangeConnection(
    input({ exchange: 'binance', dryRun: true, paperAccount }),
    recordingFactories(dry),
  );
  assert.equal(typeof dry.binance[0]!.paperAccount, 'function', '模拟盘必须用本地台账读数');

  const live = newRecorder();
  await createExchangeConnection(
    input({ exchange: 'binance', dryRun: false, paperAccount }),
    recordingFactories(live),
  );
  assert.equal(live.binance[0]!.paperAccount, undefined, '实盘绝不能读本地台账冒充交易所余额');
});
