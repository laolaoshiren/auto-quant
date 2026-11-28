import type { MarginMode, OrderCancelSource, OrderRecord } from '@aq/shared';
import { getDb } from '../db/index.js';

const now = (): string => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/*  Orders                                                                     */
/* -------------------------------------------------------------------------- */

interface OrderRow {
  id: number;
  trader_id: number;
  exchange_order_id: string | null;
  client_order_id: string;
  symbol: string;
  side: string;
  type: string;
  purpose: string;
  quantity: number;
  price: number | null;
  stop_price: number | null;
  status: string;
  avg_price: number | null;
  filled_qty: number;
  fee: number;
  error: string | null;
  raw_response: string | null;
  /** 这一行对应占用的保证金。**可空**：`NULL` = 算不出来，见 `M13_ORDER_MARGIN_USED`。 */
  margin_used: number | null;
  /** 下单时该标的的保证金模式。**可空**：`NULL` = 没有这个事实，见 `M14_ORDER_MARGIN_TYPE`。 */
  margin_type: string | null;
  /** 撤销操作来源（模型 / 系统 / 手动）。**可空**：迁移前历史行无此字段，见 `M23_ORDER_CANCEL_SOURCE`。 */
  cancel_source?: string | null;
  created_at: string;
  updated_at: string;
}

const VALID_CANCEL_SOURCES: ReadonlySet<OrderCancelSource> = new Set([
  'model_cancel',
  'model_adjust',
  'system_timeout',
  'system_guard',
  'system_reconcile',
  'manual',
]);

function normalizeCancelSource(value: string | null | undefined): OrderCancelSource | null {
  if (!value) return null;
  return VALID_CANCEL_SOURCES.has(value as OrderCancelSource) ? (value as OrderCancelSource) : null;
}

