# 发版手册

面向**维护者与版本发布官**。贡献流程见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)，
部署细节见 [`DEPLOYMENT.md`](DEPLOYMENT.md) 与 [`../deploy/README.md`](../deploy/README.md)，
开发流程与闭环纪律见 [`DEVELOPMENT-WORKFLOW.md`](DEVELOPMENT-WORKFLOW.md)。

本项目**下真实订单**，所以一次发布会影响正在跑着的机器人。
本手册的目的不是走流程，而是让"这次发布要改什么"在发布之前就被看见，
并且让"什么时候**不能**发布"有明确的判据。

> ⚠️ **前情提要（为什么这里曾经一度"完全不碰 GitHub"）**
>
> 2026-09-25 发生过一次真实事故：AI agent 在几分钟里连续创建并合并 6 个 PR、
> 每个都跑 `gh pr checks` 轮询，几十次 API 调用挤在几分钟内 —— 用户的 GitHub 账号
> 被判定为滥用自动化并 **suspend**。当时的应对是把 CI 与发版自动化全部删掉，
> 把关回到本地。
>
> **2026-10-17 用户的明确指示修正了这个结论**：真正的问题不是"用 GitHub"，
> 而是**变态频繁地调用 `gh`**。正常使用 GitHub 的全部功能（提交、推送、PR、
> Release/Tag、CI、版本号对齐）**是允许且需要的**，要像正规公司一样用；
> 仍然禁止的是那些导致封号的形状：**`gh` 进循环轮询、批量对多仓库操作、
> 一分钟内连续 push、一次迭代开一堆 PR**。
>
> 所以本手册以下内容**全部按"正常使用 GitHub"来写**；上面那四条禁令仍然有效
> （见 [`DEVELOPMENT-WORKFLOW.md`](DEVELOPMENT-WORKFLOW.md) §4.6）。
>
> 当前生效的三条工作流（全部由 GitHub 事件触发，没有任何脚本轮询或批量调 API）：
>
> | 工作流 | 触发 | 做什么 |
> | --- | --- | --- |
> | [`ci.yml`](../.github/workflows/ci.yml) | PR / push main | 类型检查 · Lint · 文档链接 · 接口一致性 · 测试 · 构建 · 密钥扫描 |
> | [`pr-labeler.yml`](../.github/workflows/pr-labeler.yml) | PR | 路径标签（`labeler.yml`）+ 类型标签（Conventional Commits 前缀）|
> | [`release-drafter.yml`](../.github/workflows/release-drafter.yml) | push main | 增量维护发布说明草稿，并按标签推导版本号 |

---

## 1. 版本号策略

### 1.1 语义化版本（0.x 阶段）

当前是 **0.x**。按语义化版本的定义，`0.x` 的**次要版本可以包含破坏性变更** ——
但这只是允许，不是免于说明：这个项目的破坏性变更会打到已经部署的服务器上，
所以它必须**单独成节**、写清"升级的人要做什么"。

什么算破坏性变更（都要打 `breaking` 标签）：

| 变化 | 为什么是破坏性的 |
| --- | --- |
| 环境变量改名、删除或默认值反转 | 部署方的 `deploy/.env` 会静默失效 |
| `StrategyConfigSchema` 新增**无默认值**的必填字段 | 已存在的策略读取失败并整体回退到默认配置，用户的策略被换掉 |
| [`API.md`](API.md) 里已有端点的契约变化 | 控制台与外部脚本会按旧契约调用 |
| `data/` 的数据库迁移不可回退 | 回滚镜像会读到新 schema |
| `CloseReason`、`DecisionAction` 等**持久化机器码**的值变化 | 等于改写历史账目 |

版本增量由标签推导（[`.github/release-drafter.yml`](../.github/release-drafter.yml)）：
`breaking` / `enhancement` → **次要**版本，`bug` / `perf` / `docs` / `dependencies` → **补丁**版本。

> **1.0.0 由人决定，不自动发生。** 配置里刻意没有 `major` 规则：
> "这次破坏性变更够不够格升到 1.0"是产品决策，不该由一次自动标签替人做出。
> 真要发 1.0 时，直接把草稿的名字与标签改成 `v1.0.0` 再发布。

### 1.2 版本号的唯一事实来源与「四处对齐」

本项目有**四个地方**会出现版本号，它们口径不同、必须**同时**对齐：

| # | 位置 | 口径 | 谁写 |
| --- | --- | --- | --- |
| ① | GitHub **Release 的 tag**（`vX.Y.Z`） | **权威来源**：对外发布的产品版本 | 发版时由人确认并发布 |
| ② | `git tag vX.Y.Z`（annotated） | 与 ① 同名同提交；用于回溯与镜像构建 | `git tag -a vX.Y.Z` |
| ③ | `package.json` 的 `version` | 服务端 `/api/health` 的 `version` 字段读它（`readAppVersion()`） | 发版提交里一起改 |
| ④ | 线上运行环境 | `build-info.json` 的 `commitShort`（= 部署时的本地 HEAD）+ `/api/health` 的 `version` | 部署脚本自动写 / 随 ③ 上线 |

