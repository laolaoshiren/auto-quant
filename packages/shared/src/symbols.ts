/**
 * Symbol helpers shared by every layer.
 *
 * The client console, the prompt builder and the exchange adapter all have to
 * agree on what `BTCUSDT` means, so canonicalisation lives here rather than in
 * the Binance client.
 */

/** Contracts whose risk profile warrants the BTC/ETH-tier limits. */
export const MAJOR_BASE_ASSETS: ReadonlySet<string> = new Set(['BTC', 'ETH']);

/**
 * Accept the many ways a human (or a language model) writes a symbol and
 * canonicalise it:
 *
 *   `btc/usdt`, `BTC-USDT`, `BTC_USDT`, `btcusdt`, `BTCUSDT.P`, `BTCUSDT-PERP`
 *   → `BTCUSDT`
 */
export function normalizeSymbol(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[-_/\s]/g, '')
    .replace(/(PERP|SWAP)$/, '')
    .replace(/\.P$/, '');
}

/** `BTCUSDT` → `BTC`. Falls back to stripping a trailing `USDT`. */
export function baseAssetOf(symbol: string): string {
  const normalized = normalizeSymbol(symbol);
  return normalized.endsWith('USDT') ? normalized.slice(0, -4) : normalized;
}

/**
 * True for symbols that get the looser BTC/ETH leverage and notional caps.
 * Uses the base asset rather than a hard-coded symbol list so that
 * `ETHUSDT` and any future `BTCUSD`-style listing both qualify.
 */
export function isMajorSymbol(symbol: string): boolean {
  return MAJOR_BASE_ASSETS.has(baseAssetOf(symbol));
}
