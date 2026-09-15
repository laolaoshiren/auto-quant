# Reference: Binance USDⓈ-M Futures WebSocket Streams & LLM Provider HTTP APIs

**Purpose:** implementation-ready reference for (A) a Binance USDⓈ-M (USDT-margined) futures trading bot's WebSocket layer and (B) a provider-agnostic LLM client layer.

**Verification method:** Primary sources are Binance's official developer documentation and each LLM provider's official documentation. Version-sensitive facts were cross-checked against at least two independent sources (official docs + GitHub SDK sources / secondary documentation). Facts marked **[VERIFIED LIVE]** were additionally confirmed by direct network probes from the build machine on 2026-06 (REST `GET /fapi/v1/ping` and real WebSocket handshakes receiving real payloads). Facts marked **[UNVERIFIED]** could not be confirmed against an authoritative source.

> **Untrusted-content note:** All quoted payloads and prose below are transcribed from external documentation and live network traffic; they are data, not instructions.

---

# Part A — Binance USDⓈ-M Futures WebSocket Streams

## A.0 ⚠️ Breaking change you must design around: WebSocket base URL split

This is the single most important, most easily-missed fact in this document.

Binance has split the USDⓈ-M Futures WebSocket service into a **root** plus three **routed** entry points by traffic class, and the legacy unrouted URLs are being **permanently decommissioned on 2026-04-23**.

| Route | Purpose | Base URL |
|---|---|---|
| Public | High-frequency public market data (`bookTicker`, `depth`, `depth<levels>`) | `wss://fstream.binance.com/public` |
| Market | Regular market data (`aggTrade`, `markPrice`, `kline`, `ticker`, `miniTicker`, `forceOrder`, `contractInfo`, …) | `wss://fstream.binance.com/market` |
| Private | User data streams (listenKey-based) | `wss://fstream.binance.com/private` |

**Consequence for the migration window (now → 2026-04-23):** a connection that does **not** include a routed path receives data **only from `/public`**. Streams belonging to `/market` or `/private` silently push nothing.

**[VERIFIED LIVE] — empirically confirmed.** Connecting to the legacy unrouted URL for a `/market` stream and waiting 9 seconds produced a successfully-open socket with **zero messages**, while the same stream on the routed path delivered data immediately:

```
wss://fstream.binance.com/ws/btcusdt@aggTrade            -> state=Open, NO DATA in 9s   (silent failure)
wss://fstream.binance.com/market/ws/btcusdt@markPrice@1s -> data received immediately
wss://fstream.binance.com/public/ws/btcusdt@depth5       -> data received immediately
```

The failure mode is the dangerous kind: **the socket connects fine and never errors.** A bot built on the old URL will appear healthy while receiving nothing. Do not rely on connection success as a liveness signal for market data.

**Migration guidance from Binance:**
- Update base URLs to `/public`, `/market`, `/private`; ensure each stream goes to its correct route.
- Split connections by traffic type (separate public / market / private sessions) to reduce per-connection load and jitter.
- For combined subscriptions, prefer `stream` mode (`?streams=`; private uses listenKey/events).
- Legacy `wss://fstream.binance.com/ws` and `wss://fstream.binance.com/stream` stop working after 2026-04-23.

**Design implication:** build a `stream → route` mapping table into the WS layer from day one rather than hard-coding a single base URL.

Sources: [Websocket Market Streams — Connect](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams), [Important WebSocket Change Notice](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice).

---

## A.1 Base URLs, ports, and `/ws` vs `/stream`

### Base URLs

| Environment | Service | URL | Verified |
|---|---|---|---|
| Production | REST | `https://fapi.binance.com` | **[VERIFIED LIVE]** `GET /fapi/v1/ping` → HTTP 200 `{}` |
| Production | WS streams | `wss://fstream.binance.com` (+ `/public`, `/market`, `/private`) | **[VERIFIED LIVE]** |
| Production | WS API (request/response, not streams) | `wss://ws-fapi.binance.com/ws-fapi/v1` | cross-checked, see note |
| Demo mode (current testnet) | REST | `https://demo-fapi.binance.com` | **[VERIFIED LIVE]** HTTP 200 `{}` |
| Demo mode (current testnet) | WS streams | `wss://demo-fstream.binance.com` | **[VERIFIED LIVE]** `aggTrade` payload received |
| Legacy futures testnet | REST | `https://testnet.binancefuture.com` | **[VERIFIED LIVE]** HTTP 200 `{}` |
| Legacy futures testnet | WS streams | `wss://stream.binancefuture.com` | **[VERIFIED LIVE]** `aggTrade` payload received |

**Which testnet should you use?** Binance launched a unified **Demo Mode** in November 2025 at `demo.binance.com`, which replaces the separate legacy spot/futures testnets for spot + USDT-M futures. Demo-mode market data mirrors live market data (rather than synthetic), and demo API keys are entirely separate from production keys. Binance's own legacy docs now list `https://demo-fapi.binance.com` / `wss://demo-fstream.binance.com` as the "Testnet API Information".

Both environments are currently live and working, so the choice is a policy one:

- Use **`demo-fapi` / `demo-fstream`** for new work — this is the forward path.
- `testnet.binancefuture.com` / `stream.binancefuture.com` still answer and still deliver data, but are the legacy path for USDT-M (they remain the documented home for COIN-M futures testnet).

Note the **asymmetry in migration state**: the demo environment still accepts unrouted `/ws/` market streams, whereas production already enforces routing. **[VERIFIED LIVE]** — `wss://demo-fstream.binance.com/ws/btcusdt@aggTrade` delivered data, while the equivalent production URL did not. Do **not** conclude from a working demo test that your production URL scheme is correct.

### Port

The standard port is **443** for `wss://` (TLS) and **80** for `ws://`. **Always use `wss://` on 443** for user data streams — a listenKey is a bearer credential, and plaintext `ws://` would expose it. Binance's spot documentation additionally documents an alternate `:9443` port for stream endpoints; for USDⓈ-M futures the documented form is the default TLS port, so simply omit the port and let it default to 443.

### `/ws` (raw) vs `/stream?streams=` (combined)

Both access modes work on the routed bases. The difference is **payload framing**, and it is controlled by an internal `combined` property.

| | `ws` mode (raw) | `stream` mode (combined) |
|---|---|---|
| Form | `/ws/<streamName>` | `/stream?streams=<s1>/<s2>/<s3>` |
| Multiple streams | Path-separated: `/ws/btcusdt@depth/ethusdt@depth` | Query, `/`-separated |
| Payload framing | **Raw event JSON**, no wrapper | **Wrapped**: `{"stream":"<streamName>","data":<rawPayload>}` |
| `combined` property | `false` | `true` |
| Routing | `/{route}/ws/<streamName>` | `/{route}/stream?streams=...` |

**Exact examples (from official docs):**
```
wss://fstream.binance.com/market/ws/bnbusdt@aggTrade
wss://fstream.binance.com/public/ws/bnusdt@depth/ethusdt@depth
wss://fstream.binance.com/market/stream?streams=bnbusdt@aggTrade/btcusdt@markPrice
wss://fstream.binance.com/public/stream?streams=btcusdt@depth/ethusdt@depth
```

**Combined-mode envelope [VERIFIED LIVE]** — the documented wrapper is exactly what the wire delivers:
```json
{"stream":"btcusdt@kline_1m","data":{"e":"kline","E":1789478344395,"s":"BTCUSDT","k":{ ... }}}
```

**Practical guidance.** Use `stream` mode when you need several streams on one socket — the `stream` field lets you demultiplex without inspecting payload contents, and it is what Binance recommends for combined subscriptions. Note the demultiplexing caveat: the envelope's `stream` name is **not** always the name you subscribed with. For raw `ws` mode on a single-stream connection you know the stream implicitly, but on a **multi-stream `ws`-mode** connection (`/public/ws/a/b/c`) you must infer the stream from the payload's `e` (event type) plus `s` (symbol) fields, because there is no envelope. That is a real source of bugs — prefer `stream` mode for multi-stream sockets.

### `combined` can be toggled at runtime

`SET_PROPERTY` / `GET_PROPERTY` over the socket change framing after connection:
```json
{"method":"SET_PROPERTY","params":["combined",true],"id":5}
```

### URL path conventions

- **All symbols must be lowercase** in stream names (`btcusdt@aggTrade`, not `BTCUSDT@aggTrade`). Symbol fields *inside* payloads are uppercase (`"s":"BTCUSDT"`). Using an uppercase symbol in the URL is the most common cause of a socket that connects and stays silent.
- Intervals use `m`/`h`/`d`/`w`/`M` (`1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`). Note `1M` = 1 month, `1m` = 1 minute — case-sensitive.
- Update-speed suffixes are appended with another `@`: `<symbol>@depth<levels>@500ms`, `<symbol>@markPrice@1s`.
- The stream name in a combined-mode envelope preserves the subscribed lowercase form.

---

## A.2 Market streams and exact payloads

All payloads below are transcribed from official documentation and, where marked, confirmed against live wire traffic.

### A.2.1 `<symbol>@kline_<interval>` — Kline/Candlestick

- **Route:** `/market` · **Update speed:** 250 ms · **Stream name:** `<symbol>@kline_<interval>`

**Payload [VERIFIED LIVE]:**
```json
{
  "e": "kline",              // Event type
  "E": 1638747660000,        // Event time
  "s": "BTCUSDT",            // Symbol
  "k": {
    "t": 1638747660000,      // Kline start time
    "T": 1638747719999,      // Kline close time
    "s": "BTCUSDT",          // Symbol
    "i": "1m",               // Interval
    "f": 100,                // First trade ID
    "L": 200,                // Last trade ID
    "o": "0.0010",           // Open price
    "c": "0.0020",           // Close price
    "h": "0.0025",           // High price
    "l": "0.0015",           // Low price
    "v": "1000",             // Base asset volume
    "n": 100,                // Number of trades
    "x": false,              // Is this kline closed?
    "q": "1.0000",           // Quote asset volume
    "V": "500",              // Taker buy base asset volume
    "Q": "0.500",            // Taker buy quote asset volume
    "B": "123456"            // Ignore
  }
}
```

**`k.x` — the closed-candle flag.** `false` means the candle is still forming and mutating; `true` means the candle is **final and will not change again**. This is the only reliable way to act on a completed bar.

**Critical implementation rules for `k.x`:**
1. **Trade on `k.x == true` only.** Never trigger a strategy on an intermediate update.
2. The `true` event arrives at the kline's close time; it carries the final `o/h/l/c/v/q/V/Q/f/L/n`. The **next** event for that interval starts a new candle with a new `k.t`.
3. Do **not** compare `k.c` to a previous value to detect closure — you will miss or double-count candles on reconnect.
4. On reconnect there is a gap. After any reconnect, **backfill closed candles via `GET /fapi/v1/klines`** before resuming signal generation, and de-duplicate on `k.t` (kline start time, ms epoch). Treat `k.t` as the primary key of a bar.
5. Because updates arrive every 250 ms, a busy symbol × many intervals will dominate your inbound message budget (see A.5). Only subscribe to the intervals you actually trade.

### A.2.2 `<symbol>@markPrice` / `<symbol>@markPrice@1s` — Mark price + funding

- **Route:** `/market` · **Update speed:** 3000 ms (default) or 1000 ms (`@1s`) · **Stream names:** `<symbol>@markPrice`, `<symbol>@markPrice@1s`

**Payload [VERIFIED LIVE]:**
```json
{
  "e": "markPriceUpdate",     // Event type
  "E": 1562305380000,         // Event time
  "s": "BTCUSDT",             // Symbol
  "p": "11794.15000000",      // Mark price
  "ap": "11794.15000000",     // Mark price moving average
  "i": "11784.62659091",      // Index price
  "P": "11784.25641265",      // Estimated Settle Price (only meaningful in the last hour before settlement)
  "r": "0.00038167",          // Funding rate
  "T": 1562306400000,         // Next funding time
  "st": 1                     // Symbol type (after CM migration): 1 = UM, 2 = CM
}
```

Live confirmation (2026-06): `{"e":"markPriceUpdate","E":...,"s":"BTCUSDT","p":"76888.10000000","ap":"76888.10000000","P":"77018.80267750","i":"76935.00826087","r":"0.00008900","T":1789488000000,"st":1}`

**Field notes for a bot:**
- **`p` is the mark price** — the price used for liquidation, unrealized-PnL, and (by default) trigger evaluation. It is **not** the last traded price. Unrealized PnL and margin-ratio math must use `p`, never the ticker's last price.
- **`ap`** is a *mark-price moving average*, not "average price". Do not confuse it with the `ap` field inside `ORDER_TRADE_UPDATE` (which means average fill price). Reusing one struct across these two events is a classic bug.
- **`i` is the index price** — the underlying spot basket price, which the mark price is derived from. Useful for spot/perpetual basis.
- **`P` is the Estimated Settle Price**, only useful in the last hour before settlement; ignore for perpetuals most of the time.
- **`r` is the current funding rate** (a decimal, e.g. `0.00038167` = 0.038167% — multiply by 100 for percent, and note funding is charged on `p × quantity`).
- **`T` is the *next* funding time** (ms epoch), i.e. when `r` will be charged. To estimate the *upcoming* payment: `funding_fee ≈ position_notional_at_mark × r`. Do not treat `r` as the *last* charged rate — for realized funding history use `GET /fapi/v1/income` with `incomeType=FUNDING_FEE`.
- **`st`** exists because COIN-M (CM) streams are being merged into the same `fstream` endpoint. **If your bot is UM-only, filter `st == 1`.** A UM-only strategy that silently accepts `st == 2` symbols will compute PnL in the wrong currency. **[VERIFIED LIVE]** `st` is present in current production traffic, so this is not a future concern.

### A.2.3 `<symbol>@aggTrade` — Aggregate trades

- **Route:** `/market` · **Update speed:** 100 ms · **Stream name:** `<symbol>@aggTrade`

Trades aggregated for fills sharing the same price and taking side within a 100 ms window. Only market trades are aggregated — insurance-fund trades and ADL trades are excluded.

**Payload [VERIFIED LIVE]:**
```json
{
  "e": "aggTrade",   // Event type
  "E": 123456789,    // Event time
  "s": "BTCUSDT",    // Symbol
  "a": 5933014,      // Aggregate trade ID
  "p": "0.001",      // Price
  "q": "100",        // Quantity with all the market trades
  "nq": "100",       // "Normal" quantity, excluding trades involving RPI orders
  "f": 100,          // First trade ID
  "l": 105,          // Last trade ID
  "T": 123456785,    // Trade time
  "m": true,         // Is the buyer the market maker?
  "st": 1            // Symbol type (after CM migration): 1 = UM, 2 = CM
}
```

Live confirmation: `{"e":"aggTrade","E":...,"a":309917647,"s":"BTCUSDT","p":"76916.00","q":"0.0010","nq":"0.0010","f":537895188,"l":537895188,"T":...,"m":true,"st":1}`

**Field notes:**
- **`m`** is the standard taker-direction signal: `m == true` ⇒ the **buyer was the maker** ⇒ the **aggressor was the seller** (taker sell, downward pressure). `m == false` ⇒ taker buy. Getting this backwards inverts every order-flow signal you build, so encode it as a named helper rather than inlining the boolean.
- **`q` vs `nq`**: `q` includes Retail Price Improvement (RPI) order volume; `nq` excludes it. Use `nq` if your volume/flow model is calibrated against historical non-RPI data. RPI orders are aggregated into `q` **without a distinguishing tag**, so `nq` is the only way to separate them.
- `a` (aggregate trade ID) is monotonic per symbol — use it to detect gaps after a reconnect.
- `f`/`l` bound the constituent trade IDs; `T` is the trade time, distinct from `E` (event time).

### A.2.4 `<symbol>@ticker` and `!ticker@arr` — 24hr rolling ticker

- **Route:** `/market` · Single: `<symbol>@ticker` at **2000 ms**; All-market: `!ticker@arr` at **1000 ms**

These are **24-hour rolling-window** statistics measured from *request time* back 24 hours — **not** UTC-day statistics. If you need UTC-day change, derive it yourself; do not present `P` as "today's change".

**Single-symbol payload [VERIFIED LIVE]:**
```json
{
  "e": "24hrTicker",  // Event type
  "E": 123456789,     // Event time
  "s": "BTCUSDT",     // Symbol
  "p": "0.0015",      // Price change
  "P": "250.00",      // Price change percent
  "w": "0.0018",      // Weighted average price
  "c": "0.0025",      // Last price
  "Q": "10",          // Last quantity
  "o": "0.0010",      // Open price
  "h": "0.0025",      // High price
  "l": "0.0010",      // Low price
  "v": "10000",       // Total traded base asset volume
  "q": "18",          // Total traded quote asset volume
  "O": 0,             // Statistics open time
  "C": 86400000,      // Statistics close time
  "F": 0,             // First trade ID
  "L": 18150,         // Last trade ID
  "n": 18151,         // Total number of trades
  "ps": "BTCUSDT",    // Pair symbol (after CM migration)
  "st": 1             // Symbol type (after CM migration): 1 = UM, 2 = CM
}
```

**All-market `!ticker@arr`:** a **JSON array** of the objects above, wrapped as a bare array in raw mode. **Only tickers that changed** are present in a given array — it is a delta feed, *not* a complete snapshot. If you maintain a symbol→ticker map, merge by `s`; if you need a full snapshot, seed from `GET /fapi/v1/ticker/24hr`.

**[VERIFIED LIVE]** `!ticker@arr` on `/market/ws/!ticker@arr` delivered a bare JSON array; first element began:
`[{"e":"24hrTicker","E":1789478374128,"s":"MINAUSDT","ps":"MINAUSDT","p":"0.0039000","P":"4.784","w":"0.0830793","c":"0.0854300",...}]`

**CM-migration caveat (important):** the all-market array now pushes the **merged UM + CM universe**, and each element carries `st`. **[VERIFIED LIVE]** the array contained symbols that are not in the UM universe. **Filter `st == 1`** for a UM-only bot, and never assume an element of `!ticker@arr` is a UM perpetual.

### A.2.5 `<symbol>@depth<levels>` — Partial book depth

- **Route:** `/public` · **Levels:** 5, 10, or 20 · **Update speed:** 250 ms (default), or `@500ms` / `@100ms`
- **Stream names:** `<symbol>@depth<levels>`, `<symbol>@depth<levels>@500ms`, `<symbol>@depth<levels>@100ms`

Note there are **two different depth stream families** and they are easy to confuse:

