/**
 * 「共识标的」—— 多个榜同时指向的那个，比只在一个榜里的更值得深看。
 *
 * ## 为什么需要它
 *
 * 第 1 层给出各维度的头部，但**每个榜是独立的**：5-8 个榜 × 每个榜 8 个标的
 * = 几十个名字。而深潜层（完整多周期行情）只能放下 15-20 个。
 *
 * 那么该给谁完整行情？**多个榜同时指向的那个** —— 一个标的既在涨幅榜又在波动率榜，
 * 说明它"涨得多**且**在剧烈波动"，那比只在成交额榜里出现（大盘币人人都能上）
 * 更值得看。
 *
 * ## ⚠️ 它只是"共振度"，不是"推荐"
 *
 * 计数高**不等于该做**。系统在这里的职责是**排序**，不是**筛选**：
 * 单榜标的排在后面，但仍在名单里 —— 把"哪些不值得看"也替模型决定，
 * 正是这一轮要修的病（用户原则：**模型是大脑，系统只是手脚**）。
 */

/** 一个榜：标签 + 它列出的符号（顺序有意义，见 `rankConsensus` 的同分规则）。 */
export interface ConsensusBoard {
  label: string;
  symbols: readonly string[];
}

export interface ConsensusRow {
  symbol: string;
  /** 出现在几个榜里 —— **共振度**。 */
  boards: number;
  /** 出现在哪些榜（给模型看依据，它据此判断这个共振意味着什么）。 */
  labels: string[];
}

/**
 * 按"出现在几个榜里"排序。
 *
 * **同分时保持第一次出现的顺序**：调用方按"成交额榜在前"组织 `boards`，
 * 于是同分时"更做得动"的那个排前面 —— 那不是随机的次序。
 */
export function rankConsensus(input: {
  boards: readonly ConsensusBoard[];
  limit: number;
}): ConsensusRow[] {
  const bySymbol = new Map<string, ConsensusRow>();
  /* 用"首次出现序号"记录同分时的次序。 */
  const order = new Map<string, number>();
  let seq = 0;

  for (const board of input.boards) {
    const seenInBoard = new Set<string>();
    for (const raw of board.symbols) {
      const symbol = String(raw ?? '').trim().toUpperCase();
      if (!symbol) continue;
      /* 同一个榜里的重复不该被数两次 —— 它表达的仍然只是"这个榜提到了它"。 */
      if (seenInBoard.has(symbol)) continue;
      seenInBoard.add(symbol);

      const existing = bySymbol.get(symbol);
      if (existing) {
        existing.boards += 1;
        existing.labels.push(board.label);
        continue;
      }
      bySymbol.set(symbol, { symbol, boards: 1, labels: [board.label] });
      order.set(symbol, seq);
      seq += 1;
    }
  }

  const rows = [...bySymbol.values()].sort((a, b) => {
    if (b.boards !== a.boards) return b.boards - a.boards;
    return (order.get(a.symbol) ?? 0) - (order.get(b.symbol) ?? 0);
  });

  return input.limit >= rows.length ? rows : rows.slice(0, Math.max(0, input.limit));
}
