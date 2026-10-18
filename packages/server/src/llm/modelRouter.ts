/**
 * **模型路由器** —— 按角色分派模型，并在失败时**自动向下平替**。
 *
 * ## 它在架构里的位置
 *
 * ```
 *   角色（调度官 / 分析师 / 风控官…）
 *        ↓  「我需要 T3 档」
 *   ModelRouter  ← 本文件
 *        ↓  选模型 → 调 magpie → 失败就降级
 *   magpie 网关（705 模型 / 额度跟踪）
 * ```
 *
 * 它包在 `DecisionModel` 之外，**不碰交易循环** —— 这是考古报告 §9.2 认定的
 * 「最小侵入接缝」：多角色/多模型可以在这一层解决，`autoTrader.ts` 一行不用改。
 *
 * ## 为什么不做成"一个角色固定一个模型"
 *
 * 用户明确要求冗余与回退（见 `modelHealth.ts` 顶部引用）。而实测额度已经见底
 *（`workbuddy-ai` 3.13/350、`cline` $0.50），所以**固定模型 = 定时停摆**。
 */

import {
  ladderForTier,
  profileOf,
  registerDiscoveredProfiles,
  type ModelProfile,
  type ModelTier,
} from './modelCatalog.js';
import {
  ModelHealthRegistry,
  classifyFailure,
  pickAvailable,
  type FailureVerdict,
} from './modelHealth.js';

/** 一次模型调用的结果。 */
export interface RouterCallResult {
  /** 最终拿到内容的那个模型。 */
  modelId: string;
  /** 文本内容。 */
  text: string;
  latencyMs: number;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    cachedTokens?: number | null;
    reasoningTokens?: number | null;
  };
  /**
   * 这一次实际尝试过哪些模型（含失败的）。
   *
   * **必须暴露出来** —— 用户反复要求"看得见系统在做什么"，
   * 而"它降级了三次才拿到答案"正是最该被看见的信息。
   */
  attempts: Array<{ modelId: string; ok: boolean; ms: number; note: string }>;
}

/** 调用一个具体模型的函数（由调用方注入，便于测试与解耦）。 */
export type CallModel = (
  modelId: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: {
    signal?: AbortSignal;
    /**
     * 该模型的**输出预算**。路由器会按 `reasoning` 放大它 ——
     * 实测：思维链模型的 `reasoning_content` 会吃掉预算导致 `content: null`。
     */
    maxTokens: number;
  },
) => Promise<{
  text: string;
  latencyMs: number;
  usage: RouterCallResult['usage'];
  /**
   * 结束原因。**必须透传** —— 它是区分两种"空内容"的唯一依据：
   *
   *   · `'length'`  → 被 token 上限截断（思维链吃光预算）→ **加大预算重试**
   *   · 其他/null   → 真的空回复 → **重试，仍空则降级**
   *
   * 不透传的话，`classifyFailure` 里那条 `finishReason === 'length'` 分支
   * **永远不会命中**（实测发现的问题：那条分支曾是死代码）。
   */
  finishReason?: string | null;
  /** 失败时由实现抛出；路由器据此分类。 */
}>;