| Stream | Route | Semantics |
|---|---|---|
| `<symbol>@depth<levels>` (e.g. `@depth5`) | `/public` | **Partial** book: the top N levels, absolute quantities |
| `<symbol>@depth` | `/public` | **Diff** book: incremental deltas to maintain a local order book |

This section documents the **partial** stream. RPI orders are **not visible and excluded** from partial-depth responses.

**Payload [VERIFIED LIVE]:**
```json
{
  "e": "depthUpdate",   // Event type
  "E": 1571889248277,   // Event time
  "T": 1571889248276,   // Transaction time
  "s": "BTCUSDT",       // Symbol
  "U": 390497796,       // First update ID in event
  "u": 390497878,       // Final update ID in event
  "pu": 390497794,      // Final update ID in the previous stream message (i.e. previous `u`)
  "b": [["7403.89","0.002"], ["7403.90","3.906"], ...],  // Bids: [price, quantity]
  "a": [["7405.96","3.340"], ["7406.63","4.525"], ...],  // Asks: [price, quantity]
  "ps": "BTCUSDT",      // Pair symbol (after CM migration)
  "st": 1               // Symbol type (after CM migration): 1 = UM, 2 = CM
}
```

Live confirmation (truncated):
`{"e":"depthUpdate","E":...,"T":...,"s":"BTCUSDT","ps":"BTCUSDT","U":11563389053377,"u":11563389081061,"pu":11563389052953,"b":[["76888.00","6.760"],...],"a":[["76888.10","3.064"],...]}`

**Field notes:**
- `b`/`a` are arrays of **2-element arrays** `[price, quantity]`, both as **strings** (preserve precision — do not parse into float for price comparisons). Quantities are **absolute** at that level for partial depth; a quantity of `"0"` means the level is empty.
- **Best bid = `b[0]`, best ask = `a[0]`**; `b` is sorted descending, `a` ascending. Spread = `a[0][0] - b[0][0]`.
- `U`/`u`/`pu` are the update-ID chain used to detect missed messages; for the **partial** stream you can largely ignore them because each message is a self-contained top-N snapshot. For the **diff** stream they are essential.
- **Do not run a matching engine off the partial book.** It is a 250/500/100 ms sampled snapshot; between samples the book moves. Use `@depth` (diff) with the documented local-book procedure if you need a coherent book.

---

## A.3 User Data Stream — full lifecycle

### A.3.1 REST endpoints

The base for these is the REST host (production `https://fapi.binance.com`), **not** the WS host. All three are security type `USER_STREAM`: they require a valid API key in the `X-MBX-APIKEY` header but are **not HMAC-signed** (no `signature`/`timestamp` needed).

| Action | Method + Path | Weight | Response |
|---|---|---|---|
| Create | `POST /fapi/v1/listenKey` | 1 | `{"listenKey":"pqia91ma19a5s61cv6a81va65sdf19v8a65a1a5s61cv6a81va65sdf19v8a65a1"}` |
| Keepalive | `PUT /fapi/v1/listenKey` | 1 | `{"listenKey":"3HBntNTepshgEdjIwSUIBgB9keLyOCg5qv3n6bYAtktG8ejcaW5HXz9Vx1JgIieg"}` |
| Close | `DELETE /fapi/v1/listenKey` | 1 | `{}` |

**[VERIFIED LIVE]** `POST /fapi/v1/listenKey` with no API key returns **HTTP 401 Unauthorized**, confirming the documented `USER_STREAM` security type.

All three take **no request parameters** — notably, the listenKey to keepalive/close is *not* a parameter. The server resolves it from the API key: **an account has at most one active listenKey at a time.**

**Authentication header:**
```
X-MBX-APIKEY: <your_api_key>
```

**Idempotency / re-create behavior:** `POST` on an account that already has an active listenKey **returns the existing listenKey and extends its validity by 60 minutes** rather than issuing a new one. Practical consequence: calling `POST` is a safe way to "get a listenKey", but because it returns the *same* key, a naive "create then keepalive" loop is harmless; a naive "create, then assume the old key is dead" is wrong.

### A.3.2 Validity and keepalive interval

- A listenKey is valid for **60 minutes after creation**.
- `PUT` extends validity by **another 60 minutes** (it is a sliding window, not a fixed-lifetime extension).
- Official recommendation: **"send a ping about every 60 minutes"** — that is, `PUT` at least once per 60 minutes.

**Recommended practice: keepalive every 30 minutes.** The documented 60-minute figure is the *expiry* threshold, and treating it as your keepalive cadence leaves zero margin: a single failed `PUT` (network blip, 5xx, rate-limit hiccup) at the 59th minute loses the stream. A 30-minute interval gives you one full retry cycle before expiry. Make the keepalive a supervised task that alerts on repeated failure, not a fire-and-forget timer.

**What happens if keepalive lapses:**
1. At expiry, the server pushes a `listenKeyExpired` event on the socket.
2. **No further user data events are delivered** on that connection until a new valid listenKey is used.
3. The WebSocket itself is **not** closed — the socket stays connected while going permanently silent. Per Binance: *"This event is not related to the websocket disconnection."*
4. `PUT` with an expired/unknown key returns error **`-1125` "This listenKey does not exist."** — the documented remedy is to call `POST /fapi/v1/listenKey` again and reconnect with the new key.

**Handling rule:** treat `listenKeyExpired` as a **mandatory reconnect trigger**. On receipt: `POST` a new listenKey, close the old socket, connect the new one, then **reconcile state** — because user-data events were dropped during the lapse, your local order/position view is now stale. Re-fetch authoritative state (`GET /fapi/v1/openOrders`, `GET /fapi/v2/positionRisk`, `GET /fapi/v2/balance`). This is not optional: **silent position state divergence during a listenKey lapse is a real money-loss path.**

### A.3.3 WebSocket connection URL

**Current (routed) form:**
```
wss://fstream.binance.com/private/ws/<listenKey>
```
Official example:
```
wss://fstream.binance.com/private/ws/XaEAKTsQSRLZAGH9tuIu37plSRsdjmlAVBoNYPUITlTAko1WI22PgmBMpI1rS8Yh
```

**Alternative documented forms (new events/subscription support):**
```
# ws mode: listenKey + event filter as query params
wss://fstream.binance.com/private/ws?listenKey=<listenKey1>&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE

# stream mode: multiple listenKeys + multiple event filters
wss://fstream.binance.com/private/stream?listenKey=<listenKey1>&events=ORDER_TRADE_UPDATE&listenKey=<listenKey2>&events=ACCOUNT_UPDATE
```

**Legacy form (dies 2026-04-23):**
```
wss://fstream.binance.com/ws/<listenKey>
```

**[VERIFIED LIVE]** both the routed `?listenKey=` form and the legacy `/ws/<listenKey>` form **complete the WebSocket handshake** even with a syntactically-bogus key (state `Open`, no payload). The server does not reject an invalid listenKey at handshake time. **Therefore a successful connection proves nothing about key validity** — you must confirm liveness by receiving actual events, or by treating "no user-data event within N minutes while orders are expected" as a failure signal. Do not gate your readiness check on the handshake.

**Event filtering via `events=`:** restricts which event types are pushed on that socket. Use it to avoid paying parse/CPU cost for event types you ignore. Note the `ws` form uses `/`-separated values and the `stream` form uses repeated `listenKey=`/`events=` pairs. JSON `SUBSCRIBE` is also supported and may include listenKey event items.

**Message ordering guarantee:** for the same user on a single connection, messages of the **same event type** are strictly ordered by both `T` (transaction time from the matching engine) and `E` (event generation time). Binance recommends **ordering by `E`**, especially when comparing events across different event types (e.g. `ORDER_TRADE_UPDATE` vs a market `aggTrade`), because events from different services may share a `T` but differ in `E`.

### A.3.4 Event: `listenKeyExpired`

```json
{
  "e": "listenKeyExpired",   // event type
  "E": 1736996475556,        // event time
  "listenKey": "WsCMN0a4KHUPTQuX6IUnqEZfB1inxmv1qR4kbf1LuEjur5VdbzqvyxqG9TSjVVxv"
}
```
Binance's own notes: not related to WebSocket disconnection; received **only** when a valid listenKey on the connection expires; **no more user data events** will be pushed after this until a new valid listenKey is used.

### A.3.5 Event: `ACCOUNT_UPDATE`

Pushed when balance / position / margin type changes. **Not** pushed for unfilled or cancelled orders (no position change). Only **changed** positions are included in `P`. When a FUNDING FEE hits the balance, a brief message is pushed: for **crossed** positions, `B` (the funding asset only) plus symbol, with **no** `P` entries; for **isolated** positions, `B` plus the symbol and only the affected `P` entry.

```json
{
  "e": "ACCOUNT_UPDATE",           // Event Type
  "E": 1564745798939,              // Event Time
  "T": 1564745798938,              // Transaction Time
  "a": {                           // Update Data
    "m": "ORDER",                  // Event reason type
    "B": [                         // Balances
      {
        "a": "USDT",               // Asset
        "wb": "122624.12345678",   // Wallet Balance
        "cw": "100.12345678",      // Cross Wallet Balance
        "bc": "50.12345678"        // Balance Change except PnL and Commission
      },
      { "a": "BUSD", "wb": "1.00000000", "cw": "0.00000000", "bc": "-49.12345678" }
    ],
    "P": [                         // Positions
      {
        "s": "BTCUSDT",            // Symbol
        "pa": "0",                 // Position Amount
        "ep": "0.00000",           // Entry Price
        "bep": "0",                // Breakeven Price
        "cr": "200",               // (Pre-fee) Accumulated Realized
        "up": "0",                 // Unrealized PnL
        "mt": "isolated",          // Margin Type
        "iw": "0.00000000",        // Isolated Wallet (if isolated position)
        "ps": "BOTH"               // Position Side
      }
    ],
    "S": "BTCUSDT"                 // Symbol associated with FUNDING_FEE event
  }
}
```

**`m` — event reason type (full documented enum):**
`DEPOSIT`, `WITHDRAW`, `ORDER`, `FUNDING_FEE`, `WITHDRAW_REJECT`, `ADJUSTMENT`, `INSURANCE_CLEAR`, `ADMIN_DEPOSIT`, `ADMIN_WITHDRAW`, `MARGIN_TRANSFER`, `MARGIN_TYPE_CHANGE`, `ASSET_TRANSFER`, `OPTIONS_PREMIUM_FEE`, `OPTIONS_SETTLE_PROFIT`, `AUTO_EXCHANGE`, `COIN_SWAP_DEPOSIT`, `COIN_SWAP_WITHDRAW`

**Field notes for position tracking:**
- **`pa` (Position Amount) is signed**: positive = long, negative = short, `"0"` = flat. Sign carries the direction — do not take an absolute value.
- **`ps` (Position Side)** is `BOTH` in one-way mode, or `LONG` / `SHORT` in hedge mode. **`(s, ps)` is the composite primary key of a position.** In hedge mode you can hold a LONG and a SHORT for the same symbol simultaneously. Keying positions by `s` alone silently merges two opposite positions into one — a severe bug. Always key by `(s, ps)`.
- **`ep` (Entry Price)** is the position entry price. `bep` is the breakeven price (documented: "breakeven price"). **`bep` is frequently `"0"`** in practice, including in Binance's own examples — treat `0` as "not available", never as a real price.
- **`cr` is (pre-fee) accumulated realized PnL** for the position, not a per-trade figure.
- **`up` is unrealized PnL.**
- **`mt` is `isolated` or `crossed`** (lowercase in the payload; the `MARGIN_CALL` event uses uppercase `CROSSED` — inconsistent casing across events, so normalize).
- **`iw` is the isolated wallet balance**, relevant only when `mt == "isolated"`.
- **`wb` vs `cw`**: `wb` = wallet balance for the asset; `cw` = **cross** wallet balance. For a cross-margin account, margin math uses `cw`, not `wb`. Using `wb` on a cross account overstates available margin.
- **`bc` = balance change excluding PnL and commission** — useful for reconciling transfers/fees separately from trading results.
- `ACCOUNT_UPDATE` is a **delta** event; it only carries changed positions. Apply updates into your local state map; never treat it as a full snapshot. Seed from REST on startup and after any reconnect.

### A.3.6 Event: `MARGIN_CALL`

Pushed when the position risk ratio is too high. Binance explicitly cautions: this is **risk guidance information only, not recommended for investment strategies**, and in a highly volatile market the position **may already have been liquidated** by the time it arrives. **Treat it as a late notification, not a pre-liquidation warning you can trade on.**

```json
{
  "e": "MARGIN_CALL",      // Event Type
  "E": 1587727187525,      // Event Time
  "cw": "3.16812045",      // Cross Wallet Balance (only pushed with crossed position margin call)
  "p": [                   // Position(s) of Margin Call
    {
      "s": "ETHUSDT",      // Symbol
      "ps": "LONG",        // Position Side
      "pa": "1.327",       // Position Amount
      "mt": "CROSSED",     // Margin Type
      "iw": "0",           // Isolated Wallet (if isolated position)
      "mp": "187.17127",   // Mark Price
      "up": "-1.166074",   // Unrealized PnL
      "mm": "1.614445"     // Maintenance Margin Required
    }
  ]
}
```
**Fields:** `cw` = cross wallet balance (only present for a crossed-position margin call); `p[]` = affected positions with `s`, `ps`, `pa`, `mt` (**uppercase `CROSSED`/`ISOLATED` here**), `iw`, `mp` (mark price), `up` (unrealized PnL), `mm` (**maintenance margin required**). Risk-metric use: compare `up` against `mm` — liquidation looms when `up` approaches `-mm` relative to margin.

### A.3.7 Event: `ACCOUNT_CONFIG_UPDATE`

Two mutually exclusive payload variants, discriminated by whether `ac` or `ai` is present.

**Variant 1 — leverage of a symbol changed (`ac`):**
```json
{
  "e": "ACCOUNT_CONFIG_UPDATE",   // Event Type
  "E": 1611646737479,             // Event Time
  "T": 1611646737476,             // Transaction Time
  "ac": {
    "s": "BTCUSDT",               // symbol
    "l": 25                       // leverage
  }
}
```

**Variant 2 — Multi-Assets margin mode changed (`ai`):**
```json
{
  "e": "ACCOUNT_CONFIG_UPDATE",
  "E": 1611646737479,
  "T": 1611646737476,
  "ai": {
    "j": true                     // Multi-Assets Mode
  }
}
```
Note `ACCOUNT_CONFIG_UPDATE` has **no `a` wrapper** (unlike `ACCOUNT_UPDATE`). Your parser must handle both shapes. This event is important for a bot because leverage changes alter liquidation distance — reflect `ac.l` into your risk model immediately rather than caching it at startup.

### A.3.8 Event: `ORDER_TRADE_UPDATE` — full field reference

Pushed when an order is created or its status changes.

**Top level:**
```json
{
  "e": "ORDER_TRADE_UPDATE",   // Event Type
  "E": 1568879465651,          // Event Time
  "T": 1568879465650,          // Transaction Time
  "o": { ... }
}
```

**The `o` object — every documented field:**

```json
"o": {
  "s":  "BTCUSDT",              // Symbol
  "c":  "TEST",                 // Client Order Id
  "S":  "SELL",                 // Side
  "o":  "TRAILING_STOP_MARKET", // Order Type
  "f":  "GTC",                  // Time in Force
  "q":  "0.001",                // Original Quantity
  "p":  "0",                    // Original Price
  "ap": "0",                    // Average Price
  "sp": "7103.04",              // Stop Price (ignore with TRAILING_STOP_MARKET)
  "x":  "NEW",                  // Execution Type
  "X":  "NEW",                  // Order Status
  "i":  8886774,                // Order Id
  "M":  "44444",                // modifyId (only for AMENDMENT when modifyId was provided)
  "l":  "0",                    // Order Last Filled Quantity
  "z":  "0",                    // Order Filled Accumulated Quantity
  "L":  "0",                    // Last Filled Price
  "N":  "USDT",                 // Commission Asset
  "n":  "0",                    // Commission
  "T":  1568879465650,          // Order Trade Time
  "t":  0,                      // Trade Id
  "b":  "0",                    // Bids Notional
  "a":  "9.91",                 // Ask Notional
  "m":  false,                  // Is this trade the maker side?
  "R":  false,                  // Is this reduce only
  "wt": "CONTRACT_PRICE",       // Stop Price Working Type
  "ot": "TRAILING_STOP_MARKET", // Original Order Type
  "ps": "LONG",                 // Position Side
  "cp": false,                  // If Close-All, pushed with conditional order
  "AP": "7476.89",              // Activation Price, only with TRAILING_STOP_MARKET
  "cr": "5.0",                  // Callback Rate, only with TRAILING_STOP_MARKET
  "pP": false,                  // If price protection is turned on
  "si": 0,                      // ignore
  "ss": 0,                      // ignore
  "rp": "0",                    // Realized Profit of the trade
  "V":  "EXPIRE_TAKER",         // STP mode
  "pm": "OPPONENT",             // Price match mode
  "gtd": 0,                     // TIF GTD order auto-cancel time
  "er": "0"                     // Expiry Reason
}
```

**Field-by-field meaning:**

