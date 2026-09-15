# AI 代理指南

**你是接手的 AI 编码代理，没有会话历史。** 本文是一份操作手册：先读什么、不可违反什么、怎么验证、
不能做什么、代码风格是什么。请把本文的约束当成硬约束，而不是建议。

这个项目会**动用真实资金**。它会自动在币安 USDT 本位合约上下单，一个错误可以亏掉账户里的钱。
所以你在这里的默认姿态应该是**保守**：不确定就查、改不动就别改、验证不了就别声称改好了。

---

## 1. 先读什么

按这个顺序读，构建一个最小可用的心智模型。**不要跳过第 4 项。**

| 顺序 | 读什么 | 目的 | 大概花多久 |
| --- | --- | --- | --- |
| 1 | 本文件 | 规则与边界 | 3 分钟 |
| 2 | [`README.md`](../README.md) | 这个产品是什么、控制台怎么用、有哪些已实现/暂缓的功能 | 8 分钟 |
| 3 | [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) | **为什么**这样设计。关键工程决策表（条件单端点、WS 路由、权重预算…）在这里 | 10 分钟 |
| 4 | [`docs/MODULES.md`](MODULES.md) | **改哪个文件**。含八条扩展配方与类型级约束清单 | 10 分钟，之后按需回查 |
| 5 | 下面这五个文件 | 任何改动都会碰到的东西 | 30 分钟 |
| 6 | [`docs/DEVELOPMENT.md`](DEVELOPMENT.md) | 怎么跑、怎么测、常见陷阱 | 按需 |

### 第 5 项：必须读的五个文件

| 文件 | 为什么它排在最前面 |
| --- | --- |
| `packages/server/src/risk/engine.ts` | **风控引擎**。整个设计的地基："模型提议，运行时裁决"。改任何与交易有关的逻辑前必须知道这里的 13 步检查 |
| `packages/server/src/trader/autoTrader.ts` | **交易循环**。12 步周期、对账、回撤守卫、执行、保护单、审计落库。这是最大也最重要的文件 |
| `packages/server/src/api/server.ts` | **API 层**。所有 HTTP 路由与 WebSocket 事件流，以及数据是怎么流向前端的 |
| `packages/server/src/store/repositories.ts` | **存储层**。所有表的读写、以及**净盈亏唯一算出来的地方** |
| `packages/shared/src/strategy.ts` | **策略配置的形状**。`StrategyConfig` 的所有字段，zod schema 是唯一事实来源 |

### 视任务类型追加

| 任务 | 追加读 |
| --- | --- |
| 改下单 / 交易所相关 | `packages/server/src/binance/broker.ts`、`symbols.ts`、`types.ts`，以及 **`docs/research/` 里的对应调研文档**（这些文档是实测出来的，每条都对应一个"踩了会亏钱"的坑） |
| 改 LLM 相关 | `packages/server/src/llm/client.ts`、`errors.ts`，以及 `docs/research/binance-ws-and-llm-apis.md` 的 LLM 部分 |
| 改 HTTP 接口 | `docs/API.md`（逐端点的参考文档，改接口必须同步它） |
| 改前端 | `packages/web/src/lib/api.ts`（唯一的后端客户端）、`lib/store.ts`、`App.tsx` |

### 省时间的捷径

- **想找某个东西在哪**：`docs/MODULES.md` 是按目录逐文件列的表，先查它。
- **想确认一个行为**：`grep` 源码，注释里通常已经解释了为什么。这个仓库的注释质量很高，
  而且**经常记录已经发生过的 bug**——那比任何设计文档都有信息量。
- **想验证一个改动**：见第 4 节。`npm run sim` 是性价比最高的一步。

---

## 2. 改动规则（不可违反的不变量）

以下每一条都是这个系统的**结构性保证**。破坏它们的改动，即使测试全绿，也是错的。

### 2.1 风控引擎是通往订单的唯一路径

**没有任何代码可以绕过 `packages/server/src/risk/engine.ts` 直接下单。**

