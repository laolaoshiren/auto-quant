/**
 * **注释里引用的"外部编号"必须能在仓库里查到**。
 *
 * ## 这条守卫接的是什么
 *
 * 本仓库的注释大量使用**编号引用** —— 例如 `§5.4`、`§2.5`、`AGENTS.md §4.3`。
 * ⚠️ 那些是**可查证的**（`docs/AGENTS.md` 里有 `### 2.5`、`### 5.4` 等小节）。
 *
 * 但我扫的时候发现 **8 处引用 `B.14`**，而**全仓（含所有 `.md`）都没有它的定义**：
 *
 * ```
 * packages/server/src/llm/client.ts:88   Full-jitter backoff bounds from B.14 (base ≈ 500ms, cap ≈ 30s)
 * packages/server/src/llm/client.ts:140  overload (B.14)
 * packages/server/src/llm/errors.ts:29   preferred over any locally computed backoff (B.14 rule 1)
 * packages/server/src/llm/errors.ts:68   quota exhaustion is pure waste (B.14)
 * packages/server/src/llm/errors.ts:144  must not be retried (B.14)
 * packages/server/src/llm/errors.ts:155  Map a coarse kind onto the retry policy from B.14
 * packages/server/src/llm/http.ts:279    (B.14 rule 1)
 * packages/server/src/llm/llm.test.ts:543  Retryability classifier (B.14)
 * ```
 *
 * ⚠️ 而 `git log -S "B.14" --all` 显示它**从仓库初始化提交（`b03bd02`）就存在** ——
 * 所以它来自**仓库外的设计文档**，而那份文档**不在这个仓库里**。
 *
 * ## 为什么这是真缺陷（而不是"注释啰嗦"）
 *
 * 本仓库对注释的要求很明确（`docs/AGENTS.md` §5.1）：
 * > 注释解释**为什么**，常常直指它防的那个 bug
 *
 * ⚠️ 而"为什么"如果指向一个**读者无法访问的出处**，那个"为什么"就**不可查证** ——
 * 读者既不能确认它是否仍然成立，也不能知道改它会不会违反某个约定。
 * **这与本仓库反复强调的"注释与实现漂移"是同一族问题**：
 * 引用还在，出处没了。
 *
 * ## 判据
 *
 * 扫**注释里**形如 `B.14` / `附录 C` 这类"外部编号"引用，
 * 断言每一个都能在 `docs/` 里找到对应（或已在 `KNOWN_EXTERNAL` 里显式登记）。
 *
 * ⚠️ 判据**只扫注释**（不看字符串与代码）—— 因为"注释里的引用"才是给读者看的。
 *
 * ## 边界（诚实说明）
 *
 * · 它只认"**形如外部编号**"的形状（`[A-Z].数字`），抓不住别的引用形式
 *   （例如"见内部文档 X"）；
 * · 它**不检查**引用是否**内容正确**（只查"出处存不存在"）—— 那只有人判得了；
 * · `§` 编号体系**不在这条的判据里** —— 因为它已确认可查证（`docs/AGENTS.md`），
 *   再守一遍就是"同一件事两套实现"。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/** 从本文件定位仓库根。 */
