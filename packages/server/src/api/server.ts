import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  EXCHANGES,
  LLM_PROVIDERS,
  STRATEGY_PRESETS,
  StrategyConfigSchema,
  defaultStrategyConfig,
  providerDefaults,
  type ServerEvent,
  type Trader,
  type TraderStatus,
} from '@aq/shared';
import { z } from 'zod';
import type { ExchangeConnection } from '../binance/bootstrap.js';
import { preflight } from '../binance/bootstrap.js';
import type { Vault } from '../crypto/vault.js';
import { dbPath, env, webDistDir } from '../env.js';
import { eventBus } from '../events.js';
import { createLogger, setLogSink } from '../logger.js';
import { maskSecret, hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from '../crypto/vault.js';
import {
  aiModels,
  computeTraderStats,
  decisions as decisionStore,
  equity as equityStore,
  exchanges,
  orders as orderStore,
  positions as positionStore,
  runtimeLogs,
  strategies,
  traders,
  trades as tradeStore,
  users,
} from '../store/repositories.js';
import type { TraderManager } from '../trader/manager.js';
import {
  requireAuth,
  signToken,
  verifyToken,
  extractToken,
  isTokenRevoked,
  generatePassword,
  generateUsername,
  type AuthedRequest,
  type TokenPayload,
} from './auth.js';
import { FailureThrottle, IP_THROTTLE_OPTIONS, USERNAME_THROTTLE_OPTIONS } from './loginThrottle.js';
import { checkOutboundUrl } from '../llm/urlGuard.js';
import type { BalanceService } from '../services/balance.js';

const log = createLogger('api');

/* -------------------------------------------------------------------------- */
/*  Request schemas                                                            */
/* -------------------------------------------------------------------------- */

const CredentialsSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(6).max(256),
});

/**
 * 修改账户凭据的请求体。
 *
 * 加 zod 不是为了拦攻击，而是为了拦住**类型错误**：`currentPassword` 传数字时，
 * 旧代码会把它一路送到 `scryptSync`，抛出的 `TypeError` 变成 HTTP 500。
 * 校验发生在任何写操作之前，所以这里没有绕过风险 —— 但 500 会让一个纯粹的
 * 客户端错误看起来像服务端故障，还会把内部栈信息回显出去。
 */
const UpdateAccountSchema = z.object({
  currentPassword: z.string({ description: '当前密码' }).min(1, '请填写当前密码。').max(256),
  username: z.string().max(64).optional(),
  newPassword: z.string().max(256).optional(),
});

/**
 * 自定义模型端点地址。
 *
 * 在这里（而不是只在真正发请求的地方）校验，是为了给操作员一条明确的 400，
 * 而不是把危险地址先存进数据库、等到交易循环才以一条看不懂的超时报错。
 * 真正的兜底在 `LlmClient` 构造函数里 —— 那里覆盖所有出站路径，
 * 包括本次改动之前就已经存进库里的旧地址。
 */
const BaseUrlSchema = z
  .string()
  .default('')
  .superRefine((value, ctx) => {
    if (!value) return;
    const verdict = checkOutboundUrl(value);
    if (!verdict.allowed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `baseUrl 不被允许：${verdict.reason}` });
    }
  });

const ExchangeAccountInputSchema = z.object({
  exchange: z.enum(['binance']).default('binance'),
  label: z.string().min(1).max(80),
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  testnet: z.boolean().default(true),
  canTrade: z.boolean().default(true),
});

/**
 * Only the three things a user should have to think about are required.
 *
 * The inference parameters are optional and fall back to the provider's own
 * sensible defaults — a trading bot needs a small, deterministic completion, so
 * there is no reason to make anyone choose a temperature. They remain settable
 * under "advanced" for the cases that genuinely need it.
 *
 * `maxTokens` has a deliberately generous ceiling: reasoning models burn output
 * budget on their thinking before emitting a single character, so a tight cap
 * manifests as an empty completion rather than a clear error.
 */
const AiModelInputSchema = z.object({
  provider: z.string().min(1),
  label: z.string().min(1).max(80),
  model: z.string().min(1),
  baseUrl: BaseUrlSchema,
  apiKey: z.string().default(''),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(2_000_000).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
});

const DiscoverModelsInputSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().default(''),
  baseUrl: BaseUrlSchema,
});

/**
 * Schema for probing an unsaved model.
 *
 * Deliberately does **not** require `label`: the probe saves nothing, and making
 * a display name mandatory to answer "does this key work?" is friction with no
 * purpose. Only the fields that actually determine whether the call can succeed
 * are required.
 */
const DraftModelInputSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  baseUrl: BaseUrlSchema,
  apiKey: z.string().default(''),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(2_000_000).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
});

const StrategyCheckInputSchema = z.object({
  aiModelId: z.number().int().positive(),
  /** Restrict the universe to one symbol for a fast, focused check. */
  symbol: z.string().max(24).optional(),
});

const StrategyInputSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  presetId: z.string().nullable().default(null),
  config: StrategyConfigSchema,
});

