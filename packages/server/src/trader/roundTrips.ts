/**
 * Rebuild closed round-trips from the exchange's own fill history.
 *
 * ## Why this exists
 *
 * The runtime used to learn about a close only when it was *alive* to see it:
 * either it placed the closing order itself, or the next cycle noticed the
 * position had vanished. Both paths require a running cycle, so a position whose
 * exchange-side take profit fired while the bot was stopped was never recorded —
 * and the console's numbers silently diverged from the account.
 *
 * Observed on a live account: POWERUSDT round-tripped 131 contracts for
 * **+0.6563**, and the console had no record of it at all. It reported −0.3136
 * realised on an account that was actually **+0.2586** — wrong sign, wrong
 * magnitude, on a 10 USDT balance.
 *
 * `/fapi/v1/userTrades` is the authoritative record. Reconstructing round-trips
 * from it means the platform's history converges on the exchange's regardless of
 * whether the process was running at the moment of the fill.
 *
 * ## Account model
 *
 * The account is in **one-way mode** (the runtime enforces this), so `positionSide`
 * is `BOTH` and the direction is inferred from the running position. A fill that
 * increases `|position|` opens or adds; one that decreases it closes. Both sides
 * of a round-trip are accumulated so the fee is the **true total**, not just the
 * exit leg — the previous implementation recorded only the exit commission and
 * under-reported costs by roughly half.
 */
import type { BinanceUserTrade } from '../binance/types.js';

export interface ReconstructedTrade {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  /** Volume-weighted entry price across every opening fill. */
  entryPrice: number;
  /** Volume-weighted exit price across every closing fill. */
  exitPrice: number;
  /**
   * Gross PnL, summed from the exchange's own `realizedPnl` per fill.
   *
   * Deliberately not recomputed from `(exit − entry) × qty`: the exchange's
   * number already accounts for contract-specific value rules, and using it
   * removes an entire class of rounding disagreement between the console and
   * the account.
   */
  grossPnl: number;
  /** Commission across **both** legs. */
  fee: number;
  /** Opening-leg commission alone. */
  entryFee: number;
  /** Closing-leg commission alone. */
  exitFee: number;
  /**
   * Commission charged in an asset other than the settlement asset (a BNB fee
   * discount, for example). Not added to `fee`, because it is not denominated in
   * the same unit — reported so the caller can surface it instead of quietly
   * understating costs.
   */
  foreignFees: Array<{ asset: string; amount: number }>;
  openedAt: string;
  closedAt: string;
  holdMinutes: number;
  entryOrderId: string;
  /**
   * 最后一个出场成交的交易所单号（历史字段，保留给旧调用方）。
   *
   * ⚠️ **它不足以判重** —— 一个回合可以有**多次**部分平仓，而这个字段只留最后一次。
   * 见 `exitOrderIds`。
   */
  exitOrderId: string;
  /**
   * **这个回合里的每一个出场成交单号**（按时间顺序，含部分平仓）。
   *
   * ## 为什么必须有它（2026-10-03 实盘事故）
   *
   * 用户在主账户上跑 `#10`，账目虚高 **1.52 USDT**。定位到一笔重复：
   *
   * ```text
   * 交易所真实成交（MANAUSDT）:
   *   04:08:16  BUY  336 @ 0.104          ← 一次开仓 336 张
   *   05:27:06  SELL 168 @ 0.11074  realized=+1.132320
   *   05:35:22  SELL 168 @ 0.10643  realized=+0.408240
   *
   * 运行期记了两笔（每次平仓一笔）:
   *   #191 qty=168 pnl=1.132320 exit_order_id=14043907060
   *   #192 qty=168 pnl=0.408240 exit_order_id=null      ← 止损触发，没拿到单号
   *
   * 对账又记了一笔（把整段看成"一个 336 的回合"）:
   *   #193 qty=336 pnl=1.540560 = #191.pnl + #192.pnl   ← 凭空多出来的
   * ```
   *
   * 三条判据全部落空：数量 `336 ≠ 168`、出场价不同（加权 vs 单笔）、
   * `closed_at` 差 5 秒（超出 2 秒窗口），而 `#192` 的 `exit_order_id` 是 null，
   * 所以"单号相同就是同一回合"那条确定性判据**也查不到**。
   *
   * **根因是两条路对同一段成交的"切法"不同**：
   *
   *   · 运行期按**每次平仓**记一笔（本地持仓行消失一次就记一次）；
   *   · `reconstructRoundTrips` 按**开仓到清仓**合成一个腿（只有仓位归零才 finalize）。
   *
   * 而**成交单号是唯一不受"切法"影响的身份**：336 的回合含两个出场单号，
   * 其中任何一个出现在账本里，就说明这段成交已经被记过。
   */
  exitOrderIds: string[];
  /** Number of exchange fills that made up the round-trip. */
  fillCount: number;
  /**
   * **这个回合里每一笔成交的成交 id**（`BinanceUserTrade.id`）。
   *
   * ## 为什么需要它（2026-10-15 实盘账目差 12.61 的根因）
   *
   * `income` 流水的 `REALIZED_PNL` 事件带 `tradeId`，而它**等于**成交的 `id`
   *（实测 `NEARUSDT`：19 条 `REALIZED_PNL` 与 33 笔成交里，**19/19 全部对上**）。
   *
   * 所以"这一笔已实现盈亏属于哪个回合"有一个**精确**答案：看它的 `tradeId`
   * 在不在这段成交里。此前用的是「**按标的 + 时间窗口**」聚合
   *（`realizedInWindow(events, symbol, openedAt, closedAt)`），而那对
   * `reconciled_reversed` 这种**方向重建错了的回合**完全失效：
   *
   * ```
   *   ADAUSDT #344 reconciled_reversed 的窗口 10-06T15:53 → 10-10T17:07（97 小时）
   *   而 #250 stop_loss / #281~283 manual_partial / #288 drawdown_guard
   *   全都落在这个窗口【内部】—— 它们的已实现盈亏被这个窗口又聚合了一遍，
   *   而它们各自已经作为独立的 trades 记过账。
   *   ⇒ platformSelf 虚增 13.06，正好是「账本 +5.66 vs 交易所 −6.96」那个差额。
   * ```
   * 实测那 38 个回合的窗口**平均 23.1 小时、最大 159.3 小时**（其他类只有 2–3 小时）。
   *
   * ⚠️ 代码里**已有这条纪律的先例**（`autoTrader.ts` 讲手续费）：
   * > 「传**入场订单号**而不是标的：同一标的反复开平时，按标的过滤会把历史回合的
   * >  入场费再加一遍（那些回合已经在 platformSelf 里了）。」
   *
   * 手续费那侧早就按单号修了，**盈亏那侧还是"按标的"**。这里补上。
   */
  fillIds: string[];
  /**
   * **开腿**那一组的成交 id（判断"这一笔成交是开还是平"用）。
   *
   * ⚠️ 对**方向重建错了**的回合，这个分组本身也是错的 —— 但**归属**不受影响：
   * 只要"这些成交 id 里没有别人"，按 `fillIds` 过滤就是精确的。
   */
  openFillIds: string[];
  /** **平腿**那一组的成交 id。 */
  closeFillIds: string[];
}

