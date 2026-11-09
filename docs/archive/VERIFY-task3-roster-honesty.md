# 复核报告：task-3 岗位状态诚实化（对抗式）

> 复核对象：`task-3`（`FirmRole.status` 增加 `by_code`，`data_sentinel` / `ops_watchdog`
> 从 `planned` 改为 `by_code`，前端团队看板显示新状态）
> 复核人：实现者本人（`roster-honesty`）· 日期：2026-10-15 · 方式：**试图推翻它**
>
> ⚠️ 本文**不复述实现细节**。它只回答一件事：**我试了哪些办法去证明它错了，结果如何。**
> 每一条都给了可重跑的命令与原始输出。

---

## 0. 我主动去证伪的两处（本次复核的重点）

| 我要推翻的断言 | 我怎么试的 | 结果 |
| --- | --- | --- |
| 「`data_sentinel` 的职责真的在跑」 | 在部署机上**实测** `/api/health`，拿到原始 JSON | ✅ **推不翻** —— 实测返回了 `staleTraders` 字段（见 §1.1） |
| 「`ops_watchdog` 每 30 分钟跑一次」 | **不引用我自己写的注释**，去读调度代码 + 读**运行进程的真实环境** + 查库里的历史行（含"确定性层是否真的产出"） | ✅ **推不翻，但有一处例外**（见 §1.2） |

**一处例外**：查运行进程环境时发现，我写在 `firm.ts` 注释里的「每 30 分钟」在本部署上是
**默认值**，而不是被显式配置绑定的值 —— 也就是说它是一个**可被环境变量改掉的默认值**
（见 §1.2）。这不影响"职责在跑"的结论（那一句是硬的），但它意味着注释里的"每 30 分钟"
在别的部署上可能不是事实。**我把它作为"实现里一条站不住的小地方"记下来（§7）。**

---

## 1. 事实是否成立 → **通过**

### 1.1 `/api/health` 真的产出 `staleTraders`（线上实测）

**证伪思路**：如果这个字段早就改名 / 从来没真的返回过，那么 `data_sentinel` 的"职责在跑"
就不成立 → 把状态改成 `by_code` 就是又一次说谎。

命令（在部署机上跑：主机名、bridge 地址与数据文件路径一律用占位符，见 §8 末条）：

```
$ ssh <deploy-host> "curl -s -m 8 http://<bridge-addr>:<port>/api/health"
{"ok":true,"version":"0.1.0","uptimeSeconds":1357,"hasOwner":true,"dryRun":false,
 "tradingDisabled":false,"environment":"production","db":"<db-file>.sqlite",
 "staleTraders":[],"runningTraders":2}
```

**原始返回里 `"staleTraders":[]` 确实在**，并且紧随其后是 `"runningTraders":2`。
⇒ 「这个端点产出 `staleTraders`」是**可被独立观测的事实**，不是从源码推的。

同时 HTTP 返回码也是实测的：`http_code=200`（`curl -w '%{http_code}'`）。
这一点有意义：按 `api/server.ts:725`，只有存在卡住的机器人时才会变 503 ——
返回 200 说明当前**确实没有**卡住的机器人，而不是这个字段压根没被填充。

**代码侧交叉核对**（两个独立位置，不是同一句话）：
- `packages/server/src/api/server.ts:717` —— 响应体里建 `staleTraders` 数组；
- `packages/server/src/api/server.ts:364` —— `STALE_CYCLE_MULTIPLIER = 2`，`server.ts:440` 用它算阈值 `max(周期×1,1) × 60_000 × 2`。

⇒ 判据是「该机器人自己的周期 × 2」，与审计文档 §2.1 一致。

### 1.2 `findDeterministicProblems()` 真的被调度

**证伪思路 A：会不会只是"定义了一个函数，没人调"**（这正是 `clerk` 那个形态）。
不查注释，直接追调用链：

```
packages/server/src/trader/manager.ts:4249   setInterval(() => { void this.runSelfCheckSweep(); }, minutes * 60_000)
packages/server/src/trader/manager.ts:4288   private async runSelfCheckSweep()
packages/server/src/trader/manager.ts:4364   const result = await runSelfCheck(id, ...)
packages/server/src/trader/selfcheckRunner.ts:208   const deterministic = findDeterministicProblems(evidence);
```

