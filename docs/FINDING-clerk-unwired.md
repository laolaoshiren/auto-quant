# 发现：`clerk`（文员）是「定义了但从未被调用」的第二个 `engineer`

> 状态：**待决策，未修**。这是一条**产品决策**（要不要这个岗位、以什么形式存在），
> 不是 BUG 修复 —— 所以没有擅自改代码。
>
> 侦察日期：2026-10-14 · 分支：`feat/ai-firm`

---

## 1. 现象

`clerk`（文员）在**三个声明层里都存在**，唯独生产代码从不调用它：

| 层 | 文件:行 | 内容 |
| --- | --- | --- |
| 组织架构 | `packages/shared/src/firm.ts:306` | `id: 'clerk'`，`label: '文员'`，`status: 'planned'` |
| 提示词 | `packages/server/src/trader/agent/roles.ts:518` | 完整 system prompt（含输出 JSON 契约） |
| 模型档位 | `packages/server/src/trader/routedModel.ts:110,319` | `tier: 'T1_fast'`、`maxTokens: 1024` |

**生产代码 0 处调用**（实测 grep，排除测试与定义处）：
```
packages/server/src/trader/routedModel.ts:110   ← 档位表
packages/server/src/trader/routedModel.ts:319   ← token 预算
packages/server/src/trader/agent/roles.ts:518   ← prompt 定义
packages/shared/src/firm.ts:306                 ← 组织架构声明
→ 没有任何 `safeAsk({ role: 'clerk', ... })`
```

### 为什么测试没抓到它

`roles.test.ts` 的角色清单检查**会覆盖它**（它在 `ROLES` 里），所以"定义了但没人用"
不会让任何测试变红。**这正是本项目反复强调的那类缺口**：`typecheck` 过、测试全绿、
界面不报错 —— 只是它永远不会被调用。

---

## 2. 这与 `engineer` 是同一类问题（有先例）

`roles.ts:405-414` 已经记录过一次完全相同的处置：

> **② 生产代码里 0 处调用 `role: 'engineer'`。**
> 它的提示词、`contextFor`、`AgentRole` 类型都在，唯独**没有任何代码会去跑它**。
> 这类缺口最难发现：typecheck 过、测试全绿、界面上也不报错，
> 只是它**永远不会被调用** —— 正是本项目反复强调的"看不出异常的失败"。

`engineer` 的结局是**被删除**（不是被接线），原因是「自检早就把这件事做得更完整了」。

### 先例留下的纪律（`roles.ts:429-432`）

> 加角色前先查组织架构层（`FIRM_ROLES` → `ROLE_TIERS` → 实现层 grep 角色 id）。
> 三处**任意一处命中**，都不该新建角色，而该去接线或补全已有的那个。

`clerk` 三处都命中 —— 所以问题不是"要不要新建"，而是"**接线还是删除**"。

---

## 3. 关键判断：它的职责可能已由确定性代码承担

`clerk` 的 prompt 说它要解决的问题是：

> 「这个信号在过去 20 轮里被引用了几次？引用之后的结果如何？」

而 **这个问题的答案已经存在**，在 `packages/server/src/trader/intel/` 里：

| 文件 | 做什么 |
| --- | --- |
| `attribution.ts` | 把「情报 → 决策 → 成交」这条链记下来（`signalKey` → `returnPct`） |
| `signalHealth.ts` | 用归因数据算失效检测（胜率崩塌 / 连续亏损 / 反应衰减） |

⚠️ **`attribution.ts` 是确定性代码**：它直接读数据库、直接算。
而 `clerk` 是一个 **LLM 角色**（T1_fast）—— 让它去"整理"这些事实，
等于**用一个概率性的东西去替换一个确定性的查询**，还要付 token 成本。

**这是反对接线的核心论据。**

---

## 4. 但 `clerk` 覆盖的范围确实更宽

`attribution` 只记 **signal → trade 一条链**；而 `clerk` 的 prompt 声明覆盖**五类**：

| 类别 | 结构化落点 | 已被使用？ |
| --- | --- | --- |
| 决策 | `repositories.ts` 的 `decisions`（:3534） | ✅ |
| 成交 | `repositories.ts` 的 `trades`（:2235） | ✅ |
| 事件 | `repositories.ts` 的 `tradeEvents`（:3909） | ✅ |
| 实验 | `agentStore.ts`（:252 附近） | ✅ |
| 情报 | `intel/`（内存 + `agentStore`） | ✅ |

**五类都有落点，但没有任何代码把它们汇成一张跨来源的表。**

所以缺口是真实的 —— 只是**正解可能是"写一个查询函数"，而不是"接一个 LLM 角色"**。

---

## 5. 三个可选方案（待决策）

### 方案 A：按 `engineer` 先例处理 —— **删除 `clerk`**
- 与先例一致；
- 理由：职责已由 `attribution.ts` + `signalHealth.ts` 以更可靠的方式承担。
- ⚠️ 代价：用户需求 ⑤ **点名要"文员"**，删掉它需要向用户解释清楚"为什么不需要"。

### 方案 B：**用确定性代码实现**「跨来源事实表」，然后把 `clerk` 改成它的调用方
- 新建 `trader/intel/factSheet.ts`：一个 SQL 查询函数，产出 `entries[]` 结构；
- `clerk` 的 prompt 保留，但**只用于"把查询结果写成自然语言"**（若确实需要）；
- 或者干脆不接 LLM —— 直接把表给下游程序用。
- ✅ 这是最符合"不重复造轮子"与"确定性优先"的做法。

### 方案 C：**按原样接线**（让 LLM 真的去做跨来源整理）
- 最贴合 prompt 的原意；
- ⚠️ 风险：LLM 整理数据库事实 = 引入幻觉；而且下游要有真正的消费者，
  否则就是第二个"空转的 `engineer`"。

### 决策前必须先回答的问题

> **谁消费这张表？** 如果答案是"暂时没人"，那么三个方案里只有 A 和 B 是诚实的
> —— C 会造出一个"看起来在干活、实际没人读"的岗位。

---

## 6. 本文档的局限

- 我**没有**验证 `agentStore.ts` 里实验/情报的具体形状（只确认了它是落点）。
- 我**没有**统计"跨来源查询"在现有代码里的实际出现次数 ——
  如果它一次都没出现过，那么缺口是**理论上的**，方案 B 的优先级应该降低。
- 上面的方案 A/B/C 是**建议**，不是结论。需要用户或维护者拍板。
