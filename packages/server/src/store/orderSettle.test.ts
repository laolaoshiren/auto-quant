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
  orderIdIn,
  orders as orderStore,
  positions as positionStore,
  shouldTrustReconciledQuantity,
  strategies,
  trades as tradeStore,
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
   * ## ⚠️ 筛的是「这一笔持仓的入场单号」，不是 symbol
   *
   * 原来按 `symbol IN (当前持仓的标的)` 过滤 —— **同一标的历史上已平仓回合的
   * 入场手续费会被重复计入**（那些回合的盈亏早已通过 `trades` 进了 `platformSelf`，
   * 入场费再加一遍就是记两次）。而同一标的反复开平正是这个项目的常态，
   * 所以这不是边角情况。③ 就是钉这一条的：它和 ① 同标的、同状态，
   * 唯一区别是它属于**另一个（已平仓的）回合**。
   */
  traderId = seedTrader();

  /* ① 要算的：当前这笔持仓的入场单（EX-1、已成交、purpose=entry） */
  seedOrder({ index: 1, status: 'FILLED', purpose: 'entry', symbol: 'ETHUSDT', fee: 0.0118539 });
  /* ② 不算：那是保护单，不是入场费 */
  seedOrder({ index: 2, status: 'FILLED', purpose: 'stop_loss', symbol: 'ETHUSDT', fee: 9 });
  /* ③ 不算：**同一标的历史回合**的入场费（按 symbol 过滤会把 7 也算进来） */
  seedOrder({ index: 3, status: 'FILLED', purpose: 'entry', symbol: 'ETHUSDT', fee: 7 });
  /* ④ 不算：还没成交的单没有手续费 */
  seedOrder({ index: 4, status: 'NEW', purpose: 'entry', symbol: 'ETHUSDT', fee: 5 });

  const total = orderStore.openEntryCosts(traderId, ['EX-1']);
  assert.ok(
    Math.abs(total - 0.0118539) < 1e-9,
    `只应汇总当前持仓那一笔入场费（EX-1），实际 ${total}` +
      '（把保护单、未成交的单、或同标的历史回合的入场费算进来，都会让总账校验反向误报）',
  );
});

test('没有持仓时未平仓成本是 0，不是「全部入场费」', () => {
  /*
   * 空列表必须短路返回 0。若不短路，SQL 里的 `IN ()` 会变成语法错误，
   * 而更糟的一种实现是"忘了过滤" —— 那样已平仓的入场费也会被加进平台侧，
   * 于是一个**已经对上的账**会被推成负差额。
   *
   * 空字符串同理：`positions.entry_order_id` 允许为 NULL（收养、迁移前的行），
   * 调用方会把它过滤掉，但这一层也要能安全地接住。
   */
  traderId = seedTrader();
  seedOrder({ index: 1, status: 'FILLED', purpose: 'entry', symbol: 'ETHUSDT', fee: 3 });
  assert.equal(orderStore.openEntryCosts(traderId, []), 0);
  assert.equal(orderStore.openEntryCosts(traderId, [''], ), 0);
});

test('未平仓成本只作用于本机器人', () => {
  // 多个机器人共用一个库：把别人的入场费算进来会让本机器人的总账凭空多一笔。
  traderId = seedTrader('mine');
  const other = seedTrader('other');
  seedOrder({ index: 1, status: 'FILLED', purpose: 'entry', symbol: 'ETHUSDT', fee: 1.5 });
  seedOrder({ forTrader: other, index: 2, status: 'FILLED', purpose: 'entry', symbol: 'ETHUSDT', fee: 99 });
  // 两个单号都给进去，`trader_id` 那一条必须把别人的 99 挡在外面。
  assert.ok(Math.abs(orderStore.openEntryCosts(traderId, ['EX-1', 'EX-2']) - 1.5) < 1e-9);
});

/* -------------------------------------------------------------------------- */
/*  单号精度：历史坏行的归属判定                                                  */
/* -------------------------------------------------------------------------- */

