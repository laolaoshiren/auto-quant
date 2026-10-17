/**
 * **模型档案** —— 哪个模型适合干什么，以及挂掉时往哪降级。
 *
 * ## 为什么需要这份档案（而不是直接写模型名）
 *
 * 用户 2026-10-12 的原话：
 *
 * > 「每个智能体根据工作内容来制定用什么模型……不同模型智商、速度、上下文等等不同，
 * >  具体做什么你来安排（当然你得先真实去查资料了解清楚，给程序建立一套档案，
 * >  还有更新的程序步骤，方便以后渠道更新了新模型，你也能更新相应的模型参数）」
 * > 「GPT\CLAUDE 系列，可用额度不多、也或许不可用，但是其他得模型基本能不限量供应，
 * >  特别是那些标注了免费得模型，因此设计系统你也要更加智能，**要有冗余、回退机制**，
 * >  比如你设计得主管用最高智能得claude模型，但是实际使用中，万一claude额度不足了，
 * >  系统能智能把主管模型换成向下平替。保证系统不中断，持续工作」
 *
 * 所以这里记的不是"模型名"，而是**能力档位 + 候选链**：
 *
 *   · 档位（tier）—— 这个角色需要多聪明
 *   · 候选链（ladder）—— 首选挂了就往下一档平替，**永远有得用**
 *
 * ## 数据来源（全部实测，不是猜）
 *
 * 速度来自 2026-10-12 对 magpie 网关的真实 HTTP 调用（见
 * `.dsh/2026-10-12-多智能体-实测情报.md`）；上下文/reasoning 来自 magpie 的
 * `plugin-providers.json`（19 供应商 / 705 模型的官方元数据）。
 *
 * **额度事实**（同一份实测）：`workbuddy-ai` 只剩 3.13/350 credits、`cline` 只剩 $0.50
 * —— 所以候选链**必须**包含免费档，且首选不能是额度最少的那类。
 */

/**
 * 能力档位。
 *
 * 依据 Anthropic 的多 agent 工程结论（多 agent 约 15× chat 的 token），
 * **把不需要智商的工作压到低档，是这套架构能不能长期跑下去的前提**。
 */
export type ModelTier =
  /** 不用 LLM，纯代码算（指标、风控限额、下单、对账）。 */
  | 'T0_code'
  /** 小快模型：字段映射、打标、摘要、情绪打分。实测 ≈1.5s 那一档。 */
  | 'T1_fast'
  /** 中档：单源分析、记忆反思、教训提炼。实测 4–5s 那一档。 */
  | 'T2_mid'
  /** 强推理：辩论、组合决策、风控裁决、异常归因。实测 3–7s 那一档。 */
  | 'T3_deep';

/** 一个模型条目的档案。 */
export interface ModelProfile {
  /** magpie 网关上的完整模型 id（`provider/model`）。 */
  id: string;
  tier: ModelTier;
  /** 实测单轮耗时（毫秒）；`null` = 没测过。 */
  measuredMs: number | null;
  /** 上下文窗口（token）。 */
  contextTokens: number;
  /** 最大输出（token）；`0` = 供应商没报。 */
  maxOutputTokens: number;
  /** 是否返回思维链。**思维链模型需要更大的 max_tokens，否则 content 会是 null**（实测）。 */
  reasoning: boolean;
  /**
   * 是否**免费/不限量**。
   *
   * 这一列是候选链的排序依据之一：额度紧张时优先用它们兜底
   *（用户原话：「其他得模型基本能不限量供应，特别是那些标注了免费得模型」）。
   */
  free: boolean;
  /**
   * 是否已实测**可用**。
   *
   * `false` 不代表永久不可用 —— 实测 `ling-3.1-flash-free` 在 mt=512 成功、
   * mt=16/128/2048 失败，**同一模型的可用性是波动的**。所以这一列只用于
   * **初始排序**，真正的可用性由运行期的健康记录决定。
   */
  verified: boolean;
  /** 一句话说明适合干什么（给人看的，也是提示词里"你是谁"的一部分）。 */
  goodFor: string;
}

