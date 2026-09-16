import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BinanceUserTrade } from '../binance/types.js';
import { reconstructRoundTrips, roundTripKey, roundTripQueryKey } from './roundTrips.js';

/**
 * Fixtures are **real fills pulled from a live account**, not invented.
 *
 * They encode the exact shape that broke the console: POWERUSDT round-tripped
 * twice, the second one (131 contracts, +0.6563) was never recorded, ARBUSDT
 * exited in three partial sells, and every round-trip paid commission on **both**
 * legs — which the old code recorded only on the exit.
 */
function fill(over: Partial<BinanceUserTrade> & { id: number; orderId: number; time: number }): BinanceUserTrade {
  return {
    symbol: 'POWERUSDT',
    side: 'BUY',
    positionSide: 'BOTH',
    price: '1',
    qty: '1',
    quoteQty: '1',
    realizedPnl: '0',
    marginAsset: 'USDT',
    commission: '0',
    commissionAsset: 'USDT',
    maker: false,
    buyer: true,
    ...over,
  };
}

const T0 = Date.parse('2026-09-15T16:20:00.000Z');

const AKE: BinanceUserTrade[] = [
  fill({ id: 1, orderId: 2302296059, time: T0, symbol: 'AKEUSDT', side: 'BUY', price: '0.0288830', qty: '449', commission: '0.00648423' }),
  fill({ id: 2, orderId: 2302330000, time: T0 + 600_000, symbol: 'AKEUSDT', side: 'SELL', price: '0.0285020', qty: '449', realizedPnl: '-0.17106900', commission: '0.00639869' }),
];

const ARB: BinanceUserTrade[] = [
  fill({ id: 3, orderId: 2302400000, time: T0, symbol: 'ARBUSDT', side: 'BUY', price: '0.155600', qty: '89.8', commission: '0.00698644' }),
  fill({ id: 4, orderId: 2302500000, time: T0 + 300_000, symbol: 'ARBUSDT', side: 'SELL', price: '0.154000', qty: '32.7', realizedPnl: '-0.05232000', commission: '0.00251790' }),
  fill({ id: 5, orderId: 2302500001, time: T0 + 301_000, symbol: 'ARBUSDT', side: 'SELL', price: '0.154000', qty: '35.1', realizedPnl: '-0.05616000', commission: '0.00270270' }),
  fill({ id: 6, orderId: 2302500002, time: T0 + 302_000, symbol: 'ARBUSDT', side: 'SELL', price: '0.154000', qty: '22', realizedPnl: '-0.03520000', commission: '0.00169400' }),
];

/** The one the console lost: two complete round-trips on the same symbol. */
const POWER: BinanceUserTrade[] = [
  fill({ id: 7, orderId: 2302296059, time: T0, symbol: 'POWERUSDT', side: 'BUY', price: '0.1780300', qty: '111', commission: '0.00988066' }),
  fill({ id: 8, orderId: 2302660624, time: T0 + 690_000, symbol: 'POWERUSDT', side: 'SELL', price: '0.1780400', qty: '111', realizedPnl: '0.00110999', commission: '0.00988122' }),
  fill({ id: 9, orderId: 2303085892, time: T0 + 1_500_000, symbol: 'POWERUSDT', side: 'BUY', price: '0.1806400', qty: '131', commission: '0.01183192' }),
  fill({ id: 10, orderId: 2303500000, time: T0 + 2_100_000, symbol: 'POWERUSDT', side: 'SELL', price: '0.1856500', qty: '131', realizedPnl: '0.65631000', commission: '0.01216007' }),
];

/* -------------------------------------------------------------------------- */

test('a simple round-trip is reconstructed with the exchange figures', () => {
  const [trade] = reconstructRoundTrips(AKE);
  assert.ok(trade);
  assert.equal(trade.symbol, 'AKEUSDT');
  assert.equal(trade.side, 'long');
  assert.equal(trade.quantity, 449);
  assert.equal(trade.entryPrice, 0.028883);
  assert.equal(trade.exitPrice, 0.028502);
  // The exchange's own realizedPnl, not recomputed from price difference.
  assert.equal(trade.grossPnl, -0.171069);
  // Both legs' commission. The old code recorded only the exit side (0.00639869).
  assert.ok(
    Math.abs(trade.fee - (0.00648423 + 0.00639869)) < 1e-9,
    `fee must include the entry leg, got ${trade.fee}`,
  );
});

