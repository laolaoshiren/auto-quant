import type { EquitySnapshot, TraderStats } from '@aq/shared';
import { getDb } from '../db/index.js';
import { traders } from './configRepos.js';
import { positions } from './positionsRepo.js';
import { clampPageLimit, orders } from './ordersRepo.js';
import { aggregateTrades, EQUITY_CURVE_WINDOW, trades } from './tradesRepo.js';
import { decisions } from './decisionsRepo.js';

const now = (): string => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/*  Equity snapshots                                                           */
/* -------------------------------------------------------------------------- */

interface EquityRow {
  id: number;
  trader_id: number;
  timestamp: string;
  equity: number;
  available_balance: number;
  unrealized_pnl: number;
  margin_used: number;
  open_positions: number;
  account_equity: number;
  account_unrealized_pnl: number;
}

/**
 * 本机器人**归属权益**。
 *
 * 一个机器人的权益是它自己的交易挣来的那部分，而不是共用的钱包余额：
 *
 *   initialEquity + Σ(本机器人 net_pnl) + 本机器人持仓浮盈
 *
 * `net_pnl` 是净额的唯一来源（§2.5：毛 − 手续费 − 资金费），这里**只做求和**，
 * 不重算任何一笔的净额。
 *
 * 为什么必须这样算：同一个交易所账户下可以跑多个机器人，它们共用凭据与钱包，
 * `account.equity` 对它们全都是同一个数。直接用它，一个从未成交的机器人就会
 * 显示别的机器人挣来的收益率（实盘上量到过 +2.67%），而一个已停止的机器人的
 * 数字会随着邻居继续交易而变化。
 */
export function attributedEquity(
  initialEquity: number,
  netRealizedPnl: number,
  unrealizedPnl: number,
): number {
  return initialEquity + netRealizedPnl + unrealizedPnl;
}

/**
 * 本机器人自己持仓的浮动盈亏。
 *
 * 为什么需要它：`equity_snapshots.unrealized_pnl` 原来抄的是
 * `account.unrealizedPnl` —— 整个交易所账户的浮盈。共用账户时每个机器人记的都是
 * 同一个数，控制台的「浮动盈亏」于是显示成账户的总浮盈（谁都能看到一个和自己
 * 无关的数）。控制台里两个机器人显示同一个浮盈，就是从这里来的。
 *
 * 自己的浮盈只能用自己的持仓算：**自己的**开仓价、数量、方向，乘上**市场**的
 * 标记价。标记价是行情事实（对所有机器人相同），借用它不引入归属错误；开仓价与
 * 数量必须来自本机器人的 `positions` 行，因为交易所那一行可能是多个机器人合起来
 * 的净头寸。
 *
 * 读不到标记价的持仓按 0 计并**把标的返回给调用方**：悄悄按 0 算是把浮盈/浮亏
 * 藏起来，和写账户数字是同一类错误，必须有人能说出来。
 */
export function ownUnrealizedPnlOf(
  openPositions: ReadonlyArray<{ symbol: string; side: string; quantity: number; entry_price: number }>,
  markPriceOf: (symbol: string) => number | undefined,
): { unrealizedPnl: number; missingMarkPrice: string[] } {
  let unrealizedPnl = 0;
  const missingMarkPrice: string[] = [];

  for (const position of openPositions) {
    const markPrice = markPriceOf(position.symbol);
    if (typeof markPrice !== 'number' || !(markPrice > 0)) {
      missingMarkPrice.push(position.symbol);
      continue;
    }
    // 数量在 `positions` 里恒为正，方向由 `side` 承载（与交易所侧一致）。
    const direction = position.side === 'short' ? -1 : 1;
    unrealizedPnl += (markPrice - position.entry_price) * position.quantity * direction;
  }

  return { unrealizedPnl, missingMarkPrice };
}

