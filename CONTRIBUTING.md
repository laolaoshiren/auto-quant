# 贡献指南

感谢你愿意改进本项目。这是一套**会下真实订单、动用真实资金**的自动化交易系统，
因此本项目的流程要求比普通项目更严：不是官僚，而是因为这里出错要花钱。

在动手之前，请先读 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 它记录了
**为什么这样设计**，以及若干"踩了会亏钱"的实测结论。

---

## 开发环境

**环境搭建、命令、测试策略、调试方法、常见陷阱，全部在
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。先读完那份再动手。**

本文档只讲**协作流程**（分支、提交、PR、评审），不重复开发环境的内容，避免两处漂移。

一轮工作怎么从"发现问题"走到"闭环 + 发版"（谁验证、谁审查、失败回到哪一步、
会话中断后靠什么恢复）见 [`docs/DEVELOPMENT-WORKFLOW.md`](docs/DEVELOPMENT-WORKFLOW.md)。

想理解**为什么这样设计** → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
想知道**某个功能该改哪个文件** → [`docs/MODULES.md`](docs/MODULES.md)
如果你是**没有上下文的新 AI 会话** → [`docs/AGENTS.md`](docs/AGENTS.md)

最短路径：

```bash
npm install
npm run dev        # 后端，http://127.0.0.1:27137
npm run dev:web    # 前端开发服务器（可选）
npm run typecheck
npm test
```

环境要求 **Node.js ≥ 22.5**（用到内置的 `node:sqlite`）。

---

## 仓库设置（维护者必读）

### 已配置

| 项目 | 状态 |
|---|---|
| CI（类型检查 / Lint / 文档链接 / 接口一致性 / 测试 / 构建 / 密钥扫描） | ✅ 每次 PR 与 push main 都跑（`.github/workflows/ci.yml`）|
| PR 自动打标签（路径 + 标题前缀） | ✅ 仅在 PR 上跑（`.github/workflows/pr-labeler.yml`）|
| 发布说明草稿（release-drafter） | ✅ 合入 main 时增量重算（`.github/workflows/release-drafter.yml`）|
| Docker 镜像 | ✅ push main 与 `v*` 标签时构建（`.github/workflows/docker-publish.yml`）|
| CODEOWNERS | ✅ 指向真实账号，改动会自动请求 review |
| Dependabot（npm + GitHub Actions，每周） | ✅ 已启用 |
| Issue / PR 模板 | ✅ 已配置 |
| `main` 分支保护 | ❌ **未启用**（见下）|

> **为什么 CI 恢复于 2026-10-13**：之前（2026-09-30）因为担心 GitHub 自动化触发风控，
> 把 CI 与发版自动化全部删掉，把关回到本地。现在有**外部协作者**
> （多台机器上的 AI 实例、另一个账号）提 PR —— 本地把关证明不了别人的代码，
> 所以 CI 是必需的。
>
> **2026-10-17 用户进一步明确**：正常使用 GitHub 的全部功能（提交、推送、PR、
> Release/Tag、CI、版本号与线上对齐）**是允许且需要的**，要像正规公司一样用；
> 账号曾被 suspend 的真正原因是 AI **高频调用 `gh`**（几分钟里几十次、
> 把 `gh pr checks` 放进循环）。仍然禁止的是那些形状：
> **`gh` 进循环轮询、批量对多仓库操作、一分钟内连续 push、一次迭代开一堆 PR**
> —— 见 [`docs/DEVELOPMENT-WORKFLOW.md`](docs/DEVELOPMENT-WORKFLOW.md) §4.6。
>
> 详见 [`docs/RELEASING.md`](docs/RELEASING.md) 开头那段。

### ⚠️ `main` 分支保护尚未启用（这是**有意**的）

直接推送到 `main` 仍然允许。理由：

- 维护者自己的迭代走 `scripts/deploy.ps1`（scp/ssh），**不经过 GitHub**，
  而现在 `docker-publish.yml` 会在每次 push main 时构建镜像 ——
  若强制走 PR，自己的迭代会多出一轮"开 PR → 等 CI → 合并"的往返；