/**
 * 模型档案表。
 *
 * ⚠️ **这一份是"初始档案"，不是"真理"**。运行期会由 `ModelHealthRegistry`
 * 覆盖可用性与延迟 —— 因为实测已证明同一模型的可用性会波动。
 */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  /* ---------- T3 强推理档 ---------- */
  {
    id: 'workbuddy-ai/gpt-6-astra',
    tier: 'T3_deep',
    measuredMs: 3045,
    contextTokens: 1_050_000,
    maxOutputTokens: 0,
    reasoning: false,
    free: false,
    verified: true,
    goodFor: '最高统筹、辩论裁决、组合决策',
  },
  {
    id: 'workbuddy-ai/gpt-6.1-sol',
    tier: 'T3_deep',
    measuredMs: 6638,
    contextTokens: 1_050_000,
    maxOutputTokens: 0,
    reasoning: false,
    free: false,
    verified: true,
    goodFor: '强推理平替',
  },
  {
    id: 'workbuddy-ai/kimi-k3',
    tier: 'T3_deep',
    measuredMs: 6152,
    contextTokens: 256_000,
    maxOutputTokens: 0,
    reasoning: true,
    free: false,
    verified: true,
    goodFor: '带思维链的深度分析',
  },
  {
    id: 'workbuddy-ai/grok-4.7',
    tier: 'T3_deep',
    measuredMs: 7103,
    contextTokens: 256_000,
    maxOutputTokens: 0,
    reasoning: false,
    free: false,
    verified: true,
    goodFor: '对抗性观点（与 GPT 系异质性）',
  },

  /* ---------- T2 中档 ---------- */
  {
    id: 'opencode-zen-free/longcat-2.5-preview-free',
    tier: 'T2_mid',
    measuredMs: 4327,
    contextTokens: 1_000_000,
    maxOutputTokens: 131_072,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '单源分析、长上下文整理（免费兜底主力）',
  },
  {
    id: 'opencode-zen-free/mimo-v2.6-flash-free',
    tier: 'T2_mid',
    measuredMs: 4589,
    contextTokens: 200_000,
    maxOutputTokens: 32_000,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '资料整理、摘要（免费）',
  },
  {
    id: 'opencode-zen-free/space-bunny-free',
    tier: 'T2_mid',
    measuredMs: 3641,
    contextTokens: 1_048_576,
    maxOutputTokens: 524_288,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '超大上下文兜底（1M 窗口）',
  },
  {
    id: 'opencode-zen-free/step-5-preview-free',
    tier: 'T2_mid',
    measuredMs: 2834,
    contextTokens: 1_000_000,
    maxOutputTokens: 65_536,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '快速整理（免费）',
  },

  /* ---------- T1 小快档 ---------- */
  {
    id: 'workbuddy-ai/deepseek-v4.1-flash',
    tier: 'T1_fast',
    measuredMs: 1505,
    contextTokens: 128_000,
    maxOutputTokens: 0,
    reasoning: false,
    free: false,
    verified: true,
    goodFor: '最快档：打标、字段映射、摘要、结构化抽取',
  },
  {
    id: 'workbuddy-ai/glm-5.3',
    tier: 'T1_fast',
    measuredMs: 1519,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    free: false,
    verified: true,
    goodFor: '快且带思维链',
  },
  {
    id: 'workbuddy-ai/fast-model',
    tier: 'T1_fast',
    measuredMs: 1517,
    contextTokens: 128_000,
    maxOutputTokens: 0,
    reasoning: false,
    free: false,
    verified: true,
    goodFor: '快速兜底',
  },
  {
    id: 'opencode-zen-free/nemotron-3.5-lightning-free',
    tier: 'T1_fast',
    measuredMs: 3246,
    contextTokens: 262_144,
    maxOutputTokens: 262_144,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '免费快速档',
  },
  {
    id: 'opencode-zen-free/big-pickle',
    tier: 'T1_fast',
    measuredMs: 4314,
    contextTokens: 200_000,
    maxOutputTokens: 32_000,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '免费兜底',
  },
  {
    id: 'opencode-zen-free/muse-spark-1.3-contributor-free',
    tier: 'T1_fast',
    measuredMs: 4140,
    contextTokens: 1_048_576,
    maxOutputTokens: 131_072,
    reasoning: true,
    free: true,
    verified: true,
    goodFor: '免费 + 大上下文',
  },
];