- `AutoTrader` 只执行 `RiskVerdict.approved` 里的决策。
- 不要在 `executeOpen` / `executeClose` 里加"因为模型说了 X，所以这次可以例外"的分支。
- 不要在风控之外新增任何 `broker.placeOrder()` 调用点（除了 `liveSmokeTest.ts` 这个**人工确认过的**
  测试脚本，以及紧急平仓 `emergencyFlatten`——后者只在"保护单挂不上"时把仓位变回平坦，是在**减少**敞口）。
- 新的限制加到 `reviewOpen` / `reviewClose`，并**必须**写进 `adjustments` 或 rejection 的 `reason`。
  每一次运行时对模型的推翻都要留下痕迹——这是这个产品可被信任的前提。

### 2.2 每一张订单都要被记录

`orders` 表要包含**被拒绝的**订单，以及交易所的 `raw_response` 与 `error`。
`recordOrder()` 在成功与失败两条路径上都被调用，这不是冗余。

### 2.3 每一笔平仓都要入账

`trades` 表必须能重建出"账户上发生过的每一个完整回合"。三层保障，缺一不可：

1. **运行期记账**：`executeClose()` / `bookClosedPosition()` 两种平仓路径都要写 `trades`。
2. **持仓对账**：`reconcilePositions()` 发现本地有、交易所没有的仓位，判定原因并记账。
3. **成交历史重建**：`reconcileTradeHistory()` 从 `/fapi/v1/userTrades` 补齐**进程未运行时**发生的平仓。

第 3 层有**归属闸门**（`orders.exchangeOrderIds()`）：只有本机器人自己挂过的交易所订单号对应的回合才会被认领。
**不要为了"多记几笔"而放宽这个闸门**——多个机器人共用一个账户时，没有闸门会让每个机器人都把
账户的全部盈亏记到自己头上，这在实盘上真的发生过。

### 2.4 模型的输出是不可信输入

模型响应要**防御性解析**（`packages/server/src/strategy/parser.ts`）：

- 对**结构宽容、对语义严格**：格式烂的响应产出"没有决策"，而不是"畸形订单"。
- 未知 action、不在候选集内的标的、方向不符的平仓、重复开仓——都要**拒绝并带理由上报**，
  绝不静默丢弃。
- 不要为了让某个"模型经常这么写"的格式通过而放宽校验；要加的是**字段别名**
  （`size` → `position_size_usd`、`sl` → `stop_loss` 等，`coerceRawDecision()` 里已有大量先例），
  而不是放开语义校验。
- 提示词里嵌入的是**事实**（行情、账户、持仓），不是指令。

### 2.5 账目必须能与交易所对得上：**净 = 毛 − 手续费 − 资金费**

| 量 | 含义 | 谁提供 |
| --- | --- | --- |
| `pnl`（毛） | 交易所自己的 `realizedPnl`，**不由平台重算** | 交易所 |
| `entryFee` / `exitFee` / `fee` | 开仓侧、平仓侧、合计手续费。**两侧都要记** | 交易所成交记录 |
| `fundingFee` | 资金费（每 8 小时结算，**任何成交记录里都看不到**） | `/fapi/v1/income` |
| `netPnl` | **毛 − 手续费 − 资金费**。这才是真正影响余额的数字 | `trades.insert()` 统一算出 |

- **`TraderStats.realizedPnl` 是净的**，毛值在 `grossRealizedPnl`。
- **`net_pnl` 和 `pnl_percent` 只在 `trades.insert()` / `applyExchangeFigures()` 里算一次**，
  不要让调用点各算一遍。
- 资金费读不到时该项记 0 并在日志里说明，**不要假装算过**。
- 非结算资产计价的手续费（BNB 抵扣等）**不计入 `fee`**——它和 USDT 不是同一个单位，
  要单独报告而不是悄悄加进一个口径不同的总数。
- 对账是**幂等**的：重复执行只修正、不重复插入。

引用 `README.md` 里的实测数字作为验收标准：对账后
`平台记录 + 机器人之外的活动 = 交易所钱包实际变动`，差额是浮点精度极限。