- 把 `main` 长期弄成红色会训练人忽略红色，比没有保护更糟。

**没有分支保护时，"`main` 是绿的"只能靠看 CI 结果，没有机制帮你拦。**
所以发版前请确认 `main` 上最近一次 CI 是绿的（见 `docs/RELEASING.md`）。

**要启用真正的技术强制**（公开仓库免费，每个仓库做一次）：

```bash
gh api -X PUT repos/<owner>/<repo>/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=类型检查 · Lint · 测试 · 构建' \
  -f 'required_pull_request_reviews[required_approving_review_count]=0' \
  -f 'required_pull_request_reviews[dismiss_stale_reviews]=true' \
  -f 'required_linear_history=true' \
  -f 'required_conversation_resolution=true' \
  -f 'allow_force_pushes=false' \
  -f 'allow_deletions=false'
```

> ⚠️ `contexts` 里的名字必须与 `ci.yml` 的 job `name` **逐字一致** ——
> 写错了 GitHub 会静默地永远不满足那个检查。当前是
> `类型检查 · Lint · 测试 · 构建`（见 `ci.yml` 的 `name:`）。

### 团队协作开始时要改的地方

- `.github/CODEOWNERS` —— 加入每个成员的 GitHub handle（**GitHub 会静默忽略无法
  解析的所有者**，拼错了不会报错，只会导致 review 请求发不出去）
- `required_approving_review_count` 从 `0` 改成 `1`（或更高）

---

## 分支模型

**trunk-based**：`main` 是唯一长期分支，且**始终是绿的**。

- 从 `main` 切出**短生命周期**分支（通常几天内合并，不要开着一周）。
- 分支命名：

  | 前缀 | 用途 |
  | --- | --- |
  | `feat/…` | 新功能 |
  | `fix/…` | 缺陷修复 |
  | `docs/…` | 文档 |
  | `refactor/…` | 不改变行为的重构 |
  | `chore/…` | 构建、依赖、杂项 |

- `main` 的**期望**是：CI 通过 + 至少一名 reviewer 批准后才能合并。
  ⚠️ 但分支保护**尚未启用**（原因见上「仓库设置」），所以直接 push 技术上仍然可行 ——
  这也是为什么发版前必须由人确认 `main` 是绿的（见 [`docs/RELEASING.md`](docs/RELEASING.md)）。

---

## 提交信息

使用 **Conventional Commits**，格式 `<type>(<scope>): <中文描述>`，
**只有一行标题、没有正文**。type 与 scope 的完整取值清单、长度上限、正反例对照表见
[`docs/DEVELOPMENT-WORKFLOW.md`](docs/DEVELOPMENT-WORKFLOW.md) §1。

"为什么这么改"写在**代码注释**里（见 [`docs/AGENTS.md`](docs/AGENTS.md) §5.1）；
过程性记录写在 PR 描述里 —— 提交信息只有一行。

为什么要求这个格式并且只有一行：`feat`/`fix` 能被工具**自动汇总成 changelog 与版本号**，
`git log --oneline` 在不打开任何 diff 的情况下就能读懂；而正文会永久留在公开历史里
（本仓库曾因 231 个提交合计 **20.9 万字符**的正文被迫重写全部历史）。
手写"更新了一下"既无法自动生成任何东西，也无法回答"这个功能是哪次提交引入的"。

本项目域内的真实例子（**都是一行**）：

```
fix(binance): 条件单改走 /fapi/v1/algoOrder，参数名用 triggerPrice
fix(risk): 拆分 clampStopLoss 与 clampTakeProfit，恢复止盈方向
fix(web): 胜率字段改用 winRatePercent，修掉 10000.0% 的显示
feat(strategy): 提示词硬约束段由 RiskControlConfig 动态生成
```

注意第一条写清了**改了什么与后果**（`-4120` 意味着开仓后止损根本没挂上）——
标题要能让人不打开 diff 就明白发生了什么，而不是"修了一些问题"。

### 提交信息里**不写**什么

**这是一个公开仓库，而提交信息是永久且全局可搜索的。**
所以它只写**工程事实**，不写**对话过程**：

