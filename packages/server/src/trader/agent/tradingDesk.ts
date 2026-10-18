/**
 * **交易台编排** —— 多智能体团队的核心流程（S3）。
 *
 * ## 它在这套架构里的位置
 *
 * ```
 *   runTradingDesk()            ← 本文件
 *        │
 *        ├─ ① 并行：多个分析师同时看不同侧面（独立任务 → 可以并行）
 *        │       行情 / 新闻 / 情绪 / 技术面
 *        │
 *        ├─ ② 对抗：Bull 与 Bear 各自构建最强论证（**必须用不同厂商的模型**）
 *        │
 *        ├─ ③ 裁决：Judge 汇总 → 收敛成一个结论（唯一裁决者）
 *        │
 *        └─ ④ 产出：结构化决策 → 交给既有的风控与执行层
 * ```
 *
 * ## 三条不可违背的结构原则（都有硬证据，见设计文档 §〇）
 *
 * | 原则 | 在这里怎么体现 |
 * |---|---|
 * | **P1 共享状态串行 + 唯一裁决者** | ① 并行（各看各的、互不依赖）；②③ **严格串行** —— 辩论与裁决是共享状态 |
 * | **P2 最终决定权由代码强制** | 编排**硬性限制轮次与预算**，终止条件由**代码**判定，不交给 LLM 自判 |
 * | **P3 风控独立且有否决权** | 本文件**不产出最终订单** —— 它只产出"提案"，风控与执行仍在既有层 |
 *
 * ## 为什么不做"无限自由的讨论"
 *
 * 调研报告的硬证据：MAST 分类法实测 7 个开源多智能体框架**失败率 41%–86.7%**，
 * 其中「步骤重复 15.7%」与「不识别终止条件 12.4%」是最高频的两类。
 * 所以这里的轮次、预算、终止条件**全部写死在代码里**，而不是提示词里"请你在
 * 讨论充分后停止"那种祈求。
 *
 * ## 为什么分析师并行、研究员串行
 *
 * 调研结论（Cognition「Don't Build Multi-Agents」+ Anthropic 多 agent 工程）：
 * **广度优先、松耦合的任务适合并行；共享状态、紧耦合的任务必须单线程**。
 * 四个分析师各看一个数据源、互不依赖 → 并行；
 * 辩论与裁决在同一个上下文上累积 → 串行。
 */

import type { ModelTier } from '../../llm/modelCatalog.js';
import {
  prefilterSymbols,
  readJevConfig,
  type JevFallbackReason,
  type JevInput,
} from '../../llm/jev.js';
import { createLogger } from '../../logger.js';
import { mapConcurrent } from './pool.js';
import { analyzePerSymbol, type PerSymbolResult } from './perSymbol.js';
import { enterCritical, leaveCritical } from './resourceGate.js';
import { compactMarketContext, compactSeriesLines } from './symbolSlices.js';
import { pickForAnalysis } from './analystSampling.js';
import {
  BUDGET_SKIP_REASON,
  buildSupervisorPrompt,
  parseDispatch,
  planDispatch,
  type AnalystCandidate,
} from './dispatch.js';
/*
 * ── 两处 import 都是**汇报员**接线的需要（2026-10-13）────────────────────
 *
 * `extractFirstJsonArray`：汇报员要报"这一轮有几条决策、动作怎么分布"，
 * 而那个数字**必须与风控官审的、最终执行的是同一份** ——
 * 所以用执行层同一个抽取器，而不是自己写个正则数 `"action"`。
 * ⚠️ 这看起来是"下层反向依赖上层适配器"：`deskOutput.ts` 是
 * `DeskOutcome → <decision>` 的翻译层。但它从 `tradingDesk` 只 `import type`
 * （见该文件第 34 行），**类型导入在运行时被完全擦除** —— 所以没有循环依赖，
 * 而那个抽取器是**纯函数**，不牵扯任何适配逻辑。
 *
 * `ROLES`：汇报员的提示词在 `roles.ts` 里**已经写好了**（那是本次接线的起点）。
 * 在这里再写一段措辞会让"写好的那份"永远到不了模型手里，而且两份会各自漂移。
 */
import { extractFirstJsonArray } from './deskOutput.js';
import { ROLES } from './roles.js';

/**
 * **Jev 初筛的观测日志**（scope=`jev`）。
 *
 * ⚠️ 走 `logger` 而不是本地 `console`：只有 `logger` 的 sink 会把日志写进
 * `runtime_logs`（`api/server.ts` 的 `setLogSink`），界面才看得见。
 */
const jevLog = createLogger('jev');

/** 把回落原因翻译成一句能直接读的话（写进 `runtime_logs` 的 warn）。 */
function jevFallbackText(
  reason: JevFallbackReason | null,
  count: number,
  minScore: number,
  highest: number | null,
): string {
  switch (reason) {
    case 'scorer-failed':
      return '初筛调用失败（网络/超时/返回无法解析）';
    case 'count-mismatch':
      return '初筛返回数量与输入不符';
    case 'format-error':
      return '初筛返回格式不对（分数/置信度/标的对不上）';
    case 'all-below-threshold':
      return `全部 ${count} 个标的低于门槛 ${minScore}（最高 ${highest === null ? '—' : highest.toFixed(2)}）`;
    case 'empty':
      return '没有可打分的标的';
    case 'disabled':
      return '初筛未启用';
    default:
      return '初筛结果不可用';
  }
}

/**
 * **分析师的静态定义**（2026-10-13 提取为常量）。
 *
 * ## 为什么提取出来
 *
 * 原来它是函数内联的一个数组字面量 —— 而"总管要先知道**有哪些角色可选**
 * 才能决定派谁"，所以那份清单必须在**问总管之前**就存在。
 *
 * ⚠️ `contextKind` 而不是直接给 `context`：材料有两个来源
 * （行情 / 新闻），而**材料本身是运行期才知道的**（压缩与否、新闻有没有）。
 * 用"种类"而不是"字符串"，是为了让"谁用哪份材料"这件事**在这里一眼可见**。
 */
const ANALYSIS_ROLE_DEFS: ReadonlyArray<{
  role: string;
  tier: ModelTier;
  contextKind: 'market' | 'news';
  task: string;
}> = [
  {
    role: 'market_analyst',
    tier: 'T2_mid',
    contextKind: 'market',
    task: '分析当前市场的整体状态与值得关注的结构。',
  },
  {
    role: 'technical',
    tier: 'T1_fast',
    contextKind: 'market',
    task: '只做指标与形态的客观描述，不要给交易建议。',
  },
  {
    role: 'newscaster',
    tier: 'T1_fast',
    contextKind: 'news',
    task: '把新闻整理成结构化事件卡（实体、方向、强度、来源）。没有可用的新闻就明说。',
  },
  {
    role: 'sentiment',
    tier: 'T1_fast',
    contextKind: 'news',
    task: '给出市场情绪分与样本量。没有数据就明说"样本不足"，不要编。',
  },
];

/** 一个角色的产出（结构化卡片）。 */
/**
 * **一次模型调用的用量**（团队模式要按角色收账）。
 *
 * ## 为什么 `null` 与 `0` 必须分开（照抄 `ChatUsage` 的纪律）
 *
 * `null` = **服务商没报这个字段（不知道）**；`0` = **报了，确实是 0**。
 * 两者的结论完全相反 —— 见 `llm/types.ts:45-51` 的说明。
 * 合并成一个数会让"没记账"看起来像"没花钱"。
 *
 * ⚠️ 与上面那条同源：**一个把故障说成正常的地方，比报错更危险。**
 * 团队模式此前 482 轮决策的四列全是"不知道"，而界面上看起来像"零成本"。
 */
export interface RoleUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** `promptTokens` 里命中上下文缓存的部分。 */
  cachedTokens: number | null;
  /** `completionTokens` 里花在思考上的部分（计入 completion）。 */
  reasoningTokens: number | null;
}

export interface DeskRoleOutput {
  role: string;
  /** 该角色用的模型（审计要记：**"谁用了什么模型"是排查质量问题的第一手信息**）。 */
  modelId: string;
  /** 结构化结果（各角色 schema 不同，见 `roles.ts` 的 `ROLES[].system`）。 */
  data: unknown;
  /** 原始文本（解析失败时保留，便于排查）。 */
  raw: string;
  latencyMs: number;
  ok: boolean;
  /** 失败原因（ok=false 时有值）。 */
  error?: string;
  /**
   * **这次调用真的花了多少 token**（2026-10-17 补 —— 修"团队账目全空"）。
   *
   * ## 为什么是可选字段
   *
   * 它是**观测**，不是**判据**：`AskRole` 的注入实现（真实路由器 / 测试桩）
   * 不报它时，编排必须照样跑完一轮。所以缺省 = `undefined` = "这次没收到用量"，
   * 而不是"0"。
   *
   * ## 为什么加在这里而不是在 `routedModel` 里另算
   *
   * 因为**只有编排自己知道这一轮问了哪些角色** —— 总管、分析师、按币并行、
   * 辩论、裁决、汇报分散在 `runTradingDeskInner` 的六段里，调用方拿不到的
   * （尤其是按币并行的产出**不进 `analyses`**，见 `perSymbolResult`）。
   * 所以在编排出口处汇总，是唯一不会漏的地方。
   */
  usage?: RoleUsage;
}

/**
 * **把一轮里所有角色的用量加起来**（团队模式的 token 账目）。
 *
 * ## 语义（三条，缺一不可）
 *
 * | 输入 | 输出 | 为什么 |
 * |---|---|---|
 * | 全部角色的 `usage` 都是 `undefined` | `{ reported: false, usage: null }` | **不知道** ≠ 0。测试桩与"没接线"的调用方走这条 |
 * | 至少一个角色报了 | `{ reported: true, usage: {…} }` | 每个字段**只累加非 null 的**；全为 null 的字段给 `null` |
 * | 某个角色失败/超时（`usage: undefined`） | 不计入，但**不阻止** others 累加 | 失败角色本来就没花多少钱，不能因此把整轮说成"不知道" |
 *
 * ## 为什么不是"所有角色都报了才算"
 *
 * 因为团队一轮有 26–28 次调用，**总会有角色失败或超时**。要求"全报"
 * 等于"永远不记账" —— 那正是这次要修的缺陷的形状。
 */
export function sumRoleUsage(
  outputs: ReadonlyArray<DeskRoleOutput | null | undefined>,
): { reported: boolean; usage: RoleUsage | null } {
  let reported = false;
  let sawPrompt = false;
  let sawCompletion = false;
  let sawCached = false;
  let sawReasoning = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;

  for (const out of outputs) {
    const u = out?.usage;
    if (u === undefined) continue;
    reported = true;
    if (u.promptTokens !== null) { sawPrompt = true; promptTokens += u.promptTokens; }
    if (u.completionTokens !== null) { sawCompletion = true; completionTokens += u.completionTokens; }
    if (u.cachedTokens !== null) { sawCached = true; cachedTokens += u.cachedTokens; }
    if (u.reasoningTokens !== null) { sawReasoning = true; reasoningTokens += u.reasoningTokens; }
  }

  if (!reported) return { reported: false, usage: null };
  return {
    reported: true,
    usage: {
      promptTokens: sawPrompt ? promptTokens : null,
      completionTokens: sawCompletion ? completionTokens : null,
      cachedTokens: sawCached ? cachedTokens : null,
      reasoningTokens: sawReasoning ? reasoningTokens : null,
    },
  };
}

/**
 * **把两份用量相加**（为"一次 `complete()` 跑多轮交易台"准备）。
 *
 * ## 为什么需要它（而不是让调用方自己写 `a + b`）
 *
 * 因为加法**不是**"对 null 取 0 然后相加"就完了。见 `sumRoleUsage` 的三条语义：
 * `null + 5` 应当是 **5**（那个字段确实有真值），而**不是** `null`。
 * 这个判断（"哪些字段见过真值"）已经在 `sumRoleUsage` 里写好 ——
 * 这里只是把它套用到"两份用量"上，**不重写第二遍加法**
 *（本仓库为"同一个算术写在两个地方，改一处等于没改"付过代价）。
 *
 * ## 谁需要它
 *
 * 团队模式的一次 `complete()` **可能跑多轮交易台**：`autoTrader` 的按需取数循环
 *（`MAX_DATA_ROUNDS = 3`）里"再问一次模型"就等于把整个交易台重跑一遍。
 * 所以团队模型返回给 `autoTrader` 的必须是**这些轮之和**，
 * 而不是最后一轮 —— 也就是 `autoTrader.ts:3781-3783` 要的那个语义。
 */
export function mergeRoleUsage(
  a: RoleUsage | null | undefined,
  b: RoleUsage | null | undefined,
): { reported: boolean; usage: RoleUsage | null } {
  const wrap = (u: RoleUsage | null | undefined): DeskRoleOutput | null =>
    u === null || u === undefined
      ? null
      : { role: '', modelId: '', data: null, raw: '', latencyMs: 0, ok: true, usage: u };
  return sumRoleUsage([wrap(a), wrap(b)]);
}

/** 一次交易台会议的完整产出。 */
/**
 * **辩论者与裁决官拿到的市场材料上限**（字符）。
 *
 * 见 `debateMaterial` 的说明：原来给的是**全文**（实测约 15 万 token），
 * 而 bull 与 bear 是**串行**的 → 这一段的耗时是两份全文之和。
 *
 * 现在只给一段：足够核对事实（关键位、方向、结构），
 * 但不至于让下游重读一遍分析师已经消化过的材料。
 *
 * ⚠️ 这个值不是"越小越好"：辩论者需要能**核对**分析师的结论。
 * 完全去掉市场材料会让论证失去依据（那正是"分工"的反面 ——
 * 让下游盲信上游）。
 *
 * ── ⚠️⚠️ **不能简单 `slice(0, N)`**（2026-10-13 实测抓到的真 BUG）──────
 *
 * ## 事故：裁决官**一个候选都看不到**
 *
 * 原来写的是 `input.marketContext.slice(0, DEBATE_MARKET_CHARS)`。
 * 而材料的结构是：
 * ```
 *   # 账户 → # 全市场概览（525 个标的，约 5 万字）→ # 候选标的（12 个，每个约 9 千字）
 * ```
 * 于是**前 12000 字符全部落在"全市场概览"里**。实测：
 * ```
 *   完整材料 130,420 字符
 *   材料里的候选标题: 12 个
 *   前 12,000 字符覆盖:  **0 个候选**
 * ```
 * **也就是说：裁决官与辩论者看到的材料里没有任何一个候选的指标序列** ——
 * 而它们却要据此裁决"做不做"。难怪裁决官会说
 * 「另 6 候选无指标序列」（其实它连一个都没看到）。
 *
 * ## 修法：按**段落**取，而不是按**前缀**取
 *
 * `marketContext` 的段落以 `### N. SYMBOL` 开头（`symbolSlices.ts` 的切分依据）。
 * 所以"给一段候选材料"应当是"**从头几个候选段里取**"，
 * 而不是"取材料的开头 N 个字符"。
 *
 * 见 `headOfMarket()`：它保留**概览的头部**（那段有用：大盘背景）
 * 加上**前若干个候选的完整段**，总量控制在 `DEBATE_MARKET_CHARS` 附近。
 */
const DEBATE_MARKET_CHARS = 12_000;

/**
 * **辩论者与裁决官拿到的市场材料预算**（字符）—— **压缩后**的材料。
 *
 * 见 `analystContext`：分析师拿到的是 `compactMarketContext` 的输出
 *（每个候选从约 12k 压到约 3k）。实测：
 * ```
 *   6 个候选（压缩后） = 20,893 字符
 *  12 个候选（压缩后） = 36,583 字符
 * ```
 * 24,000 能覆盖**前 6 个候选的完整序列** + 概览头部 + 容器开销。
 *
 * ⚠️ 与 `AQ_ANALYST_UNIVERSE` 的默认值（6）**同一个口径** ——
 * 上游与下游看到同一批证据，才谈得上"核对"（那是"分工"的前提）。
 */
const DEBATE_MARKET_FOR_JUDGE_CHARS = 24_000;

/**
 * **取市场材料的"开头"** —— 但保证**包含候选段**（而不是只取前缀字符）。
 *
 * @param marketContext 完整市场材料
 * @param budgetChars 目标字符预算
 *
 * 结构：`概览头部` + `前 N 个候选段`，总量不超过 `budgetChars` 的 1.6 倍
 *（候选段是不可切的整体 —— 切一半会让模型看到"残缺的指标序列"，
 * 那比不给更糟：它会基于半截数据下结论）。
 */