/** 路由器配置。 */
export interface ModelRouterOptions {
  /** 调用实现。 */
  call: CallModel;
  /** 健康注册表（可共享，让"哪个模型不行"在角色之间传播）。 */
  health?: ModelHealthRegistry;
  /**
   * **最多降级几次**（不是"最多试几个模型"）。
   *
   * 默认 3 → 循环是 `for (i = 0; i <= maxFallbacks; i++)`，即**至多试 4 个模型**。
   *
   * 数量这么定的理由：够覆盖"首选挂 → 平替挂 → 免费兜底 → 再兜一层"，
   * 又不至于一次调用把整条链跑完（那会把一次失败变成很长的等待；
   * 实测单模型失败要 10s+，4 个就是 40s+，已经吃掉一轮决策的可观预算）。
   *
   * ⚠️ **注释原来写的是"最多试几个模型：默认 3"，与代码不符**（复核发现 P2-J）。
   */
  maxFallbacks?: number;
  /** 观测钩子：每次降级都回调一次（给日志/事件流用）。 */
  onFallback?: (info: { from: string | null; to: string; verdict: FailureVerdict }) => void;
  /**
   * **自动发现到的候选链**（`ModelDiscovery.byTier`）—— 有它就用它，没有就用静态档案。
   *
   * ## 这是"自动发现"真正生效的那一步
   *
   * 用户 2026-10-12 要求「系统是否会自动发现，自动调研判断模型档次，
   * **然后应用到相应的智能体中**」。前两步由 `modelDiscovery` 做，
   * **第三步就是这里** —— 把发现到的档位清单当成候选链。
   *
   * ## 为什么是"覆盖"而不是"合并"
   *
   * 发现到的清单来自**网关此刻的真实状态**（哪些模型现在真的存在、
   * 哪些是免费的）。而静态档案是**人写的、会过期**的。
   * 合并会让已下线的模型继续留在链上（每次都要失败一次才发现），
   * 所以以**发现结果为准**、档案只作兜底。
   */
  discoveredLadders?: Partial<Record<ModelTier, readonly string[]>>;
  /**
   * **发现到的模型的元数据**（`reasoning` / 上下文 / 输出上限）—— 2026-10-17 加。
   *
   * ## 为什么需要它（一次整链全灭）
   *
   * `budgetFor()` 靠 `profile.reasoning` 决定放大几倍，而 `profileOf()` 只看
   * **静态档案**（14 个模型）。T1/T2/T3 链上的候选**大部分是动态发现的** ——
   * 于是 `profileOf()` 返回 `undefined` ⇒ 以前**一律不放大** ⇒
   * 预算被思维链吃光 ⇒ `content=0` ⇒ 整链全灭（用户截图 2026-10-17 16:37:36）。
   *
   * ## 为什么单独一个参数，而不是塞进 `discoveredLadders`
   *
   * `discoveredLadders` 是**档位 → id 列表**（排序结果），而这里要的是
   * **id → 元数据**（`/v1/models` 的原始字段）。两者来源不同、用途不同：
   * ```
   *   discoveredLadders   → "先试谁"（顺序）
   *   discoveredProfiles  → "给它多少预算"（reasoning / maxOutputTokens）
   * ```
   * 合在一起会让"链的排序"与"预算的依据"耦合 —— 而它们**本来没有关系**。
   *
   * ⚠️ **不传 = 行为与改动前完全一致**（静态档案 + t117 的盲放大兜底）。
   */
  discoveredProfiles?: ReadonlyArray<{
    id: string;
    reasoning: boolean;
    contextTokens: number;
    maxOutputTokens: number;
  }>;
}

/**
 * 思维链模型的输出预算放大倍数。
 *
 * **实测依据**：`gpt-6-astra` 在 `max_tokens=16/128` 时返回 `content: null` +
 * `reasoning=435/475`（思维链把预算吃光了），到 512 才正常吐字。
 * 所以对 `reasoning: true` 的模型，预算必须放大。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️⚠️ **放大的前提是"知道它是思维链模型" —— 而 T1_fast 链上的候选不在档案里**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 线上实测（2026-10-17 16:37:36，团队 #11，`T1_fast` 档 4 个候选全灭）：
 * ```
 *   opencode-zen-free/beam-free         → 输出被 token 上限截断（思维链占满了预算）
 *   opencode-zen-free/beam-free         → 同上（重试一次仍失败）
 *   opencode-zen-free/space-bunny-free  → 同上
 *   group/auto-space-bunny-free         → 同上
 * ```
 *
 * ## 根因：**`profileOf()` 对不在 `MODEL_PROFILES` 里的模型返回 `undefined`**
 *
 * 而 `budgetFor()` 的第一行是 `if (profile?.reasoning !== true) return baseMaxTokens;`
 * ⇒ **未登记的模型一律不放大**，不管它实际上是不是思维链模型。
 *
 * `T1_fast` 链上 5 个候选里，**只有 `space-bunny-free` 在 `MODEL_PROFILES` 里**；
 * 其余 4 个（`beam-free` / `group/auto-space-bunny-free` / `group/team-grunt` /
 * `group/team-analyst`）都不在 —— 而它们**全部会写思维链**。
 *
 * ## 服务器侧量化（2026-10-17，28,500 字符材料，`beam-free`）
 *
 * ```
 *   max_tokens=1024 → finish=length · ct=1024 · reasoning=1023 · content=  0 字  ← 线上实际发的预算
 *   max_tokens=2048 → finish=length · ct=2048 · reasoning=2047 · content=  0 字  ← 重试翻倍后
 *   max_tokens=4096 → finish=stop   · ct=3654 · reasoning=2336 · content=2244 字  ✅
 * ```
 * **⇒ 1024 与 2048 都被思维链吃光（content=0），4096 才写出正文。**
 * 而 T1 的基础预算正是 1024（`newscaster`/`sentiment`）或 2048（`technical`），
 * 重试翻倍后是 2048 或 4096 —— **对 `beam-free` 来说 2048 仍然不够**。
 *
 * ## 修法：**未知档案的模型按"可能带思维链"处理**
 *
 * 代价与收益：
 * ```
 *   放大错的代价：给一个非思维链模型多一倍预算 —— 它自己会 stop，不多花时间
 *   不放大错的代价：整条链 4 个候选全灭 → 角色缺席 → 决策少一份材料（线上现状）
 * ```
 * 这个不对称非常明显，所以默认放大。**宁可多给预算，也不要角色缺席。**
 *
 * ⚠️ 只有**明确知道**它不是思维链模型（`reasoning === false`）时才不放大 ——
 * 那仍然走原路径，行为不变。
 */
