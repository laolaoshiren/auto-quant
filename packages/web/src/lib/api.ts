/**
 * Thin typed client for the trading backend.
 *
 * Everything lives under `/api`; in development Vite proxies that prefix to the
 * Fastify server (see `vite.config.ts`), in production the bundle is served by
 * the same process so relative URLs just work.
 *
 * The client deliberately knows nothing about React — stores and components
 * consume it, which keeps polling/refresh logic out of the render tree.
 */
import type {
  AiModelConfig,
  Decision,
  DecisionRecord,
  EquitySnapshot,
  ExecutionLogEntry,
  ExchangeAccount,
  Kline,
  LlmProviderDescriptor,
  OrderRecord,
  PositionView,
  StrategyConfig,
  StrategyPreset,
  StrategyRecord,
  TradeRecord,
  Trader,
  TraderStats,
  User,
} from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  Session                                                                    */
/* -------------------------------------------------------------------------- */

const TOKEN_KEY = 'aq.token';
const USER_KEY = 'aq.user';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode — the session then simply does not survive a reload */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

export function getStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user: User): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

/** Raised for any non-2xx response so callers can show `error.message`. */
export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

/** Fired when the server rejects our token, so the shell can bounce to /login. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  /** Skip the Authorization header (login/register/health). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, anonymous = false, signal } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!anonymous) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(withQuery(`/api${path}`, query), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, '无法连接后端。端口 27137 上的服务是否在运行？', null);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !anonymous) onUnauthorized?.();
    const message =
      (payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : null) ?? `请求失败：HTTP ${response.status}`;
    throw new ApiError(response.status, message, payload);
  }

  return payload as T;
}

/* -------------------------------------------------------------------------- */
/*  Response shapes that go beyond the shared entities                         */
/* -------------------------------------------------------------------------- */

export interface Health {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  hasOwner: boolean;
  dryRun: boolean;
  tradingDisabled: boolean;
  environment: string;
  db: string;
}

export interface AuthResult {
  token: string;
  user: User;
}

export interface Catalog {
  providers: LlmProviderDescriptor[];
  exchanges: Array<{ id: string; label: string; market: string; available: boolean }>;
  presets: StrategyPreset[];
  defaultStrategy: StrategyConfig;
}

export interface SystemStatus {
  dryRun: boolean;
  tradingDisabled: boolean;
  environment: string;
  environmentLabel: string;
  clockOffsetMs: number;
  weightUsed: number;
  weightLimit: number;
  tradableSymbols: number;
  runningTraders: number[];
}

export interface LogLine {
  id: number;
  traderId: number | null;
  level: string;
  scope: string;
  message: string;
  createdAt: string;
}

export interface TraderRow extends Trader {
  isRunning: boolean;
}

/**
 * A live balance reading from the exchange.
 *
 * `equity` is the margin balance (wallet + unrealised PnL) — the number the bot
 * actually trades with; `walletBalance` is the settled balance the operator
 * sees as 钱包余额 on the exchange's own app.
 */
export interface ExchangeBalance {
  equity: number;
  walletBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginUsed: number;
  openOrderMargin: number;
  /** Margin asset the figures are denominated in — `USDT` in practice. */
  asset: string;
  /** ISO timestamp of the exchange read. */
  readAt: string;
}

/**
 * 凭据的**对外**形状。
 *
 * `Omit<…, 'apiKey'>` 是刻意的：服务端只发掩码，不发原始 API Key
 * （见 `server.ts` 的 `publicAccount()`）。类型里若还留着 `apiKey`，
 * 等于在鼓励下一个人写 `row.apiKey` —— 而那个字段运行时是 `undefined`，
 * TypeScript 又不会拦你。去掉它，越界访问就会在编译期报错。
 */
export interface ExchangeAccountRow extends Omit<ExchangeAccount, 'apiKey'> {
  apiKeyMasked: string;
  /** `null` when the read failed — see `balanceError`. */
  balance: ExchangeBalance | null;
  balanceError: string | null;
}

/**
 * `GET /exchange-accounts/:id/balance` — note it answers **HTTP 200 even on
 * failure**, so callers must branch on `ok`, never on the status code.
 */
export type ExchangeBalanceResult =
  | { ok: true; balance: ExchangeBalance; cached: boolean }
  | { ok: false; error: string };

/** Where a new trader's starting equity came from. */
export type EquitySource = 'exchange' | 'manual' | 'unavailable';

/**
 * `POST /traders/:id/reconcile`.
 *
 * Rebuilds the ledger from the exchange's own fill history. Places no orders and
 * is deliberately allowed while the bot is stopped — that is exactly when the
 * books need correcting. Like the balance endpoint it can answer **HTTP 400
 * with `ok: false`**, so callers must branch on `ok`.
 */
