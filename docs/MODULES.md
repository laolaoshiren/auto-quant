# 模块地图与扩展指南

本文是一张**地图**：想知道某个功能在哪个文件里、想加一个新东西要动哪几处，从这里查。
它按目录逐个文件列出职责、关键导出、依赖与扩展点，最后给出八条"要加一个新的 X 就改这里"的配方。

搭配阅读：

| 文档 | 关系 |
| --- | --- |
| [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) | 解释**为什么**这样设计。本文只讲**在哪**，不重复论证 |
| [`docs/DEVELOPMENT.md`](DEVELOPMENT.md) | 怎么跑、怎么测、有哪些坑 |
| [`docs/API.md`](API.md) | 逐个端点的请求/响应参考 |
| [`docs/AGENTS.md`](AGENTS.md) | 不可违反的改动规则 |
| [`packages/web/DESIGN.md`](../packages/web/DESIGN.md) | 控制台的**视觉规范**：色板/字号/间距/布局与响应式断点。改前端样式前先读它 |

约定：路径一律相对仓库根；**"要加一个新的 X 就改这里"** 一律指需要真正动手的位置。

---

## 0. 三个包

| 包 | 名字 | 角色 | 有测试吗 |
| --- | --- | --- | --- |
| `packages/shared` | `@aq/shared` | 跨端契约：zod schema、领域类型、指标数学、LLM 供应商目录、符号工具 | ❌ 由 server/web 的测试间接覆盖 |
| `packages/server` | `@aq/server` | Fastify API、币安适配、LLM 客户端、策略引擎、风控引擎、交易运行时、SQLite 存储 | ✅ 有测试（文件数与用例数以 `npm test` 为准，不要写死） |
| `packages/web` | `@aq/web` | React 18 + Vite + Tailwind 控制台 | ❌ 无测试脚本 |

`@aq/shared` 通过 `exports: { ".": "./src/index.ts" }` 直接暴露 **TypeScript 源码**，
没有构建步骤：server 用 `tsx` 跑、web 用 Vite 编译，两边都直接消费 `.ts`。
所以**改 `shared` 会同时影响两端**，改完必须 `npm run typecheck`（它会检查 server + web 两边）。

`packages/shared/src/index.ts` 就是六行 re-export：

```ts
export * from './strategy.js';   export * from './decision.js';
export * from './domain.js';     export * from './llm.js';
export * from './indicators.js'; export * from './symbols.js';
```

---

## 1. `packages/shared/src/` —— 跨端契约

| 文件 | 一句话职责 | 关键导出 | 依赖 | 加新东西时 |
| --- | --- | --- | --- | --- |
| `strategy.ts` | **整个策略配置的形状**，zod 定义 + 三个预设 | `StrategyConfigSchema` / `StrategyConfig` / `StrategyConfigInput`、`defaultStrategyConfig()`、`STRATEGY_PRESETS` / `StrategyPreset`、`CoinSourceConfigSchema`、`IndicatorConfigSchema`、`RiskControlConfigSchema`、`DrawdownGuardSchema`、`ThrottleConfigSchema`、`CircuitBreakerConfigSchema`、`PromptSectionsSchema`、`TIMEFRAMES` / `Timeframe`、`TradingModeSchema` | `zod` | **加一个策略配置项**：在这里加字段（**必须带 `.default()`**，否则老策略会读取失败）。新增技术指标、风控规则、策略预设都从这里开始 |
| `domain.ts` | 枚举、持久化实体的形状、中文标签表、事件总线契约 | `ExchangeIdSchema` / `ExchangeId` / `EXCHANGES`、`LlmProviderIdSchema` / `LlmProviderId` / `LlmProviderDescriptor`、`CLOSE_REASONS`（`as const`）/ `CloseReason`、`CLOSE_REASON_LABELS` / `closeReasonLabel()`、`TRADING_MODE_LABELS`、`TRADER_STATUS_LABELS`、`Trader` / `TraderStatus`、`PositionView`、`OrderRecord`、`TradeRecord`、`DecisionRecord` / `ExecutionLogEntry`、`EquitySnapshot`、`TraderStats`、`ServerEvent` | `zod`、`./strategy.js`、`./decision.js` | **加平仓原因**、**加交易所**：本文件。`TraderStats.winRatePercent` 这类带单位的字段名也在这里定义，改名前先看注释里的历史事故 |
| `llm.ts` | LLM 供应商目录 + 推理默认值 | `LLM_PROVIDERS`（10 家）、`getProvider()`、`providerDefaults()`、`looksLikeReasoningModel()` | `./domain.js` | **加 LLM 提供商**：本文件 |
| `indicators.ts` | 指标数学的**输出形状**（不是算法） | `Kline`、`SymbolInfo`、`TimeframeIndicators`、`DerivativeContext`、`QuantContext`、`MarketSnapshot`、`OiRankRow`、`CandidateCoin` | `./strategy.js` | **加技术指标**：在 `TimeframeIndicators` 加序列字段 |
| `decision.ts` | 模型必须说的那门语言 | `DecisionActionSchema` / `DecisionAction`（`open_long`/`open_short`/`close_long`/`close_short`/`hold`/`wait`）、`OPEN_ACTIONS` / `CLOSE_ACTIONS`、`isOpenAction()` / `isCloseAction()`、`RawDecisionSchema` / `RawDecision`、`Decision`、`RejectedDecision`、`ParsedDecisionSet` | `zod` | **加一个模型动作**：在 `DecisionActionSchema` 加值，并检查 `isOpenAction`/`isCloseAction` 与 `strategy/parser.ts` 的 `ACTION_PRIORITY` |
| `symbols.ts` | 符号规范化与"是否大票" | `normalizeSymbol()`、`baseAssetOf()`、`isMajorSymbol()`、`MAJOR_BASE_ASSETS` | 无 | 改大票定义（目前 `BTC`/`ETH`）：`MAJOR_BASE_ASSETS` |

### `strategy.ts` 为什么每个字段都必须有默认值

`repositories.ts` 读策略时会 `StrategyConfigSchema.safeParse(raw)`，**升级后新增的字段由 zod 默认值补齐**，
所以老行的 `config_json` 不需要迁移就能继续用（`ARCHITECTURE.md` 第 3 节也强调了这一点）。
反过来：**加一个没有 `.default()` 的必填字段，会让所有已存在的策略读取失败并整体回退到默认配置**——
静默地把用户的策略换掉，属于最糟的一类回归。

### `CLOSE_REASONS` 是 `as const`，它驱动 `CloseReason`

```ts
export const CLOSE_REASONS = ['model_decision','stop_loss','take_profit','drawdown_guard',
                              'liquidated','external','protection_unavailable','reconciled'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];
```

`CloseReason` 是从数组**推导**出来的，不是手写的联合类型。这意味着：
- 往数组里加一个字符串，`CloseReason` 自动包含它；
- 序列化 / 反序列化 / 数据库里存的是**稳定机器码**，不是显示文本（翻译它等于改写历史）；
- 中文标签在 `CLOSE_REASON_LABELS`，服务端日志、提示词、控制台三处共用同一张表，
  所以**新加一个原因不可能漏掉某个界面**。

---

## 2. `packages/server/src/` 根级

| 文件 | 职责 | 关键导出 | 依赖 |
| --- | --- | --- | --- |
| `index.ts` | **进程入口**：建目录 → 初始化 DB → 解析密钥 → 建 owner → 播种默认策略 → 建立无凭据公开行情连接 → 组装 `TraderManager` / `BalanceService` / Fastify → `listen` → 2 秒后恢复运行中的机器人 → 再 4 秒后对全部机器人对账 → 注册优雅关闭 | 无导出（纯副作用） | 几乎所有模块 |
| `env.ts` | **路径与配置的唯一来源**。手写的 `.env` 解析（真实环境变量优先）；`REPO_ROOT`；`data/` 布局 | `env`、`REPO_ROOT`、`dbPath`、`webDistDir`、`ensureDataDir()`、`resolveMasterKey()`、`resolveJwtSecret()` | `node:fs` / `node:path` |
| `logger.ts` | 零依赖结构化日志，一行一条；带颜色的 TTY 输出；可插拔 sink（控制台日志面板用） | `createLogger(scope)` → `Logger`、`setLogSink()`、`LogSink` | `./env.js` |
| `events.ts` | 进程内的服务端 → 浏览器事件扇出，带 200 条环形缓冲（新开的控制台不是空白） | `EventBus`、`eventBus` | `@aq/shared` |
| `crypto/vault.ts` | **凭据保险库**：AES-256-GCM 加解密、scrypt 口令哈希、密钥掩码 | `Vault`（`encrypt`/`decrypt`/`encryptOptional`/`decryptOptional`）、`hashPassword()`、`verifyPassword()`、`maskSecret()` | `node:crypto` |
| `db/index.ts` | `node:sqlite` 的薄封装：迁移、预编译语句缓存、值归一化、事务 | `Db`、`initDb()`、`getDb()`、`closeDb()`、`SqlValue` | `node:sqlite`、`./schema.js` |
| `db/schema.ts` | **SQLite 全部表定义与迁移**，`PRAGMA user_version` 跟踪 | `MIGRATIONS`、`Migration` | 无 |
| `services/balance.ts` | 为**显示**而读余额：每个账户一个长寿命 REST 客户端（时钟偏移可复用）、20 秒缓存、错误当值返回 | `BalanceService`（`get`/`getAll`/`invalidate`/`walletBalanceOf`）、`BalanceResult` | `binance/account.js`、`binance/rest.js`、`crypto/vault.js`、`store/repositories.js` |