test('★ 单号被精度改写过的历史行，归属判定仍要认得出', () => {
  /*
   * 实测（2026-09-27 ETHUSDT）：交易所成交里的真实入口单号是
   * `8389766285736311569`（19 位），而 `orders` 表里存的是 `8389766285736312000`
   * —— 2026-09-28 之前用 `Number()` 解析响应时**后三位被改写**了。
   *
   * 归属判定（"这一回合是不是本机器人的"）就是拿这两边做字符串相等比较，
   * 于是那个回合**永远**被判成「不属于本平台的成交」→ 总账校验凭空多出一笔
   * 外部净额（实测 `foreignNet = -0.256743`，与那笔真实成交一字不差）
   * → 每轮都报「账目与交易所对不上」。
   *
   * 解析层已经修好（`preserveBigIds()`），但历史行改不回来 —— 所以判定宽容一次。
   */
  const ids = new Set(['8389766285736312000', '96310441696']);

  assert.equal(
    orderIdIn('8389766285736311569', ids),
    true,
    '★ 交易所的真实单号要能认出本地那行被改写过的记录',
  );
  assert.equal(orderIdIn('8389766285736312000', ids), true, '原样匹配照旧');
  assert.equal(orderIdIn('96310441696', ids), true, '16 位以内的单号精确匹配（不受影响）');
  assert.equal(orderIdIn('245217262410', ids), false, '★ 不相干的单号绝不能被放行');
  assert.equal(orderIdIn('', ids), false, '空单号永远不匹配');
});

/* -------------------------------------------------------------------------- */
/*  重建成交量是否可信                                                          */
/* -------------------------------------------------------------------------- */

test('★ 重建的成交量与本地差得太远时不可信 —— 错位会污染整本账', () => {
  /*
   * 实测（2026-09-29，HYPEUSDT）：`reconstructRoundTrips()` 的窗口起点落在持仓中间时，
   * 整条成交序列错位 ——
   *
   *     真实：13:17 SELL 0.20（平掉更早的空头）→ 19:53 BUY 0.15（开新多头）
   *     重建：13:17 → 21:37 short qty=0.35 毛=0.000000   ← 把"平 0.20"当成"开空"
   *           21:37 → 23:25 long  qty=0.01  毛=0.089040   ← 真实 0.21，差 21 倍
   *
   * 而 `applyExchangeFigures()` 会把这个错数量覆盖进本地，**按数量计价的手续费**
   * 跟着算小 → 净额偏大 → 本地合计比交易所多 **0.0596**（`ledger_check` 上那个 gap）。
   *
   * 本地数量来自**运行期持仓行**（当时真实下单的数量），不经过重建 —— 所以差得离谱时保留它。
   */
  assert.equal(shouldTrustReconciledQuantity(0.21, 0.21), true, '一致 → 可信');
  assert.equal(shouldTrustReconciledQuantity(0.2, 0.21), true, '正常的部分成交/合并 → 可信');
  assert.equal(
    shouldTrustReconciledQuantity(0.21, 0.01),
    false,
    '★ 差 21 倍 → 不可信（保留本地，金额仍用交易所的）',
  );
  assert.equal(shouldTrustReconciledQuantity(0.01, 0.21), false, '★ 反过来同样不可信');
  assert.equal(shouldTrustReconciledQuantity(0, 0.21), false, '本地为 0 时不该让重建把它覆盖掉');
  assert.equal(shouldTrustReconciledQuantity(0.21, 0), false, '重建为 0 不可信');
});

/* -------------------------------------------------------------------------- */
/*  单号 → 用途：辨认"方向反了的重建回合"                                         */
/* -------------------------------------------------------------------------- */

test('★ 单号 → 用途 映射（用来辨认方向反了的重建回合）', () => {
  /*
   * `reconstructRoundTrips()` 用净头寸法判断开/平，而它不知道"窗口起点时的持仓"——
   * 起点落在持仓中间时，第一个 leg 的 open/close 会整体反向，把不同回合的单号配到一起。
   *
   * 实测（2026-09-29，6 笔 `reconciled`）：所谓「入场单」在本地 `orders` 里记的用途
   * 是 `exit`、所谓「出场单」记的是 `entry`，两者甚至相隔 2 天；6 笔净额合计
   * `-0.125559`，**正好等于账目校验的全部缺口**。也就是说账本没错，是重建造出来的。
   *
   * 运行期记下的 `purpose` 是**下单时的真实意图**，拿它反查就能辨认。
   */
  traderId = seedTrader();
  seedOrder({ index: 1, status: 'FILLED', purpose: 'entry' });
  seedOrder({ index: 2, status: 'FILLED', purpose: 'exit' });

  const map = orderStore.purposeByExchangeOrderId(traderId);
  assert.equal(map.get('EX-1'), 'entry');
  assert.equal(map.get('EX-2'), 'exit');
  assert.equal(map.get('EX-NOPE'), undefined, '没记过的单号不能凭空出现');
});