const EPSILON = 1e-12;

interface OpenLeg {
  symbol: string;
  side: 'long' | 'short';
  /** Signed position carried while this leg is open. */
  signedPosition: number;
  entryQty: number;
  entryNotional: number;
  exitQty: number;
  exitNotional: number;
  grossPnl: number;
  fee: number;
  entryFee: number;
  foreignFees: Map<string, number>;
  openedAt: number;
  firstEntryOrderId: string | null;
  lastExitOrderId: string | null;
  /**
   * 这个腿里**每一个**出场成交的交易所单号（含部分平仓）—— 判重用，见
   * `ReconstructedTrade.exitOrderIds` 的说明。
   */
  exitOrderIds: string[];
  fillCount: number;
  /** 这个腿里每一笔成交的成交 id（见 `ReconstructedTrade.fillIds`）。 */
  fillIds: string[];
  /** 开腿的成交 id。 */
  openFillIds: string[];
  /** 平腿的成交 id。 */
  closeFillIds: string[];
}

/**
 * Turn a chronological fill list into closed round-trips.
 *
 * Fills that do not return the position to zero are simply left out — an open
 * position has no realised PnL yet, and inventing one would be worse than
 * reporting nothing.
 */
export function reconstructRoundTrips(
  fills: readonly BinanceUserTrade[],
  settlementAsset = 'USDT',
): ReconstructedTrade[] {
  const ordered = [...fills].sort((a, b) => (a.time - b.time) || (a.id - b.id));

  const trades: ReconstructedTrade[] = [];
  let leg: OpenLeg | null = null;
  let position = 0;

  const finalize = (current: OpenLeg, closedAt: number): void => {
    const entryPrice = current.entryQty > 0 ? current.entryNotional / current.entryQty : 0;
    const exitPrice = current.exitQty > 0 ? current.exitNotional / current.exitQty : 0;
    trades.push({
      symbol: current.symbol,
      side: current.side,
      // The exchanged quantity: how much was opened (and closed — one-way mode
      // means the two match for a completed round-trip).
      quantity: Number(current.entryQty.toFixed(12)),
      entryPrice: Number(entryPrice.toFixed(12)),
      exitPrice: Number(exitPrice.toFixed(12)),
      grossPnl: Number(current.grossPnl.toFixed(12)),
      fee: Number(current.fee.toFixed(12)),
      entryFee: Number(current.entryFee.toFixed(12)),
      exitFee: Number((current.fee - current.entryFee).toFixed(12)),
      foreignFees: [...current.foreignFees.entries()].map(([asset, amount]) => ({
        asset,
        amount: Number(amount.toFixed(12)),
      })),
      openedAt: new Date(current.openedAt).toISOString(),
      closedAt: new Date(closedAt).toISOString(),
      holdMinutes: Math.max(0, (closedAt - current.openedAt) / 60_000),
      entryOrderId: current.firstEntryOrderId ?? '',
      exitOrderId: current.lastExitOrderId ?? '',
      exitOrderIds: [...current.exitOrderIds],
      fillCount: current.fillCount,
      fillIds: [...current.fillIds],
      openFillIds: [...current.openFillIds],
      closeFillIds: [...current.closeFillIds],
    });
  };

  for (const fill of ordered) {
    const qty = Number(fill.qty);
    if (!(qty > 0)) continue;
    const signed = fill.side === 'BUY' ? qty : -qty;
    const price = Number(fill.price);
    const commission = Number(fill.commission) || 0;

    /* ---- Open a new leg when flat ------------------------------------- */
    if (Math.abs(position) < EPSILON) {
      leg = {
        symbol: fill.symbol,
        side: signed > 0 ? 'long' : 'short',
        signedPosition: 0,
        entryQty: 0,
        entryNotional: 0,
        exitQty: 0,
        exitNotional: 0,
        grossPnl: 0,
        fee: 0,
        entryFee: 0,
        foreignFees: new Map(),
        openedAt: fill.time,
        firstEntryOrderId: String(fill.orderId),
        lastExitOrderId: null,
        exitOrderIds: [],
        fillCount: 0,
        fillIds: [],
        openFillIds: [],
        closeFillIds: [],
      };
      position = signed;
      leg.signedPosition = position;
      leg.entryQty += qty;
      leg.entryNotional += price * qty;
      leg.fillCount += 1;
      leg.fillIds.push(String(fill.id));
      leg.openFillIds.push(String(fill.id));
      addCommission(leg, commission, fill.commissionAsset, settlementAsset, true);
      continue;
    }

    if (!leg) continue; // defensive: position non-zero with no leg cannot happen

    const sameDirection = Math.sign(position) === Math.sign(signed);
    if (sameDirection) {
      // Adding to the position: the entry average moves.
      position += signed;
      leg.signedPosition = position;
      leg.entryQty += qty;
      leg.entryNotional += price * qty;
      leg.fillCount += 1;
      leg.fillIds.push(String(fill.id));
      leg.openFillIds.push(String(fill.id));
      addCommission(leg, commission, fill.commissionAsset, settlementAsset, true);
      continue;
    }

    /* ---- Closing (possibly partially) --------------------------------- */
    const closing = Math.min(qty, Math.abs(position));
    const next = position + signed;

    leg.exitQty += closing;
    leg.exitNotional += price * closing;
    leg.grossPnl += Number(fill.realizedPnl) || 0;
    leg.lastExitOrderId = String(fill.orderId);
    /* 每一次出场都记下单号（含部分平仓）—— 判重靠的是这组身份。 */
    leg.exitOrderIds.push(String(fill.orderId));
    leg.fillCount += 1;
    /*
     * ⚠️ 成交 id 也要记：`income` 的 `REALIZED_PNL` 靠它精确归属
     *（见 `ReconstructedTrade.fillIds`）。**即使这个回合的方向是错的**，
     * 这组 id 仍然是"这段成交"的精确身份 —— 归属不依赖方向判断。
     */
    leg.fillIds.push(String(fill.id));
    leg.closeFillIds.push(String(fill.id));
    // The exchange reports commission for the whole fill; when a fill both
    // closes and flips, the closing part is what belongs to this leg.
    addCommission(leg, commission * (closing / qty), fill.commissionAsset, settlementAsset, false);

    position = next;
    if (Math.abs(position) < EPSILON) {
      position = 0;
      finalize(leg, fill.time);
      leg = null;
    } else if (Math.sign(position) !== Math.sign(next - signed) && Math.abs(next) > EPSILON) {
      // Flipped through zero: close this leg and open the remainder as a new one.
      finalize(leg, fill.time);
      const remainderQty = Math.abs(next);
      leg = {
        symbol: fill.symbol,
        side: next > 0 ? 'long' : 'short',
        signedPosition: next,
        entryQty: remainderQty,
        entryNotional: price * remainderQty,
        exitQty: 0,
        exitNotional: 0,
        grossPnl: 0,
        fee: 0,
        entryFee: 0,
        foreignFees: new Map(),
        openedAt: fill.time,
        firstEntryOrderId: String(fill.orderId),
        lastExitOrderId: null,
        exitOrderIds: [],
        fillCount: 1,
        fillIds: [String(fill.id)],
        /*
         * 翻转后的剩余那部分，它的成交 id **同时**属于旧腿（作为平腿）与新腿
         *（作为开腿）—— 这是同一笔成交被两个腿共用。金额归属时按 id 取，
         * 所以这里两边都记是**正确**的（`realizedInFills` 按 id 过滤，
         * 不会因为被两个腿引用就重复计入 `platformSelf`）。
         */
        openFillIds: [String(fill.id)],
        closeFillIds: [],
      };
      addCommission(leg, commission * (remainderQty / qty), fill.commissionAsset, settlementAsset, true);
    }
  }

  return trades;
}

