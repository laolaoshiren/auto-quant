import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PositionView } from '@aq/shared';
import type { ExchangeConnection } from '../../binance/bootstrap.js';
import type { Vault } from '../../crypto/vault.js';
import { maskSecret } from '../../crypto/vault.js';
import type { GateContractRegistry } from '../../gate/account.js';
import type { GateMarket } from '../../gate/market.js';
import type { BalanceService } from '../../services/balance.js';
import type { TraderManager } from '../../trader/manager.js';
import type { AuthedRequest, requireAuth, TokenPayload } from '../auth.js';

/* -------------------------------------------------------------------------- */
/*  Server                                                                     */
/* -------------------------------------------------------------------------- */

let unhandledRejectionCount = 0;

/** AQ-2023：记录未捕获的 Promise rejection 次数，供 `/api/health` 暴露运维可观测性。 */
export function recordUnhandledRejection(): void {
  unhandledRejectionCount += 1;
}

export function getUnhandledRejectionCount(): number {
  return unhandledRejectionCount;
}

export interface ApiDependencies {
  vault: Vault;
  manager: TraderManager;
  jwtSecret: string;
  /** A credential-free connection used for public market data. */
  publicConnection: ExchangeConnection;
  /** Reads and caches exchange account balances for display. */
  balance: BalanceService;
  /**
   * **建一条只读交易所连接** —— 只给测试用，生产不传（不传就等于改动前的行为）。
   *
   * ## 为什么需要它
   *
   * `GET /api/traders/:id/positions` 与 `GET /api/traders/:id/account` 都会
   * 现建一条只读连接去问交易所的真实持仓。而**"交易所读成功、返回的持仓列表为空"**
   * 正是「模拟盘显示 0 持仓」那个 BUG 的形状 —— 没有这个注入口，那条路在测试里
   * **不可达**：真去连交易所要网络、要凭据，而测试两样都不该有。
   *
   * 于是最容易出错的那条分支反而永远测不到（本仓反复出现的"看不出异常的失败"）。
   * 有了它，测试可以注入一个假连接，逐条钉住：
   * **模拟盘 → 本地台账**、**实盘 → 交易所**、**读失败 → 503 不冒充**。
   *
   * ⚠️ **不要把生产逻辑搬到这里**，也不要为了省一次网络调用而传它 ——
   * 它存在的唯一理由是"让不可达的分支可达"。
   */
  openReadOnlyConnection?: () => Promise<ExchangeConnection>;
  /**
   * 控制台实时交易所视图（`/positions` 与 `/account`）的内存缓存时长（毫秒）。
   *
   * 生产默认 5000ms（避免多标签页与前端轮询高频撞击币安 2400 权重/分钟限额）；
   * 注入了 `openReadOnlyConnection` 的测试场景默认 0（不缓存，保证各用例彼此隔离），
   * 需测试缓存本身时可显式传入正数。
   */
  liveViewCacheTtlMs?: number;
}

/**
 * 凭据对外暴露的形状。**原始 `apiKey` 绝不外发。**
 *
 * 这里原本在两处各写了一遍 `{ ...account, apiKeyMasked: maskSecret(account.apiKey) }`。
 * 展开运算符把 `account.apiKey` —— **明文密钥** —— 一起带进了响应体；
 * 掩码只是"额外加了一个字段"，并没有替换掉它。于是完整密钥出现在
 * `GET /api/exchange-accounts` 的响应里。
 *
 * 为什么这种 bug 很难被发现：界面只画 `apiKeyMasked`，**肉眼看不出问题**。
 * 但浏览器开发者工具、任何 XSS、任何错误上报或会话回放插件都能直接读到它。
 * 同一个类型上 `hasSecret` 的注释写着 "never the secret"，说明设计意图本就是
 * 不外发 —— 是展开运算符违背了它。
 *
 * 所以用**解构剔除**而不是展开整个对象：新增字段仍然默认外发，
 * 但密钥字段必须先被显式摘掉。改这里时请保持这个方向。
 *
 * 提成模块级导出的纯函数，是为了能直接单测 —— 见 `serialize.test.ts`。
 * 放在 `buildServer` 内部时，想测它就得搭一整套 `ApiDependencies` 桩对象，
 * 于是没人会去测，而这个 bug 就会以同样的方式回来。
 */
export function publicAccount<T extends { apiKey: string }>(account: T) {
  const { apiKey, ...rest } = account;
  return { ...rest, apiKeyMasked: maskSecret(apiKey) };
}

