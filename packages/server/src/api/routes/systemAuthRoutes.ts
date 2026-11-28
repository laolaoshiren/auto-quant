import type { FastifyReply, FastifyRequest } from 'fastify';
import { basename } from 'node:path';
import {
  EXCHANGES,
  LLM_PROVIDERS,
  MANAGED_RISK_PROFILES,
  STRATEGY_PRESETS,
  TIMEFRAMES,
  defaultAiTeamConfig,
  defaultStrategyConfig,
  providerDefaults,
} from '@aq/shared';
import { checkForUpdates, readAppVersion, readBuildInfo, readLocalBuildInfo } from '../../buildInfo.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPasswordAsync } from '../../crypto/vault.js';
import { dbPath, env } from '../../env.js';
import { createLogger } from '../../logger.js';
import {
  aiModels,
  runtimeLogs,
  RUNTIME_LOG_CAP,
  RUNTIME_LOG_PAGE_DEFAULT,
  settings,
  traders,
  users,
} from '../../store/repositories.js';
import { readLlmHealth } from '../../trader/manager.js';
import { signToken, type AuthedRequest } from '../auth.js';
import { evaluateTraderHealth, healthContext } from '../health.js';
import { FailureThrottle, IP_THROTTLE_OPTIONS, USERNAME_THROTTLE_OPTIONS } from '../loginThrottle.js';
import { CredentialsSchema, UpdateAccountSchema } from '../schemas.js';
import { getUnhandledRejectionCount, type RouteContext } from './context.js';

const log = createLogger('api');

