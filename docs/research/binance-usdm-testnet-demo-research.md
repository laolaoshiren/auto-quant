# Binance USDⓈ-M Futures TESTNET / DEMO TRADING — Verified Endpoint Research

**Observation window:** 2026-09-15 13:18:31Z – 13:30:00Z (local 2026-09-15 21:18–21:30 +08:00)
**Method:** live `web_fetch` + live HTTP/WebSocket probes from pwsh; static legacy docs via `web_fetch`; source code from GitHub raw.
**Labels:** `VERIFIED` = ≥2 independent sources agree (docs + code, or code + live probe, or docs + live probe). `SINGLE-SOURCE` = one source only. `UNVERIFIED` = could not confirm. `LIVE-OBSERVED` = my own direct probe (always cite status+body).

---

## 0. Method caveats (read first — these bound the conclusions)

1. **`web_search` was unavailable this session** (`Error: DeepSeek API error (HTTP 402): Insufficient Balance`). All documentary evidence below is from direct `web_fetch` of known URLs and GitHub raw. No search-engine result corroboration.
2. **All Binance HTML UI pages are behind an AWS WAF JavaScript challenge.** `https://testnet.binancefuture.com/`, `https://testnet.binancefuture.com/en/futures/BTCUSDT`, `https://demo.binance.com/`, `https://demo.binance.com/en/futures/BTCUSDT` all return:

   ```
   HTTP 202, Content-Length: 0, Server: CloudFront
   x-amzn-waf-action: challenge
   X-Cache: Error from cloudfront
   ```
   → **UI pages could not be content-verified from this environment.** A 202 here means "WAF challenge served", NOT "page is dead" and NOT "page works". Same 202 appears for `https://testnet.binancefuture.com/futures/data/openInterestHist?...`.
3. **The environment this research was gathered from ran a fake-IP proxy** (Clash-style, `HTTP_PROXY` pointing at a local port). DNS resolved every Binance domain into the RFC-2544 benchmark range (`198.18.0.0/15`) rather than to real addresses:

   ```
   demo-fapi.binance.com        => 198.18.0.0/15  (fake IP)
   testnet.binancefuture.com    => 198.18.0.0/15  (fake IP)
   fapi.binance.com             => 198.18.0.0/15  (fake IP)
   demo-fstream.binance.com     => 198.18.0.0/15  (fake IP)
   stream.binancefuture.com     => 198.18.0.0/15  (fake IP)
   ```

   → WebSocket handshake failures observed below **may be proxy artifacts**, not Binance behavior. REST probes are unaffected in practice (all succeeded), but treat WS *failures* as low-confidence and WS *successes* as high-confidence.

   **If you are reproducing this**: check your own DNS resolution first. If Binance domains resolve into `198.18.0.0/15`, you are behind a fake-IP proxy and the WebSocket results in this document do not transfer.
4. `GET /fapi/v1/exchangeInfo` on demo/testnet returns a **stale cached `serverTime`** (see §3.9). Do not trust that field there.

---

## 1. Current base URLs — OLD generation vs NEW generation

### 1.1 USDⓈ-M REST

| Generation | URL | Status |
|---|---|---|
| **NEW / demo (current canonical)** | `https://demo-fapi.binance.com` | `VERIFIED` |
| **OLD / testnet (still fully live)** | `https://testnet.binancefuture.com` | `VERIFIED` |

**NEW generation evidence (3 sources):**
- **Legacy docs, General Info** — exact string: `The REST base url for **testnet** is "[https://demo-fapi.binance.com](https://demo-fapi.binance.com)"` — <https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/general-info> (page footer: `Copyright © 2026 Binance`)
- **Official new Python SDK** `common/src/binance_common/constants.py` line 69 (exact):
  ```python
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_DEMO_URL = "https://demo-fapi.binance.com"
  ```
  raw: <https://raw.githubusercontent.com/binance/binance-connector-python/master/common/src/binance_common/constants.py>
- **CCXT** `js/src/binance.js` lines 222–227 (exact), under `'urls': { 'demo': { ... } }`:
  ```js
  'fapiPublic': 'https://demo-fapi.binance.com/fapi/v1',
  'fapiPublicV2': 'https://demo-fapi.binance.com/fapi/v2',
  'fapiPublicV3': 'https://demo-fapi.binance.com/fapi/v3',
  'fapiPrivate': 'https://demo-fapi.binance.com/fapi/v1',
  'fapiPrivateV2': 'https://demo-fapi.binance.com/fapi/v2',
  'fapiPrivateV3': 'https://demo-fapi.binance.com/fapi/v3',
  ```
- **LIVE-OBSERVED:** `200 OK`, body `{}` for `/fapi/v1/ping`; `200 OK`, body `{"serverTime":1789478319422}` for `/fapi/v1/time`.

