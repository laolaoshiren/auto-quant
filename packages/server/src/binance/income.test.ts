import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BinanceIncome } from './types.js';
import { fundingInWindow, summarizeIncome } from './income.js';

/**
 * The income ledger is the only place funding fees appear — no fill mentions
 * them — so these tests are the only guard on that path. Live testing cannot
 * cover it on demand: funding settles every 8 hours, and a position has to
 * happen to be open across a boundary.
 *
 * The fixture totals below are the **real figures** from a live test account,
 * where the ledger reconciles exactly to the wallet balance:
 * `REALIZED_PNL 0.347051 + COMMISSION −0.08846734 + TRANSFER 10 = 10.25858366`.
 */
function income(over: Partial<BinanceIncome> & { incomeType: string; income: string; time: number }): BinanceIncome {
  return {
    symbol: 'POWERUSDT',
    asset: 'USDT',
    info: '',
    tranId: 0,
    tradeId: '',
    ...over,
  };
}

const LIVE_LEDGER: BinanceIncome[] = [
  income({ incomeType: 'TRANSFER', income: '10', symbol: '', time: 1_700_000_000_000 }),
  income({ incomeType: 'REALIZED_PNL', income: '-0.17106900', symbol: 'AKEUSDT', time: 1_700_000_100_000 }),
  income({ incomeType: 'COMMISSION', income: '-0.01288292', symbol: 'AKEUSDT', time: 1_700_000_100_000 }),
  income({ incomeType: 'REALIZED_PNL', income: '-0.14368000', symbol: 'ARBUSDT', time: 1_700_000_200_000 }),
  income({ incomeType: 'COMMISSION', income: '-0.01390104', symbol: 'ARBUSDT', time: 1_700_000_200_000 }),
  income({ incomeType: 'REALIZED_PNL', income: '0.00438001', symbol: 'DOGEUSDT', time: 1_700_000_300_000 }),
  income({ incomeType: 'COMMISSION', income: '-0.01792951', symbol: 'DOGEUSDT', time: 1_700_000_300_000 }),
  income({ incomeType: 'REALIZED_PNL', income: '0.65741999', symbol: 'POWERUSDT', time: 1_700_000_400_000 }),
  income({ incomeType: 'COMMISSION', income: '-0.04375387', symbol: 'POWERUSDT', time: 1_700_000_400_000 }),
];

test('the live ledger summarises to the real account figures', () => {
  const summary = summarizeIncome(LIVE_LEDGER);
  assert.ok(Math.abs(summary.realizedPnl - 0.347051) < 1e-8, `got ${summary.realizedPnl}`);
  assert.ok(Math.abs(summary.commission - -0.08846734) < 1e-9, `got ${summary.commission}`);
  assert.equal(summary.fundingFee, 0);
  assert.ok(Math.abs(summary.transfers - 10) < 1e-9);
});

test('net trading income excludes transfers', () => {
  const summary = summarizeIncome(LIVE_LEDGER);
  // A deposit is not profit. Including the 10 USDT transfer would make the
  // account look like it doubled.
  assert.ok(Math.abs(summary.netTradingIncome - 0.25858366) < 1e-8, `got ${summary.netTradingIncome}`);
  // And that is exactly the wallet change: 10.25858366 − 10.
  assert.ok(Math.abs(summary.netTradingIncome + summary.transfers - 10.25858366) < 1e-8);
});

test('every symbol in the ledger is discovered, including ones with no trades', () => {
  const summary = summarizeIncome(LIVE_LEDGER);
  assert.deepEqual(summary.symbols, ['AKEUSDT', 'ARBUSDT', 'DOGEUSDT', 'POWERUSDT']);
});

/* -------------------------------------------------------------------------- */
/*  Funding attribution                                                        */
/* -------------------------------------------------------------------------- */

const FUNDING: BinanceIncome[] = [
  income({ incomeType: 'FUNDING_FEE', income: '-0.0012', symbol: 'POWERUSDT', time: 1_700_000_500_000 }),
  income({ incomeType: 'FUNDING_FEE', income: '-0.0008', symbol: 'POWERUSDT', time: 1_700_003_600_000 }),
  income({ incomeType: 'FUNDING_FEE', income: '-0.0099', symbol: 'ARBUSDT', time: 1_700_000_500_000 }),
];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

test('funding is attributed only for the round-trip that spanned it', () => {
  // A position open across the first two settlements pays both.
  const both = fundingInWindow(FUNDING, 'POWERUSDT', iso(1_700_000_000_000), iso(1_700_004_000_000));
  assert.ok(Math.abs(both - -0.002) < 1e-12, `got ${both}`);

  // One that closed before the second settlement pays only the first.
  const first = fundingInWindow(FUNDING, 'POWERUSDT', iso(1_700_000_000_000), iso(1_700_001_000_000));
  assert.ok(Math.abs(first - -0.0012) < 1e-12, `got ${first}`);

  // One that opened after both pays nothing.
  const none = fundingInWindow(FUNDING, 'POWERUSDT', iso(1_700_004_000_000), iso(1_700_005_000_000));
  assert.equal(none, 0);
});

test('funding is scoped to the symbol', () => {
  const power = fundingInWindow(FUNDING, 'POWERUSDT', iso(1_700_000_000_000), iso(1_700_004_000_000));
  const arb = fundingInWindow(FUNDING, 'ARBUSDT', iso(1_700_000_000_000), iso(1_700_004_000_000));
  assert.ok(Math.abs(arb - -0.0099) < 1e-12, 'ARBUSDT funding must not leak into POWERUSDT');
  assert.notEqual(power, arb);
});

test('an empty ledger yields zeroes rather than NaN', () => {
  const summary = summarizeIncome([]);
  assert.equal(summary.realizedPnl, 0);
  assert.equal(summary.commission, 0);
  assert.equal(summary.fundingFee, 0);
  assert.equal(summary.netTradingIncome, 0);
  assert.ok(Number.isFinite(summary.netTradingIncome));
});
