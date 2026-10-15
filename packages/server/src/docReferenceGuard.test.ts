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

/** `docs/` 下全部 `.md` 的正文（用来查"这个编号在文档里有定义吗"）。 */
function docsText(): string {
  return walk(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

/**
 * 已知的"仓库外编号" —— 显式登记，附理由。
 *
 * ⚠️ 这份名单**不是垃圾桶**：每一条都要写清"它出自哪、为什么不在仓库里、
 * 以及读者该看什么替代"。
 *
 * ## ⚠️ 整族：`B.3` – `B.16`（11 处，全是同一份**仓库外的研究文档**）
 *
 * 我原本只发现 `B.14`，写了守卫之后它**报出 11 处**（`B.3`/`B.4`/`B.7`/`B.8`/`B.12`/`B.14`/`B.16`）。
 * 关键线索在 `llm/errors.ts:242`：
 *
 * > dangerous provider behaviour **in the research document** (B.8).
 *
 * ⚠️ 即它们全部指向**同一份"研究文档"**，而那份文档**不在这个仓库里**
 *（`git log -S "B.14" --all` 显示从仓库初始化提交 `b03bd02` 就存在）。
 *
 * ⚠️ **这是"整族漏网"的又一例**（与 `structuredOutput`、`ink-mid`、
 * `#123` 的 9 处未转义同型）：**补一个不够，要把这一族数清**。
 *
 * ⚠️ 规则本身在代码里**有实现**（`llm/errors.ts` 的 `isRetryable` 分类、
 * `retryAfterMs` 优先于本地退避、`client.ts` 的 full-jitter 退避、
 * 各 provider 的兼容性处理）—— 所以**代码没坏，坏的是"出处不可查"**。
 *
 * ⚠️ 修法（**都要人定，因为它涉及"要不要把那份研究文档公开"**）：
 *   ① 把相关内容摘进 `docs/`（例如 `docs/LLM-PROVIDERS.md`），注释改成指向它；
 *   ② 若那份文档不打算公开，把注释里的编号换成**自包含的说明**
 *      （例如"指数退避 + 全抖动，优先用服务端 `Retry-After`"）—— 不依赖外部出处。
 *
 * ⚠️ 我**没有擅自改注释** —— 因为 ① 要动文档结构、② 要判断哪些内容可以公开，
 * 两者都超出"修一个引用"的范围。
 */
const KNOWN_EXTERNAL: ReadonlyMap<string, string> = new Map([
  ['B.1', '仓库外的研究文档（provider 通用约定）—— `openaiCompatible.ts:363`'],
  ['B.3', '仓库外的研究文档（Anthropic 参数兼容性：`temperature` 只接受 `1.0`、`top_p ≥ 0.99`）'],
  ['B.4', '仓库外的研究文档（Gemini 原生 `generateContent` 调用形状）'],
  ['B.7', '仓库外的研究文档（Kimi 用 HTML 错误页回答网关超时等 provider 怪癖）'],
  ['B.8', '仓库外的研究文档（危险 provider 行为）—— `errors.ts:242` 自己写明是 "the research document"'],
  ['B.12', '仓库外的研究文档（provider 差异，出现在 anthropic / gemini / 测试里）'],
  ['B.14', '仓库外的研究文档（full-jitter 退避 + 重试策略）'],
  ['B.15', '仓库外的研究文档（OpenAI 兼容层的差异）—— `openaiCompatible.ts:83` / `types.ts:22`'],
  ['B.16', '仓库外的研究文档（启动预检的廉价能力探测）'],
]);

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
      '    ✅ 修法：把内容摘进 `docs/`，或把引用换成**自包含的说明**。\n' +
      '       若确实是仓库外的规格且不打算公开，加进 `KNOWN_EXTERNAL` 并写明"读者该看什么替代"。',
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
  assert.deepEqual(check('// 见 B.14 的说明'), [], '★★ 已登记的不能误报');
  /* `§5.4` 这种不在判据里（它是已确认可查证的体系）—— 顺带确认不误报。 */
  assert.deepEqual(check('// 见 §5.4 的说明'), [], '★★ `§` 编号不该被这条判据碰到');
});