function toOrder(row: OrderRow, leverages?: ReadonlyMap<string, number>): OrderRecord {
  return {
    id: row.id,
    traderId: row.trader_id,
    exchangeOrderId: row.exchange_order_id,
    clientOrderId: row.client_order_id,
    symbol: row.symbol,
    side: row.side as 'BUY' | 'SELL',
    type: row.type,
    purpose: row.purpose as OrderRecord['purpose'],
    quantity: row.quantity,
    price: row.price,
    stopPrice: row.stop_price,
    status: row.status,
    avgPrice: row.avg_price,
    filledQty: row.filled_qty,
    fee: row.fee,
    error: row.error,
    /*
     * ⚠️ 杠杆**不能**由界面按"标的的当前持仓"去读 —— 那份列表来自交易所的真实持仓，
     * 而挂单还没成交、交易所没有持仓，于是**开仓单永远读不到**（用户看到的"倒反天罡"：
     * 该显示的显示不出来、不该显示的保护单反而显示了）。
     *
     * 这里从本地 `positions`（**含 `pending` 行**）取，随订单一起发出去。
     */
    ...(leverages?.has(row.symbol) ? { leverage: leverages.get(row.symbol) } : {}),
    /*
     * ⚠️ `undefined`（界面显示 `—`）与 `0`（界面显示 `0.00`）在这里**必须是两件事**。
     *
     * `NULL` 是我们没有这个数；`0` 是"这笔没占保证金"。所以这里既不用 `?? 0`，
     * 也顺手把 0 归到"不知道"那一类：写入侧（`orders.insert()` 与
     * `resolveOrderMarginUsed()`）已经收过一次口，但这一列还可能被**绕过仓储**的行
     * 写进来（迁移前的旧行、直接写 SQL 的脚本），而"前端一定不会看到 0"这条契约
     * 值得在读出这一道再兜一次。
     */
    marginUsed: positiveOrNull(row.margin_used) ?? undefined,
    /*
     * 保证金模式：**读出这一道也收一次口**，与 `marginUsed` 同一个理由。
     *
     * ⚠️ `undefined`（界面显示 `—`）与 `'cross'`（界面显示「全仓」）在这里是
     * **两句相反的话**：前者是"我们不知道这张单当时是什么模式"，后者是"它就是全仓"。
     * 所以这里既不用 `?? 'cross'`，也把认不出的写法归到"不知道"那一类 ——
     * 历史行（`NULL`）、以及任何绕过 `orders.insert()` 的写入都从这里经过。
     */
    marginType: normalizeMarginMode(row.margin_type) ?? undefined,
    cancelSource: normalizeCancelSource(row.cancel_source) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 把"也许是保证金"的输入收成 `number` 或 `null`。
 *
 * 保证金这一列只有两种合法取值：**一个正数**，或**不知道**（`NULL`）。
 * `0` 不属于"不知道"那一类 —— 它在界面上读作"这笔没占保证金"，与"我们不知道"
 * 是两句相反的话（见 `M13_ORDER_MARGIN_USED`）。而 `marginOf()` 在名义价值为 0 时
 * 恰好回 `0`，所以这个收口必须在写入与读出两处都做一遍。
 */
function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 保证金模式的**唯一收口**：把三种写法收成 `'cross' | 'isolated'`，认不出的回 `null`。
 *
 * ## 为什么必须有它
 *
 * "全仓"这一个概念在这个系统里有**三个拼法**（全都是外部契约，改不动）：
 *
 * | 来源 | 写法 |
 * | --- | --- |
 * | 交易所 `positionRisk` / `symbolConfig`（读） | `cross` |
 * | `POST /fapi/v1/marginType`（写） | `CROSSED` |
 * | 本仓库 `StrategyConfigSchema.riskControl.marginMode` | `crossed` |
 *
 * 直接比较字符串会**静默失败**：`'cross' === 'crossed'` 是 `false`，而它不抛错、
 * 不报警，只会让一次"这个标的是全仓"的判断变成"不是全仓"（或反过来）。
 * 所以入库前、读库后都从这里过一道 —— 与 `positiveOrNull()` 对保证金做的是同一件事。
 *
 * ## 为什么认不出是 `null` 而不是报错 / 也不回落到 `'cross'`
 *
 * 这一列的合法取值只有"两个模式之一"或"不知道"。币安的**默认**确实是全仓，
 * 但"默认是"与"我们读到了"是两件事 —— 认不出的值（未来的新写法、脏数据）
 * 回落到 `'cross'` 会让界面**替交易所宣布一个我们没验证过的事实**，
 * 与 `M13_ORDER_MARGIN_USED` 里"0 不等于不知道"是同一条纪律。
 *
 * 大小写与空白一并容忍（`'CROSSED'` / `' isolated '` 都能收到），因为它们来自
 * 不同的外部接口，而"多一个空格就变成不知道"是最难查的那类字段映射 bug。
 */
export function normalizeMarginMode(value: unknown): MarginMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cross' || normalized === 'crossed') return 'cross';
  if (normalized === 'isolated') return 'isolated';
  return null;
}

/**
 * 一张订单行该写什么保证金 —— **这个判断只有这一份实现**。
 *
 * ## 取值顺序
 *
 *   ① `override`：调用方给的值。开仓 / 加仓单给的是**这一笔自己**的
 *      `|价 × 量| ÷ 杠杆`（`marginOf()`），也就是同时写进 `positions.margin_used`
 *      的同一个数；
 *   ② 否则取 `positionMargin`（该标的**当前持仓行**的 `positions.margin_used`，
 *      权威值，不重算）。平仓单与保护单都是为那张持仓下的单，它们落库时那张持仓
 *      一定还开着（`executeClose` 在 `bookClosedPosition` 之前记订单、保护单在
 *      持仓建好之后才挂）—— 所以这不是"按标的猜"，它就是那张持仓。
 *      保护单行上只有触发价、没有成交价，自己乘一遍只会得到与持仓页不一致的第二个数；
 *   ③ 都没有 → `null` → `OrderRecord.marginUsed` 是 `undefined` → 界面显示 `—`。
 *      被拒的开仓单走的就是这条路（那时还没有持仓，也确实什么都没占用）。
 *
 * ## ⚠️ 为什么开仓单**不许**回落到 ②
 *
 * 开仓单要的是"这一笔自己"的保证金，而那一刻它要建的持仓还不存在 ——
 * 若此时同标的上恰好还挂着一个别的持仓（重复开仓的守卫失效、或对账留下的行），
 * 回落会把**别人的仓位**压的本金记到这一行上。宁可显示 `—`。
 */
export function resolveOrderMarginUsed(input: {
  purpose: OrderRecord['purpose'];
  override?: number | null;
  positionMargin?: number | null;
}): number | null {
  const own = positiveOrNull(input.override);
  if (own !== null) return own;
  if (input.purpose === 'entry') return null;
  return positiveOrNull(input.positionMargin);
}

/* -------------------------------------------------------------------------- */
/*  Pagination caps                                                            */
/* -------------------------------------------------------------------------- */

/*
 * 历史表（订单 / 成交 / 决策）只回**一页**，三张表共用下面这一套钳制与游标。
 *
 * 为什么要共用一份实现：这三处各写一遍的话，迟早只改其中两处，而漏掉的那张表
 * 就是操作者说的"成千上万数据一次加载出来导致系统卡死"复发的地方
 * （`?limit=999999` 以前会被原样交给 SQL）。
 */

/**
 * 把调用方给的 `limit` 收进 `[1, max]`。**钳制而不是报错**。
 *
 * 翻页的控制台不该因为页大小写得大一点就收到 400，而一个手写的
 * `?limit=999999` 也绝不能真的返回 999999 条。
 * 非有限值（没传 / `NaN` / `Infinity`）回落到该表自己的默认页大小，
 * 等同于路由原来那半句 `Number.isFinite(limit) ? limit : 100`。
 *
 * 下界收到 1 而不是 0：`LIMIT 0` 返回的空数组和"这个机器人还没有记录"
 * 在响应里长得一模一样，会把一次参数错误伪装成一次空结果。
 */
export function clampPageLimit(limit: number, max: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(limit)));
}