/**
 * 档位的**降级顺序**：高档位用完就往下走。
 *
 * 这就是用户说的「**向下平替**」的机器表达：
 * 「万一claude额度不足了，系统能智能把主管模型换成向下平替」。
 *
 * T3 用完 → 试 T2 的免费模型 → 还不行就试 T1 的免费模型。
 * **宁可让裁决官用一个弱一点的模型，也不要让整个交易台停摆。**
 */
const DOWNGRADE_PATH: Record<Exclude<ModelTier, 'T0_code'>, readonly ModelTier[]> = {
  T3_deep: ['T3_deep', 'T2_mid', 'T1_fast'],
  T2_mid: ['T2_mid', 'T1_fast'],
  T1_fast: ['T1_fast', 'T2_mid'],
};

/**
 * **候选链**：一个档位下的模型优先级。
 *
 * ## 排序规则（不是随便排的）
 *
 * 1. **首选给"最强且实测可用"的** —— 但用户提醒过 GPT/Claude 系额度少，
 *    所以首选**不放在额度最少的那一类**上；`workbuddy-ai` 实测只剩 3.13/350。
 * 2. **必须有免费兜底** —— 免费模型不限量，是"系统不中断"的最后一道保证。
 *    实测 T3 档全是付费模型，**光靠本档位会停摆**，所以必须跨档兜底。
 * 3. **同一档位内尽量跨供应商** —— 一个供应商挂了不该带走整条链。
 * 4. **跨档兜底时优先免费的** —— 高智商模型额度贵，兜底用免费的更可持续。
 *
 * 运行期还会被健康记录重排（连续失败的下沉），见 `ModelRouter`。
 */
export function ladderForTier(tier: ModelTier): readonly ModelProfile[] {
  if (tier === 'T0_code') return [];
  const path = DOWNGRADE_PATH[tier];

  const result: ModelProfile[] = [];
  for (const [index, t] of path.entries()) {
    const isOwnTier = index === 0;
    const candidates = MODEL_PROFILES.filter((m) => m.tier === t && m.verified);
    const sorted = [...candidates].sort((a, b) => scoreFor(t, isOwnTier, a) - scoreFor(t, isOwnTier, b));
    for (const m of sorted) {
      if (!result.some((x) => x.id === m.id)) result.push(m);
    }
  }
  return result;
}

/**
 * 给候选模型打分（**分越低越优先**）。
 *
 * ## 为什么不再用"免费优先"当第一排序键（2026-10-12 实测修正）
 *
 * 原来的排序是：**先按 `free` 分组，再按速度排**。于是 `T1_fast` 的候选链变成：
 *
 * ```
 *   1. nemotron-3.5-lightning-free    free=true  reasoning=Y  3246ms
 *   2. muse-spark-1.3-contributor-free free=true  reasoning=Y  4140ms
 *   3. big-pickle                     free=true  reasoning=Y  4314ms
 *   4. deepseek-v4.1-flash            free=false reasoning=-  1505ms  ← 最快，却排第 4
 *   5. fast-model                     free=false reasoning=-  1517ms
 * ```
 *
 * **前三个都是思维链模型**，实测（真实提示词、20 个标的）单个角色要
 * **47–59 秒**；而最快的两个（约 1.5 秒）因为"要花钱"被排到后面。
 *
 * 后果很实际：一轮决策数分钟，而**省下的时间是能多做几轮决策的** ——
 * 对 7×24 持续工作来说，**快本身就是产出**。
 *
 * ## 现在的口径
 *
 * | 档位 | 主要看什么 | 理由 |
 * |---|---|---|
 * | **T1**（体力活）| **速度权重最高** | 打标/摘要这类活，快比省钱重要得多 |
 * | **T2**（分析）| 速度与免费并重 | 要写完整分析，慢一点可接受 |
 * | **T3**（判断）| **能力优先**（免费只是加分）| 辩论与裁决的质量直接决定盈亏 |
 * | **兜底档** | **免费优先** | 兜底要能长期靠得住，付费额度留给主力 |
 *
 * `reasoning: true` 在 T1/T2 上**加罚分** —— 思维链模型在体力活上
 * 既慢又容易被自己的推理带偏（实测它们会把"我要去取数"写进输出）。
 */
