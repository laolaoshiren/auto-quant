# 发现：`ROLES` 里 4 个角色「定义了但生产零调用」

> 状态：**待决策，未修**。这是产品决策（要不要这些岗位），不是 BUG 修复。
>
> 复核日期：2026-10-14（分支 `main`）· 复核方式：脚本扫描全部生产文件（排除 `.test.ts` 与 `roles.ts` 定义处）

---

## 1. 事实（用脚本实测，不是推理）

`packages/server/src/trader/agent/roles.ts` 的 `ROLES` 表里有 **10 个角色**，
其中 **4 个在 149 个生产文件里零调用**：

| 角色 | 中文名 | 生产调用 | 声明它的体系 |
| --- | --- | --- | --- |
| `performance_analyst` | 绩效分析师 | ❌ 零 | 策略审视（`orchestrator.ts`） |
| `attribution_analyst` | 归因分析师 | ❌ 零 | 策略审视（`orchestrator.ts`） |
| `trader` | 交易员 | ❌ 零 | 团队决策（`tradingDesk.ts`） |
| `clerk` | 文员 | ❌ 零 | 团队决策（`tradingDesk.ts`） |

**在跑的 6 个**（对照）：
```
risk_officer      5 处   routedModel.ts
market_analyst    1 处   agent/tradingDesk.ts
strategist        1 处   agent/orchestrator.ts
reviewer          1 处   agent/orchestrator.ts
reporter          1 处   agent/tradingDesk.ts
symbol_scout      1 处   agent/tradingDesk.ts
```

> ⚠️ 我第一版统计脚本把 `roles.ts` 里的**定义**算成了调用，得出"每个角色都有 1–2 处"的
> **错误结论**。修正方式是排除定义文件 —— 见本文末尾的"复核方法"。

---

## 2. 为什么这是个值得处理的问题

这与 `roles.ts:405` 记录过的 `engineer` 角色**完全同类**（原文）：

> **② 生产代码里 0 处调用 `role: 'engineer'`。**
> 它的提示词、`contextFor`、`AgentRole` 类型都在，唯独**没有任何代码会去跑它**。
> 这类缺口最难发现：typecheck 过、测试全绿、界面上也不报错，
> 只是它**永远不会被调用** —— 正是本项目反复强调的"看不出异常的失败"。

**而测试抓不到它**：`roles.test.ts` 的角色清单检查**会覆盖**这 4 个（它们在 `ROLES` 里），
所以"定义了但没人用"不会让任何测试变红。

---

## 3. 逐个判断（按先例纪律：先查"是否已被替代"）

### 3.1 `trader`（交易员）—— 建议**删除**

它的产出格式与**在跑的裁决官（`judge`）完全重叠**：

```
trader（零调用）
  {"proposals":[{"symbol","action":"open_long|open_short",
   "leverage","positionSizeUsd","stopLoss","takeProfit",
   "confidence","reasoning"}], "noTradeReason","summary"}

judge（在跑，tradingDesk.ts）
  [{"symbol":"BTCUSDT","action":"open_long","leverage":3,
    "positionSizeUsd":100,"stopLoss":...,"takeProfit":...}]
```

**同样的字段、同样的语义**。而 `trader` 的 `contextFor: 'decision_review'`
**在整个仓库里只有它自己声明** —— 也就是说那个材料类型从来没有生产者。

**它是单智能体时代的三级流水线（分析师 → 交易员 → 风控）遗留**，
而团队模式用 `supervisor` / `judge` / `bull` / `bear` 替代了它。

⚠️ 证据：提交 `cd381c8`「feat(team): 补上用户需求⑤点名的三个岗位 —— 系统工程师 / 汇报员 / 文员」
那一轮明确给需求⑤补了 3 个岗位，**没有 `trader`** —— 说明当时就已经不认为它需要存在。

### 3.2 `clerk`（文员）—— 建议**先决定"谁消费"再动手**

详见 [`FINDING-clerk-unwired.md`](FINDING-clerk-unwired.md)。核心问题：
它的产出（结构化事实表）**谁读**？若暂时没人读，接一个 LLM 角色就是造第二个空转岗位。
**我倾向用确定性 SQL 实现那张表**（从数据库汇表是代码该干的，不是 LLM）。

### 3.3 `performance_analyst` / `attribution_analyst` —— 建议**接线到策略审视**

这两个是**用户需求⑤明确点名要的**（「分析账户的」），而且它们**属于已经在跑的体系**：

```
orchestrator.ts 的策略审视已经用了 strategist + reviewer
→ 把这两个接进去是【同一个体系内的补全】，不是新建体系
```

它们的产出也有明确用途：
```
performance_analyst → {state, trades, netPnl, grossPnl, fees, feeToGrossRatio,
                       winRatePercent, avgWin, avgLoss, sampleAdequate, caveats}
attribution_analyst → 归因（哪个信号/形态在赚、哪个在亏）
```

⚠️ 而策略师（`strategist`）**现在拿不到结构化的绩效数据** ——
它只能看原始权益曲线。接上这两个会让"它自己诊断参数问题"有据可依
（实测它曾自己诊断出 `promptSections` 全空，见 `strategy.ts` 的记录）。

---

## 4. 建议的处置（按优先级）

| 顺序 | 动作 | 理由 | 风险 |
| --- | --- | --- | --- |
| 1 | `performance_analyst` 接进策略审视 | 用户点名要的岗位，且体系已在跑 | 低（新增一次调用） |
| 2 | `attribution_analyst` 接进策略审视 | 同上，且归因数据已有落点（`intel/attribution.ts`） | 低 |
| 3 | `clerk` 先写确定性查询函数，再决定要不要 LLM | 避免第二个空转岗位 | 中（要先答"谁消费"） |
| 4 | `trader` 删除（或标注"已被 judge 取代"） | 与在跑的 judge 完全重叠 | 低（但它零调用，删了也没行为变化） |

---

## 5. 复核方法（可重复）

```bash
# 在仓库根目录
npx tsx -e "
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES } from './packages/server/src/trader/agent/roles.js';
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) {
  if (n === 'node_modules' || n.startsWith('.')) continue;
  const p = join(d, n);
  if (statSync(p).isDirectory()) walk(p);
  else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) files.push(p);
} };
walk('packages/server/src');
for (const role of Object.keys(ROLES)) {
  let hits = 0;
  for (const f of files) {
    if (f.split(/[\\\\/]/).join('/').endsWith('agent/roles.ts')) continue;  // 定义文件
    hits += (readFileSync(f,'utf8').match(new RegExp(\"role:\\\\s*'\" + role + \"'\" , 'g')) ?? []).length;
  }
  console.log(role.padEnd(22), hits === 0 ? '零调用' : hits + ' 处');
}
"
```

---

## 6. 本文档的局限

- 我**没有**验证"接上 `performance_analyst` 之后策略师的表现会不会变好" ——
  那需要实测（它可能拿到数据后仍然给出同样的结论）。
- 我**没有**统计"策略审视一轮的 token 预算还够不够"接两个新角色 ——
  `orchestrator.ts` 有 `panel`/`single` 两档强度，接之前要确认预算。
- `trader` 是否真的可以删，取决于**是否有外部脚本/文档引用了它** ——
  我只扫了 `packages/` 下的 `.ts`，没有扫 `docs/` 与脚本。