export function headOfMarket(marketContext: string, budgetChars: number): {
  text: string;
  candidatesShown: number;
  totalCandidates: number;
} {
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **先把规则段摘出来，让它【不参与任何截断】**（2026-10-13 实测 P0）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故：规则段被 `overviewCap` 腰斩（每轮 100% 触发）
   *
   * 这条是**独立审计**发现的第三条路径，而**线上证据当天就印证了它**：
   * ```
   *   #2590 c97（修①之前）: MUST=false  default-to-action=false   ← 全丢
   *   #2592 c98（修①之后）: MUST=**true**  default-to-action=false ← 只有前半段到了
   * ```
   * 也就是"规则开始被引用了，但**只有前 3.9k 字符幸存**"。
   *
   * ## 根因：`compacted.shared` 被当成"概览"再截一次
   *
   * 材料形状（默认压缩路径）：
   * ```
   *   analystContext = compacted.shared + 前 6 个候选切片
   *                    ↑ 含【概览 + 账户 + 绩效 + 规则段】
   *   headOfMarket(analystContext, 24000)
   *     → overview = 第一个候选之前的全部内容（= compacted.shared）
   *     → overviewCap = 24000/4 = 6000
   *     → overview.slice(0, 6000)   ← ❌ 规则段 12.9k，被砍到只剩约 3.9k
   * ```
   * 实测（真实 `systemPrompt` 12858 字符 + 线上材料形状）：
   * ```
   *   # 入场标准          offset 2587  → 幸存
   *   # 输出格式          offset 4098  → **丢失**
   *   # 你自己写下的长期指示 offset 12860 → **丢失**
   * ```
   * 边界：`shared` 的"规则段之前"部分 ≥ 3502 字符时，**连 `# 入场标准` 都丢**。
   *
   * ## 为什么上一轮的修②救不回来
   *
   * 修② 的判据是"在**最后一个 part** 里找 marker" —— 而修① 已经把规则段
   * 搬到了 `shared`（不在任何 part 里）→ 修② 在这条路径上**永远找不到东西可补**。
   *
   * **这是"两个各自正确的修复合起来失效"** —— 与本项目记录过的
   * `ai_requested` + "只取前 6 个"是同一类组合性缺陷。
   *
   * ## 修法：规则段是【行为约束】，不是"可裁的背景材料"
   *
   * ```
   *   裁候选/裁概览  → 省 token（材料是"参考"）
   *   裁规则段       → **改变系统行为**（模型不知道自己的义务）
   * ```
   * 所以它在**任何截断之前**就被摘出来，最后无条件接回。
   * 代价是几 KB，换来的是"模型知道自己该做什么"。
   */
  const RULES_MARKER = '\n---\n\n## 团队需要遵守的规则';
  /*
   * ⚠️ 规则段可能出现在**两处**（取决于材料怎么拼的）：
   *   · 在 `shared` 里（压缩路径：修① 把它搬进了 shared）
   *   · 在**最后一个候选之后**（未压缩路径：routedModel 直接拼在末尾）
   * 两处都要处理。
   */
  const extractRules = (text: string): { body: string; rules: string } => {
    const at = text.indexOf(RULES_MARKER);
    if (at < 0) return { body: text, rules: '' };
    return { body: text.slice(0, at), rules: text.slice(at) };
  };

  /*
   * 找候选段的起点：第一处 `### 1. `（或 `### <数字>. `）。
   * ⚠️ 用行首锚定，避免命中正文里偶然出现的 `### 1.`。
   */
  const firstCand = /^###\s*\d+\.\s*\S/m.exec(marketContext);
  if (firstCand === null) {
    /*
     * 没有候选段（例如持仓管理轮）→ 退回前缀。
     *
     * ⚠️⚠️ **但规则段仍要保住**（2026-10-13 审计发现的第四条路径）：
     * 持仓轮的材料 = 概览 + 持仓 + 绩效 + 规则段，实测 29612 字符，
     * 而预算 24000 → 直接 `slice` 会把规则段尾巴砍掉。
     */
    const { body, rules } = extractRules(marketContext);
    const room = Math.max(0, budgetChars - rules.length);
    return {
      text: (body.length > room ? body.slice(0, room) : body) + rules,
      candidatesShown: 0,
      totalCandidates: 0,
    };
  }
  const overviewEnd = firstCand.index;
  /*
   * ⚠️ **先把规则段从 overview 里摘出来** —— 它不参与 `overviewCap`。
   * 摘完再截断，这样规则段永远不会被腰斩。
   */
  const rawOverview = marketContext.slice(0, overviewEnd);
  const { body: overview, rules: overviewRules } = extractRules(rawOverview);
  const rest = marketContext.slice(overviewEnd);

  /* 按 `### N. ` 切开候选段。 */
  const parts = rest.split(/^(?=###\s*\d+\.\s*\S)/m);
  const total = parts.length;
  /*
   * 预算分配：概览最多占 1/4（它只是背景），其余给候选段。
   * ⚠️ 概览**必须保留** —— 它给出"大盘今天什么状态"，
   * 而那正是辩论"逆势还是顺势"的依据。
   */
  const overviewCap = Math.floor(budgetChars / 4);
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **概览段的截断必须"按小节切"，并优先保住【行为约束】小节**
   *      （2026-10-13 实测 —— 同一类 BUG 的第五处）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故：裁决官看不到「保证金 ≠ 名义价值」，于是继续算错
   *
   * 线上 `#2594 c99` 的决策理由原文：
   * ```
   *   BTCUSDT skip：「最小名义 50 对 20U 账户**过重**，不做。」
   * ```
   * **而这是错的**：`20.75 × 20x = 415 USDT 名义`，它完全开得起。
   *
   * ## 为什么：那段换算是"概览"的一部分，而概览被 `overviewCap` 砍了
   *
   * 实测（线上真实 `user_prompt` 132921 字符）：
   * ```
   *   「逐仓运行的」/「保证金 ≠ 名义价值」段  位置 18187（13.7%）
   *   第一个候选标题                          位置 18876
   *   → 它在【第一个候选之前】→ 被当成"概览"
   *   → overviewCap = 24000/4 = 6000
   *   → 位置 18187 > 6000 → **被截掉**
   * ```
   * 于是：**我上一轮修的换算说明，裁决官从来没见过** ——
   * 它仍然凭"20U 账户 vs 50 名义"的直觉判断，而那个直觉是错的。
   *
   * ## 为什么不能"再摘一个 marker"
   *
   * 我前面已经为「规则段」摘过一次（`extractRules`）。若再来一个
   * "摘名义价值段"的 marker，下次还会有第三段、第四段 ——
   * **那是在逐个打补丁，而根因是"概览里混着行为约束"这件事没被承认**。
   *
   * ## 正解：按 `#` 小节切，把"约束类"小节排在前面
   *
   * ```
   *   overview 由若干 `# 小节` 组成（`# 系统状态` / `# 硬性约束` / `# 逐仓…`）
   *   → 按小节切分
   *   → 【约束类】小节优先保留（它们是行为依据，不是背景数据）
   *   → 【数据类】小节（概览、绩效）按剩余空间给
   * ```
   * ⚠️ 判据用**关键词命中**（"约束 / 边界 / 保证金 / 逐仓 / 规则 / 必须"），
   * 而不是写死小节名 —— 因为小节名会随渲染改动而变，而**语义不会**。
   *
   * ⚠️ 保序：输出顺序仍按原文顺序（模型读起来连贯），只是"谁被砍"变了。
   */
  const CONSTRAINT_HINTS = /约束|边界|保证金|逐仓|规则|必须|不能|禁止|上限|下限|可用/;
  const head = (() => {
    if (overview.length <= overviewCap) return overview;
    /*
     * 按行首 `#`（1–3 级）切成小节。第一段（标题之前的内容）保留。
     */
    const lines = overview.split('\n');
    const secs: Array<{ title: string; text: string; important: boolean }> = [];
    let cur: { title: string; lines: string[] } | null = null;
    for (const line of lines) {
      if (/^#{1,3}\s/.test(line)) {
        if (cur !== null) secs.push({ title: cur.title, text: cur.lines.join('\n'), important: CONSTRAINT_HINTS.test(cur.title) });
        cur = { title: line, lines: [line] };
      } else if (cur === null) {
        cur = { title: '', lines: [line] };
      } else {
        cur.lines.push(line);
      }
    }
    if (cur !== null) secs.push({ title: cur.title, text: cur.lines.join('\n'), important: CONSTRAINT_HINTS.test(cur.title) });

    /*
     * ⚠️⚠️ **约束类优先，但必须给"数据类"留一份配额**（2026-10-13 实测回归）。
     *
     * ## 我第一版只做"约束类优先"，把概览挤掉了
     *
     * 既有测试 `marketHead.test.ts` 当场抓到：
     * ```
     *   ★★★ 概览不能被整段丢掉 —— 它是"大盘背景"（辩论要用）
     *   → out.text.includes('全市场概览')  ❌ 失败
     * ```
     * 根因：`# 账户` 段里含"可用 / 保证金"→ 命中约束关键词 → 被当"重要"，
     * 于是它先占满 `overviewCap`，而「全市场概览」作为"不重要"被挤掉。
     *
     * ## 为什么那是个真回归
     *
     * 「全市场概览」是辩论"**顺势还是逆势**"的唯一依据 ——
     * 裁掉它，辩论者就只能看到候选自己的形态，看不到大盘。
     * 而约束段（保证金换算）与概览段**回答的是两个不同的问题**，都要在。
     *
     * ## 修法：两段各留配额
     *
     * ```
     *   约束类 → 最多 70% 的 overviewCap
     *   数据类 → 剩下的 ≥30%（按原顺序）
     * ```
     * ⚠️ 70/30 是实测选出的：约束段（逐仓 + 换算 + 杠杆档位）实测约 3.6k，
     * 而 `overviewCap = 6000` 的 70% = 4200 —— 装得下；
     * 概览 30% = 1800 —— 够放"大盘一句话 + 涨跌榜头部"。
     */
    const CONSTRAINT_QUOTA = Math.floor(overviewCap * 0.7);
    const keep = new Map<string, string>(); /* 原文 → 实际输出的文本（可能被截短） */
    let used = 0;
    /*
     * ⚠️⚠️ **小节放不下时要【截断它】，而不是丢掉它**（2026-08-13 实测回归）。
     *
     * ## 既有测试当场抓到的第二个问题
     *
     * `marketHead.test.ts` 的材料是**扁平结构**：
     * ```
     *   # 账户
     *   权益 20.75 USDT
     *   # 全市场概览（币安 525 个 USDT 永续）
     *   SYM0USDT 1.23 -1.5% 456M      ← 400 行，约 9,000 字符
     *   ...
     * ```
     * 而「# 全市场概览」这一节 **9,000 字符 > 剩余配额** → 被 `continue` 跳过
     * → **整段概览丢掉** → 辩论者看不到大盘 ❌
     *
     * ## 为什么"丢掉"是错的
     *
     * ```
     *   概览是【能裁的数据】：400 行里给前 60 行照样能看出大盘方向
     *   约束是【不能裁的规则】：截断会让模型读到半句话
     * ```
     * 所以：**约束类**放不下就跳过（宁可不要，也不要半句）；
     *      **数据类**放不下就**截断**（前面那部分仍然有用）。
     */
    const addSection = (s: { text: string; important: boolean }, cap: number): void => {
      const room = cap - used;
      if (room <= 0) return;
      if (s.text.length <= room) {
        keep.set(s.text, s.text);
        used += s.text.length;
        return;
      }
      if (!s.important) {
        /*
         * 数据类：截断到剩余空间（**至少给 200 字符**，否则那一段没有信息量）。
         */
        if (room >= 200) {
          keep.set(s.text, `${s.text.slice(0, room)}\n（本节因预算截断）`);
          used += room;
        }
      }
      /* 约束类放不下 → 跳过（半句规则比没有更糟）。 */
    };
    for (const s of secs.filter((x) => x.important)) addSection(s, CONSTRAINT_QUOTA);
    for (const s of secs.filter((x) => !x.important)) addSection(s, overviewCap);
    /*
     * ⚠️ 一个都没放下时也要给第一个（宁可超一点，也不要给"没有概览"的材料）。
     */
    if (keep.size === 0 && secs.length > 0) keep.set(secs[0]!.text, secs[0]!.text);
    /*
     * **按原文顺序**输出（保序），只保留选中的那些；
     * ⚠️ 值用 `keep.get()`（数据类可能被截短过）。
     */
    const kept = secs
      .filter((s) => keep.has(s.text))
      .map((s) => keep.get(s.text) ?? s.text)
      .join('\n');
    const omitted = secs.length - keep.size;
    return omitted > 0 ? `${kept}\n（概览另有 ${omitted} 个小节因预算未展开）\n` : kept;
  })();

  const picked: string[] = [];
  let used = head.length;
  for (const p of parts) {
    if (used + p.length > budgetChars) break;
    picked.push(p);
    used += p.length;
  }
  /*
   * ⚠️ **一个候选都放不下时也要给第一个**（宁可超预算，也不要给"没有候选"的材料）——
   * 那正是这个 BUG 的形态。 */
  if (picked.length === 0 && parts.length > 0) picked.push(parts[0]!);

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **最后一个 part 里的"非候选尾巴"必须单独保留**（2026-10-13 实测 P0）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故：策略师写的规则【到不了辩论者与裁决官】
   *
   * 上面那个 `break` 会把**超预算之后的候选全部丢掉** —— 而
   * `routedModel.ts:863` 拼材料时把**规则段放在【最后】**：
   * ```
   *   marketContext = userPrompt
   *                 + '\n---\n\n## 团队需要遵守的规则（来自交易循环）\n'
   *                 + systemPrompt        ← 策略师的 entryStandards 都在这里
   * ```
   * 预算 12,000 用完时 `break` → **规则段永远不会进 `picked`**。
   *
   * ## 线上实证（决定性）
   *
   * `#11` 的 `cot_trace`（四个分析师 + 裁决官的产出）里：
   * ```
   *   "MUST open at least one position"  ❌ 未命中
   *   "default-to-action"                ❌ 未命中
   *   "opportunity cost"                 ❌ 未命中
   * ```
   * 而策略师自己写的规则原文就是：
   * ```
   *   「You MUST open at least one position per 6 cycles if any symbol
   *     showed a ≥2% move. …your entry standards are too strict by construction」
   * ```
   * → **裁决官（最终决策者）从来不知道它有"必须开仓"的义务。**
   * 结果：**95 轮 · 217 条决策 · 全部 skip · 0 成交。**
   *
   * ## 修法：把尾巴【无条件】接回去（它不属于"可裁的候选"）
   *
   * ```
   *   规则段不是候选材料 —— 它是【行为约束】。
   *   裁候选是为了省 token，而裁掉约束是【改变系统行为】。
   * ```
   * ⚠️ 无条件保留的代价是几 KB（`systemPrompt` 13162 字符里的规则段部分）——
   * 而它换来的是"模型知道自己该做什么"，那**远远值得**。
   *
   * ⚠️ 判据用 `routedModel` 拼材料时的那个独特分隔符；找不到时**原样返回**
   *（退化成修之前的行为，而不是把材料弄坏）。
   */
  /*
   * ⚠️⚠️ **判据必须同时看 `head` 与 `picked`**（2026-10-13 审计发现的坑）。
   *
   * 上一版只查 `picked.some(...)` —— 而修① 把规则段搬进了 `shared`，
   * 于是它出现在 `head` 里（不在任何 part 里）→ 那个判据**永远为 false**，
   * 又去 `parts[last]` 找 marker（那里已经被搬空）→ 补不上。
   *
   * 现在改成三段来源合并：
   * ```
   *   ① overviewRules —— 从 `head` 里摘出来的（压缩路径，修① 搬进 shared 的那份）
   *   ② picked 里的    —— 未压缩路径下，规则段随最后一个候选一起被收进来
   *   ③ parts[last] 的 —— 未压缩路径下，规则段被 break 挡在外面时单独取
   * ```
   * ⚠️ 三处**只取一份**（重复会让模型以为有两套规则）。
   */
  const rulesFromPicked = picked.find((p) => p.includes(RULES_MARKER));
  let rulesTail = '';
  if (overviewRules !== '') {
    /* ① 优先：从 head 里摘出来的那份（最完整 —— 它没被截断过）。 */
    rulesTail = overviewRules;
  } else if (rulesFromPicked !== undefined) {
    /* ② 已经在 picked 里了 → 不用再补（避免重复）。 */
    rulesTail = '';
  } else {
    /* ③ 未压缩路径：规则段在最后一个 part 里、且被 break 挡在外面。 */
    const lastPart = parts[parts.length - 1];
    if (lastPart !== undefined) {
      const at = lastPart.indexOf(RULES_MARKER);
      if (at >= 0) rulesTail = lastPart.slice(at);
    }
  }

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️ **被预算挡掉的候选必须"说出来"**（2026-10-15 修）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 原来的行为：静默丢掉，而材料看起来是完整的
   *
   * 上面那个 `break` 会把超预算之后的候选整段丢掉，而 `text` 里**没有任何交代**。
   * 用真实材料实测（`#11`）：
   * ```
   *   headOfMarket(raw,     12_000) → candidatesShown = 1 / 12
   *   headOfMarket(analyst, 24_000) → candidatesShown = 5 / 6
   * ```
   * 模型读到的是"候选就这些"，而真相是"还有 N 个被预算挡住了"。
   *
   * 这正是本仓库反复强调的那类**假事实** —— 与 `compactUniverseOverview` 的
   *「必须显式写出省略了多少行」是同一条纪律：**宁可说截断了，不能让它误以为完整**。
   *
   * ⚠️ 它同时解释了另一个真现象：`analystContext` 取 6 片，而裁决官那一份
   * 在 24k 预算下只列得出 5 个 —— **第 6 个候选从结论里消失了**，
   * 而分析师明明分析过它。
   */
  const omittedCandidates = Math.max(0, total - picked.length);
  const omissionNote =
    omittedCandidates > 0
      ? `\n\n（⚠️ 另有 ${omittedCandidates} 个候选因**材料预算**没有列出 —— ` +
        `不是"市场里没有它们"，而是这一次的材料放不下。` +
        `需要看就用 get_klines 点名要，或把它们排进前几位。）\n`
      : '';

  return {
    text: [head, ...picked, omissionNote, rulesTail].join(''),
    candidatesShown: picked.length,
    totalCandidates: total,
  };
}

/**
 * **分析师产出给辩论者的窗口**（字符）。
 *
 * 400（原值）太短：辩论者现在主要靠它，截断会让论证失去依据。
 * 1200 大约是"一段完整结论 + 关键依据"的长度。
 */
const ANALYST_DIGEST_CHARS = 1_200;
export interface DeskOutcome {
  /** 各分析师的并行产出。 */
  analyses: DeskRoleOutput[];
  /** 多空论证（`null` = 该角色没跑或失败）。 */
  bull: DeskRoleOutput | null;
  bear: DeskRoleOutput | null;
  /** 裁决结论。 */
  verdict: DeskRoleOutput | null;
  /** 这一轮实际用掉的模型调用次数（预算审计）。 */
  callsUsed: number;
  /** 是否因为预算/轮次上限而提前收尾。 */
  truncatedByBudget: boolean;
  /** 一句话摘要（给日志与界面用）。 */
  summary: string;
  /**
   * **这一轮所有角色加起来的 token 用量**（2026-10-17 补）。
   *
   * ## 语义与"整轮 vs 最后一次"的关系（这一条是本次修复的核心）
   *
   * `autoTrader.ts:3781-3783` 明确区分过两件事：
   * ```
   *   「这一轮的真实用量」  vs  「最后一次调用的用量」
   * ```
   * 而团队模式**一次 `complete()` 背后是 26–28 次模型调用**
   *（总管 1 + 分析师 4 + 按币并行 17~19 + 辩论 2 + 裁决 1 + 汇报 1；见 `DESK_LIMITS`）。
   * 所以这里的值必须是**这些调用的【和】**，而不是其中任何一次。
   *
   * 它是**怎么保证是和的**：汇总点在 `runTradingDeskInner` 的出口，
   * 而那一处的入参**包含全部六段**的产出（`analyses` / `perSymbol` / `bull` / `bear` /
   * `verdict` / `report` 各自那次）。少收任何一段，数字就会小于真实的整轮成本 ——
   * 签名的形状（接收全部产出）比注释更难写错。
   *
   * `null` = **这一轮的调用方没有报用量**（测试桩、或还没接线的路径）——
   * 不是"零成本"。见 `sumRoleUsage` 的三条语义。
   *
   * ## ⚠️ 为什么这里是可选（`?:`）而不是必填
   *
   * 与 `DeskRoleOutput.usage` 同一个理由：它是**观测**，不是**判据**。
   * 既有测试里有两处手工构造 `DeskOutcome` 的夹具
   *（`deskOutput.test.ts` / `riskSkipReason.test.ts`）—— 它们不关心用量，
   * 若把这里写成必填，就必须去改那两个文件（而它们不在本次改动的范围内）。
   *
   * **真正的生产者只有一个**：`runTradingDeskInner` 的出口，它**总是**给出这个值
   *（`null` 或对象，不会是 `undefined`）。消费方（`routedModel`）按
   * `usage ?? null` 处理 `undefined` —— 于是"没报"与"没这个字段"行为一致。
   */
  usage?: RoleUsage | null;
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⭐ **汇报员的产出**（2026-10-13 接线 —— 用户需求 ⑤ 点名的"汇报工作的"）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 为什么是**可选**字段，而不是必填的 `string`
   *
   * 因为它是**附加动作**（见 `runTradingDeskInner` 里 ④ 那一段）：
   * 汇报员没跑（预算不足）或跑失败时，这一轮**仍然是完整的一轮** ——
   * 决策、风控、执行全都没少任何东西。
   * 若把它写成必填，那就得在失败时编一个 `''` 或 `'（无汇报）'` 填进去，
   * 而**调用方无法区分"它说没事"与"它根本没跑"** ——
   * 那正是本仓库反复强调的"看不出异常的失败"。
   *
   * ## 三个取值，语义各不相同（调用方必须能分辨）
   *
   * ```
   *   string  —— 它跑了，这是它的产出（原始文本，含它自己的 JSON 结构）
   *   null    —— 它跑了但**失败了**（超时/网关抖动/空内容）
   *   undefined —— 它**根本没被调用**（预算不足）
   * ```
   *
   * ⚠️ 这里的 `undefined` 与 `null` 的区别是刻意的，不是疏忽 ——
   * 与 `verdict` 的 `null`（"没跑或失败"）不同，因为汇报员的**"没跑"本身
   * 就是一条值得看的信息**：它意味着"这一轮的预算连一次附加调用都放不下"。
   */
  report?: string | null;
}

