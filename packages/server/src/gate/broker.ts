/**
 * Gate.io USDT 永久合约的 `BrokerPort` 实现。
 *
 * ## 设计取舍：Gate 的"模拟盘"是测试网，不是本地模拟
 *
 * 币安的模拟盘（`dryRun`）是**本地撮合**（`BinanceBroker` 内部模拟成交）。
 * Gate 这边不重复那套：Gate 有官方的**合约测试网**（`api-testnet.gateapi.io`，
 * 假钱、真实撮合），用它比本地模拟更真实，也少一套需要与真实撮合对齐的逻辑。
 *
 * 所以：`isDryRun` 恒为 `false`，而"测试环境"由**账户的 `testnet` 字段**决定
 * （见 manager 的 `connectionFor`）。同一个 GateBroker 代码同时服务两种环境 ——
 * 上线正式网只是**换一个账户的 base URL**，不是改代码。
 *
 * ## 返回类型为什么是"币安形状"
 *
 * `BrokerPort` 由 `Pick<BinanceBroker, ...>` 定义（见 `trader/brokerPort.ts`），
 * 所以返回类型必须是 `BinanceOrderResponse` / `BinanceAlgoOrderResponse` 等。
 * 这不是笔误：交易循环对两个交易所要求**同一套形状**，差异在这里对齐掉。
 * 每个映射函数都明确写了"哪些字段是 Gate 没有的、给的是什么默认值"。
 */
import type {
  BinanceAlgoOrderResponse,
  BinanceIncome,
  BinanceOrderResponse,
  BinanceUserTrade,
} from '../binance/types.js';
import type { AccountState } from '../binance/account.js';
import type { ExchangePosition, PlaceOrderRequest, PlacedOrder, BrokerOptions } from '../binance/broker.js';
import { CONDITIONAL_ORDER_TYPES } from '../binance/broker.js';
import { createLogger } from '../logger.js';
import { GateAccountReader, GateContractRegistry, gateContractToSymbol, num, symbolToGateContract } from './account.js';
import { GateRest } from './rest.js';
import type {
  GateFuturesAccount,
  GateFuturesAccountBook,
  GateFuturesContract,
  GateFuturesFill,
  GateFuturesOrder,
} from './types.js';

const log = createLogger('gate:broker');

/**
 * Gate 的自定义客户端单号 **必须以 `t-` 开头**。
 *
 * 2026-11-11 服务器实测：限价开仓全部失败，Gate 返回
 * `HTTP 400 · INVALID_PARAM_VALUE: text not starting with \`t-\``。
 * 本系统的 clientOrderId 形如 `aq-entry-...`，直接传必被拒。
 * 前缀加上；已经是 `t-` 开头的原样保留（幂等）。
 */
function toGateOrderText(clientOrderId: string): string {
  const prefixed = clientOrderId.startsWith('t-') ? clientOrderId : `t-${clientOrderId}`;
  /*
   * Gate 的 text **限长 30 字符**（2026-11-11 实测：`text content length longer
   * than 30`）。`makeClientId` 给币安生成的是 36 —— 直接传必被拒。
   *
   * 截断是安全的：`makeClientId` 的唯一性来自**前缀后的时间戳+随机段**
   * （`prefix-<stamp><random>-<symbol>`），它落在前 ~21 字符内，30 字符
   * 足够保留全部唯一段，只丢掉尾部的符号可读性。
   */
  return prefixed.slice(0, 30);
}

/** 本系统的一侧（BUY/SELL 决定开平方向）→ Gate 的 `size` 符号。 */
function signedSize(side: 'BUY' | 'SELL', size: number): number {
  return side === 'BUY' ? Math.abs(size) : -Math.abs(size);
}

/** 币数 → Gate 张数（向下取整；转换不出可交易张数时返回 0）。 */
function toSize(quantity: number, contract: GateFuturesContract): number {
  const multiplier = num(contract.quanto_multiplier);
  if (!(multiplier > 0) || !(quantity > 0)) return 0;
  const stepRaw = num(contract.order_size_step ?? '1');
  const step = stepRaw > 0 ? stepRaw : 1;
  const stepped = Math.floor(quantity / multiplier / step) * step;
  const min = num(contract.order_size_min ?? '1');
  return stepped >= (min > 0 ? min : 1) ? stepped : 0;
}