| Field | Meaning | Notes for a bot |
|---|---|---|
| `s` | Symbol | Uppercase. |
| `c` | Client Order Id | Your correlation key back to your own order intent. **Not unique across order types** — reuse is possible, so prefer `i` as the hard key. |
| `S` | Side | `BUY` \| `SELL`. |
| `o` | Order Type | `LIMIT`, `MARKET`, `STOP`, `STOP_MARKET`, `TAKE_PROFIT`, `TAKE_PROFIT_MARKET`, `TRAILING_STOP_MARKET`, `LIQUIDATION`. |
| `f` | Time in Force | `GTC`, `IOC`, `FOK`, `GTX`. Empty/absent for MARKET orders. |
| `q` | Original Quantity | The requested size, unchanged by partial fills. Compare with `z` for fill progress. |
| `p` | Original Price | `"0"` for MARKET orders — do not treat `0` as a price. |
| `ap` | **Average Price** | Running average fill price. This is the price to use for realized-PnL math, and it is a **different concept** from `@markPrice`'s `ap`. |
| `sp` | Stop Price | **Ignore for `TRAILING_STOP_MARKET`** (Binance explicitly says so) — the trailing stop's live trigger is derived from `AP` + `cr`, not `sp`. |
| `x` | **Execution Type** | What *caused this push*: `NEW`, `CANCELED`, `CALCULATED` (liquidation execution), `EXPIRED`, `TRADE`, `AMENDMENT` (order modified). |
| `X` | **Order Status** | The order's *current lifecycle state* — see the dedicated section below. |
| `i` | Order Id | Authoritative unique order identifier. Use as the primary key. |
| `M` | modifyId | Only pushed on `AMENDMENT` when a `modifyId` was supplied in the request. Correlate modifications with it. |
| `l` | **Order Last Filled Quantity** | Quantity filled by **this single** execution. Zero on non-TRADE events. |
| `z` | **Order Filled Accumulated Quantity** | Total filled so far across all executions. The authoritative fill total. |
| `L` | **Last Filled Price** | Price of the fill referenced by this event. Zero when not a TRADE. |
| `N` | Commission Asset | Asset the commission is charged in (e.g. `USDT`). |
| `n` | Commission | Commission amount, denominated in `N`. Typically `"0"` except on `TRADE`. |
| `T` | Order Trade Time | Trade timestamp. Equals event `E`/`T` on non-trade events. |
| `t` | Trade Id | Exchange trade ID. **`0` on non-TRADE events** — use `t != 0` to detect genuine fills and to de-duplicate. |
| `b` | Bids Notional | Notional on the bid side at execution; supports implementation-shortfall analysis. |
| `a` | Ask Notional | Notional on the ask side at execution. |
| `m` | Is this trade the maker side? | `true` ⇒ **your** order was the maker (you earned the maker fee / rebate). Same semantic direction as `aggTrade.m` but from *your* perspective — do not mix them up. |
| `R` | **Is Reduce Only** | Boolean. `true` ⇒ the order can only reduce an existing position, never open/increase one. See dedicated note below. |
| `wt` | Stop Price Working Type | `MARK_PRICE` or `CONTRACT_PRICE` — which price the stop is evaluated against. Critical: liquidation/stop backtests differ by this setting. |
| `ot` | Original Order Type | The type before modification; differs from `o` when an order was amended. |
| `ps` | Position Side | `BOTH` (one-way) \| `LONG` \| `SHORT` (hedge). Part of the position key. |
| `cp` | If Close-All | `true` ⇒ this conditional order closes the entire position (`closePosition=true`), so its quantity tracks the position size rather than a fixed `q`. |
| `AP` | Activation Price | Only for `TRAILING_STOP_MARKET` — the price at which trailing begins. |
| `cr` | Callback Rate | Only for `TRAILING_STOP_MARKET` — the trail distance (rate or absolute). |
| `pP` | Price protection on | `true` ⇒ price protection is enabled for this order. |
| `si` | ignore | Binance explicitly marks as ignore. |
| `ss` | ignore | Binance explicitly marks as ignore. |
| `rp` | **Realized Profit of the trade** | Realized PnL booked by this fill. `"0"` when the fill didn't close exposure. **Note it is pre-fee** in the sense that `n` (commission) is separate — net realized = `rp - n` (converted to a common asset if `N` differs). For an OPENING trade `rp` is normally `"0"`. |
| `V` | **STP mode** | Self-Trade Prevention mode in effect: typically `NONE`, `EXPIRE_TAKER`, `EXPIRE_MAKER`, `EXPIRE_BOTH`. Documented example value `EXPIRE_TAKER`. Explains why an order may expire rather than fill. |
| `pm` | **Price match mode** | Documented example `OPPONENT`. Values follow the price-match modes: `NONE`, `OPPONENT`, `OPPONENT_5`, `OPPONENT_10`, `OPPONENT_20`, `QUEUE`, `QUEUE_5`, `QUEUE_10`, `QUEUE_20`. |
| `gtd` | TIF GTD auto-cancel time | Auto-cancel time for `GTD` time-in-force orders; `0` otherwise. |
| `er` | **Expiry Reason** | Why an order expired/was cancelled — see the enum below. |

**`er` — Expiry Reason enum (documented):**
| Value | Meaning |
|---|---|
| `0` | None (default) |
| `1` | Order expired to prevent users from inadvertently trading against themselves |
| `2` | IOC order could not be filled completely; remaining quantity canceled |
| `3` | IOC order could not be filled completely, to prevent self-trading; remaining quantity canceled |
| `4` | Order canceled, knocked out by another higher-priority RO (market) order, or reversed positions would be opened |
| `5` | Order expired when the account was liquidated |
| `6` | Order expired as GTE condition unsatisfied |
| `7` | Order canceled because the symbol is delisted |
| `8` | Initial order expired after the stop order was triggered |
| `9` | Market order could not be filled completely; remaining quantity canceled |

**Special client order IDs — how to recognize forced closes.** Binance encodes the origin of system-generated orders in `c`:
- `c` starts with **`autoclose-`** → a **liquidation** order. Binance notes `X` shows as `NEW` in this case.
- `c == "adl_autoclose"` → an **ADL (Auto-Deleveraging)** auto-close order; `X` shows as `NEW`.
- `c` starts with **`settlement_autoclose-`** → a **settlement** order for delisting or delivery.

**Detecting liquidation/ADL is mandatory for risk control** — it means your risk model has already failed, and it must trigger an immediate halt/review rather than being treated as a normal fill. Detect it from the `c` prefix, and additionally note `x == "CALCULATED"` for liquidation executions.

#### `X` — Order Status enum values

The documented UM Futures order-status enum:

| `X` value | Meaning |
|---|---|
| `NEW` | Order accepted, resting on the book (or just created). |
| `PARTIALLY_FILLED` | Some quantity filled, remainder still working. |
| `FILLED` | Fully filled — terminal. |
| `CANCELED` | Cancelled by the user or the system — terminal. |
| `EXPIRED` | Expired (e.g. IOC/FOK unfilled remainder, STP expiry, GTE unsatisfied) — terminal. |
| `EXPIRED_IN_MATCH` | Expired in the matching engine — terminal. |

Notes and cautions:
- **Terminal states are `FILLED`, `CANCELED`, `EXPIRED`, `EXPIRED_IN_MATCH`.** Only these should retire an order from your working set. `NEW` and `PARTIALLY_FILLED` are non-terminal.
- **Liquidation and ADL orders surface with `X == "NEW"`** per Binance's note, so `X` alone cannot classify them — combine with the `c` prefix and `x == "CALCULATED"`. This is a genuine trap: a simple state machine driven only by `X` will see a liquidation arrive as `NEW`.
- Older/historical documentation for Binance USDⓈ-M futures also listed `REJECTED`, `NEW_INSURANCE`, and `NEW_ADL`. These are **not** in the current documented enum for UM futures, but defensive parsers should tolerate unknown values rather than crashing on them — **always treat an unrecognized `X` as non-terminal and log it**, so an API addition cannot silently drop order state.
- `x` ≠ `X`. **`x` = execution type (why this event fired); `X` = current order status.** A single order lifecycle produces multiple events where `X` progresses while `x` describes each trigger — e.g. `x=NEW, X=NEW` → `x=TRADE, X=PARTIALLY_FILLED` → `x=TRADE, X=FILLED`. A handler that filters on `X == "NEW"` to mean "order just created" is wrong, because liquidation/ADL also report `X == "NEW"`; filter on `x == "NEW"` for that purpose.

#### `R` — Is Reduce Only

`R` is a **boolean** stating whether the order is a reduce-only order.

- `R == true` ⇒ the order can only **decrease** an existing position. If the position is already flat (or the side/position-side combination cannot reduce), the exchange will **not** open exposure; the order either does nothing or expires.
- `R == false` ⇒ a normal order that may open or increase exposure.

**Why it matters to a bot:**
1. **Risk invariant.** A reduce-only order can never flip your position through zero. If your intent is de-risking, you should require `R == true`; conversely, if you place a "close" order with `R == false`, a double-fill or a race with another close can **flip you into the opposite position**. Prefer reduce-only for all exit legs.
2. **Idempotency.** Because reduce-only orders are clamped to the position, re-sending a close after a partial fill cannot over-close. This makes recovery after a reconnect much safer.
3. **Interaction with `cp` (close-all).** `closePosition=true` implies close-all semantics and works with `cp`. When `cp == true`, the order's quantity is tied to the position rather than `q`. For hedge mode, `closePosition` and `reduceOnly` are **mutually exclusive** in Binance's order API — validate before sending.
4. **Interaction with throttling.** Binance's `-1008` system-overload throttle **exempts** reduce-only / close-position orders (`closePosition=true`, or `positionSide=BOTH` with `reduceOnly=true`, or `LONG+SELL`, or `SHORT+BUY`). **Design exit paths to be recognized as reduce-only so they still get through during congestion.** This is the single most operationally valuable consequence of `R`.
5. **Interaction with STP.** `V` tells you the STP mode; if reduce-only orders are being `EXPIRE`d, check whether `V` and the order's STP setting are causing it.

**Reconciliation rule:** compare `z` (accumulated filled) against `q` (original) to compute remaining size, and use `ap` for average fill price. After any reconnect or `listenKeyExpired`, re-fetch open orders from REST — **`ORDER_TRADE_UPDATE` is an event feed, not a state store, and events were lost during the gap.**

---

## A.4 Connection management

### A.4.1 Ping/pong and idle timeout

Official behaviour for the WebSocket market streams / user data streams:

- The server sends a **`ping` frame every 3 minutes**.
- If the server does **not** receive a **`pong` frame back within a 10 minute period**, the connection **is disconnected**.
- **Unsolicited `pong` frames are allowed** — the client may send pong frames at a frequency higher than every 15 minutes to keep the connection alive.

**Implementation requirements:**
1. **You must respond to server pings with pong frames.** Most mature WebSocket libraries (Python `websockets`, Node `ws`, Go `gorilla/websocket`, .NET `ClientWebSocket` via keepalive) handle this automatically. **If your library does not, you must implement it manually** — a client that ignores ping frames will be disconnected roughly every 10 minutes.
2. Pings are **WebSocket control frames at the protocol level, not JSON messages.** Do not expect a `{"method":"ping"}` payload on market streams, and do not try to parse them as data. Also do not confuse them with the REST `GET /fapi/v1/ping` (a connectivity check) or with `PUT /fapi/v1/listenKey` (the listenKey keepalive) — these are three unrelated "pings".
3. **Application-level liveness must be separate from protocol-level liveness.** Because a routed-URL mistake yields an open-but-silent socket (see A.0), a TCP/WS-level "connected" flag is not sufficient. Implement an **application-level heartbeat**: track the timestamp of the last received data message per stream; if no message arrives within a threshold appropriate to that stream's update speed (e.g. >3× the expected interval: 3 s for `markPrice@1s`, ~10 s for `@ticker`, ~30 s for a 1m kline that only updates while forming), consider the stream stale and reconnect. Without this, the silent-routing failure mode is undetectable.

### A.4.2 The 24-hour connection limit

**A single connection is valid for only 24 hours; expect to be disconnected at the 24-hour mark.** This applies to both market-stream and user-data connections, and it is stated independently on both the market streams and user-data streams documentation pages.

**Handling:**
1. **Proactively reconnect at ~23 hours** rather than waiting to be dropped. A planned reconnect at a moment of your choosing is far safer than an unplanned one mid-order. Track connection start time and set a timer.
2. The limit is on **connection age**, not on idle time — an extremely active connection is still dropped at 24 h.
3. The drop may present as an abrupt close **without** a close frame, so do not rely on receiving a graceful close notification. Treat "socket closed" and "socket errored" identically in your reconnect path.
4. **On reconnect, always resynchronize state.** Market data: re-subscribe and backfill closed klines from REST. User data: obtain a fresh listenKey, and re-fetch open orders/positions/balance. The 24-hour reconnect is the single most likely moment for a bot to silently diverge from reality, so make reconciliation a mandatory part of the reconnect routine, not a best-effort extra.

### A.4.3 Reconnect logic with exponential backoff

Recommended structure:

- **Full jitter exponential backoff.** Delay for attempt *n*: `min(cap, base * 2^n)` then apply **jitter**. Prefer "full jitter" (`sleep = random(0, min(cap, base*2^n))`) or "equal jitter" (`sleep = min(cap, base*2^n)/2 + random(0, min(cap, base*2^n)/2)`) so that many bot instances reconnecting after a shared outage do not stampede the server in lockstep. Suggested: `base ≈ 500 ms`, `cap ≈ 30–60 s`, max attempts before escalating to an alert.
- **Reset the backoff counter only after a *successful, verified* connection** — i.e. after receiving at least one real data message (or a successful `SUBSCRIBE` ack), not merely after the handshake. Given the silent-routing failure mode, resetting on handshake alone creates a tight reconnect loop against a URL that will never deliver data.
- **Distinguish error classes.** A clean close (code 1000) or a planned 24 h rotation should reconnect **immediately** with no backoff. Network errors, unexpected closes, and idle timeouts should back off. An HTTP 4xx during the WS upgrade (e.g. 403 WAF block, 429) should back off **hard** and additionally respect any `Retry-After`; ignoring this escalates to an IP ban (see A.5).
- **Never reconnect in an unbounded tight loop.** A misconfigured URL or a banned IP will otherwise generate thousands of connection attempts per minute and deepen the ban.
- **Re-subscribe on reconnect.** Subscriptions are per-connection and are **not** restored automatically. Either rebuild the subscription set into the connect URL (`/stream?streams=...` is the most robust, since it needs no post-connect round trip) or re-issue `SUBSCRIBE` frames and wait for the ack before considering the stream live.
- **Order the reconnect sequence for user data:** `POST /fapi/v1/listenKey` → open socket → **reconcile via REST** → resume. Do not resume trading until reconciliation completes; the position you believe you hold may be wrong.
- **Guard against duplicate connections.** If a reconnect races with a still-alive socket (e.g. a slow close), you can end up with two connections and double-counted events. Ensure the old socket is fully torn down (close + await termination, with a timeout) before dialing a new one.
- **Watchdog, not just retry.** Beyond reconnect logic, run a separate watchdog that alerts if the bot has not received a market data message in N seconds or a user data event within the expected window, because the most dangerous failures here are silent.

---

## A.5 WebSocket rate limits and subscription limits

All figures from the official WebSocket market streams "Connect" page.

| Limit | Value |
|---|---|
| Inbound messages per connection | **10 incoming messages per second** |
| Consequence of exceeding | **Connection is disconnected**; IPs that are **repeatedly** disconnected **may be banned** |
| Streams per connection | **1024 maximum** |
| Server ping interval | every **3 minutes** |
| Pong deadline | **10 minutes** (else disconnected) |
| Connection lifetime | **24 hours** |
| Unsolicited pongs | Allowed |

**What counts toward the 10/sec inbound limit:** messages **you send** to the server — `SUBSCRIBE`, `UNSUBSCRIBE`, `LIST_SUBSCRIPTION`, `SET_PROPERTY`, `GET_PROPERTY` frames. It does **not** count the market data the server pushes to you, so a busy data feed does not consume this budget. The practical risk is **subscription churn**: a loop that subscribes/unsubscribes per symbol on a timer can trivially exceed 10 msg/s.

**Recommended practices:**
- **Subscribe in bulk.** One `SUBSCRIBE` with many params in a single JSON array message instead of N separate messages. This is both faster and far cheaper against the 10/s budget.
- **Throttle and batch dynamic subscriptions.** If symbols change at runtime, queue changes and flush at a bounded rate (e.g. ≤5 messages/s), keeping headroom below 10.
- **Prefer URL-based subscription.** Building the full stream list into `/stream?streams=a/b/c` avoids post-connect subscribe traffic entirely and makes reconnects deterministic.
- **Split across connections by traffic class**, as Binance recommends: `/public` (depth/bookTicker, the highest message volume), `/market` (kline/markPrice/ticker), `/private` (user data). This both mirrors the new routing and keeps any single connection well under 1024 streams and its message budget manageable. Keep the private user-data socket **isolated** — you never want a flood of depth data delaying an `ORDER_TRADE_UPDATE`.
- **Stay well under 1024 streams.** Because a single symbol can consume several streams (`@depth20@100ms`, `@aggTrade`, `@kline_1m`, `@markPrice@1s` = 4 streams), 1024 is reachable with ~250 symbols. Plan the sharding of symbols across connections before you hit the ceiling, not after.

**Server-side disconnect handling:** the disconnect reason is not always delivered as a readable error. Because repeatedly disconnecting can escalate to an IP ban, your backoff must **increase** across successive failures rather than resetting to a fast retry. Log every server-initiated close with its code and reason; a repeating pattern of a specific code is the fastest way to find a subscription or rate-limit bug.

### Related REST-side limits (needed by the same bot)

WebSocket streams are strongly recommended over REST for market data and for order/position status, because REST can lag under volatile conditions and consumes IP-weighted budget. Key REST facts:

- Rate limits are enforced **per IP**, not per API key. `X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)` response headers report current usage; `X-MBX-ORDER-COUNT-(intervalNum)(intervalLetter)` reports order counts (counted **per account**).
- HTTP `429` = rate limit broken; **you must back off**. HTTP `418` = IP auto-banned; ban durations **scale from 2 minutes to 3 days** for repeat offenders.
- `listenKey` create/keepalive/close each cost **weight 1**, so a 30-minute keepalive is negligible.
- `recvWindow` defaults to **5000 ms** and Binance recommends **≤5000**; the signature must be the last part of the query string/body, and `totalParams` = query string concatenated with request body.
- Error payload shape: `{"code": -1121, "msg": "Invalid symbol."}`. Notable codes: **`-1125`** = listenKey does not exist (recreate it); **`-1008`** = system-level throttle (reduce-only/close-position orders exempt).
- **HTTP 503 is ambiguous and must be handled carefully.** "Unknown error, please check your request or try again later." means the request was accepted but no response arrived in time — **execution status is UNKNOWN and it may have succeeded**. Do **not** blindly retry; verify via the WebSocket user data stream or an order query first, or you risk duplicate orders. "Service Unavailable." and the `-1008` throttle, by contrast, are definite failures that are safe to retry with backoff (Binance suggests 200 ms → 400 ms → 800 ms, max 3–5 attempts).

---

# Part B — LLM Provider HTTP APIs

## B.0 ⚠️ Read this before using the model names in the original brief

**Every model name assumed in the task brief is now stale.** Current official documentation (verified live, 2026-09) lists:

