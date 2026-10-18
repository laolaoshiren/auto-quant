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
 *
 * ## ⚠️ 方向从哪来（2026-10-19 修正）
 *
 * 原来用 `c.heldSide !== 'short'` 推方向 —— **那是在猜**：
 * 新建仓时 `heldSide` 是 `undefined`，于是永远推出 `dirLong = true`
 * ⇒ **只会开多仓**，空头机会全丢。
 *
 * 现在方向是**必填参数**，由 Jev 的 `direction` 答案决定
 *（`open_long` / `open_short`）。它同时决定止损在价的哪一侧。
 */
export function tiersFor(
  c: JevCandidate,
  opts: JevModeOptions,
  /**
   * 方向。**必填** —— 没有"默认多头"这回事（那正是原来的 bug）。
   */
  side: 'long' | 'short',
): Tiers {
  const dirLong = side === 'long';
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

/**
 * **把 `state` 摘要拼出来** —— 这是 Jev 唯一能看到的东西。
 *
 * ## ⚠️ 为什么要同时给出【多空两套档位】（2026-10-19 修正）
 *
 * 第一版只给多头档位、并且把"做多"写死在摘要里：
 * ```
 *   我们正在评估做多（已有持仓方向决定，本次不改变方向）
 *   候选止损价档：A=…（1.0×ATR）   ← 这些数字是【多头】的止损
 * ```
 * 后果：**Jev 根本没有机会说"做空"** —— 它看到的所有数字都是多头的，
 * 而问题里也没有"做空"这个选项。于是整个模式只会开多仓。
 *
 * 现在把两套都摊开，让它**先选方向、再选档位**。
 * ⚠️ 顺序很重要：方向决定档位属于哪一侧，所以两套必须一起给出。
 */
export function buildState(
  c: JevCandidate,
  longTiers: Tiers,
  shortTiers: Tiers,
): string {
  const lines = [
    `标的 ${c.symbol}`,
    `当前价 ${c.price}`,
    `ATR14 = ${longTiers.atr.toFixed(6)}（占价 ${((longTiers.atr / c.price) * 100).toFixed(2)}%）`,
  ];
  if (c.change24hPercent !== undefined) lines.push(`24h 涨跌 ${c.change24hPercent.toFixed(2)}%`);
  if (c.displacementPercent !== undefined) {
    lines.push(`近3根位移 D = ${c.displacementPercent.toFixed(3)}%`);
  }
  if (c.rsi7 !== undefined) lines.push(`RSI7 = ${c.rsi7.toFixed(1)}`);
  if (c.ema20 !== undefined) lines.push(`EMA20 = ${c.ema20}`);

  const tierLine = (label: string, t: Tiers, verb: string): string[] => [
    `${verb}候选仓位档（名义价值，已按风险预算算好）：` +
      `A=${t.size.A.toFixed(2)}U  B=${t.size.B.toFixed(2)}U  C=${t.size.C.toFixed(2)}U`,
    `${verb}候选止损价档：` +
      `A=${t.stop.A.toFixed(6)}（1.0×ATR）  B=${t.stop.B.toFixed(6)}（1.5×ATR）  C=${t.stop.C.toFixed(6)}（2.0×ATR）`,
    `${verb}候选止盈价档（2:1 盈亏比）：` +
      `A=${t.take.A.toFixed(6)}  B=${t.take.B.toFixed(6)}  C=${t.take.C.toFixed(6)}`,
  ];

  lines.push('', ...tierLine('做多', longTiers, '【做多】'), '', ...tierLine('做空', shortTiers, '【做空】'));
  return lines.join('\n');
}

/**
 * **把 baseUrl 拼成 `/v1/systemone` 的完整地址**。
 *
 * ## 为什么要单独抽成一个函数（2026-10-19 线上实测踩到）
 *
 * `resolveTeamGateway()` 返回的 baseUrl **已经带 `/v1`**：
 * ```
 *   实测值：http://127.0.0.1:3425/v1
 *   我的第一版：`${baseUrl}/v1/systemone`  ⇒  /v1/v1/systemone  ⇒  HTTP 404
 * ```
 *
 * 而那个 404 的正文把正确路径列了出来（"magpie serves … /v1/systemone …"）
 * —— 错误信息里已经有答案，只是拼接重复了。
 *
 * ⚠️ 这个 bug 的类型是**最容易漏的那种**：单元测试全绿、typecheck 全绿、
 * 构建全绿，**只有真的打一次网络才会现形**。所以把它抽成纯函数，
 * 让 `jevModel.test.ts` 能钉住"带不带 `/v1` 都拼成同一个地址"。
 */
export function jevEndpointUrl(baseUrl: string): string {
  /* 先剥尾部斜杠，再剥尾部的 `/v1`，最后自己加一次 —— 两种形状都对。 */
  const origin = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${origin}/v1/systemone`;
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
      /*
       * ⚠️⚠️ **方向必须是三选一，不是"执行/跳过"二选一**（2026-10-19 修正）。
       *
       * 第一版写的是 `{ open: '执行', skip: '跳过' }`，然后代码里
       * `action: 'open_long'` 写死 —— 结果**只会开多仓**，空头机会全丢。
       * 用户问「JEV 模式下…其他的操作会吗」时我查代码才发现。
       *
       * 现在方向由 Jev 直接选，代码不再猜。
       */
      direction: {
        type: 'choice',
        /*
         * ⚠️ **用肯定句**：Jev 官方明确说它对否定句的读取不可靠
         *（见 `docs/JEV-README.md` 的实测记录）。
         */
        instructions:
          '根据上面给出的数字，现在应该做多、做空，还是跳过？' +
          '注意：【做多】的止损在价格下方、止盈在上方；【做空】反之。',
        criteria: {
          open_long: '做多（用【做多】那一组档位）',
          open_short: '做空（用【做空】那一组档位）',
          skip: '跳过（这次不做）',
        },
      },
      size_tier: {
        type: 'choice',
        instructions: '如果要做，用哪一个仓位档？A 最保守，C 最激进。',
        criteria: { A: 'A 档（最保守）', B: 'B 档（中等）', C: 'C 档（最激进）' },
      },
      stop_tier: {
        type: 'choice',
        instructions: '如果要做，止损放在哪一个档？A 最近（1.0×ATR），C 最远（2.0×ATR）。',
        criteria: { A: 'A 档 1.0×ATR', B: 'B 档 1.5×ATR', C: 'C 档 2.0×ATR' },
      },
      take_tier: {
        type: 'choice',
        instructions: '如果要做，止盈放在哪一个档？A 最近，C 最远。',
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
   * ⚠️⚠️ **`baseUrl` 可能已经带 `/v1`**（2026-10-19 实测踩到）。
   *
   * `resolveTeamGateway()` 返回的是**团队模式用的出口**，而团队调的是
   * `/v1/chat/completions` —— 所以它给的 baseUrl 已经含 `/v1`：
   * ```
   *   实测：http://127.0.0.1:3425/v1
   *   我的第一版：`${baseUrl}/v1/systemone` ⇒ /v1/v1/systemone ⇒ HTTP 404
   * ```
   * 而 404 的正文是「magpie serves /v1/chat/completions, …, /v1/systemone, …」
   * —— 它明确告诉我正确路径是 `/v1/systemone`，只是我拼重复了。
   *
   * ⇒ 统一成"**先剥掉尾部的 `/v1`，再自己加 `/v1/systemone`**"。
   *   这样两种形状（带或不带 `/v1`）都对。
   */
  const res = await fetchGuarded(jevEndpointUrl(opts.baseUrl), {
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

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **P1：已有持仓的「继续持有 / 平掉」判断**（2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么需要它
 *
 * 第一版对已有持仓**直接跳过、根本不问 Jev**：
 * ```
 *   if (c.heldSide !== undefined) return '已有持仓，本模式不叠加'
 * ```
 * 后果：一台 JEV 模式的机器人开完仓之后就**再也不做任何判断**，
 * 只能等交易所侧的止损/止盈触发。那不是"Jev 自主交易"，
 * 那是"开仓后交给保护单"。
 *
 * ## ⚠️ 边界：这只是**提议**，不是命令
 *
 * 平仓决策仍然要走 `RiskEngine.reviewClose()`（`docs/AGENTS.md` §2.1：
 * 风控是通往订单的唯一路径）。本函数只回答"Jev 想不想平"，
 * **不直接下单、不撤保护单**。
 *
 * ⚠️ 而且**保护单必须先撤**才手动平仓（§2.7：`closePosition=true` 的条件单
 * 在手动平仓后依然存活，会朝反方向开出新仓）。那个撤单由既有平仓路径负责。
 */
export async function askJevForPosition(
  state: string,
  opts: JevModeOptions,
  signal?: AbortSignal,
): Promise<JevResponse> {
  const body = {
    state,
    model: opts.model,
    questions: {
      hold_or_close: {
        type: 'choice',
        instructions:
          '这个仓位现在应该继续持有，还是平掉？' +
          '注意：止损止盈单已经在交易所挂着，平掉意味着主动放弃它们。',
        criteria: {
          hold: '继续持有（让止损止盈单继续工作）',
          close: '主动平掉（理由已经不存在了）',
        },
      },
      conviction: {
        type: 'score',
        instructions: '你对"继续持有"的信心有多强？',
        criteria: ['很弱', '较弱', '一般', '较强', '很强'],
      },
    },
  };

  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const res = await fetchGuarded(jevEndpointUrl(opts.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: merged,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as JevResponse;
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **P2：移动止损（trailing stop）的判断**（2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么需要它
 *
 * 第一版**挂上止损之后再也不动**。后果：
 * ```
 *   一个已经浮盈 3% 的仓位，止损还在 -1.5×ATR 那里
 *   ⇒ 一次正常回调就把利润全吐回去（那正是"追高"亏钱的主要形态）
 * ```
 *
 * ## ⚠️ 边界（三条硬约束）
 *
 * ```
 * ① 只能【收紧】，不能【放宽】 —— 放宽止损等于增加风险，那必须由人决定
 * ② 必须走 RiskEngine（风控是通往订单的唯一路径）
 * ③ 新的止损必须在【盈利方向】上 —— 绝不允许把止损移到开仓价之外
 * ```
 *
 * 第 ③ 条尤其重要：如果 Jev 说"把多头止损移到开仓价下方很远"，
 * 那是**放宽**，必须拒掉。
 */
export async function askJevForTrailingStop(
  state: string,
  opts: JevModeOptions,
  signal?: AbortSignal,
): Promise<JevResponse> {
  const body = {
    state,
    model: opts.model,
    questions: {
      move_stop: {
        type: 'choice',
        instructions:
          '这个仓位已经有浮盈了。止损要不要往盈利方向收紧？' +
          '注意：只能收紧（离当前价更近），不能放宽。',
        criteria: {
          keep: '保持原止损不动',
          tighten: '收紧止损（锁定一部分利润）',
        },
      },
      how_much: {
        type: 'choice',
        instructions: '如果要收紧，收紧到哪一档？（三档都已算好）',
        criteria: {
          A: 'A 档（最保守，只锁一点点）',
          B: 'B 档（中等）',
          C: 'C 档（最激进，锁住大部分利润）',
        },
      },
    },
  };

  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const res = await fetchGuarded(jevEndpointUrl(opts.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: merged,
  });
  if (!res.ok) {
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
    action: 'open_long' | 'open_short' | 'close_long' | 'close_short';
    leverage: number;
    positionSizeUsd: number;
    /**
     * 止损/止盈价。
     *
     * ⚠️ **平仓决策不需要它们** —— `close_long` / `close_short` 不带保护单
     *（平仓之后原来的保护单会被撤掉，见 `docs/AGENTS.md` §2.7）。
     * 所以类型是 `number | null`，而不是强制要求一个数。
     */
    stopLoss: number | null;
    takeProfit: number | null;
    confidence: number | null;
    setupScore: number | null;
    setupScoreBasis: string;
    reasoning: string;
    riskUsd: number;
    marginMode: 'isolated' | 'crossed';
  } | null;
  /** 这一标的是"跳过"还是"失败"（前者正常，后者要 warn）。 */
  outcome: 'open' | 'close' | 'skip' | 'failed';
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
   * ⚠️ **已有持仓的标的不在这里处理**（2026-10-19 修正）。
   *
   * 第一版直接 `return 'skip'` —— 那让一台 JEV 模式的机器人**开完仓就再也不思考**。
   * 现在持仓走 `decideForPosition()`（P1 平仓 + P2 移动止损），
   * 与开仓是**两条独立的路径**（它们的输出形状完全不同：
   * 开仓产出 `open_*`，持仓产出 `close_*` 或"保持不动"）。
   */
  if (c.heldSide !== undefined) {
    return {
      decision: null,
      outcome: 'skip',
      detail: '已有持仓 —— 走 decideForPosition（平仓/移动止损）',
    };
  }
  if (!(c.price > 0) || !(c.atr > 0)) {
    return { decision: null, outcome: 'failed', detail: '缺少价格或 ATR，无法算档位' };
  }

  /*
   * ⚠️ **两套档位都要算**（多头一套、空头一套），因为方向由 Jev 选，
   * 而方向决定止损/止盈在价格的哪一侧。
   */
  const longTiers = tiersFor(c, opts, 'long');
  const shortTiers = tiersFor(c, opts, 'short');
  const state = buildState(c, longTiers, shortTiers);

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
  /*
   * ⚠️ **方向必须从 Jev 的答案里读，不许猜**（2026-10-19 修正）。
   * 认不出就 `failed` —— 绝不能静默回落成"开多"（那是第一版的 bug）。
   */
  const side: 'long' | 'short' | null =
    dir?.choice === 'open_long' ? 'long' : dir?.choice === 'open_short' ? 'short' : null;
  if (side === null) {
    return {
      decision: null,
      outcome: 'failed',
      detail: `Jev 的 direction 答案无法识别：${JSON.stringify(dir?.choice)}`,
    };
  }
  const tiers = side === 'long' ? longTiers : shortTiers;

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

  const confidence = confidenceToPercent(dir?.confidence);
  const setupScore = setupScoreToPercent(answers.setup);

  /*
   * `reasoning` **由答案生成**，不是编的 —— 每个数字都能追到 Jev 的某条应答。
   * ⚠️ 这是 `Decision.reasoning` 的必需字段（类型上不可为空）。
   */
  const probs = dir?.probabilities ?? {};
  const probText = Object.entries(probs)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
    .join(' / ');
  const setupText =
    answers.setup?.score !== undefined
      ? `${answers.setup.score.toFixed(2)}/4（${answers.setup.legend?.[String(Math.round(answers.setup.score))] ?? '—'}）`
      : '未给';

  /*
   * ⚠️ **Jev 判"执行"但置信度很低时必须说清**（2026-10-19 实测发现）。
   *
   * 实测 DOGEUSDT：Jev 答 `open`，但 `probabilities` 是
   * `{open: 0.50, skip: 0.50}`、`confidence: 0` —— 那是**平局**，
   * 而它仍然选了一边（`choice` 类型必须给一个答案）。
   *
   * ## 为什么不在本文件里拒掉它
   *
   * 门槛是**策略配置**（`minConfidence`），而风控引擎已经有一处统一实现
   *（`risk/engine.ts:901`：`decision.confidence < risk.minConfidence` ⇒ 拒绝并带理由）。
   * 在这里再造一个门槛会让"最低置信度"有两个定义处 —— 那正是
   * `docs/AGENTS.md` §2.1「风控是通往订单的唯一路径」要避免的分叉。
   *
   * ⇒ 正确做法：**照常产出 Decision**（把 `confidence` 如实填进去），
   *   让风控按策略配置拒。这里只负责把"它是平局"这件事**写进 reasoning**，
   *   这样日志里看得见"为什么这一笔被拒了"。
   */
  const isTie = probText.includes('skip 50%') || (confidence !== null && confidence < 20);
  const sideText = side === 'long' ? '做多' : '做空';
  const reasoning =
    `Jev 判${sideText}（置信 ${confidence ?? '—'}%${probText === '' ? '' : `；${probText}`}）` +
    `${isTie ? '⚠️ 接近平局，可能被最低置信度拦下' : ''}；` +
    `机会强度 ${setupText}；` +
    `仓位 ${sizeTier} 档 ${tiers.size[sizeTier].toFixed(2)}U；` +
    `止损 ${stopTier} 档 ${tiers.stop[stopTier].toFixed(6)}（${stopTier === 'A' ? '1.0' : stopTier === 'B' ? '1.5' : '2.0'}×ATR）；` +
    `止盈 ${takeTier} 档 ${tiers.take[takeTier].toFixed(6)}`;

  return {
    decision: {
      symbol: c.symbol,
      /*
       * ⚠️ **方向来自 Jev，不是写死的**（2026-10-19 修正）。
       * 原来这里是 `'open_long'` 字面量 —— 于是整个模式只会开多仓。
       */
      action: side === 'long' ? 'open_long' : 'open_short',
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
    detail: `Jev 判${sideText}`,
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **已有持仓的决策：继续持有 / 平掉**（P1，2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么它和 `decideForCandidate` 分开
 *
 * 两者的**输出形状完全不同**：
 * ```
 *   开仓路径 → 产出 open_long / open_short（带仓位、止损、止盈）
 *   持仓路径 → 产出 close_long / close_short，或"什么都不做"
 * ```
 * 硬塞进一个函数会让分支纠缠、也更容易在某一侧写错方向。
 *
 * ## ⚠️ 三层保护，缺一不可
 *
 * ```
 * ① 本函数只回答"想不想平"，**不撤单、不下单**
 * ② 平仓必须走 RiskEngine.reviewClose()（风控是唯一路径）
 * ③ 平仓前必须先撤该标的的保护单（§2.7：否则条件单会反向开新仓）
 * ```
 * ②③ 由既有平仓路径负责，本函数**不重复实现**。
 */
export async function decideForPosition(
  c: JevCandidate & { heldSide: 'long' | 'short' },
  opts: JevModeOptions,
  signal?: AbortSignal,
): Promise<JevDecisionOutcome> {
  if (!(c.price > 0)) {
    return { decision: null, outcome: 'failed', detail: '缺少价格，无法判断' };
  }

  const sideText = c.heldSide === 'long' ? '多' : '空';
  const state = [
    `标的 ${c.symbol}`,
    `当前价 ${c.price}`,
    `我们持有一个${sideText}头仓位。`,
    ...(c.change24hPercent !== undefined
      ? [`24h 涨跌 ${c.change24hPercent.toFixed(2)}%`]
      : []),
    ...(c.displacementPercent !== undefined
      ? [`近3根位移 D = ${c.displacementPercent.toFixed(3)}%`]
      : []),
    ...(c.rsi7 !== undefined ? [`RSI7 = ${c.rsi7.toFixed(1)}`] : []),
    ...(c.ema20 !== undefined ? [`EMA20 = ${c.ema20}`] : []),
    '',
    '止损止盈单已经在交易所挂着。',
  ].join('\n');

  let resp: JevResponse;
  try {
    resp = await askJevForPosition(state, opts, signal);
  } catch (err) {
    return {
      decision: null,
      outcome: 'failed',
      detail: `Jev 调用失败（持仓判断）：${(err as Error).message}`,
    };
  }

  const a = resp.answers?.hold_or_close;
  if (a?.choice === 'hold') {
    return { decision: null, outcome: 'skip', detail: 'Jev 判断继续持有' };
  }
  if (a?.choice !== 'close') {
    return {
      decision: null,
      outcome: 'failed',
      detail: `Jev 的 hold_or_close 答案无法识别：${JSON.stringify(a?.choice)}`,
    };
  }

  const confidence = confidenceToPercent(a.confidence);
  const conviction = setupScoreToPercent(resp.answers?.conviction);

  return {
    decision: {
      symbol: c.symbol,
      /*
       * ⚠️ **平仓方向必须与持仓方向一致** —— 多头平 `close_long`、空头平 `close_short`。
       * 写反了会被风控拒（`parser.ts` 有校验），但那说明这里有 bug，不该靠下游兜。
       */
      action: c.heldSide === 'long' ? 'close_long' : 'close_short',
      leverage: opts.leverage,
      /* 平仓不需要仓位大小 —— 但 `Decision` 的类型要求这个字段，给 0。 */
      positionSizeUsd: 0,
      stopLoss: null,
      takeProfit: null,
      confidence,
      setupScore: conviction,
      setupScoreBasis: `Jev 继续持有信心 ${conviction ?? '—'}/100`,
      reasoning:
        `Jev 判主动平掉${sideText}头（置信 ${confidence ?? '—'}%）；` +
        `继续持有的信心 ${conviction ?? '—'}/100`,
      riskUsd: 0,
      marginMode: opts.marginMode,
    },
    outcome: 'close',
    detail: `Jev 判平掉${sideText}头`,
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
 * **把一轮的决策拼成交易循环要的文本**（2026-10-19）。
 *
 * ## ⚠️ 为什么必须带 `<decision>` 块
 *
 * `autoTrader.ts` 在解析之前有一道前置检查：
 * ```
 *   if (!hasDecisionBlock(response.text)) → 判定"输出被截断" → 重试 → 再失败抛错
 * ```
 * 而 `hasDecisionBlock()`（`parser.ts:509`）只做一件事：
 * ```
 *   return /<decision>/i.test(stripInvisible(response))
 * ```
 * ⇒ **它只认 `<decision>` 标签**，不认 JSON 形状。
 *
 * ## 我第一版踩的坑（线上实测）
 *
 * 返回纯 JSON `{"decisions":[…]}` ⇒ 第一轮就报：
 * ```
 *   这一轮模型的输出被截断了，没有形成任何交易决策（重试一次仍然如此）
 *   两次输出分别 1180 与 16 字符
 * ```
 * 而真正解析的 `parseDecisionResponse()` 是认 `{"decisions":[…]}` 的 ——
 * **两道判据的契约不一致，前置那道更严**。
 *
 * ## 为什么改我这边而不是改前置检查
 *
 * 改 `hasDecisionBlock` 会影响**所有模式**（那三个上面挂着真金白银）。
 * JEV 模式是新的，让它**产出符合既有契约的输出**是零风险的解法。
 *
 * ## `reasoning` 块的作用
 *
 * 它不是给解析器看的（解析器只认 `<decision>`），而是给**审计记录**看的：
 * 操作员在决策详情页能读到"这轮问了多少、开仓几个、跳过几个"，
 * 而不只是一段 JSON。
 */
export function buildJevResponseText(input: {
  candidates: number;
  decisions: readonly unknown[];
  skipped: number;
  failed: number;
  /** 开仓笔数（与 `closed` 分开报 —— 两者的风险含义相反）。 */
  opened?: number;
  /** 平仓笔数。 */
  closed?: number;
}): string {
  const opened = input.opened ?? input.decisions.length;
  const closed = input.closed ?? 0;
  return [
    '<reasoning>',
    `Jev 模式：本轮问询 ${input.candidates} 个候选，开仓 ${opened} 个、平仓 ${closed} 个，` +
      `跳过 ${input.skipped} 个，失败 ${input.failed} 个。`,
    '</reasoning>',
    '<decision>',
    JSON.stringify({ decisions: input.decisions }),
    '</decision>',
  ].join('\n');
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
/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **把移动止损的判断也交给 Jev**（P2 · 2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么做成独立函数而不是塞进 `complete()`
 *
 * `complete()` 服务的是"一轮决策"，而移动止损发生在**持仓管理**阶段
 *（`applyBreakevenGuard`，每轮单独跑）。两者时机不同、输入不同。
 *
 * ## 为什么返回 `number | 'keep' | null`
 *
 * ```
 *   一个数     → Jev 选了那一档，用它
 *   'keep'     → Jev 明确说"不动"
 *   null       → 失败/形状不对 ⇒ 调用方退回机械规则
 * ```
 * 把 `'keep'` 与 `null` 分开是刻意的：前者是**业务结论**（正常），
 * 后者是**故障**（要 warn）。混在一起会让"Jev 说不动"和"Jev 挂了"
 * 在日志里长得一样。
 *
 * ## ⚠️ 只能收紧，不能放宽
 *
 * 三档候选**全部**由 `autoTrader.tightenStop()` 算出（factor < 1 ⇒ 更紧），
 * 而且调用方还会再判一次 `isStopTighter()`。本函数不产出一个"更宽的止损"，
 * 因为那等于增加风险 —— 那必须由人决定，不该由模型决定。
 */
export async function suggestTrailingStop(
  opts: JevModeOptions,
  input: {
    symbol: string;
    side: 'long' | 'short';
    entryPrice: number;
    markPrice: number;
    currentStop: number | null;
    unrealizedPnlPercent: number;
    candidates: { A: number; B: number; C: number };
  },
  signal?: AbortSignal,
): Promise<number | 'keep' | null> {
  const sideText = input.side === 'long' ? '多' : '空';
  const state = [
    `标的 ${input.symbol}`,
    `我们持有一个${sideText}头仓位。`,
    `开仓价 ${input.entryPrice}  当前价 ${input.markPrice}`,
    `当前止损 ${input.currentStop ?? '（没有）'}`,
    `未实现盈亏 ${input.unrealizedPnlPercent.toFixed(2)}%（按保证金算）`,
    '',
    '这个仓位已经有浮盈。止损可以往盈利方向收紧，锁定一部分利润。',
    '三个候选止损价（都已算好，越靠后越紧）：',
    `A 档 = ${input.candidates.A}（机械规则给的默认值）`,
    `B 档 = ${input.candidates.B}（更紧，锁更多）`,
    `C 档 = ${input.candidates.C}（最紧，锁最多但也最容易被扫出去）`,
  ].join('\n');

  let resp: JevResponse;
  try {
    resp = await askJevForTrailingStop(state, opts, signal);
  } catch (err) {
    /* 返回 null = 故障 ⇒ 调用方退回机械规则。 */
    log.warn(`[Jev模式] ${input.symbol} 的移动止损判断失败：${(err as Error).message}`);
    return null;
  }

  const a = resp.answers?.move_stop;
  if (a?.choice === 'keep') return 'keep';
  if (a?.choice !== 'tighten') {
    log.warn(
      `[Jev模式] ${input.symbol} 的 move_stop 答案无法识别：${JSON.stringify(a?.choice)}`,
    );
    return null;
  }

  const tier = asTier(resp.answers?.how_much?.choice);
  if (tier === null) {
    log.warn(
      `[Jev模式] ${input.symbol} 的 how_much 答案无法识别：${JSON.stringify(resp.answers?.how_much?.choice)}`,
    );
    return null;
  }
  return input.candidates[tier];
}

/**
 * JEV 模式的决策模型 —— **比 `DecisionModel` 多一个 `suggestTrailingStop`**。
 *
 * ⚠️ 用交叉类型，而不是往 `DecisionModel` 里加一个可选方法：
 * 后者会让**所有模式**都看到一个"可能存在的移动止损能力"，
 * 而实际上只有 JEV 模式有。交叉类型让"谁有什么能力"在类型上就是明确的。
 */
export type JevDecisionModel = DecisionModel & {
  suggestTrailingStop: (
    input: {
      symbol: string;
      side: 'long' | 'short';
      entryPrice: number;
      markPrice: number;
      currentStop: number | null;
      unrealizedPnlPercent: number;
      candidates: { A: number; B: number; C: number };
    },
    signal?: AbortSignal,
  ) => Promise<number | 'keep' | null>;
};

export function createJevDecisionModel(opts: JevModeOptions): JevDecisionModel {
  return {
    /*
     * ⚠️ **`suggestTrailingStop` 不是 `DecisionModel` 的成员** —— 它是本模式
     * 额外提供的能力（P2 移动止损）。`autoTrader` 用 `typeof === 'function'`
     * 探测它，所以其它模式的 model 没有这个方法时整段跳过、行为逐字节不变。
     *
     * TS 的结构化类型允许多带方法，所以这个对象同时满足 `DecisionModel`
     * 与"有移动止损能力"两种形状。
     */
    suggestTrailingStop: (input, signal) => suggestTrailingStop(opts, input, signal),
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
          /*
           * ⚠️ **空决策也要带 `<decision>` 块**（理由见下面正常路径那段）：
           * 否则 `hasDecisionBlock()` 会把它判成"输出被截断"，
           * 触发一次无意义的重试，最后抛一条误导性的错误。
           * "这轮没有机会"是**合法结论**，不该报成故障。
           */
          text: '<reasoning>\nJev 模式：prompt 里没有候选块。\n</reasoning>\n<decision>\n{"decisions":[]}\n</decision>',
          latencyMs: Date.now() - t0,
          usage: { promptTokens: null, completionTokens: null },
        };
      }

      const decisions: NonNullable<JevDecisionOutcome['decision']>[] = [];
      let failed = 0;
      let skipped = 0;
      let opened = 0;
      let closed = 0;

      for (const c of candidates.slice(0, opts.maxCandidates)) {
        /*
         * ⚠️ **持仓与开仓走两条不同的路径**（2026-10-19 修正）。
         *
         * 第一版对持仓直接 `skip` —— 那让机器人开完仓就再也不思考，
         * 只能等交易所侧的止损止盈。现在持仓会问 Jev「继续持有还是平掉」（P1）。
         */
        const r =
          c.heldSide !== undefined
            ? await decideForPosition(
                { ...c, heldSide: c.heldSide },
                opts,
                options?.signal,
              )
            : await decideForCandidate(c, opts, options?.signal);

        if ((r.outcome === 'open' || r.outcome === 'close') && r.decision !== null) {
          decisions.push(r.decision);
          if (r.outcome === 'open') opened += 1;
          else closed += 1;
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
        `[Jev模式] 候选 ${candidates.length} · 开仓 ${opened} · 平仓 ${closed} · 跳过 ${skipped} · 失败 ${failed} · ${Date.now() - t0}ms`,
      );

      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **输出必须带 `<decision>` 块**（2026-10-19 线上实测抓到）
       * ══════════════════════════════════════════════════════════════════════
       *
       * ## 事故
       *
       * 第一版返回的是纯 JSON `{"decisions":[…]}`，结果线上第一轮就报：
       * ```
       *   第 #1 轮决策失败：这一轮模型的输出被截断了，没有形成任何交易决策
       *   （重试一次仍然如此）—— 已安全跳过。两次输出分别 1180 与 16 字符
       * ```
       *
       * ## 根因
       *
       * `autoTrader.ts` 在解析之前有一道**前置检查**：
       * ```
       *   if (!hasDecisionBlock(response.text)) → 判定"输出被截断" → 重试 → 再失败就抛错
       * ```
       * 而 `hasDecisionBlock()`（`parser.ts:509`）只做一件事：
       * ```
       *   return /<decision>/i.test(...)
       * ```
       * ⇒ **它只认 `<decision>` 标签**，不认 JSON 形状。
       *
       * 而真正解析用的 `parseDecisionResponse()` 是认 `{"decisions":[…]}` 的
       * —— 也就是说**两道判据的契约不一致**，前置那道更严。
       *
       * ## 为什么现在加块而不是改前置检查
       *
       * 改 `hasDecisionBlock` 会影响**所有模式**（那三个上面挂着真金白银）。
       * 而 JEV 模式是新的，让它**产出符合既有契约的输出**是零风险的解法 ——
       * 顺带也让审计记录里有一份人能读的东西。
       */
      return {
        text: buildJevResponseText({
          candidates: candidates.length,
          decisions,
          skipped,
          failed,
        }),
        latencyMs: Date.now() - t0,
        usage: { promptTokens: null, completionTokens: null },
      };
    },
  };
}
