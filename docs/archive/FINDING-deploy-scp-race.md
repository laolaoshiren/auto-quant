# "scp 抖动"的真因：并发部署竞争同一个归档文件（2026-10-15）

> 我在多轮里把 `deploy.ps1` 的 scp 失败归因为"网络抖动"并重试。
> **那是错的。** 真因是部署脚本用固定文件名打包，两次并行必然撞车。

---

## 1. 症状

```
==> 传输到 <server>:/tmp/aq.tar.gz
Exception: scripts/deploy.ps1:198
   198 |  if ($LASTEXITCODE -ne 0) { throw "scp 失败" }
       |                             ~~~~~~~~~~~~~~
       | scp 失败
```

**而同一时刻 `ssh <server> 'echo ok'` 正常返回** —— 于是看起来像"网络抖了一下"。
重试有时成功、有时失败，更强化了那个错误判断。

---

## 2. 真因

`deploy.ps1` 原来的打包段：

```powershell
$archive = Join-Path $repoRoot '_deploy.tar.gz'   # ← 固定文件名
if (Test-Path $archive) { Remove-Item $archive -Force }
& tar -czf $archive @excludes -C $repoRoot . 2>&1 | Out-Null
…
& scp -o BatchMode=yes $archive "${Server}:/tmp/aq.tar.gz" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "scp 失败" }
Remove-Item $archive -Force                        # ← 跑完就删
```

`deploy.ps1` 一次要跑几分钟。**两次并行**时：

```
A: tar  → _deploy.tar.gz 就位
B: tar  → 覆盖同一个文件（或先删掉）
A: scp  → 成功
A: Remove-Item → 文件没了
B: scp  → scp: stat local "_deploy.tar.gz": No such file or directory   ❌
```

### 决定性证据

直接手工跑那个 scp，**错误信息立刻现形**：

```
$ scp -o BatchMode=yes "_deploy.tar.gz" "<server>:/tmp/aq-test.tar.gz"
C:\WINDOWS\System32\OpenSSH\scp.exe: stat local "_deploy.tar.gz": No such file or directory
退出码 255
```

⇒ **"本地文件不存在"，不是网络问题。**

而我之所以一直没看到这句话，是因为脚本里写的是：

```powershell
& scp … 2>&1 | Out-Null      # ← 把 scp 自己说的原因吞掉了
if ($LASTEXITCODE -ne 0) { throw "scp 失败" }   # ← 只说"失败了"
```

**一个把失败原因吞掉的错误信息，比没有信息更糟** ——
它让我把一个确定性的文件竞争误判成随机网络故障，并因此重试了多轮。

### 为什么会有两次并行

我自己造成的：连续重试部署时，前一次还在跑（几分钟），我就启动了下一次。
另有一次是「后台任务 + 前台重试」同时跑。

---

## 3. 修法（三处）

```powershell
# ① 归档名含 PID —— 不同进程必然不同
$archive = Join-Path $repoRoot "_deploy.$PID.tar.gz"
try {
  …tar…
  # ② scp 的失败输出必须打出来
  $scpOut = & scp -o BatchMode=yes $archive "${Server}:/tmp/aq.tar.gz" 2>&1
  if ($LASTEXITCODE -ne 0) {
    $scpOut | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    throw "scp 失败（退出码 $LASTEXITCODE）—— 上面的输出是 scp 自己说的原因"
  }
} finally {
  # ③ 失败也删掉，不在仓库根留 8MB
  if (Test-Path $archive) { Remove-Item $archive -Force }
}
```

### 为什么用 PID 而不是时间戳

`$PID` 是**本进程**的 id：同一进程内重复执行复用同一个名字（安全 ——
同一进程不会并行跑两次自己），不同进程必然不同 —— 正好是需要区分的粒度。

---

## 4. 验证

```
修复前：连续 4 次部署全部 scp 失败（有并发任务在跑）
修复后（停掉并发 + 新脚本）：单次部署 退出码 0 · 线上版本 == 本地 HEAD ✅
仓库根残留归档：无 ✅
```

---

## 5. 教训（可复用的两条）

```
① 一个"随机失败"如果**重试能成功**，先怀疑【竞争】，而不是【网络】。
   竞争的特征是：失败与成功交替、与时间无关、与负载相关。

② **不要把子进程的 stderr 丢掉再报一个笼统的错。**
   这里 `2>&1 | Out-Null` + `throw "scp 失败"` 的组合，
   把一个"文件不存在"变成了一句无法诊断的"失败了"。
   与仓库那条既有纪律同源：**一个说错话的错误信息比没有信息更糟。**
```