/**
 * 把调用方给的游标收成一个可用的 `id`；`null` 表示"第一页"。
 *
 * 非有限值（没传 / `?before=abc`）一律按第一页处理：发不出正确游标的调用方
 * 应该拿到**最新的一页**，而不是一个 400 —— 与 `clampPageLimit` 同一个取舍。
 */
export function cursorOf(before: number | null | undefined): number | null {
  return before === undefined || before === null || !Number.isFinite(before) ? null : Math.trunc(before);
}

/**
 * 一次最多回多少条订单记录。
 *
 * 卡住的是**响应体的字节数**：订单行带着状态、均价、成交数量、手续费与错误文案
 * （12 列），而这张表是随机器人运行**无限增长**的 —— 一个跑了半年的机器人有几千行，
 * `?limit=999999` 一次就能把整张表拼进 JSON 占住 event loop，浏览器那侧也要一次
 * 建出几千个 DOM 节点。
 *
 * 200 与操作者上一版控制台每次轮询要的条数一致（那时候每 15 秒无条件拉 200 条），
 * 而一页 25 条的翻页只需要它的一小部分 —— 上限是给手写请求用的兜底，
 * 不是给界面用的页大小。
 */
export const ORDER_PAGE_MAX = 200;

/** 不传 `limit` 时返回多少条 —— 与历史契约一致（路由以前写死 100，`docs/API.md` 照旧）。 */
export const ORDER_PAGE_DEFAULT = 100;

/** `orders.list()` 的页大小：见 `clampPageLimit`。 */
export function clampOrderLimit(limit: number): number {
  return clampPageLimit(limit, ORDER_PAGE_MAX, ORDER_PAGE_DEFAULT);
}

/**
 * 「终态」委托状态：不会再变的状态码，其余任何值都还可能与交易所不一致（§2.2）。
 *
 * 覆盖两套词汇，因为 `orders.status` 里两套都会出现：
 *  · 普通订单 —— `binance/types.ts` 的 `BinanceOrderStatus`；
 *  · Algo 条件单 —— 同文件的 `BinanceAlgoStatus`（`NEW` / `FINISHED` / `TRIGGERED` / …）。
 *    两者只有 `NEW` 重合，所以 `FINISHED` 必须在这里列出来：漏掉它，一张已经触发成交的
 *    条件单就会被当成"还在挂"。
 *
 * 判据写成**否定**形式（`status NOT IN 终态`）而不是 `status IN (NEW, PARTIALLY_FILLED)`：
 * 交易所会新增状态码（`EXPIRED_IN_FUTURES` 就是后来补的），用肯定判据的话一个没见过的
 * 状态码会被当成"已经结清"，于是一张真的还挂着的单在本地被判成终态 —— 那正是这次要修的
 * 那类错误的方向。反过来，多结清一行是无害的：结清之前一定先问过交易所
 * （见 `AutoTrader.settleStaleOrders()`）。
 *
 * `TRIGGERED` 刻意**不在**终态里：条件单触发之后，它产生的那张市价单还要成交
 * （理由同 `binance/broker.ts` 的 `TERMINAL_ALGO_STATUSES`）。
 *
 * 控制台的 `TraderTables.tsx` 有一份等价实现（前端不能 import 服务端），两处要一起改。
 */
export const TERMINAL_ORDER_STATUSES: readonly string[] = [
  'FILLED',
  'FINISHED',
  'CANCELED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
  'EXPIRED_IN_FUTURES',
];