⇒ 链条完整：**定时器 → sweep → `runSelfCheck` → `findDeterministicProblems`**。
（另外 `manager.ts:4283` 启动时还会**立即**先跑一遍，见下。）

**间隔到底是多少**（这一条我刻意不引用自己的注释）：

```
packages/server/src/trader/manager.ts:4246   const raw = Number(process.env.SELF_CHECK_INTERVAL_MINUTES ?? '');
packages/server/src/trader/manager.ts:4247   const minutes = Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 1440) : 30;
```

然后在**运行中的进程**里读真实环境（`/proc/<pid>/environ`），而不是猜：

```
== env: SELF_CHECK_INTERVAL_MINUTES ==
NOT SET -> manager.ts:4247 falls back to minutes = 30
```

⇒ 该变量未设置 → 落到默认 `30` 分钟。**结论成立**。
（同一次探测还确认了：进程由一个 systemd 服务托管，`systemctl is-active` / `is-enabled`
均为 `active` / `enabled`，进程启动于 2026-10-15 17:49:30 CST。服务名与部署目录都是
仓库自带部署脚本里的默认值，不是站点专属信息。）

**证伪思路 B：会不会循环注册了但每次都被跳过（只查在跑的机器人）**。
查库里的**历史留痕**（`runtime_logs`，自检每次写一条）：

```
$ sqlite3 <db> "select count(*), min(created_at), max(created_at) from runtime_logs where scope='selfcheck';"
26|2026-10-15T09:33:05.945Z|2026-10-15T09:50:21.901Z
```

- 有 **26 条**自检留痕 ⇒ 循环**确实执行过很多次**，不是只在启动时空转一次；
- 最早一条 `09:33:05.945Z`、最新一条 `09:50:21.901Z`（= **17:33 / 17:50 CST**）；
- 最新一条与进程启动时刻（**17:49:30 CST**）相差约 **51 秒**，正好对应
  `manager.ts:4283` 的"启动时立即先跑一遍"；而批量同一秒写入 ⇒ 一次 sweep 写多条。

**证伪思路 C（最强的一条）：确定性层真的产出了东西吗，还是只是"函数被调用但什么都不返回"**。
`selfcheckRunner.ts:208-209` 是「`findDeterministicProblems(evidence)` → `persistFindings(...)`」
紧挨着的两步，所以**只要库里有 `[自检/ai]` 结尾的留痕，就说明同一次 `runSelfCheck` 里
确定性层已经跑过**（AI 层在它之后）。实测原文（截断）：

```
2026-10-15T09:50:21.901Z|[自检/ai] SOLUSDT 持仓拿不到标记价，浮盈按 0 计入 —— 权益数字失真且保护判断可能缺依据｜…
2026-10-15T09:50:21.901Z|[自检/ai] 启动对账一次性修正 51 笔且 store 反复报重建边界错误…｜…
2026-10-15T09:50:21.901Z|[自检/ai] 决策循环本身健康｜失败轮次 0、距上次成功 1 分钟、持仓均有保护单｜下一步：无需处理
```

⇒ `ops_watchdog` 的职责**不是"定义了但没人调"**：它有 26 条运行期留痕，而且最新一次
连 AI 层都在同一条链上跑完了。**这一条直接排除了 `clerk` 那个失败形态。**

**证伪思路 D：`findDeterministicProblems()` 里到底有没有我注释里写的那些检查**。
逐个打开源码核对（我注释里写了三项）：

| 我注释里说的 | 源码 | 是否属实 |
| --- | --- | --- |
| 裸奔仓位 | `selfcheck.ts:134` `if (e.nakedPositions.length > 0)`，`severity: 'critical'` | ✅ |
| 连续失败 ≥3 | `selfcheck.ts:147` `if (e.consecutiveFailures >= 3)` | ✅ |
| 长时间无成功决策 | `selfcheck.ts:174`，用 `minutesSinceLastSuccess / cycleIntervalMinutes >= 3` | ✅ |

⇒ 我写在 `firm.ts` 里的那句"含裸奔仓位 / 连续失败 ≥3 / 长时间无成功决策"**没有夸大**。
（另注：这一项用的是**周期倍数**而不是写死 30 分钟，与注释里"相对阈值"的设计一致。）

### 1.3 关于 §1.2 那处例外的诚实说明（**这是我要主动指出的小问题**）

