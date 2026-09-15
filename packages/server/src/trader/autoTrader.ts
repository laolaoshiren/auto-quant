import {
  closeReasonLabel,
  isCloseAction,
  isOpenAction,
  normalizeSymbol,
  type CloseReason,
  type Decision,
  type EquitySnapshot,
  type ExecutionLogEntry,
  type MarketSnapshot,
  type PositionView,
  type StrategyConfig,
  type Trader,
  type TraderStatus,
} from '@aq/shared';
import type { BinanceBroker, ExchangePosition } from '../binance/broker.js';
import type { BinanceMarketData } from '../binance/market.js';
import type { SymbolRegistry } from '../binance/symbols.js';
import { eventBus } from '../events.js';
import { createLogger } from '../logger.js';
import type { MarketDataService } from '../market/service.js';
import { checkCircuitBreakers, RiskEngine, shouldCloseForDrawdown } from '../risk/engine.js';
import { selectCandidates } from '../strategy/coins.js';
import { parseDecisionResponse, sortDecisions } from '../strategy/parser.js';
import { buildSystemPrompt, buildUserPrompt, type PromptPosition } from '../strategy/prompt.js';
import { isMajorSymbol } from '@aq/shared';
import {
  decisions as decisionStore,
  equity as equityStore,
  orders as orderStore,
  positions as positionStore,
  runtimeLogs,
  tradeEvents,
  traders as traderStore,
  trades as tradeStore,
} from '../store/repositories.js';
import {
  reconstructRoundTrips,
  roundTripKey,
  type ReconstructedTrade,
} from './roundTrips.js';
import { fundingInWindow } from '../binance/income.js';

const log = createLogger('trader');

/** Row shape returned by the position repository — inferred to avoid a dup type. */
type PositionRow = ReturnType<typeof positionStore.open>[number];

/* -------------------------------------------------------------------------- */
/*  Injected model interface                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The slice of the LLM client the trader depends on.
 *
 * Declared structurally rather than importing the concrete client so the trading
 * loop stays testable with a stub and does not couple to any provider.
 */
export interface DecisionModel {
  complete(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{
    text: string;
    latencyMs: number;
    usage: { promptTokens: number | null; completionTokens: number | null };
  }>;
}

export interface AutoTraderDeps {
  trader: Trader;
  config: StrategyConfig;
  registry: SymbolRegistry;
  market: BinanceMarketData;
  marketData: MarketDataService;
  broker: BinanceBroker;
  model: DecisionModel;
}

/* -------------------------------------------------------------------------- */
/*  Auto trader                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One trader's autonomous loop.
 *
 * The cycle is deliberately ordered so that risk-reducing work happens before
 * risk-adding work, and so that every cycle leaves a complete audit record even
 * when it fails:
 *
 *   1. authoritative account + position state from the exchange
 *   2. reconcile local records against reality
 *   3. mechanical protections (drawdown guard) — these never ask the model
 *   4. circuit breakers
 *   5. build the candidate universe and market snapshots
 *   6. ask the model
 *   7. parse, then subject every proposal to the hard risk engine
 *   8. execute closes, then opens
 *   9. persist the decision, the orders, the trades and an equity point
 */
export class AutoTrader {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cycleInFlight = false;
  private cycleNumber: number;
  private consecutiveFailures = 0;
  private status: TraderStatus = 'stopped';
  private readonly risk = new RiskEngine();

  constructor(private readonly deps: AutoTraderDeps) {
    // Resume numbering so the audit trail stays continuous across restarts.
    this.cycleNumber = deps.trader.lastCycleNumber;
    this.consecutiveFailures = deps.trader.consecutiveFailures;
  }

