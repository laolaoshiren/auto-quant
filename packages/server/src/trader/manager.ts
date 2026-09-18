import { StrategyConfigSchema, type StrategyConfig, type TraderStatus } from '@aq/shared';
import { connectExchange, preflight, type ExchangeConnection, type PreflightCheck } from '../binance/bootstrap.js';
import type { BinanceEnvironment } from '../binance/endpoints.js';
import { BinanceUserDataStream } from '../binance/ws.js';
import type { Vault } from '../crypto/vault.js';
import { createLogger } from '../logger.js';
import { MarketDataService } from '../market/service.js';
import { LlmClient } from '../llm/client.js';
import { aiModels, equity, exchanges, runtimeLogs, strategies, traders } from '../store/repositories.js';
import { eventBus } from '../events.js';
import { checkConfigReachability } from '../risk/reachability.js';
import { AgentRuntime } from './agent/runtime.js';
import { AutoTrader, type DecisionModel } from './autoTrader.js';

const log = createLogger('manager');

/**
 * 开机恢复的重试节奏（F2 + F4）。
 *
 * 为什么需要重试：`startTrader()` 的失败以前是**终局**的。启动时一次网络抖动、
 * 一次 LLM 提供商的 5xx、一次交易所 503，就把机器人写成 `error`，
 * 而 `resumePersisted()` 只恢复 `running` / `safe_mode` —— 于是它**永远**
 * 停在 error 上，静默地什么都不做，直到有人注意到控制台并手动点一次启动。
 * 一个"必须无人值守跑几周"的系统不能有这种闩锁。
 *
 * 为什么是这几个数：
 *  · 第一次尝试不等待 —— 绝大多数启动是正常的，冒烟路径不能变慢。
 *  · 退避 5s → 15s → 45s → 90s（上限 90s）。单次失败最常见的成因（DNS 抖动、
 *    网关 502）在十几秒内就会自愈，所以早期退避要短；而一次失败的 LLM/交易所
 *    调用本身可能已经等了 15–120s，所以上限不宜太小，否则总预算被一次慢失败吃掉。
 *  · 4 次重试 / 约 2.5 分钟的总预算。它必须**明显短于**最短的合法
 *    `cycleIntervalMinutes`（schema 允许的最小值是 1 分钟）乘以一个"人还能忍"的
 *    倍数，否则"启动中"会变成一种新的静默状态；同时它又要长到能穿过一次
 *    分钟级的提供商抽风。
 */
const BOOT_RETRY_BACKOFF_MS = [5_000, 15_000, 45_000, 90_000];

/**
 * 这些启动失败**不重试**：重试改变不了结果，只会让"机器人起不来"这件事
 * 延迟几分钟才浮出水面，并在此期间反复把同样的错误发进日志和事件流。
 *
 * 判据是"人需要做点什么"：填凭据、入金、改配置。
 */
const PERMANENT_START_FAILURES = [
  /还没有配置 API Key/,
  /还没有存储 API Key/,
  /没有合约交易权限/,
  /可用余额为 0/,
  /找不到交易所账户/,
  /找不到策略/,
  /找不到 AI 模型/,
  /找不到机器人/,
  /还没有配置/,
];

function isPermanentStartFailure(message: string): boolean {
  return PERMANENT_START_FAILURES.some((pattern) => pattern.test(message));
}

/* -------------------------------------------------------------------------- */
/*  Manager                                                                    */
/* -------------------------------------------------------------------------- */

export interface StartResult {
  ok: boolean;
  error?: string;
  preflight: PreflightCheck[];
}

/**
 * Owns the lifecycle of every running trader.
 *
 * Each trader gets its own exchange connection, market-data cache and model
 * client, so one trader's rate-limit pressure or provider outage cannot degrade
 * another's decisions. Stopping is always clean: the loop is cleared and any
 * partially-open state is left for the next start to reconcile.
 */
export class TraderManager {
  private readonly running = new Map<number, AutoTrader>();
  private readonly connections = new Map<number, ExchangeConnection>();
  private readonly userStreams = new Map<number, BinanceUserDataStream>();
  private stopping = false;
  /**
   * 被明确取消启动的机器人（操作员点了停止、或进程正在关闭）。
   *
   * 开机恢复会在退避后重试启动，而"点了停止"是比"我想让它跑"更强的意图：
   * 没有这个集合时，`stopTrader()` 之后退避到期的重试仍然会把机器人拉起来。
   */
  private readonly cancelledStarts = new Set<number>();
  /**
   * 每个正在运行的机器人是什么时候被启动的（本地时钟）。
   *
   * 给 `/api/health` 用：一个已经跑起来但还没写 `last_cycle_at` 的机器人，
   * 它的启动宽限期必须从**它自己**启动那一刻算起。用一个全局的「进程已运行多久」
   * 会让运行两小时后才启动的机器人在卡死时被白白宽限两小时；按「第一次看到
   * null」算则更糟 —— 一个永远跑不完第一轮的机器人每次探测都能重新获得宽限，
   * 于是**永远不会**被判为卡住，而它恰恰是这个检查要抓的东西。
   */
  private readonly startedAt = new Map<number, number>();

