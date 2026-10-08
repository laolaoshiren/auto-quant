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
  CircuitBreakerReading,
  StrategyConfig,
  StrategyPreset,
  StrategyRecord,
  TradeRecord,
  Trader,
  TraderMode,
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

  /*
   * ── 滑动续期 ─────────────────────────────────────────────────────────
   *
   * 服务端在令牌剩余不足一半寿命时，会把一张同身份的新令牌放进这个响应头
   * （见 `auth.ts` 的 `refreshIfStale`）。存回去，下次请求就用新的 ——
   * 于是**只要页面还在轮询，登录状态就不会掉**。
   *
   * 放在 `response.ok` 判断**之前**：续期与这次请求成功与否无关，
   * 一个 500 的响应也可能带着新令牌（它同样是"经过校验的请求"）。
   * 漏掉它，一次后端抖动就会顺带把会话寿命白扔一半。
   */
  const refreshed = response.headers.get('x-refreshed-token');
  if (refreshed && !anonymous) setToken(refreshed);

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
  /**
   * 创建机器人时预选哪个模型。
   *
   * 原来是"列表第一个"，而列表按 id 排 —— 于是一个**已失效**的模型只要 id 最小
   * 就会成为默认，每次创建都要手动改回来。取不到时为 null，调用方回落到第一个。
   */
  defaultAiModelId: number | null;
}

/**
 * 部署版本 —— 线上跑的是哪一次构建。
 *
 * 服务器上没有 `.git`（部署是打包上传），所以这些值由构建机写进 `build-info.json`
 * 随包传过去。`null` 表示**这次部署没有写出版本信息**（部署脚本早于该功能，
 * 或用了别的部署方式）—— 界面必须把它显示成"未知"，不能回落到一个默认真值。
 */
export interface BuildInfo {
  commit: string;
  commitShort: string;
  branch: string;
  subject: string;
  committedAt: string;
  deployedAt: string;
  /** 打包时工作区有未提交改动 —— 服务器跑的东西不等于这个提交。 */
  dirty: boolean;
  repository: string;
}

export type UpdateState = 'up-to-date' | 'behind' | 'ahead' | 'diverged' | 'unknown';