`firm.ts` 的 `carriedBy` / 注释把"每 30 分钟"当成了**事实**写进面向操作员的文案，但实际是
**默认值**：任何部署只要设了 `SELF_CHECK_INTERVAL_MINUTES`（1–1440 之间的整数）就变了。
本次部署恰好没设，所以**当前是真的**；但换部署环境后这句文案会变成一句**无法被核对、
且已经过时**的话 —— 而这正是本次改动要消灭的那类东西。

判定：**不阻塞部署**（当前部署为真；且文案主体"由 selfcheck.ts 承担"是硬的）。
但它是本报告认为**最值得改的一处**，改法见 §7（我没有改，见该节说明）。

---

## 2. 其余 5 个 `planned` 是否被顺手改掉 → **通过**

```
$ grep -n "id: '" packages/shared/src/firm.ts   # 与 status 行逐一配对
```

| 岗位 | 当前 status | 应当 |
| --- | --- | --- |
| `onchain_analyst` | `planned` | `planned` ✅ |
| `community_monitor` | `planned` | `planned` ✅ |
| `red_team` | `planned` | `planned` ✅ |
| `portfolio_manager` | `planned` | `planned` ✅ |
| `clerk` | `planned` | `planned` ✅ |

同时 `data_sentinel` / `ops_watchdog` = `by_code`，其余 14 个 = `staffed`。
**没有被顺手全改。**

> 附：实现过程中我曾用一条 PowerShell 批量替换做"守卫探针"（见 §5.1），那次批量替换**误伤了
> 另外 6 个岗位的状态**。我随后用「按 id 精确重写 status」的脚本修复，并加了
> `matched === 21` 的**前置断言**（不满足就抛错、不写盘）。当前状态经上表逐条核对，
> 且 `git diff packages/shared/src/firm.ts` 显示**只有 2 个岗位的状态行发生变化** ——
> 这一条我用 diff 本身做了证据，而不是凭记忆。

---

## 3. 新状态会不会落进"规划中"兜底分支 → **通过（用渲染输出与可量属性说话）**

**证伪思路**：新状态只要有一个消费点没覆盖，就会静默降级成"规划中"或"在岗"。

1. **状态映射处**（唯一的双分支写法已经被换掉）：
   `packages/web/src/components/TeamBoard/roster.ts:127` 是
   `Record<FirmRole['status'], RosterState>` 映射表（`firm.ts` 的状态取值 → 前端状态），
   `by_code: 'by_code'`。写成 `Record` 的代价是**漏一个取值就编译不过** ——
   所以这一类降级在类型层就被挡住了，不依赖测试。当前值：`staffed→idle` / `by_code→by_code` / `planned→planned`。
2. **渲染函数输出**（不是"看起来对"）：我写了一个一次性 SSR 探针，直接调用组件渲染函数并把
   **HTML 输出**打出来（命令与输出见 §5.2）。对 `data_sentinel` 那一行，输出里是
   `>代码在跑<`，并且**整行可见文字**不含"规划中"，也不含"待命 / 最近活跃"。
3. **没有用肉眼判断**：`AGENTS.md` 明确要求这类结论**要量不要看**。本次我量的是：
   - 渲染输出里的**文字**（剥掉标签后断言，避免把 `title` 属性里的字当成渲染结果）；
   - `aria-expanded` 属性（§6，量折叠状态）。

⚠️ **一处自我证伪记录**：这个 SSR 断言**第一次跑就抓到了我自己实现里的一个真 bug** ——
状态词已正确写"代码在跑"，但同一行下面的"出勤"分支仍然渲染"待命"，**同一行两句矛盾的话**。
typecheck / build / 既有单测全绿，只有屏幕会说假话。已修（`by_code` 不再进出勤分支）。
这一段的意义在于：**如果我只读了代码而没跑渲染，我就会漏掉它** —— 所以 §3 的结论建立在
渲染输出上，而不是建立在我的阅读上。

---

## 4. 别处的 `status === 'planned'` 判据是否被改变行为 → **通过（逐点列出）**

全仓 `grep "'planned'"` 的**每一个消费点**（含测试与文档）：