> ⚠️ 控制台「操作员账户」页的**产品版本**取的是 GitHub 最新 release tag
> （`buildInfo.ts` 的 `latestRelease`），**不是** `package.json` ——
> 历史上那一格读 `package.json`，而它长期停在 `0.1.0`，
> 于是界面上的"产品版本"与实际发布差了几十个版本却没人看得出来。

**发布前的对齐检查（可执行）**：

```powershell
# 本地：HEAD 与 tag
git rev-parse --short HEAD
git describe --tags          # 期望形如 v0.1.42，而不是 v0.1.20-107-g…
git tag --sort=-v:refname | Select-Object -First 3
# 本地：package.json 的 version 必须等于你即将发布的 vX.Y.Z
node -p "require('./package.json').version"
```

```bash
# 线上（由有 SSH 授权的成员执行；只读）
#   ① build-info.json 的 commitShort == 本地 HEAD
#   ② /api/health 的 version == package.json 的 version（③ 口径）
#   ③ GET /api/system/update 的 latestRelease == GitHub 最新 Release tag（① 口径，需登录）
```

> ⚠️ `build-info.json` **没有** `version` 字段（只有
> `commit / commitShort / branch / subject / committedAt / deployedAt / dirty / repository`）。
> 所以 ④ 这一环能对齐的是**提交**（`commitShort` 必须等于本地 HEAD），
> 版本号则要靠 `/api/health` 与线上部署目录里的 `package.json` 来读。

> ⚠️ **2026-10-17 只读审计实测的漂移（发版前必须先处理）：**
>
> | 位置 | 实测值 |
> | --- | --- |
> | 线上 `build-info.json` 的 `commitShort` | **等于本地 HEAD** ✅ |
> | `package.json` 的 `version`（本地与线上部署目录都是） | `0.1.32` |
> | 线上 `/api/health` 的 `version` | `0.1.32`（它正是读 `package.json`） |
> | GitHub 最新 Release | `v0.1.38` —— 比 `package.json` **高 6 个 release** |
> | 本地 git tags | 最大 `v0.1.20`（缺 `v0.1.21`~`v0.1.38`） |
> | `CHANGELOG.md` | 正文只到 `0.1.0` |
>
> 后果是**同一个进程里两个界面自相矛盾**：账户页显示 `v0.1.38`（取 GitHub release），
> 登录页显示 `0.1.32`（取 `package.json`）。
>
> 根因：版本号由 release-drafter 从提交推导 tag，**从不写回 `package.json`**，
> 而 `/api/health` 仍然读 `package.json`（`readAppVersion()`）。
>
> 修正动作（发版时一起做，不要只改一处）：
> ① 先 `git fetch --tags`（把本地 tags 补到与远端一致，**这一步单独做，不要和 push 挤在一分钟内**）；
> ② 在**同一个发版提交**里更新 `package.json` 的 `version` 与 `CHANGELOG.md`；
> ③ 打 annotated tag `vX.Y.Z` 并推送；
> ④ 部署后**两条口径都要回读**（只回读一条证明不了"版本号已对齐"）：
>    · `GET /api/health` 的 `version` → 证明"线上部署目录的 `package.json` 与本地一致"（③ 口径）；
>    · `GET /api/system/update` 的 `latestRelease`（需登录；服务端缓存 10 分钟）
>      → 证明"线上认到的发布版本与 GitHub Release 一致"（① 口径）。

