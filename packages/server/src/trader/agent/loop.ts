/**
 * 工具循环。
 *
 * ## 这是"智能体"的心脏
 *
 * 与之前所有"定时问一次模型"的区别：模型不再只回答一个问题，而是**用工具行动、
 * 看到结果、再决定下一步**，直到它自己说结束（或撞上上限）。
 *
 * ## 协议是提示词式的，不是原生工具调用
 *
 * LLM 客户端只有 `complete(system, prompt)`，没有 `tools` 参数。所以模型每轮输出
 * **一个 JSON**：
 *
 *     {"thought": "为什么这么做", "tool": "get_performance", "args": {"window": "24h"}}
 *
 * 程序执行、把结果回喂、再让它继续。这样与厂商无关，换模型不用改代码。
 *
 * ## 三条必须有界/必须诚实的地方
 *
 * 1. **步数上限。** 一个不收敛的循环在不设上限时会一直烧钱 —— 实测单次决策约
 *    5.8 万 tokens，一个没有上限的循环能在一小时内烧掉几百次调用。
 * 2. **停下时必须说明是"它自己说完了"还是"被上限截断"。** 两者对上游的含义完全
 *    不同：前者是结论，后者是**没有结论**。把它们混成同一个 `ok` 会让上层
 *    把一个截断的半成品当成完整判断去用。
 * 3. **模型输出坏掉时降级，不猜。** 抽不出工具调用就把这一条错误回喂一次；
 *    再坏就结束并标记 `failed` —— **绝不用默认值替它编一个动作**。
 */

import { parseNativeToolCalls } from './nativeToolCall.js';
import { contextFor, parseRoleOutput, renderPriorFailures, ROLES, type AgentRole } from './roles.js';
import { dispatchTool, renderToolCatalogue, type AgentToolDeps } from './tools.js';
import type { AgentMemoryRow } from '../../store/agentStore.js';

/* -------------------------------------------------------------------------- */
/*  注入的模型                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 循环需要的模型能力。
 *
 * 只有 `complete()` —— 与 `AutoTrader` 用的 `DecisionModel` 同一个形状，
 * 所以真实的 LLM 客户端可以直接传进来，测试里换成桩。
 */
export interface LoopModel {
  complete(
    system: string,
    user: string,
  ): Promise<{
    text: string;
    usage: { promptTokens: number | null; completionTokens: number | null };
    latencyMs: number;
  }>;
}

/* -------------------------------------------------------------------------- */
/*  结果                                                                       */
/* -------------------------------------------------------------------------- */

/** 一步：模型要做什么，以及发生了什么。 */
export interface LoopStep {
  step: number;
  /** 模型自述的理由 —— 留着是为了回答"它当时为什么调这个工具"。 */
  thought: string;
  tool: string;
  args: unknown;
  result: unknown;
}

