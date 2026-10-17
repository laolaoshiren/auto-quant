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
    [switch]$SkipBuild,
    # 允许在工作树不干净时部署（见下面「检查工作树是否干净」那段的原因）。
    [switch]$AllowDirty
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

# --- 全量备份（AGENTS.md 要求："定期 git bundle 做全量备份，保证本地完整"）------
#
# 为什么放在这里：部署是这个项目里最频繁的"有意义的时刻"，而"记得手动备份"恰恰最
# 容易忘 —— 实测这一次：仓库已经跑了 450 个提交，`.dsh/backups` 里**一个备份都没有**。
#
# 保留最近 5 个：bundle 只有 2–3 MB（本仓库实测），留几个不占地方；全留则无限增长。
# 失败**不阻断部署** —— 备份是保险，不是部署的前置条件。
$backupDir = Join-Path $repoRoot '.dsh\backups'
New-Item -ItemType Directory -Force $backupDir | Out-Null
$bundlePath = Join-Path $backupDir ('aq-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.bundle')
git -C $repoRoot bundle create $bundlePath --all *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "    ⚠️  git bundle 备份失败（继续部署）" -ForegroundColor Yellow
} else {
    Write-Host "    ✓ 已备份 $(Split-Path $bundlePath -Leaf)" -ForegroundColor DarkGray
    Get-ChildItem $backupDir -Filter '*.bundle' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 5 |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

$excludes = @(    '--exclude=./.env',                 # ← 关键：绝不覆盖服务器的环境配置
    '--exclude=./.env.local',
    '--exclude=./deploy.local.ps1',
    '--exclude=./node_modules',
    '--exclude=./packages/*/node_modules',
    '--exclude=./data',                 # 数据库、主密钥、JWT 密钥、日志
    '--exclude=./docs/research/vendor', # 大体积可再生的供应商文档副本
    '--exclude=./.git',
    # ⚠️ **`.dsh` 与 `.agent-teams` 必须排除** —— 2026-10-03 实测发现的问题：
    #
    # 上面的 bundle 清理**只在本地跑**（`Select-Object -Skip 5`），而服务器上没有任何
    # 清理。不排除 `.dsh` 时，每次部署都会把 5 个 bundle（约 15 MB）传上去并留在
    # `/opt/autoquant/.dsh/backups/` 里 —— **只增不减**。实测一天部署约 10 次后
    # 那里累积到 **87 个 · 247 MB**，而磁盘只剩 11 GB。
    #
    # 服务器需要的是**运行代码**，备份留在本地就够（它本来就是"本地完整"的保险）。
    '--exclude=./.dsh', '--exclude=./.agent-teams',   # 团队协作状态：含凭 brief 生成的 team.json 与 inbox，其中有部署者环境信息
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
#
# ## ⚠️ 两道闸，都**不能接管道**
#
# PowerShell 里 `cmd 2>&1 | Select-String ...` 之后，`$LASTEXITCODE` 是
# **`Select-String` 的**（有输入就返回 0），不是 `cmd` 的 —— 于是无论成功还是
# 失败都会读到 0，`throw` 永远不会执行。见 `docs/AGENTS.md` §3.1。
#
# 这个脚本原来正是这么写的（`& npm run build 2>&1 | Select-String ...`），
# 所以那句"构建失败，已中止部署"**从来没生效过**。重定向到文件再读退出码才是真的。
#
# ## ⚠️ 为什么必须先 typecheck
#
# `npm run build` **只编前端**（`--workspace @aq/web`）。服务端的语法错误它
# 一点都不会碰 —— 实测代价：一个漏掉的反引号让 `prompt.ts` 解析失败，
# 而"构建成功"照样放行、包照样传上去、**服务在线上进入崩溃循环**
# （`systemctl` 显示 `activating (auto-restart)`，进程 exit-code 1）。
# 类型检查是唯一能在本地拦住那类错误的闸。
if (-not $SkipBuild) {
    $tcLog = Join-Path $env:TEMP 'aq-typecheck.log'
    Write-Host "==> 类型检查（全仓）" -ForegroundColor Cyan
    & npm run typecheck *> $tcLog
    if ($LASTEXITCODE -ne 0) {
        Get-Content $tcLog | Select-String -Pattern 'error TS' | Select-Object -First 12 | ForEach-Object { Write-Host "    $($_.Line.Trim())" -ForegroundColor Red }
        throw "类型检查失败，已中止部署（服务端的错误 build 抓不到，只有这一步能拦）"
    }

    $buildLog = Join-Path $env:TEMP 'aq-build.log'
    Write-Host "==> 本地构建前端" -ForegroundColor Cyan
    # -----------------------------------------------------------------------
    # 把 HEAD 与构建时刻注入前端（Vite 只暴露 VITE_* 前缀的变量）
    # -----------------------------------------------------------------------
    # 为什么需要：控制台上原来只显示 package.json 的 version（`0.1.32`），
    # 那个值**在两次部署之间不变** —— 用户因此无法判断「我看到的是不是最新一版」，
    # 只能来问队长，而队长还要 SSH 回读 build-info.json。本批已多次因此产生
    # 「你改的没生效？」/「其实还没部署」的来回。
    #
    # 现在页面会显示 `9b88931 · 10-17 10:05`，部署完刷新即可核对。
    # ⚠️ 必须在 `npm run build` **之前**设置：Vite 在构建期把值内联进产物。
    $env:VITE_BUILD_COMMIT = (& git -C $repoRoot rev-parse --short HEAD).Trim()
    $env:VITE_BUILD_TIME = (Get-Date).ToString('MM-dd HH:mm')
    & npm run build *> $buildLog
    if ($LASTEXITCODE -ne 0) {
        Get-Content $buildLog | Select-String -Pattern 'error|✗' | Select-Object -First 12 | ForEach-Object { Write-Host "    $($_.Line.Trim())" -ForegroundColor Red }
        throw "本地构建失败，已中止部署（不会把陈旧产物传上去）"
    }
    Get-Content $buildLog | Select-String -Pattern 'built in' | Select-Object -First 2 | ForEach-Object { Write-Host "    $($_.Line.Trim())" }

    $distIndex = Join-Path $repoRoot 'packages/web/dist/index.html'
    if (-not (Test-Path $distIndex)) { throw "构建完成但找不到 packages/web/dist/index.html —— 产物不完整，已中止" }
} else {
    Write-Host "==> 跳过本地构建（-SkipBuild），将使用现有的 packages/web/dist" -ForegroundColor Yellow
    if (-not (Test-Path (Join-Path $repoRoot 'packages/web/dist/index.html'))) {
        throw "packages/web/dist 不存在，无法跳过构建。去掉 -SkipBuild 或先手动构建一次。"
    }
}

Write-Host "==> 检查工作树是否干净" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# 为什么部署前必须干净（2026-10-17 加，起因是一次真实事故）
# ---------------------------------------------------------------------------
# `deploy.ps1` 打包的是**整个工作树**（`tar -C $repoRoot .`），不是 HEAD。
# 所以工作树脏的时候，线上跑的东西 ≠ `build-info.json` 里的 `commitShort`
# —— 而 `commitShort` 正是「线上到底是哪一版」的**唯一**答案（服务器没有 .git）。
#
# 2026-10-17 15:53 就撞上了：部署时 `t111` 正在工作树里写两个测试文件，
# 结果线上 `dirty=true`。事后 `t93` 的独立核验不得不**逐个比 8 个文件的 sha256**
# 才能证明"线上确实等于 303967a"—— 把最硬的判据降级成了人工比对。
#
# 默认中止（而不是只告警）：一旦放行过一次，下一次就会变成"反正也能过"。
# 确实要在脏树上部署时用 `-AllowDirty`，并且那一次的 `dirty` 会如实记进 build-info。
if (-not $AllowDirty) {
    $dirtyPaths = @(& git -C $repoRoot status --porcelain)
    if ($dirtyPaths.Count -gt 0) {
        Write-Host ""
        Write-Host "    ✗ 工作树不干净，共 $($dirtyPaths.Count) 项：" -ForegroundColor Red
        $dirtyPaths | Select-Object -First 12 | ForEach-Object { Write-Host "        $_" -ForegroundColor Red }
        if ($dirtyPaths.Count -gt 12) { Write-Host "        …（还有 $($dirtyPaths.Count - 12) 项）" -ForegroundColor Red }
        Write-Host ""
        Write-Host "    这些改动会一起上线，而 build-info 里的 commitShort 只指向 HEAD。" -ForegroundColor Yellow
        Write-Host "    先 commit（或 stash）再部署；确实要带着改动上线用 -AllowDirty。" -ForegroundColor Yellow
        throw "工作树不干净，已中止部署。"
    }
    Write-Host "    ✓ 工作树干净"
}

Write-Host "==> 生成构建信息（build-info.json）" -ForegroundColor Cyan
# ---------------------------------------------------------------------------
# 为什么这个文件必须存在
# ---------------------------------------------------------------------------
# 服务器上**没有 `.git`**（部署是打包上传，`.git` 在下面的排除列表里），所以运行
# 目录里根本没有仓库 —— 它无法回答"我在跑哪个提交"。控制台「操作员账户」页那个
# 「服务端版本」格子因此长期显示一个硬编码的 `'0.1.0'`：一个永远不变的数字，
# 看起来像状态，其实什么都没说。
#
# 这个文件就是那条信息从构建机传到运行环境的**唯一通道**：HEAD、提交时间、以及
# 仓库地址（从 `origin` 读，所以本脚本自己仍然不含任何站点专属信息），一并写下来，
# 服务端读它并与远端比对"是否落后"。
#
# `dirty` 必须如实记录：工作区有未提交改动时，服务器跑的东西**不等于**这个提交，
# 而"版本一致"会让一个改到一半的部署看起来是干净的。
$gitSha = (& git -C $repoRoot rev-parse HEAD).Trim()
$buildInfo = [ordered]@{
    commit      = $gitSha
    commitShort = $gitSha.Substring(0, 7)
    branch      = (& git -C $repoRoot rev-parse --abbrev-ref HEAD).Trim()
    subject     = (& git -C $repoRoot log -1 --format=%s).Trim()
    committedAt = (& git -C $repoRoot log -1 --format=%cI).Trim()
    deployedAt  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss'Z'")
    dirty       = [bool](& git -C $repoRoot status --porcelain)
    repository  = ((& git -C $repoRoot remote get-url origin) -replace '\.git$', '').Trim()
}
[System.IO.File]::WriteAllText(
    (Join-Path $repoRoot 'build-info.json'),
    ($buildInfo | ConvertTo-Json),
    (New-Object System.Text.UTF8Encoding($false))
)
Write-Host "    $($buildInfo.branch) @ $($buildInfo.commitShort)$(if ($buildInfo.dirty) { '（工作区有未提交改动）' })"

Write-Host "==> 打包（排除 .env / data / node_modules；含前端产物）" -ForegroundColor Cyan
<#
  ⚠️ **归档文件名必须唯一（含 PID），不能是固定的 `_deploy.tar.gz`**（2026-10-15 修）

  ## 事故：两次部署并行时，一个删掉归档、另一个正在传它

  原来的写法：
  ```
    $archive = Join-Path $repoRoot '_deploy.tar.gz'   # 固定名
    …scp…
    Remove-Item $archive -Force                       # 跑完就删
  ```
  而 `deploy.ps1` 一次要跑几分钟。**两次并行**（我连续重试时就发生了）会撞车：
  ```
    A: 打包 → _deploy.tar.gz 就位
    B: 打包 → 覆盖同一个文件
    A: scp → 成功
    A: Remove-Item → 文件没了
    B: scp → scp: stat local "_deploy.tar.gz": No such file or directory  ❌
  ```
  症状是 **scp 失败（退出码 1）而网络完全正常** —— 我为此把它误判成"scp 抖动"
  并重试了好几轮，**而真相是并发竞争**。

  ## 为什么用 PID 而不是时间戳

  `$PID` 是**本进程**的 id，同一进程内重复执行会复用同一个名字（那是安全的，
  因为同一进程不会并行跑两次自己）；不同进程必然不同 —— 正好是需要区分的粒度。

  ## 附带：临时文件应当清理干净

  `try/finally` 保证**即使 scp 抛错也删掉归档** —— 否则失败一次就在仓库根
  留一个 8MB 的文件，而下一次 `git status` 会看到它。
#>
$archive = Join-Path $repoRoot "_deploy.$PID.tar.gz"
try {
  & tar -czf $archive @excludes -C $repoRoot . 2>&1 | Out-Null
  $sizeKb = [math]::Round((Get-Item $archive).Length / 1KB, 1)
  Write-Host "    $sizeKb KB"

  Write-Host "==> 传输到 ${Server}:/tmp/aq.tar.gz" -ForegroundColor Cyan
  <#
    ⚠️ **scp 的失败原因必须打出来** —— 原来这行是 `2>&1 | Out-Null`，
    于是 `throw "scp 失败"` 只说"失败了"，不说为什么。
    实测代价：我把"文件不存在"误判成"网络抖动"，白重试了好几轮。
  #>
  $scpOut = & scp -o BatchMode=yes $archive "${Server}:/tmp/aq.tar.gz" 2>&1
  if ($LASTEXITCODE -ne 0) {
    $scpOut | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    throw "scp 失败（退出码 $LASTEXITCODE）—— 上面的输出是 scp 自己说的原因"
  }
} finally {
  if (Test-Path $archive) { Remove-Item $archive -Force }
}

$remote = @"
set -e

export PATH=/usr/local/node22/bin:`$PATH
cd $RemoteDir

# 解压前先看一眼 .env 是否还在，避免把它弄丢
HAD_ENV=`$( [ -f .env ] && echo yes || echo no )

# 前端产物目录先删干净再解包。
#
# ``vite build`` 给每个 chunk 起带内容哈希的名字，所以每次构建的文件名都不同。
# 而 ``tar -x`` 只覆盖、不删除 —— 结果是**每次部署都在服务器上留下一批陈旧 chunk**：
# 实测一次累积到 69 个文件，而本地构建只有 35 个。它们不会被 index.html 引用，
# 但会一直占着磁盘，也让"服务器上到底是哪一版"变得难以判断。
#
# ``dist`` 完全由构建产出，删掉再解包是安全的；源码与 data 都不在这个目录里。
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

# ---------------------------------------------------------------------------
# magpie 网关 key 副本（团队模式的模型出口 + 联网搜索都要它）
# ---------------------------------------------------------------------------
# ## 为什么需要（实测踩到）
#
# ``caller-keys.json`` 权限同样是 ``-rw-------``（属主 UID 65532，容器内用户），
# 服务以 ``autoquant`` 身份跑，**读不到**它。
#
# 后果非常具体（实测日志）：
#
#     [error] AI 团队模式未启用：找不到 magpie 网关配置
#
# 也就是说：**AI 团队模式静默退回了单模型**，而界面上还写着"AI 团队"。
# 与 ``plugin-providers.json`` 是同一类问题 —— 上一轮我只修了那个档案文件、
# **漏了这个 key 文件**，于是同一个坑换个文件又踩一次。
#
# 团队模式的模型出口与联网搜索**都依赖这个 key**，所以它是硬依赖。
#
# ⚠️ 复制失败**不阻断部署**，但会在 ``MAGPIE_GATEWAY_KEY`` 缺席时
# 让团队模式明确报告"未启用"（而不是静默降级）。
MAGPIE_KEY_SRC=/var/lib/docker/volumes/magpie-config/_data/magpie/caller-keys.json
MAGPIE_KEY_DST=$RemoteDir/data/magpie-caller-keys.json
if [ -r "`$MAGPIE_KEY_SRC" ]; then
  mkdir -p $RemoteDir/data
  cp "`$MAGPIE_KEY_SRC" "`$MAGPIE_KEY_DST" 2>/dev/null && chown autoquant:autoquant "`$MAGPIE_KEY_DST" 2>/dev/null || true
  chmod 600 "`$MAGPIE_KEY_DST" 2>/dev/null || true
  echo "  magpie 网关 key 已同步"
else
  echo "  ⚠️  读不到 magpie 网关 key（`$MAGPIE_KEY_SRC）—— 团队模式将不可用"
fi

# ---------------------------------------------------------------------------
# magpie 模型档案副本（供"自动发现"读免费/付费标注）
# ---------------------------------------------------------------------------
# ## 为什么要复制一份，而不是直接读原文件
#
# magpie 的 ``plugin-providers.json`` 权限是 ``-rw-------``（属主 UID 65532，
# 那是容器内的用户）。服务以 ``autoquant`` 身份运行，**读不到它**（实测确认）。
#
# 而这份文件是"哪些模型免费不限量、哪些要消耗积分"的**唯一来源** ——
# ``/v1/models`` 只给 context/reasoning，**没有 ``free`` 也没有 ``cost``**（实测）。
#
# 拿不到它的后果很具体：自动发现会把所有模型标成"未知免费状态"，
# 于是"体力活优先用免费模型"的策略**静默失效**（实测日志：
# 「模型目录已刷新：共 105 个（免费 0 个）」—— 而实际有 14+ 个免费模型）。
#
# ## 为什么用复制而不是改权限
#
# 改 magpie 的文件权限会影响容器内的 magpie 自身，且 magpie 每次写配置都可能重置它。
# **复制一份只读副本**对 magpie 零影响，且部署脚本每次都刷新它。
#
# ⚠️ 复制失败**不阻断部署** —— 那只是让免费标注退化（``free: 'unknown'``），
# 团队模式仍能用静态档案跑，只是少了"优先用免费模型"这一层优化。
MAGPIE_SRC=/var/lib/docker/volumes/magpie-config/_data/magpie/plugin-providers.json
MAGPIE_DST=$RemoteDir/data/magpie-plugin-providers.json
if [ -r "`$MAGPIE_SRC" ]; then
  mkdir -p $RemoteDir/data
  cp "`$MAGPIE_SRC" "`$MAGPIE_DST" 2>/dev/null && chown autoquant:autoquant "`$MAGPIE_DST" 2>/dev/null || true
  chmod 640 "`$MAGPIE_DST" 2>/dev/null || true
  echo "  magpie 模型档案已同步：`$(wc -c < "`$MAGPIE_DST" 2>/dev/null || echo 0) 字节"
else
  echo "  ⚠️  读不到 magpie 档案（`$MAGPIE_SRC）—— 免费/付费标注将退化为"未知""
fi
"@

$remote += @"

# ---------------------------------------------------------------------------
# 远端只做"装依赖"，**不再构建前端**
# ---------------------------------------------------------------------------
# 前端产物（packages/web/dist）在本地构建、随包一起传过来。原因见文件顶部：
# 目标机常常是 2 GB 且无 swap 的小机器，``vite build`` 会把它打死。
#
# 依赖仍然要在服务器上装 —— node_modules 不适合跨平台传输。
# 用 --omit=dev：服务器通过 tsx 直接跑 TypeScript，不需要 typescript / @types 这些。
#
# 只在 package-lock 变了的时候装。没有这一步时，项目一新增依赖服务器就缺包，
# 而报错来自 vite（``Rollup failed to resolve import "@radix-ui/react-collapsible"``），
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
    # ⚠️ **不能用 ``npm ci … 2>&1 | tail -2`` 放在 if 里（2026-10-11 审查发现）。**
    #
    # 管道的退出码是 ``tail`` 的 0，于是**安装失败也走 then 分支**、把 lock hash 写进 stamp，
    # 下次部署直接"依赖未变化，跳过安装" —— 服务带着缺包重启，而本地照常打印「完成」。
    #
    # 修法是**先落到文件、再看退出码**，而不是给整个脚本加 ``set -o pipefail``：
    # 后者会改变脚本里**所有**管道的语义（实测直接把部署打断：``tail: option used in
    # invalid context -- 2``，而本地不检查 ssh 退出码、照样打印「完成」）。
    # **只改有问题的那一行，别动全局语义。**
    if sudo -u autoquant env PATH=/usr/local/node22/bin:`$PATH HOME=/tmp/aqhome npm ci --omit=dev --no-audit --no-fund > /tmp/aq-npm.log 2>&1; then
        tail -n 2 /tmp/aq-npm.log
        echo "`$LOCK_HASH" > `$STAMP_FILE
        chown autoquant:autoquant `$STAMP_FILE 2>/dev/null || true
    else
        echo "    ✗ 依赖安装失败 —— 服务会起不来。npm 输出："
        tail -n 20 /tmp/aq-npm.log
        # **必须让部署失败**，不能带着缺包重启：写 stamp 的下一次会跳过安装。
        exit 1
    fi
else
    echo "==> 依赖未变化，跳过安装"
fi
"@

$remote += @"

echo "==> 重启服务"
# ── 日志落盘（drop-in）──────────────────────────────────────────────────────
#
# ⚠️ **这一条是 2026-09-22 加的，而它修的是一个让我误判了两次的问题。**
#
# 在那之前服务没配 ``StandardOutput``，于是输出全交给 journald —— 而 journald
# 有容量与限流（本机 journal 已占 964M 并在滚动丢旧记录）。排查时我 grep 的
# ``data/server.log`` 其实是某次手工 tee 留下的**残留文件**，最后一行停在
# 1.5 天前 —— 于是「某机制 0 次」这种判断**全是假信号**。
#
# 用 **drop-in** 而不是改主单元文件：不猜原文件是谁写的，升级也不丢。
#
# 幂等：内容一样就不重写（避免每次部署都 daemon-reload）。
LOGUNIT=/etc/systemd/system/autoquant.service.d/logging.conf
if ! grep -q "append:/opt/autoquant/data/server.log" "`$LOGUNIT" 2>/dev/null; then
    mkdir -p /etc/systemd/system/autoquant.service.d
    cat > "`$LOGUNIT" <<'LOGCONF'
[Service]
# 日志追加到固定文件，而不是交给 journald —— 见 deploy.ps1 里的说明。
StandardOutput=append:/opt/autoquant/data/server.log
StandardError=append:/opt/autoquant/data/server.log
LOGCONF
    systemctl daemon-reload
    echo "    已配置日志落盘（drop-in）"
fi

#
# ⚠️ **给"跑完在途那一轮"留够时间**（用户要求的"两全其美"）。
#
# ## 问题
#
# 用户的原话：
#
# > 「你改代码的时候（提交更新部署代码到服务器后，服务器会重启对吧，
# >  这时候运行中的机器人会被停止-启动……**这个你得自己看着修**……
# >  应该是**两全其美**」
#
# 实测证据（生产日志）：
#
# ````
#   01:08:33  停止时上一轮决策未在时限内结束，可能留下未挂保护单的仓位
#   01:08:41  机器人已启动（实盘）      ← 部署在 01:08 打断了一轮决策
# ````
#
# 一轮跑到"入场已成交、保护单还没挂"时被掐掉 → 循环也停了 →
# **没有任何人会去补那张保护单**，直到下次启动对账。中间就是**裸奔窗口**。
#
# ## 修法（两侧都要改，缺一不可）
#
# | 侧 | 改动 |
# |---|---|
# | 应用 | ``stop(persist=false)`` **不掐断**在途轮次，最多等 ``SHUTDOWN_DRAIN_TIMEOUT_MS``（3 分钟）|
# | systemd | ``TimeoutStopSec`` 从默认 **90 秒** 提到 **210 秒** |
#
# ⚠️ **只改应用是没用的**：systemd 在 90 秒就 SIGKILL，
# 那 3 分钟的等待**永远等不到**（实测 ``TimeoutStopUSec=1min 30s``）。
#
# 210 秒 = 应用的 3 分钟 + 30 秒余量（留给进程收尾）。
#
# 为什么可以这么长：部署时**没人在等**（不像操作员点停止）。
# 而"操作员点停止"那条路径仍然是 60 秒 + 立刻掐断 —— 快的那条没变。
TIMEOUTUNIT=/etc/systemd/system/autoquant.service.d/timeout.conf
if ! grep -q "TimeoutStopSec=210" "`$TIMEOUTUNIT" 2>/dev/null; then
    mkdir -p /etc/systemd/system/autoquant.service.d
    cat > "`$TIMEOUTUNIT" <<'TIMECONF'
[Service]
# 见 deploy.ps1 的说明：让部署重启时"跑完在途那一轮"，
# 避免掐断在"入场已成交、保护单未挂"的窗口里（裸奔仓位）。
# 应用侧上限是 3 分钟，这里给 210 秒（3 分钟 + 30 秒收尾余量）。
TimeoutStopSec=210
TIMECONF
    systemctl daemon-reload
    echo "    已配置停机超时 210 秒（drop-in）"
fi

#
# ⚠️ **强制 Node 用 IPv4 —— 这台服务器的 IPv6 没有路由。**
#
# 2026-10-07 实测事故：机器人连续多轮 ``Cannot reach opencode: fetch failed``，
# 而同一台机器上 ``curl https://opencode.ai/...`` 一直是 200。
#
# 根因：``opencode.ai`` 的 DNS **同时**返回 A（172.65.90.20）与 AAAA
# （2606:4700:78::…），而这台机器 ``curl -6`` 是 **ENETUNREACH**（IPv6 不通）。
# ``curl`` 有 Happy Eyeballs 会自动回退 IPv4，**Node 的 fetch 不会可靠回退** ——
# 于是它优先试 IPv6、失败就报 ``fetch failed``，表现为**间歇性**失败
# （IPv6 路由时通时断），并且"测着正常、跑着不正常"。
#
# 用 **drop-in** 固化这一条：主单元文件不该被部署脚本覆盖，而重装/重建
# 服务器时这条配置必须跟着回来 —— 之前它只存在于手改的 systemd 里，
# 离开这台机器就丢了（我第一版还把它写成了
# ``Environment=NODE_OPTIONS=NODE_OPTIONS=...``，值多了一层前缀 → 选项被忽略、
# 事故照旧。**所以这里连值一起断言。**）
#
# 幂等：内容一致就不重写。
NETUNIT=/etc/systemd/system/autoquant.service.d/network.conf
if ! grep -q 'dns-result-order=ipv4first' "`$NETUNIT" 2>/dev/null; then
    mkdir -p /etc/systemd/system/autoquant.service.d
    cat > "`$NETUNIT" <<'NETCONF'
[Service]
# IPv6 在这台机器上不可达（ENETUNREACH），而 DNS 同时给 A/AAAA。
# Node 不做 Happy Eyeballs 回退，所以必须显式优先 IPv4。
Environment="NODE_OPTIONS=--dns-result-order=ipv4first"
NETCONF
    systemctl daemon-reload
    echo "    已配置 IPv4 优先（drop-in）"
fi

# 值写错了等于没写 —— 启动后核对**进程实际拿到的**环境变量。
if [ -f "`$NETUNIT" ]; then
    MAINPID=`$(systemctl show autoquant -p MainPID --value)
    ACTUAL=`$(tr '\0' '\n' < /proc/`$MAINPID/environ 2>/dev/null | grep '^NODE_OPTIONS=' || true)
    if [ "`$ACTUAL" != "NODE_OPTIONS=--dns-result-order=ipv4first" ]; then
        echo "    ⚠️ NODE_OPTIONS 实际值不对：'`$ACTUAL'（期望 NODE_OPTIONS=--dns-result-order=ipv4first）"
    fi
fi

systemctl restart autoquant
sleep 15
echo -n "    服务状态: "; systemctl is-active autoquant
echo -n "    日志文件: "; ls -la /opt/autoquant/data/server.log 2>/dev/null | awk '{print `$5" 字节  最后写入 "`$6" "`$7" "`$8}'

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

#
# ══════════════════════════════════════════════════════════════════════════════
#  ⚠️⚠️ **必须检查远端退出码**（2026-10-15 实测抓到的真事故）
# ══════════════════════════════════════════════════════════════════════════════
#
# ## 事故：一连几次"部署成功"，而服务【一次都没重启】
#
# 实测症状：
# ```
#   deploy.ps1 打印「==> 完成」，build-info.json 也已经是新的 commitShort
#   而 systemctl 的 ExecMainStartTimestamp 停在【两小时前】
#   ⇒ 代码文件更新了，但进程还在跑旧代码
# ```
# 手工回放定位到远端脚本在**重启之前**就失败了（那次的报错是
# `tail: option used in invalid context -- 2`）。而本脚本**从不看 ssh 的退出码**，
# 于是：失败 → 照样打印「完成」→ 我以为部署成功。
#
# ## 为什么"回读 build-info.json"没兜住它
#
# 那个校验问的是「线上代码是哪一版」，而本次事故的失败点在**重启之前** ——
# `build-info.json` 那时**已经写好了**。所以：
# ```
#   版本号正确 ✅  服务在跑旧代码 ❌   ← 两个信号都"正常"，而系统是坏的
# ```
#
# ## ⚠️ 这条纪律本文件早就写过，只是没落在代码上
#
# 上面 :327 的注释原文：
# > 「……实测直接把部署打断：`tail: option used in invalid context -- 2`，
# >  **而本地不检查 ssh 退出码、照样打印「完成」**。」
#
# 也就是说：**当时只修了那一行管道，没有修"不看退出码"这个根因** ——
# 于是同一个事故换了个失败点又发生一次。这次把它落在代码上。
#
# ## 失败的判据取"非零即失败"
#
# 远端脚本在每一处致命错误上都 `exit 1`（见它的 `npm ci` 分支），
# 所以非零就是失败。**不使用 `$ErrorActionPreference` 去捕获**：ssh 的非零退出
# 在 PowerShell 里不是异常，只会写进 `$LASTEXITCODE`。
#
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "==> ✗ 部署失败（远端退出码 $LASTEXITCODE）" -ForegroundColor Red
    Write-Host "    上面最后几行是远端的报错。**服务很可能没有重启，仍在跑旧代码**：" -ForegroundColor Yellow
    Write-Host "      ssh tx 'systemctl show autoquant -p ExecMainStartTimestamp'" -ForegroundColor Yellow
    Write-Host "    修掉远端那一步再重跑；不要只看 build-info.json —— 它在重启【之前】就写好了。" -ForegroundColor Yellow
    exit $LASTEXITCODE
}

Write-Host "==> 完成" -ForegroundColor Green
