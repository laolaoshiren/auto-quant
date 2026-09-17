import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Coin universe                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where the candidate-coin universe comes from.
 *
 * - `static`  : the user's hand-written symbol list
 * - `coinpool`: dynamically ranked universe (liquidity / momentum screen)
 * - `oi_top`  : symbols with the fastest open-interest growth
 * - `mixed`   : union of the above, de-duplicated, multi-source tags preserved
 */
export const CoinSourceTypeSchema = z.enum(['static', 'coinpool', 'oi_top', 'mixed']);
export type CoinSourceType = z.infer<typeof CoinSourceTypeSchema>;

/** How the dynamic `coinpool` universe is ranked. */
export const CoinPoolRankSchema = z.enum([
  'quote_volume', // 24h notional turnover — the most liquid majors
  'gainers', // 24h price change, descending
  'losers', // 24h price change, ascending
  'volatility', // 24h (high-low)/low — best for scalping regimes
  'funding_extreme', // largest |funding rate| — crowded positioning
]);
export type CoinPoolRank = z.infer<typeof CoinPoolRankSchema>;

export const CoinSourceConfigSchema = z.object({
  sourceType: CoinSourceTypeSchema.default('static'),
  /** Explicit symbols, e.g. `["BTCUSDT","ETHUSDT"]`. Normalised to upper-case. */
  staticCoins: z.array(z.string()).default([]),

  /** `mixed` mode toggles. */
  useCoinPool: z.boolean().default(false),
  useOITop: z.boolean().default(false),

  /** How many symbols the dynamic universe contributes. */
  coinPoolLimit: z.number().int().min(1).max(200).default(20),
  coinPoolRank: CoinPoolRankSchema.default('quote_volume'),

  /** Drop stablecoin pairs and anything below this 24h turnover (USDT). */
  minQuoteVolume24h: z.number().min(0).default(50_000_000),
  /** Only consider symbols whose open interest exceeds this (USDT). */
  minOpenInterestUsd: z.number().min(0).default(5_000_000),

  /** How many symbols the OI-growth source contributes. */
  oiTopLimit: z.number().int().min(1).max(100).default(10),
  /** OI growth is measured over this window (hours). */
  oiTopWindowHours: z.number().int().min(1).max(24).default(4),
});

/* -------------------------------------------------------------------------- */
/*  Indicators                                                                 */
/* -------------------------------------------------------------------------- */

export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'] as const;
export const TimeframeSchema = z.enum(TIMEFRAMES);
export type Timeframe = z.infer<typeof TimeframeSchema>;

export const KlineConfigSchema = z.object({
  /** Timeframe whose indicators are shown inline next to the price. */
  primaryTimeframe: TimeframeSchema.default('5m'),
  /** Every timeframe rendered into the prompt, oldest → newest. */
  selectedTimeframes: z.array(TimeframeSchema).min(1).default(['5m', '15m', '1h', '4h']),
  /**
   * How many candles are fetched and fed to the indicator calculations.
   *
   * Must comfortably exceed the longest indicator warm-up. MACD(26,9) needs 26
   * candles for the slow EMA plus 9 more for its signal line — 35 before the
   * histogram produces a single value — and EMA50 needs 50. A value of 30, the
   * intuitive default, silently yields an empty MACD.
   */
  primaryCount: z.number().int().min(10).max(1000).default(60),
});

export const IndicatorConfigSchema = z.object({
  kline: KlineConfigSchema.default({}),

  enableEma: z.boolean().default(true),
  emaPeriods: z.array(z.number().int().min(2).max(400)).default([20, 50]),

  enableMacd: z.boolean().default(true),
  macdFast: z.number().int().min(2).default(12),
  macdSlow: z.number().int().min(3).default(26),
  macdSignal: z.number().int().min(2).default(9),

  enableRsi: z.boolean().default(true),
  rsiPeriods: z.array(z.number().int().min(2).max(200)).default([7, 14]),

  enableAtr: z.boolean().default(true),
  atrPeriods: z.array(z.number().int().min(2).max(200)).default([14]),

  enableVolume: z.boolean().default(true),
  enableOi: z.boolean().default(true),
  enableFundingRate: z.boolean().default(true),
  /** Taker buy/sell flow, used as a free substitute for paid net-flow feeds. */
  enableQuantData: z.boolean().default(false),
  /** Cross-sectional OI ranking table appended to the prompt. */
  enableOiRanking: z.boolean().default(false),
});
export type IndicatorConfig = z.infer<typeof IndicatorConfigSchema>;