const REASONING_BUDGET_MULTIPLIER = 4;

/**
 * 因"被 token 上限截断"而重试时，预算再乘的倍数。
 *
 * **只乘一次**（`budgetBoosted` 是单次标记）。不设"反复加倍直到成功"的理由：
 * 那是 MAST 分类法里"步骤重复 15.7%"的形状 —— 预算越大思维链可能写得越长，
 * 收敛不了。**宁可这一次拿不到内容，也不要陷进无界重试。**
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️ **从 2 提到 4**（2026-10-17 服务器侧实测）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 同一材料（28,500 字符）、同一个模型（`beam-free`）：
 * ```
 *   1024（线上首次）      → content=  0 字
 *   2048（×2 重试）       → content=  0 字   ← 旧倍数救不回来
 *   4096（×4 重试）       → content=2244 字  ✅
 * ```
 * ⇒ 旧倍数 2 **在真实材料规模下必然失败**：它把预算从 1024 抬到 2048，
 * 而思维链本身就要 2047 —— 一个字符的正文都剩不下。
 *
 * ⚠️ 仍然**只重试一次**（不改成"反复加倍"）：上面那段 MAST 的理由仍然成立。
 * 变的是"这一次给多少"，不是"可以试几次"。
 */
const EMPTY_CONTENT_RETRY_MULTIPLIER = 4;

export class ModelRouter {
  private readonly health: ModelHealthRegistry;
  private readonly maxFallbacks: number;

  constructor(private readonly options: ModelRouterOptions) {
    this.health = options.health ?? new ModelHealthRegistry();
    this.maxFallbacks = options.maxFallbacks ?? 3;
    /*
     * ⚠️ **构造时注册一次**（不是每次调用）—— 发现结果在网关重启之间不变，
     * 而 `callByTier` 是热路径（一轮决策要调 9 次）。每轮重注册是纯浪费。
     *
     * 不传时**什么都不做** ⇒ 行为与改动前一致（`profileOf` 仍只查静态档案，
     * `budgetFor` 走 t117 的盲放大兜底）。
     */
    if (options.discoveredProfiles !== undefined && options.discoveredProfiles.length > 0) {
      registerDiscoveredProfiles(options.discoveredProfiles);
    }
  }

  /** 暴露健康状态（界面/日志用）。 */
  healthSnapshot(): ReturnType<ModelHealthRegistry['snapshot']> {
    return this.health.snapshot();
  }

