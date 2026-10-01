import {
  closeReasonLabel,
  marginPercentToPricePercent,
  type MarketSnapshot,
  type OiRankRow,
  type PositionView,
  type StrategyConfig,
  type TimeframeIndicators,
  type TradeRecord,
} from '@aq/shared';

import { SCORE_WEIGHTS } from './scoring.js';
import { DECISION_TOOL_CATALOGUE } from '../trader/decisionTools.js';
import type { RankingRow, UniverseRankings } from '../market/rankings.js';
import type { PlatformHistoryRow } from './platformHistory.js';
import type { EntryFillStats } from './entryStats.js';

/* -------------------------------------------------------------------------- */
/*  Prompt context                                                             */
/* -------------------------------------------------------------------------- */

export interface PromptAccountInfo {
  equity: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginUsed: number;
  positionCount: number;
  /**
   * 账户上**不属于本平台任何机器人**的成交笔数（外部活动）。
   *
   * 这些交易会直接改变余额，但**不计入本机器人的绩效** —— 所以
   * 「账户在缩水」和「我的绩效是正的」可以同时成立，而模型必须知道这一点，
   * 否则它会在错误的前提下推理（以为自己算错了，或以为策略在亏）。
   */
  foreignRounds?: number;
  /** 这些外部成交的净额，用来解释账户与绩效之间的差额。 */
  foreignNet?: number;
  /**
   * **平台账本与交易所的差额**（总账校验的结论）。
   *
   * 非 0 且超出容差意味着**上面的绩效数字本身不可信** —— 平台的账
   * 与交易所的流水对不上，而模型正照着那份账决策。
   *
   * 与 `foreignRounds` 的区别：那个是「账户上有别人的交易」（账是对的），
   * 这个是「账本身就是错的」。**后者严重得多。**
   */
  ledgerGap?: number;
}

export interface PromptPosition {
  position: PositionView;
  /** Indicator snapshot for the symbol, used to give the model live context. */
  snapshot: MarketSnapshot | null;
  holdingMinutes: number;
}

/** 一张挂出去、还没成交的限价入场单（提示词用）。 */
export interface PromptPendingEntry {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  /** 挂单的价位（**不是成交价** —— 它还没成交）。 */
  limitPrice: number;
  /** 挂上去多少分钟了。 */
  waitingMinutes: number;
  /** 成交后会用这个止损挂保护单。 */
  stopLoss: number | null;
  takeProfit: number | null;
  /** 当初为什么挂这一单。 */
  reasoning: string;
}

export interface PromptContext {
  traderName: string;
  cycleNumber: number;
  now: Date;
  config: StrategyConfig;
  /**
   * 这个机器人是不是由 AI 自己托管（`mode === 'ai_managed'`）。
   *
   * ## 为什么提示词需要知道这件事
   *
   * 因为**有一整段内容只在非 AI 托管时才对**：`MODE_GUIDANCE` 会给提示词注入
   * 一段交易性格（「模式：稳健……保住本金压倒一切」），而那是**写死的一档**。
   * 对固定策略那是准确的描述 —— 写策略的人确实选了那一档。
   *
   * 而 AI 托管模式的意义正是**由它自己决定该稳健还是该进取**。给它注入一段
   * 写死的性格，等于把那个判断拿走；而它还会与角色句、以及它自己写的
   * `entryStandards` 叠成三层，都在说同一件事（实测 `#9` 就是这个样子）。
   *
   * 省缺 = `false`（按固定策略处理）—— 那是更保守的默认：老调用点不需要改。
   */
  aiManaged?: boolean;
  account: PromptAccountInfo;
  positions: PromptPosition[];
  /**
   * **已挂出、等待成交的限价入场单。**
   *
   * ## 为什么它必须进提示词
   *
   * 没有它，模型**不知道自己在等什么** —— 它会为一笔已经挂好的入场重复提案，
   * 或者干脆忘了这件事。而这两件事都真实发生过（`agent_memory` 里那句
   * 「问题出在移损/止盈规则过松」的另一面就是：它对自己手上的状态不完全清楚）。
   *
   * 它**不是持仓**，所以单独一段、措辞明确 —— 不能混进「当前持仓」里，
   * 那会让模型以为仓位已经成立、去做它现在还做不到的事（比如"把止损上移"）。
   */
  pendingEntries: PromptPendingEntry[];
  candidates: MarketSnapshot[];
  oiRanking: OiRankRow[];
  /**
   * 模型对自己历史的「记忆」（提案 §2 的三个区块）。
   *
   * ⚠️ 这三个区块是**唯一不参与预算裁剪**的内容：组装完成后超出预算时先砍候选标的，
   * 绝不砍它们。理由见 `trimCandidatesForBudget()` —— 行情是"这一轮的机会"，
   * 记忆是"我一直在亏钱"；丢掉前者只是错过一次机会，丢掉后者会让系统永远重复
   * 同一个错误，而那正是当前问题的根源。
   */
  memory: PromptMemory;
  /**
   * 选币阶段**已经**裁掉了多少个标的（`selectCandidates` 的候选上限）。
   *
   * ⚠️ 这是**第二次**裁剪，与 `buildUserPrompt` 内部那次（提示词 token 预算）
   * 不是同一件事，而它原来完全没有告诉模型：
   *
   *   · 第一次在 `coins.ts`：按 `candidateBudget(config)` 的上限截断候选池；
   *   · 第二次在这里：按 token 预算再砍一轮（那次会写进候选区块的标题）。
   *
   * 于是模型看到的是"候选标的（11 个）"，而配置里其实是 25 个 ——
   * 它无从知道池子被裁过。而提示词第 9 条又明确鼓动它"如果连续几轮在同样的
   * 标的上找不到机会，问题可能在你选标的的方式"—— **它会在一个被静默裁过的
   * 池子上做归因**，然后去改一个本来没问题的参数。
   *
   * 非 null 表示这一轮真的裁过；null 表示没裁（那时不必占一行预算）。
   */
  universeTrimmedFrom: number | null;
  /**
   * ⚠️ **全市场概览 —— 币安全部可交易 USDT 永续的极简一行。**
   *
   * ## 为什么需要它（用户 2026-09-30 的原话）
   *
   * > 「币安支持的币种我觉得都应该在模型判断得范围（当然不是一次性给所有币种行情数据）」
   *
   * 在此之前模型的视野**只有候选池那 20 个**（占全市场约 527 个的 3.8%），
   * 而它**无从知道外面还有什么** —— 那正是"只做大盘币、抓不住异动"的根源，
   * 也是"系统替模型做了决定"（用户的原则：**模型是大脑，系统只是手脚**）。
   *
   * ## 与候选池的区别（很重要）
   *
   * 这一段**不是候选**：每条只有符号 + 三个数字，**没有指标序列**。
   * 所以它极便宜（约 527 行 ≈ 6K tokens，占每轮 30 万的 2%），
   * 而模型能据此发现"外面有什么值得看"，再用工具点名要完整行情。
   *
   * 可选：不传就不渲染这一段（测试与回放路径不需要它）。
   */
  marketOverview?: MarketOverviewRow[];
  /**
   * ⚠️ **市场聚焦（第 1 层）—— 各维度的 Top 榜。**
   *
   * 第 0 层「全景」让模型**看见全部标的**；这一层告诉它**哪里在动**：
   * 成交额 / 涨幅 / 跌幅 / 波动率 / 资金费极值，每个维度前几名。
   *
   * ⚠️ **它是"快照"而不是"推荐"** —— 每个榜只按一个维度排序，系统**没有做任何
   * 筛选判断**。那句话也写进了提示词里：用户的原则是「**模型是大脑，系统只是手脚**」，
   * 系统在这里没有资格替它决定"哪个值得做"。
   *
   * 可选：不传就不渲染（回放/测试路径不需要）。
   */
  rankings?: UniverseRankings;
  /**
   * 「持仓量增长」这个维度**当前是否开启**（`indicators.enableOiRanking`）。
   *
   * ⚠️ 它关着的时候，渲染层会**明确告诉模型这个能力存在、以及怎么打开**。
   *
   * 为什么不直接替它打开：那属于**模型的判断**（它能用 `set_params` 自己改），
   * 而用户的原则是「**模型是大脑，系统只是手脚**」。但"能开而不知道"等于没有 ——
   * 那就成了"系统把能力藏起来"，与本项目的方向正相反。
   */
  oiRankingEnabled?: boolean;
  /**
   * ⚠️ **本平台历史**（第 1 层的第七个维度）—— 按标的聚合**本平台自己的成交**。
   *
   * 八个维度里唯一一个"关于自己"的维度：交易所只给市场数据，
   * 而"**我**在这个标的上做过几笔、结果如何"只有平台知道。
   *
   * ⚠️ 两个方向都要给（赚过的 + 总是亏的），且每行带**笔数** —— 见 `platformHistory.ts`。
   */
  platformHistory?: PlatformHistoryRow[];
  /**
   * ⚠️ **这个机器人多久决策一次**（分钟）。
   *
   * 必须写进提示词：模型的**时间类规则**要按这个尺度换算。实测（2026-09-30）
   * 它写的「入场后第一次醒来检查」在 30 分钟周期下变成了"开仓就平"——
   * 而那条规则的本意显然不是这样。
   *
   * 它也能自己用 `set_params` 改周期，所以这里给的是**事实**，不是约束。
   */
  cycleIntervalMinutes?: number;
  /**
   * ⚠️ **往返成本**（开+平手续费合计，占名义价值的百分比；从本账户的历史成交反推）。
   *
   * 模型自己那类「保本/锁盈上移」规则的判据是**价格浮盈的百分比**，而它把止损
   * 移到"比入场价好一点点"时，那"一点点"必须覆盖这个数 —— 否则被扫掉就是净亏，
   * 与方向判断对不对无关。
   *
   * 实测（2026-09-30 ZECUSDT）：止损被上移到只锁 **0.048%**，而往返成本 **0.070%**，
   * 结果毛 +0.0042、手续费 0.0148 → 净 **-0.0106**。模型自己的复盘两次都指出了
   * 这条教训，但**决策时手里没有这个数字**（它在 09-30 的复盘里明说
   * 「具体是原止损还是移动止损被扫，数据不足无法确定」）。这是信息缺口，不是能力缺口。
   */
  roundTripCostPercent?: number | null;
  /**
   * ⚠️ **交易所对【这个账户】的实际杠杆授信**（`symbol → 上限`，读自 `leverageBracket`）。
   *
   * 为什么必须告诉模型：币安的规则是
   * `能设的最大杠杆 = min(名义价值档位的 initialLeverage, 账户级限制, symbol 上限)`，
   * 而**账户级那一项对子账户是硬的** —— 官方 FAQ：新建子账户合约杠杆不超过 5x。
   *
   * 系统早就读了这个数（`broker.getMaxLeverage()`），但只喂给风控引擎做钳制
   * （`autoTrader.ts` 的 `exchangeMaxLeverageOf`），**从没进过提示词**。
   * 于是模型只看到配置里写死的 `最大杠杆 5x`，**永远不会想到**
   * "其实交易所允许更高，我可以把配置调上去"。
   *
   * 用户 2026-10-01 的原话：「我准备用主账户交易了（没有合约 5X 限制，本金也会加到 100u 以上），
   * 你确保我使用主账户，系统能正常运作（不要无法识别 5X 以上什么的和现在一样
   * **AI 不知道能挂更高**）」。
   */
  leverageCaps?: Record<string, number>;
  /**
   * ⚠️ **挂单成交统计** —— 模型看不到的那个反馈。
   *
   * 用户 2026-10-01 观察到「每次开单都是限价单…经常挂了都无法成交…好像在浪费时间和 token」。
   * 真实数据证实了他的判断：**限价入场单撤单率 64%**（78 撤 / 44 成交），而市价单 100% 成交。
   *
   * 系统**已经告诉过它**"挂满 `pendingEntryTimeoutMinutes` 分钟会自动撤"，
   * 但它从没看到**"我过去挂的单六成都没成交"** —— 而这是它调整挂单方式的唯一依据。
   * 于是它每轮都在重复"挂回踩位 → 超时撤掉 → 下一轮再挂"。
   *
   * 这里只给**事实**。要不要改挂法仍然是它的判断。
   */
  entryStats?: EntryFillStats;
  /**
   * ⚠️ **连续多少轮没有开过一次仓**（从最近的决策记录倒着数）。
   *
   * ## 为什么这个事实必须说出来
   *
   * 模型逐轮排除候选，每一条理由都具体且站得住（"BTC 名义下限不够"、
   * "RSI 90 动能 climax"、"1.5×ATR 超类别止损带"…）。而**每一条都是亏损复盘后加上的**，
   * 规则**只增不减** —— 可做集合随时间**单调收缩**。
   *
   * 实测 2026-10-01：连续 10+ 轮 0 开仓，最近一次成交在 **21 小时前**。
   * 而它看不见这件事 —— **每一轮的思考都是局部的**，没人告诉它"你已经很久什么都没做了"。
   *
   * 系统不替它删规则（那是它的判断），只把事实摆出来。≥5 轮（约 2.5 小时）才渲染。
   */
  idleCycles?: number;
  /** 这段空转期间的已平仓净额（说明"什么都没做"的同时账户发生了什么）。 */
  idleNetPnl?: number;
  /**
   * ⚠️ **模型自己写的规则有多少字符 / 多少条编号规则。**
   *
   * 它没有刻度：只写规则、不删规则，也看不到"我的规则现在有多大"。
   *
   * 量化证据（2026-10-01，`agent_experiments` 里记录的配置长度）：
   *
   *     #14  2026-09-20   1,841 字符
   *     #46  2026-09-30   9,618 字符      ← **5.2 倍**
   *
   * 同期开单率：09-26 是 48% → 10-01 是 8%。
   *
   * 「每次亏损复盘加一条」本身是对的 —— 缺的是**反馈**：
   * 规则多了以后，可做集合会单调收缩到空，而这件事没有任何地方会"响"。
   */
  ruleSizeChars?: number;
  ruleCount?: number;
}

/** 「全市场概览」的一行 —— 见 `PromptContext.marketOverview`。 */
export interface MarketOverviewRow {
  symbol: string;
  price: number;
  /** 24 小时涨跌幅（百分数，例如 `-1.01`）。 */
  changePercent24h: number;
  /** 24 小时成交额（USDT）。 */
  quoteVolume24h: number;
}

/* -------------------------------------------------------------------------- */
/*  记忆区块的输入（提案 §2）                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 绩效区块的统计窗口（小时）。
 *
 * 固定值，不是"从第一笔成交算起"：窗口固定 + SQL 聚合 = §4 要求的 O(1)。
 * 没有这条，"7×24 跑一年"之后这个区块会随历史长度线性膨胀。
 */
export const PROMPT_PERFORMANCE_WINDOW_HOURS = 24;

/**
 * 「最近平仓」区块的笔数。
 *
 * ## 为什么从 5 提到 15
 *
 * 固定 N 是第二块 O(1)：逐笔明细永远只有 N 行，跑一年也不会变长 —— 所以
 * **N 取多少与"会不会膨胀"无关**（§2.4「不加完整成交历史」仍然成立：明细是
 * O(n)，聚合是 O(1)）。
 *
 * 而 5 在有意义的场景下**太短**：这台机器人的周期是 45 分钟，5 笔平仓还不到
 * **4 小时**的历史。用户的原则是「在**最大化发挥模型能力**的前提下，才考虑
 * 优化模型成本」—— 让模型只看到最近 5 笔就把"它最近做错了什么"这个判断
 * 压缩到了一个很容易被一次幸运或一次意外主导的样本量上。
 *
 * ## 成本
 *
 * 每行含一句当时的理由，实测约 250 字符。15 行约 3,750 字符 ≈ **2,200 token** ——
 * 占 1M 上下文模型那 80 万预算的 **0.3%**。这个量级换来 3 倍的历史视野，
 * 在"能力优先"的原则下是明显划算的。
 *
 * ⚠️ 它**不是**唯一的记忆来源：`get_lessons`（复盘结论，默认取 12 条、上限 30）
 * 与 `agent_memory` 才是长期记忆，而且模型可以按需再取。这一块的作用是
 * **"刚刚发生了什么"**，所以取一个够用的固定行数即可。
 */
export const PROMPT_RECENT_CLOSE_COUNT = 15;

/**
 * 绩效区块的全部输入。字段固定，所以渲染出来的字节数固定。
 *
 * 金额都是 USDT；`roundTripFeeRate` 是**小数比例**（0.001 = 0.10%），
 * 字段名带单位后缀以免调用方再乘一次 100（§5.3）。
 */
/**
 * 连续空转到多少轮，就该在绩效区块里明确点出来。
 *
 * 取 8：按 15 分钟一轮约两小时。短于它的空转可能只是"这段行情确实没有机会"，
 * 而长于它、且每一轮都在否掉全部候选，就已经是**系统性问题**而不是运气 ——
 * 那时模型该做的是回头检查门槛 / 标的池 / 自己的标准，而不是继续等。
 */
export const IDLE_CYCLES_ALERT_THRESHOLD = 8;

export interface PromptPerformance {
  windowHours: number;
  totalTrades: number;
  wins: number;
  losses: number;
  grossPnl: number;
  totalFees: number;
  totalFunding: number;
  netPnl: number;
  avgWin: number;
  /** 平均亏损额（正数）。渲染时加负号。 */
  avgLoss: number;
  /** 实际盈亏比 = 平均盈利 / 平均亏损；窗口内没有亏损单时为 null。 */
  realizedPayoffRatio: number | null;
  /** 往返成本占名义价值的比例；窗口内没有成交时为 null（不编造）。 */
  roundTripFeeRate: number | null;
  /**
   * **连续有多少轮没有做出任何决策**（`decisions` 为空的周期数，从最近往前数）。
   *
   * ## 为什么这个数字必须单独给
   *
   * 上面那些字段都在描述"成交之后怎么样"，而**空转时它们全是 0** ——
   * `totalTrades === 0` 只渲染一句"最近 N 小时没有已平仓的交易"。
   * 而那句话无法区分两种完全不同的处境：
   *
   *   · 刚跑了两轮，还没等到机会（正常）；
   *   · **已经连续二十几轮、每一轮都把候选逐个否掉**（那是系统性问题）。
   *
   * 实测就是后一种：某机器人 28 个周期 0 决策，而它的推理质量很高 ——
   * 它每一轮都在认真分析，只是**看不到"我已经这样很多轮了"这件事**。
   * 绩效区块说的是"没成交"，而它需要知道的是"我一直在原地"。
   *
   * 这个数字是"该反思自己而不是继续等待"的直接依据，所以放在绩效里。
   */
  idleCycles: number;
}

/**
 * 一笔最近平仓 + **模型当时的入场理由**。
 *
 * 第二项是关键：把"当时的理由"和"实际结果"放在一起，是模型唯一能形成
 * "我某个判断模式不奏效"的机制。没有它，明细只是流水账。
 */
export type PromptClose = TradeRecord & {
  /** 开仓时模型写下的理由（持仓行的 `open_reasoning`），可能为空。 */
  entryReason: string | null;
};

/** 「本周期约束」区块的输入：模型离节流与冷却还有多远。 */
export interface PromptThrottleBudget {
  entriesThisHour: number;
  maxEntriesPerHour: number;
  /** 距最近一次平仓过了多少分钟；从未平过仓时为 null。 */
  minutesSinceLastExit: number | null;
  reentryCooldownMinutes: number;
}

/** 三个记忆区块的全部输入。 */
export interface PromptMemory {
  performance: PromptPerformance;
  recentCloses: PromptClose[];
  throttle: PromptThrottleBudget;
  /**
   * 最近被风控拒绝的提议。
   *
   * ## 为什么必须有这一块（实测出来的）
   *
   * 上面那段注释已经写着原则：**看不见的约束等于不存在** ——
   * 模型会反复提出必然被拒的请求。但那条原则此前只落实在节流/冷却上。
   *
   * 实测的形态：模型提「名义 $6.00」，运行时按步长取整后是 $5.00，
   * 低于下限 $6.00 → 拒绝。**下一轮模型只看到绩效与节流，完全不知道被拒过**，
   * 于是原样再提一次。用户看到的是「为什么同一个错误反复出现」——
   * **不是模型不智能，是这一侧没把它自己的失败告诉它。**
   *
   * 固定取最近 3 条（与最近平仓同样的 O(1) 纪律，见 §4）。
   */
  recentRejections: PromptRejection[];
  /**
   * AI 自己复盘出来的教训（`agent_memory`）。
   *
   * ## ⚠️ 这一块原来**根本不存在**，而那是「越跑越厉害」断掉的地方
   *
   * `agent_memory`（每笔平仓后由复盘员写下的"这一笔为什么亏")从写下那天起
   * **没有任何决策路径读它** —— 全仓库唯一的调用者是复盘员自己（再喂给下一轮
   * 复盘），以及测试。也就是说：
   *
   *   · 交易决策提示词里从来没有出现过教训；
   *   · 一条教训要影响下一笔交易，只能**绕道**让策略师把它变成一个参数改动
   *     （或写进 `promptSections`）—— 那是间接的、有损的、还得恰好被策略师看见。
   *   · 仓库自己早就记着这件事（`tools.test.ts` 里那段话："复盘员反复打出
   *     「止损过紧」「费用吃掉利润」，而策略师一直在 `minPositionSize` 上反复
   *     微调 —— 因为它看不到那个诊断"）。
   *
   * 把教训直接放进决策提示词，是"AI 从自己的失败里学"最直接的一条路：
   * 它每次做决定前都能看到"我在这个标的上以前是怎么亏的"。
   */
  lessons: PromptLesson[];
}

/** 一条教训 —— 给模型看的是"哪个标的、什么结局、结论是什么"。 */
export interface PromptLesson {
  symbol: string;
  /** 平仓原因（英文稳定码，见 `CLOSE_REASONS`）。 */
  closeReason: string;
  /** 那笔的**净**盈亏（已扣手续费与资金费）。 */
  netPnl: number;
  /** 复盘员写下的结论。 */
  lesson: string;
}

/** 一条被拒的提议 —— 给模型看的是「它提了什么、为什么不行」。 */
export interface PromptRejection {
  symbol: string;
  /** 当时提议的名义价值（美元）。 */
  positionSizeUsd: number;
  /** 拒绝理由，运行时原话。 */
  reason: string;
}

/**
 * 没有账本可读时的记忆区块（策略体检 / 管道验证这类诊断路径）。
 *
 * 如实表示"还没有任何成交"，而不是编一组数字出来：诊断路径展示的提示词必须与
 * 实盘真的会发出去的那一份形状一致，否则体检报告的 token 数就没意义了 ——
 * 那正是 `healthCheck` 里"这段预算检查必须在调用之前做"的原因。
 */