  /* ---------------------------------------------------------------------- */
  /*  Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  get currentStatus(): TraderStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.setStatus('starting', null);

    const mode = await this.deps.broker.ensureOneWayMode().catch((error) => ({
      changed: false,
      warning: `无法读取持仓模式：${(error as Error).message}`,
    }));
    if (mode.warning) this.emit('warn', mode.warning);

    this.setStatus('running', null);
    this.emit('info', `机器人「${this.deps.trader.name}」已启动`);

    // Run the first cycle immediately so the operator is not left waiting.
    void this.tick();
    const intervalMs = Math.max(1, this.deps.trader.cycleIntervalMinutes) * 60_000;
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  async stop(reason = '操作员手动停止'): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setStatus('stopped', null);
    this.emit('info', `机器人「${this.deps.trader.name}」已停止（${reason}）`);
  }

  private setStatus(status: TraderStatus, error: string | null): void {
    this.status = status;
    traderStore.setStatus(this.deps.trader.id, status, error);
    eventBus.publish({
      type: 'trader_status',
      traderId: this.deps.trader.id,
      status,
      ...(error ? { detail: error } : {}),
    });
  }

  private emit(level: 'info' | 'warn' | 'error', message: string): void {
    log[level](`[${this.deps.trader.name}] ${message}`);
    runtimeLogs.write(this.deps.trader.id, level, 'trader', message);
    eventBus.publish({
      type: 'log',
      traderId: this.deps.trader.id,
      level,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Run exactly one cycle, outside the timer.
   *
   * Used by the console's "run now" action and by integration tests. Unlike
   * `tick()` it does not swallow failures, so a caller sees the real error.
   */
  async runOnce(): Promise<string> {
    if (this.cycleInFlight) throw new Error('A cycle is already running.');
    this.cycleInFlight = true;
    try {
      this.cycleNumber += 1;
      const summary = await this.runCycle(this.cycleNumber);
      traderStore.recordCycle(this.deps.trader.id, this.cycleNumber, 0);
      if (this.status === 'safe_mode') this.setStatus('running', null);
      return summary;
    } finally {
      this.cycleInFlight = false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Cycle driver                                                           */
  /* ---------------------------------------------------------------------- */

  private async tick(): Promise<void> {
    if (!this.running) return;
    // A cycle that overruns its interval must not overlap the next one — that
    // would double-count positions and duplicate orders.
    if (this.cycleInFlight) {
      this.emit('warn', '上一轮决策仍在执行，跳过本次调度');
      return;
    }

    this.cycleInFlight = true;
    const traderId = this.deps.trader.id;

    try {
      this.cycleNumber += 1;
      eventBus.publish({
        type: 'cycle_start',
        traderId,
        cycleNumber: this.cycleNumber,
        timestamp: new Date().toISOString(),
      });

      const summary = await this.runCycle(this.cycleNumber);
      this.consecutiveFailures = 0;
      traderStore.recordCycle(traderId, this.cycleNumber, 0);
      if (this.status === 'safe_mode') this.setStatus('running', null);

      eventBus.publish({
        type: 'cycle_end',
        traderId,
        cycleNumber: this.cycleNumber,
        summary,
        success: true,
      });
    } catch (error) {
      this.consecutiveFailures += 1;
      const message = (error as Error).message;
      this.emit('error', `第 #${this.cycleNumber} 轮决策失败：${message}`);
      traderStore.recordCycle(traderId, this.cycleNumber, this.consecutiveFailures);

      const threshold = this.deps.config.circuitBreaker.safeModeAfterFailures;
      if (this.consecutiveFailures >= threshold) {
        // Repeated failures usually mean a rejected key, an exhausted balance or
        // a model outage. Stop opening new positions until something changes.
        this.setStatus('safe_mode', message);
        this.emit('error', `连续失败 ${this.consecutiveFailures} 次，已进入安全模式`);
      } else {
        this.setStatus('error', message);
      }

      eventBus.publish({
        type: 'cycle_end',
        traderId,
        cycleNumber: this.cycleNumber,
        summary: message,
        success: false,
      });
    } finally {
      this.cycleInFlight = false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  One full decision cycle                                                */
  /* ---------------------------------------------------------------------- */

  private async runCycle(cycleNumber: number): Promise<string> {
    const traderId = this.deps.trader.id;
    const config = this.deps.config;

    /* --- 1. Authoritative account state ---------------------------------- */
    const account = await this.deps.broker.getAccountState();

    /* --- 2. Reconcile local records against reality ---------------------- */
    /*
     * The ledger pass runs first and unconditionally: it is what recovers a
     * round-trip that closed while the process was not running, which is the
     * only way the console's PnL can be trusted to match the account.
     */
    await this.reconcileTradeHistory().catch((error) => {
      log.warn(`[${this.deps.trader.name}] 成交对账失败（不影响本周期交易）：${(error as Error).message}`);
    });

    const exchangePositions = await this.deps.broker.getPositions();
    await this.reconcilePositions(exchangePositions);

    /* --- 3. Mechanical protections --------------------------------------- */
    const closedByGuard = await this.applyDrawdownGuard();

    /* --- 4. Circuit breakers --------------------------------------------- */
    const highWater = equityStore.highWaterMark(traderId);
    const breaker = checkCircuitBreakers(config, account.equity, {
      dailyRealizedPnl: tradeStore.realizedPnlToday(traderId),
      highWaterEquity: Math.max(highWater, account.equity),
    });
    if (breaker.blocked) this.emit('warn', breaker.reason);

    /* --- 5. Refresh state after the guard's closes ----------------------- */
    const livePositions = await this.deps.broker.getPositions();
    const localPositions = positionStore.open(traderId);

    /* --- 6. Candidate universe + market snapshots ------------------------ */
    const held = localPositions.map((p) => p.symbol);
    const selection = await selectCandidates(config, this.deps.marketData, { mustInclude: held });

    const snapshots = await this.deps.marketData.buildSnapshots(
      selection.symbols,
      config.indicators,
      selection.sourcesBySymbol,
    );

    if (snapshots.length === 0) {
      await this.recordEquity(
        account.equity,
        account.availableBalance,
        account.unrealizedPnl,
        account.marginUsed,
        livePositions.length,
      );
      return '没有可用的行情数据，本轮未产生任何决策。';
    }

    const snapshotBySymbol = new Map(snapshots.map((s) => [s.symbol, s]));

    /* --- 7. Ask the model ------------------------------------------------ */
    const promptPositions = this.buildPromptPositions(localPositions, snapshotBySymbol);
    const oiRanking = config.indicators.enableOiRanking
      ? await this.deps.marketData.getOiRanking(15).catch(() => [])
      : [];

    const promptContext = {
      traderName: this.deps.trader.name,
      cycleNumber,
      now: new Date(),
      config,
      account: {
        equity: account.equity,
        availableBalance: account.availableBalance,
        unrealizedPnl: account.unrealizedPnl,
        marginUsed: account.marginUsed,
        positionCount: livePositions.length,
      },
      positions: promptPositions,
      candidates: snapshots,
      recentTrades: tradeStore.recent(traderId, 10),
      oiRanking,
    };

    const systemPrompt = buildSystemPrompt(promptContext);
    const userPrompt = buildUserPrompt(promptContext);

    const startedAt = Date.now();
    const response = await this.deps.model.complete(systemPrompt, userPrompt);
    const aiLatencyMs = response.latencyMs || Date.now() - startedAt;

    /* --- 8. Parse -------------------------------------------------------- */
    const openPositionMap = new Map<string, 'long' | 'short'>(
      localPositions.map((p) => [p.symbol, p.side as 'long' | 'short']),
    );
    const parsed = parseDecisionResponse(response.text, {
      candidateSymbols: new Set(snapshots.map((s) => s.symbol)),
      openPositions: openPositionMap,
      allowUnlistedCloses: true,
    });

    const executionLog: ExecutionLogEntry[] = parsed.rejected.map((r) => ({
      action: r.action,
      symbol: r.symbol,
      status: 'rejected' as const,
      detail: r.reason,
    }));

    /* --- 9. Hard risk review --------------------------------------------- */
    const verdict = this.risk.review(sortDecisions(parsed.decisions), {
      config,
      account: {
        equity: account.equity,
        availableBalance: account.availableBalance,
        marginUsed: account.marginUsed,
        positionCount: livePositions.length,
      },
      positions: new Map(
        localPositions.map((p) => [p.symbol, this.toPositionView(p, snapshotBySymbol)]),
      ),
      snapshots: snapshotBySymbol,
      minNotionalOf: (symbol) => this.deps.registry.minNotional(symbol),
      quantityFor: (symbol, notionalUsd, price) =>
        this.deps.registry.notionalToQuantity(symbol, notionalUsd, price),
      entriesThisCycle: 0,
      entriesLastHour: tradeEvents.entriesThisHour(traderId),
    });

    for (const rejection of verdict.rejected) {
      executionLog.push({
        action: rejection.decision.action,
        symbol: rejection.decision.symbol,
        status: 'rejected',
        detail: rejection.reason,
      });
    }

    /* --- 10. Execute ----------------------------------------------------- */
    let entriesTaken = 0;
    let exitsTaken = closedByGuard;
    let cooldownBlocked = 0;

    for (const decision of verdict.approved) {
      if (!isOpenAction(decision.action) && !isCloseAction(decision.action)) continue;

      if (isOpenAction(decision.action)) {
        // Circuit breakers and safe mode take precedence over any model intent.
        if (breaker.blocked) {
          executionLog.push({
            action: decision.action,
            symbol: decision.symbol,
            status: 'skipped',
            detail: breaker.reason,
          });
          continue;
        }
        if (this.status === 'safe_mode') {
          executionLog.push({
            action: decision.action,
            symbol: decision.symbol,
            status: 'skipped',
            detail: '当前处于安全模式，在模型恢复正常之前禁止开新仓。',
          });
          continue;
        }
        if (this.isInCooldown(decision.symbol)) {
          cooldownBlocked += 1;
          executionLog.push({
            action: decision.action,
            symbol: decision.symbol,
            status: 'skipped',
            detail: `该标的处于再入冷却期（平仓后 ${config.throttle.reentryCooldownMinutes} 分钟内不可再入场）。`,
          });
          continue;
        }
      }

      try {
        if (isCloseAction(decision.action)) {
          const outcome = await this.executeClose(decision, 'model_decision');
          executionLog.push(outcome);
          if (outcome.status === 'ok') exitsTaken += 1;
        } else {
          const outcome = await this.executeOpen(decision, snapshotBySymbol.get(decision.symbol));
          executionLog.push(outcome);
          if (outcome.status === 'ok') entriesTaken += 1;
        }
      } catch (error) {
        const detail = (error as Error).message;
        this.emit('error', `${decision.action} ${decision.symbol} 执行失败：${detail}`);
        executionLog.push({
          action: decision.action,
          symbol: decision.symbol,
          status: 'failed',
          detail,
        });
      }
    }

    /* --- 11. Persist the audit record ------------------------------------ */
    const recordId = decisionStore.log({
      traderId,
      cycleNumber,
      systemPrompt,
      userPrompt,
      cotTrace: parsed.cotTrace,
      decisions: parsed.decisions,
      rawResponse: parsed.rawResponse,
      executionLog,
      candidateSymbols: snapshots.map((s) => s.symbol),
      success: true,
      error: null,
      aiLatencyMs,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
    });

    const record = decisionStore.get(recordId);
    if (record) eventBus.publish({ type: 'decision', traderId, record });

    /* --- 12. Refresh and snapshot ---------------------------------------- */
    const finalPositions = await this.deps.broker.getPositions().catch(() => livePositions);
    await this.reconcilePositions(finalPositions);

    const finalAccount = await this.deps.broker.getAccountState().catch(() => account);
    await this.recordEquity(
      finalAccount.equity,
      finalAccount.availableBalance,
      finalAccount.unrealizedPnl,
      finalAccount.marginUsed,
      finalPositions.length,
    );

    eventBus.publish({
      type: 'positions',
      traderId,
      positions: positionStore
        .open(traderId)
        .map((p) => this.toPositionView(p, snapshotBySymbol)),
    });

    const parts = [
      `${parsed.decisions.length} 条决策`,
      `开仓 ${entriesTaken}`,
      `平仓 ${exitsTaken}`,
    ];
    if (cooldownBlocked > 0) parts.push(`${cooldownBlocked} 条被冷却期拦截`);
    const rejectedCount = parsed.rejected.length + verdict.rejected.length;
    if (rejectedCount > 0) parts.push(`${rejectedCount} 条被拒绝`);
    return parts.join('，');
  }

  /* ---------------------------------------------------------------------- */
  /*  Position reconciliation                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Reconcile local position records with the exchange.
   *
   * Positions can disappear without us ever receiving a user-data event — the
   * exchange-side stop or target fires, or the position is liquidated. If that
   * is not detected the bot believes it holds something it does not, and every
   * subsequent decision is built on a false premise.
   */
  private async reconcilePositions(exchangePositions: ExchangePosition[]): Promise<void> {
    const traderId = this.deps.trader.id;
    const exchangeBySymbol = new Map(exchangePositions.map((p) => [p.symbol, p]));
    const localOpen = positionStore.open(traderId);

    for (const local of localOpen) {
      const live = exchangeBySymbol.get(local.symbol);
      if (live) {
        // Still open: ratchet the peak profit used by the drawdown guard.
        positionStore.updatePeak(traderId, local.symbol, live.unrealizedPnlPercent);
        continue;
      }

      // Recover the actual exit from the exchange's fill record. Read it here
      // rather than inside the booking step because the reason detection needs
      // it too: when the exchange cannot tell us which order fired, the exit
      // price relative to the two levels is what disambiguates.
      const fill = await this.lastFillFor(local.symbol);
      const exitPrice =
        fill.price > 0 ? fill.price : await this.deps.broker.getMarkPrice(local.symbol).catch(() => 0);

      const reason = await this.detectCloseReason(
        local.symbol,
        local.stop_order_id,
        local.tp_order_id,
        exitPrice,
        local.entry_price,
        local.stop_loss,
        local.take_profit,
      );
      await this.bookClosedPosition(local, reason, exitPrice, fill.fee);
    }

    // Positions opened outside the bot (a manual trade) are adopted rather than
    // ignored: the model should manage what is actually there.
    for (const live of exchangePositions) {
      if (localOpen.some((p) => p.symbol === live.symbol)) continue;
      this.emit(
        'warn',
        `发现一个未被记录的 ${live.symbol} ${live.side === 'long' ? '多头' : '空头'} 持仓，已收养它以便模型可以管理。`,
      );
      positionStore.insert({
        traderId,
        symbol: live.symbol,
        side: live.side,
        quantity: live.quantity,
        entryPrice: live.entryPrice,
        leverage: live.leverage,
        liquidationPrice: live.liquidationPrice,
        marginUsed: live.marginUsed,
        stopLoss: null,
        takeProfit: null,
        stopOrderId: null,
        tpOrderId: null,
        openReasoning: '收养：该仓位是在机器人之外开立的。',
      });
    }
  }

  /**
   * Determine why a position vanished.
   *
   * The subtlety that this used to get wrong: when a `closePosition` stop or
   * target fires, Binance also removes the *surviving* one, so neither id is in
   * `openAlgoOrders` any more. Checking "is the stop gone?" therefore always
   * answered yes and every take-profit was booked as a stop loss.
   *
   * The authoritative signal is each algo order's own final status — the one
   * that fired is `FINISHED`/`TRIGGERED`, the other is `CANCELED`. When that
   * query is unavailable (dry run, network), fall back to comparing the exit
   * price against the levels we recorded, which is unambiguous in practice
   * because they sit on opposite sides of the entry.
   */
  private async detectCloseReason(
    symbol: string,
    stopOrderId: string | null,
    tpOrderId: string | null,
    exitPrice: number,
    entryPrice: number,
    stopLoss: number | null,
    takeProfit: number | null,
  ): Promise<CloseReason> {
    try {
      const [stopOrder, tpOrder] = await Promise.all([
        stopOrderId ? this.deps.broker.getAlgoOrder(Number(stopOrderId)) : Promise.resolve(null),
        tpOrderId ? this.deps.broker.getAlgoOrder(Number(tpOrderId)) : Promise.resolve(null),
      ]);

      const fired = (status: string | undefined): boolean =>
        status === 'FINISHED' || status === 'TRIGGERED';
      const dead = (status: string | undefined): boolean =>
        status === 'CANCELED' || status === 'EXPIRED' || status === 'REJECTED';

      if (fired(stopOrder?.algoStatus)) return 'stop_loss';
      if (fired(tpOrder?.algoStatus)) return 'take_profit';

      // Both cancelled: the position was closed some other way, so the levels
      // themselves are the tiebreaker.
      if (dead(stopOrder?.algoStatus) && dead(tpOrder?.algoStatus)) {
        const byPrice = this.reasonFromPrice(exitPrice, stopLoss, takeProfit);
        if (byPrice) return byPrice;
      }

      // Liquidation and ADL fills carry a recognisable client order id.
      const fills = await this.deps.broker.getUserTrades(symbol, 20);
      const latest = fills[fills.length - 1];
      if (latest) {
        const clientId = String((latest as { clientOrderId?: string }).clientOrderId ?? '');
        if (/autoclose|adl/i.test(clientId)) return 'liquidated';
      }

      const byPrice = this.reasonFromPrice(exitPrice, stopLoss, takeProfit);
      if (byPrice) return byPrice;

      return 'external';
    } catch {
      return 'external';
    }
  }

  /**
   * Infer the trigger from where the position actually exited.
   *
   * Only used when the exchange will not tell us: each level is on the opposite
   * side of the entry, so whichever one the exit price is sitting on is the one
   * that fired.
   */
  private reasonFromPrice(
    exitPrice: number,
    stopLoss: number | null,
    takeProfit: number | null,
  ): CloseReason | null {
    if (!(exitPrice > 0)) return null;
    const toStop = stopLoss !== null ? Math.abs(exitPrice - stopLoss) : Number.POSITIVE_INFINITY;
    const toTarget =
      takeProfit !== null ? Math.abs(exitPrice - takeProfit) : Number.POSITIVE_INFINITY;
    if (toStop === Number.POSITIVE_INFINITY && toTarget === Number.POSITIVE_INFINITY) return null;
    return toStop <= toTarget ? 'stop_loss' : 'take_profit';
  }

  /**
   * The most recent fill for a symbol, used to recover the true exit price and
   * commission. A guessed exit price would corrupt the trade history permanently.
   */
  private async lastFillFor(symbol: string): Promise<{ price: number; fee: number }> {
    try {
      const fills = await this.deps.broker.getUserTrades(symbol, 20);
      const latest = fills[fills.length - 1];
      if (latest) {
        return { price: Number(latest.price) || 0, fee: Number(latest.commission) || 0 };
      }
    } catch {
      /* caller falls back to the mark price */
    }
    return { price: 0, fee: 0 };
  }

  /** Persist a trade and mark the local position closed. */
  private async bookClosedPosition(
    local: PositionRow,
    reason: CloseReason,
    exitPriceInput: number,
    exitFeeInput: number,
  ): Promise<void> {
    const traderId = this.deps.trader.id;

    /*
     * Prefer the exchange's own accounting for this round-trip.
     *
     * Its `realizedPnl` is authoritative, and reconstructing the round-trip from
     * the fills is the only way to see **both** legs' commission — the live path
     * previously recorded just the exit leg, understating costs by about half.
     * Falls back to the local arithmetic when the fills are unavailable.
     */
    const authoritative = await this.findRoundTrip(local).catch(() => null);

    let exitPrice = authoritative?.exitPrice || exitPriceInput;
    if (!(exitPrice > 0)) {
      exitPrice = await this.deps.broker.getMarkPrice(local.symbol).catch(() => 0);
    }
    if (!(exitPrice > 0)) {
      this.emit('warn', `无法确定 ${local.symbol} 的出场价，改用入场价记账`);
      exitPrice = local.entry_price;
    }

    const isLong = local.side === 'long';
    const grossPnl =
      authoritative?.grossPnl ??
      (isLong ? exitPrice - local.entry_price : local.entry_price - exitPrice) * local.quantity;

    // When the fills are unavailable we know only the exit leg's commission, and
    // recording that as zero would be worse than recording half of it — the
    // reconciliation pass corrects it to the true total shortly afterwards.
    const entryFee = authoritative?.entryFee ?? 0;
    const exitFee = authoritative?.exitFee ?? exitFeeInput;

    const tradeId = tradeStore.insert({
      traderId,
      symbol: local.symbol,
      side: isLong ? 'long' : 'short',
      quantity: authoritative?.quantity ?? local.quantity,
      entryPrice: local.entry_price,
      exitPrice,
      leverage: local.leverage,
      grossPnl,
      entryFee,
      exitFee,
      closeReason: reason,
      openedAt: local.opened_at,
      source: 'bot',
      entryOrderId: authoritative?.entryOrderId ?? null,
      exitOrderId: authoritative?.exitOrderId ?? null,
    });

    positionStore.close(local.id);
    tradeEvents.record(traderId, local.symbol, 'exit');

    const record = tradeStore.list(traderId, 200).find((t) => t.id === tradeId);
    if (record) eventBus.publish({ type: 'trade', traderId, trade: record });

    // Log the **net** figure: it is what actually moved the balance, and the
    // gross number was what made the console disagree with the account.
    const net = record?.netPnl ?? grossPnl - entryFee - exitFee;
    const sign = net >= 0 ? '+' : '';
    const costNote =
      entryFee + exitFee > 0 ? `，含手续费 ${(entryFee + exitFee).toFixed(4)}` : '';
    this.emit(
      'info',
      `已平仓 ${local.symbol} ${local.side === 'long' ? '多头' : '空头'} @ ${exitPrice} → 净 ${sign}${net.toFixed(4)} USDT（毛 ${grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(4)}${costNote}，${closeReasonLabel(reason)}）`,
    );
  }

  /**
   * Find this position's completed round-trip in the exchange's fill history.
   *
   * Matched on symbol + quantity + entry price (see `roundTripKey`) rather than on
   * time, because the local record's `opened_at` is when the runtime decided and
   * the exchange's is when the order filled.
   */
  private async findRoundTrip(local: PositionRow): Promise<ReconstructedTrade | null> {
    const fills = await this.deps.broker.getUserTrades(local.symbol, 50);
    const completed = reconstructRoundTrips(fills);
    const wanted = roundTripKey({
      symbol: local.symbol,
      quantity: local.quantity,
      entryPrice: local.entry_price,
    });
    return completed.find((t) => roundTripKey(t) === wanted) ?? null;
  }

  /* ---------------------------------------------------------------------- */
  /*  Ledger reconciliation                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Rebuild the trade ledger from the exchange's fill history.
   *
   * This is the fix for the failure that made the console disagree with the
   * account. Live bookkeeping can only observe a close while it is running, so a
   * position whose exchange-side stop or target fires during downtime — or
   * between cycles, right before the trader is stopped — is never recorded. On
   * the live test account that lost a **+0.6563** round-trip entirely and left
   * the console reporting a loss on a profitable account.
   *
   * Reconstruction is idempotent: a round-trip already on the books is *corrected*
   * from the exchange's figures rather than duplicated, which also repairs the
   * historical fees that were captured on the exit leg only.
   *
   * Runs at start and at the head of every cycle, so the ledger converges on the
   * exchange's regardless of what the runtime managed to witness.
   */
  async reconcileTradeHistory(): Promise<{ recovered: number; corrected: number; funding: number }> {
    const traderId = this.deps.trader.id;
    const since = new Date(this.deps.trader.createdAt).getTime() - 60_000;

    /*
     * The income ledger does double duty here: it supplies funding fees (which no
     * fill mentions) and it names **every symbol the account has touched**, which
     * is how a symbol the platform has no record of at all gets discovered.
     */
    let incomeEvents: Awaited<ReturnType<BinanceBroker['getIncome']>> = [];
    try {
      incomeEvents = await this.deps.broker.getIncome({ startTime: since });
    } catch (error) {
      log.debug(`[${this.deps.trader.name}] 收入流水读取失败，本次对账跳过资金费：${(error as Error).message}`);
    }

    const symbols = new Set<string>([
      ...tradeStore.tradedSymbols(traderId),
      ...positionStore.open(traderId).map((p) => p.symbol),
      ...incomeEvents.map((e) => e.symbol).filter((s): s is string => Boolean(s)),
    ]);

    const byKey = new Map(
      tradeStore.ledger(traderId).map((t) => [
        roundTripKey({ symbol: t.symbol, quantity: t.quantity, entryPrice: t.entryPrice }),
        t.id,
      ]),
    );

    /*
     * Which exchange orders this trader actually placed.
     *
     * Two traders can share one exchange account, and then the fill history is
     * identical for both — reconciliation would have each of them claim every
     * round-trip, double-counting the account's PnL across the books. Only the
     * local order history can say who traded what, so adoption is gated on it.
     *
     * The live symptom was exactly this: two traders on one credential, and a
     * boot pass that booked the same four trades onto both.
     */
    const ownOrders = orderStore.exchangeOrderIds(traderId);

    let recovered = 0;
    let corrected = 0;
    let fundingTotal = 0;

    for (const symbol of symbols) {
      if (!this.deps.registry.get(symbol)) continue;
      let fills;
      try {
        fills = await this.deps.broker.getUserTrades(symbol, 500);
      } catch {
        continue; // a symbol we cannot read must not abort the whole pass
      }

      for (const trip of reconstructRoundTrips(fills)) {
        if (new Date(trip.closedAt).getTime() < since) continue;
        const funding = fundingInWindow(incomeEvents, symbol, trip.openedAt, trip.closedAt);
        fundingTotal += funding;
        const key = roundTripKey(trip);
        const existingId = byKey.get(key);

        if (existingId !== undefined) {
          tradeStore.applyExchangeFigures({
            id: existingId,
            grossPnl: trip.grossPnl,
            entryFee: trip.entryFee,
            exitFee: trip.exitFee,
            fundingFee: funding,
            entryPrice: trip.entryPrice,
            exitPrice: trip.exitPrice,
            quantity: trip.quantity,
            leverage: this.leverageFor(symbol),
            entryOrderId: trip.entryOrderId || null,
            exitOrderId: trip.exitOrderId || null,
          });
          corrected += 1;
          continue;
        }

        /*
         * Only adopt a round-trip this trader placed.
         *
         * `entryOrderId` comes from the exchange's fill, so an exact match in the
         * local order history proves ownership. A round-trip with no matching
         * order belongs to another trader on the same credential, or to a manual
         * trade — either way it is not ours to claim, and booking it would
         * double-count the account's PnL across the books.
         *
         * No fallback: a trade we cannot prove we opened is skipped. Missing a
         * recovery is a smaller error than inventing one, because a phantom trade
         * corrupts the ledger permanently while a skip corrects itself the moment
         * the order row exists.
         */
        if (!trip.entryOrderId || !ownOrders.has(trip.entryOrderId)) {
          log.debug(
            `[${this.deps.trader.name}] 跳过非本机器人开立的成交：${symbol} ${trip.quantity} @ ${trip.entryPrice}（入口订单 ${trip.entryOrderId || '未知'}）`,
          );
          continue;
        }

        const tradeId = tradeStore.insert({          traderId,
          symbol: trip.symbol,
          side: trip.side,
          quantity: trip.quantity,
          entryPrice: trip.entryPrice,
          exitPrice: trip.exitPrice,
          leverage: this.leverageFor(symbol),
          grossPnl: trip.grossPnl,
          entryFee: trip.entryFee,
          exitFee: trip.exitFee,
          fundingFee: funding,
          closeReason: 'reconciled',
          openedAt: trip.openedAt,
          closedAt: trip.closedAt,
          source: 'reconciled',
          entryOrderId: trip.entryOrderId || null,
          exitOrderId: trip.exitOrderId || null,
        });
        byKey.set(key, tradeId);
        recovered += 1;

        const net = trip.grossPnl - trip.fee - funding;
        this.emit(
          'warn',
          `对账补录了一笔未被记录的成交：${trip.symbol} ${trip.side === 'long' ? '多头' : '空头'} ` +
            `${trip.quantity} @ ${trip.entryPrice} → ${trip.exitPrice}，净 ${net >= 0 ? '+' : ''}${net.toFixed(4)} USDT。` +
            '（平仓发生在机器人未运行时，已从交易所成交记录恢复）',
        );
      }
    }

    /*
     * Close local position rows the exchange no longer holds.
     *
     * `reconcilePositions` does this during a cycle, but it needs the position to
     * still be open locally *and* a cycle to run. Doing it here as well means a
     * trader that was stopped mid-position does not come back believing it still
     * holds something.
     */
    const liveSymbols = new Set(
      (await this.deps.broker.getPositions().catch(() => [])).map((p) => p.symbol),
    );
    for (const local of positionStore.open(traderId)) {
      if (!liveSymbols.has(local.symbol)) {
        positionStore.close(local.id);
        tradeEvents.record(traderId, local.symbol, 'exit');
      }
    }

    /*
     * Refresh the equity snapshot from the exchange.
     *
     * `computeTraderStats` reads the newest snapshot, and a stopped trader writes
     * none — so its displayed equity freezes at whenever the last cycle ran. On
     * the live account that meant showing 9.6213 while the real balance was
     * 10.2586, because the profit landed *after* the bot was stopped. Writing one
     * here is correct precisely because this pass is the moment the books are
     * known to match reality.
     */
    try {
      const account = await this.deps.broker.getAccountState();
      const livePositions = await this.deps.broker.getPositions().catch(() => []);
      equityStore.insert({
        traderId,
        timestamp: new Date().toISOString(),
        equity: account.equity,
        availableBalance: account.availableBalance,
        unrealizedPnl: account.unrealizedPnl,
        marginUsed: account.marginUsed,
        openPositions: livePositions.length,
      });
    } catch (error) {
      log.debug(`[${this.deps.trader.name}] 对账后写入权益快照失败：${(error as Error).message}`);
    }

    if (recovered > 0 || corrected > 0) {
      log.info(
        `[${this.deps.trader.name}] 对账完成：补录 ${recovered} 笔，修正 ${corrected} 笔，资金费合计 ${fundingTotal.toFixed(6)} USDT`,
      );
    }
    return { recovered, corrected, funding: fundingTotal };
  }

  /**
   * Leverage to record on a reconciled trade.
   *
   * The exchange's fill history carries prices and sizes but not the leverage
   * that was set, and leverage only affects the *percentage* return — never the
   * absolute PnL, which comes from the exchange. Preferring the live position's
   * leverage keeps the percentage honest for anything still open; otherwise the
   * strategy's configured default is the best available answer.
   */
  private leverageFor(symbol: string): number {
    const open = positionStore.open(this.deps.trader.id).find((p) => p.symbol === symbol);
    if (open && open.leverage > 0) return open.leverage;
    const risk = this.deps.config.riskControl;
    return isMajorSymbol(symbol) ? risk.btcEthMaxLeverage : risk.altcoinMaxLeverage;
  }

  /* ---------------------------------------------------------------------- */
  /*  Drawdown guard                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Close positions that have given back too much of their peak profit.
   *
   * Runs before the model is consulted and does not ask permission: protecting
   * realised profit is exactly the judgement models reliably get wrong.
   */
  private async applyDrawdownGuard(): Promise<number> {
    const traderId = this.deps.trader.id;
    const exchangePositions = await this.deps.broker.getPositions();
    const liveBySymbol = new Map(exchangePositions.map((p) => [p.symbol, p]));
    let closed = 0;

    for (const local of positionStore.open(traderId)) {
      const live = liveBySymbol.get(local.symbol);
      if (!live) continue;

      // Use the exchange's own unrealised PnL for the decision, but the stored
      // peak (which we ratchet ourselves) for the reference point.
      const view: PositionView = {
        ...this.toPositionView(local, new Map()),
        markPrice: live.markPrice,
        unrealizedPnl: live.unrealizedPnl,
        unrealizedPnlPercent: live.unrealizedPnlPercent,
      };

      const verdict = shouldCloseForDrawdown(view, this.deps.config);
      if (!verdict.close) continue;

      this.emit('info', verdict.reason);
      try {
        await this.executeClose(
          {
            symbol: local.symbol,
            action: local.side === 'long' ? 'close_long' : 'close_short',
            leverage: local.leverage,
            positionSizeUsd: 0,
            stopLoss: null,
            takeProfit: null,
            confidence: 100,
            riskUsd: 0,
            reasoning: verdict.reason,
            adjustments: [],
          },
          'drawdown_guard',
        );
        closed += 1;
      } catch (error) {
        this.emit(
          'error',
          `回撤守卫平仓 ${local.symbol} 失败：${(error as Error).message}`,
        );
      }
    }

    return closed;
  }

  /* ---------------------------------------------------------------------- */
  /*  Execution                                                              */
  /* ---------------------------------------------------------------------- */

  /** Market-close an entire position, then cancel its leftover protection. */
  private async executeClose(decision: Decision, reason: CloseReason): Promise<ExecutionLogEntry> {
    const traderId = this.deps.trader.id;
    const symbol = normalizeSymbol(decision.symbol);
    const local = positionStore.getOpenBySymbol(traderId, symbol);
    if (!local) {
      return {
        action: decision.action,
        symbol,
        status: 'skipped',
        detail: '本地没有该持仓的记录，无法平仓。',
      };
    }

    const clientOrderId = makeClientId('exit', symbol);
    const side: 'BUY' | 'SELL' = local.side === 'long' ? 'SELL' : 'BUY';

    // Cancel the resting stop/target FIRST. A `closePosition` algo order survives
    // a manual close and would fire into a flat book, opening a new position in
    // the opposite direction.
    await this.deps.broker.cancelAllOrders(symbol);

    try {
      const placed = await this.deps.broker.placeOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity: local.quantity,
        reduceOnly: true,
        clientOrderId,
      });

      const filled = await this.deps.broker.waitForFill(placed);
      const exitPrice = filled.avgPrice || (await this.deps.broker.getMarkPrice(symbol));
      const filledQty = filled.executedQty || local.quantity;

      // Best-effort commission capture. Fee accounting is a reporting concern,
      // so a failure here must never abort a close that has already executed.
      let fee = 0;
      try {
        const fills = await this.deps.broker.getUserTrades(symbol, 10);
        fee = fills
          .filter((fill) => String(fill.orderId) === filled.id)
          .reduce((sum, fill) => sum + (Number(fill.commission) || 0), 0);
      } catch {
        /* leave the fee at zero rather than fail the close */
      }

      this.recordOrder({
        traderId,
        exchangeOrderId: filled.id,
        clientOrderId,
        symbol,
        side,
        type: 'MARKET',
        purpose: 'exit',
        quantity: local.quantity,
        price: null,
        triggerPrice: null,
        status: filled.status,
        avgPrice: exitPrice,
        filledQty,
        fee,
        raw: filled.raw,
      });

      const isLong = local.side === 'long';
      // Prefer the exchange's realized figure and both legs' commission, exactly
      // as the reconciliation path does — this branch is the manual/model close,
      // which is the same event and must be accounted for the same way.
      const authoritative = await this.findRoundTrip(local).catch(() => null);
      const grossPnl =
        authoritative?.grossPnl ??
        (isLong ? exitPrice - local.entry_price : local.entry_price - exitPrice) * filledQty;

      const tradeId = tradeStore.insert({
        traderId,
        symbol,
        side: isLong ? 'long' : 'short',
        quantity: authoritative?.quantity ?? filledQty,
        entryPrice: local.entry_price,
        exitPrice: authoritative?.exitPrice || exitPrice,
        leverage: local.leverage,
        grossPnl,
        entryFee: authoritative?.entryFee ?? 0,
        exitFee: authoritative?.exitFee ?? fee,
        closeReason: reason,
        openedAt: local.opened_at,
        source: 'bot',
        entryOrderId: authoritative?.entryOrderId ?? null,
        exitOrderId: authoritative?.exitOrderId ?? String(filled.id),
      });

      positionStore.close(local.id);
      tradeEvents.record(traderId, symbol, 'exit');

      const record = tradeStore.list(traderId, 200).find((t) => t.id === tradeId);
      if (record) eventBus.publish({ type: 'trade', traderId, trade: record });
      const net = record?.netPnl ?? grossPnl;

      this.emit(
        'info',
        `已平仓 ${symbol} ${local.side === 'long' ? '多头' : '空头'} @ ${exitPrice} → 净 ${net >= 0 ? '+' : ''}${net.toFixed(4)} USDT（${closeReasonLabel(reason)}）`,
      );

      return {
        action: decision.action,
        symbol,
        status: 'ok',
        detail: `已按 ${exitPrice} 平掉${local.side === 'long' ? '多头' : '空头'}，净盈亏 ${net >= 0 ? '+' : ''}${net.toFixed(4)} USDT。`,
        orderId: filled.id,
        notionalUsd: filledQty * exitPrice,
      };
    } catch (error) {
      this.recordOrder({
        traderId,
        exchangeOrderId: null,
        clientOrderId,
        symbol,
        side,
        type: 'MARKET',
        purpose: 'exit',
        quantity: local.quantity,
        price: null,
        triggerPrice: null,
        status: 'REJECTED',
        avgPrice: null,
        filledQty: 0,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /** Market-enter, then immediately place exchange-side protection. */
  private async executeOpen(
    decision: Decision,
    snapshot: MarketSnapshot | undefined,
  ): Promise<ExecutionLogEntry> {
    const traderId = this.deps.trader.id;
    const symbol = normalizeSymbol(decision.symbol);
    const isLong = decision.action === 'open_long';

    if (!snapshot) {
      return {
        action: decision.action,
        symbol,
        status: 'skipped',
        detail: '该标的没有可用的行情快照。',
      };
    }

    /* --- Leverage -------------------------------------------------------- */
    const leverageResult = await this.deps.broker.setLeverage(symbol, decision.leverage);
    if (leverageResult.note) this.emit('warn', leverageResult.note);

    /* --- Size ------------------------------------------------------------ */
    const price = await this.deps.broker.getMarkPrice(symbol).catch(() => snapshot.price);
    if (!(price > 0)) {
      return { action: decision.action, symbol, status: 'skipped', detail: '没有可用价格。' };
    }

    const quantity = this.deps.registry.notionalToQuantity(symbol, decision.positionSizeUsd, price);
    if (quantity <= 0) {
      return {
        action: decision.action,
        symbol,
        status: 'rejected',
        detail: `名义价值 ${decision.positionSizeUsd.toFixed(2)} 在价格 ${price} 下取整后为 0 张。`,
      };
    }

    const clientOrderId = makeClientId('entry', symbol);
    const side: 'BUY' | 'SELL' = isLong ? 'BUY' : 'SELL';

    try {
      const placed = await this.deps.broker.placeOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity,
        clientOrderId,
      });

      const filled = await this.deps.broker.waitForFill(placed);
      const entryPrice = filled.avgPrice || price;
      const filledQty = filled.executedQty || quantity;

      this.recordOrder({
        traderId,
        exchangeOrderId: filled.id,
        clientOrderId,
        symbol,
        side,
        type: 'MARKET',
        purpose: 'entry',
        quantity,
        price: null,
        triggerPrice: null,
        status: filled.status,
        avgPrice: entryPrice,
        filledQty,
        raw: filled.raw,
      });

      const notional = filledQty * entryPrice;
      const margin = notional / Math.max(decision.leverage, 1);

      /* --- Exchange-side protection ------------------------------------- */
      // Order matters: the stop goes on first and is verified. If protection
      // cannot be placed the position is closed immediately rather than left
      // naked — an unprotected leveraged position is the worst state to be in.
      const exitSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
      let stopOrderId: string | null = null;
      let tpOrderId: string | null = null;

      if (decision.stopLoss && decision.stopLoss > 0) {
        stopOrderId = await this.placeProtection({
          symbol,
          side: exitSide,
          type: 'STOP_MARKET',
          triggerPrice: decision.stopLoss,
          purpose: 'stop_loss',
          traderId,
          quantity: filledQty,
        });
      }

      if (!stopOrderId && this.deps.config.riskControl.requireStopLoss) {
        this.emit(
          'error',
          `无法为 ${symbol} 挂上止损。为避免留下无保护的杠杆敞口，立即平掉该仓位。`,
        );
        await this.emergencyFlatten(symbol, filledQty, exitSide, traderId);
        return {
          action: decision.action,
          symbol,
          status: 'failed',
          detail: '止损挂单失败，已立即平掉该仓位。',
        };
      }

      if (decision.takeProfit && decision.takeProfit > 0) {
        tpOrderId = await this.placeProtection({
          symbol,
          side: exitSide,
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice: decision.takeProfit,
          purpose: 'take_profit',
          traderId,
          quantity: filledQty,
        });
      }

      positionStore.insert({
        traderId,
        symbol,
        side: isLong ? 'long' : 'short',
        quantity: filledQty,
        entryPrice,
        leverage: decision.leverage,
        liquidationPrice: null,
        marginUsed: margin,
        stopLoss: decision.stopLoss && decision.stopLoss > 0 ? decision.stopLoss : null,
        takeProfit: decision.takeProfit && decision.takeProfit > 0 ? decision.takeProfit : null,
        stopOrderId,
        tpOrderId,
        openReasoning: decision.reasoning,
      });

      tradeEvents.record(traderId, symbol, 'entry');

      this.emit(
        'info',
        `已开仓 ${symbol} ${isLong ? '多头' : '空头'} ${filledQty} @ ${entryPrice}（${decision.leverage}x，$${notional.toFixed(2)}）止损 ${decision.stopLoss ?? '无'} 止盈 ${decision.takeProfit ?? '无'}`,
      );

      const adjustments =
        decision.adjustments.length > 0 ? ` 运行时调整：${decision.adjustments.join(' ')}` : '';

      return {
        action: decision.action,
        symbol,
        status: 'ok',
        detail: `已开仓${isLong ? '多头' : '空头'} ${filledQty} @ ${entryPrice}。${adjustments}`,
        orderId: filled.id,
        notionalUsd: notional,
        ...(decision.adjustments.length > 0 ? { adjustments: decision.adjustments } : {}),
      };
    } catch (error) {
      this.recordOrder({
        traderId,
        exchangeOrderId: null,
        clientOrderId,
        symbol,
        side,
        type: 'MARKET',
        purpose: 'entry',
        quantity,
        price: null,
        triggerPrice: null,
        status: 'REJECTED',
        avgPrice: null,
        filledQty: 0,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Place a `closePosition=true` stop or target on the Algo Order API.
   *
   * `closePosition` is preferred over a sized `reduceOnly` order because it
   * always covers the full position however the size drifts, and cannot be left
   * behind as a partial residual. Binance forbids combining it with `quantity`,
   * which the broker strips automatically.
   */
  private async placeProtection(input: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    triggerPrice: number;
    purpose: 'stop_loss' | 'take_profit';
    traderId: number;
    quantity: number;
  }): Promise<string | null> {
    const clientOrderId = makeClientId(input.purpose, input.symbol);
    try {
      const placed = await this.deps.broker.placeOrder({
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        triggerPrice: input.triggerPrice,
        closePosition: true,
        workingType: 'MARK_PRICE',
        priceProtect: true,
        clientOrderId,
      });

      this.recordOrder({
        traderId: input.traderId,
        exchangeOrderId: placed.id,
        clientOrderId,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        purpose: input.purpose,
        quantity: input.quantity,
        price: null,
        triggerPrice: input.triggerPrice,
        status: placed.status,
        avgPrice: null,
        filledQty: 0,
        raw: placed.raw,
      });

      return placed.id;
    } catch (error) {
      this.emit(
        'error',
        `为 ${input.symbol} 挂 ${input.purpose === 'stop_loss' ? '止损' : '止盈'}（触发价 ${input.triggerPrice}）失败：${(error as Error).message}`,
      );
      this.recordOrder({
        traderId: input.traderId,
        exchangeOrderId: null,
        clientOrderId,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        purpose: input.purpose,
        quantity: input.quantity,
        price: null,
        triggerPrice: input.triggerPrice,
        status: 'REJECTED',
        avgPrice: null,
        filledQty: 0,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /** Last-resort market exit used when protection could not be established. */
  private async emergencyFlatten(
    symbol: string,
    quantity: number,
    side: 'BUY' | 'SELL',
    traderId: number,
  ): Promise<void> {
    const clientOrderId = makeClientId('flatten', symbol);
    try {
      const placed = await this.deps.broker.placeOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity,
        reduceOnly: true,
        clientOrderId,
      });
      const filled = await this.deps.broker.waitForFill(placed);
      this.recordOrder({
        traderId,
        exchangeOrderId: filled.id,
        clientOrderId,
        symbol,
        side,
        type: 'MARKET',
        purpose: 'exit',
        quantity,
        price: null,
        triggerPrice: null,
        status: filled.status,
        avgPrice: filled.avgPrice,
        filledQty: filled.executedQty,
        raw: filled.raw,
      });
      await this.deps.broker.cancelAllOrders(symbol);
      this.emit('warn', `因保护单挂单失败，已市价平掉 ${symbol}。`);
    } catch (error) {
      this.emit(
        'error',
        `${symbol} 紧急平仓失败：${(error as Error).message}。需要人工介入。`,
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  private isInCooldown(symbol: string): boolean {
    const minutes = this.deps.config.throttle.reentryCooldownMinutes;
    if (minutes <= 0) return false;
    const lastExit = tradeEvents.lastFor(this.deps.trader.id, symbol, 'exit');
    if (!lastExit) return false;
    return Date.now() - new Date(lastExit).getTime() < minutes * 60_000;
  }

  private buildPromptPositions(
    localPositions: PositionRow[],
    snapshots: Map<string, MarketSnapshot>,
  ): PromptPosition[] {
    return localPositions.map((p) => ({
      position: this.toPositionView(p, snapshots),
      snapshot: snapshots.get(p.symbol) ?? null,
      holdingMinutes: (Date.now() - new Date(p.opened_at).getTime()) / 60_000,
    }));
  }

  private toPositionView(row: PositionRow, snapshots: Map<string, MarketSnapshot>): PositionView {
    const snapshot = snapshots.get(row.symbol);
    const markPrice = snapshot?.price ?? row.entry_price;
    const isLong = row.side === 'long';
    const unrealizedPnl =
      (isLong ? markPrice - row.entry_price : row.entry_price - markPrice) * row.quantity;

    return {
      id: row.id,
      traderId: row.trader_id,
      symbol: row.symbol,
      side: isLong ? 'long' : 'short',
      quantity: row.quantity,
      entryPrice: row.entry_price,
      markPrice,
      leverage: row.leverage,
      liquidationPrice: row.liquidation_price,
      unrealizedPnl,
      unrealizedPnlPercent: row.margin_used > 0 ? (unrealizedPnl / row.margin_used) * 100 : 0,
      peakPnlPercent: row.peak_pnl_percent,
      marginUsed: row.margin_used,
      notional: row.quantity * markPrice,
      stopLoss: row.stop_loss,
      takeProfit: row.take_profit,
      openedAt: row.opened_at,
      openReasoning: row.open_reasoning,
    };
  }

  private recordOrder(input: {
    traderId: number;
    exchangeOrderId: string | null;
    clientOrderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    type: string;
    purpose: 'entry' | 'exit' | 'stop_loss' | 'take_profit' | 'adjustment';
    quantity: number;
    price: number | null;
    triggerPrice: number | null;
    status: string;
    avgPrice: number | null;
    filledQty: number;
    /** Commission reported by the exchange, when known. */
    fee?: number;
    error?: string | null;
    raw?: unknown;
  }): void {
    const id = orderStore.insert({
      traderId: input.traderId,
      exchangeOrderId: input.exchangeOrderId,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      purpose: input.purpose,
      quantity: input.quantity,
      price: input.price,
      stopPrice: input.triggerPrice,
      status: input.status,
      avgPrice: input.avgPrice,
      filledQty: input.filledQty,
      fee: input.fee ?? 0,
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.raw !== undefined ? { rawResponse: input.raw } : {}),
    });

    eventBus.publish({
      type: 'order',
      traderId: input.traderId,
      order: {
        id,
        traderId: input.traderId,
        exchangeOrderId: input.exchangeOrderId,
        clientOrderId: input.clientOrderId,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        purpose: input.purpose,
        quantity: input.quantity,
        price: input.price,
        stopPrice: input.triggerPrice,
        status: input.status,
        avgPrice: input.avgPrice,
        filledQty: input.filledQty,
        fee: input.fee ?? 0,
        error: input.error ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  }

  private async recordEquity(
    equity: number,
    availableBalance: number,
    unrealizedPnl: number,
    marginUsed: number,
    openPositions: number,
  ): Promise<void> {
    const snapshot: EquitySnapshot = {
      traderId: this.deps.trader.id,
      timestamp: new Date().toISOString(),
      equity,
      availableBalance,
      unrealizedPnl,
      marginUsed,
      openPositions,
    };
    equityStore.insert(snapshot);
    eventBus.publish({ type: 'equity', traderId: this.deps.trader.id, snapshot });
  }
}

/* -------------------------------------------------------------------------- */
/*  Module helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Client order ids are how we correlate our records with the exchange's.
 * Binance caps them at 36 characters, and the id must be persisted *before* the
 * request so an ambiguous outcome can be reconciled instead of retried.
 */
function makeClientId(prefix: string, symbol: string): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${symbol}-${stamp}-${random}`.slice(0, 36);
}
