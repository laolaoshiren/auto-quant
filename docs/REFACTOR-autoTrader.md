# `autoTrader.ts` 拆分方案（分阶段执行中）

> 状态：**阶段 1 已完成（2026-11-26）** · **阶段 2 第一批已完成（2026-11-26）**。
> - 阶段 1 的 4 个低风险纯搬模块（`promptBuilders.ts` / `equityRecord.ts` / `paperPositions.ts` / `cycleFailures.ts`）已抽出并保留 `AutoTrader` 门面与全量再导出，行为零变化；
> - 阶段 2 的 3 个核心守卫/结清/对账模块（`mechanicalGuards.ts` / `staleOrders.ts` / `positionReconcile.ts`）已抽出并保留 `AutoTrader` 门面、全部公开导出与结构守卫不变量，行为零变化；`closeBooking.ts` / `tradeHistoryReconcile.ts`（受账本写账点与手续费守卫强绑定）及阶段 3 待后续独立迭代推进。
>
> 目标：让交易主链路在"多人多维度开发"下可读、可审查、少冲突，**且不改变任何行为语义**。

---

## 1. 现状（2026-11-09 实测）

| 指标 | 值 |
| --- | --- |
| `packages/server/src/trader/autoTrader.ts` | **13,738 行 / 110 个方法** |
| 其中 `runCycleBody()` | 3,073–5,487 行，**约 2,414 行**（17.6%） |
| 周期步骤 | 12 步（见 `docs/ARCHITECTURE.md`），顺序与判定是**硬约束**（`docs/AGENTS.md` §2.9） |
| 已有拆分先例 | `cycleSchedule`、`pendingTimeout`、`roundTrips`、`ladderResolve`、`decisionTools` 等辅助模块 |

**为什么是"屎山"而不是"单纯的的大"**：所有交易路径（开仓/平仓/加仓/减仓/调保护/对账/记账/保护单恢复）
都挤在一个类里，改一处要读两千行上下文；多人并行时**任何两个改动都会撞同一个文件**——
这直接违反"写作用域不重叠"的协作前提。

---

## 2. 原则（不可违反）

1. **行为语义零变化**：拆分只做"搬代码 + 薄委托"，不改判定、不改顺序、不改日志文本。
2. **`AutoTrader` 保留为 façade**：`manager.ts`、测试、脚本的构造与调用入口都不变。
3. **一次只拆一个模块**，每个模块一个独立迭代（独立提交、独立验证）。
4. **每阶段门禁**：`typecheck` + `npx tsx --test src/trader/*.test.ts`（全绿）+ `npm run sim`（18/18）。
5. **不拆风控**：`risk/engine.ts` 不在本方案范围内（它是独立且已被测试钉住的地基）。

---

## 3. 阶段划分

### 阶段 1：低风险纯搬（预计 −1,100 行）

| 模块 | 搬什么 | 约行数 | 风险 |
| --- | --- | --- | --- |
| `trader/promptBuilders.ts` | `buildPromptMemory/Lessons/Rejections`、`countIdleCycles`、`buildPromptPositions`、`toPositionView` | ~630 | 低（纯读 + 拼字符串） |
| `trader/equityRecord.ts` | 权益快照记录与曲线口径 | ~250 | 低 |
| `trader/paperPositions.ts` | `effectivePositions`、`settleDryRunPositions`、`rememberMarkPrices`/`paperMarkPrices` | ~240 | 低（模拟盘专用） |

**验收**：仅移动代码 + 参数化依赖（把 `this.deps` 作为入参传入），无逻辑改动；
`autoTrader.test.ts` 全绿；`sim` 18/18。

### 阶段 2：中风险（预计 −3,500 行）

