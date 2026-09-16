import {
  closeReasonLabel,
  isCloseAction,
  isOpenAction,
  normalizeSymbol,
  orderPurposeLabel,
  type CloseReason,
  type Decision,
  type EquitySnapshot,
  type ExecutionLogEntry,
  type MarketSnapshot,
  type OrderRecord,
  type PositionView,
  type StrategyConfig,
  type Trader,
  type TraderStatus,
} from '@aq/shared';
import type { BinanceBroker, ExchangePosition } from '../binance/broker.js';
import type { AccountState } from '../binance/account.js';
import type { BinanceMarketData } from '../binance/market.js';
import type { SymbolRegistry } from '../binance/symbols.js';
import { BinanceApiError, type BinanceAlgoStatus } from '../binance/types.js';
import { eventBus } from '../events.js';
import { createLogger } from '../logger.js';
import { LlmError } from '../llm/errors.js';
import type { MarketDataService } from '../market/service.js';
import { checkCircuitBreakers, RiskEngine, shouldCloseForDrawdown } from '../risk/engine.js';
import { selectCandidates } from '../strategy/coins.js';
import { parseDecisionResponse, sortDecisions } from '../strategy/parser.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  PROMPT_PERFORMANCE_WINDOW_HOURS,
  PROMPT_RECENT_CLOSE_COUNT,
  type PromptMemory,
  type PromptPosition,
} from '../strategy/prompt.js';
import { isMajorSymbol } from '@aq/shared';
import {
  attributedEquity,
  decisions as decisionStore,
  equity as equityStore,
  orders as orderStore,
  ownUnrealizedPnlOf,
  positions as positionStore,
  tradeEvents,
  traders as traderStore,
  trades as tradeStore,
} from '../store/repositories.js';
import {
  reconstructRoundTrips,
  roundTripKey,
  roundTripQueryKey,
  type ReconstructedTrade,
} from './roundTrips.js';
import { fundingInWindow } from '../binance/income.js';

const log = createLogger('trader');

/** Row shape returned by the position repository — inferred to avoid a dup type. */
type PositionRow = ReturnType<typeof positionStore.open>[number];

/**
 * 例行对账回看多久。
 *
 * 30 天。这个窗口只需要覆盖「这个机器人还可能需要对账的成交」，不需要覆盖它
 * 全部的历史 —— 见 `reconcileTradeHistory()`。取 30 天而不是贴着一个周期，
 * 是因为交易所的 `/fapi/v1/userTrades` 只能按时间范围拉：窗口太窄会让一个
 * 长时间没动的标的彻底滑出视野（而它可能刚被交易所侧止损平掉），
 * 30 天既远大于任何一次真实的停机窗口，又把每轮对账的查询量固定在常数级别。
 * 更早的东西由周期性深对账兜底。
 */
const RECONCILE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 每多少个对账回合做一次覆盖全生命周期的深对账。
 *
 * 24 轮。以默认 15 分钟周期算约 6 小时一次，对「停机期间被交易所止损平掉」
 * 这种必须补录的事件来说足够及时；同时把 O(历史) 的扫描从每轮一次降到每天
 * 4 次。这个值**不能取太大**：深对账是「+0.6563 那笔完全没被记账」的唯一
 * 修复路径，间隔越长，账面与账户不一致持续的时间就越长。
 */
const FULL_RECONCILE_EVERY_PASSES = 24;

/**
 * 结清一张本地委托之前，它至少要有多"老"。
 *
 * ## 为什么需要这个宽限
 *
 * "这张单还在不在"的权威答案是交易所的挂单列表，但那是一次**读**：一张单从我们记下它
 * （`created_at`）到它出现在 `/fapi/v1/openOrders` / `/fapi/v1/openAlgoOrders` 里，
 * 中间可能有极短的时延（请求在途、两次读之间的竞态）。没有这个下界，一次刚好排在
 * 下单之后的读就会把**刚挂上去的保护单**判成"已经不在交易所"，在账面上把保护单抹掉 ——
 * 而 §2.6 存在的意义就是不让一个没有保护的杠杆仓位变得看不见。
 *
 * ## 为什么是 2 分钟
 *
 * 下界要远大于任何一次交易所读写的耗时（亚秒到几秒，相差两个数量级），
 * 又要小到让真正已经撤销的行不会长期挂在界面上：默认周期 15 分钟，最短 1 分钟，
 * 所以一行脏数据最多多显示一两轮就会被结清。
 */
export const ORDER_SETTLE_GRACE_MS = 2 * 60_000;

/**
 * 走 Algo 端点的条件单类型。
 *
 * 就是 `/fapi/v1/order` 会以 `-4120` 拒掉的那几种（见 `binance/types.ts`），
 * 它们的最终状态只能用 `/fapi/v1/algoOrder` 回读。
 */
const CONDITIONAL_ORDER_TYPES = new Set([
  'STOP',
  'STOP_MARKET',
  'TAKE_PROFIT',
  'TAKE_PROFIT_MARKET',
  'TRAILING_STOP_MARKET',
]);

/**
 * 条件单的 `algoStatus` → `orders.status` 里的订单状态。
 *
 * 必须翻译：`orders.status` 那一列存的是**订单**状态（`FILLED` / `CANCELED` / …），
 * 而 Algo 端点报的是它自己的状态词表（`FINISHED` / `TRIGGERED` / …），两者只有 `NEW`
 * 一个词重合。把 `FINISHED` 原样写进那一列的话：控制台既没有它的中文标签，终态集合里
 * 也没有它 —— 一张已经触发成交的止损会继续以"已挂单"的样子留在「当前委托」里，
 * 也就是这次要修的显示缺陷换个状态码重演一遍。
 *
 * `TRIGGERED` 同样记为成交：走到这里的前提是本地已经没有任何该标的的持仓，
 * 而 `closePosition=true` 条件单的唯一作用就是平掉整个仓位 —— 它触发了、仓位也没了，
 * 这一张就是成交了。
 */
const ALGO_FINAL_ORDER_STATUS: Partial<Record<BinanceAlgoStatus, string>> = {
  FINISHED: 'FILLED',
  TRIGGERED: 'FILLED',
  CANCELED: 'CANCELED',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
};

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

/**
 * 一个周期边走边累积的审计内容。
 *
 * 字段与 `decisionStore.log()` 的入参一一对应，只少了 `success` —— 它是从
 * `error` 推出来的（非空即失败），避免出现"success = true 但带着一条错误"这种
 * 自相矛盾的记录。
 */
interface CycleProgress {
  systemPrompt: string;
  userPrompt: string;
  cotTrace: string;
  decisions: Decision[];
  rawResponse: string;
  executionLog: ExecutionLogEntry[];
  candidateSymbols: string[];
  /** 非空即代表本轮失败；内容就是给操作员看的那句话。 */
  error: string | null;
  aiLatencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * 行情空窗的固定说明。
 *
 * 单独的常量：它同时被"选币为空"这条早退路径与测试断言用到，散在两处就会走样。
 */
const MARKET_DATA_UNAVAILABLE_MESSAGE =
  '行情数据不可用：本轮没有任何可用行情快照（选币为空，或所有候选标的的行情都取不到），' +
  '因此没有向模型提问、也没有下单。通常是交易所行情接口暂时不可用，机器人会在下一轮自动重试；' +
  '若连续多轮如此，请检查网络与交易所连通性。';

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

  /**
   * 每个"状态位"最近一次记下的文案。
   *
   * 用于 `emitOnChange()`：状态没变就不再记。键是状态位名（例如 `circuit-breaker`），
   * 值是上次记的文案 —— 文案变了（例如亏损比例变了）也算变化，会重新记一条，
   * 这样操作者既不会被重复刷屏，也不会漏掉数值的实质变化。
   */
  private stateNotices = new Map<string, string>();
  /**
   * 已经跑过多少次对账。决定这一次是「例行浅对账」还是「全量深对账」。
   *
   * 见 `reconcileTradeHistory()`：浅对账只覆盖最近有活动的标的与账目，
   * 深对账才扫全生命周期。计数器是进程内的 —— 重启后第一次对账一定是深对账
   * （`0 % N === 0`），正好覆盖「停机期间发生的平仓」。
   */
  private reconcilePasses = 0;
  /**
   * Resolves when the cycle that currently holds `cycleInFlight` has finished.
   *
   * The flag alone is enough to keep the timer from overlapping itself, but two
   * other things mutate the same books — an operator stopping the trader and the
   * `/reconcile` endpoint — and both used to act while a cycle was mid-flight.
   * Stop could return while the cycle was still placing orders (the process then
   * exited and shut down without closing it), and reconcile ran a **second**
   * `AutoTrader` in parallel with the live one, so both could read the same
   * position and book the same close twice.
   *
   * Holding the promise makes "is a cycle running?" an awaitable question, which
   * is what lets shutdown and reconciliation serialise against it instead of
   * guessing.
   */
  private cyclePromise: Promise<void> | null = null;
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

