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
  "version": "0.1.0",
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
| 距离上一轮决策结束 < `max(周期 × 2, 300s)` | 健康 |
| 超过该阈值 | **503**，并在 `staleTraders` 里列出 |
| 已启动但还没跑完第一轮，且启动未满阈值 | 健康（冷启动宽限） |
| 已启动但还没跑完第一轮，且已超过阈值 | **503**，`awaitingFirstCycle: true` |
| `stopped` / `safe_mode` / `error` / `starting` | **不影响状态码** |

阈值的取法见 `packages/server/src/api/server.ts` 的 `STALE_CYCLE_MULTIPLIER` 与
`STARTUP_GRACE_MS`；简单说：`last_cycle_at` 只在**一轮结束**时写入，所以 1 倍周期
必然产生假警报（每轮都会短暂越线），2 倍才是"连续两轮都没跑完"；
300 秒是下界，避免冷启动时编排器在不该重启的时候重启容器。

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
  "weightUsed": 412,
  "weightLimit": 2400,
  "requestsInFlight": 3,
  "maxRequestsInFlight": 6,
  "runningTraders": [1, 2],
  "failedTraders": []
}
```

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
    "equity": 10.25858366,           // 保证金余额 = 钱包 + 未实现
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

推理参数（`temperature` / `maxTokens` / `timeoutSeconds` / `maxRetries`）**全部可选**，
留空时按提供商取默认值。

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

创建时 **`initialEquity` 可省略**。省略（或传 0）时服务端会**从配置的交易所读取真实
钱包余额**作为起始权益：

```json
{ "ok": true, "id": 5, "initialEquity": 9.9864505, "equitySource": "exchange" }
```

`equitySource` 取值：

| 值 | 含义 |
|---|---|
| `exchange` | 从交易所实时读取成功 |
| `manual` | 操作员手动指定 |
| `unavailable` | 读取失败，起始权益为 0 —— **此时收益率百分比没有意义** |

> 起始权益是收益率的基准，填错会让之后所有绩效数字都错，所以默认是**读取**而不是手填。

### `PATCH /api/traders/:id` / `DELETE /api/traders/:id`

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

→ `{ "ok": true, "recovered": 1, "corrected": 4, "funding": 0 }`

| 字段 | 含义 |
|---|---|
| `recovered` | 补录的成交数（平台此前完全没有记录） |
| `corrected` | 按交易所数字修正的成交数（例如补齐入场手续费） |
| `funding` | 归集到的资金费合计 |

> **为什么需要它**：平台只有在**自己活着的时候**才能观察到平仓。交易所侧止盈触发时
> 若进程已停，这笔平仓永远不会被记账——实测曾因此丢失一笔 +0.6563 的盈利回合，
> 账面显示亏损而账户实际盈利。详见 README 的「盈亏口径与对账」。

---

## 机器人数据

### `GET /api/traders/:id/stats`

```jsonc
{
  "traderId": 5,
  "initialEquity": 9.9864505,       // 起始余额（从交易所读取）
  "equity": 10.25858366,            // 当前权益
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

### `GET /api/traders/:id/positions`

持仓视图，含标记价、未实现盈亏、止损止盈、强平价、杠杆。

### `GET /api/traders/:id/account`

实时的交易所账户状态（钱包余额 / 可用 / 未实现 / 保证金占用）。
机器人未运行时返回 `{ "live": false, "account": null, "positions": [] }`。

### `GET /api/traders/:id/orders`

订单记录，含 `purpose`（`entry` / `exit` / `stop_loss` / `take_profit`）、触发价、
成交均价、手续费、交易所订单号。

### `GET /api/traders/:id/decisions`

决策审计。每条记录包含该周期的**完整提示词**、**模型原始响应**、解析出的决策、
思维链与逐条执行结果——包括被风控**拒绝**的提案和原因。

| 参数 | 说明 |
|---|---|
| `limit` | 默认 50 |

### `GET /api/traders/:id/decisions/:recordId`

单条决策的完整审计详情。

### `GET /api/traders/:id/equity`

净值曲线快照序列。

---

## 行情

### `GET /api/market/symbols`

可交易合约列表，含价格、涨跌幅、成交量等，用于选币与界面展示。

### `GET /api/market/klines`

| 参数 | 说明 |
|---|---|
| `symbol` | 必填 |
| `interval` | 如 `1m` / `5m` / `15m` / `1h` |
| `limit` | 默认 400 |

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