export function registerSystemAuthRoutes(ctx: RouteContext): void {
  const { app, deps, authed, disconnectUserSockets } = ctx;

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
    const health = evaluateTraderHealth(traders.list(), Date.now(), runningSince, healthContext());
    const body = {
      ok: health.ok,
      /*
       * 产品版本号，取自 `package.json`。
       *
       * 原来这里是**硬编码的 `'0.1.0'`** —— 一个从写下那天起就没变过、也永远不会
       * 变的字符串。它看起来像状态，其实什么都没说：控制台「操作员账户」页那个
       * 「服务端版本」格子因此长期在骗人。
       *
       * 这个端点**无需认证**，所以它只回产品版本号，**不回 commit**：
       * 精确到提交的版本足以让攻击者去查该提交的已知缺陷，而这属于认证后才该给的
       * 信息（见 `/api/system` 的 `build` 与 `/api/system/update`）。
       */
      version: readAppVersion(),
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
        /*
         * ⚠️ **`t114` 之后必须把它带出去**：阈值是分布驱动的，**因机器人而异**
         *（`max(周期×2, 300 秒, P95×2)`）。不带出去，控制台只能干看着一个
         * "已 45 分钟没跑完"，却不知道**这一台**的阈值是多少。
         *
         * 实测缺口：加完 `thresholdMs` 之后忘了在这里放行，横幅那一行就只能显示
         * `（阈值 NaN 分钟）` —— 而类型检查**抓不到**（它是可选字段）。
         * 所以 `staleRegression.test.ts` 有一条源码守卫盯着这个映射。
         */
        thresholdMs: entry.thresholdMs,
      })),
      runningTraders: health.traders.filter((entry) => entry.status === 'running').length,
      unhandledRejections: getUnhandledRejectionCount(),
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
   * 一次登录尝试要计入的「来源 IP」键。
   *
   * `trustProxy` 已收敛为仅信任本机/内网反代：
   *   · 直连公网时 Fastify 自动忽略伪造的 XFF，`request.ip` 即对端真实 IP；
   *   · 经过受信任反代时 `request.ip` 为客户端真实 IP —— 绝不再把反代共享的
   *     `socket.remoteAddress` 混进节流键，防止未认证攻击者一键锁死管理员登录。
   */
  const ipThrottleKeys = (request: FastifyRequest): string[] => [`ip:${request.ip}`];

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
      passwordOk = await verifyPasswordAsync(password, record.passwordHash);
    } else {
      // 用户名不存在时**也必须**跑一遍 scrypt（异步走线程池，不阻塞交易事件循环）。
      await verifyPasswordAsync(password, DUMMY_PASSWORD_HASH);
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


  app.get('/api/auth/me', authed, async (request: AuthedRequest) => {
    const record = request.user ? users.findById(request.user.sub) : undefined;
    if (!record) return { user: request.user };
    return {
      user: {
        id: record.id,
        sub: record.id,
        username: record.username,
        role: record.role,
        createdAt: record.createdAt,
      },
    };
  });

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
    if (!full || !(await verifyPasswordAsync(body.currentPassword, full.passwordHash))) {
      accountThrottle.recordFailure(accountKeys);
      accountIpThrottle.recordFailure(accountIpKeys);
      /*
       * ⚠️ **必须带机器可读码**（外部 issue #148）。
       *
       * 401 在这里的意思是"**本次请求的口令填错了**"，与 `auth.ts` 里那三个
       * 401（需要登录 / 令牌过期 / 凭据变更 = "**会话结束了**"）是**完全不同的事**。
       *
       * 而前端原来只按状态码判断 → 见到 401 就清 token 跳登录页 →
       * **在设置页把当前密码输错一次就被登出**。
       *
       * 加这个码之后前端能区分两者（判据见 `packages/web/src/lib/api.ts`
       * 的 `shouldSignOut()`）。**不要改状态码**：401 对外语义是对的
       * （确实未通过认证），改成 400 会把"认证失败"与"参数错误"混在一起。
       */
      return reply
        .code(401)
        .send({ error: '当前密码不正确。', code: 'invalid_current_password' });
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

    if (nextUsername !== undefined || nextPassword !== undefined) {
      disconnectUserSockets(record.id);
    }

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
    /*
     * 创建机器人时预选哪个模型。
     *
     * 原来是"列表第一个"，而列表按 id 排 —— 于是一个**余额不足或已失效**的模型
     * 只要 id 最小，就会成为每个新机器人的默认，每次创建都要手动改回来。
     * 这里让操作员能指定，取不到就回落到第一个（与以前的行为一致）。
     */
    defaultAiModelId: (() => {
      const saved = Number(settings.get('default_ai_model_id') ?? '');
      if (Number.isFinite(saved) && saved > 0 && aiModels.get(saved)) return saved;
      return aiModels.list()[0]?.id ?? null;
    })(),
  }));

  /* --- System status ----------------------------------------------------- */

  app.get('/api/system', authed, async () => ({
    dryRun: env.dryRun,
    tradingDisabled: env.globalTradingDisabled,
    environment: deps.publicConnection.environment,
    environmentLabel: deps.publicConnection.endpoints.label,
    clockOffsetMs: deps.publicConnection.clockOffsetMs,
    weightUsed:
      typeof deps.publicConnection.rest.currentUsedWeight1m === 'function'
        ? deps.publicConnection.rest.currentUsedWeight1m()
        : deps.publicConnection.rest.usedWeight1m,
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
    /**
     * 部署版本 —— "线上跑的是哪一版"。
     *
     * 服务器上没有 `.git`（部署是打包上传），所以这份信息来自构建机随包写下的
     * `build-info.json`。**没有它时是 `null`**，而不是一个看起来正常的默认值：
     * "我不知道我跑的是哪一版"必须显示成未知。
     */
    build: readBuildInfo(),
    /** 产品版本号（`package.json`）。与上面那个是两件事，分开给。 */
    version: readAppVersion(),
  }));

  /**
   * 与远端仓库比对部署版本 —— 回答"线上是不是最新的"。
   *
   * ## 为什么单独一个端点，而不是塞进 `/api/system`
   *
   * 这一次要**出网**（GitHub API，8 秒超时）。塞进 `/api/system` 会让整页的加载
   * 被一个诊断性的可选项拖住，而 `/api/system` 是控制台每次轮询都会打的端点。
   * 单独一个端点也让它能被独立缓存与独立失败：取不到版本比对，不该影响"我现在
   * 跑在什么环境里"那一整块。
   *
   * 结果在 `checkForUpdates()` 内部缓存（成功 10 分钟、失败 1 分钟），
   * 所以反复打开这一页不会反复打 GitHub。
   */
  app.get('/api/system/update', authed, async () => checkForUpdates());

  /*
   * **当前代码版本 + 与 GitHub 的关系**（2026-11-10 用户要求）。
   *
   * 与 /api/system/update 的区别：那个比较的是**部署产物**（build-info.json）里的提交，
   * 本地开发时那是上一次部署的旧版本；这里在仓库带 .git 时读**真实 HEAD**，
   * 所以本地看到的就是"眼前这份代码"与 GitHub 的关系。
   */
  app.get('/api/system/version', authed, async () => {
    const local = readLocalBuildInfo();
    const update = await checkForUpdates(local.info);
    return {
      mode: local.source === 'git' ? 'dev' : 'deployed',
      source: local.source,
      dirty: local.dirty,
      version: readAppVersion(),
      local: local.info,
      update,
    };
  });

  app.get('/api/logs', authed, async (request) => {
    /*
     * ⚠️ **这里只做"字符串 → 数字"，钳制交给仓储层**（`runtimeLogs.list()`）。
     *
     * 原来这里写的是 `Number.isFinite(limit) ? limit : 200`，而 `1e21` **是有限数** ——
     * 它直达 SQL 的 `LIMIT ?` 后 `node:sqlite` 抛 `datatype mismatch`，
     * 整个端点变成 500（实测触发条件是 ≥1e21 或非整数）。
     * 与 `orders` 的处理保持一致：上限的钳制集中在一处，每个路由不必各写一遍。
     */
    const limit = Number((request.query as { limit?: string }).limit ?? RUNTIME_LOG_PAGE_DEFAULT);
    return { logs: runtimeLogs.list(limit) };
  });

}
