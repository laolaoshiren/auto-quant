import type { CloseReason, TradeRecord } from '@aq/shared';
import { beijingDayStartIso } from '@aq/shared';
/* 净盈亏的唯一算式 —— 见 `netPnlOf` 的注释（资金费的符号）。 */
import { netPnlOf } from '../binance/income.js';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';
import { clampPageLimit, cursorOf, normalizeMarginMode } from './ordersRepo.js';

const log = createLogger('store');
const now = (): string => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/*  Trades                                                                     */
/* -------------------------------------------------------------------------- */

interface TradeRow {
  id: number;
  trader_id: number;
  symbol: string;
  side: string;
  quantity: number;
  entry_price: number;
  exit_price: number;
  leverage: number;
  pnl: number;
  pnl_percent: number;
  fee: number;
  close_reason: string;
  opened_at: string;
  closed_at: string;
  hold_minutes: number;
  entry_fee: number;
  funding_fee: number;
  net_pnl: number;
  source: string;
  entry_order_id: string | null;
  exit_order_id: string | null;
  /**
   * **JOIN 出来的列，不是 `trades` 自己的列** —— 见 `TradeRecord.marginType`。
   *
   * 查询里用 `LEFT JOIN orders`（按 `exchange_order_id = entry_order_id`）拿到
   * 入场那一单的保证金模式。补录的回合或 v14 之前的订单没有匹配行时是 `null`。
   */
  entry_margin_type?: string | null;
}

function toTrade(row: TradeRow): TradeRecord {
  return {
    id: row.id,
    traderId: row.trader_id,
    symbol: row.symbol,
    side: row.side as 'long' | 'short',
    quantity: row.quantity,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    leverage: row.leverage,
    pnl: row.pnl,
    entryFee: row.entry_fee,
    exitFee: Math.max(0, row.fee - row.entry_fee),
    fee: row.fee,
    fundingFee: row.funding_fee,
    netPnl: row.net_pnl,
    pnlPercent: row.pnl_percent,
    closeReason: row.close_reason,
    source: (row.source === 'reconciled' ? 'reconciled' : 'bot') as 'bot' | 'reconciled',
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    holdMinutes: row.hold_minutes,
    /*
     * 保证金是**派生**的，不落库：这一行的三个输入都在，而且建仓时写进
     * `positions.margin_used` 用的就是同一个 `marginOf()`（`trades.insert()` 里
     * 算 `pnl_percent` 用的也是它）—— 三处必须是同一个数，否则"这笔占了多少本金"
     * 会随读它的地方而变。
     */
    marginUsed: marginUsedOrUndefined(row.entry_price, row.quantity, row.leverage),
    /*
     * 保证金模式来自**入场订单那一行**（SQL 里的 `LEFT JOIN orders`）。
     * 取不到就是 `undefined`（界面显示 `—`），绝不回落到 `'cross'` —— 见
     * `TradeRecord.marginType` 上的说明。
     */
    marginType: normalizeMarginMode(row.entry_margin_type) ?? undefined,
  };
}

/**
 * Margin committed by a round-trip, used to express net PnL as a percentage.
 *
 * 出口（`export`）是给 `AutoTrader` 用的：开仓 / 加仓那条路径要在**写订单行**时
 * 把同一个数写进 `orders.margin_used`，而"名义价值 ÷ 杠杆"这个算式**只能有一份** ——
 * 调用点各写一遍的话，两边迟早会分叉（仓库里已经有过"同一个算式五份副本"的教训）。
 */
export function marginOf(entryPrice: number, quantity: number, leverage: number): number {
  const notional = Math.abs(entryPrice * quantity);
  return notional > 0 ? notional / Math.max(leverage, 1) : 0;
}

/**
 * `marginOf()` 的**可缺失版本**：算不出来时回 `undefined`，绝不回 `0`。
 *
 * 为什么要多一个名字：`marginOf()` 在名义价值为 0、或杠杆缺失时都会回一个数字
 * （后者靠 `Math.max(leverage, 1)` 兜底，把 5x 的仓位算成 1x 的保证金，
 * 金额直接放大 5 倍）。而"保证金占用"是要印在界面上的：`0` 读作"这笔没占保证金"，
 * 那个 5 倍的数字读作一个具体金额 —— **两句都是编的**。所以这里在入口就把
 * "缺输入"挡住，让它变成 `undefined`（界面显示 `—`）。
 */
function marginUsedOrUndefined(
  entryPrice: number,
  quantity: number,
  leverage: number,
): number | undefined {
  if (!Number.isFinite(leverage) || leverage <= 0) return undefined;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(quantity)) return undefined;
  if (entryPrice === 0 || quantity === 0) return undefined;
  return marginOf(entryPrice, quantity, leverage);
}

/**
 * How many round-trips the dashboard's trend window covers.
 *
 * 5000 is the same ceiling the console used to request, now applied **in SQL**
 * via `ORDER BY closed_at DESC LIMIT ?` instead of by loading every row and
 * slicing in JavaScript. For any trader under 5000 round-trips the numbers the
 * dashboard renders are byte-for-byte what they were before.
 */
export const TREND_WINDOW = 5000;

/**
 * 疑似重复行的**报告**窗口（毫秒）。
 *
 * 检测比写入守卫更宽：守卫要求 `closed_at` 毫秒精确相同（见 `findDuplicate()`），
 * 是因为它要**改账**；而这里只是把可疑的成对行报给人看，宁可多报也不能漏报 ——
 * 漏掉一对，操作者就永远不知道账上多了一份盈亏。所以窗口放到 1 秒。
 */
const DUPLICATE_REPORT_WINDOW_MS = 1000;

/**
 * 判定"这是同一个回合"时，数量与入场价允许的偏差（相对值）。
 *
 * ## 为什么数量不能当判据
 *
 * 同一回合的两条记账路径本来就按**不同口径**取数量：运行期记的是本地持仓行的
 * 数量（下单时按名义价值取整得到的），对账记的是交易所实际成交量（多笔成交加权后
 * 保留 12 位）。实盘上那三组重复行能被生成，正是因为这两个口径**不相等**时没有任何
 * 东西拦它；这次复现量到的偏差是 0.008823 对 0.008923（约 1.1%）。
 *
 * 所以容差不能按"浮点噪声"来定 —— 差 1.1% 完全正常，而 1e-6 这种要求浮点相等的
 * 判据正是这个 bug 钻过去的缝。20% 的用意是：数量只用来**排除明显不相干的同一标的
 * 其它回合**，真正的身份是 `closed_at`（同一个真实成交，两条路径拿到的时间戳一致，
 * 实测差 368ms）。单向持仓模式下同一标的同一毫秒不可能平掉两个仓位，所以
 * `closed_at` 命中就是同一个真实事件。
 */
const DUPLICATE_QUANTITY_TOLERANCE = 0.2;

/**
 * 入场价的相对容差。
 *
 * 两条路径的入场价都来自交易所，但一条是持仓行里的成交均价、另一条是多笔成交
 * 加权后保留 12 位的 VWAP，多笔分批成交时最后几位可以不同 —— 所以这里也是
 * 相对比较，而不是"浮点相等"。
 */
const DUPLICATE_PRICE_TOLERANCE = 1e-6;

/**
 * **出场价**的相对容差 —— 两条记账路径之间唯一同源的那个字段。
 *
 * 取得比入场价那条（1e-6）宽、比"完全相等"实际：同一个真实成交的出场均价
 * 在两条路径上可能因为分批成交的加权顺序差末位，但不可能差出千分之一。
 * 0.05% 对 2600 美元的 ETH 是 1.3 美元 —— 远小于任何两个**不同**回合之间的价差
 * （同标的、同方向、同数量、同一价位附近平掉两笔真实回合，中间还隔着再入场冷却）。
 *
 * 详见 `findDuplicate()` 里那段"为什么不能靠放宽平仓时间"的说明。
 */
const DUPLICATE_EXIT_PRICE_TOLERANCE = 5e-4;

/**
 * **入场时间**允许的偏差（毫秒）—— 判定"同一个回合"的主判据。
 *
 * ## 为什么是 `opened_at` 而不是 `closed_at`
 *
 * 实测一对真实的重复（同一笔 ETH 被记了两次）：
 *
 *     #90 bot          opened_at 17:14:51.381   closed_at 02:02:20.361
 *     #92 reconciled   opened_at 17:14:41.276   closed_at 01:51:35.036
 *
 * **入场时间只差 10 秒**（下单到成交的延迟），**平仓时间差了 11 分钟**。
 * 两个字段的差别在于**它们各自从哪来**：
 *
 *  · `opened_at` 两条路径都锚在**这笔仓位什么时候开的**，中间只隔下单延迟；
 *  · `closed_at` 一条是本地"察觉到仓位消失"的时刻（可能晚一整轮），
 *    另一条是交易所成交记录里的时刻 —— **两个不同的时钟**。
 *
 * 所以身份判据要挂在 `opened_at` 上，而不是 `closed_at`。
 *
 * ## 为什么 5 分钟既能覆盖又能区分
 *
 *  · **能覆盖**：同一回合的两条路径差的是下单延迟，实测 10 秒；
 *  · **能区分**：同一标的两笔**真实**回合之间至少隔着再入场冷却
 *    （`throttle.reentryCooldownMinutes`，配置里是 10 分钟）——
 *    而 `autoTrader.test.ts` 里那个 fixture 的两笔正好差 11 分钟。
 *
 * 5 分钟留了一半余量给"时钟漂移 + 下单延迟"，又远小于冷却时间。
 */
const DUPLICATE_OPEN_TOLERANCE_MS = 300_000;

/**
 * `closed_at` 允许的偏差（毫秒）—— **这是写入守卫的关键容差**。
 *
 * ## 为什么不能要求毫秒精确相等
 *
 * 这一处原来写的是
 * `strftime('%Y-%m-%dT%H:%M:%f', closed_at) = strftime('%Y-%m-%dT%H:%M:%f', ?)`，
 * 即**毫秒精确相等**。而同一回合的两条记账路径拿到的平仓时刻本来就不同：
 * 运行期用的是它在本地**察觉到仓位消失**的时刻，对账用的是交易所**成交记录**里的时刻。
 *
 * 上一条注释一边说这两者"一致、实测差 368ms"，一边把守卫写成精确相等 ——
 * **自相矛盾，于是守卫在它本该生效的那个场景里永远不会触发**。实盘后果实测到了：
 *
 *     #29 BULLAUSDT  closed_at 17:39:06.483  source=bot         费 0
 *     #30 BULLAUSDT  closed_at 17:39:06.033  source=reconciled  费 0.0249
 *
 * 同一个回合被记了两次，账面多算一笔 -0.156 的亏损。
 *
 * ## 为什么 2 秒是安全的
 *
 * 单向持仓模式下**同一标的同一时刻只能有一个仓位**；同一标的的两笔真实回合之间
 * 至少隔着再入场冷却（配置里是分钟级）。所以 2 秒远不足以把两笔真实回合并成一笔，
 * 而 450ms 这种路径差异又能被覆盖。
 */
const DUPLICATE_CLOSE_TOLERANCE_MS = 2000;

/**
 * How many equity snapshots the time-to-trough drawdown considers.
 *
 * Same number the console passed inline before (`equity.list(traderId, 5000)`),
 * hoisted to a named constant so the single read and any future caller agree on
 * it. With one snapshot per cycle, 5000 covers a 15-minute trader for ~52 days —
 * beyond that the dashboard's drawdown is "recent", and the *breaker* uses
 * `equity.realizedHighWaterMark()`, which is unaffected by this bound.
 */
export const EQUITY_CURVE_WINDOW = 5000;

/** One point of the PnL curve. Where the type says `snake_case`, SQL named it. */
export interface TradeCurvePoint {
  pnl: number;
  pnl_percent: number;
  net_pnl: number;
  fee: number;
  funding_fee: number;
  closedAt: string;
}

export interface TradeStats {
  totalTrades: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  best: number;
  worst: number;
  avgWin: number;
  avgLoss: number;
  grossPnl: number;
  totalFees: number;
  totalFunding: number;
  netPnl: number;
  /** Earliest close on the books, for "how long has this been running". */
  firstClosedAt: string | null;
}

