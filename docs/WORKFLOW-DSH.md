# AI 协作工作流手册：在 auto-quant 上做可持续、可审查、可回滚的迭代

> **本文是"怎么干活"的操作手册**（2026-11-26 升级适配 **Antigravity + `/swarm` + 内置浏览器 + 自动增量部署**）。
> 规则来源：`AGENTS.md`（本地协作与 GitHub 纪律，**不入库**）、`docs/AGENTS.md`（工程不变量与验证阶梯）、`docs/DEVELOPMENT-WORKFLOW.md`（闭环流程与台账）。
>
> 适用对象：接手本仓库的 AI 代理（单代理或 `/swarm` 多代理团队）与人类开发者。

---

## 0. 一句话版本

**每个迭代 = 「发现/定标 → 并行实现或单点直修 → 全量门禁验收 → 独立审查（复杂改动） → 更新精简 `state.md` → 提交 → 增量部署并回读线上 → 自动单次推送备份」，站点信息永不入库。**

---

## 1. 四份文档的分工（避免规则打架）

| 文件 | 内容 | 是否入库 | 谁改 |
| --- | --- | --- | --- |
| `AGENTS.md`（根） | 用户协作偏好：GitHub 纪律、推送规则、实盘规范、站点信息 | ❌ 本地 | 用户 / AI 提炼 |
| `docs/AGENTS.md` | 工程不变量（§2）、验证要求（§3）、禁止项（§4）、代码风格（§5）、验证阶梯（§6） | ✅ | 代理 / 人 |
| `docs/PROJECT-GOALS.md` | 长期目标、优先级、明确不做/暂缓项 | ✅ | 用户拍板，AI 同步 |
| **本文** | 协作工具落地、并行切分、验证矩阵、部署与推送节奏 | ✅ | 代理 / 人 |

冲突时按「更具体、更近期」顺序：`AGENTS.md` → `docs/PROJECT-GOALS.md` → `docs/AGENTS.md` → 本文。

---

## 2. 协作形态选择（什么时候单干，什么时候 `/swarm`）

| 场景 | 推荐形态 | 关键规则 |
|---|---|---|
| 单点 Bug 修复、单模块小改动（1–3 文件） | 单代理直接完成 | 改完跑对应门禁，不额外开子代理空耗 |
| UI 改动与线上页面巡检 | 内置 `browser` 子代理 | 直连目标页交互与深/浅主题核验（已废止旧 `playwright-core` 脚本） |
| 跨多模块大清理 / 大重构（用户触发 `/swarm`） | **`/swarm` 隔离工作树并行** | 每位作者用 `workspace:"share"`、写作用域零重叠 + 配 1 名只读 `verifier` 审查 + 1 名 `integrator` 主线合入回归 |
| 跨多目录只读深度排查 | `research` 只读子代理 | 不改文件，只回传带行号证据的报告 |

### `/swarm` 并行铁律
1. **写作用域按文件切分，设计阶段消灭冲突**：严禁两名作者同时改同一个大文件核心段；
2. **先合入、再清理**：所有 `workspace:"share"` 作者必须在隔离分支 `git commit`，经 `verifier` 独立复测通过并由 `integrator` 合并进 `main` 跑完集成回归后，才能 `kill` 回收工作树；
3. **验证与实现分离**：`verifier` 只审查和跑测试、不直接改业务代码，发现缺陷 `@作者名` 打回修完复验。

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

**Windows PowerShell 5.1 必避三坑**：
1. 不支持 `&&` / `||`，链式命令必须写 `; if ($LASTEXITCODE -eq 0) { ... }`；
2. 调 npm/npx 用 `npm.cmd` / `npx.cmd`（绕开 `.ps1` 执行策略）；
3. 管道后的 `$LASTEXITCODE` 是管道右侧的，必须重定向到文件再读退出码；复杂远端 shell 统一 base64 编码后通过 `ssh <alias> "echo <b64> | base64 -d | bash"` 执行。

---

## 6. 提交、推送、部署的节奏

### 6.1 提交

- **一行清晰标题**，Conventional Commits 前缀（`fix(trader): ...`、`feat(managed): ...`、`refactor(cleanup): ...`）。
- 不写站点信息、不写冗余过程日志（那些进 `.dsh/`）。

### 6.2 推送（2026-11-26 更新）

