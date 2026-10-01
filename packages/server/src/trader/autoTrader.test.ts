import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  STRATEGY_PRESETS,
  defaultStrategyConfig,
  type MarketSnapshot,
  type StrategyConfig,
} from '@aq/shared';
import type { BinanceBroker, ExchangePosition, PlacedOrder } from '../binance/broker.js';
import { BinanceApiError, type BinanceAlgoOrderResponse, type BinanceOrderResponse, type BinanceUserTrade } from '../binance/types.js';
import type { SymbolRegistry } from '../binance/symbols.js';
import { closeDb, getDb, initDb } from '../db/index.js';
import { eventBus } from '../events.js';
import { setLogSink } from '../logger.js';
import { classifyHttpError, LlmError } from '../llm/errors.js';
import type { MarketDataService } from '../market/service.js';
import {
  computeTraderStats,
  decisions as decisionStore,
  equity as equityStore,
  exchanges,
  aiModels,
  orders as orderStore,
  positions as positionStore,
  strategies as strategyStore,
  settings,
  traders,
  trades as tradeStore,
  tradeEvents,
} from '../store/repositories.js';
import {
  AutoTrader,
  describeCycleFailure,
  makeClientId,
  ORDER_SETTLE_GRACE_MS,
  readForeignActivity,
  type DecisionModel,
} from './autoTrader.js';

/* -------------------------------------------------------------------------- */
/*  Harness                                                                    */
/* -------------------------------------------------------------------------- */

