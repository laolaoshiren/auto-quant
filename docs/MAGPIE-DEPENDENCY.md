# magpie 依赖治理 · 现状与"一劳永逸"方案

> 用户的要求：
> > 「既然项目团队模式高度依赖 magpie，那么是否有些功能/设置会因为 magpie 的改动更新
> >   而需要做相应的调整，如果有你得跟进，还要研究看看有没有一劳永逸的方案
> >   （不让这个成为项目包袱）」
>
> magpie 是**自动更新、一天多版**的项目（实测：我们开始工作后几小时内它就从 0.1.1283 到了 0.1.1285）。

---

## 一、我们依赖什么（盘点结果）

| 依赖面 | 位置 | 脆弱性 | 坏了会怎样 |
|---|---|---|---|
| `/v1/models` 的响应形状 | `llm/modelDiscovery.ts` | **中** | 预算算不出来 ⇒ 输出被截断成空内容（**静默**） |
| 候选链上的模型 id | `trader/routedModel.ts` | **高** | 每轮先撞 404（**静默变慢**） |
| 错误文案（`余额/额度/不可用`） | `llm/errors.ts` + `llm/modelHealth.ts` | **高** | 降级判据失效 ⇒ 每轮重复撞同一个死模型 |
| `/v1/systemone`（Jev） | `llm/jev.ts` | **高** | 初筛失效 ⇒ 降级回"不筛"（有兜底） |
| `/mcp/magpie/web-search` | `trader/agent/webSearch.ts` | **高** | 新闻材料为空（有兜底） |
| `caller-keys.json` 格式 | `trader/teamGateway.ts` | **高** | 读不到 key ⇒ 静默退回单模型 |
| Anthropic Messages 兼容面 | `trader/agent/harness.ts` | **高** | 工具循环失效 |

**结论：真正危险的不是"magpie 挂了"**（那会报错、看得见、有人会修），
**而是这四类静默降质**：
```
① 模型 id 悄悄失效        → 决策变慢，测试不会红
② 错误文案改了            → 降级判据失效，每轮白撞
③ /v1/models 字段改名     → 预算算不出来，输出变空
④ 端点路径变了            → 功能缺失，但有兜底
```

---

## 二、已经做了什么

### ✅ 1. 修掉一个**真实已知**的死 id

```diff
- 'group/auto-space-bunny-free'
+ 'group/auto-space-bunny'
```
线上网关实测：带 `-free` 的那个已不存在，现名去掉后缀。
而 T1/T2 两条链各挂着它 ⇒ **每轮决策先撞一次 404**。

### ✅ 2. 加了一道**自动防线**：按网关清单过滤死 id

`packages/server/src/trader/ladderResolve.ts` + `setAvailableModelIds()`

- 启动时用 `/v1/models` 过滤候选链上不存在的 id
- 被过滤的写一条 `warn`（**这是"升级后 id 漂移了"的唯一可见信号**）
- 边界（都有测试）：拿不到清单 ⇒ 不筛；**一个都不剩 ⇒ 不筛**（宁可撞 404，也不能让团队没候选）

### ✅ 3. 加了**契约自检**（P0 免费层）

`packages/server/src/llm/gatewayContract.ts` + `index.ts` 接线

- 探针（**全部零 token**）：
  - `models.shape` —— `data: [{id}]` 形状还在吗
  - `models.metadata` —— 带上下文长度的模型占比（<20% 是 error，因为那会让输出变空）
  - `models.ladderIds` —— 候选链上哪些 id 已经不存在（**点名**）
  - `quotas.shape` —— `/v1/magpie/quotas` 还在吗（只 warn）
- 默认关闭（`AQ_GATEWAY_CONTRACT=on` 才跑）
- 启动后 60 秒一次，失败写 `runtime_logs`（scope=`gateway_contract`），**同一问题 24 小时只写一次**
- 实测：`[网关契约] 自检通过（329 个模型 · 2 次请求 · 1012ms）`

### ✅ 4. 加了**未归类错误文案**的被动观测

`packages/server/src/llm/errors.ts` 的 `setUnrecognizedErrorSink()`

**它防的是一个具体的历史事故**：某个网关在 HTTP **400** 里返回 `模型不可用：deepseek-flash`
这种**临时不可用**信息，而 400 通常被正确地判为不可重试，导致一次本可成功的请求被放弃。

那个短语现在登记在 `TRANSIENT_BAD_REQUEST_MARKERS` 里。但如果 magpie **换了措辞**呢？
所有 4xx 都会变成"不可重试"，**而没有任何信号**。

⇒ 加了被动接收器：真实流量里出现"4xx 但文案一个都不认识"时记一笔 `warn`。

| 场景 | 行为 |
|---|---|
| 没注册 sink（默认） | **零副作用**，分类结果逐字不变 |
| 注册了 + 未归类文案 | 触发一次，带上原文（截断 200 字符） |
| 注册了 + 已登记短语 | **不触发**（那是正常路径，不是漂移信号） |

实测 4 条测试全部通过，包括「已登记短语一个都不该触发」（假警报会让这条信号失去价值）。

