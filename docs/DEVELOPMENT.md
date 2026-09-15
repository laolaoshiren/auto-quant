# 开发手册：从克隆到提交

本文面向**第一次接触这个仓库的开发者**（人和 AI 都适用）。它回答的是最基本的几个问题：
怎么把它跑起来、代码为什么长成这样、改完怎么验证、哪些坑已经有人踩过。

先读这两份，它们比本文更宏观：

| 文档 | 什么时候读 |
| --- | --- |
| [`README.md`](../README.md) | 想知道这个产品是干什么的、怎么用控制台 |
| [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) | 想知道**为什么**这样设计（本文不重复它的论证） |
| [`docs/API.md`](API.md) | 要改 HTTP 接口时 |
| [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) | 要部署到服务器时 |
| [`docs/MODULES.md`](MODULES.md) | 知道要改什么了，想知道**改哪个文件** |
| [`docs/AGENTS.md`](AGENTS.md) | 你是 AI 代理，需要一份不可违反的规则清单 |

> 本文描述的是**当前代码的事实**。凡是本文与代码不一致的，以代码为准，并请顺手修正本文。

---

## 1. 前置条件

| 要求 | 具体值 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 22.5.0** | 根 `package.json` 的 `engines` 字段写死了 `>=22.5.0` |
| npm | 随 Node 一起装即可 | 项目用 **npm workspaces**，没有 pnpm/yarn 配置 |
| 磁盘/网络 | 能访问币安公开行情接口 | 跑 `verify` / `sim` / `demo` 需要真实 K 线 |

仓库里**没有** `.nvmrc`，版本约束只有 `package.json` 的 `engines`。用一个 22.x 的 Node 就不会有问题
（开发机上验证过的是 `v22.23.1` / npm `10.9.8`）。

### 为什么偏偏是 Node 22.5，以及"不需要编译原生模块"意味着什么

持久化用的是 **Node 内置的 `node:sqlite`**（`DatabaseSync`，见 `packages/server/src/db/index.ts`），
它在 Node 22.5 才作为内置模块出现。这不是随手选的：

- **`npm install` 里没有任何原生编译步骤。** 一旦用 `better-sqlite3` 这类库，安装就意味着
  node-gyp / Python / C++ 工具链、预编译二进制与当前 Node ABI 是否匹配、CI 镜像里有没有编译器。
  这些失败和业务代码无关，但会让人在第一步就卡住，而且报错信息通常完全指不到原因。
- **换一台机器、换一个 Node 小版本都不会突然装不上。** 克隆下来 `npm install` 就是拉几个纯 JS 包，
  几秒钟结束。这是可以在全新机器上放心复现的前提。

**因此有一条硬规则：不要为了某个功能引入需要编译的原生依赖。** 确实必要的话（见
[`docs/AGENTS.md`](AGENTS.md) 的"不能做的事"），必须在 PR 里说明理由和它对部署环境的影响。

依赖面本身也很小：服务端只有 `fastify`、`@fastify/{cors,static,websocket}`、`ws`、`zod`；
控制台只有 `react`、`react-dom`、`react-router-dom`、`zustand`、`recharts`、`lightweight-charts`、`clsx`、Tailwind。
JWT 是手写的 HS256（`packages/server/src/api/auth.ts`），`.env` 是手写的解析器（`packages/server/src/env.ts`），
指标是零依赖自实现的（`packages/server/src/market/indicators.ts`）。

---

## 2. 第一次跑起来

```bash
git clone <仓库地址> auto-quant
cd auto-quant

npm install                      # 无原生编译，几秒到十几秒

cp .env.example .env             # Windows: Copy-Item .env.example .env
```

### `.env` 里哪些是必须动的

`.env.example` 的每一项都有注释。默认值就能把服务跑起来，只有两项值得注意：

| 变量 | 默认 | 第一次要不要改 |
| --- | --- | --- |
| `PORT` | `3200` | 一般不动。选 3200 而不是常见的 3080，是因为 3080 经常被别的本地工具占用，而端口冲突只会在 `listen()` 时暴露 |
| `HOST` | `127.0.0.1` | 本地开发不动。要让同网段访问才改成 `0.0.0.0` |
| `BINANCE_USE_TESTNET` | `true` | **保持 `true`**。`true` 走币安 Demo 模拟盘，`false` 直接是实盘 |
| `MASTER_KEY` / `JWT_SECRET` | 空 | 保持空也行：首次启动会生成并落盘到 `data/.master.key`、`data/.jwt.secret`。多实例或容器部署时才需要显式给定 |
| `ADMIN_PASSWORD` | 空 | 保持空即"每次首启生成随机密码并打印一次"。想自己定就填 |
| `GLOBAL_TRADING_DISABLED` | `false` | 想在本地做纯前端调试时设 `true`，任何机器人都起不来 |
| `DRY_RUN` | `false` | `true` = 行情与账户读真实数据、但不下单。**注意 `.env` 的 `DRY_RUN` 是服务端全局默认，控制台启动机器人时的"模拟/实盘"单选是按机器人覆盖它的** |

`HTTPS_PROXY` 是可选项：如果本机到币安或 LLM 需要走代理，填上它（Node 的 `fetch` 会尊重
`HTTPS_PROXY`；环境里出现过 `UNDICI-EHPA` 的 experimental 警告，那是 Node 在用
`EnvHttpProxyAgent`，属正常现象，不是错误）。

### 启动

两个终端，或者一个终端跑前后端其中一端：

```bash
npm run dev          # 后端：tsx watch 监听 packages/server/src/index.ts
npm run dev:web      # 前端：vite dev server，带 /api 与 WebSocket 代理
```

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| 后端 API + 生产控制台 | `http://127.0.0.1:3200` | Fastify。若 `packages/web/dist` 存在，它会**顺带把控制台静态文件也托管了**，SPA 路由回落到 `index.html` |
| 前端开发服务器 | `http://127.0.0.1:5173` | `vite.config.ts` 里把 `/api`（含 WebSocket）代理到 `127.0.0.1:3200` |