### 加一张表 / 加一个字段

`db/schema.ts` 是**追加式迁移列表**，绝不修改已发布的迁移 SQL：

```ts
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial',           sql: M1_INITIAL },
  { version: 2, name: 'trade-accounting',  sql: M2_TRADE_ACCOUNTING },
  // 新加：{ version: 3, name: '...', sql: M3_... }
];
```

`Db.migrate()` 逐个执行 `version > 当前 user_version` 的迁移，**每个迁移各自在一个事务里**，
失败就回滚并抛出带版本号与名字的错误。加字段就用 `ALTER TABLE ... ADD COLUMN`；
`M2_TRADE_ACCOUNTING` 是范例（还带了一段 backfill `UPDATE`，把历史行也算对）。
注意 `db/index.ts` 的 `normalise()` 会把 boolean 转成 1/0、`NaN`/`Infinity` 转成 `null`、
对象转成 JSON 字符串——这是 `node:sqlite` 绑定的边界适配。

---

## 3. `packages/server/src/binance/` —— 交易所连接层

这个目录的实现依据是 `docs/research/` 里的实测调研。**改之前先读对应文档**，里面每条都对应一个
"踩了会亏钱或长时间静默失败"的坑。

| 文件 | 一句话职责 | 关键导出 | 依赖 |
| --- | --- | --- | --- |
| `endpoints.ts` | 环境 → REST/WS 主机映射；WebSocket **流量类别路由**表；按流的存活阈值 | `BinanceEnvironment`、`BinanceEndpoints`、`BINANCE_ENDPOINTS`、`resolveEndpoints()`、`WsRoute`、`routeForStream()`、`groupStreamsByRoute()`、`buildMarketStreamUrl()`、`buildUserStreamUrl()`、`stalenessThresholdMs()` | 无 |
| `types.ts` | 币安线格式类型，**字段名逐字对齐实盘响应**（含币安自己不一致的 camelCase）；错误类与错误分类 | 全部 `Binance*` 接口、`BinanceApiError`（含 `isTimestampError` / `isRateLimited` / `isFilterError` / `isWrongEndpointForConditional` / `wouldImmediatelyTrigger` / `isDuplicateClientId` …） | 无 |
| `rest.ts` | 底层 REST 传输：HMAC-SHA256 签名（`signature` 最后追加）、时钟同步、权重预算与软限速、`-1021`/`-5028` 重同步重试、429 退避、确定性错误不重试 | `BinanceRest`（`publicGet`/`signedRequest`/`keyedRequest`/`syncTime`）、`WEIGHT_LIMIT_DEFAULT`、`HttpMethod` | `./endpoints.js`、`./types.js` |
| `account.ts` | 只读账户快照，刻意**不依赖** symbol registry（一次请求 vs 三次）；`-1121`/404 时回落到 v2 | `AccountState`、`AccountBalanceSnapshot`、`fetchAccountState()`、`fetchBalanceSnapshot()`、`marginAssetOf()` | `./rest.js`、`./types.js` |
| `income.ts` | `/fapi/v1/income` 收入流水：按 7 天分页、汇总、按窗口归属资金费 | `IncomeSummary`、`fetchIncome()`、`summarizeIncome()`、`fundingInWindow()` | `./rest.js`、`./types.js` |
| `market.ts` | 公开行情端点：K 线（**去掉未收盘的那根**）、24h ticker、markPrice/funding、持仓量、主动买卖流、多空比 | `BinanceMarketData`、`toKline()` | `./rest.js`、`./symbols.js`、`./types.js` |
| `symbols.ts` | **`exchangeInfo` 过滤器缓存 + 全部下单取整逻辑**。这是防止 `-1111`/`-4164`/`-2019` 的那一层 | `SymbolRegistry`（`fromExchangeInfo`、`roundQuantity`、`roundPriceValue`、`roundTriggerPrice`、`isValidTrigger`、`notionalToQuantity`、`minNotional`…）、`stepDecimals()`、`roundDownToStep()`、`roundToStep()`、`roundPrice()`；re-export `normalizeSymbol`/`baseAssetOf` | `@aq/shared`、`./types.js` |
| `broker.ts` | **下单语义层，本目录最需要小心的文件**：条件单路由到 Algo 端点、归一化 `PlacedOrder`、持仓/杠杆/保证金、撤单（两边都撤）、成交查询、dry-run 模拟 | `BinanceBroker`、`PlaceOrderRequest`、`PlacedOrder`、`ExchangePosition`、`CONDITIONAL_ORDER_TYPES`、`normalizeStandard()`、`normalizeAlgo()`、`isFilled()`、`BrokerOptions` | `./account.js`、`./income.js`、`./market.js`、`./rest.js`、`./symbols.js`、`./types.js` |
| `ws.ts` | 长连接韧性：静默僵尸检测、23h 主动轮换、**只有收到真实数据才重置退避**、重叠连接拆除；listenKey 生命周期；用户数据流（**只用于告警**） | `ResilientStream`、`StreamState`、`ResilientStreamOptions`、`BinanceMarketStream`、`MarketStreamHandlers`、`BinanceUserDataStream`、`UserStreamHandlers`、`sleepMs` | `ws`、`./endpoints.js`、`./rest.js`、`./types.js` |
| `bootstrap.ts` | **装配 + 预检**：时钟同步 → `exchangeInfo`（权重要读、registry 要建）→ 组装 connection bundle；`preflight()` 逐项报告可交易性 | `ExchangeConnection`、`ConnectOptions`、`connectExchange()`、`preflight()`、`PreflightCheck` | 本目录全部 + `../logger.js` |

### 依赖方向

```
bootstrap ──► broker ──► symbols, market, account, income, rest, types
                  └────► ws (只依赖 rest + endpoints + types)
```

没有反向依赖：`rest.ts` 不知道 broker 的存在，`account.ts` 不引 registry。

### `PlacedOrder` 是 broker 的语义契约（新增交易所必须满足）

`AutoTrader` 只认这个归一化形状，所以任何新交易所适配器都要提供等价语义：

| 交易循环调用 | 语义要求 |
| --- | --- |
| `getAccountState()` | 返回 `{ equity, walletBalance, availableBalance, unrealizedPnl, marginUsed, openOrderMargin }` |
| `getPositions(symbol?)` | 只返回**非零**仓位；方向已推断；带 `markPrice` / `liquidationPrice` / `unrealizedPnlPercent` / `marginUsed` |
| `setLeverage()` / `setMarginType()` | 幂等；"无需修改"这类错误算成功 |
| `placeOrder(request)` | 返回 `PlacedOrder`；**数量向下取整、价格对齐 tick、触发价方向正确**（见 `broker.ts` 的注释：这是适配器自己的责任，不是风控的） |
| `waitForFill(order)` | 轮询到终态或超时；超时返回最后一次观测 |
| `cancelAllOrders(symbol)` | **同时撤普通单与条件单** |
| `getUserTrades(symbol, limit)` | 成交历史，`orderId` 必须能对上 `placeOrder` 返回的 id（否则手续费永远是 0） |
| `getIncome({ startTime })` | 收入流水（资金费、以及"账户碰过哪些标的"的发现来源） |
| `getAlgoOrder(algoId)` | 查询**已不在挂单列表里**的条件单终态（`FINISHED` / `CANCELED`）；这是区分"止损触发"与"止盈触发"的唯一可靠信号 |
| `getMarkPrice(symbol)` | 标记价 |

---

## 4. `packages/server/src/llm/` —— 提供商无关的模型客户端