function findRepoRoot(): string {
  const start = fileURLToPath(new URL('.', import.meta.url));
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      if (statSync(join(dir, 'docs', 'AGENTS.md')).isFile()) return dir;
    } catch {
      /* 继续往上。 */
    }
    dir = join(dir, '..');
  }
  throw new Error(`找不到仓库根（从 ${start} 向上找了 8 层）`);
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
    if (['node_modules', 'dist', '.git', 'coverage'].includes(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * `docs/` 下全部 `.md` 的正文（用来查"这个编号在文档里有定义吗"）。
 *
 * ⚠️ **不能用上面的 `walk()`** —— 它只收 `.ts`/`.tsx`，而 `docs/` 下**全是 `.md`**。
 * 我第一版就是这么写的，于是 `docsText()` **永远返回空串**，
 * 而"文档里有定义就算可查证"那条分支**永不成立** —— 守卫退化成"只看 KNOWN_EXTERNAL"。
 *
 * ⚠️ 这个缺陷是**用变异发现的**：我把 `KNOWN_EXTERNAL` 清空后守卫**仍然失败**
 *（本该如此，因为文档没被读到）。若它当时"通过"了，说明判据在看别的东西。
 *
 * ⚠️ 教训与第 33 轮一致：**判据的实现本身也要验证** ——
 * 一个"读了但读错文件类型"的辅助函数，会让整条判据静默退化。
 */
function docsText(): string {
  const out: string[] = [];
  const collect = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) collect(full);
      else if (entry.endsWith('.md')) out.push(readFileSync(full, 'utf8'));
    }
  };
  collect(join(ROOT, 'docs'));
  /* 根目录的 README 也算文档。 */
  try {
    out.push(readFileSync(join(ROOT, 'README.md'), 'utf8'));
  } catch {
    /* 没有就没有。 */
  }
  return out.join('\n');
}

/**
 * 已知的"仓库外编号" —— 显式登记，附理由。
 *
 * ⚠️ **这份名单现在是空的** —— 因为 `docs/EXTERNAL-REFS.md` 已经登记了整族 `B.x`。
 *
 * 判据是"**能在 `docs/` 里查到** **或** 在这份名单里登记"。文档存在时，名单就是**冗余**的
 * —— 所以下面的反向检查会**报错**，提醒把它清掉（否则名单会腐化，
 * 下一个人会以为"文档里查不到"）。
 *
 * ⚠️ 保留这个 `Map` 与反向检查，是为了**下一个**不可查证的引用：
 * 它要么进 `docs/`，要么进这份名单，**二者必居其一**。
 *
 * ## 回顾：这一族是怎么被发现的（值得记）
 *
 * 我原本只发现 `B.14`（8 处），写了守卫之后它**报出 11 处**
 *（`B.3`/`B.4`/`B.7`/`B.8`/`B.12`/`B.14`/`B.16`），补完登记后**又报出 3 处**
 *（`B.1`/`B.15`）。最终穷尽统计是 **9 种编号、27 处引用**。
 *
 * 关键线索在 `llm/errors.ts:242`：
 * > dangerous provider behaviour **in the research document** (B.8).
 *
 * ⚠️ **这是"整族漏网"的又一例**（与 `structuredOutput`、`ink-mid`、
 * `#123` 的 9 处未转义同型）：**补一个不够，要把这一族数清** ——
 * 而我这次是**靠守卫自己数清的**（它报出 11 处时我才知道不止一个）。
 */
const KNOWN_EXTERNAL: ReadonlyMap<string, string> = new Map([]);

/** 允许在"探针校准"用例里出现的人造编号（否则守卫会命中自己）。 */
const CALIBRATION_REFS = new Set(['C.2', 'Z.99']);