> `vite.config.ts` 里显式绑 `host: '127.0.0.1'` 且 `strictPort: true`。这不是洁癖：Windows 上
> `localhost` 可能只解析到 `::1`，导致 Vite 明明起来了但 `curl http://127.0.0.1:5173` 失败。
> 所以请用 `127.0.0.1` 而不是 `localhost`。

### 首次启动会发生什么（一定要看控制台）

`packages/server/src/index.ts` 的启动顺序是固定的一串动作，其中有几步只在第一次发生：

1. `ensureDataDir()` —— 建 `data/` 目录。
2. `initDb(dbPath)` —— 建 / 打开 SQLite，并**自动跑迁移**（`PRAGMA user_version` 跟踪，可重复执行）。
3. `resolveMasterKey()` —— 没有 `MASTER_KEY` 就生成 `data/.master.key`（权限 `0600`）；
   `resolveJwtSecret()` —— 同理生成 `data/.jwt.secret`。
4. `bootstrapOwnerAccount()` —— **首次启动创建 owner 账号 `admin`，并把随机密码用 `log.warn` 打印一次**：

   ```
   ========================================================================
   首次启动 —— 已创建 owner 账户
     用户名：admin
     密码：<这里就是密码>
     登录后请立即修改密码。此密码只显示这一次。
   ========================================================================
   ```

   **这个密码只存在这一次明文。** 代码里的注释就是这么写的，别把它当成可以再查的东西——
   没记下来只能改数据库或删掉 `data/` 重来（`ADMIN_PASSWORD` 只在**创建时**生效）。
5. `seedDefaults()` —— 库里一个策略都没有时，创建一个 `默认策略 — 稳健`（`conservative` 预设），
   这样控制台不会是"一个空白页面、没有任何可点的东西"。
6. `connectExchange({ environment, dryRun: true })` —— 用**无凭据**的连接做公开行情连接，
   顺带做时钟同步、拉 `exchangeInfo`（权重预算与全部合约过滤器）。
7. `buildServer()` + `listen()`，日志打印控制台地址与当前交易环境。
8. `setTimeout(2000ms)` → `manager.resumePersisted()`：恢复重启前处于 `running` / `safe_mode` 的机器人。
9. `setTimeout(+4000ms)` → `manager.reconcileAllTraders()`：**对全部机器人（包括已停止的）做一次对账**。
   它刻意延后且**永不致命**——对账是纠错，失败不应该妨碍服务本身对外服务。

### 数据落在哪里

| 路径 | 内容 | 能不能提交 |
| --- | --- | --- |
| `data/autoquant.sqlite` | 主数据库（含**加密后的**交易所凭据） | ❌ 已在 `.gitignore` |
| `data/.master.key` | 32 字节 AES-256-GCM 主密钥（0600） | ❌ |
| `data/.jwt.secret` | JWT 签名密钥 | ❌ |
| `packages/web/dist/` | 控制台构建产物 | ❌ |

> `.gitignore` 里有句注释值得记住：**主密钥和数据库放在一起就等于明文凭据**——
> 拿到这两样就能解密出交易所 API Secret。所以 `data/` 是整体排除的，不要用 `git add -f`。

想彻底重来：停掉服务，删掉整个 `data/`，再 `npm run dev`。
想清掉演示数据但保留真实数据：`npx tsx packages/server/src/scripts/demoCycle.ts --clean`。

### 跑起来之后应该看到什么

1. 终端里出现 `数据库就绪：...`、`connected to ... (clock offset Nms)`、`loaded N tradable USDT-M perpetual contracts; weight budget N/min`、`控制台地址：http://127.0.0.1:3200`、`交易环境：币安合约 Demo 模拟盘`。
2. 浏览器打开 `http://127.0.0.1:3200` → 登录页 → 用 `admin` + 打印出来的密码登录。
3. 总览页顶部的环境横幅显示当前环境、是否 `DRY_RUN`、是否全局禁用、权重用量、可交易合约数。
4. 策略工作室里已经有一个 `默认策略 — 稳健`。

---

## 3. 命令表

根 `package.json` 的脚本就是下面这 10 条，没有更多。它们全是对各 workspace 脚本的转发：

| 命令 | 实际执行 | 什么时候用 |
| --- | --- | --- |
| `npm run dev` | `npm run dev --workspace @aq/server` → `tsx watch src/index.ts` | 日常开发后端。改文件自动重启 |
| `npm run dev:web` | `npm run dev --workspace @aq/web` → `vite` | 日常开发前端（`http://127.0.0.1:5173`，热更新 + `/api` 代理） |
| `npm start` | `npm run start --workspace @aq/server` → `tsx src/index.ts` | 生产启动（无 watch）。需先 `npm run build`，否则它只提供 API，没有控制台静态文件 |
| `npm run build` | `npm run build --workspace @aq/web` → `vite build` → `packages/web/dist` | 出控制台产物。**它不编译服务端**（服务端由 `tsx` 直接跑 TS） |
| `npm run typecheck` | `npm run typecheck --workspaces --if-present` → server + web 各自 `tsc --noEmit` | 提交前必跑。`@aq/shared` 没有自己的 typecheck 脚本，它作为被依赖的源码被两边一起检查 |
| `npm test` | `npm run test --workspace @aq/server` → `tsx --test "src/**/*.test.ts"` | 提交前必跑。**只有服务端有测试**；`@aq/web` 目前没有测试脚本 |
| `npm run verify` | `tsx packages/server/src/scripts/verifyPipeline.ts` | 用**真实币安行情**跑「选币 → 指标 → 提示词 → 解析 → 风控」全链路。**不需要任何密钥、不下单** |
| `npm run demo` | `tsx packages/server/src/scripts/demoCycle.ts` | 往**真实数据库**写入一轮带 `[DEMO]` 前缀的完整决策审计数据，让控制台的审计界面立刻有东西可看。加 `--clean` 清除 |
| `npm run sim` | `tsx packages/server/src/scripts/simulate.ts` | **完整交易生命周期模拟**：真实历史 K 线回放 + 会真正触发止损止盈的模拟交易所 + 脚本化模型，80 轮，15 项校验（**当前实测 15/15 全通过**）。写临时数据库 |
| `npm run sim:live` | `tsx packages/server/src/scripts/simulate.ts --live --loose --cycles 12` | 同上，但模型换成**真实 LLM**（需要 `SIM_LLM_KEY`），策略放宽（`--loose`）以便真的有可能下单 |

