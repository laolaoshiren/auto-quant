/**
 * **Jev 初筛客户端** —— 在"逐币分析"之前用 TypeSafe Jev 给每个标的打一个分。
 *
 * ## Jev 是什么（实测结论）
 *
 * 它**只输出类型化决策**（`noul` 是/否概率、`choice` 多选一、`score` 量表分），
 * 不产生任何自由文本：
 *
 * ```json
 *   POST /v1/systemone
 *   { "state": "…行情摘要…", "model": "jev-latest",
 *     "questions": { "worth": {
 *       "type": "score",
 *       "instructions": "这个标的今天值得深看吗？",
 *       "criteria": ["完全没机会","机会很小","一般","值得看","明确机会"] } } }
 * ```
 *
 * 实测返回（2026-10-18，本地 magpie）：
 *
 * ```json
 *   { "model": "jev-1.13.0",
 *     "answers": { "worth": { "type": "score", "score": 2.91, "confidence": 0.91,
 *       "legend": {"0":"完全没机会", …},
 *       "probabilities": {"0":0.0,"1":0.0,"2":0.1,"3":0.89,"4":0.01} } } }
 * ```
 *
 * ⚠️ **`score` 是 0–4 的量表位置，不是 0–1** —— 本模块统一归一化成 0–1
 * （`score / (criteria.length - 1)`），这样门槛（默认 0.5）与日志里的小数
 * 与"概率"直觉一致。
 *
 * ## 这个模块的边界
 *
 * 它**只负责打分**，不负责"筛几个"、不负责写日志、不负责碰交易决策：
 *
 * | 模块 | 职责 |
 * |---|---|
 * | 本文件 | 发请求、超时、限流、解析、归一化 |
 * | `tradingDesk.ts` | 开关、取前 N、降级、`runtime_logs` |
 *
 * ## 三条铁律（全部有测试钉住）
 *
 * 1. **任何异常都返回 `null`，绝不抛** —— 调用方据此回落到"不筛"；
 * 2. **数量对不上 / 格式不对也是 `null`** —— 宁可不用，不能用半份结果；
 * 3. **整体最多 15 秒、单次最多 8 秒、并发最多 4** —— 它是**初筛**，
 *    不能把一整轮的周期拖住（团队模式一轮还有辩论与裁决要跑）。
 */

import { readFileSync } from 'node:fs';

/** 一个待打分的标的：`digest` 是一段紧凑行情摘要（调用方负责裁剪）。 */
export interface JevInput {
  symbol: string;
  digest: string;
}

/** 一个标的的打分结果。`score` / `confidence` 都已归一化到 0–1。 */
export interface JevScore {
  symbol: string;
  /** 0–1 的"值得深看"程度（Jev 量表分归一化后的值）。 */
  score: number;
  /** Jev 自报的置信度（0–1）。 */
  confidence: number;
}

/**
 * 发给 Jev 的五级量表。
 *
 * ⚠️ **必须是 5 个**：归一化按 `criteria.length - 1` 算分母。
 * 改这个数组会同时改分数的语义 —— 所以它写成常量，不开放环境变量。
 */
export const JEV_CRITERIA = [
  '完全没机会',
  '机会很小',
  '一般',
  '值得看',
  '明确机会',
] as const;

/** `scoreSymbols` 的可选参数（全部有安全默认值）。 */
export interface JevClientOptions {
  /** Jev 服务基址（默认 `http://127.0.0.1:3425`）。 */
  baseUrl?: string;
  /** 模型名（默认 `jev-latest`）。 */
  model?: string;
  /** 单次请求超时（默认 8000ms）。 */
  requestTimeoutMs?: number;
  /** 整批超时（默认 15000ms）。 */
  totalTimeoutMs?: number;
  /** 并发上限（默认 4，且**永远不超过 4**）。 */
  concurrency?: number;
  /** 单个摘要的最大字符数（默认 4000；超出就截断，避免把 Jev 撑爆）。 */
  maxDigestChars?: number;
  /** 测试注入用的 fetch（默认全局 `fetch`）。 */
  fetchImpl?: JevFetch;
  /**
   * 网关的 Bearer token。
   *
   * ⚠️ **不传就用不了**（第一版就是没这个字段，线上每轮 401 —— 见 `JevConfig.apiKey`）。
   * 空串时 `scoreSymbols()` 直接返回 `null`，**不发无效请求**。
   */
  apiKey?: string;
}