/**
 * 读 `:id` 路由参数，转不成有限数字就抛一个 **400**。
 *
 * 以前 22 条路由各自写 `Number((request.params as { id: string }).id)`，
 * 而 `NaN` 会被 `db/index.ts` 的 `normalise()` 静默绑成 NULL —— 于是
 * `WHERE id = NULL` 查不到行，接口回 **404「找不到该凭据/该机器人」**。
 *
 * 一个拼错的 URL 因此得到"这条记录不存在"的回答：操作员会去找一条
 * 从来没存在过的记录，而真正的病因（路径写错）被完全藏住。
 */
export function idParamOf(params: unknown): number {
  const raw = (params as { id?: unknown }).id;
  /*
   * 空串要先拦掉：`Number('')` 是 **0**，而 0 是有限数 —— 少了这一步，
   * `/api/traders//positions` 这种少了一段路径的 URL 会变成"查 id 0"，
   * 同样是个看不出病因的错误答案。
   */
  const id = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(id)) {
    const error = new Error('请求路径里的 ID 无效。');
    (error as { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return id;
}


export type PositionsSource = 'exchange' | 'local_mirror' | 'none';

export type ExchangeAccountState = Awaited<
  ReturnType<ExchangeConnection['broker']['getAccountState']>
>;

export interface LiveAccountViewResult {
  live: boolean;
  account: ExchangeAccountState | null;
  positions: PositionView[];
  positionsSource: PositionsSource;
  ownUnrealizedPnl?: number;
  openOrderCount?: number;
  error: string | undefined;
}

export interface LivePositionsViewResult {
  live: boolean;
  positions: PositionView[];
  positionsSource: PositionsSource;
  error: string | undefined;
}

export interface LiveViewCache {
  liveViewCacheTtlMs: number;
  liveAccountCache: Map<number, { at: number; value: LiveAccountViewResult }>;
  liveAccountInFlight: Map<number, Promise<LiveAccountViewResult>>;
  livePositionsCache: Map<number, { at: number; value: LivePositionsViewResult }>;
  livePositionsInFlight: Map<number, Promise<LivePositionsViewResult>>;
  invalidateLiveView: (traderId: number) => void;
}

export function createLiveViewCache(deps: ApiDependencies): LiveViewCache {
  const liveViewCacheTtlMs =
    deps.liveViewCacheTtlMs ?? (deps.openReadOnlyConnection ? 0 : 5_000);
  const liveAccountCache = new Map<number, { at: number; value: LiveAccountViewResult }>();
  const liveAccountInFlight = new Map<number, Promise<LiveAccountViewResult>>();
  const livePositionsCache = new Map<number, { at: number; value: LivePositionsViewResult }>();
  const livePositionsInFlight = new Map<number, Promise<LivePositionsViewResult>>();
  const invalidateLiveView = (traderId: number): void => {
    liveAccountCache.delete(traderId);
    livePositionsCache.delete(traderId);
  };
  return {
    liveViewCacheTtlMs,
    liveAccountCache,
    liveAccountInFlight,
    livePositionsCache,
    livePositionsInFlight,
    invalidateLiveView,
  };
}

export type PublicGateMarketHandle = {
  market: GateMarket;
  contracts: GateContractRegistry;
};

export function createPublicGateMarketLoader(): () => Promise<PublicGateMarketHandle> {
  let promise: Promise<PublicGateMarketHandle> | null = null;
  return () => {
    if (!promise) {
      promise = (async () => {
        const { GateRest } = await import('../../gate/rest.js');
        const { GateContractRegistry } = await import('../../gate/account.js');
        const { GateMarket } = await import('../../gate/market.js');
        const rest = new GateRest({ apiKey: '', apiSecret: '', environment: 'live' });
        const contracts = new GateContractRegistry(rest);
        return { market: new GateMarket(rest, contracts), contracts };
      })().catch((err) => {
        promise = null;
        throw err;
      });
    }
    return promise;
  };
}

export interface RouteContext {
  app: FastifyInstance;
  deps: ApiDependencies;
  authed: { preHandler: ReturnType<typeof requireAuth> };
  idOf: (request: AuthedRequest) => number;
  guard: <T>(
    handler: (input: T, request: AuthedRequest, reply: FastifyReply) => Promise<unknown> | unknown,
  ) => (request: AuthedRequest, reply: FastifyReply) => Promise<unknown>;
  tokenRevoked: (payload: TokenPayload) => boolean;
  activeWsClients: Map<number, Set<() => void>>;
  disconnectUserSockets: (userId: number) => void;
  liveView: LiveViewCache;
  getPublicGateMarket: () => Promise<PublicGateMarketHandle>;
}
