import {
  closeReasonLabel,
  type MarketSnapshot,
  type OiRankRow,
  type PositionView,
  type StrategyConfig,
  type TimeframeIndicators,
  type TradeRecord,
} from '@aq/shared';

import { SCORE_WEIGHTS } from './scoring.js';
import { DECISION_TOOL_CATALOGUE } from '../trader/decisionTools.js';

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
 * 固定 N 是第二块 O(1)：逐笔明细永远只有 5 行，跑一年也不会变长。
 * 这也是 §2.4「不加完整成交历史」的落地方式 —— 明细是 O(n)，聚合是 O(1)。
 */
export const PROMPT_RECENT_CLOSE_COUNT = 5;

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
 */
const MAX_RENDER_POINTS = 30;

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
    `# 角色\n${config.promptSections.roleDefinition.trim() || DEFAULT_ROLE}`,
  );

  /* 2 — Mode ------------------------------------------------------------- */
  sections.push(`# ${MODE_GUIDANCE[config.tradingMode]}`);

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
      risk.marginMode === 'isolated'
        ? '- 保证金模式：**逐仓（isolated）** —— 每个标的单独划保证金，**一笔爆仓最多亏掉它自己的保证金，不会动到别的仓位**。评估单笔风险时按这个算。'
        : '- 保证金模式：**全仓（crossed）** —— 所有仓位共享同一个保证金钱包，**任何一笔亏到爆仓都会吃掉整个合约钱包**。所以仓位规模要按"整账户一起看"来控制，而不是只看单笔。',
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
      `- 新开仓的最低盈亏比：1:${risk.minRiskRewardRatio}`,
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
        ? `- 回撤守卫：当某个仓位的浮盈超过 ${config.drawdownGuard.activationPercent}% 后，若回吐达到峰值的 ${(config.drawdownGuard.givebackRatio * 100).toFixed(0)}%，运行时会自动平掉它。`
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
      '**"不做任何动作"时同样给出完整字段，一个都不能省** —— 尤其是 `confidence`：',
      '```json',
      '[',
      '  {',
      '    "symbol": "SOLUSDT",',
      '    "action": "wait",',
      '    "confidence": 35,',
      '    "reasoning": "15m 与 1h 方向冲突，且波动率在收敛 —— 结构不成立。把握 35 分，远低于门槛。"',
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
      '- `action`：取值为 `open_long`、`open_short`、`close_long`、`close_short`、`adjust_protection`、`add_to_position`、`reduce_position`、`hold`、`wait` 之一。',
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
function renderRecentCloses(closes: PromptClose[], now: Date): string {
  if (closes.length === 0) {
    return '# 最近平仓\n还没有已平仓的交易。';
  }

  const blocks = closes.map((close) => {
    const closedAt = new Date(close.closedAt).getTime();
    const minutesAgo = Number.isFinite(closedAt)
      ? Math.max(0, (now.getTime() - closedAt) / 60_000)
      : 0;
    const head =
      `- ${close.symbol} ${close.side === 'long' ? '多' : '空'} ${close.leverage}x ` +
      `@${fmt(close.entryPrice)}→${fmt(close.exitPrice)}  净 ${fmtSigned(close.netPnl, 3)}  ` +
      `${closeReasonLabel(close.closeReason, close.netPnl)}  (${humanDuration(minutesAgo)}前)`;
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

  let stable = renderUserPrompt(ctx, ctx.candidates, null, 'stable');
  let volatile = renderUserPrompt(ctx, ctx.candidates, null, 'volatile');
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
      stable = renderUserPrompt(ctx, trimmed, meta, 'stable');
      volatile = renderUserPrompt(ctx, trimmed, meta, 'volatile');
      spent = measure(stable, volatile);
    }
  }

  return { stable, volatile };
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

  stableParts.push(renderRecentCloses(ctx.memory.recentCloses, ctx.now));
  stableParts.push(renderPerformance(ctx.memory.performance, ctx.config));

  /* 2 — System status ---------------------------------------------------- */
  volatileParts.push(
    [
      '# 系统状态',
      `时间：${ctx.now.toISOString()}（UTC）`,
      `机器人：${ctx.traderName}`,
      `决策轮次：#${ctx.cycleNumber}`,
      `交易模式：${ctx.config.tradingMode}`,
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
   * ⚠️ **账本自己对不上时，必须让模型知道"不要相信上面的绩效"。**
   *
   * 与上面那条的区别：外部活动是「账户上有别人的交易」（账是对的）；
   * 这一条是「平台记的账与交易所对不上」—— **绩效数字本身就是错的**，
   * 而模型正照着它调整策略。
   *
   * 不告诉它的后果正是用户描述的那个：模型以为自己在挣钱（或亏钱），
   * 于是一路往错误的方向调，而没有任何一处会纠正它。
   */
  if (Math.abs(a.ledgerGap ?? 0) > 0.01) {
    volatileParts.push(
      [
        '# 警告：账目与交易所对不上',
        `平台记录的盈亏与交易所的流水相差 ${fmtSigned(a.ledgerGap ?? 0, 4)} USDT。` +
          '这意味着**上面「你的交易绩效」里的数字本身可能不准** ——' +
          '它们来自平台的账本，而账本与交易所对不上。' +
          '在人工核对清楚之前，请对这种不确定性保持警惕：' +
          '不要仅凭近期的盈亏数字就大幅调整你的策略或交易频率。',
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
        `   盈亏 ${fmtPercent(pos.unrealizedPnlPercent)} | 金额 ${fmtUsd(pos.unrealizedPnl)}`,
        `   最高浮盈 ${fmtPercent(pos.peakPnlPercent)} | 杠杆 ${pos.leverage}x`,
        `   保证金 ${fmtUsd(pos.marginUsed)} | 强平价 ${pos.liquidationPrice ? fmt(pos.liquidationPrice) : '无'}`,
        pos.stopLoss ? `   止损 ${fmt(pos.stopLoss)}` : '   止损：未设置',
        pos.takeProfit ? `   止盈 ${fmt(pos.takeProfit)}` : '   止盈：未设置',
        `   已持仓 ${humanDuration(p.holdingMinutes)}`,
      ];
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
        '如果你认为那张单已经**不该再等下去**（价位错了、逻辑变了、等太久了），' +
        '下一步我会给你撤单的能力；在那之前，用 `wait` 说明你的判断即可。',
    );
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
    const blocks = candidates.map((snap, index) =>
      formatMarketData(snap, index, ctx.config, {
        detailed: index < DETAILED_CANDIDATE_COUNT || held.has(snap.symbol),
      }),
    );
    const detailedCount = blocks.filter((_, i) => i < DETAILED_CANDIDATE_COUNT).length;
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
      '请记住：',
      '- 优先管理已有持仓。如果某个持仓的逻辑已经被破坏，就平掉它。',
      '- 只有当某个机会明确满足你的入场标准和所有硬性约束时，才开新仓。',
      '- 返回 `[]`，或只包含 `hold`/`wait` 的列表，都是完全合格的答案。',
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
export const PROMPT_TOKEN_CEILING = 200_000;

/**
 * 这一轮该给多少 token 的提示词预算。
 *
 * @param inputTokenLimit 模型的输入上限；`0` 或非法值 = **不知道** → 用保守的
 *   `PROMPT_TOKEN_BUDGET`。
 *
 * 取值规则：`clamp(上限 × 0.5, 下限 6 万, 上限 20 万)`。
 *
 * 乘 0.5 而不是 0.8：这个系统一次请求里，**输出（含推理）占的比例很高** ——
 * 实测 `completion_tokens` 里 80%+ 是 `reasoning_tokens`。留一半给输出，
 * 而不是按"压缩阈值"的思路顶到 80%。
 */
export function promptTokenBudget(inputTokenLimit: number): number {
  if (!Number.isFinite(inputTokenLimit) || inputTokenLimit <= 0) return PROMPT_TOKEN_BUDGET;
  return Math.max(
    PROMPT_TOKEN_BUDGET,
    Math.min(Math.floor(inputTokenLimit * 0.5), PROMPT_TOKEN_CEILING),
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
