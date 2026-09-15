# 部署指南

本文档描述如何把本系统部署到一台长期在线的服务器上，并让它 7×24 运行。

> **本文不含任何站点专属信息。** 主机名、域名、路径都以占位符出现——那些属于部署者
> 自己的环境，不属于项目代码。把某个人的服务器域名写进仓库，既让新人困惑，也让仓库
> 一旦转公开就变成信息泄漏。

---

## 0. 两种部署方式，先选一个

| | **Docker（推荐）** | 从源码 + systemd |
|---|---|---|
| 服务器需要什么 | 只有 Docker | Node ≥ 22.5、npm、构建工具链 |
| 更新方式 | 一条命令拉新镜像 | 拉源码、装依赖、重新构建 |
| 适合谁 | **所有人**，包括不写代码的运维/使用者 | 需要改代码的开发者 |
| 章节 | 见下方「方式 A」 | 见「方式 B」 |

**如果你只是要让服务跑起来，用方式 A。** 它不需要服务器上有 Node，不需要源码，
也不需要构建步骤 —— 那些都在 GitHub Actions 里完成了。

---

# 方式 A：Docker（推荐）

## A1. 一条命令

```bash
cd /opt/autoquant/deploy && ./up.sh
```

就这一条。首次运行会：

1. 检查 Docker 是否可用（并给出安装指引）
2. 生成 `.env`，含随机的主密钥、JWT 密钥、管理员密码 —— **并把密码打印出来**
3. 登录镜像仓库（如需要）
4. 拉取最新镜像
5. 启动容器并等待健康检查通过
6. 打印访问地址与登录信息

**重复运行是安全的**，它只会把服务更新到最新镜像，不碰数据。

常用子命令：

```bash
./up.sh              # 更新并重启（日常）
./up.sh logs         # 跟随日志
./up.sh status       # 状态与健康检查
./up.sh backup       # 备份数据
./up.sh import <dir> # 导入旧的 data/ 目录
./up.sh down         # 停止
```

完整的说明见 [`deploy/README.md`](../deploy/README.md)。

## A2. 镜像从哪里来

推送代码到 `main` → GitHub Actions 跑 CI → **CI 通过后**才构建并推送镜像到 GHCR。

这一步的顺序是刻意的：`.github/workflows/docker-publish.yml` 用 `workflow_run`
依赖 CI 成功，而不是与 CI 并行。如果并行构建，一次测试失败的提交可能已经把镜像
推上去、服务器也可能已经拉到并部署了。

镜像同时带 `sha-<短哈希>` 标签，所以任何一次部署都能追溯到确切的提交。

## A3. 网络暴露

容器默认**只绑宿主机 `127.0.0.1`**，公网不可直接访问。
对外提供访问的正确做法是在前面加一层反向代理并启用 HTTPS —— 见本文档
「反向代理与 HTTPS」一节，那里给了 Caddy 的完整配置。

> **不要把 `BIND_ADDRESS` 改成 `0.0.0.0` 了事。** 控制台登录后可以下真实订单，
> 直接暴露到公网意味着安全性完全取决于那一个密码。

如果反向代理跑在 Docker 里，把 `BIND_ADDRESS` 设成 Docker 网桥网关
（通常是 `172.17.0.1`）：容器能访问到它，而公网无法路由到它。

## A4. 从源码部署迁移过来

数据（账户、加密凭据、交易历史）在旧的 `data/` 目录里，
**新的数据卷是空的 —— 不导入就会看到一个全新的空系统**。

```bash
sudo systemctl stop autoquant && sudo systemctl disable autoquant
./up.sh import /opt/autoquant/data
./up.sh
```

`import` 会**自动对齐主密钥**。这一步不能省：`.env` 里的 `MASTER_KEY` 优先于
`data/.master.key`，而 `up.sh` 首次运行会生成一个新的。不对齐的话，账户和历史都在，
但**所有交易所凭据都解不开** —— 症状是控制台显示「无法读取该账户的 API 凭据」，
从这条错误完全看不出真正的原因。

## A5. 数据与备份

数据在 Docker 命名卷 `autoquant-data` 里。备份：

