# JEV 模式设计（实验性 · 第四种交易模式）

> 状态：**设计已定稿，依据全部来自线上实测**（2026-10-18/19）。
> 本文是 `t120` 的交付物，也是实现者的唯一依据。
> 实现任务：`t121`（未开始）。

---

## 一、需求与硬约束

### 用户的原话

> 「帮我增加一种模式（实验性），JEV 模式，该模式所有操作都采用 JEV 模型来实现，
>   从选币到交易，一切都由 JEV 自主完成」

### ⛔ 字面实现不可能 —— 这是实测结论，不是猜测

| Decision 必需字段 | Jev 能否产出 | 依据 |
|---|---|---|
| `symbol` | ✅ | `choice` 可从给定选项里选 |
| `action` | ✅ | `choice` |
| `confidence` | ✅ | **`choice` 应答自带 `confidence`** |
| `setupScore` | ✅ | `score` 类型 |
| `leverage` / `positionSizeUsd` | ❌ | Jev **不产生数字**，弱于算术 |
| `stopLoss` / `takeProfit` | ❌ | 需要精确价格 |
| `reasoning: string`（**必需**） | ❌❌ | Jev **完全不产生文字** |

**Jev 的答案只有三种类型**（线上实测 `/v1/systemone`）：

```jsonc
// choice —— 从给定选项里选一个
{"type":"choice","choice":"open_long","confidence":0.74,
 "probabilities":{"open_long":0.83,"open_short":0.01,"skip":0.16}}

// score —— 按给定刻度打分
{"type":"score","score":2.53,"confidence":0.6,
 "legend":{"0":"很差",...,"4":"很好"},"probabilities":{...}}

// noul —— 一个概率值
{"type":"noul","noul":0.33}
```

### ✅ 可行的形态：**代码算好档位 → Jev 选 → 代码翻译**

```
① 代码按 ATR / 风险预算算好 3 个候选档位（仓位、止损、止盈）
② Jev 用 choice 从档位里【选】
③ 代码把 Jev 的答案翻译成 Decision，reasoning 由答案生成（不是编的）
```

**⇒ 每一个决策内容都源自 Jev 的选择**，同时避开它的算术与文字弱点。
这就是「一切由 JEV 自主完成」在本模型能力下的**正确且唯一**的形态。

### ⛔ 不可接受的实现

| 做法 | 为什么不行 |
|---|---|
| 让 Jev 输出自由文本 | 它**不产生任何文字**，只会得到空 |
| 让 Jev 直接给价格/数量数字 | 它弱于算术，会**静默产出错数字** —— 比没有更危险 |
| 让 Jev 算 ATR 倍数 | 同上 |
| 用 Jev 替代风控引擎 | 风控是资金安全的最后一道闸，不能交给概率模型 |

---

## 二、线上实测得到的 API 契约（实现者必须照此写）

### 端点

```
POST {baseUrl}/v1/systemone
Authorization: Bearer <gateway key>
```

### 请求体

```jsonc
{
  "state": "<一段紧凑的行情摘要 + 算好的候选档位>",
  "model": "jev-latest",
  "questions": {
    "<问题名>": {
      "type": "choice" | "score" | "noul",
      "instructions": "<用肯定句描述要判断什么>",
      "criteria": <形状取决于 type，见下>
    }
  }
}
```

### ⚠️ `criteria` 的形状**因 type 而异**（实测踩过两次）

| type | `criteria` 形状 | 例子 |
|---|---|---|
| `score` | **数组** | `["很差","较差","一般","较好","很好"]` |
| `choice` | **字典**（键=答案值，值=给模型看的说明） | `{"open_long":"做多","open_short":"做空","skip":"不动"}` |
| `noul` | **字典** | `{"yes":"是","no":"不是"}` |

**两种写错都会 422**，且报错文案是 `Input should be a valid dictionary/list`：

```
✗ choice: criteria 放数组        → 422 dict_type
✗ choice: 包一层 {choice:{criteria:…}} → 422 Field required
✓ choice: criteria 直接放字典     → 200
```

### ✅ 一次调用可以问多个问题

`questions` 是对象 ⇒ **一次 HTTP 就能拿到一个标的的完整交易判断**。
线上实测（408ms）：

