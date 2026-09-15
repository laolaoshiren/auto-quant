/**
 * Binance USDⓈ-M Futures endpoint routing.
 *
 * ## Why this file exists
 *
 * Binance split the futures WebSocket host into **traffic-class routes**
 * (`/public`, `/market`, `/private`) and is decommissioning the legacy unrouted
 * `wss://fstream.binance.com/ws/...` paths. The failure mode of getting this
 * wrong is nasty: connecting to a legacy unrouted path for a stream that now
 * lives on `/market` **succeeds at the handshake and then delivers nothing,
 * forever**. A TCP "connected" flag therefore proves nothing, which is why the
 * stream layer in `ws.ts` tracks application-level liveness per stream.
 */

export type BinanceEnvironment = 'production' | 'demo' | 'legacy-testnet';

export interface BinanceEndpoints {
  environment: BinanceEnvironment;
  rest: string;
  /** WebSocket host, without the traffic-class route segment. */
  wsHost: string;
  label: string;
  /** Demo/testnet keys are separate from live keys. */
  isTestnet: boolean;
}

export const BINANCE_ENDPOINTS: Record<BinanceEnvironment, BinanceEndpoints> = {
  production: {
    environment: 'production',
    rest: 'https://fapi.binance.com',
    wsHost: 'wss://fstream.binance.com',
    label: '币安 USDT 本位合约（实盘）',
    isTestnet: false,
  },
  /**
   * Unified Demo Mode, the forward path for paper trading. Market data mirrors
   * the live market rather than being synthetic, so it exercises real code
   * paths — but note that the demo environment still accepts legacy unrouted
   * WebSocket URLs, so a passing demo test does *not* validate the production
   * URL scheme.
   */
  demo: {
    environment: 'demo',
    rest: 'https://demo-fapi.binance.com',
    wsHost: 'wss://demo-fstream.binance.com',
    label: '币安合约 Demo 模拟盘',
    isTestnet: true,
  },
  /** Legacy USDT-M futures testnet. Still live, but not the forward path. */
  'legacy-testnet': {
    environment: 'legacy-testnet',
    rest: 'https://testnet.binancefuture.com',
    wsHost: 'wss://stream.binancefuture.com',
    label: '币安合约测试网（旧版）',
    isTestnet: true,
  },
};

/**
 * Returns a **copy**, so callers may override the WebSocket host without
 * mutating the shared catalogue (testnet WebSocket hosts are genuinely
 * ambiguous, so an override is a supported configuration).
 */
export function resolveEndpoints(environment: BinanceEnvironment): BinanceEndpoints {
  return { ...BINANCE_ENDPOINTS[environment] };
}

/* -------------------------------------------------------------------------- */
/*  WebSocket traffic classes                                                  */
/* -------------------------------------------------------------------------- */

export type WsRoute = 'public' | 'market' | 'private';

/**
 * Which route a stream suffix belongs to. Getting this wrong yields a silent,
 * empty socket, so the mapping is explicit rather than inferred.
 */
const MARKET_STREAM_PATTERNS: Array<[RegExp, WsRoute]> = [
  // High-frequency order-book traffic lives on /public.
  [/@depth/i, 'public'],
  [/@bookTicker/i, 'public'],
  // Everything else that we subscribe to lives on /market.
  [/@kline_/i, 'market'],
  [/@markPrice/i, 'market'],
  [/@aggTrade/i, 'market'],
  [/@trade/i, 'market'],
  [/@miniTicker/i, 'market'],
  [/@ticker/i, 'market'],
  [/@forceOrder/i, 'market'],
  [/@contractInfo/i, 'market'],
];

export function routeForStream(stream: string): WsRoute {
  for (const [pattern, route] of MARKET_STREAM_PATTERNS) {
    if (pattern.test(stream)) return route;
  }
  // Unknown suffixes default to /market, the general-purpose route.
  return 'market';
}

/** Group stream names by the route they must be subscribed on. */
export function groupStreamsByRoute(streams: string[]): Record<WsRoute, string[]> {
  const grouped: Record<WsRoute, string[]> = { public: [], market: [], private: [] };
  for (const stream of streams) grouped[routeForStream(stream)].push(stream);
  return grouped;
}

/**
 * Build a routed combined-stream URL:
 *
 *   wss://fstream.binance.com/market/stream?streams=btcusdt@kline_5m/ethusdt@markPrice@1s
 *
 * Subscribing through the URL rather than post-connect `SUBSCRIBE` frames is
 * deliberate: it consumes none of the 10-messages-per-second inbound budget and
 * makes reconnects deterministic, since the subscription set is re-established
 * by the connect call itself.
 */
export function buildMarketStreamUrl(endpoints: BinanceEndpoints, route: WsRoute, streams: string[]): string {
  if (streams.length === 0) throw new Error('Cannot build a stream URL with no streams');
  const query = streams.map((s) => s.toLowerCase()).join('/');
  return `${endpoints.wsHost}/${route}/stream?streams=${query}`;
}

/**
 * Build the private user-data-stream URL.
 *
 * Uses the routed `?listenKey=` form. The event filter is applied so the socket
 * carries only what we act on.
 */
export function buildUserStreamUrl(
  endpoints: BinanceEndpoints,
  listenKey: string,
  events: string[] = ['ORDER_TRADE_UPDATE', 'ACCOUNT_UPDATE', 'MARGIN_CALL', 'ACCOUNT_CONFIG_UPDATE', 'listenKeyExpired'],
): string {
  const params = new URLSearchParams();
  params.append('listenKey', listenKey);
  if (events.length > 0) params.append('events', events.join('/'));
  return `${endpoints.wsHost}/private/ws?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/*  Application-level liveness thresholds                                      */
/* -------------------------------------------------------------------------- */

/**
 * How long a stream may be silent before we treat the connection as broken.
 *
 * These exist because a mis-routed URL produces a socket that connects
 * successfully and then never delivers a byte. Protocol-level liveness cannot
 * detect that; only "have I actually received data recently?" can.
 *
 * Each threshold is a generous multiple of the stream's natural update cadence.
 */
export function stalenessThresholdMs(stream: string): number {
  if (/@markPrice@1s/i.test(stream)) return 15_000; // pushes every second
  if (/@markPrice/i.test(stream)) return 30_000; // pushes every 3s
  if (/@bookTicker/i.test(stream)) return 30_000;
  if (/@depth/i.test(stream)) return 30_000;
  if (/@aggTrade|@trade/i.test(stream)) return 120_000; // trade-driven, can be quiet
  if (/@ticker|@miniTicker/i.test(stream)) return 120_000; // pushes every 1s but be generous
  if (/@kline_1m/i.test(stream)) return 180_000;
  if (/@kline_/i.test(stream)) return 300_000;
  return 120_000;
}
