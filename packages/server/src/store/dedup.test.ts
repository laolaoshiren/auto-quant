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
  strategies,
  traders,
  trades as tradeStore,
} from './repositories.js';

/**
 * 「同一个真实回合在 `trades` 里只能有一行」—— **用交易所的单号来保证**。
 *
 * ## 为什么这个文件存在
 *
 * 用户的原话：「查一下盈亏计算是否正确？归属权益（USDT）和收益，为什么和钱包
 * 实际余额对不上？（当前没有持仓和挂单）」
 *
 * 查下去是**重复记账**：平台记的净额比交易所流水多出 **1.51 USDT**，六组重复，
 * 每一组都是「同一个平仓时刻、同一个入场价、同一个出场价，只是数量不同」，
 * 而每组里都恰好有一笔 `bot`（运行期记的）和一到两笔 `reconciled`（对账重建的）。
 *
 * 根因有两层，两层都在这份用例里钉住：
 *
 *  1. **数量容差（20%）原来写在 WHERE 的最外层**，一票否决了正确的判据 ——
 *     而数量本来就是两条路径之间**最不可靠**的维度（口径不同源）。
 *  2. **确定性键一直躺在表里没人用**：`trades.exit_order_id` 实测 100% 有值，
 *     而一笔平仓在交易所**只有一个** `orderId`。最硬的那对（ZECUSDT `#107`/`#120`）
 *     正因为判据只看启发式、没看单号，才漏到账上。
 *
 * 按 AGENTS.md §3.6：临时目录，绝不碰 `data/`。
 */

let workDir: string;
let traderId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-dedup-'));
  initDb(path.join(workDir, 'dedup.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().run('DELETE FROM trades');
});

