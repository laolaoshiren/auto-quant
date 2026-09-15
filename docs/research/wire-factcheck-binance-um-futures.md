# Wire-level fact-check: binance-futures-connector-python (USDⓈ-M Futures) + live fapi wire format

All source quotes fetched **2026-09-15 UTC** via `web_fetch` (plain text). All live calls made **2026-09-15 UTC**
(server `date` header: `Tue, 15 Sep 2026 13:19:xx GMT`; `/fapi/v1/time` → `serverTime 1789478299014`…`1789478433767`).

---

## 0. Repo identity / status

| Fact | Value |
|---|---|
| Repo | https://github.com/binance/binance-futures-connector-python |
| Package | `pip install binance-futures-connector` |
| Base URL (UM) | `https://fapi.binance.com` |
| **Status** | **DEPRECATED** |

README, first line and header (verbatim):

```
# Binance Futures Public API Connector Python - DEPRECATED
```

```
**This repository is deprecated. Please use the new modular connector repository: [binance-connector-python](https://github.com/binance/binance-connector-python)**
```

Source: https://raw.githubusercontent.com/binance/binance-futures-connector-python/main/README.md

Real directory layout (GitHub contents API, `binance/`): `__init__.py`, `__version__.py`, `api.py`, `cm_futures`, `error.py`, `lib`, `um_futures`, `websocket`.
→ **`binance/CMFutures/` does NOT exist.** The path you asked about is `binance/cm_futures/` (lowercase, underscore). Confirmed: `https://raw.githubusercontent.com/binance/binance-futures-connector-python/main/binance/cm_futures/market.py` → HTTP 200, first path literal `url_path = "/dapi/v1/ping"`.

---

## 1. Every literal REST path string in `binance/um_futures/market.py`

Source: https://raw.githubusercontent.com/binance/binance-futures-connector-python/main/binance/um_futures/market.py (582 lines)
Verified by grepping the raw file for `url_path = |self\.query\(|self\.limit_request\(`.

| Python method | Literal path used | Exact call line(s) |
|---|---|---|
| `ping` | `/fapi/v1/ping` | `url_path = "/fapi/v1/ping"` / `return self.query(url_path)` |
| `time` | `/fapi/v1/time` | `url_path = "/fapi/v1/time"` / `return self.query(url_path)` |
| `exchange_info` | `/fapi/v1/exchangeInfo` | `url_path = "/fapi/v1/exchangeInfo"` / `return self.query(url_path)` |
| `depth` | `/fapi/v1/depth` | `return self.query("/fapi/v1/depth", params)` |
| `trades` | `/fapi/v1/trades` | `return self.query("/fapi/v1/trades", params)` |
| `historical_trades` | `/fapi/v1/historicalTrades` | `return self.limit_request("GET", "/fapi/v1/historicalTrades", params)` |
| `agg_trades` | `/fapi/v1/aggTrades` | `return self.query("/fapi/v1/aggTrades", params)` |
| `klines` | `/fapi/v1/klines` | `return self.query("/fapi/v1/klines", params)` |
| `continuous_klines` | `/fapi/v1/continuousKlines` | `return self.query("/fapi/v1/continuousKlines", params)` |
| `index_price_klines` | `/fapi/v1/indexPriceKlines` | `return self.query("/fapi/v1/indexPriceKlines", params)` |
| `mark_price_klines` | `/fapi/v1/markPriceKlines` | `return self.query("/fapi/v1/markPriceKlines", params)` |
| `mark_price` | `/fapi/v1/premiumIndex` | `return self.query("/fapi/v1/premiumIndex", params)` |
| `funding_rate` | `/fapi/v1/fundingRate` | `return self.query("/fapi/v1/fundingRate", params)` |
| **`funding_info`** | **`/fapi/v1/fundingRate`** ← **wrong path** | `return self.query("/fapi/v1/fundingRate")` |
| `ticker_24hr_price_change` | `/fapi/v1/ticker/24hr` | `return self.query("/fapi/v1/ticker/24hr", params)` |
| **`ticker_price`** | **`/fapi/v2/ticker/price`** ← v2, not v1 | `return self.query("/fapi/v2/ticker/price", params)` |
| `book_ticker` | `/fapi/v1/ticker/bookTicker` | `return self.query("/fapi/v1/ticker/bookTicker", params)` |
| `quarterly_contract_settlement_price` | `/futures/data/delivery-price` | `return self.query("/futures/data/delivery-price", params)` |
| `open_interest` | `/fapi/v1/openInterest` | `return self.query("/fapi/v1/openInterest", params)` |
| `open_interest_hist` (= "open interest statistics") | `/futures/data/openInterestHist` | `return self.query("/futures/data/openInterestHist", params)` |
| `top_long_short_position_ratio` | `/futures/data/topLongShortPositionRatio` | `return self.query("/futures/data/topLongShortPositionRatio", params)` |
| `long_short_account_ratio` | `/futures/data/globalLongShortAccountRatio` | `return self.query("/futures/data/globalLongShortAccountRatio", params)` |
| `top_long_short_account_ratio` | `/futures/data/topLongShortAccountRatio` | `return self.query("/futures/data/topLongShortAccountRatio", params)` |
| `taker_long_short_ratio` | `/futures/data/takerlongshortRatio` | `return self.query("/futures/data/takerlongshortRatio", params)` |
| `blvt_kline` | `/fapi/v1/lvtKlines` | `return self.query("/fapi/v1/lvtKlines", params)` |
| `index_info` | `/fapi/v1/indexInfo` | `return self.query("/fapi/v1/indexInfo", params)` |
| `asset_Index` | `/fapi/v1/assetIndex` | `return self.query("/fapi/v1/assetIndex", params)` |
| `index_price_constituents` | `/fapi/v1/constituents` | `return self.query("/fapi/v1/constituents", params)` |

