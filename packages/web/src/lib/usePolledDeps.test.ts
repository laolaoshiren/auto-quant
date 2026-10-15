/**
 * **`usePolled` 的 `deps` 用法必须满足 React 的依赖数组纪律**。
 *
 * ## 这条守卫接的是什么
 *
 * `usePolled`（`packages/web/src/lib/hooks.ts`）接受一个 `deps?: unknown[]`，
 * 并在自己的 `useEffect` 里**展开**它：
 *
 * ```ts
 * }, [enabled, intervalMs, nonce, ...deps]);
 * // eslint-disable-next-line react-hooks/exhaustive-deps
 * ```
 *
 * ⚠️ **展开数组进依赖列表是 React 的经典陷阱**：`useEffect` 的依赖数组
 * **长度必须恒定** —— React 按**位置**比对依赖。长度变化会让它把
 * "第 3 个依赖"和"上一次的第 3 个依赖"当成同一个东西比较，
 * 于是该重跑的没重跑、不该重跑的狂重跑。
 *
 * ⚠️ 而这里**没有运行时保护**：`deps` 是调用方传的任意数组。
 *
 * ## ⚠️ 我核实过：**当前是安全的**（所以这条守卫是"防将来"，不是"修现在"）
 *
 * 全仓 32 个 `usePolled` 调用点，我逐个查过：
 * - **每一个都是独立的 hook 实例**（不是同一个 hook 在条件分支里传不同长度的 `deps`）；
 * - **没有任何一个 `usePolled` 被条件调用**（那才是 React 真正会报错的形态）。
 *
 * ⚠️ 所以"现在没坏"是**碰巧**：它依赖"每个调用点的 `deps` 长度恒定"这条**没人检查的纪律**。
 * 而本仓库反复出现的形态正是"**两处必须一致、没人检查**"。
 *
 * ## 判据
 *
 * 对每个 `usePolled(...)` 调用点，断言它**不是条件调用** ——
 * 即它不出现在 `if` / `&&` / `? :` / 循环的**直接分支**里。
 *
 * ⚠️ 这条判据**故意只守"条件调用"**，不去数 `deps` 长度：
 * 因为长度恒定是**跨渲染**的性质，静态文本看不出来（同一行代码在不同渲染里
 * 可以传不同长度）。**能静态守的只有"调用位置是否稳定"** —— 而那也是唯一
 * 会让 React 直接报错的情形。
 *
 * ## 边界（诚实说明）
 *
 * · 它**不能**证明 `deps` 长度跨渲染恒定（见上）；
 * · 它**不检查** `deps` 的内容对不对（"这个 effect 该依赖什么"要人判）；
 * · 它只扫 `packages/web`（`usePolled` 只在那里）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/** 从本文件定位 `packages/web/src`。 */
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
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** 剥注释但保留行号。 */
function stripCommentsKeepLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') ? line : '';
    })
    .join('\n');
}

test('★★★ `usePolled` 不得被条件调用（那会让依赖数组长度在渲染间变化）', () => {
  const files = walk(WEB_SRC);
  assert.ok(files.length >= 50, `★ 只扫到 ${files.length} 个文件 —— 扫描可能失效了`);

  const offenders: string[] = [];
  let calls = 0;

  for (const file of files) {
    const rel = file.slice(WEB_SRC.length).replace(/\\/g, '/');
    const lines = stripCommentsKeepLines(readFileSync(file, 'utf8')).split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (!/\busePolled\s*[(<]/.test(line)) continue;
      calls += 1;

      /*
       * ⚠️ 看**同一行**是否已经有条件前缀（`&& usePolled(`、`? usePolled(`），
       * 以及**上一行**是否是裸的 `if (...) {` 或 `if (...) ` ——
       * 后者是"条件调用 hook"最常见的写法。
       */
      const sameLine = /(?:&&|\|\||\?)\s*$/.test(line.slice(0, line.indexOf('usePolled')));
      const prev = (lines[i - 1] ?? '').trim();
      const prevIsIf = /^if\s*\(.*\)\s*\{?$/.test(prev) || /^else\b/.test(prev);
      /* 循环里的 hook 调用同样是条件性的（迭代次数可变）。 */
      const prevIsLoop = /^(?:for|while|do)\b/.test(prev);

      if (sameLine || prevIsIf || prevIsLoop) {
        offenders.push(`${rel}:${i + 1}`);
      }
    }
  }

  /* 前置断言：必须真的找到调用（否则"零个问题"是因为没扫到东西）。 */
  assert.ok(
    calls >= 20,
    `★ 只找到 ${calls} 处 \`usePolled\` 调用 —— 扫描可能失效了（应当有 30+ 处）`,
  );

  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些 `usePolled` 是**条件调用**的：\n' +
      offenders.map((o) => `      · ${o}`).join('\n') +
      '\n    ⚠️ `usePolled` 内部把 `deps` **展开**进 `useEffect` 的依赖数组\n' +
      '    （`[enabled, intervalMs, nonce, ...deps]`）—— 而 React 要求依赖数组**长度恒定**。\n' +
      '    ⚠️ 条件调用会让 hook 的**调用顺序/数量**在渲染间变化，React 会直接报错\n' +
      '    （"Rendered more hooks than during the previous render"）。\n' +
      '    ✅ 修法：把条件**移进** `usePolled` 的 `enabled` 选项，而不是包住调用。',
  );
});

test('★★★ 判据必须能真的报出条件调用 —— 用人造源码校准', () => {
  /*
   * ⚠️ "探针校准"：上面那条断言 `offenders` 为空，而**一个什么都没扫到的实现
   * 也返回空数组**。这里用同一套判据跑人造源码，断言它会被报出。
   */
  const classify = (prev: string, line: string): boolean => {
    const sameLine = /(?:&&|\|\||\?)\s*$/.test(line.slice(0, line.indexOf('usePolled')));
    const p = prev.trim();
    const prevIsIf = /^if\s*\(.*\)\s*\{?$/.test(p) || /^else\b/.test(p);
    const prevIsLoop = /^(?:for|while|do)\b/.test(p);
    return sameLine || prevIsIf || prevIsLoop;
  };

  /* ① `if (...) {` 后跟调用 → 必须报。 */
  assert.equal(
    classify('if (ready) {', '  const q = usePolled(fn);'),
    true,
    '★★★ 判据必须能报出条件调用 —— 否则上面那条是在空转',
  );
  /* ② `cond && usePolled(...)` → 必须报。 */
  assert.equal(classify('', '  const q = ready && usePolled(fn);'), true, '★★ `&&` 形态必须报');
  /* ③ 顶层直接调用 → 放过。 */
  assert.equal(
    classify('  const [tabVisible] = useState(true);', '  const q = usePolled(fn, { deps: [x] });'),
    false,
    '★★ 正常的顶层调用不能被误报',
  );
  /* ④ 循环里的调用 → 必须报。 */
  assert.equal(classify('for (const x of xs) {', '  usePolled(fn);'), true, '★★ 循环里的 hook 调用必须报');
});
