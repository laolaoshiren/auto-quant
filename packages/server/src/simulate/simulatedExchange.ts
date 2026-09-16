import type { CloseReason, PositionSide } from '@aq/shared';
import type {
  BinanceBroker,
  BrokerOptions,
  ExchangePosition,
  PlacedOrder,
} from '../binance/broker.js';
import type { SymbolRegistry } from '../binance/symbols.js';
import type {
  BinanceAlgoOrderResponse,
  BinanceIncome,
  BinanceOrderResponse,
  BinanceUserTrade,
} from '../binance/types.js';
import { createLogger } from '../logger.js';

const log = createLogger('sim:exchange');

/* -------------------------------------------------------------------------- */
/*  Trade log                                                                  */
/* -------------------------------------------------------------------------- */

export interface SimulatedFill {
  at: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  purpose: 'entry' | 'exit' | 'stop_loss' | 'take_profit' | 'adjustment';
  type: string;
  quantity: number;
  price: number;
  fee: number;
  notional: number;
  /**
   * The exchange order id this fill belongs to.
   *
   * Carried so that `getUserTrades` returns ids the trading loop can match
   * against the order it just placed — which is how commission and realised PnL
   * get attached. A simulation that returned unrelated ids would silently make
   * every fee zero.
   */
  orderId: string;
  /** Populated on the closing side. */
  pnl?: number;
  closeReason?: CloseReason;
}

export interface SimulatedPriceStep {
  at: number;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/* -------------------------------------------------------------------------- */
/*  Position book                                                              */
/* -------------------------------------------------------------------------- */

interface SimPosition {
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  leverage: number;
  marginUsed: number;
  /** Resting conditional orders, keyed by the id we handed back. */
  protection: Map<string, { kind: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'; triggerPrice: number }>;
  openedAt: number;
  peakPnlPercent: number;
}

export interface SimulatedExchangeOptions {
  registry: SymbolRegistry;
  startingBalance: number;
  /** Binance USDⓈ-M taker fee, as a fraction. */
  takerFeeRate?: number;
  /** How the triggering price is derived from a candle. */
  triggerMode?: 'intrabar' | 'close';
}

/**
 * A simulated USDⓈ-M futures exchange.
 *
 * This is not a stub: it maintains a real position book with margin, fills
 * market orders, and — critically — **actually triggers resting stop-loss and
 * take-profit orders when price crosses them**, using the intrabar high/low so
 * that a stop which would have been hit inside a candle is not missed.
 *
 * That behaviour is the whole point. The most dangerous class of bug in this
 * system is a position that opens but never gets its protection attached, or
 * protection that fires and is never booked as a trade. Neither can be found by
 * testing the risk engine in isolation — they only appear when price moves.
 */
export class SimulatedExchange {
  private balance: number;
  private readonly positions = new Map<string, SimPosition>();
  private readonly fills: SimulatedFill[] = [];
  private readonly feeRate: number;
  private readonly triggerMode: 'intrabar' | 'close';

  /** Price currently being simulated, per symbol. */
  private readonly marks = new Map<string, number>();
  private readonly candles = new Map<string, SimulatedPriceStep>();
  /**
   * Final status of algo orders that are no longer resting.
   *
   * Modelled explicitly because it is the only way to tell which of a position's
   * two protection orders actually fired: Binance removes the survivor as well,
   * so "it is not in the open list" is equally true of both. Getting this wrong
   * books every take-profit as a stop loss.
   */
  private readonly resolvedAlgo = new Map<string, 'FINISHED' | 'CANCELED'>();
  private nextId = 700_000;
  /** Simulated wall-clock, advanced by the replay driver. */
  private now = Date.now();

  constructor(private readonly options: SimulatedExchangeOptions) {
    this.balance = options.startingBalance;
    this.feeRate = options.takerFeeRate ?? 0.0005;
    this.triggerMode = options.triggerMode ?? 'intrabar';
  }

