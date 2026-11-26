/**
 * M3.4 三段式 Agentic 决策循环（`packages/server/src/managed/engine.ts`）
 *
 * 落地 VergeX 级标准原生 function-calling 三段式协议：
 *   1. `plan`          — 声明本轮大盘格局、逐个持仓复盘与候选观察重点
 *   2. `update_notes`  — 维护按标的替换的反例衰减笔记（或给被证伪笔记记反例）
 *      `update_thesis` — 维护已有持仓的结构化论点（加减仓条件、时间止损、MAE 硬线）
 *      `get_klines`    — 可选按需补看池外标的 K 线（无缝衔接 M1.2 热加入可执行池）
 *   3. `finalize`      — 强制最终拍板（永不空决策：每个持仓必须给 HOLD/战术动作，
 *                        每个展开候选必须给 WAIT/开仓），并可随开仓单附带初始论点参数
 *
 * 兼容与容错：
 *   - 依赖原生 `model.chat(messages, { tools, toolChoice, signal })`；若底层只提供 `complete()`
 *     或模型直接吐出 `<decision>` 正文，则平滑接住不报错、不浪费额外轮次。
 *   - 最多 4 轮工具回合，逐轮累加 token/延迟统计；收尾自动补全遗漏持仓的 `hold` 与候选的 `wait`。
 */

import {
  normalizeSymbol,
  type Kline,
  type ManagedStageStep,
  type PositionView,
  type Timeframe,
} from '@aq/shared';

import type { ChatMessage, ToolCall, ToolSpec } from '../llm/types.js';
import type { RadarBias } from '../radar/ai500.js';
import { managedNotesStore } from './notes.js';
import { managedThesisStore } from './thesis.js';

/* -------------------------------------------------------------------------- */
/*  Public Types                                                               */
/* -------------------------------------------------------------------------- */

/** 开仓提案中模型附带的初始持仓论点参数（成交后立即落库绑定到 `managed_theses`）。 */
export interface PendingThesisPlan {
  entryBasis?: string;
  addTrigger?: string;
  reduceTarget?: string;
  invalidation?: string;
  timeStopHours?: number;
  minProgressR?: number;
  maxAdverseExcursionPct?: number;
}

export interface ManagedChatModel {
  chat(
    messages: ChatMessage[],
    options?: {
      signal?: AbortSignal;
      maxTokens?: number;
      tools?: readonly ToolSpec[];
      toolChoice?: 'auto' | 'none' | 'required';
    },
  ): Promise<{
    text: string;
    latencyMs: number;
    ttftMs?: number | null;
    usage: {
      promptTokens: number | null;
      completionTokens: number | null;
      cachedTokens?: number | null;
      reasoningTokens?: number | null;
    };
    toolCalls?: ToolCall[];
  }>;
}

export interface ManagedEngineInput {
  traderId: number;
  model: ManagedChatModel;
  baseMessages: readonly ChatMessage[];
  /** 当前持仓（用于 update_thesis 校验与 finalize 完整性兜底）。 */
  openPositions: readonly PositionView[];
  /** 当前待成交限价挂单标的（豁免观察池过滤并在 finalize 中保留/补齐 wait，防止掉出雷达 Top 4 后挂单评估被静默丢弃）。 */
  pendingSymbols?: readonly string[];
  /** 本轮深度展开的候选标的（不含持仓，用于 finalize 完整性兜底）。 */
  candidateSymbols: readonly string[];
  /** 本轮 Prompt 中已展开完整 4h/15m/1m K 线的标的集合（含持仓+候选），用于拦截重复 get_klines 拖慢周期。 */
  expandedSymbols?: readonly string[];
  /** 单周期允许调用 get_klines 的最大次数（默认 4 次，防止 12 连查拖慢周期到 5-7 分钟）。 */
  maxKlineCalls?: number;
  /** 可选按需拉取 K 线回调（复用 MarketDataService.getKlines 并触发 M1.2 热加入）。 */
  getKlines?: (symbol: string, timeframe: Timeframe, count: number) => Promise<Kline[]>;
  /** 可选事件回调：向运行日志输出三段式推进痕迹。 */
  onStageEvent?: (stage: string, detail: string) => void;
  signal?: AbortSignal;
  maxRounds?: number;
  nowMs?: number;
}

export interface ManagedEngineResult {
  /** 归一化后的 `<reasoning>...</reasoning>\n<decision>...</decision>` 文本，无缝交由既有解析器与风控执行。 */
  text: string;
  latencyMs: number;
  /** 多轮调用的 LLM 平均首字延迟（毫秒）；未测到时为 `null`。 */
  ttftMs: number | null;
  /** 各轮实测首字延迟明细（毫秒），供外层合并执行回执追问重新求全局均值。 */
  ttftSamples: number[];
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    cachedTokens: number | null;
    reasoningTokens: number | null;
  };
  /** 模型在 `finalize` 中为新开仓标的附带的初始论点，待成交后由 AutoTrader 落库。 */
  pendingThesisPlans: Map<string, PendingThesisPlan>;
  /** 审计轨迹（例如 `plan`, `note:SOLUSDT`, `thesis:ETHUSDT`, `finalize(4)`）。 */
  stageTrace: string[];
  /** 结构化步骤明细（大盘定调、笔记正文与触发条件、论点更新、提前复查等）。 */
  stageSteps: ManagedStageStep[];
  /** 是否走通了原生 `finalize` 结构化协议。 */
  usedFinalizeTool: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Native Function-Calling Tool Specifications                                */