| 文件 | 一句话职责 | 关键导出 | 依赖 |
| --- | --- | --- | --- |
| `types.ts` | 层内的提供商中立契约 + usage/finish_reason 归一化 | `ChatMessage`、`ChatRequest`、`ChatUsage`、`FinishReason`、`ChatResult`、`WireUsage`、`OutboundRequest`、`ConversationParts`、`EMPTY_USAGE`、`splitSystem()`、`toTokenCount()`、`normalizeUsage()` | 无 |
| `errors.ts` | **错误归一化与可重试性判定**。所有厂商判断都集中在这里 | `LlmError`、`LlmErrorKind`、`isRetryable()`、`kindForStatus()`、`isRetryableKind()`、`extractMessage()`、`bodyHaystack()`、`classifyHttpError()`、`classifyMinimaxBaseResp()`、`emptyCompletionError()`、`timeoutError()`、`connectionError()`、`abortError()` | 无 |
| `http.ts` | 各适配器共用的 HTTP 管道：URL 拼接、安全 JSON 解析、`Retry-After` 解析、单次 POST、MiniMax 的 200-内错误快速失败 | `joinUrl()`、`safeJsonParse()`、`JsonResponse`、`parseRetryAfter()`、`executeJsonRequest()`、`executeJsonRequestSafe()` | `./errors.js`、`./types.js` |
| `openaiCompatible.ts` | **一个适配器服务所有 OpenAI 方言**（DeepSeek/OpenAI/Qwen/Grok/Kimi/MiniMax/OpenRouter/custom），并把各家的偏差显式处理掉 | `buildBody()`、`buildRequest()`、`parseResponse()`、`extractText()`、`stripThinkTags()`、`normalizeFinishReason()`、`rejectsSamplingParameters()`、`supportsResponseFormat()`、`supportsStrictSchema()`、`maxTokensField()`、`defaultBaseUrl()` | `@aq/shared`、`./http.js`、`./errors.js`、`./types.js` |
| `anthropic.ts` | 原生 Messages API：`system` 是顶层字段、`content` 是类型化块数组、`x-api-key` + `anthropic-version`、新模型拒绝 sampling 参数 | `buildBody()`、`buildRequest()`、`parseResponse()`、`extractText()`、`normalizeStopReason()`、`rejectsSamplingParameters()`、`ANTHROPIC_VERSION` | `./http.js`、`./errors.js`、`./types.js` |
| `gemini.ts` | 原生 `generateContent`：key 走 query、角色是 `model`、`systemInstruction` 顶层、schema 必须翻译成**全大写类型**并丢掉不支持的键 | `buildBody()`、`buildRequest()`、`parseResponse()`、`toGeminiSchema()`、`extractText()`、`hasFunctionCall()`、`normalizeFinishReason()` | `./http.js`、`./errors.js`、`./types.js` |
| `client.ts` | **统一策略层**：按 `openAiCompatible` 分派 → 各家 `buildRequest`/`parseResponse`；超时、重试、全抖动退避、结构化日志（**永不记录 API Key 本身**，只记掩码）；连接探测；构造时用 `urlGuard` 拒绝内网 `baseUrl`（这是所有模型请求的必经之路，连库里存着的旧地址也会被拦下） | `LlmClient`、`LlmClientOptions`、`ConnectionProbe`、`backoffDelayMs()` | `@aq/shared`、`./errors.js`、`./http.js`、`./urlGuard.js`、三个适配器 |
| `discovery.ts` | 用**用户自己的 key** 向厂商拉取**当前可用**模型列表（三种响应方言归一化），失败回落内置提示并标记 `source: 'fallback'`；请求前同样过 `urlGuard` | `discoverModels()`、`DiscoverModelsResult` | `@aq/shared`、`./errors.js`、`./urlGuard.js` |
| `urlGuard.ts` | 出站 URL 白名单（SSRF 防护）：只允许 http(s)，拒绝回环 / 链路本地（含云元数据）/ RFC1918 / CGNAT / ULA / 组播，含 IPv4-mapped 与 NAT64 形式；校验**字面主机**，不做 DNS 解析 | `checkOutboundUrl()`、`assertOutboundUrlAllowed()`、`UrlGuardVerdict` | `node:net` |

### `LlmClient` 的调用面

- `testConnection(): Promise<ConnectionProbe>` —— 一次极小的补全，一次验证 key + baseURL + model id + 鉴权头。
  探测预算刻意是 **256 tokens 而不是 16**：推理模型会先烧掉输出预算再说话，16 tokens 会返回"空内容"，
  看起来像 key 坏了。
- `chat(messages, { probe? })` —— 带重试的主路径。
- `complete(systemPrompt, userPrompt)` —— 策略引擎用的便捷包装（system + user 两条消息）。

重试策略：只有 `isRetryable(error)` 为真才重试；服务端给了 `Retry-After` 就优先用它；
否则用**全抖动**（而不是确定性指数退避）——共享故障之后每个实例同时重试，正是 IP 封禁的起点。

---

## 5. `packages/server/src/market/` —— 行情与指标

| 文件 | 一句话职责 | 关键导出 | 依赖 |
| --- | --- | --- | --- |
| `indicators.ts` | **零依赖技术指标实现**，Wilder 原始定义（不是 EMA 近似），固定长度对齐、无未来函数 | `ema()`、`sma()`、`rsi()`、`atr()`、`macd()`、`last()`、`computeTimeframeIndicators()`、`latestIndicatorSnapshot()` | `@aq/shared` |
| `service.ts` | 把"模型看到的行情画面"组装出来：全市场 ticker/premium 一次拉取 + 短缓存、闭合 K 线缓存、快照组装、衍生品上下文、主动买卖流（零额外请求）、横截面筛选、OI 排行 | `MarketDataService`（`buildSnapshot`/`buildSnapshots`/`screenUniverse`/`screenOpenInterestGrowth`/`getOiRanking`/`invalidate`） | `@aq/shared`、`binance/market.js`、`binance/symbols.js`、`binance/types.js`、`./indicators.js` |

### 加指标时的两条不变量（`indicators.ts` 头部注释）

1. **无未来函数**：`out[i]` 只是输入到 `i` 为止的函数。偷看一眼 `i+1`，实盘决策和回测都会变成幻觉。
2. **固定长度对齐**：序列长度恒等于输入长度，预热期为 `null`，**不做压缩**——
   压缩掉预热段正是 off-by-N 对齐 bug 的来源。`closes[i]` 和 `rsi['14'][i]` 永远指同一根蜡烛。

还有两个必须记住的具体事实：MACD 的 signal line 是在**压缩后的有效段**上算再映射回原索引的
（直接对含 `null` 的数组算 signal 会把前几个值拖向 0，这是经典的 MACD 对齐 bug）；
RSI 与 ATR 的第一个可计算值都在索引 `period`（比同周期 EMA 晚一根），因为它需要两个收盘价。

---

## 6. `packages/server/src/strategy/` —— 策略引擎

| 文件 | 一句话职责 | 关键导出 | 依赖 |
| --- | --- | --- | --- |
| `prompt.ts` | **两段提示词的组装 + token 预算**。系统提示词 8 段（角色 / 模式 / **硬约束** / 频率 / 入场标准 / 决策流程 / **输出格式** / 自定义），硬约束段由 `RiskControlConfig` 动态生成 | `PromptContext`、`PromptAccountInfo`、`PromptPosition`、`buildSystemPrompt()`、`buildUserPrompt()`、`formatMarketData()`、`estimateTokens()`、`estimateCandidateChars()`、`candidateBudget()`、`PROMPT_TOKEN_BUDGET`、`formatNumber` / `formatPercent` / `humanDuration` | `@aq/shared` |
| `coins.ts` | 候选池构建（`static` / `coinpool` / `oi_top` / `mixed`），多源标签保留，持仓无条件入选，**按提示词预算裁剪** | `selectCandidates()`、`CoinSelectionResult` | `@aq/shared`、`../market/service.js`、`./prompt.js` |
| `parser.ts` | **把模型的自由文本变成可执行决策**：结构与语义分离、思维链提取、括号配平 JSON 提取、编码/结构修复、字段别名、逐条校验 | `parseDecisionResponse()`、`extractCoTTrace()`、`extractDecisions()`、`hasDecisionBlock()`、`repairEncoding()`、`sortDecisions()`、`ParseContext` | `@aq/shared`、`zod` |
| `healthCheck.ts` | **策略体检**：用真实行情 + 真实提示词 + 真实模型 + 真实风控，对**模拟账户**跑完整链路，逐阶段报告 | `checkStrategy()`、`CheckStage`、`StrategyCheckResult`、`StrategyCheckSample` | `binance/bootstrap.js`、`llm/client.js`、`market/service.js`、`risk/engine.js`、`./coins.js`、`./parser.js`、`./prompt.js` |

### 解析器的四层提取策略（`extractDecisions`）

按顺序尝试，任一层成功即止：

1. `<decision>` 块内的 ```json 代码块
2. `<decision>` 块内的裸平衡 JSON
3. 全文任意 ```json 代码块
4. 全文第一个**括号配平**的 JSON 值（`findBalancedJson` 会跳过字符串字面量与转义）

第 4 层是必要的：用 `indexOf(']')` 会在符号名或理由字符串里出现 `]` 时截断。

**"结构宽容、语义严格"** 是这里的核心取舍：格式烂的响应产出"没有决策"，而不是"畸形订单"。
数值性的限制（钳制、仓位大小）全归风控；这里拒绝的都是**结构上不可能执行**的东西
（未知 action、标的不在候选集、平仓方向与持仓不符、重复开仓）——并且**每一类拒绝都带理由上报**，
进入 `DecisionRecord.executionLog`，操作员能看到。未知 action 绝不会被静默丢弃。

