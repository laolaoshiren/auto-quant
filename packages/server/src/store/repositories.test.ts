import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, getDb, initDb } from '../db/index.js';
import {
  aiModels,
  exchanges,
  orders,
  positions,
  strategies,
  tradeEvents,
  traders,
  trades,
} from './repositories.js';

let workDir: string;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-repos-'));
  initDb(path.join(workDir, 'repos.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.run('DELETE FROM trade_events');
  db.run('DELETE FROM trades');
  db.run('DELETE FROM orders');
  db.run('DELETE FROM positions');
  db.run('DELETE FROM traders');
  db.run('DELETE FROM strategies');
  db.run('DELETE FROM ai_models');
  db.run('DELETE FROM exchange_accounts');
});

function seedAccount(label = 'acc'): number {
  return exchanges.create({
    exchange: 'binance',
    label,
    apiKey: `k-${label}`,
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  }).id;
}

function seedTrader(accountId: number, name: string): number {
  const model = aiModels.create({
    provider: 'deepseek',
    label: `m-${name}`,
    model: 'm',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const strategy = strategies.create({
    name: `s-${name}`,
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  return traders.create({
    name,
    exchangeAccountId: accountId,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;
}

test('★ applyExchangeFigures 不覆写已有非空 entry_order_id / exit_order_id，仅回填空值', () => {
  /*
   * 防回归：COALESCE(?, exit_order_id) 会把 manual_partial 的 exit_order_id 覆写成尾仓单号，
   * 导致后续尾仓记账被判重复并永久丢失。改为 COALESCE(NULLIF(exit_order_id, ''), ?) 后只补空值。
   */
  const acc = seedAccount();
  const tid = seedTrader(acc, 't1');

  const { id } = trades.insert({
    traderId: tid,
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 1,
    entryPrice: 100,
    exitPrice: 110,
    leverage: 5,
    grossPnl: 10,
    entryFee: 0.05,
    exitFee: 0.05,
    closeReason: 'manual_partial',
    openedAt: '2026-10-01T00:00:00.000Z',
    closedAt: '2026-10-01T01:00:00.000Z',
    source: 'bot',
    entryOrderId: null,
    exitOrderId: 'PARTIAL-EXIT-1',
  });

  trades.applyExchangeFigures({
    id,
    grossPnl: 10,
    entryFee: 0.05,
    exitFee: 0.05,
    fundingFee: 0,
    entryPrice: 100,
    exitPrice: 110,
    quantity: 1,
    leverage: 5,
    entryOrderId: 'ENTRY-1',
    exitOrderId: 'TAIL-EXIT-2',
  });

  const row = getDb().get<{ entry_order_id: string | null; exit_order_id: string | null }>(
    'SELECT entry_order_id, exit_order_id FROM trades WHERE id = ?',
    id,
  )!;
  assert.equal(row.entry_order_id, 'ENTRY-1', '原为 NULL 的 entry_order_id 应被回填');
  assert.equal(row.exit_order_id, 'PARTIAL-EXIT-1', '已有非空 exit_order_id 绝不可被尾仓单号覆盖');
});

test('★ trades.list() 使用标量子查询，同 exchange_order_id 多条 orders 不放大结果行', () => {
  /*
   * 防回归：原 LEFT JOIN orders 在同 (trader_id, exchange_order_id) 有多条订单行时，
   * 会把单条 trades 笛卡尔积放大成多条重复记录。
   */
  const acc = seedAccount();
  const tid = seedTrader(acc, 't-list');

  orders.insert({
    traderId: tid,
    exchangeOrderId: 'DUP-E1',
    clientOrderId: 'c1',
    symbol: 'ETHUSDT',
    side: 'BUY',
    type: 'MARKET',
    purpose: 'entry',
    quantity: 1,
    price: null,
    stopPrice: null,
    status: 'FILLED',
    marginType: 'isolated',
  });
  orders.insert({
    traderId: tid,
    exchangeOrderId: 'DUP-E1',
    clientOrderId: 'c2',
    symbol: 'ETHUSDT',
    side: 'BUY',
    type: 'MARKET',
    purpose: 'entry',
    quantity: 1,
    price: null,
    stopPrice: null,
    status: 'FILLED',
    marginType: 'cross',
  });

  trades.insert({
    traderId: tid,
    symbol: 'ETHUSDT',
    side: 'long',
    quantity: 1,
    entryPrice: 2000,
    exitPrice: 2100,
    leverage: 5,
    grossPnl: 100,
    entryFee: 1,
    exitFee: 1,
    closeReason: 'model_decision',
    openedAt: '2026-10-01T00:00:00.000Z',
    closedAt: '2026-10-01T01:00:00.000Z',
    entryOrderId: 'DUP-E1',
    exitOrderId: 'X1',
  });

  const rows = trades.list(tid, 50);
  assert.equal(rows.length, 1, '重复的 orders 行不得放大 trades.list() 行数');
  assert.equal(rows[0]!.marginType, 'cross', '应取最新一条订单的 margin_type');
});

test('★ orders.exchangeOrderIds 不传 limit 时返回全量（超过 2000 条不截断）', () => {
  /*
   * 防回归：深度对账若受 2000 条上限截断，老单号会被误判为 otherTrader / foreign。
   */
  const acc = seedAccount();
  const tid = seedTrader(acc, 't-2050');
  const db = getDb();
  db.transaction(() => {
    for (let i = 1; i <= 2050; i += 1) {
      orders.insert({
        traderId: tid,
        exchangeOrderId: `ORD-${i}`,
        clientOrderId: `c-${i}`,
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'MARKET',
        purpose: 'entry',
        quantity: 0.01,
        price: null,
        stopPrice: null,
        status: 'FILLED',
      });
    }
  });

  const all = orders.exchangeOrderIds(tid);
  assert.equal(all.size, 2050);
  assert.ok(all.has('ORD-1'), '最早的第 1 条单号也不得被截断');
  assert.equal(orders.exchangeOrderIds(tid, 10).size, 10, '显式传 limit 时仍按 limit 截断');
});

test('★ positions.promote 按单行 pendingId 精确转正，多条 pending 不撞唯一索引', () => {
  /*
   * 防回归：若异常出现同标的 2 条 pending 行，按 WHERE trader_id=? AND symbol=? 批量 UPDATE
   * 会同时将 2 行改成 open，撞上 idx_positions_open_symbol 唯一约束报错。
   */
  const acc = seedAccount();
  const tid = seedTrader(acc, 't-promote');
  const p1 = positions.insert({
    traderId: tid,
    symbol: 'SOLUSDT',
    side: 'long',
    quantity: 1,
    entryPrice: 100,
    leverage: 5,
    liquidationPrice: null,
    marginUsed: 20,
    stopLoss: 95,
    takeProfit: 115,
    stopOrderId: null,
    tpOrderId: null,
    openReasoning: 'p1',
    status: 'pending',
    entryOrderId: 'L1',
  });
  positions.insert({
    traderId: tid,
    symbol: 'SOLUSDT',
    side: 'long',
    quantity: 1,
    entryPrice: 99,
    leverage: 5,
    liquidationPrice: null,
    marginUsed: 20,
    stopLoss: 94,
    takeProfit: 114,
    stopOrderId: null,
    tpOrderId: null,
    openReasoning: 'p2',
    status: 'pending',
    entryOrderId: 'L2',
  });

  const res = positions.promote(tid, 'SOLUSDT', { quantity: 1, entryPrice: 100, marginUsed: 20 }, p1);
  assert.equal(res.mergedIntoExisting, false);
  assert.equal(positions.open(tid).length, 1);
  assert.equal(positions.open(tid)[0]!.id, p1, '只精确转正指定的 pending 行');
  assert.equal(positions.pending(tid).length, 1, '另一条 pending 行未被误改');
});

test('★ positions.openSymbolsForOtherTradersOnAccount 只返回同账户他机持仓', () => {
  const acc1 = seedAccount('acc-1');
  const acc2 = seedAccount('acc-2');
  const t1 = seedTrader(acc1, 'bot-1');
  const t2 = seedTrader(acc1, 'bot-2');
  const t3 = seedTrader(acc2, 'bot-3');

  const base = {
    side: 'long' as const,
    quantity: 1,
    entryPrice: 100,
    leverage: 5,
    liquidationPrice: null,
    marginUsed: 20,
    stopLoss: 95,
    takeProfit: 115,
    stopOrderId: null,
    tpOrderId: null,
    openReasoning: 'test',
  };
  positions.insert({ ...base, traderId: t1, symbol: 'BTCUSDT' });
  positions.insert({ ...base, traderId: t2, symbol: 'ETHUSDT' });
  positions.insert({ ...base, traderId: t3, symbol: 'SOLUSDT' });

  const othersForT1 = positions.openSymbolsForOtherTradersOnAccount(acc1, t1);
  assert.deepEqual([...othersForT1], ['ETHUSDT'], '只应看到同账户下他机的 ETHUSDT，不含自己的 BTCUSDT 与异账户的 SOLUSDT');
});

test('★ tradeEvents.record() 按写入计数周期性触发裁剪（解决 countSince >= 200 永不触发）', () => {
  const acc = seedAccount();
  const tid = seedTrader(acc, 't-events');
  const db = getDb();

  // 插入 1 条 30 天前的过期事件
  db.run(
    'INSERT INTO trade_events (trader_id, symbol, kind, created_at) VALUES (?, ?, ?, ?)',
    tid,
    'OLDUSDT',
    'exit',
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  );
  assert.ok(tradeEvents.lastFor(tid, 'OLDUSDT', 'exit'), '前提：过期行存在');

  // 写入 200 条新事件，触发 record() 内的周期性裁剪
  for (let i = 0; i < 200; i += 1) {
    tradeEvents.record(tid, 'BTCUSDT', 'entry');
  }
  assert.equal(
    tradeEvents.lastFor(tid, 'OLDUSDT', 'exit'),
    undefined,
    '写入满一个周期后，7 天前的过期行必须被自动裁掉',
  );
});

test('★ openEntryCostsForAccount 按账户汇总多机器人持仓及加仓订单手续费', () => {
  const acc = seedAccount();
  const t1 = seedTrader(acc, 'cost-1');
  const t2 = seedTrader(acc, 'cost-2');
  const openedAt = '2026-10-01T00:00:00.000Z';

  // t1 开仓（E1）+ 后续加仓（E1-ADD）
  orders.insert({
    traderId: t1,
    exchangeOrderId: 'E1',
    clientOrderId: 'c1',
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'MARKET',
    purpose: 'entry',
    quantity: 1,
    price: null,
    stopPrice: null,
    status: 'FILLED',
    fee: 0.12,
  });
  positions.insert({
    traderId: t1,
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 1,
    entryPrice: 100,
    leverage: 5,
    liquidationPrice: null,
    marginUsed: 20,
    stopLoss: 95,
    takeProfit: 115,
    stopOrderId: null,
    tpOrderId: null,
    openReasoning: 'open',
    entryOrderId: 'E1',
  });
  // 将 positions.opened_at 设为稍早时间，以便后续加仓单 created_at >= opened_at
  getDb().run('UPDATE positions SET opened_at = ? WHERE trader_id = ?', openedAt, t1);
  orders.insert({
    traderId: t1,
    exchangeOrderId: 'E1-ADD',
    clientOrderId: 'c1-add',
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'MARKET',
    purpose: 'entry',
    quantity: 1,
    price: null,
    stopPrice: null,
    status: 'FILLED',
    fee: 0.08,
  });

  // t2 同账户开仓（E2）
  orders.insert({
    traderId: t2,
    exchangeOrderId: 'E2',
    clientOrderId: 'c2',
    symbol: 'ETHUSDT',
    side: 'BUY',
    type: 'MARKET',
    purpose: 'entry',
    quantity: 1,
    price: null,
    stopPrice: null,
    status: 'FILLED',
    fee: 0.05,
  });
  positions.insert({
    traderId: t2,
    symbol: 'ETHUSDT',
    side: 'long',
    quantity: 1,
    entryPrice: 2000,
    leverage: 5,
    liquidationPrice: null,
    marginUsed: 400,
    stopLoss: 1900,
    takeProfit: 2300,
    stopOrderId: null,
    tpOrderId: null,
    openReasoning: 'open',
    entryOrderId: 'E2',
  });

  const openPos = positions.openForAccount(acc);
  assert.equal(openPos.length, 2);
  const totalFee = orders.openEntryCostsForAccount(openPos);
  assert.ok(Math.abs(totalFee - 0.25) < 1e-9, `应汇总两台机器人开仓+加仓手续费 0.25，实得 ${totalFee}`);
});

test('★ trades.legSplitRows 能召回部分减仓同批尾仓（opened_at 因延迟入账偏移且尾仓单号缺失）', () => {
  /*
   * 复现线上实测故障：限价单延迟晋升导致本地 opened_at 比交易所开仓晚十余分钟；
   * 先 manual_partial 减半（记录了 exit_order_id），后 drawdown_guard 平尾仓（未记 orderId）。
   * 对账时 legSplitRows 必须把两笔都召回，绝不可因漏召尾仓而重复补录 reconciled 记录。
   */
  const acc = seedAccount();
  const tid = seedTrader(acc, 't-legsplit');

  const partial = trades.insert({
    traderId: tid,
    symbol: 'WLDUSDT',
    side: 'short',
    quantity: 1150,
    entryPrice: 0.239,
    exitPrice: 0.242,
    leverage: 10,
    grossPnl: -3.45,
    entryFee: 0,
    exitFee: 0.13915,
    closeReason: 'manual_partial',
    openedAt: '2026-11-24T00:11:40.314Z',
    closedAt: '2026-11-24T02:14:12.000Z',
    source: 'bot',
    entryOrderId: null,
    exitOrderId: 'E_PARTIAL',
  });

  const tail = trades.insert({
    traderId: tid,
    symbol: 'WLDUSDT',
    side: 'short',
    quantity: 1151,
    entryPrice: 0.239,
    exitPrice: 0.238,
    leverage: 10,
    grossPnl: 1.151,
    entryFee: 0,
    exitFee: 0.137,
    closeReason: 'drawdown_guard',
    openedAt: '2026-11-24T00:11:40.314Z',
    closedAt: '2026-11-24T02:54:36.550Z',
    source: 'bot',
    entryOrderId: null,
    exitOrderId: null,
  });

  // 同标的另一笔无关历史单（不同 opened_at 且不同单号），不可被误拉入
  trades.insert({
    traderId: tid,
    symbol: 'WLDUSDT',
    side: 'short',
    quantity: 500,
    entryPrice: 0.25,
    exitPrice: 0.24,
    leverage: 10,
    grossPnl: 5,
    entryFee: 0,
    exitFee: 0.06,
    closeReason: 'take_profit',
    openedAt: '2026-11-23T18:00:00.000Z',
    closedAt: '2026-11-23T19:00:00.000Z',
    source: 'bot',
    entryOrderId: 'E_OLD_ENTRY',
    exitOrderId: 'E_OLD_EXIT',
  });

  const rows = trades.legSplitRows({
    traderId: tid,
    symbol: 'WLDUSDT',
    entryOrderId: 'E_ENTRY',
    exitOrderIds: ['E_PARTIAL', 'E_EXIT'],
    openedAt: '2026-11-23T23:57:05.696Z',
    closedAt: '2026-11-24T02:54:36.408Z',
  });

  assert.equal(rows.length, 2, '应召回 manual_partial + 同批尾仓共 2 条记录');
  const ids = rows.map((r) => r.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [partial.id, tail.id].sort((a, b) => a - b));
});

test('★ orders.cancelOpenProtectionBySymbol 仅取消指定保护单的 NEW 行，不影响其他委托', () => {
  const acc = seedAccount();
  const tid = seedTrader(acc, 't-cancel-prot');

  const sl = orders.insert({
    traderId: tid,
    exchangeOrderId: 'PAPER-SL-1',
    clientOrderId: 'c-sl-1',
    symbol: 'XRPUSDT',
    side: 'BUY',
    type: 'STOP_MARKET',
    purpose: 'stop_loss',
    quantity: 100,
    price: null,
    stopPrice: 1.5,
    status: 'NEW',
    fee: 0,
  });
  const tp = orders.insert({
    traderId: tid,
    exchangeOrderId: 'PAPER-TP-1',
    clientOrderId: 'c-tp-1',
    symbol: 'XRPUSDT',
    side: 'BUY',
    type: 'TAKE_PROFIT_MARKET',
    purpose: 'take_profit',
    quantity: 100,
    price: null,
    stopPrice: 1.2,
    status: 'NEW',
    fee: 0,
  });
  const entry = orders.insert({
    traderId: tid,
    exchangeOrderId: 'PAPER-ENTRY-1',
    clientOrderId: 'c-entry-1',
    symbol: 'XRPUSDT',
    side: 'SELL',
    type: 'MARKET',
    purpose: 'entry',
    quantity: 100,
    price: 1.4,
    stopPrice: null,
    status: 'FILLED',
    fee: 0.05,
  });

  const changed = orders.cancelOpenProtectionBySymbol(tid, 'XRPUSDT', { stop: true, target: false });
  assert.equal(changed, 1);

  const statuses = new Map(
    getDb()
      .all<{ id: number; status: string }>('SELECT id, status FROM orders WHERE trader_id = ?', tid)
      .map((r) => [r.id, r.status]),
  );
  assert.equal(statuses.get(sl), 'CANCELED');
  assert.equal(statuses.get(tp), 'NEW');
  assert.equal(statuses.get(entry), 'FILLED');
});
