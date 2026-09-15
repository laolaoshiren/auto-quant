import type { PositionSide } from '@aq/shared';
import { createLogger } from '../logger.js';
import { fetchAccountState, type AccountState } from './account.js';
import type { BinanceMarketData } from './market.js';
import type { BinanceRest } from './rest.js';
import { fetchIncome, type IncomeSummary } from './income.js';
import { normalizeSymbol, type SymbolRegistry } from './symbols.js';
import {
  BinanceApiError,
  type BinanceAccountV3,
  type BinanceAlgoOrderResponse,
  type BinanceAlgoStatus,
  type BinanceOrderResponse,
  type BinanceOrderSide,
  type BinanceOrderStatus,
  type BinanceOrderType,
  type BinancePositionRisk,
  type BinanceUserTrade,
  type BinanceIncome,
} from './types.js';

const log = createLogger('binance:broker');

/* -------------------------------------------------------------------------- */
/*  Domain shapes returned by the broker                                       */
/* -------------------------------------------------------------------------- */

// `AccountState` now lives in `./account.ts` so a balance can be read without
// bootstrapping a symbol registry. Re-exported here for callers that already
// import it from the broker.
export type { AccountState } from './account.js';

export interface ExchangePosition {
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  liquidationPrice: number | null;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  marginUsed: number;
  notional: number;
  marginType: 'cross' | 'isolated';
}

/** The order types that must be sent to the Algo Order API. */
export const CONDITIONAL_ORDER_TYPES: ReadonlySet<string> = new Set([
  'STOP',
  'STOP_MARKET',
  'TAKE_PROFIT',
  'TAKE_PROFIT_MARKET',
  'TRAILING_STOP_MARKET',
]);

export type OrderType = 'MARKET' | 'LIMIT' | BinanceOrderType;

export interface PlaceOrderRequest {
  symbol: string;
  side: BinanceOrderSide;
  type: OrderType;
  quantity?: number;
  price?: number;
  /**
   * The price at which a conditional order fires.
   *
   * Named `triggerPrice` because that is what the Algo Order API expects;
   * `stopPrice` survives only in order *responses*.
   */
  triggerPrice?: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  reduceOnly?: boolean;
  /**
   * `closePosition` makes the order close whatever the position size is at
   * trigger time. Mutually exclusive with `quantity` and `reduceOnly`; this is
   * the right choice for a bot's stop and target because it can never be left
   * behind as a partial residual.
   */
  closePosition?: boolean;
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
  priceProtect?: boolean;
  clientOrderId?: string;
}

/**
 * A normalised handle for a placed order.
 *
 * Regular and algo orders have different identity spaces (`orderId` vs
 * `algoId`, `clientOrderId` vs `clientAlgoId`, `status` vs `algoStatus`).
 * Collapsing them here means the trading loop never has to branch on which
 * endpoint was used, which is where subtle bugs would otherwise live.
 */
export interface PlacedOrder {
  kind: 'order' | 'algo';
  /** `orderId` for regular orders, `algoId` for algo orders. */
  id: string;
  clientId: string;
  symbol: string;
  side: BinanceOrderSide;
  type: string;
  status: string;
  avgPrice: number;
  executedQty: number;
  /** True once the order can no longer change state. */
  terminal: boolean;
  raw: BinanceOrderResponse | BinanceAlgoOrderResponse;
}

export interface BrokerOptions {
  /** Simulate order placement while still reading real account data. */
  dryRun?: boolean;
  /** How long `waitForFill` polls before giving up. */
  fillTimeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/*  Broker                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * High-level Binance USDⓈ-M futures trading interface.
 *
 * Five pieces of hard-won correctness live here:
 *
 *  1. **Conditional orders go to the Algo Order API.** `POST /fapi/v1/order`
 *     rejects every conditional type with `-4120`. Getting this wrong means
 *     entries are opened with no stop loss at all, which is the single most
 *     dangerous failure this system can have.
 *  2. **One-way position mode.** Orders are sent with `positionSide=BOTH` and
 *     never with a signed quantity, because in one-way mode the sign of the
 *     amount is what encodes direction.
 *  3. **`closePosition` protection.** Stops and targets cover the whole position
 *     unconditionally, and Binance's prohibition on combining that flag with
 *     `quantity` or `reduceOnly` is enforced automatically.
 *  4. **Stale-order hygiene.** `closePosition` algo orders survive a manual
 *     close and would fire into a flat book, opening a fresh position in the
 *     opposite direction. Every manual exit cancels both regular *and* algo
 *     orders for the symbol first.
 *  5. **Never blind-retry an order.** An ambiguous outcome is reconciled by
 *     client id rather than resent.
 */
export class BinanceBroker {
  private readonly dryRun: boolean;
  private readonly fillTimeoutMs: number;