/**
 * Gate 订单状态 → 币安状态（交易循环按币安词汇判断"还能不能变"）。
 *
 * Gate：`open`（挂单中）/ `finished`（全部成交）/ `cancelled`（已撤/部分成交后撤）。
 * 币安：`NEW` / `PARTIALLY_FILLED` / `FILLED` / `CANCELED`。
 */
function orderStatus(order: GateFuturesOrder): string {
  if (order.status === 'finished') return 'FILLED';
  if (order.status === 'cancelled') {
    /* Gate 用 `finish_as` 区分"用户撤的"与"自动撤的"（IOC 未成交、仓位不足等）。 */
    return order.finish_as === 'auto_deleveraged' ? 'EXPIRED' : 'CANCELED';
  }
  const left = Math.abs(order.left);
  const total = Math.abs(order.size);
  return left > 0 && left < total ? 'PARTIALLY_FILLED' : 'NEW';
}

/** Gate 订单 → `BinanceOrderResponse`（缺失字段给安全默认值，逐项注释在下面）。 */
export function gateOrderToBinanceResponse(
  order: GateFuturesOrder,
  contract: GateFuturesContract,
): BinanceOrderResponse {
  const multiplier = num(contract.quanto_multiplier) || 1;
  const size = Math.abs(order.size);
  const left = Math.abs(order.left);
  const filledSize = Math.max(0, size - left);
  const isMarket = num(order.price) === 0;
  return {
    clientOrderId: order.text ?? '',
    cumQty: String(filledSize * multiplier),
    cumQuote: String(filledSize * multiplier * num(order.fill_price ?? '0')),
    executedQty: String(filledSize * multiplier),
    orderId: order.id,
    avgPrice: order.fill_price && num(order.fill_price) > 0 ? order.fill_price : '0',
    origQty: String(size * multiplier),
    price: isMarket ? '0' : order.price,
    reduceOnly: order.is_reduce_only === true,
    side: order.size > 0 ? 'BUY' : 'SELL',
    /* Gate 的合约默认单向持仓（dual_mode=false）→ 币安侧对应 `BOTH`。 */
    positionSide: 'BOTH',
    status: orderStatus(order) as BinanceOrderResponse['status'],
    stopPrice: order.trigger ? order.trigger.price : '0',
    closePosition: order.is_close === true,
    symbol: gateContractToSymbol(order.contract),
    timeInForce: isMarket ? 'IOC' : 'GTC',
    type: (isMarket ? 'MARKET' : 'LIMIT') as BinanceOrderResponse['type'],
    origType: (isMarket ? 'MARKET' : 'LIMIT') as BinanceOrderResponse['origType'],
    /* Gate 不给以下三个字段 —— 给安全默认值（交易循环不依赖它们做判断）。 */
    updateTime: 0,
    workingType: 'MARK_PRICE',
    priceProtect: false,
  };
}