/**
 * 一个**固定时间窗口**内的绩效聚合（`trades.performanceSince()`）。
 *
 * 与 `TradeStats` 的区别是"有没有界"：`TradeStats` 是终身口径（给控制台看的），
 * 这个结构是窗口口径（给模型看的）。它存在的全部理由是 §4 的 O(1) 性质 ——
 * 字段是固定的，所以提示词大小与 `trades` 的行数无关。
 */
export interface TradePerformance {
  totalTrades: number;
  wins: number;
  losses: number;
  grossProfit: number;
  /** 亏损单净额的绝对值之和（正数）。 */
  grossLoss: number;
  avgWin: number;
  /** 平均亏损额，**正数**；渲染成负数由调用方决定。 */
  avgLoss: number;
  grossPnl: number;
  totalFees: number;
  totalFunding: number;
  netPnl: number;
  /** Σ|入场价 × 数量|：窗口内回合的名义价值合计。 */
  notional: number;
  /** 往返手续费率（**小数比例**：0.001 = 0.10%）；窗口内没有成交时为 null。 */
  roundTripFeeRate: number | null;
}

/**
 * 一行「由某条情报驱动」的已平仓成交 —— 即 `trades.intel_keys` 的**读取侧**。
 *
 * 它存在的理由是 `trader/intel/signalHealth.ts` 需要输入：`assessSignal()` 的
 * 参数是"这个信号的历史成交"，而那条链（情报 → 决策 → 成交）的落点是
 * `trades.intel_keys`。在 2026-11-09 之前，这一列**只写不读**：
 *
 * ```
 *   写入：开仓写 positions.intel_keys → 平仓搬到 trades.intel_keys   ✅
 *   读取：全仓 0 处                                                  ❌
 *   ⇒ signalHealth 永远 insufficient_data，失效检测从未生效
 * ```
 *
 * 这是与 `clerk` 同一类的"写了但没接线"（见 `docs/archive/FINDING-clerk-unwired.md`）。
 */
export interface TradeIntelAttributionRow {
  /** 该笔成交依据的情报键（`signalKeyOf()` 的产出；**已去重**，坏值已丢弃）。 */
  intelKeys: string[];
  /**
   * 该笔的**净**收益率（小数比例：0.012 = +1.2%）。
   *
   * 取自 `trades.pnl_percent / 100`（那一列是 `net_pnl / margin × 100`，见
   * `trades.insert()`）。与 `signalHealth.SignalTrade.returnPct` 的定义一致。
   */
  returnPct: number;
  /** 平仓时刻（ISO）。 */
  closedAt: string;
}

/**
 * `trades.intelAttributionsSince()` 一次最多回多少笔。
 *
 * 与 `TREND_WINDOW` 同一个理由：这张表随时间无限增长，而调用方会按固定间隔
 * 重算信号健康度。上限让它保持 O(固定行数)，而不是随历史长度线性变慢。
 * 2000 笔足够 20+ 个信号各积累 30+ 样本（`SIGNAL_LIMITS`），也小到不拖慢周期。
 */
export const TRADE_INTEL_ATTRIBUTION_MAX = 2000;

/**
 * **容错解析 `trades.intel_keys` 列**（JSON 数组字符串）。
 *
 * ⚠️ 与 `autoTrader.parseIntelKeysOf` 是**同一条纪律**（那边解析的是
 * `positions.intel_keys`，写入侧；这里是读取侧）：
 * 坏值降级成 `[]`，绝不抛错 —— 一个附属统计字段不该让"读成交"失败。
 * 降级的语义是"这笔没被任何信号驱动"，最坏结果只是少一个样本，
 * 而不是让整份信号健康度报告消失。
 */
function parseIntelKeysColumn(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string' && k.length > 0);
  } catch {
    return [];
  }
}

/**
 * 一次 SQL 聚合出「成交总额」口径的**所有**数字。
 *
 * ## 为什么它必须只有一份（2026-11-09 合并）
 *
 * `aggregateTrades()`（终身口径，给控制台）与 `trades.performanceSince()`
 * （窗口口径，给提示词）原来各自抄了一份完全相同的 9 个 `SUM` / `COUNT` 表达式。
 * 两份副本的**判胜口径**（按净盈亏而不是毛盈亏）一旦漂移，控制台上的胜率与
 * 模型看到的胜率就会说两件事 —— 而"模型照着一个假的胜率做决策"是看不见的。
 *
 * `sinceIso` 省略 = 终身口径；给了就只算 `closed_at >= sinceIso` 的窗口。
 * 聚合仍然全部在 SQL 里完成（见 `aggregateTrades` 的 O(1) 说明）。
 */
interface TradeTotalsRow {
  totalTrades: number;
  wins: number;
  losses: number;
  grossProfit: number | null;
  grossLoss: number | null;
  best: number | null;
  worst: number | null;
  grossPnl: number | null;
  totalFees: number | null;
  totalFunding: number | null;
  netPnl: number | null;
  firstClosedAt: string | null;
  notional: number | null;
}

function aggregateTradeTotals(traderId: number, sinceIso?: string): TradeTotalsRow | undefined {
  const windowed = sinceIso !== undefined;
  return getDb().get<TradeTotalsRow>(
    `SELECT
       COUNT(*)                                                   AS totalTrades,
       COALESCE(SUM(CASE WHEN net_pnl >  0 THEN 1 ELSE 0 END), 0) AS wins,
       COALESCE(SUM(CASE WHEN net_pnl <= 0 THEN 1 ELSE 0 END), 0) AS losses,
       COALESCE(SUM(CASE WHEN net_pnl >  0 THEN net_pnl ELSE 0 END), 0) AS grossProfit,
       ABS(COALESCE(SUM(CASE WHEN net_pnl <= 0 THEN net_pnl ELSE 0 END), 0)) AS grossLoss,
       MAX(net_pnl) AS best,
       MIN(net_pnl) AS worst,
       COALESCE(SUM(pnl), 0)         AS grossPnl,
       COALESCE(SUM(fee), 0)         AS totalFees,
       COALESCE(SUM(funding_fee), 0) AS totalFunding,
       COALESCE(SUM(net_pnl), 0)     AS netPnl,
       MIN(closed_at) AS firstClosedAt,
       COALESCE(SUM(ABS(entry_price * quantity)), 0) AS notional
     FROM trades WHERE trader_id = ?${windowed ? ' AND closed_at >= ?' : ''}`,
    ...(windowed ? [traderId, sinceIso] : [traderId]),
  );
}

/**
 * One pass over `trades`: aggregate in SQL, materialise only the trend window.
 *
 * Why: `computeTraderStats` used to pull every column of every round-trip into
 * JavaScript objects and reduce them there — twice per request, once for
 * `stats()` and once for the Sharpe input — and it is called every 5–12 s per
 * trader. `node:sqlite` is synchronous, so those object graphs were built on the
 * same event loop that places orders. SQLite counts and sums without leaving C,
 * so the JavaScript work drops from O(all round-trips) to O(window).
 *
 * `COUNT(*)` and `SUM(...)` deliberately still cover the **whole** table: the
 * headline totals (lifetime trades, net PnL, fees, funding) must stay lifetime
 * figures and must not silently follow the window.
 */
export function aggregateTrades(traderId: number): { totals: TradeStats; curve: TradeCurvePoint[] } {
  const totals = aggregateTradeTotals(traderId);

  const totalTrades = totals?.totalTrades ?? 0;
  const wins = totals?.wins ?? 0;
  const losses = totals?.losses ?? 0;
  const grossProfit = totals?.grossProfit ?? 0;
  const grossLoss = totals?.grossLoss ?? 0;

  return {
    totals: {
      totalTrades,
      wins,
      losses,
      grossProfit,
      grossLoss,
      // `MAX(net_pnl)` is NULL only when there are no rows, which is reported as 0
      // rather than left as a null the console would have to special-case.
      best: totals?.best ?? 0,
      worst: totals?.worst ?? 0,
      avgWin: wins > 0 ? grossProfit / wins : 0,
      avgLoss: losses > 0 ? grossLoss / losses : 0,
      grossPnl: totals?.grossPnl ?? 0,
      totalFees: totals?.totalFees ?? 0,
      totalFunding: totals?.totalFunding ?? 0,
      netPnl: totals?.netPnl ?? 0,
      firstClosedAt: totals?.firstClosedAt ?? null,
    },
    curve: getDb()
      .all<TradeCurvePoint>(
        `SELECT pnl, pnl_percent, net_pnl, fee, funding_fee, closed_at AS closedAt
           FROM trades WHERE trader_id = ? ORDER BY closed_at DESC LIMIT ?`,
        traderId,
        TREND_WINDOW,
      )
      // Reversed to chronological order: a drawdown walk is direction-sensitive,
      // so walking newest-first would silently report a different (smaller) one.
      .reverse(),
  };
}

/** One detected pair of rows that describe the same real round-trip. */
export interface TradeDuplicateSuspect {
  traderId: number;
  /** `reconciled` 那行与运行期那行的 id；顺序按 id 升序，与来源无关。 */
  idA: number;
  idB: number;
  symbol: string;
  quantity: number;
  closedAt: string;
  reasonA: string;
  reasonB: string;
  netA: number;
  netB: number;
}

/**
 * 一次最多回多少条成交记录。
 *
 * 与 `ORDER_PAGE_MAX` 同一个理由：成交行是最宽的一张（毛盈亏、开/平两侧手续费、
 * 资金费、净盈亏、来源、两个订单号、平仓原因…），而这张表随着每次平仓无限增长。
 * 200 是操作者上一版控制台每次轮询要的条数，上限只为手写请求兜底。
 */
export const TRADE_PAGE_MAX = 200;

/** 不传 `limit` 时返回多少条 —— 与历史契约一致（路由以前写死 100）。 */
export const TRADE_PAGE_DEFAULT = 100;

/** `trades.list()` 的页大小：见 `clampPageLimit`。 */
export function clampTradeLimit(limit: number): number {
  return clampPageLimit(limit, TRADE_PAGE_MAX, TRADE_PAGE_DEFAULT);
}

/**
 * 重建出来的成交量**可信到可以覆盖本地**吗？
 *
 * ## 为什么要有这道判断（实测：账目凭空多出 0.0596）
 *
 * `reconstructRoundTrips()` 用**净头寸法**判断开/平，而它拿不到"窗口起点时的持仓"——
 * 一旦起点落在某个持仓的中间，整条成交序列就会错位。实测（2026-09-29，HYPEUSDT）：
 *
 * ```text
 * 真实成交： 13:17 SELL 0.20（是【平掉更早的空头】）→ 19:53 BUY 0.15（开新多头）→ …
 * 重建结果： 13:17 → 21:37  short qty=0.35 毛=0.000000   ← 把"平 0.20"当成了"开空"
 *            21:37 → 23:25  long  qty=0.01  毛=0.089040   ← 数量被带偏（真实 0.21）
 * ```
 *
 * 而 `applyExchangeFigures()` 会把这个错数量覆盖进本地，**按数量计价的手续费**跟着算小
 * → 净额偏大 → 本地合计比交易所多 **0.0596**（就是 `ledger_check` 上那个 gap）。
 *
 * 本地数量来自**运行期持仓行**（当时真实下单的数量），它**不经过重建**。
 * 所以当两者差到"不可能是同一个回合"时，保留本地。
 *
 * 阈值 1.5 倍：正常的部分成交/合并都在这个量级内（0.20 vs 0.21 ✓）；
 * 而错位那种是**几十倍**（0.01 vs 0.21 = 21 倍）。
 */
export function shouldTrustReconciledQuantity(localQuantity: number, reconciled: number): boolean {
  if (!(localQuantity > 0) || !(reconciled > 0)) return false;
  const ratio = Math.max(localQuantity, reconciled) / Math.min(localQuantity, reconciled);
  return ratio <= 1.5;
}

