import type { PositionView } from '@aq/shared';
import { getDb } from '../db/index.js';

const now = (): string => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/*  Positions                                                                  */
/* -------------------------------------------------------------------------- */

interface PositionRow {
  id: number;
  trader_id: number;
  symbol: string;
  /**
   * ⚠️ **只有小写 `'long' | 'short'` 两种取值，写成联合类型而不是 `string`。**
   *
   * 这一列只由交易循环写入（`autoTrader` 写 `isLong ? 'long' : 'short'`），
   * 而所有读它的地方都要按方向分支。用 `string` 收它，等于把"方向只有两种"
   * 这个事实从类型里删掉 —— 于是 `side === 'LONG'` 这种错误不会被 `tsc` 发现，
   * 只会在运行时静默地永远落到 else 分支（2026-11-09 实际修掉的那个 BUG）。
   *
   * 收窄之后，任何新的方向判断写错大小写都会**编译失败**，而不是算错浮盈。
   */
  side: 'long' | 'short';
  quantity: number;
  entry_price: number;
  leverage: number;
  liquidation_price: number | null;
  margin_used: number;
  peak_pnl_percent: number;
  stop_loss: number | null;
  take_profit: number | null;
  stop_order_id: string | null;
  tp_order_id: string | null;
  open_reasoning: string;
  opened_at: string;
  status: string;
  /** 限价入场的交易所单号（`status='pending'` 时有值）。见 `M11_PENDING_ENTRY`。 */
  entry_order_id: string | null;
  /** 模型为这一张挂单指定的耐心（分钟）；`null` = 用系统配置的基础时限。见 `M15_PENDING_WAIT_MINUTES`。 */
  wait_minutes: number | null;
  /**
   * **开仓决策依据的情报键**（JSON 数组字符串）。见 `M17_POSITION_INTEL_ATTRIBUTION`。
   *
   * ⚠️ 平仓时把它搬到 `trades.intel_keys` —— 那是 `signalHealth`
   * 失效检测的数据来源。**解析必须容错**（见 `autoTrader.parseIntelKeysOf`）：
   * 一个附属统计字段绝不该让平仓失败。
   */
  intel_keys: string;
}

/**
 * 一行「按平仓原因聚合的 峰值 vs 落袋」—— 见 `positions.peakVsRealised()`。
 *
 * 百分比都是**保证金口径**（`trades.pnl_percent` 与 `positions.peak_pnl_percent`
 * 同源），与提示词里"浮盈 X%"的说法一致。
 */
export interface PeakVsRealisedRow {
  closeReason: string;
  trades: number;
  /** 这一组的净盈亏合计（含手续费与资金费）。 */
  netPnl: number;
  /** 平均落袋（保证金口径 %）。 */
  avgNetPercent: number | null;
  /** 平均峰值浮盈（保证金口径 %）—— 接不到持仓行时为 `null`。 */
  avgPeakPercent: number | null;
  maxPeakPercent: number | null;
  /** 这一组里净盈亏为正的笔数。 */
  profitable: number;
}