### 2.6 每笔开仓必须有交易所侧保护

开仓后**先挂止损并验证**；挂不上且 `requireStopLoss` 为真时，**立刻市价平仓**并记录错误。
一个没有保护的杠杆仓位是最糟糕的状态，宁可立刻退出。改 `executeOpen` 时不要动这个顺序或这段逻辑。

### 2.7 手动平仓前先撤掉该标的的全部挂单

`closePosition=true` 的条件单在手动平仓后**依然存活**，会朝反方向开出新仓。
`cancelAllOrders(symbol)` 同时撤普通单（`/fapi/v1/allOpenOrders`）与 Algo 单
（`/fapi/v1/algoOpenOrders`）——**两个端点都要打**。

### 2.8 周期不重叠

`cycleInFlight` 守卫保证超时的周期不会被下一个 tick 覆盖执行。去掉它会导致仓位重复计数与订单重复提交。

### 2.9 减少风险的工作先于增加风险的工作

平仓先于开仓，回撤守卫与熔断器先于问模型。理由见 `docs/DEVELOPMENT.md` 第 5 节。
不要在 `sortDecisions()` 的 `ACTION_PRIORITY`、`RiskEngine.review()` 的重排逻辑、
或 `runCycle()` 的步骤顺序上做"优化"。

---

## 3. 验证要求

### 3.1 声称一个改动"能用"之前，必须跑过

```bash
npm run typecheck   # 必须 0 退出
npm test            # 必须全绿（当前 194 个用例）
```

改了前端再加 `npm run build`。这三条是**最低门槛**，不是可选项。

### 3.2 不要声称你没实际运行过的功能

具体含义：

- 说"这个页面好了"之前，**在浏览器里真的点过它**（编译通过不等于能用）。
- 说"这个端点工作了"之前，**真的请求过它**（`curl` 或前端）。
- 说"下单路径没问题"之前，说明你是在哪一档验证的（见第 6 节），以及那一档**验证不了什么**。
- 修了一个 bug 但没能复现它 → **说出来**，别暗示已经验证。
- 有一个你无法确认的事实 → 说"我没能验证这一点"，或者干脆不写。
  **一份说错了的文档比没有文档更糟：照着它做的人会白白损失几个小时。**

### 3.3 外部行为要用真实环境验证

只要你的断言依赖**外部系统的行为**（币安的响应字段、下单参数名、LLM 厂商的方言、
某个端点的返回形状），就必须对着真实环境验证，而不是靠文档或推理。

- `packages/server/src/binance/types.ts` 的字段名是**对着实盘响应逐字段核对过的**，不是从文档抄的。
  注释里明确写了这一点（`walletBalance` 而非 `balance`、`unRealizedProfit` 与 `unrealizedProfit` 的差别）。
- `docs/research/` 整个目录就是为此存在的：动手改 `binance/` 或 `llm/` 之前先读对应文档，
  改动之后如果无法实测，要在 PR / 回复里说明"这一点未在真实环境验证"。
- 有一个具体的历史教训：一个网关在 **HTTP 400** 里返回 `模型不可用：deepseek-flash` 这种
  **临时不可用**信息，而 400 通常被正确地判为不可重试，导致一次本可成功的请求被放弃。
  修复方式是在 `llm/errors.ts` 里显式列出这类可用性短语——**这是实测出来的**，不是推演的。

### 3.4 测试里写**观测到的真实值**，不要写你算出来的值

- 指标测试固化的是 Wilder 原始定义下的经典参考值。
- 账户、手续费、对账的测试断言的是**真实交易所响应**里观察到的数字。
- **不要为了让测试通过而把断言改成你的实现算出来的那个数。** 先确认哪个是对的。
  这条规则存在的意义就是：当实现和参考值不一致时，**默认是实现在错**，而不是参考值过时了。

### 3.5 新测试要写注释说明"为什么这个测试存在"

这是本仓库最一致的工程习惯。注释通常直指它防的那个 bug。真实例子：

