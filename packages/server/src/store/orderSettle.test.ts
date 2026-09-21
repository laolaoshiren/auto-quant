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
  orders as orderStore,
  strategies,
  traders,
  TERMINAL_ORDER_STATUSES,
} from './repositories.js';

/**
 * `orders.unsettled()` 的筛选契约。
 *
 * ## 为什么这个文件存在
 *
 * `orders.status` 从来没有人更新过（本次修复之前 `orders.update()` 一个调用点都没有），
 * 于是"交易所已经不挂了、本地还停在非终态"的行只会越积越多 —— 实盘上量到的是
 * `NEW: 24 / FILLED: 19`，而交易所的挂单列表是 **0**。结清它们的第一步，就是**准确地**
 * 把候选集选出来；选错方向的两个后果都是真问题：
 *
 *  - **漏选**（把还挂着的当成终态，或把候选行过滤掉了）→ 脏行永远留在「当前委托」里，
 *    操作员继续看到不存在的委托；
 *  - **多选**（把刚下的单也选出来）→ 下一层会去问交易所"它还在吗"，而刚下的单可能还没
 *    出现在那一读里。所以宽限窗口（`createdBefore`）必须在 SQL 这一层就生效。
 *
 * 四条断言对应这四件事：终态不被选出、Algo 的状态词表（`FINISHED`）也算终态、
 * 宽限窗口生效、只作用于本机器人。
 *
 * 按 AGENTS.md §3.6：临时目录，绝不碰 `data/`。
 */

let workDir: string;
let traderId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-order-settle-'));
  initDb(path.join(workDir, 'order-settle.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().run('DELETE FROM orders');
});

