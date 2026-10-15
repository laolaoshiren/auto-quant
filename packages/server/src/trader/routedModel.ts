/**
 * **决策模型路由器** —— 把 `ModelRouter` 适配成 `DecisionModel`，并承载交易台编排。
 *
 * ## 它在架构里的位置
 *
 * ```
 *   autoTrader.runCycleBody 第 7 步
 *         ↓  this.deps.model.complete(system, user)
 *   【本文件】DecisionModel 适配层
 *         ├─ 单模型路径：按档位选模型 → 失败自动降级
 *         └─ 团队路径：跑整个交易台 → 翻成 <decision> 格式
 *   ModelRouter → magpie 网关
 * ```
 *
 * ## 为什么团队编排放在这里，而不是改 `autoTrader`
 *
 * `autoTrader` 是**最安全攸关**的文件（10201 行）。考古报告认定的模型侧唯一接缝
 * 就是 `DecisionModel`（`autoTrader.ts:381-434`）—— 它只要求"给我一段文本"。
 *
 * 所以团队模式的全部复杂度（并行分析、辩论、裁决、格式翻译）**都关在这一层**：
 * `autoTrader` 完全不知道它在跟一个团队说话，它只是收到一段
 * `<decision>[...]</decision>`。**这就是"不碰交易循环"的具体形态。**
 *
 * ## 与 `ai_managed` 的关系：**零影响**
 *
 * 单模型路径（`createRoutedDecisionModel`）与团队路径（`createTeamDecisionModel`）
 * 是两个独立构造函数。智能托管用原来那个单客户端的适配器，一行都不用改。
 */

import type { Decision } from '@aq/shared';
import type { DecisionModel } from './autoTrader.js';
import type { ModelTier } from '../llm/modelCatalog.js';
import { ModelRouter, type CallModel } from '../llm/modelRouter.js';
import { runTradingDesk, type AskRole, type DeskOutcome, type DeskRoleOutput } from './agent/tradingDesk.js';
import { renderDeskOutcome, extractFirstJsonArray } from './agent/deskOutput.js';
import { parseRiskOfficerVerdict } from './agent/riskOfficer.js';
/*
 * ⚠️ 从 `loop.ts` 导入标记（单一来源）—— 不在两处各写一遍字面量。
 * 那正是 2026-10-15 那次事故的形状：`runToolLoop` 有标记、`runSingleShot` 漏了，
 * 于是后者被判成"交易决策"、跑整个交易台、永久失败。
 */
import { AGENT_CALL_MARKER } from './agent/loop.js';
/* ⚠️ 角色提示词的唯一来源 —— sk() 必须用它，否则那份长文到不了模型。 */
import { ROLES } from './agent/roles.js';
import type { AgentRole } from './agent/roles.js';

/** 一次「向模型提问」要用的档位与角色。 */
export interface RoleRequest {
  /** 角色名（用于日志与审计）。 */
  role: string;
  /** 该角色需要的能力档位。 */
  tier: ModelTier;
}

/**
 * 角色 → 档位的**默认映射**（设计文档 §二 的机器表达）。
 *
 * ## 为什么档位写在这里，而不是散在各角色实现里
 *
 * 用户要求「**每个智能体根据工作内容来制定用什么模型**」。
 * 把映射集中一处，好处是：**换档位只改一个地方**，
 * 而且能一眼看出"谁在用贵模型"（避免把 T3 浪费在体力活上 ——
 * 那是 Anthropic 实测的 15× token 成本来源）。
 */
export const ROLE_TIERS: Readonly<Record<string, ModelTier>> = {
  /* --- 需要顶级判断力的（T3）--- */
  supervisor: 'T3_deep',
  judge: 'T3_deep',
  bull: 'T3_deep',
  bear: 'T3_deep',
  portfolio_manager: 'T3_deep',
  red_team: 'T3_deep',
  /*
   * **系统工程师** —— 用户理想组织里点名要的「维护系统的程序员」。
   *
   * 由**自检的 AI 层**承担（每 30 分钟读一次运行证据、把线索连起来找缺陷）。
   * 用 T3 是因为"从日志与数字里看出问题"正是最需要判断力的活。
   *
   * ⚠️ 这一条是**被测试逼出来的**：我先把 `FIRM_ROLES` 里的 `system_engineer`
   * 标成 `staffed`，而路由表里没有它 —— 于是 `tierForRole()` 会静默回退到
   * T2（能跑，但"在岗"是虚的，且我写的 T3 假设不成立）。
   * `routedModel.test.ts` 里那条一致性断言当场抓住了它。
   */
  system_engineer: 'T3_deep',

  /* --- 主要分析工作（T2）--- */
  market_analyst: 'T2_mid',
  onchain_analyst: 'T2_mid',
  memory_curator: 'T2_mid',
  risk_officer: 'T2_mid',

  /*
   * **按币并行的侦查员**（2026-10-14 新增）。
   *
   * ## 为什么它是 T3 而不是 T2（用户需求 ① 的直接落地）
   *
   * 用户对分工的原话：「高智能的模型做什么，低智能的做哪些体力活」。
   * 逐币深看（一个标的的完整序列 → 方向/强度/关键位/失效条件）正是
   * "高智能"的那类活 —— 它的产出**直接进裁决材料**。
   *
   * ## 实测依据（为什么从 T2 提上来）
   *
   * 挂在 `market_analyst`（T2/flash 档）下跑的四轮：
   * ```
   *   成功 1/20 → 2/20 → 4/20 → 5/20（失败全是"没有找到 JSON 对象"）
   * ```
   * flash 档的**格式服从性**是天花板：同一批模型在 `<team>` 标签里
   * 能稳定输出 JSON 数组，裸输出/`<digest>` 标签就写散文。
   * T3（`team-judge` 组的最强模型）对输出契约的服从性显著更好 ——
   * `judge` 用"先输出 JSON 数组"的措辞稳定工作了 100+ 轮。
   */
  symbol_scout: 'T3_deep',

  /* --- 体力活：打标、摘要、抽取（T1）--- */
  newscaster: 'T1_fast',
  sentiment: 'T1_fast',
  technical: 'T1_fast',
  reporter: 'T1_fast',
  clerk: 'T1_fast',

  /* --- 不用 LLM（T0）--- */
  data_sentinel: 'T0_code',
  execution: 'T0_code',
  ops_watchdog: 'T0_code',
};

/** 取某角色的档位；未知角色保守给 T2（宁可稍贵，也不要让新角色没模型可用）。 */
export function tierForRole(role: string): ModelTier {
  return ROLE_TIERS[role] ?? 'T2_mid';
}

/**
 * **角色 → magpie 路由组**（2026-10-12 接线）。
 *
 * 这些组是第 43 轮按"工种"建的（`magpie group add`），当时**建了却没接线** ——
 * 于是角色走的是发现层自动排的链，实测 `market_analyst` 撞上
 * `group/auto-hy3`（思维链）→ 耗时 39s/121s/**
 * T1（体力活）的候选链 —— **组 + 兜底组**。
 *
 * 见 `ROLE_GROUP_LADDERS` 里"实测踩到"那段：单组一次 5xx 就让整档不可用。
 */
const T1_LADDER: readonly string[] = [
  'group/team-grunt',
  /* 兜底：分析组里也有快模型，能用就用（有产出好过没有）。 */
  'group/team-analyst',
  /* 再兜一层：新闻组是 3 对同名模型跨供应商配对，可用性最高。 */
  'group/team-news',
];
/**>180s** → 超时 → 零决策。
 *
 * ⚠️ **只列我验证过的三个**。其余角色保持原样（发现层自动排序）——
 * 一次全换会让我分不清"哪一处改动导致了什么"。
 */
