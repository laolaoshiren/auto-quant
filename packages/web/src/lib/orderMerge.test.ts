/**
 * 审计 P1 #21：WS 订单事件与 REST 轮询订单合并的去重与单调性测试。
 *
 * 1. `upsertLiveOrder` / `useEvents.ingest` 必须按 `id` 和 `exchangeOrderId` 去重，
 *    不能在 `live.orders` 里留下同一张单的旧 `NEW` 副本；
 * 2. `mergeOrderRows`（`TraderTables` 使用）在合并 `loaded`、`live`、`polledPage` 时，
 *    绝不允许陈旧 REST 轮询把已终态（`FILLED` / `CANCELED` / `EXPIRED` / `REJECTED` 等）
 *    订单倒退回 `NEW` 或 `PARTIALLY_FILLED`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrderRecord } from '@aq/shared';

import {
  isOpenOrder,
  mergeOrderRows,
  pickNewerOrder,
  upsertLiveOrder,
} from './orderMerge';
import { useEvents } from './store';

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 101,
    traderId: 7,
    exchangeOrderId: 'EX-101',
    clientOrderId: 'cli-101',
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    purpose: 'entry',
    quantity: 0.1,
    price: 85000,
    stopPrice: null,
    status: 'NEW',
    avgPrice: null,
    filledQty: 0,
    fee: 0,
    error: null,
    createdAt: '2026-11-25T07:00:00.000Z',
    updatedAt: '2026-11-25T07:00:00.000Z',
    ...overrides,
  };
}

test('★★★ upsertLiveOrder 按 id 与 exchangeOrderId 去重，且终态绝不倒退回 NEW', () => {
  const created = makeOrder({ id: 101, exchangeOrderId: 'EX-101', status: 'NEW', updatedAt: '2026-11-25T07:00:00.000Z' });
  const filled = makeOrder({
    id: 101,
    exchangeOrderId: 'EX-101',
    status: 'FILLED',
    avgPrice: 85100,
    filledQty: 0.1,
    updatedAt: '2026-11-25T07:00:05.000Z',
  });

  let list = upsertLiveOrder([], created, 50);
  list = upsertLiveOrder(list, filled, 50);

  assert.equal(list.length, 1, '★★★ 同一 id 的 NEW 与 FILLED 必须去重为一条');
  assert.equal(list[0]!.status, 'FILLED');
  assert.equal(isOpenOrder(list[0]!), false);

  /* 乱序延迟到达的旧 NEW 事件（甚至同 exchangeOrderId 不同临时 id）绝不能把 FILLED 倒退回 NEW。 */
  const staleById = makeOrder({ id: 101, exchangeOrderId: 'EX-101', status: 'NEW', updatedAt: '2026-11-25T07:00:01.000Z' });
  const staleByExId = makeOrder({ id: 999, exchangeOrderId: 'EX-101', status: 'NEW', updatedAt: '2026-11-25T07:00:02.000Z' });
  list = upsertLiveOrder(list, staleById, 50);
  list = upsertLiveOrder(list, staleByExId, 50);

  assert.equal(list.length, 1, '★★★ 相同 exchangeOrderId 也必须去重为一条');
  assert.equal(list[0]!.status, 'FILLED', '★★★ 终态 FILLED 绝不能被迟到的 NEW 覆盖');
});

test('★★★ mergeOrderRows 绝不允许陈旧 REST 轮询把终态订单倒退回 NEW 或 PARTIALLY_FILLED', () => {
  const terminalStatuses = [
    'FILLED',
    'CANCELED',
    'CANCELLED',
    'EXPIRED',
    'REJECTED',
    'FINISHED',
    'EXPIRED_IN_MATCH',
    'EXPIRED_IN_FUTURES',
  ];

  for (const terminal of terminalStatuses) {
    const wsTerminal = makeOrder({
      id: 200,
      exchangeOrderId: 'EX-200',
      status: terminal,
      updatedAt: '2026-11-25T07:01:00.000Z',
    });
    const staleRestNew = makeOrder({
      id: 200,
      exchangeOrderId: 'EX-200',
      status: 'NEW',
      updatedAt: '2026-11-25T07:00:55.000Z',
    });
    const staleRestPartial = makeOrder({
      id: 200,
      exchangeOrderId: 'EX-200',
      status: 'PARTIALLY_FILLED',
      filledQty: 0.05,
      updatedAt: '2026-11-25T07:00:58.000Z',
    });

    const mergedFromNew = mergeOrderRows([staleRestNew], [wsTerminal], [staleRestNew], 7);
    assert.equal(mergedFromNew.length, 1);
    assert.equal(
      mergedFromNew[0]!.status,
      terminal,
      `★★★ 陈旧 REST(NEW) 绝不能把 WS 终态 ${terminal} 倒退回 NEW`,
    );

    const mergedFromPartial = mergeOrderRows([], [wsTerminal], [staleRestPartial], 7);
    assert.equal(mergedFromPartial.length, 1);
    assert.equal(
      mergedFromPartial[0]!.status,
      terminal,
      `★★★ 陈旧 REST(PARTIALLY_FILLED) 绝不能把 WS 终态 ${terminal} 倒退`,
    );
  }
});

