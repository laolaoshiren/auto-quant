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
/*
 * **输入侧预算**（t82）—— 复用策略层那一套 token 换算与 6 万上限。
 *
 * ⚠️ 为什么用 `estimateTokens` 而不是自己写一个除法：那个函数的注释里记着一次实测
 * （207,328 字符 → 128,073 tokens，约 **1.62 字符/token**，不是英文散文的 4）。
 * 自己估一个"4 字符/token"会让真值**低估一倍以上** —— 这个仓库正是这样让一个
 * 12.8 万 token 的请求溜过了一道"以为只有 6 万"的检查。
 */
import { estimateTokens, PROMPT_TOKEN_BUDGET } from '../../strategy/prompt.js';

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
  /**
   * **有没有工具结果因为输入预算被省略**（t82）。
   *
   * 它回答的是"这一轮的账目里，有没有东西被我省掉了" ——
   * 省略本身是**必须的**（见 `packContext`），但**省略得看不见**才是本仓库反复吃亏的形态。
   * `false` = 一个字节都没省（此时行为与改动前逐字节一致）。
   */
  contextTrimmed: boolean;
}

/* -------------------------------------------------------------------------- */
/*  输入侧预算（t82）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * **会走工具循环的那批角色**在提示词里最多能看到的输入（token）。
 *
 * ## 为什么需要它（线上实测的失败形状）
 *
 * `agent_runs` + `runtime_logs` 取样（2026-10-17）：**18 条 `finish_reason=length`
 * 而正文为空**，其中 7 条在最新部署之后仍在发生。成因不是模型不会答，而是：
 * ```
 *   输出预算（`TEAM_BASE_MAX_TOKENS = 8192`）与【思维链】共享
 *   而输入侧【没有预算】—— 工具循环的 transcript 每步追加一份完整工具结果
 *   实测单结果 40,000 字符 × 最多 8 步 ⇒ 最坏约 32 万字符 ≈ 19 万 token
 *   ⇒ 模型把 8192 全花在"想"上 ⇒ 正文为空 ⇒ 两轮都空 ⇒ failed，零结论
 * ```
 * ⚠️ **绝不能靠调 `TEAM_BASE_MAX_TOKENS` 来修**：那个数就是被思维链吃掉的，
 * 调它只会让思维链吃更多。要修的是**喂进去的东西**。
 *
 * ## 为什么取 `PROMPT_TOKEN_BUDGET`（6 万）而不是另定一个数
 *
 * 同一个仓库里，**策略层**已经为同一件事定过这个数，而且理由是实测的
 * （`strategy/prompt.ts:3683-3685`）：
 * ```
 *   "The failure this constant exists to prevent was a prompt at 128k tokens:
 *    the model consumed its entire output budget reasoning about the input
 *    and returned nothing. 60k is less than half of that."
 * ```
 * **同一个失败形状，同一个数** —— 不再造第二个口径（本仓库为"同一件事两处各算一遍"
 * 已经付过多次代价）。
 *
 * ⚠️ 与模型自己的上下文上限（≥128k）的关系：6 万是**不到一半**，
 * 留出的那部分正是模型"想 + 答"的地方 —— 那两件事共享的预算越小越容易被烧光。
 */
const TOOL_LOOP_INPUT_BUDGET_TOKENS = PROMPT_TOKEN_BUDGET;

/**
 * **最近几个工具结果必须原样保留**（不裁、不省）。
 *
 * 理由是工具循环的语义：模型**下一步要基于刚才那个结果**做判断。
 * 只保留"最近一次"就够它走一步，但不够它做**交叉核对**
 *（例如拿 `get_performance` 与 `get_lessons` 对读 —— 那正是策略师提示词要求它做的事）。
 *
 * 3 这个数：一次工具循环里"当前正在用的结论链"通常不超过 3 环，
 * 再往前的结果已经**体现在后续步骤的 thought 里**（模型自己引用过它）。
 */
export const TOOL_LOOP_KEEP_RECENT_RESULTS = 3;