```bash
./up.sh backup     # 生成 backup-autoquant-<时间戳>.tar.gz
```

> ⚠️ **备份文件等同于账户访问权**：里面有 AES 主密钥和加密后的交易所凭据，
> 两样放在一起就是明文凭据。请妥善保管，不要放进共享目录或代码仓库。

这个卷丢失 = 交易所凭据与全部交易历史丢失，且无法恢复。

---

# 方式 B：从源码 + systemd

**只有在需要改代码、或者服务器不方便用 Docker 时才选这个方式。**
日常使用请用上面的方式 A。

---

## 1. 为什么必须部署到服务器

**币安对 API Key 有 IP 白名单限制。** 未加白的 IP 发起的**所有签名请求**都会返回：

```json
{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action, request ip: x.x.x.x"}
```

注意这条错误的措辞具有误导性：它同时列了"密钥无效 / IP 不对 / 权限不足"三种可能，
**你无法从错误信息本身判断是哪一个**。如果你确认密钥正确、权限也开了，那就是 IP 问题。

公开行情接口（`/fapi/v1/klines`、`/fapi/v1/time`）不受白名单影响，所以未加白时表现为
「行情能拉、但一下单就失败」——这个组合基本可以断定是白名单。

**做法**：在币安 API 管理页面把服务器的**公网出口 IP** 加入白名单。

```bash
# 在服务器上确认它的公网出口 IP（注意是出口 IP，不是网卡上的内网地址）
curl -s https://api.ipify.org; echo
```

如果服务器在 NAT 或代理后面，`ip addr` 显示的内网地址是没用的，必须用上面这条命令
拿到真实的出口 IP。

---

## 2. 服务器要求

| 项目 | 最低 | 说明 |
|---|---|---|
| 操作系统 | 任意现代 Linux | 本文以 Debian/Ubuntu + systemd 为例 |
| **Node.js** | **≥ 22.5.0** | 见下方说明，这是硬性要求 |
| 内存 | 512 MB | 实测常驻约 80–100 MB；2 GB 的机器可同时跑别的服务 |
| 磁盘 | 1 GB | 源码 + 依赖约 300 MB，其余是数据库与日志 |
| 网络 | 能访问 `fapi.binance.com` | 若在受限网络，需要配置 `HTTPS_PROXY` |

### 为什么必须 Node ≥ 22.5

项目用的是 **Node 内置的 `node:sqlite`**，不是 `better-sqlite3` 之类的第三方库。这是一个
刻意的选型，收益很实在：

- **没有原生模块编译步骤**——`npm install` 不需要编译器工具链，不会因为 Python、
  node-gyp 或 ABI 版本而失败
- 部署更轻，CI 更快

代价是最低版本被抬到了 22.5。装 Node 22：

```bash
# 以 Linux x64 为例，按需替换版本号与架构
NODE_VERSION=v22.23.2
curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz
mkdir -p /usr/local/lib/nodejs
tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
ln -sfn "/usr/local/lib/nodejs/node-${NODE_VERSION}-linux-x64" /usr/local/node22
ln -sf /usr/local/node22/bin/node /usr/local/bin/node
ln -sf /usr/local/node22/bin/npm  /usr/local/bin/npm

node -v   # 应 >= v22.5.0
node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync(':memory:'); console.log('node:sqlite OK')"
```

---

## 3. 安装

```bash
sudo mkdir -p /opt/autoquant
sudo chown "$USER" /opt/autoquant

# 方式一：从 git 克隆
git clone <仓库地址> /opt/autoquant

# 方式二：本地打包上传（见 scripts/deploy.ps1，它已排除 .env / data / node_modules）
```

```bash
cd /opt/autoquant
npm ci --no-audit --no-fund     # 生产用 ci，严格按 lockfile 安装
npm run build                   # 构建控制台静态文件
```

---

## 4. 环境配置

```bash
cp .env.example .env
```

**生产环境必须显式设置以下三项**（不要让系统自动生成）：

| 变量 | 说明 |
|---|---|
| `MASTER_KEY` | 32 字节密钥，用于 AES-256-GCM 加密交易所 API Secret |
| `JWT_SECRET` | 会话令牌签名密钥 |
| `ADMIN_PASSWORD` | 首次启动创建 owner 账户的密码 |