  /**
   * **按档位调用** —— 这是给业务代码用的唯一入口。
   *
   * 流程：候选链 → 逐个尝试 → 失败分类 → 该重试就重试 / 该降级就降级。
   */
  async callByTier(
    tier: ModelTier,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options: {
      signal?: AbortSignal;
      baseMaxTokens: number;
      /**
       * **显式的候选链覆盖**（2026-10-12 加，用于"按角色指定 magpie 路由组"）。
       *
       * ## 为什么需要它
       *
       * 用户建议过「按工种建 magpie 路由组，绑定给对应的智能体」，
       * 而我在第 43 轮**建了 4 个组**（`team-grunt` / `team-analyst` /
       * `team-judge` / `team-news`）—— 但**一直没接线**。
       *
       * 不接线的后果实测（`#2447`）：`market_analyst`（T2 档）走的是
       * 发现层自动排的 `group/auto-hy3`（**思维链模型**），
       * 耗时在 **39s / 121s / >180s** 之间剧烈波动 → **超时失败** →
       * 它是"判断有没有机会"的核心角色 → **裁决官无依据 → 零决策**。
       *
       * ## 语义
       *
       * · 给了它 → **只用它**（不再走发现层的候选链）；
       * · 没给（默认）→ **行为与改动前完全一致**（这是增量更新的硬要求）。
       *
       * ⚠️ 它**不绕过健康检查** —— 链内仍然按 `pickAvailable` 逐个试、
       * 失败仍然降级与熔断。所以给一个"全是死模型"的链不会卡死，
       * 而是会走到 `maxFallbacks` 用尽后报错（与原来一致）。
       */
      ladder?: readonly string[];
    },
  ): Promise<RouterCallResult> {
    if (tier === 'T0_code') {
      throw new Error('T0_code 档不需要模型 —— 这类工作应当由代码完成（这是设计约束，不是错误）。');
    }

    /*
     * **候选链来源（优先级从高到低）**：
     *   ① 调用方显式给的 `ladder`（按角色绑定路由组）
     *   ② 网关此刻真实存在的发现结果
     *   ③ 静态档案（兜底）
     */
    const discovered = options.ladder !== undefined && options.ladder.length > 0
      ? [...options.ladder]
      : this.options.discoveredLadders?.[tier];
    const ladder = discovered !== undefined && discovered.length > 0
      ? [...discovered]
      : ladderForTier(tier).map((p) => p.id);
    if (ladder.length === 0) {
      throw new Error(`档位 ${tier} 没有任何候选模型 —— 模型档案（modelCatalog）需要补充。`);
    }

    const attempts: RouterCallResult['attempts'] = [];
    const tried: string[] = [];
    let previousModel: string | null = null;
    /*
     * 被 token 上限截断时**放大预算原地重试**用的标记；`null` = 还没用过这个额度。
     * 只允许一次（见空内容分支里的说明：防止"预算越大、思维链越长"的死循环）。
     */
    let budgetBoosted: number | null = null;

    /*
     * ══════════════════════════════════════════════════════════════════════
     *  ⚠️ **降级次数不能少于候选链长度**（2026-10-18 线上实测）
     * ══════════════════════════════════════════════════════════════════════
     *
     * `maxFallbacks` 默认 3（至多试 4 个），而 T3 链有 **6** 个候选。线上实测：
     * ```
     *   [dispatch] 按币并行失败 AGTUSDT：档位 T3_deep 试了 4 个模型都失败：
     *     group/auto-glm-5-3  → 认证或权限失败
     *     group/auto-grok-4-7 → 认证或权限失败
     *     group/auto-kimi-k3  → 上游端点不可用或额度已尽
     *     group/auto-mimo-v2-6-pro → 失败
     *   ⇒ 放弃。而 **group/team-judge / group/team-analyst 明明在线**，永远轮不到。
     * ```
     * 于是"逐币深看"整批失败（`成功 1 · 失败 5`）—— 链上明明是好的，只是没被尝试。
     *
     * ⇒ 判据改成：**只要链上还有没试过的候选，就给它机会**（那才是"降级"的定义），
     *   `maxFallbacks` 退化为下限。
     *
     * ## ⚠️ 为什么不能用 `i -= 1` 给截断重试"还配额"
     *
     * 我第一版那样写，结果循环**卡在同一个位置**（测试 403 实测 `callCount` 5 → 10 → 11）：
     * 截断重试把 `i` 还回去后，下一轮又选中同一个模型、又截断、又还回去 —— 无界。
     *
     * ⇒ 用**独立的计数器**分开两类：`fallbackCount` 只数"换候选"，`budgetBoosted`
     *   只管"同候选放大重试一次"。循环本身由 `tried` 集合自然收敛（每个候选至多一次）。
     */
    let fallbackCount = 0;

    for (let i = 0; ; i += 1) {
      /*
       * 退出条件写在循环内（因为"截断重试"不增加 `fallbackCount`）：
       * 换候选次数用完 ⇒ 停。
       */
      if (fallbackCount > Math.max(this.maxFallbacks, ladder.length - 1)) break;
      const modelId = pickAvailable(ladder, this.health, tried);
      if (modelId === null) {
        /*
         * 整条链都在冷却 —— 这是"降级到无路可走"。
         *
         * 按 P2（最终决定权由代码强制）**不静默兜底**：抛出去让上层决定
         *（是等待、是告警、还是用最后手段）。**假装成功比失败更糟。**
         */
        throw new Error(
          `档位 ${tier} 的候选链全部处于冷却期（${ladder.length} 个模型）—— ` +
            `已尝试：${attempts.map((a) => `${a.modelId}(${a.note})`).join('；')}`,
        );
      }

      tried.push(modelId);
      const profile = profileOf(modelId);
      const started = Date.now();
      try {
        const result = await this.options.call(modelId, messages, {
          ...(options.signal ? { signal: options.signal } : {}),
          maxTokens:
            budgetBoosted === null
              ? budgetFor(profile, options.baseMaxTokens)
              /*
               * ⚠️ 重试路径走 `retryBudgetFor` 而**不是** `budgetFor` ——
               * 见那个函数的说明：`budgetFor` 对 `reasoning=false` 的模型
               * 会返回原值，让"翻倍重试"空转。
               *
               * 第三个参数传**首次实际用的预算** —— 重试不得低于它。
               */
              : retryBudgetFor(profile, budgetBoosted, budgetFor(profile, options.baseMaxTokens)),
        });
        const ms = Date.now() - started;

        /* ② 空内容检查 —— 实测的"HTTP 200 但没吐字"。 */
        if (result.text.trim().length === 0) {
          const verdict = classifyFailure({
            status: 200,
            message: '',
            emptyContent: true,
            finishReason: result.finishReason ?? null,
          });
          attempts.push({ modelId, ok: false, ms, note: verdict.reason });

          /*
           * ⚠️ **"被 token 上限截断"不该换模型**，而该**给同一个模型更多预算重试**。
           *
           * 实测：`gpt-6-astra` 在 mt=16/128 时 `content: null`（思维链吃光了预算），
           * mt=512 就正常吐字。**它不是坏了，是这次话说得多了一点** ——
           * 换模型会白白丢掉最强的那个（T3 候选链里它排第一）。
           *
           * 原来的实现是"换下一个候选"，与 `classifyFailure` 里
           * `shouldRetry: true, shouldFallback: false` 的承诺**不符**：
           * 循环顶部的 `pickAvailable` 跳过了 `tried`，所以永远试不到同一模型
           * —— 那条 `finishReason === 'length'` 分支等于白写。
           *
           * 这里改成：**不加入 `tried`，把预算翻倍后原地重试一次**。
           * 只重试一次（`budgetBoosted` 标记），避免"预算越大、思维链写得越长"
           * 的死循环 —— 那正是 MAST 分类法里"步骤重复 15.7%"的形状。
           */
          if (verdict.kind === 'empty_content' && result.finishReason === 'length' && budgetBoosted === null) {
            /*
             * ⚠️ **必须基于"首次【实际】用的预算"翻倍**，而不是 `baseMaxTokens`。
             *
             * 实测踩到（2026-10-12）：`T3` 首选的 `kimi-k3` 是思维链模型且
             * 供应商没报输出上限 → `budgetFor()` 把它**放大 4 倍**：
             *
             * ```
             *   首次：budgetFor(4096) = 16384
             *   原来：budgetBoosted = baseMaxTokens × 2 = 8192   ← 比首次【还小】！
             * ```
             *
             * 那会让"重试"拿到**更少的预算** —— 与目的正好相反。
             * 项目的旧测试（`★★ 被 token 上限截断 → 加大预算重试同一个模型`）
             * 断言 `calls[1].maxTokens > calls[0].maxTokens` ——
             * 它**当场抓到了这个矛盾**。
             */
            const firstBudget = budgetFor(profile, options.baseMaxTokens);
            budgetBoosted = firstBudget * EMPTY_CONTENT_RETRY_MULTIPLIER;
            tried.pop(); /* 允许重选同一个模型 */
            previousModel = modelId;
            /*
             * ⚠️ **不增加 `fallbackCount`**：截断重试不是"降级到下一个候选"，
             * 而是"同一个候选换个预算再来一次"。它由 `budgetBoosted` 单次标记
             * 自己收敛（第二次走到这里时标记已非空，进不来）。
             */
            continue;
          }

          /*
           * ⚠️ **`endpoint_down` 是【供应商级】事实，要熔断整个供应商**
           *（2026-10-12 实测：T1 前 5 位全是同一家已耗尽额度的供应商，
           *  各失败 1 次都不到冷却阈值 → 每轮白烧 4 次调用）。
           *
           * 判据：`endpoint is unavailable` / `insufficient` / `credits exhausted`
           * 说的都是**那家供应商的账或端点**，不是某个模型坏了。
           *
           * 详见 `ModelHealthRegistry.recordProviderFailure`。
           */
          if (verdict.kind === 'endpoint_down') {
            this.health.recordProviderFailure(modelId, verdict.reason, ladder);
          }
          this.health.recordFailure(modelId, verdict.reason);
          previousModel = modelId;
          continue;
        }

        attempts.push({ modelId, ok: true, ms, note: '成功' });
        this.health.recordSuccess(modelId);
        return { modelId, text: result.text, latencyMs: result.latencyMs, usage: result.usage, attempts };
      } catch (error) {
        const ms = Date.now() - started;
        const verdict = classifyFailure({
          status: statusOf(error),
          message: (error as Error).message,
        });
        attempts.push({ modelId, ok: false, ms, note: verdict.reason });

        /*
         * ══════════════════════════════════════════════════════════════════════
         *  ⚠️ **`permission`（403）要按【供应商】熔断**（2026-10-18 补）
         * ══════════════════════════════════════════════════════════════════════
         *
         * ## 实测证据
         *
         * 修好日志的 model 字段之后（见 `api/server.ts` 的 `diagnosticTail`），
         * 一天之内抓到：
         * ```
         *   opencode-zen-free/space-bunny-free          status=403  ×4
         *   opencode-zen-free/beam-free                 status=403  ×3
         *   opencode-zen-free/deepseek-v4.1-flash-free  status=403  ×1
         * ```
         * 三家都是 `opencode-zen-free` 这一个供应商的，分散在 T1/T2/T3 三条链上
         * —— 每轮各撞一次，每次白等 **675–1618ms**。
         *
         * ## 为什么必须放在 `shouldFallback` **之前**
         *
         * `permission` 的 `shouldFallback === false`、`shouldRetry === false`
         * ⇒ 它会一路走到最后的 `throw error`，**根本不进任何熔断分支**。
         * （这一点是类型系统帮我发现的：把判断放进 `shouldFallback` 分支里，
         *   `tsc` 报 `FailureKind` 与 `"permission"` 无交集。）
         *
         * ## 为什么按供应商熔断是对的
         *
         * 403 = 这家网关/账号**没有这个模型的权限**（免费额度用完、需要订阅）。
         * 它不是"某个模型坏了"，而是**"这一家的免费池对我们关了"** ⇒
         * 同一前缀下的其它模型大概率同样 403。
         *
         * `recordProviderFailure` 会按 `provider/` 前缀匹配，并直接用 **30 分钟**冷却
         * （不是模型级的 5 分钟）。⇒ 一次 403 就把整家的候选一起冷下来。
         *
         * ⚠️ **`auth`（401）不在此列**：那说明我们自己配的 key 有问题，
         *   换哪个模型都救不了，也不需要"熔断某一家"。
         */
        /*
         * ⚠️ **HTTP 403 要按【供应商】熔断**（2026-10-18 补）
         *
         * ## 实测证据
         *
         * 修好日志的 model 字段之后（见 `api/server.ts` 的 `diagnosticTail`），
         * 一天之内抓到：
         * ```
         *   opencode-zen-free/space-bunny-free          status=403  ×4
         *   opencode-zen-free/beam-free                 status=403  ×3
         *   opencode-zen-free/deepseek-v4.1-flash-free  status=403  ×1
         * ```
         * 三家都是 `opencode-zen-free` 这一个供应商的，分散在 T1/T2/T3 三条链上
         * —— 每轮各撞一次，每次白等 **675–1618ms**。
         *
         * ## 两个"必须"
         *
         * 1. **必须放在 `shouldFallback` 之前**：403 的 `shouldFallback === false`、
         *    `shouldRetry === false` ⇒ 它会一路走到最后的 `throw error`，
         *    **根本不进任何熔断分支**。（这一点是 `tsc` 帮我发现的。）
         *
         * 2. **必须判状态码而不是 `verdict.kind`**：`FailureKind` 里**没有**
         *    `'permission'` —— 403 与 401 一起被归为 `'auth'`（见 `modelHealth.ts`）。
         *    而两者含义完全不同：
         *    ```
         *      401 = 我们自己配的 key 错了 → 换哪个模型都救不了，不熔断
         *      403 = 这家没有这个模型的权限（免费额度用完）→ 同前缀的其它模型大概率一样
         *    ```
         *
         * ⇒ `recordProviderFailure` 按 `provider/` 前缀匹配，直接用 **30 分钟**冷却
         *   （不是模型级的 5 分钟），一次 403 就把整家的候选一起冷下来。
         */
        if (statusOf(error) === 403) {
          this.health.recordProviderFailure(modelId, verdict.reason, ladder);
        }

        if (verdict.shouldFallback) {
          this.health.recordFailure(modelId, verdict.reason);
          this.options.onFallback?.({ from: previousModel, to: modelId, verdict });
          previousModel = modelId;
          /* 换候选 = 一次降级（这是 `fallbackCount` 唯一递增的地方）。 */
          fallbackCount += 1;
          continue;
        }
        if (verdict.shouldRetry) {
          /* 可重试：不退避（退避在 LlmClient 内部已做），换下一个候选继续试。 */
          previousModel = modelId;
          fallbackCount += 1;
          continue;
        }
        /* 既不该降级也不该重试（例如 400 格式错）—— **原样抛出**，不掩盖 bug。 */
        throw error;
      }
    }

    throw new Error(
      `档位 ${tier} 试了 ${attempts.length} 个模型都失败：` +
        attempts.map((a) => `${a.modelId} → ${a.note}`).join('；'),
    );
  }
}

