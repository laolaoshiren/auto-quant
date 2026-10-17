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

/** 收一个解析出来的对象；没有可用的 `tool` 就返回 `null`。 */
function toAction(value: { thought?: unknown; tool?: unknown; args?: unknown } | null): TurnAction | null {
  if (!value) return null;
  const tool = value.tool;
  if (typeof tool !== 'string' || tool.length === 0) return null;
  return {
    thought: typeof value.thought === 'string' ? value.thought : '',
    tool,
    args: value.args ?? {},
  };
}

/**
 * 切出**第一个括号配平的对象字面量**，没有就返回 `null`。
 *
 * 逐字符扫描，同时跟踪三件事：括号深度、是否在字符串里、字符串里刚才是转义符。
 * 三者缺一不可 —— 只看深度会被字符串里的 `{`/`}` 骗到（`args` 里带一段 JSON
 * 文本是很正常的事）。与 `strategy/parser.ts` 用的是同一种手法。
 */
export function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

/**
 * 抽出一轮的动作。
 *
 * 宽容度与 §2.4 一致：允许围栏、允许前后有解释文字。
 * **但抽不出 `tool` 就是失败** —— 不猜它想干什么。
 */
export function parseTurn(text: string): { action: TurnAction | null; error: string | null } {
  type Shape = { thought?: unknown; tool?: unknown; args?: unknown };

  /*
   * 先试约定好的 JSON —— 那是提示词里要求的形式。
   */
  const parsed = parseRoleOutput<Shape>(text);
  const direct = toAction(parsed.value);
  if (direct) return { action: direct, error: null };

  /*
   * 再试：模型一次吐了**多个**对象，只取第一个。
   *
   * ## 这是实测出来的，且代价很大
   *
   * `parseRoleOutput` 抽的是"一个角色的结论"，所以它对多对象**必须失败**
   * （取哪一个有歧义，猜错就是把结论搞混）。但工具循环的语义不同：这里的协议是
   * "一轮一个 JSON：选一个工具、看结果、再决定下一步"，模型多吐一个只是**多写了一个**，
   * 第一个仍然是它此刻想做的事。
   *
   * 实测 `agent_runs` 里 **37 次 `failed` 全是这个形状**（占全部运行的 31%，
   * 每次烧 2–6 万 tokens 却零结论）。原文：
   *
   *     {"thought":"先看绩效与权益曲线…","tool":"get_performance","args":{"window":"7d"}}
   *     {"thought":"同时看最近的决策与拒绝记录…
   *
   * 而当时报出来的错是"无法从回复里解析出 JSON 对象"—— 读起来像模型根本没输出 JSON，
   * **实际是它输出了两个**，于是排查方向从一开始就偏了。
   *
   * 与下面那个原生方言分支同一条规则：**多个调用只用第一个**，因为让模型在看不到
   * 结果的情况下连续决策，正是这个循环要避免的事。
   */
  const firstObject = firstBalancedObject(text);
  if (firstObject !== null) {
    const firstParsed = parseRoleOutput<Shape>(firstObject).value;
    const single = toAction(firstParsed);
    if (single) return { action: single, error: null };
    /*
     * ⚠️⚠️ **这里必须报"没有 tool 字段"，不能沿用 `parsed.error`**（2026-10-15 修）
     *
     * ## 事故：错误信息在说谎，于是模型无法自我纠正
     *
     * 实测失败原文（`agent_runs` #820，`strategy/single`，烧掉 2–6 万 tokens 零产出）：
     * ```
     *   模型连续两轮没有输出可解析的工具调用：
     *     无法从回复里解析出 JSON 对象（前 120 字符：
     *     {"thought":"综合分析：1) 24h 30笔交易,胜率30%,SL均亏-3.98%,TP均赚+8.73%,
     *      净PnL≈-0.048——数学上接近盈亏平衡,6连亏在70%失败率下概率11.8%,属统计噪声…"）
     * ```
     *
     * ## 真实形状（复刻出来的，不是推测）
     *
     * 那个形状是「**多个对象、且第一个没有 `tool`**」：
     * ```
     *   parseRoleOutput(整段)  → value=null（多对象对它是歧义，必须失败）
     *                            error="无法从回复里解析出 JSON 对象…"   ← 【就是这句在说谎】
     *   firstBalancedObject()  → 取到第一个对象，但它【没有 tool 字段】
     *   ⇒ 走到这里时，`parsed.error` 是"解析失败"，而真相是"JSON 好得很、只是没说要调什么"
     * ```
     *
     * ## 为什么这比"报错不准确"严重得多
     *
     * ```
     *   ① 给模型的纠正提示是错的
     *      → 它读到"无法解析 JSON"，于是去**重新整理格式**（格式本来就没问题）
     *      → 下一轮给出同样的形状 → 连续两轮 → failed
     *   ② 给操作员的日志是错的
     *      → "无法解析 JSON" 让人去查解析器 / 编码 / 转义
     *      → 而真相是提示词里的协议（每轮必须带 tool）没被遵守
     * ```
     * 这个仓库反复记过同一类教训：**一个说错话的错误信息比没有信息更糟。**
     *
     * ## 修法
     *
     * 走到这里说明"对象取到了、JSON 也解析了，就是缺 tool" ⇒ 报这个事实。
     * 只有**连对象都取不到**（`firstObject === null`）才用 `parsed.error`。
     */
    return {
      action: null,
      error:
        'JSON 解析成功，但里面**没有 tool 字段** —— 你只写了 thought、没说要调哪个工具。' +
        '每一轮都必须带 tool；要给结论就调用 finish。' +
        `收到：${JSON.stringify(firstParsed ?? firstObject).slice(0, 200)}`,
    };
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

    const outcome = await dispatchTool(action.tool, action.args, input.deps);
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
 * **"这次调用来自 agent 层、不是交易决策"的标记**（2026-10-15 修）。
 *
 * ## 为什么需要它（一次真实事故）
 *
 * `ai_team` 的团队模型挂在机器人的**模型出口**上（`manager.ts` 的
 * `DecisionModel.complete`），所以**任何**调用都会进来 —— 包括 agent 层的
 * 工具循环与单次调用。而 `routedModel.complete()` 靠一段**文本特征**
 * 区分"这是不是交易决策"，不是就转给单模型。
 *
 * 那个特征原来只存在于 `runToolLoop` 的 `PROTOCOL` 里：
 * ```
 *   TOOL_LOOP_MARKER = '你每一轮只能输出**一个 JSON 对象**'
 * ```
 * 而 **`runSingleShot` 不拼 `PROTOCOL`**（它是"不开工具循环"的档），
 * 于是它的调用**被判成交易决策** → 跑整个交易台。
 *
 * ## 实测后果（`agent_runs`）
 *
 * ```
 *   #833 ai_team strategy panel failed 29,058ms  tokens_in=0
 *        detail：无法从回复里解析出 JSON 对象（前 120 字符：<decision>
 *                [{"symbol":"BTCUSDT","action":"skip"…
 *   #834 同上 32,935ms
 * ```
 * 也就是说：`performance_analyst` / `attribution_analyst` **每次只想要一个结论，
 * 却触发了完整的 8 角色会议**（分析师→多空对抗→裁决），拿回 `<decision>` 文本
 * 必然解析失败 —— **这两个岗位从接线那天起就没成功过一次**。
 *
 * 而对照 `#830`/`#831`（`ai_managed`，不走团队模型）：同一份代码 `ok`、有 token。
 *
 * ## 修法：两条路径都带上标记
 *
 * ```
 *   runToolLoop   → 已含 PROTOCOL（保持原样）
 *   runSingleShot → 显式拼上这个标记
 * ```
 * ⚠️ 标记**必须只在 agent 层出现** —— 交易循环给的那份 system 里没有它，
 * 所以"是不是交易决策"这个判据不会误伤（`toolLoopRouting.test.ts` 钉住这一点）。
 */
export const AGENT_CALL_MARKER =
  '本次调用来自交易系统的 agent 层（工具循环或单次结论），不是交易决策会议。';

/**
 * **解析失败时追加到 user 消息末尾的重试指令**（t69）。
 *
 * ## 为什么需要它（线上实测 31%–36% 的失败都死在这一条）
 *
 * `runSingleShot` 原来在解析失败时**直接返回 failed**，没有任何挽回动作：
 * ```
 *   agent_runs: strategy|ok|7   strategy|failed|4    ⇒ 36%
 *   失败 detail 全是同一个形状：
 *     单次调用的输出无法解析：无法从回复里解析出 JSON 对象（前 120 字符：{...}）
 * ```
 * 而 `loop.ts:170` 的历史注释已经写过同一件事（**37 次 failed 全是这个形状，占 31%**）——
 * 当时只修了"错误信息在说谎"，**没修"失败后不重试"**。
 *
 * ## 为什么重试能救回来（而不是白烧一次 token）
 *
 * 失败的真实形状是「**模型一次吐了多个对象**」或「JSON 后跟了含 `}` 的文字」。
 * 这两者都不是"模型不会答"，而是"**它多写了一段**" —— 明确要求之后，
 * 它收敛到单个对象的概率很高。而代价只是多一次调用。
 *
 * ## ⚠️ 措辞里每一句都在防一种实测形状
 *
 * ```
 *   只输出一个 JSON 对象        ← 防「多对象」（线上主形状）
 *   不要重复输出                ← 防「同一个对象写两遍」
 *   不要在 JSON 前后加任何文字   ← 防「JSON 后跟含 } 的说明」（切片会拼出非法 JSON）
 * ```
 *
 * ⚠️ **这不改变解析层的严格性**：`parseRoleOutput` 对多对象仍然**必须失败**
 * （`roles.ts:751-753`：取错对象会把一个角色的结论当成另一个角色的）。
 * 重试只是**给模型一次改口的机会**，判据一点没松。
 */
const SINGLE_SHOT_RETRY_INSTRUCTION =
  '\n\n## ⚠️ 上一次回复无法解析（可能有多个 JSON 对象，或 JSON 前后带了文字）\n' +
  '请**只输出一个 JSON 对象**，不要重复输出、不要在 JSON 前后加任何文字。';

/**
 * 一次"单次调用"（不开工具循环）—— 给常规轮次用的廉价档。
 *
 * 用途：大多数周期里没有什么值得深挖的，开完整面板是浪费。
 * 这一档让模型直接给结论，**不允许调工具**；需要查数据时它只能基于 `facts` 判断。
 * 由程序决定用哪一档（见 `intensityFor`），不让模型自己选 —— 否则它永远选最贵的那档。
 *
 * ## 解析失败会**重试恰好一次**（t69，修线上 36% 失败）
 *
 * 见 `SINGLE_SHOT_RETRY_INSTRUCTION` 的说明。三条纪律：
 * ```
 *   ① 只重试一次 —— 重试无限次会把一次失败放大成 N 次 token 消耗；
 *   ② 重试仍失败时 detail 必须说清"已重试" —— 否则操作员会以为第一次就死了；
 *   ③ token 计数与 latencyMs **包含重试那一次**（它确实花了钱/时间）。
 * ```
 */
export async function runSingleShot(input: Omit<LoopInput, 'maxSteps'>): Promise<LoopResult> {
  const spec = ROLES[input.role];
  const system =
    `${spec.system}\n\n注意：本次你没有工具可用，只能依据下面给出的事实直接给结论。` +
    `如果事实不足以判断，就明说数据不足。\n\n${AGENT_CALL_MARKER}`;
  const started = Date.now();

  /** user 消息。⚠️ 第一次与重试的**唯一区别**是末尾那段指令。 */
  const baseUser = `## 你的任务\n${input.task}\n\n## 已知事实\n${input.facts}`;
  const MAX_ATTEMPTS = 2; /* 原始 + 重试 1 次 —— 上限写死在这里，不参数化（见上面第 ① 条）。 */

  let tokensIn = 0;
  let tokensOut = 0;
  let latency = 0;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const user = attempt === 1 ? baseUser : `${baseUser}${SINGLE_SHOT_RETRY_INSTRUCTION}`;
    const reply = await input.model.complete(system, user);
    tokensIn += reply.usage.promptTokens ?? 0;
    tokensOut += reply.usage.completionTokens ?? 0;
    latency += reply.latencyMs || 0;

    const parsed = parseRoleOutput<Record<string, unknown>>(reply.text);
    if (!parsed.error && parsed.value) {
      return {
        outcome: 'ok',
        steps: [],
        conclusion: JSON.stringify(parsed.value),
        /*
         * ⚠️ 第一次就成功时 detail **逐字节不变**（"单次调用完成。"）——
         * 上游有测试与界面在读它，不能因为"加了重试"就让成功路径的话变了。
         */
        detail: '单次调用完成。',
        tokensIn,
        tokensOut,
        latencyMs: latency || Date.now() - started,
      };
    }
    lastError = parsed.error ?? '（无错误信息）';
  }

  /*
   * 走到这里 = 两次都解析失败。
   *
   * ⚠️ **detail 必须写明"已重试"**：不然操作员看到"单次调用的输出无法解析"
   * 会以为第一次就失败了、去查模型/网关 —— 而真相是我们已经让它重写过一遍。
   */
  return {
    outcome: 'failed',
    steps: [],
    conclusion: null,
    detail: `单次调用的输出无法解析（已重试 ${MAX_ATTEMPTS - 1} 次仍失败）：${lastError}`,
    tokensIn,
    tokensOut,
    latencyMs: latency || Date.now() - started,
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