- `orders.test.ts`：*"Sending a conditional order to the wrong endpoint is rejected by Binance with
  `-4120`, and the practical consequence is an open position with no stop loss — so the routing
  decision is worth pinning down."*
- `risk/engine.test.ts` 的 fixture 注释解释了为什么盈亏比必须设成 1:3，否则用例在到达被测行为之前就被拒了。
- `engine.ts` 里注释记录了*把 `clampStopLoss` 与 `clampTakeProfit` 合并会静默让每笔止盈失效*。

**修 bug 时同理**：先写一个能复现的用例，再改代码，并在注释里写清这个 bug 是什么。

### 3.6 数据库相关的测试不要碰 `data/`

用临时目录，模式见 `packages/server/src/trader/autoTrader.test.ts`：
`mkdtempSync` 建临时目录 → `initDb(tmp)` → `after()` 里 `closeDb()` + `rmSync` →
`beforeEach()` 清空所有表并重建实体。

---

## 4. 不能做的事

### 4.1 不要提交 `.env` 或 `data/`

`data/` 里有加密后的交易所凭据、AES 主密钥、数据库。`.gitignore` 里写得很清楚：

> *"主密钥和数据库放在一起就等于明文凭据：拿到这两样就能解密出交易所 API Secret。"*

不要用 `git add -f` 绕过。同理不要提交 `.env.*`、`*.pem`、`deploy.local.ps1`，
以及 AI 代理的会话目录（`.dsh/`、`.claude/`、`.cursor/` 等——那里有完整对话历史，
经常包含粘贴过的密钥和服务器地址）。

### 4.2 不要为了让测试通过而削弱风控

这是**绝对禁止**的。如果一条风控规则让你写的测试失败了，那么：

- 要么测试的 fixture 不对（多数情况——检查它是否满足了所有前置条件，
  例如 `risk/engine.test.ts` 的 fixture 为什么要按 1:3 设盈亏比）；
- 要么被测的行为本来就该被拒绝（那就是测试写错了）；
- 要么**规则真的有问题** → 那是产品决策，需要在回复里明确说明并等待人的确认，
  而不是自己把上限调大。

**不要放宽 `maxPositions` / 杠杆上限 / `maxMarginUsage` / 名义价值上限 / `minRiskRewardRatio` /
`minConfidence` / `requireStopLoss` 来让某个东西"跑通"。** 也不要删掉 `adjustments` 的记录。

### 4.3 不要在没有强理由的情况下引入原生依赖

`node:sqlite` 是刻意选的，就是为了让 `npm install` 没有任何编译步骤（理由见 `docs/DEVELOPMENT.md` 第 1 节）。
`better-sqlite3`、`bcrypt`、`sharp` 这类需要 node-gyp / 预编译二进制的包，会把这个优势抹掉，
而且失败信息通常完全指不到原因。

确实必要的话：在回复里明确说明**为什么现有方案不行**、以及它对部署环境（`docs/DEPLOYMENT.md`）
的影响。不要悄悄加进去。

同等原则适用于**任何新依赖**：JWT 是手写的、`.env` 解析是手写的、指标是自实现的、
HTTP 客户端就是内置的 `fetch`。默认答案是"自己写那 30 行"，而不是"加一个包"。

### 4.4 不要把站点专属信息放进仓库

**主机名、域名、IP、服务器路径、凭据——一个都不要。**

用占位符：`my-server`、`https://quant.example.com`、`/srv/<应用目录>`。
`scripts/deploy.ps1` 就是这么做的，注释写明了理由：

> *"部署脚本里不含任何站点专属信息（主机、域名、路径）。那些属于部署者自己的环境，不属于项目代码。"*

部署者的私有配置放在 `deploy.local.ps1`（已 gitignore）。

**同理适用于**：日志、注释、测试 fixture、错误信息、文档示例、提交信息。
如果你在终端输出里看到了真实的域名或 IP 并想把它写进代码或文档，**不要写**。

### 4.5 其它禁止项

- ❌ 不要修改已经发布过的迁移 SQL（`db/schema.ts` 的 `M1_INITIAL` / `M2_TRADE_ACCOUNTING`）。
  只能**追加**新的 `version`。
