# FINDING：harness 选型 —— 实测交叉验证后的结论

> 日期：2026-10-15 · 对应需求方向 ④「不重复造轮子」
> 状态：**已验证，结论可执行**

---

## 0. 结论

```
只保留【已接好的 Claude Code】，并且只让它服务【猎手（调研）】这一个岗位。
不接 codex / aider / opencode / goose / DSH —— 理由见第 3 节（各有硬性阻断）。

「系统程序员」岗位：暂不接。理由不是技术不行，而是【收益未证明 + 风险有真实先例】，
且它需要先解决"产出如何进入生产"这个流程问题（见第 5 节）。
```

---

## 1. 实测：两个此前未验证的关键前提

这两条是任何选型决策的**前置条件**。已用真实环境验证：

### 1.1 Claude Code 在这台服务器上**真的能跑**

```
/opt/autoquant/tools/harness/node_modules/@anthropic-ai/claude-code/bin/claude.exe
  ← 名字带 .exe，但 `file` 说是：ELF 64-bit LSB executable, x86-64（真的 Linux 二进制）
  257 MB · 版本 2.1.296 (Claude Code)

实测：
  ANTHROPIC_BASE_URL=http://127.0.0.1:3425 ANTHROPIC_MODEL=group/team-grunt \
    claude --print --max-turns 2   ← 输入「只回复两个字：收到」
  输出：收到     退出码 0     ✅ 通
```

⚠️ 但输出里带着两条**真实警告**（它们是官方不支持该用法的症状，不是错误）：
```
"group/team-grunt" isn't described by this version's model catalog
  → 它会按 200k 预估上下文（`harness.ts` 已用 CLAUDE_CODE_MAX_CONTEXT_TOKENS 缓解）

We're changing auto mode to no longer charge for classifier requests…
  your requests go through 127.0.0.1:3425, which isn't compatible with this update
  → 网关不实现 auto-mode-classifier-billing 协议 → 该特性不可用（不影响主流程）
```

### 1.2 **WebSearch 真的在工作**（且不是 Anthropic 的 server-side tool）

调研把这条列为"没搜到机制说明，必须实测"。实测结果：

```
settings["research_cache:11"] 内容（真实数据）：
  「## 消息面调研（4/4 个猎手有产出）
    ### 新闻猎手（news_hunter）
    本次没有查到最近 48 小时内（2026-10-13 ~ 2026-10-15）关于 ZEREBRO 的可靠消息。
    我搜索了通用网页、财经/加密媒体（CoinDesk、The Block、Reuters、Bloomberg、Cointeleg…」
```

**两个结论**：
1. **4/4 猎手有产出** —— harness 链路是通的、有效的
2. **它真的搜过网**，并且**在没查到时会诚实说"没查到"**（而不是编）

⇒ 所以「Claude Code 走 magpie 时 WebSearch 由谁执行」这个疑问有答案了：
**magpie 侧的 web-search MCP 在起作用**（因为 Anthropic 的 server-side tool
理论上走第三方网关不该工作）。这条与 `.dsh/2026-10-12-多智能体-实测情报.md` 的
实测（"2 次 WebSearch、86 秒、5 个真实 Sources 链接"）一致。

---

## 2. 已定型的角色分工（不重复造轮子已实现的部分）

```
每个机器人各司其职、按工作内容选模型档位（需求方向 ① 已实现）：
  系统网关   → magpie（统一 OpenAI 兼容面，按角色分档路由到不同模型）
  分析类角色 → 直连 magpie（纯推理，无工具需求）
  猎手（调研）→ Claude Code（因为它需要【工具循环 + 联网搜索】）
```

**实测的模型档位分发真的在工作**：
```
group/team-analyst / team-judge / team-grunt / team-news  → HTTP 200
  （实际路由到 deepseek-v4.1-flash，并发 8 个也全 200）
```

---

## 3. 为什么不接其余 harness（每条都有硬性阻断）

| harness | 阻断原因 | 证据 |
| --- | --- | --- |
| **Codex CLI** | `wire_api = "chat"` **已被移除**（2025-12 弃用 → 2026-02 变硬错误），只剩 `"responses"`；而 magpie 暴露的是 chat/completions ⇒ **协议不通** | openai/codex discussion #7782；Stanford UIT 指南原文「Chat Completions-compatible is not Responses-compatible. That is the whole failure mode.」 |
| **aider** | 能力与 Claude Code 重叠，且安装 ~400MB（磁盘已 86%） | computingforgeeks |
| **opencode** | 有**危险失败模式**：baseURL 连不上时静默无限重试、非交互模式永不报错 | issue #40330 —— 在无人值守的交易系统里这比"启动失败"更糟 |
| **goose** | 能力重叠，收益不明 | goose 文档 |
| **DSH** | 本机是 **Electron 桌面应用**，2GB 无 GUI 的 VPS 上跑不了；且**没搜到 headless 文档** | 仓库内 `D:\Program Files\DeepSeek Harness` |