/** 被省略的工具结果在提示词里留下的**一行说明**（让模型知道"这里少了东西"）。 */
export interface OmittedToolResult {
  step: number;
  tool: string;
  /** 原始字符数（如实报，不压低）。 */
  chars: number;
}

/** `packContext` 的产出：提示词 + 它到底省了什么。 */
export interface PackedContext {
  transcript: string;
  /** 被**整条省略**的结果（按被省掉的顺序）。 */
  dropped: OmittedToolResult[];
  /** 被**截断**的结果（整条省略还不够时才会发生）。 */
  truncated: OmittedToolResult[];
  /** 固定段（任务 + 事实）自己就已经超预算 —— 那种情况必须让人看见。 */
  prefixOverBudget: boolean;
}

/** 固定段（任务 + 已知事实）：**任何情况下都不裁** —— 它是这一轮的全部输入。 */
function fixedPrefix(task: string, facts: string): string {
  return `## 你的任务\n${task}\n\n## 已知事实\n${facts}`;
}

/** 把一步渲染成提示词里的一段（与被省略时留下的那行共用同一套字段）。 */
function renderStep(step: LoopStep): string {
  return (
    `\n\n## 第 ${step.step} 轮\n你想调用：${step.tool}(${JSON.stringify(step.args)})` +
    `\n结果：${JSON.stringify(step.result)}`
  );
}

/**
 * **系统提示词要留出的余量**（token）。
 *
 * ## 为什么预算不能全给 transcript
 *
 * 真正发出去的是 `system + transcript` 两段，而 `system` 也要占 token：
 * ```
 *   角色提示词（strategist 那份约 5 千字符）+ PROTOCOL（协议说明）+ 历史失败块
 * ```
 * 若把 6 万全给 transcript，则**实际输入 = 6 万 + system** —— 预算就不是预算了。
 * 实测（`.dsh/t82-measure.ts`）第一版就是这样：transcript 压到 6 万，
 * 而 stub 看到的输入是 **60,202 tokens**，刚刚越过阈值 —— **差一点点，等于没修**。
 *
 * ## 为什么是 8 千而不是"量一下 system 有多大"
 *
 * 量它是可行的（`estimateTokens(system)`），但那样预算会随角色的提示词长度浮动 ——
 * 而"这一轮最多能喂多少"应当是**稳定**的。固定留 8 千（远大于实测最长的那份
 * 角色提示词）既够用又好解释。
 */
const SYSTEM_PROMPT_RESERVE_TOKENS = 8_000;

/**
 * **把工具循环的对话记录压进输入预算**（纯函数，t82）。
 *
 * ## 策略（每一档都有取舍，按"先省最不要紧的"排序）
 *
 * ```
 *   ① 任务 + 已知事实        —— 永不裁。裁了就不是同一个任务了。
 *   ② 最近 3 个工具结果      —— 永不裁。模型下一步要基于它判断（见常量说明）。
 *   ③ 更早的结果：整条换一行说明（省最多，信息损失最小 —— 模型早就引用过它）
 *   ④ 还不够？逐个截断（连最近 3 个也会被截）—— 最后一道，必须有，
 *      否则一个 20 万字符的结果仍能把预算撑破（线上 `list_candidates` 就是这一类）
 * ```
 *
 * ## ⚠️ 为什么不能"直接 slice 字符串"
 *
 * 切在 JSON 中间会让模型看到**半截结果**，而它没有"这是半截"的线索 ——
 * 会基于残缺数据下结论。这与 `tradingDesk` 的 `headOfMarket` 记过的是同一个教训：
 * **材料要按"谁需要什么"给，切的时候必须把"切了"这件事说清楚**。
 *
 * ## ⚠️ 判据是**估算**，不是真的 token 计数
 *
 * 所以它是**保守**的：`estimateTokens` 按实测的 1.62 字符/token 换算，
 * 留出余量给"模型数 token 的方式与我们不同"这件事。
 *
 * @param budgetTokens 这段**记录**能用的预算（默认已经是"总预算 − system 余量"）
 */
