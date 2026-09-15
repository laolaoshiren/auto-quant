# 安装本地 Git 钩子：提交前拦截敏感信息
#
#   pwsh -File scripts/install-hooks.ps1
#   pwsh -File scripts/install-hooks.ps1 -Uninstall
#
# ---------------------------------------------------------------------------
# 为什么用本地钩子，而不是只靠 CI
# ---------------------------------------------------------------------------
# 要防的是"把站点专属信息写进仓库"——域名、服务器 IP、主机名之类。
# 但如果把这些值写进 CI 配置来检测它们，CI 配置本身就成了泄漏源。这是个死结，
# 本地钩子是唯一能真正解开的做法：
#
#   · `.git/hooks/` 永远不会被提交，所以检测值不会进仓库
#   · 检出发生在提交**之前**，所以问题内容根本不会进入历史
#
# 而钩子脚本本身（scripts/pre-commit.sh）是纳入版本控制的，只含通用凭据格式，
# 因此全团队可以共用同一个钩子，各自维护自己的私有规则文件。
#
# ---------------------------------------------------------------------------
# 用法
# ---------------------------------------------------------------------------
# 1. 创建 `sensitive-patterns.txt`（已 gitignore），每行一条正则：
#
#      my-internal-domain\.example
#      203\.0\.113\.7
#      my-server-hostname
#
#    推荐写成 `名称=正则`，报错时会显示名称，更容易定位：
#
#      内网测试域名=my-internal-domain\.example
#      测试服务器IP=203\.0\.113\.7
#
# 2. 运行本脚本安装钩子。之后每次提交都会自动检查。

param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path (Join-Path $repoRoot '.git'))) {
    Write-Host "当前目录不是 git 仓库，无法安装钩子。" -ForegroundColor Red
    exit 1
}

$hookPath = Join-Path $repoRoot '.git/hooks/pre-commit'

if ($Uninstall) {
    if (Test-Path $hookPath) {
        Remove-Item $hookPath -Force
        Write-Host "已卸载 pre-commit 钩子。" -ForegroundColor Green
    } else {
        Write-Host "未安装 pre-commit 钩子。" -ForegroundColor Yellow
    }
    exit 0
}

$source = Join-Path $PSScriptRoot 'pre-commit.sh'
if (-not (Test-Path $source)) {
    Write-Host "找不到 scripts/pre-commit.sh。" -ForegroundColor Red
    exit 1
}

# 统一换行符为 LF。
# git 在 Windows 上通过 sh 执行钩子，CRLF 会导致 'bad interpreter: No such file'。
$content = [System.IO.File]::ReadAllText($source) -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($hookPath, $content)

# 可执行位：Windows 上无效但无害；WSL / Unix 上必需。
try { & git update-index --chmod=+x --add --cacheinfo "100755,$(& git hash-object -w $hookPath),.git/hooks/pre-commit" 2>&1 | Out-Null } catch { }

Write-Host "已安装 pre-commit 钩子" -ForegroundColor Green
Write-Host "  $hookPath"
Write-Host ""

# 顺手检查私有规则文件是否存在并提示
$patternsFile = Join-Path $repoRoot 'sensitive-patterns.txt'
if (Test-Path $patternsFile) {
    $rules = Get-Content $patternsFile |
        Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') }
    Write-Host "已读取 $($rules.Count) 条站点专属规则：" -ForegroundColor Cyan
    $rules | Select-Object -First 10 | ForEach-Object { "    $_" }
    if ($rules.Count -gt 10) { Write-Host "    … 另有 $($rules.Count - 10) 条" }
} else {
    Write-Host "提示：尚未创建 sensitive-patterns.txt。" -ForegroundColor Yellow
    Write-Host "      通用凭据格式已被拦截，但**站点专属信息（域名、IP、主机名）需要你显式添加**。" -ForegroundColor Yellow
    Write-Host "      参考 sensitive-patterns.example.txt 建一个同名的文件即可。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "钩子会在提交前检查新增内容，命中时拒绝提交（可用 --no-verify 绕过）。" -ForegroundColor Cyan