- ❌ 不要删掉 `simulate/simulatedExchange.ts` 里的 tick 精度校验与 `-2021` 立即触发校验。
  它们存在的全部意义就是让"止损挂不上去"这类 bug 在离线时被抓到。
- ❌ 不要用 `git add -f` 绕过 `.gitignore`。
- ❌ 不要把 API Key、Secret、密码写进代码、注释、日志或测试。日志里只允许出现**掩码**
  （`maskSecret()`），这个约定在 `llm/client.ts` 里也有明确注释。
- ❌ 不要在 `data/` 之外的地方写运行时文件，也不要让脚本把数据写到真实库里
  （除了 `demoCycle.ts`——它**故意**写真实库，但所有东西都带 `[DEMO]` 前缀并且可 `--clean` 清除）。

---

## 5. 写代码的风格要求

这些是从现有代码里读出来的**真实约定**，代码本身是最好的参考。

### 5.1 注释解释**为什么**，常常直指它防的那个 bug

这是本仓库最显著的特征。不要写"做了什么"的注释（代码已经说了），要写"为什么这样做"，
尤其是为什么**不能**用那个看起来更直观的写法。

真实例子（都是源码原话的意思）：

- `symbols.ts` 的 `roundTriggerPrice`：*"omitting [tick rounding] is a live bug this codebase shipped
  once: Binance rejects an unrounded trigger with `-1111`... which means **the stop loss is never
  placed at all**."*
- `broker.ts` 的 `placeOrder`：*"A previous version trusted the risk engine to have produced valid
  numbers — but the risk engine only guarantees the *direction* of a stop, not its tick alignment,
  so the exchange rejected every stop with `-1111`... and positions ran unprotected."*
- `engine.ts`：*"conflating the two silently inverts the target for every trade. This bug was caught
  once by a unit test during development."*
- `autoTrader.ts` 的 `detectCloseReason`：*"Checking 'is the stop gone?' therefore always answered yes
  and every take-profit was booked as a stop loss."*
- `schema.ts` 的 `M2_TRADE_ACCOUNTING`：一段实测数字（+0.6563 的回合完全缺失、账面 −0.3136 vs
  实际 +0.2586）解释了为什么要有这几列。

**注释里写数字、写症状、写后果。** "这里要小心"是没用的注释；"读 `balance` 会得到 `undefined`，
它和 0 比较为真并静默回落到默认值——一个会把自己藏起来的 bug"是有用的注释。

### 5.2 用户可见文本用中文，机器契约用英文

| 类别 | 语言 | 例子 |
| --- | --- | --- |
| 面向用户/操作员的文本 | **中文** | 日志信息（`已平仓 BTCUSDT 多头 @ ... → 净 +0.1234 USDT`）、错误信息、预检结果（`PreflightCheck.detail`）、控制台 UI 文案、策略预设的 `label`/`summary`、提示词里给模型看的散文 |
| 机器契约 | **英文** | JSON 字段名（`position_size_usd`、`stop_loss`）、`action` 枚举值（`open_long`/`hold`/`wait`）、XML 标签（`<reasoning>`、`<decision>`）、数据库列名、状态码（`FINISHED`/`CANCELED`）、日志的 `scope` |
| 平仓原因 | **英文稳定码** | `CLOSE_REASONS` 里的值。**它们是持久化进数据库的机器码，翻译它们等于改写历史**；中文标签单独放在 `CLOSE_REASON_LABELS` |
| 技术指标名 | **英文缩写** | EMA / MACD / RSI / ATR —— 中文交易者和模型都不翻译它们 |
| 源码注释与文档 | 现状是**两者都有**：中文注释多在核心业务文件，英文注释多在新近改动的文件。**保持邻近文件的语言**，不要为了统一而批量重写注释（会产生巨大的、无法审查的 diff） |

