# task-4 复核报告：团队决策空转修复（task-1）

- **复核人**：`desk-pipeline`（即 task-1 的实现者本人 —— 对抗式自审）
- **复核时间**：2026-10-15
- **被复核对象**：`packages/server/src/trader/agent/deskOutput.ts`（+ `deskOutput.test.ts`、`teamModel.test.ts` 各一处）
- **代码基线**：工作树 `HEAD=269e386`（task-1 的改动**未提交**，仍在工作树里）
- **线上**：`ssh tx` 只读查询 `/opt/autoquant/data/autoquant.sqlite`（全部语句只有 `SELECT`）

> **总判定：可部署**（附 1 条"数字需更正"、2 条"必须记录的限制"、1 条建议）

> ⚠️⚠️ **本报告 §1 的 B/C 两个数字是【在复核中推翻实现者原表】得到的**
> （实现者原表 `B=26 / C=27` → 复核结论 **`B=7 / C=32`**，根因见 §1.3：
> 判据的非贪婪正则切在了裁决官自己写的 `- close[-1] = …` 列表项上）。
>
> **读者不要拿实现者的原表当结论。** 本报告以 §1.1 的复核表为准；
> §1.3 保留两个口径的对照，是为了让"为什么数字变过"这件事可追溯 —— 不是为了给出两个答案。
> 其余各类（散文 57 / 无产出 8 / 真截断 8 / 真空数组 2 / 假决策 1）两边一致。

---

## 0. 复核方法：我刻意不复用实现者的脚本

实现者的分类脚本有两个**会改变结论的**重建细节，我第一轮就撞上了（详见 §1.3）。所以我自己重写了判据：