各脚本自己的参数（本文不重复，脚本头部注释写得很细）：

```bash
npx tsx packages/server/src/scripts/simulate.ts --cycles 120   # 更长回放
npx tsx packages/server/src/scripts/simulate.ts --json         # 机器可读报告
npx tsx packages/server/src/scripts/demoCycle.ts --clean       # 清演示数据
npx tsx packages/server/src/scripts/liveSmokeTest.ts --confirm --symbol DOGEUSDT --notional 6
```

`packages/server/package.json` 里的 `verify` 脚本与根级同名脚本等价，一般用根级的就够了。
`packages/web/package.json` 另有 `preview`（本地预览构建产物）和 `typecheck` 两个脚本——
根级的 `npm run typecheck` 会通过 `--workspaces --if-present` 把它们一起跑上，
但根级的 `npm test` **只跑 `@aq/server`**，控制台目前没有自动化测试。

### `sim:live` 用到的环境变量

`simulate.ts` 从环境变量读真实模型配置，**仓库里没有任何密钥**：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SIM_LLM_KEY` | 空 | **必需**，没有它 `--live` 会直接抛错退出 |
| `SIM_LLM_BASE` | 一个 OpenAI 兼容端点 | 改这里指向你自己的网关 |
| `SIM_LLM_MODEL` | 一个模型 id | 自由文本 |

`liveSmokeTest.ts` 则优先读 `BINANCE_API_KEY` / `BINANCE_API_SECRET`；两者都为空时回落到
数据库里的凭据（默认取第一个账户，可用 `--account <id>` 指定）。

### `npm run sim` 的实测状态（15/15 通过）

**`npm run sim` 退出码为 0，报告 `全部 15 项校验通过`。**

这里记录一段真实的历史，因为它是一个很好的教训：**这份文档刚写出来时，`npm run sim`
稳定报告 13/15**，失败的固定是「每笔开仓都挂上止损与止盈」与「止损会被真实触发并正确记账」。
日志显示 40 张止盈单被拒：

```
ERROR [trader] 为 BTCUSDT 挂 止盈（触发价 79033.592）失败：
  模拟交易所拒绝：触发价 79033.592 不符合 BTCUSDT 的价格精度 tickSize=0.1
  （-1111 Precision is over the maximum defined for this asset）
