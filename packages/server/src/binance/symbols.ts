import { isMajorSymbol as sharedIsMajor, normalizeSymbol, type SymbolInfo } from '@aq/shared';
import type { BinanceExchangeInfo, BinanceSymbol } from './types.js';

export { normalizeSymbol, baseAssetOf } from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  Decimal-safe rounding                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Number of decimal places implied by a step/tick string.
 *
 *   "0.001" → 3      "0.10" → 1      "1" → 0      "10" → 0
 *
 * ## ⚠️ 必须同时认得科学计数法（外部 issue #136）
 *
 * `SymbolInfo` 里的 tick/step 是 **`Number`**（`:97` 的 `Number(tickSize)`），
 * 而调用点又把它转回字符串再解析精度（`:220` 的 `stepDecimals(String(info.tickSize))`）。
 *
 * `Number` → `String` 这一步**不是无损的**：JS 对 `< 1e-6` 的量使用科学计数法，
 *
 * ```
 * "0.0000001" → Number → 1e-7 → String → "1e-7"      ← 没有小数点！
 * ```
 *
 * 而原实现只认小数点（`trimmed.indexOf('.')`），于是 `"1e-7"` 被读成 **0 位小数** ——
 * `roundPrice` / `roundTriggerPrice` 对任何价格都返回 **0**。
 *
 * 后果是**真实的**（实测）：`1000PEPEUSDT`（`tickSize=1e-7`）的保护单因为
 * "触发价 0 会立即触发"被拒 → 止损挂不上 → 按 `docs/AGENTS.md` §2.6
 * 立即市价平掉该仓位 → 每次尝试白付一次开+平的手续费与滑点。
 *
 * ## 为什么修这里而不是改调用点
 *
 * 也可以让调用点保留原始字符串（issue #136 的"方案二"）—— 那更治本，
 * 但 `SymbolInfo` 是 `binance/` 与 `risk/` 共用的类型，改它要动结构。
 * 而**本函数的契约就是"从 step 字符串读精度"**：一个形如 `"1e-7"` 的 step
 * 字符串是合法输入，读不出精度是**这个函数的缺陷**，不是调用方的错。
 *
 * 所以修在这里，并把 `Number` 往返的两种形态都钉进 `stepDecimals.test.ts`。
 */
export function stepDecimals(step: string): number {
  /*
   * 科学计数法：`"1e-7"` / `"1.5e-8"` / `"2E-6"`。
   *
   * 小数位数 = 指数绝对值 + 尾数本身的小数位。例：
   *   "1e-7"   → 尾数 "1"   无小数 → 7 + 0 = 7
   *   "1.5e-8" → 尾数 "1.5" 有 1 位 → 8 + 1 = 9
   */
  const scientific = /^(\d+)(?:\.(\d+))?[eE]-(\d+)$/.exec(step.trim());
  if (scientific) {
    const mantissaDecimals = scientific[2]?.length ?? 0;
    return Number(scientific[3]) + mantissaDecimals;
  }

  const trimmed = step.includes('.') ? step.replace(/0+$/, '') : step;
  const dot = trimmed.indexOf('.');
  return dot === -1 ? 0 : trimmed.length - dot - 1;
}

/**
 * Round **down** to the nearest multiple of `step`.
 *
 * Quantities are always floored: rounding up would ask the exchange for more
 * than the account can afford and produce a `-2019` insufficient-margin error.
 * The `1e-9` nudge absorbs binary-float noise such as `0.1 * 3 = 0.30000000000000004`.
 */
export function roundDownToStep(value: number, step: number, decimals: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const ratio = value / step;
  const floored = Math.floor(ratio + 1e-9);
  return Number((floored * step).toFixed(decimals));
}

/** Round to the nearest multiple of `step` — the right choice for prices. */
export function roundToStep(value: number, step: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const ratio = value / step;
  const rounded = Math.round(ratio);
  return Number((rounded * step).toFixed(decimals));
}

/**
 * Round a price *toward* `side` so that a stop is never loosened and a target
 * is never made easier to hit by accident:
 *
 *  - a BUY stop rounds up (worse fill but guaranteed trigger)
 *  - a SELL stop rounds down
 *
 * `direction` is `'up' | 'down' | 'nearest'`.
 */
