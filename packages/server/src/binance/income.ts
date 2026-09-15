/**
 * `/fapi/v1/income` — the account's authoritative income ledger.
 *
 * Every movement that is not an open position's mark-to-market appears here:
 * realised PnL, commission, funding, transfers, referrals. It is the closest
 * thing Binance offers to "what actually happened to my money", which makes it
 * the right source for two jobs the platform cannot do reliably on its own:
 *
 *  1. **Funding fees.** These settle every 8 hours on open positions and are not
 *     part of any fill, so nothing in the order flow reveals them. A position
 *     held across a settlement pays (or receives) money that a fill-based ledger
 *     simply does not see.
 *  2. **Discovering symbols.** A ledger built from locally-booked trades only
 *     knows the symbols it remembers. Income events name every symbol the
 *     account has touched, which is what lets reconciliation notice a position
 *     the platform never recorded at all.
 *
 * The ledger also reconciles exactly to the wallet balance: on the live test
 * account, `REALIZED_PNL 0.347051 + COMMISSION −0.08846734 + TRANSFER 10` equals
 * the reported wallet balance of `10.25858366`. That is a useful property — it
 * means an independent check on the platform's arithmetic is always available.
 */
import type { BinanceRest } from './rest.js';
import type { BinanceIncome } from './types.js';

export interface IncomeSummary {
  /** Gross realised PnL across every symbol. */
  realizedPnl: number;
  /** Commission, as a negative number (Binance reports expenses as negative). */
  commission: number;
  /** Funding, signed: negative when paid, positive when received. */
  fundingFee: number;
  /** Deposits and withdrawals, signed. Excluded from trading performance. */
  transfers: number;
  /**
   * Realised + commission + funding. **Excludes transfers** — a deposit is not
   * profit, and including it would make the account look like a genius on the
   * day it was funded.
   */
  netTradingIncome: number;
  /** Every symbol named by an income event, for reconciliation discovery. */
  symbols: string[];
  byType: Record<string, number>;
}

/** Fetch income events. Binance requires a window and caps it at 7 days per call. */
export async function fetchIncome(
  rest: BinanceRest,
  options: { startTime: number; endTime?: number; symbol?: string; incomeType?: string; limit?: number },
): Promise<BinanceIncome[]> {
  const endTime = options.endTime ?? Date.now();
  const events: BinanceIncome[] = [];

  /*
   * Page forward in 7-day slices. `/fapi/v1/income` silently accepts longer
   * windows but truncates at `limit`, which would look like "no income" rather
   * than "ask for less" — so the slicing is done here deliberately.
   */
  const WINDOW = 7 * 24 * 60 * 60 * 1000;
  let cursor = options.startTime;
  while (cursor < endTime) {
    const sliceEnd = Math.min(cursor + WINDOW, endTime);
    const page = await rest.signedRequest<BinanceIncome[]>('GET', '/fapi/v1/income', {
      startTime: cursor,
      endTime: sliceEnd,
      ...(options.symbol ? { symbol: options.symbol } : {}),
      ...(options.incomeType ? { incomeType: options.incomeType } : {}),
      limit: options.limit ?? 1000,
    });
    if (Array.isArray(page)) events.push(...page);
    cursor = sliceEnd + 1;
  }

  return events;
}

const TRADING_TYPES = new Set(['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE']);

export function summarizeIncome(events: readonly BinanceIncome[]): IncomeSummary {
  const byType: Record<string, number> = {};
  const symbols = new Set<string>();

  for (const event of events) {
    const amount = Number(event.income) || 0;
    byType[event.incomeType] = (byType[event.incomeType] ?? 0) + amount;
    if (event.symbol) symbols.add(event.symbol);
  }

  const realizedPnl = byType.REALIZED_PNL ?? 0;
  const commission = byType.COMMISSION ?? 0;
  const fundingFee = byType.FUNDING_FEE ?? 0;
  const transfers = Object.entries(byType)
    .filter(([type]) => !TRADING_TYPES.has(type))
    .reduce((sum, [, amount]) => sum + amount, 0);

  return {
    realizedPnl,
    commission,
    fundingFee,
    transfers,
    netTradingIncome: realizedPnl + commission + fundingFee,
    symbols: [...symbols].sort(),
    byType,
  };
}

/**
 * Funding paid or received on one symbol between two instants.
 *
 * Attributed to a round-trip by its own lifetime, which is the honest window: a
 * position held from 15:00 to 17:00 that spans a 16:00 settlement pays for that
 * settlement, and one that opens at 16:30 does not.
 */
export function fundingInWindow(
  events: readonly BinanceIncome[],
  symbol: string,
  openedAt: string,
  closedAt: string,
): number {
  const from = new Date(openedAt).getTime();
  const to = new Date(closedAt).getTime();
  return events
    .filter(
      (e) =>
        e.incomeType === 'FUNDING_FEE' &&
        e.symbol === symbol &&
        e.time >= from &&
        e.time <= to,
    )
    .reduce((sum, e) => sum + (Number(e.income) || 0), 0);
}