```

根因不是脚本化模型算错了价，而是**`SimulatedExchange` 搞错了自己扮演的角色**：

- 它在流水线里被注入为 `AutoTrader` 的 **broker**，而按 `tickSize` 取整正是 **broker 的职责**——
  真实的 `BinanceBroker.placeOrder` 就是先取整再发送。Binance 永远不会从一个正确的客户端
  收到未对齐的触发价。
- 但那个版本的模拟器选择了**拒绝**而不是取整，于是**模拟器比现实更严格**，
  在真实系统完全能正常处理的场景上失败。
- 修法：改用 `registry.roundTriggerPrice()` + `isValidTrigger()`，与 broker 契约一致。

**两条值得记住的结论：**

1. **校验要加在正确的层。** 防「broker 忘记取整」的断言属于 `binance/orders.test.ts`
   （它断言真实 broker 发送前会取整）。放在模拟器里等于在测试另一条代码路径——
   模拟运行根本不会调用真实 broker。
2. **没进 CI 的验证等于不存在。** 当时 `npm test` 全绿，因为单元测试走不到这条路径。
   现在 `npm run sim` 已加入 CI（`.github/workflows/ci.yml`）。
   ⚠️ 但在 GitHub 托管的 runner 上它会被**跳过**——币安返回
   `Service unavailable from a restricted location`（runner 位于限制区域）。
   CI 会先探测可达性并打出 warning，**不静默通过**。本地务必自己跑。

---

## 4. 测试策略

### 怎么跑、在哪

- 运行器是 **Node 内置的 `node:test`**，通过 `tsx` 执行 TypeScript，不引入 vitest/jest：
  `npm test` → `tsx --test "src/**/*.test.ts"`（在 `packages/server` 下执行）。
- 测试文件**与源码同目录、同前缀**（`engine.ts` ↔ `engine.test.ts`），没有独立的 `test/` 目录。
- 单跑一个文件：`npx tsx --test packages/server/src/risk/engine.test.ts`。
  注意从**仓库根目录**跑时要写完整路径；`docs/ARCHITECTURE.md` 第 10 节里给的形式是
  在 `packages/server` 目录下用相对路径。

### 当前规模（实测）

全量 `npm test`：**194 个用例，全部通过，约 0.36 秒**。

| 测试文件 | 用例数 | 覆盖什么 |
| --- | --- | --- |
| `binance/orders.test.ts` | 31 | broker 的路由与参数名（条件单是否走 Algo 端点）、tick/step 取整、触发价方向 |
| `llm/llm.test.ts` | 45 | 各厂商方言与怪癖（Anthropic 内容块、Gemini schema、MiniMax 在 200 里报错、Kimi 拒绝 temperature…） |
| `strategy/parser.test.ts` | 29 | 响应解析：思维链提取、括号配平、编码修复、字段别名、校验拒绝 |
| `risk/engine.test.ts` | 27 | 风控每一条限制与钳制方向、回撤守卫、熔断器 |
| `market/indicators.test.ts` | 16 | 指标数学（Wilder RSI/ATR 参考值、EMA 种子、MACD 对齐） |
| `binance/account.test.ts` | 10 | 账户字段映射（尤其是 `walletBalance` 这种拼写陷阱） |
| `trader/roundTrips.test.ts` | 10 | 从成交历史重建回合、手续费双侧累计、匹配键 |
| `trader/autoTrader.test.ts` | 7 | 交易循环集成（真实 SQLite 临时库 + 假的 broker/model） |
| `store/stats.test.ts` | 7 | 统计口径（净盈亏分类、胜率、利润因子） |
| `binance/income.test.ts` | 6 | 收入流水分页与汇总、资金费归属窗口 |
| `strategy/prompt.test.ts` | 6 | 提示词组装与 token 预算估算 |

### 新贡献者必须遵守的约定

这些是从现有测试里读出来的**实际习惯**，不是理想化的规范：

**1. 测"哪条路径"而不是"哪个函数"。** 用例名就是一句话的行为断言，例如
`adding to a position averages the entry instead of starting a new trade`、
`commission in another asset is reported, not silently added`。
被测模块的内部实现改了、行为没改，测试不应该失败。

**2. 单位写进名字和字段名。** 涉及百分比的字段一律带单位（`winRatePercent`、`pnlPercent`、
`peakPnlPercent`、`confidence` 是 0–100 的整数）。历史事故：字段叫 `winRate` 时服务端返回百分比、
三个控制台页面当成小数又乘了 100，**一笔一胜的交易渲染成 10000.0%**。

**3. 用注释说明"为什么这个测试存在"，通常直指它防的那个 bug。** 这是本仓库最一致的约定，
几乎每个非平凡用例上方都有一段。真实例子：

- `orders.test.ts`：*"Sending a conditional order to the wrong endpoint is rejected by Binance with
  `-4120`, and the practical consequence is an open position with no stop loss — so the routing
  decision is worth pinning down."*
- `risk/engine.test.ts` 的 fixture 注释解释为什么盈亏比必须设为 1:3：*"the default strategy enforces
  a 1:3 floor, so a fixture that did not clear it would be rejected before the behaviour under test
  was ever reached."*
- `engine.ts` 里 `clampStopLoss` / `clampTakeProfit` 的注释记录了*把两个函数合并会静默让每笔止盈失效*，
  这个 bug 就是被单元测试抓到的。

写新测试时请照做：如果这个用例是为了防止某个具体的、已经发生过的或可预见的错误，
**把那个错误写出来**。一个说明"为什么"的注释，比十条描述"做了什么"的注释都有用。

**4. fixture 要显式、完整、类型化，不要走 schema 之外的捷径。**
`indicators.test.ts` 的 `indicatorConfig()` 手写整个 `IndicatorConfig`（而不是 `StrategyConfigSchema.parse({})`），
注释解释了原因：*"so these unit tests stay hermetic: the indicators module only needs the fields below,
and typing the literal against `IndicatorConfig` makes the compiler prove that the shape is still
correct."* ——手写常量 + 类型标注 = 加字段时编译器会报错，不会静默漏掉。

其他 fixture 习惯：

- 需要快照对象时写一个小工厂：`snapshot(symbol, price)`（`risk/engine.test.ts`）。
- 需要价格 / 配置变体时写 `configWith(patch)`、`openDecision(overrides)`。
- **要打桩就在边界打桩，不要在内部打桩**：`orders.test.ts` 里的 `fakeRest()` 记录每一次调用
  （`{ method, path, params }`）而不是返回假数据——测试断言的是"走了哪个端点、参数叫什么名字"。
  同理 `autoTrader.test.ts` 用假的 `BinanceBroker` / `DecisionModel`，但**用真的 SQLite 和真的仓储**。

**5. 需要数据库的测试用临时目录，别碰 `data/`。** `autoTrader.test.ts` 的模式是标准做法：

```ts
before(() => { workDir = mkdtempSync(path.join(tmpdir(), 'aq-integration-')); initDb(path.join(workDir, 'test.sqlite')); });
after(()  => { closeDb(); rmSync(workDir, { recursive: true, force: true }); });
beforeEach(() => { /* DELETE FROM ... 清空所有表，然后重建这个用例需要的实体 */ });
```

`simulate.ts` 与 `demoCycle.ts` 的区别也在这里：前者写临时库并自动删除，后者**故意**写真实库
（因为它存在的意义就是让控制台有数据可看），但给所有东西加了 `[DEMO]` 前缀。

**6. 不要把测试串起来。** 每个用例自带前置条件，不依赖同文件里另一个用例先跑过。

**7. 参考值是实测出来的，不是编出来的。** 指标测试里固化的是 Wilder 原始定义下的参考值；
对账、手续费、账户字段的测试断言的是**真实交易所响应**观察到的数字。
写测试时不要为了让它过而把断言改成你算出来的那个值——先去确认哪个是对的。

### 什么时候该写测试

值得写：解析与校验（模型输出是不可信输入）、风控的每一条限制与钳制方向、金额相关的算术
（盈亏、手续费、资金费、仓位取整）、对外部行为的事实断言（端点、参数名、字段名）、
任何你**修了一个 bug** 的地方（先写一个能复现的用例，再改代码）。

不值得写：纯转发、纯渲染、常量表本身。

---

## 5. 改代码时的思维模型

### 一条规则压倒其它所有规则：**模型只负责提议，运行时负责裁决**

模型输出被当作**和任何外部输入一样不可信**。它能做的只有"提出建议"；
真正决定一张订单能不能出去的是 `packages/server/src/risk/engine.ts`。

```
模型响应 ──► parser（结构宽容、语义严格）──► RiskEngine.review() ──► 执行
                    │                              │
              不合法的直接拒绝              不合法的拒绝 / 超限的钳制
              （带理由上报）               （每一次干预都写进 adjustments）
