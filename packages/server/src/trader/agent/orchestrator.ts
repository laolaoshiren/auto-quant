/**
 * 编排层：把守卫、工具、角色、循环、触发串成一条能跑的流程。
 *
 * ## 这一层只负责"流程"，不负责"判断"
 *
 * 所有外部能力（读数据、跑模型、落库）都从**端口**注入。好处有两个：
 *
 * 1. **整条流程可以用桩测试** —— "调参之后有没有落实验记录"、
 *    "结果够了有没有结算"、"预算用完了会不会降级"这些都能断言，
 *    而不需要起数据库也不需要花钱调模型。
 * 2. 真实接线（SQLite + LLM 客户端）只是一层薄适配，改它不影响流程。
 *
 * ## 三条流程纪律
 *
 * 1. **先结算旧实验，再开始新的一轮。** 否则策略师看到的历史里，
 *    它自己最近那次调整永远是"还没有结果" —— 那等于让它闭着眼睛调参。
 * 2. **调参必须落实验记录，回填必须落结果。** 这是「越跑越厉害」的全部机制；
 *    少了任何一半，它就退化成一个每轮重新开始的普通模型调用。
 * 3. **任何一步失败都不抛穿。** 智能体是交易的**附加**能力，不是前置条件 ——
 *    它坏了不该让机器人停止交易。
 */

import type { AgentRunKind, StrategyConfig, WakeTrigger } from '@aq/shared';

import { runSingleShot, runToolLoop, intensityFor, type Intensity, type LoopModel, type LoopResult } from './loop.js';
import type { AgentRole } from './roles.js';
import { decideSettle, decideWake, DEFAULT_WAKE_POLICY, type WakeDecision, type WakeFacts, type WakePolicy } from './wake.js';
import type { AgentToolDeps } from './tools.js';

/* -------------------------------------------------------------------------- */
/*  端口                                                                       */
/* -------------------------------------------------------------------------- */

/** 待结算的实验（流程只关心这几个字段）。 */
export interface PendingRow {
  id: number;
  createdAt: string;
  /** 那次调整之后真实发生了什么 —— 用来判断能不能结算。 */
  tradesSince: number;
  netPnlSince: number;
}

/** 编排层需要的全部外部能力。真实实现是 SQLite + LLM；测试里是桩。 */
export interface OrchestratorPorts {
  /** 当前生效的配置，以及写回。 */
  readConfig: () => StrategyConfig;
  saveConfig: (config: StrategyConfig, meta: { reason: string; patch: unknown; clamps: unknown }) => void;

  /** 读工具的数据来源。 */
  toolReads: AgentToolDeps['read'];

  /** 收集唤醒判据需要的事实。 */
  collectFacts: () => Omit<WakeFacts, 'callsThisHour'>;
  /** 本小时已用调用次数。 */
  callsThisHour: () => number;

  /** 待结算的实验。 */
  pendingExperiments: () => PendingRow[];
  settleExperiment: (id: number, outcome: { trades: number; netPnl: number }) => void;

  /** 落一次实验记录（调参的完整上下文）。 */
  recordExperiment: (row: {
    /*
     * ⚠️ **必须是 `WakeTrigger`，不是 `string`**（t61）。
     *
     * 这一列（`agent_experiments.trigger`）的取值域就是"为什么被唤醒"，
     * 而那张名单的唯一权威是 `wake.ts` 的 `WakeTrigger` —— `@aq/shared` 里
     * `WAKE_TRIGGERS` 与它逐字一致（由 `agentRunLabels.test.ts` 的跨包守卫钉住）。
     *
     * 收 `string` 时，往这里塞一个未登记的触发原因**编译得过**、落库、然后
     * 界面上回落到裸码 —— 而"每个触发原因都有中文标签"的穷尽性测试**仍然是绿的**，
     * 因为它遍历的是联合类型，而端口早就把类型放宽了。
     */
    trigger: WakeTrigger;
    observed: unknown;
    patch: unknown;
    applied: unknown;
    clamps: unknown;
    reason: string;
    toolCalls: unknown;
  }) => void;

  /**
   * 落一次运行轨迹。
   *
   * ## ⚠️ 三个字段都必须收**联合类型**，不能收 `string`（t61）
   *
   * 这是本任务存在的全部理由。原来的签名是 `kind: string` / `trigger: string`，
   * 于是这条链**每一环都是宽的**：
   *
   * ```
   *   写入点 `kind: 'incident'`  →  端口收 string（编译通过）
   *      →  agent_runs.kind 落库  →  界面 `?? 原码` 回落到英文
   *      →  而"每个 AgentRunKind 都有标签"的穷尽测试仍然是绿的
   * ```
   *
   * 收窄之后，同一个改动**在写入点就编译不过** —— 缺陷族被堵在源头，
   * 而不是等用户在截图上看到一个新英文词。
   *
   * `intensity` 本来就是 `Intensity`（`loop.ts`），它一直是安全的；
   * 真正被放宽的只有 `kind` 与 `trigger` 两个。
   */
  recordRun: (row: {
    kind: AgentRunKind;
    trigger: WakeTrigger;
    intensity: Intensity;
    result: LoopResult;
  }) => void;


