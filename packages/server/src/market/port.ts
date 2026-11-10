/**
 * **行情层的最小能力面**（交易循环 + 行情服务需要的公开方法）。
 *
 * ## 为什么需要它（Gate 阶段 2）
 *
 * `MarketDataService` 与 `AutoTrader` 原来把行情依赖写成**具体类** `BinanceMarketData`。
 * 接第二个交易所（Gate.io）时，那意味着要么让 `GateMarket` 继承币安实现（继承了一堆
 * 币安专有语义），要么把依赖收窄成一个**结构类型**。后者才对 —— 与
 * `trader/brokerPort.ts` 对 `BinanceBroker` 做的事完全同一条思路。
 *
 * ## 为什么是 `Pick<BinanceMarketData, ...>` 而不是手写签名
 *
 * 手写签名 = **两份真相**：币安实现的参数一改，接口不会跟着变，而 `BinanceMarketData`
 * 仍然"满足"接口 —— 类型系统不报错，运行时才炸。`Pick` 让接口由币安实现自动定义。
 *
 * 代价：Gate 那边必须实现同样的形状。这是刻意的：交易循环要能同时驱动两个交易所，
 * 差异（Gate 的 funding_rate 历史、合约张数换算）留在各自实现内部消化。
 *
 * ## 为什么包含 `takerBuySellVolume` / `longShortRatio`
 *
 * 它们目前不是 `MarketDataService` 的读取点，但属于"一套行情能力"的一部分，
 * 且两个实现都有；收进来可以避免以后加消费方时又去改一次类型。方法的**行为**
 * 可以是降级的（Gate 没有对应公开端点 → 返回空数组），但**形状**必须一致。
 */
import type { BinanceMarketData } from '../binance/market.js';

export type MarketPort = Pick<
  BinanceMarketData,
  | 'klines'
  | 'fetchClosedKlines'
  | 'ticker24h'
  | 'premiumIndex'
  | 'openInterest'
  | 'openInterestHist'
  | 'takerBuySellVolume'
  | 'longShortRatio'
>;

/**
 * 运行期守卫（可选）：只检查**方法存在**，不检查行为。
 *
 * 接线处（如 `connectGate` 之后的启动预检）用它给出"这个行情对象连方法都不齐"的
 * 明确错误，而不是让第一次行情调用以 `xxx is not a function` 的形式随机失败。
 */
export function isMarketPort(value: unknown): value is MarketPort {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const methods = [
    'klines',
    'fetchClosedKlines',
    'ticker24h',
    'premiumIndex',
    'openInterest',
    'openInterestHist',
    'takerBuySellVolume',
    'longShortRatio',
  ] as const;
  return methods.every((name) => typeof candidate[name] === 'function');
}