export type ReconcileResult =
  | { ok: true; recovered: number; corrected: number; funding: number }
  | { ok: false; error: string };

export interface AiModelRow extends AiModelConfig {
  apiKeyMasked: string;
  hasKey: boolean;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
  /**
   * Display severity. A check can be "fine, but confirm this" — the
   * withdrawal-permission notice on a sub-account key is the motivating case —
   * which `ok: boolean` alone cannot express. Optional so an older server
   * payload still renders.
   */
  severity?: 'ok' | 'warn' | 'error';
}

export interface StartResult {
  ok: boolean;
  preflight: PreflightCheck[];
  error?: string;
}

export interface ExchangeTestResult {
  ok: boolean;
  checks: PreflightCheck[];
  error?: string;
}

export interface ModelTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  modelEcho?: string;
}

/** One entry returned by `POST /ai-models/discover`. */
export interface DiscoveredModel {
  id: string;
  label?: string;
  /** Context window, when the provider reports one. */
  contextLength?: number;
  /** `false` means "built-in suggestion", not a live result. */
  discovered: boolean;
}

export interface DiscoverModelsResult {
  ok: boolean;
  models: DiscoveredModel[];
  source: 'live' | 'fallback';
  message: string;
}

/** One row of a strategy health check stage. */
export interface CheckStage {
  name: string;
  ok: boolean;
  detail: string;
  /** Wall-clock cost of this stage in milliseconds. */
  ms: number;
}

export interface StrategyCheckSample {
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  cotTrace: string;
  decisions: Decision[];
  rejected: Array<{ symbol: string; action: string; reason: string }>;
  approved: Decision[];
  riskRejected: Array<{ action: string; symbol: string; reason: string }>;
  executionLog: ExecutionLogEntry[];
  candidateSymbols: string[];
  /** Simulated account the review ran against — never a real order. */
  simulatedEquity: number;
}

export interface StrategyCheckResult {
  ok: boolean;
  verdict: string;
  stages: CheckStage[];
  sample: StrategyCheckSample | null;
  strategyName?: string;
  modelLabel?: string;
  model?: string;
}

export interface MarketSymbol {
  symbol: string;
  baseAsset: string;
  price: number;
  changePercent24h: number;
  quoteVolume24h: number;
  minNotional: number;
}

export interface ExchangeAccountInput {
  exchange: string;
  label: string;
  apiKey: string;
  apiSecret?: string;
  testnet: boolean;
  canTrade: boolean;
}

/**
 * Model payload.
 *
 * The inference knobs are optional on the wire: omitting one makes the server
 * fall back to the provider's own default, which is exactly what the collapsed
 * "advanced" disclosure in the add-model dialog relies on.
 */
export interface AiModelInput {
  provider: string;
  label: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  maxRetries?: number;
}

export interface StrategyInput {
  name: string;
  description: string;
  presetId: string | null;
  config: StrategyConfig;
}

export interface TraderInput {
  name: string;
  exchangeAccountId: number;
  aiModelId: number;
  strategyId: number;
  cycleIntervalMinutes: number;
  /**
   * Optional on purpose: omitting it (or sending 0) makes the server read the
   * real wallet balance from the configured exchange. Only send it when the
   * operator explicitly chose to type the baseline themselves.
   */
  initialEquity?: number;
}

/* -------------------------------------------------------------------------- */
/*  Endpoint surface                                                           */
/* -------------------------------------------------------------------------- */