/**
 * 给一个模型算输出预算。
 *
 * ⚠️ **思维链模型必须放大** —— 否则实测会出现 `content: null`（预算被思维链吃光）。
 *
 * ## 修过一次的 bug（2026-10-12 复核发现）
 *
 * 第一版写的是：
 *
 *     Math.min(maxOutputTokens > 0 ? maxOutputTokens : base * 4, base * 4)
 *
 * **它在 `maxOutputTokens < base × 4` 时返回的比 `base` 还小**，例如
 * `big-pickle`（maxOutput=32000）配上 `base=131072` → 返回 **32000（base 的 0.24 倍）**。
 * 也就是说：这个函数**在四个模型上把预算缩小了**，正好制造它要防的
 * `content: null` —— **注释承诺放大、代码执行缩小**。
 *
 * 为什么原来的测试没抓住：它用 `MODEL_PROFILES.find(m => m.reasoning && m.tier === 'T3_deep')`
 * 取到的是 `kimi-k3`，而它的 `maxOutputTokens === 0`（走 `base × 4` 那条路）——
 * **测试恰好只覆盖了唯一不会暴露 bug 的那个模型**。
 *
 * ## 正确的语义
 *
 * 「**放大，但不低于原值，也不超过供应商声明的上限**」：
 *
 *   · 供应商没报上限（0）→ `base × 倍率`
 *   · 报了上限 → 在 `[base, min(上限, base × 倍率)]` 之间取
 *     （`Math.max(base, …)` 保证**永不小于 base**）
 */
