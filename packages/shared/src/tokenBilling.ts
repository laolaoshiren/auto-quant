/**
 * LLM Token 计费估算与格式化模块（前后端共享，单一真相来源）。
 *
 * ⚠️ 口径纪律：
 * - 所有金额单位为 **USD**（单价为 **USD / 每百万 token**）；
 * - 这是模型调用侧的 **Token 估算费用**，与交易所实盘成交盈亏/手续费完全隔离，
 *   绝不混入账户权益或 `trades` 账本。
 */

export interface TokenPricingPerMillion {
  /** 未命中缓存输入单价（USD / 1M tokens）。 */
  input: number;
  /** 缓存命中输入单价（USD / 1M tokens）。 */
  cacheRead: number;
  /** 输出单价（USD / 1M tokens；含思考 token）。 */
  output: number;
  /** 单价来源说明（例如 `models.dev (deepseek-v4.1-flash)` 或 `内置参考价`）。 */
  source: string;
  /** 是否为免费渠道（如 `*-free` 模型）。 */
  free?: boolean;
}

export interface TokenUsageCounts {
  promptTokens: number | null | undefined;
  completionTokens: number | null | undefined;
  cachedTokens?: number | null | undefined;
  reasoningTokens?: number | null | undefined;
}

export interface TokenCostBreakdown {
  promptTokens: number;
  cachedTokens: number;
  uncachedInputTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  inputCostUsd: number;
  cacheCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  /** 相对全部按未缓存输入计价，本次缓存命中省下的费用（USD）。 */
  savedByCacheUsd: number;
}

export interface TraderTokenBillingSummary {
  traderId: number;
  model: string;
  pricing: TokenPricingPerMillion | null;
  /** 全量已记录决策周期数。 */
  totalCycles: number;
  /** 有回传 token 用量的周期数。 */
  meteredCycles: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** 全量累计估算费用（USD）；无定价时为 `null`。 */
  totalCostUsd: number | null;
  /** 缓存命中累计省下的费用（USD）；无定价时为 `null`。 */
  savedByCacheUsd: number | null;
  /** 今日（北京时间 00:00 起）决策轮次。 */
  todayCycles: number;
  todayPromptTokens: number;
  todayCachedTokens: number;
  todayCompletionTokens: number;
  /** 今日（北京时间 00:00 起）累计估算费用（USD）；无定价时为 `null`。 */
  todayCostUsd: number | null;
}

const ONE_MILLION = 1_000_000;

function nonNegInt(v: number | null | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.round(v);
}

/** 计算单轮或累计 token 用量的精确费用明细（USD）。 */
export function calculateTokenCost(
  usage: TokenUsageCounts,
  pricing: TokenPricingPerMillion,
): TokenCostBreakdown {
  const promptTokens = nonNegInt(usage.promptTokens);
  const completionTokens = nonNegInt(usage.completionTokens);
  const cachedTokens = Math.min(promptTokens, nonNegInt(usage.cachedTokens));
  const uncachedInputTokens = Math.max(0, promptTokens - cachedTokens);
  const reasoningTokens = Math.min(completionTokens, nonNegInt(usage.reasoningTokens));

  const inputRate = Math.max(0, Number.isFinite(pricing.input) ? pricing.input : 0);
  const cacheRate = Math.max(0, Number.isFinite(pricing.cacheRead) ? pricing.cacheRead : inputRate);
  const outputRate = Math.max(0, Number.isFinite(pricing.output) ? pricing.output : 0);

  const inputCostUsd = (uncachedInputTokens / ONE_MILLION) * inputRate;
  const cacheCostUsd = (cachedTokens / ONE_MILLION) * cacheRate;
  const outputCostUsd = (completionTokens / ONE_MILLION) * outputRate;
  const totalCostUsd = inputCostUsd + cacheCostUsd + outputCostUsd;
  const savedByCacheUsd = (cachedTokens / ONE_MILLION) * Math.max(0, inputRate - cacheRate);

  return {
    promptTokens,
    cachedTokens,
    uncachedInputTokens,
    completionTokens,
    reasoningTokens,
    inputCostUsd,
    cacheCostUsd,
    outputCostUsd,
    totalCostUsd,
    savedByCacheUsd,
  };
}

interface FallbackRateRule {
  pattern: RegExp;
  label: string;
  input: number;
  cacheRead: number;
  output: number;
  free?: boolean;
}

/**
 * 仅在 `models.dev` 运行时目录未命中时的兜底参考价（USD / 1M tokens）。
 * 优先由服务端读取 `models.dev` 动态快照定价，避免写死过期。
 */
