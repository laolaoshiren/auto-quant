# 部署目录

这个目录是**给服务器用的**，不是给开发用的。它只包含运行所需的三个文件：

| 文件 | 作用 |
|---|---|
| `up.sh` | **一条命令**：拉取最新镜像并启动/更新服务 |
| `docker-compose.yml` | 服务定义（端口、数据卷、日志轮转、健康检查） |
| `.env.example` | 配置模板；`up.sh` 首次运行会自动生成 `.env` 并填入随机密钥 |

服务以 **Docker 镜像**运行，不在服务器上装 Node、不拉源码、不构建。

---

## 快速开始

```bash
# 一次性：把部署文件放到服务器（需要对该私有仓库有访问权限）
git clone --depth 1 https://github.com/laolaoshiren/auto-quant.git /opt/autoquant
cd /opt/autoquant/deploy

# 以后每次部署 / 更新（就这一条）
./up.sh
```

首次运行会自动：

1. 检查 Docker 是否可用
2. 生成 `.env`，包含随机的主密钥、JWT 密钥、管理员密码 —— **并把密码打印出来**
3. 登录镜像仓库（如果需要）
4. 拉取最新镜像
5. 启动容器，等待健康检查通过
6. 打印访问地址与登录信息

**重复运行是安全的**：只会把服务更新到最新镜像，不会动数据。

---

## 常用命令

```bash
./up.sh              # 拉取最新镜像并（重新）启动 —— 日常就用这条
./up.sh logs         # 跟随日志
./up.sh status       # 查看状态、健康检查、接口响应
./up.sh backup       # 备份数据（数据库 + 主密钥）
./up.sh import <dir> # 把旧的 data/ 目录导入数据卷（从源码部署迁移过来时用）
./up.sh down         # 停止（数据保留）
./up.sh help         # 帮助
```

---

## 从「源码 + systemd」迁移过来

如果之前是用源码运行、systemd 托管的，数据在原来的 `data/` 目录里。
**不要直接切换** —— 新的数据卷是空的，切换后会看到一个全新的空系统。

```bash
# 1. 停掉旧服务，避免数据库处于写入状态
sudo systemctl stop autoquant && sudo systemctl disable autoquant

# 2. 把旧数据导入数据卷
./up.sh import /opt/autoquant/data

# 3. 启动
./up.sh

# 4. 确认无误后再删除旧目录（先留一段时间作为回退路径）
```

`import` 会**自动对齐主密钥**。这一点很关键：`.env` 里的 `MASTER_KEY` 优先于
`data/.master.key`，而 `up.sh` 首次运行会生成一个新的 —— 不对齐的话，
账户和历史都在，但**所有交易所凭据都解不开**，症状是控制台显示
「无法读取该账户的 API 凭据」，完全指不到真正的原因。

---

## 访问控制台

默认只绑宿主机 `127.0.0.1`，公网不可直接访问。用 SSH 隧道：

```bash
ssh -L 3200:127.0.0.1:3200 <你的服务器>
# 然后浏览器打开 http://127.0.0.1:3200
```

要对外提供访问，**正确做法是在前面加反向代理 + HTTPS**，而不是把
`BIND_ADDRESS` 改成 `0.0.0.0`。详见 [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)。

---

## 配置

所有配置都在 `.env` 里（首次运行自动生成，已 gitignore）。常用项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BINANCE_USE_TESTNET` | `true` | **最容易出错的一项**。`false` = 实盘真实资金；两者界面完全一样 |
| `BIND_ADDRESS` | `127.0.0.1` | 改成 `0.0.0.0` 会让控制台对公网开放 |
| `PORT` | `3200` | 宿主机端口 |
| `DRY_RUN` | `false` | `true` 时只模拟下单 |
| `GLOBAL_TRADING_DISABLED` | `false` | 全局熔断，`true` 时拒绝启动任何机器人 |
| `AUTOQUANT_IMAGE` | `ghcr.io/.../auto-quant:latest` | 锁定版本时改成具体 tag |
| `MASTER_KEY` / `JWT_SECRET` | 自动生成 | **迁移时不要覆盖**，见上文 |
| `ADMIN_PASSWORD` | 自动生成 | 首次启动创建 owner 账户用 |

---

## 镜像从哪来

推送代码到 `main` → GitHub Actions 跑完 CI → CI 通过后自动构建并推送镜像到
GHCR（`.github/workflows/docker-publish.yml`）。

**只有通过全部检查的提交才会产出镜像** —— 用的是 `workflow_run` 依赖 CI 成功，
而不是并行构建。同时会打上 `sha-<短哈希>` 标签，所以任何一次部署都能追溯到确切的提交。

---

## 数据与备份

数据在 Docker 命名卷 `autoquant-data` 里，包含：

- SQLite 数据库（账户、凭据密文、交易历史、决策审计）
- `.master.key` / `.jwt.secret`
- 服务日志

> ⚠️ **备份文件等同于账户访问权。** 主密钥 + 加密凭据放在一起 = 明文凭据。
> `./up.sh backup` 生成的文件请妥善保管，不要放进共享目录或代码仓库。

这个卷丢失 = 交易所凭据与全部交易历史丢失，且无法恢复。
