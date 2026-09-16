import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, getDb, initDb } from '../db/index.js';
import {
  aiModels,
  clampOrderLimit,
  clampTradeLimit,
  exchanges,
  ORDER_PAGE_DEFAULT,
  ORDER_PAGE_MAX,
  orders as orderStore,
  strategies,
  traders,
  TRADE_PAGE_DEFAULT,
  TRADE_PAGE_MAX,
  trades as tradeStore,
} from './repositories.js';

/**
 * 历史成交 / 订单记录的**分页契约**。
 *
 * 这个文件防的是操作者报告的那件事：「历史成交 / 订单记录 … 要有默认显示条数和翻页功能
 * （避免资源浪费和系统卡死）」。这两张表以前每 15 秒无条件向服务端要 200 行并**全部**渲染，
 * 而路由把 `?limit=999999` 原样交给 SQL —— 一个跑了半年的机器人有几千行订单，
 * 一次请求就能把整张表拼进响应、把 event loop 占住，浏览器那侧也要一次建出几千个 DOM 节点。
 *
 * 三件事必须被钉住（与 `decisions.test.ts` 同一套，两张表各来一遍）：
 *
 *  1. `limit` 有硬上限，且**钳制而不报错** —— 999999 拿到的是上限条数，不是全部；
 *  2. 游标翻页取到的是"接下来的那些"，不重不漏，最新在前；
 *  3. **两次翻页之间插入一行**（新订单 / 新平仓），页边界依然不重不漏 —— 这正是选游标
 *     （`before=id`）而不是 `OFFSET` 的唯一理由，所以它必须有一个用例。
 *     成交那张表还多一条：对账补录进来的行 `closed_at` 可能比库里已有的行更旧，
 *     所以排序键只能是 `id`，不能是 `closed_at`（见最后一个用例）。
 *
 * 按 AGENTS.md §3.6：临时目录，绝不碰 `data/`。
 */

let workDir: string;
let traderId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-table-pages-'));
  initDb(path.join(workDir, 'table-pages.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().run('DELETE FROM orders');
  getDb().run('DELETE FROM trades');
});