  constructor(
    private readonly rest: BinanceRest,
    private readonly market: BinanceMarketData,
    private readonly registry: SymbolRegistry,
    options: BrokerOptions = {},
  ) {
    this.dryRun = options.dryRun ?? false;
    this.fillTimeoutMs = options.fillTimeoutMs ?? 10_000;
  }

  get isDryRun(): boolean {
    return this.dryRun;
  }

  /* ---------------------------------------------------------------------- */
  /*  Account                                                                */
  /* ---------------------------------------------------------------------- */

  async getAccountState(): Promise<AccountState> {
    return fetchAccountState(this.rest);
  }

  /** Position mode: `true` when the account is in hedge (dual-side) mode. */
  async isHedgeMode(): Promise<boolean> {
    const response = await this.rest.signedRequest<{ dualSidePosition: boolean }>(
      'GET',
      '/fapi/v1/positionSide/dual',
    );
    return response.dualSidePosition === true;
  }

  /**
   * Force one-way mode, the only mode this bot reasons about.
   * Binance refuses the change while any position or open order exists.
   */
  async ensureOneWayMode(): Promise<{ changed: boolean; warning: string | null }> {
    if (this.dryRun) return { changed: false, warning: null };
    const hedge = await this.isHedgeMode();
    if (!hedge) return { changed: false, warning: null };

    const positions = await this.getPositions();
    const openOrders = (await this.getOpenOrders().catch(() => [])).length;
    const openAlgo = (await this.getOpenAlgoOrders().catch(() => [])).length;
    if (positions.length > 0 || openOrders > 0 || openAlgo > 0) {
      return {
        changed: false,
        warning:
          '账户当前是双向持仓模式。请先清空所有持仓与挂单，然后重启机器人，它才能切换为单向持仓模式。',
      };
    }

    try {
      await this.rest.signedRequest('POST', '/fapi/v1/positionSide/dual', {
        dualSidePosition: 'false',
      });
      log.info('账户已切换为单向持仓模式');
      return { changed: true, warning: null };
    } catch (error) {
      return {
        changed: false,
        warning: `无法切换为单向持仓模式：${(error as Error).message}`,
      };
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Positions                                                              */
  /* ---------------------------------------------------------------------- */

  /** Open positions only — Binance returns a row for every symbol it knows. */
  async getPositions(symbol?: string): Promise<ExchangePosition[]> {
    const rows = await this.rest.signedRequest<BinancePositionRisk[]>(
      'GET',
      '/fapi/v2/positionRisk',
      symbol ? { symbol: normalizeSymbol(symbol) } : {},
    );

    const results: ExchangePosition[] = [];
    for (const row of rows) {
      const quantity = Number(row.positionAmt) || 0;
      if (quantity === 0) continue;

      const entryPrice = Number(row.entryPrice) || 0;
      const markPrice = Number(row.markPrice) || 0;
      const unrealizedPnl = Number(row.unRealizedProfit) || 0;
      const leverage = Number(row.leverage) || 1;
      const notional = Math.abs(Number(row.notional) || markPrice * Math.abs(quantity));

      // In one-way mode the sign of positionAmt carries the direction and
      // positionSide is always BOTH.
      const side: PositionSide = row.positionSide === 'SHORT' || quantity < 0 ? 'short' : 'long';

      // `/fapi/v2/positionRisk` exposes no initial-margin field, so derive it.
      const marginUsed =
        row.marginType === 'isolated' ? Math.abs(Number(row.isolatedWallet) || 0) : notional / leverage;

      const liquidationPrice = Number(row.liquidationPrice);

      results.push({
        symbol: row.symbol,
        side,
        quantity: Math.abs(quantity),
        entryPrice,
        markPrice,
        leverage,
        liquidationPrice:
          Number.isFinite(liquidationPrice) && liquidationPrice > 0 ? liquidationPrice : null,
        unrealizedPnl,
        unrealizedPnlPercent: marginUsed > 0 ? (unrealizedPnl / marginUsed) * 100 : 0,
        marginUsed,
        notional,
        marginType: row.marginType,
      });
    }
    return results;
  }

  /* ---------------------------------------------------------------------- */
  /*  Leverage & margin                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Set leverage for a symbol.
   *
   * `-4046` ("no need to change leverage") is benign; `-4168` means open orders
   * block the change, which is not fatal because sizing is clamped anyway.
   */
  async setLeverage(
    symbol: string,
    leverage: number,
  ): Promise<{ ok: boolean; leverage: number; note?: string }> {
    const normalized = normalizeSymbol(symbol);
    if (this.dryRun) return { ok: true, leverage };

    const current = await this.getPositions(normalized);
    if (current.length > 0) {
      return {
        ok: false,
        leverage: current[0]?.leverage ?? leverage,
        note: `${normalized} 已有持仓，杠杆保持不变`,
      };
    }

    try {
      const response = await this.rest.signedRequest<{ leverage: number; symbol: string }>(
        'POST',
        '/fapi/v1/leverage',
        { symbol: normalized, leverage },
      );
      return { ok: true, leverage: Number(response.leverage) || leverage };
    } catch (error) {
      if (error instanceof BinanceApiError) {
        if (error.code === -4046) return { ok: true, leverage };
        if (error.code === -4168) {
          return {
            ok: false,
            leverage,
            note: `${normalized} 有挂单未成交，杠杆保持不变`,
          };
        }
      }
      throw error;
    }
  }

  /** Set margin type for a symbol. Cannot change while positions are open. */
  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<boolean> {
    if (this.dryRun) return true;
    const normalized = normalizeSymbol(symbol);
    try {
      await this.rest.signedRequest('POST', '/fapi/v1/marginType', {
        symbol: normalized,
        marginType,
      });
      return true;
    } catch (error) {
      if (error instanceof BinanceApiError && error.code === -4046) return true;
      if (error instanceof BinanceApiError && error.code === -4047) return false;
      log.warn(`setMarginType(${normalized}, ${marginType}) failed: ${(error as Error).message}`);
      return false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Order placement                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Place an order of any type, routing conditional types to the Algo API.
   *
   * **Every value is normalised here, before it leaves the process.** Quantity is
   * floored to `stepSize`, limit and trigger prices are snapped to `tickSize`,
   * and a trigger is kept on the side of the market its order type requires.
   *
   * This is deliberately not the caller's responsibility. A previous version
   * trusted the risk engine to have produced valid numbers — but the risk engine
   * only guarantees the *direction* of a stop, not its tick alignment, so the
   * exchange rejected every stop with `-1111 Precision is over the maximum
   * defined for this asset` and positions ran unprotected. The adapter is the
   * only layer that both knows the symbol filters and is on the path of every
   * order, which makes it the right place for this.
   */
  async placeOrder(request: PlaceOrderRequest): Promise<PlacedOrder> {
    const symbol = normalizeSymbol(request.symbol);
    const isConditional = CONDITIONAL_ORDER_TYPES.has(request.type);

    const normalised: PlaceOrderRequest = { ...request, symbol };

    // Quantity: always floor, so rounding can never ask for more than intended.
    if (typeof request.quantity === 'number' && request.quantity > 0) {
      const rounded = this.registry.roundQuantity(symbol, request.quantity);
      if (rounded <= 0) {
        throw new Error(
          `${symbol} 的下单数量 ${request.quantity} 按步长 ${this.registry.require(symbol).stepSize} 取整后为 0`,
        );
      }
      normalised.quantity = rounded;
    }

    if (isConditional) {
      if (!(request.triggerPrice && request.triggerPrice > 0)) {
        throw new Error(`条件单 ${request.type} 缺少触发价`);
      }
      // The mark price is needed to keep the trigger on the correct side after
      // rounding, so fetch it rather than assuming.
      const markPrice = await this.getMarkPrice(symbol).catch(() => 0);
      normalised.triggerPrice = this.registry.roundTriggerPrice(
        symbol,
        request.triggerPrice,
        request.type,
        request.side,
        markPrice,
      );

      if (!this.registry.isValidTrigger(normalised.triggerPrice, request.type, request.side, markPrice)) {
        // Refuse locally with a clear message rather than letting Binance answer
        // `-2021 Order would immediately trigger`, which says nothing about why.
        throw new Error(
          `${symbol} 的 ${request.type} 触发价 ${normalised.triggerPrice} 会立即触发（当前标记价 ${markPrice}），已拒绝下单`,
        );
      }
    } else if (typeof request.price === 'number' && request.price > 0) {
      // A buy limit must not round up into a worse price, nor a sell limit down.
      normalised.price = this.registry.roundLimitPrice(
        symbol,
        request.price,
        request.side === 'BUY' ? 'down' : 'up',
      );
    }

    if (isConditional) return this.placeAlgoOrder(normalised as PlaceOrderRequest & { symbol: string });
    return this.placeStandardOrder(normalised as PlaceOrderRequest & { symbol: string });
  }

  private async placeStandardOrder(request: PlaceOrderRequest & { symbol: string }): Promise<PlacedOrder> {
    const params: Record<string, unknown> = {
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      // One-way mode: always BOTH. Never send a signed quantity.
      positionSide: 'BOTH',
      newClientOrderId: request.clientOrderId,
    };

    if (request.type === 'MARKET') {
      // `quoteOrderQty` is not supported on USDⓈ-M futures; `quantity` is required.
      params.quantity = request.quantity;
      if (request.reduceOnly) params.reduceOnly = true;
    } else {
      params.quantity = request.quantity;
      params.price = request.price;
      params.timeInForce = request.timeInForce ?? 'GTC';
      params.reduceOnly = request.reduceOnly ?? false;
    }

    if (this.dryRun) return this.simulateStandard(request);

    const response = await this.rest.signedRequest<BinanceOrderResponse>(
      'POST',
      '/fapi/v1/order',
      params,
    );
    log.debug(`order ${request.type} ${request.side} ${request.symbol} → ${response.status}`, {
      orderId: response.orderId,
      qty: response.origQty,
      avgPrice: response.avgPrice,
    });
    return normalizeStandard(response);
  }

  /**
   * Place a conditional order on the Algo Order API.
   *
   * `closePosition=true` must not be combined with `quantity` or `reduceOnly`,
   * so those are stripped rather than sent and rejected.
   */
  private async placeAlgoOrder(request: PlaceOrderRequest & { symbol: string }): Promise<PlacedOrder> {
    const params: Record<string, unknown> = {
      algoType: 'CONDITIONAL',
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      positionSide: 'BOTH',
      // The Algo API calls this `triggerPrice`; `stopPrice` is response-only now.
      triggerPrice: request.triggerPrice,
      workingType: request.workingType ?? 'MARK_PRICE',
      priceProtect: request.priceProtect ?? true,
      clientAlgoId: request.clientOrderId,
    };

    if (request.closePosition) {
      params.closePosition = true;
    } else {
      params.quantity = request.quantity;
      params.reduceOnly = request.reduceOnly ?? true;
    }

    if (this.dryRun) return this.simulateAlgo(request);

    const response = await this.rest.signedRequest<BinanceAlgoOrderResponse>(
      'POST',
      '/fapi/v1/algoOrder',
      params,
    );
    log.debug(
      `algo ${request.type} ${request.side} ${request.symbol} trigger=${response.triggerPrice} → ${response.algoStatus}`,
      { algoId: response.algoId, closePosition: response.closePosition },
    );
    return normalizeAlgo(response);
  }

  /* ---------------------------------------------------------------------- */
  /*  Order queries                                                          */
  /* ---------------------------------------------------------------------- */

  async getOpenOrders(symbol?: string): Promise<BinanceOrderResponse[]> {
    return this.rest.signedRequest<BinanceOrderResponse[]>(
      'GET',
      '/fapi/v1/openOrders',
      symbol ? { symbol: normalizeSymbol(symbol) } : {},
    );
  }

  /**
   * Open algo orders. Weight 1 with a symbol, **40 without** — so this is always
   * called per symbol.
   */
  async getOpenAlgoOrders(symbol?: string): Promise<BinanceAlgoOrderResponse[]> {
    const response = await this.rest.signedRequest<BinanceAlgoOrderResponse[] | { orders?: BinanceAlgoOrderResponse[] }>(
      'GET',
      '/fapi/v1/openAlgoOrders',
      symbol ? { symbol: normalizeSymbol(symbol), algoType: 'CONDITIONAL' } : { algoType: 'CONDITIONAL' },
    );
    if (Array.isArray(response)) return response;
    return response.orders ?? [];
  }

  /**
   * Query a single algo order, including ones that are no longer open.
   *
   * This is the **only** reliable way to tell a stop that fired from a target
   * that fired: once the position closes, Binance removes the surviving
   * `closePosition` order too, so both ids disappear from `openAlgoOrders` and
   * their absence cannot distinguish them. The triggered order reports
   * `FINISHED` (or `TRIGGERED`); the other reports `CANCELED`/`EXPIRED`.
   */
  async getAlgoOrder(algoId: number): Promise<BinanceAlgoOrderResponse | null> {
    if (this.dryRun) return null;
    try {
      return await this.rest.signedRequest<BinanceAlgoOrderResponse>('GET', '/fapi/v1/algoOrder', {
        algoId,
      });
    } catch (error) {
      log.debug(`getAlgoOrder(${algoId}) failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** Poll a regular order until it reaches a terminal state. */
  async waitForFill(order: PlacedOrder, timeoutMs = this.fillTimeoutMs): Promise<PlacedOrder> {
    if (this.dryRun || order.terminal) return order;

    const deadline = Date.now() + timeoutMs;
    let latest = order;
    let delay = 250;

    while (Date.now() < deadline) {
      await sleep(delay);
      delay = Math.min(delay * 1.5, 1500);
      try {
        latest =
          order.kind === 'order'
            ? normalizeStandard(
                await this.rest.signedRequest<BinanceOrderResponse>('GET', '/fapi/v1/order', {
                  symbol: order.symbol,
                  orderId: Number(order.id),
                }),
              )
            : normalizeAlgo(
                await this.rest.signedRequest<BinanceAlgoOrderResponse>('GET', '/fapi/v1/algoOrder', {
                  algoId: Number(order.id),
                }),
              );
      } catch (error) {
        log.debug(`poll for ${order.kind} ${order.id} failed: ${(error as Error).message}`);
        continue;
      }
      if (latest.terminal) return latest;
    }

    log.warn(`${order.kind} ${order.id} (${order.symbol}) not terminal after ${timeoutMs}ms`, {
      status: latest.status,
    });
    return latest;
  }

  /* ---------------------------------------------------------------------- */
  /*  Cancellation                                                           */
  /* ---------------------------------------------------------------------- */

  async cancelOrder(symbol: string, orderId: number, kind: 'order' | 'algo' = 'order'): Promise<boolean> {
    if (this.dryRun) return true;
    const normalized = normalizeSymbol(symbol);
    try {
      if (kind === 'algo') {
        await this.rest.signedRequest('DELETE', '/fapi/v1/algoOrder', {
          symbol: normalized,
          algoId: orderId,
        });
      } else {
        await this.rest.signedRequest('DELETE', '/fapi/v1/order', {
          symbol: normalized,
          orderId,
        });
      }
      return true;
    } catch (error) {
      // -2011 "Unknown order sent" means it already filled or was cancelled.
      if (error instanceof BinanceApiError && error.code === -2011) return true;
      log.warn(`cancelOrder(${symbol}, ${orderId}, ${kind}) failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Cancel every resting order for a symbol — **both** regular and algo.
   *
   * Called immediately before and after any manual exit. A leftover
   * `closePosition` algo order would otherwise fire into a flat book and open a
   * brand new position in the opposite direction.
   */
  async cancelAllOrders(symbol: string): Promise<void> {
    if (this.dryRun) return;
    const normalized = normalizeSymbol(symbol);

    const results = await Promise.allSettled([
      this.rest.signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: normalized }),
      // Separate endpoint: `allOpenOrders` does not touch algo orders.
      this.rest.signedRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol: normalized }),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        const error = result.reason as BinanceApiError;
        if (error instanceof BinanceApiError && error.code === -2011) continue;
        log.warn(`cancelAllOrders(${normalized}) partially failed: ${error.message ?? error}`);
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Fills                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Recent fills for a symbol, used to reconcile fees and realised PnL. */
  async getUserTrades(symbol: string, limit = 50): Promise<BinanceUserTrade[]> {
    if (this.dryRun) return [];
    return this.rest.signedRequest<BinanceUserTrade[]>('GET', '/fapi/v1/userTrades', {
      symbol: normalizeSymbol(symbol),
      limit,
    });
  }

  /**
   * The account's income ledger — realised PnL, commission, funding, transfers.
   *
   * The runtime reads it to discover symbols it may have missed and to attribute
   * funding fees, neither of which is visible in the order flow.
   */
  async getIncome(options: {
    startTime: number;
    endTime?: number;
    symbol?: string;
    incomeType?: string;
  }): Promise<BinanceIncome[]> {
    if (this.dryRun) return [];
    return fetchIncome(this.rest, options);
  }

  /** Mark price straight from the exchange — used to price fallback stops. */
  async getMarkPrice(symbol: string): Promise<number> {
    const [premium] = await this.market.premiumIndex(symbol);
    const value = Number(premium?.markPrice);
    if (Number.isFinite(value) && value > 0) return value;
    const [ticker] = await this.market.ticker24h(symbol);
    return Number(ticker?.lastPrice) || 0;
  }

  /* ---------------------------------------------------------------------- */
  /*  Dry-run simulation                                                     */
  /* ---------------------------------------------------------------------- */

  private async simulateStandard(request: PlaceOrderRequest & { symbol: string }): Promise<PlacedOrder> {
    const markPrice = (await this.getMarkPrice(request.symbol)) || request.price || 0;
    const at = Date.now();
    const qty = request.quantity ?? 0;

    log.info(
      `[dry-run] ${request.type} ${request.side} ${request.symbol} qty=${qty} @ ~${markPrice}`,
    );

    const response: BinanceOrderResponse = {
      clientOrderId: request.clientOrderId ?? `dry-${at}`,
      cumQty: String(qty),
      cumQuote: String(qty * markPrice),
      executedQty: String(qty),
      orderId: at,
      avgPrice: String(markPrice),
      origQty: String(qty),
      price: String(request.price ?? 0),
      reduceOnly: request.reduceOnly ?? false,
      side: request.side,
      positionSide: 'BOTH',
      status: 'FILLED',
      stopPrice: '0',
      closePosition: false,
      symbol: request.symbol,
      timeInForce: request.timeInForce ?? 'GTC',
      type: request.type as BinanceOrderType,
      origType: request.type as BinanceOrderType,
      updateTime: at,
      workingType: 'MARK_PRICE',
      priceProtect: false,
    };
    return normalizeStandard(response);
  }

  private async simulateAlgo(request: PlaceOrderRequest & { symbol: string }): Promise<PlacedOrder> {
    const at = Date.now();
    log.info(
      `[dry-run] algo ${request.type} ${request.side} ${request.symbol} trigger=${request.triggerPrice} closePosition=${request.closePosition ?? false}`,
    );

    const response: BinanceAlgoOrderResponse = {
      algoId: at,
      clientAlgoId: request.clientOrderId ?? `dry-algo-${at}`,
      algoType: 'CONDITIONAL',
      orderType: request.type as BinanceOrderType,
      symbol: request.symbol,
      side: request.side,
      positionSide: 'BOTH',
      timeInForce: 'GTC',
      quantity: String(request.quantity ?? 0),
      algoStatus: 'NEW',
      triggerPrice: String(request.triggerPrice ?? 0),
      price: '0',
      closePosition: request.closePosition ?? false,
      reduceOnly: request.reduceOnly ?? false,
      workingType: request.workingType ?? 'MARK_PRICE',
      priceProtect: request.priceProtect ?? true,
      createTime: at,
      updateTime: at,
      triggerTime: 0,
    };
    return normalizeAlgo(response);
  }
}

/* -------------------------------------------------------------------------- */
/*  Normalisation                                                              */
/* -------------------------------------------------------------------------- */

const TERMINAL_ORDER_STATUSES: ReadonlySet<BinanceOrderStatus> = new Set([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
]);

/** `TRIGGERED` is not terminal: the resulting order still has to fill. */
const TERMINAL_ALGO_STATUSES: ReadonlySet<BinanceAlgoStatus> = new Set([
  'FINISHED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);

export function normalizeStandard(response: BinanceOrderResponse): PlacedOrder {
  return {
    kind: 'order',
    id: String(response.orderId),
    clientId: response.clientOrderId,
    symbol: response.symbol,
    side: response.side,
    type: response.type,
    status: response.status,
    avgPrice: Number(response.avgPrice) || 0,
    executedQty: Number(response.executedQty) || 0,
    terminal: TERMINAL_ORDER_STATUSES.has(response.status),
    raw: response,
  };
}

export function normalizeAlgo(response: BinanceAlgoOrderResponse): PlacedOrder {
  return {
    kind: 'algo',
    id: String(response.algoId),
    clientId: response.clientAlgoId,
    symbol: response.symbol,
    side: response.side,
    type: response.orderType,
    status: response.algoStatus,
    // An untriggered algo order has no fill; `actualPrice` appears once it fires.
    avgPrice: Number(response.actualPrice ?? 0) || 0,
    executedQty: Number(response.actualQty ?? 0) || 0,
    terminal: TERMINAL_ALGO_STATUSES.has(response.algoStatus),
    raw: response,
  };
}

export function isFilled(order: PlacedOrder): boolean {
  return order.executedQty > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