| 模块 | 搬什么 | 约行数 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| `trader/positionReconcile.ts` | 持仓对账、缺失保护单巡检恢复、消失持仓归因（`reconcilePositions` / `ensureStopsOnOpenPositions` / `bookVanishedPosition` / `detectCloseReason` / `reasonFromPrice` / `lastFillFor` / `fallbackStopPrice`） | ~560 | 中（会写持仓与触发记账委托） | ✅ 已完成（2026-11-26） |
| `trader/staleOrders.ts` | 陈旧挂单结清与终态判定（`settleStaleOrders` / `finalStatusOf` / `ORDER_SETTLE_GRACE_MS`） | ~340 | 中 | ✅ 已完成（2026-11-26） |
| `trader/mechanicalGuards.ts` | 实时守卫、回撤守卫、论点硬检查、保本/移动止损（`runGuardTick` / `applyDrawdownGuard` / `applyThesisHardGuard` / `applyBreakevenGuard` / `tightenStop` / `isStopTighter`） | ~650 | 中（依赖注入） | ✅ 已完成（2026-11-26） |
| `trader/closeBooking.ts` | 平仓记账核心 | ~900 | 中（金额算术，受 `closeBookingGuard` / `closeBookingLedger` 强绑定） | ⏳ 待后续独立迭代 |
| `trader/tradeHistoryReconcile.ts` | 成交历史重建（`/fapi/v1/userTrades`） | ~1,270 | 中（归属闸门与写账点守卫强绑定） | ⏳ 待后续独立迭代 |

**验收**：每搬一个模块前先确认它的测试存在且钉住原行为；对账/记账的测试必须全绿；
`sim` 18/18。**不允许**在搬的同时改行为。

### 阶段 3：高风险，单独 PR + 更严门禁（预计 −2,900 行）

| 模块 | 搬什么 | 约行数 | 风险 |
| --- | --- | --- | --- |
| `trader/protection.ts` | `place/replace/restore`、`flattenAndBook`、`hasLiveStop`、`emergencyFlatten` | ~400 | **高**（§2.6/§2.7 集中点：每笔开仓必须有交易所侧保护） |
| `trader/orderFlow.ts` | `executeOpen/Close/Add/Reduce/Adjust`、限价入场、手工平仓 | ~2,500 | **高**（真实下单路径） |

最后把 `runCycleBody()` 按 12 步拆成 `CycleRunner` 的私有方法 ——
**顺序与判定一律不动**（§2.9），只做函数切分。

**额外门禁**：
- 独立验证者 ≠ 实现者；
- 服务器上用**子账号**做一次实盘冒烟（`liveSmokeTest --confirm`）；
- 回读线上 `build-info.json` 与 `/api/health`。

---

## 4. 测试策略

1. **拆分前先建基线**：记录当前 `npx tsx --test src/trader/*.test.ts` 的用例数与全绿状态。
2. **搬代码不改测试**：若拆完某测试要改才能过，说明行为变了 → 停，回退。
3. **新增"结构守卫"测试**（本仓已有先例，如 `staleOrderSettle.test.ts` 扫描源码字段）：
   - `runCycle` 的 12 步顺序不可变；
   - `ACTION_PRIORITY` 不可变；
   - 保护单必须在开仓后挂上（契约测试已有）。
4. **每阶段结束跑 `npm run sim`**：它抓的是接缝（保护单、记账、权益曲线），不是单元逻辑。

---

## 5. 为什么不一次大拆

- 13,738 行的单文件、真实资金、12 步周期：一次大拆的 diff 无法被人工审查，
  而本仓库的纪律是"**验证不了就别声称改好了**"；
- 拆分本身不产生功能价值，它的价值是**降低后续迭代的边际成本** ——
  所以应该以最小风险、最高频次（每次一个模块）推进；
- 一次大拆若引入回归，定位成本远高于分阶段。

---

## 6. 执行清单（每个阶段复制一份）

```text
□ 该模块的现有测试覆盖是否足够？不够先补测试（不改行为）。
□ 记录拆分前基线：用例数 / 全绿 / sim 18/18。
□ 搬代码：只移动 + 依赖注入，不改判定/顺序/文本。
□ typecheck 0 + 该模块相关测试 + src/trader/*.test.ts 全绿。
□ npm run sim 18/18。
□ 独立验证（≠ 实现者）。
□ commit（一行标题）。
□ 更新 docs/MODULES.md 的文件表（新增模块 + 谁调用它）。
```
