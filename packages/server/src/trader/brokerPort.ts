/**
 * 交易循环对"交易所"的最小能力面。
 *
 * ## 为什么需要它
 *
 * `AutoTrader` 的依赖类型原来直接写着 `BinanceBroker` —— 一个**具体类**。
 * 接第二个交易所（Gate.io）时，要么让 GateBroker 继承币安实现（继承了一堆
 * 币安专有语义：`STOP_MARKET`/`closePosition`/`algo` 端点），要么把这段
 * 依赖收窄成一个**结构类型**。后者才对：交易循环真正用到的只有下面这 19 个方法，
 * 它们描述的是"一个合约交易所该能做什么"，与"币安"无关。
 *
 * ## 为什么是 `Pick<BinanceBroker, ...>` 而不是手写签名
 *
 * 手写签名意味着**两份真相**：币安实现的参数一改，接口不会跟着变，而
 * `BinanceBroker` 仍然"满足"接口 —— 类型系统不会报错，运行时才炸。
 * `Pick` 让接口**由币安实现自动定义**：签名只有一份，改了就一起变。
 *
 * 代价：Gate 那边必须实现与币安**完全一致的形状**（包括币安特有的
 * `PlacedOrder.kind` / `BinanceOrderResponse` 这些返回类型）。这是刻意的——
 * 交易循环要能同时驱动两个交易所，形状必须对齐；对齐不了的差异（例如 Gate 的
 * 条件单是独立资源 `price_orders`）在 Gate 实现内部消化，而不是泄漏到这里。
 */
import type { BinanceBroker } from '../binance/broker.js';

export type BrokerPort = Pick<
  BinanceBroker,
  | 'getAccountState'
  | 'isHedgeMode'
  | 'ensureOneWayMode'
  | 'getPositions'
  | 'getMaxLeverage'
  | 'setLeverage'
  | 'setMarginType'
  | 'placeOrder'
  | 'getOpenOrders'
  | 'getOrder'
  | 'getOpenAlgoOrders'
  | 'getAlgoOrder'
  | 'waitForFill'
  | 'cancelOrder'
  | 'cancelAllOrders'
  | 'getUserTrades'
  | 'getIncome'
  | 'getMarkPrice'
  | 'isDryRun'
>;