`hasDecisionBlock()` 单独存在是因为两个东西必须区分：**"返回了空数组 `[]`"是一个合法且正确的答案**，
而"根本没有 `<decision>` 块"意味着模型没完成要求的输出（通常是输出预算耗尽）——把它们混为一谈会掩盖真实的配置问题。

---

## 7. `packages/server/src/risk/engine.ts` —— 硬风控引擎

| 导出 | 职责 |
| --- | --- |
| `RiskEngine`（`review()`） | 审查一整批决策。**平仓先于开仓**，且维护滚动预算（`positionCount` / `marginUsed` / `entriesThisCycle`）让同批次的开仓互相可见 |
| `RiskEnvironment` / `RiskAccount` / `RiskRejection` / `RiskVerdict` | 引擎的输入输出契约。注意注释：`RiskEnvironment` **刻意不含模型输出**——它的工作是拿事实评判提案 |
| `shouldCloseForDrawdown()` | 回撤守卫（纯函数，机械规则，跑在问模型之前） |
| `checkCircuitBreakers()` | 熔断器（纯函数，只阻止**新开仓**，不平仓） |
| `CircuitBreakerState` / `CircuitBreakerVerdict` | 上面那个的输入输出 |

### `reviewOpen` 的实际检查顺序（14 步）

编号与源码里的 `/* --- N. --- */` 标记**一一对应**（0–13），想核对时直接按标记 grep 即可。

0. 账户权益 > 0 ｜ 标的有可用价格（**绝不在没有价格时盲目下单**）
1. 持仓槽位未满 ｜ 2. 置信度达标
3. **杠杆钳制**（BTC/ETH 与山寨分别设限；模型没给就用 `defaultLeverage`）
4. 止损存在（缺省则按 `fallbackStopLossPercent` 推算）｜ 5. 止盈同理
6. **保护价位必须在正确一侧**（多头止损低于现价等）
7. 盈亏比达标 ｜ 8. 名义价值上限（按权益倍数）｜ 9. 保证金预算（同时受 `maxMarginUsage` 与可用余额约束，超了就缩名义价值）
10. 最小下单量（交易所 `MIN_NOTIONAL` 与配置值的**较大者**）｜ 11. 节流（每轮/每小时开仓上限）
12. **数量可按步长取整**（取不到整数手直接拒绝）
13. 把止损/止盈各自**钳到入场价的安全侧**（`clampStopLoss` / `clampTakeProfit`，两个镜像函数）

最后按实际可取整数量反推最终名义价值，算出真实 `riskUsd` 与"占权益百分比"，然后写进 `adjustments`。

`reviewClose` 只有一条限制：最小持仓时间。**"拒绝平仓"是把小亏变成爆仓的经典方式。**

> `clampStopLoss` 与 `clampTakeProfit` **不能合并**成一个"把价格钳到安全侧"的函数：
> 那会静默地让每一笔交易的止盈失效。这个 bug 在开发期被单元测试抓到过一次。

---

## 8. `packages/server/src/trader/` —— 交易运行时

| 文件 | 一句话职责 | 关键导出 | 依赖 |
| --- | --- | --- | --- |
| `autoTrader.ts` | **一个机器人的自主循环**（12 步周期，见 `DEVELOPMENT.md` 第 5 节的表）。含对账、回撤守卫、执行、保护单、紧急平仓、审计落库 | `AutoTrader`（`runOnce` / `reconcileTradeHistory` / `currentStatus`）、`AutoTraderDeps`、`DecisionModel` | `@aq/shared`、`binance/*`、`market/service.js`、`risk/engine.js`、`strategy/*`、`store/repositories.js`、`./roundTrips.js` |
| `manager.ts` | **多机器人生命周期**：每个机器人独立的交易所连接 / 行情缓存 / 模型客户端；启动预检；停止；单次运行；对账；重启恢复；用户数据流（**只告警**） | `TraderManager`（`startTrader`/`stopTrader`/`runCycleNow`/`reconcileTrader`/`reconcileAllTraders`/`stopAll`/`resumePersisted`/`isRunning`/`runningIds`/`statusOf`）、`StartResult` | 大多数上层模块 |
| `roundTrips.ts` | **从交易所成交历史重建完整回合**（净盈亏口径与对账的基础）；本地/交易所回合的匹配键 | `reconstructRoundTrips()`、`roundTripKey()`（含 `entryOrderId`，同标同价同量的两个回合不冲突）、`roundTripQueryKey()`（仅用于「本地行没记入口订单号」的回退查找）、`ReconstructedTrade` | `binance/types.js` |

`DecisionModel` 是**结构化声明**的接口（只有 `complete()`），不是导入具体客户端——
这是为了让交易循环可以用桩测试、并且不耦合任何提供商。`manager.ts` 在组装时把 `LlmClient` 包一层塞进去。

`TraderManager.reconcileTrader()` 刻意用**一个会抛错的桩模型**（`complete: () => Promise.reject(...)`）：
对账只读交易所成交历史、从不问 LLM，把它变成结构性事实，意味着**一个坏掉的 API Key 永远无法阻止账本被修正**。
机器人**正在运行**时，该端点不再另建一个 `AutoTrader`，而是走 `AutoTrader.runReconcile()`——它会先等
在跑的那一轮周期结束（有超时上限），因为两个实例并发对账会重复记账。

`reconcileAllTraders()` 是**顺序**执行的，理由是权重预算：一次开机就并发十几个对账会花光实盘交易需要的额度；
而且单个机器人失败不能中断其它机器人的修正。

---

## 9. `packages/server/src/store/` —— 数据访问

| 文件 | 一句话职责 | 关键导出 | 依赖 |
| --- | --- | --- | --- |
| `repositories.ts` | **所有仓储**（每个都是一组函数/对象）+ 统计聚合。行字段的 snake_case ↔ 领域对象 camelCase 在这里转换 | `users`、`exchanges`、`aiModels`、`strategies`、`traders`、`positions`、`orders`、`trades`、`decisions`、`equity`、`tradeEvents`、`settings`、`runtimeLogs`、`computeTraderStats()` | `@aq/shared`、`../db/index.js` |

### 几个必须知道的行为

- **`trades.insert()` 是唯一做账的地方。** 调用方传 `grossPnl` 与各项费用，`net_pnl`
  和 `pnl_percent` **在这里统一算出来**，而不是让每个调用点各算一遍然后互相不一致。
  公式：`net_pnl = grossPnl − entryFee − exitFee − fundingFee`。
- **`trades.insert()` 还负责给审计记录封顶**（每个机器人最近 500 条），`runtimeLogs.write()` 同理（全局 500 条）。
- **`orders.exchangeOrderIds(traderId)` 是对账的归属闸门**：只有本机器人挂过的交易所订单号集合。
- **`equity.latest()` 读的是最新快照**，所以已停止的机器人必须由对账流程补写一条，
  否则它的显示权益会停在最后一轮决策的历史数字上。
- **`decisions.log()` 是审计入口**：提示词、思维链、原始响应、执行日志、候选集、token 用量，一次写完。
- **`tradeEvents`** 是节流记账（开/平仓事件），**持久化**，所以重启后节流限制依然有效。
  `entriesThisHour()` / `lastFor()` 被风控和再入冷却使用。
- **`computeTraderStats()`** 的 `realizedPnl` 是**净**值，毛值在 `grossRealizedPnl`；
  `winRatePercent` 是 0–100 的百分比（字段名带单位是刻意的），`wins`/`losses` 是真实计数
  （**不要从百分比反推计数**，那是有损的，曾经把"1 笔"变成"100 盈"）。胜负有**按净盈亏**分类。

---

## 10. `packages/server/src/simulate/` —— 模拟交易所与回放行情

| 文件 | 一句话职责 | 关键导出 | 依赖 |
| --- | --- | --- | --- |
| `simulatedExchange.ts` | **不是空壳的模拟交易所**：真实仓位账本与保证金、市价成交、以及**在价格穿越时真的触发止损止盈**（用 K 线最高/最低）；刻意复刻币安的 tick 精度（`-1111`）与立即触发（`-2021`）拒绝 | `SimulatedExchange`、`SimulatedFill`、`SimulatedPriceStep`、`SimulatedExchangeOptions` | `binance/broker.js`、`binance/symbols.js`、`binance/types.js` |
| `replayMarketData.ts` | 用录制好的 K 线替代实时 API 的 `MarketDataService`：**无未来函数**（只看 `closeTime <= 模拟时钟` 的蜡烛）、**复用生产指标代码**；衍生品上下文如实报告为缺失而不是编造 | `ReplayMarketData`、`ReplaySource`、`ReplayMarketDataIsCompatible` | `@aq/shared`、`binance/symbols.js`、`market/indicators.js` |