export const equity = {
  list(traderId: number, limit = 500): EquitySnapshot[] {
    return getDb()
      .all<EquityRow>(
        /*
         * `id DESC` 是 `timestamp DESC` 的**决胜键**，不是装饰。
         *
         * 一个周期写一条快照，而两个周期完全可能落在**同一毫秒**里（实测：整个测试跑完
         * 只要 3.9ms）。只按 `timestamp` 排序时，同一毫秒内的行序是未定义的 —— 实测
         * SQLite 会先回**先插入**的那一行，于是 `latest()` 拿到的是上一轮的快照：
         * 控制台显示的浮盈晚一轮，而依赖它的归属权益会算错。这不是理论问题：它让
         * `stats.test.ts` 里"开仓 + 平仓后权益应为 1001"的断言间歇性地得到 1002
         * （浮盈取到了平仓前那一轮的 +1），大约每 10 次全量测试出现一次。
         *
         * 时间戳相同时，"最新"只能是**最后写入**的那一条，所以用自增主键决胜。
         */
        'SELECT * FROM equity_snapshots WHERE trader_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?',
        traderId,
        limit,
      )
      .reverse()
      .map((row) => ({
        traderId: row.trader_id,
        timestamp: row.timestamp,
        equity: row.equity,
        availableBalance: row.available_balance,
        unrealizedPnl: row.unrealized_pnl,
        marginUsed: row.margin_used,
        openPositions: row.open_positions,
        accountEquity: row.account_equity,
        accountUnrealizedPnl: row.account_unrealized_pnl,
      }));
  },

  insert(snapshot: EquitySnapshot): void {
    getDb().run(
      `INSERT INTO equity_snapshots (trader_id, timestamp, equity, available_balance, unrealized_pnl, margin_used, open_positions, account_equity, account_unrealized_pnl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      snapshot.traderId,
      snapshot.timestamp,
      snapshot.equity,
      snapshot.availableBalance,
      snapshot.unrealizedPnl,
      snapshot.marginUsed,
      snapshot.openPositions,
      snapshot.accountEquity,
      snapshot.accountUnrealizedPnl,
    );
  },

  /**
   * Highest equity ever recorded — **on closed positions only**.
   *
   * Snapshot 的账户权益（`account_equity`）是保证金余额，含未实现盈亏。拿它当
   * 熔断器的高水位是一次真实的 bug：一次未实现浮盈的尖峰（开仓价格瞬间上插）
   * 把高水位永久抬高，价格回落后标记口径回到基线，于是之后每一轮都算出一个
   * 从未发生过的回撤，`maxTotalDrawdownPercent` 从此**永久且静默地**拒绝开新仓
   * —— 原因只写进日志，没有任何东西会清除它。
   *
   * `account_equity - account_unrealized_pnl` 是"开仓按开仓价计价"时账户的余额，
   * 也就是只有真正平仓时才会动的那个数。入金同样会推动它，这是对的：入金确实
   * 抬高了账户的基数。
   *
   * 这一列必须用 `account_*`：`equity` 自 M4 起是**本机器人归属**口径，拿它当
   * 账户高水位会让风控的输入跟着单个机器人的账本走（§4.2，风控输入不变）。
   */
  realizedHighWaterMark(traderId: number): number {
    const row = getDb().get<{ peak: number | null }>(
      'SELECT MAX(account_equity - account_unrealized_pnl) AS peak FROM equity_snapshots WHERE trader_id = ?',
      traderId,
    );
    return row?.peak ?? 0;
  },

  latest(traderId: number): EquitySnapshot | undefined {
    const rows = this.list(traderId, 1);
    return rows[rows.length - 1];
  },
};

/* -------------------------------------------------------------------------- */
/*  Trade events (throttling bookkeeping)                                      */
/* -------------------------------------------------------------------------- */

/**
 * `trade_events` 保留窗口。
 *
 * 这张表原来**没有任何保留策略**，而每个回合至少写两行（entry + exit），
 * 于是它随交易次数线性增长、永不收缩。
 *
 * 7 天是"安全富余"而不是"刚好够用"，理由是这张表的**每一个读取者**都只看最近一小段：
 *
 *  · `entriesThisHour()` 只看 1 小时；
 *  · `isInCooldown()` 只问「这个标的上一次 exit 是什么时候」，而 cooldown 的上限由
 *    `StrategyConfigSchema` 钉死在 1440 分钟（24 小时）—— 超过 24 小时的记录
 *    无论存在与否都不改变判断结果。
 *
 * 所以 7 天 = 最长 cooldown 的 7 倍，即使出现时钟跳变或手工改过配置也不会读到
 * 被裁掉的行。反向的取舍：裁早了会**放开**一个本该仍在冷却的标的（更激进），
 * 所以窗口宁可给足，不能贴着 1440 分钟设。
 *
 * 注意：账目正确性不依赖这张表 —— 净盈亏来自 `trades`，节流只是运行时约束。
 */
const TRADE_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 每写入这么多条节流事件顺手裁剪一次 7 天前的历史行。
 *
 * 原实现挂在 `countSince()` 里并要求窗口内 `count >= 200`（1 小时内开仓 ≥200 次），
 * 正常交易下永远不会触发，导致 `trade_events` 无限膨胀。改为在 `record()` 写入路径上
 * 按写入计数周期性裁剪（与 `runtimeLogs` 相同模式）。
 */
const TRADE_EVENT_TRIM_EVERY_WRITES = 200;
let tradeEventWritesSinceTrim = 0;

/**
 * 裁掉保留窗口之外的节流事件。
 *
 * 模块级函数而不是 `tradeEvents.trim`：避免对象字面量初始化期的自引用问题。
 */
function trimTradeEvents(retentionMs = TRADE_EVENT_RETENTION_MS): void {
  getDb().run(
    'DELETE FROM trade_events WHERE created_at < ?',
    new Date(Date.now() - retentionMs).toISOString(),
  );
}

export const tradeEvents = {
  record(traderId: number, symbol: string, kind: 'entry' | 'exit'): void {
    getDb().run(
      'INSERT INTO trade_events (trader_id, symbol, kind, created_at) VALUES (?, ?, ?, ?)',
      traderId,
      symbol,
      kind,
      now(),
    );
    tradeEventWritesSinceTrim += 1;
    if (tradeEventWritesSinceTrim >= TRADE_EVENT_TRIM_EVERY_WRITES) {
      tradeEventWritesSinceTrim = 0;
      trimTradeEvents();
    }
  },

  /** 裁剪到保留窗口内。写路径按写入计数周期性触发，也可按需显式调用。 */
  trim(retentionMs = TRADE_EVENT_RETENTION_MS): void {
    trimTradeEvents(retentionMs);
  },

  countSince(traderId: number, kind: 'entry' | 'exit', sinceIso: string): number {
    return getDb().count(
      'SELECT COUNT(*) AS n FROM trade_events WHERE trader_id = ? AND kind = ? AND created_at >= ?',
      traderId,
      kind,
      sinceIso,
    );
  },

  /** Most recent event of a kind for a symbol — drives the re-entry cooldown. */
  lastFor(traderId: number, symbol: string, kind: 'entry' | 'exit'): string | undefined {
    const row = getDb().get<{ created_at: string }>(
      'SELECT created_at FROM trade_events WHERE trader_id = ? AND symbol = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
      traderId,
      symbol,
      kind,
    );
    return row?.created_at;
  },

  /**
   * 这个机器人最后一次平仓是什么时候（任意标的）。
   *
   * 提示词的「本周期约束」区块要告诉模型它离再入场冷却还有多远。冷却本身是**按标的**
   * 计的（`isInCooldown(symbol)`），这里只回"最近一次平仓"，因为把每个仍在冷却的标的
   * 都列出来会让区块大小随标的数变化，破坏 §4 的 O(1) 要求。
   *
   * 这只是让模型**看见**约束；真正的判定仍然在 `AutoTrader.isInCooldown()` 与风控里，
   * 按标的执行。看不见的约束等于不存在 —— 但看得见的约束也不代替执行。
   */
  lastExit(traderId: number): string | undefined {
    const row = getDb().get<{ created_at: string }>(
      'SELECT created_at FROM trade_events WHERE trader_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
      traderId,
      'exit',
    );
    return row?.created_at;
  },

  entriesThisHour(traderId: number): number {
    return this.countSince(traderId, 'entry', new Date(Date.now() - 3_600_000).toISOString());
  },

  /**
   * 本周期已经开了几仓 —— 用「该轮决策落库的时刻」当起点数之后的开仓事件。
   *
   * ## ⚠️ 列名是 `timestamp`，不是 `created_at`（外部 issue #151）
   *
   * 这里原来查 `SELECT created_at FROM decision_records`，而
   * **`decision_records` 的时间列叫 `timestamp`**（`db/schema.ts:188`）——
   * `created_at` 在那一张表上**不存在**，于是这个方法一被调用就抛
   * `no such column: created_at`。
   *
   * 成因是照抄了相邻的 `lastExit()`：那个方法查的是 **`trade_events`** 表，
   * 而**那张表确实有 `created_at`**（`schema.ts:227`）。改了表名、没改列名。
   *
   * ## 它为什么至今没爆：没有调用点
   *
   * 全仓 grep 只有本方法的定义 —— 其余的 `entriesThisCycle` 命中全是
   * `RiskEnvironment` 的**同名字段**（`engine.ts` / `autoTrader.ts:3849` 里那个
   * `entriesThisCycle: 0` 是风控环境的局部计数，与本方法无关）。
   * 所以它是一颗**没人踩到的哑弹**。
   *
   * ⚠️ 这类"死方法里查了不存在的列"值得修而不是删：它的**语义是有效的**
   *（按 `cycle_number` 定位那一轮的起始时刻、再数之后的开仓事件），
   * 而 `risk/engine.ts` 的 `maxEntriesPerCycle` 判据正需要这类信息 ——
   * 现在那个值由调用点从一个变量 0 开始累加（见 `engine.ts:558-569` 的说明）。
   * 一旦有人把本院方法接上，就是线上 500。
   *
   * 同族的既有缺陷：`trades.feesOf()` 曾查不存在的 `exit_fee` 列（已修）。
   *
   * 查不到该轮次时**回落到"最近一分钟"**这个保守窗口，而不是抛 ——
   * 调用方可能在一轮决策刚落库、或对账补录的时序下问一次。
   */
  entriesThisCycle(traderId: number, cycleNumber: number): number {
    const row = getDb().get<{ timestamp: string }>(
      'SELECT timestamp FROM decision_records WHERE trader_id = ? AND cycle_number = ? LIMIT 1',
      traderId,
      cycleNumber,
    );
    const since = row?.timestamp ?? new Date(Date.now() - 60_000).toISOString();
    return this.countSince(traderId, 'entry', since);
  },
};

/* -------------------------------------------------------------------------- */
/*  Settings and logs                                                          */
/* -------------------------------------------------------------------------- */

export const settings = {
  get(key: string): string | undefined {
    return getDb().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
  },
  set(key: string, value: string): void {
    getDb().run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  },
};

/** 控制台日志保留的最新行数。表有界，但**不再每写一行就裁剪一次**。 */
export const RUNTIME_LOG_CAP = 500;

/**
 * `runtimeLogs.list()` 一次最多回多少行。
 *
 * 与 `RUNTIME_LOG_CAP` 一致：表里本来就只有这么多行，要更多也没有。
 */
export const RUNTIME_LOG_PAGE_MAX = RUNTIME_LOG_CAP;

/** 不传 `limit` 时返回多少行 —— 与历史契约一致（路由原先写死 200）。 */
export const RUNTIME_LOG_PAGE_DEFAULT = 200;
/**
 * 每写入这么多行才执行一次裁剪。
 *
 * 为什么不是每行一次：原实现的 DELETE 是
 * `DELETE … WHERE id NOT IN (SELECT id … LIMIT 500)`，每写一行扫一遍全表。
 * 而 `emit()` 会在**每个标的的循环里**调用它（对账补录、保护单挂不上、
 * 平仓失败……），一轮周期里能触发几十次；`node:sqlite` 是同步 API，
 * 这些全表扫描全部阻塞事件循环 —— 事件循环正是交易循环本身。
 *
 * 200 这个数字是"内存里多留 200 行"换"DELETE 次数降两个数量级"：
 * 表的上界变成 CAP + TRIM_EVERY = 700 行，而控制台只读最近 200 行，
 * 缓冲的那部分没有任何读取路径依赖它。
 */
const TRIM_EVERY_WRITES = 200;
/** 距离上次裁剪已写入的行数。模块级状态即可：裁剪是全局的，不区分 trader。 */
let writesSinceTrim = 0;

export const runtimeLogs = {
  write(traderId: number | null, level: string, scope: string, message: string): void {
    getDb().run(
      'INSERT INTO runtime_logs (trader_id, level, scope, message, created_at) VALUES (?, ?, ?, ?, ?)',
      traderId,
      level,
      scope,
      message,
      now(),
    );
    writesSinceTrim += 1;
    if (writesSinceTrim >= TRIM_EVERY_WRITES) {
      writesSinceTrim = 0;
      this.trim();
    }
  },

  /** 把表压回 `RUNTIME_LOG_CAP` 行。写路径按批次调用，不是每行调用。 */
  trim(): void {
    getDb().run(
      `DELETE FROM runtime_logs
        WHERE id NOT IN (SELECT id FROM runtime_logs ORDER BY id DESC LIMIT ${RUNTIME_LOG_CAP})`,
    );
  },

  list(limit = RUNTIME_LOG_PAGE_DEFAULT): Array<{ id: number; traderId: number | null; level: string; scope: string; message: string; createdAt: string }> {
    /*
     * ⚠️ **钳制放在仓储层，不放在路由** —— 与 `orders` 的 `clampOrderLimit` 同一个取舍。
     *
     * 原来的路由只挡了非有限值（`Number.isFinite`），而 `1e21` **是有限数**：
     * 它顺利通过并直达 SQL 的 `LIMIT ?`，`node:sqlite` 随即抛
     * `datatype mismatch`（不是截断、不是空结果）→ 整个端点 500。
     * 实测触发条件是 **≥1e21 或非整数**（`1.5` 同样抛；而 `2**53` 虽然超出
     * 安全整数范围却仍然正常，所以"超安全整数"不是判据）。
     *
     * 放在这里而不是路由里的理由：表有界（`RUNTIME_LOG_CAP`），
     * 所以"要超过 500 行"本身就没有意义；在仓储层钳制能让**将来任何新调用点**
     * 自动受保护，不必记得在每个路由里各写一遍。
     *
     * 另外顺手挡住负数：SQLite 的 `LIMIT -5` 表示**无上限**，
     * 会把全表回给调用方 —— 与"只回一页"的契约相反。
     */
    const pageSize = clampPageLimit(limit, RUNTIME_LOG_PAGE_MAX, RUNTIME_LOG_PAGE_DEFAULT);
    return getDb()
      .all<{ id: number; trader_id: number | null; level: string; scope: string; message: string; created_at: string }>(
        'SELECT * FROM runtime_logs ORDER BY id DESC LIMIT ?',
        pageSize,
      )
      .reverse()
      .map((row) => ({
        id: row.id,
        traderId: row.trader_id,
        level: row.level,
        scope: row.scope,
        message: row.message,
        createdAt: row.created_at,
      }));
  },
};

/* -------------------------------------------------------------------------- */
/*  Aggregated statistics                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compute a trader's headline statistics.
 *
 * Sharpe is annualised from per-trade returns using the trade count as the
 * sample size, which is crude but honest — it is labelled as such in the UI and
 * is only comparable between traders on the same cadence.
 */
export function computeTraderStats(traderId: number): TraderStats {
  const trader = traders.get(traderId);
  /*
   * One pass over `trades` for both the totals and the Sharpe input.
   *
   * This used to be **four** full scans per request: `trades.stats()`, a second
   * `SELECT pnl, pnl_percent FROM trades` for the Sharpe, and `equity.list(5000)`
   * called *twice* — once for the drawdown walk and once again just to read
   * `[0].timestamp`. The dashboard refreshes this every 5–12 s per trader, and
   * `node:sqlite` is synchronous, so every one of those scans ran on the event
   * loop that also drives the trading cycle. Two of them were also unbounded.
   */
  const { totals: tradeStats, curve: closed } = aggregateTrades(traderId);
  const latest = equity.latest(traderId);
  const openPositions = positions.open(traderId);

  /*
   * `realizedPnl` is the **net** figure — gross minus fees minus funding —
   * because that is what the account actually gained and what the console must
   * show. Reporting gross here is what let the platform claim −0.3136 on an
   * account that had made +0.2586.
   */
  const realizedPnl = tradeStats.netPnl;
  const initial = trader?.initialEquity ?? 0;
  /*
   * 归属权益：**每次按定义重算**，不读快照里存的存量值。
   *
   * 两个理由：
   *  1. 升级前落库的 `equity` 装的是共享钱包余额（M4 之前的 bug），照读会把
   *     那个数字原样带到新版本 —— 一个从未成交的机器人就继续显示别人的收益。
   *  2. 对账补录的成交会立刻反映到控制台，不必等下一个快照；反过来，一个已停止
   *     的机器人没有新快照，这个数就冻在那里不动 —— 这正是它该有的行为。
   *
   * 浮盈取最近一条快照里**本机器人自己的**那个数（标记价只有周期才会重新读到），
   * 不是账户的总浮盈。
   */
  const unrealizedPnl = latest?.unrealizedPnl ?? 0;
  const equityNow = attributedEquity(initial, realizedPnl, unrealizedPnl);

  // Sharpe over **net** returns, matching the headline number.
  const returns = closed.map((t) => t.pnl_percent / 100);
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance =
    returns.length > 1
      ? returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(Math.min(returns.length, 252)) : null;

  /*
   * Equity curve for the drawdown walk and for uptime.
   *
   * Read **once**. The previous code called `equity.list(traderId, 5000)` twice
   * with identical arguments — the second time purely to read element `[0]` — so
   * every dashboard refresh scanned and materialised the same 5000 snapshots
   * twice.
   */
  const equityCurve = equity.list(traderId, EQUITY_CURVE_WINDOW);

  // Max peak-to-trough drawdown across the equity curve.
  let peak = 0;
  let maxDrawdown = 0;
  for (const snapshot of equityCurve) {
    const value = snapshot.equity;
    if (value > peak) peak = value;
    if (peak > 0) {
      const dd = ((peak - value) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const firstSnapshot = equityCurve[0];
  const uptimeHours = firstSnapshot
    ? (Date.now() - new Date(firstSnapshot.timestamp).getTime()) / 3_600_000
    : 0;

  return {
    traderId,
    equity: equityNow,
    initialEquity: initial,
    totalReturnPercent: initial > 0 ? ((equityNow - initial) / initial) * 100 : 0,
    realizedPnl,
    grossRealizedPnl: tradeStats.grossPnl,
    totalFees: tradeStats.totalFees,
    totalFunding: tradeStats.totalFunding,
    unrealizedPnl,
    /*
     * 共享钱包单独给出：同一账户下的多个机器人读数是同一个数，混进 `equity`
     * 就没法分辨"这个机器人挣了多少"和"账户里有多少钱"。没有快照时为 0，
     * 界面据此显示"—"而不是假装账户是空的。
     */
    accountEquity: latest?.accountEquity ?? 0,
    totalTrades: tradeStats.totalTrades,
    // Percentage in 0–100. The field name states the unit so no caller has to
    // guess — an earlier `winRate` with no unit was multiplied by 100 again on
    // the client and rendered one win as 10000.0%.
    winRatePercent:
      tradeStats.totalTrades > 0 ? (tradeStats.wins / tradeStats.totalTrades) * 100 : 0,
    // Sent as real counts rather than left for the client to back out of the
    // percentage, which is lossy and produced "1 笔已平仓 / 100 盈".
    wins: tradeStats.wins,
    losses: tradeStats.losses,
    profitFactor:
      tradeStats.grossLoss > 0
        ? tradeStats.grossProfit / tradeStats.grossLoss
        : tradeStats.grossProfit > 0
          ? Number.POSITIVE_INFINITY
          : 0,
    avgWin: tradeStats.avgWin,
    avgLoss: tradeStats.avgLoss,
    maxDrawdownPercent: maxDrawdown,
    sharpeRatio: sharpe,
    bestTrade: tradeStats.best,
    worstTrade: tradeStats.worst,
    openPositions: openPositions.length,
    cyclesRun: decisions.count(traderId),
    uptimeHours,
  };
}

