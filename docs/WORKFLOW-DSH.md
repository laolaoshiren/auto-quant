# DSH 工作流手册：在 auto-quant 上做可持续、可审查、可回滚的迭代

> **本文是"怎么干活"的操作手册**，默认 harness 为 **DSH（DeepSeek Harness）**。
> 规则从哪来：`AGENTS.md`（本地协作与 GitHub 纪律，**不入库**）、`docs/AGENTS.md`
> （工程不变量与验证阶梯）、`docs/DEVELOPMENT-WORKFLOW.md`（闭环流程与台账）。
> 本文只负责**把这些规则落到 DSH 的具体操作上**，不重复它们的内容。
>
> 适用对象：接手本仓库的 AI 代理（单个或多 Agent 团队）与人类开发者。

---

## 0. 一句话版本

**每个迭代 = 一次"发现 → 拆任务 → 并行实现 → 独立验证 → 独立审查 → 闭环 → 提交 →（推送/部署）"的闭环，
所有证据落盘到 `.dsh/`，所有长期规则落进 `docs/`，所有代码改动带测试，站点信息永不入库。**

---

## 1. 四份文档的分工（先搞清谁管什么，避免规则打架）

| 文件 | 内容 | 是否入库 | 谁改 |
| --- | --- | --- | --- |
| `AGENTS.md`（根） | 用户协作偏好：GitHub 纪律、推送规则、实盘测试规范、UI 暂缓、站点信息 | ❌ 本地 | 用户 |
| `docs/AGENTS.md` | 工程不变量（§2）、验证要求（§3）、禁止项（§4）、代码风格（§5）、验证阶梯（§6） | ✅ | 代理/人 |
| `docs/DEVELOPMENT-WORKFLOW.md` | 闭环流程图、缺陷台账、角色与准入/退出条件 | ✅ | 代理/人 |
| **本文** | DSH 工具落地、任务拆分、验证矩阵、节奏 | ✅ | 代理/人 |

冲突时按"更具体、更直接"的顺序：`AGENTS.md` → `docs/AGENTS.md` → 本文 → 其余文档。

---

## 2. 迭代的 9 个阶段

| # | 阶段 | 做什么 | DSH 工具 | 产出 | 退出条件 |
| --- | --- | --- | --- | --- | --- |
| 1 | **发现** | 读症状、代码、日志，形成可指认的现象 | `read` / `grep` / `job_output`（读日志） | 现象 + 证据（文件:行 / 命令+退出码） | 能回答"怎么复现/怎么证明" |
| 2 | **登记** | 写进台账，定 P0–P3、验收标准、写作用域 | `write`（`.dsh/ledger/items.md`） | 台账条目 | 状态 `DEFINED` |
| 3 | **拆任务** | 按写作用域切分，标注依赖 | `team_task_create`（带 `write_scopes` / `blocked_by`） | 任务板条目 | 每条任务可独立完成、范围不重叠 |
| 4 | **分派** | 复杂并行交 Agent Team；单点自己干 | `spawn_teammate` / `send_message` | 运行中的成员 | 每个成员都有明确任务与红线 |
| 5 | **实现** | 改代码 + 加测试（修 bug 必须带"没修就会红"的测试） | `read`/`edit`/`write`；单文件测试用 `npx tsx --test <file>` | 代码 + 测试 | 本地最低门槛（§5 矩阵） |
| 6 | **独立验证** | **≠ 实现者**在指定档位跑验收，记录命令/退出码/输出 | `job_output`（后台跑全量）| 验证证据 | 状态 `VERIFIED` |
| 7 | **独立审查** | **≠ 实现者**逐行读关键 diff + 过红线清单 | `read`/`git diff` | 审查 findings | 状态 `REVIEWED` |
| 8 | **闭环核验** | 回到原点确认现象消失 + 无回归 + 验收标准逐条对照 | 同上 | 闭环证据 | 状态 `CLOSED` |
| 9 | **收尾** | 提交 →（必要时）推送/部署 → 回读线上 | `git`；`pwsh -File scripts/deploy.ps1` | `build-info.json` 回读值 | 线上版本与 HEAD 一致 |

> 人手不足时：**允许一个人兼任多角色，但必须在汇报里明说"我自验了、没有独立验证"**，
> 不能把自验写成"已验证"（`docs/AGENTS.md` §3.2）。

---

## 3. DSH 工具能力速查

### 3.1 什么时候用 Agent Team

| 场景 | 选择 |
| --- | --- |
| 单文件、单点修复（≤1 小时） | 自己干，**不要** spawn |
| 2–4 个独立方向（前端/后端/文档/脚本） | `spawn_teammate`，每个方向一个成员 |
| 大量同质、可枚举的检查（几十个文件逐一审计） | `workflow` 工具（脚本化 fan-out），或 `subagent` 批跑 |
| 需要长时间后台跑（全量测试、构建、部署） | `run_in_background` + `job_output`（**不要忙轮询**） |

