/**
 * **Gate 连接的集中创建点** —— REST + 合约注册表 + broker + 行情层 + 交易注册表。
 *
 * ## 为什么单独一个文件
 *
 * `manager.connectionFor()` 原来只会造币安连接。接第二个交易所时，"怎么造一条
 * Gate 连接"（REST、合约注册表、broker、行情、同步注册表谁依赖谁、环境从哪来）
 * 如果散在 manager 里，会被后来的行情层、联调脚本与测试各抄一份 —— 这正是这个
 * 仓库反复记录的"同一个事实有多份副本"那一类问题。
 *
 * 集中在这里之后只有一条规则：
 *
 * ```
 *   环境 = 账户的 testnet 字段 ? 'testnet' : 'live'
 * ```
 *
 * **不是全局 env，也不是启动时的 dryRun**：同一个 GateBroker 代码同时服务测试网
 * 与正式网，上线正式网只是把一个账户的环境标记换掉，不是改代码。
 *
 * ## 与 `binance/bootstrap.ts` 的对应关系
 *
 * `connectExchange()` 做三件事：校时、拉 `exchangeInfo`（限频 + 合约过滤器）、
 * 组装 broker。Gate 的对应物：
 *
 * | 币安 | Gate |
 * | --- | --- |
 * | `rest.syncTime()` 全局校时 | **请求级时间戳**（每次请求取当前时间，秒级），无全局偏移。`clockOffsetMs` 恒 0，字段保留让 manager 的统一日志能读 |
 * | `exchangeInfo` → `SymbolRegistry` | `GateContractRegistry`（异步取合约）→ `buildGateSymbolRegistry()` 映射成同一个 `SymbolRegistry` |
 * | `BinanceBroker(rest, market, registry)` | `GateBroker(rest, contracts)` |
 * | `BinanceMarketData(rest)` | `GateMarket(rest, contracts)` |
 *
 * ## 为什么"启动时 await 构建"交易注册表
 *
 * 交易循环（`AutoTrader` / `RiskEngine`）只认同步的 `SymbolRegistry`。Gate 的合约
 * 信息是异步 API，所以在**建连接的时候**取一次并映射好。取不到 → 抛错 → 启动失败，
 * 而不是带着空注册表启动、之后每一笔都"Unknown or non-tradable futures symbol"。
 */
import type { PreflightCheck } from '../binance/bootstrap.js';
import { SymbolRegistry } from '../binance/symbols.js';
import { GateContractRegistry } from './account.js';
import { GateBroker } from './broker.js';
import type { GateEnvironment } from './endpoints.js';
import { GateMarket } from './market.js';
import { GateRest } from './rest.js';
import { buildGateSymbolRegistry } from './symbols.js';

/**
 * Gate 行情层的**最低形状** —— 与 `binance/market.ts` 的公共方法对齐。
 *
 * ⚠️ 用 `Pick<…>` 而不是直接写成 `BinanceMarketData`：后者带 private 字段
 *（`constructor(private readonly rest)`），而 TypeScript 对 private 成员要求
 * "同源" —— GateMarket 永远不会结构兼容它。`Pick` 只取公共方法签名，才是
 * "形状对齐"的正确表达（与 `trader/brokerPort.ts` 对 BinanceBroker 的做法一致）。
 */
export type GateMarketPort = Pick<
  GateMarket,
  | 'klines'
  | 'fetchClosedKlines'
  | 'ticker24h'
  | 'premiumIndex'
  | 'openInterest'
  | 'openInterestHist'
  | 'takerBuySellVolume'
  | 'longShortRatio'
>;