```bash
# 生成密钥
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **不要依赖首次启动自动生成主密钥。** 那是开发便利：它会写进 `data/.master.key`，
> 而 `data/` 里同时存着加密后的凭据——两样放在一起，等于明文凭据。

其余关键项：

```bash
PORT=3200
HOST=127.0.0.1          # 见第 6 节，这样选是有原因的
BINANCE_USE_TESTNET=false   # 实盘
DRY_RUN=false
GLOBAL_TRADING_DISABLED=false
```

```bash
chmod 600 .env
```

> **`BINANCE_USE_TESTNET` 是最容易出错的一项。** 它决定了所有交易发往实盘还是模拟盘，
> 而两者**外观完全一样**——不会报错，只是交易悄悄跑到了错误的环境上。
> 部署脚本会在解压后回显这一项，为的就是让这个错误无处藏身。

---

## 5. 以 systemd 托管

直接用 `nohup ... &` 启动是不可靠的：ssh 会话结束时进程可能被带走，崩溃后也不会重启。

`/etc/systemd/system/autoquant.service`：

```ini
[Unit]
Description=auto-quant — LLM 驱动的加密货币合约自动交易系统
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 专用用户：该进程持有交易所密钥，不该用 root 跑
User=autoquant
Group=autoquant
WorkingDirectory=/opt/autoquant
Environment=NODE_ENV=production
Environment=PATH=/usr/local/node22/bin:/usr/bin:/bin
ExecStart=/usr/local/node22/bin/node /opt/autoquant/node_modules/tsx/dist/cli.mjs /opt/autoquant/packages/server/src/index.ts
Restart=always
RestartSec=5
# 崩溃循环保护：5 分钟内重启超过 5 次就放弃，避免无限重启掩盖真实故障
StartLimitIntervalSec=300
StartLimitBurst=5
StandardOutput=append:/opt/autoquant/data/server.log
StandardError=append:/opt/autoquant/data/server.log

# 基础加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/autoquant/data /opt/autoquant

[Install]
WantedBy=multi-user.target
```

> **注意 `ExecStart` 直接调 node + tsx 的 CLI，而不是走 `npm start`。**
> systemd 里的 `npm` 会引入一层不必要的进程包装，信号传递也会变得不直接，
> 导致 `systemctl stop` 不能干净地触发优雅关闭。

创建用户并启动：

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin autoquant
sudo chown -R autoquant:autoquant /opt/autoquant
sudo chmod 600 /opt/autoquant/.env

sudo systemctl daemon-reload
sudo systemctl enable --now autoquant
sudo systemctl status autoquant
```

### 首次启动

```bash
journalctl -u autoquant -n 40 --no-pager
```

首次启动会创建 owner 账户，**密码只打印这一次**：

```
WARN [main] 首次启动 —— 已创建 owner 账户
WARN [main]   用户名：admin
WARN [main]   密码：xxxxxxxxxxxxxxxx
```

**立刻保存并登录修改。** 如果设置了 `ADMIN_PASSWORD` 则使用你指定的那个。

健康检查：

```bash
curl -s http://127.0.0.1:3200/api/health
# {"ok":true,"environment":"production","dryRun":false,...}
```

**确认 `environment` 是 `production`。** 这一步能挡住第 4 节说的那个静默错误。

---

## 6. 对外访问与 HTTPS

### 绑定地址的选择

`.env` 里的 `HOST` 决定服务监听在哪里，这个选择值得想清楚：

| 取值 | 谁能访问 | 适用场景 |
|---|---|---|
| `127.0.0.1` | 仅本机 | 只用 SSH 隧道访问，最安全 |
| `172.17.0.1` | 本机 + **Docker 容器** | 反向代理跑在容器里时用这个 |
| `0.0.0.0` | **公网所有人** | 除非前面有防火墙，否则不要 |

如果反向代理是 **Docker 容器**（Caddy、Nginx、Traefik 等），它会认为
`127.0.0.1` 是容器自己，访问不到宿主机上的服务。这种情况绑 **Docker 网桥网关**
（通常是 `172.17.0.1`）：

