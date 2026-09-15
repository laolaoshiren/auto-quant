# 发版手册

面向**维护者**。贡献流程见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)，
部署细节见 [`DEPLOYMENT.md`](DEPLOYMENT.md) 与 [`../deploy/README.md`](../deploy/README.md)。

本项目**下真实订单**，所以一次发布会影响正在跑着的机器人。
本手册的目的不是走流程，而是让"这次发布要改什么"在发布之前就被看见。

---

## 1. 版本号策略

当前项目是 **0.x**。按语义化版本，`0.x` 的**次要版本可以包含破坏性变更** ——
但这只是允许，不是免于说明：这个项目的破坏性变更会打到已经部署的服务器上，
所以它必须单独成节、写清"升级的人要做什么"。

什么算破坏性变更（都需要打 `breaking` 标签）：

| 变化 | 为什么是破坏性的 |
| --- | --- |
| 环境变量改名、删除或默认值反转 | 部署方的 `deploy/.env` 会静默失效 |
| `StrategyConfigSchema` 新增**无默认值**的必填字段 | 已存在的策略读取失败并整体回退到默认配置，用户的策略被换掉 |
| `docs/API.md` 里已有端点的契约变化 | 控制台与外部脚本会按旧契约调用 |
| `data/` 的数据库迁移不可回退 | 回滚镜像会读到新 schema |
| `CloseReason`、`DecisionAction` 等**持久化机器码**的值变化 | 等于改写历史账目 |

版本增量由标签推导（[`.github/release-drafter.yml`](../.github/release-drafter.yml)）：
`breaking` / `enhancement` → **次要**版本，`bug` / `perf` / `docs` / `dependencies` → **补丁**版本。

> **1.0.0 由人决定，不自动发生。** 配置里刻意没有 `major` 规则：
> "这次破坏性变更够不够格升到 1.0"是产品决策，不该由一次自动标签替人做出。
> 真要发 1.0 时，直接把草稿的名字与标签改成 `v1.0.0` 再发布。

---

## 2. 发版步骤

### 0. 前提：`main` 是绿的

CI（类型检查 / 测试 / 构建 / 密钥扫描 / 提交信息规范）必须在 `main` 上通过。

> ⚠️ 发布前确认 `main` 是绿的。仓库已开源，分支保护可用（见 CONTRIBUTING.md），所以「`main` 是绿的」
> 只能靠人去看 CI 结果，没有机制帮你拦。这一点在
> [`../CONTRIBUTING.md`](../CONTRIBUTING.md) 的「仓库设置」一节里有说明。
> 本手册里的任何一步都不依赖分支保护，缺少它不会让发版流程失败。

### 1. 核对发布说明草稿

打开仓库的 **Releases → Draft**。

[`.github/workflows/release-drafter.yml`](../.github/workflows/release-drafter.yml)
在每次合入 `main` 时都会重算这份草稿，所以它此刻应当是完整的。

逐项确认：

- **「破坏性变更」一节是不是空的。** 如果不空，说明这次升级需要人做点什么 ——
  把"要做什么"补成明确的操作步骤，而不是只留一行 PR 标题。
- 分类对不对。分错了通常是标签漏打：补上标签后在 Actions 里手动跑一次
  "发布说明草稿"工作流即可重新生成，**不需要**为了刷新说明再合一个 PR。
- 「其他」里有没有本该归类的内容。这里堆得多，说明标签规则需要补。
- 版本号是否是本次应有的增量（见第 1 节）。

### 2. 给提交打标签并推送

```bash
git switch main && git pull
git tag v0.2.0
git push origin v0.2.0
```

> **为什么明确推送标签，而不是靠"发布草稿时自动创建标签"**：
> 发布草稿确实会创建标签，但它是否触发 `push` 事件属于实现细节 ——
> 而镜像构建正是这条链路上最关键的一步，不能建立在一个需要推断的行为上。

推送 `v*` 标签会触发
[`docker-publish.yml`](../.github/workflows/docker-publish.yml)，它**无条件构建**（不要求先跑 CI），
产出这些镜像标签：

| 触发 | 产出的镜像标签 |
| --- | --- |
| 推送 `v0.2.0` | `ghcr.io/<owner>/<repo>:0.2.0`、`:0.2`、`:sha-<短哈希>` |
| 合入 `main`（CI 通过后） | `ghcr.io/<owner>/<repo>:latest`、`:sha-<短哈希>` |

> `latest` 带 `enable={{is_default_branch}}`，而标签推送**不是**默认分支，
> 所以 `:0.2.0` 这一次不会产出 `latest`。这是预期行为：`latest` 始终由 `main` 的构建维护。
> 因为标签指向的提交就在 `main` 上、且已经通过 CI，两者的镜像内容是一致的。

构建完成后在仓库的 **Packages** 页面确认 `0.2.0` 与 `0.2` 都已出现。

### 3. 发布草稿

回到 Releases → Draft，点 **Publish release**。草稿的正文就是发布说明，
这一步只是把它从"草稿"变成"已发布"，不会再重新生成内容。

### 4. 更新服务器

见下一节。发布说明里已经带了升级命令。

---

## 3. 服务器怎么更新

日常升级只有一条命令，`latest` 会拉到刚刚由 `main` 构建出来的镜像：

```bash
cd <部署目录>/deploy && ./up.sh
```

要**固定版本**（典型场景是回滚、或先在一台机器上验证），在 `deploy/.env` 里覆盖镜像地址：

