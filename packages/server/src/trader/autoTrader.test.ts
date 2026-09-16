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
  traders,
  trades as tradeStore,
  tradeEvents,
} from '../store/repositories.js';
import {
  AutoTrader,
  describeCycleFailure,
  makeClientId,
  ORDER_SETTLE_GRACE_MS,
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
  readonly cancelledSymbols: string[] = [];
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
    return symbol ? this.positions.filter((p) => p.symbol === symbol) : [...this.positions];
  }

  async setLeverage(symbol: string, leverage: number) {
    this.leverageCalls.push({ symbol, leverage });
    return { ok: true, leverage };
  }

  async ensureOneWayMode() {
    return { changed: false, warning: null };
  }

  async placeOrder(request: Parameters<BinanceBroker['placeOrder']>[0]): Promise<PlacedOrder> {
    this.placed.push(request);
    const id = String(this.nextId++);
    const isConditional = request.type === 'STOP_MARKET' || request.type === 'TAKE_PROFIT_MARKET';

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

  async cancelAllOrders(symbol: string) {
    this.cancelledSymbols.push(symbol);
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

  async getUserTrades() {
    return this.userTrades;
  }

  /** 一次性探针用：交易所成交历史。 */
  userTrades: BinanceUserTrade[] = [];

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

const fakeMarketData = {
  async buildSnapshots() {
    return [snapshot()];
  },
  async getOiRanking() {
    return [];
  },
} as unknown as MarketDataService;

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
  const strategy = strategyStore.get(trader!.strategyId);
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
  assert.equal(records[0]!.promptTokens, 100);
  assert.deepEqual(records[0]!.candidateSymbols, [SYMBOL]);

  // Equity snapshot for the curve.
  assert.ok(equityStore.list(traderId).length >= 1);
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
  // Net is derived in one place and must include the funding.
  assert.ok(
    Math.abs(trade.netPnl - (trade.pnl - trade.fee - trade.fundingFee)) < 1e-12,
    'net PnL must equal gross − fees − funding',
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
  strategyStore.update(traders.get(traderId)!.strategyId, {
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
  strategyStore.update(traders.get(traderId)!.strategyId, {
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
  strategyStore.update(traders.get(traderId)!.strategyId, {
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
  assert.equal(calls, 1, '未熔断时必须照常请求模型');

  /* --- ② 熔断 + 空仓：一次都不能调用 --- */
  calls = 0;
  strategyStore.update(traders.get(traderId)!.strategyId, {
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
  strategyStore.update(traders.get(traderId)!.strategyId, {
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
  assert.deepEqual(record.candidateSymbols, [SYMBOL]);

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
    config: strategyStore.get(traders.get(traderId)!.strategyId)!.config,
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
  const emptyMarketData = {
    async screenUniverse() {
      return [];
    },
    async screenOpenInterestGrowth() {
      return [];
    },
    async buildSnapshots() {
      return [];
    },
    async getOiRanking() {
      return [];
    },
  } as unknown as MarketDataService;

  const trader = new AutoTrader({
    trader: traders.get(traderId)!,
    config: strategyStore.get(traders.get(traderId)!.strategyId)!.config,
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
  assert.deepEqual(broker.cancelledSymbols, [SYMBOL], '撤单仍然只发生在平仓那一次');
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

test('本地还持仓的标的：一行都不碰（那可能是保护单真的没了，不是显示脏了）', async () => {
  /*
   * 这一条守的是**修复的边界**，不是显示效果。
   *
   * 一个本地还持仓、而交易所挂单列表里没有它的保护单的标的，可能的真相是
   * 「保护单真的没了」—— §2.6 里最糟糕的状态。把这种情况也顺手结清，等于用一行状态更新
   * 把一个真实的告警盖掉；而本次修复的授权范围只是"交易所已经不挂了、本地还留着"的显示记账，
   * 依据是"这个标的本地已经没有持仓"。所以持仓还在时，这里必须一行都不改。
   */
  const broker = new FakeBroker();
  await buildTrader(broker, OPEN_LONG_RESPONSE).runOnce();
  const stop = purposeRow('stop_loss');
  const target = purposeRow('take_profit');

  // 保护单在交易所侧消失了（人工撤单 / 别的进程），仓位还在本地。
  await broker.cancelAllOrders(SYMBOL);
  ageOrders();

  await buildTrader(broker, '<decision>[]</decision>').runReconcile();

  assert.equal(positionStore.open(traderId).length, 1, '前提：本地仍然持仓');
  assert.equal(orderRow(stop.id).status, 'NEW', '持仓还在时不得改写订单状态');
  assert.equal(orderRow(target.id).status, 'NEW');
});
