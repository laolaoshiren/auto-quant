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

import type { StrategyConfig } from '@aq/shared';

import { runSingleShot, runToolLoop, intensityFor, type Intensity, type LoopModel, type LoopResult } from './loop.js';
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
    trigger: string;
    observed: unknown;
    patch: unknown;
    applied: unknown;
    clamps: unknown;
    reason: string;
    toolCalls: unknown;
  }) => void;

  /** 落一次运行轨迹。 */
  recordRun: (row: {
    kind: string;
    trigger: string;
    intensity: Intensity;
    result: LoopResult;
  }) => void;

  /** 请求暂停交易（只收紧）。 */
  requestPause: (reason: string) => void;

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
  trigger: string;
  intensity: Intensity | null;
  loop: LoopResult | null;
  /** 调参之后的配置（没调就是原配置）。 */
  config: StrategyConfig | null;
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
    return { ran: false, skippedBecause: decision.why, trigger: decision.trigger, intensity: null, loop: null, config: null };
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
  const task =
    '审视当前的交易参数。先读你自己的历史调整与它们之后真实发生的結果，再决定要不要改。' +
    '一次只改少数几项 —— 一次改十项的话，之后无论结果好坏你都学不到东西。' +
    '不改也是一个正当结论。';
  const factsText = `唤醒原因：${decision.why}\n当前参数：${JSON.stringify(input.ports.readConfig())}`;

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
  const loop = await runToolLoop({
    role: 'strategist',
    task,
    facts: factsText,
    deps,
    model: input.model,
    maxSteps: chosen.intensity === 'panel' ? 12 : 8,
    // 每步实时进来 —— 这样 `set_params` 落实验记录时它已经有内容了。
    onStep: (step) => trace.steps.push(step),
  });

  // 5. 落运行轨迹
  ports.recordRun({ kind: 'strategy', trigger: decision.trigger, intensity: chosen.intensity, result: loop });

  return {
    ran: true,
    skippedBecause: null,
    trigger: decision.trigger,
    intensity: chosen.intensity,
    loop,
    config: ports.readConfig(),
  };
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
        read: {
          performance: () => null,
          equityCurve: () => null,
          experiments: () => null,
          recentDecisions: () => null,
          marketOverview: () => null,
        },
        requestPause: () => {},
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
function buildToolDeps(ports: OrchestratorPorts, context: { trigger: string; observed: unknown; steps: () => unknown }): AgentToolDeps {
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
    read: ports.toolReads,
    requestPause: (reason) => ports.requestPause(reason),
    cycleInterval: () => ports.cycleInterval(),
    setCycleInterval: (minutes, reason) => ports.setCycleInterval(minutes, reason),
  };
}
