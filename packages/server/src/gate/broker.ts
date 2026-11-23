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
  BinanceAlgoStatus,
  BinanceIncome,
  BinanceOrderResponse,
  BinanceUserTrade,
} from '../binance/types.js';
import type { AccountState } from '../binance/account.js';
import type { ExchangePosition, PlaceOrderRequest, PlacedOrder, BrokerOptions } from '../binance/broker.js';
import { CONDITIONAL_ORDER_TYPES } from '../binance/broker.js';
import { stepDecimals } from '../binance/symbols.js';
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
 * 按合约的**允许最小价格变动**（`order_price_round`）把价格取整到合法值。
 *
 * 2026-11-11 服务器实测：保护单大量失败
 * `AUTO_INVALID_PARAM_TRIGGER_PRICE: trigger.price price is not an integer multiple of a price unit` ——
 * 触发价带着浮点长尾（`69.02236585365898`、`74.4715000000005`），Gate 对价格精度执行得比
 * 币安严格，多一位小数就整单拒绝。
 *
 * 取整放在 broker 内部是**防御性**的：上层（`replaceProtection`）本该用 SymbolRegistry 的
 * `roundTriggerPrice`，但那条路径目前没有调用点 —— 交易所这一层兜底最可靠，
 * 至少不会把浮点长尾发到交易所。
 *
 * 取整方向用 `round`（四舍五入到最近一档），而不是 floor/ceil：触发价只是"到价才触发"，
 * 差半档不影响保护效果，而方向性取整在两种持仓方向下会各错一次。
 */
function formatGatePrice(price: number, contract: GateFuturesContract): string {
  const tick = num(contract.order_price_round);
  if (!(tick > 0) || !(price > 0)) return String(price);
  const decimals = stepDecimals(String(contract.order_price_round));
  const stepped = Math.round(price / tick) * tick;
  /*
   * 用 `toFixed(decimals)` 而非 `String(Number(stepped.toFixed(8)))`（2026-11-23 修复）：
   *   1. 防止极小价币种（如 1e-7）被 `toFixed(8)` 截断或 `String(...)` 转成科学计数法 `"1e-7"` 被 Gate 拒单；
   *   2. 去掉小数末尾多余的 0（如 `"69.0"` → `"69"`、`"74.50"` → `"74.5"`），同时消除二进制浮点尾差。
   */
  const fixed = stepped.toFixed(decimals);
  return decimals > 0 ? fixed.replace(/\.?0+$/, '') : fixed;
}

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

/**
 * 为 Gate 条件单构造自带止损/止盈标记的客户端单号（`t-sl-...` / `t-tp-...`）。
 *
 * ⚠️ **为什么不能只靠进程内 `algoKinds` Map（2026-11-23 修复）**：
 * Gate 的 `price_orders` 响应没有「止盈/止损」字段。仅靠内存 Map 会在重启后清空，
 * 导致所有挂着的止盈单退化成 `'STOP_MARKET'` —— 止损缺失时 `hasLiveStop` 误放行
 * （仓位裸奔），而移损/调止损时 `cancelAllProtection` 又把止盈单误撤。
 * 把标记写进 `initial.text` 后，重启也能 100% 无状态准确区分。
 */
function toGateAlgoText(kind: 'STOP' | 'TAKE_PROFIT', clientOrderId?: string): string {
  const tag = kind === 'TAKE_PROFIT' ? 't-tp-' : 't-sl-';
  const raw = (clientOrderId ?? '').replace(/^t-/, '').replace(/^(?:tp|sl|stop)-/i, '');
  const body = raw || Date.now().toString(36);
  return `${tag}${body}`.slice(0, 30);
}

