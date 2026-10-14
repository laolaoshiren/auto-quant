/**
 * **穿零翻转（反手）必须被正确重建**（外部 issue #128 —— 结论：**不属实**）。
 *
 * ## 为什么留这个测试
 *
 * issue #128 断言 `roundTrips.ts` 里那条翻转分支「**条件恒为 false**」：
 *
 * ```ts
 * const next = position + signed;   // 235
 * …
 * position = next;                  // 248  ← ⚠️ 这一行在条件之前
 * if (Math.abs(position) < EPSILON) { … }
 * else if (Math.sign(position) !== Math.sign(next - signed) && …) { … }
 * ```
 *
 * 作者的推导是「`next - signed === position` ⇒ 化简成 `sign(position) !== sign(position)`
 * ⇒ 恒 false」。**前半段成立，后半段不成立** —— 因为 `248` 行已经把
 * `position` 赋成了 `next`，所以条件实际是：
 *
 * ```
 *   Math.sign(next) !== Math.sign(next - signed)
 *   = sign(翻转后的仓位) !== sign(翻转前的仓位)
 * ```
 *
 * **那正是"翻转"的定义**。它不是恒 false，而是这条分支唯一的判据。
 *
 * ## 我做的对照实验（本测试把它固化下来）
 *
 * ```
 *   真实代码                 → 2 个回合（long 1.0 已平 + short 0.6 已平）
 *   把条件改成 `false`        → 1 个回合，且数量/价格都错（exit=2081.25）
 * ```
 *
 * 后者证明**这个条件是有承载的**（load-bearing），而不是可有可无的死代码。
 *
 * ## 另一个容易误读的点：反手后"开着"的那一半不输出
 *
 * `reconstructRoundTrips` 的文档（`roundTrips.ts:140`）写得很清楚：
 *
 * > Fills that do not return the position to zero are simply left out —
 * > an open position has no realised PnL yet
 *
 * 所以「多 1.0 → 卖 1.6」这个序列只输出 **1 个回合**（那条已平的 long），
 * 反手的 0.6 空头**没有被丢掉** —— 它是"尚未实现盈亏的未平仓腿"，
 * 按设计不进入回合列表。原 issue 把这一点读成了"数量凭空消失"。
 * 本文件最后一条用例专门钉住这个区别。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { reconstructRoundTrips } from './roundTrips.js';

const T = 1_700_000_000_000;

/** 一笔成交（形状与交易所 `userTrades` 一致：数量/价格是字符串）。 */
function fill(
  id: number,
  side: 'BUY' | 'SELL',
  qty: number,
  price: number,
  timeOffsetMs: number,
  orderId = 100,
): {
  id: number;
  orderId: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: string;
  qty: string;
  realizedPnl: string;
  commission: string;
  commissionAsset: string;
  time: number;
} {
  return {
    id,
    orderId,
    symbol: 'ETHUSDT',
    side,
    price: String(price),
    qty: String(qty),
    realizedPnl: '0',
    commission: '0',
    commissionAsset: 'USDT',
    time: T + timeOffsetMs,
  };
}

test('★★★ 穿零翻转：反手那一半必须成为一个独立回合（条件不是死代码）', () => {
  /*
   * 序列：多 1.0 → 卖 1.6（平掉 1.0 的多、反手开 0.6 的空）→ 买 0.6 平掉。
   *
   * ⚠️ 这条用例的关键在于**最后那笔平仓**：只有它存在时反手的腿才会收尾、
   * 才会被输出。少了它，反手的 0.6 是"未平仓腿"，按设计不出现在回合列表里
   *（见本文件头部第二段说明）。
   */
  const trips = reconstructRoundTrips([
    fill(1, 'BUY', 1.0, 2000, 0, 101),
    fill(2, 'SELL', 1.6, 2100, 60_000, 102),
    fill(3, 'BUY', 0.6, 2050, 120_000, 103),
  ] as never);

  assert.equal(
    trips.length,
    2,
    '★★★ 反手必须产出【两个】回合 —— 把翻转条件改成 `false` 会只剩 1 个（我实测过），' +
      '那正是这条分支在起作用的证据（issue #128 断言它恒为 false，不成立）',
  );

  const long = trips.find((t) => t.side === 'long');
  const short = trips.find((t) => t.side === 'short');
  assert.ok(long, '★ 应当有那条被平掉的多头');
  assert.ok(short, '★★★ 反手开出的空头必须存在 —— 它曾经被读成"数量凭空消失"');

  /* 数量：多 1.0、空 0.6（不是 1.6、也不是 0）。 */
  assert.equal(long.quantity, 1, '★ 多头回合的数量是 1.0');
  assert.equal(short.quantity, 0.6, '★★★ 反手空头的数量必须是【超出部分】0.6，不是整笔 1.6');

  /* 价格：多头的出场价 = 卖出价；空头的入场价也是那个价（同一笔成交的两面）。 */
  assert.equal(long.entryPrice, 2000, '★ 多头入场价');
  assert.equal(long.exitPrice, 2100, '★ 多头出场价 = 那笔卖出的价');
  assert.equal(short.entryPrice, 2100, '★★ 空头的入场价也必须是 2100（同一笔成交开了它）');
  assert.equal(short.exitPrice, 2050, '★ 空头出场价 = 最后那笔买入价');
});

test('★★ 只有"持仓回到零"的腿才进入回合列表 —— 未平仓腿不输出（设计如此）', () => {
  /*
   * ⚠️ 这条钉住上面那个**容易误读**的点：issue #128 把"反手后只剩一个回合"
   * 读成了"数量丢失"。而 `roundTrips.ts:140` 的文档明确说未回零的成交不输出
   *（"an open position has no realised PnL yet"）。
   *
   * 所以这里断言：**少一笔平仓 → 回合数少一个**，这是设计，不是漏记。
   */
  const withoutClosing = reconstructRoundTrips([
    fill(1, 'BUY', 1.0, 2000, 0, 101),
    fill(2, 'SELL', 1.6, 2100, 60_000, 102),
  ] as never);

  assert.equal(
    withoutClosing.length,
    1,
    '★ 未平仓的反手腿不进回合列表（设计）—— 加上最后一笔平仓就会变成 2 个',
  );
  assert.equal(withoutClosing[0]!.side, 'long', '★ 只有那条已平的多头被输出');
});