`simulatedExchange` 里有一个容易被误删的细节：`resolvedAlgo` 映射记录了已不再挂着的条件单终态。
它存在的原因是——币安在仓位因 `closePosition` 条件单平掉后**会把幸存的那张也一起移除**，
所以"不在挂单列表里"对两张单都成立。没有这个映射，**每一笔止盈都会被记成止损**。

---

## 11. `packages/server/src/scripts/` —— 可执行入口

这些不是"一次性脚本"，它们是**验证手段**，改动时要一起维护。

| 文件 | 命令 | 干什么 | 碰真钱吗 |
| --- | --- | --- | --- |
| `verifyPipeline.ts` | `npm run verify` | 真实币安行情 → 选币 → 指标 → 提示词 → 解析一份内置响应 → 风控审查。**不需要任何密钥，不下单** | 否 |
| `simulate.ts` | `npm run sim` / `npm run sim:live` | 真实历史 K 线回放 + 模拟交易所 + 脚本化（或真实）模型，跑 80（或 12）轮，结尾跑 **15 项校验**（**当前实测 15/15 全通过**）。写**临时**数据库 | 否 |
| `demoCycle.ts` | `npm run demo` | 往**真实**数据库写一轮 `[DEMO]` 前缀的完整审计数据（真实行情 + 脚本化模型 + 自己的 `SimulatedBroker`）；`--clean` 清除 | 否 |
| `liveSmokeTest.ts` | `npx tsx .../liveSmokeTest.ts --confirm` | **实盘接线冒烟**：预检 → 单向模式 → 杠杆 → 市价开仓 → 挂止损 → 挂止盈 → **回读交易所确认** → 撤单 → 平仓 → 确认账户干净 | ✅ **是** |
| `resetAdminPassword.ts` | `npx tsx .../resetAdminPassword.ts` | **锁死时的后门**：直接改库里的管理员用户名/密码（调 `generatePassword()` / `generateUsername()`，与首启一致）。`deploy/up.sh` 的 `reset-credentials` 会调它 | 否 |

### `simulate.ts` 的脚本化模型是刻意的

`makeScriptedModel()` 有**被模拟盘账本的完全知情权**，这让每一条执行路径都能按计划发生，
而不是指望随机行情自己撞上。它按入场序号 6 个一循环安排覆盖：

| 阶段 | 安排 | 验证什么 |
| --- | --- | --- |
| `0 / 1 / 3` | 很紧的保护（0.2–0.3% 止损，止盈刚好过 1.2 盈亏比下限） | 加密市场几根 5 分钟 K 线就能走到，**止损和止盈都会被真实触发** |
| `2 / 4` | 宽保护，故意持有 | **模型主动平仓**这条路径 |
| `4` | 额外提 100x 杠杆 + 50 000 USDT 名义价值 | **风控确实在钳制**，而不是仅仅被配置了 |
| `5` | 提 confidence 10（低于下限） | **风控确实在拒绝** |

相位计数的是**提案数而不是被接受的入场数**。原因写在注释里：低置信度那一相会被（正确地）拒绝，
如果按入场数推进相位，就会被永远卡在同一个被拒提案上，后面的计划永远走不到——测试工具把自己饿死了。

`sim:live`（`--live`）下，那 9 项"依赖模型愿意交易"的校验会降级为**提示**（`soft`），
因为真实模型完全有权每一轮都选择不交易。

---

## 12. `packages/server/src/api/`

| 文件 | 一句话职责 | 关键导出 | 依赖 |
| --- | --- | --- | --- |
| `server.ts` | **全部 HTTP 路由 + WebSocket 事件流 + 静态控制台托管**。含请求 zod schema、错误处理、`guard()` 包装、实时交易所视图 | `buildServer()`、`ApiDependencies`、`bootstrapOwnerAccount()`、`publicAccount()`（把账户行里的密钥剥掉再序列化；提成模块级纯函数就是为了能直接单测） | 几乎全部 server 模块 |
| `auth.ts` | 手写 HS256 JWT（签发/校验，`timingSafeEqual` 比较签名）+ Fastify preHandler 守卫 + 首启密码生成 + **令牌撤销判定**（`credAt` 与库中"凭据变更时间"等值比较）；`extractToken()` 默认只认 `Authorization` 头 | `signToken()`、`verifyToken()`、`isTokenRevoked()`、`TOKEN_TTL_SECONDS`、`TokenPayload`、`requireAuth()`、`extractToken()`、`generatePassword()`、`generateUsername()`、`AuthedRequest` | `node:crypto`、`fastify` |
| `loginThrottle.ts` | 登录失败节流：按**用户名**与**来源 IP** 两个维度计数、指数锁定，`Map` 有 LRU + 过期双重上限（没有上限的节流器本身就是一条内存耗尽路径） | `FailureThrottle`、`USERNAME_THROTTLE_OPTIONS`、`IP_THROTTLE_OPTIONS` | 无（刻意零依赖） |
| `serialize.test.ts` | `publicAccount()` 的回归测试：**密钥必须被剥掉**，其余字段原样透传（多一个字段不该被静默丢掉，也不该把 `api_secret_enc` 漏出去） | —— | `node:test`、`./server.js` |

### 路由的两类失败形式（容易踩的坑）

`docs/API.md` 开头写明了约定：**业务失败返回 `HTTP 200 + { ok: false, error }` 还是 `4xx`，两种都存在**。
调用方应**优先检查 `ok` 字段**。具体地：

- 余额读取 `GET /api/exchange-accounts/:id/balance`：失败也是 **200**，body 里 `ok: false`。
- 对账 `POST /api/traders/:id/reconcile`：失败是 **400 + `ok: false`**。
- `guard()` 包装的处理器：抛出的错误变成 **400**（或错误自带的 `statusCode`）。
- 全局错误处理器把 ≥500 记日志后原样返回 `{ error }`。

其它必须知道的细节：

- 路由里**只有 `/api/health` 与 `/api/auth/login` 不需要认证**，
  其余全部走 `requireAuth`。
- 有一个 `addContentTypeParser('*')`：把空 body 与各种奇怪的 Content-Type 统一成 `undefined` / JSON。
  这是为了让 `/start`、`/stop`、`/run-once`、`/test` 这些**可选 body 的 POST**
  能从浏览器、curl、PowerShell 里都能调（Fastify 默认会对某些 Content-Type 直接回 415）。
- 静态控制台只在 `packages/web/dist` **存在时**才注册；`setNotFoundHandler` 对 `/api` 前缀回 404 JSON，
  其余回落到 `index.html`（SPA 客户端路由）。
- `/api/events` 是 WebSocket，token 从 **query 参数**取（浏览器无法给 WebSocket 升级请求设 header），
  连上后先回放最近 30 条历史，避免新开的控制台空白。**只有这一个端点接受 `?token=`**；
  REST 路由只认 `Authorization` 头（URL 会进代理日志、浏览器历史和 `Referer`）。

---

## 13. `packages/web/src/` —— React 控制台

技术栈：React 18 + Vite 6 + Tailwind + `zustand`（状态）+ `recharts` / `lightweight-charts`（图表），
路由是 `react-router-dom` v6。

### 入口与路由

| 文件 | 职责 |
| --- | --- |
| `main.tsx` | `createRoot` + `<BrowserRouter>` + `<App />`，挂载 `Toaster` |
| `App.tsx` | 全部路由 + `RequireAuth` 包裹。`/settings` 保留为**重定向**到 `/models`（老书签不 404） |
| `components/Layout.tsx` | 侧边导航 + 顶部状态条。导航**数据**不在这个文件里，见 `components/nav.ts` |
| `components/nav.ts` | **导航表的唯一来源**：`NAV_ITEMS`（`{ to, label, icon, jump }`，`icon` 是 lucide 组件）+ `pageTitleFor()` 顶栏标题判定。侧栏与命令面板共用它，避免"加了一个页面只有侧栏有"的漂移 |

实际路由（`App.tsx` 为准）：`/`（总览）、`/traders`、`/traders/:id`、`/traders/:id/decisions/:recordId`、
`/strategy`、`/strategy/:id`、`/market`、`/models`、`/exchanges`、`/account`、`/settings`（重定向）、
`/data`、`/faq`、`*`（NotFound）。