/** `GET /api/system/update` —— 与远端仓库比对的结果（服务端缓存 10 分钟）。 */
export interface UpdateCheck {
  state: UpdateState;
  message: string;
  checkedAt: string;
  repository: string | null;
  branch: string | null;
  localCommit: string | null;
  latestCommit: string | null;
  latestCommitShort: string | null;
  latestSubject: string | null;
  latestCommittedAt: string | null;
  behindBy: number | null;
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
  /** 部署版本。`null` = 这次部署没写出版本信息。 */
  build: BuildInfo | null;
  /** 产品版本号（`package.json`）。与 `build` 是两件事。 */
  version: string;
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
  /**
   * **AI 主动停手**的状态（没停手时是 `null`）。
   *
   * 用户 2026-10-04 的原话：「**再也不会开新仓？你确定？那这个机器人存在意义是什么？**」
   *
   * 他说得对：模型能调 `pause_trading` 设上这个开关、交易循环也照它拦开仓，
   * **而清除它的入口原本不存在**（`clearPause()` 只在测试里被调用）。
   * 于是界面只显示「开多 / 未执行（已跳过）」，人既看不出原因、也找不到出口。
   *
   * 现在服务端把它发出来，界面据此显示"停手中 + 恢复按钮"。
   */
  agentPaused?: { at: string; reason: string } | null;
  /**
   * 最近一次**账目校验**的结论（交易循环每轮自己算的）。
   *
   * 用户 2026-10-07 报的「起始 100.05，现在 100.84，为什么显示 +$1.29」——
   * `platformNet` 是账本（可能错），`exchangeNet` 是交易所流水（真实），
   * 两者之差就是 `gap`。界面对着它显示，而不是拿账本值冒充事实。
   */
  ledger?: { platformNet: number; exchangeNet: number; gap: number; checkedAt: string } | null;
  /**
   * **下一轮决策的预定触发时刻**（epoch 毫秒），没有排程时为 null。
   *
   * 用户 2026-10-07：「能在这里加入一个倒计时吗？让我明显知道下一轮决策剩余周期」。
   *
   * 由服务端给出（`AutoTrader.nextCycleAt`），它记的是**定时器真正被排到的那一刻**，
   * 已经把"模型自己要求的间隔"和"失败短重试"都算进去了 ——
   * **界面不要自己推算**，那会显示一个骗人的倒计时。
   */
  nextCycleAt?: number | null;
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
  /**
   * 这个模型**最近一次调用**的结果（服务端记在 `settings` 里）。
   *
   * `null` = 还没调用过。它存在的理由：网关连着回「余额不足」时，
   * 界面上原本一个字都没有（见服务端 `LlmHealth` 的说明）。
   */
  health?: { ok: boolean; at: string; latencyMs?: number; error?: string } | null;
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
  /*
   * ⚠️ **不再有 temperature / maxTokens / timeoutSeconds / maxRetries。**
   *
   * 它们完全由服务端按厂商决定（见 `AiModelInputSchema`），控制台上的
   * 「高级设置」面板也已删除。**契约里继续留着它们，会让人以为传了有用。**
   */
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
  /**
   * 这只机器人的策略；**AI 托管时必须传 `null`**。
   *
   * ## ⚠️ 这里曾经与「已知事实」相反（2026-10-03 修）
   *
   * 原来是 `strategyId: number`，下面 `mode` 的注释还写着**解耦之前**的说法：
   * 「`ai_managed` 时 `strategyId` 仍然要传（**服务端是 NOT NULL**），但不起作用」。
   *
   * **那句话早就过时了。** `d338b35`「智能托管与策略彻底解耦」把服务端的
   * `traders.strategy_id` 改成可空（迁移后 `ON DELETE SET NULL`），并在创建时
   * **主动拒绝**带策略的 AI 托管请求：
   *
   *   if (mode === 'ai_managed' && requestedStrategyId !== null)
   *     throw new Error('智能托管模式不引用任何策略 —— 请不要为它选择策略。');
   *
   * 而前端**一直在传数字**（下拉框里那个 `#9`）—— 于是 **AI 托管模式下创建机器人
   * 必定失败**，错误文字就是上面那句。用户 2026-10-03 撞上的正是它：
   * 他现有的机器人是解耦**之前**建的，而那是他第一次用界面创建 AI 托管机器人。
   *
   * 类型放宽成可空，**提交处按 `mode` 决定传什么**（见 `TraderModals.tsx` 的 `submit`）。
   */
  strategyId: number | null;
  cycleIntervalMinutes: number;
  /**
   * Optional on purpose: omitting it (or sending 0) makes the server read the
   * real wallet balance from the configured exchange. Only send it when the
   * operator explicitly chose to type the baseline themselves.
   */
  initialEquity?: number;
  /**
   * 运行模式。
   *
   * `'ai_managed'` 时参数由 AI 智能体自己设定并持续调整，**策略参数被彻底忽略** ——
   * 此时 `strategyId` 必须传 `null`（见上面那条字段说明：服务端会拒绝带策略的请求）。
   * `'strategy'` 时 `strategyId` 必须是一个真实存在的策略 id。
   */
  mode?: TraderMode;
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
  /**
   * 与远端仓库比对部署版本。
   *
   * 单独一次请求，因为它**要出网**（服务端打 GitHub，8 秒超时）—— 不能让它拖住
   * 整页的加载。服务端缓存 10 分钟，所以重复打开这一页不会重复打 GitHub。
   */
  updateCheck: (signal?: AbortSignal) => request<UpdateCheck>('/system/update', { signal }),
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
  /**
   * 指定「新建机器人时预选哪个模型」。
   *
   * 服务端一直在读 `settings.default_ai_model_id` 并把结果交给
   * `catalog.defaultAiModelId`（创建机器人时用它预选），**但此前没有任何地方写它** ——
   * 于是"取不到就回落到列表第一个"成了唯一会发生的行为。
   */
  setDefaultAiModel: (id: number) =>
    request<{ ok: boolean; defaultAiModelId: number }>(`/ai-models/${id}/set-default`, {
      method: 'POST',
      body: {},
    }),
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
  /**
   * Probe an unsaved model draft before committing it.
   *
   * `modelId` 与 `discoverModels` 同一个含义：**编辑已有模型时用那条记录的已存密钥**。
   * 界面刻意不回显明文密钥（输入框留空 = "不改它"），所以只发 `apiKey: ''`
   * 会被服务端当成"没提供密钥"而直接报 `Missing API key.`。
   */
  testAiModelDraft: (input: AiModelInput & { modelId?: number }) =>
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
  /**
   * **恢复交易** —— 撤掉 AI 主动设下的停手开关（`pause_trading`）。
   *
   * 那个开关原本**没有任何撤销入口**：模型设得上、循环照它拦开仓，
   * 而清除函数只在测试里被调用过 —— 机器人会永久停在新仓之外。
   */
  resumeTrader: (id: number) => request<{ ok: boolean }>(`/traders/${id}/resume`, { method: 'POST', body: {} }),
  /** Force one decision cycle now instead of waiting for the interval. */
  runTraderOnce: (id: number) =>
    request<{ ok: boolean; summary: string }>(`/traders/${id}/run-once`, { method: 'POST', body: {} }),
  /**
   * 让 AI **现在**审视一次策略 —— 与 `runTraderOnce` 是两件事。
   *
   *   `runTraderOnce`  跑一个**决策周期**：机器人按当前参数决策一次
   *   这个             跑一次**策略审视**：AI 反思绩效与复盘，决定要不要改参数
   *
   * 它下不了单，但确实会改参数（受结构守卫约束）。返回的是"请求已发出"
   * 而不是结果 —— 审视异步执行，且仍可能被每小时预算挡下。
   */
  agentReview: (id: number) =>
    request<{ ok: boolean; accepted: boolean; note: string }>(`/traders/${id}/agent-review`, {
      method: 'POST',
      body: {},
    }),
  /** Rebuild the books from the exchange's fill history — never places an order. */
  reconcileTrader: (id: number) =>
    request<ReconcileResult>(`/traders/${id}/reconcile`, { method: 'POST', body: {} }),

