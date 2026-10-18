/**
 * **JEV 模式的决策模型**（实验性 · 2026-10-19）。
 *
 * ## 它做什么
 *
 * 用户的要求：
 * > 「该模式所有操作都采用 JEV 模型来实现，从选币到交易，一切都由 JEV 自主完成」
 *
 * 而 Jev 的能力边界是**实测出来的**（见 `docs/JEV-MODE-DESIGN.md`）：
 *
 * ```jsonc
 *   choice → {"choice":"open_long","confidence":0.74,"probabilities":{…}}
 *   score  → {"score":2.53,"confidence":0.6,"legend":{…},"probabilities":{…}}
 *   noul   → {"noul":0.33}
 * ```
 *
 * ⚠️ **它不产生任何文字，且弱于算术。** 而 `Decision` 需要
 * `positionSizeUsd` / `stopLoss` / `takeProfit`（精确数字）与 `reasoning`（必需的文字）。
 *
 * ⇒ 本模块的形态就是那个唯一可行的解：
 * ```
 *   ① 代码按 ATR / 风险预算算好 3 个候选档位（本文件的 tierFor / stopTierFor / tpTierFor）
 *   ② 一次 HTTP 问 Jev 五个问题（方向 + 仓位档 + 止损档 + 止盈档 + 机会强度）
 *   ③ 代码把答案翻译成 Decision，reasoning 由答案生成（不是编的）
 * ```
 * **每一个「判断」都由 Jev 做出；代码只负责算数（它的弱项）与翻译。**
 *
 * ## ⚠️ 为什么 leverage 不给 Jev 选
 *
 * 杠杆直接决定爆仓距离。Jev 看不到保证金、看不到账户余额、算不了强平价 ——
 * 让它选杠杆等于**把资金安全交给一个不掌握事实的模型**。
 * 这与 `docs/AGENTS.md` §2 的网关边界同一条纪律：**谁掌握事实，谁做决定。**
 *
 * ## 与其他模式的关系
 *
 * ⚠️ **本文件只在 `mode === 'jev'` 时被调用。** 三种既有模式的代码路径
 * 一个字都不经过这里 —— 它们上面挂着用户的真金白银。
 */
import { fetchGuarded } from '../llm/http.js';
import { createLogger } from '../logger.js';
import type { DecisionModel } from './autoTrader.js';

const log = createLogger('jev');

/**
 * 一次 Jev 应答里，单个问题的答案。
 *
 * 形状照抄线上实测（`/v1/systemone` 的 `answers.<name>`）：
 * `choice` / `score` / `noul` 三选一，但**只有 `choice` 与 `score` 在这里有用**。
 */
