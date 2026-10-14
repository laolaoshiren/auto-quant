/**
 * **`deploy.ps1` 的 here-string 里不能有裸反引号**（2026-10-15 实测事故）
 *
 * ## 事故：一连几次"部署成功"，而服务【一次都没重启】
 *
 * 症状：
 * ```
 *   deploy.ps1 打印「==> 完成」，build-info.json 也已经是新的 commitShort
 *   而 systemctl 的 ExecMainStartTimestamp 停在【两小时前】
 *   ⇒ 代码文件更新了，但进程还在跑旧代码
 * ```
 *
 * 根因在 `deploy.ps1` 的**注释**里（源码 L320）：
 * ```
 *   # ⚠️ **不能用 `npm ci … 2>&1 | tail -2` 放在 if 里**
 * ```
 * 它在 PowerShell 双引号 here-string 里被转义：
 * ```
 *   `n → 换行      （`npm  → 换行 + "pm"）
 *   `t → 制表符    （`tail → TAB + "ail"）
 * ```
 * 于是发到服务器的文本变成：
 * ```
 *   L115:     # ⚠️ **不能用
 *   L116: pm ci … 2>&1 | tail -2 放在 if 里**     ← 【不是注释，被 bash 当命令执行】
 * ```
 * 那行漏出来的文本让 `tail` 收到畸形参数 →
 * `tail: option used in invalid context -- 2` → `exit 1` → 而它在**重启服务之前**
 * → **服务从未重启，而本地照样打印「完成」**。
 *
 * ## 为什么"回读 build-info.json"没兜住
 *
 * 那个校验问的是「线上代码是哪一版」，而失败点在**重启之前** ——
 * `build-info.json` 那时**已经写好了**。于是：
 * ```
 *   版本号正确 ✅   服务在跑旧代码 ❌   ← 两个信号都"正常"，而系统是坏的
 * ```
 *
 * ## 判据
 *
 * 在 `$remote = @"…"@` 与每个 `$remote += @"…"@` 的**内部**：
 * ```
 *   · 整行注释里的反引号必须是【两个】（`` → 输出一个字面量反引号）
 *   · 反引号 + `$`（真正的 PowerShell 变量转义）不在此列
 * ```
 *
 * ⚠️ 为什么用"两个反引号"而不是"去掉反引号"：注释的可读性一字不改 ——
 * 服务器收到的仍是 `` `npm ci `` 这样一个反引号。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SRC = readFileSync(new URL('../../../../scripts/deploy.ps1', import.meta.url), 'utf8');
const LINES = SRC.split('\n');

/**
 * 取出所有 here-string 区间 `[起, 止)`（`@"` 那一行到 `"@` 那一行之间，不含两端）。
 */
function hereStringRanges(): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let start = -1;
  for (let i = 0; i < LINES.length; i += 1) {
    const line = LINES[i]!;
    if (start < 0 && /^\s*\$remote\s*(\+=|=)\s*@"\s*$/.test(line)) {
      start = i + 1;
      continue;
    }
    if (start >= 0 && /^\s*"@\s*$/.test(line)) {
      ranges.push({ from: start, to: i });
      start = -1;
    }
  }
  return ranges;
}

test('★★★ here-string 里的整行注释不能有裸反引号', () => {
  const ranges = hereStringRanges();
  assert.ok(ranges.length >= 3, `★ 应当找到多个 here-string 块（实际 ${ranges.length}）`);

  const bad: string[] = [];
  for (const { from, to } of ranges) {
    for (let i = from; i < to; i += 1) {
      const line = LINES[i]!;
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('#')) continue;
      /*
       * 找出裸反引号：反引号后面不是 `$`，且【不是两个连续反引号】。
       */
      const stripped = line.replace(/\`\`|\`\$/g, '');
      if (stripped.includes('`')) {
        bad.push(`L${i + 1}: ${trimmed.slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    '★ here-string 的注释里不能有裸反引号 —— 它会被 PowerShell 转义成换行/制表符，' +
      '而漏出来的那半行会被 bash 当命令执行（实测让部署在重启前失败）：\n  ' + bad.join('\n  '),
  );
});

test('★★★ 必须检查远端 ssh 的退出码（否则失败会冒充成功）', () => {
  /*
   * ⚠️ 这是同一个事故的第二半：远端 exit 1，而脚本照样打印「完成」。
   */
  assert.match(
    SRC,
    /\$output = ssh -o BatchMode=yes \$Server \$remote 2>&1/,
    '★ 应当还能找到 ssh 调用',
  );
  const at = SRC.indexOf('$output = ssh -o BatchMode=yes $Server $remote 2>&1');
  const after = SRC.slice(at, at + 2500);
  assert.match(
    after,
    /if \(\$LASTEXITCODE -ne 0\)/,
    '★ ssh 之后必须检查 $LASTEXITCODE —— ssh 的非零退出在 PowerShell 里不是异常',
  );
  assert.match(
    after,
    /部署失败/,
    '★ 失败必须明确报出来，而不是继续打印「完成」',
  );
  assert.match(
    after,
    /它在重启【之前】就写好了/,
    '★ 要提醒"不要只看 build-info.json"—— 那正是这次事故骗过校验的方式',
  );
});

test('★★ 「==> 完成」必须排在退出码检查之后', () => {
  const sshAt = SRC.indexOf('$output = ssh -o BatchMode=yes $Server $remote 2>&1');
  const checkAt = SRC.indexOf('if ($LASTEXITCODE -ne 0)', sshAt);
  const doneAt = SRC.indexOf('Write-Host "==> 完成"', sshAt);
  assert.ok(sshAt > 0 && checkAt > sshAt && doneAt > checkAt,
    '★ 顺序必须是 ssh → 检查退出码 → 打印完成（否则又变成"无条件报成功"）');
});

test('★★ 远端脚本必须在重启服务之前 exit 1（否则失败点不可预测）', () => {
  assert.match(SRC, /exit 1/, '★ npm ci 失败分支必须 exit 1');
  const restartAt = SRC.indexOf('systemctl restart autoquant');
  const exitAt = SRC.indexOf('exit 1');
  assert.ok(restartAt > 0 && exitAt > 0 && exitAt < restartAt,
    '★ npm ci 的 exit 1 应当排在重启之前（那正是本次事故的失败点）');
});