function inferAlgoKindFromText(text: string): 'STOP' | 'TAKE_PROFIT' | null {
  if (/^t-tp-/i.test(text) || /^tp-/i.test(text)) return 'TAKE_PROFIT';
  if (/^t-sl-/i.test(text) || /^sl-/i.test(text) || /^stop-/i.test(text)) return 'STOP';
  return null;
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
 * ⚠️ **Gate API v4 普通单只有 `open` / `finished` 两种 `status`（2026-11-23 修复）**：
 * 被撤单、IOC 未成交、reduce_only 冲突、强平等全部返回 `status: 'finished'`，
 * 真正的原因在 `finish_as` 里。原来只看 `status === 'finished'` 就返回 `'FILLED'`，
 * 会把已撤销的限价单和未成交的 IOC 单错判为成交。
 */
function orderStatus(order: GateFuturesOrder): BinanceOrderResponse['status'] {
  if (order.status === 'cancelled') {
    return order.finish_as === 'auto_deleveraged' ? 'EXPIRED' : 'CANCELED';
  }
  const left = Math.abs(order.left);
  const total = Math.abs(order.size);
  if (order.status === 'finished') {
    const finishAs = order.finish_as;
    if (finishAs === 'auto_deleveraged' || finishAs === 'liquidated') return 'EXPIRED';
    if (
      finishAs === 'cancelled' ||
      finishAs === 'reduce_only' ||
      finishAs === 'position_closed' ||
      finishAs === 'reduce_out' ||
      finishAs === 'stp'
    ) {
      return 'CANCELED';
    }
    if (finishAs === 'ioc') {
      return total > 0 && left === 0 ? 'FILLED' : 'CANCELED';
    }
    if (finishAs === 'filled') return 'FILLED';
    /* 未给 finish_as（兼容旧测试夹具）：若一笔未成交（left === total 且 total > 0）按撤单处理。 */
    if (total > 0 && left >= total) return 'CANCELED';
    return 'FILLED';
  }
  return left > 0 && left < total ? 'PARTIALLY_FILLED' : 'NEW';
}

function algoStatusOf(order: GateFuturesOrder): BinanceAlgoStatus {
  if (order.status === 'cancelled') return 'CANCELED';
  if (order.status === 'finished') {
    const finishAs = order.finish_as;
    if (finishAs === 'cancelled') return 'CANCELED';
    if (finishAs === 'expired') return 'EXPIRED';
    if (finishAs === 'failed') return 'REJECTED';
    return 'FINISHED';
  }
  return 'NEW';
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
    status: orderStatus(order),
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
  /*
   * `kind` 优先采用调用方已知值；未传时从 `initial.text`（`t-tp-` / `t-sl-`）无状态还原；
   * 均缺失（例如进程重启前的外部手工条件单）时保守回落 `'STOP'`。
   */
  kind?: 'STOP' | 'TAKE_PROFIT',
): BinanceAlgoOrderResponse {
  const multiplier = num(contract.quanto_multiplier) || 1;
  /* price_orders 的契约/数量/价格/text 在 `initial` 里（顶层没有，实测 undefined）。 */
  const initial = order.initial;
  const clientAlgoId = initial?.text ?? order.text ?? '';
  const resolvedKind: 'STOP' | 'TAKE_PROFIT' = kind ?? inferAlgoKindFromText(clientAlgoId) ?? 'STOP';
  const rawSignedSize = initial?.size !== undefined && initial.size !== 0 ? initial.size : order.size;
  const size = Math.abs(initial?.size ?? order.size);
  const rule = order.trigger?.rule ?? 1;
  const priceText = initial?.price ?? order.price;
  const contractName = initial?.contract ?? order.contract;
  const algoStatus = algoStatusOf(order);
  /*
   * closePosition 条件单在 Gate 必须传 `initial.size = 0`。原来写 `rawSignedSize > 0 ? 'BUY' : 'SELL'`
   * 会把平空单（BUY）全部错标为 `'SELL'`。size=0 时按 `resolvedKind` + `trigger.rule` 唯一反推：
   *   · STOP:        rule=2(≤触发) → SELL 平多；rule=1(≥触发) → BUY 平空
   *   · TAKE_PROFIT: rule=1(≥触发) → SELL 平多；rule=2(≤触发) → BUY 平空
   */
  const side: 'BUY' | 'SELL' =
    rawSignedSize !== 0
      ? rawSignedSize > 0
        ? 'BUY'
        : 'SELL'
      : resolvedKind === 'STOP'
        ? rule === 2
          ? 'SELL'
          : 'BUY'
        : rule === 1
          ? 'SELL'
          : 'BUY';
  return {
    algoId: order.id,
    clientAlgoId,
    algoType: 'CONDITIONAL',
    orderType: (resolvedKind === 'TAKE_PROFIT' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET') as BinanceAlgoOrderResponse['orderType'],
    symbol: gateContractToSymbol(contractName ?? ''),
    side,
    positionSide: 'BOTH',
    timeInForce: 'GTC',
    quantity: String(size * multiplier),
    algoStatus,
    triggerPrice: order.trigger?.price ?? '0',
    price: priceText,
    closePosition: initial?.close === true || order.is_close === true,
    reduceOnly: initial?.reduce_only === true || order.is_reduce_only === true,
    workingType: 'MARK_PRICE',
    priceProtect: false,
    /* Gate 的触发方向：rule=1 价格上穿触发 / rule=2 下穿触发 —— 记录在 activatePrice 之外的语义里。 */
    activatePrice: String(rule),
    actualOrderId: algoStatus === 'FINISHED' && order.finish_time ? String(order.id) : undefined,
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
     * ⚠️ **必须留空串 `''`，绝不能写 `'0'`（2026-11-23 P0 账目修复）**。
     *
     * Gate 的 `my_trades` 成交明细不含 `realizedPnl`。原实现硬填 `'0'`，结果
     * `reconstructRoundTrips()` 算出 `grossPnl = 0` → `bookClosedPosition` 与
     * `reconcileTradeHistory` 的 `applyExchangeFigures()` 把 Gate 账本里所有平仓的
     * 毛盈亏全数覆写清零（界面只剩负手续费、对账永久大差额）。
     * 留空串 `''` 明确语义为"成交行未提供 realizedPnl"，由 `reconstructRoundTrips`
     * 自动按线性合约加权入场均价精确算出毛盈亏（币安始终返回数值串，不受影响）。
     */
    realizedPnl: '',
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
  /*
   * ⚠️ **Gate API v4 `account_book` 官方枚举（2026-11-23 P0 修复）**：
   *   · `fund` = 资金费（原代码错映成 `TRANSFER`，导致资金费全部丢失且污染转账！）
   *   · `pnl`  = 已实现盈亏（原代码只认 `realised_pnl`，导致所有已实现盈亏未计入 `REALIZED_PNL`！）
   *   · `dnw`  = 出入金转账（原代码未映射成 `TRANSFER`）
   *   · `fee`  = 交易手续费
   * 保留 `funding`/`realised_pnl` 别名兼容旧夹具。
   */
  const typeMap: Record<string, string> = {
    fund: 'FUNDING_FEE',
    funding: 'FUNDING_FEE',
    fee: 'COMMISSION',
    pnl: 'REALIZED_PNL',
    realised_pnl: 'REALIZED_PNL',
    dnw: 'TRANSFER',
    auto_deleveraging: 'AUTO_EXCHANGE',
  };
  const timeMs = Math.round(book.time * 1000);
  return {
    symbol: book.contract ? gateContractToSymbol(book.contract) : '',
    incomeType: typeMap[book.type] ?? book.type.toUpperCase(),
    income: book.change,
    asset: 'USDT',
    time: timeMs,
    info: book.type,
    tranId: book.id !== undefined ? Number(book.id) || timeMs : timeMs,
    tradeId: '',
  };
}

export class GateBroker {
  readonly isDryRun = false;
  /** 条件单 id → 创建时是止损还是止盈（Gate 响应里不带这个信息，见映射函数的说明）。 */
  private readonly algoKinds = new Map<string, 'STOP' | 'TAKE_PROFIT'>();
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
    /*
     * ⚠️ **Gate 全仓模式必须传 `leverage=0` + `cross_leverage_limit=N`（2026-11-23 修复）**。
     *
     * Gate API v4 约定：传正整数 `leverage=10` 会把该合约强制切换为**逐仓模式**；
     * 而本系统交易循环按单向全仓设计（`setMarginType` 假定全仓）。改用全仓上限参数后，
     * 既不误切逐仓，也能从响应里的 `cross_leverage_limit` / `leverage` 读回实际生效倍数。
     */
    try {
      const response = await this.rest.signed<{ leverage?: string | number; cross_leverage_limit?: string | number }>(
        'POST',
        `/futures/usdt/positions/${contract}/leverage`,
        { params: { leverage: '0', cross_leverage_limit: String(wanted) } },
      );
      const cross = num(response?.cross_leverage_limit);
      const isolated = num(response?.leverage);
      const applied = cross > 0 ? cross : isolated > 0 ? isolated : wanted;
      return { ok: true, leverage: applied };
    } catch (error) {
      const message = (error as Error).message;
      return {
        ok: false,
        leverage: 0,
        note: `Gate 设置 ${symbol} 全仓杠杆 ${wanted}x 失败：${message}`,
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
      price: request.type === 'MARKET' ? '0' : formatGatePrice(request.price ?? 0, contract),
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

  private rememberAlgoKind(id: string, kind: 'STOP' | 'TAKE_PROFIT'): void {
    this.algoKinds.set(id, kind);
    /* 有界淘汰，防止 7×24 长期运行缓慢泄漏。 */
    if (this.algoKinds.size > 500) {
      const oldest = this.algoKinds.keys().next().value;
      if (oldest !== undefined) this.algoKinds.delete(oldest);
    }
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
    const triggerText = formatGatePrice(request.triggerPrice ?? 0, contract);
    /*
     * Gate 的触发方向：rule=1（价格 ≥ 触发价时触发）/ rule=2（≤ 时触发）。
     * 本系统的语义：
     *   · 止损（STOP/STOP_MARKET）：多头在下方 → ≤ 触发（rule=2）；空头在上方 → ≥（rule=1）
     *   · 止盈（TAKE_PROFIT）：多头在上方 → ≥（rule=1）；空头在下方 → ≤（rule=2）
     * 判断用「平仓方向」：SELL 平多 → 止损在下（2）/止盈在上（1）；BUY 平空相反。
     */
    const isStop = request.type.startsWith('STOP');
    const kind: 'STOP' | 'TAKE_PROFIT' = request.type.startsWith('TAKE_PROFIT') ? 'TAKE_PROFIT' : 'STOP';
    const closingLong = request.side === 'SELL';
    const rule = isStop ? (closingLong ? 2 : 1) : closingLong ? 1 : 2;
    const algoText = toGateAlgoText(kind, request.clientOrderId);
    const body = {
      initial: {
        contract: contractName,
        /* close 单必须 size=0（见上面那段实测说明）；否则按数量下单。 */
        size: closeAll ? 0 : signedSize(request.side, size),
        price: request.price !== undefined && request.price > 0 ? formatGatePrice(request.price, contract) : '0',
        tif: request.price !== undefined && request.price > 0 ? 'gtc' : 'ioc',
        reduce_only: !closeAll,
        /* closePosition 语义在 Gate 叫 `close`（按触发时仓位全平）。 */
        close: closeAll,
        /* 写入带 t-sl-/t-tp- 标记的客户端单号，重启后仍可无状态还原止损/止盈身份。 */
        text: algoText,
      },
      /*
       * Gate API v4 字段名是 `strategy_type`（0=价格触发）与 `price_type`（1=标记价，
       * 与本项目 `workingType: 'MARK_PRICE'` 口径一致；不传默认为 0=最新价）。
       */
      trigger: { strategy_type: 0, price_type: 1, price: triggerText, rule },
    };
    const order = await this.rest.signed<GateFuturesOrder>('POST', '/futures/usdt/price_orders', { body });
    this.rememberAlgoKind(String(order.id), kind);
    log.info(`[gate] 条件单 ${request.symbol} ${request.type} 触发 ${triggerText} → #${order.id}`);
    /* 必须把 `kind` 传进去，否则刚挂出的止盈单 `raw.orderType` 会被错标成 STOP_MARKET。 */
    const raw = gatePriceOrderToAlgoResponse(order, contract, kind);
    return {
      kind: 'algo',
      id: String(order.id),
      clientId: algoText,
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
      .map(({ o, name }) =>
        /* 不传硬编码 `'STOP'`，让 `gatePriceOrderToAlgoResponse` 在重启后优先按 `initial.text` 还原类型。 */
        gatePriceOrderToAlgoResponse(o, registry.get(name)!, this.algoKinds.get(String(o.id))),
      );
  }

  async getAlgoOrder(algoId: string | number): Promise<BinanceAlgoOrderResponse | null | 'not-found'> {
    try {
      const order = await this.rest.signed<GateFuturesOrder>('GET', `/futures/usdt/price_orders/${algoId}`);
      const registry = await this.contracts.all();
      const contract = registry.get(order.initial?.contract ?? order.contract);
      if (!contract) return 'not-found';
      return gatePriceOrderToAlgoResponse(order, contract, this.algoKinds.get(String(order.id)));
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
      if (raw === 'not-found') break;
      /* 瞬时读取失败（null）继续等到 deadline，不要把一次网络抖动当成终态退出。 */
      if (!raw) continue;
      if (current.kind === 'algo') {
        const algo = raw as BinanceAlgoOrderResponse;
        current = {
          ...current,
          status: algo.algoStatus,
          terminal:
            algo.algoStatus === 'FINISHED' ||
            algo.algoStatus === 'CANCELED' ||
            algo.algoStatus === 'EXPIRED' ||
            algo.algoStatus === 'REJECTED',
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
   * 契约与 `BinanceBroker.cancelOrder` 一致：已不存在返回 `true`，其它失败记 warn 返回 `false`。
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
      if (kind === 'algo') this.algoKinds.delete(String(orderId));
      log.info(`[gate] 已撤销 ${symbol} 的${kind === 'algo' ? '条件单' : '普通单'} #${orderId}`);
      return true;
    } catch (error) {
      /* 已经不在 = 撤单成功（与币安那层同一个语义）。 */
      const message = (error as Error).message;
      if (/not.?found|404|INVALID_ORDER/i.test(message)) {
        if (kind === 'algo') this.algoKinds.delete(String(orderId));
        return true;
      }
      log.warn(`[gate] 撤销 ${symbol} 的${kind === 'algo' ? '条件单' : '普通单'} #${orderId} 失败：${message}`);
      return false;
    }
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    const contract = symbolToGateContract(symbol);
    const errors: string[] = [];
    /* 普通挂单：Gate 支持按 contract 批量撤。失败不可静默，否则调用方会继续挂单造成重复单。 */
    try {
      await this.rest.signed('DELETE', '/futures/usdt/orders', { params: { contract } });
    } catch (error) {
      const msg = `普通挂单撤销失败：${(error as Error).message}`;
      log.warn(`[gate] ${symbol} ${msg}`);
      errors.push(msg);
    }
    /*
     * ⚠️ **条件单必须逐个撤**（2026-11-11 线上实测），且**失败必须抛出**（2026-11-23 对齐 BrokerPort 契约）：
     * `executeAdjust`/`applyBreakevenGuard` 依赖 `cancelAllOrders` 抛错来中止重挂保护单；
     * 静默吞错会让旧条件单留在交易所并叠加重复单。
     */
    try {
      const open = await this.rest.signed<GateFuturesOrder[]>('GET', '/futures/usdt/price_orders', {
        params: { status: 'open', contract },
      });
      for (const order of open) {
        try {
          await this.rest.signed('DELETE', `/futures/usdt/price_orders/${order.id}`);
          this.algoKinds.delete(String(order.id));
        } catch (error) {
          const message = (error as Error).message;
          if (/not.?found|404|INVALID_ORDER/i.test(message)) {
            this.algoKinds.delete(String(order.id));
            continue;
          }
          const msg = `条件单 #${order.id} 撤销失败：${message}`;
          log.warn(`[gate] ${symbol} ${msg}`);
          errors.push(msg);
        }
      }
    } catch (error) {
      const msg = `列条件单失败：${(error as Error).message}`;
      log.warn(`[gate] ${symbol} ${msg}`);
      errors.push(msg);
    }
    if (errors.length > 0) {
      throw new Error(`Gate 撤销 ${symbol} 挂单未全部完成：${errors.join('；')}`);
    }
  }

  async getUserTrades(symbol: string, limit = 50): Promise<BinanceUserTrade[]> {
    const params: Record<string, string> = {
      contract: symbolToGateContract(symbol),
      limit: String(limit),
    };
    const fills = await this.rest.signed<GateFuturesFill[]>('GET', '/futures/usdt/my_trades', { params });
    const contract = await this.contracts.get(symbolToGateContract(symbol));
    /*
     * ⚠️ **必须按时间升序返回（2026-11-23 P0 修复）**。
     * Gate API v4 `my_trades` 默认倒序（最新在前），而本项目所有消费方（`lastFillFor`、
     * `detectCloseReason`）按币安 `userTrades` 契约取 `fills[fills.length - 1]` 作为最新成交。
     * 不排序会导致 Gate 每次都取到 20 笔之前的陈旧成交价。
     */
    return fills
      .map((fill) => gateFillToUserTrade(fill, contract))
      .sort((a, b) => a.time - b.time || a.id - b.id);
  }

  async getIncome(options: {
    symbol?: string;
    startTime: number;
    endTime?: number;
    limit?: number;
  }): Promise<BinanceIncome[]> {
    /*
     * ⚠️ `endTime` 必须可选；并按 offset 翻页避免超过 100 条资金流水被静默截断（2026-11-23 修复）。
     */
    const endTime = options.endTime ?? Date.now();
    const pageSize = Math.max(1, Math.min(options.limit ?? 100, 100));
    const maxPages = 50;
    const fromSec = String(Math.floor(options.startTime / 1000));
    const toSec = String(Math.floor(endTime / 1000));
    const out: BinanceIncome[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < maxPages; page += 1) {
      const params: Record<string, string> = {
        from: fromSec,
        to: toSec,
        limit: String(pageSize),
        ...(page > 0 ? { offset: String(page * pageSize) } : {}),
      };
      if (options.symbol) params.contract = symbolToGateContract(options.symbol);
      const books = await this.rest.signed<GateFuturesAccountBook[]>('GET', '/futures/usdt/account_book', { params });
      if (!Array.isArray(books) || books.length === 0) break;
      for (const book of books) {
        const mapped = gateBookToIncome(book);
        const key = `${book.id ?? ''}:${mapped.time}:${mapped.incomeType}:${mapped.symbol}:${mapped.income}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(mapped);
      }
      /* 调用方显式指定了小 limit 或本页不满 → 已拉完。 */
      if (books.length < pageSize || (options.limit !== undefined && out.length >= options.limit)) break;
    }

    return out;
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