一条具体的取舍记录在 `prompt.ts` 里，值得遵循：面向模型的行情数据里，
指标键名保持 **snake_case 英文**（`current_ema20`、`current_macd_hist`），
因为*"they mirror the field names the model must emit (`stop_loss`, `position_size_usd`, ...),
so keeping the data vocabulary consistent anchors the output contract."*

### 5.3 字段名带单位

**只要可能在单位上产生歧义，就把单位写进名字。**

- `winRatePercent` 而不是 `winRate` —— **这是 0–100 的百分比，不是 0–1 的小数**。
  历史事故：无单位的 `winRate` 让服务端返回百分比、三个控制台页面当成小数又乘了 100，
  一笔一胜的交易渲染成 **10000.0%**。
- `pnlPercent` / `peakPnlPercent` / `unrealizedPnlPercent` / `totalReturnPercent` /
  `maxDrawdownPercent` / `aiLatencyMs` / `holdMinutes` / `quoteVolume24h` / `fundingRate`（小数比例，
  渲染时乘 100 加 `%`）/ `leverage`（整数倍）。
- 反过来：**`wins` / `losses` 要作为真实计数单独返回**，不要留给客户端从百分比反推——
  那是有损的，曾经把"1 笔已平仓"变成"100 盈"。

### 5.4 其它一致性要求

- **`StrategyConfigSchema` 里每个新字段都必须有 `.default()`。** 策略从数据库读出时会重新过一遍
  zod schema（`strategies.get()`），所以带默认值的新字段能让老策略继续工作；
  没有默认值的必填字段会让**所有已存在的策略**读取失败并整体回退到默认配置——静默地把用户的策略换掉。
- **金额相关的算术只在一个地方算。** 需要新的派生金额时，放进 `trades.insert()` /
  `applyExchangeFigures()` 那一层，而不是让每个调用点自己算。
- **仓储负责行字段转换。** SQL 写在 `store/repositories.ts` 里，路由和业务代码不要直接碰数据库。
  `data/` 之外没有别的地方直接 `import { getDb }`。
- **`adjustments` / `rejection.reason` 里的文字要含具体数字**：
  `杠杆已从 20x 压到上限 5x。` 比 `杠杆超限` 有用得多。
- **导出的纯函数优先于需要打桩的对象。** 需要被测试的逻辑尽量做成纯函数
  （`shouldCloseForDrawdown()`、`buildBody()`、`parseResponse()`、`roundTripKey()`），
  这样测试不用起网络也不用起数据库。
- **类型别写 `any`。** 用 `unknown` + 显式收窄。看 `binance/types.ts` 的 `asObject()`、
  仓储的行接口、参数化的 `get<T>()` 是怎么做的。
- **结构化声明接口，而不是导入具体实现**：`DecisionModel`（`AutoTrader` 只要一个 `complete()`）、
  `ReplayMarketDataIsCompatible`（编译期断言回放服务满足实时服务的形状）。这让交易循环可用桩测试
  且不耦合提供商。

---

## 6. 如何判断一个改动是否安全

### 6.1 升级阶梯（每一步只在上一步证明不了时才往上走）

| 台阶 | 命令 | 能抓到什么 | 抓不到什么 | 花钱吗 |
| --- | --- | --- | --- | --- |
| ① 单元测试 | `npx tsx --test <file>` / `npm test` | 纯逻辑：解析、风控每条限制与钳制方向、指标数学、金额算术、字段映射 | 任何需要真实网络 / 交易所行为 / 时间推进才能暴露的问题 | 否 |
| ② 脚本化模拟 | `npm run sim` | **接缝**：保护单是否真的挂上、触发后是否真的记账、权益曲线是否在推进、冷却/节流是否生效、风控是否真的在路径上 | 真实模型的指令跟随能力、真实交易所的接口契约 | 否 |
| ③ 真实模型 + 模拟交易所 | `npm run sim:live`（需 `SIM_LLM_KEY`） | 真实模型能否按格式输出、提示词是否有效、真实提案能否通过风控 | 真实交易所的**交易接口接线** | **花 LLM 的钱** |
| ④ 演示数据 | `npm run demo` | 完整审计链路在真实库与控制台里的呈现 | 交易正确性（它的模拟 broker 不会触发保护单） | 否 |
| ⑤ 实盘冒烟 | `npx tsx packages/server/src/scripts/liveSmokeTest.ts --confirm` | **接线**：预检、单向模式、杠杆、市价开仓、挂止损、挂止盈、**回读交易所确认**、撤单、平仓、账户干净 | 长时间行为、策略盈利能力、并发场景 | ⚠️ **真实资金** |
| ⑥ 真实交易 | 控制台启动机器人（选"实盘"） | 一切 | —— | ⚠️ **真实资金** |

