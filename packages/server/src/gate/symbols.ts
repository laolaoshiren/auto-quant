/**
 * **Gate 合约 → `SymbolRegistry`（本项目的合约精度注册表）适配。**
 *
 * ## 为什么需要这一层（Gate 阶段 2）
 *
 * 交易循环（`AutoTrader` / `RiskEngine`）对合约精度只有**一个**入口：
 * `binance/symbols.ts` 的 `SymbolRegistry`（同步 API：`roundQuantity` /
 * `roundTriggerPrice` / `minNotional` / `quantityFor` …）。所有"按交易所规则取整、
 * 最小名义、最小数量"的逻辑都长在它上面 —— **绝不能为 Gate 再写一套**：
 * 那会立刻产生两份取整逻辑，迟早分叉，而分叉的表现是"同一个数量在风控里合格、
 * 在交易所侧被拒"。
 *
 * Gate 那边只有 `GateContractRegistry`（**异步** API，按合约名取 `GateFuturesContract`），
 * 所以这里做一次**启动期**的映射：异步读全部合约 → 映射成 `SymbolInfo[]` →
 * `new SymbolRegistry(infos)`。之后交易循环拿到的就是熟悉的同步注册表。
 *
 * ## 映射口径（全部对着 Gate 实测响应核对过）
 *
 * | 本项目（`SymbolInfo`） | Gate | 说明 |
 * | --- | --- | --- |
 * | `symbol` | `name` 去下划线 | `BTC_USDT` → `BTCUSDT` |
 * | `baseAsset` / `quoteAsset` | `name` 拆分 | `BTC_USDT` → BTC / USDT |
 * | `tickSize` | `order_price_round` | 价格最小变动 |
 * | `stepSize` | `order_size_step × quanto_multiplier` | **张数步长换成币数步长** |
 * | `minQty` | `order_size_min × quanto_multiplier` | 最小张数换成最小币数 |
 * | `maxQty` | `order_size_max × quanto_multiplier` | 0 = 不限制（与币安同约定） |
 * | `minNotional` | `order_size_min × quanto_multiplier` | ⚠️ 见下方说明 |
 * | `pricePrecision` / `quantityPrecision` | 由 tick/step 的十进制位数推出 | 复用 `stepDecimals` |
 * | `contractSize` | 1 | 本项目的"数量"单位是**币数**；张数换算在 broker 内部完成 |
 *
 * ## ⚠️ `minNotional` 的量纲说明（重要，别当成 USDT 用）
 *
 * Gate **没有**币安 `MIN_NOTIONAL` 那种"最小名义价值（USDT）"字段，只有最小张数。
 * 这里按任务约定把"最小张数 × 每张面值"填进来（BTC_USDT = 1 × 0.0001 = 0.0001）。
 * **它的量纲是币数，不是 USDT**，所以它只会让风控的最小名义检查**更宽松**
 * （绝不会错误拒绝一笔本可以下的单）；真正的"最少 1 张"约束由 `GateBroker`
 * 的数量换算兜底 —— 转不出可交易张数时它会明确报错，不会静默下一个 0 张的单。
 */
import type { SymbolInfo } from '@aq/shared';
import { createLogger } from '../logger.js';
import { stepDecimals, SymbolRegistry } from '../binance/symbols.js';
import type { GateContractRegistry } from './account.js';
import {
  GateMarket,
  toGateContractInfo,
  type GateContractInfo,
  type GateContractRaw,
} from './market.js';

const log = createLogger('gate:symbols');

/**
 * 清掉浮点乘法尾巴：`0.0001 × 1` 是干净的，但 `0.1 × 3` 会是
 * `0.30000000000000004` —— 那种值进 `stepDecimals` 会被读成 17 位小数，
 * 取整逻辑跟着错。保留 12 位有效数字足够覆盖 Gate 的精度（价格最小到 1e-8），
 * 又把二进制尾差清掉。
 */
function clean(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(12)) : 0;
}

/** `BTC_USDT` → `['BTC', 'USDT']`；没有下划线时按 USDT 本位兜底。 */
export function splitGateContractName(contract: string): { baseAsset: string; quoteAsset: string } {
  const index = contract.lastIndexOf('_');
  if (index <= 0) return { baseAsset: contract, quoteAsset: 'USDT' };
  return { baseAsset: contract.slice(0, index), quoteAsset: contract.slice(index + 1) };
}

