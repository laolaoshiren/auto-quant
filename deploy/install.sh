#!/bin/sh
# =============================================================================
# 前导代码（POSIX sh）
#
# 这一段解决两个"一键安装"必须先解决的问题，两段都只用 POSIX 语法，
# 因为此时还不知道系统里有什么。
#
# ── 问题一：从管道运行时，脚本不是一个文件 ──
#
#   curl -fsSL <url> | bash
#
# 这种情况下 `$0` 是 `bash`，不是脚本路径。而后面的逻辑需要用 sudo
# 重新执行自己（提权）、也需要用 bash 重新执行自己（Alpine 没有 bash）——
# 两者都需要一个真实文件。`exec sudo bash "$0"` 在管道模式下会变成
# `sudo bash bash`，直接失败。
#
#   解法：发现自己不是文件时，先把自己下载到临时文件再执行。
#   此时必然有 curl 或 wget（否则用户也没法把它喂进来）。
#
# ── 问题二：Alpine 这类系统没有 bash ──
#
#   解法：检测 bash，没有就装一个，然后用它重新执行自己。
#   装好后 BASH_VERSION 存在，前导直接跳过，不会死循环。
# =============================================================================

SELF_URL="https://raw.githubusercontent.com/${AUTOQUANT_REPO:-laolaoshiren/auto-quant}/${AUTOQUANT_BRANCH:-main}/deploy/install.sh"

# --- 问题一：把自己落盘 ---
if [ ! -f "$0" ]; then
  SELF_TMP="/tmp/autoquant-install-$$.sh"
  echo "==> 检测到从管道运行，正在把安装脚本落盘"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 20 -o "$SELF_TMP" "$SELF_URL" || { echo "    下载失败：$SELF_URL"; exit 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 20 -O "$SELF_TMP" "$SELF_URL" || { echo "    下载失败：$SELF_URL"; exit 1; }
  else
    echo "    需要 curl 或 wget 才能继续 —— 请先安装其中一个。"
    exit 1
  fi

  chmod +x "$SELF_TMP"
  echo "    ✓ $SELF_TMP"
  # 用 sh 重新执行落盘后的脚本（后续前导会再确保 bash）
  exec sh "$SELF_TMP" "$@"
fi

# --- 问题二：确保有 bash ---
if [ -z "${BASH_VERSION:-}" ]; then
  # 只用 POSIX 语法 —— 这一段必须能在 busybox sh 下跑
  if ! command -v bash >/dev/null 2>&1; then
    echo "==> 需要 bash，正在安装"
    FAMILY_PRE=""
    if [ -r /etc/os-release ]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      case "${ID:-}" in
        alpine) FAMILY_PRE="alpine" ;;
        debian|ubuntu|raspbian|linuxmint|pop) FAMILY_PRE="debian" ;;
        rhel|centos|rocky|almalinux|ol|fedora|amzn) FAMILY_PRE="rhel" ;;
        arch|manjaro|endeavouros) FAMILY_PRE="arch" ;;
        opensuse*|sles) FAMILY_PRE="suse" ;;
      esac
    fi

    case "$FAMILY_PRE" in
      alpine) apk add --no-cache bash ;;
      debian) DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bash ;;
      rhel)   { command -v dnf >/dev/null 2>&1 && dnf install -y -q bash; } || yum install -y -q bash ;;
      arch)   pacman -Sy --noconfirm --needed bash ;;
      suse)   zypper --non-interactive install bash ;;
      *)      echo "    无法自动安装 bash。请手动安装后重新运行：sh $0"; exit 1 ;;
    esac

    if ! command -v bash >/dev/null 2>&1; then
      echo "    ✗ bash 安装失败。请手动安装后重新运行：sh $0"
      exit 1
    fi
    echo "    ✓ bash 已安装"
  fi

  # 用 bash 重新执行自己。此后 BASH_VERSION 存在，不会再进这一段。
  exec bash "$0" "$@"
fi

# =============================================================================
# 以下为 bash 专用部分
# =============================================================================

