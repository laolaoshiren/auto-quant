# 需求④验证：harness（Claude Code）真的在跑，且产出已落库（2026-10-15）

> 需求原话：
> > 「不重复造轮子，就像我刚才想要的那些功能，例如增加查新闻智能体，
> >  可以直接用现成的 AI AGENT：如 claude code / codex / dsh 等等去完成……
> >  具体是直接用原版的还是有什么更好的方法调用他们工作，**这个由你调研以后来决定**」

**结论：已调研、已选型、已接线、已线上验证有真实产出。**

---

## 1. 选型结论（`docs/FINDING-harness-selection.md`）

```
只保留【已接好的 Claude Code】，并且只让它服务【猎手（调研）】这一个岗位。
不接 codex / aider / opencode / goose / DSH —— 各有硬性阻断。

「系统程序员」岗位：暂不接。理由不是技术不行，而是【收益未证明 + 风险有真实先例】，
且它需要先解决"产出如何进入生产"这个流程问题。
```

### 前置条件（实测，不是推理）

```
Claude Code 在这台服务器上真的能跑：
  tools/harness/node_modules/@anthropic-ai/claude-code/bin/claude.exe
  ← 名字带 .exe，但 file 说是 ELF 64-bit LSB executable（真的 Linux 二进制）
  257 MB · 版本 2.1.296

  实测：
    ANTHROPIC_BASE_URL=http://<网关> ANTHROPIC_MODEL=group/team-grunt \
      claude --print --max-turns 2   ← 输入「只回复两个字：收到」
    输出：收到     退出码 0     ✅ 通
```

⚠️ 两条**真实警告**（官方不支持该用法的症状，不是错误）：
```
"group/team-grunt" isn't described by this version's model catalog
  → 它按 200k 预估上下文（`harness.ts` 用 CLAUDE_CODE_MAX_CONTEXT_TOKENS 缓解）

your requests go through 127.0.0.1:3425, which isn't compatible with this update
  → 网关不实现 auto-mode-classifier-billing 协议 → 该特性不可用（不影响主流程）
```

---

## 2. 接线（代码）

```
packages/server/src/trader/agent/harness.ts       15.1 KB  —— 调 Claude Code 的那层
packages/server/src/trader/agent/hunters.ts               —— HUNTERS 定义（4 个猎手）
packages/server/src/trader/manager.ts:2208                —— 猎手并发执行
packages/server/src/trader/manager.ts:1133                —— 同一路径（另一处）
```

调用形状：
```ts
const r = await runAgentTask({
  task: buildHunterTask(hunter, symbols),
  allowedTools: 'WebSearch,WebFetch',
  model: process.env.AQ_RESEARCH_GROUP ?? 'group/team-news',
  fastModel: process.env.AQ_GRUNT_GROUP ?? 'group/team-grunt',
  workdir: hunterWorkdir(hunter.id),
  timeoutMs: hunterTimeout,
  authToken: apiKey,
});
```

**并发**：`mapConcurrent(HUNTERS, hunterLimit, …)` —— 与需求②的"并发工作"一致。

---

## 3. 线上验证（判据：有真实产出，不是"代码存在"）

### 3.1 猎手产出已落库

```
settings.research_cache:11 = 1138 字节
```

内容（原文节选）：
```
- [bearish] 美国现货 Solana ETF 连续 7 个交易日（10 月 5 日–13 日）净流出，
  其中 5–9 日合计流出 2500 万美元，SOL 报约 102.50 美元，10 月以来累计下跌约 13%
  来源：https://www.tokenpost.com/news/investing/323…
```

⇒ **带方向标签（bearish）+ 带来源 URL** —— 这是 harness 通过 magpie 联网搜索的真实产出。

### 3.2 ⚠️ 我一度判断错了（如实记下）

我先查 `server.log` 里搜「猎手 / harness / 调研」，**结果为空**，于是怀疑需求④没生效。
**那个判断是错的**，原因是：

```
server.log 已经滚到 21 MB —— 早期的猎手记录被冲掉了
而 research_cache 的落库记录还在（它在数据库里，不受日志滚动影响）
```

⇒ 又一次「**不要把『我的查询没看到』当成『它没有发生』**」。
判据应当选**不会滚动的载体**（数据库、落库的设置项），而不是日志。

### 3.3 只有 #11 有 research_cache

```
research_cache:11  → 有（1138 字节）
research_cache:10  → 无
```

`#10` 是 `ai_managed`（智能托管），**不是团队模式** —— 所以它没有猎手，这是**符合设计**的
（猎手是团队模式的岗位）。`#9` 已停止，`#8` 不存在。

---

## 4. 结论

| 需求④的四个要点 | 状态 |
| --- | --- |
| 调研清楚（哪种 harness、原版还是更好的方式） | ✅ `FINDING-harness-selection.md`，含实测 |
| 决定用哪个 | ✅ 只用 Claude Code，只服务猎手岗位 |
| 真的接上 | ✅ `harness.ts` + `manager.ts` 两处调用点 |
| 真的在跑 | ✅ `research_cache:11` 有带来源的真实情报 |

**未做的部分（诚实列出）**：
```
① 「系统程序员」岗位未接 —— 理由见选型文档（收益未证明 + 产出进生产的流程未解决）
② codex / dsh / aider / opencode / goose 均未接 —— 各有硬性阻断（同上文档）
③ 猎手的产出【如何被下游消费】我只验证了它落进 research_cache，
   没有验证"它真的改变了决策" —— 那是另一个问题（需要对照实验）
```
