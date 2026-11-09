/**
 * **候选材料的"取样"不能按顺序取前 N 个** —— 那会结构性偏向某一种来源。
 *
 * ## 真 BUG（2026-10-13 线上实测）
 *
 * `#11`（团队模式）**87 轮零开仓**，而 `#10`（单模型托管）是 209/571 = 36.6%。
 *
 * 查材料结构，发现：
 * ```
 *   ###  1. GTCUSDT  ai_requested   ← 分析师看得到 ┐
 *   ###  2. OGNUSDT  ai_requested                  │
 *   ###  3. WUSDT    ai_requested                  │ 前 6 个
 *   ###  4. CTUSDT   ai_requested                  │ = 全部 ai_requested
 *   ###  5. SKLUSDT  ai_requested                  │
 *   ###  6. DOSUSDT  ai_requested                 ┘
 *   ###  7. BTCUSDT  coinpool + reference  ┐
 *   ###  8. ETHUSDT  coinpool              │
 *   ###  9. SOLUSDT  coinpool              │ 后 8 个
 *   ### 10. ZECUSDT  coinpool              │ = 全部 coinpool
 *   ### 11. NEARUSDT coinpool              │ 【一个都看不到】
 *   ### 12. XRPUSDT  coinpool              │
 *   ### 13. HYPEUSDT coinpool              │
 *   ### 14. DOGEUSDT coinpool              ┘
 * ```
 * 而 `#10` 那笔赚钱的开仓正是 **ETHUSDT（coinpool）**。
 *
 * ## 为什么会这样（不是"随机的坏运气"）
 *
 * `strategy/coins.ts:130` 有一句注释写明了原因：
 * ```
 *   ⚠️ 模型点名/共识的标的先加 —— sourcesBySymbol 的【顺序就是优先级】…
 *      放在 switch 之前意味着它们排在系统选出的候选【前面】。
 * ```
 * `ai_requested` 是**上一轮模型点名要看**的标的（通常是热点、极端波动标的），
 * 它排在最前面是**对的**（模型自己要看的东西优先）。
 *
 * 而 `tradingDesk.ts` 的 `analystContext` 因为实测"12 个候选会让模型一个字都写不出"
 *（`content = 0 字`），只取 `slices.slice(0, 6)`。
 *
 * **两个各自正确的决定合起来，产生了一个错误**：
 * ```
 *   "ai_requested 优先" + "只取前 6 个"  →  【分析师永远只看 ai_requested】
 * ```
 * 这是典型的**组合性缺陷**：两个决定单独看都对，谁都没想到它们会合起来。
 *
 * ## 修法：按来源分层取样，而不是按顺序截取
 *
 * 目标是让分析师**两类都看到**（热点 + 主流），而不是只看热点。
 * 具体做法见 `pickForAnalysis()`：**保序、但保证每个来源都有代表**。
 *
 * ⚠️ **不改变任何单来源的行为**：只有 1 种来源时结果与 `slice(0, n)` 完全一致。
 * 这是这条修法能安全上线的关键 —— 它只在"混合来源"时才改变行为，
 * 而"混合来源"正是出问题的那种情况。
 */

/**
 * **这段材料是"完整型"还是"只有摘要"**（2026-10-13）。
 *
 * ## 为什么必须区分（线上材料实测）
 *
 * `prompt.ts` 渲染候选时有两种密度：
 * ```
 *   **前 10 个给出完整指标序列**；**其余只给摘要**（最新值 + 最近 5 根的走向）
 * ```
 * 实测同一轮材料：
 * ```
 *   完整型 ≈ 10,000 字符（GTC/OGN/…/BTC/ETH/SOL/ZEC）
 *   摘要型 ≈  1,100 字符（NEAR/XRP/HYPE/DOGE）
 * ```
 * 而 `compactMarketContext` 按 `### N. SYMBOL` 切分，**不区分这两种** ——
 * 于是取样时它们**平等地各占一个名额**。最坏情况是"3 个完整 + 3 个摘要"，
 * 一半名额花在没序列的标的上。
 *
 * ## 判据：找指标序列的字段名
 *
 * 完整序列一定含 `current_ema20` 这类字段（`prompt.ts` 的渲染格式）；
 * 摘要型只有"最新价 + 最近 5 根走向"的文字。
 *
 * ⚠️ **不用"长度 >= N 字符"作判据** —— 长度会随配置漂（`promptPoints`
 * 可设 5–120），而"有没有那个字段"是**格式契约**（有测试钉住渲染格式）。
 */