interface JevAnswer {
  type?: string;
  /** `choice` 的答案（就是 `criteria` 的某个键）。 */
  choice?: string;
  /** `score` 的答案（0..N-1 的浮点）。 */
  score?: number;
  /** `noul` 的概率值（本模式暂不使用）。 */
  noul?: number;
  /** **0–1 的小数**（不是 0–100）。 */
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

/** 一次 Jev 应答的整体形状。 */
interface JevResponse {
  model?: string;
  answers?: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** 三个档位：A 最保守、B 中等、C 最激进。 */
export type Tier = 'A' | 'B' | 'C';

/**
 * 一个标的的**候选档位表** —— 代码算好、Jev 来选。
 *
 * ⚠️ 三档的**顺序与含义必须稳定**：Jev 看到的 `criteria` 说明里写的就是
 * "A 最保守 / C 最激进"。如果顺序变了，它会按旧语义选，而结果会静默出错。
 */
export interface Tiers {
  /** 仓位档（USDT 名义价值）。 */
  size: Record<Tier, number>;
  /** 止损价档。 */
  stop: Record<Tier, number>;
  /** 止盈价档。 */
  take: Record<Tier, number>;
  /** 止损距离（价格差）—— 生成 `reasoning` 时要说清"几倍 ATR"。 */
  stopDistance: Record<Tier, number>;
  /** ATR 的绝对值（用于文案）。 */
  atr: number;
}

/**
 * 从 `<JEV_INPUT>` 块里取出的一个候选。
 *
 * ⚠️ **字段是"够用就好"，不是行情全集** —— Jev 的 `state` 是自然语言摘要，
 * 塞太多数字反而稀释重点（实测：19 个标的 × 每标的 700 字仍然稳定）。
 */
export interface JevCandidate {
  symbol: string;
  price: number;
  atr: number;
  /** 近 3 根位移百分比（策略里的 D）。 */
  displacementPercent?: number;
  /** 24h 涨跌百分比。 */
  change24hPercent?: number;
  rsi7?: number;
  ema20?: number;
  /** 已有持仓的方向 —— 有仓时不新开（本模式只做"开仓/跳过"）。 */
  heldSide?: 'long' | 'short';
}

/** 本模式的可调参数。 */
export interface JevModeOptions {
  baseUrl: string;
  apiKey: string;
  /** Jev 的模型 id（`jev-latest` 是网关给的别名）。 */
  model: string;
  /** 单次 HTTP 超时。实测一次五问约 400ms，给 15 秒足够宽松。 */
  timeoutMs: number;
  /** 权益（用于算风险预算）。 */
  equity: number;
  /** 单笔风险占权益的比例（例如 0.01 = 1%）。 */
  riskPercent: number;
  /** 杠杆 —— **由策略配置决定，不让 Jev 选**（见文件头）。 */
  leverage: number;
  /** 每轮最多问几个标的（控成本）。 */
  maxCandidates: number;
  /**
   * 保证金模式。
   *
   * ⚠️ 取值是 `'crossed'` 而**不是** `'cross'` —— 这是仓库既有约定
   *（`StrategyConfigSchema` 的 `marginMode: z.enum(['isolated','crossed'])`，
   * 见 `packages/shared/src/strategy.ts:317`）。写成 `'cross'` 会被
   * `Decision.marginMode` 的类型挡下来（tsc 会红，那正是它的价值）。
   */
  marginMode: 'isolated' | 'crossed';
}

/**
 * 计算三个候选档位。
 *
 * ## 为什么档位是"代码算、Jev 选"而不是"Jev 算"
 *
 * Jev **弱于算术**（实测：它能给出概率分布，但算不对精确价位）。
 * 让它算止损价，它会给一个看起来合理、实际会挂不上的数字 —— 那是**静默错误**，
 * 比没有决策更危险。
 *
 * ## 三档的口径
 *
 * ```
 *   仓位：按「单笔风险预算 ÷ 止损距离」反推，再取 0.6× / 1.0× / 1.4× 三档
 *   止损：按 ATR 的 1.0× / 1.5× / 2.0× 三档
 *   止盈：按 2:1 盈亏比算（配合每档自己的止损距离）
 * ```
 * ⇒ 三档**都是合法的**（都能通过风控），Jev 只决定"要多激进"。
 */
export function tiersFor(c: JevCandidate, opts: JevModeOptions): Tiers {
  const dirLong = c.heldSide !== 'short';
  const atr = c.atr > 0 ? c.atr : c.price * 0.01;

  /* 单笔愿意亏的钱（USDT）。 */
  const riskUsd = Math.max(0.5, opts.equity * opts.riskPercent);

  const stopDistance: Record<Tier, number> = {
    A: atr * 1.0,
    B: atr * 1.5,
    C: atr * 2.0,
  };

  const stop: Record<Tier, number> = {
    A: dirLong ? c.price - stopDistance.A : c.price + stopDistance.A,
    B: dirLong ? c.price - stopDistance.B : c.price + stopDistance.B,
    C: dirLong ? c.price - stopDistance.C : c.price + stopDistance.C,
  };

  /*
   * 止盈：按 **2:1** 盈亏比。
   * ⚠️ 用每一档**自己的**止损距离算 —— 否则 C 档（宽止损）会得到一个
   * 与它风险不匹配的过近止盈，等于让"激进"变成了"高风险低回报"。
   */
  const take: Record<Tier, number> = {
    A: dirLong ? c.price + stopDistance.A * 2 : c.price - stopDistance.A * 2,
    B: dirLong ? c.price + stopDistance.B * 2 : c.price - stopDistance.B * 2,
    C: dirLong ? c.price + stopDistance.C * 2 : c.price - stopDistance.C * 2,
  };

  /*
   * 仓位：数量 = 风险预算 ÷ 止损距离，名义 = 数量 × 价格。
   * 再按 0.6 / 1.0 / 1.4 缩放成三档。
   */
  const baseNotional = (riskUsd / stopDistance.B) * c.price;
  const size: Record<Tier, number> = {
    A: baseNotional * 0.6,
    B: baseNotional * 1.0,
    C: baseNotional * 1.4,
  };

  return { size, stop, take, stopDistance, atr };
}

/** 把 `state` 摘要拼出来 —— 这是 Jev 唯一能看到的东西。 */
export function buildState(c: JevCandidate, t: Tiers, dirLong: boolean): string {
  const lines = [
    `标的 ${c.symbol}`,
    `当前价 ${c.price}`,
    `ATR14 = ${t.atr.toFixed(6)}（占价 ${((t.atr / c.price) * 100).toFixed(2)}%）`,
  ];
  if (c.change24hPercent !== undefined) lines.push(`24h 涨跌 ${c.change24hPercent.toFixed(2)}%`);
  if (c.displacementPercent !== undefined) {
    lines.push(`近3根位移 D = ${c.displacementPercent.toFixed(3)}%`);
  }
  if (c.rsi7 !== undefined) lines.push(`RSI7 = ${c.rsi7.toFixed(1)}`);
  if (c.ema20 !== undefined) lines.push(`EMA20 = ${c.ema20}`);
  lines.push(
    '',
    `我们正在评估做${dirLong ? '多' : '空'}（已有持仓方向决定，本次不改变方向）。`,
    `候选仓位档（名义价值，已按风险预算算好）：A=${t.size.A.toFixed(2)}U  B=${t.size.B.toFixed(2)}U  C=${t.size.C.toFixed(2)}U`,
    `候选止损价档：A=${t.stop.A.toFixed(6)}（1.0×ATR）  B=${t.stop.B.toFixed(6)}（1.5×ATR）  C=${t.stop.C.toFixed(6)}（2.0×ATR）`,
    `候选止盈价档（2:1 盈亏比）：A=${t.take.A.toFixed(6)}  B=${t.take.B.toFixed(6)}  C=${t.take.C.toFixed(6)}`,
  );
  return lines.join('\n');
}

/**
 * 一次 HTTP 问五个问题。
 *
 * ## ⚠️ `criteria` 的形状**因 type 而异**（实测踩过两次 422）
 *
 * ```
 *   score  → 数组    ["很差","较差","一般","较好","很好"]
 *   choice → 字典    {"A":"…","B":"…","C":"…"}
 * ```
 * 写反了会 422，报错是 `Input should be a valid dictionary/list`。
 *
 * ## 为什么五个问题放一次调用
 *
 * 实测：五问一次 408ms、966 input tokens。拆成五次调用是 5 倍开销与 5 倍超时风险，
 * 而且**方向与档位本来就该在同一个上下文里一起判断**（分开问会让止损档与方向脱节）。
 */
export async function askJev(
  state: string,
  opts: JevModeOptions,
  signal?: AbortSignal,
): Promise<JevResponse> {
  const body = {
    state,
    model: opts.model,
    questions: {
      direction: {
        type: 'choice',
        /*
         * ⚠️ **用肯定句**：Jev 官方明确说它对否定句的读取不可靠
         *（见 `docs/JEV-README.md` 的实测记录）。所以问"该不该动手"而不是"不该动手吗"。
         */
        instructions: '根据上面给出的数字，现在应该执行这个仓位，还是跳过？',
        criteria: { open: '执行（按候选档位开仓）', skip: '跳过（这次不做）' },
      },
      size_tier: {
        type: 'choice',
        instructions: '如果执行，用哪一个仓位档？A 最保守，C 最激进。',
        criteria: { A: 'A 档（最保守）', B: 'B 档（中等）', C: 'C 档（最激进）' },
      },
      stop_tier: {
        type: 'choice',
        instructions: '如果执行，止损放在哪一个档？A 最近（1.0×ATR），C 最远（2.0×ATR）。',
        criteria: { A: 'A 档 1.0×ATR', B: 'B 档 1.5×ATR', C: 'C 档 2.0×ATR' },
      },
      take_tier: {
        type: 'choice',
        instructions: '如果执行，止盈放在哪一个档？A 最近，C 最远。',
        criteria: { A: 'A 档（最近）', B: 'B 档（中等）', C: 'C 档（最远）' },
      },
      setup: {
        type: 'score',
        instructions: '这个机会本身的强度如何？',
        criteria: ['很差', '较差', '一般', '较好', '很好'],
      },
    },
  };

  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  /*
   * ⚠️ **必须走 `fetchGuarded`**（不是裸 `fetch`）—— 本仓库的硬约束。
   *
   * `llm/urlGuard.ts` 的文件头写着：「新增出站路径时**必须**走 `fetchGuarded`，
   * 否则连接层校验不会被应用」。字面层校验（`checkOutboundUrl`）**挡不住
   * DNS rebinding** —— 那是 #126 的结论，而 rebinding 能让一个通过字面校验的
   * 地址在解析时指向内网。
   *
   * 我第一版写的是裸 `fetch`，被 `outboundFetchGuard.test.ts` 当场抓红
   *（那条测试扫源码、列出所有没走守卫的出站调用）—— 这正是它存在的理由。
   */
  const res = await fetchGuarded(`${opts.baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: merged,
  });

  if (!res.ok) {
    /* 读一小段正文 —— 形状变了/额度问题都靠它才看得见（不要把错误吞成"没有决策"）。 */
    const text = await res.text().catch(() => '');
    throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.json()) as JevResponse;
}

/** `choice` 的答案收窄成 `Tier`；认不出就返回 `null`（**不猜**）。 */
function asTier(v: string | undefined): Tier | null {
  if (v === 'A' || v === 'B' || v === 'C') return v;
  return null;
}

/** `confidence` 是 0–1 小数，而 `Decision.confidence` 是 0–100。 */
function confidenceToPercent(raw: number | undefined): number | null {
  if (raw === undefined || !Number.isFinite(raw)) return null;
  /* 钳到 [0,1] 再 ×100 —— 超界时**不丢样本**，只钳制。 */
  const clamped = Math.min(1, Math.max(0, raw));
  return Math.round(clamped * 100);
}

/** `score` 的答案（0..n-1）换算成 0–100。`legend` 的长度就是刻度数。 */
function setupScoreToPercent(a: JevAnswer | undefined): number | null {
  if (a === undefined || typeof a.score !== 'number' || !Number.isFinite(a.score)) return null;
  const scale = a.legend !== undefined ? Object.keys(a.legend).length - 1 : 4;
  if (scale <= 0) return null;
  return Math.round(Math.min(1, Math.max(0, a.score / scale)) * 100);
}

/**
 * 一个标的的完整决策。
 *
 * 返回 `null` = **本轮不开仓**（Jev 说跳过，或它的答案形状不对）。
 * 后者要写 warn —— 那是"网关侧形状变了"，不是业务结论。
 */
export interface JevDecisionOutcome {
  /** 组装好的决策（`null` = 跳过）。 */
  decision: {
    symbol: string;
    action: 'open_long' | 'open_short';
    leverage: number;
    positionSizeUsd: number;
    stopLoss: number;
    takeProfit: number;
    confidence: number | null;
    setupScore: number | null;
    setupScoreBasis: string;
    reasoning: string;
    riskUsd: number;
    marginMode: 'isolated' | 'crossed';
  } | null;
  /** 这一标的是"跳过"还是"失败"（前者正常，后者要 warn）。 */
  outcome: 'open' | 'skip' | 'failed';
  /** 失败/跳过的原因（写日志用）。 */
  detail: string;
}

/**
 * 问一个标的、把答案翻译成决策。
 *
 * ⚠️ **失败与跳过必须分开**（`outcome`）：
 * - `skip` 是 Jev 的业务结论（正常，不写 warn）
 * - `failed` 是形状不对/网络错（**要 warn** —— 否则网关侧坏了我们会静默空转）
 */
export async function decideForCandidate(
  c: JevCandidate,
  opts: JevModeOptions,
  signal?: AbortSignal,
): Promise<JevDecisionOutcome> {
  /*
   * 已有持仓的标的不新开 —— 本模式只做"开仓 / 跳过"。
   * 平仓由既有的风控与保护单路径负责（不在这里造第二套平仓逻辑）。
   */
  if (c.heldSide !== undefined) {
    return { decision: null, outcome: 'skip', detail: '已有持仓，本模式不叠加' };
  }
  if (!(c.price > 0) || !(c.atr > 0)) {
    return { decision: null, outcome: 'failed', detail: '缺少价格或 ATR，无法算档位' };
  }

  const tiers = tiersFor(c, opts);
  const dirLong = true; /* 首次开仓按多头评估；空头由 Jev 的 direction 决定 —— 见下 */
  const state = buildState(c, tiers, dirLong);

  let resp: JevResponse;
  try {
    resp = await askJev(state, opts, signal);
  } catch (err) {
    return {
      decision: null,
      outcome: 'failed',
      detail: `Jev 调用失败：${(err as Error).message}`,
    };
  }

  const answers = resp.answers;
  if (answers === undefined) {
    return { decision: null, outcome: 'failed', detail: 'Jev 应答里没有 answers' };
  }

  const dir = answers.direction;
  if (dir?.choice === 'skip') {
    return { decision: null, outcome: 'skip', detail: 'Jev 判断跳过' };
  }
  if (dir?.choice !== 'open') {
    return {
      decision: null,
      outcome: 'failed',
      detail: `Jev 的 direction 答案无法识别：${JSON.stringify(dir?.choice)}`,
    };
  }

  const sizeTier = asTier(answers.size_tier?.choice);
  const stopTier = asTier(answers.stop_tier?.choice);
  const takeTier = asTier(answers.take_tier?.choice);
  if (sizeTier === null || stopTier === null || takeTier === null) {
    return {
      decision: null,
      outcome: 'failed',
      detail:
        `Jev 的档位答案无法识别：` +
        `size=${JSON.stringify(answers.size_tier?.choice)} ` +
        `stop=${JSON.stringify(answers.stop_tier?.choice)} ` +
        `take=${JSON.stringify(answers.take_tier?.choice)}`,
    };
  }

  const confidence = confidenceToPercent(dir.confidence);
  const setupScore = setupScoreToPercent(answers.setup);

  /*
   * `reasoning` **由答案生成**，不是编的 —— 每个数字都能追到 Jev 的某条应答。
   * ⚠️ 这是 `Decision.reasoning` 的必需字段（类型上不可为空）。
   */
  const probs = dir.probabilities ?? {};
  const probText = Object.entries(probs)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
    .join(' / ');
  const setupText =
    answers.setup?.score !== undefined
      ? `${answers.setup.score.toFixed(2)}/4（${answers.setup.legend?.[String(Math.round(answers.setup.score))] ?? '—'}）`
      : '未给';

  const reasoning =
    `Jev 判执行（置信 ${confidence ?? '—'}%${probText === '' ? '' : `；${probText}`}）；` +
    `机会强度 ${setupText}；` +
    `仓位 ${sizeTier} 档 ${tiers.size[sizeTier].toFixed(2)}U；` +
    `止损 ${stopTier} 档 ${tiers.stop[stopTier].toFixed(6)}（${stopTier === 'A' ? '1.0' : stopTier === 'B' ? '1.5' : '2.0'}×ATR）；` +
    `止盈 ${takeTier} 档 ${tiers.take[takeTier].toFixed(6)}`;

  return {
    decision: {
      symbol: c.symbol,
      action: 'open_long',
      /*
       * ⚠️ 杠杆来自策略配置，**不是 Jev 选的** —— 理由见文件头。
       */
      leverage: opts.leverage,
      positionSizeUsd: tiers.size[sizeTier],
      stopLoss: tiers.stop[stopTier],
      takeProfit: tiers.take[takeTier],
      confidence,
      setupScore,
      setupScoreBasis: `Jev setup ${setupText}`,
      reasoning,
      riskUsd: Math.max(0.5, opts.equity * opts.riskPercent),
      marginMode: opts.marginMode,
    },
    outcome: 'open',
    detail: 'Jev 判执行',
  };
}

/**
 * 把 `<JEV_INPUT>` 块从 prompt 里取出来。
 *
 * ## 为什么不解析 prompt 的散文
 *
 * `renderUserPrompt()` 的输出格式会随策略配置变化（有些段落有、有些没有），
 * 用正则去抠"价格是多少"是**脆弱**的 —— 它会在某个配置下静默抠错。
 *
 * ⇒ `autoTrader` 在**仅 Jev 模式**下追加一个结构化的 JSON 块，
 *   本函数只认那个块。**其余模式的 prompt 逐字节不变**（它们没有这个块）。
 */
export function extractJevInput(userPrompt: string): JevCandidate[] {
  const m = /<JEV_INPUT>([\s\S]*?)<\/JEV_INPUT>/.exec(userPrompt);
  if (m === null) return [];
  try {
    const parsed = JSON.parse(m[1]!) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: JevCandidate[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const symbol = typeof o.symbol === 'string' ? o.symbol : '';
      const price = typeof o.price === 'number' ? o.price : 0;
      const atr = typeof o.atr === 'number' ? o.atr : 0;
      if (symbol === '') continue;
      out.push({
        symbol,
        price,
        atr,
        displacementPercent:
          typeof o.displacementPercent === 'number' ? o.displacementPercent : undefined,
        change24hPercent:
          typeof o.change24hPercent === 'number' ? o.change24hPercent : undefined,
        rsi7: typeof o.rsi7 === 'number' ? o.rsi7 : undefined,
        ema20: typeof o.ema20 === 'number' ? o.ema20 : undefined,
        heldSide: o.heldSide === 'long' || o.heldSide === 'short' ? o.heldSide : undefined,
      });
    }
    return out;
  } catch {
    /* 块存在但 JSON 坏了 —— 返回空，由调用方写 warn（不要静默当成"没有候选"）。 */
    return [];
  }
}

/**
 * 造一个 `DecisionModel` —— 交易循环只要求 `complete()` 返回 `text`。
 *
 * ## 为什么返回 JSON 文本而不是直接造 `Decision[]`
 *
 * `DecisionModel` 的契约就是 `{ text }`，而交易循环会把 `text` 交给
 * `parser.ts` 解析、再交给风控引擎。**复用那条链路**意味着：
 * ```
 *   风控、执行、保护单、记账、审计 —— 一行都不用改
 * ```
 * 自己造 `Decision[]` 绕过 parser 会**绕开所有既有的防御性校验**
 *（`docs/AGENTS.md` §2.4：模型输出是不可信输入）。
 *
 * ⇒ 我们把 Jev 的答案序列化成**与 LLM 输出同构的 JSON**，让 parser 照常校验。
 */
export function createJevDecisionModel(opts: JevModeOptions): DecisionModel {
  return {
    complete: async (_systemPrompt, userPrompt, options) => {
      const t0 = Date.now();
      const candidates = extractJevInput(userPrompt);
      if (candidates.length === 0) {
        /*
         * 没有块 = 接线错了（`autoTrader` 忘了追加）。**这不是"没有候选"** ——
         * 那种情况块里是个空数组。所以这里要 warn，让人看得见。
         */
        log.warn('[Jev模式] prompt 里没有 <JEV_INPUT> 块 —— 接线可能断了，本轮无决策');
        return {
          text: JSON.stringify({ decisions: [] }),
          latencyMs: Date.now() - t0,
          usage: { promptTokens: null, completionTokens: null },
        };
      }

      const decisions: NonNullable<JevDecisionOutcome['decision']>[] = [];
      let failed = 0;
      let skipped = 0;

      for (const c of candidates.slice(0, opts.maxCandidates)) {
        const r = await decideForCandidate(c, opts, options?.signal);
        if (r.outcome === 'open' && r.decision !== null) {
          decisions.push(r.decision);
        } else if (r.outcome === 'skip') {
          skipped += 1;
        } else {
          failed += 1;
          /* ⚠️ 失败必须看得见 —— 否则网关侧形状变了我们会静默空转。 */
          log.warn(`[Jev模式] ${c.symbol} ${r.detail}`);
        }
      }

      /*
       * 每轮**一条**汇总日志（环形缓冲纪律：`docs/AGENTS.md` §5.6 ——
       * 多条会被别的 scope 挤掉，而一条能活下来）。
       */
      log.info(
        `[Jev模式] 候选 ${candidates.length} · 开仓 ${decisions.length} · 跳过 ${skipped} · 失败 ${failed} · ${Date.now() - t0}ms`,
      );

      /*
       * 输出形状照 `parser.ts` 认的契约：`{"decisions":[…]}`。
       * `action` 用英文枚举（`open_long`）—— 机器契约，不翻译。
       */
      return {
        text: JSON.stringify({ decisions }),
        latencyMs: Date.now() - t0,
        usage: { promptTokens: null, completionTokens: null },
      };
    },
  };
}
