# auto-quant

**用自然语言定义策略的加密货币自动交易终端。**

[![CI](https://github.com/laolaoshiren/auto-quant/actions/workflows/ci.yml/badge.svg)](https://github.com/laolaoshiren/auto-quant/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-blue)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-no%20copyleft-brightgreen)](THIRD-PARTY-NOTICES.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

策略不是一堆参数，而是一段中文描述。模型每个周期读取市场、做出决策、执行下单、留下完整推理；
而一个**独立于模型的风控引擎**会审查并钳制它发出的每一张订单。

> 模型负责判断，运行时负责裁决。

---

## 🚀 一键部署

在一台**全新服务器**上，一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/laolaoshiren/auto-quant/main/deploy/install.sh | bash
```

**就这一条，不需要任何其他操作。** 它会自动完成：

- 识别系统、补齐缺失的基础工具（**包括系统里没有 `bash` 的情况**）
- **安装 Docker 与 Compose**（如果没有）
- 生成配置与随机密钥
- 拉取镜像、启动服务、等待健康检查通过
- 打印访问地址与登录凭据

**你不需要预先安装任何东西** —— 不用 Node、不用源码、不用懂 Docker，也不需要任何令牌。

支持 Debian / Ubuntu、RHEL / CentOS / Rocky / Alma、Fedora、
**Alpine（含没有 bash 的精简镜像）**、Arch、openSUSE。仅支持 x86_64。

之后更新到最新版本，**还是这一条命令**。

> 不使用管道也可以，效果相同：
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/laolaoshiren/auto-quant/main/deploy/install.sh -o install.sh
> sudo bash install.sh
> ```
>
> 需要 root 权限 —— 安装器在没有 root 时会自动用 sudo 重新执行自己。
> 用管道时 sudo 会从终端读取密码，不受影响。

📖 完整说明：[deploy/README.md](deploy/README.md) · [部署指南](docs/DEPLOYMENT.md)

📖 完整说明：[deploy/README.md](deploy/README.md) · [部署指南](docs/DEPLOYMENT.md)

---

## ✨ 能力

| | |
| --- | --- |
| 🧠 **自然语言策略** | 用中文描述交易逻辑，不需要写代码。选币、指标、风控、提示词都在控制台里可视化配置 |
| 🛡️ **硬风控引擎** | 杠杆、仓位上限、强制止损止盈、盈亏比、回撤保护、熔断与节流由独立层裁决。**模型无法绕过** |
| 🔍 **完整决策审计** | 每一轮都保存：完整提示词、模型原始响应、思维链、风控的每一次钳制与拒绝及原因 |
| 📊 **账目可与交易所对账** | 按交易所口径核算盈亏，并可从成交历史自动补齐缺失记录 |
| 🔌 **多交易所适配层** | 连接、合约元数据、下单、行情统一抽象，新增交易所只改适配层 |
| 🤖 **多模型支持** | OpenAI 兼容端点、Anthropic、Gemini 等，模型列表可从厂商接口实时拉取 |
| 🧪 **不花钱就能验证** | 策略体检、历史回放、生命周期模拟——不需要真实资金即可验证整条链路 |
| 🐳 **容器化部署** | 服务器不需要 Node、不需要源码、不需要构建 |

---

## 🧭 它是怎么工作的

每个交易机器人循环执行四件事：

```
读取市场结构  →  模型决策  →  风控裁决  →  执行并记录
     ↑                                        │
     └──────────────  下一周期  ←──────────────┘
```

**1. 读取市场结构**
拉取配置的周期与指标，组装成模型能读懂的市场快照。选币可以来自涨幅榜、持仓量增长、静态列表或全市场筛选。

**2. 模型决策**
把市场快照、账户状态、当前持仓和你的策略提示词一起交给模型，要求它输出结构化决策。

**3. 风控裁决 ← 关键的一层**
模型的输出是**不可信输入**。它可能要求 100 倍杠杆、可能忘了设止损、可能给出不合理的盈亏比。
风控引擎逐条审查，能做三件事：

- **拒绝** —— 置信度不足、盈亏比过低、超出仓位上限的提案直接丢弃，并记录原因
- **钳制** —— 杠杆调回上限、名义价值压到预算内、止损挪到合理位置，每次调整都留下记录
- **强制** —— 无止损的开仓一律拒绝；挂不上保护单的仓位立即市价平掉

**4. 执行并记录**
订单、成交、盈亏、决策全过程写入本地库。任何一次"风控推翻了模型"都能事后查证。

---

## 📦 本地开发

需要 **Node.js ≥ 22.5**（使用内置的 `node:sqlite`，无需编译原生模块）。

```bash
npm install
npm run dev          # 后端 → http://127.0.0.1:27137
npm run dev:web      # 前端热更新 → http://127.0.0.1:5173
```

首次启动会创建管理员账号并打印随机密码（**只显示一次**）。

### 验证

```bash
npm run typecheck    # 类型检查
npm test             # 单元测试
npm run verify       # 用真实行情跑通「选币 → 指标 → 提示词 → 解析 → 风控」
npm run sim          # 完整交易生命周期模拟（历史 K 线回放 + 模拟交易所）
npm run sim:live     # 同上，但使用真实模型
```

> `npm run verify` 与 `npm run sim` **不需要任何密钥、不下任何真实订单**，
> 是改动后性价比最高的验证手段。

### 实盘冒烟测试

部署后、投入真实资金前，用最小仓位验证交易所接线是否正常：

```bash
npx tsx packages/server/src/scripts/liveSmokeTest.ts --confirm
```

完整走一遍：预检 → 切换单向持仓 → 设置杠杆 → 市价开仓 → 挂止损 → 挂止盈 →
**回读交易所确认保护单确实存在** → 撤单 → 平仓 → 确认账户干净。

必须有 `--confirm` 才会执行，名义价值上限 20 USDT，清理步骤写在 `finally` 里。
**它会真的花钱**——先用最小仓位。

---

## ⚙️ 配置

环境变量见 [`.env.example`](.env.example)。容器部署由 `deploy/up.sh` 自动生成。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BINANCE_USE_TESTNET` | `true` | 模拟盘 / 实盘。**两者界面完全一致，配错不会报错** |
| `DRY_RUN` | `false` | `true` 时只模拟下单，不触碰交易所 |
| `GLOBAL_TRADING_DISABLED` | `false` | 全局熔断，`true` 时拒绝启动任何机器人 |
| `MASTER_KEY` | 自动生成 | 加密交易所密钥的主密钥 |
| `JWT_SECRET` | 自动生成 | 会话令牌签名密钥 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 自动生成 | 首次启动创建的管理员账号 |
| `BIND_ADDRESS` | `127.0.0.1` | 控制台绑定地址 |

### 策略配置

在控制台「策略工作室」中配置，也可直接编辑数据库中的策略记录。包含四组：

- **选币** —— 来源（涨幅榜 / 持仓量 / 静态列表 / 全市场）、筛选门槛、候选数量
- **指标** —— 周期组合、K 线数量、启用的指标与参数
- **风控** —— 仓位上限、杠杆上限、止损止盈规则、盈亏比门槛、回撤保护、熔断、节流
- **提示词** —— 角色设定、入场标准、决策流程、输出要求，均可自由改写

控制台内置稳健、进取、短线三套预设，可一键套用后微调。

---

## 🏗️ 架构

```
packages/
├── shared/    类型定义、zod schema、指标数学、模型目录
├── server/    Fastify API · 交易所适配层 · 模型客户端 · 策略引擎 · 风控引擎 · 交易运行时 · SQLite 存储
└── web/       React 控制台
```

| 模块 | 职责 |
| --- | --- |
| 交易所适配层 | 连接、合约元数据、签名请求、下单、条件单、行情与用户数据流 |
| 模型客户端 | 多提供商统一接口、错误分类与重试、模型列表发现 |
| 策略引擎 | 选币、指标组装、提示词构建、模型输出解析 |
| **风控引擎** | 通往订单的唯一路径。所有限制与钳制逻辑集中在此 |
| 交易运行时 | 周期调度、持仓对账、保护单管理、成交记录重建 |
| 存储层 | SQLite（内置 `node:sqlite`，零原生依赖） |

深入阅读：[架构与设计取舍](docs/ARCHITECTURE.md) · [模块地图与扩展配方](docs/MODULES.md)

---

## 📚 文档

| 文档 | 内容 |
| --- | --- |
| [开发手册](docs/DEVELOPMENT.md) | 环境、命令、测试策略、调试、常见陷阱 |
| [模块地图](docs/MODULES.md) | 逐文件职责 + 「要加一个新的 X 就改这里」配方 |
| [架构文档](docs/ARCHITECTURE.md) | 设计取舍与关键工程决策 |
| [API 参考](docs/API.md) | 全部 HTTP 端点契约 |
| [控制台视觉规范](packages/web/DESIGN.md) | 色板、字号、间距、布局与响应式断点 |
| [部署指南](docs/DEPLOYMENT.md) | 上线流程、反向代理、安全检查清单 |
| [发布手册](docs/RELEASING.md) | 维护者的发版流程 |
| [AI 代理指南](docs/AGENTS.md) | 面向自动化编码代理的工作约束 |
| [合规清单](docs/LEGAL.md) | 许可证、交易所条款、监管风险的逐项说明 |
| [调研记录](docs/research/README.md) | 交易所与模型接口的一手实测记录 |
| [第三方声明](THIRD-PARTY-NOTICES.md) | 运行时依赖的许可证与版权方 |

---

## 🤝 参与

这是一个**由贡献者利用业余时间维护**的项目。欢迎各种形式的参与。

| 我想…… | 去哪里 |
| --- | --- |
| 报告缺陷 | [开 issue](/issues/new/choose) —— 请带上环境、日志与复现步骤 |
| 提功能建议 / 问问题 | [Discussions](/discussions) |
| 直接动手改代码 | [`good first issue`](/labels/good%20first%20issue) 标签，或先读[开发手册](docs/DEVELOPMENT.md) |
| 了解项目往哪走 | [ROADMAP.md](ROADMAP.md) |
| 了解怎么合作、谁能决定什么 | [GOVERNANCE.md](GOVERNANCE.md) |
| 了解怎么贡献代码 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 求助 | [SUPPORT.md](SUPPORT.md) |
| **报告安全漏洞** | **不要开公开 issue** —— 见 [SECURITY.md](SECURITY.md) |

**最有价值的贡献，是把一个「应该没问题」的地方变成「我验证过了，这是证据」。**

这个项目面对的是会真实亏钱的场景，所以它更看重可验证性而不是功能数量：

- 修 bug 时附带一个**能复现的测试**，比修十个 bug 更有用
- 涉及下单路径的改动，**说明验证到了哪一级**（单元测试 → 模拟 → 实盘冒烟），
  而不是声称"应该没问题"
- 对不确定的事**说"我不确定"** —— 在这个项目里，一个自信的错误判断会让人亏钱

提交前的三条底线：`npm run typecheck`、`npm test`、`npm run build` 全部通过。
改动影响交易逻辑时，再加一次 `npm run sim`（历史回放，不花钱、不下单）。

版本间的变更记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## ⚠️ 风险提示

自动交易会造成**真实资金损失**。

- 先用模拟盘跑够时间，确认策略与风控行为符合预期
- 使用**只有交易权限、禁止提现**的 API Key，并绑定 IP 白名单
- 投入前先跑一次实盘冒烟测试
- 不要投入无法承受损失的资金

**使用者责任**：本项目是工具，不是投资建议，不对任何交易结果作出担保。
你需要自行确认：

- 你所在辖区**允许**进行加密货币合约交易
- 你的使用方式**符合**目标交易所的服务条款（包括其地理资格要求）
- 你的策略与交易行为符合当地法律法规

交易所会在 API 层面强制地理资格限制 —— 位于受限地区时会直接返回错误，
本项目**不提供也不计划提供**任何绕过此类限制的功能。

上述各项的完整说明见 [合规与法律风险清单](docs/LEGAL.md)。详见 [LICENSE](LICENSE)。

---

## 📄 许可

[Apache License 2.0](LICENSE) —— 可自由使用、修改、分发与商用，包括专利授权。
再分发时请保留版权声明与 [NOTICE](NOTICE)。

第三方组件的许可证见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
合规与法律风险的完整说明见 [docs/LEGAL.md](docs/LEGAL.md)。