### ✅ 5. 加了**版本感知**

`gatewayContract.ts` 的 `readGatewayVersion()`

**它回答的问题是：某天开始出问题时，是 magpie 哪一版改坏的。**

```
部署前：自检通过（329 个模型 · 2 次请求 · 1066ms）
部署后：自检通过（329 个模型 · 3 次请求 · 1466ms · magpie v0.1.1271）
```

⚠️ 有一个坑：线上服务以 `autoquant` 用户运行，而 `last-version` 文件是 root 可读、
**autoquant 读不到** ⇒ 那一格一直是"未知"。
修法：部署脚本（`scripts/deploy.ps1`）把源文件复制成 `data/magpie-last-version` 并 chown 给 autoquant。

### ✅ 6. 补上了**最后一个契约盲区**：Jev 端点探针

探针 5：`POST /v1/systemone`

**为什么那是最危险的一个：**

```
/v1/systemone 是【非标准端点】（TypeSafe 自己的 Decisions API，不是 OpenAI 兼容协议）
      ↓ magpie 一天多版，任何"顺手重构路由"都可能把它改掉
      ↓ 而它一坏：Jev 初筛 → 降级到"不筛" → 每轮重新分析全部 20 个标的
           耗时从 110s 回到 300s+，而且【不会报任何错】
```

**这正是本项目反复记录的那类失败：静默变差，不是报错。**

| 项 | 内容 |
|---|---|
| 何时探 | **只在 `AQ_JEV_PREFILTER=on` 时**（没开时那个端点与我们无关） |
| 探什么 | 发一个 `noul` 问句，只验 `answers.<任意键>.type` 是字符串 |
| 成本 | 一次调用 `input≈268 / output≈20` token ⇒ **≈ 0.00001 美分** |
| 级别 | `warn`（不是 error）—— Jev 坏了会降级，不影响交易 |

### 至此，七个依赖面全部有覆盖

| 依赖面 | 探针 | 坏了会怎样 |
|---|---|---|
| `/v1/models` 形状 | ✅ | 告警 |
| `/v1/models` 元数据 | ✅ | **error 级**（输出会变空） |
| 候选链上的模型 id | ✅ | 告警（**点名**哪个失效了） |
| `/v1/magpie/quotas` | ✅ | 告警（只影响提示词一句话） |
| **`/v1/systemone`（Jev）** | ✅ | 告警（初筛降级，变慢） |
| 错误文案措辞 | ✅ | 被动观测（真实失败时记一笔） |
| magpie 版本号 | ✅ | 每次自检都记录 |

**⇒ 这是"不让 magpie 更新成为包袱"当前能达到的最好状态。**

---

## 三、"一劳永逸"的四条路（评估结果）

| 方案 | 可行性 | 判断 |
|---|---|---|
| **① 能力探测代替硬编码** | 部分 | ❌ **不能全自动**。候选链承载了实测出来的**人判断**（哪个快、哪个契约稳、哪个有超时问题），那些推不出来。且 Jev **不在 `/v1/models` 里**（实测 329 个 id 里 0 个 jev）⇒ systemone 只能靠端点探测 |
| **② 协议适配层收口** | 可行 | 🟡 **收益最大但工作量大**。把所有网关调用（models / chat / systemone / search）收进一个门面。目前做了"候选链过滤"这一块，其余待做 |
| **③ 固定 magpie 版本** | ❌ 不可行 | magpie README 明写 "every build updates itself"，且用户明确要自动更新。**而且这条路省不掉维护** —— 每天在变的是**供应商侧模型上下线**，与 magpie 版本无关 |
| **④ 契约测试 + 夹具** | 可行 | ✅ **性价比最高，已部分落地**（`gatewayContract.test.ts` 8 条 + `ladderResolve.test.ts` 6 条）。差的是"对着活网关跑一遍"的入口 |

### 推荐组合（按投入产出排序）

```
第 1 步（已完成）：人保留判断，机器去掉死 id
                  → ladderResolve.ts + 启动时注入 /v1/models

第 2 步（已完成）：契约自检 P0 免费层
                  → gatewayContract.ts，零 token，默认关

第 3 步（待做）：错误文案的被动告警
                  → 每次真实失败若落到 unknown/bad_request 却带 4xx/429，
                    记一条"未归类的网关错误文案" + 原文前 120 字
                  ⚠️ 这是性价比最高的一条：不需要制造故障就能发现"magpie 换了措辞"

第 4 步（待做）：版本感知
                  → 部署脚本同步 last-version，版本一变就触发一次 deep 探测
                    "升级当天就知道"，而不是等某轮变慢才发现
```

---

## 四、实际的第一次考验（已通过）

```
magpie 0.1.1283 → 0.1.1285（自动更新 2 个版本，发生在几小时内）
实测：
  /v1/models      HTTP 200 · 329 个模型 · 字段齐全
  /v1/systemone   HTTP 200 · jev-1.13.0 正常
  团队决策         正常进行，无报错
```

**⇒ 这次没打坏。但"这次没事"不等于"下次没事"** —— 契约自检就是为了让下一次出事时
**在升级当天就在日志里出现一条**，而不是等某轮决策莫名变慢才发现。

