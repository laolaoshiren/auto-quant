/**
 * Binance USDⓈ-M Futures wire types.
 *
 * Field names mirror the exchange payloads exactly, including Binance's own
 * camelCase inconsistencies, so that no translation layer is needed when
 * reading a response.
 */

import { EXCHANGE_ERROR_LABELS } from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  exchangeInfo                                                               */
/* -------------------------------------------------------------------------- */

export interface BinanceFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  maxQty?: string;
  minNotional?: string;
  notional?: string;
  multiplierUp?: string;
  multiplierDown?: string;
  multiplierDecimal?: string;
  limit?: number;
}

export interface BinanceSymbol {
  symbol: string;
  pair: string;
  contractType: string;
  deliveryDate: number;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  baseAssetPrecision: number;
  quotePrecision: number;
  underlyingType: string;
  filters: BinanceFilter[];
  orderTypes: string[];
  timeInForce: string[];
}

export interface BinanceExchangeInfo {
  exchangeFilters: unknown[];
  rateLimits: Array<{
    rateLimitType: string;
    interval: string;
    intervalNum: number;
    limit: number;
  }>;
  serverTime: number;
  symbols: BinanceSymbol[];
}

/* -------------------------------------------------------------------------- */
/*  Account / positions                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One asset row of `/fapi/v3/account` (and `/fapi/v2/account`).
 *
 * Field names below were verified against a **live account response**, not taken
 * from documentation: the wallet balance field is `walletBalance`, there is no
 * `accountAlias`, and `unrealizedProfit` is spelled with a lower-case `r` here —
 * whereas `/fapi/v2/positionRisk` uses `unRealizedProfit` with a capital one.
 * Reading the wrong spelling yields `undefined`, which silently becomes `0`.
 */
export interface BinanceBalanceV3 {
  asset: string;
  /** Settled balance. **Not** `balance` — that field does not exist. */
  walletBalance: string;
  /** Lower-case `r`, unlike `positionRisk`'s `unRealizedProfit`. */
  unrealizedProfit: string;
  marginBalance: string;
  maintMargin: string;
  initialMargin: string;
  positionInitialMargin: string;
  openOrderInitialMargin: string;
  crossWalletBalance: string;
  crossUnPnl: string;
  availableBalance: string;
  maxWithdrawAmount: string;
  /** Present on v2; absent from the v3 payload. */
  marginAvailable?: boolean;
  updateTime: number;
}

/**
 * `/fapi/v3/account` position row.
 *
 * Note this is a *different shape* from `/fapi/v2/positionRisk`: it carries no
 * mark price and no liquidation price, which is why the trading loop reads
 * positions from `positionRisk` and only reads balances from here.
 */
export interface BinanceAccountPositionV3 {
  symbol: string;
  initialMargin: string;
  maintMargin: string;
  unrealizedProfit: string;
  positionInitialMargin: string;
  openOrderInitialMargin: string;
  leverage: string;
  isolated: boolean;
  entryPrice: string;
  breakEvenPrice?: string;
  maxNotional: string;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  positionAmt: string;
  notional: string;
  isolatedWallet: string;
  updateTime: number;
  bidNotional?: string;
  askNotional?: string;
}

export interface BinanceAccountV3 {
  totalInitialMargin: string;
  totalMaintMargin: string;
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  totalPositionInitialMargin: string;
  totalOpenOrderInitialMargin: string;
  totalCrossWalletBalance: string;
  totalCrossUnPnl: string;
  availableBalance: string;
  maxWithdrawAmount: string;
  assets: BinanceBalanceV3[];
  positions: BinanceAccountPositionV3[];
  /** Present on v2 only. */
  canTrade?: boolean;
  canDeposit?: boolean;
  canWithdraw?: boolean;
  feeTier?: number;
  multiAssetsMargin?: boolean;
  updateTime?: number;
}

export interface BinancePositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  breakEvenPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  maxNotionalValue: string;
  marginType: 'cross' | 'isolated';
  isolatedMargin: string;
  isAutoAddMargin: string;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  notional: string;
  isolatedWallet: string;
  updateTime: number;
  adlQuantile?: number;
}

/* -------------------------------------------------------------------------- */
/*  Market data                                                                */
/* -------------------------------------------------------------------------- */

export interface BinanceTicker24h {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  lastPrice: string;
  lastQty: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  openTime: number;
  closeTime: number;
  count: number;
}

export interface BinancePremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  interestRate: string;
  time: number;
}

export interface BinanceOpenInterest {
  openInterest: string;
  symbol: string;
  time: number;
}