> **口径路线（必须写清选哪条，否则会反复）**：两个口径长期不一致的**根因是"改一次就忘"** ——
> 实测 38 次发版里 `package.json` 那个字段只对齐过 1 次。代号与选择如下：
>
> | 路线 | 做法 | 选还是不选 |
> | --- | --- | --- |
> | **A′（目标路线 = V1，阶段 2 的代码修复）** | `checkForUpdates()` **成功**拿到 release tag 时，把值**快照进一个模块级缓存**（`buildInfo.ts` 新增 `lastKnownRelease: string \| null`）；`/api/health` 与 `/api/system` 读**这个快照** —— **请求路径上零网络调用、零 `await`、零超时**。冷启动或从未成功取到时为 `null` → 回落 `package.json`（与账户页现有降落策略同构）。快照**只在成功时更新**：一次网络抖动不得把已知版本抹成 `null` | ✅ **选它**：零新增请求是**结构上**成立的，不依赖"缓存恰好命中" |
> | **V2（同一目标的错误实现）** | 在 health handler 里 `await checkForUpdates()` | ❌ **不选**：`checkForUpdates()` 的出网超时是 **8 秒**，而 `/api/health` 是**唯一**被探活的健康端点、编排器每 30 秒打一次且 **timeout 5 秒**（`--retries=3`：要连续 3 次才判 unhealthy）。GitHub 抖动 / 未认证限流 / 出口不通时，8 秒 > 5 秒 —— 网络问题会被**翻译成健康状态信号**：`deploy/up.sh`（阻塞等待容器健康才继续）会卡住或误判、监控会误报。本仓库的 compose 配置**没有 `restart:` 策略**，所以默认形态下先表现为"部署卡住 + 误报"；若目标环境配了 `restart` 策略或外部看守进程，它会进一步升级成**反复重启一个正在跑真实资金的进程**（在**不使用本仓库 Dockerfile / `HEALTHCHECK` 的部署形态**下，例如 systemd 直接跑进程：探活仍会执行、也仍可能把容器标记为 unhealthy，但那个状态**不影响该进程** —— 危害落点同样落在部署流程与监控上） |
> | **B′（过渡路线，零代码改动）** | 保留 `package.json` 口径，靠本手册的清单约束"发版时同改 + 两条口径同时回读" | 在 A′ 落地前**必须**执行；它是纪律而不是机制，所以容易复发 |
>
> 本手册选 **A′（必须按 V1 实现）为最终形态、B′ 为过渡**；**不选** V2，也**不选**
> "只保留 `package.json` 口径、不做回读" —— 后者正是过去 38 个版本的状态，已经证明会失败。
>
> **A′（V1）的验收标准（阶段 2 条目草案，由队长/缺陷台账官正式登记）**：
>
> 1. `/api/health` 的 handler 路径里**没有任何 `fetch` / `await checkForUpdates()`** ——
>    用**结构守卫测试**断言源码（本仓库有此先例，如 `api/traderStatsNotFound.test.ts`）。
>    **这一条比"请求次数守卫"更重要**：次数守卫允许"偶尔出网"；
> 2. `buildInfo.test.ts` 的请求次数守卫仍绿（零新增 GitHub 请求）；
> 3. 取不到 release 时回落 `package.json`，**且回落值在 `/api/health` 上也生效**
>    （登录页读它）—— 不能只修账户页那一格（`ecebb19` 的错误正是只修了一格）；
> 4. 快照与 `/api/system/update` 缓存 TTL（成功 10 分钟 / 失败 60 秒）的**生命周期写清**：
>    快照只在成功时更新，失败不覆盖；
> 5. （可选，与文档漂移审计的 VER-3 合并）既然同一处要改 `buildInfo.ts` 与 `deploy.ps1`，
>    顺手决定"要不要把版本号写进 `build-info.json`" —— 它现在**没有 `version` 字段**，
>    离线无法回答"跑的是哪个版本号"。
>
> ⚠️ 修版本号口径时**不要新增 GitHub 出网请求**：`buildInfo.ts` 已按未认证限额
> （60 次/小时）算过预算，代码注释明确写着"不要在这里再加请求"。

> ⚠️ **版本号推导链对直推 `main` 的提交不生效**：标签来自 **PR 标题前缀**
> （`pr-labeler.yml`），而本项目大量迭代是**直推 `main`** 的（不经过 PR）。
> 实测：38 个 Release 全是 patch 递增，24 条 `feat:` 没有产生过一次 minor。
> 所以草稿里的版本号**只能当建议** —— 发版人必须人工核对（§2.1 已把它列为准入条件）。

### 1.3 Tag 命名

| 规则 | 说明 |
| --- | --- |
| 格式 | `v<major>.<minor>.<patch>`，例：`v0.1.42`。**不带** `-beta` 之类的后缀（0.x 本身就是预发布语义） |
| 类型 | **annotated**（`git tag -a`），消息写一行中文摘要；轻量 tag 不便于审计 |
| 指向 | tag 必须指向**已经在 `main` 上、且 CI 通过**的那个提交 |
| 一次性 | **一个版本一个 tag，不打两次**；打错了先删除**未推送**的 tag，已推送的不改 |

一次性存档 tag（例如某个时间点的快照标签）允许存在，但**不参与发版**：
不要用它触发镜像构建，也不要把它当版本号读。

### 1.4 CHANGELOG 与 Release Notes

**两者是同一份内容的两个出口**，写法一致，区别只是谁生成：

- **`CHANGELOG.md`（仓库内）**：遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
  每个已发布版本一个小节，分类固定为
  `破坏性变更 / 新增 / 修复 / 性能 / 文档 / 其他`；**最新版本在最上面**。
- **Release Notes（GitHub Release）**：由 release-drafter 从 PR 标签生成草稿
  （`.github/release-drafter.yml` 的分类与模板决定形状），发版前由人**核对并补齐**。

**写法要求（面向使用者，不讲内部排查过程）**：

| 要写 | 不要写 |
| --- | --- |
| 使用者能感知的变化：界面、行为、配置、升级动作 | 内部排查过程、第几轮、谁发现的、日志片段 |
| 「你需要做什么」：改哪个配置、要不要迁移、能不能直接回滚 | 「我研究了很久」「踩了一个坑」 |
| 影响面：只影响新策略 / 影响全部已部署实例 | 未经验证的断言（"应该没问题"） |
| 破坏性变更**单独成节**，给出可照做的步骤 | 把破坏性变更埋在「修复」里 |

> ⚠️ **实测现状（2026-10-17，需要修）**：最新 5 份 Release 正文里**没有一条**
> 自动生成行 —— 正文是人工写的会话记录，含第一人称推理（"我核实过"）、
> 失败尝试（"第一次插错了行"）与轮次编号（"第 48 轮"）。
> 这与"231 条流水账提交"是同一个问题，只是搬到了 Release Notes 里。
> **要求**：Release 正文只保留 ① 这次改了什么（使用者视角）② 升级要做什么 ③ 已知限制；
> 过程叙述留给 `.dsh/` 报告或 PR 描述。

**发布公告模板**（中文、面向使用者，可直接套用）：

