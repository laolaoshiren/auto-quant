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
 * 模型自己要求的"下次什么时候再看"的允许范围（分钟）。
 *
 * ## 为什么这是本轮（2026-10-02）最重要的改动
 *
 * 用户的原话：
 *
 *   「不是系统喂给 AI 什么，AI 就只能**定时定点**的去做，这不是智能，
 *     也不是 AI，这是传统机器人了。」
 *   「会像真人一样，**决定何时做什么事情**。」
 *
 * 在那之前，机器人只有一个节拍：数据库里的 `cycleIntervalMinutes`（30 分钟）。
 * 它可以在 30 分钟里等一个正在形成的突破，也可以在市场死水时被无意义地叫醒十几次 ——
 * **而"什么时候值得再看一眼"这件事，恰恰是交易判断本身的一部分。**
 *
 * 真人交易员不会这样工作：他盯着一个刚放量突破的标的时会每几分钟看一眼，
 * 而在周末横盘时会去干别的。
 *
 * ## 边界为什么是 1–120
 *
 * · **下限 1**：低于一分钟会让"盯着"退化成空转，而那会烧掉 token 与上游配额；
 * · **上限 120**：允许它说"这行情没意思，两小时后再说"，**但不允许它彻底睡过去**。
 *   一个能把自己设成"明天再看"的机器人，会在真正的机会出现时缺席 ——
 *   而"错过机会"和"乱开仓"是同一量级的失败。
 */
export const MIN_NEXT_CHECK_MINUTES = 1;
export const MAX_NEXT_CHECK_MINUTES = 120;

/**
 * 把模型给的"下一次看盘"钳进允许范围。
 *
 * 返回 `undefined` 表示"它没提这个要求"，调用方应当退回配置的周期 ——
 * 这与"它说了 1 分钟"是**不同的意图**，不能混为一谈。
 */
export function clampNextCheckMinutes(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(MAX_NEXT_CHECK_MINUTES, Math.max(MIN_NEXT_CHECK_MINUTES, raw));
}

/**
 * 计算下一次 `tick` 的延迟。
 *
 * @param failed  本轮决策是否失败（模型调用/交易所/行情任一步抛错）
 * @param cycleIntervalMinutes 数据库里当前的周期长度（AI 可以自己改）
 * @param requestedMinutes 模型这一轮自己要求的间隔（`next_check_in_minutes`）
 *
 * 规则：
 *   · **模型说了就听它的**（钳进 1–120），因为"何时再看"是它的判断；
 *   · 没说就按配置的周期；
 *   · **失败轮次取"5 分钟"与目标的较小者** —— 让它永远不把"提前"变成"推后"。
 */
export function nextCycleDelayMs(input: {
  failed: boolean;
  cycleIntervalMinutes: number;
  requestedMinutes?: number;
}): number {
  /*
   * 下限 1 分钟，且**必须先挡住 `NaN`**：
   * `Math.max(1, NaN)` 的结果是 `NaN`（不是 1），而 `setTimeout(cb, NaN)`
   * 会被当成 0 → **立刻重跑，机器人疯狂空转**。
   *
   * 调用点原来在 `try` 里做过 `Number.isFinite` 检查，抽成纯函数之后那层保护
   * 必须自己带上 —— 这条是**单元测试抓出来的**（第一版就是这么写的）。
   */
  const configured = input.cycleIntervalMinutes;
  const configuredMinutes = Number.isFinite(configured) && configured > 1 ? configured : 1;
  const requested = clampNextCheckMinutes(input.requestedMinutes);
  const targetMinutes = requested ?? configuredMinutes;
  const normalMs = targetMinutes * 60_000;
  if (!input.failed) return normalMs;
  return Math.min(FAILED_CYCLE_RETRY_MS, normalMs);
}