```

**没有任何绕过风控的路径。** 这不是约定，是代码结构：`AutoTrader` 只执行
`verdict.approved` 里的决策（`packages/server/src/trader/autoTrader.ts`），
风控拒绝的项只进入审计日志。所以：

- 改 `executeOpen` / `executeClose` 时，不要在里面加"因为模型说了 X 所以就下"的分支。
- 加新限制的唯一正确位置是 `RiskEngine.reviewOpen`（开仓）或 `reviewClose`（平仓）。
- **每一次钳制 / 拒绝都要写进 `Decision.adjustments` 或 rejection 的 `reason`。**
  ARCHITECTURE 里那句说得很直接：*"每一次运行时对模型的推翻都必须留下痕迹，这是这个产品可被信任的前提。"* ——
  账户所有者要能在控制台看到"运行时在哪里推翻了模型"。

### `runOnce()` 的周期顺序，以及为什么是这个顺序

`AutoTrader.runCycle()` 的实际执行顺序（这一段是本文档里最值得记住的部分）：

| # | 做什么 | 方法 | 为什么在这个位置 |
| --- | --- | --- | --- |
| 1 | 读交易所权威账户状态 | `broker.getAccountState()` | 后面所有判断都要用真实权益 |
| 2 | **对账**：本地台账 vs 交易所成交历史 | `reconcileTradeHistory()` → `reconcilePositions()` | 必须在最前面。进程不在时发生的平仓只能在这里找回来；账本不对，后面的统计全是错的。失败**不影响本周期交易**（只 `log.warn`） |
| 3 | **机械保护**：回撤守卫 | `applyDrawdownGuard()` | **跑在问模型之前，且不问模型**。保护已有利润恰恰是模型最不可靠的判断 |
| 4 | 熔断器检查 | `checkCircuitBreakers()` | 决定本周期还能不能开新仓（只阻止开仓，不平仓） |
| 5 | 重新读持仓（守卫可能刚平了仓） | `getPositions()` / `positionStore.open()` | 顺序：先平后读，否则会拿过期状态去算候选集 |
| 6 | 选币 + 组装行情快照 | `selectCandidates()` → `marketData.buildSnapshots()` | 持仓标的**无条件**进候选集 |
| 7 | 组装提示词 → 调模型 | `buildSystemPrompt/UserPrompt` → `model.complete()` | |
| 8 | 解析响应 | `parseDecisionResponse()` | 结构性不合法的在这里就被拒了，不会变成畸形订单 |
| 9 | **硬风控审查** | `risk.review(sortDecisions(...))` | 风控内部也把平仓排在开仓前面 |
| 10 | 执行：**先平仓，后开仓** | `executeClose` / `executeOpen` | 见下 |
| 11 | 落库审计记录 | `decisionStore.log()` | 即使整轮失败也要留下记录 |
| 12 | 再读一次账户/持仓并记权益快照 | `recordEquity()` | 权益曲线是回撤与熔断的输入 |

**为什么"减少风险的工作"必须先于"增加风险的工作"**：

- **资金占用**：平仓释放保证金，开仓消耗保证金。先开后平，可能因为保证金不够而白白拒绝一个本可执行的开仓。
- **持仓槽位**：`maxPositions` 是并发上限。先平掉一个再开一个，是"换仓"；先开再平，会被上限直接拒。
- **失败方向**：如果本轮在中途出错，先平后开意味着剩下的状态是"敞口更小"；
  反过来就是"该平的没平、还多开了一个"。
- **同批次内的开仓互相可见**：`RiskEngine.review()` 维护一个滚动的
  `positionCount` / `marginUsed` / `entriesThisCycle`，先通过的开仓会消耗掉后面开仓的预算。
  否则一批里的多个开仓可以**合起来**突破账户上限。
- **平仓几乎不加限制**（只受"最小持仓时间"约束）。减少敞口永远是安全方向，
  而"拒绝平仓"是把小亏变成爆仓的经典方式。

执行层的顺序体现在两处，改的时候两处都要留意：
`sortDecisions()`（`strategy/parser.ts`，`ACTION_PRIORITY`：close=1 < open=2 < hold/wait=3）
和 `RiskEngine.review()` 里把决策重排成 closes → opens → 其它。

### 与这条规则配套的另外三条设计

- **开仓后先挂止损并验证；挂不上就立刻市价平仓**（若 `requireStopLoss`）。
  一个没有保护的杠杆仓位是最糟糕的状态，宁可立刻退出。见 `executeOpen` 的
  `placeProtection` + `emergencyFlatten`。
- **平仓前先撤掉该标的的所有挂单**（普通单 + Algo 单）。
  `closePosition=true` 的条件单在手动平仓后**依然存活**，会朝反方向开出一个新仓。
- **周期不重叠**：`cycleInFlight` 守卫。跑超时的周期不会被下一个 tick 覆盖执行——
  那会导致仓位重复计数与订单重复提交。

---

## 6. 调试

### 看模型到底说了什么

三样东西是**完整持久化**的，缺一个都不算"有纸质记录"：

| 存在哪 | 字段 | 内容 |
| --- | --- | --- |
| `decision_records` 表 | `system_prompt` / `user_prompt` | 本轮**实际发给模型**的两段提示词，一字不差 |
| 同表 | `cot_trace` | 从 `<reasoning>` 提取的思维链 |
| 同表 | `raw_response` | 模型的**原始响应文本**（未经任何清洗） |
| 同表 | `decisions_json` / `execution_log_json` | 解析后的决策 + 逐条执行结果（含风控的拒绝理由与 `adjustments`） |
| `orders` 表 | `raw_response` | 每张订单的交易所原始响应，**包括被拒绝的订单** |

控制台入口：`机器人看板 → 决策`（列表）→ 点任意一行进入 `决策审计详情`。
「最近决策」的展示规则是：决策卡片常显（"它决定了什么"是操作员持续在盯的信息），
思维链与完整提示词默认收起、每个周期独立展开。这个取舍的论证在 `README.md` 里。

**被风控拒绝的提案会标红显示理由**——这就是"为什么它什么都没做"的答案。
一张标注了 `adjustments` 的订单记录，则是"模型想做什么、运行时改成了什么"的答案。

### 不花钱地复现一个决策

按代价从低到高：

| 手段 | 能看到什么 | 花钱吗 |
| --- | --- | --- |
| `npm run verify` | 真实行情 + 真实指标 + 真实提示词 + 真实解析 + 真实风控，喂一份**内置的**模型响应 | 不花钱、不需要任何密钥 |
| `npm run sim` | 上面这些 **+ 真实执行 + 会触发止损止盈的模拟交易所 + 脚本化模型的 80 轮决策**，写临时库 | 不花钱 |
| 控制台 **策略体检**（`POST /api/strategies/:id/check`） | 用**真实模型**跑完一整条链路，报告每个阶段的成败。用的是模拟账户（默认权益 1000），**全程不向交易所发请求、不需要交易所密钥** | 花 LLM 的钱，不下单 |
| `npm run demo` | 往真实库写一轮带 `[DEMO]` 前缀的完整审计数据（真实行情 + 脚本化模型 + 模拟交易所），让审计界面立刻有内容 | 不花钱、**不下任何单** |
| `npm run sim:live` | 真实模型在模拟交易所上跑 12 轮 | 花 LLM 的钱，**不动真钱** |

**策略体检最重要的价值是区分两种从外部看完全一样的失败**（"机器人什么都不做"）：

- 模型没答 / 答得无法解析 → 是提示词或模型选择的问题；
- 模型答得挺好但提案全被风控拒了 → 是风控限制与策略提示词不匹配。

它逐阶段报告（`交易所连接 → 选币 → 行情快照 → 提示词 → 调模型 → 解析 → 风控`），
并且在**调用模型之前**就检查提示词是否超预算——因为超预算是最贵的一种失败：
等 40 秒以上，然后被告知"模型返回空内容"，而真正的原因一眼可见。

### 更直接的调试手段

- **日志**：`LOG_LEVEL=debug` 打开详细日志；`/data` 页是实时日志面板（WebSocket 推送）。
  服务端日志有一个 sink（`setLogSink`）把 `info` 以上的记录写进 `runtime_logs` 并推到事件流，
  `debug` 级别只进 stdout、不进数据库。
- **不看日志也能查的地方**：`orders` 表里有每张订单的 `raw_response` 与 `error`；
  `decision_records` 有完整的提示词与原始响应。控制台没有暴露的东西，都可以用 SQLite 直接读。
- **`GET /api/system`**：一次性看到 `dryRun`、`tradingDisabled`、环境标签、时钟偏移、
  权重用量/上限、可交易合约数、正在运行的机器人 id。
- **对账作为诊断工具**：`POST /api/traders/:id/reconcile` 不下任何单、**不受全局急停开关限制**
  （因为它只改账本），可以随时对任意机器人执行，包括已停止的。
  它的返回是 `{ ok, recovered, corrected, funding }`，`recovered > 0` 就意味着"曾经有一笔平仓没被记账"。
- **`DRY_RUN`**：读真实行情与真实账户，但不真正下单。注意真实 broker 的 dry-run 路径下
  `getUserTrades` 返回**空数组**、`getAlgoOrder` 返回 `null`，所以对账 / 平仓原因推断在此模式下拿不到数据。

### 一个具体的陷阱：`reconcileTradeHistory()` 的归属闸门

对账会从 `/fapi/v1/userTrades` 重建回合。**多个机器人共用一个交易所账户时，成交历史对它们是相同的**。
没有闸门，每个机器人都会把账户的全部盈亏记到自己头上——这在实盘上真的发生过。

所以只有 `trip.entryOrderId` 出现在**本机器人自己的 `orders` 表**里的回合才会被认领，
**没有 fallback**。代码注释解释了取舍：*"Missing a recovery is a smaller error than inventing one,
because a phantom trade corrupts the ledger permanently while a skip corrects itself the moment the
order row exists."*

调试"某笔盈亏没被记上"时，先看这一条——很可能不是 bug，是刻意的保守。

---

## 7. 不能用真钱测试

### 升级阶梯

每一次改动都应该尽量停在**尽可能低**的台阶上。往上一级只在下一级已经证明不了的时候才走：

| 台阶 | 命令 | 能抓到什么 | **抓不到什么** |
| --- | --- | --- | --- |
| ① 单元测试 | `npx tsx --test <file>` / `npm test` | 纯逻辑：解析、风控每条限制与钳制方向、指标数学、金额算术、字段映射 | 任何需要真实网络 / 真实交易所行为 / 时间推进才能暴露的东西 |
| ② 脚本化模拟 | `npm run sim` | **接缝**：开仓后是否真的挂上保护、保护触发后是否真的记账、权益曲线是否在推进、冷却/节流是否真的生效、风控是否真的在路径上（脚本化模型会故意提 100x 杠杆和过低置信度） | 真实模型的指令跟随能力、真实交易所的接口契约 |
| ③ 真实模型 + 模拟交易所 | `npm run sim:live`（需 `SIM_LLM_KEY`） | 真实模型能不能按格式输出、提示词是否有效、真实提案能否通过风控 | 真实交易所的交易接口；`sim:live` 跑在**模拟**交易所上，不动真钱 |
| ④ 演示数据 | `npm run demo` | 完整审计链路（提示词、思维链、执行日志）在真实库里的呈现 | 交易正确性——它的模拟交易所**不会触发**保护单 |
| ⑤ 实盘冒烟 | `npx tsx packages/server/src/scripts/liveSmokeTest.ts --confirm` | **接线**：预检、单向模式、杠杆、市价开仓、挂止损、挂止盈、**回读交易所确认保护单真的挂着**、撤单、平仓、确认账户干净 | 长时间运行的行为、策略的盈利能力、并发场景 |
| ⑥ 真实交易 | 控制台启动机器人（选"实盘"） | 一切 | —— |

> ⚠️ **⑤ 和 ⑥ 会动用真实资金。** ⑤ 的护栏：必须显式带 `--confirm` 才会下单；
> 名义价值硬上限 20 USDT；清理步骤写在 `finally` 里（中途异常也会撤单平仓）；
> 结束时回读交易所确认账户干净；标的默认选 `DOGEUSDT` 这种最小名义价值低、能开出最小仓位的合约。

### 关于"测试网"和"Demo 环境"的边界

模拟证明的是**逻辑**，只有真实交易所上的操作能证明**接线**。反过来，
`npm run sim` 的模拟交易所**不是**一个空壳：它维护真实的仓位账本与保证金，
并且**会真的在价格穿越时触发止损止盈**（用 K 线的最高/最低价，所以蜡烛内部的触发不会被漏掉）——
这正是它存在的意义：最危险的一类 bug 是"开了仓但保护没挂上"或"保护触发了却没被记账"，
这两者都不可能靠孤立地单元测试风控引擎发现。

### 为什么模拟器要模拟交易所约束（`-1111` 与 `-2021`）

`simulate/simulatedExchange.ts` 里有两段刻意的校验，它们的存在本身就是一段事故记录：

1. **tick 精度**。触发价必须落在该标的的 `tickSize` 网格上，否则模拟交易所像币安一样拒绝：

   > 模拟交易所拒绝：触发价 X 不符合 `SYMBOL` 的价格精度 `tickSize=...`
   > （`-1111 Precision is over the maximum defined for this asset`）

   代码注释写明了原因：*"Without this check the simulation accepts any float, and the real
   `-1111 Precision is over the maximum defined for this asset` rejection only appears against the
   live venue — where it means the stop was never placed. Modelling the constraint is the whole point
   of a simulator."*

2. **立即触发（`-2021`）**。条件单的触发价必须位于市场的要求一侧（止损在亏损侧、止盈在盈利侧），
   否则报：

   > 模拟交易所拒绝：触发价 X 会立即触发（标记价 Y）

真实的 `-1111` 事故后果是：**所有止损都挂不上去，仓位裸奔**。修复落在两处——
`SymbolRegistry.roundTriggerPrice`（`binance/symbols.ts`）负责取整并在取整跨越市场后往安全侧退一格，
`BinanceBroker.placeOrder` 在下单前统一做归一化与本地 `-2021` 预检。
注释解释了为什么归一化的位置在 broker 而不是风控：*"the risk engine only guarantees the direction
of a stop, not its tick alignment... The adapter is the only layer that both knows the symbol filters
and is on the path of every order."*

**所以：改模拟器时不要把这两个校验删掉或放宽。** 它们的全部价值就是让这一类 bug 在离线时被抓到。

---

## 8. 提交前检查清单

```bash
npm run typecheck   # 必须 0 退出
npm test            # 必须全绿（当前 194 个用例）
npm run build       # 改了前端就必须跑；它会编译 packages/web 到 dist
```

三项都过，才算"改完了"。补充约定：

1. **改了前端** → 除了 `build`，还应该在浏览器里真的点一遍受影响的页面（见 `docs/AGENTS.md`
   关于"不要声称没实际运行过的功能"那一条）。
2. **改了影响交易的逻辑** → 至少再跑一次 `npm run sim`，它会在 15 项校验里覆盖执行接缝
   （当前应为 15/15 全通过；若有失败，先读上面「`npm run sim` 的实测状态」）。
3. **改了 prompt / risk / 解析** → 额外跑一次 `npm run verify`，它用真实行情走完整链路。
4. **改了币安相关代码（broker / 端点 / 字段）** → `docs/research/` 里有实测调研，
   动手前先读对应文件；能上真实交易所验证的，就去验证。
5. **修了一个 bug** → 附带一个能复现它的测试，并在注释里写清这个 bug 是什么。
   这是本仓库最一致的工程习惯，请保持。
6. **不要提交 `.env` 和 `data/`**（已在 `.gitignore`，不要用 `-f` 绕过）。
7. **不要在仓库里放站点专属信息**：主机名、域名、IP、服务器路径、凭据。
   需要举例就用 `my-server`、`https://quant.example.com` 这类占位符——
   `scripts/deploy.ps1` 就是这么做的，注释里也写明了理由：*"那些属于部署者自己的环境，不属于项目代码。"*
