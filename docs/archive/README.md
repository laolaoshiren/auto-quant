# 历史归档（docs/archive）

> **这里的文件都是历史记录，不代表当前行为。**
> 需要判断"现在是怎么做的"时，以代码、测试与根目录的长期文档为准
> （[`../AGENTS.md`](../AGENTS.md)、[`../ARCHITECTURE.md`](../ARCHITECTURE.md)、
> [`../MODULES.md`](../MODULES.md)、[`../DEVELOPMENT.md`](../DEVELOPMENT.md) 等）。

## 为什么有这个目录

`docs/` 根目录只保留**长期有效**的文档（工程手册、架构、模块地图、部署、发版、API 等）。
一次性的调查 / 验证 / 实验 / 提案记录在闭环之后移到这里，避免新读者把"当时的结论"
误读成"现在的行为"。

每份归档文件的开头都有一行归档说明（归档时间 + 理由）。

## 目录内容

| 类别 | 文件 | 说明 |
| --- | --- | --- |
| 调查 / 复盘 | `FINDING-*.md` | 2026-09 ~ 2026-11 的一次性缺陷调查。结论已并入代码、测试或长期文档 |
| 验证 / 复核 | `VERIFY-*.md` | 任务完成时的独立验证报告（含对抗式复核） |
| 智能体交付记录 | `AGENT-*.md` | 多智能体过渡期的交付说明 / 部署记录 / 观察 |
| 监控日志 | `MONITORING-LOG.md`、`MONITORING-REPORT.md` | 过渡期监控台账 |
| 一次性操作 | `ONEOFF-*.md`、`TRIAGE-20261013-external-issues.md`、`REPORT-TRIAGE-20260926.md`、`VERIFY-constraints-and-orders.md` | 已执行完的数据/账本/外部 issue 处理记录 |
| 提案（未实现或已被取代） | `PROPOSAL-*.md` | 当时待评审的方案；**不是当前实现** |
| JEV 实验 | `JEV-EXPERIMENT.md`、`JEV-FINAL-CONCLUSION.md`、`JEV-MONITOR-LOG.md`、`JEV-RISK-CHASING.md`、`JEV-README.md` | JEV 实验的完整过程与结论。JEV 模式本身保留，设计见 [`../JEV-MODE-DESIGN.md`](../JEV-MODE-DESIGN.md) |
| 其它 | `给用户的说明.md`、`团队模式-进度看板.md` | 一次性说明 / 自述已过时的状态快照 |

## 新增归档的流程

1. 确认该文档确实是一次性的（结论已闭环、或已被新文档取代，且**不再被代码/长期文档依赖**）。
2. 脱敏：任何真实域名 / IP / SSH 别名 / 服务器路径替换成占位符（判据见 [`../AGENTS.md`](../AGENTS.md) §7）。
3. `git mv docs/<文件> docs/archive/<文件>`，并在开头加一行：
   `> **归档于 YYYY-MM-DD：<已闭环 / 已被 XXX 取代>，仅作历史记录，不代表当前行为。**`
4. 更新引用：代码注释与文档里的 `docs/<文件>` → `docs/archive/<文件>`；文档内相对链接按新目录调整。
5. 跑 `npm run check:links` 与 `npm run typecheck`。