let workDir: string;
const SYMBOL = 'BTCUSDT';
const MARK_PRICE = 68_000;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-integration-'));
  initDb(path.join(workDir, 'test.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

let traderId = 0;

beforeEach(() => {
  // A clean slate per test: the in-memory database is shared across the file.
  const db = initDb(path.join(workDir, 'test.sqlite'));
  db.exec(`
    DELETE FROM trades; DELETE FROM orders; DELETE FROM positions;
    DELETE FROM decision_records; DELETE FROM equity_snapshots;
    DELETE FROM trade_events; DELETE FROM traders; DELETE FROM strategies;
    DELETE FROM ai_models; DELETE FROM exchange_accounts;
  `);

  const account = exchanges.create({
    exchange: 'binance',
    label: 'test',
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: 'test',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 120,
    maxRetries: 3,
  });
  const strategy = strategyStore.create({
    name: 'test',
    description: '',
    config: permissiveConfig(),
    presetId: null,
  });
  traderId = traders.create({
    name: 'integration',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;
});

/** Loosened limits so a cycle can actually place an order. */
function permissiveConfig(): StrategyConfig {
  const base = { ...defaultStrategyConfig(), ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>) };
  return {
    ...base,
    riskControl: {
      ...base.riskControl,
      maxPositions: 3,
      minConfidence: 50,
      minRiskRewardRatio: 1.5,
      maxMarginUsage: 100,
      minPositionSize: 5,
      btcEthMaxPositionValueRatio: 10,
      altcoinMaxPositionValueRatio: 5,
    },
    throttle: { minHoldMinutes: 0, reentryCooldownMinutes: 0, maxEntriesPerCycle: 3, maxEntriesPerHour: 10 },
    circuitBreaker: {
      maxDailyLossPercent: 0,
      maxTotalDrawdownPercent: 0,
      safeModeAfterFailures: 3,
      safeModeProbeCycles: 3,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Doubles                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * An in-memory exchange.
 *
 * Tracks positions so that open → protect → close can be exercised without a
 * network call, and records which endpoints/parameters the trader asked for.
 */
class FakeBroker {
  readonly placed: Array<Parameters<BinanceBroker['placeOrder']>[0]> = [];
  /**
   * 每次 `placeOrder` 分配的**交易所订单号**，与 `placed` 同索引。
   *
   * 成交明细（`getUserTrades`）必须报同一个 `orderId` —— 开仓路径正是按它把佣金
   * 查回来的。桩里原来那个 `orderId` 是从 `clientOrderId` 里**抠数字拼出来的**，
   * 与真实契约不符（币安的 `orderId` 是交易所自己的编号，与客户单号没有数字关系），
   * 于是"按 `orderId` 过滤"的代码在这个桩上恒不命中 ——
   * **桩比实现更宽松，就会把 bug 藏起来**（这正是 `failCancel` 那条注释说的同一件事）。
   */
  readonly placedIds: string[] = [];
  readonly cancelledSymbols: string[] = [];
  /**
   * 下单与撤单的**交错顺序**。
   *
   * `placed` 只记下单，看不出「先挂新还是先撤旧」—— 而那正是保本止损里
   * 唯一需要证的不变量（**先挂新 ⇒ 任何一步失败都不会让仓位失去保护**）。
   */
  readonly opLog: string[] = [];
  readonly leverageCalls: Array<{ symbol: string; leverage: number }> = [];
  /** Mutable mark price: price drift between the decision and execution is D1. */
  markPrice = MARK_PRICE;
  /**
   * 钱包（已结算）余额。
   *
   * 默认是 fixture 一直用的 1000；共账户的用例需要它随已实现盈亏变化 ——
   * 那正是"账户里有多少钱"与"这个机器人挣了多少"分道扬镳的地方。
   */
  walletBalance = 1000;
  /** Set to make conditional orders fail, as a stop on the wrong side does. */
  rejectStops = false;
  /** Set to make the next reduce-only market order fill only this fraction. */
  partialFillRatio: number | null = null;
  /** `/fapi/v1/income` events, for funding attribution. */
  income: Array<{ symbol: string; incomeType: string; income: string; time: number }> = [];
  /**
   * 挂着的条件单，按算法单号索引。
   *
   * 必须有这本账：本文件要验的是"本地行停在 `NEW`、而交易所早就不挂了"这类对账契约，
   * 而"交易所还挂着什么"正是被验的那一侧。以前这里 `getOpenAlgoOrders()` 恒回空数组，
   * 于是任何"这张单还在不在"的判断都无从被测到。
   */
  private readonly algoOrders = new Map<string, BinanceAlgoOrderResponse>();
  /** 算法单号只在自己标的下唯一（币安如此），所以查挂单要带上标的。 */
  private readonly algoSymbol = new Map<string, string>();
  private positions: ExchangePosition[] = [];
  private nextId = 1000;

  async getAccountState() {
    const unrealized = this.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    return {
      equity: this.walletBalance + unrealized,
      walletBalance: this.walletBalance,
      availableBalance: 800,
      unrealizedPnl: unrealized,
      marginUsed: 200,
      openOrderMargin: 0,
    };
  }

  async getPositions(symbol?: string) {
    /*
     * 按**当前标记价**重算浮盈，而不是返回开仓时快照的 0。
     *
     * ⚠️ 这里原本硬编码 `unrealizedPnlPercent: 0` —— 于是**任何依赖浮盈的
     * 逻辑在测试里都从未被真正走到过**：保本止损每次都读到 0%，
     * 永远不触发，而用例照样全绿。
     *
     * 这正是「没测的路径就是可能已经坏掉的路径」最纯粹的例子 ——
     * 不是断言写得松，而是**夹具让被测的那条分支根本不可达**。
     */
    const marked = this.positions.map((p) => {
      const direction = p.side === 'long' ? 1 : -1;
      const move = (this.markPrice - p.entryPrice) * direction;
      const unrealizedPnl = move * p.quantity;
      return {
        ...p,
        markPrice: this.markPrice,
        unrealizedPnl,
        // 交易所口径：价格变动百分比 × 杠杆。
        unrealizedPnlPercent: p.entryPrice > 0 ? (move / p.entryPrice) * 100 * p.leverage : 0,
      };
    });
    return symbol ? marked.filter((p) => p.symbol === symbol) : marked;
  }

  async setLeverage(symbol: string, leverage: number) {
    this.leverageCalls.push({ symbol, leverage });
    return { ok: true, leverage };
  }

  /**
   * 保证金模式。**必须存在** —— 开仓路径在每个新标的下第一单之前都会调它，
   * 桩里少这一个方法会让所有涉及开仓的用例在运行时炸掉（实测：28 个）。
   *
   * 默认返回 `true`（设成功），并记录每次调用，好让用例断言"设的是什么模式"。
   */
  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED') {
    this.marginTypeCalls.push({ symbol, marginType });
    return this.marginTypeOk;
  }

  /** 用例可以设成 false，模拟"该标的已有持仓/挂单，改不了"。 */
  marginTypeOk = true;

  /**
   * 还挂着的限价单（`orderId` → 交易所响应）。由 `getOrder` 回答"成交了吗"。
   * 用例通过 `fillRestingOrder()` 让它成交，模拟价格走过来。
   */
  restingOrders = new Map<number, BinanceOrderResponse>();

  /** 让一张挂着的限价单成交 —— 成交价就是它自己的挂单价。 */
  fillRestingOrder(orderId: number): void {
    const order = this.restingOrders.get(orderId);
    if (!order) return;
    const qty = Number(order.origQty) || 0;
    order.status = 'FILLED';
    order.executedQty = String(qty);
    order.avgPrice = order.price;
    /*
     * 成交意味着仓位真的出现了 —— 限价入场对账之后会去建本地持仓，
     * 但 `getPositions()`（交易所那一侧）也必须反映它，否则后续的对账
     * 会认为"本地多了一个交易所没有的仓位"。
     */
    this.positions.push({
      symbol: order.symbol,
      side: order.side === 'BUY' ? 'long' : 'short',
      quantity: qty,
      entryPrice: Number(order.price),
      markPrice: this.markPrice,
      leverage: 3,
      liquidationPrice: null,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      marginUsed: (qty * Number(order.price)) / 3,
      notional: qty * Number(order.price),
      marginType: 'cross',
    });
  }

  /** 撤销一张挂着的限价单 —— 对账应当把它当作"从未成为持仓"。 */
  cancelRestingOrder(orderId: number): void {
    const order = this.restingOrders.get(orderId);
    if (order) order.status = 'CANCELED';
  }

  /**
   * 用例设成 true 时，撤单请求会**失败**。
   *
   * ⚠️ **失败形态必须是"静默返回 false"，与真实 `broker.cancelOrder` 一致。**
   *
   * 真实实现是 `Promise<boolean>`：所有失败路径 `return false` 而**不抛**
   * （只有 `-2011`「单子已经不在交易所了」返回 `true`）。
   * 这个桩原来在失败时**抛异常**、成功时返回 `undefined` —— 两个方向都与真实契约
   * 相反。后果是**测试假绿**：调用点里"看返回值"的代码从来没被测过，
   * 而"只看异常"的代码反而总会走进 `catch`。
   *
   * 2026-09-26 的核查正是在这里发现了 P0-10/P0-11 两处 bug 能"通过测试"的原因：
   * 桩会抛，生产不会 —— 于是「撤不掉就不要挂新的」在生产里是死代码。
   */
  failCancel = false;
  /** 撤单时**抛异常**（另一种真实形态：网络层错误）。用于覆盖 `catch` 分支。 */
  throwOnCancel = false;
  /** 让 `cancelAllOrders` 抛错 —— 见那条"撤不掉就不挂新的"用例。 */
  failCancelAll = false;

  async getOrder(symbol: string, orderId: string | number): Promise<BinanceOrderResponse | null> {
    const order = this.restingOrders.get(Number(orderId));
    if (!order || order.symbol !== symbol) return null;
    return order;
  }

  /**
   * 交易所允许的最大杠杆。**默认 `null` = 不知道**，这时引擎只用配置上限 ——
   * 也就是改动之前的行为，所以既有用例的期望值不需要改。
   *
   * 用例可以把它设成一个数字来验证"配置写 20x、交易所只给 5x"那种情况。
   */
  async getMaxLeverage(_symbol: string): Promise<number | null> {
    return this.maxLeverageCap;
  }

  maxLeverageCap: number | null = null;

  marginTypeCalls: Array<{ symbol: string; marginType: 'ISOLATED' | 'CROSSED' }> = [];

  async ensureOneWayMode() {
    return { changed: false, warning: null };
  }

  /**
   * 用例设成一句话时，**条件单挂单会被交易所拒绝**，错误信息就是这句话。
   *
   * 用来验证"失败原因必须透传到提示里"：实测 2026-09-27 ETHUSDT 的界面写着
   * 「新保护单没挂上（…**没有挂单尝试**）」，而交易所其实明确回了
   * `-4509 Time in Force (TIF) GTE can only be used with open positions`。
   */
  failAlgoPlacement: string | null = null;

  async placeOrder(request: Parameters<BinanceBroker['placeOrder']>[0]): Promise<PlacedOrder> {
    this.placed.push(request);
    this.opLog.push(`place:${request.type}@${request.triggerPrice ?? request.price ?? '-'}`);
    const id = String(this.nextId++);
    this.placedIds.push(id);
    const isConditional = request.type === 'STOP_MARKET' || request.type === 'TAKE_PROFIT_MARKET';

    if (isConditional && this.failAlgoPlacement) {
      throw new Error(this.failAlgoPlacement);
    }

    /*
     * ⚠️ **限价单挂上不成交。**
     *
     * 原来这里只分"条件单"和"非条件单"，把**所有**非条件单都当市价立即成交 ——
     * 包括 `LIMIT`。于是限价入场的整条路径（挂单 → pending → 对账 → 转正）
     * 在测试里**根本走不到**：桩会直接把仓位建好。
     *
     * 现在它把限价单记进 `restingOrders`，由 `getOrder` 按用例设定的脚本回答
     * "成交了吗"。默认**一直挂着**（最保守），用例想让它成交就改那张单的状态。
     */
    if (request.type === 'LIMIT') {
      const resting: BinanceOrderResponse = {
        symbol: request.symbol,
        orderId: Number(id),
        clientOrderId: request.clientOrderId ?? id,
        side: request.side,
        type: 'LIMIT',
        status: 'NEW',
        price: String(request.price ?? 0),
        origQty: String(request.quantity ?? 0),
        executedQty: '0',
        avgPrice: '0',
        timeInForce: 'GTC',
        reduceOnly: false,
        closePosition: false,
        workingType: 'MARK_PRICE',
        priceProtect: false,
        updateTime: 0,
      } as BinanceOrderResponse;
      this.restingOrders.set(Number(id), resting);
      return {
        kind: 'order',
        id,
        clientId: resting.clientOrderId,
        symbol: request.symbol,
        side: request.side,
        type: 'LIMIT',
        status: 'NEW',
        avgPrice: 0,
        executedQty: 0,
        terminal: false,
        raw: resting,
      };
    }

    if (isConditional && this.rejectStops) {
      // Mirrors the real broker: a conditional order whose trigger is already on
      // the wrong side of the market is refused with `-2021` before it is sent.
      throw new Error(
        `${request.symbol} 的 ${request.type} 触发价 ${request.triggerPrice} 会立即触发（当前标记价 ${this.markPrice}），已拒绝下单`,
      );
    }

    /*
     * The fill ratio for a reduce-only order, consumed exactly once.
     *
     * Non-reduce-only orders must leave it alone: an opening market order that
     * cleared the flag would silently let the following exit fill in full and
     * make every partial-fill test pass vacuously.
     */
    const ratio = request.reduceOnly ? this.partialFillRatio : null;
    if (ratio !== null) this.partialFillRatio = null;
    const partial = ratio !== null;

    if (!isConditional) {
      // Market orders fill instantly and update the simulated position book.
      if (request.reduceOnly) {
        /*
         * 已结算盈亏真的会进钱包。
         *
         * `getAccountState()` 的权益因此会随着平仓变化，而不是永远 1000 + 浮盈 ——
         * 这正是"账户里有多少钱"与"这个机器人挣了多少"分道扬镳的地方，共账户的
         * 用例要靠这个区别才能证明归属权益不是账户权益。
         *
         * A reduce-only order removes only what it actually filled. Modelling a
         * partial exit as a full flatten would hide the very state under test.
         */
        const quantity = request.quantity ?? 0;
        const closing = this.positions.find((p) => p.symbol === request.symbol);
        const filled = closing ? Math.min(quantity, closing.quantity) : 0;
        if (closing && filled > 0) {
          const direction = closing.side === 'long' ? 1 : -1;
          this.walletBalance += (this.markPrice - closing.entryPrice) * filled * direction;
        }
        const remainder = quantity * (1 - (ratio ?? 1));
        if (remainder <= 1e-12) {
          this.positions = this.positions.filter((p) => p.symbol !== request.symbol);
        } else {
          this.positions = this.positions.map((p) =>
            p.symbol === request.symbol ? { ...p, quantity: remainder } : p,
          );
        }
      } else {
        const quantity = request.quantity ?? 0;
        this.positions.push({
          symbol: request.symbol,
          side: request.side === 'BUY' ? 'long' : 'short',
          quantity,
          entryPrice: this.markPrice,
          markPrice: this.markPrice,
          leverage: 3,
          liquidationPrice: null,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          marginUsed: (quantity * this.markPrice) / 3,
          notional: quantity * this.markPrice,
          marginType: 'cross',
        });
      }
    }

    if (isConditional) {
      const raw: BinanceAlgoOrderResponse = {
        algoId: Number(id),
        clientAlgoId: request.clientOrderId ?? id,
        algoType: 'CONDITIONAL',
        orderType: request.type as BinanceAlgoOrderResponse['orderType'],
        symbol: request.symbol,
        side: request.side,
        positionSide: 'BOTH',
        timeInForce: 'GTC',
        quantity: String(request.quantity ?? 0),
        algoStatus: 'NEW',
        triggerPrice: String(request.triggerPrice ?? 0),
        price: '0',
        closePosition: request.closePosition ?? false,
        reduceOnly: request.reduceOnly ?? false,
        workingType: request.workingType ?? 'MARK_PRICE',
        priceProtect: request.priceProtect ?? true,
        createTime: 0,
        updateTime: 0,
        triggerTime: 0,
      };
      // 挂进"交易所的账"：它就是"这张单还挂着"这个问题的答案来源。
      this.algoOrders.set(id, raw);
      this.algoSymbol.set(id, request.symbol);
      return {
        kind: 'algo',
        id,
        clientId: raw.clientAlgoId,
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        status: 'NEW',
        avgPrice: 0,
        executedQty: 0,
        // Untriggered: the stop is resting, not filled.
        terminal: false,
        raw,
      };
    }

    const requestedQty = request.quantity ?? 0;
    // A timed-out exit comes back partly filled: the runtime must not treat the
    // requested size as the executed size.
    const filledQty = partial ? requestedQty * ratio! : requestedQty;
    const status = partial ? 'PARTIALLY_FILLED' : 'FILLED';
    const raw: BinanceOrderResponse = {
      orderId: Number(id),
      clientOrderId: request.clientOrderId ?? id,
      symbol: request.symbol,
      side: request.side,
      type: request.type as BinanceOrderResponse['type'],
      status: status as BinanceOrderResponse['status'],
      avgPrice: String(this.markPrice),
      executedQty: String(filledQty),
      origQty: String(requestedQty),
      price: '0',
      cumQty: String(filledQty),
      cumQuote: String(filledQty * this.markPrice),
      reduceOnly: request.reduceOnly ?? false,
      positionSide: 'BOTH',
      stopPrice: '0',
      closePosition: false,
      timeInForce: 'GTC',
      origType: request.type as BinanceOrderResponse['origType'],
      updateTime: 0,
      workingType: 'MARK_PRICE',
      priceProtect: false,
    };

    return {
      kind: 'order',
      id,
      clientId: raw.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status,
      avgPrice: this.markPrice,
      executedQty: filledQty,
      terminal: true,
      raw,
    };
  }

  async waitForFill(order: PlacedOrder) {
    return order;
  }

  /**
   * 单张撤单。
   *
   * **此前 FakeBroker 没有这个方法** —— 保本止损用它只撤旧止损、不动止盈，
   * 而测试里没有对应实现。之前测试不炸，只是因为配置里阈值默认为 0、
   * 那一行提前返回了：**没测的路径就是可能已经坏掉的路径。**
   */
  async cancelOrder(symbol: string, orderId: number, kind: 'order' | 'algo' = 'order'): Promise<boolean> {
    /*
     * 与真实 `broker.cancelOrder` 保持**同一个契约**：
     *   · 成功 → `true`
     *   · 被拒 → `false`（**不抛**）—— `failCancel`
     *   · 网络层异常 → 抛 —— `throwOnCancel`
     *
     * 这条对齐是必须的：桩与实现的失败形态一旦不同，调用点里
     * "检查返回值"的代码就永远不会被测到（见 `failCancel` 的注释）。
     */
    if (this.throwOnCancel) {
      throw new Error(symbol + ' 的订单 ' + orderId + ' 撤销时网络中断');
    }
    if (this.failCancel) return false;
    this.opLog.push(`cancel:${symbol}#${orderId}`);
    /*
     * ⚠️ **撤单必须在"交易所的账"上真的生效。**
     *
     * 这里原来只往 `opLog` 记一笔就返回 `true` —— 于是**单张撤单是假的**：
     * 撤完之后那张条件单在 `getOpenAlgoOrders()` 里**仍然是 NEW**。
     *
     * 这藏住了一整类 bug：`settleStaleOrders()` 的判据正是"这一行还在不在
     * 交易所的挂单列表里"，而假撤单让"被替换掉的旧保护单"看起来**还活着** ——
     * 所以"旧行永远停在已挂单"这个真实缺陷在测试里根本造不出来
     * （用户实测：同一个仓位挂出 4 条止损、交易所侧一张都没有）。
     *
     * 真实现里 `DELETE /fapi/v1/algoOrder` 成功之后，那张单就不再是 open order 了。
     */
    if (kind === 'algo') {
      const existing = this.algoOrders.get(String(orderId));
      if (existing && existing.algoStatus === 'NEW') {
        this.algoOrders.set(String(orderId), { ...existing, algoStatus: 'CANCELED' });
      }
    }
    return true;
  }

  async cancelAllOrders(symbol: string) {
    /*
     * 用例可以设成 true，模拟"撤旧单这一步失败"。
     *
     * 这个开关是给一条**真实的 BUG** 加的（2026-09-22 ADAUSDT）：
     * `executeAdjust` 撤单失败后**仍然去挂新单**，于是必然吃 `-4130`、
     * `hasLiveStop` 判否、按 §2.6 把仓位平掉 —— 而那时旧止损其实还挂着。
     * 见下面那条"撤不掉就不挂新的"的用例。
     */
    if (this.failCancelAll) {
      throw new Error(symbol + ' 撤单被拒（模拟交易所侧失败）');
    }
    this.cancelledSymbols.push(symbol);
    /*
     * 也进 `opLog` —— 那样才能断言**撤单与挂单的相对顺序**。
     *
     * 两个数组（`cancelledSymbols` / `placed`）各自只记自己那一类，之间没有时间线；
     * 而"先撤后挂"正是这里要钉住的那条不变量（不先撤，挂上去就是 `-4130`）。
     */
    this.opLog.push(`cancel:${symbol}`);
    /*
     * 撤单**真的撤掉了** —— 这正是 §2.7 在交易所侧的效果。
     *
     * 以前这里只往数组里记一个标的名就完了，于是"本地行还写着 NEW、交易所早就撤了"
     * 这个状态在测试里根本造不出来。
     */
    for (const [id, order] of this.algoOrders) {
      if (this.algoSymbol.get(id) === symbol && order.algoStatus === 'NEW') {
        this.algoOrders.set(id, { ...order, algoStatus: 'CANCELED' });
      }
    }
  }

  /**
   * 交易所成交历史。
   *
   * 默认空。两个来源：
   *   · 测试直接设 `userTrades`（要造特定的成交形状时）；
   *   · 或打开 `autoUserTrades` —— 那时每一笔**已下的市价单**会按 `commissionRate`
   *     生成一条成交，用于验证"运行期能不能把手续费读回来"。
   *
   * 后者是必需的：开仓路径要按**交易所订单号**去成交明细里查佣金，而那个订单号
   * 是运行期生成的（`makeClientId` 带随机后缀），测试**没法预先知道**它。
   * 所以这里报的是 `placedIds` 里那个与 `placeOrder` 同一次调用分配的 id。
   */
  async getUserTrades() {
    if (!this.autoUserTrades) return this.userTrades;
    return this.placed
      .map((request, index) => ({ request, id: this.placedIds[index] ?? '' }))
      .filter(
        ({ request }) => request.type === 'MARKET',
      )
      .map(({ request: r, id }) => {
        const qty = r.quantity ?? 0;
        const price = this.markPrice;
        return {
          orderId: Number(id) || 0,
          symbol: r.symbol,
          side: r.side,
          price: String(price),
          qty: String(qty),
          /* 币安把佣金报成负数（支出）。 */
          commission: String(-(qty * price * this.commissionRate)),
          commissionAsset: 'USDT',
          time: Date.now(),
        } as unknown as BinanceUserTrade;
      });
  }

  /** 一次性探针用：交易所成交历史。 */
  userTrades: BinanceUserTrade[] = [];

  /** 打开后 `getUserTrades` 按已下的市价单生成成交（见该方法说明）。 */
  autoUserTrades = false;

  /** 生成成交时用的佣金率。默认 0.04%（币安 USDT-M 吃单费率的量级）。 */
  commissionRate = 0.0004;

  async getIncome() {
    return this.income;
  }

  async getMarkPrice() {
    return this.markPrice;
  }

  /** 交易所挂着的普通委托。这个替身只下市价单，而下单即成交 —— 所以永远是空的。 */
  async getOpenOrders() {
    return [] as BinanceOrderResponse[];
  }

  async getOpenAlgoOrders(symbol?: string) {
    return [...this.algoOrders.entries()]
      .filter(([id, order]) => order.algoStatus === 'NEW' && (!symbol || this.algoSymbol.get(id) === symbol))
      .map(([, order]) => order);
  }

  /** 回读单张条件单，包括已经不在挂单列表里的（币安就是靠它区分"触发了"和"被撤了"）。 */
  async getAlgoOrder(algoId: number) {
    return this.algoOrders.get(String(algoId)) ?? null;
  }

  /** Test helper: make the position vanish as if the exchange closed it. */
  simulateExchangeClose(): void {
    this.positions = [];
  }

  /**
   * Test helper: 交易所**自己**把仓位平掉了，并顺手撤掉还挂着的保护单。
   *
   * `closePosition=true` 的条件单在仓位消失时由交易所一并撤掉（存活的那张标成
   * `CANCELED`），它不会通知任何人 —— 这正是"本地行停在 NEW"的第三条成因。
   */
  simulateExternalClose(): void {
    this.positions = [];
    for (const [id, order] of this.algoOrders) {
      if (order.algoStatus === 'NEW') {
        this.algoOrders.set(id, { ...order, algoStatus: 'CANCELED' });
      }
    }
  }

  /**
   * Test helper: 止损真的触发成交。
   *
   * 交易所的行为是：触发的那张变成 `FINISHED`（并带上实际成交量与成交价），
   * 同一仓位上还挂着的兄弟单（止盈）被一并撤掉。仓位没了，而**没有任何一条
   * 本地订单行被更新过** —— 这就是实盘上 24 行 `NEW` 的来源。
   *
   * @returns 触发的那张单的算法单号。
   */
  simulateStopFired(filledQty = 1): string {
    let fired: string | null = null;
    for (const [id, order] of this.algoOrders) {
      if (order.algoStatus !== 'NEW') continue;
      if (order.orderType === 'STOP_MARKET') {
        fired = id;
        this.algoOrders.set(id, {
          ...order,
          algoStatus: 'FINISHED',
          actualQty: String(filledQty),
          actualPrice: String(this.markPrice),
          triggerTime: Date.now(),
        });
      } else {
        this.algoOrders.set(id, { ...order, algoStatus: 'CANCELED' });
      }
    }
    this.positions = [];
    if (!fired) throw new Error('没有可触发的止损单：用例的前提没有成立');
    return fired;
  }

  /**
   * Test helper: move the open position's mark-to-market, as a price wick does.
   *
   * Only the *unrealised* figure moves — the wallet balance is untouched — which
   * is exactly the shape that used to poison the circuit breaker's watermark.
   *
   * 标记价是唯一能推动未实现盈亏的东西：快照里的浮动盈亏现在是**按本机器人持仓的
   * 开仓价与标记价算出来**的（不再抄账户的 `unrealizedPnl`），所以这里必须把价格
   * 一起移动 —— 只改那个字段而价格不动，算出来（正确地）是 0，测试就会在到达被测
   * 行为之前先失效。平仓成交价同样取自标记价，价格不动就永远平在开仓价上。
   */
  simulateUnrealizedPnl(value: number): void {
    this.positions = this.positions.map((p) => {
      const direction = p.side === 'long' ? 1 : -1;
      const markPrice = p.quantity > 0 ? p.entryPrice + direction * (value / p.quantity) : p.markPrice;
      return { ...p, markPrice, unrealizedPnl: value };
    });
    const single = this.positions.length === 1 ? this.positions[0]!.markPrice : null;
    if (single !== null) this.markPrice = single;
  }
}

function snapshot(): MarketSnapshot {
  return {
    symbol: SYMBOL,
    sources: ['static'],
    price: MARK_PRICE,
    quoteVolume24h: 1_000_000_000,
    priceChangePercent24h: 1,
    high24h: MARK_PRICE * 1.02,
    low24h: MARK_PRICE * 0.98,
    primary: {
      timeframe: '5m',
      klines: [],
      closes: [MARK_PRICE],
      volumes: [1],
      ema: { '20': [MARK_PRICE] },
      rsi: { '7': [55] },
      atr: { '14': [100] },
      macd: null,
    },
    isMajor: true,
    timeframes: [],
    derivatives: {
      openInterest: 1000,
      openInterestUsd: MARK_PRICE * 1000,
      openInterestAvg: 900,
      openInterestChangePercent: { '1h': 2 },
      fundingRate: 0.0001,
      nextFundingTime: null,
      markPrice: MARK_PRICE,
      indexPrice: MARK_PRICE,
    },
    quant: null,
  };
}

/**
 * `MarketDataService` 的测试替身 —— **默认实现集中在这一处**。
 *
 * ## 为什么要有它（还一笔债）
 *
 * 这个接口每加一个方法，测试里几处手写的替身就都要跟着补。已经连续踩过**两次**：
 * `fullMarketOverview()` 与 `topRankings()` 加进来时，各处都报 `xxx is not a function` ——
 * 而 `.catch()` **兜不住同步 TypeError**（它只接 Promise 的 rejection），
 * 于是同一片用例集体失败，排查起来像是"功能写坏了"，其实是夹具缺一个方法。
 *
 * 现在默认实现只有这一份：**接口加方法只改这里**，用例只覆盖自己真正关心的那几个。
 * `overrides` 用宽松类型是有意的 —— 这个函数整体就是 `as unknown as MarketDataService`，
 * 逐字段写类型只会让每个用例都要多写一遍 import。
 */
function fakeMarketDataService(overrides: Record<string, unknown> = {}): MarketDataService {
  return {
    async buildSnapshots() {
      return [snapshot()];
    },
    async getOiRanking() {
      return [];
    },
    /* 第 0 层「全景」默认不渲染（给空数组）。 */
    async fullMarketOverview() {
      return [];
    },
    /* 第 1 层「聚焦」默认不渲染（给 undefined）。 */
    async topRankings() {
      return undefined;
    },
    async getKlines() {
      return [];
    },
    ...overrides,
  } as unknown as MarketDataService;
}

/*
 * 共享替身：默认行为来自 `fakeMarketDataService()`，这里只覆盖本套用例要用的那几个。
 */
const fakeMarketData = Object.assign(
  fakeMarketDataService({
    /*
     * ⚠️ **按入参返回快照** —— 与真实实现一致：候选池里有什么，就给什么标的的快照。
     *
     * 这样"某个标的是不是**真的**进了候选池"就能从提示词里断言出来 ——
     * 共识标的（多个榜同时指向的）与模型点名的标的都靠这条路径进池，
     * 而它们最容易在重构里被悄悄丢掉。
     */
    buildSnapshots: async (symbols: string[] = [SYMBOL]) => {
      const wanted = symbols.length > 0 ? symbols : [SYMBOL];
      const base = snapshot();
      return wanted.map((symbol) => ({ ...base, symbol }));
    },
    /*
     * 第 0 层「全景」—— 全市场一行摘要。
     *
     * 这里刻意给**两行**：一行是候选池里也有的 BTCUSDT，一行是**候选池里没有的
     * OUTSIDEUSDT** —— 后者正是用来断言"模型能看见候选池之外的市场"。
     */
    fullMarketOverview: async () => [
      { symbol: 'BTCUSDT', price: 68_000, changePercent24h: -1.2, quoteVolume24h: 1_200_000_000 },
      { symbol: 'OUTSIDEUSDT', price: 0.5, changePercent24h: 25.5, quoteVolume24h: 8_000_000 },
    ],
    /*
     * 第 1 层「聚焦」—— 各维度榜。每个榜的头名都是**不同的符号**，
     * 这样"聚焦段真的被渲染了"可以被断言到具体符号。
     */
    topRankings: async () => {
      const row = (symbol: string, value: number, change: number) => ({
        symbol,
        value,
        changePercent24h: change,
        quoteVolume24h: 300_000_000,
      });
      return {
        quoteVolume: [row('RANKVOLUSDT', 900_000_000, 1.5)],
        gainers: [row('PUMPERUSDT', 42.5, 42.5)],
        losers: [row('DUMPERUSDT', -31.2, -31.2)],
        /*
         * ⚠️ **`PUMPERUSDT` 刻意同时出现在涨幅榜与波动率榜** —— 它就是"共识标的"：
         * 多个维度同时指向的那个。深潜层只能放十几个，而 8 个榜合起来有几十个名字，
         * 所以共振度是"该给谁完整行情"的第一依据。
         */
        volatility: [row('PUMPERUSDT', 0.45, 42.5), row('WILDUSDT', 0.4, 3.1)],
        fundingExtreme: [row('FUNDINGUSDT', -0.019, 2.2)],
      };
    },
    /** 按需取数走这里。默认给两根假 K 线，够断言"取到的数据被回喂了"。 */
    getKlines: async (_symbol: string, _timeframe: string, count: number) =>
      Array.from({ length: Math.min(count, 2) }, (_, i) => ({
        openTime: Date.UTC(2026, 8, 21, 12, i),
        open: 2600 + i,
        high: 2610 + i,
        low: 2590 + i,
        close: 2605 + i,
        volume: 100 + i,
        closeTime: Date.UTC(2026, 8, 21, 12, i, 59),
        quoteVolume: 0,
        trades: 0,
        takerBuyBase: 0,
        takerBuyQuote: 0,
      })),
  }),
  /** 记录每一次取数请求 —— 用例靠它证明"模型要什么、系统就取什么"。 */
  { klineRequests: [] as Array<{ symbol: string; timeframe: string; count: number }> },
) as unknown as MarketDataService & {
  klineRequests: Array<{ symbol: string; timeframe: string; count: number }>;
};

/** 带取数记录的版本。`fakeMarketData` 是共享单例，用例要用自己的。 */
function recordingMarketData(): {
  market: MarketDataService;
  requests: Array<{ symbol: string; timeframe: string; count: number }>;
} {
  const requests: Array<{ symbol: string; timeframe: string; count: number }> = [];
  const market = fakeMarketDataService({
    async getKlines(symbol: string, timeframe: string, count: number) {
      requests.push({ symbol, timeframe, count });
      return [
        {
          openTime: Date.UTC(2026, 8, 21, 12, 0),
          open: 2600,
          high: 2610,
          low: 2590,
          close: 2605,
          volume: 120,
          closeTime: Date.UTC(2026, 8, 21, 12, 0, 59),
          quoteVolume: 0,
          trades: 0,
          takerBuyBase: 0,
          takerBuyQuote: 0,
        },
      ];
    },
  });
  return { market, requests };
}

/** Only the methods the trader actually uses. */
const fakeRegistry = {
  minNotional: () => 5,
  notionalToQuantity: (_symbol: string, notionalUsd: number, price: number) =>
    Math.floor((notionalUsd / price) * 1e6) / 1e6,
  /**
   * Reconciliation skips a symbol the registry does not know, so a missing or
   * empty `get()` makes the whole ledger pass a no-op — which would silently
   * hollow out any test that inspects it.
   */
  get: (symbol: string) => ({
    symbol,
    tickSize: 0.1,
    stepSize: 0.001,
    minQty: 0.001,
    maxQty: 1000,
    minNotional: 5,
  }),
  /**
   * Mirrors `SymbolRegistry.isValidTrigger`, and is load-bearing for D1: the
   * runtime decides whether a stop can still rest by asking the registry. A stub
   * that always said yes would hide the whole failure mode.
   */
  isValidTrigger: (triggerPrice: number, type: string, side: 'BUY' | 'SELL', marketPrice: number) => {
    if (!(triggerPrice > 0) || !(marketPrice > 0)) return false;
    const isStop = type === 'STOP' || type === 'STOP_MARKET';
    const mustBeBelow = isStop ? side === 'SELL' : side === 'BUY';
    return mustBeBelow ? triggerPrice < marketPrice : triggerPrice > marketPrice;
  },
} as unknown as SymbolRegistry;

function modelReturning(text: string): DecisionModel {
  return {
    async complete() {
      return { text, latencyMs: 42, usage: { promptTokens: 100, completionTokens: 50 } };
    },
  };
}

function buildTrader(
  broker: FakeBroker,
  text: string,
  model?: DecisionModel,
  /** 默认是 `beforeEach` 建的那个机器人；共账户的用例需要给第二个机器人也建一个。 */
  id = traderId,
): AutoTrader {
  const trader = traders.get(id);
  const strategy = strategyStore.get(trader!.strategyId!);
  return new AutoTrader({
    trader: trader!,
    config: strategy!.config,
    registry: fakeRegistry,
    market: {} as never,
    marketData: fakeMarketData,
    broker: broker as unknown as BinanceBroker,
    model: model ?? modelReturning(text),
  });
}

const OPEN_LONG_RESPONSE = `<reasoning>Clean setup.</reasoning>
<decision>
[
  {
    "symbol": "BTCUSDT",
    "action": "open_long",
    "leverage": 3,
    "position_size_usd": 600,
    "stop_loss": 66000,
    "take_profit": 74000,
    "confidence": 85,
    "risk_usd": 20,
    "reasoning": "Breakout with rising OI."
  }
]
</decision>`;

const CLOSE_LONG_RESPONSE = `<reasoning>Target reached.</reasoning>
<decision>[{"symbol":"BTCUSDT","action":"close_long","confidence":90,"reasoning":"Thesis complete."}]</decision>`;

/* -------------------------------------------------------------------------- */
/*  模型真的能看见自己的绩效（提案 §2）                                          */
/* -------------------------------------------------------------------------- */

/**
 * 一个把提示词收下来的模型替身。
 *
 * 单元测试能证明渲染函数是对的、聚合是 O(1) 的，但证明不了它们**被接进了交易循环** ——
 * "改了但没接线"正好藏在那个缝里。所以这三个用例断言的是模型**实际收到**的内容。
 */
function capturingModel(response: string): {
  model: DecisionModel;
  prompts: Array<{ system: string; user: string }>;
} {
  const prompts: Array<{ system: string; user: string }> = [];
  return {
    prompts,
    model: {
      async complete(systemPrompt, userPrompt) {
        prompts.push({ system: systemPrompt, user: userPrompt });
        return { text: response, latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1 } };
      },
    },
  };
}

test('★ 共识标的必须进候选池 —— 多个榜同时指向的，优先拿到完整行情', async () => {
  /*
   * ## 为什么这一条必须在端到端断言
   *
   * 第 1 层给出 8 个榜（每个 8 个标的），合起来几十个名字 —— 而深潜层
   * （完整多周期指标序列）只能放 15-20 个。所以"该给谁完整行情"必须有依据：
   * **多个榜同时指向的那个**（既在涨幅榜又在波动率榜 = 涨得多**且**在剧烈波动）。
   *
   * 夹具里 `PUMPERUSDT` **刻意只出现在涨幅榜与波动率榜**，不在成交额榜里；
   * 而系统按成交额选出的候选是 `BTCUSDT`。所以它出现在候选区块里，
   * **只能**是"共识"这条路径带来的 —— 这条接线最容易被以后的改动悄悄丢掉。
   */
  const captured = capturingModel(OPEN_LONG_RESPONSE);
  const trader = buildTrader(new FakeBroker(), '', captured.model);

  await trader.runOnce();

  const { user } = captured.prompts[0]!;
  assert.match(
    user,
    /### \d+\. PUMPERUSDT/,
    '★ 共识标的（多个榜同时指向）必须进候选池，与系统按成交额选的候选并列',
  );
  /* 系统自己选的候选不能被挤掉 —— 这是"增量"，不是"替换"。 */
  assert.match(user, /### \d+\. BTCUSDT/, '原来的候选仍要在');
});

test('每一轮的提示词里都带着绩效、最近平仓与行为余量三个区块', async () => {
  /*
   * Why this test exists —— 这次改动的一句话说明是"让模型看见自己在亏"，而它成立的前提
   * 是这三个区块**真的出现在发给模型的提示词里**。渲染函数单测绿了、聚合 O(1) 也测了，
   * 两者都不代表它们被接到了 `runCycleBody` 组装的上下文上。
   */
  const captured = capturingModel(OPEN_LONG_RESPONSE);
  const trader = buildTrader(new FakeBroker(), '', captured.model);

  await trader.runOnce();

  const { system, user } = captured.prompts[0]!;
  assert.match(user, /# 你的交易绩效/);
  assert.match(user, /# 最近平仓/);
  assert.match(user, /# 本周期约束/);
  // 还没有成交时如实说"没有"，而不是编一组数字。
  assert.match(user, /最近 24 小时没有已平仓的交易/);
  // 本小时已开仓 0 / 10：`permissiveConfig()` 的 maxEntriesPerHour 就是 10。
  assert.match(user, /本小时已开仓 0 \/ 10 笔/);
  // 止损手续费门槛必须写进硬性约束（系统提示词）：看不见的约束等于不存在。
  assert.match(system, /必须至少是往返手续费的 3 倍/);
});

test('★ 全市场概览真的被接到了提示词上 —— 模型要能看见候选池之外的标的', async () => {
  /*
   * 渲染函数单测绿了**不代表**它被接到了 `runCycleBody` 组装的上下文上 ——
   * 这条接线最容易被以后的改动误删，所以在这里钉一次端到端。
   *
   * `fakeMarketData.fullMarketOverview()` 刻意给了一行 **OUTSIDEUSDT**：
   * 它**不在候选池里**（候选只有 `snapshot()` 那一个标的），所以它能出现在提示词里
   * 就证明"模型的视野确实超出了候选池" —— 那正是用户 2026-09-30 要的东西：
   * 「币安支持的币种我觉得都应该在模型判断得范围」。
   */
  const captured = capturingModel(OPEN_LONG_RESPONSE);
  const trader = buildTrader(new FakeBroker(), '', captured.model);

  await trader.runOnce();

  const { user } = captured.prompts[0]!;
  assert.match(user, /# 全市场概览/, '★ 全景段必须被渲染出来');
  assert.match(user, /BTCUSDT/, '概览里要有大盘标的');
  assert.match(
    user,
    /OUTSIDEUSDT/,
    '★ 候选池【之外】的标的也必须出现 —— 否则"扩大视野"就是空的',
  );
  /* 它不能顶掉候选池：两者必须同时存在。 */
  assert.match(user, /# 候选标的/, '概览是增量的，不能取代候选池');

  /* 第 1 层「聚焦」同样必须被接上 —— 每个榜的头部符号都该看得见。 */
  assert.match(user, /# 市场聚焦/, '★ 聚焦段必须被渲染出来');
  assert.match(user, /PUMPERUSDT/, '涨幅榜的标的要在');
  assert.match(user, /DUMPERUSDT/, '跌幅榜的标的要在');
  assert.match(user, /WILDUSDT/, '波动率榜的标的要在');
  assert.match(user, /FUNDINGUSDT/, '资金费极值榜的标的要在');
});

test('平仓之后，模型下一轮能看到自己当时的理由和真实结果并排出现', async () => {
  /*
   * Why this test exists —— §2.2 的第二行是整块记忆里唯一能让模型形成"我某个判断模式
   * 不奏效"的机制：只看结果它不知道自己错在哪，只看理由它不知道那个理由已经失败过。
   *
   * 这里走完整条链：模型开仓（写下理由）→ 平仓（结果入账）→ 下一轮提问。
   * 理由取自 `positions.open_reasoning`，靠 `(symbol, opened_at)` 与成交行对上号 ——
   * 这条连接是这次改动里最容易悄悄断掉的一环（断了不会报错，只会少一行）。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();
  assert.equal(tradeStore.list(traderId).length, 1, '前提：这一回合已经入账');

  const captured = capturingModel('<decision>[]</decision>');
  await buildTrader(broker, '', captured.model).runOnce();

  const prompt = captured.prompts[0]!.user;
  // 结果 + 当时的理由（OPEN_LONG_RESPONSE 的 reasoning）并排出现。
  assert.match(prompt, /- BTCUSDT 多 3x @68000\.00→68000\.00  净 \+0\.000  模型主动平仓/);
  assert.match(prompt, /你当时的理由：Breakout with rising OI\./);
  // 绩效区块也有了真实数字（这一笔毛 0、手续费 0 → 净 0，按净额记为亏损）。
  assert.match(prompt, /最近 24 小时：1 笔（0 胜 1 负）/);
  // 行为余量：刚平过仓，冷却 0 分钟的配置下要如实说明。
  assert.match(prompt, /上次平仓在 不到 1 分钟前（未启用再入场冷却）/);
});

test('★ 订单落库时带上保证金占用 —— 否则表格那一列永远是空的', async () => {
  /*
   * 用户要求「**当前委托、历史成交、订单记录里增加一栏显示每一单保证金占用**」。
   *
   * 这一列的值来自 `orders.margin_used`（迁移 v13 新增）。**这条用例填的是那次交付
   * 唯一的证据缺口**：迁移、仓储映射与纯函数单测当时都已就绪，但"**真实的开仓流程
   * 到底会不会把值写进去**"只有纯函数级证据 —— 而线上跑的那一刻 AI 恰好选择观望
   * （`开仓 0`），一行订单都没产生，于是那一列在真实数据里全是 `NULL`。
   *
   * 一条只有单测、没有端到端证据的字段，和"我以为它接上了"没有区别 ——
   * 而这一列的失败方式恰好是最安静的那种：**界面显示 `—`，不报错、不告警**。
   *
   * 判据用 `typeof === 'number' && > 0` 而不是 `!== undefined`：`0` 与 `undefined`
   * 在这条链路上是两句相反的话（`0` = 没占保证金，`undefined` = 不知道），
   * 服务端两侧都做了收口（`positiveOrNull`），这里一并钉住。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const entry = orderStore.list(traderId).find((o) => o.purpose === 'entry');
  assert.ok(entry, '前提：这一轮真的开出了仓（否则这条用例什么都没测）');
  assert.ok(
    typeof entry.marginUsed === 'number' && entry.marginUsed > 0,
    `开仓单必须带上保证金占用，实际 ${String(entry.marginUsed)} —— ` +
      'undefined / 0 都会让界面那一列显示成 —（而它其实是有值的）',
  );

  /*
   * 保护单与开仓单属于**同一张持仓**，所以服务端取的是同一个 `positions.margin_used`。
   * 钉住这点有两个用处：
   *
   *  1. 证明"平仓/保护单不重算、直接取持仓行的权威值"这条路线真的接上了；
   *  2. 证明界面那一列的语义是「**这笔仓位占了多少**」而不是「这张单锁了多少」
   *     —— 后者在这里会得到另一个数（保护单没有成交价可言）。
   */
  const stop = orderStore.list(traderId).find((o) => o.purpose === 'stop_loss');
  if (stop) {
    assert.equal(
      stop.marginUsed,
      entry.marginUsed,
      '保护单与开仓单是同一张持仓，保证金必须是同一个数',
    );
  }
});

test('★ 订单落库时带上保证金模式 —— 就是开仓前刚设成功的那个', async () => {
  /*
   * 用户要求「订单记录里面显示：全仓\逐仓」。
   *
   * 这条用例填的是这条链路上最容易断的一环：迁移 v14、仓储映射（`toOrder` / `insert`）、
   * `normalizeMarginMode()` 的纯函数单测可以各自全绿，而"**真实的开仓流程到底有没有把
   * 值写进去**"只有端到端能证明 —— 失败方式与上一条 `marginUsed` 一模一样：
   * **界面显示 `—`，不报错、不告警**，谁都不会发现。
   *
   * 判据是**具体的 `'isolated'`**（默认配置 `riskControl.marginMode` 就是逐仓），
   * 而不是"不等于 undefined"：真正要钉的是"写进去的是那个模式本身，而且是交易所口径的
   * 机器码" —— 配置里写的是 `crossed`，若有人图省事直接落库，这一列就会有第二种写法，
   * 而 `'cross' === 'crossed'` 是 `false`（比较失败不抛错，界面把那批单读成"不知道"）。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const entry = orderStore.list(traderId).find((o) => o.purpose === 'entry');
  assert.ok(entry, '前提：这一轮真的开出了仓（否则这条用例什么都没测）');
  assert.equal(
    entry.marginType,
    'isolated',
    `开仓单必须带上保证金模式（默认配置是逐仓），实际 ${String(entry.marginType)} —— ` +
      'undefined 会让界面那一列显示成 —，而这条链路的失败是静默的',
  );
});

test('★ 保证金模式设不上时，订单行是「不知道」而不是默认的全仓', async () => {
  /*
   * 与上一条相对的那一半，也是这个交付里**唯一不能让步**的一条：**取不到就显示 `—`，
   * 绝不允许默认成"全仓"。**
   *
   * 币安官方明文「All contracts and positions are defaulted to the Cross Margin mode」，
   * 所以"设不上"的场景里默认值确实是全仓 —— 但那句话描述的是**交易所的默认行为**，
   * 不是"这一行的事实"：`setMarginType` 失败意味着（`-4044`/`-4048` 之类）
   * **我们根本没读到它现在是什么模式**。写成 `'cross'` 之后，界面上
   * 「全仓」与「不知道」就再也分不开了，而这一列存在的意义恰恰是让人判断风险。
   *
   * 场景取自实际会发生的事：该标的已经有持仓或挂单时币安不允许改模式，
   * 而那种情况下开仓**必须继续**（见 `executeOpen` 的注释）—— 于是这里同时钉住了
   * "模式设不上不该阻断开仓"与"设不上要如实留空"。
   */
  const broker = new FakeBroker();
  broker.marginTypeOk = false;
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const entry = orderStore.list(traderId).find((o) => o.purpose === 'entry');
  assert.ok(entry, '设不上保证金模式不该阻断开仓 —— 这一轮仍然要开出仓');
  assert.equal(
    entry.marginType,
    undefined,
    `设不上模式时这一行必须是 undefined（界面 —），实际 ${String(entry.marginType)} —— ` +
      '补一个 cross 等于替交易所宣布一个我们没读到的事实',
  );
});

test('止损比往返手续费还近的开仓：在交易循环里被拒，且理由带具体数字', async () => {
  /*
   * Why this test exists —— §5 的门槛必须**在通往订单的那条路径上**，而不是只在风控的
   * 单元测试里成立。这里让模型提一个止损只有 0.10% 的多头（往返成本就是 0.10%，K=3
   * 要求 0.30%）：它必须被拒、订单不得到达交易所，而且拒绝理由要带数字并写进决策记录 ——
   * 每一次运行时对模型的推翻都要留下痕迹（§2.1）。
   */
  const broker = new FakeBroker();
  const trader = buildTrader(
    broker,
    `<decision>[{"symbol":"BTCUSDT","action":"open_long","leverage":3,"position_size_usd":600,
      "stop_loss":67932,"take_profit":68400,"confidence":90,"reasoning":"tight scalp"}]</decision>`,
  );

  const summary = await trader.runOnce();

  assert.match(summary, /开仓 0/);
  assert.equal(broker.placed.length, 0, '被手续费门槛拒掉的提案不得到达交易所');
  assert.equal(positionStore.open(traderId).length, 0);

  const record = decisionStore.list(traderId)[0]!;
  const rejection = record.executionLog.find((entry) => entry.status === 'rejected');
  assert.ok(rejection, `拒绝必须写进执行日志，实际：${JSON.stringify(record.executionLog)}`);
  assert.match(rejection.detail, /往返手续费/);
  assert.match(rejection.detail, /0\.100%/);
  assert.match(rejection.detail, /0\.3000%/, '理由要给出这个费率下允许的最小止损幅度');
});

/* -------------------------------------------------------------------------- */
/*  ★ skip：看过、不做 —— 但它要留下一条带评分的记录                            */
/* -------------------------------------------------------------------------- */

test('★ skip 不产生任何订单、也不被记成失败，但分数必须落库', async () => {
  /*
   * Why this test exists —— `skip` 每轮会有十几条（提示词要求模型对**每一个**
   * 候选标的都留一条），所以它在执行层的两种"出错方式"后果都会被放大十几倍：
   *
   *  · 掉进最后的 `else` 被当成**开仓**执行 → 十几笔凭空下的单
   *    （`cancel_pending` 那个坑的翻版，`decision.ts` 里为它写过三次注释）；
   *  · 掉进"不认识的决策动作"兜底 → 十几条红字**执行失败**，而那一轮什么都没做错
   *    （`hold` 曾经这样报了很久 —— "一个把正常行为报成错误的检查，
   *    会让人不再相信错误提示"）。
   *
   * 最后一条断言钉的是这条路线的**目的**：那条决策要带着 `setupScore` 落库。
   * 它是"校准入场门槛"唯一的原料 —— 没有它，`get_skipped_outcomes` 只能告诉
   * 模型"这些后来涨了"，回答不了"我的线是不是划高了"。
   */
  const broker = new FakeBroker();
  const before = broker.placed.length;

  const response = `<decision>[
    {"symbol":"BTCUSDT","action":"skip","setup_score":58,
     "setup_score_basis":"抛物线中段 止损无处可放","confidence":70,"reasoning":"不追高"}
  ]</decision>`;
  const summary = await buildTrader(broker, response).runOnce();

  assert.equal(broker.placed.length, before, '★ skip 不得产生任何订单');
  assert.equal(positionStore.open(traderId).length, 0, '★ 也不得建仓');
  assert.match(summary, /开仓 0/, `摘要里不该出现任何动作，实际：${summary}`);

  const record = decisionStore.list(traderId)[0]!;
  assert.equal(
    record.executionLog.filter((e) => e.status === 'failed').length,
    0,
    `★ skip 不该被记成执行失败，实际：${JSON.stringify(record.executionLog)}`,
  );
  const skipped = record.decisions.find((d) => d.symbol === 'BTCUSDT')!;
  assert.equal(skipped.action, 'skip');
  assert.equal(skipped.setupScore, 58, '★ 分数必须落库 —— 那是校准门槛唯一的原料');
});

/* -------------------------------------------------------------------------- */
/*  Opening                                                                    */
/* -------------------------------------------------------------------------- */

test('a cycle opens a position and places exchange-side protection', async () => {
  const broker = new FakeBroker();
  const trader = buildTrader(broker, OPEN_LONG_RESPONSE);

  const summary = await trader.runOnce();

  assert.match(summary, /开仓 1/);

  // Leverage was set before the entry.
  assert.ok(broker.leverageCalls.some((c) => c.symbol === SYMBOL && c.leverage === 3));

  // Entry first, then stop, then target — all on the right endpoints.
  const entry = broker.placed.find((p) => p.type === 'MARKET');
  const stop = broker.placed.find((p) => p.type === 'STOP_MARKET');
  const target = broker.placed.find((p) => p.type === 'TAKE_PROFIT_MARKET');

  assert.ok(entry, 'a market entry must be placed');
  assert.equal(entry.side, 'BUY');
  assert.ok(stop, 'a stop loss MUST be placed after entry');
  assert.equal(stop.triggerPrice, 66_000);
  assert.equal(stop.closePosition, true, 'the stop must cover the whole position');
  assert.equal(stop.side, 'SELL');
  assert.ok(target, 'a take profit must be placed');
  assert.equal(target.triggerPrice, 74_000);
  assert.equal(target.closePosition, true);

  // Local book keeping.
  const open = positionStore.open(traderId);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.symbol, SYMBOL);
  assert.equal(open[0]!.side, 'long');
  assert.equal(open[0]!.stop_loss, 66_000);
  assert.equal(open[0]!.take_profit, 74_000);
  assert.ok(open[0]!.stop_order_id, 'the stop algo id must be recorded');

  // Orders and audit record.
  assert.ok(orderStore.list(traderId).length >= 3, 'entry, stop and target must all be recorded');

  const records = decisionStore.list(traderId);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.cotTrace, 'Clean setup.');
  assert.equal(records[0]!.success, true);
  assert.ok(records[0]!.systemPrompt.length > 500);
  assert.ok(records[0]!.userPrompt.length > 200);
  assert.equal(records[0]!.aiLatencyMs, 42);
  /*
   * ⚠️ **`>= 100` 而不是 `=== 100`。**
   *
   * 这条守的是"用量被记下来了"。而现在开仓成功之后还有一次**执行回执**的追问，
   * 它的 token 会**累加**到同一个周期上 —— 那正是要的（那一轮确实花了两次调用的钱）。
   * 钉死成 100 会让"回执的用量没被累加"这个 bug 反过来变成通过。
   */
  assert.ok(
    (records[0]!.promptTokens ?? 0) >= 100,
    `用量必须记下来（含执行回执那一次），实际 ${records[0]!.promptTokens}`,
  );
  /*
   * ⚠️ 用 `includes` 而不是 `deepEqual([SYMBOL])`：候选池里除了系统按成交额选的标的，
   * 还会有**共识标的**（多个榜同时指向的，见 `rankConsensus`）与**模型点名的**标的 ——
   * 那两条路径都是有意接进来的，所以"只有它一个"不再成立。
   */
  assert.ok(
    records[0]!.candidateSymbols.includes(SYMBOL),
    `系统按成交额选的候选必须在，实际 ${JSON.stringify(records[0]!.candidateSymbols)}`,
  );

  // Equity snapshot for the curve.
  assert.ok(equityStore.list(traderId).length >= 1);
});

test('★ 空仓且权益没变时不重复记快照 —— 否则曲线上全是悬停看不出变化的长平线', async () => {
  /*
   * 用户的原话：「默认上面显示得是全部 …… 鼠标悬停在某个时间节点上，显示得信息
   * 也是全局来的数据（现在显示的数据我感觉是基于今天的，导致了**除了今天以外的
   * 鼠标悬停都看不到数据**）」。
   *
   * 查下来**数据没错**（那一刻的快照确实是那个值），但**体验确实是坏的** ——
   * 根因是空仓期间权益一动不动，而系统仍然每轮记一条**逐字节相同**的快照。
   * 实测线上最长的一段是**连续 64 条都是 21.9669**。
   *
   * 规则：有变化一定记；没变化时每 2 小时记一条心跳（保"我还在"的证据）。
   * 单测里跨不过 2 小时，所以这里钉的是**前半条**：没变化就不记。
   */
  const broker = new FakeBroker();
  const trader = buildTrader(
    broker,
    '<reasoning>Nothing to do.</reasoning><decision>[{"symbol":"BTCUSDT","action":"wait"}]</decision>',
  );

  await trader.runOnce();
  const afterFirst = equityStore.list(traderId).length;
  assert.ok(afterFirst >= 1, `第一轮必须记一条基线，实际 ${afterFirst}`);

  /* 再跑两轮，什么都没发生 —— 一条都不该多。 */
  await trader.runOnce();
  await trader.runOnce();

  assert.equal(
    equityStore.list(traderId).length,
    afterFirst,
    '持仓、浮动盈亏、权益都没变时不该重复插快照（那正是"悬停看不到变化"的来源）',
  );
});

test('a cycle that decides to wait places no orders', async () => {
  const broker = new FakeBroker();
  const trader = buildTrader(
    broker,
    '<reasoning>Nothing to do.</reasoning><decision>[{"symbol":"BTCUSDT","action":"wait"}]</decision>',
  );

  const summary = await trader.runOnce();

  assert.match(summary, /开仓 0/);
  assert.equal(broker.placed.length, 0);
  assert.equal(positionStore.open(traderId).length, 0);
});

/* -------------------------------------------------------------------------- */
/*  Closing                                                                    */
/* -------------------------------------------------------------------------- */

test('a close cancels protection before flattening', async () => {
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  assert.equal(positionStore.open(traderId).length, 1);

  broker.placed.length = 0;
  /*
   * ⚠️ `cancelledSymbols` 也要清。
   *
   * 开仓路径现在也会撤一次单（挂保护单之前要清掉该标的的旧条件单 —— 见
   * `placeProtection` 的注释：过期的 Algo 单在交易所那边仍占着名额）。这里测的是
   * **平仓时**的撤单，所以要把开仓那一次从记录里去掉，否则断言到的是两条。
   *
   * `placed` 本来就清了，撤单记录是这次改动新引入的脏数据 —— 两件事必须一起清，
   * 否则"测的是哪一次撤单"就变得含糊了。
   */
  broker.cancelledSymbols.length = 0;
  const summary = await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  assert.match(summary, /平仓 1/);

  // Cancelling first is what stops a surviving closePosition algo order from
  // firing into a flat book and opening a position in the opposite direction.
  assert.deepEqual(broker.cancelledSymbols, [SYMBOL]);

  const exit = broker.placed.find((p) => p.type === 'MARKET');
  assert.ok(exit);
  assert.equal(exit.side, 'SELL');
  assert.equal(exit.reduceOnly, true);

  assert.equal(positionStore.open(traderId).length, 0);
  const closed = tradeStore.list(traderId);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.closeReason, 'model_decision');
});

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                             */
/* -------------------------------------------------------------------------- */

test('a position that vanishes is detected and booked as a trade', async () => {
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  assert.equal(positionStore.open(traderId).length, 1);

  // The exchange-side stop fires: the position is gone and our algo order is no
  // longer resting. Nothing told us directly.
  broker.simulateExchangeClose();
  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  assert.equal(positionStore.open(traderId).length, 0, 'the stale local record must be cleared');
  const closed = tradeStore.list(traderId);
  assert.equal(closed.length, 1, 'the vanished position must be booked exactly once');
});

test('an untracked exchange position is adopted rather than ignored', async () => {
  const broker = new FakeBroker();
  // Someone opened a position by hand; the bot has never seen it.
  await broker.placeOrder({ symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: 0.01 });

  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  const open = positionStore.open(traderId);
  assert.equal(open.length, 1, 'the manual position must be adopted');
  assert.match(open[0]!.open_reasoning, /机器人之外/);
});

/* -------------------------------------------------------------------------- */
/*  一个回合只能记一次账（§2.5 的幂等）                                          */
/* -------------------------------------------------------------------------- */

/**
 * 把某一回合的两条交易所成交按顺序接进 `getUserTrades`。
 *
 * 入场成交量故意与本地持仓量**不同**：这正是实盘上对账重复记账的触发条件 ——
 * 本地记的是持仓行的数量，交易所重建的是实际成交量（多笔成交的加权），两者
 * 一旦不等，`findRoundTrip()` 就认不出这一回合。
 */
function feedRoundTrip(
  broker: FakeBroker,
  input: {
    localQuantity: number;
    exchangeQuantity: number;
    entryOrderId: string;
    exitOrderId: string;
    entryTime: number;
    exitTime: number;
    entryPrice: number;
    exitPrice: number;
    grossPnl: number;
  },
): void {
  broker.userTrades = [
    {
      symbol: SYMBOL,
      id: 1,
      orderId: Number(input.entryOrderId),
      side: 'BUY',
      positionSide: 'BOTH',
      price: String(input.entryPrice),
      qty: String(input.exchangeQuantity),
      quoteQty: String(input.entryPrice * input.exchangeQuantity),
      realizedPnl: '0',
      marginAsset: 'USDT',
      commission: '0.24',
      commissionAsset: 'USDT',
      time: input.entryTime,
      maker: false,
      buyer: true,
    },
    {
      symbol: SYMBOL,
      id: 2,
      orderId: Number(input.exitOrderId),
      side: 'SELL',
      positionSide: 'BOTH',
      price: String(input.exitPrice),
      qty: String(input.exchangeQuantity),
      quoteQty: String(input.exitPrice * input.exchangeQuantity),
      realizedPnl: String(input.grossPnl),
      marginAsset: 'USDT',
      commission: '0.24',
      commissionAsset: 'USDT',
      time: input.exitTime,
      maker: false,
      buyer: false,
    },
  ];
  // `localQuantity` 只是断言上的说明，不参与喂数：交易所那侧永远只认成交量。
  void input.localQuantity;
}

test('运行期已记账的回合，对账不得再插一行（重复记账 = 凭空多出一份盈亏）', async () => {
  /*
   * Why this test exists —— 这个用例防的就是 §2.5「对账是幂等的：重复执行只修正、
   * 不重复插入」被破坏的那个 bug。
   *
   * 实盘上量到的三组重复行（其余字段逐字节相同，只有 id / source / opened_at 不同）：
   *
   *   #17 reconciled / #18 take_profit   SYNUSDT  99  -0.047554650
   *   #11 reconciled / #12 stop_loss     SYNUSDT 169  -0.75613135
   *   #9  reconciled / #10 take_profit   LSKUSDT  35  +0.66674843
   *
   * 12 行里 4 行是 reconciled，多出来的 6 行凭空造出 **+0.4954** 的净盈亏，
   * 因为毛、手续费、资金费都被算了两遍。
   *
   * 机制：运行期按**本地持仓行的数量**记账，对账按**交易所实际成交量**重建。
   * 两个口径一旦不等（这次就是），`reconcileTradeHistory` 的严格键
   * （symbol+qty+入场价+入口订单号）和只按描述匹配的回退键**同时**落空，
   * 于是它既没认出那一行、也没有任何唯一性约束拦它 —— 两条路各插一行。
   * `orders.exchangeOrderIds()` 那道归属闸门在这里帮不上忙：它回答的是"这个回合
   * 是不是本机器人开的"，而不是"这一回合是不是已经记过账了"。
   *
   * 契约：两条路径描述同一个真实回合时，`trades` 里**有且只有一行**。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const open = positionStore.open(traderId)[0]!;
  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  const booked = tradeStore.list(traderId);
  assert.equal(booked.length, 1, '运行期先记了一行（这是前提，否则用例证明不了什么）');
  const runtimeRow = booked[0]!;

  /*
   * 交易所的成交记录：实际成交量比本地持仓行多一点 —— 这正是 `findRoundTrip()`
   * 认不出这一回合的原因（它按 symbol+数量+入场价匹配），于是运行期记下的那一行
   * 没有入口订单号，对账的严格键与描述回退键也会一起落空。
   *
   * 平仓时间取**运行期记下的那一刻**：两条路径读的是交易所同一笔平仓成交，
   * 实盘上那三组重复行的 `closed_at` 正是逐字节相同的。这个时间就是幂等判据里
   * 唯一能把"同一回合被记两次"和"两笔真实成交"分开的东西（`closed_at` 相同时
   * 再用数量与入场价收窄）。
   */
  feedRoundTrip(broker, {
    localQuantity: runtimeRow.quantity,
    exchangeQuantity: runtimeRow.quantity + 0.0001,
    entryOrderId: '1000',
    exitOrderId: '1003',
    entryTime: Date.parse(runtimeRow.openedAt),
    exitTime: Date.parse(runtimeRow.closedAt),
    entryPrice: runtimeRow.entryPrice,
    exitPrice: runtimeRow.entryPrice + 100,
    grossPnl: 0.88,
  });

  const result = await buildTrader(broker, '<decision>[]</decision>').runReconcile();

  const after = tradeStore.list(traderId);
  assert.equal(
    after.length,
    1,
    `同一回合必须只有一行；实际 ${after.length} 行：${JSON.stringify(
      after.map((t) => ({ id: t.id, source: t.source, qty: t.quantity, net: t.netPnl })),
    )}`,
  );
  // 保留的是运行期那一行（它是先写的），并把交易所的权威口径修正上去 —— 这正是
  // "只修正、不重复插入"。
  assert.equal(after[0]!.id, runtimeRow.id, '不得新增行，应由对账修正原行');
  assert.equal(result.recovered, 0, '没有漏记的回合，补录数必须是 0');
  assert.ok(
    Math.abs(after[0]!.quantity - (runtimeRow.quantity + 0.0001)) < 1e-9,
    '交易所的成交量是权威口径，应当被修正到那一行上',
  );
});

/*
 * 运行中触发止损：平仓原因必须是「触发止损」，不能是「对账补录」。
 *
 * 为什么需要这个测试 —— 实盘上三笔在机器人**运行中**发生的平仓
 * （POWERUSDT / SYNUSDT / LSKUSDT）全部被记成了 `reconciled`。
 *
 * 原因是周期里两步对账的顺序：`reconcileTradeHistory` 跑在前面，它只有交易所的
 * 成交记录、判断不出原因，就先按 `reconciled` 记下了；等 `reconcilePositions`
 * 再跑，本地仓位已经没了、无事可做 —— 真实原因永远不会被确定。
 *
 * 为什么这不只是标签问题：模型的「最近平仓」区块看到的是"对账补录"而不是
 * "触发止损"，而那个区块存在的意义正是让它把**自己当时的理由**与**实际结果**
 * 对上。标签错了，学习信号就废了一半。
 *
 * 必须跑**完整周期**，不能用 `runReconcile()` —— 后者只调 `reconcileTradeHistory`，
 * 测不到两步之间的顺序（这正是本用例要钉的东西）。
 */
/*
 * 下单用的 clientOrderId 必须是币安接受的字符集。
 *
 * 实测故障：
 *
 *     open_long 龙虾USDT 执行失败：
 *     Binance -1100: Illegal characters found in parameter 'newclientorderid'
 *
 * 交易所的标的列表里有**中文名的币**，而 id 由 `prefix-symbol-stamp-random`
 * 拼成 —— 中文被原样带进去，下单直接失败，而且**每个周期都会再失败一次**
 * （策略会反复选中它）。
 *
 * 币安接受的是 `^[.A-Z:/a-z0-9_-]{1,36}$`，所以这里同时钉住三件事：
 *   ① 任何标的（含中文、含超长）产出的 id 都合法且不超 36 字符；
 *   ② 唯一性后缀不被截断挤掉 —— 撞 id 会让两笔订单在账目上无法区分，
 *      比下单失败更危险；
 *   ③ 同一毫秒内连续生成不重复。
 */
test('clientOrderId 对中文与超长标的都合法、唯一且不超 36 字符', () => {
  const legal = /^[.A-Z:/a-z0-9_-]{1,36}$/;

  for (const symbol of ['龙虾USDT', '1000SATSUSDT', 'BTCUSDT', '龙虾', 'A'.repeat(40)]) {
    const id = makeClientId('stop_loss', symbol);
    assert.ok(legal.test(id), `「${symbol}」产出的 id 非法：${id}`);
    assert.ok(id.length <= 36, `「${symbol}」产出的 id 超过 36 字符：${id}`);
  }

  // 唯一性：同一毫秒内连续生成不得重复（后缀没被截断才会成立）。
  const ids = new Set<string>();
  for (let i = 0; i < 50; i += 1) ids.add(makeClientId('entry', 'BULLAUSDT'));
  assert.equal(ids.size, 50, '同一毫秒内生成的 id 出现重复 —— 唯一性后缀被截断了');
});
/*
 * 同一回合的两条记账路径，平仓时刻相差几百毫秒 —— 守卫必须认出来。
 *
 * 实盘事故（2026-09-17 17:39）：
 *
 *     #29 BULLAUSDT  closed_at 17:39:06.483  source=bot         费 0
 *     #30 BULLAUSDT  closed_at 17:39:06.033  source=reconciled  费 0.0249
 *
 * 同一个回合被记了两次，账面多算一笔 -0.156 的亏损。
 *
 * 原因是守卫要求 `closed_at` **毫秒精确相等**，而运行期用的是"本地察觉到仓位消失"
 * 的时刻、对账用的是交易所成交记录里的时刻，两者本来就差几百毫秒（实测 450ms）。
 * 于是守卫在它本该生效的那个场景里**永远不会触发**。
 *
 * 这个用例钉住容差：500ms 的偏差必须被认成同一回合。
 */
test('两条记账路径的平仓时刻相差 500ms 时，仍判为同一回合而不重复插入', () => {
  const qty = 218;
  const entryPrice = 0.1145555;
  const first = tradeStore.insert({
    traderId,
    symbol: 'BULLAUSDT',
    side: 'long',
    quantity: qty,
    entryPrice,
    exitPrice: 0.1139543,
    leverage: 5,
    grossPnl: -0.1062,
    entryFee: 0.0124,
    exitFee: 0.0125,
    closeReason: 'drawdown_guard',
    openedAt: '2026-09-17T17:33:51.340Z',
    closedAt: '2026-09-17T17:39:06.483Z',
    source: 'bot',
  });

  // 对账路径：同一回合，但平仓时刻晚了 450ms
  const second = tradeStore.insert({
    traderId,
    symbol: 'BULLAUSDT',
    side: 'long',
    quantity: qty,
    entryPrice,
    exitPrice: 0.1139543,
    leverage: 5,
    grossPnl: -0.1062,
    entryFee: 0.0124,
    exitFee: 0.0125,
    closeReason: 'reconciled',
    openedAt: '2026-09-17T17:33:50.968Z',
    closedAt: '2026-09-17T17:39:06.033Z',
    source: 'reconciled',
    idempotent: true,
  });

  assert.equal(second.created, false, '450ms 的偏差必须被认成同一回合，不得插第二行');
  assert.equal(second.id, first.id, '返回的应当是已有那一行');
  assert.equal(tradeStore.list(traderId).length, 1, '账上只应有一行');

  /*
   * 反面：2 秒之外的**真实**另一回合必须照常插入。
   * 没有这一半，把容差改成"永远匹配"也能让上面全绿 —— 那会把真成交吞掉。
   */
  const later = tradeStore.insert({
    traderId,
    symbol: 'BULLAUSDT',
    side: 'long',
    quantity: qty,
    entryPrice,
    exitPrice: 0.1139543,
    leverage: 5,
    grossPnl: -0.115,
    entryFee: 0.0125,
    exitFee: 0.0125,
    closeReason: 'drawdown_guard',
    openedAt: '2026-09-17T17:45:00.000Z',
    closedAt: '2026-09-17T17:50:00.000Z',
    source: 'bot',
    idempotent: true,
  });
  assert.equal(later.created, true, '相隔数分钟的另一回合必须照常入账');
  assert.equal(tradeStore.list(traderId).length, 2);
});

test('★ 对账晚 11 分钟才补的行也必须被认成同一回合 —— 判据是开仓时刻而不是平仓时刻', () => {
  /*
   * ## 这条用例来自一次真实的账面错误
   *
   * 实盘上同一笔 ETH 被记了两次：
   *
   *     #90 bot          opened_at 17:14:51.381   closed_at 02:02:20.361   净 +0.1821
   *     #92 reconciled   opened_at 17:14:41.276   closed_at 01:51:35.036   净 +0.1713
   *
   * **入场时间只差 10 秒**（下单到成交的延迟），**平仓时间差 11 分钟**。
   * 而当时守卫的三个判据在这笔上**全部落空**：入场价容差 1e-6（实际差 0.116）、
   * 平仓时间窗口 2 秒（实际差 11 分钟）、补录那条没有入场订单号。
   *
   * 后果不是"数字不好看"：那 0.17 被算进了净盈亏，而**钱包余额不会跟着多** ——
   * 操作员看到的是「界面说赚了 0.20，钱包只多了 0.03」。
   *
   * ## 为什么不能靠放宽平仓时间那条
   *
   * 同一标的两笔**真实**回合之间只隔着再入场冷却（分钟级），而这两笔正好差
   * 11 分钟 —— 窗口一放就可能把两笔真实回合并成一笔，那比重复更严重
   * （会凭空吃掉一笔交易）。所以判据挂在**开仓时刻**上：它两条路径都锚在
   * "仓位什么时候开的"，只隔下单延迟。
   *
   * 上面那条 500ms 的用例仍然要有 —— 它覆盖"两条路径几乎同时记账"那一类；
   * 这条覆盖"对账几十分钟后才补"那一类。**两类都必须被拦住。**
   */
  const qty = 0.009;
  const exitPrice = 2655.66;

  const live = tradeStore.insert({
    traderId,
    symbol: 'ETHUSDT',
    side: 'long',
    quantity: qty,
    entryPrice: 2634.3164186,
    exitPrice,
    leverage: 3,
    grossPnl: 0.1920922326,
    entryFee: 0,
    exitFee: 0.01195047,
    fundingFee: 0.00194304,
    closeReason: 'stop_loss',
    openedAt: '2026-09-20T17:14:51.381Z',
    closedAt: '2026-09-21T02:02:20.361Z',
    source: 'bot',
  });

  /* 对账那条：平仓时刻晚了 11 分钟，入场价用的是快照价（差 0.116）。 */
  const reconciled = tradeStore.insert({
    traderId,
    symbol: 'ETHUSDT',
    side: 'long',
    quantity: qty,
    entryPrice: 2634.2,
    exitPrice,
    leverage: 3,
    grossPnl: 0.19314,
    entryFee: 0.0118539,
    exitFee: 0.02380437,
    fundingFee: 0.00194304,
    closeReason: 'reconciled',
    openedAt: '2026-09-20T17:14:41.276Z',
    closedAt: '2026-09-21T01:51:35.036Z',
    source: 'reconciled',
    idempotent: true,
  });

  assert.equal(
    reconciled.created,
    false,
    '开仓时刻只差 10 秒 —— 这是同一个回合，不得插第二行（否则净盈亏会凭空多出 0.17）',
  );
  assert.equal(reconciled.id, live.id, '返回的应当是已有的那一行');
  assert.equal(tradeStore.list(traderId).length, 1, '账上只应有一行');
});

test('★ 但同一标的、同一个出场价的两笔**真实**回合必须照常入账', () => {
  /*
   * 这条是上一条的反面，**没有它，把判据改成"出场价相同就算重复"也能让上面全绿**
   * —— 而那会吞掉一笔真实成交，比重复记账更严重。
   *
   * 区分点是开仓时刻：两笔真实回合之间至少隔一个再入场冷却（配置里 10 分钟），
   * 而同一回合的两条路径只差下单延迟（实测 10 秒）。5 分钟的窗口把两者分开。
   */
  const qty = 218;
  const entryPrice = 0.1145555;
  const exitPrice = 0.1139543;

  const first = tradeStore.insert({
    traderId,
    symbol: 'BULLAUSDT',
    side: 'long',
    quantity: qty,
    entryPrice,
    exitPrice,
    leverage: 5,
    grossPnl: -0.1062,
    entryFee: 0.0124,
    exitFee: 0.0125,
    closeReason: 'drawdown_guard',
    openedAt: '2026-09-17T17:33:51.340Z',
    closedAt: '2026-09-17T17:39:06.483Z',
    source: 'bot',
  });

  /* 11 分钟之后另开的一笔：同样的标的、数量、入场与出场价，但**开仓时刻不同**。 */
  const later = tradeStore.insert({
    traderId,
    symbol: 'BULLAUSDT',
    side: 'long',
    quantity: qty,
    entryPrice,
    exitPrice,
    leverage: 5,
    grossPnl: -0.115,
    entryFee: 0.0125,
    exitFee: 0.0125,
    closeReason: 'drawdown_guard',
    openedAt: '2026-09-17T17:45:00.000Z',
    closedAt: '2026-09-17T17:50:00.000Z',
    source: 'reconciled',
    idempotent: true,
  });

  assert.equal(later.created, true, '相隔 11 分钟的另一回合必须照常入账，不能被当成重复吞掉');
  assert.notEqual(later.id, first.id);
  assert.equal(tradeStore.list(traderId).length, 2);
});

test('运行中触发止损：平仓原因是「触发止损」而不是「对账补录」', async () => {
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const open = positionStore.open(traderId)[0]!;
  assert.ok(open, '前提：已开出一笔仓位');
  assert.equal(tradeStore.list(traderId).length, 0, '前提：这一回合运行期还没记账');

  // 止损在交易所触发成交，同仓位的止盈被交易所一并撤掉；本地订单行无人更新。
  broker.simulateStopFired(open.quantity);
  /*
   * 同时喂一份交易所成交历史 —— 这是实盘的常态：`reconcileTradeHistory` 每次
   * 都会去拉它。只有把两个数据源都摆出来，才测得出"谁先谁后"。
   */
  feedRoundTrip(broker, {
    localQuantity: open.quantity,
    exchangeQuantity: open.quantity,
    entryOrderId: '1000',
    exitOrderId: '1003',
    entryTime: Date.parse(open.opened_at),
    exitTime: Date.parse(open.opened_at) + 240_000,
    entryPrice: open.entry_price,
    exitPrice: open.entry_price - 50,
    grossPnl: -0.18,
  });

  // 完整周期：里面依次跑 reconcilePositions 与 reconcileTradeHistory。
  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  const rows = tradeStore.list(traderId);
  assert.equal(rows.length, 1, '恰好一行 —— 两步对账不得各记一条');
  assert.equal(
    rows[0]!.closeReason,
    'stop_loss',
    `运行中触发止损必须保住真实原因，实际是 ${rows[0]!.closeReason}。` +
      '若这里变成 reconciled，说明两步对账的顺序又反了 —— 见 runCycleBody 步骤 2 的注释。',
  );
});

test('交易所推来成交：账本当场对齐，不用等下一个周期', async () => {
  /*
   * Why this test exists —— 实测故障，不是设想。
   *
   * 用户数据流的订单回调此前只写一行日志，账本完全由每 `cycleIntervalMinutes`
   * 一轮的周期对账刷新（生产里 45 分钟）。实测两笔保本止损在 21:17:15 与
   * 21:27:38 触发，而控制台到 21:43 仍显示「当前持仓 0、委托全部待对账」、
   * 历史成交里没有这两笔 —— 操作员看到的是一份停在上一个周期的账，而它说的是
   * **已经不存在的事**。直到手动点一次「对账」才入账。
   *
   * 对账本身一条都没错（上面那个用例证明连平仓原因都是对的），错的是**它被触发的
   * 时机**。所以这里钉的就是时机：一次 `applyExchangeFill()` 就要把整本账对齐。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const open = positionStore.open(traderId)[0]!;
  assert.ok(open, '前提：已开出一笔仓位');
  assert.equal(tradeStore.list(traderId).length, 0, '前提：这一回合运行期还没记账');

  // 止损在交易所触发成交，仓位没了 —— 而本地此刻一个字段都没变。
  broker.simulateStopFired(open.quantity);
  feedRoundTrip(broker, {
    localQuantity: open.quantity,
    exchangeQuantity: open.quantity,
    entryOrderId: '1000',
    exitOrderId: '1003',
    entryTime: Date.parse(open.opened_at),
    exitTime: Date.parse(open.opened_at) + 240_000,
    entryPrice: open.entry_price,
    exitPrice: open.entry_price - 50,
    grossPnl: -0.18,
  });

  await buildTrader(broker, '<decision>[]</decision>').applyExchangeFill();

  const rows = tradeStore.list(traderId);
  assert.equal(rows.length, 1, '成交推送一到，这一回合就必须已经入账，且只有一行');
  assert.equal(
    rows[0]!.closeReason,
    'stop_loss',
    '即使由成交推着跑，原因仍由仓位那一遍定出 —— 不能被历史那一遍顶成 reconciled',
  );
  assert.equal(positionStore.open(traderId).length, 0, '本地那一行必须已经关掉');
});
test('运行期确实没记的回合，对账必须补录（#4 POWERUSDT 那种）', async () => {
  /*
   * Why this test exists —— 它是上一个用例的**反面**，用来防止"把对账修坏"。
   *
   * 12 行里 4 行 reconciled，只有 3 行是重复的；`#4 POWERUSDT 131` 没有对应的
   * 运行期行 —— 机器人当时没在跑，那一回合是**真的漏记**了，正是对账存在的理由。
   * 所以修复绝不能变成"凡 reconciled 就不记"或"删掉所有 reconciled"：
   * 那会把 +0.6563 那一笔彻底丢掉，账面反而比账户少。
   *
   * 契约：本地账本里没有这一回合时，reconciliation 仍然插一行，且标成
   * `source: 'reconciled'`（对账补录是"记账漏了"的信号，必须能看出来）。
   */
  const broker = new FakeBroker();
  // 开仓后不经过任何平仓路径：交易所自己平掉了，本地什么都没记。
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  assert.equal(tradeStore.list(traderId).length, 0, '前提：这一回合运行时没有记过账');

  const open = positionStore.open(traderId)[0]!;
  broker.simulateExchangeClose();
  feedRoundTrip(broker, {
    localQuantity: open.quantity,
    exchangeQuantity: open.quantity,
    entryOrderId: '1000',
    exitOrderId: '1003',
    entryTime: Date.parse(open.opened_at),
    exitTime: Date.parse(open.opened_at) + 300_000,
    entryPrice: open.entry_price,
    exitPrice: open.entry_price + 100,
    grossPnl: 0.6563,
  });

  const result = await buildTrader(broker, '<decision>[]</decision>').runReconcile();

  const rows = tradeStore.list(traderId);
  assert.equal(rows.length, 1, '漏记的回合必须被补录，恰好一行');
  assert.equal(result.recovered, 1);
  assert.equal(rows[0]!.source, 'reconciled', '补录行必须标出来源，否则"漏记"这个信号就没了');
  assert.equal(rows[0]!.closeReason, 'reconciled');
  assert.ok(Math.abs(rows[0]!.pnl - 0.6563) < 1e-9, '毛盈亏取自交易所，不得重算');
});

test('★ 同标的、同数量、同入场价的两个回合：必须按开仓时刻挑对那一个', async () => {
  /*
   * Why this test exists —— 实盘事故（用户的原话：
   * 「机器人未运行时平仓是什么意思？首先我没有关闭过机器人」）。
   *
   * 两笔 HYPEUSDT 的回合撞在同一个 key 上：
   *
   *     #111  0.21 @ 97.2 → 97.575   opened 01:09  closed 05:21
   *     #110  0.21 @ 97.2 → 96.451   opened 05:53  closed 07:54
   *
   * `findRoundTrip()` 的匹配键是 `symbol + quantity + entryPrice`（**不含时间**），
   * 而 `find(...)` 取第一个 —— 于是 #110 的往返被认成了 #111 的：`closedAt` 与
   * `exitPrice` 全套是错的值，再拿这组错参数去 `findDuplicate()` 必然命中 #111，
   * 运行期记账被跳过；这笔真实成交最后只能由兜底路径补录成 `reconciled`
   * —— 界面上就成了「机器人未运行时平仓」，而机器人从头到尾没停过、
   * WS 推来了成交、那张止损单在库里是 `FILLED`、本地持仓行也带着 `stop_order_id`。
   *
   * 这个用例把那两个回合一起摆出来，断言挑中的是**开仓时刻更近**的那一个，
   * 而且它必须是**运行期记账**（`source: 'bot'`）而不是补录。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const open = positionStore.open(traderId)[0]!;
  const entryAt = Date.parse(open.opened_at);
  const { symbol, quantity: qty, entry_price: price } = open;

  const fill = (
    id: number,
    orderId: number,
    side: 'BUY' | 'SELL',
    p: number,
    t: number,
    pnl: number,
  ) => ({
    symbol,
    id,
    orderId,
    side,
    positionSide: 'BOTH' as const,
    price: String(p),
    qty: String(qty),
    quoteQty: String(p * qty),
    realizedPnl: String(pnl),
    marginAsset: 'USDT',
    commission: '0.24',
    commissionAsset: 'USDT',
    time: t,
    maker: false,
    buyer: side === 'BUY',
  });

  /* ① 两小时前的**另一个**回合：同样的数量与入场价，只有时间与出场价不同。 */
  const earlier = entryAt - 2 * 3600_000;
  broker.userTrades = [
    fill(1, 9001, 'BUY', price, earlier, 0),
    fill(2, 9002, 'SELL', price + 100, earlier + 600_000, 20),
    /* ② **本次**的回合 —— 出场价在入场价**之下**，用它来区分挑中的是哪一个。 */
    fill(3, 9003, 'BUY', price, entryAt, 0),
    fill(4, 9004, 'SELL', price - 100, entryAt + 300_000, -20),
  ];
  broker.simulateExchangeClose();

  await buildTrader(broker, '<decision>[]</decision>').runReconcile();

  const rows = tradeStore.list(traderId);
  const mine = rows.find((t) => t.exitPrice < price);
  assert.ok(
    mine,
    `必须有一行是**本次**那个回合（出场 ${price - 100}）。实际：` +
      JSON.stringify(rows.map((r) => ({ exit: r.exitPrice, reason: r.closeReason, source: r.source }))),
  );
  /*
   * ⚠️ **这一条才是用户看到的那句话。**
   *
   * `source: 'bot'` = 运行期记账（本地持仓行 + 交易所成交一起看出来的），
   * 而 `'reconciled'` = 兜底补录 —— 后者在界面上显示成「**机器人未运行时平仓**」。
   * 机器人当时明明在跑，那个措辞是假的。
   */
  assert.equal(
    mine.source,
    'bot',
    `本次平仓发生在运行期，必须是运行期记账；实际是 ${mine.source}（界面上会写成"机器人未运行时平仓"）`,
  );
});

test('对账重复执行是幂等的：第二遍不再插手', async () => {
  /*
   * Why this test exists —— §2.5 的原话是「对账是幂等的：重复执行只修正、不重复插入」。
   *
   * 对账在每个周期开头都会跑一遍（`runCycleBody` 第 2 步），所以"跑两次"不是假设，
   * 而是常态。如果第二遍又插一行，操作员每次点「对账」都会让盈亏膨胀一次。
   *
   * 契约：同一份交易所成交历史上跑第二遍，`recovered` 与 `corrected` 都是 0，
   * 行数与每一行都不动。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  const open = positionStore.open(traderId)[0]!;
  broker.simulateExchangeClose();
  feedRoundTrip(broker, {
    localQuantity: open.quantity,
    exchangeQuantity: open.quantity,
    entryOrderId: '1000',
    exitOrderId: '1003',
    entryTime: Date.parse(open.opened_at),
    exitTime: Date.parse(open.opened_at) + 300_000,
    entryPrice: open.entry_price,
    exitPrice: open.entry_price + 100,
    grossPnl: 0.5,
  });

  const first = await buildTrader(broker, '<decision>[]</decision>').runReconcile();
  assert.equal(first.recovered, 1, '第一遍负责补录，否则第二遍什么都没得比');
  const afterFirst = tradeStore.list(traderId).map((t) => ({ id: t.id, net: t.netPnl }));

  const second = await buildTrader(broker, '<decision>[]</decision>').runReconcile();
  assert.equal(second.recovered, 0, '重复执行不得再补录');
  assert.deepEqual(
    tradeStore.list(traderId).map((t) => ({ id: t.id, net: t.netPnl })),
    afterFirst,
    '第二遍必须什么都不改',
  );
});

/**
 * 直接写一行"历史重复行"。
 *
 * 为什么要绕过仓储：`trades.insert()` 在修复之后是幂等的，它会认出重复并返回已有行，
 * 所以"已经落库的重复行"只能靠原始 SQL 造出来。这个助手只服务于那个检测用例。
 */
function insertDuplicateRow(input: {
  traderId: number;
  symbol: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  grossPnl: number;
  fee: number;
  openedAt: string;
  closedAt: string;
  netPnl: number;
}): number {
  const { lastInsertRowid } = getDb().run(
    `INSERT INTO trades (trader_id, symbol, side, quantity, entry_price, exit_price, leverage,
       pnl, pnl_percent, fee, close_reason, opened_at, closed_at, hold_minutes,
       entry_fee, funding_fee, net_pnl, source)
     VALUES (?, ?, 'long', ?, ?, ?, ?, ?, 0, ?, 'reconciled', ?, ?, 0, 0, 0, ?, 'reconciled')`,
    input.traderId,
    input.symbol,
    input.quantity,
    input.entryPrice,
    input.exitPrice,
    input.leverage,
    input.grossPnl,
    input.fee,
    input.openedAt,
    input.closedAt,
    input.netPnl,
  );
  return lastInsertRowid;
}

test('重复行只被报告出来，不被自动删除', async () => {
  /*
   * Why this test exists —— 已经落库的重复行要由**人**决定怎么处理。
   *
   * 删除会计历史是不可以自动化的事情：删错一行就永久改写了对账依据。所以修复只做
   * 两件事 —— 今后不再产生重复、以及把疑似重复**报出来**给操作者复核。
   * 这个用例钉住报告口径：必须成对、一 reconciled 一非 reconciled，且字段取自数据库。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  const open = positionStore.open(traderId)[0]!;
  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();
  const runtimeRow = tradeStore.list(traderId)[0]!;

  // 直接构造出实盘那三组重复行的形状（修复之后正常路径不会再产生它，历史行仍在）。
  /*
   * 直接写 SQL 造出这一对：**不能**走 `tradeStore.insert()` —— 修复之后它自己就会
   * 认出重复并返回已有行（那正是上一个用例钉住的行为）。这里要模拟的是**已经落库的
   * 历史行**，所以必须绕过写入路径，否则这个用例永远造不出它要检测的形状。
   */
  const duplicateId = insertDuplicateRow({
    traderId,
    symbol: SYMBOL,
    quantity: open.quantity,
    entryPrice: open.entry_price,
    exitPrice: runtimeRow.exitPrice,
    leverage: runtimeRow.leverage,
    grossPnl: runtimeRow.pnl,
    fee: runtimeRow.fee,
    openedAt: new Date(Date.parse(runtimeRow.openedAt) - 368).toISOString(),
    closedAt: runtimeRow.closedAt,
    netPnl: runtimeRow.netPnl,
  });

  const suspects = tradeStore.duplicateSuspects(traderId);
  assert.equal(suspects.length, 1, '这一对重复行必须被报出来');
  assert.deepEqual(
    [suspects[0]!.idA, suspects[0]!.idB].sort((a, b) => a - b),
    [runtimeRow.id, duplicateId].sort((a, b) => a - b),
  );
  assert.equal(suspects[0]!.symbol, SYMBOL);
  assert.ok(
    [suspects[0]!.reasonA, suspects[0]!.reasonB].includes('reconciled'),
    '一对里必须恰好有一行来自对账，否则就不是重复，而是两笔真实成交',
  );

  // 报告不等于删除：两行都还在。
  assert.equal(tradeStore.list(traderId).length, 2, '检测不得顺手删任何一行');
});

/* -------------------------------------------------------------------------- */
/*  Audit trail on failure                                                     */
/* -------------------------------------------------------------------------- */

test('a model failure leaves the position state untouched and reports the error', async () => {
  const broker = new FakeBroker();
  const trader = buildTrader(broker, '');
  // Replace the model with one that throws.
  (trader as unknown as { deps: { model: DecisionModel } }).deps.model = {
    async complete() {
      throw new Error('provider unavailable');
    },
  };

  await assert.rejects(() => trader.runOnce(), /provider unavailable/);
  assert.equal(broker.placed.length, 0);
  assert.equal(positionStore.open(traderId).length, 0);
});

test('a response that violates the risk rules is rejected and recorded', async () => {
  const broker = new FakeBroker();
  // Confidence below the configured floor, and a stop on the wrong side.
  const trader = buildTrader(
    broker,
    `<decision>[{"symbol":"BTCUSDT","action":"open_long","leverage":3,"position_size_usd":600,
      "stop_loss":70000,"take_profit":80000,"confidence":20}]</decision>`,
  );

  await trader.runOnce();

  assert.equal(broker.placed.length, 0, 'an invalid entry must not reach the exchange');
  assert.equal(positionStore.open(traderId).length, 0);

  const record = decisionStore.list(traderId)[0]!;
  assert.ok(record.executionLog.length > 0, 'the rejection must be recorded in the audit trail');
  assert.equal(record.executionLog[0]!.status, 'rejected');
});

/* -------------------------------------------------------------------------- */
/*  Protection that cannot be placed                                           */
/* -------------------------------------------------------------------------- */

test('an entry whose stop is already breached is flattened and booked, not left naked', async () => {
  /*
   * Why this test exists (D1).
   *
   * The risk engine approves a stop against the price in its own snapshot, and
   * the entry executes against a *later* mark price. Between those two moments
   * the mark can move through the stop level — a normal stop becomes a trigger
   * that would fire the instant it is placed.
   *
   * Binance refuses such an order with `-2021 Order would immediately trigger`,
   * `placeProtection` returns null, and the runtime flattens the position. The
   * bug was *how* it got there: `roundTriggerPrice` would happily nudge the
   * trigger to the other side of the market to make it placeable, which silently
   * turns the stop the risk engine sized the trade around into a different,
   * wider one. A stop that immediately triggers protects nothing anyway, so the
   * honest answer is: the thesis is dead, exit now.
   *
   * The observable contract this pins: the position is flat, the stop is
   * **never** re-priced onto the safe side, and the account event is booked.
   */
  const broker = new FakeBroker();
  // The mark is below the approved stop by the time the stop would be placed.
  broker.markPrice = 65_000;

  const trader = buildTrader(broker, OPEN_LONG_RESPONSE);
  const summary = await trader.runOnce();

  assert.match(summary, /开仓 0/, 'an instantly-triggering entry must not count as a held entry');

  // No stop was ever sent. Sending one at a moved level would be the silent
  // stop-widening that §4.2 forbids.
  assert.equal(
    broker.placed.filter((p) => p.type === 'STOP_MARKET').length,
    0,
    'a stop that would immediately trigger must not be placed at all',
  );

  // The entry was flattened and the position is flat everywhere.
  assert.equal(positionStore.open(traderId).length, 0);
  const flatten = broker.placed.find((p) => p.type === 'MARKET' && p.reduceOnly === true);
  assert.ok(flatten, 'the naked position must be market-closed immediately');

  // The exit is a real account event: it must exist in `trades`.
  const trades = tradeStore.list(traderId);
  assert.equal(trades.length, 1, 'the flatten must be booked exactly once');
  assert.equal(trades[0]!.symbol, SYMBOL);
  assert.equal(trades[0]!.closeReason, 'protection_unavailable');
});

test('a failed stop placement still books the emergency flatten', async () => {
  /*
   * Why this test exists (D3).
   *
   * The emergency path used to `return` immediately after flattening, before
   * `positionStore.insert` / `tradeStore.insert` ever ran. The exchange then held
   * a complete entry + exit round-trip that the `trades` table knew nothing
   * about: `reconcilePositions` cannot recover it (no local position) and
   * `reconstructRoundTrips` reports nothing for an already-closed round-trip it
   * was never told about. The platform's PnL read *better* than the account's —
   * a direct breach of §2.3.
   *
   * Here the stop fails for a reason other than drift (the exchange rejects the
   * order), which is the other half of the same branch.
   */
  const broker = new FakeBroker();
  broker.rejectStops = true;

  const trader = buildTrader(broker, OPEN_LONG_RESPONSE);
  await trader.runOnce();

  assert.equal(positionStore.open(traderId).length, 0, 'the naked position must be flattened');
  assert.ok(
    broker.placed.some((p) => p.type === 'MARKET' && p.reduceOnly === true),
    'the emergency flatten must reach the exchange',
  );

  const trades = tradeStore.list(traderId);
  assert.equal(trades.length, 1, 'the emergency close must be booked, not silently dropped');
  assert.equal(trades[0]!.closeReason, 'protection_unavailable');
  assert.ok(trades[0]!.exitPrice > 0, 'the recorded exit must carry a real price');

  // Both orders of the round-trip are in the audit trail.
  const purposes = orderStore.list(traderId).map((o) => o.purpose);
  assert.ok(purposes.includes('entry'), 'the entry order must be recorded');
  assert.ok(purposes.includes('exit'), 'the flatten order must be recorded');
});

/* -------------------------------------------------------------------------- */
/*  Unconfirmed fills                                                          */
/* -------------------------------------------------------------------------- */

test('a partially filled exit is not booked as a full close', async () => {
  /*
   * Why this test exists (D4).
   *
   * `waitForFill` gives up after its timeout and returns the last state it saw,
   * which can be a partial fill. The exit path used `executedQty || local.quantity`,
   * so a timeout was booked as a **full** close: the remainder stayed open at the
   * exchange, the next `reconcilePositions` saw the position still there, and the
   * same round-trip was booked a second time. The ledger showed a trade that had
   * not completed while the account still carried the position.
   *
   * Unconfirmed means unconfirmed: no `trades` row, and the local position stays
   * open so reconciliation can settle the truth from the exchange.
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  assert.equal(positionStore.open(traderId).length, 1);
  const before = positionStore.open(traderId)[0]!;

  // Only a third of the exit fills before the poll gives up. Armed *after* the
  // entry so the next reduce-only market order — the exit — is the one that
  // comes back partial.
  broker.partialFillRatio = 1 / 3;
  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  assert.equal(tradeStore.list(traderId).length, 0, 'a partial exit must not be booked as a close');
  const stillOpen = positionStore.open(traderId);
  assert.equal(stillOpen.length, 1, 'the remainder is still a real position and must stay recorded');
  assert.equal(stillOpen[0]!.quantity, before.quantity, 'the local quantity is left for reconciliation');

  // The attempt itself is still auditable.
  const exitOrder = orderStore.list(traderId).find((o) => o.purpose === 'exit');
  assert.ok(exitOrder, 'the partial exit attempt must still be recorded as an order');
  assert.equal(exitOrder.status, 'PARTIALLY_FILLED');
});

/* -------------------------------------------------------------------------- */
/*  Funding on the live close path                                             */
/* -------------------------------------------------------------------------- */

test('funding is attributed when the bot closes the position itself', async () => {
  /*
   * Why this test exists (D5).
   *
   * Funding settles every 8 hours and appears in **no** fill, so it can only come
   * from `/fapi/v1/income`. It used to be attributed on the reconcile path alone,
   * which only touches a row it can match — so a close booked live could keep
   * `funding_fee = 0` forever and the platform's net PnL read better than the
   * account's. `trades.setFundingFee()` was dead code (no callers), which is why
   * the value has to be passed into `insert()` instead.
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const opened = positionStore.open(traderId)[0]!;
  // A settlement *inside* the position's lifetime. Funding can only be attributed
  // to the round-trip's own window, so a fixture dated after the close would
  // (correctly) be excluded and the test would prove nothing.
  broker.income = [
    {
      symbol: SYMBOL,
      incomeType: 'FUNDING_FEE',
      income: '-0.0231',
      time: new Date(opened.opened_at).getTime(),
    },
  ];

  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  const [trade] = tradeStore.list(traderId);
  assert.ok(trade, 'the close must be booked');
  assert.ok(
    Math.abs(trade.fundingFee - -0.0231) < 1e-12,
    `funding must be read from the income ledger, got ${trade.fundingFee}`,
  );
  /*
   * Net is derived in one place and must include the funding.
   *
   * ⚠️ **加法：`fundingFee` 是交易所口径的带符号值**（上面那条 fixture 用的
   * `'-0.0231'` 就是真实符号）。这里原来写的是 `− fundingFee` —— 而那个假设
   * 把一笔支出算成了收入，代价是**每轮都报一条假的账目告警**。见 `netPnlOf`。
   */
  assert.ok(
    Math.abs(trade.netPnl - (trade.pnl - trade.fee + trade.fundingFee)) < 1e-12,
    'net PnL must equal gross − fees + funding（资金费带符号）',
  );
});

/* -------------------------------------------------------------------------- */
/*  Circuit-breaker watermark                                                  */
/* -------------------------------------------------------------------------- */

test('an unrealised spike does not permanently trip the drawdown breaker', async () => {
  /*
   * Why this test exists (D2).
   *
   * The watermark was `max(equityStore.highWaterMark, account.equity)`, and
   * `account.equity` is the **margin balance** — it includes unrealised PnL. One
   * unrealised spike therefore raised the watermark permanently: when the price
   * wick retraced, equity came back to baseline, `maxTotalDrawdownPercent`
   * calculated a drawdown that never happened, and the bot refused to open
   * anything — forever, with only a log line to explain it.
   *
   * The watermark is now the realised peak (`equity − unrealized_pnl`). This test
   * runs the exact sequence: open, wick up, wick back.
   */
  const broker = new FakeBroker();
  // A configured breaker, unlike the permissive default of the other tests.
  strategyStore.update(traders.get(traderId)!.strategyId!, {
    config: {
      ...permissiveConfig(),
      circuitBreaker: {
        maxDailyLossPercent: 0,
        maxTotalDrawdownPercent: 5,
        safeModeAfterFailures: 3,
        safeModeProbeCycles: 3,
      },
    },
  });

  // Cycle 1: opens the position; the equity snapshot carries no unrealised PnL.
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  // Cycle 2: the position wicks up +100. This is the snapshot that used to
  // poison the watermark.
  broker.simulateUnrealizedPnl(100);
  await buildTrader(broker, '<decision>[]</decision>').runOnce();
  assert.ok(
    equityStore.list(traderId).some((s) => Math.abs(s.equity - 1100) < 1e-9),
    'the wick must actually be recorded, or the test proves nothing',
  );

  // Cycle 3: the wick retraces and the model tries to open again.
  broker.simulateUnrealizedPnl(0);
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const records = decisionStore.list(traderId);
  const log = records.flatMap((r) => r.executionLog.map((e) => e.detail));
  assert.ok(
    !log.some((d) => d.includes('总回撤熔断')),
    `a retraced unrealised spike must not trip the breaker, got: ${log.join(' | ')}`,
  );
  // And the entry must actually have been attempted, so the assertion above
  // cannot pass merely because no entry was proposed.
  assert.ok(
    log.some((d) => d.includes('已开仓')),
    `the entry must reach execution after the spike retraces, got: ${log.join(' | ')}`,
  );
});

/*
 * 熔断生效且空仓时**不请求模型**。
 *
 * 为什么需要这个测试：熔断原先在步骤 4 检查、到步骤 8 才拦截，中间隔着
 * "抓 11 个标的的行情 + 构建 5.8 万 token 提示词 + 请求模型"。于是熔断期间
 * 每个周期都在**付费生成一批注定被丢弃的决策**（实测约 134 万 tokens/小时，
 * 产出为零，而熔断按"单日"计算，可能持续数小时）。
 *
 * 这个测试钉住两件事，缺一不可：
 *   ① 空仓 + 熔断 → 一次模型调用都不发生；
 *   ② 未熔断 → 照常调用（否则"跳过"会变成"再也不决策"）。
 */
/*
 * 每小时开仓额度用满、且空仓时同样跳过模型请求。
 *
 * 与熔断那条是**同一个判据**：本轮有没有可能产生可执行的动作。
 * 额度满 → 新开仓全被拦；空仓 → 没有平仓可做。所以本轮必定无事可做，
 * 花钱请求模型只会得到一批注定被拒的决策。
 *
 * 实测：额度（3 笔）用满后，最近 12 轮里有 5 轮是这种空转，
 * 每轮约 6 万 tokens，共 30 万 tokens 产出为零。
 *
 * 这个测试钉住的是"额度满也要跳过"，**不是**"额度满就什么都不做" ——
 * 有持仓时必须照常请求，因为决策里可能有平仓。
 */
test('每小时额度用满且空仓时跳过模型请求', async () => {
  let calls = 0;
  const countingModel: DecisionModel = {
    complete: async () => {
      calls += 1;
      return {
        text: OPEN_LONG_RESPONSE,
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        latencyMs: 1,
      };
    },
  };

  /*
   * 额度设成 1（schema 的下限 —— `maxEntriesPerHour` 是
   * `z.number().int().min(1).max(60)`，**写 0 会被拒**，整个 config 回落到默认值，
   * 测试就会以"额度并没满"的方式假绿）。
   * 然后手动记一条开仓事件，让本小时计数达到 1 —— 此时账户仍是空仓。
   */
  strategyStore.update(traders.get(traderId)!.strategyId!, {
    config: {
      ...permissiveConfig(),
      throttle: { ...permissiveConfig().throttle, maxEntriesPerHour: 1 },
    },
  });
  tradeEvents.record(traderId, 'BTCUSDT', 'entry');
  assert.equal(tradeEvents.entriesThisHour(traderId), 1, '夹具应已记下 1 笔本小时开仓');

  const summary = await buildTrader(new FakeBroker(), '', countingModel).runOnce();

  assert.equal(calls, 0, '额度用满且空仓时不得请求模型 —— 那是注定被丢弃的付费调用');
  assert.ok(
    summary.includes('额度'),
    `runOnce 的返回值应说明是额度触发的跳过，实际是：${summary}`,
  );
});
test('熔断生效且空仓时跳过模型请求，未熔断时照常请求', async () => {
  let calls = 0;
  const countingModel: DecisionModel = {
    complete: async () => {
      calls += 1;
      return {
        text: OPEN_LONG_RESPONSE,
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        latencyMs: 1,
      };
    },
  };

  /* --- ① 未熔断：必须调用 --- */
  strategyStore.update(traders.get(traderId)!.strategyId!, {
    config: {
      ...permissiveConfig(),
      circuitBreaker: {
        maxDailyLossPercent: 100,
        maxTotalDrawdownPercent: 100,
        safeModeAfterFailures: 3,
        safeModeProbeCycles: 3,
      },
    },
  });
  await buildTrader(new FakeBroker(), '', countingModel).runOnce();
  /*
   * ⚠️ **`>= 1` 而不是 `=== 1`。**
   *
   * 这条守的是"未熔断时**必须**请求模型"（而不是"只请求一次"）。而现在开仓成功
   * 之后会多一次**执行回执**的追问，所以这里可能是 2 次。
   *
   * 判据改成"至少一次"，它仍然是这条用例真正要守的东西 —— 而"最多几次"
   * 由别处的用例管（那是另一件事）。
   */
  assert.ok(calls >= 1, `未熔断时必须照常请求模型（实际 ${calls} 次）`);
  assert.ok(calls <= 2, `未熔断时不该超过 2 次（主轮 + 执行回执），实际 ${calls} 次`);

  /* --- ② 熔断 + 空仓：一次都不能调用 --- */
  calls = 0;
  strategyStore.update(traders.get(traderId)!.strategyId!, {
    config: {
      ...permissiveConfig(),
      circuitBreaker: {
        maxDailyLossPercent: 0,
        maxTotalDrawdownPercent: 5,
        safeModeAfterFailures: 3,
        safeModeProbeCycles: 3,
      },
    },
  });
  // 高水位 1100、账户回到 1000 = 真实 9.1% 回撤，熔断必然生效
  equityStore.insert({
    traderId,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    equity: 1100,
    availableBalance: 800,
    unrealizedPnl: 0,
    marginUsed: 0,
    openPositions: 0,
    accountEquity: 1100,
    accountUnrealizedPnl: 0,
  });
  const summary = await buildTrader(new FakeBroker(), '', countingModel).runOnce();

  assert.equal(calls, 0, '熔断生效且空仓时不得请求模型 —— 那是注定被丢弃的付费调用');
  assert.ok(
    summary.includes('跳过'),
    `runOnce 的返回值应说明本轮跳过了模型请求，实际是：${summary}`,
  );
});
test('a genuine realised loss still trips the drawdown breaker', async () => {
  /*
   * Companion to the test above, and the reason the watermark fix is not a
   * loosening: a change in *realised* equity must still stop new entries. The
   * watermark is seeded directly here because the point under test is the
   * comparison, not how the loss was produced.
   */
  const broker = new FakeBroker();
  strategyStore.update(traders.get(traderId)!.strategyId!, {
    config: {
      ...permissiveConfig(),
      circuitBreaker: {
        maxDailyLossPercent: 0,
        maxTotalDrawdownPercent: 5,
        safeModeAfterFailures: 3,
        safeModeProbeCycles: 3,
      },
    },
  });

  // The account peaked at 1100 with nothing unrealised. 高水位读的是**账户**两列
  // （`account_equity − account_unrealized_pnl`），`equity` 自 M4 起是本机器人归属
  // 口径 —— 风控的输入因此保持不变（§4.2）。
  equityStore.insert({
    traderId,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    equity: 1100,
    availableBalance: 800,
    unrealizedPnl: 0,
    marginUsed: 0,
    openPositions: 0,
    accountEquity: 1100,
    accountUnrealizedPnl: 0,
  });
  // ...and the broker now reports the baseline 1000, a real 9.1% drawdown.
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  /*
   * 理由可能出现**两处**，取决于熔断在哪一步生效：
   *
   *   · 记录的 `error` 字段 —— 熔断生效且空仓时，周期提前返回、根本不再请求
   *     模型（省掉一次注定被丢弃的付费调用），理由写在 `error` 里；
   *   · `executionLog` 的 detail —— 熔断生效但**有仓位**时，模型必须继续跑
   *     （它的决策里可能有平仓），于是理由由风控在拒绝决策时写入。
   *
   * 两处都算通过 —— 本测试要保证的是"真实回撤仍然拦住开仓"这件事本身，
   * 而不是理由恰好写在哪个字段里。
   */
  const records = decisionStore.list(traderId);
  const reasons = records.flatMap((r) => [
    ...(r.error ? [r.error] : []),
    ...r.executionLog.map((e) => e.detail),
  ]);
  assert.ok(
    reasons.some((d) => d.includes('总回撤熔断')),
    `a real drawdown must still block entries, got: ${reasons.join(' | ')}`,
  );

  /*
   * 真正断言"被拦住"的是这一条：**不许有任何成功的开仓**。
   *
   * 只看理由文字是不够的 —— 理由写对了但订单照样出去，才是真正危险的情况。
   */
  const opened = records.flatMap((r) =>
    r.executionLog.filter((e) => e.status === 'ok' && e.action.startsWith('open_')),
  );
  assert.equal(
    opened.length,
    0,
    `熔断期间不得有任何成功开仓，实际有 ${opened.length} 笔：${opened.map((e) => `${e.action} ${e.symbol}`).join(', ')}`,
  );
  assert.equal(positionStore.open(traderId).length, 0, 'no entry may be opened while blocked');
});

/* -------------------------------------------------------------------------- */
/*  Serialisation against the running cycle                                     */
/* -------------------------------------------------------------------------- */

test('stopping a trader waits for the cycle already in flight', async () => {
  /*
   * Why this test exists (D7/D8).
   *
   * `stop()` cleared the timer and returned immediately. Ctrl+C landing between
   * "entry filled" and "stop placed" therefore exited the process with a naked
   * leveraged position on the exchange and no timer left to fix it — the state
   * §2.6 exists to forbid. Stopping must now drain the cycle.
   */
  const broker = new FakeBroker();
  const trader = buildTrader(broker, OPEN_LONG_RESPONSE, {
    async complete() {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { text: OPEN_LONG_RESPONSE, latencyMs: 150, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  });

  await trader.start();
  await trader.stop('测试：停机');

  assert.ok(
    broker.placed.some((p) => p.type === 'STOP_MARKET'),
    'stop() must not return before the in-flight cycle has placed its protection',
  );
  const open = positionStore.open(traderId);
  assert.equal(open.length, 1);
  assert.ok(open[0]!.stop_order_id, 'the position must be protected by the time stop() resolves');
});

test('a reconcile pass does not run while a cycle is in flight', async () => {
  /*
   * Why this test exists (D7).
   *
   * `/reconcile` built a **second** `AutoTrader` over the same account and ran it
   * concurrently with the live one. Both reconciled the same positions and the
   * same `trades` rows: both could see a position gone, both could book the
   * close, one could close a local row the other had just corrected.
   *
   * The observable contract: the reconcile pass starts only after the cycle has
   * finished — the ledger reads it makes cannot happen while a cycle is running.
   */
  const broker = new FakeBroker();
  const ledgerReads: string[] = [];
  let cycleRunning = false;

  eventBus.subscribe((event) => {
    if (event.type === 'cycle_start') cycleRunning = true;
    if (event.type === 'cycle_end') cycleRunning = false;
  });

  const model: DecisionModel = {
    async complete() {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        text: '<decision>[]</decision>',
        latencyMs: 150,
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
  };

  /*
   * `getIncome` is the first thing the ledger pass does, and it is called
   * unconditionally — unlike the per-symbol fill reads, which only happen for
   * symbols the trader has traded. Instrumenting it is what makes "did the pass
   * start while a cycle was running?" observable.
   */
  const originalGetIncome = broker.getIncome.bind(broker);
  broker.getIncome = async (...args: Parameters<FakeBroker['getIncome']>) => {
    if (!cycleRunning) ledgerReads.push('reconcile');
    return originalGetIncome(...args);
  };

  const trader = buildTrader(broker, '<decision>[]</decision>', model);
  await trader.start();
  try {
    await trader.runReconcile();

    assert.ok(
      ledgerReads.length > 0,
      'the reconcile pass must actually read the ledger, or the test proves nothing',
    );
    // Every ledger read outside a cycle belongs to the reconcile pass, and the
    // first of them can only happen after `cycle_end`.
    assert.equal(
      ledgerReads[0],
      'reconcile',
      'reconciliation must not read the ledger while the cycle is still running',
    );
  } finally {
    // The interval would otherwise keep the test process alive for 15 minutes.
    await trader.stop('测试结束');
  }
});

/* -------------------------------------------------------------------------- */
/*  一个交易所账户、两个机器人                                                  */
/* -------------------------------------------------------------------------- */

test('共用一个交易所账户的两个机器人：不交易的那个必须一直是平的，且不随另一个交易而变动', async () => {
  /*
   * Why this test exists —— 这就是本次修复针对的那个 bug。
   *
   * `equity_snapshots.equity` 过去写的是 `broker.getAccountState().equity`，也就是
   * **共享钱包**的保证金余额；同一个账户下的机器人共用一份凭据，于是它们每个人
   * 的每一行记的都是同一个数。实盘上量到的三个机器人（都挂在同一个账户上）：
   *
   *   #4 测试机器人1   0 笔平仓、净 0.000000 → 显示 +2.67%
   *   #5 测试2         4 笔平仓、净 +0.272133 → 显示 +2.67%
   *   #6 实盘3小时验证  0 笔平仓、净 0.000000 → 显示 −0.06%
   *
   * #4 从来没有成交过，却显示了别的机器人挣来的 +2.67%，而且和 #5 一模一样 ——
   * 因为它们读的是同一个钱包。`unrealizedPnl` 是同一个病的第二个字段：它抄的是
   * 账户的总浮盈，所以两个机器人显示同一个浮动盈亏。
   *
   * 这个用例钉住两件事：
   *   1. 不交易的机器人读数是平的（恰好等于自己的 initialEquity），账户里的浮盈
   *      一分钱都不算它的；
   *   2. 另一个机器人继续交易时，它的每一个数字都**一动不动**。
   */
  const base = traders.get(traderId)!;
  const idleId = traders.create({
    name: 'idle',
    exchangeAccountId: base.exchangeAccountId,
    aiModelId: base.aiModelId,
    strategyId: base.strategyId,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;

  const broker = new FakeBroker();

  /*
   * 交易的机器人先完成一个回合，把 +1 USDT 的已实现盈亏落进**共享钱包**。
   *
   * 用已实现而不是浮盈，是因为共用账户时两个机器人的 `positions` 是共享的行情状态：
   * 不交易的那个会在自己的周期里"收养"对方开着的仓位（`reconcilePositions` 的既有
   * 行为）。平掉之后再观察，账户里变化的是钱，而不是谁名下的持仓。
   */
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  broker.simulateUnrealizedPnl(1);
  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  const traded = computeTraderStats(traderId);
  assert.ok(
    traded.realizedPnl > 0.9,
    `交易的机器人必须真的挣到了钱，否则这个用例证明不了任何事，得到 ${traded.realizedPnl}`,
  );
  assert.ok(Math.abs(traded.equity - 1001) < 0.01, `期望归属权益约 1001，得到 ${traded.equity}`);
  assert.ok(
    Math.abs((await broker.getAccountState()).equity - 1001) < 0.01,
    '共享钱包里应当已经有这 1 USDT（否则下面测的还是同一个数）',
  );

  /*
   * 不交易的机器人跑一轮：它自己的周期会写权益快照，而这条路径正是污染进入它账本
   * 的地方 —— 旧代码在这里把共享钱包的 1001 写成了它的权益，于是它显示 +0.1% 的
   * 收益率，而它的 `trades` 是空的。
   */
  await buildTrader(broker, '<decision>[]</decision>', undefined, idleId).runOnce();

  const idleFlat = computeTraderStats(idleId);
  assert.equal(idleFlat.equity, 1000, '没成交过的机器人必须停在初始权益上，而不是账户权益');
  assert.equal(idleFlat.totalReturnPercent, 0, '别人的钱不是它的收益率');
  assert.equal(idleFlat.unrealizedPnl, 0, '别人的浮盈不是它的浮盈');
  assert.equal(idleFlat.realizedPnl, 0);
  assert.equal(idleFlat.totalTrades, 0);
  assert.equal(idleFlat.maxDrawdownPercent, 0);
  // 共享钱包单独汇报，而且**不等于**归属权益 —— 这两个数以前是同一个。
  assert.ok(
    Math.abs(idleFlat.accountEquity - 1001) < 1e-9,
    `账户（共享钱包）权益应当单独给出（期望 1001），得到 ${idleFlat.accountEquity}`,
  );
  assert.notEqual(idleFlat.accountEquity, idleFlat.equity);

  /** 只取参与归属判断的字段：`uptimeHours` 每次调用都会变，不该参与比较。 */
  const shapeOf = (id: number) => {
    const stats = computeTraderStats(id);
    return {
      equity: stats.equity,
      totalReturnPercent: stats.totalReturnPercent,
      realizedPnl: stats.realizedPnl,
      unrealizedPnl: stats.unrealizedPnl,
      totalTrades: stats.totalTrades,
      openPositions: stats.openPositions,
      maxDrawdownPercent: stats.maxDrawdownPercent,
    };
  };
  const idleBefore = shapeOf(idleId);
  const idleSnapshotsBefore = equityStore.list(idleId).length;

  // 交易的机器人再做一个回合（钱包涨到 1003），不交易的机器人一动不动。
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  broker.simulateUnrealizedPnl(2);
  await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();

  assert.ok(
    computeTraderStats(traderId).realizedPnl > traded.realizedPnl,
    '交易的机器人必须继续在挣钱，否则"另一个没动"可能只是因为它也没动',
  );
  assert.ok(
    (await broker.getAccountState()).equity > 1002,
    '共享钱包必须继续变化，否则"没动"可能只是因为账户也没动',
  );
  assert.deepEqual(
    shapeOf(idleId),
    idleBefore,
    '邻居交易时，不交易的机器人的每一个数字都必须原样不动',
  );
  assert.equal(
    equityStore.list(idleId).length,
    idleSnapshotsBefore,
    '不交易的机器人不该被别人的周期改写快照',
  );

  /*
   * 已停止的机器人在「对账」时也不该被改写快照。
   *
   * 这一遍原来无条件写一条账户权益，于是控制台上一个 stopped 的机器人的数字会
   * 随着它自己的对账（以及邻居的交易）继续变化 —— 停止的机器人，历史必须停止移动。
   * 它对账刚补录的成交仍然会立刻显示出来，因为权益是按 `trades` 现算的，不靠快照。
   */
  const idleTrader = buildTrader(broker, '<decision>[]</decision>', undefined, idleId);
  await idleTrader.runReconcile();
  assert.equal(
    equityStore.list(idleId).length,
    idleSnapshotsBefore,
    '已停止的机器人对账后不该多出一条快照',
  );
  assert.deepEqual(shapeOf(idleId), idleBefore, '对账也不该让停止的机器人的数字移动');
});

/* -------------------------------------------------------------------------- */
/*  关闭流程不得伪装成"操作员停止"                                              */
/* -------------------------------------------------------------------------- */

test('shutdown does not mark the trader as operator-stopped', async () => {
  /*
   * Why this test exists.
   *
   * `AutoTrader.stop()` used to always write `stopped` to the database. That is
   * correct for an operator clicking 停止, and wrong for the process shutting
   * down — because `resumePersisted()` treats `stopped` as **a human decision**
   * and deliberately refuses to resume it.
   *
   * The consequence was silent and total: every deploy or restart turned every
   * running bot into "manually stopped", and it never came back. Nothing looked
   * wrong on the console — the status read `stopped`, exactly as if someone had
   * clicked it. It was found only by restarting a live instance and noticing the
   * bot had not resumed.
   *
   * So the contract is: shutdown stops the loop but leaves `running` on disk;
   * only an explicit operator stop may write `stopped`.
   */
  const broker = new FakeBroker();
  const trader = buildTrader(broker, '<decision>[]</decision>');

  // Start so the persisted status becomes `running`, exactly as a real start does.
  await trader.start();
  assert.equal(
    traders.get(traderId)?.status,
    'running',
    'starting must persist `running`, otherwise nothing is ever resumable',
  );

  // Shutdown path.
  await trader.stop('服务器正在关闭', false);
  assert.equal(
    traders.get(traderId)?.status,
    'running',
    'shutdown must leave `running` on disk so the next boot resumes the bot',
  );

  // Operator path — the default must still mark it stopped.
  await trader.stop('操作员手动停止');
  assert.equal(
    traders.get(traderId)?.status,
    'stopped',
    'an explicit operator stop must persist `stopped`, or resumePersisted would resurrect a bot the human stopped',
  );
});

/* -------------------------------------------------------------------------- */
/*  失败的周期必须留下记录                                                      */
/* -------------------------------------------------------------------------- */

test('模型调用抛错的周期：仍然写出恰好一条失败记录，并带上已经拿到的进度', async () => {
  /*
   * Why this test exists —— 这就是本次修复针对的那个 bug。
   *
   * 审计记录原来是周期的第 11 步，位置在模型调用与执行**之后**，而且硬编码
   * `success: true, error: null`。于是模型调用一旦抛错，`runCycle()` 就直接退出，
   * **一条记录都不写**：决策流里什么都看不到。实盘上正在发生的就是这件事 ——
   * 一个欠费的模型供应商让每一轮都被拒，而操作员在控制台上看不到任何迹象。
   * `decision_records.success` / `error` 两列一直都在，只是从来没有被写过。
   *
   * 这个用例钉住三件事：
   *   1. 失败也要落库，而且**恰好一条**（不能一条都不写，也不能写两条）；
   *   2. `error` 是能照着做的中文说明，而不是堆栈，并且带上服务商原文；
   *   3. 已经拿到的部分（提示词、候选标的）必须一起留下 —— 否则操作员还是看不出
   *      "这一轮原本要问什么"。
   *
   * 状态码用的是 429 + `insufficient_quota`：欠费在真实服务商那里就是这么回报的
   * （见 `llm/errors.ts` 的 QUOTA_MARKERS），而不是靠推理编一个。
   */
  const broker = new FakeBroker();
  const trader = buildTrader(broker, '', {
    async complete() {
      throw classifyHttpError('deepseek', 429, { error: { message: 'insufficient_quota' } });
    },
  });

  await assert.rejects(() => trader.runOnce(), /insufficient_quota/);

  const records = decisionStore.list(traderId);
  assert.equal(records.length, 1, '失败的周期必须留下恰好一条记录');
  const record = records[0]!;
  assert.equal(record.success, false, '失败必须写成 success = false，而不是硬编码的 true');
  assert.ok(record.error, '失败必须带一条 error');
  assert.match(record.error!, /AI 服务额度不足/, '类别要能一眼看出是欠费');
  assert.match(record.error!, /insufficient_quota/, '要带上服务商原文，否则没人知道是谁拒的');
  assert.match(record.error!, /充值/, '说明必须可执行');

  // 部分进度：提示词在发请求之前就写进了审计记录。
  assert.ok(record.systemPrompt.length > 500, '失败记录仍要带上系统提示词');
  assert.ok(record.userPrompt.length > 200, '失败记录仍要带上用户提示词');
  /*
   * 同上：候选池里还可能有序共识标的（多个榜同时指向的）与模型点名的标的 ——
   * 所以断言"包含"而不是"只有它"。
   */
  assert.ok(
    record.candidateSymbols.includes(SYMBOL),
    `失败记录也要带上候选池，实际 ${JSON.stringify(record.candidateSymbols)}`,
  );

  // 失败没有下单，也没有留下持仓。
  assert.equal(broker.placed.length, 0);
  assert.equal(positionStore.open(traderId).length, 0);
});

test('再失败一轮也只有新的一条记录：一个周期一条，不多不少', async () => {
  /*
   * "恰好一条"必须在**多轮**上也成立：记录写在不同位置（早退 / 抛错 / 正常结束）时，
   * 很容易变成"某一轮写两条"。这里跑两轮失败，断言总数正好是 2。
   */
  const broker = new FakeBroker();
  const trader = buildTrader(broker, '', {
    async complete() {
      throw classifyHttpError('deepseek', 401, { error: { message: 'invalid api key' } });
    },
  });

  await assert.rejects(() => trader.runOnce());
  await assert.rejects(() => trader.runOnce());

  const records = decisionStore.list(traderId);
  assert.equal(records.length, 2, '两轮失败 = 两条记录');
  for (const record of records) {
    assert.equal(record.success, false);
    assert.match(record.error!, /AI 服务拒绝/);
  }
});

test('风控裁决抛错的周期：记录里保留提示词、思维链与模型决策', async () => {
  /*
   * Why this test exists.
   *
   * 失败记录不能只有一句错误 —— 如果模型回答已经拿到、只是后面某一步抛了，那么
   * 提示词、思维链、决策与执行日志都必须照样落库。否则操作员看到的是"什么都没发生"，
   * 那正是这次要修的观测空洞的另一种形态。
   *
   * 这里让交易所的最小名义价值查询抛错：它在风控第 10 步被调用，而那时解析已经完成。
   */
  const broker = new FakeBroker();
  const registry = {
    ...fakeRegistry,
    minNotional: () => {
      throw new Error('symbol filters unavailable');
    },
  } as unknown as SymbolRegistry;

  const trader = new AutoTrader({
    trader: traders.get(traderId)!,
    config: strategyStore.get(traders.get(traderId)!.strategyId!)!.config,
    registry,
    market: {} as never,
    marketData: fakeMarketData,
    broker: broker as unknown as BinanceBroker,
    model: modelReturning(OPEN_LONG_RESPONSE),
  });

  await assert.rejects(() => trader.runOnce(), /symbol filters unavailable/);

  const records = decisionStore.list(traderId);
  assert.equal(records.length, 1, '抛错也恰好一条');
  const record = records[0]!;
  assert.equal(record.success, false);
  assert.match(record.error!, /决策处理失败/);
  // 已经拿到的部分全在。
  assert.equal(record.cotTrace, 'Clean setup.');
  assert.equal(record.decisions.length, 1);
  assert.equal(record.decisions[0]!.action, 'open_long');
  assert.ok(record.rawResponse.includes('open_long'), '原始响应也要留下');
  assert.ok(record.systemPrompt.length > 500);
  // 风控在抛错前没有放行任何订单。
  assert.equal(broker.placed.length, 0);
});

test('行情为空的一轮：也留下恰好一条记录，但不推进连续失败计数', async () => {
  /*
   * Why this test exists.
   *
   * 取不到行情时 `runCycle()` 原本**直接 return**，同样一条记录都不写 —— 决策流里
   * 看不出机器人已经好几轮什么都没做。现在它写一条 `success = false` 的记录。
   *
   * 但它**刻意不抛错**：抛错会被 `tick()` 记成一次连续失败、并可能把机器人推进安全
   * 模式。行情空窗是策略层面的正常状态（候选全被过滤掉也会这样），不是模型 / 交易所
   * 故障 —— 所以这里同时钉住"有记录"和"失败计数没有被动过"。
   */
  const broker = new FakeBroker();
  /*
   * 行情服务"连得上但什么都给不出"：选币返回空、快照也是空 —— 这正是行情接口
   * 大面积失败时真实的样子（`market/service.ts` 对单个标的失败是降级而不是抛错）。
   */
  const emptyMarketData = fakeMarketDataService({
    async screenUniverse() {
      return [];
    },
    async screenOpenInterestGrowth() {
      return [];
    },
    async buildSnapshots() {
      return [];
    },
  });

  const trader = new AutoTrader({
    trader: traders.get(traderId)!,
    config: strategyStore.get(traders.get(traderId)!.strategyId!)!.config,
    registry: fakeRegistry,
    market: {} as never,
    marketData: emptyMarketData,
    broker: broker as unknown as BinanceBroker,
    model: modelReturning('<decision>[]</decision>'),
  });

  /*
   * 走**真正的 tick 路径**（start() 会立刻跑一轮）：只有这样"连续失败计数"与
   * 机器人状态才是真的被观察的，而不是靠 runOnce 绕开失败策略。
   */
  await trader.start();
  await trader.stop('测试：行情空窗', false);

  assert.equal(broker.placed.length, 0);

  const records = decisionStore.list(traderId);
  assert.equal(records.length, 1, '什么都没做的一轮同样要留下一条记录');
  assert.equal(records[0]!.success, false);
  assert.match(records[0]!.error!, /行情数据不可用/);

  // 行情空窗**不是**失败：机器人的状态与连续失败计数都不该被它推动。
  assert.equal(traders.get(traderId)!.consecutiveFailures, 0, '行情空窗不该推进连续失败计数');
  assert.equal(
    traders.get(traderId)!.status,
    'running',
    '行情空窗不该把机器人推进 error / safe_mode —— 那会是行为变更，而不是补记录',
  );
});

test('★ 失败文案要说清「具体是哪一种不可用」—— 而不是笼统的"服务商故障"', () => {
  /*
   * ## 用户 2026-10-01 的原话
   *
   * 「还有图示的报错（系统不能自己处理重试？**因为报错的时候我用 API 测试上游是可用的**）」
   *
   * 他看到的只有一句笼统的话：
   *
   *     AI 服务不可用：…这是服务商侧的临时故障（限流 / 过载 / 超时 / 5xx）…
   *
   * 四类原因被混在一句话里，于是**"上游到底怎么了"无法判断** ——
   * 而实测里它们指向完全不同的处置：
   *
   *   · **超时**（`request exceeded 240000ms`）—— 是**我们**的请求跑太久，
   *     该改的是提示词大小与超时配置，不是去服务商后台查；
   *   · **限流**（429）—— 该退避，而不是立刻重试（那会加剧限流）；
   *   · **5xx** —— 确实是上游，等一等就恢复。
   *
   * 用户去服务商后台单独测 API 会发现"上游是好的"，因为那是**另一个请求路径**
   * （请求体小得多）。把类别与 HTTP 状态写在文案里，这个矛盾就不会再出现。
   *
   * 格式约束：第一个全角冒号之前必须是类别（`DecisionFeed.failureCategory()` 依赖它）。
   */
  const rateLimited = describeCycleFailure(
    classifyHttpError('commandcode', 429, { message: 'too many requests' }),
    'model',
  );
  assert.match(rateLimited, /^AI 服务不可用：/, '类别仍在第一个全角冒号前');
  assert.match(rateLimited, /被限流/, '要说清是限流');
  assert.match(rateLimited, /HTTP 429/, '要带上 HTTP 状态 —— 那是可查证的原始事实');

  const serverError = describeCycleFailure(
    classifyHttpError('commandcode', 503, { message: 'upstream error' }),
    'model',
  );
  assert.match(serverError, /^AI 服务不可用：/);
  assert.match(serverError, /HTTP 503/);
});

test('describeCycleFailure：每一类失败都给一句可执行的中文说明，且类别写在第一个全角冒号之前', async () => {
  /*
   * Why this test exists.
   *
   * 这句话是操作员在决策流里唯一会读到的失败信息，所以它必须说清"谁失败了、意味着
   * 什么、要不要做点什么"。同时它必须只用 `llm/errors.ts` 已经判好的 `kind`，**不能**
   * 在这里按 HTTP 状态码再判一次：那个文件里记着一次实测事故 —— 网关在 HTTP 400 里
   * 返回 `模型不可用：deepseek-flash`，而"400 就是参数错误、不可重试"的通用规则让一次
   * 本可成功的请求被放弃。这里钉住"展示层不会把那个 bug 复制一遍"。
   *
   * 最后一条断言钉的是决策流的展示契约：元数据行取第一个全角冒号之前的类别
   * （`DecisionFeed.failureCategory()`），所以每一句话都必须以 `类别：` 开头。
   */
  const quota = describeCycleFailure(
    classifyHttpError('deepseek', 429, { error: { message: 'insufficient_quota' } }),
    'model',
  );
  assert.match(quota, /AI 服务额度不足/);
  assert.match(quota, /充值/);

  const unavailable = describeCycleFailure(
    classifyHttpError('deepseek', 400, { message: '模型不可用：deepseek-flash' }),
    'model',
  );
  assert.match(unavailable, /AI 服务不可用/, 'HTTP 400 里的"模型不可用"是临时不可用');
  assert.doesNotMatch(unavailable, /请求参数错误/);

  const badRequest = describeCycleFailure(
    classifyHttpError('deepseek', 400, { message: 'invalid model id' }),
    'model',
  );
  assert.match(badRequest, /AI 服务拒绝：请求参数错误/);

  const empty = describeCycleFailure(
    new LlmError('No assistant text in deepseek response', null, 'deepseek', true),
    'parse',
  );
  assert.match(empty, /AI 响应无法解析/);

  const market = describeCycleFailure(new Error('fetch failed'), 'market');
  assert.match(market, /行情数据不可用/);

  const exchange = describeCycleFailure(
    new BinanceApiError(-2019, 'Margin is insufficient.', 400, null, '/fapi/v1/order'),
    'execute',
  );
  assert.match(exchange, /交易所拒绝/);
  assert.match(exchange, /保证金不足/);

  const unknown = describeCycleFailure(new Error('boom'), 'bookkeeping');
  assert.match(unknown, /未知错误/);

  // 元数据行的展示契约：`类别：说明`，类别在 12 字以内（一行小字放得下）。
  for (const message of [quota, unavailable, badRequest, empty, market, exchange, unknown]) {
    assert.match(message, /^[^：]{2,12}：/, `类别必须写在第一个全角冒号之前：${message}`);
  }
});

/* -------------------------------------------------------------------------- */
/*  停在 NEW 的委托行必须被结清                                                */
/* -------------------------------------------------------------------------- */

/*
 * 这一组用例针对的显示缺陷：
 *
 *   本地 `orders.status` 分布是 `NEW: 24 / FILLED: 19`，而那 24 行的标的**每一个**的
 *   本地持仓都是 0；同一时刻对实盘账户做签名的只读 `GET /fapi/v1/openOrders` 得到 **0**。
 *   也就是说撤单本身没问题（交易所在撤），只是**本地那一行从来没有人更新过**
 *   （`orders.update()` 在这次修复之前没有任何调用点）。后果是「当前委托」里列出十几行
 *   并不存在的委托 —— 按 §2.7，每一行看起来都像是会朝反方向开出新仓的存活单。
 *   它其实全是假警报，但一个不能相信的界面和真的出事一样糟。
 *
 * 三条成因各有一个用例：触发成交、平仓前撤单、交易所自己撤单；外加一条宽限窗口。
 */

/**
 * 把委托行的 `created_at` 推到宽限窗口之前。
 *
 * 为什么必须动 SQL：`ORDER_SETTLE_GRACE_MS` 是**生产路径**的一部分，不能为了测试把它
 * 调小（那测的就不是真实行为了），而"这张单已经挂了一会儿"只能靠改时间戳来造。
 */
function ageOrders(forTrader = traderId, symbol?: string): void {
  const past = new Date(Date.now() - ORDER_SETTLE_GRACE_MS - 60_000).toISOString();
  if (symbol) {
    getDb().run('UPDATE orders SET created_at = ? WHERE trader_id = ? AND symbol = ?', past, forTrader, symbol);
  } else {
    getDb().run('UPDATE orders SET created_at = ? WHERE trader_id = ?', past, forTrader);
  }
}

/** 重新读一行（`list()` 最新在前，这里按 id 找，与顺序无关）。 */
function orderRow(id: number) {
  const row = orderStore.list(traderId, 200).find((o) => o.id === id);
  assert.ok(row, `订单 #${id} 不见了 —— 结清只能改状态，绝不能删行（§2.2）`);
  return row;
}

function purposeRow(purpose: 'stop_loss' | 'take_profit') {
  const row = orderStore.list(traderId, 200).find((o) => o.purpose === purpose);
  assert.ok(row, `本地没有 ${purpose} 的订单行，用例的前提没有成立`);
  return row;
}

test('触发成交的条件单不会停在 NEW：交易所说 FINISHED，本地就写 FILLED', async () => {
  /*
   * 成因一：条件单触发成交。平仓发生在交易所，本地行还是 `NEW`。
   *
   * 契约：`FINISHED` 必须被翻译成订单状态 `FILLED` —— `orders.status` 是**订单**状态列，
   * 而控制台的终态集合与中文标签表都不认识 Algo 自己的 `FINISHED`。原样写进去，
   * 一张已经成交的止损会继续以"已挂单"留在「当前委托」里，缺陷换个状态码重演。
   *
   * 同时钉住兄弟单：止盈被交易所一并撤掉，它必须是 `CANCELED`，而不是也变成"成交"。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const stop = purposeRow('stop_loss');
  const target = purposeRow('take_profit');
  assert.equal(stop.status, 'NEW', '前提：止损挂上去时是 NEW');
  assert.equal(target.status, 'NEW');

  const firedId = broker.simulateStopFired(stop.quantity);
  assert.equal(firedId, stop.exchangeOrderId, '前提：触发的是被验的那张止损');

  // 挂了一会儿之后再走对账（宽限窗口见最后一个用例）。
  ageOrders();
  await buildTrader(broker, '<decision>[]</decision>').runReconcile();

  const settledStop = orderRow(stop.id);
  assert.equal(settledStop.status, 'FILLED', '触发成交的止损必须被结清，而不是停在 NEW');
  assert.ok(settledStop.filledQty > 0, '交易所报了 actualQty，就该写进成交数量');
  assert.equal(orderRow(target.id).status, 'CANCELED', '被交易所一并撤掉的兄弟单是已撤销');

  // 这一回合照样要记账（§2.3），结清订单行不影响它。
  assert.equal(tradeStore.list(traderId).length, 1);
});

test('平仓时被撤掉的条件单：本地行必须跟着结清（§2.7 的撤单要有回执）', async () => {
  /*
   * 成因二：`executeClose()` 在平仓前先 `cancelAllOrders(symbol)`（§2.7）。
   * 交易所在那一瞬间就撤掉了两张保护单，而本地行一直写着 `NEW`。
   *
   * 契约：平仓成功之后那两张单必须是终态（这里是 `CANCELED`），而且**不能**因此多下
   * 或补撤任何一张单 —— 交易所侧的撤单动作仍然只发生在那一次 `cancelAllOrders()`。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  const stop = purposeRow('stop_loss');
  const target = purposeRow('take_profit');

  // 保护单是上一轮挂上去的：已经过了宽限窗口。
  ageOrders();
  const summary = await buildTrader(broker, CLOSE_LONG_RESPONSE).runOnce();
  assert.match(summary, /平仓 1/, '前提：这一轮真的平掉了仓位');

  assert.equal(orderRow(stop.id).status, 'CANCELED', '平仓前撤掉的止损必须被结清');
  assert.equal(orderRow(target.id).status, 'CANCELED', '平仓前撤掉的止盈必须被结清');

  // 交易所侧没有被重挂、也没有被补撤：两轮合起来只有第 1 轮挂过保护单。
  const conditional = broker.placed.filter(
    (p) => p.type === 'STOP_MARKET' || p.type === 'TAKE_PROFIT_MARKET',
  );
  assert.equal(conditional.length, 2, '结清只是记账，绝不能重新下单或重新撤单');
  /*
   * ⚠️ 两次撤单，**各属于一轮**：开仓那一轮挂保护单之前清一次旧条件单，
   * 平仓那一轮按 §2.7 撤一次。原来只断言一次 —— 那时开仓路径还没有这次撤单，
   * 而过期的 Algo 单占着名额正是老 bug 的根因。
   */
  assert.deepEqual(
    broker.cancelledSymbols,
    [SYMBOL, SYMBOL],
    '撤单只应发生在"开仓挂保护单之前"与"平仓之前"这两处，不该有第三次',
  );
});

test('交易所自己撤掉的条件单（closePosition 兄弟单）：下一次对账结清', async () => {
  /*
   * 成因三：交易所自己撤单。仓位没了之后，`closePosition=true` 的条件单会被交易所一并
   * 撤掉 —— 更不会通知任何人，这是本地最不可能自己知道的一种。
   *
   * 契约：下一遍对账必须把它结清，而且这一回合仍然要记进 `trades`（§2.3）：
   * 结清订单行与记账是两件事，前者不能顶替后者。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  const stop = purposeRow('stop_loss');
  const target = purposeRow('take_profit');

  broker.simulateExternalClose();
  ageOrders();
  await buildTrader(broker, '<decision>[]</decision>').runReconcile();

  assert.equal(orderRow(stop.id).status, 'CANCELED');
  assert.equal(orderRow(target.id).status, 'CANCELED');
  assert.equal(tradeStore.list(traderId).length, 1, '消失的仓位仍然要入账，不能被结清顶替');
  assert.equal(positionStore.open(traderId).length, 0);
});

test('刚下的单不会被宽限窗口误判：交易所那一读没报它，也不等于它已经死了', async () => {
  /*
   * 宽限窗口存在的唯一理由：挂单列表是一次**读**，而一张单从"我们记下它"到"它出现在
   * 挂单列表里"之间可能有极短的时延。没有这个下界，一次刚好排在下单之后的读就会把刚挂上
   * 的保护单判成"已经不在交易所"，在账面上把保护单抹掉 —— 而那正是 §2.6 最怕的状态。
   *
   * 契约：**同一份交易所状态**下，只差 `created_at`（宽限期内 / 宽限期外）两种结果。
   * 这样断言，测的才是窗口本身，而不是别的什么东西。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  const stop = purposeRow('stop_loss');

  // 仓位在交易所消失了（被别的路径平掉），同时两张保护单也已不在挂单列表里 ——
  // 唯一的不同是这两行刚刚才下出去。
  broker.simulateExternalClose();
  await buildTrader(broker, '<decision>[]</decision>').runReconcile();
  assert.equal(
    orderRow(stop.id).status,
    'NEW',
    '刚下的单必须留在原地：一次没报它说明不了任何事',
  );

  // 过了宽限窗口，交易所的同一份回答就必须被采纳。
  ageOrders();
  await buildTrader(broker, '<decision>[]</decision>').runReconcile();
  assert.equal(orderRow(stop.id).status, 'CANCELED', '过了宽限期就该结清，否则脏行永远留着');
});

test('★ 本地还持仓、而保护单在交易所侧消失 → 自动重挂（不再放任裸仓）', async () => {
  /*
   * 这一条守的是 2026-09-26 那次**实测事故**的形态。
   *
   * 一个本地还持仓、而交易所挂单列表里没有它的保护单的标的，真相通常是
   * 「保护单真的没了」—— §2.6 里最糟糕的状态。
   *
   * 原来的处理是"持仓还在时，保护单一行都不碰"：既不改状态、**也不重挂** ——
   * 那等于放任一个裸仓存在。实测 SOLUSDT 就这样裸跑了 **1 小时 25 分钟**
   * （0.16 张、浮盈 +5%，交易所侧止损与止盈全是 `CANCELED`），系统一句告警都没有。
   *
   * 现在分成两件事，两件都要成立：
   *   · 当前生效的那张保护单行**不结清**（它不在交易所 = 真事故，
   *     不能靠一行状态更新把它伪装成"历史脏行"）；
   *   · 同时**自动重挂**（方案 A），并告警说清它此前为什么值得查。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  const stop = purposeRow('stop_loss');
  const target = purposeRow('take_profit');

  // 保护单在交易所侧消失了（被撤 / 过期 / 别的进程），仓位还在本地。
  await broker.cancelAllOrders(SYMBOL);
  ageOrders();

  const before = positionStore.open(traderId).find((p) => p.symbol === SYMBOL)!;
  // 走**周期路径**：生产上"结清 + 补挂"都发生在对账里（`runReconcile()` 只跑
  // 历史成交那一遍，不经过 `reconcilePositions`）。
  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  assert.equal(positionStore.open(traderId).length, 1, '前提：本地仍然持仓');
  /*
   * 旧的那两行会被结清 —— 而这是**对的**：`ensureStopsOnOpenPositions()` 已经把
   * 保护单换成新的一张（`positions` 的单号指向新的），旧那张确实已经不在交易所了。
   * 换句话说，"被结清"与"被重挂"是同一件事的两面：**先有替代者，才有历史行**。
   */
  assert.equal(
    orderRow(stop.id).status,
    'CANCELED',
    '旧的止损行应被结清（它已经被重挂的那张取代，交易所侧也确实没有它了）',
  );
  assert.equal(orderRow(target.id).status, 'CANCELED');

  const after = positionStore.open(traderId).find((p) => p.symbol === SYMBOL)!;
  assert.ok(after.stop_order_id, '★ 必须自动重挂止损 —— 放任裸仓才是这次事故的根因');
  assert.notEqual(
    String(after.stop_order_id),
    String(before.stop_order_id),
    '★ 新单号必须不同于那张已经消失的',
  );

  const live = await broker.getOpenAlgoOrders(SYMBOL);
  const typeOf = (order: unknown): string =>
    String(
      (order as { orderType?: string; type?: string }).orderType ??
        (order as { type?: string }).type ??
        '',
    );
  assert.ok(
    live.some((order) => typeOf(order) === 'STOP_MARKET'),
    '★ 交易所侧必须真的重新挂上了止损（不只是改了本地记录）',
  );
});

test('★ 被替换掉的旧保护单行会被结清（不再永远显示「已挂单」）', async () => {
  /*
   * 用户实测的现象：同一个 SOLUSDT 仓位在「当前委托」里挂着 **4 条止损**
   * （118.10 / 119.607 / 119.627 / 120.942），而交易所侧一张都没有。
   *
   * 成因：追踪止损每上移一次就撤旧挂新，于是每轮留下一行 `orders`；
   * 而结清逻辑原来是"**这个标的还持仓 → 保护单一行都不碰**" ——
   * 那些旧行于是**永远**停在"已挂单"。用户据此问"这是不是 BUG"，它确实是。
   *
   * 判据现在改成"只保护当前生效的那一张"（`positions.stop_order_id` /
   * `tp_order_id` 指向的），被替换掉的旧单照常走交易所核对 → 结清。
   */
  const strategyRecord = strategyStore.list().find((s) => s.name === 'test')!;
  strategyStore.update(strategyRecord.id, { config: breakevenConfig() });

  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  const oldStop = purposeRow('stop_loss');

  /* 抬价触发保本止损上移：撤旧、挂新 —— 于是旧的那张成了"历史行"。 */
  broker.markPrice = 70_000;
  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  const moved = positionStore.open(traderId).find((p) => p.symbol === SYMBOL)!;
  assert.ok(moved.stop_order_id, '前提：止损已重挂');
  assert.notEqual(
    String(moved.stop_order_id),
    String(oldStop.exchangeOrderId),
    '前提：单号已经换成新的（旧的那张成了历史行）',
  );
  assert.equal(orderRow(oldStop.id).status, 'NEW', '前提：旧行仍停在挂单状态');

  ageOrders();
  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  assert.equal(
    orderRow(oldStop.id).status,
    'CANCELED',
    '★ 被替换掉的旧保护单必须被结清 —— 否则界面上会堆出一排幽灵「已挂单」',
  );
});

test('★ 保护单被交易所拒绝时，原因必须出现在提示里（不能写"没有挂单尝试"）', async () => {
  /*
   * 实测 2026-09-27 23:08 ETHUSDT 的界面原文：
   *
   *     ✗ 执行失败  调整保护 ETHUSDT — 新保护单没挂上（拟设止损=2673、止盈=null；
   *       **没有挂单尝试**），已按 §2.6 立即平仓
   *
   * 而日志里交易所明确回了：
   *
   *     -4509 Time in Force (TIF) GTE can only be used with open positions
   *
   * 根因：`placeProtection()` **自己吞掉异常**（它要记一行 REJECTED 订单），
   * 所以调用方的 `.catch()` 永远收不到 —— `failed` 数组是空的，于是渲染成
   * "没有挂单尝试"。一句把可诊断问题变成不可诊断的话。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  broker.failAlgoPlacement =
    '币安错误 -4509：Time in Force (TIF) GTE can only be used with open positions.';

  const adjustResponse = `<decision>[{"symbol":"${SYMBOL}","action":"adjust_protection","stop_loss":66500,"confidence":70,"reasoning":"把止损上移。"}]</decision>`;
  await buildTrader(broker, adjustResponse).runOnce();

  /* ① 挂单**确实被尝试过** —— 所以"没有挂单尝试"这句话本身是错的。 */
  assert.ok(
    broker.opLog.some((op) => op.startsWith('place:STOP_MARKET')),
    '前提：新止损确实被提交过（否则"没有挂单尝试"就不是措辞问题而是事实）',
  );

  /* ② 交易所的拒绝原因必须出现在这一轮的执行日志里。 */
  const row = getDb().get<{ execution_log_json: string }>(
    'SELECT execution_log_json FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT 1',
    traderId,
  );
  assert.ok(row, '前提：这一轮落了一条决策记录');
  assert.match(
    String(row.execution_log_json),
    /-4509/,
    '★ 交易所的拒绝原因必须透传到提示里 —— 否则界面只会说"没有挂单尝试"',
  );
  assert.doesNotMatch(
    String(row.execution_log_json),
    /没有挂单尝试/,
    '★ 这句话是错的：挂单尝试过了，是被交易所拒了',
  );
});

/* -------------------------------------------------------------------------- */
/*  保本止损：顺序不变量                                                        */
/* -------------------------------------------------------------------------- */

/** 与 `permissiveConfig()` 相同，但开了保本止损。 */
function breakevenConfig(): StrategyConfig {
  const base = permissiveConfig();
  return { ...base, riskControl: { ...base.riskControl, breakevenTriggerPercent: 5 } };
}

test('浮盈达标时把止损移到开仓价 —— 而且**先撤旧、再挂新**', async () => {
  /*
   * 这条钉的是保本止损里唯一需要证的不变量：**顺序**。
   *
   * | 顺序 | 新挂失败时 |
   * | --- | --- |
   * | 先撤旧、再挂新 | **仓位无保护** → 必须立刻平仓（§2.6 的最糟状态） |
   * | 先挂新、再撤旧 | 旧止损还在，仓位仍有保护 |
   *
   * 所以断言的是 `opLog` 里 `place` 出现在 `cancel` **之前** —— 不是"两者都发生了"。
   * 只断言后者的话，一个把顺序写反的实现照样能过，而那正是会让仓位暴露的写法。
   *
   * 夹具：入场 68000、止损 66000、止盈 74000。把标记价抬到 70000
   * （价格 +2.94%，3x 下浮盈约 8.8% ≥ 阈值 5%），且**不触发止盈**。
   */
  const strategyRecord = strategyStore.list().find((s) => s.name === 'test')!;
  strategyStore.update(strategyRecord.id, { config: breakevenConfig() });

  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const pos = positionStore.open(traderId).find((p) => p.symbol === SYMBOL);
  assert.ok(pos, '前提：仓位已开');
  assert.equal(pos.stop_loss, 66000, '前提：初始止损在开仓价之下（亏损侧）');

  // 抬价制造浮盈。
  broker.markPrice = 70_000;
  broker.opLog.length = 0; // 只看这一轮的动作

  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  const move = broker.opLog.filter((op) => op.startsWith('place:STOP_MARKET') || op.startsWith('cancel:'));
  assert.ok(move.length >= 2, `应当既有挂新也有撤旧，实际：${JSON.stringify(broker.opLog)}`);

  const placeIdx = move.findIndex((op) => op.startsWith('place:STOP_MARKET@68000'));
  const cancelIdx = move.findIndex((op) => op.startsWith('cancel:'));
  assert.ok(placeIdx >= 0, `新止损应当挂在开仓价 68000，实际：${JSON.stringify(move)}`);
  assert.ok(cancelIdx >= 0, `旧止损应当被撤掉，实际：${JSON.stringify(move)}`);
  assert.ok(
    cancelIdx < placeIdx,
    `**必须先撤旧、再挂新。** 我一开始写的是反过来（理由是"挂新失败时旧止损还在"），` +
      `但那个推理漏了交易所的约束：**币安不允许同一仓位存在两张条件单**，` +
      `所以先挂新必然吃 -4130 —— 实测订单记录里连刷了四条拒绝，` +
      `保本止损从未生效过。实际顺序：${JSON.stringify(move)}`,
  );

  // 本地记录也要跟着走，否则下一轮会重复挂单。
  const after = positionStore.open(traderId).find((p) => p.symbol === SYMBOL);
  assert.equal(after?.stop_loss, 68000, '本地止损价必须更新成保本价，否则每轮都会重复挂一张新止损');
});

test('止损已在保本或更好时不动 —— 棘轮只往有利方向走', async () => {
  /*
   * 允许回退是最坏的一种"自作聪明"：操作员手动设了更紧的止损，
   * 保本逻辑如果把它退回开仓价，等于**主动放宽了风险**。
   *
   * 这里把初始止损直接设在开仓价之上（65000 是止损，68000 是入场 ——
   * 用 69000 模拟"已被移到更好的位置"），断言**没有**任何撤挂动作。
   */
  const strategyRecord = strategyStore.list().find((s) => s.name === 'test')!;
  strategyStore.update(strategyRecord.id, { config: breakevenConfig() });

  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  // 手动把本地止损记到开仓价之上，模拟"已经被移到更好的位置"。
  const pos = positionStore.open(traderId).find((p) => p.symbol === SYMBOL)!;
  positionStore.setProtection(traderId, SYMBOL, 69_000, pos.take_profit, pos.stop_order_id, pos.tp_order_id);

  broker.markPrice = 70_000;
  broker.opLog.length = 0;
  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  const moved = broker.opLog.filter((op) => op.startsWith('place:STOP_MARKET') || op.startsWith('cancel:'));
  assert.deepEqual(moved, [], `止损已在保本之上时不该有任何撤挂动作，实际：${JSON.stringify(moved)}`);
});

/* -------------------------------------------------------------------------- */
/*  总账校验：读不到流水 ≠ 账本错了                                             */
/* -------------------------------------------------------------------------- */

test('★ 读不到交易所流水时，校验必须标出"这一轮不算数"而不是断言账本错了', async () => {
  /*
   * Why this test exists —— 这条告警曾经把"我没查到"报成了"你的账错了"。
   *
   * `incomeEvents` 为空的两种情况含义完全不同：**账户上真的没有流水**，
   * 与**这一次没读到**。原来那个 `catch` 只写 `log.debug`，然后数组停在 `[]` ——
   * 总账校验于是拿一个 0 去比，报出「平台的账本可能有漏记或重复记账」。
   *
   * 实测那条告警长这样：
   *
   *   账目与交易所对不上：平台记录 0.3246 USDT、交易所流水 **0.0000** USDT，差 0.3246
   *
   * —— 0.3246 恰好是那个机器人的**全部净盈亏**，而流水是 0，说明**流水根本没读到**。
   * 同一次运行的落库值 `gap` 只有 0.0057（正常）：**读成功就正常、读失败就报账目错误。**
   *
   * 而这段代码自己写着「一个永久误报的校验比没有校验更糟 —— 它会训练操作员忽略这条
   * 告警，而这是唯一能自动发现『账本错了』的地方」。
   */
  /*
   * ⚠️ **必须先造一笔窗口内的成交，否则这个用例测不到任何东西。**
   *
   * 空库上 `platformNet` 恒为 0；而流水读失败时 `exchangeNet` 也是 0 ——
   * 于是 `gap` 是 0，**不触发告警**，无论被测代码是对是错都会通过。
   * 变异测试（把 `!incomeReadFailed` 条件去掉）没有失败，才把它翻出来。
   */
  tradeStore.insert({
    traderId,
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 1,
    entryPrice: 100,
    exitPrice: 101,
    leverage: 1,
    grossPnl: 1,
    entryFee: 0.05,
    exitFee: 0.05,
    closeReason: 'take_profit',
    openedAt: new Date(Date.now() - 120_000).toISOString(),
    closedAt: new Date(Date.now() - 60_000).toISOString(),
    source: 'bot',
  });

  /*
   * ⚠️ **告警走的是 logger 的 sink，不是 `runtime_logs`。**
   *
   * 第一版这里查的是 `runtime_logs` 表 —— 而那张表由 `server.ts` 的 `setLogSink`
   * 写入，测试进程里**没有那个 sink**，所以它永远是空的：断言"没有这条告警"
   * 在任何情况下都会通过。
   */
  const notices: string[] = [];
  setLogSink((_level, _scope, message) => {
    notices.push(message);
  });

  const readBack = () => {
    const row = getDb().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', `ledger_check:${traderId}`);
    assert.ok(row, '每一轮对账都应当把校验结果落库');
    return JSON.parse(row.value) as { incomeReadFailed?: boolean; exchangeNet?: number; gap?: number };
  };

  /* --- 情形一：流水读不到（注入失败） --- */
  const broken = new FakeBroker();
  broken.getIncome = async () => {
    throw new Error('权重用尽');
  };
  const traderA = buildTrader(broken, '<decision>[]</decision>');
  await traderA.start();
  try {
    await traderA.runReconcile();
    const after = readBack();
    assert.equal(after.incomeReadFailed, true, '必须标出"这一轮没读到流水" —— 否则调用方分不清它与"真的没有流水"');
    assert.equal(after.exchangeNet, 0, '没读到就是 0（这个 0 的含义是"未知"，所以才需要那个标志）');

    /*
     * ★ **这一条才是修复的目的。**
     *
     * 上面那两条只证明了"标志写对了"；而这次修的是**它引发的那句错话** ——
     * 读不到流水时报出「账目与交易所对不上…平台的账本可能有漏记或重复记账」。
     * 没有这条断言，把 `if (!incomeReadFailed && …)` 改回 `if (…)` 仍然全绿。
     */
    assert.ok(
      !notices.some((message) => message.includes('账目与交易所对不上')),
      '读不到流水时**不该**报"账目与交易所对不上" —— 那正是这次修的东西',
    );
  } finally {
    setLogSink(null);
    await traderA.stop('测试结束');
  }

  /* --- 情形二：流水读得到（对照） --- */
  const healthy = new FakeBroker();
  const traderB = buildTrader(healthy, '<decision>[]</decision>');
  await traderB.start();
  try {
    await traderB.runReconcile();
    const after = readBack();
    assert.equal(after.incomeReadFailed, false, '读成功时不该带上那个标志');
  } finally {
    await traderB.stop('测试结束');
  }
});

test('★ 读流水失败那一轮的"差额"不能进提示词 —— 它是假差额', () => {
  /*
   * Why this test exists —— 上一轮修了"是否告警"，却漏了**这条路径**：
   * 同一个 `ledger_check` 还会被 `readForeignActivity` 读出来、喂给模型。
   *
   * `incomeReadFailed` 为真时，`gap` 是在 `exchangeNet` 为 0 的前提下算出来的，
   * 它等于整个 `platformNet` —— 一个**假差额**。把它喂给模型等于告诉它
   * "账本与交易所差了 N USDT、可能有漏记"，而真实情况只是**这一次没读到流水**。
   *
   * 而这条路径的读者比日志更要紧：**它是正在做决策的模型。**
   * （`readForeignActivity` 上面那段注释自己写着"两种失败的含义完全不同：
   *   一个是『我们不知道』，一个是『账没问题』" —— 这里是同一件事的反向。）
   */
  settings.set(`ledger_check:${traderId}`, JSON.stringify({ gap: 0.5, incomeReadFailed: false }));
  assert.equal(readForeignActivity(traderId).ledgerGap, 0.5, '正常的一轮照读');

  settings.set(`ledger_check:${traderId}`, JSON.stringify({ gap: 0.3246, incomeReadFailed: true }));
  assert.equal(
    readForeignActivity(traderId).ledgerGap,
    undefined,
    '读流水失败时那个 gap 是假的，不能进提示词',
  );

  /*
   * 老数据（写这个字段之前落库的那一批）没有 `incomeReadFailed` —— 必须仍然照读，
   * 否则一次升级会**静默丢掉所有历史读数**，而那正好是"账本曾经对不上"的证据。
   */
  settings.set(`ledger_check:${traderId}`, JSON.stringify({ gap: 0.02 }));
  assert.equal(readForeignActivity(traderId).ledgerGap, 0.02, '没有那个字段的老数据必须照读');
});

/* -------------------------------------------------------------------------- */
/*  订单记录的完整性                                                            */
/* -------------------------------------------------------------------------- */

test('★ 开仓手续费要查成交明细写进订单 —— 下单响应里没有它', async () => {
  /*
   * ## 这条用例来自一次"我的修法加的是 0"
   *
   * 我给总账校验加了「把未平仓的持有成本算进平台侧」，它读的是 `orders.fee` ——
   * 而那个字段对每一张开仓单都是 `0`。**我基于一个没验证的假设写了修法。**
   *
   * 币安的下单响应里本来就不含佣金，要另外查成交明细。平仓路径早就这么做了
   * （`lastFillFor`），而开仓路径从来没查过。除了让总账校验失效，它还让
   * **订单列表的「手续费」列对开仓单永远是 0** —— 界面与事实不符。
   */
  const broker = new FakeBroker();
  broker.autoUserTrades = true;

  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const entry = orderStore.list(traderId).find((o) => o.purpose === 'entry');
  assert.ok(entry, '前提：开仓单已记录');
  assert.ok(
    entry.fee > 0,
    `开仓单的手续费必须从成交明细查回来，实际 ${entry.fee}` +
      '（它是总账校验把未平仓成本算进平台侧的唯一数据源，也是订单列表那一列的内容）',
  );
});

test('★ 加仓也要记订单 —— 它是一笔真实成交', async () => {
  /*
   * `add_to_position` 原来下单、等成交、改本地持仓、写节流事件，**唯独没有
   * `recordOrder`** —— 于是订单列表里永远看不到加仓单，而它是一笔有真实手续费的成交。
   * 操作员拿订单列表与交易所核对时会对不上。
   */
  const broker = new FakeBroker();
  broker.autoUserTrades = true;
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const before = orderStore.list(traderId).filter((o) => o.purpose === 'entry').length;

  const addResponse = `<decision>
\`\`\`json
[
  {
    "symbol": "${SYMBOL}",
    "action": "add_to_position",
    "position_size_usd": 100,
    "confidence": 80,
    "reasoning": "结构仍成立，加一点。"
  }
]
\`\`\`
</decision>`;
  await buildTrader(broker, addResponse).runOnce();

  const entries = orderStore.list(traderId).filter((o) => o.purpose === 'entry');
  assert.equal(
    entries.length,
    before + 1,
    `加仓必须多出一条入场订单记录，实际 ${before} → ${entries.length}` +
      '（少了它，"当前委托/历史委托"里就少了这一笔真实成交）',
  );
});

test('★ 加仓时撤不掉旧保护单 → 不许下单（多出来的部分会没有保护）', async () => {
  /*
   * 与 `executeAdjust` 那条（"撤旧失败就不许挂新"）**同一条纪律**，但后果更重：
   * 加仓必须先撤掉"只覆盖旧数量"的保护单 —— 撤不掉就加，多出来的那部分
   * **没有任何保护**（§2.6 最糟的形状），而且接着按新数量重挂必然吃 `-4130`。
   *
   * 这里原来写的是 `cancelAllOrders(...).catch(() => undefined)`：
   * 撤单失败被整个吞掉，然后照样市价加仓。
   * （`cancelAllOrders` 的失败形态是**抛错**，那个 `.catch` 吞的就是它。）
   */
  const broker = new FakeBroker();
  broker.autoUserTrades = true;
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const opened = positionStore.getOpenBySymbol(traderId, SYMBOL);
  assert.ok(opened, '前提：开出了一个仓位');

  /* 撤旧保护单这一步失败：那张单**仍在**交易所上，而且只覆盖旧数量。 */
  broker.failCancelAll = true;
  const placedBefore = broker.placed.length;

  const addResponse = `<decision>
\`\`\`json
[
  {
    "symbol": "${SYMBOL}",
    "action": "add_to_position",
    "position_size_usd": 20,
    "confidence": 80,
    "reasoning": "结构仍成立，加一点。"
  }
]
\`\`\`
</decision>`;
  await buildTrader(broker, addResponse).runOnce();

  const marketAdds = broker.placed.slice(placedBefore).filter((p) => p.type === 'MARKET');
  assert.equal(
    marketAdds.length,
    0,
    '★ 撤不掉旧保护单时不许市价加仓 —— 多出来的那部分会暴露在没有保护的状态下',
  );
  assert.equal(
    positionStore.getOpenBySymbol(traderId, SYMBOL)?.quantity,
    opened.quantity,
    '★ 没下单就不许改本地持仓（数量与交易所必须一致）',
  );
});

test('★ 减仓也要记订单 —— 同上', async () => {
  /*
   * `reduce_position` 算出了 `exitFee`、写进了成交表、改了持仓，也没有 `recordOrder`。
   */
  const broker = new FakeBroker();
  broker.autoUserTrades = true;
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const before = orderStore.list(traderId).filter((o) => o.purpose === 'exit').length;

  const reduceResponse = `<decision>
\`\`\`json
[
  {
    "symbol": "${SYMBOL}",
    "action": "reduce_position",
    "reduce_percent": 50,
    "confidence": 80,
    "reasoning": "结构转弱，先减一半保浮盈。"
  }
]
\`\`\`
</decision>`;
  await buildTrader(broker, reduceResponse).runOnce();

  const exits = orderStore.list(traderId).filter((o) => o.purpose === 'exit');
  assert.equal(
    exits.length,
    before + 1,
    `减仓必须多出一条平仓订单记录，实际 ${before} → ${exits.length}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  失败状态必须能恢复                                                          */
/* -------------------------------------------------------------------------- */

test('★ 一轮失败把状态标成 error，下一轮成功必须回到 running', async () => {
  /*
   * ## 这条用例来自一次真实的"关不掉的红色大横幅"
   *
   * 操作员看到 `/traders/9` 顶上挂着一整条红色横幅：「这一轮模型的输出被截断了…」，
   * 而**机器人其实一直在正常跑**（每 45 分钟一轮、不断产出决策）。
   *
   * 根因是成功分支里那一行条件的遗漏（**两处，各一份拷贝**）：
   *
   *     if (this.status === 'safe_mode') this.setStatus('running', null);
   *
   * 只认 `safe_mode`，而 `error` 是**单次**失败的标记（连续失败到阈值才升到
   * `safe_mode`）。于是：**一次瞬时的模型输出截断 → 状态设为 `error` → 永远回不去**，
   * 只有"重启机器人"能清掉它。
   *
   * 后果不只是"多了一行字"：那个状态会渲染成整页最显眼的告警，**而它是假的** ——
   * 一个长期误报的状态会训练操作员忽略所有告警。
   *
   * ## ⚠️ 第一版用例是无效的（变异测试发现的）
   *
   * 它第二阶段用的是**新的 `buildTrader(...).start()`** —— 而 `start()` 自己就会
   * `setStatus('running', null)`（第 513 行）。所以"成功那一轮能不能恢复"**从来没被
   * 考到**：把实现改回只认 `safe_mode`，那条用例照样通过。
   *
   * 现在两阶段用**同一个实例**：`start()` 跑出失败的一轮，再用 `runOnce()`
   * 跑一轮成功的 —— `stop(_, false)` 不改状态，所以 `error` 会一直留到被真正恢复。
   */
  const broker = new FakeBroker();

  /*
   * ⚠️ **必须用同一个实例** —— `this.status` 是**实例字段**。
   *
   * 第一版两阶段各造了一个实例：阶段二那句恢复的条件是
   * `this.status === 'safe_mode' || 'error'`，而**新实例的 `this.status` 不是
   * `error`**（数据库里是，实例上不是）—— 于是它什么也没做，用例却因为
   * `start()` 自己设了 `running` 而"看起来通过"。
   *
   * 所以模型的响应要**可变**：同一个模型对象，按调用次数返回不同的东西。
   */
  let responseText = '模型被截断了，这里没有 decision 块';
  const model: DecisionModel = {
    async complete() {
      return { text: responseText, latencyMs: 42, usage: { promptTokens: 100, completionTokens: 50 } };
    },
  };
  const trader = buildTrader(broker, '', model);

  /* 阶段一：输出不含 `<decision>`（被截断的样子）→ 走失败分支 → error。 */
  await trader.start();
  await trader.stop('测试：先失败一轮', false);

  assert.equal(
    traders.get(traderId)!.status,
    'error',
    '前提：单次失败应当把状态标成 error（连续失败才是 safe_mode）',
  );
  assert.ok(traders.get(traderId)!.lastError, '前提：这一轮的错误原因已记录');

  /*
   * 阶段二：**同一个实例**、模型这次正常返回。
   *
   * 不能用 `start()` —— 它自己就会 `setStatus('running')`，那样子断言无论实现
   * 对不对都会通过（这正是第一版的问题）。`runOnce()` 走的才是"成功分支里那句恢复"。
   */
  responseText = '<decision>[]</decision>';
  await trader.runOnce();

  assert.equal(
    traders.get(traderId)!.status,
    'running',
    '★ 成功一轮就必须回到 running —— 否则一次瞬时的模型失败会把机器人永久标成故障，' +
      '而它其实一直在正常跑。实测操作员看到的正是那条关不掉的红色横幅。',
  );
});

/* -------------------------------------------------------------------------- */
/*  保护单：先撤后挂                                                            */
/* -------------------------------------------------------------------------- */

test('★ 挂保护单之前必须先撤掉该标的的旧条件单', async () => {
  /*
   * ## 这条用例来自三次完全相同的"提前平仓"
   *
   * 实测序列（三次一模一样）：
   *
   * ```
   * 06:22:17  stop_loss    EXPIRED   单号 3000002207017212   ← 交易所报"已过期"
   *    ...    （2 小时 52 分后，模型决定移动保护位）
   * 09:14:37  stop_loss    REJECTED  -4130「已有止损单」      ← 挂不上
   * 09:14:38  exit         FILLED                            ← 判"保护单缺失"→ 立即平仓
   * ```
   *
   * **过期的 Algo 单在交易所那边仍然占着「该仓位已有条件单」的名额**，而本地看它
   * `EXPIRED` 就以为能挂新的了。于是一次"移动保护位"变成把仓位提前平掉 ——
   * 三次都恰好盈利，纯属运气。
   *
   * ## 为什么断言的是**顺序**而不是"撤了几次"
   *
   * 撤单本身不是目的：**在挂之前撤**才是。只断言"撤过"的话，一个把撤单写在挂单
   * **之后**的实现照样通过 —— 而那个顺序是无效的（挂的时候旧单还在，照样 `-4130`）。
   *
   * 而且这一批要挂两张（止损 + 止盈）：撤单必须在**第一张之前**，不能在两张之间
   * —— 在中间撤会把刚挂好的止损一起撤掉（实测这么写过一次，报的是
   * 「没有可触发的止损单」）。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const ops = broker.opLog;
  const cancelIdx = ops.findIndex((op) => op.startsWith('cancel:'));
  const firstConditional = ops.findIndex(
    (op) => op.startsWith('place:STOP_MARKET') || op.startsWith('place:TAKE_PROFIT_MARKET'),
  );

  assert.ok(cancelIdx >= 0, `挂保护单之前必须先撤一次旧条件单，实际操作序列：${JSON.stringify(ops)}`);
  assert.ok(firstConditional >= 0, '前提：这一轮确实挂了保护单');
  assert.ok(
    cancelIdx < firstConditional,
    `★ 撤单必须在**第一张保护单之前**。过期的 Algo 单在交易所仍占名额，` +
      `不先撤就是 -4130 → 判"保护单缺失" → 把仓位提前平掉。实际序列：${JSON.stringify(ops)}`,
  );
  /* 两张保护单都挂上了 —— 撤单没有把先挂的那张撤掉。 */
  assert.equal(
    ops.filter((op) => op.startsWith('place:STOP_MARKET')).length,
    1,
    '止损必须挂着，不能被同一批里的撤单撤掉',
  );
  assert.equal(
    ops.filter((op) => op.startsWith('place:TAKE_PROFIT_MARKET')).length,
    1,
    '止盈同理',
  );
});

/* -------------------------------------------------------------------------- */
/*  按需取数                                                                    */
/* -------------------------------------------------------------------------- */

test('★ 模型可以中途要数据：要什么就取什么，取完再给它出结论', async () => {
  /*
   * ## 这条用例守的是"数据视界"
   *
   * 在此之前，一个周期开始时批量取好的数据就是模型的**全部世界**：
   * 它看了 1h 觉得没机会，而 1m 图上刚放量突破 —— **它没有任何办法去要那张图**。
   * 真人交易员是反过来的：先扫一眼候选，**再针对性地去翻**那个让他起疑的图。
   *
   * 这条用例走完整链路：**模型要 → 系统取 → 回喂 → 模型给结论**。
   */
  const { market, requests } = recordingMarketData();
  const responses = [
    /* 第一轮：分析完发现要更多数据。 */
    '15m/1h 都没有干净结构，但盘口像刚启动 —— 我要 1 分钟图确认。\n' +
      '<tool>{"tool":"get_klines","args":{"symbol":"ETHUSDT","timeframe":"1m","count":120}}</tool>',
    /* 第二轮：拿到数据后给结论。 */
    OPEN_LONG_RESPONSE,
  ];
  let call = 0;
  const model: DecisionModel = {
    async complete() {
      const text = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return { text, latencyMs: 42, usage: { promptTokens: 100, completionTokens: 50 } };
    },
  };

  const trader = new AutoTrader({
    trader: traders.get(traderId)!,
    config: strategyStore.get(traders.get(traderId)!.strategyId!)!.config,
    registry: fakeRegistry,
    market: {} as never,
    marketData: market,
    broker: new FakeBroker() as unknown as BinanceBroker,
    model,
  });

  const summary = await trader.runOnce();

  assert.equal(requests.length, 1, `应当恰好取一次数，实际 ${JSON.stringify(requests)}`);
  assert.deepEqual(
    requests[0],
    { symbol: 'ETHUSDT', timeframe: '1m', count: 120 },
    '**取的数据必须正是模型要的那一份** —— 换个周期或换个标的都等于没听懂它',
  );
  /* 取完之后它仍然要能给出决策 —— 而且要真的被解析、被执行。 */
  assert.match(summary, /开仓 1|open/i, `第二轮应当产出决策，实际摘要：${summary}`);
  /*
   * ⚠️ **`call` 现在是 3，而不是 2** —— 因为开仓成功之后还有一次**执行回执**。
   *
   * 这一条守的是"要数据那一步真的多问了一次"（1 次要数据 + 1 次给结论），
   * 而回执是另一个机制加的第三次。所以判据写成"**至少 2 次**"+
   * "**不多于 3 次**" —— 那既守住了原来的意图，也钉住了"回执只追问一轮、
   * 不递归"这条纪律。
   */
  assert.equal(call, 3, '要数据一轮、给结单一轮、执行回执一轮 —— 回执只追问一次，不递归');
});

test('没有工具调用时不多问一次 —— 大多数轮次都该只调一次模型', async () => {
  /*
   * 反面：**绝大多数周期模型不会要数据**。如果那条路径也多发一次请求，
   * 每轮就白烧 10 万 token —— 而这个是热路径，代价按周期数放大。
   */
  const { market, requests } = recordingMarketData();
  let call = 0;
  const model: DecisionModel = {
    async complete() {
      call += 1;
      return {
        text: OPEN_LONG_RESPONSE,
        latencyMs: 42,
        usage: { promptTokens: 100, completionTokens: 50 },
      };
    },
  };

  await new AutoTrader({
    trader: traders.get(traderId)!,
    config: strategyStore.get(traders.get(traderId)!.strategyId!)!.config,
    registry: fakeRegistry,
    market: {} as never,
    marketData: market,
    broker: new FakeBroker() as unknown as BinanceBroker,
    model,
  }).runOnce();

  /*
   * ⚠️ **断言的是"没有为取数多问"，不是"总共只调一次模型"。**
   *
   * 这条用例原来的期望是 `call === 1`。而现在开仓成功之后会多一次**执行回执**
   * 的追问（把成交价交回给模型），所以这里实际是 2 次。
   *
   * 那**不是回归**：回执是另一个机制，而这条用例守的是"取数那条路径不要在
   * 没必要的时候追问"。所以判据改成**"取数请求数为 0"** —— 那才是它要守的东西，
   * 而调用次数只作为"没有取数轮"的佐证。
   */
  assert.equal(requests.length, 0, '没要数据就不该取数');
  assert.ok(
    call <= 2,
    `没有工具调用时不该为取数多问；算上执行回执最多 2 次，实际 ${call} 次`,
  );
});

/* -------------------------------------------------------------------------- */
/*  保证金模式                                                                  */
/* -------------------------------------------------------------------------- */

test('★ 开仓前把保证金模式设成逐仓 —— 这一步以前完全缺失', async () => {
  /*
   * ## 为什么这条用例重要
   *
   * 币安官方明文：**「All contracts and positions are defaulted to the Cross
   * Margin mode」** —— 不管它，账户就是**全仓**。而这个系统在此以前从来没调用过
   * `setMarginType`，所以实盘上一直是全仓。
   *
   * 全仓意味着：**任何一笔判断错到底，都可能把其他仓位的钱一起带走** ——
   * 爆仓清空整个合约钱包，而不是亏掉那一笔。对一个小本金、多仓位的账户，
   * 这不是理论风险。
   *
   * 硬约束是它**只能在零持仓、零挂单时改**，所以正确的位置是"每个标的下第一单
   * 之前" —— 也就是这条用例走的那条路径。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  assert.ok(
    broker.marginTypeCalls.length > 0,
    '开仓路径必须设置保证金模式 —— 不设就是币安默认的全仓',
  );
  assert.deepEqual(
    broker.marginTypeCalls.map((c) => c.marginType),
    ['ISOLATED'],
    '默认配置是逐仓：单仓最多亏掉自己的保证金，不会动到别的仓位',
  );

  /* 反面：设不上（该标的已有持仓/挂单）时**不该阻断开仓** —— 它只影响损失上限。 */
  const broker2 = new FakeBroker();
  broker2.marginTypeOk = false;
  const summary = await buildTrader(broker2, OPEN_LONG_RESPONSE).runOnce();
  assert.match(
    summary,
    /开仓 1|open/i,
    `设不上保证金模式不该让开仓失败（那会让"改不了模式"变成"做不了交易"）。实际：${summary}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  杠杆上限来自交易所                                                          */
/* -------------------------------------------------------------------------- */

test('★ 配置写 20x 而交易所只允许 5x 时，按 5x 走 —— 而不是让交易所拒回来', async () => {
  /*
   * ## 这条用例对应的就是那个问题
   *
   * > 我现在跑的是币安子账户，平台应该限制了 5x 最大，**AI 有没有能识别**？
   *
   * 官方 FAQ 明文：普通用户在 **2025-08-12 之后新建的子账户**，合约杠杆不超过 5x。
   * 而在此之前，引擎只认配置里那个数字 —— **同一份配置跑在主账户与子账户上的结果
   * 不会不同**，因为代码根本不知道子账户有这条限制（`leverageBracket` 全仓库 0 命中）。
   *
   * 后果不是"少赚"：模型提 20x → 风控照批 → `setLeverage` 被交易所拒
   * （`-4203`/`-4209`）→ 它收到一句**自己无法预先算出来**的拒绝。
   *
   * 现在引擎取**两者的小**。
   */
  const strategy = strategyStore.get(traders.get(traderId)!.strategyId!)!;
  strategyStore.update(strategy.id, {
    config: {
      ...strategy.config,
      riskControl: { ...strategy.config.riskControl, btcEthMaxLeverage: 20 },
    },
  });

  const broker = new FakeBroker();
  /* 交易所说：这个标的只能 5x（子账户那条限制）。 */
  broker.maxLeverageCap = 5;

  /* 模型要 20x —— 照配置是完全合法的。 */
  const greedy = OPEN_LONG_RESPONSE.replace(/"leverage":\s*3/, '"leverage": 20');
  await buildTrader(broker, greedy).runOnce();

  const placed = broker.placed.find((p) => p.type === 'MARKET');
  assert.ok(placed, '前提：确实下了一单');
  assert.equal(
    broker.leverageCalls.at(-1)?.leverage,
    5,
    '★ 传给交易所的杠杆必须是**交易所允许的那个**（5x），不是配置里那个（20x）—— ' +
      '否则会被交易所拒回来，而模型收到一句它无法预先算出的错误',
  );
});

test('读不到档位时退回配置上限 —— 读不到不该让交易停下来', async () => {
  /*
   * 反面：`getMaxLeverage` 返回 `null`（接口失败 / dry-run / 响应形状不认识）时，
   * 引擎必须**只用配置上限**，行为与改动之前完全一致。
   *
   * 这一条比上一条更重要：一个"读不到就不开仓"的实现会让网络抖动变成停摆。
   */
  const strategy = strategyStore.get(traders.get(traderId)!.strategyId!)!;
  strategyStore.update(strategy.id, {
    config: {
      ...strategy.config,
      riskControl: { ...strategy.config.riskControl, btcEthMaxLeverage: 20 },
    },
  });

  const broker = new FakeBroker();
  broker.maxLeverageCap = null; // 读不到

  const greedy = OPEN_LONG_RESPONSE.replace(/"leverage":\s*3/, '"leverage": 12');
  await buildTrader(broker, greedy).runOnce();

  assert.equal(
    broker.leverageCalls.at(-1)?.leverage,
    12,
    '读不到交易所档位时应当照模型提的走（只受配置上限约束）—— 不能因此拒绝交易',
  );
});

/* -------------------------------------------------------------------------- */
/*  加仓 / 减仓按「实际成交量」记账，不是请求量                                    */
/* -------------------------------------------------------------------------- */

test('★ 减仓只部分成交时，本地持仓按实际成交量减 —— 不是按请求量', async () => {
  /*
   * ## 这条来自一次审计，而它是同一个病的最后一个入口
   *
   * 开仓与平仓路径早就改成"只看 `executedQty`"了（那也是之前一个真实 bug 的
   * 修法：开仓单 `status=NEW` 而 `executedQty` 有值，用 `|| quantity` 回退会把
   * 未确认的成交记成完全成交）。而 `executeAdd` / `executeReduce` 两条**没跟上**：
   *
   * 它们取了 `filled.avgPrice`，却没取 `filled.executedQty`，然后拿**请求量**去算
   * 毛盈亏、订单记录、成交记录、剩余持仓、已实现盈亏累计 —— **5 个数字一起偏离**。
   *
   * 部分成交在实盘上不罕见（市价单在流动性薄的标的上会分批成交），而它对账时
   * 表现为"本地持仓与交易所对不上"，那正是我们花了很多轮在修的那类问题。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const before = positionStore.open(traderId).find((p) => p.symbol === SYMBOL);
  assert.ok(before, '前提：已开仓');
  const originalQty = before.quantity;

  /* 模型说减一半，而交易所**只成交了三分之一**（`partialFillRatio` 消费一次）。 */
  broker.partialFillRatio = 1 / 3;
  const reduceResponse = `<decision>
\`\`\`json
[
  {
    "symbol": "${SYMBOL}",
    "action": "reduce_position",
    "reduce_percent": 50,
    "confidence": 80,
    "reasoning": "先减一半锁盈。"
  }
]
\`\`\`
</decision>`;
  await buildTrader(broker, reduceResponse).runOnce();

  const after = positionStore.open(traderId).find((p) => p.symbol === SYMBOL);
  assert.ok(after, '减仓不该把仓位整个平掉');
  const reduced = originalQty - after.quantity;
  const requested = originalQty * 0.5;

  assert.ok(
    reduced < requested * 0.9,
    `减仓数量必须按**实际成交**（约 ${(requested / 3).toFixed(6)}）而不是请求量（${requested.toFixed(6)}）记。` +
      `实际减了 ${reduced.toFixed(6)} —— 按请求量记账会让本地持仓比交易所多减`,
  );
  assert.ok(reduced > 0, '成交了一部分，就该减掉那一部分');
});

/* -------------------------------------------------------------------------- */
/*  限价入场                                                                    */
/* -------------------------------------------------------------------------- */

/** 一条"挂限价单做多"的模型响应。 */
function limitEntryResponse(limitPrice: number, markPrice: number): string {
  /*
   * ⚠️ **止损止盈要相对市价满足盈亏比，不是相对限价。**
   *
   * 风控算盈亏比用的是**当前市价**与那两个价位的距离（它不知道也不该知道
   * 这笔将来会挂在哪儿）。所以挂一个低于市价 3% 的限价单时，止损如果按限价
   * 算就变成"距市价 -4.9%"，而止盈只有 +2.8% —— 盈亏比 0.57，直接被拒。
   *
   * 这不是系统的毛病：真实交易员挂低吸单时，止损当然按他的入场价算，
   * 但他不会设一个**相对当前市价**只有 0.57 盈亏比的单。夹具要照他的做法写。
   */
  const stop = markPrice * 0.985;
  const target = markPrice * 1.05;
  return `<decision>
\`\`\`json
[
  {
    "symbol": "${SYMBOL}",
    "action": "open_long",
    "entry_type": "limit",
    "limit_price": ${limitPrice},
    "leverage": 3,
    "position_size_usd": 60,
    "stop_loss": ${stop.toFixed(4)},
    "take_profit": ${target.toFixed(4)},
    "confidence": 80,
    "reasoning": "预测回踩到这个区间，挂单等成交。"
  }
]
\`\`\`
</decision>`;
}

test('★ 限价入场：挂单后不建仓，成交后才转正并挂上保护单', async () => {
  /*
   * ## 这条用例走的是「真实交易员」那条路
   *
   * 分析完行情之后预测一个区间、在那儿挂限价单等着，而不是立刻市价吃进去
   * （后者付 taker 费、还吃滑点）。这个系统在此之前只会市价开仓。
   *
   * 它要证明四件事：
   *
   * 1. **挂的是 `LIMIT` 单**，不是一个市价单；
   * 2. **挂了之后本地没有持仓** —— 只有一行 `pending`（`open()` 看不到）；
   * 3. **对账发现成交后，仓位带着止损止盈转正**；
   * 4. **保护单在同一轮里就挂上了** —— 否则那段窗口就是没有保护的杠杆仓位。
   */
  const broker = new FakeBroker();
  /* 价格要低于市价，否则会被判成"会立即成交"。 */
  const limitPrice = broker.markPrice * 0.995;

  const first = await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();

  /* ① 挂的是限价单。 */
  const limitOrder = broker.placed.find((p) => p.type === 'LIMIT');
  assert.ok(limitOrder, `必须挂出 LIMIT 单，实际下了：${broker.placed.map((p) => p.type).join('、')}`);
  assert.equal(limitOrder.price, limitPrice, '挂单价必须就是模型给的那个价位');
  assert.equal(limitOrder.timeInForce, 'GTC', '挂单要一直有效到撤销，不能 IOC');

  /* ② 这一轮没有持仓 —— 只有一行 pending。 */
  assert.equal(
    positionStore.open(traderId).filter((p) => p.symbol === SYMBOL).length,
    0,
    '★ 挂单不等于建仓 —— 这一轮本地不能出现持仓（否则就是"界面说有仓、交易所说没有"）',
  );
  const pendingRows = positionStore.pending(traderId);
  assert.equal(pendingRows.length, 1, '应当留下一行待成交记录，供对账去盯');
  assert.equal(pendingRows[0]!.entry_price, limitPrice, 'pending 行要记住打算成交的价位');
  assert.equal(pendingRows[0]!.stop_loss !== null, true, 'pending 行必须带着计划中的止损');

  /* ③ 执行摘要说的是"已挂单"，不是"已开仓"。 */
  assert.match(first, /挂单|等待成交/, `摘要应当说清楚这一轮只是挂了单，实际：${first}`);

  /* ④ 让那张单成交，再跑一轮 —— 对账应当把它转正。 */
  const orderId = Number(pendingRows[0]!.entry_order_id);
  broker.fillRestingOrder(orderId);
  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  const opened = positionStore.open(traderId).find((p) => p.symbol === SYMBOL);
  assert.ok(opened, '★ 成交之后必须转成真正的持仓');
  assert.equal(opened.quantity, Number(limitOrder.quantity), '数量取实际成交');
  assert.equal(opened.entry_price, limitPrice, '成交价就是挂单价（这张单是按挂单价成交的）');
  assert.equal(
    positionStore.pending(traderId).length,
    0,
    'pending 行转正后不该还留在待成交集合里',
  );

  /*
   * ⑤ **保护单必须挂上了** —— 这是整条路径里唯一有风险的地方。
   * 成交与挂保护单之间是一个真实的窗口，所以转正与挂单在同一段代码里连着做。
   */
  const stops = broker.placed.filter(
    (p) => p.type === 'STOP_MARKET' && p.symbol === SYMBOL && (p.triggerPrice ?? 0) > 0,
  );
  assert.ok(
    stops.length > 0,
    '★ 成交后必须立刻挂上止损 —— 否则那段时间是没有保护的杠杆仓位（§2.6）',
  );

  /*
   * ⑥ **那张入场单行必须已经结清。**
   *
   * 用户看着「当前委托」问的原话是：「这一笔开仓买入，是否已经成交完了？如果是
   * 成交完了，为什么委托里面还显示有这个？」—— 成交完了（持仓就是证据），而本地
   * 那张订单行一直停在 `NEW`：建仓、挂保护单都做了，唯独没人回写它。界面于是同时
   * 说「持仓 12.7 @ 1.5600」和「开仓 限价 已挂单」，两句话互相矛盾。
   *
   * 这里钉的是**回写发生的地方** —— `promotePendingEntry()` 里，转正那一刻。
   * 兜底那条路（`settleStaleOrders()`）也补了，但它过去被"这个标的还持仓"整段
   * 排除掉，指望不上；这条断言保证不靠兜底也是对的。
   */
  const entryRow = orderStore.list(traderId).find((o) => o.purpose === 'entry');
  assert.ok(entryRow, '前提：入场单应当有一行记录');
  assert.equal(
    entryRow.status,
    'FILLED',
    `★ 入场单成交后必须写成 FILLED，实际停在 ${entryRow.status}` +
      ' —— 停在 NEW 会让「当前委托」永远显示一张早已成交的单',
  );
  assert.ok(
    entryRow.filledQty > 0,
    `★ 成交量也必须回写（实际 ${entryRow.filledQty}）—— settleStaleOrders 判终态时读的就是它`,
  );
});

test('限价单未成交就被撤销时，本地不留任何痕迹', async () => {
  /*
   * 反面：单子被撤了（或过期了），它**从未成为过持仓**。
   *
   * 这一条防的是"pending 行永远留着" —— 那种行会每轮被查询一次，
   * 而更重要的是它会让操作员以为"有一笔入场在等"，实际上那张单早就没了。
   */
  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();

  const pendingRow = positionStore.pending(traderId)[0];
  assert.ok(pendingRow, '前提：留下了待成交记录');
  broker.cancelRestingOrder(Number(pendingRow.entry_order_id));

  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  assert.equal(positionStore.pending(traderId).length, 0, '撤销后不该再留着待成交记录');
  assert.equal(
    positionStore.open(traderId).filter((p) => p.symbol === SYMBOL).length,
    0,
    '没成交就撤销 = 从未建仓，不能凭空多出一个持仓',
  );
});

test('限价买价高于市价时会立即成交 —— 那就不是"挂单等"，按市价处理并说明', async () => {
  /*
   * 模型给了一个**高于市价**的买价：那意味着立刻成交，而不是"等价格过来"。
   *
   * 与其让它悄悄变成一张立即成交的限价单（用户以为在等、实际上已经进场了），
   * 不如**说清楚并明确按市价开仓** —— 行为一致，但话是真的。
   */
  const broker = new FakeBroker();
  const previous = buildTrader(broker, limitEntryResponse(broker.markPrice * 1.003, broker.markPrice));

  const log = await previous.runOnce();
  assert.ok(
    broker.placed.some((p) => p.type === 'MARKET'),
    '会立即成交的"限价单"应当按市价处理，而不是挂一张必然立刻吃掉的单',
  );
  assert.equal(positionStore.pending(traderId).length, 0, '这种路径不该留下待成交记录');
  assert.match(log, /开仓|open|市价/i, `应当走正常开仓路径，实际：${log}`);
});

test('★ 部分成交后被撤销：已经成交的那部分是真实持仓，必须转正', async () => {
  /*
   * ## 这条守的是一个**判断顺序**，而变异测试证明它原来没人守
   *
   * 对账拿到交易所的答复时有两条独立的线索：
   *
   *   · `executedQty > 0` —— **成交了多少**；
   *   · `status ∈ {CANCELED, EXPIRED, …}` —— **这张单还在不在**。
   *
   * 而它们是**可以同时成立**的：一张限价单成交了一部分，剩下的被撤掉
   * （或 IOC 剩余过期）。那种情况下：
   *
   *   | 先判什么 | 结果 |
   *   | --- | --- |
   *   | **先判成交量**（正确）| 转正 + 挂保护单 —— 那笔真实的持仓有人管 |
   *   | 先判状态（错误）| **当成"从未发生"** —— 钱已经花了、仓位已经开了，而本地不知道 |
   *
   * 第二种会留下一个**没有任何保护单、也不在任何账本里的杠杆仓位** ——
   * §2.6 说的最糟状态。
   *
   * 最初写这段时我以为它是显然的，所以没写用例；变异测试（把顺序反过来）
   * 全绿通过 —— **那就是"显然"的反证。** 现在它是显式的。
   */
  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();

  const pendingRow = positionStore.pending(traderId)[0];
  assert.ok(pendingRow, '前提：留下了待成交记录');
  const orderId = Number(pendingRow.entry_order_id);
  const intendedQty = Number(broker.restingOrders.get(orderId)?.origQty ?? 0);

  /* 成交一部分（一半），剩下的被撤 —— 两个条件同时成立。 */
  broker.fillRestingOrder(orderId);
  const resting = broker.restingOrders.get(orderId)!;
  resting.origQty = String(intendedQty / 2);
  resting.executedQty = String(intendedQty / 2);
  resting.status = 'CANCELED';

  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  const opened = positionStore.open(traderId).find((p) => p.symbol === SYMBOL);
  assert.ok(
    opened,
    '★ 成交了一部分就是真实持仓 —— 不能因为"单被撤了"就当成从未发生（那笔钱已经花了）',
  );
  assert.equal(
    positionStore.pending(traderId).length,
    0,
    '转正之后不该还留着待成交记录',
  );

  /*
   * ⚠️ **光断言"有止损单"不够 —— 收养路径也会挂一张。**
   *
   * 变异测试暴露了这一点：把"成交 → 转正"改坏成"成交 → 关掉"之后，用例**仍然通过**。
   * 原因是那个坏实现下，仓位会由 `reconcilePositions` 兜底**收养**进来，
   * 而收养路径同样会补一张**兜底比例**的止损单（那是它的职责）。
   *
   * 两条路都"最终有持仓、有止损"，所以宏观断言分不出对错 —— 区别在**价位**：
   *
   *   · **转正**（正确）：止损就是当初计划好的那个（存在 pending 行上）；
   *   · 收养（兜底）：止损是**兜底比例**算出来的一个系统挑的价位。
   *
   * 所以判据是"止损价位是不是我计划的那个" —— 那才是"系统知道这张单在等什么"的证据。
   */
  const plannedStop = pendingRow.stop_loss;
  assert.ok(plannedStop !== null, '前提：挂单时记下了计划中的止损');
  const stopOrders = broker.placed.filter(
    (p) => p.type === 'STOP_MARKET' && p.symbol === SYMBOL,
  );
  assert.ok(
    stopOrders.some((p) => Math.abs((p.triggerPrice ?? 0) - (plannedStop ?? 0)) < 1e-6),
    '★ 必须用**计划中的止损价位**挂保护单（实际挂的：' +
      stopOrders.map((p) => p.triggerPrice).join('、') +
      `）—— 只挂一张兜底比例的止损说明仓位是被"收养"的，不是这次入场转正的`,
  );
});

test('★ 待成交的挂单要占持仓名额 —— 否则 maxPositions 管不住真实敞口', async () => {
  /*
   * ## 这是一条**真实的风控漏洞**，而且是加挂单那一步时留下的
   *
   * `positionCount` 原来数的是**交易所已存在的仓位**（`livePositions.length`），
   * 而一张挂着的限价单一根都没成交，所以它不在里面。
   *
   * 但**它是已经承诺出去的风险** —— 价格一过来它就变成持仓。不加这一项的话：
   *
   *     maxPositions: 3   →   3 个挂单 + 3 个持仓 = 6 个敞口
   *
   * 也就是说模型可以先把名额用挂单占满，等它们陆续成交，实际敞口翻倍。
   * 挂单与持仓在"占多少风险额度"这件事上**是同一件事**，只是时间不同。
   *
   * ## 用例怎么证明
   *
   * 把 `maxPositions` 设成 1，先挂一张限价单（占掉那个唯一名额），
   * 然后让模型再提一笔开仓 —— **必须被拒**，理由要提到持仓数。
   */
  const strategy = strategyStore.get(traders.get(traderId)!.strategyId!)!;
  strategyStore.update(strategy.id, {
    config: { ...strategy.config, riskControl: { ...strategy.config.riskControl, maxPositions: 1 } },
  });

  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;

  /* 第一轮：挂上一张限价单 —— 它占掉唯一的那个名额。 */
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();
  assert.equal(positionStore.pending(traderId).length, 1, '前提：挂上了一张单');

  /* 第二轮：模型再提一笔市价开仓 —— 名额已经被挂单占了，必须被拒。 */
  const again = OPEN_LONG_RESPONSE.replace(/"confidence":\s*\d+/, '"confidence": 90');
  const summary = await buildTrader(broker, again).runOnce();

  const openedMarket = broker.placed.filter((p) => p.type === 'MARKET');
  assert.equal(
    openedMarket.length,
    0,
    `★ 挂单占着名额时不能再开新仓 —— 否则 maxPositions 管不住真实敞口。` +
      `实际下了 ${openedMarket.length} 张市价单，摘要：${summary}`,
  );
});

test('提示词要告诉模型它在等什么 —— 挂单不能对它隐身', async () => {
  /*
   * ## 没有这一段，模型不知道自己在等什么
   *
   * 提示词的「当前持仓」读的是 `positionStore.open()`（只含已成交），
   * 所以挂单**不在里面** —— 模型会为一笔已经挂好的入场重复提案，或者忘了这件事。
   *
   * 而它必须**单独成段、措辞明确说"不是持仓"**：混进「当前持仓」会让模型
   * 拿它当仓位去管理（"把止损上移"——挂单上根本没有止损单可移）。
   */
  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();

  /*
   * 下一轮拿到的提示词里必须出现那张挂单。
   *
   * 用 `FakeBroker` 之外的办法读不到提示词，所以这里直接看**决策记录**里
   * 落库的那种 —— 它和生产环境存的是同一个字符串。
   */
  const captured: string[] = [];
  const model: DecisionModel = {
    async complete(system, user) {
      captured.push(user);
      return {
        text: '<decision>[]</decision>',
        latencyMs: 10,
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
  };
  await buildTrader(broker, '<decision>[]</decision>', model).runOnce();

  const prompt = captured.at(-1) ?? '';
  assert.match(
    prompt,
    /等待成交的挂单/,
    '★ 提示词里必须有"等待成交的挂单"那一段 —— 否则模型不知道自己在等什么',
  );
  assert.match(prompt, /不是持仓/, '★ 必须说清它不是持仓，否则模型会去管理一个还不存在的仓位');
  /* 挂单价位也要在，模型才能判断"这个价位还该不该等"。 */
  assert.ok(
    prompt.includes(String(limitPrice).slice(0, 6)),
    `挂单价位应当出现在提示词里（找 ${limitPrice}），实际片段：${prompt.slice(0, 200)}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  限价成交后必须把保护单号写回持仓                                              */
/* -------------------------------------------------------------------------- */

test('★ 限价成交后要把止损单号写回持仓 —— 不写，保本守卫会把仓位平掉', async () => {
  /*
   * ## 这条钉的是一个**实测发生过、代价很大**的漏记
   *
   * 生产上的那一轮（`#91` UNIUSDT）：
   *
   * ```
   * 限价单成交 → 挂上计划止损 8.86
   * → 保本守卫想把止损移到成本价 8.98
   * → -4130「该仓位已有止损单」（因为它不知道 8.86 那张是自己挂的）
   * → 判为"保护单缺失" → §2.6 立刻市价平仓
   * ```
   *
   * 而那一笔本来是**盈利**的（挂单价 8.98、成交价 9.073）。
   *
   * 根因：`promotePendingEntry` 挂了止损，却**没把单号写回 `positions.stop_order_id`**。
   * 而保本守卫的第一步就是"读旧止损单号"：
   *
   * ```ts
   * const oldStopId = local.stop_order_id ? Number(local.stop_order_id) : null;
   * if (oldStopId && …) { …撤旧… }        // ← null 就整段跳过
   * ```
   *
   * → 跳过撤旧 → 直接挂新的 → 撞 `-4130`。**同一个文件里已经为"写了一半的记账"
   * 写过很多次注释了。**
   */
  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();

  const pendingRow = positionStore.pending(traderId)[0];
  assert.ok(pendingRow, '前提：挂上了一张单');
  const orderId = Number(pendingRow.entry_order_id);

  /* 让它成交，再跑一轮 —— 对账会转正并挂保护单。 */
  broker.fillRestingOrder(orderId);
  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  const opened = positionStore.open(traderId).find((p) => p.symbol === SYMBOL);
  assert.ok(opened, '★ 成交之后必须转成真正的持仓');

  /*
   * ★ **这里就是那个漏记**：单号必须被写回来。
   *
   * 不写的话 `stop_order_id` 是 `null`，而保本守卫据此认为"没有旧止损可撤"
   * → 直接挂新的 → 撞 `-4130` → 平仓。
   */
  assert.ok(
    opened.stop_order_id,
    '★ 挂上止损之后必须把它的单号写回持仓 —— 不写的话保本守卫会以为没有保护单，' +
      '然后挂新单撞 -4130、把一笔盈利仓位平掉（实测 #91 就是这样）',
  );
});


test('★ 模型可以撤掉自己的挂单 —— 「挂单」不能是一扇单向门', async () => {
  /*
   * ## 这条守的是"能挂不能撤"
   *
   * 上一批做完之后模型能挂限价单、也能从提示词里看见它在等，**但改不了它**。
   * 于是出现这种局面：一张单挂了很久、当初的理由早已不成立（结构破了、
   * 价位被甩开），而它**只能干看着** —— 那张单占着持仓名额，机会成本一直在流。
   *
   * 这个文件里已经为同一条规律写过三次注释：**范例里没有的动作，模型不会写。**
   */
  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();

  const pendingRow = positionStore.pending(traderId)[0];
  assert.ok(pendingRow, '前提：挂上了一张单');

  const cancelResponse = `<decision>
\`\`\`json
[
  {
    "symbol": "${SYMBOL}",
    "action": "cancel_pending",
    "reasoning": "等太久没成交，而结构已经变了 —— 当初的理由不成立。"
  }
]
\`\`\`
</decision>`;
  const summary = await buildTrader(broker, cancelResponse).runOnce();


  assert.equal(
    positionStore.pending(traderId).length,
    0,
    '★ 撤单之后本地不该还留着待成交记录 —— 否则它会被每轮查询，而操作员以为还有一笔在等',
  );
  assert.match(summary, /撤单 1/, `摘要要如实报"撤单 1"，实际：${summary}`);
  /*
   * ⚠️ **撤单不是平仓、更不是开仓。**
   *
   * 执行层是链式分派（最后一个是"当成开仓"），`cancel_pending` 掉进去会被
   * 真的当成一笔开仓 —— 那比"静默什么都不做"更糟。这条断言盯的就是那个。
   */
  assert.equal(
    broker.placed.filter((p) => p.type === 'MARKET').length,
    0,
    '★ 撤单绝不能产生任何下单一 —— 它只是把一张挂着的单收回来',
  );
  assert.match(summary, /开仓 0/, `撤单不该被算成开仓，实际：${summary}`);
});

test('撤单失败时保留本地记录 —— 下一轮继续尝试，而不是当它已经撤了', async () => {
  /*
   * ## ⚠️ 这一条我最初写的是别的场景，而我写错了
   *
   * 原来断言的是"撤单时发现那张单**已经成交** → 本地记录必须保留"。
   * 实测是 **0**：因为**对账（`settlePendingEntries`）每轮先于模型决策跑**，
   * 它已经发现那张单成交、把它**转正**了 —— 撤单那一步看到的是"没有待成交记录"，
   * 走 `skipped` 分支。
   *
   * **那正是正确的顺序**（先对账、后决策）。而"撤单失败 + 已成交"这个组合
   * 要求一个很窄的时序（成交发生在对账之后、撤单之前），在用例里构造不稳定 ——
   * **我没有为让它可测而人为制造那个窗口，因为那样测的是夹具而不是系统。**
   *
   * 改成测**可稳定构造**的那一支：撤单请求失败、而那张单**确实还没成交**。
   * 那时**不能**关掉本地记录 —— 关掉它等于"从此不再管这张单"，
   * 而它可能下一秒就成交。
   */
  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();

  assert.ok(positionStore.pending(traderId)[0], '前提：挂上了一张单');

  /* 撤单请求被拒，而那张单还挂着（没有成交）。 */
  broker.failCancel = true;

  const cancelResponse = `<decision>
\`\`\`json
[{"symbol": "${SYMBOL}", "action": "cancel_pending", "reasoning": "不想等了。"}]
\`\`\`
</decision>`;
  const summary = await buildTrader(broker, cancelResponse).runOnce();

  assert.equal(
    positionStore.pending(traderId).length,
    1,
    '★ 撤单失败时必须保留本地记录 —— 关掉它等于"从此不再管这张单"，而它可能下一秒就成交',
  );
  assert.equal(
    broker.placed.filter((p) => p.type === 'MARKET').length,
    0,
    '撤不掉也不该改用市价开仓 —— 那会把一个"取消入场"的意图变成"立刻入场"',
  );
  assert.match(summary, /开仓 0/, `撤单失败不是开仓，实际：${summary}`);
});

/* -------------------------------------------------------------------------- */
/*  挂单超时自动撤                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 把某个机器人**所有待成交记录**的挂出时刻往前挪，模拟"已经等了很久"。
 *
 * 直接改库而不是注入时钟：`opened_at` 就是这一件事的事实来源，
 * 把它改早与"时间真的过去了"对被测代码**不可区分** —— 而引入一个假时钟
 * 会牵动整个 `autoTrader` 的时间调用面，为了测一条规则不值得。
 */
function agePendingEntries(traderId: number, minutes: number): void {
  getDb().run(
    "UPDATE positions SET opened_at = ? WHERE trader_id = ? AND status = 'pending'",
    new Date(Date.now() - minutes * 60_000).toISOString(),
    traderId,
  );
}

test('★ 挂太久的限价单会被自动撤掉 —— 不能一直占着持仓名额', async () => {
  /*
   * ## 为什么需要一条机械规则，而不是全靠模型自己撤
   *
   * 模型现在能撤单（`cancel_pending`），但那要求它**每轮都记得回头看**。
   * 而它每轮要处理 20 个候选、几个持仓、一堆约束 ——「我半小时前挂了张单」
   * 很容易被挤出去。
   *
   * 与 `applyBreakevenGuard` / `applyDrawdownGuard` 同一个理由：
   * **保护一个已经做出的判断，恰恰是模型可靠地判断错的那件事。**
   * 而"等太久了就撤"没有任何需要判断的成分。
   */
  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();
  assert.equal(positionStore.pending(traderId).length, 1, '前提：挂上了一张单');

  /*
   * 把它"挂出时刻"挪到 600 分钟前。
   *
   * ⚠️ **不再是 100 分钟。** `pendingEntryTimeoutMinutes = 45` 是**基准**，
   * 实际时限会按"挂价距离 ÷ 15m ATR"（随机游走口径）延长，上限 8 小时。
   * 本用例的挂价距现价 0.5%，而夹具的 ATR 与之同量级 —— 算出来的时限约 100+ 分钟，
   * 于是"挪到 100 分钟前"不再能触发它。
   *
   * 挪到 600 分钟既超过了自适应结果、也仍在 480 分钟的硬上限之上 ——
   * 这一条要验的是"**超过时限就必须撤**"这个意图，不是某个具体分钟数。
   * 见 `pendingTimeout.test.ts` 对时限算法本身的用例。
   */
  agePendingEntries(traderId, 600);

  /* 再跑一轮，模型什么都不说 —— 撤销应当由机械规则完成。 */
  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  assert.equal(
    positionStore.pending(traderId).length,
    0,
    '★ 超过时限的挂单必须被自动撤掉 —— 否则它会一直占着持仓名额，而模型可能一直没回头看',
  );
  assert.ok(
    broker.opLog.some((o) => o.startsWith('cancel:')),
    '撤单必须真的打到交易所（不能只改本地记录 —— 那会让交易所还挂着一张我们以为没有的单）',
  );

  /*
   * ⚠️ **撤单之后，那张入场单在本地也必须立刻变成"已撤销"。**
   *
   * 只关掉 `positions` 的待成交行是不够的：`orders` 里那张 `entry` 行会继续停在
   * `NEW`，于是「当前委托」里一直显示一张**交易所侧已经不存在的**挂单。
   * 实测（2026-09-26 04:02）：LTCUSDT 的限价开仓单等满 55 分钟被自动撤掉，
   * 交易所侧逐笔确认没有它，而界面上它仍写着「已挂单」。
   *
   * `settleStaleOrders()` 会在**下一轮对账**兜底结清，但那最多是一个周期
   * （45 分钟）之后；而撤单这一刻就知道事实，就该在这一刻写。
   */
  const entryRow = orderStore.list(traderId, 50).find((o) => o.purpose === 'entry');
  assert.ok(entryRow, '前提：那张入场单有本地行（§2.2：每一张订单都要被记录）');
  assert.equal(
    entryRow.status,
    'CANCELED',
    '★ 超时撤掉的那张入场单必须立刻结清 —— 否则界面会一直说它「已挂单」',
  );
});

test('★ 超时的限价单其实已经成交 → 不许撤，也不许写成已撤销', async () => {
  /*
   * 2026-09-27 ETHUSDT 的实测形态：限价单 @2698 等满 45 分钟被判「未成交，已自动撤掉」，
   * 而它**其实成交了**（交易所侧 `executedQty > 0`）。仓位靠对账的"收养"才被捡回来，
   * 但那张订单行被写成 `CANCELED`（实际 `FILLED`）—— 订单记录里就多出一个假状态。
   *
   * `cancelOrder` 返回 `true` 并不等于"撤掉了"：`-2011 Unknown order`（单子已经不存在，
   * 最常见的原因就是**它成交了**）也被当成成功。所以撤之前必须先读一次权威状态。
   */
  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();

  const pendingRow = positionStore.pending(traderId)[0];
  assert.ok(pendingRow, '前提：挂上了一张单');

  /* 它其实成交了 —— 而我们这一轮才因为超时去看它。 */
  broker.fillRestingOrder(Number(pendingRow.entry_order_id));
  agePendingEntries(traderId, 100);

  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  const entryRow = orderStore.list(traderId, 50).find((o) => o.purpose === 'entry');
  assert.ok(entryRow, '前提：入场单有本地行（§2.2：每一张订单都要被记录）');
  assert.notEqual(
    entryRow.status,
    'CANCELED',
    '★ 它成交了 —— 订单行写成 CANCELED 就是假状态（用户看到的"订单记录不对"就是这个）',
  );
  assert.ok(
    positionStore.open(traderId).length > 0 || positionStore.pending(traderId).length > 0,
    '★ 成交的挂单必须变成持仓（或留给对账转正），不能被"超时撤单"关掉',
  );
});

test('时限内的挂单不许动 —— 时间没到就撤等于让限价入场白做', async () => {
  /*
   * 反面，而且它比上面那条更要紧：**一条把正常挂单也撤掉的规则，会让限价入场
   * 完全失去意义** —— 单子刚挂上就被收回来，等于每次挂单都白付一次判断的代价。
   */
  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();

  agePendingEntries(traderId, 5); // 默认 45 分钟，才等 5 分钟

  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  assert.equal(
    positionStore.pending(traderId).length,
    1,
    '★ 时限内的挂单必须留着 —— 撤早了等于把限价入场变成一个多余的步骤',
  );
});

test('时限设为 0 时关闭这条规则', async () => {
  /*
   * 与 `maxDailyLossPercent` / `breakevenTriggerPercent` 同一约定：**0 = 关闭**。
   *
   * 一个"想关但关不掉"的机械规则比没有它更糟 —— 操作员会以为已经关上了。
   */
  const strategy = strategyStore.get(traders.get(traderId)!.strategyId!)!;
  strategyStore.update(strategy.id, {
    config: {
      ...strategy.config,
      riskControl: { ...strategy.config.riskControl, pendingEntryTimeoutMinutes: 0 },
    },
  });

  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();

  agePendingEntries(traderId, 10_000); // 等了 7 天

  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  assert.equal(
    positionStore.pending(traderId).length,
    1,
    '配置为 0 时必须保留挂单 —— "想关但关不掉"比没有这条规则更糟',
  );
});

/* -------------------------------------------------------------------------- */
/*  执行回执                                                                     */
/* -------------------------------------------------------------------------- */

test('★ 开仓之后把真实成交价交回给模型，让它按实际价位重定保护位', async () => {
  /*
   * ## 这条守的是"能看见自己动手之后发生了什么"
   *
   * 在此之前这个循环是：模型决策 → 执行 → 记账 → 下一轮（45 分钟后）。
   * 也就是说**模型看不见自己动手之后发生了什么**。而有两件事只有执行完才知道：
   *
   *   · **成交价** —— 止损是按**决策时那个价**算的，而实际成交价可能差 0.5%，
   *     止损距离跟着变。真实交易员是成交之后按**实际入场价**定保护位的。
   *   · **拒绝** —— 风控压了多少、交易所为什么拒。
   *
   * 这条用例证明三件事：**追问真的发生了**、**成交价在里面**、
   * **超出范围的动作被忽略**（这一轮只允许调保护位与撤单）。
   */
  const broker = new FakeBroker();
  /** 每次追问的 user 提示词 —— 回执就在最后一条里。 */
  const prompts: string[] = [];
  let call = 0;

  /* 第一轮：正常开仓。第二轮（回执）：要求调保护位 + 一个超范围的开仓。 */
  const model: DecisionModel = {
    async complete(system, user) {
      call += 1;
      prompts.push(user);
      if (call === 1) {
        return { text: OPEN_LONG_RESPONSE, latencyMs: 10, usage: { promptTokens: 1, completionTokens: 1 } };
      }
      /* 回执那一轮：一个合法动作（调保护位）+ 一个越权动作（开仓）。 */
      return {
        text: `<decision>
\`\`\`json
[
  { "symbol": "${SYMBOL}", "action": "adjust_protection", "stop_loss": ${(broker.markPrice * 0.99).toFixed(2)}, "reasoning": "按真实成交价把止损上移一点。" },
  { "symbol": "ETHUSDT", "action": "open_long", "leverage": 5, "position_size_usd": 50, "confidence": 90, "reasoning": "顺便再开一个。" }
]
\`\`\`
</decision>`,
        latencyMs: 10,
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
  };

  const trader = new AutoTrader({
    trader: traders.get(traderId)!,
    config: strategyStore.get(traders.get(traderId)!.strategyId!)!.config,
    registry: fakeRegistry,
    market: {} as never,
    marketData: fakeMarketData,
    broker: broker as unknown as BinanceBroker,
    model,
  });
  await trader.runOnce();

  /* ① 追问真的发生了。 */
  assert.equal(call, 2, '★ 开仓之后必须把结果交回给模型 —— 否则它看不见自己动手之后发生了什么');
  const receipt = prompts.at(-1) ?? '';
  /*
   * ⚠️ 措辞是「你刚才的动作**结果如下**」，而不是「**已经执行**」。
   *
   * 我第一版用的是后者，而回执里现在**也可能有被风控拒绝的条目** ——
   * 那种情况说"已经执行"是**说谎**，而模型会据此以为自己的提案被采纳了。
   */
  assert.match(receipt, /结果如下/, '★ 回执必须说清"这是刚才真的发生了的"');
  assert.match(receipt, /已执行/, '★ 成功的那些要说清状态；被拒的那些另有标记');

  /* ② 真实成交价在里面 —— 那正是这一轮存在的理由。 */
  assert.match(
    receipt,
    new RegExp(String(broker.markPrice).slice(0, 5)),
    `★ 回执里必须有真实成交价（找 ${broker.markPrice}）—— 止损该按它算，而不是按决策时的价位`,
  );

  /* ③ 越权动作被忽略：不许在回执那一轮开新仓。 */
  /*
   * ⚠️ **这条纪律实际有三层，而变异只测得动前两层。**
   *
   * 我第一版想断言执行层那条"不在这一轮允许的范围内"的日志 —— 而它**不会出现**：
   * `ETHUSDT` 在**解析阶段**就被挡住了（回执那一轮喂给解析器的候选池只含当前持仓
   * 的标的），根本没走到执行层。
   *
   * 于是做了个"同时放开两层"的变异（动作白名单 + 候选池）—— **它仍然没被抓到**，
   * 因为第三层在结构上就做不到：`followUpAfterExecution` 调 `executeOpen` 时
   * **不传行情快照**（回执那一段压根没有快照可用），而 `undefined` 会让开仓
   * 直接返回 `skipped`。
   *
   * **我不会为了让这个变异可测而给回执那轮补上快照 —— 那正是要防的事。**
   * 所以这条用例的价值不在于"变异抓得到它"，而在于**它是将来那次改动的哨兵**：
   * 如果有人给回执那轮加了快照（一个看起来无害的"完善"），前两层仍然会拦着，
   * 而这条断言会在那一刻失败。
   */
  assert.equal(
    broker.placed.filter((p) => p.symbol === 'ETHUSDT').length,
    0,
    '★ 回执那一轮不能开新仓 —— 它只能调保护位或撤单，否则一轮之内的敞口会反复膨胀',
  );
  assert.equal(
    positionStore.open(traderId).filter((p) => p.symbol === 'ETHUSDT').length,
    0,
    '★ 也不许在本地凭空多出一个 ETHUSDT 持仓',
  );
});

test('★ 调整保护位时撤旧单失败：必须放弃调整，不许把有保护的仓位平掉', async () => {
  /*
   * **这条用例对应一次真实的平仓**（2026-09-22 22:17:13 ADAUSDT）。
   *
   * `executeAdjust` 原来写的是：
   *
   *     await this.broker.cancelAllOrders(symbol).catch(() => { 继续挂新单 });
   *
   * 撤旧失败时**旧单还在交易所上**，此时去挂新单必然吃币安 `-4130`
   * （同一仓位不允许两张条件单）→ `placeProtection` 返回 null →
   * 下面的 `hasLiveStop` 判否 → 按 §2.6「不留无保护敞口」把仓位平掉。
   *
   * 而那一刻**旧的止损单其实还好好挂着** —— 平掉的是一个**有保护**的仓位，
   * 只因为模型想优化一下止盈价位。实测：开仓仅 0.5 分钟、净 -0.0166 收场；
   * 同一标的此前还被迫在 +1.197% 平过一次，只吃到最大浮盈 3.735% 的一小部分。
   *
   * 同一个文件里的 `applyBreakevenGuard` 早就把这条写对了 ——
   * 「**撤不掉就不要挂新的**：那必然吃 `-4130`，只会多一条无用的拒绝记录」。
   * 两处要求同一条顺序，`executeAdjust` 漏了。这条用例就是那条顺序的哨兵。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();

  const opened = positionStore.getOpenBySymbol(traderId, SYMBOL);
  assert.ok(opened, '前提：开出了一个仓位');
  assert.ok(opened.stop_loss, '前提：开仓时挂上了止损 —— 否则"有保护"这个前提不成立');

  /* 撤旧单这一步失败：旧保护单**仍在**交易所上。 */
  broker.failCancelAll = true;
  const placedBefore = broker.placed.length;

  const newStop = (broker.markPrice * 0.995).toFixed(2);
  await buildTrader(
    broker,
    `<decision>[{"symbol":"${SYMBOL}","action":"adjust_protection","stop_loss":${newStop},"reasoning":"把止损上移一点"}]</decision>`,
  ).runOnce();

  /* ① 仓位必须还在。旧保护单没撤掉，它**不是**无保护敞口。 */
  assert.ok(
    positionStore.getOpenBySymbol(traderId, SYMBOL),
    '★ 撤旧单失败时绝不能平仓 —— 旧保护单仍在，仓位不是"无保护的敞口"',
  );

  /* ② 不许挂新单：旧单还在，挂上去必然 -4130，只会多一条无用的拒绝记录。 */
  const newProtection = broker.placed
    .slice(placedBefore)
    .filter((p) => p.type === 'STOP_MARKET' || p.type === 'TAKE_PROFIT_MARKET');
  assert.equal(
    newProtection.length,
    0,
    `★ 撤不掉就不许挂新的（挂了 ${newProtection.length} 张）—— 旧单还在，必然 -4130`,
  );

  /* ③ 本地止损**不能被改成新的** —— 交易所上那张还是旧价，本地记新价会误导下一轮判断。 */
  const after = positionStore.getOpenBySymbol(traderId, SYMBOL);
  assert.equal(
    after?.stop_loss,
    opened.stop_loss,
    '★ 放弃调整就必须把本地记录也留在旧值 —— 否则下一轮会拿一个交易所上不存在的价位去判断',
  );
});

/* -------------------------------------------------------------------------- */
/*  截断自动重试                                                                 */
/* -------------------------------------------------------------------------- */

test('★ 回复被截断时先重试一次，而不是白等一整轮', async () => {
  /*
   * ## 实测两次截断，`completionTokens` 都正好是 16,384
   *
   * 那是**输出上限**，而其中约 15,000 是思考 —— **思考把输出预算吃光，
   * 正文一个字都没写出来**（`#104`、`#119`）。
   *
   * 原来的处理是直接抛错、这一轮跳过。而那两次都发生在**45 分钟一轮**的时段里，
   * 等于白等一整轮。而重试一次的成本远低于等 45 分钟 —— 这类截断是**一次性**的。
   */
  const broker = new FakeBroker();
  let call = 0;
  const model: DecisionModel = {
    async complete() {
      call += 1;
      if (call === 1) {
        /* 第一次：只有思考、没有 `<decision>` —— 模拟被截断。 */
        return {
          text: '<reasoning>我想了很久很久……</reasoning>',
          latencyMs: 10,
          usage: { promptTokens: 100, completionTokens: 16_384 },
        };
      }
      /* 第二次：正常给出结论。 */
      return {
        text: OPEN_LONG_RESPONSE,
        latencyMs: 10,
        usage: { promptTokens: 100, completionTokens: 50 },
      };
    },
  };

  const summary = await buildTrader(broker, OPEN_LONG_RESPONSE, model).runOnce();

  assert.equal(
    call,
    3,
    '第一次（截断）+ 重试（拿到结论）+ 开仓后的执行回执 —— 共 3 次',
  );
  assert.match(
    summary,
    /开仓 1/,
    `★ 重试拿到结论之后要照常执行 —— 而不是把这一轮判成失败。实际：${summary}`,
  );
});

test('重试仍然没有结论时才按失败计数（不把失败藏起来）', async () => {
  /*
   * 反面，而且它比上面那条更重要：**重试是"多给一次机会"，不是"掩盖失败"。**
   *
   * 截断必须按失败计数 —— 否则 `consecutiveFailures` 永远不涨、
   * **安全模式永远不触发**。那正是这个文件里另一处注释警告过的形态：
   * "同一个失败在诊断里被判失败、在交易里被判成功"。
   */
  const broker = new FakeBroker();
  let call = 0;
  const model: DecisionModel = {
    async complete() {
      call += 1;
      return {
        text: '<reasoning>还是只想不说。</reasoning>',
        latencyMs: 10,
        usage: { promptTokens: 100, completionTokens: 16_384 },
      };
    },
  };

  await assert.rejects(
    () => buildTrader(broker, OPEN_LONG_RESPONSE, model).runOnce(),
    (err: Error) => {
      assert.match(err.message, /被截断/, '两次都没有结论时必须照旧报失败');
      assert.match(err.message, /重试一次仍然如此/, '理由里要说清重试过了');
      return true;
    },
  );
  assert.equal(call, 2, '只重试一次，不递归');
  assert.equal(broker.placed.length, 0, '没有结论就绝不下单');
});

/* -------------------------------------------------------------------------- */
/*  回执要包含"被拒绝"                                                           */
/* -------------------------------------------------------------------------- */

test('★ 风控拒绝了提案时也要回执 —— 那是模型能立刻修正的东西', async () => {
  /*
   * ## 这条来自生产数据，而且它修的是**我自己想错的地方**
   *
   * `#120` 那一轮：`动作 0 条`，但里面有一条 `rejected open_long BNBUSDT`。
   * 而我第一版的回执筛选**只挑 `ok` / `submitted` / `failed`**，理由是
   * "`rejected` 没有产生新状态"。
   *
   * **而那个理由是错的**：模型提了一个被拒的开仓，**要等到下一轮（45 分钟后）
   * 才可能知道**，甚至永远不知道。而"我这个提案为什么没通过"恰恰是它**能立刻
   * 修正**的东西 —— "名义太小"→ 提大一点；"盈亏比不够"→ 换价位。
   *
   * 节流/冷却那种"下去再来"的跳过**不进**回执（模型知道了也做不了什么）——
   * 那条区分也在这条用例的断言里。
   */
  const broker = new FakeBroker();
  let call = 0;
  const prompts: string[] = [];

  const model: DecisionModel = {
    async complete(_system, user) {
      call += 1;
      prompts.push(user);
      if (call === 1) {
        /* 名义价值小到必然被风控拒（低于 minPositionSize）。 */
        return {
          text: `<decision>
\`\`\`json
[{"symbol": "${SYMBOL}", "action": "open_long", "leverage": 3, "position_size_usd": 0.5, "stop_loss": ${(broker.markPrice * 0.98).toFixed(2)}, "take_profit": ${(broker.markPrice * 1.08).toFixed(2)}, "confidence": 90, "reasoning": "试试。"}]
\`\`\`
</decision>`,
          latencyMs: 10,
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      }
      return {
        text: '<decision>[]</decision>',
        latencyMs: 10,
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
  };

  await buildTrader(broker, OPEN_LONG_RESPONSE, model).runOnce();

  assert.equal(broker.placed.filter((p) => p.type === 'MARKET').length, 0, '前提：那笔被拒了');
  assert.ok(call >= 2, '★ 有被拒的提案时也必须回执');
  const receipt = prompts.at(-1) ?? '';
  assert.match(
    receipt,
    /被风控拒绝/,
    `★ 回执里必须告诉模型"你那条被拒了、为什么" —— 否则它要等 45 分钟才知道。实际：${receipt.slice(0, 400)}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  可观测性：追问就要留痕                                                        */
/* -------------------------------------------------------------------------- */

test('★ 追问了就记一条日志 —— 哪怕模型什么都没调整', async () => {
  /*
   * ## 这条守的是"机制可观察"
   *
   * 我第一版只在"模型确实调了什么"时才 emit，于是这两种情况**在日志里长得
   * 一模一样**：
   *
   *   · **回执发生了、而模型回了空数组**（完全正常的答案）；
   *   · **回执压根没发生**（某个筛选条件把它排除了）。
   *
   * 而实测我正是**靠日志判断"回执有没有上线"** —— 那个 0 条的日志让我怀疑了
   * 两轮，还去对了服务启动时间才排除"代码没生效"。
   *
   * **一个观察不到的机制，等于无法验证的机制。** 这条钉住"追问就留痕"。
   */
  const broker = new FakeBroker();
  const messages: string[] = [];
  setLogSink((_level, _scope, message) => {
    messages.push(message);
  });

  let call = 0;
  const model: DecisionModel = {
    async complete() {
      call += 1;
      /* 第一次正常开仓；回执那一轮**什么都不调整**（空数组）。 */
      return {
        text: call === 1 ? OPEN_LONG_RESPONSE : '<decision>[]</decision>',
        latencyMs: 10,
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
  };

  await buildTrader(broker, OPEN_LONG_RESPONSE, model).runOnce();
  setLogSink(null);

  assert.equal(call, 2, '前提：回执确实追问了一次');
  assert.ok(
    messages.some((m) => m.includes('执行回执已追问')),
    `★ 追问了就必须留一条日志 —— 否则"模型没调整"和"回执没发生"分不出来。实际日志：${JSON.stringify(messages.slice(-4))}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  账本不变量                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 检查"一个开着的持仓该有的字段都写了吗"。
 *
 * ## 为什么把它做成一个函数，而不是散在几条用例里
 *
 * 这一轮（Round 17–24）连着修了六个 bug，而它们的形态是**同一个**：
 *
 *   1. `promotePendingEntry` 挂了止损却**没把单号写回** → 保本守卫读不到旧单号
 *      → 跳过撤旧 → 挂新单撞 `-4130` → **把一笔盈利仓位平掉**（实测 `#91`）；
 *   2. 资金费符号反了 → 净额算错 → **每轮都报一条假的账目告警**；
 *   3. 限价单的盈亏比按市价算 → 它**从未挂出过**；
 *   4. 服务日志不落盘 → **所有"机制有没有生效"的判断都是假信号**。
 *
 * **共同点是：数据层少了一个值 / 多了一个符号，而没有任何东西在检查它。**
 * 每一条都是**事后从生产数据里撞出来的** —— 那意味着下一个同类问题也会。
 *
 * 所以这个函数把"该有什么"写下来，让它在**每次测试**里被检查一次。
 */
function assertPositionRowInvariants(label: string): void {
  const open = positionStore.open(traderId);
  for (const p of open) {
    assert.ok(
      p.stop_order_id,
      `[${label}] ★ 开着的持仓必须有止损单号（${p.symbol} 是 null）—— ` +
        '保本守卫靠它判断"有没有旧止损可撤"，读不到就会去挂新单、撞 -4130、然后把仓位平掉（实测 #91）',
    );
    assert.ok(p.stop_loss !== null && p.stop_loss > 0, `[${label}] 开着的持仓必须有止损价（${p.symbol}）`);
    assert.ok(p.quantity > 0, `[${label}] 开着的持仓数量必须为正（${p.symbol}）`);
  }
  const pending = positionStore.pending(traderId);
  for (const p of pending) {
    assert.ok(
      p.entry_order_id,
      `[${label}] ★ 待成交记录必须有交易所单号（${p.symbol} 是 null）—— ` +
        '没单号就对不了账，它会永远占着持仓名额',
    );
  }
}

test('★ 走完一个开仓周期后，持仓行的账本不变量全部成立', async () => {
  /*
   * 这条不测某一个行为，它测**"记账写全了没有"** —— 而上面那个函数列出了
   * "写全"的定义。见它的注释：这一轮六个 bug 全都是它的某个变体。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  assertPositionRowInvariants('市价开仓');
  assert.ok(positionStore.open(traderId).length > 0, '前提：确实开出了一个仓位');
});

test('★ 走完一个限价成交周期后，账本不变量同样成立', async () => {
  /*
   * 限价入场那条路径**曾经在同一个坑里**（`#91`）：挂了止损、没写单号，
   * 而当时 652 项测试全绿 —— 因为那些用例只检查了"止损有没有挂"，
   * 没有检查"单号有没有写回"。
   *
   * 这条与上面那条的区别只在"怎么走到持仓"：一个是市价、一个要等成交。
   * 而**走到之后要满足的东西是同一套** —— 那正是把它抽成函数的意义。
   */
  const broker = new FakeBroker();
  const limitPrice = broker.markPrice * 0.995;
  await buildTrader(broker, limitEntryResponse(limitPrice, broker.markPrice)).runOnce();

  const pendingRow = positionStore.pending(traderId)[0];
  assert.ok(pendingRow, '前提：挂上了一张单');
  /* 挂单状态下必须先满足 pending 的那条不变量。 */
  assertPositionRowInvariants('限价挂单中');

  broker.fillRestingOrder(Number(pendingRow.entry_order_id));
  await buildTrader(broker, '<decision>[]</decision>').runOnce();

  assert.ok(positionStore.open(traderId).length > 0, '前提：那张单成交并转正了');
  assertPositionRowInvariants('限价成交后');
});












