/**
 * Populate the console with one realistic, fully-recorded decision cycle.
 *
 * Why this exists: the decision-audit screen is the centrepiece of the product,
 * but it needs data to be meaningful — and producing that data normally requires
 * a funded exchange account plus a working LLM key. This script runs the **real**
 * pipeline (live Binance market data, real indicator maths, the real prompt
 * builders, the real parser, the real risk engine) against a **simulated**
 * exchange and a **scripted** model, then writes the result into the real
 * database.
 *
 * Everything it creates is prefixed `[DEMO]` so it is trivially identifiable and
 * removable.
 *
 *   npx tsx packages/server/src/scripts/demoCycle.ts          # create the demo data
 *   npx tsx packages/server/src/scripts/demoCycle.ts --clean  # remove it again
 *
 * Nothing here touches an exchange. No orders are ever placed.
 */

import {
  STRATEGY_PRESETS,
  defaultStrategyConfig,
  type StrategyConfig,
} from '@aq/shared';
import { connectExchange } from '../binance/bootstrap.js';
import type { BinanceBroker, ExchangePosition, PlacedOrder } from '../binance/broker.js';
import type { BinanceAlgoOrderResponse, BinanceOrderResponse } from '../binance/types.js';
import { Vault } from '../crypto/vault.js';
import { closeDb, getDb, initDb } from '../db/index.js';
import { dbPath, resolveMasterKey } from '../env.js';
import { MarketDataService } from '../market/service.js';
import {
  aiModels,
  exchanges,
  positions as positionStore,
  strategies,
  traders,
} from '../store/repositories.js';
import { AutoTrader, type DecisionModel } from '../trader/autoTrader.js';

const TAG = '[DEMO]';
const TRADER_NAME = `${TAG} 决策审计示例`;
const ROUND_TRIP_NAME = `${TAG} 已平仓回合`;

/* -------------------------------------------------------------------------- */
/*  A scripted model                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Returns a reply in the exact format the prompt demands, including a plausible
 * chain of thought. The point is to exercise the parser and the audit trail, not
 * to be a good trader.
 */
function scriptedResponse(symbol: string, price: number): string {
  const stop = Number((price * 0.975).toPrecision(6));
  const target = Number((price * 1.08).toPrecision(6));
  return `<reasoning>
第一步 —— 高周期。1 小时序列仍站在 EMA20 上方，4 小时结构也保持完好，因此主导趋势依然是上行。

第二步 —— 结构。价格已重新站上前一时段的中点，而最近的 15 分钟波段低点就在当前价位下方，
这给了我一个干净且紧凑的失效位。

第三步 —— 动能。5 分钟与 15 分钟的 MACD 都在信号线之上，RSI 处于 50-65 区间，
说明价格在参与但尚未超买。

第四步 —— 衍生品。持仓量与价格同步扩张，说明是新增持仓而非空头回补，
且资金费率尚未拥挤。

第五步 —— 决策。该形态通过了我的入场标准。我先按结构位确定止损，
再以约为止损距离三倍的位置设定目标，最后把仓位控制在"止损被扫时损失低于权益 1%"。
</reasoning>

<decision>
\`\`\`json
[
  {
    "symbol": "${symbol}",
    "action": "open_long",
    "leverage": 3,
    "position_size_usd": 300,
    "stop_loss": ${stop},
    "take_profit": ${target},
    "confidence": 82,
    "risk_usd": 7.5,
    "reasoning": "价格重新站上关键位后的趋势延续，动能配合且持仓量上升。"
  }
]
\`\`\`
</decision>`;
}

/* -------------------------------------------------------------------------- */
/*  A simulated exchange                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors the behaviour the trader actually depends on: market orders fill at
 * the mark price, conditional orders rest as `NEW`, and `closePosition` stops
 * are recorded but never fire (so the position stays open for the audit view).
 */
class SimulatedBroker {
  private readonly positions: ExchangePosition[] = [];
  private nextId = 900_000;

  constructor(private readonly priceOf: (symbol: string) => number) {}

  async getAccountState() {
    const unrealized = this.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    return {
      equity: 1000 + unrealized,
      walletBalance: 1000,
      availableBalance: 700,
      unrealizedPnl: unrealized,
      marginUsed: 300,
      openOrderMargin: 0,
    };
  }

  async getPositions(symbol?: string) {
    return symbol ? this.positions.filter((p) => p.symbol === symbol) : [...this.positions];
  }

  async setLeverage(_symbol: string, leverage: number) {
    return { ok: true, leverage };
  }

