#!/usr/bin/env bash
# =============================================================================
# auto-quant 一条命令部署
#
#   ./up.sh              拉取最新镜像并（重新）启动 —— 日常就用这条
#   ./up.sh logs         跟随日志
#   ./up.sh status       查看状态与健康检查
#   ./up.sh backup       备份数据（数据库 + 密钥）
#   ./up.sh import <dir> 把旧的 data/ 目录导入数据卷（从 systemd 迁移时用）
#   ./up.sh reset-password  把管理员凭据重置为 .env 中的值（忘记密码时用）
#   ./up.sh down         停止（数据保留）
#   ./up.sh help         帮助
#
# 首次运行会自动：
#   · 检查 Docker
#   · 生成 .env（含随机主密钥、JWT 密钥、管理员用户名与密码）
#   · 登录镜像仓库（如需）
#   · 拉取镜像、启动、等待健康检查通过
#   · 打印访问地址与登录凭据
#
# 这个脚本是**幂等**的：重复运行只会把服务更新到最新镜像，不会动数据。
# =============================================================================

set -euo pipefail

# --- 输出helpers -------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_INFO=$'\033[36m'; C_OK=$'\033[32m'
  C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_BOLD=''
fi
info() { printf '%s==>%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s  ⚠%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
err()  { printf '%s  ✗%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

# --- 定位目录 ---------------------------------------------------------------
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR"

COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_TEMPLATE="$SCRIPT_DIR/.env.example"
VOLUME_NAME="autoquant-data"
CONTAINER_NAME="autoquant"
# 镜像默认值；.env 里的 AUTOQUANT_IMAGE 会覆盖它
DEFAULT_IMAGE="ghcr.io/laolaoshiren/auto-quant:latest"

# -----------------------------------------------------------------------------
# 工具函数
# -----------------------------------------------------------------------------

# 生成密钥。优先 openssl；没有时退回 /dev/urandom。
# **不用 node** —— 部署机器上很可能根本没装 Node，那正是用 Docker 的意义。
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    err "没有找到 docker。"
    echo ""
    echo "  请先安装 Docker，一条命令："
    echo "      curl -fsSL https://get.docker.com | sh"
    echo ""
    echo "  安装后确认："
    echo "      docker version"
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    err "Docker 已安装但当前用户没有权限访问守护进程。"
    echo ""
    echo "  两种解决方式："
    echo "    1) 用 sudo 运行本脚本：       sudo ./up.sh"
    echo "    2) 把当前用户加入 docker 组： sudo usermod -aG docker \$USER"
    echo "       （之后需要重新登录一次 shell 才生效）"
    exit 1
  fi

  # compose v2 是 docker 的子命令；老版本是独立的 docker-compose
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
    warn "使用的是旧版 docker-compose。建议升级到 Docker 自带的 compose v2。"
  else
    err "没有找到 docker compose 插件。"
    echo "  安装：https://docs.docker.com/compose/install/linux/"
    exit 1
  fi
}

# 从 .env 读一个变量（不 source 整个文件，避免 .env 里的值被执行）
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

# 解析镜像地址。优先级：环境变量 > .env > 内置默认值。
# 环境变量优先是为了支持临时覆盖（例如用本地构建的镜像做验证、
# 或临时切到某个 sha 标签排查问题），而不必去改 .env。
image_name() {
  if [ -n "${AUTOQUANT_IMAGE:-}" ]; then
    printf '%s' "$AUTOQUANT_IMAGE"
    return 0
  fi
  local v; v=$(env_get AUTOQUANT_IMAGE)
  printf '%s' "${v:-$DEFAULT_IMAGE}"
}

# 首次运行生成 .env
ensure_env() {
  if [ -f "$ENV_FILE" ]; then
    return 0
  fi

  info "首次运行：生成 .env"

  if [ ! -f "$ENV_TEMPLATE" ]; then
    die "找不到 $ENV_TEMPLATE。请确认 deploy/ 目录完整。"
  fi

  local master jwt admin user
  master=$(gen_secret)
  jwt=$(gen_secret)
  # 管理员密码用更短的十六进制，便于手输
  admin=$(gen_secret | cut -c1-16)
  # 用户名也随机生成，与不带固定 admin 默认值的设计保持一致：
  # 固定的用户名等于把登录所需的两半信息送出去一半。
  # 格式与服务端的 generateUsername() 一致（admin_ + 6 位十六进制）。
  user="admin_$(gen_secret | cut -c1-6)"

  # 用 sed 逐项替换模板里的空值
  sed -e "s|^MASTER_KEY=.*|MASTER_KEY=${master}|" \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=${jwt}|" \
      -e "s|^ADMIN_USERNAME=.*|ADMIN_USERNAME=${user}|" \
      -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${admin}|" \
      "$ENV_TEMPLATE" > "$ENV_FILE"

  chmod 600 "$ENV_FILE"

  ok "已生成 $ENV_FILE（权限 600）"
  echo ""
  printf '%s  ┌──────────────────────────────────────────────┐%s\n' "$C_BOLD" "$C_RESET"
  printf '%s  │  控制台登录信息（请立刻保存）                │%s\n' "$C_BOLD" "$C_RESET"
  printf '%s  └──────────────────────────────────────────────┘%s\n' "$C_BOLD" "$C_RESET"
  echo "     用户名：admin"
  echo "     密码：  $admin"
  echo ""
  echo "     这个密码也可以随时在 $ENV_FILE 里查看或修改。"
  echo ""
}

# 登录私有镜像仓库。
# 镜像在 GHCR 上是私有的，不登录拉不下来。
ensure_registry_login() {
  local image; image=$(image_name)
  local registry="${image%%/*}"

  # 非 ghcr.io / docker.io 的自建仓库，交给用户自己处理
  case "$registry" in
    ghcr.io) ;;
    *) return 0 ;;
  esac

  # 已经登录过就不重复登录
  if [ -f "$HOME/.docker/config.json" ] && grep -q "$registry" "$HOME/.docker/config.json" 2>/dev/null; then
    return 0
  fi

  # 提供 token 就登录
  if [ -n "${GHCR_TOKEN:-}" ]; then
    info "登录 $registry"
    printf '%s' "$GHCR_TOKEN" | docker login "$registry" -u "${GHCR_USER:-$(whoami)}" --password-stdin >/dev/null
    ok "登录成功"
    return 0
  fi

  # 用 gh CLI 的凭据（如果装了）
  if command -v gh >/dev/null 2>&1 && gh auth token >/dev/null 2>&1; then
    info "使用 gh CLI 的凭据登录 $registry"
    gh auth token | docker login "$registry" -u "$(gh api user --jq .login)" --password-stdin >/dev/null
    ok "登录成功"
    return 0
  fi

  warn "尚未登录 $registry。如果镜像仓库是私有的，拉取会失败。"
  echo ""
  echo "  解决办法（任选其一）："
  echo "    1) 提供 token 再运行："
  echo "         GHCR_TOKEN=<你的token> ./up.sh"
  echo "       token 需要有 read:packages 权限，在 GitHub → Settings →"
  echo "       Developer settings → Personal access tokens 创建。"
  echo ""
  echo "    2) 手动登录一次，之后本脚本会自动复用凭据："
  echo "         echo <你的token> | docker login $registry -u <你的用户名> --password-stdin"
  echo ""
}