  /**
   * 手工平掉一个持仓 —— **操作员的最高权限，随时可用**。
   *
   * 服务端不对它做任何"机器人是否在运行"的前置检查：那是"机器人要不要开仓"
   * 的范畴，而这是"人要退出"。**一个止不住手的操作员是被困住的。**
   */
  closePosition: (id: number, symbol: string) =>
    request<{ ok: boolean; avgPrice: number; fee: number; stillRunning: boolean }>(
      `/traders/${id}/positions/${symbol}/close`,
      { method: 'POST', body: {} },
    ),

  /**
   * 平掉**该机器人的全部持仓**。
   *
   * 服务端逐个平（每个都走 `closeManually` 的同一套顺序：先撤单、再市价平、再记账），
   * 并返回**实际平掉的币种列表** —— 界面靠这个列表说话，而不是靠一个哨兵值。
   */
  closeAllPositions: (id: number) =>
    request<{ ok: boolean; closed: string[]; cancelledPending: number; stillRunning: boolean }>(
      `/traders/${id}/positions/close-all`,
      { method: 'POST', body: {} },
    ),

  /* --- per-trader data --- */
  /**
   * 统计 + **熔断器的当前读数** + **这个机器人自己在不在纸面模式**。
   *
   * `circuitBreaker` 与 `dryRun` 都不是 `TraderStats` 的一部分：那个类型是仓储层
   * 算的纯统计，而这两个数由服务端从**运行时**组装（见端点上的说明）。机器人在
   * **停止**时它们都是 `null` —— 那时没有内存里的配置/实例可用来判定，
   * **而不是"确认没有熔断"或"确认在花真钱"**。
   */
  traderStats: (id: number, signal?: AbortSignal) =>
    request<
      TraderStats & { circuitBreaker: CircuitBreakerReading | null; dryRun: boolean | null }
    >(`/traders/${id}/stats`, {
      signal,
    }),
  traderPositions: (id: number, signal?: AbortSignal) =>
    request<PositionView[]>(`/traders/${id}/positions`, { signal }),
  traderAccount: (id: number, signal?: AbortSignal) =>
    request<{
      live: boolean;
      account: Record<string, unknown> | null;
      /**
       * 交易所**实时**持仓（`liveExchangeView` 直接问交易所，不是本地镜像）。
       *
       * ⚠️ 类型原来写的是 `unknown[]` —— 那让调用方只能断言或者绕开，而"绕开"
       * 的结果是页面拿 WebSocket 推的本地镜像当持仓数：服务刚重启、镜像还没建
       * 起来时显示「持仓 0」，而**这个端点明明已经拿到了真实持仓**。
       * 类型松一档，正确的那条路就没人走。
       */
      positions: PositionView[];
      /**
       * **本机器人自己**的浮动盈亏（服务端按它的持仓 symbol 过滤后算出）。
       *
       * `positions` 是**整个账户**的持仓（共享钱包上所有机器人 + 手动仓），
       * 所以不能拿它求和当"我的浮盈" —— 独立验收 2026-10-07 指出的就是这一处。
       */
      ownUnrealizedPnl?: number;
      /**
       * **交易所口径**的挂单数量（实时读回，不是 WebSocket 镜像）。
       *
       * 用户 2026-10-08：「有 3 个挂单，为什么上面不显示保证金占用？」
       * 卡片原来用 `live?.orders`（镜像）去判断"是否空仓"，镜像在断线/重连时是空的，
       * 于是它以为没有挂单、把占用算成 0，而下方「挂单占用」还写着 26.74。
       */
      openOrderCount?: number;
      error?: string;
    }>(`/traders/${id}/account`, { signal }),
  /**
   * 账户上的**外部交易活动** —— 不属于本平台任何机器人的成交。
   *
   * ## 为什么它值得单独一个端点
   *
   * 这些交易的盈亏**直接从交易所余额进出**，却不计入任何机器人的绩效。
   * 于是会出现一个看起来自相矛盾、而两者都正确的情形：
   *
   *     机器人绩效 +0.32      账户余额 −1.56
   *
   * 在加这个端点之前，平台对此**一个字都不说**（归属闸门在跳过时写的是
   * `log.debug`，而那个级别不显示）。操作员只能自己猜，AI 也只能自己猜。
   *
   * 结论来自**最近一次对账**，所以机器人在停止状态下仍然可读 ——
   * 那正是最需要它的时刻。
   *
   * `detectedAt` 为 `null` 表示**从未检测过**，与「检测过、没有外部活动」
   * （`rounds = 0`）是两件事，界面必须分开说。
   */
  foreignActivity: (id: number, signal?: AbortSignal) =>
    request<{
      rounds: number;
      net: number;
      symbols: string[];
      firstAt: string | null;
      lastAt: string | null;
      detectedAt: string | null;
    }>(`/traders/${id}/foreign-activity`, { signal }),
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
  /**
   * 一页成交记录。
   *
   * ⚠️ **游标是复合的**（`before` + `beforeClosedAt`）——
   * 与 `traderOrders` **不一样**，别照抄。
   *
   * 成交行的 `id` 是插入顺序，而**对账补录的行 id 更大、成交时刻更早**：
   * 按 id 排序会让界面上的日期看起来错乱（用户的原话：「历史成交里面日期显示
   * 错乱（不是完全按时间排序）」）。服务端因此改成按 `closed_at` 排序，
   * 而按时间排序之后只用 id 做游标会漏行 —— 所以翻页要同时给
   * **那一行的 `closedAt`**。两个都给时服务端走新路径；只给 `before` 时
   * 退回旧行为。
   */
  traderTrades: (
    id: number,
    options: {
      limit?: number;
      before?: number | null;
      beforeClosedAt?: string | null;
      signal?: AbortSignal;
    } = {},
  ) =>
    request<TradeRecord[]>(`/traders/${id}/trades`, {
      query: {
        limit: options.limit ?? 100,
        before: options.before ?? undefined,
        beforeClosedAt: options.beforeClosedAt ?? undefined,
      },
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