export const ROLE_GROUP_LADDERS: Readonly<Record<string, readonly string[]>> = {
  /*
   * 唯一的 T2 分析角色。用 `team-analyst`（我按"分析"挑的
   * mimo-flash-free / deepseek-flash / nemotron-ultra，优选→兜底）。
   *
   * **关键：不用思维链模型** —— 实测 `group/auto-hy3` 的耗时波动太大
   *（39s / 121s / >180s），而它有 180 秒的硬超时。
   *
   * ⚠️ 后面挂了 `team-grunt` 作为**兜底** —— 见下面 `T1_LADDER` 的说明。
   */
  market_analyst: ['group/team-analyst', 'group/team-grunt'],
  /*
   * ── 按币并行的侦查员：要【最强 + 最听话】（2026-10-14 新增）──────────────
   *
   * ## 为什么绑 `team-judge`
   *
   * 1. 它是"最强模型"组 —— 逐币深看是高智能活（用户需求 ①）。
   * 2. `judge` 在这个组里用"先输出 JSON 数组"稳定跑了 100+ 轮 ——
   *    **输出契约服从性**已被验证，而那正是 flash 档的死穴
   *    （按币并行挂 flash 下四轮：1→2→4→5 / 20，失败全是格式）。
   *
   * ⚠️ 兜底挂 `team-analyst`（不是 team-grunt）：
   *    scout 失败的代价是"裁决官少一份逐币深看"，宁可稍慢也别没产出。
   */
  symbol_scout: ['group/team-judge', 'group/team-analyst'],
  /*
   * ── 体力活：要快 + 免费。**必须有兜底** ──────────────────────────────
   *
   * ## 实测踩到（2026-10-12）
   *
   * 我第一版只写 `['group/team-grunt']`，于是实测出现：
   * ```
   *   technical：失败：档位 T1_fast 的候选链全部处于冷却期（1 个模型）
   *             —— group/team-grunt(上游 5xx，先重试一次，仍失败则换)
   * ```
   *
   * **一个组 = 一个候选**，而**一次上游 5xx 就会让它进冷却** ——
   * 于是三个 T1 角色**同时**不可用（它们共用这一个组）。
   *
   * ## 为什么"组内还有模型"救不了
   *
   * `group/team-grunt` 组内确实有 3 个模型，但**组是网关侧的一个入口** ——
   * 网关返回 5xx 时，路由器看到的是"**这个候选失败了**"，
   * 它**不知道组内还有别的**，于是把整个组标成冷却。
   *
   * ## 修法：链上多挂几个组
   *
   * 依次尝试：`team-grunt` → `team-analyst` → `team-news`。
   * 它们分属不同供应商组合，**同时挂掉的概率远低于单个组**。
   *
   * ⚠️ 顺序有意义：`team-grunt` 最快最便宜，所以放第一；
   * 后面两个是"快慢不一但可用"的兜底 —— **有产出永远好过没有产出**。
   */
  technical: T1_LADDER,
  newscaster: T1_LADDER,
  sentiment: T1_LADDER,
};


/**
 * **档位 → 路由组**（角色没单独指定时的兜底）。
 *
 * ⚠️ T1 只给"体力活"组：那一档本来就该快。
 * **T3 不在这里绑** —— 辩论/裁决我还没验证过 `team-judge` 的实际表现，
 * 贸然换掉会让我分不清"是路由组变好了还是模型变好了"。
 */
const TIER_GROUP_LADDERS: Readonly<Record<string, readonly string[]>> = {
  T1_fast: ['group/team-grunt'],
};

/**
 * **按角色的输出 token 预算**（2026-10-12 加）—— 修"超时"的真正根因。
 *
 * ## 决定性实测（同一材料，只变 `max_tokens`）
 *
 * ```
 *   极短输入 + max_tokens=10    →  2.9 秒（completion 10）
 *   极短输入 + max_tokens=4000  →  4.3 秒（completion 161）  ← 它自己停
 *   单标的材料 + max_tokens=2000 → 20.5 秒 · completion=2000（【用满】）· content=0 字！
 *   单标的材料 + max_tokens=800  → 11.8 秒 · completion=800 （【用满】）· content=493 字
 *   finish_reason = "length"    ← 全部撞上限
 * ```
 *
 * ## 结论（推翻我之前的判断）
 *
 * 我一度认为"瓶颈是输入太大"。**实测数据否定了它**：
 * ```
 *   7,538 输入 token  → 41.3 秒
 *   45,326 输入 token → 65.2 秒     ← 输入差 6 倍，时间只差 24 秒
 * ```
 * **真正的瓶颈是【输出生成】**（约 50–100 token/秒）。
 * 而 `TEAM_BASE_MAX_TOKENS = 8192` 意味着**最坏要跑 80+ 秒** ——
 * 而 T1 角色的超时线是 **60 秒**：**它必然超时。**
 *
 * ## 更糟的是：这些 token 大多【不是有用内容】
 *
 * `max_tokens=2000` 那次：`reasoning_content = 4228 字`，而 **`content = 0 字`** ——
 * 全部预算花在推理上，**正式回答一个字都没写**。
 *
 * ## 分档原则
 *
 * | 角色类 | 预算 | 理由 |
 * |---|---|---|
 * | 分析师（`market_analyst` / `technical` / `newscaster` / `sentiment`）| **1024** | 任务是"描述与整理"，实测 800 就能给出 493 字有效内容 |
 * | 辩论与裁决（`bull` / `bear` / `judge`）| **4096** | 需要完整论证，且它们的超时线是 180 秒（更宽）|
 *
 * ⚠️ **这是"按任务给预算"，不是"砍能力"**。
 *
 * ⚠️ 未知角色退回调用方给的 `baseMaxTokens` —— **不改既有行为**。
 */
