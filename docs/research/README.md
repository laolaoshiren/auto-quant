# 调研文档

这些文档是在动手实现**之前**做的实测调研，它们直接决定了 `packages/server/src/binance/`
和 `packages/server/src/llm/` 的实现方式。**改这两个模块之前请先读对应文档** ——
里面每一条都对应一个"踩了会亏钱或长时间静默失败"的坑。

| 文件 | 内容 |
| --- | --- |
| `binance-usdm-futures-api.md` | 币安 USDT 本位合约 REST API 完整参考：签名、账户/持仓端点、杠杆与保证金、下单参数矩阵、标的过滤器、限流与错误码、测试网差异 |
| `binance-ws-and-llm-apis.md` | 币安 WebSocket（路由拆分、用户数据流、连接管理）与 9 家 LLM 提供商的 HTTP API 对照 |
| `binance-usdm-testnet-demo-research.md` | 测试网/Demo 环境的实测证据（与实盘的行为差异） |
| `wire-factcheck-binance-um-futures.md` | 逐字段的接口事实核对 |
| `binance-fapi-wire-facts.md` | 关键接口摘要 |
| `vendor/` | 从币安官网下载的文档语料副本（约 8 MB，已 gitignore，可按下方链接重新获取） |

## 调研方法

- 币安新版文档站是 JS 渲染的，直接抓取会得到空内容；
  **静态镜像 `developers.binance.com/legacy-docs/derivatives/...` 可抓取且与新版逐字节一致**。
- 币安把整站文档以纯文本发布在
  `https://developers.binance.com/en/docs/llms-full.txt` —— 已下载到 `vendor/`。
- 关键结论用**实时探测**交叉验证过（`/fapi/v1/exchangeInfo`、`/time`、各 WebSocket 主机）。

## 最重要的六条结论

1. **条件单已迁移。** `STOP_MARKET` / `TAKE_PROFIT_MARKET` / `STOP` / `TAKE_PROFIT` /
   `TRAILING_STOP_MARKET` 在 `POST /fapi/v1/order` 上一律返回 `-4120`，
   必须改用 `POST /fapi/v1/algoOrder` + `algoType=CONDITIONAL`，
   触发价参数是 **`triggerPrice`** 而不是 `stopPrice`。
   → 搞错的后果不是报错，而是**开仓后止损根本没挂上**。

2. **WebSocket 已按流量类别拆分路由**（`/public` `/market` `/private`），
   旧的无路由路径已停用。**路由错误的连接会握手成功但永远收不到数据** ——
   所以必须有应用层存活检测，不能只看连接状态。

3. **权重上限随环境变化**：实盘 2400/min，测试网 6000/min。
   必须从 `exchangeInfo.rateLimits` 读取，不能硬编码。

4. **测试网 `exchangeInfo.serverTime` 陈旧约 5 天**，而 `/fapi/v1/time` 是准的。
   时间同步只能用后者，否则每个签名请求都会 `-1021`。

5. **`MIN_NOTIONAL` 是逐币种的**（实测 BTCUSDT=50、ETHUSDT=20、XRPUSDT=5），
   从过滤器读取，不要假设常量。

6. **除 `-1021` 外还有 `-5028`**：撮合引擎会再做一次 `recvWindow` 检查，
   请求可以通过网关检查后被拒。两者的处理方式相同。

## 未解决的问题

- `/fapi/v2/account|balance|positionRisk` 的真实权重：文档写 5，changelog 写 10，
  无法在不发签名请求的情况下确定。实现上按文档值处理并通过
  `X-MBX-USED-WEIGHT-1M` 动态观察。
- 测试网 `/futures/data/*` 端点返回非 JSON 垃圾数据，因此**持仓量历史与 OI 排行
  在 Demo 环境不可用**；实现上做了优雅降级（返回空而非报错）。