8. **改了用户可见的行为** → 顺手更新 `README.md` / `docs/API.md` / 本文。
   一份说错了的文档比没有文档更糟：照着它做的人会白白损失几个小时。

---

## 9. 常见陷阱

以下每一条都是从代码和注释里挖出来的真实事实。它们的共同点是：**错了不会报错，只会静默地做错事。**

### 9.1 `node:sqlite` 的字段命名：是 `walletBalance`，不是 `balance`

`/fapi/v3/account` 的资产行里，已结算余额字段叫 **`walletBalance`**，**没有** `balance` 这个字段。
读错拼写得到 `undefined` → `Number(undefined)` → `0` → 静默回落到默认值。这个 bug 会把自己藏起来。
`binance/types.ts` 的注释记录了这一点，`binance/account.ts` 的 `marginAssetOf()` 里也有一行：

> *"Reading `balance` here returns undefined, which compares as 0 and silently falls through to the
> default — a bug that hides itself."*

同一文件里还有第二个拼写陷阱：`/fapi/v3/account` 的资产行用 **`unrealizedProfit`**（小写 r），
而 `/fapi/v2/positionRisk` 用 **`unRealizedProfit`**（大写 R）。**两个端点拼法不同。**

> 相关：`types.ts` 里这些字段名是**对着实盘响应逐字段核对过的**，不是从文档抄的。
> 改这块之前，先读 `docs/research/wire-factcheck-binance-um-futures.md`。

