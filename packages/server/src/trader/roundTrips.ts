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
  exitOrderId: string;
  /** Number of exchange fills that made up the round-trip. */
  fillCount: number;
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
  fillCount: number;
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
      fillCount: current.fillCount,
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
        fillCount: 0,
      };
      position = signed;
      leg.signedPosition = position;
      leg.entryQty += qty;
      leg.entryNotional += price * qty;
      leg.fillCount += 1;
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
    leg.fillCount += 1;
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
        fillCount: 1,
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
 * Symbol plus quantity plus entry price, rounded to a sane tolerance. Entry
 * price is the useful discriminator: the same symbol rarely round-trips the same
 * size at the same price twice. Timestamps are deliberately *not* part of the
 * key — the local `closed_at` is when the runtime noticed, while the exchange's
 * is when the fill happened, and those can differ by minutes.
 */
export function roundTripKey(input: {
  symbol: string;
  quantity: number;
  entryPrice: number;
}): string {
  const qty = Number(input.quantity).toFixed(8);
  // 6 significant digits on price: enough to separate distinct entries on the
  // same symbol, loose enough to survive float noise from an average.
  const price = Number(input.entryPrice).toPrecision(6);
  return `${input.symbol}|${qty}|${price}`;
}