/** 只依赖"够用"的响应形状，便于测试注入普通对象。 */
export interface JevHttpResponse {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}

/** `fetch` 的最小签名（与全局 fetch 兼容，测试可注入桩）。 */
export type JevFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<JevHttpResponse>;

export const JEV_DEFAULT_BASE = 'http://127.0.0.1:3425';
export const JEV_DEFAULT_MODEL = 'jev-latest';
export const JEV_DEFAULT_TOP_N = 6;
export const JEV_DEFAULT_MIN_SCORE = 0.5;
export const JEV_DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
export const JEV_DEFAULT_TOTAL_TIMEOUT_MS = 15_000;
export const JEV_MAX_CONCURRENCY = 4;
export const JEV_DEFAULT_MAX_DIGEST_CHARS = 4_000;

/** 从环境变量读出的开关配置（**未设置 = 关闭**）。 */
export interface JevConfig {
  enabled: boolean;
  topN: number;
  minScore: number;
  model: string;
  baseUrl: string;
  /**
   * 网关的 Bearer token。
   *
   * ⚠️ **2026-10-18 线上实测补上** —— 第一版根本没有这个字段，请求只带了
   * `Content-Type`，于是线上每一轮都 401：
   * ```
   *   runtime_logs(scope=jev)  warn | [Jev] 初筛调用失败（网络/超时/返回无法解析）
   *                                    —— 回落到不筛（全部 18 个标的照常进 LLM）
   * ```
   * 降级是对的（没有因为 Jev 挂了就少看标的），但功能等于没接上。
   * 而**测试全是桩**，所以那 13 条用例一条都没发现。
   *
   * ## 来源
   *
   * 与团队模式主 LLM **同一个网关、同一份凭据** —— 读 `MAGPIE_GATEWAY_KEY_FILE`
   * 指向的文件（部署脚本同步过来的 `caller-keys.json` 副本，格式 `[{secret:…}]`）。
   * 拿不到就是空串 ⇒ `scoreSymbols()` 直接返回 `null`（不白发请求）。
   */
  apiKey: string;
}

/**
 * 解析环境变量。**永不抛**，非法值退回默认值。
 *
 * ⚠️ 默认值必须让"什么都没设"等于**完全关闭** —— 这是它能上实盘的前提。
 */
export function readJevConfig(env: NodeJS.ProcessEnv = process.env): JevConfig {
  /*
   * ⚠️ **空字符串必须当成"没设置"**：`Number('')` 是 0，而 0 对 minScore
   * 是一个**合法且危险**的值（等于没有门槛）—— 一个 `AQ_JEV_MIN_SCORE=`
   * 的占位写法会静默把门槛关掉。所以先判空再转数字。
   */
  const parseNumber = (raw: string | undefined): number => {
    if (raw === undefined || raw.trim() === '') return Number.NaN;
    return Number(raw);
  };
  const topRaw = parseNumber(env.AQ_JEV_TOP_N);
  const topN =
    Number.isFinite(topRaw) && topRaw >= 1 ? Math.floor(topRaw) : JEV_DEFAULT_TOP_N;

  const minRaw = parseNumber(env.AQ_JEV_MIN_SCORE);
  const minScore =
    Number.isFinite(minRaw) && minRaw >= 0 && minRaw <= 1
      ? minRaw
      : JEV_DEFAULT_MIN_SCORE;

  const model = (env.AQ_JEV_MODEL ?? '').trim() || JEV_DEFAULT_MODEL;
  const baseUrl = (env.AQ_JEV_BASE ?? '').trim() || JEV_DEFAULT_BASE;

  return {
    enabled: env.AQ_JEV_PREFILTER === 'on',
    topN,
    minScore,
    model,
    baseUrl,
    apiKey: readGatewayKey(env),
  };
}