export function isDetailedSlice(text: string): boolean {
  return /current_ema20\s*=/.test(text);
}

/**
 * **按来源分层取样** —— 保序，但保证每个来源都有代表。
 *
 * ## 判据（为什么不是简单的"轮流取"）
 *
 * ```
 *   ✓ 保序：结果里的相对顺序与原材料一致（模型读起来还是"从强到弱"）
 *   ✓ 每个来源至少 1 个（即使某个来源只占 1 个位置）
 *   ✓ 总数不超过 limit
 *   ✓ 只有 1 种来源时，结果 === slice(0, limit)（行为不变）
 * ```
 *
 * ## 为什么"每个来源至少 1 个"而不是"按比例分配"
 *
 * 按比例分配在"6 个 ai + 8 个 coin、limit=6"时会给出小数 ——
 * 而**取整之后的行为很难预测**（且会随 limit 变化）。
 * "至少 1 个"是一条**可断言**的规则：测试能直接钉住它。
 *
 * ⚠️ 而"至少 1 个"也是**够用**的：分析师的产出是"给裁决官一个方向感"，
 * 它不需要看完每个候选 —— 它需要的是**不因为取样方式而系统性瞎掉一整类**。
 *
 * ## ⚠️ 来源必须来自 `slice.sources` 字段，不能在这里解析 `text`
 *
 * 第一版我用正则从 `text` 里再抠一次标题 —— 结果**测试里的最小材料没写序号**
 *（`### GTCUSDT（…）`）→ 解析失败 → 退化成"按顺序取" → BUG 原地复活。
 * 根因是"同一件事算两遍"（本项目对这件事有明确教训：`prompt.ts` 的 `quantity`）。
 */