### 9.2 条件单必须走 Algo Order 端点

`POST /fapi/v1/order` 对 `STOP` / `STOP_MARKET` / `TAKE_PROFIT` / `TAKE_PROFIT_MARKET` /
`TRAILING_STOP_MARKET` 一律返回 **`-4120`**。这些必须发到 `POST /fapi/v1/algoOrder`，
而且参数名是 **`triggerPrice`**（`stopPrice` 只存在于响应里）。

搞错的后果不是"报个错"，而是**开完仓止损根本没挂上**。这是一套系统能出的最危险的故障。

两种订单是两个独立身份空间：

| | 普通单 | Algo 单 |
| --- | --- | --- |
| 端点 | `/fapi/v1/order` | `/fapi/v1/algoOrder` |
| ID | `orderId` / `clientOrderId` | `algoId` / `clientAlgoId` |
| 状态 | `status` | `algoStatus` |
| 触发价 | —— | 请求 `triggerPrice`，响应 `stopPrice` |

broker 把两者归一化成统一的 `PlacedOrder`，所以交易循环**不必**分支——改这里的代价很高，
因为下游全部依赖这个归一化。

还有两个由此派生的坑：

- **撤单必须两边都撤**：`DELETE /fapi/v1/allOpenOrders` **不会**动 Algo 单，
  需要额外的 `DELETE /fapi/v1/algoOpenOrders`。`cancelAllOrders()` 同时打两个端点。
- **`getOpenAlgoOrders()` 不带 symbol 时权重是 40，带 symbol 是 1**，所以它永远按标的一次一个调。
- **`algoId` 是逐标的自增的**，只在 `(标的, algoId)` 组合下唯一。

