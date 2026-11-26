import test from 'node:test';
import assert from 'node:assert/strict';

import { initDb } from '../db/index.js';
import {
  aiModels,
  orders as orderStore,
  positions as positionStore,
  traders as traderStore,
} from '../store/repositories.js';
import { settleStaleOrdersForTrader } from './staleOrders.js';

initDb(':memory:');

test('★ 线上回归（#21 PIEVERSEUSDT）：仓位止损平仓后即使距挂单 <2 分钟，ignoreGraceWindow=true 也必须立即结清止损/止盈保护单', async () => {
  const model = aiModels.create({
    label: 'vanished-test-model',
    provider: 'openai',
    model: 'gpt-test',
    apiKeyEnc: '',
    baseUrl: 'https://example.invalid/v1',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 0,
  });
  const trader = traderStore.create({
    name: 'vanished-order-settle-test',
    mode: 'ai_managed',
    dryRun: false,
    exchangeAccountId: null,
    aiModelId: model.id,
    strategyId: null,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
    paperStartingBalance: 100,
  });

  // 刚挂上去不到 10 秒的 SL / TP 保护单，随后仓位已关闭（positions.open 为空）
  const slOrderId = orderStore.insert({
    traderId: trader.id,
    exchangeOrderId: '4000002209134490',
    clientOrderId: 'test-sl-1',
    symbol: 'PIEVERSEUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    purpose: 'stop_loss',
    quantity: 7,
    price: null,
    stopPrice: 4.0204,
    status: 'NEW',
  });
  const tpOrderId = orderStore.insert({
    traderId: trader.id,
    exchangeOrderId: '4000002209130935',
    clientOrderId: 'test-tp-1',
    symbol: 'PIEVERSEUSDT',
    side: 'SELL',
    type: 'TAKE_PROFIT_MARKET',
    purpose: 'take_profit',
    quantity: 7,
    price: null,
    stopPrice: 4.345,
    status: 'NEW',
  });

  assert.equal(positionStore.open(trader.id).length, 0);

  // 默认 2 分钟宽限窗口下不会结清刚挂不久的单（保护正常周期竞态）
  const settledDefault = await settleStaleOrdersForTrader({
    traderId: trader.id,
    traderName: trader.name,
    isDryRun: false,
    onlySymbol: 'PIEVERSEUSDT',
    getOpenOrders: async () => [],
    getOpenAlgoOrders: async () => [],
    finalStatusOf: async () => ({ status: 'CANCELED' }),
    emit: () => undefined,
    logWarn: () => undefined,
  });
  assert.equal(settledDefault, 0, '常规巡检保持 2 分钟宽限窗口');

  // 仓位已确认消失时传 ignoreGraceWindow=true：立即将 SL 结清为 FILLED、TP 结清为 CANCELED
  const settledImmediate = await settleStaleOrdersForTrader({
    traderId: trader.id,
    traderName: trader.name,
    isDryRun: false,
    onlySymbol: 'PIEVERSEUSDT',
    ignoreGraceWindow: true,
    getOpenOrders: async () => [],
    getOpenAlgoOrders: async () => [],
    finalStatusOf: async (row) =>
      row.exchangeOrderId === '4000002209134490'
        ? { status: 'FILLED', filledQty: 7, avgPrice: 4.0159 }
        : { status: 'CANCELED' },
    emit: () => undefined,
    logWarn: () => undefined,
  });

  assert.equal(settledImmediate, 2, '两张保护单必须被立刻结清');
  const all = orderStore.list(trader.id);
  const slAfter = all.find((o) => o.id === slOrderId);
  const tpAfter = all.find((o) => o.id === tpOrderId);
  assert.equal(slAfter?.status, 'FILLED');
  assert.equal(tpAfter?.status, 'CANCELED');
  assert.equal(tpAfter?.cancelSource, 'system_reconcile');
});