function seedTrader(name = 'dedup'): number {
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

/** 直接落一行成交（`idempotent` 默认关闭，所以它**不去重** —— 正是造重复所需）。 */
function book(over: Partial<Parameters<typeof tradeStore.insert>[0]> = {}): number {
  return tradeStore.insert({
    traderId,
    symbol: 'HEDGEUSDT',
    side: 'long',
    quantity: 0.009,
    entryPrice: 1546,
    exitPrice: 1545.08,
    leverage: 5,
    grossPnl: -0.00368,
    entryFee: 0.0012368,
    exitFee: 0.00432696,
    closeReason: 'stop_loss',
    openedAt: '2026-09-22T16:59:47.151Z',
    closedAt: '2026-09-22T17:37:17.018Z',
    source: 'bot',
    exitOrderId: 'SHARED-EXIT-ID',
    ...over,
  }).id;
}

test('★ 共用同一个平仓单号 = 同一个回合，不看数量也不看时间窗', () => {
  /*
   * 实测那一对：ZECUSDT `#107`（0.009）/ `#120`（0.004）共用 `exit_order_id`
   * `807238763718`，却被判成两个回合 —— 因为
   *
   *   · 数量差 0.005，超出 20% 容差（0.009 × 0.2 = 0.0018）；
   *   · 平仓时刻差 6 秒，超出 2 秒窗口。
   *
   * 于是账上多记一笔，**归属权益比钱包高 0.015**。
   * 交易所的单号是**身份**，不是相似度 —— 这一条把那个边界关掉。
   */
  traderId = seedTrader();
  const first = book();
  book({
    quantity: 0.004,
    /* 差 6 秒 —— 刻意落在 2 秒窗口之外，让启发式判据全部落空。 */
    closedAt: '2026-09-22T17:37:11.051Z',
    source: 'reconciled',
  });

  const found = tradeStore.findDuplicate({
    traderId,
    symbol: 'HEDGEUSDT',
    quantity: 0.004,
    entryPrice: 1546,
    exitPrice: 1545.08,
    openedAt: '2026-09-22T16:59:47.151Z',
    closedAt: '2026-09-22T17:37:11.051Z',
    exitOrderId: 'SHARED-EXIT-ID',
  });
  assert.equal(found, first, '单号相同就是同一个回合 —— 必须认出已有的那一行');
});

test('★ 单号还没写上的那几秒：双价 + 开仓时刻必须认出同一回合', () => {
  /*
   * ## 实测事故（用户的原话）
   *
   * 「**我从未停止过机器人运行，为什么会提示机器人未运行时平仓？**」
   *
   * 界面上一笔 HYPEUSDT 被标成「机器人未运行时平仓」，而它其实**正常运行期平掉的**。
   * 库里那两行：
   *
   *     #130 bot         HYPEUSDT 0.21  94.05 → 92.878  opened_at 20:17:37.389  closed_at 21:57:10.512
   *     #131 reconciled  HYPEUSDT 0.14  94.05 → 92.878  opened_at 20:17:32.060  closed_at 21:57:05.073
   *
   * ## 为什么之前的所有判据都落空
   *
   * 三条路依次失败，而每一条都有具体原因：
   *
   *  · **单号**查空 —— 运行期记账那一刻成交明细还没回来，`#130` 的两个订单号
   *    都还是 `null`；它们要到**同一遍对账的"修正"阶段**才被写上去（日志顺序：
   *    21:57:10 记账 → 21:57:11 补录 → 21:57:12 修正完成）。所以补录时按单号
   *    查**必然**查不到；
   *  · **数量**差 33%（0.21 vs 0.14），超出 20% 容差；
   *  · **双价判据**当时挂在 `closed_at` 上、窗口 2 秒 —— 而这两条路径的
   *    `closed_at` 差了 **5.44 秒**（本地时钟 vs 交易所时钟）。
   *
   * 最后一条是**判据挂错了字段**：本项目自己在 `DUPLICATE_OPEN_TOLERANCE_MS`
   * 的注释里就写着「`closed_at` 一条是本地"察觉到仓位消失"的时刻（可能晚一整轮），
   * 另一条是交易所成交记录里的时刻 —— **两个不同的时钟**」。既然知道它会漂，
   * 就不该拿它做 2 秒的判断。
   *
   * `opened_at` 才是同源的（都锚在"这笔仓位什么时候开的"，只隔下单延迟），
   * 它的 5 分钟容差也正是按这个理由定的。
   *
   * 这条用例把当时的真实形状固化下来：**数量差 33%、平仓时刻差 5.4 秒、两个
   * 订单号都为空** —— 靠"双价 + 开仓时刻"照样必须认出是同一回合。
   */
  traderId = seedTrader();
  const first = book({
    symbol: 'HYPEUSDT',
    quantity: 0.21,
    entryPrice: 94.05,
    exitPrice: 92.878,
    openedAt: '2026-09-24T20:17:37.389Z',
    closedAt: '2026-09-24T21:57:10.512Z',
    exitOrderId: null,
    entryOrderId: null,
  });

  const found = tradeStore.findDuplicate({
    traderId,
    symbol: 'HYPEUSDT',
    /* 差 33% —— 刻意越过 20% 的数量容差。 */
    quantity: 0.14,
    entryPrice: 94.05,
    exitPrice: 92.878,
    /* 只差 5.3 秒 —— 落在 `opened_at` 的 5 分钟窗口内。 */
    openedAt: '2026-09-24T20:17:32.060Z',
    /* 差 5.44 秒 —— 刻意越过当时那条 2 秒窗口。 */
    closedAt: '2026-09-24T21:57:05.073Z',
    /* 两个订单号都为空 —— 与运行期记账那一刻的真实状态一致。 */
    exitOrderId: null,
    entryOrderId: null,
  });
  assert.equal(
    found,
    first,
    '双价逐字节相同 + 开仓时刻只差 5 秒 ⇒ 同一回合，必须认出已有那一行（否则界面会显示"机器人未运行时平仓"）',
  );
});

test('★ 存量重复的复核报告也要按单号报出来', () => {
  /*
   * `duplicateSuspects()` 是给操作者复核存量重复用的报告，而它用的是**同一套
   * 容差** —— 所以它既没拦住那一对、也没报出来。这条用例保证下次不会再漏报。
   */
  traderId = seedTrader();
  book();
  book({
    quantity: 0.004,
    closedAt: '2026-09-22T17:37:11.051Z',
    source: 'reconciled',
  });

  const suspects = tradeStore.duplicateSuspects(traderId);
  assert.equal(suspects.length, 1, `必须报出这一对，实际 ${suspects.length} 对`);
});

test('不同单号的两个回合不许被合并 —— 判据不是"永远匹配"', () => {
  /*
   * 反面。没有这一条，把判据改成"只要同标的就算同一个"也能让上面全绿 ——
   * 而那会把两笔**真实**回合并成一笔，比重复更严重（凭空吃掉一笔交易）。
   * 所以这里让两个回合连启发式也区分得开（入场价与出场价都不同）。
   */
  traderId = seedTrader();
  book({ exitOrderId: 'EXIT-A' });
  book({
    exitOrderId: 'EXIT-B',
    quantity: 0.004,
    entryPrice: 1500,
    exitPrice: 1490,
    closedAt: '2026-09-22T17:37:11.051Z',
    source: 'reconciled',
  });

  const found = tradeStore.findDuplicate({
    traderId,
    symbol: 'HEDGEUSDT',
    quantity: 0.004,
    entryPrice: 1500,
    exitPrice: 1490,
    openedAt: '2026-09-22T16:59:47.151Z',
    closedAt: '2026-09-22T17:37:11.051Z',
    exitOrderId: 'EXIT-B',
  });
  const rows = tradeStore.list(traderId, 10);
  assert.equal(rows.length, 2, '前提：两个回合都在账上');
  /*
   * B 是后插的，id 更大。判据必须命中**单号相同的那个**（B）；
   * 如果它退化成"同标的就算同一个"，`ORDER BY id ASC` 会命中 A —— 那就是
   * 把两笔真实回合并成一笔，比重复更严重。
   */
  const bId = Math.max(...rows.map((r) => r.id));
  assert.equal(found, bId, '必须命中单号相同的 B，而不是靠价格/数量猜到的 A');
});

test('★ 一个腿的【任一】出场单号已记账 = 同一段成交，不能再插一行', () => {
  /*
   * ## 用户 2026-10-03 的第二次报告（同一个数字，同一种事故）
   *
   * 他在主账户上新建了机器人 `#10`，页面上「交易盈亏 +1.43」而钱包只少了 0.09 ——
   * **账目虚高 1.52 USDT**。而这份文件开头记着的那次报告，数字是 **1.51**。
   *
   * ## 为什么上一轮的修复没挡住它
   *
   * 上一轮加的是"**平仓单号相同就是同一个回合**"（上面那条用例）—— 那条判据是对的，
   * 但它有一个前提：**两边都拿得到单号**，而且**切法一致**。
   *
   * 这次两条都不成立。真实成交（MANAUSDT）：
   *
   * ```text
   * 04:08:16  BUY  336 @ 0.104          ← 一次开仓 336 张
   * 05:27:06  SELL 168 @ 0.11074  realized=+1.132320   orderId=14043907060
   * 05:35:22  SELL 168 @ 0.10643  realized=+0.408240   orderId=14044221042
   * ```
   *
   *   · **运行期**按**每次平仓**记一笔：`#191`(168, 单号 14043907060)
   *     与 `#192`(168, **单号 null** —— 止损触发，没拿到成交单号)。
   *   · **对账**按**开仓到清仓**合成一个腿：`#193`(336, 单号 = **最后一个** 14044221042)。
   *
   * 于是三条启发式判据全部落空（数量 336 ≠ 168、出场价加权 ≠ 单笔、
   * `closed_at` 差 5 秒超窗口），而"单号相同"也查不到 —— 因为账上那笔的单号是
   * **第一笔**的，而对账只带了**最后一笔**的。
   *
   * ## 这条用例钉住的新判据
   *
   * 一个腿带**全部**出场单号，**任意一个**已在账本里 ⇒ 这段成交已经记过。
   * 这就是"只修正、不重复插入"该有的语义，也是唯一不受"切法"影响的身份。
   */
  traderId = seedTrader();

  /* 运行期：两笔部分平仓。第一笔有单号，第二笔（止损）没拿到 —— 与实盘一模一样。 */
  const first = book({
    quantity: 168,
    entryPrice: 0.104,
    exitPrice: 0.11074,
    grossPnl: 1.13232,
    exitOrderId: '14043907060',
    closeReason: 'manual_partial',
  });
  book({
    quantity: 168,
    entryPrice: 0.104,
    exitPrice: 0.10643,
    grossPnl: 0.40824,
    exitOrderId: null,
    closeReason: 'stop_loss',
    /* 平仓时刻与对账那条差 5 秒 —— 刻意让 2 秒窗口落空。 */
    closedAt: '2026-09-22T17:37:22.018Z',
  });

  /* 对账：把整段看成一个 336 的腿，带两个出场单号。 */
  const found = tradeStore.findDuplicate({
    traderId,
    symbol: 'HEDGEUSDT',
    quantity: 336,
    entryPrice: 0.104,
    exitPrice: 0.108585,
    openedAt: '2026-09-22T16:59:47.151Z',
    closedAt: '2026-09-22T17:37:17.018Z',
    entryOrderId: '14041749974',
    exitOrderId: '14044221042',
    exitOrderIds: ['14043907060', '14044221042'],
  });

  assert.equal(
    found,
    first,
    '★ 336 的腿含 168 那笔的单号 —— 必须判定"这段成交已经记过"，否则账上凭空多出 1.5153',
  );
  assert.equal(tradeStore.list(traderId, 10).length, 2, '前提：运行期那两笔仍在账上');
});

test('没有交集单号时仍然按启发式判断 —— 新判据不能吞掉真实成交', () => {
  /*
   * 反向守卫：新判据必须**只在单号真的相交时**命中。
   * 两个回合各有自己的单号，即便数量/价格巧合也不能被合并 ——
   * 那会把两笔真实成交记成一笔，比重复更严重。
   */
  traderId = seedTrader();
  const a = book({ exitOrderId: 'MANA-A' });
  book({ exitOrderId: 'MANA-B', closedAt: '2026-09-22T17:37:22.018Z' });

  const found = tradeStore.findDuplicate({
    traderId,
    symbol: 'HEDGEUSDT',
    quantity: 336,
    entryPrice: 0.104,
    exitPrice: 0.108585,
    openedAt: '2026-09-22T16:59:47.151Z',
    closedAt: '2026-09-22T18:00:00.000Z',
    exitOrderIds: ['NOT-IN-BOOK-1', 'NOT-IN-BOOK-2'],
  });

  assert.equal(found, null, '单号没有交集、启发式也对不上，必须返回 null 而不是硬凑一个');
  assert.notEqual(found, a);
});
