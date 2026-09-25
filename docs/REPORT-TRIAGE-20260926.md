# 外部测评报告的核查与修复结论（2026-09-26）

> 输入：一份**项目目录之外**的外部 AI 代码测评报告（858 行，审查基线 commit `0defce8`）。
> 原则：**不盲信**。每一条都回源码复核，报告判错的条目**不改**；纯代码缺陷直接修，功能性/策略性改动一律留给用户决策。
> 全部修复已 `deploy.ps1` 部署到线上并回读 `build-info.json` 验证（scp/ssh，不经过 GitHub）。

---

## 1. 报告本身判错的条目（照它改会改坏）

| 报告条目 | 报告说法 | 实际 |
| --- | --- | --- |
| P1 4.3-① | `maxDrawdown` 的 `peak` 从 0 起爬，1000→800 会报 0% | **假**。`equity.list()` 结尾有 `.reverse()`，曲线是时间正序，窗口内第一条快照会给 `peak` 播种 → 报 20% 正确。真问题只是窗口上限 5000 条 |
| P1 4.6-⑧ | `Retry-After` 若按毫秒会被当成 1/1000 | **假**。消费点 `rest.ts` 是 `retryAfterSeconds * 1000` —— 方向相反（会变成超长等待） |
| P1 4.2-③ | `confidence` 为 `NaN` 时静默放行 | **假**。`toFiniteNumber` 只放行有限数，该路径当前不可达 |
| P1 4.1-⑦ | `promote()` 把 `opened_at` 改晚会**放松** `minHoldMinutes` | **方向写反**。更晚 ⇒ `heldMinutes` 更小 ⇒ 更**严**。真实影响是 `hold_minutes` 失真与 JOIN 失配 |
| P1 4.5-① | `cancelledStarts` 只增不减 ⇒ 永久放弃开机重试 | 事实成立，但**当前不可达**（重试预算只在开机路径，每进程一次、集合初始为空）。真实危害是集合无界增长 |
| P2 15 | `market.ts` 的 klines limit 写成 1500（实测上限 1000） | **假**。1500 是 **fapi** 的上限（现货才是 1000）。唯一影响是 `limit=1500` 时实得 1499 根 |
| 7.5 | 保本/追踪两个参数默认 0 = 关闭 | **部分真**。schema 默认确为 0，但「稳健」预设给了 `breakevenTriggerPercent: 8` —— 真问题是**8% 高到形同虚设**，不是关闭 |
| 7.6 | 兜底 2.5/7.5 恰等 3:1，任何取整都会失败 | **后半句错**。兜底价与盈亏比用同一个 `entryPrice` 基数，比值精确 3.0，而 `+1e-9` 容差正是为「恰好达标必须通过」而加 |
| 7.2 | 「熔断期间空转 134 万 token/小时」 | **旧账**。该段是「熔断+无仓位则跳过本轮」的**改动理由说明**，现状已不空转 |

---

## 2. 已修复（11 个 P0 全部 + 5 条 P1 + 3 条 P2/P3）

### 第一批 · 会凭空造出/抹掉真实盈亏

| 项 | 位置 | 修法 |
| --- | --- | --- |
| **P0-1** | `autoTrader.ts` 持仓消失核对 | `getPositions().catch(() => [])` → 读不到就**整段跳过**（一次网络抖动曾把每个持仓判为"已平仓"） |
| **P0-2** | `emergencyFlatten` | 增加 `executedQty > 0` 校验，未确认就返回 `null`；4 处调用点改为**未确认不记账** |
| **P0-3** | `engine.ts` 第 13 步 | 钳制与 `finalRiskUsd` 改用 `entryPrice`（原来用市价，会静默推翻刚校验过的盈亏比） |
| **P0-4** | `manager.startTrader` + `resumePersisted` | `GLOBAL_TRADING_DISABLED` 判定下沉到生命周期收口，开机恢复不再绕过熔断 |
| **P0-5** | `repositories.openEntryCosts` | 改为按**入场订单号**过滤（原来按 symbol，把同标的历史回合入场费重复计入） |

### 第二批 · 「读不到」被当成「事实成立」（报告 §8 的系统性缺陷）

| 项 | 位置 | 修法 |
| --- | --- | --- |
| **P0-8** | `broker.cancelAllOrders` | 失败**改为抛错**（`-2011` 视为成功）—— 原来永不抛错，导致「撤不掉就不挂新的」是死代码 |
| **P0-10** | `applyBreakevenGuard` | 删掉 `.then(() => true)`（它把撤单失败的 `false` 覆盖成成功） |
| **P0-11** | `expireStalePendingEntries` | 检查返回值，撤不掉**保留本地记录**（原来照样销毁记录，交易所单还挂着） |
| 同形第 3 处 | `executeCancelPending` | 同时接住「抛错」与「静默返回 false」两种失败形态 |