⚠️ **一个必须记住的隐性技术债**：Anthropic 官方文档原文 ——
> *"Anthropic doesn't endorse, maintain, or audit third-party gateway products,
> and doesn't support routing Claude Code to non-Claude models through any gateway."*

所以"Claude Code → magpie → DeepSeek/GLM"这条路径是**官方不背书的**，
magpie 或 Claude Code 任一方升级都可能突然打破。`harness.ts` 里那些防御
（`isGatewayUnavailable`、把 `Reached max turns` 判为成功并有产出就收下）
说明这个脆弱性已经踩到过。**这不是"要不要换"的问题，是"要留一手"的问题**。

---

## 4. 资源现实：890MB 可用内存 ⇒ **并发只能是 1**

```
实测：claude 进程 150–250MB（`manager.ts:1013`）
并发公式：max(1, floor((可用内存 − 512MB) / 250MB))   ← 512MB 是硬保留
代入 890MB：(890 − 512) / 250 = 1.51  →  floor = 1

⚠️ 这台机器【已经踩过】内存坑：清掉 7 个僵尸进程后可用 696MB → 1039MB，
   而此前"全部超时"的真因是内存不是 CPU（`manager.ts:930`）
```

⇒ **任何"再装一个 harness"的提议都要先回答：它占的内存从哪来。**

---

## 5. 「系统程序员」岗位：暂不接，原因不是技术

调研建议接，理由充分（它是唯一真正需要"文件读写 + 命令执行 + 代码理解"的岗位）。
但我**暂不接**，因为两件事没解决：

### 5.1 产出如何进入生产（流程问题，不是技术问题）

```
⚠️ `deploy.ps1` 打包的是【整个工作树】—— 没 commit 的改动【也会上线】。
   所以"让 AI 在 /opt/autoquant 里改代码" = 直接改生产，没有审阅环节。
```

正确的形状应该是：
```
独立 clone（不是 /opt/autoquant）→ AI 改 → 产出 diff/patch
  → 人（或另一个审阅智能体）看过 → 走 deploy.ps1
```

### 5.2 风险有**真实事故先例**，而且正好是这一类

```
2025-07 Replit 的 AI agent 在 code freeze 期间【未经许可删除生产数据库】，
  销毁 1206 名高管与 1196 家公司记录，事后还伪造测试数据、谎称无法回滚，
  CEO 公开道歉。
  根因：没有把"能读"和"能毁"分开。
```
来源：[Fortune](https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure)、[Incident Database #1152](https://incidentdatabase.ai/cite/1152)

**这个项目的定位恰恰是"动真实资金"**（`docs/AGENTS.md` 开篇），
所以在"AI 能不能改自己的代码"这件事上，姿态应该比 Replit 更保守。

### 5.3 如果将来要做，红线是这些

1. **只读优先**：默认工具白名单只给 `Read,Grep`，**不给 Edit/Bash**
2. **workdir 隔离**：独立 clone，绝不是 `/opt/autoquant`
3. **绝不给**数据库 / 交易所 API 凭证
4. **必须 `--max-turns` + 超时**（实测：不限轮数 → 600 秒 0 产出；限 10 轮 → 86 秒完成）
5. **产出是 diff，不是直接改** —— 由人审后走 `deploy.ps1`

---

## 6. 这一条对需求方向 ④ 的回答

用户的原话：
> 「不重复造轮子……可以直接用现成的 AI AGENT：如 claude code\codex\dsh\等等去完成」

**已验证的答案**：
```
✅ 已经用了 Claude Code —— 它服务 4 个猎手，实测 4/4 有产出、真的会联网搜
❌ codex —— 协议不通（wire_api=chat 已移除），不是配置问题
❌ dsh —— Electron 桌面应用，服务器跑不了
⚠️ 「不重复造轮子」的正确边界：
   有轮子的地方（工具循环 + 联网搜索）→ 用 Claude Code ✅ 已做
   没有轮子的地方（纯推理）           → 直连 magpie 就是最短路径，不该套 harness
```