| 不写 | 改写为 |
|---|---|
| 「用户说要随时可用」 | 「手工平仓必须随时可用」 |
| 「用户的判断是对的」 | 直接陈述那条判断与技术理由 |
| 「我说过……（引用自己上一轮的说法）」 | 直接写结论；提交信息不是对话续篇 |
| 「用户实测观察：做的币种总是那几个热门币」 | 「候选池按成交额排序时，标的长期集中在头部」 |
| 任何一段对方原话的**逐字引用**（`「……」`） | 把它转述成**需求陈述**，或干脆去掉 |

理由：**技术理由必须留**（根因、判据、为什么这么设计）——那是工程记录；
但「谁提的、说了几次、原话是什么」属于私下对话，写进公开历史等于把它公开。

> 一个例外：`用户提示词`（LLM 的 user prompt）、`用户数据流`（交易所 listenKey 流）
> 这类是**技术术语**，不是对话记录，必须原样保留。

---

## PR 流程

1. **一个 PR 只做一件逻辑上的事。** 顺手重构请另开 PR —— 混在一起会让 review
   和回滚都失去边界。
2. **填写 PR 模板**（`.github/PULL_REQUEST_TEMPLATE.md`），包含「是否涉及真实资金」一节。
3. **PR 要小。** 数百行的 PR 基本不会被真正 review。
4. **说清"为什么"，不只是"做了什么"。** diff 已经说明了做了什么；没有被写下来的
   原因，半年后没人能重建。
5. **关联 issue**（`Closes #123`）。
6. **CI 必须通过**（`npm run typecheck`、`npm test`、`npm run build`）。
7. **至少一名 reviewer 批准**后才能合并（分支保护尚未启用，这一步靠人执行）。
8. **使用 squash merge** 合入 `main`，保持历史线性、每个提交都可用。

---

## 代码规范

- **TypeScript strict**：不要为了省事关掉类型检查。
- **不使用 `any`**，除非有充分理由并在紧邻的注释里写明。
- **注释解释"为什么"，不解释"是什么"。** 本项目的注释经常引用**它所防止的那个
  bug** —— 这是刻意的约定，请沿用：

  ```ts
  // `closePosition` 条件单在手动平仓后依然存活，会朝反方向开新仓。
  // 所以任何手动平仓前必须先撤该标的的全部普通单与 Algo 单。
  ```

  这类注释的价值在于：没有它，后人会把"多余的"撤单代码删掉，然后重新踩一遍。
- **语言边界**：
  - **面向用户的字符串与注释** → 简体中文；
  - **机器契约** → 英文（JSON 字段名、`DecisionAction` 动作枚举
    `open_long` / `close_short` / `hold`、提示词的 XML 标签 `<reasoning>` `<decision>`、
    环境变量名）。
- **有单位歧义时，字段名必须带单位**：写 `winRatePercent` 而不是 `winRate`。
  这不是洁癖 —— 过去服务端返回 0–100 的百分比，而三个控制台页面当成 0–1 又乘了
  一次 100，一笔盈利单被渲染成 **10000.0%**。带单位的名让这类错误无法悄悄重现。

---

## 测试要求

- **任何行为变更都要有测试。** 没有测试的行为变更在 review 中视为未完成。
- **修 bug 必须带一个"没有修复就会失败"的测试。** 先写测试重现，再修。
- **外部行为要固化真实观测值**，而不是自己编的数字：币安返回的字段名、状态字符串、
  错误码（例如 `-4120`、`-1021`、`-5028`）与真实响应形状，都应当来自实测抓取。
  用编造的值写测试，只会固化一个错误的假设。
- 指标类测试固定经典参考值（Wilder RSI、EMA），风控类测试覆盖**每一条限制与钳制
  的方向** —— 这是防止"看起来对但方向反了"这类静默错误的主要防线。

---

## 安全红线

**绝不提交以下内容**：

- `.env` / `.env.*`（`.env.example` 除外）
- `data/` 目录
- 任何 API Key、密码、Token、私钥
- **站点专属的部署信息**：真实主机名、域名、IP、服务器路径。这些属于部署者自己的
  环境，不属于项目代码（`deploy.local.ps1` 已 gitignore）。

