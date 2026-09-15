import {
  closeReasonLabel,
  type MarketSnapshot,
  type OiRankRow,
  type PositionView,
  type StrategyConfig,
  type TimeframeIndicators,
  type TradeRecord,
} from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  Prompt context                                                             */
/* -------------------------------------------------------------------------- */

export interface PromptAccountInfo {
  equity: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginUsed: number;
  positionCount: number;
}

export interface PromptPosition {
  position: PositionView;
  /** Indicator snapshot for the symbol, used to give the model live context. */
  snapshot: MarketSnapshot | null;
  holdingMinutes: number;
}

export interface PromptContext {
  traderName: string;
  cycleNumber: number;
  now: Date;
  config: StrategyConfig;
  account: PromptAccountInfo;
  positions: PromptPosition[];
  candidates: MarketSnapshot[];
  recentTrades: TradeRecord[];
  oiRanking: OiRankRow[];
}

/* -------------------------------------------------------------------------- */
/*  Number formatting                                                          */
/* -------------------------------------------------------------------------- */

/** Adapts decimal places to magnitude so prompts stay readable and compact. */
function fmt(value: number | null | undefined, decimals?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  if (decimals !== undefined) return value.toFixed(decimals);
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(4);
  if (abs >= 0.01) return value.toFixed(6);
  return value.toExponential(4);
}

function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${value >= 0 ? '' : '-'}$${Math.abs(value).toFixed(2)}`;
}

function fmtSigned(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}`;
}