### `lib/` —— 无 React 依赖的逻辑层

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `api.ts` | **唯一的后端客户端**。所有请求走 `/api`，token 存 localStorage，`ApiError`，401 触发全局登出回调；同时把后端返回形状声明成 TS 类型 | `api`（一个对象，按资源分组的方法）、`ApiError`、`getToken`/`setToken`/`clearToken`/`getStoredUser`/`setStoredUser`、`setUnauthorizedHandler`、`eventStreamUrl()`、以及 `Health`/`Catalog`/`SystemStatus`/`TraderRow`/`ExchangeBalance`/`PreflightCheck`/`StrategyCheckResult`/`MarketSymbol` 等接口 |
| `store.ts` | **两个 zustand store**：`useApp`（会话 / 目录 / 系统状态 / 机器人列表，慢）与 `useEvents`（WebSocket 实时日志、订单、持仓、通知，快）。拆开的理由：繁忙的 socket 帧只重渲染真正读它的面板 | `useApp`、`useEvents`、`selectTraderLive()`、`cachedUser`、`SessionStatus`、`SocketStatus`、`Toast`、`TraderLive` |
| `hooks.ts` | 轮询与 UI 辅助 | `usePolled()`、`fallbackInterval()`、`useDocumentTitle()`、`useCopy()`、`useTicker()`、`QueryState` |
| `actions.ts` | "立即运行一轮"与"手动对账"的交互封装（含 toast 文案） | `useRunOnce()`、`useReconcile()`、`reconcileSummary()`、`ReconcileOutcome` |
| `format.ts` | 全部格式化函数与颜色 | `fmtNum`/`fmtUsd`/`fmtAsset`/`fmtSigned`/`fmtPercent`/`fmtPrice`/`fmtQty`/`fmtInt`/`fmtCompact`/`fmtDuration`/`fmtTime`/`fmtDateTime`/`fmtLatency`/`fmtProfitFactor`/`timeAgo`/`sideLabel`/`pnlColor`/`safeJson`/`clamp`、`BALANCE_LABEL`、`DEFAULT_SETTLE_ASSET` |
| `strategy.ts` | 策略草案的工具：套用预设、预校验、深拷贝 | `applyPreset()`、`presetById()`、`validateStrategy()`、`cloneConfig()`、`ValidationResult` |
| `summaries.ts` | 平仓原因等标签的本地兜底 + 摘要 store | `useSummaries`、`closeReasonLabel()` |

> ⚠️ `closeReasonLabel` 在 `@aq/shared`（`domain.ts`）和 `web/src/lib/summaries.ts` **两处都有**。
> 加平仓原因时**两处都要看**，别只改一处（`lib/summaries.ts` 是给旧数据/未加载目录时的兜底）。

### `pages/`

| 文件 | 路由 | 内容 |
| --- | --- | --- |
| `OverviewPage.tsx` | `/` | 环境横幅、机器人列表、新建机器人 |
| `TradersPage.tsx` | `/traders` | 机器人列表 |
| `TraderPage.tsx` | `/traders/:id` | **机器人看板**：统计卡、权益曲线、持仓/委托/成交/历史标签页、右侧「最近决策」 |
| `DecisionDetailPage.tsx` | `/traders/:id/decisions/:recordId` | 决策审计详情（思维链、解析决策、逐条执行结果、完整提示词） |
| `StrategyListPage.tsx` / `StrategyEditorPage.tsx` | `/strategy` `/strategy/:id` | 策略工作室与体检 |
| `MarketPage.tsx` | `/market` | 合约搜索 + K 线图 |
| `ModelsPage.tsx` / `ExchangesPage.tsx` / `AccountPage.tsx` | `/models` `/exchanges` `/account` | 都是**薄页面**：只放标题 + 引用 `components/settings/` 里的 section |
| `DataPage.tsx` | `/data` | 实时日志（WebSocket 推送） |
| `FaqPage.tsx` | `/faq` | 使用说明与风险提示 |
| `LoginPage.tsx` | `/login` | 登录（无注册入口；无账号时提示去哪看凭据） |
| `NotFoundPage.tsx` / `SettingsPage.tsx` | `*` / `/settings` | 404 / 重定向 |
| `overviewParts.tsx` | 无（被 `/` 引用）| 总览页的展示件：`HeadlineMetric` / `SystemFact` / `TradersSnapshotTable` / `EquitySkeleton` / `useRecentTrades`。拆出来是为了让 `OverviewPage.tsx` 读起来是**结构**而不是一堆 markup |

### `components/`

| 文件 | 职责 |
| --- | --- |
| `ui.tsx` | **设计系统原语**：`Badge`/`Button`/`Panel`/`Stat`/`Modal`/`Field`/`TextInput`/`NumberInput`/`Select`/`TextArea`/`Toggle`/`Empty`/`ErrorNote`/`Spinner`/`Spinner3`/`KV`/`CopyButton`/`Collapsible`/`Dot`、`Tone` 类型 |
| `Layout.tsx` | 外壳与导航 |
| `Badges.tsx` | `TraderStatusBadge` / `SideBadge` / `CheckList`（预检结果）/ `SectionHeading` / `Tabs` |
| `TraderTables.tsx` | 持仓 / 委托 / 成交 / 历史四个表 + `TraderTabId` |
| `TraderModals.tsx` | 新建 / 启动机器人弹窗 |
| `TraderConfigModal.tsx` | 修改机器人配置 |
| `BalanceCells.tsx` | 余额单元格与账户条（多资产、单位正确） |
| `PnlBreakdown.tsx` | 净盈亏拆解（`NET_PNL_FORMULA = '净盈亏 = 毛盈亏 − 手续费 − 资金费'`） |
| `DecisionFeed.tsx` | 「最近决策」滚动列表（周期元信息 → 决策常显 → 可折叠思维链/提示词） |
| `DecisionAudit.tsx` | 决策审计的各种小组件（`ACTION_LABELS`/`ACTION_TONES`/`ExecutionList`/`PromptBlocks`/`RejectedBanner`…） |
| `StrategyFields.tsx` / `StrategyRiskFields.tsx` / `StrategyFieldKit.tsx` | 策略编辑器的字段分组与字段原语 |
| `StrategyCheckModal.tsx` | 策略体检弹窗 |
| `EquitySourceField.tsx` | 起始权益来源选择（从交易所读 / 手动输入） |
| `DashboardCharts.tsx` | 交易看板的图表件：权益曲线（`DashboardEquityChart`）、胜负条（`WinLossBar`）。**它 import 了 recharts**，所以只允许被懒加载的页面引用 |
| `EquityCurveChart.tsx` | 总览页专用的权益曲线（同样基于 recharts）。**单独一个文件就是为了把 recharts 挡在首屏之外**——它只经 `lazy(() => import('./EquityCurveChart'))` 到达 |
| `equityCurve.ts` | 两条曲线共用的**零图表依赖**算术与调色：`mergeEquityCurves()`、`rangeSpanMs()`、`equityAxisFormatter()`、`CHART_INK`、`EQUITY_RANGES`/`filterByRange()`。放这里是因为任何被首屏引用的东西都不能牵进 recharts |
| `nav.ts` | 导航表（见上） |
| `CommandPalette.tsx` | ⌘K 命令面板（`cmdk` + Radix Dialog）：页面跳转、机器人操作，快捷键与 `NAV_ITEMS` 同源 |
| `CandlestickChart.tsx` | 轻量 K 线图封装 |
| `Toaster.tsx` | 通知浮层 |
| `settings/AccountSection.tsx` / `AiModelsSection.tsx` / `ExchangeAccountsSection.tsx` | 设置三节的实体实现 |

> **页面与 section 的分工**：`pages/*` 负责路由、标题、数据加载与布局；
> `components/settings/*` 负责具体的增删改查表单。所以"加一个设置项"通常改的是 component，
> 不是 page。

---

## 14. 扩展配方

每一条都给出**真实步骤**，并标出**忘了改会编译失败或在运行时报错**的位置。

---

### 配方 1 · 新增一个交易所（目前只有币安）

目前 `ExchangeIdSchema` 是 `z.enum(['binance'])`，只有一支。好消息是分派点少，坏消息是
`ExchangeId` 是**编译期约束**，少改一处 `tsc` 就会报错——这反而是好事。

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `packages/shared/src/domain.ts` | `ExchangeIdSchema = z.enum(['binance', '<新id>'])`，并在 `EXCHANGES` 数组里加一条描述（`id`/`label`/`market`/`available`）。`ExchangeId` 类型自动扩展 |
| 2 | `packages/server/src/api/server.ts` | `ExchangeAccountInputSchema.exchange` 目前是 `z.enum(['binance']).default('binance')`——**这里必须加**，否则前端提交新交易所 id 会被 zod 拒绝 |
| 3 | 新目录 `packages/server/src/<venue>/` | 实现等价于 `src/binance/` 的连接层，满足第 3 节那张 `PlacedOrder` 语义契约表。最低要求：`getAccountState` / `getPositions` / `setLeverage` / `placeOrder`（返回归一化 `PlacedOrder`）/ `waitForFill` / `cancelAllOrders` / `getUserTrades` / `getIncome` / `getAlgoOrder` / `getMarkPrice`，以及一个 `SymbolRegistry` 等价物（数量步长、价格 tick、最小名义价值） |
| 4 | 新文件 `packages/server/src/<venue>/bootstrap.ts` | 仿 `connectExchange()` 返回一个 bundle，并提供这个交易所自己的 `preflight()`（返回 `PreflightCheck[]`） |
| 5 | `packages/server/src/trader/manager.ts` | `connectionFor()` 目前硬编码 `connectExchange()`。在这里按 `account.exchange` 分派；`startTrader()` 里的预检调用点也要跟着分派 |
| 6 | `packages/server/src/api/server.ts` | `test-draft` 与 `:id/test` 两个端点里各有一处 `connectExchange()` 动态导入——**两处都要分派**，否则"测试连接"永远测的是币安 |
| 7 | `packages/server/src/services/balance.ts` | `clientFor()` 建的是 `BinanceRest`；余额展示要支持新交易所就得在这里分派（否则凭据列表里新交易所那一行的余额永远是错的） |
| 8 | 前端：`packages/web/src/components/settings/ExchangeAccountsSection.tsx` | 交易所下拉来自 `GET /api/catalog` 的 `exchanges`，所以只要第 1 步做完就会自动出现。但如果新交易所有额外凭据字段（passphrase 等），要在这里补表单 |
| 9 | 数据库 | `exchange_accounts.exchange` 是自由 TEXT，不用迁移。`passphrase_enc` 字段已经存在（默认空字符串），可以直接用 |
| 10 | 验证 | `npm run typecheck`，然后写 `packages/server/src/<venue>/orders.test.ts`，照 `binance/orders.test.ts` 的做法用 `fakeRest()` 断言**走了哪个端点、参数叫什么名字** |

