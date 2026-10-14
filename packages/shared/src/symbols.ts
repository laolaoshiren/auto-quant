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
 * Base assets that are pegged to a fiat currency — their USDⓈ-M perps quote and
 * move as ~nothing, so a candidate slot spent on one is a slot not spent on an
 * actual opportunity.
 *
 * **Why a whitelist instead of a blacklist of "everything not major":** a new
 * listing (or one we simply never enumerated) must fail *closed* — it is treated
 * as a stablecoin and kept out until someone says otherwise. The opposite
 * default lets unknown pegged tokens into the candidate pool silently, which is
 * exactly how `excludeStablecoins` came to be a no-op in the first place.
 */
const STABLE_BASE_ASSETS: ReadonlySet<string> = new Set([
  'USDC', // Circle USD
  'FDUSD', // First Digital USD
  'TUSD', // TrueUSD
  'USDE', // Ethena USDe (not 1:1, but pegged by design)
  'USDP', // Paxos USD
  'BUSD', // Binance USD (legacy, still listed on some venues)
  'PYUSD', // PayPal USD
  'USDD', // Decentralized USD
  'GUSD', // Gemini USD
  'EUR', // Stably EUR
]);

/**
 * True when the symbol's base asset is a fiat-pegged stablecoin.
 *
 * `USDCUSDT` is the shape this is for: it survives the registry's
 * `quoteAsset === 'USDT'` filter (its *quote* is USDT) while being, for trading
 * purposes, a slot that cannot pay for itself.
 */
export function isStableBaseAsset(symbol: string): boolean {
  return STABLE_BASE_ASSETS.has(baseAssetOf(symbol));
}

/**
 * True for symbols that get the looser BTC/ETH leverage and notional caps.
 * Uses the base asset rather than a hard-coded symbol list so that
 * `ETHUSDT` and any future `BTCUSD`-style listing both qualify.
 */
export function isMajorSymbol(symbol: string): boolean {
  return MAJOR_BASE_ASSETS.has(baseAssetOf(symbol));
}
