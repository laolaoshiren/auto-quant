/**
 * **按成交 id 归属已实现盈亏**（2026-10-15 实盘账目差 12.61 的修复）
 *
 * ## 事故
 *
 * `#10` 实盘（本金 100.05）：
 * ```
 *   platformNet  +5.657252     ← 平台账本
 *   exchangeNet  -6.956285     ← 交易所流水
 *   gap          12.613538     ← 差 12.6（本金才 100）
 *
 *   逐项：reconciled_reversed 38 笔 · 净 +13.0577   ← 与 gap 量级吻合
 *   platformSelf − reversedNet = -7.4004（与交易所只差 0.44，差两个数量级）
 *   ⇒ 那 12.6 几乎全部来自这一类
 * ```
 *
 * ## 根因
 *
 * 金额原来取自 `realizedInWindow(events, symbol, openedAt, closedAt)`
 * —— 按**标的 + 时间窗口**。而这些回合的窗口**平均 23.1 小时、最大 159.3 小时**
 *（其他平仓类只有 2–3 小时），因为方向判错时 `openedAt` 取自一笔"其实是平仓"的成交，
 * 窗口就此跨到别的回合里。实测有 **12 个真实回合完全落在别的回合窗口内部**。
 *
 * ## 修法
 *
 * `income` 的 `REALIZED_PNL` 带 `tradeId`，而它**等于**成交的 `id` ——
 * 实盘实测 `NEARUSDT`：19 条 `REALIZED_PNL` 与 33 笔成交，**19/19 全部对上**。
 * 所以改为按 `closeFillIds` 精确归属，与手续费那侧"按单号而不是按标的"同源。
 *
 * ⚠️ 用 `closeFillIds` 而不是 `fillIds`：穿过零的翻转成交同时属于两个回合，
 * 而 `realizedPnl` 只属于平腿那一侧。用 `fillIds` 会重复计入。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { realizedInFills } from './income.js';
import { reconstructRoundTrips } from '../trader/roundTrips.js';
import type { BinanceIncome, BinanceUserTrade } from './types.js';

/** 一条 `REALIZED_PNL` 流水。 */
function pnl(tradeId: string, time: number, income: number, symbol = 'AAAUSDT'): BinanceIncome {
  return {
    symbol,
    incomeType: 'REALIZED_PNL',
    income: String(income),
    asset: 'USDT',
    time,
    info: '',
    tranId: Number(tradeId),
    tradeId,
  } as BinanceIncome;
}

/** 一笔成交。 */
function fill(
  id: number,
  time: number,
  side: 'BUY' | 'SELL',
  qty: number,
  price: number,
  realizedPnl = 0,
  symbol = 'AAAUSDT',
): BinanceUserTrade {
  return {
    id,
    orderId: id * 10,
    symbol,
    side,
    qty: String(qty),
    price: String(price),
    realizedPnl: String(realizedPnl),
    commission: '0',
    commissionAsset: 'USDT',
    time,
  } as unknown as BinanceUserTrade;
}

test('★★★ 按成交 id 归属：只算属于这个回合的那些', () => {
  /*
   * 场景：三笔 `REALIZED_PNL`，本回合只占其中两笔。
   * 按窗口归属会把第三笔（别人的）也算进来 —— 那正是 12.6 差额的成因。
   */
  const events = [pnl('101', 1000, 1.5), pnl('102', 2000, -0.5), pnl('999', 2500, 8.8)];
  const mine = realizedInFills(events, ['101', '102']);
  assert.equal(mine, 1.0, '★ 只算 101 + 102 = 1.5 − 0.5，不含别人的 999');
});

test('★★★ 不属于本回合的一律不算（哪怕时间落在窗口内）', () => {
  const events = [pnl('999', 1000, 8.8)];
  assert.equal(realizedInFills(events, ['101', '102']), 0, '★ id 对不上就是 0');
});

test('★★★ 非 REALIZED_PNL 的流水不算（手续费/资金费各走各的路径）', () => {
  const events: BinanceIncome[] = [
    pnl('101', 1000, 1.0),
    { symbol: 'AAAUSDT', incomeType: 'COMMISSION', income: '-0.1', asset: 'USDT', time: 1001, info: '', tranId: 1, tradeId: '101' } as BinanceIncome,
    { symbol: 'AAAUSDT', incomeType: 'FUNDING_FEE', income: '-0.2', asset: 'USDT', time: 1002, info: '', tranId: 2, tradeId: '101' } as BinanceIncome,
  ];
  assert.equal(realizedInFills(events, ['101']), 1.0, '★ 只取 REALIZED_PNL');
});

test('★★ 空 id 列表返回 0（不是"全都算"）', () => {
  const events = [pnl('101', 1000, 5)];
  assert.equal(realizedInFills(events, []), 0, '★ 没有 id 就是 0，绝不能退化成"全算"');
});