export const positions = {
  /**
   * **峰值浮盈 → 实际落袋**的对照，**按平仓原因分组**。
   *
   * ## 为什么需要它（用户的原话：「我看到历史成交大多是提示：移动止损（保本离场）」）
   *
   * 实测那台机器人：**13 笔止损类平仓的平均峰值浮盈 2.84%、平均落袋只有 0.42%**
   * —— 回吐约 85%。而它自己的止盈目标是 3%。
   *
   * `trades.performanceSince()` 给的是"总净盈亏、胜率、平均盈亏"，**看不出这件事**：
   * 那些交易全都记成"盈利"，只是每笔只赚几分钱。要看出"**我在同一个地方把利润
   * 还回去**"，必须把**峰值**和**落袋**放在一起、按原因分组 ——
   * 而 `peak_pnl_percent` 只存在于**持仓行**，成交行里没有这一列。
   *
   * 与 `get_lessons` 的 `recurringTags`、`get_experiments` 的 `repeatedFields`
   * 是同一条思路：**单条说的是"这一次"，聚合说的是"我一直在同一个地方"。**
   * 而**数这件事该由程序做** —— 不该指望模型每次自己从一列散记录里翻。
   *
   * ## 关联键是 `symbol` + `opened_at`
   *
   * 两个仓储各写各的表，关联只能靠这两个字段（同一次开仓，两边的值同源）。
   * 用 `LEFT JOIN`：接不上的行（老记录、迁移前的手工数据）仍然计入成交那一侧，
   * 只是峰值为 `NULL` —— **宁可少一个数，也不要凭空丢掉一笔交易**。
   */
  peakVsRealised(traderId: number, sinceIso: string): PeakVsRealisedRow[] {
    return getDb().all<PeakVsRealisedRow>(
      `SELECT t.close_reason                                    AS closeReason,
              COUNT(*)                                          AS trades,
              ROUND(SUM(t.net_pnl), 4)                          AS netPnl,
              ROUND(AVG(t.pnl_percent), 2)                      AS avgNetPercent,
              ROUND(AVG(p.peak_pnl_percent), 2)                 AS avgPeakPercent,
              ROUND(MAX(p.peak_pnl_percent), 2)                 AS maxPeakPercent,
              SUM(CASE WHEN t.net_pnl > 0 THEN 1 ELSE 0 END)    AS profitable
         FROM trades t
         LEFT JOIN positions p
                ON p.trader_id = t.trader_id
               AND p.symbol = t.symbol
               AND p.opened_at = t.opened_at
        WHERE t.trader_id = ? AND t.closed_at >= ?
        GROUP BY t.close_reason
        ORDER BY trades DESC`,
      traderId,
      sinceIso,
    );
  },

  open(traderId: number): PositionRow[] {
    return getDb().all<PositionRow>(
      "SELECT * FROM positions WHERE trader_id = ? AND status = 'open' ORDER BY opened_at",
      traderId,
    );
  },

  /**
   * **这个标的最近的一行持仓 —— 含已平掉的那些。**
   *
   * ## 为什么需要它（2026-10-05 实测：历史成交的百分比虚高约 40 倍）
   *
   * 用户看到「历史成交」里 `+$0.44 · +156.05%`、`-$1.70 · -428.62%` 这种数字，
   * 问对不对 —— **不对**。反推每一笔的隐含保证金，全都指向一个 `leverage = 125`：
   *
   * ```text
   * #214 SANDUSDT net -1.695 → -428.62%  ⇒ margin 0.3955 = 0.07446×664 / 【125】
   * #215 QNTUSDT  net -1.1908 → -278.75% ⇒ margin 0.4272 = 267×0.2    / 【125】
   * #217 SUIUSDT  net +0.4365 → +156.05% ⇒ margin 0.2797 = 1.1934×29.3 / 【125】
   * ```
   *
   * 而它们的真实杠杆是 2 / 3 / 3。**125 正是配置里的 `altcoinMaxLeverage`。**
   *
   * 根因在 `autoTrader.leverageFor()`：仓位**已经被平掉**时，它查不到 `open` 行，
   * 于是回落到"配置上限"。于是**所有由对账重建的成交**都按 125 倍算百分比。
   *
   * 而 `positions` 表**保留着已平的那些行、且带着当时的真实杠杆** ——
   * 所以正确的答案是查"最近一行，不论状态"。
   */
  lastBySymbol(traderId: number, symbol: string): PositionRow | undefined {
    return getDb().get<PositionRow>(
      'SELECT * FROM positions WHERE trader_id = ? AND symbol = ? ORDER BY id DESC LIMIT 1',
      traderId,
      symbol,
    );
  },

  /**
   * **账户级**：当前所有未平仓持仓的符号（不分机器人）。
   *
   * 与 `tradedSymbols` / `allTradedSymbols` 同一个理由：清点"账户上的外部活动"时，
   * 别的机器人正持有的符号也必须扫到 —— 那些仓位平掉时产生的外部成交同样在
   * 交易所流水里，漏掉就又是一笔假差额。
   */
  allOpenSymbols(): string[] {
    return getDb()
      .all<{ symbol: string }>(
        "SELECT DISTINCT symbol FROM positions WHERE status = 'open'",
      )
      .map((r) => r.symbol);
  },

  /**
   * 同一交易所账户下，**其它机器人**当前处于 `open` 或 `pending`（挂单待转正）状态的标的集合。
   *
   * 多机器人共用同一个交易所账户时，`reconcilePositions` 看到交易所持仓但本机本地没有：
   * 若该标的已被同账户另一台机器人持有（或正有挂单等待转正），说明那是他机仓位，
   * 跳过收养、绝不抢占或撤改其保护单。
   */
  openSymbolsForOtherTradersOnAccount(accountId: number, excludeTraderId: number): Set<string> {
    return new Set(
      getDb()
        .all<{ symbol: string }>(
          `SELECT DISTINCT p.symbol
             FROM positions p
             JOIN traders t ON t.id = p.trader_id
            WHERE t.exchange_account_id = ?
              AND p.trader_id != ?
              AND COALESCE(t.dry_run, 0) = 0
              AND p.status IN ('open', 'pending')`,
          accountId,
          excludeTraderId,
        )
        .map((r) => r.symbol),
    );
  },

  /**
   * 同一交易所账户下所有实盘机器人当前的 `open` 持仓（排除 `dry_run = 1` 模拟盘，
   * 与 `netSinceForAccount` 同口径，防止纸面持仓污染实盘总账校验）。
   */
  openForAccount(accountId: number): PositionRow[] {
    return getDb().all<PositionRow>(
      `SELECT p.*
         FROM positions p
         JOIN traders t ON t.id = p.trader_id
        WHERE t.exchange_account_id = ?
          AND COALESCE(t.dry_run, 0) = 0
          AND p.status = 'open'
        ORDER BY p.opened_at`,
      accountId,
    );
  },

  getOpenBySymbol(traderId: number, symbol: string): PositionRow | undefined {
    return getDb().get<PositionRow>(
      "SELECT * FROM positions WHERE trader_id = ? AND symbol = ? AND status = 'open'",
      traderId,
      symbol,
    );
  },

  insert(input: {
    traderId: number;
    symbol: string;
    /**
     * 方向。**只接受小写** —— 见 `PositionRow.side` 的注释：写成 `string`
     * 时一个大写的 `'LONG'` 能一路编译通过，然后在所有读它的地方静默走错分支。
     */
    side: 'long' | 'short';
    quantity: number;
    entryPrice: number;
    leverage: number;
    liquidationPrice: number | null;
    marginUsed: number;
    stopLoss: number | null;
    takeProfit: number | null;
    stopOrderId: string | null;
    tpOrderId: string | null;
    openReasoning: string;
    /**
     * `'open'`（默认，成交后的持仓）或 `'pending'`（**限价入场：单已挂出、
     * 还没成交**）。
     *
     * `pending` 的行**不是持仓**：`open()` 只返回 `'open'`，所以风控、UI、
     * 权益计算看不到它 —— 那正是要的，一个还没成交的单不该占仓位名额。
     * 它的作用只有一个：**让对账知道"有一张挂出去的单要盯着"**。
     */
    status?: 'open' | 'pending';
    /** 限价入场那笔单的交易所单号 —— 对账靠它去问"成交了吗"。 */
    entryOrderId?: string | null;
    /** 模型为这一张挂单指定的耐心（分钟）；不传 = 用配置的基础时限。 */
    waitMinutes?: number | null;
    /**
     * **这条开仓决策依据了哪几条情报**（`<域名>|<方向>|<标的>`）。
     *
     * 见 `db/schema.ts` 的 M17 —— 它是**归因链的中间一环**：
     * ```
     *   开仓 → 存在 positions 上（此时决策在手边）
     *   平仓 → 搬到 trades 上（signalHealth 的数据来源）
     * ```
     *
     * ⚠️ 不传 = `[]` = **纯技术面开仓**（与改动前行为一致）。
     * 这里存的是**已经过 `filterKnownIntelKeys` 校验**的键 ——
     * 编造的不该走到这一层。
     */
    intelKeys?: readonly string[];
  }): number {
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO positions (trader_id, symbol, side, quantity, entry_price, leverage, liquidation_price, margin_used, peak_pnl_percent, stop_loss, take_profit, stop_order_id, tp_order_id, open_reasoning, opened_at, status, entry_order_id, wait_minutes, intel_keys)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.symbol,
      input.side,
      input.quantity,
      input.entryPrice,
      input.leverage,
      input.liquidationPrice,
      input.marginUsed,
      input.stopLoss,
      input.takeProfit,
      input.stopOrderId,
      input.tpOrderId,
      input.openReasoning,
      now(),
      input.status ?? 'open',
      input.entryOrderId ?? null,
      input.waitMinutes ?? null,
      JSON.stringify(input.intelKeys ?? []),
    );
    return lastInsertRowid;
  },

  /**
   * 还挂着的**限价入场单**（`status='pending'`）。
   *
   * 对账每轮拿它们去问交易所："成交了吗" —— 见 `AutoTrader.settlePendingEntries`。
   * 之所以要单独一个方法而不是让调用方自己过滤 `open()`：`open()` 刻意不返回
   * `pending`（它不是持仓），而"哪些单在等"是一个独立的、必须被看见的集合。
   */
  pending(traderId: number): PositionRow[] {
    return getDb().all<PositionRow>(
      "SELECT * FROM positions WHERE trader_id = ? AND status = 'pending' ORDER BY id",
      traderId,
    );
  },

  /**
   * 把一行 `pending` 转成真正的持仓 —— 限价单成交了。
   *
   * 用**交易所报的成交价与成交量**覆盖挂单时的意向值：挂单时填的是"我想在
   * 这个价位买这么多"，而成交时可能部分成交、也可能在更好的价位。
   * 本地账本只能记**实际发生的**（这条纪律这个项目里已经踩过三次）。
   *
   * `stop_order_id` / `tp_order_id` 由调用方在挂完保护单后用 `setProtection` 写。
   */
  promote(
    traderId: number,
    symbol: string,
    fill: { quantity: number; entryPrice: number; marginUsed: number },
    pendingId?: number,
  ): { mergedIntoExisting: boolean } {
    const db = getDb();

    return db.transaction(() => {
      /*
       * ⚠️ **该标的可能已经有一行 `open` 了 —— 那就不能再把它变成第二行。**
       *
       * 表上有一条**部分唯一索引**（`schema.ts`）：
       *
       *     CREATE UNIQUE INDEX idx_positions_open_symbol
       *       ON positions(trader_id, symbol) WHERE status = 'open';
       *
       * 而"限价单成交时已经有一行 open"是**真实会发生**的：对账的**收养路径**
       * 只检查了 `positionStore.open()`，**没有看 pending 行** —— 于是同一个标的
       * 可以同时存在「收养来的 open 行」和「还没成交的 pending 行」。
       *
       * 另外，即使没有 `open` 行，如果异常状态下存在多条 `pending` 行，按
       * `WHERE trader_id = ? AND symbol = ? AND status = 'pending'` 批量改状态
       * 也会一次把多行改成 `open` 而撞上唯一索引 —— 因此按精确 `pendingRow.id`
       * 更新单行，并将整段包裹在事务里。
       */
      const existingOpen = this.getOpenBySymbol(traderId, symbol);
      if (existingOpen) {
        if (pendingId !== undefined) {
          db.run(
            `UPDATE positions SET status = 'closed' WHERE id = ? AND trader_id = ? AND status = 'pending'`,
            pendingId,
            traderId,
          );
        } else {
          db.run(
            `UPDATE positions SET status = 'closed' WHERE trader_id = ? AND symbol = ? AND status = 'pending'`,
            traderId,
            symbol,
          );
        }
        db.run(
          `UPDATE positions SET quantity = ?, entry_price = ?, margin_used = ?, opened_at = ? WHERE id = ?`,
          fill.quantity,
          fill.entryPrice,
          fill.marginUsed,
          now(),
          existingOpen.id,
        );
        return { mergedIntoExisting: true };
      }

      const targetPendingId =
        pendingId ??
        db.get<{ id: number }>(
          `SELECT id FROM positions WHERE trader_id = ? AND symbol = ? AND status = 'pending' ORDER BY id ASC LIMIT 1`,
          traderId,
          symbol,
        )?.id;
      if (targetPendingId !== undefined) {
        db.run(
          `UPDATE positions
              SET status = 'open', quantity = ?, entry_price = ?, margin_used = ?, opened_at = ?
            WHERE id = ? AND trader_id = ? AND status = 'pending'`,
          fill.quantity,
          fill.entryPrice,
          fill.marginUsed,
          now(),
          targetPendingId,
          traderId,
        );
      }
      return { mergedIntoExisting: false };
    });
  },

  updatePeak(traderId: number, symbol: string, peakPnlPercent: number): void {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return;
    // Peak only ever ratchets upward.
    if (peakPnlPercent <= row.peak_pnl_percent) return;
    getDb().run('UPDATE positions SET peak_pnl_percent = ? WHERE id = ?', peakPnlPercent, row.id);
  },

  setProtection(
    traderId: number,
    symbol: string,
    stopLoss: number | null,
    takeProfit: number | null,
    stopOrderId?: string | null,
    tpOrderId?: string | null,
  ): void {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return;
    getDb().run(
      'UPDATE positions SET stop_loss = ?, take_profit = ?, stop_order_id = ?, tp_order_id = ? WHERE id = ?',
      stopLoss,
      takeProfit,
      stopOrderId === undefined ? row.stop_order_id : stopOrderId,
      tpOrderId === undefined ? row.tp_order_id : tpOrderId,
      row.id,
    );
  },


  /**
   * 支撑「加仓 / 减仓」的两个仓库方法。
   *
   * ## 为什么数量与均价要一起改
   *
   * 加仓改变的是**加权平均入场价**：`(旧均价×旧数量 + 新价×新数量) / 总数量`。
   * 只改数量、不改均价的话，平仓时算出来的盈亏是错的 ——
   * 而那个数字会一路传到 `trades`，成为永久的账面记录。
   *
   * **减仓反过来：均价不变。** 卖掉一部分不改变剩余部分当初的买入价
   * —— 这正是"加权平均"这个模型的含义。改它是记账错误。
   */
  resize(
    traderId: number,
    symbol: string,
    input: {
      /** 新的总数量（不是增量）。 */
      quantity: number;
      /** 新的加权均价；减仓时传原值。 */
      entryPrice: number;
      /** 保证金随之变化 —— 它由数量与杠杆决定。 */
      marginUsed: number;
      /**
       * 部分平仓累计已记的**毛**盈亏（只增不减）。
       *
       * ⚠️ **2026-10-03 起语义是"毛"**（此前是"净"）。列名保持
       * `realized_partial_pnl` 不变以免多一次迁移，但调用方要减的是
       * **`grossPnl` 而不是 `netPnl`** —— 拿毛减净会把那一部分的平仓手续费
       * 多扣一次。见 `partialBooked()` 与最终平仓处的说明。
       */
      addRealizedPartialPnl?: number;
      /** 部分平仓累计已记的数量（只增不减）。 */
      addBookedPartialQty?: number;
    },
  ): void {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return;
    getDb().run(
      `UPDATE positions
         SET quantity = ?, entry_price = ?, margin_used = ?,
             realized_partial_pnl = realized_partial_pnl + ?,
             booked_partial_qty = booked_partial_qty + ?
       WHERE id = ?`,
      input.quantity,
      input.entryPrice,
      input.marginUsed,
      input.addRealizedPartialPnl ?? 0,
      input.addBookedPartialQty ?? 0,
      row.id,
    );
  },

  /**
   * 部分平仓已经记了多少（**毛**盈亏 + 数量）。
   *
   * 最终平仓时要把它从交易所重建的整段往返里**减掉** —— 见迁移 M8 的说明：
   * 重复记账会让账面比账户好看，而那正是 §2.5 禁止的方向。
   *
   * ⚠️ **`gross` 是毛盈亏**（2026-10-03 起）。这个函数曾经叫 `.pnl` 并返回净额，
   * 而调用方拿它去减**毛** —— 口径不匹配，等于把已记那部分的平仓手续费多扣一次
   * （`G − (g − xf)` 而不是 `G − g`，毛被高估 `xf`）。改名成 `gross` 就是为了
   * 让调用点一眼看出它该配 `grossRaw`。
   */
  partialBooked(traderId: number, symbol: string): { gross: number; qty: number } {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return { gross: 0, qty: 0 };
    const r = getDb().get(
      'SELECT realized_partial_pnl AS gross, booked_partial_qty AS qty FROM positions WHERE id = ?',
      row.id,
    ) as { gross: number | null; qty: number | null } | undefined;
    return { gross: Number(r?.gross) || 0, qty: Number(r?.qty) || 0 };
  },
  close(id: number): void {
    getDb().run("UPDATE positions SET status = 'closed' WHERE id = ?", id);
  },

  closeAllForTrader(traderId: number): void {
    getDb().run(
      "UPDATE positions SET status = 'closed' WHERE trader_id = ? AND status = 'open'",
      traderId,
    );
  },
};