test('★★ mergeOrderRows 正常向前推进状态（NEW → PARTIALLY_FILLED → FILLED）并吸收同终态较新对账字段', () => {
  const loadedNew = makeOrder({ id: 300, exchangeOrderId: 'EX-300', status: 'NEW', updatedAt: '2026-11-25T07:00:00.000Z' });
  const wsPartial = makeOrder({
    id: 300,
    exchangeOrderId: 'EX-300',
    status: 'PARTIALLY_FILLED',
    filledQty: 0.04,
    updatedAt: '2026-11-25T07:00:10.000Z',
  });
  const restFilled = makeOrder({
    id: 300,
    exchangeOrderId: 'EX-300',
    status: 'FILLED',
    filledQty: 0.1,
    avgPrice: 85200,
    fee: 1.7,
    updatedAt: '2026-11-25T07:00:20.000Z',
  });

  const step1 = mergeOrderRows([loadedNew], [wsPartial], [loadedNew], 7);
  assert.equal(step1.length, 1);
  assert.equal(step1[0]!.status, 'PARTIALLY_FILLED');

  const step2 = mergeOrderRows([loadedNew], [wsPartial], [restFilled], 7);
  assert.equal(step2.length, 1);
  assert.equal(step2[0]!.status, 'FILLED');
  assert.equal(step2[0]!.fee, 1.7);

  /* 同为 FILLED 时，更晚更新的对账数据胜出；更早的陈旧 FILLED 不覆盖较新 FILLED。 */
  const reconciled = makeOrder({
    ...restFilled,
    fee: 1.85,
    updatedAt: '2026-11-25T07:00:30.000Z',
  });
  assert.equal(pickNewerOrder(restFilled, reconciled).fee, 1.85);
  assert.equal(pickNewerOrder(reconciled, restFilled).fee, 1.85);
});

test('★★ useEvents.ingest 处理重复 WS order 事件时在 store 中去重且保持终态', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    value: { setTimeout: () => 0, clearTimeout: () => {} },
    configurable: true,
    writable: true,
  });
  useEvents.setState({ byTrader: {}, status: 'open', attempts: 0, logs: [], toasts: [] });

  try {
    const orderNew = makeOrder({ id: 401, traderId: 9, exchangeOrderId: 'EX-401', status: 'NEW' });
    const orderCanceled = makeOrder({
      id: 401,
      traderId: 9,
      exchangeOrderId: 'EX-401',
      status: 'CANCELED',
      updatedAt: '2026-11-25T07:05:00.000Z',
    });

    useEvents.getState().ingest({ type: 'order', traderId: 9, order: orderNew } as never);
    useEvents.getState().ingest({ type: 'order', traderId: 9, order: orderCanceled } as never);
    useEvents.getState().ingest({ type: 'order', traderId: 9, order: orderNew } as never);

    const stored = useEvents.getState().byTrader[9]?.orders ?? [];
    assert.equal(stored.length, 1, '★★ store 中同一笔订单只能保留一条记录');
    assert.equal(stored[0]!.status, 'CANCELED', '★★ store 中终态 CANCELED 绝不被旧 NEW 覆盖');
  } finally {
    useEvents.setState({ byTrader: {}, status: 'idle', attempts: 0, logs: [], toasts: [] });
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
        writable: true,
      });
    }
  }
});
