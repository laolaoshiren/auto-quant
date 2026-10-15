/**
 * **净盈亏的算式只能有一份**（2026-10-15，一次真实的"复制算式"事故）
 *
 * ## 事故：我写一次性脚本时手抄了错误的公式
 *
 * 校正历史账本时，我在 `scripts/oneoff/fix-ledger-reconciled-reversed.ts` 里写：
 * ```ts
 *   const newNet = newGross - row.fee - row.funding_fee;   // ❌ 资金费符号错
 * ```
 * 而平台的不变量是（`income.ts` 的 `netPnlOf`）：
 * ```ts
 *   net = gross − fee + fundingFee
 *                          ↑ 【加】—— 交易所口径里资金费支出为负
 * ```
 *
 * ## 后果（实测）
 * ```
 *   5 行不再自洽：net ≠ pnl − fee + funding
 *   每行差值 = 2 × funding_fee（铁证：-0.000354 → 差 -0.000708）
 *   合计差 -0.003075
 * ```
 * 而**那个正确的算式就摆在同一个仓库里** —— 我却自己拼了一遍。
 *
 * ## 为什么这条测试值得存在
 *
 * `netPnlOf` 的注释里已经写明：
 * > 修之前，同一个算式在仓库里有**五处**副本（`repositories.ts` 两处、
 * > `autoTrader.ts` 三处），于是同一个符号错误也复制了五份。
 * > §5.4 说"金额相关的算术只在一个地方算" —— 这就是那条规则的用处。
 *
 * 而**我刚刚又造了第六份副本，并且抄错了**。
 *
 * ## 判据
 *
 * 扫 `packages/<包>/src` 与 `scripts/` 下的 `.ts`，找「自己拼净盈亏」的地方：
 * ```
 *   同一行里既有 `- ...fee` 又有 `- ...funding`  ⇒ 命中
 * ```
 * 正确写法是调 `netPnlOf(...)`。
 * ⚠️ `netPnlOf` 自己的函数体是**唯一允许**出现 `- input.fee + input.fundingFee` 的地方
 *（它是"加"不是"减"，所以不会命中）。
 *
 * ## ⚠️ 文件遍历用**按标记定位**，不靠猜相对层数
 *
 * 这是 `configWiringGuard.test.ts` 记过的坑：猜层数会**静默扫到 0 个文件**，
 * 于是守卫报告"没问题" —— 那比没有守卫更糟。所以：
 * ```
 *   ① 从本文件向上找含 server/shared/web 的 packages 根；找不到就抛错
 *   ② 扫到的文件数必须 > 0（否则判据失效，必须报错而不是通过）
 * ```
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/** 从本文件向上找 `packages/` 根（按标记，不猜层数）。 */
function findRepoRoot(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      existsSync(join(dir, 'packages', 'server', 'src')) &&
      existsSync(join(dir, 'packages', 'shared', 'src')) &&
      existsSync(join(dir, 'scripts'))
    ) {
      return dir;
    }
    dir = join(dir, '..');
  }
  throw new Error(`找不到仓库根（从 ${fileURLToPath(new URL('.', import.meta.url))} 向上找了 8 层）`);
}

const ROOT = findRepoRoot();

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (entry.endsWith('.ts')) {
      out.push(full);
      continue;
    }
    /*
     * ⚠️ 只有目录才继续往下 —— 用 `statSync` 判断。
     * 我第一版用 `readdirSync(full).length >= 0` 当判据，那是错的：
     * `.ts` 文件也会被它当成目录试一次（虽然抛错被吞掉），
     * 而更糟的是**逻辑绕**，读代码的人要花时间才明白它在干什么。
     */
    try {
      if (statSync(full).isDirectory()) walk(full, out);
    } catch {
      /* 不是目录、或读不到 —— 跳过 */
    }
  }
  return out;
}

/** 收集要扫的文件。 */
function sourceFiles(): string[] {
  const out: string[] = [];
  walk(join(ROOT, 'packages', 'server', 'src'), out);
  walk(join(ROOT, 'packages', 'shared', 'src'), out);
  walk(join(ROOT, 'scripts'), out);
  return out;
}

test('★★★ 净盈亏的算式不能有第二份副本（我抄错过一次）', () => {
  const files = sourceFiles();
  /*
   * ⚠️ 扫到 0 个文件时必须报错 —— 否则守卫会"在没扫到东西的情况下说没问题"。
   */
  assert.ok(files.length > 20, `★ 只扫到 ${files.length} 个 .ts 文件 —— 判据失效了（路径找错了）`);

  const offenders: string[] = [];
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    /* 去掉注释与字符串（注释里的示例不该被当成代码）。 */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/`[^`]*`/g, '``')
      .replace(/'[^'\n]*'/g, "''")
      .replace(/"[^"\n]*"/g, '""');
    for (const [i, line] of code.split('\n').entries()) {
      /*
       * 命中形状：同一行里 `- xxxfee` 与 `- xxxfunding` 都在。
       * 正确写法（`+ fundingFee`）不会命中。
       */
      if (/-\s*[\w.]*fee\b/.test(line) && /-\s*[\w.]*funding/i.test(line)) {
        offenders.push(`${file.replace(ROOT, '')}:${i + 1}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些地方自己拼了"毛 − 费 − 资金费"—— 正确的算式是 `netPnlOf()`\n' +
      '   （资金费在交易所口径里【支出为负】，所以是【加】）。\n' +
      '   2026-10-15 我为这个错误付过代价：5 行账本不再自洽，合计差 -0.003075。\n' +
      offenders.map((o) => `   ${o}`).join('\n'),
  );
});

test('★★★ `netPnlOf` 必须仍然只有一份实现', () => {
  /*
   * ⚠️ **必须排除测试文件自身** —— 我第一版没有排除，于是它匹配到了
   * 本文件里的正则字面量 `/export function netPnlOf\b/`，
   * 报"实际 2 处：income.ts、netPnlSingleSource.test.ts"。
   *
   * 这是"判据把自己算进去"的典型 —— 与"手写清单会漂移"是同一类错误：
   * **判据的输入里混进了判据自己**。
   */
  const self = fileURLToPath(import.meta.url);
  const files = sourceFiles().filter((f) => f !== self);
  const defs: string[] = [];
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    /* 去掉注释与字符串，避免"文档里提到它"被算成"定义"。 */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/`[^`]*`/g, '``')
      .replace(/'[^'\n]*'/g, "''")
      .replace(/"[^"\n]*"/g, '""');
    if (/export function netPnlOf\b/.test(code)) defs.push(file.replace(ROOT, ''));
  }
  assert.equal(defs.length, 1, `★ netPnlOf 应当只有一处定义，实际 ${defs.length} 处：${defs.join('、')}`);
});

test('★★ `netPnlOf` 的算式必须是"减费、加资金费"', () => {
  /*
   * 钉住那个符号 —— 它是这次事故的核心。
   * 判据：函数体里出现 `- input.fee` 与 `+ input.fundingFee`。
   */
  const src = readFileSync(join(ROOT, 'packages', 'server', 'src', 'binance', 'income.ts'), 'utf8');
  const at = src.indexOf('export function netPnlOf');
  assert.ok(at > 0, '★ 找不到 netPnlOf');
  const body = src.slice(at, at + 700);
  assert.ok(/- input\.fee/.test(body), '★ 必须【减】手续费（支出为正）');
  assert.ok(/\+ input\.fundingFee/.test(body), '★ 必须【加】资金费（交易所口径支出为负）');
});