  /**
   * AI 改自己的决策周期（分钟）。落库到 `traders.cycle_interval_minutes`。
   *
   * 它**不在** `StrategyConfig` 里 —— 那是调度器要在配置之外读的一列。
   * 单独开一个口子是为了让这件事显式，而不是让工具层去猜。
   */
  /** 当前的决策周期（分钟）。 */
  cycleInterval: () => number;
  setCycleInterval: (minutes: number, reason: string) => { minutes: number; clamped: boolean };
}

/* -------------------------------------------------------------------------- */
/*  一、策略审视                                                               */
/* -------------------------------------------------------------------------- */

export interface StrategyReviewOutcome {
  /** 这一轮到底跑没跑。 */
  ran: boolean;
  /** 没跑的原因（预算/冷却/没有值得醒的事件）。**必须能说清为什么没跑**。 */
  skippedBecause: string | null;
  /**
   * 这一轮的唤醒触发原因。
   *
   * ⚠️ `WakeTrigger` 而不是 `string`（t61）：它直接来自 `decideWake()` 的
   * `WakeDecision.trigger`，而那个字段本来就已经是联合类型 —— 这里写 `string`
   * 是在**出口处白白丢掉了类型信息**，于是调用方（以及它的调用方）谁都拿不到约束。
   */
  trigger: WakeTrigger;
  intensity: Intensity | null;
  loop: LoopResult | null;
  /** 调参之后的配置（没调就是原配置）。 */
  config: StrategyConfig | null;
  /**
   * **panel 档并行跑的分析角色产出**（2026-10-14 加）。
   *
   * ```
   *   performance_analyst（绩效）+ attribution_analyst（归因）
   * ```
   * ⚠️ 只在 `intensity === 'panel'` 时非空，其它档是 `[]`。
   * ⚠️ 它们**不是策略师的输入**（策略师自己会读同样的数据）——
   * 它们是给操作员与后续归因用的旁证。所以其中一个失败不影响调参。
   */
  analysts: Array<{ role: AgentRole; result: LoopResult }>;
}

/**
 * 策略师的步数预算。
 *
 * ## 这是按"必读清单"倒推的，不是拍脑袋
 *
 * 策略师的纪律要求它**先读** `get_experiments` 与 `get_lessons`，再读绩效 / 权益曲线 /
 * 最近决策 / 当前参数 —— **6 次只读调用**，之后还要 `set_params` 与 `finish`，
 * 合计 **8 步**。原来 `single` 档给的就是 8：**一步余量都没有。**
 *
 * ## 实测的代价
 *
 * `agent_runs` 里 **39 次 `degraded`（占 33%）** 的 detail 全是同一句
 * "达到步数上限（8 步）仍未结束，本轮没有结论"，平均停在 **7.6 步**；
 * 而成功的那些平均 **7.1 步**。**两个分布贴着同一条边界** ——
 * "这一轮能不能得出结论"基本由运气决定。
 *
 * 这些运行**已经烧掉 6–7 步的 token 却什么都没产出**。再多给两三步让它把结论
 * 说出来，比让它白烧更省 —— 而"给出结论"正是这个角色存在的全部意义。
 *
 * ## 加工具时必须同步这里
 *
 * 上一轮新增 `get_lessons` 时必读清单又多一步，而预算没跟着动 ——
 * 那等于**把更多的运行推进必然撞限的区间**。`orchestrator.test.ts` 里有一条用例
 * 专门钉住"预算容得下必读清单"，就是为了让下一次加工具的人（或 AI）不会漏掉。
 */
export const STRATEGIST_MAX_STEPS = {
  /**
   * 常规轮次：必读 6 步 + 决策 + finish，再留余量。
   *
   * ## 11 → 13：实测的余量偏薄
   *
   * 线上 80 次审视的分布：
   *
   *     panel   上限 14，实际 7–13（平均 9.4）  ✅ 从没撞过
   *     single  上限 11，实际 8–11（平均 9.5）  ⚠️ 撞过一次
   *
   * 而**唯一那次 `degraded`**（"达到步数上限仍未结束，本轮没有结论"）就出在
   * single 档 —— 那一轮**烧掉 18.3 万输入 token 却什么都没产出**。
   *
   * 平均 9.5 对上限 11，余量只有 1.5 步；而步数的**分布是有长尾的**
   * （panel 档观测到过 13）。放宽到 13 让两档的余量对齐，代价是**最多多两次
   * 模型调用**，而且只在模型真的需要时才用 —— 它大多数轮次在 9–10 步就自行
   * 结束了（`agent_runs.detail` 写的是"模型在第 N 步自行结束"）。
   *
   * 用户的原则是「**在最大化发挥模型能力的前提下，才考虑优化模型成本**」：
   * 一轮 18 万 token 的**白花**，比"偶尔多花两步"贵得多。
   */
  single: 13,
  /** 完整面板：额外开了并行分析，读的东西更多。 */
  panel: 14,
} as const;