```markdown
## vX.Y.Z

一句话说明这一版解决什么问题、给谁带来什么。

### ⚠️ 升级前必读
- （有破坏性变更时写清要做什么；没有则写"无需额外操作，直接升级"）

### 新增
- …（使用者视角的一句描述）

### 修复
- …（症状 → 现在变成什么样）

### 已知限制
- …（这一版**没有**解决的问题，避免使用者误以为已经修好）

### 升级方式
- Docker：`cd deploy && ./up.sh`
- 源码 + systemd：见 `docs/DEPLOYMENT.md`（回滚见本手册「实盘部署闸门」）
```

> **公告里不写**：内部文档路径以外的排查记录、服务器地址、账号信息、
> 未合并的分支或未验证的猜测。发布说明是**对外**的产物。

### 1.5 手动补充 changelog 条目

自动生成的一行 `- fix(risk): … (#123)` 有时不足以说明升级方该做什么 ——
典型情况是"改了默认值""需要动 `deploy/.env`""旧数据要迁移"。

做法：**直接编辑草稿正文**（Releases → Draft → 编辑），在对应分类下补一小节，例如：

```markdown
### 需要你做的事

- 本次升级后 `MAX_LEVERAGE` 的默认值从 20 降为 10。已经显式配置过的策略不受影响。
```

两点必须知道：

- **草稿正文会被下一次 `main` 的构建覆盖。** 手写内容只在"紧接着发布"时能留存下来，
  所以改完就发，不要合了新的 PR 再回头看。
- 需要**每次都带上**的内容（升级命令、风险提示一类）不要写在草稿正文里，
  写进 [`../.github/release-drafter.yml`](../.github/release-drafter.yml) 的 `template` ——
  它每次生成都会被重新带上。

已发布的 release 不会被后续运行改写；下一次合入 `main` 会为**下一个**版本新建草稿。
同时，**把这次发布的内容同步写进 `CHANGELOG.md`**（草稿不是仓库的一部分，会随版本滚走）。

**`CHANGELOG.md` 的执行要求（当前是"声明了制度、但制度没有执行"）**：
实测它只覆盖 `0.1.0`，38 个已发布版本一条未记。本手册的选择是**恢复它**
（而不是废除成"只有 GitHub Releases"），理由：它回答的是"升级的人该做什么"，
与使用者直接相关，而且它在仓库里、不会随版本滚走。规则：

- 每个已发布版本一个小节，分类固定（`破坏性变更 / 新增 / 修复 / 性能 / 文档 / 其他`），
  **最新版本在最上面**；
- **一个小节只写三类内容**：① 需要升级方**动手**的事 ② 破坏性变更 ③ 已知限制；
  其余（新增 / 修复）用一行使用者视角的结论带过；
- **不得照抄 Release Notes 的正文** —— 那会把第一人称推理与轮次编号搬进来（§1.4 的实测）；
- 文件底部的版本链接同步补：`[vX.Y.Z]: https://github.com/<owner>/<repo>/releases/tag/vX.Y.Z`；
- 它**必须写进发版检查清单**（§3.2），否则一个月后又会回到今天的现状。

---

## 2. 阶段性发版判据：什么时候**该**发版，什么时候**不该**

> 用户的要求：「提交-发版看起来都要正常」，以及"应该是可持续进行的"。
> 所以发版不是"攒够了一堆提交"，而是**一个阶段性进展闭环之后的对外交付**。

### 2.1 算（准入条件，全部满足）

- [ ] **至少一个 P0/P1 条目走完闭环**：独立验证通过 + 独立审查通过 + 闭环核验通过
      （[`DEVELOPMENT-WORKFLOW.md`](DEVELOPMENT-WORKFLOW.md) §3.4 的 `CLOSED`）；
- [ ] 该批改动**全量验证通过**：`npm run typecheck`、`npm run lint`、`npm test`、
      `npm run build`、`npm run check:links`、`npm run check:routes` 全绿；
      碰下单路径的另加 `npm run sim`（必要时实盘冒烟，见 §4 检查清单）；
- [ ] **线上回读一致**：`build-info.json` 的 `commitShort` == 本次发布提交；
      `/api/health` 的 `version` == 新版本号；`dryRun` / `tradingDisabled` 符合预期；
- [ ] **版本号对齐（§1.2）**：tag / `package.json` / 线上 `/api/health` 一致，
      **且** `GET /api/system/update` 的 `latestRelease` == 本次 tag（两条口径都要回读）；
      `CHANGELOG.md` 已有对应小节；版本号由**人**核对过 ——
      直推 `main` 的提交拿不到 PR 标签，自动推导只对 PR 路径可信（§1.2）；
- [ ] **发布说明对使用者可读**：分类正确、破坏性变更单独成节、写清升级动作（§1.4）；
- [ ] **没有本发版范围内的未闭环条目**（见 §2.3 台账门禁）。

### 2.2 不算（以下任一情况，不发版）