**注意条件单语义差异**：止损在有些交易所是普通单类型、有些是独立端点。
`binance/broker.ts` 里 `CONDITIONAL_ORDER_TYPES` 那套路由逻辑是币安特有的，不要照抄语义。

---

### 配方 2 · 新增一个 LLM 提供商

**先分两种情况**，绝大多数情况是第一种。

#### 情况 A：它兼容 OpenAI `/chat/completions` 方言（最常见）

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `packages/shared/src/domain.ts` | `LlmProviderIdSchema` 的 `z.enum([...])` **加一个新 id**。这是类型级硬约束：不加，`provider: '新的'` 在任何地方都编译不过 |
| 2 | `packages/shared/src/llm.ts` | 往 `LLM_PROVIDERS` 数组加一条完整的 `LlmProviderDescriptor`：`id`、`label`、`baseUrl`、`authStyle`、`models`（**建议留空**——静态列表会过时，让 `modelsPath` 发现机制去拉）、`openAiCompatible: true`、`jsonMode`、`docsUrl`、`modelsPath`、`modelsAuth`、可选的 `modelsHeaders`、`defaults`、`supportsThinking`。**漏了这一条**：`getProvider()` 在运行时抛"未知的 LLM 提供商"，`/api/catalog` 的下拉里也不会出现它 |
| 3 | `packages/server/src/llm/client.ts` | **通常不用改**：`buildRequest()` 里 `if (this.descriptor.openAiCompatible)` 会自动走 `openai.buildRequest`，`parse()` 同理 |
| 4 | `packages/server/src/llm/openaiCompatible.ts` | **只有在这个厂商有偏差时才改**，而且要用显式开关而不是"顺手转发"：`rejectsSamplingParameters()`（拒绝 temperature）、`supportsResponseFormat()`（不支持 `response_format`）、`supportsStrictSchema()`（不支持严格 schema）、`maxTokensField()`（用 `max_completion_tokens` 还是 `max_tokens`）。函数里的 `switch` 是穷尽的，加 id 后 `tsc` 会提示你确认这些分支 |
| 5 | `packages/server/src/llm/discovery.ts` | 只有当它的 `/models` 响应**不是** OpenAI 形状时才需要加一支 `extractModels()` 分支（Gemini 和 Anthropic 各有一支）。OpenAI 形状的话第 2 步的 `modelsPath`/`modelsAuth` 就够了 |
| 6 | `packages/server/src/llm/errors.ts` | 只有当它在**非标准场景**报错时才需要（例如 MiniMax 在 HTTP 200 里报错 → `MINIMAX_CODES` + `classifyMinimaxBaseResp`）。通用的 4xx/429/5xx 已经被 `kindForStatus()` 覆盖 |
| 7 | 前端 | 无需改动：供应商下拉来自 `/api/catalog` 的 `providers`，选中后 baseUrl 与默认值自动填 |
| 8 | 测试 | 在 `packages/server/src/llm/llm.test.ts` 加用例。这个文件有 45 个用例，模式是分别断言 `buildBody()`（纯函数，看请求体）与 `parseResponse()`（纯函数，喂真实响应样本） |

#### 情况 B：方言完全不同（非 OpenAI 兼容）

除了第 1、2 步以外：

| # | 文件 | 改什么 |
| --- | --- | --- |
| 3' | 新文件 `packages/server/src/llm/<vendor>.ts` | 仿 `anthropic.ts` 或 `gemini.ts`，导出**可测的纯函数** `buildRequest()` / `buildBody()` / `parseResponse()`（可选 `extractText()` / `normalizeFinishReason()` 等），内部一律复用 `./http.js` 的 `joinUrl` 与各规范类型 |
| 4' | `packages/server/src/llm/client.ts` | 两处必须加分支：`buildRequest()` 里的 `if (this.provider === '<vendor>')` 和 `parse()` 里的同款。**漏掉任何一处，运行时抛 `No adapter for provider <vendor>`** |
| 5' | `packages/shared/src/llm.ts` | 该条的 `openAiCompatible: false` |
| 6' | 测试 | 在 `llm.test.ts` 里照 Anthropic/Gemini 的写法补一组 |

> 别忘了 `discovery.ts`：新提供商在"获取可用模型"按钮上要么走 `extractModels()` 的新分支，
> 要么至少要能优雅回落到 `fallback`（`source: 'fallback'` 会告诉用户这是内置提示而不是实时结果）。

---

### 配方 3 · 新增一个技术指标

以"加一个布林带"为例。**四处**，缺一处就是静默失效：

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `packages/shared/src/indicators.ts` | 在 `TimeframeIndicators` 里加序列字段，例如 `bollinger: { period: number; upper: [...]; middle: [...]; lower: [...] } \| null`。**这是编译期的第一道网**：不加字段，第 2 步把值塞进去就编译不过 |
| 2 | `packages/shared/src/strategy.ts` | 在 `IndicatorConfigSchema` 里加开关与参数，**必须带 `.default()`**：`enableBollinger: z.boolean().default(false)`、`bollingerPeriod: z.number().int().min(2).default(20)` |
| 3 | `packages/server/src/market/indicators.ts` | 写纯函数（返回定长、预热期 `null`、**无未来函数**、周期非法时返回全 `null` 而不是抛错），并在 `computeTimeframeIndicators()` 里按 `config.enableBollinger` 计算。**注意两点**：(a) 预热需要的蜡烛数如果超过 `primaryCount`，序列会静默全空——要在 `strategy.ts` 的 `primaryCount` 注释旁边把新的最低要求写清；(b) 若序列条数变化，`estimateCandidateChars()` 的分支必须同步，否则提示词预算估价会偏低 |
| 4 | `packages/server/src/strategy/prompt.ts` | 两处渲染：`formatMarketData()` 的 headline / 时间周期序列段，以及 `summariseSnapshot()`（持仓列表用的一行摘要）。**同时更新 `estimateCandidateChars()`**，把新增的序列条数算进去——不改它，提示词预算会低估，`candidateBudget()` 会放行过多候选币种 |
| 5 | `packages/server/src/market/indicators.test.ts` | 加用例。**固化的应该是经典参考值**（参照现有 Wilder RSI / EMA 的做法），并写注释说明为什么这个用例存在 |
| 6 | 前端（可选） | 指标参数在策略编辑器里由 `packages/web/src/components/StrategyFields.tsx` 的 `IndicatorsSection` 渲染。想让用户在控制台里调，就在这里补字段；不加也不影响后端 |

**不要忘了**：`ReplayMarketData`（`simulate/replayMarketData.ts`）调用的是同一个
`computeTimeframeIndicators()`，所以回放会自动包含新指标——这正是它复用生产代码的目的。

---