/**
 * 从 `MAGPIE_GATEWAY_KEY_FILE` 读网关 key（与团队主 LLM 同一份）。
 *
 * 文件格式（magpie 的 `caller-keys.json`，部署脚本同步的那份）：
 * ```json
 *   [{ "secret": "mk-…" }, …]
 * ```
 * 也兼容 `{"secret":"…"}` 与裸字符串。**任何异常都返回空串**（调用方据此跳过，不发无效请求）。
 *
 * ⚠️ 只在**开关打开时**才读 —— 关着的时候连文件都不碰。
 */
function readGatewayKey(env: NodeJS.ProcessEnv): string {
  if (env.AQ_JEV_PREFILTER !== 'on') return '';
  const path = (env.MAGPIE_GATEWAY_KEY_FILE ?? '').trim();
  if (path === '') return '';
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item !== null && typeof item === 'object' && typeof (item as { secret?: unknown }).secret === 'string') {
          const s = (item as { secret: string }).secret.trim();
          if (s.length > 0) return s;
        }
      }
      return '';
    }
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { secret?: unknown }).secret === 'string') {
      return (parsed as { secret: string }).secret.trim();
    }
    if (typeof parsed === 'string') return parsed.trim();
    return '';
  } catch {
    /* 读不到（文件不存在 / 权限 / JSON 坏了）⇒ 空串，调用方会跳过。 */
    return '';
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/** 把基址规范成"到 `/v1` 为止"——用户填不填 `/v1` 都能用。 */
function endpointUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base === '') return `${JEV_DEFAULT_BASE}/v1/systemone`;
  return /\/v1$/i.test(base) ? `${base}/systemone` : `${base}/v1/systemone`;
}

/**
 * 并发地跑 `fn`，**最多同时 `limit` 个**；保持输入顺序。
 *
 * ⚠️ 不复用 `trader/agent/pool.ts` 的 `mapConcurrent`：`llm/` 是**下层**，
 * 反向依赖 `trader/` 会把层次弄反（那正是这个仓库反复强调的分层纪律）。
 * 这段只有十来行，留在本文件更安全。
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  /* ⚠️ 必须先初始化再创建工人：async 函数体在第一个 `await` 之前是**同步执行**的。 */
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      /* 共享下标领取（work-stealing 的最简形态）—— 避免"最慢那一批"的尾巴。 */
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 解析一次 Jev 响应；任何不符合契约的形状都给 `null`。 */
function parseAnswer(json: unknown): { score: number; confidence: number } | null {
  if (typeof json !== 'object' || json === null) return null;
  const answers = (json as { answers?: unknown }).answers;
  if (typeof answers !== 'object' || answers === null) return null;
  const answer = (answers as Record<string, unknown>).worth;
  if (typeof answer !== 'object' || answer === null) return null;
  const a = answer as Record<string, unknown>;
  /*
   * 严格认 `type === "score"`：若服务端换了题型（例如返回 `noul`），
   * 字段含义就变了 —— 那种时候必须回落，而不是猜一个分数。
   */
  if (a.type !== 'score') return null;
  const rawScore = a.score;
  const confidence = a.confidence;
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  const scale = JEV_CRITERIA.length - 1;
  return { score: clamp01(rawScore / scale), confidence: clamp01(confidence) };
}

/**
 * **给一批标的打分**（Jev 初筛的底层客户端）。
 *
 * @returns 与输入**同序**、同长度；任何异常（网络、超时、非 200、JSON 形状不对、
 *          某个标的失败）都返回 **`null`** —— 调用方必须回落到"不筛"。
 *
 * ⚠️ 只要有一个标的失败就整批 `null`：用"半份分数"去决定谁进 LLM，
 * 会让"没拿到分"的标的被**静默排除**，那正是本仓库最反对的失败形状。
 */
