/**
 * **候选链的"死 id"过滤器** —— 让手工维护的模型链不再悄悄腐烂。
 *
 * ## 为什么需要它（2026-10-18 实测）
 *
 * `routedModel.ts` 的 T1/T2/T3 候选链是**手工维护的字符串数组**。文件开头自己写着：
 *
 * > 「链上的 id 会失效，而不会有任何测试因此变红」
 *
 * 实测就打脸了：
 * ```
 *   线上网关（172.19.0.1:3425）329 个模型里：
 *     group/auto-space-bunny-free   → 查无此项（现名 group/auto-space-bunny）
 *   而 T1_LADDER / T2_LADDER 各有一条它 ⇒ 每轮都要先撞一次 404 才轮到下一个候选。
 * ```
 *
 * ## 为什么不是"全自动发现"（那样更省事）
 *
 * 候选链里不只有"能用的模型"，还**承载了实测出来的排序与禁用判断**
 * （哪些快、哪些输出契约稳、哪些有 180s 超时问题）。那些是**人的判断**，
 * 不能从 `/v1/models` 推出来。
 *
 * ⇒ 所以做法是：**人保留判断，机器去掉死 id**。
 *   链还是人写的，但每次启动用网关的真实清单过滤一遍，并**把被过滤的写进日志**。
 *
 * ## 安全边界
 *
 * - **拿不到清单就原样返回**（不筛）—— 判据是"非空数组"，空数组/`null` 一律视为"没拿到"。
 * - **一个都不剩时也原样返回** —— 宁可用可能失效的链，也不能让机器人没有候选。
 *   那不是"更干净"，那是把整个团队打瘸。
 */

/**
 * 用网关的真实模型清单过滤候选链。
 *
 * @param ladder 手工维护的候选链（顺序即优先级）
 * @param available 网关 `/v1/models` 报出的全部 id；`null`/空数组 = 没拿到
 * @returns 过滤后的链，与"被丢掉的那些"（供调用方写日志）
 */
export function resolveLadder(
  ladder: readonly string[],
  available: readonly string[] | null | undefined,
): { ladder: readonly string[]; dropped: readonly string[] } {
  /* 没拿到清单 → 原样返回（不筛）。这是最保守的一条。 */
  if (available === null || available === undefined || available.length === 0) {
    return { ladder, dropped: [] };
  }

  const known = new Set(available);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const id of ladder) {
    if (known.has(id)) kept.push(id);
    else dropped.push(id);
  }

  /*
   * ⚠️ **一个都不剩时原样返回**。
   *
   * 这看起来像"没筛成"，但它是唯一正确的选择：如果 `/v1/models` 只返回了一页
   * （magpie 的响应里有 `has_more`）、或者组名整体改了，全筛掉会让机器人
   * **完全没有候选模型** —— 那比"撞几次 404"严重得多。
   */
  if (kept.length === 0) {
    return { ladder, dropped: [] };
  }

  return { ladder: kept, dropped };
}

/**
 * 整张 `ROLE_GROUP_LADDERS` 一起过滤。
 *
 * 返回里 `droppedByRole` 只包含**真的有东西被筛掉**的角色，方便调用方只打有意义的日志。
 */
export function resolveAllLadders<K extends string>(
  ladders: Readonly<Record<K, readonly string[]>>,
  available: readonly string[] | null | undefined,
): { ladders: Record<K, readonly string[]>; droppedByRole: Array<{ role: K; dropped: readonly string[] }> } {
  const out = {} as Record<K, readonly string[]>;
  const droppedByRole: Array<{ role: K; dropped: readonly string[] }> = [];
  for (const role of Object.keys(ladders) as K[]) {
    const r = resolveLadder(ladders[role], available);
    out[role] = r.ladder;
    if (r.dropped.length > 0) droppedByRole.push({ role, dropped: r.dropped });
  }
  return { ladders: out, droppedByRole };
}