# =============================================================================
# auto-quant 引导安装器
#
# 在一台**全新服务器**上，一条命令完成全部准备工作：
#
#     sudo bash install.sh
#
# 它会依次处理：
#   1. 检查权限（不是 root 就自动用 sudo 重新执行）
#   2. 识别发行版
#   3. 补齐缺失的基础工具（bash / curl 或 wget / **ca-certificates**）
#   4. **安装 Docker 与 compose 插件**（如果没有）
#   5. 取到部署文件（本目录已有就用，没有就用 token 从仓库取）
#   6. 认证私有镜像仓库
#   7. 生成密钥与配置、拉取镜像、启动、等待健康检查通过
#
# 目标：**使用者不需要预先安装任何东西，也不需要懂 Docker**。
#
# -----------------------------------------------------------------------------
# 支持的系统
# -----------------------------------------------------------------------------
#   Debian / Ubuntu、RHEL / CentOS / Rocky / Alma、Fedora、
#   Alpine（含无 bash 的精简镜像）、Arch、openSUSE。
#   其他系统会给出明确的手动安装指引，而不是留下一个语焉不详的失败。
#
# -----------------------------------------------------------------------------
# 为什么这个脚本存在（而不是让用户直接跑 up.sh）
# -----------------------------------------------------------------------------
#   up.sh 假定 Docker 已经装好。实测在一台最小化的 Debian 上，
#   它只会打印"请先安装 Docker"然后退出 —— 而它建议的那条安装命令
#   （curl -fsSL https://get.docker.com | sh）**在该系统上根本跑不起来**，
#   因为 curl 与 CA 证书都没有。这个脚本就是为了消除这类"看文档也会卡住"的死角。
# =============================================================================

set -euo pipefail

# 版本号，便于排查"用户跑的是哪一版脚本"
INSTALLER_VERSION="1.0.0"

REPO_SLUG="${AUTOQUANT_REPO:-laolaoshiren/auto-quant}"
DEFAULT_IMAGE="ghcr.io/${REPO_SLUG%%/*}/auto-quant:latest"
INSTALL_DIR="${AUTOQUANT_DIR:-/opt/autoquant}"
BRANCH="${AUTOQUANT_BRANCH:-main}"

# --- 输出 ---------------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_INFO=$'\033[36m'; C_OK=$'\033[32m'
  C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_BOLD=''
fi
step() { printf '\n%s==>%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '%s    ✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s    ⚠%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
err()  { printf '%s    ✗%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

# -----------------------------------------------------------------------------
# 0. 权限：不是 root 就用 sudo 重新执行自己
#
# 安装 Docker 需要 root。与其让用户在十几步之后才撞到权限错误，
# 不如在第一步就处理好 —— 而且自动重执行比让用户自己想起来加 sudo 更省事。
# -----------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    step "需要 root 权限，正在用 sudo 重新执行"
    exec sudo -E bash "$0" "$@"
  else
    die "需要 root 权限，但系统里没有 sudo。请以 root 身份运行：su -c 'bash $0'"
  fi
fi

printf '%s\n' "${C_BOLD}auto-quant 安装器 v${INSTALLER_VERSION}${C_RESET}"

# -----------------------------------------------------------------------------
# 1. 识别发行版
# -----------------------------------------------------------------------------
step "识别系统"

DISTRO_ID=""; DISTRO_VERSION=""; DISTRO_LIKE=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_ID="${ID:-}"; DISTRO_VERSION="${VERSION_ID:-}"; DISTRO_LIKE="${ID_LIKE:-}"
fi

# 归一化成几个大类，后续按类选择安装方式
case "$DISTRO_ID" in
  debian|ubuntu|raspbian|linuxmint|pop) FAMILY="debian" ;;
  rhel|centos|rocky|almalinux|ol|fedora|amzn) FAMILY="rhel" ;;
  alpine) FAMILY="alpine" ;;
  arch|manjaro|endeavouros) FAMILY="arch" ;;
  opensuse*|sles|sled) FAMILY="suse" ;;
  *)
    case "$DISTRO_LIKE" in
      *debian*) FAMILY="debian" ;;
      *rhel*|*fedora*) FAMILY="rhel" ;;
      *alpine*) FAMILY="alpine" ;;
      *arch*) FAMILY="arch" ;;
      *suse*) FAMILY="suse" ;;
      *) FAMILY="unknown" ;;
    esac
    ;;
esac

if [ -n "$DISTRO_ID" ]; then
  ok "${PRETTY_NAME:-$DISTRO_ID $DISTRO_VERSION}（按 ${FAMILY} 系列处理）"
else
  warn "无法识别发行版（/etc/os-release 缺失），将尝试通用方式"
fi

