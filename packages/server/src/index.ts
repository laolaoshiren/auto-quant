import { connectExchange } from './binance/bootstrap.js';
import type { BinanceEnvironment } from './binance/endpoints.js';
import { Vault } from './crypto/vault.js';
import { closeDb, initDb } from './db/index.js';
import { dbPath, ensureDataDir, env, resolveJwtSecret, resolveMasterKey } from './env.js';
import { createLogger } from './logger.js';
import { buildServer, bootstrapOwnerAccount } from './api/server.js';
import { BalanceService } from './services/balance.js';
import { TraderManager } from './trader/manager.js';
import { strategies } from './store/repositories.js';
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
    log.warn('首次启动 —— 已创建 owner 账户');
    log.warn('  用户名：admin');
    log.warn(`  密码：${owner.password}`);
    log.warn('  登录后请立即修改密码。此密码只显示这一次。');
    log.warn('='.repeat(72));
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
  log.info(`控制台地址：http://${env.host}:${env.port}`);
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
  }, 2000);

  /* --- Graceful shutdown ------------------------------------------------- */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal} 信号，正在关闭`);
    try {
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
    log.error(`未捕获的异常：${error.message}`, error);
  });
}

main().catch((error) => {
  // The logger may not be usable this early, so write straight to stderr.
  console.error('启动失败：', error);
  process.exit(1);
});
