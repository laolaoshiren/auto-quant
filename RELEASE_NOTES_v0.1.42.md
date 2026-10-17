## Bug Fixes

- 修复 AI 工作流里被截断的 JSON 仍显示原文。
- 完整对象后跟中文、单字段长文本现在都能提取成表，不再回落原始 JSON。
- 数组元素（`symbols` / `arguments` / `matches`）每个元素一行。
- 字段名与英文枚举中文化：补 `side` / `strength` / `arguments` / `invalidates` / `summary` / `symbols` / `structure` / `support` / `resistance` / `evidence` / `point` / `why` / `matches` / `dataGaps` / `indicators` / `patterns`。
- 值里的英文枚举中文化：`short_or_no_trade` / `strong` / `moderate` / `weak` / `long` / `short`。

### Install

`pwsh -File scripts/deploy.ps1`（本项目不走 Docker）。