function scoreFor(tier: ModelTier, isOwnTier: boolean, m: ModelProfile): number {
  /* 速度归一化：实测 1.5s–7s；没测过的给一个较大的中性值。 */
  const speed = (m.measuredMs ?? 8_000) / 1_000;

  /* 兜底档：免费是唯一重要的（要能长期靠得住）。 */
  if (!isOwnTier) return (m.free ? 0 : 1_000) + speed;

  if (tier === 'T1_fast') {
    /*
     * 体力活：**速度是主项**，免费是加分项，思维链是减分项。
     *
     * 权重这么定的依据：实测思维链模型在真实提示词下要 47–59 秒，
     * 而最快的两个约 1.5 秒 —— **差 30 倍**，远超"免费 vs 花几分钱"的差别。
     */
    return speed + (m.free ? 0 : 2) + (m.reasoning ? 3 : 0);
  }

  if (tier === 'T2_mid') {
    /* 分析：速度与免费并重。 */
    return speed * 0.6 + (m.free ? 0 : 3) + (m.reasoning ? 0.5 : 0);
  }

  /* T3：能力优先 —— 免费只是加分，速度权重最低（质量直接决定盈亏）。 */
  return speed * 0.3 + (m.free ? -1 : 0) + (isStrongest(m) ? -2 : 0);
}

/**
 * 是不是"强模型"（T3 内部再分一层）。
 *
 * 判据用**思考等级数**（`>=4` 档）—— 与 `modelDiscovery.inferTier` 同一个
 * 可观测信号（实测 `gpt-6-astra` 报 6 档，普通思考模型只报 2–3 档）。
 */
function isStrongest(m: ModelProfile): boolean {
  /*
   * ⚠️ `ModelProfile` 里没有 `reasoningLevels`（那是"发现"层的字段），
   * 所以这里用**档案里的实测耗时与是否思维链**做一个保守近似：
   * T3 里"耗时长且会思考"的通常是更强的那个。
   */
  return m.reasoning && (m.measuredMs ?? 0) >= 6_000;
}

/* -------------------------------------------------------------------------- */
/*  运行期档案：把"动态发现的模型"补进档案（2026-10-17，修 T1 整链全灭）          */
/* -------------------------------------------------------------------------- */