function fmtPercent(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

/** A compact JSON-ish array render, dropping `null` padding and trimming length. */
function series(values: Array<number | null>, decimals: number, maxPoints = 30): string {
  const usable = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (usable.length === 0) return '[]';
  const tail = usable.slice(-maxPoints);
  return `[${tail.map((v) => v.toFixed(decimals)).join(', ')}]`;
}

function humanDuration(minutes: number): string {
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours < 24) return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时`;
}

/* -------------------------------------------------------------------------- */
/*  Trading-mode guidance                                                      */
/* -------------------------------------------------------------------------- */

const MODE_GUIDANCE: Record<StrategyConfig['tradingMode'], string> = {
  aggressive: [
    '模式：进取',
    '你偏好动能与突破延续。较低的胜率是可以接受的，因为盈利单会被允许充分奔跑。',
    '只要失效位没有被击穿，你可以容忍正常回撤。',
    '你可以容忍更大的单笔敞口，但绝不能超过下面的硬性上限。',
  ].join('\n'),
  conservative: [
    '模式：稳健',
    '在投入资金之前，你要求多个相互独立的确认。错过一波行情不花一分钱；一笔糟糕的入场不是。',
    '保住本金压倒一切。宁可交易更少、质量更高。',
    '当信号互相冲突时，正确的动作是 `wait`。',
  ].join('\n'),
  scalping: [
    '模式：短线',
    '你交易短促的动能爆发，持仓以分钟计而非小时计。',
    '目标位与止损都紧贴结构。若某个机会在一两根K线内没有触发，它就已经失效——放弃它。',
    '快速止盈是正确的；让一笔小额盈利单变成亏损单是最糟糕的结果。',
  ].join('\n'),
};

/* -------------------------------------------------------------------------- */
/*  System prompt                                                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_ROLE =
  '你是一名管理真实资金账户的专业加密货币合约交易员，在币安 USDT 本位永续合约上交易。你会仔细推演市场结构，并且对资金保持保守。';

const DEFAULT_FREQUENCY =
  '你按固定周期被调用。连续多个周期不采取任何动作是完全正常且正确的。不要为了显得有产出而凭空制造交易。';

const DEFAULT_ENTRY_STANDARDS =
  '只有当证据足够清楚、清楚到你愿意向一位持怀疑态度的风控经理辩护时，才开仓。每一笔入场都必须有明确的失效位。';

const DEFAULT_DECISION_PROCESS = [
  '1. 先确定所提供的最高时间周期上的主导趋势。',
  '2. 定位关键结构：最近的波段高低点、价格正在反应的位置、以及流动性聚集处。',
  '3. 检查动能（MACD、RSI），看它是确认价格还是与价格背离。',
  '4. 检查衍生品信息：持仓量在扩张还是在平仓？资金费是否已经拥挤？',
  '5. 对已有持仓，判断原始逻辑是否依然成立。若不成立，就平掉它。',
  '6. 对新的入场，先定止损，再定目标，最后确定仓位大小，使止损被扫时的亏损是可以接受的。',
  '7. 如实给出置信度。低于阈值的置信度意味着你根本不应该交易。',
].join('\n');

/**
 * Assemble the system prompt.
 *
 * Structure mirrors the eight documented sections so that the editable parts
 * (role, frequency, standards, process) stay clearly separated from the parts
 * the runtime owns and the model must never contradict (hard limits and the
 * response format).
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const { config } = ctx;
  const risk = config.riskControl;
  const sections: string[] = [];

  /* 1 — Role ------------------------------------------------------------- */
  sections.push(
    `# 角色\n${config.promptSections.roleDefinition.trim() || DEFAULT_ROLE}`,
  );

  /* 2 — Mode ------------------------------------------------------------- */
  sections.push(`# ${MODE_GUIDANCE[config.tradingMode]}`);

  /* 3 — Hard constraints ------------------------------------------------- */
  sections.push(
    [
      '# 硬性约束（由代码强制执行，你无法覆盖）',
      '运行时会对你的每一张订单做独立校验与钳制。若你越界，订单会被拒绝或被静默调整为您所限范围内，所以请始终待在边界内。',
      '',
      `- 最大同时持仓数：${risk.maxPositions}`,
      `- 最大杠杆（BTC/ETH）：${risk.btcEthMaxLeverage}x`,
      `- 最大杠杆（其他所有标的）：${risk.altcoinMaxLeverage}x`,
      `- 单仓名义价值上限（BTC/ETH）：账户权益的 ${risk.btcEthMaxPositionValueRatio} 倍`,
      `- 单仓名义价值上限（其他所有标的）：账户权益的 ${risk.altcoinMaxPositionValueRatio} 倍`,
      `- 单笔最小名义价值：${risk.minPositionSize} USDT`,
      `- 最大保证金占用：权益的 ${risk.maxMarginUsage}%`,
      `- 新开仓的最低盈亏比：1:${risk.minRiskRewardRatio}`,
      `- 开仓所需的最低置信度：${risk.minConfidence}/100`,
      risk.requireStopLoss
        ? '- 每一笔开仓都必须带止损。没有止损的开仓会被拒绝。'
        : '- 强烈建议每一笔开仓都带止损。',
      risk.requireTakeProfit
        ? '- 每一笔开仓都必须带止盈。没有止盈的开仓会被拒绝。'
        : '- 建议每一笔开仓都带止盈。',
      '- 同一时间每个标的至多一个仓位。',
      `- 开仓节流：每个周期最多 ${config.throttle.maxEntriesPerCycle} 个新仓位，每小时最多 ${config.throttle.maxEntriesPerHour} 个。`,
      config.throttle.minHoldMinutes > 0
        ? `- 新开的仓位在 ${config.throttle.minHoldMinutes} 分钟内不能被平掉。`
        : '',
      config.throttle.reentryCooldownMinutes > 0
        ? `- 平掉某个标的之后，${config.throttle.reentryCooldownMinutes} 分钟内不能再次入场该标的。`
        : '',
      config.drawdownGuard.enabled
        ? `- 回撤守卫：当某个仓位的浮盈超过 ${config.drawdownGuard.activationPercent}% 后，若回吐达到峰值的 ${(config.drawdownGuard.givebackRatio * 100).toFixed(0)}%，运行时会自动平掉它。`
        : '',
      config.circuitBreaker.maxDailyLossPercent > 0
        ? `- 单日亏损熔断：若当日已实现亏损超过权益的 ${config.circuitBreaker.maxDailyLossPercent}%，所有新开仓会停止直到次日。`
        : '',
      config.circuitBreaker.maxTotalDrawdownPercent > 0
        ? `- 总回撤熔断：若权益较历史最高水位回撤达到 ${config.circuitBreaker.maxTotalDrawdownPercent}%，所有新开仓会停止。`
        : '',
      '',
      '仓位大小用 `position_size_usd` 表示，含义是这笔仓位的**名义价值**（数量 × 价格），不是保证金。实际占用的保证金 = 名义价值 / 杠杆。',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  /* 4 — Frequency -------------------------------------------------------- */
  sections.push(
    `# 交易频率\n${config.promptSections.tradingFrequency.trim() || DEFAULT_FREQUENCY}`,
  );

  /* 5 — Entry standards -------------------------------------------------- */
  sections.push(
    `# 入场标准\n${config.promptSections.entryStandards.trim() || DEFAULT_ENTRY_STANDARDS}`,
  );

  /* 6 — Decision process ------------------------------------------------- */
  sections.push(
    `# 决策流程\n${config.promptSections.decisionProcess.trim() || DEFAULT_DECISION_PROCESS}`,
  );

  /* 7 — Output format (fixed) ------------------------------------------- */
  sections.push(
    [
      '# 输出格式要求',
      '只输出两个 XML 块，不要有任何其他内容。',
      '',
      '第一个是你的思考过程。一步步推演市场，以及每一个持仓和候选标的。这是你的思维链，会被记录下来供账户所有者审计。',
      '',
      '<reasoning>',
      '你的逐步分析。',
      '</reasoning>',
      '',
      '第二个是你的决策，放在 `<decision>` 块内的 JSON 数组里。如果你不采取任何动作，就返回空数组：`[]`。',
      '',
      '<decision>',
      '```json',
      '[',
      '  {',
      '    "symbol": "BTCUSDT",',
      '    "action": "open_long",',
      `    "leverage": ${risk.defaultLeverage},`,
      '    "position_size_usd": 150.00,',
      '    "stop_loss": 64200.00,',
      '    "take_profit": 68900.00,',
      '    "confidence": 82,',
      '    "risk_usd": 12.50,',
      '    "reasoning": "用一两句话说明这笔具体交易的理由。"',
      '  }',
      ']',
      '```',
      '</decision>',
      '',
      '字段规则：',
      '- `symbol`：必须与候选区中列出的完全一致，例如 `BTCUSDT`。',
      '- `action`：取值为 `open_long`、`open_short`、`close_long`、`close_short`、`hold`、`wait` 之一。',
      '  - `close_long` / `close_short` 会平掉该方向上的整个现有仓位。平仓时不要附带 `leverage`、`position_size_usd`、`stop_loss` 或 `take_profit`，它们会被忽略。',
      '  - `hold` 表示"维持现有仓位不变"。`wait` 表示"这里没有仓位，不做任何事"。',
      '- `leverage`：整数，不得超过该标的的硬性上限。',
      '- `position_size_usd`：以 USDT 计的名义价值，介于最小名义价值与该标的上限之间。',
      '- `stop_loss` / `take_profit`：绝对价格，不是百分比、也不是距离。',
      '- `confidence`：0-100 的整数。请如实填写——低于阈值的值不会被交易。',
      '- `risk_usd`：若止损被触发，损失的 USDT 金额。',
      '',
      '决策块内只能输出合法 JSON：双引号、无注释、无尾随逗号。你可以在 `reasoning` 字段里写简短理由，但 JSON 必须能被解析。',
    ].join('\n'),
  );

  /* 8 — Custom prompt ---------------------------------------------------- */
  const custom = config.customPrompt.trim();
  if (custom) {
    sections.push(`# 账户所有者追加的指示\n${custom}`);
  }

  return sections.join('\n\n');
}

/* -------------------------------------------------------------------------- */
/*  User prompt                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the per-cycle user prompt: the complete, factual state of the world
 * the model needs to decide.
 */
export function buildUserPrompt(ctx: PromptContext): string {
  const parts: string[] = [];

  /* 1 — System status ---------------------------------------------------- */
  parts.push(
    [
      '# 系统状态',
      `时间：${ctx.now.toISOString()}（UTC）`,
      `机器人：${ctx.traderName}`,
      `决策轮次：#${ctx.cycleNumber}`,
      `交易模式：${ctx.config.tradingMode}`,
    ].join('\n'),
  );

  /* 2 — BTC market overview --------------------------------------------- */
  const btc = ctx.candidates.find((c) => c.symbol === 'BTCUSDT');
  if (btc) {
    const rsiKey = Object.keys(btc.primary.rsi)[0];
    const emaKey = Object.keys(btc.primary.ema)[0];
    const last = <T,>(arr: Array<T | null>): T | null =>
      [...arr].reverse().find((v) => v !== null) ?? null;

    parts.push(
      [
        '# BTC 市场概览',
        `价格：${fmt(btc.price)} | 24h 涨跌：${fmtPercent(btc.priceChangePercent24h)}`,
        emaKey ? `EMA${emaKey}：${fmt(last(btc.primary.ema[emaKey] ?? []))}` : '',
        btc.primary.macd ? `MACD 柱：${fmt(last(btc.primary.macd.histogram))}` : '',
        rsiKey ? `RSI${rsiKey}：${fmt(last(btc.primary.rsi[rsiKey] ?? []), 1)}` : '',
        `持仓量（USDT）：${fmt(btc.derivatives.openInterestUsd)} | 资金费：${fmtPercent(
          btc.derivatives.fundingRate !== null ? btc.derivatives.fundingRate * 100 : null,
          4,
        )}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  /* 3 — Account ---------------------------------------------------------- */
  const a = ctx.account;
  const balancePct = a.equity > 0 ? (a.availableBalance / a.equity) * 100 : 0;
  const pnlPct = a.equity > 0 ? (a.unrealizedPnl / a.equity) * 100 : 0;
  const marginPct = a.equity > 0 ? (a.marginUsed / a.equity) * 100 : 0;
  parts.push(
    [
      '# 账户',
      `权益 ${fmt(a.equity)} | 可用 ${fmt(a.availableBalance)}（${balancePct.toFixed(1)}%）| 未实现盈亏 ${fmtSigned(
        a.unrealizedPnl,
      )}（${fmtPercent(pnlPct)}）| 保证金占用 ${marginPct.toFixed(1)}% | 持仓数 ${a.positionCount}`,
      `仓位换算参考——权益的 1% 是 ${fmt(a.equity * 0.01)} USDT。`,
    ].join('\n'),
  );

  /* 4 — Recent closed trades -------------------------------------------- */
  if (ctx.recentTrades.length > 0) {
    const lines = ctx.recentTrades.slice(0, 10).map((t, index) => {
      return `${index + 1}. ${t.symbol} ${t.side === 'long' ? '多头' : '空头'} | 入场 ${fmt(t.entryPrice)} → 出场 ${fmt(
        t.exitPrice,
      )} | ${t.leverage}x | 盈亏 ${fmtSigned(t.pnl)}（${fmtPercent(t.pnlPercent)}）| 持仓 ${humanDuration(
        t.holdMinutes,
      )} | 平仓原因：${closeReasonLabel(t.closeReason)}`;
    });
    const wins = ctx.recentTrades.filter((t) => t.pnl > 0).length;
    parts.push(
      `# 最近已平仓交易（最新的在前）\n${lines.join('\n')}\n\n近期战绩：${ctx.recentTrades.length} 笔中盈利 ${wins} 笔。`,
    );
  }

  /* 5 — Open positions --------------------------------------------------- */
  if (ctx.positions.length === 0) {
    parts.push('# 当前持仓\n当前没有持仓。');
  } else {
    const lines = ctx.positions.map((p, index) => {
      const pos = p.position;
      const snap = p.snapshot;
      const rows = [
        `${index + 1}. ${pos.symbol} ${pos.side === 'long' ? '多头' : '空头'} | 入场 ${fmt(pos.entryPrice)} 当前 ${fmt(
          pos.markPrice,
        )}`,
        `   数量 ${fmt(pos.quantity, 6)} | 名义价值 ${fmtUsd(pos.notional)}`,
        `   盈亏 ${fmtPercent(pos.unrealizedPnlPercent)} | 金额 ${fmtUsd(pos.unrealizedPnl)}`,
        `   最高浮盈 ${fmtPercent(pos.peakPnlPercent)} | 杠杆 ${pos.leverage}x`,
        `   保证金 ${fmtUsd(pos.marginUsed)} | 强平价 ${pos.liquidationPrice ? fmt(pos.liquidationPrice) : '无'}`,
        pos.stopLoss ? `   止损 ${fmt(pos.stopLoss)}` : '   止损：未设置',
        pos.takeProfit ? `   止盈 ${fmt(pos.takeProfit)}` : '   止盈：未设置',
        `   已持仓 ${humanDuration(p.holdingMinutes)}`,
      ];
      if (snap) {
        rows.push(`   行情：${summariseSnapshot(snap)}`);
      }
      return rows.join('\n');
    });
    parts.push(`# 当前持仓\n${lines.join('\n\n')}`);
  }

  /* 6 — Candidate coins -------------------------------------------------- */
  if (ctx.candidates.length === 0) {
    parts.push(
      '# 候选标的\n本周期没有选出任何候选标的。你只能管理已有持仓；若无事可做，返回 `[]`。',
    );
  } else {
    const blocks = ctx.candidates.map((snap, index) => formatMarketData(snap, index, ctx.config));
    parts.push(
      `# 候选标的（${ctx.candidates.length} 个）\n每个区块给出一个标的、选中它的来源，以及每个已配置时间周期的指标序列，按由旧到新排列。每个序列的最后一个值就是最新值。\n\n${blocks.join(
        '\n\n',
      )}`,
    );
  }

  /* 7 — OI ranking ------------------------------------------------------- */
  if (ctx.config.indicators.enableOiRanking && ctx.oiRanking.length > 0) {
    const rows = ctx.oiRanking
      .slice(0, 15)
      .map(
        (r, i) =>
          `${i + 1}. ${r.symbol} | 持仓量 ${fmt(r.openInterestUsd)} | 持仓量变化 ${fmtPercent(
            r.changePercent,
          )} | 价格 ${fmtPercent(r.priceChangePercent)}`,
      );
    parts.push(`# 持仓量排行\n${rows.join('\n')}`);
  }

  /* Closing instruction -------------------------------------------------- */
  parts.push(
    [
      '# 你的任务',
      '分析以上内容，先输出 `<reasoning>` 块，再输出包含 JSON 数组的 `<decision>` 块。',
      '请记住：',
      '- 优先管理已有持仓。如果某个持仓的逻辑已经被破坏，就平掉它。',
      '- 只有当某个机会明确满足你的入场标准和所有硬性约束时，才开新仓。',
      '- 返回 `[]`，或只包含 `hold`/`wait` 的列表，都是完全合格的答案。',
    ].join('\n'),
  );

  return parts.join('\n\n');
}

/* -------------------------------------------------------------------------- */
/*  Enum labels                                                                */
/* -------------------------------------------------------------------------- */

// The label map lives in `@aq/shared` so the console, the server logs and this
// prompt all render a close reason identically.


/* -------------------------------------------------------------------------- */
/*  Market data rendering                                                      */
/* -------------------------------------------------------------------------- */

/** One-line indicator summary, used inside the position list. */
function summariseSnapshot(snap: MarketSnapshot): string {
  const last = <T,>(arr: Array<T | null>): T | null =>
    [...arr].reverse().find((v) => v !== null) ?? null;

  const pieces: string[] = [`price=${fmt(snap.price)}`];
  for (const [period, series] of Object.entries(snap.primary.ema)) {
    pieces.push(`ema${period}=${fmt(last(series))}`);
  }
  if (snap.primary.macd) {
    pieces.push(`macd=${fmt(last(snap.primary.macd.line))}`);
    pieces.push(`macd_hist=${fmt(last(snap.primary.macd.histogram))}`);
  }
  for (const [period, series] of Object.entries(snap.primary.rsi)) {
    pieces.push(`rsi${period}=${fmt(last(series), 1)}`);
  }
  for (const [period, series] of Object.entries(snap.primary.atr)) {
    pieces.push(`atr${period}=${fmt(last(series))}`);
  }
  if (snap.derivatives.openInterest !== null) {
    pieces.push(`oi=${fmt(snap.derivatives.openInterest, 0)}`);
  }
  if (snap.derivatives.fundingRate !== null) {
    pieces.push(`funding=${(snap.derivatives.fundingRate * 100).toFixed(4)}%`);
  }
  return pieces.join(', ');
}

/**
 * How many recent points of each series are rendered into the prompt.
 *
 * The indicator *calculations* run over the full candle set so that warm-up is
 * satisfied, but past ~30 points the model gains nothing and the prompt grows
 * linearly with the candidate count.
 */
const MAX_RENDER_POINTS = 30;

/* -------------------------------------------------------------------------- */
/*  Prompt budget                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Token estimate for this kind of content.
 *
 * Measured against a real call rather than assumed: 207,328 characters produced
 * **128,073** tokens — about 1.62 chars/token, not the 4 chars/token rule of
 * thumb for English prose. Two reasons: the prompt is dense with long digit
 * strings (`0.08174000`) which tokenize badly, and it contains CJK prose. Using
 * the English ratio understated the true size by more than 2×, which is exactly
 * how a 128k-token request slipped past a check that thought it was 60k.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.7);
}

/**
 * Ceiling on the assembled user prompt.
 *
 * 60k tokens. The reasoning:
 *
 *  - Every supported provider has a context window of at least 128k, so this
 *    leaves more than half for the model to think and answer in.
 *  - The failure this constant exists to prevent was a prompt at **128k tokens**:
 *    the model consumed its entire output budget reasoning about the input and
 *    returned nothing. 60k is less than half of that.
 *  - It is a budget, not a target. A light single-timeframe strategy still gets
 *    a large universe; only heavy configurations are constrained, and they are
 *    exactly the ones that were overflowing.
 */
export const PROMPT_TOKEN_BUDGET = 60_000;

/**
 * Average rendered size of one number, including its separator.
 *
 * Calibrated against a real prompt rather than guessed: a scalping config with
 * 3 timeframes × 9 series × 30 points produced 120,842 characters for 14
 * candidates — about 8,770 characters each. The first estimate used 8 and came
 * out 24% low, which is how a prompt predicted at 58k tokens actually measured
 * 72k and still blew the budget it was supposed to respect.
 *
 * Prices like `0.08174000` plus a `, ` separator are the reason it is not 8.
 */
const CHARS_PER_NUMBER = 10;
/** Per-timeframe label overhead ("=== 5M 周期（由旧到新）===\n价格: [...]"). */
const CHARS_PER_TIMEFRAME_LABEL = 90;
/** Per-candidate headline, derivatives and quant lines. */
const CHARS_PER_CANDIDATE_OVERHEAD = 400;
/**
 * Everything in the prompt that does not scale with the candidate count: the
 * system prompt, the status/account/BTC-overview sections, and the closing
 * instructions. Reserved up front so the budget cannot be spent on candidates
 * and then overflowed by the scaffolding.
 */
const FIXED_PROMPT_TOKENS = 3_000;

/**
 * How many characters one candidate contributes, derived from what will
 * actually be rendered rather than from a guess.
 *
 * The series count is a function of which indicators are enabled, which is why
 * this has to be computed per strategy: a scalping config with three timeframes
 * and every indicator on costs several times what a two-timeframe config does.
 */
export function estimateCandidateChars(config: StrategyConfig): number {
  const indicators = config.indicators;
  const points = Math.min(config.indicators.kline.primaryCount, MAX_RENDER_POINTS);
  const timeframes = Math.max(1, indicators.kline.selectedTimeframes.length);

  let seriesPerTimeframe = 1; // prices
  if (indicators.enableVolume) seriesPerTimeframe += 1;
  seriesPerTimeframe += indicators.enableEma ? indicators.emaPeriods.length : 0;
  if (indicators.enableMacd) seriesPerTimeframe += 3; // line, signal, histogram
  seriesPerTimeframe += indicators.enableRsi ? indicators.rsiPeriods.length : 0;
  seriesPerTimeframe += indicators.enableAtr ? indicators.atrPeriods.length : 0;

  const perTimeframe = seriesPerTimeframe * points * CHARS_PER_NUMBER + CHARS_PER_TIMEFRAME_LABEL;
  return timeframes * perTimeframe + CHARS_PER_CANDIDATE_OVERHEAD;
}

/**
 * Largest candidate universe whose prompt still fits the budget.
 *
 * The fixed prompt overhead is subtracted first: the system prompt and the
 * status/account sections are not free, and a budget that ignores them is a
 * budget that gets overrun.
 *
 * Returns a number, never zero: a strategy is always allowed to look at at least
 * one symbol, because silently selecting none would look like "no opportunities"
 * rather than "your configuration is too heavy".
 */
export function candidateBudget(
  config: StrategyConfig,
  budgetTokens = PROMPT_TOKEN_BUDGET,
): number {
  const perCandidate = estimateCandidateChars(config);
  if (perCandidate <= 0) return 40;
  // Budget is in tokens; the estimator is in characters.
  const availableChars = Math.max(0, (budgetTokens - FIXED_PROMPT_TOKENS) * 1.7);
  return Math.max(1, Math.floor(availableChars / perCandidate));
}

/**
 * Render one candidate symbol:
 *
 * ```
 * ### 1. ETHUSDT (coinpool+oi_top dual signal)
 *
 * current_price = 3500.00, current_ema20 = 3450.00, ...
 *
 * === 5M TIMEFRAME (oldest → latest) ===
 * Prices: [...]
 * Volumes: [...]
 * ```
 */
export function formatMarketData(snap: MarketSnapshot, index: number, config: StrategyConfig): string {
  const indicatorCfg = config.indicators;
  // Multi-source nominations are a genuine signal for the model: a symbol that
  // both the liquidity screen and the open-interest screen picked is stronger
  // than one that only appeared in a single list.
  const tag =
    snap.sources.length > 1
      ? `${snap.symbol}（${snap.sources.join(' + ')} — 多来源共振）`
      : snap.sources.length === 1
        ? `${snap.symbol}（${snap.sources[0]}）`
        : snap.symbol;

  const lines: string[] = [];
  lines.push(`### ${index + 1}. ${tag}`);

  // The indicator keys stay in snake_case English on purpose: they mirror the
  // field names the model must emit (`stop_loss`, `position_size_usd`, ...), so
  // keeping the data vocabulary consistent anchors the output contract.
  const headline: string[] = [`current_price = ${fmt(snap.price)}`];
  for (const [period, series] of Object.entries(snap.primary.ema)) {
    headline.push(`current_ema${period} = ${fmt(lastValue(series))}`);
  }
  if (snap.primary.macd) {
    headline.push(`current_macd = ${fmt(lastValue(snap.primary.macd.line))}`);
    headline.push(`current_macd_signal = ${fmt(lastValue(snap.primary.macd.signalLine))}`);
    headline.push(`current_macd_hist = ${fmt(lastValue(snap.primary.macd.histogram))}`);
  }
  for (const [period, series] of Object.entries(snap.primary.rsi)) {
    headline.push(`current_rsi${period} = ${fmt(lastValue(series), 1)}`);
  }
  for (const [period, series] of Object.entries(snap.primary.atr)) {
    headline.push(`current_atr${period} = ${fmt(lastValue(series))}`);
  }
  headline.push(`24h_change = ${fmtPercent(snap.priceChangePercent24h)}`);
  headline.push(`24h_quote_volume = ${fmt(snap.quoteVolume24h, 0)}`);
  lines.push(headline.join(', '));

  /* Derivatives context --------------------------------------------------- */
  const deriv: string[] = [];
  if (indicatorCfg.enableOi && snap.derivatives.openInterest !== null) {
    deriv.push(
      `持仓量：最新 ${fmt(snap.derivatives.openInterest, 2)}${
        snap.derivatives.openInterestAvg !== null ? ` 均值 ${fmt(snap.derivatives.openInterestAvg, 2)}` : ''
      }`,
    );
    const changeLine = renderChangeMap(snap.derivatives.openInterestChangePercent);
    if (changeLine) deriv.push(`持仓量变化：${changeLine}`);
  }
  if (indicatorCfg.enableFundingRate && snap.derivatives.fundingRate !== null) {
    deriv.push(`资金费率：${(snap.derivatives.fundingRate * 100).toFixed(4)}%`);
  }
  if (deriv.length > 0) lines.push('', deriv.join('\n'));

  /* Quant / order-flow context -------------------------------------------- */
  if (indicatorCfg.enableQuantData && snap.quant) {
    const priceLine = renderChangeMap(snap.quant.priceChangePercent);
    const rows = [
      `主动买卖流：1 小时买入占比 ${(snap.quant.takerBuyRatio1h * 100).toFixed(1)}%（净额 ${fmt(
        snap.quant.netflow1h,
        0,
      )}），4 小时买入占比 ${(snap.quant.takerBuyRatio4h * 100).toFixed(1)}%（净额 ${fmt(snap.quant.netflow4h, 0)}）`,
    ];
    if (priceLine) rows.push(`价格变化：${priceLine}`);
    lines.push('', rows.join('\n'));
  }

  /* Per-timeframe series -------------------------------------------------- */
  for (const tf of snap.timeframes) {
    lines.push('', renderTimeframe(tf, indicatorCfg));
  }

  return lines.join('\n');
}

function lastValue(series: Array<number | null> | undefined): number | null {
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== null && value !== undefined && Number.isFinite(value)) return value;
  }
  return null;
}