### 3.2 任务板（Team Task Board）的正确用法

```
team_task_create
  subject:      一句话说清交付物
  description:  必读文档 + 范围 + 具体项 + 验收标准 + 红线
  write_scopes: 允许改动的路径（advisory，但必须写，冲突靠它避免）
  blocked_by:   必须完成后才能开始的任务 id
```

- **写作用域不重叠**是并行安全的前提。两个成员要改同一文件 → 必须串行（`blocked_by`）或合并成一个任务。
- 成员开工第一步：`team_task_get` → `team_task_update(action=claim, expected_revision=当前 revision)`。
- 完成后 `action=complete`；汇报里带"改了什么（文件:行）/ 发现但未修（证据）/ 验证结果"。
- Lead 不代替成员 complete；Lead 只负责**最终集成与全量验证**。

### 3.3 给 teammate 的任务描述模板（复制用）

```text
工作目录：<路径>（共享工作树，HEAD=<sha>）
第一步：team_task_get 读 <task-id> → claim → 执行。
必读：docs/AGENTS.md（硬约束）、<领域文档>
写范围：<路径列表>（不要改 <排除路径>）
要做的：
1. <具体项 + 证据/文件:行>
2. ...
验收：<命令 + 期望>
红线：不 push/deploy、不碰 .env 与 data、策略性改动先汇报
交付：complete task + 中文汇报（改了什么/未修问题/验证结果）
```

### 3.4 后台任务

- 用 `run_in_background: true` 跑 `npm test` / `npm run sim` / `npm run build`；用 `job_output(wait:true)` 收。
- **不要**在后台任务运行期间重复启动同样的任务（CPU 争抢会让原本的 flaky 更像随机故障）。
- 长任务期间做独立的事（读 diff、写文档），不要 sleep 忙等。

---

## 4. 任务拆分与并行

### 4.1 拆分原则

1. **按写作用域切，不按"功能名词"切**。两个任务争同一个文件 → 合并或串行。
2. **一个任务一个可验收的结论**（"修 X"而不是"整理 Y 区域"）。
3. **依赖显式化**：B 需要 A 的产出 → `blocked_by`，不要让 B 猜。
4. **先低风险后高风险**：先纯搬/删死代码/补测试，再动交易主链路。
5. **交易主链路（`risk/`、`trader/autoTrader.ts`、`binance/broker.ts`）一次只让一个人动**。

### 4.2 本仓库的风险分区

| 区域 | 风险 | 并行建议 |
| --- | --- | --- |
| `packages/web/**` | 低 | 可独立并行 |
| `docs/`、`scripts/`、`.github/`、`.env.example` | 低 | 可独立并行 |
| `store/`、`api/`、`llm/` | 中 | 与 trader 分开 |
| `trader/`、`risk/`、`binance/` | **高**（真实资金） | 串行，且必须跑 `npm run sim` |

---

## 5. 验证矩阵（改什么 → 必跑什么）

| 改动类型 | 最低必跑 | 说明 |
| --- | --- | --- |
| 任意代码 | `npm run typecheck` | 0 退出 |
| 任意代码 | `npm test` | 全绿；记录 `# tests` 数，不写死 |
| 前端 | + `npm run build` | Vite 构建 |
| 前端 | + `npm run lint` | 目前只查 React hooks |
| 路由/接口 | + `npm run check:routes` | 前端声明 ↔ 后端注册 |
| 文档 | + `npm run check:links` | 站内链接 |
| 依赖/打包 | + `node scripts/generate-notices.mjs --check` | 第三方声明 |
| 交易链路 | + `npm run sim`（必须 18/18） | 保护单/记账/权益曲线接缝 |
| 交易链路 | + `npm run verify`（真实行情、不下单） | 选币→指标→提示词→解析→风控 |
| 提示词/模型 | `npm run sim:live`（需 `SIM_LLM_KEY`，花 LLM 钱） | 真实模型输出 |
| 实盘接线 | 服务器 + 子账号 `liveSmokeTest --confirm` | **动真实资金，AI 不自行运行** |

**PowerShell 陷阱**：命令接管道后 `$LASTEXITCODE` 是管道的、不是 npm 的。必须重定向到文件再读退出码。

---

## 6. 提交、推送、部署的节奏

### 6.1 提交

- **一行中文标题**，Conventional Commits 前缀（`fix/trader`、`feat(llm)`、`docs`…）。
- 不写正文、不写过程、不写教训（那些进代码注释或 `.dsh/`）。
- 一个逻辑改动一个 commit；同一迭代多条 commit 是正常的。

### 6.2 推送（按用户 2026-11-09 的规则）