# 架构：目前只发布 amd64 镜像
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ok "架构 $ARCH" ;;
  aarch64|arm64)
    warn "架构 $ARCH —— 本项目目前只构建 amd64 镜像"
    info "在 ARM 机器上会尝试用模拟运行，性能较差。如需原生支持请提 issue。"
    ;;
  *) warn "架构 $ARCH 未经验证" ;;
esac

# -----------------------------------------------------------------------------
# 2. 补齐基础工具
#
# 这一节的必要性来自实测：最小化的 debian:13-slim 里
# **没有 curl、没有 wget、没有 openssl**。而安装 Docker 的官方脚本
# 需要 curl 或 wget。所以"先装 Docker"这一步本身要先有条件。
# -----------------------------------------------------------------------------
step "检查基础工具"

# 找一个可用的下载工具；两个都没有就装一个
DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then DOWNLOADER="wget"
fi

# 包管理器输出重定向到日志，只在失败时回显。
#
# 这不是洁癖：实测 apt 在装 curl 时会刷出一屏 `Reading database ... 5% ... 95%`
# 的 dpkg 进度。对刚上手的人来说，「一屏看不懂的输出」和「安装出错了」没有区别，
# 会直接导致他们中断安装来问问题。安静地成功，比详细地成功更有用。
PKG_LOG="/tmp/autoquant-pkg-$$.log"

pkg_install() {
  # 用各发行版的包管理器安装；只用于安装少量基础包
  if (
    case "$FAMILY" in
      debian)
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq && apt-get install -y -qq --no-install-recommends "$@"
        ;;
      rhel)
        if command -v dnf >/dev/null 2>&1; then dnf install -y -q "$@"
        else yum install -y -q "$@"; fi
        ;;
      alpine) apk add --no-cache "$@" ;;
      arch)   pacman -Sy --noconfirm --needed "$@" ;;
      suse)   zypper --non-interactive --quiet install "$@" ;;
      *) exit 127 ;;
    esac
  ) >"$PKG_LOG" 2>&1; then
    rm -f "$PKG_LOG"
    return 0
  fi

  # 失败时把日志尾部打出来 —— 出错时有线索，成功时保持安静
  err "包安装失败（$*）"
  tail -15 "$PKG_LOG" 2>/dev/null | sed 's/^/        /' >&2
  return 1
}

# 静默尝试：失败不打印任何东西，交给调用方决定是否汇报。
#
# 需要有这个变体是因为回退链的存在：如果每一次候选都打错误信息，
# 用户会看到「✗ 安装失败」紧接着「✓ 安装完成」—— 实测过，
# 那看起来像出了故障，而实际上只是第一个候选包名在该发行版上不存在。
pkg_install_quiet() {
  pkg_install "$@" >/dev/null 2>&1
}

if [ -z "$DOWNLOADER" ]; then
  info "没有 curl 也没有 wget，正在安装…"
  # ⚠️ **必须同时装 ca-certificates**。
  #
  # 只装 curl 是不够的，而且失败方式极具误导性：最小化的 debian:13-slim 里
  # 没有 /etc/ssl/certs/ca-certificates.crt，于是每一个 HTTPS 请求都以
  #     curl: (77) error setting certificate file: /etc/ssl/certs/ca-certificates.crt
  # 失败。而"下不动东西"看起来像网络问题，会让人往错的方向排查很久。
  #
  # 实测出来的：只装 curl 时官方 Docker 脚本取不下来（静默退回到较旧的发行版
  # 仓库版本）；连 ca-certificates 一起装就正常了。
  if pkg_install curl ca-certificates 2>/dev/null; then
    DOWNLOADER="curl"
    ok "已安装 curl 与 ca-certificates"
  elif pkg_install wget ca-certificates 2>/dev/null; then
    DOWNLOADER="wget"
    ok "已安装 wget 与 ca-certificates"
  else
    die "无法安装下载工具。请手动安装 curl 或 wget 后重试。"
  fi
else
  ok "下载工具：$DOWNLOADER"
fi

# 即便已有 curl/wget，证书包也可能缺失（最小化系统常见）。
# 单独检查一次，因为它不影响"命令是否存在"，只影响 HTTPS 能否成功，
# 而后者要到真正下载时才暴露。
if [ ! -e /etc/ssl/certs/ca-certificates.crt ] && [ ! -d /etc/ssl/certs ]; then
  info "缺少 CA 证书，正在安装…"
  pkg_install ca-certificates >/dev/null 2>&1 || true
  # 某些发行版需要显式刷新证书链接
  command -v update-ca-certificates >/dev/null 2>&1 && update-ca-certificates >/dev/null 2>&1 || true