function renderTimeframe(tf: TimeframeIndicators, config: StrategyConfig['indicators']): string {
  const label = tf.timeframe.toUpperCase();
  const points = Math.min(config.kline.primaryCount, MAX_RENDER_POINTS);
  const lines: string[] = [`=== ${label} 周期（由旧到新）===`];

  lines.push(`价格: ${series(tf.closes, priceDecimalsFor(tf), points)}`);
  if (config.enableVolume) {
    lines.push(`成交量: ${series(tf.volumes, 2, points)}`);
  }
  // Indicator names stay in their standard English abbreviations — EMA, MACD,
  // RSI and ATR are used untranslated by Chinese traders and by the models.
  for (const [period, values] of Object.entries(tf.ema)) {
    lines.push(`EMA${period}: ${series(values, priceDecimalsFor(tf), points)}`);
  }
  if (tf.macd) {
    lines.push(`MACD: ${series(tf.macd.line, priceDecimalsFor(tf), points)}`);
    lines.push(`MACD_SIGNAL: ${series(tf.macd.signalLine, priceDecimalsFor(tf), points)}`);
    lines.push(`MACD_HIST: ${series(tf.macd.histogram, priceDecimalsFor(tf), points)}`);
  }
  for (const [period, values] of Object.entries(tf.rsi)) {
    lines.push(`RSI${period}: ${series(values, 1, points)}`);
  }
  for (const [period, values] of Object.entries(tf.atr)) {
    lines.push(`ATR${period}: ${series(values, priceDecimalsFor(tf), points)}`);
  }

  return lines.join('\n');
}

/**
 * Render a `{ window: value }` map, dropping windows that could not be computed.
 *
 * Printing `4h N/A` for every symbol is pure noise and actively misleads the
 * model into thinking a value exists but is unavailable, rather than that the
 * window is simply outside the configured lookback.
 */
function renderChangeMap(changes: Record<string, number | undefined>): string {
  const usable = Object.entries(changes).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  );
  if (usable.length === 0) return '';
  return usable.map(([window, pct]) => `${window} ${fmtPercent(pct)}`).join(' | ');
}

/** Candle series get 2 decimals below $1000, and none above it. */
function priceDecimalsFor(tf: TimeframeIndicators): number {
  const last = lastValue(tf.closes);
  if (last === null) return 2;
  if (last >= 1000) return 2;
  if (last >= 1) return 4;
  return 6;
}

export { fmt as formatNumber, fmtPercent as formatPercent, humanDuration };