const FALLBACK_RATE_RULES: readonly FallbackRateRule[] = [
  { pattern: /(?:^|[-/])free(?:$|[-/])/i, label: '免费渠道', input: 0, cacheRead: 0, output: 0, free: true },
  { pattern: /deepseek[-_.]?(?:v4(?:\.\d+)?[-_.]?flash|flash)/i, label: 'DeepSeek Flash', input: 0.15, cacheRead: 0.003, output: 0.6 },
  { pattern: /deepseek[-_.]?(?:v4[-_.]?pro|reasoner|r1)/i, label: 'DeepSeek Pro/R1', input: 0.55, cacheRead: 0.14, output: 2.19 },
  { pattern: /deepseek[-_.]?(?:chat|v3)/i, label: 'DeepSeek Chat', input: 0.27, cacheRead: 0.07, output: 1.1 },
  { pattern: /gpt[-_.]?5[-_.]?mini/i, label: 'GPT-5 Mini', input: 0.25, cacheRead: 0.025, output: 2.0 },
  { pattern: /gpt[-_.]?5/i, label: 'GPT-5', input: 1.25, cacheRead: 0.125, output: 10.0 },
  { pattern: /gpt[-_.]?4\.1[-_.]?mini/i, label: 'GPT-4.1 Mini', input: 0.4, cacheRead: 0.1, output: 1.6 },
  { pattern: /gpt[-_.]?4\.1/i, label: 'GPT-4.1', input: 2.0, cacheRead: 0.5, output: 8.0 },
  { pattern: /gpt[-_.]?4o[-_.]?mini/i, label: 'GPT-4o Mini', input: 0.15, cacheRead: 0.075, output: 0.6 },
  { pattern: /gpt[-_.]?4o/i, label: 'GPT-4o', input: 2.5, cacheRead: 1.25, output: 10.0 },
  { pattern: /claude[-_.]?(?:3\.5|3\.7|4(?:\.\d+)?)[-_.]?haiku|haiku/i, label: 'Claude Haiku', input: 0.8, cacheRead: 0.08, output: 4.0 },
  { pattern: /claude[-_.]?(?:3\.5|3\.7|4(?:\.\d+)?)[-_.]?opus|opus/i, label: 'Claude Opus', input: 15.0, cacheRead: 1.5, output: 75.0 },
  { pattern: /claude[-_.]?(?:3\.5|3\.7|4(?:\.\d+)?)[-_.]?sonnet|sonnet/i, label: 'Claude Sonnet', input: 3.0, cacheRead: 0.3, output: 15.0 },
  { pattern: /gemini[-_.]?2\.5[-_.]?flash|gemini.*flash/i, label: 'Gemini Flash', input: 0.15, cacheRead: 0.0375, output: 0.6 },
  { pattern: /gemini[-_.]?2\.5[-_.]?pro|gemini.*pro/i, label: 'Gemini Pro', input: 1.25, cacheRead: 0.31, output: 10.0 },
  { pattern: /qwen3.*flash|qwen.*turbo/i, label: 'Qwen Flash', input: 0.05, cacheRead: 0.01, output: 0.4 },
  { pattern: /qwen/i, label: 'Qwen', input: 0.4, cacheRead: 0.1, output: 1.2 },
];

/** 按模型名查兜底参考单价；识别不出时返回 `null`（宁可显示未知也不编造）。 */
export function resolveFallbackTokenPricing(modelName: string | null | undefined): TokenPricingPerMillion | null {
  const raw = (modelName ?? '').trim();
  if (!raw) return null;
  for (const rule of FALLBACK_RATE_RULES) {
    if (rule.pattern.test(raw)) {
      return {
        input: rule.input,
        cacheRead: rule.cacheRead,
        output: rule.output,
        source: `内置参考价 (${rule.label})`,
        ...(rule.free ? { free: true } : {}),
      };
    }
  }
  return null;
}

/** 格式化美元计费金额：小额保留 4 位避免单轮显示成 $0.00，大额保留 2–3 位。 */
export function fmtTokenCostUsd(
  usd: number | null | undefined,
  options?: { approx?: boolean },
): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—';
  const prefix = options?.approx ? '~$' : '$';
  if (usd <= 0) return '$0.00';
  if (usd < 0.0001) return `<${prefix}0.0001`;
  if (usd < 0.1) return `${prefix}${usd.toFixed(4)}`;
  if (usd < 1) return `${prefix}${usd.toFixed(3)}`;
  return `${prefix}${usd.toFixed(2)}`;
}

/** 紧凑格式化百万/千级 token 数（如 `39.7K`、`5.24M`）。 */
export function fmtCompactTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count) || count <= 0) return '0';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(Math.round(count));
}

function fmtRate(rate: number): string {
  if (rate <= 0) return '$0';
  if (rate < 0.01) return `$${rate.toFixed(4)}`;
  if (rate < 0.1) return `$${rate.toFixed(3)}`;
  return `$${Number(rate.toFixed(2))}`;
}

/** 生成单轮计费胶囊的详细悬停公式说明。 */
export function formatCycleCostTooltip(
  breakdown: TokenCostBreakdown,
  pricing: TokenPricingPerMillion,
): string {
  if (pricing.free || (pricing.input === 0 && pricing.output === 0)) {
    return `本轮模型为免费通道（${pricing.source}），估算费用 $0.00`;
  }
  const lines = [
    `本轮 Token 估算费用：${fmtTokenCostUsd(breakdown.totalCostUsd)}（不计入实盘交易盈亏）`,
    `· 未缓存输入：${breakdown.uncachedInputTokens.toLocaleString('en-US')} × ${fmtRate(pricing.input)}/1M = ${fmtTokenCostUsd(breakdown.inputCostUsd)}`,
  ];
  if (breakdown.cachedTokens > 0) {
    lines.push(
      `· 缓存命中：${breakdown.cachedTokens.toLocaleString('en-US')} × ${fmtRate(pricing.cacheRead)}/1M = ${fmtTokenCostUsd(breakdown.cacheCostUsd)}（缓存省 ${fmtTokenCostUsd(breakdown.savedByCacheUsd)}）`,
    );
  }
  lines.push(
    `· 输出${breakdown.reasoningTokens > 0 ? '（含思考）' : ''}：${breakdown.completionTokens.toLocaleString('en-US')} × ${fmtRate(pricing.output)}/1M = ${fmtTokenCostUsd(breakdown.outputCostUsd)}`,
    `· 单价来源：${pricing.source}`,
  );
  return lines.join('\n');
}