```
judge 段 = 从 team 块里 `- judge（…）：` 那一行开头，**贪婪**取到 `</team>` 之前
           （实现者取的是"judge 行到 `</team>`"，但它用非贪婪正则切在了第一条
             `\n- ` 上 —— 而裁决官自己会写 `- close[-1] = …` 这种列表项）
判据顺序：无产出 → 未闭合 `[` → 空数组 `[]` → 未闭合围栏 → 无任何 `[`
```

*（方法学备注：Lead 建议的"解析 `deskOutput.ts` 的字面量来验实际文案"这个方法有效，
我在 §5 用它验了跨目录契约。它**没有**以探针形态留在仓里，见 §7。）*

---

## 1. 根因分类是否可复现

**结论：可复现；但实现者表格里有 2 处数字需要更正（结论方向不变）。**

### 1.1 复核者的独立分类（自己判据）

线上 `trader_id=11` 共 **287** 条，`decisions_json='[]'` 共 **108** 条 = **37.6%**
（任务描述写的"107/285"是快照时点差，不是错）。

| 复核者分类 | 条数 | 占空决策 | 与实现者是否一致 |
|---|---|---|---|
| A-裁决官以散文给出"不行动"（全程无数组） | **57** | 52.8% | ✅ 一致（57） |
| B-裁决官写到 ` ```json ` 就停（无数组） | **7** | 6.5% | ❌ 实现者写 26 |
| C-抽到真数组但本轮空决策 | **32** | 29.6% | ❌ 实现者写 27 |
| D-无产出（judge 行是"失败"/没有 judge 行/整轮无 raw） | **8** | 7.4% | ✅ 一致（8，构成不同见下） |
| E-真截断（有未闭合 `[`） | **8** | 7.4% | ✅ 一致（8） |
| F-裁决官真的写了 `[]` | **2** | 1.9% | ✅ 一致（2） |
| G-抓错数组（`[-1]`） | **1** | 0.9% | ✅ 一致（1） |

（B/C 两列有重叠计数：实现者的 26 里被我判成 C 的有 19 条、判成 B 的 7 条；
另有 5 条被实现者算进 E、我判成 C，见 §1.3。）

### 1.2 三类真实样本（逐字，截断到可读）

```
[A · id=2418 · c7]  judge 正文结尾：
  "## Judge结论：**不行动**"            ← 全篇没有反引号围栏、没有 [
[B · id=2579 · c90]  judge 正文结尾：
  "```json"                             ← 写完围栏就停，无数组
[C · id=2663 · c137] judge 正文：
  "```json [ {\"symbol\": \"1000RATSUSDT\", \"action\": \"open_short\", …} … ] ```"
  而 <risk> 写成： 否决（group/auto-qfmodel）：## 风险审查意见     ← 假否决
[E · id=2836 · c236] judge 正文结尾：
  "…24h+21.51"                          ← 未闭合 [（被 4000 字 clip 截到 mid-array）
[F · id=2496 · c40]  judge 正文结尾：
  "```json\n[]\n```"                    ← 真的输出空数组
[G · id=2761 · c192] <decision>\n[-1]\n</decision>   ← 推理里的 close[-1]
```

### 1.3 两处不一致的具体定位（**这是本节最重要的内容**）

**不一致①：B=26 → 实际 7；C=27 → 实际 32。**
19 条被实现者算成"围栏就停"的记录（`2568/2579/2652/2653/2655/2656/2658/2663/2665/2667/2668/2670/2671/2673/2675/2676/2678/2679/2683`…）
**其实抽到了真数组**。根因是**判据切段方式**：

```
实现者用的是非贪婪正则： /^- judge（([^）]*)）：(.*)$/m
  → `(.*)` 遇到第一条 `\n- ` 就停
  → 而裁决官正文里常写 `- close[-1] = 2.4831`、`- 杠杆：…` 这类列表项
  → 段被提前截断，数组（在更后面）看不到 → 误判成"没有数组"
```

⚠️ 值得强调：**19 条里 18 条是假否决（C 类）**，也就是"实现者把 19 条误判成了输出契约问题"。
方向是**低估了自己的修复覆盖**（C 类更多、B 类更少），不影响安全面。

**不一致②：E=8 的构成。** 实现者写"bad-json（未闭合）5 + clipped 里 4+1"，
我判 8 条未闭合 `[`（`2489/2536/2552/2836/2841/2842/2866/2868`）。
差 3 条：`2489/2536/2552` 被实现者归到"无 judge 行"：我复核了 `raw_response`，
它们的 `<team>` 里**根本没有 judge 行** ⇒ 这 3 条是"无产出"而不是"截断"。
即：**真正"judge JSON 被输出预算截断"的只有 5 条 = 4.6%**（任务描述假设的是 107 条）。
实现者那句"真截断只有 5 条（4.6%）"在**它自己那套重建下是对的**，在我这套下是 8；
两个数字都远小于 107，结论方向一致。

### 1.4 交叉校验（独立于分类逻辑的证据）

```
error 列非空的行 = 1（就是 id=2398 · c2 · Abort）
success=0 的行    = 1（同一条）
```
⇒ 说明"空决策"绝大多数是 **success=1 的正常轮次**，不是异常落库。与实现者"108 条里只有 1 条是异常"一致。

---

## 2. 修复是否真的改变行为（生产路径是否执行）

**结论：通过。生产路径确实执行这一段代码，且链路可逐跳指认。**

菜单：
```
manager.ts:2798   trader.mode === 'ai_team'  ← 生产闸门
     ↓
manager.ts:1933   const model = createTeamDecisionModel({ router, … })
     ↓
autoTrader 的 model.complete(system, user)   （交易循环唯一契约）
     ↓
routedModel.ts:705  createTeamDecisionModel(...).complete
     ↓
routedModel.ts:1074 runTradingDesk(...)      ← 跑完 4 分析师 + 辩论 + 裁决
     ↓
routedModel.ts:1109 askRiskOfficer(...)
     ↓
routedModel.ts:1161 renderDeskOutcome(outcome, risk, {…})   ← ★ 我改的抽取与文案在这一步
     ↓
routedModel.ts:1160 stripToolBlocks(...) → 返回 text
     ↓
autoTrader → strategy/parser.ts: parseDecisionResponse(raw, ctx)
```

**闸门证据**（线上库只读查询）：
```
id  name                    mode        dry_run  status
11  [团队测试] 多智能体        ai_team     1        running
```
⇒ `ai_team` 且 `running`，所以 `buildTeamModel()` 会被调用，
`renderDeskOutcome` 在**这台机器人的每一轮**都执行。

**旁证**：被复核的 108 条空决策里，`raw_response` 都含 `<team>` 块
（唯一例外是 id=2398，`raw_response=''`，那是 c2 的 Abort —— 团队台没跑起来）。
⇒ 修复前的那些记录**确实经过了这一行代码**。

---

## 3. 是否放松了风控

**结论：通过（零命中）。**

```
$ git diff -- <我的 3 个文件> > v_diff.patch
$ Select-String v_diff.patch -Pattern "maxPositions|maxMarginUsage|minRiskRewardRatio|minConfidence|requireStopLoss|leverage|adjustments|reduceDecisions|approved|sortDecisions|ACTION_PRIORITY"
命中行数 = 0
```

逐项核对：

| 风控项 | 是否触碰 |
|---|---|
| `maxPositions` | 否（0 命中） |
| 杠杆上限 | 否 |
| `maxMarginUsage` | 否 |
| `minRiskRewardRatio` | 否 |
| `minConfidence` | 否 |
| `requireStopLoss` | 否 |
| `adjustments` 记录 | 否（删除行里没有任何 `adjustments`/`reason` 写入） |

`deskOutput.ts` 的**删除行全文**（供你核对有没有夹带）：
```
- 三种情况必须区分…（注释）
- `ok` / `no-block` / `bad-json`（注释）
- status: 'ok' | 'no-block' | 'bad-json';
- /** bad-json 时的原始片段… */
- * 从任意文本里抽出**第一个 JSON 数组**。（注释）
- return Array.isArray(parsed) ? {decisions:parsed,status:'ok'} : {decisions:null,status:'bad-json',…};
- const extracted = verdict?.ok === true ? extractFirstJsonArray(verdict.raw) : {decisions:null,status:'no-block'};
- if (extracted.status !== 'ok') {
- （旧的两句失败文案）
```
⇒ 全部是**输出渲染层**的东西；没有一行在下单/风控路径上。

⚠️ **诚实标注**：`deskOutput.test.ts` 里第 3 条断言
`assert.equal(extracted.status, 'empty')`（原为 `'ok'`），
`teamModel.test.ts` 里同性质一处 —— **这是测试断言的放宽**（从"必须是 ok"改成
"必须是空决策"）。我判它**不构成"为了让测试变绿而削弱风控"**，理由：
被断言的对象是**决策数组为空**这件事（`deepEqual(decisions, [])` 仍在），
而状态字面量是本次**有意细分**的（见 §4）；且这两条测试守的是"不编造动作"，不是风控阈值。

---

## 4. 是否引入"看起来成功其实失败"的形状

**结论：通过，但有一条必须记录的**下游行为变化**。**

### 4.1 "解析失败 → 假的 hold 决策"？没有

新代码在 `not-decisions` / `no-block` / `bad-json` 下**只会**产出 `<decision>\n[]\n</decision>`
（`deskOutput.ts:410`：`extracted.status === 'ok' ? extracted.decisions : null`），
不存在"补一个 hold/skip"的分支。这一条我专门写了用例 `★★ 形态校验失败时【绝不补一个动作】`。

### 4.2 "错误被吞掉"？没有

失败态**都会写报告行**（5 行，逐态不同文案），且 `callsUsed/truncatedByBudget` 的渲染未动。

### 4.3 ⚠️ 但我用**真实解析器**发现了一条真实的下游差异（实现者报告里没写）

拿 c192 的真实原文跑 `parseDecisionResponse()`（`strategy/parser.ts:809`）：

```
--- 修复前（<decision> = [-1]）
    decisions = []            rejected  = 1 条 ["（未给出标的）:（未给出操作）"]
    WARN [strategy:parser] 丢弃了一条无法解析的决策项（已记入 rejected，不再是静默）{"item":-1}
--- 修复后（<decision> = []）
    decisions = []            rejected  = 0 条 []
```

**差异**：修复前 `parsed.rejected` 多 1 条。
而 `autoTrader.ts:3996` 把 `parsed.rejected` 写进 `execution_log`（`status:'rejected'`）、
`autoTrader.ts:4475` 把它并进"本轮 N 条被拒绝"、界面 `ports.ts:328` 会把它标红。

⇒ 所以这不是"纯审计文案"改动，它**确实改了一条 UI/落库路径**。
我判它**是好的方向**：那条 rejected 是**假的**（`[-1]` 根本不是模型给的决策，
是抽取器的假象），它会让界面把"模型没说任何话"显示成"模型给了东西但被吃掉"。
**净效果：假告警 -1 条，真实交易行为 0 变化。** 但实现者的报告应当写明这一条 —— 
我把它记为"报告不完整"，不记为"代码有问题"。

### 4.4 "把空数组当成正常"？**有意为之，且我认为是对的**

`empty`（真的 `[]`）不产生任何告警行。核对：线上 F 类的 2 条
（`id=2496 c40`、`id=2508 c48`）正文是 `### json\n[]\n`，是**模型明确说"不行动"**。
把它报警会制造 2 条假故障 —— 与本次要修的病同向。

---

## 5. 跨目录契约：后端文案 vs 前端判据（Lead 点名）

**结论：通过 —— 6 条报告行全部对上，且"判断句含『不是截断』"这个陷阱没有踩。**

方法：解析 `deskOutput.ts` 的**字符串字面量**（含 `+` 拼接还原），把抽到的文案
逐条喂给**前端真实分类器** `classifyZeroDecision()`（`packages/web/src/pages/decisionZeroState.ts:121`）。

```
抽到 6 条以「⚠️ 裁决」开头的报告行：
  [not-decisions]       ⚠️ 裁决里解析出一段像 JSON 数组的文本，但它**不是决策数组**…
  [bad-json]            ⚠️ 裁决里的 JSON 数组**没有闭合**（解析失败：输出被截断）…
  [bad-json]            ⚠️ 裁决里的 JSON 解析失败 —— …
  [no-block-no-output]  ⚠️ 裁决官这一轮**没有产出**（调用失败或超时/冷却）…
  [no-block-truncated]  ⚠️ 裁决里的 JSON 数组**没有闭合**（裁决官写到 json 代码块就停了…）
  [no-block-judgment]   ⚠️ 裁决里没有找到 JSON 数组 —— 裁决官这一轮**以文字给出「不行动」**…

期望 kind 比对（3 条断言全过）：
  not-decisions        ← 「不是决策数组」              failure=true   ✅
  bad-json             ← 「（解析失败：输出被截断）」    failure=true   ✅
  bad-json             ← 「JSON 解析失败 ——」           failure=true   ✅
  no-block-no-output   ← 「没有产出」                  failure=true   ✅
  no-block-truncated   ← 「裁决官写到 json 代码块就停」 failure=true   ✅
  no-block-judgment    ← 「以文字给出「不行动」」        failure=false  ✅ ← 关键
```

**陷阱验证**：判断句原文里确实含「截断」二字
（`…这是它的**判断**（不是截断，无需查预算）`），
而前端**先过完 4 条故障正向判据、最后才落"判断"**（先立后破），
所以它**没有**被误判成故障。⇒ `roster-honesty` 的 task-7 **做对了**。

旁证：前端自带契约测试 `packages/web/src/pages/decisionZeroState.test.ts` 独立通过（见 §6）。

---

## 6. 独立跑 typecheck / 测试

全部**重定向到文件再读退出码**（不接管道，见 `docs/AGENTS.md` §3.1）：

```
$ npx tsc --noEmit -p packages/server/tsconfig.json > $env:TEMP\v_tc.log 2>&1
exit=0   errors=0
$ npm run typecheck > $env:TEMP\v_tc2.log 2>&1
exit=0   errors=0
$ npm test > $env:TEMP\v_full.log 2>&1
exit=0
  shared : # tests 65   / # pass 65   / # fail 0
  server : # tests 1752 / # pass 1752 / # fail 0
  web    : # tests 278  / # pass 278  / # fail 0
  → 合计 2095 用例，0 失败
```

（我的两次 `npm test`：实现者报告时是 2088（web 272），
我复核时是 2095（web 278）—— 差额来自队友当时还在补前端用例。
两次都是 0 失败。）

---

## 7. 测试是否真能复现"修复前的失败"（回退验证）

**结论：通过 —— 3 条新用例在回退后全部变红，且红在正确的断言上。**

### 怎么回退的（**只改行为，保留新导出**，避免"红在 import 失败"这种假红）

1. 先把 3 个文件按 SHA256 备份到**仓外**：`%TEMP%\v_task1_files\`
   （`deskOutput.ts` = `32D20A740EAA2A57`，测试文件 `852D39E24FCAD344`、`D1CB1EDAA0FCFDA4`）
2. 只对 `deskOutput.ts` 做**行为回退**（用文本替换，不碰测试文件）：
   ```
   ① 删掉 extractDecisionArray 里的形态校验 → 任何可解析数组都当决策（模拟修复前）
   ② 把 arrayOpenedNotClosed / judgeProducedNothing / fenceOpenedNotClosed
      三个分支条件改成 `false as boolean` → 全部走最后那句"判断"文案（模拟修复前只有一句）
   ```
   ⇒ 文件 hash 变成 `E5AC83667E3AD178`
3. 跑测试：

```
$ npx tsx --test packages/server/src/trader/agent/deskOutput.test.ts
exit=1    # tests 20 / # pass 17 / # fail 3

not ok 18 - ★★★ 推理里的 `close[-1]` 不能被当成决策数组（线上 c192 的 `[-1]`）
      error: ★ 元素没有 action 字段 → 不是决策数组
             + actual 'ok'  - expected 'not-decisions'      ← 红在形态判据上
not ok 19 - ★★★ 空决策的四种失败必须【各说各的事实】…
not ok 20 - ★★ 形态校验失败时【绝不补一个动作】…
```

### 怎么恢复的

```
Copy-Item %TEMP%\v_task1_files\deskOutput.ts <repo>\…\deskOutput.ts -Force
(Get-FileHash …).Hash.Substring(0,16) = 32D20A740EAA2A57   ← 与备份逐位一致
git diff --stat -- packages/server/src/trader/agent/deskOutput.ts
  → 1 file changed, 280 insertions(+), 18 deletions(-)      ← 与回退前一致
```

### 临时探针清理（Lead 点名）

```
$ git status --porcelain | Select-String '^\?\?'
?? docs/VERIFY-task3-roster-honesty.md
?? packages/server/src/trader/agent/summaryCloses.test.ts
?? packages/web/src/components/TeamBoard/boardRender.test.ts
?? packages/web/src/pages/DecisionDetailPage.test.ts
?? packages/web/src/pages/decisionZeroStateCopy.ts

$ Get-ChildItem -Recurse -File -Include "__*",".zdbg*","*.tmp","*.bak" -Path packages,docs,scripts
（空）
```
我建的临时文件（`__verify_parser_tmp.ts`、`__verify_align_tmp.test.ts`、`__wording_tmp.ts`、
早先的 `__replay_tmp.ts`）**全部已删**；备份在 `%TEMP%`（仓外）。
上面 5 个未跟踪文件都是队友的，我没有动。
⚠️ 你提到的 `.zdbg.ts` / `.zdbg2.ts` **不是我建的** —— 我从没用过那个名字，也没有见过它们。

---

## 8. 我没能验证的部分

1. **没有部署、没有线上回读**。所有结论都是"本机代码 + 线上只读快照"。
   新文案**从未在真实运行中产生过一行 `decision_records`**。
2. **"这 5/8 条截断是 token 预算顶格导致的"我验证不了**：
   `prompt_tokens` / `completion_tokens` 两列**全为 NULL**（108 条里 0 条有值），
   所以"截断的成因是预算"这一点**没有数据支持**，只有文本形态（未闭合 `[`）。
3. **B 类（围栏就停）的成因无法区分**：它和"数组被截掉"的文本形态**相同**（都是"有围栏、没有 `[`"）。
   代码里的文案已经**没有断言成因**（只说"没有闭合"），但我也**无法**给出一份"模型自己停
   vs 被截断"的拆分数字。
4. **`npm run sim` / `npm run verify` / `npm run ui:smoke` 都没跑**。
   理由：本次改动不触及下单路径（§3 已证）与前端渲染代码；且队友在并行改动，
   跑全量模拟可能写库/产生交叉干扰。**这是我主动放弃的一档验证，不是通过。**
5. **前端那份 `decisionZeroState.test.ts` 我只跑了、没有逐行审**
   （它在队友范围）。我用的是"后端文案 → 真实前端分类器"这条独立路径（§5）。
6. **没有验证 `not-decisions` 在历史数据上的分布是否会变**（历史行是旧代码写的，
   我只验了"当前代码对同样文本的行为"）。

---

## 9. 必须修的清单（按严重度）

| # | 严重度 | 问题 | 建议 |
|---|---|---|---|
| 1 | 中 | 实现者报告里的根因数字 **B=26/C=27 应为 B=7/C=32**（重建正则非贪婪，切在了裁决官自己的 `- close[-1] = …` 列表项上），另有 3 条 `2489/2536/2552` 被误归为"截断" | 部署前**更正报告数字**；脚本判据若入库需改成贪婪切段 |
| 2 | 低 | 实现者报告漏写了 §4.3 那条**下游差异**：修复前 `parsed.rejected` 多 1 条（会进 `execution_log` 并在界面标红） | 报告补一句；这是**改善**方向，不需要改代码 |
| 3 | 低（建议） | 跨目录契约现在靠"前端读后端源码"来守（`decisionZeroState.test.ts` 已这么做）。后端自己没有守卫 | 建议在 `deskOutput.test.ts` 里加一条"我的 5 条报告行必须含前端的判别词根"，把契约**钉在后端这一侧**。⚠️ 本次**不做**（task-4 只许写报告文件，且三方冻结） |
| 4 | 记录 | §1.3 的"真截断 5 条"这个数字依赖重建口径 | 报告里两个口径都写出来，别只写一个 |

**没有任何一条属于"必须改代码才能部署"。**

---

## 10. 总判定

> ### ✅ 可部署
>
> - 风控零触碰（§3，关键词命中 0）；
> - 生产路径确实执行（§2，`ai_team` 闸门 + 逐跳调用链 + 线上 `raw_response` 旁证）；
> - 无"假成功"形状（§4.1/4.2），且"空数组不报警"是**有意且正确**的（§4.4）；
> - 新用例在回退后**真的变红**，恢复后 hash 逐位一致（§7）；
> - typecheck 0 / `npm test` 2095 用例 0 失败（§6）；
> - 跨目录契约 6/6 对齐，"不是截断"陷阱未踩（§5）。
>
> **部署前需要做的唯一一件事**：把 §9 第 1 条的两个数字更正过来
>（否则文档会误导下一个查"零决策"的人 —— 而那正是本次要修的病）。
>
> **对 task-1 结论的支持度**：本次修复**消不掉**那 57 条"裁决官主动说不做"
>（那是决策不是故障，我同意不把它做好看），也消不掉 26/7 条围栏就停与
> 8 条无产出（分别在提示词输出契约与网关面）。
> 它真正消掉的是 **1 条假决策（`[-1]`）+ 让 101 条的审计定性从"可能被截断"
> 变成各说各的事实** —— 后者是本次的主要价值，**不是动作率**。