### 6.2 明确的警告

> ⚠️ **③⑤⑥ 涉及真实成本。**
> - **③ `npm run sim:live`** 用真实 LLM，按 token 计费。它跑在**模拟**交易所上，不动真钱，
>   但也不是免费的。
> - **⑤ 实盘冒烟测试会真的下单，动用真实资金。** 它必须有 `--confirm` 才会执行，名义价值硬上限
>   20 USDT，清理步骤写在 `finally` 里，结束时回读交易所确认账户干净。
> - **⑥ 真实交易**用真实资金、真实风险。
>
> **作为 AI 代理：不要自行运行 ⑤ 和 ⑥。** 需要跑的话，明确向人说明为什么必须跑、跑之前会做什么、
> 跑完如何确认账户干净，等确认。也不要在 ⑥ 上做"试试看这个改动效果如何"的实验——
> 策略实验应该在 ②③ 上做。

### 6.3 判断一个改动安全的具体问题清单

改完之后，逐个问自己：

1. **这个改动能不能让一张绕过风控的订单出去？** 如果能 → 停，重做。
2. **这个改动会不会让某条平仓路径少记一笔账？** 如果会 → 至少加测试，并说明对账能否补上。
3. **这个改动碰了金额/费用/仓位的算术吗？** 如果碰了 → 必须有单元测试，并且断言的是**交易所口径**的值。
4. **这个改动碰了币安或 LLM 的接口契约吗？**（字段名、端点、参数名、错误码）→ 必须对着真实环境验证，
   或者明确标注"未验证"。
5. **这个改动碰了 `StrategyConfigSchema` 吗？** → 每个新字段都有 `.default()` 吗？
   老策略读出来会怎样？
6. **这个改动碰了提示词吗？** → token 预算估算（`estimateCandidateChars()`）跟着更新了吗？
7. **这个改动加了一个新的 `CloseReason` / `DecisionAction` / `ExchangeId` / `LlmProviderId` 吗？** →
   这些是**类型级约束**，`tsc` 会告诉你漏了哪些穷尽性检查；但运行时的分派点
   （`client.ts` 的 `buildRequest`/`parse`、`manager.ts` 的 `connectionFor` 等）要靠
   `docs/MODULES.md` 的配方清单核对。
8. **这个改动会在日志或数据库里写下密钥、域名、IP、路径吗？** → 不要。
9. **我声称它"能用"，是因为我跑过它，还是因为我读完觉得对？** → 只承认前者。

### 6.4 卡住的时候

- 先跑 `npm run verify`（真实行情、不需要密钥、不下单）。它能在 30 秒内告诉你
  "选币 → 指标 → 提示词 → 解析 → 风控"这条链路是否还通。
- 再跑 `npm run sim`。它会在 15 项校验里指出是哪一类接缝断了（保护单、记账、冷却、权益曲线…）。
  ⚠️ **注意**：在撰写文档的环境上它稳定报告 **13/15**，失败的固定是"每笔开仓都挂上止损与止盈"
  与"止损会被真实触发并正确记账"两项（原因见 `docs/DEVELOPMENT.md` 的"`npm run sim` 的当前实测状态"）。
  先确认你看到的失败不是那两项，再去查自己的改动。
- 还是不通，去读那个文件顶部的注释。这个仓库的注释密度很高，通常已经写清了"为什么不能那样做"。
- 仍然不确定 → **说出来**。不要用一个看起来合理的猜测填补空白，尤其是在文档里。