/* -------------------------------------------------------------------------- */
/*  Risk control — enforced in code, outside the model's reach                  */
/* -------------------------------------------------------------------------- */

export const RiskControlConfigSchema = z.object({
  /** Hard ceiling on concurrently open positions. */
  maxPositions: z.number().int().min(1).max(20).default(3),

  /** Leverage is clamped at order-sizing time regardless of what the model asks. */
  btcEthMaxLeverage: z.number().int().min(1).max(125).default(5),
  altcoinMaxLeverage: z.number().int().min(1).max(125).default(5),
  /** Leverage applied when the model omits one. */
  defaultLeverage: z.number().int().min(1).max(125).default(3),

  /** Notional cap expressed as a multiple of account equity. */
  btcEthMaxPositionValueRatio: z.number().min(0.01).max(50).default(5),
  altcoinMaxPositionValueRatio: z.number().min(0.01).max(50).default(1),

  /** Percentage of equity allowed to sit in margin. */
  maxMarginUsage: z.number().min(1).max(100).default(90),
  /** Orders below this notional are rejected rather than rounded up. */
  minPositionSize: z.number().min(1).default(12),

  /** Reward:risk floor, e.g. 3 means TP distance must be >= 3x SL distance. */
  minRiskRewardRatio: z.number().min(0).max(50).default(3),
  /** Model confidence floor (0-100). */
  minConfidence: z.number().int().min(0).max(100).default(75),

  /** Force an exchange-side stop loss on every entry. Strongly recommended. */
  requireStopLoss: z.boolean().default(true),
  /** Force an exchange-side take profit on every entry. */
  requireTakeProfit: z.boolean().default(true),
  /** Stop-loss distance as a % of entry, applied when the model omits one. */
  fallbackStopLossPercent: z.number().min(0.05).max(50).default(2.5),
  /** Take-profit distance as a % of entry, applied when the model omits one. */
  fallbackTakeProfitPercent: z.number().min(0.05).max(200).default(7.5),

  /**
   * 止损距离必须至少是**往返手续费**的多少倍（提案 §5 的手续费感知门槛）。
   *
   * 一笔止损比往返成本还近的交易，**即使方向做对了也是亏的**：价格必须先走完
   * 成本才开始为账户挣钱。这条校验把"手续费"从一个模型可以考虑的因素，变成一条
   * 由风控强制执行的入场边界（§2.1：风控是通往订单的唯一路径）。
   *
   * 3 是保守起点：止损幅度等于手续费时，胜率再高也只是在给交易所打工。
   * 0 表示关闭这条校验（与 `maxDailyLossPercent` 等字段同一约定）。
   */
  minStopLossFeeMultiple: z.number().min(0).max(50).default(3),
  /**
   * 保本止损：浮盈达到这个百分比时，把止损移到开仓价。
   *
   * **0 表示关闭**（与 `maxDailyLossPercent` 等字段同一约定）。
   *
   * 为什么需要它：实测平均持仓 4.6 分钟、手续费占毛盈亏 38%，
   * 而**一笔已经赚到钱的单又变回亏损单是最亏的做法**。
   * 既有的回撤守卫管的是"浮盈回吐太多就落袋"，管不了这件事 ——
   * 它给利润设了上限，而这里要的是"这笔不再可能亏"。
   *
   * ⚠️ 只能往有利方向移，永不回退（见 `risk/breakeven.ts`）。
   */
  breakevenTriggerPercent: z.number().min(0).max(100).default(0),
  /**
   * 读不到成交记录时，按这个**往返**手续费率校验（小数比例：0.001 = 0.10%）。
   *
   * 实测均值是 0.1000%（15 笔成交），但不同标的、不同 VIP 等级会不同，所以真实
   * 取值优先用成交记录算出来的 `Σfee / Σ名义价值`（见
   * `RiskEnvironment.roundTripFeeRate`）；这里的默认值只在"这个机器人还没有任何
   * 成交"时兜底。**不要把它写死成常量**：那会让这个数字在 VIP 账户上系统性偏高。
   */
  fallbackRoundTripFeeRate: z.number().min(0).max(0.05).default(0.001),
});
export type RiskControlConfig = z.infer<typeof RiskControlConfigSchema>;

