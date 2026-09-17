import { z } from 'zod';
import type { StrategyConfig } from './strategy.js';
import type { Decision } from './decision.js';

/* -------------------------------------------------------------------------- */
/*  Exchanges                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Phase 1 ships Binance USDⓈ-M futures only. The union is intentionally open so
 * further venues can be added without touching call sites.
 */
export const ExchangeIdSchema = z.enum(['binance']);
export type ExchangeId = z.infer<typeof ExchangeIdSchema>;

export const EXCHANGES: ReadonlyArray<{
  id: ExchangeId;
  label: string;
  market: string;
  available: boolean;
}> = [
  { id: 'binance', label: '币安 USDT 本位合约', market: 'USDT 永续合约', available: true },
];

/* -------------------------------------------------------------------------- */
/*  LLM providers                                                              */
/* -------------------------------------------------------------------------- */

export const LlmProviderIdSchema = z.enum([
  'deepseek',
  'openai',
  'anthropic',
  'gemini',
  'qwen',
  'grok',
  'kimi',
  'minimax',
  'openrouter',
  'custom',
]);
export type LlmProviderId = z.infer<typeof LlmProviderIdSchema>;

export interface LlmProviderDescriptor {
  id: LlmProviderId;
  label: string;
  /** Default API base URL. `custom` requires the user to supply one. */
  baseUrl: string;
  /** Auth style drives how the client builds headers. */
  authStyle: 'bearer' | 'x-api-key' | 'query-key';
  /**
   * A few suggested model ids, shown only before the user has supplied a key.
   * Prefer `modelsPath` discovery — a static list goes stale.
   */
  models: string[];
  /** True when the provider speaks the OpenAI `/chat/completions` dialect. */
  openAiCompatible: boolean;
  /** Whether a native strict JSON mode is available. */
  jsonMode: 'json_object' | 'json_schema' | 'none';
  docsUrl: string;
  /** Path appended to `baseUrl` to list available models, e.g. `/models`. */
  modelsPath: string;
  /** How to authenticate against `modelsPath`. */
  modelsAuth: 'bearer' | 'x-api-key' | 'query-key';
  /** Extra headers the models endpoint requires (e.g. `anthropic-version`). */
  modelsHeaders?: Record<string, string>;
  /** Sensible inference defaults, so the user never has to choose numbers. */
  defaults: {
    temperature: number;
    maxTokens: number;
    timeoutSeconds: number;
    maxRetries: number;
  };
  /** True when the provider offers a slow, deliberate reasoning mode. */
  supportsThinking: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Persisted entities                                                         */
/* -------------------------------------------------------------------------- */

export interface User {
  id: number;
  username: string;
  role: 'owner' | 'user';
  createdAt: string;
}

/** Exchange credentials. `apiSecret` never leaves the server in plaintext. */
export interface ExchangeAccount {
  id: number;
  exchange: ExchangeId;
  label: string;
  apiKey: string;
  /** Only ever sent to the client as a boolean-ish hint, never the secret. */
  hasSecret: boolean;
  testnet: boolean;
  /** Read-only keys can be stored but cannot trade. */
  canTrade: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiModelConfig {
  id: number;
  provider: LlmProviderId;
  label: string;
  model: string;
  baseUrl: string;
  /** Masked on the wire. */
  apiKeyMasked: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A model advertised by a provider's own `/models` endpoint.
 *
 * `discovered` distinguishes a live result from a built-in suggestion, so the UI
 * can tell the user which list they are looking at.
 */
export interface DiscoveredModel {
  id: string;
  label?: string;
  /** Context window, when the provider reports one. */
  contextLength?: number;
  discovered: boolean;
}

/** 机器人的运行模式。**这是机器人的属性，不是一个策略** —— 见 `M7_TRADER_MODE` 的注释。 */
export type TraderMode = 'strategy' | 'ai_managed';

export type TraderStatus = 'running' | 'stopped' | 'starting' | 'error' | 'safe_mode';

export interface Trader {
  id: number;
  name: string;
  exchangeAccountId: number;
  aiModelId: number;
  strategyId: number;
  /** Minutes between decision cycles. */
  cycleIntervalMinutes: number;
  initialEquity: number;
  status: TraderStatus;
  /** Populated while running. */
  lastCycleAt: string | null;
  /**
   * Monotonic cycle counter, persisted so that the audit trail keeps a single
   * continuous numbering across restarts rather than resetting to zero.
   */
  lastCycleNumber: number;
  lastError: string | null;
  consecutiveFailures: number;
  /**
   * AI 智能托管模式下的参数（JSON），**非空即代表这个机器人由 AI 托管**。
   *
   * 不能用 `strategies.config` 的原因：**一个策略可以被多个机器人共用**，
   * 而 AI 模式下每个机器人的参数是各自演化的 —— 共用会让两个 AI 互相覆盖，
   * 而且那种覆盖看起来完全正常。
   *
   * 为 null 时按 `strategies.config` 跑，行为与以前完全一致。
   */
  agentConfigJson: string | null;
  /**
   * 运行模式。
   *
   * `'strategy'` —— 按 `strategies.config` 的固定参数跑（既有机器人的行为）。
   * `'ai_managed'` —— 由 AI 智能体托管：参数由它自己设定并持续调整，
   *   存在 `agentConfigJson`（按机器人隔离），策略参数被忽略。
   *
   * **这是一个机器人的属性，不是一个策略。** 策略是"一组固定参数"，
   * 而 AI 模式的意思是"没有固定参数" —— 后者不能是前者的一种。
   */
  mode: TraderMode;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyRecord {
  id: number;
  name: string;
  description: string;
  config: StrategyConfig;
  /** Set when the strategy was cloned from a preset. */
  presetId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/*  Trading records                                                            */
/* -------------------------------------------------------------------------- */

export type PositionSide = 'long' | 'short';

export interface PositionView {
  id: number;
  traderId: number;
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  liquidationPrice: number | null;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  /** Best unrealised PnL seen, used by the drawdown guard. */
  peakPnlPercent: number;
  marginUsed: number;
  notional: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string;
  /** Free-form reason captured at entry, from the model. */
  openReasoning: string;
}

export interface OrderRecord {
  id: number;
  traderId: number;
  exchangeOrderId: string | null;
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  purpose: 'entry' | 'exit' | 'stop_loss' | 'take_profit' | 'adjustment';
  quantity: number;
  price: number | null;
  stopPrice: number | null;
  status: string;
  avgPrice: number | null;
  filledQty: number;
  fee: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TradeRecord {
  id: number;
  traderId: number;
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  /**
   * **Gross** realised PnL — the exchange's own `realizedPnl`, before costs.
   *
   * This comment previously read "net of fees", which was simply untrue and is
   * the kind of documentation error that teaches every caller a wrong
   * assumption. Costs live in `entryFee`/`fee`/`fundingFee`; use `netPnl` for
   * what the trade actually contributed to the account.
   */
  pnl: number;
  /** Opening-leg commission. */
  entryFee: number;
  /** Closing-leg commission. */
  exitFee: number;
  /** `entryFee + exitFee`. Kept for display convenience. */
  fee: number;
  /** Funding paid or received while the position was open. */
  fundingFee: number;
  /** `pnl − fee − fundingFee`: the real change to the account balance. */
  netPnl: number;
  /** `netPnl` as a percentage of the margin committed. */
  pnlPercent: number;
  /** Why it closed. A stable machine code — see `CloseReason`. */
  closeReason: string;
  /**
   * Where the record came from.
   *
   * `bot` — booked live by the running cycle.
   * `reconciled` — recovered from the exchange's fill history, because the
   * position closed while the process was not running. Both are legitimate, but
   * a reconciled trade is the signal that live bookkeeping missed something.
   */
  source: 'bot' | 'reconciled';
  openedAt: string;
  closedAt: string;
  holdMinutes: number;
}

/**
 * Why a position was closed.
 *
 * These are **stable machine codes persisted in the database**, deliberately not
 * display text: translating them would rewrite history and make old rows
 * unreadable to the current UI. The console maps them to labels.
 */
export const CLOSE_REASONS = [
  'model_decision', // the model asked to close
  'stop_loss', // the exchange-side stop fired
  'take_profit', // the exchange-side target fired
  'drawdown_guard', // peak-profit giveback rule
  'liquidated', // liquidation or ADL
  'external', // closed outside the bot, reason unknown
  /*
   * Entered, but the exchange-side stop could not be established — so the
   * position was market-closed to avoid holding a naked leveraged exposure.
   *
   * A distinct code on purpose: this close is a **cost** the runtime chose to
   * pay, and an operator needs to see how often it happens. Folding it into
   * `external` or `stop_loss` would hide the fact that the entry and the
   * protection disagreed about price.
   */
  'protection_unavailable',
  /*
   * Recovered from the exchange's fill history rather than observed live.
   *
   * A distinct code on purpose: the position certainly closed, but the process
   * was not running to see *which* order did it. Labelling it `stop_loss` or
   * `take_profit` would be inventing a fact, and it would hide the operational
   * signal that live bookkeeping missed a close.
   */
  'reconciled',
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/**
 * Chinese labels for the close-reason codes.
 *
 * Lives in the shared package because three layers render it: the server log
 * lines, the prompt sent to the model, and the console. Keeping one map means a
 * new reason cannot be added without every surface picking it up.
 */
export const CLOSE_REASON_LABELS: Record<string, string> = {
  model_decision: '模型主动平仓',
  stop_loss: '触发止损',
  take_profit: '触发止盈',
  drawdown_guard: '回撤守卫平仓',
  liquidated: '爆仓',
  external: '外部平仓',
  protection_unavailable: '保护单缺失（已立即平仓）',
  reconciled: '对账补录',
};

/** Label for a close reason, falling back to the raw code rather than blank. */
export function closeReasonLabel(code: string): string {
  return CLOSE_REASON_LABELS[code] ?? code;
}

/**
 * Chinese labels for trader status codes.
 *
 * Same reasoning as `CLOSE_REASON_LABELS` above, and the same trap: `status` is
 * a **machine code persisted in the database** (`traders.status`), so the stored
 * value must never be translated — only what the operator reads.
 *
 * This map used to live inside the badge component, which meant anything outside
 * that component rendered the raw code. A status event therefore surfaced to the
 * operator as:
 *
 *     机器人 #6 → stopped
 *
 * That is not a cosmetic problem: `stopped` is also what a deliberate operator
 * stop writes, so an English word was the only thing distinguishing "the bot was
 * stopped" from any other status. Putting the map in the shared package means a
 * new status cannot be added without every surface picking up a label.
 */
export const TRADER_STATUS_LABELS: Record<TraderStatus, string> = {
  running: '运行中',
  stopped: '已停止',
  starting: '启动中',
  error: '异常',
  safe_mode: '安全模式',
};

/** Label for a trader status, falling back to the raw code rather than blank. */
export function traderStatusLabel(status: string): string {
  return TRADER_STATUS_LABELS[status as TraderStatus] ?? status;
}

/**
 * Chinese labels for an order's purpose.
 *
 * Same rule as the maps above: `purpose` is persisted in `orders.purpose`, so the
 * **stored value never changes** — only what the operator reads. Before this map
 * existed the order toast rendered the raw code with its underscore swapped for a
 * space, so an operator saw `stop loss · BUY BTCUSDT` instead of
 * `止损 · 多 BTCUSDT`.
 */
export const ORDER_PURPOSE_LABELS: Record<string, string> = {
  entry: '开仓',
  exit: '平仓',
  stop_loss: '止损',
  take_profit: '止盈',
  adjustment: '调整',
};

export function orderPurposeLabel(purpose: string): string {
  return ORDER_PURPOSE_LABELS[purpose] ?? purpose;
}

/**
 * Chinese labels for exchange order status codes.
 *
 * These are Binance's own values (`NEW` / `FILLED` / …). They stay English in the
 * database and in the API — the console is the only place they get translated,
 * and unknown values fall through unchanged so a new status is never hidden.
 */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  NEW: '已挂单',
  PARTIALLY_FILLED: '部分成交',
  FILLED: '已成交',
  CANCELED: '已撤销',
  CANCELLED: '已撤销',
  REJECTED: '已拒绝',
  EXPIRED: '已过期',
  EXPIRED_IN_MATCH: '已过期（撮合中）',
  /*
   * 补进来的原因：控制台的"终态"集合（`TraderTables.tsx` 的 `TERMINAL_STATUSES`）
   * 里一直有它，标签表却没有 —— 于是同一列里 `EXPIRED_IN_MATCH` 是中文、
   * 它是英文原码。一边中文一边英文比全英文更难读。
   */
  EXPIRED_IN_FUTURES: '已过期（期货）',
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

/**
 * Chinese labels for order types.
 *
 * `STOP_MARKET` / `TAKE_PROFIT_MARKET` are the conditional types the broker
 * routes to `/fapi/v1/algoOrder`; an operator reading a table should not have to
 * know that.
 */
export const ORDER_TYPE_LABELS: Record<string, string> = {
  LIMIT: '限价',
  MARKET: '市价',
  STOP: '止损限价',
  STOP_MARKET: '止损市价',
  TAKE_PROFIT: '止盈限价',
  TAKE_PROFIT_MARKET: '止盈市价',
  TRAILING_STOP_MARKET: '移动止损',
};

export function orderTypeLabel(type: string): string {
  return ORDER_TYPE_LABELS[type] ?? type;
}

/**
 * Chinese labels for account roles.
 *
 * Same rule as the other label maps: the value is a machine code stored in
 * `users.role`, so only the display changes. It used to render raw in the
 * sidebar footer, which showed a bare English `owner` under the username.
 */
export const USER_ROLE_LABELS: Record<string, string> = {
  owner: '拥有者',
  user: '操作员',
};

export function userRoleLabel(role: string): string {
  return USER_ROLE_LABELS[role] ?? role;
}
/** Label for a trading mode. */
export const TRADING_MODE_LABELS: Record<string, string> = {
  conservative: '稳健',
  aggressive: '进取',
  scalping: '短线',
};

/**
 * Chinese labels for the coin-source machine codes.
 *
 * Same rule as the maps above: `coinSource.sourceType` is a stored contract value
 * (`static` / `coinpool` / `oi_top` / `mixed`) that must never be translated in
 * the database — only what the operator reads. This map did not exist, so the
 * strategy list rendered the **raw code**, and a Chinese console showed a bare
 * `mixed` in the 币种池 column. The editor had its own local copy of the same
 * four labels (`SOURCE_TYPES` in `StrategyFields.tsx`), which is exactly the
 * divergence the shared map exists to prevent.
 */
export const COIN_SOURCE_TYPE_LABELS: Record<string, string> = {
  static: '静态列表',
  coinpool: '动态币种池',
  oi_top: '持仓量领先',
  mixed: '混合（并集）',
};

export function coinSourceTypeLabel(sourceType: string): string {
  return COIN_SOURCE_TYPE_LABELS[sourceType] ?? sourceType;
}

/**
 * One complete decision cycle. `systemPrompt` + `userPrompt` + `rawResponse`
 * make every trade fully reproducible after the fact — there is no position
 * without a paper trail.
 */
export interface DecisionRecord {
  id: number;
  traderId: number;
  cycleNumber: number;
  timestamp: string;
  systemPrompt: string;
  userPrompt: string;
  cotTrace: string;
  decisions: Decision[];
  rawResponse: string;
  executionLog: ExecutionLogEntry[];
  candidateSymbols: string[];
  success: boolean;
  error: string | null;
  /** Wall-clock cost of the model call, milliseconds. */
  aiLatencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ExecutionLogEntry {
  action: string;
  symbol: string;
  status: 'ok' | 'rejected' | 'failed' | 'skipped';
  detail: string;
  orderId?: string;
  /** Notional actually filled, when applicable. */
  notionalUsd?: number;
  /**
   * Every place the risk engine overruled the model for this decision.
   *
   * Structured rather than only embedded in `detail` so the console can list
   * them, and so a test can assert that clamping actually happened instead of
   * pattern-matching a sentence.
   */
  adjustments?: string[];
}

/**
 * 某个机器人在某一时刻的权益快照。
 *
 * `equity` 是**归属**权益（`initialEquity + Σ net_pnl + 自己的浮盈`），不是钱包
 * 余额。同一个交易所账户下可以跑多个机器人，它们共用一份凭据、共用一个钱包，
 * 所以钱包余额对它们全都是同一个数 —— 把它写进这里会让一个从未成交的机器人显示
 * 别的机器人挣来的收益率，也会让一个已停止的机器人的数字随着邻居交易而变。
 * 账户（共享钱包）的权益另存 `accountEquity` / `accountUnrealizedPnl`。
 */
export interface EquitySnapshot {
  traderId: number;
  timestamp: string;
  /**
   * 归属权益：**本机器人自己的交易**挣来的那部分。
   *
   * `initialEquity + Σ(本机器人 net_pnl) + 本机器人持仓浮盈`。机器人没成交时
   * 就等于 `initialEquity`（平的），停止后不再变化。
   */
  equity: number;
  /**
   * 账户的可用余额。
   *
   * 它和 `marginUsed` 都是**账户级**的量：自由保证金是共享钱包的属性，按机器人
   * 拆分没有意义（交易所也不提供这个口径）。保留在这里是为了记录快照当时的账户
   * 状态，不要把它当成"这个机器人的可用余额"。
   */
  availableBalance: number;
  /** 本机器人自己持仓的浮动盈亏，不是账户的总浮盈。 */
  unrealizedPnl: number;
  /** 账户级：被持仓与挂单占用的初始保证金。 */
  marginUsed: number;
  /** 本机器人自己的未平仓合约数。 */
  openPositions: number;
  /** 账户（共享钱包）的权益 —— `totalMarginBalance`，同一账户下所有机器人共用。 */
  accountEquity: number;
  /** 账户的总浮动盈亏，用于对账展示；风控高水位读的是 `accountEquity − accountUnrealizedPnl`。 */
  accountUnrealizedPnl: number;
}

export interface TraderStats {
  traderId: number;
  /**
   * 归属权益（默认口径）：`initialEquity + realizedPnl + unrealizedPnl`。
   *
   * 不是账户余额 —— 见 `accountEquity`。
   */
  equity: number;
  initialEquity: number;
  totalReturnPercent: number;
  realizedPnl: number;
  /**
   * Gross realised PnL before costs — the sum of the exchange's own
   * `realizedPnl` per round-trip.
   *
   * `realizedPnl` above is the **net** figure; this is the other half of the
   * breakdown so the console can show where the money went.
   */
  grossRealizedPnl: number;
  /** Total commission paid, both legs of every round-trip. */
  totalFees: number;
  /** Total funding paid (negative) or received (positive). */
  totalFunding: number;
  unrealizedPnl: number;
  /**
   * 该机器人所属**交易所账户**（共享钱包）的权益，来自最近一条快照。
   *
   * 之所以单独给出而不是让界面用 `equity` 顶替：同一账户下的多个机器人读数是
   * 同一个数，混在一起就没法分辨"这个机器人挣了多少"和"账户里有多少钱"。
   * 没有快照时为 0。
   */
  accountEquity: number;
  totalTrades: number;
  /**
   * Winning trades as a **percentage in 0–100**, not a 0–1 fraction.
   *
   * Named with the unit on purpose. The field used to be called `winRate` with
   * no unit, the server returned a percentage while three console pages assumed
   * a fraction, and each multiplied by 100 again — one win out of one trade
   * rendered as **10000.0%**. A name that carries its unit makes that class of
   * mistake impossible to reintroduce silently.
   */
  winRatePercent: number;
  /** Closed trades that finished in profit. */
  wins: number;
  /**
   * Closed trades that did not.
   *
   * Sent explicitly rather than derived on the client from `winRatePercent`,
   * which is lossy: rounding a percentage back into a count is how "1 trade"
   * became "100 盈".
   */
  losses: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdownPercent: number;
  sharpeRatio: number | null;
  bestTrade: number;
  worstTrade: number;
  openPositions: number;
  cyclesRun: number;
  uptimeHours: number;
}

/* -------------------------------------------------------------------------- */
/*  Live event bus (server → browser)                                          */
/* -------------------------------------------------------------------------- */

export type ServerEvent =
  | { type: 'trader_status'; traderId: number; status: TraderStatus; detail?: string }
  | { type: 'cycle_start'; traderId: number; cycleNumber: number; timestamp: string }
  | { type: 'cycle_end'; traderId: number; cycleNumber: number; summary: string; success: boolean }
  | { type: 'decision'; traderId: number; record: DecisionRecord }
  | { type: 'positions'; traderId: number; positions: PositionView[] }
  | { type: 'order'; traderId: number; order: OrderRecord }
  | { type: 'trade'; traderId: number; trade: TradeRecord }
  | { type: 'equity'; traderId: number; snapshot: EquitySnapshot }
  | { type: 'log'; traderId: number | null; level: 'info' | 'warn' | 'error'; message: string; timestamp: string };
