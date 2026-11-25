/**
 * 智能托管 2.0 精简结构化 Prompt 渲染器（`packages/server/src/managed/prompt.ts`）
 *
 * 设计目标（对齐 `docs/AI-MANAGED-2.0-SPEC.md`）：
 *   1. **高信噪比红线**：单轮 User Prompt 严格 ≤ 30,000 字符（目标 16,000–26,000 字符），
 *      彻底告别过去 15.5 万字噪音灌注，将 DeepSeek v4.1-flash 推理延迟压进秒级。
 *   2. **只展开核心标的**：仅完整展开「当前持仓 + AI500 雷达 Top 3–5 高分起爆候选」，
 *      其余标的折叠为 1 行全市场雷达榜概览。
 *   3. **黄金三周期契约**：每个展开标的固定给 **`4h`（大趋势）+ `15m`（结构与突破）+ `1m`（精准入场与止损位）**
 *      各 30 根干净 OHLCV（超预算时自动逐级压缩，确保绝不突破 30,000 字符硬上限）。
 *   4. **结论前置、拒绝心算**：AI500 六维明细、POC/VA/上下筹码墙、清算磁吸区、15m 环比增量 Δ、
 *      持仓 R 倍数/成本止损偏移全部预先算好直接喂给模型。
 *   5. **前缀缓存友好**：拆分为 `stablePrompt`（变动频率低的账户规则/记忆/近期复盘）与
 *      `volatilePrompt`（每轮实时行情/持仓/雷达），保持 DeepSeek 前缀缓存高命中率。
 */

import {
  closeReasonLabel,
  inferManagedRiskProfile,
  MANAGED_RISK_PROFILES,
  type Kline,
  type StrategyConfig,
} from '@aq/shared';

import type { Ai500Candidate } from '../radar/ai500.js';
import { formatRadarDeltaLine, type RadarDelta } from '../radar/deltaTracker.js';
import {
  formatCompactPrice,
  formatVolumeProfileLine,
  type VolumeProfileResult,
} from '../radar/volumeProfile.js';
import type {
  PromptAccountInfo,
  PromptMemory,
  PromptPendingEntry,
  PromptPosition,
} from '../strategy/prompt.js';
import { formatManagedNotesSection, type ManagedNote } from './notes.js';
import { computePositionTactics, formatPositionTacticsLines } from './tactics.js';
import type { PositionThesis } from './thesis.js';

/* -------------------------------------------------------------------------- */
/*  Constants & Public Types                                                   */
/* -------------------------------------------------------------------------- */

/** 硬性 Prompt 字符红线（`docs/AI-MANAGED-2.0-SPEC.md` §1）。 */
export const MANAGED_PROMPT_CHAR_LIMIT = 30_000;

/** 黄金三周期契约：每周期默认 30 根已收盘 OHLCV。 */
export const MANAGED_KLINE_BARS = 30;

export interface ManagedSymbolDossier {
  symbol: string;
  /** 是否为当前持仓标的（持仓优先级最高，绝不可被裁剪）。 */
  isHeld: boolean;
  /** AI500 六维评分结果。 */
  radar: Ai500Candidate;
  /** 筹码分布（POC / VA / 支撑阻力墙 / 清算磁吸区）。 */
  volumeProfile: VolumeProfileResult | null;
  /** 与上一轮的 15m 环比增量 Δ。 */
  delta: RadarDelta;
  /** 黄金三周期已收盘 K 线（各最多 30 根）。 */
  klines: {
    '4h': readonly Kline[];
    '15m': readonly Kline[];
    '1m': readonly Kline[];
  };
  /** 交易所单标的最小名义价值与杠杆上限（可选）。 */
  minNotionalUsd?: number;
  maxLeverage?: number;
}

