import { createLogger } from '../logger.js';
import type { BinanceRest } from './rest.js';
import { BinanceApiError, type BinanceAccountV3 } from './types.js';

const log = createLogger('binance:account');

/* -------------------------------------------------------------------------- */
/*  Account snapshot                                                           */
/* -------------------------------------------------------------------------- */

export interface AccountState {
  /** Margin balance: wallet balance plus unrealised PnL. */
  equity: number;
  /** Total wallet balance, i.e. the settled balance. */
  walletBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginUsed: number;
  /** Initial margin currently locked by resting orders alone. */
  openOrderMargin: number;
}

/** An account snapshot annotated with when it was read, for caching and display. */
export interface AccountBalanceSnapshot extends AccountState {
  /** ISO timestamp of the read. */
  readAt: string;
  /** Margin asset the figures are denominated in. */
  asset: string;
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Read USDⓈ-M futures account balances.
 *
 * Deliberately standalone and dependency-free so that showing a balance does not
 * require bootstrapping an `exchangeInfo` symbol registry. The full connect path
 * costs three requests (time sync, exchangeInfo, account); a balance refresh
 * should cost one, because the console polls it.
 *
 * `-1121` / 404 means the v3 endpoint is unavailable on that deployment, so the
 * v2 shape is used instead — same fields, which is why one mapper covers both.
 */
export async function fetchAccountState(rest: BinanceRest): Promise<AccountState> {
  let account: BinanceAccountV3;
  try {
    account = await rest.signedRequest<BinanceAccountV3>('GET', '/fapi/v3/account');
  } catch (error) {
    if (error instanceof BinanceApiError && (error.code === -1121 || error.httpStatus === 404)) {
      account = await rest.signedRequest<BinanceAccountV3>('GET', '/fapi/v2/account');
    } else {
      throw error;
    }
  }
  return mapAccount(account);
}

function mapAccount(account: BinanceAccountV3): AccountState {
  const walletBalance = Number(account.totalWalletBalance) || 0;
  const unrealizedPnl = Number(account.totalUnrealizedProfit) || 0;
  const openOrderMargin = Number(account.totalOpenOrderInitialMargin) || 0;

  return {
    walletBalance,
    unrealizedPnl,
    openOrderMargin,
    marginUsed: (Number(account.totalPositionInitialMargin) || 0) + openOrderMargin,
    equity: Number(account.totalMarginBalance) || walletBalance + unrealizedPnl,
    availableBalance: Number(account.availableBalance) || 0,
  };
}

/**
 * Pick the margin asset the account actually settles in.
 *
 * A USDⓈ-M account holds a single margin asset (USDT in practice, but USDC
 * accounts exist), and reporting the wrong unit on a balance card is the kind of
 * detail that makes an operator distrust every other number on the screen.
 */
export function marginAssetOf(account: BinanceAccountV3): string {
  const funded = account.assets
    // `walletBalance`, verified against a live payload. Reading `balance` here
    // returns undefined, which compares as 0 and silently falls through to the
    // default — a bug that hides itself.
    ?.filter((a) => Number(a.walletBalance) > 0 || Number(a.availableBalance) > 0)
    .sort((a, b) => Number(b.walletBalance) - Number(a.walletBalance));
  return funded?.[0]?.asset ?? 'USDT';
}

/**
 * Read a balance snapshot suitable for display, including the margin asset.
 *
 * Errors are returned rather than thrown so a credential row can render "余额读取
 * 失败" next to that account instead of breaking the whole list.
 */
export async function fetchBalanceSnapshot(
  rest: BinanceRest,
): Promise<{ ok: true; balance: AccountBalanceSnapshot } | { ok: false; error: string }> {
  try {
    let account: BinanceAccountV3;
    try {
      account = await rest.signedRequest<BinanceAccountV3>('GET', '/fapi/v3/account');
    } catch (error) {
      if (error instanceof BinanceApiError && (error.code === -1121 || error.httpStatus === 404)) {
        account = await rest.signedRequest<BinanceAccountV3>('GET', '/fapi/v2/account');
      } else {
        throw error;
      }
    }

    return {
      ok: true,
      balance: {
        ...mapAccount(account),
        asset: marginAssetOf(account),
        readAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    const message = (error as Error).message;
    log.debug(`balance read failed: ${message}`);
    // Translate the two failures an operator can actually act on.
    if (error instanceof BinanceApiError && (error.code === -2015 || error.httpStatus === 401)) {
      return { ok: false, error: 'API Key 无效、已过期，或没有读取账户的权限。' };
    }
    if (error instanceof BinanceApiError && error.code === -1022) {
      return { ok: false, error: 'API Key 签名无效，请检查 Secret 是否正确。' };
    }
    return { ok: false, error: message };
  }
}
