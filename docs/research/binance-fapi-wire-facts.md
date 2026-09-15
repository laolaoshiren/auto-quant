# Binance USDⓈ-M Futures (fapi) — wire-level facts

Research date: **2026-09-15** (env UTC `2026-09-15 13:25:38`). All facts below are from Binance-controlled
sources unless marked otherwise. No application code written.

## 0. Source-access notes (important, changes what you can trust)

| Source | Status |
|---|---|
| `https://developers.binance.com/legacy-docs/derivatives/...` | **WORKS** (static HTML, legacy mirror) |
| `https://developers.binance.com/en/docs/...` (new docs) | **HTTP 202, empty body** — bot-protected, unusable via any client |
| `https://developers.binance.com/en/docs/llms-full.txt` | **WORKS — 8,229,908 bytes static plain-text dump of the ENTIRE new docs.** Best single source. Saved to `_research/llms-full.txt` |
| `https://developers.binance.com/en/docs/llms.txt` | **WORKS — 172,570 bytes** index. Saved to `_research/llms.txt` |
| `https://www.binance.com/en/support/announcement/...` | **HTTP 202, empty body** |
| `https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query?articleCode=<code>` | **WORKS — returns the full announcement body as JSON** |

New-docs doc boundaries inside `llms-full.txt` (line numbers, 1-based):
- USDⓈ-M futures general-info: `51666–52132`
- USDⓈ-M futures error-code: `52133–53045`
- USDⓈ-M futures change-log: `53365–57318`
- Spot REST general info: `21883–…`
- common/derivatives-trading change-log: `168440–172393`

### On the "implausible future dates"
The change log's newest entry is `## 2026-09-15` (new docs) / `## 2026-09-10` (legacy mirror). **These are not
implausible: the environment's current date is 2026-09-15 UTC, and Binance's own live CMS returns articles
dated 2026-09-14** (e.g. `releaseDate 1789378206783` → `2026-09-14 09:30:06 UTC`). The docs are live and current.
Side note: the **legacy mirror lags the new docs by at least one entry** (legacy newest = 2026-09-10; new = 2026-09-15).

---

## 1. The 2024-09-03 API update — what actually changed

Announcement: `articleCode 19d4e3cd0758426584dd9686eb56ec64`, CMS `id 207263`,
title `Notice on Upcoming Binance API Update (2024-09-03)`, `publishDate 1722927604168` = **2024-08-06 07:00:04 UTC**.
URL: https://www.binance.com/en/support/announcement/notice-on-upcoming-binance-api-update-2024-09-03-19d4e3cd0758426584dd9686eb56ec64

Verbatim flattened body (structural text preserved; tables flattened to `A | B | Current 5 | New 10`):