export function emptyPromptMemory(config: StrategyConfig): PromptMemory {
  return {
    performance: {
      windowHours: PROMPT_PERFORMANCE_WINDOW_HOURS,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      grossPnl: 0,
      totalFees: 0,
      totalFunding: 0,
      netPnl: 0,
      avgWin: 0,
      avgLoss: 0,
      realizedPayoffRatio: null,
      roundTripFeeRate: null,
      /* 诊断路径没有决策历史 —— 如实填 0，而不是编一个"空转了很久"。 */
      idleCycles: 0,
    },
    recentCloses: [],
    throttle: {
      entriesThisHour: 0,
      maxEntriesPerHour: config.throttle.maxEntriesPerHour,
      minutesSinceLastExit: null,
      reentryCooldownMinutes: config.throttle.reentryCooldownMinutes,
    },
    recentRejections: [],
    lessons: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Number formatting                                                          */
/* -------------------------------------------------------------------------- */

/** Adapts decimal places to magnitude so prompts stay readable and compact. */
function fmt(value: number | null | undefined, decimals?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  if (decimals !== undefined) return value.toFixed(decimals);
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(4);
  if (abs >= 0.01) return value.toFixed(6);
  return value.toExponential(4);
}

function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${value >= 0 ? '' : '-'}$${Math.abs(value).toFixed(2)}`;
}

function fmtSigned(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}`;
}

function fmtPercent(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

/**
 * 「止损距入场价多远」——**价格口径**，正数表示已经在锁盈侧。
 *
 * 为什么值得渲染出来：模型那类「保本/锁盈上移」规则用的是**价格百分比**做判据，
 * 它得自己在脑子里把"止损价 vs 入场价"换成百分比。它确实算过
 * （`#1731` 的推理里写着"距现价 1.02%=1.65×ATR"），**但那一步在连续几轮的推理里
 * 很容易被跳过** —— 2026-09-30 的 ZECUSDT 就是跳过它的那次：止损被移到只锁 0.048%，
 * 而往返成本 0.070%，被扫掉后净亏 0.0106。
 *
 * 给出来只是省掉一次心算，判据仍然是模型的。
 */
function stopDistanceLabel(pos: {
  side: 'long' | 'short';
  entryPrice: number;
  stopLoss: number | null;
}): string {
  const stop = pos.stopLoss;
  if (stop === null || !Number.isFinite(stop) || !Number.isFinite(pos.entryPrice) || pos.entryPrice <= 0) {
    return '';
  }
  /* 多头：止损在入场价**下方**时触发，损益为负；空头反之。正数 = 锁盈侧。 */
  const signed = pos.side === 'long' ? stop - pos.entryPrice : pos.entryPrice - stop;
  const pct = (signed / pos.entryPrice) * 100;
  const side = pct >= 0 ? '锁盈侧' : '亏损侧';
  return `（距入场 ${pct >= 0 ? '+' : ''}${pct.toFixed(3)}% 价格口径，${side}）`;
}

/** A compact JSON-ish array render, dropping `null` padding and trimming length. */
function series(values: Array<number | null>, decimals: number, maxPoints = 30): string {
  const usable = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (usable.length === 0) return '[]';
  const tail = usable.slice(-maxPoints);
  return `[${tail.map((v) => v.toFixed(decimals)).join(', ')}]`;
}

function humanDuration(minutes: number): string {
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours < 24) return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时`;
}

/* -------------------------------------------------------------------------- */
/*  Trading-mode guidance                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 「市场聚焦」里每个维度榜取前几名。
 *
 * 8 是"够看出格局、又不至于变成第二份候选池"的量：5 个榜 × 8 行 ≈ 1,000 字符，
 * 相对每轮二十几万字符是零头。它的作用**不是给候选**，而是让模型知道
 * **市场里哪些地方在动** —— 真正的深看仍然是它自己用 `get_klines` 点名。
 */
const RANKING_LIMIT = 8;

/**
 * 连续多少轮没开仓才渲染「连续观望提醒」（5 轮 ≈ 2.5 小时，默认周期下）。
 *
 * 低于这个数属于正常的"这段时间没机会"，提醒会变成噪声 ——
 * **一个每轮都响的警告等于没有警告**（同 `coins.ts` 里裁剪通知的理由）。
 */
const IDLE_CYCLES_NOTICE_THRESHOLD = 5;

/**
 * 模型自己写的决策规则有多大 —— 字符数 + 编号规则条数。
 *
 * ⚠️ **这是"它没有刻度"这个问题的解法。**
 *
 * 模型每次亏损复盘都会往 `promptSections` 里加一条规则，而**没有任何地方会删**。
 * 实测（2026-10-01，`agent_experiments` 记录的配置长度）：
 *
 *     2026-09-20   1,841 字符
 *     2026-09-30   9,618 字符      ← 9 天涨 5.2 倍
 *
 * 同期开单率：09-26 是 48% → 10-01 是 8%。而它自己**看不见这个趋势** ——
 * 每一轮读到的都是完整规则文本，没有"它比上周大了多少"这个信息。
 *
 * 只统计"策略段落"（`promptSections` 里那些模型可写的决策规则），
 * 不含系统提示词与行情数据 —— 那些不是它的产物。
 */
export function summariseRules(
  promptSections: Record<string, unknown> | undefined,
): { ruleSizeChars?: number; ruleCount?: number } {
  if (!promptSections) return {};
  let chars = 0;
  for (const value of Object.values(promptSections)) {
    if (typeof value === 'string') chars += value.length;
  }
  if (chars === 0) return {};
  /*
   * 条数按"形如 N.M 的编号"数（`5.1` / `5.2` …）—— 那是这个仓库里
   * 模型写规则的既有格式，实测它的 decisionProcess 就是这么编号的。
   */
  const all = Object.values(promptSections)
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  const ruleCount = (all.match(/(?:^|\n)\s*\d+\.\d+\s/g) ?? []).length;
  return { ruleSizeChars: chars, ...(ruleCount > 0 ? { ruleCount } : {}) };
}

const MODE_GUIDANCE: Record<StrategyConfig['tradingMode'], string> = {
  aggressive: [
    '模式：进取',
    '你偏好动能与突破延续。较低的胜率是可以接受的，因为盈利单会被允许充分奔跑。',
    '只要失效位没有被击穿，你可以容忍正常回撤。',
    '你可以容忍更大的单笔敞口，但绝不能超过下面的硬性上限。',
  ].join('\n'),
  conservative: [
    '模式：稳健',
    '在投入资金之前，你要求多个相互独立的确认。错过一波行情不花一分钱；一笔糟糕的入场不是。',
    '保住本金压倒一切。宁可交易更少、质量更高。',
    '当信号互相冲突时，正确的动作是 `wait`。',
  ].join('\n'),
  scalping: [
    '模式：短线',
    '你交易短促的动能爆发，持仓以分钟计而非小时计。',
    '目标位与止损都紧贴结构。若某个机会在一两根K线内没有触发，它就已经失效——放弃它。',
    '快速止盈是正确的；让一笔小额盈利单变成亏损单是最糟糕的结果。',
  ].join('\n'),
};

/**
 * 硬性约束里那条与手续费有关的止损要求（提案 §5）。
 *
 * ## 为什么它必须出现在提示词里
 *
 * 与 §2.3 同一条道理：**看不见的约束等于不存在**。这条门槛会拒掉一批"看起来没问题"
 * 的止损（止损比往返成本还近），而模型如果不知道它，就会一轮又一轮地提出这些提案 ——
 * 每一次被拒都浪费一次决策机会。
 *
 * ## 数字必须与风控用的是同一个
 *
 * 有成交就按成交记录实测的费率，没有就按配置的兜底费率 —— 与
 * `RiskEngine.reviewOpen()` 第 6b 步的取值规则完全一致。两处各说各话时，模型会照着
 * 提示词里的数字合规，却仍然被拒（或反过来）。
 */
function feeAwareStopConstraint(
  risk: StrategyConfig['riskControl'],
  observedRoundTripFeeRate: number | null,
): string {
  const multiple = risk.minStopLossFeeMultiple;
  if (!(multiple > 0)) return '';
  const rate = observedRoundTripFeeRate ?? risk.fallbackRoundTripFeeRate;
  const source = observedRoundTripFeeRate === null ? '按配置的兜底费率' : '按近期成交实测';
  const minPercent = rate * multiple * 100;
  return (
    `- 止损距离（|开仓价 − 止损价| / 开仓价）必须至少是往返手续费的 ${multiple} 倍` +
    `（${source}，往返成本约 ${(rate * 100).toFixed(2)}%，即止损幅度不得小于 ${minPercent.toFixed(2)}%）。` +
    '止损比交易成本还近的交易，方向做对了也是亏的。'
  );
}

/* -------------------------------------------------------------------------- */
/*  System prompt                                                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_ROLE =
  '你是一名管理真实资金账户的专业加密货币合约交易员，在币安 USDT 本位永续合约上交易。你会仔细推演市场结构，并且对资金保持保守。';

/**
 * AI 托管模式下的角色 —— **唯一区别是没有替它预设交易性格**。
 *
 * ## 为什么「保守」这两个字必须从 AI 托管的提示词里拿掉
 *
 * 默认角色句的结尾是「**并且对资金保持保守**」。对一份**固定策略**来说那是准确的
 * 描述 —— 写策略的人确实选了稳健那一档。而 AI 托管模式的全部意义是
 * **由它自己决定该稳健还是该进取**；在一句话里先替它定好，等于把那个判断拿走了。
 *
 * 更糟的是它会**叠加**（实测 `#9` 的系统提示词开头）：
 *
 * ```
 * # 角色
 * …并且对资金保持保守。            ← 这里
 * # 模式：稳健
 * 在投入资金之前，你要求多个相互独立的确认…
 * 保住本金压倒一切。宁可交易更少、质量更高。   ← MODE_GUIDANCE 又一遍
 * ```
 *
 * 再加上它自己写的 `entryStandards` 里那句「保守模式，账户约 20 USDT…」——
 * **三层都在说同一件事，而那句话本该由它自己得出。**
 *
 * ## 拿掉的只是「性格」，安全边界一条不动
 *
 * 杠杆上限、名义价值上限、保证金占用、最大持仓数、盈亏比与置信度门槛 ——
 * **全部照旧**（它们本来在 `# 硬性约束` 那一段里，与角色句无关）。
 * 改的是「**它该怎么想**」，不是「**它最多能做多大**」。
 */
const AI_MANAGED_ROLE =
  '你是一名管理真实资金账户的专业加密货币合约交易员，在币安 USDT 本位永续合约上交易。你会仔细推演市场结构，并独立判断当前该有多谨慎或多进取 —— 那个判断由你自己做，也可以随市场变化而改变。';

const DEFAULT_FREQUENCY =
  '你按固定周期被调用。连续多个周期不采取任何动作是完全正常且正确的。不要为了显得有产出而凭空制造交易。';

const DEFAULT_ENTRY_STANDARDS = [
  '只有当证据足够清楚、清楚到你愿意向一位持怀疑态度的风控经理辩护时，才开仓。每一笔入场都必须有明确的失效位。',
  /*
   * ⚠️ **多空对称这一条必须显式写出来，不能指望模型自己想到。**
   *
   * 实测：机器人连续 204 个周期、成交 6 笔，**全部是 long，
   * 而 `open_short` 作为动作一次都没出现过** —— 而它在 127 条记录的推理里
   * 都谈到了做空。也就是说它**看得见**下跌结构，却只把它们当成"不要碰"。
   *
   * 决定性的一轮：模型对一个 24h −16%、4H 明确下跌的标的说
   * 「**不适合稳健账户**」然后跳过 —— 它是在用"入场标准"这把尺子量一个下跌结构，
   * **而尺子上只刻了向上的刻度。**
   *
   * 所以这里不是"提醒它也可以做空"，而是**把刻度补全**：
   * 做空与做多的条件完全相同，只是方向镜像。
   * 措辞保持对称（不偏向任何一边）—— 反方向的偏置同样是缺陷。
   */
  '**下跌结构与上涨结构是同等质量的交易机会，条件完全相同。** 失效位在上方（前高 / 均线 / 区间上沿）时，止损放在它之外、目标在下方，这就是做空 —— 它的每一道审核标准（失效位清晰、盈亏比、与大周期不冲突）与做多一字不差。**不要因为方向朝下就把它当成"不适合"，那等于白放掉一半的机会。**',
  /*
   * ⚠️ **机会是分档的，不是"合格 / 不合格"两档。**
   *
   * 实测：一个机器人连续 15 个周期、0 笔决策，而每一轮的推理都长达一千多字 ——
   * 它逐个复核了候选、指出具体冲突（大周期与短周期打架、盈亏比够不到 1:3、
   * 正处在超卖反抽的位置），结论一律是"没有一个能让我有底气向风控经理辩护"。
   *
   * **它的推理没问题，缺的是"小仓也是参与"这个选项。** 而它手上明明有权限：
   * `patch.ts` 的守卫里只有 `requireStopLoss` 是结构性的，**盈亏比门槛、置信度门槛、
   * 仓位上限全都可以由它自己调**（设计上就是"完全交给 AI"）。它不调，是因为
   * 提示词把"开仓"定义成了一个要么全达标、要么放弃的二元判断。
   *
   * 把刻度补全：给它**三档**的心智模型。措辞刻意不给死的百分比阈值 —— 具体多大
   * 是它自己的判断（"该给多少"正是要它回答的问题），这里只把"档位存在"这件事说清楚。
   */
  '**机会是分档的，不要在"完美信号"和"放弃"之间二选一。** 一个方向清晰、失效位明确、但形态不漂亮的机会，值得用**小仓**参与；一个多周期共振、失效位极硬的机会，才配得上**接近上限**的仓位。把它们想成三档：**试探 / 标准 / 重仓**——每档对应不同的仓位与不同的证据强度，而不是同一把尺子只量出"过"或"不过"。',
  /*
   * 紧接着要给出**算这笔账所需的两个数**，否则"小仓划不划算"只能靠猜。
   * 其中交易所最低名义（按标的不同）已在硬性约束里说明；这里给的是
   * **往返手续费与止损幅度的比较**——那才是"小仓能不能做"的真正判据。
   */
  '**小仓是否划算，取决于手续费占止损的比例。** 一笔交易的往返成本约为名义价值的 0.1%（见硬性约束里的费率），而止损幅度由你定。名义越小，手续费在"总风险"里占的比重越大 —— 当手续费接近或超过止损本身时，这笔交易在**期望值上就是负的**，无论方向对错。账户权益较小时请把这个比例算出来再决定，**而不是简单地"仓位小就安全"**。',
  '**长期空仓同样是一个需要辩护的决定。** "错过一波不花钱"是真的，但每一轮都在同一个候选池上得出同一个"都不合格"，本身就说明该检查的是**门槛、标的池或你自己的标准**，而不是继续等待 —— 那三样里有两样你可以直接改。',
].join('\n');

/**
 * How many recent points of each series are rendered into the prompt.
 *
 * The indicator *calculations* run over the full candle set so that warm-up is
 * satisfied, but past ~30 points the model gains nothing and the prompt grows
 * linearly with the candidate count.
 *
 * ⚠️ **它同时被系统提示词引用了**（第 10 条那条"每根 K 线都有成本"）。
 * 原来它定义在文件靠后的位置，而提示词在前面 —— 于是提示词只能写死一个
 * 「5–120」（那是 schema 的允许范围），**比真实上限大一倍**：AI 把
 * `promptPoints` 从 30 调到 120，看到的点数一根都不会变，而它会把这记成
 * "我加厚了历史依据"并据此归因。定义必须排在提示词之前，两边才不会各说各话。
 *
 * ## 30 → 120：把"防撑爆"的职责交还给预算裁剪
 *
 * 上面那段只修了**一半** —— 它让提示词**如实说出**上限是 30，却没回答
 * "为什么上限是 30"。而答案是**预算**：这个常量诞生于 `PROMPT_TOKEN_CEILING`
 * 还是 20 万的时候，那时 30 点是合理的。
 *
 * 现在预算按模型能力算（1M 上下文的模型拿到 80 万），实测算过：
 *
 *     4 周期 × 10 条序列 × 120 点 × 10 字符 ≈ 48,000 字符/候选
 *     20 个候选全给满 ≈ 96 万字符 ≈ 56 万 token —— **仍在 80 万预算之内**
 *
 * 所以把这个数抬到**与配置允许范围一致（schema 是 5–120）**：
 * `promptPoints` 与 `primaryCount` 各自仍是各自的约束，而"撑爆"由
 * `buildUserPromptParts()` 那道裁剪循环兜底 —— **那一层才是唯一该管预算的地方**，
 * 这里再叠一个写死的 30 只会把已经算准的预算又砍一刀。
 *
 * ⚠️ 这与 `coins.ts` 里删掉 `hardCap = 40` 是同一个判断：**两层限额里，
 * 写死的那一层总是先咬人，而且咬得没有依据。**
 */
const MAX_RENDER_POINTS = 120;

const DEFAULT_DECISION_PROCESS = [
  '1. 先确定所提供的最高时间周期上的主导趋势。',
  '2. 定位关键结构：最近的波段高低点、价格正在反应的位置、以及流动性聚集处。',
  '3. 检查动能（MACD、RSI），看它是确认价格还是与价格背离。',
  '4. 检查衍生品信息：持仓量在扩张还是在平仓？资金费是否已经拥挤？',
  '5. 对已有持仓，判断原始逻辑是否依然成立。若不成立，就平掉它。',
  /*
   * 第 5 条只说了"不成立就平"，**没说"成立但要更安全"** ——
   * 而后者才是持仓管理的日常。补上这一步，否则 `adjust_protection`
   * 这个动作在提示词里没有出现的位置，模型自然不会想到用它。
   */
  '6. 对已有持仓，还要问一句：**这笔已经走出来的利润，有多少是被保护住的？** 止损还停在最初那个位置的话，浮盈随时可能全部回吐 —— 用 `adjust_protection` 把它提上来（提到成本价或更高，视结构而定）。',
  '7. 对新的入场，先定止损，再定目标，最后确定仓位大小，使止损被扫时的亏损是可以接受的。',
  '8. 如实给出置信度。低于阈值的置信度意味着你根本不应该交易。',
  /*
   * 第 9 步：**候选池本身是可以改的**。
   *
   * 用户实测观察：「做的币种始终是那几个热门币，似乎没有机会很大的山寨币」。
   * 查证结果：候选池按 `coinSource.coinPoolRank` 排，生产上设的是
   * `quote_volume`（成交额榜）—— **天然只有最热门的那些**。
   *
   * 而 `coinSource.*` 本来就在 `set_params` 的可调范围里（排序方式、数量、
   * 成交额与持仓量门槛……都能改）。**能力一直在，缺的是一个去用它的理由。**
   *
   * 这和"只做多"那条是同一个病：**能力存在，但提示词没让它想到要用。**
   */
  '9. **如果连续几轮都在同样的几个标的上找不到机会，问题可能不在标的，而在你怎么选标的。** 候选池的排序方式（`coinSource.coinPoolRank`：成交额、涨幅、跌幅、波动率、资金费极端值）与规模（`coinPoolLimit`）都是你可以用 `set_params` 改的参数。一个按成交额排出来的池子永远是最热门的那几个 —— **而"机会大"往往出现在波动率或资金费极端的那一类里，不是成交额最高的那一类。**',
  /*
   * 第 10 步：**你的输入长度本身是一个可以权衡的成本。**
   *
   * 实测：每轮约 49,700 个 prompt token，而**主体是每个候选标的约 10,200 字
   * 的逐根 K 线数字数组**（7 个候选 ≈ 68,000 字）。这些数字按
   * `indicators.kline.promptPoints` 渲染，**那个值原来写死在代码里**，
   * 现在归你了。
   *
   * ⚠️ **但只讲"成本"是不够的 —— 实测的后果是它从来不动这个参数。**
   *
   * 一个机器人连续多轮候选池只有 7 个标的、0 笔决策，而它的推理长达千余字、
   * 质量很高（逐个复核、指出具体冲突）。问题不在它的判断，在于**它不知道
   * 这笔预算的另一端是什么**：它把"点数"当成纯粹的支出，于是没有理由动它。
   *
   * 真相是**点数和标的数是同一笔预算的两端**：
   *
   *     预算 ≈ 点数 × 标的数 × (每点字符) × (周期数)
   *
   * 把点数减半，同样预算下能看到的候选大约翻倍。而"从更多标的里挑一个"往往比
   * "在少数几个标的上看得更细"更有价值 —— 形态判断要的是"有没有结构"，
   * 不是"小数点后更精确"。所以这一条必须把**两端**都写出来，让它自己权衡。
   *
   * 措辞仍然不给建议值：**"该给多少"正是要它自己回答的问题。**
   */
  '10. **你看到的每根 K 线都是有成本的，而这个成本直接换算成"你能看多少个标的"。** 每个候选标的的指标序列长度由 `indicators.kline.promptPoints` 决定（可设 5–120，当前值可在 `get_current_params` 里读到）—— 但**实际渲染还有一道硬上限：每个序列最多 ' +
    `${MAX_RENDER_POINTS} 根` +
    '**，设得比它大不会让你看到更多。**' +
    /*
     * 这一句是补上的"另一端"。没有它，AI 面对的是一笔纯支出，而纯支出没有
     * 调小的理由 —— 实测它因此从来没动过这个参数。
     */
    '**关键在于：点数和候选标的是同一笔预算的两端 —— 每轮能塞进来的数据量是固定的，' +
    '每个标的占得越多，能看的标的就越少。** 把每个序列的点数减半，同样预算下你能看到的候选' +
    '大约翻倍；反过来，候选只有个位数时，先降点数通常比"接受只能看到这么几个标的"更好。' +
    '**形态判断需要的是"这里有没有结构"，不是"小数点后更精确"** —— 而"从二十个标的里挑一个"和' +
    '"在七个标的里反复找"是完全不同的两种处境。这笔账归你算。',
].join('\n');

/**
 * Assemble the system prompt.
 *
 * Structure mirrors the eight documented sections so that the editable parts
 * (role, frequency, standards, process) stay clearly separated from the parts
 * the runtime owns and the model must never contradict (hard limits and the
 * response format).
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const { config } = ctx;
  const risk = config.riskControl;
  const sections: string[] = [];

  /* 1 — Role ------------------------------------------------------------- */
  sections.push(
    `# 角色\n${config.promptSections.roleDefinition.trim() || (ctx.aiManaged ? AI_MANAGED_ROLE : DEFAULT_ROLE)}`,
  );

  /* 2 — Mode ------------------------------------------------------------- */
  /*
   * ⚠️ **AI 托管时不再注入写死的交易性格 —— 改成把那个判断明确交给它。**
   *
   * `MODE_GUIDANCE` 是**三档写死的行为指令**（进取 / 稳健 / 短线）。对一份固定策略
   * 那是对的：写策略的人选了哪一档，就按哪一档执行。
   *
   * 而 AI 托管模式的全部意义就是**由它自己决定**。给它注入一档，等于把那个判断
   * 拿走 —— 而且会与角色句、以及它自己写的 `entryStandards` 叠成三层
   * （实测 `#9` 的系统提示词里，「保守/稳健」出现了三次）。
   *
   * **换上的那一段不是"不说"，而是"说清这归你"** —— 差别很大：
   *
   *   · 什么都不说 → 它会保留 `MODE_GUIDANCE` 留下的印象（而那是别人的选择）；
   *   · 说「由你判断」→ 它知道**这是它的决定**，也知道**它可以改**。
   *
   * 而"改"是有具体去处的：它自己的 `promptSections.entryStandards` /
   * `tradingFrequency`（用 `set_params` 改，下一轮生效）。所以这里把去处也点明。
   */
  sections.push(
    ctx.aiManaged
      ? [
          '# 交易风格 —— 由你自己判断',
          '当前该偏谨慎还是偏进取，**不是一个固定设定，而是你自己的判断**。市场从趋势转成震荡、或波动率变化时，改变它是对的。',
          '把结论写进你自己的 `entryStandards` / `tradingFrequency`（用 `set_params` 改，下一轮生效）—— 那样它就变成一条你能复查、也能再改的规则，而不是一次性的想法。',
          '注意「谨慎」与「风险上限」是两件事：**风格**决定你多挑、多愿意等；而**杠杆、名义价值、保证金占用、持仓数**这些上限由代码强制执行，与风格无关。',
        ].join('\n')
      : `# ${MODE_GUIDANCE[config.tradingMode]}`,
  );

  /* 3 — Hard constraints ------------------------------------------------- */
  /*
   * ## ⚠️ 标题原来写的是「硬性约束（由代码强制执行，你无法覆盖）」
   *
   * 「无法覆盖」描述的是**运行时行为**（每张订单都会被独立校验和钳制，绕不过去），
   * 但读起来像在说"**这些数字不归你管**"。而实际上下面**每一条都在
   * `StrategyConfig` 里**，全部可以用 `set_params` 调 —— 实测这个机器人自己
   * 就把 `minConfidence` 从 75 挪到过 68。
   *
   * 那半句话造成的后果是具体的：模型可能以为"杠杆上限、单仓上限、最大持仓数"
   * 是外部给定的、只能服从，于是**从不去动它们** —— 而"这个账户太小，
   * 单仓只能到权益的 1 倍"这类约束恰恰是它该主动权衡的对象。
   *
   * 所以改成把两件事分开：
   *   1. **这些值是策略参数，归你调**（然后用 `set_params` 改）；
   *   2. **改完之后由运行时强制**，越界会被拒或被钳，所以别指望写一个超限的值蒙混过去。
   *
   * 并且要**点明唯一那条真的不能动的** —— 否则模型会把"可以调"推广到
   * `requireStopLoss` 上去，试一次被拒一次。
   */
  sections.push(
    [
      '# 硬性约束',
      '**这些数字全部来自你自己的策略配置，归你调 —— 用 `set_params` 改，下一轮就生效。** ' +
        '它们列在这里不是"不可更改的规定"，而是**你当前选定的边界**。',
      '运行时会对你的每一张订单做独立校验与钳制：越界的订单会被拒绝或被静默调整到你设定的范围内。' +
        '所以**改了之后要按改后的值来提案** —— 不能靠写一个超限的数字蒙混过去。',
      '',
      '- 最大同时持仓数：' + `${risk.maxPositions}`,
      `- 最大杠杆（BTC/ETH）：${risk.btcEthMaxLeverage}x`,
      `- 最大杠杆（其他所有标的）：${risk.altcoinMaxLeverage}x`,
      /*
       * ⚠️ **交易所对这个账户的实际授信不在这里渲染** —— 它是**每轮随候选池变化**的
       * （见 `volatileParts` 的「系统状态」区）。放进系统提示词会破坏缓存前缀：
       * 缓存按 system + user 拼接后匹配，而系统提示词一变，后面全部失效。
       */
      /*
       * ⚠️ **保证金模式要告诉它 —— 它决定"一个仓位爆仓会不会吃掉别的仓位"。**
       *
       * 币安默认全仓，而这个系统现在会在**每个标的下第一单之前**把它设成配置的模式。
       * 模型不知道这件事会犯两类错：
       *
       *   · 按**全仓**的直觉去算"我还能再加多少"（全仓下保证金共享，看起来额度更宽）；
       *   · 或者以为某个仓位"反正有整个账户兜着"，于是在它上面下更重的注。
       *
       * 逐仓的语义是：**这一仓最多亏掉它自己的保证金** —— 那是它在评估"这笔最坏
       * 会怎样"时的一个硬事实，和杠杆一样（两者一起决定单仓的最大损失）。
       */
      (risk.marginMode === 'isolated'
        ? '- 保证金模式：**逐仓（isolated）** —— 每个标的单独划保证金，**一笔爆仓最多亏掉它自己的保证金，不会动到别的仓位**。评估单笔风险时按这个算。' +
          '**这个值是系统给的起点，不是规定 —— 你可以按自己的判断改成全仓（`set_params` 改 `riskControl.marginMode`，下一轮生效）。**'
        : '- 保证金模式：**全仓（crossed）** —— 所有仓位共享同一个保证金钱包，**任何一笔亏到爆仓都会吃掉整个合约钱包**。所以仓位规模要按"整账户一起看"来控制，而不是只看单笔。' +
          '**这个值是当前的设定，不是规定 —— 你可以随时用 `set_params` 改回逐仓。**') +
        /*
         * ⚠️ **只写"你可以改"是不够的 —— 缺的是判据。**
         *
         * 实测：AI 的覆盖层里 `marginMode` 与策略基线**一字不差** —— 它从没改过这个
         * 参数，尽管提示词早就写了"这是起点，不是规定"。同一个模式在别处也出现过
         * （`add_to_position` / `reduce_position` 也是"范例都有、0 次使用"）。
         *
         * 所以这里补的是**可操作的判据**，以及一个让它**不能默认滑过去**的动作
         * （复盘时说一句理由）。复盘是低频的，token 代价可控；而"每轮都说"会很贵。
         */
        '**什么时候值得考虑改成全仓**：同时持有 2 个以上仓位、且它们各自占用的保证金加起来明显小于钱包余额时 —— ' +
        '全仓让保证金共享，少一个仓位被单独打爆。' +
        '**什么时候保持逐仓**：单笔仓位相对账户偏大、或你想让每个标的的亏损严格隔离时。' +
        '**每次复盘时用一句话说明你维持（或改变）它的理由** —— 这个维度默认滑过去，就等于没人在管。',
      /*
       * ⚠️ **这个字段以前完全没出现在提示词里 —— 而它是可调的。**
       *
       * `priceProtectOnStop` 是限价入场那一轮加的（把写死的 `priceProtect: true`
       * 改成配置项）。当时的实测教训是：`priceProtect: true` 会让**极端行情下的
       * 止损不触发**，所以默认值改成了 `false`。
       *
       * 而那次只改了代码，**没有让它出现在提示词里** —— 于是得到一个
       * 「**AI 能改、而 AI 不知道它存在**」的参数。它永远不会调它，因为它不知道
       * 有这个东西。**那在效果上比写死更糟**：写死至少是一个明确的决定，而这是
       * 一个没人知道的选择。
       */
      `- 止损单的「触发价格保护」（riskControl.priceProtectOnStop）：当前**${risk.priceProtectOnStop ? '开启' : '关闭'}**。` +
        (risk.priceProtectOnStop
          ? '开启时交易所只在价格**穿过**触发价后才下单，能挡掉插针导致的误触发；代价是**极端行情下止损可能不触发**。'
          : '关闭时价格一碰到触发价就立即下单 —— 极端行情下更容易成交，代价是插针时可能被扫。') +
        '**这个值由系统给的起点，不是规定 —— 你可以按自己的判断改（`set_params`，下一轮生效）。**',
      /*
       * ⚠️ **这条必须告诉它当前值 —— 否则它会与保本守卫打架。**
       *
       * `breakevenTriggerPercent` 是保本守卫的触发线：浮盈到这个百分比时，
       * 运行时会**自动把止损移到开仓价**。而 AI 改过这个字段（`#18` 设成了 1），
       * 所以它知道它存在 —— 但提示词里从来没写过**当前值**。
       *
       * 后果是具体的：它会看到止损"自己动了"，可能以为是哪个环节错了，于是用
       * `adjust_protection` 去"修正" —— 而下一轮守卫又会移一次。
       * **两方来回改同一个止损位，而它每次都要花一次决策预算。**
       *
       * ⚠️ **口径也要写清 —— 这是同一类问题的第二次，而代价更大。**
       *
       * 2026-09-22 实测（`#95` XRPUSDT 5x）：复盘回执里印的是一个裸的
       * "最大浮盈 3.146%"，而它是**对保证金**的口径。模型按最近的那个口径
       * （同一段里「价格变动」是价格口径）去读，反算出 **1.5606** 这个
       * 从未出现的价格（真实最高 1.5318），于是判定一张**从未被触及**的止盈单
       * 该兑现却没兑现，并据此去改离场逻辑。
       *
       * **一个不带口径的百分比，会被按离它最近的那个口径读。**
       * 而这里更隐蔽：`breakevenTriggerPercent` 的语义本身就是对保证金的口径
       * （`shouldMoveStopToBreakeven` 拿 `unrealizedPnlPercent` 跟它比），
       * 所以 AI 设 1 时以为是"价格涨 1%"，实际是"价格涨 1/杠杆"。
       */
      risk.breakevenTriggerPercent > 0
        ? `- 保本止损：当某个仓位的**保证金浮盈**达到 **${risk.breakevenTriggerPercent}%** 时，运行时会**自动把它的止损移到开仓价**（只能往有利方向移，永不回退）。` +
          `⚠️ **口径是"对保证金"的、含杠杆** —— 折合价格变动 = ${risk.breakevenTriggerPercent} ÷ 该仓位的杠杆，` +
          `所以 3x 时约合价格 ${(risk.breakevenTriggerPercent / 3).toFixed(2)}%、5x 时约 ${(risk.breakevenTriggerPercent / 5).toFixed(2)}%。` +
          '**杠杆越高，这条线在价格上离入场价越近**，越容易被一次正常回踩触发 —— 调它时按你实际会用的杠杆去算。' +
          '所以你看到止损被移动过，**那是这条规则做的，不是你错了** —— 不要为此去调整它，除非你有别的理由。' +
          '**这个值归你（`set_params` 改，0 = 关闭）—— 嫌它太早或太晚，就改它。**'
        : '- 保本止损：**已关闭**（`riskControl.breakevenTriggerPercent = 0`）—— 运行时不移动止损。**这条规则归你，需要就开（`set_params`）。**',
      `- 单仓名义价值上限（BTC/ETH）：账户权益的 ${risk.btcEthMaxPositionValueRatio} 倍`,
      `- 单仓名义价值上限（其他所有标的）：账户权益的 ${risk.altcoinMaxPositionValueRatio} 倍`,
      /*
       * ⚠️ **配置下限不是全部。**
       *
       * 实际门槛是 `max(minPositionSize, 交易所该标的的最小名义)`（见 `risk/engine.ts`
       * 的 `effectiveMin`）。交易所那一侧按标的差别很大 —— BTC 与 ETH 明显更高、
       * 山寨较低。原来提示词只给一个配置下限，于是模型照着它提金额，在 BTC 上
       * **必然被拒**，而它无从预先算出来：每个新标的都要浪费一次决策机会去试。
       *
       * 不把每个标的的数字拼进这里（那要改快照类型、组装与渲染三处），而是
       * 把**事实**说清楚：门槛可能更高，被拒的理由会回来。被拒记录本来就回喂
       * （那套机制是好的），模型据此能自己学到每个标的的量级。
       */
      `- 单笔最小名义价值：${risk.minPositionSize} USDT`,
      '- **每个标的在交易所那边还有自己的最小名义，实际门槛取这两个数里的较大者** —— BTC/ETH 明显更高、山寨较低。按上面这个配置下限提金额，在主流的几个标的上可能直接被拒。拿不准时宁可提大一点。',
      `- 最大保证金占用：权益的 ${risk.maxMarginUsage}%`,
      /*
       * ⚠️ **这条原来只有一行数字，而实测它没有形成约束。**
       *
       * 实测 `#120` / `#121` 连着两轮提了**盈亏比 0.68 与 0.74** 的做多单
       * （止损远、止盈近 —— 在做多里刚好是反的），两次都被风控拒。
       *
       * 反解出来的数字长这样：
       *
       *     SOLUSDT  市价 119.76   上行 1.19 / 下行 1.61   → 1:0.74
       *     BNBUSDT  市价 812.54   上行 12.96 / 下行 19.04 → 1:0.68
       *
       * 也就是说：**它把止损放在结构位之外（较远）、而把止盈放在最近的那个阻力
       * （较近）** —— 两个都"有道理"，合起来却不达标。而那种单**即使方向做对了
       * 也是亏的**。
       *
       * 所以这条要说三件事，缺一不可：
       *
       *   1. **算法**：分母是"当前市价到止损"，分子是"当前市价到止盈"——
       *      按**现在这个价**算，不是按你心里的理想入场价（那笔单还没挂呢）；
       *   2. **形状**：做多时**止损近、止盈远**；做空镜像。反过来的单先别写；
       *   3. **先算后写**：写下止盈之前先除一下，不够就**换机会**而不是硬提 ——
       *      硬提只会被拒，那一轮就白跑了。
       */
      `- **新开仓的最低盈亏比：1:${risk.minRiskRewardRatio}**（按**当前市价**算：分子是市价到止盈的距离，分母是市价到止损的距离）。`,
      `  ⚠️ **别按你心里那个理想入场价算** —— 除非你同时写了 \`entry_type: "limit"\` 与 \`limit_price\`（那时风控才会按挂单价衡量）。`
        + `做多时**止损近、止盈远**，做空镜像 —— 反过来（止损远、止盈近）的单子先别写。`
        + `**写下止盈之前先除一下**：不够 1:${risk.minRiskRewardRatio} 就换一个机会，硬提只会被拒、那一轮就白跑了。`,
      feeAwareStopConstraint(risk, ctx.memory.performance.roundTripFeeRate),
      `- 开仓所需的最低置信度：${risk.minConfidence}/100`,
      /*
       * ⚠️ 这两条原来写的是「没有止损的开仓会被拒绝」—— **而那是不成立的**。
       *
       * `reviewOpen` 里的拒绝分支要求 `fallbackStopLossPercent <= 0`，而那个字段的
       * schema 是 `min(0.05)`：**它永远不可能 ≤ 0，那条分支不可达**。实际行为是
       * 按兜底比例补一个止损然后照常开仓。
       *
       * 于是模型读到一句它无法验证的承诺（"会被拒绝"，那还暗示它可以试探），
       * 而系统实际上是在**一个它从未选择的价位**上开出了真仓 —— 那个止损与它
       * 自己的失效位论证毫无关系。
       *
       * 说真话比空承诺更有约束力：**把后果讲清楚**（"等于把这一笔的风险控制
       * 交了出去"），模型才有理由每次都自己写。
       */
      risk.requireStopLoss
        ? `- 每一笔开仓都必须带止损。**如果你没给，系统会按配置的兜底比例 ${risk.fallbackStopLossPercent}% 自动补一个 —— 那个价位与你的失效位论证无关，等于把这一笔的风险控制交了出去。** 所以永远自己写。`
        : '- 强烈建议每一笔开仓都带止损。',
      risk.requireTakeProfit
        ? `- 每一笔开仓都必须带止盈。**如果你没给，系统会按配置的兜底比例 ${risk.fallbackTakeProfitPercent}% 自动补一个。** 所以永远自己写。`
        : '- 建议每一笔开仓都带止盈。',
      /*
       * ⚠️ **必须点明"唯一那条真的不能改的"。**
       *
       * 上面刚说完"这些数字全部归你调"，如果不补这一句，模型会把那个结论推广到
       * `requireStopLoss` 上 —— 试一次被守卫拒一次，浪费一轮完整的工具预算
       * （而它每一轮都在省着用）。被拒的记录现在会留痕了，但它不该靠撞墙才知道。
       *
       * `requireTakeProfit` 与它不同：**那条是可以关的**（它是偏好，不是结构），
       * 所以两者要分开说，不能合成一句"止损止盈都不能关"。
       */
      '- ⚠️ **上面所有值里，只有"开仓必须带止损"这一条你改不了** —— 它是结构性守卫，' +
        '请求关闭会被整体拒绝（一个没有保护的杠杆仓位可以在几秒内亏掉全部保证金，' +
        '那不是一种策略选择）。**其余每一条（含止盈要求、杠杆、单仓上限、各类门槛）都可以用 `set_params` 改。**',
      '- 同一时间每个标的至多一个仓位。',
      `- 开仓节流：每个周期最多 ${config.throttle.maxEntriesPerCycle} 个新仓位，每小时最多 ${config.throttle.maxEntriesPerHour} 个。`,
      config.throttle.minHoldMinutes > 0
        ? `- 新开的仓位在 ${config.throttle.minHoldMinutes} 分钟内不能被平掉。`
        : '',
      config.throttle.reentryCooldownMinutes > 0
        ? `- 平掉某个标的之后，${config.throttle.reentryCooldownMinutes} 分钟内不能再次入场该标的。`
        : '',
      config.drawdownGuard.enabled
        ? `- 回撤守卫：当某个仓位的**保证金浮盈**超过 ${config.drawdownGuard.activationPercent}% 后，若回吐达到峰值的 ${(config.drawdownGuard.givebackRatio * 100).toFixed(0)}%，运行时会自动平掉它。` +
          '⚠️ 口径同上（**对保证金**、含杠杆）—— 折合价格变动 = 上面的数 ÷ 该仓位的杠杆。' +
          `3x 时 ${config.drawdownGuard.activationPercent}% 约合价格 ${(config.drawdownGuard.activationPercent / 3).toFixed(2)}%、5x 时约 ${(config.drawdownGuard.activationPercent / 5).toFixed(2)}%。` +
          '**"回吐达到峰值"那部分是比值，与口径无关**（分子分母同一个口径，杠杆会约掉）。'
        : '',
      config.circuitBreaker.maxDailyLossPercent > 0
        ? `- 单日亏损熔断：若当日已实现亏损超过权益的 ${config.circuitBreaker.maxDailyLossPercent}%，所有新开仓会停止直到次日。`
        : '',
      config.circuitBreaker.maxTotalDrawdownPercent > 0
        ? `- 总回撤熔断：若权益较历史最高水位回撤达到 ${config.circuitBreaker.maxTotalDrawdownPercent}%，所有新开仓会停止。`
        : '',
      '',
      '仓位大小用 `position_size_usd` 表示，含义是这笔仓位的**名义价值**（数量 × 价格），不是保证金。实际占用的保证金 = 名义价值 / 杠杆。',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  /* 4 — Frequency -------------------------------------------------------- */
  sections.push(
    `# 交易频率\n${config.promptSections.tradingFrequency.trim() || DEFAULT_FREQUENCY}`,
  );

  /* 5 — Entry standards -------------------------------------------------- */
  sections.push(
    `# 入场标准\n${config.promptSections.entryStandards.trim() || DEFAULT_ENTRY_STANDARDS}`,
  );

  /* 6 — Decision process ------------------------------------------------- */
  sections.push(
    `# 决策流程\n${config.promptSections.decisionProcess.trim() || DEFAULT_DECISION_PROCESS}`,
  );

  /*
   * 6.5 — 输出空间 ------------------------------------------------------
   *
   * ## 为什么必须主动说这件事
   *
   * 实盘观察：这台机器人给**自己**定了一条规则
   * （写在它自己维护的 `promptSections.decisionProcess` 里）：
   *
   *     「⚠️ 输出预算很紧：分析文字总计不超过 150 字，且以保证决策 JSON
   *       完整可解析为第一优先 —— 历史上已出现过整轮因输出被截断而报废」
   *
   * **那句话在写下的时候是对的**：当时 `ai_models.max_tokens = 16384`，
   * 而推理（实测峰值 28,590）与正文**共享**这个额度 —— 实测有 **8 次**
   * `completion_tokens` 正好等于 16384，也就是正文一个字都没剩下。
   *
   * **但现在前提变了**：`MIN_MAX_TOKENS_FOR_REASONING` 已把实际输出上限抬到
   * **131,072**（见 `manager.ts` 上那份实测）。而**它不会自己知道这件事** ——
   * 于是它继续按一个已经不存在的限制压缩分析。
   *
   * **一条过时的自我约束比没有约束更糟**：它让人（和模型）以为自己省下了什么，
   * 实际上只是在降低判断质量。用户的要求是「**最大化发挥模型能力**」。
   *
   * ## 措辞的分寸
   *
   * 不写"写得越长越好" —— 长度不是目标，**完整的推理**才是。所以这里同时给出
   * 另一半：真正会毁掉一轮的只有**决策 JSON 不完整**，而那与文字长短无关。
   */
  sections.push(
    [
      '# 你的输出空间',
      '',
      '单次输出**至少**有 **131072 tokens**（约 8 万汉字）可用 —— **其中包含你的思考过程**。',
      '（这是运行时保证的下限；模型本身可能给得更多。）在推理之外，留给正式分析的空间仍然很大。',
      '',
      '⚠️ **这条是最近才变化的事实**：2026-09-24 之前，这个上限是 16384，那时',
      '"推理把输出额度全部吃光、正文一个字不剩"真实发生过（库里有 8 次记录）。',
      '如果你曾经为此给自己定过"分析不超过多少字"之类的限制，**那条限制的前提',
      '已经不成立** —— 该写长就写长。',
      '',
      '但长度本身不是目标：**内容完整**才是。唯一会真正毁掉一轮的，是 `<decision>`',
      '块里的 JSON 不完整或不可解析 —— 那与文字长短无关。',
    ].join('\n'),
  );

  /* 7 — Output format (fixed) ------------------------------------------- */
  sections.push(
    [
      '# 输出格式要求',
      '只输出两个 XML 块，不要有任何其他内容。',
      '',
      '第一个是你的思考过程。一步步推演市场，以及每一个持仓和候选标的。这是你的思维链，会被记录下来供账户所有者审计。',
      '',
      '<reasoning>',
      '你的逐步分析。',
      '</reasoning>',
      '',
      '第二个是你的决策，放在 `<decision>` 块内的 JSON 数组里。如果你不采取任何动作，就返回空数组：`[]`。',
      '',
      '<decision>',
      '```json',
      '[',
      '  {',
      '    "symbol": "BTCUSDT",',
      '    "action": "open_long",',
      /*
       * ⚠️ **两个范例的杠杆刻意不同。**
       *
       * 原来两处都是 `risk.defaultLeverage`（同一个值）—— 于是模型看到的永远是一个
       * 固定的数字，它照抄就完事了。实测：11 次开仓、杠杆 100% 是 3x，一次没变。
       *
       * 现在做多那个用**上限**（"证据齐全时可以用满"）、做空那个用**上限的一半**
       * （"把握一般时降下来"）—— 让模型看见**同一个字段有两个不同的合法取值**，
       * 那才叫"它是个变量"。
       */
      `    "leverage": ${risk.btcEthMaxLeverage},`,
      '    "position_size_usd": 150.00,',
      '    "stop_loss": 64200.00,',
      '    "take_profit": 68900.00,',
      '    "confidence": 82,',
      '    "risk_usd": 12.50,',
      '    "reasoning": "用一两句话说明这笔具体交易的理由。"',
      '  }',
      ']',
      '```',
      '</decision>',
      '',
      /*
       * ⚠️ **做空也要给一个范例，而且与做多那个同等详细。**
       *
       * 实测：204 个周期、6 笔成交**全是 long，`open_short` 一次都没出现过** ——
       * 而上面那段是模型在整份提示词里看到的**唯一一个完整范例**。
       * 范例对输出形状的锚定作用比措辞强得多：只见过做多样例的模型，
       * 默认就照着做多的形状去填。
       *
       * 注意止损/止盈的**方向是镜像的**：做空的失效位在上方（止损 > 入场）、
       * 目标在下方（止盈 < 入场）。**范例自己把镜像关系摆清楚就够了** ——
       * 不需要额外叮嘱，那反而会显得做空是需要特别许可的例外。
       */
      '做空是同样的形状，只是止损与止盈的方向相反：',
      '```json',
      '[',
      '  {',
      '    "symbol": "ETHUSDT",',
      '    "action": "open_short",',
      /* 与做多那个刻意不同：把握一般时把杠杆降下来。见上一段范例的说明。 */
      `    "leverage": ${Math.max(1, Math.floor(risk.altcoinMaxLeverage / 2))},`,
      '    "position_size_usd": 150.00,',
      '    "stop_loss": 2680.00,',
      '    "take_profit": 2410.00,',
      '    "confidence": 78,',
      '    "risk_usd": 12.50,',
      '    "reasoning": "失效位在 2680 上方（前高 / 4H EMA20），止损放它之外，目标在下方。"',
      '  }',
      ']',
      '```',
      '',
      /*
       * ⚠️ **入场方式也要有范例 —— 同一个理由，第四次。**
       *
       * 这个文件里已经为同一条规律写过三次注释（做空范例、`wait`/`hold` 范例、
       * 仓位管理三个动作的范例）：**范例对输出形状的锚定作用比措辞强得多。**
       * 只见过市价开仓范例的模型，不会想到还有另一种入场方式 —— 哪怕规则里写了。
       *
       * 而这一条尤其要紧，因为**限价挂单是真实交易员的标准做法**：分析完行情之后
       * 预测一个区间、在那儿等着，而不是立刻市价吃进去（后者付 taker 费、吃滑点）。
       *
       * ## 范例怎么组成的
       *
       * · `limit_price` 是**低于现价**的买价（做空则相反）—— 高于现价会立即成交，
       *   那就不是"挂单等"了，系统会按市价处理并在日志里说明；
       * · **止损止盈照常给**，而且**照常按现价衡量盈亏比**（风控就是这么算的，
       *   它不知道也不该知道这笔将来挂在哪儿）—— 挂单时它们挂不上去，但**成交
       *   那一刻会立刻用它们挂保护单**，所以在决策里必须给全。
       */
      '如果你判断价格会**回踩到某个区间**再继续，那就挂限价单在那儿等，而不是现在市价追进去：',
      '```json',
      '[',
      '  {',
      '    "symbol": "SOLUSDT",',
      '    "action": "open_long",',
      '    "entry_type": "limit",',
      `    "limit_price": 148.50,`,
      `    "leverage": ${risk.altcoinMaxLeverage},`,
      '    "position_size_usd": 150.00,',
      '    "stop_loss": 144.20,',
      '    "take_profit": 162.00,',
      '    "confidence": 76,',
      '    "risk_usd": 12.50,',
      '    "reasoning": "15m 放量后回踩，148.5 是前一段的成交密集区。挂在那儿等，不追高；成交后系统会自动按上面的止损止盈挂保护单。"',
      '  }',
      ']',
      '```',
      '**"挂单等"与"市价追"是两种工具，按机会的性质选**：价格已经启动、晚一步就没了 → 市价；'
        + '有一个明确的技术位、愿意等它回来 → 限价。**追高与等待都要付代价**，选哪种是你的判断，'
        + '但要知道两种都可用。挂上去之后**这一轮不会建仓**，成交时系统会转成持仓并挂上保护单。',
      /*
       * ⚠️ **时限必须说出来，而且要说清"谁负责"。**
       *
       * 系统有一条机械规则：挂满 N 分钟没成交就自动撤（`pendingEntryTimeoutMinutes`）。
       * 不说的话模型会以为那张单会一直等着 —— 而它可能在某个周期里发现
       * "我挂的单不见了"，却不知道为什么。
       *
       * 同时要说清分工：**这条规则是兜底，不是它的替代品**。它看到理由不成立时
       * 应该立刻撤（那比等时限更早、更准）；时限只负责它没想到的情况。
       */
      `⏱ **系统有一条兜底时限：挂满 ${risk.pendingEntryTimeoutMinutes} 分钟仍未成交的限价单会被自动撤掉**`
        + (risk.pendingEntryTimeoutMinutes > 0
          ? '（可在 `get_current_params` 里读到、也能通过 `set_params` 改）。'
          : '。')
        + '说清分工：**那条规则只负责你没想到的情况** —— 你看到理由不成立了应该立刻撤，'
        + '比等时限更早；而当你没顾上看它时，时限保证它不会一直占着持仓名额。',
      '',
      /*
       * ⚠️ **撤单也要有范例 —— 否则"挂单"是一扇单向门。**
       *
       * 模型能挂单、能看见它在等，而**改不了它**。于是出现这种局面：一张单挂了很久、
       * 当初的理由早已不成立（结构破了、价位被甩开），而它**只能干看着** ——
       * 那张单占着持仓名额，机会成本一直在流。
       *
       * 与前面几个范例同一条规律：**范例里没有的动作，模型不会写。**
       */
      '挂上去之后如果你认为**这笔不该再等下去了**（当初的理由不成立、价位被甩开、或等得太久），就撤掉它：',
      '```json',
      '[',
      '  {',
      '    "symbol": "SOLUSDT",',
      '    "action": "cancel_pending",',
      '    "reasoning": "挂了两小时没成交，而 4H 结构已经转空 —— 当初挂单的理由不成立了，撤掉腾出名额。"',
      '  }',
      ']',
      '```',
      '撤单**只释放风险**（那张单成交就会变成持仓），所以它不过开仓那批上限、也不会被节流拦住。'
        + '**但别把它当习惯动作** —— 挂之前想清楚价位，挂之后给它时间。一张单刚挂上就撤，'
        + '等于凭空付了一次判断的代价。',
      '',
      /*
       * ⚠️ **"不动"也要有范例，而且 `confidence` 一个都不能少。**
       *
       * 实测：机器人连续多轮输出的每条决策都只有三个字段
       * （`symbol` / `action` / `reasoning`）—— **`confidence` 整份输出里一次都没出现**。
       * 于是解析器填了 `0`，界面上每个决策都显示「置信度 0%」，看起来像"模型对
       * 每个判断都毫无把握"；而风控那边拒绝开仓时会说"置信度 0 低于 68"，
       * **把"漏填字段"说成了"信心不足"**。
       *
       * 原因就在上面：两个范例都是**开仓**动作。`wait` / `hold` 这些"不动"的决策
       * 没有范例可照，模型就自由发挥了。**范例对输出形状的锚定作用比措辞强得多**
       * —— 这个文件里为"只做多"加做空范例时，写的就是同一条道理。
       */
      '**"不做任何动作"时同样给出完整字段，一个都不能省** —— 尤其是 `confidence` 与 `setup_score`：',
      '```json',
      '[',
      '  {',
      '    "symbol": "SOLUSDT",',
      '    "action": "skip",',
      '    "setup_score": 41,',
      '    "setup_score_basis": "15m 与 1h 方向冲突、波动率收敛，四条入场标准一条都不满足",',
      '    "confidence": 35,',
      '    "reasoning": "15m 与 1h 方向冲突，且波动率在收敛 —— 结构不成立。把握 35 分，远低于门槛。"',
      '  }',
      ']',
      '```',
      '',
      /*
       * ⚠️ **每个候选标的都要有一条，包括你决定不做的那些。**
       *
       * ## 为什么（用户的原话：「复盘不够智能」）
       *
       * 实测：一个 24h +94%、成交额排全市场第 12 的标的，连续五轮被写进
       * "抛物线、4h RSI 90+、追高禁区，排除"—— 而 `decisions_json` 里
       * **关于它一条记录都没有**。
       *
       * 后果不是"它漏看了"（它看得见，也读了自己的复盘工具），而是：
       * **它的入场门槛从来没有被校准过**。工具能告诉它"这些标的后来涨了"，
       * 但回答不了真正的问题 ——「我的线是不是划高了」，因为**没有"线"这个数**。
       *
       * 所以：**对每一个进你视野的候选标的都给一个 `setup_score`**，
       * 用 `action: "skip"` 表示"看过、不做"。分数落在库里之后，
       * 你才能在复盘时算出来：我否掉的那批平均多少分、开仓的那批平均多少分、
       * 而**后来涨了很多的那些当时是多少分**。那是唯一能校准这条线的证据。
       *
       * ## 分数是你自己的标准，不是系统给的
       *
       * 系统**不定义**什么叫 80 分，也不拿它卡单 —— 开不开仍由你的规则与风控决定。
       * 你可以在 `entryStandards` 里自己写清楚评分口径（那本来就是你改的）。
       * 唯一的纪律是：**同一套口径要能横着比** —— 别让 70 分在 A 标的意味着
       * "很有机会"、在 B 标的意味着"还差点"，那这个数就白记了。
       *
       * ## 一条重要的区分
       *
       * · `setup_score` 说的是「**这个标的本身**有多符合我的入场标准」
       * · `confidence` 说的是「我对我这个**决策**有多确定」
       *
       * 一个你已经持有的、正在 `hold` 的标的，`setup_score` 可能只有 55
       * （它当初达标、现在结构变差了）而 `confidence` 是 72（你对"继续持有"很确定）。
       * 两个数不矛盾，它们回答不同的问题。
       */
      '⚠️ **每一个候选标的都要有一条决策，包括你不做的那些** —— 不做的用 `action: "skip"`，',
      '并且**同样要给 `setup_score`**（0–100，你自己的标准）与一句话的 `setup_score_basis`。',
      '只有落了库，你以后才可能知道自己那条线划得对不对。范例：',
      '```json',
      '[',
      '  {',
      '    "symbol": "MUBARAKUSDT",',
      '    "action": "skip",',
      '    "setup_score": 58,',
      '    "setup_score_basis": "趋势极强，但 4h RSI 92、价格偏离 EMA20 达 11%，止损无处可放、盈亏比算不出来",',
      '    "confidence": 70,',
      '    "reasoning": "抛物线中段，追进去的失效位太远 —— 把握 70 分地认为**现在**不该进，但值得继续跟踪回踩。"',
      '  }',
      ']',
      '```',
      '',
      '`wait`（**挂着的限价单在等成交** —— 与 `skip` 不是一回事）同样要给全字段：',
      '```json',
      '[',
      '  {',
      '    "symbol": "XRPUSDT",',
      '    "action": "wait",',
      '    "setup_score": 71,',
      '    "setup_score_basis": "趋势未破、回踩位仍在，但现价超买不宜追",',
      '    "confidence": 66,',
      '    "reasoning": "挂单 1.5510 的回踩逻辑仍成立，继续等；把握 66 分。"',
      '  }',
      ']',
      '```',
      '',
      '`hold`（维持已有仓位）的字段形状相同，也**必须**带 `confidence`：',
      '```json',
      '[',
      '  {',
      '    "symbol": "ETHUSDT",',
      '    "action": "hold",',
      '    "setup_score": 74,',
      '    "setup_score_basis": "三周期仍同向，但动量在衰减",',
      '    "confidence": 72,',
      '    "reasoning": "趋势仍成立、未触及失效位，继续持有；把握 72 分。"',
      '  }',
      ']',
      '```',
      '',
      /*
       * ⚠️ **三个仓位管理动作原来只有文字说明、没有范例 —— 于是它们一次都没被用过。**
       *
       * 实测（机器人 #9 跑了几十轮之后的全量决策记录）：
       *
       *     wait              129 次
       *     hold               55 次
       *     open_long          11 次
       *     adjust_protection   3 次   ← 只有 3 次，对比 55 次 hold
       *     close_long          1 次
       *     open_short          0 次
       *     add_to_position     0 次
       *     reduce_position     0 次
       *
       * 而它自己在复盘里写的是（`agent_memory`，原话）：
       *
       *   · 「入场逻辑可复用，**问题出在移损/止盈规则过松**」
       *   · 「浮盈一度达 1.486% 却**全程未上移保护位**，最终回吐至 -0.980%」
       *   · 「直接原因是**出场而非入场**：最大浮盈 2.522% 回吐到 +0.826%」
       *
       * **它诊断对了病，却没有药** —— 而药就在这三个动作里，只是范例里没有它们的形状。
       * 这个文件上面那段注释已经写过同一条规律（为"只做多"补做空范例时）：
       * **范例对输出形状的锚定作用比措辞强得多。** 同一个坑，这是第三次踩。
       *
       * 三个范例都刻意带上**具体的数字**（把止损移到哪、减多少），因为笼统的
       * "可以移动保护位"正是原来那句话没起作用的原因。
       */
      '',
      '**仓位管理：这三个动作同样有固定形状，`hold` 不是唯一的选择。**',
      '',
      '① 浮盈之后**把止损上移到成本价之上**（保本 / 锁盈）—— 这是防止"浮盈回吐"的',
      '主要手段，也是专业交易员每笔都在做的事：',
      '```json',
      '[',
      '  {',
      '    "symbol": "ETHUSDT",',
      '    "action": "adjust_protection",',
      '    "stop_loss": 2700.00,',
      '    "confidence": 74,',
      '    "reasoning": "浮盈 3%，把止损从 2655 上移到 2700（成本 2660 之上）—— 这笔最坏结果变成不亏。"',
      '  }',
      ']',
      '```',
      '',
      '② 结构开始走坏、但还没跌破止损时**先减一半**，让剩下的继续跑：',
      '```json',
      '[',
      '  {',
      '    "symbol": "ETHUSDT",',
      '    "action": "reduce_position",',
      '    "reduce_percent": 50,',
      '    "confidence": 70,',
      '    "reasoning": "15m 动量转负但 1h 仍多头 —— 先落袋一半，剩下那半看 1h 能否守住。"',
      '  }',
      ']',
      '```',
      '',
      '③ 已经走出利润、结构依然成立时**加一点**（增量名义，不是总量）：',
      '```json',
      '[',
      '  {',
      '    "symbol": "ETHUSDT",',
      '    "action": "add_to_position",',
      '    "position_size_usd": 15.00,',
      '    "confidence": 76,',
      '    "reasoning": "突破回踩确认、量能配合 —— 加 15 USDT 名义，止损同步上移。"',
      '  }',
      ']',
      '```',
      '',
      '字段规则：',
      '- `symbol`：必须与候选区中列出的完全一致，例如 `BTCUSDT`。',
      '- `action`：取值为 `open_long`、`open_short`、`close_long`、`close_short`、`adjust_protection`、`add_to_position`、`reduce_position`、`hold`、`wait`、`cancel_pending`、`skip` 之一。`skip` = **看过、不做**（照样要给 `setup_score`）。',
      '  - `close_long` / `close_short` 会平掉该方向上的整个现有仓位。平仓时不要附带 `leverage`、`position_size_usd`、`stop_loss` 或 `take_profit`，它们会被忽略。',
      '  - `adjust_protection`：**移动一个已有持仓的止损或止盈**（不改数量、不占保证金）。带上新的 `stop_loss` 和/或 `take_profit`（绝对价格），其余字段会被忽略。',
      '    - **这是你管理已有仓位的主要手段。** 一笔已经走出利润的仓位，把止损提到成本价或更高，等于把这笔交易变成"最坏情况不亏"——**这是专业交易员每天在做的事，而不做它意味着浮盈随时可能全部回吐。**',
      '    - 止损只能朝有利方向移动（多头往上、空头往下）；反向移动会被拒绝。',
      '    - 止损距现价必须 ≥ 往返成本的若干倍（见硬性约束），否则会被拒绝——太近的止损会被正常波动扫掉。',
      '  - `add_to_position`：**在一个已有持仓上同向加仓。** 带上 `position_size_usd`（要加的**增量**名义，不是总量）。',
      '    - **这是你把握"机会来了"的手段。** 一笔已经走出利润、结构依然成立的仓位，加仓是把赢面变大的方式 —— 但**代价是同一标的的敞口变大**，所以要克制。',
      '    - 加仓后均价会重算成加权平均，保护单会按新数量自动重挂，**你不需要操心这两件事**。',
      '    - 它与新开仓共用同一批上限（杠杆、单仓名义上限、保证金占用、节流）——**额度不够时它会被拒**。',
      '  - `reduce_position`：**平掉一个已有持仓的一部分。** 带上 `reduce_percent`（1–100 的百分比）或 `reduce_quantity`（具体数量），两个都给时以数量为准。',
      '    - **这是你保护浮盈的另一种手段**：当结构开始走坏但还没跌破止损时，先减一半，让剩下的那半继续跑 —— 比"全平"和"死等"都更接近专业做法。',
      '    - 减仓**不改均价**（卖掉一部分不改变剩余部分当初的买入价），剩余部分的保护单会按新数量自动重挂。',
      '    - 减完之后剩余的不能低于该标的最小下单量 —— 否则那个残仓既挂不了保护单也减不动。要清干净请用 `close_long` / `close_short`。',
      '  - `hold` 表示"维持现有仓位不变"。`wait` 表示"这里没有仓位，不做任何事"。',
      /*
       * ⚠️ **杠杆要按"这笔机会有多好"来选，不是每次都填同一个数。**
       *
       * 原来这一行只写「不得超过该标的的硬性上限」，而上面两个开仓范例里
       * `"leverage"` 是模板插进去的 `risk.defaultLeverage` —— **一个固定的数字**。
       *
       * 实测后果：机器人跑了几十轮、11 次开仓，**杠杆 100% 都是 3x**，一次没变过。
       * 而那个 3 恰好等于当时策略配的上限（`btcEthMaxLeverage: 3`）—— 说明模型
       * 是**照抄了范例的形状**，而不是判断"这笔值得用多少"。
       *
       * 提示词里其实**列了上限**（上面的硬性约束区有「最大杠杆（BTC/ETH）：Nx」），
       * 所以它不是"不知道能改"，是**没有理由去改** —— 范例没给它一个"变量"的印象。
       *
       * 这一段给它那个理由，并说明**低杠杆也是一种选择**（这一点很重要：原来那句话
       * 只说了"不许超过上限"，读起来像"越大越好、顶格填即可"）。
       */
      '- `leverage`：**整数，按这笔机会的质量自己选，不要每次都填同一个数。** 上限见硬性约束区（BTC/ETH 与其它标的各有一条）。',
      '  - **依据是这笔交易的把握与波动**：三条以上独立证据、且止损位清晰 → 可以用到上限；',
      '    证据勉强够、或标的波动很大（止损会被正常波动扫掉）→ **用更低的杠杆**，那是防守，不是保守。',
      '  - 杠杆只影响**同样的价格波动放大成多大的盈亏**，不改变方向判断。**高杠杆不会让一笔坏交易变好，只会让它更快爆掉。**',
      '  - 杠杆上限是**账户所在交易所的实际限制**与**策略配置**里更小的那一个 —— 超过会被直接拒单。',
      '- `position_size_usd`：以 USDT 计的名义价值，介于最小名义价值与该标的上限之间。',
      '- `stop_loss` / `take_profit`：绝对价格，不是百分比、也不是距离。',
      '- `confidence`：**0-100 的整数，每一个决策都要给 —— 包括 `wait` 和 `hold`。漏填会被当作"没有把握"而拒绝开仓**（风控的门槛看的就是它）。请如实填写：低于阈值的值不会被交易。',
      '- `risk_usd`：若止损被触发，损失的 USDT 金额。',
      '',
      '决策块内只能输出合法 JSON：双引号、无注释、无尾随逗号。你可以在 `reasoning` 字段里写简短理由，但 JSON 必须能被解析。',
    ].join('\n'),
  );

  /*
   * 7.5 — 按需取数（§ 见 `decisionTools.ts`）。
   *
   * ⚠️ **这一节必须紧跟在"输出格式"之后。**
   *
   * 上面刚说完"只输出两个 XML 块，不要有任何其他内容" —— 那是这套提示词原有的
   * 硬约束。而"你可以中途要数据"恰好是**对那条约束的一个例外**，所以例外要写在
   * 规则旁边；放到别处会读成"另外还有个建议"，模型多半不会当回事。
   *
   * 这一段解决的是**数据视界**问题：在此之前，每个周期开始时批量取好的那些数据
   * 就是模型的全部世界 —— 它看了 1h 觉得没机会，而 1m 图上刚放量突破，
   * **它没有任何办法去要那张图**。真人交易员不会这样工作。
   */
  sections.push(DECISION_TOOL_CATALOGUE);

  /* 8 — Custom prompt ---------------------------------------------------- */
  const custom = config.customPrompt.trim();
  if (custom) {
    sections.push(`# 账户所有者追加的指示\n${custom}`);
  }

  return sections.join('\n\n');
}

/* -------------------------------------------------------------------------- */
/*  记忆区块的渲染（提案 §2）                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 「你的交易绩效」区块（§2.1）。固定四行左右，永远不随历史增长。
 *
 * ## 为什么最后一行是服务端算出来的倍数，而不是一句固定文案
 *
 * 那一行是**反过度交易的核心信号**：它把"你在亏"直接翻译成"你该少做"，而不是让
 * 模型自己从一堆数字里推断。但如果写成固定句子，它在账户开始赚钱之后仍然是
 * 同一句话 —— 模型只要发现一次"这行是假的"，整个区块的可信度就没了。
 *
 * 所以倍数一律按窗口内的真实数字算，并且：
 *   · 毛盈亏为 0 时倍数是无穷，直接渲染 ∞（同一个模板，只换数字）；
 *   · 倍数 < 1（成本还没吞掉全部毛盈亏）时**只陈述事实**，不加"减少交易次数"那句
 *     指令 —— 那时它不是唯一有效的方向，说反了比不说更糟。
 */
function renderPerformance(performance: PromptPerformance, config: StrategyConfig): string {
  const lines: string[] = ['# 你的交易绩效'];
  const hours = performance.windowHours;

  if (performance.totalTrades === 0) {
    lines.push(`最近 ${hours} 小时没有已平仓的交易，因此没有可对比的绩效。`);
    /*
     * ⚠️ **空转的轮数必须单独说。**
     *
     * 上面那句无法区分"刚开始跑"和"已经连着二十几轮都在否掉全部候选" ——
     * 而后者是系统性问题，需要用完全不同的方式处置（改门槛、改标的池，或者
     * 承认这个账户规模下不该交易）。模型看不到轮数，就只能继续等下去。
     */
    if (performance.idleCycles >= IDLE_CYCLES_ALERT_THRESHOLD) {
      lines.push(
        `**你已连续 ${performance.idleCycles} 轮没有做出任何决策（每一轮都把所有候选否掉了）。** ` +
          '连续空转到这个程度时，"再等一个更好的信号"已经不是稳健，而是**整轮流程没有在产生价值**。' +
          '请检查：是门槛组合不可达、标的池太小、还是你的标准本身需要一个复核 —— ' +
          '这三样里有两样你可以直接用 `set_params` 改。',
      );
    }
    return lines.join('\n');
  }

  /*
   * 资金费只在非 0 时出现。
   *
   * 不是可选的装饰：`净 = 毛 − 手续费 − 资金费` 是这个平台唯一允许出现的盈亏口径
   * （§2.5）。资金费被结算过、却不在这一行里露面的账，模型无论怎么加都对不上，
   * 而一个对不上的账本会让人（和模型）不再相信里面任何一个数字。
   */
  const fundingTerm =
    performance.totalFunding !== 0 ? ` · 资金费 ${fmtSigned(-performance.totalFunding, 2)}` : '';

  lines.push(
    `最近 ${hours} 小时：${performance.totalTrades} 笔（${performance.wins} 胜 ${performance.losses} 负）` +
      `· 毛 ${fmtSigned(performance.grossPnl, 2)}` +
      ` · 手续费 ${fmtSigned(-performance.totalFees, 2)}${fundingTerm}` +
      ` · 净 ${fmtSigned(performance.netPnl, 2)}`,
  );

  const payoffRatio = performance.realizedPayoffRatio;
  lines.push(
    `平均盈利 ${fmtSigned(performance.avgWin, 2)} · 平均亏损 ${fmtSigned(-performance.avgLoss, 2)}` +
      ` · 实际盈亏比 ${payoffRatio === null ? '无（窗口内没有亏损单）' : payoffRatio.toFixed(2)}` +
      `（新开仓要求 ≥ ${config.riskControl.minRiskRewardRatio}）`,
  );

  if (performance.roundTripFeeRate !== null) {
    lines.push(`每次往返成本约 ${(performance.roundTripFeeRate * 100).toFixed(2)}%（名义价值）`);
  }

  if (performance.totalFees > 0) {
    const multiple =
      Math.abs(performance.grossPnl) > 1e-9
        ? performance.totalFees / Math.abs(performance.grossPnl)
        : Number.POSITIVE_INFINITY;
    const rendered = Number.isFinite(multiple) ? multiple.toFixed(1) : '∞';
    lines.push(
      multiple >= 1
        ? `**手续费是毛盈亏的 ${rendered} 倍 —— 减少交易次数是当前唯一有效的改进方向。**`
        : `手续费是毛盈亏的 ${rendered} 倍。`,
    );
  }

  return lines.join('\n');
}

/**
 * 「最近平仓」区块（§2.2）：固定 N=5 笔，每笔**两行**。
 *
 * 第二行才是重点 —— 把模型**当时的理由**和**实际结果**并排放在一起。这是它唯一
 * 能形成"我某个判断模式不奏效"的机制：只看结果它不知道自己错在哪，只看理由它
 * 不知道那个理由已经失败过。
 *
 * 理由只留**一句话**（§2.4）：全文会让区块变成 O(n)，而理由的**形状**
 * （是"1M 突破"还是"RSI 超卖"）比全文更有诊断价值。
 */
/**
 * 把一个时刻渲染成**绝对时间戳**（UTC，`MM-DD HH:mm`）。
 *
 * ## ⚠️ 为什么这里绝对不许用「X 小时前」
 *
 * 实测抓到的缓存杀手：这一块原来写的是
 *
 *     `(${humanDuration(minutesAgo)}前)`
 *
 * 而 `minutesAgo` 是 `now - closedAt` —— **`now` 每轮都在变**。于是 45 分钟之后
 * 「3 小时前」变成「4 小时前」，**整个 stable 段从这一行起就与上一轮分叉**，
 * 而缓存要求**前缀逐字节相同** —— 后面那几万 token 全部按全价计费。
 *
 * 证据在那份命中率里：**没有平仓记录时**（这一块是常量文案「还没有已平仓的交易」）
 * 命中 **59,000**；**一旦有平仓记录**，命中掉到 **8,000**（只剩系统提示词）。
 * 同一份提示词结构、同样的候选池，差别只在这一行。
 *
 * 绝对时间既**不随 `now` 变化**，又比"3 小时前"更有用 —— 模型可以拿它与
 * `volatile` 段里那句「时间：…（UTC）」直接相减，而"3 小时前"只给了一个数。
 *
 * 口径与提示词里那句时间一致（UTC），避免模型在两个时区之间换算。
 */
function closeStamp(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  return at.toISOString().slice(5, 16).replace('T', ' ');
}

function renderRecentCloses(closes: PromptClose[]): string {
  if (closes.length === 0) {
    return '# 最近平仓\n还没有已平仓的交易。';
  }

  const blocks = closes.map((close) => {
    const head =
      `- ${close.symbol} ${close.side === 'long' ? '多' : '空'} ${close.leverage}x ` +
      `@${fmt(close.entryPrice)}→${fmt(close.exitPrice)}  净 ${fmtSigned(close.netPnl, 3)}  ` +
      `${closeReasonLabel(close.closeReason, close.netPnl)}  (${closeStamp(close.closedAt)} UTC)`;
    return `${head}\n  你当时的理由：${oneLine(close.entryReason, 60)}`;
  });

  return `# 最近平仓（最新在前）\n${blocks.join('\n')}`;
}

/**
 * 「本周期约束」区块（§2.3）：让模型知道自己离节流与冷却多远。
 *
 * 这些限制**已经在代码里强制执行**，但模型看不见。看不见的约束等于不存在 ——
 * 它会反复提出必然被拒的请求，浪费一次调用，也浪费一次决策机会。
 *
 * 冷却只报"最近一次平仓"（见 `tradeEvents.lastExit()`）：列出每个仍在冷却的标的
 * 会让这一块随标的数增长，而 §4 要求它是 O(1)。判定仍然按标的执行，这里只是
 * 让模型看得见它。
 */
function renderThrottleBudget(budget: PromptThrottleBudget): string {
  const parts = [`本小时已开仓 ${budget.entriesThisHour} / ${budget.maxEntriesPerHour} 笔`];

  if (budget.minutesSinceLastExit === null) {
    parts.push('本机器人还没有平过仓');
  } else if (budget.reentryCooldownMinutes <= 0) {
    parts.push(`上次平仓在 ${humanDuration(budget.minutesSinceLastExit)}前（未启用再入场冷却）`);
  } else {
    const remaining = budget.reentryCooldownMinutes - budget.minutesSinceLastExit;
    parts.push(
      `上次平仓在 ${humanDuration(budget.minutesSinceLastExit)}前（再入场冷却 ${budget.reentryCooldownMinutes} 分钟，` +
        (remaining > 0 ? `还剩 ${humanDuration(remaining)}）` : '已满）'),
    );
  }

  return `# 本周期约束\n${parts.join(' · ')}`;
}

/**
 * 「最近被拒的提议」区块。
 *
 * ## 为什么必须有这一块（实测出来的）
 *
 * 上面 `renderThrottleBudget` 的注释已经写着原则：**看不见的约束等于不存在** ——
 * 模型会反复提出必然被拒的请求。**但那条原则此前只落实在节流/冷却上。**
 *
 * 实测的形态：模型提「名义 $6.00」，运行时按步长取整后是 $5.00，
 * 低于下限 $6.00 → 拒绝。**下一轮模型只看到绩效与节流，完全不知道被拒过**，
 * 于是原样再提一次。操作员看到的是「为什么同一个错误反复出现」——
 * **不是模型不智能，是这一侧没把它自己的失败告诉它。**
 *
 * 理由用运行时的**原话**，不改写：那句话里带着具体数字（差多少、下限多少），
 * 而那正是模型调整提议所需要的。改写会把可行动的细节磨掉。
 */
function renderRejections(rejections: PromptRejection[]): string | null {
  if (rejections.length === 0) return null;

  const lines = rejections.map(
    (r) => `- ${r.symbol} 提议名义 $${r.positionSizeUsd.toFixed(2)}：${r.reason}`,
  );

  return (
    `# 最近被拒的提议（最新在前）\n${lines.join('\n')}\n` +
    '**这些提议没有进入执行阶段。** 如果原因是你的数值在当前账户规模下不可行，' +
    '下一轮请给出一个确实能通过的数值，而不是重复同一个 —— ' +
    '每次重复都在浪费一次决策机会。'
  );
}

/**
 * AI 自己复盘出来的教训 —— 按标的给出"我上次在这里是怎么亏的"。
 *
 * ## 这一块为什么存在
 *
 * `agent_memory` 从写下那天起**没有任何决策路径读它**：唯一的调用者是复盘员
 * 自己（喂给下一轮复盘）与测试。于是 AI 每次做决定前看到的都是"干净的行情 +
 * 干净的账户"，而它自己上一笔为什么亏、复盘员下了什么结论，**它看不到**。
 *
 * 一条教训要影响交易，原来只能**绕道**让策略师把它变成一个参数改动 —— 间接、
 * 有损，还得恰好被策略师读进上下文。仓库自己的 `tools.test.ts` 里记着那个现场：
 * "复盘员反复打出「止损过紧」「费用吃掉利润」，而策略师一直在 `minPositionSize`
 * 上反复微调 —— 因为它看不到那个诊断。"
 *
 * 没有教训时返回 null（不产生空区块）：一个永远写着"无"的区块会占预算，
 * 还会让模型学会跳过它。
 */
function renderLessons(lessons: PromptLesson[]): string | null {
  if (lessons.length === 0) return null;

  const lines = lessons.map(
    (l) =>
      `- ${l.symbol}（平仓原因 ${l.closeReason}，净 ${l.netPnl >= 0 ? '+' : ''}${l.netPnl.toFixed(4)} USDT）：${oneLine(l.lesson, 200)}`,
  );

  return (
    `# 你自己复盘出来的教训（最新在前）\n${lines.join('\n')}\n` +
    '**这些是你自己（复盘环节）在那些平仓之后写下的结论。** 它们针对的是**具体标的与具体情形**，' +
    '不是通用规则 —— 请对照当前行情判断它们是否仍然适用，而不是无条件照做。'
  );
}

/**
 * 压成一行并截断。
 *
 * 模型写下的 `reasoning` 可以是多行散文；原样进提示词会让"每笔两行"变成长短不一的
 * 段落（区块大小随内容浮动），也会挤掉真正重要的聚合数字。
 */
function oneLine(text: string | null, maxChars: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return '（未记录）';
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/* -------------------------------------------------------------------------- */
/*  User prompt                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the per-cycle user prompt: the complete, factual state of the world
 * the model needs to decide.
 *
 * ## 预算守卫：超预算时**先砍行情，绝不砍记忆**（提案 §3）
 *
 * 组装完成后估算 token 数（`estimateTokens()`），超过上限就从**最弱的候选标的**
 * 开始丢，直到装得下为止。绩效、最近平仓与约束这三个区块**一个字段都不裁**。
 *
 * 这个取舍方向是刻意的：候选区块是"这一轮的机会"，记忆区块是"我一直在亏钱"。
 * 丢掉前者只是错过一次机会；丢掉后者会让系统永远重复同一个错误 —— 而后者正是
 * 当前问题的根源。见 `trimCandidatesForBudget()`。
 */
export function buildUserPrompt(ctx: PromptContext, budgetTokens = PROMPT_TOKEN_BUDGET): string {
  const { stable, volatile } = buildUserPromptParts(ctx, budgetTokens);
  return stable.length > 0 ? `${stable}\n\n${volatile}` : volatile;
}

/**
 * 用户提示词的**两段**：变化慢的与每轮变的。
 *
 * ## 为什么要分两段 —— 这是缓存能不能命中的全部原因
 *
 * 实测对照：本产品的 AI 托管**只命中 5%**（`cached_tokens 2304 / prompt_tokens 49394`），
 * 而 DSH 自己的会话是 **99%**。差别不在措辞，在**请求结构**：
 *
 *   · DSH 是**追加式**对话 —— 每轮 `[system, ...历史, 最新一条]`，前缀只增不改，
 *     于是除最后一条外全部命中；
 *   · 我们每轮**重新拼一个全新的字符串**，而这个字符串的第一行就是
 *     `时间：2026-09-20T14:37:38.123Z` —— 从第一个字符起就与上一轮分叉。
 *     于是只有 `system` 那一段（约 2300 token）命中，其余 4.7 万全是全价。
 *
 * 分两段之后发给模型的是：
 *
 * ```
 * [{ role: 'system',    content: 系统提示词 },      ← 稳定
 *  { role: 'user',      content: stable },          ← 稳定（教训 / 最近平仓 / 绩效）
 *  { role: 'assistant', content: '（已读）' },        ← 占位，让下一段是"新一轮输入"
 *  { role: 'user',      content: volatile }]        ← 每轮变（时间 / 账户 / 行情）
 * ```
 *
 * `stable` 只在**成交之后**才变，所以连续多轮之间它是逐字节相同的 —— 那几段就进了
 * 缓存。这也解释了为什么"段落顺序"要按变化频率排：**前缀一旦分叉，后面再稳定也没用**。
 */
export function buildUserPromptParts(
  ctx: PromptContext,
  budgetTokens = PROMPT_TOKEN_BUDGET,
): { stable: string; volatile: string } {
  /*
   * 系统提示词也是同一次请求的一部分，所以预算必须把它算进去。只量用户提示词的话，
   * 一个 3k tokens 的系统提示词会凭空落在预算之外 —— 而 §3 要的是一条**硬**上限。
   */
  const systemTokens = estimateTokens(buildSystemPrompt(ctx));
  const measure = (stable: string, volatile: string): number =>
    systemTokens + estimateTokens(stable) + estimateTokens(volatile);

  let stable = renderUserPrompt(ctx, ctx.candidates, null, 'stable', budgetTokens);
  let volatile = renderUserPrompt(ctx, ctx.candidates, null, 'volatile', budgetTokens);
  let spent = measure(stable, volatile);

  if (spent > budgetTokens) {
    const held = new Set(ctx.positions.map((p) => p.position.symbol));
    // 已有持仓的标的**一个都不裁**：模型必须看得见自己手上有什么，否则只能盲目持有。
    const minKeep = Math.max(1, ctx.candidates.filter((c) => held.has(c.symbol)).length);
    let keep = ctx.candidates.length;

    while (keep > minKeep && spent > budgetTokens) {
      const overflow = spent - budgetTokens;
      /*
       * 用实测的"每个候选约多少 token"估算这一轮要丢几个，而不是一次丢一个：
       * 逐个试在大候选池上要重渲染十几次。估算偏小也没关系 —— 循环会再走一轮，
       * 而每一轮 `keep` 都严格变小，所以最多循环"候选数"次就收敛。
       */
      const perCandidateTokens = Math.max(1, estimateCandidateChars(ctx.config) / 1.7);
      const drop = Math.max(1, Math.ceil(overflow / perCandidateTokens));
      keep = Math.max(minKeep, keep - drop);
      const trimmed = trimCandidatesForBudget(ctx.candidates, held, keep);
      const meta = { total: ctx.candidates.length };
      stable = renderUserPrompt(ctx, trimmed, meta, 'stable', budgetTokens);
      volatile = renderUserPrompt(ctx, trimmed, meta, 'volatile', budgetTokens);
      spent = measure(stable, volatile);
    }
  }

  /*
   * ── 把「你的上下文还有多少空间」告诉模型 ──────────────────────────────
   *
   * 用户的原则：「在**最大化发挥模型能力**的前提下，才考虑优化模型成本……
   * 要**最大化利用模型能力、上下文**来使得交易更加智能、准确」。
   *
   * 之前这一层是**单向**的：预算在阻止候选池过大（上面那个裁剪循环），
   * 但模型**不知道自己有多少空间可用** —— 于是它不会去用它。实测那台机器人
   * `coinSource.coinPoolLimit = 20`，而 80 万的预算按当前渲染密度能放
   * **约 106 个候选**：**87% 的上下文是空着的**，而它每一轮都在同样的 20 个
   * 标的里挑。
   *
   * 加在 `volatile` 而不是 `stable`：它含"本轮实际用了多少"（每轮都不同），
   * 放进 `stable` 会让缓存前缀每轮分叉 —— 而缓存命中是这套提示词结构
   * （`buildUserPromptParts` 的注释）存在的全部理由。
   */
  const budgetNote = renderBudgetNote(ctx, budgetTokens, spent);
  if (budgetNote.length > 0) volatile = `${volatile}\n\n${budgetNote}`;

  return { stable, volatile };
}

/**
 * 渲染「上下文空间」那一段。**只在真的还有空间时才出现。**
 *
 * ## 为什么必须由程序说这件事
 *
 * `coinSource.coinPoolLimit` 是模型可以用 `set_params` 改的参数，提示词里也写了
 * "候选池的规模是你可以改的"。但**"可以改"和"还剩多少空间"是两件事** ——
 * 前者它早就知道，后者它无从计算：那需要知道本轮预算（来自模型的
 * `input_token_limit`）、当前渲染密度（来自策略的周期数与指标数）、以及
 * 本轮实际用掉多少。**这些数是运行时的事实，模型自己推不出来。**
 *
 * ## 什么时候不说
 *
 * 候选池已经接近预算能容纳的数量时返回空串。理由是每多一段话都在花 token，
 * 而**在池子已经吃满时它没有任何可执行的动作** —— 那只是一段噪音，还会稀释
 * 别的约束（这个文件里对"信号淹没"记过不止一次）。
 *
 * 阈值取 1.3 倍：留一点余量，避免"刚好差 2 个"就反复催促。
 */
function renderBudgetNote(ctx: PromptContext, budgetTokens: number, spentNow: number): string {
  const shown = ctx.candidates.length;
  const roomFor = candidateBudget(ctx.config, budgetTokens);
  if (roomFor <= shown * 1.3) return '';

  const usedPercent = budgetTokens > 0 ? Math.round((spentNow / budgetTokens) * 100) : 0;
  return [
    '## 你的上下文空间',
    '',
    `- 本轮提示词预算 **${budgetTokens.toLocaleString()}** tokens（来自模型自己的上下文上限，已留出安全余量与输出空间）`,
    `- 本轮实际渲染约 **${spentNow.toLocaleString()}** tokens，也就是**${usedPercent}%**`,
    `- 按当前的渲染密度（周期数 × 指标数），这个预算**最多能放约 ${roomFor} 个候选标的**，`,
    `  而你现在只看到 **${shown}** 个 —— 卡住它的是候选池上限 \`coinSource.coinPoolLimit\`，**不是上下文**。`,
    '',
    '**这个上限归你**（`set_params` 改）。空间是有的；如果连续几轮都在同样那几个标的里',
    '找不到机会，把它调大是合理的 —— 但要有理由，别只是"多看看"。',
  ].join('\n');
}

/**
 * 按预算裁剪候选标的：**从最弱的开始丢**（提案 §3）。
 *
 * `candidates` 的顺序就是选币给出的强弱顺序（`selectCandidates()` 把已有持仓放在最前，
 * 其余按来源加入的顺序），所以"最弱的"就是数组末尾那些。过滤而不是切片，是为了
 * 保持原来的顺序不变 —— 顺序本身是信息（最强的在前），裁剪不该把它打乱。
 *
 * 已有持仓的标的**永远不裁**（`coins.ts` 的预算裁剪也是同一条规则）：一个看不见
 * 自己持仓行情的模型，会把"没有数据"当成"没有理由继续持有"。
 */
function trimCandidatesForBudget(
  candidates: MarketSnapshot[],
  held: Set<string>,
  keep: number,
): MarketSnapshot[] {
  if (keep >= candidates.length) return candidates;

  const keepSet = new Set<string>();
  for (const candidate of candidates) {
    if (held.has(candidate.symbol)) keepSet.add(candidate.symbol);
  }
  for (const candidate of candidates) {
    if (keepSet.size >= keep) break;
    if (!held.has(candidate.symbol)) keepSet.add(candidate.symbol);
  }
  return candidates.filter((candidate) => keepSet.has(candidate.symbol));
}

/**
 * The user prompt itself, for a given candidate list.
 *
 * Split out of `buildUserPrompt()` so the budget guard can re-render it with a shorter
 * candidate list — measuring is the only honest way to enforce a ceiling.
 *
 * @param trimmedFrom 非空表示这一份是**预算裁剪之后**的版本：候选区块会说明从多少个
 *   里裁到了多少个。模型知道这件事很重要 —— 否则它会以为某个标的从候选池里消失了。
 */
function renderUserPrompt(
  ctx: PromptContext,
  candidates: MarketSnapshot[],
  trimmedFrom: { total: number } | null,
  /**
   * 只渲染哪一段。见 `buildUserPromptParts()` 的说明：
   *
   *   · `'stable'`   —— 变化慢的（教训 / 最近平仓 / 绩效），进缓存前缀；
   *   · `'volatile'` —— 每轮变的（时间 / 账户 / 行情 / 持仓 / 节流 / 被拒）；
   *   · `'all'`      —— 两段都要（诊断路径与测试用）。
   */
  part: 'all' | 'stable' | 'volatile' = 'all',
  /**
   * 本轮提示词预算 —— **给多少个候选完整序列由它决定**（`detailedCandidateCount()`）。
   *
   * 传进来而不是读全局：预算是按**这个模型**的上下文算出来的运行时事实，
   * 而这个函数在测试与诊断脚本里也要能用一个假预算跑。
   */
  budgetTokens = PROMPT_TOKEN_BUDGET,
): string {
  const stableParts: string[] = [];
  const volatileParts: string[] = [];
  const wantStable = part !== 'volatile';
  const wantVolatile = part !== 'stable';

  /*
   * ## ⚠️ 段落的顺序由**缓存命中**决定，不只是由阅读顺序决定
   *
   * 实测：一轮请求 `prompt_tokens = 49,394`，而 `cached_tokens = 2,304` ——
   * **只有 5% 命中**。那 2,304 大致就是系统提示词的长度，也就是说
   * **系统提示词命中了、用户提示词那 4.7 万 token 全部没命中**。
   *
   * 原因是缓存的工作方式：**前缀必须逐字节相同**。而原来用户提示词的第一行是
   *
   *     时间：2026-09-20T14:37:38.123Z（UTC）
   *
   * —— **每一轮都不同**，于是从第一个字符起就与上一轮分叉，后面再稳定也没用。
   *
   * 所以这里按"变化频率"重排：**变化慢的在前，每轮变的在后**。
   *
   * | 段 | 变化频率 | 位置 |
   * | --- | --- | --- |
   * | AI 的教训 | 只在平仓后变 | 最前 |
   * | 最近平仓 | 只在平仓后变 | 次之 |
   * | 交易绩效（24h 滚动） | 慢 | 再次 |
   * | 系统状态（时间 / 轮次） | **每轮变** | 之后 |
   * | 账户 | 每轮变 | 之后 |
   * | 持仓 / 行情 / 候选 | 每轮变 | 最后（也是最大的一块） |
   *
   * 顺序变了**不改变**原来那条设计意图（"先让模型看见自己在亏钱、离约束有多远，
   * 再看这一轮有什么机会"）—— 前面几段全是"我过去怎么样"，它反而更早了。
   */

  /* 1 — 记忆里**变化最慢**的两块：教训与最近平仓 -------------------------- */
  /*
   * 教训来自 `agent_memory`（每笔平仓写一条），最近平仓固定 5 笔。
   * 它们只在**成交之后**才变 —— 而成交远不如行情频繁，所以放在最前面时，
   * 连续多轮之间这一段是逐字节相同的，能进缓存。
   */
  const lessons = renderLessons(ctx.memory.lessons);
  if (lessons) stableParts.push(lessons);

  stableParts.push(renderRecentCloses(ctx.memory.recentCloses));
  stableParts.push(renderPerformance(ctx.memory.performance, ctx.config));

  /* 2 — System status ---------------------------------------------------- */
  volatileParts.push(
    [
      '# 系统状态',
      `时间：${ctx.now.toISOString()}（UTC）`,
      `机器人：${ctx.traderName}`,
      `决策轮次：#${ctx.cycleNumber}`,
      `交易模式：${ctx.config.tradingMode}`,
      /*
       * ⚠️ **周期长度必须写出来 —— 否则模型的时间类规则会与实际节奏错配。**
       *
       * 实测（2026-09-30）：模型自己写了「5.5 无跟随时间止损 —— 入场后**第一次醒来**
       * 检查该仓位的那一轮，若峰值浮盈 < 0.25% 即市价全平」。而本机器人周期 30 分钟，
       * 于是"第一次醒来"= 入场后约 30 分钟。
       *
       * 用最近 1000 根 5m K 线模拟"任一点入场后 30 分钟内能否浮盈 ≥0.25%"：
       * **BTCUSDT 21.3% / ETHUSDT 32.6% / BNBUSDT 28.7%** —— 即大多数情况下
       * 该规则**必然**判定"未获跟随"，把正常仓位按 ≈0.1% 的手续费平掉。
       * 用户在页面上看到的正是这个：33 分钟开仓又平仓、毛 +0.01、手续费 0.0214、净亏。
       *
       * 规则本身是好纪律（"没跟随就早退"），错的是**它以为的"醒来"与实际周期
       * 不是一回事**。把周期如实写出来（周期本身它也能用 `set_params` 改），
       * 它就能自己算准这个尺度 —— 这正是"系统是手脚"该做的：**给事实，不给命令**。
       */
      ...(ctx.cycleIntervalMinutes && ctx.cycleIntervalMinutes > 0
        ? [
            `决策周期：每 ${ctx.cycleIntervalMinutes} 分钟一次`,
            '（你的**时间类**规则要按这个尺度换算：「入场后第一次醒来检查」在当前设置下' +
              `就是入场后约 ${ctx.cycleIntervalMinutes} 分钟，而不是几分钟后。这个周期本身你也能改。）`,
          ]
        : []),
      /*
       * ⚠️ **交易所对这个账户的实际授信 —— 必须让模型知道。**
       *
       * 币安：`能设的最大杠杆 = min(名义档位的 initialLeverage, 账户级限制, symbol 上限)`，
       * 而**账户级那一项对子账户是硬的** —— 官方 FAQ：新建子账户合约杠杆不超过 5x。
       * 同一份策略配置，跑在**主账户上能用 20x，跑在子账户上只能 5x**。
       *
       * 这个数系统**早就读到了**（`broker.getMaxLeverage()` → `leverageBracket`），
       * 但原来只喂给风控引擎做钳制（`autoTrader.ts` 的 `exchangeMaxLeverageOf`），
       * **从没进过提示词**。于是模型只看到「硬性约束」里那两行写死的配置值，
       * 永远不会想到"交易所允许更高，我可以把配置调上去"。
       *
       * 用户 2026-10-01 的原话：「我准备用主账户交易了（没有合约 5X 限制，本金也会加到 100u 以上），
       * 你确保我使用主账户，系统能正常运作（不要无法识别 5X 以上什么的和现在一样
       * **AI 不知道能挂更高**）」。
       *
       * ⚠️ **它渲染在用户提示词里而不是系统提示词里**，因为它**每轮随候选池变化** ——
       * 扔进系统提示词会让缓存前缀每次都失效（缓存按 system + user 拼接匹配）。
       */
      ...(ctx.leverageCaps && Object.keys(ctx.leverageCaps).length > 0
        ? [
            '',
            '## 交易所对该标的的杠杆档位上限',
            Object.entries(ctx.leverageCaps)
              .map(([symbol, cap]) => `${symbol} ${cap}x`)
              .join('、'),
            '（读自 `leverageBracket`，是**该 symbol 在那里的档位上限**。）',
            '**实际可用杠杆 = 「硬性约束」里的配置上限、这个档位上限、以及账户级限制 —— 三者取最小**，' +
              '风控按它钳制。所以配置写多少不等于能用多少：档位不够会被压下来。',
            '⚠️ **账户级限制不会出现在这个接口里。** 币安对**新建子账户**的合约杠杆有 5x 硬上限；' +
              '**主账户**通常没有这一层。所以：**若你把配置调高后仍然被压回 5x，' +
              '那说明当前跑的是子账户，而不是档位不够。**',
            '换账户 / 入金之后档位可能变（名义价值分档）。**要用多少仍然由你判断** ——' +
              '`set_params` 调 `btcEthMaxLeverage` / `altcoinMaxLeverage`，下一轮生效。',
          ]
        : []),
    ].join('\n'),
  );

  /* 3 — BTC market overview --------------------------------------------- */
  const btc = candidates.find((c) => c.symbol === 'BTCUSDT');
  if (btc) {
    const rsiKey = Object.keys(btc.primary.rsi)[0];
    const emaKey = Object.keys(btc.primary.ema)[0];
    const last = <T,>(arr: Array<T | null>): T | null =>
      [...arr].reverse().find((v) => v !== null) ?? null;

    volatileParts.push(
      [
        '# BTC 市场概览',
        `价格：${fmt(btc.price)} | 24h 涨跌：${fmtPercent(btc.priceChangePercent24h)}`,
        emaKey ? `EMA${emaKey}：${fmt(last(btc.primary.ema[emaKey] ?? []))}` : '',
        btc.primary.macd ? `MACD 柱：${fmt(last(btc.primary.macd.histogram))}` : '',
        rsiKey ? `RSI${rsiKey}：${fmt(last(btc.primary.rsi[rsiKey] ?? []), 1)}` : '',
        `持仓量（USDT）：${fmt(btc.derivatives.openInterestUsd)} | 资金费：${fmtPercent(
          btc.derivatives.fundingRate !== null ? btc.derivatives.fundingRate * 100 : null,
          4,
        )}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  /* 3 — Account ---------------------------------------------------------- */
  const a = ctx.account;
  const balancePct = a.equity > 0 ? (a.availableBalance / a.equity) * 100 : 0;
  const pnlPct = a.equity > 0 ? (a.unrealizedPnl / a.equity) * 100 : 0;
  const marginPct = a.equity > 0 ? (a.marginUsed / a.equity) * 100 : 0;
  volatileParts.push(
    [
      '# 账户',
      `权益 ${fmt(a.equity)} | 可用 ${fmt(a.availableBalance)}（${balancePct.toFixed(1)}%）| 未实现盈亏 ${fmtSigned(
        a.unrealizedPnl,
      )}（${fmtPercent(pnlPct)}）| 保证金占用 ${marginPct.toFixed(1)}% | 持仓数 ${a.positionCount}`,
      `仓位换算参考——权益的 1% 是 ${fmt(a.equity * 0.01)} USDT。`,
    ].join('\n'),
  );
  /*
   * ⚠️ **账户上有外部交易时必须说出来。**
   *
   * 模型同时看到两个都对、但互相矛盾的数字：账户在缩水（权益下降了），
   * 而它自己的绩效是正的。少了这一行，它只能自己猜 —— 而它最可能的猜测
   * 是「我算错了」或「策略在亏」，两种都会让它往错误方向调整。
   *
   * 这一行也是「归属权益 ≠ 账户余额」的**唯一解释**：归属口径假设账户里
   * 只有这一个机器人在交易，而外部活动让这个假设不成立了。
   */
  if ((a.foreignRounds ?? 0) > 0) {
    volatileParts.push(
      [
        '# 注意：账户上有不属于本机器人的交易',
        `交易所账户里还有 ${a.foreignRounds} 笔不是本平台开立的成交（净 ${fmtSigned(a.foreignNet ?? 0, 4)} USDT）。` +
          '它们的盈亏直接从余额进出，不计入上面的绩效，也不受你的决策控制。' +
          '所以当「账户余额的变化」与「你的绩效」对不上时，差额可能来自这里。' +
          '不要因为余额在缩水就认为自己的策略在亏。',
      ].join('\n'),
    );
  }

  /*
   * ⚠️ **账本自己对不上时必须让模型知道 —— 但警告的强度要与差异的大小相称。**
   *
   * 与上面那条的区别：外部活动是「账户上有别人的交易」（账是对的）；
   * 这一条是「平台记的账与交易所对不上」—— 绩效数字本身就不可信，而模型正照着它调策略。
   *
   * ## 为什么必须分档（实测：0.0137 的差异被说成"绩效可能不准"）
   *
   * 2026-09-30 线上真实提示词：`gap = +0.0137`，而当时绩效净额是 `1.1757` ——
   * **差异只占 1.2%**，措辞却是「上面「你的交易绩效」里的数字本身可能不准」。
   * 那会让模型**无谓地给自己的绩效打折**，而它正是在照着那份绩效调整策略 ——
   * 这正是用户要防的"账目问题影响模型决策"（⑥）。
   *
   * 所以判据用**相对量级**而不是绝对值：差额占近期净盈亏（下限取 1 USDT，
   * 免得小账户被除出一个夸张的比例）的 **5%** 以上才算"绩效不可信"；
   * 低于那一档时数字照给，但明确告诉它"不必因此调整"。
   */
  const ledgerGapAbs = Math.abs(a.ledgerGap ?? 0);
  if (ledgerGapAbs > 0.01) {
    /*
     * ⚠️ **分母不能用固定下限 1 USDT —— 那会让"差异比绩效还大"的情况被判成小差异。**
     *
     * 实测（2026-09-30）：`gap = 0.01367`，而近 24h 净额只有 `0.0441` ——
     * 差异是绩效的 **31%**，**确实该让模型警惕**。但第一版写的是
     * `max(|净额|, 1)`，分母被抬到 1，算出来 1.37% → **错误地归入"小差异档"**。
     *
     * 改成 `max(|净额|, gap)`：分母永远不小于差额本身，于是
     *   · 净额远大于差额 → 得到真实的相对占比（小 → 不吓人）；
     *   · 净额很小甚至为 0 → 占比逼近 1 → **按大差异处理**（这正确：账上凭空
     *     多出一笔与近期全部盈亏同量级的差额，本来就该警惕）。
     */
    const netMagnitude = Math.abs(ctx.memory.performance.netPnl);
    const share = ledgerGapAbs / Math.max(netMagnitude, ledgerGapAbs);
    volatileParts.push(
      share >= 0.05
        ? [
            '# 警告：账目与交易所对不上',
            `平台记录的盈亏与交易所的流水相差 ${fmtSigned(a.ledgerGap ?? 0, 4)} USDT —— ` +
              `这个差额已相当于近期净盈亏的 ${(share * 100).toFixed(0)}%。` +
              '这意味着**上面「你的交易绩效」里的数字本身可能不准** ——' +
              '它们来自平台的账本，而账本与交易所对不上。' +
              '在人工核对清楚之前，请对这种不确定性保持警惕：' +
              '不要仅凭近期的盈亏数字就大幅调整你的策略或交易频率。',
          ].join('\n')
        : [
            '# 说明：账目有一处小出入（**不必因此调整策略**）',
            `平台记录的盈亏与交易所的流水相差 ${fmtSigned(a.ledgerGap ?? 0, 4)} USDT —— ` +
              `这个差额只相当于近期净盈亏的 ${(share * 100).toFixed(1)}%，**不影响你对绩效的大致判断**。` +
              '它通常来自重建口径或手续费取整，属于正常范围。' +
              '如实告诉你只是不想让你以为账本是完美的 —— **不要因此降低对上面绩效数字的信任度**。',
          ].join('\n'),
    );
  }
  /*
   * 4 — 节流与被拒提议。
   *
   * ⚠️ 它们**留在最后**，因为它们每轮都变（计数与时间差），放到前面会把缓存前缀
   * 立刻打断 —— 那正是这一轮重排要解决的问题。而"离约束有多远"这件事本来就
   * 与"这一轮有什么机会"贴得最近，放这里也合乎阅读顺序。
   *
   * 上面第 1 段已经渲染了绩效与最近平仓；原来这里还有一份重复的 `push`，
   * 已随重排一并去掉（同一个区块渲染两次既浪费预算，也会让两处的数字有机会不一致）。
   */
  volatileParts.push(renderThrottleBudget(ctx.memory.throttle));
  const rejections = renderRejections(ctx.memory.recentRejections);
  if (rejections) volatileParts.push(rejections);

  /*
   * 这里原有一个 `# 最近已平仓交易` 区块，**已删除**。
   *
   * 它和上面第 4 段的 `# 最近平仓` 讲的是同一批成交，但两者对同一笔给出
   * **不同的盈亏数字**：旧区块用 `t.pnl`（毛），新区块用净额。
   * 模型在同一个提示词里看到两个互相矛盾的"这笔赚了多少"，而两者都没写口径 ——
   * 那比少给信息更糟。
   *
   * 新区块还多两样旧区块没有的东西：**模型当时的入场理由**（§2.2 —— 那是唯一
   * 能让它发现自己某个判断模式不奏效的机制），以及固定的 5 笔上限（O(1)）。
   * 旧区块的「近期战绩 N 笔中盈利 M 笔」也已由 `# 你的交易绩效` 里的
   * 「15 笔（6 胜 9 负）」覆盖。
   *
   * 所以删除它不丢任何信息，只去掉重复与矛盾。
   */

  /* 6 — Open positions --------------------------------------------------- */
  /*
   * ⚠️ **这一段里有两个口径的百分比在同时流动，必须各自标出来。**
   *
   * | 数 | 口径 |
   * | --- | --- |
   * | `unrealizedPnlPercent` / `peakPnlPercent` | **对保证金**（含杠杆）|
   * | 换算出来的「≈ 价格 X%」 | **价格变动**（不含杠杆）|
   *
   * 它们只差一个杠杆倍数，而模型要拿"价格"去和止损/止盈价比较 ——
   * 所以两个都给，而不是让模型自己去猜哪个是哪个。
   * 实测 `#95` 就是猜错的那一次，见 `runtime.ts` 里同一处的注释。
   */
  if (ctx.positions.length === 0) {
    volatileParts.push('# 当前持仓\n当前没有持仓。');
  } else {
    const lines = ctx.positions.map((p, index) => {
      const pos = p.position;
      const snap = p.snapshot;
      const rows = [
        `${index + 1}. ${pos.symbol} ${pos.side === 'long' ? '多头' : '空头'} | 入场 ${fmt(pos.entryPrice)} 当前 ${fmt(
          pos.markPrice,
        )}`,
        `   数量 ${fmt(pos.quantity, 6)} | 名义价值 ${fmtUsd(pos.notional)}`,
        `   盈亏 ${fmtPercent(pos.unrealizedPnlPercent)}（**对保证金**的口径，含 ${pos.leverage}x 杠杆 ≈ 价格 ${fmtPercent(
          marginPercentToPricePercent(pos.unrealizedPnlPercent, pos.leverage),
        )}）| 金额 ${fmtUsd(pos.unrealizedPnl)}`,
        `   最高浮盈 ${fmtPercent(pos.peakPnlPercent)}（**对保证金**的口径 ≈ 价格 ${fmtPercent(
          marginPercentToPricePercent(pos.peakPnlPercent, pos.leverage),
        )}）| 杠杆 ${pos.leverage}x`,
        `   保证金 ${fmtUsd(pos.marginUsed)} | 强平价 ${pos.liquidationPrice ? fmt(pos.liquidationPrice) : '无'}`,
        pos.stopLoss ? `   止损 ${fmt(pos.stopLoss)}${stopDistanceLabel(pos)}` : '   止损：未设置',
        pos.takeProfit ? `   止盈 ${fmt(pos.takeProfit)}` : '   止盈：未设置',
        `   已持仓 ${humanDuration(p.holdingMinutes)}`,
      ];
      /*
       * ⚠️ **往返成本：算"止损该放哪"时绕不过去的那个数。**
       *
       * 模型自己写的「保本/锁盈上移」规则用**价格浮盈 %** 做判据，而当止损被移到
       * "比入场价好一点点"的位置时，那"一点点"必须覆盖往返成本，否则被扫掉就是净亏 ——
       * 与方向判断对不对无关，是算术。
       *
       * 实测 2026-09-30 ZECUSDT：止损上移到只锁 **0.048%**，而往返成本 **0.070%** →
       * 毛 +0.0042、手续费 0.0148 → **净 -0.0106**。
       *
       * 这里只给**事实**（本账户历史成交反推的均值）。是否因此把保护位放到覆盖成本之上，
       * 仍然是模型的判断 —— 那是它的取舍，不是系统的（"模型是大脑，系统只是手脚"）。
       */
      if (ctx.roundTripCostPercent !== undefined && ctx.roundTripCostPercent !== null) {
        rows.push(
          `   往返成本 ≈${ctx.roundTripCostPercent.toFixed(3)}%（开+平手续费合计占名义价值；` +
            '保护位与入场价的距离小于它时，被扫掉后**必然净亏**）',
        );
      }
      if (snap) {
        rows.push(`   行情：${summariseSnapshot(snap)}`);
      }
      return rows.join('\n');
    });
    volatileParts.push(`# 当前持仓\n${lines.join('\n\n')}`);
  }

  /* 6.5 — Pending limit entries ------------------------------------------ */
  /*
   * ⚠️ **挂在外面、等成交的限价单必须让模型看见。**
   *
   * 没有这一段，模型**不知道自己在等什么** —— 它会为一笔已经挂好的入场重复提案，
   * 或者干脆忘了这件事。
   *
   * 而它**单独成段、措辞明确**：这不是持仓（一根都没成交），模型不该拿它当仓位
   * 去管理（比如"把止损上移" —— 挂单上根本没有止损单可移，那个止损只是**计划**）。
   * 混进「当前持仓」会让它做出执行层做不到的动作。
   */
  if (ctx.pendingEntries.length > 0) {
    const lines = ctx.pendingEntries.map((p, index) => {
      const rows = [
        `${index + 1}. ${p.symbol} ${p.side === 'long' ? '做多' : '做空'} | **挂单 ${fmt(p.limitPrice)}**（尚未成交）`,
        /*
         * ⚠️ **"挂价离现价多远"必须给出来。**
         *
         * 能不能成交取决于"挂价与市价的距离 vs 这段时间市场能走多远"：
         * 后者模型自己有（ATR），**前者系统从没给过** —— 于是它无法判断
         * "我这个挂法现不现实"，只能一轮一轮挂、一轮一轮被 45 分钟时限撤掉。
         *
         * 实测（2026-10-01）：限价入场单撤单率 64%，最近 20 轮开单 6 次全部被撤；
         * 日志典型一行是"SOLUSDT 的限价挂单已等满 62 分钟仍未成交，已自动撤掉"。
         *
         * 只给**距离**，不给"该不该挂"的判断 —— 那是它的（"模型是大脑，系统只是手脚"）。
         */
        ...pendingDistanceRow(p, ctx),
        `   数量 ${fmt(p.quantity, 6)} | 已等 ${humanDuration(p.waitingMinutes)}`,
        `   成交后会用这两个价位挂保护单：止损 ${p.stopLoss ? fmt(p.stopLoss) : '无'} | 止盈 ${p.takeProfit ? fmt(p.takeProfit) : '无'}`,
      ];
      if (p.reasoning) rows.push(`   当初的理由：${p.reasoning.slice(0, 200)}`);
      return rows.join('\n');
    });
    volatileParts.push(
      `# 等待成交的挂单（${ctx.pendingEntries.length} 张，**不是持仓**）\n` +
        `${lines.join('\n\n')}\n\n` +
        '**这些是"已经在排队"的入场，不是"可以再开一个"的名额** —— 它们已经占着持仓上限。' +
        '所以：不要在同一个标的上再提一次入场（那张单还在等）；也不要以为仓位已经成立 —— ' +
        '**成交之前你无法管理它**（改不了它的止损，因为还没有仓位）。\n' +
        /*
         * ⚠️ **这一段原来写着「下一步我会给你撤单的能力」—— 那是过期的话，而且有害。**
         *
         * `cancel_pending` **早就实现了**（同一个提示词的另一处就给了它的 JSON 范例），
         * 而这里却说"下一步才给"。模型读到它，就以为自己只能干等时限 ——
         * 于是明明可以立刻撤掉、把名额让给别的机会，它却什么都不做。
         *
         * 实测（2026-10-01）：限价挂单撤单率 64%，最近 20 轮开单 6 次全部超时被撤；
         * 用户看到的是「挂了又取消根本没成交…浪费时间和 token」。
         *
         * 现在明确写：**撤单是你现在就有的动作。**
         */
        '如果你认为那张单已经**不该再等下去**（价位错了、逻辑变了、等太久了），' +
        '**用 `cancel_pending` 现在就撤掉它**（范例见前面「撤单」那一节）—— ' +
        '不必等系统那条时限，也不必用 `wait` 干等：撤掉之后名额立刻释放，你可以在同一轮里换个机会。',
    );
  }

  /*
   * 6.5 — **全市场概览**（第 0 层）------------------------------------------
   *
   * ⚠️ 它放在候选池**之前**，且**独立于"有没有候选"** —— 阅读顺序是
   * "先看见整个市场，再聚焦到这一轮的候选"；而即使这一轮一个候选都没选出来，
   * 模型也该知道外面有什么（那正是它下一次能纠正自己的依据）。
   *
   * 它对缓存没有额外伤害：候选池那一段本来就每轮都变。
   */
  if (ctx.marketOverview && ctx.marketOverview.length > 0) {
    volatileParts.push(renderMarketOverview(ctx.marketOverview));
  }

  /*
   * 6.6 — **市场聚焦**（第 1 层）--------------------------------------------
   *
   * 全景说"有什么"，聚焦说"哪里在动"。两者相邻，模型读起来是连贯的一件事：
   * 先扫一遍全市场，再看各维度的头几名，然后自己决定要不要点名深看。
   */
  if (ctx.rankings) {
    volatileParts.push(
      renderRankings(ctx.rankings, RANKING_LIMIT, ctx.oiRankingEnabled === true),
    );
  }

  /*
   * 6.7 — **本平台历史**（第 1 层的第七个维度）------------------------------
   *
   * 放在聚焦层之后：先看"市场里哪里在动"，再看"我自己在哪些标的上做得怎么样"。
   * 两者合起来才够模型做判断 —— 只看市场会忽略自己的实际表现，
   * 只看自己会忽略市场正在发生的事。
   */
  if (ctx.platformHistory && ctx.platformHistory.length > 0) {
    volatileParts.push(renderPlatformHistory(ctx.platformHistory));
  }

  /*
   * 6.8 — **挂单成交统计** -------------------------------------------------
   *
   * ⚠️ **这是模型看不到的那个反馈。** 用户 2026-10-01 观察到「每次开单都是限价单…
   * 经常挂了都无法成交…好像在浪费时间和 token」，而真实数据证实了他：
   *
   *     限价入场单：CANCELED 78 / FILLED 44  → **撤单率 64%**
   *     市价入场单：FILLED 19                → 100% 成交
   *
   * 系统**已经告诉过它**"挂满 `pendingEntryTimeoutMinutes` 分钟会自动撤"，
   * 但它从没看到"我过去挂的单六成都没成交" —— 而那是它调整挂单方式的唯一依据。
   * 所以它每轮都在重复"挂回踩位 → 超时撤掉 → 下一轮再挂"。
   *
   * 放在「本平台历史」之后：一个说"我在哪些标的上做得怎么样"，
   * 这个说"我的**挂单方式**本身好不好用"，两者都是关于它自己的事实。
   */
  if (ctx.entryStats && ctx.entryStats.fillRatePercent !== null) {
    volatileParts.push(renderEntryStats(ctx.entryStats, ctx.config.riskControl.pendingEntryTimeoutMinutes));
  }

  /*
   * 6.9 — **连续观望提醒** --------------------------------------------------
   *
   * ⚠️ **规则只增不减，会让可做集合单调收缩到空。**
   *
   * 模型每次亏损复盘都会加一条"这种情况别做"（那是对的），但它不会回头删规则。
   * 实测 2026-10-01：连续 10+ 轮 0 开仓、最近一次成交在 21 小时前，
   * 而它每一轮的排除理由单独看都成立 —— **它看不见"我已经很久什么都没做了"**，
   * 因为每一轮的思考都是局部的。
   *
   * 这一段只给事实。要不要放宽某条规则仍然是它的判断（用户的原则：模型是大脑）。
   */
  if (ctx.idleCycles !== undefined && ctx.idleCycles >= IDLE_CYCLES_NOTICE_THRESHOLD) {    /*
     * ⚠️ **候选的波动率分布。**
     *
     * 它连续多轮全 skip，每轮把 20 个候选逐个排除，理由都成立。而实测
     * （2026-10-01，真实行情）它最硬的那条门槛（`1.5×ATR ≤ 类别上限 1.4%`
     * ⇒ ATR ≤ 0.93%）在成交额前 60 个标的里有 **43 个满足（72%）**，
     * 中位 ATR 只有 **0.667%** —— **"市场里没有机会"这个隐含前提是错的**。
     *
     * 逐个排除让它看得见每个标的的毛病，却看不见**合格面有多宽**。
     * 系统只给这个统计，不给结论。
     */
    const atrPcts = ctx.candidates
      .map((c) => {
        const atr = lastValue(c.primary?.atr?.['14']);
        return atr !== null && Number.isFinite(c.price) && c.price > 0
          ? (atr / c.price) * 100
          : null;
      })
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);

    const lines = [
      '# 连续观望提醒',
      `⚠️ 你已经**连续 ${ctx.idleCycles} 轮没有开过一次仓**` +
        (ctx.idleNetPnl !== undefined && Number.isFinite(ctx.idleNetPnl)
          ? `（这段期间已平仓净额 ${fmtSigned(ctx.idleNetPnl, 4)}）`
          : '') +
        '。',
      '**这不是系统故障** —— 你每一轮的排除理由单独看都成立。但请注意：',
      '每一次亏损复盘都会给你**加**一条"这种情况别做"，而规则**只增不减**。',
      '回头看一遍你自己的规则：哪些是**当前市况下仍然成立**的，哪些是**当时那一次的特例**' +
        '（某个标的、某段行情）。要不要松、松哪一条、松多少，**由你判断**。',
      ...(ctx.ruleSizeChars !== undefined && ctx.ruleSizeChars > 0
        ? [
            `📏 你当前写的决策规则合计 **${ctx.ruleSizeChars.toLocaleString('en-US')} 字符**` +
              (ctx.ruleCount !== undefined ? `（${ctx.ruleCount} 条编号规则）` : '') +
              '。这个数字**只会随每次复盘增长** —— 没有任何机制会替你删。',
            /*
             * ⚠️ **这里原来写着"它每长一点，可做的机会就少一点"—— 2026-10-01 删掉了。**
             *
             * 那句话是我推出来的因果，而数据不支持：本机器人自己写的规则在
             * 09-27 就有 **5,080 字符**（记录在 `agent_experiments` 里），
             * 而那天开单率是 **58%**（19/33 轮）；到 09-30 涨到 **6,999 字符**，
             * 开单率 **8%**。**两者不是单调关系** —— 规则多的时候它也大量开过单。
             *
             * 保留"这个数字只会增长"这个**事实**（它确实没有删除机制，
             * 也确实看不到自己规则的规模），但不再替它下"因此机会变少"的结论。
             * 那属于它自己的判断，而在提示词里塞一个错的因果，
             * 比不塞更糟 —— 它会照着一条站不住的前提去改自己的规则。
             */
          ]
        : []),
      ...(atrPcts.length >= 5
        ? [
            `📊 本轮 ${atrPcts.length} 个候选的 **15m ATR 中位数 ` +
              `${atrPcts[Math.floor(atrPcts.length / 2)]!.toFixed(3)}%**` +
              `（最小 ${atrPcts[0]!.toFixed(3)}%、最大 ${atrPcts[atrPcts.length - 1]!.toFixed(3)}%）。` +
              '你自己的止损带规则给出了一个 ATR 上限 —— **除一下就知道有多少个在带内**。' +
              '逐个排除让你看得见每个标的的毛病，**但看不见合格面有多宽**。',
          ]
        : []),
      /*
       * ⚠️ **把它覆盖掉的那条系统原则摆回它面前。**
       *
       * ## 这条提醒是 2026-10-02 加的，起因是一段被"覆盖"掉的原则
       *
       * 渲染逻辑是：
       *
       *     `# 入场标准\n${config.promptSections.entryStandards.trim() || DEFAULT_ENTRY_STANDARDS}`
       *
       * —— `||` 意味着**它自己写的版本会整个替换掉系统默认**，而不是补充。
       *
       * 而系统默认里有一条**专门为这个现象写的**原则：
       *
       *   「**机会是分档的，不是"合格 / 不合格"两档。**」
       *
       * 它的注释记录着上一次同样的病：
       *
       *   实测：一个机器人连续 15 个周期、0 笔决策，而每一轮的推理都长达一千多字 ——
       *   它逐个复核了候选、指出具体冲突…结论一律是"没有一个能让我有底气向风控经理辩护"。
       *   **它的推理没问题，缺的是"小仓也是参与"这个选项。**
       *
       * 现在的现象与之**逐字重合**（连续 11+ 轮全观望、每轮逐个排除）。
       * 而这条原则**没有进它的提示词** —— 被它自己的 `entryStandards` 覆盖了。
       *
       * ## 为什么只是"提醒"而不是"改它的规则"
       *
       * 用户的原则是「模型是大脑，系统只是手脚」—— **我不替它改规则**。
       * 但"你覆盖掉的那版里有这一条"是一个**事实**，而系统有义务把事实摆出来：
       * 它不可能记得自己什么时候覆盖过什么。
       */
      ...(ctx.config.promptSections.entryStandards.trim() !== ''
        ? [
            '📋 **你的「入场标准」覆盖了系统默认的那一版** —— 渲染规则是"你写了就用你的，整段替换"。' +
              '而被你替换掉的那一版里有这一句，是**专门为"长期全观望"写的**：',
            '> **机会是分档的，不是"合格 / 不合格"两档。** 如果所有候选都是"差一点"，' +
              '那"用最小仓位参与最接近的那一个、并把止损放得比平时更紧"也是一个选项 ——' +
              '**不交易本身也有成本**（错过一整段行情，以及永远不产生样本可供你复盘）。',
            '这不是要你放宽风控。要不要把它写回你的 `entryStandards`，**是你自己的判断** ——' +
              '但你现在的版本里没有它，而你大概不记得自己是什么时候去掉的。',
          ]
        : []),
      /*
       * ⚠️ **把你自己的规则联立起来算一遍 —— 这是 2026-10-02 加的最后一段。**
       *
       * ## 为什么要系统来算这道算术
       *
       * 它的 `entryStandards` 里有三条互相咬合的硬约束：
       *
       *   1. 单笔风险 ≤ 权益的 2%（实测它按此推导：权益 22 → 预算 0.44 USDT）；
       *   2. 止损必须 ≥ 1.5 × ATR14(15m)（波动下限）；
       *   3. 止损上限 = 风险预算 ÷ (名义 × 1.5)。
       *
       * 联立 2 与 3 给出一个它**每轮都在手算、但只算到"这个不行"就停下**的结论：
       *
       *     ATR ≤ 上限 ÷ 1.5
       *
       * 实测（2026-10-01/02，权益 21.92）：上限 = 0.44 ÷ (21 × 1.5) = **1.40%**，
       * 于是 **ATR 必须 ≤ 0.93%**。再叠加它自己的"磁吸位缓冲 + 盈亏比 3 +
       * 15m/1h 同向 + 两条独立证据 + 张数≥1"，20 个候选里满足**全部**的是 **0 个**，
       * 而它连续 11+ 轮的结论都是"没有合格标的"。
       *
       * ## 系统算的是"事实"，不是"建议"
       *
       * 上面那几个数字**都是它自己规则里的**，权益是账户的真实值，ATR 是本轮候选的真实值。
       * 系统只是**把这道它每轮都要做一遍的联立算完并写出来**，并指出一件它看不到的事：
       *
       *   **造成"空集"的两个变量 —— 规则、风险参数 —— 都在它自己的权限里。**
       *   （权益不归它管，那是账户所有者的。）
       *
       * 怎么动、动不动，仍然是它的判断。系统不替它选。
       */
      ...(() => {
        const equity = ctx.account.equity;
        /* 它规则里的两个系数。写下来源，因为若它改了规则，这两个数就会过时。 */
        const riskPerTradePercent = 2; // 「单笔亏损 ≤ 权益 2%」
        const stopToRiskMultiple = 1.5; // 「实际亏损可达止损幅度的 1.5 倍」
        const atrToStopMultiple = 1.5; // 「止损 ≥ 1.5 × ATR14(15m)」
        /* 名义：取它规则里的山寨币目标档，与交易所下限取大者。 */
        const notional = Math.max(ctx.config.riskControl.minPositionSize, 20);
        if (!Number.isFinite(equity) || equity <= 0 || atrPcts.length < 5) return [];
        const riskBudget = (equity * riskPerTradePercent) / 100;
        const stopCapPercent = (riskBudget / (notional * stopToRiskMultiple)) * 100;
        const atrCapPercent = stopCapPercent / atrToStopMultiple;
        const within = atrPcts.filter((p) => p <= atrCapPercent).length;
        return [
          /*
           * ⚠️ **必须说清"这只是一条门槛"。**
           *
           * 我第一版把这段写在「把你自己那几条硬约束联立一下」的标题下，算出来的
           * 是"ATR 在止损带上限内的候选数"。而实测（2026-10-02 `#1813`）它算出
           * **13 个**，模型**仍然全观望** —— 因为它真正卡住的地方是
           * 「15m/1h 方向一致 + 超卖不追空 + 至少两条独立证据」这几条，
           * 而**那些在这段里根本没算**。
           *
           * 一个只算了一条门槛、却自称"联立了全部约束"的段落，会让模型误以为
           * "13 个都合格而我却什么都没做" —— 那是在**制造一个假事实**，
           * 比不写更糟（同一晚我已经因为一个不准确因果删过一次）。
           */
          '🧮 **先算一条最容易被忽略的硬门槛**（数字全部来自你自己的规则与本轮真实行情）：',
          `- 单笔风险预算 = 权益 ${equity.toFixed(2)} × ${riskPerTradePercent}% = **${riskBudget.toFixed(4)} USDT**`,
          `- 止损上限 = ${riskBudget.toFixed(4)} ÷ (名义 ${notional} × ${stopToRiskMultiple}) = **${stopCapPercent.toFixed(2)}%**`,
          `- 而你的止损下限是 ${atrToStopMultiple} × ATR14 → **可做标的的 15m ATR 必须 ≤ ${atrCapPercent.toFixed(2)}%**`,
          `- 本轮 ${atrPcts.length} 个候选里，ATR 在这个上限以内的有 **${within} 个**。`,
          '⚠️ **这只是一条门槛**（波动率能否塞进你的止损带），' +
            '**方向一致性、磁吸位缓冲、盈亏比、独立证据数量这些都没有算在内** —— ' +
            '所以这 N 个**不等于**"N 个合格机会"，别把它当成"还有得做"的证据。',
          within <= 2
            ? '⚠️ 它想说明的是：**这一条门槛就已经把可行集压到接近空了**。' +
              '这**不是市场没机会** —— 而"规则"和"风险参数"这两样**都在你自己的权限里**' +
              '（权益不归你管）。要不要让可行集重新非空、以及怎么让，**是你的判断**。'
            : '如果连这一条都过得去、而你的结论仍是"全部观望"，那卡住你的就是**后面那几条** —— ' +
              '值得回头看看它们是当前市况下的判断，还是某一次亏损留下的特例。',
        ];
      })(),
    ];
    volatileParts.push(lines.join('\n'));
  }

  /* 7 — Candidate coins -------------------------------------------------- */
  if (candidates.length === 0) {
    volatileParts.push(
      '# 候选标的\n本周期没有选出任何候选标的。你只能管理已有持仓；若无事可做，返回 `[]`。',
    );
  } else {
    /*
     * ⚠️ **前 `DETAILED_CANDIDATE_COUNT` 个给完整序列，其余只给概览。**
     *
     * 实测：一轮输入 **14.7 万 token**，其中 **95% 是这 20 个标的的完整指标序列**
     * （4 周期 × 10 条序列 × 30 个点），而模型**通常只深入看 1–2 个**。
     *
     * `candidates` 是**按强弱排序**的（`selectCandidates` 把持仓放最前），
     * 所以"前几个详细"天然落在最该被看的那几个上。
     *
     * **持仓标的永远详细** —— 即使它因为某种原因排到了后面。管理已有仓位是核心职责，
     * 不该因为排序被降级。（正常情况下它们在候选池最前，这一条是兜底。）
     *
     * 想看其余标的的完整序列？**现在可以点名要**（`get_klines`）。
     */
    const held = new Set(ctx.positions.map((p) => p.position.symbol));
    /*
     * ⚠️ **给多少个完整序列，按预算算**（原来写死 5，那个数是照着 20 万预算定的账）。
     * 见 `detailedCandidateCount()` 的说明 —— 它同时保留了"不低于 5"的下限。
     */
    const detailed = detailedCandidateCount(ctx.config, budgetTokens, candidates.length);
    const blocks = candidates.map((snap, index) =>
      formatMarketData(snap, index, ctx.config, {
        /*
         * ⚠️ **开不了的标的只给摘要** —— 它拿不到完整的多周期序列。
         *
         * 实测（2026-09-30）：BTCUSDT 的交易所下限是 $50，而账户约 22 USDT 时模型按风险
         * 算出的名义只有 $20（`#1462` 真实被拒：「仓位名义价值 $20.00 低于最低要求 $50.00」）。
         * 而 BTC 每轮都排在候选第一位（`coins.ts` 无条件加入它作为大盘背景），
         * 于是每轮白送 ~10KB 给它 —— 那些序列永远用不上，还让模型以为它能做 BTC。
         *
         * 摘要 + 一句「开不了」既保住了大盘背景，又不为做不了的仓位付 token。
         */
        detailed:
          (index < detailed || held.has(snap.symbol)) && snap.tradability?.ok !== false,
      }),
    );
    const detailedCount = blocks.filter((_, i) => i < detailed).length;
    /*
     * 两处裁剪都要说 —— 它们发生在不同阶段，模型不该把它们合成一个数字：
     * `ctx.universeTrimmedFrom` 是**选币阶段**按候选上限截断的，
     * `trimmedFrom` 是**这一份提示词**为 token 预算再砍的。
     */
    const universeNote =
      ctx.universeTrimmedFrom !== null
        ? `本轮的候选池在选币阶段已按候选上限从 ${ctx.universeTrimmedFrom} 个截断`
        : null;
    const header = trimmedFrom
      ? `# 候选标的（${candidates.length} 个，已因上下文预算从 ${trimmedFrom.total} 个裁剪）\n` +
        `为把这一次请求控制在上下文预算内，本轮只保留了最强的 ${candidates.length} 个标的；` +
        '被裁掉的是排序最靠后的候选。绩效与历史区块不受影响。' +
        (universeNote ? `\n⚠️ ${universeNote} —— **你没看到的那些不是"市场里没有"，而是被配置的候选上限挡掉了。** 若因此觉得可选标的太少，该调的是 coinSource.coinPoolLimit 或门槛，不是选币逻辑。` : '')
      : `# 候选标的（${candidates.length} 个）\n` +
        `**前 ${Math.min(detailedCount, candidates.length)} 个给出完整指标序列**（按由旧到新排列，最后一个值就是最新值）；` +
        '**其余只给摘要**（最新值 + 最近 5 根的走向）—— 那足够用来筛掉它们，' +
        '而**任何一个你想深看的标的，都可以用 `get_klines` 点名要完整序列**，不必它排前面。' +
        (universeNote ? `\n⚠️ ${universeNote} —— **你没看到的那些不是"市场里没有"，而是被配置的候选上限挡掉了。**` : '');
    volatileParts.push(`${header}\n\n${blocks.join('\n\n')}`);
  }

  /* 8 — OI ranking ------------------------------------------------------- */
  if (ctx.config.indicators.enableOiRanking && ctx.oiRanking.length > 0) {
    const rows = ctx.oiRanking
      .slice(0, 15)
      .map(
        (r, i) =>
          `${i + 1}. ${r.symbol} | 持仓量 ${fmt(r.openInterestUsd)} | 持仓量变化 ${fmtPercent(
            r.changePercent,
          )} | 价格 ${fmtPercent(r.priceChangePercent)}`,
      );
    volatileParts.push(`# 持仓量排行\n${rows.join('\n')}`);
  }

  /* Closing instruction -------------------------------------------------- */
  volatileParts.push(
    [
      '# 你的任务',
      '分析以上内容，先输出 `<reasoning>` 块，再输出包含 JSON 数组的 `<decision>` 块。',
      '',
      /*
       * ⚠️ **这一段是 2026-10-02 的重写，起因是用户的一句判断：**
       *
       *   「不是**系统喂给 AI 什么，AI 就只能定时定点的去做**，这不是智能，
       *     也不是 AI，这是传统机器人了。」
       *
       * 而实测支持这句话：最近 200 轮里，`screen_symbols` / `get_klines` /
       * `request_deep_analysis` / `list_candidates` **各出现在 0 轮** ——
       * 给它造的"手脚"，一次都没用过。
       *
       * 原因之一是这里原本写着：
       *
       *     「返回 `[]`，或只包含 hold/wait 的列表，都是完全合格的答案。」
       *
       * 系统亲口告诉它"不做没问题"，而**一个把"不做"定义为合格的系统，
       * 必然得到"不做"**。那句已删。
       *
       * 原因之二是**时机**：工具目录在 system 里（18K 固定前缀的后段），
       * 而它要穿过 **11 万字符的候选池**（占 user 的 83%）才落到这里做结论 ——
       * 到那一刻，"你可以主动要数据"早已不在近处，剩下的印象只有"不做也可以"。
       * 所以工具提醒必须**在它真正落笔的地方**再说一次。
       */
      '**你的职责是找到值得做的机会。** 系统负责把市场摊开给你看、把你的判断变成订单并通过风控；' +
        '**"发现机会"是你的工作，不是系统的。**',
      '上面那份候选池是系统按成交额和规则挑出来的**起点**，不是"市场里所有值得看的东西"。' +
        '如果你觉得该看的没在里面 —— 那正是你该动手的时候。',
      '',
      '请记住：',
      '- 优先管理已有持仓。如果某个持仓的逻辑已经被破坏，就平掉它。',
      '- 只有当某个机会明确满足你的入场标准和所有硬性约束时，才开新仓。',
      '',
      '**观望是可以的，但它必须是一个结论，不是默认值。** 落笔前先问自己：',
      '- 我这一轮**真的扫过了**吗？还是只是把系统给的这十几个逐个看了一遍？',
      '- 我有没有用 `screen_symbols` 按**自己的想法**筛一遍全市场' +
        '（「哪些中盘币在放量」「哪些在阴跌但成交额还很大」）？',
      '- 我有没有对**任何一个**值得看的标的用 `get_klines` 拉更细的周期看过？',
      '如果这些都没做，而结论是"没有符合标准的标的" —— 那大概率不是市场没机会，' +
        '而是**你还没有开始找**。',
      '',
      /*
       * ⚠️ **"下一次什么时候再看盘"也归它。**
       *
       * 用户 2026-10-02：「会像真人一样，**决定何时做什么事情**。」
       * 在这之前机器人只有一个节拍（配置里的 `cycleIntervalMinutes`），
       * 它没法说"这个突破正在形成，5 分钟后再叫我"，也没法说
       * "这行情没意思，一小时后再看" —— 而**这两件事都是交易判断本身**。
       *
       * 必须写在这里（而不是只写进 system 的格式说明）：它读到这里才落笔，
       * 而"你可以定节奏"这件事必须在**落笔的地方**是近处的。
       */
      '## 你还可以决定"下一次什么时候再看盘"',
      '在决策 JSON 的**任意一条**里加 `"next_check_in_minutes": <1–120 的整数>`，' +
        '系统就按你说的排下一轮 —— **不必等配置的周期**。（不说就按配置走。）',
      '用它表达你的判断：',
      '- **正在等一个突破形成**、或挂单刚挂上还没成交 → 调小（**3–10 分钟**），盯着它；',
      '- **刚开完仓、结构完好**、暂时没什么要做的 → 用默认或稍大；',
      '- **行情死水**、所有候选都不在状态 → 调大（**30–120 分钟**），别空转烧钱。',
      '⚠️ 上限 120 分钟。**别用它来"睡过去"** —— 错过一个真正的机会，' +
        '和乱开一笔仓，是同一量级的失败。',
    ].join('\n'),
  );

  return [...(wantStable ? stableParts : []), ...(wantVolatile ? volatileParts : [])].join('\n\n');
}

/* -------------------------------------------------------------------------- */
/*  Enum labels                                                                */
/* -------------------------------------------------------------------------- */

// The label map lives in `@aq/shared` so the console, the server logs and this
// prompt all render a close reason identically.


/* -------------------------------------------------------------------------- */
/*  Market data rendering                                                      */
/* -------------------------------------------------------------------------- */

/** One-line indicator summary, used inside the position list. */
function summariseSnapshot(snap: MarketSnapshot): string {
  const last = <T,>(arr: Array<T | null>): T | null =>
    [...arr].reverse().find((v) => v !== null) ?? null;

  const pieces: string[] = [`price=${fmt(snap.price)}`];
  for (const [period, series] of Object.entries(snap.primary.ema)) {
    pieces.push(`ema${period}=${fmt(last(series))}`);
  }
  if (snap.primary.macd) {
    pieces.push(`macd=${fmt(last(snap.primary.macd.line))}`);
    pieces.push(`macd_hist=${fmt(last(snap.primary.macd.histogram))}`);
  }
  for (const [period, series] of Object.entries(snap.primary.rsi)) {
    pieces.push(`rsi${period}=${fmt(last(series), 1)}`);
  }
  for (const [period, series] of Object.entries(snap.primary.atr)) {
    pieces.push(`atr${period}=${fmt(last(series))}`);
  }
  if (snap.derivatives.openInterest !== null) {
    pieces.push(`oi=${fmt(snap.derivatives.openInterest, 0)}`);
  }
  if (snap.derivatives.fundingRate !== null) {
    pieces.push(`funding=${(snap.derivatives.fundingRate * 100).toFixed(4)}%`);
  }
  return pieces.join(', ');
}

/* -------------------------------------------------------------------------- */
/*  Prompt budget                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Token estimate for this kind of content.
 *
 * Measured against a real call rather than assumed: 207,328 characters produced
 * **128,073** tokens — about 1.62 chars/token, not the 4 chars/token rule of
 * thumb for English prose. Two reasons: the prompt is dense with long digit
 * strings (`0.08174000`) which tokenize badly, and it contains CJK prose. Using
 * the English ratio understated the true size by more than 2×, which is exactly
 * how a 128k-token request slipped past a check that thought it was 60k.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.7);
}

/**
 * Ceiling on the assembled user prompt.
 *
 * 60k tokens. The reasoning:
 *
 *  - Every supported provider has a context window of at least 128k, so this
 *    leaves more than half for the model to think and answer in.
 *  - The failure this constant exists to prevent was a prompt at **128k tokens**:
 *    the model consumed its entire output budget reasoning about the input and
 *    returned nothing. 60k is less than half of that.
 *  - It is a budget, not a target. A light single-timeframe strategy still gets
 *    a large universe; only heavy configurations are constrained, and they are
 *    exactly the ones that were overflowing.
 *
 * ## ⚠️ 它现在是一个**下限**（"什么都不知道时用这个"）
 *
 * 模型自己的输入上限存在 `ai_models.input_token_limit`。知道那个数时用
 * `promptTokenBudget()` 算，而它会**不低于这个常量**。
 */
export const PROMPT_TOKEN_BUDGET = 60_000;

/**
 * 上下文利用率 —— **上限的 80%**。
 *
 * ## 用户的原则（原话）
 *
 *   「在**最大化发挥模型能力**的前提下，才考虑优化模型成本 …… 这个模型最大
 *     上下文是 1M，那么要**最大化利用模型能力、上下文**（当然也考虑安全冗余，
 *     我记得是 80%）来使得交易更加智能、准确」
 *
 * 留 20% 而不是顶到 100%：`estimateTokens()` 是**估算**（1.7 字符/token），
 * 而渲染抖动、多轮工具结果追加重放都会让实际输入比估算值大。20% 是给那些
 * 误差的余量，不是"省钱的余量"。
 */
export const PROMPT_UTILISATION = 0.8;

/**
 * 给**输出**预留的空间（token）。
 *
 * ## 为什么必须单独留，而不能靠"输入占一半"
 *
 * 输入 + 输出 + 推理**共享同一个上下文窗口**。而这一轮实测确认：
 *
 *   · 输出上限（provider 硬限）= **393,216**（`max_tokens=1000000` 被拒：
 *     "the valid range of max_tokens is [1, 393216]"）；
 *   · 但实际输出量**远小于**它：推理峰值实测 28,590、正文 1–2k；
 *   · 而这个模型**强制思考、关不掉**（`thinking:{type:disabled}` 与
 *     `enable_thinking:false` 都被忽略，仍有 reasoning）。
 *
 * 所以预留取 **131,072（128k）** —— 远高于观测峰值，给"某次特别难的决策"
 * 留出空间；又不至于像按 393,216 预留那样白扔掉 26 万 token 的上下文。
 *
 * 原来是"输入只能占一半"（`× 0.5`），那等于**无条件扔掉一半上下文** ——
 * 而输出实际只用 5% 左右。那是把"省钱的保守"当成了"安全的保守"。
 */
export const PROMPT_OUTPUT_RESERVE = 131_072;

/**
 * 候选池里**给出完整指标序列**的标的个数，其余只给摘要。
 *
 * ## 为什么是 5
 *
 * 实测量出来的账：一个候选的完整区块约 **10,200 字符**，而其中
 * **95% 是「4 周期 × 10 条序列 × 30 个点」**；概览（最新价、持仓量、资金费、
 * 候选评分）只占约 500 字符。
 *
 * 20 个候选全给完整序列 = **约 20 万字符 / 14.7 万 token 的输入**，
 * 而**模型实测通常只深入看 1–2 个**。也就是说绝大多数候选的那 30 个点从没被读过
 * —— 而"信号淹没在数据里会让人判断变差"这件事，这个文件里写过不止一次。
 *
 * 取 5 而不是 2：候选池是**按强弱排序**的，但"最强的"不等于"最值得交易的那个"
 * （评分量的是"盘整后即将突破"，对已经走出来的强趋势给分偏低 —— 同一段注释里记过）。
 * 留一倍半的余量，让模型有东西可比较。
 *
 * **持仓标的永远详细**，不受这个数字影响。
 *
 * 想看其余标的的完整序列？**模型现在可以点名要**（`get_klines`，见 `decisionTools.ts`）
 * —— 这正是先做"按需取数"再做这个的原因：**先给它后路，再收窄默认。**
 */
export const DETAILED_CANDIDATE_COUNT = 5;

/**
 * ⚠️ **"完整序列"候选数的硬上限（10）。**
 *
 * ## 为什么它必须独立于 token 预算（2026-10-01 实测 `HTTP 524`）
 *
 * `detailedCandidateCount()` 原来只吃预算 —— 而 1M 上下文的模型拿到 **800,000**，
 * 于是 `roomFor` 算出来远大于候选总数，**全部 20 个都给了完整序列**：
 *
 *     20 个候选 × 约 10,600 字符 = 213,000 字符 = 一轮提示词的 **90%**
 *
 * 代价不是"贵"，是**一半的轮次直接失败**：
 *
 *     AI 服务不可用：服务商 5xx（**HTTP 524**）
 *
 * **`524` 是 Cloudflare 的"源站超时"** —— 网关等 **100 秒**拿不到响应就放弃。
 * 而这么大的请求实测耗时 **60–205 秒**，撞上它几乎是必然。
 * （把客户端 `timeout_seconds` 提到 600 秒**没有用** —— 限制在中间的网关那里。）
 *
 * ## 为什么减到 10 不损失能力
 *
 * 用户对候选池的要求是「15-20 个完整多周期行情」—— **20 个标的仍然全部在**，
 * 只是"完整序列"给前 10 个，其余给**摘要**（最新值 + 最近 5 根走向），
 * 而提示词本来就说清了「**想要哪个就用 `get_klines` 点名**」。
 *
 * 也就是 **信息没删、深度按需**，换来的是不再有一半轮次白费。
 * 而排序是"按强弱"的（`selectCandidates` 把持仓放最前），所以前 10 个天然是最该看的那些。
 */
export const DETAILED_HARD_CAP = 10;

/**
 * **详细区块能占预算的多大比例。**
 *
 * 剩下那部分要留给：固定的系统提示词、绩效与历史区块、候选概览、持仓区块，
 * 以及**输出**（推理 + 正文，实测推理峰值 28,590）。
 */
const DETAILED_BUDGET_SHARE = 0.7;

/**
 * 给**完整指标序列**的候选个数 —— **按预算算，不再写死**。
 *
 * ## 为什么原来写死的 5 不够用了
 *
 * `DETAILED_CANDIDATE_COUNT` 上面那份账（一个区块约 10,200 字符、20 个候选
 * 全详细约 14.7 万 token）**是照着 20 万预算算的**。而预算现在按模型能力算：
 * 1M 上下文的模型拿到 **80 万**（见 `promptTokenBudget`）。
 *
 * 按新预算重算：`20 个候选 × 6,000 token ≈ 12 万 token` —— **只占预算的 15%**。
 * 也就是说"为了省预算只给 5 个详细"这个理由，在新预算下**已经不成立**。
 *
 * ## 那段注释里还有一个循环论证
 *
 * 它写着「模型实测通常只深入看 1–2 个」—— 但**模型当时只能看到 5 个的详细序列**。
 * 从"它没看"推出"它不需要看"，是把**供给限制**当成了**需求证据**。
 *
 * ## 用户的原则
 *
 * 「在**最大化发挥模型能力**的前提下，才考虑优化模型成本 …… 要**最大化利用
 * 模型能力、上下文**」。把 90% 的候选降级成摘要，是在**替模型做取舍** ——
 * 而它才是那个该判断"哪个标的值得看"的角色。
 *
 * ## 下限仍然是 5
 *
 * 小预算下（不知道模型能力时的 6 万兜底）算出来会比 5 小，那时保留 5 ——
 * **这个改动不该让任何情况变差**。
 *
 * **持仓标的永远详细**，不受这个数字影响（见调用点）。
 */
export function detailedCandidateCount(
  config: StrategyConfig,
  budgetTokens = PROMPT_TOKEN_BUDGET,
  total = 0,
): number {
  /* 一个详细区块的 token 成本 —— 与 `estimateCandidateChars()` 同一个口径。 */
  const perDetailed = Math.max(1, estimateCandidateChars(config) / 1.7);
  const roomFor = Math.max(
    DETAILED_CANDIDATE_COUNT,
    Math.floor((budgetTokens * DETAILED_BUDGET_SHARE) / perDetailed),
  );
  /*
   * ⚠️ **再封一层硬上限** —— 理由见 `DETAILED_HARD_CAP` 的说明：
   * 大请求会撞上网关 100 秒的源站超时（`HTTP 524`），而那是**整轮失败**，
   * 比"少看几个完整序列"严重得多。
   */
  const capped = Math.min(roomFor, DETAILED_HARD_CAP);
  return total > 0 ? Math.min(capped, total) : capped;
}
/**
 * **你愿意花多少** —— 提示词预算的成本上限，与模型能吃多少无关。
 *
 * ## 为什么必须与"模型能吃多少"分开
 *
 * 实测：某机器人挂的模型能吃 100 万 token，而候选池只有 **7 个**（因为预算
 * 硬编码 6 万），连续 15 轮 0 决策。把预算只按"模型能吃多少"放开，会走到另一个
 * 极端：80 万 token 的提示词 × 每小时几十次 = 一份真实且巨大的账单。
 *
 * 所以两个数字：
 *
 *   · `ai_models.input_token_limit` —— **能力**（物理上能吃多少）；
 *   · 这个常量 —— **意愿**（一次请求最多花多少）。
 *
 * ## 20 万的由来
 *
 * 按现在的渲染密度（4 个周期 × 30 个点 ≈ 8,000 字符/候选）折合 **约 42 个候选**。
 * 而 `PROMPT_TOKEN_BUDGET` 的注释里记着一个真实的坑：**128k 的提示词让模型把
 * 整个输出预算花在推理上、返回空**。20 万仍然在"留足输出空间"这一侧
 * （1M 上下文的模型只用掉 20%），但比 6 万宽了三倍多。
 */
export const PROMPT_TOKEN_CEILING = 800_000;

/**
 * 这一轮该给多少 token 的提示词预算。
 *
 * @param inputTokenLimit 模型的输入上限；`0` 或非法值 = **不知道** → 用保守的
 *   `PROMPT_TOKEN_BUDGET`。
 *
 * ## 取值规则（**能力优先**，与项目原来的写法相反）
 *
 * ```
 * budget = clamp( min(上限 × 80%, 上限 − 输出预留), 下限 6 万, 上限 80 万 )
 * ```
 *
 * **两条约束取小**：
 *
 *   · **利用率 80%** —— 用户明确的安全冗余，留给估算误差与渲染抖动；
 *   · **上限 − 输出预留 128k** —— 输入 + 输出共享同一个窗口，输出必须有地方写。
 *
 * ## ⚠️ 这一段原来写的是 `上限 × 0.5`
 *
 * 理由是"这个系统输出（含推理）占比很高"。**事实上确实是**（实测
 * `reasoning_tokens` 占 `completion_tokens` 的 80%+），但**绝对量很小**：
 * 推理峰值 28,590，而窗口是 1,000,000。
 *
 * **把一个 3% 的占比当成 50% 来预留，等于无条件扔掉一半上下文** ——
 * 而那与用户"最大化利用上下文"的要求正好相反。**省钱的保守不等于安全的保守**，
 * 这里原来把两者混在了一起。
 *
 * ## 换模型时会自己调节吗 —— 会
 *
 * 这个函数只吃 `ai_models.input_token_limit`，而那个值有两个来源：
 * `providerDefaults()` 的兜底，以及 `/models` 的发现（`discoverModels` 会读
 * provider 报的 `context_length`）。所以**换一个上下文更大的模型，预算自动跟着涨；
 * 换一个更小的，自动降**，不需要改代码。
 */
export function promptTokenBudget(inputTokenLimit: number): number {
  if (!Number.isFinite(inputTokenLimit) || inputTokenLimit <= 0) return PROMPT_TOKEN_BUDGET;
  const byUtilisation = Math.floor(inputTokenLimit * PROMPT_UTILISATION);
  const byRoomForOutput = inputTokenLimit - PROMPT_OUTPUT_RESERVE;
  return Math.max(
    PROMPT_TOKEN_BUDGET,
    Math.min(byUtilisation, byRoomForOutput, PROMPT_TOKEN_CEILING),
  );
}

/**
 * Average rendered size of one number, including its separator.
 *
 * Calibrated against a real prompt rather than guessed: a scalping config with
 * 3 timeframes × 9 series × 30 points produced 120,842 characters for 14
 * candidates — about 8,770 characters each. The first estimate used 8 and came
 * out 24% low, which is how a prompt predicted at 58k tokens actually measured
 * 72k and still blew the budget it was supposed to respect.
 *
 * Prices like `0.08174000` plus a `, ` separator are the reason it is not 8.
 */
const CHARS_PER_NUMBER = 10;
/** Per-timeframe label overhead ("=== 5M 周期（由旧到新）===\n价格: [...]"). */
const CHARS_PER_TIMEFRAME_LABEL = 90;
/** Per-candidate headline, derivatives and quant lines. */
const CHARS_PER_CANDIDATE_OVERHEAD = 400;
/**
 * Everything in the prompt that does not scale with the candidate count: the
 * system prompt, the status/account/BTC-overview sections, and the closing
 * instructions. Reserved up front so the budget cannot be spent on candidates
 * and then overflowed by the scaffolding.
 */
const FIXED_PROMPT_TOKENS = 3_000;

/**
 * How many characters one candidate contributes, derived from what will
 * actually be rendered rather than from a guess.
 *
 * The series count is a function of which indicators are enabled, which is why
 * this has to be computed per strategy: a scalping config with three timeframes
 * and every indicator on costs several times what a two-timeframe config does.
 */
export function estimateCandidateChars(config: StrategyConfig): number {
  const indicators = config.indicators;
  /*
   * ⚠️ **这个公式必须与 `renderTimeframe` 逐字一致。**
   *
   * 它被预算裁剪用着：估算偏大 → 砍掉本来放得下的候选标的（丢掉真实的机会）；
   * 估算偏小 → 提示词超预算、被模型截断。
   *
   * 我给渲染加了 `promptPoints` 之后**忘了同步这里** —— 于是"调小点数省钱"
   * 这个动作在裁剪逻辑里完全看不见，估算值纹丝不动。
   * **用例抓到了它**（8 点与 30 点算出来都是 12760 字）。
   *
   * 两处的取值口径现在完全相同：`min(promptPoints, primaryCount, MAX_RENDER_POINTS)`。
   */
  const points = Math.min(
    config.indicators.kline.promptPoints ?? 30,
    config.indicators.kline.primaryCount,
    MAX_RENDER_POINTS,
  );
  const timeframes = Math.max(1, indicators.kline.selectedTimeframes.length);

  let seriesPerTimeframe = 1; // prices
  if (indicators.enableVolume) seriesPerTimeframe += 1;
  seriesPerTimeframe += indicators.enableEma ? indicators.emaPeriods.length : 0;
  if (indicators.enableMacd) seriesPerTimeframe += 3; // line, signal, histogram
  seriesPerTimeframe += indicators.enableRsi ? indicators.rsiPeriods.length : 0;
  seriesPerTimeframe += indicators.enableAtr ? indicators.atrPeriods.length : 0;

  const perTimeframe = seriesPerTimeframe * points * CHARS_PER_NUMBER + CHARS_PER_TIMEFRAME_LABEL;
  return timeframes * perTimeframe + CHARS_PER_CANDIDATE_OVERHEAD;
}

/**
 * Largest candidate universe whose prompt still fits the budget.
 *
 * The fixed prompt overhead is subtracted first: the system prompt and the
 * status/account sections are not free, and a budget that ignores them is a
 * budget that gets overrun.
 *
 * Returns a number, never zero: a strategy is always allowed to look at at least
 * one symbol, because silently selecting none would look like "no opportunities"
 * rather than "your configuration is too heavy".
 */
export function candidateBudget(
  config: StrategyConfig,
  budgetTokens = PROMPT_TOKEN_BUDGET,
): number {
  const perCandidate = estimateCandidateChars(config);
  if (perCandidate <= 0) return 40;
  // Budget is in tokens; the estimator is in characters.
  const availableChars = Math.max(0, (budgetTokens - FIXED_PROMPT_TOKENS) * 1.7);
  return Math.max(1, Math.floor(availableChars / perCandidate));
}

/**
 * Render one candidate symbol:
 *
 * ```
 * ### 1. ETHUSDT (coinpool+oi_top dual signal)
 *
 * current_price = 3500.00, current_ema20 = 3450.00, ...
 *
 * === 5M TIMEFRAME (oldest → latest) ===
 * Prices: [...]
 * Volumes: [...]
 * ```
 */
export function formatMarketData(
  snap: MarketSnapshot,
  index: number,
  config: StrategyConfig,
  /**
   * 是否渲染**每个周期的完整指标序列**。
   *
   * ## 为什么要有这个开关（实测量出来的）
   *
   * 一个候选标的的完整区块约 **10,200 字符**，其中概览（最新价、持仓量、资金费、
   * 候选评分）只占 **约 500** —— **95% 是「4 个周期 × 10 条序列 × 30 个点」**。
   *
   * 而 20 个候选合起来是 **约 20 万字符 / 14.7 万 token 的输入**，
   * 实测**模型最后通常只深入看 1–2 个标的**。也就是说：**绝大多数候选的
   * 那 30 个点，它根本没读。** 而"信号淹没在数据里"本身就会让判断变差
   * （不只是变贵）—— 这句话在这个文件里写过。
   *
   * 所以：**候选池前几个给完整序列，其余只给概览**；谁想深看，
   * 现在有 `get_klines` 可以点名要（见 `decisionTools.ts`）。
   */
  options: { detailed: boolean } = { detailed: true },
): string {
  const indicatorCfg = config.indicators;
  // Multi-source nominations are a genuine signal for the model: a symbol that
  // both the liquidity screen and the open-interest screen picked is stronger
  // than one that only appeared in a single list.
  const tag =
    snap.sources.length > 1
      ? `${snap.symbol}（${snap.sources.join(' + ')} — 多来源共振）`
      : snap.sources.length === 1
        ? `${snap.symbol}（${snap.sources[0]}）`
        : snap.symbol;

  const lines: string[] = [];
  lines.push(`### ${index + 1}. ${tag}`);

  // The indicator keys stay in snake_case English on purpose: they mirror the
  // field names the model must emit (`stop_loss`, `position_size_usd`, ...), so
  // keeping the data vocabulary consistent anchors the output contract.
  const headline: string[] = [`current_price = ${fmt(snap.price)}`];
  for (const [period, series] of Object.entries(snap.primary.ema)) {
    headline.push(`current_ema${period} = ${fmt(lastValue(series))}`);
  }
  if (snap.primary.macd) {
    headline.push(`current_macd = ${fmt(lastValue(snap.primary.macd.line))}`);
    headline.push(`current_macd_signal = ${fmt(lastValue(snap.primary.macd.signalLine))}`);
    headline.push(`current_macd_hist = ${fmt(lastValue(snap.primary.macd.histogram))}`);
  }
  for (const [period, series] of Object.entries(snap.primary.rsi)) {
    headline.push(`current_rsi${period} = ${fmt(lastValue(series), 1)}`);
  }
  for (const [period, series] of Object.entries(snap.primary.atr)) {
    headline.push(`current_atr${period} = ${fmt(lastValue(series))}`);
  }
  headline.push(`24h_change = ${fmtPercent(snap.priceChangePercent24h)}`);
  headline.push(`24h_quote_volume = ${fmt(snap.quoteVolume24h, 0)}`);
  lines.push(headline.join(', '));

  /* Derivatives context --------------------------------------------------- */
  const deriv: string[] = [];
  if (indicatorCfg.enableOi && snap.derivatives.openInterest !== null) {
    deriv.push(
      `持仓量：最新 ${fmt(snap.derivatives.openInterest, 2)}${
        snap.derivatives.openInterestAvg !== null ? ` 均值 ${fmt(snap.derivatives.openInterestAvg, 2)}` : ''
      }`,
    );
    const changeLine = renderChangeMap(snap.derivatives.openInterestChangePercent);
    if (changeLine) deriv.push(`持仓量变化：${changeLine}`);
  }
  if (indicatorCfg.enableFundingRate && snap.derivatives.fundingRate !== null) {
    deriv.push(`资金费率：${(snap.derivatives.fundingRate * 100).toFixed(4)}%`);
  }
  if (deriv.length > 0) lines.push('', deriv.join('\n'));

  /*
   * ## 候选评分 —— **把我们的尺子交给模型，并如实说明它量的是什么**
   *
   * ⚠️ 这个分数原来**只被用来当门槛，从不进提示词**（而且门槛 `minScore` 常常是 0）。
   * 于是模型完全不知道我们给每个标的打了多少分、按什么打的 —— 它**无法质疑尺子**，
   * 也无法利用"哪个最强"这个已经算好的结论。
   *
   * 实测对照：另一个平台把同类分数（"AI500"）直接摆在模型面前当第一性原则
   * （"82.4 分 > 75 门槛 → 可持有；71.0 分 → 禁止开仓"），而我们的模型只能
   * 从原始 K 线里自己重新估一遍。
   *
   * **并且必须把口径写出来。** 这条尺子有明显的偏向：
   *   · 趋势分只看 **4h EMA21 最近 5 根（约 20 小时）的斜率** —— 1.5% 就满分；
   *   · 突破量能分**只在"刚刚创新高/新低且放量"那一刻**给分；
   *   · 盘整分给窄幅横盘。
   *
   * 三者合起来，它衡量的是**"盘整后即将突破"**，而**对"已经涨了很久的强趋势"
   * 给分偏低**（那种标的早已不在突破那一刻、也早已不盘整，还会被波动扣分）。
   * 实测：一个 24h +15%、6 倍大牛标的拿 10/90，而它最近 20 小时确实在横盘 ——
   * **算法没错，但它量的东西和"这波行情还能不能上"不是一回事。**
   *
   * 所以这段的价值不在那个数字，而在**让模型知道这个数字的边界**：
   * 它可以据此说"这个分数低不代表没机会，只是不在它量的那类结构里"，
   * 并在 `set_params` 时把 `minScore` 当作一个**自己可调的**工具来用。
   */
  if (snap.score) {
    const s = snap.score;
    const w = SCORE_WEIGHTS;
    lines.push(
      '',
      `候选评分 ${s.total}／100（**本系统按固定规则算的，不是市场事实，也不预测涨跌**）：` +
        `趋势 ${(s.parts.trend * w.trend).toFixed(1)}／${w.trend}` +
        ` · 突破量能 ${(s.parts.breakoutVolume * w.breakoutVolume).toFixed(1)}／${w.breakoutVolume}` +
        ` · 盘整 ${(s.parts.consolidation * w.consolidation).toFixed(1)}／${w.consolidation}` +
        ` · 波动扣分 −${(s.parts.volatilityPenalty * w.volatilityPenalty).toFixed(1)}`,
    );
    /*
     * ⚠️ **口径说明只在第一个候选后面写一次。**
     *
     * 它讲的是**同一把尺子** —— 20 个候选各写一遍就是 20 遍同样的 300 字符
     * （合计约 6,000 字符 ≈ 3,500 token）。实测渲染 20 个候选时量到的浪费。
     *
     * 而它必须**出现在第一次看到分数的地方**：那句"分数低不等于没机会"是用来
     * 防止模型被这个数字否决的，挪到末尾的通用说明里就晚了。
     */
    if (index === 0) {
      lines.push(
        '评分口径（**只在这里说明一次；后面每个标的的分数都用同一把尺子**）：' +
          '**趋势**=4h EMA21 在最近 5 根（约 20 小时）的斜率，1.5% 即满分；' +
          '**突破量能**=15m 刚创新高或新低**且**成交量 ≥ 均量 1.5 倍（**只在突破那一刻给分**）；' +
          '**盘整**=15m 近 10 根窄幅；**波动扣分**=高波动惩罚。' +
          '→ 它偏向「**盘整后即将突破**」。**对"已经涨了很久的强趋势"给分天然偏低**（那种标的既不在突破那一刻、也不在盘整，还会被波动扣分）。' +
          '所以分数低**不等于没机会**，只等于"它不在这条尺子量的那类结构里"—— 那种情况下请**用你自己的分析判断**，而不是被这个数字否决。',
      );
    }
  }

  /* Quant / order-flow context -------------------------------------------- */
  if (indicatorCfg.enableQuantData && snap.quant) {
    const priceLine = renderChangeMap(snap.quant.priceChangePercent);
    const rows = [
      `主动买卖流：1 小时买入占比 ${(snap.quant.takerBuyRatio1h * 100).toFixed(1)}%（净额 ${fmt(
        snap.quant.netflow1h,
        0,
      )}），4 小时买入占比 ${(snap.quant.takerBuyRatio4h * 100).toFixed(1)}%（净额 ${fmt(snap.quant.netflow4h, 0)}）`,
    ];
    if (priceLine) rows.push(`价格变化：${priceLine}`);
    lines.push('', rows.join('\n'));
  }

  /*
   * ⚠️ **开不了的标的：把原因说清楚，并且不给完整序列。**
   *
   * 实测（2026-09-30）：`#1462` 里模型提了 BTCUSDT open_short，被交易所下限直接拒掉
   * （「仓位名义价值 $20.00 低于最低要求 $50.00」）。而它每轮都在候选里排第一位 ——
   * 一个**永远开不了**的标的，却占着候选第一名和约 10KB 的完整多周期序列。
   *
   * 保留它是有价值的（它提供大盘背景），但必须**说清楚它开不了**：
   * 不说的话模型会继续对它提案，那一轮决策就白花了。
   */
  if (snap.tradability && !snap.tradability.ok) {
    lines.push(
      '',
      `⚠️ **这个标的在当前账户规模下开不了仓**：${snap.tradability.reason ?? '低于交易所最小名义'}。` +
        '把它列出来只是让你看到大盘背景 —— **不要对它提开仓**，那会被风控直接拒掉、白费一轮。' +
        '如果你想让这类标的变得可做，该调的是仓位比例参数或账户资金，不是这一轮的提案。',
    );
  } else if (snap.tradability?.minNotional && snap.tradability.minNotional > 0) {
    /*
     * ⚠️ **最小名义必须告诉它 —— 这是"事实"，不是"指令"。**
     *
     * 实测 `#1462`：模型对 BTCUSDT 提了 `$20` 名义，而交易所下限是 `$50` → 整轮被拒。
     * BTC 对这个账户其实**能做**（名义上限 = 5 × 权益 ≈ $110），它只是不知道起步价。
     * 不写这句话，它就会继续按 `$20` 的习惯提，**每一轮都白花**。
     */
    lines.push(
      '',
      `约束：这个标的在交易所的**最小名义价值是 $${snap.tradability.minNotional}** —— ` +
        `提案里的 \`position_size_usd\` 低于它会被直接拒掉（与你的判断对错无关）。`,
    );
  }

  /* Per-timeframe series -------------------------------------------------- */
  /*
   * ⚠️ **只有 `detailed` 才渲染完整序列** —— 见 `formatMarketData` 的参数说明。
   *
   * 非 detailed 时保留**最新值**（已在 headline 里）与**这一段的方向摘要**，
   * 那正是"一眼扫过 20 个标的时真正会用到的信息"。
   */
  if (options.detailed) {
    for (const tf of snap.timeframes) {
      lines.push('', renderTimeframe(tf, indicatorCfg));
    }
  } else {
    lines.push('', renderTimeframeSummary(snap));
  }

  return lines.join('\n');
}

/**
 * 概览模式下的周期摘要 —— 替代完整序列。
 *
 * 每条序列只给**最新值 + 最近 5 根的走向**，而"走向"用**相对最新值的百分比**
 * 表示而不是把 5 个原始数字列出来：模型看"EMA20 在涨、价格刚站上去"这类判断时，
 * 百分比比裸数字更快、更省，而**原始数字它想看随时能要**。
 *
 * 这一段是给"扫一遍 20 个标的、挑出值得深看的那一两个"用的。
 */
/**
 * 成交额的紧凑写法：`12.3B` / `1234M` / `45K`。
 *
 * 概览层要在**一行里装下一个标的**、而一共有 500 多个，所以不能写完整数字。
 */
function fmtVolumeCompact(usdt: number): string {
  const abs = Math.abs(usdt);
  if (!Number.isFinite(usdt)) return '0';
  if (abs >= 1e9) return `${(usdt / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(usdt / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `${(usdt / 1e3).toFixed(0)}K`;
  return usdt.toFixed(0);
}

/**
 * 「全市场概览」—— 币安**全部可交易 USDT 永续**的极简一行。
 *
 * ## 为什么它必须存在（用户 2026-09-30 的原话）
 *
 * > 「币安支持的币种我觉得都应该在模型判断得范围（当然不是一次性给所有币种行情数据）」
 *
 * 在那之前模型的视野**只有候选池那 20 个**（约占全市场 527 个的 **3.8%**），
 * 而它无从知道外面还有什么 —— 那是"只做大盘币、抓不住异动"的根源，
 * 也是"系统替模型做了决定"（用户的原则：**模型是大脑，系统只是手脚**）。
 *
 * ## 它不是候选（这个区别很重要）
 *
 * 每条只有**四个字段**：符号、价格、24h 涨跌、24h 成交额 —— **没有指标序列**。
 * 所以它便宜得多：527 行约 16,000 字符 ≈ 6K tokens，占每轮约 30 万的 2%。
 * 模型据此**发现**外部世界，再用 `get_klines` 点名要完整行情（那才进候选池）。
 *
 * 排序按成交额降序：模型先看到活跃的，僵尸币自然沉底 —— 但它们**仍在清单里**，
 * 因为用户要的是"币安支持的币种都在判断范围内"，而"这个标的成交额很小"
 * 本身就是模型该知道的事实。
 */
function renderMarketOverview(rows: readonly MarketOverviewRow[]): string {
  const header = [
    `# 全市场概览（币安 ${rows.length} 个 USDT 永续，按 24h 成交额降序）`,
    '',
    '**这不是候选池** —— 每条只有符号、价格、24h 涨跌、24h 成交额，**没有指标序列**。',
    '它存在的意义是让你**看见整个市场**：下面的候选池只有十几个，而市场里有这么多标的。',
    '**看到这里值得深看的，用 `get_klines` 点名要它的完整序列** —— 不必等它排进候选。',
  ].join('\n');
  const lines = rows.map(
    (r) =>
      `${r.symbol} ${fmt(r.price)} ${fmtPercent(r.changePercent24h)} ${fmtVolumeCompact(r.quoteVolume24h)}`,
  );
  return `${header}\n\n${lines.join('\n')}`;
}

/**
 * 「市场聚焦」—— 各维度 Top 榜（第 1 层）。
 *
 * ⚠️ **它是"快照"，不是"推荐"。** 每个榜只按**一个**维度排序，系统**没有**做筛选判断。
 * 这句话必须出现在提示词里：否则模型会把"涨幅榜第一"读成系统给的建议，
 * 而系统在这里**没有资格**给建议 —— 用户的原则是「**模型是大脑，系统只是手脚**」。
 */
function renderRankings(
  r: UniverseRankings,
  limit: number,
  oiRankingEnabled: boolean,
): string {
  const compact = (x: RankingRow): string =>
    `${x.symbol} ${fmtPercent(x.changePercent24h)}（${fmtVolumeCompact(x.quoteVolume24h)}）`;
  const join = (rows: readonly RankingRow[], render: (x: RankingRow) => string): string =>
    rows.length === 0 ? '（本轮为空）' : rows.map(render).join(' · ');

  return [
    `# 市场聚焦（各维度前 ${limit} 名 —— **这不是推荐，只是"哪里在动"的快照**）`,
    '',
    '每个榜只按**一个**维度排序，系统**没有**做任何筛选判断 —— 哪个值得做是你的判断。',
    '需要某个标的的完整指标序列，用 `get_klines` 点名（括号里是它 24h 成交额）。',
    '',
    `成交额：${join(r.quoteVolume, (x) => `${x.symbol} ${fmtVolumeCompact(x.quoteVolume24h)} ${fmtPercent(x.changePercent24h)}`)}`,
    `涨幅：${join(r.gainers, compact)}`,
    `跌幅：${join(r.losers, compact)}`,
    `波动率：${join(r.volatility, (x) => `${x.symbol} 振幅 ${(x.value * 100).toFixed(1)}%（${fmtVolumeCompact(x.quoteVolume24h)}）`)}`,
    `资金费极值：${join(r.fundingExtreme, (x) => `${x.symbol} ${(x.value * 100).toFixed(4)}%（${fmtVolumeCompact(x.quoteVolume24h)}）`)}`,
    /*
     * ⚠️ 第八个维度「持仓量增长」的能力**早已存在**（`getOiRanking()` +
     * `screenOpenInterestGrowth()`），只是由 `indicators.enableOiRanking` 控制、当前关着。
     *
     * 按「模型是大脑」的原则**不替它打开**，但必须让它知道这个能力存在 ——
     * 否则"能开而不知道"等于没有。
     */
    ...(oiRankingEnabled
      ? []
      : [
          '',
          '**持仓量增长榜**：策略参数 `indicators.enableOiRanking` 当前是**关闭**的 —— ' +
            '打开它就能看到 1 小时持仓量增长最快的一批标的（用 `set_params` 改，下一轮生效）。' +
            '持仓量异动常常先于价格异动，是另一种"哪里在动"的信号。',
        ]),
  ].join('\n');
}

/**
 * 「本平台历史」—— 按标的聚合**本平台自己的成交**（第 1 层的第七个维度）。
 *
 * ⚠️ **必须说明它是"我自己的历史"，不是"市场判断"。**
 * 否则模型会把"我在 SOL 上赚过"读成"SOL 是个好标的" —— 那是两件事，
 * 而它自己的记忆里已经有一份「最近平仓」，这一段的用途不同：
 * 那一份是**逐笔**的因果，这一份是**按标的汇总**的倾向。
 */
function renderPlatformHistory(rows: readonly PlatformHistoryRow[]): string {
  if (rows.length === 0) return '';
  const lines = rows.map(
    (r) =>
      `${r.symbol} ${r.trades} 笔 · 净 ${fmtSigned(r.netPnl, 3)} · 胜率 ${(r.winRate * 100).toFixed(0)}%`,
  );
  return [
    '# 本平台历史（按标的汇总 —— 这是**你自己**在这个标的上做过的事，不是市场判断）',
    '',
    '只列样本量达标的标的；**笔数越少，那个胜率越不可信**（3 笔里 2 胜可能是运气）。',
    '按净额降序，**两端都列** —— 头部是你赚过的，尾部是你总是亏的，后者同样重要。',
    '',
    ...lines,
  ].join('\n');
}

/**
 * 「我的挂单方式好不好用」—— 成交率与撤单平均等待时长。
 *
 * ⚠️ 这一段存在的唯一理由是：**模型看不到自己的挂单成效**。
 *
 * 它已经知道"挂满 N 分钟会自动撤"这条规则，但不知道**自己过去挂的单六成都没成交**。
 * 用户 2026-10-01 看到的就是这个循环：「挂了又取消根本没成交…浪费时间和 token」。
 *
 * 说法上刻意只给**统计**，不给建议 —— 挂近一点、用市价、还是继续等回踩，
 * 是它的判断（用户的原则：**模型是大脑，系统只是手脚**）。
 */
function renderEntryStats(stats: EntryFillStats, timeoutMinutes: number): string {
  const decided = stats.limitFilled + stats.limitCanceled;
  const lines = [
    '# 我的挂单成效（限价入场单的历史统计 —— 这是**你自己**的成交情况）',
    '',
    `- 限价单：**成交 ${stats.limitFilled} 张 / 撤单 ${stats.limitCanceled} 张**` +
      `（共 ${decided} 张有结论）→ **成交率 ${stats.fillRatePercent!.toFixed(0)}%**`,
  ];
  if (stats.avgCanceledWaitMinutes !== null) {
    lines.push(
      `- 被撤的那些**平均等了 ${stats.avgCanceledWaitMinutes.toFixed(0)} 分钟**` +
        `（系统上限是 ${timeoutMinutes} 分钟）—— 等满了还没到价，说明**挂价离当时的市价偏远**。`,
    );
  }
  if (stats.marketFilled > 0) {
    lines.push(
      `- 市价单：成交 ${stats.marketFilled} 张（**市价单不会因为价格没到而失败**）。`,
    );
  }
  if (stats.limitRejected > 0) {
    lines.push(`- 另有 ${stats.limitRejected} 张限价单被交易所直接拒绝（那是"没挂上"，不算在成交率里）。`);
  }
  lines.push(
    '',
    '**这只是统计，不是建议** —— 挂得更近、直接吃单、还是继续等回踩，由你按当下行情决定。',
    '但如果成交率长期偏低，而你又在反复挂同一个价位，那消耗的是**你自己的决策轮次**。',
  );
  return lines.join('\n');
}

/**
 * 「挂价离现价多远」—— 一行，给模型判断"这个挂法现不现实"。
 *
 * ⚠️ 只给**距离**。该不该继续挂、要不要改成市价，是模型的判断
 * （用户的原则：**模型是大脑，系统只是手脚**）。
 */
function pendingDistanceRow(
  pending: { symbol: string; limitPrice: number },
  ctx: PromptContext,
): string[] {
  const snap = ctx.candidates.find((c) => c.symbol === pending.symbol);
  /*
   * 用 `snap.price`（快照自带的最新价），不要从 `timeframes[0].closes` 里取：
   * 快照的 `timeframes` 在轻量场景下可能是空的，而 `price` 一定是有的 ——
   * 第一版就是从序列里取，于是**这一行在夹具/轻量快照下静默不渲染**，
   * 而那正是这条信息最该出现的时候。
   */
  const mark = snap && Number.isFinite(snap.price) && snap.price > 0 ? snap.price : null;
  if (mark === null) return [];
  if (!Number.isFinite(pending.limitPrice) || pending.limitPrice <= 0) return [];

  const pct = ((pending.limitPrice - mark) / mark) * 100;
  const direction = pct >= 0 ? '高于' : '低于';
  const rows = [
    `   现价 ${fmt(mark)} | **挂价${direction}现价 ${Math.abs(pct).toFixed(3)}%**` +
      `（价格要先走这么多才可能成交）`,
  ];

  /*
   * ⚠️ **两个数必须放在一起：挂价距离 vs 这段时间价格预期能走多远。**
   *
   * 上一轮只给了"成交率 29%"（结果），而模型最近 6 轮的思考里**一次都没提过它** ——
   * 它照旧挂限价。它缺的不是结果，是**那笔账**：
   *
   *     我挂的价位离现价 1.225%
   *     而按当前 15m ATR，45 分钟内价格预期只能走约 0.3%
   *
   * 前一个数上一轮给了；后一个数**它有 ATR，但没人替它换算成"这段时间能走多远"**。
   * 两个数挨着放，比较就是一眼的事。
   *
   * 口径用**随机游走**（`ATR × √N`）而不是线性外推（`ATR × N`）：
   * 后者在 45 分钟（3 根）上会把预期行程夸大 1.7 倍，而那正是"让我以为挂得到"的方向 ——
   * 一个鼓励继续挂远的数字比不给更糟。
   */
  const atr = lastValue(snap?.primary?.atr?.['14']);
  if (atr !== null && Number.isFinite(atr) && atr > 0) {
    const timeoutMinutes = ctx.config.riskControl.pendingEntryTimeoutMinutes;
    const n = Math.max(1, timeoutMinutes / 15);
    const expectedPct = ((atr * Math.sqrt(n)) / mark) * 100;
    rows.push(
      `   ⏱ 按当前 15m ATR(14) ≈ ${fmt(atr)} 估计，**${timeoutMinutes} 分钟内价格预期能走约 ` +
        `${expectedPct.toFixed(2)}%**（随机游走口径：ATR × √根数）` +
        ` —— 与上面那个距离比一比，就知道这个价位等不等得到。`,
    );
  }

  return rows;
}

function renderTimeframeSummary(snap: MarketSnapshot): string {
  const lines: string[] = ['周期摘要（完整序列见 `get_klines`，需要哪个周期就点名要）：'];
  for (const tf of snap.timeframes) {
    const label = tf.timeframe.toUpperCase();
    const parts: string[] = [];

    const price = lastValue(tf.closes);
    if (price !== null) parts.push(`价 ${fmt(price)}${trendOf(tf.closes, price)}`);

    for (const [period, values] of Object.entries(tf.ema)) {
      const v = lastValue(values);
      if (v !== null) parts.push(`EMA${period} ${fmt(v)}${trendOf(values, v)}`);
    }
    if (tf.macd) {
      const hist = lastValue(tf.macd.histogram);
      if (hist !== null) parts.push(`MACD柱 ${fmt(hist)}`);
    }
    for (const [period, values] of Object.entries(tf.rsi)) {
      const v = lastValue(values);
      if (v !== null) parts.push(`RSI${period} ${fmt(v, 1)}`);
    }
    for (const [period, values] of Object.entries(tf.atr)) {
      const v = lastValue(values);
      if (v !== null) parts.push(`ATR${period} ${fmt(v)}`);
    }
    if (parts.length > 0) lines.push(`${label}: ${parts.join(' | ')}`);
  }
  return lines.join('\n');
}

/**
 * 一串序列最近 5 根相对于最新值的走向 —— `(↑1.2%)` / `(↓0.8%)` / 空串。
 *
 * 只在变化有意义时才标（小于 0.05% 当作持平），避免满屏 `(↑0.0%)` 的噪声。
 */
function trendOf(series: Array<number | null> | undefined, latest: number): string {
  if (!series || latest === 0) return '';
  const window = series.slice(-5).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (window.length < 2) return '';
  const first = window[0]!;
  if (first === 0) return '';
  const pct = ((latest - first) / Math.abs(first)) * 100;
  if (Math.abs(pct) < 0.05) return '';
  return `(${pct > 0 ? '↑' : '↓'}${Math.abs(pct).toFixed(1)}%)`;
}

function lastValue(series: Array<number | null> | undefined): number | null {
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== null && value !== undefined && Number.isFinite(value)) return value;
  }
  return null;
}

function renderTimeframe(tf: TimeframeIndicators, config: StrategyConfig['indicators']): string {
  const label = tf.timeframe.toUpperCase();
  /*
   * 渲染多少个点由配置决定（`promptPoints`），**不再写死 30**。
   *
   * 上限仍取 `primaryCount` 与 `MAX_RENDER_POINTS` 的较小者：前者是"取了多少根"，
   * 后者是"最多渲染多少根"（防一个异常大的配置把提示词撑爆）。
   * 于是 `promptPoints` 只能**减**，不能凭空要求比取到的还多。
   */
  const points = Math.min(config.kline.promptPoints ?? 30, config.kline.primaryCount, MAX_RENDER_POINTS);
  const lines: string[] = [`=== ${label} 周期（由旧到新）===`];

  lines.push(`价格: ${series(tf.closes, priceDecimalsFor(tf), points)}`);
  if (config.enableVolume) {
    lines.push(`成交量: ${series(tf.volumes, 2, points)}`);
  }
  // Indicator names stay in their standard English abbreviations — EMA, MACD,
  // RSI and ATR are used untranslated by Chinese traders and by the models.
  for (const [period, values] of Object.entries(tf.ema)) {
    lines.push(`EMA${period}: ${series(values, priceDecimalsFor(tf), points)}`);
  }
  if (tf.macd) {
    lines.push(`MACD: ${series(tf.macd.line, priceDecimalsFor(tf), points)}`);
    lines.push(`MACD_SIGNAL: ${series(tf.macd.signalLine, priceDecimalsFor(tf), points)}`);
    lines.push(`MACD_HIST: ${series(tf.macd.histogram, priceDecimalsFor(tf), points)}`);
  }
  for (const [period, values] of Object.entries(tf.rsi)) {
    lines.push(`RSI${period}: ${series(values, 1, points)}`);
  }
  for (const [period, values] of Object.entries(tf.atr)) {
    lines.push(`ATR${period}: ${series(values, priceDecimalsFor(tf), points)}`);
  }

  return lines.join('\n');
}

/**
 * Render a `{ window: value }` map, dropping windows that could not be computed.
 *
 * Printing `4h N/A` for every symbol is pure noise and actively misleads the
 * model into thinking a value exists but is unavailable, rather than that the
 * window is simply outside the configured lookback.
 */
function renderChangeMap(changes: Record<string, number | undefined>): string {
  const usable = Object.entries(changes).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  );
  if (usable.length === 0) return '';
  return usable.map(([window, pct]) => `${window} ${fmtPercent(pct)}`).join(' | ');
}

/** Candle series get 2 decimals below $1000, and none above it. */
function priceDecimalsFor(tf: TimeframeIndicators): number {
  const last = lastValue(tf.closes);
  if (last === null) return 2;
  if (last >= 1000) return 2;
  if (last >= 1) return 4;
  return 6;
}

export { fmt as formatNumber, fmtPercent as formatPercent, humanDuration };