/** Gate 价格保护单（`price_orders`）→ `BinanceAlgoOrderResponse`。 */
export function gatePriceOrderToAlgoResponse(
  order: GateFuturesOrder,
  contract: GateFuturesContract,
): BinanceAlgoOrderResponse {
  const multiplier = num(contract.quanto_multiplier) || 1;
  /* price_orders 的契约/数量/价格在 `initial` 里（顶层没有，实测 undefined）。 */
  const initial = order.initial;
  const size = Math.abs(initial?.size ?? order.size);
  const left = Math.abs(initial?.size ?? order.left);
  const filledSize = Math.max(0, size - left);
  const rule = order.trigger?.rule ?? 1;
  const priceText = initial?.price ?? order.price;
  const contractName = initial?.contract ?? order.contract;
  return {
    algoId: order.id,
    clientAlgoId: order.text ?? '',
    algoType: 'CONDITIONAL',
    orderType: (num(priceText) === 0 ? 'MARKET' : 'LIMIT') as BinanceAlgoOrderResponse['orderType'],
    symbol: gateContractToSymbol(contractName ?? ''),
    side: (initial?.size ?? order.size) > 0 ? 'BUY' : 'SELL',
    positionSide: 'BOTH',
    timeInForce: 'GTC',
    quantity: String(size * multiplier),
    algoStatus: (order.status === 'finished'
      ? 'FINISHED'
      : order.status === 'cancelled'
        ? 'CANCELLED'
        : 'WORKING') as BinanceAlgoOrderResponse['algoStatus'],
    triggerPrice: order.trigger?.price ?? '0',
    price: priceText,
    closePosition: initial?.close === true || order.is_close === true,
    reduceOnly: initial?.reduce_only === true || order.is_reduce_only === true,
    workingType: 'MARK_PRICE',
    priceProtect: false,
    /* Gate 的触发方向：rule=1 价格上穿触发 / rule=2 下穿触发 —— 记录在 activatePrice 之外的语义里。 */
    activatePrice: String(rule),
    actualOrderId: order.finish_time ? String(order.id) : undefined,
    /* Gate 不单独给这些时间戳：用创建时间兜底（秒 → 毫秒）。 */
    createTime: Number(order.create_time) * 1000,
    updateTime: Number(order.finish_time ?? order.create_time) * 1000,
    triggerTime: 0,
  };
}

/** Gate 成交 → `BinanceUserTrade`。 */
export function gateFillToUserTrade(fill: GateFuturesFill, contract: GateFuturesContract): BinanceUserTrade {
  const multiplier = num(contract.quanto_multiplier) || 1;
  const price = num(fill.price);
  return {
    symbol: gateContractToSymbol(fill.contract),
    id: fill.id,
    orderId: fill.order_id ?? '',
    side: fill.size > 0 ? 'BUY' : 'SELL',
    positionSide: 'BOTH',
    price: fill.price,
    qty: String(Math.abs(fill.size) * multiplier),
    quoteQty: String(Math.abs(fill.size) * multiplier * price),
    /*
     * Gate 的成交行**不含 realizedPnl**（盈亏在 account_book 里按仓位结算）。
     * 这里给 '0' —— 交易循环拿它做"成交即记账"时，真正入账仍走 `bookClosedPosition`
     * （按持仓/均价算），不会依赖这个字段。
     */
    realizedPnl: '0',
    marginAsset: 'USDT',
    commission: fill.fee,
    commissionAsset: 'USDT',
    time: fill.create_time * 1000,
    maker: fill.role !== 'taker',
    buyer: fill.size > 0,
  };
}

/** Gate account_book → `BinanceIncome`。 */
export function gateBookToIncome(book: GateFuturesAccountBook): BinanceIncome {
  const typeMap: Record<string, string> = {
    funding: 'FUNDING_FEE',
    fee: 'COMMISSION',
    realised_pnl: 'REALIZED_PNL',
    fund: 'TRANSFER',
    auto_deleveraging: 'AUTO_EXCHANGE',
  };
  return {
    symbol: book.contract ? gateContractToSymbol(book.contract) : '',
    incomeType: typeMap[book.type] ?? book.type.toUpperCase(),
    income: book.change,
    asset: 'USDT',
    time: book.time * 1000,
    info: book.type,
  } as BinanceIncome;
}

export class GateBroker {
  readonly isDryRun = false;
  private readonly account: GateAccountReader;
  private readonly fillTimeoutMs: number;

  constructor(
    private readonly rest: GateRest,
    private readonly contracts: GateContractRegistry,
    options: BrokerOptions = {},
  ) {
    this.account = new GateAccountReader(rest, contracts);
    this.fillTimeoutMs = options.fillTimeoutMs ?? 10_000;
  }

  async getAccountState(): Promise<AccountState> {
    return this.account.balance();
  }

