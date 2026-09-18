import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Decision — the exact contract the language model must speak                 */
/* -------------------------------------------------------------------------- */

export const DecisionActionSchema = z.enum([
  'open_long',
  'open_short',
  'close_long',
  'close_short',
  /*
   * 移动止损 / 改止盈 —— **对一个已有持仓调整保护位**。
   *
   * ## 为什么必须有这个动作
   *
   * 原来只有"开"和"平"：止损止盈在开仓那一刻定死，之后**只有代码里那个
   * 固定阈值的回撤守卫能动它**。于是：
   *
   *   · 一笔已经涨了很多的仓位，止损还停在最初那个位置
   *   · 保本止损的阈值写死在配置里（实测 8%，而观测到的峰值只有 1.5–2.7%），
   *     **从来没触发过**
   *   · AI 在推理里看得出"这笔该把止损提上来"，**却没有动作可以表达**
   *
   * 用户的原话是「没有动态加仓、减仓、调整」——**这是"调整"那一半**。
   *
   * 它比加减仓更小：不改变持仓数量，只改两张保护单的价格，
   * 所以不涉及均价与部分平仓的账目问题。
   */
  'adjust_protection',
  'hold',
  'wait',
]);
export type DecisionAction = z.infer<typeof DecisionActionSchema>;

export const OPEN_ACTIONS: readonly DecisionAction[] = ['open_long', 'open_short'];
export const CLOSE_ACTIONS: readonly DecisionAction[] = ['close_long', 'close_short'];
export const ADJUST_ACTIONS: readonly DecisionAction[] = ['adjust_protection'];

export function isOpenAction(a: DecisionAction): boolean {
  return a === 'open_long' || a === 'open_short';
}
export function isCloseAction(a: DecisionAction): boolean {
  return a === 'close_long' || a === 'close_short';
}
/**
 * 调整已有持仓的保护位（不改数量）。
 *
 * 单独一个谓词的必要性：风控引擎与执行层都是
 * `if (isCloseAction) … else if (isOpenAction) … else 当成 no-op`，
 * **没有这个谓词的话，新动作会被静默当成"什么都不做"** ——
 * 模型以为它调了止损，而系统当作没看见。
 */
export function isAdjustAction(a: DecisionAction): boolean {
  return a === 'adjust_protection';
}

/** The raw decision object as emitted by the model inside the `<decision>` block. */
export const RawDecisionSchema = z.object({
  symbol: z.string().min(1),
  action: DecisionActionSchema,
  leverage: z.number().optional(),
  position_size_usd: z.number().optional(),
  stop_loss: z.number().optional(),
  take_profit: z.number().optional(),
  confidence: z.number().optional(),
  risk_usd: z.number().optional(),
  reasoning: z.string().optional(),
});
export type RawDecision = z.infer<typeof RawDecisionSchema>;

/**
 * A decision after normalisation and risk review. `sizeUsd`, `leverage` and the
 * protection levels are always populated for open actions — either from the
 * model or from the configured fallbacks — and `adjusted` records every place
 * the risk engine had to intervene.
 */
export interface Decision {
  symbol: string;
  action: DecisionAction;
  leverage: number;
  positionSizeUsd: number;
  stopLoss: number | null;
  takeProfit: number | null;
  confidence: number;
  riskUsd: number;
  reasoning: string;
  /** Human-readable notes describing every risk-engine adjustment. */
  adjustments: string[];
}

/**
 * A decision the validator refused to execute.
 *
 * Deliberately loose about `action`: the whole point is to report requests the
 * model made that were not executable, including ones naming an action that
 * does not exist. Typing this as a `RawDecision` would force a lie.
 */
export interface RejectedDecision {
  symbol: string;
  action: string;
  reason: string;
}

/** Outcome of parsing one model response. */
export interface ParsedDecisionSet {
  /** The model's chain of thought, extracted from `<reasoning>`. */
  cotTrace: string;
  /** Fully validated and risk-reviewed decisions, in execution priority order. */
  decisions: Decision[];
  /** The raw, unparsed model response — always persisted for the audit trail. */
  rawResponse: string;
  /** Decisions the model emitted that the validator rejected outright. */
  rejected: RejectedDecision[];
}