### 9.3 单向 vs 双向持仓模式

这个系统**只在一个模式下推理：单向持仓（one-way）**。

- 订单一律带 `positionSide=BOTH`，**永远不发带符号的数量**——单向模式下方向由数量正负编码。
- 启动时 `ensureOneWayMode()` 会尝试把账户切成单向。**币安在有任何持仓或挂单时拒绝切换**，
  此时它只返回一条 warning，机器人照常启动，但你要知道状态不对。
- 启动预检里，"账户处于双向模式且已有持仓"是**阻塞性错误**（`blocking: true`），拒绝启动。
- 读持仓时方向由 `positionAmt` 的符号推断（`row.positionSide === 'SHORT' || quantity < 0`），
  因为单向模式下 `positionSide` 恒为 `BOTH`。

对账代码（`roundTrips.ts`）也建立在同一个假设上：*"The account is in **one-way mode** (the runtime
enforces this), so `positionSide` is `BOTH` and the direction is inferred from the running position."*
—— 如果有人真的开了双向模式，重建回合的逻辑会算错。

### 9.4 `MIN_NOTIONAL` 是逐币种的

不是全局常数，也不是"5 USDT"。`BTCUSDT` 是 50、`ETHUSDT` 是 20，各不相同。
它从 `exchangeInfo` 的 `MIN_NOTIONAL` 过滤器读出来（`binance/symbols.ts` 的 `minNotionalOf()`，
读不到时兜底 5）。

风控用的是**较大者**：`Math.max(risk.minPositionSize, minNotionalOf(symbol))`。
而且取整之后要**再检查一次**：数量按步长取整后算出的实际名义价值可能掉到门槛以下，
这种情况直接拒绝而不是"差不多就行"。

相关的取整规则：

- **数量永远向下取整**（`roundDownToStep`）。向上取会要得比账户能负担的更多，得到 `-2019`。
  `1e-9` 的微调用来吸收二进制浮点噪声（`0.1 * 3 = 0.30000000000000004`）。
- **价格可以就近取整，但限价单要朝"不改善"的方向**（买单向下、卖单向上）。
- 取到的数量为 0 → 拒绝，并提示"请调大 `position_size_usd`"。

### 9.5 提示词有 token 预算，它会**裁剪候选币种数量**

`strategy/prompt.ts` 里有一整套预算估算，不是装饰：

- **`PROMPT_TOKEN_BUDGET = 60_000` tokens**。这个数字的来源是实测：曾经有一个 **128k token**
  的提示词，模型把整个输出预算花在推理输入上、**一个字符都没输出**。60k 不到它的一半。
- **估算比例是 1.7 字符/token，不是英文直觉的 4**。实测 207,328 字符 → 128,073 tokens。
  原因有两个：提示词里塞满了长数字串（`0.08174000` 这种 tokenize 很吃亏），以及里面有中文散文。
  用英文比例**会把真实大小低估一倍以上**——这就是"以为是 60k 的请求其实是 128k"的成因。
- **候选池会被预算裁剪**：`candidateBudget(config)` 根据**这份策略自己**的
  `时间周期数 × 启用序列数 × 渲染点数` 算出每个标的的开销，再除预算得出上限，
  最后还要 `Math.min(它, 40)`。一个三周期、指标全开的短线策略，每个标的的开销是两周期策略的好几倍。
  裁剪时**持仓标的永远保留**。
- 被裁剪会在日志里明确写出来，并且 `selectCandidates` 返回 `trimmedFrom`，控制台会显示
  "候选池被预算从 N 裁到 M"。这是刻意的：**绝不能让"配置太重"看起来像"市场没机会"。**

**顺带一个直觉陷阱**：`primaryCount` 的默认值是 **60**，不是 30。
指标必须在完整蜡烛集上算才能满足预热（MACD(26,9) 需要 35 根才有第一个直方图值，EMA50 需要 50 根），
但只向模型渲染最近 30 个点（`MAX_RENDER_POINTS`）。**把它设成 30 会让 MACD 静默变空。**

### 9.6 其它几个静默失败的坑

- **WebSocket 路由错了会"连接成功但永远收不到数据"。** 合约 WS 已按流量类别拆成
  `/public` `/market` `/private`，旧的无路由路径已停用。所以 `ws.ts` 有**应用层存活检测**
  （按流记录 `lastMessageAt` + 看门狗），并且**退避计数只在收到真实数据后才重置**——
  在手握成功时重置会让一个永远收不到数据的错误路由变成紧密重连风暴。
- **`exchangeInfo.serverTime` 在测试网陈旧约 5 天。** 时间同步只能用 `/fapi/v1/time`。
- **权重预算不能硬编码。** 实盘 2400/min，测试网 6000/min；照着测试网的值打实盘会从 429 升级成 IP 封禁。
  预算从 `exchangeInfo.rateLimits` 读。
- **时间戳错误有两个码**：`-1021`（网关层）和 **`-5028`（撮合引擎层）**。两个都要触发时钟重同步并重试。
- **`canTrade` 在 `/fapi/v2/account` 里，不在 `/fapi/v1/apiTradingStatus`。** 后者没有这个字段，
  读出来是 `undefined` → falsy → 报"没有合约权限" → **阻塞每一次启动**。这个假阴性在实盘上出现过。
- **提现权限只报警告，不算失败。** 子账户密钥的 `canWithdraw` 读出来是 `true`，但主账户才控制实际提现能力。
  报成红色失败会让操作员学会无视整个面板。
- **测试网的 `/futures/data/*` 不可用**（返回非 JSON）。OI 历史 / OI 排行在模拟盘**优雅降级为空**，不报错。
  所以别把"模拟盘上 OI 是空的"当成 bug。
- **MiniMax 在 HTTP 200 里返回错误**（`base_resp.status_code`）。把它当成功会得到一个"成功的空回答"。
  客户端只对 MiniMax 打开 `failFastOnMinimaxBaseResp`。
- **`-1111` 与 `-2021`** 见第 7 节：触发价必须对齐 tick，且必须落在市场的要求一侧。