  async isHedgeMode(): Promise<boolean> {
    /*
     * ⚠️ **Gate 没有 `GET /futures/usdt/dual_mode`**（2026-11-11 实测 HTTP 405）。
     * 持仓模式由**账户响应**的 `in_dual_mode` 给出；设置才走 `POST dual_mode`。
     * 之前用 GET 查询 → 每轮都抛错 → 风控把每一单都拒掉（用户截图：
     * 「无法读取持仓模式…本轮没有任何下单」），Gate 机器人等于不能交易。
     *
     * 读不到 `in_dual_mode` 时按**单向**处理（Gate 新账户默认单向）：宁可放过，
     * 也不要因为一个可选字段缺失而让整个机器人停摆。真正不匹配时交易所会以
     * -4061 拒绝下单，那是一条能看懂的错误，比"每轮静默拒绝"好。
     */
    try {
      const account = await this.rest.signed<GateFuturesAccount>('GET', '/futures/usdt/accounts');
      return account.in_dual_mode === true;
    } catch (error) {
      log.warn(`[gate] 读取持仓模式失败，按单向处理：${(error as Error).message}`);
      return false;
    }
  }

  async ensureOneWayMode(): Promise<{ changed: boolean; warning: string | null }> {
    if (!(await this.isHedgeMode())) return { changed: false, warning: null };
    await this.rest.signed('POST', '/futures/usdt/dual_mode', { params: { dual_mode: 'false' } });
    return { changed: true, warning: 'Gate 账户原来是双向持仓，已切换为单向（本系统按单向运行）。' };
  }

  async getPositions(symbol?: string): Promise<ExchangePosition[]> {
    const all = await this.account.positions();
    return symbol ? all.filter((p) => p.symbol === symbol) : all;
  }

  async getMaxLeverage(symbol: string): Promise<number | null> {
    try {
      const contract = await this.contracts.get(symbolToGateContract(symbol));
      const max = num(contract.leverage_max);
      return max > 0 ? max : null;
    } catch {
      return null;
    }
  }

  /**
   * 设置杠杆（对齐 `BrokerPort`/`BinanceBroker.setLeverage` 的返回形状）。
   *
   * ## 为什么返回对象而不是 boolean
   *
   * 交易循环的 `executeOpen` 靠 `{ ok, leverage, note }` 决定：
   *   · `ok:false`（交易所不允许该杠杆/有挂单）→ **本笔放弃**，不在不知道实际杠杆的
   *     情况下开杠杆仓；
   *   · `leverage` 低于风控批准值（子账户/档位限制）→ 按比例缩小名义价值。
   * 只返回 `true/false` 会让"交易所实际给了多少杠杆"永远丢失 —— 那正是
   * 2026-11-10 修过的一类 bug（按批准杠杆记账、实际保证金超预算）。
   *
   * Gate 的 `POST /positions/{contract}/leverage` 响应里带 `leverage`；
   * 拒绝时（`INVALID_LEVERAGE` / 超过上限）返回 `ok:false`，让调用方安全放弃本笔。
   */
  async setLeverage(
    symbol: string,
    leverage: number,
  ): Promise<{ ok: boolean; leverage: number; note?: string }> {
    const contract = symbolToGateContract(symbol);
    const wanted = Math.trunc(leverage);
    try {
      const response = await this.rest.signed<{ leverage?: string | number }>(
        'POST',
        `/futures/usdt/positions/${contract}/leverage`,
        { params: { leverage: String(wanted) } },
      );
      const applied = num(response?.leverage);
      return { ok: true, leverage: applied > 0 ? applied : wanted };
    } catch (error) {
      const message = (error as Error).message;
      return {
        ok: false,
        leverage: 0,
        note: `Gate 设置 ${symbol} 杠杆 ${wanted}x 失败：${message}`,
      };
    }
  }

  /**
   * Gate 的逐仓/全仓切换接口与币安不同（且默认全仓），本系统交易循环只用单向全仓。
   * 返回 `false` = "没有发生切换"，调用方据此决定是否继续（不抛错）。
   */
  async setMarginType(): Promise<boolean> {
    return false;
  }