function addCommission(
  leg: OpenLeg,
  amount: number,
  asset: string,
  settlementAsset: string,
  isEntry: boolean,
): void {
  if (!(amount > 0)) return;
  if (!asset || asset === settlementAsset) {
    leg.fee += amount;
    if (isEntry) leg.entryFee += amount;
    return;
  }
  leg.foreignFees.set(asset, (leg.foreignFees.get(asset) ?? 0) + amount);
}

/* -------------------------------------------------------------------------- */
/*  Matching against locally-recorded trades                                   */
/* -------------------------------------------------------------------------- */

/**
 * A key that identifies the same round-trip in both the local book and the
 * exchange's reconstruction.
 *
 * **The entries' order id is the discriminator**, with symbol + quantity +
 * entry price as the description.
 *
 * Symbol/quantity/price alone is not unique, and the collision is not
 * theoretical: an account that opens the same size at the same price twice —
 * a retry after a stop, or two round-trips inside one 5-minute candle on a
 * low-priced altcoin — produced two identical keys. `applyExchangeFigures`
 * matches on this key, so the exchange's figures for the *second* round-trip
 * were written over the *first* row: one trade's PnL silently replaced
 * another's, and the console disagreed with the account while looking
 * perfectly well-formed.
 *
 * Timestamps are still deliberately *not* part of the key — the local
 * `closed_at` is when the runtime noticed, while the exchange's is when the
 * fill happened, and those can differ by minutes, so a timestamp would stop
 * the same round-trip from ever matching itself.
 */