  get log_(): readonly SimulatedFill[] {
    return this.fills;
  }

  get startBalance(): number {
    return this.options.startingBalance;
  }

  /* ---------------------------------------------------------------------- */
  /*  Price advance + protection triggering                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the simulated market by one candle.
   *
   * The order of operations mirrors reality: the candle's high/low are examined
   * for a trigger **before** the close is adopted as the new mark, so a stop that
   * was breached mid-candle fires.
   */
  advance(step: SimulatedPriceStep): void {
    this.now = step.at;
    this.candles.set(step.symbol, step);
    this.marks.set(step.symbol, step.close);

    const position = this.positions.get(step.symbol);
    if (!position) return;

    const hit = this.findTrigger(position, step);
    if (!hit) {
      this.updatePeak(position, step.close);
      return;
    }

    this.closePosition(position, hit.price, hit.reason, hit.orderId);
  }

  /**
   * Which resting protection, if any, did this candle trigger?
   *
   * Long positions stop out on the way down and target on the way up; shorts are
   * mirrored. When a candle spans both levels we resolve the stop first — the
   * conservative assumption, and the one that avoids flattering the results.
   */
  private findTrigger(
    position: SimPosition,
    step: SimulatedPriceStep,
  ): { price: number; reason: CloseReason; orderId: string } | null {
    const isLong = position.side === 'long';
    const low = this.triggerMode === 'intrabar' ? step.low : step.close;
    const high = this.triggerMode === 'intrabar' ? step.high : step.close;

    let stop: { id: string; price: number } | null = null;
    let target: { id: string; price: number } | null = null;
    for (const [id, order] of position.protection) {
      if (order.kind === 'STOP_MARKET') stop = { id, price: order.triggerPrice };
      else target = { id, price: order.triggerPrice };
    }

    if (stop) {
      const breached = isLong ? low <= stop.price : high >= stop.price;
      // A gap through the stop fills at the open, not at the stop price — the
      // slippage is real and worth modelling.
      if (breached) {
        const fillPrice = isLong
          ? Math.min(stop.price, step.open > stop.price ? step.open : stop.price)
          : Math.max(stop.price, step.open < stop.price ? step.open : stop.price);
        return { price: fillPrice, reason: 'stop_loss', orderId: stop.id };
      }
    }
    if (target) {
      const breached = isLong ? high >= target.price : low <= target.price;
      if (breached) {
        return { price: target.price, reason: 'take_profit', orderId: target.id };
      }
    }
    return null;
  }

  private updatePeak(position: SimPosition, markPrice: number): void {
    const pnlPercent = this.unrealizedPercent(position, markPrice);
    if (pnlPercent > position.peakPnlPercent) position.peakPnlPercent = pnlPercent;
  }

  private unrealizedPercent(position: SimPosition, markPrice: number): number {
    if (position.marginUsed <= 0) return 0;
    const isLong = position.side === 'long';
    const pnl = (isLong ? markPrice - position.entryPrice : position.entryPrice - markPrice) * position.quantity;
    return (pnl / position.marginUsed) * 100;
  }

  private closePosition(position: SimPosition, price: number, reason: CloseReason, orderId: string): void {
    const isLong = position.side === 'long';
    const pnl = (isLong ? price - position.entryPrice : position.entryPrice - price) * position.quantity;
    const fee = price * position.quantity * this.feeRate;

    // A stop or target closes the whole position via `closePosition=true`, so the
    // resting protection disappears with it: the one that fired is FINISHED and
    // any survivor is CANCELED.
    for (const id of position.protection.keys()) {
      this.resolvedAlgo.set(id, id === orderId ? 'FINISHED' : 'CANCELED');
    }
    position.protection.clear();
    this.balance += pnl - fee;
    this.positions.delete(position.symbol);

    this.fills.push({
      at: this.now,
      symbol: position.symbol,
      side: isLong ? 'SELL' : 'BUY',
      purpose: reason === 'stop_loss' ? 'stop_loss' : 'take_profit',
      type: reason === 'stop_loss' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
      quantity: position.quantity,
      price,
      fee,
      notional: price * position.quantity,
      orderId,
      pnl: pnl - fee,
      closeReason: reason,
    });

    log.info(
      `[sim] ${position.symbol} ${reason === 'stop_loss' ? '触发止损' : '触发止盈'} @ ${price} → ${pnl - fee >= 0 ? '+' : ''}${(pnl - fee).toFixed(2)} USDT`,
      { orderId },
    );
  }