/**
 * 派给策略师的任务描述。
 *
 * ⚠️ **必须把步数预算告诉它，否则它无法规划。**
 *
 * 原来这一段只说"先读历史调整、再决定要不要改"，**一个字都没提它只有几步可走**。
 * 于是它按"反正能一直读"的方式花预算 —— 实测 39 次 `degraded`（占 33%）全是
 * "达到步数上限仍未结束，本轮没有结论"，而那些运行**已经烧掉 6–7 步的 token
 * 却什么都没产出**。
 *
 * 一个知道自己有预算的 agent 和一个不知道的，行为不一样：前者先读最关键的、
 * 并在预算内给结论；后者读完再说（然后没机会说）。
 *
 * 提成纯函数是为了**可测** —— 否则"有没有把预算写进去"只能靠读代码确认。
 */
export function strategistTask(budget: number): string {
  return (
    '审视当前的交易参数。先读你自己的历史调整与它们之后真实发生的结果，再决定要不要改。' +
    '一次只改少数几项 —— 一次改十项的话，之后无论结果好坏你都学不到东西。' +
    '不改也是一个正当结论。' +
    /*
     * ══════════════════════════════════════════════════════════════════════
     *  ⚠️ **必须让它核对"我定的规则有没有被执行"**（2026-10-14 实测抓到的缺口）
     * ══════════════════════════════════════════════════════════════════════
     *
     * ## 事故：它写的硬规则被裁决官用【规则外的理由】绕过，而它不知道
     *
     * 线上实测（`#11` `c127`）：
     * ```
     *   它写的 entryStandards：「skip 的【唯一】合法理由是 (a) 无标的 ≥0.8% 位移
     *     或 (b) 点差/深度不足。No other condition gates entry.
     *     若 (a) 满足 → 【必须】开仓」
     *
     *   bull 的论证：BLURUSDT 位移 +2.43% ≥ 0.8% → 触发
     *   裁决官的判决：skip，理由「两边赔率都不成立」← 规则外的第 (c) 个理由
     * ```
     * **规则被绕过了，而策略师连续多轮都没发现** —— 它的任务是"审视参数"，
     * 而从没有人告诉它"也要审视规则有没有被遵守"。
     *
     * ## 为什么这条指引必须显式写出来
     *
     * 它手上**已经有** `recent_decisions` 工具（现在含每条决策的 `reasoning`）——
     * 也就是说**数据是齐的，缺的是"该去找什么"**。
     * 这正是本项目反复出现的形态：**能力在、而没人告诉它要用**。
     *
     * ⚠️ 措辞刻意用"对照"而不是"检查合规"：
     * 它**有权改规则**（那才是它的职责），所以发现不一致时，
     * "改规则"和"加强约束"都是正当结论 —— 我不替它选。
     */
    '\n\n⚠️ **也要核对你写的入场标准有没有被遵守**：' +
    '用 `recent_decisions` 读最近几轮，逐条看裁决官给的 `reasoning` —— ' +
    '如果它的理由**不在**你写的允许清单里（例如你只允许"无位移"和"点差过大"，' +
    '而它用了"赔率不成立"/"接飞刀"这类别的理由），那就是**你的规则被绕过了**。' +
    '这时你有两个正当选择：**把规则改得更明确**（例如写清"不允许用其他理由拒绝"），' +
    '或者**放宽规则**（如果它的理由其实更对）。' +
    '**不要放任这个不一致存在** —— 规则被绕过而你不知道，等于你没有规则。' +
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️ **要判断门槛，就必须先读"你放过的那些标的后来怎么样了"**
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 真实情况：它【经常】读这个工具（65%），而提示词里从没要求过它读
     *
     * 线上实测（`#11`）：
     * ```
     *   get_skipped_outcomes 被用过 45/69 次（65%）· 最近 30 次里 22 次（73%）
     *   而它的 decisionProcess（1299 字）里【一个字都没提】这个工具
     * ```
     * 也就是说：它**自己**觉得该读（那说明这个工具的价值是被模型认可的），
     * 但那件事**全靠它自觉** —— 而提示词里唯一的"必读"清单
     *（`get_experiments` / `get_lessons` / `get_recent_decisions`）**没有它**。
     * 一旦预算紧张（实测 5–9 步就 finish），先被砍掉的就是这种"非必读"项。
     *
     * ## ⚠️⚠️ 我一开始的论断是错的，而错因值得记下来
     *
     * 我最初的诊断是这样的：
     * > 「最近 8 轮一次都没用 —— 每轮只读 2-3 个工具就 finish 了」
     *
     * **那是假阴性**，来自我的查询语句：
     * ```sql
     *   SELECT substr(agents_json, 1, 400) …     ← 只取前 400 字符
     * ```
     * 而 `agents_json` 实测长 2.3–4.9 KB，工具调用列表在**中后段** ——
     * 于是那 8 轮全被截成"2-3 个工具"，而完整读出来是 6-9 个、**每一轮都有校准工具**。
     *
     * 这与本项目反复记录的形态同源（`docs/AGENTS.md` §3.2）：
     * **不要把"我的查询没看到"当成"它没有发生"。**
     * 后来我用「同一个 mode、同一条记录、截断 vs 完整」的对照实验复现了这一点。
     *
     * ## 那这条指令还有必要吗：**有，但理由不同**
     *
     * 不是"它不知道要用"，而是：
     * ```
     *   · 它读它 = 【自觉】，而必读清单里没有它 → 预算紧时先被砍
     *   · 而它上次真的读了数据之后，结论是「样本太小，不足以支撑门槛调整」
     *     → 读了却因为"不知道样本小该怎么用"而没有行动
     * ```
     * 所以这条指令补的是两件事：**把"可读"变成"该读"**，以及**给样本量的用法**。
     *
     * ## 它自己的原话（说明第二件事是真的需要）
     *
     * `agent_experiments #102`：
     * ```
     *   「skipped_outcomes 样本太小(10个)……不足以支撑门槛调整」
     *   「现在再动任何参数会让 14:20 的修改无法被归因」
     * ```
     * 推理每一步都对，但结果是**永远不校准** —— 它在用"样本不够"论证"不该动"，
     * 而样本量的正确用法是**决定"结论能下多强"**，不是"要不要看"。
     *
     * ## 为什么写成"要判断门槛就先读它"（而不是"记得用某个工具"）
     *
     * 项目里已有教训：**列工具清单不如给判据**。所以这条挂在**它本来就在做的
     * 那件事**上 —— 它每轮都在判断"门槛该不该动"（那是它的职责），
     * 而那件事**离开这个数据就没法做**。这样它不会把它当成"额外的可选步骤"。
     *
     * ⚠️ **同时给最小样本量的指引**：它上次用"只有 10 个样本"否决了校准。
     * 若不给指引，它会永远等一个"足够大"的样本 —— 而那等于永不校准。
     * 样本量的正确用法是**决定"结论能下多强"，而不是"要不要看"**。
     */
    '\n\n⚠️ **要判断入场门槛该不该动，就必须先读 `get_skipped_outcomes`** —— ' +
    '它是**唯一**能告诉你"你放过的那些标的后来怎么样了"的数据源，' +
    '而你每轮都在拒绝候选池里的绝大多数标的。' +
    '只凭"最近的盈亏"调门槛是**在凭结果猜原因**：亏了可能是门槛太严（错过机会），' +
    '也可能是门槛太松（进场太晚），**两者的修法正好相反** —— ' +
    '而只有这个工具能区分它们（比较你给被拒标的的 `setupScore` 与放行的那批，' +
    '看 `biggestMovers` 里高分标的后来是涨是跌）。' +
    '\n**样本小不是不读的理由，而是"结论能下多强"的理由**：' +
    '样本少（例如 10 个）时**照读照比**，但只据此下**方向性**结论' +
    '（"被拒的高分标的普遍在涨"比"门槛应该从 0.8% 降到 0.6%"更配得上那个样本量）。' +
    '**不要因为样本小而完全不看** —— 那等于永远不校准。' +
    `\n\n⚠️ 你这一轮有 ${budget} 次工具调用的预算，**用完就必须给出结论**。` +
    '所以：先读最关键的，不要重复读同一类信息。' +
    '如果预算快用完还没读全，就用手上已有的信息下结论 —— ' +
    '**没有结论的这一轮等于白花**（实测这一档有三分之一的运行就是这么浪费掉的）。'
  );
}