export const orders = {
  /**
   * Exchange order ids this trader has placed, newest first.
   *
   * Reconciliation needs this to answer "did *this* trader open that
   * round-trip?" — two traders can share one exchange account, in which case
   * every fill in the account is visible to both and only the order history says
   * which one actually traded it.
   */
  exchangeOrderIds(traderId: number, limit?: number): Set<string> {
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      const safeLimit = Math.max(0, Math.floor(limit));
      return new Set(
        getDb()
          .all<{ exchange_order_id: string | null }>(
            'SELECT exchange_order_id FROM orders WHERE trader_id = ? AND exchange_order_id IS NOT NULL ORDER BY id DESC LIMIT ?',
            traderId,
            safeLimit,
          )
          .map((r) => String(r.exchange_order_id)),
      );
    }
    return new Set(
      getDb()
        .all<{ exchange_order_id: string | null }>(
          'SELECT DISTINCT exchange_order_id FROM orders WHERE trader_id = ? AND exchange_order_id IS NOT NULL',
          traderId,
        )
        .map((r) => String(r.exchange_order_id)),
    );
  },

  /**
   * **全部**机器人挂过的交易所订单号 —— 用来把「别人的机器人」和「外部活动」分开。
   *
   * ## 为什么不能复用 `exchangeOrderIds(traderId)`
   *
   * 那个函数默认只取最新 2000 条，而且按机器人过滤。它的上限是**归属判断**的
   * 保守设计（宁可跳过也不冒认一笔），但用在"这笔成交是不是平台的"上会
   * 反过来：订单超过 2000 条之后，**本平台自己的早期成交会被误报成外部活动**。
   *
   * 所以这里**不设上限**，也不过滤机器人。
   */
  allExchangeOrderIds(): Set<string> {
    return new Set(
      getDb()
        .all<{ exchange_order_id: string | null }>(
          'SELECT DISTINCT exchange_order_id FROM orders WHERE exchange_order_id IS NOT NULL',
        )
        .map((r) => String(r.exchange_order_id)),
    );
  },

  /**
   * 本机器人的「交易所单号 → 用途」映射（`entry` / `exit` / `stop_loss` / …）。
   *
   * ## 它存在的理由：校验**重建出来的回合有没有把方向搞反**
   *
   * `reconstructRoundTrips()` 用的是**净头寸法** —— 按持仓数量的变化判断哪一笔
   * 是开仓、哪一笔是平仓。而它的输入是 `getUserTrades(symbol, 500)`（最近 500 笔）
   * 且**没有"起始持仓"这个信息**：如果窗口起点落在一个持仓的中间，第一笔
   * （其实是平仓）会被当成开仓，**整个 leg 的 open/close 就此反向**。
   *
   * 实测（2026-09-29）：6 笔 `reconciled` 回合的 `entry_order_id` 在 `orders` 里
   * 记的用途是 `exit`、而 `exit_order_id` 记的是 `entry`，两者甚至相隔 2 天 ——
   * 合计 `-0.125559`，**正好等于账目校验的全部缺口**。也就是说：**账本没错，
   * 是重建凭空造出了这 6 笔反向的回合**，还顺带让 `findDuplicate()` 的
   * 单号去重判据失效。
   *
   * 运行期记下的 `purpose` 是我们**下单时的真实意图**，用它反查一次即可辨认。
   */
  purposeByExchangeOrderId(traderId: number): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of getDb().all<{ exchange_order_id: string | null; purpose: string }>(
      'SELECT exchange_order_id, purpose FROM orders WHERE trader_id = ? AND exchange_order_id IS NOT NULL',
      traderId,
    )) {
      if (row.exchange_order_id === null) continue;
      map.set(String(row.exchange_order_id), String(row.purpose));
    }
    return map;
  },

  /**
   * **每个标的最近一次被交易所确认过的保证金模式**（`symbol → 'isolated' | 'cross'`）。
   *
   * ## 为什么需要它（2026-10-18 · 用户实测）
   *
   * 用户看到订单记录里「保证金模式」这一列**有一部分是空的**：
   * ```
   *   entry      103 笔 → 0 笔缺 ✓
   *   exit        37 笔 → 21 笔缺
   *   stop_loss  132 笔 → 12 笔缺
   * ```
   *
   * 根因不是写库漏了，而是 `AutoTrader.marginSet` 是**进程内内存**：
   * 每次部署重启后就清空，于是"本进程没为这个标的设过" ⇒ `recordOrder` 如实写 `NULL`。
   * 实测同一标的（`TIAUSDT`）19 笔有值、9 笔无值 —— 正是"重启前 / 重启后"的分界。
   *
   * ⇒ 启动时用这张表把内存填回来。**它只影响显示，不改变任何设置行为**
   *   （`executeOpen` 仍会照常 `setMarginType`，`marginSet` 依旧只记成功的那次）。
   *
   * ## 为什么取 `MAX(id)` 而不是"最后一次设置时间"
   *
   * `orders` 里没有"设置模式"这个动作的记录，只有下单记录。所以"该标的最新的那条
   * 带模式的订单"就是最接近事实的近似 —— 而且它**只会更保守**：
   * 如果之后有人在交易所手工改了模式，这里记的仍是旧值，界面那列的 `title`
   * 与 `/positions` 的实时读取会兜底（见 `recordOrder` 的说明）。
   */
  /**
   * **某标的下还在挂着的保护单类型**（`STOP*` / `TAKE_PROFIT*`）。
   *
   * ## 为什么需要它
   *
   * 界面要回答「这个持仓的保护单到底挂上了没有」。`positions` 表的
   * `stop_loss` / `take_profit` 只是**意向值**（决策时就算好了），
   * 而"挂上了"这件事只有 `orders` 表知道 —— 那里才有 `status = 'NEW'` 的行。
   *
   * 两者在开仓后的头两秒会不一致：
   * ```
   *   t+0s  持仓行已写，stop_loss 有值
   *   t+2s  保护单行才写进 orders
   * ```
   * 窗口内若只看 `positions`，界面会把"正在挂"说成"没有"。
   *
   * ⚠️ 只返回**保护单**类型（止损/止盈），不含入场单 ——
   * 调用方问的是"有没有保护"，入场单不是保护。
   */
  /**
   * **把某标的还挂着的单标记为已撤销**（2026-10-21 实盘抓到）。
   *
   * ## 为什么需要它
   *
   * 用户报告：「JEV实盘我停了，然后手动点了全部平仓，仓位好像平了，
   * 但是当前委托里面为什么还有」。
   *
   * 实测那 6 张单在交易所侧**全是 `CANCELED`**（条件单是
   * `closePosition` 类型，仓位一平交易所就自动撤销它们），
   * 而本地 `orders` 表仍然停在 `NEW` ⇒ 界面的「当前委托」显示幽灵单。
   *
   * ## 根因
   *
   * `closeManually()` 调了 `broker.cancelAllOrders(symbol)` 撤**交易所侧**，
   * 但没有任何一步回写本地 `orders` 表。而正常轮次里的对账
   * （`settleStaleOrders`）会清理这类残留 —— **可它只在机器人运行时跑**，
   * 而这次是「先停机器人、再手工平仓」，对账没有机会执行。
   *
   * ⇒ 平仓路径必须**立即**清账，而不是指望下一轮对账。
   *
   * ⚠️ 只动 `status='NEW'` 的行：已成交（`FILLED`）与早已撤销的行
   * 是历史事实，不能改写。
   */
  cancelOpenBySymbol(traderId: number, symbol: string): number {
    const result = getDb().run(
      `UPDATE orders SET status = 'CANCELED', cancel_source = COALESCE(cancel_source, 'manual'), updated_at = ?
        WHERE trader_id = ? AND symbol = ? AND status = 'NEW'`,
      now(),
      traderId,
      symbol,
    );
    return Number(result.changes ?? 0);
  },

  /**
   * 仅把指定标的与用途（止损 / 止盈）下仍处于 `NEW` 的本地保护委托标为 `CANCELED`。
   *
   * 2026-11-24 实测修复：模拟盘移动止损（`applyBreakevenGuard`）或调整保护位时，
   * `cancelAllProtection` 在 dry-run 直接返回 0，旧 `STOP_MARKET` 本地行留在 `NEW`，
   * 导致委托表里同一仓位同时出现多张活跃止损单。
   */
  cancelOpenProtectionBySymbol(
    traderId: number,
    symbol: string,
    kinds: { stop?: boolean; target?: boolean },
    cancelSource?: OrderCancelSource,
  ): number {
    const purposes: string[] = [];
    if (kinds.stop) purposes.push('stop_loss');
    if (kinds.target) purposes.push('take_profit');
    if (purposes.length === 0) return 0;
    const placeholders = purposes.map(() => '?').join(', ');
    const src = normalizeCancelSource(cancelSource);
    const result = getDb().run(
      `UPDATE orders SET status = 'CANCELED', cancel_source = COALESCE(?, cancel_source), updated_at = ?
        WHERE trader_id = ? AND symbol = ? AND status = 'NEW' AND purpose IN (${placeholders})`,
      src,
      now(),
      traderId,
      symbol,
      ...purposes,
    );
    return Number(result.changes ?? 0);
  },

  openProtectionTypes(traderId: number, symbol: string): string[] {
    const rows = getDb().all<{ type: string }>(
      `SELECT type FROM orders
        WHERE trader_id = ? AND symbol = ? AND status = 'NEW'
          AND (type LIKE 'STOP%' OR type LIKE 'TAKE_PROFIT%' OR type = 'TRAILING_STOP_MARKET')`,
      traderId,
      symbol,
    );
    return rows.map((row) => row.type);
  },

  latestMarginTypeBySymbol(traderId: number): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of getDb().all<{ symbol: string; margin_type: string }>(
      `SELECT o.symbol, o.margin_type
         FROM orders o
         JOIN (SELECT symbol, MAX(id) AS mid
                 FROM orders
                WHERE trader_id = ? AND margin_type IS NOT NULL AND margin_type <> ''
                GROUP BY symbol) latest
           ON o.id = latest.mid`,
      traderId,
    )) {
      map.set(String(row.symbol), String(row.margin_type));
    }
    return map;
  },

  /**
   * 某机器人的订单记录，**最新在前**，一次一页。`before` 是游标：只返回 `id < before` 的行。
   *
   * ## 为什么用 `before=id` 而不是 `offset`
   *
   * 这个列表**在顶部持续插入**：机器人每下一单就多一行。用 `OFFSET 25` 取"第二页"时，
   * 只要第一页之后又落了一张新订单，整个窗口就往下挪一格 —— 第二页的第一条会和第一页的
   * 最后一条**重复**（同一张订单在表格里出现两次，看起来像下了两单）。游标锚在一条具体
   * 订单的 `id` 上：新订单的 `id` 一定更大、永远落在游标之上，页与页之间既不重也不漏。
   * `trades.list()` / `decisions.list()` 是同一套契约。
   *
   * ## 排序键必须就是游标键
   *
   * 翻页边界要成立，`ORDER BY` 与游标只能是同一列，所以这里按自增主键 `id`（写入顺序）
   * 倒序。它同时仍然是"最新的一单在最上面"：订单是**下出去那一刻**写进来的，
   * `id` 倒序与原来的 `created_at DESC` 是同一个顺序。
   * 索引 `idx_orders_trader` 建在 `created_at` 上，所以这条查询会在按 `trader_id`
   * 过滤之后再排序，代价可以忽略 —— 换来的是页边界不可能漏行或重复。
   *
   * 页大小由 `clampOrderLimit` 钳制：`?limit=999999` 最多只会拿到 `ORDER_PAGE_MAX` 条。
   */
  list(traderId: number, limit = ORDER_PAGE_DEFAULT, before?: number | null): OrderRecord[] {
    const pageSize = clampOrderLimit(limit);
    const cursor = cursorOf(before);

    /*
     * 各标的的杠杆读数（**含 `pending` 行**）—— 挂单在本地是有持仓行的，
     * 那张行上就记着杠杆。界面要靠它显示"开仓单的杠杆"：
     * 不能按交易所的真实持仓读（挂单还没成交，那里没有）。
     */
    const leverages = new Map<string, number>();
    for (const p of getDb().all<{ symbol: string; leverage: number }>(
      'SELECT symbol, leverage FROM positions WHERE trader_id = ? ORDER BY id ASC',
      traderId,
    )) {
      if (typeof p.leverage === 'number' && p.leverage > 0) leverages.set(p.symbol, p.leverage);
    }

    // 第一页与后续页只有 WHERE 一段不同：分成两条 SQL 是为了两条都能吃到索引，
    // 也不用把 `(? IS NULL OR id < ?)` 这种对优化器不友好的写法塞进热路径。
    if (cursor === null) {
      return getDb()
        .all<OrderRow>(
          'SELECT * FROM orders WHERE trader_id = ? ORDER BY id DESC LIMIT ?',
          traderId,
          pageSize,
        )
        .map((row) => toOrder(row, leverages));
    }

    return getDb()
      .all<OrderRow>(
        'SELECT * FROM orders WHERE trader_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        traderId,
        cursor,
        pageSize,
      )
      .map((row) => toOrder(row, leverages));
  },

  /**
   * **还没平掉的那些仓位，已经付掉的入场成本合计**（手续费 + 资金费）。
   *
   * ## 为什么总账校验需要它
   *
   * 交易所的流水（`incomeEvents`）从**开仓那一刻**就有 `COMMISSION`，持仓期间还会
   * 有 `FUNDING_FEE`；而平台的 `trades` **只在平仓时**记一笔。于是只要有持仓，
   * 「平台净额」天然比「交易所流水」少一个"未平仓的持有成本"。
   *
   * 实测：两条告警的差额 `0.0119` / `0.0202` 正好等于当时那两个仓位的入场手续费
   * （ETH `0.0118539` + HYPE `0.00837404`）。而它被报成了
   * **「平台的账本可能有漏记或重复记账，请先核对再让机器人继续交易」** ——
   * 一个纯粹的口径差被说成了账目错误，而且每轮都报一次。
   *
   * 所以总账校验的两侧必须用**同一个口径**：把未平仓的持有成本加到平台侧。
   *
   * @param entryOrderIds **当前仍然持仓**的那些仓位各自的入场订单号
   *   （`positions.entry_order_id`）。
   *
   *   ⚠️ **必须是"这一笔持仓的入场单"，不能按 `symbol` 过滤。**
   *
   *   原来这里收的是 symbol 列表，于是**同一个标的历史上已平仓回合的入场手续费
   *   会被重复计入**（那些回合的盈亏早已通过 `trades` 记进 `platformSelf`，
   *   入场费再加一遍就是记两次）。函数自己的注释也写着"不传 symbols 会把已平仓的
   *   入场费算进来，反而造成反向误差 —— 所以要传"，**但传 symbol 根本没解决它**：
   *   同一标的反复开平是常态。
   *
   *   按入场订单号过滤之后，这一项才真的等于"手上这些仓位已经付掉的入场费"。
   *
   *   另：`orders` 表**没有资金费列**，持仓期间的资金费只存在于交易所流水
   *   （`income`）那一侧。**这一项只覆盖手续费** —— 所以调用方还要另外把
   *   未平仓仓位的资金费补上（`fundingSince()`）。
   *
   *   ✅ 2026-10-03：那条补充已经接上了（见 `reconcileTradeHistory` 里的 `openCosts`）。
   *   这里原来写的是「平台侧在跨过资金费结算点时仍会偏小一点，这是**已知且方向固定的
   *   残差，不要再靠猜口径去补**」—— 而它**不用猜**：资金费就在 `income` 流水里，
   *   按标的 + 开仓之后聚合即可。留着那条注释会让人以为这个偏差是设计上接受的。
   */
  openEntryCosts(traderId: number, entryOrderIds: readonly string[]): number {
    const ids = entryOrderIds.filter((id) => id.length > 0);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const row = getDb().get<{ total: number | null }>(
      `SELECT SUM(COALESCE(fee, 0)) AS total
         FROM orders
        WHERE trader_id = ?
          AND purpose = 'entry'
          AND status = 'FILLED'
          AND exchange_order_id IN (${placeholders})`,
      traderId,
      ...ids,
    );
    return Number(row?.total ?? 0);
  },

  /**
   * 账户级未平仓入场手续费合计（兼容多机器人共用账户及加仓订单）。
   *
   * 每个当前 `open` 持仓既匹配其 `entry_order_id`（首笔开仓，包括更早挂出的限价入场单），
   * 也匹配该标的在 `opened_at` 之后成交的同机器人 `purpose = 'entry'` 加仓订单，
   * 避免旧实现只看单机器人或漏算加仓单手续费导致总账校验出现假差额。
   */
  openEntryCostsForAccount(
    openPositions: readonly Array<{
      trader_id: number;
      symbol: string;
      opened_at: string;
      entry_order_id: string | null;
    }>[number][],
  ): number {
    let total = 0;
    const db = getDb();
    for (const pos of openPositions) {
      const entryId = pos.entry_order_id && pos.entry_order_id.length > 0 ? pos.entry_order_id : null;
      const row = db.get<{ total: number | null }>(
        `SELECT SUM(COALESCE(fee, 0)) AS total
           FROM orders
          WHERE trader_id = ?
            AND symbol = ?
            AND purpose = 'entry'
            AND status = 'FILLED'
            AND (
                  (? IS NOT NULL AND exchange_order_id = ?)
               OR created_at >= ?
            )`,
        pos.trader_id,
        pos.symbol,
        entryId,
        entryId,
        pos.opened_at,
      );
      total += Number(row?.total ?? 0);
    }
    return total;
  },

  insert(input: {
    traderId: number;
    exchangeOrderId: string | null;
    clientOrderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    type: string;
    purpose: OrderRecord['purpose'];
    quantity: number;
    price: number | null;
    stopPrice: number | null;
    status: string;
    /** Fill details. Omitted for orders that rest (stops, targets) or are rejected. */
    avgPrice?: number | null;
    filledQty?: number;
    fee?: number;
    error?: string | null;
    rawResponse?: unknown;
    /**
     * 这一行对应占用的保证金（USDT 本金）。
     *
     * **不传就是"不知道"**（落 `NULL`，读取时是 `undefined`）。
     * ⚠️ 不要用 0 表达"不知道" —— 0 会被读成"这笔没占保证金"，
     * 见 `M13_ORDER_MARGIN_USED` 与 `toOrder()`。
     */
    marginUsed?: number | null;
    /**
     * 下单时该标的的保证金模式（`cross` / `isolated`，也接受配置里那个 `crossed`）。
     *
     * **不传就是"不知道"**（落 `NULL`，读取时是 `undefined` → 界面 `—`）。
     * ⚠️ 不要用 `'cross'` 表达"不知道" —— 币安的默认是全仓，但"默认是"不是
     * "我们读到了"，见 `M14_ORDER_MARGIN_TYPE`。
     *
     * 收的是**原始拼法**（交易所读回来是 `cross`、策略配置里是 `crossed`），
     * 由 `normalizeMarginMode()` 归一后落库；**认不出的拼法落 `NULL` 而不是报错** ——
     * 好过让一个拼法差异悄悄变成"另一个模式"。
     */
    marginType?: MarginMode | string | null;
  }): number {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO orders (trader_id, exchange_order_id, client_order_id, symbol, side, type, purpose, quantity, price, stop_price, status, avg_price, filled_qty, fee, error, raw_response, margin_used, margin_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.exchangeOrderId,
      input.clientOrderId,
      input.symbol,
      input.side,
      input.type,
      input.purpose,
      input.quantity,
      input.price,
      input.stopPrice,
      input.status,
      input.avgPrice ?? null,
      input.filledQty ?? 0,
      input.fee ?? 0,
      input.error ?? null,
      input.rawResponse === undefined ? null : JSON.stringify(input.rawResponse),
      /* 落库前再收一次：这一列的值只有"正数"或"不知道"两种，见 `positiveOrNull()`。 */
      positiveOrNull(input.marginUsed),
      /* 同上：只有 `cross` / `isolated` 或"不知道"，见 `normalizeMarginMode()`。 */
      normalizeMarginMode(input.marginType),
      ts,
      ts,
    );
    return lastInsertRowid;
  },

  /**
   * 按**交易所单号**找一行。
   *
   * ## 为什么需要它（而不是用本地 `orders.id`）
   *
   * 成交那一刻手上只有**持仓行**（`promotePendingEntry()`），而
   * `positions.entry_order_id` 存的是**交易所单号** —— 本地订单表的主键在那条路径上
   * 根本拿不到。加这个方法，是为了让"成交了"这件事能在**发生的地方**写回订单行，
   * 而不是指望以后有人来收拾（实测就是没人收拾：那张开仓单从成交起一直停在 `NEW`，
   * 界面上同时显示"持仓 12.7 @ 1.5600"和"开仓 限价 已挂单"）。
   */
  findByExchangeOrderId(traderId: number, exchangeOrderId: string): OrderRecord | null {
    const row = getDb().get<OrderRow>(
      'SELECT * FROM orders WHERE trader_id = ? AND exchange_order_id = ? ORDER BY id DESC LIMIT 1',
      traderId,
      exchangeOrderId,
    );
    return row ? toOrder(row) : null;
  },

  /**
   * 仍处于**非终态**、且早于 `createdBefore` 的委托行，最新在前。
   *
   * 这是"交易所已经不挂了、本地还停在 `NEW`"那些行的候选集。它只做筛选：
   * 这里**判断不了**哪一行真的已经不在交易所 —— 那只能问交易所，所以调用方
   * （`AutoTrader.settleStaleOrders()`）在改任何一行之前都会先去读挂单列表。
   *
   * `createdBefore` 是给刚下的单留的宽限窗口（窗口多长、为什么需要，见
   * `ORDER_SETTLE_GRACE_MS`）：挂单列表是一次**读**，而一张单从"我们记下它"到
   * "交易所的挂单列表里能看到它"之间可能有极短的时延，没有这个下界就会把刚挂上去的
   * 保护单结清掉 —— 那正好是 §2.6 最怕的事。
   */
  unsettled(traderId: number, createdBefore: string): OrderRecord[] {
    const placeholders = TERMINAL_ORDER_STATUSES.map(() => '?').join(', ');
    return getDb()
      .all<OrderRow>(
        `SELECT * FROM orders WHERE trader_id = ? AND created_at <= ? AND status NOT IN (${placeholders}) ORDER BY id DESC`,
        traderId,
        createdBefore,
        ...TERMINAL_ORDER_STATUSES,
      )
      .map((row) => toOrder(row));
  },

  /**
   * 就地修正一行订单。
   *
   * `undefined` **保持原值**（而不是写成 null）：调用方只想改状态时不必先把整行读出来，
   * 也不会顺手把它没打算碰的成交数量清掉。
   */
  update(
    id: number,
    input: Partial<{
      status: string;
      avgPrice: number | null;
      filledQty: number;
      fee: number;
      error: string | null;
      /**
       * 交易所对这张单的**最终**答复。结清一张条件单时写在这里，
       * 于是 `raw_response` 从头到尾都是交易所说过的话（§2.2），而不是只剩一个状态码。
       */
      rawResponse: unknown;
      /** 订单被撤销时的操作来源（模型 / 系统 / 手动），见 `M23_ORDER_CANCEL_SOURCE`。 */
      cancelSource: OrderCancelSource | null;
    }>,
  ): void {
    const row = getDb().get<OrderRow>('SELECT * FROM orders WHERE id = ?', id);
    if (!row) return;
    getDb().run(
      'UPDATE orders SET status = ?, avg_price = ?, filled_qty = ?, fee = ?, error = ?, raw_response = ?, cancel_source = ?, updated_at = ? WHERE id = ?',
      input.status ?? row.status,
      input.avgPrice === undefined ? row.avg_price : input.avgPrice,
      input.filledQty ?? row.filled_qty,
      input.fee ?? row.fee,
      input.error === undefined ? row.error : input.error,
      input.rawResponse === undefined ? row.raw_response : JSON.stringify(input.rawResponse),
      input.cancelSource === undefined ? (row.cancel_source ?? null) : normalizeCancelSource(input.cancelSource),
      now(),
      id,
    );
  },

  /** Fee total for a trader's trades, used in stats. */
  totalFees(traderId: number): number {
    const row = getDb().get<{ total: number | null }>(
      'SELECT SUM(fee) AS total FROM orders WHERE trader_id = ?',
      traderId,
    );
    return row?.total ?? 0;
  },
};