const TraderInputSchema = z.object({
  name: z.string().min(1).max(80),
  exchangeAccountId: z.number().int().positive(),
  aiModelId: z.number().int().positive(),
  strategyId: z.number().int().positive(),
  cycleIntervalMinutes: z.number().int().min(1).max(1440).default(15),
  /**
   * Starting equity, used as the baseline for the return percentage.
   *
   * Optional on purpose. When omitted or zero the server reads the **real**
   * wallet balance from the configured exchange, because a hand-typed number can
   * silently disagree with the account and make every return figure wrong.
   */
  initialEquity: z.number().min(0).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Server                                                                     */
/* -------------------------------------------------------------------------- */

export interface ApiDependencies {
  vault: Vault;
  manager: TraderManager;
  jwtSecret: string;
  /** A credential-free connection used for public market data. */
  publicConnection: ExchangeConnection;
  /** Reads and caches exchange account balances for display. */
  balance: BalanceService;
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

/* -------------------------------------------------------------------------- */
/*  Health truth                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 一个机器人多久没走完一轮才算"卡住"——以它的周期为单位的倍数。
 *
 * **2 倍**，理由是把"合法的最慢情况"排除在外：
 *
 *  · `traders.last_cycle_at` 是在**一轮走完之后**才写的
 *    （`store/repositories.ts` 的 `recordCycle()`），所以 1 倍周期时，
 *    每一轮都恰好会在写之前短暂越线 —— 那是必然发生的假警报，不是故障。
 *  · 一轮的墙钟时间 = 周期本身 + 它对模型的调用 + 行情快照。模型的超时上限
 *    就是分钟级的，一个慢周期花掉接近一整个周期的时间是正常的。
 *  · 取 2 倍意味着"连续两轮都没能结束"才报警：单次超时、单次提供商抽风、
 *    单次交易所 503 都不会触发它，而**真正卡死**（事件循环被同步 SQLite 堵住、
 *    网络调用永不返回、循环退出）会在一个有界的时间内必然触发。
 *
 * 为什么不能再大：这个数字同时是运维发现"机器人已经不工作了"的延迟上限。
 * 取 3 倍会让一个 15 分钟的机器人最多沉默 45 分钟才被发现，而它在无保护、
 * 有持仓的情况下沉默的每一分钟都是真金白银的风险。
 */
export const STALE_CYCLE_MULTIPLIER = 2;

/**
 * 启动宽限期：这之后才开始判定"卡住"。
 *
 * 没有它，健康检查会在冷启动时**必然**失败一次：进程起来 → 容器开始探测 →
 * 行情快照 / 合约元数据 / 用户数据流还在加载，第一个周期要几十秒才走完，
 * 而 `last_cycle_at` 这时还是 null。那会让编排器在最不该重启的时候重启容器。
 *
 * 300 秒是一个"足够慢的启动也能走完第一轮"的下限；它也是每个机器人各自计算的
 * 下界（`max(周期 × 2, 300s)`），所以它对周期 1 分钟的机器人同样有效。
 */
export const STARTUP_GRACE_MS = 300_000;

export interface TraderHealth {
  traderId: number;
  name: string;
  status: TraderStatus;
  /** 距离上一轮结束的毫秒数；从未跑完过一轮时为 null。 */
  staleForMs: number | null;
  /** 该机器人被判定为卡住。只有 status === 'running' 才可能为 true。 */
  stale: boolean;
  /** 已在运行但还没有任何一轮的完成记录（首轮仍在跑）。 */
  awaitingFirstCycle: boolean;
}

export interface HealthVerdict {
  /** 所有**正在运行**的机器人都还有心跳。注意它与 HTTP 状态码是同一件事。 */
  ok: boolean;
  /** 只有"运行中且已卡住"的机器人。 */
  stale: TraderHealth[];
  /** 所有机器人（含已停止的），便于控制台一眼看到全貌。 */
  traders: TraderHealth[];
}

/**
 * 从 `traders.last_cycle_at` 推导每个机器人的决策新鲜度。
 *
 * 这个函数存在的理由只有一个：**让健康检查说真话**。
 * 原来 `/api/health` 无条件返回 `ok: true`，而 `deploy/docker-compose.yml` 与
 * `Dockerfile` 的 HEALTHCHECK 都以它为准 —— 于是一个决策循环已经挂死、
 * 或者事件循环被同步 SQLite 阻塞的进程，在编排器看来永远"健康"。
 * 没人会收到告警，容器也不会重启，而账户可能还挂着仓位。
 *
 * 三条必须守住的边界（否则这就是一个比原来更糟的检查）：
 *
 *  1. **只有 `running` 参与判定。** `safe_mode` / `error` 仍在跑循环，但它们的
 *     失败是**已经**通过状态和 `last_error` 上报过的；`stopped` 则根本不跑。
 *     把它们算成"不健康"会让一个被刻意停在原地的机器人在编排器眼里永远是坏的。
 *  2. **`starting` 不参与。** AutoTrader 先写 `starting` 再跑首轮，把它算进去
 *     等于在启动瞬间就判定失败。
 *  3. **阈值有下界（启动宽限），且基于该机器人自己的周期。** 见上面两个常量。
 *
 * 纯函数：只依赖传入的列表和 `now`，所以可以直接单测边界（见 `health.test.ts`）。
 */
export function evaluateTraderHealth(
  traderRows: readonly Pick<
    Trader,
    'id' | 'name' | 'status' | 'lastCycleAt' | 'cycleIntervalMinutes'
  >[],
  now: number,
  /**
   * 每个**正在运行**的机器人是什么时候被启动的。
   *
   * 为什么需要它而不是用进程启动时间：宽限期必须按每个机器人自己的年龄算。
   * 用一个全局的"进程已运行多久"会让运行两小时后才启动的机器人在第一轮
   * 卡死时被宽限整整 2 小时；反过来，如果按"第一次看到 null 的时间"算，
   * 一个永远跑不完第一轮的机器人每次探测都重新获得宽限，**永远不会**被判为
   * 卡住 —— 那正是这个检查要抓的情形。
   *
   * 缺省为空时退化为"用进程启动时间"，只是为了让纯函数好测。
   */
  startedAtByTrader: ReadonlyMap<number, number> = new Map(),
): HealthVerdict {
  const traders: TraderHealth[] = traderRows.map((trader) => {
    const thresholdMs = Math.max(
      Math.max(1, trader.cycleIntervalMinutes) * 60_000 * STALE_CYCLE_MULTIPLIER,
      STARTUP_GRACE_MS,
    );
    const lastCycleMs = trader.lastCycleAt ? new Date(trader.lastCycleAt).getTime() : null;
    const valid = lastCycleMs !== null && Number.isFinite(lastCycleMs);

    // Only a `running` trader is judged. See the boundary list above.
    if (trader.status !== 'running') {
      return {
        traderId: trader.id,
        name: trader.name,
        status: trader.status,
        staleForMs: valid ? now - (lastCycleMs as number) : null,
        stale: false,
        awaitingFirstCycle: false,
      };
    }

    if (!valid) {
      /*
       * Running but no completed cycle is tolerated only for the startup grace
       * period, measured from *this trader's* start. `start()` kicks the first
       * cycle off immediately, so either it finished and wrote the timestamp, or
       * it is wedged.
       */
      const startedAt = startedAtByTrader.get(trader.id);
      const runningForMs = startedAt === undefined ? null : now - startedAt;
      return {
        traderId: trader.id,
        name: trader.name,
        status: trader.status,
        staleForMs: runningForMs,
        stale: runningForMs !== null && runningForMs > thresholdMs,
        awaitingFirstCycle: true,
      };
    }

    const staleForMs = now - (lastCycleMs as number);
    return {
      traderId: trader.id,
      name: trader.name,
      status: trader.status,
      staleForMs,
      stale: staleForMs > thresholdMs,
      awaitingFirstCycle: false,
    };
  });

  const stale = traders.filter((t) => t.stale);
  return { ok: stale.length === 0, stale, traders };
}

export async function buildServer(deps: ApiDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // The console is served from the same origin in production, and Vite proxies
    // /api during development.
    trustProxy: true,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket);

  /**
   * Tolerate body-less and oddly-typed POSTs.
   *
   * Several endpoints (`/start`, `/stop`, `/run-once`, `/test`) are POSTs with
   * an optional body. Browsers omit `Content-Type` entirely when there is no
   * body, while curl and PowerShell tend to send
   * `application/x-www-form-urlencoded`; Fastify's default behaviour is to
   * reject the latter with a 415 before the route ever runs. Normalising here
   * keeps those routes callable from anything.
   */
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const error = new Error('请求体不是合法的 JSON');
      (error as { statusCode?: number }).statusCode = 400;
      done(error, undefined);
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Error handling                                                         */
  /* ---------------------------------------------------------------------- */

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) log.error(`unhandled API error: ${error.message}`, error);
    void reply.code(status).send({ error: error.message });
  });

  /** Wrap a handler so thrown errors become clean 400s with a message. */
  const guard =
    <T>(handler: (input: T, request: AuthedRequest, reply: FastifyReply) => Promise<unknown> | unknown) =>
    async (request: AuthedRequest, reply: FastifyReply) => {
      try {
        return await handler(request.body as T, request, reply);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        return reply.code(status).send({ error: (error as Error).message });
      }
    };

  /* ---------------------------------------------------------------------- */
  /*  Health + auth (unauthenticated)                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * 存活探测。
   *
   * 这个端点是**未认证**的（容器 healthcheck 必须能打它），所以它不能回显
   * 文件系统布局：此前直接返回 `dbPath`（如 `/srv/<应用目录>/data/autoquant.sqlite`），
   * 未认证的调用方由此得知操作系统、部署根目录、以及数据目录名 ——
   * 那是给后续攻击挑目标的信息，而这个端点本来就只是回答"我还活着吗"。
   *
   * 只保留文件名而不是删掉整个字段：控制台「操作员账户」页把它当作
   * 「连的是哪个库」的提示在显示（`packages/web/.../AccountSection.tsx`）。
   * 文件名足以区分实例，且不泄漏任何路径。
   */
  /*
   * Health now tells the truth, and it still answers only one question: "is this
   * process still doing its job?"
   *
   * Why it had to change: the Dockerfile and `deploy/docker-compose.yml`
   * HEALTHCHECKs both use this endpoint as their **only** signal, and it used to
   * return `ok: true` unconditionally. A trading process whose decision loop had
   * hung — or whose event loop was blocked on synchronous SQLite work — looked
   * permanently healthy to the orchestrator: no alert, no restart, while the
   * account may still be carrying open positions.
   *
   * Why a non-200 is safe here: every existing caller already checks only
   * `r.ok` (the HEALTHCHECK `fetch`) or just prints the body (`up.sh`), so the
   * 200/503 distinction breaks nothing while giving the orchestrator a way to
   * restart a wedged instance. Stopped and paused traders **never** affect the
   * status code — that would make a deliberately stopped bot permanently "bad".
   */
  app.get('/api/health', async (_request, reply) => {
    /*
     * `runningSince()` is optional at the call site on purpose.
     *
     * This is the one route whose failure takes the whole instance down in an
     * orchestrator's eyes, and it runs before anything else the process does. An
     * `ApiDependencies.manager` that predates this method — a test stub, or any
     * embedder supplying its own manager — would otherwise turn a *successful*
     * probe into a 500, which is the same "the healthcheck lies" failure this
     * endpoint was just fixed to stop producing, pointing the other way.
     *
     * Missing the map degrades instead of throwing: a running trader with no
     * completed cycle is then not judged, rather than judged wrongly.
     */
    const runningSince =
      typeof deps.manager.runningSince === 'function'
        ? deps.manager.runningSince()
        : new Map<number, number>();
    const health = evaluateTraderHealth(traders.list(), Date.now(), runningSince);
    const body = {
      ok: health.ok,
      version: '0.1.0',
      uptimeSeconds: Math.round(process.uptime()),
      hasOwner: users.count() > 0,
      dryRun: env.dryRun,
      tradingDisabled: env.globalTradingDisabled,
      environment: deps.publicConnection.environment,
      /*
       * 只回**文件名**，绝不回 `dbPath`。
       *
       * 这个端点**无需认证**（容器 healthcheck 必须能打它），所以它不能公布
       * 文件系统布局：绝对路径会同时泄漏操作系统、部署根目录与数据目录名 ——
       * 那是给后续攻击挑目标的信息，而这个端点本来就只是回答"我还活着吗"。
       * 保留字段本身是因为控制台「操作员账户」页把它当作"连的是哪个库"的提示。
       */
      db: basename(dbPath),
      /*
       * Decision freshness. Only running-and-stale traders appear here; each one
       * carries how long it has been silent so an operator does not have to read
       * the source to know what "too long" means
       * (threshold = max(cycleIntervalMinutes × 2, 300s)).
       */
      staleTraders: health.stale.map((entry) => ({
        id: entry.traderId,
        name: entry.name,
        staleForMs: entry.staleForMs,
        awaitingFirstCycle: entry.awaitingFirstCycle,
      })),
      runningTraders: health.traders.filter((entry) => entry.status === 'running').length,
    };
    if (!health.ok) {
      return reply.code(503).send({
        ...body,
        reason: `有 ${health.stale.length} 个正在运行的机器人已超过各自周期的 2 倍仍未完成一轮决策。`,
      });
    }
    return body;
  });

  /**
   * Registration is open only while the instance has no accounts: the first one
   * becomes the owner. After that, new accounts must be created by an owner.
   */
  /*
   * 注册接口已移除。
   *
   * 这个系统目前面向**单人自用**部署：首次启动自动生成管理员账号并打印一次，
   * 登录后可在「操作员账户」里自行修改用户名与密码。
   *
   * 保留一个「首个账户可自助注册」的入口意味着：任何能访问到控制台的人在
   * 数据库为空时都能把自己变成管理员 —— 而这个窗口在部署脚本还没跑完、
   * 或数据卷被误删重建时会真实出现。对单人部署来说，这个风险没有任何对应的收益。
   *
   * 这里返回明确的 410 而不是 404：如果将来有人照着旧文档去调它，
   * 应该看到「已移除、改用首次启动自动创建」这条信息，而不是一个语焉不详的 404。
   */
  /* ---------------------------------------------------------------------- */
  /*  Login throttling                                                       */
  /* ---------------------------------------------------------------------- */

  /*
   * 两个维度各一把节流器，见 `loginThrottle.ts` 里对阈值取舍的说明。
   * 计数器只在内存里，进程重启即清零：这是单人自用部署下的刻意取舍
   * （见该模块顶部注释），换来的是不引入 Redis 这类新依赖。
   */
  const usernameThrottle = new FailureThrottle(USERNAME_THROTTLE_OPTIONS);
  const ipThrottle = new FailureThrottle(IP_THROTTLE_OPTIONS);

  /*
   * 修改凭据的「当前密码」校验也要节流，但用**独立**的实例。
   *
   * 需要它：这个端点要求已登录，但"已登录"不等于"知道密码" ——
   * 令牌泄漏之后，攻击者可以拿它当在线口令预言机（每次校验同样跑 scrypt）。
   * 独立实例的理由：在这里连错几次不该把**登录**路径锁掉（反之亦然），
   * 否则一个错误的猜测就能把操作员挡在自己的控制台外面。
   */
  const accountThrottle = new FailureThrottle(USERNAME_THROTTLE_OPTIONS);
  const accountIpThrottle = new FailureThrottle(IP_THROTTLE_OPTIONS);

  /**
   * 一次登录尝试要计入的「来源」键。
   *
   * 除了 `request.ip`（`trustProxy: true` 下取自 `X-Forwarded-For`，**可被伪造**），
   * 还额外计入 TCP 层的对端地址：直连场景下攻击者能随意编造 XFF 来轮换 IP 键，
   * 但换不掉自己的出口地址。两者相同时只记一个键，避免把正常流量算两遍。
   */
  const ipThrottleKeys = (request: FastifyRequest): string[] => {
    const keys = [`ip:${request.ip}`];
    const socketAddress = request.socket.remoteAddress;
    if (socketAddress && socketAddress !== request.ip) keys.push(`sock:${socketAddress}`);
    return keys;
  };

  app.post('/api/auth/register', async (_request, reply) =>
    reply.code(410).send({
      error:
        '注册已停用。本系统面向单人部署：管理员账号在首次启动时自动创建，' +
        '凭据会打印在服务日志中；登录后可在「操作员账户」中修改用户名与密码。',
    }),
  );

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = CredentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请填写用户名与密码。' });

    const username = parsed.data.username;
    const password = parsed.data.password;
    const usernameKeys = [`user:${username.toLowerCase()}`];
    const ipKeys = ipThrottleKeys(request);

    // 先判节流、后验口令：scrypt 是刻意做得昂贵的（约几十毫秒），
    // 一个不限次数的登录端点本身就是一条 CPU 耗尽路径 ——
    // 节流器在这里既防爆破，也让每个被拒的请求几乎不花 CPU。
    const userVerdict = usernameThrottle.check(usernameKeys);
    const ipVerdict = ipThrottle.check(ipKeys);
    if (!userVerdict.allowed || !ipVerdict.allowed) {
      const retryAfterSeconds = Math.max(userVerdict.retryAfterSeconds, ipVerdict.retryAfterSeconds);
      return reply
        .header('Retry-After', String(retryAfterSeconds))
        .code(429)
        .send({ error: `登录尝试过于频繁，请在 ${retryAfterSeconds} 秒后重试。` });
    }

    const record = users.findByUsername(username);
    let passwordOk = false;
    if (record) {
      passwordOk = verifyPassword(password, record.passwordHash);
    } else {
      // 用户名不存在时**也必须**跑一遍 scrypt。
      //
      // 这里原先是 `if (!record || !verifyPassword(...))`，`||` 短路意味着
      // 未知用户名的 401 根本不派生密钥，比"密码错"快几十毫秒。
      // 那条时间差就是一个可靠的**用户名枚举预言机**：
      // 先花几毫秒问出哪些用户名存在，再对存在的那个慢慢爆破密码 ——
      // 于是 generateUsername() 随机后缀换来的优势被完全抵消。
      verifyPassword(password, DUMMY_PASSWORD_HASH);
    }

    if (!record || !passwordOk) {
      usernameThrottle.recordFailure(usernameKeys);
      ipThrottle.recordFailure(ipKeys);
      return reply.code(401).send({ error: '用户名或密码不正确。' });
    }

    usernameThrottle.recordSuccess(usernameKeys);
    ipThrottle.recordSuccess(ipKeys);

    const token = signToken(
      {
        sub: record.id,
        username: record.username,
        role: record.role,
        credAt: users.credentialsChangedAt(record.id) ?? 0,
      },
      deps.jwtSecret,
    );
    return {
      token,
      user: { id: record.id, username: record.username, role: record.role, createdAt: record.createdAt },
    };
  });

  /* ---------------------------------------------------------------------- */
  /*  Everything below requires a session                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * 令牌签名有效 ≠ 仍然有效。
   *
   * 账户改过凭据之后，此前签发的所有令牌都必须立刻作废 —— 否则"改密码"
   * 在最需要它的时候（令牌泄漏、设备丢失）救不了任何东西。
   * 判定逻辑本身是 `auth.ts` 里的纯函数，这里只负责把数据库里的当前值喂给它。
   */
  const tokenRevoked = (payload: TokenPayload): boolean =>
    isTokenRevoked(payload, users.credentialsChangedAt(payload.sub));

  const authed = { preHandler: requireAuth(deps.jwtSecret, tokenRevoked) };

  app.get('/api/auth/me', authed, async (request: AuthedRequest) => ({
    user: request.user,
  }));

  /*
   * 修改账户凭据：用户名与密码。
   *
   * 两者放在同一个端点，因为它们共享同一条安全前提：**必须验证当前密码**。
   * 只靠会话令牌就允许改密码，意味着任何一次令牌泄露（浏览器残留、日志、
   * 代理）都能被升级成永久接管 —— 攻击者改掉密码，真正的所有者就进不来了。
   *
   * 改完用户名要**重新签发令牌**：JWT 的载荷里带着用户名，
   * 不重签的话前端拿的还是旧身份，下次校验就会对不上。
   */
  const updateAccount = async (request: AuthedRequest, reply: FastifyReply) => {
    // 校验请求体再动任何东西：`currentPassword` 不是字符串时会一路走进
    // `scryptSync` 并抛出 TypeError，变成一条 500 —— 看起来像服务端坏了。
    const parsed = UpdateAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '请求内容无效。' });
    }
    const body = parsed.data;

    const record = users.findById(request.user!.sub);
    if (!record) return reply.code(404).send({ error: '找不到该账户。' });

    // 节流的键用**库里的**用户名，不用请求体里的：请求体根本没有用户名字段，
    // 而这个端点一次只能改自己的凭据。
    const accountKeys = [`acct:${record.username.toLowerCase()}`];
    const accountIpKeys = ipThrottleKeys(request);
    const accountVerdict = accountThrottle.check(accountKeys);
    const accountIpVerdict = accountIpThrottle.check(accountIpKeys);
    if (!accountVerdict.allowed || !accountIpVerdict.allowed) {
      const retryAfterSeconds = Math.max(
        accountVerdict.retryAfterSeconds,
        accountIpVerdict.retryAfterSeconds,
      );
      return reply
        .header('Retry-After', String(retryAfterSeconds))
        .code(429)
        .send({ error: `当前密码尝试过于频繁，请在 ${retryAfterSeconds} 秒后重试。` });
    }

    const full = users.findByUsername(record.username);
    if (!full || !verifyPassword(body.currentPassword, full.passwordHash)) {
      accountThrottle.recordFailure(accountKeys);
      accountIpThrottle.recordFailure(accountIpKeys);
      return reply.code(401).send({ error: '当前密码不正确。' });
    }
    accountThrottle.recordSuccess(accountKeys);
    accountIpThrottle.recordSuccess(accountIpKeys);

    const nextUsername = typeof body.username === 'string' ? body.username.trim() : undefined;
    const nextPassword = typeof body.newPassword === 'string' ? body.newPassword : undefined;

    if (nextUsername === undefined && nextPassword === undefined) {
      return reply.code(400).send({ error: '没有需要修改的内容。' });
    }

    if (nextPassword !== undefined && nextPassword.length < 8) {
      return reply.code(400).send({ error: '新密码至少需要 8 位字符。' });
    }

    if (nextUsername !== undefined) {
      if (nextUsername.length < 3 || nextUsername.length > 64) {
        return reply.code(400).send({ error: '用户名需要 3 到 64 个字符。' });
      }
      if (nextUsername !== record.username && users.findByUsername(nextUsername)) {
        return reply.code(409).send({ error: '该用户名已被占用。' });
      }
      users.updateUsername(record.id, nextUsername);
    }

    if (nextPassword !== undefined) {
      users.updatePassword(record.id, hashPassword(nextPassword));
    }

    /*
     * 凭据变更加盖时间戳，作废该账户此前签发的**所有**会话。
     *
     * 用户名也算凭据：令牌载荷里带着用户名，改完名字之后另一个浏览器里的旧会话
     * 仍然以旧身份通过校验。一次"改名"或"改密码"应当等价于"把其他设备登出"。
     *
     * 顺序很关键：必须**先**盖时间戳、**后**签发新令牌，
     * 否则新令牌带着变更前的时间戳，一签发就会被自己的撤销检查拒掉。
     */
    const credentialsChangedAt =
      nextUsername !== undefined || nextPassword !== undefined
        ? users.markCredentialsChanged(record.id)
        : (users.credentialsChangedAt(record.id) ?? 0);

    const updated = users.findById(record.id)!;
    // 用户名可能变了，重新签发令牌，否则前端拿的还是旧身份
    const token = signToken(
      {
        sub: updated.id,
        username: updated.username,
        role: updated.role,
        credAt: credentialsChangedAt,
      },
      deps.jwtSecret,
    );
    return { ok: true, token, user: updated };
  };

  app.patch('/api/auth/account', authed, updateAccount);

  /*
   * 旧端点保留为别名。
   *
   * 控制台是单页应用，浏览器可能缓存着上一版的 JS：如果直接删掉这个路由，
   * 那些页面上的「修改密码」会得到一个 404，而用户完全无从判断原因。
   * 保留成本是两行，收益是消除一类难以解释的失败。
   */
  app.post('/api/auth/password', authed, updateAccount);

  /* --- Static catalogues ------------------------------------------------- */

  app.get('/api/catalog', authed, async () => ({
    providers: LLM_PROVIDERS,
    exchanges: EXCHANGES,
    presets: STRATEGY_PRESETS,
    defaultStrategy: defaultStrategyConfig(),
  }));

  /* --- System status ----------------------------------------------------- */

  app.get('/api/system', authed, async () => ({
    dryRun: env.dryRun,
    tradingDisabled: env.globalTradingDisabled,
    environment: deps.publicConnection.environment,
    environmentLabel: deps.publicConnection.endpoints.label,
    clockOffsetMs: deps.publicConnection.clockOffsetMs,
    weightUsed: deps.publicConnection.rest.usedWeight1m,
    weightLimit: deps.publicConnection.rest.weightLimitPerMinute,
    /**
     * 并发请求占用。
     *
     * 权重预算曾经只能靠"上一份响应里的 header"约束，而每一批 `Promise.all`
     * 都在读完那个已经过期的值之后同时放行 —— 40 个请求一起出去，75% 的软上限
     * 等于不存在。现在每个请求在发出前先占一个槽位，这个字段让"当前有几个请求
     * 同时在路上"变得可见，而不是只能靠推测。
     */
    requestsInFlight: deps.publicConnection.rest.inFlightCount,
    maxRequestsInFlight: deps.publicConnection.rest.maxInFlightPerRequest,
    tradableSymbols: deps.publicConnection.registry.size,
    runningTraders: deps.manager.runningIds(),
    /**
     * 自动恢复已经放弃的机器人（`status = 'error'` 且没在运行）。
     *
     * 见 `TraderManager.resumePersisted()`：一次瞬时的启动失败以前会把机器人
     * 永久钉在 error 上，而**没有任何地方**会再提起它。现在它会被自动重试，
     * 放弃时也会留在这里 —— 这个列表就是为了让"放弃"这件事不可能被忽略。
     */
    failedTraders: deps.manager.failedTraders(),
  }));

  app.get('/api/logs', authed, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 200);
    return { logs: runtimeLogs.list(Number.isFinite(limit) ? limit : 200) };
  });

  /* --- Exchange accounts ------------------------------------------------- */

  app.get('/api/exchange-accounts', authed, async () => {
    // Balances are read from the cache here so that a polling console stays
    // cheap; the dedicated endpoint below forces a fresh read on demand.
    const balances = await deps.balance.getAll();

    return exchanges.list().map((account) => {
      const result = balances.get(account.id);
      return {
        ...publicAccount(account),
        balance: result?.ok ? result.balance : null,
        balanceError: result && !result.ok ? result.error : null,
      };
    });
  });

  /**
   * Live balance for one credential.
   *
   * `?refresh=1` bypasses the cache — an operator pressing refresh is asking for
   * "now", and serving them a stale number would be a lie.
   */
  app.get('/api/exchange-accounts/:id/balance', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!exchanges.get(id)) return reply.code(404).send({ ok: false, error: '找不到该凭据' });

    const refresh = String((request.query as { refresh?: string }).refresh ?? '') === '1';
    const result = await deps.balance.get(id, { force: refresh });
    if (!result.ok) return reply.code(200).send({ ok: false, error: result.error });
    return { ok: true, balance: result.balance, cached: result.cached };
  });

  app.post('/api/exchange-accounts', authed, guard(async (body: unknown) => {
    const parsed = ExchangeAccountInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');
    const account = exchanges.create({
      exchange: parsed.data.exchange,
      label: parsed.data.label,
      apiKey: parsed.data.apiKey,
      apiSecretEnc: deps.vault.encrypt(parsed.data.apiSecret),
      testnet: parsed.data.testnet,
      canTrade: parsed.data.canTrade,
    });
    deps.balance.invalidate(account.id);
    return publicAccount(account);
  }));

  /**
   * Test **unsaved** exchange credentials.
   *
   * Mirrors the model draft probe: the point is to find out whether a key works
   * before it is committed to the database, rather than discovering a typo from a
   * failed trading cycle later.
   */
  app.post('/api/exchange-accounts/test-draft', authed, async (request, reply) => {
    const parsed = ExchangeAccountInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, checks: [], error: '请填写完整的交易所、API Key 与 Secret。' });
    }
    try {
      const { connectExchange } = await import('../binance/bootstrap.js');
      const connection = await connectExchange({
        environment: parsed.data.testnet ? 'demo' : 'production',
        apiKey: parsed.data.apiKey,
        apiSecret: parsed.data.apiSecret,
        dryRun: true,
      });
      const checks = await preflight(connection, { requireCredentials: true });
      return { ok: checks.every((c) => c.ok || !c.blocking), checks };
    } catch (error) {
      return reply.code(400).send({ ok: false, checks: [], error: (error as Error).message });
    }
  });

  app.patch('/api/exchange-accounts/:id', authed, guard(async (body: unknown, request) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = ExchangeAccountInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');

    const patch: Parameters<typeof exchanges.update>[1] = {};
    if (parsed.data.label !== undefined) patch.label = parsed.data.label;
    if (parsed.data.apiKey !== undefined) patch.apiKey = parsed.data.apiKey;
    if (parsed.data.apiSecret) patch.apiSecretEnc = deps.vault.encrypt(parsed.data.apiSecret);
    if (parsed.data.testnet !== undefined) patch.testnet = parsed.data.testnet;
    if (parsed.data.canTrade !== undefined) patch.canTrade = parsed.data.canTrade;

    exchanges.update(id, patch);
    // The stored key may have changed, so the cached balance and REST client are
    // no longer trustworthy.
    deps.balance.invalidate(id);
    return { ok: true };
  }));

  app.delete('/api/exchange-accounts/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const inUse = exchanges.usageCount(id);
    if (inUse > 0) {
      return reply.code(409).send({
        error: `该凭据正被 ${inUse} 个机器人使用，请先删除或改派它们。`,
      });
    }
    exchanges.remove(id);
    deps.balance.invalidate(id);
    return { ok: true };
  }));

  /** Connect with the stored key and report exactly what is wrong, if anything. */
  app.post('/api/exchange-accounts/:id/test', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = exchanges.getWithSecret(id);
    if (!row) return reply.code(404).send({ error: '找不到该凭据' });

    try {
      const { connectExchange } = await import('../binance/bootstrap.js');
      const connection = await connectExchange({
        environment: row.testnet === 1 ? 'demo' : 'production',
        apiKey: row.api_key,
        apiSecret: deps.vault.decrypt(row.api_secret_enc),
        dryRun: true,
      });
      const checks = await preflight(connection, { requireCredentials: true });
      return { ok: checks.every((c) => c.ok || !c.blocking), checks };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message, checks: [] });
    }
  });

  /* --- AI models --------------------------------------------------------- */

  app.get('/api/ai-models', authed, async () =>
    aiModels.list().map((model) => {
      const row = aiModels.getWithSecret(model.id);
      let masked = '';
      if (row?.api_key_enc) {
        try {
          masked = maskSecret(deps.vault.decrypt(row.api_key_enc));
        } catch {
          masked = 'unreadable';
        }
      }
      return { ...model, apiKeyMasked: masked, hasKey: Boolean(row?.api_key_enc) };
    }),
  );

  /**
   * Ask the provider which models this key can use.
   *
   * This is the primary way the UI learns about models. A static list would go
   * stale — and a stale default fails only at runtime, once a trader is already
   * trying to make a decision.
   */
  app.post('/api/ai-models/discover', authed, async (request, reply) => {
    const parsed = DiscoverModelsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      // baseUrl 被地址白名单拒绝时要把原因说出来（"为什么不能打这个地址"），
      // 其余字段的 zod 默认提示是英文，对操作员没用 —— 保持原来的中文兜底。
      const baseUrlIssue = parsed.error.issues.find((issue) => issue.path[0] === 'baseUrl');
      return reply.code(400).send({
        ok: false,
        models: [],
        source: 'fallback',
        message: baseUrlIssue?.message ?? '参数无效。',
      });
    }

    const { discoverModels } = await import('../llm/discovery.js');
    return discoverModels({
      provider: parsed.data.provider as never,
      apiKey: parsed.data.apiKey,
      ...(parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl } : {}),
    });
  });

  /**
   * Probe an **unsaved** model configuration.
   *
   * The saved-model endpoint can only test what is already in the database, which
   * means a wrong key or a hallucinated model id could only be discovered after
   * committing it. This closes that gap.
   */
  app.post('/api/ai-models/test-draft', authed, async (request, reply) => {
    const parsed = DraftModelInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: parsed.error.issues[0]?.message ?? '参数无效。', latencyMs: 0 });
    }
    const descriptor = LLM_PROVIDERS.find((p) => p.id === parsed.data.provider);
    const baseUrl = parsed.data.baseUrl || descriptor?.baseUrl || '';
    if (!baseUrl) {
      return reply.code(400).send({ ok: false, message: '自定义提供商必须填写基础 URL。', latencyMs: 0 });
    }

    try {
      const { LlmClient } = await import('../llm/client.js');
      const defaults = providerDefaults(parsed.data.provider as never);
      const client = new LlmClient({
        provider: parsed.data.provider as never,
        apiKey: parsed.data.apiKey,
        model: parsed.data.model,
        baseUrl,
        temperature: parsed.data.temperature ?? defaults.temperature,
        maxTokens: parsed.data.maxTokens ?? defaults.maxTokens,
        // Cap the probe so a wrong endpoint fails fast instead of hanging.
        timeoutSeconds: Math.min(parsed.data.timeoutSeconds ?? defaults.timeoutSeconds, 60),
        maxRetries: 0,
      });
      return await client.testConnection();
    } catch (error) {
      return reply.code(400).send({ ok: false, message: (error as Error).message, latencyMs: 0 });
    }
  });

  app.post('/api/ai-models', authed, guard(async (body: unknown) => {
    const parsed = AiModelInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');
    const descriptor = LLM_PROVIDERS.find((p) => p.id === parsed.data.provider);
    const baseUrl = parsed.data.baseUrl || descriptor?.baseUrl || '';
    if (!baseUrl) throw new Error('自定义提供商必须填写基础 URL。');

    // Anything the user left alone falls back to the provider's own defaults, so
    // the common path really is just name + key + model id.
    const defaults = providerDefaults(parsed.data.provider as never);

    return aiModels.create({
      provider: parsed.data.provider as never,
      label: parsed.data.label,
      model: parsed.data.model,
      baseUrl,
      apiKeyEnc: deps.vault.encryptOptional(parsed.data.apiKey),
      temperature: parsed.data.temperature ?? defaults.temperature,
      maxTokens: parsed.data.maxTokens ?? defaults.maxTokens,
      timeoutSeconds: parsed.data.timeoutSeconds ?? defaults.timeoutSeconds,
      maxRetries: parsed.data.maxRetries ?? defaults.maxRetries,
    });
  }));

  app.patch('/api/ai-models/:id', authed, guard(async (body: unknown, request) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = AiModelInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');

    const patch: Parameters<typeof aiModels.update>[1] = {};
    if (parsed.data.provider !== undefined) patch.provider = parsed.data.provider as never;
    if (parsed.data.label !== undefined) patch.label = parsed.data.label;
    if (parsed.data.model !== undefined) patch.model = parsed.data.model;
    if (parsed.data.baseUrl !== undefined) patch.baseUrl = parsed.data.baseUrl;
    if (parsed.data.apiKey) patch.apiKeyEnc = deps.vault.encrypt(parsed.data.apiKey);
    if (parsed.data.temperature !== undefined) patch.temperature = parsed.data.temperature;
    if (parsed.data.maxTokens !== undefined) patch.maxTokens = parsed.data.maxTokens;
    if (parsed.data.timeoutSeconds !== undefined) patch.timeoutSeconds = parsed.data.timeoutSeconds;
    if (parsed.data.maxRetries !== undefined) patch.maxRetries = parsed.data.maxRetries;

    aiModels.update(id, patch);
    return { ok: true };
  }));

  /**
   * Strategy health check — "策略体检".
   *
   * Runs the real pipeline (live market data → real prompts → a real model call
   * → real parsing → real risk review) against a **simulated** account, so a
   * strategy can be validated before any exchange credential exists. Reports
   * each stage separately, because "the model failed" and "the risk engine
   * refused everything" both look like "the bot did nothing" from outside.
   */
  app.post('/api/strategies/:id/check', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const strategy = strategies.get(id);
    if (!strategy) return reply.code(404).send({ ok: false, error: '找不到该策略' });

    const parsed = StrategyCheckInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: '请选择一个要用于测试的 LLM 模型。' });

    const modelRow = aiModels.getWithSecret(parsed.data.aiModelId);
    if (!modelRow) return reply.code(404).send({ ok: false, error: '找不到该 AI 模型' });

    const apiKey = deps.vault.decryptOptional(modelRow.api_key_enc);
    if (!apiKey && modelRow.provider !== 'custom') {
      return reply.code(400).send({ ok: false, error: `AI 模型「${modelRow.label}」还没有配置 API Key。` });
    }

    try {
      const { LlmClient } = await import('../llm/client.js');
      const { checkStrategy } = await import('../strategy/healthCheck.js');

      const client = new LlmClient({
        provider: modelRow.provider as never,
        apiKey,
        model: modelRow.model,
        ...(modelRow.base_url ? { baseUrl: modelRow.base_url } : {}),
        temperature: modelRow.temperature,
        maxTokens: modelRow.max_tokens,
        timeoutSeconds: modelRow.timeout_seconds,
        maxRetries: modelRow.max_retries,
      });

      const result = await checkStrategy({
        config: strategy.config,
        connection: deps.publicConnection,
        client,
        ...(parsed.data.symbol ? { symbol: parsed.data.symbol.toUpperCase() } : {}),
      });

      return { ...result, strategyName: strategy.name, modelLabel: modelRow.label, model: modelRow.model };
    } catch (error) {
      log.error(`策略体检失败：${(error as Error).message}`);
      return reply.code(500).send({ ok: false, error: (error as Error).message, stages: [], sample: null });
    }
  });

  app.delete('/api/ai-models/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const inUse = aiModels.usageCount(id);
    if (inUse > 0) {
      return reply.code(409).send({ error: `该模型正被 ${inUse} 个机器人使用。` });
    }
    aiModels.remove(id);
    return { ok: true };
  }));

  /** Probe the model endpoint without starting a trader. */
  app.post('/api/ai-models/:id/test', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = aiModels.getWithSecret(id);
    if (!row) return reply.code(404).send({ error: '找不到该模型' });

    try {
      const { LlmClient } = await import('../llm/client.js');
      const client = new LlmClient({
        provider: row.provider as never,
        apiKey: deps.vault.decryptOptional(row.api_key_enc),
        model: row.model,
        ...(row.base_url ? { baseUrl: row.base_url } : {}),
        timeoutSeconds: Math.min(row.timeout_seconds, 60),
        maxRetries: 0,
      });
      const probe = await client.testConnection();
      return probe;
    } catch (error) {
      return reply.code(400).send({ ok: false, message: (error as Error).message, latencyMs: 0 });
    }
  });

  /* --- Strategies -------------------------------------------------------- */

  app.get('/api/strategies', authed, async () => strategies.list());

  app.get('/api/strategies/:id', authed, async (request, reply) => {
    const strategy = strategies.get(Number((request.params as { id: string }).id));
    if (!strategy) return reply.code(404).send({ error: '找不到该策略' });
    return strategy;
  });

  app.post('/api/strategies', authed, guard(async (body: unknown) => {
    const parsed = StrategyInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid strategy');
    return strategies.create({
      name: parsed.data.name,
      description: parsed.data.description,
      config: parsed.data.config,
      presetId: parsed.data.presetId,
    });
  }));

  app.patch('/api/strategies/:id', authed, guard(async (body: unknown, request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = StrategyInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid strategy');

    const patch: Parameters<typeof strategies.update>[1] = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.config !== undefined) patch.config = parsed.data.config;

    strategies.update(id, patch);
    const updated = strategies.get(id);
    if (!updated) return reply.code(404).send({ error: '找不到该策略' });
    return updated;
  }));

  app.delete('/api/strategies/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const inUse = strategies.usageCount(id);
    if (inUse > 0) {
      return reply.code(409).send({ error: `该策略正被 ${inUse} 个机器人使用。` });
    }
    strategies.remove(id);
    return { ok: true };
  }));

  /* --- Traders ----------------------------------------------------------- */

  app.get('/api/traders', authed, async () => {
    const running = new Set(deps.manager.runningIds());
    return traders.list().map((trader) => ({
      ...trader,
      // The live loop is the source of truth for status, not the stored value.
      status: running.has(trader.id) ? deps.manager.statusOf(trader.id) : ('stopped' as const),
      isRunning: running.has(trader.id),
    }));
  });

  app.post('/api/traders', authed, guard(async (body: unknown) => {
    const parsed = TraderInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid trader');
    const account = exchanges.get(parsed.data.exchangeAccountId);
    if (!account) throw new Error('未知的交易所账户');
    if (!aiModels.get(parsed.data.aiModelId)) throw new Error('未知的 AI 模型');
    if (!strategies.get(parsed.data.strategyId)) throw new Error('未知的策略');

    // Seed the return baseline from the exchange rather than from a typed number.
    let initialEquity = parsed.data.initialEquity ?? 0;
    let equitySource: 'exchange' | 'manual' | 'unavailable' = 'manual';
    if (initialEquity <= 0) {
      const live = await deps.balance.walletBalanceOf(account.id);
      if (live !== null && live > 0) {
        initialEquity = live;
        equitySource = 'exchange';
      } else {
        equitySource = 'unavailable';
      }
    }

    const trader = traders.create({
      name: parsed.data.name,
      exchangeAccountId: parsed.data.exchangeAccountId,
      aiModelId: parsed.data.aiModelId,
      strategyId: parsed.data.strategyId,
      cycleIntervalMinutes: parsed.data.cycleIntervalMinutes,
      initialEquity,
    });

    return { ...trader, equitySource };
  }));

  app.patch('/api/traders/:id', authed, guard(async (body: unknown, request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (deps.manager.isRunning(id)) {
      return reply.code(409).send({ error: '请先停止该机器人，再修改它的配置。' });
    }
    const parsed = TraderInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid trader');
    traders.update(id, parsed.data);
    return traders.get(id);
  }));

  app.delete('/api/traders/:id', authed, guard(async (_body: unknown, request) => {
    const id = Number((request.params as { id: string }).id);
    await deps.manager.stopTrader(id);
    traders.remove(id);
    return { ok: true };
  }));

  app.post('/api/traders/:id/start', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (env.globalTradingDisabled) {
      return reply.code(503).send({
        error: '交易已被 GLOBAL_TRADING_DISABLED 全局禁用。要启动机器人请先移除该设置。',
        preflight: [],
      });
    }
    const body = (request.body ?? {}) as { dryRun?: boolean };
    // Paper mode is the default: a real-money start must be asked for explicitly.
    const dryRun = body.dryRun ?? true;
    const result = await deps.manager.startTrader(id, dryRun);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  app.post('/api/traders/:id/stop', authed, async (request) => {
    await deps.manager.stopTrader(Number((request.params as { id: string }).id));
    return { ok: true };
  });

  /** Force one decision cycle immediately instead of waiting for the interval. */
  app.post('/api/traders/:id/run-once', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (env.globalTradingDisabled) {
      return reply.code(503).send({ error: '交易已被全局禁用。' });
    }
    try {
      const summary = await deps.manager.runCycleNow(id);
      return { ok: true, summary };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

  /**
   * Rebuild a trader's ledger from the exchange's own history.
   *
   * Deliberately **not** gated by the global trading kill switch: it places no
   * orders and only corrects the books, which is exactly what you want to be
   * able to do while trading is disabled.
   */
  app.post('/api/traders/:id/reconcile', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      const result = await deps.manager.reconcileTrader(id);
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

  /* --- Trader data ------------------------------------------------------- */

  const traderIdOf = (request: { params: unknown }): number =>
    Number((request.params as { id: string }).id);

  /**
   * Read the exchange directly for a trader's live account and positions.
   *
   * Uses a throwaway read-only connection so the console always shows what the
   * exchange actually holds, rather than our local mirror — the whole point of
   * having a reconciliation loop is that the mirror can be wrong.
   */
  const liveExchangeView = async (traderId: number) => {
    const trader = traders.get(traderId);
    if (!trader || !deps.manager.isRunning(traderId)) {
      return { live: false, account: null, positions: [], error: undefined as string | undefined };
    }
    try {
      const row = exchanges.getWithSecret(trader.exchangeAccountId);
      if (!row) return { live: false, account: null, positions: [], error: '找不到该凭据' };
      const { connectExchange } = await import('../binance/bootstrap.js');
      const connection = await connectExchange({
        environment: row.testnet === 1 ? 'demo' : 'production',
        apiKey: row.api_key,
        apiSecret: deps.vault.decrypt(row.api_secret_enc),
        dryRun: true,
      });
      const [account, livePositions] = await Promise.all([
        connection.broker.getAccountState(),
        connection.broker.getPositions(),
      ]);
      // Layer the local records (stop/target ids, peak PnL, entry reasoning) on
      // top of the exchange's truth.
      const local = positionStore.open(traderId);
      const bySymbol = new Map(local.map((p) => [p.symbol, p]));
      const positions = livePositions.map((live) => {
        const record = bySymbol.get(live.symbol);
        return {
          id: record?.id ?? 0,
          traderId,
          symbol: live.symbol,
          side: live.side,
          quantity: live.quantity,
          entryPrice: live.entryPrice,
          markPrice: live.markPrice,
          leverage: live.leverage,
          liquidationPrice: live.liquidationPrice,
          unrealizedPnl: live.unrealizedPnl,
          unrealizedPnlPercent: live.unrealizedPnlPercent,
          peakPnlPercent: record?.peak_pnl_percent ?? 0,
          marginUsed: live.marginUsed,
          notional: live.notional,
          stopLoss: record?.stop_loss ?? null,
          takeProfit: record?.take_profit ?? null,
          openedAt: record?.opened_at ?? new Date().toISOString(),
          openReasoning: record?.open_reasoning ?? '',
        };
      });
      return { live: true, account, positions, error: undefined as string | undefined };
    } catch (error) {
      return { live: false, account: null, positions: [], error: (error as Error).message };
    }
  };

  app.get('/api/traders/:id/stats', authed, async (request) => computeTraderStats(traderIdOf(request)));

  app.get('/api/traders/:id/positions', authed, async (request) => {
    const id = traderIdOf(request);
    // Prefer the exchange's own view; fall back to the local mirror when the
    // trader is stopped or the exchange is unreachable.
    const live = await liveExchangeView(id);
    if (live.positions.length > 0 || live.live) return live.positions;

    return positionStore.open(id).map((row) => ({
      id: row.id,
      traderId: row.trader_id,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      entryPrice: row.entry_price,
      markPrice: row.entry_price,
      leverage: row.leverage,
      liquidationPrice: row.liquidation_price,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      peakPnlPercent: row.peak_pnl_percent,
      marginUsed: row.margin_used,
      notional: row.quantity * row.entry_price,
      stopLoss: row.stop_loss,
      takeProfit: row.take_profit,
      openedAt: row.opened_at,
      openReasoning: row.open_reasoning,
    }));
  });

  /** Live exchange view, so the console can show truth rather than our mirror. */
  app.get('/api/traders/:id/account', authed, async (request, reply) => {
    const trader = traders.get(traderIdOf(request));
    if (!trader) return reply.code(404).send({ error: '找不到该机器人' });
    return liveExchangeView(trader.id);
  });

  app.get('/api/traders/:id/orders', authed, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 100);
    return orderStore.list(traderIdOf(request), Number.isFinite(limit) ? limit : 100);
  });

  app.get('/api/traders/:id/trades', authed, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 100);
    return tradeStore.list(traderIdOf(request), Number.isFinite(limit) ? limit : 100);
  });

  app.get('/api/traders/:id/decisions', authed, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 50);
    return decisionStore.list(traderIdOf(request), Number.isFinite(limit) ? limit : 50);
  });

  app.get('/api/traders/:id/decisions/:recordId', authed, async (request, reply) => {
    const recordId = Number((request.params as { recordId: string }).recordId);
    const record = decisionStore.get(recordId);
    if (!record || record.traderId !== traderIdOf(request)) {
      return reply.code(404).send({ error: '找不到该决策记录' });
    }
    return record;
  });

  app.get('/api/traders/:id/equity', authed, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 500);
    return equityStore.list(traderIdOf(request), Number.isFinite(limit) ? limit : 500);
  });

  /* --- Public market data ------------------------------------------------ */

  app.get('/api/market/symbols', authed, async () => {
    const registry = deps.publicConnection.registry;
    const tickers = await deps.publicConnection.market.ticker24h().catch(() => []);
    const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));
    return registry
      .all()
      .map((info) => {
        const ticker = bySymbol.get(info.symbol);
        return {
          symbol: info.symbol,
          baseAsset: info.baseAsset,
          price: Number(ticker?.lastPrice ?? 0),
          changePercent24h: Number(ticker?.priceChangePercent ?? 0),
          quoteVolume24h: Number(ticker?.quoteVolume ?? 0),
          minNotional: info.minNotional,
        };
      })
      .filter((s) => s.quoteVolume24h > 0)
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
  });

  app.get('/api/market/klines', authed, async (request, reply) => {
    const query = request.query as { symbol?: string; interval?: string; limit?: string };
    if (!query.symbol) return reply.code(400).send({ error: '缺少 symbol 参数' });
    const interval = (query.interval ?? '15m') as never;
    const limit = Math.min(Number(query.limit ?? 200) || 200, 1000);
    return deps.publicConnection.market.klines(query.symbol, interval, limit);
  });

  /* --- Live event stream ------------------------------------------------- */

  app.get('/api/events', { websocket: true }, (socket, request) => {
    // 这是**唯一**允许从查询参数取令牌的地方（浏览器的 WebSocket 构造函数
    // 无法设置请求头）。HTTP 路由一律只认 Authorization 头，见 auth.ts。
    const token = extractToken(request, { allowQueryToken: true });
    if (!token) {
      socket.close(1008, '需要登录');
      return;
    }
    const payload = verifyToken(token, deps.jwtSecret);
    if (!payload || tokenRevoked(payload)) {
      socket.close(1008, 'Invalid session');
      return;
    }

    // Replay recent history so a freshly-opened console is not blank.
    for (const event of eventBus.history(30)) socket.send(JSON.stringify(event));

    const unsubscribe = eventBus.subscribe((event: ServerEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });

    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });

  /* --- Server logs to the console ---------------------------------------- */

  setLogSink((level, scope, message) => {
    if (level === 'debug') return;
    runtimeLogs.write(null, level, scope, message);
    eventBus.publish({
      type: 'log',
      traderId: null,
      level,
      message: `[${scope}] ${message}`,
      timestamp: new Date().toISOString(),
    });
  });

  /* --- Static console ---------------------------------------------------- */

  if (existsSync(webDistDir)) {
    await app.register(fastifyStatic, { root: webDistDir });
    app.setNotFoundHandler((request, reply) => {
      // SPA fallback: client-side routes must resolve to index.html.
      if (request.url.startsWith('/api')) {
        return reply.code(404).send({ error: '接口不存在' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

/**
 * 首次启动创建管理员账号，并把凭据打印一次。
 *
 * 用户名与密码**都**可以随机生成（除非通过 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 指定）。
 * 随机用户名不是多余的：固定的 `admin` 等于把登录所需的两半信息送出去一半，
 * 安全性就只剩密码一道防线。用户登录后可以随时在「操作员账户」里改掉。
 */
export function bootstrapOwnerAccount(): {
  created: boolean;
  username?: string;
  password?: string;
} {
  if (users.count() > 0) return { created: false };

  const username = env.adminUsername || generateUsername();
  const password = env.adminPassword || generatePassword();
  users.create(username, hashPassword(password), 'owner');
  return { created: true, username, password };
}