/**
 * 跑一次策略审视。
 *
 * 顺序：**先结算旧实验 → 再判断该不该醒 → 再决定用哪档 → 跑循环 → 落库**。
 * 结算排在最前是刻意的（见文件头的纪律 1）。
 */
export async function runStrategyReview(input: {
  ports: OrchestratorPorts;
  model: LoopModel;
  policy?: WakePolicy;
  /** 强制唤醒（操作员点"立即分析"）。绕过冷却与事件，但**不绕过预算**。 */
  force?: boolean;
  /** 一次调参实验最多等多少笔结果。低于它不结算（见 wake.ts）。 */
  settlePolicy?: { minTrades: number; maxWaitMinutes: number };
}): Promise<StrategyReviewOutcome> {
  const policy = input.policy ?? DEFAULT_WAKE_POLICY;
  const { ports } = input;

  // 1. 先结算旧实验 —— 否则策略师看到的"上次调整"永远没有结果
  settlePending(ports, input.settlePolicy);

  // 2. 判断该不该醒
  const calls = ports.callsThisHour();
  const facts: WakeFacts = { ...ports.collectFacts(), callsThisHour: calls };
  const decision: WakeDecision = input.force
    ? { wake: true, trigger: 'manual', why: '操作员手动触发。' }
    : decideWake(facts, policy);

  if (!decision.wake) {
    /* 没醒 → 什么都没跑，所以 `analysts` 是空数组（不是 `null`：调用方可以无脑遍历）。 */
    return {
      ran: false,
      skippedBecause: decision.why,
      trigger: decision.trigger,
      intensity: null,
      loop: null,
      config: null,
      analysts: [],
    };
  }

  /*
   * 3. 决定用哪一档（由程序决定，不让模型自己选）。
   *
   * ⚠️ **策略师永远走工具循环，不适用 single 档。**
   *
   * 一开始我按"强度选择"把它也降到 single（不调工具、直接给结论），结果它的
   * `set_params` 根本没被执行 —— **而策略师的整个职责就是调参**，
   * 让它跑在没有工具的档里等于让它永远无法完成工作。测试立刻抓到了这一点。
   *
   * `single` 档只适用于**分析类**角色（绩效、归因）：那些角色确实只需要读一遍数据
   * 给个结论。强度选择的真实含义是"要不要**额外**开并行分析"，
   * 而不是"要不要给它工具"。
   */
  /*
   * `hasPosition` 与"距上次策略审视多久"是**决策当时的真实状态**，
   * 由调用方在收集事实时一并给出 —— 不能让编排层自己去猜或从别处拼。
   * 拼错的后果是"该开面板时没开"或"每轮都开最贵的那档"，两者都不会报错。
   */
  const chosen = intensityFor({
    callsThisHour: calls,
    hourlyBudget: policy.hourlyBudget,
    hasPosition: facts.hasPosition,
    minutesSinceStrategyReview: facts.minutesSinceStrategyReview,
    equityDriftPercent: facts.equityDriftPercent,
  });

  // 4. 跑循环
  const budget = chosen.intensity === 'panel' ? STRATEGIST_MAX_STEPS.panel : STRATEGIST_MAX_STEPS.single;
  const task = strategistTask(budget);
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **不要把 `tradingMode` 交给策略师**（2026-10-13 实测抓到）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故：它据此写下了一条【系统并不执行】的约束
   *
   * 原来这里是 `JSON.stringify(input.ports.readConfig())` —— **整份配置**，
   * 含 `"tradingMode":"conservative"`。而策略师据此写了
   *（`agent_experiments #81` 的 patch 原文）：
   * ```
   *   "For the **conservative mode** on this small account (~20 USDT equity):
   *    1. Enter when the 15m or 1h chart shows a directional move…"
   * ```
   * **它把"conservative"当成了一个必须遵守的档位** ——
   * 而系统在**托管模式下并不按那一档约束任何东西**
   *（`defaultAiTeamConfig()` 把 `minConfidence`/`minRiskRewardRatio`/
   *  `maxMarginUsage` 全放开了，只留 `requireStopLoss` 那个结构要求）。
   *
   * ## 为什么这比"不告诉它"更糟
   *
   * 这是**同一个假约束的第三个出口**：
   * ```
   *   ① `system_prompt` 里的 `MODE_GUIDANCE['conservative']`   ← 已修
   *   ② `user_prompt` 里的"交易模式：conservative"             ← 已修
   *   ③ **本处**：策略师的参数 dump 里的 `"tradingMode"`        ← 本轮修
   * ```
   * 前两处修完后，策略师**仍然**从这第三处读到了它 ——
   * 而它的反应是**把那个不存在的档位写进自己的规则**，
   * 于是那个假约束**从提示词搬进了它的 `entryStandards`**（会一直生效）。
   *
   * ## 修法：给它**该管的字段**，而不是整份配置
   *
   * ```
   *   ✗ tradingMode      —— 系统预设档，托管模式下不执行（给了就是假约束）
   *   ✗ name/description —— 与调参无关的元数据
   *   ✓ riskControl / throttle / circuitBreaker / coinSource / promptSections
   *                      —— 这些**确实是它能用 `set_params` 改的**
   * ```
   * ⚠️ 这正是"**只给它需要的**"那条原则：一份"什么都给"的 dump 里，
   * 每一个它管不到的字段都可能被它当成约束。
   */
  const configForStrategist = (() => {
    const cfg = input.ports.readConfig() as unknown as Record<string, unknown>;
    const { tradingMode: _drop, name: _n, description: _d, ...rest } = cfg;
    return rest;
  })();
  const factsText = `唤醒原因：${decision.why}\n当前参数：${JSON.stringify(configForStrategist)}`;

  /*
   * 工具调用的序列要进实验记录，而 `set_params` 会在**循环中途**写那条记录。
   *
   * ⚠️ 这里原本写的是"用一个引用盒子，`set_params` 发生时把当前步骤快照进去"，
   * **但那是错的**：闭包返回的是 `trace.steps` 的引用，而它在那一刻还是空数组
   * （赋值发生在循环结束之后）。实测结果就是每条调参实验的 `tool_calls_json`
   * 都是 `[]` —— **推理依据整段丢失，而且看不出来。**
   *
   * 改成让循环**每步实时回调**进来。
   */
  const trace: { steps: unknown[] } = { steps: [] };
  const deps = buildToolDeps(ports, { trigger: decision.trigger, observed: factsText, steps: () => trace.steps });

  /*
   * ⚠️ **策略师永远走工具循环，不适用单次调用档。**
   *
   * 一开始我按"强度选择"把它也降到 single（不调工具、直接给结论），结果它的
   * `set_params` 根本没被执行 —— **而策略师的整个职责就是调参**，
   * 让它跑在没有工具的档里等于让它永远无法完成工作。测试立刻抓到了这一点。
   *
   * `single` 档只适用于**分析类**角色（绩效、归因）：那些角色确实只需要读一遍数据
   * 给个结论。强度选择的真实含义是"要不要**额外**开并行分析"，
   * 而不是"要不要给它工具"。
   */
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⭐ **panel 档：并行跑两个分析角色**（2026-10-14 接线）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 为什么是这两个
   *
   * 用户需求⑤点名要有「**分析账户的**」岗位 —— 而 `performance_analyst`（绩效）
   * 与 `attribution_analyst`（归因）的 prompt **早就写好了**，只是**没有任何代码
   * 会去跑它们**：实测 149 个生产文件里零调用，只在 `.test.ts` 里被用过。
   *
   * 这与 `roles.ts` 记录过的 `engineer` 角色是**同一类缺口**：
   * ```
   *   typecheck 过 · 测试全绿 · 界面上也不报错 —— 只是它永远不会被调用
   * ```
   *（`docs/FINDING-unwired-roles.md` 有复核脚本与另外两个同类角色。）
   *
   * ## 为什么挂在 panel 档
   *
   * 上面那段注释（本文件 :352）**早就写明了意图**：
   * > 「`single` 档只适用于**分析类**角色（绩效、归因）：那些角色确实只需要
   * >  读一遍数据给个结论。强度选择的真实含义是"要不要**额外**开并行分析"。」
   *
   * **设计意图已经存在，只是实现没做。** 这里把它补上。
   *
   * ## 为什么【串行】放在策略师之后，而不是并行
   *
   * 我第一版写成并行（先启动 `analystRuns`、再 await），**测试立刻抓到了两个问题**：
   * ```
   *   ① 端到端②：轨迹条数从 1 变成 3（我给分析角色也各落了一条）
   *   ② 端到端③：策略师的 `set_params` 没被执行
   * ```
   * 第二个是真问题，而它的根因是**调用顺序**：
   * ```
   *   测试用的 modelScript 按顺序返回预设响应
   *   并行时分析角色【抢走了】本该给策略师的响应
   *   → 策略师拿到空响应 → 调参从未发生
   * ```
   * 而这不只是测试的问题 —— **生产环境同样存在这个竞争**：
   * ```
   *   `LlmClient` 有【实例内状态】（timeoutCount 驱动思考等级降档、
   *   streamDisabled 流式被拒后自我降级），三路并发共用同一个实例
   *   → 分析角色的超时会推高 timeoutCount，从而【降低策略师的思考等级】
   * ```
   * 所以改成**串行**：策略师先跑完（关键路径），分析再跑。
   *
   * ⚠️ 代价可接受：分析是**旁证**，不阻塞调参。而且它本来就在
   * `panel` 档（一轮几十秒），多两次单次调用不会改变量级。
   *
   * ⚠️ 更重要的：**策略师先跑完**意味着"调参已经生效"，
   * 之后分析的产出只影响记录，不影响行为 —— 那是安全的顺序。
   */
  const loop = await runToolLoop({
    role: 'strategist',
    task,
    facts: factsText,
    deps,
    model: input.model,
    maxSteps: chosen.intensity === 'panel' ? STRATEGIST_MAX_STEPS.panel : STRATEGIST_MAX_STEPS.single,
    // 每步实时进来 —— 这样 `set_params` 落实验记录时它已经有内容了。
    onStep: (step) => trace.steps.push(step),
  });

  /* ⚠️ 在策略师【之后】跑 —— 理由见上面那段（调用竞争与实例内状态）。 */
  const analysts = chosen.intensity === 'panel' ? await runPanelAnalysts(input, factsText, decision.trigger) : [];

  // 5. 落运行轨迹
  ports.recordRun({ kind: 'strategy', trigger: decision.trigger, intensity: chosen.intensity, result: loop });
  /*
   * ⚠️ **分析角色也各落一条轨迹** —— "跑过"这件事必须留痕。
   * 否则"接了线但看不出它在跑"与"没接线"在运维眼里完全一样
   *（这正是这些角色藏了这么久没被发现的原因）。
   */
  for (const a of analysts) {
    ports.recordRun({ kind: 'strategy', trigger: decision.trigger, intensity: chosen.intensity, result: a.result });
  }

  return {
    ran: true,
    skippedBecause: null,
    trigger: decision.trigger,
    intensity: chosen.intensity,
    loop,
    config: ports.readConfig(),
    analysts,
  };
}

