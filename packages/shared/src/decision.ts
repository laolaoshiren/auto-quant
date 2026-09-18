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
  /*
   * 加仓 / 减仓 —— **调整一个已有持仓的规模**。
   *
   * 用户的原话是「没有动态加仓、减仓、调整」。
   * `adjust_protection` 是「调整」；这两个是另外两半。
   *
   * ## 为什么它们现在能安全地做
   *
   * 我一开始以为这需要发明"加权均价"和"部分成交"的账目模型，
   * 所以先只做了 `adjust_protection`。查证之后发现**那套基础设施已经存在** ——
   * `reconstructRoundTrips()` 里写着：
   *
   *   · 「Adding to the position: the entry average moves.」—— 加仓累加
   *     `entryQty` / `entryNotional`，均价由 `entryNotional / entryQty` 得出
   *   · 「Closing (possibly partially)」—— 部分出场按剩余数量封顶，
   *     手续费按 `closing / qty` 分摊
   *
   * 缺的只是**触发它的动作**，以及本地持仓的同步。
   *
   * ## 唯一需要新增的记账机制
   *
   * 部分平仓必须当场记账，而最终平仓时 `findRoundTrip()` 会把整段往返再算一遍 ——
   * 同一笔利润会被记两次。所以加了 `positions.realized_partial_pnl` 与
   * `booked_partial_qty`（迁移 M8），最终平仓时把已记的部分减掉。
   * **重复记账比漏记更糟**：它让账面比账户好看，而那正是 §2.5 禁止的方向。
   */
  'add_to_position',
  'reduce_position',
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
/**
 * 加仓 / 减仓 —— 改变一个已有持仓的规模。
 *
 * 单独一个谓词的理由与 `isAdjustAction` 相同：风控与执行都是
 * `if (isClose) … else if (isOpen) … else 当成 no-op`，
 * **没有谓词的话新动作会被静默当成"什么都不做"**。
 */
export function isResizeAction(a: DecisionAction): boolean {
  return a === 'add_to_position' || a === 'reduce_position';
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
  /*
   * 减仓用：卖掉落多少。
   *
   * **两个字段而不是一个**：按比例减是交易员的自然说法（"减一半"），
   * 而按数量减在数量不是整数时更精确（币的数量可以是小数）。
   * 两个都给时以数量为准 —— 它更具体。
   */
  reduce_percent: z.number().optional(),
  reduce_quantity: z.number().optional(),
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
  /**
   * 减仓用：卖掉落多少。
   *
   * 归一化之后**两个都可能为 null**（不是减仓动作时）——
   * 风控会把模型给的比例或数量换算成一个，另一个留空。
   */
  reducePercent: number | null;
  reduceQuantity: number | null;
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