# 等待容器健康。镜像的 HEALTHCHECK 会打 /api/health。
wait_healthy() {
  local timeout="${1:-90}"
  local waited=0

  info "等待服务就绪（最多 ${timeout} 秒）"
  while [ "$waited" -lt "$timeout" ]; do
    local status
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
               "$CONTAINER_NAME" 2>/dev/null || echo "missing")

    case "$status" in
      healthy)
        ok "服务已就绪"
        return 0
        ;;
      unhealthy)
        err "健康检查失败。最近日志："
        echo ""
        $COMPOSE -f "$COMPOSE_FILE" logs --tail 40 autoquant || true
        return 1
        ;;
      exited|dead)
        err "容器已退出。最近日志："
        echo ""
        $COMPOSE -f "$COMPOSE_FILE" logs --tail 40 autoquant || true
        return 1
        ;;
    esac

    printf '.'
    sleep 3
    waited=$((waited + 3))
  done

  echo ""
  warn "等待超时（${timeout}s）。容器可能仍在启动，查看日志："
  echo "    ./up.sh logs"
  return 1
}

print_access_info() {
  local port bind
  port=$(env_get PORT); port="${port:-3200}"
  bind=$(env_get BIND_ADDRESS); bind="${bind:-127.0.0.1}"

  local env_name
  case "$(env_get BINANCE_USE_TESTNET)" in
    true)  env_name="模拟盘（Demo）" ;;
    *)     env_name="实盘（真实资金）" ;;
  esac

  # 是否已经有账户：有的话 .env 里的密码就不再生效（首次启动时才用它创建账号）
  local has_account=false
  if docker exec "$CONTAINER_NAME" sh -c 'test -f /app/data/autoquant.sqlite' 2>/dev/null; then
    if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "created owner account\|已创建管理员账户"; then
      has_account=true
    fi
  fi

  echo ""
  printf '%s  ┌──────────────────────────────────────────────┐%s\n' "$C_BOLD" "$C_RESET"
  printf '%s  │  部署完成                                    │%s\n' "$C_BOLD" "$C_RESET"
  printf '%s  └──────────────────────────────────────────────┘%s\n' "$C_BOLD" "$C_RESET"
  echo ""
  echo "     交易环境：$env_name"
  echo "     绑定地址：$bind:$port"
  echo ""

  # 登录凭据。这是非开发用户最需要看到的一段 —— 没有注册入口，
  # 账号只在首次启动时创建一次，看不到就得去翻容器日志。
  if [ "$has_account" = "true" ]; then
    echo "     登录账号：$(env_get ADMIN_USERNAME)（已在首次启动时创建）"
    echo "     密码：    首次启动时设置的那个；如已遗忘，见下方说明"
    echo ""
    echo "     忘记密码时（会丢失加密封存，需重新添加交易所凭据）："
    echo "         ./up.sh reset-password"
  else
    echo "     ┌──────────────────────────────────────────────┐"
    echo "     │  登录凭据（请立刻保存）                       │"
    echo "     └──────────────────────────────────────────────┘"
    echo "         用户名：$(env_get ADMIN_USERNAME)"
    echo "         密码：  $(env_get ADMIN_PASSWORD)"
    echo ""
    echo "     这组凭据在首次启动时创建。系统没有注册入口，"
    echo "     登录后可在「操作员账户」中修改用户名与密码。"
  fi
  echo ""

  if [ "$bind" = "127.0.0.1" ]; then
    echo "     控制台只监听本机，从你的电脑用 SSH 隧道访问："
    echo "         ssh -L ${port}:127.0.0.1:${port} <你的服务器>"
    echo "         然后浏览器打开 http://127.0.0.1:${port}"
  else
    echo "     控制台地址：http://${bind}:${port}"
    if [ "$bind" = "0.0.0.0" ]; then
      warn "已绑定 0.0.0.0 —— 控制台对公网开放。登录后可下真实订单，"
      echo "        建议改回 127.0.0.1 并在前面加反向代理 + HTTPS（见 docs/DEPLOYMENT.md）。"
    fi
  fi
  echo ""
  echo "     常用命令："
  echo "         ./up.sh logs      查看日志"
  echo "         ./up.sh status    查看状态"
  echo "         ./up.sh backup    备份数据"
  echo ""
}