fi

# 统一的下载函数
fetch() {
  # fetch <url> [输出文件]；没有输出文件时写到 stdout
  local url="$1" out="${2:-}"
  if [ "$DOWNLOADER" = "curl" ]; then
    if [ -n "$out" ]; then curl -fsSL --connect-timeout 20 -o "$out" "$url"
    else curl -fsSL --connect-timeout 20 "$url"; fi
  else
    if [ -n "$out" ]; then wget -q -T 20 -O "$out" "$url"
    else wget -q -T 20 -O - "$url"; fi
  fi
}

# 带凭据下载（仓库仍是私有时用）。
# Token 走请求头而不是 URL —— URL 会出现在日志、进程列表与错误信息里。
fetch_authed() {
  local url="$1" out="$2" token="$3"
  if [ "$DOWNLOADER" = "curl" ]; then
    curl -fsSL --connect-timeout 20 \
      -H "Authorization: Bearer $token" \
      -H "Accept: application/vnd.github.raw" \
      -o "$out" "$url"
  else
    wget -q -T 20 --header="Authorization: Bearer $token" -O "$out" "$url"
  fi
}

# openssl 用于生成密钥；没有就用 /dev/urandom 兜底（见下），所以不是硬依赖
if command -v openssl >/dev/null 2>&1; then
  ok "openssl"
else
  info "没有 openssl —— 密钥将用 /dev/urandom 生成（结果同样安全）"
  pkg_install openssl >/dev/null 2>&1 && ok "已安装 openssl" || true
fi

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# -----------------------------------------------------------------------------
# 3. 安装 Docker
# -----------------------------------------------------------------------------
step "检查 Docker"

DOCKER_JUST_INSTALLED=0

if command -v docker >/dev/null 2>&1; then
  ok "Docker 已安装：$(docker --version 2>/dev/null | head -1)"
else
  info "没有找到 Docker，正在安装…"
  info "（这一步会从官方源下载，视网络情况需要一到几分钟）"

  install_docker() {
    case "$FAMILY" in
      alpine)
        # Alpine 用官方仓库。get.docker.com 不支持 musl。
        pkg_install_quiet docker docker-cli-compose
        return $?
        ;;
      arch)
        pkg_install_quiet docker docker-compose
        return $?
        ;;
    esac

    # Debian / RHEL / Fedora / openSUSE：优先用官方便捷脚本 ——
    # 它会配置 Docker 自己的软件源，拿到的是较新的版本。
    #
    # ⚠️ 注意 fetch 的签名是 `fetch <url> <输出文件>`（位置参数，**没有 `-o`**）。
    #    这里曾经写成 `fetch <url> -o <文件>`，于是输出文件参数变成了字面量 "-o"，
    #    curl 把内容写进了一个名叫 `-o` 的文件，真正要用的文件从未生成 ——
    #    结果被误判成"网络取不到官方脚本"，静默退回到较旧的发行版仓库版本。
    if fetch https://get.docker.com /tmp/get-docker.sh 2>/dev/null; then
      if sh /tmp/get-docker.sh >"$PKG_LOG" 2>&1; then
        rm -f /tmp/get-docker.sh "$PKG_LOG"
        return 0
      fi
      rm -f /tmp/get-docker.sh
      # 把官方脚本失败的原因打出来。
      # 之前这里只报"改用发行版仓库"，用户（和我们自己）都看不到根因 ——
      # 实测中官方脚本会因为发行版已 EOL、镜像源不可达、缺少 dnf 插件等原因失败，
      # 每一种的处理方式都不同，藏起来等于让人从零开始排查。
      warn "官方安装脚本执行失败，改用发行版仓库的 Docker"
      info "官方脚本最后几行输出："
      tail -6 "$PKG_LOG" 2>/dev/null | sed 's/^/        /' >&2
    else
      warn "无法获取官方安装脚本，改用发行版仓库的 Docker"
    fi

    # 回退：用发行版仓库。
    #
    # ⚠️ 包名是**在真机上实测出来的**，不是照文档猜的。这里踩过一个坑：
    #    Debian 13 的 `docker.io` 包**只装守护进程**（dockerd / docker-proxy /
    #    docker-init），**不含 `docker` 命令行** —— CLI 是另一个独立的包
    #    `docker-cli`。少装它的表现非常迷惑：apt 报告安装成功，
    #    但 `command -v docker` 找不到命令，于是脚本判定安装失败。
    #    另外 `docker-compose-plugin` 与 `docker-ce` 在 Debian 仓库里根本不存在。
    #
    #    所以顺序是：引擎（含 CLI）→ 再单独补 CLI（老版本 Debian 才有独立的
    #    这个包）→ 最后 compose。每一步都容错，最后统一验证。
    case "$FAMILY" in
      debian)
        pkg_install_quiet docker.io || true
        pkg_install_quiet docker-cli || true          # Debian 13 需要它才有 docker 命令
        pkg_install_quiet docker-compose || true
        ;;
      rhel)
        pkg_install_quiet docker || true
        pkg_install_quiet docker-compose-plugin || pkg_install_quiet docker-compose || true
        ;;
      suse)
        pkg_install_quiet docker || true
        pkg_install_quiet docker-compose || true
        ;;
      *) return 1 ;;
    esac

    # 统一在这里验证，而不是相信包管理器报了成功
    if ! command -v docker >/dev/null 2>&1; then
      err "命令 \`docker\` 仍不可用"
      info "可能是该发行版把 CLI 拆到了单独的包里。请手动安装后重试："
      info "    https://docs.docker.com/engine/install/"
      return 1
    fi
    return 0
  }

  if ! install_docker; then
    err "Docker 安装失败。"
    echo ""
    echo "  请手动安装后重新运行本脚本："
    echo "      https://docs.docker.com/engine/install/"
    echo ""
    exit 1
  fi

  DOCKER_JUST_INSTALLED=1
  ok "Docker 安装完成"
