import {
  STRATEGY_PRESETS,
  StrategyConfigSchema,
  presetOfConfig,
  type StrategyConfig,
  type StrategyPreset,
} from '@aq/shared';

/** 按 id 取预设（控制台的 `<select>` 只拿得到 id）。 */
export function presetById(id: string | null): StrategyPreset | undefined {
  if (!id) return undefined;
  return STRATEGY_PRESETS.find((preset) => preset.id === id);
}

/**
 * ⚠️ **这里曾经导出一个 `applyPreset(current, preset)`，已删除。**
 *
 * 它是本缺陷的载体：签名逼调用方交出一份"当前配置"，而那正是"以草稿为底叠 patch"
 * 的语义 —— 未在 `patch` 里声明的字段于是继承上一份预设（`indicators` /
 * `drawdownGuard` 三套预设声明得不一样），而提示词与徽章都按新预设渲染。
 * `safeParse` 失败时它还静默 `return current`，调用方照样弹「已应用到草稿」。
 *
 * 现在两个入口（编辑器、策略列表的"从预设新建"）都直接调共享包的
 * `resolvePreset(preset)`：**它根本不接受"当前配置"** ——
 * 这是"上游缺陷不可能再犯"的那种修法，比"记得不要传"可靠。
 *
 * ⇒ **本文件不再 import / 引用 `resolvePreset`**（它只属于两个调用点）。
 * 这里保留这段文字是因为 `presetWiring.test.ts` 的守卫要求"不得再导出 applyPreset"，
 * 而那句断言的前提是守卫确实盯在 lib/strategy.ts 上 —— 见那个测试里的注记。
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