export interface BinanceOpenInterestHist {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

/** `/fapi/v1/klines` returns a positional array, not an object. */
export type BinanceKlineTuple = [
  openTime: number,
  open: string,
  high: string,
  low: string,
  close: string,
  volume: string,
  closeTime: number,
  quoteAssetVolume: string,
  numberOfTrades: number,
  takerBuyBaseAssetVolume: string,
  takerBuyQuoteAssetVolume: string,
  ignore: string,
];

/* -------------------------------------------------------------------------- */
/*  Orders                                                                     */
/* -------------------------------------------------------------------------- */

export type BinanceOrderType =
  | 'LIMIT'
  | 'MARKET'
  | 'STOP'
  | 'STOP_MARKET'
  | 'TAKE_PROFIT'
  | 'TAKE_PROFIT_MARKET'
  | 'TRAILING_STOP_MARKET';

export type BinanceOrderSide = 'BUY' | 'SELL';
export type BinanceTimeInForce = 'GTC' | 'IOC' | 'FOK' | 'GTX' | 'GTD';
export type BinanceWorkingType = 'MARK_PRICE' | 'CONTRACT_PRICE';

export interface BinanceOrderResponse {
  clientOrderId: string;
  cumQty: string;
  cumQuote: string;
  executedQty: string;
  orderId: number;
  avgPrice: string;
  origQty: string;
  price: string;
  reduceOnly: boolean;
  side: BinanceOrderSide;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  status: BinanceOrderStatus;
  stopPrice: string;
  closePosition: boolean;
  symbol: string;
  timeInForce: BinanceTimeInForce;
  type: BinanceOrderType;
  origType: BinanceOrderType;
  activatePrice?: string;
  priceRate?: string;
  updateTime: number;
  workingType: BinanceWorkingType;
  priceProtect: boolean;
  /** Present on query responses, absent on placement responses. */
  time?: number;
  updateId?: number;
}

export type BinanceOrderStatus =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'EXPIRED_IN_MATCH';

/* -------------------------------------------------------------------------- */
/*  Algo (conditional) orders                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Conditional orders live on a **separate endpoint** with a **separate identity
 * space**. `POST /fapi/v1/order` rejects `STOP_MARKET` / `TAKE_PROFIT_MARKET` /
 * `STOP` / `TAKE_PROFIT` / `TRAILING_STOP_MARKET` with `-4120`, and the trigger
 * parameter is named `triggerPrice` rather than `stopPrice`.
 *
 * The practical consequences that shape the rest of this codebase:
 *  - an algo order has `algoId` + `clientAlgoId` and `algoStatus`, not
 *    `orderId` + `clientOrderId` and `status`;
 *  - `algoId` is self-incrementing **per symbol**, so it is only meaningful
 *    together with the symbol;
 *  - entry and its stop/target can no longer be placed in one batch request, so
 *    the stop is placed first and verified before the target.
 */
export interface BinanceAlgoOrderResponse {
  algoId: number;
  clientAlgoId: string;
  algoType: string;
  orderType: BinanceOrderType;
  symbol: string;
  side: BinanceOrderSide;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  timeInForce: BinanceTimeInForce;
  quantity: string;
  algoStatus: BinanceAlgoStatus;
  triggerPrice: string;
  price: string;
  icebergQuantity?: string;
  closePosition: boolean;
  reduceOnly: boolean;
  workingType: BinanceWorkingType;
  priceProtect: boolean;
  activatePrice?: string;
  callbackRate?: string;
  /** Populated once the condition fires and a real order is created. */
  actualOrderId?: string;
  actualPrice?: string;
  actualType?: string;
  actualQty?: string;
  createTime: number;
  updateTime: number;
  triggerTime: number;
  goodTillDate?: number;
}

export type BinanceAlgoStatus =
  | 'NEW'
  | 'CANCELED'
  | 'TRIGGERED'
  | 'FINISHED'
  | 'EXPIRED'
  | 'REJECTED';


export interface BinanceUserTrade {
  symbol: string;
  id: number;
  orderId: number;
  side: BinanceOrderSide;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  price: string;
  qty: string;
  quoteQty: string;
  realizedPnl: string;
  marginAsset: string;
  commission: string;
  commissionAsset: string;
  time: number;
  maker: boolean;
  buyer: boolean;
}

export interface BinanceIncome {
  symbol: string;
  incomeType: string;
  income: string;
  asset: string;
  time: number;
  info: string;
  tranId: number;
  tradeId: string;
}

/* -------------------------------------------------------------------------- */
/*  WebSocket payloads                                                         */
/* -------------------------------------------------------------------------- */

export interface BinanceWsKlineEvent {
  e: 'kline';
  E: number;
  s: string;
  k: {
    t: number;
    T: number;
    s: string;
    i: string;
    f: number;
    L: number;
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;
    n: number;
    x: boolean;
    q: string;
    V: string;
    Q: string;
    B: string;
  };
}

export interface BinanceWsMarkPriceEvent {
  e: 'markPriceUpdate';
  E: number;
  s: string;
  p: string;
  i: string;
  P: string;
  r: string;
  T: number;
}

export interface BinanceWsOrderTradeEvent {
  e: 'ORDER_TRADE_UPDATE';
  E: number;
  T: number;
  o: {
    s: string;
    c: string;
    S: BinanceOrderSide;
    o: BinanceOrderType;
    f: BinanceTimeInForce;
    q: string;
    p: string;
    ap: string;
    sp: string;
    x: string;
    X: BinanceOrderStatus;
    i: number;
    l: string;
    z: string;
    L: string;
    n: string;
    N: string;
    T: number;
    t: number;
    b: string;
    a: string;
    m: boolean;
    R: boolean;
    wt: BinanceWorkingType;
    ot: BinanceOrderType;
    ps: 'BOTH' | 'LONG' | 'SHORT';
    cp: boolean;
    AP: string;
    cr: string;
    rp: string;
    pP: boolean;
    si: number;
    ss: number;
    V: string;
    pm: string;
    gtd: number;
  };
}

export interface BinanceWsAccountUpdateEvent {
  e: 'ACCOUNT_UPDATE';
  E: number;
  T: number;
  a: {
    m: string;
    B: Array<{ a: string; wb: string; cw: string; bc: string }>;
    P: Array<{
      s: string;
      pa: string;
      ep: string;
      bep: string;
      cr: string;
      up: string;
      mt: string;
      iw: string;
      ps: 'BOTH' | 'LONG' | 'SHORT';
    }>;
  };
}

export interface BinanceWsMarginCallEvent {
  e: 'MARGIN_CALL';
  E: number;
  cw: string;
  p: Array<{
    s: string;
    ps: 'BOTH' | 'LONG' | 'SHORT';
    pa: string;
    mt: string;
    iw: string;
    mp: string;
    up: string;
    mm: string;
  }>;
}

export interface BinanceWsListenKeyExpiredEvent {
  e: 'listenKeyExpired';
  E: number;
  listenKey: string;
}

export interface BinanceWsAccountConfigUpdateEvent {
  e: 'ACCOUNT_CONFIG_UPDATE';
  E: number;
  T: number;
  ac?: { s: string; l: number };
  ai?: { j: boolean };
}

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

export interface BinanceErrorBody {
  code: number;
  msg: string;
}

/**
 * Binance signals throttling with HTTP 429 and, on repeat offences,
 * 418 + IP ban. `retryAfterSeconds` is parsed from the `Retry-After` header.
 */
export class BinanceApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus: number,
    readonly retryAfterSeconds: number | null = null,
    readonly endpoint = '',
  ) {
    /*
     * ⚠️ **这是所有交易所报错的唯一成型点 —— 所以中文翻译在这里做一次就够。**
     *
     * 原来拼的是 `Binance -4164: Order's notional must be no smaller than 5
     * (unless you choose reduce only). (/fapi/v1/order)` —— 给开发者看的。
     * 而操作员在**六个不同的地方**会看到这条字符串（决策流、决策审计、
     * 决策详情、订单表……）：操作员看到它既不知道发生了什么、也不知道该不该动手。
     *
     * 我一开始是在那些显示处逐个翻译 —— **那是错的做法**：
     * 漏掉一处就还是英文，而这正是"不能一劳永逸"的原因。
     * 在源头翻译一次，所有显示它的地方自动都是中文。
     *
     * **错误码必须保留**（括号里那一段）：排查、对交易所文档、以及
     * `isRateLimited` / `isTimestampError` 这些判定都靠它。
     */
    const explained = EXCHANGE_ERROR_LABELS[String(code)];
    super(
      explained
        ? `${explained}（币安错误码 ${code}，接口 ${endpoint}）`
        : `币安错误 ${code}：${message}（接口 ${endpoint}）`,
    );
    this.name = 'BinanceApiError';
  }

  /** Timestamp drift — the request must be re-signed with a fresh offset. */
  get isTimestampError(): boolean {
    // -1021 is the gateway check; -5028 is a *second* recvWindow check performed
    // at the matching engine, so a request can pass the gateway and still be
    // rejected here. Both are fixed by re-syncing the clock and retrying once.
    return this.code === -1021 || this.code === -5028;
  }

  /** Too many requests / banned. */
  get isRateLimited(): boolean {
    return this.httpStatus === 429 || this.httpStatus === 418 || this.code === -1003;
  }

  /** Insufficient margin to place the order. */
  get isInsufficientMargin(): boolean {
    return this.code === -2019 || this.code === -2018;
  }

  /** Quantity/price violates the symbol filters. */
  get isFilterError(): boolean {
    return [-1111, -4014, -4164, -1100, -1102, -4003, -1013].includes(this.code);
  }

  /** The symbol is not tradable / does not exist. */
  get isSymbolError(): boolean {
    return this.code === -1121 || this.code === -4141;
  }

  /**
   * A conditional order was sent to the wrong endpoint. This must never be
   * swallowed: it means the position would be left without a stop.
   */
  get isWrongEndpointForConditional(): boolean {
    return this.code === -4120;
  }

  /** The trigger price is already on the wrong side of the market. */
  get wouldImmediatelyTrigger(): boolean {
    return this.code === -2021 || this.code === -4142;
  }

  /** The client order id was already used — a retry reached the server. */
  get isDuplicateClientId(): boolean {
    return this.code === -4116 || this.code === -1007 || this.code === -1006;
  }
}