/** 一次"问某个角色"的函数（由调用方注入真实实现，便于测试）。 */
export type AskRole = (input: {
  role: string;
  tier: ModelTier;
  /** 该角色要看的材料（结构化文本）。 */
  context: string;
  /** 角色自己的任务描述。 */
  task: string;
}) => Promise<DeskRoleOutput>;

/** 编排的硬上限（P2：**由代码强制，不交给 LLM**）。 */
export const DESK_LIMITS = {
  /**
   * 一次会议最多几次模型调用。
   *
   * 组成：**总管(1)** + 4 个分析师并行(4) + Bull(1) + Bear(1) + **Judge(1)** = 8，
   * 第 9 次给**汇报员**（2026-10-13 接线）→ **9**。
   *
   * ⚠️ **`maxCalls` 必须 ≥ 1(总管) + 分析员数 + 2×辩论轮数 + 1（裁决）**，
   * 否则裁决会被饿死 —— 这是实测踩到的：
   * ```
   *   第一版 maxCalls=8 配 maxDebateRounds=2 → 4 + 2×2 = 8 次用光，
   *   Judge 一次都没跑，整轮没有结论。
   * ```
   * ⚠️ 而 2026-10-13 接上真总管之后，**同样的错误又差点重演**：
   * `maxCalls=8` 在"1 总管 + 4 分析师 + 2 辩论 + 1 裁决 = 8"下**刚好用光**，
   * 两个既有测试当场失败（「自洽预算下不该被截断」）。所以提到 9。
   *
   * 所以下面有 `assertBudgetConsistent()` 在启动时就把这个不变量验一遍 ——
   * **让配置错误在启动那一刻暴露，而不是在跑了几十轮之后表现为"总是没有裁决"。**
   *
   * ── ⚠️ **第 9 次从"余量"变成了"汇报员"**（2026-10-13 接线后必读）────────
   *
   * ## 为什么没有再把 `maxCalls` 提到 10
   *
   * 因为**汇报员在编排里排在最后**（见 `runTradingDeskInner` 的 ④）：
   * ```
   *   裁决官的 canAsk() 检查 → 裁决 → 汇报员的 canAsk() 检查
   * ```
   * 于是"预算不够"被牺牲的**永远是汇报员**，而裁决官**结构上不可能**被它挤掉 ——
   * 这个保证来自**顺序**，不是来自算术。
   *
   * ## 为什么不把汇报员写进 `assertBudgetConsistent` 的不变量
   *
   * 那条不变量的语义是「**保证任何负载下裁决都跑得到**」—— 它守的是**决策链**。
   * 而汇报员是**附加动作**（用户明确要求"失败不能影响决策"）：
   * 把它写进不变量就等于宣布"预算永远必须容得下汇报"，
   * 那与"预算不足时**不调用**它"这条要求直接矛盾。
   *
   * 所以现在的账是：
   * ```
   *   不变量（必须永远成立）：1 总管 + 4 分析师 + 2×辩论 + 1 裁决 = 8
   *   默认配置 9 的第 9 次 = 汇报员（它可有可无，且排在最后）
   *   配置紧到 8 时（`{maxCalls: 8, maxDebateRounds: 1}`，自洽）
   *     → 裁决照常跑，**汇报员被跳过并记一条 onStep**
   * ```
   * ⚠️ 代价是**默认配置不再有"余量"**：将来若有人再加一次**必需的**调用，
   * 被挤掉的会是汇报员（那是设计意图），而**裁决仍由不变量保护**。
   */
  maxCalls: 9,
  /**
   * 辩论轮数上限。
   *
   * **从 1 起步**（TradingAgents 默认 2，但它的预算模型不同）。
   *
   * 为什么保守：调研的硬证据是 **"多 agent 辩论必然提升准确率"已被证伪**
   *（arXiv:2509.23055：谄媚会让辩论准确率**低于**单智能体基线），
   * 而 Anthropic 实测多 agent 的 token 成本约为 chat 的 **15×**。
   * 所以辩论要**够用就好**，不是越多越好。
   */
  maxDebateRounds: 1,
} as const;

/**
 * 分析员数量（满编）。**它就是预算校验的分母。**
 *
 * 想省钱应该调**它**（少派几个人），而不是调 `maxCalls` 去卡满编需求 ——
 * 后者会让"预算不足"在界面上表现为"这一轮没有决策"，从表面极难定位。
 */
export const DESK_ANALYST_COUNT = 4;

/**
 * **总管那次调用**占用的额度（2026-10-13 加）。
 *
 * ## 为什么必须显式计入不变量（我差点漏掉）
 *
 * 我把总管接上去之后，**两个既有测试当场失败**：
 * ```
 *   ★ 预算不足时【提前收尾并如实标记】  → 「自洽预算下不该被截断」实际被截断了
 *   ★ 分析师顺序必须与角色表一致
 * ```
 * 根因：`maxCalls = 8` 正好是 `4 分析师 + 1 Bull + 1 Bear + 1 Judge = 7` 加余量 1，
 * 而**总管又吃掉一次** → 分析师被截断 → **裁决官真的会被饿死**。
 *
 * > 这正是 `assertBudgetConsistent` 存在的意义：**它当场抓住了这个算术错误**。
 * > 而我如果只改 `maxCalls` 而不更新这个不变量，下一个改配置的人会再踩一次。
 */
const SUPERVISOR_CALLS = 1;

/**
 * 校验预算自洽 —— **不变量：`maxCalls` 必须容得下
 * "1 次总管 + 满编分析员 + 全部辩论 + 1 次裁决"**。
 *
 * ## 为什么按【满编】校验，而不是按"这次实际会派几个"
 *
 * 因为分析员数量本身是预算的函数（钱不够就少派几个），按实际数校验会变成
 * **循环论证**：派 2 个时不报错、派 4 个时才报错 —— 于是配置错误在大负载时才炸，
 * 而不是启动时就炸。
 *
 * **按满编校验 = 保证任何负载下裁决都跑得到。**
 *
 * ⚠️ 实测踩到的真实缺陷：第一版 `maxCalls=8` + `maxDebateRounds=2`，
 * 4 + 2×2 = 8 用光，**Judge 一次都没跑**，整轮没有结论。
 */
export function assertBudgetConsistent(
  limits: { maxCalls: number; maxDebateRounds: number },
  analystCount = DESK_ANALYST_COUNT,
): void {
  const needed = SUPERVISOR_CALLS + analystCount + limits.maxDebateRounds * 2 + 1;
  if (limits.maxCalls < needed) {
    throw new Error(
      `交易台预算不自洽：需要至少 ${needed} 次调用` +
        `（${SUPERVISOR_CALLS} 总管 + ${analystCount} 分析师 + ${limits.maxDebateRounds}×2 辩论 + 1 裁决），` +
        `但 maxCalls=${limits.maxCalls} —— 裁决会被饿死，整轮将没有结论。`,
    );
  }
}

/**
 * **从市场材料里摘出「账户状态」那一段**（2026-10-13，汇报员接线需要）。
 *
 * ## 为什么是"摘一段"而不是"把材料给它"
 *
 * 汇报员要回答的第一个问题就是「账户现在什么状态」。而账户信息**只存在于
 * `marketContext` 里**（`routedModel` 给 `positionContext` 传的是空串）——
 * 那份材料实测 **130,420 字符**。
 *
 * ```
 *   ✗ 把 marketContext 整个给它   → 为了 40 字的账户行读 13 万字符
 *   ✓ 只摘 `# 账户` 那一段        → 约 200 字符，且是它唯一需要的
 * ```
 * 这正是 `headOfMarket` 那段注释里说的同一件事：**材料要按"谁需要什么"给，
 * 而不是"有什么就给什么"**。
 *
 * ## 拿不到时**必须说"拿不到"**，不能返回空串
 *
 * 汇报员的提示词里写着「不许替你判断不了的事下结论」「数据不足就明说」。
 * 若这里返回 `''`，模型看到的是"账户那一栏是空的" ——
 * 它要么跳过第一个问题（于是操作员以为账户没问题），要么凭别的线索编一个。
 * 所以返回一句**明确的事实**：「这一轮的材料里没有账户段」。
 *
 * ⚠️ 判据用 `^# 账户`（行首锚定）——与 `headOfMarket` 找候选段同一纪律：
 * 正文里偶然出现的 `# 账户` 不该被当成小节标题。
 *
 * @param marketContext 完整市场材料
 * @param maxChars 摘出来的上限（**必须有上限**：材料是外部输入，长度不可控）
 */