> Fellow Binancians,
> Binance will update the Request Weight Adjustments and WebSocket User Data Requests from **2024-09-03 06:00 (UTC).**
> **Key Changes**
> 1. **Request Weight Adjustments (Effective from 2024-09-03)**
>
> | | | Current | New |
> |---|---|---|---|
> | REST API | WebSocket API | 5 | 10 |
> | `GET /fapi/v2/balance` | `account.balance` | | |
> | `GET /fapi/v2/account` | `account.status` | | |
> | `GET /fapi/v2/positionRisk` | `account.position` | | |
>
> 2. **Deprecation of WebSocket User Data Requests (Effective from 2024-09-03)**
> The following WebSocket User Data Requests will be deprecated:
> - `<listenKey>@account`: USDⓈ-M Futures: Documentation / COIN-M Futures: Documentation
> - `<listenKey>@balance`: USDⓈ-M Futures: Documentation / COIN-M Futures: Documentation
> - `<listenKey>@position`: USDⓈ-M Futures: Documentation / COIN-M Futures: Documentation
>
> **Recommended Actions**
> For COIN-M Futures, users are still recommended to use existing API to query: `GET /dapi/v1/account`,
> `GET /dapi/v1/balance`, `GET /dapi/v1/positionRisk`.
> For USDⓈ-M Futures, users are encouraged to switch to the following updated version endpoints…
> **REST API** — New Endpoints to Query Account Information:
> - `GET /fapi/v1/symbolConfig`: Query user symbol configuration.
> - `GET /fapi/v1/accountConfig`: Query user account configuration.
> - `GET /fapi/v3/account`: **Replacement of `GET /fapi/v2/account`.** This endpoint only returns symbols that the user has positions or open orders in. Configuration-related fields have been removed and can now be queried from `GET /fapi/v1/symbolConfig` and `GET /fapi/v1/accountConfig`. The V3 endpoint also offers better performance.
> - `GET /fapi/v3/balance`: **Replacement of `GET /fapi/v2/balance`.** Query user account balance.
> New Endpoints to Query Trade Information:
> - `GET /fapi/v3/positionRisk`: **Replacement of `GET /fapi/v2/positionRisk`.** This endpoint only returns symbols that the user has positions or open orders in. Configuration-related fields have been removed and can now be queried from `GET /fapi/v1/symbolConfig`. The V3 endpoint also offers better performance.
> **WebSocket API** — New Endpoints to Query Account Information:
> - `v2/account.status`: Replacement of `account.status`…
> - `v2/account.balance`: Replacement of `account.balance`. Query user account balance.
> - `v2/account.position`: Replacement of `account.position`…
> Note: There may be discrepancies in the translated version of this original article in English…
> Binance Team **2024-08-06**
> *Note: This announcement was updated on 2024-08-29 to add API Doc redirect links and to emphasize that the deprecation of this interface applies to both USDⓈ-M and COIN-M Futures.*

### NEGATIVE findings — what the 2024-09-03 announcement does NOT contain
Programmatic checks over the full flattened body: **zero** occurrences of
`selfTradePreventionMode`, `Self-Trade`, `STP`, `TRADE_LITE`, `X-MBX`, `Retry-After`, `removed`,
`EXPIRE_TAKER`, `rate limit header`.

So, concretely, for 2024-09-03:
- **New endpoints:** none new on 2024-09-03. The announcement only *redirects* users to endpoints already
  shipped on 2024-07-24 (`/fapi/v3/account`, `/fapi/v3/balance`, `/fapi/v3/positionRisk`,
  `/fapi/v1/symbolConfig`, `/fapi/v1/accountConfig`; WS `v2/account.status|balance|position`).
- **Deprecations:** only the three WS user-data *requests* `<listenKey>@account|@balance|@position` (UM **and** CM).
- **Removed params:** none mentioned.
- **Self-trade prevention:** **not** part of this update. (USDⓈ-M STP was announced in the change log on
  **2023-08-29** as `**Self-Trade Prevention(Release Date TBD)**` and never got its own dated UM release entry;
  COIN-M STP entry is **2024-10-11**, Portfolio-Margin **2024-01-11**, Options **2026-03-11** effective 2026-03-19.)
- **New rate limit headers:** none. `X-MBX-USED-WEIGHT-*` / `X-MBX-ORDER-COUNT-*` predate 2024 (spot change log:
  2020-12-16-era entries `New Headers X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)…`, `New Header
  X-MBX-ORDER-COUNT-(intervalNum)(intervalLetter)…`).
- **Weight changes:** only these → `GET /fapi/v2/balance`, `GET /fapi/v2/account`, `GET /fapi/v2/positionRisk`
  REST `5 -> 10`, and WS `account.status`, `account.balance`, `account.position` `5 -> 10`, effective 2024-09-03.
- **TRADE_LITE:** comes from the **change log**, not the announcement. Change log `## 2024-09-03`, USDⓈ-M Futures,
  verbatim (identical in legacy and new docs):
  > User data stream will add `TRADE_LITE` event. `TRADE_LITE` event designed to reduce user data latency by
  > focusing solely on 'TRADE' execution type and minimizing the number of user data fields, providing a faster
  > and more efficient experience compared to the original `ORDER_TRADE_UPDATE` user data stream.

