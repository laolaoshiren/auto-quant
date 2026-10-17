import {
  STRATEGY_PRESETS,
  StrategyConfigSchema,
  presetOfConfig,
  resolvePreset,
  type StrategyConfig,
  type StrategyPreset,
} from '@aq/shared';

/** 按 id 取预设（控制台的 `<select>` 只拿得到 id）。 */
export function presetById(id: string | null): StrategyPreset | undefined {
  if (!id) return undefined;
  return STRATEGY_PRESETS.find((preset) => preset.id === id);
}

/**
 * 套上一份预设 —— **得到的就是这份预设的完整定义**。
 *
 * ## ⚠️ 这里原来做的事，与调用方以为它做的事不是一回事
 *
 * 旧实现（已删）是拿**当前草稿**当底再叠预设的 `patch`：
 *
 * ```ts
 * const merged = { ...current, ...preset.patch, coinSource: { ...current.coinSource, … } };
 * return StrategyConfigSchema.safeParse(merged).success ? parsed.data : current;
 * ```
 *
 * 它有两个静默失效点，而且**都在真实路径上**：
 *
 * 1. **未在 `patch` 里出现的字段继承上一份预设**（`{ ...current }` 就是那个继承）。
 *    三套预设声明的字段集合不同（只有 `scalping` 声明 `indicators` 与
 *    `drawdownGuard`；只有 `conservative` 声明 `breakevenTriggerPercent`），
 *    于是「短线 → 稳健」得到的是**稳健的提示词 + 短线的回撤守卫与指标**
 *    ——而徽章、提示词、参数三处互相矛盾（详见 `resolvePreset()` 的注释）。
 * 2. **`safeParse` 失败时 `return current`** —— 草稿一个字都不变，
 *    而调用方照样弹「已将预设应用到草稿」。用户看不到任何异常。
 *    现在解析失败**抛错**（见 `resolvePreset()`），由调用方显示真实原因。
 *
 * ## 现在的语义（唯一实现）
 *
 * 真正干活的算法在 `packages/shared/src/strategy.ts` 的 `resolvePreset()` ——
 * 放在共享包里是因为它是**跨端契约**（控制台与任何脚本套预设必须得到同一份配置），
 * 而"两处各实现一遍"正是本仓库反复付代价的形状。
 *
 * `current` 参数**保留但不再参与计算**：两个调用点都传它，而"套模板"这件事
 * 与新配置无关（这是本修复的要点）。保留签名是为了不改动调用方；
 * 它的存在本身就是那条误导性契约的遗迹，所以在这里显式写明它现在是空的。
 *
 * @deprecated 新代码请直接用 `resolvePreset(preset)`；保留这个名字只为迁移期兼容。
 */
/**
 * ⚠️ **这里曾经导出一个 `applyPreset(current, preset)`，已删除。**
 *
 * 它是本缺陷的载体：签名逼调用方交出一份"当前配置"，而那正是"以草稿为底叠 patch"
 * 的语义 —— 未在 `patch` 里声明的字段于是继承上一份预设（`indicators` /
 * `drawdownGuard` 三套预设声明得不一样），而提示词与徽章都按新预设渲染。
 *
 * 现在两个入口（编辑器、策略列表的"从预设新建"）都直接调共享包的
 * `resolvePreset(preset)`：**它根本不接受"当前配置"** ——
 * 这是"上游缺陷不可能再犯"的那种修法，比"记得不要传"可靠。
 *
 * ⚠️ **删掉它的直接后果**：`presetApply.test.ts` / `presetWiring.test.ts` 里
 * 那几条"`applyPreset` 必须等于 `resolvePreset`"的守卫随实现一起消失了。
 * 它们不是被删掉，而是**不再必要** —— 那两个函数都不存在了。
 * 剩下的守卫盯的是新路径（`resolvePreset` / `presetOfConfig` / 两个入口的接线）。
 */

/**
 * 当前草稿**还等于**哪一份预设（不等于任何一份时返回 `null`）。
 *
 * 界面用它决定徽章敢不敢写「预设：稳健」—— 判据是**配置本身**，不是那个会过期的
 * `presetId` 字段（`strategies.preset_id` 只记录"从哪份模板克隆来的"，
 * 而 `PATCH /api/strategies/:id` 根本不收它：`api/server.ts:1662-1667`）。
 */
export function activePreset(config: StrategyConfig): StrategyPreset | null {
  return presetOfConfig(config);
}

export interface ValidationResult {
  ok: boolean;
  config: StrategyConfig | null;
  /** `path.to.field` → first message. */
  errors: Record<string, string>;
}

/**
 * Validate a draft against the shared schema before it is sent to the server.
 * Errors are flattened to dotted paths so each field can render its own message.
 */
export function validateStrategy(draft: unknown): ValidationResult {
  const parsed = StrategyConfigSchema.safeParse(draft);
  if (parsed.success) return { ok: true, config: parsed.data, errors: {} };

  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.');
    if (!(path in errors)) errors[path] = issue.message;
  }
  return { ok: false, config: null, errors };
}

/** Deep clone that keeps the draft independent from the loaded record. */
export function cloneConfig(config: StrategyConfig): StrategyConfig {
  return JSON.parse(JSON.stringify(config)) as StrategyConfig;
}