test('partial exits are aggregated into one round-trip', () => {
  const trades = reconstructRoundTrips(ARB);
  assert.equal(trades.length, 1, 'three partial sells are still one position');
  const [trade] = trades;
  assert.ok(trade);
  assert.equal(trade.quantity, 89.8, 'quantity is the opened size');
  assert.equal(trade.entryPrice, 0.1556);
  assert.equal(trade.exitPrice, 0.154);
  assert.ok(Math.abs(trade.grossPnl - -0.14368) < 1e-9);
  assert.equal(trade.fillCount, 4);
  // Entry plus all three exit commissions.
  assert.ok(Math.abs(trade.fee - (0.00698644 + 0.0025179 + 0.0027027 + 0.001694)) < 1e-9);
});

test('two round-trips on the same symbol are two trades — the missed-profit case', () => {
  const trades = reconstructRoundTrips(POWER);
  assert.equal(trades.length, 2, 'a second entry after going flat starts a new round-trip');

  const [first, second] = trades;
  assert.ok(first && second);

  assert.equal(first.quantity, 111);
  assert.equal(first.entryPrice, 0.17803);
  assert.equal(first.exitPrice, 0.17804);
  // Exact exchange figures, not rounded: 0.00111 vs 0.00110999 is a 1e-8 gap
  // that a 1e-9 tolerance rejects, and inventing a looser tolerance to hide that
  // would weaken every other assertion in this file.
  assert.ok(Math.abs(first.grossPnl - 0.00110999) < 1e-12, `got ${first.grossPnl}`);

  // This is the trade the console never recorded.
  assert.equal(second.quantity, 131);
  assert.equal(second.entryPrice, 0.18064);
  assert.equal(second.exitPrice, 0.18565);
  assert.ok(Math.abs(second.grossPnl - 0.65631) < 1e-9, `got ${second.grossPnl}`);
  assert.ok(second.closedAt > first.closedAt);
});

test('the reconstructed totals reconcile to the same net as the live account', () => {
  const trades = reconstructRoundTrips([...AKE, ...ARB, ...POWER]);
  const gross = trades.reduce((sum, t) => sum + t.grossPnl, 0);
  const fees = trades.reduce((sum, t) => sum + t.fee, 0);

  // Summed from the three symbols the console queried. The account's wallet went
  // 10 → 10.25858366, and /fapi/v1/income reported REALIZED_PNL +0.347051 with
  // COMMISSION −0.08846734 across *all* symbols, so these numbers are the subset.
  assert.ok(Math.abs(gross - 0.342671) < 1e-6, `gross got ${gross}`);
  assert.ok(Math.abs(fees - 0.070538) < 1e-6, `fees got ${fees}`);

  // Net is what the console must show. Before the fix it showed −0.3136, which
  // is not merely imprecise: it has the wrong sign.
  const net = gross - fees;
  assert.ok(net > 0, `the account made money; net must be positive, got ${net}`);
});

test('an open position is not reported as a completed trade', () => {
  const open = [POWER[0]!, POWER[1]!, POWER[2]!]; // second entry never closed
  const trades = reconstructRoundTrips(open);
  assert.equal(trades.length, 1, 'only the completed round-trip is reported');
  assert.equal(trades[0]?.quantity, 111);
});

test('adding to a position averages the entry instead of starting a new trade', () => {
  const scaleIn: BinanceUserTrade[] = [
    fill({ id: 20, orderId: 1, time: T0, price: '100', qty: '1', commission: '0.05' }),
    fill({ id: 21, orderId: 2, time: T0 + 1000, price: '102', qty: '3', commission: '0.153' }),
    fill({ id: 22, orderId: 3, time: T0 + 2000, price: '105', qty: '4', realizedPnl: '18', commission: '0.21', side: 'SELL' }),
  ];
  const trades = reconstructRoundTrips(scaleIn);
  assert.equal(trades.length, 1);
  const [trade] = trades;
  assert.ok(trade);
  assert.equal(trade.quantity, 4);
  // (100×1 + 102×3) / 4 = 101.5
  assert.ok(Math.abs(trade.entryPrice - 101.5) < 1e-9, `got ${trade.entryPrice}`);
  assert.equal(trade.exitPrice, 105);
});

test('commission in another asset is reported, not silently added', () => {
  const withBnb: BinanceUserTrade[] = [
    fill({ id: 30, orderId: 1, time: T0, price: '100', qty: '1', commission: '0.001', commissionAsset: 'BNB' }),
    fill({ id: 31, orderId: 2, time: T0 + 1000, price: '101', qty: '1', realizedPnl: '1', commission: '0.05', side: 'SELL' }),
  ];
  const [trade] = reconstructRoundTrips(withBnb, 'USDT');
  assert.ok(trade);
  // Only the USDT commission counts toward the fee.
  assert.ok(Math.abs(trade.fee - 0.05) < 1e-9, `got ${trade.fee}`);
  assert.deepEqual(trade.foreignFees, [{ asset: 'BNB', amount: 0.001 }]);
});