/**
 * **并行跑两个分析类角色**（`performance_analyst` + `attribution_analyst`）。
 *
 * ## 为什么各自独立 catch
 *
 * 两个分析互不依赖，而"一个失败导致另一个也不跑"是纯粹的浪费 ——
 * 它们的 prompt 都要求"数据不足时如实说"，所以**部分成功是有价值的**。
 *
 * ## 为什么用 `runSingleShot` 而不是 `runToolLoop`
 *
 * 见本文件 :352 那段注释：分析类角色「只需要读一遍数据给个结论」，
 * 不需要工具循环。给它们工具只会让它们多花几步、更慢、更容易跑偏。
 *
 * ⚠️ 但**事实（`facts`）必须给全** —— 那是它们唯一的信息来源。
 */
async function runPanelAnalysts(
  input: { model: LoopModel; ports: OrchestratorPorts },
  factsText: string,
  /**
   * **真实的那一次唤醒原因** —— 由调用方把 `decision.trigger` 传进来。
   *
   * ## ⚠️ 这里原本硬编码 `trigger: 'panel'`（t61 收窄类型时抓到）
   *
   * `'panel'` **不在** `WakeTrigger` 名单里 —— 它是"档位"（`Intensity`），
   * 不是"为什么被唤醒"。而 `agent_experiments.trigger` 这一列的含义是后者。
   *
   * 为什么它一直没被发现：写入侧（`recordExperiment` 端口）收货的是 `string`，
   * 所以一个语义上根本不属于该列的取值**编译得过、落库、然后什么都不报错**。
   * 界面上的 `agent_experiments` 是策略师的输入（`get_experiments`），
   * 于是它会读到一条 `trigger: 'panel'` 的实验记录 —— 一个它无法解释的唤醒理由。
   *
   * 这条路径**只在 `panel` 档且分析角色真的调了 `set_params`/被拒补丁时才落库**
   * （`runSingleShot` 没有工具，`dispatchTool` 在单次调用里其实走不到），
   * 所以它是个**潜伏**缺陷而不是线上正在发生的故障 —— 但类型收窄让它当场现形，
   * 这正是本任务要找的东西：**类型放宽会掩盖语义错误**。
   */
  trigger: WakeTrigger,
): Promise<Array<{ role: AgentRole; result: LoopResult }>> {
  const roles: AgentRole[] = ['performance_analyst', 'attribution_analyst'];
  const settled = await Promise.all(
    roles.map(async (role) => {
      try {
        const deps = buildToolDeps(input.ports, { trigger, observed: factsText, steps: () => [] });
        const result = await runSingleShot({
          role,
          task:
            role === 'performance_analyst'
              ? '梳理这个账户到目前为止的绩效。**数据不足时如实说**（`sampleAdequate: false` 是合法结论）。'
              : '做一次归因：哪些信号/形态在赚、哪些在亏。**样本不够时如实说**，不要硬凑结论。',
          facts: factsText,
          deps,
          model: input.model,
        });
        return { role, result };
      } catch {
        /*
         * ⚠️ **不抛穿**：分析失败不该让整次审视失败。
         * 也不在这里返回 error 字段 —— `runSingleShot` 自己会把失败写进 `LoopResult`
         *（它有 `error`），再包一层会让调用方分不清"两个都失败"还是"一个失败两次"。
         */
        return null;
      }
    }),
  );
  return settled.filter((x): x is { role: AgentRole; result: LoopResult } => x !== null);
}