  /* ---------------------------------------------------------------------- */
  /*  Broker surface                                                         */
  /* ---------------------------------------------------------------------- */

  /** Equity = realised balance + unrealised PnL at the current marks. */
  private equity(): number {
    let equity = this.balance;
    for (const position of this.positions.values()) {
      const mark = this.marks.get(position.symbol) ?? position.entryPrice;
      const isLong = position.side === 'long';
      equity += (isLong ? mark - position.entryPrice : position.entryPrice - mark) * position.quantity;
    }
    return equity;
  }

  private marginUsed(): number {
    let used = 0;
    for (const position of this.positions.values()) used += position.marginUsed;
    return used;
  }

  async getAccountState() {
    const equity = this.equity();
    const margin = this.marginUsed();
    return {
      equity,
      walletBalance: this.balance,
      availableBalance: Math.max(0, equity - margin),
      unrealizedPnl: equity - this.balance,
      marginUsed: margin,
      openOrderMargin: 0,
    };
  }

  async getPositions(symbol?: string): Promise<ExchangePosition[]> {
    const rows: ExchangePosition[] = [];
    for (const position of this.positions.values()) {
      if (symbol && position.symbol !== symbol) continue;
      const mark = this.marks.get(position.symbol) ?? position.entryPrice;
      const isLong = position.side === 'long';
      const unrealized = (isLong ? mark - position.entryPrice : position.entryPrice - mark) * position.quantity;
      rows.push({
        symbol: position.symbol,
        side: position.side,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        markPrice: mark,
        leverage: position.leverage,
        liquidationPrice: isLong ? position.entryPrice * 0.6 : position.entryPrice * 1.4,
        unrealizedPnl: unrealized,
        unrealizedPnlPercent: position.marginUsed > 0 ? (unrealized / position.marginUsed) * 100 : 0,
        marginUsed: position.marginUsed,
        notional: mark * position.quantity,
        marginType: 'cross',
      });
    }
    return rows;
  }

  async setLeverage(_symbol: string, leverage: number) {
    return { ok: true, leverage };
  }

  async setMarginType() {
    return true;
  }

  async isHedgeMode() {
    return false;
  }

  async ensureOneWayMode() {
    return { changed: false, warning: null };
  }