  /**
   * Stop the loop and **wait for the cycle already running** to finish.
   *
   * Returning while a cycle is mid-flight is what let a shutdown land between
   * "entry filled" and "stop placed": the process exited, the timer was already
   * cleared so nothing would retry, and the account was left holding an
   * unprotected leveraged position (§2.6). Waiting here means the protection
   * order is either in place or the position has been flattened before `stop()`
   * resolves — which is the state shutdown needs in order to be safe.
   */
  /**
   * @param reason 停止原因，写进日志。
   * @param persist 是否把 `stopped` 写进数据库。
   *
   * `persist: false` 是给**进程关闭**用的，不是给"操作员点了停止"用的，
   * 这个区分很关键：
   *
   * `resumePersisted()` 只恢复 `running` / `safe_mode` / `error`，**刻意不恢复
   * `stopped`** —— 因为那被当作操作员的决定，自动启动它等于代码推翻人。
   *
   * 但关闭流程也会走 `stop()`。如果它照样写 `stopped`，那么**每一次部署或重启
   * 都会把所有机器人变成"操作员手动停止"**，重启后不再恢复 —— 机器人就此静默
   * 停摆，而控制台上看不出任何异常（状态显示为 stopped，像是有人点过）。
   *
   * 这个 bug 真实发生过：加了优雅停机之后，一次部署就静默停掉了正在跑的机器人。
   * 关闭是进程行为，不是人的决定，所以它不该留下"人的决定"这个痕迹。
   */
  async stop(reason = '操作员手动停止', persist = true): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const drained = await this.waitForIdle();
    if (!drained) {
      /*
       * The wait is bounded so a wedged exchange call cannot hang shutdown
       * forever — but a timeout must be **loud**, because the state it leaves is
       * the dangerous one: the cycle may be sitting between "entry filled" and
       * "stop placed", and the next cycle that would have fixed it can never run
       * now that the loop is stopped. That needs a human.
       */
      this.emit(
        'error',
        `停止时上一轮决策未在时限内结束，可能留下未挂保护单的仓位。请人工核对交易所持仓与挂单。`,
      );
    }
    if (persist) this.setStatus('stopped', null);
    this.emit('info', `机器人「${this.deps.trader.name}」已停止（${reason}）`);
  }

  /**
   * Resolve once no cycle is running.
   *
   * `timeoutMs` bounds the wait so shutdown can never hang forever on a stuck
   * exchange call — but it returns `false` in that case rather than pretending
   * the cycle finished, so the caller can say so in the log.
   */
  async waitForIdle(timeoutMs = 60_000): Promise<boolean> {
    const pending = this.cyclePromise;
    if (!pending) return true;
    return Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
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

  /**
   * 记一条属于本机器人的日志。
   *
   * ⚠️ **只走 logger 这一条路径**，不要在这里再 `runtimeLogs.write()` 与
   * `eventBus.publish()` 一次。
   *
   * 原来三样都做，而 `log[level]()` 会触发全局 sink（`server.ts` 的
   * `setLogSink`），sink 同样写库、同样推事件 —— 于是**一条日志变成两条库记录
   * 加两个前端事件**，界面上同一句话出现两遍。而且两条记录的归属还对不上：
   * sink 那条 `trader_id = NULL`（并带上 scope 前缀），这里那条才有真实 id。
   *
   * 现在把归属通过 `meta` 交给 sink，由它统一落盘与推送：
   *   · `traderId` —— 这条日志属于哪个机器人
   *   · `raw`      —— 不带机器人名前缀的原文（stdout 仍用带前缀的版本，
   *                   数据库与界面里则由 `trader_id` 表达归属，不必重复写名字）
   */
  private emit(level: 'info' | 'warn' | 'error', message: string): void {
    log[level](`[${this.deps.trader.name}] ${message}`, {
      traderId: this.deps.trader.id,
      raw: message,
    });
  }

  /**
   * 只在**状态发生变化**时记一条，状态没变就不记。
   *
   * 用于"每个周期都成立"的状态（熔断生效、候选池被预算裁剪）。它们**每轮都会
   * 再次成立**，按事件每轮写一次的结果是：日志被同一句话填满，真正的异常被埋掉
   * —— 一个每轮都响的警告等于没有警告。
   *
   * 只在**进入**该状态时记一次；状态解除后再进入会重新记一次（这正是操作者
   * 需要知道的两个时刻：什么时候开始的、什么时候结束的）。
   *
   * `key` 用来区分不同的状态位（同一个机器人可能同时有多条这类状态）。
   */
  private emitOnChange(key: string, level: 'info' | 'warn', message: string): void {
    if (this.stateNotices.get(key) === message) return;
    this.stateNotices.set(key, message);
    this.emit(level, message);
  }

  /** 状态解除：下一次再进入时会重新记一条。 */
  private clearStateNotice(key: string): void {
    this.stateNotices.delete(key);
  }

  /**
   * Mark a cycle as in flight for its whole duration.
   *
   * One place owns the flag and the promise so they can never disagree: the flag
   * is what stops the timer from overlapping itself, and the promise is what lets
   * `stop()` and the reconcile endpoint wait for the cycle to finish instead of
   * writing the books underneath it.
   */
  private async inCycle<T>(work: () => Promise<T>): Promise<T> {
    this.cycleInFlight = true;
    let done: () => void = () => undefined;
    this.cyclePromise = new Promise<void>((resolve) => {
      done = resolve;
    });
    try {
      return await work();
    } finally {
      this.cycleInFlight = false;
      this.cyclePromise = null;
      done();
    }
  }

  /**
   * Run exactly one cycle, outside the timer.
   *
   * Used by the console's "run now" action and by integration tests. Unlike
   * `tick()` it does not swallow failures, so a caller sees the real error.
   */
  async runOnce(): Promise<string> {
    if (this.cycleInFlight) throw new Error('上一轮决策尚未结束，请稍后再试。');
    return this.inCycle(async () => {
      this.cycleNumber += 1;
      const summary = await this.runCycle(this.cycleNumber);
      traderStore.recordCycle(this.deps.trader.id, this.cycleNumber, 0);
      if (this.status === 'safe_mode') this.setStatus('running', null);
      return summary;
    });
  }

  /**
   * Run the ledger reconciliation pass, serialised against any running cycle.
   *
   * The `/reconcile` endpoint used to build a **second** `AutoTrader` over the
   * same exchange account and let it run while the live one was mid-cycle. Both
   * then reconciled the same position concurrently: both could see the position
   * gone, both could book the close, and one of them could close the local row
   * the other had just closed. Two writers, one ledger.
   *
   * Serialising means an in-flight cycle finishes (and books what it is going to
   * book) before the correction pass reads the ledger — so the pass corrects
   * rather than races.
   */
  async runReconcile(): Promise<{ recovered: number; corrected: number; funding: number }> {
    const idle = await this.waitForIdle();
    if (!idle) {
      // The cycle is stuck on something slow rather than finished. Skipping is
      // safe: the cycle reconciles at its own head, and this pass is a repair,
      // not a source of truth. Racing it would be the actual damage.
      this.emit('warn', '上一轮决策未在等待时限内结束，本次对账跳过，避免与交易周期并发写账。');
      return { recovered: 0, corrected: 0, funding: 0 };
    }
    return this.reconcileTradeHistory();
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

    const traderId = this.deps.trader.id;

    try {
      await this.inCycle(async () => {
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
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  One full decision cycle                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * 跑一个周期，并保证**无论发生什么都写出恰好一条审计记录**。
   *
   * ## 为什么落库点必须在这里
   *
   * 原来写记录是周期里的第 11 步，位置在模型调用与执行**之后**，而且硬编码
   * `success: true, error: null`。于是任何一种中途失败 —— 模型调用抛错（欠费、
   * 被服务商拒绝、网络故障）、交易所拒单、行情取不到 —— 都会直接退出
   * `runCycle()`，**一条记录都不写**：决策流里什么都看不到。实盘上正在发生的就是
   * 这件事，一个欠费的模型供应商让每一轮都失败，而操作员在控制台上看不到任何迹象；
   * `decision_records.success` / `error` 两列从一开始就在，只是从来没有被写过。
   *
   * 现在的结构是：
   *
   *   1–12 步本体（`runCycleBody`）→ 把已经拿到的内容填进 `progress`
   *   第 11 步落库                → 本方法里**唯一**的一次 `decisionStore.log()`
   *   失败继续抛                  → `tick()` 的连续失败计数与安全模式不变
   *
   * 唯一的那次写入放在本体**之后**，是为了让"一个周期恰好一条记录"成为结构性
   * 保证：本体抛错也好、正常结束也好，都走同一个落库点。第 12 步（刷新与权益快照）
   * 因此排在落库之前执行；它只做对账与展示快照、不下任何单，所以
   * "先减少风险、后增加风险"的顺序（§2.9）没有变化。
   */
  private async runCycle(cycleNumber: number): Promise<string> {
    const traderId = this.deps.trader.id;

    /*
     * 本轮**已经拿到的东西**，边走边填。
     *
     * 记录必须做到"部分成功也留痕"：如果行情与模型调用都成功了、只有执行那一步抛了，
     * 提示词、思维链、决策与执行日志还是要照样落库。等最后再拼一个完整对象做不到
     * 这一点 —— 任何一步抛错都会把后面所有字段一起丢掉，而操作员看到的又会是一条
     * "什么都没发生"的失败，正是本次要修的那个观测空洞的另一种形态。
     */
    const progress: CycleProgress = {
      systemPrompt: '',
      userPrompt: '',
      cotTrace: '',
      decisions: [],
      rawResponse: '',
      executionLog: [],
      candidateSymbols: [],
      error: null,
      aiLatencyMs: 0,
      promptTokens: null,
      completionTokens: null,
    };

    /** 失败发生在哪一段。只在错误类型本身说明不了问题时才用得上（见 `describeCycleFailure`）。 */
    const state = { phase: 'bookkeeping' as CycleFailurePhase };
    /** 抛出的原始错误：记录落库之后要原样继续抛出去。 */
    let thrown: unknown = null;
    let summary: string | null = null;

    try {
      summary = await this.runCycleBody(cycleNumber, progress, state);
    } catch (error) {
      thrown = error;
      progress.error = describeCycleFailure(error, state.phase);
    }

    /* --- 11. Persist the audit record ------------------------------------ */
    // 没有硬编码的 `success`：`progress.error` 非空就是失败。"一个周期恰好一条"
    // 由"本方法只有一个写入点"保证，而不是靠调用方自觉。
    const recordId = decisionStore.log({
      traderId,
      cycleNumber,
      ...progress,
      success: progress.error === null,
    });

    const record = decisionStore.get(recordId);
    if (record) eventBus.publish({ type: 'decision', traderId, record });

    /*
     * 失败要**继续抛出去**。
     *
     * `tick()` 的连续失败计数、安全模式，以及操作员在日志里看到的那句话，全都建立
     * 在"runCycle 会抛错"这个前提上。在这里吞掉异常等于顺手改掉了失败策略 ——
     * 本次改动只负责把失败**记录下来**，不负责改变机器人的行为（不加退避、不熔断、
     * 不猜重试次数：供应商欠费时每一轮重试本来就是对的，充值后自然会恢复）。
     */
    if (thrown) throw thrown;
    return summary ?? '';
  }

  /**
   * 一个完整决策周期的 1–12 步本体。
   *
   * 与 `runCycle()` 分成两个方法，是为了让"记录恰好写一条"成为**结构性**保证：
   * 落库点在 `runCycle()` 里，且只有一个，本体无论抛错还是正常结束都经过它。
   * 写在一个方法里的话，异常路径就必须在本体中间再补一次写入，而"一个周期写两条"
   * 或"一条都不写"又会重新变成可能。
   *
   * 本体只额外做一件事：把已经拿到的内容填进 `progress`。行情为空这类
   * "什么也没做、但不是异常"的结束方式，把说明写进 `progress.error` 后正常返回 ——
   * **刻意不抛错**，因为抛错会推进 `tick()` 的连续失败计数并可能把机器人送进安全
   * 模式，那是行为变更；这里只补记录。
   */
  private async runCycleBody(
    cycleNumber: number,
    progress: CycleProgress,
    state: { phase: CycleFailurePhase },
  ): Promise<string> {
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
    await this.reconcileTradeHistory(false).catch((error) => {
      log.warn(`[${this.deps.trader.name}] 成交对账失败（不影响本周期交易）：${(error as Error).message}`);
    });

    const exchangePositions = await this.deps.broker.getPositions();
    await this.reconcilePositions(exchangePositions);

    /* --- 3. Mechanical protections --------------------------------------- */
    const closedByGuard = await this.applyDrawdownGuard();

    /* --- 4. Circuit breakers --------------------------------------------- */
    /*
     * The watermark is the *realised* peak, not the mark-to-market peak.
     *
     * `account.equity` is margin balance, so it carries the open positions'
     * unrealised PnL. Feeding that into the watermark made one unrealised spike
     * permanent: price wicks up, the watermark records the wick, price comes
     * back, and every following cycle reports a drawdown that never happened —
     * so `maxTotalDrawdownPercent` blocks every new entry for good, with only a
     * log line to say why.
     *
     * The current figure stays `account.equity` on purpose: an *open* loss is
     * real money at risk, and a guard that only noticed closed losses would let
     * the account bleed through a single losing position. What must not inflate
     * the peak is unrealised *profit*.
     */
    const highWater = equityStore.realizedHighWaterMark(traderId);
    const breaker = checkCircuitBreakers(config, account.equity, {
      dailyRealizedPnl: tradeStore.realizedPnlToday(traderId),
      highWaterEquity: highWater,
    });
    if (breaker.blocked) {
      // 每轮都成立的**状态**，只在进入时记一次（详见 emitOnChange 的说明）。
      this.emitOnChange('circuit-breaker', 'warn', breaker.reason);
    } else {
      // 解除：先记一条"恢复"，再清掉状态，这样"什么时候恢复的"也有记录。
      if (this.stateNotices.has('circuit-breaker')) {
        this.clearStateNotice('circuit-breaker');
        this.emit('info', '熔断已解除，恢复正常决策。');
      }
    }

    /* --- 5. Refresh state after the guard's closes ----------------------- */
    const livePositions = await this.deps.broker.getPositions();
    const localPositions = positionStore.open(traderId);

    /*
     * 熔断生效 + 手上没有任何仓位 = 本轮**不可能**有任何可执行的动作，
     * 因此跳过这一轮的全部昂贵工作。
     *
     * 为什么以前不是这样：熔断在步骤 4 检查，却到步骤 8 才真正拦截决策 ——
     * 中间隔着"抓 11 个标的的行情（每个约 5,159 tokens）+ 构建 5.8 万 token
     * 提示词 + 请求模型"。于是熔断生效期间，每个周期都在**付费生成一批注定被
     * 丢弃的决策**。实测：约 134 万 tokens/小时，产出为零，而熔断按"单日"
     * 计算，可能持续数小时。
     *
     * ⚠️ 条件必须是「**且没有任何仓位**」，不能只看熔断：
     * 熔断只拦新开仓，**不拦平仓**。有仓位时模型必须继续跑，因为它的决策里
     * 可能有平仓 —— 那时省下的钱会变成没平掉的风险敞口。
     *
     * 本地与交易所两边的持仓都为空才跳过：两边不一致时保守地照常跑，
     * 宁可多花一次调用的钱，也不要跳过一轮本该处理的对账/平仓。
     *
     * 早退方式与"行情为空"一致：写进 `progress.error` 后**正常返回**，
     * 不抛错，所以连续失败计数与安全模式完全不受影响。
     */
    /*
     * 每小时开仓额度是否已用满。
     *
     * 在**跳过判据之前**读，而不是等到组装提示词时 —— 判据要用它。
     * 只能读一次：分头读会得到两个可能不一致的数字，而"模型看到 2/3、
     * 风控按 3/3"这种不一致会让模型提出注定被拒的请求。
     */
    const entriesLastHour = tradeEvents.entriesThisHour(traderId);
    const quotaExhausted = entriesLastHour >= config.throttle.maxEntriesPerHour;

    if ((breaker.blocked || quotaExhausted) && livePositions.length === 0 && localPositions.length === 0) {
      await this.recordEquity(account, livePositions);
      /*
       * ⚠️ 说明写进 `executionLog`，**不写 `progress.error`**。
       *
       * `progress.error` 的契约是「非空即代表本轮失败」（`success: progress.error === null`）。
       * 而熔断拦住开仓**不是失败，是系统在正常工作** —— 往失败字段里塞正常状态，
       * 会让成功率统计虚低、让监控把正常状态报成故障，然后有人去追一个不存在的
       * 问题。这类"语义用错字段"的代价，比一次多花的模型调用钱更贵。
       *
       * `executionLog` 是记录"这一轮实际发生了什么"的地方，而 `skipped`
       * 正是它的合法取值之一（与熔断拒绝决策时用的是同一个状态）。
       */
      /*
       * 说清**是哪个条件**触发的跳过，并给出解除它的条件。
       *
       * 两个条件的解除方式完全不同：熔断按"单日"结算，要等到第二天；
       * 额度按小时滚动，最迟下一个整点就恢复。把它们写成同一句话，
       * 操作者就分不清"还要等多久"。
       */
      const blocker = breaker.blocked
        ? `熔断生效：${breaker.reason}`
        : `本小时开仓额度已用满（${entriesLastHour} / ${config.throttle.maxEntriesPerHour} 笔）`;
      const recovery = breaker.blocked
        ? '熔断按单日结算，跨过零点后自动恢复。'
        : '额度按小时滚动，最迟下一个整点恢复。';

      progress.executionLog = [
        {
          action: 'skip_cycle',
          symbol: '—',
          status: 'skipped',
          detail:
            `${blocker}，且当前没有任何持仓。` +
            '本轮没有向模型提问、也没有下单 —— 此时模型不可能给出任何可执行的动作，' +
            `跳过请求是为了不产生无谓的 token 开销。${recovery}`,
        },
      ];
      return breaker.blocked ? '熔断生效且空仓，本轮跳过模型请求。' : '本小时额度已满且空仓，本轮跳过模型请求。';
    }

    /* --- 6. Candidate universe + market snapshots ------------------------ */
    // 从这里到快照就绪之间抛出的都是普通 `Error`（行情层不发明错误类型），
    // 失败说明里的类别全靠这个阶段标记。
    state.phase = 'market';
    const held = localPositions.map((p) => p.symbol);
    const selection = await selectCandidates(config, this.deps.marketData, { mustInclude: held });

    const snapshots = await this.deps.marketData.buildSnapshots(
      selection.symbols,
      config.indicators,
      selection.sourcesBySymbol,
    );

    progress.candidateSymbols = snapshots.map((s) => s.symbol);

    if (snapshots.length === 0) {
      await this.recordEquity(account, livePositions);
      /*
       * 行情为空同样要留下记录 —— 这是本次修复要补的观测空洞的第二种形态：
       * 一个什么都没做的周期在决策流里也必须看得见。写进 `progress.error`
       * 之后**正常返回**而不是抛错，连续失败计数与安全模式因此完全不变。
       */
      progress.error = MARKET_DATA_UNAVAILABLE_MESSAGE;
      return '没有可用的行情数据，本轮未产生任何决策。';
    }

    const snapshotBySymbol = new Map(snapshots.map((s) => [s.symbol, s]));

    /* --- 7. Ask the model ------------------------------------------------ */
    const promptPositions = this.buildPromptPositions(localPositions, snapshotBySymbol);
    const oiRanking = config.indicators.enableOiRanking
      ? await this.deps.marketData.getOiRanking(15).catch(() => [])
      : [];

    /*
     * 本小时的已开仓数只读一次，两处用同一个数：提示词的「本周期约束」区块与风控的
     * `entriesLastHour`。分头读会得到两个可能不一致的数字，而模型看到 2/3、风控按 3/3
     * 拒绝，正是"看不见的约束"换一种形态。
     */
    // 已在步骤 4 之前读取（跳过判据要用），此处不再重复读 —— 分头读会得到两个可能不一致的数字。
    const memory = this.buildPromptMemory(traderId, config, entriesLastHour);

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
      oiRanking,
      memory,
    };

    const systemPrompt = buildSystemPrompt(promptContext);
    const userPrompt = buildUserPrompt(promptContext);

    /*
     * 提示词在**发请求之前**就填进进度对象：这是"部分成功也留痕"的关键一步 ——
     * 模型调用抛错（欠费 / 被拒 / 网络）时，操作员仍然能拿到这一轮原本要问什么。
     */
    progress.systemPrompt = systemPrompt;
    progress.userPrompt = userPrompt;

    const startedAt = Date.now();
    state.phase = 'model';
    const response = await this.deps.model.complete(systemPrompt, userPrompt);
    progress.aiLatencyMs = response.latencyMs || Date.now() - startedAt;
    progress.promptTokens = response.usage.promptTokens;
    progress.completionTokens = response.usage.completionTokens;

    /* --- 8. Parse -------------------------------------------------------- */
    state.phase = 'parse';
    const openPositionMap = new Map<string, 'long' | 'short'>(
      localPositions.map((p) => [p.symbol, p.side as 'long' | 'short']),
    );
    const parsed = parseDecisionResponse(response.text, {
      candidateSymbols: new Set(snapshots.map((s) => s.symbol)),
      openPositions: openPositionMap,
      allowUnlistedCloses: true,
    });

    progress.cotTrace = parsed.cotTrace;
    progress.decisions = parsed.decisions;
    progress.rawResponse = parsed.rawResponse;

    const executionLog: ExecutionLogEntry[] = parsed.rejected.map((r) => ({
      action: r.action,
      symbol: r.symbol,
      status: 'rejected' as const,
      detail: r.reason,
    }));
    // 同一个数组对象：下面每 push 一条，进度对象里也是最新的（step 10 的失败条目同理）。
    progress.executionLog = executionLog;

    /* --- 9. Hard risk review --------------------------------------------- */
    state.phase = 'risk';
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
      entriesLastHour,
      /*
       * 手续费感知门槛用的费率。**实测优先**（窗口内的 Σ手续费 / Σ名义价值），
       * 读不到成交时留 null，由引擎回落到配置的兜底费率 —— 提示词里那条硬性约束
       * 用的是同一个取值规则，两边不会各说各话。
       */
      roundTripFeeRate: memory.performance.roundTripFeeRate,
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
    // 普通 `Error`（网络层、响应解析）在这个阶段抛出，就是"订单没有得到交易所确认"。
    state.phase = 'execute';
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

    /* --- 12. Refresh and snapshot ---------------------------------------- */
    /*
     * 第 12 步排在落库（第 11 步）之前，见 `runCycle()` 的说明：这样它自己抛错时
     * 也会写成一条失败记录，而不是留下一条写着"成功"的记录。它只做对账与展示
     * 快照，不下任何单。
     *
     * 阶段标记回到 `bookkeeping`：这里读到的是交易所的持仓 / 账户，抛错意味着对账
     * 失败，而不是"订单被拒"。
     */
    state.phase = 'bookkeeping';
    const finalPositions = await this.deps.broker.getPositions().catch(() => livePositions);
    await this.reconcilePositions(finalPositions);

    const finalAccount = await this.deps.broker.getAccountState().catch(() => account);
    await this.recordEquity(finalAccount, finalPositions);

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

      await this.bookVanishedPosition(local);
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
   * Book a local position the exchange no longer holds, and close the row.
   *
   * There are two ways to learn a position vanished — a cycle comparing the
   * exchange's position list, and the ledger pass at the head of every cycle —
   * and both must produce the **same** record. This is that single path, so
   * neither one can close a row without booking the round-trip it represents.
   *
   * The exit is recovered from the exchange's fill record rather than assumed:
   * the reason detection needs it too, because when the exchange cannot tell us
   * which order fired, the exit price relative to the two levels is what
   * disambiguates a stop from a target.
   */
  private async bookVanishedPosition(local: PositionRow): Promise<void> {
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
    /** Exchange fill time, when known. Funding is attributed to the real window. */
    closedAtInput?: string,
  ): Promise<{ netPnl: number; grossPnl: number; exitPrice: number; quantity: number }> {
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
    const closedAt = authoritative?.closedAt || closedAtInput || new Date().toISOString();

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

    /*
     * Funding is read here, at the moment of closing, and not only during the
     * reconciliation pass.
     *
     * Funding settles every 8 hours and appears in **no** fill, so it can only
     * come from `/fapi/v1/income`. It used to be attributed on the reconcile
     * path alone — but that path only touches a row it can match, and a close
     * booked live with figures the reconcile could not match kept
     * `funding_fee = 0` forever. A position held across a settlement then showed
     * a net PnL that was better than the account's, which is exactly the
     * divergence §2.5 forbids.
     */
    const fundingFee = await this.fundingFor(local.symbol, local.opened_at, closedAt);

    /*
     * 上锁前先问一次：这一回合是不是已经记过账了？
     *
     * 对账（`reconcileTradeHistory`）在周期开头跑，`reconcilePositions` 在周期末尾跑，
     * 两者都可能看到同一个已经消失的仓位。`positionStore.close()` 只能保证**本进程内**
     * 不会重复记账，而这里要保证的是"同一个真实回合在 `trades` 里只有一行"——
     * 所以判定必须在写账之前，用的身份与 `trades.insert()` 里的完全一致
     * （`trades.findDuplicate()` 是同一个实现，不存在两套判据）。
     */
    const alreadyBooked = tradeStore.findDuplicate({
      traderId,
      symbol: local.symbol,
      quantity: authoritative?.quantity ?? local.quantity,
      entryPrice: local.entry_price,
      closedAt,
      entryOrderId: authoritative?.entryOrderId ?? null,
    });
    if (alreadyBooked !== null) {
      if (authoritative) {
        /*
         * 运行期拿到了成交记录的权威口径，就把它写到已有那一行上 —— 这正是
         * §2.5 的"重复执行只修正"：`net_pnl` 仍然只在
         * `trades.insert()` / `applyExchangeFigures()` 里算过一次。
         *
         * 为什么必须修正而不是"找到就什么都不做"：运行期与对账对同一回合取到的
         * 数量口径本来就可能不同（本地持仓量 vs 交易所实际成交量）。如果只认"已存在"
         * 而把交易所的数字丢掉，账本里留下的就是那个较粗的口径 —— 与账户对不上，
         * 而 §2.5 要求账目必须能与交易所对得上。
         */
        tradeStore.applyExchangeFigures({
          id: alreadyBooked,
          grossPnl: authoritative.grossPnl,
          entryFee: authoritative.entryFee,
          exitFee: authoritative.exitFee,
          fundingFee,
          entryPrice: authoritative.entryPrice,
          exitPrice: authoritative.exitPrice,
          quantity: authoritative.quantity,
          leverage: local.leverage,
          entryOrderId: authoritative.entryOrderId || null,
          exitOrderId: authoritative.exitOrderId || null,
        });
      }
      positionStore.close(local.id);
      tradeEvents.record(traderId, local.symbol, 'exit');
      const existing = tradeStore.list(traderId, 200).find((t) => t.id === alreadyBooked);
      this.emit(
        'info',
        `${local.symbol} 的平仓此前已入账（第 #${alreadyBooked} 笔），本次不再重复记录；净 ${(existing?.netPnl ?? 0).toFixed(4)} USDT。`,
      );
      return {
        netPnl: existing?.netPnl ?? 0,
        grossPnl: existing?.pnl ?? grossPnl,
        exitPrice: existing?.exitPrice ?? exitPrice,
        quantity: existing?.quantity ?? local.quantity,
      };
    }

    const booked = tradeStore.insert({
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
      fundingFee,
      closeReason: reason,
      openedAt: local.opened_at,
      closedAt,
      source: 'bot',
      entryOrderId: authoritative?.entryOrderId ?? null,
      exitOrderId: authoritative?.exitOrderId ?? null,
      // 这是一笔真实平仓：先查重，别把同一回合记两次（§2.5 的幂等）。
      idempotent: true,
    });
    const tradeId = booked.id;

    positionStore.close(local.id);
    tradeEvents.record(traderId, local.symbol, 'exit');

    const record = tradeStore.list(traderId, 200).find((t) => t.id === tradeId);
    if (record) eventBus.publish({ type: 'trade', traderId, trade: record });

    /*
     * Log the **net** figure: it is what actually moved the balance, and the
     * gross number was what made the console disagree with the account.
     */
    const net = record?.netPnl ?? grossPnl - entryFee - exitFee - fundingFee;
    const sign = net >= 0 ? '+' : '';
    const costNote =
      entryFee + exitFee > 0 ? `，含手续费 ${(entryFee + exitFee).toFixed(4)}` : '';
    const fundingNote = fundingFee !== 0 ? `，含资金费 ${fundingFee.toFixed(4)}` : '';
    if (!booked.created) {
      /*
       * 这一回合已经记过账了（对账先补录、运行期后到），`insert()` 把那一行还了回来。
       * 不新增行，也**不再播报一次"已平仓"** —— 否则操作员会以为账户上真的平了两次。
       * 保留的仍是运行期发现的平仓原因（`stop_loss` / `take_profit` 比 `reconciled`
       * 信息多），所以这里只把重复这件事说清楚。
       */
      this.emit(
        'info',
        `${local.symbol} 的平仓此前已入账（第 #${tradeId} 笔），本次不再重复记录；净 ${sign}${net.toFixed(4)} USDT。`,
      );
    } else {
      this.emit(
        'info',
        `已平仓 ${local.symbol} ${local.side === 'long' ? '多头' : '空头'} @ ${exitPrice} → 净 ${sign}${net.toFixed(4)} USDT（毛 ${grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(4)}${costNote}${fundingNote}，${closeReasonLabel(reason)}）`,
      );
    }

    return {
      netPnl: net,
      grossPnl,
      exitPrice,
      quantity: authoritative?.quantity ?? local.quantity,
    };
  }

  /**
   * Funding paid or received on one symbol over a round-trip's own lifetime.
   *
   * Returns 0 — never a guess — when the income ledger cannot be read, and says
   * so in the log. Recording 0 is the honest answer (§2.5: 不要假装算过); the
   * reconcile pass re-reads the ledger later and overwrites the row with the
   * real figure if this read failed.
   */
  private async fundingFor(symbol: string, openedAt: string, closedAt: string): Promise<number> {
    try {
      /*
       * The ledger is read from `openedAt`, not from the trader's creation time:
       * a close is a one-off event, and asking for days of history to attribute
       * eight hours of funding would spend weight on every exit for no gain.
       */
      const events = await this.deps.broker.getIncome({
        startTime: new Date(openedAt).getTime(),
        endTime: new Date(closedAt).getTime() + 60_000,
      });
      return fundingInWindow(events, symbol, openedAt, closedAt);
    } catch (error) {
      log.warn(
        `[${this.deps.trader.name}] ${symbol} 的资金费读取失败，本次记 0，待对账时补齐：${(error as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * Find this position's completed round-trip in the exchange's fill history.
   *
   * Matched on the **entry order id** (with symbol + quantity + entry price) —
   * see `roundTripKey` — rather than on time, because the local record's
   * `opened_at` is when the runtime decided and the exchange's is when the order
   * filled.
   */
  private async findRoundTrip(local: PositionRow): Promise<ReconstructedTrade | null> {
    const fills = await this.deps.broker.getUserTrades(local.symbol, 50);
    const completed = reconstructRoundTrips(fills);

    /*
     * The entry order id is the exact discriminator when it is known, and the
     * local position row does not carry one — so this lookup matches on the
     * descriptive part (symbol + quantity + entry price). That is a **lookup for
     * figures**, not a key for overwriting another row: the strict key is written
     * onto the trade row, and it is the trade row that reconciliation matches on.
     */
    const wanted = roundTripQueryKey({
      symbol: local.symbol,
      quantity: local.quantity,
      entryPrice: local.entry_price,
    });
    return (
      completed.find(
        (t) =>
          roundTripQueryKey({ symbol: t.symbol, quantity: t.quantity, entryPrice: t.entryPrice }) ===
          wanted,
      ) ?? null
    );
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
   *
   * `full` chooses the **time window**, and the distinction is about cost, not
   * correctness. Every pass asks one `/fapi/v1/userTrades` question per symbol in
   * scope (up to 500 fills each), and re-reads local history through
   * `trades.ledger()` / `trades.tradedSymbols()` — so a pass whose window is
   * "everything this trader ever did" gets more expensive every week it runs,
   * while answering a question whose answer can only have changed for symbols
   * that traded recently.
   *
   *  · `full: true`  — window from the trader's creation. Used at start (inside
   *    `start()`), by the operator-triggered `/reconcile`, and once every
   *    `FULL_RECONCILE_EVERY_PASSES` passes. This is the pass that recovers a
   *    close the process slept through.
   *  · `full: false` — window of `RECONCILE_WINDOW_MS`. Used by the routine
   *    cycle. Anything it skips is still inside the *next* deep pass's window, so
   *    nothing becomes permanently invisible.
   *
   * The deep pass deliberately still runs: skipping it entirely would leave a
   * symbol that traded once and then went quiet unrecoverable forever, which is
   * exactly the bug this whole method exists for.
   */
  async reconcileTradeHistory(
    full = true,
  ): Promise<{ recovered: number; corrected: number; funding: number }> {
    const traderId = this.deps.trader.id;
    const deep = full || this.reconcilePasses % FULL_RECONCILE_EVERY_PASSES === 0;
    this.reconcilePasses += 1;

    const createdSince = new Date(this.deps.trader.createdAt).getTime() - 60_000;
    /*
     * The window floor. A deep pass keeps the original "since this trader
     * existed" bound; a routine pass narrows it. `Math.max` with the creation
     * time keeps a *young* trader's window small as well — a trader created an
     * hour ago must not ask the exchange for a month of income history it cannot
     * have.
     */
    const since = deep
      ? createdSince
      : Math.max(createdSince, Date.now() - RECONCILE_WINDOW_MS);
    const sinceIso = new Date(since).toISOString();

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

    /*
     * Symbols in scope for this pass.
     *
     * Open positions are always included regardless of the window — a position
     * this trader is actually holding must have its fills checked even when its
     * local trade row is older than the window. Only the traded-symbol list is
     * windowed, and only on a routine pass.
     */
    const symbols = new Set<string>([
      ...tradeStore.tradedSymbols(traderId, deep ? undefined : sinceIso),
      ...positionStore.open(traderId).map((p) => p.symbol),
      ...incomeEvents.map((e) => e.symbol).filter((s): s is string => Boolean(s)),
    ]);

    /*
     * Two indexes over the same rows.
     *
     * `byKey` is the strict key (symbol + qty + entry price + entry order id) and
     * is what prevents one round-trip's exchange figures from being written onto
     * another row: two entries of the same size at the same price are only the
     * same trade if they are the same order.
     *
     * `byDescription` holds rows that carry **no** entry order id — booked before
     * the id was known, or from an adopted position. Those can only be matched on
     * their description, and keeping them in a separate index that is consulted
     * only after the strict lookup fails means the ambiguous match can never
     * shadow an exact one.
     */
    // Bounded the same way: a routine pass only needs the rows it can still match.
    const ledger = tradeStore.ledger(traderId, deep ? undefined : sinceIso);
    const byKey = new Map(
      ledger.map((t) => [
        roundTripKey({
          symbol: t.symbol,
          quantity: t.quantity,
          entryPrice: t.entryPrice,
          entryOrderId: t.entryOrderId,
        }),
        t.id,
      ]),
    );
    const byDescription = new Map(
      ledger
        .filter((t) => !t.entryOrderId)
        .map((t) => [
          roundTripQueryKey({ symbol: t.symbol, quantity: t.quantity, entryPrice: t.entryPrice }),
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
        /*
         * Exact match first. Only when no row owns this entry order do we fall
         * back to the description-only index, and only for rows that have no
         * entry order id of their own — so an ambiguous row can never be
         * overwritten by, or overwrite, an identified one.
         */
        const existingId =
          byKey.get(key) ??
          byDescription.get(
            roundTripQueryKey({
              symbol: trip.symbol,
              quantity: trip.quantity,
              entryPrice: trip.entryPrice,
            }),
          );

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
          /*
           * The row now owns this entry order, so it moves out of the
           * description-only index — otherwise a later identical-looking
           * round-trip could still match it by description.
           */
          byKey.set(key, existingId);
          byDescription.delete(
            roundTripQueryKey({
              symbol: trip.symbol,
              quantity: trip.quantity,
              entryPrice: trip.entryPrice,
            }),
          );
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
        /*
         * 这段"归属闸门"（`ownOrders`）必须先说清楚它管什么、不管什么：
         * 它回答的是"这一回合是不是**本机器人**开的"，用来防止同一个交易所账户下的
         * 多个机器人各自把账户的全部盈亏记到自己账上。
         *
         * 它**不**回答"这一回合是不是已经记过账了"。运行期从本地持仓行记的那一行
         * 完全属于这台机器人，闸门照样放行 —— 于是同一回合被记两次（实盘上
         * SYNUSDT 99/169、LSKUSDT 35 三组，凭空多出 +0.4954）。幂等由
         * `trades.insert()` 内部的身份判定负责（见 `trades.findDuplicate()`），
         * 而不是由这道闸门负责；两者的职责不要混。
         */
        if (!trip.entryOrderId || !ownOrders.has(trip.entryOrderId)) {
          log.debug(
            `[${this.deps.trader.name}] 跳过非本机器人开立的成交：${symbol} ${trip.quantity} @ ${trip.entryPrice}（入口订单 ${trip.entryOrderId || '未知'}）`,
          );
          continue;
        }

        const booked = tradeStore.insert({
          traderId,
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
          // 这是从交易所成交重建出的真实回合：同一回合已经记过就只修正，不再插一行。
          idempotent: true,
        });
        /*
         * 无论本次是"新插入"还是"命中已有行"，这条成交都已经被账本认领了，所以
         * 两个索引都要更新 —— 否则同一遍里第二笔长相相同的成交会绕过刚刚建立的
         * 认知（`byKey.set` 原来只在新插入时做，是因为那时没有第二种结果）。
         */
        byKey.set(key, booked.id);

        if (!booked.created) {
          /*
           * 这一回合运行期已经记过账了：`insert()` 认出并返回了那一行。
           * 这里**不算补录、也不播报补录** —— 账本一行没多，"补录了 N 笔"的日志
           * 会让操作员以为发生过漏记，而漏记才是需要警惕的信号。
           *
           * 但要把交易所的权威口径写到那一行上（§2.5 的"只修正"）：运行期是从本地
           * 持仓行记的，数量与手续费口径都比成交记录粗；不修正，账本就停在一个
           * 与账户对不上的数字上。
           */
          tradeStore.applyExchangeFigures({
            id: booked.id,
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
          log.debug(
            `[${this.deps.trader.name}] 对账发现 ${symbol} 的这一回合已在账上（第 #${booked.id} 笔），只修正不重复插入。`,
          );
          continue;
        }

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
     * Settle local position rows the exchange no longer holds.
     *
     * `reconcilePositions` does this during a cycle, but it needs the position to
     * still be open locally *and* a cycle to run. Doing it here as well means a
     * trader that was stopped mid-position does not come back believing it still
     * holds something.
     *
     * **It must book the round-trip, not merely close the row.** This loop used
     * to call `positionStore.close()` directly and book nothing: the local row
     * disappeared while the exchange still held a finished entry+exit round-trip,
     * so the trade never reached `trades` — a position closed by an exchange-side
     * stop during downtime was dropped from the ledger entirely, and the
     * platform's PnL read better than the account's (§2.3). Worse, this pass runs
     * at the *head* of every cycle, before `reconcilePositions`, so it could
     * swallow a close that the later pass would have booked correctly.
     *
     * Booking it here is idempotent with `reconcilePositions`: closing the row
     * takes it out of `positionStore.open()`, so the later pass cannot book the
     * same round-trip twice.
     */
    const livePositions = await this.deps.broker.getPositions().catch(() => []);
    const liveSymbols = new Set(livePositions.map((p) => p.symbol));
    for (const local of positionStore.open(traderId)) {
      if (!liveSymbols.has(local.symbol)) {
        await this.bookVanishedPosition(local);
      }
    }

    /*
     * Refresh the display snapshot — 但**只给在跑的机器人**刷新。
     *
     * 这一段原来存在的理由：`computeTraderStats` 读最近一条快照，而一个已停止的
     * 机器人不再写快照，于是它的显示权益冻在最后一次周期那一刻。实盘上那次是
     * 显示 9.6213 而真实余额 10.2586 —— 利润是在机器人停下**之后**到的账。所以
     * 「对账时顺手写一条」在当时是对的。
     *
     * 但它同时是一个 bug 的一半：这一遍也会在一个**已停止**的机器人上跑（控制台的
     * 「对账」按钮、以及启动前的这一遍），而它当时写进去的是 `account.equity` ——
     * **共享钱包**的余额。同账户下每个机器人的快照因此都被刷成同一个数：一个从未
     * 成交的机器人显示别人的收益率，而一个已停止的机器人的数字会随着邻居继续交易
     * 而变动。**停止的机器人，历史必须停止移动。**
     *
     * 所以：只有循环是活的（`this.running`）或者这一遍本身就在一个进行中的周期里
     * （`this.cycleInFlight`）时才写。停止状态下点「对账」不再改动任何机器人快照；
     * 而"账刚对上就要显示新数字"这件事没有丢 —— `computeTraderStats` 在读取时按
     * 归属口径从 `trades` 现算权益，这一遍刚补录的成交立刻就会出现在控制台上，
     * 根本不需要一条新快照。
     */
    if (this.running || this.cycleInFlight) {
      try {
        const account = await this.deps.broker.getAccountState();
        const livePositions = await this.deps.broker.getPositions().catch(() => []);
        equityStore.insert(this.buildEquitySnapshot(account, livePositions));
      } catch (error) {
        log.debug(`[${this.deps.trader.name}] 对账后写入权益快照失败：${(error as Error).message}`);
      }
    }

    if (recovered > 0 || corrected > 0) {
      log.info(
        `[${this.deps.trader.name}] 对账完成：补录 ${recovered} 笔，修正 ${corrected} 笔，资金费合计 ${fundingTotal.toFixed(6)} USDT`,
      );
    }

    /*
     * 交易所已经不再挂着的本地委托行，也要在这一遍里结清。
     *
     * 位置放在"消失的持仓已经记账"之后：一张触发成交的止损，先要有人把那一回合记进
     * `trades`，再谈它自己的状态；而"这个标的是否还持仓"正是那一段刚更新过的东西。
     * 详见 `settleStaleOrders()`。
     */
    await this.settleStaleOrders().catch((error) => {
      // 记账失败不能影响这一遍对账的结论（它已经写完了），更不能把异常抛给周期。
      log.warn(
        `[${this.deps.trader.name}] 结清本地委托记录失败（不影响本周期交易）：${(error as Error).message}`,
      );
    });

    return { recovered, corrected, funding: fundingTotal };
  }

  /* ---------------------------------------------------------------------- */
  /*  Stale order records                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * 把交易所已经不挂着的本地委托行结清（§2.2 只要求不删行，从不要求状态停在 `NEW`）。
   *
   * ## 这个缺陷是什么
   *
   * `orders.status` 是**下单那一刻**交易所给的返回值，此后没有任何代码更新过它
   * （`orders.update()` 在本次修复之前没有任何调用点）。于是有三条路径会让它停在非终态：
   *
   *  1. **条件单触发成交** —— 平仓发生在交易所，本地行还是 `NEW`；
   *  2. **平仓前 `cancelAllOrders()` 撤单**（§2.7）—— 撤掉了，但没写回本地行；
   *  3. **交易所自己撤单** —— `closePosition=true` 的止损触发后，止盈那张"兄弟单"
   *     会被交易所一并撤掉，它不会通知任何人。
   *
   * 实盘上量到的后果：本地 24 行 `NEW` 全部属于已经平掉的仓位，而交易所的
   * `/fapi/v1/openOrders` 是 **0** —— 控制台的「当前委托」因此列出十几行并不存在的委托，
   * 其中每一行按 §2.7 看起来都像是会朝反方向开出新仓的存活单。**它其实全是假警报**，
   * 但一个不能相信的界面与真的出事一样糟：操作员无法分辨这一次到底是哪一种。
   *
   * ## 它只改账
   *
   * 这里既不补撤单、也不重挂保护单，唯一的依据是**交易所自己**说这张单还在不在
   * （挂单列表 + 条件单的最终状态）。撤单与下单的时机、位置一个都没有变 ——
   * 若某条路径真的漏撤了，那是另一件更严重的事，要单独报出来，而不是靠更新一行状态
   * 把它掩盖掉。
   *
   * @param onlySymbol 只结清这一个标的（平仓之后立刻调用，好让控制台马上正确）；
   *   不传时扫这个机器人全部待结清的行。对账轮次走的就是不传的那条。
   * @returns 实际改写的行数。
   */
  private async settleStaleOrders(onlySymbol?: string): Promise<number> {
    const traderId = this.deps.trader.id;

    /*
     * 只把"够老"的行当候选：`createdBefore` 就是宽限窗口的下界，
     * 窗口取多长、为什么需要，见 `ORDER_SETTLE_GRACE_MS`。
     */
    const cutoff = new Date(Date.now() - ORDER_SETTLE_GRACE_MS).toISOString();
    const candidates = orderStore
      .unsettled(traderId, cutoff)
      .filter((row) => onlySymbol === undefined || row.symbol === onlySymbol);
    if (candidates.length === 0) return 0;

    /*
     * 还持仓的标的先排除。
     *
     * 那种情况不是"显示脏了"，而是"保护单真的没了"—— 一件更严重、也完全不同的故障
     * （§2.6：一个没有交易所侧保护的杠杆仓位是最糟糕的状态）。把它混进这次记账修复里，
     * 等于用一行状态更新掩盖一条真实的告警。持仓还在，这里就一行都不碰。
     */
    const held = new Set(positionStore.open(traderId).map((p) => p.symbol));
    const symbols = [...new Set(candidates.map((row) => row.symbol))].filter((s) => !held.has(s));
    if (symbols.length === 0) return 0;

    /*
     * 权威答案在交易所。
     *
     * 两个端点都要读：条件单在 Algo 端点（`/fapi/v1/algoOpenOrders`），普通单在
     * `/fapi/v1/openOrders`，两边互不覆盖（`broker.cancelAllOrders()` 的注释写过同一件事）。
     * 少读一个，都会把一张**真的还挂着**的保护单当成已经不在 —— 那就是在自己造 §2.6 的事故。
     *
     * 按标的读（带 symbol 是 weight 1，不带是 40），而且只为"有待结清行的标的"读：
     * 结清之后这些标的下一次就没有候选行了，稳态下这一整段不产生任何请求。
     */
    const liveBySymbol = new Map<string, Set<string>>();
    for (const symbol of symbols) {
      try {
        const [regular, algo] = await Promise.all([
          this.deps.broker.getOpenOrders(symbol),
          this.deps.broker.getOpenAlgoOrders(symbol),
        ]);
        const live = new Set<string>();
        for (const order of regular) live.add(String(order.orderId));
        for (const order of algo) live.add(String(order.algoId));
        liveBySymbol.set(symbol, live);
      } catch (error) {
        /*
         * 读不到就**什么都不做**：这一轮无法断定它已经不在交易所，而"以为它不在"
         * 会把一张还在挂着的保护单写成终态。下一轮会重新读。
         */
        log.warn(
          `[${this.deps.trader.name}] ${symbol} 的挂单列表读取失败，本轮不结清该标的的委托记录：${(error as Error).message}`,
        );
      }
    }

    let settled = 0;
    const summary: string[] = [];
    for (const row of candidates) {
      const live = liveBySymbol.get(row.symbol);
      // 三种情况都不是"可以结清"：这个标的一轮没读到、这行没有交易所单号、
      // 或者它**正躺在挂单列表里**（那它当然还活着）。
      if (!live || !row.exchangeOrderId || live.has(row.exchangeOrderId)) continue;

      const outcome = await this.finalStatusOf(row);
      if (!outcome) continue;

      orderStore.update(row.id, outcome);
      settled += 1;
      summary.push(`${row.symbol} ${orderPurposeLabel(row.purpose)}`);
    }

    if (settled > 0) {
      this.emit(
        'info',
        `对账结清了 ${settled} 张交易所已不再挂着的委托（${summary.slice(0, 8).join('、')}` +
          `${summary.length > 8 ? ' 等' : ''}）：这些行此前停在挂单状态，实际早已成交或撤销；交易所侧没有任何改动。`,
      );
    }
    return settled;
  }

  /**
   * 一张已经**不在交易所挂单列表里**的委托，最终是怎么结束的。
   *
   * 判据只有两种，都来自交易所，没有一处靠推断凑数：
   *
   *  1. **条件单** —— `/fapi/v1/algoOrder` 能查到它自己的 `algoStatus`：
   *     `FINISHED`/`TRIGGERED` 是触发成交，`CANCELED` 是被撤，`EXPIRED` 是过期。
   *     这是唯一能把"止损真的触发了"和"平仓时被我们撤掉了"分开的东西，
   *     `detectCloseReason()` 依赖的也正是同一个查询。
   *     查不到（网络故障、dry run）时返回 `null` = **什么都不写** —— 此时把一张可能已经
   *     成交的止损写成"已撤销"，会和 `trades.close_reason` 里的 `stop_loss` 直接矛盾，
   *     比多留一轮脏行糟得多。
   *  2. **普通委托**（开仓 / 平仓的市价单）—— 交易所没有按单号回读的封装，就用手上
   *     真实拿到过的数字判：下单时确认的成交量若已覆盖整张单，就是 `FILLED`；
   *     否则它是带着剩余数量离场的，在币安自己的语义里那就是 `CANCELED`
   *     （部分成交 + 撤销剩余）。
   *
   * @returns 要写进那一行的字段；`null` 表示"这一轮不下结论"。
   */
  private async finalStatusOf(
    row: OrderRecord,
  ): Promise<{ status: string; filledQty?: number; avgPrice?: number; rawResponse?: unknown } | null> {
    const exchangeOrderId = row.exchangeOrderId;
    if (!exchangeOrderId) return null;

    if (CONDITIONAL_ORDER_TYPES.has(row.type)) {
      const algo = await this.deps.broker.getAlgoOrder(Number(exchangeOrderId));
      if (!algo) return null;
      const status = ALGO_FINAL_ORDER_STATUS[algo.algoStatus];
      // `NEW` 会走到这里：它说"还挂着"，而挂单列表刚说"不在" —— 两次读之间的竞态，
      // 真相是哪一个都可能是。留给下一轮，不拿这个矛盾去改账。
      if (!status) return null;

      const filledQty = Number(algo.actualQty ?? 0) || 0;
      const avgPrice = Number(algo.actualPrice ?? 0) || 0;
      return {
        status,
        // 只有交易所确实报了成交数字才写：`0` 会把已有的数字抹掉。
        ...(filledQty > 0 ? { filledQty } : {}),
        ...(avgPrice > 0 ? { avgPrice } : {}),
        // 交易所对这张单的最后一次答复（§2.2：raw_response 留的是交易所的话）。
        rawResponse: algo,
      };
    }

    /*
     * 相对容差而不是"浮点相等"：`quantity` 与 `filledQty` 分别是**请求数量**与交易所
     * 回报的**成交数量**，两者都过了字符串 → 数字这一趟，一个先取整、一个由交易所
     * 自己格式化，逐位相等不是它们之间的契约（同一取舍见 `repositories.ts` 里
     * 判定"同一个回合"用的 `DUPLICATE_QUANTITY_TOLERANCE`）。
     */
    const fullyExecuted = row.quantity > 0 && row.filledQty >= row.quantity * (1 - 1e-9);
    return fullyExecuted ? { status: 'FILLED' } : { status: 'CANCELED' };
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
      const filledQty = filled.executedQty;

      /*
       * An unconfirmed exit must never be booked as a completed round-trip.
       *
       * `waitForFill` gives up after its timeout and returns whatever the last
       * poll saw — which can be a partial fill or a still-working order. The code
       * here used to fall back to `local.quantity`, so a timeout was booked as a
       * **full** close: the remainder stayed open at the exchange, the next
       * `reconcilePositions` found the position still there, and the same
       * round-trip was booked a second time. The ledger then showed a trade that
       * never happened while the account still carried the position.
       *
       * So: book only what the exchange confirms, and when it confirms nothing,
       * leave the position open and let the next cycle reconcile the truth. The
       * position row is deliberately *not* closed here — the reconciliation pass
       * is the path that knows how to handle a remainder.
       */
      if (!(filledQty > 0)) {
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
          avgPrice: filled.avgPrice || null,
          filledQty: 0,
          raw: filled.raw,
        });
        this.emit(
          'warn',
          `${symbol} 的平仓单在 ${filled.status} 状态下没有确认成交，本次不记账；仓位仍按本地记录保留，下一轮对账会以交易所的实际持仓为准。`,
        );
        return {
          action: decision.action,
          symbol,
          status: 'failed',
          detail: `平仓单未确认成交（状态 ${filled.status}），未记账，等待对账。`,
          orderId: filled.id,
        };
      }

      const exitPrice = filled.avgPrice || (await this.deps.broker.getMarkPrice(symbol));

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

      if (filledQty < local.quantity) {
        this.emit(
          'warn',
          `${symbol} 只成交了 ${filledQty}/${local.quantity}，本地记录已保留，剩余敞口由下一轮对账与后续平仓处理。`,
        );
        return {
          action: decision.action,
          symbol,
          status: 'failed',
          detail: `平仓单只成交 ${filledQty}/${local.quantity}，未按全平记账，等待对账。`,
          orderId: filled.id,
        };
      }

      /*
       * Book through the same path as every other close, so fees, funding and
       * the trades row are produced identically no matter what closed the
       * position.
       */
      const booked = await this.bookClosedPosition(
        local,
        reason,
        exitPrice,
        fee,
        new Date().toISOString(),
      );

      /*
       * 平仓前撤掉的那些保护单（§2.7）在交易所已经没了，本地行却还写着 `NEW`。
       * 顺手结清它们，操作员就不必等到下一轮对账才在「当前委托」里看到正确的状态。
       *
       * 只碰账：撤单仍然只发生在上面那一次 `cancelAllOrders()`，时机与参数都没变。
       * 这一步失败只记日志，绝不影响这一笔已经成交的平仓。
       */
      await this.settleStaleOrders(symbol).catch((error) => {
        log.warn(
          `[${this.deps.trader.name}] ${symbol} 平仓后结清本地委托记录失败：${(error as Error).message}`,
        );
      });

      return {
        action: decision.action,
        symbol,
        status: 'ok',
        detail: `已按 ${exitPrice} 平掉${local.side === 'long' ? '多头' : '空头'} ${filledQty}，净盈亏 ${booked.netPnl >= 0 ? '+' : ''}${booked.netPnl.toFixed(4)} USDT。`,
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

      /*
       * Record the position **before** protection is attempted.
       *
       * If the stop cannot be established, the position is immediately flattened,
       * and that flatten is a real account event that must be booked in `trades`
       * (§2.3). The booking path needs a local row to close, and — more
       * importantly — an unprotected position that exists at the exchange must
       * never be invisible to the local books: that is exactly the state in which
       * a stop-out would go unrecorded and the console would claim a PnL the
       * account does not have. Nothing here trades without the stop: the only
       * difference is that the row exists one step earlier.
       */
      const openPosition = {
        traderId,
        symbol,
        side: (isLong ? 'long' : 'short') as 'long' | 'short',
        quantity: filledQty,
        entryPrice,
        leverage: decision.leverage,
        liquidationPrice: null,
        marginUsed: margin,
        stopLoss: null as number | null,
        takeProfit: null as number | null,
        stopOrderId: null as string | null,
        tpOrderId: null as string | null,
        openReasoning: decision.reasoning,
      };
      positionStore.insert(openPosition);

      /* --- Exchange-side protection ------------------------------------- */
      // Order matters: the stop goes on first and is verified. If protection
      // cannot be placed the position is closed immediately rather than left
      // naked — an unprotected leveraged position is the worst state to be in.
      const exitSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
      let stopOrderId: string | null = null;
      let tpOrderId: string | null = null;
      let stopFailureDetail = '止损挂单失败，已立即平掉该仓位。';

      if (decision.stopLoss && decision.stopLoss > 0) {
        /*
         * A stop that sits on the *wrong* side of the current market is not a
         * stopped-out trade, it is a trade whose thesis died: the mark price
         * already crossed the level the risk engine approved. Binance rejects
         * such an order with `-2021 Order would immediately trigger`, and a
         * stop that triggers the instant it is placed protects nothing at all —
         * it is a market exit with extra steps.
         *
         * This is what the price drift between the risk engine's snapshot and
         * execution produces. `roundTriggerPrice` must not paper over it by
         * nudging the trigger to the other side of the market: that would silently
         * place a stop at a *different* level than the one the risk engine sized
         * the trade around, i.e. it would widen the stop to make the order
         * placeable. §4.2 forbids exactly that.
         *
         * So the answer is the honest one: the entry's thesis is already
         * invalidated, flatten it now. That is a loss either way — the price has
         * already moved through the stop — and paying one market exit is strictly
         * better than holding an unprotected leveraged position while pretending
         * a stop exists.
         */
        const markNow = await this.deps.broker.getMarkPrice(symbol).catch(() => 0);
        if (
          markNow > 0 &&
          !this.deps.registry.isValidTrigger(decision.stopLoss, 'STOP_MARKET', exitSide, markNow)
        ) {
          stopFailureDetail =
            `止损触发价 ${decision.stopLoss} 已位于当前标记价 ${markNow} 的错误一侧（挂上去会立即触发、等于没有保护），` +
            '入场逻辑已失效，已立即平掉该仓位。';
          this.emit('error', `${symbol} ${stopFailureDetail}`);
          this.recordOrder({
            traderId,
            exchangeOrderId: null,
            clientOrderId: makeClientId('stop_loss', symbol),
            symbol,
            side: exitSide,
            type: 'STOP_MARKET',
            purpose: 'stop_loss',
            quantity: filledQty,
            price: null,
            triggerPrice: decision.stopLoss,
            status: 'REJECTED',
            avgPrice: null,
            filledQty: 0,
            error: stopFailureDetail,
          });
        } else {
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
      }

      if (!stopOrderId && this.deps.config.riskControl.requireStopLoss) {
        this.emit(
          'error',
          `无法为 ${symbol} 挂上止损。为避免留下无保护的杠杆敞口，立即平掉该仓位。`,
        );
        /*
         * Every close must be booked, including this one.
         *
         * This path used to return straight after the flatten, so the exchange
         * held a complete entry+exit round-trip that the `trades` table never
         * saw: `reconcilePositions` could not recover it (the local position row
         * did not exist) and `reconstructRoundTrips` reports nothing for an
         * already-closed round-trip it was never told about. The platform's PnL
         * then read *better* than the account's — the exact divergence §2.3
         * exists to prevent.
         */
        const flatten = await this.emergencyFlatten(symbol, filledQty, exitSide, traderId);
        const localPosition = positionStore.getOpenBySymbol(traderId, symbol);
        if (localPosition) {
          await this.bookClosedPosition(
            localPosition,
            'protection_unavailable',
            flatten?.avgPrice || entryPrice,
            flatten?.fee ?? 0,
            new Date().toISOString(),
          );
        } else {
          // Cannot happen while the insert above succeeded, but a missing row
          // must be reported rather than silently swallowing the account event.
          this.emit(
            'error',
            `${symbol} 已紧急平仓，但本地找不到对应的持仓记录，这一笔无法入账。`,
          );
        }
        return {
          action: decision.action,
          symbol,
          status: 'failed',
          detail: stopFailureDetail,
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

      positionStore.setProtection(
        traderId,
        symbol,
        decision.stopLoss && decision.stopLoss > 0 ? decision.stopLoss : null,
        decision.takeProfit && decision.takeProfit > 0 ? decision.takeProfit : null,
        stopOrderId,
        tpOrderId,
      );

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

  /**
   * Last-resort market exit used when protection could not be established.
   *
   * Returns what the exchange confirmed — or `null` when the flatten itself
   * failed, in which case the caller must still book the entry, because the
   * position may well exist at the exchange unprotected.
   */
  private async emergencyFlatten(
    symbol: string,
    quantity: number,
    side: 'BUY' | 'SELL',
    traderId: number,
  ): Promise<{ avgPrice: number; fee: number } | null> {
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

      /*
       * Commission is captured here too. This exit is a pure cost — the entry
       * and the exit both paid a fee — and reporting a net PnL that omits it
       * would make the platform's books read better than the account's (§2.5).
       */
      let fee = 0;
      try {
        const fills = await this.deps.broker.getUserTrades(symbol, 10);
        fee = fills
          .filter((fill) => String(fill.orderId) === filled.id)
          .reduce((sum, fill) => sum + (Number(fill.commission) || 0), 0);
      } catch {
        /* leave the fee at zero rather than fail the flatten */
      }

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
        fee,
        raw: filled.raw,
      });
      await this.deps.broker.cancelAllOrders(symbol);
      this.emit('warn', `因保护单挂单失败，已市价平掉 ${symbol}。`);
      return { avgPrice: filled.avgPrice, fee };
    } catch (error) {
      this.emit(
        'error',
        `${symbol} 紧急平仓失败：${(error as Error).message}。需要人工介入。`,
      );
      return null;
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

  /**
   * 组装提示词里的「记忆」区块（提案 §2 的三块）。
   *
   * ## 为什么全部在 SQL 里做（§4 的 O(1)）
   *
   * 三块内容分别来自：一个**固定时间窗口**的聚合、**固定 5 笔**逐笔明细、以及计数与
   * 时间差。进提示词的只有这些结果，所以提示词大小与 `trades` 里有多少行无关 ——
   * 这是"跑满一年后单轮 token 数与第一天相同"这条承诺的实现方式。把成交行拉进
   * JavaScript 再自己 reduce 也能算出同样的数，但每轮的记忆开销会随历史长度线性上升，
   * 而 `node:sqlite` 是同步的：那笔开销直接压在交易循环所在的事件循环上。
   *
   * ## 为什么"当时的理由"必须和结果一起给模型
   *
   * 它看不到自己刚在 4 分钟前平掉了一笔、今天已经开了 7 笔、连续用同一个理由在同一个
   * 标的上反复进出。把理由与结果并排放，是它唯一能形成"我某个判断模式不奏效"的机制：
   * 只看结果它不知道自己错在哪，只看理由它不知道那个理由已经失败过。
   */
  private buildPromptMemory(
    traderId: number,
    config: StrategyConfig,
    entriesThisHour: number,
  ): PromptMemory {
    const since = new Date(Date.now() - PROMPT_PERFORMANCE_WINDOW_HOURS * 3_600_000).toISOString();
    const performance = tradeStore.performanceSince(traderId, since);
    const lastExitAt = tradeEvents.lastExit(traderId);
    const lastExitMs = lastExitAt ? Date.parse(lastExitAt) : Number.NaN;

    return {
      performance: {
        windowHours: PROMPT_PERFORMANCE_WINDOW_HOURS,
        totalTrades: performance.totalTrades,
        wins: performance.wins,
        losses: performance.losses,
        grossPnl: performance.grossPnl,
        totalFees: performance.totalFees,
        totalFunding: performance.totalFunding,
        netPnl: performance.netPnl,
        avgWin: performance.avgWin,
        avgLoss: performance.avgLoss,
        /*
         * 没有亏损单时这个比值算不出来 —— 用 null 表示"算不出来"，而不是 0 或无穷：
         * 0 会被渲染成"实际盈亏比 0.00"，读起来像是"每一笔都亏"，与事实相反。
         */
        realizedPayoffRatio:
          performance.avgLoss > 0 ? performance.avgWin / performance.avgLoss : null,
        roundTripFeeRate: performance.roundTripFeeRate,
      },
      recentCloses: tradeStore.recentWithReason(traderId, PROMPT_RECENT_CLOSE_COUNT),
      throttle: {
        entriesThisHour,
        maxEntriesPerHour: config.throttle.maxEntriesPerHour,
        // 时间戳读不出来时按"从未平过仓"处理（null）：宁可少说一句，也不要报一个假的剩余时间。
        minutesSinceLastExit: Number.isFinite(lastExitMs)
          ? Math.max(0, (Date.now() - lastExitMs) / 60_000)
          : null,
        reentryCooldownMinutes: config.throttle.reentryCooldownMinutes,
      },
    };
  }

  private buildPromptPositions(
    localPositions: PositionRow[],
    snapshots: Map<string, MarketSnapshot>,
  ): PromptPosition[] {    return localPositions.map((p) => ({
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

  /**
   * 组装这个机器人本次的权益快照。
   *
   * 为什么不能直接写 `account.equity`：同一个交易所账户下可以跑多个机器人 ——
   * 它们共用一份凭据、共用一个钱包，`account.equity` 对它们全都是**同一个数**。
   * 实盘上量到的后果：一个 **0 笔平仓、净盈亏 0.000000** 的机器人显示 +2.67%
   * 收益率，而另一个机器人显示完全相同的 +2.67%（两个机器人读的是同一个钱包）。
   *
   * 归属权益只由这个机器人自己的东西构成（见 `attributedEquity()`）：
   *
   *   initialEquity + Σ(本机器人 net_pnl) + 本机器人持仓浮盈
   *
   * 浮盈用**自己的** `positions` 行（开仓价、数量、方向）按标记价算；标记价取自
   * 交易所持仓里的 `markPrice`（行情事实，对所有机器人相同，借用它不引入归属
   * 错误），**不是** `account.unrealizedPnl` —— 那个数同样是整个账户的，会把它
   * 人的浮盈算进来。读不到标记价时按 0 计并明确报警，不静默。
   *
   * 账户权益没有丢：`accountEquity` / `accountUnrealizedPnl` 两列记的就是它，
   * 风控的回撤高水位与「账户权益」展示读那两列（见 `realizedHighWaterMark`）。
   */
  private buildEquitySnapshot(account: AccountState, exchangePositions: ExchangePosition[]): EquitySnapshot {
    const traderId = this.deps.trader.id;
    const openPositions = positionStore.open(traderId);
    const markPrices = new Map(exchangePositions.map((p) => [p.symbol, p.markPrice]));

    const { unrealizedPnl, missingMarkPrice } = ownUnrealizedPnlOf(openPositions, (symbol) =>
      markPrices.get(symbol),
    );
    if (missingMarkPrice.length > 0) {
      this.emit(
        'warn',
        `读不到 ${missingMarkPrice.join('、')} 的标记价，这些持仓的浮动盈亏暂按 0 计入归属权益。`,
      );
    }

    return {
      traderId,
      timestamp: new Date().toISOString(),
      // 归属权益：本机器人自己的账，不是共享钱包。
      equity: attributedEquity(
        traderStore.get(traderId)?.initialEquity ?? 0,
        tradeStore.stats(traderId).netPnl,
        unrealizedPnl,
      ),
      availableBalance: account.availableBalance,
      unrealizedPnl,
      marginUsed: account.marginUsed,
      openPositions: openPositions.length,
      accountEquity: account.equity,
      accountUnrealizedPnl: account.unrealizedPnl,
    };
  }

  private async recordEquity(account: AccountState, exchangePositions: ExchangePosition[]): Promise<void> {
    const snapshot = this.buildEquitySnapshot(account, exchangePositions);
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

/* -------------------------------------------------------------------------- */
/*  周期失败的分类与表述                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 失败发生在周期的哪一段。
 *
 * 只在**错误类型本身说明不了问题**时才用得上（`describeCycleFailure` 的最后一级）：
 * 行情层抛的是普通 `Error`，而下单路径抛的也可能是普通 `Error` —— 同一个异常类型在
 * 两个阶段意味着两件完全不同的事，只有阶段标记分得开。
 */
export type CycleFailurePhase =
  | 'bookkeeping'
  | 'market'
  | 'model'
  | 'parse'
  | 'risk'
  | 'execute';

/** 一条记录里放得下的错误原文长度。见 `clipDetail` 的说明。 */
const FAILURE_DETAIL_LIMIT = 300;

/**
 * 折叠并截断服务商 / 交易所返回的原文。
 *
 * 它们可能是一整页 HTML 错误页或者带着换行的 JSON。原样写进
 * `decision_records.error` 会：让一条记录在决策流里占满整屏、把元数据行挤出视野。
 * 300 字符够放下"insufficient balance: please top up"这类关键句。
 */
function clipDetail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '未提供错误详情';
  return flat.length > FAILURE_DETAIL_LIMIT ? `${flat.slice(0, FAILURE_DETAIL_LIMIT)}…` : flat;
}

function detailOf(error: unknown): string {
  if (error instanceof Error) return clipDetail(error.message);
  return clipDetail(String(error));
}

/**
 * `llm/errors.ts` 的 `emptyCompletionError()` 没有专属的 `kind`（HTTP 200、但没有任何
 * 可用的助手文本），只能认它那句固定的英文文案 —— 那是"AI 响应无法解析"这一类的
 * 唯一信号。判错的后果只是把"空补全"说成"服务不可用"，两者的处置建议相同，所以这个
 * 妥协是可接受的；不要为了它去改 `errors.ts` 的类型（那会牵动重试策略）。
 */
function looksLikeEmptyCompletion(error: LlmError): boolean {
  return error.status === null && /no assistant text/i.test(error.message);
}

/**
 * 一次失败的周期，该对操作员说什么。
 *
 * ## 为什么返回中文散文，而不是堆栈
 *
 * 决策流是操作员唯一会去看的地方（参考产品就是这么做的），而堆栈在那里等于什么都
 * 没说：既看不出"是谁没给钱"，也看不出"要不要做点什么"。所以每一类都给一句**能照着
 * 做**的话，并把服务商 / 交易所的原文附在中间 —— 那句话往往已经写明了原因
 * （额度耗尽、模型不存在、保证金不足）。
 *
 * ## 失败类别写在**第一个全角冒号之前**
 *
 * 决策流的元数据行只放类别（`失败 · AI 服务额度不足`），完整说明留在盒子里，见
 * `packages/web/src/components/DecisionFeed.tsx` 的 `failureCategory()`。没有为此
 * 新增列：`decision_records.error` 本来就在，而这条文本的唯一读者是人。
 *
 * ## 判类只做这一次，且**不看 HTTP 状态码**
 *
 * `LlmError.kind` 是 `llm/errors.ts` 已经判好的结论，这里直接用它。那里记着一次实测
 * 事故：一个网关在 **HTTP 400** 里返回 `模型不可用：deepseek-flash`，而"400 不可重试"
 * 的通用规则让一次本可成功的请求被放弃；修复方式正是在 `kindForStatus()` 里显式列出
 * 这类可用性短语。这里若按状态码再判一次，等于把那个 bug 复制到展示层。
 */
export function describeCycleFailure(error: unknown, phase: CycleFailurePhase): string {
  if (error instanceof LlmError) {
    const detail = detailOf(error);
    switch (error.kind) {
      case 'quota_exhausted':
        return `AI 服务额度不足：${detail}。服务商已经把这条密钥判定为没有余额或没有额度，机器人在充值前每一轮决策都会失败 —— 请先在服务商后台充值或提高额度；充值后无需重启机器人，下一轮会自动恢复。`;
      case 'auth':
        return `AI 服务拒绝：${detail}。通常是 API Key 无效、已过期或被停用，请在控制台「设置 → AI 模型」里更新密钥。`;
      case 'permission':
        return `AI 服务拒绝：${detail}。这把密钥没有调用该模型的权限，请确认密钥权限或改用其他模型。`;
      case 'not_found':
        return `AI 服务拒绝：${detail}。配置的模型名在服务商侧不存在或已下线，请在控制台改用可用的模型。`;
      case 'bad_request':
        return `AI 服务拒绝：请求参数错误（${detail}）。请求被 AI 服务判定为参数异常，本轮没有产生任何决策；请检查模型名、温度与最大输出 Token 的配置，若反复出现请联系模型服务商。`;
      case 'content_filter':
        return `AI 服务拒绝：${detail}。模型侧的内容审核拦下了本次请求，一般下一轮就会恢复；若持续出现，请检查提示词与行情数据里是否有异常内容。`;
      case 'rate_limit':
      case 'overloaded':
      case 'server':
      case 'timeout':
        return `AI 服务不可用：${detail}。这是服务商侧的临时故障（限流 / 过载 / 超时 / 5xx），机器人下一轮会自动重试，通常不需要人工处理。`;
      case 'unknown':
        return looksLikeEmptyCompletion(error)
          ? `AI 响应无法解析：${detail}。模型返回了 HTTP 成功但没有任何可用文本（推理过程耗尽输出预算、或内容被审核掉都可能这样），本轮没有决策；机器人会在下一轮重新提问。`
          : `AI 服务不可用：${detail}。这次请求没有拿到模型的响应（网络不可达、被取消或响应异常），机器人下一轮会自动重试。`;
    }
  }

  if (error instanceof BinanceApiError) {
    const detail = detailOf(error);
    if (error.isInsufficientMargin) {
      return `交易所拒绝：保证金不足（${detail}）。这笔订单没有成交；请降低仓位比例或少开几个仓位，风控会按最新可用余额重算额度。`;
    }
    if (error.isRateLimited) {
      return `交易所限流：${detail}。请求过快或已被临时限制，机器人下一轮会自动重试。`;
    }
    if (error.isTimestampError) {
      return `交易所拒绝：请求时间戳超出接收窗口（${detail}）。服务器时钟需要与交易所同步，否则每一笔下单都会被拒。`;
    }
    if (error.isFilterError) {
      return `交易所拒绝：订单参数不符合该标的的交易规则（${detail}）。这通常是数量 / 价格的取整或最小名义价值问题，订单没有成交。`;
    }
    return `交易所拒绝：${detail}。这笔订单没有得到交易所确认；原始响应与错误码已记入订单表，可据此判断是否需要人工干预。`;
  }

  const detail = detailOf(error);

  // 模型返回的内容本身不是合法 JSON（被截断、或混进了额外说明）。它在"解析"阶段
  // 抛出，但类型是 SyntaxError，比阶段标记更精确。
  if (error instanceof SyntaxError) {
    return `AI 响应无法解析：${detail}。模型返回的内容不是合法 JSON（可能被截断或混入了说明文字），本轮没有决策；机器人会在下一轮重新提问。`;
  }

  switch (phase) {
    case 'market':
      return `行情数据不可用：${detail}。本轮取不到可用行情，因此没有向模型提问、也没有下单；通常是交易所行情接口暂时失败，机器人会在下一轮重试。`;
    case 'model':
      return `AI 服务不可用：${detail}。调用模型时出错，且这个错误不属于已知的服务商故障类型；机器人会在下一轮重试。若持续出现，请检查网络与模型配置。`;
    case 'parse':
      return `AI 响应无法解析：${detail}。模型返回的内容无法解析成决策，本轮没有决策。`;
    case 'risk':
      return `决策处理失败：${detail}。本轮在风控裁决环节抛出异常，没有下任何单；这属于程序内部故障，请结合运行日志排查（该周期的提示词与模型返回已保存在这条记录里）。`;
    case 'execute':
      return `交易所下单失败：${detail}。这笔订单没有得到交易所确认，可能并未成交；请核对交易所的持仓与挂单，机器人下一轮会重新对账。`;
    case 'bookkeeping':
      return `未知错误：${detail}。本轮在账务 / 对账环节失败，且错误不属于已知的模型、行情或交易所类别；该周期已经拿到的提示词与执行记录已尽量保存，请结合运行日志排查。`;
  }
}
