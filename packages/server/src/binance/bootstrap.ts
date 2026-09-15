import { BinanceBroker } from './broker.js';
import { resolveEndpoints, type BinanceEndpoints, type BinanceEnvironment } from './endpoints.js';
import { BinanceMarketData } from './market.js';
import { BinanceRest } from './rest.js';
import { SymbolRegistry } from './symbols.js';
import type { BinanceExchangeInfo } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('binance:bootstrap');

/* -------------------------------------------------------------------------- */
/*  Connection bundle                                                          */
/* -------------------------------------------------------------------------- */

export interface ExchangeConnection {
  environment: BinanceEnvironment;
  endpoints: BinanceEndpoints;
  rest: BinanceRest;
  market: BinanceMarketData;
  registry: SymbolRegistry;
  broker: BinanceBroker;
  /** Drift between our clock and Binance's, in milliseconds. */
  clockOffsetMs: number;
}

export interface ConnectOptions {
  environment: BinanceEnvironment;
  apiKey?: string;
  apiSecret?: string;
  dryRun?: boolean;
  /** Override the WebSocket host (testnet hosts are genuinely ambiguous). */
  wsHostOverride?: string;
}

/* -------------------------------------------------------------------------- */
/*  Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Establish and validate an exchange connection before any trading happens.
 *
 * Three things here are load-bearing rather than cosmetic:
 *
 *  1. **Clock sync runs first.** A signature whose timestamp is outside
 *     `recvWindow` is rejected with `-1021` (gateway) or `-5028` (matching
 *     engine). On testnet, `exchangeInfo.serverTime` is stale by days while
 *     `/fapi/v1/time` is accurate — so the time endpoint is the only safe
 *     source, and every signed call depends on this having run.
 *  2. **The weight budget is read from `exchangeInfo`, not hardcoded.**
 *     Testnet allows 6000 weight/minute and production 2400; guessing high on
 *     production escalates from 429 to an IP ban.
 *  3. **The symbol registry is built from the same `exchangeInfo` response**,
 *     so every order is rounded to filters the exchange actually published.
 */
export async function connectExchange(options: ConnectOptions): Promise<ExchangeConnection> {
  const endpoints = resolveEndpoints(options.environment);
  if (options.wsHostOverride) {
    endpoints.wsHost = options.wsHostOverride;
  }

  const rest = new BinanceRest({
    environment: options.environment,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.apiSecret ? { apiSecret: options.apiSecret } : {}),
  });

  // 1. Clock sync before anything signed.
  const clockOffsetMs = await rest.syncTime(true);
  log.info(
    `connected to ${endpoints.label} (clock offset ${clockOffsetMs}ms)`,
  );

  // 2 + 3. Exchange metadata: rate limits and symbol filters.
  const info = await rest.publicGet<BinanceExchangeInfo>('/fapi/v1/exchangeInfo');
  applyRateLimits(rest, info);

  const registry = SymbolRegistry.fromExchangeInfo(info);
  log.info(
    `loaded ${registry.size} tradable USDT-M perpetual contracts; weight budget ${rest.weightLimitPerMinute}/min`,
  );

  const market = new BinanceMarketData(rest);
  const broker = new BinanceBroker(rest, market, registry, {
    dryRun: options.dryRun ?? false,
  });

  return {
    environment: options.environment,
    endpoints,
    rest,
    market,
    registry,
    broker,
    clockOffsetMs,
  };
}

/**
 * Replace the hardcoded weight budget with the exchange's published limit.
 *
 * `exchangeInfo.rateLimits` carries three entries on live USDⓈ-M:
 * `REQUEST_WEIGHT/MINUTE/1` (2400 prod, 6000 testnet), `ORDERS/MINUTE/1` (1200)
 * and `ORDERS/SECOND/10` (300). Only the first governs our request pacing.
 */
function applyRateLimits(rest: BinanceRest, info: BinanceExchangeInfo): void {
  const weightLimit = info.rateLimits?.find(
    (limit) => limit.rateLimitType === 'REQUEST_WEIGHT' && limit.interval === 'MINUTE',
  );
  if (weightLimit?.limit && Number.isFinite(weightLimit.limit)) {
    rest.weightLimitPerMinute = weightLimit.limit;
  } else {
    log.warn('exchangeInfo did not publish a REQUEST_WEIGHT/MINUTE limit; keeping the default');
  }
}

/* -------------------------------------------------------------------------- */
/*  Preflight                                                                  */
/* -------------------------------------------------------------------------- */

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** True when the problem must block trading rather than merely warn. */
  blocking: boolean;
  /**
   * Display severity.
   *
   * `ok` alone cannot express "not a failure, but worth your attention" — and
   * that third state matters here. A verified case: an API key belonging to a
   * **sub-account** reports `canWithdraw: true`, which is just the permission
   * flag; a sub-account cannot withdraw to arbitrary addresses because the master
   * controls that. Rendering it as a red failure is a false alarm that trains the
   * operator to ignore the panel.
   */
  severity: 'ok' | 'warn' | 'error';
}

/** Helper so each check states its severity explicitly rather than implying it. */
function check(
  name: string,
  severity: 'ok' | 'warn' | 'error',
  detail: string,
  blocking = false,
): PreflightCheck {
  return { name, severity, ok: severity !== 'error', detail, blocking: blocking && severity === 'error' };
}

