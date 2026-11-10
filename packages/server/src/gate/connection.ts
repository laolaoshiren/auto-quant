/**
 * **Gate 连接的集中创建点** —— REST + 合约注册表 + broker（+ 行情层）。
 *
 * ## 为什么单独一个文件
 *
 * `manager.connectionFor()` 原来只会造币安连接。接第二个交易所时，"怎么造一条
 * Gate 连接"（REST、合约注册表、broker 三者谁依赖谁、环境从哪来）如果散在
 * manager 里，会被后来的行情层、联调脚本与测试各抄一份 —— 这正是这个仓库
 * 反复记录的"同一个事实有多份副本"那一类问题。
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
 * | `exchangeInfo` → `SymbolRegistry` | `GateContractRegistry` 懒加载 `/futures/usdt/contracts`（5 分钟缓存，见 `account.ts`） |
 * | `BinanceBroker(rest, market, registry)` | `GateBroker(rest, registry)` |
 *
 * ## ⚠️ 行情层由并发任务提供（`gate/market.ts`，task-15）
 *
 * 行情层还没落地，所以这里用 `GateMarketPort` **接口**声明形状，并通过
 * `createMarket` 工厂注入。在它落地之前 `market === null`，manager 会**明确拒绝**
 * 用这条连接组装交易循环 —— 绝不用币安行情服务驱动 Gate 下单（那会让风控按
 * 币安的行情与合约精度去裁决 Gate 的订单）。
 */
import type { BinanceMarketData } from '../binance/market.js';
import { GateContractRegistry } from './account.js';
import { GateBroker } from './broker.js';
import type { GateEnvironment } from './endpoints.js';
import { GateRest } from './rest.js';

/**
 * Gate 行情层的**最低形状** —— 与 `binance/market.ts` 的公共方法对齐。
 *
 * ⚠️ 用 `Pick<…>` 而不是直接写成 `BinanceMarketData`：后者带 private 字段
 *（`constructor(private readonly rest)`），而 TypeScript 对 private 成员要求
 * "同源" —— GateMarket 永远不会结构兼容它。`Pick` 只取公共方法签名，才是
 * "形状对齐"的正确表达。
 */
export type GateMarketPort = Pick<
  BinanceMarketData,
  | 'klines'
  | 'fetchClosedKlines'
  | 'ticker24h'
  | 'premiumIndex'
  | 'openInterest'
  | 'openInterestHist'
>;

/** 一条 Gate 连接（与 `ExchangeConnection` 同层，但行情/注册表是 Gate 实现）。 */
export interface GateConnection {
  /** 交易所标识 —— manager 用它做 union 收窄（`isGateConnection`）。 */
  exchange: 'gate';
  /** 测试网还是正式网 —— **只由账户的 `testnet` 字段决定**。 */
  environment: GateEnvironment;
  rest: GateRest;
  registry: GateContractRegistry;
  broker: GateBroker;
  /** 行情层；`gate/market.ts` 落地前为 null（见文件头）。 */
  market: GateMarketPort | null;
  /**
   * 与币安连接保持同名的字段。
   *
   * Gate 不做全局校时（请求级时间戳），所以恒为 0 —— 但保留它，让 manager
   * 的统一日志 / 未来的健康检查不必为两种连接写两个分支。
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
   * 行情层工厂。
   *
   * `gate/market.ts`（task-15）落地后由 manager 传入（或在本文件里改成默认值）。
   * 未提供时 `market === null` —— manager 会明确拒绝启动交易循环，而不是
   * 拿一条没有行情的连接去下单。
   */
  createMarket?: (rest: GateRest, registry: GateContractRegistry) => GateMarketPort;
}

/**
 * 创建一条 Gate 连接。**不发起任何网络请求** —— 合约注册表是懒加载的
 * （第一次用到时才拉 `/futures/usdt/contracts`），所以这里可以同步返回。
 *
 * 一个值得写下来的取舍：这里**不**主动校时、也不预热合约信息。币安要校时，
 * 是因为它的签名带 `timestamp` + `recvWindow` 且测试网时间会偏差几天；Gate 的
 * 签名时间戳是**每次请求现取**（见 `rest.ts` 头部），没有可校的全局偏移。
 * 预热也不做：那会让"启动机器人"多一次可能失败的网络请求，而失败时还什么都
 * 没下单 —— 懒加载失败会落在真正需要它的那一次调用上，错误位置更准确。
 */
export function connectGate(options: ConnectGateOptions): GateConnection {
  const rest = new GateRest({
    apiKey: options.apiKey,
    apiSecret: options.apiSecret,
    environment: options.environment,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const registry = new GateContractRegistry(rest);
  const broker = new GateBroker(rest, registry);
  const market = options.createMarket ? options.createMarket(rest, registry) : null;

  return {
    exchange: 'gate',
    environment: options.environment,
    rest,
    registry,
    broker,
    market,
    clockOffsetMs: 0,
  };
}