export interface LoopResult {
  /**
   * - `ok`       —— 模型自己调了 `finish`，这是一个**结论**
   * - `degraded` —— 撞上步数上限，**没有结论**，只是停下来了
   * - `failed`   —— 模型输出坏掉且无法恢复
   */
  outcome: 'ok' | 'degraded' | 'failed';
  steps: LoopStep[];
  /** `finish` 的结论（只在 `outcome === 'ok'` 时非空）。 */
  conclusion: string | null;
  /** 给操作员看的一句话：说清为什么停。 */
  detail: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

/* -------------------------------------------------------------------------- */
/*  单轮模型输出的解析                                                         */
/* -------------------------------------------------------------------------- */

interface TurnAction {
  thought: string;
  tool: string;
  args: unknown;
}

/**
 * 抽出一轮的动作。
 *
 * 宽容度与 §2.4 一致：允许围栏、允许前后有解释文字。
 * **但抽不出 `tool` 就是失败** —— 不猜它想干什么。
 */
function parseTurn(text: string): { action: TurnAction | null; error: string | null } {
  /*
   * 先试约定好的 JSON —— 那是提示词里要求的形式。
   */
  const parsed = parseRoleOutput<{ thought?: unknown; tool?: unknown; args?: unknown }>(text);
  if (!parsed.error && parsed.value) {
    const tool = parsed.value.tool;
    if (typeof tool === 'string' && tool.length > 0) {
      return {
        action: {
          thought: typeof parsed.value.thought === 'string' ? parsed.value.thought : '',
          tool,
          args: parsed.value.args ?? {},
        },
        error: null,
      };
    }
  }

  /*
   * JSON 不认，再试模型的**原生工具调用方言**。
   *
   * ⚠️ 这一条是实测逼出来的，不是设想的。Command 厂商的 deepseek-v4.1-flash
   * 会用它训练时的原生格式回来，而那时整个循环会判失败 ——
   * **烧掉 2.5 万 tokens、产出一句"模型没输出可解析的工具调用"**，
   * 看起来像模型不听话，实际是"我们没接住它的话"。
   *
   * 这只是**多认一种格式**，不放宽任何语义：抽出来的工具名与参数照样过
   * `dispatchTool` 那套校验（§2.4 的"加字段别名，不放宽语义校验"）。
   */
  const native = parseNativeToolCalls(text);
  if (native.length > 0) {
    const first = native[0] as { tool: string; args: Record<string, unknown> };
    /*
     * 一次回复里出现多个调用时**只用第一个**。
     *
     * 循环的形状是"一步一个动作、看到结果再决定下一步"；一次塞多个进来
     * 就变成了"模型在看不到结果的情况下连续决策"，而那正是这个设计要避免的。
     * 剩下的会被忽略 —— 如果模型反复这样，它会在 `thought` 与后续轮次里暴露出来。
     */
    return { action: { thought: '', tool: first.tool, args: first.args }, error: null };
  }

  return {
    action: null,
    error: parsed.error ?? `输出里没有 tool 字段（收到 ${JSON.stringify(parsed.value ?? text).slice(0, 120)}）`,
  };
}

/* -------------------------------------------------------------------------- */
/*  循环                                                                       */
/* -------------------------------------------------------------------------- */

export interface LoopInput {
  role: AgentRole;
  /** 这一轮要它做什么（角色自己负责怎么用工具）。 */
  task: string;
  /** 补充事实（绩效快照、市场数据…）。**按角色的 `contextFor` 组装，不是全塞进去。** */
  facts: string;
  deps: AgentToolDeps;
  model: LoopModel;
  /** 步数上限。默认 8。 */
  maxSteps?: number;
  /** 这个标的历史失败（只给风控官）。 */
  priorFailures?: readonly AgentMemoryRow[];
  /**
   * 每执行完一步就回调一次。
   *
   * 存在的理由很具体：`set_params` 会在**循环中途**写一条实验记录，
   * 而那条记录要带上"到目前为止调过哪些工具"。等到循环结束再取就晚了 ——
   * 实测得到的是空数组，于是每一次调参的实验记录里都缺了它的推理依据。
   */
  onStep?: (step: LoopStep) => void;
}

const DEFAULT_MAX_STEPS = 8;
/** 协议说明 —— 拼在系统提示词后面。 */
const PROTOCOL = `
## 你的工作方式

你每一轮只能输出**一个 JSON 对象**，形如：

{"thought":"你这一步为什么这么做","tool":"工具名","args":{...}}

系统会执行这个工具，把结果回给你，然后你再输出下一个。
当你得出最终结论时，调用 finish 工具结束（不要一直调工具来显得在干活）。

可用工具：

${renderToolCatalogue()}
`.trim();

/**
 * 跑一轮工具循环。
 *
 * 循环体本身不做任何业务判断 —— 它只负责"让模型用工具、把结果回喂、在上限处停下
 * 并说清为什么"。业务判断在角色提示词与工具实现里。
 */
export async function runToolLoop(input: LoopInput): Promise<LoopResult> {
  const maxSteps = Math.max(1, input.maxSteps ?? DEFAULT_MAX_STEPS);
  const spec = ROLES[input.role];

  /*
   * 系统提示词 = 角色定义 + 协议 + （仅风控官）这个标的历史失败。
   *
   * 历史失败只给风控官：那是它唯一的"弹药"。给别的角色会让它们把
   * "上次亏过"当成"这次也会亏"，而那是两回事。
   */
  const priorBlock =
    input.priorFailures && input.priorFailures.length > 0
      ? `\n\n## 这个标的历史失败（你判断时的依据）\n${renderPriorFailures(input.priorFailures)}`
      : '';
  const system = `${spec.system}\n\n${PROTOCOL}${priorBlock}`;

  const steps: LoopStep[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let latencyMs = 0;
  /** 对话记录 —— 每轮把"上一次想干什么 + 结果"追加进去，模型据此决定下一步。 */
  let transcript = `## 你的任务\n${input.task}\n\n## 已知事实\n${input.facts}\n\n请开始。`;
  /** 坏输出只宽容一次：给模型一次自我纠正的机会，但不成环。 */
  let badOutputRetries = 0;

  for (let step = 1; step <= maxSteps; step += 1) {
    const started = Date.now();
    const reply = await input.model.complete(system, transcript);
    latencyMs += reply.latencyMs || Date.now() - started;
    tokensIn += reply.usage.promptTokens ?? 0;
    tokensOut += reply.usage.completionTokens ?? 0;

    const { action, error } = parseTurn(reply.text);
    if (!action) {
      if (badOutputRetries >= 1) {
        return {
          outcome: 'failed',
          steps,
          conclusion: null,
          detail: `模型连续两轮没有输出可解析的工具调用：${error}`,
          tokensIn,
          tokensOut,
          latencyMs,
        };
      }
      badOutputRetries += 1;
      transcript += `\n\n## 第 ${step} 轮：你的输出无法解析\n${error}\n请只输出一个 JSON 对象，形如 {"thought":"...","tool":"...","args":{...}}。`;
      continue;
    }

    const outcome = dispatchTool(action.tool, action.args, input.deps);
    const record: LoopStep = {
      step,
      thought: action.thought,
      tool: action.tool,
      args: action.args,
      result: outcome.result,
    };
    steps.push(record);
    // 立刻通知调用方 —— 它可能在下一步就用到（见 `onStep` 的说明）。
    input.onStep?.(record);

    if (outcome.finished) {
      return {
        outcome: 'ok',
        steps,
        conclusion: outcome.finished.summary,
        detail: `模型在第 ${step} 步自行结束。`,
        tokensIn,
        tokensOut,
        latencyMs,
      };
    }

    transcript += `\n\n## 第 ${step} 轮\n你想调用：${action.tool}(${JSON.stringify(action.args)})\n结果：${JSON.stringify(outcome.result)}`;
  }

  /*
   * 撞上步数上限。
   *
   * ⚠️ **这不是成功，也不是失败，而是"没有结论"。** 标记成 `degraded` 是刻意的：
   * 上游必须能区分"模型说完了"和"被我们截断了"——把它们混成同一个 ok，
   * 会让一个截断的半成品被当成完整判断用。
   */
  return {
    outcome: 'degraded',
    steps,
    conclusion: null,
    detail: `达到步数上限（${maxSteps} 步）仍未结束，本轮没有结论。`,
    tokensIn,
    tokensOut,
    latencyMs,
  };
}

/**
 * 一次"单次调用"（不开工具循环）—— 给常规轮次用的廉价档。
 *
 * 用途：大多数周期里没有什么值得深挖的，开完整面板是浪费。
 * 这一档让模型直接给结论，**不允许调工具**；需要查数据时它只能基于 `facts` 判断。
 * 由程序决定用哪一档（见 `intensityFor`），不让模型自己选 —— 否则它永远选最贵的那档。
 */
export async function runSingleShot(input: Omit<LoopInput, 'maxSteps'>): Promise<LoopResult> {
  const spec = ROLES[input.role];
  const system = `${spec.system}\n\n注意：本次你没有工具可用，只能依据下面给出的事实直接给结论。如果事实不足以判断，就明说数据不足。`;
  const started = Date.now();
  const reply = await input.model.complete(system, `## 你的任务\n${input.task}\n\n## 已知事实\n${input.facts}`);

  const parsed = parseRoleOutput<Record<string, unknown>>(reply.text);
  if (parsed.error || !parsed.value) {
    return {
      outcome: 'failed',
      steps: [],
      conclusion: null,
      detail: `单次调用的输出无法解析：${parsed.error}`,
      tokensIn: reply.usage.promptTokens ?? 0,
      tokensOut: reply.usage.completionTokens ?? 0,
      latencyMs: reply.latencyMs || Date.now() - started,
    };
  }

  return {
    outcome: 'ok',
    steps: [],
    conclusion: JSON.stringify(parsed.value),
    detail: '单次调用完成。',
    tokensIn: reply.usage.promptTokens ?? 0,
    tokensOut: reply.usage.completionTokens ?? 0,
    latencyMs: reply.latencyMs || Date.now() - started,
  };
}

/* -------------------------------------------------------------------------- */
/*  强度选择                                                                   */
/* -------------------------------------------------------------------------- */

export type Intensity = 'single' | 'panel';

export interface IntensityInput {
  /** 本小时已经用掉的调用次数。 */
  callsThisHour: number;
  /** 本小时的预算上限。 */
  hourlyBudget: number;
  /** 当前是否有持仓（有仓位时判断更重要）。 */
  hasPosition: boolean;
  /** 距上次调参过了多久（分钟）。 */
  minutesSinceStrategyReview: number;
  /** 权益相对上次大脑决策的变化（百分比绝对值）。 */
  equityDriftPercent: number;
}

/**
 * 由**程序**决定用哪一档。
 *
 * 为什么不让模型自己选：它会为了"更严谨"永远选最贵的那档。而成本是硬约束 ——
 * 完整面板是单次调用的 4–5 倍（实测单次约 5.8 万 tokens）。
 *
 * 预算是**降级**而不是拒绝：超预算时退回单次调用，而不是让这一轮什么都不做。
 * 一个"因为超预算所以今天不决策"的系统，会在最需要它的时候罢工。
 */
export function intensityFor(input: IntensityInput): { intensity: Intensity; why: string } {
  if (input.callsThisHour >= input.hourlyBudget) {
    return { intensity: 'single', why: `本小时已用 ${input.callsThisHour} 次达到预算上限，降级为单次调用。` };
  }
  if (input.hasPosition && input.equityDriftPercent >= 2) {
    return { intensity: 'panel', why: '有持仓且权益相对上次判断变化超过 2%，值得开完整面板。' };
  }
  if (input.minutesSinceStrategyReview >= 60) {
    return { intensity: 'panel', why: '距上次策略审视已超过 60 分钟，需要完整面板。' };
  }
  return { intensity: 'single', why: '常规轮次，单次调用足够。' };
}
