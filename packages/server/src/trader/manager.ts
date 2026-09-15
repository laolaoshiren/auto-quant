import { StrategyConfigSchema, type StrategyConfig, type TraderStatus } from '@aq/shared';
import { connectExchange, preflight, type ExchangeConnection, type PreflightCheck } from '../binance/bootstrap.js';
import type { BinanceEnvironment } from '../binance/endpoints.js';
import { BinanceUserDataStream } from '../binance/ws.js';
import type { Vault } from '../crypto/vault.js';
import { createLogger } from '../logger.js';
import { MarketDataService } from '../market/service.js';
import { LlmClient } from '../llm/client.js';
import { aiModels, exchanges, runtimeLogs, strategies, traders } from '../store/repositories.js';
import { eventBus } from '../events.js';
import { AutoTrader, type DecisionModel } from './autoTrader.js';

const log = createLogger('manager');

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

  async startTrader(traderId: number, dryRun: boolean): Promise<StartResult> {
    const trader = traders.get(traderId);
    if (!trader) return { ok: false, error: `找不到机器人 ${traderId}`, preflight: [] };

    if (this.running.has(traderId)) {
      return { ok: false, error: '该机器人已经在运行中', preflight: [] };
    }

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
        return { ok: false, error: message, preflight: checks };
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

      const autoTrader = new AutoTrader({
        trader,
        config,
        registry: connection.registry,
        market: connection.market,
        marketData,
        broker: connection.broker,
        model,
      });

      this.running.set(traderId, autoTrader);
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

      return { ok: true, preflight: checks };
    } catch (error) {
      const message = (error as Error).message;
      log.error(`启动机器人 ${traderId} 失败：${message}`);
      this.running.delete(traderId);
      this.connections.delete(traderId);
      traders.setStatus(traderId, 'error', message);
      return { ok: false, error: message, preflight: checks };
    }
  }

  async stopTrader(traderId: number): Promise<void> {
    const autoTrader = this.running.get(traderId);
    if (autoTrader) {
      await autoTrader.stop();
      this.running.delete(traderId);
    }
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

    await Promise.all(
      [...this.running.entries()].map(async ([id, trader]) => {
        try {
          await trader.stop(reason);
        } catch (error) {
          log.warn(`停止机器人 ${id} 失败：${(error as Error).message}`);
        }
      }),
    );
    this.running.clear();
    this.connections.clear();
    this.stopping = false;
    log.info('所有机器人已停止');
  }

  /**
   * Resume every trader that was running before a restart.
   *
   * Called on boot so an unattended host that reboots comes back up trading
   * rather than silently sitting idle.
   */
  async resumePersisted(dryRun: boolean): Promise<void> {
    for (const trader of traders.list()) {
      if (trader.status !== 'running' && trader.status !== 'safe_mode') continue;
      log.info(`重启后正在恢复机器人「${trader.name}」`);
      const result = await this.startTrader(trader.id, dryRun);
      if (!result.ok) {
        log.warn(`无法恢复机器人「${trader.name}」：${result.error}`);
      }
    }
  }
}