| 情况 | 为什么不发 |
| --- | --- |
| 纯文档改动（`docs:`） | 使用者拿不到任何行为变化；攒进下一个功能性版本一起发 |
| 纯注释 / 纯格式化 | 同上 |
| 单个 P2 修复 | 没有阶段性进展的意义，等它与同批条目一起闭环 |
| 只改了测试 / 守卫（`test:`） | 只有在"它钉住了本批某个已闭环缺陷"时才随该批一起发 |
| 纯重构 / 纯 CI / 纯 chore（且**没有部署**） | 不产生使用者可感知的变化；攒进下一个功能性版本 |
| 仍有 P0/P1 条目未闭环 | 未过门禁不得发版（§2.3） |
| 验证只到"typecheck 全绿" | 类型正确与"订单会被交易所接受"之间没有关系 |
| 只做了本地验证、没有线上回读 | 无法回答"线上到底在跑哪一版" |
| 线上正处于异常状态（stale 交易循环、崩溃重启、裸仓） | 先把线上稳住，再谈发布 |

### 2.3 台账门禁（硬规则）

发版前逐条检查 `.dsh/ledger/items.md`：

- 本发版范围内的条目**必须**全部 `CLOSED`（三个独立性证据齐全）；
- 若有未闭环条目，只有一个合法出路：**把它们明确排除在本次发版范围外，并写进发布说明的
  「已知限制」**（让使用者知道这一版没修它）；
- **不允许**为了让发版通过而把未闭环条目标成 `CLOSED`，也不允许从台账里删掉它们。

---

## 3. 发版步骤

### 3.0 前提：`main` 是绿的

CI（类型检查 / Lint / 文档链接 / 接口一致性 / 测试 / 构建 / 密钥扫描）必须在 `main` 上通过。
**看 CI 结果一次即可**（PR 页面或 Actions 页面），不要写循环轮询。

> 仓库已开源，分支保护可用（见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md) 的「仓库设置」），
> 但当前并未强制。所以「`main` 是绿的」这一步只能靠人去看；
> 本手册里的任何一步都不依赖分支保护，缺少它不会让发版流程失败 —— 但也不会替你拦住红色。

### 3.1 核对发布说明草稿

打开仓库的 **Releases → Draft**。`release-drafter.yml` 在每次合入 `main` 时都会重算这份草稿。

逐项确认：

- **「破坏性变更」一节是不是空的。** 如果不空，把"要做什么"补成明确的操作步骤，
  而不是只留一行 PR 标题。
- 分类对不对。分错了通常是标签漏打：补上标签后在 Actions 里手动跑一次
  "发布说明草稿"工作流即可重新生成，**不需要**为了刷新说明再合一个 PR。
- 「其他」里有没有本该归类的内容。这里堆得多，说明标签规则需要补。
- 版本号是否是本次应有的增量（见 §1.1），并**与 §2.1 的对齐检查一致**。

### 3.2 发布前检查清单

在**能访问币安的机器**上跑（GitHub 托管 runner 位于币安的限制区域，
所以这几步在 CI 里是被跳过或降级处理的，见 [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml)）。