export async function scoreSymbols(
  inputs: readonly JevInput[],
  options: JevClientOptions = {},
): Promise<JevScore[] | null> {
  if (inputs.length === 0) return [];

  const baseUrl = options.baseUrl?.trim() || JEV_DEFAULT_BASE;
  const model = options.model?.trim() || JEV_DEFAULT_MODEL;
  const apiKey = options.apiKey?.trim() ?? '';
  const requestTimeoutMs = positiveInt(
    options.requestTimeoutMs,
    JEV_DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const totalTimeoutMs = positiveInt(options.totalTimeoutMs, JEV_DEFAULT_TOTAL_TIMEOUT_MS);
  const concurrency = Math.min(
    JEV_MAX_CONCURRENCY,
    positiveInt(options.concurrency, JEV_MAX_CONCURRENCY),
  );
  const maxDigestChars = positiveInt(
    options.maxDigestChars,
    JEV_DEFAULT_MAX_DIGEST_CHARS,
  );
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as JevFetch);
  if (typeof doFetch !== 'function') return null;

  const url = endpointUrl(baseUrl);
  const master = new AbortController();
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const totalTimeout = new Promise<null>((resolve) => {
    totalTimer = setTimeout(() => {
      /* 整体超时：先掐断在途请求，再让调用方拿到 null。 */
      master.abort();
      resolve(null);
    }, totalTimeoutMs);
  });

  const callOne = async (input: JevInput): Promise<JevScore | null> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const perCallTimeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, requestTimeoutMs);
    });

    const digest =
      input.digest.length > maxDigestChars
        ? `${input.digest.slice(0, maxDigestChars)}\n…（摘要已截断）`
        : input.digest;
    const state = `标的：${input.symbol}\n${digest}`;
    const body = JSON.stringify({
      state,
      model,
      questions: {
        worth: {
          type: 'score',
          /*
           * ⚠️⚠️ **提问必须写清"我们按什么筛"，不能只说"值得看吗"**（2026-10-18 实测修正）
           *
           * 第一版就是那句模糊的「这个标的今天值得深看吗？」。实测后果：
           * ```
           *   Jev 5 次里有 3 次把 BTCUSDT 筛掉（平均 0.31）、2 次筛掉 SOLUSDT（0.30）
           *   而策略配置恰恰给 BTC/ETH **5 倍于山寨币**的仓位上限
           *   ⇒ Jev 的偏好与我们的策略意图【相反】
           * ```
           * 原因不是 Jev 差，而是**它不知道我们在找什么**：它只看到一段 K 线摘要，
           * 却要回答一个没有标准的开放问题。它于是按通用直觉打分 —— 而通用直觉
           * 会偏爱"故事性强的小币"，恰恰不是我们的口径。
           *
           * ⇒ 现在把团队的真实筛选标准写进 instructions：问了什么，才答得准什么。
           */
          /*
           * ⚠️⚠️ **必须用肯定句，不能用否定句**（2026-10-18 · 查 TypeSafe 官方限制页后改）
           *
           * TypeSafe 发布的 Jev 1.13 限制说明里明确列了：
           * > 弱点包括**否定与隐含语义**（negations or implied meaning）——
           * > Jev 按字面读，可能**漏掉一个"不"字**。
           *
           * 我第一版写的是：
           * ```
           *   不要因为"某个币名气大/活跃"就加分，也不要因为"没听说过"就减分
           * ```
           * 三个否定（不要 / 不要 / 没见过）挤在一句里 —— 对 Jev 是最坏的形状。
           *
           * ⇒ 全部改成**正面陈述"按什么排序"**：
           *   把"不要看名气"换成"排序依据是摘要里的四个数字"，
           *   把"不要减分"换成"名气不参与排序"。
           */
          instructions:
            '这是一个加密货币合约标的的行情摘要。判断目标：这个标的今天出现可执行交易机会的可能性。' +
            '排序依据只有摘要里的四个数字：' +
            '① 位移幅度 —— 近几根涨跌幅的绝对值落在中等区间时机会最好（绝对值很小代表无方向，绝对值很大代表行情已走完）；' +
            '② 波动率 —— ATR 占价格的比例落在中等区间时机会最好（比例很高代表风险失控，比例很低代表价格停滞）；' +
            '③ 结构位置 —— 有明确支撑阻力关系、且价格处在可执行的一侧时机会更好；' +
            '④ 异常信号 —— 出现放量或方向突变时，按上面三条重新评估。' +
            '排序只看这四个数字。币种名称与市值大小不参与排序。',
          criteria: [...JEV_CRITERIA],
        },
      },
    });

    try {
      const signal = AbortSignal.any([master.signal, controller.signal]);
      const response = await Promise.race([
        doFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            /* ⚠️ 必须带 —— 第一版漏了，线上每轮 401（见 JevConfig.apiKey 的说明）。 */
            ...(apiKey !== '' ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body,
          signal,
        }),
        perCallTimeout,
      ]);
      /* `null` 是"这一次超时了"的哨兵值（不是合法响应）。 */
      if (response === null || !response.ok) return null;
      const json = await response.json();
      const parsed = parseAnswer(json);
      if (parsed === null) return null;
      return { symbol: input.symbol, score: parsed.score, confidence: parsed.confidence };
    } catch {
      /* 网络错误 / abort / JSON 解析失败 —— 一律当作"这次没拿到分"。 */
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  };

  const work = (async (): Promise<JevScore[] | null> => {
    const results = await mapWithLimit(inputs, concurrency, (input) => callOne(input));
    /* 任何一个失败 → 整批不可用（见函数注释）。 */
    if (results.some((r) => r === null)) return null;
    return results as JevScore[];
  })().catch(() => null);

  try {
    return await Promise.race([work, totalTimeout]);
  } finally {
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    master.abort();
  }
}

