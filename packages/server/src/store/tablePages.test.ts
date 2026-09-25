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
  normalizeMarginMode,
  orders as orderStore,
  resolveOrderMarginUsed,
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
function placeOrder(
  forTrader = traderId,
  index = 1,
  marginUsed?: number,
  marginType?: string,
): number {
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
    ...(marginUsed === undefined ? {} : { marginUsed }),
    ...(marginType === undefined ? {} : { marginType }),
  });
}

/**
 * 记一笔已平仓的回合。
 *
 * `symbol` / `quantity` / `closedAt` 都随 `index` 变：`trades.insert()` 现在是
 * **幂等**的（它按 `closed_at` 与入场订单号判定"同一个真实回合"），
 * fixture 里给两行相同的时间与数量就会被判成一行，用例会在测到分页之前先失败。
 */
function bookTrade(forTrader = traderId, index = 1, closedAt?: string, leverage = 5): number {
  const iso = closedAt ?? new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString();
  return tradeStore.insert({
    traderId: forTrader,
    symbol: `T${index}USDT`,
    side: 'long',
    quantity: 1 + index,
    entryPrice: 100 + index,
    exitPrice: 101 + index,
    leverage,
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
   * ⚠️ **这条用例原来断言的是"补录行排在最上面"** —— 那个行为被推翻了。
   *
   * 原注释写着：「排序键 = 游标键 = `id`（写入顺序，最新记进来的在最上面）」，
   * 理由是"页边界不重不漏优先于补录行插回历史中间"。**分页正确性当然重要**，
   * 但它不是二选一 —— 用 `(closed_at, id)` 复合游标就能同时满足。
   *
   * 而只按 id 排的代价是用户直接看到的：**「历史成交里面日期显示错乱
   * （不是完全按时间排序）」**。实测线上 18 行里有 **4 处**乱序。
   *
   * 所以现在：**排序按 `closed_at`，游标是复合的**。这条用例改过来钉新契约。
   */
  traderId = seedTrader();
  const ids = seedTrades(6);

  const page1 = tradeStore.list(traderId, 3);
  assert.deepEqual(idsOf(page1), [...ids].reverse().slice(0, 3));
  const cursor = page1[page1.length - 1]!.id;

  // 补录：成交时间是**一天前**（比库里所有行都旧），但它是现在才写进来的。
  const recovered = bookTrade(traderId, 99, '2024-12-31T00:00:00.000Z');
  assert.ok(recovered > cursor);

  /*
   * ⚠️ **它必须排在最后**（时间最新 → 最旧），而不是按 id 排到最前面。
   * 这一条就是"日期错乱"的回归测试。
   */
  const page = tradeStore.list(traderId, 10);
  assert.equal(
    page[page.length - 1]!.id,
    recovered,
    '按 closed_at 排序时，一天前那一笔该在最下面 —— 按 id 排会让它跳到最上面，那就是日期错乱',
  );
  for (let i = 1; i < page.length; i += 1) {
    assert.ok(
      page[i - 1]!.closedAt >= page[i]!.closedAt,
      `closedAt 必须单调不增：#${page[i - 1]!.id}(${page[i - 1]!.closedAt}) 后面是 #${page[i]!.id}(${page[i]!.closedAt})`,
    );
  }

  /*
   * 复合游标：从最旧那一行继续翻，既不重复也不漏。
   *
   * 单靠 `id` 游标会**漏掉**这类补录行（它们 id 大、时间早）——
   * 所以这里两个都传，证明新路径可用。
   */
  const oldest = page[page.length - 1]!;
  assert.deepEqual(
    tradeStore.list(traderId, 10, oldest.id, oldest.closedAt),
    [],
    '已经在最旧那一行上，翻下一页应当是空的',
  );

  /* 老契约仍然可用：只给 id 时退回按 id 分页，行为与以前一致。 */
  assert.deepEqual(idsOf(tradeStore.list(traderId, 3, cursor)), [...ids].reverse().slice(3, 6));
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

/* -------------------------------------------------------------------------- */
/*  保证金占用                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 订单行上的「保证金占用」。
 *
 * ## 这一列为什么必须由服务端给
 *
 * 操作者在「当前委托 / 订单记录」里看的是**每一张单**，而 `orders` 表里既没有杠杆，
 * 也没有对应持仓的入场价 —— 止损/止盈行上只有触发价。前端拿不到就只能写 `0`
 * 或是硬编一个分母，两者都是编数。
 *
 * ## 这条用例钉的是两个方向
 *
 *  · 写得进去、读得回来（原样）；
 *  · **没写过的是 `undefined`，不是 `0`**。界面据 `undefined` 显示 `—`，
 *    而 `0` 会被读成"这笔没占保证金" —— 两句相反的结论不能共用一个值。
 *    写 `0` 进来的那条路也归到"不知道"：这一列只有
 *    `AutoTrader.recordOrder()` 会写，而它写 0 的唯一可能是**算不出来**
 *    （`marginOf()` 在名义价值为 0 时回 0）。
 */
test('订单：marginUsed 原样回读；没写过、或写了 0 的都是 undefined 而不是 0', () => {
  traderId = seedTrader();

  const withMargin = placeOrder(traderId, 1, 12.5);
  const without = placeOrder(traderId, 2);
  const zeroed = placeOrder(traderId, 3, 0);

  const byId = new Map(orderStore.list(traderId, 10).map((row) => [row.id, row]));

  assert.equal(byId.get(withMargin)!.marginUsed, 12.5, '落库的保证金必须原样读回来');
  assert.equal(
    byId.get(without)!.marginUsed,
    undefined,
    '没写过保证金的行必须是 undefined（界面显示 —），不能是 0',
  );
  assert.equal(
    byId.get(zeroed)!.marginUsed,
    undefined,
    '0 读作"这笔没占保证金"，所以它必须归到"不知道"那一类',
  );
});

/**
 * `normalizeMarginMode()` —— 「全仓 / 逐仓」这个概念的**唯一收口**。
 *
 * 它存在的理由是这个概念在系统里有**三个拼法**，全都是外部契约、改不动：
 *
 * | 来源 | 写法 |
 * | --- | --- |
 * | 交易所 `positionRisk`（读） | `cross` |
 * | `POST /fapi/v1/marginType`（写） | `CROSSED` |
 * | `StrategyConfigSchema.riskControl.marginMode` | `crossed` |
 *
 * 直接比较字符串会**静默失败**（`'cross' === 'crossed'` 是 `false`，不抛错、不报警），
 * 所以收口必须在这里做一次，落库与读出各走一遍。
 *
 * 第二段钉的是"认不出 ≠ 全仓"：币安的默认确实是全仓，但那是"默认"，
 * 不是"我们读到了"—— 不认识的值回 `null`（界面 `—`），**不回落到 `'cross'`**。
 */
test('normalizeMarginMode：三种写法收成同一个机器码；认不出的回 null，绝不回落成全仓', () => {
  // ① 三种外部写法都收到同一对机器码上。
  assert.equal(normalizeMarginMode('cross'), 'cross', '交易所 positionRisk 的写法');
  assert.equal(normalizeMarginMode('crossed'), 'cross', '策略配置与写接口的写法');
  assert.equal(normalizeMarginMode('CROSSED'), 'cross', '写接口全大写');
  assert.equal(normalizeMarginMode('ISOLATED'), 'isolated');
  assert.equal(normalizeMarginMode(' isolated '), 'isolated', '多一个空格不该变成"不知道"');

  // ② 认不出的、以及根本没有值的一律是 null ——**不是** 'cross'。
  for (const value of [null, undefined, '', 'both', 'hedge', 1, {}, []]) {
    assert.equal(
      normalizeMarginMode(value),
      null,
      `认不出的值必须回 null（界面 —），实际把 ${JSON.stringify(value)} 收成了别的 —— ` +
        '回落到 cross 就是替交易所宣布一个没验证过的事实',
    );
  }
});

/**
 * `orders.margin_type` —— 用户的原话是「订单记录里面显示：全仓\逐仓」。
 *
 * ## 这条用例钉的是什么（不是"能不能存字符串"）
 *
 * **没有这个事实时是 `undefined`（界面显示 `—`），绝不是 `'cross'`。**
 * 币安的默认确实是全仓，但"默认是"与"我们读到了"是两件事：给读不到的行补一个 `'cross'`，
 * 界面上「全仓」与「不知道」就长得一模一样了 —— 而这个仓库为这件事定过两次规矩
 * （`marginUsed` 的 0 与 undefined、`M13_ORDER_MARGIN_USED` 的 NULL 与 0）。
 *
 * 覆盖三种缺失：迁移之前的历史行（这一列不存在）、调用方没传、以及传了一个脏字符串
 * （写进 SQL 的是 `NULL`，不是那个字符串，也不是"全仓"）。
 */
test('订单：marginType 原样回读；没写过 / 认不出的行是 undefined 而不是默认的全仓', () => {
  traderId = seedTrader();

  const isolated = placeOrder(traderId, 1, undefined, 'isolated');
  const crossed = placeOrder(traderId, 2, undefined, 'crossed'); // 配置里的写法
  const upper = placeOrder(traderId, 3, undefined, 'CROSSED'); // 写接口的写法
  const unset = placeOrder(traderId, 4); // 调用方没传（= 不知道）
  const junk = placeOrder(traderId, 5, undefined, 'weird-mode'); // 脏数据

  const byId = new Map(orderStore.list(traderId, 10).map((row) => [row.id, row]));

  assert.equal(byId.get(isolated)!.marginType, 'isolated', '逐仓必须原样读回来');
  assert.equal(byId.get(crossed)!.marginType, 'cross', '配置里的 crossed 落库必须是 cross');
  assert.equal(byId.get(upper)!.marginType, 'cross', '写接口的 CROSSED 落库必须是 cross');
  assert.equal(
    byId.get(unset)!.marginType,
    undefined,
    '没写过这一列的行必须是 undefined（界面 —），不能是 cross —— 那是在编一个事实',
  );
  assert.equal(
    byId.get(junk)!.marginType,
    undefined,
    '认不出的写法归到"不知道"，不能原样透出、更不能猜成全仓',
  );
});

/**
 * `resolveOrderMarginUsed()` —— 「这一行该写什么保证金」的唯一那份判断。
 *
 * 这是 `AutoTrader.recordOrder()` 调用的纯函数，所以**不需要起交易循环**就能把
 * 三条规则钉住（AGENTS §5.4：能被测的逻辑做成纯函数）：
 *
 *   ① 开仓 / 加仓：用这一笔自己的值；
 *   ② 平仓 / 保护单：取它那张持仓的保证金（`positions.margin_used`，权威值）；
 *   ③ 拿不到 → `null`（界面 `—`），而不是 0。
 *
 * 还有一条**防的是编数**：开仓单**不许**回落到持仓行。那一刻它要建的持仓还不存在，
 * 若同标的上恰好还挂着一个别的持仓（重复开仓的守卫失效、或对账留下的行），
 * 回落就会把**别人的仓位**压的本金记到这一行上。
 */
test('订单：保证金取值的三条规则（含"开仓单不许回落到别人的持仓"）', () => {
  // ① 开仓单：用这一笔自己的值。
  assert.equal(
    resolveOrderMarginUsed({ purpose: 'entry', override: 40.4, positionMargin: 999 }),
    40.4,
    '开仓单必须用这一笔自己的保证金，而不是那个不相关的持仓行',
  );
  // ② 平仓 / 保护单：取持仓行的权威值。
  for (const purpose of ['exit', 'stop_loss', 'take_profit', 'adjustment'] as const) {
    assert.equal(
      resolveOrderMarginUsed({ purpose, positionMargin: 123.45 }),
      123.45,
      `${purpose} 单应当取它那张持仓的 margin_used`,
    );
  }
  // ③ 拿不到就是 null；0 也归到"不知道"（`marginOf()` 在名义价值为 0 时会回 0）。
  assert.equal(resolveOrderMarginUsed({ purpose: 'exit' }), null);
  assert.equal(resolveOrderMarginUsed({ purpose: 'exit', positionMargin: null }), null);
  assert.equal(resolveOrderMarginUsed({ purpose: 'exit', positionMargin: 0 }), null);
  assert.equal(resolveOrderMarginUsed({ purpose: 'entry' }), null, '被拒的开仓单什么都没占用');
  assert.equal(resolveOrderMarginUsed({ purpose: 'entry', override: 0 }), null);
  assert.equal(resolveOrderMarginUsed({ purpose: 'entry', override: Number.NaN }), null);
  // ★ 开仓单**不回落**：这是这条规则里唯一会"编出别人的数"的分支。
  assert.equal(
    resolveOrderMarginUsed({ purpose: 'entry', override: undefined, positionMargin: 999 }),
    null,
    '开仓单不许继承同标的另一个持仓的保证金 —— 那是别人的本金',
  );
});

/**
 * 成交行上的「保证金占用」是**派生**的：`|entryPrice × quantity| ÷ leverage`。
 *
 * 它必须与建仓那一刻写进 `positions.margin_used`、以及 `pnlPercent` 的分母是
 * 同一个数（三处共用 `marginOf()`）—— 否则"这笔占了多少本金"会随读它的地方而变。
 *
 * 后半段钉的是"算不出来时不是 0"：杠杆为 0 的行走 `marginUsedOrUndefined()` 回
 * `undefined`。若有人图省事直接用 `marginOf()`，它内部的 `Math.max(leverage, 1)`
 * 会把一笔 5x 的仓位按 1x 算 —— **保证金直接放大 5 倍**，而界面上看不出这是个假数。
 */
test('成交：marginUsed = |qty × entry| ÷ leverage；杠杆缺失时是 undefined 而不是 0', () => {
  traderId = seedTrader();

  const normal = bookTrade(traderId, 1); // qty 2 × entry 101 ÷ 5x
  const noLeverage = bookTrade(traderId, 2, undefined, 0);

  const byId = new Map(tradeStore.list(traderId, 10).map((row) => [row.id, row]));

  assert.equal(byId.get(normal)!.marginUsed, (2 * 101) / 5, '保证金必须是 名义价值 ÷ 杠杆');
  assert.equal(
    byId.get(noLeverage)!.marginUsed,
    undefined,
    '杠杆缺失时必须回 undefined —— 凭空按 1x 算出来的金额是一个假数',
  );
});