Notes:
- There is **no** `/fapi/v1/openInterestStatistics` path — that endpoint is `open_interest_hist` → `/futures/data/openInterestHist`.
- There is **no** `premium_index_klines` method in the connector. **NOT FOUND.**
- There is **no** standalone `premiumIndex` method name; `mark_price` is the premiumIndex wrapper. **NOT FOUND** for a method literally named `premium_index`.
- `_request(...)` does not exist in this codebase. The internal helpers are `self.query(path, params)` (public GET) and `self.limit_request(method, path, params)` (API-key endpoints). **`self._request(...)` — NOT FOUND.**

`funding_info` verbatim (this is a real connector bug — docstring says `fundingInfo`, code calls `fundingRate`):

```python
def funding_info(self):
    """
    |
    | **Get Funding Rate Info**
    | *Query funding rate info for symbols that had FundingRateCap/FundingRateFloor/fundingIntervalHours adjustment*

    :API endpoint: ``GET /fapi/v1/fundingInfo``
    :API doc: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Info
    |
    """

    return self.query("/fapi/v1/fundingRate")
```

---

## 2. Exact parameter names, signatures, defaults, and validation

### 2a. Signatures (verbatim)

```python
def ping(self):
def time(self):
def exchange_info(self):
def depth(self, symbol: str, **kwargs):
def trades(self, symbol: str, **kwargs):
def historical_trades(self, symbol: str, **kwargs):
def agg_trades(self, symbol: str, **kwargs):
def klines(self, symbol: str, interval: str, **kwargs):
def continuous_klines(self, pair: str, contractType: str, interval: str, **kwargs):
def index_price_klines(self, pair: str, interval: str, **kwargs):
def mark_price_klines(self, symbol: str, interval: str, **kwargs):
def mark_price(self, symbol: str = None):
def funding_rate(self, symbol: str, **kwargs):
def funding_info(self):
def ticker_24hr_price_change(self, symbol: str = None):
def ticker_price(self, symbol: str = None):
def book_ticker(self, symbol: str = None):
def quarterly_contract_settlement_price(self, pair: str):
def open_interest(self, symbol: str):
def open_interest_hist(self, symbol: str, period: str, **kwargs):
def top_long_short_position_ratio(self, symbol: str, period: str, **kwargs):
def long_short_account_ratio(self, symbol: str, period: str, **kwargs):
def top_long_short_account_ratio(self, symbol: str, period: str, **kwargs):
def taker_long_short_ratio(self, symbol: str, period: str, **kwargs):
def blvt_kline(self, symbol: str, interval: str, **kwargs):
def index_info(self, symbol: str = None):
def asset_Index(self, symbol: str = None):
def index_price_constituents(self, symbol: str = None):
```

### 2b. Parameter-passing mechanics

Every market method builds a dict and hands it to `self.query`:

```python
params = {"symbol": symbol, **kwargs}
return self.query("/fapi/v1/klines", params)
```

Optional params (`limit`, `startTime`, `endTime`, `fromId`, `contractType` for index klines, etc.) are **not declared** — they ride in `**kwargs` and are **not validated at all**.

`binance/api.py` → https://raw.githubusercontent.com/binance/binance-futures-connector-python/main/binance/api.py

```python
def query(self, url_path, payload=None):
    return self.send_request("GET", url_path, payload=payload)

def limit_request(self, http_method, url_path, payload=None):
    """limit request is for those endpoints require API key in the header"""

    check_required_parameter(self.key, "apiKey")
    return self.send_request(http_method, url_path, payload=payload)
```

```python
def _prepare_params(self, params, special=False):
    return encoded_string(cleanNoneValue(params), special)
```

```python
def send_request(self, http_method, url_path, payload=None, special=False):
    if payload is None:
        payload = {}
    url = self.base_url + url_path
```

`binance/lib/utils.py` → https://raw.githubusercontent.com/binance/binance-futures-connector-python/main/binance/lib/utils.py

```python
def cleanNoneValue(d) -> dict:
    out = {}
    for k in d.keys():
        if d[k] is not None:
            out[k] = d[k]
    return out


def check_required_parameter(value, name):
    if not value and value != 0:
        raise ParameterRequiredError([name])
```

→ **Consequence:** `mark_price(symbol=None)` / `ticker_price(symbol=None)` etc. actually **omit** the `symbol` query param (because of `cleanNoneValue`), producing an all-symbols request.

### 2c. Validation actually present in the source