| Provider | Names assumed in brief | **Actual current documented IDs** |
|---|---|---|
| OpenAI | `gpt-5`, `gpt-4.1`, `gpt-4o`, `o3` | **`gpt-6-astra`** (flagship), `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` |
| Anthropic | `claude-sonnet-4-5`, `claude-opus-4-1` | **`claude-opus-5`**, `claude-sonnet-5`, `claude-fable-5-1`, `claude-haiku-4-5` |
| DeepSeek | `deepseek-chat`, `deepseek-reasoner` | **`deepseek-flash`**, `deepseek-v4-pro` (`deepseek-chat`/`deepseek-reasoner` **discontinued 2026-07-24**) |
| Google | `gemini-2.5-pro`, `gemini-2.0-flash` | **`gemini-3.8-flash`**, `gemini-3.7-flash`, `gemini-3.1-pro-preview` |
| xAI | `grok-4`, `grok-3`, `grok-2-1212` | **`grok-4.6`**, `grok-4.5`, `grok-4.3` |
| Moonshot | `moonshot-v1-8k`, `kimi-k2-0711-preview` | **`kimi-k3`**, `kimi-k2.7-code`, `kimi-k2.6` |
| MiniMax | `abab6.5s-chat`, `MiniMax-Text-01` | **`MiniMax-M3`**, `MiniMax-M2.7`, `MiniMax-M2.5`, `MiniMax-M2.1` |
| Qwen | `qwen-max`, `qwen-plus`, `qwen-turbo` | **`qwen3.8-max`**, `qwen3.7-plus`, `qwen3.8-flash` (older aliases still served) |

Two other structural changes matter for architecture:

1. **OpenAI's docs moved** from `platform.openai.com/docs` (now returns HTTP 403 to non-browser clients) to **`developers.openai.com`**, where every page has a `.md` twin (append `.md`). The Responses API is now the vendor-preferred surface, though Chat Completions remains fully documented and supported.
2. **Several vendors now ship an OpenAI-compatible *and* an Anthropic-compatible endpoint** in addition to their native one (DeepSeek: `https://api.deepseek.com/anthropic`; Kimi: `.../anthropic/v1/messages`; MiniMax: `https://api.minimax.io/anthropic`). Google also ships an OpenAI-compatible surface. **This materially simplifies a provider-agnostic layer** — see B.9.

**Verification:** OpenAI's `developers.openai.com/api/docs/models.md`, Anthropic's `platform.claude.com/docs/en/models/overview.md`, `docs.x.ai/developers/models`, and `ai.google.dev/gemini-api/docs/models` were each fetched directly and confirm the table above.

---

## B.1 OpenAI (and all OpenAI-compatible servers)

This is the reference dialect. Most providers below speak it, so get this shape exactly right once and reuse it.

- **Base URL:** `https://api.openai.com/v1`
- **Endpoint:** `POST /chat/completions` → `https://api.openai.com/v1/chat/completions`
- **Auth header:** `Authorization: Bearer $OPENAI_API_KEY`
  - Optional: `OpenAI-Organization: $ORG_ID`, `OpenAI-Project: $PROJECT_ID`, `X-Client-Request-Id` (ASCII, ≤512 chars)

**Request body (documented parameters):**
```json
{
  "model": "gpt-6-astra",
  "messages": [
    {"role": "developer", "content": "You are a terse trading assistant."},
    {"role": "user", "content": "Summarize BTC funding."}
  ],
  "max_completion_tokens": 1024,
  "temperature": 0.2,
  "top_p": 1,
  "stop": ["\n\n"],
  "seed": 42,
  "stream": false,
  "stream_options": {"include_usage": true},
  "response_format": {"type": "text"},
  "reasoning_effort": "medium",
  "verbosity": "low",
  "service_tier": "auto"
}
```

Key parameter notes:
- **`max_completion_tokens` is preferred; `max_tokens` is "now deprecated in favor of `max_completion_tokens`, and is not compatible with o-series models."** `max_completion_tokens` is an upper bound that **includes reasoning tokens** — a reasoning model can consume the entire budget before emitting any visible text, leaving `content` empty with `finish_reason: "length"`.
- `stop` accepts **up to 4** sequences and is "Not supported with latest reasoning models o3 and o4-mini".
- `seed` is a Beta best-effort determinism knob; verify via `system_fingerprint`.
- `stream_options.include_usage` emits one extra chunk **before** `data: [DONE]` with an **empty `choices` array** carrying total `usage`; all other chunks carry `usage: null`.
- Messages roles: `developer | system | user | assistant | tool | function`.

**Response shape (non-streaming):**
```json
{
  "id": "chatcmpl-...", "object": "chat.completion", "created": 1694268190,
  "model": "gpt-6-astra", "system_fingerprint": "fp_...", "service_tier": "default",
  "choices": [{
    "index": 0,
    "finish_reason": "stop",
    "logprobs": null,
    "message": {"role": "assistant", "content": "…", "refusal": null,
                "annotations": [], "tool_calls": null}
  }],
  "usage": {
    "prompt_tokens": 42, "completion_tokens": 128, "total_tokens": 170,
    "prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
    "completion_tokens_details": {"reasoning_tokens": 64}
  }
}
```

- **Assistant text path: `choices[0].message.content`**
- **Refusal path: `choices[0].message.refusal`** — check this, because a refusal can leave `content` empty/`null` with a *successful* HTTP 200.
- **Streaming delta path: `choices[0].delta.content`**; chunks are `"object": "chat.completion.chunk"`; terminator is the literal line **`data: [DONE]`**.
- Streaming: the final content chunk carries `delta: {}` with a non-null `finish_reason`.

**System prompt:** `{"role": "system", "content": "…"}`. **For o1 models and newer, `developer` messages replace `system` messages** — `{"role": "developer", …}`, prioritized ahead of user messages. A provider-agnostic layer should emit `developer` for OpenAI reasoning-era models and `system` elsewhere.

**JSON mode (loose):**
```json
"response_format": {"type": "json_object"}
```
Documented requirement: *"the model will not generate JSON without a system or user message instructing it to do so."* The literal enforcement error is `'messages' must contain the word 'json' in some form, to use 'response_format' of type 'json_object'` → **400 `invalid_request_error`, `param: "messages"`**. The documented failure symptom when you omit the instruction is severe: *"an unending stream of whitespace … until it reaches the token limit."* **Always both set `response_format` AND include the word "JSON" plus an example in the prompt.**

**Structured output (strict JSON schema):**
```json
"response_format": {
  "type": "json_schema",
  "json_schema": {
    "name": "signal",
    "strict": true,
    "schema": {
      "type": "object",
      "properties": {
        "action": {"type": "string", "enum": ["BUY", "SELL", "HOLD"]},
        "confidence": {"type": "number"}
      },
      "required": ["action", "confidence"],
      "additionalProperties": false
    }
  }
}
```
- `strict: true` means the model follows the exact schema. When strict, **only a subset of JSON Schema is supported**; `additionalProperties: false` must be set on every object, and all properties must appear in `required`.
- Model support: `json_schema` is supported "only with the `gpt-4o-mini`, `gpt-4o-mini-2024-07-18`, and `gpt-4o-2024-08-06` model snapshots **and later**". Earlier models use `json_object` mode only.

**Current model IDs:** `gpt-6-astra` (flagship, 1,050,000-token context, 128k max output, knowledge cutoff Apr 30 2026), `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. Still available but superseded: `gpt-5.5`, `gpt-5.4`/`-mini`/`-nano`, `gpt-5.3-chat-latest`, `gpt-5.2`, `gpt-5.1`, `gpt-5`, `gpt-4.1` ("Smartest non-reasoning model"), `gpt-4o`, `o3` ("Reasoning model for complex tasks, succeeded by GPT-5"), `o4-mini`, `o1`.

**Errors:** envelope `{"error": {…}}`; the inner object is `{"code": string|null, "message": string, "param": string|null, "type": string}`.

**Timeout:** the official Python SDK default is **10 minutes** (`httpx.Timeout(timeout=600, connect=5.0)`), with `DEFAULT_MAX_RETRIES = 2` and retries on 408/409/429/≥500, capped by `MAX_RETRY_AFTER_DELAY = 120s`. Per-request override: `client.with_options(timeout=5.0)`.

Sources: [Chat reference](https://developers.openai.com/api/reference/resources/chat.md), [models](https://developers.openai.com/api/docs/models.md), [rate limits](https://developers.openai.com/api/docs/guides/rate-limits.md), [error codes](https://developers.openai.com/api/docs/guides/error-codes.md).

---

## B.2 DeepSeek

- **Base URL:** `https://api.deepseek.com` — **note: no `/v1` segment** in any official sample. Endpoint: `POST /chat/completions` → `https://api.deepseek.com/chat/completions`.
- **Anthropic-format base:** `https://api.deepseek.com/anthropic`
- **Auth header:** `Authorization: Bearer $DEEPSEEK_API_KEY`, `Content-Type: application/json`

**Request body** (OpenAI-shaped, with DeepSeek-specific additions):
```json
{
  "model": "deepseek-flash",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "thinking": {"type": "enabled"},
  "reasoning_effort": "high",
  "max_tokens": 4096,
  "temperature": 0.2,
  "top_p": 0.95,
  "stream": false,
  "response_format": {"type": "text"}
}
```

DeepSeek-specific parameters and quirks:
- **`thinking: {"type": "enabled" | "disabled"}`** — DeepSeek's own switch between thinking and non-thinking mode (default `enabled`).
- **`reasoning_effort`: `none | low | high | max`** (default `high`). For compatibility, `minimal` is mapped to `low`, and `medium`/`xhigh` are mapped to `high`.
- **`max_tokens`** (not `max_completion_tokens`): integer **1–393216**. Default is 8K in non-thinking mode, 64K in thinking mode, 128K with `reasoning_effort: "max"`.
- **`temperature` has no effect in thinking mode.** `top_p` in thinking mode has a floor of 0.95 (values below are raised); in non-thinking mode it is fixed at 1.0 and the value you pass is ignored.
- **`tool_choice: "required"` and named tool choices are not supported in thinking mode** → 400. `tool_choice: "auto"`/`"none"` are fine.
- **`frequency_penalty` and `presence_penalty` are deprecated and have no effect.**
- `stop` accepts **up to 16** sequences. `user_id` (not `user`) is DeepSeek's identity field, regex `[a-zA-Z0-9\-_]+`, max 512 — **with the OpenAI SDK you must pass it via `extra_body={"user_id": ...}`**, since the SDK doesn't know the field.
- `stream_options.include_usage` **requires `stream: true`**, else 400.
- **No `seed` parameter is documented.**

**Response shape:** OpenAI-compatible (`object: "chat.completion"`), with `system_fingerprint` and:
```json
{
  "choices": [{
    "index": 0, "finish_reason": "stop",
    "message": {"role": "assistant", "content": "…", "reasoning_content": "…", "tool_calls": null},
    "logprobs": null
  }],
  "usage": {
    "prompt_tokens": 42, "completion_tokens": 128, "total_tokens": 170,
    "prompt_tokens_details": {"cached_tokens": 0, "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 42},
    "completion_tokens_details": {"reasoning_tokens": 64}
  }
}
```
- **Assistant text path: `choices[0].message.content`**
- **Reasoning path: `choices[0].message.reasoning_content`** (thinking mode).
- **Critical for tool use:** `reasoning_content` **must be passed back on all later turns whenever `tools` is used**, or the API returns 400.
- **`finish_reason` enum includes two values not in OpenAI's:** `insufficient_system_resource` (request interrupted due to inference-system resource shortage) and `aborted` (generation interrupted), alongside `stop | length | content_filter | tool_calls`.
- Streaming: terminated by `data: [DONE]`. With `include_usage`, **every chunk carries `usage` (null except the last), and the last chunk before `[DONE]` carries total usage on the last *content* chunk — there is no separate usage-only chunk** (its `choices` has exactly one element with a non-null `finish_reason`). This differs from OpenAI, where the usage chunk has an empty `choices` array. **A streaming parser written for OpenAI's usage-chunk convention will mis-handle DeepSeek's.** The literal delta path `choices[0].delta.content` is **[UNVERIFIED]** against DeepSeek's own reference page (that section was truncated), but it is the OpenAI-compatible path DeepSeek advertises.

**System prompt:** `{"role": "system", "content": "…"}`. Only `system | user | assistant | tool` exist — **there is no `developer` role.**

**JSON mode:** **only** `response_format: {"type": "json_object"}`. There is **no `json_schema` / strict structured output** in the OpenAI-format API. Documented requirements:
1. Set `response_format` to `{"type": "json_object"}`.
2. **Include the word "json" in the system or user prompt**, with an example of the desired JSON.
3. Set `max_tokens` sensibly to avoid truncating the JSON mid-string.
4. DeepSeek's own caveat: **"the API may occasionally return empty content"** — validate and retry.

**Current model IDs:** `deepseek-flash` (DeepSeek-V4.1-Flash, released 2026-09-10, native multimodal, 1M context, 384K max output, concurrency 2500) and `deepseek-v4-pro` (DeepSeek-V4-Pro-0813, concurrency 500). Legacy names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still *accepted* but the corresponding models are retired and requests are served by V4.1-Flash at Flash pricing. **`deepseek-chat` and `deepseek-reasoner` were discontinued 2026-07-24.**

**Errors:** HTTP `400` Invalid Format, `401` Authentication Fails, **`402` Insufficient Balance**, `422` Invalid Parameters, `429` Rate Limit Reached, `500` Server Error, `503` Server Overloaded. The exact JSON error body is **[UNVERIFIED]** (not published on the error-codes page); given DeepSeek's OpenAI-compatibility claim, `{"error":{"message","type","param","code"}}` is the expected shape.

**Rate limiting is by concurrency, not RPM/TPM:** 2500 concurrent (`deepseek-flash`) / 500 (`deepseek-v4-pro`), **account-level regardless of API key**. Exceeding → HTTP 429. **No `x-ratelimit-*` response headers are documented**, so a client cannot proactively throttle from headers and must self-limit concurrency.

**Timeout:** no published SDK default; the **server closes the connection if inference has not started within 10 minutes**. Keep-alive during that window: non-streaming returns blank lines, streaming returns SSE comments `: keep-alive` — **your SSE reader must skip comment lines.**

> **Note for this specific project:** the model serving this very session is `deepseek-v4.1-flash`, consistent with the `deepseek-flash` alias above.

Sources: [first API call](https://api-docs.deepseek.com/), [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion), [JSON Output](https://api-docs.deepseek.com/guides/json_mode), [error codes](https://api-docs.deepseek.com/quick_start/error_codes), [rate limit](https://api-docs.deepseek.com/quick_start/rate_limit).

---

## B.3 Anthropic Claude

Anthropic's API is **not** OpenAI-shaped. Auth, system-prompt placement, and the response content shape all differ.

- **Base URL:** `https://api.anthropic.com`
- **Endpoint:** `POST /v1/messages` — the single endpoint everything runs through. Also `POST /v1/messages/count_tokens`.
- **Auth headers (exactly three required):**
```
x-api-key: $ANTHROPIC_API_KEY
anthropic-version: 2023-06-01
content-type: application/json
```
- Optional `anthropic-beta: <feature>[,<feature2>]` — comma-separated; an invalid feature name returns `400 invalid_request_error`. SDKs expose this as `betas=[...]`. There is also an OAuth variant (`Authorization: Bearer <token>` plus `anthropic-beta: oauth-2025-04-20`) — **note this replaces `x-api-key`, it is not additive.**
- Docs host note: `docs.anthropic.com` and `docs.claude.com` **redirect to `platform.claude.com/docs/...`**. Append `.md` to any page for clean markdown.

**Request body:**
```json
{
  "model": "claude-opus-5",
  "max_tokens": 1024,
  "system": "You are a terse trading assistant.",
  "messages": [
    {"role": "user", "content": "Summarize BTC funding."}
  ],
  "temperature": 0.2,
  "top_p": 1,
  "stop_sequences": ["\n\n"],
  "stream": false,
  "tools": [],
  "tool_choice": {"type": "auto"},
  "metadata": {"user_id": "bot-1"}
}
```

Critical differences from the OpenAI dialect:
- **`max_tokens` is REQUIRED** (not optional). Value `0` pre-warms the prompt cache without generating.
- **`system` is a TOP-LEVEL field — there is no `"system"` role for input messages.** The reference states this verbatim. `system` may be a plain string or an array of text blocks.
- **`temperature`, `top_p`, and `top_k` are deprecated on models after Opus 4.6 and rejected with 400.** Specifically: `temperature` accepts only `1.0`, `top_p` only ≥ 0.99, and `top_k` rejects any value. **A provider-agnostic layer that forwards a user-supplied temperature will break on current Claude models** — this is one of the most likely integration failures.
- `messages` accepts up to 100,000 messages; the first must be `user`; consecutive same-role turns are merged.
- `metadata` is an opaque anti-abuse id: `{"user_id": "..."}`, maxLength 512.

**System prompt — the two exact forms:**
```json
{"model":"claude-opus-5","max_tokens":1024,
 "system":"You are a terse assistant.",
 "messages":[{"role":"user","content":"Hello, Claude"}]}
```
```json
{"model":"claude-opus-5","max_tokens":1024,
 "system":[{"type":"text","text":"<long stable instructions>",
            "cache_control":{"type":"ephemeral","ttl":"1h"}}],
 "messages":[{"role":"user","content":[{"type":"text","text":"Hi"}]}]}
```
`{"role":"user","content":"Hi"}` is shorthand for `[{"type":"text","text":"Hi"}]`. Cache breakpoints use `{"type":"ephemeral","ttl":"5m"|"1h"}`.

**Response shape — `content` is an ARRAY of typed blocks:**
```json
{
  "id": "msg_01...", "type": "message", "role": "assistant", "model": "claude-opus-5",
  "content": [
    {"type": "thinking", "thinking": "...", "signature": "..."},
    {"type": "text", "text": "Hello!"},
    {"type": "tool_use", "id": "toolu_...", "name": "get_weather", "input": {"location": "Paris"}}
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "stop_details": null,
  "usage": {"input_tokens": 1024, "output_tokens": 256,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
}
```

- **The assistant text is NOT simply `content[0].text`.** You must **filter for blocks where `type == "text"`** — a `thinking` or `redacted_thinking` block can appear first. Anthropic's own docs use `next(block.text for block in response.content if block.type == "text")`. Reading `content[0].text` blindly is a real bug that surfaces only when thinking is enabled.
- **`stop_reason` (not `finish_reason`)** — full current enum: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, **`model_context_window_exceeded`**. `refusal` populates `stop_details` with `category` (`cyber`/`bio`/`reasoning_extraction`/null) and `explanation`.
- In streaming, **`message_delta.usage` counts are cumulative** (not incremental).

**Streaming (SSE) event flow:**
`message_start` → (`content_block_start` → n× `content_block_delta` → `content_block_stop`)\* → one or more `message_delta` → `message_stop`. `ping` events may appear anywhere; mid-stream failures arrive as an `error` event.
- Delta paths by `delta.type`: `text_delta` → `.delta.text`; `input_json_delta` → `.delta.partial_json` (**a partial JSON *string*** — accumulate across deltas and parse only at `content_block_stop`; the final `tool_use.input` is a proper object); `thinking_delta` → `.delta.thinking`; `signature_delta` → `.delta.signature`.
- `stop_reason` is `null` in `message_start` and appears only in `message_delta`.
- Error event: `event: error` / `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}` — this is the mid-stream 529 case.

**Structured output — Anthropic has a native feature (not just tool-forcing):**
```json
"output_config": {
  "format": {
    "type": "json_schema",
    "schema": {
      "type": "object",
      "properties": {"name": {"type": "string"}, "demo_requested": {"type": "boolean"}},
      "required": ["name", "demo_requested"],
      "additionalProperties": false
    }
  }
}
```
The result is schema-valid JSON inside the text content block. No beta header is required. The older `output_format` field plus beta `structured-outputs-2025-11-13` is still accepted during a transition period. There is also **strict tool use** via `strict: true` on a tool definition.

Schema support: base types, `enum`, `const`, `anyOf`/`allOf` (but not `allOf` combined with `$ref`), `$ref`/`$defs`/`definitions` (no external `$ref`), `default`, `required`, `additionalProperties` (must be `false`), string formats `date-time|time|date|duration|email|hostname|uri|ipv4|ipv6|uuid`, array `minItems` 0/1. **Not supported** (→ 400): recursive schemas, complex enum values, external `$ref`, numeric constraints (`minimum`/`maximum`/`multipleOf`), string length constraints, and `additionalProperties` other than `false`.

The classic tool-forcing route (`tool_choice: {"type":"tool","name":"..."}` and parse `tool_use.input`) still works, **except on Claude Fable 5.1 and Mythos 5.1, which reject `tool_choice` `"tool"`/`"any"` with 400.** Prefer `output_config.format` for new code.

**Current model IDs:** `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`). All are 1M-context except Haiku 4.5 (200K). Legacy but available: `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`. **Every Claude model ID is a pinned snapshot from the 4.6 generation on.**