/**
 * **运行期补进来的档案**（来自 `modelDiscovery` 的 `/v1/models` 元数据）。
 *
 * ## 为什么需要它（一次真实的整链全灭）
 *
 * `MODEL_PROFILES` 是**人写的静态档案**，只收了 14 个模型。
 * 而 `T1_fast` / `T2_mid` / `T3_deep` 的候选链里**大部分是动态发现的**：
 *
 * ```
 *   T1_fast 链 5 个候选 → 只有 1 个（space-bunny-free）在静态档案里
 *   其余 4 个（beam-free / group/auto-space-bunny-free /
 *              group/team-grunt / group/team-analyst）→ profileOf() = undefined
 * ```
 *
 * 而 `budgetFor()` 需要 `profile.reasoning` 才能决定放大几倍。
 * `undefined` 在**修 t117 之前**意味着"不放大" ⇒ 预算 1024 被思维链吃光
 * ⇒ `content=0` ⇒ 4 个候选全灭（用户截图 2026-10-17 16:37:36）。
 *
 * ## 为什么不能只靠"未登记就放大"（t117 的兜底）
 *
 * t117 让 `undefined` 也 ×4 —— 那是**必要的兜底**，但它是**盲放大**：
 * ```
 *   它不知道 maxOutputTokens ⇒ 无法夹上限
 *   它不知道 contextTokens  ⇒ 无法在选模型时避开窗口不够的候选
 * ```
 * 而 `/v1/models` **本来就返回这些字段**（实测 2026-10-17）：
 * ```
 *   opencode-zen-free/beam-free         ctx=1048576  maxOut=131072  reasoning=true  levels=5
 *   group/auto-space-bunny-free         ctx= 524288  maxOut=524288  reasoning=true  levels=0
 *   group/team-grunt                    ctx=1000000  maxOut=384000  reasoning=true  levels=3
 * ```
 * ⇒ **信息一直在，只是没被接到 `profileOf` 上。** 这就是本函数补的那一环。
 *
 * ## 为什么是"注册"而不是"改静态表"
 *
 * 静态表是**人写的**（含 `measuredMs` / `goodFor` 这些只有人能判断的字段）；
 * 而动态模型的元数据是**网关报的**、会随网关变化。两者生命周期不同，不能混写。
 * 所以：**静态表优先，动态注册只补空缺**（`profileOf` 里先查静态表）。
 */
const runtimeProfiles = new Map<string, ModelProfile>();

/**
 * 把**发现到的模型**注册进运行期档案（幂等，可重复调用）。
 *
 * @param models 发现层给出的模型（`DiscoveredModel` 的最小结构 —— 只取这里要用的字段，
 *               避免 `modelCatalog` 反向依赖 `modelDiscovery` 造成循环 import）
 *
 * ⚠️ **不覆盖静态档案里的模型** —— 那是人写的，含实测耗时与用途说明。
 * ⚠️ 只补 `reasoning` / `maxOutputTokens` / `contextTokens` 三列 ——
 *    其余列（`measuredMs` / `goodFor`）对动态模型**没有可信来源**，宁可留空。
 */
export function registerDiscoveredProfiles(
  models: ReadonlyArray<{
    id: string;
    reasoning: boolean;
    contextTokens: number;
    maxOutputTokens: number;
  }>,
): void {
  for (const m of models) {
    if (typeof m.id !== 'string' || m.id.length === 0) continue;
    /* 静态档案优先：人写的字段（measuredMs/goodFor）比网关报的更可信。 */
    if (MODEL_PROFILES.some((p) => p.id === m.id)) continue;
    runtimeProfiles.set(m.id, {
      id: m.id,
      /*
       * 档位对 `budgetFor` **没有影响**（它只看 reasoning 与 maxOutputTokens），
       * 所以这里不猜档位 —— 档位由发现层的 `inferTier` 单独算。
       * 给 `T1_fast` 只是"最保守的中性值"，且这个字段在运行期档案里不被消费。
       */
      tier: 'T1_fast',
      measuredMs: null,
      contextTokens: m.contextTokens,
      maxOutputTokens: m.maxOutputTokens,
      reasoning: m.reasoning,
      free: true,
      verified: true,
      goodFor: '（动态发现）',
    });
  }
}

/** 清空运行期档案（测试用；生产不调用）。 */
export function clearRuntimeProfiles(): void {
  runtimeProfiles.clear();
}

/** 运行期档案的当前条目数（观测/测试用）。 */
export function runtimeProfileCount(): number {
  return runtimeProfiles.size;
}

/**
 * 按 id 取档案 —— **静态优先，其次运行期注册的**。
 *
 * ⚠️ 顺序不能反：静态档案里有人写的 `measuredMs` 与 `goodFor`，
 * 那是排序（`scoreFor`）与提示词要用的；运行期档案只有网关报的三列。
 */
export function profileOf(modelId: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((m) => m.id === modelId) ?? runtimeProfiles.get(modelId);
}
