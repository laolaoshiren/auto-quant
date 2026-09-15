# 部署到远程服务器
#
#   pwsh -File scripts/deploy.ps1 -Server my-server
#   pwsh -File scripts/deploy.ps1 -Server my-server -PublicUrl https://quant.example.com
#
# 本脚本刻意**不含任何站点专属信息**（主机别名、域名、服务器路径）。那些属于部署者
# 自己的环境，不属于项目代码：把某个人的服务器域名写进仓库，既让新人困惑，也让仓库
# 一旦转公开就变成信息泄漏。
#
# 把常用值写进 `deploy.local.ps1`（已在 .gitignore 中）即可免去每次输入：
#
#   @{ Server = 'my-server'; RemoteDir = '/opt/autoquant'; PublicUrl = 'https://quant.example.com' }
#
# 用法：  pwsh -File scripts/deploy.ps1 -Server my-server
#
# --- 为什么排除列表写死在脚本里 -------------------------------------------------
#
# 打包时必须排除 `.env`。曾经漏掉过一次，结果本地的开发配置覆盖了服务器的实盘配置，
# **服务静默切到了模拟盘** —— 不报错，只是所有交易悄悄跑到错误的环境上。这类问题
# 不会自己暴露，所以排除项固化在这里，而不是靠每次记得。
#
# 其余排除项：node_modules（服务器上重装更快）、data（服务器上的数据库与密钥，绝不
# 能被覆盖）、dist（服务器上重新构建）、vendor（大体积可再生的研究资料）。

param(
    [string]$Server,
    [string]$RemoteDir,
    [string]$PublicUrl,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

# --- 本地覆盖（不进仓库） ----------------------------------------------------
$localConfig = Join-Path $repoRoot 'deploy.local.ps1'
if (Test-Path $localConfig) {
    $cfg = & $localConfig
    if (-not $Server)    { $Server    = $cfg.Server }
    if (-not $RemoteDir) { $RemoteDir = $cfg.RemoteDir }
    if (-not $PublicUrl) { $PublicUrl = $cfg.PublicUrl }
}
if (-not $RemoteDir) { $RemoteDir = '/opt/autoquant' }

if (-not $Server) {
    Write-Host "缺少 -Server 参数。" -ForegroundColor Red
    Write-Host "请传入目标主机（ssh 别名或 user@host），或创建 deploy.local.ps1：" -ForegroundColor Yellow
    Write-Host "    @{ Server = 'my-server'; RemoteDir = '/opt/autoquant' }" -ForegroundColor Yellow
    exit 1
}

$excludes = @(
    '--exclude=./.env',                 # ← 关键：绝不覆盖服务器的环境配置
    '--exclude=./.env.local',
    '--exclude=./deploy.local.ps1',
    '--exclude=./node_modules',
    '--exclude=./packages/*/node_modules',
    '--exclude=./data',                 # 数据库、主密钥、JWT 密钥、日志
    '--exclude=./packages/web/dist',
    '--exclude=./docs/research/vendor', # 大体积可再生的供应商文档副本
    '--exclude=./.git',
    '--exclude=./_deploy.tar.gz'
)

Write-Host "==> 打包（排除 .env / data / node_modules）" -ForegroundColor Cyan
$archive = Join-Path $repoRoot '_deploy.tar.gz'
if (Test-Path $archive) { Remove-Item $archive -Force }

& tar -czf $archive @excludes -C $repoRoot . 2>&1 | Out-Null
$sizeKb = [math]::Round((Get-Item $archive).Length / 1KB, 1)
Write-Host "    $sizeKb KB"

Write-Host "==> 传输到 ${Server}:/tmp/aq.tar.gz" -ForegroundColor Cyan
& scp -o BatchMode=yes $archive "${Server}:/tmp/aq.tar.gz" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "scp 失败" }
Remove-Item $archive -Force

$remote = @"
set -e
export PATH=/usr/local/node22/bin:`$PATH
cd $RemoteDir

# 解压前先看一眼 .env 是否还在，避免把它弄丢
HAD_ENV=`$( [ -f .env ] && echo yes || echo no )
tar -xzf /tmp/aq.tar.gz -C $RemoteDir
rm -f /tmp/aq.tar.gz

if [ "`$HAD_ENV" = "no" ]; then
  echo "  ⚠️  服务器上原本没有 .env —— 请确认环境配置！"
else
  echo "  .env 保持不变：`$(grep -E '^BINANCE_USE_TESTNET' .env || echo '未设置')"
fi

chown -R autoquant:autoquant $RemoteDir 2>/dev/null || true
chmod 600 .env 2>/dev/null || true
"@

if (-not $SkipBuild) {
    $remote += @"

echo "==> 在服务器上重建前端"
sudo -u autoquant env PATH=/usr/local/node22/bin:`$PATH npm run build 2>&1 | grep -E 'built in|error' | head -3
"@
}

$remote += @"

echo "==> 重启服务"
systemctl restart autoquant
sleep 15
echo -n "    服务状态: "; systemctl is-active autoquant

# 服务绑定在 Docker 网桥网关（供反向代理容器访问），公网无法直接路由到它。
# 所以健康检查走绑定地址，而不是 127.0.0.1。
BIND=`$(grep -E '^HOST=' .env | cut -d= -f2)
BIND=`${BIND:-172.17.0.1}
echo -n "    监听地址: `$BIND:27137"
echo ""
echo -n "    健康检查: "; curl -s --max-time 8 http://`$BIND:27137/api/health
echo ""
"@

if ($PublicUrl) {
    $remote += @"

echo -n "    公网访问: "; curl -s -o /dev/null -w "HTTP %{http_code}" --max-time 10 $PublicUrl || echo "（不可达）"
echo ""
"@
}

Write-Host "==> 远端执行" -ForegroundColor Cyan
$output = ssh -o BatchMode=yes $Server $remote 2>&1
$output | ForEach-Object { "    $_" }

Write-Host "==> 完成" -ForegroundColor Green