export const api = {
  /* --- auth --- */
  health: () => request<Health>('/health', { anonymous: true }),

  login: (username: string, password: string) =>
    request<AuthResult>('/auth/login', { method: 'POST', body: { username, password }, anonymous: true }),

  me: (signal?: AbortSignal) => request<{ user: User }>('/auth/me', { signal }),

  /**
   * 修改用户名与/或密码。
   *
   * 必须带上当前密码：只凭会话令牌就允许改凭据，意味着任何一次令牌泄露
   * 都能被升级成永久接管。
   */
  updateAccount: (input: { currentPassword: string; username?: string; newPassword?: string }) =>
    request<{ ok: boolean; token: string; user: User }>('/auth/account', {
      method: 'PATCH',
      body: input,
    }),

  /* --- catalogues + system --- */
  catalog: (signal?: AbortSignal) => request<Catalog>('/catalog', { signal }),
  system: (signal?: AbortSignal) => request<SystemStatus>('/system', { signal }),
  logs: (limit = 200, signal?: AbortSignal) =>
    request<{ logs: LogLine[] }>('/logs', { query: { limit }, signal }),

  /* --- exchange accounts --- */
  exchangeAccounts: (signal?: AbortSignal) =>
    request<ExchangeAccountRow[]>('/exchange-accounts', { signal }),
  /**
   * Live balance for one credential. `refresh` bypasses the 20-second
   * server-side cache — an operator pressing refresh is asking for "now".
   */
  exchangeBalance: (id: number, refresh = false, signal?: AbortSignal) =>
    request<ExchangeBalanceResult>(`/exchange-accounts/${id}/balance`, {
      query: { refresh: refresh ? 1 : undefined },
      signal,
    }),
  /** Force a fresh read for several credentials at once. */
  refreshExchangeBalances: (ids: number[]) =>
    Promise.all(ids.map(async (id) => [id, await request<ExchangeBalanceResult>(`/exchange-accounts/${id}/balance`, { query: { refresh: 1 } })] as const)),
  createExchangeAccount: (input: ExchangeAccountInput) =>
    request<ExchangeAccountRow>('/exchange-accounts', { method: 'POST', body: input }),
  updateExchangeAccount: (id: number, input: Partial<ExchangeAccountInput>) =>
    request<{ ok: boolean }>(`/exchange-accounts/${id}`, { method: 'PATCH', body: input }),
  deleteExchangeAccount: (id: number) =>
    request<{ ok: boolean }>(`/exchange-accounts/${id}`, { method: 'DELETE' }),
  testExchangeAccount: (id: number) =>
    request<ExchangeTestResult>(`/exchange-accounts/${id}/test`, { method: 'POST', body: {} }),
  /** Probe credentials that have not been saved yet. */
  testExchangeDraft: (input: ExchangeAccountInput) =>
    request<ExchangeTestResult>('/exchange-accounts/test-draft', { method: 'POST', body: input }),

  /* --- AI models --- */
  aiModels: (signal?: AbortSignal) => request<AiModelRow[]>('/ai-models', { signal }),
  createAiModel: (input: AiModelInput) => request<AiModelConfig>('/ai-models', { method: 'POST', body: input }),
  updateAiModel: (id: number, input: Partial<AiModelInput>) =>
    request<{ ok: boolean }>(`/ai-models/${id}`, { method: 'PATCH', body: input }),
  deleteAiModel: (id: number) => request<{ ok: boolean }>(`/ai-models/${id}`, { method: 'DELETE' }),
  testAiModel: (id: number) => request<ModelTestResult>(`/ai-models/${id}/test`, { method: 'POST', body: {} }),
  /**
   * Ask the provider which models this key can use.
   *
   * `modelId` 是"用这条记录已存储的密钥"的唯一表达方式：编辑已有模型时界面刻意不回显
   * 明文密钥、输入框留空，只发 `apiKey: ''` 会被服务端当成"没提供密钥"而直接失败。
   * 用户手动输入了密钥时不必传 `modelId`。
   */
  discoverModels: (input: { provider: string; baseUrl: string; apiKey: string; modelId?: number }) =>
    request<DiscoverModelsResult>('/ai-models/discover', { method: 'POST', body: input }),
  /** Probe an unsaved model draft before committing it. */
  testAiModelDraft: (input: AiModelInput) =>
    request<ModelTestResult>('/ai-models/test-draft', { method: 'POST', body: input }),

  /* --- strategies --- */
  strategies: (signal?: AbortSignal) => request<StrategyRecord[]>('/strategies', { signal }),
  strategy: (id: number, signal?: AbortSignal) => request<StrategyRecord>(`/strategies/${id}`, { signal }),
  createStrategy: (input: StrategyInput) => request<StrategyRecord>('/strategies', { method: 'POST', body: input }),
  updateStrategy: (id: number, input: Partial<StrategyInput>) =>
    request<StrategyRecord>(`/strategies/${id}`, { method: 'PATCH', body: input }),
  deleteStrategy: (id: number) => request<{ ok: boolean }>(`/strategies/${id}`, { method: 'DELETE' }),
  /**
   * Strategy health check — runs the whole pipeline against a simulated
   * account. Slow (10–60s) and never places an order.
   */
  checkStrategy: (id: number, input: { aiModelId: number; symbol?: string }) =>
    request<StrategyCheckResult>(`/strategies/${id}/check`, { method: 'POST', body: input }),

  /* --- traders --- */
  traders: (signal?: AbortSignal) => request<TraderRow[]>('/traders', { signal }),
  /** The response carries where the starting equity came from. */
  createTrader: (input: TraderInput) => request<Trader & { equitySource?: EquitySource }>('/traders', { method: 'POST', body: input }),
  updateTrader: (id: number, input: Partial<TraderInput>) =>
    request<Trader>(`/traders/${id}`, { method: 'PATCH', body: input }),
  deleteTrader: (id: number) => request<{ ok: boolean }>(`/traders/${id}`, { method: 'DELETE' }),
  startTrader: (id: number, dryRun: boolean) =>
    request<StartResult>(`/traders/${id}/start`, { method: 'POST', body: { dryRun } }),
  stopTrader: (id: number) => request<{ ok: boolean }>(`/traders/${id}/stop`, { method: 'POST', body: {} }),
  /** Force one decision cycle now instead of waiting for the interval. */
  runTraderOnce: (id: number) =>
    request<{ ok: boolean; summary: string }>(`/traders/${id}/run-once`, { method: 'POST', body: {} }),
  /** Rebuild the books from the exchange's fill history — never places an order. */
  reconcileTrader: (id: number) =>
    request<ReconcileResult>(`/traders/${id}/reconcile`, { method: 'POST', body: {} }),

  /* --- per-trader data --- */
  traderStats: (id: number, signal?: AbortSignal) =>
    request<TraderStats>(`/traders/${id}/stats`, { signal }),
  traderPositions: (id: number, signal?: AbortSignal) =>
    request<PositionView[]>(`/traders/${id}/positions`, { signal }),
  traderAccount: (id: number, signal?: AbortSignal) =>
    request<{
      live: boolean;
      account: Record<string, unknown> | null;
      positions: unknown[];
      error?: string;
    }>(`/traders/${id}/account`, { signal }),
  /**
   * 一页订单记录（服务端按 `id` 倒序，即最新的一单在前）。
   *
   * `before` 是**游标**，不是偏移量：它要求服务端只返回 `id` 比它更小的订单。
   * 之所以不用 `offset`：订单是**在顶部持续插入**的（每下一单就多一行），用偏移量
   * 翻页时"第 2 页"的起点会因为新订单插进来而整体后移 —— 第二页的第一条会和第一页
   * 的最后一条重复，同一张订单在表格里出现两次。游标锚在一条具体记录上，
   * 插入多少条都不影响它。
   *
   * `limit` 由服务端钳制（上限 `ORDER_PAGE_MAX`），所以这里照原样传即可。
   * 调用方（`TraderTables`）一次多要一条来做"还有没有更早的"的判断，
   * 所以这个参数不叫"页大小"。
   */
  traderOrders: (
    id: number,
    options: { limit?: number; before?: number | null; signal?: AbortSignal } = {},
  ) =>
    request<OrderRecord[]>(`/traders/${id}/orders`, {
      query: { limit: options.limit ?? 100, before: options.before ?? undefined },
      signal: options.signal,
    }),
  /** 一页成交记录，契约与 `traderOrders` 完全相同（同一套 `before=id` 游标）。 */
  traderTrades: (
    id: number,
    options: { limit?: number; before?: number | null; signal?: AbortSignal } = {},
  ) =>
    request<TradeRecord[]>(`/traders/${id}/trades`, {
      query: { limit: options.limit ?? 100, before: options.before ?? undefined },
      signal: options.signal,
    }),
  /**
   * 一页决策记录（服务端按 `id` 倒序，即最新的一轮在前）。
   *
   * `before` 是**游标**，不是偏移量：它要求服务端只返回 `id` 比它更小的记录。
   * 之所以不用 `offset`：决策记录是**在顶部持续插入**的（每跑完一轮就多一条），
   * 用偏移量翻页时，"第 2 页"的起点会因为新记录插进来而整体后移 ——
   * 于是第二页的第一条会和第一页的最后一条重复，反过来（记录被裁掉时）则会漏掉。
   * 游标锚在一条具体记录上，插入多少条都不影响它。
   *
   * 调用方（`DecisionFeed`）一次多要一条来做"还有没有更早的"的判断，
   * 所以这里不把 `limit` 设成"页大小"的名字。
   */
  traderDecisions: (
    id: number,
    options: { limit?: number; before?: number | null; signal?: AbortSignal } = {},
  ) =>
    request<DecisionRecord[]>(`/traders/${id}/decisions`, {
      query: { limit: options.limit ?? 50, before: options.before ?? undefined },
      signal: options.signal,
    }),
  traderDecision: (id: number, recordId: number, signal?: AbortSignal) =>
    request<DecisionRecord>(`/traders/${id}/decisions/${recordId}`, { signal }),
  traderEquity: (id: number, limit = 500, signal?: AbortSignal) =>
    request<EquitySnapshot[]>(`/traders/${id}/equity`, { query: { limit }, signal }),

  /* --- market --- */
  marketSymbols: (signal?: AbortSignal) => request<MarketSymbol[]>('/market/symbols', { signal }),
  marketKlines: (symbol: string, interval: string, limit = 300, signal?: AbortSignal) =>
    request<Kline[]>('/market/klines', { query: { symbol, interval, limit }, signal }),
};

/** Absolute WebSocket URL for the live event stream. */
export function eventStreamUrl(): string {
  const token = getToken() ?? '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/events?token=${encodeURIComponent(token)}`;
}