/* -------------------------------------------------------------------------- */
/*  二、结算                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 把等够笔数的实验结算掉。
 *
 * 单独抽出来是因为它有**两个调用点**：策略审视之前（上面），以及每个周期末尾
 * （结果刚入账时最该结算）。结算晚了会让策略师看到过期的历史。
 */
export function settlePending(
  ports: OrchestratorPorts,
  policy: { minTrades: number; maxWaitMinutes: number } = { minTrades: 5, maxWaitMinutes: 24 * 60 },
): { settled: number; reasons: string[] } {
  const nowMs = Date.now();
  const reasons: string[] = [];
  let settled = 0;

  for (const row of ports.pendingExperiments()) {
    const d = decideSettle(
      { id: row.id, createdAt: row.createdAt },
      { tradesSince: row.tradesSince, netPnlSince: row.netPnlSince, nowMs },
      policy,
    );
    if (!d.settle || !d.outcome) continue;
    ports.settleExperiment(row.id, d.outcome);
    settled += 1;
    reasons.push(`#${row.id}：${d.why}`);
  }

  return { settled, reasons };
}

/* -------------------------------------------------------------------------- */
/*  三、复盘                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReviewOutcome {
  ok: boolean;
  lesson: string | null;
  error: string | null;
}

/**
 * 一笔平仓之后写一条因果结论。
 *
 * 这是 `agent_memory` 的唯一写入路径，也是"前车之鉴"的来源。
 * **失败不抛穿**：复盘是附加动作，它坏了不该让交易周期失败。
 */
