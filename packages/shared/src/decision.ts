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
  /*
   * **撤掉一张还没成交的限价入场单。**
   *
   * ## 为什么需要它
   *
   * 限价入场挂出去之后，模型只能"看着" —— 它能从提示词里看到那张单在等，
   * 但**改不了它**。而现实中"这笔不该再等下去了"是常见的判断：
   * 挂单的理由已经不成立（结构破了）、价位早就被甩开、或者等得太久
   * （占着持仓名额，而机会成本在流逝）。
   *
   * ## 它只降低风险
   *
   * 撤单**释放**一个已经承诺出去的敞口（挂单成交就会变成持仓）。所以在风控里
   * 它**总是通过** —— 与 `reduce_position` 同类，不需要过那批"增加风险"的上限。
   */
  'cancel_pending',
  /*
   * **「我看过了，不做。」**
   *
   * ## 为什么需要一个"什么都不做"的动作
   *
   * 在此之前，模型对候选池里**没做的那些标的**不留任何结构化痕迹 ——
   * 它只在推理文本里写一句"排除"，`decisions_json` 里根本没有这些标的。
   * 后果是**它的入场标准从来没有被校准过**：
   *
   *   · `get_skipped_outcomes` 能告诉它"这些标的后来涨了/跌了"，
   *   · 却回答不了真正的问题 ——「**我的门槛是不是太高**」，
   *   · 因为**没有"门槛"这个量**，也就没有"差多少"。
   *
   * 实测（用户的原话）：一个 24h +94%、成交额排全市场第 12 的标的，它连续五轮
   * 写"抛物线、4h RSI 90+、追高禁区"然后跳过，**一轮都没做**。而它的复盘工具
   * 齐备、也确实调用了 `get_skipped_outcomes` —— 缺的是一个能把"我否掉它"
   * 变成**可比数字**的载体。
   *
   * ## 它必须是 no-op，而且要显式声明
   *
   * 风控与执行层都是
   *
   *     if (isCloseAction) … else if (isOpenAction) … else 当成 no-op
   *
   * 的链式分派。`skip` 掉进最后那个分支**恰好**是它想要的语义 ——
   * 但 `cancel_pending` 掉进去会被当成开仓（见上面那段注释）。所以这里同样
   * 给出独立谓词：**下一次有人在这条链上动手时，该看见"skip 必须继续是 no-op"，
   * 而不是靠它碰巧掉对了分支。**
   */
  'skip',
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

/**
 * 撤掉一张还没成交的限价入场单。
 *
 * ⚠️ **单独一个谓词，理由与 `isAdjustAction` / `isResizeAction` 一字不差**：
 * 风控与执行层都是
 *
 *     if (isCloseAction) … else if (isOpenAction) … else 当成 no-op
 *
 * 的链式分派。**没有谓词的话，新动作会掉进最后那个分支** ——
 * 而 `cancel_pending` 掉进去的结果比"什么都不做"更糟：它会被当成**开仓**去审，
 * 甚至真的被当成开仓执行。这个文件里已经为同一个坑写过两次注释。
 */
export function isCancelPendingAction(a: DecisionAction): boolean {
  return a === 'cancel_pending';
}

/**
 * 「看过了，不做」—— 一个**纯记录**动作，不产生任何订单。
 *
 * ⚠️ **单独一个谓词，理由与上面三个一字不差**：风控与执行层都是链式分派，
 * 而没有谓词的新动作会掉进最后那个 `else`。`skip` 掉进去**正好**是它要的语义
 * （什么都不做），所以它今天不会出事 —— 但"碰巧对"不是"约定"。
 * 让这个谓词存在，是为了让下一个人在改那条链时能看见它、并且不得不处理它。
 *
 * ## 它为什么值得占一个动作
 *
 * 它让模型**对每一个候选标的都留一条结构化记录**（`setup_score` 那一项），
 * 而不仅仅是它决定要做的那些。`get_skipped_outcomes` 因此可以从
 * 「这些标的后来涨了」升级成「**我否掉的平均 62 分、开仓的平均 78 分，
 * 而某个后来涨了 40% 的标的当时 74 分**」—— 那才是能校准门槛的证据。
 */