/* -------------------------------------------------------------------------- */

export const MANAGED_AGENT_TOOLS: readonly ToolSpec[] = [
  {
    name: 'plan',
    description:
      '【第 1 步】声明本轮交易计划：大盘状态、当前持仓的逐一检查结论，以及本轮重点评估的 AI500 高分候选。常规轮次应先调用 plan（可与 update_notes / update_thesis 同轮并行）。',
    parameters: {
      type: 'object',
      properties: {
        market_regime: {
          type: 'string',
          description: '大盘与 BTC 当前格局判断（如“BTC弱势下行，顺势空头优先”或“区间震荡，高观望纪律”）。',
        },
        position_reviews: {
          type: 'array',
          description: '逐个当前持仓的简明评估。',
          items: {
            type: 'object',
            properties: {
              symbol: { type: 'string' },
              status: { type: 'string', description: '论点是否依然成立、是否达加仓/锁利/离场条件。' },
            },
            required: ['symbol', 'status'],
          },
        },
        focus_candidates: {
          type: 'array',
          description: '本轮重点关注的候选标的与初步筛选结论。',
          items: {
            type: 'object',
            properties: {
              symbol: { type: 'string' },
              view: { type: 'string' },
            },
            required: ['symbol', 'view'],
          },
        },
      },
      required: ['market_regime'],
    },
  },
  {
    name: 'update_notes',
    description:
      '【第 2 步·可选】维护按标的唯一替换的跨轮观察笔记（强制包含可验证的数字价位/量比/指标触发条件），或在旧观察被市场证伪时累加 counterexamples 反例计数。',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['upsert', 'counterexample', 'delete'],
          description: '操作类型：upsert 写入/替换笔记，counterexample 记录一次反例，delete 删除笔记。',
        },
        symbol: { type: 'string', description: '合约标的（如 SOLUSDT）。' },
        note: { type: 'string', description: 'upsert 时必填：简明结构判断（≤240字）。' },
        trigger_condition: {
          type: 'string',
          description: 'upsert 时必填：必须含具体数字的可验证触发条件（如“15m放量站稳152.4且量比>1.8x”）。',
        },
        bias: { type: 'string', enum: ['long', 'short', 'neutral'] },
        confidence: { type: 'number', description: '0-100 信心度。' },
        reason: { type: 'string', description: 'counterexample 时说明市场如何证伪原判断。' },
      },
      required: ['op', 'symbol'],
    },
  },
  {
    name: 'update_thesis',
    description:
      '【第 2 步·可选】更新当前已持有仓位的结构化论点（加仓条件、减仓目标、结构失效位、时间止损小时数 time_stop_hours、最低进展 min_progress_r、最大不利偏移硬线 max_adverse_excursion_pct）。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '已持仓标的（如 SOLUSDT）。' },
        entry_basis: { type: 'string', description: '开仓核心依据。' },
        add_trigger: { type: 'string', description: '无风险金字塔加仓触发条件（如“盈利≥1R且突破156.2放量”）。' },
        reduce_target: { type: 'string', description: '分批减仓/止盈目标（如“到2R/阻力墙162.5减半锁利”）。' },
        invalidation: { type: 'string', description: '结构失效条件。' },
        time_stop_hours: { type: 'number', description: '相对当前时间多少小时后触发时间止损（1-72）。' },
        min_progress_r: { type: 'number', description: '到期要求的最低 R 进展（默认 0.3）。' },
        max_adverse_excursion_pct: {
          type: 'number',
          description: '价格口径最大不利偏移硬线 %（0.4-15，触线由 30s 守卫强制平仓）。',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_klines',
    description:
      '【可选·限流】仅在确需查验“上方档案未展开”的雷达外标的时拉取 K 线（每轮最多 4 次）。上方已展开标的自带最新 30 根 4h/15m/1m K 线，严禁重复拉取以免拖慢周期错过行情。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        timeframe: { type: 'string', enum: ['1m', '5m', '15m', '1h', '4h', '1d'] },
        count: { type: 'number', description: 'K 线根数（10-60，默认 30）。' },
      },
      required: ['symbol', 'timeframe'],
    },
  },
  {
    name: 'finalize',
    description:
      '【第 3 步·必选终结】提交本轮最终交易决策。严禁空决策：必须对每个已成交的真实持仓给出 hold 或战术动作（close/reduce/add/adjust_protection）；对未成交的待成交限价挂单，继续保留等待成交必须用 wait（切勿用 hold），需撤单时用 cancel_pending；对每个重点候选给出 wait/skip 或开仓动作（open_long/open_short）。执行 add_to_position 顺势滚仓时，请同步传入 position_size_usd、合并保本 stop_loss 以及顺延拓展后的新 take_profit。调用此工具后本轮决策立即结束。',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '本轮简明中文推理总结（大盘判断 + 持仓处置 + 候选结论）。',
        },
        next_check_in_minutes: {
          type: 'number',
          description:
            '可选：动态指定下次看盘间隔（范围 3-15 分钟；常规默认 15 分钟，仅在临近突破口/有待成交挂单/持仓贴近关键位时可提速至 3-10 分钟，超过 15 分钟会被系统自动钳回 15 分钟）。',
        },
        decisions: {
          type: 'array',
          description: '本轮完整决策列表。',
          items: {
            type: 'object',
            properties: {
              symbol: { type: 'string' },
              action: {
                type: 'string',
                enum: [
                  'open_long',
                  'open_short',
                  'close_long',
                  'close_short',
                  'reduce_position',
                  'add_to_position',
                  'adjust_protection',
                  'cancel_pending',
                  'hold',
                  'wait',
                  'skip',
                ],
              },
              entry_type: {
                type: 'string',
                enum: ['market', 'limit'],
                description:
                  '入场类型：放量突破刚确认且距 15m EMA20 ≤ 1.8×ATR 可直接 market 市价切入（强关注突破可用 50% 计划仓位先市价上底仓）；偏离过大（>2.0×ATR）或顶阻力墙用 limit 回踩限价，严禁撤单后在原远价位原地重挂。',
              },
              limit_price: { type: 'number', description: '限价入场价（entry_type=limit 时必填）。' },
              wait_minutes: {
                type: 'number',
                description: '限价单耐心等待上限（分钟，15-90，到期未成交系统自动撤单释放名额）。',
              },
              margin_mode: {
                type: 'string',
                enum: ['isolated', 'cross'],
                description:
                  '保证金模式：默认 isolated（逐仓隔离风险）；仅低波动主流趋势单且有严格硬止损时可选 cross（全仓）。',
              },
              leverage: { type: 'number' },
              position_size_usd: { type: 'number' },
              stop_loss: { type: 'number' },
              take_profit: { type: 'number' },
              reduce_percent: { type: 'number' },
              confidence: {
                type: 'number',
                description: '0-100 对本条判断的信心度（每条决策必填，含 wait/skip/hold）。',
              },
              reasoning: { type: 'string' },
              // 开仓时可内联初始论点字段（成交即刻落库绑定）
              add_trigger: { type: 'string' },
              reduce_target: { type: 'string' },
              invalidation: { type: 'string' },
              time_stop_hours: { type: 'number' },
              min_progress_r: { type: 'number' },
              max_adverse_excursion_pct: { type: 'number' },
            },
            required: ['symbol', 'action', 'confidence', 'reasoning'],
          },
        },
      },
      required: ['summary', 'decisions'],
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore invalid JSON */
  }
  return {};
}