fi

# 启动守护进程（容器环境里 systemctl 可能不可用，所以每步都容错）
if ! docker info >/dev/null 2>&1; then
  info "启动 Docker 服务…"
  systemctl enable --now docker 2>/dev/null \
    || service docker start 2>/dev/null \
    || rc-service docker start 2>/dev/null \
    || true

  # 给它一点启动时间
  for _ in $(seq 1 15); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! docker info >/dev/null 2>&1; then
  die "Docker 守护进程无法启动。请检查：systemctl status docker"
fi
ok "Docker 守护进程运行中"

# compose：优先用 v2 插件（`docker compose`），退回独立二进制（`docker-compose`）
if docker compose version >/dev/null 2>&1; then
  COMPOSE_KIND="plugin"
  ok "docker compose 插件可用"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_KIND="standalone"
  ok "$(docker-compose --version 2>/dev/null | head -1)"
else
  info "缺少 compose，正在安装…"
  # 包名同样是实测的：Debian 13 只有 `docker-compose`（2.26.x，即 Compose v2，
  # 它能作为 CLI 插件工作，因此 `docker compose` 也可用），没有 `docker-compose-plugin`。
  case "$FAMILY" in
    debian) pkg_install_quiet docker-compose || true ;;
    rhel)   pkg_install_quiet docker-compose-plugin || pkg_install_quiet docker-compose || true ;;
    alpine) pkg_install_quiet docker-cli-compose || true ;;
    arch)   pkg_install_quiet docker-compose || true ;;
    suse)   pkg_install_quiet docker-compose || true ;;
  esac

  if docker compose version >/dev/null 2>&1; then
    COMPOSE_KIND="plugin"
    ok "compose 插件已安装"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_KIND="standalone"
    ok "已安装 $(docker-compose --version 2>/dev/null | head -1)"
  else
    err "无法安装 compose。请手动安装后重试："
    echo "      https://docs.docker.com/compose/install/"
    exit 1
  fi
fi

# -----------------------------------------------------------------------------
# 4. 镜像是否需要凭据
#
# **先试匿名拉取**，而不是上来就要求 token。
#
# 镜像是公开的（本项目开源后即是），匿名拉取直接成功，整个安装过程
# 不需要任何输入 —— 这才是一键安装该有的样子。
#
# 只有匿名失败（镜像仍是私有的，或私有复刻的镜像）才索取 token。
# 这样同一份脚本既能用于公开版本，也能用于私有部署，不需要改代码。
# -----------------------------------------------------------------------------
step "检查镜像可访问性"

REGISTRY_HOST="${DEFAULT_IMAGE%%/*}"
NEED_LOGIN=0

