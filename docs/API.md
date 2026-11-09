# HTTP API 参考

服务端是一个 Fastify 应用，同时提供 REST 接口、WebSocket 事件流，以及控制台的静态文件。

- **基地址**：`http://<HOST>:<PORT>`（默认 `127.0.0.1:27137`）
- **认证**：除 `/api/health` 与 `/api/auth/login` 外，全部需要
  `Authorization: Bearer <token>`。**只有 `/api/events` 的 WebSocket 升级**
  接受 `?token=`（浏览器无法给升级请求设 header）；HTTP 路由只认请求头，
  因为 URL 会落进反向代理日志、浏览器历史与 `Referer`。
- **会话有效期**：**12 小时**。改密码或改用户名会**立即作废该账户此前签发的所有令牌**
  （见下），不需要等过期。
- **内容类型**：请求体为 JSON。服务端注册了一个兜底解析器，所以**空 body 的 POST**
  （如 `/start`、`/stop`、`/run-once`）不会返回 415。

> **约定**：业务失败返回 **HTTP 200 + `{ ok: false, error }`** 还是 **4xx**，两种都存在，
> 取决于端点。调用方应**优先检查 `ok` 字段**，不要只看状态码。每个端点下方都注明了它的
> 失败形式。

---

## 目录

| 分组 | 说明 |
|---|---|
| [系统](#系统) | 健康检查、运行环境、日志 |
| [认证](#认证) | 登录、修改账户凭据 |
| [目录](#目录catalog) | 枚举框、策略预设、平仓原因等前端所需的静态数据 |
| [交易所凭据](#交易所凭据) | CRUD、连接测试、**实时余额** |
| [AI 模型](#ai-模型) | CRUD、连接测试、**模型列表实时发现** |
| [策略](#策略) | CRUD、**策略体检** |
| [机器人](#机器人) | CRUD、启停、单次运行、**对账** |
| [机器人数据](#机器人数据) | 统计、持仓、委托、成交、决策、净值曲线 |
| [行情](#行情) | 合约列表、K 线 |
| [事件流](#事件流) | WebSocket |

---

## 系统

### `GET /api/health` — 健康检查

无需认证。用于部署校验与存活探测。**它现在是决策新鲜度检查，不只是"进程还活着"。**

```json
{
  "ok": true,
  "version": "<当前发布版本>",
  "uptimeSeconds": 128,
  "hasOwner": true,
  "dryRun": false,
  "tradingDisabled": false,
  "environment": "production",
  "db": "autoquant.sqlite",
  "staleTraders": [],
  "runningTraders": 2
}
```

**状态码**：只要有**正在运行**的机器人超过了它的决策新鲜度阈值，就返回 **503**
（响应体形状相同，另加一个 `reason` 字段说明是哪个环节）。这不是可有可无的细节 ——
`Dockerfile` 与 `deploy/docker-compose.yml` 的 `HEALTHCHECK` 都只以这个端点为判据，
而它原来无条件返回 `{ok: true}`：一个决策循环已经挂死、或者事件循环被同步 SQLite
调用堵住的进程，在编排器看来永远健康 —— 不告警、不重启，而账户上可能还挂着仓位。

判定规则（**只有 `status = 'running'` 的机器人参与**）：

| 情形 | 结果 |
| --- | --- |
| 距离上一轮决策结束 < 该机器人的新鲜度阈值 | 健康 |
| 超过该阈值 | **503**，并在 `staleTraders` 里列出 |
| 已启动但还没跑完第一轮，且启动未满阈值 | 健康（冷启动宽限） |
| 已启动但还没跑完第一轮，且已超过阈值 | **503**，`awaitingFirstCycle: true` |
| `stopped` / `safe_mode` / `error` / `starting` | **不影响状态码** |

**阈值是分布驱动的，因机器人而异**：

```
threshold = max(周期 × 2, 300 秒, P95(该机器人最近已完成轮次的时长) × 2)
```

理由：`last_cycle_at` 只在**一轮结束**时写入，所以 1 倍周期必然产生假警报（每轮都会短暂越线）；
2 倍才是"连续两轮都没跑完"；300 秒是地板；而固定 30 分钟会让慢模型（实测 `#10` 的
P95 ≈ 20.9 分钟）**每一轮都判红**，所以阈值跟着真实分布走。实现在
`packages/server/src/api/staleThreshold.ts`（`staleThresholdMs()` / `STALE_P95_MULTIPLIER`）
与 `packages/server/src/api/server.ts`（`STALE_CYCLE_MULTIPLIER` / `STARTUP_GRACE_MS`）。

`staleTraders` 每项：`{ id, name, staleForMs, awaitingFirstCycle, thresholdMs }` ——
`thresholdMs` 必须带出去，否则控制台只能显示"已 45 分钟没跑完"却不知道**这一台**的阈值是多少。

> 暂停（`safe_mode`）与已停止的机器人**不会**让这个端点变红。
> 把"被刻意停下"算成"不健康"会让一个正常的实例在编排器眼里永远是坏的。

> `db` 只是**文件名**，不是路径。这个端点无需认证，所以不能借它公布
> 部署目录布局（操作系统、部署根目录、数据目录名都是给后续攻击挑目标的线索）。
> 控制台「操作员账户」页把它当作「连的是哪个库」的提示来显示。

> `environment` 是 **`production`** 还是 **`demo`** 值得每次部署后确认一次：
> 两者界面完全一样，配置错了不会报错，只会让交易跑到错误的环境上。

### `GET /api/system` — 运行环境概览

当前交易环境、可交易合约数量、时钟偏移、权重预算等。

```json
{
  "dryRun": false,
  "tradingDisabled": false,
  "environment": "production",
  "environmentLabel": "币安 USDT 本位合约（实盘）",
  "clockOffsetMs": 12,
  "weightUsed": 412,
  "weightLimit": 2400,
  "requestsInFlight": 3,
  "maxRequestsInFlight": 6,
  "tradableSymbols": 528,
  "runningTraders": [1, 2],
  "failedTraders": [],
  "build": null,                  // build-info.json 的内容；没有就是 null（= 不知道跑的是哪一版）
  "version": "0.2.0"              // 产品版本，来自 package.json
}
```

`build` 与 `version` 是**两件事**：前者回答"线上跑的是哪个提交"（来自部署产物），
后者回答"这是个什么版本的东西"（发版时递增）。没有 `build-info.json` 时 `build` 为 `null`，
界面必须显示"未知"，而不是一个看起来正常的默认值。

> `requestsInFlight` / `maxRequestsInFlight`：权重预算以前只能靠"上一份响应里的
> header"约束，而每一批 `Promise.all` 都在读完那个已经过期的值之后同时放行 ——
> 40 个请求一起出去，75% 的软上限等于不存在，唯一的兜底是币安的 429（再往上
> 一次 418 就是 IP 封禁）。现在每个请求在发出前先占一个槽位，这两个字段让
> 并发占用可见，而不是只能靠推测。

> `failedTraders`：**自动恢复已经放弃**的机器人（`status = 'error'` 且没在运行），
> 每项含 `id` / `name` / `lastError`。启动失败以前是终局且静默的 ——
> 一次网络抖动就把机器人永久钉在 `error` 上，而没有任何地方会再提起它。
> 现在它会按退避自动重试，放弃时留在这个列表里、写进日志、也留在
> `traders.last_error` 上（控制台机器人列表会直接渲染那个字段）。

### `GET /api/logs` — 滚动日志

| 参数 | 类型 | 说明 |
|---|---|---|
| `traderId` | number | 可选，只看某个机器人 |
| `limit` | number | 默认 200 |

### `GET /api/system/update`

**只读地**检查有没有新版本 —— 它**不会**安装或下载任何东西。

→ 当前版本、上游最新版本、以及两者是否一致；上游不可达时**不报错**，
只在响应里标明比对失败（上游限流或网络不通是常态，不该让控制台因此报红）。

---

## 认证

> **本系统没有注册入口。** 管理员账号在服务首次启动时自动创建，凭据（用户名与密码，
> 两者都是随机生成）只打印一次。登录后可在控制台「操作员账户」中修改。
>
> 这是面向单人部署的设计：保留自助注册意味着任何能访问到控制台的人，
> 在数据库为空时都能把自己变成管理员 —— 那个窗口在部署脚本尚未跑完、
> 或数据卷被误删重建时会真实出现。

### `POST /api/auth/login`

```json
{ "username": "admin_9f3c21", "password": "..." }
```

→ `{ "token": "<JWT>", "user": { "id": 1, "username": "admin_9f3c21", "role": "owner" } }`

密码错误返回 **401**；令牌有效期 **12 小时**。

尝试过于频繁返回 **429**（带 `Retry-After`，单位秒）。节流按**用户名**与**来源 IP**
两个维度独立计数，阈值分别是 5 次与 20 次连续失败，超过后按 1s、2s、4s…
指数锁定，封顶 15 分钟；失败记录在 30 分钟无新失败后失效。

> 即使用户名不存在也会走完同样的口令派生（scrypt），所以「用户名是否存在」
> 无法从响应时间上区分出来 —— 随机用户名的价值正建立在这一点上。
>
> 节流状态存在**进程内存**里（单人自用部署，不引入 Redis），重启即清零。

### `PATCH /api/auth/account`

修改用户名与/或密码。需要认证。

```json
{
  "currentPassword": "当前密码",
  "username": "new-name",     // 可选
  "newPassword": "新密码"      // 可选，至少 8 位
}
```

**必须提供 `currentPassword`。** 只凭会话令牌就允许改凭据，意味着任何一次令牌泄露
都能被升级成永久接管 —— 攻击者改掉密码，真正的所有者就再也进不来了。

`username` 与 `newPassword` 至少要提供一个。用户名需 3–64 字符且未被占用（冲突返回 **409**）。
请求体一律先过 zod：类型不对（例如 `currentPassword` 传了数字）返回 **400**，
而不是让 `scryptSync` 抛出 500。

**改用户名或改密码都会作废该账户此前签发的所有令牌**（包括其他浏览器 / 设备上的会话），
响应里返回的是重新签发的新令牌。

响应会把**重新签发的令牌**一并返回，因为 JWT 载荷里带着用户名：

```json
{ "ok": true, "token": "<新的 JWT>", "user": { ... } }
```

> `POST /api/auth/password` 保留为同义端点（只改密码），仅为了兼容浏览器中缓存的旧版前端。

> `currentPassword` 校验同样有节流（阈值与登录一致），连错后返回 **429 + `Retry-After`**：
> 拿到会话令牌不等于知道密码，这个端点不能变成在线口令预言机。

### `POST /api/auth/register`

**已停用**，返回 **410**。响应体里说明了替代方式。

### `GET /api/auth/me`

当前用户信息。需要认证。

---

## 目录（catalog）

### `GET /api/catalog`

前端启动时拉取的静态数据集合。一次拿到：

- `exchanges` — 交易所适配层的注册表，含各交易所的标识、中文名与结算资产
- `presets` — 策略预设（稳健 / 进取 / 短线），含完整的 `patch`
- `defaultStrategy` — 默认策略配置
- `providers` — LLM 提供商目录（含 `modelsPath`、`modelsAuth` 等发现字段）

> 只有上面四项。**平仓原因、交易模式、机器人状态这些枚举不在这个端点的响应里**——
> 它们由 `@aq/shared` 的常量（`CLOSE_REASONS` / `CLOSE_REASON_LABELS` 等）随前端代码一起打包，
> 前端不再从 `/api/catalog` 取。以前这里列过 `closeReasons` / `tradingModes` / `traderStatuses`，
> 服务端从来没有返回过它们。

> 新增枚举值时改 **`packages/shared/src/domain.ts`**，前端会自动跟着变——不要在前端
> 硬编码这些列表。

---

## 交易所凭据

凭据以 **AES-256-GCM** 加密存储，接口**从不返回 Secret**，只返回掩码后的 Key。

### `GET /api/exchange-accounts`

每行额外携带**实时余额**（服务端有 20 秒缓存，所以轮询这个列表是廉价的）：

```jsonc
{
  "id": 1,
  "exchange": "binance",
  "label": "币安实盘",
  "testnet": false,
  "canTrade": true,
  "balance": {                       // 读取失败时为 null
    "equity": 10.25858366,           // 账户权益（保证金余额 = 钱包 + 未实现）；共享钱包，不是某个机器人的
    "walletBalance": 10.25858366,    // 结算余额（「钱包余额」）
    "availableBalance": 10.25858366,
    "unrealizedPnl": 0,
    "marginUsed": 0,
    "openOrderMargin": 0,
    "asset": "USDT",
    "readAt": "2026-09-15T19:00:00.000Z"
  },
  "balanceError": null               // 非 null 时 balance 为 null
}
```

### `GET /api/exchange-accounts/:id/balance`

| 参数 | 说明 |
|---|---|
| `refresh=1` | 跳过缓存强制重新读取 |

**无论成功失败都返回 HTTP 200**，调用方必须检查 `ok`：

```json
{ "ok": true, "balance": { ... }, "cached": false }
{ "ok": false, "error": "API Key 无效、已过期，或没有读取账户的权限。" }
```

### `POST /api/exchange-accounts`

```json
{
  "exchange": "binance",
  "label": "我的账户",
  "apiKey": "...",
  "apiSecret": "...",
  "testnet": false,
  "canTrade": true
}
```

### `PATCH /api/exchange-accounts/:id` / `DELETE /api/exchange-accounts/:id`

更新 / 删除。删除会同时清理该凭据的余额缓存。

### `POST /api/exchange-accounts/:id/test`

对已保存的凭据跑**启动预检**。

### `POST /api/exchange-accounts/test-draft`

对**尚未保存**的凭据跑预检（添加对话框里的「测试」按钮）。

返回 `{ ok, checks: PreflightCheck[] }`。每个检查项带 `severity`：

| severity | 含义 | 界面表现 |
|---|---|---|
| `ok` | 通过 | 绿色 ✓ |
| `warn` | **需要确认，但不是失败** | 黄色 ! |
| `error` | 失败 | 红色 ✕，`blocking` 为真时阻断启动 |

> `severity` 是**三态**而不是布尔值，因为确实存在「不是失败、但值得你确认」的情况。
> 典型例子：**子账户**密钥的 `canWithdraw` 标志位是 `true`，但子账户的实际提现由
> 主账户控制——把它显示成红色失败是误报，而一个总在喊狼来了的面板会被操作员无视。

---

## AI 模型

### `GET /api/ai-models` / `POST /api/ai-models` / `PATCH /api/ai-models/:id` / `DELETE /api/ai-models/:id`

标准 CRUD。API Key 加密存储，不回传。

`GET` 的每一项除了模型配置本身，还带三个**只读**字段：

| 字段 | 含义 |
| --- | --- |
| `apiKeyMasked` | 密钥掩码（`maskSecret()`），明文永不回传 |
| `hasKey` | 服务端是否已为该模型存有密钥 |
| `health` | **这个模型最近一次调用的结果**；`null` = 还没调用过 |

`health` 的形状是 `{ ok, at, latencyMs?, error? }`。它存在的原因很实际：网关曾经连着回
`You have insufficient credits to make this request.`（HTTP 400），而**控制台上一个字都没有** ——
机器人看着"在运行"，实际上已经做不出决策，用户只能去服务器翻 `server.log`。
有了它，机器人页才能在「AI 模型」那一行直接标出「⚠️ 调用失败」（原因放在悬停提示里）。

> ⚠️ 它是**运行时状态**，由 `manager` 在每次 `chat()` 之后写进 `settings`（键 `llm_health:<id>`），
> **不属于配置** —— 在 `POST` / `PATCH` 里传它不会生效。

推理参数（`temperature` / `maxTokens` / `timeoutSeconds` / `maxRetries`）现在**由服务端按提供商
直接取默认值**，不再接受客户端传入（控制台的「高级设置」面板已删除）。把模型的 `provider` 改掉时，
这四项会被刷新成新提供商的默认值 —— 否则会留下"kimi 的超时配另一个网关"这种两边都不对的组合。

`baseUrl` 会过**出站地址白名单**：只允许 `http` / `https`，并且拒绝回环
（`127.0.0.0/8`、`::1`、`localhost`）、链路本地（`169.254.0.0/16`，云元数据服务在这里）、
私有网段（`10/8`、`172.16/12`、`192.168/16`，以及 IPv6 的 `fc00::/7`、`fe80::/10`）、
运营商级 NAT（`100.64/10`）与组播 / 保留地址，也拒绝 `.internal` / `.local` 这类内部域名。
自定义公网端点（自建网关、代理）不受影响。

> 为什么：这个地址是**服务端替你去访问**的。允许它指向内网，等于把控制台会话
> 升级成"以服务器身份访问内网"——`http://169.254.169.254/latest/meta-data/...`
> 能读到云主机凭据，`127.0.0.1:xxxx` 能打到只监听本机的服务。被拒绝时返回 **400**
> 并说明原因。
>
> 白名单校验的是**字面主机**，不做 DNS 解析：一个解析到内网地址的公开域名
> （DNS rebinding）不在防护范围内。

### `POST /api/ai-models/:id/set-default`

把某个模型设为**默认模型** —— 新建机器人时预选的那个。

→ `{ "ok": true, "defaultAiModelId": 3 }`；模型不存在返回 **404**。

### `POST /api/ai-models/discover`

**从厂商接口实时拉取可用模型列表**，取代写死的模型清单。

```json
{ "provider": "custom", "baseUrl": "https://api.example.com/v1", "apiKey": "sk-..." }
```

→ `{ "ok": true, "models": [{ "id": "deepseek-flash", "label": "..." }], "source": "live", "message": "..." }`

`source` 为 `live`（真实拉取）或 `fallback`（拉取失败，回退到内置清单）。支持三种响应
方言：OpenAI 兼容 / OpenRouter、Anthropic、Gemini。

### `POST /api/ai-models/test-draft`

测试**尚未保存**的模型配置（不需要 `label`）。

### `POST /api/ai-models/:id/test`

测试已保存的模型。

> 探测请求的输出上限是 **256 tokens**，而不是 16。推理模型会先输出思考过程，
> 上限太小会导致「空回复」——那看起来像密钥坏了，实际是预算用光了。

---

## 策略

### `GET /api/strategies` / `GET /api/strategies/:id`

### `POST /api/strategies` / `PATCH /api/strategies/:id` / `DELETE /api/strategies/:id`

`config` 由 `StrategyConfigSchema`（zod）校验，非法字段会回退为默认值并记日志。

### `POST /api/strategies/:id/check` — 策略体检

对**模拟账户**跑一次完整链路，**不下任何真实订单**。这是排查「策略为什么不交易」
的首选工具。

```json
{ "aiModelId": 1, "symbol": "BTCUSDT" }
```

七个阶段依次执行，每个都返回 `ok` / `ms` / `detail`：

| # | 阶段 | 在查什么 |
|---|---|---|
| 1 | 交易所连接与合约元数据 | 网络、时钟、合约过滤器是否可用 |
| 2 | 选出候选标的 | 选币来源与门槛是否选得出东西；**是否被提示词预算裁剪** |
| 3 | 组装行情与指标 | 各周期 K 线是否够用（例如 MACD 需要足够的历史） |
| 4 | 构建提示词 | 提示词是否过大（超出预算会提前警告，而不是发出后再失败） |
| 5 | 调用模型 | 模型是否响应；**区分「没回答」与「输出被截断」** |
| 6 | 解析模型输出 | 模型输出是否符合约定格式 |
| 7 | 硬风控审查 | 提案是被市场否掉了，还是被风控否掉了 |

`verdict` 是给人看的一句话结论。

---

## 机器人

### `GET /api/traders` / `POST /api/traders`

**`exchangeAccountId` 可以省略或传 `null`** —— 那是**纯模拟盘机器人**（PR #185）：
它不下真实订单、余额由本地台账折算，所以**不需要任何真实交易所账户**。
传了 id 就必须真实存在（未知 id 返回 **400**）。

```jsonc
{
  "name": "演练",
  "exchangeAccountId": null,     // 省略 / null = 纯模拟盘；传 id 则绑定该账户
  "aiModelId": 1,
  "strategyId": 9,
  "cycleIntervalMinutes": 15,
  "paperStartingBalance": 1000,  // 可选：模拟盘本金。省略 = 用默认值
  "initialEquity": 0             // 可选：收益率的基准。省略/0 = 由服务端决定来源
}
```

**`paperStartingBalance`**（可选，只对模拟盘有意义）：
显式传值时必须是 **10 ~ 10 亿** 之间的数字（`0` 也会被拒 —— 它静默回落到默认值会让
操作员填的数字在界面上消失）。省略时服务端回落 `initialEquity`，再回落到首次启动时的默认本金。
它**与 `initialEquity` 不是一回事**：后者是收益率的分母，前者是模拟钱包的本金（永不被覆盖）。

创建时 **`initialEquity` 可省略**，服务端按情形决定起始权益：

- **绑定了交易所账户**：省略（或传 0）时**从该账户读取真实钱包余额**作为基准；
- **纯模拟盘（没有账户）**：不可能读真实钱包，用 `paperStartingBalance`（或 `initialEquity`）。

```json
{ "ok": true, "id": 5, "initialEquity": 9.9864505, "equitySource": "exchange" }
```

`equitySource` 取值：

| 值 | 含义 |
|---|---|
| `exchange` | 从交易所实时读取成功 |
| `manual` | 操作员手动指定了 `initialEquity` |
| `paper` | **纯模拟盘**：起始权益来自 `paperStartingBalance` / `initialEquity`。此时没有真实账户可读（PR #185 新增） |
| `unavailable` | 读取失败且没有可用兜底，起始权益为 0 —— **此时收益率百分比没有意义** |

> 起始权益是收益率的基准，填错会让之后所有绩效数字都错，所以默认是**读取**而不是手填。
>
> `aiModelId` 在 `mode: 'ai_team'` / `'jev'` 下**被忽略**（这两种模式的模型出口不来自「AI 模型」列表），
> 但请求体里仍然需要一个真实存在的 id 来满足外键。

### `PATCH /api/traders/:id`

部分更新；**运行中的机器人必须先停止**（返回 **409**）。
`exchangeAccountId` **不能通过编辑修改**：值真的变了会返回 **400**（换账户请新建机器人）。
`paperStartingBalance` 与创建路径受**同一套边界校验**。

### `DELETE /api/traders/:id`

删除机器人（会先停掉它）。它的成交 / 决策 / 智能体记录随之级联删除 —— **删之前先确认账本已对过账**。

### `POST /api/traders/:id/start`

```json
{ "dryRun": false }
```

→ `{ ok, preflight: PreflightCheck[] }`。**任何 `blocking` 的检查失败都会阻止启动**，
返回的 `preflight` 供界面逐项展示。受全局熔断开关约束。

### `POST /api/traders/:id/stop`

停止。正在运行的周期会跑完，持仓保持不变。

### `POST /api/traders/:id/run-once`

不等待周期间隔，立即跑一轮。**会真实下单。** 受全局熔断开关约束。

### `POST /api/traders/:id/reconcile` — 对账

从交易所的成交历史重建台账。**不下任何订单，且不受全局熔断开关约束**——
它只修正账目，正是应该在交易被禁用时也能做的事。**停止状态下也能用。**

机器人**正在运行**时，这次对账会先等当前那一轮决策周期结束（有超时上限；超时则跳过本次对账并记一条警告）。
两个实例同时对账会让同一笔平仓被记两次或互相覆盖，所以这里必须串行——不是延迟问题，是记账正确性问题。

→ `{ "ok": true, "recovered": 1, "corrected": 4, "funding": 0, "foreignRounds": 144, "foreignNet": -1.893744 }`

| 字段 | 含义 |
|---|---|
| `recovered` | 补录的成交数（平台此前完全没有记录） |
| `corrected` | 按交易所数字修正的成交数（例如补齐入场手续费） |
| `funding` | 归集到的资金费合计 |
| `foreignRounds` | **不属于本平台任何机器人**的成交笔数（外部活动） |
| `foreignNet` | 这些外部成交的净额 |

> **为什么需要它**：平台只有在**自己活着的时候**才能观察到平仓。交易所侧止盈触发时
> 若进程已停，这笔平仓永远不会被记账——实测曾因此丢失一笔 +0.6563 的盈利回合，
> 账面显示亏损而账户实际盈利。详见 README 的「盈亏口径与对账」。

> **`foreignRounds` 是什么**：账户上**本平台之外**的交易活动（另一个程序、
> 交易所端的手动操作）。它们直接改变余额，却不计入任何机器人的绩效——
> 所以「机器人显示在赚钱、账户却在缩水」可以同时成立。
> 这个数字就是用来解释那个差额的。归属判据是：这一回合的入场订单号
> **既不在本机器人的订单历史里，也不在本平台任何机器人的订单历史里**。

### `POST /api/traders/:id/agent-review` — 让 AI 立刻审视一次

**AI 托管**模式下唯一的人工触发入口：不等它的定时唤醒，立刻跑一次策略审视
（它会先读自己的历史调整与真实结果，再决定要不要改参数）。

→ `{ "ok": true, ... }`。审视**已经在跑**时返回 **409**（`{ "ok": false, ... }`）——
两次审视同时跑会互相覆盖，所以这里拒绝而不是排队。

### `POST /api/traders/:id/positions/:symbol/close` — 手工平掉一个标的

先撤掉该标的的**全部挂单**，再市价平仓。`symbol` 不区分大小写。

> 为什么必须先撤单（§2.7）：`closePosition` 的条件单在手工平仓后**依然存活**，
> 会朝反方向开出新仓 —— 平完仓反而多了一张反向单。

失败时返回 **400** 并带原因。

### `POST /api/traders/:id/positions/close-all` — 手工平掉全部仓位

逐标的走上面那条路径，返回已平仓的标的。失败返回 **400** 并带原因
（**不会静默跳过某一笔** —— 手工平仓最忌讳"以为全平了、其实还剩一个"）。

---

## 机器人数据

### `GET /api/traders/:id/stats`

```jsonc
{
  "traderId": 5,
  "initialEquity": 9.9864505,       // 起始余额（从交易所读取）
  "equity": 10.25858366,            // 归属权益 = initialEquity + realizedPnl + unrealizedPnl
  "accountEquity": 10.25858366,     // 所属交易所账户（共享钱包）的权益；同一账户下的每个机器人读数是同一个数
  "totalReturnPercent": 2.725,

  // ---- 盈亏拆解（净是主数字）----
  "realizedPnl": 0.27213316,        // 净 = 毛 − 手续费 − 资金费
  "grossRealizedPnl": 0.342671,     // 毛
  "totalFees": 0.07053783,          // 手续费（开仓 + 平仓两侧）
  "totalFunding": 0,                // 资金费，负 = 支付
  "unrealizedPnl": 0,

  // ---- 绩效 ----
  "totalTrades": 4,
  "wins": 1,
  "losses": 3,
  "winRatePercent": 25,             // ← 百分数（0–100），不是小数
  "profitFactor": 0.42,
  "avgWin": 0.632, "avgLoss": 0.120,
  "maxDrawdownPercent": 0.5,
  "sharpeRatio": null,
  "bestTrade": 0.632, "worstTrade": -0.184,
  "openPositions": 0,
  "cyclesRun": 3,
  "uptimeHours": 1.2
}
```

**胜负按净盈亏判定**：一笔在价格上小赚、但不够付手续费的交易算**亏损**。
按毛值算会同时美化胜率和盈亏比。

**`equity` 是归属口径**（`初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈`），
`unrealizedPnl` 同样是本机器人自己持仓的浮盈。**同一个交易所账户下可以跑多个机器人，
它们共用一份凭据与一个钱包** —— 账户的钱包余额只在 `accountEquity` 里给出，
它不是任何一个机器人的业绩。曾经 `equity` 写的就是共享钱包余额，后果是一个从未成交的
机器人显示别的机器人挣来的收益率（实盘上量到 +2.67%），而两个机器人的收益率完全相同。

响应里还有三个**运行时**字段（不属于 `TraderStats`，仓储层算不出来）：

| 字段 | 含义 |
|---|---|
| `circuitBreaker` | 熔断器状态（读不到为 `null`） |
| `maxLeverage` | 有效杠杆上限（`null` = 读不到，界面显示"不知道"而不是 0） |
| `dryRun` | 这台机器人此刻是不是纸面模式。**`null` = 它没在运行**，客户端据此不渲染那一行，而不是渲染成「实盘」 |

机器人不存在时返回 **404**（不能返回"权益 0"—— 那会被读成"这个机器人亏光了"）。

### `GET /api/traders/:id/trades`

```jsonc
{
  "id": 4,
  "symbol": "POWERUSDT",
  "side": "long",
  "quantity": 131,
  "entryPrice": 0.18064,
  "exitPrice": 0.18565,
  "leverage": 5,

  "pnl": 0.65631,          // 毛，直接取交易所的 realizedPnl
  "entryFee": 0.01183192,
  "exitFee": 0.01216007,
  "fee": 0.02399199,       // 两者之和
  "fundingFee": 0,
  "netPnl": 0.63231801,    // ← 真正影响余额的数字
  "pnlPercent": 13.36,     // 基于净盈亏

  "closeReason": "reconciled",
  "source": "reconciled",  // 'bot' = 运行期记账；'reconciled' = 对账补录
  "openedAt": "...", "closedAt": "...", "holdMinutes": 25
}
```

**恒等式**：`pnl − fee − fundingFee === netPnl`。

| 参数 | 说明 |
|---|---|
| `limit` | 一页多少条。默认 100，上限 200 —— **钳制不报错** |
| `before` | 游标（按 `id`）。非数字/缺失按"第一页"处理 |
| `beforeClosedAt` | 复合游标的另一半（该行的 `closedAt`）。**与 `before` 同时给才启用按成交时间分页**；只给 `before` 时退回旧行为（按 id 分页） |

> 为什么要复合游标：`trades.id` 是插入顺序，而对账补录的行 **id 更大、成交时刻更早**。
> 只按 id 分页会在页边界漏行（实测 18 行里 4 处乱序）。

### `GET /api/traders/:id/positions`

持仓视图，含标记价、未实现盈亏、止损止盈、强平价、杠杆。

**来源取决于机器人是否模拟盘**（`dry_run`）。实盘机器人的持仓取自交易所；**模拟盘机器人的持仓只存在于本地台账**（交易所侧本来就没有它们，因为它的成交是本地模拟的）。两种情况都会返回真实持仓，不要用"空数组"判断机器人没在跑 —— 那要用 `/account` 的 `live` 与 `positionsSource`。

### `GET /api/traders/:id/account`

实时的交易所账户状态（钱包余额 / 可用 / 未实现 / 保证金占用）。
机器人未运行时返回 `{ "live": false, "account": null, "positions": [] }`。

| 字段 | 含义 |
|---|---|
| `live` | 交易所读数是否可用。`false` 有两种原因：**机器人没在跑**，或**读交易所失败**（后者同时回 503... 见下） |
| `positions` | 持仓行。**来源见 `positionsSource`** —— 不要假定它总是来自交易所 |
| `positionsSource` | `"exchange"` = 来自交易所；`"local_mirror"` = **模拟盘机器人的本地台账**（交易所对它不适用）；`"none"` = 读不到。**前端据此区分「交易所真的没有仓」与「这是模拟仓」** |
| `ownUnrealizedPnl` | **本机器人自己**的浮盈（按它的入场价与数量算，与交易所怎么合并持仓无关）。它**始终按本地台账算**，即使实盘机器人也一样 |
| `openOrderCount` | 交易所口径的挂单数（界面用它判断"有没有东西占着保证金"） |

> ⚠️ **实盘机器人的 `positions` 仍以交易所为准；模拟盘才走本地台账。** 这个分支建在"建连接之前"：
> 若先连交易所再按模拟盘换来源，交易所一抖动就会走 catch，模拟盘于是拿到 `live:false` → `/positions` 回 503，
> 而它的模拟仓根本不需要交易所 —— 一次**无关的网络故障**让它闪烁，比不修还糟。

### `GET /api/traders/:id/foreign-activity`

账户上**不属于本平台任何机器人**的成交（外部活动）。

```json
{
  "rounds": 144,
  "net": -1.893744,
  "symbols": ["APTUSDT", "SOLUSDT", "ZECUSDT"],
  "firstAt": "2026-09-18T17:50:35.480Z",
  "lastAt": "2026-09-19T01:50:28.850Z",
  "detectedAt": "2026-09-19T17:24:23.123Z"
}
```

| 字段 | 含义 |
|---|---|
| `rounds` | 检测到的外部成交笔数 |
| `net` | 它们的净额（毛盈亏 − 手续费）—— **就是「账户与绩效对不上」的那个差额** |
| `symbols` | 涉及的标的（最多 20 个） |
| `firstAt` / `lastAt` | 外部活动的首次与末次成交时间 |
| `detectedAt` | 上次检测的时刻 |

> **`detectedAt` 为 `null` 与 `rounds = 0` 是两件事**：
> 前者是「**从来没检测过**」，后者是「检测过，账户是干净的」。
> 界面必须分开说 —— 把"不知道"显示成"没问题"会让操作员错过一次资金安全事故。

> **为什么是独立端点而不是塞进 `/account`**：`/account` 是**实时**读交易所的，
> 而这个结论来自**最近一次对账**（每 10 轮一次深扫）。两者时效性与失败方式都不同：
> 交易所读不到时 `/account` 报错，而这个结论**仍然有效**。
> 混在一个响应里会让「哪个是实时、哪个是上次的」说不清。

> **机器人停止之后仍然可读** —— 那正是最需要它的时刻：操作员看到余额不对，
> 而机器人已经停了、不会再跑对账。

### `GET /api/traders/:id/orders`

订单记录，含 `purpose`（`entry` / `exit` / `stop_loss` / `take_profit`）、触发价、
成交均价、手续费、交易所订单号。

| 参数 | 说明 |
|---|---|
| `limit` | 一页多少条。默认 100，上限 200 —— **钳制不报错** |
| `before` | 游标：只返回 `id` 比它更小的订单。非数字/缺失按"第一页"处理 |

### `GET /api/traders/:id/decisions`

决策审计。每条记录包含该周期的**完整提示词**、**模型原始响应**、解析出的决策、
思维链与逐条执行结果——包括被风控**拒绝**的提案和原因。

| 参数 | 说明 |
|---|---|
| `limit` | 默认 50，上限 200 —— 钳制不报错 |
| `before` | 游标：只返回 `id` 比它更小的记录。非数字/缺失按"第一页"处理 |

> **列表返回的记录里 `systemPrompt` / `userPrompt` 恒为空字符串**：提示词全文只在
> `GET /api/traders/:id/decisions/:recordId` 单条取。实测 910 条记录里 `user_prompt`
> 合计 81.6 MB（单条最大 283 KB），列表若带上全文，一次 30 条 ≈ 2.7 MB JSON，
> 浏览器解析要几十秒。

### `GET /api/traders/:id/decisions/:recordId`

单条决策的完整审计详情。记录不存在、或不属于该机器人时返回 **404**。

### `GET /api/traders/:id/equity`

归属权益曲线快照序列。

| 参数 | 说明 |
|---|---|
| `limit` | 默认 500，钳制在 1–5000（`?limit=-1` 会被钳成 1 —— SQLite 里 `LIMIT -1` 表示"不限行"） |

每条快照里：

| 字段 | 口径 |
|---|---|
| `equity` | **本机器人归属权益** = 初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈 |
| `unrealizedPnl` | 本机器人自己持仓的浮盈（不是账户的总浮盈） |
| `openPositions` | 本机器人自己的未平仓合约数 |
| `accountEquity` / `accountUnrealizedPnl` | 所属**账户**（共享钱包）的两个数 |
| `availableBalance` / `marginUsed` | 账户级：自由保证金无法按机器人拆分，交易所也不提供这个口径 |

---

## 机器人：智能体审计与实时开关

这一组是**只读的审计/观测**与**运行时开关**。除标注外都需要认证。

### `GET /api/traders/:id/agent-audit`

AI 托管 / 团队模式的审计数据，一次返回三张表：

```jsonc
{
  "runs": [ /* 每次角色运行：谁跑了、用了多少 token、多久 */ ],
  "experiments": [ /* 参数实验：改了什么 + 真实结果 */ ],
  "memory": [ /* 教训记忆（按标的） */ ],
  "pendingExperiments": 2,   // 还没等到结果的实验数
  "runCount": 128            // 累计运行次数
}
```

| 参数 | 说明 |
|---|---|
| `limit` | 每张表返回多少条。默认 20，钳制在 1–100 |

> 合成一个响应而不是三个端点：界面上这块面板要同时显示"这一轮做了什么 + 学到了什么 +
> 之前试过什么"，分三个请求会让面板出现三次加载闪烁。

### `GET /api/traders/:id/agent/last-seen`

每个岗位**最近一次被观察到干活**的时刻（团队看板的"最近活跃"数据源）。

```jsonc
{
  "roles": [
    { "role": "risk_officer", "lastSeenAt": "2026-11-09T12:00:00.000Z", "source": "log" }
  ]
}
```

| 参数 | 说明 |
|---|---|
| `limit` | 扫描多少条 `runtime_logs`。默认 200，钳制在 1–500（`RUNTIME_LOG_CAP`） |

`source` 说明这个时刻是从哪份数据里看出来的：`log` = 服务端直写的步骤日志（`runtime_logs`），
`cot` = 那一轮决策审计块里的产出摘要（`decision_records.cot_trace`）。

### `GET /api/traders/:id/agent/:role/steps`

某个岗位的**历史工作详情**（只读）。

| 参数 | 说明 |
|---|---|
| `limit` | 默认 50，钳制在 1–200 |

```jsonc
{
  "role": "judge",
  "total": 37,          // 过滤后的总条数（不含正文为空的条目）
  "steps": [
    { "at": "...", "phase": "decision", "message": "...", "source": "log" }
  ],
  "lastSeenAt": "..."   // 最近一条的时刻；没有条目时为 null
}
```

`role` 只接受 `[a-z_]+`（不是安全边界，是"这个 id 必然匹配不到真实行"的诚实判据）；
含中文/空格的 role 返回空数组。正文为空的条目（模型只调了工具、没产出文字）会被**过滤掉**，
以免它们占满 `limit` 名额、把真正有内容的记录挤出去。

### `POST /api/traders/:id/selfcheck` — 跑一次自检

跑一次**不依赖模型**的确定性自检，并把结果写进 `runtime_logs`（`scope='selfcheck'`）。
**是 POST 不是 GET**：它会写库，GET 不该有副作用。

| 参数 | 说明 |
|---|---|
| `windowHours` | 检查窗口（小时）。默认 6，钳制在 1–168 |

```jsonc
{
  "windowHours": 6,
  "deterministic": [ /* 确定性发现：不依赖模型 */ ],
  "ai": [ /* AI 层发现（没跑 AI 层时为空数组） */ ],
  "evidence": { /* 取数证据，供人核对 */ }
}
```

### `GET /api/traders/:id/control` / `POST /api/traders/:id/control/:key`

**实时生效**的布尔开关（JEV 初筛开关等）。开关是**进程级/全局**的（不属于某台机器人），
路径里的 `:id` 只用来校验 id 合法。

```jsonc
// GET → { "switches": [{ "key": "jev_prefilter", "label": "...", "effect": "...", "on": true, "source": "ui" }] }
// POST /api/traders/:id/control/jev_prefilter  { "on": false }
// → { "switches": [ ... ] }   ← 写入后回读，界面不用再发一次 GET
```

`source` 说明当前值的来源：`ui` = 界面上设过（重启保持）、`env` = `.env` 初始值、
`default` = 代码默认值。未知 `key` 返回 **400**；`on` 不是布尔返回 **400**。

### `GET /api/traders/:id/jev-options` / `POST /api/traders/:id/jev-options/:key`

JEV 模式专属的枚举 / 数字 / 布尔配置（**只影响 `mode === 'jev'` 的机器人**）。
GET 同时返回预设：

```jsonc
{
  "options": [
    {
      "key": "min_confidence", "label": "最低置信度", "why": "...",
      "kind": "number", "range": { "min": 0, "max": 100, "step": 1, "unit": "分" },
      "value": "55", "source": "ui"     // source: 'ui' = 界面设过；'default' = 代码默认
    }
  ],
  "presets": [ { "id": "balanced", "label": "均衡（推荐）", "summary": "...", "values": { /* … */ } } ]
}
```

写一个选项：`POST /api/traders/:id/jev-options/min_confidence`，body `{ "value": 55 }`。
服务端**逐类型校验**（枚举必须在候选里、数字必须在 `range` 内、布尔只认 `on`/`off`），
非法 → **400 + 中文原因**；未知 key → **400**。写入后回读整个选项表。

### `POST /api/traders/:id/jev-presets/:presetId`

一键套用一个内置预设（一次调用原子写入整组参数，避免"一半新一半旧"的自相矛盾配置）。

→ `{ "applied": 23, "options": [ ... ] }`；预设 id 未知或含非法参数时返回 **400**
（`unknown` 里列出是哪几项）。

---

## 行情

### `GET /api/market/symbols`

可交易合约列表，含价格、涨跌幅、成交量等，用于选币与界面展示。

### `GET /api/market/klines`

| 参数 | 说明 |
|---|---|
| `symbol` | 必填 |
| `interval` | 如 `1m` / `5m` / `15m` / `1h`。默认 `15m` |
| `limit` | 默认 200，上限 1000 |

---

## 事件流

### `GET /api/events` — WebSocket

实时推送，避免界面轮询。事件类型（`ServerEvent` 联合类型）：

| type | 载荷 |
|---|---|
| `trader_status` | 状态变化（运行 / 停止 / 安全模式 / 错误） |
| `cycle_start` / `cycle_end` | 周期开始与结束 |
| `decision` | 新的决策记录 |
| `positions` | 持仓变化 |
| `trade` | 成交（平仓）——**报价用净盈亏** |
| `log` | 日志行 |

浏览器 WebSocket API 无法自定义请求头，因此握手时 token 通过**查询参数**传递。
**这要求传输层是 HTTPS**，否则 token 会以明文出现在链路上。

> 这是**唯一**接受 `?token=` 的端点。REST 路由只认 `Authorization` 头：
> URL 会被反向代理的 access log、浏览器历史和 `Referer` 记录下来，
> 把会话凭据放进 URL 等于把它抄送到多个你无法控制的地方。
>
> 校验同样包含**撤销**检查：账户改过凭据之后，旧令牌在 WebSocket 上也不再被接受。