export interface ManagedPromptContext {
  traderName: string;
  cycleNumber: number;
  now: Date;
  config: StrategyConfig;
  account: PromptAccountInfo;
  positions: readonly PromptPosition[];
  pendingEntries: readonly PromptPendingEntry[];
  /** 已排序并展开的标的档案（含持仓 + Top 3–5 雷达高分标的）。 */
  dossiers: readonly ManagedSymbolDossier[];
  /** 全市场雷达 Top 10 极简榜单（仅 1 行概览，让模型看见次优梯队但不占字数）。 */
  radarLeaderboard: readonly Ai500Candidate[];
  /** 市场基准 BTC 概览行（例如 `BTCUSDT 68200 · 1h +0.4% · 4h +1.2% · 24h +2.1%`）。 */
  btcBenchmarkLine: string | null;
  cycleIntervalMinutes: number;
  roundTripCostPercent?: number | null;
  idleCycles?: number;
  memory?: PromptMemory;
  /** M3.1：当前活跃持仓论点映射（symbol → PositionThesis）。 */
  thesesBySymbol?: ReadonlyMap<string, PositionThesis>;
  /** M3.3：活跃反例衰减观察笔记列表。 */
  managedNotes?: readonly ManagedNote[];
  /** M3.4：是否开启原生 function-calling 三段式决策协议提示。 */
  enableAgenticProtocol?: boolean;
}

export interface ManagedPromptBundle {
  systemPrompt: string;
  stablePrompt: string;
  volatilePrompt: string;
  userPrompt: string;
  stats: {
    userChars: number;
    systemChars: number;
    expandedSymbols: number;
    barsPerTf: { '4h': number; '15m': number; '1m': number };
    compactionLevel: number;
  };
}

/* -------------------------------------------------------------------------- */
/*  Formatting Helpers                                                         */
/* -------------------------------------------------------------------------- */

