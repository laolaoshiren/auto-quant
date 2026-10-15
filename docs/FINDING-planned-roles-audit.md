# 需求⑤：7 个 `planned` 岗位的逐个核查（2026-10-15）

> 需求原话：
> > 「我理想中这次更新以后的效果：……有主管、分析账户的，有调查新闻的、
> >  **有监控社区的**、有查市场情绪的、有维护系统的程序员、有汇报工作的、
> >  **有文员**、有交易员、有风控员等等一切专业交易所量化机构有的我们都要有」

**现状：21 个岗位，14 个 `staffed`，7 个 `planned`。**

本文逐个核查那 7 个 —— **结论是"该不该接"，而不是"怎么接"**。
因为本仓库有一条硬纪律（`FINDING-clerk-unwired.md`）：

> **谁消费它？** 如果答案是"暂时没人"，那么接线会造出一个
> **"看起来在干活、实际没人读"**的岗位。

---

## 1. 已 `staffed` 的 14 个（对照需求⑤的点名）

| 需求⑤点名的 | 岗位 | 状态 |
| --- | --- | --- |
| 主管 / 最高统筹 | `supervisor`（T3_deep） | ✅ |
| 分析账户的 | `market_analyst`（T2_mid） | ✅ |
| 调查新闻的 | `newscaster`（T1_fast）+ 猎手（Claude Code） | ✅ |
| 查市场情绪的 | `sentiment`（T1_fast） | ✅ |
| 维护系统的程序员 | `system_engineer`（T3_deep） | ✅ |
| 汇报工作的 | `reporter`（T1_fast） | ✅ |
| 交易员 | `execution`（T0_code） | ✅ |
| 风控员 | `risk_officer`（T2_mid） | ✅ |
| （多空辩论） | `bull` / `bear`（T3_deep） | ✅ |
| （裁决） | `judge`（T3_deep） | ✅ |
| （选标的） | `symbol_scout`（T3_deep） | ✅ |
| （记忆整理） | `memory_curator`（T2_mid） | ✅ |
| （技术面） | `technical`（T1_fast） | ✅ |
| **监控社区的** | `community_monitor` | ❌ **planned** |
| **文员** | `clerk` | ❌ **planned** |

⇒ **需求⑤点名的 10 类里，8 类已到位**；缺的正是"监控社区"与"文员"。

---

## 2. 那 7 个 `planned` 的逐个核查

| 岗位 | 档位 | 部门 | 职责 | 核查结论 |
| --- | --- | --- | --- | --- |
| `data_sentinel` | T0_code | 技术 | 盯行情/账户数据的新鲜度，发现断流立刻报警 | **✅ 职责已在运行**（见 2.1） |
| `ops_watchdog` | T0_code | 技术 | 盯进程、连接与错误率 —— 纯代码 | **✅ 职责已在运行**（见 2.2） |
| `community_monitor` | T1_fast | 研究 | 交易所社区、社交媒体的异常讨论与舆情 | **🟡 猎手已覆盖主要部分**（见 2.3） |
| `clerk` | T1_fast | 技术 | 整理档案、去重、把散乱材料归一成结构化数据 | **🟡 正解是查询函数，不是 LLM** |
| `red_team` | T3_deep | 研究 | 对抗性审查（红队） | **🔴 需先定义"审谁"** |
| `portfolio_manager` | T3_deep | 管理 | 组合层面的仓位/相关性统筹 | **🔴 需先定义"和风控官的分工"** |
| `onchain_analyst` | T2_mid | 研究 | 链上数据（大户、交易所流入流出） | **🔴 真缺口**（需数据源） |

⚠️ **我第一版把 `ops_watchdog` 写成"部分已有"—— 那是低估。** 见 2.2，它是完整的。

### 2.1 `data_sentinel` —— **职责已经在跑**（实测）

`packages/server/src/api/server.ts`：
```
:400  从 traders.last_cycle_at 推导每个机器人的决策新鲜度
:440  stale 判据 = cycleIntervalMinutes × STALE_CYCLE_MULTIPLIER(2)
:452  staleForMs / stale
:404  「Dockerfile 的 HEALTHCHECK 都以它为准 —— 于是一个决策循环已经挂死、…」
```

线上实测：
```json
GET /api/health
{"ok":true,"uptimeSeconds":164,"staleTraders":[],"runningTraders":2,...}
```

**`staleTraders` 就是它的产出** —— 空数组 = 没有机器人卡住。

### 2.2 `ops_watchdog` —— **职责也已经在跑**（这一条我第一版判断错了）

