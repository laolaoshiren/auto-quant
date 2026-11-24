# 智能托管 2.0（`ai_managed` 2.0）架构规范与里程碑总表

> **单一真相源（防上下文压缩 / 跨会话走偏）**  
> 本文件是 `ai_managed` 2.0 工程的永久架构蓝图与进度总表。任何新会话或 `/goal` 推进某个里程碑之前，必须先读本文件与本地 `.dsh/state.md`。  
> 配套架构决策：[`decisions/ADR-0005-ai-managed-2-architecture.md`](decisions/ADR-0005-ai-managed-2-architecture.md)。

---

## 0. 目标与核心定位

1. **产品目标**：打造真正能够长期稳定盈利、风控严密、减少人工干预的 **智能托管模式（`ai_managed`）**。
2. **对标与超越基准**：
   - 吸收实战已验证的盈利内核：**高信噪比量化多因子选币雷达（自研 AI500 级）+ 筹码结构/增量 Δ 预计算 + 精炼上下文（≤ 3 万字）+ `4h / 15m / 1m` 黄金三周期 + 三段式纪律决策（`plan → notes/thesis → finalize`）+ 大盈亏比（3:1 ~ 5:1）波段持仓管理**；
   - 在此基础上超越：原生支持**多空双向顺势**、**交易所侧结构移动止损 + 持仓论点时间止损/MAE 机器硬检查**、**不可绕过的物理安全硬底线**，以及**实盘成交归因反哺权重校准**。
3. **架构原则（借壳换脑 · 零历史包袱）**：
   - **底座 100% 复用**：Binance / Gate 双交易所实盘与测试网执行器、模拟盘钱包、`RiskEngine` 统一硬风控（含 `AI_MANAGED_HARD_LIMITS`）、对账引擎、SQLite、API、Quill 前端控制台；
   - **大脑 100% 独立重写**：新代码一律写在 `packages/server/src/radar/` 与 `packages/server/src/managed/` 两个独立解耦目录（每个模块小而纯、可独立单测与离线回测），**禁止继续往 1.47 万行 `autoTrader.ts` 与 4,500 行 `prompt.ts` 里堆业务补丁**；`autoTrader.ts` 仅在 `mode === 'ai_managed'` 入口处保留极薄路由委托。
4. **其余模式边界**：
   - `strategy`（固定策略）：保持稳定运行，作为实盘/测试网对照组；
   - `jev`（JEV 模式）：已停用，不再投入维护；待 `ai_managed` 2.0 跑稳后统一清理；
   - `ai_team`（多智能体模式）：保持暂缓，等待后续独立重构。

---

## 1. 硬性工程契约（任何里程碑不可违反）

| 契约项 | 硬要求 |
|---|---|
| **唯一风控路径** | 所有开仓/加仓/减仓/平仓/调保护位仍必须经过 `RiskEngine`；`AI_MANAGED_HARD_LIMITS`（持仓 ≤10、BTC/ETH ≤20x、山寨 ≤10x、保证金 ≤80%、强制止损、日亏 ≤15%、总回撤 ≤35%）不可被 AI 绕过。 |
| **模型绑定** | `ai_managed` 统一通过系统 magpie 网关调用 `AI_MANAGED_PRESET_MODEL`（`workbuddy/deepseek-v4.1-flash`），绝不静默回落到其它模型。 |
| **Prompt 信噪比红线** | 新内核单轮 User Prompt 严格控制在 **≤ 30,000 字符**（目标 18,000–26,000 字符），只展开 **Top 3–5 高分起爆标的 + 当前持仓**；所有数字预先算成结论、百分比偏移与 15m 环比增量 `Δ`，绝不甩原始数组让 LLM 自己做算术。 |
| **K 线三周期契约** | `ai_managed` 2.0 固定使用 **`4h`（大趋势）+ `15m`（结构与突破）+ `1m`（精准入场与止损位置）** 各 30 根干净 OHLCV。 |
| **高观望纪律** | 宁可连续多轮 `WATCH`，绝不强行开仓；入场必须同时满足「雷达评分达标 + 结构位置合理 + 量能/资金流确认 + 可验证失效位」。 |
| **大盈亏比保护** | `ai_managed` 默认关闭会提前砍死波段赢家的早期 `drawdown_guard`；依靠「交易所侧止损/结构上移止损 + 持仓论点 `thesis`（时间止损 & MAE 硬检查）+ 分批减仓留底仓」放大盈亏比。 |
| **每步可验证** | 每个子任务完成后必须过 `npm run typecheck` + `npm test`（碰交易链路加 `npm run sim` 18/18）+ 独立 commit + 更新本文件勾选框与 `.dsh/state.md`。 |

---

## 2. 四个里程碑与原子任务清单