# 交互式确认。
#
# ⚠️ 必须处理非交互场景：在 CI、`ssh host './up.sh import x'`、或任何没有 TTY 的
# 环境里，裸 `read` 会**永久挂住**而不是报错。曾经因此让一条命令卡死到超时。
# 所以：没有 TTY 时直接要求 --yes，而不是等待一个永远不会到来的输入。
ASSUME_YES=${ASSUME_YES:-0}
confirm() {
  local prompt="$1"

  if [ "$ASSUME_YES" = "1" ]; then
    return 0
  fi

  if [ ! -t 0 ]; then
    err "需要确认「$prompt」，但当前不是交互式终端。"
    echo ""
    echo "  在脚本或远程命令里请显式加 --yes："
    echo "      ./up.sh import $2 --yes"
    exit 1
  fi

  printf '  %s [y/N] ' "$prompt"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) echo "  已取消。"; exit 0 ;;
  esac
}

# -----------------------------------------------------------------------------
# 子命令
# -----------------------------------------------------------------------------

cmd_up() {
  require_docker
  ensure_env
  ensure_registry_login

  local image; image=$(image_name)
  info "拉取镜像 $image"
  if ! $COMPOSE -f "$COMPOSE_FILE" pull --quiet 2>/dev/null; then
    # 拉取失败有两种情况，必须区别对待：
    #   · 本地已经有这个镜像（离线部署、或自己构建的测试镜像）→ 继续，但要提醒
    #   · 本地也没有 → 直接失败，否则会拿旧镜像启动而让人以为"更新成功"
    if docker image inspect "$image" >/dev/null 2>&1; then
      warn "拉取失败，但本地已有该镜像 —— 将使用本地版本（可能不是最新的）。"
    else
      err "拉取镜像失败，且本地没有该镜像。"
      echo ""
      echo "  常见原因："
      echo "    1) 镜像仓库是私有的但尚未登录 —— 见上面的提示"
      echo "    2) 镜像还没构建出来 —— 确认 GitHub Actions 的「Docker 镜像」工作流已成功"
      echo "    3) 服务器无法访问 $(printf '%s' "$image" | cut -d/ -f1)"
      exit 1
    fi
  fi

  info "启动服务"
  # up -d 会在镜像或配置变化时自动重建容器，数据卷不受影响
  $COMPOSE -f "$COMPOSE_FILE" up -d

  if wait_healthy 90; then
    print_access_info
  else
    die "服务未能在预期时间内就绪。请用 ./up.sh logs 查看日志。"
  fi
}