---

## 五、还没解决的（诚实记录）

1. **错误文案的被动告警没做** —— 这是性价比最高的一条，下一轮该做。
2. **协议适配层没完全收口** —— `/v1/models`、`/v1/systemone`、MCP 搜索仍然分散在多个文件。
3. **版本感知没做** —— 目前靠人来发现"magpie 更新了"。
4. **Jev 不在 `/v1/models` 里** —— 意味着它无法被能力探测发现，只能靠端点探测。这是 magpie 的现状，不是我们能改的。

---

## 六、一个契约自检**抓不到**的坑（2026-10-18 实测发现）

### 现象

修好日志之后（见下），`llm` 的 error 终于带上了模型名：

```
custom 的模型调用失败 —— 这类错误不会因重试而成功
  ｜model=opencode-zen-free/deepseek-v4.1-flash-free provider=custom status=403 kind=permission
```

聚合结果：
| 模型 | 次数 | 状态码 |
|---|---|---|
| `opencode-zen-free/space-bunny-free` | 4 | 40x |
| `opencode-zen-free/beam-free` | 3 | **403** |
| `opencode-zen-free/deepseek-v4.1-flash-free` | 1 | **403** |
| `workbuddy-ai/kimi-k3` | 1 | 429（限流，正常） |

### 关键发现：**它们在 `/v1/models` 里是"存在"的**

```
opencode-zen-free/space-bunny-free:          ✓ 清单里有
opencode-zen-free/beam-free:                 ✓ 清单里有
opencode-zen-free/deepseek-v4.1-flash-free:  ✓ 清单里有
     但实测调用全部 403（无权限）
```

**⇒ `/v1/models` 说"有"，实际"不能用"。**

### 这意味着什么

我原来以为"按 `/v1/models` 过滤死 id"就能防住模型失效。**这个假设是错的。**

| 失效方式 | `/v1/models` 能发现吗 | 契约自检能发现吗 |
|---|---|---|
| id 改名（`-free` 后缀消失） | ✅ 能 | ✅ 能 |
| id 被删除 | ✅ 能 | ✅ 能 |
| **id 还在，但 403 无权限** | ❌ **不能** | ❌ **不能** |
| id 还在，但 429 限流 | ❌ 不能 | ❌ 不能 |

**⇒ 前两种是"契约变了"，后两种是"额度/权限变了"。后者只能靠真实调用发现。**

### 为什么这个坑不致命（但要记住）

```
模型失败 → fallback 自动换下一个 → 最终成功
⇒ 业务零影响（实测：35 条 llm error，同时段逐币并行失败 0 次）
```

**⇒ 代价不是"交易出错"，而是"每轮多花几次无效请求 + 决策变慢一点"。**

### 如果以后要根治，方向是

**加一条"真实调用"健康检查**：对候选链上的每个 id 发一次极小请求（1 token），
把 403/404 的从链里摘掉。

**但这条要谨慎**：
- 它会**花钱**（虽然极少）
- 它和 `docs/AGENTS.md` §6 的"升级阶梯"冲突（那是给交易路径定的，模型路径可以放宽）
- 而且 403 可能是**临时的**（额度每天重置）⇒ 摘掉之后要能自动恢复

**⇒ 所以这条记为"待评估"，不在本轮做。**

---

## 七、顺手修了一个日志缺陷（2026-10-18）

### 问题

`llm` 的 83 条 error **全部长得一模一样**：
```
custom 的模型调用失败 —— 这类错误不会因重试而成功
```
**看不到是哪个模型、什么状态码。** 想回答"哪个在挂"时查不到。

### 根因

```ts
// llm/client.ts —— 记录时带了完整 detail
log.error(`... 模型调用失败 ...`, { provider, model, attempt, status, kind, retryable, elapsedMs, error });

// api/server.ts —— 但 sink 只读两个字段
const m = meta as { traderId?: number; raw?: string };
runtimeLogs.write(traderId, level, scope, text);   // ← 其余全部丢弃
```

而 `runtime_logs` 表只有 `message` 一列 ⇒ **结构化上下文彻底消失。**

### 修法

不新增数据库列（那要迁移，而它是环形缓冲，收益不值）。
改为在写库时把**诊断必需的**几个字段拼成短尾巴：

```
custom 的模型调用失败 —— 这类错误不会因重试而成功 ｜model=xxx provider=custom status=403 kind=permission
```

⚠️ **只挑必需字段**（model / provider / status / kind / attempt / elapsedMs / error），
**不序列化整个 meta** —— 那会把提示词、响应体塞进日志，既撑爆环形缓冲又可能泄露内容。
⚠️ **每个值截断到 60 字符**。

### 同一条教训在本仓库出现过第二次

`errors.ts` 里记过：「一个网关在 HTTP 400 里返回 `模型不可用：deepseek-flash`，
而 400 被正确判为不可重试 ⇒ 一次本可成功的请求被放弃」。

**两次都是同一个问题：日志要能回答"是哪个"，否则它只能回答"出事了"。**