/* -------------------------------------------------------------------------- */
/*  Protection — drawdown giveback, throttling, circuit breakers                */
/* -------------------------------------------------------------------------- */

export const DrawdownGuardSchema = z.object({
  enabled: z.boolean().default(true),
  /** Only arm the guard once a position's peak profit exceeds this (%). */
  activationPercent: z.number().min(0).max(1000).default(1.5),
  /** Close when this fraction of the peak profit has been given back (0-1). */
  givebackRatio: z.number().min(0.05).max(1).default(0.5),
});
export type DrawdownGuard = z.infer<typeof DrawdownGuardSchema>;

export const ThrottleConfigSchema = z.object({
  /** A freshly opened position cannot be closed by the model before this. */
  minHoldMinutes: z.number().min(0).max(1440).default(3),
  /** Per-symbol lockout after a close. */
  reentryCooldownMinutes: z.number().min(0).max(1440).default(10),
  /** Entry orders allowed per decision cycle. */
  maxEntriesPerCycle: z.number().int().min(1).max(20).default(2),
  /** Entry orders allowed per rolling hour. */
  maxEntriesPerHour: z.number().int().min(1).max(60).default(6),
});

export const CircuitBreakerConfigSchema = z.object({
  /** Halt new entries once the day's realised loss exceeds this (% of equity). */
  maxDailyLossPercent: z.number().min(0).max(100).default(5),
  /** Halt new entries once equity falls this far below its high-water mark (%). */
  maxTotalDrawdownPercent: z.number().min(0).max(100).default(20),
  /** Consecutive LLM/execution failures before safe mode engages. */
  safeModeAfterFailures: z.number().int().min(1).max(50).default(3),
  /** While in safe mode, wait this many cycles before probing the model again. */
  safeModeProbeCycles: z.number().int().min(1).max(100).default(3),
});

/* -------------------------------------------------------------------------- */
/*  Prompt sections — the strategy itself                                      */
/* -------------------------------------------------------------------------- */

export const TradingModeSchema = z.enum(['aggressive', 'conservative', 'scalping']);
export type TradingMode = z.infer<typeof TradingModeSchema>;

export const PromptSectionsSchema = z.object({
  roleDefinition: z.string().default(''),
  tradingFrequency: z.string().default(''),
  entryStandards: z.string().default(''),
  decisionProcess: z.string().default(''),
});
export type PromptSections = z.infer<typeof PromptSectionsSchema>;

/* -------------------------------------------------------------------------- */
/*  Full strategy                                                              */
/* -------------------------------------------------------------------------- */