cmd_logs() {
  require_docker
  $COMPOSE -f "$COMPOSE_FILE" logs -f --tail 100 autoquant
}

cmd_status() {
  require_docker
  echo ""
  docker ps --filter "name=^/${CONTAINER_NAME}$" \
    --format '  容器: {{.Names}}\n  状态: {{.Status}}\n  镜像: {{.Image}}' || true
  echo ""
  local health
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}无健康检查{{end}}' \
             "$CONTAINER_NAME" 2>/dev/null || echo "未运行")
  echo "  健康: $health"
  echo ""
  local port; port=$(env_get PORT); port="${port:-3200}"
  echo -n "  接口: "
  if docker exec "$CONTAINER_NAME" node -e \
       "fetch('http://127.0.0.1:${port}/api/health').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(()=>process.exit(1))" 2>/dev/null; then
    :
  else
    echo "无响应"
  fi
  echo ""
}

cmd_backup() {
  require_docker
  local stamp out
  stamp=$(date +%Y%m%d-%H%M%S)
  out="$SCRIPT_DIR/backup-autoquant-${stamp}.tar.gz"

  info "备份数据卷 $VOLUME_NAME"
  # 用一次性容器把卷打包出来。
  # ⚠️ 备份里含 AES 主密钥与加密后的交易所凭据 —— 等同于账户访问权，
  #    必须与生产环境同等对待：不要放进共享目录、不要提交进任何仓库。
  docker run --rm \
    -v "${VOLUME_NAME}:/data:ro" \
    -v "${SCRIPT_DIR}:/backup" \
    alpine:3 \
    tar czf "/backup/$(basename "$out")" -C /data . >/dev/null

  chmod 600 "$out" 2>/dev/null || true
  ok "已备份到 $out"
  echo ""
  warn "这个文件包含主密钥与交易所凭据，请妥善保管，不要放进共享目录或代码仓库。"
  echo ""
}

cmd_down() {
  require_docker
  info "停止服务（数据卷保留）"
  $COMPOSE -f "$COMPOSE_FILE" down
  ok "已停止。数据仍在卷 $VOLUME_NAME 中，下次 ./up.sh 会继续使用。"
}