/** 一个新的机器人（每个用例一个，与 `decisions.test.ts` 同一种写法）。 */
function seedTrader(name = 'table-pages'): number {
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

/** 写一张订单。内容与本文件无关，只要求"一单一行"。 */
function placeOrder(forTrader = traderId, index = 1): number {
  return orderStore.insert({
    traderId: forTrader,
    exchangeOrderId: `EX-${forTrader}-${index}`,
    clientOrderId: `CL-${forTrader}-${index}`,
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'MARKET',
    purpose: 'entry',
    quantity: 1 + index,
    price: null,
    stopPrice: null,
    status: 'FILLED',
    avgPrice: 100 + index,
    filledQty: 1 + index,
    fee: 0.01,
  });
}

/**
 * 记一笔已平仓的回合。
 *
 * `symbol` / `quantity` / `closedAt` 都随 `index` 变：`trades.insert()` 现在是
 * **幂等**的（它按 `closed_at` 与入场订单号判定"同一个真实回合"），
 * fixture 里给两行相同的时间与数量就会被判成一行，用例会在测到分页之前先失败。
 */
function bookTrade(forTrader = traderId, index = 1, closedAt?: string): number {
  const iso = closedAt ?? new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString();
  return tradeStore.insert({
    traderId: forTrader,
    symbol: `T${index}USDT`,
    side: 'long',
    quantity: 1 + index,
    entryPrice: 100 + index,
    exitPrice: 101 + index,
    leverage: 5,
    grossPnl: index,
    entryFee: 0.1,
    exitFee: 0.1,
    fundingFee: 0,
    closeReason: 'model_decision',
    openedAt: iso,
    closedAt: iso,
    source: 'bot',
  }).id;
}

/** 连续写入 `count` 行，返回写入的 id（**升序 = 时间顺序**，最后一个是新的）。 */
function seedOrders(count: number, forTrader = traderId): number[] {
  const ids: number[] = [];
  for (let index = 1; index <= count; index += 1) ids.push(placeOrder(forTrader, index));
  return ids;
}

function seedTrades(count: number, forTrader = traderId): number[] {
  const ids: number[] = [];
  for (let index = 1; index <= count; index += 1) ids.push(bookTrade(forTrader, index));
  return ids;
}

const idsOf = (rows: Array<{ id: number }>): number[] => rows.map((row) => row.id);

/* -------------------------------------------------------------------------- */
/*  订单：上限                                                                 */
/* -------------------------------------------------------------------------- */

test('订单：limit 有硬上限：?limit=999999 拿到的是上限条数，而不是全部', () => {
  /*
   * 断言分两层：
   *  · 行为层 —— 要得再多也不会超过 `ORDER_PAGE_MAX`，而且不报错（钳制而不是 400）；
   *  · 政策层 —— 上限本身不能大到等于"没有上限"。只写第一层的话，
   *    有人把上限调到 100000 这个用例照样是绿的，而事故原封不动地回来了。
   */
  traderId = seedTrader();
  // 两页还多：这样"带游标的那一页"下面也还剩够多的行，钳制在那条路径上同样能被观察到。
  seedOrders(ORDER_PAGE_MAX * 2 + 5);

  const page = orderStore.list(traderId, 999_999);
  assert.equal(page.length, ORDER_PAGE_MAX, '超出上限的 limit 必须被钳到上限');
  assert.ok(
    ORDER_PAGE_MAX <= 200,
    `订单页大小上限被调到了 ${ORDER_PAGE_MAX} —— 一次请求又能把整张订单表拼进响应里了`,
  );

  // 上限对**带游标的页**同样生效：否则深翻几页之后又能一次拉一大片。
  const cursor = page[page.length - 1]!.id;
  const deeper = orderStore.list(traderId, 999_999, cursor);
  assert.equal(deeper.length, ORDER_PAGE_MAX, '带游标的页也必须被钳制');
  assert.ok(!idsOf(deeper).includes(cursor), '钳制不能把游标那一页变成"从游标重新开始"');
});

test('订单：默认页大小没变，非有限值、小数与 0 都被收进合法区间', () => {
  traderId = seedTrader();
  seedOrders(ORDER_PAGE_DEFAULT + 10);

  // 默认 100 是路由原来的契约（`?? 100`），老客户端依赖它。
  assert.equal(orderStore.list(traderId).length, ORDER_PAGE_DEFAULT);

  // 路由以前对非有限值是回落到 100（`Number.isFinite(limit) ? limit : 100`），保持一致。
  assert.equal(clampOrderLimit(Number.NaN), ORDER_PAGE_DEFAULT);
  assert.equal(clampOrderLimit(Number.POSITIVE_INFINITY), ORDER_PAGE_DEFAULT);
  // 小数（`?limit=20.7`）不该把 SQLite 的 LIMIT 变成一个没人预期过的数。
  assert.equal(clampOrderLimit(20.7), 20);
  // 0 或负数收进 1 行：`LIMIT 0` 的空数组和"这个机器人还没有订单"长得一模一样，
  // 会把一次参数错误伪装成一次空结果。
  assert.equal(clampOrderLimit(0), 1);
  assert.equal(clampOrderLimit(-5), 1);
});

/* -------------------------------------------------------------------------- */
/*  订单：游标翻页                                                             */
/* -------------------------------------------------------------------------- */

test('订单：before=id 取到的正好是下一页：不重、不漏、最新在前', () => {
  traderId = seedTrader();
  const ids = seedOrders(45);
  const newestFirst = [...ids].reverse(); // ids[44] 最新 → ids[0] 最旧

  const page1 = orderStore.list(traderId, 20);
  assert.deepEqual(idsOf(page1), newestFirst.slice(0, 20), '第一页必须是最新的 20 张，且倒序');

  const page2 = orderStore.list(traderId, 20, page1[page1.length - 1]!.id);
  assert.deepEqual(idsOf(page2), newestFirst.slice(20, 40), '第二页必须紧接第一页往下取');

  const page3 = orderStore.list(traderId, 20, page2[page2.length - 1]!.id);
  assert.deepEqual(idsOf(page3), newestFirst.slice(40), '最后一页只有剩下的 5 张');

  // 再往下要：空数组，而不是又从头来一遍 ——
  // 客户端就是靠"这一页不满"判断「已到最早一笔」的。
  const page4 = orderStore.list(traderId, 20, page3[page3.length - 1]!.id);
  assert.deepEqual(page4, []);

  const all = [...page1, ...page2, ...page3].map((row) => row.id);
  assert.equal(new Set(all).size, 45, '三页合起来必须正好覆盖 45 张，没有重复');
});

test('订单：翻页之间插入一张新订单，页边界依然不重不漏（这就是不用 offset 的理由）', () => {
  /*
   * 真实场景：机器人一直在跑，操作者翻到了第二页，而期间又下了一张新单。
   *
   * 用 `OFFSET 3` 的话，插入之后 `ORDER BY id DESC LIMIT 3 OFFSET 3` 会从
   * `[new, 10, 9, 8, 7, …]` 里取到 `[8, 7, 6]` —— 8 是上一页的最后一条，
   * 于是订单表里同一张订单出现两次（看起来像下了两单）。
   * 游标 `id < 8` 取到的是 `[7, 6, 5]`，与上一页严丝合缝。
   */
  traderId = seedTrader();
  const ids = seedOrders(10);
  const newestFirst = [...ids].reverse();

  const page1 = orderStore.list(traderId, 3);
  assert.deepEqual(idsOf(page1), newestFirst.slice(0, 3));
  const cursor = page1[page1.length - 1]!.id;

  // 第二次请求**之前**，又下了一张新单（id 更大，落在游标之上）。
  const newId = placeOrder(traderId, 99);
  assert.ok(newId > cursor, '新订单的 id 必须比游标大，否则游标语义不成立');

  const page2 = orderStore.list(traderId, 3, cursor);
  const page2Ids = idsOf(page2);

  assert.equal(page2Ids.length, 3);
  assert.ok(!page2Ids.includes(cursor), '第二页重复了第一页的最后一张 —— 游标退化成 offset 了');
  assert.ok(!page2Ids.includes(newId), '第二页不该包含插到顶部的新订单');
  assert.deepEqual(page2Ids, newestFirst.slice(3, 6), '第二页必须是游标紧邻的那三张');

  // 而"最新一页"仍然是新的：轮询会重新拉第一页，它必须已经包含刚插入的那张。
  assert.equal(orderStore.list(traderId, 3)[0]!.id, newId);

  // 换个方向再钉一次：从第二页继续往下翻，三页合起来正好覆盖 9 张、无一重复。
  const page3 = orderStore.list(traderId, 3, page2[page2.length - 1]!.id);
  const seen = new Set([...idsOf(page1), ...page2Ids, ...idsOf(page3)]);
  assert.equal(seen.size, 9);
});

test('订单：游标只作用于本机器人', () => {
  // 多个机器人共用一个库：游标撞上别的机器人的行时不能把它的订单捞出来。
  traderId = seedTrader('mine');
  const other = seedTrader('other');

  // 交替写入，让两个机器人的 id 交错在一起 —— 这样"漏了 trader_id 条件"必然被抓到。
  const mine: number[] = [];
  const theirs: number[] = [];
  for (let index = 1; index <= 3; index += 1) {
    mine.push(placeOrder(traderId, index));
    theirs.push(placeOrder(other, index));
  }

  const page = orderStore.list(traderId, 10);
  assert.deepEqual(idsOf(page), [...mine].reverse());
  assert.ok(page.every((row) => row.traderId === traderId));
  assert.ok(
    theirs.every((id) => !idsOf(page).includes(id)),
    '别的机器人的订单混进来了',
  );

  const next = orderStore.list(traderId, 10, mine[1]);
  assert.deepEqual(idsOf(next), [mine[0]]);
});

/* -------------------------------------------------------------------------- */
/*  成交：上限                                                                 */
/* -------------------------------------------------------------------------- */

test('成交：limit 有硬上限：?limit=999999 拿到的是上限条数，而不是全部', () => {
  traderId = seedTrader();
  seedTrades(TRADE_PAGE_MAX * 2 + 5);

  const page = tradeStore.list(traderId, 999_999);
  assert.equal(page.length, TRADE_PAGE_MAX, '超出上限的 limit 必须被钳到上限');
  assert.ok(
    TRADE_PAGE_MAX <= 200,
    `成交页大小上限被调到了 ${TRADE_PAGE_MAX} —— 一次请求又能把整张成交表拼进响应里了`,
  );

  // 成交行是最宽的一张：每页都带着毛/净盈亏、两侧手续费、资金费与两个订单号。
  const cursor = page[page.length - 1]!.id;
  assert.equal(tradeStore.list(traderId, 999_999, cursor).length, TRADE_PAGE_MAX);

  // 默认页大小与钳制规则必须和订单表一模一样（同一个 `clampPageLimit`）。
  seedTrades(TRADE_PAGE_DEFAULT + 10);
  assert.equal(tradeStore.list(traderId).length, TRADE_PAGE_DEFAULT);
  assert.equal(clampTradeLimit(Number.NaN), TRADE_PAGE_DEFAULT);
  assert.equal(clampTradeLimit(20.7), 20);
  assert.equal(clampTradeLimit(0), 1);
  assert.equal(clampTradeLimit(-5), 1);
});

/* -------------------------------------------------------------------------- */
/*  成交：游标翻页                                                             */
/* -------------------------------------------------------------------------- */

test('成交：before=id 取到的正好是下一页：不重、不漏、最新在前', () => {
  traderId = seedTrader();
  const ids = seedTrades(45);
  const newestFirst = [...ids].reverse();

  const page1 = tradeStore.list(traderId, 20);
  assert.deepEqual(idsOf(page1), newestFirst.slice(0, 20), '第一页必须是最新的 20 笔，且倒序');

  const page2 = tradeStore.list(traderId, 20, page1[page1.length - 1]!.id);
  assert.deepEqual(idsOf(page2), newestFirst.slice(20, 40));

  const page3 = tradeStore.list(traderId, 20, page2[page2.length - 1]!.id);
  assert.deepEqual(idsOf(page3), newestFirst.slice(40));

  assert.deepEqual(tradeStore.list(traderId, 20, page3[page3.length - 1]!.id), []);

  const all = [...page1, ...page2, ...page3].map((row) => row.id);
  assert.equal(new Set(all).size, 45, '三页合起来必须正好覆盖 45 笔，没有重复');
});

test('成交：翻页之间又平了一仓，页边界依然不重不漏（这就是不用 offset 的理由）', () => {
  traderId = seedTrader();
  const ids = seedTrades(10);
  const newestFirst = [...ids].reverse();

  const page1 = tradeStore.list(traderId, 3);
  assert.deepEqual(idsOf(page1), newestFirst.slice(0, 3));
  const cursor = page1[page1.length - 1]!.id;

  // 第二次请求**之前**，机器人又平了一仓。
  const newId = bookTrade(traderId, 11);
  assert.ok(newId > cursor, '新成交的 id 必须比游标大，否则游标语义不成立');

  const page2 = tradeStore.list(traderId, 3, cursor);
  const page2Ids = idsOf(page2);

  assert.equal(page2Ids.length, 3);
  assert.ok(!page2Ids.includes(cursor), '第二页重复了第一页的最后一笔 —— 游标退化成 offset 了');
  assert.ok(!page2Ids.includes(newId), '第二页不该包含插到顶部的新成交');
  assert.deepEqual(page2Ids, newestFirst.slice(3, 6));

  assert.equal(tradeStore.list(traderId, 3)[0]!.id, newId);

  const page3 = tradeStore.list(traderId, 3, page2[page2.length - 1]!.id);
  const seen = new Set([...idsOf(page1), ...page2Ids, ...idsOf(page3)]);
  assert.equal(seen.size, 9);
});

test('成交：对账补录的行 closed_at 更旧，但排序键与游标键都是 id', () => {
  /*
   * 这一条钉的是**排序键**：成交记录曾经按 `closed_at DESC` 排。
   *
   * 但 `closed_at` 是交易所的成交时间，不是写入时间：对账补录
   * （`reconcileTradeHistory`）会把"进程未运行时"才平掉的回合现在写进来，
   * 这些行的 `closed_at` 比库里已有的行更旧。若继续按 `closed_at` 排，那么
   * "页面顺序"与"游标锚住的 id 顺序"是两套顺序 —— 翻页时必然漏行或重复。
   *
   * 所以：排序键 = 游标键 = `id`（写入顺序，最新记进来的在最上面）。
   * 下面用"补录一笔更旧的成交"把这件事演出来。
   */
  traderId = seedTrader();
  const ids = seedTrades(6);

  const page1 = tradeStore.list(traderId, 3);
  assert.deepEqual(idsOf(page1), [...ids].reverse().slice(0, 3));
  const cursor = page1[page1.length - 1]!.id;

  // 补录：成交时间是**一天前**（比库里所有行都旧），但它是现在才写进来的。
  const recovered = bookTrade(traderId, 99, '2024-12-31T00:00:00.000Z');
  assert.ok(recovered > cursor);

  // 它排在最上面（"最近记进来的"），而不是按成交时间插回一天前的历史中间。
  assert.equal(tradeStore.list(traderId, 10)[0]!.id, recovered);

  // 游标翻页不受它影响：第二页仍然是紧接着游标往下数的那三笔，没有重复、没有跳过。
  const page2 = tradeStore.list(traderId, 3, cursor);
  assert.deepEqual(idsOf(page2), [...ids].reverse().slice(3, 6));
  assert.ok(!idsOf(page2).includes(recovered));
});

test('成交：游标只作用于本机器人', () => {
  traderId = seedTrader('mine');
  const other = seedTrader('other');

  const mine: number[] = [];
  const theirs: number[] = [];
  for (let index = 1; index <= 3; index += 1) {
    mine.push(bookTrade(traderId, index));
    theirs.push(bookTrade(other, index));
  }

  const page = tradeStore.list(traderId, 10);
  assert.deepEqual(idsOf(page), [...mine].reverse());
  assert.ok(page.every((row) => row.traderId === traderId));
  assert.ok(
    theirs.every((id) => !idsOf(page).includes(id)),
    '别的机器人的成交混进来了',
  );

  const next = tradeStore.list(traderId, 10, mine[1]);
  assert.deepEqual(idsOf(next), [mine[0]]);
});