```jsonc
{"model":"jev-1.13.0","answers":{
  "direction":{"type":"choice","choice":"open_long","confidence":0.88,
               "probabilities":{"open_long":0.92,"open_short":0,"skip":0.08}},
  "size_tier":{"type":"choice","choice":"B","confidence":0.28,
               "probabilities":{"A":0.44,"B":0.52,"C":0.04}},
  "stop_tier":{"type":"choice","choice":"B","confidence":0.25,...},
  "tp_tier":  {"type":"choice","choice":"A","confidence":0.8,...},
  "setup":    {"type":"score","score":2.53,"confidence":0.6,...}},
 "usage":{"input_tokens":966,"output_tokens":166}}
```

**⇒ 408ms/标的** vs 团队模式一轮 100–200 秒 ⇒ 快 250–500 倍。

### ⚠️ `confidence` 是 0–1 的小数

而 `Decision.confidence` 是 **0–100** ⇒ 必须 `× 100` 并取整。

### ⚠️ `readGatewayKey()` 的守卫是本模式的一个坑

```typescript
// llm/jev.ts:230
function readGatewayKey(env) {
  if (env.AQ_JEV_PREFILTER !== 'on') return '';   // ← 初筛功能专属的守卫
```

**它只认「初筛」开关。** 用户 2026-10-18 关掉初筛后，连 key 都读不到。

⇒ **JEV 模式必须有自己的启用条件**，不能复用这个守卫。
建议：`readJevConfig()` 增一个「为什么读 key」的参数（`purpose: 'prefilter' | 'mode'`），
或让守卫接受「任一使用者开启」。

---

## 三、字段来源表（实现的规格）

对每个候选标的，一轮 Jev 调用产出：

| Decision 字段 | 来源 | 说明 |
|---|---|---|
| `symbol` | 候选列表 | 逐个标的单独问 |
| `action` | **Jev `choice`**（direction） | `open_long`→`open_long`、`skip`→丢弃 |
| `confidence` | **Jev `choice` 的 confidence** | ×100 取整 |
| `setupScore` | **Jev `score`**（setup） | 2.53/4 → 换算成 0–100 |
| `setupScoreBasis` | **由答案生成** | 例：`Jev setup=2.53/4（较好），置信 0.60` |
| `reasoning` | **由答案生成**（模板 + Jev 的百分位） | 例：`Jev 判 open_long（置信 88%，多 92% / 空 0% / 不动 8%）；仓位档 B；止损 1.5×ATR；止盈 2:1` |
| `positionSizeUsd` | **档位表 × Jev 选的档** | 代码按风险预算算好 A/B/C 三档 |
| `stopLoss` | **档位表 × Jev 选的档** | 代码按 ATR 算好 A/B/C 三档 |
| `takeProfit` | **档位表 × Jev 选的档** | 代码按盈亏比算好 A/B/C 三档 |
| `leverage` | **策略配置** | 不让 Jev 选（它无法评估爆仓风险） |
| `riskUsd` | **代码**（= 权益 × 风险比例） | 与档位表同源 |
| `reducePercent` / `reduceQuantity` | 不适用 | 本模式只做开仓与跳过（见下） |

### 为什么 `leverage` 不给 Jev 选

杠杆直接决定爆仓距离。Jev 看不到保证金、看不到账户余额、
也无法计算强平价 —— 让它选杠杆等于**把资金安全交给一个不掌握事实的模型**。
这与 `AGENTS.md` 的「网关边界」同一条纪律：**谁掌握事实，谁做决定。**

---

## 四、接线方案（最小风险）

### 关键发现：`DecisionModel` 只要求返回 `text`

```typescript
// autoTrader.ts:519
export interface DecisionModel {
  complete(systemPrompt, userPrompt, options): Promise<{ text: string; latencyMs: number; usage: … }>
}
```

交易循环拿到 `text` 后交给 **`parser.ts` 解析成 `Decision[]`**。

**⇒ Jev 模型把答案序列化成 JSON 文本即可 —— 完全复用现有的解析、风控、执行链路。**

### 接线点

```typescript
// manager.ts:3017  ← 唯一的模式分派点
complete: async (systemPrompt, userPrompt, options) => {
  if (routedTeamModel) return routedTeamModel.complete(...);  // ai_team
  if (jevModel)        return jevModel.complete(...);          // ← 新增这一行
  const result = await client.complete(...);                   // 其余
}
```

### Jev 模型怎么拿到行情数据

**不解析 prompt 文本**（脆弱）。做法：