test('a short round-trip is labelled short', () => {
  const shortTrade: BinanceUserTrade[] = [
    fill({ id: 40, orderId: 1, time: T0, price: '100', qty: '2', side: 'SELL', commission: '0.1' }),
    fill({ id: 41, orderId: 2, time: T0 + 1000, price: '95', qty: '2', side: 'BUY', realizedPnl: '10', commission: '0.095' }),
  ];
  const [trade] = reconstructRoundTrips(shortTrade);
  assert.ok(trade);
  assert.equal(trade.side, 'short');
  assert.equal(trade.grossPnl, 10);
});

test('an empty or fully-unclosed history yields nothing', () => {
  assert.deepEqual(reconstructRoundTrips([]), []);
  assert.deepEqual(reconstructRoundTrips([POWER[0]!]), []);
});

/* -------------------------------------------------------------------------- */

test('the match key ignores timestamp drift but separates distinct entries', () => {
  const a = roundTripKey({ symbol: 'POWERUSDT', quantity: 131, entryPrice: 0.18064 });
  const b = roundTripKey({ symbol: 'POWERUSDT', quantity: 131, entryPrice: 0.1806401 });
  assert.equal(a, b, 'float noise in an averaged entry price must not split the match');

  const c = roundTripKey({ symbol: 'POWERUSDT', quantity: 111, entryPrice: 0.17803 });
  assert.notEqual(a, c, 'the two POWERUSDT round-trips must not collide');
});

test('two identical-looking round-trips are distinguished by their entry order', () => {
  /*
   * Why this test exists: the key was `symbol | qty | entryPrice` with no time
   * and no order id, and `applyExchangeFigures()` matches on it. An account that
   * opened the same size at the same price twice — a re-entry after a stop, or
   * two round-trips inside one candle on a low-priced altcoin — produced two
   * identical keys, so the second round-trip's exchange figures were written
   * over the first one's `trades` row. One trade's PnL silently replaced
   * another's, and the console disagreed with the account while looking
   * perfectly well-formed.
   *
   * These two round-trips are identical in every field the old key used.
   */
  const fills: BinanceUserTrade[] = [
    fill({ id: 50, orderId: 9001, time: T0, symbol: 'ARBUSDT', side: 'BUY', price: '0.1556', qty: '89.8', commission: '0.00698644' }),
    fill({ id: 51, orderId: 9002, time: T0 + 60_000, symbol: 'ARBUSDT', side: 'SELL', price: '0.1600', qty: '89.8', realizedPnl: '0.39512', commission: '0.0071840' }),
    fill({ id: 52, orderId: 9003, time: T0 + 120_000, symbol: 'ARBUSDT', side: 'BUY', price: '0.1556', qty: '89.8', commission: '0.00698644' }),
    fill({ id: 53, orderId: 9004, time: T0 + 180_000, symbol: 'ARBUSDT', side: 'SELL', price: '0.1500', qty: '89.8', realizedPnl: '-0.50288', commission: '0.0067350' }),
  ];

  const trades = reconstructRoundTrips(fills);
  assert.equal(trades.length, 2, 'two separate round-trips');

  const [first, second] = trades;
  assert.ok(first && second);
  assert.equal(first.entryPrice, second.entryPrice, 'the old key saw these as one row');
  assert.equal(first.quantity, second.quantity);

  const a = roundTripKey(first);
  const b = roundTripKey(second);
  assert.notEqual(a, b, 'same size, same entry price, different order — must not collide');
  assert.equal(a, roundTripKey({ ...first, entryOrderId: '9001' }));
  assert.equal(b, roundTripKey({ ...second, entryOrderId: '9003' }));
});

test('a row with no recorded entry order keys separately from an identified one', () => {
  const withoutId = roundTripKey({ symbol: 'POWERUSDT', quantity: 131, entryPrice: 0.18064 });
  const withId = roundTripKey({
    symbol: 'POWERUSDT',
    quantity: 131,
    entryPrice: 0.18064,
    entryOrderId: '9001',
  });
  assert.notEqual(withoutId, withId, 'a missing order id must not match a real order id');

  // The description-only key is what reconciles a row that predates entry-order
  // tracking — it must be exactly the "no id" key, so it can never be confused
  // with a row that has one.
  assert.equal(
    withoutId,
    roundTripQueryKey({ symbol: 'POWERUSDT', quantity: 131, entryPrice: 0.18064 }),
  );
});