  async placeOrder(request: Parameters<BinanceBroker['placeOrder']>[0]): Promise<PlacedOrder> {
    const symbol = request.symbol;
    const id = String(this.nextId++);
    const mark = this.marks.get(symbol);
    if (!mark || mark <= 0) throw new Error(`模拟交易所没有 ${symbol} 的价格`);

    const isConditional =
      request.type === 'STOP_MARKET' || request.type === 'TAKE_PROFIT_MARKET';

    if (isConditional) {
      const position = this.positions.get(symbol);
      if (!position) throw new Error(`${symbol} 没有持仓，无法挂保护单`);
      if (!(request.triggerPrice && request.triggerPrice > 0)) {
        throw new Error('条件单缺少触发价');
      }

      // Binance rejects a stop on the wrong side of the market with -2021, and
      // the simulation mirrors that so the bot hits it in testing, not in
      // production.
      const isLong = position.side === 'long';
      const isStop = request.type === 'STOP_MARKET';
      const valid = isStop
        ? isLong
          ? request.triggerPrice < mark
          : request.triggerPrice > mark
        : isLong
          ? request.triggerPrice > mark
          : request.triggerPrice < mark;
      if (!valid) {
        throw new Error(
          `模拟交易所拒绝：触发价 ${request.triggerPrice} 会立即触发（标记价 ${mark}）`,
        );
      }

      /*
       * Snap the trigger price to the symbol's tick — the **broker's** job.
       *
       * This class stands in for `BinanceBroker` in the trading pipeline, so it
       * has to have the same contract. The real broker rounds quantity to
       * `stepSize` and trigger prices to `tickSize` before sending, precisely
       * because Binance answers `-1111 Precision is over the maximum defined for
       * this asset` otherwise and the stop is never placed.
       *
       * An earlier version of this method *rejected* off-tick prices instead of
       * rounding them. That modelled the wrong layer: Binance never sees an
       * off-tick price from a correct client, so the simulation became stricter
       * than reality and `npm run sim` failed 13/15 on scenarios the real system
       * handles fine.
       *
       * The regression guard for "did the broker forget to round?" lives where it
       * belongs — `binance/orders.test.ts` asserts that `BinanceBroker.placeOrder`
       * sends a tick-aligned trigger. Asserting it here would test the wrong code
       * path, since the simulation never calls the real broker.
       */
      const rawTrigger = request.triggerPrice;
      const triggerPrice = this.options.registry.roundTriggerPrice(
        symbol,
        rawTrigger,
        request.type,
        request.side,
        mark,
      );
      if (!(triggerPrice > 0)) {
        throw new Error(`模拟交易所拒绝：${symbol} 的触发价 ${rawTrigger} 取整后为 0`);
      }
      // The rounded value must still sit on the correct side of the market; this
      // mirrors the broker's post-rounding validation.
      if (!this.options.registry.isValidTrigger(triggerPrice, request.type, request.side, mark)) {
        throw new Error(
          `模拟交易所拒绝：触发价 ${triggerPrice} 会立即触发（标记价 ${mark}）（-2021）`,
        );
      }

      position.protection.set(id, {
        kind: request.type as 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
        triggerPrice,
      });

      const raw: BinanceAlgoOrderResponse = {
        algoId: Number(id),
        clientAlgoId: request.clientOrderId ?? id,
        algoType: 'CONDITIONAL',
        orderType: request.type as BinanceAlgoOrderResponse['orderType'],
        symbol,
        side: request.side,
        positionSide: 'BOTH',
        timeInForce: 'GTC',
        quantity: String(request.quantity ?? 0),
        algoStatus: 'NEW',
        triggerPrice: String(triggerPrice),
        price: '0',
        closePosition: request.closePosition ?? false,
        reduceOnly: request.reduceOnly ?? false,
        workingType: request.workingType ?? 'MARK_PRICE',
        priceProtect: request.priceProtect ?? true,
        createTime: this.now,
        updateTime: this.now,
        triggerTime: 0,
      };
      return {
        kind: 'algo',
        id,
        clientId: raw.clientAlgoId,
        symbol,
        side: request.side,
        type: request.type,
        status: 'NEW',
        avgPrice: 0,
        executedQty: 0,
        terminal: false,
        raw,
      };
    }

    /* --- Market / limit --------------------------------------------------- */
    const quantity = request.quantity ?? 0;
    if (quantity <= 0) throw new Error('下单数量为 0');

    const fee = mark * quantity * this.feeRate;

    if (request.reduceOnly) {
      const position = this.positions.get(symbol);
      if (!position) throw new Error(`${symbol} 没有可平的持仓`);
      const isLong = position.side === 'long';
      const pnl = (isLong ? mark - position.entryPrice : position.entryPrice - mark) * quantity;
      this.balance += pnl - fee;
      for (const id of position.protection.keys()) this.resolvedAlgo.set(id, 'CANCELED');
      position.protection.clear();
      this.positions.delete(symbol);
      this.fills.push({
        at: this.now,
        symbol,
        side: request.side,
        purpose: 'exit',
        type: request.type,
        quantity,
        price: mark,
        fee,
        notional: mark * quantity,
        orderId: id,
        pnl: pnl - fee,
        closeReason: 'model_decision',
      });
    } else {
      const leverage = 3;
      this.balance -= fee;
      this.positions.set(symbol, {
        symbol,
        side: request.side === 'BUY' ? 'long' : 'short',
        quantity,
        entryPrice: mark,
        leverage,
        marginUsed: (mark * quantity) / leverage,
        protection: new Map(),
        openedAt: this.now,
        peakPnlPercent: 0,
      });
      this.fills.push({
        at: this.now,
        symbol,
        side: request.side,
        purpose: 'entry',
        type: request.type,
        quantity,
        price: mark,
        fee,
        notional: mark * quantity,
        orderId: id,
      });
    }

    const raw: BinanceOrderResponse = {
      orderId: Number(id),
      clientOrderId: request.clientOrderId ?? id,
      symbol,
      side: request.side,
      type: request.type as BinanceOrderResponse['type'],
      status: 'FILLED',
      avgPrice: String(mark),
      executedQty: String(quantity),
      origQty: String(quantity),
      price: '0',
      cumQty: String(quantity),
      cumQuote: String(mark * quantity),
      reduceOnly: request.reduceOnly ?? false,
      positionSide: 'BOTH',
      stopPrice: '0',
      closePosition: false,
      timeInForce: 'GTC',
      origType: request.type as BinanceOrderResponse['origType'],
      updateTime: this.now,
      workingType: 'MARK_PRICE',
      priceProtect: false,
    };

    return {
      kind: 'order',
      id,
      clientId: raw.clientOrderId,
      symbol,
      side: request.side,
      type: request.type,
      status: 'FILLED',
      avgPrice: mark,
      executedQty: quantity,
      terminal: true,
      raw,
    };
  }

