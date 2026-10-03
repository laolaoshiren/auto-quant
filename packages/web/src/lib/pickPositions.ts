/**
 * **"现在交易所那边有什么" 这个问题的唯一答案来源。**
 *
 * ## 为什么需要一个单独的函数（2026-10-04 的幽灵持仓事故）
 *
 * 页面上有**两个地方**要回答"当前持仓是什么"：
 *
 *   · `TraderPage` —— 顶部卡片与「当前持仓 N」标签的计数；
 *   · `PositionsTable` —— 那张表本身的行。
 *
 * 它们原先各写一遍取值顺序，而且**顺序相反**：
 *
 * ```ts
 * // TraderPage（对）
 * const positions = accountView?.positions ?? live?.positions ?? [];
 * // PositionsTable（错）
 * const positions = live ?? query.data ?? [];
 * ```
 *
 * 后果用户当场看到了：
 *
 * > 「当前持仓这两笔，我都手动点了平仓（页面显示成功）但是我刷新页面后持仓又出现，
 * >  又点击平仓后提示"本地没有 DOGEUSDT 的持仓"」
 *
 * 那两笔在更早的时候（`trades.close_reason = 'manual'`）就真的平掉了，
 * 交易所是空仓。可 **WebSocket 镜像在机器人停止后永远停在最后一刻**，
 * 而反过来的顺序让它**盖过了实时查询** —— 于是「当前持仓 0」旁边摆着两行仓位。
 *
 * 用户以为系统留有裸仓、还去手动平了一个不存在的仓。
 *
 * ## 所以规则只有一条，写在这里，两处都调它
 *
 * **实时结果优先；它没到时才用镜像。**
 *
 * 关键在"没到"的判据是 `undefined`，**不是"空"** ——
 * **空数组是一个结论**（`[]` = 交易所确实没有持仓），而 `undefined` 只是"还没问到"。
 * `??` 正是这个语义；写成 `|| []` 或者给镜像更高优先级都会把结论当成"没数据"。
 */
export function pickPositions<T>(
  /** 实时查询的结果：`undefined`/`null` 表示**还没问到**，`[]` 表示"确实空仓"。 */
  live: T[] | null | undefined,
  /** WebSocket 推送的本地镜像：机器人停止后它**永远停在最后一刻**。 */
  mirror: T[] | null | undefined,
): T[] {
  return live ?? mirror ?? [];
}