export async function reviewClosedTrade(input: {
  model: LoopModel;
  trade: { symbol: string; closeReason: string; netPnl: number; entryReasoning?: string | null };
  facts: string;
  save: (memory: { symbol: string; closeReason: string; netPnl: number; lesson: string; tags: string[] }) => void;
}): Promise<ReviewOutcome> {
  try {
    const r = await runSingleShot({
      role: 'reviewer',
      task:
        `这笔已平仓：${input.trade.symbol}，以「${input.trade.closeReason}」结束，净 ${input.trade.netPnl.toFixed(4)}。` +
        '写下"这笔为什么赚/亏" —— 要具体到可复用的程度，并区分决策质量与结果。',
      facts: input.facts,
      deps: {
        currentConfig: () => ({}) as StrategyConfig,
        saveConfig: () => {},
    recordRejectedPatch: () => {},
        read: {
          performance: () => null,
          equityCurve: () => null,
          experiments: () => null,
          lessons: () => null,
          recentDecisions: () => null,
          marketOverview: () => null,
          skippedOutcomes: async () => ({}),
        },
        /*
         * 复盘用的桩：**它不该改周期**。
         *
         * 复盘是"这笔为什么赚/亏"的学习环节，而改决策频率是一次交易决策
         * —— 让复盘阶段能顺手改掉调度参数，等于给一条只该反思的路径开了写权限。
         */
        cycleInterval: () => 0,
        setCycleInterval: () => ({ minutes: 0, clamped: false }),
      },
      model: input.model,
    });

    if (r.outcome !== 'ok' || !r.conclusion) {
      return { ok: false, lesson: null, error: r.detail };
    }

    const parsed = JSON.parse(r.conclusion) as { lesson?: unknown; tags?: unknown; decisionQuality?: unknown };
    const lesson = typeof parsed.lesson === 'string' ? parsed.lesson : null;
    if (!lesson) return { ok: false, lesson: null, error: '复盘结论里没有 lesson 字段' };

    /*
     * 决策质量与结果不符时，**在标签里显式标出来**。
     *
     * 一笔好决策可能亏钱、一笔坏决策可能赚钱。不标的话，记忆里会积累
     * "这样做亏过"这种错误教训 —— 而它们以后会被检索出来误导决策。
     */
    const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [];
    if (typeof parsed.decisionQuality === 'string') tags.push(`决策质量:${parsed.decisionQuality}`);

    input.save({
      symbol: input.trade.symbol,
      closeReason: input.trade.closeReason,
      netPnl: input.trade.netPnl,
      lesson,
      tags,
    });
    return { ok: true, lesson, error: null };
  } catch (error) {
    // 复盘失败不该影响交易 —— 它是附加能力，不是前置条件
    return { ok: false, lesson: null, error: (error as Error).message };
  }
}