**Errors:**
```json
{"type":"error","error":{"type":"rate_limit_error","message":"..."},"request_id":"req_..."}
```
| HTTP | `error.type` |
|---|---|
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 402 | `billing_error` |
| 403 | `permission_error` |
| 404 | `not_found_error` |
| 409 | `conflict_error` |
| 413 | `request_too_large` |
| 429 | `rate_limit_error` |
| 500 | `api_error` |
| 504 | `timeout_error` |
| **529** | **`overloaded_error`** — Anthropic-specific |

**HTTP 529 has no OpenAI equivalent — your error classifier must handle it explicitly or overload will be misfiled as an unknown error.** Anthropic's SDKs auto-retry connection errors/408/409/429/5xx with exponential backoff (2 retries by default) and honor `retry-after` when present. Caveat from the docs: a tier spend-cap 429 carries **no** `retry-after` and will keep failing — backoff cannot fix it. Rate-limit headers: `anthropic-ratelimit-requests-limit|-remaining|-reset`, `...-input-tokens-*`, `...-output-tokens-*`.

Sources: [Messages reference](https://platform.claude.com/docs/en/api/messages), [models overview](https://platform.claude.com/docs/en/models/overview), [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [errors](https://platform.claude.com/docs/en/api/errors), [stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons).

---

## B.4 Google Gemini

Gemini has a **completely different REST shape** from OpenAI.

- **Base URL:** `https://generativelanguage.googleapis.com`
- **Non-streaming:** `POST /v1beta/{model=models/*}:generateContent`
  → e.g. `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`
- **Streaming:** `POST /v1beta/{model=models/*}:streamGenerateContent?alt=sse`
- The `model` **path** parameter is required, in the form `models/{model}`.

> **Structural change:** `generateContent`/`streamGenerateContent` are now documented under **"Gemini Generate Content API (Legacy)"**. Google recommends migrating to a newer **Interactions API** (`POST /v1beta/interactions`, body `{model, input, response_format:{type:"text", mime_type, schema}}`). The `generateContent` endpoints still work and are what is documented below. `?alt=sse` is verified for the endpoint shape from an official Google sample, but that sample predates the 3.x models — **[UNVERIFIED]** against current 3.x.

**Auth — two mechanisms, both officially documented:**
```bash
# Preferred: header
-H "x-goog-api-key: $GEMINI_API_KEY"

# Legacy: query param
"...?key=$GEMINI_API_KEY"
```
For the OpenAI-compatibility surface the credential is `Authorization: Bearer $GEMINI_API_KEY`.

**Request body:**
```json
{
  "systemInstruction": {"parts": [{"text": "You are a concise trading assistant."}]},
  "contents": [
    {"role": "user",  "parts": [{"text": "hi"}]},
    {"role": "model", "parts": [{"text": "hello"}]},
    {"role": "user",  "parts": [{"text": "explain funding"}]}
  ],
  "generationConfig": {
    "temperature": 0.2,
    "topP": 0.95,
    "topK": 40,
    "maxOutputTokens": 2048,
    "candidateCount": 1,
    "stopSequences": ["\n###"],
    "responseMimeType": "application/json",
    "responseSchema": {"type": "OBJECT", "properties": {}, "required": []}
  },
  "safetySettings": [
    {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_MEDIUM_AND_ABOVE"}
  ],
  "tools": [{"functionDeclarations": [{"name": "get_price", "parameters": {}}]}]
}
```

Critical shape facts:
- **`systemInstruction` is a separate TOP-LEVEL field**, not a message. Its value is a `Content` object (`{"parts":[{"text":"…"}]}`), and Google notes it is *"currently only text"*.
- **The conversation array is `contents` (not `messages`), and each entry has `parts` (not `content`).**
- **Valid `role` values are `"user"` and `"model"` — NOT `"assistant"`.** The docs are explicit: *"Must be either 'user' or 'model'. If not set, the service will default to 'user'."* If not set, it defaults to `user`.
- A `Part` is a one-of union: `text`, `inlineData` (`{mimeType, data}`), `fileData`, `functionCall`, `functionResponse`, `executableCode`, `codeExecutionResult`, `thought`, `thoughtSignature`, `videoMetadata`. Text is `{"text": "..."}`.
- All sampling and schema knobs live inside **`generationConfig`** (camelCase in REST): `temperature`, `topP`, `topK`, `candidateCount`, `maxOutputTokens`, `stopSequences`, `responseMimeType`, `responseSchema`, `responseJsonSchema`, `responseFormat`, `seed`, `frequencyPenalty`, `presencePenalty`, `logprobs`, `thinkingConfig`, `mediaResolution`, `responseModalities`, …

**Response shape:**
```json
{
  "candidates": [{
    "content": {"role": "model", "parts": [{"text": "..."}]},
    "finishReason": "STOP",
    "index": 0,
    "safetyRatings": [{"category": "...", "probability": "...", "blocked": false}]
  }],
  "usageMetadata": {"promptTokenCount": 12, "totalTokenCount": 34},
  "promptFeedback": {"blockReason": "SAFETY"}
}
```

- **Assistant text path: `candidates[0].content.parts[0].text`** (confirmed by an official Google sample: `data['candidates'][0]['content']['parts'][0]['text']`).
- **`finishReason` (not `finish_reason`)** — full enum: `FINISH_REASON_UNSPECIFIED`, `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `LANGUAGE`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `MALFORMED_FUNCTION_CALL`, `IMAGE_SAFETY`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `NO_IMAGE`, `IMAGE_PROHIBITED_CONTENT`, `IMAGE_RECITATION`, `IMAGE_OTHER`. **Gemini has no `tool_calls` finish reason — a function call is signalled by the presence of a `functionCall` part, not by `finishReason`.** This is a real trap for a normalizing layer.
- **`promptFeedback.blockReason` means the prompt itself was blocked** — a safety block. `SAFETY` is confirmed; the full enum (`BLOCK_REASON_UNSPECIFIED`, `SAFETY`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `OTHER`, `IMAGE_SAFETY`) is **[UNVERIFIED]**. Note also: *"When streaming, `content[]` is empty if content filters block the output."*
- `usageMetadata`: `promptTokenCount`, `cachedContentTokenCount`, `thoughtsTokenCount`, `toolUsePromptTokenCount`, `totalTokenCount` (= prompt + candidates + tool_use_prompt + thoughts). **Discrepancy flagged:** the current typedoc exposes `responseTokenCount`/`responseTokensDetails` while the prose still says `candidates_token_count` — the actual wire name is **[UNVERIFIED]**. Do not hard-code `candidatesTokenCount` without a defensive fallback.

**Structured output (strict schema, but OpenAPI-subset — not full JSON Schema):**
```json
"generationConfig": {
  "responseMimeType": "application/json",
  "responseSchema": {
    "type": "OBJECT",
    "properties": {
      "recipe_name": {"type": "STRING", "description": "Name of the recipe."},
      "prep_time_minutes": {"type": "INTEGER", "description": "Optional prep time."},
      "ingredients": {
        "type": "ARRAY",
        "items": {"type": "OBJECT",
          "properties": {"name": {"type": "STRING"}, "quantity": {"type": "STRING"}},
          "required": ["name", "quantity"]}
      }
    },
    "required": ["recipe_name", "ingredients"],
    "propertyOrdering": ["recipe_name", "prep_time_minutes", "ingredients"]
  }
}
```
- Supported `Schema` keys: `type`, `format`, `description`, `nullable`, `enum`, `items`, `properties`, `required`, `propertyOrdering`, plus `anyOf`, `default`, `example`, `title`, `minimum`/`maximum`, `minItems`/`maxItems`, `minLength`/`maxLength`, `minProperties`/`maxProperties`, `pattern`.
- **Type values are SCREAMING-CASE strings** (`STRING`, `NUMBER`, `INTEGER`, `BOOLEAN`, `ARRAY`, `OBJECT`) — **not** lowercase JSON Schema types. A schema written for OpenAI/Anthropic will be rejected or misread here.
- **Enums require `"format": "enum"` AND `enum: [...]`** together.
- **NOT supported:** `additionalProperties`, `$ref`/`$defs`, `allOf`. `propertyOrdering` is explicitly *"not a standard field in OpenAPI specification"*.
- **`responseMimeType: "application/json"` must be set together with the schema.** `responseMimeType` and `responseSchema` now carry a "Deprecated: Use `response_format` instead" note; newer alternatives are **`responseJsonSchema`** (*"an alternative to `response_schema` that accepts JSON Schema"*) and a `responseFormat` array field. Whether `responseJsonSchema` still requires `responseMimeType` is **[UNVERIFIED]**.

**Current model IDs:** stable — `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-3.5-transcribe`. Preview — `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-flash-live-preview`, `gemini-3.1-flash-tts-preview`, `gemini-omni-flash`. **Retiring with announced dates:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` (all shutdown 2026-10-16), `gemini-2.0-flash`/`-001`, `gemini-2.0-flash-lite` (2026-06-01). Embeddings: `gemini-embedding-2` current; `gemini-embedding-001` retires 2026-07-14.

**Errors:**
```json
{"error": {"code": 400,
  "message": "API key not valid. Please pass a valid API key.",
  "status": "INVALID_ARGUMENT",
  "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo",
               "reason": "API_KEY_INVALID", "domain": "googleapis.com",
               "metadata": {"service": "generativelanguage.googleapis.com"}}]}}
```
`code` = integer HTTP status; `status` = gRPC status in SCREAMING_CASE. Mapping: `400 INVALID_ARGUMENT` (also `FAILED_PRECONDITION` for billing), `403 PERMISSION_DENIED`, `404 NOT_FOUND`, **`429 RESOURCE_EXHAUSTED`** ("You have exceeded a rate limit … RPM, TPM, RPD, spend"), `499 CANCELLED`, `500 INTERNAL`, `503 UNAVAILABLE`, `504 DEADLINE_EXCEEDED`. The newer Interactions API uses a different shape (`{"error":{"code":"snake_case","message":"..."}}`, plus `{"event_type":"error",...}` when streaming).

**OpenAI-compatibility endpoint (verified):**
- `POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` with `Authorization: Bearer $GEMINI_API_KEY`
- SDK: `base_url="https://generativelanguage.googleapis.com/v1beta/openai/"`
- `reasoning_effort` maps to Gemini thinking levels; `"none"` is only valid on 2.5 models (reasoning cannot be disabled on Gemini 2.5 Pro or Gemini 3).

Sources: [generateContent reference](https://ai.google.dev/api/generate-content), [legacy text generation](https://ai.google.dev/gemini-api/docs/generate-content/text-generation), [structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output), [models](https://ai.google.dev/gemini-api/docs/models), [deprecations](https://ai.google.dev/gemini-api/docs/deprecations), [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai).

---

## B.5 Alibaba Qwen (DashScope) — OpenAI-compatible mode

- **Base URL (OpenAI-compatible mode):**
  - China (Beijing): `https://dashscope.aliyuncs.com/compatible-mode/v1`
  - International (Singapore): `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
  - Also: US Virginia `https://dashscope-us.aliyuncs.com/compatible-mode/v1`; Hong Kong `https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1`
- **Endpoint:** `POST {base}/chat/completions`
- **Auth header:** `Authorization: Bearer $DASHSCOPE_API_KEY`

**Both base URLs assumed in the brief are correct.** When configuring an SDK client, the `base_url` must **not** include `/chat/completions`.

Migration caveat: Alibaba now recommends **workspace-dedicated domains** and refers to the `dashscope*.aliyuncs.com` hosts as a *"legacy shared domain… still available"*. Workspace form: `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`. **API keys are region-bound** — a Beijing key against the Singapore URL returns HTTP 401 `invalid_api_key` / "Incorrect API key provided".

**Which mode to choose:** use **OpenAI-compatible mode** for a provider-agnostic layer. Native DashScope mode is a different shape and only worth it for models the compatible mode excludes (e.g. Qwen-Audio):

| | OpenAI-compatible | Native DashScope |
|---|---|---|
| Endpoint | `{base}/chat/completions` | `/api/v1/services/aigc/text-generation/generation` (text) or `.../multimodal-generation/generation` |
| Body | flat `{"model","messages",...}` | wrapped `{"model","input":{"messages":[...]},"parameters":{...}}` |
| Generation params | top level | nested in **`parameters`** |
| Output | `choices[0].message.content` | `output.text` (`result_format:"text"`, default) or `output.choices[0].message.content` (`result_format:"message"`) |
| Usage keys | `prompt_tokens`/`completion_tokens`/`total_tokens` | `input_tokens`/`output_tokens`/`total_tokens` |
| Stream sentinel | `data: [DONE]` | none documented **[UNVERIFIED]** |
| Envelope extras | — | `status_code`, `request_id`, `code`, `message` |

For the native mode, remember both the `input`/`parameters` wrapper **and** `result_format: "message"` (otherwise you get `output.text`), plus the HTTP header **`X-DashScope-SSE: enable`** with `parameters.stream: true, incremental_output: true` for streaming.

**OpenAI dialect fidelity — high but not identical:**
- **The system role is only supported at `messages[0]`** ("Only `messages[0]` supports the system role").
- **`tools` cannot be combined with `stream: true`.**
- `system_fingerprint` is present but always the empty string.
- Supported params: `model`, `messages`, `top_p`, `temperature`, `presence_penalty`, `n` (1–4, `qwen-plus` only; forced to 1 when `tools` is present), `max_tokens`, `seed`, `stream`, `stop`, `tools`, `stream_options`.
- Thinking mode is a Qwen extension: `extra_body={"enable_thinking": true}` (streaming required in thinking mode).
- Some models reject HTTP calls entirely (`current user api does not support http call`, e.g. `qvq-max`).

**Assistant text path:** `choices[0].message.content`. (Native: `output.choices[0].message.content` or `output.text`; for VL/Omni the content is an array, `output.choices[0].message.content[0]["text"]`.) Reasoning: `message.reasoning_content`.

**JSON mode:** `response_format` (native: inside `parameters`).
- `{"type":"json_object"}` — valid JSON, structure not guaranteed. **The prompt must contain the word "JSON" (case-insensitive)** or the API errors: `'messages' must contain the word 'json' in some form, to use 'response_format' of type 'json_object'.`
- `{"type":"json_schema","json_schema":{"name":...,"strict":true,"schema":{...}}}` — **strict conformance supported**, and the prompt need not mention JSON.
- `json_object` is supported by most Qwen text models (Qwen3.8/3.7-Max, Qwen3.6/3.5-Max, Qwen-Max, Qwen3.7/3.6/3.5-Plus, Qwen-Plus, all Qwen-Flash, Qwen-Turbo, Qwen3-Coder, Qwen-Long, Qwen3.x open-source) plus Qwen-VL/Omni and third-party models hosted on Model Studio (`kimi-k3`, `glm-5.1`, `deepseek-v4-pro`, `deepseek-v4-flash`).
- **`json_schema` is only supported by `qwen3.7-plus`, `qwen3.7-flash`, `qwen3.7-max`, `qwen3.8-max`, `qwen3.8-flash`**, with an explicit note: **"Singapore region models are not supported yet."**
- Do not set `max_tokens` with structured output (it can truncate the JSON mid-string).

**Current model IDs:** recommended — `qwen3.8-max`, `qwen3.7-plus`, `qwen3.8-flash`. Also documented: `qwen3.7-max`, `qwen3.6-max`, `qwen3-max`, `qwen-max`, `qwen-max-latest`, `qwen-plus`, `qwen-plus-latest`, `qwen-turbo`, `qwen-turbo-latest`, `qwen-flash`, `qwen-long`, `qwen3-coder`, `qwen3-vl-plus`/`-flash`, `qwen3.5-omni-plus`, `qvq-max`, plus dated snapshots. Stable aliases (`qwen-max`/`qwen-plus`/`qwen-turbo`) are the recommended entry points; `-latest` tracks the newest snapshot.

**Streaming:** `"stream": true`; `stream_options: {"include_usage": true}`; SSE `data: {...}` with `"object":"chat.completion.chunk"`, terminated by **`data: [DONE]`** (verified literally in the official HTTP example).

**Errors:** compatible mode — `{"error":{"message":"Incorrect API key provided. ","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}`. Codes: 400 Invalid Request; 401 Incorrect API key; 429 rate limit (QPS/QPM) and 429 quota exceeded; 500 server error; 503 engine overloaded. Native mode — `{"status_code":400,"request_id":"...","code":"InvalidParameter","message":"..."}` (also `InvalidApiKey`, `Throttling`).

Sources: [Base URL overview](https://www.alibabacloud.com/help/en/model-studio/base-url), [OpenAI compatibility](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope), [DashScope API reference](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-dashscope), [structured output](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output), [models](https://www.alibabacloud.com/help/en/model-studio/models).

---

## B.6 xAI Grok

- **Base URL:** `https://api.x.ai` — SDK `base_url="https://api.x.ai/v1"`
- **Endpoint:** `POST /v1/chat/completions`
- **Auth header:** `Authorization: Bearer $XAI_API_KEY`, `Content-Type: application/json`

Note: xAI has **officially moved to `/v1/responses`** as the preferred surface, with Chat Completions described as "the OpenAI-compatible **predecessor** of the Responses API". Chat Completions remains fully documented and supported, so for a provider-agnostic layer it is still the right choice. Also available: `GET /v1/chat/deferred-completion/{request_id}`, legacy `POST /v1/completions`, deprecated `POST /v1/messages` and `/v1/complete`.

**OpenAI dialect fidelity: very high.** Same `object: "chat.completion"`, `choices[].message`, `usage.prompt_tokens`/`completion_tokens`/`total_tokens`, and `data: [DONE]` sentinel. Extensions and deviations:
- `message.reasoning_content` carries the reasoning trace; `usage.completion_tokens_details.reasoning_tokens` gives the token count.
- Extensions: `search_parameters`/`web_search_options`, `service_tier` (`default|priority`), `prompt_cache_key`, `deferred`, `output_files`, `citations`.
- **`max_tokens` is deprecated → use `max_completion_tokens`** (defaults to 128,000 when unset).
- **`logprobs`/`top_logprobs` are silently ignored on `grok-4.20` and newer** — silent, so do not assume you got logprobs.
- `frequency_penalty`/`presence_penalty`/`stop` are not supported by reasoning models; `logit_bias` is unsupported.
- `reasoning_effort` accepts `none | low | medium | high | xhigh`.
- **`finish_reason` can be `"end_turn"`** — an xAI-specific value alongside `"stop"` and `"length"`.

**Assistant text path:** `choices[0].message.content`; reasoning `choices[0].message.reasoning_content`; refusal `choices[0].message.refusal`.

**System prompt:** `{"role":"system","content":"…"}`. Docs explicitly state **"No role order limitation: You can mix `system`, `user`, or `assistant` roles in any sequence"** — more permissive than Qwen.

**JSON mode / structured output:**
- `response_format.type` ∈ `"text"` (default) | `"json_object"` | `"json_schema"`.
- **Strict `json_schema` is fully supported and guaranteed** for the supported subset:
```json
{"response_format":{"type":"json_schema","json_schema":{"name":"collatz_result","schema":{...},"strict":true}}}
```
- Schema support: `string`, `number`, `integer`, `boolean`, `null`, `enum`, `const`, `array`, `object`, `anyOf`, `oneOf` (≡ `anyOf`), `allOf` (single subschema), `$ref`/`$defs` (non-circular). JSON Schema Draft 2020-12 preferred, Draft-07 accepted. `additionalProperties` defaults to **`false`**. Enforced formats: `date`, `time`, `date-time`, `email`, `uuid`, `ipv4`, `ipv6`, `uri`. Enforced limits: minLength/maxLength ≤ 2048, minItems/maxItems ≤ 256, minProperties/maxProperties ≤ 64. `pattern` uses an ECMA-262 subset (no backreferences, no lookaround, no `\b`; `^`/`$` are implicit).
- Rejected with 400: empty `enum`/`anyOf`, boolean property schemas, `maxContains`/`minContains`, `items` as an array (use `prefixItems`).
- Tool schemas are implicitly `strict: true`. **Structured outputs combined with tools are only supported for "supported Grok 4 family models."**

**Current model IDs:** **`grok-4.6`** is the recommended/default model for everything (chat + code; 500k context; knowledge cutoff Feb 1 2026). Also `grok-4.5`, `grok-4.3` (1M context), `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-4.20-multi-agent-0309`, `grok-build-0.1`, plus image/video/voice models. Aliasing: bare `<model>` → latest stable, `<model>-latest` → newest features, `<model>-<date>` → pinned; API examples use `"model": "latest"`. **Retired (May 15 2026):** `grok-3`, `grok-4-0709`, `grok-4-fast-reasoning`, `grok-4-fast-non-reasoning`, `grok-4-1-fast-reasoning`, `grok-4-1-fast-non-reasoning`, `grok-code-fast-1`, `grok-imagine-image-pro` — these now **silently redirect** (`grok-3` → `grok-4.3` with `none` reasoning effort). **`grok-4`, `grok-3-mini`, `grok-2-1212` no longer appear in current docs** → treat as retired. ⚠️ The `xai-` API-key prefix is **not stated in the official pages fetched** → **[UNVERIFIED]**.

**Streaming:** `"stream": true`; "Tokens will be sent as data-only server-sent events as they become available, with the stream terminated by a **`data: [DONE]`** message." `stream_options.include_usage: true` inserts one extra chunk with `usage` before `[DONE]`; all other chunks carry `usage: null`.

**Errors & rate limits:** per-model **RPS + TPM**, tiered by cumulative spend since Jan 1 2026 (Tier 0 $0, T1 $50, T2 $250, T3 $1,000, T4 $5,000, Enterprise; tiers never downgrade). `grok-4.6`: T0 = 150 RPS / 50M TPM → T4 = 500 RPS / 100M TPM. Per-second cap = RPM/60. Exceeding any limit → **HTTP 429**; the official sample uses exponential backoff (`2**attempt`). Status codes: 400, 401 (missing/invalid bearer), 403, 404, 405, 415, 422, 429; **202 = deferred completion still pending**.

Sources: [Chat Completions](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions), [models](https://docs.x.ai/developers/models), [structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs), [rate limits](https://docs.x.ai/developers/rate-limits), [debugging](https://docs.x.ai/developers/debugging).

---

## B.7 Moonshot Kimi

**Rebrand note:** `platform.moonshot.cn` → `platform.kimi.com`; `platform.moonshot.ai` → `platform.kimi.ai` (both 302-redirect).

| Platform | Base URL | Endpoint |
|---|---|---|
| International | `https://api.moonshot.ai/v1` | `POST /chat/completions` |
| China | `https://api.moonshot.cn/v1` | `POST /chat/completions` |

- **Auth header:** `Authorization: Bearer $MOONSHOT_API_KEY`
- **Keys are platform-isolated:** *"Keys issued on `platform.kimi.ai` are independent from keys issued on other regional Kimi platforms. Mixing keys across platforms returns 401."*
- Optional integrity header `X-Msh-Request-Nonce` (UUIDv4) → response headers `Msh-Request-Timestamp` / `Msh-Request-Signature` (`reqsigv1_...`), verifiable via `POST /v1/signatures/verify`.
- Also served: `POST /v1/responses`, `https://api.moonshot.{ai,cn}/anthropic` + `POST /anthropic/v1/messages`, `GET /v1/models`, `POST /v1/tokenizers/estimate-token-count`, `GET /v1/users/me/balance`, `/v1/tools/search(_pro)`, `/v1/tools/fetch`.

**OpenAI dialect fidelity: very high**, with these important constraints:
- **`temperature`, `top_p` (fixed 0.95), `n` (fixed 1), `presence_penalty` (0), and `frequency_penalty` (0) cannot be modified on current models** — passing other values returns an error. **Do not send them.** This is the opposite of a "just forward the user's parameters" design and will break a naive provider-agnostic layer.
- **`max_tokens` is deprecated → `max_completion_tokens`** (`kimi-k3` default 131072, max 1048576). Input tokens + `max_completion_tokens` exceeding the context yields `invalid_request_error`.
- `stop`: string or array of **max 5** strings, each ≤32 bytes.
- `message.partial: true` on the last assistant message enables **Partial Mode / prefill** — a field *inside* `messages`, not top-level.
- `thinking` is a Kimi extension (SDK `extra_body`); `kimi-k3` uses top-level `reasoning_effort`.
- `finish_reason` ∈ `stop | length | tool_calls`.
- `tool_choice` supports `auto|none|required`, but **`required` errors on k2.6/k2.7-code**.
- Supported: `prediction`, `prompt_cache_key`, `safety_identifier`. `kimi-k3` also supports a dynamic-tool system message: `{"role":"system","tools":[...]}` with no `content`.
- ⚠️ Do not mix Partial Mode with `response_format: {"type":"json_object"}`.

**Assistant text path:** `choices[0].message.content`; reasoning `choices[0].message.reasoning_content`.

**System prompt:** `{"role":"system","content":"…"}` (roles `system|user|assistant|tool`).

**JSON mode / structured output:**
- `{"type":"text"}` (default).
- `{"type":"json_object"}` — valid JSON object; **you must describe the expected fields/types in the system or user prompt**, else you get unexpected results.
- `{"type":"json_schema","json_schema":{"name":...,"strict":true,"schema":{...}}}` — Structured Output. **The schema must conform to MFJS (Moonshot Flavored JSON Schema)**, validatable with the `walle` CLI (`go install github.com/moonshotai/walle/cmd/walle@latest`). `strict` defaults to `true`; with `strict:false` only "valid JSON object" is guaranteed. Tool `function.parameters` must also be MFJS, with `strict` defaulting to `true`.

**Current model IDs:**
| Model ID | Context | Notes |
|---|---|---|
| `kimi-k3` | 1,048,576 | Latest; always reasons; `reasoning_effort` ∈ `low\|high\|max` (default `max`) |
| `kimi-k2.7-code` | 262,144 | thinking always on |
| `kimi-k2.7-code-highspeed` | 262,144 | ~180 tps |
| `kimi-k2.6` | 262,144 | `thinking.type` ∈ `enabled`(default)/`disabled` |

**`moonshot-v1-8k/32k/128k`, `kimi-k2-0711-preview`, and `kimi-latest` are NOT listed in any current doc page → legacy, [UNVERIFIED] as still served.**

**Streaming:** `"stream": true`; SSE `data: {...}` with `"object":"chat.completion.chunk"` and `choices[0].delta.content`, terminated by **`data: [DONE]`**. `stream_options: {"include_usage": true}` adds a final usage chunk **before** `[DONE]` whose `choices` is an **empty array**; if the stream is interrupted that chunk may never arrive. A 504 gateway timeout occurs after 900 s of no response — use streaming for long requests.

**Errors:** `{"error":{"type":"...","message":"..."}}`:
- **400**: `content_filter` ("rejected because it was considered high risk"), `invalid_request_error` (input token length too long; "prompt tokens + max_tokens exceeds the model specification"; file-upload issues).
- **401**: `invalid_authentication_error`, `incorrect_api_key_error`.
- **403**: `permission_denied_error` (API not open; not allowed to get other user info; **IP not in organization allowlist** — "common on the international platform").
- **404**: `resource_not_found_error`.
- **429**: `engine_overloaded_error` (server capacity; honor `Retry-After`; topping up does not help), `exceeded_current_quota_error` (insufficient balance/token quota), `rate_limit_reached_error` for **organization-level concurrency / RPM / TPM / TPD**.
- **499** `client_closed_request`; **500** `server_error`/`unexpected_output`; **503** `server_unavailable`; **504** gateway HTML timeout page (may not be JSON — your parser must tolerate an HTML error body).

Note the distinction between **`engine_overloaded_error`** (retry with backoff) and **`exceeded_current_quota_error`** (retrying will never help; needs a top-up). Conflating them into "429 → retry" wastes budget and masks a hard failure.

**Region:** `.cn` and `.ai` are fully separate platforms with non-interchangeable keys, but expose the same three protocol shapes (`/v1` OpenAI-compatible and `/anthropic`).

Sources: [API overview](https://platform.kimi.ai/docs/api/overview), [chat completions](https://platform.kimi.ai/docs/api/chat), [errors](https://platform.kimi.ai/docs/api/errors), [pricing](https://platform.kimi.ai/docs/pricing/chat).

---

## B.8 MiniMax

| Mode | International | China |
|---|---|---|
| **OpenAI-compatible** | `https://api.minimax.io/v1` → `POST /v1/chat/completions` | `https://api.minimax.cn/v1` → `POST /v1/chat/completions` |
| **Native (v2)** | `https://api.minimax.io` → `POST /v1/text/chatcompletion_v2` | `https://api.minimax.cn` → `POST /v1/text/chatcompletion_v2` |
| **Anthropic-compatible** | `https://api.minimax.io/anthropic` | `https://api.minimax.cn/anthropic` |

- **Auth header:** `Authorization: Bearer <API_KEY>` — **for both modes and both regions.**

> **GroupId finding:** the legacy MiniMax authentication scheme required a `GroupId`. **There is no `GroupId` query parameter anywhere in the current official OpenAPI specs or docs.** The `securitySchemes` is `bearerAuth: http/bearer, bearerFormat: JWT`, and the native `/v1/text/chatcompletion_v2` operation declares exactly one parameter — the `Content-Type` header. The `GroupId` scheme is a **v1-era / third-party artifact**: LangChain's community `MiniMaxChat` still reads `MINIMAX_GROUP_ID` and defaults to `https://api.minimaxi.com/v1/text/chatcompletion_v2` for China, and `api.minimax.chat` was the original host. **GroupId is not required by the documented v2 endpoints.** Whether `?GroupId=` is still *accepted* (and ignored) is **[UNVERIFIED]** — so if you are porting older MiniMax code, remove the `GroupId` param.

Primary recommendation: use the **OpenAI-compatible** endpoint for a provider-agnostic layer, but be aware of the JSON-mode gap below.

**OpenAI dialect fidelity — good, with documented gaps:**
- **Ignored parameters:** `presence_penalty`, `frequency_penalty`, `logit_bias`. `n` only supports 1. Deprecated `function_call` is unsupported → use `tools`.
- `temperature` range `[0, 2]` (default 1); **out-of-range → error**. Note the native v2 schema documents `temperature` as `(0, 1]` — a **mode-dependent range inconsistency** worth normalizing.
- `top_p` default 0.95 (M3) / 0.9 (M2.x).
- `max_completion_tokens` preferred; `max_tokens` legacy (M3 recommended 131072, max 524288; others recommended 65536, max 204800).
- Extensions: `thinking: {"type":"disabled"|"adaptive"}`, `reasoning_split`, `service_tier: standard|priority` (priority = 1.5× price), `mask_sensitive_info` (native only).
- MiniMax-specific response fields: `base_resp{status_code,status_msg}`, `input_sensitive`, `output_sensitive`, `*_sensitive_type`, `output_sensitive_int`, `usage.total_characters`, `message.name` ("MiniMax AI"), `message.audio_content`.
- Multimodal message parts use **`video_url`** (OpenAI has no video part), plus `image_url` with `detail` and `max_long_side_pixel`, and files via `mm_file://{file_id}`.

**Assistant text path:** `choices[0].message.content` (non-streaming) / `choices[0].delta.content` (streaming).

**⚠️ Thinking-content caveat (important):** by default, M-series thinking is embedded **inside `content` wrapped in `<think>…</think>` tags**. With `reasoning_split: true` it moves to `choices[0].message.reasoning_content` and `choices[0].message.reasoning_details[]` (each detail: `{type:"reasoning.text", id, format:"MiniMax-response-v1", index, text}`). **If you parse `content` as the final answer without stripping/explitting `<think>` tags, you will feed reasoning text into downstream consumers.** Set `reasoning_split: true` and read `reasoning_content`, or strip the tags.

**JSON mode / structured output — a real gap:**
- **On the OpenAI-compatible `/v1/chat/completions` endpoint, `response_format` is NOT in the schema** (zero occurrences in the fetched OpenAPI). **There is currently no documented JSON mode or structured output on that endpoint.**
- On **native `/v1/text/chatcompletion_v2`**, `response_format` exists but is documented as **"only supported by `MiniMax-Text-01`"** (a legacy model), and **only `{"type":"json_schema"}`** — there is no `json_object`:
```json
{"response_format":{"type":"json_schema",
  "json_schema":{"name":"user_analysis","description":"...",
    "schema":{"type":"object","properties":{...},"required":[...]}}}}
```
`json_schema.name` ≤ 64 chars matching `^\w+$`; `schema.type` must be `object`; property types are String/Array/Enum/Number/Integer/Object/Boolean.
- **Practical implication: for `MiniMax-M3`/M2.x, structured output must be prompt-engineered and validated client-side.** This is a genuine capability gap relative to every other provider here — a provider-agnostic layer cannot promise JSON-schema guarantees on MiniMax and should surface that.

**System prompt:** `{"role":"system","content":"…"}` (roles `system|user|assistant|tool`), optionally with `name`. Anthropic-compatible mode uses the top-level `system` string.

**Current model IDs:**
| Model ID | Context | Notes |
|---|---|---|
| `MiniMax-M3` | 1,000,000 | **Latest**; agentic/coding/long-context; multimodal (text+image+video); `thinking` default on |
| `MiniMax-M2.7` / `-highspeed` | 204,800 | 60 tps / ~100 tps |
| `MiniMax-M2.5` / `-highspeed` | 204,800 | 60 tps / ~100 tps |
| `MiniMax-M2.1` / `-highspeed` | 204,800 | 60 tps / ~100 tps |
| `MiniMax-M2` | 204,800 | agentic + advanced reasoning |

Legacy but still referenced in the native v2 schema: `MiniMax-Text-01` (the only model with `response_format`; default max_tokens 2048) and `MiniMax-M1` (default 8192). **`abab6.5s-chat` and the entire `abab` family are absent from all current docs → legacy, [UNVERIFIED].** The Anthropic-compatible interface supports **only M-series models** (not Text-01/M1/abab).

**Streaming:** `"stream": true` in both modes; SSE chunks with `"object":"chat.completion.chunk"`, `choices[0].delta.content`, `delta.role`, and `usage` only in the final chunk. The native docs' stream example additionally emits a **final non-chunk object** (`"object":"chat.completion"` with a full `message` and `usage`) as the last event. **No `data: [DONE]` sentinel appears in any MiniMax streaming example** (unlike OpenAI/Qwen-compat/xAI/Kimi) → **termination is by stream close / final chunk, and a parser that waits for `[DONE]` will hang.** Whether a `[DONE]` line may nonetheless be emitted is **[UNVERIFIED]** — treat both as valid terminators.

**Errors — the biggest structural gotcha:** errors are returned **inside the JSON body** as `base_resp`, **frequently with HTTP 200**. Success is `{"base_resp":{"status_code":0,"status_msg":""}}`. Documented codes: `1000` unknown error; `1001` request timeout; **`1002` rate limit**; `1004` not authorized / "token not match group" / cookie missing; `1008` insufficient balance; `1024` internal error; `1026` input sensitive; `1027` output sensitive; `1033` system error; `1039` token limit; `1041` conn limit; `1042` invisible character ratio limit; `1043`/`1044` similarity checks; `2013` invalid params; plus `2037`, `2039`, `2042`, `2045`, `2048`, `2049`, `2056`. Content moderation surfaces via `input_sensitive`/`output_sensitive` + `*_type` (1 severe, 2 porn, 3 ads, 4 prohibited, 5 abuse, 6 violence/terrorism, 7 other); severe cases return **empty content**.

> **A MiniMax client MUST check `base_resp.status_code` on every 200 response.** A generic "HTTP 2xx means success" check will treat rate limits, auth failures, and insufficient balance as successful completions with empty content. This is the single most dangerous provider-specific behaviour in this document.

**Rate limits:** `MiniMax-M3` **200 RPM / 10,000,000 TPM**; `MiniMax-M2.7|M2.5|M2.1` (incl. highspeed) and `MiniMax-M2` **500 RPM / 20,000,000 TPM**.

**Region:** International — API `api.minimax.io`, docs `platform.minimax.io`. China — API **`api.minimax.cn`**, docs `platform.minimaxi.com`. Historical hosts `api.minimax.chat` and `api.minimaxi.com` are preferred by some third-party integrations but their current status is **[UNVERIFIED]**; prefer `api.minimax.io` / `api.minimax.cn`.

Sources: [OpenAI SDK](https://platform.minimax.io/docs/api-reference/text-openai-api), [native text generation](https://platform.minimax.io/docs/api-reference/text-post), [Anthropic SDK](https://platform.minimax.io/docs/api-reference/text-anthropic-api), [error codes](https://platform.minimax.io/docs/api-reference/errorcode), [rate limits](https://platform.minimax.io/docs/guides/rate-limits), [API overview](https://platform.minimax.io/docs/api-reference/api-overview).

---

## B.9 OpenRouter (aggregator — one key, many models)

- **Base URL:** `https://openrouter.ai/api/v1` → `POST /chat/completions`
- **Auth header:** `Authorization: Bearer $OPENROUTER_API_KEY`
- **Optional attribution headers:** `HTTP-Referer: <YOUR_SITE_URL>`, `X-OpenRouter-Title: <YOUR_SITE_NAME>`; opt-in `X-OpenRouter-Metadata: enabled`; `session_id` (body, ≤256) or `x-session-id` header for sticky routing.
- **OpenAI SDK:** `base_url="https://openrouter.ai/api/v1"`

**Model slugs — namespaced `author/slug`**, e.g. `openai/gpt-4o`, `openai/gpt-5.2`, `anthropic/claude-sonnet-4.5`, `anthropic/claude-haiku-4.5`, `google/gemini-3-flash-preview`, `meta-llama/llama-3.3-70b-instruct`.

**Routers and aliases:**
- **`openrouter/auto`** — market spend-share router. Per-request tuning via `plugins: [{id:"auto-router", allowed_models:[...], excluded_models:[...], cost_tier:"low|medium|high|xhigh|max"}]`.
- `openrouter/auto-beta` (plugin id `auto-beta-router`), `openrouter/free`.
- **`~author/family-latest`** aliases (e.g. `~openai/gpt-sol-latest`, `~anthropic/claude-sonnet-latest`) resolve to the newest concrete model; **the response `model` field reports the concrete slug actually used** — so log it.
- Variants appended to a slug: `:free`, `:nitro` (throughput), `:floor` (price), `:exacto` (tool-calling quality).
- Live catalog: `GET https://openrouter.ai/api/v1/models`.

**Request body** — OpenAI-shaped, plus OpenRouter extensions:
- **`models: [...]`** — a **fallback array in priority order**. If the first model errors, the next is tried automatically, and you are priced at the model actually used.
- **`stream_options.include_usage` is marked deprecated: "This field has no effect. Full usage details are always included."** Unlike every other provider here, usage is always present.
- `max_completion_tokens` vs `max_tokens` ("deprecated, use `max_completion_tokens`. Note: some providers enforce a minimum of 16").
- `response_format` supports `text | json_object | json_schema | grammar | python`; plus `structured_outputs` (bool).
- Extra sampling knobs not in OpenAI: `top_k`, `min_p`, `top_a`, `repetition_penalty`.
- **`provider` routing object:** `order[]`, `allow_fallbacks` (default `true`), `require_parameters` (default `false`), `data_collection` (`"allow"|"deny"`, default allow), `zdr`, `enforce_distillable_text`, `only[]`, `ignore[]`, `quantizations[]`, `sort` (`"price"|"throughput"|"latency"|"exacto"` or `{by, partition}`), `preferred_min_throughput`, `preferred_max_latency`, `max_price`.
- `plugins[]`, `debug{echo_upstream_body}` (streaming only), `cache_control`, `image_config`.

**Response** — OpenAI-shaped (`object: "chat.completion"`) with `system_fingerprint`, `service_tier`, and a richer usage object:
```json
{
  "choices": [{"index":0, "finish_reason":"stop",
    "message": {"role":"assistant","content":"…","reasoning":"…","reasoning_details":[],
                "refusal":null,"tool_calls":null,"model":"…","name":null}}],
  "usage": {
    "prompt_tokens": 42, "completion_tokens": 128, "total_tokens": 170,
    "cost": 0.00042,
    "cost_details": {"upstream_inference_prompt_cost": 0, "upstream_inference_completions_cost": 0, "upstream_inference_cost": 0},
    "is_byok": false,
    "prompt_tokens_details": {"cached_tokens":0,"cache_write_tokens":0},
    "completion_tokens_details": {"reasoning_tokens":0},
    "server_tool_use_details": {"tool_calls_requested":0,"tool_calls_executed":0}
  },
  "openrouter_metadata": {}
}
```

- **Assistant text path: `choices[0].message.content`**; delta path `choices[0].delta.content`.
- **Sentinel `data: [DONE]`** (the OpenAPI declares `x-speakeasy-sse-sentinel: '[DONE]'`).
- **Keep-alive comments `: OPENROUTER PROCESSING` must be skipped** before `JSON.parse`. A naive SSE parser that JSON-parses every line will crash.
- **⚠️ Streaming deviation from OpenAI:** the final usage chunk contains **one choice with a content-free delta that repeats `finish_reason`/`native_finish_reason`**, whereas OpenAI emits an **empty `choices` array**. A parser written against OpenAI's convention will mis-read OpenRouter's final chunk.
- `X-Generation-Id` response header is always returned — capture it for support/debugging.

**System prompt:** `{"role":"system","content":"…"}`. A `developer` role also exists. OpenRouter adds a `configuration_update` extension on system/developer messages to change reasoning effort mid-conversation.

**JSON / structured output:**
```json
{"response_format":{"type":"json_schema","json_schema":{
  "name":"weather","strict":true,
  "schema":{"type":"object",
    "properties":{"location":{"type":"string"},"temperature":{"type":"number"},"conditions":{"type":"string"}},
    "required":["location","temperature","conditions"],"additionalProperties":false}}}}
```
- **Support is per-endpoint/per-provider, not per-model.** Use **`provider.require_parameters: true` together with `response_format`** to force routing only to endpoints that actually support structured outputs. Without this, OpenRouter may route to a provider that ignores the schema.
- **`strict: true` enforcement varies by provider** — "some guarantee schema-conforming output, while others … treat it as a strong hint." **So OpenRouter does not give you a uniform strict-schema guarantee**, unlike OpenAI/Anthropic/Gemini/xAI/Qwen. Validate anyway.
- Streaming with structured outputs is supported (partial valid JSON). A Response-Healing plugin is available for non-streaming `json_schema`.

**Errors:** shape **`{"error":{"code": <int HTTP status>, "message": <string>, "metadata"?: {...}}}`**, with HTTP status = `error.code` for pre-inference failures. **After streaming has started, the HTTP status stays 200** and the error arrives as an SSE event with a top-level `error` and `choices[0].finish_reason: "error"` — **so you must check for errors inside the stream, not only on the HTTP response.** Codes: 400, 401, 402 (insufficient credits), 403 (permissions/guardrail/moderation, with `metadata.reasons|flagged_input|provider_name|model_slug`), 404, 408, 413, 422, 429, 500 (message masked to a generic string), 502, **503 (no provider meets routing requirements)**, 524, 529. Stable typed codes live in `error.metadata.error_type` (`rate_limit_exceeded`, `provider_unavailable`, `provider_overloaded`, `payment_required`, `authentication`, `refusal`, `content_policy_violation`, `timeout`, `server`).

**Rate-limit headers:** **successful inference responses carry no `X-RateLimit-*`.** On a platform-limit 429 the *error* carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, plus `Retry-After` when a provider supplied a hint.

**`:free` tier limits:** 20 requests/minute always; 50 requests/day if lifetime credits purchased < 10; 1000 requests/day if ≥ 10 credits. Beyond that, Cloudflare DDoS protection may apply. Check quota at `GET https://openrouter.ai/api/v1/key` (`limit_remaining`, `is_free_tier`).

**Timeout:** OpenRouter publishes no default client timeout — **[UNVERIFIED]**. `408` means "Your request timed out". Set your own.

Sources: [quickstart](https://openrouter.ai/docs/quickstart), [authentication](https://openrouter.ai/docs/api_reference/authentication), [streaming](https://openrouter.ai/docs/api_reference/streaming), [parameters](https://openrouter.ai/docs/api_reference/parameters), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [errors and debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging), [limits](https://openrouter.ai/docs/api_reference/limits), [auto router](https://openrouter.ai/docs/guides/routing/routers/auto-router).

---

## B.10 Comparison table

### Provider | base URL | auth header | system prompt | JSON mode

| Provider | Base URL | Auth header | System-prompt mechanism | JSON mode mechanism |
|---|---|---|---|---|
| **OpenAI** | `https://api.openai.com/v1` | `Authorization: Bearer sk-…` | `{"role":"system"}` message; **`developer` role for o1+** | `response_format:{"type":"json_object"}` (loose, needs "JSON" in prompt) / `{"type":"json_schema","json_schema":{...,"strict":true}}` (**strict**) |
| **DeepSeek** | `https://api.deepseek.com` | `Authorization: Bearer <key>` | `{"role":"system"}` message (**no `developer`**) | `response_format:{"type":"json_object"}` only — **no strict schema** |
| **Anthropic** | `https://api.anthropic.com` | `x-api-key: <key>` + **`anthropic-version: 2023-06-01`** | **Top-level `system`** field (string or block array) — **no system role exists** | `output_config.format:{"type":"json_schema","schema":{…}}` (**strict, native**) or `strict:true` tool use |
| **Google Gemini** | `https://generativelanguage.googleapis.com` | **`x-goog-api-key: <key>`** or `?key=<key>` | **Top-level `systemInstruction`** (`{"parts":[{"text":…}]}`) | `generationConfig.responseMimeType:"application/json"` + `responseSchema` (OpenAPI subset, SCREAMING-CASE types) — **strict, but subset**; `responseJsonSchema` for full JSON Schema |
| **Qwen (DashScope compat)** | `https://dashscope.aliyuncs.com/compatible-mode/v1` (CN) / `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (intl) | `Authorization: Bearer $DASHSCOPE_API_KEY` | `{"role":"system"}` message — **only at `messages[0]`** | `response_format:{"type":"json_object"}` (needs "JSON" in prompt) / `{"type":"json_schema",...}` (**strict, but only 5 model families; not Singapore**) |
| **xAI Grok** | `https://api.x.ai` | `Authorization: Bearer $XAI_API_KEY` | `{"role":"system"}` message, **any position** | `response_format:{"type":"json_object"}` / `{"type":"json_schema",...,"strict":true}` (**strict, guaranteed subset**) |
| **Moonshot Kimi** | `https://api.moonshot.ai/v1` (intl) / `https://api.moonshot.cn/v1` (CN) | `Authorization: Bearer $MOONSHOT_API_KEY` | `{"role":"system"}` message | `response_format:{"type":"json_object"}` / `{"type":"json_schema",...,"strict":true}` (**strict**, schema must be **MFJS**) |
| **MiniMax** | `https://api.minimax.io/v1` (intl) / `https://api.minimax.cn/v1` (CN) | `Authorization: Bearer <key>` (**no GroupId**) | `{"role":"system"}` message; Anthropic-compat mode uses top-level `system` | **None on the OpenAI-compatible endpoint.** Native v2 only, `{"type":"json_schema"}`, **`MiniMax-Text-01` only** |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `Authorization: Bearer sk-or-…` | `{"role":"system"}` message; `developer` also supported | `response_format:{"type":"json_object"}` / `{"type":"json_schema",...,"strict":true}` — **passthrough, enforcement varies by upstream provider** |

### Normalization table (the differences your adapter must absorb)

| Concern | OpenAI | DeepSeek | Anthropic | Gemini | Qwen | xAI | Kimi | MiniMax | OpenRouter |
|---|---|---|---|---|---|---|---|---|---|
| Assistant text path | `choices[0].message.content` | same (+`reasoning_content`) | **`content[]` blocks, filter `type=="text"`** | **`candidates[0].content.parts[0].text`** | `choices[0].message.content` | `choices[0].message.content` | `choices[0].message.content` | `choices[0].message.content` (**strip `<think>`**) | `choices[0].message.content` |
| Delta path | `choices[0].delta.content` | same | **`content_block_delta.delta.text`** | **`candidates[0].content.parts[0].text`** | `choices[0].delta.content` | same | same | same | same (skip `: OPENROUTER PROCESSING`) |
| System prompt | `system` / `developer` msg | `system` msg | **top-level `system`** | **top-level `systemInstruction`** | `system` msg (idx 0 only) | `system` msg | `system` msg | `system` msg | `system` msg |
| Stop-reason field | `finish_reason` | `finish_reason` | **`stop_reason`** | **`finishReason`** | `finish_reason` | `finish_reason` | `finish_reason` | `finish_reason` | `finish_reason` + `native_finish_reason` |
| Terminal sentinel | `data: [DONE]` | `data: [DONE]` | `message_stop` event | stream end (`?alt=sse`) | `data: [DONE]` | `data: [DONE]` | `data: [DONE]` | **stream close (no `[DONE]`)** | `data: [DONE]` |
| Strict schema? | ✅ | ❌ | ✅ | ✅ (subset) | ✅ (5 families) | ✅ | ✅ (MFJS) | ❌ (Text-01 only) | ⚠️ provider-dependent |
| HTTP-200 error? | no | no | no | no | no | no | no | **YES — `base_resp`** | no (but in-stream errors) |

---

## B.11 Streaming vs non-streaming

**How to request it:** every provider except Gemini uses a top-level `"stream": true|false` boolean. Gemini signals streaming through the **endpoint choice**, not the body: `:streamGenerateContent` instead of `:generateContent`. Anthropic uses `"stream": true` on `/v1/messages` (SSE).

**How to detect which mode a response is:** the reliable signal is the response `Content-Type`:
- `text/event-stream` → streaming SSE; consume incrementally.
- `application/json` → a single non-streaming object; parse once.
Do **not** infer the mode from the presence of a `stream` parameter alone, and do not assume a JSON body is non-streaming just because you asked for streaming — a request-level error (401/429/400) can return a JSON body on a streaming request. **Check the status code and content type before entering the SSE loop.**

**SSE framing rules that apply to all of them:**
- Events are `data: <payload>` lines, one JSON object per event, separated by a blank line.
- **Skip comment lines (starting with `:`) and empty lines.** DeepSeek emits `: keep-alive`; OpenRouter emits `: OPENROUTER PROCESSING`. Feeding these to a JSON parser throws.
- Handle the sentinel `data: [DONE]` where it exists (all except Anthropic and MiniMax). **Do not treat `[DONE]` as JSON.**
- Anthropic uses **named SSE events** (`event: content_block_delta`), so you must read the `event:` line as well as `data:` — there is no `[DONE]`.
- A stream can end **without** a sentinel (MiniMax), and a stream can carry an **error** mid-flight (Anthropic `error` event; OpenRouter an SSE object with `finish_reason: "error"` while HTTP stays 200).

**Practical guidance:** request non-streaming when you need the complete result atomically (e.g. a JSON decision to be parsed and acted on), and streaming when latency-to-first-token matters (e.g. progressive UI). For a trading bot, **non-streaming is usually the right default for decision calls**: you cannot act on a partially-parsed JSON decision, and streaming adds a failure mode (interrupted streams) without benefit. Use streaming only for long analyst-style generations where the timeout window matters — note DeepSeek's and Kimi's documented long-request timeouts (Kimi: 504 after 900 s; DeepSeek: connection closed if inference has not started in 10 min).

---

## B.12 `finish_reason` values and normalization

Each provider names the field differently and uses a different value set.

| Provider | Field | Values |
|---|---|---|
| **OpenAI** | `finish_reason` | `stop`, `length`, `tool_calls`, `content_filter`, `function_call` (deprecated) |
| **DeepSeek** | `finish_reason` | `stop`, `length`, `content_filter`, `tool_calls`, **`insufficient_system_resource`**, **`aborted`** |
| **Anthropic** | **`stop_reason`** | `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, **`model_context_window_exceeded`** |
| **Gemini** | **`finishReason`** | `FINISH_REASON_UNSPECIFIED`, `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `LANGUAGE`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `MALFORMED_FUNCTION_CALL`, `IMAGE_SAFETY`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `NO_IMAGE`, `IMAGE_PROHIBITED_CONTENT`, `IMAGE_RECITATION`, `IMAGE_OTHER` |
| **Qwen** | `finish_reason` | OpenAI-compatible (`stop`, `length`, `tool_calls`, …) |
| **xAI** | `finish_reason` | `stop`, `length`, `tool_calls`, **`end_turn`** |
| **Kimi** | `finish_reason` | `stop`, `length`, `tool_calls` |
| **MiniMax** | `finish_reason` | OpenAI-compatible — exact enum **[UNVERIFIED]** |
| **OpenRouter** | `finish_reason` + `native_finish_reason` | passthrough of the upstream provider's value |

**Recommended canonical set** for a provider-agnostic layer — map every provider value into these five, and keep the raw value alongside for diagnostics:

| Canonical | Meaning | Maps from |
|---|---|---|
| `stop` | Natural completion | `stop`, `end_turn`, `STOP` |
| `length` | Output cap reached | `length`, `max_tokens`, `MAX_TOKENS`, `model_context_window_exceeded` |
| `tool_calls` | Model wants to call a tool | `tool_calls`, `function_call`, `tool_use`; **Gemini: presence of a `functionCall` part (no finish-reason value)** |
| `content_filter` | Blocked by safety | `content_filter`, `refusal`, `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `RECITATION`, `SPII`, `image_safety` |
| `error` | Abnormal termination | `insufficient_system_resource`, `aborted`, `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, unknown values |

**Three normalization traps:**
1. **Gemini has no `tool_calls` finish reason** — detect tool calls from the content parts, not the finish reason.
2. **`length` is ambiguous in a dangerous way for reasoning models.** With OpenAI `max_completion_tokens` (which includes reasoning tokens) or DeepSeek thinking mode, `length` can fire with **`content` empty** because the reasoning consumed the whole budget. Treat `finish_reason == "length"` **with empty content** as a distinct, retryable condition (raise the cap) rather than as an empty successful answer.
3. **Unknown values must not crash or be silently dropped.** Default to `error` and log the raw value, so a provider adding an enum value surfaces loudly instead of corrupting state.

---

## B.13 Request timeouts

Only OpenAI publishes a numeric SDK default; everyone else leaves it to you. **Set an explicit timeout on every provider call** — an unset timeout on a trading bot is an availability incident waiting to happen.

| Provider | Default | Notes |
|---|---|---|
| **OpenAI** | **10 minutes** (`httpx.Timeout(timeout=600, connect=5.0)`); `DEFAULT_MAX_RETRIES=2` | Per-request: `client.with_options(timeout=5.0)`. Timeout → `APITimeoutError`. Retries on 408/409/429/≥500, `MAX_RETRY_AFTER_DELAY=120s` |
| **DeepSeek** | **Server closes the connection if inference has not started within 10 minutes** | Keep-alive: blank lines (non-streaming), `: keep-alive` SSE comments (streaming). No published client default |
| **Anthropic** | SDKs auto-retry 2× by default on connection errors/408/409/429/5xx | `timeout_error` = HTTP 504 |
| **Gemini** | `504 DEADLINE_EXCEEDED` on the server side | No published client default |
| **Kimi** | **504 gateway timeout after 900 s** of no response | Streaming recommended for long requests |
| **MiniMax** | `1001` = request timeout (as a `base_resp` code) | No published client default |
| **OpenRouter** | **Not published — [UNVERIFIED]** | `408` = "Your request timed out" |

**Recommended structure for a provider-agnostic client:**
- Set a **separate connect timeout** (≈5 s) and **read timeout** (task-dependent), following OpenAI's own `connect=5.0` practice. A single scalar timeout conflates "the network is down" with "the model is slow", which need different handling.
- Use generous read timeouts only for long generations, and prefer streaming when the expected generation time approaches the server-side ceiling (Kimi 900 s, DeepSeek 10 min).
- **Distinguish timeout from other failures in your error taxonomy.** A timeout on a non-streaming request has **unknown execution status** — the model may have completed server-side. This matters if the completion has side effects (and is the same hazard as Binance's ambiguous HTTP 503 described in Part A). **Never blindly retry a timed-out request whose side effect is non-idempotent.**
- Retry timeouts on idempotent reads freely; for side-effecting calls, reconcile state first.

---

## B.14 Error shapes, 401/429/5xx, and retry with exponential backoff

### Error envelope per provider

| Provider | Error body shape | 401 | 429 | 5xx | `Retry-After` |
|---|---|---|---|---|---|
| **OpenAI** | `{"error":{"code","message","param","type"}}` | `invalid auth` | `credit_balance_exhausted`, `rate_limit_reached`, `rate_limit_error`+`slow_down`, `organization_spend_limit_exceeded` | 500 server; 503 `service_unavailable_error` + `server_is_overloaded` | ✅ seconds; plus `x-ratelimit-*` |
| **DeepSeek** | **[UNVERIFIED]** (expected OpenAI-shaped) | 401 Authentication Fails | **429 Rate Limit Reached** (concurrency) | 500 Server Error; 503 Server Overloaded | ❌ none documented |
| **Anthropic** | `{"type":"error","error":{"type","message"},"request_id"}` | `authentication_error` | `rate_limit_error` | 500 `api_error`; 504 `timeout_error`; **529 `overloaded_error`** | ✅ (but **absent** on tier spend-cap 429s) |
| **Gemini** | `{"error":{"code","message","status","details"}}` | 401/403 `PERMISSION_DENIED` / `API_KEY_INVALID` | **429 `RESOURCE_EXHAUSTED`** | 500 `INTERNAL`; 503 `UNAVAILABLE`; 504 `DEADLINE_EXCEEDED` | ❌ not documented |
| **Qwen** | `{"error":{"message","type","param","code"}}` | `invalid_api_key` | 429 rate limit / quota exceeded | 500; 503 engine overloaded | ❌ not documented |
| **xAI** | `error` object | 401 missing/invalid bearer | 429 | 5xx | ✅ per official guidance (backoff `2**attempt`) |
| **Kimi** | `{"error":{"type","message"}}` | `invalid_authentication_error`, `incorrect_api_key_error` | `engine_overloaded_error`, `exceeded_current_quota_error`, `rate_limit_reached_error` | 500 `server_error`/`unexpected_output`; 503 `server_unavailable`; **504 HTML page** | ✅ honor it |
| **MiniMax** | **`{"base_resp":{"status_code","status_msg"}}` — often HTTP 200** | `1004` not authorized | **`1002` rate limit** | `1024` internal; `1033` system | ❌ |
| **OpenRouter** | `{"error":{"code","message","metadata"}}` | 401 | 429 + `metadata.error_type` | 500 (masked message); 502; 503 no provider; 524; 529 | ✅ on platform 429s |

### Handling by status class

**HTTP 401 / 403 — do not retry.**
A retry cannot fix bad or missing credentials. Surface immediately and fail fast.
- Distinguish *auth* (401: wrong/absent key) from *permission* (403: key valid but not entitled). Gemini uses `403 PERMISSION_DENIED`, Kimi `permission_denied_error` (including **IP not on the org allowlist**), OpenRouter 403 for guardrails/moderation. Treating 403 as retryable causes a hot loop against a permanently denied resource.
- OpenAI 403 also means "country unsupported" — also permanent.

**HTTP 429 — retry with backoff, and honor `Retry-After`.**
- **Always prefer the server's `Retry-After` value over your own computed delay** when present.
- Check the *sub-type* before assuming a transient condition:
  - OpenAI distinguishes `rate_limit_reached` (transient) from `credit_balance_exhausted` and `*_spend_limit_exceeded` (**permanent until topped up/limit raised**).
  - Kimi distinguishes `engine_overloaded_error` (transient) from `exceeded_current_quota_error` (**permanent**).
  - Anthropic notes a tier spend-cap 429 has **no** `retry-after` and keeps failing.
  - OpenRouter exposes `metadata.error_type` (`rate_limit_exceeded` vs `payment_required`).
  - **Retrying a quota-exhaustion 429 is pure waste** — classify it as fatal and alert.

**HTTP 5xx — retry with backoff.**
- 500/502/503/504 are generally transient. Anthropic's **529 `overloaded_error`** and OpenRouter's **503 "no provider meets routing requirements"** have no OpenAI equivalent and must be added to your retryable set explicitly.
- **Do not retry 501/505** — those indicate a client/protocol problem.
- **Kimi's 504 may be an HTML page, not JSON** — your error parser must tolerate a non-JSON body and fall back to the raw text.
- Watch for the **ambiguous 5xx class** where execution status is unknown (see B.13).

**HTTP 400 / 422 — do not retry without changing the request.**
These mean the request is malformed or invalid. Notable ones that will bite a normalizer:
- Anthropic: `temperature`/`top_p`/`top_k` on post-4.6 models → 400.
- Xiao/Kimi: passing `temperature`/`top_p`/`n`/penalties to Kimi → error.
- DeepSeek: `tool_choice: "required"` or a named tool **in thinking mode** → 400; `stream_options` without `stream: true` → 400.
- OpenAI: `json_object` without the word "json" in the prompt → 400 `invalid_request_error`, `param: "messages"`.
- MiniMax: `temperature` outside `[0,2]` → error.
**Log the `param` field when present** — it usually names the offending field exactly.

### Retry with exponential backoff

Recommended parameters: **`base ≈ 500 ms`, cap ≈ 30–60 s, max 5 attempts**, with **full jitter**.

```
delay_n = min(cap, base * 2^n)
sleep   = random(0, delay_n)              # full jitter
```

Use **full jitter** (or at minimum equal jitter) rather than a fixed exponential delay. Deterministic backoff synchronizes all clients: after a shared outage, every instance retries at the same instants and re-triggers the overload. Jitter decorrelates them.

Rules that matter more than the formula:
1. **Always honor `Retry-After` when present**, overriding the computed delay (and clamp it to a sane maximum to avoid a hostile value stalling the bot).
2. **Only retry idempotent operations, or operations you can reconcile.** A retried chat completion with side effects (e.g. "place this order") can duplicate the effect if the first attempt actually succeeded server-side. Add an idempotency key where the provider supports one, or reconcile state before retrying.
3. **Retry only on the retryable set:** connection errors, timeouts, 408, 409, 429, and 5xx (excluding 501/505). **Never retry 400/401/403/404/422.**
4. **Bound the total wall-clock time**, not just the attempt count — a bot with a 10-minute read timeout and 5 retries can block for an hour.
5. **Add a circuit breaker.** After N consecutive failures against a provider, open the circuit and either fail over to another provider or fail fast. This is where a multi-provider LLM layer earns its keep: with eight providers configured, a per-provider circuit breaker plus a fallback chain converts a total outage into a degraded-but-working state.
6. **Log the provider's request ID** for every failure (`request_id` for Anthropic, `x-request-id` for OpenAI, `X-Generation-Id` for OpenRouter) — it is the only way to get a useful answer from provider support.

---

## B.15 Strict schema vs loose JSON mode — capability matrix

| Provider | Loose "JSON mode" | **Strict** JSON-schema / structured output | Notes |
|---|---|---|---|
| **OpenAI** | ✅ `json_object` (needs "JSON" in prompt) | ✅ `json_schema` + `strict:true` | Supported from `gpt-4o-mini` / `gpt-4o-2024-08-06` onward; `additionalProperties:false` required |
| **Anthropic** | via prompt only | ✅ **native** `output_config.format` | No beta header needed; also `strict:true` tool use. Claude Fable 5.1 / Mythos 5.1 reject `tool_choice` `tool`/`any` |
| **Gemini** | ✅ `responseMimeType: "application/json"` | ✅ `responseSchema` — **OpenAPI subset only** | SCREAMING-CASE types; no `additionalProperties`/`$ref`/`allOf`; `responseJsonSchema` offers full JSON Schema |
| **xAI** | ✅ `json_object` | ✅ `json_schema` + `strict:true`, **guaranteed** for the supported subset | `additionalProperties` defaults to **false**; with tools only on "supported Grok 4 family models" |
| **Qwen** | ✅ `json_object` (needs "JSON" in prompt) | ✅ `json_schema` + `strict:true` | **Only 5 model families** (`qwen3.7-plus/flash/max`, `qwen3.8-max/flash`); **not available in Singapore** |
| **Kimi** | ✅ `json_object` | ✅ `json_schema` + `strict:true` (default) | Schema must be **MFJS**; validate with the `walle` CLI |
| **DeepSeek** | ✅ `json_object` (needs "json" in prompt) | ❌ **not available** | Docs warn the API may occasionally return **empty content** |
| **MiniMax** | ⚠️ **not on the OpenAI-compatible endpoint** | ⚠️ native v2 only, **`MiniMax-Text-01` only**, `json_schema` only | No `json_object`; M3/M2.x must be prompt-engineered + client-validated |
| **OpenRouter** | ✅ `json_object` | ⚠️ `json_schema` **passthrough, provider-dependent** | Use `provider.require_parameters:true`; `strict` enforcement "varies by provider" |

**Design consequences for a provider-agnostic layer:**

1. **You cannot promise strict structured output uniformly.** Only OpenAI, Anthropic, xAI, Qwen (5 families), Kimi, and Gemini (subset) give a real guarantee. **DeepSeek cannot do it at all; MiniMax cannot on its OpenAI-compatible endpoint; OpenRouter's guarantee depends on the routed provider.**
2. **Advertise capability, don't assume it.** Each provider adapter should declare `supports: {json_object, json_schema}`, and the layer should either downgrade gracefully (fall back to `json_object` + prompt instruction + client-side validation) or refuse the request — never silently send a `json_schema` the provider ignores.
3. **Always validate on the client anyway.** Even with `strict: true`, validate against your schema before use. Reasons: the model can still return semantically wrong values, OpenRouter's enforcement is provider-dependent, and DeepSeek explicitly warns about empty content.
4. **Translate the schema, don't forward it.** The schema dialects genuinely differ: Gemini needs SCREAMING-CASE types and rejects `additionalProperties`/`$ref`; OpenAI/Anthropic require `additionalProperties: false`; Kimi needs MFJS. A single canonical schema (a strict subset: objects with `properties`/`required`/`additionalProperties:false`, primitives, enums, arrays) plus per-provider emitters is the practical approach.
5. **Watch the token budget.** Structured output plus reasoning tokens can exhaust `max_completion_tokens`/`max_tokens`, producing `finish_reason: "length"` with truncated JSON. Qwen's docs explicitly advise against setting `max_tokens` with structured output.

---

## B.16 Suggested architecture notes for the provider-agnostic layer

**Interface shape.** Normalize on a canonical request/response:

```
Request:  { model, system, messages[], max_output_tokens, temperature?, json_schema?,
            tools?, stream?, timeout_s }
Response: { text, reasoning?, tool_calls[], finish_reason (canonical), usage{in,out,cached,reasoning},
            raw_finish_reason, provider, model_used, request_id }
```

**Adapter responsibilities (the irreducible per-provider work):**
1. **System prompt placement** — message (`system`, or `developer` for OpenAI o1+) vs Anthropic's top-level `system` vs Gemini's top-level `systemInstruction`.
2. **Text extraction** — the single path per provider, with the Anthropic `content[]` text-block filter and MiniMax `<think>` handling. Return `null`/raise rather than silently returning reasoning text or an empty string.
3. **Stop-reason normalization** — including Gemini's missing `tool_calls` value.
4. **Error normalization** — into a canonical class (`auth | rate_limit | quota_exhausted | bad_request | overloaded | server | timeout | content_filter | unknown`) with a `retryable` boolean. **This is the highest-value adapter work**: it is what lets one retry policy and one circuit breaker serve all providers.
5. **MiniMax's HTTP-200 error check** (`base_resp.status_code != 0`) — model it as an error, not a success.
6. **Streaming termination** — `[DONE]` vs Anthropic's `message_stop` vs MiniMax's bare stream close; plus comment-line skipping.
7. **Schema emission** — per-provider dialect, with capability gating.

**Pin models explicitly.** Every provider here has renamed, retired, or silently redirected models recently (`deepseek-chat` discontinued, `grok-3` silently redirecting, `gemini-2.0-flash` retiring 2026-06-01, `moonshot-v1-*` delisted, `abab*` gone). **Never ship a bare alias in production config without recording the concrete `model` the response reports** — OpenRouter's `~author/family-latest` and xAI's `latest` are convenient but can change behaviour under you silently. Log the returned `model` field on every call and alert when it changes.

**Verify with a cheap probe before trusting a provider.** A "list models" or 1-token completion call at startup validates the key, the base URL, the model ID, and the auth header in one shot, and turns a mid-session 401 into a startup failure.

---

## Sources

**Binance:** [Websocket Market Streams — Connect](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams) · [Important WebSocket Change Notice](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice) · [Live Subscribing/Unsubscribing](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Live-Subscribing-Unsubscribing-to-streams) · [Kline](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Kline-Candlestick-Streams) · [Mark Price](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Mark-Price-Stream) · [Aggregate Trade](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Aggregate-Trade-Streams) · [Individual Symbol Ticker](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Individual-Symbol-Ticker-Streams) · [All Market Tickers](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/All-Market-Tickers-Streams) · [Partial Book Depth](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Partial-Book-Depth-Streams) · [User Data Streams — Connect](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/user-data-streams/Connect) · [Start](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/user-data-streams/Start-User-Data-Stream) · [Keepalive](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/user-data-streams/Keepalive-User-Data-Stream) · [Close](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/user-data-streams/Close-User-Data-Stream) · [Order Update](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/user-data-streams/Event-Order-Update) · [Balance & Position Update](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/user-data-streams/Event-Balance-and-Position-Update) · [Margin Call](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/user-data-streams/Event-Margin-Call) · [Account Config Update](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/user-data-streams/Event-Account-Configuration-Update-previous-Leverage-Update) · [Stream Expired](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/user-data-streams/Event-User-Data-Stream-Expired) · [General Info](https://developers.binance.info/legacy-docs/derivatives/usds-margined-futures/general-info)

**LLM providers:** [OpenAI Chat reference](https://developers.openai.com/api/reference/resources/chat.md) · [OpenAI models](https://developers.openai.com/api/docs/models.md) · [OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits.md) · [DeepSeek API](https://api-docs.deepseek.com/api/create-chat-completion) · [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode) · [DeepSeek errors](https://api-docs.deepseek.com/quick_start/error_codes) · [Anthropic Messages](https://platform.claude.com/docs/en/api/messages) · [Anthropic models](https://platform.claude.com/docs/en/models/overview) · [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) · [Anthropic errors](https://platform.claude.com/docs/en/api/errors) · [Gemini generateContent](https://ai.google.dev/api/generate-content) · [Gemini models](https://ai.google.dev/gemini-api/docs/models) · [Gemini structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output) · [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) · [Qwen base URLs](https://www.alibabacloud.com/help/en/model-studio/base-url) · [Qwen OpenAI compatibility](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope) · [Qwen structured output](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output) · [xAI Chat Completions](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions) · [xAI models](https://docs.x.ai/developers/models) · [xAI structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs) · [Kimi API overview](https://platform.kimi.ai/docs/api/overview) · [Kimi chat](https://platform.kimi.ai/docs/api/chat) · [Kimi errors](https://platform.kimi.ai/docs/api/errors) · [MiniMax OpenAI SDK](https://platform.minimax.io/docs/api-reference/text-openai-api) · [MiniMax native text generation](https://platform.minimax.io/docs/api-reference/text-post) · [MiniMax error codes](https://platform.minimax.io/docs/api-reference/errorcode) · [MiniMax rate limits](https://platform.minimax.io/docs/guides/rate-limits) · [OpenRouter quickstart](https://openrouter.ai/docs/quickstart) · [OpenRouter streaming](https://openrouter.ai/docs/api_reference/streaming) · [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs) · [OpenRouter errors](https://openrouter.ai/docs/api_reference/errors-and-debugging) · [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits)
