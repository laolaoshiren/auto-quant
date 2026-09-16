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
# 其余排除项：node_modules（服务器上重装较快）、data（服务器上的数据库与密钥，绝不
# 能被覆盖）、vendor（大体积可再生的研究资料）。
#
# ⚠️ `dist` **不在排除列表里**，这是刻意的，也是踩过坑之后的决定。
#
# 原设计是"服务器上重新构建"，理由是避免陈旧产物。但部署目标常常是**小内存机器**
# （2 GB、且**没有 swap**），而 `vite build` 处理两千多个模块时很容易超过可用内存 ——
# 结果是**服务器被 OOM 打死**，还得人工重启。构建产物是纯静态文件，本地构建完直接
# 传过去不占用目标机任何构建内存，这个方向明显更安全。
#
# 顺带的好处：服务器上不再需要 devDependencies。

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
    '--exclude=./docs/research/vendor', # 大体积可再生的供应商文档副本
    '--exclude=./.git',
    '--exclude=./_deploy.tar.gz'
    # 注意：dist **不排除** —— 本地构建好一起传，见文件顶部说明。
)

# ---------------------------------------------------------------------------
# 本地构建前端
# ---------------------------------------------------------------------------
# 在**本地**构建，产物随包传过去。目标机常常是 2 GB 且无 swap 的小机器，
# 在上面跑 `vite build` 会把它 OOM 打死（真实发生过，还需要人工重启）。
#
# 这一步放在打包之前：构建失败就该**中止部署**，而不是把一个不完整/陈旧的包
# 传到线上。
if (-not $SkipBuild) {
    Write-Host "==> 本地构建前端" -ForegroundColor Cyan
    & npm run build 2>&1 | Select-String -Pattern 'built in|error|✗' | ForEach-Object { Write-Host "    $($_.Line.Trim())" }
    if ($LASTEXITCODE -ne 0) { throw "本地构建失败，已中止部署（不会把陈旧产物传上去）" }

    $distIndex = Join-Path $repoRoot 'packages/web/dist/index.html'
    if (-not (Test-Path $distIndex)) { throw "构建完成但找不到 packages/web/dist/index.html —— 产物不完整，已中止" }
} else {
    Write-Host "==> 跳过本地构建（-SkipBuild），将使用现有的 packages/web/dist" -ForegroundColor Yellow
    if (-not (Test-Path (Join-Path $repoRoot 'packages/web/dist/index.html'))) {
        throw "packages/web/dist 不存在，无法跳过构建。去掉 -SkipBuild 或先手动构建一次。"
    }
}

Write-Host "==> 打包（排除 .env / data / node_modules；含前端产物）" -ForegroundColor Cyan
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

# 前端产物目录先删干净再解包。
#
# `vite build` 给每个 chunk 起带内容哈希的名字，所以每次构建的文件名都不同。
# 而 `tar -x` 只覆盖、不删除 —— 结果是**每次部署都在服务器上留下一批陈旧 chunk**：
# 实测一次累积到 69 个文件，而本地构建只有 35 个。它们不会被 index.html 引用，
# 但会一直占着磁盘，也让"服务器上到底是哪一版"变得难以判断。
#
# `dist` 完全由构建产出，删掉再解包是安全的；源码与 data 都不在这个目录里。
rm -rf packages/web/dist

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

$remote += @"

# ---------------------------------------------------------------------------
# 远端只做"装依赖"，**不再构建前端**
# ---------------------------------------------------------------------------
# 前端产物（packages/web/dist）在本地构建、随包一起传过来。原因见文件顶部：
# 目标机常常是 2 GB 且无 swap 的小机器，`vite build` 会把它打死。
#
# 依赖仍然要在服务器上装 —— node_modules 不适合跨平台传输。
# 用 --omit=dev：服务器通过 tsx 直接跑 TypeScript，不需要 typescript / @types 这些。
#
# 只在 package-lock 变了的时候装。没有这一步时，项目一新增依赖服务器就缺包，
# 而报错来自 vite（`Rollup failed to resolve import "@radix-ui/react-collapsible"`），
# 完全指不到"依赖没装"这个真正的原因 —— UI 重设计加了一批 Radix 包之后就这么炸过。
#
# HOME 必须指向可写目录：autoquant 的 shell 是 nologin，npm 写 ~/.npm/_logs 会失败，
# 报出来是 "Log files were not written"，看着像权限问题、其实是这个用户没有可写的 home。
LOCK_HASH=`$(md5sum package-lock.json | cut -d' ' -f1)
STAMP_FILE=.deploy-lock-hash
if [ "`$(cat `$STAMP_FILE 2>/dev/null)" != "`$LOCK_HASH" ]; then
    echo "==> 依赖有变化，正在安装（npm ci --omit=dev）"
    mkdir -p /tmp/aqhome
    chown autoquant:autoquant /tmp/aqhome 2>/dev/null || true
    if sudo -u autoquant env PATH=/usr/local/node22/bin:`$PATH HOME=/tmp/aqhome npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2; then
        echo "`$LOCK_HASH" > `$STAMP_FILE
        chown autoquant:autoquant `$STAMP_FILE 2>/dev/null || true
    else
        echo "    ✗ 依赖安装失败 —— 服务会起不来，请先看上面的 npm 输出"
    fi
else
    echo "==> 依赖未变化，跳过安装"
fi
"@

$remote += @"

echo "==> 重启服务"
systemctl restart autoquant
sleep 15
echo -n "    服务状态: "; systemctl is-active autoquant

# 服务绑定在 Docker 网桥网关（供反向代理容器访问），公网无法直接路由到它。
# 所以健康检查走绑定地址，而不是 127.0.0.1。
BIND=`$(grep -E '^HOST=' .env | cut -d= -f2)
BIND=`${BIND:-172.17.0.1}

# 端口必须读 .env，不能写死。
#
# 曾经写死过 27137（当时的默认值），而线上 .env 里是 PORT=3200 ——
# 于是部署日志里"健康检查"永远是空的，看起来像服务没起来，
# 实际上只是查错了端口。默认值会变，部署脚本不该假设它。
PORT=`$(grep -E '^PORT=' .env | cut -d= -f2)
PORT=`${PORT:-27137}

echo -n "    监听地址: `$BIND:`$PORT"
echo ""
echo -n "    健康检查: "; curl -s --max-time 8 http://`$BIND:`$PORT/api/health
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