export function isSkipAction(a: DecisionAction): boolean {
  return a === 'skip';
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
  /*
   * 入场方式。省略 = 市价（与既有行为一致 —— 模型不写这个字段时什么都没变）。
   *
   * `entry_type: 'limit'` 时 `limit_price` 必填；解析器会校验并给出可读的拒绝理由，
   * 而不是让一个缺价的限价单走到执行层去。
   */
  entry_type: z.enum(['market', 'limit']).optional(),
  limit_price: z.number().optional(),
  /*
   * **这个标的的评分（0–100）—— 标准由你自己定义。**
   *
   * ## 为什么是"你自己定义"，而不是系统给一把尺子
   *
   * 系统的模式是「全智能、不写死」：入场标准本来就归模型自己（`entryStandards`
   * 是它能改的提示词段落之一）。所以这里**不定义什么叫 80 分**，只要求它
   * **对每一个候选标的都给出一个数**，并说明依据。
   *
   * 那个数的作用不是决定"开不开"（开不开仍由它的规则与风控决定），
   * 而是让它**可被自己校准**：`setup_score` 落了库，`get_skipped_outcomes`
   * 才能算出「我否掉的那批平均多少分、我开仓的那批平均多少分、
   * 而后来涨了很多的那些当时是多少分」。
   *
   * 没有这个数，它每一轮都在用同一把尺子，而**那把尺子从来没被校准过** ——
   * 这正是用户说的"复盘不够智能"：不是它不复盘，是**复盘拿不到可比的量**。
   */
  setup_score: z.number().min(0).max(100).optional(),
  /** 上面那个分数是**按什么打出来的**（一句话，便于以后对照）。 */
  setup_score_basis: z.string().optional(),
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
  /**
   * 开仓用**市价**还是**限价挂单等成交**。省略 = 市价（既有行为）。
   *
   * ## 为什么要有它
   *
   * 真实交易员分析完行情之后，常见做法是**预测一个区间、在那儿挂限价单等着**，
   * 而不是立刻市价吃进去 —— 后者要付 taker 费、还要承受滑点。这个系统在此之前
   * 只会市价开仓。
   *
   * ## 它与别的字段的关系
   *
   * · `limit` 时 **`limitPrice` 必填**，它是入场触发价；
   * · 挂上之后**这一轮不建仓** —— 它变成一行 `status='pending'` 的持仓，
   *   由对账在成交后转正并**立刻补挂保护单**（见 `M11_PENDING_ENTRY` 的说明）；
   * · `stopLoss` / `takeProfit` 仍然要照常给：挂单时挂不上去（没有仓位），
   *   但**成交那一刻要立刻用它们挂保护单** —— 不给的话仓位会有一段裸奔窗口。
   */
  entryType?: 'market' | 'limit';
  /** 限价入场的价格。`entryType === 'limit'` 时必填。 */
  limitPrice?: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /**
   * 模型对这个决策的自评置信度（0–100）。
   *
   * ## ⚠️ `null` 表示**模型没有给出** —— 它与 `0` 是两件事
   *
   * 实测：模型输出的 JSON 里**压根没有 `confidence` 这个字段**（它只写了
   * `symbol` / `action` / `reasoning`），而解析器当时填的是 `0` ——
   * 于是界面上每个决策都显示「置信度 0%」，看起来像"模型对每个判断都毫无把握"。
   *
   * 更糟的是风控那道 `minConfidence` 门槛：**一个真实把握 75 分、只是漏填字段的
   * 开仓会被当成 0 分直接拒掉**，而拒绝理由会写着"置信度 0 低于要求的最低值 68"
   * —— 那句话是错的，它应该说"你根本没给"。
   *
   * 类型原来是必填的 `number`，而 zod schema 是 `.optional()` —— **两者不一致，
   * 解析器就用 `0` 去满足类型**。改成可空之后，"没给"和"给了 0"在类型上就分开了。
   * （模型为什么漏填：提示词只给了 `open_long` / `open_short` 两个范例，
   * `wait` / `hold` 这些动作没有范例可照 —— 见 `prompt.ts` 里新增的那个。
   * 范例对输出形状的锚定作用比措辞强得多，这一点提示词自己的注释里写过。）
   */
  confidence: number | null;
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
  /**
   * 模型给这个标的打的评分（0–100），以及它的依据。
   *
   * `null` = **模型没给**（与 `confidence` 同一条约定：`0` 与 `null` 是两件事）。
   *
   * 它与 `confidence` 的区别很重要，别混：
   *   · `confidence` 是"我对我这个**决策**有多确定"
   *   · `setup_score` 是"这个**标的本身**有多符合我的入场标准"
   *
   * 一个被 `skip` 掉的标的没有决策可言，但**有分数** —— 而那正是校准
   * 入场门槛唯一需要的量。详见 `setup_score` 在 `RawDecisionSchema` 上的说明。
   */
  setupScore: number | null;
  /** 打分依据（一句话）。没给时是空串。 */
  setupScoreBasis: string;
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