export function budgetFor(profile: ModelProfile | undefined, baseMaxTokens: number): number {
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **`profile === undefined` 时也必须放大**（2026-10-17 修，线上 4 候选全灭）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 原来这一行是 `if (profile?.reasoning !== true) return baseMaxTokens;` ——
   * 于是**不在 `MODEL_PROFILES` 里的模型一律不放大**，而 `T1_fast` 链上
   * 5 个候选里有 4 个不在档案里（只有 `space-bunny-free` 在），
   * 它们**全都写思维链** ⇒ 预算被推理吃光 ⇒ `content=0` ⇒ 整链失败。
   *
   * ## 为什么"未知就放大"是对的（代价不对称）
   *
   * ```
   *   放大错的代价：给非思维链模型多一倍预算 —— 它自己 stop，几乎不多花时间
   *   不放大错的代价：整条链全灭 → 角色缺席 → 决策少一份材料（线上现状）
   * ```
   * 所以默认按"可能带思维链"处理。**只有明确 `reasoning === false` 才不放大。**
   *
   * ⚠️ 未登记时拿不到 `maxOutputTokens`，所以不夹上限（供应商会自己拒超限请求）。
   */
  if (profile !== undefined && profile.reasoning === false) return baseMaxTokens;
  const amplified = baseMaxTokens * REASONING_BUDGET_MULTIPLIER;
  if (profile === undefined) return amplified;
  if (profile.maxOutputTokens <= 0) return amplified;
  /*
   * `Math.max(baseMaxTokens, …)` 是关键那一半：**下限是原值**。
   * 少了它，供应商报的上限比 base 小的时候就会把预算缩下去。
   */
  return Math.max(baseMaxTokens, Math.min(profile.maxOutputTokens, amplified));
}

