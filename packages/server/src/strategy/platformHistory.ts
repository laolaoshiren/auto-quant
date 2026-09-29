/**
 * 「本平台历史」榜 —— 按标的聚合**本平台自己的成交**，告诉模型它在哪些标的上
 * 真的赚过、哪些上总是亏。
 *
 * ## 为什么这个维度只有平台能做
 *
 * 交易所给的是**市场数据**（价格、成交额、持仓量、资金费）。而
 * 「**我**在这个标的上做过几笔、结果如何」是**本平台自己的历史** ——
 * 没有任何外部接口能提供它。它也是第 1 层八个维度里唯一一个"关于自己"的维度。
 *
 * ## 为什么两个方向都要给（而不是只给"胜率高的"）
 *
 * 只列"我赚过的"会让模型反复扑向同一个标的 —— 而 3 笔里 2 胜完全可能是运气。
 * 「**我在这个标的上总是亏**」同样是高价值信号：它可能意味着这个标的的波动特性
 * 与当前策略不合（例如止损总被扫），而那正是该避开的地方。
 *
 * 所以排序按净额降序，**截断时保留两端**。
 *
 * ## 为什么必须有样本量门槛
 *
 * 3 笔里 2 胜（67%）与 30 笔里 20 胜（67%）**完全不是一回事**。
 * 门槛把"噪声"挡在外面，而每行都带**笔数**，让模型自己判断可信度。
 */

/** 聚合的输入 —— 只要两个字段，便于测试与跨模块复用。 */
export interface PlatformTradeLike {
  symbol: string;
  netPnl: number;
}

export interface PlatformHistoryRow {
  symbol: string;
  /** 这个标的上平过多少笔 —— **样本量**，可信度的唯一线索。 */
  trades: number;
  netPnl: number;
  /** 胜率（0–1）。 */
  winRate: number;
}

export function rankPlatformHistory(input: {
  trades: readonly PlatformTradeLike[];
  /** 少于这个笔数的标的不入榜（样本量门槛）。 */
  minTrades: number;
  /** 最多给几行（截断时两端都保留）。 */
  limit: number;
}): PlatformHistoryRow[] {
  const bySymbol = new Map<string, { trades: number; netPnl: number; wins: number }>();
  for (const t of input.trades) {
    const cur = bySymbol.get(t.symbol) ?? { trades: 0, netPnl: 0, wins: 0 };
    cur.trades += 1;
    cur.netPnl += Number.isFinite(t.netPnl) ? t.netPnl : 0;
    if (t.netPnl > 0) cur.wins += 1;
    bySymbol.set(t.symbol, cur);
  }

  const rows: PlatformHistoryRow[] = [...bySymbol.entries()]
    .filter(([, v]) => v.trades >= input.minTrades)
    .map(([symbol, v]) => ({
      symbol,
      trades: v.trades,
      netPnl: v.netPnl,
      winRate: v.wins / v.trades,
    }))
    .sort((a, b) => b.netPnl - a.netPnl);

  if (rows.length <= input.limit) return rows;

  /*
   * ⚠️ **截断时保留两端**：头部是"我在这里赚过"，尾部是"我在这里总是亏"。
   * 只留头部会让模型看不见后者 —— 而那恰恰是最该避开的地方。
   */
  const head = Math.ceil(input.limit / 2);
  const tail = input.limit - head;
  return tail > 0 ? [...rows.slice(0, head), ...rows.slice(rows.length - tail)] : rows.slice(0, head);
}
