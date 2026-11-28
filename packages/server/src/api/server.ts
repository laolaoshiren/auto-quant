import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { hashPassword } from '../crypto/vault.js';
import { env, webDistDir } from '../env.js';
import { eventBus } from '../events.js';
import { createLogger, setLogSink } from '../logger.js';
import { runtimeLogs, users } from '../store/repositories.js';
import {
  generatePassword,
  generateUsername,
  isTokenRevoked,
  requireAuth,
  type AuthedRequest,
  type TokenPayload,
} from './auth.js';
import { isCorsOriginAllowed, parseCorsAllowedOrigins } from './corsOrigin.js';
import {
  createLiveViewCache,
  createPublicGateMarketLoader,
  idParamOf,
  type ApiDependencies,
  type RouteContext,
} from './routes/context.js';
import { registerExchangeModelRoutes } from './routes/exchangeModelRoutes.js';
import { registerMarketEventsRoutes } from './routes/marketEventsRoutes.js';
import { registerSystemAuthRoutes } from './routes/systemAuthRoutes.js';
import { registerTraderControlRoutes } from './routes/traderControlRoutes.js';
import { registerTraderDataRoutes } from './routes/traderDataRoutes.js';

// Barrel re-exports — keep all existing imports from `api/server.js` working with zero churn.
export {
  getUnhandledRejectionCount,
  idParamOf,
  publicAccount,
  recordUnhandledRejection,
  type ApiDependencies,
} from './routes/context.js';
export {
  evaluateTraderHealth,
  healthContext,
  mergeRoleLastSeen,
  parseCotTraceRoles,
  parseTeamStepLine,
  STARTUP_GRACE_MS,
  STALE_CYCLE_MULTIPLIER,
  type HealthContext,
  type HealthVerdict,
  type RoleLastSeen,
  type TraderHealth,
} from './health.js';

const log = createLogger('api');