function seedTrader(name = 'order-settle'): number {
  const account = exchanges.create({
    exchange: 'binance',
    label: name,
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: name,
    model: 'm',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const strategy = strategies.create({
    name,
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  return traders.create({
    name,
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;
}

/** 写一张订单，`status` 是要被测的那个变量。 */
function seedOrder(input: {
  forTrader?: number;
  index: number;
  status: string;
  symbol?: string;
  /** `created_at` 相对现在的偏移（毫秒，负数=更早）。 */
  ageMs?: number;
  /** 默认 `stop_loss`（本文件多数用例关心的那种）；测入场费时传 `entry`。 */
  purpose?: string;
  fee?: number;
}): number {
  const id = orderStore.insert({
    traderId: input.forTrader ?? traderId,
    exchangeOrderId: `EX-${input.index}`,
    clientOrderId: `CL-${input.index}`,
    symbol: input.symbol ?? 'BTCUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    purpose: (input.purpose ?? 'stop_loss') as never,
    quantity: 1,
    price: null,
    stopPrice: 66_000,
    status: input.status,
    fee: input.fee ?? 0,
  });
  if (input.ageMs !== undefined) {
    getDb().run(
      'UPDATE orders SET created_at = ? WHERE id = ?',
      new Date(Date.now() + input.ageMs).toISOString(),
      id,
    );
  }
  return id;
}

const HOUR = 60 * 60 * 1000;

test('未结清的候选集：终态一个都不选，非终态且够老的全选', () => {
  /*
   * 实盘上那 24 行 `NEW` 的形状：条件单挂上去之后再也没有人更新过它。
   * 另一端是已经终态的行 —— 它们**不能**被选出来，否则每次对账都要为它们重新问一遍交易所。
   */
  traderId = seedTrader();
  const cutoff = new Date(Date.now() - HOUR).toISOString();

  const staleNew = seedOrder({ index: 1, status: 'NEW', ageMs: -2 * HOUR });
  const stalePartial = seedOrder({ index: 2, status: 'PARTIALLY_FILLED', ageMs: -2 * HOUR });
  const fresh = seedOrder({ index: 3, status: 'NEW', ageMs: -60_000 });
  const filled = seedOrder({ index: 4, status: 'FILLED', ageMs: -2 * HOUR });
  const canceled = seedOrder({ index: 5, status: 'CANCELED', ageMs: -2 * HOUR });
  const rejected = seedOrder({ index: 6, status: 'REJECTED', ageMs: -2 * HOUR });

  const ids = orderStore.unsettled(traderId, cutoff).map((row) => row.id);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    [staleNew, stalePartial].sort((a, b) => a - b),
    '只有"非终态 + 够老"的行才是候选',
  );
  for (const terminal of [fresh, filled, canceled, rejected]) {
    assert.ok(!ids.includes(terminal), `#${terminal} 不该出现在候选集里`);
  }
});

test('Algo 条件单自己的状态词表也算终态：FINISHED 不是"还挂着"', () => {
  /*
   * `orders.status` 里两套词表都会出现：普通订单（`FILLED` / `CANCELED` / …）与
   * Algo 条件单（`FINISHED` / `TRIGGERED` / …）。它们只有 `NEW` 一个词重合，
   * 所以漏掉 `FINISHED` 就会让一张**已经触发成交的止损**永远留在候选集里 ——
   * 结清逻辑每次都要为它再问一次交易所，而控制台那边它也一直被当成"挂单中"。
   */
  traderId = seedTrader();
  const cutoff = new Date(Date.now() - HOUR).toISOString();

  const finished = seedOrder({ index: 1, status: 'FINISHED', ageMs: -2 * HOUR });
  const triggered = seedOrder({ index: 2, status: 'TRIGGERED', ageMs: -2 * HOUR });
  const expired = seedOrder({ index: 3, status: 'EXPIRED', ageMs: -2 * HOUR });

  assert.ok(TERMINAL_ORDER_STATUSES.includes('FINISHED'), 'FINISHED 必须算终态');
  const ids = orderStore.unsettled(traderId, cutoff).map((row) => row.id);
  assert.ok(!ids.includes(finished), '条件单已成交 = 终态');
  assert.ok(!ids.includes(expired), '过期 = 终态');
  /*
   * `TRIGGERED` 相反：条件单触发了，但它产生的那张市价单还要成交。
   * 把它当终态会让"触发之后、成交之前"的那一小段窗口里的行彻底失联。
   */
  assert.ok(ids.includes(triggered), 'TRIGGERED 还不是终态：它产生的单还要成交');
});

test('宽限窗口：比 createdBefore 更新的行一律不选（刚下的单不能被这一读判死）', () => {
  traderId = seedTrader();
  const cutoff = new Date(Date.now() - HOUR).toISOString();
  const old = seedOrder({ index: 1, status: 'NEW', ageMs: -3 * HOUR });
  const atCutoff = seedOrder({ index: 2, status: 'NEW', ageMs: -2 * HOUR });
  const fresh = seedOrder({ index: 3, status: 'NEW', ageMs: -30_000 });

  const ids = orderStore.unsettled(traderId, cutoff).map((row) => row.id);
  assert.ok(ids.includes(old));
  assert.ok(ids.includes(atCutoff), '边界上（正好等于 cutoff）的行算够老');
  assert.ok(!ids.includes(fresh), '刚下的单必须被排除在候选集之外');
});

test('候选集只作用于本机器人', () => {
  // 多个机器人共用一个库：把别人的行捞出来会让这台机器人去结清别的机器人的委托。
  traderId = seedTrader('mine');
  const other = seedTrader('other');
  const cutoff = new Date(Date.now() - HOUR).toISOString();

  const mine = seedOrder({ index: 1, status: 'NEW', ageMs: -2 * HOUR });
  seedOrder({ forTrader: other, index: 2, status: 'NEW', ageMs: -2 * HOUR });

  const ids = orderStore.unsettled(traderId, cutoff).map((row) => row.id);
  assert.deepEqual(ids, [mine]);
});

/* -------------------------------------------------------------------------- */
/*  未平仓的入场成本                                                            */
/* -------------------------------------------------------------------------- */

test('★ 未平仓的入场成本：只算「入场 + 已成交 + 该标的仍持仓」', () => {
  /*
   * ## 为什么总账校验需要它
   *
   * 交易所流水从**开仓那一刻**就有 `COMMISSION`，而平台的 `trades` 只在**平仓时**
   * 记一笔。于是只要有持仓，「平台净额」天然比「交易所流水」少一个"未平仓的持有成本"。
   *
   * 实测：两条告警的差额 `0.0119` / `0.0202` 正好是当时那两个仓位的入场手续费
   * （ETH `0.0118539` + HYPE `0.00837404` = `0.0202`）—— **一个纯粹的口径差被报成了
   * 「平台的账本可能有漏记或重复记账」**，而且每轮都报一次（上百条）。
   *
   * 所以这个汇总的口径必须精确，四条边界各钉一条：
   */
  traderId = seedTrader();

  /* ① 要算的：入场 + 已成交 + 该标的仍持仓 */
  seedOrder({ index: 1, status: 'FILLED', purpose: 'entry', symbol: 'ETHUSDT', fee: 0.0118539 });
  /* ② 不算：那是保护单，不是入场费 */
  seedOrder({ index: 2, status: 'FILLED', purpose: 'stop_loss', symbol: 'ETHUSDT', fee: 9 });
  /* ③ 不算：它是另一个标的的入场费，而那个标的已经不在持仓列表里 */
  seedOrder({ index: 3, status: 'FILLED', purpose: 'entry', symbol: 'BNBUSDT', fee: 7 });
  /* ④ 不算：还没成交的单没有手续费 */
  seedOrder({ index: 4, status: 'NEW', purpose: 'entry', symbol: 'ETHUSDT', fee: 5 });

  const total = orderStore.openEntryCosts(traderId, ['ETHUSDT']);
  assert.ok(
    Math.abs(total - 0.0118539) < 1e-9,
    `只应汇总 ETHUSDT 那一笔入场费，实际 ${total}` +
      '（把保护单、别的标的、或未成交的单算进来都会让总账校验反向误报）',
  );
});

test('没有持仓时未平仓成本是 0，不是「全部入场费」', () => {
  /*
   * 空标的列表必须短路返回 0。若不短路，SQL 里的 `IN ()` 会变成语法错误，
   * 而更糟的一种实现是"忘了过滤" —— 那样已平仓的入场费也会被加进平台侧，
   * 于是一个**已经对上的账**会被推成负差额。
   */
  traderId = seedTrader();
  seedOrder({ index: 1, status: 'FILLED', purpose: 'entry', symbol: 'ETHUSDT', fee: 3 });
  assert.equal(orderStore.openEntryCosts(traderId, []), 0);
});

test('未平仓成本只作用于本机器人', () => {
  // 多个机器人共用一个库：把别人的入场费算进来会让本机器人的总账凭空多一笔。
  traderId = seedTrader('mine');
  const other = seedTrader('other');
  seedOrder({ index: 1, status: 'FILLED', purpose: 'entry', symbol: 'ETHUSDT', fee: 1.5 });
  seedOrder({ forTrader: other, index: 2, status: 'FILLED', purpose: 'entry', symbol: 'ETHUSDT', fee: 99 });
  assert.ok(Math.abs(orderStore.openEntryCosts(traderId, ['ETHUSDT']) - 1.5) < 1e-9);
});