```bash
AUTOQUANT_IMAGE=ghcr.io/<owner>/<repo>:0.2.0
```

`AUTOQUANT_IMAGE` 的优先级高于脚本内置的默认值，改完再跑一次 `./up.sh` 生效。
也可以用环境变量临时覆盖一次（例如切到某个 `sha-<短哈希>` 排查问题）：

```bash
AUTOQUANT_IMAGE=ghcr.io/<owner>/<repo>:sha-1a2b3c4 ./up.sh
```

几条实际会遇到的事：

- **升级前先备份**：`./up.sh backup` 会把数据库与主密钥打包成
  `backup-autoquant-<时间戳>.tar.gz`。回滚镜像不会动数据卷，但**如果那次发布带了
  不可回退的迁移，回滚镜像会读到新的 schema** —— 这是唯一一类备份能救回来的情况。
- **不要在同一台机器上混用 `latest` 与固定版本**：`latest` 会随 `main` 每次构建前移，
  一旦某次发布需要回滚，固定版本的那台机器与另一台会悄悄跑在不同版本上。
- 镜像为公开，无需登录即可拉取。若你复刻成了私有镜像，需先 `docker login ghcr.io`，
  令牌勾选 `read:packages` 即可，做一次之后会自动复用凭据。

---

## 4. 发布前检查清单

在**能访问币安的机器**上跑（GitHub 托管 runner 位于币安的限制区域，
所以这几步在 CI 里是被跳过或降级处理的，见 [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml)）。

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`（控制台）
- [ ] `node scripts/generate-notices.mjs` —— 之后 `git diff` 必须为空。
      脚本遇到 copyleft（GPL/AGPL/SSPL…）或无法确认的许可证会**直接失败**：
      许可问题必须在引入依赖的那一刻暴露，一旦以冲突条款分发过就不是改一行配置能解决的了。
      同一个检查在 CI 里也会跑，这里再跑一次是因为"上次跑过"不代表现在的依赖没变。
- [ ] `npm run sim` —— 完整交易生命周期模拟，**不需要密钥、不下单**，
      当前实测 15/15 通过。它覆盖的是"接缝"：保护单是否真的挂上、触发后是否真的记账、
      风控是否真的在路径上。
- [ ] 本次改动是否触及下单路径（`packages/server/src/binance/`、`risk/`、`trader/`，
      以及 `packages/shared/src/strategy.ts` 的风控配置）？
      如果是，**发布前必须做一次实盘冒烟测试**：

      ```bash
      npx tsx packages/server/src/scripts/liveSmokeTest.ts --confirm
      ```

      > ⚠️ **它会真的花钱。** 名义价值硬上限 20 USDT，清理步骤写在 `finally` 里，
      > 结束时回读交易所确认账户干净。**这不是可选项**：
      > 模拟证明的是逻辑，只有这一步能证明接线 ——
      > 本项目确实出现过"类型全过、`npm test` 全绿，但止损根本没挂上（`-4120`）"的缺陷。

- [ ] 草稿里「破坏性变更」一节写清了升级方需要做什么（没有破坏性变更则无需此步）
- [ ] 如果这次发布涉及开源、许可证或商业化，逐项过一遍
      [`LEGAL.md`](LEGAL.md) 第 6 节的「待办清单」（那里按"现在就做 / 开源前 / 商业化前"分组）

---

## 5. 需要手写 changelog 条目时

自动生成的一行 `- fix(risk): … (#123)` 有时不足以说明升级方该做什么 ——
典型情况是"改了默认值""需要动 `deploy/.env`""旧数据要迁移"。

做法：**直接编辑草稿正文**（Releases → Draft → 编辑），在对应分类下补一小节，例如：

```markdown
### 需要你做的事

- 本次升级后 `MAX_LEVERAGE` 的默认值从 20 降为 10。已经显式配置过的策略不受影响。
```

两点必须知道：

- **草稿正文会被下一次 `main` 的构建覆盖。** 手写内容只在"紧接着发布"时能留存下来，
  所以改完就发，不要合了新的 PR 再回头看。
- 需要**每次都带上**的内容（升级命令、风险提示一类）不要写在草稿正文里，
  写进 [`../.github/release-drafter.yml`](../.github/release-drafter.yml) 的 `template` ——
  它每次生成都会被重新带上。

已发布的 release 不会被后续运行改写；下一次合入 `main` 会为**下一个**版本新建草稿。

---

## 6. 相关文件

| 文件 | 作用 |
| --- | --- |
| [`../.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml) | 构建并推送镜像到 GHCR |
| [`../.github/workflows/release-drafter.yml`](../.github/workflows/release-drafter.yml) | 在每次合入 `main` 时更新发布说明草稿 |
| [`../.github/release-drafter.yml`](../.github/release-drafter.yml) | 分类规则、版本增量规则、发布说明模板 |
| [`../.github/workflows/pr-labeler.yml`](../.github/workflows/pr-labeler.yml) | 打标签（路径 + 标题前缀），草稿分类的依据 |
| [`../.github/labeler.yml`](../.github/labeler.yml) | 路径 → 标签的映射 |
| [`../deploy/up.sh`](../deploy/up.sh) | 服务器上更新与回滚的实际执行者 |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | 首次部署、反向代理、安全检查清单 |
| [`LEGAL.md`](LEGAL.md) | 许可证、交易所条款、监管风险的逐项说明 |