/**
 * 纯函数：从打分结果里选出"分数最高的前 N 个（且不低于门槛）"。
 *
 * @returns `null` 表示**没有任何标的过门槛** —— 调用方必须据此回落，
 *          绝不能把"0 个"当成"全都不值得看"。
 *
 * ## 两条排序纪律
 *
 * · 先按 `score` **降序**取前 N（分数相同按输入顺序，保证可复现）；
 * · 返回的**下标保持输入顺序** —— 下游的切片本来就有"从强到弱"的语义，
 *   这里再排一次会让材料顺序与候选顺序漂移。
 */
export function selectTopScores(
  scores: readonly JevScore[],
  topN: number,
  minScore: number,
): { keptIndexes: number[]; dropped: JevScore[] } | null {
  const passed = scores
    .map((score, index) => ({ score, index }))
    .filter((x) => x.score.score >= minScore);
  if (passed.length === 0) return null;

  const limit = Math.max(1, Math.floor(topN));
  const winners = passed
    .sort((a, b) => b.score.score - a.score.score || a.index - b.index)
    .slice(0, limit);
  const kept = new Set(winners.map((x) => x.index));

  return {
    keptIndexes: scores.map((_, i) => i).filter((i) => kept.has(i)),
    dropped: scores.filter((_, i) => !kept.has(i)),
  };
}

/** 回落原因（给调用方写 `runtime_logs` 用）。 */
export type JevFallbackReason =
  | 'disabled'
  | 'empty'
  | 'scorer-failed'
  | 'count-mismatch'
  | 'format-error'
  | 'all-below-threshold';

/** `prefilterSymbols` 的返回。`applied=false` 时 `keep` 一定是**全部下标**。 */
export interface JevPrefilterResult {
  /** 要保留的输入下标（**保持输入顺序**）。回落时是全部下标。 */
  keep: number[];
  /** 是否真的按 Jev 筛选了。`false` = 原样全部进 LLM。 */
  applied: boolean;
  /** `applied=false` 且开关开启时的原因；开关关闭时为 `disabled`。 */
  reason: JevFallbackReason | null;
  scores: JevScore[] | null;
  dropped: JevScore[];
  highest: number | null;
  lowest: number | null;
  elapsedMs: number;
}

export interface JevPrefilterOptions {
  enabled: boolean;
  topN: number;
  minScore: number;
  baseUrl?: string;
  model?: string;
  /** 网关 Bearer token（见 `JevClientOptions.apiKey`）。不传 = 请求会 401。 */
  apiKey?: string;
  /** 测试注入；默认 `scoreSymbols`。 */
  scorer?: (
    inputs: readonly JevInput[],
    options: JevClientOptions,
  ) => Promise<JevScore[] | null>;
  clientOptions?: JevClientOptions;
}