if docker manifest inspect "$DEFAULT_IMAGE" >/dev/null 2>&1; then
  ok "镜像可匿名拉取（$DEFAULT_IMAGE）"
else
  NEED_LOGIN=1
fi

if [ "$NEED_LOGIN" = "1" ]; then
  # 也许本地已经有凭据
  if [ -f "$HOME/.docker/config.json" ] && grep -q "$REGISTRY_HOST" "$HOME/.docker/config.json" 2>/dev/null; then
    ok "已登录 $REGISTRY_HOST（复用已有凭据）"
  else
    step "登录镜像仓库"

    TOKEN="${GHCR_TOKEN:-}"

    if [ -z "$TOKEN" ]; then
      if [ ! -t 0 ]; then
        err "该镜像需要凭据，但当前不是交互式终端。"
        echo ""
        echo "  请通过环境变量提供："
        echo "      GHCR_TOKEN=<你的令牌> bash install.sh"
        exit 1
      fi

      echo ""
      echo "  这个镜像是私有的，需要一次性授权。"
      echo ""
      echo "  请准备一个 Personal Access Token（只勾 read:packages）："
      echo "      https://github.com/settings/tokens/new?scopes=read:packages"
      echo ""
      printf '  粘贴令牌后回车（输入不会显示）：'
      read -rs TOKEN
      echo ""
    fi

    [ -n "$TOKEN" ] || die "没有提供令牌。"

    if printf '%s' "$TOKEN" | docker login "$REGISTRY_HOST" -u "${GHCR_USER:-oauth2}" --password-stdin >/dev/null 2>&1; then
      ok "登录成功"
      export INSTALLER_TOKEN="$TOKEN"
    else
      die "登录失败。请确认令牌有效且勾选了 read:packages 权限。"
    fi
  fi
fi

# -----------------------------------------------------------------------------
# 5. 准备部署文件
#
# 优先使用本目录里已有的文件（从仓库获取的完整 deploy/ 目录）。
# 如果只有 install.sh 这一个文件（有人只拷了它），就用 token 从仓库取。
# 这样既能单文件使用，又不会让 compose 出现两份实现而产生漂移。
# -----------------------------------------------------------------------------
step "准备部署文件"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

need_file() {
  # need_file <文件名> <仓库路径>
  local name="$1" repo_path="$2"

  # 情况一：目标目录已有 → 用它
  if [ -f "$INSTALL_DIR/$name" ]; then
    ok "$name（已存在，保留）"
    return 0
  fi

  # 情况二：脚本所在目录有 → 拷过来（正常的仓库部署方式）
  if [ -f "$SCRIPT_DIR/$name" ]; then
    cp "$SCRIPT_DIR/$name" "$INSTALL_DIR/$name"
    ok "$name"
    return 0
  fi

  # 情况三：只有 install.sh 一个文件 → 从仓库取。
  # 仓库公开时直接下载；仍是私有的才需要凭据。
  local url="https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/${repo_path}"
  info "$name 不存在，正在从仓库获取…"

  if fetch "$url" "$INSTALL_DIR/$name" 2>/dev/null; then
    ok "$name（从仓库获取）"
    return 0
  fi

  # 公开地址取不到 —— 试带凭据（私有仓库的情形）
  local token="${INSTALLER_TOKEN:-${GHCR_TOKEN:-}}"
  if [ -n "$token" ] && fetch_authed "$url" "$INSTALL_DIR/$name" "$token" 2>/dev/null; then
    ok "$name（带凭据从仓库获取）"
    return 0
  fi

  err "无法获取 $name。"
  echo "  请把仓库里的 deploy/ 目录一并放到服务器上，或提供 GHCR_TOKEN。"
  return 1
}

need_file "docker-compose.yml" "deploy/docker-compose.yml"
need_file ".env.example"      "deploy/.env.example"
need_file "up.sh"             "deploy/up.sh"
chmod +x up.sh

# -----------------------------------------------------------------------------
# 6. 交给 up.sh
#
# 后面的逻辑（生成密钥、拉镜像、启动、健康检查、子命令）都在 up.sh 里，
# 这里不重复实现 —— 单一实现来源，避免两处行为不一致。
# -----------------------------------------------------------------------------
step "开始部署"

export AUTOQUANT_IMAGE="${AUTOQUANT_IMAGE:-$DEFAULT_IMAGE}"

exec ./up.sh

# exec 之后不会执行到这里