> **推进约定**：每完成一个子任务，立即把 `[ ]` 改为 `[x]` 并标注对应 `commitShort`。会话若因额度中断，恢复后对照本表与 `git log` 从第一个未勾选任务无缝续跑。

### 🏁 里程碑 1（M1）：基础清障与大盈亏比松绑（上实盘前必清地雷）

**目标**：消除现系统阻塞 `ai_managed` 盈利与可靠性的 4 个基础硬伤，让模拟盘数据可信、让大赢家不再被提前砍死。

- [x] **M1.1 释放 `ai_managed` 大盈亏比空间**（`d40ca37`）：`unboundedAiManagedConfig()` 默认关闭早期机械 `drawdownGuard`（`enabled: false`），并开启交易所侧保本（`breakevenTriggerPercent: 5`）与移动止损（`trailingStopPercent: 1.5`）基线；兼容已有测试并补充回归单测。
- [x] **M1.2 打通 AI 自选币与风控白名单**（`d40ca37`）：允许 `ai_managed` 在当轮通过 `get_klines` 查验过的合法合约标的热加入本轮可执行池（上限 5 个，仍严格校验交易所可交易性、排除稳定币、`minQuoteVolume24h` 流动性底线与风控，且严格隔离固定策略模式），彻底根治「自己选的币被风控以不在候选池拒杀」。
- [x] **M1.3 限价单防穿透止损闭环**（`10a5175`）：风控 §6/§6b 拦截现价已穿止损与无安全缓冲的立即可成交限价单；`submitLimitEntry()` 下单前执行 `isValidTrigger` 校验并落库拒绝原因；30 秒实时守卫 `runGuardTick()` 主动巡检结清已成交限价单（将裸仓窗口从 10–20 分钟压缩至 ≤ 30 秒）；`promotePendingEntry()` 转正前复检止损有效性，已穿越则立即平仓防裸仓。
- [x] **M1.4 模拟盘真实摩擦模型**（`10a5175`）：为模拟盘（`dryRun`）增加可配置市价单不利滑点（默认 `0.03%`，`AQ_PAPER_SLIPPAGE_RATE=0` 可关闭，限价单仍按委托价精确成交）与 8 小时 UTC 结算点资金费估算（读取缓存标的资金费率，默认 `0.01%` 兜底，`AQ_PAPER_FUNDING_ENABLED=false` 可关闭），使模拟盘净收益真实反映实盘摩擦。
- [x] **M1 验收与上线**（`d40ca37` + `10a5175`）：`typecheck` 0 · `lint` 0 · `check:links` 107/236 · 全量 `npm test` 绿（`@aq/shared` 82/82、`@aq/server` 2434/2434、`@aq/web` 457/457、`test:feed` PASS）· `npm run sim` 18/18 · 已同步部署验证上线。

---

### 🏁 里程碑 2（M2）：自研「AI500 多因子选币雷达 + 筹码结构引擎」+ 精简 Prompt

**目标**：建立独立、纯函数、可回测的 `packages/server/src/radar/` 与 `packages/server/src/managed/prompt.ts`，让 DeepSeek v4.1-flash 从 15.5 万字噪音中解放出来，聚焦在 Top 3–5 真正具备短期爆发力的标的上。

- [x] **M2.1 全市场 6 维「AI500 评分雷达」（`packages/server/src/radar/ai500.ts`）**（`68df2e6`）：
  - 流动性硬过滤（成交额 + OI 门槛，剔除稳定币与垃圾低流动币）；
  - 6 维量化评分（0–100 + `bias: long | short | neutral` + 结构化触发/警示标签）：
    1. 多周期趋势共振（`4h` / `1h` / `15m` EMA 斜率与排列一致度）
    2. 放量真突破 & K 线实体饱满度（过滤长影线插针与缩量假突破）
    3. 合约资金流共振（OI 增仓同向确认，区分真资金进场与空心拉盘）
    4. Taker 主动买卖盘净流 & CVD（直接利用交易所 K 线自带主动买量字段）
    5. 资金费率挤压与拥挤度（捕捉轧空/轧多机会，规避过度拥挤追高）
    6. 相对 BTC 超额强弱（RS Alpha）+ 启动位置性价比（奖励蓄势突破，严惩偏离均线 >2.5×ATR 追单，风险标签置顶永不截断）
  - 严格按雷达综合分排序，输出 **Top 3–5 候选**，支持可配置准入红线（默认 `≥ 75` 强关注、`≥ 65` 观察）。
- [x] **M2.2 筹码结构 & 清算簇代理引擎（`packages/server/src/radar/volumeProfile.ts`）**（`68df2e6`）：
  - 基于近期 `15m` K 线成交额按价格 24 档分桶（实体 60% / 振幅 40% 加权），计算 **POC（筹码最密集价）**、**Value Area（70% 价值区）**、**上方阻力墙 & 下方支撑墙（Walls）** 及其相对现价的 `%` 偏移；
  - 基于近期显著波段高低点与常见杠杆倍数（5x/10x/20x）估算去重后的上下方止损/清算磁吸区；
  - 所有结果直接输出为结构化单行文字结论。