**OLD generation evidence (2 sources, both say it is *not* the docs' canonical testnet, yet it is live):**
- **Official new Python SDK** `constants.py` lines 66–68 (exact):
  ```python
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL = (
      "https://testnet.binancefuture.com"
  )
  ```
- **CCXT** `js/src/binance.js` lines 204–209 (exact), under `'urls': { 'test': { ... } }`:
  ```js
  'fapiPublic': 'https://testnet.binancefuture.com/fapi/v1',
  'fapiPrivate': 'https://testnet.binancefuture.com/fapi/v1',
  ```
- **LIVE-OBSERVED:** `200 OK`, `{}` for `/fapi/v1/ping`; `200 OK`, `{"serverTime":1789478325920}` for `/fapi/v1/time`.

> **KEY RESULT — `demo-fapi` and `testnet.binancefuture.com` are the SAME backend, on different hostnames.**
> `GET /fapi/v1/exchangeInfo` returned **byte-identical** documents including the same stale `serverTime` `1789008009026`, same symbol count `739`, same `TRADING` count `605`, same asset list, same non-TRADING symbol set. Klines for `BTCUSDT 1m` were digit-identical:
> ```
> [[1789478220000,"76965.40","76965.40","76925.80","76953.60","6.9863",1789478279999,"537560.524370",143,"3.2714","251784.524520","0"], ...]
> ```
> `openInterest` identical to the last digit (`"405578558.6347"` on both at the same `time`). `fundingRate` history identical. Only real-time node-computed values differ (`markPrice`, `lastPrice`, `depth` `lastUpdateId`), which is expected for different cache nodes of one matching engine. → CCXT models them as two *different* environments (`urls['test']` vs `urls['demo']`) but they currently point at one shared testnet/demo exchange; the distinction that matters is **API-key/account provisioning**, not market data. See §3.10.

### 1.2 USDⓈ-M market WebSocket streams

| Generation | URL | Live result |
|---|---|---|
| OLD generation (task's "older generations") | `wss://stream.binancefuture.com` | `LIVE-OBSERVED` **OPEN + data** |
| Legacy-docs testnet base | `wss://demo-fstream.binance.com` | `LIVE-OBSERVED` **OPEN + data** |
| Official-SDK testnet WS-streams base | `wss://fstream.binancefuture.com` | `LIVE-OBSERVED` **OPEN + data** |
| COIN-M testnet streams | `wss://dstream.binancefuture.com` | `LIVE-OBSERVED` **OPEN + data** |
| Host that does NOT serve market streams | `wss://testnet.binancefuture.com/ws/...` | `LIVE-OBSERVED` **FAILS (WAF 202)** |

**Legacy-docs string (VERIFIED):** `The Websocket base url for **testnet** is "wss://demo-fstream.binance.com"` — <https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/general-info>

**Official Python SDK strings (exact, lines 76–79):**
```python
DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL = "wss://fstream.binance.com"
DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL = (
    "wss://fstream.binancefuture.com"
)
```
and lines 59–62 (COIN-M):
```python
DERIVATIVES_TRADING_COIN_FUTURES_WS_STREAMS_PROD_URL = "wss://dstream.binance.com"
DERIVATIVES_TRADING_COIN_FUTURES_WS_STREAMS_TESTNET_URL = (
    "wss://dstream.binancefuture.com"
)
```

**LIVE-OBSERVED raw frames (first message after connect):**
```
wss://demo-fstream.binance.com/ws/btcusdt@markPrice
  {"e":"markPriceUpdate","E":1789478388001,"s":"BTCUSDT","p":"76944.22056159","ap":"76944.22056159","P":...}
wss://stream.binancefuture.com/ws/btcusdt@aggTrade
  {"e":"aggTrade","E":1789478710811,"a":309918255,"s":"BTCUSDT","p":"76936.10","q":"0.0012",...,"st":1}
wss://fstream.binancefuture.com/market/ws/btcusdt@markPrice
  {"e":"markPriceUpdate","E":1789478982000,"s":"BTCUSDT","p":"76932.50000000","ap":"76932.50000000",...}
wss://dstream.binancefuture.com/ws/btcusdt@markPrice
  {"e":"markPriceUpdate","E":1789478988000,"s":"BTCUSDT","p":"76933.20000000",...}
```

**NEW routed-path structure (`/public`, `/market`, `/private`) — must-know, dated migration.**

Official notice: **"Important WebSocket Change Notice — Base URL Split & Migration"**
<https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice>

Exact strings:
- `Public (high-frequency public market data): wss://fstream.binance.com/public`
- `Market (regular market data): wss://fstream.binance.com/market`
- `Private (user data): wss://fstream.binance.com/private`
- `**Legacy URLs will remain available until 2026-04-23**, after which they will be permanently decommissioned.`
- `**After the upgrade, any connections not migrated will ONLY be able to receive data from `wss://fstream.binance.com/public`. Channels under `/market` and `/private` will stop pushing data.** For example, `wss://fstream.binance.com/ws/btcusdt@depth` will continue to work, but `wss://fstream.binance.com/ws/btcusdt@markPrice` will not.`
- Change-log entry `## 2026-04-02`: `Updated important websocket change notice with legacy URL decommissioning date: **2026-04-23**.`

Also the current "Connect" page states: `Connections that do not include a routed path (/public, /market, or /private) will only receive data from the Public endpoint.`

**`LIVE-OBSERVED` — the routed paths work on the testnet/demo stream hosts too:**
```
OPEN  wss://demo-fstream.binance.com/market/ws/btcusdt@markPrice      MSG: {"e":"markPriceUpdate",...}
OPEN  wss://demo-fstream.binance.com/market/stream?streams=btcusdt@markPrice
      MSG: {"stream":"btcusdt@markPrice","data":{"e":"markPriceUpdate","E":1789478799000,...}}
OPEN  wss://demo-fstream.binance.com/public/ws/btcusdt@depth          MSG: {"e":"depthUpdate",...,"pu":429105308030,...}
OPEN  wss://demo-fstream.binance.com/public/ws/btcusdt@bookTicker     MSG: {"e":"bookTicker","u":429105331794,...,"b":"76883.20","B":"136.9283","a":"76900.00",...}
OPEN  wss://stream.binancefuture.com/market/ws/btcusdt@markPrice      MSG: {"e":"markPriceUpdate",...}
OPEN  wss://fstream.binancefuture.com/ws/btcusdt@markPrice            MSG: {"e":"markPriceUpdate",...}   <- legacy unrouted form still pushes markPrice on the TESTNET host
FAIL  wss://demo-fstream.binance.com/private/ws?listenKey=fake => A task was canceled.  (fake key; inconclusive)
FAIL  wss://testnet.binancefuture.com/market/ws/btcusdt@markPrice => The server returned status code '202' when status code '101' was expected.
FAIL  wss://testnet.binancefuture.com/public/ws/btcusdt@depth    => The server returned status code '202' when status code '101' was expected.
```
⚠️ Note the asymmetry: on **production** the unrouted `wss://fstream.binance.com/ws/btcusdt@markPrice` returned OPEN with **no data** within 10–20s (consistent with the 2026-04-23 decommission), while on the **testnet** host `wss://fstream.binancefuture.com/ws/btcusdt@markPrice` still pushed markPrice. `SINGLE-SOURCE`/`LIVE-OBSERVED` — do not rely on the unrouted form; use `/market/ws/...` or `/public/ws/...`.

### 1.3 WebSocket API (request/response, `order.place` etc.)

**Current testnet base (VERIFIED, 2 sources):** `wss://testnet.binancefuture.com/ws-fapi/v1`

- **Legacy docs, WebSocket API General Info** — exact strings:
  > `The base endpoint is: **`wss://ws-fapi.binance.com/ws-fapi/v1`**`
  > `The base endpoint for testnet is: `wss://testnet.binancefuture.com/ws-fapi/v1``
  <https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/websocket-api-general-info>
- **Official Python SDK** `constants.py` lines 70–75 (exact):
  ```python
  DERIVATIVES_TRADING_USDS_FUTURES_WS_API_PROD_URL = (
      "wss://ws-fapi.binance.com/ws-fapi/v1"
  )
  DERIVATIVES_TRADING_USDS_FUTURES_WS_API_TESTNET_URL = (
      "wss://testnet.binancefuture.com/ws-fapi/v1"
  )
  ```
- COIN-M analog (lines 53–58): `wss://ws-dapi.binance.com/ws-dapi/v1` / `wss://testnet.binancefuture.com/ws-dapi/v1`

**LIVE-OBSERVED (handshake + real request/response, not just TCP):**
```
OPEN  wss://testnet.binancefuture.com/ws-fapi/v1
  sent: {"id":"p2","method":"time","params":{}}
  recv: {"id":"p2","status":200,"result":{"serverTime":1789478708148},
         "rateLimits":[{"rateLimitType":"REQUEST_WEIGHT","interval":"MINUTE","intervalNum":1,"limit":6000,"count":6}]}
OPEN  wss://ws-fapi.binance.com/ws-fapi/v1
  recv: {"id":"p3","status":200,"result":{"serverTime":1789478708818},
         "rateLimits":[{"rateLimitType":"REQUEST_WEIGHT","interval":"MINUTE","intervalNum":1,"limit":2400,"count":6}]}
FAIL  wss://demo-fstream.binance.com/ws-fapi/v1 => The server returned status code '404' when status code '101' was expected.
FAIL  wss://fstream.binance.com/ws-fapi/v1      => The server returned status code '404' when status code '101' was expected.
```
→ **`wss://demo-fstream.binance.com/ws-fapi/v1` is 404. The WS API testnet endpoint is NOT on the demo-fstream host.** This is a common trap: the REST demo host (`demo-fapi`) and the WS-API testnet host (`testnet.binancefuture.com`) differ.

### 1.4 What's "current" — recommendation

- **REST:** `https://demo-fapi.binance.com` is the docs' canonical testnet URL and is live. `https://testnet.binancefuture.com` is also live and currently identical. Prefer `demo-fapi` for REST: it serves `/futures/data/*` (`testnet.binancefuture.com` WAF-202s that path).
- **Market WS:** `wss://demo-fstream.binance.com` (docs) or `wss://fstream.binancefuture.com` (official SDK) — both live; use the new routed paths `/market/ws/...`, `/public/ws/...`, `/private/...`. `wss://stream.binancefuture.com` still works (old generation) but is the riskiest of the three.
- **WS API:** `wss://testnet.binancefuture.com/ws-fapi/v1`.

---

## 2. Testnet / Demo UI and FAUCET

### 2.1 The exact legacy-docs quote (VERIFIED verbatim)

Source: <https://developers.binance.com/legacy-docs/derivatives/quick-start> — section **"Futures Testnet"**:

```
### Futures Testnet

Users can use the Futures Testnet to practice `FUTURES` trading.

Currently, this is only available via the API.

Please refer to the [Futures Demo Trading page](https://demo.binance.com/en/futures/BTCUSDT) for more information and how to set up the Demo Trading API key.
```

Note it conflates "Futures Testnet" with "Futures Demo Trading page" and points at **`https://demo.binance.com/en/futures/BTCUSDT`**.

### 2.2 URLs and their verification status

| Purpose | URL | Status |
|---|---|---|
| Demo trading UI (futures) | `https://demo.binance.com/en/futures/BTCUSDT` | `VERIFIED` (legacy quick-start + Binance FAQ) |
| Demo trading UI (root) | `https://demo.binance.com/` | `VERIFIED` (Binance FAQ: "Visit the [demo trading platform](https://demo.binance.com/)") |
| **Demo trading API-key management** | `https://demo.binance.com/en/my/settings/api-management` | `SINGLE-SOURCE` (CCXT only) |
| Live-account API management (referenced by FAQ as the place to create the demo key) | `https://www.binance.com/en/my/settings/api-management` | `VERIFIED` (Binance FAQ) |
| Legacy testnet UI | `https://testnet.binancefuture.com` | `UNVERIFIED` (HTTP 202 WAF challenge — content not observable) |
| Legacy testnet UI deep link | `https://testnet.binancefuture.com/en/futures/BTCUSDT` | `UNVERIFIED` (HTTP 202 WAF challenge) |
| **Faucet** | *not found* | `UNVERIFIED` — see §2.4 |

**CCXT exact strings** (`js/src/binance.js` lines 3110–3111, JSDoc of `enableDemoTrading`):
```js
 * @see https://www.binance.com/en/support/faq/detail/9be58f73e5e14338809e3b705b9687dd
 * @see https://demo.binance.com/en/my/settings/api-management
```
(identical at `ts/src/binance.ts` lines 3112–3113)

**Binance FAQ content** (<https://www.binance.com/en/support/faq/detail/9be58f73e5e14338809e3b705b9687dd>, title `How to Use Binance Demo Trading?`, retrieved via `r.jina.ai` text extraction because the page itself is WAF-202) — exact strings:
- `Visit the [demo trading platform](https://demo.binance.com/) and log in using your Binance account.`
- `**2. Is Binance Demo Trading available on API?** Yes. Binance Demo Trading can be accessed via API. Log into your Binance account and visit Binance Demo Trading.Go to the API Management page by clicking the Account icon at the top right, or visit [API Management page here](https://www.binance.com/en/my/settings/api-management). Select **[Create API]** and provide a name for your API key.`
- `**3. Does Binance Demo Trading exactly replicate the actual live trading environment?** ... There may be discrepancies in the chart data, actual order book pricing, and trade order execution when compared to the live trading environment.`
- `Only a Binance account is needed to access Binance Demo Trading. Users who have not completed identity verification (KYC) or do not have a Futures Account can access Demo Trading for both Spot and Futures, subject to eligibility requirements.`
- `**Please note:** Binance Demo Trading is available to users in certain countries and regions only.`
- Not-supported list (exact): `Spot Demo Trading: Trading Bots, Copy Trading;` / `Futures Demo Trading: TWAP, PNL based close all, search history/top search, heatmap, top movers, webhook, Grid, and all export features.`

### 2.3 Practical conclusion for UI / API keys

- The **live** path to a USDⓈ-M demo/testnet key today is: log into **`https://demo.binance.com/`** (your real Binance account) → API Management → Create API. The CCXT-referenced demo-specific settings URL is `https://demo.binance.com/en/my/settings/api-management` (`SINGLE-SOURCE`).
- The FAQ explicitly says **only a Binance account is needed** — no separate testnet registration. This supersedes the classic "register at testnet.binancefuture.com with a separate email" flow.
- The legacy `https://testnet.binancefuture.com` UI may still exist, but I could not verify its content (WAF). Treat any claim about its current faucet/key UI as `UNVERIFIED`.

### 2.4 FAUCET — not found

- **No faucet URL is documented anywhere I could reach.** The legacy docs, quick-start, general-info, WS docs and the Demo Trading FAQ contain **zero** occurrences of "faucet".
- CCXT contains **zero** occurrences of `faucet`/`Faucet` (grepped `js/src/binance.js` + `ts/src/binance.ts`, full files, 805,241 / 828,661 bytes).
- The **modern replacement for a faucet is the Demo "Reset"**: FAQ exact string — `**4. Can I reset the virtual funds on my Demo Trading account?** Yes. Virtual funds can be reset separately for both Spot and Futures Accounts. To reset, go to **[Assets]**, select which account you want to reset (Spot or Futures), and choose **[Reset]**. If you have any pending orders, you will need to cancel them before you can reset your account.`
- Historical/testnet-style faucet (`https://testnet.binancefuture.com/...` faucet button) → `UNVERIFIED`. **Report as: no canonical faucet URL; use demo.binance.com Assets → Reset for virtual USDT.**

---

## 3. What testnet/demo does NOT support, and behavioral differences

### 3.1 `/sapi/*` — NOT supported  `VERIFIED`
- **CCXT code comment** (`js/src/binance.js` line 3184): `// demotrading does not support sapi endpoints`, immediately followed by `if (this.safeBool(this.options, 'enableDemoTrading', false)) { return {}; }` in `fetchCurrencies`.
- **LIVE-OBSERVED:** `https://demo-fapi.binance.com/sapi/v1/capital/config/getall` → **HTTP 403** (empty body); `https://demo-fapi.binance.com/sapi/v1/account/apiRestrictions` → **HTTP 403**; `https://demo-fapi.binance.com/sapi/v1/system/status` → **HTTP 403**.
- On `https://testnet.binancefuture.com/sapi/v1/capital/config/getall` → **HTTP 202** (WAF).
→ **No wallet/withdraw/transfer/asset sapi endpoints. No deposit/withdraw. Fund your account via the demo Reset, not a transfer.**

### 3.2 Symbol availability — restricted  `VERIFIED` (live, both hosts identical)

| | testnet/demo | production |
|---|---|---|
| `symbols` total | **739** | **897** |
| `status == "TRADING"` | **605** | **766** |
| non-TRADING | 134 | 131 |
| `assets` | `USDT,BTC,BNB,ETH,USDC,FDUSD,BNFCR,BFUSD,PIPPIN,B2,USD1,U` | `USDT,BTC,BNB,ETH,USDC,FDUSD,BNFCR,BFUSD,LDUSDT,RWUSD,USD1,U` |
| `contractType` values | `CURRENT_QUARTER,CURRENT_QUARTER DELIVERING,CURRENT_WEEK,NEXT_QUARTER,NEXT_WEEK,PERPETUAL,TRADIFI_PERPETUAL` | `CURRENT_QUARTER,NEXT_QUARTER,PERPETUAL,TRADIFI_PERPETUAL` |
| `serverTime` in exchangeInfo | `1789008009026` (stale) | `1789440582684` |

- `BTCUSDT`/`ETHUSDT`**are** present and TRADING on testnet (`VERIFIED`, live).
- Testnet **lacks** `LDUSDT` and `RWUSD` assets that production has; it carries `PIPPIN` and `B2` as assets.
- Testnet carries a `CURRENT_QUARTER DELIVERING` contract type that production does not (CM/UM architecture integration leftovers).
- Testnet non-TRADING examples observed: `EOSUSDT=SETTLING OMGUSDT=PENDING_TRADING WAVESUSDT=SETTLING MKRUSDT=SETTLING DEFIUSDT=PENDING_TRADING BALUSDT=PENDING_TRADING FTMUSDT=SETTLING FLMUSDT=PRE_SETTLE`.
- `1000PEPEUSDT` exists on both. Do not assume production symbols are all available — always read `exchangeInfo` from the testnet host.

### 3.3 Rate limits — testnet is MORE permissive on IP weight  `VERIFIED` (live)

`exchangeInfo.rateLimits`:
```
demo-fapi / testnet.binancefuture.com:
  REQUEST_WEIGHT: limit 6000 / 1 MINUTE
  ORDERS:         limit 1200 / 1 MINUTE
  ORDERS:         limit  300 / 10 SECOND
fapi.binance.com:
  REQUEST_WEIGHT: limit 2400 / 1 MINUTE
  ORDERS:         limit 1200 / 1 MINUTE
  ORDERS:         limit  300 / 10 SECOND
```
Independently confirmed on the **WS API** by the live `rateLimits` block returned from a `time` request: `"limit":6000` on `wss://testnet.binancefuture.com/ws-fapi/v1` vs `"limit":2400` on `wss://ws-fapi.binance.com/ws-fapi/v1`.
→ **Testnet allowance is 2.5× production for `REQUEST_WEIGHT`; ORDER limits are identical.** (The legacy WS-API doc example responses show `"limit": 2400`, i.e. they document production values.) Ban escalation semantics (`429` → `418`, 2 min to 3 days) are documented for production and not separately documented for testnet → `UNVERIFIED` for testnet specifically.

### 3.4 Funding rate / mark price / index price realism — PARTIALLY realistic  `VERIFIED` (live)

Live snapshot (same instant, `2026-09-15T13:28:58Z`, `time:1789478938000` both):

| field | production `fapi` | testnet/demo |
|---|---|---|
| `markPrice` | `76952.90000000` | `76910.22899209` |
| `indexPrice` | `76974.32826087` | **`76974.32826087` (identical)** |
| `estimatedSettlePrice` | `76991.35887609` | `76991.39638853` (≈identical) |
| `lastFundingRate` | `0.00008784` | **`0.00010000`** |
| `interestRate` | `0.00010000` | `0.00010000` |
| `nextFundingTime` | `1789488000000` | `1789488000000` |

`fundingRate` history, last 3, `BTCUSDT`:
```
PROD    : [{"symbol":"BTCUSDT","fundingTime":1789401600000,"fundingRate":"0.00004220","markPrice":"78543.10000000","rateType":"Regular"},
           {"symbol":"BTCUSDT","fundingTime":1789430400000,"fundingRate":"0.00003563","markPrice":"78178.30000000","rateType":"Regular"},
           {"symbol":"BTCUSDT","fundingTime":1789459200005,"fundingRate":"0.00006188","markPrice":"76907.97183333","rateType":"Regular"}]
TESTNET : [{"symbol":"BTCUSDT","fundingTime":1789401600000,"fundingRate":"0.00007617","markPrice":"78550.02869565"},
           {"symbol":"BTCUSDT","fundingTime":1789430400000,"fundingRate":"0.00010000","markPrice":"78149.51586957"},
           {"symbol":"BTCUSDT","fundingTime":1789459200000,"fundingRate":"0.00010000","markPrice":"76890.70135870"}]
```
Findings:
- **Index price mirrors production exactly**; **mark price tracks but is offset** (testnet mark `76910.23` vs prod `76952.90` ≈ −0.055%). `estimatedSettlePrice` near-identical.
- **Funding on testnet is effectively pinned at the 0.01% baseline** (`0.00010000` = `interestRate`), whereas production funding is market-driven and varied (`0.00004220`, `0.00003563`, `0.00006188`). Live `premiumIndex.lastFundingRate` on testnet read `0.00010000` in every sample taken.
- **Testnet `fundingRate` history is missing the `rateType` field** that production now returns (added per change-log `2026-07-23`: `The response now includes a new field rateType (STRING)`). → **Testnet lags production API schema.**

### 3.5 Liquidity / volume — misleading, thin real book  `VERIFIED` (live)

`GET /fapi/v1/ticker/24hr?symbol=BTCUSDT`:
```
PROD    lastPrice=76953.00  quoteVolume=13247273482.20       count=3463597  high=79570.90  low=76667.30
TESTNET lastPrice=76900.00  quoteVolume=114249634312.95      count=334087   high=79542.00  low=76695.90
```
- **Testnet `quoteVolume` is 8.6× HIGHER than production** (`114.2B` vs `13.2B`) while **trade count is 10× LOWER** (`334,087` vs `3,467,597`). → **`quoteVolume`/`volume` on testnet is not a usable liquidity signal.**
- `openInterest` on testnet is `"405585841.9297"` vs production `"106269.634"` — a ~3,800× scale difference for the same `BTCUSDT` symbol → **OI is synthetic/not economically meaningful.**
- Top-of-book `depth` (limit=5): `PROD bestBid=76952.90 x 0.159 | bestAsk=76953.00 x 11.879` vs `TESTNET bestBid=76883.20 x 132.4608 | bestAsk=76899.90 x 0.0254` → spreads are wider and the book is erratic/one-sided. **Assume worse effective liquidity and slippage than production, and never calibrate strategy sizing off testnet `quoteVolume`.**

### 3.6 `/sapi/*`, wallet, transfer — see 3.1. NOT available.  `VERIFIED`

### 3.7 User data stream / `listenKey` — EXISTS  `VERIFIED` (live)

```
GET  https://demo-fapi.binance.com/fapi/v1/listenKey              => HTTP 404  (method must be POST)
POST https://demo-fapi.binance.com/fapi/v1/listenKey              => HTTP 401
POST https://testnet.binancefuture.com/fapi/v1/listenKey          => HTTP 401
POST https://fapi.binance.com/fapi/v1/listenKey                   => HTTP 401
```
A `401` (not `404`) proves the route exists and is gated on `X-MBX-APIKEY` — identically on demo, testnet and production. `GET` is `404` (correct method is POST/PUT/DELETE).
- CCXT and both official Python SDKs implement `new_listen_key`/`renew`/`close` for UM futures; the new SDK's `clients/derivatives_trading_usds_futures/.../rest_api/api/user_data_streams_api.py` covers it.
- Testnet WS base for user data under the new scheme: `wss://fstream.binancefuture.com/private/ws?listenKey=<listenKey>&events=ORDER_TRADE_UPDATE` (routed form). `LIVE-OBSERVED` that `/private/ws?listenKey=fake` on demo-fstream did **not** complete within the window (inconclusive — fake key and/or proxy). Mark as `UNVERIFIED` for the exact testnet private URL; the mechanism exists.
- Cannot create a real listenKey (no API keys) → **end-to-end listenKey flow is `UNVERIFIED`; the endpoint and protocol are `VERIFIED`.**

### 3.8 WebSocket API on testnet — AVAILABLE  `VERIFIED` (live, handshake + round-trip)
See §1.3. Full request/response worked: `{"id":"p2","method":"time","params":{}}` → `{"id":"p2","status":200,"result":{"serverTime":1789478708148},"rateLimits":[...]}`.
Legacy docs confirm "Most of the endpoints can be used in the testnet platform" and give the testnet WS API base. **Only Ed25519 keys are supported for `session.logon`** on the WS API (doc exact string: `Only *Ed25519* keys are supported for this feature.`).

### 3.9 `exchangeInfo.serverTime` is a stale cached snapshot on testnet  `VERIFIED` (live)
```
HOST https://testnet.binancefuture.com
  exchangeInfo.serverTime=1789008009026 -> 2026-09-10 02:40:09Z   (STALE)
  /fapi/v1/time.serverTime=1789478942161 -> 2026-09-15 13:29:02Z
HOST https://demo-fapi.binance.com
  exchangeInfo.serverTime=1789008009026 -> 2026-09-10 02:40:09Z   (SAME stale value)
HOST https://fapi.binance.com
  exchangeInfo.serverTime=1789440582684 -> 2026-09-15 02:49:42Z
```
→ ~5.4 days stale on testnet, and byte-identical across the two hostnames (further proof of one shared backend). **Use `/fapi/v1/time`, not `exchangeInfo.serverTime`.**

### 3.10 Two distinct environments: TESTNET vs DEMO (both exist)  `VERIFIED`
Confirmed platform-wide by official SDK constants:
```python
SPOT_REST_API_TESTNET_URL = "https://testnet.binance.vision"
SPOT_REST_API_DEMO_URL    = "https://demo-api.binance.com"
SPOT_WS_API_TESTNET_URL   = "wss://ws-api.testnet.binance.vision/ws-api/v3"
SPOT_WS_API_DEMO_URL      = "wss://demo-ws-api.binance.com/ws-api/v3"
SPOT_WS_STREAMS_TESTNET_URL = "wss://stream.testnet.binance.vision"
SPOT_WS_STREAMS_DEMO_URL    = "wss://demo-stream.binance.com:9443"
```
`LIVE-OBSERVED`: `https://demo-api.binance.com/api/v3/time` → `200 {"serverTime":1789478957433}`; `https://testnet.binance.vision/api/v3/time` → `200 {"serverTime":1789478957950}`; `https://demo-api.binance.com/api/v3/ping` → `200 {}`.

**CCXT models these as mutually exclusive modes** (`js/src/binance.js`):
```js
3114: enableDemoTrading(enable) {
3115:     if (this.isSandboxModeEnabled) {
3116:         throw new NotSupported(this.id + ' demo trading is not supported in the sandbox environment. Please check https://www.binance.com/en/support/faq/detail/9be58f73e5e14338809e3b705b9687dd to see the differences');
3117:     }
3118:     if (enable) {
3119:         this.urls['apiBackupDemoTrading'] = this.urls['api'];
3120:         this.urls['api'] = this.urls['demo'];
...
3127:     this.options['enableDemoTrading'] = enable;
```
```
3443: const sandboxMode = this.safeBool(this.options, 'sandboxMode', false);
3444: const demoMode = this.safeBool(this.options, 'enableDemoTrading', false);
3445: const isDemoEnv = (demoMode === true) || (sandboxMode === true);
3449: if (type === 'option' && (isDemoEnv === true)) { continue; }        // options unsupported in demo
3459: if ((fetchMargins === true) && ... && (isDemoEnv !== true)) { ... }  // margin sapi skipped in demo
13340: if ((url.indexOf('testnet.binancefuture.com') > -1) && this.isSandboxModeEnabled && ...) { <warning> }
```
→ CCXT: **`sandbox`/`setSandboxMode()` = testnet (`testnet.binancefuture.com`); `enableDemoTrading()` = demo (`demo-fapi.binance.com`); they are mutually exclusive, and demo does not support options or margin/sapi.**
Caveat: `js/src/binance.js` and `ts/src/binance.ts` contain **no** `wss://` strings, no `demo-fstream`, no `stream.binancefuture`, no `ws-fapi` (grepped full files) → **CCXT does not hardcode these WS URLs in the Binance class; do not cite CCXT for WS testnet URLs.** `SINGLE-SOURCE`/negative finding.

### 3.11 Endpoint surface observed on `demo-fapi` (live probe, `LIVE-OBSERVED`)

| Endpoint | Status | Meaning |
|---|---|---|
| `/fapi/v1/ping`, `/fapi/v1/time` | 200 | live |
| `/fapi/v1/exchangeInfo` | 200 | live (stale serverTime) |
| `/fapi/v1/premiumIndex`, `/ticker/24hr`, `/openInterest`, `/fundingRate`, `/depth`, `/klines`, `/continuousKlines` | 200 | live |
| `/fapi/v1/indexInfo`, `/fapi/v1/insuranceBalance`, `/fapi/v1/constituents?symbol=BTCUSDT` | 200 | live (unauthenticated market data) |
| `/fapi/v1/indexPriceKlines` (via `continuousKlines`) | 200 | live |
| `/futures/data/*` (`openInterestHist`) | 200 on `demo-fapi` | see malformed-body note below |
| `/fapi/v1/assetIndex?symbol=BTCUSDT` | 400 | bad request as called |
| `/fapi/v1/listenKey` (GET) | 404 | wrong method |
| `/fapi/v1/balance`, `/fapi/v1/positionRisk` | 404 | wrong version — use `/fapi/v2|v3/...` |
| `/fapi/v1/positionRisk` (on testnet host too) | 404 | same |
| `/fapi/v1/pmExchangeInfo`, `/fapi/v1/portfolioMarginExchangeInfo` | 404 | deprecated/absent |
| `/fapi/v2/account`, `/fapi/v3/balance`, `/fapi/v1/income`, `/fapi/v1/leverageBracket`, `/fapi/v1/commissionRate`, `/fapi/v1/positionSide/dual`, `/fapi/v1/multiAssetsMargin`, `/fapi/v1/feeBurn`, `/fapi/v1/accountConfig`, `/fapi/v1/symbolConfig`, `/fapi/v1/rateLimit/order`, `/fapi/v1/apiTradingStatus`, `/fapi/v1/adlQuantile`, `/fapi/v1/order/asyn` | **401** | **route exists, needs a valid API key** |
| `/sapi/v1/*` | **403** | not supported |
| `/fapi/v1/convert/exchangeInfo` | **500** | present but erroring on demo |

**Malformed-body anomaly (`LIVE-OBSERVED`, `UNVERIFIED` cause):** `GET https://demo-fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=2` → `HTTP 200` with body observed literally as `111 107` (looks like un-decoded chunked-transfer framing) while the same call on `https://fapi.binance.com` returns proper JSON:
```
[{"symbol":"BTCUSDT","sumOpenInterest":"106289.69300000","sumOpenInterestValue":"8175197334.30990000","CMCCirculatingSupply":"20084481.00000000","timestamp":1789478400000}, ...]
```
Same testnet path with `&contractType=PERPETUAL` → `HTTP 202` (WAF). **Treat testnet `/futures/data/*` as unreliable; do not use it for strategy research.**

---

## 4. Task 4 — raw HTTP evidence (exact bodies, exact status)

All observed `2026-09-15T13:18:38Z–13:18:45Z` (`Date: Tue, 15 Sep 2026 ... GMT`, `Server: nginx`, `Access-Control-Allow-Origin: *` on all four).

| URL | Status | Raw body |
|---|---|---|
| `https://demo-fapi.binance.com/fapi/v1/ping` | **200 OK** | `{}` |
| `https://demo-fapi.binance.com/fapi/v1/time` | **200 OK** | `{"serverTime":1789478319422}` |
| `https://fapi.binance.com/fapi/v1/time` | **200 OK** | `{"serverTime":1789478319738}` |
| `https://testnet.binancefuture.com/fapi/v1/ping` | **200 OK** | `{}` |
| `https://testnet.binancefuture.com/fapi/v1/time` | **200 OK** | `{"serverTime":1789478325920}` |

`web_fetch` independently reproduced the same (its own timestamps):
```
https://demo-fapi.binance.com/fapi/v1/ping  -> HTTP 200, body: {}
https://demo-fapi.binance.com/fapi/v1/time  -> HTTP 200, body: {"serverTime":1789478308441}
https://fapi.binance.com/fapi/v1/time       -> HTTP 200, body: {"serverTime":1789478307906}
https://testnet.binancefuture.com/fapi/v1/ping -> HTTP 200, body: {}
```

**Conclusion for task 4: `https://demo-fapi.binance.com` definitively RESPONDS — `200 OK`, valid JSON, CORS-open, and confirmed twice by two independent clients.** It is not a dead/misleading doc value. The same holds for `https://testnet.binancefuture.com` (REST). `clientOffset` between the two `/time` responses was ~6.5 s at first sample (different nodes), then ~1.1 s later — node skew, not a different clock.

---

## 5. Cross-check: exact strings in source code

### 5.1 CCXT (`github.com/ccxt/ccxt`, master, retrieved 2026-09-15)
Files: `js/src/binance.js` (805,241 B), `ts/src/binance.ts` (828,661 B), `js/src/binanceusdm.js` (2,951 B), `js/src/abstract/binance.js` (488 B — re-export stub only).

```
js/src/binance.js:201  'dapiPublic': 'https://testnet.binancefuture.com/dapi/v1',
js/src/binance.js:204  'fapiPublic': 'https://testnet.binancefuture.com/fapi/v1',
js/src/binance.js:209  'fapiPrivateV3': 'https://testnet.binancefuture.com/fapi/v3',
js/src/binance.js:215  'dapiPublic': 'https://demo-dapi.binance.com/dapi/v1',
js/src/binance.js:218  'demo': {
js/src/binance.js:222  'fapiPublic': 'https://demo-fapi.binance.com/fapi/v1',
js/src/binance.js:224  'public': 'https://demo-api.binance.com/api/v3',
js/src/binance.js:230  'v1': 'https://demo-api.binance.com/api/v1',
js/src/binance.js:13340 if ((url.indexOf('testnet.binancefuture.com') > -1) && this.isSandboxModeEnabled && (this.safeBool(this.options, 'disableFuturesSandboxWarning') !== true)) {
js/src/binance.js:13460 if (url.startsWith('https://api.' + hostname + '/') || url.startsWith('https://demo-api') || url.startsWith('https://testnet.binance.vision')) {
js/src/binance.js:13463 else if (url.startsWith('https://dapi.' + hostname + '/') || url.startsWith('https://demo-dapi') || url.startsWith('https://testnet.binancefuture.com/dapi')) {
js/src/binance.js:13466 else if (url.startsWith('https://fapi.' + hostname + '/') || url.startsWith('https://demo-fapi') || url.startsWith('https://testnet.binancefuture.com/fapi')) {
js/src/binance.js:3111 * @see https://demo.binance.com/en/my/settings/api-management
js/src/binance.js:3184 // demotrading does not support sapi endpoints
```
**Negative results (grepped full files):** no match for `demo-fstream`, `stream.binancefuture`, `fstream.binance`, `ws-fapi`, `ws-dapi`, `wss://`, `faucet`.
→ `tests/` URLs live under `urls['test']`; demo under `urls['demo']`; `'sandbox': true` in `has`; `'sandboxMode': false` default in `options`.

### 5.2 `binance-futures-connector-python` (legacy connector, branch `main`)
- `binance/um_futures/__init__.py`: `kwargs["base_url"] = "https://fapi.binance.com"` — **no testnet constant at all.**
- `binance/api.py:18`: `base_url (str, optional): the API base url, useful to switch to testnet, etc. By default it's https://api.binance.com`
- `README.md:78-80`: `For USDT-M Futures, if base_url is not provided, it defaults to fapi.binance.com.` / `It's recommended to pass in the base_url parameter, even in production as Binance provides alternative URLs`
- `binance/websocket/um_futures/__init__.py` → **HTTP 200, 0 bytes** (empty file in repo).
→ **`SINGLE-SOURCE`/negative: this legacy connector hardcodes no testnet URL; you must pass `base_url` yourself (e.g. `https://demo-fapi.binance.com`).**

### 5.3 `binance-connector-python` (new official SDK, branch `master`) — BEST SOURCE
File `common/src/binance_common/constants.py` (full constant list reproduced in §3.10 / §1.1 / §1.2 / §1.3). Key exact lines:
```
65: DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL = "https://fapi.binance.com"
66: DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL = (
67:     "https://testnet.binancefuture.com"
68: )
69: DERIVATIVES_TRADING_USDS_FUTURES_REST_API_DEMO_URL = "https://demo-fapi.binance.com"
70: DERIVATIVES_TRADING_USDS_FUTURES_WS_API_PROD_URL = (
71:     "wss://ws-fapi.binance.com/ws-fapi/v1"
72: )
73: DERIVATIVES_TRADING_USDS_FUTURES_WS_API_TESTNET_URL = (
74:     "wss://testnet.binancefuture.com/ws-fapi/v1"
75: )
76: DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL = "wss://fstream.binance.com"
77: DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL = (
78:     "wss://fstream.binancefuture.com"
79: )
```
Note: **there is no `..._WS_STREAMS_DEMO_URL` for USDS futures in this file** (spot has demo URLs, derivatives REST has a demo URL, but derivatives WS streams/demo WS API constants are absent). Grep for `demo-fstream` in this file → **no match**.
`clients/derivatives_trading_usds_futures/README.md:144-157` — `#### Testnet`, exact: `For testing purposes, /fapi/* endpoints can be used in the [Futures Testnet](https://testnet.binance.vision/). Update the base_path in your configuration:` with `base_path=DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL`, and `If base_path is not provided, it defaults to https://fapi.binance.com.` ⚠️ **Note this README's link points at `https://testnet.binance.vision/` (SPOT testnet) — a doc bug in Binance's own SDK README.**

### 5.4 Binance docs (static legacy mirror — works; new docs are JS-rendered and empty)
- General Info: <https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/general-info>
- WS API General Info: <https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/websocket-api-general-info>
- WS Market Streams (Connect): <https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams>
- Important WebSocket Change Notice: <https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice>
- Quick Start ("Futures Testnet", verbatim quote in §2.1): <https://developers.binance.com/legacy-docs/derivatives/quick-start>
- Change Log (latest entry `## 2026-09-10`): <https://developers.binance.com/legacy-docs/derivatives/change-log>
- All pages footer: `Copyright © 2026 Binance.`, banner: `⚠️ You are viewing the legacy Binance API documentation. The new documentation is now the default and is actively maintained.`

---

## 6. Bottom line / recommended config

```yaml
# USDⓈ-M Futures TESTNET / DEMO — as of 2026-09-15
rest_base:      https://demo-fapi.binance.com      # docs-canonical; VERIFIED live 200
rest_alt:       https://testnet.binancefuture.com  # identical backend; VERIFIED live 200
market_ws:      wss://demo-fstream.binance.com     # docs testnet WS base; VERIFIED live
market_ws_alt:  wss://fstream.binancefuture.com    # official new Python SDK testnet WS base; VERIFIED live
market_ws_old:  wss://stream.binancefuture.com     # old generation; still live but riskiest
ws_api:         wss://testnet.binancefuture.com/ws-fapi/v1   # VERIFIED handshake + round-trip
cm_testnet_streams: wss://dstream.binancefuture.com         # VERIFIED live
# Use NEW routed paths where possible:
#   wss://<testnet-stream-host>/market/ws/<stream>      e.g. btcusdt@markPrice, btcusdt@aggTrade
#   wss://<testnet-stream-host>/public/ws/<stream>      e.g. btcusdt@depth, btcusdt@bookTicker
#   wss://<testnet-stream-host>/private/ws?listenKey=..&events=ORDER_TRADE_UPDATE
# Do NOT use:  wss://demo-fstream.binance.com/ws-fapi/v1   (404)
#              wss://testnet.binancefuture.com/ws/<stream> (WAF 202, never completes)
#              https://testnet.binancefuture.com/futures/data/* (WAF 202) — use demo-fapi
# API keys:    https://demo.binance.com/  -> API Management (only a Binance account needed)
# Virtual USDT: https://demo.binance.com/ -> Assets -> Reset  (no faucet URL exists in current docs)
```

**Highest-value gotchas**
1. `demo-fapi` and `testnet.binancefuture.com` are the same exchange right now — two hostnames, one stale-cached `exchangeInfo`.
2. **`wss://demo-fstream.binance.com/ws-fapi/v1` is 404** — the docs' *REST* testnet host shares a name with the *market-stream* host, but the *WS API* host is `testnet.binancefuture.com`.
3. `wss://testnet.binancefuture.com/ws/<stream>` (market streams) is WAF-blocked; only `/ws-fapi/v1` works on that host.
4. Unrouted WS connections now only get `/public` data on production (decommissioned 2026-04-23); the testnet stream hosts are laxer but do not rely on it.
5. `quoteVolume` and `openInterest` on testnet are not meaningful; funding is pinned at 0.01%; `exchangeInfo.serverTime` is days stale; `/sapi/*` is 403.
6. Testnet `REQUEST_WEIGHT` is 6000/min vs production 2400/min.
