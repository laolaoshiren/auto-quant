#!/bin/sh
# 提交前检查：拦截敏感信息与站点专属配置。
#
# 由 scripts/install-hooks.ps1 安装到 .git/hooks/pre-commit。
# 本文件**纳入版本控制**，因此它只包含通用规则，不含任何站点专属值。
#
# 站点专属规则（域名、服务器 IP、主机名）在**运行时**从 sensitive-patterns.txt 读取，
# 该文件已 gitignore。这样钩子可以被团队共享，而不必把任何人的私有信息写进来。
#
# 紧急绕过（请先确认内容真的可以公开）：
#     git commit --no-verify
#
# ---------------------------------------------------------------------------
# 设计原则：宁可漏报，不可误报
#
# 一个会拦截正常提交的钩子比没有钩子更糟 —— 它会让人养成用 --no-verify 的习惯，
# 于是钩子对所有提交都失效，包括真正危险的提交。所以：
#
#   · 路径类检查看的是**新增的文件名**，不是行内容。
#     否则文档里写一句 `cp .env.example .env` 就会被误判。
#   · 内容类检查只保留高精度的凭据格式，不匹配"提到这些名字"的说明文字。
# ---------------------------------------------------------------------------

set -e

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo .)
CUSTOM_FILE="$REPO_ROOT/sensitive-patterns.txt"
FLAG=$(mktemp)
trap 'rm -f "$FLAG"' EXIT

echo "提交前检查…"

# ===========================================================================
# 一、路径检查：新增的文件本身是否是禁区
# ===========================================================================
ADDED_FILES=$(git diff --cached --name-only --diff-filter=A 2>/dev/null || true)

for f in $ADDED_FILES; do
    case "$f" in
        .env|.env.local|.env.*|deploy.local.ps1|sensitive-patterns.txt)
            # .env.example 是模板，必须允许
            if [ "$f" != ".env.example" ]; then
                echo "  ✗ 禁止提交的文件: $f"
                echo "x" >> "$FLAG"
            fi
            ;;
        data/*|docs/research/vendor/*)
            echo "  ✗ 禁止提交的目录下的文件: $f"
            echo "x" >> "$FLAG"
            ;;
        *.sqlite|*.sqlite-wal|*.sqlite-shm|*.master.key|*.pem|*.key|*.p12|*.pfx|*.jks|*.keystore)
            echo "  ✗ 数据库或密钥文件: $f"
            echo "x" >> "$FLAG"
            ;;
        id_rsa*|id_ed25519*|known_hosts|.npmrc|credentials.json)
            echo "  ✗ 凭据文件: $f"
            echo "x" >> "$FLAG"
            ;;
    esac
done

# ===========================================================================
# 二、内容检查：只针对高精度的凭据格式
# ===========================================================================
ADDED=$(git diff --cached --unified=0 --no-color 2>/dev/null | grep -E '^\+' | grep -v '^+++' || true)

if [ -n "$ADDED" ]; then
    check_content() {
        label="$1"
        pattern="$2"
        [ -z "$pattern" ] && return 0
        hits=$(printf '%s\n' "$ADDED" | grep -nE "$pattern" 2>/dev/null | head -5 || true)
        if [ -n "$hits" ]; then
            echo ""
            echo "  ✗ $label"
            printf '%s\n' "$hits" | sed 's/^/      /'
            echo "x" >> "$FLAG"
        fi
    }

    # 通用凭据格式。这些特征与任何具体站点无关，可以安全地写进版本控制，
    # 同样的规则在 CI 中也有一份（.github/workflows/ci.yml）。
    check_content "LLM API Key（sk-… 风格）"        'sk-[A-Za-z0-9_-]{32,}'
    check_content "GitHub Token（ghp_ / gho_ …）"   'gh[pousr]_[A-Za-z0-9]{36,}'
    check_content "AWS Access Key"                   'AKIA[0-9A-Z]{16}'
    check_content "私钥内容"                          'BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE KEY'
    check_content "硬编码的密钥赋值"                   '(api[_-]?secret|secret[_-]?key|private[_-]?key|passphrase)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9/+_-]{24,}'

    # -----------------------------------------------------------------------
    # 站点专属规则：运行时从 gitignored 的文件读取。
    #
    # 每行一个规则，两种写法：
    #     my-internal-domain\.example
    #     测试域名=my-internal-domain\.example      ← 报错时显示名称，更好定位
    # 以 # 开头的行忽略。
    # -----------------------------------------------------------------------
    if [ -f "$CUSTOM_FILE" ]; then
        while IFS= read -r line || [ -n "$line" ]; do
            line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
            [ -z "$line" ] && continue
            case "$line" in \#*) continue ;; esac

            case "$line" in
                *=*)
                    label=$(printf '%s' "$line" | cut -d= -f1)
                    pattern=$(printf '%s' "$line" | cut -d= -f2-)
                    ;;
                *)
                    label="站点专属信息"
                    pattern="$line"
                    ;;
            esac
            check_content "$label" "$pattern"
        done < "$CUSTOM_FILE"
    fi
fi

# ===========================================================================
if [ -s "$FLAG" ]; then
    echo ""
    echo "────────────────────────────────────────────────────────────"
    echo "提交被拒绝：检测到疑似敏感信息。"
    echo ""
    echo "若确认是误报（例如你的改动本身就在讨论这些格式），用："
    echo "    git commit --no-verify"
    echo ""
    echo "但请先认真确认：这个值真的可以进入仓库吗？"
    echo "仓库一旦推送，历史就很难彻底抹掉 —— 密钥必须视为已泄露并轮换。"
    echo "────────────────────────────────────────────────────────────"
    exit 1
fi

echo "  ✓ 未发现敏感信息"
exit 0