/**
 * **初筛总入口**：开关、调用、校验、选择、回落，一处做完。
 *
 * 这样 `tradingDesk.ts` 只需要"拿结果、写日志"，而测试可以直接钉住
 * 五种情形（正常 / 超时 / 格式错 / 全低于门槛 / 开关关闭）。
 *
 * ## 回落铁律（本函数的核心）
 *
 * 下列任一情形 → `applied: false` + `keep: 全部下标`：
 * · 开关关闭（**一个请求都不发**）；
 * · `scoreSymbols` 返回 `null`（超时/网络/格式）；
 * · 返回数量与输入不符；
 * · 分数/标的对不上；
 * · **全部低于门槛**。
 *
 * ⚠️ 最后一条尤其重要：**绝不允许"Jev 说都不值得"就一个标的都不分析** ——
 * 那等于让一个实验功能掐死整个团队。
 */
export async function prefilterSymbols(
  inputs: readonly JevInput[],
  options: JevPrefilterOptions,
): Promise<JevPrefilterResult> {
  const allIndexes = inputs.map((_, i) => i);
  const startedAt = Date.now();
  const base = {
    scores: null as JevScore[] | null,
    dropped: [] as JevScore[],
    highest: null as number | null,
    lowest: null as number | null,
  };

  if (!options.enabled) {
    return {
      keep: allIndexes,
      applied: false,
      reason: 'disabled',
      ...base,
      elapsedMs: Date.now() - startedAt,
    };
  }
  if (inputs.length === 0) {
    return {
      keep: [],
      applied: false,
      reason: 'empty',
      ...base,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const scorer = options.scorer ?? scoreSymbols;
  /* 顶层 baseUrl/model 只**覆盖**已给的值，不把 clientOptions 里的值抹成 undefined。 */
  const clientOptions: JevClientOptions = { ...options.clientOptions };
  if (options.baseUrl !== undefined) clientOptions.baseUrl = options.baseUrl;
  if (options.model !== undefined) clientOptions.model = options.model;
  /*
   * ⚠️ **apiKey 必须一路传下去**（2026-10-18 线上实测）。
   * 第一版 `JevPrefilterOptions` 里没有这个字段，于是即使 `JevConfig.apiKey` 读到了 key，
   * `scoreSymbols()` 收到的 `options.apiKey` 仍是 undefined ⇒ 请求不带 Authorization ⇒ 401。
   * 这类"读了但没传"的断链，只有真的打一次线上才发现得了。
   */
  if (options.apiKey !== undefined) clientOptions.apiKey = options.apiKey;

  let scores: JevScore[] | null = null;
  try {
    scores = await scorer(inputs, clientOptions);
  } catch {
    scores = null;
  }
  const elapsedMs = Date.now() - startedAt;

  const fallback = (reason: JevFallbackReason, s: JevScore[] | null): JevPrefilterResult => ({
    keep: allIndexes,
    applied: false,
    reason,
    scores: s,
    dropped: [],
    highest: s !== null && s.length > 0 ? Math.max(...s.map((x) => x.score)) : null,
    lowest: s !== null && s.length > 0 ? Math.min(...s.map((x) => x.score)) : null,
    elapsedMs,
  });

  if (scores === null) return fallback('scorer-failed', null);
  if (!Array.isArray(scores) || scores.length !== inputs.length) {
    return fallback('count-mismatch', Array.isArray(scores) ? scores : null);
  }
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]!;
    if (
      typeof s !== 'object' ||
      s === null ||
      s.symbol !== inputs[i]!.symbol ||
      typeof s.score !== 'number' ||
      !Number.isFinite(s.score) ||
      s.score < 0 ||
      s.score > 1 ||
      typeof s.confidence !== 'number' ||
      !Number.isFinite(s.confidence)
    ) {
      return fallback('format-error', scores);
    }
  }

  /*
   * 门槛是 0–1 的归一化分。`>=` 而不是 `>`：门槛写 0.5 时，
   * 恰好 0.5 的标的**应当留下**（否则用户会觉得门槛"差一点"很别扭）。
   */
  const selection = selectTopScores(scores, options.topN, options.minScore);
  if (selection === null) return fallback('all-below-threshold', scores);

  return {
    keep: selection.keptIndexes,
    applied: true,
    reason: null,
    scores,
    dropped: selection.dropped,
    highest: Math.max(...scores.map((x) => x.score)),
    lowest: Math.min(...scores.map((x) => x.score)),
    elapsedMs,
  };
}