| 改动类型 | 动作 |
| --- | --- |
| **正常完整的功能改动 / Bug 修复** | 本地验证全绿 + `git commit`（及按需部署验证）后**自动单次 `git push origin main`** |
| **特别小的、预期还要多次协商微调的短期改动** | 先本地 `commit` 暂存，定稿后再合推一次 |

- **严守防风控红线**：低频单次 push、禁用 `gh` 轮询/批处理/自动合并、不做 `git ls-remote` 探测。

### 6.3 部署（自动增量极速模式）

1. 本地门禁全绿 → 2. `git commit`（工作树干净）→ 3. `pwsh -File scripts/deploy.ps1`（自动对比远端 `build-info.json` 走 `git diff` 增量包，纯后端改动自动跳过 `vite build` 与 `dist` 传输，智能 1s 健康轮询，结束自动清理本地 `build-info.json`；需强制全量加 `-Full`）→ 4. 回读线上 `build-info.json` 的 `commitShort` 与 `/api/health`，确认等于本地 HEAD。

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

## 8. 记忆骨架：上下文恢复（会话中断 / 换窗口 / 换人）

**靠磁盘事实，不靠记忆。** 三层记忆 + 一个入口：

| 层 | 文件 | 入库 | 更新频率 |
| --- | --- | --- | --- |
| 长期·目标 | `docs/PROJECT-GOALS.md` | ✅ | 很少（用户拍板） |
| 长期·决策 | `docs/decisions/ADR-*.md` | ✅ | 每次重大决策 |
| 中期·状态 | `.dsh/state.md`（严控 ≤ 100 行，超长先归档） | ❌ | **每轮收尾** |
| 中期·任务 | `.dsh/ledger/OPEN.md`（完整历史见 `.dsh/archive/legacy-2026-11/缺陷台账.md`） | ❌ | 每次任务变化 |
| 中期·教训 | `.dsh/ENGINEERING-LESSONS.md` | ❌ | 遇到新教训 |

**入口**：`.dsh/START-HERE.md`（新会话先读它：60 秒协议 + 指针表）。

**开场（每次会话，约 60 秒）**：

1. 读 `docs/PROJECT-GOALS.md` —— 目标、优先级、明确不做的事；
2. 读 `.dsh/state.md` —— 做到哪、下一步、卡点；
3. 读 `.dsh/ledger/OPEN.md` —— 未闭环任务；
4. `git status` / `git log --oneline -10` —— 磁盘事实；
5. 不一致 → 先写进 state，再动手；**不要用"应该是这样"补齐**。

**收尾（每轮）**：更新 `state.md` → 推进台账 → 重要决定写 ADR → `commit`。
**没更新 state 的迭代 = 没做完。**

**每周对账**：读 GOALS + state + 最近 7 天 `git log --stat`，输出「目标偏差报告」（不自动改代码）。
提示词模板见 `.dsh/START-HERE.md` §3。

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
□ 读 docs/PROJECT-GOALS.md（目标/优先级有没有变？）
□ 读 .dsh/state.md（上次做到哪、下一步、卡点）
□ git status 干净？HEAD 是什么？
□ .dsh/ledger/OPEN.md 里有没有未闭环条目？
□ 本次属于正常完整改动（验证后自动单次 push）还是短期微调暂存？
□ 并行改动是否切分到写作用域不重叠？
□ 交易链路是否被碰到？碰到就必须 sim（18/18）+ 独立验证。
□ 有站点信息要写吗？→ 只写本地不入库文件。
□ 收尾时更新 .dsh/state.md（保持 ≤ 100 行）了吗？（没更新 = 没做完）
```

---

## 11. 相关文档

- [`AGENTS.md`](../AGENTS.md)（本地，不入库）：协作偏好与硬红线
- [`docs/PROJECT-GOALS.md`](PROJECT-GOALS.md)：**项目目标与优先级（北极星）**
- [`docs/decisions/`](decisions/README.md)：重要决策记录（ADR）
- [`docs/AGENTS.md`](AGENTS.md)：工程不变量、验证要求、代码风格
- [`docs/DEVELOPMENT-WORKFLOW.md`](DEVELOPMENT-WORKFLOW.md)：闭环流程与缺陷台账
- [`docs/DEVELOPMENT.md`](DEVELOPMENT.md)：命令、测试、常见陷阱
- [`docs/REFACTOR-autoTrader.md`](REFACTOR-autoTrader.md)：交易循环拆分的分阶段方案
- [`docs/MODULES.md`](MODULES.md)：改哪个文件
- [`docs/RELEASING.md`](RELEASING.md)：发版流程