export const StrategyConfigSchema = z.object({
  /** Display name shown in the console. */
  name: z.string().min(1).max(80).default('Default strategy'),
  description: z.string().max(500).default(''),

  tradingMode: TradingModeSchema.default('conservative'),

  coinSource: CoinSourceConfigSchema.default({}),
  indicators: IndicatorConfigSchema.default({}),
  riskControl: RiskControlConfigSchema.default({}),
  drawdownGuard: DrawdownGuardSchema.default({}),
  throttle: ThrottleConfigSchema.default({}),
  circuitBreaker: CircuitBreakerConfigSchema.default({}),

  promptSections: PromptSectionsSchema.default({}),
  /** Appended verbatim to the system prompt. */
  customPrompt: z.string().max(20_000).default(''),
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
export type StrategyConfigInput = z.input<typeof StrategyConfigSchema>;

/* -------------------------------------------------------------------------- */
/*  Factory defaults + presets                                                 */
/* -------------------------------------------------------------------------- */

/** A fully-populated config. Zod defaults fill every field. */
export function defaultStrategyConfig(): StrategyConfig {
  return StrategyConfigSchema.parse({});
}

/**
 * Style presets mirroring the three trading modes. These only seed the
 * *prompt* sections and a few numeric knobs — the user is free to edit
 * everything afterwards.
 */
export interface StrategyPreset {
  id: string;
  label: string;
  summary: string;
  tradingMode: TradingMode;
  patch: Partial<StrategyConfigInput>;
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'conservative',
    label: '稳健',
    summary: '多重信号确认、低杠杆、宽止损、少交易。',
    tradingMode: 'conservative',
    patch: {
      tradingMode: 'conservative',
      coinSource: {
        sourceType: 'mixed',
        staticCoins: ['BTCUSDT', 'ETHUSDT'],
        useCoinPool: true,
        useOITop: true,
        coinPoolLimit: 15,
        coinPoolRank: 'quote_volume',
        minQuoteVolume24h: 100_000_000,
        minOpenInterestUsd: 10_000_000,
        oiTopLimit: 8,
        oiTopWindowHours: 4,
      },
      riskControl: {
        maxPositions: 2,
        btcEthMaxLeverage: 3,
        altcoinMaxLeverage: 3,
        defaultLeverage: 2,
        btcEthMaxPositionValueRatio: 3,
        altcoinMaxPositionValueRatio: 0.5,
        maxMarginUsage: 50,
        minPositionSize: 12,
        minRiskRewardRatio: 3,
        minConfidence: 80,
        requireStopLoss: true,
        requireTakeProfit: true,
        fallbackStopLossPercent: 2.5,
        fallbackTakeProfitPercent: 7.5,
        minStopLossFeeMultiple: 3,
        fallbackRoundTripFeeRate: 0.001,
        breakevenTriggerPercent: 8,
      },
      throttle: {
        minHoldMinutes: 30,
        reentryCooldownMinutes: 60,
        maxEntriesPerCycle: 1,
        maxEntriesPerHour: 2,
      },
      promptSections: {
        roleDefinition:
          '你是一名管理真实账户的稳健型加密货币合约交易员。保住本金是你的首要目标；错过一笔交易永远好过做错一笔交易。',
        tradingFrequency:
          '有选择地交易。连续多个周期不产生任何订单是完全正常且正确的。只在多重信号共振的高置信度机会上出手。',
        entryStandards:
          '入场前至少需要三个相互独立的确认（例如：多周期趋势一致、动能同向、持仓量与资金费支持）。拒绝"有可能"的机会，只接受"显而易见"的机会。',
        decisionProcess:
          '1) 先判断高周期趋势。2) 再看低周期结构与动能。3) 用持仓量和资金费做确认。4) 核验盈亏比至少达到 3:1。5) 按"止损被扫掉只损失不超过账户权益 1%"来确定仓位大小。6) 明确写出这笔交易的失效位。',
      },
      customPrompt:
        '绝不向亏损的仓位加仓。除非 1 小时与 15 分钟周期同时确认反转，否则绝不逆着 4 小时趋势开仓。',
    },
  },
  {
    id: 'aggressive',
    label: '进取',
    summary: '趋势突破、更高杠杆容忍度、更大仓位规模。',
    tradingMode: 'aggressive',
    patch: {
      tradingMode: 'aggressive',
      coinSource: {
        sourceType: 'mixed',
        staticCoins: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        useCoinPool: true,
        useOITop: true,
        coinPoolLimit: 30,
        coinPoolRank: 'gainers',
        minQuoteVolume24h: 30_000_000,
        minOpenInterestUsd: 5_000_000,
        oiTopLimit: 15,
        oiTopWindowHours: 2,
      },
      riskControl: {
        maxPositions: 5,
        btcEthMaxLeverage: 10,
        altcoinMaxLeverage: 7,
        defaultLeverage: 5,
        btcEthMaxPositionValueRatio: 8,
        altcoinMaxPositionValueRatio: 2,
        maxMarginUsage: 80,
        minPositionSize: 12,
        minRiskRewardRatio: 2,
        minConfidence: 70,
        requireStopLoss: true,
        requireTakeProfit: true,
        fallbackStopLossPercent: 3,
        fallbackTakeProfitPercent: 8,
        minStopLossFeeMultiple: 3,
        fallbackRoundTripFeeRate: 0.001,
      },
      throttle: {
        minHoldMinutes: 5,
        reentryCooldownMinutes: 10,
        maxEntriesPerCycle: 3,
        maxEntriesPerHour: 10,
      },
      promptSections: {
        roleDefinition:
          '你是一名激进的加密货币永续合约动能交易员。你捕捉突破后的延续与波动扩张，接受较低的胜率，依靠不对称的盈亏比获利。',
        tradingFrequency:
          '保持活跃。每个周期扫描整个候选池，只要出现合格机会就拿下其中最优秀的一到三个。',
        entryStandards:
          '在放量且持仓量上升的整理区间被有效突破时入场。优先选择相对 BTC 走强的标的。不要追一根已经偏离突破位超过 3% 的K线。',
        decisionProcess:
          '1) 按相对强度与动能给候选标的排序。2) 找出清晰且紧凑的突破位。3) 用成交量与持仓量扩张做确认。4) 在被突破结构的另一侧精确设置止损。5) 目标至少是止损距离的 2 倍。',
      },
      customPrompt:
        '快速止损——突破失败即视为失效。让盈利单奔跑至目标位，不要过早止盈。',
    },
  },
  {
    id: 'scalping',
    label: '短线',
    summary: '短线动能、紧贴的目标位、快速换手。',
    tradingMode: 'scalping',
    patch: {
      tradingMode: 'scalping',
      coinSource: {
        sourceType: 'mixed',
        staticCoins: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        useCoinPool: true,
        useOITop: false,
        coinPoolLimit: 25,
        coinPoolRank: 'volatility',
        minQuoteVolume24h: 50_000_000,
        minOpenInterestUsd: 5_000_000,
        oiTopLimit: 10,
        oiTopWindowHours: 1,
      },
      indicators: {
        kline: { primaryTimeframe: '1m', selectedTimeframes: ['1m', '5m', '15m'], primaryCount: 60 },
        enableEma: true,
        emaPeriods: [9, 21],
        enableMacd: true,
        macdFast: 12,
        macdSlow: 26,
        macdSignal: 9,
        enableRsi: true,
        rsiPeriods: [7],
        enableAtr: true,
        atrPeriods: [14],
        enableVolume: true,
        enableOi: true,
        enableFundingRate: true,
        enableQuantData: true,
        enableOiRanking: false,
      },
      riskControl: {
        maxPositions: 3,
        btcEthMaxLeverage: 20,
        altcoinMaxLeverage: 10,
        defaultLeverage: 10,
        btcEthMaxPositionValueRatio: 10,
        altcoinMaxPositionValueRatio: 3,
        maxMarginUsage: 70,
        minPositionSize: 12,
        minRiskRewardRatio: 1.2,
        minConfidence: 65,
        requireStopLoss: true,
        requireTakeProfit: true,
        fallbackStopLossPercent: 0.6,
        fallbackTakeProfitPercent: 1.2,
        minStopLossFeeMultiple: 3,
        fallbackRoundTripFeeRate: 0.001,
      },
      drawdownGuard: { enabled: true, activationPercent: 0.4, givebackRatio: 0.4 },
      throttle: {
        minHoldMinutes: 1,
        reentryCooldownMinutes: 3,
        maxEntriesPerCycle: 3,
        maxEntriesPerHour: 20,
      },
      promptSections: {
        roleDefinition:
          '你是一名加密货币永续合约的高频短线交易员。你交易订单流动能的短促爆发，持仓以分钟计而非小时计。',
        tradingFrequency:
          '要非常活跃。每个周期都重新评估，抓住当下最干净的短线动能机会。',
        entryStandards:
          '只在即时动能中入场：最新几根 1 分钟K线的高点/低点被刷新，且有主动买卖流支持。止损紧贴结构位。任何在一两根K线内没有触发的想法都应放弃。',
        decisionProcess:
          '1) 读 1 分钟微观结构与 5 分钟趋势。2) 定位最近的波段高低点。3) 在突破时结合订单流确认入场。4) 把止损放在波段另一侧。5) 目标为最近的流动性区域，快速止盈。',
      },
      customPrompt:
        '激进地保护利润——一笔已经赚到钱的短线单又变成亏损单是最糟糕的结果。除非有充分理由，绝不在资金费结算时刻前后持仓。',
    },
  },
];