- 容器**能**访问到（这是容器到宿主机的标准路径）
- 公网**无法**路由到它——网桥地址不是公网地址

这比绑 `0.0.0.0` 再依赖防火墙规则更可靠：安全性由绑定地址本身保证，
而不是由防火墙配置是否正确保证。

> 换成 `172.17.0.1` 后，**服务器上的 `curl 127.0.0.1:3200` 会失败**。
> 这是正常的，用绑定地址访问即可。

### 反向代理示例（Caddy）

```caddy
quant.example.com {
    encode gzip zstd

    reverse_proxy 172.17.0.1:3200 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
        # 控制台有实时事件流（WebSocket）。不缓冲，否则事件会延迟到达。
        flush_interval -1
    }

    log {
        output file /var/log/caddy/autoquant.log {
            roll_size 20mb
            roll_keep 5
        }
    }
}
```

改完先校验再重载：

```bash
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload   --config /etc/caddy/Caddyfile
```

Caddy 会自动申请并续期 Let's Encrypt 证书。**若域名挂在 Cloudflare 后面**，
注意两点：

- 证书用 **HTTP-01** 验证，Cloudflare 代理（橙云）能正常转发挑战
- 但 **TLS-ALPN-01 无法穿过代理**，Caddy 会自动回退，无需干预

### 安全提醒

**控制台登录后可以下真实订单。** 只靠一层密码暴露在公网是不够的，建议至少再叠加一层：

- 反向代理的 `basic_auth`
- Cloudflare Access（边缘就拦掉，不动服务器配置）
- Cloudflare 的 IP / 国家规则
- 只监听 `127.0.0.1`，用 SSH 隧道访问：
  ```bash
  ssh -L 3200:127.0.0.1:3200 <你的主机>
  # 然后浏览器打开 http://127.0.0.1:3200
  ```

---

## 7. 运维

```bash
systemctl status autoquant        # 状态
systemctl restart autoquant       # 重启
systemctl stop autoquant          # 停止
journalctl -u autoquant -f        # 实时日志
tail -f /opt/autoquant/data/server.log
```

### 升级

```bash
cd /opt/autoquant
sudo systemctl stop autoquant
sudo -u autoquant git pull
sudo -u autoquant npm ci --no-audit --no-fund
sudo -u autoquant npm run build
# 数据库迁移在启动时自动执行（PRAGMA user_version 跟踪，可安全重复运行）
sudo systemctl start autoquant
journalctl -u autoquant -n 30 --no-pager   # 确认迁移与启动无异常
```

**升级前建议备份 `data/`**：

```bash
sudo -u autoquant tar -czf /var/backups/autoquant-$(date +%F).tar.gz -C /opt/autoquant data
```

> 备份文件**包含主密钥和加密凭据**，必须与 `data/` 同等对待——不要放进共享目录、
> 不要提交进任何仓库。

---

## 8. 上线安全检查清单

部署完成后逐项确认：

- [ ] `.env` 权限是 `600`，属主是运行服务的用户
- [ ] `MASTER_KEY` / `JWT_SECRET` 是显式设置的，不是自动生成的
- [ ] `/api/health` 返回的 `environment` 是预期的那个（不是测试网）
- [ ] owner 账户密码已修改，不是首次启动打印的那个
- [ ] 交易所 API Key **未开启提现权限**（交易机器人不需要它）
- [ ] 交易所 API Key 的白名单**只包含这台服务器**的出口 IP
- [ ] 服务没有监听 `0.0.0.0`
- [ ] 若暴露到公网：有 HTTPS，且除密码外还有一层访问控制
- [ ] `data/` 与备份目录不可被其他用户读取
- [ ] 防火墙只放行必要端口
- [ ] 已确认全局熔断开关 `GLOBAL_TRADING_DISABLED` 的行为符合预期
- [ ] 已用小仓位跑过一次实盘冒烟测试（见 README）

> 最后一项目前是最有价值的一步：它在真正投入资金之前，验证预检、下单、挂止损止盈、
> 回读确认、撤单、平仓整条链路都通。见 README 的「实盘冒烟测试」一节。
