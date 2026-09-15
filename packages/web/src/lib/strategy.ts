import { StrategyConfigSchema, STRATEGY_PRESETS, type StrategyConfig, type StrategyPreset } from '@aq/shared';

/** Merge a preset's patch over the current config, then let zod fill every gap. */
export function applyPreset(current: StrategyConfig, preset: StrategyPreset): StrategyConfig {
  const merged = {
    ...current,
    ...preset.patch,
    // Nested objects must be merged key by key, never replaced wholesale.
    coinSource: { ...current.coinSource, ...(preset.patch.coinSource ?? {}) },
    indicators: {
      ...current.indicators,
      ...(preset.patch.indicators ?? {}),
      kline: { ...current.indicators.kline, ...(preset.patch.indicators?.kline ?? {}) },
    },
    riskControl: { ...current.riskControl, ...(preset.patch.riskControl ?? {}) },
    drawdownGuard: { ...current.drawdownGuard, ...(preset.patch.drawdownGuard ?? {}) },
    throttle: { ...current.throttle, ...(preset.patch.throttle ?? {}) },
    circuitBreaker: { ...current.circuitBreaker, ...(preset.patch.circuitBreaker ?? {}) },
    promptSections: { ...current.promptSections, ...(preset.patch.promptSections ?? {}) },
    tradingMode: preset.tradingMode,
  };

  const parsed = StrategyConfigSchema.safeParse(merged);
  return parsed.success ? parsed.data : current;
}

export function presetById(id: string | null): StrategyPreset | undefined {
  if (!id) return undefined;
  return STRATEGY_PRESETS.find((preset) => preset.id === id);
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
