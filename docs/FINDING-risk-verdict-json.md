# 风控官说"要求收紧"，系统读成"否决"（2026-10-15 修）—— 有机会却不出手

> 这是目标（"7×24 全自动干活"）的**底线问题**：
> 团队在跑、裁决官在提议、而**每一次真实动作都被风控官拦下**。

---

## 1. 症状：最近 20 轮有动作 **0 轮**

```
#11 最近 20 轮：决策 220 条（全是 skip/hold）· 有动作 0 轮（0%）
```

## 2. 逐层查到根因

### 2.1 裁决官**确实在提议动作**

```
第 280 轮 judge: {"symbol":"SOLUSDT","action":"close_short",…}, {"symbol":"ZECUSDT",…}
第 282 轮 judge: {"symbol":"XRPUSDT","action":"open_long","leverage":5,"positionSizeUsd":11,…}
```

### 2.2 而 `<decision>` 是 `[]`

```
第 280 轮 <decision>: []      ← 提议被清空
第 282 轮 <decision>: []      ← 提议被清空
```

### 2.3 `<risk>` 块说明是谁清的

```
第 282 轮：
  否决（group/auto-qfmodel）：（风控官未给出理由）
  （未能识别风控官的表态，按保守策略只放行降低风险的动作）
```

### 2.4 而风控官**明明给了明确表态**

```
担心：{"verdict":"tighten","lossScenarios":[…],"checked":"…"}
       ↑ 它说"要求收紧"，是一个**明确**的结构化表态
```

---

## 3. 根因：契约不一致 —— 提示词要 JSON，解析器只认中文散文

`roles.ts` 的风控官输出契约：
```
{"verdict":"approve|tighten|reject",
 "lossScenarios":[{"scenario":"这个提案会怎么亏","likelihood":"high|medium|low","severity":"severe|moderate|minor"}],
 "checked":"…"}
```
并明说：「你**只能**否决（reject）或要求收紧（tighten）。你没有"放宽"这个选项。」

而 `riskOfficer.ts` 的解析器：
```ts
const approveRe = /批准|放行|(?<!不)同意|approved|approve/i;
const rejectRe  = /否决|拒绝|不同意|不批准|rejected|reject|denied/i;
```

⇒ **`"tighten"` 两边都不命中** ⇒ 判不出表态 ⇒ 走保守兜底。

---

## 4. 实测代价（最近 60 轮）

```
verdict 分布: tighten=5 · approve=5 · reject=1

而那 5 次 tighten 全部渲染成：
  <risk> 否决（…）：（风控官未给出理由）      ← 判成"否决"
  <decision> []                                ← 所有决策被清空
而 judge 原本提议的是: close_short / open_long / open_long …
```

### 三个缺陷叠加

```
① `tighten` 不在 approveRe/rejectRe 里         → 判不出表态
② 判不出时走保守兜底，而渲染层写成「否决」     → 比实际更严重
③ `reason` 取"第一行非空文本" —— 而它是 JSON    → 显示"（风控官未给出理由）"
```

---

## 5. 修法

### 5.1 先认结构化 `verdict`（那是提示词要求的格式）

```ts
const jsonVerdict = ((): 'approve' | 'tighten' | 'reject' | null => {
  const m = /"verdict"\s*:\s*"?(approve|tighten|reject)"?/i.exec(text);
  if (m === null) return null;
  return m[1]!.toLowerCase() as 'approve' | 'tighten' | 'reject';
})();

if (jsonVerdict === 'reject')  → 否决
if (jsonVerdict === 'tighten') → 放行 + 削减（**不是否决**）
if (jsonVerdict === 'approve') → 放行
```

⚠️ **`tighten` 归到"放行 + 削减"** —— 它的字面意思是"要求收紧"，
而收紧在系统里就是 `reduceDecisions()`。
把它当成否决会让**每一次风控官想保守一点都变成完全不出手**。

### 5.2 理由从 JSON 里取

```ts
const jsonReason = /"checked"\s*:\s*"((?:[^"\\]|\\.){1,300})"/.exec(text)  // 它自己写的"我查了什么"
  ?? /"scenario"\s*:\s*"((?:[^"\\]|\\.){1,300})"/.exec(text);              // 它担心的具体场景
const reason = (jsonReason ?? firstLine ?? '（风控官未给出理由）').slice(0, 300);
```

### 5.3 散文判据**原样保留**（纵深防御）

模型不一定总给 JSON —— 原来的 `approveRe` / `rejectRe` 与"否决优先"
在 `jsonVerdict === null` 时仍然生效。

---

## 6. 验证

`riskJsonVerdict.test.ts`（5 条）：
```
① verdict:"tighten" → 必须是【放行+削减】，且削减后仓位 < 原值
② verdict:"reject"  → 否决
③ verdict:"approve" → 放行且不削减
④ 理由必须从 JSON 里取（不能显示"未给出理由"）
⑤ 【反向守卫】散文格式仍走原判据（含"条件句里的否决不该命中"那条既有边界）
```

---

## 7. ⚠️ 一个仍未解决的问题（诚实记下）

**`tighten` 该不该削减，以及削多少** —— 现在沿用 `reduceDecisions()` 的既有逻辑
（那是为散文格式设计的）。而 `verdict:"tighten"` 的语义可能更接近
"放行但把止损收紧/仓位压小到某个比例"，而不是"一律砍半"。

⚠️ 我没有实测证据说明该砍多少，所以**没有动 `reduceDecisions()` 的比例**。
这需要观察修复后的线上数据（削减后的仓位是否合理）再决定。