  async placeOrder(request: PlaceOrderRequest): Promise<PlacedOrder> {
    const contractName = symbolToGateContract(request.symbol);
    const contract = await this.contracts.get(contractName);
    const conditional = request.triggerPrice !== undefined && CONDITIONAL_ORDER_TYPES.has(request.type);
    if (conditional) return this.placeConditional(request, contract, contractName);

    const size = toSize(request.quantity ?? 0, contract);
    if (size === 0) throw new Error(`Gate 下单数量换算为 0 张（quantity=${request.quantity}，合约=${contractName}）。`);

    const body: Record<string, unknown> = {
      contract: contractName,
      size: signedSize(request.side, size),
      /* Gate：price=0 即市价单，且 tif 必须是 ioc。 */
      price: request.type === 'MARKET' ? '0' : String(request.price ?? 0),
      tif: request.type === 'MARKET' ? 'ioc' : 'gtc',
    };
    if (request.reduceOnly === true) body.reduce_only = true;
    if (request.clientOrderId) body.text = toGateOrderText(request.clientOrderId);

    const order = await this.rest.signed<GateFuturesOrder>('POST', '/futures/usdt/orders', { body });
    log.info(`[gate] 下单 ${request.symbol} ${request.side} ${size} 张 → #${order.id}`);
    const raw = gateOrderToBinanceResponse(order, contract);
    return {
      kind: 'order',
      id: String(order.id),
      clientId: order.text ?? '',
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status: raw.status,
      avgPrice: num(raw.avgPrice),
      executedQty: num(raw.executedQty),
      terminal: raw.status === 'FILLED' || raw.status === 'CANCELED' || raw.status === 'EXPIRED',
      raw,
    };
  }

  private async placeConditional(
    request: PlaceOrderRequest,
    contract: GateFuturesContract,
    contractName: string,
  ): Promise<PlacedOrder> {
    /*
     * ⚠️ **closePosition 条件单的 size 必须是 0**（2026-11-11 测试网实测：
     * 传持仓张数会得到 `AUTO_INVALID_PARAM_INITIAL_SIZE: close size must zero`）。
     * Gate 的语义是"触发时按当时的仓位全平"，所以它不需要、也不允许指定张数。
     */
    const closeAll = request.closePosition === true;
    const size = closeAll ? 0 : toSize(request.quantity ?? 0, contract);
    if (!closeAll && size === 0) {
      throw new Error(`Gate 条件单数量换算为 0 张（quantity=${request.quantity}，合约=${contractName}）。`);
    }
    const trigger = request.triggerPrice ?? 0;
    /*
     * Gate 的触发方向：rule=1（价格 ≥ 触发价时触发）/ rule=2（≤ 时触发）。
     * 本系统的语义：
     *   · 止损（STOP/STOP_MARKET）：多头在下方 → ≤ 触发（rule=2）；空头在上方 → ≥（rule=1）
     *   · 止盈（TAKE_PROFIT）：多头在上方 → ≥（rule=1）；空头在下方 → ≤（rule=2）
     * 判断用「平仓方向」：SELL 平多 → 止损在下（2）/止盈在上（1）；BUY 平空相反。
     */
    const isStop = request.type.startsWith('STOP');
    const closingLong = request.side === 'SELL';
    const rule = isStop ? (closingLong ? 2 : 1) : closingLong ? 1 : 2;
    const body = {
      initial: {
        contract: contractName,
        /* close 单必须 size=0（见上面那段实测说明）；否则按数量下单。 */
        size: closeAll ? 0 : signedSize(request.side, size),
        price: request.price !== undefined && request.price > 0 ? String(request.price) : '0',
        tif: request.price !== undefined && request.price > 0 ? 'gtc' : 'ioc',
        reduce_only: !closeAll,
        /* closePosition 语义在 Gate 叫 `close`（按触发时仓位全平）。 */
        close: closeAll,
      },
      trigger: { strategy: 0, price: String(trigger), rule },
    };
    if (request.clientOrderId) (body.initial as Record<string, unknown>).text = toGateOrderText(request.clientOrderId);
    const order = await this.rest.signed<GateFuturesOrder>('POST', '/futures/usdt/price_orders', { body });
    log.info(`[gate] 条件单 ${request.symbol} ${request.type} 触发 ${trigger} → #${order.id}`);
    const raw = gatePriceOrderToAlgoResponse(order, contract);
    return {
      kind: 'algo',
      id: String(order.id),
      clientId: request.clientOrderId ?? '',
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status: raw.algoStatus,
      avgPrice: 0,
      executedQty: 0,
      terminal: false,
      raw,
    };
  }