export async function buildServer(deps: ApiDependencies): Promise<FastifyInstance> {
  /*
   * ⚠️ **收敛 `trustProxy` 信任边界（2026-11-23 P0 DoS 修复）**。
   *
   * 原先设为 `trustProxy: true`（信任任意公网来源的 XFF），为了防直连伪造 XFF 又把
   * `socket.remoteAddress` 加进了登录节流键；结果在反向代理（nginx / 容器网桥）后面，
   * 全部流量共享同一个 `sock:127.0.0.1`，攻击者 20 次错密码就能锁死全站管理员登录。
   *
   * 只信任本机与私有网段反代（`loopback` / `linklocal` / `uniquelocal`）：
   *   · 反代后：Fastify 解析反代写入的客户端真实 IP 作为 `request.ip`，不再锁反代出口；
   *   · 公网直连：非信任来源的 `X-Forwarded-For` 会被 Fastify 忽略，`request.ip` 就是真实对端。
   */
  const trustProxyRaw = process.env.AQ_TRUST_PROXY?.trim();
  const trustProxy: boolean | string[] | ((address: string, hop: number) => boolean) = (() => {
    if (!trustProxyRaw) return ['loopback', 'linklocal', 'uniquelocal'];
    const lower = trustProxyRaw.toLowerCase();
    if (lower === 'false') return false;
    if (lower === 'true') return true;
    if (/^\d+$/.test(trustProxyRaw)) {
      const hops = Number(trustProxyRaw);
      return (_address: string, hop: number) => hop <= hops;
    }
    const list = trustProxyRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : ['loopback', 'linklocal', 'uniquelocal'];
  })();

  const app = Fastify({
    logger: false,
    trustProxy,
  });

  const extraCorsOrigins = parseCorsAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
  await app.register(cors, {
    delegator: (req, callback) => {
      const origin = req.headers.origin;
      const requestHost = req.host || req.headers.host || null;
      const allowed = isCorsOriginAllowed(origin, {
        requestHost,
        extraAllowedOrigins: extraCorsOrigins,
      });
      callback(null, { origin: allowed, credentials: true });
    },
  });
  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024,
    },
  });

  /**
   * **基础安全响应头**（审计 2026-11-10）。
   *
   * 这个控制台能下单、平仓、删凭据 —— 也就是说，一次**点击劫持**就能让操作员
   * 在不知情的情况下点掉一个仓位。而在此之前，所有响应都没有任何安全头：
   *
   * ```
   *   缺 X-Frame-Options       → 攻击者可以把控制台放进 iframe 叠一层假界面
   *   缺 X-Content-Type-Options → 浏览器可能把 JSON 当 HTML/脚本嗅探执行
   *   缺 Referrer-Policy        → 令牌虽在 Authorization 头里，但 URL 仍可能外泄
   * ```
   *
   * 三个都是低风险、零功能影响的响应头，所以放在应用级 `onSend` 上对
   * **所有**响应生效（含静态文件与 SPA 回落），而不是逐个路由加。
   *
   * `SAMEORIGIN` 而不是 `DENY`：同源 iframe（若有）不应被误伤，而跨站嵌入
   * ——也就是点击劫持的载体——被挡住。
   *
   * ⚠️ **没有加 CSP**：Vite 构建产物里是否有 inline script/style 需要在真实
   * 浏览器里逐个页面验证，而一个过紧的 CSP 会让控制台白屏。那属于"要实测才能
   * 声称能用"的改动，先留在审计报告里，不在本轮凭空加。
   */
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('x-content-type-options')) {
      reply.header('X-Content-Type-Options', 'nosniff');
    }
    if (!reply.hasHeader('x-frame-options')) {
      reply.header('X-Frame-Options', 'SAMEORIGIN');
    }
    if (!reply.hasHeader('referrer-policy')) {
      reply.header('Referrer-Policy', 'no-referrer');
    }
    return payload;
  });

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
    if (status >= 500) {
      log.error(`unhandled API error: ${error.message}`, error);
      void reply.code(status).send({ error: '服务器内部错误，请稍后重试' });
      return;
    }
    void reply.code(status).send({ error: error.message });
  });

  /** `:id` 路由参数的读取入口（解析与拒绝逻辑见 `idParamOf`）。 */
  const idOf = (request: AuthedRequest): number => idParamOf(request.params);

  /** Wrap a handler so thrown errors become clean 400s with a message. */
  const guard =
    <T>(handler: (input: T, request: AuthedRequest, reply: FastifyReply) => Promise<unknown> | unknown) =>
    async (request: AuthedRequest, reply: FastifyReply) => {
      try {
        return await handler(request.body as T, request, reply);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        if (status >= 500) {
          log.error(`unhandled API error: ${(error as Error).message}`, error);
          return reply.code(status).send({ error: '服务器内部错误，请稍后重试' });
        }
        return reply.code(status).send({ error: (error as Error).message });
      }
    };


  /* ---------------------------------------------------------------------- */
  /*  Everything below requires a session                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * 令牌签名有效 ≠ 仍然有效。
   *
   * 1) 必须核实账户仍存在于库中（避免已删除账户的旧令牌因为 `credentialsChangedAt === null` 绕过撤销）；
   *    注意：首次安装尚未改过密码的账户其 `credentials_changed_at` 为 `NULL`，绝不可单凭 `null` 判撤销。
   * 2) 账户改过凭据之后，此前签发的所有令牌都必须立刻作废 —— 否则"改密码"
   *    在最需要它的时候（令牌泄漏、设备丢失）救不了任何东西。
   */
  const tokenRevoked = (payload: TokenPayload): boolean => {
    if (!users.findById(payload.sub)) return true;
    return isTokenRevoked(payload, users.credentialsChangedAt(payload.sub));
  };

  /** 已认证的活跃 WebSocket 连接（按 userId 分组），凭据变更时立刻踢断旧连接。 */
  const activeWsClients = new Map<number, Set<() => void>>();
  const disconnectUserSockets = (userId: number): void => {
    const closers = activeWsClients.get(userId);
    if (!closers) return;
    for (const close of [...closers]) {
      close();
    }
  };

  const authed = { preHandler: requireAuth(deps.jwtSecret, tokenRevoked) };


  const routeCtx: RouteContext = {
    app,
    deps,
    authed,
    idOf,
    guard,
    tokenRevoked,
    activeWsClients,
    disconnectUserSockets,
    liveView: createLiveViewCache(deps),
    getPublicGateMarket: createPublicGateMarketLoader(),
  };

  registerSystemAuthRoutes(routeCtx);
  registerExchangeModelRoutes(routeCtx);
  registerTraderControlRoutes(routeCtx);
  registerTraderDataRoutes(routeCtx);
  registerMarketEventsRoutes(routeCtx);

  /* --- Server logs to the console ---------------------------------------- */

  /*
   * 全局日志落盘与推送。**这是日志进入数据库与前端事件的唯一入口。**
   *
   * 交易循环（`AutoTrader.emit`）不再自己写库与推事件，而是通过 `meta` 把
   * 归属交过来 —— 原先两边各写一次，一条日志就变成两条记录加两个事件，
   * 界面上同一句话出现两遍。
   *
   * `meta.traderId` 存在时：记录归属该机器人，`message` 用 `meta.raw`
   * （不带机器人名前缀 —— 归属已经由 `trader_id` 表达，名字不必再写一遍）。
   * 不存在时：是服务器级日志，`trader_id` 留空，并按 `[scope]` 加前缀区分来源。
   */
  /*
   * ── 把日志 meta 里几个"诊断必需"的字段拼成短尾巴 ────────────────────────
   *
   * `runtime_logs` 只有 `message` 一列（没有 meta 列，加列要迁移，而它是环形缓冲，
   * 收益不值）。所以关键上下文只能拼进正文。
   *
   * ⚠️ **只挑必需字段**，不把整个 meta 序列化：
   * 那会把提示词、响应体之类的大对象也塞进日志，既撑爆环形缓冲，又可能泄露内容。
   *
   * ⚠️ **值要截断到 60 字符**：模型 id 可能很长（`group/auto-xxx`），
   * 而错误信息可能带整段 HTML。截断保长度可控。
   */
  const diagnosticTail = (meta: Record<string, unknown>): string => {
    const picked: string[] = [];
    const add = (key: string): void => {
      const v = meta[key];
      if (v === undefined || v === null) return;
      if (typeof v === 'string') {
        const s = v.trim();
        if (s === '') return;
        picked.push(`${key}=${s.length > 60 ? `${s.slice(0, 60)}…` : s}`);
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        picked.push(`${key}=${String(v)}`);
      }
    };
    /* 顺序即重要性：先说"哪个模型"，再说"什么错"。 */
    for (const key of ['model', 'provider', 'status', 'kind', 'attempt', 'elapsedMs', 'error']) {
      add(key);
    }
    return picked.join(' ');
  };

  setLogSink((level, scope, message, meta) => {
    if (level === 'debug') return;
    const m = (meta ?? {}) as { traderId?: number; raw?: string };
    const traderId = typeof m.traderId === 'number' ? m.traderId : null;
    const text = traderId !== null && typeof m.raw === 'string' ? m.raw : message;
    /*
     * ⚠️⚠️ **把关键结构化上下文补进正文**（2026-10-18 修）
     *
     * ## 事故
     *
     * `llm/client.ts` 记录失败时是这样调的：
     * ```ts
     * log.error(`${this.provider} 的模型调用失败 —— 这类错误不会因重试而成功`, {
     *   provider, model, attempt, status, kind, retryable, elapsedMs, error,
     * });
     * ```
     * 而这条 sink **只从 meta 里读 `traderId` 和 `raw`**，其余全部丢弃。
     * 再加上 `runtime_logs` 表只有 `message` 列、没有 meta 列 ⇒
     * **落库的正文只有「custom 的模型调用失败」，看不到是哪个模型、什么状态码。**
     *
     * 实测后果：近 2 小时 83 条 `llm` error，全部长得一模一样，
     * 想回答"哪个模型在挂"时**查不到** —— 只能看到"出事了 83 次"。
     *
     * 同一个教训在本仓库已经出现过一次（`errors.ts` 里那条
     * 「模型不可用：deepseek-flash」）：**日志要能回答"是哪个"，
     * 否则它只能回答"出事了"。**
     *
     * ## 做法
     *
     * 不新增数据库列（那要迁移，且 `runtime_logs` 是环形缓冲，收益不值）。
     * 改为在写库/推事件时，把几个**诊断必需的**字段拼成一个短尾巴：
     * ```
     *   custom 的模型调用失败 —— 这类错误不会因重试而成功
     *     ｜model=group/auto-glm-5-3 status=400 kind=bad_request
     * ```
     *
     * ⚠️ **只挑必需字段**（model / status / kind / attempt / elapsedMs）。
     * 不把整个 meta 序列化进去 —— 那会把提示词、响应体之类的大对象也塞进日志，
     * 既撑爆环形缓冲，又可能泄露内容。
     */
    const diag = diagnosticTail(m);
    const withDiag = diag === '' ? text : `${text} ｜${diag}`;
    runtimeLogs.write(traderId, level, scope, withDiag);
    eventBus.publish({
      type: 'log',
      traderId,
      level,
      /*
       * ⚠️ **不再把 `[scope]` 拼进正文。**
       *
       * 原来这里是 `message: traderId === null ? `[${scope}] ${message}` : text`，
       * 于是界面上显示 `[binance:bootstrap] loaded 528 tradable …` ——
       * **机器码出现在给人看的文本里**。
       *
       * 拼进去之后界面就再也分不出哪段是来源、哪段是正文，
       * 连"把来源翻译成中文"都做不到。所以来源单独传，
       * 由展示层翻译（`logScopeLabel`）。原始码完整保留，筛选靠它。
       */
      message: withDiag,
      scope,
      timestamp: new Date().toISOString(),
    });
  });

  /* --- Static console ---------------------------------------------------- */

  if (existsSync(webDistDir)) {
    /*
     * ⚠️ **缓存策略必须显式设置 —— 否则"改好了用户却还看到旧的"。**
     *
     * ## 为什么（2026-10-07 实测踩到）
     *
     * 用户报「页面 BUG 还在」，而线上产物里**确实已经包含修复**
     * （`TraderPage-*.js` 里能搜到新代码、磁盘上旧 chunk 已删）。
     * 问题出在 `index.html` 被浏览器缓存了：它引用的是**懒加载 chunk 的文件名**，
     * 而 chunk 名带 hash、每次构建都变 —— 于是"缓存住的 index.html + 已消失的旧 chunk"
     * 让页面停在旧版本上。用户只能靠 Ctrl+F5 才能看到修复。
     *
     * ## 规则
     *
     *  · `index.html` —— **每次都回源验证**（`no-cache` 不等于不缓存，而是必须先问服务器）。
     *    它是"版本指针"，必须永远是最新的。
     *  · `assets/*` —— 文件名**带内容 hash**，内容一变文件名就变，所以可以**永久缓存**。
     *    这既快又不会出现陈旧内容（陈旧的那个文件名已经不存在了）。
     *
     * 这套组合是标准做法：**入口不缓存、指纹资源永久缓存**。
     * 它同时消掉了"每次部署都要用户手动硬刷新"和"白下载没变的资源"两个问题。
     */
    await app.register(fastifyStatic, { root: webDistDir });
    /*
     * 缓存策略统一在这里下发（`@fastify/static` 的 `setHeaders` 选项在这版类型里
     * 不被接受，而 `onSend` 钩子对静态文件同样生效、类型也干净）。
     */
    app.addHook('onSend', async (request, reply, payload) => {
      const url = request.url.split('?')[0] ?? '';
      if (url.includes('/assets/')) {
        /* 文件名带内容 hash：内容一变名字就变，可以永久缓存。 */
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        /*
         * 其余（`index.html` 与 SPA 回落到它的那些前端路由）都是**版本指针**，
         * 必须每次回源验证 —— 否则"改好了用户却还看到旧页面"。
         */
        reply.header('Cache-Control', 'no-cache, must-revalidate');
      }
      return payload;
    });
    app.setNotFoundHandler((request, reply) => {
      // SPA fallback: client-side routes must resolve to index.html.
      if (request.url.startsWith('/api')) {
        return reply.code(404).send({ error: '接口不存在' });
      }
      reply.header('Cache-Control', 'no-cache, must-revalidate');
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

