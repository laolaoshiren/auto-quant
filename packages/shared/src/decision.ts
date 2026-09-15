import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Decision — the exact contract the language model must speak                 */
/* -------------------------------------------------------------------------- */

export const DecisionActionSchema = z.enum([
  'open_long',
  'open_short',
  'close_long',
  'close_short',
  'hold',
  'wait',
]);
export type DecisionAction = z.infer<typeof DecisionActionSchema>;

export const OPEN_ACTIONS: readonly DecisionAction[] = ['open_long', 'open_short'];
export const CLOSE_ACTIONS: readonly DecisionAction[] = ['close_long', 'close_short'];

export function isOpenAction(a: DecisionAction): boolean {
  return a === 'open_long' || a === 'open_short';
}
export function isCloseAction(a: DecisionAction): boolean {
  return a === 'close_long' || a === 'close_short';
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
