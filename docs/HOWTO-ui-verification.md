# UI 验证方法（含一次真实踩坑）

> 2026-10-15。本文记**怎么在这个项目里验证界面**，以及一条让 UI 检查"假失败"了很久的坑。
>
> ⚠️ 仓库约定（`docs/AGENTS.md` §3.2）：**说"这个页面好了"之前，必须在真实浏览器里点过它。**
> 编译通过不等于能用。

---

## 1. 正确的验证方式

```powershell
# ① 建隧道：本地端口 → 线上服务（服务只听 172.17.0.1:3200，不对外）
ssh -N -L 27201:172.17.0.1:3200 <ssh-alias>

# ② 签一枚 owner token（见第 3 节，不要用密码）
# ③ 跑冒烟检查
$env:AQ_TOKEN = <token>
$env:UI_SMOKE_URL = "http://127.0.0.1:27201"
node scripts/ui-smoke.mjs
```

**它检查什么**（`scripts/ui-smoke.mjs`）：10 个路由 × 3 档缩放 ——
渲染是否成功、控制台有没有错误、**150% 缩放下有没有横向滚动**。

---

## 2. ⚠️ 那条坑：旧隧道进程残留会让检查**假失败**

### 症状

```
❌ 发现 11 个问题：
   · 总览 /           被重定向到 /login —— 路由没匹配上或未登录
   · 机器人 /traders   被重定向到 ...
   （10 个路由全部如此）
```

而**同一枚 token 用 curl 直接请求 `/api/auth/me` 是 200**。

### 根因

**本地有残留的 ssh 隧道进程占着同一个端口**，于是：
```
新起的隧道 → 端口被占 → ExitOnForwardFailure 让它退出
而旧的残留隧道仍在监听 → 请求经它转发
⇒ 旧隧道连的是【另一个时刻的连接】，行为与当前不一致
```

⚠️ 本机还跑着代理软件（Clash 一类），而 SSH 别名可能被解析到
**`198.18.0.0/15`** —— 那是 Clash 的 **fake-IP 保留段**（RFC 2544 基准测试段，
代理用它做域名映射）。代理会把同一个域名在不同时刻映射到不同出口，
**让"看似同一个隧道"实际不是**。

### 修法

```powershell
# 每次建隧道前先清掉残留
Get-Process ssh -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# 用【全新端口】建（不要复用刚才那个）
ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -N -L 27201:172.17.0.1:3200 <alias>
```

**判据：先确认隧道通且 token 可用，再跑检查。**
```
① curl http://127.0.0.1:<port>/api/health          → 200
② curl -H 'Authorization: Bearer <t>' .../api/auth/me → 200
两条都过再跑 ui-smoke；否则先修隧道，不要怀疑产品。
```

---

## 3. 怎么签一枚可用的 owner token

**不要问密码** —— 用服务自己的 `signToken`。⚠️ 两个坑：

```ts
// 坑①：secret 不是环境变量，是 <数据目录>/.jwt.secret
//      （`env.ts` 的 resolveJwtSecret()：有 JWT_SECRET 用它，否则读文件，都没有才生成）
const secret = readFileSync('<数据目录>/.jwt.secret', 'utf8').trim();

// 坑②：credAt 必须用 users.credentialsChangedAt()，【不能直接读列】
//      库里 credentials_changed_at 可能是空字符串 ""，
//      而 isTokenRevoked 的比较是 (payload.credAt ?? 0) !== (cur ?? 0)
//      —— `?? 0` 对空字符串【不生效】，于是 "" !== 0 成立 ⇒ 令牌被视为已撤销
const credAt = users.credentialsChangedAt(id) ?? 0;

signToken({ sub: id, username, role, credAt }, secret);
```

**token 有效期 30 天**，且服务有**滑动续期**：
```
成功请求后若剩余不足一半 → 签发新 token 放进响应头 `x-refreshed-token`
```
⚠️ 所以**同一枚 token 反复手工测试可能在第 N 次失败** ——
那不是 bug，是续期机制。要连续测就每次重新签。

---

## 4. 怎么看**团队模式**的界面

`ui-smoke` 只跑 `/traders/<第一条数据>`，而**团队看板只在 `mode === 'ai_team'` 时渲染**
（`DecisionFeed.tsx` 的判据）—— 所以要看团队机器人那一页。

判据（**量，不要看**）：
```
① 页面可见文本里有没有团队特征词（岗位名/阶段名）
② 有尺寸的容器数量与最大高度 —— 0 高度说明没渲染
③ scrollWidth vs clientWidth —— 判断有没有横向滚动
④ 控制台错误数
```

实测（`#11`，1600×1000）：
```
页面可见文本 8288 字
命中特征词：裁决、风控、做多、做空、行情分析、技术面、新闻、情绪（8/10）
有尺寸的容器 393 个 · 最高 703px
横向滚动：无 · 控制台错误 0 条 · 150% 缩放无横向滚动
```

界面结构（截图确认）：
```
顶部：账户余额 / 交易盈亏 / 保证金占用 / 持仓 / 胜率
中间左：归属权益曲线（含"本段变化"）
中间右：**AI 工作流看板** —— 按部门分组（管理 / 研究 / …），
        每个岗位有中文状态词（进行中/已完成/失败/在岗/规划中）
        顶部一行阶段链：派发 → 并行分析 → 多空辩论 → 裁决 → 风控把关
底部：当前持仓 / 当前委托 / 历史成交 / 订单记录
```

---

## 5. ⚠️ 一次"我怀疑界面说谎、结果是我错了"

界面显示「周期 #240 · 结论：空仓（模型没有给出任何决策）」，而
**那一轮的 `raw_response` 有 15,317 字** —— 看起来像"明明有内容却说没有"。

查清后的真相：
```
<decision>
[]
</decision>

⇒ 裁决官【真的】输出了空数组 []，15KB 全在 <team> 与 <risk> 块里
⇒ 界面文案是【准确的】
```

**教训**：`raw_response` 很长 ≠ 有决策 —— 团队审计块本身就占十几 KB。
判据要落在 **`<decision>` 块的内容**上，而不是整条回复的长度。

（这与本仓库反复出现的"判据不能区分目标与噪声"是同一类错误：
我这次差点又用它去改一个不存在的问题。）