  async waitForFill(order: PlacedOrder) {
    return order;
  }

  /** Cancel every resting order for a symbol — both flavours, like the real broker. */
  async cancelAllOrders(symbol: string): Promise<void> {
    const position = this.positions.get(symbol);
    if (!position) return;
    for (const id of position.protection.keys()) this.resolvedAlgo.set(id, 'CANCELED');
    position.protection.clear();
  }

  /**
   * Query one algo order by id, including ones that are no longer open.
   *
   * This is what lets the trading loop distinguish "the stop fired" from "the
   * target fired" after the position is gone.
   */
  async getAlgoOrder(algoId: number): Promise<BinanceAlgoOrderResponse | null> {
    const id = String(algoId);

    for (const position of this.positions.values()) {
      const order = position.protection.get(id);
      if (!order) continue;
      return {
        algoId,
        clientAlgoId: id,
        algoType: 'CONDITIONAL',
        orderType: order.kind,
        symbol: position.symbol,
        side: position.side === 'long' ? 'SELL' : 'BUY',
        positionSide: 'BOTH',
        timeInForce: 'GTC',
        quantity: '0',
        algoStatus: 'NEW',
        triggerPrice: String(order.triggerPrice),
        price: '0',
        closePosition: true,
        reduceOnly: false,
        workingType: 'MARK_PRICE',
        priceProtect: true,
        createTime: this.now,
        updateTime: this.now,
        triggerTime: 0,
      };
    }

    const resolved = this.resolvedAlgo.get(id);
    if (!resolved) return null;

    // The symbol is gone from the book, so report it from the resolution map.
    return {
      algoId,
      clientAlgoId: id,
      algoType: 'CONDITIONAL',
      orderType: 'STOP_MARKET',
      symbol: this.candles.keys().next().value ?? '',
      side: 'SELL',
      positionSide: 'BOTH',
      timeInForce: 'GTC',
      quantity: '0',
      algoStatus: resolved,
      triggerPrice: '0',
      price: '0',
      closePosition: true,
      reduceOnly: false,
      workingType: 'MARK_PRICE',
      priceProtect: true,
      createTime: this.now,
      updateTime: this.now,
      triggerTime: this.now,
    };
  }