Corroborating change-log entry `## 2024-08-07` (verbatim):
> - The following endpoints IP weight limit will be adjusted from 2024-09-03:
>   - REST API:
>     - `GET /fapi/v2/balance`: 5->10
>     - `GET /fapi/v2/account`: 5->10
>     - `GET /fapi/v2/positionRisk`: 5->10
>   - Websocket API:
>     - `account.status`: 5->10
>     - `account.balance`: 5->10
>     - `account.position`: 5->10
> - The following WebSocket User Data Requests will be deprecated from 2024-09-03
>   - `<listenKey>@account` / `<listenKey>@balance` / `<listenKey>@position`
> Please refer to the corresponding Binance announcement for api replacement

Deprecation confirmation: change log `## 2024-09-27` — "The following websocket user data requests are
deprecated: `listenkey@account`, `listenkey@balance`, `listenkey@position`" (UM **and** CM).

Confidence: **VERIFIED for the announcement content** (CMS JSON body + the 2024-08-07 change-log entry agree).
**VERIFIED as a negative** for STP/TRADE_LITE/rate-limit-header content (CMS body + change log agree).

---

## 2. RSA / Ed25519 / HMAC signing on USDⓈ-M futures REST

### Exact strings (identical on the legacy page and in the new-docs dump → 2 mirrors, 1 document)
- API key header: **`X-MBX-APIKEY`**
  > API-keys are passed into the Rest API via the `X-MBX-APIKEY` header.
- Signature transport:
  > `SIGNED` endpoints require an additional parameter, `signature`, to be sent in the `query string` or
  > `request body`.
  > The `signature` is **not case sensitive**.
  > Please make sure the `signature` is the end part of your `query string` or `request body`.
  > `totalParams` is defined as the `query string` concatenated with the `request body`.
- Default scheme stated in the SIGNED section:
  > Endpoints use `HMAC SHA256` signatures. The `HMAC SHA256 signature` is a keyed `HMAC SHA256` operation.
  > Use your `secretKey` as the key and `totalParams` as the value for the HMAC operation.
- HMAC worked example (query string, signature last):
  ```
  curl -H "X-MBX-APIKEY: dbefbc809e3e83c283a984c3a1459732ea7db1360ca80c5c2c8867408d28cc83" -X POST \
   'https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943&signature=3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9'
  ```
  (HMAC digest = lowercase hex, 64 chars.)
- RSA section heading: `### SIGNED Endpoint Examples for POST /fapi/v1/order - RSA Keys`
  > - We support `PKCS#8` currently.
  > - To get your API key, you need to upload your RSA Public Key to your account and a corresponding API key will be provided for you.
  > 2.2 - Sign payload using RSASSA-PKCS1-v1_5 algorithm with SHA-256 hash function.
  > 2.3 - Encode output as base64 string.
  > 2.4 - Delete any newlines in the signature.
  > 2.5 - Since the signature may contain `/` and `=`, this could cause issues with sending the request. So the signature has to be URL encoded.
  Shell: `openssl dgst -keyform PEM -sha256 -sign ./test-prv-key.pem | openssl enc -base64 | tr -d '\n'`, then `rawurlencode`.
  Final call still puts `signature` in the **query string** with `X-MBX-APIKEY`:
  ```
  curl -H "X-MBX-APIKEY: vE3BDAL1gP1UaexugRLtteaAHg3UO8Nza20uexEuW1Kh3tVwQfFHdAiyjjY428o2" -X POST \
   'https://fapi.binance.com/fapi/v1/order?timestamp=1671090801999&recvWindow=9999999&symbol=BTCUSDT&side=SELL&type=MARKET&quantity=1.23&signature=aap36wD5loVXizxvvPI3wz9Cjqwmb3KVbxoym0XeWG1jZq8umqrnSk8H8dkLQeySjgVY91Ufs%2BBGCW%2B4sZjQEpgAfjM76riNxjlD3coGGEsPsT2lG39R%2F1q72zpDs8pYcQ4A692NgHO1zXcgScTGgdkjp%2Brp2bcddKjyz5XBrBM%3D'
  ```
  URL-encoded `+` becomes `%2B`, `=` becomes `%3D`, `/` becomes `%2F`.