  constructor(private readonly vault: Vault) {}

  /**
   * Subscribe to the exchange's user-data stream for alerting.
   *
   * Deliberately **advisory only**: it logs and surfaces events but never trades.
   * All position state is still derived from the REST reconciliation that runs
   * every cycle, so a dropped or mis-routed socket cannot silently desynchronise
   * the bot — it can only delay a notification. That separation is what makes it
   * safe to attach a streaming dependency to a system that must run unattended.
   */
  private async startUserStream(traderId: number, connection: ExchangeConnection): Promise<void> {
    if (!connection.rest.hasCredentials) return;

    const emit = (level: 'info' | 'warn' | 'error', message: string): void => {
      runtimeLogs.write(traderId, level, 'binance:userdata', message);
      eventBus.publish({
        type: 'log',
        traderId,
        level,
        message,
        timestamp: new Date().toISOString(),
      });
    };

    const stream = new BinanceUserDataStream(connection.rest, connection.endpoints, {
      onMarginCall: (event) => {
        const detail = event.p
          .map((p) => `${p.s} ${p.ps} 数量=${p.pa} 维持保证金=${p.mm}`)
          .join('; ');
        emit(
          'error',
          `收到追加保证金通知（MARGIN CALL）——账户已接近强平。钱包余额 ${event.cw}。持仓：${detail}`,
        );
      },
      onOrderUpdate: (event) => {
        const o = event.o;
        // Only surface the transitions an operator cares about; the REST loop
        // remains the source of truth for fills.
        if (o.X === 'FILLED' || o.X === 'CANCELED' || o.X === 'EXPIRED') {
          emit('info', `订单 ${o.s} ${o.S} ${o.o} ${o.X} 数量=${o.z}@${o.ap}`);
        }
      },
      onListenKeyExpired: () => {
        emit('warn', '用户数据流的 listenKey 已过期，已重新创建并重连。');
      },
      onReconnected: (reason) => {
        emit(
          'info',
          `用户数据流已重连（${reason}）。持仓状态会在下一轮决策时对账。`,
        );
      },
      onAccountConfigUpdate: (event) => {
        if (event.ac) emit('info', `${event.ac.s} 的杠杆已调整为 ${event.ac.l}x`);
      },
    });

    try {
      await stream.start();
      this.userStreams.set(traderId, stream);
      emit('info', '已订阅交易所用户数据流（订单、持仓与保证金告警）。');
    } catch (error) {
      // Alerting is a nice-to-have; never let it block a trader from starting.
      log.warn(`无法启动用户数据流：${(error as Error).message}`);
      emit('warn', `无法订阅用户数据流：${(error as Error).message}`);
    }
  }

  isRunning(traderId: number): boolean {
    return this.running.has(traderId);
  }

  runningIds(): number[] {
    return [...this.running.keys()];
  }

  /** 正在运行的机器人的启动时刻，供健康检查计算启动宽限期。 */
  runningSince(): ReadonlyMap<number, number> {
    return this.startedAt;
  }

  statusOf(traderId: number): TraderStatus {
    return this.running.get(traderId)?.currentStatus ?? 'stopped';
  }

  /** Resolve an exchange account into a live connection, reusing it if present. */
  private async connectionFor(
    traderId: number,
    exchangeAccountId: number,
    dryRun: boolean,
  ): Promise<ExchangeConnection> {
    const existing = this.connections.get(traderId);
    if (existing) return existing;

    const account = exchanges.getWithSecret(exchangeAccountId);
    if (!account) throw new Error(`找不到交易所账户 ${exchangeAccountId}`);

    const apiKey = account.api_key;
    const apiSecret = this.vault.decrypt(account.api_secret_enc);

    const environment: BinanceEnvironment = account.testnet === 1 ? 'demo' : 'production';

    const connection = await connectExchange({
      environment,
      apiKey,
      apiSecret,
      dryRun,
      ...(process.env.BINANCE_WS_HOST ? { wsHostOverride: process.env.BINANCE_WS_HOST } : {}),
    });

    this.connections.set(traderId, connection);
    return connection;
  }

  /**
   * Build the model client for a trader and confirm it actually answers.
   *
   * The probe is deliberately part of start-up: a rejected API key would
   * otherwise only surface as a failed trading cycle every N minutes, which is
   * a slow and confusing way to learn that a key is wrong.
   */
  private async buildModel(aiModelId: number): Promise<{ client: LlmClient; config: ReturnType<typeof aiModels.get> }> {
    const row = aiModels.getWithSecret(aiModelId);
    if (!row) throw new Error(`找不到 AI 模型 ${aiModelId}`);

    const apiKey = this.vault.decryptOptional(row.api_key_enc);
    if (!apiKey && row.provider !== 'custom') {
      throw new Error(`AI 模型「${row.label}」还没有存储 API Key`);
    }

    const client = new LlmClient({
      provider: row.provider as never,
      apiKey,
      model: row.model,
      ...(row.base_url ? { baseUrl: row.base_url } : {}),
      temperature: row.temperature,
      maxTokens: row.max_tokens,
      timeoutSeconds: row.timeout_seconds,
      maxRetries: row.max_retries,
    });

    const probe = await client.testConnection();
    if (!probe.ok) {
      throw new Error(`AI 模型「${row.label}」无法访问：${probe.message}`);
    }
    log.info(
      `AI 模型「${row.label}」（${row.provider}/${row.model}）响应正常，耗时 ${probe.latencyMs}ms`,
    );

    return { client, config: aiModels.get(aiModelId) };
  }