- [x] **M2.3 15 分钟环比增量追踪器（`packages/server/src/radar/deltaTracker.ts`）**（`68df2e6`）：
  - 按机器人实例 + 标的缓存上一轮雷达与结构快照，输出 **15m Δ**（`AI500 Δ`、`现价 Δ%`、`OI Δ%`、`Taker 买比 Δpp`、`POC 偏移 Δpp` 与 `accelerating/steady/fading/reversing` 动能状态），超 90 分钟自动失效防陈旧增量。
- [x] **M2.4 `ai_managed` 2.0 精简结构化 Prompt（`packages/server/src/managed/prompt.ts` + `packages/server/src/managed/cycle.ts`）**（`68df2e6`）：
  - 只展开 **Top 4 雷达高分标的 + 当前持仓**，附 Top 10 一行极简雷达榜；
  - K 线切为 **`4h + 15m + 1m`** 各 30 根干净 OHLCV（含 `tb%`），5 级自动压缩保证单轮 User Prompt **硬红线 ≤ 30,000 字符**，且拆分 `stablePrompt / volatilePrompt` 保留前缀缓存；
  - 极薄委托接入 `autoTrader.ts` 的 `mode === 'ai_managed'` 路径，其它模式零字节变动，保留前端决策流与审计兼容。
- [x] **M2 验收与上线**（`68df2e6`）：`typecheck` 0 · `lint` 0 · `check:links` 107/236 · 全量 `npm test` 绿（`@aq/shared` 82/82、`@aq/server` 2443/2443 含 9 项 M2 雷达/筹码/Δ/端到端测试、`@aq/web` 457/457、`test:feed` PASS）· `npm run sim` 18/18 · 已部署上线并现场验证 `#19` 首轮实跑。

---

### 🏁 里程碑 3（M3）：VergeX 级「三段式决策 + 持仓论点 `thesis` + 反例衰减记忆 + 战术面板」

**目标**：让 `ai_managed` 的持仓管理（加仓、减半锁利、上移止损、时间止损、果断离场）达到“游刃有余”的专业交易员水准。

- [x] **M3.1 持仓论点 `thesis` 与机器硬检查（`packages/server/src/managed/thesis.ts` + SQLite 迁移 `v20`）**（`d29c18b`）：
  - 新增 SQLite 迁移 `v20`（`managed_theses` / `managed_notes` / `managed_radar_latest`）及退出原因 `thesis_time_stop` / `thesis_mae_stop`；每笔持仓开仓即绑定结构化论点（开仓依据、加仓/减仓/失效触发、`time_stop_at` 时间止损、`max_adverse_excursion_pct` MAE、入场快照与峰值 `R`）；
  - 30 秒监控层 `runGuardTick()` 接入 `applyThesisHardGuard()` 对 `time_stop` 与 `MAE` 执行**确定性机器硬检查**，触线自动平仓并记明确原因（已登记 `riskOnlyPath.test.ts` 降暴露白名单）。
- [x] **M3.2 持仓战术仪表盘（`packages/server/src/managed/tactics.ts`）**（`d29c18b`）：
  - 每轮为每个持仓预计算并注入 Prompt：当前 **`R` 倍数**与峰值 `R`、距止损/止盈的 ATR 距离、**+50% 金字塔加仓模拟（合并均价 + 含手续费零风险保本止损位）**、以及入场至今的 AI500/OI/Taker 动能衰减提示；
  - 明确给出战术阶段指引（`trial` 试仓 → `pyramid_ready` ≥1R 无风险金字塔加仓 → `scale_out_lock` 2R+/动能衰减分批减仓锁利与非整数位结构上移止损 → `defense` 防守）。
- [x] **M3.3 反例衰减笔记（`packages/server/src/managed/notes.ts`）**（`d29c18b`）：
  - 升级跨轮记忆：按 `(trader_id, symbol)` 唯一键替换语义、强制校验**可验证价位/指标触发条件**（`hasVerifiableTrigger`）、**`counterexamples` 反例计数**自动降权（`1/(1+n)`，累计 `≥ 3` 自动退休）、7 天过期与离池 24h 自动退休。