export function packContext(
  task: string,
  facts: string,
  steps: readonly LoopStep[],
  budgetTokens: number = TOOL_LOOP_INPUT_BUDGET_TOKENS - SYSTEM_PROMPT_RESERVE_TOKENS,
): PackedContext {
  const prefix = `${fixedPrefix(task, facts)}\n\n请开始。`;
  const dropped: OmittedToolResult[] = [];
  const truncated: OmittedToolResult[] = [];
  /*
   * 固定段自己就超预算：**照样原样发出**（裁它等于换一个任务），
   * 但把这件事报出去 —— 上游要知道"这一轮的输入预算本来就是破的"。
   */
  if (estimateTokens(prefix) >= budgetTokens) {
    return {
      transcript: prefix + steps.map(renderStep).join(''),
      dropped,
      truncated,
      prefixOverBudget: true,
    };
  }

  const recentFrom = Math.max(0, steps.length - TOOL_LOOP_KEEP_RECENT_RESULTS);
  const older = steps.slice(0, recentFrom);
  const recent = steps.slice(recentFrom);

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **分配口径**（t82 的第五版；前四版都栽在"谁先拿额度"上）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 四版实测（`.dsh/t82-debug-pack.ts`）踩到的都是同一件事：
   * ```
   *   ① 先塞满老结果             → 最新的两条被截到 0 字符（最要紧的证据死了）
   *   ② 按"预算 / 4"预留        → 老结果吃不满、结余还不回尾部 ⇒ 最新那条仍被截断
   *   ③ 从最新往回平均分配       → 放不下的被误记进 dropped ⇒ "取舍从最老开始"的判据失效
   *   ④ 只给"最新那条"留额度     → 老证据整条整条活着，而最近那几条被压成几十字符
   *                              （**恰好反了**：第 1、2 步完整，第 3–5 步只剩零头）
   * ```
   * 现在只有**一条**口径，按"谁更可能被下一步用到"排序：
   * ```
   *   ① 最近那 3 条整条进（它们是要用的证据）—— 装不下就截断其中最老的一条，退让重算
   *   ② 更老的那些只用剩下的额度，且**整条放不下就整条省略**（不切）
   *   ③ 最后再兜一次：若连"最近那几条"都装不下，截断其中**最老**的一条并重试
   * ```
   * ⚠️ "整条放不下就整条省略"（只针对更老的那些）是刻意的：切一半的 JSON 会让模型
   * **基于残缺数据下结论**，那比"明确告诉你这一条没装进来"更糟
   *（`tradingDesk` 的 `headOfMarket` 记过同一个教训）。
   */
  const KEEP_RECENT = TOOL_LOOP_KEEP_RECENT_RESULTS;
  const newestNote = (chars: number, keptChars: number): string =>
    `\n…（**结果被截断**：这一条原始 ${chars} 字符，为装进输入预算只保留了前 ${keptChars} 字符）` +
    '\n⚠️ 上面是不完整的结果 —— 缺的部分不要猜；需要就再调一次工具（可以缩小参数，例如更短的时间窗）。';

  let keepRecent = Math.min(KEEP_RECENT, recent.length);
  let keptOlder: string[] = [];
  let head = prefix;
  let dropNote = '';
  let tail = '';

  for (;;) {
    const recentKept = recent.slice(recent.length - keepRecent);
    const olderAll = steps.slice(0, steps.length - keepRecent);

    /* ① 最近那几条整条进（截断与占位只在兜底里发生）。 */
    const recentTexts = recentKept.map(renderStep);
    const reserved = recentTexts.reduce((sum, t) => sum + estimateTokens(t), 0);
    const capForOlder = Math.max(estimateTokens(prefix), budgetTokens - reserved);

    /* ② 更老的那些：整条放不下就整条省略。 */
    const droppedHere: OmittedToolResult[] = [];
    keptOlder = [];
    for (const step of olderAll) {
      const text = renderStep(step);
      if (estimateTokens(prefix + keptOlder.join('') + text) > capForOlder) {
        droppedHere.push({ step: step.step, tool: step.tool, chars: text.length });
        continue;
      }
      keptOlder.push(text);
    }
    dropNote =
      droppedHere.length === 0
        ? ''
        : `\n\n## ⚠️ 有 ${droppedHere.length} 条更早的工具结果因【输入预算】被省略\n` +
          droppedHere.map((d) => `- 第 ${d.step} 步 ${d.tool}：结果约 ${d.chars} 字符，已省略。`).join('\n') +
          '\n⚠️ 缺的部分不要猜；需要就再调一次工具（可以缩小参数，例如更短的时间窗）。';
    /* ⚠️ 说明本身可能把头部顶出 `capForOlder` —— 从末尾往回丢，直到装得下。 */
    while (keptOlder.length > 0 && estimateTokens(prefix + keptOlder.join('') + dropNote) > capForOlder) {
      keptOlder.pop();
    }
    head = prefix + keptOlder.join('') + dropNote;
    dropped.length = 0;
    dropped.push(...droppedHere);

    /* ③ 最近那几条真的装得下吗？装不下就**截断其中最老的一条**再算一次。 */
    const tailCost = estimateTokens(recentKept.map(renderStep).join(''));
    if (estimateTokens(head) + tailCost <= budgetTokens || keepRecent <= 1) {
      tail = recentKept.map(renderStep).join('');
      break;
    }
    keepRecent -= 1;
  }

  /*
   * 兜底：`keepRecent === 1` 时仍装不下 → 只保留"最新那条"允许被截断。
   * 它是模型下一步唯一要用的证据，给一半（并明说被截断、不要猜）好过什么都不给。
   */
  if (estimateTokens(head + tail) > budgetTokens && recent.length > 0) {
    const last = recent[recent.length - 1]!;
    const lastText = renderStep(last);
    const room = budgetTokens - estimateTokens(head);
    let cut = Math.min(lastText.length, Math.max(0, Math.floor(room * 1.7)));
    let chosen: string | null = null;
    while (cut > 0) {
      const withNote = lastText.slice(0, cut) + newestNote(lastText.length, cut);
      if (estimateTokens(withNote) <= room) {
        chosen = withNote;
        break;
      }
      cut = Math.floor(cut * 0.9);
    }
    truncated.push({ step: last.step, tool: last.tool, chars: lastText.length });
    tail = chosen ?? '';
  }

  /*
   * ── 最后一道：**硬保证** ──────────────────────────────────────────────
   *
   * 上面每一档都是"保守估算 + 收紧"，但估算与真实之间总有取整误差（实测差 36 tokens）。
   * 而这条预算存在的理由就是"不许越界"，所以最后无条件收一次。
   */
  if (estimateTokens(head + tail) > budgetTokens) {
    const note = '\n…（本段因输入预算被截断）';
    let cut = tail.length;
    while (cut > 0 && estimateTokens(head + tail.slice(0, cut) + note) > budgetTokens) {
      cut = Math.floor(cut * 0.95);
    }
    tail = tail.slice(0, cut) + note;
    truncated.push({ step: 0, tool: '（输入预算硬截断）', chars: cut });
  }

  return {
    transcript: head + tail,
    dropped,
    truncated,
    prefixOverBudget: false,
  };
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
 * **交易决策 / 交易台格式的标签**（t72）。
 *
 * `runToolLoop` 与 `runSingleShot` 的契约是
 * `{"thought":…,"tool":…,"args":{…}}`（见本文件头部）。
 * 而下面这些标签属于**另外两套契约**：
 * ```
 *   <reasoning> + <decision>   ← 交易循环的决策格式（strategy/prompt.ts）
 *   <decision> + <risk> + <team>  ← 交易台的渲染输出（agent/deskOutput.ts）
 * ```
 * ⚠️ 判据**只在"已经确定拿不到 action"之后**才用（见 `parseTurn` 的调用点）：
 * 一个**合法的**工具调用里完全可能**在字符串里**带上这些标签
 * （策略师可以改 `promptSections` / `customPrompt`，那里面就可能写着 `<decision>`）。
 * 先让"能解析成工具调用"的分支走完，再来判断"这是不是另一个格式"。
 */
const TRADING_FORMAT_TAGS = /<(?:reasoning|decision|risk|team)>/i;

/**
 * 「这次回复属于**另一个契约**」的说明（t72）。
 *
 * ## 为什么必须单独说这一句（线上 15 条 + 历史 17 条的真形状）
 *
 * 线上失败 detail 的原文：
 * ```
 *   模型连续两轮没有输出可解析的工具调用：无法从回复里解析出 JSON 对象
 *   （前 120 字符：<decision>
 *   []
 *   </decision>
 *
 *   <risk>
 *   ⚠️ 本轮**未经风…
 * ```
 * **"无法从回复里解析出 JSON 对象"这句话在这里是错的** —— 那段文本根本不是
 * 模型想输出的 JSON：`<decision>` 与 `<risk>` 是**渲染层产出的**
 * （`deskOutput.ts` 里那句 `⚠️ 本轮**未经风控官审阅**（原因未记录）` 是**字面量**），
 * 也就是说**这次 agent 层调用被交易台接走了**，模型没有参与格式选择。
 *
 * 本仓库为这种错误付过代价（本文件 :188-226 记的就是"错误信息在说谎"）：
 * **一个说错话的错误信息比没有信息更糟** —— 它会让人去查解析器/编码，
 * 而真相是"调用被别的路径回答了"。
 *
 * ⚠️ **这条只改"怎么说"，不改"怎么判"**：`action` 仍然是 `null`、
 * 仍然只宽容两轮、仍然判 `failed`。把交易台的输出当成策略师的结论收下，
 * 才是真正的错（那会把一个角色的结论记到另一个角色名下）。
 */
function crossContractHint(text: string): string {
  return (
    '⚠️ 这次回复用的是**另一个契约的格式**（含 `<reasoning>`/`<decision>`/`<risk>`/`<team>` 标签）。\n' +
    '    工具循环只认 `{"thought":…,"tool":…,"args":{…}}`；**要给结论就调用 finish**。\n' +
    '    而 `<decision>` 与 `<risk>` 是**渲染层产出**的（不是模型写的）⇒ ' +
    '**这通常意味着这次调用被交易台接走了**（走的是团队决策那条路，不是 agent 层的工具循环）。\n' +
    `    收到：${text.trim().slice(0, 120)}`
  );
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
        (TRADING_FORMAT_TAGS.test(text) ? `\n    ${crossContractHint(text)}` : '') +
        `\n    收到：${JSON.stringify(firstParsed ?? firstObject).slice(0, 200)}`,
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

  /*
   * ⚠️ **最后一道判断：这是不是"另一个契约"的回复**（t72）。
   *
   * 走到这里 = 没有任何一条路径能抽出一个动作。此时若文本里出现交易决策/交易台的标签，
   * 那么"无法从回复里解析出 JSON 对象"这句话就是**错的** —— 真相是
   * "这次调用被交易台接走了"（线上 15 条的实测形状，见 `crossContractHint`）。
   *
   * ⚠️ 判据放在**最后**：合法的工具调用在上面两个分支已经返回了，
   * 而它们的字符串里完全可能带 `<decision>`（策略师能改提示词）。
   */
  if (TRADING_FORMAT_TAGS.test(text)) {
    return { action: null, error: crossContractHint(text) };
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

## ⚠️ 本轮不需要工具时，也必须用 finish 收尾（t72）

**"不需要再调工具"不等于"可以换一种格式回答"** —— 工具循环只认上面那一个形状。
如果你想说的已经是结论了，就**调用 finish** 把它放进 args.summary 字段：

{"thought":"信息够了，给出结论","tool":"finish","args":{"summary":"你的结论"}}

**不要**用下面这些方式代替 finish（它们都不是工具调用，会被判失败）：
· 直接写一段散文/总结（只有 thought、没有 tool）；
· **单独输出工具参数**（只有参数、没有 \`thought\`/\`tool\` 外壳的对象）——
  那些参数**不是一次调用**，系统不会执行它们（t81：线上 15 条失败就是这个形状）；
· 用**别的模式的格式**回答 —— 例如交易循环的 \`<reasoning>\` + \`<decision>\` 块，
  或交易台的 \`<decision>\` + \`<risk>\` + \`<team>\` 块。

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
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **对话记录必须每轮按输入预算重打包**（t82）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 原来它是**只增不减**的一个字符串：
   * ```
   *   let transcript = `## 你的任务…`;
   *   …
   *   transcript += `\n\n## 第 N 轮\n…\n结果：${JSON.stringify(outcome.result)}`;
   * ```
   * 而工具结果**可以很大**（线上实测单结果 40,000 字符，`list_candidates` 更大），
   * 步数上限是 8 —— 最坏就是把约 32 万字符（≈19 万 token）喂给一次调用。
   *
   * 后果实测两种，都会让这一轮**白跑**：
   * ```
   *   ① 超出模型上下文 ⇒ 请求直接被拒 / 被裁（那是坏的，因为裁剪发生在网关侧，我们看不见）
   *   ② 没超上下文，但输出预算（8192，与思维链共享）被"读大材料"吃光 ⇒ 正文为空
   *      ⇒ agent_runs 里 18 条 finish_reason=length、content 为空的形状
   * ```
   *
   * 所以每次调用前用 `packContext()` 重打包：**最近的工具结果保原样，更老的换成一行说明**，
   * 总量压在 `TOOL_LOOP_INPUT_BUDGET_TOKENS` 以内。取舍与理由写在那个函数上。
   *
   * ⚠️ `dropped` / `truncated` **必须累积着传进下一次打包**：省略本身要**可见**，
   * 否则模型会以为"那些步骤不存在"，而操作员也不知道这一轮的账目被省过。
   */
  let dropped: OmittedToolResult[] = [];
  let truncated: OmittedToolResult[] = [];
  let packed = packContext(input.task, input.facts, steps);
  let transcript = packed.transcript;
  /** 把 `packContext` 的结果接过来（含它累积的省略清单）。 */
  const repack = (): void => {
    packed = packContext(input.task, input.facts, steps);
    /*
     * ⚠️ 只**累积已省略过的**，不把"这次新省略的"丢掉：
     * `packContext` 每次都从完整 steps 重算，所以它返回的清单已经包含全部历史省略。
     */
    dropped = packed.dropped;
    truncated = packed.truncated;
    transcript = packed.transcript;
  };
  /** 这一轮到底省没省东西（给调用方看）。 */
  const contextTrimmed = (): boolean => dropped.length > 0 || truncated.length > 0;
  /** 省略情况的**一句话**（附在返回的 `detail` 上，让操作员不必去翻日志）。 */
  const trimNote = (): string => {
    if (!contextTrimmed()) return '';
    const parts: string[] = [];
    if (dropped.length > 0) parts.push(`省略 ${dropped.length} 条旧工具结果`);
    if (truncated.length > 0) parts.push(`截断 ${truncated.length} 条结果`);
    return `（输入预算：${parts.join('、')}；最近的 ${TOOL_LOOP_KEEP_RECENT_RESULTS} 条保持原样）`;
  };
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
          detail: `模型连续两轮没有输出可解析的工具调用：${error}${trimNote()}`,
          tokensIn,
          tokensOut,
          latencyMs,
          contextTrimmed: contextTrimmed(),
        };
      }
      badOutputRetries += 1;
      /*
       * ⚠️⚠️ **纠正指令必须与真实病因匹配**（t81）。
       *
       * ## 事故：指令只说"只输出一个对象"，而线上那条回复**本来就是一个对象**
       *
       * `agent_runs` 15 条的 detail 原文：
       * ```
       *   模型连续两轮没有输出可解析的工具调用：JSON 解析成功，
       *   但里面**没有 tool 字段** … 收到：{"limit":20}
       * ```
       * `{"limit":20}` 是工具的**参数**，缺的是 `thought`/`tool` 外壳。
       * 而原来那段纠正只说"请只输出一个 JSON 对象…" —— 模型读到的是"你写多了"，
       * 于是**同一个形状再来一遍** ⇒ 两轮都坏 ⇒ `failed`。
       *
       * `parseTurn` 已经把两类病因分开了（"缺 tool 字段" vs "根本解析不出 JSON"），
       * 这里就按它给的那一类**分别**说 —— 指令里的每一句都要对应一种真实形状。
       *
       * ⚠️ 新句子**不给可照抄的 JSON 例子**：few-shot 会让模型把示例当模板，
       * 而这里要它做的是"补上外壳"，不是"照抄一个例子"。
       */
      const missingTool = (error ?? '').includes('没有 tool 字段');
      transcript +=
        `\n\n## 第 ${step} 轮：${missingTool ? '你的输出不是一次工具调用' : '你的输出无法解析'}\n${error}\n` +
        (missingTool
          ? '⚠️ 你的 JSON 本身**是合法的**，缺的只是 `tool` 字段 —— ' +
            '**单独输出工具参数**（只有参数、没有 `thought`/`tool` 外壳的对象）**不算一次调用**，' +
            '系统不会执行它。\n'
          : '') +
        '请只输出一个 JSON 对象，形如 {"thought":"...","tool":"...","args":{...}}。\n' +
        '⚠️ **如果你已经可以给结论，就用 finish 收尾**（`{"thought":"...","tool":"finish","args":{"summary":"..."}}`）——' +
        '不要用散文或别的模式的格式（如 `<decision>` 块）代替工具调用。';
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
        detail: `模型在第 ${step} 步自行结束。${trimNote()}`,
        tokensIn,
        tokensOut,
        latencyMs,
        contextTrimmed: contextTrimmed(),
      };
    }

    /*
     * ⚠️ **不是 `transcript += …`**（t82）：每步都按输入预算**重打包**，
     * 见上面 `repack()` 那段说明 —— 只增不减的记录会把 8 步的工具结果
     * （最坏约 32 万字符）全喂给下一次调用。
     */
    repack();
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
    detail: `达到步数上限（${maxSteps} 步）仍未结束，本轮没有结论。${trimNote()}`,
    tokensIn,
    tokensOut,
    latencyMs,
    contextTrimmed: contextTrimmed(),
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
 *   该有的字段一次写全           ← 防「单个对象没写完 / 只写了参数片段」（t81 补：15 条与 4 条都栽在这）
 * ```
 *
 * ⚠️ **最后一条是 t81 补的，而它纠正了上面那句"失败的真实形状是…"**：
 * 线上实测里失败的回复**本来就是单个对象** —— 工具循环那一档是"只有参数、没有 `tool` 外壳"
 * （`收到：{"limit":20}`），单次结论档是"对象没写完"（同期 `runtime_logs` 有 18 条
 * `finish_reason=length`）。而原来的指令只猜"多对象/前后带文字"，**打不中病因，所以重试也救不回来**。
 *
 * ⚠️ **这不改变解析层的严格性**：`parseRoleOutput` 对多对象仍然**必须失败**
 * （`roles.ts:751-753`：取错对象会把一个角色的结论当成另一个角色的）。
 * 重试只是**给模型一次改口的机会**，判据一点没松。
 */
const SINGLE_SHOT_RETRY_INSTRUCTION =
  '\n\n## ⚠️ 上一次回复无法解析成**一个完整的结论对象**\n' +
  '病因不止"多个对象 / JSON 前后带文字"：也可能**只写了参数或片段、对象没写完**。\n' +
  '请**只输出一个 JSON 对象**，不要重复输出、不要在 JSON 前后加任何文字，并把该有的字段一次写全。';

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
        /*
         * ⚠️ 这一档**没有工具结果**（它不开工具循环），所以输入侧没什么可裁的。
         * 恒 `false` 是**如实**的：它没有省略任何东西。
         * 唯一能让它超预算的是 `task` / `facts` 本身 —— 那属于调用方该管的事
         *（`autoTrader` 用 `promptTokenBudget()` 管提示词预算），不在这里静默裁。
         */
        contextTrimmed: false,
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
    contextTrimmed: false,
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