关于 `data/`，请理解它为什么是**一等红线**：该目录同时保存
**AES-256-GCM 主密钥**（`data/.master.key`）**和加密后的交易所凭据**（SQLite 数据库
中的 `api_secret_enc`）。两者放在一起，**等价于明文密钥**——拿到这个目录就能解密出
交易所 API Secret。把它提交上去，等于把账户交出去。

---

## 贡献授权

**提交 Pull Request 即表示你同意：你贡献的代码按本项目当前所采用的许可证授权给本项目。**

为什么需要写明这一条：一旦你的代码被合并，那部分代码的版权就同时属于你。
如果本项目将来需要变更许可证（例如从专有转为开源，或在 MIT 与 AGPL 之间切换），
**必须取得每一位贡献者的同意**才能变更整体授权 —— 否则只能追溯剔除那些代码。

事先写明，可以让将来的一次性决定成为可能，而不是翻出一份贡献者名单逐个联系。

> 如果你代表雇主或其他组织贡献代码，请先确认你有权这样做。

---

## 涉及真实资金的改动

> **这一节优先于本文档的其他所有内容。**

本应用会自动在交易所**下真实订单**（当前实现的适配器为币安合约）。凡是可能影响下单路径的改动
（`packages/server/src/binance/`、`packages/server/src/risk/`、
`packages/server/src/trader/`、`packages/shared/src/strategy.ts` 中的风控配置），
适用以下要求：

1. **必须在 PR 描述里明确写出"涉及真实资金/下单路径"**，不允许默默带过。
2. **必须说明测试到了哪一级**，并按升级阶梯逐级验证：

   | 级别 | 手段 | 能证明什么 |
   | --- | --- | --- |
   | 1 | 单元测试 | 逻辑分支正确 |
   | 2 | `npm run sim`（确定性行情夹具 + 模拟交易所） | 整条链路与记账正确 |
   | 3 | `npm run sim:live`（真实 LLM + 模拟交易所） | 真实模型输出能被解析并通过风控 |
   | 4 | 实盘冒烟测试（最小仓位） | **接线**正确，交易所真的接受这些请求 |

   模拟证明的是**逻辑**，只有第 4 级能证明**接线**：

   ```bash
   npx tsx packages/server/src/scripts/liveSmokeTest.ts --confirm
   ```

   它会用最小名义价值走完：预检 → 单向模式 → 杠杆 → 市价开仓 → 挂止损 → 挂止盈
   → 回读确认保护单真的挂着 → 撤单 → 平仓 → 确认账户干净。清理写在 `finally` 里。

3. **不得仅凭 typecheck 通过就合并。** 类型正确与"订单会被交易所接受"之间没有关系；
   本项目已经有过"类型全过、但止损根本没挂上（`-4120`）"这类缺陷。
4. 触及风控引擎的改动，reviewer 应格外确认：**钳制的方向没有被改反**，且每一次
   运行时对模型决策的推翻都会写进决策审计。

### 标签与配置文件

仓库里的标签**不会自动创建** —— 它们是 GitHub 上的状态，而 issue 模板与
release-drafter 只在配置里**引用**标签名。若引用的标签不存在，
**GitHub 会静默忽略**：不报错、不提示，只是那个标签永远打不上。

当前被引用、必须存在的标签：

| 标签 | 被谁引用 | 缺失的后果 |
| --- | --- | --- |
| `incident` | `trading_incident.yml` | 交易事故 issue 无法被筛出 —— 这是最需要优先看到的一类 |
| `documentation` | `docs_improvement.yml` | 文档类 issue 无法筛选 |
| `enhancement` / `bug` | feature / bug 模板 | 同上 |
| `breaking` / `enhancement` / `bug` / `perf` / `docs` / `dependencies` | `release-drafter.yml` | 发布说明对应小节**永远为空** |

改动模板或 release-drafter 的 `labels` 字段时，**请确认标签在仓库里真实存在**。
`perf` 与 `incident` 都曾经漏掉过。