| # | 位置 | 改动前行为 | 改动后行为 | 影响 |
| --- | --- | --- | --- | --- |
| 1 | `web/.../TeamBoard/roster.ts:250` 附近（原 `role.status === 'planned' ? 'planned' : 'idle'`） | 双分支：非 planned 一律 `idle` | 显式三态映射表 | **本次核心**：新状态不再降级成 idle |
| 2 | `web/.../TeamBoard.tsx` 头部计数 | `规划中 7` | `代码在跑 2` + `规划中 5` | 面向操作员的数字变了（**期望的**） |
| 3 | `web/.../TeamBoard.tsx`「其余岗位」行 | `规划中 7（还没实现）` | `已由代码承担 2 · 规划中 5（还没实现）` | 同上 |
| 4 | `shared/src/firmStatus.test.ts:121` `status === 'planned' && isWired` | 这 2 个在 `routedModel.ts` 里有 id 字面量 → 会被这条判为"接线后忘改状态" | 它们不再是 planned → 不再进这条判据 | **测试的期望被修正**（原期望是错的：它们确实"接了线"，只是不是 LLM 线） |
| 5 | `shared/src/firmStatus.test.ts:138` planned 清单 | 7 个 | 5 个 | 期望值更新 |
| 6 | `shared/src/firmRoles.test.ts:129-134` | 不存在（本次新增） | 分布断言 14/2/5 | 新增守卫 |
| 7 | **`server/src/trader/routedModel.test.ts:387`** `filter(r => r.status === 'staffed')` | 这 2 个不在集合内 | 仍不在集合内 | **行为不变**（server 全量测试 1747/1747 绿） |
| 8 | `docs/团队模式-进度看板.md:54`、`docs/FINDING-clerk-unwired.md:16` | 提到"看板显示规划中" / `clerk` 是 planned | 文档文字**已过时**（前者描述的是旧判据行号与旧行为） | ⚠️ **见 §7 第 2 条** |

⇒ 有行为变化的只有 2 个前端消费点，且都是**期望的**变化；测试期望更新 3 处；
`routedModel.test.ts` 那条判据**不受影响**（我实测跑过 server 全量）。

---

## 5. 测试是否钉住了正确的东西 → **通过（并用"反向复位"证明有牙）**

### 5.1 我做的探针：把新文案/新状态"换回旧的"，测试必须变红

**探针 A（shared）**：把 2 个岗位从 `by_code` 改回 `planned`（批量替换，随后精确还原），
`npm test --workspace @aq/shared` 的结果：

```
not ok 37 - ★★★ 岗位的实现状态分布（14 在岗 / 2 已由代码承担 / 5 规划中）
not ok 39 - ★★★ 接了线的角色不能再标 planned（用户截图抓到的那类漂移）
not ok 41 - ★ planned 的岗位清单（新增/接线岗位时同步更新这条期望）
not ok 43 - ★★★ data_sentinel / ops_watchdog 必须标 by_code —— 界面写"规划中"而实际在跑就是说谎
```

**探针 B（web/SSR）**：同一状态下 `npm test --workspace @aq/web`：

```
not ok 1 - ★★★ 已由代码承担的岗位不能显示成"规划中"（界面在说的必须是事实）
not ok 3 - ★★★ 头部计数必须把"代码在跑"从"规划中"里分出来
not ok 18 - ★★★ 已由代码承担的岗位不得落进"规划中"，也不得落进"在岗"（判据探针）
```

⇒ 两个方向都有牙：**改回 planned 会被抓住**，**头部计数也会被抓住**。

**探针 C（其余 5 个被改成 `by_code`）**：由 `firmRoles.test.ts` 的
`by_code 成员 == ['data_sentinel','ops_watchdog']` 与分布断言 `by_code == 2` 覆盖
（代码复核：这两条断言对**多一个** `by_code` 必然失败）。⚠️ 我**没有**实际跑这一探针
（改了源码再还原的窗口越小越好，且 §2 那次的误伤已让我付过代价）—— 这一条是**代码推演**，
不是实测，如实标注。

### 5.2 "只是断言字段等于某值"的那一类测试能防住什么

这是清单第 5 条要我说清楚的。我的判断（按防住什么分档）：