/** Strict key: identifies one specific entry order's round-trip. */
export function roundTripKey(input: {
  symbol: string;
  quantity: number;
  entryPrice: number;
  /** The exchange order that opened the position. Required for a strict key. */
  entryOrderId?: string | null;
}): string {
  const qty = Number(input.quantity).toFixed(8);
  // 6 significant digits on price: enough to separate distinct entries on the
  // same symbol, loose enough to survive float noise from an average.
  const price = Number(input.entryPrice).toPrecision(6);
  // `~` cannot be produced by `String(orderId)`, so a row with no recorded entry
  // order can never accidentally collide with a real order's key.
  const owner = input.entryOrderId ? String(input.entryOrderId) : '~';
  return `${input.symbol}|${qty}|${price}|${owner}`;
}

/**
 * The key without the order-id component, for **fallback** matching only.
 *
 * Used when the local row has no `entry_order_id` (the fills were unreadable at
 * close time, so the id could not be learned) while the exchange's
 * reconstruction has one. Without this fallback the reconcile pass would insert
 * a *second* row for a round-trip it already booked — duplicating the PnL
 * instead of correcting it, which is worse than the collision this key change
 * fixes.
 */
export function roundTripQueryKey(input: {
  symbol: string;
  quantity: number;
  entryPrice: number;
}): string {
  return roundTripKey({ ...input, entryOrderId: null });
}
