# Binance USDⓈ-M Futures (USDT-M Perpetual) REST API — Implementation Reference

**Audience:** Node.js/TypeScript trading bot using native `fetch` + HMAC-SHA256.
**Scope:** USDⓈ-M Futures (`/fapi/*`) only. COIN-M (`/dapi/*`) and Portfolio Margin (`/papi/*`) are out of scope.
**Version basis:** Binance Derivatives Change Log through the **2026-09-10** entry; current docs (`developers.binance.com/docs/derivatives/...`) and the static legacy mirror (`developers.binance.com/legacy-docs/derivatives/...`).
**Documentation sources are cited inline.** Where a fact is version-sensitive it is marked with a verification status.

---

## ⚠️ READ THIS FIRST — The single most important breaking change

**Conditional orders are no longer placed on `POST /fapi/v1/order`.**

Effective **2025-12-09**, USDⓈ-M Futures migrated all conditional order types to a new **Algo Order API**:

> Effective on **2025-12-09**, USDⓈ-M Futures will migrate conditional orders to the Algo Service, which will affect the following order types: `STOP_MARKET`/`TAKE_PROFIT_MARKET`/`STOP`/`TAKE_PROFIT`/`TRAILING_STOP_MARKET`.
> The following endpoints will block the requests for order types after the migration … The error code `-4120` STOP_ORDER_SWITCH_ALGO will be encountered.
> — [Binance Derivatives Change Log, 2025-11-06](https://developers.binance.com/docs/derivatives/change-log#2025-11-06)

Blocked endpoints:

- `POST /fapi/v1/order`
- `POST /fapi/v1/batchOrders`

New endpoints:

| Purpose | Endpoint |
| --- | --- |
| Place an algo/conditional order | `POST /fapi/v1/algoOrder` |
| Cancel an algo order | `DELETE /fapi/v1/algoOrder` |
| Cancel all open algo orders | `DELETE /fapi/v1/algoOpenOrders` |
| Query an algo order | `GET /fapi/v1/algoOrder` |
| Query algo open order(s) | `GET /fapi/v1/openAlgoOrders` |
| Query algo order(s) (history) | `GET /fapi/v1/allAlgoOrders` |

Exact error returned by the old path ([Error Code page](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/error-code)):

```json
{"code": -4120, "msg": "Order type not supported for this endpoint. Please use the Algo Order API endpoints instead."}
```

Independently confirmed by Binance staff on the developer forum (2026-04-27) in response to a user hitting `-4120` on `POST /fapi/v1/order` with `type=STOP_MARKET`:
"Conditional orders have been migrated to the Algo Service. You will have to use the endpoint `POST fapi/v1/algoOrder`." — [dev.binance.vision/t/algo-order-endpoint-question/37372](https://dev.binance.vision/t/algo-order-endpoint-question/37372)

**Also note the parameter rename:** the Algo Order API uses **`triggerPrice`**, not `stopPrice`, for the trigger price. The `stopPrice` field still appears in order *responses* (order history / open orders) but is not the request parameter for new conditional orders.

**Consequences for a bot:**

1. `POST /fapi/v1/order` is now effectively for `LIMIT` and `MARKET` only.
2. `POST /fapi/v1/batchOrders` can no longer place stops — you cannot atomically submit entry + SL + TP in one batch any more.
3. `-4120` must be in your error-handling switch (see §7).
4. Additional behavioral changes after the migration ([Change Log 2025-11-06](https://developers.binance.com/docs/derivatives/change-log#2025-11-06)):
   - **No margin check before the conditional order gets triggered.**
   - `GTE_GTC` orders no longer depend on open orders of the opposite side, only on positions.
   - **Modification of untriggered conditional orders is not supported.**
   - No latency increase in triggering is expected.
5. `MAX_NUM_ALGO_ORDERS` was **removed** from `GET /fapi/v1/exchangeInfo` effective 2025-12-29; the conditional order limit is **200 across all symbols** ([Change Log 2025-12-29](https://developers.binance.com/docs/derivatives/change-log#2025-12-29)).

---

## 1. Base URLs

### 1.1 REST

| Environment | Base URL | Notes |
| --- | --- | --- |
| **Production** | `https://fapi.binance.com` | All `/fapi/v1`, `/fapi/v2`, `/fapi/v3` endpoints |
| **Demo / Testnet** | `https://demo-fapi.binance.com` | Binance renamed "Futures Testnet" → "Demo Trading". Stated as "The REST base url for **testnet**" in [General Info](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/general-info) |
| **Demo / Testnet (legacy host)** | `https://testnet.binancefuture.com` | Still listed as a `servers` entry (`https://testnet.binancefuture.com`) in the current generated OpenAPI docs for the Trade section. Historically the testnet host. |

Data-only (statistics) routes live under the **same host** but a different path prefix:

| Purpose | Path |
| --- | --- |
| Futures data (long/short ratios, OI history, taker volume, basis) | `https://fapi.binance.com/futures/data/*` |

> **Verification status:** `https://fapi.binance.com` and `https://demo-fapi.binance.com` — verified against the official General Info page. `https://testnet.binancefuture.com` — verified only as the host string emitted in the current docs' OpenAPI `servers` list; treat it as a legacy alias and prefer `demo-fapi.binance.com`.

### 1.2 WebSocket

**Market data streams (production)** — the URL structure changed in 2026. See [Important WebSocket Change Notice](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice):

| Category | Base URL | Stream types |
| --- | --- | --- |
| Root (legacy, **decommissioned 2026-04-23**) | `wss://fstream.binance.com` | High-frequency public only — no longer receives `/market` or `/private` data since the upgrade |
| Public | `wss://fstream.binance.com/public` | `<symbol>@bookTicker`, `!bookTicker`, `<symbol>@depth<levels>`, `<symbol>@depth` |
| Market | `wss://fstream.binance.com/market` | `<symbol>@aggTrade`, `<symbol>@markPrice`, `!markPrice@arr`, `<symbol>@kline_<interval>`, `<pair>_<contractType>@continuousKline_<interval>`, `<symbol>@miniTicker`, `!miniTicker@arr`, `<symbol>@ticker`, `!ticker@arr`, `<symbol>@forceOrder`, `!forceOrder@arr`, `<symbol>@compositeIndex`, `!contractInfo`, `!assetIndex@arr`, `<assetSymbol>@assetIndex` |
| Private (user data) | `wss://fstream.binance.com/private` | listenKey events: `ORDER_TRADE_UPDATE`, `ACCOUNT_UPDATE`, `MARGIN_CALL`, `TRADE_LITE`, `ALGO_UPDATE`, `CONDITIONAL_ORDER_TRIGGER_REJECT` (deprecated 2025-12-15) |

Two access modes per category:

- **`ws` mode** (path-based): `wss://fstream.binance.com/market/ws/btcusdt@aggTrade/ethusdt@aggTrade`
- **`stream` mode** (query-based): `wss://fstream.binance.com/market/stream?streams=bnbusdt@aggTrade/btcusdt@markPrice`
- **Private, `ws` mode:** `wss://fstream.binance.com/private/ws?listenKey=<key>&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE`
- **Private, `stream` mode:** `wss://fstream.binance.com/private/stream?listenKey=<k1>&events=ORDER_TRADE_UPDATE&listenKey=<k2>&events=ACCOUNT_UPDATE`

> **Gotcha:** after the upgrade, an un-migrated connection to `wss://fstream.binance.com/ws/...` will keep working **only for `public` streams**. Example given by Binance: `wss://fstream.binance.com/ws/btcusdt@depth` keeps working, but `wss://fstream.binance.com/ws/btcusdt@markPrice` will **not**. Always use the routed paths.

**Market data streams (testnet/demo):** three host names are in circulation and **all three currently serve data** — `wss://demo-fstream.binance.com` (what the docs say), `wss://fstream.binancefuture.com` (what Binance's own SDK constants say), and `wss://stream.binancefuture.com` (older). **Make this configurable and use routed paths.** See §8.2 for the full breakdown and the failure modes to avoid.

**WebSocket API (order placement over WS, production):** `wss://ws-fapi.binance.com/ws-fapi/v1` (available since 2024-04-01). Functionally equivalent to REST — same parameters, same filters, same rate limits, same error codes. Signing may be done **per request** or **once per session** via `session.logon`.

- **`session.logon` supports Ed25519 ONLY** ("Only _Ed25519_ keys are supported for this feature"), weight 2. After logging on, `apiKey`/`signature` may be omitted from subsequent requests; only one key can be authenticated at a time, and calling `session.logon` again switches keys. You may still pass an explicit `apiKey`+`signature` per request to override (e.g. a USER_DATA key by default, a TRADE key explicitly).
- **WS API signing differs from REST:** the payload is built from all params **sorted alphabetically by name** (`&`.join of `k=v`), then signed, then **base64**-encoded and sent as a plain `signature` field in the JSON body — **no URL-encoding**. (REST does not sort; it signs the literal transmitted string.)
- **Types matter:** `INT` parameters such as `timestamp` must be **JSON integers, not strings**; `DECIMAL` parameters such as `price` must be **JSON strings, not floats**.
- **Shared limits:** the WS API `ORDERS` limit is **per UID and shared with REST**. The WS API `REQUEST_WEIGHT` pool is separate from REST's. A WS handshake attempt costs **5** weight; `session.logon`/`session.status`/`session.logout` cost **2** each; `order.place` is **0** IP weight (it counts only against the order limits).
- **Revocation sentinel:** if your key is invalidated mid-session, the next request returns `{"id":null,"status":401,"error":{"code":-2015,...}}` — **`"id": null`** is the tell. Reconnect and re-logon.
- Every WS API response includes a `rateLimits[]` array; suppress it with `?returnRateLimits=false` on the connection URL or per-request `"returnRateLimits": true`. Ping/pong frames are limited to **5 per second**.

**Connection and keepalive rules (market streams):**

- A single connection is valid for **24 hours**; expect a disconnect at the 24-hour mark and reconnect with backoff.
- The server sends a **ping frame every 3 minutes**; you must reply with a **pong** carrying the same payload. If no pong is received within **10 minutes**, the connection is dropped. (Unsolicited pongs are allowed.)
- **10 incoming messages per second** per connection; exceeding it gets you disconnected, and repeated disconnects can get the IP banned.
- A single connection may listen to a maximum of **1024 streams** (raised from 200 on 2025-07-02).
- Symbols in stream names must be **lowercase**. Combined-stream events are wrapped as `{"stream":"<streamName>","data":<rawPayload>}`.

**WebSocket API (testnet/demo):** `wss://testnet.binancefuture.com/ws-fapi/v1` — *single-source; verify before use.*

### 1.3 `/fapi/v1` vs `/fapi/v2` vs `/fapi/v3`

The version split applies **only to account/balance/position endpoints**. Everything else is `/fapi/v1`.

| Concern | `/fapi/v1` | `/fapi/v2` | `/fapi/v3` |
| --- | --- | --- | --- |
| Account info | — | `GET /fapi/v2/account` | `GET /fapi/v3/account` |
| Balance | — | `GET /fapi/v2/balance` | `GET /fapi/v3/balance` |
| Position risk | — | `GET /fapi/v2/positionRisk` | `GET /fapi/v3/positionRisk` |
| Per-symbol config (leverage, marginType, etc.) | `GET /fapi/v1/symbolConfig` | — | — |
| Account-level config | `GET /fapi/v1/accountConfig` | — | — |

**How v2 and v3 differ** ([Change Log 2024-07-24](https://developers.binance.com/docs/derivatives/change-log#2024-07-24)):

- **v3 returns only symbols that the user has a position or open order in.** v2 returns *all* symbols (a large array with many zero rows).
- **v3 removed configuration-related fields.** Those moved to `GET /fapi/v1/symbolConfig` and `GET /fapi/v1/accountConfig`.
- v3 "also offers better performance."

Deprecation: on 2024-07-24 Binance announced `GET /fapi/v2/balance`, `GET /fapi/v2/account`, `GET /fapi/v2/positionRisk` (and the WS API `account.status`/`account.balance`/`account.position`) would be deprecated "in the coming months (exact date to be announced later)." **As of the current docs, the v2 endpoints are still documented and callable**, but v3 + `/fapi/v1/symbolConfig` + `/fapi/v1/accountConfig` is the forward-compatible choice. Note the practical difference: with v3 you must track symbols yourself.

Weight change note ([Change Log 2024-08-07](https://developers.binance.com/docs/derivatives/change-log#2024-08-07)): `GET /fapi/v2/balance`, `/fapi/v2/account`, `/fapi/v2/positionRisk` had IP weight adjusted `5 -> 10` effective 2024-09-03. The current generated docs display **IP Weight 5** for `GET /fapi/v2/positionRisk` and `GET /fapi/v3/positionRisk`. **This is a live discrepancy — do not hardcode; read the weight from the docs/exchangeInfo and budget for 10.** (See §7.)

---

## 2. Authentication & Signing

Source: [General Info — Endpoint Security Type](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/general-info) and the current generated docs' request schemas.

### 2.1 Security types

| Type | Requirement |
| --- | --- |
| `NONE` | Public, no auth |
| `MARKET_DATA` | API key only (no signature) |
| `USER_STREAM` | API key only (no signature) — e.g. `POST /fapi/v1/listenKey` |
| `TRADE` | API key **+ signature** |
| `USER_DATA` | API key **+ signature** |

`TRADE` + `USER_DATA` are the `SIGNED` endpoints.

### 2.2 API key header

```
X-MBX-APIKEY: <your-api-key>
```

- Exact header name: **`X-MBX-APIKEY`** (all caps, hyphenated). Confirmed in both the prose docs and the generated cURL examples.
- API keys and secret keys are **case sensitive**.
- Keys can be scoped to only some secure endpoint types.

### 2.3 `timestamp` and `recvWindow`

| Parameter | Type | Notes |
| --- | --- | --- |
| `timestamp` | LONG (ms) | **Mandatory** on every SIGNED endpoint. Millisecond Unix timestamp of when the request was created. |
| `recvWindow` | LONG (ms) | Optional. **Default `5000`**. The OpenAPI-generated request schemas annotate **`max: 60000`**, but the fapi prose documents **no maximum** and Binance's own RSA example uses `recvWindow=9999999`. The "`recvWindow` must be less than 60000" rule is **Spot/Options-scoped** (`-1131 BAD_RECV_WINDOW` is *Options*, not UM). **Keep `recvWindow` at 5000 — not because of a hard cap, but because Binance recommends ≤ 5000 and a large window widens your replay exposure.** |

Documented validation logic:

```
if (timestamp < serverTime + 1000 && serverTime - timestamp <= recvWindow) {
  // process request
} else {
  // reject request
}
```

i.e. the request is rejected if the timestamp is **more than 1000 ms in the future**, or if the server time is more than `recvWindow` ms ahead of your timestamp. Binance: "It is recommended to use a small recvWindow of 5000 or less!"

> Note this logic is asymmetric: it tolerates only 1000 ms of *positive* client clock skew, but tolerates `recvWindow` of *negative* skew (your clock behind the server).

### 2.4 The signature

- Algorithm: **HMAC SHA256** (keyed). Key = your `secretKey`, message = `totalParams`.
- `totalParams` is defined as **the query string concatenated with the request body**.
- `signature` may be sent in the query string **or** the request body.
- `signature` is **not case sensitive** (hex digest).
- **"Please make sure the `signature` is the end part of your query string or request body."**
- For `GET`, all parameters go in the query string. For `POST`/`PUT`/`DELETE`, parameters may go in the query string, in an `application/x-www-form-urlencoded` body, or **split across both** — if a parameter appears in both, the **query string wins**.
- Parameters may be sent **in any order** (the server does not re-sort for signing; it uses the literal string you sent).

**Canonical example** (from the official docs, HMAC keys):

```
apiKey    = dbefbc809e3e83c283a984c3a1459732ea7db1360ca80c5c2c8867408d28cc83
secretKey = 2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9

payload (payload string, NOT including "signature"):
symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943

HMAC-SHA256(payload, secretKey) = 3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9
```

Resulting request:

```
POST https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943&signature=3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9
Header: X-MBX-APIKEY: dbefbc809e3e83c283a984c3a1459732ea7db1360ca80c5c2c8867408d28cc83
```

**Mixed query string + body example** — the signed string is a *bare concatenation*, **with no `&` inserted at the join point**:

- query string: `symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=GTC`
- request body: `quantity=1&price=9000&recvWindow=5000&timestamp=1591702613943`
- `totalParams` = `symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=GTCquantity=1&price=9000&recvWindow=5000&timestamp=1591702613943`
- signature = `f9d0ae5e813ef6ccf15c2b5a434047a0181cb5a342b903b367ca6d27a66e36f2`

> **This is a real footgun.** The cleanest strategy for a bot: **put all parameters in exactly one place** (query string for GET/DELETE, form body for POST/PUT), sign the exact serialized string you will transmit, and never mix.

### 2.5 URL-encoding rules for the signed string

The signature must be computed over **the exact byte sequence that the server will reconstruct**, so:

1. Build `key=value` pairs.
2. Percent-encode each **value** (and key, if needed) using the same rules the server expects.
3. Join with `&`.
4. **Sign that string.** Do **not** sign a decoded/normalized variant.
5. Append `&signature=<hex>` **last**.
6. Send the string **byte-identical** to what you signed.

Binance's own reference implementation (`rawurlencode` in the RSA example) treats exactly this as unreserved:

```
[-_.~a-zA-Z0-9]  -> unchanged
everything else  -> %XX (uppercase hex)
```

**JavaScript caveat:** `encodeURIComponent()` does **not** escape `!`, `'`, `(`, `)`, `*`. Binance's `rawurlencode` **does** escape them. For typical futures payloads (numbers, uppercase tickers, enum values, and the `^[\.A-Z\:/a-z0-9_-]{1,36}$` client-order-id charset) this never matters — but if you ever put arbitrary user text in a parameter, write an explicit RFC 3986 encoder rather than relying on `encodeURIComponent`.

Practical safe value set for this API: decimal quantities/prices, `true`/`false`, uppercase enums, ticker symbols. All are unreserved.

**Chinese symbols gotcha (2025-10-09):** Futures now supports symbols containing Chinese characters (e.g. `"symbol": "测试USDT"`). If `symbol` contains non-ASCII, it **must** be UTF-8 percent-encoded — Binance's own example:
`https://fapi.binance.com/fapi/v1/order?symbol=%E6%B5%8B%E8%AF%95USDT&side=BUY&type=TAKE_PROFIT_MARKET&timeInForce=GTC&quantity=1&stopPrice=30&timestamp=1760000007980`.
Unencoded Chinese may fail or produce parameter-parsing errors. ([Change Log 2025-10-09](https://developers.binance.com/docs/derivatives/change-log#2025-10-09))

### 2.6 RSA and Ed25519 keys

- **RSA is supported on USDⓈ-M Futures.** From the official docs: "We support `PKCS#8` currently. To get your API key, you need to upload your RSA Public Key to your account…"
  - Signing: `RSASSA-PKCS1-v1_5` with SHA-256.
  - The signature is **binary → Base64**, then **URL-encoded** before being placed in the query string ("Since the signature may contain `/` and `=`, this could cause issues with sending the request. So the signature has to be URL encoded.").
  - The rest of the flow (payload construction, `signature` last) is identical to HMAC.
  - Error code confirming RSA on futures: `-4057 INVALID_RSA_PUBLIC_KEY` — "Invalid api public key".
- **Ed25519:** **undocumented for the USDⓈ-M Futures REST API.** A full-text search of Binance's entire documentation corpus finds **zero** occurrences of "Ed25519" in the fapi REST documentation. The futures General Info and Error Code pages document only **HMAC SHA256** and **RSA** (there is an RSA-specific error `-4057 INVALID_RSA_PUBLIC_KEY`, and **no** Ed25519 analogue). Spot's API-key FAQ (`Ed25519 (recommended) / HMAC / RSA`, and its "HMAC keys are deprecated" note) is **Spot-scoped — do not import it into futures**. Treat Ed25519 on `/fapi/*` REST as **unsupported / unverified**.
  - **Important exception:** Ed25519 **is** documented for the USDⓈ-M **WebSocket API** — `session.logon` states "**Only _Ed25519_ keys are supported for this feature.**" (§1.2). So Ed25519 is real on futures, just not on the REST signing path.
  - Practical guidance for your bot: **use HMAC SHA256.** If you need asymmetric keys for REST, use RSA PKCS#8. Only reach for Ed25519 if you adopt the WebSocket API with `session.logon`.

### 2.7 `X-MBX-TIME-UNIT`

**Not a USDⓈ-M Futures feature.** The `X-MBX-TIME-UNIT` request header (which lets a client select `MILLISECOND`/`MICROSECOND` and correspondingly changes `timestamp` units) was introduced in the **Spot** API changelog (`binance-spot-api-docs/CHANGELOG.md`: "A new optional header `X-MBX-TIME-UNIT` can be sent in the request to select the time unit…").

It does **not** appear in:

- the futures [General Info](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/general-info) page,
- the futures [Error Code](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/error-code) page,
- any generated futures request schema (every signed futures request schema shows `timestamp integer · int64`, described as "Unix timestamp in **milliseconds**").

**Corpus-level confirmation:** a full-text search of Binance's *entire* published documentation corpus (the 8.2 MB `llms-full.txt`) finds the string `X-MBX-TIME-UNIT` **exactly 6 times, every one of them inside the two Spot API documents**, where it reads:

> "All time and timestamp related fields in the JSON responses are in **milliseconds by default.** To receive the information in microseconds, please add the header `X-MBX-TIME-UNIT:MICROSECOND` or `X-MBX-TIME-UNIT:microsecond`."

The Spot change log entry "New Feature: Microsecond support" (2024-12-17) names the values `MILLISECOND`/`millisecond`/`MICROSECOND`/`microsecond`, and it is opt-in. There are **zero** occurrences in the USDⓈ-M futures or common-derivatives documentation spans.

**Conclusion: `X-MBX-TIME-UNIT` is Spot-only. Do not send it to `/fapi/*`. `timestamp` is always milliseconds on USDⓈ-M futures.**

### 2.8 Server-time sync and the `-1021` error

**Endpoint:** `GET /fapi/v1/time` (security type `NONE`). Response: `{"serverTime": 1499827319559}`.

**Error code `-1021 INVALID_TIMESTAMP`** has two documented messages:

```
Timestamp for this request is outside of the recvWindow.
Timestamp for this request was 1000ms ahead of the server's time.
```

**Root causes, in order of likelihood:**

1. **Local clock drift** (VM clock, container clock, laptop sleep/wake). Even 1–2 seconds of drift breaks `recvWindow=5000` intermittently.
2. **Timestamp in the wrong unit** — seconds instead of milliseconds, or microseconds via a stray `X-MBX-TIME-UNIT`-style assumption.
3. **`timestamp` generated after the signature but the string signed is different** — a classic bug is computing `timestamp` inside the signer and again in the sender, producing two different values. Generate it **once**, use the same value for signing and transmission.
4. **`recvWindow` too small** for a slow/retried request or for the **matching-engine** leg of the check (see `-5028` below).
5. **Signing a re-serialized payload** — e.g. signing a `URLSearchParams` then sending a differently-ordered/re-encoded string.
6. **Stale static timestamp** in a long-lived process that never refreshes.

> **There are TWO `recvWindow` checks, and they produce different errors.** The API gateway produces `-1021 INVALID_TIMESTAMP`; the **matching engine** independently produces **`-5028 ME_RECVWINDOW_REJECT`** ("Timestamp for this request is outside of the ME recvWindow."). The engine-side check was added 2023-04-18 and applies to `POST`/`PUT /fapi/v1/order` and `POST`/`PUT /fapi/v1/batchOrders` (COIN-M twin: `-4188`). **A request can pass the gateway and still be rejected by the engine.** Handle `-5028` with the same re-sync-then-retry-once logic as `-1021`, and do not set `recvWindow` so tight that engine latency alone trips it. Full details in §7.4.

**How to avoid it (recommended bot design):**

1. On startup, call `GET /fapi/v1/time`, record `offsetMs = serverTime - Date.now()`.
2. Use `timestamp = Date.now() + offsetMs` for every signed request.
3. Re-sync periodically (e.g. every 15–60 minutes) and immediately after any `-1021`.
4. Keep `recvWindow` at **5000** (or 10000 worst case); never push it to the 60000 max as a band-aid — it widens your replay/timing exposure and Binance explicitly recommends ≤ 5000.
5. On `-1021`: re-sync time, then retry **once** with a freshly computed signature. Do not blind-retry the same signed payload — the timestamp is already outside the window and the same bytes will fail again.
6. Never reuse a signed query string across retries; re-sign with a new `timestamp`.

---

## 3. Account & Position Endpoints

### 3.1 `GET /fapi/v2/account` / `GET /fapi/v3/account` — Account Information

**Security:** `USER_DATA` (signed). **Params:** `timestamp` (required), `recvWindow` (optional).
**Weight:** **5** for `GET /fapi/v2/account` (per the current endpoint page). *Note: the 2024-08-07 change log announced `GET /fapi/v2/account`, `/fapi/v2/balance`, `/fapi/v2/positionRisk` would go `5 -> 10` effective 2024-09-03; the current endpoint pages still display 5. Budget for 10 and confirm against the live page.*

> `GET /fapi/v2/account` behaves differently in **single-asset** vs **multi-assets** mode. In single-asset mode the `total*` fields are "**only for USDT asset**". In multi-assets mode they are **USD values aggregated across all assets**. The `totalInitialMargin` field is annotated "useless with isolated positions". Do not compare totals across modes.

Top-level fields (the ones a bot actually needs):

| Field | Meaning |
| --- | --- |
| `feeTier` | Account commission tier |
| **`feeBurn`** | **`true` = Fee Discount (BNB burn) On; `false` = Off.** Present on the account response — you do not need a separate call to `/fapi/v1/feeBurn` to read it |
| `canTrade` | Whether trading is enabled |
| `canDeposit` / `canWithdraw` | Transfer permissions |
| `updateTime` | **Documented as "reserved property, please ignore".** Do not use it to detect changes — use the user data stream |
| `multiAssetsMargin` | `true` = Multi-Assets mode |
| `tradeGroupId` | Trade group id (STP scope); `-1` when not in a group |
| `totalInitialMargin` | Total initial margin across all positions |
| `totalMaintMargin` | Total maintenance margin |
| **`totalWalletBalance`** | **Wallet balance (no unrealized PnL)** — the closest thing to "my cash" |
| **`totalUnrealizedProfit`** | **Sum of unrealized PnL on all open positions** |
| **`totalMarginBalance`** | **`totalWalletBalance + totalUnrealizedProfit`** — the margin balance |
| `totalPositionInitialMargin` | Initial margin required by positions |
| `totalOpenOrderInitialMargin` | Initial margin required by open orders |
| `totalCrossWalletBalance` | Cross wallet balance |
| `totalCrossUnPnl` | Cross unrealized PnL |
| **`availableBalance`** | **Free margin available to open new positions** |
| `maxWithdrawAmount` | Max transferable out |

Nested `assets[]` (per margin asset, e.g. one entry for `USDT`):

`asset`, `walletBalance`, `unrealizedProfit`, `marginBalance`, `maintMargin`, `initialMargin`, `positionInitialMargin`, `openOrderInitialMargin`, `crossWalletBalance`, `crossUnPnl`, `availableBalance`, `maxWithdrawAmount`, `marginAvailable`, `updateTime`.

**Nested `positions[]` — the exact field set (this differs from `positionRisk`, see the warning below):**

`symbol`, `initialMargin`, `maintMargin`, **`unrealizedProfit`** (lowercase `r`), `positionInitialMargin`, `openOrderInitialMargin`, `leverage`, **`isolated`** (a **boolean**, not a `marginType` string), `entryPrice`, **`maxNotional`**, `bidNotional` (ignore), `askNotional` (ignore), `positionSide`, `positionAmt`, `updateTime`.

Documented behavior notes for this array:

- "**positions of all symbols in the market are returned**" (it is not filtered to symbols you hold).
- "only `BOTH` positions will be returned with One-way mode; only `LONG` and `SHORT` positions will be returned with Hedge mode."

> **⚠️ DO NOT confuse `account.positions[]` with `positionRisk[]`.** They are different shapes with overlapping-but-different names:
>
> | Concept | `GET /fapi/v2/account` → `positions[]` | `GET /fapi/v2/positionRisk[]` |
> | --- | --- | --- |
> | Unrealized PnL field | `unrealizedProfit` (lowercase `r`) | `unRealizedProfit` (**capital `R`**) |
> | Margin mode | `isolated` (**boolean**) | `marginType` (**string**, lowercase `cross`/`isolated`) |
> | Max notional | `maxNotional` | `maxNotionalValue` |
> | Mark price | **absent** | `markPrice` |
> | Liquidation price | **absent** | `liquidationPrice` |
> | Break-even price | **absent** | `breakEvenPrice` |
> | `notional`, `isolatedWallet`, `adl` | **absent** | present |
>
> If you want mark price, liquidation price, or notional, **call `positionRisk`** — the account endpoint does not give them. A common bug is reading `position.unrealizedProfit` from the wrong response and getting `undefined`.
>
> The "absent" rows describe the **documented** response shape. If your account currently returns extra fields (e.g. `breakEvenPrice`), feel free to use them — but build the bot against `positionRisk` for anything price-related, since that endpoint's contract is stable and explicit.

> **v3 differences in detail.** `GET /fapi/v3/account` keeps the same 11 `total*` fields at the top level but:
>
> - **Top level loses:** `feeTier`, `feeBurn`, `canTrade`, `canDeposit`, `canWithdraw`, `multiAssetsMargin`, `tradeGroupId`, `updateTime`. These move to `GET /fapi/v1/accountConfig` (§3.9).
> - **`assets[]` loses:** `marginAvailable`. (Docs omit it; the Go SDK still declares it — treat it as optional.)
> - **`positions[]` shrinks to exactly 10 fields:** `symbol`, `positionSide`, `positionAmt`, `unrealizedProfit`, `isolatedMargin`, `notional`, `isolatedWallet`, `initialMargin`, `maintMargin`, `updateTime`. **Gone vs v2:** `leverage`, `isolated`, `entryPrice`, `maxNotional`, `bidNotional`, `askNotional`, `positionInitialMargin`, `openOrderInitialMargin`.
> - **`positions[]` contains only symbols where you have a position or open order** — with `positionAmt: "0"` rows still present for symbols that only have open orders.
>
> So: if you need `entryPrice` or `leverage` per position from the *account* endpoint, you must be on **v2**, or call `symbolConfig` + `positionRisk`. This is the main reason to keep v2 around.

**The identity to assert in tests:** `totalMarginBalance == totalWalletBalance + totalUnrealizedProfit` (subject to rounding; all values are **strings**, not numbers).

### 3.2 `GET /fapi/v2/balance` / `GET /fapi/v3/balance` — Futures Account Balance

Lighter-weight alternative when you only need wallet/available balance.

Response: an **array**, one object per asset:

| Field | Meaning |
| --- | --- |
| `accountAlias` | Account alias |
| `asset` | e.g. `USDT` |
| `balance` | Wallet balance |
| `crossWalletBalance` | Cross wallet balance |
| `crossUnPnl` | Cross unrealized PnL |
| `availableBalance` | Available balance |
| `maxWithdrawAmount` | Max withdrawable |
| `marginAvailable` | Whether usable as margin |
| `updateTime` | ms |

**Weight:** documented `5` historically, adjusted to `10` effective 2024-09-03. Current generated docs show a value — **verify**.

### 3.3 `GET /fapi/v2/positionRisk` — Position Information V2

**Security:** `USER_DATA` (signed). **Params:** `symbol` (optional), `timestamp` (required), `recvWindow`.
**Weight:** **5** for `GET /fapi/v2/positionRisk` per the current endpoint page. *The 2024-08-07 change log raised v2 5 → 10 effective 2024-09-03, and**v3 did not exist yet** — so if you want the un-raised value, use **v3**. Budget 10 and monitor `X-MBX-USED-WEIGHT-1M`.*

> **v2 does NOT return** `marginAsset`, `initialMargin`, `maintMargin`, `positionInitialMargin`, `openOrderInitialMargin`, `adl`, `bidNotional`, or `askNotional` — those are **v3-only** (or account-only). Verified across both doc mirrors and the Go SDK. If your code reads `.marginAsset` off a v2 row it will be `undefined`.
**Behavior:** `symbol` omitted ⇒ returns **all symbols**, with a row per symbol per position side.

Full response row fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `symbol` | string | e.g. `BTCUSDT` |
| `positionSide` | string | `BOTH` (one-way), `LONG` or `SHORT` (hedge) |
| **`positionAmt`** | string | Position size. **Signed in one-way mode**: `> 0` long, `< 0` short. In hedge mode the sign normally matches `positionSide` (`LONG` positive, `SHORT` negative) |
| `entryPrice` | string | Average entry price (`0.00000` when flat) |
| `breakEvenPrice` | string | Break-even price including fees |
| `markPrice` | string | Current mark price |
| **`unRealizedProfit`** | string | **Note the capital `R`** — `unRealizedProfit`, not `unrealizedProfit` (v2). Unrealized PnL |
| `liquidationPrice` | string | Liquidation price; `0` when flat or not applicable |
| `leverage` | string | Current leverage, e.g. `"10"` |
| `maxNotionalValue` | string | Max notional allowed at this leverage bracket |
| `marginType` | string | **Lowercase**: `"cross"` or `"isolated"` (read) vs. `ISOLATED`/`CROSSED` (write — see §4.2) |
| `isolatedMargin` | string | Isolated margin amount |
| `isAutoAddMargin` | string | **Returned as a string** `"true"`/`"false"` in v2 (not a boolean) |
| `notional` | string | Position notional = `abs(positionAmt) * markPrice` |
| `isolatedWallet` | string | Isolated wallet balance; `"0"` in cross |
| `updateTime` | number | ms; `0` for a never-touched flat row |

Example (one-way, from the docs):

```json
[{
  "entryPrice": "0.00000",
  "breakEvenPrice": "0.0",
  "marginType": "isolated",
  "isAutoAddMargin": "false",
  "isolatedMargin": "0.00000000",
  "leverage": "10",
  "liquidationPrice": "0",
  "markPrice": "6679.50671178",
  "maxNotionalValue": "20000000",
  "positionAmt": "0.000",
  "notional": "0",
  "isolatedWallet": "0",
  "symbol": "BTCUSDT",
  "unRealizedProfit": "0.00000000",
  "positionSide": "BOTH",
  "updateTime": 0
}]
```

### 3.4 `GET /fapi/v3/positionRisk` — Position Information V3 (recommended)

**Same weight (5).** Only symbols with a position or open order are returned. It **removes** the v2 config-oriented fields and **adds** margin detail:

Removed vs v2: `leverage`, `maxNotionalValue`, `marginType`, `isAutoAddMargin` (get these from `GET /fapi/v1/symbolConfig`).

Added:

| Field | Meaning |
| --- | --- |
| `marginAsset` | Margin asset, e.g. `USDT` |
| `initialMargin` | Initial margin required at current mark price |
| `maintMargin` | Maintenance margin required |
| `positionInitialMargin` | Initial margin for the position |
| `openOrderInitialMargin` | Initial margin required by open orders |
| `adl` | ADL ranking (integer), example `2` |
| `bidNotional` / `askNotional` | Documented as "ignore" |

Kept: `symbol`, `positionSide`, `positionAmt`, `entryPrice`, `breakEvenPrice`, `markPrice`, `unRealizedProfit`, `liquidationPrice`, `isolatedMargin`, `notional`, `isolatedWallet`, `updateTime`.

> `positionAmt` in v3 is documented as **"position amount, positive for long, negative for short"** — an explicit statement of the sign convention.

**Use v3** unless you specifically need leverage/marginType inline; pair it with `GET /fapi/v1/symbolConfig`.

### 3.5 `GET /fapi/v1/income` — Get Income History

**Security:** `USER_DATA`. **Params:**

| Param | Notes |
| --- | --- |
| `symbol` | Optional |
| `incomeType` | Optional; see enum below |
| `startTime` / `endTime` | ms |
| `page` | Optional (newer addition) |
| `limit` | Optional, default `100`, max `1000` |
| `timestamp` / `recvWindow` | Standard |

**Weight:** **30**. `startTime` and `endTime` are **inclusive**. If omitted, the **most recent 7 days** are returned. **"Income history only contains data for the last three months."** `tranId` is documented as unique **within the same `incomeType`** for a user — the docs misspell it `trandId`, and the field is really named **`tranId`** in responses.

`incomeType` enum values:

`TRANSFER`, `WELCOME_BONUS`, `REALIZED_PNL`, `FUNDING_FEE`, `COMMISSION`, `INSURANCE_CLEAR`, `REFERRAL_KICKBACK`, `COMMISSION_REBATE`, `API_REBATE`, `CONTEST_REWARD`, `CROSS_COLLATERAL_TRANSFER`, `OPTIONS_PREMIUM_FEE`, `OPTIONS_SETTLE_PROFIT`, `INTERNAL_TRANSFER`, `AUTO_EXCHANGE`, `DELIVERED_SETTELMENT` *(sic — Binance's spelling)*, `COIN_SWAP_DEPOSIT`, `COIN_SWAP_WITHDRAW`, `POSITION_LIMIT_INCREASE_FEE`, `STRATEGY_UMFUTURES_TRANSFER`, `FEE_RETURN`, `BFUSD_REWARD`, and **`SPECIAL_FUNDING_FEE`** (TradFi dividend funding fee, added **2026-09-10**).

> `DELIVERED_SETTELMENT` is misspelled in the API itself. Match it exactly. Also note **`SPECIAL_FUNDING_FEE`** will be unknown to older client enum validators — do not `assertNever` on income types.

Response fields per row: `symbol`, `incomeType`, `income`, `asset`, `info`, `time`, `tranId`, `tradeId`.

Key uses: `REALIZED_PNL` + `FUNDING_FEE` + `COMMISSION` = your true PnL decomposition. `incomeType=REALIZED_PNL` with `symbol` is the cheapest way to reconcile realized PnL per symbol.

### 3.6 `GET /fapi/v1/userTrades` — Account Trade List

**Security:** `USER_DATA`. **Weight:** **5**.

| Param | Notes |
| --- | --- |
| `symbol` | **Required** |
| `orderId` | Must be used together with `symbol` |
| `startTime` / `endTime` | ms; window ≤ 7 days |
| `fromId` | Trade id to fetch from; default = most recent. **Cannot be combined with `startTime`/`endTime`** |
| `limit` | Default **500**, max **1000** |
| `timestamp` / `recvWindow` | Standard |

Documented constraints: if `startTime`/`endTime` are both omitted the **last 7 days** are returned; the span between them **cannot exceed 7 days**; **only the past 3 months** are queryable (changed from 6 months effective **2026-08-26**).

Response row fields (current, after the 2026-08-05 additions):

`buyer` (bool), `commission`, `commissionAsset`, `id`, `maker` (bool), `orderId`, `price`, `qty`, **`quoteQty`** (populated for USDⓈ-M; `"0"` for COIN-M), **`baseQty`** (populated for COIN-M; `"0"` for USDⓈ-M), `marginAsset`, `realizedPnl`, `side`, `positionSide`, `symbol`, **`pair`**, `time`.

> **Gotchas:** `realizedPnl` is per-fill, not per-order. Sum `realizedPnl` for a symbol to get realized PnL, but remember `commission` and `FUNDING_FEE` (from `/fapi/v1/income`) are separate. `id` is the **trade id**, `orderId` groups fills. `maker`/`buyer` are booleans, `price`/`qty` are strings.

### 3.7 Commission rate

- **`GET /fapi/v1/commissionRate`** — "User Commission Rate". **Security:** `USER_DATA` (signed). **Weight: 20.** Params: `symbol` (required), `timestamp`, `recvWindow`.
  - Response: `symbol`, `makerCommissionRate`, `takerCommissionRate` (e.g. `"0.0002"` / `"0.0004"`), plus **`rpiCommissionRate`** (e.g. `"0.00005"`), added **2025-11-26** for RPI (Retail Price Improvement) orders ([Change Log 2025-11-25](https://developers.binance.com/docs/derivatives/change-log#2025-11-25)).
  - **Weight 20 is expensive** — cache it per symbol (rates change rarely, and only with VIP tier).
- BNB burn (fee discount) is controlled separately: `POST /fapi/v1/feeBurn` / `GET /fapi/v1/feeBurn` (added 2024-05-22), and its status also shows in `GET /fapi/v1/accountConfig`.
- The account's `feeTier` from `/fapi/v2/account` is a coarse indicator; **`commissionRate` is authoritative** and includes per-symbol and RPI-specific rates.

### 3.8 Position mode: one-way vs hedge (dual-side) — the critical gotchas

**Global switch:** `POST /fapi/v1/positionSide/dual` with `dualSidePosition=true` (Hedge Mode) / `false` (One-way Mode). Read it with `GET /fapi/v1/positionSide/dual`. Applies to **all symbols**.

**`positionSide` rules per order:**

| Mode | `positionSide` on `POST /fapi/v1/order` (and `/fapi/v1/algoOrder`) |
| --- | --- |
| **One-way** | Omit it, or send **`BOTH`**. It is the default and the only allowed value. |
| **Hedge (dual-side)** | **MANDATORY.** Must be **`LONG`** or **`SHORT`**. |

Docs (New Order): "Default `BOTH` for One-way Mode; `LONG` or `SHORT` for Hedge Mode. **It must be sent in Hedge Mode.**"

**`reduceOnly` rules:**

| Mode | `reduceOnly` |
| --- | --- |
| One-way | Allowed: `"true"` / `"false"`, default `"false"` |
| **Hedge** | **"Cannot be sent in Hedge Mode."** Sending it in hedge mode is an error. |

This is the single most common integration bug: in hedge mode you must **not** send `reduceOnly`; instead you express intent through `positionSide` + `side` (a `SELL` on `positionSide=LONG` reduces the long). Conversely, `closePosition=true` in hedge mode "cannot be used with BUY orders in LONG position side, and cannot be used with SELL orders in SHORT position side."

**How `positionAmt` encodes direction (one-way mode):**

- `positionAmt > 0` ⇒ **long**
- `positionAmt < 0` ⇒ **short**
- `positionAmt == 0` ⇒ flat
- `notional = abs(positionAmt) * markPrice`
- To compute the signed exposure for risk math, use `positionAmt` directly (it is already signed). In hedge mode, prefer `positionSide` and treat `abs(positionAmt)`.

**Cross-mode errors to expect:** `-4060 INVALID_POSITION_SIDE` ("Invalid position side."), `-4061 POSITION_SIDE_NOT_MATCH` ("Order's position side does not match user's setting."), `-4062 REDUCE_ONLY_CONFLICT` ("Invalid or improper reduceOnly value."), `-4059 NO_NEED_TO_CHANGE_POSITION_SIDE` ("No need to change position side.").

**Recent change (2026):** after the COIN-M/USDⓈ-M integration, **UM and CM share the same `dualSidePosition` setting**. Calling `POST /fapi/v1/positionSide/dual` flips **both** at once, and the change is **rejected** if either side has an open order or position:

- `-4067` open orders exist — "Position side cannot be changed if there exists open orders."
- `-4068` open position exists — "Position side cannot be changed if there exists position."
- `-4531` (temporary, added 2026-05-11): "Position mode change requires syncing UM and CM. Please close any open positions or orders in CM and try again."

Source: [Change Log 2026-05-11](https://developers.binance.com/docs/derivatives/change-log#2026-05-11).

### 3.9 Per-symbol configuration: `GET /fapi/v1/symbolConfig` and `GET /fapi/v1/accountConfig`

Since v3 removed configuration fields, these are the canonical source for settings.

**`GET /fapi/v1/symbolConfig`** — `USER_DATA`, weight **5**. Param `symbol` **optional** (omit ⇒ array for all symbols). Returns an **array**:

```json
[{
  "symbol": "BTCUSDT",
  "marginType": "CROSSED",
  "isAutoAddMargin": false,
  "leverage": 21,
  "maxNotionalValue": "1000000"
}]
```

**(For `GET /fapi/v1/accountConfig`)** — `USER_DATA`, weight **5**. Returns:

```json
{
  "feeTier": 0,
  "canTrade": true,
  "canDeposit": true,
  "canWithdraw": true,
  "dualSidePosition": true,
  "updateTime": 0,
  "multiAssetsMargin": false,
  "tradeGroupId": -1
}
```

> **⚠️ Three different encodings of the same concepts — a guaranteed source of bugs:**
>
> | Concept | `symbolConfig` | `positionRisk` v2 | `POST /marginType` request |
> | --- | --- | --- | --- |
> | Margin mode | `"CROSSED"` / `"ISOLATED"` (**uppercase string**) | `"cross"` / `"isolated"` (**lowercase string**) | `ISOLATED` / `CROSSED` (**uppercase**) |
> | Auto-add-margin | `isAutoAddMargin`: **boolean** `false` | `isAutoAddMargin`: **string** `"false"` | n/a |
> | Leverage | `leverage`: **number** `21` | `leverage`: **string** `"10"` | request: `leverage: 21` |
>
> Normalize on read: `const mode = String(cfg.marginType).toUpperCase()` — then compare against `ISOLATED`/`CROSSED` and only send the uppercase form when writing.

Use `accountConfig.updateTime` only as documentation — like the v2 account's `updateTime` it is annotated **"reserved property, please ignore"**. Detect changes through the user data stream's `ACCOUNT_CONFIG_UPDATE` event instead.

### 3.10 `GET /fapi/v1/leverageBracket` — Notional and Leverage Brackets

`USER_DATA`, weight **1**. Param `symbol` optional (omit ⇒ array for all symbols; provide ⇒ single object).

```json
{
  "symbol": "ETHUSDT",
  "notionalCoef": 1.5,
  "brackets": [
    { "bracket": 1, "initialLeverage": 75, "notionalCap": 10000, "notionalFloor": 0, "maintMarginRatio": 0.0065, "cum": 0 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `bracket` | Bracket index |
| `initialLeverage` | **Max initial leverage allowed in this bracket** |
| `notionalCap` / `notionalFloor` | Notional range of the bracket |
| `maintMarginRatio` | Maintenance margin ratio for the bracket |
| `cum` | Auxiliary number used for quick maintenance-margin calculation |
| `notionalCoef` | User-specific bracket multiplier — **only present when your symbol bracket has been individually adjusted** |

Use this **before** calling `POST /fapi/v1/leverage` to pick a leverage whose `notionalCap` covers your intended position, and to compute maintenance margin locally for liquidation-distance checks.

### 3.11 Other account endpoints you may need

| Endpoint | Weight | Purpose |
| --- | --- | --- |
| `GET /fapi/v1/positionMargin/history` | 1 | Isolated-margin change history: `symbol` (req), `type` (`1` add / `2` reduce), `startTime`, `endTime`, `limit` (default 500). Only ≤ 30 days back; span ≤ 30 days. Response: `symbol`, `type`, `deltaType` (e.g. `USER_ADJUST`), `amount`, `asset`, `time`, `positionSide` |
| `POST /fapi/v1/positionMargin` | 1 | Add/reduce isolated margin: `symbol`, `amount`, `type` (`1`/`2`), `positionSide` (hedge only). Response `{"amount":100,"code":200,"msg":"Successfully modify position margin.","type":1}` |
| `GET /fapi/v1/rateLimit/order` | 1 | Your real account ORDERS limits (§7.1) |
| `GET /fapi/v1/accountConfig` | 5 | See §3.9 |
| `GET /fapi/v1/symbolConfig` | 5 | See §3.9 |
| `POST /fapi/v1/countdownCancelAll` | 10 | Dead-man switch: `symbol`, `countdownTime` (ms; `0` disables). Call as a heartbeat (e.g. every 30 s with `countdownTime=120000`); if you stop calling, **all open orders on that symbol are auto-cancelled**. Response `{"symbol":"BTCUSDT","countdownTime":"100000"}` — note `countdownTime` comes back as a **string** |
| `GET /fapi/v1/feeBurn` / `POST /fapi/v1/feeBurn` | 1 | Read/toggle BNB fee discount. `POST` body: `feeBurn` = `"true"`/`"false"` |

---

## 4. Leverage / Margin / Position-Mode Configuration

### 4.1 `POST /fapi/v1/leverage` — Change Initial Leverage

**Security:** `TRADE` (signed). **Weight:** **1**.

| Param | Type | Required |
| --- | --- | --- |
| `symbol` | STRING | YES |
| `leverage` | INT | YES |
| `timestamp` | LONG | YES |
| `recvWindow` | LONG | NO |

Response:

```json
{ "leverage": 21, "maxNotionalValue": "1000000", "symbol": "BTCUSDT" }
```

Notes:
- Leverage is **per symbol** and is the *initial* leverage. `maxNotionalValue` returned is the bracket cap for the new leverage.
- Valid leverage values are **bracket-dependent** — read the bracket table from **`GET /fapi/v1/leverageBracket`** before choosing (see §3.10). `leverage` is documented as min **1**, max **125**. Invalid values give `-4028 INVALID_LEVERAGE` ("Leverage `%s` is not valid" or "Leverage `%s` already exist with `%s`").
- ❌ **`GET /fapi/v1/notionalBrackets` does not exist for USDⓈ-M Futures.** The brackets endpoint is **`GET /fapi/v1/leverageBracket`** (documented as "Notional and Leverage Brackets"). If you copied `notionalBrackets` from another Binance product, fix it — you will get a 404/`-1121`-class route error, not a helpful message.
- **Changing leverage while a position or open order exists:** in **cross** margin, leverage changes are generally permitted and simply re-scale required margin (the server may reject if the new leverage implies insufficient margin: `-2027 MAX_LEVERAGE_RATIO` "Exceeded the maximum allowable position at current leverage.", `-2028 MIN_LEVERAGE_RATIO` "Leverage is smaller than permitted: insufficient margin balance.").
  In **isolated** margin, **reducing** leverage while a position is open is explicitly rejected: **`-4161 ISOLATED_LEVERAGE_REJECT_WITH_POSITION`** — "Leverage reduction is not supported in Isolated Margin Mode with open positions."
  There is **no dedicated "open order exists" error** for leverage; the practical failure modes are `-4161` (isolated + position), `-4028` (invalid/unchanged value), and `-2027`/`-2028` (margin).
- Practical bot rule: **set leverage before entering**, and treat `-4161` as "flat first, then change leverage."
- Additional account-level gates: `-4202 ADJUST_LEVERAGE_KYC_FAILED` ("Intermediate Personal Verification is required for adjusting leverage over 20x"), `-4203` (one month after registration), `-4205`, `-4206` (country limits), `-4208`.

### 4.2 `POST /fapi/v1/marginType` — Change Margin Type

**Security:** `TRADE` (signed). **Weight:** **1**.

| Param | Type | Required | Values |
| --- | --- | --- | --- |
| `symbol` | STRING | YES | |
| `marginType` | ENUM | YES | **`ISOLATED`**, **`CROSSED`** |
| `timestamp` | LONG | YES | |
| `recvWindow` | LONG | NO | |

> **Naming asymmetry:** you **write** `ISOLATED`/`CROSSED`, but `positionRisk` **reads back** lowercase **`isolated`/`cross`**. Do not compare them directly.

Response: `{"code": 200, "msg": "success"}`.

**Errors for margin type:**

| Code | Msg | Meaning |
| --- | --- | --- |
| `-4046` | `No need to change margin type.` | Already in that mode. **Treat as success.** |
| `-4047` | `Margin type cannot be changed if there exists open orders.` | Cancel open orders first |
| `-4048` | `Margin type cannot be changed if there exists position.` | Close the position first |
| `-4167` | `Unable to adjust to Multi-Assets mode with symbols of USDⓈ-M Futures under isolated-margin mode.` | |
| `-4168` | `Unable to adjust to isolated-margin mode under the Multi-Assets mode.` | Multi-assets + isolated are mutually exclusive |
| `-4169` | `Unable to adjust Multi-Assets Mode with insufficient margin balance in USDⓈ-M Futures.` | |
| `-4170` | `Unable to adjust Multi-Assets Mode with open orders in USDⓈ-M Futures.` | |
| `-4171` | `Adjusted asset mode is currently set and does not need to be adjusted repeatedly.` | Treat as success |
| `-4172` | `Unable to adjust Multi-Assets Mode with a negative wallet balance of margin available asset…` | |

### 4.3 How leverage and isolated/cross margin interact

- **Cross margin:** one shared margin pool (the USDT wallet) backs *all* cross positions. Margin is not reserved per position. Available margin = `availableBalance` from `/fapi/v2/account`. Leverage is per-symbol and only scales the *initial-margin requirement*; liquidation depends on the whole account's margin ratio.
- **Isolated margin:** each position gets its own margin bucket, `isolatedWallet` in `positionRisk`. A loss is capped at that bucket. `POST /fapi/v1/positionMargin` (`symbol`, `amount`, `type` = `1` add / `2` reduce, optional `positionSide` in hedge mode) tops it up; `GET /fapi/v1/positionMargin/history` reads history (`type` `1`/`2`, `deltaType`, `amount`, `asset`, `time`, `positionSide`; ≤ 30 days back).
- **Isolated only:** `-4049 ADD_ISOLATED_MARGIN_REJECT` ("Add margin only support for isolated position."), `-4053 AUTO_ADD_CROSSED_MARGIN_REJECT` ("Auto add margin only support for isolated position."), `-4054 ADD_ISOLATED_MARGIN_NO_POSITION_REJECT` ("Cannot add position margin: position is 0."), `-4052 NO_NEED_TO_CHANGE_AUTO_ADD_MARGIN`.
- **Interaction table:**

| | Cross | Isolated |
| --- | --- | --- |
| Margin shared across symbols | Yes | No |
| `isolatedWallet` meaningful | No (`"0"`) | Yes |
| Can change marginType with position open | No (`-4048`) | No (`-4048`) |
| Can reduce leverage with position open | Yes (margin permitting) | **No** (`-4161`) |
| Can modify margin via `/fapi/v1/positionMargin` | No (`-4049`) | Yes |
| Composable with Multi-Assets mode | Yes | **No** (`-4168`) |

- **Multi-Assets mode:** `POST /fapi/v1/multiAssetsMargin` with `multiAssetsMargin` = `"true"`/`"false"`; read via `GET /fapi/v1/multiAssetsMargin`. In Multi-Assets mode, non-USDT assets count as collateral. Response `{"code":200,"msg":"success"}`. It cannot be combined with isolated margin (`-4168`) and cannot be changed with open orders (`-4170`) or a negative available-asset wallet balance (`-4172`).

### 4.4 Recommended configuration sequence

```
1. GET  /fapi/v1/positionSide/dual          -> confirm one-way vs hedge
2. GET  /fapi/v1/multiAssetsMargin          -> confirm asset mode
3. GET  /fapi/v1/symbolConfig               -> current per-symbol leverage/marginType
4. if change needed:
     POST /fapi/v1/marginType  (tolerate -4046/-4171 as success)
     POST /fapi/v1/leverage    (expect -4161 in isolated+position)
5. GET  /fapi/v1/leverageBracket            -> validate leverage against notionalCap
6. only then place orders
```

**Everything in this section is a signed `TRADE` endpoint; changing position mode or margin type requires the symbol to be flat and order-free.**

---

## 5. Order Placement

### 5.1 `POST /fapi/v1/order` — New Order

**Security:** `TRADE` (signed).
**Weight:** `1 on 10s order rate limit (X-MBX-ORDER-COUNT-10S); 1 on 1min order rate limit (X-MBX-ORDER-COUNT-1M); 0 on IP rate limit (x-mbx-used-weight-1m)`.

**Request parameters** (current generated schema):

| Name | Type | Mandatory | Notes |
| --- | --- | --- | --- |
| `symbol` | STRING | YES | |
| `side` | ENUM | YES | `BUY`, `SELL` |
| `type` | ENUM | YES | `LIMIT`, `MARKET`, `STOP`, `STOP_MARKET`, `TAKE_PROFIT`, `TAKE_PROFIT_MARKET`, `TRAILING_STOP_MARKET` — **but the 5 conditional types now return `-4120` on this endpoint** |
| `timestamp` | LONG | YES | ms |
| `positionSide` | ENUM | NO* | Default `BOTH` (one-way). **Mandatory in Hedge Mode:** `LONG` or `SHORT` |
| `timeInForce` | ENUM | NO | `GTC`, `IOC`, `FOK`, `GTX`, `GTD`, `RPI` |
| `reduceOnly` | STRING | NO | `"true"`/`"false"`, default `"false"`. **Cannot be sent in Hedge Mode** |
| `quantity` | DECIMAL | NO | |
| `price` | DECIMAL | NO | |
| `newClientOrderId` | STRING | NO | Unique among open orders; regex `^[\.A-Z\:/a-z0-9_-]{1,36}$`; auto-generated if omitted |
| `newOrderRespType` | ENUM | NO | `ACK` (default), `RESULT` |
| `priceMatch` | ENUM | NO | `LIMIT`/`STOP`/`TAKE_PROFIT` only; **cannot be combined with `price`** |
| `selfTradePreventionMode` | ENUM | NO | `EXPIRE_TAKER`, `EXPIRE_BOTH`, `EXPIRE_MAKER`; default `EXPIRE_MAKER`; only effective for `IOC`/`GTC`/`GTD` |
| `goodTillDate` | LONG | NO | Required when `timeInForce=GTD`; second-level precision only; must be `> now + 600s` and `< 253402300799000` |
| `recvWindow` | LONG | NO | |

**Additional mandatory parameters by `type`:**

| Type | Additional mandatory |
| --- | --- |
| `LIMIT` | `timeInForce`, `quantity`, `price` |
| `MARKET` | `quantity` |

> **`quoteOrderQty` is NOT supported on USDⓈ-M Futures.** It does not appear anywhere in the current USDⓈ-M order schemas (including the complete Trade section, which contains all order endpoints), and the docs state `MARKET` requires `quantity`. `quoteOrderQty` is a **Spot**-market-order parameter. To size a futures MARKET order by notional, fetch the mark price and compute `quantity = notional / price`, then round to `stepSize` (§6).
>
> **`closePosition`, `stopPrice`, `workingType`, `priceProtect`, `activationPrice`, `callbackRate` are no longer request parameters of this endpoint.** They moved to the Algo Order API (§5.4) as `closePosition`, `triggerPrice`, `workingType`, `priceProtect`, `activatePrice`, `callbackRate`. The response schema of `/fapi/v1/order` still *contains* `stopPrice`, `closePosition`, `workingType`, `priceProtect` because those describe the resulting order object.

**Parameters with special mutual-exclusion rules:**

- `priceMatch` + `price` ⇒ error (they are mutually exclusive).
- `selfTradePreventionMode` effective only for `IOC`/`GTC`/`GTD`.
- `goodTillDate` required iff `timeInForce=GTD`.
- `reduceOnly` + Hedge Mode ⇒ error (`-4062` / `-1106`-family).
- As of **2025-10-23**, `priceMatch` enum values **`OPPONENT_10`** and **`OPPONENT_20`** are temporarily removed from place/amend flows (other enums unaffected).

**Response** (`newOrderRespType=ACK`, the default):

```json
{
  "clientOrderId": "testOrder",
  "cumQty": "0",
  "executedQty": "0",
  "orderId": 22542179,
  "origQty": "10",
  "price": "0",
  "reduceOnly": false,
  "side": "SELL",
  "positionSide": "SHORT",
  "status": "NEW",
  "stopPrice": "0",
  "closePosition": false,
  "symbol": "BTCUSDT",
  "timeInForce": "GTD",
  "type": "LIMIT",
  "origType": "LIMIT",
  "updateTime": 1566818724722,
  "workingType": "CONTRACT_PRICE",
  "priceProtect": false,
  "priceMatch": "NONE",
  "selfTradePreventionMode": "NONE",
  "goodTillDate": 1693207680000
}
```

`newOrderRespType=RESULT` returns the final state: for `MARKET`, the final `FILLED` result; for `LIMIT` with special `timeInForce`, `FILLED` or `EXPIRED`.

**Order status enum:** `NEW`, `PARTIALLY_FILLED`, `FILLED`, `CANCELED`, `REJECTED`, `EXPIRED`, `EXPIRED_IN_MATCH`.

> Important: `ACK` means the order was **accepted**, not filled. For MARKET orders a bot must either use `newOrderRespType=RESULT` or read `avgPrice`/`executedQty` from `GET /fapi/v1/order` / the user data stream.

### 5.2 `POST /fapi/v1/batchOrders` — Place Multiple Orders

**Security:** `TRADE`. **Weight:** `5 on 10s order rate limit (X-MBX-ORDER-COUNT-10S); 1 on 1min order rate limit (X-MBX-ORDER-COUNT-1M); 5 on IP rate limit (x-mbx-used-weight-1m)`.

| Param | Notes |
| --- | --- |
| `batchOrders` | **Max 5 orders.** Type is `LIST<JSON>`, but over **REST** it is transmitted as a **URL-encoded JSON array string**. |
| `timestamp` | required |
| `recvWindow` | optional |

**Exact REST serialization (get this wrong and you get `-1102`/`-1013`):**

```
POST /fapi/v1/batchOrders
batchOrders=%5B%7B%22type%22%3A%22LIMIT%22%2C%22timeInForce%22%3A%22GTC%22%2C%22symbol%22%3A%22BTCUSDT%22%2C%22side%22%3A%22BUY%22%2C%22price%22%3A%2210001%22%2C%22quantity%22%3A%220.001%22%7D%5D&timestamp=...
```

which decodes to:

```
batchOrders=[{"type":"LIMIT","timeInForce":"GTC","symbol":"BTCUSDT","side":"BUY","price":"10001","quantity":"0.001"}]
```

Rules:

- Build the array with `JSON.stringify(orders)` — a **single** stringify. Do **not** pre-stringify individual orders and then embed them (nested/escaped JSON strings are rejected).
- Do **not** use `\x22`-style escaping. Percent-encode the JSON string normally (`%5B` = `[`, `%7B` = `{`, `%22` = `"`).
- **Sign the exact percent-encoded string you send** (§2.5) — because `batchOrders` is a parameter value, its encoding is part of the signed payload.
- The WebSocket API (`order.place`-family / batch method) takes a **real JSON array**, not a string — do not share the serialization code path between REST and WS.

Per-order fields: `symbol`, `side`, `positionSide`, `type`, `timeInForce`, `quantity`, `price`, `reduceOnly`, `newClientOrderId`, `newOrderRespType`, `priceMatch`, `selfTradePreventionMode`, `goodTillDate`. **Note:** `selfTradePreventionMode` defaults to **`NONE`** in the batch context, whereas a single `POST /fapi/v1/order` defaults to **`EXPIRE_MAKER`** — a subtle behavioral divergence if you omit it.

Documented behavior:

- Batch orders are processed **concurrently**; matching order is **not guaranteed**.
- "The order of returned contents for batch orders is the same as the order of the batchOrders list."
- The response is an **array**; individual entries may be an order object **or** an error object (`{"code": -2019, "msg": "Margin is insufficient."}`). **You must inspect every element** — the HTTP status can be 200 while individual orders failed.
- `-4082 INVALID_BATCH_PLACE_ORDER_SIZE` ("Invalid number of batch place orders: %s") if >5; `-4083 PLACE_BATCH_ORDERS_FAIL` ("Fail to place batch orders.").

> **Because conditional types are blocked here (`-4120`), you can no longer place entry + SL + TP in a single batch.** Enter with `/fapi/v1/order` (or a batch of `LIMIT`/`MARKET`), then place stops via `/fapi/v1/algoOrder` calls.

### 5.3 `POST /fapi/v1/order/test` — Test Order

"Testing order request, this order will **not** be submitted to matching engine." Same parameters as `POST /fapi/v1/order`. Returns `{}` on success. **Use this to validate your rounding logic in CI / staging** — it exercises the real `PRICE_FILTER` / `LOT_SIZE` / `MARKET_LOT_SIZE` / `MIN_NOTIONAL` checks and returns the same filter error codes (`-1111`, `-4014`, `-4023`, `-4164`, …) without risking a fill.

Notes and caveats:

- **Weight** is not printed on the current page; the change log groups it with `POST /fapi/v1/order` for the `-1008` system-throttling exemption. Assume **0 IP weight / 1 order-count**, i.e. it consumes order-rate-limit budget. Low confidence — verify.
- **This endpoint still documents the LEGACY conditional parameter set** — `stopPrice`, `closePosition`, `activationPrice`, `callbackRate`, `workingType`, `priceProtect` — because it was never migrated to the Algo service. **`closePosition` and `stopPrice` on `/test` are documented as `STOP_MARKET`/`TAKE_PROFIT_MARKET` concepts.** Whether the live `/test` route actually accepts conditional types after the 2025-12-09 migration is **unverified** — if you use it for stop validation, expect the possibility of `-4120` here too and handle it.
- Its documented mandatory-by-type table (legacy) is: `LIMIT` → `timeInForce`+`quantity`+`price`; `MARKET` → `quantity`; `STOP`/`TAKE_PROFIT` → `quantity`+`price`+`stopPrice`; `STOP_MARKET`/`TAKE_PROFIT_MARKET` → `stopPrice`; `TRAILING_STOP_MARKET` → `callbackRate`.
- Because a `/test` call costs order-rate-limit budget and is only a *parameter* validator, **do not call it before every live order** in production — validate locally against cached filters (§6.2) and reserve `/test` for CI and for diagnosing a live rejection.

### 5.4 `POST /fapi/v1/algoOrder` — New Algo Order **(the current path for all conditional orders)**

**Security:** `TRADE` (signed).
**Weight:** `1` on 10s order rate limit (`X-MBX-ORDER-COUNT-10S`), `1` on 1min order rate limit (`X-MBX-ORDER-COUNT-1M`), **`0`** on IP rate limit ([Change Log 2026-06-20](https://developers.binance.com/docs/derivatives/change-log#2026-06-20)).

**Request parameters:**

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `algoType` | ENUM | **YES** | **`CONDITIONAL`** |
| `symbol` | STRING | YES | |
| `side` | ENUM | YES | `BUY`, `SELL` |
| `type` | ENUM | YES | `STOP_MARKET`, `TAKE_PROFIT_MARKET`, `STOP`, `TAKE_PROFIT`, `TRAILING_STOP_MARKET` |
| `timestamp` | LONG | YES | ms |
| `positionSide` | STRING | NO* | `BOTH` (one-way default) / `LONG` / `SHORT`; mandatory in Hedge Mode |
| `timeInForce` | ENUM | NO | For `type=STOP` or `TAKE_PROFIT`, may be sent; **default `GTC`** |
| `quantity` | FLOAT | NO | **Cannot be sent with `closePosition=true`** |
| `price` | FLOAT | NO | Limit price for `STOP`/`TAKE_PROFIT` |
| **`triggerPrice`** | FLOAT | NO | **The trigger price. This replaces `stopPrice`.** |
| `workingType` | ENUM | NO | **`MARK_PRICE`**, **`CONTRACT_PRICE`**; default `CONTRACT_PRICE` |
| `priceMatch` | ENUM | NO | `LIMIT`/`STOP`/`TAKE_PROFIT` only; cannot be combined with `price` |
| **`closePosition`** | ENUM | NO | `"true"`/`"false"`. Close-All, used with `STOP_MARKET` or `TAKE_PROFIT_MARKET` |
| `priceProtect` | ENUM | NO | `"true"`/`"false"`, default `"false"`. Used with `STOP_MARKET`/`TAKE_PROFIT_MARKET` |
| `reduceOnly` | ENUM | NO | `"true"`/`"false"`, default `"false"`. Cannot be sent in Hedge Mode; cannot be sent with `closePosition=true` |
| `activatePrice` | FLOAT | NO | `TRAILING_STOP_MARKET` only. Defaults to the latest price (per `workingType`) |
| `callbackRate` | FLOAT | NO | `TRAILING_STOP_MARKET` only. **min 0.1, max 10** (percent) |
| `clientAlgoId` | STRING | NO | `^[\.A-Z\:/a-z0-9_-]{1,36}$`; auto-generated if omitted |
| `newOrderRespType` | ENUM | NO | `ACK` (default), `RESULT` |
| `selfTradePreventionMode` | ENUM | NO | `NONE` (default), `EXPIRE_TAKER`, `EXPIRE_BOTH`, `EXPIRE_MAKER` |
| `goodTillDate` | LONG | NO | For `GTD` |
| `recvWindow` | LONG | NO | |

**Response fields:** `algoId`, `clientAlgoId`, `algoType`, `orderType`, `symbol`, `side`, `positionSide`, `timeInForce`, `quantity`, `algoStatus`, `triggerPrice`, `price`, `icebergQuantity`, `tpTriggerPrice`, `tpPrice`, `slTriggerPrice`, `slPrice`, `tpOrderType`, `selfTradePreventionMode`, `workingType`, `priceMatch`, `closePosition`, `priceProtect`, `reduceOnly`, `activatePrice`, `callbackRate`, `actualOrderId`, `actualPrice`, `actualType`, `actualQty`, `createTime`, `updateTime`, `triggerTime`, `goodTillDate`.

> **Note the identity change:** an algo order has **`algoId` + `clientAlgoId`**, not `orderId` + `clientOrderId`. `algoStatus` is used instead of `status`. Once triggered it produces a real order whose id appears in `actualOrderId`. Your data model must track both key spaces and store the mapping `algoId -> (symbol, purpose)` yourself.

**Conditional trigger semantics** (identical rules to the old `stopPrice` model):

- `STOP` / `STOP_MARKET`:
  - `BUY`: trigger when latest price (`workingType`) **>= `triggerPrice`**
  - `SELL`: trigger when latest price **<= `triggerPrice`**
- `TAKE_PROFIT` / `TAKE_PROFIT_MARKET`:
  - `BUY`: trigger when latest price **<= `triggerPrice`**
  - `SELL`: trigger when latest price **>= `triggerPrice`**
- `TRAILING_STOP_MARKET`:
  - `SELL`: highest price after placement **>= `activatePrice`**, then trail by `callbackRate`
  - `BUY`: lowest price after placement, trail by `callbackRate`
- `priceProtect=true`: at trigger time, the difference rate between `MARK_PRICE` and `CONTRACT_PRICE` must not exceed the symbol's `triggerProtect` (from `exchangeInfo`) — otherwise the trigger is rejected. This protects against wick/one-sided-price triggers.
- `-2021 ORDER_WOULD_IMMEDIATELY_TRIGGER` ("Order would immediately trigger.") means the trigger price is already on the wrong side of the market. For `TRAILING_STOP_MARKET` specifically: `BUY` requires `activatePrice` **<** latest price; `SELL` requires `activatePrice` **>** latest price.
- `-4142 STRATEGY_INVALID_TRIGGER_PRICE` — "REJECT: take profit or stop order will be triggered immediately."
- `-4135 INVALID_ACTIVATION_PRICE` — "Invalid activation price".

**Related algo endpoints:**

| Endpoint | Purpose | Notes |
| --- | --- | --- |
| `DELETE /fapi/v1/algoOrder` | Cancel one algo order | `algoId` **or** `clientAlgoId` (one required); weight 1. Response `{"algoId":...,"clientAlgoId":"...","code":"200","msg":"success"}` — **`code` comes back as a STRING here**, unlike every other endpoint where it is a number. Do not `=== 200`. |
| `DELETE /fapi/v1/algoOpenOrders` | Cancel all open algo orders for a symbol | `symbol` required; returns `{"code":200,"msg":"The operation of cancel all open order is done."}` |
| `GET /fapi/v1/algoOrder` | Query one algo order | `algoId` or `clientAlgoId`; weight 1 |
| `GET /fapi/v1/openAlgoOrders` | Open algo orders | weight **1 with `symbol`, 40 without**; params `algoType`, `symbol`, `algoId` |
| `GET /fapi/v1/allAlgoOrders` | Algo order history | weight 5; also not-found rules: CANCELED/EXPIRED + no fill + >3 days, or created >90 days ago |

`algoId` is **self-incrementing per symbol** (documented on the Query Algo Order page) — do not assume global uniqueness.

### 5.5 Order-type / parameter applicability matrix

| Order type | Endpoint | `quantity` | `price` | `triggerPrice` | `timeInForce` | `workingType` | `priceProtect` | `reduceOnly` | `closePosition` | `activatePrice` / `callbackRate` | `priceMatch` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MARKET` | `/fapi/v1/order` | **required** | — | — | — | — | — | optional | — | — | — |
| `LIMIT` | `/fapi/v1/order` | **required** | **required** | — | **required** | — | — | optional | — | — | optional |
| `STOP_MARKET` | **`/fapi/v1/algoOrder`** | optional (required unless `closePosition=true`) | — | **required** | — | optional | optional | optional | optional | — | — |
| `TAKE_PROFIT_MARKET` | **`/fapi/v1/algoOrder`** | optional (required unless `closePosition=true`) | — | **required** | — | optional | optional | optional | optional | — | — |
| `STOP` | **`/fapi/v1/algoOrder`** | required | required | **required** | optional (default `GTC`) | optional | optional | optional | — | — | optional |
| `TAKE_PROFIT` | **`/fapi/v1/algoOrder`** | required | required | **required** | optional (default `GTC`) | optional | optional | optional | — | — | optional |
| `TRAILING_STOP_MARKET` | **`/fapi/v1/algoOrder`** | required | — | — | — | optional | — | optional | — | **required** | — |

Enum values you must hardcode:

- `side`: `BUY` | `SELL`
- `positionSide`: `BOTH` | `LONG` | `SHORT`
- `timeInForce`: `GTC` | `IOC` | `FOK` | `GTX` | `GTD` | `RPI`
- `workingType`: **`MARK_PRICE`** | **`CONTRACT_PRICE`** (note: `MARK_PRICE`, **not** `MARK` — the value is literally `MARK_PRICE`)
- `newOrderRespType`: `ACK` | `RESULT`
- `selfTradePreventionMode`: `NONE` | `EXPIRE_TAKER` | `EXPIRE_BOTH` | `EXPIRE_MAKER`
- `priceMatch`: `NONE` | `OPPONENT` | `OPPONENT_5` | (`OPPONENT_10`/`OPPONENT_20` temporarily removed 2025-10-23) | `QUEUE` | `QUEUE_5` | `QUEUE_10` | `QUEUE_20`

### 5.6 `closePosition=true` vs `reduceOnly=true` — the exact rules

Documented rules for `closePosition=true` (from the New Algo Order page):

- Only valid with **`STOP_MARKET`** or **`TAKE_PROFIT_MARKET`**.
- **"Cannot be used with `quantity` parameter"** ⇒ error `-4137 QUANTITY_EXISTS_WITH_CLOSE_POSITION` — "Quantity must be zero with closePosition equals true".
- **"Cannot be used with `reduceOnly` parameter"** ⇒ error `-4138 REDUCE_ONLY_MUST_BE_TRUE` — "Reduce only must be true with closePosition equals true". (The message text is confusing/self-contradictory in the docs; the parameter description is authoritative: **do not send `reduceOnly` together with `closePosition`**.)
- **In Hedge Mode, cannot be used with `BUY` orders in `LONG` position side, and cannot be used with `SELL` orders in `SHORT` position side** (those are position-*increasing* directions).
- "If triggered, close all current long position (if `SELL`) or current short position (if `BUY`)."

| | `closePosition=true` | `reduceOnly=true` |
| --- | --- | --- |
| Valid order types | `STOP_MARKET`, `TAKE_PROFIT_MARKET` only | Any type (subject to `-2026`) |
| Quantity | **Must not be sent** | **Must be sent** (you specify how much to reduce) |
| Sends full position | **Yes — auto closes 100% of the position at trigger time** | No — only the specified `quantity` |
| Adjusts to position changes | **Yes.** If you add to the position after placing the stop, `closePosition=true` still closes the whole thing | **No.** A `reduceOnly` stop with the old quantity under-protects after a position increase |
| Works in Hedge Mode | Yes, but not for `LONG`+`BUY` / `SHORT`+`SELL` | **No — "Cannot be sent in Hedge Mode"** |
| Survives partial closes | Yes | Not exactly — `reduceOnly` clamps to the remaining position |
| Error codes | `-4137`, `-4138` | `-2022`, `-2026`, `-4118` |

**Why `closePosition=true` cannot be combined with `quantity` or `reduceOnly`:** the semantics are "close **all** of the position." A `quantity` would contradict "all" (which quantity — and what if the position changed?); `reduceOnly` would be redundant and ambiguous. So the API models it as an exclusive mode, and the server rejects the combination rather than silently ignoring one.

**Which should a bot use?**

- **`closePosition=true` is the correct choice for "always protect the whole position"** and is strongly recommended for a bot that may scale into a position. It is self-adjusting, so you never under-protect after adding size.
- **`reduceOnly=true` with an explicit `quantity`** is for **partial** exits: scaling out, taking 50% off, laddered TPs.
- In **Hedge Mode**, `closePosition=true` is usually the *only* workable option for a full stop, because `reduceOnly` is forbidden in hedge mode entirely.
- Risk of `closePosition=true`: it closes **the entire position on that `positionSide`**, so if you deliberately run multiple independent "strategies" on the same symbol and side, a single `closePosition` stop will flatten all of them. In that case, prefer explicit `reduceOnly` quantities — but only in **one-way** mode, or model each strategy on its own `positionSide` in hedge mode.

### 5.7 Complete, correct example requests

**Assumptions:** one-way mode, symbol `BTCUSDT`, entry at ~60000, quantity `0.01`, 10x leverage, `workingType=CONTRACT_PRICE`, `recvWindow=5000`, all values already rounded to `tickSize`/`stepSize` (§6).

#### (a) Market open LONG

`POST /fapi/v1/order`

```http
POST /fapi/v1/order HTTP/1.1
Host: fapi.binance.com
X-MBX-APIKEY: <API_KEY>
Content-Type: application/x-www-form-urlencoded

symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.01&newClientOrderId=entry-1a2b3c&newOrderRespType=RESULT&recvWindow=5000&timestamp=1770736694138&signature=<HMAC_SHA256_HEX>
```

Signed payload (exactly this string, no `signature`):

```
symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.01&newClientOrderId=entry-1a2b3c&newOrderRespType=RESULT&recvWindow=5000&timestamp=1770736694138
```

- No `positionSide` (one-way mode).
- No `reduceOnly` (position-increasing).
- `newOrderRespType=RESULT` so you get the fill (`avgPrice`, `executedQty`) immediately rather than just an ACK.
- Read back the actual position with `GET /fapi/v3/positionRisk?symbol=BTCUSDT` (or `ACCOUNT_UPDATE` on the user data stream) to learn `positionAmt` and `entryPrice` before placing stops.

#### (b) STOP_MARKET close-all stop loss

**Current, correct request — `POST /fapi/v1/algoOrder`:**

```http
POST /fapi/v1/algoOrder HTTP/1.1
Host: fapi.binance.com
X-MBX-APIKEY: <API_KEY>
Content-Type: application/x-www-form-urlencoded

algoType=CONDITIONAL&symbol=BTCUSDT&side=SELL&type=STOP_MARKET&triggerPrice=59000&closePosition=true&workingType=CONTRACT_PRICE&priceProtect=true&clientAlgoId=sl-1a2b3c&recvWindow=5000&timestamp=1770736694138&signature=<HMAC_SHA256_HEX>
```

- `side=SELL` closes a **long** (`BUY` would close a short). "If triggered, close all current long position (if SELL) or current short position (if BUY)."
- `closePosition=true` ⇒ **no `quantity`, no `reduceOnly`.**
- `triggerPrice=59000` must be **below** the current price for a long stop; otherwise `-2021`.
- `priceProtect=true` guards against an outlier mark/contract price spread at trigger time.
- Response is an algo order: `{"algoId": 2146760, "clientAlgoId": "sl-1a2b3c", "algoType": "CONDITIONAL", "orderType": "STOP_MARKET", "algoStatus": "NEW", "triggerPrice": "59000", "closePosition": true, ...}` — **store `algoId`**.

> **Legacy form (NO LONGER WORKS — returns `-4120`):**
> ```
> symbol=BTCUSDT&side=SELL&type=STOP_MARKET&stopPrice=59000&closePosition=true&workingType=CONTRACT_PRICE&priceProtect=true&timestamp=...&signature=...
> ```
> `POST /fapi/v1/order` ⇒ `{"code":-4120,"msg":"Order type not supported for this endpoint. Please use the Algo Order API endpoints instead."}`

#### (c) TAKE_PROFIT_MARKET close-all take profit

**Current, correct request — `POST /fapi/v1/algoOrder`:**

```http
POST /fapi/v1/algoOrder HTTP/1.1
Host: fapi.binance.com
X-MBX-APIKEY: <API_KEY>
Content-Type: application/x-www-form-urlencoded

algoType=CONDITIONAL&symbol=BTCUSDT&side=SELL&type=TAKE_PROFIT_MARKET&triggerPrice=63000&closePosition=true&workingType=CONTRACT_PRICE&clientAlgoId=tp-1a2b3c&recvWindow=5000&timestamp=1770736694138&signature=<HMAC_SHA256_HEX>
```

- For a long TP, `side=SELL` and the market must **rise to** `triggerPrice` (`TAKE_PROFIT_MARKET` + `SELL` triggers when latest price **>=** `triggerPrice`).
- `closePosition=true` again forbids `quantity`/`reduceOnly`.
- `priceProtect` is optional for TP; leave it off (or on, if you want the same guard).

#### (d) Optional: partial take-profit with `reduceOnly` (one-way mode only)

```http
POST /fapi/v1/algoOrder
algoType=CONDITIONAL&symbol=BTCUSDT&side=SELL&type=TAKE_PROFIT_MARKET&triggerPrice=63000&quantity=0.005&reduceOnly=true&workingType=CONTRACT_PRICE&clientAlgoId=tp-partial-1&recvWindow=5000&timestamp=...&signature=...
```

Note `quantity` + `reduceOnly` **instead of** `closePosition`.

#### (e) Optional: trailing stop

```http
POST /fapi/v1/algoOrder
algoType=CONDITIONAL&symbol=BTCUSDT&side=SELL&type=TRAILING_STOP_MARKET&quantity=0.01&activatePrice=61000&callbackRate=1.0&workingType=CONTRACT_PRICE&clientAlgoId=trail-1&recvWindow=5000&timestamp=...&signature=...
```

`callbackRate` is a percentage with **min 0.1, max 10**. For `SELL`, `activatePrice` must be **above** the latest price (`-2021` otherwise).

#### Correct sequencing for "market entry, then exchange-side SL + TP" (one-way mode)

```
1. GET  /fapi/v3/positionRisk?symbol=BTCUSDT      (confirm flat, get leverage/marginType if needed)
2. POST /fapi/v1/leverage      {symbol, leverage}          (before entering)
3. POST /fapi/v1/order         {MARKET, quantity, newOrderRespType=RESULT}
4. GET  /fapi/v3/positionRisk?symbol=BTCUSDT      (read positionAmt, entryPrice)   -- do NOT assume the fill size
5. POST /fapi/v1/algoOrder     {STOP_MARKET, triggerPrice, closePosition=true}     -> store algoId
6. POST /fapi/v1/algoOrder     {TAKE_PROFIT_MARKET, triggerPrice, closePosition=true} -> store algoId
7. verify: GET /fapi/v1/openAlgoOrders?symbol=BTCUSDT  -> both algoIds present, algoStatus=NEW
```

**Ordering matters:** place the **stop loss first**, then the take profit. If the TP placement fails you still hold protected risk; if you place the TP first and the SL then fails, you are unprotected.

**Failure handling:** if step 5 or 6 errors, immediately **flatten the position** (`POST /fapi/v1/order` `side=SELL&type=MARKET&quantity=<positionAmt>&reduceOnly=true` in one-way mode) rather than leaving a naked position. Also note `-4120` must never be silently swallowed.

---

## 6. Symbol / Filter Metadata and Market Data

### 6.1 `GET /fapi/v1/exchangeInfo` — Exchange Information

**Security:** `NONE`. **Weight:** **1** (futures — this is much cheaper than Spot's 20).

Top level: `exchangeFilters`, `rateLimits`, **`serverTime`**, `assets`, `symbols`, `timezone`.

> **`serverTime` gotcha:** the response includes a top-level `serverTime`, but Binance annotates it inline: *"Ignore please. If you want to check current server time, please check via `GET /fapi/v1/time`."* **Do not** use `exchangeInfo.serverTime` for clock sync — use `GET /fapi/v1/time` (§2.8).

Example `rateLimits` entries (from [Common Definition](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/common-definition)):

```json
{ "rateLimitType": "REQUEST_WEIGHT", "interval": "MINUTE", "intervalNum": 1, "limit": 2400 }
{ "rateLimitType": "ORDERS",         "interval": "MINUTE", "intervalNum": 1, "limit": 1200 }
```

Per-`symbols[]` object, the fields a bot needs:

| Field | Meaning |
| --- | --- |
| `symbol` | e.g. `BTCUSDT` (tradable identifier — use this) |
| `pair` | Underlying pair, e.g. `BTCUSDT` |
| `contractType` | `PERPETUAL`, `CURRENT_MONTH`, `NEXT_MONTH`, `CURRENT_QUARTER`, `NEXT_QUARTER`, `PERPETUAL_DELIVERING` |
| `status` | `TRADING`, `PENDING_TRADING`, `PRE_DELIVERING`, `DELIVERING`, `DELIVERED`, `PRE_SETTLE`, `SETTLING`, `CLOSE`, `TRADING_HALT`, `TRADING_CANCEL_ONLY` |
| `baseAsset` / `quoteAsset` | `BTC` / `USDT` |
| `marginAsset` | `USDT` |
| `deliveryDate` / `onboardDate` | ms |
| **`pricePrecision`** | **Maximum number of decimal places allowed for price** |
| **`quantityPrecision`** | **Maximum number of decimal places allowed for quantity** |
| `baseAssetPrecision` / `quotePrecision` | Asset-level precision |
| `maintMarginPercent` / `requiredMarginPercent` | Margin percentages |
| `triggerProtect` | The `priceProtect` threshold (as a fraction, e.g. `"0.0500"`), used when `priceProtect=true` |
| `liquidationFee` | Liquidation fee rate |
| `marketTakeBound` | Bound for market orders |
| `maxMoveOrderLimit` | Max modify count |
| `underlyingType` / `underlyingSubType` | e.g. `COIN`, `INDEX` |
| `settlePlan` | Settlement plan |
| `orderTypes[]` | Allowed order types for the symbol |
| `timeInForce[]` | Allowed TIF values |
| `filters[]` | See below |

> **`pricePrecision`/`quantityPrecision` GOTCHA — the docs say so themselves.** In the official `exchangeInfo` example the fields are annotated inline:
>
> ```jsonc
> "pricePrecision": 5,    // please do not use it as tickSize
> "quantityPrecision": 0, // please do not use it as stepSize
> ```
>
> They are **maximum decimal places**, nothing more. The authoritative rounding constraints are **`tickSize` (price/trigger price)** and **`stepSize` (quantity)** from the filters, which can be coarser or finer than the precision suggests. Rounding to the precision instead of to the step is a classic source of `-4014 PRICE_NOT_INCREASED_BY_TICK_SIZE` and `-4023 QTY_NOT_INCREASED_BY_STEP_SIZE`. **Always round to `tickSize`/`stepSize`; use the precision fields only as a sanity cap.**
>
> In the same example, `maintMarginPercent` and `requiredMarginPercent` are annotated **"ignore"** — do not build margin math on them.
>
> Also note `"multiplierDecimal": "4"` is returned as a **string** in the current example (older examples show the number `4`) — parse defensively.

Top-level `assets[]` entries (relevant to Multi-Assets mode):

| Field | Meaning |
| --- | --- |
| `asset` | e.g. `BTC`, `USDT`, `BNB` |
| `marginAvailable` | Whether the asset can be used as margin in Multi-Assets mode |
| `autoAssetExchange` | Auto-exchange threshold in Multi-Assets margin mode (may be `null`) |

Also note `marketTakeBound` — "the max price difference rate (from mark price) a market order can make" — and `triggerProtect`, the threshold applied when you send `priceProtect=true`.

**Filters** (exact `filterType` and fields), from [Common Definition](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/common-definition). A current `exchangeInfo` symbol carries these filter types — **note there are now SEVEN, not the six the `Common Definition` page documents**:

| `filterType` | Live? |
| --- | --- |
| `PRICE_FILTER`, `LOT_SIZE`, `MARKET_LOT_SIZE`, `MAX_NUM_ORDERS`, `MIN_NOTIONAL`, `PERCENT_PRICE` | Yes — per the official example |
| **`POSITION_RISK_CONTROL`** (`{"filterType":"POSITION_RISK_CONTROL","positionControlSide":"NONE"}`) | **Yes — present on every symbol in the live response, but NOT documented on the `Common Definition` page.** Codes against it: `-4105`/`-4106`/`-4107` |
| `MAX_NUM_ALGO_ORDERS` | **REMOVED** (2025-12-29). Do not parse it; the conditional-order cap is a flat 200 across all symbols |

```json
{ "filterType": "PRICE_FILTER", "minPrice": "0.00000100", "maxPrice": "100000.00000000", "tickSize": "0.00000100" }
{ "filterType": "LOT_SIZE",    "minQty": "0.00100000",  "maxQty": "100000.00000000", "stepSize": "0.00100000" }
{ "filterType": "MARKET_LOT_SIZE", "minQty": "0.00100000", "maxQty": "100000.00000000", "stepSize": "0.00100000" }
{ "filterType": "MAX_NUM_ORDERS",  "limit": 200 }
{ "filterType": "PERCENT_PRICE",   "multiplierUp": "1.1500", "multiplierDown": "0.8500", "multiplierDecimal": 4 }
{ "filterType": "MIN_NOTIONAL",    "notional": "5.0" }   // value is PER-SYMBOL — see below
{ "filterType": "POSITION_RISK_CONTROL", "positionControlSide": "NONE" }  // live, undocumented
```

Rules:

- **`PRICE_FILTER`** — for `price` *and* `stopPrice`/`triggerPrice`: `price >= minPrice`, `price <= maxPrice`, and **`(price - minPrice) % tickSize == 0`**. Any component may be `0` (disabled).
- **`LOT_SIZE`** — for `quantity` on non-market orders: `quantity >= minQty`, `quantity <= maxQty`, **`(quantity - minQty) % stepSize == 0`**.
- **`MARKET_LOT_SIZE`** — the same three rules but applied to `MARKET` orders specifically. **Fetch and apply this one for market entries** — it can be stricter than `LOT_SIZE`.
- **`MAX_NUM_ORDERS`** (`limit`, typically 200) — max simultaneously open orders per symbol. **Both "algo" orders and normal orders count toward this.**
- **`PERCENT_PRICE`** — `BUY`: `price <= markPrice * multiplierUp`; `SELL`: `price >= markPrice * multiplierDown`. Violations surface as `-4016`/`-4024`/`-4131`.
- **`MIN_NOTIONAL`** (`notional`) — `price * quantity >= notional`. For `MARKET` orders the **mark price** is used since there is no order price.
  > **⚠️ `notional` is PER-SYMBOL and is frequently NOT 5.** Live values observed: **`BTCUSDT` = `"50"`**, **`ETHUSDT` / `BCHUSDT` = `"20"`**, **`XRPUSDT` / `TRXUSDT` / `BNBUSDT` = `"5"`**. Never hardcode `5` — read it from `exchangeInfo` per symbol. This is the single most common cause of "my small test order is rejected" and of confusing `-2019`/`-4164` reports on BTCUSDT, where the real floor is 50 USDT.
- **`MAX_NUM_ALGO_ORDERS` was REMOVED** effective 2025-12-29. Do not depend on it; the conditional order limit is a flat **200 across all symbols**.

### 6.2 Correct rounding of quantity and price

**Never use naive `toFixed()`** — you must round *down to a multiple of the step*, and you must handle exponential notation.

`stepSize`/`tickSize` come back as **strings** and are frequently in exponential form for small values (e.g. `"1e-05"`, `"1E-8"`). `parseFloat("1e-05")` is fine, but naive decimal-string digit counting is not.

**Deriving the number of decimals from a step string:**

```
decimalsOf(stepStr):
  s = stepStr.trim()
  if s contains 'e' or 'E':
      // e.g. "1e-05" -> mantissa "1", exponent -5  -> 5 decimals
      [mant, exp] = s.split(/[eE]/)
      e = int(exp)
      mDec = (mant.split('.')[1] ?? '').length
      return max(0, mDec - e)          // NOTE: minus e, because e is negative
  else:
      return (s.split('.')[1] ?? '').length
```

Examples: `"0.00100000"` -> 6; `"1e-05"` -> 5; `"1E-8"` -> 8; `"10"` -> 0; `"0.5"` -> 1.

**Rounding down to a step (floor), robustly:**

```
floorToStep(value, stepStr):
  step = decimalsOf(stepStr)                  // integer number of decimals
  factor = 10 ** step
  // Work in scaled integers to avoid IEEE-754 drift:
  v = Math.round(value * factor)              // scale value into integer space
  s = Math.round(parseFloat(stepStr) * factor) // step in integer space, e.g. 1 or 5 or 10
  n = Math.floor(v / s) * s
  return (n / factor).toFixed(step)           // exact decimal string, no exponent
```

Two subtleties that matter in practice:

1. **`Math.round(value * factor)` first**, then floor-divide by the integer step. Doing `Math.floor(value / step) * step` directly with floats produces off-by-one-step errors (e.g. `0.3 / 0.1 = 2.9999999999999996` -> floors to `0.2`).
2. **Steps are not always `10^-k`.** `tickSize` can legitimately be `0.5`, `5`, `25`, `0.05`, etc. That is exactly why you must divide by the *integer step* rather than just truncating decimal places.

**Requirement checks** (mirror the server's own arithmetic):

```
priceOk(p)  = p >= minPrice && (maxPrice == 0 || p <= maxPrice) && isMultiple(p - minPrice, tickSize)
qtyOk(q)    = q >= minQty   && (maxQty == 0 || q <= maxQty)   && isMultiple(q - minQty,  stepSize)
notionalOk  = p * q >= minNotional           // p = markPrice for MARKET orders
```

Because floating-point `%` is unreliable for `(x - min) % step == 0`, compare in scaled integer space:

```
isMultiple(x, stepStr) = (scaled(x) - scaled(min)) % scaled(step) === 0
```

**Practical notes:**

- `BTCUSDT` currently has `tickSize = "0.10"` and `stepSize = "0.001"`; these change over time — **fetch from `exchangeInfo` at startup and cache with a TTL (e.g. 1 hour), and refresh on any filter error.**
- Round quantity **down** (you never want to exceed available margin or the requested risk). Round a stop *away* from the market (down for a long stop, up for a short stop) so it is a valid trigger and not immediately triggered.
- After rounding, if `quantity < minQty`, **do not send** — the order would fail with `-4004`/`-4164`. Surface a clear "size below exchange minimum" error to the strategy layer.
- **Re-check `MIN_NOTIONAL` against the mark price for MARKET orders** — many "insufficient margin" reports are actually `-4164`.

### 6.3 The filter/funds error codes

| Code | Exact msg | Meaning & handling |
| --- | --- | --- |
| **`-1111`** | `Precision is over the maximum defined for this asset.` (BAD_PRECISION) | You sent more decimal places than allowed. Round to `tickSize`/`stepSize`. Re-read `exchangeInfo` and retry. |
| **`-4014`** | `Price not increased by tick size.` (PRICE_NOT_INCREASED_BY_TICK_SIZE) | `price` (or trigger price) is not an exact multiple of `tickSize`. **Note: `-4014` is *not* "price less than zero" — that is `-4001 `Price less than 0.`** |
| **`-4023`** | `Qty not increased by step size.` (QTY_NOT_INCREASED_BY_STEP_SIZE) | `quantity` is not a multiple of `stepSize`. |
| **`-4001`** | `Price less than 0.` | Negative price. |
| **`-4002`** | `Price greater than max price.` | Exceeds `maxPrice`. |
| **`-4003`** | `Quantity less than zero.` | Negative quantity. |
| **`-4004`** | `Quantity less than min quantity.` | Below `minQty`. |
| **`-4005`** | `Quantity greater than max quantity.` | Above `maxQty`. |
| **`-4013`** | `Price less than min price.` | Below `minPrice`. |
| **`-4016`** | `Price is higher than mark price multiplier cap.` | `PERCENT_PRICE` violated on the upside. |
| **`-4024`** | `Price is lower than mark price multiplier floor.` | `PERCENT_PRICE` violated on the downside. |
| **`-4131`** | `The counterparty's best price does not meet the PERCENT_PRICE filter limit` (MARKET_ORDER_REJECT) | A MARKET order was rejected because the book is outside the band — retry/back off. |
| **`-4164`** | `Order's notional must be no smaller than 5.0 (unless you choose reduce only)` (MIN_NOTIONAL) | Notional below `MIN_NOTIONAL.notional`. **Note the parenthetical: reduce-only orders are exempt.** |
| **`-2019`** | `Margin is insufficient.` (MARGIN_NOT_SUFFICIEN — *sic*) | Insufficient available margin for the requested size at the current leverage. Recompute against `availableBalance` and `notional`, or reduce size. |
| **`-2018`** | `Balance is insufficient.` | Wallet balance insufficient. |
| **`-2019` vs `-4164`** | — | If you get `-2019` on a *small* order, suspect `MIN_NOTIONAL` mis-rounding instead. If you get `-4164` after increasing size, suspect you forgot `MARKET_LOT_SIZE`. |

**Standard remediation loop for filter errors (`-1111`, `-4014`, `-4023`, `-4164`):**

```
1. re-fetch GET /fapi/v1/exchangeInfo (bypass cache)
2. re-derive tickSize / stepSize / minQty / minNotional / MARKET_LOT_SIZE for the symbol
3. re-round price (away from market for stops) and quantity (down)
4. re-validate MIN_NOTIONAL against mark price for MARKET orders
5. optionally POST /fapi/v1/order/test to verify before the real send
6. retry ONCE; if it fails again, abort and alert (do not loop)
```

### 6.4 `GET /fapi/v1/premiumIndex` — Mark Price and Funding Rate

**Security:** `NONE`. **Weight:** `1` with `symbol`, `10` without.

| Param | Notes |
| --- | --- |
| `symbol` | Optional. Omit to get an **array** for all symbols |

Response (single-symbol form; array form returns an array of these):

```json
{
  "symbol": "BTCUSDT",
  "markPrice": "11793.63104562",
  "indexPrice": "11781.80495970",
  "estimatedSettlePrice": "11781.16138815",
  "lastFundingRate": "0.00010000",
  "nextFundingTime": 1597392000000,
  "interestRate": "0.00010000",
  "time": 1597370495002
}
```

| Field | Meaning |
| --- | --- |
| `symbol` | Contract |
| **`markPrice`** | Current mark price. **This is the price used by `workingType=MARK_PRICE`, by `MIN_NOTIONAL` for MARKET orders, by `PERCENT_PRICE`, and by unrealized-PnL/liquidation math.** Use it — not the last trade — for sizing. |
| `indexPrice` | Underlying index price |
| `estimatedSettlePrice` | Estimated settle price — documented as **"only useful in the last hour before the settlement starts"** |
| **`lastFundingRate`** | The *latest* funding rate as a decimal fraction, e.g. `0.00038246` = 0.038246% |
| `nextFundingTime` | ms timestamp of the next funding event. Guard against `0`/absent (observed on some symbols; not documented as a guaranteed-present field) |
| `interestRate` | Interest rate component |
| `time` | Server time of the response |

**Gotchas:**
- `lastFundingRate` is a **rate, not a percentage** — multiply by 100 for display, and by `notional` to estimate the next funding payment.
- The name `lastFundingRate` is misleading: it is the rate for the *current/next* funding interval, not the realized past one.
- `nextFundingTime` may be `0`; do not do arithmetic on it blindly.
- For funding *history*, use `GET /fapi/v1/fundingRate` (`symbol` required, `startTime`, `endTime`, `limit` default 100 / max 1000). Its response now includes **`rateType`** (`Regular` for the normal rate, `Special` for the stock-dividend extra rate) since **2026-07-23**. Also `GET /fapi/v1/fundingInfo` for funding-interval/cap metadata.

### 6.5 `GET /fapi/v1/openInterest` — Open Interest

**Security:** `NONE`. **Weight:** **1**.

| Param | Required |
| --- | --- |
| `symbol` | **YES** |

```json
{ "openInterest": "10659.509", "symbol": "BTCUSDT", "time": 1589437530011 }
```

`openInterest` is in **base asset units** (contracts of the base asset), not notional. Multiply by `markPrice` for notional OI. For historical OI use `GET /futures/data/openInterestHist` (note the different path prefix — it is under `/futures/data`, not `/fapi`).

### 6.6 `GET /fapi/v1/klines` — Kline/Candlestick Data

**Security:** `NONE`.

| Param | Required | Notes |
| --- | --- | --- |
| `symbol` | YES | |
| `interval` | YES | See enum below |
| `startTime` | NO | ms, **inclusive** |
| `endTime` | NO | ms, **inclusive** |
| `limit` | NO | **Default 500, max 1500** |

**Weight** depends on `limit` (verify exact boundaries against the current doc):

| `limit` | Weight |
| --- | --- |
| `[1, 100)` | 1 |
| `[100, 500)` | 2 |
| `[500, 1000]` | 5 |
| `> 1000` (up to 1500) | 10 |

**`interval` enum** — from [Common Definition, "Kline/Candlestick chart intervals"](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/common-definition): `s` = seconds, `m` = minutes, `h` = hours, `d` = days, `w` = weeks, `M` = months.

Listed values: **`1s`**, `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`.

> `1s` **is** present in the documented futures interval enum (unlike the older futures docs). Treat `1s` support as symbol-dependent and verify per symbol; for reliable sub-minute data prefer the WebSocket `<symbol>@kline_1m` stream plus trades. Do not blindly trust `M` vs `m` (case matters: `1m` = 1 minute, `1M` = 1 month).

Other documented facts for this endpoint:

- "Klines are **uniquely identified by their open time**." Key your candle store on element 0, not element 6.
- After the CM migration, `symbol` "accepts both UM and CM symbols."
- "If `startTime` and `endTime` are not sent, the most recent klines are returned."

**The 12 array elements, in order:**

| Index | Type | Field | Meaning |
| --- | --- | --- | --- |
| 0 | number | **open time** | Kline open time, ms |
| 1 | string | **open** | Open price |
| 2 | string | **high** | High price |
| 3 | string | **low** | Low price |
| 4 | string | **close** | Close price |
| 5 | string | **volume** | Base-asset volume |
| 6 | number | **close time** | Kline close time, ms |
| 7 | string | **quote asset volume** | Quote-asset volume |
| 8 | number | **number of trades** | Trade count |
| 9 | string | **taker buy base asset volume** | Taker buy base volume |
| 10 | string | **taker buy quote asset volume** | Taker buy quote volume |
| 11 | string | **ignore** | Unused — ignore |

Interpretation notes:
- **Prices and volumes are strings**, times and counts are **numbers**. Parse explicitly.
- `taker buy base / volume` gives the buy/sell pressure ratio: `buyRatio = takerBuyBase / volume`.
- Element 11 is documented as `ignore`; never depend on it.

> **THE OPEN-CANDLE GOTCHA:** the final element of a normal (non-`endTime`-bounded) response is the **still-forming, currently-open candle**. Its `close` price changes tick-by-tick and its `volume` is incomplete. **`closeTime` for that candle is in the future.**
>
> The relationship is exact and confirmed by the official example: with `openTime = 1499040000000` and `closeTime = 1499644799999`, **`closeTime = openTime + intervalMs - 1`** (here 60000 ms for `1m`). So the last candle is open iff `closeTime >= Date.now()`.
>
> Correct rule: **a candle is only complete if `closeTime < Date.now()`** (equivalently: drop the last element unless its `closeTime` has passed). Implement this explicitly:
> ```
> const now = Date.now();
> const closed = klines.filter(k => k[6] < now);
> ```
> Never compute signals on an unclosed candle; never use the unclosed candle's `close` as a confirmed signal. For a warm-up, request `limit = N + 1` and discard the last.
>
> A second consequence: because element 6 is the **close time (inclusive end)**, the next candle's element 0 (`openTime`) is **`closeTime + 1`**, not `closeTime`. Do not build an index keyed on `closeTime` and expect contiguity with `openTime`.

**Also relevant:** `GET /fapi/v1/continuousKlines` (params `pair`, `contractType`, `interval`, …) and `GET /fapi/v1/indexPriceKlines` / `GET /fapi/v1/markPriceKlines` (param `pair` instead of `symbol`) follow the same 12-element format.

### 6.7 Other market-data endpoints worth caching

| Endpoint | Notes |
| --- | --- |
| `GET /fapi/v1/time` | Server time — `{"serverTime": ...}`. Weight 1. Use for clock sync (§2.8). |
| `GET /fapi/v1/ticker/price` | `symbol` optional. Weight **1** for a single symbol, **2** when `symbol` is omitted. ⚠️ **The `GET /fapi/v1/ticker/price` page is titled `Symbol Price Ticker(Deprecated)` — prefer `GET /fapi/v2/ticker/price`**, which has the same contract. There is **no `symbols=` parameter** on either (see §7.1). |
| `GET /fapi/v1/ticker/24hr` | Weight **1** for one symbol, **40** with no symbol (weight scales with the number of symbols when `symbols=` is used, e.g. 40 for >100 symbols — verify). |
| `GET /fapi/v1/ticker/bookTicker` | Best bid/ask. RPI orders are excluded. |
| `GET /fapi/v1/depth` | `limit` enum: `5, 10, 20, 50, 100, 500, 1000`. Larger limits cost more weight. RPI orders excluded. |
| `GET /fapi/v1/aggTrades` | Aggregated trades; lookback now **48 hours** (extended from 24h, 2026-08-11). |
| `GET /fapi/v1/trades` | Recent trades. |
| `GET /fapi/v1/historicalTrades` | **Weight 200** (raised from 20 on 2026-07-29); only the **last 1 month**'s data. |
| **`GET /fapi/v1/leverageBracket`** | "Notional and Leverage Brackets". Weight **1**; `symbol` optional (omit ⇒ array for all symbols; provide ⇒ single object). Response: `symbol`, `notionalCoef` (present only when your symbol bracket has been individually adjusted), and `brackets[]` of `{ bracket, initialLeverage, notionalCap, notionalFloor, maintMarginRatio, cum }`. Use to validate leverage (§4.1). **This is the endpoint — `notionalBrackets` does not exist.** |

---

## 7. Rate Limits & Error Handling

### 7.1 The limits

From [General Info — LIMITS](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/general-info) and a **live** `GET /fapi/v1/exchangeInfo`:

| `rateLimitType` | `interval` | `intervalNum` | `limit` | Scope |
| --- | --- | --- | --- | --- |
| `REQUEST_WEIGHT` | `MINUTE` | 1 | **2400** | **Per IP** |
| `ORDERS` | `MINUTE` | 1 | **1200** | **Per account (UID)** |
| `ORDERS` | `SECOND` | **10** | **300** | **Per account (UID)** |

> **There are THREE entries, not two.** The legacy docs' `exchangeInfo` example is stale and shows only the first two. The live response contains the `ORDERS / SECOND / 10 → 300` entry as well, and it is also confirmed by the WebSocket API's `rateLimits[]` block and by the change log's repeated references to `X-MBX-ORDER-COUNT-10S`. **The 10-second order limit is the one you will actually hit as a market-making/trading bot** — 300 orders per 10 s sounds generous, but it is per account and shared across all symbols.

- "**The limits on the API are based on the IPs, not the API keys.**"
- **⚠️ These are PRODUCTION values. Testnet/demo `REQUEST_WEIGHT` is `6000`/min**, with `ORDERS` unchanged at 1200/min and 300/10s. Read `rateLimits` from `exchangeInfo` (and `X-MBX-USED-WEIGHT-1M`) rather than hardcoding — see §8.2.1.
- "**The order rate limit is counted against each account.**"
- **Also discoverable at runtime:** `GET /fapi/v1/rateLimit/order` (USER_DATA, weight **1**) returns the **account-specific** ORDERS limits, which for some tiers are far higher than the global default — e.g. `[{"rateLimitType":"ORDERS","interval":"SECOND","intervalNum":10,"limit":10000},{"rateLimitType":"ORDERS","interval":"MINUTE","intervalNum":1,"limit":20000}]`. **The `exchangeInfo` values (300/1200) are the documented global baseline; `rateLimit/order` is the authoritative per-account ceiling.** Read it once at startup and use it instead of hardcoding.
- **WebSocket API sharing:** the WS API `ORDERS` limit is **per UID and shared with REST** — REST and WS order placement draw on the same order budget. The WS API's `REQUEST_WEIGHT` pool is **separate** from REST's.
- **⚠️ USDⓈ-M (`fapi`) and COIN-M (`dapi`) share ONE IP weight counter.** The CM-UM integration notice states: *"Requests on either `fapi` or `dapi` count against the same `X-MBX-USED-WEIGHT-1M` counter."* So if you run both products from one IP (or one process), their request weights **add**. This is easy to miss when a UM-only bot suddenly starts getting 429s after a CM strategy is enabled.
- **Weights are per endpoint and can be dynamic.**
  - Endpoints that operate on multiple symbols (or omit `symbol`) cost more: `/fapi/v1/openOrders` is **1** with a symbol but **40** without; `/fapi/v1/ticker/24hr` is **1** for one symbol and **40** with no symbol; `/fapi/v1/ticker/price` is **1** for one symbol and **2** with no symbol; `/fapi/v1/historicalTrades` is **200**.
  - **There is no `symbols=` list parameter on the futures ticker endpoints** (unlike Spot). `GET /fapi/v1/ticker/price` and `/fapi/v2/ticker/price` accept only `symbol`; passing `symbols=[...]` is silently ignored and you receive the full all-symbols array at the no-symbol weight. **Do not port Spot's "weight scales with list length" logic to futures** — a `symbols=` list neither works nor multiplies weight here.
  - Batch endpoints multiply: `/fapi/v1/batchOrders` is **5** on the IP weight (up to 5 orders per call).
  - `limit`-scaled endpoints: `/fapi/v1/klines` (1/2/5/10 by `limit`, §6.6) and `/fapi/v1/depth` (weight rises with the depth level requested).
- Binance "has the right to further tighten the rate limits on users with intent to attack."

### 7.2 Reading the weight headers

Every response contains a header of the form:

```
X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)
```

Concretely for futures: **`X-MBX-USED-WEIGHT-1M`** — the current used weight for this IP in the current 1-minute window.

Order-count headers on order responses:

```
X-MBX-ORDER-COUNT-10S
X-MBX-ORDER-COUNT-1M
```

> **Caveats:**
> - **Header names are case-insensitive** for HTTP, but `fetch` gives you lowercased keys — read `res.headers.get('x-mbx-used-weight-1m')`.
> - **`X-MBX-USED-WEIGHT-1M` is documented as INACCURATE on `GET /fapi/v2/ticker/price`** — Binance says explicitly to ignore it from that endpoint. Do not let that one response corrupt your local budget tracker.
> - The window is a **fixed 1-minute window that resets** (not a sliding 60 s window). Reading the header is the only reliable local signal.
> - **"Rejected/unsuccessful orders are not guaranteed to have `X-MBX-ORDER-COUNT-**` headers in the response."** Do not assume parity between your request count and the server's.
> - A response may itself be generated by a rate-limit check *before* the request is counted, so **account for the weight of the request you just made** when you read the header.
> - Track your own pre-flight budget locally as well: maintain a counter of the weight you *intend* to spend and refuse to send if it would exceed a self-imposed cap (e.g. 2000), leaving headroom for retries and other processes on the same IP.

### 7.3 HTTP status codes and correct backoff

From [General Info — HTTP Return Codes](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/general-info):

| Status | Meaning | Action |
| --- | --- | --- |
| `4XX` | Malformed request — **the issue is on the sender's side** | **Do not retry blindly.** Fix the request. Parse the JSON `{code, msg}`. |
| `403` | **WAF (Web Application Firewall) limit violated** | Stop. Back off hard. Investigate your request pattern; this is not a normal rate limit. |
| `408` | Timeout waiting for a response from the backend server | Retry with backoff. Treat execution status as **unknown** (see 503 section). |
| `429` | **Rate limit broken** | **Back off immediately.** ⚠️ **Binance does NOT document a `Retry-After` header on USDⓈ-M Futures** (unlike Spot). Do not build logic that depends on it. Instead: sleep a fixed 5 s, then exponential 5→10→20→40 s (cap ~60 s), and resume at a *reduced* rate. The ban-expiry timestamp, when present, arrives inside the `-1003` message body ("… IP banned until %s") — parse that. |
| `418` | **IP auto-banned for continuing to send requests after receiving `429`s** | You are banned. Stop all traffic from this IP. Wait out the ban. **IP bans scale in duration for repeat offenders, from 2 minutes to 3 days.** |
| `5XX` | Internal error — Binance's side | Retry with backoff. |
| `503` | See below — three distinct meanings | Depends on the message |

**The `429` / `418` escalation rule (critical):**

> "When a 429 is received, it's your obligation as an API to back off and not spam the API. **Repeatedly violating rate limits and/or failing to back off after receiving 429s will result in an automated IP ban (HTTP status 418).**"

**Recommended backoff algorithm:**

```
on 429:
  - Binance documents no Retry-After for fapi; do not depend on it.
  - Sleep 5s, then exponential: 5s -> 10s -> 20s -> 40s (cap ~60s).
  - If the body is a -1003 "IP banned until %s" variant, parse %s and sleep until then.
  - After the sleep, HALVE your request rate (or add a fixed inter-request delay)
    and drain the backlog of non-urgent (market data) calls. Cancel/prioritise:
    reduce-only and close-position orders are exempt from system throttling and
    should be sent first.
  - Do NOT resume at the previous rate. If you hit 429 twice in a rolling 5 min,
    clamp to a conservative rate for at least 15 min.

on 418:
  - STOP ALL requests from this IP immediately (not just to the offending endpoint).
  - Sleep for at least the ban duration (start from 2 min; assume it grows).
  - After the ban, resume at a drastically reduced rate and only after re-reading
    X-MBX-USED-WEIGHT-1M.
  - Repeated 418s escalate the ban up to 3 days. Treat as a hard incident.
```

**HTTP 503 has three variants with different meanings:**

| Message | Meaning | Action | Counted against limits? |
| --- | --- | --- | --- |
| `Unknown error, please check your request or try again later.` | Request accepted but no response before timeout. **Execution may have succeeded — status UNKNOWN.** | **Do NOT treat as failure.** Reconcile via the user data stream or `GET /fapi/v1/order` (by `origClientOrderId`!) before retrying, to avoid duplicates. | May or may not — check the header |
| `Service Unavailable.` | **100% failure**, service temporarily unavailable | Retry with exponential backoff (200ms → 400ms → 800ms, max 3–5 attempts) | Not counted |
| `Request throttled by system-level protection. Reduce-only/close-position orders are exempt. Please try again.` (`-1008`) | Node exceeded max concurrency; **100% failure** | Retry with backoff and **reduce concurrency** | Not counted |

**`-1008` details:** applies to `POST /fapi/v1/order`, `POST /fapi/v1/batchOrders`, `POST /fapi/v1/order/test`. Requests that **reduce exposure** are **exempt and prioritised**: `closePosition=true`, or `positionSide=BOTH` + `reduceOnly=true`, or `LONG`+`SELL`, or `SHORT`+`BUY`. **Design your bot so risk-reducing orders are always attempted first and are never blocked behind market-data flooding.**

**Idempotency is the key defensive tool:** always send a deterministic `newClientOrderId` (or `clientAlgoId`) *before* the request, persist it, and on any `-1006`/`-1007`/`503-unknown`/network timeout, **query by that id** rather than resending. `-4116 DUPLICATED_CLIENT_ORDER_ID` ("clientOrderId is duplicated") is the signal that your retry reached the server.

### 7.4 Error codes a bot must handle explicitly

Codes below are quoted exactly from the [Error Code page](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/error-code) (`{ "code": -1121, "msg": "Invalid symbol." }`).

**10xx — general server / network**

| Code | Msg | Handling |
| --- | --- | --- |
| `-1000` | `An unknown error occured while processing the request.` (UNKNOWN) | Retry once with backoff; if persistent, alert |
| `-1001` | `Internal error; unable to process your request. Please try again.` (DISCONNECTED) | Retry with backoff |
| `-1002` | `You are not authorized to execute this request.` (UNAUTHORIZED) | **Do not retry.** Fix key/permissions |
| `-1003` | `Too many requests; current limit is %s requests per minute. Please use the websocket for live updates to avoid polling the API.` / `Way too many requests; IP banned until %s. …` | **Back off / you are banned.** See §7.3 |
| `-1006` | `An unexpected response was received from the message bus. Execution status unknown.` | **Reconcile by `clientOrderId` before any retry.** Never blind-resend an order |
| `-1007` | `Timeout waiting for response from backend server. Send status unknown; execution status unknown.` | Same as `-1006` |
| `-1008` | `Server is currently overloaded with other requests. Please try again in a few minutes.` / `Request throttled by system-level protection. Reduce-only/close-position orders are exempt. Please try again.` | Backoff + reduce concurrency; prioritise reduce-only |
| `-1013` | `INVALID_MESSAGE.` (filter failure) | Fix parameters. Often a filter violation (`-1111`/`-4014`-class) |
| `-1015` | `Too many new orders.` / `Too many new orders; current limit is %s orders per %s.` | Back off on the **order** limiter (`X-MBX-ORDER-COUNT-*`) |
| `-1016` | `This service is no longer available.` | Stop; endpoint retired |
| `-1020` | `This operation is not supported.` | Stop |
| **`-1021`** | `Timestamp for this request is outside of the recvWindow.` / `Timestamp for this request was 1000ms ahead of the server's time.` | **Re-sync `GET /fapi/v1/time`, then retry ONCE with a fresh signature** (§2.8) |
| **`-1022`** | `Signature for this request is not valid.` | **Do not retry.** Your signed string ≠ transmitted string. Log the exact payload and diff it. Common causes: signing a different parameter order than sent, double-encoding, `signature` not last, wrong secret, mixing query/body incorrectly |
| `-1023` | `Start time is greater than end time.` | Fix params |
| `-1099` | `Not found, unauthenticated, or unauthorized.` | Check auth |

**11xx — request issues**

| Code | Msg | Handling |
| --- | --- | --- |
| `-1100` | `Illegal characters found in a parameter.` / `Illegal characters found in parameter '%s'; legal range is '%s'.` | Sanitize; check `newClientOrderId` regex |
| `-1102` | `A mandatory parameter was not sent, was empty/null, or malformed.` / `Mandatory parameter '%s' was not sent…` / `Param '%s' or '%s' must be sent, but both were empty/null!` | Fix the request |
| `-1104` | `Not all sent parameters were read.` / `Not all sent parameters were read; read '%s' parameter(s) but was sent '%s'.` | **You sent a parameter this endpoint ignores** — e.g. `stopPrice`/`closePosition` on `/fapi/v1/order`. Strong signal of the §5 migration bug |
| `-1105` | `A parameter was empty.` / `Parameter '%s' was empty.` | Omit empty params rather than sending them blank |
| `-1106` | `A parameter was sent when not required.` / `Parameter '%s' sent when not required.` | E.g. `reduceOnly` in hedge mode; `quantity` with `closePosition=true` |
| `-1111` | `Precision is over the maximum defined for this asset.` | Round to `tickSize`/`stepSize` (§6.3) |
| `-1115` | `Invalid timeInForce.` | Use a documented TIF |
| `-1116` | `Invalid orderType.` | Use a documented type |
| `-1117` | `Invalid side.` | |
| `-1118` | `New client order ID was empty.` | |
| `-1120` | `Invalid interval.` | Fix kline interval |
| `-1121` | `Invalid symbol.` | Symbol not tradable/delisted. Re-read `exchangeInfo` |
| `-1122` | `Invalid symbol status.` | Symbol not `TRADING` |
| `-1125` | `This listenKey does not exist. Please use POST /fapi/v1/listenKey to recreate listenKey` | Recreate the user data stream |
| `-1127` | `Lookup interval is too big.` / `More than %s hours between startTime and endTime.` | Narrow the window (7 days for userTrades/allOrders) |
| `-1128` | `Combination of optional parameters invalid.` | Fix the combination |
| `-1130` | `Invalid data sent for a parameter.` / `Data sent for parameter '%s' is not valid.` | Fix the value |

**20xx — processing / account**

| Code | Msg | Handling |
| --- | --- | --- |
| `-2010` | `NEW_ORDER_REJECTED` | Inspect |
| `-2011` | `CANCEL_REJECTED` / `Cancel request failure as open order not found in the orderbook: "Unknown order sent".` | **Treat as already-cancelled (idempotent success)** if you intended to cancel |
| `-2013` | `Order does not exist.` | Reconcile; may be filled or expired |
| `-2014` | `API-key format invalid.` | Fix the key |
| `-2015` | `Invalid API-key, IP, or permissions for action.` | Fix IP whitelist / permissions |
| `-2017` | `API Keys are locked on this account.` | Stop; contact support |
| `-2018` | `Balance is insufficient.` | Reduce size |
| **`-2019`** | `Margin is insufficient.` | Recompute size vs `availableBalance` and leverage; reduce |
| `-2020` | `Unable to fill.` | Retry or abandon |
| **`-2021`** | `Order would immediately trigger.` | Trigger price already crossed. For a long stop, `triggerPrice` must be **below** market; for a short stop, **above** |
| **`-2022`** | `ReduceOnly Order is rejected.` / `This indicates the new reduce-only order conflicts with existing open orders; cancel the existing order and resubmit the reduce-only order.` | Cancel the conflicting open order, then resubmit |
| `-2023` | `User in liquidation mode now.` | **Abort.** Do not add risk |
| `-2024` | `Position is not sufficient.` | Reduce quantity; you tried to close more than you hold |
| `-2025` | `Reach max open order limit.` | Cancel orders first |
| `-2026` | `This OrderType is not supported when reduceOnly.` | Use a different type |
| `-2027` | `Exceeded the maximum allowable position at current leverage.` | Lower leverage or size |
| `-2028` | `Leverage is smaller than permitted: insufficient margin balance.` | Add margin or lower position |

**40xx — filters, configuration, and the algo migration**

| Code | Msg | Handling |
| --- | --- | --- |
| `-4001` | `Price less than 0.` | Fix |
| `-4002` | `Price greater than max price.` | Fix |
| `-4003` | `Quantity less than zero.` | Fix |
| `-4004` | `Quantity less than min quantity.` | Increase size or skip |
| `-4005` | `Quantity greater than max quantity.` | Split or reduce |
| `-4006` | `Stop price less than zero.` | Fix |
| `-4007` | `Stop price greater than max price.` | Fix |
| `-4013` | `Price less than min price.` | Fix |
| **`-4014`** | `Price not increased by tick size.` | **Round price to `tickSize`** |
| `-4015` | `Client order id is not valid.` / `Client order id length should not be more than 36 chars` | Fix the id |
| `-4016` | `Price is higher than mark price multiplier cap.` | `PERCENT_PRICE` — move the price closer to market |
| `-4023` | `Qty not increased by step size.` | **Round quantity to `stepSize`** |
| `-4024` | `Price is lower than mark price multiplier floor.` | `PERCENT_PRICE` |
| `-4028` | `Invalid leverage` / `Leverage %s is not valid` / `Leverage %s already exist with %s` | Use a bracket-valid leverage |
| `-4031` | `Invalid parameter working type` / `Invalid parameter working type: %s` | Use exactly `MARK_PRICE` or `CONTRACT_PRICE` |
| `-4045` | `Reach max stop order limit.` | Cancel conditional orders; cap is 200 |
| **`-4046`** | `No need to change margin type.` | **Treat as success** |
| **`-4047`** | `Margin type cannot be changed if there exists open orders.` | Cancel orders first |
| **`-4048`** | `Margin type cannot be changed if there exists position.` | Close position first |
| `-4056` | `Invalid api key type.` | Fix key type |
| `-4057` | `Invalid api public key` | RSA key problem |
| `-4059` | `No need to change position side.` | **Treat as success** |
| `-4060` | `Invalid position side.` | |
| `-4061` | `Order's position side does not match user's setting.` | Fix hedge-mode `positionSide` |
| `-4062` | `Invalid or improper reduceOnly value.` | You sent `reduceOnly` in hedge mode |
| **`-4067`** | `Position side cannot be changed if there exists open orders.` | Cancel orders first |
| **`-4068`** | `Position side cannot be changed if there exists position.` | Close positions first |
| `-4082` | `Invalid number of batch place orders: %s` | Batch >5 |
| `-4083` | `Fail to place batch orders.` | Inspect per-order results |
| `-4087` | `User can only place reduce only order` | Account restriction |
| `-4088` | `User can not place order currently` | Account restriction |
| `-4105` | `Symbol is under position risk control, only reduce-only order is allowed.` | **Stop opening; only reduce** |
| `-4106` / `-4107` | `Symbol is under position risk control, buy/sell order can only works with reduce-only.` | Reduce-only only |
| `-4109` | `Inactive account` / `Transfer any amount of asset to future wallet to reactive` | Fund the account |
| `-4116` | `clientOrderId is duplicated` | **Your retry landed.** Reconcile, do not resend |
| `-4117` | `stop order is triggering` | Wait; retry later |
| `-4118` | `ReduceOnly Order Failed. Please check your existing position and open orders` | Cancel the conflicting same-side order |
| **`-4120`** | `Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.` | **Use `POST /fapi/v1/algoOrder`** (§5.4). Never swallow this |
| `-4131` | `The counterparty's best price does not meet the PERCENT_PRICE filter limit` | Back off; market moved outside band |
| `-4135` | `Invalid activation price` | Fix `activatePrice` |
| **`-4137`** | `Quantity must be zero with closePosition equals true` | Remove `quantity` |
| **`-4138`** | `Reduce only must be true with closePosition equals true` | Remove `reduceOnly` |
| `-4142` | `REJECT: take profit or stop order will be triggered immediately` | Move the trigger away from market |
| `-4144` | `Invalid pair` | |
| **`-4161`** | `Leverage reduction is not supported in Isolated Margin Mode with open positions` | Go flat first, or stay in cross |
| **`-4164`** | `Order's notional must be no smaller than 5.0 (unless you choose reduce only)` | Increase size or use reduce-only |
| `-4165` | `Invalid time interval` / `Maximum time interval is %s days` | Narrow the query |
| `-4167`…`-4172` | Multi-assets / isolated mutual exclusions (see §4.2) | Fix the mode |
| `-4189` | `Restricted account permission: can only place reduceOnly order on the symbol.` | Reduce-only only |
| `-4192` | `Trade forbidden due to Cooling-off Period.` | Stop trading |
| `-4202`/`-4203`/`-4205`/`-4206`/`-4208`/`-4209` | Leverage/KYC/region gates. `-4208` `Current symbol leverage cannot exceed 20 when using position limit adjustment service.`; `-4209` `The max leverage of Symbol is 20x` / `Leverage adjustment failed. Current symbol max leverage limit is %sx` | Cap leverage per the message |
| `-4531` | `Position mode change requires syncing UM and CM. Please close any open positions or orders in CM and try again.` | (Temporary, 2026-05-11) flatten CM first |

**42xx — stop-price multiplier caps (band checks on *conditional* orders)**

| Code | Exact msg | Handling |
| --- | --- | --- |
| `-4210` | `Stop price is higher than price multiplier cap.` / `Stop price can't be higher than %s` | Clamp the trigger price toward the market |
| `-4211` | `Stop price is lower than price multiplier floor.` / `Stop price can't be lower than %s` | Clamp the trigger price toward the market |

**44xx — quantitative rules, regional compliance, and large-position controls**

| Code | Name | Exact msg | Handling |
| --- | --- | --- | --- |
| **`-4400`** | `TRADING_QUANTITATIVE_RULE` | `Futures Trading Quantitative Rules violated, only reduceOnly order is allowed, please try again later.` | **Do not retry the same order.** Only reduce-only will be accepted. Stop opening, reduce exposure, alert. Pair with `GET /fapi/v1/apiTradingStatus` ("Futures Trading Quantitative Rules Indicators") |
| **`-4401`** | `LARGE_POSITION_SYM_RULE` | `Futures Trading Risk Control Rules of large position holding violated, only reduceOnly order is allowed, please reduce the position. .` (double period is in the API) | Reduce the position; only reduce-only accepted |
| `-4402` | `COMPLIANCE_BLACK_SYMBOL_RESTRICTION` | `Dear user, as per our Terms of Use and compliance with local regulations, this feature is currently not available in your region.` | Fatal for that symbol/region — drop it |
| `-4403` | `ADJUST_LEVERAGE_COMPLIANCE_FAILED` | `Dear user, as per our Terms of Use and compliance with local regulations, the leverage can only up to 10x in your region` / `… can only up to %sx in your region` | Cap leverage per the message |

> **`-4411` does NOT exist for USDⓈ-M Futures.** The UM 44xx block is exactly `-4400`, `-4401`, `-4402`, `-4403`. If you have seen "`-4411`", it is almost certainly a misreading of **`-4401`** or a **Portfolio Margin** code (`-4405 UM_REDUCE_ONLY_ONLY`, `-4407 ACCOUNT_REDUCE_ONLY`, `-4415 CM_REDUCE_ONLY_ONLY`). Do not implement it for UM. Likewise, **`-4189 ACCOUNT_REDUCE_ONLY` is the UM code** for "Restricted account permission: can only place reduceOnly order on the symbol." — PM uses `-4407` with the *same message*. Do not conflate the two namespaces.

**50xx — order execution issues (this block is easy to miss, and it contains a critical timing error)**

| Code | Name | Exact msg | Handling |
| --- | --- | --- | --- |
| `-5021` | `FOK_ORDER_REJECT` | `Due to the order could not be filled immediately, the FOK order has been rejected.` | Expected for FOK; don't retry identically |
| `-5022` | `GTX_ORDER_REJECT` | `Due to the order could not be executed as maker, the Post Only order will be rejected.` | Expected for GTX; re-price toward the book |
| `-5024` | `MOVE_ORDER_NOT_ALLOWED_SYMBOL_REASON` | `Symbol is not in trading status. Order amendment is not permitted.` | Stop amending |
| `-5025` | `LIMIT_ORDER_ONLY` | `Only limit order is supported.` | Use `LIMIT` |
| `-5026` | `Exceed_Maximum_Modify_Order_Limit` | `Exceed maximum modify order limit.` | Cancel + replace instead of amending |
| `-5027` | `SAME_ORDER` | `No need to modify the order.` | **Treat as idempotent success** |
| **`-5028`** | `ME_RECVWINDOW_REJECT` | `Timestamp for this request is outside of the ME recvWindow.` | **Re-sync clock and retry.** See the warning below — this is a *second*, independent window check |
| `-5029` | `MODIFICATION_MIN_NOTIONAL` | `Order's notional must be no smaller than %s` | Amend to a larger notional |
| `-5037` | `INVALID_PRICE_MATCH` | `Invalid price match` | Fix `priceMatch` |
| `-5038` | `UNSUPPORTED_ORDER_TYPE_PRICE_MATCH` | `Price match only supports order type: LIMIT, STOP AND TAKE_PROFIT` | Remove `priceMatch` |
| `-5039` | `INVALID_SELF_TRADE_PREVENTION_MODE` | `Invalid self trade prevention mode` | Fix `selfTradePreventionMode` |
| `-5040` | `FUTURE_GOOD_TILL_DATE` | `The goodTillDate timestamp must be greater than the current time plus 600 seconds and smaller than 253402300799000 (UTC 9999-12-31 23:59:59)` | Fix `goodTillDate` |
| `-5041` | `BBO_ORDER_REJECT` | `No depth matches this BBO order` | Retry/re-price |
| `-5043` | `Existing_Pending_Modification` | `A pending modification already exists for this order.` | Wait for the in-flight amend |
| `-5047` | `NOT_REDUCE_ONLY_ORDER` | `The original order is not a reduce-only order.` | Added 2026-09-15 — see below |

> ### ⚠️ `-5028` — the second `recvWindow` check you probably don't know about
>
> Binance performs the `recvWindow` check **twice**: once at the API gateway (which produces **`-1021`**) and again when the order reaches the **matching engine** (which produces **`-5028 ME_RECVWINDOW_REJECT`**). Change log 2023-04-17 (release 2023-04-18):
>
> > "The `recvWindow` check will also be performed when orders reach matching engine." … "the order placing requests are valid if `recvWindow + timestamp >= matching engine timestamp`."
>
> Impacted endpoints: `POST`/`PUT /fapi/v1/order`, `POST`/`PUT /fapi/v1/batchOrders`. (COIN-M's twin is `-4188`.)
>
> **Consequence:** you can sign perfectly, pass the gateway check, and still be rejected on the way to the engine. A `recvWindow` of `5000` is normally fine, but if your clock offset is stale by a second or two or your request path is slow, you will see `-5028` and not `-1021`. **Treat `-5028` exactly like `-1021`: re-sync `GET /fapi/v1/time`, re-sign, retry once.** Keep `recvWindow` comfortably above your worst-case signing→engine latency; do not shave it down to 1000 ms "for safety" — that makes `-5028` *more* likely.

> **`-5047` and the 2026-09-15 change:** `PUT /fapi/v1/order` (Modify Order) and the WebSocket API `order.modify` gained an optional **`reduceOnly`** (STRING) parameter, effective **2026-09-15**. When `reduceOnly=true` the endpoint **skips `min_notional` validation** on the modified order **if and only if the original order was placed as reduce-only**; otherwise it rejects with **`-5047` "The original order is not a reduce-only order."** Note the caveat in the entry: this parameter is used **purely for validation** (min-notional bypass + reduce-only consistency check) and **does NOT change the order's reduce-only attribute** — that stays whatever it was at placement time.

**Do not hardcode this table.** The error-code document is long, is updated without notice, and spans several product namespaces whose codes collide. **Treat your error table as data (a config file or map), not as a `switch` on a literal type**, and always include an `UNKNOWN_CODE` fallback that logs the raw `{code, msg}` at `warn` level rather than throwing. When a code is unknown, log it and **do not retry the order** — reconcile first.

**Recommended error-classification switch for a bot:**

```
RETRYABLE_AFTER_CLOCK_RESYNC       = [-1021, -5028]
RETRYABLE_WITH_BACKOFF             = [-1000, -1001, -1008, -1015, -2011, -4117, -4192, -5021, -5022, -5041, -5043]
RECONCILE_DO_NOT_RESEND            = [-1006, -1007, -4116, 503-unknown]
IDEMPOTENT_SUCCESS_TREAT_AS_OK     = [-2011, -4046, -4052, -4059, -4171, -5027]
REFRESH_METADATA_THEN_RETRY_ONCE   = [-1111, -4014, -4023, -4164, -5029, -1121, -1130, -4031, -5037, -5038, -5039, -5040]
FIX_REQUEST_DO_NOT_RETRY           = [-1022, -1102, -1104, -1105, -1106, -1116, -1117, -4137, -4138, -1013, -4082, -4210, -4211, -5047]
REDUCE_OR_ABORT                    = [-2019, -2018, -2024, -2025, -2026, -2027, -2028, -4045, -4120, -4131, -4161, -4400, -4401, -5026]
HARD_STOP_ALERT                    = [-1002, -1003, -2015, -2017, -2023, -4105, -4109, -4189, -4402, -4403, 418, 403]
```

Rules of thumb:

- **Never retry `-1022`** without changing the payload — it will always fail.
- **Never blind-retry an order** after `-1006`, `-1007`, `-4116`, or an unknown `503` — always reconcile via `clientOrderId`/`clientAlgoId`.
- **`-4120` should trigger an immediate alarm in your monitoring**: it means your stop-loss code path is broken and positions are unprotected.
- **`-4400` / `-4401` mean "you may only reduce".** Your bot must flip into a reduce-only mode for that symbol, not retry.
- **`-2011`/`-4046`/`-4052`/`-4059`/`-4171`/`-5027` are idempotent-success** results; treating them as errors causes spurious strategy resets.
- **`-5028` is not a filter error** — it is a timing error. Classifying it as `FIX_REQUEST_DO_NOT_RETRY` (a common mistake, since it arrives alongside 50xx execution codes) will silently disable your order flow.

---

## 8. Testnet / Demo Trading Specifics

### 8.1 Getting keys

- **Binance no longer calls it "Testnet" in the UI — it is "Demo Trading."** The docs' Quick Start says: "Users can use the Futures Testnet to practice `FUTURES` trading. Currently, this is only available via the API. Please refer to the [Futures Demo Trading page](https://demo.binance.com/en/futures/BTCUSDT) for more information and how to set up the Demo Trading API key."
- **Portal:** `https://demo.binance.com` — log in, go to the Demo Trading API management page, create an API key. The demo environment has its own key/secret pair, **separate from production keys**. As of 2025-11-12, Binance also launched a new **Options** demo API environment and pointed users at `https://demo.binance.com/zh-CN/my/settings/api-management`.
- Test/demo accounts are funded with **fake balance**. **There is NO faucet** — a full-text search for "faucet" across the legacy docs, the Demo Trading FAQ, and ccxt's `binance.js`/`binance.ts` returns **zero** occurrences. The modern equivalent is **Demo Reset**: *"go to [Assets], select which account you want to reset (Spot or Futures), and choose [Reset]."* There is also no `/sapi` transfer path into a demo account (§8.3).
- **Demo Trading FAQ (verbatim, retrieved via a rendering proxy because the page itself is WAF-protected):** *"Visit the demo trading platform (https://demo.binance.com/) and log in using your Binance account."* / *"Only a Binance account is needed… Users who have not completed identity verification (KYC) or do not have a Futures Account can access Demo Trading"* / *"Binance Demo Trading is available to users in certain countries and regions only."*
- **API keys created on the production site do NOT work on demo, and vice versa.** This is the most common "authentication fails on testnet" cause.

### 8.2 Pointing at testnet — verified configuration

> **🔴 There is NO separate "testnet" and "demo" backend for USDⓈ-M futures. `https://demo-fapi.binance.com` and `https://testnet.binancefuture.com` are currently the *same* backend** — verified by identical stale `exchangeInfo.serverTime` (`1789008009026`), identical symbol count (739 total / 605 `TRADING`), digit-identical BTCUSDT 1m klines, and identical `openInterest` and `fundingRate` history. Only node-computed values (`markPrice`, `lastPrice`, `depth`) differ. So this is **not** a "two generations, pick one" situation; both names work and run the same environment. (The genuinely separate pair is *Spot*: `testnet.binance.vision` vs `demo-api.binance.com`. ccxt treats `setSandboxMode` and `enableDemoTrading()` as mutually exclusive: *"demo trading is not supported in the sandbox environment"*.)

```ini
# ---- REST ----
rest_base   = https://demo-fapi.binance.com       # canonical, live, docs-blessed
rest_alt    = https://testnet.binancefuture.com   # identical backend, still live

# ---- Market data WebSocket (pick one, make it configurable) ----
market_ws   = wss://demo-fstream.binance.com     # what the DOCS say
market_ws   = wss://fstream.binancefuture.com     # what Binance's OWN SDK constants say
market_ws   = wss://stream.binancefuture.com      # third historical name, still live
# All three answered the WS handshake with real data.
# ALWAYS use the routed path: /market/ws/<stream>, /public/ws/<stream>, /private/ws?listenKey=...

# ---- WebSocket API (order placement over WS) ----
ws_api      = wss://testnet.binancefuture.com/ws-fapi/v1   # the ONLY WS host that works here

# ---- Keys ----
keys        = https://demo.binance.com/  ->  API Management
              (https://demo.binance.com/en/my/settings/api-management)
funds       = Assets -> Reset        # THERE IS NO FAUCET

# ---- Limits / clock ----
rate_limit  = REQUEST_WEIGHT 6000/min            # NOT 2400 — see below
clock_sync  = GET /fapi/v1/time                  # exchangeInfo.serverTime is ~5.4 days STALE
```

**⚠️ The market-WS host is genuinely ambiguous and you must not guess.** The docs name `wss://demo-fstream.binance.com`; Binance's own SDK constants file (`binance-connector-python`, `common/src/binance_common/constants.py`) names `wss://fstream.binancefuture.com` for `..._WS_STREAMS_TESTNET_URL`; and the older `wss://stream.binancefuture.com` still answers. **Notably, that constants file has no `..._WS_STREAMS_DEMO_URL` entry at all.** All three hosts returned data when probed. **Pick one, keep it in config, and prefer the routed path** so you stay forward-compatible with the 2026-04-23 split. (ccxt contains **no** testnet WS URLs at all — do not cite it for these.)

**❌ Do NOT use:**

| Bad URL / path | Result |
| --- | --- |
| `wss://demo-fstream.binance.com/ws-fapi/v1` | **404** — the WS *API* is not on the demo-fstream host |
| `wss://testnet.binancefuture.com/ws/<stream>` or `.../market/ws/<stream>` | **WAF 202 challenge** — on that host **only `/ws-fapi/v1` works** |
| `https://testnet.binancefuture.com/futures/data/*` | **WAF 202** |
| `/fapi/v1/balance`, `/fapi/v1/positionRisk`, `GET /fapi/v1/listenKey` on testnet | **404 — these `/fapi/v1` paths do not exist**; use `/fapi/v2/` or `/fapi/v3/` |

Testnet **does** honor the routed `/public`, `/market`, `/private` paths — verified live on both testnet hosts.

### 8.2.1 🔴 Testnet rate limits differ from production

> **The request-weight limit on testnet/demo is `6000`/min, NOT `2400`/min.**

| Limiter | Production | Testnet / Demo |
| --- | --- | --- |
| `REQUEST_WEIGHT` / `MINUTE` / 1 | **2400** | **6000** |
| `ORDERS` / `MINUTE` / 1 | 1200 | 1200 (identical) |
| `ORDERS` / `SECOND` / 10 | 300 | 300 (identical) |

Confirmed two ways: testnet `exchangeInfo.rateLimits` returns `6000`, and a live testnet WebSocket-API round-trip returned `{"rateLimitType":"REQUEST_WEIGHT","interval":"MINUTE","intervalNum":1,"limit":6000,"count":6}`.

**Never hardcode a weight limit.** Read `rateLimits` from `exchangeInfo` and `X-MBX-USED-WEIGHT-1M` from response headers, per environment. A bot that hardcodes 2400 on testnet is merely over-conservative; one that hardcodes 6000 on production will get `429` → `418`. See §7.1.

### 8.3 What testnet/demo does and does not support — **live-verified**

| Supported | Not supported / different |
| --- | --- |
| Order placement, cancel, amend, **algo orders** | **`/sapi/*` — hard 403.** `/sapi/v1/capital/config/getall`, `/sapi/v1/account/apiRestrictions`, `/sapi/v1/system/status` all return **403** on `demo-fapi`. No wallet, transfers, deposits or withdrawals. (ccxt: *"demotrading does not support sapi endpoints"*) |
| Account/position endpoints — **but only `/fapi/v2/*` and `/fapi/v3/*`** | **`/fapi/v1/balance` and `/fapi/v1/positionRisk` return 404 on testnet.** You cannot fall back to v1 for those |
| Position mode, margin type, leverage, symbolConfig/accountConfig | **`/futures/data/*` is unusable** — `openInterestHist` on `demo-fapi` returned HTTP 200 with the literal non-JSON body `111 107`; on `testnet.binancefuture.com` it is WAF-blocked (202). **Do not build testnet data pipelines on `/futures/data/*`** |
| Market data (ping/time/exchangeInfo/premiumIndex/ticker/depth/klines/continuousKlines/openInterest/fundingRate/indexInfo/insuranceBalance/constituents all 200) | **The full symbol universe** — testnet has **739 symbols / 605 `TRADING`** vs production **897 / 766** |
| WebSocket market + user data streams; **WS API works on testnet** | **Market-driven funding rates** — testnet `lastFundingRate` is pinned to `0.00010000` (equal to `interestRate`) on every sample. Production varied (`0.00004220`, `0.00003563`, `0.00006188`). Testnet also **omits the `rateType` field** that production returns (schema lag) |
| Filter enforcement — testnet reports the same filter structure | **Realistic liquidity** — testnet BTCUSDT 24hr quoteVolume was **8.6× HIGHER** than production while trade count was **10× LOWER**. Book depth is wide and erratic. **Never calibrate sizing or slippage off testnet volume** |
| `listenKey` routes exist (`POST` → 401, not 404, i.e. route present and key-gated) | **Authenticated testnet listenKey round-trip** is unverified here (no keys available) |
| `convert/exchangeInfo` responds (500 — present but erroring) | `/fapi/v1/pmExchangeInfo`, `/fapi/v1/portfolioMarginExchangeInfo` → 404 |

**Mark price vs index price on testnet:** `indexPrice` is **mirrored from production** (identical values, e.g. `76974.32826087`), while `markPrice` is **computed locally** (testnet `76910.22899209` vs prod `76952.90000000`) and `estimatedSettlePrice` is approximately equal. Consequence: **anything you test that depends on mark price** — `workingType=MARK_PRICE` triggers, `priceProtect`, liquidation distance, `MIN_NOTIONAL` for MARKET orders — **behaves differently on testnet than in production.**

### 8.4 Known behavioral differences and practical advice

1. **Symbol universe is smaller and the filter values are environment-specific.** Testnet: **739 symbols / 605 `TRADING`**; production: **897 / 766**. Testnet also carries contract types production does not (e.g. `CURRENT_QUARTER DELIVERING`). **Always fetch `exchangeInfo` per environment** and fail fast if a symbol is missing — do not cache production `tickSize`/`stepSize` and expect testnet to accept them.
2. **`REQUEST_WEIGHT` is 6000/min on testnet vs 2400/min on production** (§8.2.1). Read the limit from `exchangeInfo`; never hardcode it.
3. **`/fapi/v2/balance` and `/fapi/v2/positionRisk` are the live testnet paths for those resources** — `/fapi/v1/balance` and `/fapi/v1/positionRisk` are **404** there. Note this cuts against using v3 exclusively: `/fapi/v3/balance` and `/fapi/v3/positionRisk` do work on testnet (401 = present, key required), so v2/v3 are both fine, but **v1 is not**.
4. **WebSocket hosts are ambiguous — make the URL configurable and always use routed paths.** The docs, Binance's own SDK constants, and the legacy host name three *different* testnet market-WS URLs (`demo-fstream.binance.com`, `fstream.binancefuture.com`, `stream.binancefuture.com`); all three serve data. The testnet **WS API** exists only at `wss://testnet.binancefuture.com/ws-fapi/v1` — `demo-fstream.binance.com/ws-fapi/v1` returns **404**, and `testnet.binancefuture.com/ws/<stream>` returns a WAF **202**. Route explicitly: `/market/ws/<stream>`, `/public/ws/<stream>`, `/private/ws?listenKey=...`.
5. **Liquidity on testnet is actively misleading, not merely thin.** Testnet BTCUSDT 24hr quote volume measured **8.6× higher** than production while its trade count was **10× lower**, and the book is wide and erratic. **Never calibrate order sizing, slippage assumptions, or fill-probability models against testnet volume.** Prefer `LIMIT` orders for testnet testing so you control the price.
6. **Funding and mark price are not market-driven on testnet.** `lastFundingRate` is pinned near `interestRate` (e.g. `0.00010000`) instead of floating, and `markPrice` is computed locally while `indexPrice` is mirrored from production. So `workingType=MARK_PRICE` triggers, `priceProtect` behavior, liquidation distance, and `MIN_NOTIONAL` checks for MARKET orders can all differ. **Do not tune liquidation or funding logic against testnet.**
7. **`/sapi/*` is 403 on testnet** — there is no wallet/transfer/deposit/withdraw surface. Fund via **Assets → Reset**, not a faucet.
8. **Never ship demo credentials.** Keep base URL + credentials as separate environment-scoped config and **assert at startup that the key and the base URL belong to the same environment** (a demo key must never be paired with `fapi.binance.com`, and vice versa). A misconfiguration here means live orders.
9. **⚠️ Testnet `exchangeInfo.serverTime` is STALE by ~5.4 days.** Measured: `exchangeInfo.serverTime` = `1789008009026` (2026-09-10 02:40:09Z) while the same host's `GET /fapi/v1/time` = 2026-09-15 13:29:02Z. **Sync your clock offset from `GET /fapi/v1/time` only** — if you use `exchangeInfo.serverTime` (as some tutorials suggest), your `timestamp` will be days off and you will get `-1021`/`-5028` on every signed call. (Production's `exchangeInfo.serverTime` is fine, but the doc explicitly says to ignore it anyway — §6.1.)
10. **The keys/UI live at `https://demo.binance.com`.** The legacy `https://testnet.binancefuture.com` UI returns a WAF challenge (HTTP 202) to non-browser clients, so whether that older UI still exists is unverified — treat `demo.binance.com` as canonical. (Binance's own Python SDK README links "Futures Testnet" to `https://testnet.binance.vision/`, which is the *Spot* testnet — a bug in their README. Don't follow it.)

---

## 9. Signing Checklist for a Node.js Implementation

A numbered, implementation-ordered checklist. Follow it literally; every step exists because skipping it produces a specific, observed failure.

**Setup (once, at startup)**

1. **Store `apiKey` and `secretKey` separately** from `baseUrl`. Assert both are present and non-empty; fail fast otherwise.
2. **Sync the clock:** `GET {baseUrl}/fapi/v1/time` (unsigned). Compute `serverOffsetMs = serverTime - Date.now()`. Persist it. Schedule a re-sync every 15–60 minutes. On any `-1021`, re-sync immediately.
3. **Decide the transmission layout and never mix:** use the **query string** for `GET`/`DELETE`, and the **`application/x-www-form-urlencoded` body** for `POST`/`PUT`. Mixing is legal but makes the signed string a bare concatenation with no `&` at the join point (§2.4) — the single easiest way to produce `-1022`.
4. **Fetch `GET /fapi/v1/exchangeInfo` once** and build a symbol→filters map (`tickSize`, `stepSize`, `minQty`, `minNotional`, `MARKET_LOT_SIZE`, `triggerProtect`, `pricePrecision`, `quantityPrecision`). Cache with a TTL and invalidate on any filter error.

**Per signed request**

5. **Generate `timestamp` exactly once:** `const timestamp = Date.now() + serverOffsetMs` using the **millisecond** integer. Do not compute it separately for signing and for sending. Do not use seconds. Do not send `X-MBX-TIME-UNIT` (futures ignores/does not define it).
6. **Add a `recvWindow`** (recommended `5000`; never more than `60000`) as an integer number of milliseconds.
7. **Add `signature`-relevant business parameters** (`symbol`, `side`, `type`, `quantity`, `price`, `positionSide`, `newClientOrderId`, `algoType`, `triggerPrice`, `closePosition`, …). **Round quantity to `stepSize` and price/trigger price to `tickSize` *before* building the string** (§6.2) — rounding after signing changes the value and invalidates the signature.
8. **Omit empty/undefined parameters entirely.** Sending `price=` or `quantity=undefined` causes `-1102`/`-1105`. Build the parameter list by filtering out `null`/`undefined`/`""`.
9. **Serialize deterministically.** Create an ordered array of `[key, value]` pairs and reuse the *exact same serialized string* for both signing and transmission. A safe pattern:
   ```ts
   const pairs: Array<[string, string]> = [...]
     .filter(([, v]) => v !== undefined && v !== null && v !== '')
     .map(([k, v]) => [k, String(v)]);

   const payload = pairs
     .map(([k, v]) => `${encodeURIComponent(k)}=${rfc3986Encode(v)}`)
     .join('&');
   ```
   Serialize the string **once** and hold it in a variable. Never regenerate it (e.g. via `new URLSearchParams(obj).toString()`) after signing.
10. **Percent-encode each value** (RFC 3986: unreserved = `A-Z a-z 0-9 - _ . ~`; everything else `%XX` uppercase). For this API's value set (numbers, `true`/`false`, uppercase enums, tickers) `encodeURIComponent` is sufficient — but be aware it does **not** escape `! ' ( ) *` while Binance's reference `rawurlencode` does. If you ever sign arbitrary text, use an explicit encoder. Non-ASCII symbols (e.g. Chinese) **must** be UTF-8 percent-encoded.
11. **Compute the signature over the payload string *excluding* `signature`:**
    ```ts
    import { createHmac } from 'node:crypto';
    const signature = createHmac('sha256', secretKey)
      .update(payload, 'utf8')      // ASCII/UTF-8 bytes of the payload
      .digest('hex');
    ```
    HMAC-SHA256, hex digest, **lowercase hex** is what Binance returns and what it accepts; the signature is not case sensitive.
    (For **RSA** keys: sign the same payload bytes with `RSASSA-PKCS1-v1_5` + SHA-256 using your PKCS#8 private key, take **Base64**, then **URL-encode** the Base64 before appending.)
12. **Append `signature` LAST:**
    ```ts
    const finalQuery = `${payload}&signature=${signature}`;
    // or, for a form body:
    const finalBody  = `${payload}&signature=${signature}`;
    ```
    The docs are explicit: "Please make sure the `signature` is the end part of your query string or request body." **The signature itself is not URL-encoded in the HMAC case** (it is pure hex).
13. **Send the raw HTTP request with the correct headers:**
    ```ts
    const res = await fetch(`${baseUrl}${path}?${finalQuery}`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: finalBody,            // exactly `payload + '&signature=' + signature`
    });
    ```
    - Header name exactly **`X-MBX-APIKEY`**.
    - For `GET`/`DELETE`, put the whole signed string in the URL query and send **no body**.
    - **Do not** add `Content-Type` on `GET` requests.
    - **Do not** send the payload and the signature in different places.
14. **Verify the bytes you sent equal the bytes you signed.** In development, log `payload` and assert `bodyOrQuery === payload + '&signature=' + signature`. This one assertion eliminates the overwhelming majority of `-1022` reports.
15. **Parse the response defensively.**
    - Check `res.status` first: `429`/`418` ⇒ rate-limit path (§7.3); `4xx` ⇒ parse `{code, msg}`; `5xx`/`503` ⇒ consult the message.
    - Binance returns **HTTP 400** with a JSON error body for most business errors (e.g. `-4120` came back as HTTP 400) — **never treat a non-2xx as a generic network failure**; always read the body.
    - All numbers are **strings** in responses — parse explicitly; never assume `typeof x === 'number'`.
16. **Read the rate-limit headers on every response:** `x-mbx-used-weight-1m`, and on order endpoints `x-mbx-order-count-10s` / `x-mbx-order-count-1m`. Feed them into a token-bucket/pre-flight budget that reserves headroom.
17. **Re-sign (fresh `timestamp`) on every retry.** Never resend a previously signed string: even if the payload is identical, a retry after a delay will exceed `recvWindow` and fail with `-1021`.
18. **Always send a deterministic `newClientOrderId` / `clientAlgoId` before the request** and persist it *before* awaiting the response. On any ambiguous outcome (`-1006`, `-1007`, unknown `503`, socket error, timeout), **do not resend** — query by that id (`GET /fapi/v1/order?origClientOrderId=…` or `GET /fapi/v1/algoOrder?clientAlgoId=…`) and reconcile.
19. **Handle `-1021` as a first-class path:** re-sync `GET /fapi/v1/time`, recompute `timestamp`, re-sign, retry **once**. If it fails again, abort and alert rather than looping.
20. **Expected signature failure modes to check when you get `-1022`:** (a) `signature` is not last; (b) you signed a different parameter order/set than you sent; (c) you signed a URL-encoded string but sent a decoded one, or vice versa; (d) you mixed query string and body and lost/added the `&` at the join; (e) you signed before rounding quantity/price; (f) wrong secret (e.g. demo secret against production, or trailing whitespace/newline in the env var); (g) `timestamp` computed twice; (h) using `encodeURIComponent`-then-`URLSearchParams` double-encoding (spaces become `%2520`).

---

## Appendix A — Primary Sources

Official (fetched and cross-checked):

- [USDⓈ-M Futures — General Info](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/general-info) (base URLs, testnet, HTTP codes, security types, timing, HMAC/RSA signing examples, limits)
- [USDⓈ-M Futures — Common Definition](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/common-definition) (ENUMs, filters, rateLimit objects)
- [USDⓈ-M Futures — Error Code](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/error-code) (exact codes and messages)
- [Derivatives — Change Log](https://developers.binance.com/legacy-docs/derivatives/change-log) (all dated changes, through 2026-09-10)
- [Derivatives — Quick Start](https://developers.binance.com/legacy-docs/derivatives/quick-start) (testnet/demo, API key setup)
- [Trade REST API (current docs)](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order) — New Order, New Algo Order, batchOrders, leverage, marginType, positionRisk V2/V3, userTrades, openOrders, allOrders, countdownCancelAll, adlQuantile, positionMargin, orderAmendment, openAlgoOrders, algoOrder, algoOpenOrders
- [Account REST API (current docs)](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Account-Information-V3) — account/balance V2 & V3, income, commissionRate, accountConfig, symbolConfig, leverageBracket (Notional and Leverage Brackets), rateLimit/order, multiAssetsMargin, positionSide/dual
- [Important WebSocket Change Notice — Base URL Split & Migration](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice)
- [New Algo Order (legacy mirror)](https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/trade/rest-api/New-Algo-Order)

Independent cross-checks:

- [Binance Developer Community — "Algo Order endpoint question"](https://dev.binance.vision/t/algo-order-endpoint-question/37372) (Binance staff confirming `-4120` and the `POST /fapi/v1/algoOrder` migration, 2026-04)
- [Binance Spot API CHANGELOG — `X-MBX-TIME-UNIT`](https://github.com/binance/binance-spot-api-docs/blob/master/CHANGELOG.md) (confirming the header is a **Spot** feature)
- Official connectors: [binance-connector-python](https://github.com/binance/binance-connector-python), [binance-connector-java](https://github.com/binance/binance-connector-java); third-party: `ccxt`, `go-binance`, `openxapi/binance-go`
- **Live unauthenticated probes** of `https://fapi.binance.com/fapi/v1/exchangeInfo`, `/time`, `/ticker/price`, and the demo hosts — used to confirm the third `rateLimits` entry (`ORDERS/SECOND/10 → 300`), the per-symbol `MIN_NOTIONAL` values, the undocumented `POSITION_RISK_CONTROL` filter, the absence of `MAX_NUM_ALGO_ORDERS`, the testnet `REQUEST_WEIGHT` of **6000**, testnet symbol counts and endpoint availability (404/401/403/200 surface), testnet's non-market-driven funding and locally-computed `markPrice`, the stale testnet `exchangeInfo.serverTime`, and that **all three** testnet market-WS hosts currently answer.
- `binance-connector-python` — `common/src/binance_common/constants.py` (the authoritative list of official base URLs, including the testnet WS host that the docs omit).

### Research notes (so you can re-verify quickly)

- `https://developers.binance.com/docs/...` pages are **client-side rendered** and return an empty body to a plain fetcher. Two workarounds that work:
  1. The **static legacy mirror** `https://developers.binance.com/legacy-docs/derivatives/...` — plain HTML, fetchable, and kept in sync with the current specification (it carries the same generated request/response schemas).
  2. A rendering proxy such as `https://r.jina.ai/https://developers.binance.com/docs/...`. Fetching *any one* endpoint page returns the **entire section** (all endpoints), so grep the result rather than reading it top to bottom.
- Binance also publishes the whole new doc site as plaintext for LLMs: `https://developers.binance.com/en/docs/llms.txt` (index) and `https://developers.binance.com/en/docs/llms-full.txt` (concatenated). Note the individual `.md` URLs listed in `llms.txt` are served as `application/octet-stream` and do **not** fetch as text — use `llms-full.txt`.
- Binance's own `Common Definition` page is **stale in places** relative to live behavior (it still documents `MAX_NUM_ALGO_ORDERS` and omits `POSITION_RISK_CONTROL`). When the docs and a live response disagree, **trust the live response** and note the divergence.
- **Binance HTML *announcement* pages are WAF-blocked too** (HTTP 202, empty body), but the same article is retrievable as JSON via their CMS endpoint:
  `https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query?articleCode=<articleCode>`
  This is how the 2024-09-03 "Notice on Upcoming Binance API Update" was read (it turned out to contain only the v2/WS `5 -> 10` weight change and the `<listenKey>@account|@balance|@position` deprecation — **no** STP, new headers, or removed parameters).

## Appendix B — Endpoint Quick Reference

| Method | Path | Security | Weight | Requires symbol |
| --- | --- | --- | --- | --- |
| GET | `/fapi/v1/time` | NONE | 1 | No |
| GET | `/fapi/v1/exchangeInfo` | NONE | 1 | No |
| GET | `/fapi/v1/premiumIndex` | NONE | 1 / 10 | No |
| GET | `/fapi/v1/openInterest` | NONE | 1 | **Yes** |
| GET | `/fapi/v1/klines` | NONE | 1–10 | **Yes** |
| GET | `/fapi/v1/ticker/price` | NONE | 1 / 2 | No |
| GET | `/fapi/v1/ticker/24hr` | NONE | 1 / 40 | No |
| GET | `/fapi/v1/depth` | NONE | 1–50 | **Yes** |
| GET | `/fapi/v1/fundingRate` | NONE | 1 | **Yes** |
| POST | `/fapi/v1/listenKey` | USER_STREAM | 1 | No |
| PUT | `/fapi/v1/listenKey` | USER_STREAM | 1 | No |
| DELETE | `/fapi/v1/listenKey` | USER_STREAM | 1 | No |
| GET | `/fapi/v2/account` | USER_DATA | 5 (changelog: 10) | No |
| GET | `/fapi/v3/account` | USER_DATA | 5 | No |
| GET | `/fapi/v2/balance` | USER_DATA | 5 (changelog: 10) | No |
| GET | `/fapi/v3/balance` | USER_DATA | 5 | No |
| GET | `/fapi/v2/positionRisk` | USER_DATA | 5 (changelog: 10) | No |
| GET | `/fapi/v3/positionRisk` | USER_DATA | 5 | No |
| GET | `/fapi/v1/income` | USER_DATA | 30 | No |
| GET | `/fapi/v1/userTrades` | USER_DATA | 5 | **Yes** |
| GET | `/fapi/v1/commissionRate` | USER_DATA | 20 | **Yes** |
| GET | `/fapi/v1/accountConfig` | USER_DATA | 5 | No |
| GET | `/fapi/v1/symbolConfig` | USER_DATA | 5 | No |
| GET | `/fapi/v1/leverageBracket` | USER_DATA | 1 | No |
| GET | `/fapi/v1/rateLimit/order` | USER_DATA | 1 | No |
| GET | `/fapi/v1/apiTradingStatus` | USER_DATA | 1 / 10 no-symbol | No |
| GET | `/fapi/v1/positionSide/dual` | USER_DATA | 30 | No |
| POST | `/fapi/v1/positionSide/dual` | TRADE | 1 | No |
| GET | `/fapi/v1/multiAssetsMargin` | USER_DATA | 30 | No |
| POST | `/fapi/v1/multiAssetsMargin` | TRADE | 1 | No |
| POST | `/fapi/v1/leverage` | TRADE | 1 | **Yes** |
| POST | `/fapi/v1/marginType` | TRADE | 1 | **Yes** |
| POST | `/fapi/v1/positionMargin` | TRADE | 1 | **Yes** |
| POST | `/fapi/v1/order` | TRADE | 0 IP / 1 order | **Yes** |
| POST | `/fapi/v1/order/test` | TRADE | 0 IP / 1 order | **Yes** |
| POST | `/fapi/v1/batchOrders` | TRADE | 5 IP / 5 order | **Yes** |
| POST | `/fapi/v1/algoOrder` | TRADE | 0 IP / 1 order | **Yes** |
| DELETE | `/fapi/v1/algoOrder` | TRADE | 1 | No |
| DELETE | `/fapi/v1/algoOpenOrders` | TRADE | 1 | **Yes** |
| GET | `/fapi/v1/algoOrder` | USER_DATA | 1 | No |
| GET | `/fapi/v1/openAlgoOrders` | USER_DATA | 1 / 40 | No |
| GET | `/fapi/v1/allAlgoOrders` | USER_DATA | 5 | No |
| GET | `/fapi/v1/openOrders` | USER_DATA | 1 / 40 | No |
| GET | `/fapi/v1/allOrders` | USER_DATA | 5 | No |
| DELETE | `/fapi/v1/allOpenOrders` | TRADE | 1 | **Yes** |
| PUT | `/fapi/v1/order` | TRADE | 1 | **Yes** |
| POST | `/fapi/v1/countdownCancelAll` | TRADE | 10 | **Yes** |

> Weights marked `~` or given as ranges are the ones with a **documented discrepancy** between the change log and the current generated docs. **Read the weight from the live docs page for your exact endpoint before hardcoding**, and monitor `X-MBX-USED-WEIGHT-1M` rather than trusting a static table.
>
> **Environment matters:** the per-IP `REQUEST_WEIGHT` ceiling is **2400/min on production but 6000/min on testnet/demo**. The `ORDERS` limits (1200/min, 300/10s) are the same in both.

---

*End of document.*