| 迭代规模 | 动作 |
| --- | --- |
| 大的 / 多天的 / 跨多个模块 | 验证全绿后**自己推送一次** |
| 小的 / 单点的 / 当天收尾 | 本地 commit，等用户安排 |

- **不要反复问"要不要推送"**；按上表判断。
- 一次迭代最多一个 PR；`gh` 单次调用、绝不放循环。
- 禁止：`gh pr checks` 轮询、批量 API、自动合并、`git ls-remote` 探测。

### 6.3 部署

1. 本地全绿 → 2. `git commit` → 3. `pwsh -File scripts/deploy.ps1` → 4. 回读线上
`build-info.json` 的 `commitShort` 与 `/api/health`，确认等于本地 HEAD。

---

## 7. 实盘验证（必须遵守）

> 用户指示：**本地模拟盘为主；实盘测试只在服务器上做；只能用子账号。**

1. **本地不跑实盘**：`npm run sim` / `sim:live` 足够覆盖接缝。
2. **服务器**：按本地 `AGENTS.md` 的"实盘测试"一节；站点信息（SSH 别名/域名/IP/白名单）
   **只写本地不入库文件**。
3. **子账号硬约束**：主账户正在跑真实项目，**任何测试不得用它**（不填 key、不跑冒烟、不手工下单）。
4. `liveSmokeTest.ts` 必须 `--confirm`、名义价值 ≤20 USDT、`finally` 清理、结束回读确认账户干净。
5. 7×24 长周期观察在服务器上做，本地不长跑。

---

## 8. 上下文恢复（会话中断/换人接手）

**靠磁盘事实，不靠记忆。** 新会话按顺序：

1. 读 `.dsh/ledger/items.md` —— 哪些条目没关闭、卡在哪一环、谁的活。
2. `git status` / `git log --oneline -20` —— 工作树是否干净、最近提交。
3. 读 `.dsh/` 最近一次验证/侦察报告。
4. 线上回读（有权限时）：`build-info.json` + `/api/health`。
5. 三者与台账不一致 → 写进台账，**不要用"应该是这样"补齐**。

---

## 9. 本仓库实测教训（照着做，别再踩）

| # | 教训 | 规则 |
| --- | --- | --- |
| 1 | 管道后的 `$LASTEXITCODE` 是错的 | 重定向到文件再读退出码 |
| 2 | 全量并行下有时序 flaky | 修根因，不要靠"重跑一次"；用固定时钟复现 |
| 3 | Windows 上临时目录删除失败会盖掉真正断言 | 清理异常只 warn，不改测试结论 |
| 4 | 站点信息容易随手写进文档/注释 | 入库前逐处替换占位符，不依赖脱敏规则 |
| 5 | 死代码清理前必须全仓 grep + tsc `--noUnusedLocals` | 删完跑 typecheck/build/test |
| 6 | 单个超大文件（`autoTrader.ts` 1.3 万行） | 按 `docs/REFACTOR-autoTrader.md` 分阶段拆，不一次大改 |
| 7 | 写了但没接线（`validateStartingBalance`、`assessSignal`） | 新功能必须"生产方式被调用"才算完成 |
| 8 | 金额/手续费只在 `trades.insert()` 一层算 | 不要在调用点各算一遍 |
| 9 | 风控参数绝不为了"跑通"放宽 | 需要放宽 → 产品决策，先说明 |
| 10 | 提交信息写成一页纸会被公开 | 一行标题；过程进 `.dsh/` |
| 11 | 环形缓冲日志会丢观测数据 | 需要跨时间的观测主动落盘 `.jsonl` |
| 12 | CI 的 notices 校验原先不存在 | 已加；改依赖后必须 `--check` |

---

## 10. 每轮开始的 60 秒检查清单

```text
□ git status 干净？HEAD 是什么？
□ .dsh/ledger/items.md 里有没有未闭环条目？
□ 这次迭代属于"大/多天"（可自行推送）还是"小/单点"（等安排）？
□ 任务拆到写作用域不重叠了吗？依赖标了吗？
□ 交易链路是否被碰到？碰到就必须 sim + 独立验证。
□ 有站点信息要写吗？→ 只写本地文件。
```

---

## 11. 相关文档

- [`AGENTS.md`](../AGENTS.md)（本地，不入库）：协作偏好与硬红线
- [`docs/AGENTS.md`](AGENTS.md)：工程不变量、验证要求、代码风格
- [`docs/DEVELOPMENT-WORKFLOW.md`](DEVELOPMENT-WORKFLOW.md)：闭环流程与缺陷台账
- [`docs/DEVELOPMENT.md`](DEVELOPMENT.md)：命令、测试、常见陷阱
- [`docs/REFACTOR-autoTrader.md`](REFACTOR-autoTrader.md)：交易循环拆分的分阶段方案
- [`docs/MODULES.md`](MODULES.md)：改哪个文件
- [`docs/RELEASING.md`](RELEASING.md)：发版流程