  /**
   * 挂着的**普通**委托。
   *
   * 模拟器只下市价单，而下单即成交 —— 所以这里永远是空的。它必须存在，是因为
   * `BinanceBroker` 的这个方法被交易循环用来回答"那张单还在不在交易所"：
   * 少了它，结清过期委托记录时按标的的读取会整体抛错，模拟运行就比现实更容易失败
   * （同一个道理写在 `placeOrder` 里关于触发价取整的那段注释上）。
   *
   * 条件单不走这里，它们在 `getOpenAlgoOrders()`。
   */
  async getOpenOrders(): Promise<BinanceOrderResponse[]> {
    return [];
  }

  async getOpenAlgoOrders(symbol?: string): Promise<BinanceAlgoOrderResponse[]> {
    const rows: BinanceAlgoOrderResponse[] = [];
    for (const position of this.positions.values()) {
      if (symbol && position.symbol !== symbol) continue;
      for (const [id, order] of position.protection) {
        rows.push({
          algoId: Number(id),
          clientAlgoId: id,
          algoType: 'CONDITIONAL',
          orderType: order.kind,
          symbol: position.symbol,
          side: position.side === 'long' ? 'SELL' : 'BUY',
          positionSide: 'BOTH',
          timeInForce: 'GTC',
          quantity: '0',
          algoStatus: 'NEW',
          triggerPrice: String(order.triggerPrice),
          price: '0',
          closePosition: true,
          reduceOnly: false,
          workingType: 'MARK_PRICE',
          priceProtect: true,
          createTime: this.now,
          updateTime: this.now,
          triggerTime: 0,
        });
      }
    }
    return rows;
  }

  /**
   * 回放里不存在资金费结算，所以**必须返回空数组**，而不是省略这个方法。
   *
   * `AutoTrader` 在平仓时会读一次 `/fapi/v1/income` 把资金费记进这一笔（§2.5）。
   * 方法缺失时每次平仓都会打一条 `getIncome is not a function` 的警告 ——
   * 降级行为本身是对的（记 0 并明确告警），但**模拟运行里刷出的一屏警告会把
   * 真正的问题淹掉**，而模拟的价值恰恰在于"出了异常一眼能看见"。
   *
   * 返回空数组表达的是"这段时间没有资金费"，语义正确，且与实际部署一致：
   * 一次 5 分钟的回放本来就跨不过 8 小时的结算点。
   */
  async getIncome(): Promise<BinanceIncome[]> {
    return [];
  }

  async getUserTrades(symbol: string, limit = 50): Promise<BinanceUserTrade[]> {
    return this.fills
      .filter((f) => f.symbol === symbol)
      .slice(-limit)
      .map((f) => ({
        symbol: f.symbol,
        id: Number(f.orderId),
        // Must match the id handed back from `placeOrder`, otherwise the trading
        // loop cannot attribute commission to the order it just sent.
        orderId: Number(f.orderId),
        side: f.side,
        positionSide: 'BOTH' as const,
        price: String(f.price),
        qty: String(f.quantity),
        quoteQty: String(f.notional),
        realizedPnl: String(f.pnl ?? 0),
        marginAsset: 'USDT',
        commission: String(f.fee),
        commissionAsset: 'USDT',
        time: f.at,
        maker: false,
        buyer: f.side === 'BUY',
      }));
  }

  async getMarkPrice(symbol: string): Promise<number> {
    return this.marks.get(symbol) ?? 0;
  }

  /** Latest candle, so a test can inspect what price the bot just saw. */
  lastCandle(symbol: string): SimulatedPriceStep | undefined {
    return this.candles.get(symbol);
  }

  /** Set a price without a candle, used for single-shot checks. */
  setMark(symbol: string, price: number): void {
    this.marks.set(symbol, price);
  }
}

export type { BrokerOptions };