export const ROLE_MAX_TOKENS: Readonly<Record<string, number>> = {
  /*
   * ── ⚠️ **`market_analyst` 必须 2048，不能 1024**（2026-10-12 实测）───────
   *
   * 我第一版给了 1024（理由是"分析师是描述性任务"），但实测发现
   * **它恰好卡在临界点上**（同一组、同一提示词，只变预算与材料规模）：
   * ```
   *    6 标的（26,252 字符）mt=1024 → 11.7s · content= 779 字  ✅
   *    6 标的（26,252 字符）mt=2048 → 34.5s · content= 931 字  ✅
   *   12 标的（54,971 字符）mt=1024 → 16.5s · content=   0 字  ❌
   *   12 标的（54,971 字符）mt=2048 → 26.8s · content=3917 字  ✅ ← 2048 就够
   * ```
   * `content = 0 字` 会让角色判定失败 → 触发重试 → **白烧一轮**。
   *
   * ⚠️ 它是**唯一读全量候选**的角色（`technical` 读的是限流后的材料），
   * 所以预算要更宽。而 T2 的超时线是 **180 秒** —— 26.8 秒用得起。
   */
  /*
   * ── ⚠️⚠️ **`market_analyst` 从 2048 提到 4096**（2026-10-13 线上实测）──────
   *
   * ## 线上真实失败（`#11` 连续 6 轮，2026-10-13 21:22–21:58）
   *
   * ```
   *   market_analyst（未调用成功）：失败 —— 档位 T2_mid 的候选链全部处于冷却期（2 个模型）
   *     —— 已尝试：group/team-analyst(输出被 token 上限截断（思维链占满了预算）)
   *                group/team-analyst(同上)
   *                group/team-grunt(同上)
   * ```
   * **三个候选全部"输出被 token 上限截断"** —— 而 2048 是我上一轮认为"够了"的值。
   *
   * ## 为什么 2048 不够（我上一轮的测量有偏差）
   *
   * 我当时的实测是"12 标的 54,971 字符 → mt=2048 → content=3917 字 ✅"，
   * 于是判定 2048 够用。**但那是单次测量的运气**：
   * · 思维链长度**随材料波动**（同样的材料，模型每次想的长度不同）；
   * · 一旦思维链占满 2048，`content` 就是 **0 字** → 角色判定失败；
   * · 而失败会**让模型进 5 分钟冷却** → 重试时三个候选**全在冷却** → 角色直接缺席。
   *
   * 于是三个失败**串成一条链**：
   * ```
   *   预算不足 → content=0 → 判定失败 → 模型冷却 → 重试无处可去 → 分析师缺席
   *     → 裁决官只有噪声材料 → 输出 [] → **决策 0 条**
   * ```
   *
   * ## 为什么现在给得起 4096
   *
   * T2 的超时线已是 **180 秒**（`ROLE_TIMEOUT_MS`），而实测该角色用 2048 时
   * 耗时 26.8–34.5 秒 —— **离超时线还很远**。多给预算的代价只是多花一点输出 token，
   * 而收益是**角色不再缺席**（那是决策 0 条的直接原因）。
   *
   * ⚠️ 这与本项目那条纪律一致：**"够用"要用"最坏情况"验证，不是单次测量**。
   */
  market_analyst: 4096,
  /*
   * 其他分析师：材料已被限流。
   *
   * ⚠️ **从 1024 提到 2048**（2026-10-13）—— 与上面同一个理由：
   * `technical` 在线上也报过"输出被 token 上限截断"。它读的是限流后的材料，
   * 但思维链长度同样会波动，1024 的余量太薄。
   */
  technical: 2048,
  newscaster: 1024,
  sentiment: 1024,
  /* 其他"整理类"角色同样短输出。 */
  clerk: 1024,
  reporter: 1024,
  memory_curator: 1024,
  onchain_analyst: 1024,
  /* 辩论与裁决：需要完整论证。 */
  bull: 4096,
  bear: 4096,
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **`judge` 从 4096 提到 8192**（2026-10-13 实测抓到 —— 这是"零决策"的最后一环）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 实测现场（`#2552 c75`）
   *
   * 裁决官**输出了正确的 JSON 数组**（13 条 `skip`），而线上落库的是：
   * ```
   *   ```json
   *   [
   *     {"symbol":"WUSDT","action":"skip","confidence":80,"reasoning":"急跌后短修复但1
   *   </team>
   * ```
   * **数组在第一个元素中间被截断** → `extractFirstJsonArray` 报 `bad-json`
   * → `decisions = []` → **整轮零决策**。
   *
   * 而它的推理部分（1171 字）**是完整的** —— 也就是说
   * **推理把预算用光了，JSON 数组排在最后，只分到 83 个字符。**
   *
   * ## 为什么这个 BUG 极难发现
   *
   * ```
   *   ① 裁决官的结论"不行动"看起来是【一个判断】，不是"输出被截断"
   *   ② 审计块里只显示前 4000 字 —— 而截断发生在更后面
   *   ③ raw_response 里那一行 `{` 看起来很自然（谁会去数括号？）
   * ```
   * 我前几轮一直在查"提示词、模型、门槛"，**而真相是"预算不够"**。
   *
   * ## 为什么是 8192 而不是更大
   *
   * ```
   *   实测 judge 的推理 ≈ 1,200 字 ≈ 1,800 tokens
   *   而 13 条 skip 的 JSON ≈ 1,500 字 ≈ 2,200 tokens
   *   合计 ≈ 4,000 tokens —— 4096 是【刚好不够】
   * ```
   * 8192 留了一倍余量（候选数会涨到 20+，而每条 skip 都要写理由）。
   *
   * ⚠️ **T3 的超时是 180 秒**，而 8192 tokens 的输出在实测里约 40–80 秒 ——
   * 时间够。这与 `market_analyst` 那次（2048 → 4096）是同一类修法。
   *
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **8192 到 2026-10-15 已经不够了 —— 实测数据推翻上面那句"一倍余量"**
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 实测（全历史 59 个可测量轮次，从 `<team>` 块的"完整 N 字"抓）
   *
   * ```
   *   judge 输出长度: p10=4,468 · p50=5,844 · p90=9,921 · max=12,111
   *   超过 8192 的: 14 / 59（23.7%）
   * ```
   *
   * ## 而超限率与**候选数**强相关（机制清楚）
   *
   * ```
   *   候选数     轮数   judge 平均长度   超 8192 的轮数   超限率
   *   ≤6         34        5,804            3          8.8%
   *   7-12        6        5,551            0          0.0%
   *   13-18      11        7,897            6         54.5%   ← 陡增
   *   >18         8        8,897            5         62.5%
   * ```
   *
   * ## 后果（这不是"少写点字"，是**决策丢失**）
   *
   * 裁决官的 JSON 被从末尾砍 → `decisions = []` → 那一轮**没有任何决策**：
   * ```
   *   ⚠️ 裁决里的 JSON 解析失败（可能被截断）—— 本轮按"不行动"处理
   *   attention: 裁决输出不可解析，导致本轮决策链路空转；
   *              需排查裁决角色的输出格式/预算截断问题
   * ```
   * 实测空决策轮里 judge 的输出：**5,042 / 5,265 / 6,756 / 10,854 / 11,847 字**。
   *
   * ## 为什么这次才暴露
   *
   * 两个因素叠加：
   * ```
   *   ① 候选数变多（早期 ≤6，后来 13–20）
   *   ② 2026-10-15 给 judge 补的提示词要求
   *      「每条决策都要给 reasoning：写"风险较高"是没用的；
   *        写"该标的在我历史上 11 笔净约 -0.005、胜率 36%"才有用」
   *      ⇒ 每条 reasoning 变长 ⇒ 数组整体变长
   * ```
   * 而提示词里那段"先输出数组"的教训**假设了数组本身短** —— 它防的是
   * "理由写在数组前面"，防不住"数组里每条都很长"。
   *
   * ## 修法（两层，缺一不可）
   * ```
   *   ① 预算 8192 → 16384（实测 max 12,111，留 35% 余量）
   *   ② 提示词里加"输出预算纪律"：skip 的 reasoning 要短
   *      —— 单靠加预算不够：候选数还会涨，而预算是有限的
   * ```
   * ⚠️ T3 超时 180 秒：16,384 tokens 按实测 50–100 token/秒约 160–330 秒 ——
   * **可能超时**。所以②（让它写短）不是可选项，是**必须**的；
   * 而①是给"确实需要长输出"的那一轮留的余地。
   */
  judge: 16384,
  risk_officer: 2048,
};

/**
 * **`ROLES[role].system` 的查表**（2026-10-15 加 —— 修"6/10 角色提示词从未到达模型"）。
 *
 * ## 为什么需要它
 *
 * `ask()` 原来拼的是 `你是交易台的「${role}」。${task}`，而 `task` 是
 * `tradingDesk.ts` 里的**内联短句** —— 于是 `roles.ts` 里那份精心写的
 * `system`（含风控官的 `lossScenarios`、`symbol_scout` 的输出契约、
 * `bull`/`bear` 的失效条件纪律）**只对 4 个走 `loop.ts` 的角色生效**。
 *
 * 线上印证：`decision_records` 里含 `<risk>` 的 **223 条**记录中，
 * 含 `lossScenarios` 的 **0 条**、含 `checked` 的 **0 条** ——
 * 而那两个字段只写在那份**从未到达**的提示词里。
 *
 * ## 为什么是"查表"而不是在 `ask()` 里直接 `ROLES[role].system`
 *
 * `ask()` 的 `role` 是 `string`（`AskRole` 的签名），而 `ROLES` 的键是
 * `AgentRole` 联合类型 —— 直接索引需要一次类型收窄。这里用一个显式的
 * `Record<string, string>` 映射，好处是：
 * ```
 *   ① 类型安全（`ROLES` 是封闭枚举，映射由类型检查保证不漏）
 *   ② 未知角色自然落到 `undefined` → 退回原行为（不抛错）
 * ```
 *
 * ⚠️ **它的正确性由 `roleSystemsWired.test.ts` 钉住**：那条测试从
 * `ROLES` 的实际键反查，确保每个角色的 `system` 都能被这里取到 ——
 * 判据从事实来源生成，不靠人记得（这个仓库为"手写清单会漂移"付过代价）。
 */
export const ROLE_SYSTEMS: Readonly<Record<string, string>> = Object.fromEntries(
  (Object.keys(ROLES) as AgentRole[]).map((r) => [r, ROLES[r].system]),
);
/**
 * 构造一个**多模型**的 `DecisionModel`。
 *
 * @param router 已经配好的模型路由器（含健康记录与降级链）
 * @param request 这一轮用哪个角色、哪个档位
 * @param baseMaxTokens 该角色的基础输出预算
 * @param onAttempt 观测钩子：每次尝试（含失败的降级）都会回调 ——
 *                  用户要求的"看得见系统在做什么"就靠它落进日志/事件流
 */
export function createRoutedDecisionModel(options: {
  router: ModelRouter;
  request: RoleRequest;
  baseMaxTokens: number;
  onAttempt?: (info: {
    role: string;
    modelId: string;
    ok: boolean;
    ms: number;
    note: string;
    fallbackCount: number;
  }) => void;

}): DecisionModel {
  const { router, request, baseMaxTokens, onAttempt } = options;

  return {
    complete: async (systemPrompt, userPrompt, callOptions) => {
      const result = await router.callByTier(
        request.tier,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
          baseMaxTokens,
        },
      );

      /*
       * 把**每一次尝试**报出去 —— 包括失败与降级。
       *
       * 用户反复要求"看得见系统在做什么"（这也是 `cycle_step` 事件存在的理由）。
       * 一次"降级了三次才拿到答案"如果不报出来，操作员只会觉得"这轮很慢"，
       * 而看不到"首选模型额度尽了"这个真事实。
       */
      if (onAttempt) {
        /*
         * ⚠️ **`fallbackCount` 是"到这一步为止已经降级了几次"**（复核发现 P2-I）。
         *
         * 第一版写的是 `index + failures`（两点：这是两个无关量的和），
         * 实测 `[失败,失败,成功]` 会输出 `2,3,4` —— 而正确的语义是 `0,1,2`
         *（第 1 次尝试还没降级、第 2 次降了 1 级、第 3 次降了 2 级）。
         *
         * 这个字段是**给操作员看的**（"为什么这轮慢"），语义错了就会误导。
         */
        let fallbacks = 0;
        for (const a of result.attempts) {
          onAttempt({
            role: request.role,
            modelId: a.modelId,
            ok: a.ok,
            ms: a.ms,
            note: a.note,
            fallbackCount: fallbacks,
          });
          if (!a.ok) fallbacks += 1;
        }
      }

      return {
        text: result.text,
        latencyMs: result.latencyMs,
        usage: {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          cachedTokens: result.usage.cachedTokens,
          reasoningTokens: result.usage.reasoningTokens,
        },
      };
    },
  };
}

/**
 * 默认的"调用一个具体模型"实现 —— 由 `manager` 注入真实的 `LlmClient` 工厂。
 *
 * 抽成类型别名只是为了让 `manager` 侧的那段胶水写得清楚：
 * **路由器不关心模型怎么调**，它只关心"选谁、失败了怎么办"。
 */
export type ModelCallFactory = (modelId: string) => CallModel;

/* -------------------------------------------------------------------------- */
/*  团队模式：跑整个交易台，返回 <decision> 文本                                 */
/* -------------------------------------------------------------------------- */

/**
 * 造一个**跑交易台**的 `DecisionModel`。
 *
 * ## 它是怎么把"多角色协作"藏在一层适配器后面的
 *
 * `autoTrader` 调 `complete(system, user)` 时，这里：
 *
 *   1. 把 `system` + `user`（交易循环给的完整材料）当作**交易台的市场与持仓材料**；
 *   2. 跑 `runTradingDesk()` —— 4 分析师并行 → 多空辩论 → 裁决；
 *   3. 用 `renderDeskOutcome()` 把裁决翻成 `<decision>[...]</decision>` 返回。
 *
 * 交易循环那边看到的就是"模型给了个决策数组"，**它不知道背后有 7 个角色**。
 *
 * ## 两个必须守住的边界
 *
 * · **`system` 提示词被保留**：它是交易循环的规则说明（输出格式、纪律）。
 *   交易台的角色提示词是**叠加**在它之上的，不是替换 —— 否则团队会不知道
 *   要输出 `<decision>` 格式，而那是**唯一**能让它的结论生效的形式。
 *
 * · **失败不抛出，而是返回空决策块**：一次团队会议失败（某个模型额度尽、
 *   网关抖动）不该让整轮决策抛错。`renderDeskOutcome` 已经把"为什么没结论"
 *   写进 `<team>` 块了 —— **返回"不行动 + 说清原因"比抛错更有用**：
 *   前者操作员看得懂，后者只会在日志里留一条栈。
 */
/**
 * 剥掉模型输出里的 `<tool>…</tool>` 块。
 *
 * ## 为什么团队模式必须剥（实测：这是"一轮跑 4 次交易台"的根因）
 *
 * `autoTrader` 有一个**按需取数循环**（`MAX_DATA_ROUNDS = 3`）：
 * 只要模型输出里有 `<tool>` 块，它就会执行工具并**再问一次模型**。
 *
 * 对**单模型**这是廉价的（多问 1 次）。而对**团队模式**，
 * "再问一次模型"意味着**把整个交易台重跑一遍**（8 个角色）——
 * 于是"一次决策"变成最多 **4 次交易台 = 32 次角色调用**。
 *
 * 实测（`#11` 模拟盘，9 分钟）：**派出分析师 8 次、零产出、64 次模型调用**。
 *
 * ## 为什么是"剥掉"而不是"改提示词"
 *
 * 我在角色 system 提示词里已经写明「**你没有工具**」，但模型仍会按训练习惯
 * 假装调工具（实测输出 `<tool>{"tool":"list_candidates",…}`）。
 * 提示词能降低概率，**不能保证** —— 而代价是整台重跑。
 *
 * 既然团队**真的没有工具**，它输出里的任何 `<tool>` 块都是**幻觉**。
 *
 * 顺带的好处：审计块里不再混着那段假 JSON（此前实测 `<team>` 块里
 * 出现 `{"tool":"l…`，读起来很困惑）。
 *
 * ⚠️ **只在团队模式剥**（本文件是团队专用的 `createTeamDecisionModel`）——
 * 另两种模式**真的有工具**（`decisionTools.ts`），剥掉会让它们失去取数能力。
 */
/**
 * **不算"动作"的决策** —— 它们不改变任何仓位，风控无需审阅。
 *
 * 与 `@aq/shared` 的 `DecisionActionSchema` 保持一致：
 * `skip` / `hold` / `wait` 都是"什么都不做"的表达（只是语气不同）。
 *
 * ⚠️ **不要用 `isOpenAction` 之类的白名单反推** —— 那样每加一个新动作
 * 都会默认落到"不算动作"里（fail-open）。这里用**黑名单**：
 * 只有明确属于"不行动"的三个才跳过，其余（含将来新增的动作）
 * **一律送去风控**（fail-closed）。
 */
const NON_ACTION = new Set(['skip', 'hold', 'wait']);
export function stripToolBlocks(text: string): string {
  return text.replace(/<tool>[\s\S]*?<\/tool>/g, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * 从交易循环给的提示词里**尽力**找出候选标的。
 *
 * ## 为什么要找，而不是让调用方传
 *
 * `DecisionModel.complete(system, user)` 是交易循环与模型之间的**唯一契约**
 *（见 `autoTrader.ts:381-434`），它只给两段文本。要拿标的就得从文本里找 ——
 * 改那个契约会牵连整个交易循环，而那是本项目最安全攸关的文件。
 *
 * ## 找不到就不搜
 *
 * 匹配不到标的时返回空数组 → `collectMarketResearch` 只查整体市场情绪
 *（那一条不需要标的）。**不猜标的** —— 猜错会让新闻分析师去查一个
 * 跟本轮无关的币。
 *
 * 判据是 `XXXUSDT` 形式的交易对（这是本项目标的的命名约定）。
 */
function symbolsFromPrompt(prompt: string): string[] {
  const matches = prompt.match(/\b[A-Z0-9]{2,15}USDT\b/g);
  if (matches === null) return [];
  /* 去重并限制数量 —— 搜索结果要进提示词，太多会把上下文吃满。 */
  return [...new Set(matches)].slice(0, 3);
}
/**
 * **工具循环的提示词标记** —— 用来区分"这次调用是谁发的"。
 *
 * ## 为什么需要它（2026-10-13 实测）
 *
 * 团队模型挂在机器人的**模型出口**上，所以它也会收到
 * `agent/loop.ts` 的工具循环调用。而那些调用只认工具调用 JSON ——
 * 拿团队会议的文本必然解析失败（实测 `#11` 的 `agent_runs` 全部 failed）。
 *
 * 接口层分不出来（`LoopModel` 与 `DecisionModel` 都是 `complete(system, user)`），
 * 但工具循环的 system 里有**它自己独有的协议说明**（`loop.ts` 的 `PROTOCOL`）。
 * 所以判据是那段文本。
 *
 * ⚠️ **必须与 `loop.ts` 的 `PROTOCOL` 保持同步。**
 * `toolLoopRouting.test.ts` 里有一条断言钉住这两处的字面量 ——
 * 若哪天有人改了 `loop.ts` 里的措辞而没改这里，那条测试会失败
 *（否则症状会回到"策略师全部失败、而界面上看不出来"）。
 */
export const TOOL_LOOP_MARKER = '你每一轮只能输出**一个 JSON 对象**';

/**
 * **单次调用档（`runSingleShot`）的标记**（2026-10-15 加）。
 *
 * ## 为什么必须有第二个标记（真实事故）
 *
 * `TOOL_LOOP_MARKER` 只存在于 `runToolLoop` 的 `PROTOCOL` 里，而
 * **`runSingleShot` 不拼 `PROTOCOL`** —— 于是它的调用被判成"交易决策"，
 * 进而**跑整个交易台**：
 * ```
 *   #833 ai_team strategy panel failed 29,058ms  tokens_in=0
 *        detail：无法从回复里解析出 JSON 对象（前 120 字符：<decision>
 *                [{"symbol":"BTCUSDT","action":"skip"…
 *   #834 同上 32,935ms
 * ```
 * `performance_analyst` / `attribution_analyst` 每次只想要一个结论，
 * 却触发了完整的 8 角色会议（分析师→多空对抗→裁决）——
 * **这两个岗位从接线那天起就没成功过一次**。
 *
 * ⚠️ 标记从 `loop.ts` 导入（单一来源），不在两处各写一遍字面量 ——
 * 那正是这次事故的形状（一处有、一处漏）。
 */
export { AGENT_CALL_MARKER };

/** 这次调用是不是来自 agent 层（工具循环 **或** 单次结论档）。 */
function isAgentLayerCall(systemPrompt: string): boolean {
  return systemPrompt.includes(TOOL_LOOP_MARKER) || systemPrompt.includes(AGENT_CALL_MARKER);
}

export function createTeamDecisionModel(options: {
  router: ModelRouter;
  /**
   * **当调用来自工具循环时的兜底模型**（2026-10-13 加）。
   *
   * ## 为什么必须有一个兜底
   *
   * 这个团队模型挂在机器人的**模型出口**上（`manager.ts` 的
   * `DecisionModel.complete`）—— 所以它**也会收到工具循环的调用**
   *（策略师、绩效分析、复盘员…见 `complete()` 里那段长注释）。
   *
   * 而那些调用**只认工具调用 JSON**（`{"tool":"…","args":{…}}`），
   * 拿团队会议的 `<decision>` 文本必然解析失败 —— 实测 `#11` 的
   * `agent_runs` **全部 `outcome=failed`**、`agent_experiments` **0 条**。
   *
   * 所以那些调用必须转给**单模型**。
   *
   * ⚠️ **不传时**：转给 `router` 里配的**第一个 T2 档模型**
   *（`createRoutedDecisionModel` 用的也是它），并记一条 warn 日志 ——
   * 让"这里被用到了"在日志里可见，而不是静默。 */
  singleModel?: DecisionModel;
  /** 交易循环给的系统提示词（含输出格式要求）。团队角色提示词会叠加在它之上。 */
  /** 每一步的回调（可观测性：让界面看得见团队在做什么）。 */
  onStep?: (step: { role: string; phase: string; note: string }) => void;
  /** 单次响应的输出预算。 */
  baseMaxTokens: number;
  /** 覆盖默认上限（测试用）。 */
  limits?: { maxCalls: number; maxDebateRounds: number };
  /**
   * **市场调研的取数函数**（联网搜索）。
   *
   * ## 为什么是注入的函数，而不是在里面直接调搜索
   *
   * 这样：① 这一层仍可被单元测试（注入桩即可，不碰网络）；
   * ② 搜索的配置（端点/key）留在 `manager`，与网关配置同一处来源；
   * ③ **不传就退化成原来的行为**（新闻材料为空）——
   * 既有测试与"没配搜索"的部署都不受影响。
   *
   * 用户 2026-10-12 的要求：「总管委派子代理去做市场调研（查新闻、各大交易所社区、
   * 社交媒体、新闻源等等）根据资料反馈给相应的智能体做处理」。
   */
  /**
   * 调研：**可以只返回文本，也可以返回文本 + 可选情报键**。
   *
   * ⚠️ 为什么要返回 `keys`（而不是让调用方从文本里抽）：
   * 裁决官要"标注这条决策依据了哪几条情报"，而**校验它没编造**
   * 需要"这次真的给过它哪些键"。若调用方从文本里正则抽，
   * **抽错了是静默的** —— 于是归因链会记下错的键（见 `attribution.ts`）。
   *
   * 返回 `string` 仍然支持（旧行为）—— 那时没有可选键，
   * 裁决官**不标注**，而不是猜。
   */
  research?: (symbols: readonly string[]) => Promise<string | { text: string; keys: string[] }>;

}): DecisionModel {
  const { router, onStep, baseMaxTokens, limits, research, singleModel } = options;

  /** 把一个角色的问题交给路由器。 */
  const ask: AskRole = async ({ role, tier, context, task }): Promise<DeskRoleOutput> => {
    const started = Date.now();
    try {
      /*
       * ── **按角色绑定 magpie 路由组**（2026-10-12 接线）──────────────────
       *
       * 用户建议过「按工种建路由组，绑定给对应的智能体」，而我在第 43 轮
       * **建了 4 个组却一直没接线**。不接线的后果实测（`#2447`）：
       *
       * ```
       *   market_analyst（T2 档）→ 发现层自动排的 group/auto-hy3（思维链）
       *   → 耗时 39s / 121s / >180s 剧烈波动 → 超时失败
       *   → 它是"判断有没有机会"的核心角色 → 裁决官无依据 → 零决策
       * ```
       *
       * ## 映射的取舍
       *
       * | 角色类 | 组 | 理由 |
       * |---|---|---|
       * | `market_analyst`（唯一 T2 分析）| **`team-analyst`** | 我按"分析"挑的 3 模型优选→兜底；**不用思维链模型**（慢且不稳）|
       * | T1 体力活 | **`team-grunt`** | 要快 + 免费 |
       * | 辩论/裁决（T3）| **`team-judge`** | 要最强 |
       *
       * ⚠️ **只覆盖这三个组，其余角色保持原样**（发现层的自动排序）——
       * 那是我还没充分验证过的部分，不该一次全换。
       *
       * ⚠️ 可用环境变量关掉（`AQ_ROLE_GROUPS=off`）—— 出问题能立刻回到旧行为。
       */
      const roleLadder = process.env.AQ_ROLE_GROUPS === 'off'
        ? undefined
        : ROLE_GROUP_LADDERS[role] ?? TIER_GROUP_LADDERS[tier];
      const result = await router.callByTier(
        tier,
        [
          {
            role: 'system',
            content:
              /*
               * ══════════════════════════════════════════════════════════════════
               *  ⚠️⚠️ **角色提示词必须真的送进模型**（2026-10-15 修）
               * ══════════════════════════════════════════════════════════════════
               *
               * ## 事故：`ROLES` 里有的角色，提示词**从未到达模型**
               *
               * 这里原来拼的是：
               * ```
               *   `你是交易台的「${role}」。${task}`
               * ```
               * 而 `task` 全是 `tradingDesk.ts` 里的**内联短句**。于是
               * `roles.ts` 里精心写的那份 `system`（风控官的 `lossScenarios`、
               * `symbol_scout` 的输出契约…）**到不了模型**。
               *
               * 线上印证：`decision_records` 里含 `<risk>` 的 **223 条**记录中，
               * 含 `lossScenarios` 的 **0 条**、含 `checked` 的 **0 条** ——
               * 而那两个字段只写在那份**从未到达**的提示词里。
               *
               * ## 修法：**角色标识行 + 角色提示词 + 本次任务**，三段都要有
               *
               * ```
               *   ① 你是交易台的「risk_officer」。   ← 标识行（谁在说话）
               *   ② <ROLES[role].system>            ← 那份长文（纪律与输出契约）
               *   ③ ## 本次任务 <task>              ← 这一次具体要它做什么
               * ```
               *
               * ⚠️ **① 不能省**（我第一版就省了，立刻被 4 条既有测试抓到）：
               * ```
               *   · 模型需要知道自己的角色名（它会引用"作为风控官…"）
               *   · 测试桩与审计日志靠 `「role」` 反推"这次问的是谁"
               *   · 省掉它 → `teamModel.test.ts` 里 4 条断言全红
               *     （包括"有真实动作时必须叫风控官"那条 fail-closed 守卫）
               * ```
               * 顺序也不能反：长文定义了输出格式与纪律，任务短句只是本次委托。
               *
               * ⚠️ **不在 `ROLES` 里的角色退回原行为**（只有标识行 + task）——
               * 那 7 个角色（`judge`/`bull`/`bear`/`supervisor`/`technical`/
               * `newscaster`/`sentiment`）**本来就没有 system 可送**。
               * 它们是另一件事：编制表不完整（见 `roleSystemsWired.test.ts`）。
               */
              `你是交易台的「${role}」。\n\n` +
              (ROLE_SYSTEMS[role] !== undefined
                ? `${ROLE_SYSTEMS[role]}\n\n## 本次任务\n${task}\n\n`
                : `${task}\n\n`) +
              /*
               * ⚠️ **必须明确说"你没有工具"**（2026-10-12 实测踩到）。
               *
               * 第一版没写这句，于是角色**以为它能取数**，输出了：
               *
               *   · 「我将先获取市场数据来了解当前状况。让我同时列出候选池…」
               *   · 「候选标的技术形态数据缺失，**我先拉取候选池与指标序列**再做客观描述」
               *
               * 而这些"动作"**永远不会发生**（团队模式不给角色工具）——
               * 结果是模型反复"打算取数"，实测把某个角色拖到 **299 秒**，
               * 而操作员在审计块里看到的是一段**假装干活的独白**。
               *
               * 说清这一点有两层好处：
               *   ① 不再浪费 token 与时间去"计划取数"；
               *   ② 数据确实缺失时它会**如实说"数据不足"**，
               *      而不是假装去拿 —— 那正是本项目反复强调的"看不出异常的失败"。
               */
              '## 重要：你没有工具\n' +
              '**你不能调用任何工具、不能取数、不能查行情。** 只能基于下面提供的材料作答。\n' +
              '材料里没有的东西，就**如实说"数据不足"** —— 不要写"我将去获取…"、"让我先拉取…"，' +
              '因为那些动作不会发生，而且会掩盖"数据缺失"这个真问题。',
          },
          { role: 'user', content: context },
        ],
        {
          /*
           * **按角色给输出预算**（见 `ROLE_MAX_TOKENS` 的实测说明）。
           *
           * ⚠️ 这是修"超时"的真正根因：`TEAM_BASE_MAX_TOKENS = 8192`
           * 意味着最坏要跑 80+ 秒，而 T1 的超时线是 60 秒 —— **必然超时**。
           * 而实测 `max_tokens=2000` 时 `content = 0 字`（全花在推理上）。
           */
          baseMaxTokens: ROLE_MAX_TOKENS[role] ?? baseMaxTokens,
          /* 按角色绑定的路由组（`undefined` 时保持发现层的原行为）。 */
          ...(roleLadder !== undefined ? { ladder: roleLadder } : {}),
        },
      );
      return {
        role,
        modelId: result.modelId,
        data: null,
        raw: result.text,
        latencyMs: Date.now() - started,
        ok: true,
      };
    } catch (error) {
      return {
        role,
        modelId: '（未调用成功）',
        data: null,
        raw: '',
        latencyMs: Date.now() - started,
        ok: false,
        error: (error as Error).message,
      };
    }
  };

  return {
    complete: async (systemPrompt, userPrompt) => {
      const started = Date.now();
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **只接管"交易决策"那一次调用，不是所有调用**
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 事故：策略师每一轮都在跑一整个团队会议（2026-10-13 实测抓到）
       *
       * `ai_team` 的这个路由模型被挂在机器人的**模型出口**上
       *（`manager.ts` 的 `DecisionModel.complete`），所以**任何**调用都会进来 ——
       * 包括 `agent/loop.ts` 的**工具循环**（策略师、绩效分析、复盘员…）。
       *
       * 而工具循环解析的是**工具调用 JSON**：
       * ```
       *   {"thought":"…","tool":"get_experiments","args":{…}}
       * ```
       * 于是实测（`agent_runs` 的 detail 字段，原文）：
       * ```
       *   模型连续两轮没有输出可解析的工具调用：
       *   无法从回复里解析出 JSON 对象（前 120 字符：<decision>
       *   []
       *   </decision>
       *
       *   <risk>
       *   ⚠️ 本轮**未经风控官审阅**…
       *   <team>
       *   交易台：分析师 2/2 成功 · 做多论证已出）
       * ```
       * **`#11` 的 agent_runs 全部 `outcome=failed`**，而每一轮耗时 **324–870 秒**：
       * ```
       *   #712 idle panel steps=6 449s failed
       *   #709 idle single steps=4 352s failed
       *   #707 idle single steps=7 666s failed
       *   ...
       *   agent_experiments = **0 条**
       * ```
       * 也就是说：**策略师每走一步，系统就召集 8 个角色开一次会**
       *（那正是 5–15 分钟的来历），然后把会议纪要喂给一个
       * "只认工具调用 JSON"的解析器 → 必然失败 → 再重试一次 → 还是失败。
       *
       * ## 修法：靠**提示词特征**判断这次是谁在调用
       *
       * 接口层分不出来（两者都是 `complete(system, user)`）——
       * 但**工具循环的 system 里有它自己独有的协议说明**（`loop.ts` 的 `PROTOCOL`）。
       * 所以判据是那段文本。
       *
       * ⚠️ **为什么用文本特征而不是加一个参数**：`LoopModel` 与 `DecisionModel`
       * 是**同一个形状**（`loop.ts` 的注释明确说"同一个形状，所以真实客户端可以
       * 直接传进来"）—— 加参数会破坏那个通用性，而它是刻意的设计
       *（"换厂商不用改代码"）。文本特征虽然不优雅，但**不需要改任何接口**。
       *
       * ⚠️ 而这段文本**必须与 `loop.ts` 保持同步** —— 所以 `toolLoop.test.ts`
       * 里有一条断言钉住这两处的字面量（见那个测试文件的说明）。
       */
      /*
       * ⚠️ **判据从"工具循环"放宽到"agent 层"**（2026-10-15 修）。
       *
       * 原来只认 `TOOL_LOOP_MARKER`，而 `runSingleShot`（单次结论档）不拼
       * `PROTOCOL` —— 于是它的调用被判成交易决策、**跑整个交易台**，
       * 拿回 `<decision>` 必然解析失败。实测 `agent_runs` #833/#834 就是这么 failed 的
       * （29s / 33s、`tokens_in=0`），而对照 `ai_managed` 的 #830/#831 是 ok。
       *
       * 受影响的是 `performance_analyst` / `attribution_analyst`（panel 档并行跑）
       * 与复盘员 —— **它们从接线那天起就没成功过一次**。
       */
      const agentLayerCall = isAgentLayerCall(systemPrompt);
      if (agentLayerCall) {
        /*
         * 工具循环 —— **走普通单模型**（它自己有一套工具协议，
         * 不需要也不该由一个 8 人团队来回答"下一步调哪个工具"）。
         *
         * ⚠️ 这里**必须返回一个可用的结果**，不能抛错 ——
         * 抛错会让策略师那一轮直接失败（而现在它至少能正常工作）。
         *
         * ⚠️ 而且**必须记一条日志**：`onStep` 让"这次调用被转给了单模型"
         * 在界面上可见。否则将来排查"策略师为什么不调参"时，
         * 会看到一个谜（团队模型明明在，工具循环却拿到了普通回答）。
         */
        onStep?.({
          role: 'supervisor',
          phase: 'route',
          note: '工具循环调用 → 转给单模型（团队会议只回答交易决策）',
        });
        if (singleModel !== undefined) {
          return singleModel.complete(systemPrompt, userPrompt);
        }
        /*
         * 没有注入单模型 → 用路由器直接调**一个**模型
         *（`T2_mid` 档：那是"处理型"角色的档位，工具循环需要的是听话+快）。
         *
         * ⚠️ 用 `router.callByTier` 而不是自己拼 HTTP —— 路由器的
         * 重试/降级/健康检查逻辑就在那里，绕过它等于把那些保护丢掉。
         */
        const res = await router.callByTier(
          'T2_mid',
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          { baseMaxTokens },
        );
        return {
          text: res.text,
          latencyMs: res.latencyMs ?? 0,
          usage: {
            promptTokens: res.usage?.promptTokens ?? null,
            completionTokens: res.usage?.completionTokens ?? null,
          },
        };
      }

      /*
       * 交易循环给的 `systemPrompt`（规则与输出格式）**并入市场材料** ——
       * 见上面第二段边界说明：不能丢掉它，否则团队不知道要输出什么格式。
       */
      /*
       * ⚠️ **`systemPrompt` 与 `userPrompt` 的分工（2026-10-12 实测修正）。**
       *
       * `autoTrader` 传给模型的两段文本是这样分工的：
       *
       *   · `systemPrompt` —— **规则与角色说明**（输出格式、纪律、风控约束）；
       *   · `userPrompt`   —— **真正的材料**：候选池、多周期指标序列、持仓、账户状态。
       *
       * 第一版我把它们接反了：`marketContext = systemPrompt`（规则当材料）、
       * 而 `userPrompt` 只当新闻。实测后果 —— 模型明确说：
       *
       *   「本轮材料中没有提供任何市场数据，因此无法进行市场结构分析」
       *   「提示词里没有附带任何行情数据、候选池或持仓信息 —— 我手上是空的」
       *
       * 而同一时刻日志显示「list_candidates → 20 个」—— 数据取到了，
       * **只是没进提示词**。于是团队基于"空材料"讨论，还白白慢了一轮。
       *
       * 现在：行情材料用 `userPrompt`，而**规则（systemPrompt）也一并带进去**
       *（角色需要知道输出格式与纪律，见下面 `marketContext` 的拼装）。
       */
      let newsContext = '';
      /*
       * **本次调研给出的"可选情报键"**（2026-10-12）——
       * 裁决官只能从这里面标注依据，`filterKnownIntelKeys` 也用它做校验。
       *
       * ⚠️ 为什么必须是"这次真的给过它的"：模型可能编一个不存在的键，
       * 而编造的键**永远只有 1 个样本** → 失效检测对它永不生效，
       * 且会让归因数据看起来比实际更丰富（见 `attribution.ts` 的说明）。
       */
      let availableIntelKeys: string[] = [];
      if (research !== undefined) {
        try {
          onStep?.({ role: 'supervisor', phase: 'dispatch', note: '派出调研员联网搜索新闻与情绪' });
          const r = await research(symbolsFromPrompt(userPrompt));
          /*
           * 兼容两种返回形状：
           * · `string` —— 旧行为（纯文本），此时没有可用键（**不标注**，不猜）；
           * · `{ text, keys }` —— 新行为，带上"可选键"。
           *
           * ⚠️ **不能用"从文本里正则抽键"来兼容旧形状** ——
           * 那等于让调用方猜，而猜错的后果是静默的（见上）。
           */
          if (typeof r === 'string') {
            newsContext = r;
          } else {
            newsContext = r.text;
            availableIntelKeys = r.keys;
          }
        } catch (error) {
          /* 调研这一层失败不该让整轮失败 —— 行情数据仍是好的。 */
          onStep?.({ role: 'supervisor', phase: 'dispatch', note: `调研失败：${(error as Error).message}` });
        }
      }

      const outcome = await runTradingDesk({
        ask,
        /*
         * 行情材料 = **真正的数据（userPrompt）** + 规则速览（systemPrompt 的末尾一段）。
         *
         * 规则要带进去是因为角色需要知道输出格式与纪律；但**不能让它占满材料位**
         *（第一版就是这个问题）。所以规则放在后面、标明是"规则"。
         */
        marketContext: `${userPrompt}\n\n---\n\n## 团队需要遵守的规则（来自交易循环）\n${systemPrompt}`,
        newsContext,
        /* 本次调研给出的可选情报键 —— 裁决官只能从这里面标注（见 esearch 的说明）。 */
        availableIntelKeys,
        positionContext: '',
        ...(onStep ? { onStep } : {}),
        ...(limits ? { limits } : {}),
      });

      /*
       * ── **风控官关卡**（用户需求 #3：风控由智能体负责，不是内置规则）──────
       *
       * 位置很关键：**在裁决之后、渲染之前**。
       *
       *   · 在裁决**之前**问 → 风控官看不到团队讨论的结论，只能空谈；
       *   · 在渲染**之后**问 → 来不及改决策，只能"事后评论"（那正是
       *     TradingAgents 的教训：只提建议的风控等于没有风控）。
       *
       * ## 为什么这一层仍然不是"全部交给智能体"
       *
       * 风控官（本层）管**策略判断**：仓位大小、集中度、该不该收手 ——
       * 那是真正需要智能的部分，也是用户要的"风格由智能体负责"。
       *
       * 而**物理底线**（保证金够不够、数量可不可交易、止损存不存在）
       * 仍在下一层 `RiskEngine`，**它不可被绕过** ——
       * 把"保证金够不够"交给会幻觉的模型判断，等于拿爆仓换"智能"。
       */
      const risk = await askRiskOfficer(ask, outcome, onStep);

      return {
        /*
         * ⚠️ **剥掉 `<tool>` 块**（2026-10-12 实测：这是"一轮跑 4 次交易台"的根因）。
         *
         * ## 为什么必须剥
         *
         * `autoTrader` 有一个**按需取数循环**（`MAX_DATA_ROUNDS = 3`）：
         *
         * ```ts
         * for (let dataRound = 1; dataRound <= MAX_DATA_ROUNDS; dataRound += 1) {
         *   const calls = extractToolCalls(finalResponse.text);
         *   if (calls.length === 0) break;
         *   ... 执行工具 ...
         *   const followUp = await askAgain(...);   // ← 再问一次模型
         * }
         * ```
         *
         * 对**单模型**这是廉价的（多问 1 次）。而对**团队模式**，
         * "再问一次模型"意味着**把整个交易台重跑一遍**（8 个角色）——
         * 于是"一次决策"变成最多 **4 次交易台 = 32 次角色调用**。
         *
         * 实测证据（#11 模拟盘，9 分钟窗口）：
         * ```
         *   派出分析师 2 → 4 → 5 → 6 → 7 → 8 次
         *   新决策记录：0 条
         * ```
         * **64 次模型调用，零产出。**
         *
         * ## 为什么模型会输出 `<tool>`
         *
         * 团队角色**没有工具**（我在 system 提示词里已经写明"你没有工具"），
         * 但模型仍会按训练里的习惯**假装调工具**（实测输出
         * `<tool>{"tool":"list_candidates",...}`）。
         * 提示词能降低概率，**不能保证** —— 而代价是整台重跑。
         *
         * 所以这里做**兜底**：既然团队真的没有工具，那它的输出里
         * **任何 `<tool>` 块都是幻觉**，剥掉即可。
         *
         * 顺带的好处：审计块里不再出现那段假的工具 JSON
         *（此前实测 `<team>` 块里混着 `{"tool":"l...`，读起来很困惑）。
         */
        text: stripToolBlocks(renderDeskOutcome(outcome, risk)),
        latencyMs: Date.now() - started,
        usage: { promptTokens: null, completionTokens: null },
      };
    },
  };
}

/**
 * 问风控官。
 *
 * ## 提取裁决里的决策 → 交给风控官 → 解析它的结论
 *
 * 决策从**裁决文本**里抽（与渲染用的是同一个抽取器）—— 保证"风控官审的东西"
 * 与"最终执行的"是**同一份**。用两次不同的抽取会引入"审的是 A、执行的是 B"的风险。
 *
 * ## 失败时不阻断
 *
 * 风控官调用失败（额度尽、网关抖动）→ 返回 `null` → 渲染层会标明
 * "本轮未经风控官审阅"。**不抛错**：一次抖动不该让整轮决策作废
 *（而下一层 `RiskEngine` 的物理底线仍在，安全不靠这一层单独保证）。
 */
async function askRiskOfficer(
  ask: AskRole,
  outcome: DeskOutcome,
  onStep?: (step: { role: string; phase: string; note: string }) => void,
): Promise<{
  approved: boolean;
  adjusted: Decision[] | null;
  reason: string;
  concern: string | null;
  modelId: string | null;
} | null> {
  const extracted = outcome.verdict?.ok === true ? extractFirstJsonArray(outcome.verdict.raw) : null;
  const decisions = (extracted?.decisions ?? []) as Decision[];

  /* 没有决策要审（本轮本来就不行动）→ 不必多花一次调用。 */
  if (decisions.length === 0) return null;

  /*
   * ⚠️ **全是"不行动"时也跳过风控官**（2026-10-12，实测耗时结构定位后补上）。
   *
   * ## 为什么
   *
   * 风控审的是**要执行的动作** —— 没有动作就没有风险敞口可审。
   * 而裁决官经常会给出 N 条 `skip`（"每个候选都不做"），
   * 那时 `decisions.length` **不是 0**（所以上面那条拦不住），
   * 于是风控官被叫来读 15 万字材料、然后回答"批准"—— **约 120 秒白花**。
   *
   * ## 实测背景
   *
   * 第 39 轮把耗时结构定位清楚了：
   *
   * ```
   *   4 个分析师（并行）：~50 秒
   *   辩论 → 裁决 → 风控：~370 秒     ← 瓶颈
   * ```
   *
   * 而这三次串行 T3 调用**不能并行**（P1：唯一裁决者）。
   * 所以省时间的唯一办法是**少调用一次** —— 而这一条正是安全的省略：
   * 没有动作时，风控的结论必然是"批准"（没什么可否决的）。
   *
   * ## 为什么这是安全的（而不是"跳过检查"）
   *
   * 风控官的两层结构里，**代码层的物理底线（`RiskEngine`）不受影响** ——
   * 它仍然会跑，仍然会拦下保证金不足、数量不可交易、没有止损的动作。
   * 跳过的只是"**智能体层的策略审阅**"，而那一层对"什么都不做"没有可审的东西。
   */
  const hasAction = decisions.some((d) => !NON_ACTION.has(d.action));
  if (!hasAction) {
    onStep?.({
      role: 'risk_officer',
      phase: 'risk',
      note: `裁决结果全是"不行动"（${decisions.length} 条）—— 风控官无需审阅，省一次调用`,
    });
    return null;
  }

  onStep?.({ role: 'risk_officer', phase: 'risk', note: `审阅 ${decisions.length} 条决策` });

  try {
    const out = await ask({
      role: 'risk_officer',
      tier: tierForRole('risk_officer'),
      context: [
        '## 待审决策',
        JSON.stringify(decisions, null, 2),
        '## 团队讨论摘要',
        outcome.summary,
        '## 裁决官结论',
        outcome.verdict?.raw.slice(0, 1500) ?? '（缺失）',
      ].join('\n\n'),
      task:
        '审阅上面的决策，判断**风险是否可接受**。你有权**否决**或**建议削减仓位**。' +
        '必须明确表态：说"批准"或"否决"（或"削减"）。' +
        '同时给出一句话理由，以及你担心的主要风险。' +
        '⚠️ 你的职责是**风险**，不是方向 —— 不要因为"我觉得会涨"而批准，' +
        '也不要因为"我觉得会跌"而否决；只看**风险敞口是否合适**。',
    });

    const verdict = parseRiskOfficerVerdict(out.raw, decisions);
    onStep?.({
      role: 'risk_officer',
      phase: 'risk',
      note: verdict.approved ? (verdict.reduced ? '削减后放行' : '放行') : '否决',
    });
    return {
      approved: verdict.approved,
      adjusted: verdict.adjusted,
      reason: verdict.reason,
      concern: verdict.concern,
      modelId: out.modelId,
    };
  } catch (error) {
    onStep?.({ role: 'risk_officer', phase: 'risk', note: `调用失败：${(error as Error).message}` });
    return null;
  }
}