export function roundPrice(
  value: number,
  tickSize: number,
  decimals: number,
  direction: 'up' | 'down' | 'nearest' = 'nearest',
): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const ratio = value / tickSize;
  const factor = direction === 'up' ? Math.ceil(ratio - 1e-9) : direction === 'down' ? Math.floor(ratio + 1e-9) : Math.round(ratio);
  return Number((factor * tickSize).toFixed(decimals));
}

/* -------------------------------------------------------------------------- */
/*  Symbol registry                                                            */
/* -------------------------------------------------------------------------- */

/** Contracts whose risk profile warrants the BTC/ETH-tier limits. */
function pickFilter(symbol: BinanceSymbol, type: string): string | undefined {
  return symbol.filters.find((f) => f.filterType === type)?.tickSize
    ?? symbol.filters.find((f) => f.filterType === type)?.stepSize
    ?? undefined;
}

function minNotionalOf(symbol: BinanceSymbol): number {
  const notionalFilter = symbol.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
  if (notionalFilter) {
    const raw = notionalFilter.notional ?? notionalFilter.minNotional;
    if (raw !== undefined) return Number(raw);
  }
  return 5; // Binance's documented default floor
}

function toSymbolInfo(symbol: BinanceSymbol): SymbolInfo {
  const tickSize = pickFilter(symbol, 'PRICE_FILTER') ?? '0.01';
  const stepSize = pickFilter(symbol, 'LOT_SIZE') ?? '0.001';
  const minQty = symbol.filters.find((f) => f.filterType === 'LOT_SIZE')?.minQty ?? '0';
  const maxQty = symbol.filters.find((f) => f.filterType === 'LOT_SIZE')?.maxQty ?? '0';

  return {
    symbol: symbol.symbol,
    baseAsset: symbol.baseAsset,
    quoteAsset: symbol.quoteAsset,
    status: symbol.status,
    pricePrecision: symbol.pricePrecision,
    quantityPrecision: symbol.quantityPrecision,
    tickSize: Number(tickSize),
    stepSize: Number(stepSize),
    minQty: Number(minQty),
    maxQty: Number(maxQty),
    minNotional: minNotionalOf(symbol),
    contractSize: 1,
  };
}

/**
 * Cached view of `/fapi/v1/exchangeInfo`.
 *
 * Every order the bot sends is rounded through this registry first, which is
 * what prevents the `-1111` (precision) and `-4164` (min notional) rejects that
 * otherwise waste a cycle.
 */
export class SymbolRegistry {
  private readonly bySymbol = new Map<string, SymbolInfo>();
  private loadedAt = 0;

  constructor(list: SymbolInfo[]) {
    for (const info of list) this.bySymbol.set(info.symbol, info);
    this.loadedAt = Date.now();
  }