| Method | Validation line | Effect |
|---|---|---|
| `depth` | `check_required_parameter(symbol, "symbol")` | raises `ParameterRequiredError` |
| `trades` | `check_required_parameter(symbol, "symbol")` | idem |
| `historical_trades` | `check_required_parameter(symbol, "symbol")` | idem |
| `agg_trades` | `check_required_parameter(symbol, "symbol")` | idem |
| `klines` | `check_required_parameters([[symbol, "symbol"], [interval, "interval"]])` | idem |
| `continuous_klines` | `check_required_parameters([[pair, "pair"], [contractType, "contractType"], [interval, "interval"]])` | idem |
| `index_price_klines` | `check_required_parameters([[pair, "pair"], [interval, "interval"]])` | idem |
| `mark_price_klines` | `check_required_parameters([[symbol, "symbol"], [interval, "interval"]])` | idem |
| `quarterly_contract_settlement_price` | `check_required_parameter(pair, "pair")` | idem |
| `open_interest` | `check_required_parameter(symbol, "symbol")` | idem |
| `open_interest_hist` | `check_required_parameters([[symbol, "symbol"], [period, "period"]])` | idem |
| `top_long_short_position_ratio` | `check_required_parameters([[symbol, "symbol"], [period, "period"]])` | idem |
| `long_short_account_ratio` | `check_required_parameters([[symbol, "symbol"], [period, "period"]])` | idem |
| `top_long_short_account_ratio` | `check_required_parameters([[symbol, "symbol"], [period, "period"]])` | idem |
| `taker_long_short_ratio` | `check_required_parameters([[symbol, "symbol"], [period, "period"]])` | idem |
| `blvt_kline` | `check_required_parameters([[symbol, "symbol"], [interval, "interval"]])` | idem |
| **`funding_rate`** | **none** (despite `symbol: str` being required by the API) | no local validation |
| **`exchange_info`** | **none** (no symbol parameter at all) | — |

### 2d. Hardcoded defaults / minsize / maxsize

- **No `limit` default value is set anywhere in code.** No `params["limit"] = 500`. The "Default 500" text exists **only in docstrings**. If you don't pass `limit`, the connector sends **no `limit` param at all** and the server applies its own default.
- **No assertions** — grep of the raw file for `assert` returned **zero** matches.
- **No `minsize`/`maxsize`/`minQty`/`stepSize` validation** anywhere in `market.py`. **NOT FOUND.**
- The only numeric constraints in the file are docstring prose: `[5, 10, 20, 50, 100, 500, 1000]` (depth) and `max 1000` / `max 500`.

---

## 3. Exact docstrings / comments in `market.py`

**Grep results for the raw file:**
- lines containing `Weight` → **0 matches** (so `# Request Weight: based on parameter LIMIT` and the LIMIT→weight table are **NOT FOUND** in this repo)
- lines containing `1500` → **0 matches** (so `"Default 500; max 1500"` is **NOT FOUND**)
- lines containing `assert` → **0 matches**

**All `Default ` / `:parameter limit` docstring lines, verbatim:**

```
    :parameter limit: optional int; limit the results. Default 500, valid limits: [5, 10, 20, 50, 100, 500, 1000].
    :parameter limit: optional int; limit the results. Default 500, max 1000.
    :parameter limit: optional int; limit the results. Default 500, max 1000.
    :parameter formId: optional int; trade ID to fetch from. Default gets most recent trades.
    :parameter limit: optional int; limit the results. Default 500, max 1000.
    :parameter limit: optional int; limit the results. Default 500, max 1000.
    :parameter limit: optional int; limit the results. Default 500, max 1000.
    :parameter limit: optional int; limit the results. Default 500, max 1000.
    :parameter limit: optional int; limit the results. Default 500, max 1000.
    :parameter limit: optional int; limit the results. Default 500, max 1000.
    :parameter limit: optional int; limit the results. Default 30, max 500.
    :parameter limit: optional int; limit the results. Default 30, max 500.
    :parameter limit: optional int; limit the results. Default 30, max 500.
    :parameter limit: optional int; limit the results. Default 30, max 500.
    :parameter limit: optional int; limit the results. Default 30, max 500.
    :parameter limit: optional int; limit the results. Default 500, max 1000.
```

**`klines` docstring, complete and verbatim** (note: **no `**Notes**` block**, therefore the sentence *"If startTime and endTime are not sent, the most recent klines are returned"* is **NOT FOUND** in `market.py`):

```python
def klines(self, symbol: str, interval: str, **kwargs):
    """
    |
    | **Kline/Candlestick Data**
    | *Kline/candlestick bars for a symbol. Klines are uniquely identified by their open time.*

    :API endpoint: ``GET /fapi/v1/klines``
    :API doc: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data

    :parameter symbol: string; the trading symbol.
    :parameter interval: string; the interval of kline, e.g 1m, 5m, 1h, 1d, etc. (see more in https://developers.binance.com/docs/derivatives/usds-margined-futures/common-definition)
    :parameter limit: optional int; limit the results. Default 500, max 1000.
    :parameter startTime: optional int
    :parameter endTime: optional int
    |
    """
```

**`funding_rate` docstring, complete and verbatim** (the only endpoint in this file with a `**Notes**` block):

```python
def funding_rate(self, symbol: str, **kwargs):
    """
    |
    | **Funding Rate History

    :API endpoint: ``GET /fapi/v1/fundingRate``
    :API doc: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-History

    :parameter symbol: string; the trading symbol.
    :parameter limit: optional int; limit the results. Default 500, max 1000.
    :parameter startTime: optional int
    :parameter endTime: optional int

    **Notes**
        - If startTime and endTime are not sent, the most recent limit datas are returned.
        - If the number of data between startTime and endTime is larger than limit, return as startTime + limit.
        - In ascending order.
    |
    """
```

(Note the unterminated `**Funding Rate History` — the closing `**` is missing in the source.)

**`depth` docstring, verbatim:**

```python
def depth(self, symbol: str, **kwargs):
    """
    |
    | **Get Orderbook**

    :API endpoint: ``GET /fapi/v1/depth``
    :API doc: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Order-Book

    :parameter symbol: string; the trading symbol.
    :parameter limit: optional int; limit the results. Default 500, valid limits: [5, 10, 20, 50, 100, 500, 1000].
    |
    """
```

**`open_interest` docstring, verbatim:**

```python
def open_interest(self, symbol: str):
    """
    |
    | **Get present open interest of a specific symbol.**

    :API endpoint: ``GET /fapi/v1/openInterest``
    :API doc: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Open-Interest

    :parameter symbol: string; the trading symbol.
    |
    """
```