export function accountSnapshot(marketContext: string, maxChars = 600): string {
  const NOT_FOUND = '（这一轮的材料里没有账户段 —— 这一项数据不足，不要推测）';
  const head = /^# 账户[^\n]*$/m.exec(marketContext);
  if (head === null) return NOT_FOUND;
  const from = head.index;
  /*
   * 到**下一个一级小节**为止（账户段的正文里不会有 `# ` 开头的行）。
   * 找不到下一个标题时就取到材料末尾，再由 `maxChars` 收口。
   */
  const rest = marketContext.slice(from + head[0].length);
  const next = /^# /m.exec(rest);
  const body = next === null ? rest : rest.slice(0, next.index);
  const text = `${head[0]}${body}`.trim();
  if (text.length === 0) return NOT_FOUND;
  /*
   * ⚠️ 截断时**明说被截断** —— 与 `headOfMarket` 的「本节因预算截断」同一条纪律：
   * 一份被悄悄砍掉的材料会让模型以为"账户信息就这么多"。
   */
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n（账户段因长度上限截断）`;
}

/**
 * **汇报员这一轮要看的"事实"**（2026-10-13）。
 *
 * 刻意只有计数与状态，**没有一行市场数据** —— 见 `renderReportMaterial`。
 */
export interface ReportFacts {
  /** 账户段（来自 `accountSnapshot`）。 */
  account: string;
  analyses: ReadonlyArray<{ role: string; ok: boolean; error?: string }>;
  bull: { ok: boolean; error?: string } | null;
  bear: { ok: boolean; error?: string } | null;
  verdict: { ok: boolean; error?: string } | null;
  /** 从裁决里抽出来的决策数组（`null` = 没抽到）。 */
  decisions: unknown[] | null;
  callsUsed: number;
  maxCalls: number;
  truncatedByBudget: boolean;
}

/**
 * **把"这一轮的事实"渲染成汇报员的材料**。
 *
 * ## 为什么必须是纯函数
 *
 * 因为它的**唯一职责是"不把大材料放进去"**，而那条性质只能靠"材料有多长"
 * 来验证。做成纯函数，测试就能直接断言"喂它 13 万字符的市场材料，
 * 产出的材料仍然只有几百字符" —— 而如果它藏在 `runTradingDeskInner` 里，
 * 就只能起一整个会议去间接观察。
 *
 * ## 为什么给"动作分布"而不是把决策数组原样贴进去
 *
 * 汇报员的任务是**压缩与排序**（它的提示词原话：「你的价值是压缩与排序」）。
 * 12 条决策的完整 JSON 约 1,500 字符，而操作员真正要的是
 * 「12 条，全是 skip」这一句话。把数组贴进去等于**让它把刚压缩过的东西
 * 再压缩一遍**，还多花 token。
 *
 * ⚠️ **但"抽不到数组"这件事必须如实写出来**：那是 `deskOutput` 里
 * `no-block` / `bad-json` 两个不同的失败，而它们会让整轮变成"不行动"。
 * 汇报员若看不到这一点，就会把它讲成"团队决定观望" ——
 * 那正是本项目反复记录的"看不出异常的失败"。
 */
export function renderReportMaterial(f: ReportFacts): string {
  const okOf = (r: { ok: boolean; error?: string } | null): string =>
    r === null ? '没有跑' : r.ok ? '成功' : `失败（${r.error ?? '未知原因'}）`;

  const failedAnalysts = f.analyses.filter((a) => !a.ok);
  const lines: string[] = [
    '## 账户（来自本轮材料）',
    f.account,
    '',
    '## 团队各角色结果',
    `- 分析师：${f.analyses.filter((a) => a.ok).length}/${f.analyses.length} 成功` +
      /*
       * ⚠️ **失败原因必须带上**（不只是角色名）—— 汇报员的提示词要求
       * 「若某个角色失败了，就说"它失败了"，而不是"信息有限"」。
       * 只给一个角色名，它能写的只有"某角色失败了"；给了原因，
       * 它才能写出"技术面分析超时未返回"这种**操作员能据此行动**的话。
       */
      (failedAnalysts.length > 0
        ? `；失败：${failedAnalysts.map((a) => `${a.role}（${a.error ?? '未知原因'}）`).join('、')}`
        : ''),
    `- 做多论证：${okOf(f.bull)}`,
    `- 做空/不行动论证：${okOf(f.bear)}`,
    `- 裁决：${okOf(f.verdict)}`,
    '',
    '## 这一轮的决策',
  ];

  if (f.decisions === null) {
    /*
     * ⚠️ 与 `deskOutput.extractFirstJsonArray` 的两种失败对齐：这里只知道
     * "抽不到合法数组"，而那意味着**本轮不会有任何动作**（执行层会按"不行动"处理）。
     */
    lines.push(
      '- ⚠️ **裁决里没有可解析的决策数组**（模型可能只写了散文，或数组被输出预算截断）。',
      '  这一轮按"不行动"处理 —— 请如实汇报这件事，不要替一个系统故障编一个正常的理由。',
    );
  } else {
    const counts = new Map<string, number>();
    for (const d of f.decisions) {
      const action =
        typeof d === 'object' && d !== null && 'action' in d
          ? String((d as { action: unknown }).action)
          : '（无 action 字段）';
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
    const dist =
      counts.size === 0
        ? '（空数组）'
        : [...counts.entries()].map(([a, n]) => `${a} ${n} 条`).join('、');
    lines.push(`- 共 ${f.decisions.length} 条：${dist}`);
  }

  lines.push(
    '',
    '## 预算',
    `- 模型调用 ${f.callsUsed}/${f.maxCalls}` +
      (f.truncatedByBudget ? '（**本轮因预算/轮次上限提前收尾**）' : ''),
  );
  return lines.join('\n');
}

/**
 * 跑一次交易台会议。
 *
 * @param input.ask 问某个角色的函数（真实实现走 `ModelRouter`，测试可注入桩）
 * @param input.marketContext 市场材料（行情、候选池等的结构化文本）
 * @param input.newsContext 新闻/情绪材料（可为空 —— 没配搜索时就是空的）
 * @param input.positionContext 持仓与账户材料
 * @param input.onStep 每一步的回调（**可观测性**：让界面看得见团队在做什么）
 *
 * ── ⚠️ **它同时是一个"资源关键区"**（2026-10-13 加）──────────────────────
 *
 * ## 为什么（一次实测定位到的真因）
 *
 * 服务器是 **2 核 / 1.9GB**（可用常驻内存仅 ~740MB），而线上同时跑着：
 * ```
 *   ① 后台调研：每 10 分钟一轮，起 claude code 进程（每个约 95–250MB）
 *   ② 这次决策：4 个分析师并发
 * ```
 * 症状：
 * ```
 *   technical：失败 —— 角色 technical 超过 120 秒未返回
 * ```
 * **而我在空载时单独实测同一个任务只要 10–13 秒**（4 个并发一起也只要 16 秒）。
 * 差别只有一个：**线上同时还有后台调研在抢 CPU**。
 *
 * ## 所以：决策期间**调研让路**
 *
 * `runOutsideCritical()` 会让后台调研等到这里结束（见 `resourceGate.ts`）。
 * 优先级是**业务定的**：决策是"要花钱/赚钱的那个动作"，
 * 调研是"下一轮才用到"的准备 —— 它晚 30 秒没有任何损失。
 *
 * ⚠️ **`finally` 不能省**：若一次异常就让计数永远 > 0，
 * 后台调研会**再也不会运行** —— 那是"安静地停掉一个功能"的失败，
 * 而它不会报错、界面上也看不出来。
 */
export async function runTradingDesk(input: Parameters<typeof runTradingDeskInner>[0]): ReturnType<typeof runTradingDeskInner> {
  enterCritical();
  try {
    return await runTradingDeskInner(input);
  } finally {
    leaveCritical();
  }
}

async function runTradingDeskInner(input: {
  ask: AskRole;
  marketContext: string;
  newsContext: string;
  /**
   * **本次调研给出的"可选情报键"** —— 裁决官只能从这里面标注依据。
   *
   * 见 `routedModel.ts` 的 `research` 与 `intel/attribution.ts`：
   * 校验"模型没编造情报来源"需要**这次真的给过它哪些键**。
   * 为空数组时裁决官**不标注**（而不是猜）。
   */
  availableIntelKeys?: string[];
  /**
   * **本轮候选标的数** —— 只用于让总管知道"有没有东西可分析"（2026-10-13）。
   *
   * ⚠️ **不传也能工作**：`tradingDesk` 会从 `marketContext` 里**数出**候选数
   *（数 `### N. SYMBOL` 标题）。这一条是**必须的** ——
   * 我第一版只留了这个字段而**没人传它**，于是总管永远看到"0 个候选"，
   * 它合理地判断"没东西可分析"→ **少派了分析师** →
   * 两个既有测试当场失败（`expected: 8, actual: 7`）。
   *
   * 传这个字段只是"调用方已经知道确切数字"时的快捷方式。
   */
  analystUniverseSize?: number;
  positionContext: string;
  limits?: { maxCalls: number; maxDebateRounds: number };
  onStep?: (step: { role: string; phase: string; note: string }) => void;
}): Promise<DeskOutcome> {
  const limits = input.limits ?? DESK_LIMITS;
  /*
   * ⚠️ **一开工就验预算自洽** —— 让"算术错误"在启动那一刻暴露。
   *
   * 实测踩过：`maxCalls=8` 配 `maxDebateRounds=2` 时，4+2×2=8 次用光，
   * **Judge 一次都没跑**，整轮没有结论。而那个症状看起来像"模型不听话"，
   * 从表面极难定位到"是算术错了"。
   */
  assertBudgetConsistent(limits);
  let callsUsed = 0;
  let truncatedByBudget = false;

  /** 统一的"还能不能再问一次"闸门 —— **P2 原则的落地点**。 */
  const canAsk = (): boolean => callsUsed < limits.maxCalls;
  const note = (role: string, phase: string, text: string): void => {
    input.onStep?.({ role, phase, note: text });
  };

  /*
   * ── ① **先问总管派谁**（2026-10-13 接线）────────────────────────────────
   *
   * ## 之前是什么样（用户需求 ① 的核心缺口）
   *
   * `firm.ts` 里总管的定义一直写着：
   * ```
   *   id: 'supervisor' · label: '总管' · tier: 'T3_deep' · status: 'staffed'
   *   duty: '统筹全局：派出调研员、指派分析师、决定要不要开会辩论'
   * ```
   * **而它从未发起过任何模型调用** —— 只有一句
   * `note('supervisor', 'dispatch', '派出 4 个分析师并行调研')` 日志标签。
   * 派谁干活由下面一行 `.slice(0, ...)` 写死。
   *
   * 也就是说：**`status: 'staffed'`（在岗）是虚的，
   * 而用户要的"最高智能AI担任最高统筹"从来没发生过。**
   *
   * ## 现在的分工
   *
   * · **代码守住硬边界**（预算 / 没新闻不派依赖新闻的角色 / 至少要有人干活）；
   * · **总管在边界内决定派哪些**（见 `dispatch.ts`）。
   *
   * ⚠️ 调用失败或解析失败时**退回全派** —— 与改动前行为一致（保守降级）。
   */
  const analystCandidates: AnalystCandidate[] = ANALYSIS_ROLE_DEFS.map((r) => ({
    role: r.role,
    /* 只有这两个角色的任务是"整理新闻" —— 没有新闻时它们只能编。 */
    needsNews: r.role === 'newscaster' || r.role === 'sentiment',
  }));
  let requestedRoles: string[] | null = null;
  /*
   * ⚠️ **候选数由材料自己数出来**（不依赖调用方传）——
   * 见 `analystUniverseSize` 的说明：我第一版只留字段而没人传值，
   * 于是总管永远看到 0，从而少派分析师。
   *
   * 数 `### N. SYMBOL` 标题 —— 那是 `prompt.ts` 渲染候选的固定形状。
   */
  const universeSize = input.analystUniverseSize
    ?? (input.marketContext.match(/^### \d+\. /gm) ?? []).length;
  /*
   * **总管的用量要单独留一份**（2026-10-17）。
   *
   * 它的产出**不进 `analyses`**（见下面那句：它不是分析师，输出是"派谁"），
   * 所以汇总时如果只看 `analyses`，**总管那一次调用就漏掉了**。
   */
  let supervisorOutput: DeskRoleOutput | null = null;
  if (canAsk()) {
    callsUsed += 1;
    try {
      const q = buildSupervisorPrompt({
        candidates: analystCandidates,
        hasNews: input.newsContext.trim().length > 0,
        positionCount: 0,
        symbolCount: universeSize,
      });
      /*
       * 总管的产出**不进 `analyses`** —— 它不是分析师，它的输出是"派谁"。
       * 用 `ask` 走同一条路由（于是档位、超时、降级都一致）。
       */
      const out = await safeAsk(input.ask, {
        role: 'supervisor',
        tier: 'T3_deep',
        context: q.user,
        task: q.system,
      });
      supervisorOutput = out;
      if (out.ok) {
        requestedRoles = parseDispatch(out.raw, analystCandidates.map((c) => c.role));
      }
    } catch {
      /* 拿不到决定 → `requestedRoles` 保持 null → 退回全派。 */
    }
  }
  const plan = planDispatch({
    candidates: analystCandidates,
    budget: Math.max(0, limits.maxCalls - callsUsed - 3 /* 给 Bull/Bear/Judge 留 3 次 */),
    hasNews: input.newsContext.trim().length > 0,
    requested: requestedRoles,
  });
  for (const s of plan.skipped) note('supervisor', 'dispatch', `不派 ${s.role}：${s.reason}`);
  note(
    'supervisor',
    'dispatch',
    plan.decidedBy === 'supervisor'
      ? `总管决定派 ${plan.roles.length} 个分析师：${plan.roles.join('、')}`
      : `派出 ${plan.roles.length} 个分析师并行调研（${plan.decidedBy === 'budget' ? '受预算限制' : '退回全派'}）`,
  );

  /*
   * ── **给拿大材料的两个角色一份【紧凑材料】**（2026-10-12 接线）──────────
   *
   * ## 为什么（实测数据）
   *
   * `#11` 四个分析师里**只有拿大材料的两个超时**：
   * ```
   *   market_analyst  材料 = marketContext（130,917 字符）  ❌ 超时 180s
   *   technical       材料 = marketContext（130,917 字符）  ❌ 超时 140s
   *   newscaster      材料 = newsContext（小）              ✅ 完成 55s
   *   sentiment       材料 = newsContext（小）              ✅ 完成 12s
   * ```
   * 而**模型本身不慢** —— 实测同一个路由组在小输入下只要 **2.2 / 5.2 秒**。
   *
   * ## ⚠️ 我第一版写错了（值得记下来）
   *
   * 第一版我写的是"**只给第一个标的**"（`composeSliceContext(shared, slices[0])`），
   * 理由是"它最小（9,227 字符）"。
   *
   * **那是错的**：`market_analyst` 的任务是"分析当前市场的**整体状态**"，
   * 而 `technical` 要"客观描述**指标与形态**" —— 只给一个标的，
   * 它们**看不到其余 11 个候选**，于是裁决官拿到的是一份
   * "只基于一个标的的市场判断"。
   *
   * **那是用"解决超时"换"信息缺失"，而且缺失是看不见的** ——
   * 角色会"正常完成"，只是它的结论建立在一份不完整的材料上。
   *
   * ## 正确做法：压缩，但**保留全部候选**
   *
   * ```
   *   原文                      130,917 字符
   *   压缩后（12 个候选全保留）  ~46,000 字符（小 2.8 倍）
   * ```
   * 压缩的是**冗余**（K 线只留最后 5 点、525 行概览裁到 60 行），
   * 而不是**候选数量** —— 后者是决策依据，不能动。
   *
   * ⚠️ **安全性质：切不出来时退回原文**（`compactMarketContext` 返回 `null`）——
   * **绝不给空材料或残缺材料**（那会让 agent 编造，而操作员看到的是"正常完成"）。
   *
   * ⚠️ 可用 `AQ_COMPACT_CONTEXT=off` 关掉（回到改动前的行为）。
   */
  const analystContext = (() => {
    if (process.env.AQ_COMPACT_CONTEXT === 'off') return input.marketContext;
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **`keepLast` 从 5 提到 10**（2026-10-13 线上实测）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 模型自己指出的问题（原文）
     *
     * `#11` 的裁决官在 `c103` 里写着：
     * ```
     *   「最大不确定性是**序列被截断（每周期省略前 25 根）**，
     *     看不到真实摆动低点/均量，**BLUR/ETH 的止损只能估算**」
     * ```
     * 而"止损只能估算"直接导致它拒绝开仓 —— 它的入场标准要求
     * "可执行的失效位"，而**估算出来的失效位不算可执行**。
     *
     * ## 量化代价（用线上真实材料测的）
     *
     * 单个候选（`OGNUSDT`，原文 11,867 字符，40 条序列 × 约 30 点）：
     * ```
     *   keepLast= 5 →  3,711 字符（31%）   ← 现状
     *   keepLast= 8 →  4,861 字符（41%）
     *   keepLast=10 →  5,626 字符（47%）   ← 改后（多 51% 材料）
     *   keepLast=15 →  7,338 字符（62%）
     *   keepLast=30 → 11,867 字符（100%，不压缩）
     * ```
     * **10 是"够算摆动低点"与"材料不失控"之间的取舍**：
     * ```
     *   5 个点 → 只能看出"最近在涨还是在跌"
     *   10 个点 → 能看出一两个摆动低点/高点（算止损要的）
     *   30 个点 → 完整，但材料回到 12k/候选（20 候选 = 24 万字符，必崩）
     * ```
     *
     * ## ⚠️ 为什么不是 15 或 30
     *
     * 材料规模直接决定**角色会不会超时/写不出内容**（本项目已踩过三次）：
     * ```
     *   6 标的（26,281 字符）→ 15.1s · content= 434 字  ✅
     *   12 标的（54,971 字符）→ mt=2048 时 content= 0 字  ❌
     * ```
     * 而 10 个点让每个候选从 3.7k 涨到 5.6k —— 6 个候选的材料从 39k 到 46k，
     * 仍在"能写出内容"的区间内。
     *
     * ⚠️ 这是**止血**，不是根治。根治是用户建议的**按币并行**
     *（每人一个标的 → 材料几百字符 → 那时可以给完整 30 个点）。
     */
    const compacted = compactMarketContext(input.marketContext, 10);
    /*
     * ⚠️ 切不出来（或一个标的都没有）时**退回原文** —— 不能给残缺材料。
     */
    if (compacted === null || compacted.slices.length === 0) return input.marketContext;
    /*
     * ── **限制分析角色看到的标的数**（2026-10-12，实测临界值）──────────────
     *
     * ## 决定性实测（同一模型、同一提示词，只变材料规模）
     *
     * ```
     *    0 个标的（ 5,455 字符 /  2,182 token）→ 14.8s · content= 340 字  ✅
     *    1 个标的（ 9,211 字符 /  3,684 token）→ 14.6s · content=1658 字  ✅ 最好
     *    3 个标的（16,039 字符 /  6,416 token）→ 13.0s · content=1006 字  ✅
     *    6 个标的（26,281 字符 / 10,512 token）→ 15.1s · content= 434 字  ✅
     *   12 个标的（55,011 字符 / 22,004 token）→ 17.3s · content=   0 字  ❌ 【崩了】
     * ```
     *
     * **临界点在 6–12 个标的之间。** 到 12 个时模型"只想不说"：
     * `content = 0 字`，而 `reasoning = 2,887 字`，`finish = length`。
     *
     * ## 为什么"崩了"比"慢"更糟
     *
     * `content = 0 字` 会让角色**判定为失败**（`empty_content`）→
     * 触发"加预算重试" → 重试本身要 47.5 秒 →
     * **首次 15.7s + 重试 47.5s = 63s > T1 的 60 秒超时线**
     * → **角色缺席 → 裁决官无行情依据 → 零决策**。
     *
     * ## 所以取 6（实测它能给出 434 字有效输出、15 秒完成）
     *
     * ⚠️ **这是有代价的**：分析角色看不到第 7 名之后的候选。
     * 但**"看 6 个并给出有效分析"远好过"看 12 个但一个字都写不出"**。
     *
     * ⚠️ 而**裁决官仍然拿到完整的 12 个候选**（它的材料没被裁剪）——
     * 决策依据没有变，变的只是"分析摘要基于前 6 个"。
     *
     * ⚠️ 可用 `AQ_ANALYST_UNIVERSE=12` 调回去（便于对照测试）。
     */
    /*
     * ── ⚠️ **默认 6 个候选 —— 我改过一次"全部"，实测证明那是我错了**
     * （2026-10-13，两次实测对照）────────────────────────────────────────
     *
     * ## 为什么我一度想改成"全部"
     *
     * 线上两位分析师都指出「材料标题写候选 12 个，但正文只列了 6 个」——
     * **它们是对的**，而这确实是个真问题（见下面"标题必须与内容一致"那段）。
     *
     * ## 但我用线上真实材料做的两次实测把这个改法否掉了
     *
     * ```
     *   12 个候选（36,583 字符）
     *     mt=2048  → 15.6s · content=   0 字  ❌
     *     mt=4096  → 27.2s · content=   0 字  ❌   ← 我一度把预算提到这里，仍然不行
     *     mt=8192  → 57.0s · content=   0 字  ❌
     *     mt=16384 → 115.9s · content=2206 字  ✅   ← 要 16K 才行
     * ```
     * **要 16K 预算、116 秒**才能让 12 个候选产出内容 —— 而那个耗时
     * 远超任何合理的角色超时（`T2_mid` 180 秒虽然够，但一整轮会因此变得极慢，
     * 且 16K 预算意味着单次调用成本是原来的 8 倍）。
     *
     * **所以"给 6 个"是对的取舍**：宁可少看 6 个，也不要"一个字都写不出"。
     *
     * ## 但"标题与内容不一致"必须单独修（那才是真正的 BUG）
     *
     * 裁候选没错，**错的是让材料标题仍然宣称"12 个"** ——
     * 那会让模型花力气去解释这个矛盾，甚至怀疑材料完整性。
     * 修法在下面：**裁剪时同步改写标题**（`AQ_ANALYST_UNIVERSE` 的说明里）。
     */
    const limit = Math.max(1, Number(process.env.AQ_ANALYST_UNIVERSE ?? '') || 6);
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **不能按顺序取前 N 个 —— 那会让分析师结构性瞎掉一整类候选**
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 真 BUG（2026-10-13 线上实测）
     *
     * `#11`（团队模式）**87 轮零开仓**，而 `#10`（单模型托管）是 209/571 = 36.6%。
     * 查材料结构发现：
     * ```
     *   ###  1–6   ai_requested  ← 前 6 个【全部】是它（GTC/OGN/W/CT/SKL/DOS）
     *   ###  7–14  coinpool      ← 后 8 个【全部】是它（BTC/ETH/SOL/ZEC/…）
     * ```
     * 而这里原来写的正是 `compacted.slices.slice(0, limit)` ——
     * **恰好等于"只看 ai_requested"**。分析师于是永远看不到主流币。
     *
     * 而 `#10` 那笔赚钱的开仓正是 **ETHUSDT（coinpool）**。
     *
     * ## 为什么会这样（两个各自正确的决定合起来错了）
     *
     * ```
     *   ① strategy/coins.ts:130  "ai_requested 先加 —— 顺序就是优先级"  ← 对
     *   ② 本处（实测 12 个候选 → content=0 字）→ 只取 6 个            ← 对
     *   合起来：ai_requested 占满前 6 个 → 分析师【永远只看那一类】
     * ```
     * 这是典型的**组合性缺陷**：两个决定单独看都对，谁都没想到会合起来出问题。
     *
     * ## 修法：按来源分层取样（见 `pickForAnalysis`）
     *
     * ```
     *   ✓ 保序（模型读起来仍是"从强到弱"）
     *   ✓ 每个来源至少 1 个（即使某个来源只占 1 个位置）
     *   ✓ 只有 1 种来源时，结果与 slice(0, limit) 完全一致（行为不变）
     * ```
     * ⚠️ 最后那条是它能安全上线的关键：只在"混合来源"时改变行为，
     * 而"混合来源"正是出问题的那种情况。
     *
     * ⚠️ 说明文字里的数字也要跟着改（否则又回到"标题与内容不一致"那个老问题）。
     */
    const { picked: useSlices, droppedBySource } = pickForAnalysis(compacted.slices, limit);
    /*
     * ⚠️ **裁剪后必须改写标题**（2026-10-13 加）。
     *
     * ## 为什么（两位分析师亲自指出的）
     *
     * 线上材料标题是「候选 12 个」，而正文只给了 6 个。分析师原文：
     * ```
     *   market_analyst：「我能看到的候选只有 1–6 … 第 7–12 个的摘要没有出现在
     *                    我这轮的材料里。没有的东西我不编 —— 那 6 个我无法点评。」
     *   technical：      「材料标题写"候选 12 个"，但正文只列了 6 个 …
     *                    这 6 个我无法评价——不是"不好"，是**数据不足**。」
     * ```
     * **它们诚实且正确**，但这件事本不该让它们去猜：材料自相矛盾是**我们的错**。
     *
     * ## 修法：把"被裁掉"这件事**明说在材料里**
     *
     * 在压缩后的共享段后面插一句**真实的**说明（而不是改一个数字）：
     * 分析角色只看到前 6 个 → 就写"为控制材料规模，这里只列出前 6 个候选；
     * 其余候选由裁决官在完整材料里看到"。
     * 这样模型既知道边界，也不会以为材料坏了。
     */
    /*
     * ⚠️⚠️ **必须删掉材料里那句"可以用 `get_klines` 点名要完整序列"**（2026-10-13）。
     *
     * ## 这是一个"系统给不了的承诺"（真 BUG）
     *
     * `prompt.ts` 渲染候选区块时写着：
     * ```
     *   **其余只给摘要**……而**任何一个你想深看的标的，都可以用 `get_klines`
     *   点名要完整序列**，不必它排前面。
     * ```
     * 那句话是**给单模型写的** —— 单模型（`autoTrader`）确实有工具循环
     *（`MAX_DATA_ROUNDS = 3`），它真的能调 `get_klines`。
     *
     * 而团队模式的四个分析师走的是**单次调用（`AskRole` → `complete()`）**，
     * **没有任何工具**。于是它们读到那句话之后的反应是（线上原文）：
     * ```
     *   market_analyst：「**我没有工具**，不能调 `get_klines`。所以我能做的分析，
     *                     严格限定在这 6 个标的上。」
     *   technical：     「**我没有任何工具，不能取数。**」
     * ```
     * **它们每轮都要花一段话去否定一个系统对它们做出的承诺** ——
     * 而那段话既浪费输出预算，又让它们对自己的边界产生不确定。
     *
     * ## 修法：换成"真实边界"
     *
     * ```
     *   ✗ 「你可以用 get_klines 点名要完整序列」   ← 对分析师是假的
     *   ✓ 「你看到的就是全部；没有列出的序列你无法获取」 ← 真的
     * ```
     * ⚠️ 而**裁决官**仍然看到完整材料（它不走这条路径），所以那句承诺
     * 对它成立 —— 这里只改分析师拿到的那一份。
     */
    const NO_TOOL_PROMISE = /而\*\*任何一个你想深看的标的，都可以用 `get_klines` 点名要完整序列\*\*，不必它排前面。/;
    /*
     * ⚠️⚠️ **候选区块的标题必须与"它实际收到的内容"一致**（2026-10-13）。
     *
     * ## 这是一个"材料自相矛盾"的 BUG（实测每轮都触发）
     *
     * `prompt.ts` 渲染的标题是：
     * ```
     *   # 候选标的（14 个）
     *   **前 10 个给出完整指标序列**；**其余只给摘要**（最新值 + 最近 5 根的走向）
     * ```
     * 而分析师**只收到 6 个切片**。于是它读到一个"说有 14 个、前 10 个完整"
     * 的标题，却只看到 6 个 —— 它的反应是**每轮都写一大段免责声明**（线上原文）：
     * ```
     *   market_analyst：「本轮材料只给了我 **6 个候选的完整指标序列**…另外 8 个
     *                     候选只有摘要。我**没有工具**，所以没法去补那 8 个的序列。」
     *   technical：     「本轮共有 **14 个候选**，但材料只给了 **6 个完整序列**…
     *                     另外 8 个本轮我没有序列，也没有它们的最新值。」
     * ```
     * **四个分析师每轮各写 200–400 字**去解释这个矛盾，而那些字**不产生任何
     * 交易判断**。更糟的是它让它们对自己的输入产生不确定（"我是不是漏了什么"）。
     *
     * ## 修法：把标题改写成"它实际拿到的那一份"
     *
     * ```
     *   ✗ # 候选标的（14 个）  **前 10 个给出完整指标序列**；**其余只给摘要**
     *   ✓ # 候选标的（本轮材料列出 6 个，均已给出完整指标序列）
     * ```
     * ⚠️ 这是**对已渲染文本做定点替换**（不是重新渲染）—— 与
     * `splitMarketContext` 的纪律一致：**不改渲染，只改这一份副本**。
     * 若格式变了导致替换不中，`replace` 是幂等的（原样保留），
     * 而下面那段 `truncationNote` 仍会说明取样规则 —— **不会静默给出错材料**。
     */
    const rewriteCandidateHeader = (text: string): string =>
      text.replace(
        /# 候选标的（\d+ 个）\n\*\*前 \d+ 个给出完整指标序列\*\*（[^）]*）；\*\*其余只给摘要\*\*（最新值 \+ 最近 5 根的走向）—— 那足够用来筛掉它们，/,
        `# 候选标的（本轮材料列出 ${useSlices.length} 个，均已给出完整指标序列）\n`,
      );
    const stripToolPromise = (text: string): string =>
      text.replace(
        NO_TOOL_PROMISE,
        '**你没有工具，看不到的序列就是拿不到的** —— 所以请只基于上面真正给出的内容做判断。',
      );
    const truncationNote =
      useSlices.length < compacted.slices.length
        ? `\n\n（说明：为控制材料规模，上面只列出 **${useSlices.length}** 个候选的完整序列；` +
          `本轮共有 ${compacted.slices.length} 个候选。` +
          /*
           * ⚠️ **把"按来源各留了代表"这件事明说**（2026-10-13）。
           *
           * 原来这里只写"其余 N 个在裁决官的完整材料里"。而修掉"按顺序截取"
           * 之后取样是按来源分层的 —— 模型看到"14 个候选只给了 6 个"时，
           * 会本能地怀疑"是不是把我需要的那类漏了"。明说取样规则能消除这个疑虑，
           * 也让它知道**边界在哪**（这仍然是数据边界，只是不再是"偏心的边界"）。
           */
          (Object.keys(droppedBySource).length > 1
            ? `取样的规则是**按来源各保留代表**（不是按顺序截取），所以你看不到的那 ${compacted.slices.length - useSlices.length} 个` +
              `分布在：${Object.entries(droppedBySource)
                .map(([k, v]) => `${k} ${v} 个`)
                .join('、')}。`
            : `其余 ${compacted.slices.length - useSlices.length} 个在裁决官的完整材料里。`) +
          /*
           * ⚠️ **不要让它写"数据边界"那一段**（2026-10-13 实测）。
           *
           * 原来的措辞是"并明确说明这是你的数据边界" —— 于是四个分析师
           * **每一轮都各写一大段"先说数据边界"**（实测 market_analyst 那段
           * 占 300+ 字，technical 也是）。那些字**不产生任何交易判断**，
           * 只是在对"我看到的不是全部"这件事做免责声明。
           *
           * 而边界**已经由这段说明写清楚了** —— 让它们再复述一遍是纯浪费。
           * 所以改成"不要复述边界，直接分析"。
           */
          `**不要在回答里复述这段边界说明**（它已经说清了）—— 直接基于上面这 ${useSlices.length} 个做分析。）`
        : '';
    /* **共享部分 + 前 N 个候选**（每个候选的 K 线已压到 5 点）。 */
    return rewriteCandidateHeader(
      stripToolPromise(
        [compacted.shared + truncationNote, ...useSlices.map((s) => s.text)].join('\n\n'),
      ),
    );
  })();

  const analysisRoles: Array<{ role: string; tier: ModelTier; context: string; task: string }> =
    ANALYSIS_ROLE_DEFS.map((r) => ({
      ...r,
      /* 行情材料的两个角色用【压缩后】的材料（见 `analystContext` 的说明）；
         新闻材料的两个角色用原样（`newsContext` 本来就是小的）。 */
      context: r.contextKind === 'market' ? analystContext : input.newsContext,
    }));

  /* 总管已经决定了派谁（见上面的 `plan`）—— 这里只做"按计划过滤"。 */
  const affordable = analysisRoles.filter((r) => plan.roles.includes(r.role));
  /*
   * ⚠️ **只有"预算不足"才是 `truncatedByBudget`**（外部 issue #156）。
   *
   * 原来这一行是 `if (affordable.length < analysisRoles.length) truncatedByBudget = true;`
   * —— 把「**派得比满编少**」直接等同于「**预算截断**」。而"派得少"至少有
   * **三个互不相同**的原因：
   *
   *   1. **总管按行情主动少派**（`dispatch.ts:115` 的 `'总管认为本轮不需要'`）
   *      —— 那是**判断**，不是受限；
   *   2. **没有新闻材料**（`dispatch.ts:96` 的硬边界）—— 那是**防编造**的刻意行为；
   *   3. **调用预算不够**（`BUDGET_SKIP_REASON`）—— 这才是真正的"受限"。
   *
   * 三者被压进同一个标记，而它对操作员说的话是
   *「本轮因预算/轮次上限提前收尾 —— 结论是在受限条件下得出的」——
   * **只在第 3 种情况下成立**。
   *
   * 而 `deskOutput.ts:2177` 自己算过这笔账：**「一个总在响的告警等于没有告警。」**
   * 触发条件是"总管按行情少派" —— 那**每轮都可能发生**。于是这条告警会长期亮着，
   * 而真正因预算受限的那一次就淹没在噪音里。**假告警的真实代价是掩盖真告警。**
   *
   * ## ⚠️ 判据为什么不能是 `plan.decidedBy === 'budget'`
   *
   * 因为那是**死值**：`dispatch.ts:66` 的类型里有 `'budget'`，但代码从不返回它
   *（实测四种输入只出现 `fallback_all` 与 `supervisor`）。
   * 拿它当判据会让 `truncatedByBudget` **永远不置位** —— 等于把真告警一起关掉。
   *
   * 可靠信号只有 `plan.skipped` 里的理由，所以用导出的 `BUDGET_SKIP_REASON`
   *（两处共用一份字面量，避免改一处漏一处）。
   */
  if (plan.skipped.some((s) => s.reason === BUDGET_SKIP_REASON)) truncatedByBudget = true;

  callsUsed += affordable.length;
  /*
   * ── **用并发闸门，而不是无界 `Promise.all`**（2026-10-12 接线）──────────
   *
   * ## 现在只有 4 个分析师，为什么也要闸门
   *
   * 因为**这个数字会变**：用户已经提过"按币并行"（500 个标的、N 个 agent），
   * 而一旦分析角色变成"每个标的一个人"，无界 `Promise.all` 会**同时起 20+ 个**。
   *
   * 实测约束：**claude code 单进程约 250MB** —— 20 个并行 ≈ 5GB。
   * 用户说的"不限制并发"指的是 **magpie 侧**（模型调用），
   * **服务器侧的 CPU/内存是真实约束**（那是我们自己的机器）。
   *
   * ## 现在闸门给多少
   *
   * `AQ_ANALYST_CONCURRENCY`，默认 **4**。
   * · 4 个分析师时 → **等于无界**（行为与原来完全一致，没有副作用）；
   * · 将来变成 20 个标的时 → 自动变成"4 个一批"，**不需要再改这里**。
   *
   * ## 顺序与错误语义**必须保持**
   *
   * `mapConcurrent` 保证"结果与输入同序"（否则 `analyses[i]` 会对错角色），
   * 且单个失败只标记它自己（`safeAsk` 本来就不抛）。
   */
  /*
   * ⚠️ **必须挡住非数字**（外部 issue #154）。
   *
   * 原来是 `Number(process.env.AQ_ANALYST_CONCURRENCY ?? 4)` —— `??` 只挡
   * `undefined`，挡不住"填了一个非数字"：`AQ_ANALYST_CONCURRENCY=abc` → `NaN`。
   *
   * 而 NaN 会一路传到 `mapConcurrent`，在那里让"钳制"失效
   *（`Math.max(1, NaN)` 仍是 NaN）→ **0 个工人** → 稀疏数组 →
   * `deskOutput.ts:275` 的 `for (const a of outcome.analyses)` 解引用 `undefined.role`
   * 抛 `TypeError` → 冒到 `runCycle` 的 catch → **每一轮都失败** → 进 `safe_mode`。
   *
   * 对比同文件 `:1219` 的 `Number(... ?? '') || 6` 与 `manager.ts:842/864` 的
   * `Number.isFinite` 守卫 —— 这里原来是**唯一的例外**。
   *
   * 两层都修：`mapConcurrent` 自己也挡住了 NaN（它是公用件），
   * 而这里给出**语义正确的默认值**（分析师并发 4），而不是让它降级成串行 1。
   */
  const requestedConcurrency = Number(process.env.AQ_ANALYST_CONCURRENCY);
  const concurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency >= 1
    ? Math.floor(requestedConcurrency)
    : 4;
  const analysisResults = await mapConcurrent(affordable, concurrency, async (a) => {
    /*
     * ⚠️ **必须走 `safeAsk`**（2026-10-12 实测踩到）。
     *
     * 原来这里直接 `input.ask(a)` + 自己的 try/catch ——
     * 于是**角色级超时对它不生效**（超时是在 `safeAsk` 里做的）。
     *
     * 后果实测可见：
     * ```
     *   [analysis] technical：完成（398758ms）      ← T1 档，超时该是 60 秒
     *   [analysis] market_analyst：完成（400858ms）
     * ```
     * **一个分析师跑了 398 秒**，而整轮就是被它拖到 7 分钟以上的。
     *
     * 而 `technical` 是 T1（"体力活"档）—— 它花 398 秒**本身就是异常信号**，
     * 正是角色超时要拦的那种情况。
     */
    const out = await safeAsk(input.ask, a);
    note(a.role, 'analysis', out.ok ? `完成（${out.latencyMs}ms）` : `失败：${out.error ?? '未知'}`);
    return out;
  });

  const analyses: DeskRoleOutput[] = analysisResults.map((r, i) => {
    if (r.ok) return r.value;
    /*
     * `mapConcurrent` 只在 `fn` **抛错**时才给 `ok: false` ——
     * 而 `safeAsk` 是不抛的，所以这条分支理论上走不到。
     * 但**不能因此省略它**：省略会让类型上多一个 `undefined`，
     * 而且将来若有人去掉 `safeAsk` 的包装，这里会静默变成 `undefined` 角色。
     */
    const a = affordable[i]!;
    note(a.role, 'analysis', `抛错：${r.error}`);
    return {
      role: a.role, modelId: '（未调用成功）', data: null, raw: '', latencyMs: 0,
      ok: false, error: r.error,
    };
  });

  /*
   * ── ② 对抗论证：Bull 与 Bear 各自构建最强论证（**串行**，共享同一份材料）──
   *
   * ## ⚠️ 为什么**不再**把完整市场材料塞给辩论者（2026-10-12 实测修正）
   *
   * 原来这里直接拼 `input.marketContext` —— 而实测它的规模是：
   *
   * ```
   *   候选池按提示词预算从 22 个裁剪到 20 个（每个标的约占 7506 tokens）
   *   → 20 × 7506 ≈ 15 万 token
   * ```
   *
   * 于是**每个辩论者都要读 15 万字**，加上新闻、持仓、分析师产出 ——
   * 而 bull 与 bear 是**串行**的（共享材料、互相看得见），
   * 所以这一段的耗时是**两份 15 万字之和**。
   *
   * 用户对分工的设计意图恰恰相反：
   *
   * > 「总管委派子代理去做市场调研……**根据资料反馈给相应的智能体做处理，
   * >  资料整理、判断、决策**等等」
   *
   * **分析师的职责就是"资料整理"** —— 他们消化原始材料，
   * 辩论者应当基于**消化后的结论**论证，而不是把原始材料再读一遍。
   *
   * ## 现在的口径
   *
   * | 角色 | 拿到什么 |
   * |---|---|
   * | 4 个分析师 | **完整**市场材料（他们负责消化）|
   * | bull / bear | **压缩后的**市场材料 + 分析师产出 |
   * | judge | 分析师产出 + 双方论证 |
   *
   * ⚠️ **仍然保留一段市场材料**（而不是完全去掉）：
   * 辩论者需要能**核对事实**（"分析师说的那个支撑位到底是多少"）。
   * 只是不必是全文 —— 见 `DEBATE_MARKET_CHARS`。
   *
   * ⚠️⚠️ **必须用 `headOfMarket()`，不能 `slice(0, N)`** ——
   * 后者实测抓到"裁决官一个候选都看不到"（见 `headOfMarket` 的说明）。
   */
  const marketHead = headOfMarket(input.marketContext, DEBATE_MARKET_CHARS);
  /*
   * ⚠️⚠️ **裁决官必须能看到候选的完整序列**（2026-10-13 实测后的第二版修正）。
   *
   * ## 第一版修对了方向、但预算配错了
   *
   * 第一版用 `headOfMarket()` 替代 `slice(0, N)` —— 方向对了（按段落取），
   * 但实测发现：**一个【未压缩】的候选段就 11,993 字符**，而预算只有 12,000
   * → 仍然只覆盖 **1 个**候选。
   *
   * 根因：**辩论者拿到的是【原文】，而分析师拿到的是【压缩后】的**
   *（`compactMarketContext` 把每个候选从约 12k 压到约 3k）。
   * 给下游原文等于让它们重读一遍上游已经消化过的东西 ——
   * 那正是 `debateMaterial` 的注释里早就说过的"分工的反面"。
   *
   * ## 所以：给**压缩后**的材料（与分析师同一份）
   *
   * 实测：压缩后 12 个候选 = 36,583 字符，而 6 个候选 = 20,893 字符。
   * 预算提到 **24,000** 就能覆盖**前 6 个候选的完整序列** +
   * 概览头部（约 4,500）+ 分析师的产出摘要（每人 1,200 × 4）。
   *
   * ⚠️ **为什么是 6 个而不是 12 个**：那是与分析师**同一个裁剪口径**
   *（`AQ_ANALYST_UNIVERSE`，实测 12 个候选会让模型"只想不说"）。
   * 上游与下游看到**同一批证据**，才谈得上"核对"。
   * 而下面那句"其余 N 个你看不到"会把边界**如实说清**
   *（否则模型会以为"没数据"—— 而那正是裁决官上一轮的原话）。
   */
  const marketHeadForDebate = headOfMarket(analystContext, DEBATE_MARKET_FOR_JUDGE_CHARS);

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️ **按币并行分析**（`AQ_PER_SYMBOL=on` 才启用，默认关闭）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 用户的建议（2026-10-12 原话）
   *
   * > 「假设要分析 20 个，那就**并行 20 个子代理，同步进行一人分析一个，
   * >  分析完了以后汇总**」
   *
   * ## 为什么现状（共享材料）会失败
   *
   * 4 个分析师**共享一份** 46k 字符的材料（6 个候选 × 6k）：
   * ```
   *   · 太大 → 必须压缩 K 线序列（keepLast=10）
   *   · 压缩 → 模型抱怨「看不到真实摆动低点，止损只能估算」
   *   · 「止损只能估算」→ 不满足入场标准 → 每轮都 skip
   * ```
   * 按币并行的收益：每个标的给**完整序列**（不压缩，材料只有约 4k），
   * 模型能算出真实止损。
   *
   * ## 为什么默认关闭
   *
   * 它是**另一种编排形态**，与"4 个分析师共享材料"各有取舍（见 `perSymbol.ts`
   * 的注释）：按币并行**看不到别人**（跨币比较需要下游补偿），而现状能看到。
   * 所以先用环境变量切换，等实测数据说明哪种更好再定默认。
   *
   * ## ⚠️ 预算：按币并行的调用【不计入 `maxCalls`】
   *
   * `DESK_LIMITS.maxCalls` 管的是"团队角色"（总管/分析师/辩论/裁决/汇报），
   * 而按币并行是**分析层的另一种实现** —— 它替代的是`market_analyst` +
   * `technical` 那两个角色，不是"多问几个角色"。
   * 计入会让它挤掉裁决官（唯一决策者），那是本末倒置。
   *
   * ⚠️ 但**超时仍然生效**（每个标的走 `safeAsk`，见 `input.ask` 的实现）。
   */
  let perSymbolResult: PerSymbolResult | null = null;
  /*
   * **按币并行的用量收在这里**（2026-10-17）。
   *
   * `analyzePerSymbol` 只回传 `digests` / `failed` / `peakConcurrency`
   *（见 `perSymbol.ts:114-129`）—— 用量**不在它的返回形状里**，所以汇总时
   * 拿不到。而按币并行是**整轮里最大的一块**（实测 17–19 次调用/轮），
   * 漏掉它会让总额少掉一大半 —— 正是"只记了一部分"的形状。
   *
   * 解法是在**调用点**顺手收（那里正好拿得到 `safeAsk` 的返回值）。
   * ⚠️ 不改 `perSymbol.ts`：它的职责是"编排 + 解析"，不该替调用方攒账。
   */
  const perSymbolUsages: DeskRoleOutput[] = [];
  if (process.env.AQ_PER_SYMBOL === 'on') {
    const compactedForPerSymbol = compactMarketContext(input.marketContext, 30 /* 完整序列 */);
    if (compactedForPerSymbol !== null && compactedForPerSymbol.slices.length > 0) {
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  **Jev 初筛**（`AQ_JEV_PREFILTER=on` 才启用，默认关闭）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 为什么在"逐币分析之前"加这一层
       *
       * 按币并行会对**每个**切片发起一次 `symbol_scout` 深看调用。
       * 候选多的时候（实测 17–19 次/轮），其中相当一部分标的
       * 一眼就没有机会 —— 用 Jev 先花 ~1/300 的成本打分，
       * 只让前 N 个进大模型，省下的是**最贵的那一段**。
       *
       * ## ⚠️ 降级铁律（比省成本重要得多）
       *
       * Jev 是**实验功能**。它失败、返回半份、或"说都不值得"时，
       * **必须原样把全部切片交给 LLM** —— 绝不允许一个初筛组件
       * 把整个团队的分析对象掐成 0 个。
       *
       * 具体回落条件在 `jev.ts` 的 `prefilterSymbols` 里（有 5 条测试钉住），
       * 这里只负责：**拿结果、写 `runtime_logs`、把切片换掉**。
       *
       * ## 开关
       *
       * `AQ_JEV_PREFILTER` 未设置 → `readJevConfig().enabled === false`
       * → **不读环境变量以外的任何东西、一个请求都不发**，原路径逐字不变。
       */
      const allSlices = compactedForPerSymbol.slices;
      let slicesForLlm = allSlices;
      const jevConfig = readJevConfig();
      if (jevConfig.enabled) {
        /*
         * 喂给 Jev 的是**压缩后的摘要**，不是给 LLM 的完整序列：
         * · `compactSeriesLines(..., 5)` 把每个周期的 30 个点压到 5 个，
         *   而 headline（current_ema20 / current_rsi7 / 24h_change …）原样保留；
         * · 客户端还有 4000 字符的硬上限兜底。
         *
         * ⚠️ 绝不复用 `s.text` 原文：单个切片约 1 万字符，18 个就是 18 万，
         * 对 Jev 是浪费，也会让单次调用逼近它的输入上限。
         */
        /*
         * ⚠️⚠️ **在 digest 前面显式写一行"窗口判断"**（2026-10-18 实测后加）
         *
         * ## 为什么
         *
         * 实测 21 轮后发现 Jev 有**系统性追高**：保留组里 82% 的标的是
         * 24h |涨跌| > 10%（已经走完的行情）。例：
         * ```
         *   Jev 保留：QUSDT +56%  GTCUSDT +25%  BTWUSDT +16%  ETHUSDT -0.4%  NEARUSDT -1.5%  ICNTUSDT -19%
         *   而按团队的入场标准（D 0.8~3.5%、ATR ≤3.5%），6 个里只有 NEAR 可执行
         * ```
         * 原因不是 Jev 差 —— 我给的问题是「挑出**今天有波动**的标的」，而"波动大"
         * 在 24h 尺度上**同时包含**「刚启动」与「已经走完」。它分不清，而分不清是信息不足。
         *
         * ## 做法
         *
         * 把团队自己的判据**算好**放在 digest 最前面，让 Jev 不用自己推：
         * ```
         *   窗口判断：24h 涨跌 -1.51%（在合理区间内）· ATR 未知
         * ```
         * ⚠️ **这是"给 Jev 更多信息"，不是"让它算"** —— TypeSafe 官方明确说
         * Jev 的弱点是算术与计数，而"算好再喂"正是规避它的正确姿势。
         *
         * ⚠️ **只在能可靠解析出数字时才加这一行**；解析不出来就不加（宁可少一句提示，
         * 也不要给一个错的判断）。
         */
        const windowHint = (text: string): string => {
          /* 从 headline 里抠 `24h_change` 与 `atr_percent`（存在才用）。 */
          const pct = /24h[_ ]change[^-\d+]{0,10}([-+]?\d+(?:\.\d+)?)\s*%/i.exec(text);
          const atr = /\batr(?:14)?[_ ]?(?:percent|pct)?[^-\d+]{0,10}([-+]?\d+(?:\.\d+)?)\s*%/i.exec(text);
          if (pct === null && atr === null) return '';
          const parts: string[] = [];
          if (pct !== null) {
            const v = Number(pct[1]);
            if (Number.isFinite(v)) {
              /*
               * 团队的可执行窗口（来自策略）：位移 0.8%~3.5%。
               * 这里用 **24h 涨跌** 作代理（精确的 D 值在切片里，但格式不固定）——
               * 它足够区分"刚启动"（通常 <10%）、"已经走完"（>20%）、"死水"（<0.5%）。
               */
              const verdict =
                Math.abs(v) < 0.5
                  ? '几乎不动（无方向）'
                  : Math.abs(v) <= 10
                    ? '在合理区间内'
                    : '已大幅移动（机会可能已过去）';
              parts.push(`24h 涨跌 ${v >= 0 ? '+' : ''}${v.toFixed(2)}%（${verdict}）`);
            }
          }
          if (atr !== null) {
            const a = Number(atr[1]);
            if (Number.isFinite(a)) {
              const verdict = a <= 3.5 ? '可执行' : '过高（风险失控）';
              parts.push(`ATR ${a.toFixed(2)}%（${verdict}）`);
            }
          }
          return parts.length > 0 ? `窗口判断：${parts.join(' · ')}\n` : '';
        };
        const jevInputs: JevInput[] = allSlices.map((s) => {
          const digest = compactSeriesLines(s.text, 5);
          const hint = windowHint(digest);
          return {
            symbol: s.symbol ?? 'UNKNOWN',
            digest: hint === '' ? digest : `${hint}${digest}`,
          };
        });
        const picked = await prefilterSymbols(jevInputs, {
          enabled: true,
          topN: jevConfig.topN,
          minScore: jevConfig.minScore,
          baseUrl: jevConfig.baseUrl,
          model: jevConfig.model,
          /* ⚠️ 必须传 —— 不传则请求不带 Authorization，线上每轮 401（2026-10-18 实测）。 */
          apiKey: jevConfig.apiKey,
        });

        if (picked.applied && picked.keep.length > 0) {
          slicesForLlm = picked.keep.map((i) => allSlices[i]!);
          const highest = picked.highest === null ? '—' : picked.highest.toFixed(2);
          const lowest = picked.lowest === null ? '—' : picked.lowest.toFixed(2);
          /*
           * ══════════════════════════════════════════════════════════════════
           *  ⚠️⚠️ **一轮的判定必须写在一条日志里**（2026-10-18 实测修正）
           * ══════════════════════════════════════════════════════════════════
           *
           * ## 事故
           *
           * 原来写三行：
           * ```
           *   132633  [Jev] 20 个标的 → 保留 6 个 · 最高 0.61 最低 0.26 · 耗时 1482ms
           *   132634  [Jev] 保留：QUSDT AGTUSDT BRUSDT AVAUSDT BTWUSDT SANDUSDT
           *   132635  [Jev] 筛除：EPICUSDT(0.50) GTCUSDT(0.49) …
           * ```
           *
           * 而 `runtime_logs` 是**环形缓冲**（500 条 ≈ 100 分钟）。样本采集脚本每 30 分钟
           * 跑一次，靠"保留行 + 下一行筛除行"配对 —— 只要这中间被别的日志挤掉一行，
           * 那一轮就**永久采不到**了（实测：`seen` 记了 132634，132635 成了孤儿）。
           *
           * ## 现在
           *
           * 一行搞定，用 `|` 分隔两段：
           * ```
           *   [Jev] 保留：A B C | 筛除：X(0.46) Y(0.42) …
           * ```
           *
           * ⇒ 采集脚本只需**一行**就能拿到完整配对，不再怕被冲散。
           * ⇒ 数量/最高/最低/耗时另起一行（那是给人看的心跳，不参与判据）。
           */
          const keptNames = slicesForLlm.map((s) => s.symbol ?? 'UNKNOWN');
          const desc = [...picked.dropped].sort((a, b) => b.score - a.score);
          const shown = desc.slice(0, 12);
          const suffix = desc.length > shown.length ? ` …等 ${desc.length} 个` : '';
          const droppedText = shown.map((s) => `${s.symbol}(${s.score.toFixed(2)})`).join(' ');
          jevLog.info(
            `[Jev] 保留：${keptNames.join(' ')}` +
              (droppedText === '' ? ' | 筛除：（无）' : ` | 筛除：${droppedText}${suffix}`),
          );
          jevLog.info(
            `[Jev] ${allSlices.length} 个标的 → 保留 ${slicesForLlm.length} 个` +
              ` · 最高 ${highest} 最低 ${lowest} · 耗时 ${picked.elapsedMs}ms`,
          );
        } else {
          /*
           * **回落**：`slicesForLlm` 仍是全部切片（上面的赋值没发生）。
           * 这里必须留下一条 warn —— 否则线上只会看到"这轮变慢了 15 秒"，
           * 却不知道是 Jev 失败导致的。
           */
          jevLog.warn(
            `[Jev] ${jevFallbackText(
              picked.reason,
              allSlices.length,
              jevConfig.minScore,
              picked.highest,
            )} —— 回落到不筛（全部 ${allSlices.length} 个标的照常进 LLM）`,
          );
        }
      }

      const tasks = slicesForLlm.map((s) => ({
        symbol: s.symbol ?? 'UNKNOWN',
        context: [compactedForPerSymbol.shared, s.text].join('\n\n'),
      }));
      note('supervisor', 'dispatch', `按币并行：${tasks.length} 个标的，并发 4`);
      perSymbolResult = await analyzePerSymbol({
        tasks,
        ask: async (task) => {
          const out = await safeAsk(input.ask, {
            /*
             * ⚠️ **专属角色 `symbol_scout`（T3/team-judge），不是 `market_analyst`**
             *（2026-10-14，四轮线上实测后提档）。
             *
             * 挂在 `market_analyst`（T2/flash）下的四轮成功率：
             * ```
             *   1/20 → 2/20 → 4/20 → 5/20（失败全是"没有找到 JSON 对象"）
             * ```
             * flash 档的**格式服从性**是天花板；T3（team-judge 组）的
             * 输出契约服从性已被 `judge` 验证了 100+ 轮。
             * 逐币深看正是用户需求 ① 里"高智能模型做"的那类活。
             */
            role: 'symbol_scout',
            tier: 'T3_deep',
            context: task.context,
            /*
             * ⚠️⚠️ **必须逐字段写清输出契约**（2026-10-13 线上实测抓到的接线 BUG）。
             *
             * 第一版只写了"方向判断、信号强度、关键位、依据" —— 结果
             * **20 个标的全部解析失败**（`按币并行完成：成功 0 · 失败 20`）。
             *
             * 根因：`parseDigest` 要求一个**严格的 JSON 对象**（symbol/direction/
             * score/confidence/evidence/invalidates，缺一个字段就整体失败），
             * 而 task 里没有告诉模型这件事 —— 它自然输出了散文。
             *
             * 这与 `judge` 那条"先输出 JSON 数组再写理由"是**同一条纪律**：
             * 输出契约必须写进任务描述，不能指望模型猜。
             *
             * ⚠️ `invalidates`（失效条件）必填 —— 它防的是"谄媚"：
             * 没有失效条件的判断无法被推翻，也就无法被学习。
             */
            /*
             * ⚠️⚠️ **给"填好值的完整示例"，不给"字段说明"**（2026-10-13 两轮实测）。
             *
             * 第一版只写"方向判断、信号强度、关键位、依据" → 20/20 全失败（输出散文）。
             * 第二版写字段说明 → 19/20 失败 —— 它把字段说明当成模板而不是要填的表
             *（direction 是 undefined：输出里字段在、值没填）。
             *
             * 而 `judge` 用"先输出 JSON 数组 + 内联示例"稳定工作了 100+ 轮。
             * 所以这次直接给【一个填好值的完整示例】—— 模型模仿示例
             * 远比理解字段说明可靠（few-shot > 指令，对 flash 档尤其如此）。
             *
             * ⚠️ `<digest>` 标签与 `digest.ts` 的 `extractJson` 配套
             *（那里按 标签 > 围栏 > 全文 的顺序找 JSON）。
             * ⚠️ `invalidates`（失效条件）必填 —— 防谄媚：
             * 没有失效条件的判断无法被推翻，也就无法被学习。
             */
            task:
              '把你的分析写成一个 JSON 对象，放在 <digest> 标签里。\n' +
              '照这个例子填（值全部换成你这个标的的真实数据）：\n' +
              '<digest>\n' +
              '{"symbol":"OGNUSDT","direction":"bearish","score":35,"confidence":62,' +
              '"keyLevels":{"support":0.0311,"resistance":0.0388},' +
              '"evidence":"4H EMA20 0.0349 在价上方，15m MACD 柱 -0.00022 扩大，RSI7 41.3 低于 50；资金费 -0.018% 空头拥挤",' +
              '"invalidates":"15m 放量收回 0.0349 并站稳两根以上，或资金费转正收敛",' +
              '"dataGaps":[]}\n' +
              '</digest>\n' +
              '规则：direction 只能是 bullish/bearish/neutral/unclear 之一；score 与 confidence 是 0-100 的整数；' +
              '数据不足时 direction 用 unclear、把缺的写进 dataGaps —— 不要编。',
          });
          /* 用量先收着（`analyzePerSymbol` 的返回里没有它）—— 见 `perSymbolUsages`。 */
          perSymbolUsages.push(out);
          if (!out.ok) return { ok: false as const, text: '', error: out.error ?? '调用失败' };
          return { ok: true as const, text: out.raw };
        },
        concurrency: 4,
      });
      note(
        'supervisor',
        'dispatch',
        `按币并行完成：成功 ${perSymbolResult.digests.length} · 失败 ${perSymbolResult.failed.length}` +
          ` · 并发峰值 ${perSymbolResult.peakConcurrency}`,
      );
      /*
       * ⚠️ **失败原因必须逐条上报**（2026-10-13 实测踩到）。
       *
       * 只写汇总行（"失败 18"）把最有价值的信息丢了 —— 18 个为什么失败
       * 全都看不到，而那正是修它的唯一线索。逐条写 reason，
       * 审计日志里就能直接看到"摘要解析失败：缺 invalidates"还是
       * "模型未返回"还是"标的对不上" —— 三者的修法完全不同。
       */
      for (const f of perSymbolResult.failed) {
        note('supervisor', 'dispatch', `按币并行失败 ${f.symbol}：${f.reason}`);
      }
    }
  }

  const debateMaterial = [
    '## 市场（摘要 —— 与分析师看到的是同一份压缩材料）',
    marketHeadForDebate.text,
    ...(marketHeadForDebate.candidatesShown < marketHeadForDebate.totalCandidates
      ? [
          '',
          `（候选共 ${marketHeadForDebate.totalCandidates} 个，此处给了**前 ${marketHeadForDebate.candidatesShown} 个的完整序列** ——` +
            `其余 ${marketHeadForDebate.totalCandidates - marketHeadForDebate.candidatesShown} 个的指标序列**你没有**，` +
            '所以**不要因为看不到它们就说它们"没有数据"**；需要细节请问分析师的产出）',
        ]
      : []),
    '## 新闻与情绪',
    input.newsContext.length > 0 ? input.newsContext : '（本轮没有可用的新闻/情绪数据）',
    '## 持仓与账户',
    input.positionContext,
    /*
     * 分析师产出给**更长的窗口**（400 → 1200 字）——
     * 因为辩论者现在主要靠它：截得太短会让论证失去依据。
     */
    '## 分析师产出',
    analyses.map((a) => `- ${a.role}: ${a.ok ? a.raw.slice(0, ANALYST_DIGEST_CHARS) : `（失败：${a.error ?? '未知'}）`}`).join('\n'),
    /*
     * ⚠️ **按币并行的产出放在【分析师产出之后、辩论之前】**（2026-10-13）。
     *
     * 它是**另一种分析层的实现**（每个标的单独评估，完整序列）——
     * 辩论者与裁决官用它做"逐币核对"，而不是替代分析师的整体判断。
     *
     * ⚠️ 失败项必须显式列出（`perSymbol.ts` 的注释里写明了这条纪律）：
     * 否则下游会以为"这个币没被选中"，而真相是"它没分析成" —— 两者含义完全不同。
     */
    ...(perSymbolResult !== null
      ? [
          '## 按币并行分析（每个标的的独立评估，含完整序列）',
          perSymbolResult.digests.length > 0
            ? perSymbolResult.digests
                .map(
                  (d) =>
                    `- **${d.symbol}** ${d.direction}（强度 ${d.score} · 置信 ${d.confidence}）` +
                    (d.keyLevels?.support !== undefined || d.keyLevels?.resistance !== undefined
                      ? ` ｜ 支撑 ${d.keyLevels?.support ?? '-'} 阻力 ${d.keyLevels?.resistance ?? '-'}`
                      : '') +
                    `\n  依据：${d.evidence}` +
                    `\n  失效条件：${d.invalidates}` +
                    (d.dataGaps !== undefined && d.dataGaps.length > 0 ? `\n  数据缺口：${d.dataGaps.join('、')}` : ''),
                )
                .join('\n')
            : '（按币并行没有产出任何成功的摘要）',
          ...(perSymbolResult.failed.length > 0
            ? [
                '',
                `（以下 ${perSymbolResult.failed.length} 个标的**分析失败**，不是"被排除"：` +
                  perSymbolResult.failed.map((f) => `${f.symbol}（${f.reason}）`).join('、') +
                  '）',
              ]
            : []),
        ]
      : []),
  ].join('\n\n');

  let bull: DeskRoleOutput | null = null;
  let bear: DeskRoleOutput | null = null;

  for (let round = 0; round < limits.maxDebateRounds; round += 1) {
    /*
     * ⚠️ **bull 与 bear 【并行】**（2026-10-12 实测：原来串行白白多花一份时间）。
     *
     * ## 为什么可以并行（这是有前提的，不是随手改）
     *
     * 两者拿到的是**同一份 `debateMaterial`** —— 它在上面的循环之外算好，
     * **不包含** bull 或 bear 自己的产出。也就是说：
     *
     * ```
     *   bull 的输入 ──┐
     *                 ├── 都只依赖 debateMaterial（互不依赖）
     *   bear 的输入 ──┘
     * ```
     *
     * 既然谁都不需要等谁，串行执行就只是**白等一份时间**。
     *
     * ## 实测动机
     *
     * 整轮耗时在 **341–817 秒**之间波动（5.7–13.6 分钟），而辩论段是
     * **两个 T3 调用串行** —— T3 是最慢的档位。并行后这一段从
     * `t_bull + t_bear` 变成 `max(t_bull, t_bear)`。
     *
     * ## 预算的记账方式（改了但语义不变）
     *
     * 原来每问一个角色就 `callsUsed += 1` 并检查一次 `canAsk()`。
     * 并行时**先检查"两个都问得起吗"**，再一起问 —— 于是
     * `callsUsed` 的最终值与原来完全一致（都是 +2），只是**检查点提前**了。
     *
     * 边界：预算只剩 1 次时，原来会问 bull、然后 `canAsk()` 失败而跳过 bear；
     * 现在**两个都不问**并标记 `truncatedByBudget`。这个差别是刻意的 ——
     * 只有 bull 一份论证会让裁决官**只听到一方**，
     * 而调研明确指出"单边论证"是谄媚与偏见最典型的入口（arXiv:2509.23055）。
     * **宁愿不带论证下去裁决，也不要只带一方的。**
     */
    if (callsUsed + 2 > limits.maxCalls) {
      truncatedByBudget = true;
      note('supervisor', 'debate', '预算不足以同时问多空双方 —— 跳过辩论（不制造单边论证）');
      break;
    }

    callsUsed += 2;
    note('bull', 'debate', `第 ${round + 1} 轮：构建做多论证`);
    note('bear', 'debate', `第 ${round + 1} 轮：构建做空/不行动论证`);

    const [bullOut, bearOut] = await Promise.all([
      safeAsk(input.ask, {
        role: 'bull',
        tier: 'T3_deep',
        context: debateMaterial,
        task: '为做多构建**最强**论证，并明确写出你的失效条件（什么情况下这个论证不成立）。',
      }),
      safeAsk(input.ask, {
        role: 'bear',
        tier: 'T3_deep',
        context: debateMaterial,
        task:
          '为做空或**不行动**构建**最强**论证，并明确写出失效条件。' +
          '注意：**"现在不交易"是一个合法的结论**，不要为了给出观点而硬找理由。',
      }),
    ]);
    bull = bullOut;
    bear = bearOut;
  }

  /* ── ③ 裁决：唯一裁决者（P1）──────────────────────────────────────── */
  let verdict: DeskRoleOutput | null = null;
  if (canAsk()) {
    callsUsed += 1;
    note('judge', 'verdict', '汇总辩论并裁决');
    verdict = await safeAsk(input.ask, {
      role: 'judge',
      tier: 'T3_deep',
      context: [
        debateMaterial,
        '## 多空论证',
        `### 做多\n${bull?.raw.slice(0, 1200) ?? '（缺失）'}`,
        `### 做空/不行动\n${bear?.raw.slice(0, 1200) ?? '（缺失）'}`,
      ].join('\n\n'),
      task:
        /*
         * ══════════════════════════════════════════════════════════════════════
         *  ⚠️⚠️ **JSON 数组必须写在最前面**（2026-10-13 实测抓到）
         * ══════════════════════════════════════════════════════════════════════
         *
         * ## 事故（`#2552 c75`）
         *
         * 裁决官输出了正确的 13 条 `skip`，而线上落库的是：
         * ```
         *   ```json
         *   [
         *     {"symbol":"WUSDT","action":"skip","confidence":80,"reasoning":"急跌后短修复但1
         *   </team>
         * ```
         * **数组在第一个元素中间被截断** → `bad-json` → `decisions = []` → 零决策。
         *
         * ## 为什么会被截断
         *
         * 它把**推理写在前面、JSON 写在最后**，而输出预算（`ROLE_MAX_TOKENS.judge`）
         * 用尽时**从末尾砍** —— 于是被砍掉的正是那个数组。
         * 而**推理写多长是它自己决定的**（实测 1,171 字），预算总有可能不够。
         *
         * ## 修法：把数组提到最前（并明确说出来）
         *
         * 顺序变成：
         * ```
         *   ① JSON 数组（机器读的，必须完整）
         *   ② 结论 / 置信度 / 依据（人读的，可以长）
         * ```
         * 这样即使推理被砍，**数组也已经写完了**。
         *
         * ⚠️ 这比"把预算调大"更根本：预算总有上限，而**先写关键字段**
         * 让"被截断"这件事不再致命。
         *（两层都做：预算 4096→8192，同时把数组提到最前。）
         */
        '**先输出 JSON 数组，再写你的理由。** 顺序不能反 —— ' +
        '数组是机器读的，必须完整；理由可以长，但排在后面。\n\n' +
        '综合双方论证，给出**一个**结论。必须包含：' +
        '① 结论（开多/开空/不行动）② 置信度 ③ 关键依据 ④ **最大的不确定性与它的失效条件**。' +
        /*
         * ══════════════════════════════════════════════════════════════════════
         *  ⚠️⚠️ **入场门槛由策略师定，不由你定**（2026-10-14 实测抓到的根因）
         * ══════════════════════════════════════════════════════════════════════
         *
         * ## 事故：系统给的一句话压过了策略师的全部规则 → 40+ 轮零开仓
         *
         * 这里原来写的是：
         * ```
         *   「如果双方证据都不足，**"不行动"是正确答案** —— 不要为了给出观点而降低标准。」
         * ```
         * 而策略师（它有权定规则）写的 `entryStandards` 是：
         * ```
         *   「skip 的【唯一】合法理由是 (a) 无标的 ≥0.8% 位移 或 (b) 点差/深度不足。
         *     No other condition gates entry.
         *     若 (a) 满足 → 【必须】开仓，'选择不交易'是违规」
         *   decisionProcess：「不能因为'看起来要回调了'而跳过第二步 ——
         *                    那是叙事性理由，不是算术性理由」
         * ```
         *
         * **实测（`#11` `c127`）**：BLURUSDT 位移 **+2.43% ≥ 0.8% → 触发**，
         * bull 把算术过程写得很清楚 —— 而裁决官判 `skip`，理由
         * 「反弹追多是接飞刀，两边赔率都不成立」。
         * **那正是策略师明文禁止的"叙事性理由"。**
         *
         * ## 为什么它会听系统的而不听策略师的
         *
         * 因为**系统那句是一个"永远可用的借口"**：任何一轮它都能说"证据不足"。
         * 而策略师的规则是**可证伪的算术**（位移 ≥0.8% 就触发）——
         * 后者本该优先，但提示词里没人说这件事。
         *
         * ## 修法：系统不替策略师定门槛，只负责**要求它引用策略师的规则**
         *
         * ```
         *   ✗ 「证据不足就不行动」（系统定的门槛 —— 越权，且给了万能借口）
         *   ✓ 「按策略师的入场标准判断；要 skip 就必须说明它落在哪一条允许的理由里」
         * ```
         * ⚠️ 这**不是**让系统强制开仓（那是把规则搬回代码，违背用户需求 ③
         * "风格由智能体负责"）—— 而是**把"该听谁的"这件事写清楚**：
         * 门槛是策略师定的，裁决官可以**改**它（那是另一个岗位的职责），
         * 但不能**无视**它。
         */
        '⚠️ **入场门槛是策略师定的，不是你自己定的。** ' +
        '上面材料里有它写的入场标准（`entryStandards` / `decisionProcess`）—— ' +
        '判断时**按它的标准来**：如果它的标准说了"出现 X 就必须开仓"，' +
        '那么你**不能**用别的理由（"看起来要回调"、"赔率不成立"、"接飞刀"）拒绝。\n' +
        '要给出 `skip`，你**必须**在 `reasoning` 里说明它落在策略师允许的哪一条理由里；' +
        '若你认为策略师的标准本身是错的，**照它的标准执行**，' +
        '并把你的异议写进 `reasoning`（策略师会读到并可能改规则）—— ' +
        '**在规则被改之前，它就是规则**。' +
        '\n\n' +
        /*
         * ── ⚠️ **必须独立推理，不能只复读**（2026-10-12，真实调研的结论）────────
         *
         * 调研来源：[Peacemaker or Troublemaker, arXiv:2509.23055](https://arxiv.org/html/2509.23055v1)
         *
         * 那篇论文实测出的失败模式之一正是**裁判的行为**：
         *
         * > 「有裁判时，裁判**"只复读、不做独立推理"**」
         *
         * 也就是说：让一个模型"汇总双方观点"时，它**倾向于把双方的话各抄一半、
         * 然后给个骑墙结论** —— 看起来像裁决，实际上**没有做任何判断**。
         * 而那正是"多智能体辩论"被质疑的核心原因之一。
         *
         * ## 所以这里用两个**可检验的要求**去逼它真的判断
         *
         * | 要求 | 为什么它能防"复读" |
         * |---|---|
         * | **明确写出你不同意哪一方、为什么** | 复读的人**写不出**这个 —— 它必须选边并给理由 |
         * | **如果双方都对，说明你依据什么做了取舍** | 逼它暴露**自己的判据**，而不是"综合来看" |
         *
         * ⚠️ 这两条是**提示词层面**的缓解，不是保证 —— 但它把"复读"从
         * "看起来合格的输出"变成了"明显不合格的输出"，从而**可被下游与操作员识别**。
         */
        '**你必须自己判断，不能只复读双方的话。** 具体地：' +
        '· 明确写出你**不同意哪一方**、以及为什么（如果某一方明显更弱）；' +
        '· 如果双方都有道理，说明你**依据什么做了取舍**（哪个证据权重更高、为什么）；' +
        '· 不要写"综合来看""两者都有道理"这类**不表态**的句子 —— 那等于没有裁决。' +
        '\n\n' +
        /*
         * ── **要求标注"依据了哪几条情报"**（2026-10-12，打通归因链第二段）──
         *
         * ## 为什么必须让模型标注（而不是代码猜）
         *
         * `intel/signalHealth.ts` 的失效检测（胜率崩塌 / 连续亏损 / **反应衰减**）
         * 需要"**由某个信号驱动的成交**"。而实测核查发现：
         * ```
         *   trades.source   → 只有 bot / reconciled
         *   open_reasoning  → 技术面理由
         *   Decision        → 没有情报来源字段
         * ```
         * **这条信息系统从未记录过** —— 所以失效检测一直是空转。
         *
         * ⚠️ 我**明确拒绝**了"用时间接近度猜"：归因一旦是猜的，
         * 失效检测会**基于假数据下结论** ——
         * 「"coindesk 利多"看起来在亏 → 判为失效」，而那些亏损其实与它无关。
         * **那比不接线更糟：它会自信地关掉一个好信号。**
         *
         * ## ⚠️ 只能从给定列表里选（防编造）
         *
         * 下面列出**这次真的给过它的键**，并明确"不许编"。
         * 校验在 `filterKnownIntelKeys()`：编造的键会被剔除并记日志 ——
         * 因为编造的键**永远只有 1 个样本**，会让归因数据**看起来比实际更丰富**。
         */
        ((input.availableIntelKeys ?? []).length > 0
          ? '**另外：每条决策必须标注它依据了哪几条情报。** 可选的键如下（**只能从这里选**）：\n' +
            (input.availableIntelKeys ?? []).map((k) => `  · ${k}`).join('\n') +
            '\n在 JSON 里用 `"intel_keys":["…"]` 标注（**空数组 = 这条决策是纯技术面的**）。\n' +
            '⚠️ **不要写不在上面列表里的键** —— 编造的情报来源会被剔除，而且它会让统计失真。\n\n'
          : '') +
        /*
         * ⚠️ **必须要求 JSON 数组**（2026-10-12 实测踩到）。
         *
         * 第一版只要求"给出结论"，没要求格式 → 裁决官输出的是**纯散文**
         *（实测：「结论：不行动。本轮不开多、不开空，也不挂入场限价单。」）。
         *
         * 而下游只从裁决文本里抽 JSON 数组（`extractFirstJsonArray`）→
         * 抽不到 → 触发两个连锁问题：
         *
         *   ① **风控官被跳过**（`decisions.length === 0` 时提前返回）——
         *      于是"风控由智能体负责"这条需求**静默失效**（日志里一次 risk 都没有）；
         *   ② 最终 `<decision>` 块是 `[]` —— **无论团队讨论出什么，都不会有任何动作**。
         *
         * 也就是说：整个团队跑了一轮，结论永远等于"什么都不做"。
         * 这是**功能性的致命缺陷**，而且从界面上看不出来（看起来像"模型决定观望"）。
         *
         * 所以这里把**输出格式写死**，并给出一个可照抄的样例。
         */
        '\n\n## ⚠️ 输出格式（必须遵守）\n' +
        /*
         * ⚠️ **"先给数组"**（2026-10-13）—— 见 task 开头那段说明：
         * 推理写在前面而预算用尽时，被砍掉的正是排在最后的数组。
         */
        '**第一步就输出 JSON 数组**（用 ```json 代码块或裸数组都行），然后再写理由：\n' +
        '```json\n' +
        '[\n' +
        '  {"symbol":"BTCUSDT","action":"open_long","leverage":3,"positionSizeUsd":100,' +
        '"stopLoss":60000,"takeProfit":70000,"confidence":70,"riskUsd":5,' +
        '"entryType":"market","reasoning":"一句话理由"}\n' +
        ']\n' +
        '```\n' +
        /*
         * ══════════════════════════════════════════════════════════════════════
         *  ⚠️⚠️ **止损必须在"保护"的那一侧 —— 这是 3 笔真实失败换来的**
         *      （2026-10-14 线上实测）
         * ══════════════════════════════════════════════════════════════════════
         *
         * ## 事故：止损挂反 → 订单被拒 → 立即市价平仓（白亏一次手续费）
         *
         * `#11` 实测 3 笔（`c153` / `c163` / `c165`）：
         * ```
         *   c163 QUSDT open_short: stopLoss = 0.048537
         *        而执行时的标记价 = 0.04901806
         *        → 空头止损应【高于】入场价，而它更低 → 挂上去立即触发 → 被拒
         *
         *   c165 TRUTHUSDT open_long: stopLoss = 0.022545
         *        而执行时的标记价 = 0.02180561
         *        → 多头止损应【低于】入场价，而它更高 → 同样被拒
         * ```
         * 下游的处理是**正确的**（不能用 `roundTriggerPrice` 把触发价挪到另一边 ——
         * 那等于悄悄放宽止损，`§4.2` 禁止）：它立即平掉仓位。
         * 但代价是**一次真实的手续费损失 + 这一轮的开仓机会**。
         *
         * ## 为什么团队模式特别容易犯这个错（而 `ai_managed` 不会）
         *
         * 对比实测：`#10`（`ai_managed`）**0 笔**，`#11`（团队）**3 笔**。
         * 差别在提示词 —— `strategy/prompt.ts` 里给了**镜像关系的完整范例**：
         * ```
         *   「注意止损/止盈的方向是镜像的：做空的失效位在上方（止损 > 入场）、
         *     目标在下方（止盈 < 入场）」
         * ```
         * 而团队模式的裁决官**只看到一个绝对数字的示例**（`60000` / `70000`），
         * 没有"该在入场价的哪一侧"这句话。
         *
         * ## 而且团队模式还有一个额外的坑：它看不到实时价
         *
         * 材料里的价格是**决策那一刻**的快照，而执行发生在几十秒之后 ——
         * 价格漂移足以让一个"贴着入场价"的止损翻到另一侧。
         * 所以这里不只说方向，还要求它**按百分比算**（用现价推算，而不是
         * 凭空写一个绝对数）。
         */
        '\n\n## ⚠️ 止损与止盈的方向（写错会导致这一单直接失败）\n' +
        '**做多**：止损**低于**入场价（价格跌到那里认输）、止盈**高于**入场价。\n' +
        '**做空**：止损**高于**入场价（价格涨到那里认输）、止盈**低于**入场价。\n' +
        '⚠️ **用你材料里那个标的的现价作为入场价基准**去算，不要凭记忆写一个数：\n' +
        '```\n' +
        '  做多止损 = 现价 × (1 − 止损百分比)     做多止盈 = 现价 × (1 + 止盈百分比)\n' +
        '  做空止损 = 现价 × (1 + 止损百分比)     做空止盈 = 现价 × (1 − 止盈百分比)\n' +
        '```\n' +
        '⚠️ **写之前自己核对一次方向**：做多的 `stopLoss` 必须小于 `takeProfit`；' +
        '做空的 `stopLoss` 必须大于 `takeProfit`。**写反了交易所会直接拒单**，' +
        '那意味着这一轮的判断白做、还要白付一次平仓成本。\n' +
        /*
         * ── ⚠️⚠️ **不许只给空数组 `[]`**（2026-10-13 实测后加强）──────────────
         *
         * ## 实测形状
         *
         * 近 12 轮的统计：
         * ```
         *   格式失败（模型没给 JSON）  2 轮（17%）
         *   给了但只输出 `[]`          **9 轮（75%）**
         *   逐候选给出（12 条 skip）   1 轮
         * ```
         * 那 9 轮的 `[]` **丢掉了整轮的评估信息** —— 团队跑了 8 个角色、
         * 讨论了 3 分钟，最后落地成两个字符。
         *
         * ## 为什么"逐候选"比"空数组"好得多（不是格式洁癖）
         *
         * | | `[]` | 逐候选 skip |
         * |---|---|---|
         * | 操作员能看到什么 | 什么都没有 | **每个标的为什么不做的理由** |
         * | 下一轮能参考什么 | 无 | 上一轮对同一标的的判断 |
         * | 失效检测能归因什么 | 无 | 哪个信号在哪些标的上反复出现 |
         * | 界面决策流 | 空 | 12 条带置信度的记录 |
         *
         * 而且 `skip` **本来就不是"开仓"** —— 逐候选 skip 与"不行动"在
         * **交易语义上完全等价**（都是不开仓），只是前者**留下了推理痕迹**。
         * 所以这条要求**不会**逼它开仓（那是我明确不想要的）。
         */
        '⚠️ **即使结论是"全部不行动"，也必须逐个候选给出一条 `skip`**（带置信度与理由）。\n' +
        '**不要只给空数组 `[]`** —— 那会丢掉你对每个标的的判断，' +
        '而操作员需要知道"哪些看了、为什么不做的"。\n' +
        '空数组只在**真的没有任何候选可评估**时才用。',
    });
  } else {
    truncatedByBudget = true;
    note('judge', 'verdict', '预算用尽，未能裁决');
  }

  /*
   * ══════════════════════════════════════════════════════════════════════
   *  ⚠️ **风控官不在这里接线 —— 它在 `routedModel.ts` 的 `askRiskOfficer()`**
   * ══════════════════════════════════════════════════════════════════════
   *
   * 我一度在这里加了一次 `risk_officer` 调用（以为"从未接线"），
   * 而实测核查后发现**它早已接线且逻辑正确**：
   * ```
   *   ① 没有决策要审（decisions.length === 0）→ 跳过（本轮本来就不行动）
   *   ② **全是 `skip` → 跳过**（"没有动作就没有风险敞口可审"）
   *   ③ 有真实动作 → tierForRole('risk_officer') 取档位，审阅后可否决/削减
   * ```
   *
   * ⚠️ **这里刻意不写行号。** 上面三条原先各自带了一个 `L###` 引用，
   * 而它们在写下之后全部过期了（真实位置早已漂移到另一处）——
   * 行号是**必然过期**的引用方式：任何人在这两个文件里增删一行，
   * 注释就在说谎，而**没有任何东西会报警**。所以改成指向
   * `routedModel.ts` 的 `askRiskOfficer()` 与 `NON_ACTION` 这两个**符号名**，
   * 它们随代码移动而移动。
   *
   * ⚠️ **档位是 `T2_mid`，不是 `T3`**（这里原写错成 T3，2026-10-13 更正）。
   * 判据是**两处独立声明一致 + 任务性质**，不是某一处的字面值：
   * ```
   *   firm.ts 的 FIRM_ROLES[risk_officer].tier = T2_mid
   *   routedModel.ts 的 ROLE_TIERS[risk_officer] = T2_mid
   *   → 两个文件各自声明、互相印证，且自引入角色路由起就是 T2（从未是 T3）
   * ```
   * 而任务性质也支持 T2：**它不构建论证，只审计一份已经结构化好的提案**
   *（待审决策的 JSON + 一句话理由），检查项是**枚举好的 5 条**（止损位置、
   * 方向、仓位、标的、时机）。这与 T3 档那几位（`supervisor` / `judge` /
   * `bull` / `bear` / `portfolio_manager` / `red_team` / `system_engineer`）
   * 的"从零构建最强论证、做唯一裁决、统筹全局"是两类活。
   * 输出预算同理：它拿 2048（分析类量级），而不是辩论/裁决的 4096–8192。
   *
   * ⚠️ 所以这条注释的正确写法是**断言一个不变量**，而不是抄一个数字：
   * `tierForRole('risk_officer') === 'T2_mid'` —— 见 `routedModel.test.ts`
   * 里那条"路由表与组织架构的档位必须一致"的用例（它就是这么钉的）。
   *
   * 所以线上那句「⚠️ 本轮**未经风控官审阅**」**不是 BUG** ——
   * 它的成因是**裁决官一直在输出全是 `skip`**（实测 40+ 轮零决策）。
   *
   * **如果在这里再加一次，就会变成"同一件事调用两次"** ——
   * 那正是本项目反复强调要避免的（同一个事实说两遍）。
   *
   * ⚠️ 而"风控官没跑"这件事**必须可见** —— 那一层已经由
   * `deskOutput.ts` 的 `<risk>` 块如实呈现（它在 `risk === null` 时写明原因）。
   */

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⭐ ④ **汇报员：把这一轮讲成人话**（2026-10-13 接线）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 为什么要有这一步（用户需求 ⑤ 的原话）
   *
   * > 「有主管、分析账户的，有调查新闻的、有监控社区的、有查市场情绪的、
   * >  **有维护系统的程序员、有汇报工作的、有文员**、有交易员、有风控员等等
   * >  一切专业交易所量化机构有的我们都要有」
   *
   * 而实测缺口是：交易循环里的**每个角色都在做判断，没有人把事情讲清楚**。
   * 操作员看到的是 8 个角色的原始产出（每个 1000+ 字推理），
   * 而他真正想知道的只有三件事：账户什么状态 / 团队做了什么、为什么 /
   * 有没有需要他介入的事。
   *
   * ## 位置：**裁决之后**，且**排在最后**
   *
   * 它要汇报的是**这一轮的结论**，所以在裁决之后；它不参与任何决策，
   * 所以排在最后。这两条合起来给出一个结构性保证：
   * ```
   *   汇报员的 canAsk() 检查发生在【裁决之后】
   *   → 预算不够时，被牺牲的永远是汇报员，裁决官【不可能】被它挤掉
   * ```
   * ⚠️ 这个顺序**就是**那条不变量，而不是靠算数保证 —— 见 `DESK_LIMITS.maxCalls`
   * 里关于"余量给谁"的说明。
   *
   * ## ⚠️ 为什么在 `tradingDesk` 里、而风控官在 `routedModel` 里
   *
   * 风控官的位置**必须在裁决之后、渲染之前**（那样它的否决才改得动决策）——
   * 所以它在 `routedModel.askRiskOfficer()` 里。而汇报员**不改任何决策**，
   * 它只需要"这一轮的事实"，而那些事实在这里全都有（各角色 ok/error、
   * 裁决的决策数组、账户段、预算用量）。
   *
   * 也就是说：汇报员在链路上的位置是"裁决之后、风控官之前"，
   * 而**这个差别对它是无所谓的** —— 它汇报的是团队做了什么，
   * 而风控官是否削减仓位是执行层的事（那一层有自己的 `<risk>` 审计块）。
   * 反过来，若为了"排在风控之后"而把它挪到 `routedModel`，
   * 它就得拿到 `DeskOutcome` + 风控结论两份东西 —— 那是**跨层的耦合**，
   * 而它并不需要那个信息。
   *
   * ## 失败不抛穿：**照 `safeAsk` 的纪律来**
   *
   * 与其它角色同一条路径（`safeAsk` 把异常与超时都转成 `ok: false`），
   * 所以这里不需要自己写 try/catch —— 自己写一个语义不同的版本，
   * 正是 `analystResults` 那段注释记录过的 BUG（角色级超时对它不生效）。
   *
   * ## 材料：**这一轮的事实，不是市场材料**
   *
   * 见 `renderReportMaterial`：只有计数、状态、账户段（约几百字符）。
   * 把 13 万字符的市场材料塞给一个"写 5 行摘要"的角色，
   * 既烧钱又会让它去复述它本该压缩的东西。
   */
  let report: string | null | undefined;
  /*
   * ⚠️ **汇报员的产出要单独留一份**（2026-10-17）。
   *
   * 下面那行 `report = out.ok ? out.raw : null` **把 `DeskRoleOutput` 丢掉了** ——
   * 于是它的用量也随之丢失。而它是 T1 档、每轮都会跑，漏掉它会让整轮总额
   * **系统性偏小**（也就是本条要防的"只记了一部分"）。
   * 所以额外记一个变量，只为了汇总用量时能带上它。
   */
  let reporterOutput: DeskRoleOutput | null = null;
  if (canAsk()) {
    callsUsed += 1;
    /*
     * ⚠️ 决策数组用**执行层同一个抽取器** —— 汇报员说"12 条，全是 skip"
     * 必须与最终真正执行的是同一份，否则它对操作员撒了谎。
     */
    const decisions = verdict?.ok === true ? (extractFirstJsonArray(verdict.raw).decisions ?? null) : null;
    note('reporter', 'report', '汇总本轮结果，写成人话');
    const out = await safeAsk(input.ask, {
      role: 'reporter',
      /* firm.ts 里汇报员就是这个档 —— 与 `TIER_BY_ROLE` 一致。 */
      tier: 'T1_fast',
      context: renderReportMaterial({
        account: accountSnapshot(input.marketContext),
        analyses,
        bull,
        bear,
        verdict,
        decisions,
        callsUsed,
        maxCalls: limits.maxCalls,
        truncatedByBudget,
      }),
      /*
       * ⚠️ 提示词用 `roles.ts` 里**已经写好的那一份**（含"5 行以内"、
       * "不许美化"、"不许替判断不了的事下结论"三条纪律）。
       * 在这里另写一段会让写好的那份永远到不了模型手里，而且两份会各自漂移。
       */
      task: ROLES.reporter.system,
    });
    report = out.ok ? out.raw : null;
    reporterOutput = out;
    note(
      'reporter',
      'report',
      out.ok ? `完成（${out.latencyMs}ms）` : `失败：${out.error ?? '未知'}`,
    );
  } else {
    /*
     * ⚠️ **不设 `truncatedByBudget`**（这是一个刻意的取舍）。
     *
     * 那个标志的含义是"**结论**是在受限条件下得出的"（`deskOutput.ts`
     * 据此渲染「本轮因预算/轮次上限提前收尾」）。而汇报员被跳过时，
     * 结论本身是完整的 —— 决策、辩论、裁决一个都没少。
     *
     * 把它置位会制造一个**假告警**，而假告警的代价在本项目里是明账：
     * 一个总在响的告警等于没有告警。所以"汇报员没跑"由 `report === undefined`
     * 与这条 `onStep` 如实表达。
     */
    note('reporter', 'report', '预算不足 —— 跳过汇报（它是附加动作，不挤占裁决）');
  }

  const okCount = analyses.filter((a) => a.ok).length;
  const summary = [
    `分析师 ${okCount}/${analyses.length} 成功`,
    bull?.ok ? '做多论证已出' : '做多论证缺失',
    bear?.ok ? '做空论证已出' : '做空论证缺失',
    verdict?.ok ? '已裁决' : '未裁决',
    report !== undefined && report !== null ? '已汇报' : '未汇报',
    `调用 ${callsUsed}/${limits.maxCalls}`,
  ].join(' · ');

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⭐ **整轮 token 汇总**（2026-10-17 补 —— 修"团队账目全空"）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 这一处必须收到【全部六段】的产出，一段都不能少
   *
   * | 段 | 收在哪 | 漏掉它会怎样 |
   * |---|---|---|
   * | 总管 | `supervisorOutput` | 它的产出**不进 `analyses`**，只看 analyses 必漏 |
   * | 4 个分析师 | `analyses`（含失败项） | —— |
   * | 按币并行 17~19 次 | `perSymbolUsages`（调用点顺手收） | 那是整轮最大的一块，漏掉总额少一半 |
   * | 辩论 bull/bear | `bull` / `bear` | T3 档，单价最高 |
   * | 裁决 judge | `verdict` | T3 档 |
   * | 汇报员 reporter | `reporterOutput` | 它被转成了 `string` 存进 `report`，原始对象会丢 |
   *
   * ## 为什么"漏一段"是这次要防的那个错误本身
   *
   * `autoTrader.ts:3781-3783` 的纪律是：**这一轮的真实用量 ≠ 最后一次调用的用量**。
   * 而"少收一段"是同一个错误的另一种形态 —— 它不会报错，只会给出一个**偏小的数**，
   * 看起来完全正常。所以汇总点的形状（接收全部产出）比注释更难写错：
   * 漏掉任何一段，`sumRoleUsage` 的入参里就没有它。
   *
   * ## 失败/超时的角色
   *
   * 它们的 `usage` 是 `undefined`（`safeAsk` 的 catch 分支**不编造**用量），
   * 于是不计入 —— 但不能因此把整轮说成"不知道"。
   * 判据由 `sumRoleUsage` 给：**只报一个角色也算有账**（否则 26–28 次调用里
   * 总有几次失败，就永远记不上账）。
   */
  const usageTotal = sumRoleUsage([
    supervisorOutput,
    ...analyses,
    ...perSymbolUsages,
    bull,
    bear,
    verdict,
    reporterOutput,
  ]);

  return {
    analyses,
    bull,
    bear,
    verdict,
    callsUsed,
    truncatedByBudget,
    summary,
    report,
    usage: usageTotal.usage,
  };
}

/** 包一层：把抛错也变成 `DeskRoleOutput`（团队编排不该因为一个角色挂了整轮失败）。 */
/**
 * **每个角色的超时**（毫秒），**按档位**给。
 *
 * ## 为什么需要它（实测动机）
 *
 * 实测单角色延迟波动极大 —— **同一个角色、同一个档位**：
 *
 * ```
 *   newscaster：3.8 秒  ↔  164 秒
 *   sentiment ：4.5 秒  ↔  124 秒 / 242 秒
 * ```
 *
 * 而整轮的耗时是"最慢那个角色 + 辩论 + 裁决 + 风控"——
 * **一个 242 秒的角色能把整轮拖到 7 分钟以上**（实测 341–817 秒波动）。
 *
 * ## 为什么按档位给（而不是一个数）
 *
 * 档位的定义就是"这活有多难"：
 *
 * | 档位 | 活 | 超时 | 理由 |
 * |---|---|---|---|
 * | `T1_fast` | 打标、摘要 | **60 秒** | 体力活不该要 3 分钟；慢就是有问题 |
 * | `T2_mid` | 分析 | **120 秒** | 要写完整分析 |
 * | `T3_deep` | 辩论、裁决 | **180 秒** | 最难的判断，允许更久 |
 *
 * ## 超时之后怎么办
 *
 * 与其它失败**同一条路径**（`safeAsk` 的 catch）→ 该角色标记为失败，
 * 编排继续跑（`tradingDesk` 对失败角色有降级处理）。
 *
 * ⚠️ **这是"宁可没有它，也不要为它等"** 的取舍：
 * 一个超时的分析师只是少一份材料，而**整轮卡死 = 这一轮完全没产出**。
 */
/*
 * ⚠️ **导出是为了让测试能验证"预算与超时线的协调"**（2026-10-13）。
 *
 * `ROLE_MAX_TOKENS`（输出预算）与这里（超时线）是一对**必须互相协调**的值：
 * 预算太大 → 最坏耗时超过超时线 → 角色必然超时、整轮缺席。
 * 而它们分处两个文件，所以测试需要同时读到两者才能表达那个不变量。
 */
export const ROLE_TIMEOUT_MS: Record<string, number> = {
  /*
   * ── ⚠️ **T1 从 60 秒提到 120 秒**（2026-10-13 线上实测）──────────────────
   *
   * ## 线上真实失败
   *
   * ```
   *   technical（未调用成功）：失败 —— 角色 technical 超过 60 秒未返回（按档位 T1_fast 的超时）
   * ```
   * **而它并不是"慢角色"**：我早先的实测是 8.8s / 7.4s / 11.5s / **54.3s** ——
   * 四次里有一次已经贴到 60 秒的边上。线上材料和并发情况更差一点，就直接超时。
   *
   * ## 60 秒这个值的来历（以及它为什么错）
   *
   * 它当初是按"T1 = 快角色"设的，参照的是**前三次实测**（8–12 秒）。
   * 而那个样本**没覆盖最坏情况** —— 第四次 54.3 秒已经说明分布有长尾。
   *
   * ## 为什么提到 120 秒是可以接受的
   *
   * 超时的代价是**这个角色整轮缺席**（`technical` 缺席 → 裁决官拿不到指标客观描述
   * → 输出 `[]` → **决策 0 条**）。而多等 60 秒的代价只是整轮慢一点，
   * 且整轮本来就是 121–197 秒量级。
   *
   * ⚠️ 这与 `market_analyst` 那次是同一类错误：**用"典型值"设边界，
   * 而不是用"最坏情况"设边界**。
   */
  T1_fast: 120_000,
  /*
   * ── ⚠️ **T2 从 120 秒提到 180 秒**（2026-10-12 实测后改）────────────────
   *
   * ## 实测数据（`#11` 全部 analysis 日志，16 条）
   *
   * ```
   *   technical       完成 4 · 失败 0     ← T1，超时 60s
   *   sentiment       完成 4 · 失败 0     ← T1
   *   newscaster      完成 4 · 失败 0     ← T1
   *   market_analyst  完成 2 · 失败 2     ← 【唯一的 T2】，超时 120s
   * ```
   *
   * **失败率 50%，而且是唯一失败的角色。**
   *
   * ## 为什么只有它
   *
   * 它是**唯一用 T2 档**的角色，任务也最重
   *（"分析当前市场的整体状态与值得关注的结构" vs 另三个是"客观描述指标"
   *  / "整理事件卡" / "给情绪分"）。
   *
   * **后果不只是"少一份材料"**：它是"判断有没有机会"的核心角色 ——
   * 它缺席时裁决官没有行情依据，**实测连续 12+ 轮输出 `[]`（零决策）**。
   *
   * ## 为什么"提高超时"比"降档"更对
   *
   * 降档（T2 → T1）会让它用 flash 模型做最重的那个任务 ——
   * 那是**用质量换速度**，而它恰恰是决策链的上游。
   * 而 120 秒对"通读 8 个候选 + 给出市场状态"确实偏紧。
   *
   * ⚠️ **代价**：最坏情况下整轮多花 60 秒。
   * 但那比"零决策"好得多 —— 零决策意味着**这一轮完全没干活**。
   */
  T2_mid: 180_000,
  /*
   * ── ⚠️⚠️ **T3 从 180 秒提到 360 秒**（2026-10-13 线上实测）───────────────
   *
   * ## 实测：裁决官每轮都被切断
   *
   * ```
   *   c102  192s  ⚠️   c101  300s  ⚠️   c99  187s  ⚠️   （超时线 180s）
   * ```
   * 而每轮 `decisions_json` 都恰好 5 条 —— **那就是被切断的形状**。
   * 材料给了 20 个候选，它只评了前 5 个（后 15 个从没被评估过，
   * 含 SUIUSDT —— 而 `#10` 那笔赚钱的开仓正是 SUIUSDT）。
   *
   * ## 为什么是 360 秒（而不是 300）
   *
   * ```
   *   决策周期      30 分钟 = 1800 秒
   *   团队一轮实测  120–**300.4** 秒   ← c101 实测值
   * ```
   * ⚠️ 我第一版改成 300 秒，而 **c101 的实测值正是 300.39 秒** ——
   * 那是"贴着上限被砍"，与没有余量几乎一样糟（同一类错误的第三次）。
   * 360 秒给最坏情况留 20% 余量，且仍只占周期的 1/5。
   *
   * ⚠️ 与 T2 那次同一个理由：**用最坏情况设边界，不是用典型值**。
   */
  T3_deep: 360_000,
  T0_code: 30_000,
};

/**
 * 问一个角色，**失败与超时都不抛出**。
 *
 * 编排对"某个角色没产出"是有降级处理的（辩论/裁决都会标注"缺失"），
 * 所以这里把异常转成 `ok: false` 的结果对象，让编排继续走 ——
 * 而不是让一个角色的失败把整轮炸掉。
 */
/**
 * **算一个角色的超时**（按档位基准 + 输入规模缩放）。
 *
 * 抽成**纯函数**是为了能直接测它 —— 否则只能写一个"等 65 秒看会不会被砍"
 * 的测试，那会让门禁慢一分钟（而这条规则本身很简单）。
 *
 * 判据见 `safeAsk` 里的说明：**模型不慢，慢的是输入**。
 */
export function roleTimeoutMs(tier: string, contextChars: number): number {
  const base = ROLE_TIMEOUT_MS[tier] ?? 120_000;
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **"每万字符 10 秒"严重低估 —— 改成 60 秒**（2026-10-13 线上实测）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故：裁决官每轮都被超时切断，20 个候选只点评 5 个
   *
   * 线上实测（`#11`，`ai_latency_ms`）：
   * ```
   *   c102  192s   ← 超时线 180s  ⚠️
   *   c101  300s   ← 超时线 180s  ⚠️
   *   c99   187s   ← 超时线 180s  ⚠️
   *   c100  155s   ← 勉强没超
   * ```
   * 而**每一轮的 `decisions_json` 都恰好 5 条、`raw_response` 约 5.5k 字符** ——
   * 那个"恰好 5 条"就是**被切断的形状**（它写完第 5 条时超时了）。
   *
   * ## 而材料里给了 20 个候选
   *
   * ```
   *   # 候选标的（20 个）· 全部含完整指标序列
   *   裁决官输出：OGN / ARC / W / BTC / ETH  ← 只评了前 5 个
   *   → 后 15 个（含 SUI/ENA/BNB —— 而 #10 那笔赚钱的开仓正是 SUIUSDT）
   *     【从来没被评估过】
   * ```
   *
   * ## 旧系数的来历（以及它为什么错）
   *
   * ```
   *   旧：每 1 万字符给 10 秒
   *   实测：23,325 字符的输入 → 需要 187–300 秒
   *         = 每 1 万字符约 80–130 秒
   * ```
   * 旧系数是**按"读得快"估的**（把字符数当成"读一遍的时间"），
   * 而真实成本是**逐候选做推理**（每个候选要看多周期指标、找失效位、
   * 算盈亏比、写理由）—— 那是**生成成本**，不是读取成本。
   *
   * ⚠️ 这与本项目记录过的两次是**同一类错误**：
   * ```
   *   market_analyst 用 1024/2048（典型值）设预算 → 思维链一长就 content=0
   *   technical      用 60 秒（前三次实测 8–12 秒）设超时 → 第四次 54.3 秒就超
   *   这里           用"读一遍"估超时 → 而真实成本是"逐候选推理"
   * ```
   * **共同点：用"典型/乐观值"设边界，而不是用"最坏情况"设边界。**
   *
   * ## 新系数：每 1 万字符 60 秒
   *
   * ```
   *   23,325 字符（judge 的典型输入）→ 基准 360 秒（T3）
   *   38,689 字符（market_analyst）→ 基准 180 秒（T2）
   * ```
   *
   * ## ⚠️ 上限从 300 秒提到 600 秒
   *
   * 旧上限 300 秒**恰好等于实测的最坏值**（c101 = 300.4 秒）——
   * 那是"贴着上限被砍"，与没有上限几乎一样糟。
   *
   * 600 秒的依据：整轮周期是 30 分钟，而团队一轮实测 120–300 秒。
   * 600 秒仍远小于周期，**不会让下一轮推迟**；而它给了最坏情况足够的余量。
   *
   * ⚠️ **这只是"止血"**。根治是**把输入变小**（用户建议的"按币并行"：
   * 每人一个标的，输入从 6 万字符降到几百字符）—— 那时这个缩放会自然回到基准。
   */
  const bySize = Math.round(contextChars / 10_000) * 60_000;
  return Math.min(Math.max(base, bySize), 600_000);
}
async function safeAsk(
  ask: AskRole,
  req: { role: string; tier: ModelTier; context: string; task: string },
): Promise<DeskRoleOutput> {
  const started = Date.now();
  /*
   * ── **超时按输入规模缩放**（2026-10-12 加）────────────────────────────
   *
   * ## 为什么固定超时是错的
   *
   * 实测（`#11`）：
   * ```
   *   user_prompt = 130,902 字符 ≈ 37,401 tokens
   *   team-grunt   小输入 2.2 秒   ← 模型本身不慢
   *   team-analyst 小输入 5.2 秒   ← 模型本身不慢
   *   但实际运行：technical 超时 60s · market_analyst 超时 180s
   * ```
   *
   * **模型不慢，慢的是"要读 3.7 万 token"。**
   * 而 `ROLE_TIMEOUT_MS` 是**固定值** —— 它假设每次输入都差不多大，
   * 而实际输入规模取决于候选池与材料量（会变）。
   *
   * ## 判据：按字符数线性放宽
   *
   * 取"每 1 万字符给 10 秒"作为**起步基准**，与档位基准取大者：
   * ```
   *   3 万字符  → 30 秒  → 与档位基准取大 → T1 仍是 60 秒
   *   13 万字符 → 130 秒 → T1 会放宽到 130 秒（而不是 60 秒被砍）
   * ```
   *
   * ⚠️ **这只是"止血"，不是根治。**
   * 根治是**把输入变小**（用户建议的"按币并行" —— 每人一个标的，
   * 输入从 13 万字符降到几百字符）。那时这个缩放会自然回到基准值。
   *
   * ⚠️ 上限 300 秒：不能让一个角色无限等下去（那会拖死整轮）。
   */
  const limit = roleTimeoutMs(req.tier, req.context.length);
  try {
    /*
     * `Promise.race` 而不是 `AbortSignal`：`AskRole` 的签名里没有 signal
     *（它是上层注入的接口），而这里只需要"不再等它" ——
     * 底层的 HTTP 请求会在 `ModelRouter` 自己的超时里被拆掉。
     */
    return await Promise.race([
      ask(req),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`角色 ${req.role} 超过 ${Math.round(limit / 1000)} 秒未返回（按档位 ${req.tier} 的超时）`)),
          limit,
        );
        /* 不因为这个定时器把进程吊住。 */
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    return {
      role: req.role,
      modelId: '（未调用成功）',
      data: null,
      raw: '',
      latencyMs: Date.now() - started,
      ok: false,
      error: (error as Error).message,
    };
  }
}