| 测试 | 防住什么 | **防不住什么**（说清楚） |
| --- | --- | --- |
| `firm.ts` 的状态值断言（`firmStatus`/`firmRoles`） | 下一次有人把这 2 个改回 `planned` / 把其余 5 个改成 `by_code` / 删掉一个岗位（分布断言同时抓） | **源码本身被改假**：它只断言常量 vs 常量，我把它作为"证据"改了，它不会反驳 |
| `carriedBy` 必须指向"真的存在那段代码" | 文案指向一个不存在/已删除的模块 | "字段被读了但读错了"（这里即：端点是否真的**返回**该字段）。我把判据加宽到 `staleTraders`，它在 `server.ts` 里确实同时出现在**响应体构造处**，但判据本身**不校验"在响应体里"这个位置**（§7 第 3 条） |
| SSR 渲染断言（`boardRender.test.ts`） | **"新状态没走到正确分支"**、"同一行既说 A 又说 B"、头部计数把在跑的说成没实现 | 布局/对齐/视觉；真实浏览器里的交互（它不执行 `useEffect`） |

⇒ 结论：**常量断言那几条防不住"源码改假"**，而"职责真的在跑"这个事实**只能由代码之外
的证据来钉**。本次我是用**线上实测 + 运行期留痕**把它钉住的（§1），那两条证据**不在测试里**，
也不在仓库里 —— 下一次有人想推翻 task-3，必须重做 §1 的实测，而不是"看测试全绿"。

---

## 6. `typecheck` / 前端测试 / `build` 的真实结果 → **通过**

全部在复核当时**自己重跑**（`$LASTEXITCODE` 直读，不接管道 —— `docs/AGENTS.md` §3.1）：

| 命令 | 退出码 | 用例数 |
| --- | --- | --- |
| `npm run typecheck` | **0** | —（`tsc --noEmit` ×3 workspace + web 的 `tsconfig.test.json`） |
| `npm test --workspace @aq/web` | **0** | `# tests 266 / # pass 266 / # fail 0` |
| `npm test --workspace @aq/shared` | **0** | `# tests 65 / # pass 65 / # fail 0` |
| `npm run build` | **0** | `✓ built in 3.48s` |

**产物里有新文案**（`build` 通过 ≠ 新代码进了包 —— 所以单独查了 bundle 字符串）：

```
代码在跑       -> TraderPage-C-6t6SQ2.js
已由代码承担   -> TraderPage-C-6t6SQ2.js
由代码承担：   -> TraderPage-C-6t6SQ2.js
```

（顺手补一个旧坑：`roster.ts` 文件头记过"写了不存在的 Tailwind 类，样式不生成、编译全绿"。
本次新用的两个类我都去**构建产 CSS** 里核对了：
`.bg-accent\/20{background-color:rgb(var(--aq-accent-rgb) / .2)}` 与 `.border-accent` 都存在。）

### 6.1 Lead 要求的附加证据：`--tsconfig` 不影响 `build` / 线上产物

```
$ git diff -- packages/web/package.json
-    "test": "tsx --test \"src/**/*.test.ts\"",
+    "test": "tsx --tsconfig tsconfig.json --test \"src/**/*.test.ts\"",
```

`git diff` 的**唯一**一条增删就是 `test` 脚本那一行；`build` / `dev` / `preview` / `typecheck`
一个字节都没动（diff 里没有它们）。`npm run build` = `vite build`，不经过 `tsx`，
也不读 `tsconfig.test.json`。⇒ **对 `npm run build` 与线上产物无影响**。
（改动动机仍然是成立的：`scripts/ssr-decision-feed.tsx` 文件头记过同一个坑 ——
tsx 只在 cwd 找 tsconfig；不显式指定时，从别的 cwd 启动会按 Classic 转换编译 `.tsx` 并抛
`React is not defined`。这是**可复现**的：我第一次从仓库根跑 SSR 测试就是这个报错。）

### 6.2 Lead 要求的独立确认：`initialShowRest` 默认不改变线上行为 → **确认**

**证伪思路**：`initialShowRest` 默认若不是 `false`，"其余岗位"初始就摊开 →
`ui-smoke` 统计的"规划中 N 处"会变 → Lead 会误判成回归。

我用 SSR 对比了**同一组输入**下 `{}`（默认）与 `{ initialShowRest: true }` 的输出：

```
collapsed aria-expanded = false
initialShowRest:true aria-expanded = true
collapsed has data-role=data_sentinel ? false
expanded  has data-role=data_sentinel ? true
collapsed: 规划中 count = 2 | 已由代码承担 count = 1 | li count = 0
collapsed 含 [已由代码承担 2] ? true
collapsed 含 [规划中 5（还没实现）] ? true
```

