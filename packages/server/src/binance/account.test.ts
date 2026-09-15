import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAccountState, fetchBalanceSnapshot, marginAssetOf } from './account.js';
import type { BinanceRest } from './rest.js';
import { BinanceApiError, type BinanceAccountV3 } from './types.js';

/* -------------------------------------------------------------------------- */
/*  Doubles                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A `/fapi/v3/account` payload.
 *
 * **Field names copied from a live account response**, not from documentation.
 * That distinction matters: the documented/assumed names (`balance`,
 * `accountAlias`) do not exist in the real payload, and reading a non-existent
 * field yields `undefined` → `Number(undefined)` → `0`, which is a bug that
 * silently reports an empty account instead of crashing.
 */
function accountPayload(overrides: Partial<BinanceAccountV3> = {}): BinanceAccountV3 {
  return {
    totalInitialMargin: '120.00',
    totalMaintMargin: '24.00',
    totalWalletBalance: '1000.00',
    totalUnrealizedProfit: '15.50',
    totalMarginBalance: '1015.50',
    totalPositionInitialMargin: '100.00',
    totalOpenOrderInitialMargin: '20.00',
    totalCrossWalletBalance: '1000.00',
    totalCrossUnPnl: '15.50',
    availableBalance: '800.00',
    maxWithdrawAmount: '800.00',
    assets: [
      {
        asset: 'USDT',
        walletBalance: '1000.00',
        unrealizedProfit: '15.50',
        marginBalance: '1015.50',
        maintMargin: '24.00',
        initialMargin: '120.00',
        positionInitialMargin: '100.00',
        openOrderInitialMargin: '20.00',
        crossWalletBalance: '1000.00',
        crossUnPnl: '15.50',
        availableBalance: '800.00',
        maxWithdrawAmount: '800.00',
        updateTime: 0,
      },
    ],
    positions: [],
    ...overrides,
  };
}

function fakeRest(handler: (path: string) => unknown) {
  const calls: string[] = [];
  const rest = {
    async signedRequest(_method: string, path: string) {
      calls.push(path);
      const result = handler(path);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { rest: rest as unknown as BinanceRest, calls };
}

/* -------------------------------------------------------------------------- */
/*  Mapping                                                                    */
/* -------------------------------------------------------------------------- */

test('maps account balances onto the equity/wallet/available distinction', async () => {
  const { rest } = fakeRest(() => accountPayload());
  const state = await fetchAccountState(rest);

  assert.equal(state.walletBalance, 1000);
  assert.equal(state.unrealizedPnl, 15.5);
  // Equity is the margin balance, i.e. wallet plus unrealised PnL — not the
  // wallet balance, which is the number people reach for by mistake.
  assert.equal(state.equity, 1015.5);
  assert.equal(state.availableBalance, 800);
  // Margin used is position margin PLUS resting-order margin, otherwise a bot
  // with big pending orders looks like it has far more headroom than it does.
  assert.equal(state.openOrderMargin, 20);
  assert.equal(state.marginUsed, 120);
});

test('derives equity from wallet + unrealised PnL when marginBalance is absent', async () => {
  const { rest } = fakeRest(() => accountPayload({ totalMarginBalance: '0' }));
  const state = await fetchAccountState(rest);
  assert.equal(state.equity, 1015.5, 'equity must fall back rather than report zero');
});

test('falls back to v2 when v3 is unavailable', async () => {
  const { rest, calls } = fakeRest((path) => {
    if (path === '/fapi/v3/account') {
      return new BinanceApiError(-1121, 'Invalid symbol.', 404, null, path);
    }
    return accountPayload();
  });

  const state = await fetchAccountState(rest);

  assert.deepEqual(calls, ['/fapi/v3/account', '/fapi/v2/account']);
  assert.equal(state.equity, 1015.5);
});

test('does not swallow a genuine access failure', async () => {
  const { rest, calls } = fakeRest(
    () => new BinanceApiError(-2015, 'Invalid API-key, IP, or permissions for action.', 401),
  );

  await assert.rejects(() => fetchAccountState(rest));
  assert.deepEqual(calls, ['/fapi/v3/account'], 'a 401 must not be retried on v2');
});

test('reports the margin asset from the funded balance', () => {
  assert.equal(marginAssetOf(accountPayload()), 'USDT');

  const usdc = accountPayload({
    assets: [
      {
        asset: 'USDT',
        walletBalance: '0',
        unrealizedProfit: '0',
        marginBalance: '0',
        maintMargin: '0',
        initialMargin: '0',
        positionInitialMargin: '0',
        openOrderInitialMargin: '0',
        crossWalletBalance: '0',
        crossUnPnl: '0',
        availableBalance: '0',
        maxWithdrawAmount: '0',
        updateTime: 0,
      },
      {
        asset: 'USDC',
        walletBalance: '250',
        unrealizedProfit: '0',
        marginBalance: '250',
        maintMargin: '0',
        initialMargin: '0',
        positionInitialMargin: '0',
        openOrderInitialMargin: '0',
        crossWalletBalance: '250',
        crossUnPnl: '0',
        availableBalance: '250',
        maxWithdrawAmount: '250',
        updateTime: 0,
      },
    ],
  });
  assert.equal(marginAssetOf(usdc), 'USDC');
});

test('the wallet balance field is `walletBalance`, not `balance`', () => {
  // Guards the exact regression that a live account exposed: the real payload
  // has no `balance` key, so code reading it silently sees an empty account.
  const payload = accountPayload();
  const asset = payload.assets[0]!;
  assert.equal(asset.walletBalance, '1000.00');
  assert.equal((asset as unknown as Record<string, unknown>).balance, undefined);
  assert.equal(marginAssetOf(payload), 'USDT', 'must still resolve from walletBalance');
});

/* -------------------------------------------------------------------------- */
/*  Display snapshot                                                           */
/* -------------------------------------------------------------------------- */

test('a successful snapshot is timestamped and labelled', async () => {
  const { rest } = fakeRest(() => accountPayload());
  const result = await fetchBalanceSnapshot(rest);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.balance.asset, 'USDT');
  assert.equal(result.balance.walletBalance, 1000);
  assert.ok(!Number.isNaN(Date.parse(result.balance.readAt)), 'readAt must be a valid timestamp');
});

test('an invalid key becomes an actionable message, not a stack trace', async () => {
  const { rest } = fakeRest(
    () => new BinanceApiError(-2015, 'Invalid API-key, IP, or permissions for action.', 401),
  );
  const result = await fetchBalanceSnapshot(rest);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /API Key 无效/);
});

test('a bad signature is reported as a secret problem, not a permissions problem', async () => {
  const { rest } = fakeRest(() => new BinanceApiError(-1022, 'Signature for this request is not valid.', 400));
  const result = await fetchBalanceSnapshot(rest);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /签名无效/);
});

test('a transport failure is surfaced verbatim', async () => {
  const { rest } = fakeRest(() => new Error('fetch failed'));
  const result = await fetchBalanceSnapshot(rest);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /fetch failed/);
});