**`open_interest_hist` docstring, verbatim** (this is the "Open Interest Statistics" endpoint):

```python
def open_interest_hist(self, symbol: str, period: str, **kwargs):
    """
    |
    | **Get historical open interest of a specific symbol.**

    :API endpoint: ``GET /futures/data/openInterestHist``
    :API doc: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Open-Interest-Statistics

    :parameter symbol: string; the trading symbol.
    :parameter period: string; the period of open interest, "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d".
    :parameter limit: optional int; limit the results. Default 30, max 500.
    :parameter startTime: optional int
    :parameter endTime: optional int

    **Notes**
        - If startTime and endTime are not sent, the most recent data is returned.
        - Only the data of the latest 30 days is available.
    |
    """
```

**`ticker_price` docstring, verbatim** — note it calls itself "Symbol Price Ticker V2", matching the `/fapi/v2/ticker/price` path:

```python
def ticker_price(self, symbol: str = None):
    """
    |
    | **Symbol Price Ticker V2**
    | *If the symbol is not sent, prices for all symbols will be returned in an array.*

    :API endpoint: ``GET /fapi/v2/ticker/price``
    :API doc: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Symbol-Price-Ticker-v2

    :parameter symbol: optional string; the trading symbol.

    **Notes**
        - If the symbol is not sent, prices for all symbols will be returned in an array.
    |
    """
```

**Docstring style note:** every docstring begins with the bare `|` line and uses `:API endpoint:` / `:API doc:` RST fields. Weight lines and "based on parameter LIMIT" tables are **absent across the whole file**.

---

## 4. Does `exchange_info` expose `symbol`? Any weight-difference docstring?

**No.** Verbatim, complete:

```python
def exchange_info(self):
    """
    |
    | **Exchange Information**
    | *Current exchange trading rules and symbol information.*

    :API endpoint: ``GET /fapi/v1/exchangeInfo``
    :API doc: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information
    |
    """

    url_path = "/fapi/v1/exchangeInfo"
    return self.query(url_path)
```

- `symbol` parameter: **NOT FOUND.**
- Any docstring stating a weight difference (e.g. "1 for a single symbol / 40 for all symbols"): **NOT FOUND** anywhere in `market.py`.
- `exchange_info` calls `self.query(url_path)` with **no params at all** — it is impossible to pass `symbol` through this method (no `**kwargs`).

This turns out to match the server, which **ignores `?symbol=` entirely** (see §7).

---

## 5. `error.py` / `exceptions.py`

`binance/error.py` → https://raw.githubusercontent.com/binance/binance-futures-connector-python/main/binance/error.py — **complete file, verbatim:**

```python
class Error(Exception):
    pass


class ClientError(Error):
    def __init__(self, status_code, error_code, error_message, header):
        # https status code
        self.status_code = status_code
        # error code returned from server
        self.error_code = error_code
        # error message returned from server
        self.error_message = error_message
        # the whole response header returned from server
        self.header = header


class ServerError(Error):
    def __init__(self, status_code, message):
        self.status_code = status_code
        self.message = message


class ParameterRequiredError(Error):
    def __init__(self, params):
        self.params = params

    def __str__(self):
        return "%s is mandatory, but received empty." % (", ".join(self.params))


class ParameterValueError(Error):
    def __init__(self, params):
        self.params = params

    def __str__(self):
        return "the enum value %s is invalid." % (", ".join(self.params))


class ParameterTypeError(Error):
    def __init__(self, params):
        self.params = params

    def __str__(self):
        return f"{self.params[0]} data type has to be {self.params[1]}"


class ParameterArgumentError(Error):
    def __init__(self, error_message):
        self.error_message = error_message

    def __str__(self):
        return self.error_message
```

**Error-code → message mappings: NOT FOUND.** `error.py` contains **zero** numeric error codes. It only carries the server-supplied `error_code`/`error_message` through `ClientError` verbatim.

`binance/exceptions.py` → https://raw.githubusercontent.com/binance/binance-futures-connector-python/main/binance/exceptions.py → **HTTP 404 `404: Not Found`**. The file **does not exist** in this repo (errors live in `error.py`).

How a code becomes an exception (`binance/api.py`, verbatim):

```python
    def _handle_exception(self, response):
        status_code = response.status_code
        if status_code < 400:
            return
        if 400 <= status_code < 500:
            try:
                err = json.loads(response.text)
            except JSONDecodeError:
                raise ClientError(status_code, None, response.text, response.headers)
            raise ClientError(status_code, err["code"], err["msg"], response.headers)
        raise ServerError(status_code, response.text)
```

→ Codes are **never** translated locally; `ClientError.error_code` == the raw server `code`.

---

## 6. README: market-data endpoint list and request-weight table

Source: https://raw.githubusercontent.com/binance/binance-futures-connector-python/main/README.md

- **List of supported market-data endpoints: NOT FOUND.** The README only says, verbatim:

```
- Supported APIs:
    - USDT-M Futures `/fapi/*`
    - COIN-M Delivery `/dapi/*`
    - Futures/Delivery Websocket Market Stream
    - Futures/Delivery User Data Stream
- Inclusion of examples
- Customizable base URL, request timeout
- Response metadata can be displayed
```

  and: `Please find `examples` folder to check for more endpoints.`
  There is **no per-endpoint table** for market data (no `exchange_info`, `klines`, etc. listed).

- **Request-weight table: NOT FOUND.** The README never lists per-endpoint weights. It only documents that weights come back in response headers, verbatim:

```
The Binance API server provides weight usages in the headers of each response.
You can display them by initializing the client with `show_limit_usage=True`:
```

```
{'limit_usage': {'x-mbx-used-weight-1m': '1'}, 'data': {'serverTime': 1653563092778}}
```

- Verbatim, the only other numeric constraint in the README:

```
Additional parameter `recvWindow` is available for endpoints requiring signature.<br/>
It defaults to `5000` (milliseconds) and can be any value lower than `60000`(milliseconds).
Anything beyond the limit will result in an error response from Binance server.
```

- README's error documentation, verbatim:

```
- `binance.error.ClientError`
    - This is thrown when server returns `4XX`, it's an issue from client side.
    - It has 4 properties:
        - `status_code` - HTTP status code
        - `error_code` - Server's error code, e.g. `-1102`
        - `error_message` - Server's error message, e.g. `Unknown order sent.`
        - `header` - Full response header.
- `binance.error.ServerError`
    - This is thrown when server returns `5XX`, it's an issue from server side.
```

---

## 7. LIVE wire format (real HTTP responses, 2026-09-15 UTC)

All bodies below are **literal JSON as returned**.

### 7.1 `GET /fapi/v1/time`
URL: https://fapi.binance.com/fapi/v1/time
```
{"serverTime":1789478299014}
```
(second sample, 13:20:33Z: `{"serverTime":1789478433767}`)

### 7.2 ★ CRITICAL: `GET /fapi/v1/exchangeInfo?symbol=BTCUSDT` — `symbol` IS IGNORED

URL: https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=BTCUSDT

Measured live with two independent clients:

```
len a(symbol=BTCUSDT) = 1113505   (curl Content-Length: 1113601)
len b(no param)       = 1113505
sha256 a = E4CBEC4413E40E0D8EA9713F26EB5E3F271B70A7279C1F5763B75C5C4AB1A350
sha256 b = E4CBEC4413E40E0D8EA9713F26EB5E3F271B70A7279C1F5763B75C5C4AB1A350
a eq b : True
```

- **`?symbol=` is accepted (no error) but ignored.** The response is **STILL THE FULL PAYLOAD**, `symbols[]` has **897 entries**, byte-identical to `/fapi/v1/exchangeInfo` with no query string.
- It is **NOT** an object with a single-element `symbols[]` array. Any code doing `resp["symbols"][0]` on `exchangeInfo?symbol=X` gets **BTCUSDT** (the first symbol in the file), not the symbol it asked for.
- Confirmed twice: `?symbol=NOTAREALSYM` → **HTTP 200, Content-Length 1113601**, full payload, **no `-1121 Invalid symbol`**. A real single-symbol lookup would error; this proves the parameter never reaches the resolver.
- `?symbol=ETHUSDT` → also 1113505 bytes (SHA differs only because `serverTime` changed between calls).
- **Contrast:** the *spot* endpoint `/api/v3/exchangeInfo?symbol=` does filter. On USDⓈ-M futures it does not. Do not port spot assumptions here.

### 7.3 `GET /fapi/v1/exchangeInfo` (no param) — structure

- **Top-level keys (exact, in returned order):** `timezone`, `serverTime`, `futuresType`, `rateLimits`, `exchangeFilters`, `assets`, `symbols`
  - `timezone` = `"UTC"`, `futuresType` = `"U_MARGINED"`
- **`symbols[]` count = 897**
- **`exchangeFilters`** = `[]` (verbatim: `"exchangeFilters":[]`)
- **`rateLimits`** (verbatim):
```json
[{"rateLimitType":"REQUEST_WEIGHT","interval":"MINUTE","intervalNum":1,"limit":2400},{"rateLimitType":"ORDERS","interval":"MINUTE","intervalNum":1,"limit":1200},{"rateLimitType":"ORDERS","interval":"SECOND","intervalNum":10,"limit":300}]
```
- **`assets`** entries (verbatim): `USDT, BTC, BNB, ETH, USDC, FDUSD, BNFCR, BFUSD, LDUSDT, RWUSD, USD1, U`

#### Exact set of distinct `filterType` values across ALL 897 symbols

```
LOT_SIZE
MARKET_LOT_SIZE
MAX_NUM_ORDERS
MIN_NOTIONAL
PERCENT_PRICE
POSITION_RISK_CONTROL
PRICE_FILTER
```

7 distinct values. Explicitly:

| filterType | present live? |
|---|---|
| `PRICE_FILTER` | **YES** |
| `LOT_SIZE` | **YES** |
| `MARKET_LOT_SIZE` | **YES** |
| `MAX_NUM_ORDERS` | **YES** |
| `MIN_NOTIONAL` | **YES** |
| `PERCENT_PRICE` | **YES** |
| `POSITION_RISK_CONTROL` | **YES** |
| **`PERCENT_PRICE_BY_SIDE`** | **NO — NOT PRESENT** |
| **`MAX_NUM_ALGO_ORDERS`** | **NO — NOT PRESENT** |

(`PERCENT_PRICE_BY_SIDE` and `MAX_NUM_ALGO_ORDERS` belong to the **spot** filter set, not USDⓈ-M futures.)

#### FULL `symbols[]` entry for BTCUSDT, exactly as returned

`BTCUSDT` appears exactly once in `symbols[]`.

```json
{"symbol":"BTCUSDT","pair":"BTCUSDT","contractType":"PERPETUAL","deliveryDate":4133404800000,"onboardDate":1567965300000,"status":"TRADING","maintMarginPercent":"2.5000","requiredMarginPercent":"5.0000","baseAsset":"BTC","quoteAsset":"USDT","marginAsset":"USDT","pricePrecision":2,"quantityPrecision":3,"baseAssetPrecision":8,"quotePrecision":8,"underlyingType":"COIN","underlyingSubType":["PoW","Crypto"],"triggerProtect":"0.0500","liquidationFee":"0.012500","marketTakeBound":"0.05","maxMoveOrderLimit":10000,"filters":[{"minPrice":"556.80","tickSize":"0.10","filterType":"PRICE_FILTER","maxPrice":"4529764"},{"minQty":"0.001","filterType":"LOT_SIZE","stepSize":"0.001","maxQty":"1000"},{"stepSize":"0.001","maxQty":"120","filterType":"MARKET_LOT_SIZE","minQty":"0.001"},{"filterType":"MAX_NUM_ORDERS","limit":200},{"notional":"50","filterType":"MIN_NOTIONAL"},{"multiplierDown":"0.9500","multiplierDecimal":"4","filterType":"PERCENT_PRICE","multiplierUp":"1.0500"},{"filterType":"POSITION_RISK_CONTROL","positionControlSide":"NONE"}],"orderTypes":["LIMIT","MARKET","STOP","STOP_MARKET","TAKE_PROFIT","TAKE_PROFIT_MARKET","TRAILING_STOP_MARKET"],"timeInForce":["GTC","IOC","FOK","GTX","GTD"],"permissionSets":["GRID","COPY","DCA","PSB"]}
```

Raw-HTTP version of the same entry, byte-for-byte as it appears in the `?symbol=BTCUSDT` response body (note key ordering inside `filters` varies per object — that is how Binance emits it):

```json
{"symbol":"BTCUSDT","pair":"BTCUSDT","contractType":"PERPETUAL","deliveryDate":4133404800000,"onboardDate":1567965300000,"status":"TRADING","maintMarginPercent":"2.5000","requiredMarginPercent":"5.0000","baseAsset":"BTC","quoteAsset":"USDT","marginAsset":"USDT","pricePrecision":2,"quantityPrecision":3,"baseAssetPrecision":8,"quotePrecision":8,"underlyingType":"COIN","underlyingSubType":["PoW","Crypto"],"triggerProtect":"0.0500","liquidationFee":"0.012500","marketTakeBound":"0.05","maxMoveOrderLimit":10000,"filters":[{"filterType":"PRICE_FILTER","minPrice":"556.80","maxPrice":"4529764","tickSize":"0.10"},{"filterType":"LOT_SIZE","minQty":"0.001","stepSize":"0.001","maxQty":"1000"},{"stepSize":"0.001","filterType":"MARKET_LOT_SIZE","minQty":"0.001","maxQty":"120"},{"limit":200,"filterType":"MAX_NUM_ORDERS"},{"filterType":"MIN_NOTIONAL","notional":"50"},{"multiplierUp":"1.0500","multiplierDecimal":"4","filterType":"PERCENT_PRICE","multiplierDown":"0.9500"},{"positionControlSide":"NONE","filterType":"POSITION_RISK_CONTROL"}],"orderTypes":["LIMIT","MARKET","STOP","STOP_MARKET","TAKE_PROFIT","TAKE_PROFIT_MARKET","TRAILING_STOP_MARKET"],"timeInForce":["GTC","IOC","FOK","GTX","GTD"],"permissionSets":["GRID","COPY","DCA","PSB"]}
```

Other symbols present (first ~50, to show it is the full list): BTCUSDT, ETHUSDT, BCHUSDT, XRPUSDT, LTCUSDT, TRXUSDT, ETCUSDT, LINKUSDT, XLMUSDT, ADAUSDT, XMRUSDT, DASHUSDT, ZECUSDT, XTZUSDT, BNBUSDT, ATOMUSDT, ONTUSDT, IOTAUSDT, BATUSDT, … plus `status:"SETTLING"` entries (e.g. `LRCUSDT`, `OCEANUSDT`, `ALPHAUSDT`, `UNFIUSDT`, `REEFUSDT`, `XEMUSDT`) and non-crypto underlyings (`TSLAUSDT`, `NVDAUSDT`, `XAUUSDT`, `BTCUSDT_260925`…).

### 7.4 `GET /fapi/v1/premiumIndex?symbol=BTCUSDT`
URL: https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT
```json
{"symbol":"BTCUSDT","markPrice":"76916.95122464","indexPrice":"76959.67847826","estimatedSettlePrice":"77018.74802742","lastFundingRate":"0.00008972","interestRate":"0.00010000","nextFundingTime":1789488000000,"time":1789478303000}
```

### 7.5 `GET /fapi/v1/openInterest?symbol=BTCUSDT`
URL: https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT
```json
{"symbol":"BTCUSDT","openInterest":"106312.376","time":1789478297197}
```

### 7.6 `GET /fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=3`
URL: https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=3
```json
[[1789478160000,"76936.20","76965.50","76936.10","76965.40","20.680",1789478219999,"1591436.27140",878,"15.190","1168938.63310","0"],[1789478220000,"76965.50","76971.40","76950.90","76953.60","65.132",1789478279999,"5013044.70040",942,"12.866","990128.82690","0"],[1789478280000,"76953.60","76957.30","76914.90","76914.90","28.720",1789478339999,"2209840.15800",850,"13.799","1061850.96740","0"]]
```
12-element arrays, in order: openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, numberOfTrades, takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume, unused(`"0"`). All prices/quantities are **strings**.

### 7.7 `GET /fapi/v1/fundingRate?symbol=BTCUSDT&limit=2`
URL: https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=2
```json
[{"symbol":"BTCUSDT","fundingTime":1789430400000,"fundingRate":"0.00003563","markPrice":"78178.30000000","rateType":"Regular"},{"symbol":"BTCUSDT","fundingTime":1789459200005,"fundingRate":"0.00006188","markPrice":"76907.97183333","rateType":"Regular"}]
```

### 7.8 `GET /fapi/v1/fundingInfo`
URL: https://fapi.binance.com/fapi/v1/fundingInfo → **HTTP 200**, ~133,659-byte array (only the first two entries shown here; the list is very long):

```json
[{"symbol":"GTCUSDT","adjustedFundingRateCap":"0.02000000","adjustedFundingRateFloor":"-0.02000000","fundingIntervalHours":8,"disclaimer":false,"updateTime":1758377721362},{"symbol":"LPTUSDT","adjustedFundingRateCap":"0.02000000","adjustedFundingRateFloor":"-0.02000000","fundingIntervalHours":4,"disclaimer":false,"updateTime":1752854309429}, ...]
```

- Element keys: `symbol`, `adjustedFundingRateCap`, `adjustedFundingRateFloor`, `fundingIntervalHours`, `disclaimer`, `updateTime`.
- `fundingIntervalHours` values observed: **1, 4, 8**.
- `adjustedFundingRateCap` values observed: `0.02000000`, `0.03000000` (BTCDOMUSDT), `0.00500000` (XAU/XAG/XPT/XPD/COPPER/CL/BZ/NATGAS), `0.01000000` (e.g. MINIMAXUSDT, HK0700USDT).
- Tail of the array contains legacy/disclaimer rows with `"disclaimer":true,"updateTime":null`, e.g. `{"symbol":"BTCUSDT","adjustedFundingRateCap":"0.00300","adjustedFundingRateFloor":"-0.00300","fundingIntervalHours":8,"disclaimer":true,"updateTime":null}`.
- **`?symbol=BTCUSDT` is ALSO IGNORED here**: `https://fapi.binance.com/fapi/v1/fundingInfo?symbol=BTCUSDT` → HTTP 200, **size 133,691** (vs 133,659 for no-symbol; the tiny delta is live data churn), i.e. still the full array, not a filtered single-symbol array.
- Request weight for this endpoint is stated by Binance docs as 1 for a single symbol / 10 for all symbols — **but live, `?symbol=` does not filter**, so you always pay/consume the all-symbols form.

### 7.9 `GET /fapi/v1/ticker/24hr?symbol=BTCUSDT`
URL: https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT
```json
{"closeTime":1789478298702,"count":3466091,"firstId":8076263956,"highPrice":"79570.90","lastId":8079746427,"lastPrice":"76914.90","lastQty":"0.002","lowPrice":"76667.30","openPrice":"77800.00","openTime":1789391880000,"priceChange":"-885.10","priceChangePercent":"-1.138","quoteVolume":"13258734360.38","symbol":"BTCUSDT","volume":"169924.020","weightedAvgPrice":"78027.43"}
```

### 7.10 `GET /fapi/v1/ticker/price?symbol=BTCUSDT` (and `/fapi/v2/ticker/price`)
URL: https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT
```json
{"price":"76915.00","symbol":"BTCUSDT","time":1789478295482}
```
URL: https://fapi.binance.com/fapi/v2/ticker/price?symbol=BTCUSDT (the path the connector actually uses)
```json
{"symbol":"BTCUSDT","price":"76935.10","time":1789478433767}
```
→ Same field set/shape for the single-symbol case. `?symbol=` **is** honored here (unlike exchangeInfo): `?symbol=NOTAREALSYM` on `ticker/24hr` returns HTTP 400 `{"code":-1121,"msg":"Invalid symbol."}`.
`/fapi/v1/ticker/price` with **no** symbol returns a large array of `{price, symbol, time}` objects.

### 7.11 `GET /fapi/v1/ticker/bookTicker?symbol=BTCUSDT`
URL: https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=BTCUSDT
```json
{"symbol":"BTCUSDT","bidPrice":"76914.90","bidQty":"4.218","askPrice":"76915.00","askQty":"6.128","time":1789478303376,"lastUpdateId":11563384751926}
```

### 7.12 `GET /fapi/v1/depth?symbol=BTCUSDT&limit=5`
URL: https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=5
```json
{"lastUpdateId":11563384769463,"E":1789478303560,"T":1789478303557,"bids":[["76914.90","5.878"],["76914.80","0.002"],["76914.70","0.040"],["76914.60","0.003"],["76914.50","0.001"]],"asks":[["76915.00","2.149"],["76915.10","0.012"],["76915.20","0.001"],["76915.40","0.004"],["76915.80","0.002"]]}
```
Note `E` (event time) and `T` (transaction time) — present on futures, absent on spot depth.

### 7.13 `GET /fapi/v1/aggTrades?symbol=BTCUSDT&limit=2`
URL: https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT&limit=2
```json
[{"a":3450415493,"p":"76906.00","q":"0.004","nq":"0.004","f":8079747315,"l":8079747315,"T":1789478330891,"m":false},{"a":3450415494,"p":"76905.90","q":"0.003","nq":"0.003","f":8079747316,"l":8079747316,"T":1789478330948,"m":true}]
```
Keys: `a`(aggId) `p` `q` `nq`(normalized qty — futures-only) `f` `l` `T` `m`.

### 7.14 `GET /fapi/v1/continuousKlines?pair=BTCUSDT&contractType=PERPETUAL&interval=1m&limit=1`
URL: https://fapi.binance.com/fapi/v1/continuousKlines?pair=BTCUSDT&contractType=PERPETUAL&interval=1m&limit=1
```json
[[1789478280000,"76953.60","76957.30","76900.00","76900.00","41.104",1789478339999,"3162298.10640",1561,"16.683","1283658.76190","0"]]
```

### 7.15 `GET /fapi/v1/indexPriceKlines?pair=BTCUSDT&interval=1m&limit=1`
URL: https://fapi.binance.com/fapi/v1/indexPriceKlines?pair=BTCUSDT&interval=1m&limit=1
```json
[[1789478280000,"76993.72956522","76994.69130435","76953.00391304","76953.00391304","0",1789478339999,"0",36,"0","0","0"]]
```

### 7.16 ★ Does `1s` work on USDⓈ-M futures? **NO.**

URL: https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1s&limit=1
```
HTTP 400
{"code":-1120,"msg":"Invalid interval."}
```
Exact error, both clients agreed. `1s` is **spot-only**; USDⓈ-M futures does not accept it.

### 7.17 `GET /fapi/v1/historicalTrades?symbol=BTCUSDT&limit=1` (unauthenticated)
```
HTTP 401
{"code":-2014,"msg":"API-key format invalid."}
```
Confirms the endpoint requires an API key header (consistent with the connector using `self.limit_request` → which calls `check_required_parameter(self.key, "apiKey")` locally before sending).

### 7.18 Boundary / validation errors, exact bodies

| URL | HTTP | Body |
|---|---|---|
| `/fapi/v1/klines?symbol=BTCUSDT&interval=1s&limit=1` | 400 | `{"code":-1120,"msg":"Invalid interval."}` |
| `/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=2000` | 400 | `{"code":-1130,"msg":"Data sent for parameter 'limit' is not valid."}` |
| `/fapi/v1/depth?symbol=BTCUSDT&limit=3` | 400 | `{"code":-4021,"msg":"3 is not valid depth limit"}` |
| `/fapi/v1/depth?symbol=BTCUSDT&limit=1500` | 400 | `{"code":-1130,"msg":"Data sent for parameter 'limit' is not valid."}` |
| `/fapi/v1/aggTrades?symbol=BTCUSDT&limit=1001` | 400 | `{"code":-1130,"msg":"Data sent for parameter 'limit' is not valid."}` |
| `/fapi/v1/historicalTrades?symbol=BTCUSDT&limit=1` | 401 | `{"code":-2014,"msg":"API-key format invalid."}` |
| `/fapi/v1/ticker/24hr?symbol=NOTAREALSYM` | 400 | `{"code":-1121,"msg":"Invalid symbol."}` |

→ Live-confirmed ceilings: **klines/aggTrades max limit = 1000** (`1001` → `-1130`), matching the docstrings' "max 1000" but **contradicting** any assumption of 1500. Depth accepts only the enumerated set; `3` gives the dedicated `-4021`, while `1500` (outside the enumerated set but a "number") gives generic `-1130`.

### 7.19 Response headers observed

`x-mbx-used-weight-1m` **is** present on every fapi response (case-insensitive lookup works; both `x-mbx-used-weight-1m` and `X-MBX-USED-WEIGHT-1M` are servable). Others seen: `content-type: application/json`, `content-length`, `server: nginx`, `x-content-type-options: nosniff`, `x-response-time: 0ms`, `access-control-allow-methods: GET, POST, PUT, DELETE, OPTIONS`, plus `HTTP/1.1 200 Connection established` from the local egress proxy.

**Caveat on weight attribution:** `x-mbx-used-weight-1m` is the **cumulative IP counter for the current minute**, not the cost of the single request. Values observed in sequence during my probing: `2` → `66` → `10` (rolling over a minute boundary) → `32` → `406`. Do **not** diff them naively to infer per-endpoint weights; isolate with a single request after a boundary. The connector surfaces this via `show_limit_usage=True`, whose README example shows `{'limit_usage': {'x-mbx-used-weight-1m': '1'}, 'data': {'serverTime': 1653563092778}}`.

---

## 8. Summary of surprises a consumer must handle

1. **`/fapi/v1/exchangeInfo` ignores `?symbol=` and always returns all 897 symbols (1,113,601 bytes).** Verified byte-identical with and without the param, and `?symbol=NOTAREALSYM` does not raise `-1121`. Build your own symbol index from `symbols[]`; do not expect a single-element array.
2. **`/fapi/v1/fundingInfo` also ignores `?symbol=`.**
3. The connector's `funding_info()` calls **`/fapi/v1/fundingRate`** — it does not touch `/fapi/v1/fundingInfo` at all.
4. The connector's `ticker_price()` calls **`/fapi/v2/ticker/price`**, not v1.
5. `exchange_info()` accepts **no arguments**; there is no `**kwargs`, so you cannot pass `symbol` even if you wanted to.
6. **No weight tables and no `limit` defaults exist in the connector source** — "Default 500" is docstring prose only; omit `limit` and the param is not sent.
7. Live limits: klines/aggTrades `limit ≤ 1000` (`1001` → `-1130`); depth `limit` ∈ `{5,10,20,50,100,500,1000}` (`3` → `-4021`).
8. `1s` interval → `-1120 Invalid interval.` on USDⓈ-M futures.
9. `historicalTrades` needs an API key (else `401 -2014`).
10. Filter set is the 7-value futures set; **`PERCENT_PRICE_BY_SIDE` and `MAX_NUM_ALGO_ORDERS` are NOT present** (those are spot filters).
11. `binance/exceptions.py` does not exist (404); errors live in `binance/error.py`, which has **no** code→message table.
12. Repo is **DEPRECATED**; upstream now points at `binance-connector-python`.
