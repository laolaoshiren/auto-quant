/**
 * 智能体的工具面。
 *
 * ## 这份文件的两件事
 *
 * 1. **告诉模型它有什么工具**（`AGENT_TOOLS`）—— 名字、说明、参数。
 *    说明是写给模型看的，所以写"什么时候用它"，而不是"它返回什么字段"。
 * 2. **执行它要求的调用**（`dispatchTool`）—— 而这是危险的一半。
 *
 * ## 为什么参数校验必须自己做
 *
 * 模型的工具调用是**和参数补丁同一类东西：不可信输入**。
 * 它可能是坏 JSON、可能少给必填参数、可能给一个字符串当数量、
 * 可能给一个负的 limit。**直接用 `args.limit` 去查数据库就是拿模型的输出当代码用。**
 *
 * 所以每个工具声明自己的参数形状，`dispatchTool` 先校验再执行。
 * 不引入 zod 之外的东西 —— 这里的形状太简单，一个几十行的校验器比再拉一个库合适
 * （§4.3：默认答案是"自己写那 30 行"）。
 *
 * ## 工具为什么必须是"窄"的
 *
 * 每个工具只暴露**一个明确的查询**，而不是"给我一段 SQL"或"给我任意字段"。
 * 工具面就是模型的手：**手能伸多远，决定了它出错时能造成多大后果**。
 * 目前所有工具要么只读，要么只能收紧（`pause_trading`），只有 `set_params` 会
 * 改变系统状态，而它过守卫层（`patch.ts`）。
 */

import type { StrategyConfig } from '@aq/shared';

import { applyAgentPatch, type AgentPatchResult } from './patch.js';

/* -------------------------------------------------------------------------- */
/*  参数声明                                                                   */
/* -------------------------------------------------------------------------- */

type ArgType = 'string' | 'number' | 'boolean' | 'object';

interface ArgSpec {
  type: ArgType;
  required?: boolean;
  min?: number;
  max?: number;
  /** 只在这些值里取值。 */
  enum?: readonly string[];
  /** 缺省值（`type: 'number'` 时用于分页上限那种场景）。 */
  default?: unknown;
  describe: string;
}

interface ToolSpec {
  name: string;
  /** 写给模型看的：**什么时候用它**，而不是它返回什么。 */
  describe: string;
  args: Record<string, ArgSpec>;
}

/* -------------------------------------------------------------------------- */
/*  工具清单                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 九个工具。**改动这里之前先读文件头**：工具面就是模型的手。
 *
 * 命名与说明都用英文 —— 与 `StrategyConfig` 的字段名、`action` 枚举一样，
 * 它们是**机器契约**（§5.2）。喂给模型的内容本身用中文。
 */