/* -------------------------------------------------------------------------- */
/*  已知账目缺口：重建错位（把当前行为钉住，防止它悄悄变大）                        */
/* -------------------------------------------------------------------------- */

test('★ 重建数量与本地差得太远时，数量【与金额】都保留本地', () => {
  /*
   * ## 这个缺口是什么（2026-09-29 实测，完整归因见第 21–30 轮）
   *
   * `reconstructRoundTrips()` 的窗口起点落在持仓中间时，整条成交序列错位 ——
   * HYPEUSDT 上的表现是 4 个回合的重建数量变成 **0.01**（真实 **0.21**，差 21 倍），
   * 而 `applyExchangeFigures()` 会把这个错数量覆盖进本地，**按数量计价的手续费跟着算小**
   * → 净额偏大 → 本地合计比交易所多 **0.0596 USDT**（`ledger_check` 上那个 gap）。
   *
   * ## ✅ 缺口已全部修好（2026-10-03）
   *
   *   · **数量**：差得太远时保留本地。
   *   · **金额（毛盈亏 / 手续费 / 资金费）**：**现在也保留本地**。
   *
   * 第二半是 2026-10-03 在实盘上被逼出来的 —— `#10`（MANAUSDT）的现场：
   *
   * ```text
   * 交易所成交: BUY 336 → SELL 168 (+1.132320) → SELL 168 (+0.408240)
   * 运行期记账: #191 毛 1.132320 / #192 毛 0.408240（止损，exit_order_id 为 null）
   * 对账重建:   整段看成一个 336 的腿 ⇒ grossPnl = 1.540560 = 两笔之和
   * ```
   *
   * 旧逻辑下数量保住了、**金额被覆盖成 1.540560** ⇒ `#191` 变成两笔之和而 `#192` 还在
   * ⇒ 账目凭空多出 **0.408240**（净额从 -0.08742 变成 +0.31188）。
   *
   * **真相**：一个"腿"的 `grossPnl` 是这个腿里**所有**平仓成交之和。数量对不上就说明
   * 腿的**边界**是错的，它的金额不能写进任何一行。而保留下来的本地金额也不是粗口径 ——
   * 它来自运行期从成交明细取到的那一笔，本身就是交易所的值，只是属于**正确的**那一笔。
   *
   * 原来这里写着「❌ 手续费：目前仍会被重建值覆盖 —— 这是已知缺口……
   * **要不要为它继续改账目核心逻辑，属于产品决策**」。**它已经被修掉了**，
   * 而"属于产品决策"这个结论让它多活了几天、期间实盘账目每跑一次对账就偏一次 ——
   * 留着那句话比留着 bug 更危险。
   */
  traderId = seedTrader();

  const { id } = tradeStore.insert({
    traderId,
    symbol: 'HYPEUSDT',
    side: 'long',
    quantity: 0.21, // 运行期真实下单量
    entryPrice: 97.2,
    exitPrice: 96.451,
    leverage: 3,
    openedAt: '2026-09-23T05:53:40.723Z',
    closedAt: '2026-09-23T07:54:56.063Z',
    closeReason: 'stop_loss',
    grossPnl: -0.15729,
    entryFee: 0.01420975,
    fundingFee: 0,
    source: 'bot',
  });

  /* 对账重建错位：数量 0.01（真实 0.21），手续费也按 0.01 算。 */
  tradeStore.applyExchangeFigures({
    id,
    grossPnl: -0.15729,
    entryFee: 0.00068,
    exitFee: 0.00068,
    fundingFee: 0,
    entryPrice: 97.2,
    exitPrice: 96.451,
    quantity: 0.01,
    leverage: 3,
    entryOrderId: null,
    exitOrderId: null,
  });

  const row = getDb().get<{ quantity: number; fee: number; pnl: number; net_pnl: number }>(
    'SELECT quantity, fee, pnl, net_pnl FROM trades WHERE id = ?',
    id,
  )!;

  assert.equal(
    row.quantity,
    0.21,
    '★ 数量必须保留本地 —— 否则这个回合的成交量会被写成 0.01，界面上自相矛盾',
  );
  /*
   * ## ✅ 缺口已修（2026-10-03）：数量不可信时，**金额也不再覆盖**
   *
   * 这里原来断言的是 `row.fee < 0.005`（记录"手续费仍被重建值覆盖"这个已知缺口），
   * 注释里写着"缺口一旦被真正修好（fee 变成 0.01420975 附近），这里会红 —— 那时请
   * 把它改成上面的真实值"。**就是现在这一步。**
   *
   * 为什么必须连**金额**一起保留 —— 实盘 `#10`（MANAUSDT）给出的证据：
   *
   * ```text
   * 交易所成交: BUY 336 → SELL 168 (+1.132320) → SELL 168 (+0.408240)
   * 运行期记账: #191 毛 1.132320   #192 毛 0.408240（止损触发，exit_order_id 为 null）
   * 对账重建:   整段看成一个 336 的腿 ⇒ grossPnl = 1.540560 = 两笔之和
   * ```
   *
   * 数量保护生效（保留 168），而金额被覆盖成 1.540560 ⇒ `#191` 变成两笔之和、
   * `#192` 还在 ⇒ **账目凭空多出 0.408240**（实测净额从 -0.08742 变成 +0.31188）。
   *
   * **一个"腿"的 `grossPnl` 是这个腿里所有平仓成交之和** —— 数量对不上就说明腿的
   * 边界是错的，它的金额不能写进任何一行。保留的本地金额也不是粗口径：它来自运行期
   * 从成交明细取到的那一笔，本身就是交易所的值、只是属于**正确的**那一笔。
   */
  assert.ok(
    Math.abs(row.fee - 0.01420975) < 1e-9,
    `★ 手续费必须保留本地值 0.01420975（重建按错数量算出的 ${row.fee} 不能覆盖它）`,
  );
  assert.ok(
    Math.abs(row.pnl - -0.15729) < 1e-9,
    `★ 毛盈亏必须保留本地值 -0.15729（这个用例里两者恰好相同，但断言钉住"不得覆盖"）`,
  );
  assert.ok(
    Math.abs(row.net_pnl - (-0.15729 - 0.01420975)) < 1e-9,
    `★ 净额必须由保留下来的金额重新推出，实际 ${row.net_pnl}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  限价入场转正：已有一行 open 时的合并                                          */
/* -------------------------------------------------------------------------- */

test('★ 已有一行 open 时 promote 必须合并，不能撞唯一索引', () => {
  /*
   * 实测（2026-09-29 00:56 / 01:18 / 01:28，连续三轮）：
   * `UNIQUE constraint failed: positions.trader_id, positions.symbol`
   *
   * 同一个标的**可以**同时存在「对账收养来的 `open` 行」和「还没成交的 `pending` 行」——
   * 收养路径只检查了 `open()`，**没看 pending**。这时把 pending 行改成 open 就会撞上
   * 部分唯一索引 `idx_positions_open_symbol`（`WHERE status = 'open'`）。
   *
   * 而抛出的异常被 `settlePendingEntries()` 的调用方接住、记成「待成交对账失败」——
   * **那行 pending 永远不会消失**：每轮重试、每轮失败，日志一直刷，
   * 那一笔限价入场也永远转不了正。
   *
   * 契约：合并 —— 关掉 pending 残留，把交易所报的成交数据写进已有的 open 行。
   */
  traderId = seedTrader();

  const openId = positionStore.insert({
    traderId,
    symbol: 'BNBUSDT',
    side: 'short',
    quantity: 0.02,
    entryPrice: 760,
    leverage: 3,
    liquidationPrice: null,
    marginUsed: 5,
    stopLoss: 768,
    takeProfit: null,
    stopOrderId: '111',
    tpOrderId: null,
    openReasoning: '对账收养',
  });
  positionStore.insert({
    traderId,
    symbol: 'BNBUSDT',
    side: 'short',
    quantity: 0.02,
    entryPrice: 762,
    leverage: 3,
    liquidationPrice: null,
    marginUsed: 5,
    stopLoss: 768,
    takeProfit: null,
    stopOrderId: null,
    tpOrderId: null,
    openReasoning: '限价挂单',
    status: 'pending',
    entryOrderId: '96307711711',
  });

  const result = positionStore.promote(traderId, 'BNBUSDT', {
    quantity: 0.02,
    entryPrice: 762.2,
    marginUsed: 5.08,
  });

  assert.equal(result.mergedIntoExisting, true, '★ 必须走合并，而不是抛唯一约束错误');
  const open = positionStore.open(traderId);
  assert.equal(open.length, 1, '★ 同一标的只能有一行 open');
  assert.equal(open[0]!.id, openId, '合并写进的是原来那一行（绝不新增）');
  assert.equal(open[0]!.entry_price, 762.2, '★ 用交易所报的成交价覆盖本地记录');
  assert.equal(positionStore.pending(traderId).length, 0, '★ pending 残留必须被关掉');
});

/* -------------------------------------------------------------------------- */
/*  部分平仓累计的量：必须是【毛】                                                */
/* -------------------------------------------------------------------------- */

test('★ 部分平仓累计的是【毛盈亏】—— 拿净额去减整段毛盈亏会把手续费多扣一次', () => {
  /*
   * ## 这个口径错在哪（2026-10-03 审计发现）
   *
   * 「减仓」会当场记一笔（`manual_partial`），并把结果累加到
   * `positions.realized_partial_pnl`。最终平仓时，`bookClose()` 用它去减
   * `findRoundTrip()` 重建出的**整段往返毛盈亏**：
   *
   * ```text
   * 整段往返: 毛 G、开仓费 EF、平仓费 XF
   * 部分平仓: 毛 g、平仓费 xf（已单独记过一行，净 g − xf）
   *
   * 正确:  grossPnl = G − g            （同为【毛】口径）
   * 错误:  grossPnl = G − (g − xf) = (G − g) + xf    ← 毛被高估 xf
   * ```
   *
   * 而 `entryFee`/`exitFee` 那边还传着**整段**的值 —— 于是那部分手续费
   * 在账上出现两次。两处叠加，账目比账户"好看"，正是 §2.5 禁止的方向。
   *
   * 所以这一列**存毛**，而且函数名从 `partialBooked().pnl` 改成
   * `partialBooked().gross` —— 让调用点一眼看出它该配 `grossRaw`。
   */
  traderId = seedTrader();
  const positionId = positionStore.insert({
    traderId,
    symbol: 'PARTUSDT',
    side: 'long',
    quantity: 336,
    entryPrice: 0.104,
    leverage: 5,
    liquidationPrice: null,
    marginUsed: (336 * 0.104) / 5,
    stopLoss: 0.0968,
    takeProfit: 0.113,
    stopOrderId: null,
    tpOrderId: null,
    openReasoning: '测试',
    entryOrderId: 'E-1',
  });

  /* 减掉一半：毛 +1.132320（平仓费 0.009302 那一笔已单独入账）。 */
  positionStore.resize(traderId, 'PARTUSDT', {
    quantity: 168,
    entryPrice: 0.104,
    marginUsed: (168 * 0.104) / 5,
    addRealizedPartialPnl: 1.13232,
    addBookedPartialQty: 168,
  });

  const booked = positionStore.partialBooked(traderId, 'PARTUSDT');
  assert.ok(
    Math.abs(booked.gross - 1.13232) < 1e-12,
    `★ 累计的必须是毛盈亏 1.13232（若这里存的是净额 1.123018，最终平仓就会多扣 0.009302）。实际 ${booked.gross}`,
  );
  assert.equal(booked.qty, 168, '数量也要累加 —— 手续费按它分摊');
  assert.ok(positionId > 0);
});