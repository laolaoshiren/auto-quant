/**
 * Gate.io API v4（USDT 本位永续）的响应形状。
 *
 * ## 为什么只声明用到的字段
 *
 * Gate 的响应字段很多（且不同端点略有差异）。全部声明会让"哪些字段真的读过"
 * 变得不可见，也会在 Gate 加字段时逼着我们跟着改。这里只声明**映射到本项目
 * 领域对象时用到的字段**，其余忽略。
 *
 * ⚠️ **金额/价格一律是 JSON 里的字符串**（Gate 用 `"0.0001"` 这种十进制字符串
 * 传数值，避免浮点误差）。所以这里都声明成 `string`，由 `num()` 统一转成
 * number —— 绝不在声明里写 `number` 让 TS 骗过编译器。
 */

/** 合约账户（`GET /futures/usdt/accounts`）。 */
export interface GateFuturesAccount {
  /** 保证金总额（含未实现盈亏）。 */
  total: string;
  /** 未实现盈亏。 */
  unrealised_pnl: string;
  /** 可用保证金。 */
  available: string;
  /** 已用保证金。 */
  margin?: string;
  /** 结算币种，恒为 USDT。 */
  currency?: string;
  /**
   * 是否双向持仓模式（v4.15.5 起由账户响应提供）。
   *
   * ⚠️ Gate **没有** `GET /futures/usdt/dual_mode`（2026-11-11 实测 405）——
   * 查询持仓模式只能读这个字段；设置才走 `POST /futures/usdt/dual_mode`。
   */
  in_dual_mode?: boolean;
}

/**
 * 合约（`GET /futures/usdt/contracts`）—— 决定"1 张 = 多少个币"。
 *
 * ⚠️ **Gate 的 `size` 是"张数"，不是币数**。`quanto_multiplier` 是一张的
 * 合约面值（币数）。把 Gate 接入到本系统时，数量换算必须走它：
 *
 *     币数 = 张数 × quanto_multiplier
 *     张数 = 币数 ÷ quanto_multiplier（再按 step 向下取整，最少 order_size_min 张）
 */
export interface GateFuturesContract {
  /** 合约名，例如 `BTC_USDT`。 */
  name: string;
  /** 一张等于多少个币（字符串）。 */
  quanto_multiplier: string;
  /** 最小下单张数（字符串，通常是 1）。 */
  order_size_min: string;
  /** 最大杠杆（字符串）。 */
  leverage_max?: string;
  /** 张数步长（字符串，通常是 1）。 */
  order_size_step?: string;
  /** 价格最小变动（字符串）。 */
  order_price_round: string;
  /** 是否已下线。 */
  in_delisting?: boolean;
}

/** 持仓（`GET /futures/usdt/positions`）。 */
export interface GateFuturesPosition {
  /** `BTC_USDT`；**空字符串表示没有持仓**（Gate 会把平掉的仓位也列出来）。 */
  contract: string;
  /** 张数（有符号：正=多，负=空）。 */
  size: string;
  /** 开仓均价。 */
  entry_price: string;
  /** 标记价。 */
  mark_price: string;
  /** 杠杆（字符串）。 */
  leverage: string;
  /** 强平价。 */
  liq_price?: string;
  /** 未实现盈亏。 */
  unrealised_pnl: string;
  /** 占用保证金。 */
  margin?: string;
  /** 仓位模式：`single` 单向 / `dual_long|dual_short` 双向。 */
  mode?: string;
  /** 未实现盈亏收益率（Gate 给的百分比字符串）。 */
  unrealised_pnl_rate?: string;
}

/** 委托（`GET /futures/usdt/orders`）。 */
export interface GateFuturesOrder {
  id: number;
  /** 用户自定义 id。 */
  text?: string;
  /** 合约名。 */
  contract: string;
  /** 张数（有符号：正=买，负=卖）。 */
  size: number;
  /** 已成交张数（正负号与 size 一致）。 */
  left: number;
  /** 委托价；0 表示市价。 */
  price: string;
  /** 成交均价。 */
  fill_price?: string;
  /** 状态：`open` / `finished` / `cancelled`。 */
  status: string;
  /** 是否只减仓。 */
  is_reduce_only?: boolean;
  /** 是否平仓单（closePosition 语义）。 */
  is_close?: boolean;
  /** 触发价（价格保护单）。 */
  price_type?: string;
  /** 创建时间（秒级时间戳，字符串）。 */
  create_time: string;
  /** 成交时间。 */
  finish_time?: string;
  /** 触发条件（价格保护单才有）。 */
  trigger?: {
    price: string;
    rule?: number;
    expiration?: number;
  };
  /**
   * 价格保护单（`price_orders`）的"初始订单"——**契约/数量/价格都在这里面**，
   * 顶层没有 `contract`/`size`（2026-11-11 联调实测：直接读顶层会 undefined）。
   */
  initial?: {
    contract: string;
    size: number;
    price: string;
    tif?: string;
    reduce_only?: boolean;
    close?: boolean;
    text?: string;
  };
  /** 是否自动平仓（止盈止损生成的单）。 */
  finish_as?: string;
}

/** 成交（`GET /futures/usdt/my_trades`）。 */
export interface GateFuturesFill {
  id: number;
  create_time: number;
  contract: string;
  /** 张数（有符号）。 */
  size: number;
  price: string;
  /** 手续费（正=支出，负=收入？Gate 用正数表示手续费，结算币种 USDT）。 */
  fee: string;
  /** 是否只减仓。 */
  is_reduce_only?: boolean;
  /** 订单 id。 */
  order_id?: string;
  /** `close` 表示平仓单。 */
  role?: string;
}

/** 资金流水（`GET /futures/usdt/account_book`）。 */
export interface GateFuturesAccountBook {
  time: number;
  /** 变动金额（字符串，有符号）。 */
  change: string;
  /** 流水类型：`fund` / `realised_pnl` / `fee` / `funding` / `auto_deleveraging` / ... */
  type: string;
  contract?: string;
  /** 余额快照。 */
  balance?: string;
}

/** Gate 的错误响应体（非 2xx）。 */
export interface GateErrorBody {
  label?: string;
  message?: string;
  detail?: string;
}

/** 携带 HTTP 状态与 Gate 错误标签的异常。 */
export class GateApiError extends Error {
  readonly status: number;
  readonly label: string;

  constructor(message: string, status: number, label = '') {
    super(message);
    this.name = 'GateApiError';
    this.status = status;
    this.label = label;
  }
}