  async getOpenOrders(symbol?: string): Promise<BinanceOrderResponse[]> {
    const params: Record<string, string> = { status: 'open' };
    if (symbol) params.contract = symbolToGateContract(symbol);
    const orders = await this.rest.signed<GateFuturesOrder[]>('GET', '/futures/usdt/orders', { params });
    const registry = await this.contracts.all();
    return orders
      .filter((o) => registry.has(o.contract))
      .map((o) => gateOrderToBinanceResponse(o, registry.get(o.contract)!));
  }

  async getOrder(symbol: string, orderId: string | number): Promise<BinanceOrderResponse | null> {
    try {
      const contract = await this.contracts.get(symbolToGateContract(symbol));
      const order = await this.rest.signed<GateFuturesOrder>('GET', `/futures/usdt/orders/${orderId}`);
      return gateOrderToBinanceResponse(order, contract);
    } catch {
      return null;
    }
  }

  async getOpenAlgoOrders(symbol?: string): Promise<BinanceAlgoOrderResponse[]> {
    const params: Record<string, string> = { status: 'open' };
    if (symbol) params.contract = symbolToGateContract(symbol);
    const orders = await this.rest.signed<GateFuturesOrder[]>('GET', '/futures/usdt/price_orders', { params });
    const registry = await this.contracts.all();
    return orders
      .map((o) => ({ o, name: o.initial?.contract ?? o.contract }))
      .filter(({ name }) => registry.has(name))
      .map(({ o, name }) => gatePriceOrderToAlgoResponse(o, registry.get(name)!));
  }

  async getAlgoOrder(algoId: string | number): Promise<BinanceAlgoOrderResponse | null | 'not-found'> {
    try {
      const order = await this.rest.signed<GateFuturesOrder>('GET', `/futures/usdt/price_orders/${algoId}`);
      const registry = await this.contracts.all();
      const contract = registry.get(order.initial?.contract ?? order.contract);
      if (!contract) return 'not-found';
      return gatePriceOrderToAlgoResponse(order, contract);
    } catch (error) {
      const message = (error as Error).message;
      if (/not.?found|404|INVALID/i.test(message)) return 'not-found';
      return null;
    }
  }

  /**
   * 等成交：轮询订单状态直到终态或超时。
   *
   * Gate 的订单响应是快照式的（不像币安有 WS 推送可等），轮询是最直接的实现；
   * 间隔 250ms、超时默认 10 秒（与币安 `fillTimeoutMs` 一致）。
   */
  async waitForFill(order: PlacedOrder, timeoutMs = this.fillTimeoutMs): Promise<PlacedOrder> {
    const deadline = Date.now() + timeoutMs;
    let current = order;
    while (!current.terminal && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const raw =
        current.kind === 'algo'
          ? await this.getAlgoOrder(current.id)
          : await this.getOrder(current.symbol, current.id);
      if (!raw || raw === 'not-found') break;
      if (current.kind === 'algo') {
        const algo = raw as BinanceAlgoOrderResponse;
        current = {
          ...current,
          status: algo.algoStatus,
          terminal: algo.algoStatus === 'FINISHED' || algo.algoStatus === 'CANCELED',
          raw: algo,
        };
      } else {
        const normal = raw as BinanceOrderResponse;
        current = {
          ...current,
          status: normal.status,
          avgPrice: num(normal.avgPrice),
          executedQty: num(normal.executedQty),
          terminal: normal.status === 'FILLED' || normal.status === 'CANCELED' || normal.status === 'EXPIRED',
          raw: normal,
        };
      }
    }
    return current;
  }