### 第三批 · 可用性与取整

| 项 | 位置 | 修法 |
| --- | --- | --- |
| **P0-7** | `rest.ts` | 校时探针 `skipSlot`：不占并发槽位。原来一次时钟跳变会让 6 个槽位互相等待 → **整个 REST 客户端永久死锁** |
| **P0-6** | `rest.ts` + `broker.ts` | 下单新增 `avoidAmbiguousRetry`：传输错误/5xx **不重发**（一次超时可能变成两张仓单）；`-1021`/429 仍重试 |
| **P0-9** | `broker.ts` 名义下限 | 豁免 `reduceOnly`（币安原文 "unless you choose reduce only"），残仓不再 stranded |

### 第四批 · P1/P2 快修

| 项 | 修法 |
| --- | --- |
| 启动无互斥锁 | `manager.starting` 集合 + `try/finally`：并发 `/start` 不再造出两个实例重复下单 |
| 回执路径缺决策块闸门 | 加 `hasDecisionBlock()`：`<reasoning>` 里回显的范例 JSON 不再被当成真实指令执行 |
| `entryFeeFor` 恒返回 0 | 过滤键 `clientOrderId` → `orderId`（前者在 `userTrades` 响应里**不存在**）；开仓手续费列与爆仓判定因此才第一次可用 |
| `ensureOneWayMode` 吞查询错误 | 读不到挂单时**保守不切换**并返回 warning，避免后续全账户 `-4061` |
| 回撤守卫 `activationPercent = 0` | 视同**关闭**（原来对任何浮亏仓位都 `close: true`） |
| `cancelledStarts` 只增不减 | 启动循环结束时回收该旗标 |
| `/equity` 的 `limit` | 钳到 `[1, 5000]`（SQLite 里 `LIMIT -1` 意为不限行） |
| stdout EPIPE 死循环 | `uncaughtException` 对 EPIPE 特判并退出（本地日志里有 642 条同一条异常为证） |
| `decisions.log()` 每行裁剪 | 改为每 50 次写裁剪一次（原来每行一次全表扫描，压在交易循环的事件循环上） |
| `domain.ts netPnl` 注释 | 符号写反（`- fundingFee` → `+ fundingFee`），会教出第七份错实现 |

---

## 3. 测试

- 新增/修正用例：校时探针不占槽（含**反向验证**：关掉 `skipSlot` 该用例立刻变红）、下单不重发、`openEntryCosts` 口径、`decision_records` 上限。
- 修正了一个**假绿的测试桩**：`FakeBroker.cancelOrder` 原来失败时抛错、成功时返回 `undefined`，与真实 `Promise<boolean>` 契约相反 —— 这正是 P0-10/P0-11 能"通过测试"的原因。现在桩与实现同契约，并新增 `throwOnCancel` 覆盖另一形态。
- 全量：`typecheck` / `lint` / `test`（shared 14 · server 707 · web 50）/ `build` / `sim`（18/18 校验）全部通过。

---

## 4. 等用户决策（**未改动**）

1. **给 LLM 运营成本建账**（报告第 7 章的核心结论）：全系统零 token→钱换算。在成本被度量之前，讨论"策略好不好"缺少依据。
2. `breakevenTriggerPercent` 的取值（「稳健」预设 8% 形同虚设；实测峰值 1.55–2.67%）。
3. 提示词「少做」指令从条件渲染改为常驻。
4. CORS 是否收紧为白名单。
5. `orders.exchange_order_id` 加索引（需要一条新迁移）。
6. 下单取整是否改用 `MARKET_LOT_SIZE`（**会改变下单行为**）。
7. 新增「止损必须比强平价近」与最大止损距离上限（新增风控规则）。
8. 账目告警保留的那条差额口径（差额来自「外部活动」的重建估算，平台侧自身与库内合计一致）。

---

## 5. 已确认但仍未修（可随时继续）

- 部分平仓的 `pnl`/`fee` 两列口径（净额对、毛额与派生统计错）
- `waitForIdle()` 不是真互斥（三条写账路径可并发）
- `reconcilePositions` 的收养路径没有归属闸门
- 归属闸门只取最近 2000 条订单（长期会漏认领）
- 前端缺 ErrorBoundary（渲染期抛错会白屏）
- `docs/API.md`：会话有效期写 12 小时（实现 30 天 + 滑动续期）、缺 5 条已注册端点
- `lint` 只覆盖 `packages/web`；server/shared 约 2 万行零 lint
- `income.ts` 单片 1000 条无溢出续取
