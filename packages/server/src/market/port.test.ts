/**
 * **`MarketPort` 类型契约**：币安与 Gate 的行情层都必须满足同一套方法形状。
 *
 * ## 为什么需要这个测试
 *
 * Gate 阶段 2 放开交易循环的前置条件是：`MarketDataService` / `AutoTrader` 不再
 * 依赖具体类 `BinanceMarketData`，而是依赖 `MarketPort = Pick<BinanceMarketData, 8>`。
 * 只要有一个实现的方法签名漂移（例如 `openInterestHist` 少了参数、`ticker24h`
 * 返回数组变成单对象），`cta` 会在**装配处**报错 —— 而这条测试就是那个装配处的
 * 最小复现：把两个实现分别赋给 `MarketPort`。
 *
 * 赋值检查发生在 `tsc`（编译期），运行时只有 `isMarketPort` 的行为检查。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { BinanceMarketData } from '../binance/market.js';
import { GateMarket } from '../gate/market.js';
import { isMarketPort, type MarketPort } from './port.js';

/**
 * 编译期断言：两个**具体实现**都必须能赋值给 `MarketPort`。
 *
 * `BinanceMarketData` 天然满足（MarketPort 由它 Pick 出来）；
 * `GateMarket` 是第二个交易所的实现 —— 它漂移的话这里 `tsc` 直接红。
 */
const _binanceFitsPort: (market: BinanceMarketData) => MarketPort = (market) => market;
const _gateFitsPort: (market: GateMarket) => MarketPort = (market) => market;
void _binanceFitsPort;
void _gateFitsPort;

test('★★★ 运行期守卫：八个方法齐全才算 MarketPort（防止接线时拿到半个对象）', () => {
  const complete: Record<string, unknown> = {};
  for (const name of [
    'klines',
    'fetchClosedKlines',
    'ticker24h',
    'premiumIndex',
    'openInterest',
    'openInterestHist',
    'takerBuySellVolume',
    'longShortRatio',
  ]) {
    complete[name] = () => Promise.resolve();
  }
  assert.equal(isMarketPort(complete), true);

  const missing = { ...complete };
  delete missing.openInterestHist;
  assert.equal(isMarketPort(missing), false, '少一个方法必须被判为不是 MarketPort');

  assert.equal(isMarketPort(null), false);
  assert.equal(isMarketPort('oops'), false);
  assert.equal(isMarketPort({}), false);
});