function addNullable(a: number | null, b: number | null | undefined): number | null {
  if (b === null || b === undefined || !Number.isFinite(b)) return a;
  return (a ?? 0) + b;
}

function asFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function asText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function formatKlinesBrief(symbol: string, timeframe: string, klines: readonly Kline[]): string {
  if (klines.length === 0) return `${symbol} ${timeframe}: 无可用 K 线数据`;
  const tail = klines.slice(-20);
  const rows = tail.map((k) => {
    const tb = k.quoteVolume > 0 ? Math.round((k.takerBuyQuote / k.quoteVolume) * 100) : 50;
    return `${new Date(k.openTime).toISOString().slice(11, 16)},${k.open},${k.high},${k.low},${k.close},${Math.round(k.quoteVolume)},${tb}%`;
  });
  return `${symbol} ${timeframe} (最近${tail.length}根 t,O,H,L,C,qV,tb%):\n${rows.join('\n')}`;
}

/**
 * 将 `finalize` 工具调用参数归一化为标准 `<reasoning>` + `<decision>` 文本，
 * 并强制补全任何遗漏持仓的 `hold` 与遗漏展开候选的 `wait`（永不空决策）。
 */
export function normalizeFinalizePayload(
  args: Record<string, unknown>,
  openPositions: readonly PositionView[],
  candidateSymbols: readonly string[],
  pendingSymbols: readonly string[] = [],
): {
  text: string;
  pendingThesisPlans: Map<string, PendingThesisPlan>;
  decisionCount: number;
} {
  const summary = asText(args['summary']) ?? '完成本轮三段式评估。';
  const nextCheck = asFiniteNumber(args['next_check_in_minutes']);
  const rawList = Array.isArray(args['decisions']) ? args['decisions'] : [];

  const pendingThesisPlans = new Map<string, PendingThesisPlan>();
  const normalizedDecisions: Array<Record<string, unknown>> = [];
  const coveredSymbols = new Set<string>();
  const openSymbolSet = new Set(openPositions.map((p) => normalizeSymbol(p.symbol)));
  const pendingSymbolSet = new Set(pendingSymbols.map((s) => normalizeSymbol(s)).filter(Boolean));
  const allowedObservationSymbols = new Set<string>([
    ...openSymbolSet,
    ...pendingSymbolSet,
    ...candidateSymbols.map((s) => normalizeSymbol(s)),
  ]);

  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const sym = normalizeSymbol(String(obj['symbol'] ?? ''));
    const rawAction = String(obj['action'] ?? '').trim();
    let action = rawAction === 'add_position' ? 'add_to_position' : rawAction;
    if (!sym || !action) continue;

    // 语义防呆：`hold` 仅允许用于已成交的真实持仓；待成交限价挂单或观察标的误标 `hold` 一律纠偏为 `wait`
    if (action === 'hold' && !openSymbolSet.has(sym)) {
      action = 'wait';
    }

    // 对未展开的雷达榜外围标的，纯观察性 wait/skip 不送入解析器以免产生误报 rejected:wait/skip
    if (
      (action === 'wait' || action === 'skip') &&
      allowedObservationSymbols.size > 0 &&
      !allowedObservationSymbols.has(sym)
    ) {
      continue;
    }

    coveredSymbols.add(sym);

    // 剥离并暂存新开仓附带的初始论点字段
    if (action === 'open_long' || action === 'open_short') {
      const plan: PendingThesisPlan = {
        entryBasis: asText(obj['reasoning']),
        addTrigger: asText(obj['add_trigger']),
        reduceTarget: asText(obj['reduce_target']),
        invalidation: asText(obj['invalidation']),
        timeStopHours: asFiniteNumber(obj['time_stop_hours']),
        minProgressR: asFiniteNumber(obj['min_progress_r']),
        maxAdverseExcursionPct: asFiniteNumber(obj['max_adverse_excursion_pct']),
      };
      pendingThesisPlans.set(sym, plan);
    }

    const cleanDecision: Record<string, unknown> = {
      symbol: sym,
      action,
      reasoning: asText(obj['reasoning']) ?? summary,
    };
    const copyKeys = [
      'entry_type',
      'limit_price',
      'wait_minutes',
      'margin_mode',
      'leverage',
      'position_size_usd',
      'stop_loss',
      'take_profit',
      'reduce_percent',
      'reduce_quantity',
      'setup_score',
      'confidence',
    ] as const;
    for (const k of copyKeys) {
      if (obj[k] !== undefined && obj[k] !== null) cleanDecision[k] = obj[k];
    }
    normalizedDecisions.push(cleanDecision);
  }

  // 永不空决策兜底：确保每个当前持仓都有明确表态（缺省补 `hold`）
  for (const pos of openPositions) {
    const sym = normalizeSymbol(pos.symbol);
    if (!coveredSymbols.has(sym)) {
      coveredSymbols.add(sym);
      normalizedDecisions.push({
        symbol: sym,
        action: 'hold',
        confidence: 70,
        reasoning: '本轮评估论点未失效，继续按既有止损与论点硬线持有观察。',
      });
    }
  }

  // 永不空决策兜底：确保每个待成交限价挂单也有明确表态（缺省补 `wait`，UI 自动渲染为「待成交」）
  for (const sym of pendingSymbolSet) {
    if (!coveredSymbols.has(sym)) {
      coveredSymbols.add(sym);
      normalizedDecisions.push({
        symbol: sym,
        action: 'wait',
        confidence: 70,
        reasoning: '待成交限价挂单尚未触发失效条件，继续保留挂单等待成交。',
      });
    }
  }

  // 永不空决策兜底：确保每个展开候选标的都有明确表态（缺省补 `wait`）
  for (const rawSym of candidateSymbols) {
    const sym = normalizeSymbol(rawSym);
    if (!sym || coveredSymbols.has(sym)) continue;
    coveredSymbols.add(sym);
    normalizedDecisions.push({
      symbol: sym,
      action: 'wait',
      confidence: 70,
      reasoning: '本轮未满足入场综合优势条件，继续观望等待结构与量能确认。',
    });
  }

  const payload: Record<string, unknown> = {
    decisions: normalizedDecisions,
    ...(nextCheck !== undefined && nextCheck > 0 ? { next_check_in_minutes: nextCheck } : {}),
  };

  const safeSummary = summary.replace(/<\/?(?:decision|reasoning|tool)\b[^>]*>/gi, '');
  const text = `<reasoning>${safeSummary}</reasoning>\n<decision>${JSON.stringify(payload)}</decision>`;
  return { text, pendingThesisPlans, decisionCount: normalizedDecisions.length };
}