  static fromExchangeInfo(info: BinanceExchangeInfo): SymbolRegistry {
    const tradable = info.symbols.filter(
      (s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT',
    );
    return new SymbolRegistry(tradable.map(toSymbolInfo));
  }

  get size(): number {
    return this.bySymbol.size;
  }
  get ageMs(): number {
    return Date.now() - this.loadedAt;
  }

  /** All tradable USDT-margined perpetuals. */
  all(): SymbolInfo[] {
    return [...this.bySymbol.values()];
  }

  symbols(): string[] {
    return [...this.bySymbol.keys()];
  }

  get(symbol: string): SymbolInfo | undefined {
    return this.bySymbol.get(normalizeSymbol(symbol));
  }

  /** Throw rather than trade a symbol we know nothing about. */
  require(symbol: string): SymbolInfo {
    const info = this.get(symbol);
    if (!info) throw new Error(`Unknown or non-tradable futures symbol: ${symbol}`);
    return info;
  }

  isMajor(symbol: string): boolean {
    return sharedIsMajor(normalizeSymbol(symbol));
  }

  /* ---------------------------------------------------------------------- */
  /*  Order-shaping helpers                                                  */
  /* ---------------------------------------------------------------------- */

  priceDecimals(symbol: string): number {
    return stepDecimals(String(this.require(symbol).tickSize));
  }

  quantityDecimals(symbol: string): number {
    return stepDecimals(String(this.require(symbol).stepSize));
  }

  /** Floor a quantity to a valid, tradable amount. Returns 0 when too small. */
  roundQuantity(symbol: string, quantity: number): number {
    const info = this.require(symbol);
    const decimals = stepDecimals(String(info.stepSize));
    const rounded = roundDownToStep(quantity, info.stepSize, decimals);
    if (rounded < info.minQty) return 0;
    if (info.maxQty > 0 && rounded > info.maxQty) {
      return roundDownToStep(info.maxQty, info.stepSize, decimals);
    }
    return rounded;
  }

  /**
   * Ceil a quantity to a valid, tradable amount —— 「**上取一档**」那个方向。
   *
   * ## 为什么需要它（`roundQuantity` 只肯向下）
   *
   * 向下取整是对的默认：多买一点就是多冒一点风险。但**恰好掉到门槛之下**时，
   * 向下就变成了"白白放掉一次机会"，而那本来是"差一档"的问题。
   *
   * 实测（用户的原话：「仅仅差了 0.53，这是不是模型计算问题？这种系统是否给
   * 一定容错帮他补齐？（不然导致错失机会？）」）：ETHUSDT 报 $22.00 名义、
   * 价格 2768.18、`stepSize` 0.001 —— `$22 / 2768.18 = 0.007947`，
   * **向下取整 0.007 = $19.47**，差 $0.53 没够到 $20 的门槛，整笔被拒。
   * 而**上取一档是 0.008 = $22.15** —— 只比模型要的多 0.7%。
   *
   * ⚠️ **它只负责"对齐到一档"，不负责判断该不该进位。** 那个判断在风控引擎里，
   * 而且要连带检查名义比例上限与保证金上限 —— 见 `engine.ts` 里用它那一段。
   */
  roundQuantityUp(symbol: string, quantity: number): number {
    if (!Number.isFinite(quantity) || quantity <= 0) return 0;
    const info = this.require(symbol);
    const decimals = stepDecimals(String(info.stepSize));
    const ratio = quantity / info.stepSize;
    /*
     * ⚠️ **`floor + 1`，不是 `ceil`。**
     *
     * `ceil` 是"向上对齐"，而**已经落在档位上的数量对齐之后还是它自己** ——
     * 传 0.007 进去拿回 0.007，功能看起来像没生效。这里要的是"**再进一格**"。
     */
    const next = Number(((Math.floor(ratio + 1e-9) + 1) * info.stepSize).toFixed(decimals));
    /* 超出 `maxQty` 时**返回 0 而不是夹到上限** —— 夹过去会变成"比要求的多很多"。 */
    if (next < info.minQty || (info.maxQty > 0 && next > info.maxQty)) return 0;
    return next;
  }

  roundPriceValue(symbol: string, price: number, direction: 'up' | 'down' | 'nearest' = 'nearest'): number {
    const info = this.require(symbol);
    return roundPrice(price, info.tickSize, stepDecimals(String(info.tickSize)), direction);
  }

  /**
   * Round a limit price to a valid tick.
   *
   * `direction` decides which way to land when the value is not already a
   * multiple: `down` for a sell limit (do not improve the price), `up` for a buy.
   */
  roundLimitPrice(symbol: string, price: number, direction: 'up' | 'down' | 'nearest' = 'nearest'): number {
    const info = this.require(symbol);
    return roundPrice(price, info.tickSize, stepDecimals(String(info.tickSize)), direction);
  }

  /**
   * Round a **conditional** order's trigger price to a valid tick *and* keep it
   * on the side of the market the order type requires.
   *
   * Both halves are mandatory, and omitting the first is a live bug this codebase
   * shipped once: Binance rejects an unrounded trigger with `-1111 Precision is
   * over the maximum defined for this asset`, which means **the stop loss is
   * never placed at all**. The risk engine only guarantees the *side*; tick
   * alignment is the exchange adapter's job.
   *
   * Rounding can also push the value across the market, which Binance rejects
   * with `-2021` — so after rounding we step one tick back to the safe side when
   * needed.
   *
   * Trigger semantics (Binance, USDⓈ-M):
   *   STOP / STOP_MARKET            BUY: price >= trigger   SELL: price <= trigger
   *   TAKE_PROFIT / TAKE_PROFIT_MARKET  BUY: price <= trigger   SELL: price >= trigger
   */
  roundTriggerPrice(
    symbol: string,
    value: number,
    type: string,
    side: 'BUY' | 'SELL',
    marketPrice?: number,
  ): number {
    const info = this.require(symbol);
    const decimals = stepDecimals(String(info.tickSize));
    const step = info.tickSize;

    const isStop = type === 'STOP' || type === 'STOP_MARKET';
    // A stop sits on the losing side; a take-profit on the winning side.
    const mustBeBelow = isStop ? side === 'SELL' : side === 'BUY';

    let rounded = roundToStep(value, step, decimals);
    if (!(rounded > 0)) return rounded;

    if (marketPrice !== undefined && marketPrice > 0) {
      /*
       * 只修正「原始触发价原本在安全侧（或恰好贴着市价 1 个 tick 内），仅因 tick 取整踩线」的情形：
       *   · 一步退回到安全侧最近 tick（不受旧版 maxSteps=1000 限制）；
       *   · 若原始 `value` 本来就明确位于错误一侧（超过 1 个 tick，如卖单止损 70000 > 市价 68000），
       *     保留 `rounded` 交由 `broker.placeOrder` 的 `isValidTrigger()` 明确拒绝「会立即触发」，
       *     绝不悄悄把错方向止损拉到市价边上下单。
       */
      const onCorrectSide = mustBeBelow ? rounded < marketPrice : rounded > marketPrice;
      const inputNearOrValid = mustBeBelow ? value <= marketPrice + step : value >= marketPrice - step;
      if (!onCorrectSide && inputNearOrValid) {
        if (mustBeBelow) {
          let candidate = roundPrice(marketPrice, step, decimals, 'down');
          if (candidate >= marketPrice) candidate = roundToStep(candidate - step, step, decimals);
          rounded = candidate > 0 ? candidate : rounded;
        } else {
          let candidate = roundPrice(marketPrice, step, decimals, 'up');
          if (candidate <= marketPrice) candidate = roundToStep(candidate + step, step, decimals);
          rounded = candidate;
        }
      }
    }
    return Number(rounded.toFixed(Math.max(decimals, 0)));
  }

  /** True when a trigger price sits on the side Binance requires. */
  isValidTrigger(triggerPrice: number, type: string, side: 'BUY' | 'SELL', marketPrice: number): boolean {
    if (!(triggerPrice > 0) || !(marketPrice > 0)) return false;
    const isStop = type === 'STOP' || type === 'STOP_MARKET';
    const mustBeBelow = isStop ? side === 'SELL' : side === 'BUY';
    return mustBeBelow ? triggerPrice < marketPrice : triggerPrice > marketPrice;
  }

  /**
   * Convert a desired notional (USDT) into a valid contract quantity.
   * Returns 0 when the resulting order would fall below the exchange minimum.
   */
  notionalToQuantity(symbol: string, notionalUsd: number, price: number): number {
    if (!Number.isFinite(price) || price <= 0) return 0;
    return this.roundQuantity(symbol, notionalUsd / price);
  }

  /** True when a notional clears the exchange's MIN_NOTIONAL filter. */
  meetsMinNotional(symbol: string, notionalUsd: number): boolean {
    return notionalUsd >= this.require(symbol).minNotional;
  }

  /** Lower bound on the notional a single order must have. */
  minNotional(symbol: string): number {
    return this.require(symbol).minNotional;
  }
}

/* -------------------------------------------------------------------------- */
/*  Symbol normalisation                                                       */
/* -------------------------------------------------------------------------- */

// `normalizeSymbol` / `baseAssetOf` live in `@aq/shared` so that the strategy
// engine and the console canonicalise symbols identically. Re-exported here for
// convenience so Binance-layer call sites keep their imports short.