/**
 * 这个交易所单号是否落在给定的单号集合里 —— **兼容"被精度改写过的历史行"**。
 *
 * ## 为什么需要它（实测：账目告警每轮误报）
 *
 * 币安新版订单号是 **19 位**（超过 `Number.MAX_SAFE_INTEGER`），而 2026-09-28 之前
 * 这个项目在解析响应时用了 `Number(orderId)` —— 于是**写进 `orders` 表的是被精度
 * 改写过的值**：
 *
 * ```text
 * 交易所成交里的真实入口单号   8389766285736311569
 * 本地 orders 里存下来的        8389766285736312000   ← 末尾被改写
 * ```
 *
 * 而"这个回合属不属于本机器人"的判据就是拿这两边做**字符串相等**比较 →
 * **永远不相等** → 那一笔被判成「不属于本平台的成交」（`foreign`）→
 * 总账校验凭空多出一笔外部净额（实测 `foreignNet = -0.256743`，与那笔真实成交
 * **一字不差**），于是每轮都报「账目与交易所对不上」。
 *
 * 解析层已经修好（`preserveBigIds()`），但**已经写进库的历史行改不回来** ——
 * 所以这里再宽容一层：把两边都按旧精度归一化后比一次。
 * 16 位以内的单号 `Number()` 可精确表示，这一步是无损的，**不会放宽任何真实判定**。
 */
export function orderIdIn(id: string, ids: ReadonlySet<string>): boolean {
  if (id.length === 0) return false;
  if (ids.has(id)) return true;
  const loose = String(Number(id));
  return loose !== id && ids.has(loose);
}