/**
 * **空内容重试专用的预算计算**（2026-10-12 实测补上）。
 *
 * ## 为什么不能复用 `budgetFor`
 *
 * `budgetFor` 的第一行是：
 *
 * ```ts
 * if (profile?.reasoning !== true) return baseMaxTokens;
 * ```
 *
 * 对**首次调用**这是对的（非思维链模型不需要放大预算）。
 * 但它让"空内容重试"**空转**：
 *
 * | 步骤 | 实际发生 |
 * |---|---|
 * | ① | 模型（实测 `stepfun/step-5-preview`，网关报 `reasoning=false`）返回空内容（`finish_reason=length`，被截断）|
 * | ② | `ModelRouter` 把预算设成 `baseMaxTokens × 2`（**真的翻倍了**）|
 * | ③ | 重试时**又走 `budgetFor`** → `reasoning !== true` → **返回 `baseMaxTokens`** |
 * | ④ | 重试用同一份预算 → **必然再次被截断** |
 *
 * 净效果：**"翻倍重试"白花一次调用，什么都没改变。**
 *
 * 而这两种模型在本项目的 magpie 部署里**很常见**：要么网关报
 * `reasoning=false`（实测 `omen-alpha` / `step-5-preview`），要么干脆不报元数据。
 *
 * ## 这里做什么
 *
 * 既然**已经知道上一次被截断了**，就直接用更大的预算 ——
 * 不再经过"按 reasoning 判断"那道门。唯一仍然尊重的约束是
 * **模型自己报的输出上限**（超过它没有意义，供应商会拒或截断）。
 */
export function retryBudgetFor(
  profile: ModelProfile | undefined,
  boosted: number,
  /** 首次调用实际用的预算 —— 重试**不得低于**它。 */
  originalBudget: number,
): number {
  /*
   * ## 约束有两条（缺一不可）
   *
   * ① **不得低于首次** —— 我们已经知道输出被截断了，此时给更少的预算
   *    与目的正好相反。（实测被自己的测试抓到过：首次 16384、重试 8192。）
   * ② **不超过模型自己报的上限** —— 超过它没有意义（供应商会拒或照旧截断）。
   *
   * 取两者：先按上限夹，再与首次取大。若 `originalBudget` 本身已超上限
   * （那说明调用方显式要求了更大预算），以它为准 —— 尊重调用方的意图。
   */
  if (profile === undefined || profile.maxOutputTokens <= 0) {
    return Math.max(boosted, originalBudget);
  }
  const capped = Math.min(boosted, profile.maxOutputTokens);
  return Math.max(capped, originalBudget);
}

/** 从错误对象上尽力取 HTTP 状态码（不同层可能挂在 `status` 或 `statusCode`）。 */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { status?: unknown; statusCode?: unknown };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return null;
}