### Differences RSA vs Ed25519 vs HMAC (futures scope)
| | HMAC SHA256 | RSA | Ed25519 |
|---|---|---|---|
| Documented in **fapi REST** general-info | YES (default SIGNED scheme) | YES (worked example, PKCS#8, RSASSA-PKCS1-v1_5/SHA-256) | **NO — zero occurrences of "Ed25519" anywhere in the USDⓈ-M futures REST general-info** |
| Signature encoding | lowercase hex (64 chars) | base64 → URL-encoded | (n/a for fapi REST) |
| Case sensitivity | "The `signature` is **not case sensitive**." | not stated | (n/a) |
| Transport | `signature` param, query string or request body | `signature` param, query string or request body | (n/a) |
| API key header | `X-MBX-APIKEY` | `X-MBX-APIKEY` | (n/a) |

- **Ed25519 for USDⓈ-M is documented only for the WebSocket API**, under
  `## WebSocket API Authentication request` → `### Log in with API key (SIGNED)`:
  > **Note**: Only _Ed25519_ keys are supported for this feature.
  with body `{"id":"…","method":"session.logon","params":{"apiKey":"…","signature":"1cf54395b336b0a9727ef27d5d98987962bc47aca6e13fe978612d0adee066ed","timestamp":1649729878532}}`, weight 2.
  Also `Only Ed25519 keys are allowed.` (WS-API auth section) and `> Only _Ed25519_ keys are supported for this feature.`
  (WS-API general info line 50955). Signature is **base64** of Ed25519 sign over the alphabetically-sorted param string.
- Do **not** import the spot FAQ into fapi: `/products/spot/faqs/api_key_types` says
  "We support several types of API keys: Ed25519 (recommended) / HMAC / RSA", "**HMAC keys are deprecated.**",
  "We support 2048 and 4096 bit RSA keys." — that FAQ is **spot-scoped**, and its "Sample Ed25519 signature"
  is base64 while its "Sample HMAC signature" is hex.

Confidence: `X-MBX-APIKEY` + `signature`-in-query/body = **VERIFIED** (legacy page + new-docs dump; same text).
RSA algorithm/encoding details = **SINGLE-SOURCE** (only Binance's own worked example; no second independent doc).
"Ed25519 not documented for fapi REST" = **VERIFIED negative** (legacy page + new-docs dump + full-corpus grep).

---

## 3. `X-MBX-TIME-UNIT` — does it exist for USDⓈ-M futures?

**Answer: NOT DOCUMENTED for fapi. Marked UNVERIFIED for futures.** It is a **Spot-only** documented feature.

Evidence:
- Full-corpus grep of the 8.2 MB new-docs dump: `X-MBX-TIME-UNIT` occurs **exactly 6 times, in 2 documents, both Spot**:
  - `/products/spot/rest-api` (line 21908): `All time and timestamp related fields in the JSON responses are in **milliseconds by default.** To receive the information in microseconds, please add the header `X-MBX-TIME-UNIT:MICROSECOND` or `X-MBX-TIME-UNIT:microsecond`.`
  - Spot testnet REST (line 117245): same sentence.
- **Zero** occurrences in the USDⓈ-M futures docs (lines 50720–57318) and **zero** in the common derivatives docs
  (168371–179600). Range-greps for `micro|Micro|timeUnit|TIME-UNIT` over those ranges returned **no matches at all**.
- Origin = Spot change log `### 2024-12-17`:
  > **New Feature: Microsecond support** … Microsecond support is **opt-in**, by default the requests and responses still use milliseconds.
  > REST API — A new optional header `X-MBX-TIME-UNIT` can be sent in the request to select the time unit.
  > Supported values: `MILLISECOND` / `millisecond` / `MICROSECOND` / `microsecond`
  > - The time unit affects timestamp fields in JSON responses (e.g., `time`, `transactTime`).
  > - SBE responses continue to be in microseconds regardless of time unit.
  > - If the time unit is not selected, milliseconds will be used by default.
  > - Timestamp parameters (e.g. `startTime`, `endTime`, `timestamp)` can now be passed in milliseconds or microseconds.
  (Spot WS Streams / WS API use a **connection-URL query parameter** `timeUnit=MICROSECOND`, e.g.
  `/stream?streams=btcusdt@trade&timeUnit=MICROSECOND` — not the header.)
- Futures general-info (legacy **and** new docs, verbatim, unchanged):
  > All time and timestamp related fields are in milliseconds.
  > A `SIGNED` endpoint also requires a parameter, `timestamp`, to be sent which should be the millisecond
  > timestamp of when the request was created and sent.
- Spot error text `Invalid value for time unit; expected either MICROSECOND or MILLISECOND.` (line 25117/124970) —
  again spot error-code docs.

**Operational conclusion:** do not send `X-MBX-TIME-UNIT` to fapi. `timestamp` stays **milliseconds**.
If fapi ever grows microsecond support, it is undocumented as of 2026-09-15 → UNVERIFIED.
Answer to "does `timestamp` become microseconds when it is set": **UNVERIFIED for futures; VERIFIED YES for Spot.**
Scope: **Spot-only, not futures-only/not shared.**

---

## 4. `recvWindow` default and `timestamp` handling — history

Futures general-info, **identical verbatim in the legacy mirror and the new-docs dump** (no change over time found):
> - A `SIGNED` endpoint also requires a parameter, `timestamp`, to be sent which should be the millisecond timestamp of when the request was created and sent.
> - An additional parameter, `recvWindow`, may be sent to specify the number of milliseconds after `timestamp` the request is valid for. If `recvWindow` is not sent, **it defaults to 5000**.
>
> The logic is as follows:
> ```
> if (timestamp < serverTime + 1000 && serverTime - timestamp <= recvWindow) {
>   // process request
> } else {
>   // reject request
> }
> ```
> It is recommended to use a small recvWindow of 5000 or less!

- **No documented max `recvWindow` for fapi** (the RSA example even uses `recvWindow=9999999`). No decimal-precision /
  microsecond clause for fapi. **No change to the 5000 default** found anywhere in the fapi change log.
- Full-range grep of the fapi change log (`53365–57318`) for `recvWindow|recv window|timestamp` returns only 3 clusters:
  1. `## 2023-04-17` **USDⓈ-M Futures, "RELEASE DATE 2023-04-18"** (verbatim):
     > The `recvWindow` check will also be performed when orders reach matching engine. The `recvWindow` will be checked more precisely on order placing endpoints.
     > `{"code": -5028, "msg": "Timestamp for this request is outside of the ME recvWindow"}`
     > **recvWindow Logic Before Release:** The order placing requests are valid if `recvWindow` + `timestamp` => REST API service server `timestamp`
     > **recvWindow Logic After Release:** Add new recwWindow check: the order placing requests are valid if `recvWindow` + `timestamp` => matching engine `timestamp`
     > Impacted Endpoints: `POST /fapi/v1/order`, `PUT /fapi/v1/order`, `POST /fapi/v1/batchOrders`, `PUT /fapi/v1/batchOrders`
     (COIN-M twin same date, `RELEASE DATE TBD`, code `-4188`, endpoints `POST/PUT /dapi/v1/order`, `POST/PUT /dapi/v1/batchOrders`, "(HMAC SHA256)" annotated.)
  2. `## 2020-05-06`: `GET /fapi/v1/leverageBracket` changed to "USER-DATA" — "It need to be signed, and timestamp is needed."
  3. `## 2026-01-09`-era entry: a percent-encoded example URL containing `timestamp=1760000007980`.
- fapi error-code doc (lines 52133–53045) confirms the semantics:
  - `### -1021 INVALID_TIMESTAMP` → `- Timestamp for this request is outside of the recvWindow.` / `- Timestamp for this request was 1000ms ahead of the server's time.`
  - `### -5028 ME_RECVWINDOW_REJECT` → `- Timestamp for this request is outside of the ME recvWindow.`
  - `### -1003 TOO_MANY_REQUESTS` → `Too many requests; current limit is %s requests per minute…` / `Way too many requests; IP banned until %s…`
  - `### -1015 TOO_MANY_ORDERS` → `Too many new orders.` / `Too many new orders; current limit is %s orders per %s.`
  - Note: `- recvWindow must be less than 60000` **does NOT appear** in the fapi error-code page (it is a Spot error string).

Contrast (do **not** apply to fapi) — Spot general-info has newer semantics:
> `recvWindow` supports up to three decimal places of precision (e.g., 6000.346) so that microseconds may be specified.
> Maximum `recvWindow` is 60000 milliseconds.
> `if (timestamp < (serverTime + 1 second) && (serverTime - timestamp) <= recvWindow)`
and Spot change log `### 2024-12-09`: timestamps before `1483228800000` (2017-01-01) or more than 10 seconds in the
future are rejected. **No equivalent timestamp-range rejection is documented for fapi** — UNVERIFIED whether fapi
enforces it.

Confidence: fapi default 5000 + logic string + no documented change = **VERIFIED** (legacy mirror + new-docs dump).
Spot-only max/precision/timestamp-range = **VERIFIED** but explicitly **out of fapi scope**.

---

## 5. `/fapi/v2/*` vs `/fapi/v3/*` — deprecation status and exact current weights

### Deprecation status
- Still only the open-ended 2024-07-24 notice: "The following endpoints will be deprecated in the coming months
  (**exact date to be announced later**). Please switch to the new endpoints listed above" — for
  `GET /fapi/v2/balance`, `GET /fapi/v2/account`, `GET /fapi/v2/positionRisk`, and WS `account.status|balance|position`.
- **No removal date has ever been announced** — not in the change log, not in the 2024-09-03 announcement.
- The v2 endpoints are **still documented and still listed in the new-docs API catalog** (operation IDs
  `accountInformationV2`, `futuresAccountBalanceV2`, and `GET /fapi/v2/positionRisk` still present alongside V3),
  so they are **still working / not removed**. Their legacy doc pages still render with a `USER_DATA` security type.
- The 2024-09-03 announcement re-states them as live endpoints being *replaced*, not deleted.

### Exact current documented request weights (fetched 2026-09-15 from the legacy per-endpoint pages)
| Endpoint | Documented `Request Weight` | Legacy page |
|---|---|---|
| `GET /fapi/v2/account` | **5** | `.../account/rest-api/Account-Information-V2` |
| `GET /fapi/v3/account` | **5** | `.../account/rest-api/Account-Information-V3` |
| `GET /fapi/v2/balance` | **5** | `.../account/rest-api/Futures-Account-Balance-V2` |
| `GET /fapi/v3/balance` | **5** | `.../account/rest-api/Futures-Account-Balance-V3` |
| `GET /fapi/v2/positionRisk` | **5** | `.../trade/rest-api/Position-Information-V2` |
| `GET /fapi/v3/positionRisk` | **5** | `.../trade/rest-api/Position-Information-V3` |
| `GET /fapi/v1/accountConfig` | **5** | `.../account/rest-api/Account-Config` |
| `GET /fapi/v1/symbolConfig` | **5** | `.../account/rest-api/Symbol-Config` |
| `GET /fapi/v1/rateLimit/order` | **1** | `.../account/rest-api/Query-Rate-Limit` |

### ⚠️ Documented contradiction (flag this)
- 2024-08-07 change log + 2024-09-03 announcement: v2 REST + WS account endpoints `5 -> 10`, **effective 2024-09-03**.
- Every current doc page above still says **5**.
- Earlier history: change log `## 2021-02-24`, "USDⓈ-M Futures — REST RATE LIMIT WEIGHT":
  "- The weight of endpoint `GET /fapi/v2/balance` is updated to 5" / "- The weight of endpoint
  `GET /fapi/v2/positionRisk` is updated to 5".
- **No later change-log entry reverts 10 → 5.** A scan of the entire fapi change log (`53365–57318`) for `weight`
  finds nothing about these endpoints after 2024-09-03.
- ⇒ Binance's docs are internally inconsistent. Treat **5** as the value currently documented per-endpoint and
  **10** as the value most recently *announced*; do not assume which the live server enforces.

Confidence: weights-as-documented = **VERIFIED** (9 endpoint pages each stating the number, consistent with the
2021-02-24 entry). The contradiction itself = **VERIFIED** (announcement + change log vs. pages). Live-server
effective weight = **UNVERIFIED** (would need a live signed call).

---

## 6. `Retry-After` on HTTP 429 / 418 for fapi

**Verdict: UNVERIFIED / NOT DOCUMENTED by Binance for USDⓈ-M futures.**

- Zero occurrences of the string `Retry-After` in:
  the legacy fapi general-info page; the legacy fapi `common-definition` page; the legacy fapi
  `websocket-api-general-info` page; the new-docs fapi general-info (51666–52132); the entire fapi change log
  (53365–57318); the fapi error-code doc (52133–53045).
- Binance **does** document it — but for **Spot** and for **CAAS `/api/*`**, not fapi:
  - `/products/spot/rest-api`: "A `Retry-After` header is sent with a 418 or 429 responses and will give the
    **number of seconds** to wait — to avoid a ban in the case of a `429`, or until the ban ends in the case of a
    `418`." and "If you have exceeded this, you will receive a 429 error with the `Retry-After` header."
    (Spot change log: "Retry-After header added to Rest API 418 and 429 responses.")
  - `/products/caas/basics/4.rate-limits` (line 173675): same wording.
  - **Units when documented = seconds** (integer seconds), for the `/api/*` family.
- What fapi **does** document about 429/418/backoff (verbatim from the fapi general-info, both mirrors):
  > - A `429` will be returned when either rate limit is violated.
  > - When a 429 is received, it's your obligation as an API to back off and not spam the API.
  > - **Repeatedly violating rate limits and/or failing to back off after receiving 429s will result in an automated IP ban (HTTP status 418).**
  > - IP bans are tracked and **scale in duration** for repeat offenders, **from 2 minutes to 3 days**.
  > - **The limits on the API are based on the IPs, not the API keys.**
  and, for HTTP 503 case B only:
  > **Handling**: **Retry with exponential backoff** (e.g., 200ms → 400ms → 800ms, max 3–5 attempts).
- Practical guidance: do **not** rely on a documented fapi `Retry-After`. If you read it, treat it as **seconds**,
  but note Binance never committed to it for fapi; fall back to exponential backoff plus honoring
  `X-MBX-USED-WEIGHT-1M` and `X-MBX-ORDER-COUNT-10S`/`-1M` instead of spamming.

Confidence: "not documented for fapi" = **VERIFIED negative** (7 fapi sources + full-corpus grep).

---

## 7. `X-MBX-ORDER-COUNT-10S` / `X-MBX-ORDER-COUNT-1M` for fapi

**Documented: YES, but in two different forms.**

1. **Generic form — the primary documentation, on the fapi general-info page** (both mirrors, verbatim):
   > ### Order Rate Limits
   > - Every order response will contain a `X-MBX-ORDER-COUNT-(intervalNum)(intervalLetter)` header which has the
   >   current order count for the account for all order rate limiters defined.
   > - Rejected/unsuccessful orders are not guaranteed to have `X-MBX-ORDER-COUNT-**` headers in the response.
   > - **The order rate limit is counted against each account**.
   > ### IP Limits
   > - Every request will contain `X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)` in the response headers which
   >   has the current used weight for the IP for all request rate limiters defined.

2. **Literal form — appears verbatim for USDⓈ-M futures in the change log** `## 2026-06-20`, UUID-M Futures:
   > - `POST /fapi/v1/algoOrder` (New Algo Order)
   >   - Request Weight now follows the order rate limits: `1` on 10s order rate limit (`X-MBX-ORDER-COUNT-10S`)
   >     and `1` on 1min order rate limit (`X-MBX-ORDER-COUNT-1M`). IP weight remains `0`.
   This is the **only** occurrence of a literal `X-MBX-*` header name inside the entire fapi change log.

3. **Literal names in the CM-UM integration notice** (common derivatives area):
   > `(`X-MBX-ORDER-COUNT-1M`) and **300 / 10 seconds** (`X-MBX-ORDER-COUNT-10S`). Order placements on …`
   > `Requests on either `fapi` or `dapi` count against the same `X-MBX-USED-WEIGHT-1M` counter.`

4. **The limiters the headers correspond to** — `GET /fapi/v1/rateLimit/order` (weight **1**, `USER_DATA`),
   legacy response example verbatim:
   ```json
   [
     { "rateLimitType": "ORDERS", "interval": "SECOND", "intervalNum": 10, "limit": 10000 },
     { "rateLimitType": "ORDERS", "interval": "MINUTE", "intervalNum": 1,  "limit": 20000 }
   ]
   ```
   ⇒ `X-MBX-ORDER-COUNT-10S` ↔ `interval=SECOND, intervalNum=10`; `X-MBX-ORDER-COUNT-1M` ↔
   `interval=MINUTE, intervalNum=1`. `/fapi/v1/exchangeInfo`'s `rateLimits` array carries the same
   `RAW_REQUEST` / `REQUEST_WEIGHT` / `ORDER` limiters.

Confidence: generic header pattern for fapi = **VERIFIED** (legacy page + new-docs dump).
Literal `X-MBX-ORDER-COUNT-10S` / `-1M` for fapi = **SINGLE-SOURCE** (fapi change log 2026-06-20; echoed in the
common derivatives change log, which is the same publication).
`Retry-After`-style naming (`X-MBX-USED-WEIGHT-1M`) = SINGLE-SOURCE (CM-UM integration notice).

---

## 8. Source URLs

- Legacy change log: https://developers.binance.com/legacy-docs/derivatives/change-log
- Legacy fapi general info: https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/general-info
- Legacy fapi WS API general info: https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/websocket-api-general-info
- Legacy fapi common definition: https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/common-definition
- Legacy fapi error code: https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/error-code
- Account Information V2: https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/account/rest-api/Account-Information-V2
- Account Information V3: https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/account/rest-api/Account-Information-V3
- Futures Account Balance V2: https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/account/rest-api/Futures-Account-Balance-V2
- Futures Account Balance V3: https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/account/rest-api/Futures-Account-Balance-V3
- Position Information V2: https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/trade/rest-api/Position-Information-V2
- Position Information V3: https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/trade/rest-api/Position-Information-V3
- Query Order Rate Limit: https://developers.binance.com/legacy-docs/derivatives/usds-margined-futures/account/rest-api/Query-Rate-Limit
- Account Config / Symbol Config: `.../account/rest-api/Account-Config`, `.../account/rest-api/Symbol-Config`
- New docs static dump: https://developers.binance.com/en/docs/llms-full.txt (+ https://developers.binance.com/en/docs/llms.txt)
- New docs fapi general info: https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info
- New docs fapi change log: https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/change-log
- New docs spot REST general info (for X-MBX-TIME-UNIT / Retry-After contrast): https://developers.binance.com/en/docs/products/spot/rest-api
- Announcement JSON: https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query?articleCode=19d4e3cd0758426584dd9686eb56ec64
- Announcement HTML (blocked, HTTP 202): https://www.binance.com/en/support/announcement/notice-on-upcoming-binance-api-update-2024-09-03-19d4e3cd0758426584dd9686eb56ec64

## 9. Local artifacts created
- `_research/llms-full.txt` — 8,229,908-byte static dump of the entire new Binance docs (grep-able).
- `_research/llms.txt` — 172,570-byte new-docs index.
- `_research/binance-fapi-wire-facts.md` — this report.

## 10. Method limitation
`web_search` became unavailable mid-task (search endpoint returned `HTTP 402: Insufficient Balance`), so no
search-engine corroboration (GitHub issues in binance-futures-connector-python / binance-connector-python / ccxt)
could be gathered. Everything above comes from Binance-controlled static sources fetched directly. Treat every
"SINGLE-SOURCE" label accordingly — the missing second source would normally have been third-party code/tracker
evidence.
