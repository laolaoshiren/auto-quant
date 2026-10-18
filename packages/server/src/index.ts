import { connectExchange } from './binance/bootstrap.js';
import type { BinanceEnvironment } from './binance/endpoints.js';
import { Vault } from './crypto/vault.js';
import { closeDb, initDb } from './db/index.js';
import { dbPath, ensureDataDir, env, resolveJwtSecret, resolveMasterKey } from './env.js';
import { createLogger } from './logger.js';
import { buildServer, bootstrapOwnerAccount } from './api/server.js';
import { BalanceService } from './services/balance.js';
import { TraderManager } from './trader/manager.js';
import { ROLE_GROUP_LADDERS } from './trader/routedModel.js';
import { resolveTeamGateway } from './trader/teamGateway.js';
import { contractMessages, probeGatewayContract } from './llm/gatewayContract.js';
import { runtimeLogs, strategies } from './store/repositories.js';
import { defaultStrategyConfig } from '@aq/shared';

const log = createLogger('main');

/* -------------------------------------------------------------------------- */
/*  First-run seeding                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Give a brand-new instance a usable default strategy so the console is not an
 * empty page with nothing to click.
 */
function seedDefaults(): void {
  if (strategies.list().length === 0) {
    const preset = 'conservative';
    log.info('正在创建默认策略');
    strategies.create({
      name: '默认策略 — 稳健',
      description:
        '多重信号确认、低杠杆、宽止损。可以在策略工作室中修改或复制它。',
      config: defaultStrategyConfig(),
      presetId: preset,
      isDefault: true,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  await ensureDataDir();

  /* --- Storage ---------------------------------------------------------- */
  initDb(dbPath);
  log.info(`数据库就绪：${dbPath}`);

  /* --- Secrets ---------------------------------------------------------- */
  const masterKey = await resolveMasterKey();
  const vault = new Vault(masterKey);
  const jwtSecret = await resolveJwtSecret();

  /* --- Owner account ---------------------------------------------------- */
  const owner = bootstrapOwnerAccount();
  if (owner.created) {
    // Printed exactly once: this is the only time the generated password exists
    // in plaintext anywhere.
    log.warn('='.repeat(72));
    log.warn('首次启动 —— 已创建管理员账户');
    log.warn('');
    log.warn(`  用户名：${owner.username}`);
    log.warn(`  密码：  ${owner.password}`);
    log.warn('');
    log.warn('  这组凭据只显示这一次，请立刻保存。');
    log.warn('  登录后可在「操作员账户」页面修改用户名与密码。');
    log.warn('');
    log.warn('  系统不提供注册入口 —— 管理员账号只在首次启动时创建。');
    log.warn('='.repeat(72));
    // 结构化输出一份，方便部署脚本自动抓取并展示给使用者
    log.warn(`FIRST_RUN_CREDENTIALS username=${owner.username} password=${owner.password}`);
  }

  seedDefaults();

  /* --- Public market connection (no credentials needed) ------------------ */
  const environment: BinanceEnvironment = env.binanceUseTestnet ? 'demo' : 'production';
  const publicConnection = await connectExchange({
    environment,
    dryRun: true,
    ...(process.env.BINANCE_WS_HOST ? { wsHostOverride: process.env.BINANCE_WS_HOST } : {}),
  });

  /* --- Services --------------------------------------------------------- */
  const manager = new TraderManager(vault);
  const balance = new BalanceService(vault);
  const app = await buildServer({ vault, manager, jwtSecret, publicConnection, balance });

  /* --- HTTP ------------------------------------------------------------- */
  await app.listen({ port: env.port, host: env.host });
  /*
   * ⚠️ **不回显绑定的 host。**
   *
   * 这条日志会进控制台的「数据与日志」页（登录后就能看见），而 `server.ts` 的
   * health 端点那边有一整段注释刻意避免泄漏部署布局 —— 同一个原则不该在这里反过来。
   *
   * `172.17.0.1` 单独看只是通用的 Docker 网桥地址，但它与"服务绑在容器网关上"
   * 这件事一起出现时，就是在给"下一步该打哪里"提供线索；而日志里并没有任何
   * 需要这条 host 才能完成的判断。
   *
   * **端口仍然打印** —— 那是排障时真正要用的信息，而它本身没有指向性。
   */
  log.info(`控制台已就绪（端口 ${env.port}）`);
  log.info(
    `交易环境：${publicConnection.endpoints.label}${env.dryRun ? ' | 干跑模式（DRY_RUN=true）' : ''}`,
  );
  if (env.globalTradingDisabled) {
    log.warn('已设置 GLOBAL_TRADING_DISABLED —— 任何机器人都无法启动');
  }

  /* --- Resume previously-running traders -------------------------------- */
  // Let the HTTP server settle first so the operator can see the console while
  // traders come back up.
  setTimeout(() => {
    void manager.resumePersisted(env.dryRun).catch((error) => {
      log.error(`恢复机器人失败：${(error as Error).message}`);
    });

    /*
     * Reconcile every trader's ledger against the exchange at boot.
     *
     * This runs for **stopped** traders too, which is the case that matters: the
     * way the books went wrong was a position whose exchange-side stop or target
     * fired while nothing was running, and that trader may stay stopped for days.
     * Without this pass the console would keep showing a wrong PnL for exactly as
     * long as nobody restarted it.
     *
     * Deliberately after a short delay and never fatal: reconciliation is a
     * correction, and a failure must not keep the server from serving.
     */
    setTimeout(() => {
      void manager
        .reconcileAllTraders()
        .catch((error) => log.warn(`启动对账失败：${(error as Error).message}`));
    }, 4000);

    /*
     * ══════════════════════════════════════════════════════════════════════
     *  **magpie 网关契约自检**（2026-10-18 · 用户要求"不让 magpie 更新成为包袱"）
     * ══════════════════════════════════════════════════════════════════════
     *
     * ## 为什么要有它
     *
     * 团队模式对 magpie 的依赖是 4 个非标准端点面 + 3 类自由文本契约 + 2 个内部配置文件，
     * 而 magpie **自动更新、一天多版**。真正危险的不是"网关挂了"（那会报错、看得见），
     * 而是**静默降质**：链上模型 id 悄悄失效、错误文案改了让降级判据失效、
     * `/v1/models` 字段改名让预算算不出来 —— 这三类都不会让测试变红。
     *
     * ## 三条纪律
     *
     * 1. **默认关闭**（`AQ_GATEWAY_CONTRACT=on` 才跑）—— "多打几个请求"本身是行为变化；
     * 2. **绝不阻塞启动**：延迟 60 秒、`void` 掉、任何失败只写日志；
     * 3. **零 token**：只打 GET `/v1/models` 与 `/v1/magpie/quotas`。
     *
     * ## 为什么延迟 60 秒
     *
     * 启动瞬间要做的事已经排满了（恢复机器人、对账、模型发现）。契约自检是**诊断**，
     * 它排在所有"让交易跑起来"的事情之后。
     */
    if (process.env.AQ_GATEWAY_CONTRACT === 'on') {
      setTimeout(() => {
        void runGatewayContractCheck().catch((error) => {
          log.warn(`网关契约自检失败（不影响服务）：${(error as Error).message}`);
        });
      }, 60_000);
    }
  }, 2000);

  /* --- Graceful shutdown ------------------------------------------------- */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal} 信号，正在关闭`);
    try {
      /*
       * `stopAll` waits for any cycle still in flight before returning.
       *
       * This is the whole point of the ordering: an entry can be filled and its
       * stop not yet placed, and exiting at that instant leaves the account with
       * an unprotected leveraged position (a breach of the "every entry has
       * exchange-side protection" invariant) that nothing will ever fix, because
       * the timer is gone too. The wait is bounded inside `stop()`, so a wedged
       * exchange call delays shutdown rather than hanging it permanently.
       */
      await manager.stopAll(signal);
      await app.close();
    } finally {
      closeDb();
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error(`未处理的 Promise 拒绝：${String(reason)}`);
  });
  process.on('uncaughtException', (error) => {
    /*
     * ⚠️ **stdout 断掉时不能再写日志 —— 那是一个自我递归的循环。**
     *
     * `process.stdout.write` 没有 `error` 监听，管道被关掉（日志采集器重启、
     * `docker logs` 的消费方退出）时 EPIPE 会变成 `uncaughtException` ——
     * 而处理器第一件事就是 `log.error(...)`，**又是一次 stdout 写入 → 又一次 EPIPE**。
     * 本地 `runtime_logs` 里那 **642 条完全相同的「未捕获的异常 EPIPE」**就是这个循环留下的。
     * 而 `node:sqlite` 是同步 API：这条循环会堵住跑交易循环的事件循环。
     *
     * 所以 EPIPE 单独处理：写一行到 **stderr**（那条通道还在），然后退出，
     * 交给容器的重启策略拉起一个日志通道正常的进程 ——
     * 让一个"无法记录任何东西"的交易进程继续跑，比重启更危险。
     */
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
      process.stderr.write('stdout 已断开（EPIPE）—— 退出以等待重启，避免写日志的无限递归。\n');
      process.exit(1);
    }
    log.error(`未捕获的异常：${error.message}`, error);
  });
}

/**
 * **跑一轮 magpie 网关契约自检，并把不符项写进日志。**
 *
 * ## 为什么"同一份问题 24 小时只写一次"
 *
 * 契约漂移是**持续状态**（除非有人改配置，否则每一轮探都会发现同一件事）。
 * 每 60 分钟写一条相同的 warn，会把它变成噪音 —— 而噪音的最后归宿是被忽略，
 * 那等于没有自检。所以用 `fingerprint` 去重：**问题种类变了才再写一条**。
 *
 * 去重状态放在模块级 Map 里（进程内）。重启会重置 —— 那是可接受的：
 * 重启后重新提醒一次反而是对的（有人刚动过配置）。
 */
const reportedFingerprints = new Map<string, number>();
const CONTRACT_REPORT_TTL_MS = 24 * 60 * 60 * 1000;

async function runGatewayContractCheck(): Promise<void> {
  /*
   * 网关地址与 key 从**团队模式的同一处来源**读 —— 不另立一套配置，
   * 否则"自检说没问题、而团队用的是另一个地址"这种假阴性就会出现。
   */
  const gateway = resolveTeamGateway(process.env);
  if (gateway === null) {
    log.info('[网关契约] 没有配置 magpie 网关，跳过自检。');
    return;
  }

  const report = await probeGatewayContract({
    baseUrl: gateway.baseUrl,
    apiKey: gateway.apiKey,
    ladderIds: collectLadderIds(),
  });

  const messages = contractMessages(report);
  if (messages.length === 0) {
    /*
     * ⚠️ **成功也要留一条**，但要落在可检索的地方。
     *
     * 第一版只 `log.info` —— 而 `log` 的 scope 是 `main`，写进 `runtime_logs`
     * 之后混在一堆启动日志里，排查时**根本找不到**（我实测过：grep journalctl
     * 一条都没有，因为日志通道是 `runtime_logs` 而不是 stdout）。
     *
     * ⇒ 用独立 scope `gateway_contract`，控制台的「数据与日志」页可以按 scope 过滤。
     *   `traderId = null` 表示这是全局事件（不属于某个机器人）。
     */
    runtimeLogs.write(
      null,
      'info',
      'gateway_contract',
      `[网关契约] 自检通过（${report.modelCount ?? 0} 个模型 · ${report.requests} 次请求 · ${Date.now() - report.at}ms）。`,
    );
    return;
  }

  /* 去重：同一份问题 24 小时内只写一次。 */
  const last = reportedFingerprints.get(report.fingerprint);
  const now = Date.now();
  if (last !== undefined && now - last < CONTRACT_REPORT_TTL_MS) {
    return;
  }
  reportedFingerprints.set(report.fingerprint, now);

  for (const m of messages) {
    const text = m.text;
    if (m.level === 'error') log.error(text);
    else log.warn(text);
    /* 同时进 `runtime_logs`（scope 独立），让界面能查到。 */
    runtimeLogs.write(null, m.level, 'gateway_contract', text);
  }
}

/** 收集候选链上出现的全部模型 id（去重），用于"它们还在不在"的检查。 */
function collectLadderIds(): string[] {
  const ids = new Set<string>();
  for (const ladder of Object.values(ROLE_GROUP_LADDERS)) {
    for (const id of ladder) ids.add(id);
  }
  return [...ids];
}

main().catch((error) => {
  // The logger may not be usable this early, so write straight to stderr.
  console.error('启动失败：', error);
  process.exit(1);
});