  /* ---------------------------------------------------------------------- */
  /*  Start / stop                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Start one trader, optionally retrying a **transient** failure with backoff.
   *
   * Retrying lives here rather than in `resumePersisted()` so there is exactly one
   * retry loop in the lifecycle: the boot path and any future automatic caller get
   * the same policy, and an operator-initiated start stays instant because the
   * operator is present and can see the error themselves.
   */
  async startTrader(
    traderId: number,
    dryRun: boolean,
    options: { retryTransient?: boolean } = {},
  ): Promise<StartResult> {
    const trader = traders.get(traderId);
    if (!trader) return { ok: false, error: `找不到机器人 ${traderId}`, preflight: [] };

    if (this.running.has(traderId)) {
      return { ok: false, error: '该机器人已经在运行中', preflight: [] };
    }

    this.stopping = false;
    const retry = options.retryTransient === true;

    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.attemptStart(traderId, trader, dryRun);
      if (outcome.result.ok) return outcome.result;

      const message = outcome.result.error ?? '未知错误';
      const canRetry =
        retry &&
        !outcome.permanent &&
        !this.cancelledStarts.has(traderId) &&
        !this.stopping &&
        attempt < BOOT_RETRY_BACKOFF_MS.length;

      if (!canRetry) return outcome.result;

      const waitMs = BOOT_RETRY_BACKOFF_MS[attempt] ?? 90_000;
      log.warn(
        `机器人 ${traderId} 启动失败（第 ${attempt + 1} 次）：${message}；${Math.round(waitMs / 1000)}s 后重试`,
      );
      runtimeLogs.write(
        traderId,
        'warn',
        'manager',
        `启动失败，${Math.round(waitMs / 1000)} 秒后自动重试（第 ${attempt + 1}/${BOOT_RETRY_BACKOFF_MS.length} 次）：${message}`,
      );
      await this.waitForRetry(waitMs, traderId);
      if (this.cancelledStarts.has(traderId) || this.stopping) return outcome.result;
    }
  }

  /**
   * 等待下一次重试，但**可以被取消**。
   *
   * 用 1 秒的短切片而不是一次 `setTimeout(waitMs)`：退避最长 90 秒，
   * 而中间任何时刻操作员都可能点"停止"或进程收到 SIGTERM。一次性的长
   * 定时器会让这两个信号都要等满退避才生效 —— 期间机器人还会被启动起来。
   */
  private async waitForRetry(waitMs: number, traderId: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (this.stopping || this.cancelledStarts.has(traderId)) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
    }
  }

  private async attemptStart(
    traderId: number,
    trader: NonNullable<ReturnType<typeof traders.get>>,
    dryRun: boolean,
  ): Promise<{ result: StartResult; permanent: boolean }> {
    const checks: PreflightCheck[] = [];

    try {
      /* --- Connection + preflight --------------------------------------- */
      const connection = await this.connectionFor(traderId, trader.exchangeAccountId, dryRun);
      const connectivity = await preflight(connection, { requireCredentials: !dryRun });
      checks.push(...connectivity);

      const blocking = connectivity.filter((c) => !c.ok && c.blocking);
      if (blocking.length > 0) {
        this.connections.delete(traderId);
        const message = blocking.map((c) => `${c.name}: ${c.detail}`).join(' ');
        traders.setStatus(traderId, 'error', message);
        return {
          result: { ok: false, error: message, preflight: checks },
          permanent: isPermanentStartFailure(message),
        };
      }

      /* --- Strategy ----------------------------------------------------- */
      const strategyRecord = strategies.get(trader.strategyId);
      if (!strategyRecord) throw new Error(`找不到策略 ${trader.strategyId}`);
      const parsed = StrategyConfigSchema.safeParse(strategyRecord.config);
      const config: StrategyConfig = parsed.success ? parsed.data : StrategyConfigSchema.parse({});
      if (!parsed.success) {
        log.warn(`策略「${strategyRecord.name}」校验未通过，非法字段已回退为默认值`);
      }

      /* --- Model -------------------------------------------------------- */
      const { client } = await this.buildModel(trader.aiModelId);
      checks.push({
        name: '语言模型',
        severity: 'ok',
        ok: true,
        detail: '模型已成功响应探测请求。',
        blocking: false,
      });

      /* --- Assemble ----------------------------------------------------- */
      const marketData = new MarketDataService(connection.market, connection.registry);

      // A trader created before its exchange credential existed (or created with
      // a hand-typed baseline) would otherwise show a meaningless return
      // percentage forever. Seed it from the real wallet balance on first start.
      if (trader.initialEquity <= 0) {
        const live = await connection.broker.getAccountState().catch(() => null);
        if (live && live.walletBalance > 0) {
          traders.update(traderId, { initialEquity: live.walletBalance });
          const message = `起始权益已从交易所读取：${live.walletBalance.toFixed(2)} USDT`;
          runtimeLogs.write(traderId, 'info', 'manager', message);
          eventBus.publish({
            type: 'log',
            traderId,
            level: 'info',
            message,
            timestamp: new Date().toISOString(),
          });
        }
      }

      /*
       * --- Config reachability ----------------------------------------------
       *
       * 这个配置在这个账户规模下**究竟能不能开出仓来**。
       *
       * ⚠️ 这条检查是实测逼出来的：机器人空转了 60 多个周期一笔单没开，
       * 而每轮周期都"成功"、日志干净、状态显示 running ——
       * **唯一的现象是"什么都不发生"**。
       *
       * 根因是两条互相矛盾的配置，数字上完全不显眼：
       * 山寨币名义上限 4.55 USDT < 币安最小名义 5 USDT，任何仓位都不成立。
       *
       * 放进预检是因为**这是操作员一定会看到的地方** ——
       * 而"参数不可达"与"市场不好"在控制台上长得一模一样：
       * 前者是配置错误，后者才是策略判断。混为一谈的代价是几十轮空转。
       *
       * ⚠️ **位置很要紧**：必须在读到真实权益之后。放在前面的话它会拿
       * `initialEquity`（可能是 0）去算，于是**这个检查本身会给出错误结论** ——
       * 一个用来防错的东西自己出错，比没有它更糟。
       *
       * **不阻断启动**：某一类标的不可达时另一类可能仍然可交易
       * （实测里 BTC/ETH 可以、山寨币不行）。阻断会让一个还能工作的机器人启动不了。
       */
      /*
       * ⚠️ **必须用「生效配置」，不是策略配置。**
       *
       * AI 托管机器人的参数存在 `agent_config_json`（由 AI 自己写），
       * 策略里的那份**不生效**。第一次实现时我用了策略配置，于是预检报出：
       *
       *     山寨币开不出仓位：名义上限 9.11 × 0.5 = 4.56，低于 minPositionSize=12
       *
       * 而 AI 早把 minPositionSize 调成 5、比例调成 1 —— **那两个数字在生效配置里
       * 根本不存在**。也就是说这个检查**报了一个不存在的问题，同时漏掉了真正的问题**。
       *
       * 一个用来防错的检查自己给出错误结论，比没有它更糟：它会让操作员去修一个
       * 不存在的问题，同时对真问题视而不见。
       */
      const effectiveConfig = (() => {
        const raw = traders.get(traderId)?.agentConfigJson;
        if (trader.mode === 'ai_managed' && typeof raw === 'string' && raw.length > 0) {
          try {
            const parsedAi = StrategyConfigSchema.safeParse(JSON.parse(raw));
            if (parsedAi.success) return parsedAi.data;
          } catch {
            // 坏 JSON 与 schema 不通过走同一条回落路径。
          }
          // 与 `AutoTrader.refreshAgentState()` 的回落保持一致：坏 AI 配置时用策略配置。
          log.warn(`机器人 #${traderId} 的 AI 配置无法解析，可达性检查按策略配置进行。`);
        }
        return config;
      })();

      const reachEquity = await connection.broker
        .getAccountState()
        .then((s) => s.walletBalance)
        .catch(() => trader.initialEquity);
      /*
       * 候选池的**真实**交易所约束。
       *
       * 全部取自 `registry`（它解析的就是 `fapi/v1/exchangeInfo`），
       * **不接受任何推测的数字** —— 我上一版在这里编了一个
       * `EXCHANGE_MIN_NOTIONAL_USD = 5`，而真值按标的不同（BTC 50、ETH 20、山寨 5），
       * 于是体检恰好漏掉了唯一真正不可达的那一类。
       *
       * 用**配置里的候选池**而不是"全部合约"：体检要回答的是
       * "照这个配置能交易哪些标的"，所以标的集合必须与配置一致。
       */
      const universe = new Set<string>([
        ...effectiveConfig.coinSource.staticCoins,
        ...(effectiveConfig.coinSource.useCoinPool ? [] : []),
      ]);
      const constraints = [...universe]
        .flatMap((symbol) => {
          try {
            const info = connection.registry.require(symbol);
            return [
              {
                symbol,
                minNotional: info.minNotional,
                stepSize: info.stepSize,
                price: 0, // 下面用实时标记价填 —— 价格影响取整后的有效下限。
                isMajor: connection.registry.isMajor(symbol),
              },
            ];
          } catch {
            return [];
          }
        });

      /*
       * 价格必须用**实时标记价**：取整后的有效下限依赖它
       * （HYPE 在 80 时下限 5 会取整到 5.60，在 100 时是 5.00）。
       * 拿不到价格的标的一并跳过 —— 用 0 会除零，用一个旧价会给出错误结论。
       */
      const priced = (
        await Promise.all(
          constraints.map(async (c) => {
            const price = await connection.broker.getMarkPrice(c.symbol).catch(() => 0);
            return price > 0 ? { ...c, price } : null;
          }),
        )
      ).filter((c): c is NonNullable<typeof c> => c !== null);

      const reach = checkConfigReachability({
        equity: reachEquity,
        maxMarginUsagePercent: effectiveConfig.riskControl.maxMarginUsage,
        ratios: {
          major: effectiveConfig.riskControl.btcEthMaxPositionValueRatio,
          altcoin: effectiveConfig.riskControl.altcoinMaxPositionValueRatio,
        },
        minPositionSize: effectiveConfig.riskControl.minPositionSize,
        maxLeverage: {
          major: effectiveConfig.riskControl.btcEthMaxLeverage,
          altcoin: effectiveConfig.riskControl.altcoinMaxLeverage,
        },
        symbols: priced,
      });

      /*
       * 报告形式是"**哪些标的能交易**"而不是"某一类可行吗" ——
       * 后者（"BTC 不行、SOL 行"）没法直接用于决策，前者可以。
       */
      /*
       * ⚠️ 报告里必须说清**评了哪些标的**。
       *
       * 实测撞到过：这里只评了 `staticCoins`（BTC/ETH），而配置里
       * `useCoinPool: true` —— **动态币池那些真正能交易的山寨币根本没被评估**。
       * 于是预检对操作员说"一个都开不出来"，而实际上 SOL/HYPE 是可以的。
       *
       * 启动时拿不到动态币池（它需要先拉行情），**但报告必须诚实说明范围** ——
       * 否则操作员会据此做出错误决定。这与我前面几处犯的错是同一类：
       * **一个说得太满的检查，比一个范围明确的检查更糟。**
       */
      const poolNote = effectiveConfig.coinSource.useCoinPool
        ? `（只评了静态列表；动态币池需要行情，启动时不评估 —— 里面可能有可交易的标的）`
        : '';
      checks.push({
        name: '可交易标的',
        severity: reach.ok ? 'ok' : 'warn',
        ok: reach.ok,
        detail: reach.summary + poolNote,
        blocking: false,
      });
      // 被挡下的逐个列出（最多 5 个）—— 操作员需要知道是哪些、为什么。
      for (const v of reach.blocked.slice(0, 5)) {
        checks.push({
          name: `不可交易（${v.symbol}）`,
          severity: 'warn',
          ok: false,
          detail: v.reason,
          blocking: false,
        });
      }
      if (!reach.ok) {
        log.warn(`机器人 #${traderId} 当前配置下没有可交易的标的：${reach.summary}`);
      }

      const model: DecisionModel = {
        complete: async (systemPrompt, userPrompt) => {
          const result = await client.complete(systemPrompt, userPrompt);
          return {
            text: result.text,
            latencyMs: result.latencyMs,
            usage: {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
            },
          };
        },
      };

      /*
       * AI 智能托管接缝。
       *
       * ⚠️ **总是传**，而不是"只在策略是 ai_managed 时传"。
       *
       * 判据是 `traders.agent_config_json` 非空，而那一列**可以在机器人运行期间
       * 被写**（AI 第一次调参就会写它）。若按启动时的策略 id 决定传不传，
       * 那么一个"启动时还不是 AI 模式、运行中变成 AI 模式"的机器人就永远接不上 ——
       * 而那恰恰是这个模式本来的用法。
       *
       * 传进去是安全的：`AgentRuntime` 自己在非 AI 模式下完全空转
       * （`isEnabled()` 为假时所有方法直接返回）。
       */
      const agentRuntime = new AgentRuntime({
        traderId,
        strategyConfig: () => config,
        /*
         * 选了这个预设就等于"要求 AI 托管"，哪怕它还没改过任何参数。
         *
         * ⚠️ 这个判据是**启动死锁的解药**：只看 `agent_config_json` 非空的话，
         * 而那一列只有 AI 调参才会写，而 AI 只有在跑时才调参 ——
         * 一个刚建的 AI 机器人会安静地什么都不做，且没有任何东西报错。
         */
        /*
         * 判据是**机器人自己的模式**，不是"策略是不是某个预设"。
         *
         * AI 托管本来就不该是一个策略：策略是"一组固定参数"，而 AI 模式的
         * 意思是"没有固定参数" —— 后者不能是前者的一种。挂在策略上还会让它
         * 出现在策略列表里，任何既有机器人都能选中它。
         */
        isAiStrategy: () => traders.get(traderId)?.mode === 'ai_managed',
        model,
        equityNow: () => equity.latest(traderId)?.equity ?? null,
      });

      const autoTrader = new AutoTrader({
        trader,
        config,
        registry: connection.registry,
        market: connection.market,
        marketData,
        broker: connection.broker,
        model,
        agent: {
          configOverride: () => agentRuntime.configOverride(),
          triggerReview: () => agentRuntime.triggerReview(),
          settleOnly: () => agentRuntime.settleOnly(),
          reviewTrade: (t) => agentRuntime.reviewTrade(t),
          paused: () => agentRuntime.paused() !== null,
        },
      });

      this.running.set(traderId, autoTrader);
      this.startedAt.set(traderId, Date.now());
      await autoTrader.start();
      // Attached after the trader is live, so a stream failure can never prevent
      // the trading loop from starting.
      await this.startUserStream(traderId, connection);

      const mode = dryRun ? '模拟盘' : '实盘';
      runtimeLogs.write(traderId, 'info', 'manager', `机器人已启动（${mode}）`);
      eventBus.publish({
        type: 'log',
        traderId,
        level: 'info',
        message: `机器人已启动（${mode}）`,
        timestamp: new Date().toISOString(),
      });

      return { result: { ok: true, preflight: checks }, permanent: false };
    } catch (error) {
      const message = (error as Error).message;
      log.error(`启动机器人 ${traderId} 失败：${message}`);
      this.running.delete(traderId);
      this.connections.delete(traderId);
      traders.setStatus(traderId, 'error', message);
      return {
        result: { ok: false, error: message, preflight: checks },
        permanent: isPermanentStartFailure(message),
      };
    }
  }

  /**
   * Stop a trader's loop **and wait for the cycle already in flight**.
   *
   * `AutoTrader.stop()` now drains the running cycle (see its comment: a cycle
   * that dies mid-way between "entry filled" and "stop placed" leaves an
   * unprotected leveraged position). The map entry is deliberately kept until the
   * drain finishes, so a concurrent `startTrader` cannot slip a second instance
   * in behind this one while it is still writing.
   */
  async stopTrader(traderId: number): Promise<void> {
    // Record the operator's intent before doing any async work, so a boot retry
    // parked in `waitForRetry()` aborts instead of starting the trader seconds
    // after it was told to stop.
    this.cancelledStarts.add(traderId);
    const autoTrader = this.running.get(traderId);
    if (autoTrader) {
      await autoTrader.stop();
      this.running.delete(traderId);
    }
    this.startedAt.delete(traderId);
    const stream = this.userStreams.get(traderId);
    if (stream) {
      await stream.stop().catch(() => undefined);
      this.userStreams.delete(traderId);
    }
    this.connections.delete(traderId);
    runtimeLogs.write(traderId, 'info', 'manager', '机器人已停止');
  }

  /**
   * Run one cycle immediately, without waiting for the timer.
   *
   * Exposed so an operator can force a re-evaluation (for example right after
   * changing a strategy, or before stepping away from the machine) rather than
   * waiting out the interval.
   */
  async runCycleNow(traderId: number): Promise<string> {
    const autoTrader = this.running.get(traderId);
    if (!autoTrader) throw new Error('该机器人当前未在运行。');
    return autoTrader.runOnce();
  }

  /**
   * Reconcile one trader's ledger against the exchange **without trading**.
   *
   * Needed because the interesting failure is precisely the one a cycle cannot
   * cover: a position whose exchange-side stop or target fired while the trader
   * was stopped. Waiting for a cycle to fix it means the console shows the wrong
   * PnL for as long as the trader stays stopped — which is exactly when someone
   * is looking at it.
   *
   * Deliberately built with a **stub model**: reconciliation reads the exchange's
   * fill history and never consults an LLM, so making that structural means a
   * broken API key can never block the books from being corrected.
   */
  async reconcileTrader(
    traderId: number,
  ): Promise<{ recovered: number; corrected: number; funding: number }> {
    const trader = traders.get(traderId);
    if (!trader) throw new Error('机器人不存在。');

    /*
     * When the trader is live, reconcile **through the live instance**.
     *
     * Building a second `AutoTrader` here used to run a full ledger pass
     * concurrently with the trading cycle: both read the same `trades` rows and
     * the same positions, and both could book the same close — or one could close
     * a local row the other had just corrected. `runReconcile()` waits for the
     * in-flight cycle, so there is only ever one writer.
     *
     * The stub-model construction below is still used for a trader that is not
     * running, which is the case this endpoint exists for (a position closed
     * while the bot was down), and keeps the structural guarantee that
     * reconciliation never depends on an LLM.
     */
    const live = this.running.get(traderId);
    if (live) return live.runReconcile();

    const connection = await this.connectionFor(traderId, trader.exchangeAccountId, false);
    const strategyRecord = strategies.get(trader.strategyId);
    const parsed = strategyRecord
      ? StrategyConfigSchema.safeParse(strategyRecord.config)
      : null;
    const config: StrategyConfig = parsed?.success
      ? parsed.data
      : StrategyConfigSchema.parse({});

    const autoTrader = new AutoTrader({
      trader,
      config,
      registry: connection.registry,
      market: connection.market,
      marketData: new MarketDataService(connection.market, connection.registry),
      broker: connection.broker,
      model: {
        complete: () => Promise.reject(new Error('对账不调用模型')),
      },
    });

    return autoTrader.reconcileTradeHistory();
  }
  /**
   * 操作员手工平掉一个持仓。**无论机器人在跑还是已停止，都必须能用。**
   *
   * ## 为什么不复用 `this.running` 里的实例就够了
   *
   * 机器人停止时 `running` 里没有实例，而**"已停止的机器人有持仓"恰恰是最需要
   * 手工平仓的场景** —— 它不会再自己了结，仓位会一直挂在那里。
   *
   * 所以形状照 `reconcileTrader`：
   *   · 运行中 → 走实例（只有一个写者）
   *   · 已停止 → 建一个**不调模型**的桩实例，只为拿到 broker 与记账能力
   *
   * ## 一个必须处理的冲突
   *
   * 机器人正在跑的时候手工平仓，**下一个周期它可能会立刻重新开一个同样的仓**
   * （它有额度、也认为那个标的有机会）。**那不是 bug，是它的工作。**
   * 但操作员需要知道这件事 —— 所以返回值里带一个 `stillRunning` 标记，
   * 由界面提示"机器人仍在运行，它可能重新开仓；要它别开请先停止"。
   *
   * @returns 成交结果与"机器人是否仍在运行"
   */
  async closePosition(
    traderId: number,
    symbol: string,
  ): Promise<{ avgPrice: number; fee: number; stillRunning: boolean }> {
    const trader = traders.get(traderId);
    if (!trader) throw new Error('机器人不存在。');

    const running = this.running.get(traderId);
    if (running) {
      const result = await running.closeManually(symbol);
      if (!result) throw new Error(`本地没有 ${symbol} 的持仓。`);
      return { ...result, stillRunning: true };
    }

    /*
     * 已停止：建一个一次性实例。
     *
     * 模型换成"永远拒绝"的桩 —— 手工平仓绝不该调用 LLM：
     * 那会让"按一个按钮"变成"等一次模型请求"，而且在模型故障时根本用不了。
     * **操作员的退出路径不能依赖任何外部服务。**
     */
    const connection = await this.connectionFor(traderId, trader.exchangeAccountId, false);
    const strategyRecord = strategies.get(trader.strategyId);
    const parsed = strategyRecord ? StrategyConfigSchema.safeParse(strategyRecord.config) : null;
    const config: StrategyConfig = parsed?.success ? parsed.data : StrategyConfigSchema.parse({});

    const autoTrader = new AutoTrader({
      trader,
      config,
      registry: connection.registry,
      market: connection.market,
      marketData: new MarketDataService(connection.market, connection.registry),
      broker: connection.broker,
      model: {
        complete: () => Promise.reject(new Error('手工平仓不调用模型')),
      },
    });

    const result = await autoTrader.closeManually(symbol);
    if (!result) throw new Error(`本地没有 ${symbol} 的持仓。`);
    return { ...result, stillRunning: false };
  }


  /**
   * Reconcile every trader's ledger, sequentially.
   *
   * Sequential on purpose: each pass reads fills and the income ledger from the
   * same API key, and firing a dozen of them at once at boot would spend the
   * rate-limit budget that live trading needs.
   *
   * One trader failing must not stop the others — a single bad credential would
   * otherwise leave every other book uncorrected.
   */
  async reconcileAllTraders(): Promise<{ traders: number; recovered: number; corrected: number }> {
    let recovered = 0;
    let corrected = 0;
    let count = 0;

    for (const trader of traders.list()) {
      try {
        const result = await this.reconcileTrader(trader.id);
        recovered += result.recovered;
        corrected += result.corrected;
        count += 1;
      } catch (error) {
        log.warn(`机器人「${trader.name}」启动对账跳过：${(error as Error).message}`);
      }
    }

    if (recovered > 0 || corrected > 0) {
      log.warn(`启动对账完成：${count} 个机器人，补录 ${recovered} 笔，修正 ${corrected} 笔`);
    } else {
      log.info(`启动对账完成：${count} 个机器人，账目无需修正`);
    }
    return { traders: count, recovered, corrected };
  }

  /** Stop everything — used on shutdown, and by the global kill switch. */
  async stopAll(reason = '服务器正在关闭'): Promise<void> {
    if (this.stopping) return;
    /*
     * Cancel every in-flight boot retry *before* anything else.
     *
     * `resumePersisted()` can be sitting in a 90-second backoff when SIGTERM
     * arrives. Without this, the shutdown would clear the loop timers, close the
     * database, and the backoff would then expire and try to start a trader
     * against a closed database — a crash during shutdown that looks like a
     * random failure on the next boot.
     */
    for (const trader of traders.list()) this.cancelledStarts.add(trader.id);
    this.stopping = true;

    await Promise.all(
      [...this.userStreams.entries()].map(async ([id, stream]) => {
        try {
          await stream.stop();
        } catch (error) {
          log.warn(`停止机器人 ${id} 的用户数据流失败：${(error as Error).message}`);
        }
      }),
    );
    this.userStreams.clear();

    /*
     * `trader.stop()` waits for the cycle in flight before resolving, which is
     * what makes this shutdown safe: Ctrl+C used to land between "entry filled"
     * and "stop placed", the timer was already cleared, `process.exit(0)` ran
     * immediately, and the account was left holding a leveraged position with no
     * exchange-side stop — the exact state §2.6 forbids. The wait is bounded
     * inside `stop()`, so a wedged exchange call delays shutdown but cannot hang
     * it forever.
     */
    await Promise.all(
      [...this.running.entries()].map(async ([id, trader]) => {
        try {
          /*
           * `persist: false` —— 进程关闭不是"操作员点了停止"。
           *
           * 若这里照常写入 `stopped`，`resumePersisted()` 会把它当成人的决定而
           * 拒绝恢复（见那里的注释），于是**每一次部署或重启都会静默停掉所有
           * 机器人** —— 而且控制台上看起来就像是有人手动停的，没有任何异常提示。
           * 这个 bug 真实发生过。
           *
           * 保留库里的 `running`，下次启动就能恢复。
           */
          await trader.stop(reason, false);
        } catch (error) {
          log.warn(`停止机器人 ${id} 失败：${(error as Error).message}`);
        }
      }),
    );
    this.running.clear();
    this.connections.clear();
    /*
     * `stopping` deliberately stays true: this instance is on its way down, and
     * any boot retry still parked in `waitForRetry()` must abort rather than
     * resurrect a trader against a closing database. `startTrader()` resets the
     * flag itself, so a start issued after a shutdown (the global kill switch can
     * stop traders without ending the process) still works.
     */
    log.info('所有机器人已停止');
  }

  /**
   * Resume every trader that was running before a restart.
   *
   * Called on boot so an unattended host that reboots comes back up trading
   * rather than silently sitting idle.
   */
  async resumePersisted(dryRun: boolean): Promise<void> {
    /*
     * `error` is recovered too, and that is the whole point of F2.
     *
     * A transient failure at boot wrote `error` and nothing ever looked at it
     * again: `resumePersisted()` only resumed `running` / `safe_mode`, so the bot
     * stayed down until a human clicked start. The status is written into the
     * database, which means it *survives the restart that would have fixed the
     * underlying blip* — the most common shape of this latch.
     *
     * `stopped` is still excluded: that status is an operator decision, and
     * starting it would be this code overriding a human.
     */
    const resumable = new Set(['running', 'safe_mode', 'error']);

    for (const trader of traders.list()) {
      if (!resumable.has(trader.status)) continue;
      // A stop request that arrives while earlier traders are still starting must
      // win: the operator may be shutting the instance down.
      if (this.cancelledStarts.has(trader.id) || this.stopping) break;

      const recovering = trader.status === 'error';
      log.info(
        recovering
          ? `重启后发现处于 error 状态的机器人「${trader.name}」，正在尝试恢复（原因：${trader.lastError ?? '未知'}）`
          : `重启后正在恢复机器人「${trader.name}」`,
      );

      /*
       * Only the `error` case gets the retry budget. A trader that was healthy
       * when the host went down is expected to come straight back; if it cannot,
       * the retry loop would spend ~2.5 minutes per broken trader and delay every
       * later one. `error` is the case where a transient cause is the likely
       * explanation and waiting is the whole fix.
       */
      const result = await this.startTrader(trader.id, dryRun, { retryTransient: recovering });
      if (result.ok) continue;

      /*
       * Give up **visibly**. The point of F2 is that this state must not be
       * silent, so it goes to three places the operator actually looks: the
       * process log, the console's rolling log pane, and the trader row itself
       * (`status='error'` + `lastError`, which `TradersPage` renders).
       */
      const detail = `启动恢复失败，已停止自动重试，需要人工处理：${result.error ?? '未知错误'}`;
      traders.setStatus(trader.id, 'error', detail);
      runtimeLogs.write(trader.id, 'error', 'manager', detail);
      eventBus.publish({
        type: 'log',
        traderId: trader.id,
        level: 'error',
        message: `机器人「${trader.name}」${detail}`,
        timestamp: new Date().toISOString(),
      });
      log.error(`机器人「${trader.name}」恢复失败并已放弃重试：${result.error}`);
    }
  }

  /**
   * 处于 `error` 且**没有**在运行的机器人 —— 也就是"自动恢复已经放弃"的那一批。
   *
   * 给 `/api/system` 用。它存在的理由是 F2 的另一半：放弃重试这件事本身必须是
   * 可见的。只看 `runningIds()` 的话，一个启动失败的机器人和一个被操作员
   * 主动停掉的机器人长得一模一样。
   */
  failedTraders(): Array<{ id: number; name: string; lastError: string | null }> {
    return traders
      .list()
      .filter((trader) => trader.status === 'error' && !this.running.has(trader.id))
      .map((trader) => ({ id: trader.id, name: trader.name, lastError: trader.lastError }));
  }
}