1. `autoTrader.ts` 在**仅 Jev 模式**下，把一个结构化 JSON 块附加到 `userPrompt` 末尾：
   ```
   <JEV_INPUT>{"candidates":[{"symbol":"BRUSDT","price":0.42045,"atr":0.01174,…}]}</JEV_INPUT>
   ```
2. `jevModel.ts` 提取该块（`/<JEV_INPUT>([\s\S]*?)<\/JEV_INPUT>/`）

**⚠️ 其他模式的 prompt 必须逐字节不变** —— 附加逻辑只能在同一处按模式分支，
不得改动 `renderUserPrompt` 本身。

### 数据流

```
autoTrader 每轮
  → buildUserPromptParts（原样）
  → 【Jev 模式】附加 <JEV_INPUT> 块
  → DecisionModel.complete()
      → jevModel：解析块 → 对每个候选
          → 算 3 档位（仓位/止损/止盈）
          → 一次 HTTP 问 Jev（direction + size_tier + stop_tier + tp_tier + setup）
          → 组装 Decision JSON
      → 返回 { text: JSON.stringify({decisions:[…]}) }
  → parser.ts（原样）
  → 风控引擎（原样）
  → 执行（原样）
```

---

## 五、降级与失败处理

| 情形 | 行为 |
|---|---|
| Jev HTTP 失败 / 超时 | **该标的本轮跳过**，写 `warn` 日志（含原因）。不得静默产出空决策 |
| Jev 返回 `skip` | 该标的不产生 Decision（正常业务，**不写 warn**） |
| `answers` 缺字段 | 该标的跳过 + `warn`（形状变了，那是网关侧的问题，要看得见） |
| 全部标的都失败 | 本轮 `success=false`，与现有失败路径一致 |
| `confidence` 超出 0–1 | 钳到 [0,1] 后 ×100（**不要丢样本**） |

**⚠️ 与 `docs/MAGPIE-DEPENDENCY.md` 的边界一致**：Jev 端点没了/形状变了 ⇒ 报警，
但**不要在客户端替网关做熔断或路由决策**。

---

## 六、默认关闭与兼容性

| 要求 | 落实 |
|---|---|
| 默认关闭 | 不新建 `mode='jev'` 的机器人 ⇒ 本模式代码路径**永不进入** |
| 三种既有模式逐字节不变 | 分派点是一行 `if`；`renderUserPrompt` 不改；prompt 附加只在 jev 分支 |
| 类型级保证 | `TraderMode` 扩展后，tsc 的穷尽检查会找出所有未处理的分支 |
| 关闭初筛不影响本模式 | 本模式有独立的启用条件（见 §二 的 `readGatewayKey` 坑） |

---

## 七、实现清单（给 `t121`）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/shared/src/domain.ts` | `TraderMode` 加 `'jev'`；`AI_DRIVEN_MODES` 加 `'jev'` |
| 2 | `packages/server/src/llm/jev.ts` | 加 `askJevQuestions()`（多问题、choice/score/noul 形状正确）；修 `readGatewayKey` 的守卫 |
| 3 | `packages/server/src/trader/jevModel.ts` | **新建**：档位计算 + 提问 + 组装 Decision JSON |
| 4 | `packages/server/src/trader/autoTrader.ts` | 仅 Jev 模式附加 `<JEV_INPUT>` 块 |
| 5 | `packages/server/src/trader/manager.ts` | 接线一行 `if (jevModel)` |
| 6 | `packages/web/src/…` | 新建机器人时可选「JEV 模式（实验性）」 |
| 7 | 测试 | 档位计算、criteria 形状、降级、默认关闭、三种既有模式不变 |

### 验证命令

```bash
npm run typecheck && npm test && npm run build
```

---

## 八、未验证事项（不得当成已确认）

1. **Jev 在多标的、长 state 下的表现** —— 本设计只实测了**单个标的**的 5 问组合。
   多标的批量提问是否稳定、是否需要并发控制，**未验证**。
2. **`noul` 在交易语境里的用途** —— 实测只确认了它的形状，没有找到必然的用法。
3. **成本** —— 实测 966 input / 166 output tokens 每次。19 个标的 × 每轮 ⇒
   实际 token 消耗与费用**未测算**。
4. **Jev 模式的盈利表现** —— 完全未知。这是**实验性**标签的全部理由。