/**
 * Verify that a trader can actually trade before it is allowed to start.
 *
 * Mirrors the "launch preflight" concept: model access, exchange permissions,
 * and available balance are checked up front, so a misconfiguration surfaces as
 * a clear message instead of as a stream of failed cycles.
 */
export async function preflight(
  connection: ExchangeConnection,
  options: { requireCredentials?: boolean } = {},
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  /* --- Credentials present --------------------------------------------- */
  if (!connection.rest.hasCredentials) {
    checks.push(
      check('API 凭据', 'error', '该交易所账户还没有配置 API Key 与 Secret。', options.requireCredentials !== false),
    );
    return checks;
  }

  /* --- Account readable, and permissions ------------------------------- */
  try {
    const account = await connection.broker.getAccountState();

    checks.push(
      check(
        '账户访问',
        'ok',
        `权益 ${account.equity.toFixed(2)} USDT，可用 ${account.availableBalance.toFixed(2)} USDT。`,
      ),
    );

    checks.push(
      check(
        '交易余额',
        account.availableBalance > 0 ? 'ok' : 'error',
        account.availableBalance > 0
          ? `可用余额 ${account.availableBalance.toFixed(2)} USDT。`
          : '可用余额为 0，请先入金后再启动。',
        account.availableBalance <= 0,
      ),
    );

    /**
     * Trading permission.
     *
     * Read from `/fapi/v2/account`, which is where `canTrade` actually lives —
     * `/fapi/v1/apiTradingStatus` returns a rate-limit/indicator payload with no
     * such field, so reading it there yields `undefined`, which is falsy, which
     * reports "no futures permission" and **blocks every start**. Verified
     * against a live account after that exact false negative appeared.
     *
     * If the signal is genuinely unavailable we say so and do not block: a
     * missing capability field is not evidence of a missing permission.
     */
    const permissions = await connection.rest
      .signedRequest<{ canTrade?: boolean; canWithdraw?: boolean }>('GET', '/fapi/v2/account')
      .catch(() => null);

    if (permissions && typeof permissions.canTrade === 'boolean') {
      checks.push(
        check(
          'API Key 权限',
          permissions.canTrade ? 'ok' : 'error',
          permissions.canTrade
            ? '该 Key 具备合约交易权限。'
            : '该 Key 没有合约交易权限，请在交易所的 API 设置中开启「启用合约」。',
          !permissions.canTrade,
        ),
      );

      /*
       * Withdrawal permission is reported as a **warning**, never a failure.
       *
       * `canWithdraw` is the permission *flag*, not effective capability, and on
       * a **sub-account** it reads `true` while the master account still controls
       * whether anything can actually be withdrawn — and to which whitelisted
       * address. Reporting that as a red failure is a false alarm, and a panel
       * that cries wolf is a panel operators learn to ignore.
       *
       * The check is therefore phrased as something to confirm, not something
       * that is wrong. On a genuine main-account key it still surfaces the advice.
       */
      if (permissions.canWithdraw) {
        checks.push(
          check(
            '提现权限（请确认）',
            'warn',
            '交易所返回该 Key 的提现标志位为已开启。若这是**子账户**密钥，实际提现仍由主账户控制，通常可以忽略；' +
              '若这是**主账户**密钥，建议关闭提现权限 —— 交易机器人不需要它，开启只会扩大密钥泄露时的损失。',
          ),
        );
      } else {
        checks.push(check('提现权限', 'ok', '该 Key 未开启提现权限。'));
      }
    } else {
      checks.push(
        check('API Key 权限', 'warn', '无法从交易所读取交易权限状态，将在下单时才会暴露问题。'),
      );
    }
  } catch (error) {
    checks.push(check('账户访问', 'error', `无法读取账户：${(error as Error).message}`, true));
  }

  /* --- Position mode ---------------------------------------------------- */
  try {
    const hedge = await connection.broker.isHedgeMode();
    const positions = await connection.broker.getPositions();
    const cannotSwitch = hedge && positions.length > 0;
    checks.push(
      check(
        '持仓模式',
        cannotSwitch ? 'error' : 'ok',
        hedge
          ? positions.length === 0
            ? '账户当前是双向持仓模式，启动时将自动切换为单向持仓模式。'
            : '账户处于双向持仓模式但已有持仓，无法切换。请先清空所有持仓后重试。'
          : '账户处于单向持仓模式。',
        cannotSwitch,
      ),
    );
  } catch (error) {
    checks.push(check('持仓模式', 'warn', `无法读取持仓模式：${(error as Error).message}`));
  }

  /* --- Symbol filters loaded ------------------------------------------- */
  checks.push(
    check(
      '合约元数据',
      connection.registry.size > 0 ? 'ok' : 'error',
      `已加载 ${connection.registry.size} 个可交易合约。`,
      connection.registry.size === 0,
    ),
  );

  /* --- Clock ------------------------------------------------------------ */
  const drift = Math.abs(connection.clockOffsetMs);
  checks.push(
    check(
      '时钟同步',
      drift < 5000 ? 'ok' : drift < 60_000 ? 'warn' : 'error',
      `本机时钟与币安相差 ${connection.clockOffsetMs}ms。`,
      drift >= 60_000,
    ),
  );

  /* --- Environment warnings -------------------------------------------- */
  if (connection.endpoints.isTestnet) {
    checks.push(
      check(
        '测试环境提示',
        'warn',
        '当前运行在测试/模拟环境。其行情质量、资金费率与标记价格都与实盘不同，不要在这里校准仓位大小或滑点假设。',
      ),
    );
  }

  return checks;
}