export const trades = {
  /** 某一笔的成交量 —— 供"重建数量是否可信"的判断使用（见 `shouldTrustReconciledQuantity`）。 */
  quantityOf(id: number): number | undefined {
    const row = getDb().get<{ quantity: number }>('SELECT quantity FROM trades WHERE id = ?', id);
    return row?.quantity;
  },

  /**
   * 某一笔**已存**的费用（开仓侧/平仓侧）。
   *
   * ⚠️ 用途：**流水取不到时不要把它抹掉**。`commissionsInWindow()` 在窗口不对或流水为空时
   * 返回 0，而 0 **不代表"这笔没有手续费"** —— 直接写 0 会把一个正确的数字（可能是运行期
   * 记下的、甚至交易所退费的负数）覆盖掉。实测被测试抓到过一次
   * （见 `autoTrader.test.ts` 的「对账重复执行是幂等的」）。
   *
   * ⚠️ **`exit_fee` 不是数据库列**（`schema.ts` 的迁移只加了 `entry_fee`），
   * 所以这里**必须派生**，与 `trades.list()` 的读出层同一个口径：
   * `exit_fee = fee − entry_fee`。
   *
   * 原实现写的是 `SELECT entry_fee, exit_fee FROM trades` —— 那个查询**必然抛**
   * `no such column: exit_fee`。它此前没有调用者，所以是一颗没被踩到的哑弹；
   * 一旦有人调用就会直接拿到 500（`server.ts` 把非 4xx 一律按 500 处理）。
   * 顺带一提：`schema.ts` 里 `net_pnl = gross − entry_fee − exit_fee − funding_fee`
   * 那一行只是注释，不是 DDL，别被它误导。
   */
  feesOf(id: number): { entryFee: number; exitFee: number } {
    const row = getDb().get<{ entry_fee: number | null; fee: number | null }>(
      'SELECT entry_fee, fee FROM trades WHERE id = ?',
      id,
    );
    const entryFee = Number(row?.entry_fee) || 0;
    const fee = Number(row?.fee) || 0;
    /* 夹到 0 以上：手续费有**退费**的负数情形，此时派生的平仓侧不该变成负成本。 */
    return { entryFee, exitFee: Math.max(0, fee - entryFee) };
  },
  /**
   * 某机器人的成交记录，**最新在前**，一次一页。`before` 是游标：只返回 `id < before` 的行。
   *
   * ## 为什么用 `before=id` 而不是 `offset`
   *
   * 这个列表**在顶部持续插入**：每平一次仓就多一行。用 `OFFSET 25` 取"第二页"时，
   * 只要中间又平了一仓，窗口就整体下移一格 —— 第二页会重复第一页的最后一条
   * （同一笔成交在表格里出现两次，看起来像多平了一次仓，而这张表的数字是钱）。
   * 游标锚在具体一行的 `id` 上，新行的 `id` 一定更大、永远落在游标之上。
   *
   * ## 排序键必须就是游标键 —— 这里从 `closed_at DESC` 换成了 `id DESC`
   *
   * 页边界要成立，`ORDER BY` 与游标只能是同一列。`closed_at` 做不到：
   * 对账补录（`reconcileTradeHistory`）会把**进程未运行时**才平掉的回合现在写进来，
   * 这些行的 `closed_at` 比已经在库里的行更旧，于是"按 `closed_at` 排"与"按写入顺序排"
   * 是两种不同的顺序，用 `id` 当游标必然漏行或重复。
   *
   * `id` 倒序的实际含义是"最近记进来的在最上面"，运行期记账时它与 `closed_at` 完全同序
   * （平仓那一刻就写），只有对账补录的行会排到顶部 —— 那正好是该被看见的行
   * （表格里带 `对账补录` 徽章），也让"重复执行对账只修正、不重复插入"这件事一眼可查。
   * 代价是补录行不再按它的成交时间插回历史中间；页边界不重不漏优先于这一点。
   */
  /**
   * 历史成交列表。
   *
   * ## ⚠️ 排序必须按 `closed_at`，不能按 `id`
   *
   * 用户的原话：「**历史成交里面日期显示错乱（不是完全按时间排序）**」。
   *
   * 这是真 bug，而且根因很具体：`id` 是**插入顺序**，而**对账补录的行 id 更大、
   * 成交时刻却更早**。实测那台机器人的列表（按 id 倒序）：
   *
   *     #131  09-24 21:57:05
   *     #130  09-24 21:57:10   ← 更晚，却排在下一行
   *     #127  09-22 11:04:18   ← 跳回两天前
   *     #126  09-20 23:45:50   ← 又往前
   *     #113  09-23 11:09:03   ← 又跳回来
   *
   * 18 行里有 **4 处**乱序。按 `closed_at` 排则是 **0 处**。
   *
   * ## 为什么原来会选 id（以及那个权衡为什么是错的）
   *
   * 这段代码原来的注释写着：「代价是补录行不再按它的成交时间插回历史中间；
   * **页边界不重不漏优先于这一点**」。**分页正确性确实重要**，但那不是二选一：
   * 用 `(closed_at, id)` **复合游标**就能同时满足 —— 排序按时间，而游标带上
   * `closed_at` 之后，页边界仍然不重不漏。
   *
   * ## 游标
   *
   * `before` 仍是 id（老契约不破坏），但配合 `beforeClosedAt` 一起用：
   * **只给 id 时退回旧行为**（按 id 分页），两个都给时按时间排序 + 复合游标。
   * 控制台两个都传。
   */
  list(
    traderId: number,
    limit = TRADE_PAGE_DEFAULT,
    before?: number | null,
    beforeClosedAt?: string | null,
  ): TradeRecord[] {
    const pageSize = clampTradeLimit(limit);
    const cursor = cursorOf(before);

    if (cursor !== null && beforeClosedAt) {
      /*
       * 复合游标：`closed_at` 更早的排在后面；同一毫秒的用 id 破平。
       * 用标量子查询取 entry_margin_type（而非 LEFT JOIN orders），
       * 避免同 exchange_order_id 存在多条 orders 行时把 trades 结果放大重复。
       */
      return getDb()
        .all<TradeRow>(
          `SELECT t.*,
                  (SELECT o.margin_type
                     FROM orders o
                    WHERE o.trader_id = t.trader_id
                      AND o.exchange_order_id = t.entry_order_id
                      AND t.entry_order_id IS NOT NULL
                      AND t.entry_order_id <> ''
                    ORDER BY o.id DESC
                    LIMIT 1) AS entry_margin_type
             FROM trades t
            WHERE t.trader_id = ? AND (t.closed_at < ? OR (t.closed_at = ? AND t.id < ?))
            ORDER BY t.closed_at DESC, t.id DESC LIMIT ?`,
          traderId,
          beforeClosedAt,
          beforeClosedAt,
          cursor,
          pageSize,
        )
        .map(toTrade);
    }

    // 老契约：只给了 id 游标时按 id 分页（行为与以前完全一致）。
    if (cursor === null) {
      return getDb()
        .all<TradeRow>(
          `SELECT t.*,
                  (SELECT o.margin_type
                     FROM orders o
                    WHERE o.trader_id = t.trader_id
                      AND o.exchange_order_id = t.entry_order_id
                      AND t.entry_order_id IS NOT NULL
                      AND t.entry_order_id <> ''
                    ORDER BY o.id DESC
                    LIMIT 1) AS entry_margin_type
             FROM trades t
            WHERE t.trader_id = ? ORDER BY t.closed_at DESC, t.id DESC LIMIT ?`,
          traderId,
          pageSize,
        )
        .map(toTrade);
    }

    return getDb()
      .all<TradeRow>(
        `SELECT t.*,
                (SELECT o.margin_type
                   FROM orders o
                  WHERE o.trader_id = t.trader_id
                    AND o.exchange_order_id = t.entry_order_id
                    AND t.entry_order_id IS NOT NULL
                    AND t.entry_order_id <> ''
                  ORDER BY o.id DESC
                  LIMIT 1) AS entry_margin_type
           FROM trades t
          WHERE t.trader_id = ? AND t.id < ? ORDER BY t.id DESC LIMIT ?`,
        traderId,
        cursor,
        pageSize,
      )
      .map(toTrade);
  },

  recent(traderId: number, limit = 10): TradeRecord[] {
    return this.list(traderId, limit);
  },

  /**
   * **这台机器人累计的已实现净盈亏**（毛盈亏 − 手续费 − 资金费），全生命周期。
   *
   * 给模拟盘钱包用（见 `binance/paperWallet.ts`）：`walletBalance = 起始余额 + 它`。
   *
   * 与 `performanceSince` 的区别：那个要一个时间窗（用于"最近表现"），
   * 而钱包要的是**从建仓到今天**的总数 —— 少算一笔，余额就对不上。
   *
   * ⚠️ 用 `netPnlOf` 那个口径（表里的 `net_pnl` 列已经是按它算好的），
   * **不要在这里重写算式**：那会让"余额"和"界面上的净盈亏"变成两套算法。
   */
  lifetimeNetPnl(traderId: number): number {
    const row = getDb().get<{ netPnl: number | null }>(
      'SELECT COALESCE(SUM(net_pnl), 0) AS netPnl FROM trades WHERE trader_id = ?',
      traderId,
    );
    return row?.netPnl ?? 0;
  },

  /**
   * 一个时间窗口内的成交绩效，**全部在 SQL 里聚合**。
   *
   * ## 为什么必须有这个函数（提案 §4 的 O(1) 性质）
   *
   * 提示词要告诉模型"你最近在亏钱"，而 `trades` 是**随时间无限增长**的表。
   * 这个函数对外只回**固定几个字段**：无论窗口里有 3 笔还是 30000 笔，进提示词的
   * 字节数完全一样。没有这条保证，"7×24 跑一年"就只是一个说法 —— 跑一年之后
   * 提示词会随历史长度线性膨胀，直到撑爆上下文。
   *
   * 分类口径与 `aggregateTrades()` 严格一致：按**净**盈亏判胜负。一笔毛赚了
   * 一点点、但不够付手续费的钱实际是亏的，算成盈利会同时抬高胜率与盈亏比 ——
   * 那是这个产品最容易骗自己的地方。
   *
   * @param sinceIso 窗口起点（含）。调用方给固定长度的窗口（例如最近 24 小时），
   *   所以窗口内的行数由**交易频率**决定，而不是由历史长度决定。
   */
  performanceSince(traderId: number, sinceIso: string): TradePerformance {
    /*
     * ⚠️ **走 `aggregateTradeTotals()`，不要再抄一份聚合 SQL。**
     *
     * 原来这里复制了 `aggregateTrades()` 的 9 个 `SUM` / `COUNT`，两份的判胜
     * 口径（按**净**盈亏）一旦漂移，控制台与提示词就会给出两个胜率。
     * 两个入口都从同一段 SQL 取数，"最近表现"与"终身表现"才不可能分叉。
     */
    const row = aggregateTradeTotals(traderId, sinceIso);

    const wins = row?.wins ?? 0;
    const losses = row?.losses ?? 0;
    const grossProfit = row?.grossProfit ?? 0;
    const grossLoss = row?.grossLoss ?? 0;
    const totalFees = row?.totalFees ?? 0;
    const notional = row?.notional ?? 0;

    return {
      totalTrades: row?.totalTrades ?? 0,
      wins,
      losses,
      grossProfit,
      grossLoss,
      avgWin: wins > 0 ? grossProfit / wins : 0,
      avgLoss: losses > 0 ? grossLoss / losses : 0,
      grossPnl: row?.grossPnl ?? 0,
      totalFees,
      totalFunding: row?.totalFunding ?? 0,
      netPnl: row?.netPnl ?? 0,
      notional,
      /*
       * 往返手续费率 = Σ手续费 / Σ名义价值。
       *
       * 为什么是"两个总和相除"而不是"逐笔成本率的平均"：一次往返在开、平两条腿上
       * 各付一次佣金，而两条腿的名义价值都约等于入场名义价值，所以这个比值就是
       * "每往返一次，成本占名义价值的百分之几"——实测 0.1000%。逐笔平均会让
       * 小额回合与小额手续费得到同等权重，一个 12 USDT 的回合和一个 1200 USDT 的
       * 回合会各算一票，得到的费率与本账户的真实成本无关。
       *
       * 读不到成交（窗口内没有行）时回 null —— 让调用方自己决定用什么兜底，
       * 而不是在这里编一个数出来（§5「不要假装算过」）。
       */
      roundTripFeeRate: notional > 0 ? totalFees / notional : null,
    };
  },

  /**
   * **读取"由某条情报驱动"的已平仓成交**（`trades.intel_keys` 的读取侧）。
   *
   * ## 为什么需要它（2026-11-09）
   *
   * `intel_keys` 从 M16/M18 起就一直在**写**（开仓写 `positions`、平仓搬到
   * `trades`），但整个仓库**没有一处读它** —— 于是
   * `trader/intel/signalHealth.ts` 的 `assessSignal()` 拿不到输入，失效检测
   * 永远只会返回 `insufficient_data`：代码在跑、测试通过、日志正常，
   * 而它从未下过一次结论。
   *
   * ## 口径
   *
   * · `returnPct` = `pnl_percent / 100`（**净**收益率，小数比例）—— 与
   *   `SignalTrade.returnPct` 一致；用净额而不是毛额，让"手续费吃掉的盈利"
   *   如实算作没赚到。
   * · 只取 `intel_keys <> '[]'` 的行：空数组的语义是"纯技术面成交"，
   *   它不属于任何信号，算进任何键都会污染样本。
   *
   * ## 为什么带窗口与条数上限
   *
   * 这张表随时间无限增长，而调用方（`AutoTrader.observeSignalHealth()`）会按
   * 固定间隔重算。窗口 + `LIMIT` 让查询保持 O(固定行数) —— 与
   * `performanceSince()` 同一个理由：周期耗时不随历史长度增长。
   *
   * @param sinceIso 窗口起点（含）。
   * @param limit 最多取**最新**多少笔（返回时已按时间升序）。
   */
  intelAttributionsSince(
    traderId: number,
    sinceIso: string,
    limit = TRADE_INTEL_ATTRIBUTION_MAX,
  ): TradeIntelAttributionRow[] {
    const rows = getDb().all<{
      intel_keys: string;
      pnl_percent: number;
      closed_at: string;
    }>(
      `SELECT intel_keys, pnl_percent, closed_at
         FROM trades
        WHERE trader_id = ? AND closed_at >= ? AND intel_keys <> '[]'
        ORDER BY closed_at DESC, id DESC
        LIMIT ?`,
      traderId,
      sinceIso,
      Math.max(1, Math.trunc(limit)),
    );

    /*
     * 反转成**时间升序**：`signalHealth` 的"连续亏损"是从最后一笔往前数、
     * 滚动窗口是 `slice(-WINDOW)` —— 两者都假定输入旧 → 新。
     * 这里取的是"最新 limit 条"，反转后恰好给出该窗口内的时间顺序。
     */
    return rows
      .slice()
      .reverse()
      .map((row) => ({
        intelKeys: parseIntelKeysColumn(row.intel_keys),
        returnPct: (Number(row.pnl_percent) || 0) / 100,
        closedAt: row.closed_at,
      }));
  },

  /**
   * 最近若干笔平仓，附带**模型当时的入场理由**（提案 §2.2 的第二行）。
   *
   * 理由取自 `positions.open_reasoning` —— 模型下单时写进持仓行的原话。连接键是
   * `(trader_id, symbol, opened_at)`：运行期记账时 `trades.opened_at` 就是
   * `positions.opened_at` 那一行（`bookClosedPosition()` 直接把它抄过来），
   * 所以这是一次**身份匹配**，不是"看起来差不多"的猜测。
   *
   * 对账补录的行 `opened_at` 来自交易所成交时间，本来就匹配不到持仓行 ——
   * 那就回 null，让提示词如实写"未记录"，而不是猜一个理由出来。
   *
   * ⚠️ 这是提示词里唯一会出现的**逐笔**内容，所以调用方必须传固定的小数字
   * （`PROMPT_RECENT_CLOSE_COUNT`），否则 §4 的 O(1) 性质就没了。
   */
  recentWithReason(
    traderId: number,
    limit: number,
  ): Array<TradeRecord & { entryReason: string | null }> {
    return getDb()
      .all<TradeRow & { entry_reason: string | null }>(
        `SELECT t.*, (
           SELECT p.open_reasoning FROM positions p
            WHERE p.trader_id = t.trader_id
              AND p.symbol = t.symbol
              AND p.opened_at = t.opened_at
            LIMIT 1
         ) AS entry_reason
         FROM trades t WHERE t.trader_id = ? ORDER BY t.id DESC LIMIT ?`,
        traderId,
        Math.max(1, Math.trunc(limit)),
      )
      .map((row) => ({ ...toTrade(row), entryReason: row.entry_reason }));
  },

  /**
   * Record a closed round-trip.
   *
   * `grossPnl` is the exchange's own realised figure and the costs are passed
   * separately, so `net_pnl` — the number the console shows — is derived in one
   * place instead of each caller doing its own arithmetic and disagreeing.
   * `pnlPercent` is deliberately computed here rather than accepted, for the
   * same reason.
   *
   * ## 为什么幂等检查放在这一层（§2.5、§5.4「金额相关的算术只在一个地方算」）
   *
   * 平仓有两条记账路径：运行期（`executeClose` / `bookClosedPosition`，从本地持仓行）
   * 与对账（`reconcileTradeHistory`，从交易所成交历史重建）。它们对同一回合算出的
   * **数量口径可以不同**（本地持仓量 vs 交易所实际成交量），于是对账的严格键与描述
   * 回退键会同时落空，把同一回合插成两行 —— 详见 `findDuplicate()` 的说明。
   *
   * 身份判断只有一处实现（`findDuplicate()`），所以不可能出现"一条路径记得、
   * 另一条忘了"的分裂；调用方只要声明 `idempotent: true` 就拿到这个保证。
   *
   * 返回值带 `created`，让调用方能区分"我补录了一笔"和"这一笔本来就记过了"：
   * 对账靠它把 `recovered` 数准 —— 把重复回合也算成"补录"会让操作员以为账本有漏记，
   * 而实际上什么都没发生。
   */
  insert(input: {
    traderId: number;
    symbol: string;
    side: 'long' | 'short';
    quantity: number;
    entryPrice: number;
    exitPrice: number;
    leverage: number;
    /** Gross, before costs. */
    grossPnl: number;
    entryFee?: number;
    exitFee?: number;
    fundingFee?: number;
    closeReason: CloseReason;
    openedAt: string;
    /** Exchange fill time. Defaults to now; reconciliation supplies the real one. */
    closedAt?: string;
    source?: 'bot' | 'reconciled';
    entryOrderId?: string | null;
    exitOrderId?: string | null;
    /**
     * 这一回合的**全部**出场成交单号（对账重建的腿会带多个）。
     * 只参与查重，不落库 —— 落库的是最后一个（`exit_order_id`）。
     * 见 `findDuplicate()` 里那段"两条路切法不同"的说明。
     */
    exitOrderIds?: readonly string[];
    /**
     * 这次写入代表**一笔真实平仓**，因此必须先查重（§2.5 的幂等）。
     *
     * 只有 `bookClosedPosition()` 与 `reconcileTradeHistory()` 会打开它。默认关闭，
     * 是因为判据以"平仓时刻"为身份，而测试 fixture 会连记多笔只差盈亏的假成交；
     * 见 `insert()` 内部的说明。
     */
    idempotent?: boolean;
    /**
     * **这笔成交的情报归因**（`<域名>|<方向>|<标的>`）。
     *
     * 见 `db/schema.ts` 的 M16 与 M17：
     * ```
     *   开仓 → 存在 positions.intel_keys（此时决策在手边）
     *   平仓 → 搬到 trades.intel_keys（signalHealth 的数据来源）
     * ```
     *
     * ⚠️ 不传 = `[]` = **纯技术面成交**（与改动前行为一致）。
     * 对账路径（`reconcileTradeHistory`）从交易所历史重建时**拿不到**它 ——
     * 那时为空是正确的（不是"丢了"，而是**那条路径本来就没有决策上下文**）。
     */
    intelKeys?: readonly string[];
  }): { id: number; created: boolean } {
    const closedAt = input.closedAt ?? now();

    /*
     * 幂等只在**真的在记一笔平仓**时生效：`bookClosedPosition()`（运行期）与
     * `reconcileTradeHistory()`（对账）都会显式打开 `idempotent`。
     *
     * 为什么做成显式开关而不是对每一次 `insert()` 都生效：判据依赖**平仓时刻**这个
     * 真实事件的身份，而测试与脚本会连记多笔"看起来一样"的 fixture（同一标的、
     * 同一数量与价位，只差盈亏）。那种行本来就不代表一个交易时刻，拿时间去做唯一性
     * 判定会把它们错误地合成一笔 —— 从而让 `totalTrades`、胜率、盈亏合计全部失真。
     * 两条真实记账路径打开它，才是这个不变量真正需要覆盖的范围。
     */
    const alreadyBooked = input.idempotent
      ? this.findDuplicate({
          traderId: input.traderId,
          symbol: input.symbol,
          quantity: input.quantity,
          entryPrice: input.entryPrice,
          /*
           * ⚠️ **出场价必须传。** 它是这两条记账路径之间**唯一真正同源的字段** ——
           * 两者都由交易所给出，而 `closed_at` 不同源（一条是本地察觉到仓位消失的
           * 时刻，一条是交易所成交记录里的时刻，实测差过 11 分钟）、`entry_price`
           * 也不同源（补录那条用的是快照价而不是成交均价）。见 `findDuplicate()`。
           */
          exitPrice: input.exitPrice,
          openedAt: input.openedAt,
          closedAt,
          entryOrderId: input.entryOrderId,
          /* 确定性键 —— 同一笔平仓只有一个交易所单号，见 `findDuplicate()`。 */
          exitOrderId: input.exitOrderId,
          /*
           * 一个腿可以有**多个**出场单号（部分平仓）。只看最后一个会漏掉
           * "运行期已按每次平仓分别记账"的情形 —— 那正是 2026-10-03 那笔
           * 凭空多出 1.5153 的成因。见 `findDuplicate()`。
           */
          exitOrderIds: input.exitOrderIds,
        })
      : null;
    if (alreadyBooked !== null) return { id: alreadyBooked, created: false };

    const holdMinutes = Math.max(
      0,
      (new Date(closedAt).getTime() - new Date(input.openedAt).getTime()) / 60_000,
    );
    const entryFee = input.entryFee ?? 0;
    const exitFee = input.exitFee ?? 0;
    const fee = entryFee + exitFee;
    const fundingFee = input.fundingFee ?? 0;
    /*
     * ⚠️ **用 `netPnlOf`，不要在这里重写算式** —— 见它的注释：
     * "净 = 毛 − 手续费 − 资金费"那个直觉写法把资金费的符号搞反了，
     * 而它在仓库里曾经有**五份副本**（同一个错误复制了五遍）。
     */
    const netPnl = netPnlOf({ grossPnl: input.grossPnl, fee, fundingFee });
    const margin = marginOf(input.entryPrice, input.quantity, input.leverage);
    const pnlPercent = margin > 0 ? (netPnl / margin) * 100 : 0;

    const { lastInsertRowid } = getDb().run(
      `INSERT INTO trades (
         trader_id, symbol, side, quantity, entry_price, exit_price, leverage,
         pnl, pnl_percent, fee, close_reason, opened_at, closed_at, hold_minutes,
         entry_fee, funding_fee, net_pnl, source, entry_order_id, exit_order_id, intel_keys
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.symbol,
      input.side,
      input.quantity,
      input.entryPrice,
      input.exitPrice,
      input.leverage,
      input.grossPnl,
      pnlPercent,
      fee,
      input.closeReason,
      input.openedAt,
      closedAt,
      holdMinutes,
      entryFee,
      fundingFee,
      netPnl,
      input.source ?? 'bot',
      input.entryOrderId ?? null,
      input.exitOrderId ?? null,
      /*
       * **这笔成交的情报归因**（见 `db/schema.ts` 的 M16）。
       *
       * ⚠️ 不传 = `[]` = **纯技术面成交** —— 与改动前行为一致，
       * 也让 225 笔历史成交的语义保持一致（它们确实没有情报归因）。
       */
      JSON.stringify(input.intelKeys ?? []),
    );
    return { id: lastInsertRowid, created: true };
  },

  /**
   * 找出这条"回合"是不是已经记过账了，返回已有行的 id。
   *
   * ## 为什么需要它（这是 §2.5「对账幂等」缺的那一环）
   *
   * 同一个真实回合有两条记账路径：运行期从**本地持仓行**记（`bookClosedPosition`），
   * 对账从**交易所成交历史**重建后再记（`reconcileTradeHistory`）。两条路各自算出的
   * 描述可以不一致 —— 最典型的是数量：本地记的是下单时的请求量 / 持仓行的数量，
   * 交易所重建的是实际成交量（摊到多笔成交上做加权）。一旦不一致，
   * `reconcileTradeHistory` 的严格键（symbol+qty+入场价+入口订单号）和描述回退键
   * **同时**落空，于是它把同一回合又插了一行。实盘上量到的症状：
   *
   *   #17 reconciled / #18 take_profit   SYNUSDT  99  -0.047554650
   *   #11 reconciled / #12 stop_loss     SYNUSDT 169  -0.75613135
   *   #9  reconciled / #10 take_profit   LSKUSDT  35  +0.66674843
   *
   * 12 行里 4 行是 reconciled，其中只有 #4 POWERUSDT 是真的漏记。重复的那 6 行
   * 凭空造出 **+0.4954** 的净盈亏（毛 − 手续费 − 资金费全部被算了两遍），
   * 而对账本来只该"修正、不重复插入"。
   *
   * ## 为什么用这个身份，而不是浮点相等
   *
   * 唯一能同时被两条路拿到的身份是**交易所那一笔的成交时间**（`closed_at`）：
   * 运行期有成交记录时用 `findRoundTrip()` 给出的交易所时间，对账用重建出的
   * `trip.closedAt`，两者来自同一笔平仓成交，实测精确到毫秒相同（上面三组重复行
   * 的 `closed_at` 逐字节一致）。所以判定条件是：
   *
   *   · `closed_at` 的**毫秒精度字符串相同**（`strftime('%Y-%m-%dT%H:%M:%f')`，
   *     纯字符串比较，不是浮点比较），或
   *   · `entry_order_id` 相同（两条路都拿到了交易所的入口订单号，这是铁证）
   *
   * 再加上 symbol + quantity（相对 20%）+ entry_price + exit_price 收窄。容差取相对值
   * 是因为同一回合的两条路径本来就按不同口径取值（本地持仓量 vs 交易所成交量），
   * 要求浮点相等正是这个 bug 钻过去的缝。
   *
   * **出场价为什么必须参与**：`closed_at` 精确相同时，唯一还能区分"同一回合被记两次"
   * 和"同一毫秒内平掉的两笔真实成交"的就是成交价。`retention.test.ts` / `stats.test.ts`
   * 的 fixture 正是后者——同一个标的、同一个入场价、连记四笔不同盈亏的回合；
   * 少了出场价这一项，它们会被判成一笔，`totalTrades` 从 4 变 1、盈亏合计跟着错。
   * 而同一回合被记两次时，交易所的成交价是同一个数（实盘那三组的入场价、出场价都
   * 逐字节相同），所以这一项不会漏判。
   *
   * 找到就返回已有行，调用方**不插新行**：重复执行只修正、不重复插入。
   */
  findDuplicate(input: {
    traderId: number;
    symbol: string;
    quantity: number;
    entryPrice: number;
    exitPrice: number;
    /** 开仓时刻 —— **主判据**，见 `DUPLICATE_OPEN_TOLERANCE_MS`。 */
    openedAt: string;
    closedAt?: string;
    entryOrderId?: string | null;
    /**
     * **平仓单的交易所单号 —— 这一组判据里唯一确定性的那个。**
     *
     * 一笔平仓在交易所只有一个 `orderId`，而 `trades` 里 25 行**全都有**它
     * （`entry_order_id` 同样 100% 填充）。所以"两个回合的 `exit_order_id` 相同"
     * 不是概率判断，是**同一个回合**的定义。
     *
     * 它接进来之前，去重全靠启发式（数量容差 + 价格容差 + 时间窗），而那些窗口
     * 一定有边界 —— 实测漏网的一对（ZECUSDT `#107` / `#120`）共用一个
     * `exit_order_id`，却因为平仓时刻差 6 秒（超出 2 秒窗口）被判成两个回合，
     * 账上多出一笔。
     */
    exitOrderId?: string | null;
    /**
     * **这个回合的全部出场成交单号**（对账重建的腿会带多个：部分平仓各一笔）。
     *
     * ## 为什么单个 `exitOrderId` 不够（2026-10-03 实盘事故）
     *
     * 运行期与对账对同一段成交的"切法"不同：
     *
     *   · 运行期按**每次平仓**记一笔（本地持仓行消失一次记一次）；
     *   · `reconstructRoundTrips` 按**开仓到清仓**合成一个腿。
     *
     * 实测 `#10` 的 MANAUSDT：交易所是 `BUY 336 → SELL 168 → SELL 168`，
     * 运行期记了 `#191`（168）+ `#192`（168），对账又记了 `#193`（336，
     * `pnl` 恰好等于前两笔之和）—— **凭空多出 1.5153 USDT**。
     *
     * 而三条启发式判据全部落空：数量 `336 ≠ 168`、出场价不同（加权 vs 单笔）、
     * `closed_at` 差 5 秒（超窗口）；`#192` 的 `exit_order_id` 还是 null
     * （止损触发时没拿到），所以连"单号相同"那条确定性判据也查不到。
     *
     * **成交单号是唯一不受"切法"影响的身份**：336 的回合含两个出场单号，
     * 其中**任何一个**已出现在账本里，就说明这段成交已经被记过。
     * 这也正是对账该有的语义 —— **只修正、不重复插入**。
     */
    exitOrderIds?: readonly string[];
  }): number | null {
    /*
     * 只有带交易所身份的（ISO 毫秒时间戳）才参与判定。`closed_at` 缺省时
     * `insert()` 会填当前时间，那种行没有可与交易所对齐的身份，宁可不判定，
     * 也不能拿"看起来差不多"当依据去吞掉一笔真实成交。
     */
    if (!input.closedAt || !/^\d{4}-\d{2}-\d{2}T/.test(input.closedAt)) return null;

    /*
     * ── 确定性判据放在最前面：**平仓单号相同就是同一个回合** ──────────────
     *
     * 它不看数量、不看价格、不看时间窗 —— 因为交易所的单号本身就是身份。
     * 这一步存在与否，决定了"重复记账"是一个**有边界的启发式问题**，
     * 还是一个**可以彻底关掉的问题**：
     *
     *   · 运行期记账有 `authoritative.exitOrderId`（来自成交明细）；
     *   · 对账重建有 `trip.exitOrderId`（来自同一份成交明细）；
     *   两者是**同一笔平仓**，单号逐字相同。
     *
     * ⚠️ 仍然要求 `closedAt` 存在（上面那道门）—— 老记录、手工插入的行没有单号时，
     * 走下面的启发式，行为与以前完全一致。
     */
    if (input.exitOrderId && input.exitOrderId.length > 0) {
      const exact = getDb().get<{ id: number }>(
        'SELECT id FROM trades WHERE trader_id = ? AND symbol = ? AND exit_order_id = ? ORDER BY id ASC LIMIT 1',
        input.traderId,
        input.symbol,
        input.exitOrderId,
      );
      if (exact) return exact.id;
    }

    /*
     * ── 同一个"腿"的**任一**出场成交已记账 ⇒ 这段成交已经记过 ──────────────
     *
     * 这一条补的是"两条路切法不同"那个缝：一个 336 张的腿含两个出场单号
     * （168 + 168），而运行期已经按每次平仓各记了一笔。只看**最后一个**
     * 单号（`exitOrderId`）查不到那两笔 —— 因为记在账上的单号是**第一笔**的。
     *
     * 单号是交易所给的唯一身份，所以这里不做任何容差判断：命中就是命中。
     * 顺序无关、数量无关、价格无关 —— 这正是这个 bug 需要的东西。
     */
    if (input.exitOrderIds && input.exitOrderIds.length > 0) {
      const ids = input.exitOrderIds.filter((id) => typeof id === 'string' && id.length > 0);
      if (ids.length > 0) {
        const hit = getDb().get<{ id: number }>(
          `SELECT id FROM trades WHERE trader_id = ? AND symbol = ? AND exit_order_id IN (${ids
            .map(() => '?')
            .join(', ')}) ORDER BY id ASC LIMIT 1`,
          input.traderId,
          input.symbol,
          ...ids,
        );
        if (hit) return hit.id;
      }
    }

    const byOrder =
      input.entryOrderId && input.entryOrderId.length > 0
        ? 'OR entry_order_id = ?'
        : '';
    /*
     * ## ⚠️ 为什么还要一条按**出场价**的判据
     *
     * 下面那三条判据（入场价 1e-6、平仓时间 2 秒、入场订单号）是为一类场景写的：
     * **同一秒里两条路径几乎同时记账**。而实盘真正发生的重复是另一类 ——
     * 运行期记了一次，**几十分钟之后**对账又从成交历史补了一次：
     *
     *     #90 ETHUSDT  入场 2634.3164186  出场 2655.66  净 +0.1821  source=bot    closed_at 02:02:20
     *     #92 ETHUSDT  入场 2634.2        出场 2655.66  净 +0.1713  source=reconciled  closed_at 01:51:35
     *
     * 三个判据在这笔上**全部落空**：入场价差 0.116（容差 0.0026）、时间差 11 分钟
     * （窗口 2 秒）、补录那条又没有订单号。于是同一笔被算了两次，账面多出 0.17 ——
     * 而**钱包余额不会跟着多**，操作员看到的就是"界面说赚了 0.20、钱包只多了 0.03"。
     *
     * ### 为什么不能靠放宽上面那两条
     *
     * 平仓时间那一条**不能继续放宽**：同一标的两笔真实回合之间只隔着再入场冷却
     * （配置里是分钟级），而这两笔正好差 11 分钟 —— 窗口一放到十几分钟，
     * 就可能把两笔**真实**的回合并成一笔，那是比重复更严重的错（会凭空吃掉一笔交易）。
     *
     * ### 为什么出场价可以当身份
     *
     * 它是两条路径之间**唯一同源的字段**：都由交易所给出（成交均价 / 成交记录），
     * 而 `closed_at` 一条来自本地时钟、`entry_price` 补录时用的是快照价。
     * 实测这一对上完全相同（2655.66 = 2655.66）。
     *
     * 容差用相对值且取得很小（0.05%）：真实同一回合的出场价来自同一个成交，
     * 只可能有浮点末位差异。**单向持仓模式下，同一标的在同一价位平掉两笔真实回合，
     * 中间还要隔着再入场冷却** —— 所以"同标的 + 同数量 + 同出场价"落在冷却窗口里，
     * 就是同一个回合。数量容差沿用 20%（两条路径的数量口径本来就不同）。
     *
     * ## ⚠️ 但数量不能一票否决 —— 它才是最不可靠的那个维度
     *
     * 实测事故（用户的原话：「归属权益和收益，为什么和钱包实际余额对不上？」）：
     *
     *     平台记账净额 2.69503831
     *     交易所流水   1.18510038      ← 逐位一致于钱包变化
     *     ────────────────────────
     *     平台多算了   1.50993793
     *
     * 六组重复，全都是同一个形状 —— **同一个平仓时刻、同一个入场价、同一个出场价**，
     * 只是数量不同：
     *
     *     XRP 09-21 22:03  1.5038 → 1.5583   13.6 / 9.2 / 6.8    （虚增 +1.4579）
     *     XRP 09-22 19:37  1.56   → 1.5817   12.7 / 8.3 / 5.9    （虚增 +0.3576）
     *     XRP 09-22 08:34  1.513  → 1.5189   13   / 8.6 / 6.2    （虚增 +0.1337）
     *
     * 数量差 32%、50% —— **20% 的容差全部超出**，而它原来写在 WHERE 的**最外层**，
     * 于是一票否决了下面对的那些判据：同一个真实回合被判成三个不同的回合，
     * 运行期记一笔、对账重建又各插一笔，全留在账上。
     *
     * ### 修法：把数量收进各自的分支，并补一条**以平仓时刻 + 双侧价格为准**的判据
     *
     * 六组重复里 `closed_at` 是**毫秒级相同**的，入场价与出场价也完全相同 ——
     * 那三项才是真正同源的：同一个平仓时刻、同一个入场均价、同一个出场均价，
     * 在物理上就是**同一个回合**（单向持仓下不可能在毫秒级同时平掉两笔同价仓）。
     *
     * 所以：
     *
     *   ① 原有两条判据**各自**带上数量容差（行为与以前一致，只是不再跨分支否决）；
     *   ② 新增一条：**平仓时刻落在 2 秒窗口内 + 入场价相同 + 出场价相同** ——
     *      **不看数量**。
     *
     * 放宽的是"数量口径"这一个**本来就不同源**的维度，而判据的另一半
     * （毫秒级的平仓时刻 + 两个价格）比原来更严 —— 它要求三样东西同时对得上。
     */
    const sql = `SELECT id FROM trades
       WHERE trader_id = ? AND symbol = ? AND quantity > 0
         AND close_reason <> 'manual_partial'
         AND (
              (
                ABS(quantity - ?) <= MAX(1e-6, ABS(?) * ${DUPLICATE_QUANTITY_TOLERANCE})
            AND ABS(exit_price - ?) <= MAX(1e-9, ABS(?) * ${DUPLICATE_EXIT_PRICE_TOLERANCE})
            AND ABS(julianday(opened_at) - julianday(?)) * 86400000 <= ${DUPLICATE_OPEN_TOLERANCE_MS}
              )
           OR (
                ABS(quantity - ?) <= MAX(1e-6, ABS(?) * ${DUPLICATE_QUANTITY_TOLERANCE})
            AND ABS(entry_price - ?) <= MAX(1e-9, ABS(?) * ${DUPLICATE_PRICE_TOLERANCE})
            AND ABS(julianday(closed_at) - julianday(?)) * 86400000 <= ${DUPLICATE_CLOSE_TOLERANCE_MS}
              )
           OR (
                ABS(entry_price - ?) <= MAX(1e-9, ABS(?) * ${DUPLICATE_PRICE_TOLERANCE})
            AND ABS(exit_price - ?) <= MAX(1e-9, ABS(?) * ${DUPLICATE_EXIT_PRICE_TOLERANCE})
            AND ABS(julianday(opened_at) - julianday(?)) * 86400000 <= ${DUPLICATE_OPEN_TOLERANCE_MS}
              )
              ${byOrder}
         )
       ORDER BY id ASC
       LIMIT 1`;
    const params: unknown[] = [
      input.traderId,
      input.symbol,
      /* ① 出场价 + 开仓时刻（带数量） */
      input.quantity,
      input.quantity,
      input.exitPrice,
      input.exitPrice,
      input.openedAt,
      /* ② 入场价 + 平仓时刻（带数量） */
      input.quantity,
      input.quantity,
      input.entryPrice,
      input.entryPrice,
      input.closedAt,
      /*
       * ③ 双价 + **开仓时刻**（不带数量）—— 全表最强的一条。
       *
       * ⚠️ **这里原本挂的是 `closed_at`（2 秒窗口），那是个错误的选择。**
       *
       * 实盘漏网的那一对（用户报「我从未停止过机器人运行，为什么会提示机器人
       * 未运行时平仓」）：
       *
       *     #130 bot         HYPEUSDT 0.21  94.05 → 92.878  closed_at 21:57:10.512
       *     #131 reconciled  HYPEUSDT 0.14  94.05 → 92.878  closed_at 21:57:05.073
       *
       * **两个价格逐字节相同**、`opened_at` 只差 5.3 秒，但 `closed_at` 差了 **5.44 秒** ——
       * 刚好越过 2 秒的窗口，于是同一回合被记了两行，账上多出 -0.2638。
       *
       * 而这两条路径的 `closed_at` **本来就不同源**（本项目自己的注释在上一个常量
       * 那里写着：「一条是本地"察觉到仓位消失"的时刻（可能晚一整轮），另一条是
       * 交易所成交记录里的时刻 —— **两个不同的时钟**」）。拿一个已知会漂到十几分钟的
       * 字段去做 2 秒的判断，判据在它最该生效的场景里必然落空。
       *
       * `opened_at` 才是两条路径**同源**的那个（都锚在"这笔仓位什么时候开的",
       * 中间只隔下单延迟），它的 5 分钟容差也正是按这个理由定的。
       *
       * 所以：**判据的强度不变**（仍要求双侧价格都对上），只是把它挂到正确的字段上。
       */
      input.entryPrice,
      input.entryPrice,
      input.exitPrice,
      input.exitPrice,
      input.openedAt,
    ];
    if (byOrder) params.push(String(input.entryOrderId));

    const row = getDb().get<{ id: number }>(sql, ...params);
    return row?.id ?? null;
  },

  /**
   * 查出账本上属于同一个交易所整腿 `trip` 的所有拆分记录（用于 `manual_partial` 腿的对账核算）。
   *
   * 匹配规则（并集）：
   *   1) `entry_order_id = trip.entryOrderId`；
   *   2) `exit_order_id IN (trip.exitOrderIds)`；
   *   3) 开仓时刻落在同源窗口（5 分钟）内，且 `entry_order_id` / `exit_order_id` 未归属他单
   *      （覆盖运行期止损尾仓 `entry_order_id` 与 `exit_order_id` 均为 null 的场景）。
   */
  legSplitRows(input: {
    traderId: number;
    symbol: string;
    entryOrderId?: string | null;
    exitOrderIds?: readonly string[];
    openedAt?: string | null;
    closedAt?: string | null;
  }): Array<{
    id: number;
    closeReason: string;
    quantity: number;
    grossPnl: number;
    entryFee: number;
    exitFee: number;
    fundingFee: number;
    entryOrderId: string | null;
    exitOrderId: string | null;
  }> {
    const clauses: string[] = [];
    const params: unknown[] = [input.traderId, input.symbol];

    const entryId = input.entryOrderId && input.entryOrderId.length > 0 ? input.entryOrderId : null;
    const exitIds = (input.exitOrderIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);

    const idGuardParts: string[] = [];
    const idGuardParams: unknown[] = [];
    if (entryId) {
      idGuardParts.push("(entry_order_id IS NULL OR entry_order_id = '' OR entry_order_id = ?)");
      idGuardParams.push(entryId);
    } else {
      idGuardParts.push("(entry_order_id IS NULL OR entry_order_id = '')");
    }
    if (exitIds.length > 0) {
      idGuardParts.push(
        `(exit_order_id IS NULL OR exit_order_id = '' OR exit_order_id IN (${exitIds.map(() => '?').join(', ')}))`,
      );
      idGuardParams.push(...exitIds);
    } else {
      idGuardParts.push("(exit_order_id IS NULL OR exit_order_id = '')");
    }

    if (entryId) {
      clauses.push('entry_order_id = ?');
      params.push(entryId);
    }
    if (exitIds.length > 0) {
      clauses.push(`exit_order_id IN (${exitIds.map(() => '?').join(', ')})`);
      params.push(...exitIds);
    }
    if (input.openedAt) {
      clauses.push(
        `(ABS(julianday(opened_at) - julianday(?)) * 86400000 <= ${DUPLICATE_OPEN_TOLERANCE_MS} AND ${idGuardParts.join(' AND ')})`,
      );
      params.push(input.openedAt, ...idGuardParams);
    }
    if (input.closedAt) {
      /*
       * 2026-11-24 Gate 实测修复：限价入场单由 `settlePendingEntries` 晚于成交十几分钟才转正，
       * 导致本地仓位与平仓行的 `opened_at` 偏离交易所重建值超出容差；若尾仓行又缺 `exit_order_id`，
       * 只按 `opened_at` 会漏掉已记的 `drawdown_guard` 尾仓并重复补录。补充按 `closed_at` 容差匹配。
       */
      clauses.push(
        `(ABS(julianday(closed_at) - julianday(?)) * 86400000 <= ${DUPLICATE_OPEN_TOLERANCE_MS} AND ${idGuardParts.join(' AND ')})`,
      );
      params.push(input.closedAt, ...idGuardParams);
    }
    if (clauses.length === 0) return [];

    type RawSplitRow = {
      id: number;
      close_reason: string;
      quantity: number;
      pnl: number;
      entry_fee: number;
      fee: number;
      funding_fee: number;
      entry_order_id: string | null;
      exit_order_id: string | null;
      opened_at: string;
    };

    const initialRows = getDb().all<RawSplitRow>(
      `SELECT id, close_reason, quantity, pnl, entry_fee, fee, funding_fee, entry_order_id, exit_order_id, opened_at
         FROM trades
        WHERE trader_id = ? AND symbol = ?
          AND (${clauses.join(' OR ')})
        ORDER BY id ASC`,
      ...params,
    );

    /*
     * 若命中了部分减仓行（`manual_partial`），同仓位拆出的尾仓平仓行必然与其共享完全相同的 `opened_at`。
     * 一并捞出同 `opened_at` 的兄弟行（受 idGuard 约束不误伤其它独立回合），彻底杜绝减仓尾仓重复补录。
     */
    const partialOpenedAts = [
      ...new Set(initialRows.filter((r) => r.close_reason === 'manual_partial' && r.opened_at).map((r) => r.opened_at)),
    ];
    const byId = new Map<number, RawSplitRow>(initialRows.map((r) => [r.id, r]));
    if (partialOpenedAts.length > 0) {
      const openPlaceholders = partialOpenedAts.map(() => '?').join(', ');
      const siblings = getDb().all<RawSplitRow>(
        `SELECT id, close_reason, quantity, pnl, entry_fee, fee, funding_fee, entry_order_id, exit_order_id, opened_at
           FROM trades
          WHERE trader_id = ? AND symbol = ?
            AND opened_at IN (${openPlaceholders})
            AND ${idGuardParts.join(' AND ')}
          ORDER BY id ASC`,
        input.traderId,
        input.symbol,
        ...partialOpenedAts,
        ...idGuardParams,
      );
      for (const s of siblings) byId.set(s.id, s);
    }

    return [...byId.values()]
      .sort((a, b) => a.id - b.id)
      .map((r) => ({
        id: r.id,
        closeReason: r.close_reason,
        quantity: Number(r.quantity) || 0,
        grossPnl: Number(r.pnl) || 0,
        entryFee: Number(r.entry_fee) || 0,
        exitFee: Number((r.fee - r.entry_fee).toFixed(12)) || 0,
        fundingFee: Number(r.funding_fee) || 0,
        entryOrderId: r.entry_order_id,
        exitOrderId: r.exit_order_id,
      }));
  },

  /**
   * 修正一条已入账的回合，用交易所的权威口径。
   *
   * Used by reconciliation for round-trips the runtime *did* record, but whose
   * costs it only partly captured: the live path records the exit commission at
   * the moment of closing, so the entry leg's commission was missing and every
   * historical fee was understated by roughly half.
   *
   * ## 返回值：**它到底改没改**（2026-10-17 修「修正 N 笔」虚报）
   *
   * 这个函数**有权拒绝整笔改动**（见下面 `keepLocalQuantity` 那段：重建出的"腿"
   * 边界不可信时，数量与金额一并不覆盖）。而调用方原来把它当"改过了"来计数，
   * 于是线上每次对账都报「修正 50 笔」，实际账本一个字都没变 ——
   * 操作员误以为对账在工作，也没动机去追"为什么每轮都要修正同样那 50 笔"。
   *
   * 所以它现在返回**观测到的结果**：
   *   · `applied: true`  → 这一行的金额/数量/价位确实按交易所口径覆盖了；
   *   · `applied: false` → 因为 `keepLocalQuantity`（边界存疑）整行没动，
   *     `keptLocalQuantity` 是保留下来的本地成交量，供调用方把 `K` 报清楚。
   *
   * ⚠️ 调用方只能拿它**计数**，不能把它当成"这笔回合已经处理完了"的信号 ——
   * 被拒的那一行下一轮还会再撞一次同样的判断（那正是它值得被上报的原因）。
   */
  applyExchangeFigures(input: {
    id: number;
    grossPnl: number;
    entryFee: number;
    exitFee: number;
    fundingFee: number;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    leverage: number;
    entryOrderId: string | null;
    exitOrderId: string | null;
  }): { applied: boolean; keptLocalQuantity: number } {
    const fee = input.entryFee + input.exitFee;
    const netPnl = netPnlOf({ grossPnl: input.grossPnl, fee, fundingFee: input.fundingFee });

    /*
     * ⚠️ **重建出来的"数量"不可信时，保留本地那一份。**
     *
     * 实测（2026-09-29，HYPEUSDT）：重建的**窗口起点落在持仓中间**时，整条成交序列会错位 ——
     * 一个「先平 0.20 再开 0.15」的序列被算成「开空 0.35」，后续每个回合的数量于是全错：
     *
     *     #110 / #111 / #112 / #130   重建 0.01   真实 0.21   ← 差 21 倍
     *
     * 而这里原来无条件把 `quantity` 覆盖成本地 —— 连**按数量计价的手续费**也跟着算小，
     * 净额于是偏大，账目凭空多出 **0.0596 USDT**（`ledger_check` 上就是那个 gap）。
     *
     * 本地数量来自**运行期持仓行**（就是当时真实下单的数量），它**不经过重建**；
     * 当两者差到"不可能是同一个回合"时，保留本地。
     *
     * ## ⚠️ 2026-10-03：金额也**必须**一起保留
     *
     * 旧结论写的是"**金额（毛盈亏 / 手续费 / 资金费）仍然一律采用交易所的值 ——
     * 那是权威的**"。**那条结论是错的**，实盘 `#10`（MANAUSDT）的现场：
     *
     * ```text
     * 交易所成交: BUY 336 → SELL 168 (+1.132320) → SELL 168 (+0.408240)
     * 运行期记账: #191 毛 1.132320（第一笔 168）
     *             #192 毛 0.408240（第二笔 168，止损触发，exit_order_id 为 null）
     * 对账重建:   把整段看成一个 336 的腿 ⇒ grossPnl = 1.540560 = 两笔之和
     * ```
     *
     * 旧逻辑下 `keepLocalQuantity` 为真（336 vs 168 差得太远），**数量保住了**，
     * 而金额被无条件覆盖成 `1.540560` —— 于是 `#191` 变成"两笔之和"，而 `#192` 还在，
     * 账目凭空多出 **0.408240**（实测 `#10` 的净额从 -0.08742 变成 +0.31188）。
     *
     * **真相**：一个"腿"的 `grossPnl` 是这个腿里**所有**平仓成交的 `realizedPnl` 之和。
     * 数量对不上就说明这个腿的**边界**是错的，它的金额自然不能写进任何一行。
     *
     * 而保留的本地金额**不是粗口径**：它来自运行期从**成交明细**取到的那一笔
     * （见 `findRoundTrip()`），本身也是交易所的值，只是属于**正确的**那一笔。
     *
     * 所以数量不可信时，**金额与价位一并不覆盖**。
     */
    const local = getDb().get<{ quantity: number }>('SELECT quantity FROM trades WHERE id = ?', input.id);
    const keepLocalQuantity =
      local !== undefined && !shouldTrustReconciledQuantity(local.quantity, input.quantity);
    const quantity = keepLocalQuantity ? local.quantity : input.quantity;
    if (keepLocalQuantity) {
      log.warn(
        `对账算出的成交量（${input.quantity}）与本地记录（${local.quantity}）差得太远 —— ` +
          '已保留本地数量**与本地金额**（重建那个腿的边界是错的，它的金额可能是多个回合的合计）。' +
          '这通常意味着成交历史的窗口起点落在持仓中间，重建把开/平判反了，整条序列因此错位。',
      );
    }

    /*
     * ⚠️ **`keepLocalQuantity` 为真时这一行什么都没改** —— 所以要把它**报出去**。
     *
     * 线上实测的形状（用户报「每次都是修正 50 笔」）：本函数内部把改动整个拒掉，
     * 而调用方仍然 `corrected += 1` —— 于是那条日志每次都说"修正了 50 笔"，
     * 而账本**一个字都没变**。计数虚报比不计更糟：它让操作员以为对账在工作，
     * 于是没有动机去查"为什么每轮都要修正同样 50 笔"。
     *
     * 返回值是**观测事实**（`applied` = 是否真的执行了覆盖），不是"调用与否"：
     * 调用方只能用它来计数，不能反过来把它当成成功标志。
     *
     * ## ⚠️⚠️ 边界存疑时也**必须**跑 UPDATE —— 那里还回填着两个单号（P0 回归的教训）
     *
     * 我第一版把"拒绝"写成**早退**（`if (keepLocalQuantity) return …;`），
     * 结果那段 UPDATE 里最后两行**永不可达**：
     *
     * ```sql
     *     entry_order_id = COALESCE(?, entry_order_id),
     *     exit_order_id  = COALESCE(?, exit_order_id)
     * ```
     *
     * 而 `exit_order_id` 是 `findDuplicate()` 里**唯一确定性的判重身份**
     * （见 `findDuplicate()` 的说明与 `dedup.test.ts:24-34`：「平台记的净额比交易所
     * 流水多出 1.51 USDT，六组重复」），也是 `trades.insert({ idempotent: true })`
     * 唯一的去重入口。**旧代码在这条路上仍然回填单号**；早退之后这一类行永久失去身份
     * ⇒ 去重失效 ⇒ 同一回合可能被记两次 —— 这正是 `exit_order_id` 当年被引入要关掉的东西。
     *
     * 所以"拒绝"只作用在**金额/数量/价位**这些列上（用 `keep` 开关），
     * 单号两列**照常回填**：`COALESCE` 本来就是"有值才覆盖"，回填永远是安全的。
     */

    const margin = marginOf(input.entryPrice, quantity, input.leverage);
    /*
     * `quantity` 与 `pnl_percent` 都由交易所在**同一笔成交记录**里给出，所以要一起写。
     *
     * 这里曾经漏掉 `quantity`：参数收了、SQL 里却没有这一列，于是对账算出来的
     * 权威成交量被**静默丢弃** —— 账本留下的仍是运行期那个较粗的口径（本地持仓量），
     * 与交易所的成交记录对不上，而 §2.5 要求的正是"平台记录能与交易所对得上"。
     * 本次修幂等时正是靠这一列才把同一回合的两条路径收敛到同一个数字上。
     *
     * ⚠️ **`keepLocalQuantity` 为真时金额/数量/价位不覆盖** ——
     * 那个"腿"的边界是错的，它的金额可能是多个回合的合计，写进来就是重复记账。
     * 见上面那段 2026-10-03 的说明。`CASE WHEN ?` 的写法避免在 JS 里拼两份语句。
     *
     * ⚠️ 但**两个单号列不在 `keep` 的控制范围内**（见方法头那段 P0 说明）：
     * 它们是判重身份，边界存疑时必须照常回填。
     */
    const keep = keepLocalQuantity ? 1 : 0;
    getDb().run(
      `UPDATE trades
          SET pnl = CASE WHEN ? THEN pnl ELSE ? END,
              entry_fee = CASE WHEN ? THEN entry_fee ELSE ? END,
              fee = CASE WHEN ? THEN fee ELSE ? END,
              funding_fee = CASE WHEN ? THEN funding_fee ELSE ? END,
              net_pnl = CASE WHEN ? THEN net_pnl ELSE ? END,
              pnl_percent = CASE WHEN ? THEN pnl_percent ELSE ? END,
              entry_price = CASE WHEN ? THEN entry_price ELSE ? END,
              exit_price = CASE WHEN ? THEN exit_price ELSE ? END,
              quantity = ?,
              entry_order_id = COALESCE(NULLIF(entry_order_id, ''), ?),
              exit_order_id = COALESCE(NULLIF(exit_order_id, ''), ?)
        WHERE id = ?`,
      /* pnl */
      keep, input.grossPnl,
      /* entry_fee */
      keep, input.entryFee,
      /* fee */
      keep, fee,
      /* funding_fee */
      keep, input.fundingFee,
      /* net_pnl */
      keep, netPnl,
      /* pnl_percent */
      keep, margin > 0 ? (netPnl / margin) * 100 : 0,
      /* entry_price */
      keep, input.entryPrice,
      /* exit_price */
      keep, input.exitPrice,
      /* ⚠️ 用上面判定过的那个值：重建数量与本地差得太远时保留本地。 */
      quantity,
      input.entryOrderId,
      input.exitOrderId,
      input.id,
    );

    /*
     * ⚠️ 这条返回语句**必须在 UPDATE 之后**（不能再写成早退）——
     * UPDATE 里除了金额/数量/价位，还回填着 `entry_order_id` / `exit_order_id`，
     * 而后者是 `findDuplicate()` 唯一的确定性判重身份。早退会让那两行永不可达，
     * 于是"边界存疑"的行永久失去身份 ⇒ 去重失效（见方法头那段 P0 回归的说明）。
     *
     * 计数语义：`applied` 回答的是"**这一轮有没有被拒掉**"，不是"字节有没有变" ——
     * 写进去的值刚好与原来逐字段相同时也算生效（账本确实被写成了交易所口径）。
     */
    if (keepLocalQuantity) return { applied: false, keptLocalQuantity: quantity };
    return { applied: true, keptLocalQuantity: 0 };
  },

  /**
   * There is deliberately **no** `setFundingFee()` here.
   *
   * Funding cannot be read at the instant a position closes, and a setter that
   * writes a figure without recomputing `net_pnl` is an invitation to record a
   * number that never reaches the balance. Every close path therefore passes
   * `fundingFee` into `insert()` (read from `/fapi/v1/income`, or 0 and logged
   * when unreadable), and the reconcile pass rewrites it through
   * `applyExchangeFigures()`. Both of those derive `net_pnl` in one place.
   */

  /**
   * Round-trips already on the books, for matching against the exchange.
   *
   * `sinceIso` bounds the read to closes at or after that instant, and exists so
   * the **routine** reconciliation pass does not reload the trader's entire
   * lifetime every cycle. This method used to have no bound at all: a trader that
   * had been running for months rebuilt a map of every round-trip it had ever
   * booked, once per cycle, and `node:sqlite` is synchronous — so the cost was
   * paid on the event loop that runs the trading loop. The boot pass and the
   * periodic deep pass still read everything (omit the argument), which is what
   * keeps a close this trader slept through recoverable.
   */
  ledger(
    traderId: number,
    sinceIso?: string,
  ): Array<{
    id: number;
    symbol: string;
    quantity: number;
    entryPrice: number;
    openedAt: string;
    entryOrderId: string | null;
  }> {
    const sql =
      'SELECT id, symbol, quantity, entry_price, opened_at, entry_order_id FROM trades WHERE trader_id = ?' +
      (sinceIso ? ' AND closed_at >= ?' : '');
    return getDb()
      .all<{
        id: number;
        symbol: string;
        quantity: number;
        entry_price: number;
        opened_at: string;
        entry_order_id: string | null;
      }>(sql, ...(sinceIso ? [traderId, sinceIso] : [traderId]))
      .map((r) => ({
        id: r.id,
        symbol: r.symbol,
        quantity: r.quantity,
        entryPrice: r.entry_price,
        openedAt: r.opened_at,
        entryOrderId: r.entry_order_id,
      }));
  },

  /**
   * Distinct symbols this trader traded.
   *
   * `sinceIso` has the same purpose as on `ledger()`: reconciliation asks one
   * `userTrades` question per symbol, so an unbounded list keeps asking about
   * symbols that stopped trading months ago and spends weight every cycle on an
   * answer that cannot have changed.
   */
  tradedSymbols(traderId: number, sinceIso?: string): string[] {
    const sql =
      'SELECT DISTINCT symbol FROM trades WHERE trader_id = ?' +
      (sinceIso ? ' AND closed_at >= ?' : '');
    return getDb()
      .all<{ symbol: string }>(sql, ...(sinceIso ? [traderId, sinceIso] : [traderId]))
      .map((r) => r.symbol);
  },

  /**
   * **账户级**：所有机器人交易过的符号。
   *
   * ## 为什么需要它，而不是复用 `tradedSymbols(traderId)`
   *
   * 对账要跑两件事，而它们的**范围不同**：
   *
   *   · **恢复本机器人的成交** —— 只看**本机器人**交易过的符号（`tradedSymbols`）。
   *   · **清点外部活动** —— 那是**账户级**的概念："不属于本平台任何机器人"的成交。
   *     它落在哪个符号上，与本机器人自己交易过什么**毫无关系**。
   *
   * 原来两件事共用一份"本机器人"的符号表。后果是：一个只交易过少数几个币种的
   * 机器人，**看不到账户在别的币种上的外部活动** —— 那部分盈亏记不进
   * `foreignNet`，而它确实在交易所流水里，于是总账校验报出假差额。
   *
   * 实测：共用账户的三个机器人里，两个只报 195 笔外部活动、另一个报 223 笔，
   * 差额 −0.20 与 −0.006 的区别就出在这里。
   */
  allTradedSymbols(sinceIso?: string): string[] {
    const sql = 'SELECT DISTINCT symbol FROM trades' + (sinceIso ? ' WHERE closed_at >= ?' : '');
    return getDb()
      .all<{ symbol: string }>(sql, ...(sinceIso ? [sinceIso] : []))
      .map((r) => r.symbol);
  },

  /**
   * Realised PnL since 00:00 UTC, for the daily circuit breaker.
   *
   * Net, not gross: fees are a real loss and a breaker that ignores them will
   * keep trading through a streak that is only breaking even on paper.
   */
  /**
   * **指定时间之后**的全部机器人已实现净额合计。
   *
   * ## 为什么必须能按时间窗取
   *
   * 总账校验的交易所侧来自 `income` 流水，而那个接口**必须给时间窗**
   * （币安限制窗口长度）。于是平台侧**也必须限定在同一个窗口**，
   * 否则差额里会混进"窗口之外的历史交易"—— 那会**永久误报**，
   * 而一个永久误报的校验会训练操作员忽略这条告警。
   *
   * 实测：不加窗口时这个账户会报出 −0.86 的假差额，
   * 而真实差值是 0.0057（窗口边界的浮点误差）。
   */
  /**
   * 某个**交易所账户**上、`since` 之后的已实现净额合计。
   *
   * ## 为什么按【账户】而不是按机器人（2026-10-03 抓到的真 BUG）
   *
   * 总账校验拿平台侧的净额去比**交易所流水** —— 而流水是**账户级**的：
   * 它不区分"是哪个机器人下的单"，但**严格区分是哪个账户**。
   *
   * 所以平台侧也必须是"**同一个账户上的所有机器人**"：
   *
   *   · 按**单个机器人**求和 → 一个账户上跑两个机器人时，各自只看到自己那一半账目，
   *     与整个账户的流水比 ⇒ 每个都报差额；
   *   · 按**全部机器人**求和（原来的写法）→ 主账户与子账户的账目被混在一起，
   *     却拿去比其中一个账户的流水 ⇒ 差额正好是**另一个账户的全部盈亏**。
   *
   * 实测（2026-10-03）：`#9` 跑在子账户 #2、`#10` 跑在主账户 #3，
   * `#9` 的校验报 `platformSelf = -0.9387`（= #9 的 -0.0382 + #10 的 -0.9004），
   * 而 `exchangeNet = -0.0298`（只有账户 #2 的流水）⇒ 假差额 **-0.9088**。
   * 而 `#9` 自己的账目与它自己的账户流水只差 **0.0084**。
   *
   * 这条告警是唯一能自动发现"账本真的错了"的地方，假响会训练操作员忽略它
   * （代码里那段注释自己就这么写着），所以口径必须与流水一致到账户这一级。
   *
   * @param exchangeAccountId 该机器人所用的交易所账户
   */
  netSinceForAccount(exchangeAccountId: number, sinceIso: string): number {
    const row = getDb().get<{ total: number | null }>(
      `SELECT SUM(t.net_pnl) AS total
         FROM trades t
         JOIN traders tr ON tr.id = t.trader_id
        WHERE tr.exchange_account_id = ?
          AND COALESCE(tr.dry_run, 0) = 0
          AND t.closed_at >= ?`,
      exchangeAccountId,
      sinceIso,
    );
    return row?.total ?? 0;
  },


  realizedPnlToday(traderId: number): number {
    /*
     * ⚠️ **日界是北京时间，不是 UTC。**
     *
     * 原来这里是 setUTCHours(0, 0, 0, 0) —— UTC 零点，
     * 也就是**北京时间早上 8 点**。于是北京时间 9-19 07:30 的一笔平仓
     * 会被算进「UTC 9-18」，操作员上午看到的「今日」实际覆盖
     * 9-18 08:00 → 9-19 08:00，与他的认知差 8 小时。
     *
     * 而这个数字正是熔断（maxDailyLossPercent）用来决定要不要停手的依据。
     *
     * 用 beijingDayStartIso() 而不是 setHours(0,0,0,0)：
     * 后者用的是**服务器**的时区，换一台 UTC 的机器就会静默变回 UTC 零点。
     */
    const row = getDb().get<{ total: number | null }>(
      'SELECT SUM(net_pnl) AS total FROM trades WHERE trader_id = ? AND closed_at >= ?',
      traderId,
      beijingDayStartIso(),
    );
    return row?.total ?? 0;
  },

  /**
   * Aggregate performance.
   *
   * Classification is by **net** PnL: a trade that made a little on price but
   * less than it paid in commission lost money, and counting it as a win would
   * flatter the win rate and the profit factor. Kept as a repository method for
   * callers that only want the totals; the arithmetic itself lives in
   * `aggregateTrades()` so there is exactly one definition of every figure.
   */
  stats(traderId: number): TradeStats {
    return aggregateTrades(traderId).totals;
  },

  /**
   * The gross/net curve a Sharpe ratio and a drawdown are computed from.
   *
   * Time-ordered ascending and **bounded**, because `computeTraderStats` runs on
   * every dashboard refresh (every 5–12 s per trader) and `node:sqlite` is
   * synchronous — an unbounded `SELECT *` here is paid for with a blocked event
   * loop, i.e. with the trading loop. The bound is a display choice that is
   * stated in the code rather than hidden: beyond `TREND_WINDOW` round-trips the
   * dashboard's drawdown/Sharpe are "recent", not "lifetime".
   */
  curve(traderId: number, limit = TREND_WINDOW): TradeCurvePoint[] {
    return getDb()
      .all<TradeCurvePoint>(
        `SELECT pnl, pnl_percent, net_pnl, fee, funding_fee, closed_at AS closedAt
           FROM trades WHERE trader_id = ? ORDER BY closed_at DESC LIMIT ?`,
        traderId,
        limit,
      )
      .reverse();
  },

  /**
   * 疑似"同一回合记了两次"的成对行 —— **只报告，不删**。
   *
   * 为什么只报告：`data/` 里的账是历史，删一行等于改写历史，是人的决定。
   * 这次修复只保证**今后**不再产生重复（见 `findDuplicate()`），已经落库的三组
   * 重复行（SYNUSDT 99 / SYNUSDT 169 / LSKUSDT 35）要由操作者看过之后再决定。
   *
   * 判定条件与 `findDuplicate()` 同一个口径：`trader_id + symbol + quantity` 相同、
   * `closed_at` 相差 1 秒以内，且其中恰好一行是 `reconciled`。**`side` 不参与** ——
   * 重复行的 `side` 本来就一致，少一个条件只会让漏报更少。
   *
   * 注意 `close_reason`：运行期那行记的是"怎么平的"（`take_profit` / `stop_loss`），
   * 对账那行一律是 `reconciled`。所以**保留哪一行应当按信息量决定**，而不是简单地
   * "删掉 reconciled"：`#4 POWERUSDT 131` 是唯一一笔真正漏记的回合（没有运行期
   * 对应行），删掉它就把对账存在的意义一起删了。
   *
   * `traderId` 省略时扫描**所有**机器人：复核存量数据时不该要求操作者先知道
   * 是哪台机器人记的重复。
   */
  duplicateSuspects(traderId?: number): TradeDuplicateSuspect[] {
    const filter = traderId === undefined ? '' : 'WHERE a.trader_id = ?';
    /*
     * ⚠️ **两组判据并列，而不是一组放宽的判据。**
     *
     * 原来只有下面第一组（入场价 1e-6 + 平仓时间 1 秒）。它覆盖不了实盘真正
     * 发生的那类重复 —— 运行期记一次、几十分钟后对账又补一次（实测 `#90`/`#92`
     * 差 11 分钟、入场价差 0.116）。于是**那一对既没被写入守卫拦住、也没被这里
     * 报出来**，账上凭空多出 0.17，而钱包余额不会跟着多。
     *
     * 第二组用**出场价**（两条路径唯一同源的字段）做身份。**为什么不干脆把第一组的
     * 窗口和容差放大**：平仓时间那一条不能放 —— 同一标的两笔真实回合之间只隔着
     * 再入场冷却（分钟级），而实测那两笔正好差 11 分钟；窗口一放就可能把两笔
     * **真实**回合并成一笔，那比重复更严重（会凭空吃掉一笔交易）。
     *
     * 两组都要求 `source` 恰好一边是 `reconciled`：两行都是 `bot` 的重复属于
     * 另一类缺陷，不该混进这个报告里让人误判。
     *
     * ## ⚠️ 但两组都是启发式，而**单号是确定性的**
     *
     * 实测漏报（用户报的"归属权益和钱包对不上"）：ZECUSDT 的 `#107` 与 `#120`
     * **共用同一个 `exit_order_id`**（`807238763718`），却因为
     *   · 数量 0.009 vs 0.004 —— 差 0.005，超出 20% 容差（0.0018），**外层一票否决**；
     *   · 平仓时刻差 6 秒 —— 超出 2 秒窗口；
     * 而被这份报告整个漏掉。那一笔让归属权益比钱包高出 0.015。
     *
     * 所以：
     *
     *   ① 新增一条**最高优先**的判据 —— **两行的 `exit_order_id` 相同且非空**。
     *      它是交易所给的身份，不需要任何容差。
     *   ② 数量容差从外层收进启发式那一组里 —— 它不该跨分支否决单号判据
     *      （`findDuplicate()` 里是同一个毛病，一起改了）。
     */
    return getDb().all<TradeDuplicateSuspect>(
      `SELECT
         a.trader_id    AS traderId,
         a.id           AS idA,
         b.id           AS idB,
         a.symbol       AS symbol,
         a.quantity     AS quantity,
         a.closed_at    AS closedAt,
         a.close_reason AS reasonA,
         b.close_reason AS reasonB,
         a.net_pnl      AS netA,
         b.net_pnl      AS netB
       FROM trades a
       JOIN trades b
         ON a.trader_id = b.trader_id
        AND a.symbol = b.symbol
        AND a.id < b.id
        AND (
             (
               a.exit_order_id IS NOT NULL AND a.exit_order_id <> ''
           AND a.exit_order_id = b.exit_order_id
             )
          OR (
               ABS(a.quantity - b.quantity) <= MAX(1e-6, ABS(a.quantity) * ${DUPLICATE_QUANTITY_TOLERANCE})
           AND (
                (
                  ABS(a.exit_price - b.exit_price) <= MAX(1e-9, ABS(a.exit_price) * ${DUPLICATE_EXIT_PRICE_TOLERANCE})
              AND ABS((julianday(a.opened_at) - julianday(b.opened_at)) * 86400000.0) <= ${DUPLICATE_OPEN_TOLERANCE_MS}
                )
             OR (
                  ABS(a.entry_price - b.entry_price) <= MAX(1e-9, ABS(a.entry_price) * ${DUPLICATE_PRICE_TOLERANCE})
              AND ABS((julianday(a.closed_at) - julianday(b.closed_at)) * 86400000.0) <= ${DUPLICATE_REPORT_WINDOW_MS}
                )
             )
             )
        )
        AND (a.source = 'reconciled' OR b.source = 'reconciled')
        AND NOT (a.source = 'reconciled' AND b.source = 'reconciled')
       ${filter}
       ORDER BY ABS(a.net_pnl) DESC, a.closed_at DESC`,
      ...(traderId === undefined ? [] : [traderId]),
    );
  },
};

