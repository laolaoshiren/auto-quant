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
 * ## ⚠️ 判据是**白名单**：名单外一律**放行**（fail open）
 *
 * 这个方向是**刻意**的，而且原来的注释把它写反了（写成了 fail closed）、
 * 与实现和测试都不一致 —— 那是危险的，因为下一个人按注释去"修"实现，
 * 会把**所有未列出的新币**当稳定币剔除、大量误杀真实机会。
 *
 * 取舍：
 *
 *   · **名单外放行** —— 可能放过一种新型稳定币（补一行名单即可），
 *     但**不会误杀真实标的**（把活跃山寨当稳定币剔除 = 直接放弃机会）；
 *   · 反过来（名单外一律可疑）会让每一次新上币都先被当成稳定币挡掉，
 *     而那个错误的代价落在**真实交易**上。
 *
 * `symbols.test.ts` 与 `coins.test.ts` 都用例钉住了这个方向 ——
 * 若将来要改成 fail closed，那两条会失败，**逼一次显式决定**。
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
  /*
   * ⚠️ **这里曾经有一条 `'EUR', // Stably EUR`（2026-10-14 审查时删除）。**
   *
   * 它有两处错：
   *
   * 1. **会误杀真实标的**：币安上的 `EURUSDT` 是 **Euro / TetherUS**（欧元外汇
   *    交易对 —— 币安有 FX 永续：EUR/USD、GBP/USD、USD/JPY 等，USDT 结算），
   *    那是**真实的交易品种**，波动率远大于稳定币。
   * 2. **来源标注也是错的**：Stably 的品牌稳定币符号不是 `EUR`。
   *
   * 而单字母法币代码是这份名单里最容易出事的一类 —— 一个 `EUR` 就把
   * 「不误杀真实机会」这条取舍翻了过来。要挡某个欧元稳定币请用它的**真实符号**，
   * 并在同行注释里写明来源。
   */
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