/** 一条 Gate 连接（与 `ExchangeConnection` 同层，但各部件是 Gate 实现）。 */
export interface GateConnection {
  /** 交易所标识 —— manager 用它做 union 收窄（`isGateConnection`）。 */
  exchange: 'gate';
  /** 测试网还是正式网 —— **只由账户的 `testnet` 字段决定**。 */
  environment: GateEnvironment;
  rest: GateRest;
  /** Gate 原生合约表（broker 的数量换算与行情层共用，自带 5 分钟缓存）。 */
  contracts: GateContractRegistry;
  broker: GateBroker;
  /** 行情层（Gate 实现；形状满足 `market/port.ts` 的 `MarketPort`）。 */
  market: GateMarket;
  /**
   * **交易循环用的同步合约注册表**（币安那套 `SymbolRegistry`）。
   *
   * 由 Gate 合约映射而来（见 `gate/symbols.ts`）：取整、最小名义、数量换算
   * **复用币安实现**，不重写第二套。
   */
  registry: SymbolRegistry;
  /**
   * 与币安连接保持同名的字段。
   *
   * Gate 不做全局校时（请求级时间戳），所以恒为 0 —— 但保留它，让 manager 的
   * 统一日志 / 未来的健康检查不必为两种连接写两个分支。
   */
  clockOffsetMs: number;
}

/**
 * **账户的 `testnet` 字段 → Gate 环境**。唯一映射处。
 *
 * 别让调用点各写一遍 `testnet ? 'testnet' : 'live'` —— 那种小三元一旦有一处
 * 写反，表现就是"测试网账户连了正式网"（或反过来），而两者都不会报错。
 */
export function gateEnvironmentOf(testnet: boolean): GateEnvironment {
  return testnet ? 'testnet' : 'live';
}

export interface ConnectGateOptions {
  apiKey: string;
  apiSecret: string;
  /** **由账户的 testnet 字段决定** —— 用 `gateEnvironmentOf()` 换算。 */
  environment: GateEnvironment;
  /** 测试注入（默认全局 `fetch`）。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * 行情层工厂（测试注入用；缺省造真实的 `GateMarket`）。
   *
   * 生产不传：默认 `new GateMarket(rest, contracts)` —— 二者共享同一条连接，
   * 不会出现"行情层与订单层各连一套"。
   */
  createMarket?: (rest: GateRest, contracts: GateContractRegistry) => GateMarket;
  /**
   * 交易注册表工厂（测试注入用；缺省走真实的 `buildGateSymbolRegistry`）。
   *
   * 测试注入它可以在**完全离线**的情况下建连接；生产默认会真实拉一次
   * `/futures/usdt/contracts`（启动期，见文件头）。
   */
  createRegistry?: (
    contracts: GateContractRegistry,
    market: GateMarket,
  ) => Promise<SymbolRegistry>;
}

/**
 * 创建一条 Gate 连接。**会发起一次公开行情请求**（拉合约列表构建注册表），
 * 其余组件构造成本为零（懒加载）。
 *
 * 一个值得写下来的取舍：这里**不**主动校时。币安要校时，是因为它的签名带
 * `timestamp` + `recvWindow` 且测试网时间会偏差几天；Gate 的签名时间戳是
 * **每次请求现取**（见 `rest.ts` 头部），没有可校的全局偏移。
 */