test('★★★ 注释里引用的"外部编号"必须能在仓库里查到', () => {
  const docs = docsText();
  const files = walk(join(ROOT, 'packages'));

  /* 形如 `B.14` / `C.2` 的外部编号（大写字母 + 点 + 数字）。 */
  const REF = /\b([A-Z]\.\d{1,2})\b/g;

  const unknown: string[] = [];
  let checked = 0;

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
    /*
     * ⚠️ 排除**本文件** —— 下面那条"探针校准"用例里**故意**写了人造编号
     *（`C.2`、`Z.99`）来验证判据有效。我第一版就因此命中了自己。
     */
    if (rel.endsWith('docReferenceGuard.test.ts')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      /* ⚠️ 只看注释行（`//` 或 `*` 开头）—— 代码里的同形串不是"引用"。 */
      const t = line.trim();
      const isComment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
      if (!isComment) continue;

      for (const m of line.matchAll(REF)) {
        const ref = m[1]!;
        checked += 1;
        if (KNOWN_EXTERNAL.has(ref)) continue;
        /* 文档里有定义就算可查证。 */
        if (new RegExp(`\\b${ref.replace('.', '\\.')}\\b`).test(docs)) continue;
        unknown.push(`${rel}:${i + 1}（${ref}）`);
      }
    }
  }

  /* 前置断言：必须真的扫到若干引用（否则"零个问题"是因为没扫到东西）。 */
  assert.ok(
    checked >= 3,
    `★ 只扫到 ${checked} 处"外部编号"引用 —— 扫描可能失效了，那样这条什么都没验`,
  );

  assert.deepEqual(
    unknown,
    [],
    '★★★ 这些注释引用了**仓库里查不到的编号**：\n' +
      unknown.map((u) => `      · ${u}`).join('\n') +
      '\n    ⚠️ `docs/AGENTS.md` §5.1 要求注释解释"**为什么**"——\n' +
      '    而"为什么"指向一个读者无法访问的出处时，那个"为什么"就**不可查证**：\n' +
      '    读者既不能确认它是否仍然成立，也不知道改它会不会违反某个约定。\n' +
      '    ✅ 修法：把内容摘进 `docs/`（见 `docs/EXTERNAL-REFS.md` 的做法），\n' +
      '       或把引用换成**自包含的说明**。\n' +
      '       若确实是仓库外的规格且不打算公开，加进 `KNOWN_EXTERNAL` 并写明"读者该看什么替代"。',
  );
});

test('★★★ `KNOWN_EXTERNAL` 不许留下已经进文档的条目（名单会腐化）', () => {
  /*
   * ⚠️ 判据是"能在 `docs/` 里查到 **或** 在名单里登记" —— 两者是**或**关系。
   * 所以一旦某条编号进了 `docs/`，名单里那条就是**冗余**的，
   * 留着会让下一个人以为"文档里查不到、只能看豁免"。
   *
   * ⚠️ 我这一轮就碰到了这个情形：写完 `docs/EXTERNAL-REFS.md` 之后，
   * 那 9 条登记全部变成冗余 —— 靠这条反向检查才会被发现。
   */
  const docs = docsText();
  const stale: string[] = [];
  for (const [ref] of KNOWN_EXTERNAL) {
    if (new RegExp(`\\b${ref.replace('.', '\\.')}\\b`).test(docs)) stale.push(ref);
  }
  assert.deepEqual(
    stale,
    [],
    '★★★ 这些编号**已经在 `docs/` 里能查到了**，请从 `KNOWN_EXTERNAL` 移除：\n' +
      stale.map((s) => `      · ${s}`).join('\n') +
      '\n    ⚠️ 留在名单里会让下一个人以为"文档里查不到、只能看豁免"。',
  );
});

test('★★★ 判据必须能真的报出不可查证的引用 —— 用人造数据校准', () => {
  /*
   * ⚠️ "探针校准"：上面那条断言 `unknown` 为空，而**一个什么都没扫到的实现
   * 也返回空数组**。这里用同一套判据跑人造注释，断言它会被报出。
   */
  const docs = docsText();
  const check = (commentLine: string): string[] => {
    const out: string[] = [];
    for (const m of commentLine.matchAll(/\b([A-Z]\.\d{1,2})\b/g)) {
      const ref = m[1]!;
      if (KNOWN_EXTERNAL.has(ref) || CALIBRATION_REFS.has(ref)) continue;
      if (new RegExp(`\\b${ref.replace('.', '\\.')}\\b`).test(docs)) continue;
      out.push(ref);
    }
    return out;
  };

  assert.deepEqual(
    check('// 见 Q.77 的说明'),
    ['Q.77'],
    '★★★ 判据必须能报出不可查证的编号 —— 否则上面那条是在空转',
  );
  /* ⚠️ `B.14` 现在**在文档里能查到**（`docs/EXTERNAL-REFS.md`），所以不该被报出。 */
  assert.deepEqual(check('// 见 B.14 的说明'), [], '★★ 文档里登记过的不能误报');
  /* `§5.4` 这种不在判据里（它是已确认可查证的体系）—— 顺带确认不误报。 */
  assert.deepEqual(check('// 见 §5.4 的说明'), [], '★★ `§` 编号不该被这条判据碰到');
});