test('★★★ 重建出的回合必须带上成交 id（否则修法无从落地）', () => {
  /*
   * 一个完整的回合：开 3 @ 100、平 3 @ 102（profit 6）。
   */
  const fills = [fill(1, 1000, 'BUY', 3, 100), fill(2, 2000, 'SELL', 3, 102, 6)];
  const trips = reconstructRoundTrips(fills);
  assert.equal(trips.length, 1, '★ 应当合成 1 个回合');
  const t = trips[0]!;
  assert.deepEqual(t.fillIds, ['1', '2'], '★ 两笔成交的 id 都要在');
  assert.deepEqual(t.openFillIds, ['1'], '★ 开腿是第 1 笔');
  assert.deepEqual(t.closeFillIds, ['2'], '★ 平腿是第 2 笔（只有它能算 realizedPnl）');
});

test('★★★ 翻转成交同时属于两个腿时，同一笔盈亏只算一次（靠 claimed 去重）', () => {
  /*
   * ## 为什么这条最重要
   *
   * 一笔"平掉旧仓 + 开出新仓"的成交会同时出现在旧回合的 `closeFillIds`
   * 与新回合的 `openFillIds` 里，因此也同时出现在两个回合的 `fillIds` 里。
   * 而反向回合（`reconciled_reversed`）必须按 `fillIds` 归属 —— 于是同一个
   * 成交 id 会被两个回合各认领一次，**同一笔盈亏入账两次**。
   *
   * 那正是"账本比交易所高 12.61"的成因形状，所以去重不是优化，是正确性前提。
   *
   * 实测对照：正确答案 14；不去重会得到 24。
   */
  const events = [pnl('2', 2000, 10), pnl('3', 3000, 4)];

  /* ❌ 不传 claimed：两个回合各算一次 → 重复。 */
  const firstNoClaim = realizedInFills(events, ['1', '2']);
  const secondNoClaim = realizedInFills(events, ['2', '3']);
  assert.equal(firstNoClaim, 10);
  assert.equal(secondNoClaim, 14, '★ 不去重时第二个回合把 #2 又算了一遍');
  assert.equal(
    firstNoClaim + secondNoClaim,
    24,
    '★ 不去重的结果偏大（24 vs 正确 14）—— 这就是账本虚增的形状',
  );

  /* ✅ 传同一个 claimed：第二笔在第一次已被认领，不再重复。 */
  const claimed = new Set<string>();
  const first = realizedInFills(events, ['1', '2'], claimed);
  const second = realizedInFills(events, ['2', '3'], claimed);
  assert.equal(first, 10, '★ 第一个回合认领 #2');
  assert.equal(second, 4, '★ 第二个回合只剩 #3（#2 已被认领）');
  assert.equal(first + second, 14, '★ 合计正好是交易所的全部已实现盈亏');
});

test('★★★ 一趟下来所有回合的合计恰好等于流水的总和（不重不漏）', () => {
  /*
   * 这是账本能与交易所对平的**充要条件**：每个回合各认领自己那部分，
   * 合起来 = 流水的全部。多算（重复）或少算（漏）都会让 gap 偏离 0。
   */
  const events = [pnl('1', 1000, 1.5), pnl('2', 2000, 10), pnl('3', 3000, 4)];
  const claimed = new Set<string>();
  const trips = [['1', '2'], ['2', '3'], ['3']];
  const total = trips.reduce((sum, ids) => sum + realizedInFills(events, ids, claimed), 0);
  const expected = 1.5 + 10 + 4;
  assert.equal(total, expected, `★ 合计 ${total} 必须等于流水总和 ${expected}`);
});

test('★★ 重建出的回合：穿零翻转时两个腿共用那个成交 id', () => {
  /*
   * ⚠️ 这条钉的是**身份共用**这件事本身 —— 它是上面"必须去重"的前提。
   * 若哪天重建改成"翻转成交只归一个腿"，那去重就是多余的（但留着无害）；
   * 而反过来（若它开始把同一笔塞进更多腿），去重仍然是必需的安全网。
   */
  const fills = [
    fill(1, 1000, 'BUY', 2, 100),
    fill(2, 2000, 'SELL', 4, 105, 10),
    fill(3, 3000, 'BUY', 2, 103, 4),
  ];
  const trips = reconstructRoundTrips(fills);
  assert.equal(trips.length, 2, '★ 翻转应当分出两个回合');
  assert.ok(trips[0]!.fillIds.includes('2'), '★ 旧回合含第 2 笔');
  assert.ok(trips[1]!.fillIds.includes('2'), '★ 新回合也含第 2 笔（身份共用）');
  assert.ok(trips[0]!.closeFillIds.includes('2'), '★ 作为平腿它属于旧回合');
  assert.ok(!trips[1]!.closeFillIds.includes('2'), '★ 它不是新回合的平腿');
});