/* -------------------------------------------------------------------------- */
/*  Three-Stage Agentic Loop                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 执行智能托管 2.0 三段式 function-calling 决策循环：
 * `plan` → `update_notes` / `update_thesis` / `get_klines` → `finalize`。
 */
export async function runManagedAgenticLoop(input: ManagedEngineInput): Promise<ManagedEngineResult> {
  /*
   * 默认 5 轮（原 4 轮实盘 Cycle #51 撞坑：模型连查 3 轮 get_klines 后在第 4 轮调了 plan+update_notes，
   * 没收到“这是最后一轮”的硬约束，直接撞上限退回 fallback_hold_wait 静默丢掉了整轮刚算好的 XRPUSDT 挂单）。
   * 第 1~(maxRounds-1) 轮保持完整工具列表以维持前缀缓存高命中；仅当进入最后一轮仍未 finalize 时，
   * 收窄工具集为仅保留 finalize + toolChoice:'required'，确保整轮推理绝不被白白丢弃。
   */
  const maxRounds = Math.max(2, Math.min(8, input.maxRounds ?? 5));
  const maxKlineCalls = Math.max(1, Math.min(12, input.maxKlineCalls ?? 4));
  const finalizeOnlyTools = MANAGED_AGENT_TOOLS.filter((tool) => tool.name === 'finalize');
  const expandedSet = new Set(
    (input.expandedSymbols ?? []).map((s) => normalizeSymbol(s)).filter(Boolean),
  );
  const fetchedKlines = new Set<string>();
  let klineCallsUsed = 0;
  const nowMs = input.nowMs ?? Date.now();
  const messages: ChatMessage[] = [...input.baseMessages];
  const openPosBySymbol = new Map(input.openPositions.map((p) => [normalizeSymbol(p.symbol), p]));

  let totalLatencyMs = 0;
  const ttftSamples: number[] = [];
  const avgTtft = (): number | null =>
    ttftSamples.length > 0
      ? Math.round(ttftSamples.reduce((sum, v) => sum + v, 0) / ttftSamples.length)
      : null;
  let totalPrompt: number | null = null;
  let totalCompletion: number | null = null;
  let totalCached: number | null = null;
  let totalReasoning: number | null = null;

  const stageTrace: string[] = [];
  const stageSteps: ManagedStageStep[] = [];
  const shortSym = (sym: string): string => sym.replace(/USDT$/i, '');
  const biasText = (bias: RadarBias): string =>
    bias === 'long' ? '偏多' : bias === 'short' ? '偏空' : '中性';
  let planSummary = '';
  let lastText = '';

  for (let round = 1; round <= maxRounds; round += 1) {
    const isFinalTurn = round === maxRounds;
    if (isFinalTurn && round > 1 && messages[messages.length - 1]?.role !== 'user') {
      messages.push({
        role: 'user',
        content:
          '已进入本轮最终拍板回合，请立即调用 `finalize` 工具提交本轮全部持仓与候选的最终决策，不要再调用其它工具。',
      });
    }
    const res = await input.model.chat(messages, {
      signal: input.signal,
      tools: isFinalTurn ? finalizeOnlyTools : MANAGED_AGENT_TOOLS,
      toolChoice: isFinalTurn ? 'required' : 'auto',
    });

    totalLatencyMs += res.latencyMs;
    if (typeof res.ttftMs === 'number' && Number.isFinite(res.ttftMs) && res.ttftMs > 0) {
      ttftSamples.push(res.ttftMs);
    }
    totalPrompt = addNullable(totalPrompt, res.usage.promptTokens);
    totalCompletion = addNullable(totalCompletion, res.usage.completionTokens);
    totalCached = addNullable(totalCached, res.usage.cachedTokens);
    totalReasoning = addNullable(totalReasoning, res.usage.reasoningTokens);
    if (res.text.trim().length > 0) lastText = res.text;

    const calls = res.toolCalls ?? [];

    // 兼容分支：模型直接输出了 `<decision>...</decision>` 正文且未走工具调用 → 无缝接受
    if (calls.length === 0) {
      if (/<decision>[\s\S]*<\/decision>/i.test(res.text)) {
        return {
          text: res.text,
          latencyMs: totalLatencyMs,
          ttftMs: avgTtft(),
          ttftSamples,
          usage: {
            promptTokens: totalPrompt,
            completionTokens: totalCompletion,
            cachedTokens: totalCached,
            reasoningTokens: totalReasoning,
          },
          pendingThesisPlans: new Map(),
          stageTrace: [...stageTrace, 'direct_decision'],
          stageSteps,
          usedFinalizeTool: false,
        };
      }
      // 既没调工具也没给 `<decision>`：催促调用 `finalize` 拍板
      messages.push({ role: 'assistant', content: res.text });
      messages.push({
        role: 'user',
        content: '请立即调用 `finalize` 工具提交本轮完整决策（每个持仓与重点候选都需明确表态），不得空返。',
      });
      continue;
    }

    // 记录 assistant 工具调用消息
    messages.push({
      role: 'assistant',
      content: res.text,
      toolCalls: calls,
    });

    let finalized: {
      text: string;
      pendingThesisPlans: Map<string, PendingThesisPlan>;
      decisionCount: number;
    } | null = null;

    for (const call of calls) {
      const args = safeParseArgs(call.arguments);

      if (call.name === 'plan') {
        const regime = asText(args['market_regime']) ?? '已评估当前格局';
        planSummary = regime;
        stageTrace.push('plan');
        const planMeta: Array<{ label: string; value: string }> = [];
        if (Array.isArray(args['position_reviews'])) {
          for (const item of args['position_reviews'].slice(0, 6)) {
            if (!item || typeof item !== 'object') continue;
            const rec = item as Record<string, unknown>;
            const sym = normalizeSymbol(String(rec['symbol'] ?? ''));
            const st = asText(rec['status']);
            if (sym && st) planMeta.push({ label: `持仓 ${shortSym(sym)}`, value: st.slice(0, 140) });
          }
        }
        if (Array.isArray(args['focus_candidates'])) {
          for (const item of args['focus_candidates'].slice(0, 6)) {
            if (!item || typeof item !== 'object') continue;
            const rec = item as Record<string, unknown>;
            const sym = normalizeSymbol(String(rec['symbol'] ?? ''));
            const view = asText(rec['view']);
            if (sym && view) planMeta.push({ label: `聚焦 ${shortSym(sym)}`, value: view.slice(0, 140) });
          }
        }
        stageSteps.push({
          kind: 'plan',
          round,
          title: '大盘定调',
          summary: regime.slice(0, 260),
          ...(planMeta.length > 0 ? { meta: planMeta } : {}),
        });
        input.onStageEvent?.('plan', `阶段1[plan]：${regime.slice(0, 120)}`);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify({
            ok: true,
            next: '如需更新观察笔记请调 update_notes，如需修订持仓论点请调 update_thesis；完成后立即调用 finalize 提交最终决策。',
          }),
        });
        continue;
      }

      if (call.name === 'update_notes') {
        const op = String(args['op'] ?? 'upsert');
        const sym = normalizeSymbol(String(args['symbol'] ?? ''));
        let toolOut: Record<string, unknown>;
        if (!sym) {
          toolOut = { ok: false, error: '缺少合法 symbol' };
        } else if (op === 'delete') {
          const deleted = managedNotesStore.deleteNote(input.traderId, sym);
          stageTrace.push(`note_del:${sym}`);
          stageSteps.push({
            kind: 'note_del',
            round,
            symbol: sym,
            title: `清笔记 ${shortSym(sym)}`,
            summary: deleted ? '已清理失效观察笔记' : '无对应观察笔记可清理',
          });
          toolOut = { ok: true, deleted };
        } else if (op === 'counterexample') {
          const ceReason = asText(args['reason']);
          const r = managedNotesStore.recordCounterexample(
            input.traderId,
            sym,
            ceReason,
            nowMs,
          );
          stageTrace.push(`note_ce:${sym}(#${r.counterexamples})`);
          stageSteps.push({
            kind: 'note_ce',
            round,
            symbol: sym,
            title: `反例 ${shortSym(sym)} #${r.counterexamples}`,
            summary: (ceReason ?? '市场走势证伪原有观察假设').slice(0, 260),
            meta: [
              { label: '反例计数', value: `第 ${r.counterexamples} 次` },
              { label: '笔记状态', value: r.retired ? '已自动淘汰' : '继续衰减观察' },
            ],
          });
          input.onStageEvent?.(
            'update_notes',
            `阶段2[笔记反例] ${sym} 反例计数=${r.counterexamples}${r.retired ? '（已自动退休淘汰）' : ''}`,
          );
          toolOut = { ok: true, ...r };
        } else {
          const biasRaw = String(args['bias'] ?? 'neutral');
          const bias: RadarBias = biasRaw === 'long' || biasRaw === 'short' ? biasRaw : 'neutral';
          const conf = asFiniteNumber(args['confidence']);
          const saved = managedNotesStore.upsertNote({
            traderId: input.traderId,
            symbol: sym,
            note: String(args['note'] ?? ''),
            triggerCondition: String(args['trigger_condition'] ?? ''),
            bias,
            confidence: conf,
            nowMs,
          });
          if (saved.ok) {
            stageTrace.push(`note:${sym}`);
            const noteMeta: Array<{ label: string; value: string }> = [
              { label: '方向', value: biasText(bias) },
            ];
            if (conf !== undefined) {
              noteMeta.push({ label: '信心', value: `${Math.round(conf)}%` });
            }
            if (saved.note.triggerCondition) {
              noteMeta.push({ label: '触发条件', value: saved.note.triggerCondition.slice(0, 220) });
            }
            stageSteps.push({
              kind: 'note',
              round,
              symbol: sym,
              title: `笔记 ${shortSym(sym)}`,
              summary: saved.note.note.slice(0, 300),
              meta: noteMeta,
            });
            input.onStageEvent?.(
              'update_notes',
              `阶段2[更新笔记] ${sym} 触发[${saved.note.triggerCondition}]`,
            );
            toolOut = {
              ok: true,
              symbol: saved.note.symbol,
              triggerCondition: saved.note.triggerCondition,
              expiresAt: saved.note.expiresAt,
            };
          } else {
            toolOut = { ok: false, error: saved.reason };
          }
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify(toolOut),
        });
        continue;
      }

      if (call.name === 'update_thesis') {
        const sym = normalizeSymbol(String(args['symbol'] ?? ''));
        const pos = openPosBySymbol.get(sym);
        let toolOut: Record<string, unknown>;
        if (!pos) {
          toolOut = {
            ok: false,
            error: `当前未持有 ${sym || '(空)'} 仓位；开新仓时请直接在 finalize 的开仓项里附带 time_stop_hours / max_adverse_excursion_pct / add_trigger 字段。`,
          };
        } else {
          const entryBasis = asText(args['entry_basis']);
          const addTrigger = asText(args['add_trigger']);
          const reduceTarget = asText(args['reduce_target']);
          const invalidation = asText(args['invalidation']);
          const timeStopHours = asFiniteNumber(args['time_stop_hours']);
          const minProgressR = asFiniteNumber(args['min_progress_r']);
          const maePct = asFiniteNumber(args['max_adverse_excursion_pct']);
          const updated = managedThesisStore.upsertActive({
            traderId: input.traderId,
            symbol: sym,
            side: pos.side,
            entryPrice: pos.entryPrice,
            initialStopLoss: pos.stopLoss ?? pos.entryPrice,
            entryBasis,
            addTrigger,
            reduceTarget,
            invalidation,
            timeStopHours,
            minProgressR,
            maxAdverseExcursionPct: maePct,
            nowMs,
          });
          stageTrace.push(`thesis:${sym}`);
          const thesisMeta: Array<{ label: string; value: string }> = [];
          if (addTrigger) thesisMeta.push({ label: '加仓条件', value: addTrigger.slice(0, 160) });
          if (reduceTarget) thesisMeta.push({ label: '减仓目标', value: reduceTarget.slice(0, 160) });
          if (invalidation) thesisMeta.push({ label: '失效条件', value: invalidation.slice(0, 160) });
          if (timeStopHours !== undefined) thesisMeta.push({ label: '时间止损', value: `${timeStopHours}h` });
          if (updated.maxAdverseExcursionPct != null) {
            thesisMeta.push({ label: 'MAE 硬线', value: `${updated.maxAdverseExcursionPct}%` });
          }
          stageSteps.push({
            kind: 'thesis',
            round,
            symbol: sym,
            title: `论点 ${shortSym(sym)}`,
            summary: (entryBasis ?? invalidation ?? '已更新持仓结构化论点').slice(0, 260),
            ...(thesisMeta.length > 0 ? { meta: thesisMeta } : {}),
          });
          input.onStageEvent?.(
            'update_thesis',
            `阶段2[更新论点] ${sym} 时间止损=${updated.timeStopAt ?? '无'} MAE=${updated.maxAdverseExcursionPct ?? '无'}%`,
          );
          toolOut = {
            ok: true,
            symbol: updated.symbol,
            timeStopAt: updated.timeStopAt,
            minProgressR: updated.minProgressR,
            maxAdverseExcursionPct: updated.maxAdverseExcursionPct,
          };
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify(toolOut),
        });
        continue;
      }

      if (call.name === 'get_klines') {
        const sym = normalizeSymbol(String(args['symbol'] ?? ''));
        const tf = String(args['timeframe'] ?? '15m') as Timeframe;
        const count = Math.max(10, Math.min(60, Math.round(asFiniteNumber(args['count']) ?? 30)));
        const klineKey = `${sym}:${tf}`;
        let content = `${sym}: K 线接口不可用`;
        if (sym && expandedSet.has(sym) && (tf === '4h' || tf === '15m' || tf === '1m')) {
          content = `${sym} 的 ${tf} K 线（最新 30 根）已在上方标的档案中完整提供，无需重复拉取，请直接基于已有数据决策。`;
          stageTrace.push(`klines_dup:${sym}:${tf}`);
          stageSteps.push({
            kind: 'klines_dup',
            round,
            symbol: sym,
            title: `重复查K ${shortSym(sym)} ${tf}`,
            summary: '已在档案中提供，系统拦截重复拉取',
          });
        } else if (sym && fetchedKlines.has(klineKey)) {
          content = `本轮已拉取过 ${sym} ${tf} K 线，请直接参考前文工具返回。`;
          stageTrace.push(`klines_dup:${sym}:${tf}`);
          stageSteps.push({
            kind: 'klines_dup',
            round,
            symbol: sym,
            title: `重复查K ${shortSym(sym)} ${tf}`,
            summary: '本轮已拉取过该周期，跳过重复请求',
          });
        } else if (klineCallsUsed >= maxKlineCalls) {
          content = `本轮额外 K 线查验已达上限（${maxKlineCalls} 次），为保证实盘决策时效请停止泛查，立即基于已有数据进入 plan / finalize 拍板。`;
          stageTrace.push(`klines_cap:${sym}:${tf}`);
          stageSteps.push({
            kind: 'klines_cap',
            round,
            symbol: sym,
            title: `查K限流 ${shortSym(sym)} ${tf}`,
            summary: `本轮补查已达上限（${maxKlineCalls} 次）`,
          });
        } else if (sym && input.getKlines) {
          try {
            const klines = await input.getKlines(sym, tf, count);
            klineCallsUsed += 1;
            fetchedKlines.add(klineKey);
            content = formatKlinesBrief(sym, tf, klines);
            stageTrace.push(`klines:${sym}:${tf}`);
            stageSteps.push({
              kind: 'klines',
              round,
              symbol: sym,
              title: `K线 ${shortSym(sym)} ${tf}`,
              summary: `主动补查雷达外 ${sym} ${tf} 周期最近 ${klines.length} 根 K 线`,
            });
          } catch (err) {
            content = `${sym} ${tf} 拉取失败：${(err as Error).message}`;
          }
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content,
        });
        continue;
      }

      if (call.name === 'finalize') {
        finalized = normalizeFinalizePayload(
          args,
          input.openPositions,
          input.candidateSymbols,
          input.pendingSymbols,
        );
        const nextCheckRaw = asFiniteNumber(args['next_check_in_minutes']);
        const nextCheckClamped =
          nextCheckRaw !== undefined && nextCheckRaw > 0
            ? Math.max(3, Math.min(15, Math.round(nextCheckRaw)))
            : undefined;
        stageTrace.push(`finalize(${finalized.decisionCount})`);
        const finMeta: Array<{ label: string; value: string }> = [
          { label: '工具轮次', value: `${round} 轮` },
          { label: '提交决策', value: `${finalized.decisionCount} 项` },
        ];
        if (nextCheckClamped !== undefined) {
          finMeta.push({
            label: '下次复查',
            value: nextCheckClamped < 15 ? `提前 ${nextCheckClamped} 分钟` : '常规 15 分钟',
          });
        }
        stageSteps.push({
          kind: 'finalize',
          round,
          title: `提交(${finalized.decisionCount})`,
          summary: asText(args['summary'])?.slice(0, 260),
          meta: finMeta,
        });
        input.onStageEvent?.(
          'finalize',
          `阶段3[finalize] 已提交 ${finalized.decisionCount} 条结构化决策（轨迹：${stageTrace.join(' → ')}）`,
        );
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify({ ok: true, accepted: finalized.decisionCount }),
        });
        continue;
      }

      // 未知工具名安全回复
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: JSON.stringify({ ok: false, error: `不支持的工具名：${call.name}` }),
      });
    }

    if (finalized) {
      return {
        text: finalized.text,
        latencyMs: totalLatencyMs,
        ttftMs: avgTtft(),
        ttftSamples,
        usage: {
          promptTokens: totalPrompt,
          completionTokens: totalCompletion,
          cachedTokens: totalCached,
          reasoningTokens: totalReasoning,
        },
        pendingThesisPlans: finalized.pendingThesisPlans,
        stageTrace,
        stageSteps,
        usedFinalizeTool: true,
      };
    }
  }

  // 超出最大轮次仍未调 finalize：安全兜底输出永不空决策的 hold / wait，绝不崩溃或盲动
  const fallback = normalizeFinalizePayload(
    {
      summary: planSummary || lastText.slice(0, 300) || '达到最大工具轮次，按高观望纪律保持既有持仓与观望。',
      decisions: [],
    },
    input.openPositions,
    input.candidateSymbols,
    input.pendingSymbols,
  );
  stageTrace.push('fallback_hold_wait');
  stageSteps.push({
    kind: 'fallback',
    round: maxRounds,
    title: '轮次上限兜底',
    summary: `经过 ${maxRounds} 轮工具调用未提交 finalize，已按高观望纪律兜底保持既有持仓与观望`,
  });
  return {
    text: fallback.text,
    latencyMs: totalLatencyMs,
    ttftMs: avgTtft(),
    ttftSamples,
    usage: {
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      cachedTokens: totalCached,
      reasoningTokens: totalReasoning,
    },
    pendingThesisPlans: fallback.pendingThesisPlans,
    stageTrace,
    stageSteps,
    usedFinalizeTool: false,
  };
}