- [ ] `npm run typecheck`（**不要接管道**，退出码重定向到文件再读，
      见 [`DEVELOPMENT-WORKFLOW.md`](DEVELOPMENT-WORKFLOW.md) §2.1）
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run check:links`（改过文档就必须跑：站内链接断了等于"这份文档不可信"）
- [ ] `npm run check:routes`（改过接口就必须跑）
- [ ] `npm run build`（控制台）
- [ ] `node scripts/generate-notices.mjs` —— 之后 `git diff` 必须为空。
      脚本遇到 copyleft（GPL/AGPL/SSPL…）或无法确认的许可证会**直接失败**：
      许可问题必须在引入依赖的那一刻暴露，一旦以冲突条款分发过就不是改一行配置能解决的了。
      同一个检查在 CI 里也会跑，这里再跑一次是因为"上次跑过"不代表现在的依赖没变。
- [ ] `npm run sim` —— 完整交易生命周期模拟，**不需要密钥、不下单**。
      它覆盖的是"接缝"：保护单是否真的挂上、触发后是否真的记账、风控是否真的在路径上。
- [ ] `npm run verify` —— 用**真实行情**跑通「选币 → 指标 → 提示词 → 解析 → 风控」，
      不需要密钥、不下单；30 秒内给出这条链路是否还通。
- [ ] 本次改了前端 → `npm run ui:smoke`（**必须**先准备 `AQ_BASE` / `AQ_TOKEN` / `AQ_CHROME`
      三个环境变量与一个**真实浏览器**；**它不能在 CI 里跑**）：
      检查渲染、控制台错误、以及 150% 缩放下有无横向滚动。
      编译通过不等于能用（见 [`AGENTS.md`](AGENTS.md) §3.2）。
      ⚠️ 缺环境变量时它会红 —— 那是**环境缺失**，不是代码问题；
      一个因为环境缺失而变红的校验会训练人忽略红色（`npm run sim` 那条已经吃过这个教训）。
      所以要么把前提准备好，要么明确记录"本项未执行及原因"，**不要**把它当成通过。
- [ ] 本次改动是否触及下单路径（`packages/server/src/binance/`、`risk/`、`trader/`，
      以及 `packages/shared/src/strategy.ts` 的风控配置）？
      如果是，**发布前必须做一次实盘冒烟测试**：

      ```bash
      npx tsx packages/server/src/scripts/liveSmokeTest.ts --confirm
      ```

      > ⚠️ **它会真的花钱。** 名义价值硬上限 20 USDT，清理步骤写在 `finally` 里，
      > 结束时回读交易所确认账户干净。**这不是可选项**：模拟证明的是逻辑，
      > 只有这一步能证明接线 —— 本项目确实出现过"类型全过、`npm test` 全绿，
      > 但止损根本没挂上（`-4120`）"的缺陷。
      >
      > 由 AI 成员执行前必须取得队长/用户确认，并说明理由与清理步骤
      > （[`DEVELOPMENT-WORKFLOW.md`](DEVELOPMENT-WORKFLOW.md) §2）。

- [ ] 草稿里「破坏性变更」一节写清了升级方需要做什么（没有破坏性变更则无需此步）
- [ ] `CHANGELOG.md` 已更新（§1.4）
- [ ] `package.json` 的 `version` == 本次发布的 `vX.Y.Z`（§1.2）
- [ ] 如果这次发布涉及开源、许可证或商业化，逐项过一遍
      [`LEGAL.md`](LEGAL.md) 第 6 节的「待办清单」（那里按"现在就做 / 开源前 / 商业化前"分组）

### 3.3 打标签并推送

```bash
git switch main && git pull
git tag -a v0.2.0 -m "v0.2.0：<一行中文摘要>"
git push origin v0.2.0
```

> **为什么明确推送标签，而不是靠"发布草稿时自动创建标签"**：
> 发布草稿确实会创建标签，但它是否触发 `push` 事件属于实现细节 ——
> 而镜像构建正是这条链路上最关键的一步，不能建立在一个需要推断的行为上。
>
> ⚠️ **不要在打标签后一分钟内再连推别的分支**（§4.6 的禁令之一）。

推送 `v*` 标签会触发
[`docker-publish.yml`](../.github/workflows/docker-publish.yml)，它**无条件构建**（不要求先跑 CI），
产出这些镜像标签：

| 触发 | 产出的镜像标签 |
| --- | --- |
| 推送 `v0.2.0` | `ghcr.io/<owner>/<repo>:0.2.0`、`:0.2`、`:sha-<短哈希>` |
| 合入 `main`（CI 通过后） | `ghcr.io/<owner>/<repo>:latest`、`:sha-<短哈希>` |

> ⚠️ **实测修正（旧文档描述的是一条已经被改掉的配置）**：`docker-publish.yml` 里 `latest` 是
> `type=raw,value=latest`（**无条件**），全仓已经没有 `enable={{is_default_branch}}`。
> 所以推 `v*` 标签**也会**产出 `:latest` —— "`latest` 始终由 `main` 维护"这句话**不再成立**。
> 含义：`:latest` 可能在你打标签的那一刻指向新版本，于是"一台机器固定版本、另一台用
> `latest`"的做法更危险（下一节那条注意事项因此是硬要求）。

构建完成后在仓库的 **Packages** 页面确认 `0.2.0` 与 `0.2` 都已出现（**看一次，不轮询**）。

### 3.4 发布草稿

回到 Releases → Draft，点 **Publish release**。草稿的正文就是发布说明，
这一步只是把它从"草稿"变成"已发布"，不会再重新生成内容。

### 3.5 更新服务器

见下一节（Docker 路径），或 §5（源码 + systemd 路径，本项目的线上形态）。

---

## 4. 服务器怎么更新（Docker 部署）

日常升级只有一条命令，`latest` 会拉到刚刚由 `main` 构建出来的镜像：

```bash
cd <部署目录>/deploy && ./up.sh
```

要**固定版本**（典型场景是回滚、或先在一台机器上验证），在 `deploy/.env` 里覆盖镜像地址：

```bash
AUTOQUANT_IMAGE=ghcr.io/<owner>/<repo>:0.2.0
```

`AUTOQUANT_IMAGE` 的优先级高于脚本内置的默认值，改完再跑一次 `./up.sh` 生效。
也可以用环境变量临时覆盖一次（例如切到某个 `sha-<短哈希>` 排查问题）：

```bash
AUTOQUANT_IMAGE=ghcr.io/<owner>/<repo>:sha-1a2b3c4 ./up.sh
```

几条实际会遇到的事：

- **升级前先备份**：`./up.sh backup` 会把数据库与主密钥打包成
  `backup-autoquant-<时间戳>.tar.gz`。回滚镜像不会动数据卷，但**如果那次发布带了
  不可回退的迁移，回滚镜像会读到新的 schema** —— 这是唯一一类备份能救回来的情况。
- **不要在同一台机器上混用 `latest` 与固定版本**：`latest` 会随 `main` 每次构建前移，
  一旦某次发布需要回滚，固定版本的那台机器与另一台会悄悄跑在不同版本上。
- 镜像为公开，无需登录即可拉取。若你复刻成了私有镜像，需先 `docker login ghcr.io`，
  令牌勾选 `read:packages` 即可，做一次之后会自动复用凭据。

---

## 5. 实盘部署闸门（源码 + systemd 路径）

> 本节管的是**正在跑真实资金的那台机器**。它比发版本身更危险：
> 发版只是打标签，**部署会重启交易进程**。
>
> 规则优先级：**先保住仓位与账目，再谈上线新代码。**

### 5.1 先 commit 再 deploy（不是可选项）

`scripts/deploy.ps1` 打包的是**整个工作树**（`tar -C <仓库根> .`），**不是** git 已提交的内容：

- **没 commit 的改动【也会】上线**；
- 而 `build-info.json` 的 `commitShort` 取的是 HEAD，`dirty` 只是个**标记**；
- 症状因此是「**代码是新的、版本号显示旧的**」。

要求「先 commit 再 deploy」的理由是**可追溯**：线上跑的东西必须能用一个提交号指认。
带着未提交改动上线，出问题时无法回答"线上到底是哪一版"。

**顺序固定为：验证 → 提交 → 部署 → 回读。**

### 5.2 部署前检查清单（逐条打勾，任何一条不满足就停）

- [ ] 工作树干净：`git status --porcelain` **输出为空**（有未提交改动就先 commit 或 stash）
- [ ] 本地 HEAD == 你打算上线的提交；`git log -1 --oneline` 与台账里记的提交哈希一致
- [ ] **打包排除项覆盖所有"含站点专属信息的目录"**：`deploy.ps1` 打包的是**整个工作树、
      且不读 `.gitignore`**，它的排除列表是唯一防线。历史上漏掉一个目录就等于把
      含主机别名 / 服务器路径的内容整包传到线上（`.dsh/` 曾被漏掉：`deploy.ps1` 的注释
      记录了这次实测 —— "一天约 10 次部署后累积到 87 个 bundle"）。
      **凡是新增这类目录（`.dsh/`、`.agent-teams/` 等），必须在同一次改动里把它加进排除列表**；
      部署前用 `git check-ignore` 与排除列表**逐目录对照**，别只看 `.gitignore`；
- [ ] 全量验证已过（§3.2 的清单；碰下单路径的含 `npm run sim`）
- [ ] **离线备份包含当前 HEAD**：`.dsh/backups/` 里最近一个 bundle 必须含 HEAD
      （历史教训：备份链断档时，当前线上代码只存在于本地 `.git`，回滚就没有保险）
- [ ] 线上当前无**裸仓**（有仓位但保护单缺失）—— 见 §5.3
- [ ] 线上当前无**正在执行中的手工操作**（手工平仓、对账、手工改配置）
- [ ] 账户与持仓状态已确认（§5.4），且处于允许部署的窗口（§5.3）
- [ ] 本次部署**已知会打断在途决策轮次**：应用侧最多等 3 分钟（`SHUTDOWN_DRAIN_TIMEOUT_MS`），
      systemd 侧 `TimeoutStopSec=210`；**不要在这 3 分钟内重复触发部署**

### 5.3 实盘安全窗口：什么时候允许部署，什么时候必须等

| 状态 | 允许部署？ | 说明 |
| --- | --- | --- |
| 无任何持仓、无活跃挂单 | ✅ 允许 | 最安全的窗口 |
| 有持仓，且每个仓位都有对应的止损保护单 | ✅ 允许（谨慎） | 部署重启不会撤掉交易所侧的挂单；但重启瞬间无人看守，**尽量选在平静时段** |
| **有持仓但缺保护单（裸仓）** | ❌ **必须等** | 先补上保护单或按风控流程平掉；带着裸仓重启是把风险放大 |
| 有待成交的**开仓**挂单 | ❌ 必须等 | 重启后可能出现"订单成交了但进程不知道"的窗口 |
| 有正在执行中的交易轮次（入场已成交、保护单未挂） | ❌ 必须等 | 这正是历史事故里被掐断的窗口（见 `deploy.ps1` 的注释） |
| 熔断 / 回撤守卫处于触发状态、状态不明 | ❌ 必须等 | 先搞清它在做什么，再谈重启 |
| 对账有未解释的差额 | ❌ 必须等 | 部署会让"差异是这次重启造成的吗"无法判断 |
| 有用户在操作控制台（手工平仓等） | ❌ 必须等 | 等操作完成并确认结果 |

**等待期间做什么**：把等待原因、证据与预计恢复时间写进台账与给队长的消息 ——
**不要**因为"等不及"就把闸门放宽，那属于红线（[`AGENTS.md`](AGENTS.md) §4.2）。

### 5.4 部署前怎么确认账户与持仓状态

在**有 SSH 授权**的成员那里，用只读方式回读（不要在这时候下单、不要跑重建类的接口）：

1. 健康：`GET /api/health` —— 记录 `ok` / `dryRun` / `tradingDisabled` / `environment` /
   `runningTraders` / `staleTraders`；
2. 持仓：`GET /api/traders/:id/positions` —— 逐个仓位核对**是否有对应的保护单**
   （止损条件单必须真的挂在交易所侧，不是"本地以为挂着"）；
3. 挂单：`GET /api/traders/:id/orders` —— 区分普通单与 Algo 单，确认没有"开仓单挂着"；
4. 账户：`GET /api/traders/:id/account` —— 余额、保证金使用率是否符合预期；
5. 若对账有疑点：先看 `GET /api/traders/:id/foreign-activity`，
   **不要**在部署前一刻临时跑对账（那会改变状态，让差异归因不清）。

**把回读的原始结果与时间点写进台账**（§3.4 的证据纪律）——
"我看了一下没问题"不算确认。

### 5.5 部署后怎么确认交易循环真的恢复了

**"部署命令返回 0"不等于"服务在跑新版本"，更不等于"新代码没让启动流程失败"。**
按顺序回读：

1. **服务状态**：`systemctl is-active` 为 `active`，且
   `systemctl show <服务名> -p ExecMainStartTimestamp` **是刚刚这一刻**
   （历史事故：进程根本没重启，而 `build-info.json` 已经是新的）；
2. **版本（提交口径）**：`build-info.json` 的 `commitShort` == 本地 HEAD，`dirty=false`；
3. **版本（两个产品口径，见 §1.2）**：`GET /api/health` 的 `version` == 本次版本号，
   **且** `GET /api/system/update` 的 `latestRelease` == 本次 tag（需登录；
   服务端缓存 10 分钟，重启或缓存过期后自然刷新）。
   ⚠️ **只回读第一条不能证明"版本号已对齐"** —— 它只证明线上部署目录的 `package.json`
   与本地一致；
   ⚠️ `/api/health` 能回答版本号的前提是它**在请求路径上不出网**（§1.2 的 A′ = V1）。
   如果部署后它偶发变慢或 503，**先怀疑这条约束被破坏，而不是先怀疑网络** ——
   它同时是唯一被探活的健康端点（每 30 秒打一次、timeout 5 秒、**连续 3 次**才判
   unhealthy）与部署脚本的验证端点（`deploy/up.sh` 阻塞等待、脚本回读）；
4. **健康**：`GET /api/health` 200 且 `ok: true`；`staleTraders` 为空；
   `dryRun` / `tradingDisabled` / `environment` 与预期一致；
5. **决策循环**：等**至少一个完整周期 + 余量**，再看该机器人是否产生了新的决策记录
   （`GET /api/traders/:id/decisions`）—— `last_cycle_at` 前进才算"循环活了"；
6. **账目**：确认没有凭空多出/少掉平仓记录（看 `GET /api/traders/:id/trades` 的尾部）；
7. **日志**：确认没有启动期异常、没有"保护单挂不上""模块不可用"这类静默降级。

**任一条不满足 → 按 §5.6 回滚，而不是"再等等看"。**

### 5.6 回滚判据与步骤

**立即回滚的判据**（命中任意一条）：

- `/api/health` 持续 503，或 `staleTraders` 非空且一个周期内不自愈；
- 服务反复重启 / 进入崩溃循环（`NRestarts` 增长、`activating (auto-restart)`）；
- `build-info.json` 的 `commitShort` 与预期提交不符，或 `dirty=true`；
- 启动日志出现**风控降级、保护单挂不上、模块静默退回**这类信号；
- 任何"可能有订单绕过风控"的迹象 → **最高优先级**，先停交易（用既有的
  `tradingDisabled` / 停止机器人开关），再回滚，并保留日志与数据库快照。

**步骤**（源码 + systemd 路径）：

```powershell
# ① 本地切到上一个已知良好的提交（不要动 data/ 与 .env —— 部署排除列表已含它们）
git switch --detach <上一个良好提交>
# ② 重新部署（会跑 typecheck + 本地 build）
pwsh -File scripts/deploy.ps1
# ③ 回读：commitShort 必须等于 <上一个良好提交>，且健康检查恢复
```

```bash
# Docker 路径则固定镜像版本：
#   AUTOQUANT_IMAGE=ghcr.io/<owner>/<repo>:<上一个版本> ./up.sh
```

**回滚注意事项**：

- **回滚代码不等于回滚数据**。若这次发布带了不可回退的迁移，
  回滚会读到新 schema —— 这种情况**必须有发布前的数据库备份**（§4）。
- 回滚后**在台账里新开一条条目**记录"哪次部署触发了回滚、判据是什么、证据在哪"，
  并把该版本标记为不可再用，直到缺陷闭环。
- 回滚本身也要**走一次 §5.5 的回读**，不要假设"回滚成功了"。

---

## 6. 相关文件

| 文件 | 作用 |
| --- | --- |
| [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) | 每次 PR 与 push main 的验证 |
| [`../.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml) | 构建并推送镜像到 GHCR |
| [`../.github/workflows/release-drafter.yml`](../.github/workflows/release-drafter.yml) | 在每次合入 `main` 时更新发布说明草稿 |
| [`../.github/release-drafter.yml`](../.github/release-drafter.yml) | 分类规则、版本增量规则、发布说明模板 |
| [`../.github/workflows/pr-labeler.yml`](../.github/workflows/pr-labeler.yml) | 打标签（路径 + 标题前缀），草稿分类的依据 |
| [`../.github/labeler.yml`](../.github/labeler.yml) | 路径 → 标签的映射 |
| [`../deploy/up.sh`](../deploy/up.sh) | 服务器上更新与回滚的实际执行者（Docker 路径） |
| [`../scripts/deploy.ps1`](../scripts/deploy.ps1) | 源码 + systemd 路径的部署脚本 |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | 首次部署、反向代理、安全检查清单 |
| [`DEVELOPMENT-WORKFLOW.md`](DEVELOPMENT-WORKFLOW.md) | 提交规范、闭环流程、验证阶梯、协作纪律 |
| [`LEGAL.md`](LEGAL.md) | 许可证、交易所条款、监管风险的逐项说明 |