/**
 * 单个 Gate 合约 → `SymbolInfo`。
 *
 * 返回 `null` = 这张合约**没有可用的精度信息**（`order_price_round` 或
 * `quanto_multiplier` 缺失/为 0）—— 调用方应丢弃它并告警：拿 0 当 tickSize 会让
 * 所有价格取整变成 0，进而让止损挂不上（§2.6 的最糟状态）。
 */
export function gateContractInfoToSymbolInfo(info: GateContractInfo): SymbolInfo | null {
  if (!(info.priceTick > 0) || !(info.quantoMultiplier > 0)) {
    log.warn(
      `Gate 合约 ${info.contract} 的精度信息不可用（order_price_round=${info.priceTick}、` +
        `quanto_multiplier=${info.quantoMultiplier}）—— 已从可交易名单中排除，不会用 0 精度去下单。`,
    );
    return null;
  }
  const { baseAsset, quoteAsset } = splitGateContractName(info.contract);
  /*
   * 张数 → 币数：Gate 的"1 张"是 quanto_multiplier 个币。
   * 系统的数量单位是币数，所以步长/最小/最大都要乘一次面值。
   */
  const stepSize = clean(info.sizeStep * info.quantoMultiplier);
  const minQty = clean(info.minSize * info.quantoMultiplier);
  const maxQty = info.maxSize > 0 ? clean(info.maxSize * info.quantoMultiplier) : 0;
  if (!(stepSize > 0)) return null;

  return {
    symbol: info.symbol,
    baseAsset,
    quoteAsset,
    /* 能进注册表的只可能是未下线的合约（见 `buildGateSymbolRegistry` 的过滤）。 */
    status: 'TRADING',
    pricePrecision: stepDecimals(String(info.priceTick)),
    quantityPrecision: stepDecimals(String(stepSize)),
    tickSize: info.priceTick,
    stepSize,
    minQty,
    maxQty,
    /* 见文件头：Gate 没有最小名义价值字段，这里是"最小张数 × 面值"（量纲是币数）。 */
    minNotional: minQty,
    /* 本项目的"数量"是币数；张数换算在 broker 内部完成。 */
    contractSize: 1,
  };
}

/**
 * **启动期**构建 Gate 的同步注册表（`SymbolRegistry`）。
 *
 * @param contracts Gate 合约注册表（异步 API；已带 5 分钟缓存）
 * @param market 可选：已经建好的 `GateMarket`（复用它的 `contractInfos()`，
 *   避免同一份"原始合约 → GateContractInfo"映射在连接层再写一遍）
 *
 * 合约列表为空 / 全部不可用时**抛错**：一条没有可交易合约的注册表会让之后每一次
 * 行情与下单都以"Unknown or non-tradable futures symbol"失败，而启动看起来是成功的。
 */
export async function buildGateSymbolRegistry(
  contracts: GateContractRegistry,
  market?: GateMarket,
): Promise<SymbolRegistry> {
  const infos: GateContractInfo[] = market
    ? await market.contractInfos()
    : [...(await contracts.all()).values()].map((raw) =>
        toGateContractInfo(raw as unknown as GateContractRaw),
      );

  const symbolInfos: SymbolInfo[] = [];
  const skipped: string[] = [];
  for (const info of infos) {
    /* 已下线/退市合约不进入可交易名单（否则策略会选到它、下单必被拒）。 */
    if (info.delisting) continue;
    const mapped = gateContractInfoToSymbolInfo(info);
    if (mapped) symbolInfos.push(mapped);
    else skipped.push(info.contract);
  }

  if (symbolInfos.length === 0) {
    throw new Error(
      'Gate 返回的可交易合约数为 0 —— 拒绝用空合约注册表启动交易循环' +
        '（否则之后每一次行情/下单都会以「Unknown or non-tradable futures symbol」失败，而启动看起来是成功的）。',
    );
  }
  if (skipped.length > 0) {
    log.warn(`Gate 有 ${skipped.length} 个合约因精度信息不可用被排除：${skipped.slice(0, 5).join('、')}${skipped.length > 5 ? '…' : ''}`);
  }
  return new SymbolRegistry(symbolInfos);
}
