/**
 * **界面上的字符串字面量里不允许出现 markdown 强调符 `**`**（2026-10-17 · 台账 UI-08）。
 *
 * ## 这条守卫接的是什么
 *
 * JSX 不解析 markdown，`AppearancePage.tsx` 的注释里早就记过这件事：
 *
 * > 「这里不能用 Markdown 的 `**粗体**`。星号会**原样画在屏幕上**（第一版就是
 * >  这样，截图里一眼看见两处 `**不刷新页面**`）」。
 *
 * 但那条纪律只写在注释里，于是同一个形态在别处长回来了：审计报告用
 * `document.body.innerText` 扫真实页面时抓到 **28 处** `title` 属性里带着
 * `**只是这个机器人自己的账**` 这类原文 —— 鼠标一停就露给用户看。
 *
 * ## 为什么扫**字符串字面量**而不是"整页 HTML"
 *
 * 三条理由：
 * 1. 注释里到处都是 `**`（本仓库的注释风格就是 markdown），扫全文会被噪音淹掉；
 * 2. 渲染层的 `plainText()` 是**第二道**防线（它剥的是**数据**里的 `**`，
 *    比如模型产出、服务端理由），而这里守的是**我们自己写死的文案**；
 * 3. 字符串字面量是"我们写的话"的**边界**：它出现在屏幕上时不会经过任何解析器。
 *
 * ## ⚠️ 边界（诚实说明）
 *
 * · 它**不能**检查**数据**里的 `**`（那是 `plainText()` 的职责，见
 *   `plainText.test.ts` 与 `TeamDecisionRow` 的 `MemberLine`）；
 * · 它不看 `.test.ts`（测试里的 `**` 是给失败信息加粗用的，不进界面）；
 * · JSX 裸文本节点（`<span>**x**</span>`）**不**在覆盖范围内 —— 那种写法在
 *   本仓库不存在（文案统一走字符串），将来的形态由 review 兜。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/** `packages/web/src`。 */
const WEB_SRC = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (['node_modules', 'dist', '.git'].includes(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * 把注释换成等长空白 —— **不删**：偏移量必须保持不变，
 * 否则下面按位置取回原文时会错位（这正是"掩码"而不是"删除"的理由）。
 */
function maskComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    const three = text.slice(i, i + 3);
    if (three === '{/*') {
      const end = text.indexOf('*/}', i);
      const stop = end === -1 ? text.length : end + 3;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', i);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (two === '//') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** 单/双/模板字符串字面量。刻意不处理跨行字符串之外的花样（会漏，不会误报）。 */
const LITERAL = /'([^'\\\n]|\\.)*'|"([^"\\\n]|\\.)*"|`([^`\\]|\\.)*`/g;

/** 找出这份源码里"字符串字面量含 `**`"的行号（1 起）。 */
function offendersOf(source: string): number[] {
  const masked = maskComments(source);
  /* 每行起始偏移（二分查找行号，避免在 matchAll 里重复扫描）。 */
  const starts = [0];
  for (let i = 0; i < masked.length; i += 1) if (masked[i] === '\n') starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    let ans = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! <= offset) {
        ans = mid + 1;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };

  const lines: number[] = [];
  for (const m of masked.matchAll(LITERAL)) {
    if (!m[0].includes('**')) continue;
    const n = lineOf(m.index ?? 0);
    if (!lines.includes(n)) lines.push(n);
  }
  return lines;
}

test('★★★ 界面源码的字符串字面量里不得出现 markdown 强调符 `**`', () => {
  const files = walk(WEB_SRC);
  assert.ok(files.length >= 50, `★ 只扫到 ${files.length} 个文件 —— 扫描可能失效了`);

  let literals = 0;
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const m of maskComments(source).matchAll(LITERAL)) {
      literals += 1;
      void m;
    }
    const single = file.slice(WEB_SRC.length).replace(/\\/g, '/');
    for (const line of offendersOf(source)) offenders.push(`${single}:${line}`);
  }

  /* 前置断言：扫到的字面量太少说明扫描本身坏了，而不是"没有违规"。 */
  assert.ok(literals >= 2000, `★ 只扫到 ${literals} 个字符串字面量 —— 扫描可能失效了`);

  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些字符串字面量里带着 `**` —— JSX 不解析 markdown，用户看到的是星号本身：\n' +
      offenders.map((o) => `      · ${o}`).join('\n') +
      '\n    ✅ 修法：把强调符号去掉（要加粗就用 <strong>，或者像 `AppearancePage` 那样换措辞）。\n' +
      '    ⚠️ **不要**改成渲染 markdown：那会引入一个"可信文本渲染成 HTML"的注入面。',
  );
});

test('★★ 判据必须真的报得出来，而且不误伤注释 —— 用人造源码校准', () => {
  /* ① 字符串字面量里的 `**` 必须被报出来（否则上面那条在空转）。 */
  assert.deepEqual(
    offendersOf("const t = '这个**岗位**还没有实现';"),
    [1],
    '★ 字符串里的 `**` 必须报（这是判据本体）',
  );

  /* ② 模板字面量、`title` 属性同样在覆盖范围内。 */
  assert.deepEqual(offendersOf('const t = `**没有决策**`;'), [1], '★ 模板字面量也要报');
  assert.deepEqual(offendersOf('<span title="**只是这个机器人自己的账**" />'), [1], '★ title 也要报');

  /* ③ 注释里的 `**` **不能**被误报 —— 本仓库的注释风格就是 markdown。 */
  assert.deepEqual(offendersOf('/** 这里写着 **粗体** 但它是注释 */'), [], '★ 块注释不能误报');
  assert.deepEqual(offendersOf('// 这行注释里有 **强调**'), [], '★ 行注释不能误报');
  assert.deepEqual(offendersOf('{/* JSX 注释里的 **强调** */}'), [], '★ JSX 注释不能误报');

  /* ④ 代码里的幂运算（`2 ** n`）不是字符串，不能误报。 */
  assert.deepEqual(offendersOf('const delay = 800 * 2 ** Math.min(n, 5);'), [], '★ 幂运算不能误报');

  /* ⑤ 行号要准（失败信息里给的就是它）。 */
  const multi = ["const a = 'ok';", "const b = '**坏**';"].join('\n');
  assert.deepEqual(offendersOf(multi), [2], '★ 行号必须对得上');
});