export const AGENT_TOOLS: readonly ToolSpec[] = [
  {
    name: 'get_performance',
    describe:
      'Read the realised trading performance over a window. Use this first when you need to know whether the account is winning or losing, and why. ' +
      '**Also read `byCloseReason`** — it breaks the same window down by exit reason and, for each, puts the **average peak unrealised profit next to the average actually booked** (both in margin terms, so `giveBackPercent` is directly comparable). ' +
      'That pair is the only way to see "I keep giving the profit back at the same place": a group whose `avgPeakPercent` is far above its `avgNetPercent` is leaking on the exit side. ' +
      'It is deliberately a measurement, not a recommendation — whether the fix is your breakeven line, your take-profit placement, or your exit process is your call.',
    args: {
      window: {
        type: 'string',
        enum: ['24h', '7d', '30d', 'all'],
        default: '24h',
        describe: 'How far back to look.',
      },
    },
  },
  {
    name: 'get_equity_curve',
    describe:
      'Read the equity trajectory. Use this to judge drawdowns and recoveries — a single PnL number cannot tell you whether the account is bleeding steadily or just had one bad trade.',
    args: {
      limit: { type: 'number', min: 10, max: 300, default: 60, describe: 'How many recent snapshots.' },
    },
  },
  {
    name: 'get_experiments',
    describe:
      'Read your OWN past parameter changes together with what actually happened afterwards. This is the only place where you can see whether a change you made helped. Read it before changing anything. ' +
      'Pay close attention to `repeatedFields`: it counts how many times each parameter has been changed, and the realised PnL since. ' +
      '**Changing the same field over and over while its net result stays negative is going in circles — that is evidence the approach does not work, not a reason to nudge the number once more.**',
    args: {
      limit: { type: 'number', min: 1, max: 30, default: 10, describe: 'How many past experiments.' },
    },
  },
  {
    name: 'get_lessons',
    describe:
      'Read the LESSONS written after each closed trade: why it actually won or lost, plus tags. ' +
      'Different from get_experiments — that one shows what YOU changed; this one is what the reviewer concluded about the real trades. ' +
      'Pay attention to `recurringTags`: if the same tag keeps appearing across different trades, that is your diagnosis. ' +
      'The per-trade lesson also says what it could NOT determine and why — treat a missing premise as unknown, not as favourable.',
    args: {
      limit: { type: 'number', min: 1, max: 30, default: 12, describe: 'How many recent lessons.' },
    },
  },
  {
    name: 'get_recent_decisions',
    describe:
      'Read what you decided in recent cycles, and what the risk engine rejected. A high rejection rate means your proposals do not match the parameters or the market.',
    args: {
      limit: { type: 'number', min: 1, max: 30, default: 10, describe: 'How many recent cycles.' },
    },
  },
  {
    name: 'get_market_overview',
    describe:
      'Read the current candidate universe and its volatility/volume profile. Use it to decide whether the pool itself is the problem (e.g. everything is chopping).',
    args: {
      limit: { type: 'number', min: 1, max: 30, default: 12, describe: 'How many candidate symbols.' },
    },
  },
  {
    name: 'get_skipped_outcomes',
    describe:
      'Read what happened to the symbols you LOOKED AT BUT DID NOT TRADE. ' +
      'Every cycle you reject most of the candidate pool, and without this you never learn whether those rejections were right. ' +
      'For each symbol you skipped recently it shows the price move SINCE the cycle in which you skipped it. ' +
      '**It also returns the `setupScore` you yourself gave each of them at the time** — that is what makes the filter calibratable: ' +
      'compare `avgScore` (the ones you skipped) with `avgScoreOpened` (the ones you actually acted on), and look at `biggestMovers` — ' +
      'if a symbol you scored high went up a lot, your line is drawn too high; if the high-scored ones fell too, the problem is on the exit side, not the entry bar. ' +
      '**This is the only feedback that can calibrate your entry standards.** ' +
      'If symbols you kept rejecting went up a lot, your filter is too strict — that is evidence, not opinion. ' +
      'If they fell, your caution was correct and you should NOT loosen anything. ' +
      'Note the sample is small and one-sided (it only covers symbols that reached your candidate pool at all), and the scores are your own — they may drift across cycles.',
    args: {
      cycles: {
        type: 'number',
        min: 1,
        max: 30,
        default: 8,
        describe: 'How many recent cycles of skipped symbols to look at.',
      },
    },
  },
  {
    name: 'get_current_params',
    describe:
      'Read the parameters currently in effect. Always read this before changing them — a patch is a delta, not a full replacement, and you need to know what you are changing FROM. ' +
      'The `derived` field explains the parameters whose **basis is not in their name** (for example whether a multiple applies to the round-trip or the one-way fee). ' +
      '**Read it instead of guessing from the field name** — a wrong assumption there silently doubles or halves the number you are aiming for.',
    args: {},
  },
  {
    name: 'set_params',
    describe:
      'Change the parameters that govern YOUR OWN trading — including your own instructions. ' +
      'This is a DELTA: only the fields you include change. ' +
      'Adjustable: coin selection (coinSource.*), indicators (indicators.*), how much you risk ' +
      '(riskControl.*, throttle.*, circuitBreaker.*), AND YOUR OWN PROMPT ' +
      '(promptSections.roleDefinition / tradingFrequency / entryStandards / decisionProcess, and customPrompt). ' +
      'Your prompt is a parameter like any other: if it no longer fits the market, change it — ' +
      'a fixed prompt cannot be called intelligent. ' +
      /*
       * ⚠️ **"可以删"这件事必须说出来 —— 2026-10-02 新增。**
       *
       * 用户的判断：「越更新迭代，感觉系统问题越多，越不智能越来不可用」。
       * 而数据支持这句话里最要紧的那一半：
       *
       *     它自己写的规则（`promptSections`）长度
       *       09-20  13:12      78 字符
       *       09-21  02:22     794 字符   ← 开单率 20%，净 +1.22（"有惊喜"的那几天）
       *       09-27  01:26   5,080 字符   ← 开单率 58%
       *       09-30  08:19   6,999 字符   ← 开单率 8%，此后连续 11 轮全 skip
       *
       * **规则只增不减，而新增的几乎全是"这种情况别做"。**
       *
       * 它不删的原因是**理性**的：删规则感觉像在放松风控，而它每次加规则都是
       * 因为真的亏过钱。缺的不是意愿，是**许可与机制** ——
       * 这段说明原来只说 "change it"，从没说过"`promptSections.X` 是**整体替换**的，
       * 所以你完全可以重写一整个段落、把不再适用的旧条款删掉"。
       *
       * 所以下面这两句是这次改动里最要紧的部分：把"删"明确成一个**合法且被期待**的动作。
       */
      '**AND — YOUR PROMPT SECTIONS ARE REPLACED WHOLE, SO YOU CAN DELETE AS WELL AS ADD.** ' +
      'Each `promptSections.*` field is a full replacement, not an append. ' +
      'Every rule inside it was written in response to ONE loss — and none of them have ever been ' +
      'removed, so your rulebook only grows. A rulebook that only grows eventually excludes every ' +
      'market there is. **Periodically re-read your own `entryStandards` / `decisionProcess` and ' +
      'rewrite them**: keep what still earns its place, drop what was true only for one symbol in ' +
      'one week. Pruning your own rules is a legitimate and expected move — not a loosening of risk ' +
      'control. (Hard limits — leverage, notional, margin, position count — are code-enforced and ' +
      'unaffected by anything you write here.) ' +
      'You MUST give a reason — an unexplained change cannot be reviewed later. ' +
      'Anything the structural guard overrides is reported back in clamps.' +
      /*
       * ⚠️ **"看多长的周期"是一个一等一的交易决策，而它原来只被 `indicators.*` 一笔带过。**
       *
       * 实测：机器人跑了几十轮，`indicators.kline.selectedTimeframes` 一直是
       * `["5m","15m","1h","4h"]`、`primaryTimeframe: "5m"`，**一次都没改过** ——
       * 而它自己在 `entryStandards` 里写下了「只在 15m 与 1h 同向时才考虑入场」，
       * 也就是**它给自己上了锁，却不知道钥匙就在这个工具里**。
       *
       * 真人交易员不是这么做的：看到刚放量的突破会去翻 1m/5m 找精确入场点；
       * 判断一波趋势还能不能拿，会去看 4h/1d 的结构。**同一个币在不同时刻该看不同周期。**
       *
       * 所以这里照 `set_cycle_interval` 的写法（那个工具的说明把"多久醒一次"讲成了
       * 交易决策而不是设置，效果明显好得多）把同一件事讲透。
       */
      ' ' +
      '**AND — reading the right timeframes is a first-class trading decision, not a setting.** ' +
      '`indicators.kline.selectedTimeframes` decides which candles you actually SEE, and ' +
      '`indicators.kline.primaryTimeframe` / `promptPoints` decide how much of each. ' +
      'They are all adjustable above. Ask yourself regularly: *is the timeframe I am staring at ' +
      'the one this opportunity lives on?* A breakout that just printed huge volume is a 1m/5m ' +
      'question; whether a trend still holds is a 4h/1d question. If your own entry standards ' +
      'name fixed timeframes ("only when 15m and 1h agree"), that rule is a parameter too — ' +
      're-read it against the market you are actually in, not the market you wrote it for. ' +
      'Changes take effect on your next cycle.',
    args: {
      patch: { type: 'object', required: true, describe: 'The fields to change.' },
      reason: {
        type: 'string',
        required: true,
        min: 1,
        max: 2000,
        describe: 'Why you are making this change. Written for a human reviewing it later.',
      },
    },
  },
  {
    name: 'set_cycle_interval',
    describe:
      'Change how often YOU wake up to make decisions, in minutes (1–1440). ' +
      'This is a first-class trading decision, not a setting: ' +
      'wake up often when the market is moving and you have room to act; ' +
      'wake up rarely when nothing is happening, when you are holding a position ' +
      'whose thesis needs time to play out, or when you keep deciding to do nothing ' +
      '(every cycle costs tokens and attention). ' +
      'The new value takes effect on your very next cycle — no restart needed. ' +
      'You MUST give a reason.',
    args: {
      minutes: {
        type: 'number',
        required: true,
        min: 1,
        max: 1440,
        describe: 'How many minutes between cycles.',
      },
      reason: {
        type: 'string',
        required: true,
        min: 1,
        max: 2000,
        describe: 'Why this frequency fits the current situation.',
      },
    },
  },
  {
    name: 'pause_trading',
    describe:
      'Stand aside: stop opening new positions while you keep managing what you already hold (protective orders, closes, reduces all continue). ' +
      'Use it when the market or your own recent results say you should wait. ' +
      // ⚠️ 这段原来是「This only ever TIGHTENS — there is no "resume" tool, because
      // resuming is a decision the operator makes.」—— **那个前提是错的**：
      // 它假设"操作员会替你恢复"，而这个系统是**全自动**的（用户 2026-10-04
      // 的原话：「智能托管就是完全交给 AI 操作，AI 要能 24 小时全自动交易」）。
      // 后果是那个开关**只能设不能撤**，机器人永久停在新仓之外。
      'It is NOT permanent: you can lift it yourself with `resume_trading` once you judge the reason is gone. ' +
      'Stopping is a decision about *right now*, not a verdict on the strategy — do not leave it on out of inertia.',
    args: {
      reason: { type: 'string', required: true, min: 1, max: 2000, describe: 'Why you are standing aside.' },
    },
  },
  {
    name: 'resume_trading',
    describe:
      'Lift a `pause_trading` you set earlier, so you can open new positions again. ' +
      'Call it once the reason you stood aside no longer holds — the reason is echoed back to you every turn while the pause is on, ' +
      'so you can compare it against what you see now. ' +
      'Only lifts YOUR OWN pause; it cannot touch anything else (risk parameters, positions, orders). ' +
      'Staying aside forever is a choice too — if the reason still holds, leave it on and say why in `finish`.',
    args: {
      reason: { type: 'string', required: true, min: 1, max: 2000, describe: 'What changed that makes opening new positions appropriate again.' },
    },
  },
  {
    name: 'finish',
    describe:
      'End this turn. Call it when you are done — do not keep calling tools to look busy. If you found nothing worth changing, say so; "no change" is a valid and often correct conclusion.',
    args: {
      summary: { type: 'string', required: true, min: 1, max: 2000, describe: 'What you concluded.' },
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  参数校验                                                                   */
/* -------------------------------------------------------------------------- */

export interface ArgError {
  arg: string;
  why: string;
}

/**
 * 按声明校验参数。
 *
 * 返回 `errors` 非空时**不要执行工具** —— 把错误原样回喂给模型，
 * 它下一轮通常能自己改对。**不要静默用默认值兜底**：那会让模型以为
 * "我传了 limit=99999"生效了，而实际用了 30，于是它对结果的理解是错的。
 */
export function validateArgs(
  spec: ToolSpec,
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: ArgError[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ arg: '(root)', why: `参数必须是一个对象，收到 ${Array.isArray(raw) ? 'array' : typeof raw}` }] };
  }
  const input = raw as Record<string, unknown>;
  const errors: ArgError[] = [];
  const value: Record<string, unknown> = {};

  for (const [name, arg] of Object.entries(spec.args)) {
    const given = input[name];

    if (given === undefined || given === null) {
      if (arg.required) {
        errors.push({ arg: name, why: '必填参数缺失' });
      } else if (arg.default !== undefined) {
        value[name] = arg.default;
      }
      continue;
    }

    if (arg.type === 'number') {
      // 只接受真的数字。字符串数字要拒绝 —— 模型写 "10" 时它心里想的可能是别的东西，
      // 悄悄转成 10 会让一次参数错误变成一个看不见的行为差异。
      if (typeof given !== 'number' || !Number.isFinite(given)) {
        errors.push({ arg: name, why: `必须是有限数字，收到 ${JSON.stringify(given)}` });
        continue;
      }
      if (arg.min !== undefined && given < arg.min) {
        errors.push({ arg: name, why: `不得小于 ${arg.min}，收到 ${given}` });
        continue;
      }
      if (arg.max !== undefined && given > arg.max) {
        errors.push({ arg: name, why: `不得大于 ${arg.max}，收到 ${given}` });
        continue;
      }
      value[name] = given;
      continue;
    }

    if (typeof given !== arg.type) {
      errors.push({ arg: name, why: `必须是 ${arg.type}，收到 ${typeof given}` });
      continue;
    }

    if (arg.enum && !arg.enum.includes(given as string)) {
      errors.push({ arg: name, why: `只能是 ${arg.enum.join(' / ')} 之一，收到 ${JSON.stringify(given)}` });
      continue;
    }
    if (arg.type === 'string') {
      const s = given as string;
      if (arg.min !== undefined && s.length < arg.min) {
        errors.push({ arg: name, why: '不得为空' });
        continue;
      }
      if (arg.max !== undefined && s.length > arg.max) {
        errors.push({ arg: name, why: `不得超过 ${arg.max} 字，收到 ${s.length} 字` });
        continue;
      }
    }
    value[name] = given;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/* -------------------------------------------------------------------------- */
/*  分发                                                                       */
/* -------------------------------------------------------------------------- */

/** 分发需要的全部外部能力。做成注入，工具层就能在没有网络与数据库的情况下被测试。 */
export interface AgentToolDeps {
  /** 当前生效的配置（补丁的基准）。 */
  currentConfig: () => StrategyConfig;
  /** 写回一份新配置。由调用方决定怎么落库（策略表 / 机器人覆盖）。 */
  saveConfig: (config: StrategyConfig, context: { reason: string; patch: unknown; clamps: unknown }) => void;
  /**
   * 记下**被守卫拒绝**的补丁。
   *
   * 与 `saveConfig` 分开而不是给它加一个标记位：两者的后果完全不同 ——
   * 一个会改变生效配置，一个只留痕。混在一个方法里，调用方很容易在某次重构中
   * 把"被拒"也传进 `saveConfig`。
   *
   * 被拒的补丁不留记录时，AI 看不到自己试过什么、为什么不行 —— 那等于让它
   * 只从成功里学，而"什么不能做"这一半的知识全靠撞墙才知道。
   */
  recordRejectedPatch: (meta: { reason: string; patch: unknown; rejected: unknown }) => void;
  /** 读取工具的实现。返回**已经可以喂给模型**的结构化对象。 */
  read: {
    performance: (window: string) => unknown;
    equityCurve: (limit: number) => unknown;
    experiments: (limit: number) => unknown;
    lessons: (limit: number) => unknown;
    recentDecisions: (limit: number) => unknown;
    marketOverview: (limit: number) => unknown;
    /**
     * **被自己否掉的标的，后来走了多少** —— 校准入场标准的唯一反馈。
     *
     * ## 为什么这个必须存在
     *
     * 模型每轮把候选池里的绝大多数标的否掉，而它**永远不知道那些标的后来的走势**。
     * 那意味着它的入场标准（无论是 `minRiskRewardRatio`、`minScore` 还是它自己写的
     * `entryStandards`）**从来得不到任何校准** —— 它只能从"成交过的那些"里学，
     * 而那恰恰是经过筛选的样本。
     *
     * 实测证据：一个机器人在自己的审视结论里明确写下了它缺什么 ——
     * 「minScore 我**没有任何'被滤掉的标的后来是否走了行情'的数据，无依据不动**」。
     * 工具面缺了这一项，它就只能靠猜或者不动。
     *
     * ⚠️ 样本是**有偏的**：只覆盖进过候选池的标的，而且窗口很短。
     * 所以返回值必须把样本量一起给出来，让模型自己判断可信度。
     */
    skippedOutcomes: (cycles: number) => Promise<unknown>;
  };
  /** 请求暂停交易（只收紧）。 */
  requestPause: (reason: string) => void;
  /**
   * **撤销自己设下的暂停** —— 恢复开新仓。
   *
   * 与 `requestPause` 成对：停手是 AI 的自我约束，撤销它同样是 AI 的判断。
   * 它**只**动那一个开关，不碰风控参数、不碰仓位（那些仍受"只能收紧"约束）。
   *
   * 从前没有这个能力，理由是"恢复由操作员决定" —— 而本系统是全自动的
   * （用户 2026-10-04：「智能托管就是完全交给 AI 操作，AI 要能 24 小时全自动交易」），
   * 于是那个开关**只能设不能撤**，机器人永久停在新仓之外。
   */
  clearPause: () => void;
  /**
   * 改变**自己的决策周期**（分钟）。
   *
   * 为什么单独一个能力、而不是塞进 `saveConfig`：
   * 决策周期不活在 `StrategyConfig` 里 —— 它是 `traders` 表上的一列
   * （因为调度器要在**配置之外**读它）。放在这里是让那件事**显式可见**，
   * 而不是让工具层去猜它属于哪张表。
   */
  /** 当前的决策周期（分钟）—— `get_current_params` 要把它一起给出。 */
  cycleInterval: () => number;
  setCycleInterval: (minutes: number, reason: string) => { minutes: number; clamped: boolean };
}

export interface ToolOutcome {
  /** 喂回给模型的内容。**必须可以用 JSON 序列化。** */
  result: unknown;
  /** `finish` 被调用时带上它的结论，循环据此结束。 */
  finished?: { summary: string };
  /** `set_params` 的守卫结果（含被钳制的项），调用方要落库。 */
  patch?: AgentPatchResult;
  /** `pause_trading` 被调用。 */
  paused?: { reason: string };
}

/**
 * 单个工具结果的最大字符数 —— 超出就在**合法边界**上裁。
 *
 * ## 为什么从 6000 提到 40000
 *
 * 6000 字符约 3,500 token。而提示词预算现在是**按模型能力算的**：
 * 1M 上下文的模型拿到 **80 万**（见 `promptTokenBudget`）—— 6000 字符只占
 * **0.4%**。
 *
 * 而代价是实打实的：一次策略审视里模型可能连着调十几次工具，每次都只能看到
 * 被切掉的结果。**"工具返回被砍"会直接降低它判断的质量** —— 而这与用户的原则
 * （「在**最大化发挥模型能力**的前提下，才考虑优化模型成本」）相反。
 *
 * 40000 字符约 23,000 token：**仍只占 80 万预算的 3%**，而常规调用（绩效、
 * 教训、最近决策）从此基本不会触发截断 —— 只有真正拉了整张表的调用才会。
 *
 * ## 为什么要在这里说清"截断是有损的"
 *
 * 原注释写得对：「裁剪是**有损的**，所以一定要在结果里说明裁了，否则模型会以为
 * 自己看到了全部 —— 那比不给它数据更糟。」这一点没变，`bound()` 仍然在结果里
 * 明确写出 `truncated: true` 与原文长度。
 */
export const MAX_JSON_CHARS = 40_000;

/**
 * 几个**光看字段名推不出含义**的派生量，挂在 `get_current_params` 的结果上。
 *
 * ## 为什么需要它（实测）
 *
 * 一次真实的策略审视里，AI 把 `minStopLossFeeMultiple` 从 3 改成 6，然后在
 * `reason` 里写下这样一句：
 *
 *   「不确定项已标注：该乘数的基准我只能从命名与 `fallbackRoundTripFeeRate` 推断为
 *     往返费；**若实际按单边费计，本次改动几乎空转**」
 *
 * 它的推断**是对的**（`RiskEngine.reviewOpen` 与交易员提示词都用往返费率），
 * 但**它本不该猜**：那个定义写在**交易员的提示词**里（`feeAwareStopConstraint`），
 * 而策略师只拿得到配置对象。
 *
 * 猜错的代价很实：这个参数的作用是"止损不能比交易成本还近"，基准差一倍、
 * 目标值就差一倍 —— 而 AI 会照着一个错的前提去调它，并在下一轮把它当成已验证的事实。
 *
 * ## 为什么不是把整份配置的说明都写进来
 *
 * 那会挤占预算（`bound()` 在 `MAX_JSON_CHARS` 处截断），而且大多数参数的名字
 * 已经说清了自己。这里只列**真的会读错**的那几个 —— 判断标准是
 * "**它的基准或方向不在名字里**"。
 *
 * ## 只写定义，不写建议
 *
 * 这些是**事实**（基准是什么、当前折算出来是多少），不是"应该设成多少"。
 * 后者是策略师的判断，不该由工具层替它做。
 */
export function derivedRiskFigures(config: StrategyConfig): Record<string, string> {
  const risk = config.riskControl;
  const floorPercent = risk.fallbackRoundTripFeeRate * risk.minStopLossFeeMultiple * 100;
  const fallbackPercent = (risk.fallbackRoundTripFeeRate * 100).toFixed(3);
  return {
    'riskControl.minStopLossFeeMultiple':
      `基准是【往返】手续费 —— 开仓 + 平仓两侧合计，不是单边。` +
      `按兜底费率 ${fallbackPercent}% 折算，当前要求止损幅度 ≥ ${floorPercent.toFixed(3)}%。` +
      '（有近期成交时，风控会用实测往返费率替换兜底值。）',
    'riskControl.fallbackRoundTripFeeRate':
      `【往返】费率（两侧合计），不是单边。当前 ${fallbackPercent}%。` +
      '有近期成交记录时它会被实测值替换 —— 所以它只是兜底。',
    'riskControl.breakevenTriggerPercent':
      '浮盈达到这个百分比时，把止损抬到开仓成本价。' +
      '它**不会**限制浮盈、也不影响开仓，只在达到之后改变止损的位置。',
  };
}

/**
 * 把结果裁到模型读得下的长度。
 *
 * 工具不该把整张表倒进提示词。裁剪是**有损的**，所以一定要在结果里说明裁了，
 * 否则模型会以为自己看到了全部 —— 那比不给它数据更糟。
 *
 * ## ⚠️ `preview` 是**字符切片**，所以它多半不是合法 JSON
 *
 * 这一点必须在 `note` 里说清：模型拿到一段以 `,{"id":31,"sym` 结尾的文本时，
 * 如果以为那是一个 JSON 对象，它会把解析失败归因于自己。**说清"这是原始文本的
 * 前 N 个字符"**，它才知道该做什么（缩小 `limit` 再取一次）。
 */
function bound(result: unknown): unknown {
  const text = JSON.stringify(result);
  if (text.length <= MAX_JSON_CHARS) return result;
  return {
    truncated: true,
    note:
      `结果过长（原始 ${text.length} 字符）已截断到前 ${MAX_JSON_CHARS} 字符。` +
      '**`preview` 是原始文本的字符切片，通常在 JSON 中间断开 —— 不要把它当成可解析的 JSON。**' +
      '要拿到完整且合法的结果，请**减小这个调用的 `limit` 参数**再取一次（多数工具都支持它），' +
      '或者改用更窄的查询条件。',
    original_length: text.length,
    preview: text.slice(0, MAX_JSON_CHARS),
  };
}

/**
 * 执行一次工具调用。
 *
 * @param name 工具名。**不可信** —— 未知名字返回错误而不是抛异常：
 *             一次幻觉出来的工具名不该让整个循环崩掉。
 * @param args 参数。**不可信**，先过 `validateArgs`。
 */
export async function dispatchTool(
  name: unknown,
  args: unknown,
  deps: AgentToolDeps,
): Promise<ToolOutcome> {
  const spec = AGENT_TOOLS.find((t) => t.name === name);
  if (!spec) {
    return {
      result: {
        error: `没有名为 ${JSON.stringify(name)} 的工具。可用的工具：${AGENT_TOOLS.map((t) => t.name).join(' / ')}`,
      },
    };
  }

  const checked = validateArgs(spec, args ?? {});
  if (!checked.ok) {
    return {
      result: {
        error: '参数不合格，本次调用没有执行。',
        problems: checked.errors.map((e) => `${e.arg}: ${e.why}`),
      },
    };
  }
  const a = checked.value;

  switch (spec.name) {
    case 'get_performance':
      return { result: bound(deps.read.performance(a.window as string)) };
    case 'get_equity_curve':
      return { result: bound(deps.read.equityCurve(a.limit as number)) };
    case 'get_experiments':
      return { result: bound(deps.read.experiments(a.limit as number)) };
    case 'get_lessons':
      return { result: bound(deps.read.lessons(a.limit as number)) };
    case 'get_recent_decisions':
      return { result: bound(deps.read.recentDecisions(a.limit as number)) };
    case 'get_market_overview':
      return { result: bound(deps.read.marketOverview(a.limit as number)) };
    case 'get_skipped_outcomes':
      /*
       * 异步：它要**拉历史价格**才能算出"被否掉之后走了多少"。
       * 这是唯一一个需要网络往返的只读工具，所以也是唯一一个 `await` 的 case。
       */
      return { result: bound(await deps.read.skippedOutcomes(a.cycles as number)) };
    case 'get_current_params':
      /*
       * 「当前参数」**必须把决策周期一起给出来**。
       *
       * 它不在 `StrategyConfig` 里（是 `traders` 表上的一列），所以第一版
       * 这个工具读不到它 —— 于是 AI 想调频率时**不知道自己现在是多少**，
       * 只能瞎猜一个数。**不知道起点就没法判断该往哪边调。**
       *
       * `derived` 是同一条道理的下一层：AI 看得到 `minStopLossFeeMultiple: 3`，
       * 却看不到它**是几倍于什么** —— 见 `derivedRiskFigures` 上的说明。
       */
      return {
        result: bound({
          ...deps.currentConfig(),
          cycleIntervalMinutes: deps.cycleInterval(),
          derived: derivedRiskFigures(deps.currentConfig()),
        }),
      };
    case 'set_params': {
      const reason = a.reason as string;
      const patch = applyAgentPatch(deps.currentConfig(), a.patch);
      if (patch.rejected === null) {
        deps.saveConfig(patch.config, { reason, patch: a.patch, clamps: patch.clamps });
      } else {
        /*
         * ⚠️ 被拒也要落一条记录 —— 否则下一次审视的 `get_experiments` 里
         * 看不到"我试过这个、它被拒了"，AI 会重复同一个不可能通过的改动。
         * 见 `recordRejectedPatch` 的说明。
         */
        deps.recordRejectedPatch({ reason, patch: a.patch, rejected: patch.rejected });
      }
      return {
        result: {
          applied: patch.rejected === null,
          rejected: patch.rejected,
          // 钳制必须回喂：AI 以为自己改成了、而实际被守卫改掉的话，
          // 下一轮它会基于一个错误前提继续推理。
          clamps: patch.clamps,
          note:
            patch.rejected === null
              ? patch.clamps.length > 0
                ? '补丁已生效，但有几项被结构性守卫改动（见 clamps）—— 请按 clamps 里的实际值理解现在的参数。'
                : '补丁已生效。'
              : '补丁被整体拒绝，一个字段都没改。',
        },
        patch,
      };
    }
    case 'set_cycle_interval': {
      const reason = a.reason as string;
      const requested = Number(a.minutes);
      const applied = deps.setCycleInterval(requested, reason);
      return {
        result: {
          minutes: applied.minutes,
          /*
           * 被钳制时**必须回喂实际值** —— 与 `set_params` 的 clamps 同一个理由：
           * AI 以为自己改成了 0.5 分钟、而实际是 1 的话，
           * 下一轮它会基于一个错误前提推理（"我刚提高了频率"）。
           */
          clamped: applied.clamped,
          note: applied.clamped
            ? `请求的 ${requested} 分钟超出允许范围（1–1440），实际设为 ${applied.minutes} 分钟。`
            : `决策周期已改为每 ${applied.minutes} 分钟一次，从下一轮起生效。`,
        },
      };
    }
    case 'pause_trading': {
      const reason = a.reason as string;
      deps.requestPause(reason);
      return {
        result: {
          paused: true,
          note:
            '已停止开新仓（止损/止盈/平仓/减仓照常执行）。' +
            '这不是永久决定 —— 等你判断当初的理由不再成立，可以自己调 resume_trading 恢复。',
        },
        paused: { reason },
      };
    }
    case 'resume_trading': {
      const reason = a.reason as string;
      /*
       * ⚠️ **恢复是 AI 自己的权限，不再需要操作员。**
       *
       * 原来那条路是死的：`pause_trading` 能设、交易循环也读它拦开仓，
       * 而撤销它的函数在生产代码里零引用 —— 开关落下就撤不掉，
       * 机器人永久停在新仓之外（用户 2026-10-04 发现的）。
       *
       * 而它**只**动这一个开关：不碰风控参数、不碰仓位、不下任何单。
       * 停手是 AI 的自我约束，撤销它同样是 AI 的判断 —— 这与
       * 「`set_params` 只能收紧」那条并不冲突（那条管的是**风控边界**）。
       */
      deps.clearPause();
      return {
        result: {
          paused: false,
          note: `已恢复开新仓（${reason}）。下一轮起可以正常建仓。`,
        },
      };
    }
    case 'finish':
      return { result: { done: true }, finished: { summary: a.summary as string } };
    default:
      // 走到这里说明 AGENT_TOOLS 加了工具但忘了加分支 —— 类型上不可能，
      // 运行时也不该静默返回空结果。
      return { result: { error: `工具 ${spec.name} 已声明但没有实现` } };
  }
}

/** 把工具清单渲染成给模型看的说明。 */
export function renderToolCatalogue(): string {
  return AGENT_TOOLS.map((t) => {
    const args = Object.entries(t.args);
    const argText =
      args.length === 0
        ? '（无参数）'
        : args
            .map(([n, s]) => {
              const bits: string[] = [s.type];
              if (s.enum) bits.push(s.enum.join('|'));
              if (s.min !== undefined || s.max !== undefined) bits.push(`${s.min ?? ''}..${s.max ?? ''}`);
              if (s.required) bits.push('必填');
              return `  - ${n} (${bits.join(', ')})：${s.describe}`;
            })
            .join('\n');
    return `### ${t.name}\n${t.describe}\n${argText}`;
  }).join('\n\n');
}