- [x] **M3.4 三段式 Agentic 决策循环 + 前端雷达/论点面板（`packages/server/src/managed/engine.ts` + `ManagedIntelPanel.tsx`）**（`d29c18b`）：
  - 落地原生 function-calling 三段式流程：`plan` → `update_notes` / `update_thesis` / `get_klines` → `finalize`（永不空决策，自动补齐漏报持仓 `hold` 与漏报候选 `wait`，并兼容纯文本 `<decision>` 回落）；
  - 后端新增鉴权只读接口 `GET /api/traders/:id/managed-intel`，前端仅在 `ai_managed` 详情页渲染 `<ManagedIntelPanel>`（彩色 AI500 雷达徽章联动切图、持仓论点 `thesis` 与时间止损/MAE 卡片、可折叠反例衰减笔记），真实无头浏览器 8/8 视口×主题巡检零重叠/零横向溢出/零报错。
- [x] **M3 验收与上线**（`d29c18b`）：`typecheck` 0 · `lint` 0 · `check:links` 107/236 · 全量 `npm test` 绿（`@aq/shared` 82/82、`@aq/server` 2448/2448 含 5 项 M3 端到端单测、`@aq/web` 457/457、`test:feed` PASS）· `npm run sim` 18/18 · 无头浏览器 UI 巡检 8/8 PASS · 已部署上线并现场验证 `v20` 迁移与运行态。

---

### 🏁 里程碑 4（M4）：实盘小额观察、归因校准与旧包袱清理

**目标**：用真实子账号小额资金跑出长期正期望，并根据真实成交归因优化权重、彻底瘦身代码库。

- [x] **M4.1 模拟盘 & Gate 测试网长周期指标过关与实测缺陷修复**（`cd158db`）：
  - 完成模拟盘智能托管 2.0 连续 7h+ 实跑与 Gate 测试网 24h 对照组遥测验收（22/22 周期 0 失败、Prompt 峰值 27,938 字稳守 ≤ 3 万字、平均前缀缓存命中 48%、含滑点手续费后胜率 87.5% / PF 3.25 净盈利）；
  - 现场定位并根治遥测暴露的 3 项硬伤：① 彻底断开旧 1.0 `AgentRuntime` 后台改参对 `ai_managed` 2.0 的干扰（杜绝其重启早期 `drawdownGuard` 截断波段赢家与刷出未结算实验告警）；② 过滤池外非变更 `wait`/`skip` 避免误报 `rejected` 并触发无效的回执追问调用；③ 清洗观察笔记双重 `触发[...]` 包裹。
- [x] **M4.2 子账号小额实盘就绪门禁与安全护栏**（`cd158db`）：
  - 新建只读实盘就绪评估器 `packages/server/src/managed/readiness.ts`（覆盖决策稳定性、3 万字红线、波段松绑、保护完整度、滑点后净期望与**主账号硬阻断红线**），接入 `GET /api/traders/:id/managed-intel` 与前端可折叠「归因/就绪」面板；
  - 已完成实盘子账号只读 API 连通性与零仓位核验（严守绝不触碰主账号红线；子账号当前余额为 0 USDT，待划转小额测试资金后即可一键开启实盘观察）。
- [x] **M4.3 成交归因反哺 AI500 因子权重**（`cd158db`）：
  - 新增 SQLite 迁移 `v21（managed-v2-attribution）`：`managed_theses` 持久化入场 6 维 AI500 分数与准入档位，平仓回填 `closed_trade_id` / `realized_net_pnl` / `realized_r` / `close_reason`，新建 `managed_radar_calibration` 校准表；
  - 新建纯函数归因校准引擎 `packages/server/src/radar/attribution.ts`（计算各因子皮尔逊相关 `r`、赢/亏均值差与高低组胜率，内置 `≥ 15` 笔最小样本门槛、样本收缩、单因子 `[8, 30]` / 总和 `= 100` / 最大偏移 `±4` 与红线梯度防过拟合护栏），`ai500.ts` 与 `cycle.ts` 自动消费已校准权重与准入红线。
- [x] **M4.4 彻底清理废弃历史包袱**（`cd158db`）：
  - 彻底停用并拦截 `jev` 模式的新建（API 返回 400）与启动/单次运行（`TraderManager` 拦截），移除前端新建弹窗 JEV 选项、`JevSettings.tsx` 与决策流 JEV 调参页签，保留既有已停止历史记录只读归档展示（徽章标为 `JEV 已停用`）；同步切断旧 1.0 `ai_managed` 后台改参与自检噪声路径。
- [x] **M4 验收与上线**（`cd158db`）：`typecheck` 0 · `lint` 0 · `check:links` 107/236 · 全量 `npm test` 绿（`@aq/shared` 82/82、`@aq/server` 2453/2453 含 5 项 M4 归因/就绪/回归测试、`@aq/web` 457/457、`test:feed` PASS）· `npm run sim` 18/18 · 真实无头浏览器 UI 巡检 8/8 PASS（含「归因/就绪」展开与无 JEV 新建验证）· 已部署上线并现场验证 `v21` 迁移与运行态。
