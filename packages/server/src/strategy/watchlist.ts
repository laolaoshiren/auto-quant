/**
 * 模型的「点名清单」—— 它说"下一轮把这几个给我完整行情"，系统照办。
 *
 * ## 这一层解决什么（用户 2026-09-30 的原话）
 *
 * > 「**模型是大脑，系统只是他的手脚**」
 *
 * 第 0/1 层让它**看见**市场，`screen_symbols` 让它**自己筛**。
 * 而筛出来之后，它还得能说"下一轮我要看这几个" —— 那就是这份清单。
 *
 * **没有它，上一轮的发现当场作废**：模型每一轮都从零开始看那 15-20 个
 * 系统选的候选，它自己筛出来的东西下一轮就不见了。那正是"系统替它决定看什么"。
 *
 * ## 三个设计决定
 *
 * 1. **去重并续期**：它很可能连续几轮点同一个标的（"我还在盯它"）。
 *    每次都追加一行会让清单迅速膨胀，而它表达的意思只是"继续看着"。
 * 2. **TTL 递减**：临时的兴趣不该变成永久候选，所以每过一轮减一、到零移除。
 *    用递减而不是"用完即清"，是因为它连续几轮看同一个标的是常态。
 * 3. **上限由系统把关**：它可能一次点名 30 个，那会把提示词预算挤爆。
 *    **要哪些由它定，最多留几个由系统定** —— 这就是"手脚"该守的那条线。
 */

/** 清单里的一项。 */
export interface WatchlistEntry {
  symbol: string;
  /** 还剩几轮有效；到 0 即移除。 */
  remaining: number;
  /** 它当时为什么想盯这个（回喂提示词时能提醒它）。 */
  reason?: string;
}

/** 把符号规范化：大写、去空白；明显无效的返回空串。 */
function normalize(symbol: string): string {
  return String(symbol ?? '').trim().toUpperCase();
}

/**
 * 把模型点名的标的加进清单。
 *
 * 已有的**续期**（而不是再添一行）；装满时**挤掉最旧的**（末尾那些），
 * 因为新点名的才是它这一轮的意思。
 */
export function addToWatchlist(input: {
  current: readonly WatchlistEntry[];
  symbols: readonly string[];
  reason?: string;
  ttlRounds: number;
  maxSize: number;
}): WatchlistEntry[] {
  const ttl = Math.max(1, Math.floor(input.ttlRounds));
  const max = Math.max(1, Math.floor(input.maxSize));

  /* 先按现有顺序保留（去掉无效项）—— 续期的也在这一类。 */
  const kept: WatchlistEntry[] = input.current
    .map((r) => ({ ...r, symbol: normalize(r.symbol) }))
    .filter((r) => r.symbol.length > 0 && r.remaining > 0);

  /* 这一轮**新点名**的（不在清单里的）。 */
  const fresh: WatchlistEntry[] = [];
  for (const raw of input.symbols) {
    const symbol = normalize(raw);
    if (!symbol) continue;
    const existing = kept.find((r) => r.symbol === symbol);
    if (existing) {
      /* 续期：它这一轮又点了，说明还在关注。 */
      existing.remaining = ttl;
      if (input.reason) existing.reason = input.reason;
      continue;
    }
    if (fresh.some((r) => r.symbol === symbol)) continue;
    fresh.push(
      input.reason ? { symbol, remaining: ttl, reason: input.reason } : { symbol, remaining: ttl },
    );
  }

  /*
   * 名额分配（顺序很重要）：
   *
   * 1. **这一轮新点名的优先保位** —— 那是它**此刻**的意思；装不下时按它给的顺序
   *    收前几个（尊重它说的先后），而不是留最后几个。
   * 2. **剩下的名额给已有的**，按"最新的优先"（数组尾部更新），于是被挤掉的
   *    总是**最旧**的那些。
   */
  const freshCapped = fresh.slice(0, max);
  const room = max - freshCapped.length;
  const keptTrimmed = room > 0 ? kept.slice(Math.max(0, kept.length - room)) : [];
  return [...keptTrimmed, ...freshCapped];
}

/** 每过一轮调用一次：到期的移除，其余减一。 */
export function decayWatchlist(current: readonly WatchlistEntry[]): WatchlistEntry[] {
  return current
    .map((r) => ({ ...r, remaining: r.remaining - 1 }))
    .filter((r) => r.remaining > 0);
}

/** 清单里的符号（给候选池/提示词用）。 */
export function watchlistSymbols(current: readonly WatchlistEntry[]): string[] {
  return current.filter((r) => r.remaining > 0).map((r) => r.symbol);
}