  async ensureOneWayMode() {
    return { changed: false, warning: null };
  }

  async placeOrder(request: Parameters<BinanceBroker['placeOrder']>[0]): Promise<PlacedOrder> {
    const id = String(this.nextId++);
    const conditional = request.type === 'STOP_MARKET' || request.type === 'TAKE_PROFIT_MARKET';
    const price = this.priceOf(request.symbol);

    if (conditional) {
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
        createTime: Date.now(),
        updateTime: Date.now(),
        triggerTime: 0,
      };
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
        terminal: false,
        raw,
      };
    }

    const quantity = request.quantity ?? 0;
    if (request.reduceOnly) {
      const index = this.positions.findIndex((p) => p.symbol === request.symbol);
      if (index >= 0) this.positions.splice(index, 1);
    } else {
      this.positions.push({
        symbol: request.symbol,
        side: request.side === 'BUY' ? 'long' : 'short',
        quantity,
        entryPrice: price,
        markPrice: price,
        leverage: 3,
        liquidationPrice: Number((price * 0.7).toPrecision(6)),
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        marginUsed: (quantity * price) / 3,
        notional: quantity * price,
        marginType: 'cross',
      });
    }

    const raw: BinanceOrderResponse = {
      orderId: Number(id),
      clientOrderId: request.clientOrderId ?? id,
      symbol: request.symbol,
      side: request.side,
      type: request.type as BinanceOrderResponse['type'],
      status: 'FILLED',
      avgPrice: String(price),
      executedQty: String(quantity),
      origQty: String(quantity),
      price: '0',
      cumQty: String(quantity),
      cumQuote: String(quantity * price),
      reduceOnly: request.reduceOnly ?? false,
      positionSide: 'BOTH',
      stopPrice: '0',
      closePosition: false,
      timeInForce: 'GTC',
      origType: request.type as BinanceOrderResponse['origType'],
      updateTime: Date.now(),
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
      status: 'FILLED',
      avgPrice: price,
      executedQty: quantity,
      terminal: true,
      raw,
    };
  }

  async waitForFill(order: PlacedOrder) {
    return order;
  }
  async cancelAllOrders(): Promise<void> {}
  async getUserTrades() {
    return [];
  }
  async getMarkPrice(symbol: string) {
    return this.priceOf(symbol);
  }
  async getOpenAlgoOrders() {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  Cleanup                                                                    */
/* -------------------------------------------------------------------------- */

function clean(): void {
  const db = getDb();
  const ids = db
    .all<{ id: number }>('SELECT id FROM traders WHERE name LIKE ?', `${TAG}%`)
    .map((r) => r.id);

  for (const id of ids) {
    // Children first: the schema cascades, but being explicit keeps this
    // readable and safe if a foreign key is ever relaxed.
    for (const table of ['decision_records', 'equity_snapshots', 'trade_events', 'trades', 'orders', 'positions']) {
      db.run(`DELETE FROM ${table} WHERE trader_id = ?`, id);
    }
    db.run('DELETE FROM traders WHERE id = ?', id);
  }

  db.run('DELETE FROM strategies WHERE name LIKE ?', `${TAG}%`);
  db.run('DELETE FROM ai_models WHERE label LIKE ?', `${TAG}%`);
  db.run('DELETE FROM exchange_accounts WHERE label LIKE ?', `${TAG}%`);

  process.stdout.write(`已删除 ${ids.length} 个演示机器人及其全部记录。\n`);
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const shouldClean = process.argv.includes('--clean');

  initDb(dbPath);
  const vault = new Vault(await resolveMasterKey());

  if (shouldClean) {
    clean();
    closeDb();
    return;
  }

  /* --- Strategy ---------------------------------------------------------- */
  const config: StrategyConfig = {
    ...defaultStrategyConfig(),
    ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>),
    name: `${TAG} 稳健策略`,
  };
  // A wider universe makes the audit view more representative of a real cycle.
  config.coinSource = { ...config.coinSource, coinPoolLimit: 8, minQuoteVolume24h: 100_000_000 };
  config.indicators = {
    ...config.indicators,
    kline: { primaryTimeframe: '5m', selectedTimeframes: ['5m', '15m', '1h'], promptPoints: 30, primaryCount: 60 },
    enableQuantData: true,
  };

  process.stdout.write('正在连接币安获取真实行情（无需任何凭据）...\n');
  const connection = await connectExchange({ environment: 'demo', dryRun: true });
  const marketData = new MarketDataService(connection.market, connection.registry);
  process.stdout.write(`  已加载 ${connection.registry.size} 个合约，权重预算 ${connection.rest.weightLimitPerMinute}/分钟\n`);

  /* --- Demo entities ----------------------------------------------------- */
  const account =
    exchanges.list().find((a) => a.label.startsWith(TAG)) ??
    exchanges.create({
      exchange: 'binance',
      label: `${TAG} 模拟账户`,
      apiKey: 'demo-not-a-real-key',
      apiSecretEnc: vault.encrypt('demo-not-a-real-secret'),
      testnet: true,
      canTrade: false,
    });

  const model =
    aiModels.list().find((m) => m.label.startsWith(TAG)) ??
    aiModels.create({
      provider: 'deepseek',
      label: `${TAG} 脚本化模型`,
      model: 'scripted',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnc: '',
      temperature: 0.2,
      maxTokens: 4096,
      timeoutSeconds: 120,
      maxRetries: 3,
    });

  const strategy =
    strategies.list().find((s) => s.name.startsWith(TAG)) ??
    strategies.create({
      name: `${TAG} 稳健策略`,
      description: '由演示脚本创建，可以安全删除。',
      config,
      presetId: 'conservative',
    });

  // Remove any previous demo trader so re-running is idempotent.
  for (const existing of traders.list().filter((t) => t.name.startsWith(TAG))) {
    traders.remove(existing.id);
  }

  const trader = traders.create({
    name: TRADER_NAME,
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  });

  /* --- Choose a symbol and run one real cycle ---------------------------- */
  const snapshotProbe = await marketData.buildSnapshots(
    config.coinSource.staticCoins.length > 0 ? config.coinSource.staticCoins : ['BTCUSDT'],
    config.indicators,
  );
  const symbol = snapshotProbe[0]?.symbol ?? 'BTCUSDT';
  const price = snapshotProbe[0]?.price ?? 0;

  if (!(price > 0)) {
    throw new Error('无法读取实时价格，请检查到币安的网络连通性。');
  }

  const broker = new SimulatedBroker((s) => (s === symbol ? price : price));
  const scripted: DecisionModel = {
    async complete() {
      return {
        text: scriptedResponse(symbol, price),
        latencyMs: 1830,
        usage: { promptTokens: 6120, completionTokens: 340 },
      };
    },
  };

  const autoTrader = new AutoTrader({
    trader,
    config,
    registry: connection.registry,
    market: connection.market,
    marketData,
    broker: broker as unknown as BinanceBroker,
    model: scripted,
  });

  process.stdout.write(`正在为 ${symbol}（价格 ${price}）执行一轮决策...\n`);
  const summary = await autoTrader.runOnce();
  process.stdout.write(`  ${summary}\n`);

  /* --- Report ------------------------------------------------------------ */
  const open = positionStore.open(trader.id);
  const db = getDb();
  const orderCount = db.count('SELECT COUNT(*) AS n FROM orders WHERE trader_id = ?', trader.id);
  const decisionCount = db.count(
    'SELECT COUNT(*) AS n FROM decision_records WHERE trader_id = ?',
    trader.id,
  );

  process.stdout.write(
    [
      '',
      '='.repeat(72),
      '演示数据已生成。全程未向交易所发送任何请求。',
      '='.repeat(72),
      `  机器人        #${trader.id}  ${trader.name}`,
      `  当前持仓      ${open.length}${open[0] ? `（${open[0].symbol} ${open[0].side === 'long' ? '多头' : '空头'}，止损 ${open[0].stop_loss}，止盈 ${open[0].take_profit}）` : ''}`,
      `  订单记录      ${orderCount} 条`,
      `  决策记录      ${decisionCount} 条`,
      '',
      '打开控制台查看：',
      '  http://127.0.0.1:27137/                    → 列表中可以看到这个演示机器人',
      `  http://127.0.0.1:27137/traders/${trader.id}        → 持仓、订单、统计`,
      `  http://127.0.0.1:27137/traders/${trader.id}        → 「决策」标签页 → 点开任意一行看完整审计`,
      '',
      '审计页会展示模型的思维链、解析后的决策、每一条执行结果，',
      '以及完整的系统提示词与用户提示词。',
      '',
      '清除全部演示数据：',
      '  npx tsx packages/server/src/scripts/demoCycle.ts --clean',
      '='.repeat(72),
      '',
    ].join('\n'),
  );

  closeDb();
}

main().catch((error) => {
  process.stderr.write(`演示数据生成失败：${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