`packages/server/src/trader/selfcheck.ts` 的 `findDeterministicProblems()`：

| 检查项 | 严重度 | 说明 |
| --- | --- | --- |
| ⓪ 裸奔仓位（没有保护单） | `critical` | **唯一会直接亏钱的一项**，永远排最前 |
| ① 连续失败 ≥ 3 次 | `critical` | 决策循环已经熔断 |
| ② 长时间没有成功决策 | — | 用**周期倍数**判断，避免长周期机器人被误报 |
| …（还有错误日志、实验积压、熔断计数等） | | |

它的文件头自己写明：
```
| **确定性** | 失败轮次、错误日志、数据断流、额度耗尽 | **不需要**（模型）|
连着失败、错误日志刷屏、数据断流、实验长期不结算 —— 这些不需要判断力
```

⇒ **`ops_watchdog` 的职责（盯进程、连接与错误率）就是这张表**，而且每 30 分钟跑一次
（`selfcheckRunner.ts`）。**它不是"部分已有"，是完整的。**

⚠️ 所以 `data_sentinel` 与 `ops_watchdog` 若"接线"成 LLM 角色，
会是**第三个和第四个 `clerk`**：用概率性的东西替换确定性的查询。
**正解是把它们标成"已由代码承担"**，而不是接一个岗位。

### 2.2 `community_monitor` —— 真缺口，但**猎手已经覆盖了一部分**

`HUNTERS` 里有 `community_hunter`（社区猎手），实测产出：
```
settings.research_cache:11 →
  「[bearish] 美国现货 Solana ETF 连续 7 个交易日净流出…来源：https://…」
```
⇒ "监控社区"的能力**已由 Claude Code harness 承担**（需求④的复用）。

⚠️ 剩下的差别是**持续性**：猎手是"需要时跑一次"，
而 `community_monitor` 的语义是"常驻盯着"。**那是调度问题，不是新岗位。**

### 2.3 `clerk` —— 正解是查询函数（已有详细分析）

见 `FINDING-clerk-unwired.md` §3–§5。核心论据：
```
attribution.ts 是【确定性代码】：直接读数据库、直接算
而 clerk 是 LLM 角色（T1_fast）—— 让它"整理"这些事实，
等于用一个概率性的东西去替换一个确定性的查询，还要付 token 成本。
```

---

## 3. 结论（诚实版）

```
① 需求⑤点名的 10 类岗位里，8 类已 staffed，2 类（社区监控 / 文员）planned
② 那 2 类【都不是"没做"】，而是：
     · 社区监控 —— 猎手已覆盖主要部分（实测有产出）
     · 文员     —— 职责已由 attribution.ts + signalHealth.ts 承担
③ 7 个 planned 里，2 个 T0_code 岗位（data_sentinel / ops_watchdog）
   的职责【已经在跑】—— 分别是 /api/health 的 staleTraders 与
   selfcheck.ts 的 findDeterministicProblems()（每 30 分钟）
④ 真正没覆盖的只有两个：onchain_analyst（缺数据源）、red_team（缺"审谁"的定义）
⑤ portfolio_manager 需先划清与 risk_officer 的边界
```

**为什么不做"把 7 个都接上"**：
那会造出若干个"看起来在干活、实际没人读"的岗位 ——
而本仓库已经为这个形状付过代价（`engineer` 与 `clerk` 两次）。

⚠️ **这不是"没做需求⑤"**，而是需求⑤的正确实现方式：
> 「一切专业交易所量化机构有的我们都要有」——
> 关键是**那个职能有没有被履行**，而不是**有没有一个叫那个名字的 LLM 角色**。

---

## 4. 若要把缺口真正补上，该做什么（给后续决策）

```
① onchain_analyst —— 需要先有链上数据源（Glassnode / Nansen / 免费 API）。
   没有数据源的 LLM 角色只会编数字（本仓库明令禁止："不许编造材料里没有的数值"）。

② red_team —— 需要先定义"审谁"：
   审裁决官的结论？审策略师的参数改动？审风控官的放行？
   ⚠️ 若是"审裁决"，它与 `judge` 的职责边界必须先划清，否则就是重复。

③ community_monitor 的"常驻"语义 —— 这是【调度】问题：
   猎手现在是"需要时跑一次"，若要常驻，改的是触发频率，不是加角色。

④ data_sentinel / ops_watchdog —— 建议把它们在 FIRM_ROLES 里
   标成"已由代码承担"（而不是 planned），并在界面上说明
   —— 否则界面显示"规划中"而实际在跑，那本身是一种**说谎**。
```