function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '$0.00';
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function fmtSignedPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'N/A';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function fmtShortTime(ms: number, includeDate: boolean): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hhmm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (!includeDate) return hhmm;
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${hhmm}`;
}

function fmtVolShort(quoteVol: number): string {
  if (!Number.isFinite(quoteVol) || quoteVol <= 0) return '0';
  if (quoteVol >= 1e6) return `${(quoteVol / 1e6).toFixed(1)}M`;
  if (quoteVol >= 1e3) return `${(quoteVol / 1e3).toFixed(0)}K`;
  return quoteVol.toFixed(0);
}

/**
 * 渲染紧凑 OHLCV 表：每根 K 线 1 行 `t,O,H,L,C,V,tb%`（约 38–46 字符）。
 */
function renderKlineTable(
  tf: '4h' | '15m' | '1m',
  klines: readonly Kline[],
  maxBars: number,
): string {
  if (klines.length === 0 || maxBars <= 0) return `[${tf}] 无数据`;
  const slice = klines.slice(-maxBars);
  const includeDate = tf === '4h';
  const lines: string[] = [`[${tf} ×${slice.length}] t(UTC),O,H,L,C,V,tb%`];
  for (const k of slice) {
    const tbPct =
      k.quoteVolume > 0 && Number.isFinite(k.takerBuyQuote)
        ? Math.round(Math.max(0, Math.min(1, k.takerBuyQuote / k.quoteVolume)) * 100)
        : k.volume > 0 && Number.isFinite(k.takerBuyBase)
          ? Math.round(Math.max(0, Math.min(1, k.takerBuyBase / k.volume)) * 100)
          : 50;
    lines.push(
      `${fmtShortTime(k.openTime, includeDate)},${formatCompactPrice(k.open)},${formatCompactPrice(k.high)},${formatCompactPrice(k.low)},${formatCompactPrice(k.close)},${fmtVolShort(k.quoteVolume)},${tbPct}%`,
    );
  }
  return lines.join('\n');
}

function biasLabel(bias: Ai500Candidate['bias']): string {
  return bias === 'long' ? '多头顺势' : bias === 'short' ? '空头顺势' : '中性震荡';
}

function tierLabel(tier: Ai500Candidate['tier']): string {
  return tier === 'strong' ? '★强关注(≥75)' : tier === 'watch' ? '○观察(65-74)' : '·偏弱(<65)';
}

/* -------------------------------------------------------------------------- */
/*  System Prompt (Static & Cacheable)                                         */
/* -------------------------------------------------------------------------- */

export function buildManagedSystemPrompt(ctx: ManagedPromptContext): string {
  const rc = ctx.config.riskControl;
  const cb = ctx.config.circuitBreaker;
  const riskProfile = MANAGED_RISK_PROFILES[inferManagedRiskProfile(ctx.config)];

  const lines: string[] = [
    '你是专业加密永续合约自主交易员（智能托管 2.0 内核）。你的唯一目标是在严守风控底线的前提下，通过「高观望纪律 + 精准顺势入场 + 大盈亏比波段持仓」实现长期正期望复利。',
    '',
    '## 一、核心交易纪律（硬原则）',
    '1. **高观望纪律（宁缺毋滥）**：没有明确优势时，本轮输出空决策或 `wait` 是最优秀的决策；绝不因为空仓而强行找单开仓。',
    '2. **AI500 多因子准入与入场方式（市价 vs 限价）**：',
    '   - 评分 ≥ 75（强关注）且结构位置合理、量能/Taker/OI 确认、有清晰失效位 → 优先评估入场；',
    '   - 评分 65–74（观察）→ 仅当筹码位置极佳（回踩 POC/支撑阻力墙）且盈亏比 ≥ 3:1 时轻仓试仓，否则观望；',
    '   - 评分 < 65 → 原则不新开仓（持仓管理除外）；',
    '   - **市价 vs 限价清晰分界**：刚放量突破/破位确认且距 15m EMA20 ≤ 1.5×ATR（无追单风险）时，**可直接用 `market` 市价切入**（或贴现价 0.2%–0.5% 限价），不因盲目挂远价而踏空主升/主跌浪；只有偏离 15m EMA20 > 2.0×ATR、顶着强阻力墙或带有「追单风险」「长影线插针」警示时，才用 `limit` 回踩限价并填写合理的 `wait_minutes`（通常 20–45 分钟）；',
    '   - **挂单改价 / 撤单**：已有未成交限价挂单若行情已走远或结构价位迁移，**可在同一轮 `finalize` 中直接同时提交 `cancel_pending` + 新的 `open_long/open_short`**（系统会先撤旧单再挂新单或市价进场，不要白白再干等一整轮）。',
    '3. **多空双向顺势**：遵循 4h 大趋势与 15m 结构共振，利用 1m 精确找入场与止损位；止损放在真实结构失效位之外（避开整数位与清算扫荡区），严禁贴着现价放必被噪音扫掉的窄止损。',
    '4. **大盈亏比波段管理（目标 3:1 ~ 5:1）**：',
    '   - 试仓 → 盈利 ≥ 1R 且突破确认、战术面板提示可无风险加仓时，优先考虑金字塔加仓 50% 并同步把止损移至合并均价保本位（避开整数位）；',
    '   - 盈利 ≥ 2R 或遇强阻力墙/清算磁吸/动能衰减时，用 `reduce_position` 分批减仓锁利，并沿 15m 结构高低点外侧（非整数位）上移止损；',
    '   - 严禁亏损摊平加仓；每个持仓须明确时间止损（`time_stop_hours`）与最大不利偏移硬线（`max_adverse_excursion_pct`），由 30 秒守卫机器硬执行；逻辑被市场否定即果断平仓。',
    '5. **每单杠杆与保证金模式自主决策（严禁机械写死 3x~5x）**：',
    '   - 在下方风险护栏上限与交易所对该币种/账号的实际杠杆上限（取较小值）之内，每笔单子的 `leverage` 完全由你按「**止损距离 + ATR 波动率 + 信号确定性**」动态决定；',
    '   - **强平安全铁律**：强平距离必须明显大于止损距离（建议 `leverage ≤ 40 / 止损距离%`，即强平距离 ≥ 2.5× 止损距离），绝不让插针在止损触发前抢先强平；',
    '   - **资金效率**：低波动高流动性标的（如 BTC/ETH）配合清晰紧凑结构止损（1%–1.5%）时，可大胆给到较高杠杆提升资金效率；高波动山寨或宽止损（3%–5%）则主动降低杠杆、控制单笔真实风险额；',
    '   - **保证金模式（`margin_mode`）**：由你按标的波动率决定——山寨币和高波动标的优先 `isolated`（逐仓隔离风险），低波动主流趋势单且有严格硬止损时可按需选 `cross`（全仓）。',
    '',
    `## 二、不可绕过的物理安全硬底线（当前风险护栏：${riskProfile.label}档）`,
    `- 最大同时持仓：${rc.maxPositions} 笔 · 保证金占用上限：${rc.maxMarginUsage}%`,
    `- 护栏杠杆上限：BTC/ETH ≤ ${rc.btcEthMaxLeverage}x，山寨 ≤ ${rc.altcoinMaxLeverage}x（单币实际再与交易所账户上限取小）`,
    `- 每笔开仓**必须**同时给出合法 stop_loss（且距入场至少覆盖 3× 往返手续费）；建议同时给出 take_profit（期望盈亏比 ≥ ${Math.max(1.8, rc.minRiskRewardRatio).toFixed(1)}:1）`,
    `- 账户熔断：单日亏损 ≥ ${cb.maxDailyLossPercent}% 或总回撤 ≥ ${cb.maxTotalDrawdownPercent}% 自动禁止新开仓`,
    '',
    '## 三、三段式决策协议（严格遵守）',
    ...(ctx.enableAgenticProtocol
      ? [
          '1. **阶段 1（`plan`）**：先调用 `plan` 工具声明大盘格局、逐个持仓复盘与重点候选结论；',
          '2. **阶段 2（`update_notes` / `update_thesis` · 按需并行）**：',
          '   - 有新的明确价位/量能观察机会，或旧笔记被市场证伪时，调用 `update_notes`（必须带数字可验证条件，被证伪记反例）；',
          '   - 需要修订已有持仓的加仓/减仓条件、时间止损或 MAE 硬线时，调用 `update_thesis`；',
          '3. **阶段 3（`finalize` · 必选终结）**：最后必须调用 `finalize` 提交完整决策数组——**永不空决策**：每个持仓必须给出 `hold` 或战术动作，每个重点候选必须给出 `wait`/`skip` 或开仓动作；新开仓建议一并填写 `time_stop_hours` / `max_adverse_excursion_pct` / `add_trigger` / `reduce_target` / `invalidation`。',
        ]
      : [
          '1. 先在 `<reasoning>...</reasoning>` 内用简洁中文给出：大盘判断 → 持仓处置评估 → 候选标的逐一筛选（为什么做或为什么观望）。',
          '2. 再在 `<decision>...</decision>` 内输出合法 JSON（`{"decisions":[...]}` 或数组）：',
          '   - 开仓：`{"symbol":"SOLUSDT","action":"open_long|open_short","entry_type":"market|limit","limit_price":可选,"leverage":3,"position_size_usd":200,"stop_loss":142.5,"take_profit":172.0,"confidence":82,"reasoning":"简明逻辑与失效位"}`',
          '   - 平仓/减仓/加仓/调保护位/撤挂单/观望：`close_long|close_short|reduce_position|add_to_position|adjust_protection|cancel_pending|hold|wait`',
          '3. 如确实需要查看雷达外标的的 K 线或调整自身运行参数，可在给出 `<decision>` 前输出 `<tool>{"tool":"get_klines|screen_symbols|set_params|write_memory","args":{...}}</tool>`。',
        ]),
  ];

  // 若模型曾经通过 set_params 写过精简自定义纪律，限量附在 system 尾部（最多 1500 字，防规则膨胀失控）
  const customNote = ctx.config.promptSections?.entryStandards?.trim();
  if (customNote && customNote.length > 0) {
    const clipped = customNote.length > 1500 ? `${customNote.slice(0, 1500)}…(已截断)` : customNote;
    lines.push('', '## 四、策略补充备忘（限长 1500 字）', clipped);
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  User Prompt (Stable + Volatile, Strict <= 30,000 chars)                    */
/* -------------------------------------------------------------------------- */

function renderStableSection(ctx: ManagedPromptContext): string {
  const sections: string[] = [];
  const mem = ctx.memory;

  // 1) 最近已平仓复盘（最多 6 笔）
  if (mem && mem.recentCloses.length > 0) {
    const recent = mem.recentCloses.slice(0, 6);
    const rows = recent.map((t) => {
      const sideCn = t.side === 'long' ? '多' : '空';
      const net = Number.isFinite(t.netPnl) ? t.netPnl : t.pnl;
      const reason = closeReasonLabel(t.closeReason);
      return `- ${t.symbol} ${sideCn} ${t.leverage}x · 净${net >= 0 ? '+' : ''}${net.toFixed(2)}U (${fmtSignedPct(t.pnlPercent, 1)}) · ${reason}`;
    });
    sections.push(`# 最近平仓（最近 ${recent.length} 笔）\n${rows.join('\n')}`);
  }

  // 2) 最近风控拒绝（最多 4 条，避免重复犯错）
  if (mem && mem.recentRejections.length > 0) {
    const rows = mem.recentRejections
      .slice(0, 4)
      .map((r) => `- ${r.symbol} ($${r.positionSizeUsd.toFixed(0)})：${r.reason.slice(0, 100)}`);
    sections.push(`# 近期风控拦截提醒\n${rows.join('\n')}`);
  }

  // 3) 跨轮复盘教训（严格限流，最多 4 条 × 120 字）
  if (mem && mem.lessons.length > 0) {
    const notes = mem.lessons
      .slice(0, 4)
      .map((l) => {
        const text = l.lesson.replace(/\s+/g, ' ').trim();
        return `- [复盘 ${l.symbol} · ${closeReasonLabel(l.closeReason)} · ${l.netPnl >= 0 ? '+' : ''}${l.netPnl.toFixed(2)}U] ${text.slice(0, 120)}`;
      });
    sections.push(`# 历史复盘教训\n${notes.join('\n')}`);
  }

  // 4) M3.3 反例衰减跨轮观察笔记
  if (ctx.managedNotes && ctx.managedNotes.length > 0) {
    const notesBlock = formatManagedNotesSection(ctx.managedNotes);
    if (notesBlock) sections.push(notesBlock);
  }

  return sections.join('\n\n');
}

function renderPositionsSection(ctx: ManagedPromptContext): string {
  const lines: string[] = ['# 当前持仓战术面板与挂单'];
  const dossierBySymbol = new Map(ctx.dossiers.map((d) => [d.symbol, d]));
  const feeRate =
    ctx.roundTripCostPercent !== undefined &&
    ctx.roundTripCostPercent !== null &&
    Number.isFinite(ctx.roundTripCostPercent) &&
    ctx.roundTripCostPercent > 0
      ? ctx.roundTripCostPercent / 100
      : 0.001;

  if (ctx.positions.length === 0) {
    lines.push('- 当前无持仓（空仓等待高质量信号）。');
  } else {
    for (const item of ctx.positions) {
      const p = item.position;
      const sideCn = p.side === 'long' ? '多' : '空';
      const pnlSign = p.unrealizedPnl >= 0 ? '+' : '';
      const pricePnlPct =
        p.entryPrice > 0
          ? ((p.side === 'long' ? p.markPrice - p.entryPrice : p.entryPrice - p.markPrice) /
              p.entryPrice) *
            100
          : 0;
      const holdMin = Math.round(item.holdingMinutes);
      const holdStr = holdMin >= 60 ? `${(holdMin / 60).toFixed(1)}h` : `${holdMin}m`;
      const thesis = ctx.thesesBySymbol?.get(p.symbol) ?? null;
      const dossier = dossierBySymbol.get(p.symbol) ?? null;
      const tactics = computePositionTactics({
        position: p,
        thesis,
        radar: dossier?.radar ?? null,
        roundTripFeeRate: feeRate,
        nowMs: ctx.now.getTime(),
      });
      lines.push(
        `- **${p.symbol} ${sideCn} ${p.leverage}x** | 名义 ${fmtUsd(p.notional)} · 均价 ${formatCompactPrice(p.entryPrice)} → 现价 ${formatCompactPrice(p.markPrice)} (${fmtSignedPct(pricePnlPct, 2)}) · 浮盈 ${pnlSign}${p.unrealizedPnl.toFixed(2)}U (${fmtSignedPct(p.unrealizedPnlPercent, 1)} ROE) · 持仓 ${holdStr} · SL=${p.stopLoss ? formatCompactPrice(p.stopLoss) : '未设'} · TP=${p.takeProfit ? formatCompactPrice(p.takeProfit) : '未设'}`,
      );
      lines.push(...formatPositionTacticsLines(tactics, thesis));
    }
  }

  if (ctx.pendingEntries.length > 0) {
    lines.push('**待成交限价挂单：**');
    for (const pe of ctx.pendingEntries) {
      const sideCn = pe.side === 'long' ? '多' : '空';
      lines.push(
        `- ${pe.symbol} 限价${sideCn} @ ${formatCompactPrice(pe.limitPrice)} · 已等 ${Math.round(pe.waitingMinutes)}m · SL=${pe.stopLoss ? formatCompactPrice(pe.stopLoss) : '无'} · TP=${pe.takeProfit ? formatCompactPrice(pe.takeProfit) : '无'}`,
      );
    }
  }

  return lines.join('\n');
}

function renderDossierBlock(
  d: ManagedSymbolDossier,
  bars: { '4h': number; '15m': number; '1m': number },
): string {
  const r = d.radar;
  const m = r.metrics;
  const dim = r.dimensions;
  const heldTag = d.isHeld ? ' [持仓中]' : '';
  const tagText = r.tags.length > 0 ? r.tags.join(' | ') : '常规波动';

  const header = [
    `## ${d.symbol}${heldTag} — AI500 **${r.score}/100** (${tierLabel(r.tier)} · ${biasLabel(r.bias)})`,
    `- 维度拆解：趋势 ${dim.trend}/20 · 突破量能 ${dim.breakout}/20 · OI流 ${dim.oiFlow}/15 · Taker ${dim.takerFlow}/15 · 费率 ${dim.funding}/15 · Alpha/位置 ${dim.alphaPosition}/15`,
    `- 预计算指标：现价 ${formatCompactPrice(m.price)} · 1h ${fmtSignedPct(m.change1hPct, 1)} / 4h ${fmtSignedPct(m.change4hPct, 1)} / 24h ${fmtSignedPct(m.change24hPct, 1)} · RS(vs BTC 4h) ${fmtSignedPct(m.rsAlpha4hPct, 1)} · 24h额 ${fmtUsd(m.quoteVolume24h)} · 15m量比 ${m.volRatio15m}x · 实体比 ${Math.round(m.bodyRatio15m * 100)}% · ATR15m ${m.atr15mPct}% · 距EMA20 ${m.distEma20Atr}×ATR`,
    `- 资金流与费率：Taker买比 1h=${Math.round(m.takerBuyRatio1h * 100)}% / 4h=${Math.round(m.takerBuyRatio4h * 100)}% (CVD:${m.cvdTrend}) · OI ${m.openInterestUsd ? fmtUsd(m.openInterestUsd) : 'N/A'} (1h ${fmtSignedPct(m.oiChange1hPct, 1)} / 4h ${fmtSignedPct(m.oiChange4hPct, 1)}) · 资金费 ${m.fundingRatePct !== null ? `${m.fundingRatePct >= 0 ? '+' : ''}${m.fundingRatePct.toFixed(4)}%` : 'N/A'}`,
    `- 筹码与清算：${d.volumeProfile ? formatVolumeProfileLine(d.volumeProfile) : '样本不足'}`,
    `- 动能变化：${formatRadarDeltaLine(d.delta)}`,
    `- 信号标签：${tagText}${d.minNotionalUsd || d.maxLeverage ? ` · 合约约束(最小额 ${fmtUsd(d.minNotionalUsd ?? 5)}, 最大杠杆 ${d.maxLeverage ?? 10}x)` : ''}`,
  ];

  const klineBlocks: string[] = [];
  if (bars['4h'] > 0 && d.klines['4h'].length > 0) {
    klineBlocks.push(renderKlineTable('4h', d.klines['4h'], bars['4h']));
  }
  if (bars['15m'] > 0 && d.klines['15m'].length > 0) {
    klineBlocks.push(renderKlineTable('15m', d.klines['15m'], bars['15m']));
  }
  if (bars['1m'] > 0 && d.klines['1m'].length > 0) {
    klineBlocks.push(renderKlineTable('1m', d.klines['1m'], bars['1m']));
  }

  return [...header, ...klineBlocks].join('\n');
}

function renderVolatileSection(
  ctx: ManagedPromptContext,
  dossiers: readonly ManagedSymbolDossier[],
  bars: { '4h': number; '15m': number; '1m': number },
): string {
  const acc = ctx.account;
  const marginPct = acc.equity > 0 ? (acc.marginUsed / acc.equity) * 100 : 0;
  const costText =
    ctx.roundTripCostPercent !== undefined &&
    ctx.roundTripCostPercent !== null &&
    Number.isFinite(ctx.roundTripCostPercent)
      ? ` · 双边成本 ≈${ctx.roundTripCostPercent.toFixed(3)}%`
      : '';
  const idleText =
    ctx.idleCycles !== undefined && ctx.idleCycles >= 3 ? ` · 已连续观望 ${ctx.idleCycles} 轮` : '';

  const parts: string[] = [
    `# 轮次与账户快照（第 #${ctx.cycleNumber} 轮 · ${ctx.now.toISOString().slice(0, 16).replace('T', ' ')} UTC · 周期 ${ctx.cycleIntervalMinutes}m）`,
    `- 权益 ${fmtUsd(acc.equity)} · 可用 ${fmtUsd(acc.availableBalance)} · 已用保证金 ${fmtUsd(acc.marginUsed)} (${marginPct.toFixed(1)}%) · 浮盈 ${acc.unrealizedPnl >= 0 ? '+' : ''}${acc.unrealizedPnl.toFixed(2)}U · 持仓/挂单 ${acc.positionCount}/${ctx.config.riskControl.maxPositions}${costText}${idleText}`,
  ];

  if (ctx.btcBenchmarkLine) {
    parts.push(`- 市场基准：${ctx.btcBenchmarkLine}`);
  }

  if (ctx.radarLeaderboard.length > 0) {
    const board = ctx.radarLeaderboard
      .slice(0, 10)
      .map((c) => `${c.symbol}:${c.score}(${c.bias === 'long' ? '多' : c.bias === 'short' ? '空' : '中'})`)
      .join(' · ');
    parts.push(`- 全市场 AI500 雷达榜 Top${Math.min(10, ctx.radarLeaderboard.length)}：${board}`);
  }

  parts.push('', renderPositionsSection(ctx));

  if (dossiers.length > 0) {
    parts.push(
      '',
      `# 深度展开标的（共 ${dossiers.length} 个：持仓 + AI500 Top 精选）`,
      ...dossiers.map((d) => renderDossierBlock(d, bars)),
    );
  } else {
    parts.push('', '# 深度展开标的', '本轮无达标候选标的，请保持观望。');
  }

  return parts.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Public Entrypoint with Strict <= 30,000 Char Enforcement                   */
/* -------------------------------------------------------------------------- */

/**
 * 构建 `ai_managed` 2.0 完整提示词套件，通过逐级压缩保证 `userPrompt.length <= 30,000`。
 */
export function buildManagedPrompts(ctx: ManagedPromptContext): ManagedPromptBundle {
  const systemPrompt = buildManagedSystemPrompt(ctx);
  let stablePrompt = renderStableSection(ctx);

  const levels: Array<{
    maxNonHeld: number;
    bars: { '4h': number; '15m': number; '1m': number };
  }> = [
    { maxNonHeld: 5, bars: { '4h': MANAGED_KLINE_BARS, '15m': MANAGED_KLINE_BARS, '1m': MANAGED_KLINE_BARS } },
    { maxNonHeld: 4, bars: { '4h': 24, '15m': 24, '1m': 20 } },
    { maxNonHeld: 3, bars: { '4h': 20, '15m': 20, '1m': 15 } },
    { maxNonHeld: 3, bars: { '4h': 12, '15m': 12, '1m': 10 } },
    { maxNonHeld: 2, bars: { '4h': 6, '15m': 6, '1m': 0 } },
  ];

  let chosenVolatile = '';
  let chosenDossiers: ManagedSymbolDossier[] = [];
  let chosenBars = levels[0]!.bars;
  let chosenLevel = 0;

  for (let i = 0; i < levels.length; i += 1) {
    const lv = levels[i]!;
    const held = ctx.dossiers.filter((d) => d.isHeld);
    const nonHeld = ctx.dossiers.filter((d) => !d.isHeld).slice(0, lv.maxNonHeld);
    const selected = [...held, ...nonHeld];
    const volatile = renderVolatileSection(ctx, selected, lv.bars);
    const combinedLen = (stablePrompt.length > 0 ? stablePrompt.length + 2 : 0) + volatile.length;

    chosenVolatile = volatile;
    chosenDossiers = selected;
    chosenBars = lv.bars;
    chosenLevel = i;

    if (combinedLen <= MANAGED_PROMPT_CHAR_LIMIT) break;
  }

  // 极端兜底（例如同时持有 10 个标的且记忆极长）：裁减稳定段并截断，确保硬红线绝对不被突破
  let userPrompt =
    stablePrompt.length > 0 ? `${stablePrompt}\n\n${chosenVolatile}` : chosenVolatile;
  if (userPrompt.length > MANAGED_PROMPT_CHAR_LIMIT) {
    const stableCap = Math.max(0, Math.min(stablePrompt.length, 2000));
    if (stablePrompt.length > stableCap) {
      stablePrompt = `${stablePrompt.slice(0, stableCap)}…`;
    }
    const maxVolLen = MANAGED_PROMPT_CHAR_LIMIT - (stablePrompt.length > 0 ? stablePrompt.length + 2 : 0);
    if (chosenVolatile.length > maxVolLen) {
      chosenVolatile = `${chosenVolatile.slice(0, Math.max(0, maxVolLen - 24))}\n…(已按3万字硬上限裁剪)`;
    }
    userPrompt = stablePrompt.length > 0 ? `${stablePrompt}\n\n${chosenVolatile}` : chosenVolatile;
  }

  return {
    systemPrompt,
    stablePrompt,
    volatilePrompt: chosenVolatile,
    userPrompt,
    stats: {
      userChars: userPrompt.length,
      systemChars: systemPrompt.length,
      expandedSymbols: chosenDossiers.length,
      barsPerTf: chosenBars,
      compactionLevel: chosenLevel,
    },
  };
}