### 配方 4 · 新增一个风控规则

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `packages/shared/src/strategy.ts` | 在 `RiskControlConfigSchema`（或 `ThrottleConfigSchema` / `CircuitBreakerConfigSchema`，取决于规则性质）加配置项，**必须带 `.default()`** |
| 2 | `packages/server/src/risk/engine.ts` | **唯一正确的执行位置**。开仓限制加在 `RiskEngine.reviewOpen()`，平仓限制加在 `reviewClose()`，跨周期的（回撤、熔断）做成导出的纯函数（仿 `shouldCloseForDrawdown()` / `checkCircuitBreakers()`）。选好插入位置：**检查顺序影响报错信息**，越早返回越省事，但"先拒绝还是先钳制"要按语义决定 |
| 3 | 同上 | **每一次钳制或拒绝都要留下痕迹**：拒绝 → `return { ok: false, reason: '...' }`（中文、说清数字）；钳制 → `adjustments.push('...')`。`adjustments` 会进 `ExecutionLogEntry.adjustments`，控制台会列表展示，测试也能断言"钳制真的发生了"而不是去匹配一句话 |
| 4 | `packages/server/src/strategy/prompt.ts` | 在 `buildSystemPrompt()` 的「硬性约束」段里加一行。这段是**从 `RiskControlConfig` 动态生成**的，所以模型立刻能看到新边界——**但真正的执行者是风控引擎，不是这段文字**。有条件的话仿照现有写法（例如 `config.throttle.minHoldMinutes > 0 ? '...' : ''`），避免输出无意义的"限制为 0" |
| 5 | `packages/server/src/risk/engine.test.ts` | 加用例，覆盖**每一个方向**（例如上限把值压小、下限把值抬大，以及边界值恰好相等时的行为）。现有 27 个用例就是按这个粒度写的 |
| 6 | 前端（可选） | 策略编辑器里由 `packages/web/src/components/StrategyRiskFields.tsx` 的 `RiskSection` / `ProtectionSection` 渲染 |
| 7 | 别忘了 | 如果新规则依赖新的运行时输入（例如"最近 N 分钟内的某统计"），要同时扩展 `RiskEnvironment` 接口，并在 `trader/autoTrader.ts` 构造 `verdict` 的地方（以及 `strategy/healthCheck.ts` 里那份）**两处**都补上——漏一处会编译失败（好事），两处都要用真实数据 |

> **不要为了某个规则去改风控的语义边界**（见 `docs/AGENTS.md`）。风控是"模型提议、运行时裁决"这个
> 设计唯一落地的地方。

---

### 配方 5 · 新增一个平仓原因（`CloseReason`）

`CLOSE_REASONS` 是 `as const` 数组，它**驱动** `CloseReason` 类型，所以加一个字符串会自动扩展类型。

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `packages/shared/src/domain.ts` | `CLOSE_REASONS` 数组加字符串（**稳定机器码，用英文 snake_case，绝不是显示文本**——它会被持久化进 `trades.close_reason`，翻译它等于改写历史）。同时加注释说明这个原因什么时候产生 |
| 2 | 同文件 | `CLOSE_REASON_LABELS` 加中文标签。**必须加**：服务端日志（`closeReasonLabel()`）、提示词里的"近期已平仓交易"、控制台三处共用这张表，这是"新原因不可能漏掉某个界面"的机制 |
| 3 | `packages/server/src/trader/autoTrader.ts` | 真正产生它的地方。要么是 `detectCloseReason()`（交易所侧消失的仓位）、`executeClose()`（模型/守卫主动平仓传的 `reason`）、`bookClosedPosition()`，要么是 `applyDrawdownGuard()`。**注意 `reasonFromPrice()` 与 `detectCloseReason()` 的兜底 `'external'`**：不要为了用上新原因而让无法判定的情形被"猜"成新原因——注释里写明了"Labelling it `stop_loss` or `take_profit` would be inventing a fact" |
| 4 | 数据库 | **不需要迁移**：`trades.close_reason` 是自由 TEXT |
| 5 | `packages/web/src/lib/summaries.ts` | 这个文件里**另有一份** `closeReasonLabel`（本地兜底，供未加载目录/旧数据使用）。理论上它应该只做兜底，但加原因时**去看一眼**，避免两处标签不一致 |
| 6 | `packages/server/src/trader/roundTrips.ts` 与契约测试 | `ReconstructedTrade` 不存 close reason（对账统一记 `'reconciled'`）。但 `simulate.ts` 有一项校验枚举了合法原因列表——加了新原因后如果回放里出现了它，那项校验会失败，记得同步 |
| 7 | 测试 | 在 `trader/roundTrips.test.ts` 或 `autoTrader.test.ts` 加一条断言"能识别出这个原因"的用例 |

---

### 配方 6 · 新增一个 API 端点

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `packages/server/src/api/server.ts` | 在 `buildServer()` 内注册。放在 `const authed = { preHandler: requireAuth(deps.jwtSecret) };` **之后**就自动需要登录；放在之前（或显式不传 `authed`）就是公开端点。需要 body 校验就写一个 zod schema 放在文件顶部的 "Request schemas" 区，并用 `guard()` 包一层让抛出的错误变成干净的 400 |
| 2 | 同上 | 想清楚**失败形式**：是 `4xx` 还是 `200 + { ok: false }`？（见第 12 节。）选定后要在 `docs/API.md` 里写明 |
| 3 | `packages/server/src/store/repositories.ts` | 如果端点要查/改数据，优先在这里加方法而不是在路由里写 SQL。仓储是行字段 ↔ 领域对象的唯一转换点 |
| 4 | `packages/web/src/lib/api.ts` | 加对应方法 + 返回类型。类型尽量复用 `@aq/shared` 的领域类型；确实超出时在文件里声明 interface（现有 `Health`/`Catalog`/`PreflightCheck` 等都是这么放的） |
| 5 | `packages/web` 调用方 | 视情况加到页面/store。需要轮询就用 `usePolled()`；需要实时推送就在 `packages/server/src/events.ts` 的 `ServerEvent` 联合里加一个事件类型（`@aq/shared/src/domain.ts` 定义），服务端 `eventBus.publish()`，前端 `useEvents` 里消费 |
| 6 | `docs/API.md` | **必须更新**。它是给外部用的契约文档，写了逐端点的请求/响应与失败形式 |
| 7 | 测试 | HTTP 层目前没有自动化测试，所以至少手动 `curl` 一次（注意 `addContentTypeParser` 让空 body 的 POST 也能用），并把实测结果写进 `docs/API.md` |

---

### 配方 7 · 新增一个控制台页面

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | 新文件 `packages/web/src/pages/YourPage.tsx` | 导出 `export function YourPage()`。照现有页面的骨架写：`useDocumentTitle('...')` → `<SectionHeading title sub>` → 内容。数据用 `usePolled()` 或 `useApp`/`useEvents` |
| 2 | `packages/web/src/App.tsx` | 在 `<RequireAuth><Layout /></RequireAuth>` 这层路由组里加 `<Route path="/your" element={<YourPage />} />`。放在这层外就是公开页面 |
| 3 | `packages/web/src/components/nav.ts` | 往 `NAV_ITEMS` 里加一条 `{ to: '/your', label: '...', icon: SomeLucideIcon, jump: 'y' }`。`icon` 是 **lucide-react 的组件**（本项目有图标库），`jump` 是 `g` 前缀快捷键的第二段，只用小写字母 |
| 4 | 需要的组件 | 若页面较大，把实体拆到 `components/` 下（参考 `pages/ModelsPage.tsx` + `components/settings/AiModelsSection.tsx` 的分工：page 管路由/标题/布局，component 管表单与逻辑） |
| 5 | 后端 | 数据来自 `packages/web/src/lib/api.ts` 的 `api` 对象。缺端点就先按配方 6 加 |
| 6 | 验证 | `npm run typecheck` + `npm run build`，然后**在浏览器里真的点一遍**。别只看编译通过就说它工作了 |
| 7 | 文档 | 在 `README.md` 的"控制台页面"表里加一行 |

---

### 配方 8 · 新增一个策略预设

预设是"种子"，用户之后可以自由改一切。

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `packages/shared/src/strategy.ts` | 往 `STRATEGY_PRESETS: StrategyPreset[]` 加一条：`{ id, label, summary, tradingMode, patch }`。`patch` 是 `Partial<StrategyConfigInput>`，只需写要覆盖的字段（zod 会补齐其余）。`id` 用短英文 kebab/单词，`label` 用中文 |
| 2 | 同文件（可能） | 如果要一个新的 `tradingMode`，那要改 `TradingModeSchema` 与 `TRADING_MODE_LABELS`（`domain.ts`），并处理提示词里的模式段落 |
| 3 | `packages/server/src/strategy/prompt.ts` | **`MODE_GUIDANCE` 是一个 `Record<StrategyConfig['tradingMode'], string>`**。加了新的 `tradingMode` 而没加对应条目，`tsc` 会直接报错——这是刻意的穷尽性检查。若只是新预设而复用现有 mode，则不需要改 |
| 4 | 前端 | **不用改**：策略工作室的预设下拉来自 `GET /api/catalog` 的 `presets`。点选时 `applyPreset()`（`packages/web/src/lib/strategy.ts`）会把 `patch` 逐层合并进当前配置（嵌套对象是**逐键合并**而不是整体替换，这个细节别改） |
| 5 | `packages/server/src/index.ts` | 只有想改**首启默认策略**时才需要动 `seedDefaults()`（它硬编码了 `preset: 'conservative'`） |
| 6 | 文档 | `README.md` 里提到"三种风格预设：稳健 / 进取 / 短线"的地方要同步 |

> 现有三个预设（`conservative` / `aggressive` / `scalping`）的注释说明了定位：
> *"These only seed the prompt sections and a few numeric knobs — the user is free to edit
> everything afterwards."* 所以预设里**不要**放那种"必须原样不动才有意义"的配置。