  /**
   * 撤一张单（对齐 `BrokerPort`：`(symbol, orderId, kind)`）。
   *
   * ## 为什么参数是单号而不是 `PlacedOrder`
   *
   * 交易循环的撤单调用点（`cancelAllProtection` / `executeCancelPending` /
   * 保本移损 / 手工平仓）手里只有**单号**，没有完整的 `PlacedOrder`。币安那层
   * 早就改成了 `(symbol, orderId, kind)`，Gate 原来保留 `(order: PlacedOrder)`
   * 的旧形状 —— 两个实现形状不一致时 `connection.broker` 无法当 `BrokerPort` 用
   *（接入阶段 2 才暴露出来）。`kind` 决定打哪个端点：
   *
   * ```
   *   order → DELETE /futures/usdt/orders/{id}
   *   algo  → DELETE /futures/usdt/price_orders/{id}    （条件单是独立资源）
   * ```
   *
   * 已不存在 = 撤单成功（与币安 `-2011` 同一语义）。
   */
  async cancelOrder(
    symbol: string,
    orderId: string | number,
    kind: 'order' | 'algo' = 'order',
  ): Promise<boolean> {
    try {
      const path =
        kind === 'algo' ? `/futures/usdt/price_orders/${orderId}` : `/futures/usdt/orders/${orderId}`;
      await this.rest.signed('DELETE', path);
      log.info(`[gate] 已撤销 ${symbol} 的${kind === 'algo' ? '条件单' : '普通单'} #${orderId}`);
      return true;
    } catch (error) {
      /* 已经不在 = 撤单成功（与币安那层同一个语义）。 */
      const message = (error as Error).message;
      if (/not.?found|404|INVALID_ORDER/i.test(message)) return true;
      throw error;
    }
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    const contract = symbolToGateContract(symbol);
    await this.rest.signed('DELETE', '/futures/usdt/orders', { params: { contract } }).catch((error) => {
      log.warn(`[gate] 撤销 ${symbol} 普通挂单失败：${(error as Error).message}`);
    });
    await this.rest.signed('DELETE', '/futures/usdt/price_orders', { params: { contract } }).catch((error) => {
      log.warn(`[gate] 撤销 ${symbol} 条件单失败：${(error as Error).message}`);
    });
  }

  async getUserTrades(symbol: string, limit = 50): Promise<BinanceUserTrade[]> {
    const params: Record<string, string> = {
      contract: symbolToGateContract(symbol),
      limit: String(limit),
    };
    const fills = await this.rest.signed<GateFuturesFill[]>('GET', '/futures/usdt/my_trades', { params });
    const contract = await this.contracts.get(symbolToGateContract(symbol));
    return fills.map((fill) => gateFillToUserTrade(fill, contract));
  }

  async getIncome(options: {
    symbol?: string;
    startTime: number;
    endTime?: number;
    limit?: number;
  }): Promise<BinanceIncome[]> {
    /*
     * ⚠️ `endTime` 必须可选：交易循环的多数调用点只传 `startTime`（例如
     * `reconcileTradeHistory` / `fundingFor`）。声明成必填时类型层面因为方法
     * 双变而"通过"，但运行时 `Math.floor(undefined/1000)` = NaN，会被 Gate 拒成
     * `INVALID_PARAM` —— 一类只在联调时才暴露的接口不匹配。
     */
    const endTime = options.endTime ?? Date.now();
    const params: Record<string, string> = {
      from: String(Math.floor(options.startTime / 1000)),
      to: String(Math.floor(endTime / 1000)),
      limit: String(options.limit ?? 100),
    };
    if (options.symbol) params.contract = symbolToGateContract(options.symbol);
    const books = await this.rest.signed<GateFuturesAccountBook[]>('GET', '/futures/usdt/account_book', { params });
    return books.map(gateBookToIncome);
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const tickers = await this.rest.publicGet<Array<{ contract: string; mark_price: string }>>(
      '/futures/usdt/tickers',
      { contract: symbolToGateContract(symbol) },
    );
    const ticker = tickers.find((t) => t.contract === symbolToGateContract(symbol)) ?? tickers[0];
    return ticker ? num(ticker.mark_price) : 0;
  }
}
