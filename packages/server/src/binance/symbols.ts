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
 */
export function stepDecimals(step: string): number {
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
      // Step away from the market until the trigger is strictly on the required
      // side. A single step is not always enough (the market price itself need
      // not be tick-aligned), and stopping early would hand Binance a value it
      // rejects with `-2021`.
      const maxSteps = 1000;
      let steps = 0;
      while (steps < maxSteps) {
        const onCorrectSide = mustBeBelow ? rounded < marketPrice : rounded > marketPrice;
        if (onCorrectSide) break;
        rounded = roundToStep(rounded + (mustBeBelow ? -step : step), step, decimals);
        steps += 1;
        if (!(rounded > 0)) break;
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

