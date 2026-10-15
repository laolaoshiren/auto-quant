# 错误信息被当成了产出（2026-10-15 修）—— 第四个「把故障说成正常」

> 这是本轮最重要的发现：**它在最底层，污染了所有下游角色**。

---

## 1. 症状

`#11` 团队模式的 `newscaster`（新闻官）与 `sentiment`（情绪官）反复说
"四个猎手全部失败，零情报可用"。而 `research_cache` 里写着：

```
## 消息面调研（4/4 个猎手有产出）        ← 标题说【全部有产出】
### 新闻猎手（news_hunter）
Error: Reached max turns (12)            ← 而内容是一句错误
### 资金猎手（flow_hunter）
Error: Reached max turns (12)
### 社区猎手（community_hunter）
Error: Reached max turns (12)
### 宏观猎手（macro_hunter）
Error: Reached max turns (12)
```

**标题说"4/4 有产出"，正文全是错误。**

---

## 2. 根因：判据是 `text.length > 0`

`packages/server/src/trader/agent/harness.ts`：

```ts
const hitMaxTurns = /Reached max turns/i.test(err) || /Reached max turns/i.test(text);
if (hitMaxTurns && text.length > 0) {
  finish({ ok: true, text, error: `达到轮数上限（产出可能不完整）：…` });
  return;
}
```

`claude --print` 撞上限时把 `Error: Reached max turns (N)` **写到 stdout**，
于是 `text` 非空 ⇒ 判成 `ok: true` ⇒ **那句错误被当成"有效产出"**。

### 而 `mergeHunterReports` 按 `r.ok` 数"有几个有产出"

```ts
const okCount = reports.filter((r) => r.ok).length;
lines.push(`## 消息面调研（${okCount}/${reports.length} 个猎手有产出）`);
```

⇒ `okCount = 4` ⇒ 标题写"4/4 有产出"。

### 为什么这个错误特别有害

```
下游（newscaster / sentiment）看到"4/4 有产出" ⇒ 以为调研成功了
而它实际拿到的"材料"是四行错误
⇒ 它们只能报"零情报可用"（这一步它们做对了）
⇒ 但【"4/4 有产出"这个信号本身】会让人以为问题在下游，而不是在猎手
```

**这是"把故障说成正常"的第四次**（前三次：决策详情页、`<risk>` 块、猎手零产出），
而这一次最靠底层。

---

## 3. 修法（两层，各自独立）

### 3.1 `harness.ts`：判据改成"剥掉错误行后还剩不剩实质内容"

```ts
const substantive = text
  .split('\n')
  .filter((line) => !/^\s*(Error:\s*)?Reached max turns/i.test(line))
  .join('\n')
  .trim();

if (hitMaxTurns && substantive.length > 0) {
  finish({ ok: true, text, error: '达到轮数上限（产出可能不完整）：…' });   // 收下
  return;
}
if (hitMaxTurns) {
  /* 撞上限且只有错误行 ⇒ 失败，且 text 清空（不能把错误当产出带下去）。 */
  finish({ ok: false, text: '', error: '达到轮数上限，且没有任何实质产出…' });
  return;
}
```

⚠️ **只剥"看起来是 CLI 的错误行"** —— 不剥正常文本，
否则会把一份恰好提到这个短语的真实产出误判成空。

### 3.2 `mergeHunterReports`：**必须仍然区分三件事**

⚠️ 我第一版把它改成了两类，而既有测试立刻变红：

```
① ok:false              → 「未产出」（它没跑成 —— 我们不知道那边有什么）
② ok:true + 文本为空     → 「未查到相关消息」（它跑了，那边确实没消息）
③ ok:true + 有实质内容   → 正常展示
```

**① 与 ② 对下游是完全不同的信息**：
```
"社区上没有讨论"  vs  "社区猎手挂了"
```
合并它们会让下游把"我不知道"当成"那边没事"。

⇒ 现在标题的分子按**实质内容**数，而三态仍然分开。

---

## 4. 验证

`hunterErrorNotOutput.test.ts`（3 条，行为级）：
```
① 只有错误行的"产出"必须算作未产出（标题说 0/2）
② 【反向守卫】有实质内容 + 尾部错误行 → 仍算有产出（不能把好产出丢掉）
③ 三种状态必须区分（既有语义，不能合并）
```

⚠️ 同时**修正了一条既有测试**：`maxTurns.test.ts` 原来断言
`/hitMaxTurns && text\.length > 0[\s\S]{0,200}?ok: true/` ——
**它钉住的正是那个 bug 的写法**。它的意图（"撞上限但有产出不能判失败"）是对的，
但判据写死了实现细节。已改成断言**意图**，并指向行为级测试。

---

## 5. 一条可复用的检查

四个同类缺陷，形态各不相同，但**根因是同一个**：

```
① 决策详情页：故障 → 说成"模型选择观望"（让人不去查）
② <risk> 块：设计内跳过 → 说成"未启用或调用失败"（让人白查）
③ 猎手零产出：搜索在前、结论在后 → 轮数用尽 → 什么都没写
④ harness 判据：错误行 → 说成"有产出"（污染所有下游）
```

⇒ **可复用的检查：任何"判断成功与否"的代码，都要问
"失败时留下的痕迹，会不会被同一个判据当成成功"。**

而 ④ 的特殊之处在于：**它的判据（`length > 0`）看起来完全合理** ——
"有输出就算成功"是个直觉上对的规则。错的是**那个"输出"里装的可能是错误**。