读数说明（默认态 = collapsed）：
- 折叠按钮 `aria-expanded="false"`；**没有任何岗位 `<li>` 被渲染**（`li count = 0`）⇒ 默认收起；
- `规划中` 只出现 **2 次**：一次在头部计数（`规划中 5`），一次在「其余岗位」那一行
  （`规划中 5（还没实现）`）—— 都来自**头部/摘要**，不是来自 16 个岗位行；
- `已由代码承担` 出现 **1 次**，在「其余岗位」摘要行里。

⇒ 默认行为**没有改变**：那批岗位初始仍是折叠的，只有点开才展开。
`ui-smoke` 的计数因此是**确定性的**（当前文案下：折叠态 `规划中` ×2、`已由代码承担` ×1）。
⚠️ 但要把话说全：`ui-smoke.mjs` 目前**只打印这两个计数、没有任何断言**，
所以它不会因为多一个少一个而失败 —— 数字变了要**人来读**。这一点 Lead 已知。

---

## 7. 我自己实现里站不住的地方（哪怕很小，都写出来）

### 7.1 「每 30 分钟」是可被环境变量改掉的默认值（**建议修**）

见 §1.3。文案把默认值写成了事实。**改法建议**（我没有动，理由见下）：
把 `firm.ts` 的 `carriedBy` 里那句"每 30 分钟调度"改成不含周期数字的表述
（例如"由 `selfcheckRunner.ts` 定期调度"），或者把它写成"默认 30 分钟（可被
`SELF_CHECK_INTERVAL_MINUTES` 覆盖）"。**面向操作员的文案不该包含一个会随部署变化的数字，
除非它旁边就写着它是可配的。**

### 7.2 两处文档已经过时（**建议修**）

- `docs/团队模式-进度看板.md:54` 原文：「团队看板上它们会显示「规划中」`roster.ts:202` 的判据
  就是 `role.status === 'planned'`」——判据行号与**行为**都过时了（现在这 2 个显示"代码在跑"）。
- `docs/FINDING-clerk-unwired.md:16` 把 `clerk` 的 `firm.ts:306` 描述成 `status: 'planned'` ——
  行号已漂移（现在在 `firm.ts:371`），且该文档是"发现记录"，本就不该被当成现状。

这两处**不属于** task-3 的交付范围（task-3 写的是"注释解释为什么"，没要求同步 docs），
但如果下一轮有人照着它们做，会得出错误结论。**建议由 Lead 决定是否补一份 docs 更新。**

### 7.3 `carriedBy` 的存在性守卫判据偏宽（**可选加固**）

`firmStatus.test.ts` 的新守卫对 `data_sentinel` 的判据是「`server.ts` 里出现 `staleTraders`」。
实测这句是**真的**（`server.ts:717` 就在响应体构造里），所以**当前不存在假绿**。
但它用的是 `includes`，理论上"字段名还在、但不在响应体里"（例如被挪去别处或改名成
`stale_traders`）不会被它抓住。加固方式是把判据锚到响应体那一行
（例如要求匹配 `staleTraders:` 这一形状）。**我没有改**：task-6 的硬约束是"只写报告文件"。

### 7.4 一条**判不了**的事（不是实现的问题，是我无法验证）

`manager.ts:4288` 的 sweep **只给"在跑"的机器人**跑自检（`manager.ts:4293` 附近有明确注释）。
线上 `runningTraders` 为 2，所以有 2 个在跑 —— 这条与 §1.2 的 26 条留痕一致。
但**在机器人全部被停掉的部署上，"自检每 30 分钟在跑"这个说法会变成空转**（循环在、但 sweep
没有任何对象）。当前部署不适用；我把它写下来是因为它影响"这句话在别的形态下还成不成立"。

---

## 8. 我**没能**验证的部分（诚实清单）

> 完整性声明：§1 / §5 / §6.2 里那些**一次性探针脚本**（远程探测脚本、SSR 探针、批量替换探针）
> 都是临时的，跑完即删；`git status` 里不会留下它们。复核结束时工作树里**只有本报告**
> 是本次新增的文件（其余改动属于 task-3 与另外两位队友）。