# 重置管理员凭据。
#
# 没有这一步的话，忘记密码的唯一出路是删掉数据卷 —— 那会连同交易所凭据
# 与全部交易历史一起丢掉。对单人部署来说这是必然会发生的情况。
cmd_reset_password() {
  require_docker
  ensure_env

  # 容器必须在运行才能 exec 进去；没跑就临时起一个
  local running=false
  if [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" = "true" ]; then
    running=true
  fi

  warn "即将重置管理员凭据为 .env 中的值："
  echo "         用户名：$(env_get ADMIN_USERNAME)"
  echo "         密码：  $(env_get ADMIN_PASSWORD)"
  echo ""
  echo "  改完请用这组凭据登录，并在「操作员账户」里改成自己的。"
  echo ""
  confirm "确认重置？" "reset"

  if [ "$running" = "true" ]; then
    info "在运行中的容器里重置"
    docker exec "$CONTAINER_NAME" node node_modules/tsx/dist/cli.mjs \
      packages/server/src/scripts/resetAdminPassword.ts
  else
    info "容器未运行，临时启动一个执行重置"
    $COMPOSE -f "$COMPOSE_FILE" run --rm --entrypoint node autoquant \
      node_modules/tsx/dist/cli.mjs packages/server/src/scripts/resetAdminPassword.ts
  fi

  echo ""
  ok "凭据已重置。现在可以用上面的用户名与密码登录。"
  echo ""
}

# 把已有的 data/ 目录导入卷。
#
# 这个命令存在的理由很具体：从「源码 + systemd」切换到 Docker 时，
# 新的命名卷是空的，而旧数据（账户、加密凭据、交易历史、主密钥）
# 还在原来的目录里。不知道要迁移的话，切换之后会看到一个全新的空系统，
# 而旧数据并没有丢——只是没被用上，很容易被误判为「数据丢了」。
cmd_import() {
  require_docker
  # 先确保 .env 存在：后面的主密钥对齐要改它。
  # 少了这一步，在"全新环境首次导入"这条最常见的路径上会静默失败。
  ensure_env

  local src="${1:-}"
  if [ -z "$src" ]; then
    err "用法：./up.sh import <旧 data 目录的路径>"
    echo ""
    echo "  例如从 systemd 部署迁移过来："
    echo "      ./up.sh import /opt/autoquant/data"
    echo ""
    echo "  注意：先 ./up.sh down 停掉容器，否则数据库可能处于写入状态。"
    exit 1
  fi

  if [ ! -d "$src" ]; then
    err "目录不存在：$src"
    exit 1
  fi

  if [ ! -f "$src/autoquant.sqlite" ]; then
    warn "$src 里没有 autoquant.sqlite —— 确认这是正确的 data 目录吗？"
    echo ""
    confirm "仍要继续吗？" "$src"
  fi

  # 卷里已有数据时不能盲目覆盖 —— 那会造成不可逆的丢失
  local existing
  existing=$(docker run --rm -v "${VOLUME_NAME}:/data" alpine:3 sh -c 'ls -A /data 2>/dev/null | wc -l' 2>/dev/null || echo 0)
  if [ "$existing" -gt 0 ]; then
    warn "目标卷 $VOLUME_NAME 里已经有 $existing 个文件。"
    echo ""
    echo "  继续会用 $src 的内容**覆盖**它们。"
    echo "  如果卷里的数据还有价值，请先备份：./up.sh backup"
    echo ""
    confirm "确认覆盖？" "$src"
  fi

  info "导入 $src → 卷 $VOLUME_NAME"
  # 只读挂载源目录，避免意外修改原数据（迁移出错时还能回退）
  local src_abs; src_abs=$(cd "$src" && pwd)
  docker run --rm \
    -v "${src_abs}:/src:ro" \
    -v "${VOLUME_NAME}:/data" \
    alpine:3 \
    sh -c 'cp -a /src/. /data/ && chown -R 1001:1001 /data' 

  ok "导入完成"
  echo ""
  echo "  卷里的文件："
  docker run --rm -v "${VOLUME_NAME}:/data" alpine:3 sh -c 'ls -A /data | sed "s/^/    /"'
  echo ""

  reconcile_master_key

  echo "  现在运行 ./up.sh 启动，它应该会读到原有的账户与交易历史。"
  echo ""
  warn "导入完成后，建议保留原目录一段时间再删 —— 它是你的回退路径。"
  echo ""
}

# 对齐主密钥。
#
# 这是迁移里最隐蔽的一个坑：`.env` 里的 MASTER_KEY **优先于** data/.master.key，
# 而 up.sh 首次运行会生成一个新的 MASTER_KEY。于是导入旧数据之后：
#
#   · 账户和历史都在（SQLite 文件直接可用）
#   · 但**所有交易所凭据解不开** —— 它们是用旧主密钥加密的
#   · 症状是控制台显示"无法读取该账户的 API 凭据"，完全指不到真正的原因
#
# 所以这里自动对齐：数据里有 .master.key 就说明旧部署用的是文件密钥，
# 把 .env 里的清空即可回退到文件密钥。
reconcile_master_key() {
  local file_key has_key env_key
  file_key=$(docker run --rm -v "${VOLUME_NAME}:/data" alpine:3 \
               sh -c 'cat /data/.master.key 2>/dev/null || true' | tr -d '[:space:]')
  env_key=$(env_get MASTER_KEY | tr -d '[:space:]')

  if [ -z "$file_key" ]; then
    # 旧部署用的是环境变量里的 MASTER_KEY（没有文件密钥）
    if [ -n "$env_key" ]; then
      warn "导入的数据里没有 .master.key，说明旧部署把主密钥放在了 .env 的 MASTER_KEY 里。"
      echo ""
      echo "  当前 .env 里的 MASTER_KEY 是 up.sh 新生成的，**与旧的不同**，"
      echo "  所以旧的交易所凭据将无法解密。"
      echo ""
      echo "  请手工把旧部署 .env 里的 MASTER_KEY 复制到本目录的 .env（覆盖当前值）。"
      echo ""
    fi
    return 0
  fi

  if [ "$file_key" = "$env_key" ]; then
    ok "主密钥一致，交易所凭据可正常解密"
    return 0
  fi

  # 数据里有文件密钥，且与 .env 里的不同 → 清空 .env 的 MASTER_KEY，回退到文件密钥
  warn "主密钥不一致：.env 里是 up.sh 新生成的，导入的数据里是旧的文件密钥。"
  echo ""
  echo "  已自动清空 .env 的 MASTER_KEY，改用导入的 data/.master.key ——"
  echo "  否则旧的交易所凭据会解不开（症状是「无法读取该账户的 API 凭据」）。"
  echo ""

  if grep -q '^MASTER_KEY=' "$ENV_FILE" 2>/dev/null; then
    sed -i 's|^MASTER_KEY=.*|MASTER_KEY=|' "$ENV_FILE"
  else
    # .env 里没有这一项（或文件不存在）→ 追加/创建
    printf 'MASTER_KEY=\n' >> "$ENV_FILE"
  fi

  ok "已对齐主密钥"
  echo ""
  echo "  提示：JWT_SECRET 同理。当前 .env 里是新生成的，会让旧会话失效"
  echo "  （需要重新登录），但不影响任何数据。"
  echo ""
}

cmd_help() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

# -----------------------------------------------------------------------------

case "${1:-up}" in
  up|"")   cmd_up ;;
  logs)    cmd_logs ;;
  status)  cmd_status ;;
  backup)  cmd_backup ;;
  import)
    shift
    # 解析 import 的参数：<目录> [--yes]
    IMPORT_SRC=""
    for arg in "$@"; do
      case "$arg" in
        --yes|-y) ASSUME_YES=1 ;;
        *) IMPORT_SRC="$arg" ;;
      esac
    done
    cmd_import "$IMPORT_SRC"
    ;;
  down)    cmd_down ;;
  reset-password|reset) cmd_reset_password ;;
  help|-h|--help) cmd_help ;;
  *)
    err "未知命令：$1"
    echo ""
    cmd_help
    exit 1
    ;;
esac
