/**
 * 下一轮决策什么时候跑。
 *
 * ## 为什么单独一个纯函数
 *
 * 这个数直接喂给 `setTimeout`。算错的两种方式都不报错、只是**行为诡异**：
 *
 *   · `NaN` / 负数 → `setTimeout` 当成 0 → **立刻重跑**，机器人疯狂空转；
 *   · 忘了"失败时的例外" → 上游抖动几分钟，**代价是一整个周期**。
 *
 * 抽出来之后，这两种都能被穷举测试（§5.4：导出的纯函数优先于需要打桩的对象）。
 */

/**
 * 模型调用失败后的重试间隔（5 分钟）。
 *
 * ⚠️ **这不是"退避"。** 退避是"失败了就慢下来"，会让一次抖动之后更久才恢复；
 * 这里是相反的取向：**把它当成"上游几分钟就会回来"，早一点再问一次。**
 *
 * 实测依据（2026-10-01）：上游偶发 5xx 让 `#1775`、`#1776` 连续两轮失败
 * （同轮内的 2 次重试都撞上同一段窗口），而 `#1777` 在下一轮就成功了 ——
 * **上游恢复得很快，而系统让它等满了 30 分钟。**
 */
export const FAILED_CYCLE_RETRY_MS = 5 * 60_000;

/**
 * 计算下一次 `tick` 的延迟。
 *
 * @param failed  本轮决策是否失败（模型调用/交易所/行情任一步抛错）
 * @param cycleIntervalMinutes 数据库里当前的周期长度（AI 可以自己改）
 *
 * 规则：**正常轮次按周期走；失败轮次取"5 分钟"与"周期"的较小者。**
 * 取较小者是为了让"提前"永远不变成"推后" —— 一个周期设成 2 分钟的机器人
 * 不该因为一次失败而被拖到 5 分钟。
 */
export function nextCycleDelayMs(input: {
  failed: boolean;
  cycleIntervalMinutes: number;
}): number {
  /*
   * 下限 1 分钟，且**必须先挡住 `NaN`**：
   * `Math.max(1, NaN)` 的结果是 `NaN`（不是 1），而 `setTimeout(cb, NaN)`
   * 会被当成 0 → **立刻重跑，机器人疯狂空转**。
   *
   * 调用点原来在 `try` 里做过 `Number.isFinite` 检查，抽成纯函数之后那层保护
   * 必须自己带上 —— 这条是**单元测试抓出来的**（第一版就是这么写的）。
   */
  const raw = input.cycleIntervalMinutes;
  const minutes = Number.isFinite(raw) && raw > 1 ? raw : 1;
  const normalMs = minutes * 60_000;
  if (!input.failed) return normalMs;
  return Math.min(FAILED_CYCLE_RETRY_MS, normalMs);
}