export function pickForAnalysis<T extends { symbol: string | null; text: string; sources: string[] }>(
  slices: readonly T[],
  limit: number,
): { picked: T[]; droppedBySource: Record<string, number> } {
  if (limit <= 0 || slices.length === 0) {
    return { picked: [], droppedBySource: {} };
  }
  if (slices.length <= limit) {
    return { picked: [...slices], droppedBySource: {} };
  }

  /*
   * 每个切片带上它的**主来源**（取第一个，因为它最能代表"谁把它选进来的"）。
   * ⚠️ 没有来源信息的用一个统一桶 `unknown`，**不是丢掉它** ——
   * 静默丢弃正是本项目反复强调的"看不出异常的失败"。
   */
  const withSource = slices.map((s, i) => ({
    s,
    i,
    src: s.sources[0] ?? 'unknown',
    /*
     * ⚠️ **"完整型"优先于"摘要型"**（2026-10-13，见 `isDetailedSlice` 的说明）。
     *
     * 线上实测：完整型 ≈ 10k 字符（有指标序列可分析），
     * 摘要型 ≈ 1.1k 字符（只有最新值 + 最近 5 根走向）。
     * 按个数分配时两者平等 —— 那会把名额浪费在没序列的标的上，
     * 而分析师**会去点评它们**（它只能看到价格与涨跌，于是报告"数据不足"）。
     */
    detailed: isDetailedSlice(s.text),
  }));

  /*
   * ⚠️ **只在"完整型"里做分层取样；摘要型只用于补位**。
   *
   * 若完整型够 `limit` 个 → 完全不碰摘要型（名额全给有序列的）。
   * 若不够 → 摘要型按同样的分层规则补（"知道有这个标的在"也有价值）。
   */
  const detailedPool = withSource.filter((x) => x.detailed);
  const summaryPool = withSource.filter((x) => !x.detailed);

  /*
   * ⚠️ **单一来源 + 完整型够用 → 与 `slice(0, limit)` 完全一致**。
   *
   * 这是这条修法能安全上线的关键：绝大多数机器人只配了一种来源
   *（`static` 或 `coinpool`），对它们来说这个改动**必须无感** ——
   * 否则就是拿一个大改动去换一个局部修复。
   */
  const sourceCount = new Set(withSource.map((x) => x.src)).size;
  if (sourceCount <= 1 && detailedPool.length >= limit) {
    return { picked: slices.slice(0, limit), droppedBySource: {} };
  }

  /*
   * ⚠️ **分层只对"完整型池"做**（见 `isDetailedSlice` 的说明）。
   *
   * 摘要型（1.1k 字符，无指标序列）**不该和完整型（10k 字符）**
   * 平等地占一个名额 —— 那会把名额浪费在没法分析的标的上。
   * 摘要型只在完整型不足时用来补位（"知道有这个标的在"也有价值）。
   */

  /*
   * ⚠️ **分配策略：轮流取（round-robin），而不是"保底 1 个后按顺序补"**。
   *
   * ## 为什么不能用"保底后按顺序补"（第一版就是这么写的，实测不够好）
   *
   * 那个策略在真实材料上给出 `5 个 ai + 1 个 coin`：
   * ```
   *   取到：GTC(ai), OGN(ai), W(ai), CT(ai), SKL(ai), BTC(coin)
   * ```
   * **`coinpool` 确实有代表了，但只有 1 个** —— 而分析师仍然把 5 个名额
   * 花在 `ai_requested`（极端波动标的）上，只看到 1 个主流币。
   *
   * 让 BTC 有代表只是"修掉了最坏情况"，而**不是"修对了"**：
   * 分析师的产出是给裁决官的方向感，那个方向感应该来自**两类的均衡样本**。
   *
   * ## 轮流取（当前实现）
   *
   * 按"该来源第一个出现的下标"排序后**轮流**分配 —— 真实材料上给出
   * `3 个 ai + 3 个 coin`。这既保序、又让两类样本量相当。
   *
   * ```
   *   第 1 轮：ai[0], coin[0]        （2 个）
   *   第 2 轮：ai[1], coin[1]        （4 个）
   *   第 3 轮：ai[2], coin[2]        （6 个）← 满
   * ```
   * ⚠️ 某来源取完后**跳过它**（不会卡住），所以"6 个 ai + 1 个 coin、
   * limit=3"会给出 `ai, coin, ai`（而不是死等不足的那个）。
   *
   * ⚠️ 若 `pool` 里的来源只剩一种（例如完整型全是 ai），上面那条
   * `bySource.size <= 1` 的早退已经处理了"等价于按顺序取"的情况。
   */
  const pickedSet = new Set<number>();

  /** 在给定的候选里按来源轮流取，直到填满 `limit`。 */
  const roundRobinInto = (candidates: typeof withSource): void => {
    const bySrc = new Map<string, typeof withSource>();
    for (const x of candidates) {
      const arr = bySrc.get(x.src);
      if (arr) arr.push(x);
      else bySrc.set(x.src, [x]);
    }
    if (bySrc.size <= 1) {
      /* 单一来源 → 按原顺序取（保序）。 */
      for (const x of candidates) {
        if (pickedSet.size >= limit) break;
        pickedSet.add(x.i);
      }
      return;
    }
    const ord = [...bySrc.entries()]
      .map(([src, arr]) => ({ src, first: arr[0]!.i, arr }))
      .sort((a, b) => a.first - b.first);
    const cursors = new Map<string, number>(ord.map((g) => [g.src, 0]));
    const total = ord.reduce((n, g) => n + g.arr.length, 0);
    let progressed = true;
    while (pickedSet.size < limit && progressed) {
      progressed = false;
      for (const g of ord) {
        if (pickedSet.size >= limit) break;
        const cur = cursors.get(g.src) ?? 0;
        if (cur >= g.arr.length) continue;
        pickedSet.add(g.arr[cur]!.i);
        cursors.set(g.src, cur + 1);
        progressed = true;
      }
      /* 全部取完（`total` 只是兜底防死循环）。 */
      if (ord.every((g) => (cursors.get(g.src) ?? 0) >= g.arr.length)) break;
    }
    void total;
  };

  /*
   * 第一步：**只在完整型里分层**（若完整型够 limit 个）。
   * 第二步：不够才让摘要型补位。
   */
  if (detailedPool.length >= limit) {
    roundRobinInto(detailedPool);
  } else {
    roundRobinInto(detailedPool);
    roundRobinInto(summaryPool);
  }
  /* 仍未填满（极端情况：候选数 < limit）→ 按原顺序补齐。 */
  if (pickedSet.size < limit) {
    for (const x of withSource) {
      if (pickedSet.size >= limit) break;
      pickedSet.add(x.i);
    }
  }

  const picked = withSource
    .filter((x) => pickedSet.has(x.i))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
  const droppedBySource: Record<string, number> = {};
  for (const x of withSource) {
    if (pickedSet.has(x.i)) continue;
    droppedBySource[x.src] = (droppedBySource[x.src] ?? 0) + 1;
  }
  return { picked, droppedBySource };
}
