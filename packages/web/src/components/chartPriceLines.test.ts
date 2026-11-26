import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OrderRecord, PositionView } from '@aq/shared';
import { buildSymbolChartPriceLines } from './chartPriceLines';

function makePosition(overrides: Partial<PositionView> = {}): PositionView {
  return {
    id: 1,
    traderId: 21,
    symbol: 'SSVUSDT',
    side: 'long',
    quantity: 10,
    entryPrice: 2.468,
    markPrice: 2.482,
    leverage: 5,
    liquidationPrice: 2.0,
    unrealizedPnl: 0.14,
    unrealizedPnlPercent: 2.8,
    peakPnlPercent: 3.1,
    marginUsed: 4.93,
    notional: 24.68,
    stopLoss: 2.41,
    takeProfit: 2.58,
    openedAt: '2026-11-26T09:30:00.000Z',
    openReasoning: 'breakout',
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 100,
    traderId: 21,
    exchangeOrderId: 'ex-100',
    clientOrderId: 'cli-100',
    symbol: 'SSVUSDT',
    side: 'BUY',
    type: 'LIMIT',
    purpose: 'entry',
    quantity: 10,
    price: 2.45,
    stopPrice: null,
    status: 'NEW',
    avgPrice: null,
    filledQty: 0,
    fee: 0,
    error: null,
    createdAt: '2026-11-26T09:30:00.000Z',
    updatedAt: '2026-11-26T09:30:00.000Z',
    ...overrides,
  };
}

describe('buildSymbolChartPriceLines', () => {
  it('returns empty array when symbol has neither position nor open order', () => {
    const lines = buildSymbolChartPriceLines({
      symbol: 'BTCUSDT',
      positions: [makePosition({ symbol: 'SSVUSDT' })],
      openOrders: [makeOrder({ symbol: 'PIEVERSEUSDT' })],
    });
    assert.deepEqual(lines, []);
  });

  it('builds entry, TP, and SL lines for an active position and deduplicates matching protection orders', () => {
    const lines = buildSymbolChartPriceLines({
      symbol: 'ssvusdt',
      positions: [makePosition({ side: 'long', entryPrice: 2.468, stopLoss: 2.41, takeProfit: 2.58 })],
      openOrders: [
        makeOrder({ id: 1, purpose: 'stop_loss', type: 'STOP_MARKET', side: 'SELL', price: null, stopPrice: 2.41 }),
        makeOrder({ id: 2, purpose: 'take_profit', type: 'TAKE_PROFIT_MARKET', side: 'SELL', price: null, stopPrice: 2.58 }),
      ],
    });

    assert.deepEqual(
      lines.map((l) => ({ kind: l.kind, title: l.title, price: l.price })),
      [
        { kind: 'entry', title: '开多', price: 2.468 },
        { kind: 'take_profit', title: '止盈', price: 2.58 },
        { kind: 'stop_loss', title: '止损', price: 2.41 },
      ],
    );
  });

  it('supports multiple take-profit orders ordered by distance from entry', () => {
    const lines = buildSymbolChartPriceLines({
      symbol: 'SSVUSDT',
      positions: [makePosition({ side: 'long', entryPrice: 2.45, stopLoss: 2.38, takeProfit: 2.55 })],
      openOrders: [
        makeOrder({ id: 1, purpose: 'take_profit', type: 'TAKE_PROFIT_MARKET', side: 'SELL', price: null, stopPrice: 2.7 }),
        makeOrder({ id: 2, purpose: 'take_profit', type: 'TAKE_PROFIT_MARKET', side: 'SELL', price: null, stopPrice: 2.55 }),
      ],
    });

    assert.deepEqual(
      lines.map((l) => ({ kind: l.kind, title: l.title, price: l.price })),
      [
        { kind: 'entry', title: '开多', price: 2.45 },
        { kind: 'take_profit', title: '止盈1', price: 2.55 },
        { kind: 'take_profit', title: '止盈2', price: 2.7 },
        { kind: 'stop_loss', title: '止损', price: 2.38 },
      ],
    );
  });

  it('renders pending limit entry order when no filled position exists yet', () => {
    const lines = buildSymbolChartPriceLines({
      symbol: 'PIEVERSEUSDT',
      positions: [],
      openOrders: [
        makeOrder({
          id: 50,
          symbol: 'PIEVERSEUSDT',
          side: 'SELL',
          purpose: 'entry',
          type: 'LIMIT',
          price: 4.105,
          status: 'NEW',
        }),
      ],
    });

    assert.deepEqual(
      lines.map((l) => ({ kind: l.kind, title: l.title, price: l.price })),
      [{ kind: 'pending_entry', title: '挂单开空', price: 4.105 }],
    );
  });

  it('ignores terminal/canceled/filled orders and zero-quantity positions', () => {
    const lines = buildSymbolChartPriceLines({
      symbol: 'SSVUSDT',
      positions: [makePosition({ quantity: 0 })],
      openOrders: [
        makeOrder({ status: 'CANCELED', price: 2.45 }),
        makeOrder({ status: 'FILLED', price: 2.46 }),
        makeOrder({ status: 'EXPIRED_IN_FUTURES', purpose: 'stop_loss', stopPrice: 2.4 }),
      ],
    });

    assert.deepEqual(lines, []);
  });
});