/* -------------------------------------------------------------------------- */
/*  内部                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 把端口拼成工具层要的形状。
 *
 * ## 为什么 `saveConfig` 里要顺手落实验记录
 *
 * 这不是"顺手"，是**必需**：`agent_experiments` 是「越跑越厉害」的全部机制，
 * 而 `set_params` 的 meta 里恰好带着实验记录要的全部内容 ——
 * `reason`（为什么改）、`patch`（想改成什么）、`clamps`（被守卫改成了什么）。
 *
 * 一开始我把"写配置"和"记实验"分成两个端口，结果流程里**没有任何地方调用
 * `recordExperiment`** —— AI 调了参，但它的历史里没有这次调整的记录，
 * 下一轮读不到"我上次改了什么、之后发生了什么"。**而系统看起来一切正常。**
 *
 * 所以两件事必须在同一个地方发生：**配置改了却没有记录，等于这次改动不存在。**
 */
function buildToolDeps(ports: OrchestratorPorts, context: { trigger: WakeTrigger; observed: unknown; steps: () => unknown }): AgentToolDeps {
  return {
    currentConfig: () => ports.readConfig(),
    saveConfig: (config, meta) => {
      ports.saveConfig(config, meta);
      ports.recordExperiment({
        trigger: context.trigger,
        observed: context.observed,
        patch: meta.patch,
        applied: config,
        clamps: meta.clamps,
        reason: meta.reason,
        // 工具调用序列在循环结束后才完整，所以传的是一个取值的闭包。
        toolCalls: context.steps(),
      });
    },
    /*
     * ⚠️ **被守卫拒绝的补丁也要留一条记录。**
     *
     * 原来被拒时只有工具回喂给模型**本轮**的 `note`（"补丁被整体拒绝，一个字段都没改"），
     * 而**库里的 `agent_experiments` 里什么都没有**。于是下一次审视时，
     * `get_experiments` 看不到它试过这次 —— AI 会**再试一遍同一个被拒的改动**，
     * 而它无从知道上一次为什么不行。
     *
     * 这一条对"越跑越准"是必要的：一个只记录成功的实验日志，训练不出
     * "什么不能做"这一半的知识。`applied` 传 `null` 明确表示**没有生效**
     * （而不是传一份看起来像成功的配置）。
     */
    recordRejectedPatch: (meta) => {
      ports.recordExperiment({
        trigger: context.trigger,
        observed: context.observed,
        patch: meta.patch,
        applied: null,
        clamps: [],
        reason: `${meta.reason}；被守卫整体拒绝（${meta.rejected}），一个字段都没改`,
        toolCalls: context.steps(),
      });
    },
    read: ports.toolReads,
    cycleInterval: () => ports.cycleInterval(),
    setCycleInterval: (minutes, reason) => ports.setCycleInterval(minutes, reason),
  };
}