export async function connectGate(options: ConnectGateOptions): Promise<GateConnection> {
  const rest = new GateRest({
    apiKey: options.apiKey,
    apiSecret: options.apiSecret,
    environment: options.environment,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const contracts = new GateContractRegistry(rest);
  const broker = new GateBroker(rest, contracts);
  const market = options.createMarket
    ? options.createMarket(rest, contracts)
    : new GateMarket(rest, contracts);
  /*
   * ⚠️ **启动期就把合约映射成同步注册表**（而不是懒加载/空表）。
   *
   * 交易循环只认 `SymbolRegistry`（同步）；空表会让之后每一次行情与下单都失败，
   * 而启动看起来是成功的 —— 那正是"静默失能"的形态。拿不到合约就**抛错**，
   * 让启动明确失败（manager 会把它变成 preflight 里的一条 error）。
   */
  const registry = options.createRegistry
    ? await options.createRegistry(contracts, market)
    : await buildGateSymbolRegistry(contracts, market);

  return {
    exchange: 'gate',
    environment: options.environment,
    rest,
    contracts,
    broker,
    market,
    registry,
    clockOffsetMs: 0,
  };
}

/**
 * **Gate 连接启动时的预检**（与 `binance/bootstrap.ts` 的 `preflight` 同一个角色）。
 *
 * ## 为什么不能直接复用币安的 `preflight()`
 *
 * 那个函数读的是 `BinanceRest` 的签名/权重 API（`hasCredentials`、
 * `signedRequest('/fapi/v2/account')`、`isHedgeMode`…）。Gate 的 REST 形状不同，
 * 硬塞会把类型和语义一起搞乱。
 *
 * ## 检查项与币安预检的对应
 *
 * ```
 *   账户访问    ← /futures/usdt/accounts（权益、可用）
 *   交易余额    ← available > 0（为 0 时开仓必被拒）
 *   合约元数据  ← registry.size > 0（空注册表 = 所有标的都会 "Unknown symbol"）
 *   时钟同步    ← Gate 请求级时间戳，无需校时（ok，仅说明）
 *   测试环境    ← testnet 时 warn（假钱、真实撮合；行情/资金费率与正式网不同）
 * ```
 *
 * ⚠️ **正式网 + dryRun 的拒绝不在这里**：那条守卫在
 * `manager.createExchangeConnection()` 里（连接创建之前），因为"Gate 的模拟盘
 * = 测试网"，拿正式网账户跑 dryRun 会**真钱下单** —— 必须在造连接之前拦住。
 */
export async function gateStartupChecks(connection: GateConnection): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  /* --- 账户可读 + 余额 ------------------------------------------------ */
  try {
    const account = await connection.broker.getAccountState();
    checks.push({
      name: '账户访问',
      severity: 'ok',
      ok: true,
      blocking: false,
      detail: `权益 ${account.equity.toFixed(2)} USDT，可用 ${account.availableBalance.toFixed(2)} USDT。`,
    });
    checks.push({
      name: '交易余额',
      severity: account.availableBalance > 0 ? 'ok' : 'error',
      ok: account.availableBalance > 0,
      /*
       * ⚠️ Gate 的"可用"是**保证金可用额**；为 0 时任何开仓都会被拒
       *（下单会被 Gate 以 `INSUFFICIENT_AVAILABLE` 打回），所以这里阻断启动，
       * 而不是让它跑一轮注定失败的周期。
       */
      detail:
        account.availableBalance > 0
          ? `可用余额 ${account.availableBalance.toFixed(2)} USDT。`
          : '可用余额为 0，无法开仓。请先给该 Gate 账户入金（测试网可用官方水龙头）。',
      blocking: account.availableBalance <= 0,
    });
  } catch (error) {
    checks.push({
      name: '账户访问',
      severity: 'error',
      ok: false,
      detail: `无法读取 Gate 账户：${(error as Error).message}`,
      blocking: true,
    });
  }

  /* --- 合约元数据（注册表）------------------------------------------- */
  const registrySize = connection.registry.size;
  checks.push({
    name: '合约元数据',
    severity: registrySize > 0 ? 'ok' : 'error',
    ok: registrySize > 0,
    detail:
      registrySize > 0
        ? `已加载 ${registrySize} 个可交易合约（Gate → 项目符号已映射）。`
        : 'Gate 合约注册表为空 —— 所有标的都会被判为不可交易。',
    blocking: registrySize === 0,
  });

  /* --- 时钟：Gate 用请求级时间戳，没有全局偏移 ------------------------ */
  checks.push({
    name: '时钟同步',
    severity: 'ok',
    ok: true,
    blocking: false,
    detail: 'Gate 使用请求级时间戳（每次请求现取），无需全局校时。',
  });

  /* --- 环境提示 ------------------------------------------------------- */
  if (connection.environment === 'testnet') {
    checks.push({
      name: '测试环境提示',
      severity: 'warn',
      ok: true,
      blocking: false,
      detail:
        '当前连的是 Gate **测试网**：假钱、真实撮合。其行情深度、资金费率与标记价格与正式网不同，' +
        '不要用这里的结果校准仓位大小或滑点假设。',
    });
  }

  return checks;
}