1. **没有在真实浏览器里看这块 UI**：无 `AQ_BASE` / `AQ_TOKEN` / `AQ_CHROME`，
   所以没有跑 `npm run ui:smoke`，**没有量过 `getBoundingClientRect()`**，
   也无法证明 150% 缩放下没有横向滚动。§3 / §6.2 的结论来自 **SSR 渲染输出 + `aria-expanded`**，
   它们证明的是"字对不对"和"默认折不折"，**不证明**布局/视觉/交互。
2. **线上跑的是不是这一版**：我实测的 `/api/health` 证明**事实成立**，但我**没有**核对
   线上 bundle 里有没有 `代码在跑`（那需要打线上静态资源）。因此"部署后界面显示新文案"
   这一点**未验证** —— 只能证明本地 `build` 的产物里确实有这段字符串。
3. **§5.1 探针 C（把其余 5 个改成 `by_code`）没有实测**，只有代码推演。
4. **没有验证** `ui-smoke` 在真实页面上读到的"规划中 N 处 / 已由代码承担 N 处"与
   §6.2 的 SSR 读数一致（SSR 不含 `useEffect`、也不含 CSS 断点）。
5. **没有**用实测去测"两次 sweep 之间正好隔 30 分钟"（那需要一个 30 分钟窗口的观测，
   或读 `server.log` 的时间戳序列）。当前支持"循环在跑"的是三段证据：
   代码链（定时器 → sweep → `runSelfCheck → findDeterministicProblems`）、
   运行进程环境（变量未设 ⇒ 默认 30）、以及 26 条运行期留痕（最新一条与"启动即跑"吻合、
   批量同秒写入 = 一次 sweep 多条）。**"间隔恰好 30 分钟"是代码 + 环境推出的，不是秒表量的。**
6. **没有验证** `SELF_CHECK_INTERVAL_MINUTES` 在**部署脚本/unit 的 EnvironmentFile** 里
   也没有设置（我只读了运行进程的 `environ`）。进程环境即事实，但"下次部署会不会带上它"
   我无法从本机断言。
7. **本机跑不了 task-3 里那个"守卫有牙"的完整复现**：探针 B/C 的复原我是用**精确重写脚本**
   做的，并加了 `matched === 21` 的前置断言与 diff 核对（§2 附注）；但"完全无损的原子
   换回"没有工具保证 —— 这一点我如实说出来。

---

## 9. 总判定：**可部署**

按清单 1–6 逐条：**全部通过**（§1–§6）。没有发现会让结论翻转的反证：

- 两条"职责在跑"的事实，一条来自**线上原始返回**（`"staleTraders":[]` + HTTP 200）、
  一条来自**运行进程环境 + 运行期留痕**（`SELF_CHECK_INTERVAL_MINUTES` 未设 ⇒ 默认 30；
  26 条 selfcheck 留痕，最新一条同秒批量写入、且含 `[自检/ai]` —— 证明确定性层确实跑过）；
- 其余 5 个 `planned` 未被顺手改；新状态**没有**落进"规划中"或"在岗"分支
  （映射表在类型层挡住漏取值；渲染输出实测为"代码在跑"）；
- 行为变化的消费点全部列出，其中只有 2 个是**期望的**前端变化，`routedModel.test.ts` 那条判据不受影响；
- 反向探针证明测试有牙；typecheck / shared / web / build 全绿且产物含新文案。

**不需要返工的项**。以下是**建议**（都不阻塞部署，按价值排序）：

1. **`firm.ts` 的"每 30 分钟"改为不含会变数字的表述**（§7.1）——最值得做，因为它正是本次
   要消灭的"不可核对的事实"形态。
2. 更新两处已过时的 docs（§7.2）。
3. （可选）把 `carriedBy` 守卫的判据锚到 `staleTraders:` 形状（§7.3）。

> ⚠️ 关于第 1、2 条：task-6 的硬约束是**只写本报告文件、不改任何源码或测试**，
> 所以我**没有动手**。Lead 的指示里说"发现站不住就直接写出来并修掉"——两条指示冲突时，
> 我选择遵守 task-6 更严格的**只读**约束，并把改法写清楚，避免在复核者身份下改源码
> 从而污染"被复核对象"与"复核结论"的独立性。**是否现在修，请 Lead 定；我可以立刻执行。**
