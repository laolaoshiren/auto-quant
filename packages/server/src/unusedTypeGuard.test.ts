/**
 * **每一个导出的类型别名都必须有用途，或者写明"为什么留着"**。
 *
 * ## 这条守卫接的是什么
 *
 * 第 45 轮修好了一个**名存实亡的类型断言**（`ReplayMarketDataIsCompatible` ——
 * 一个 `type` 别名，从不产生编译错误，全仓只有定义处）。
 * 本轮按那条线索**回扫全仓**，找到 4 个"从未被引用"的类型别名：
 *
 * | 类型 | 实情 | 处置 |
 * | --- | --- | --- |
 * | `ModelCallFactory` | ⚠️ 注释说"为了让 `manager` 侧那段胶水写得清楚"，而 `manager.ts` **根本没引用它** | **删除** |
 * | `RiskControlConfig` | `z.infer` 配套类型，与 schema 成对 | 保留 + 写明理由 |
 * | `DrawdownGuard` | 同上 | 保留 + 写明理由 |
 * | `PromptSections` | 同上 | 保留 + 写明理由 |
 *
 * ## ⚠️ 两类"未被引用"的处理**不同**，判据必须认得出区别
 *
 * - **`z.infer<typeof Schema>` 配套类型**：它**不可能腐化**（schema 一改它自动跟着改），
 *   删除是**不可逆的信息损失**，而保留成本为零（类型不产生运行时代码）。
 *   ⇒ **可以保留**，但必须写明"为什么留着"。
 * - **手写的类型别名**（如 `ModelCallFactory`）：它会**独立腐化** ——
 *   注释可以描述一个从未存在的用途（这正是 `ModelCallFactory` 的情形）。
 *   ⇒ **要么有引用，要么写明保留理由**。
 *
 * ⚠️ 这与第 45 轮的教训是同一条：**"没人用的东西"分两种 —— 一种是契约的一部分，
 * 一种是漏删/失效的**。判据不能一刀切。
 *
 * ## 判据
 *
 * 扫全仓 `export type X = …`：
 * - 统计每个名字在**其它位置**的出现次数；
 * - 若为 0，则要求**它上方的注释里含"刻意保留"类标记**（`刻意保留` / `无人引用` / `@public`）；
 * - 否则报错。
 *
 * ## 边界（诚实说明）
 *
 * · 它只统计**名字出现次数** —— 认不出"被引用但引用处也是死的"（链式死代码）；
 * · 它**不检查**注释说的理由**是否成立**（那要人判）——
 *   它能做的是**逼着留下理由**，让下一个人有据可查；
 * · 它**不覆盖** `interface` / `enum` / 函数导出（本轮的发现都在 `type` 上）。
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

interface Decl {
  name: string;
  file: string;
  line: number;
  /** 定义处上方连续的注释块（用来找"刻意保留"的标记）。 */
  leadingComment: string;
  /** 是否是 `z.infer<typeof Schema>` 形态。 */
  isZodInfer: boolean;
}

/**
 * 剥掉注释但**保留行号**。
 *
 * ⚠️ **这一步是必须的**：我第一版直接扫原文，于是"引用计数"把**注释里提到的名字**
 * 也算进去了 —— 而我恰好刚在那三个类型上方写了说明（里面当然提到它们的名字），
 * 结果 `RiskControlConfig` 被算成"有 4 处引用"，守卫自己把自己绊倒。
 *
 * ⚠️ 这与第 43 轮"守卫命中自己"是同一类：**判据的输入必须只含代码，不含讲解**。
 * 保留行号是因为下面要报出准确位置（`filter` 式剥离会让行号漂）。
 */
function stripCommentsKeepLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') ? line : '';
    })
    .join('\n');
}

function scan(): { decls: Decl[]; sources: Array<{ file: string; text: string }> } {
  const rawSources = walk(join(ROOT, 'packages')).map((f) => ({
    file: f.slice(ROOT.length + 1).replace(/\\/g, '/'),
    text: readFileSync(f, 'utf8'),
  }));
  /* ⚠️ 计数用**剥掉注释**的文本 —— 见 `stripCommentsKeepLines` 的说明。 */
  const sources = rawSources.map((s) => ({ file: s.file, text: stripCommentsKeepLines(s.text) }));

  const decls: Decl[] = [];
  for (const { file, text } of rawSources) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^export type ([A-Za-z_$][\w$]*)\s*[=<]/.exec(lines[i] ?? '');
      if (!m) continue;
      /* 往上收集连续注释块（`*` / `//` / `/*` 开头的行）。 */
      const commentLines: string[] = [];
      for (let j = i - 1; j >= 0; j -= 1) {
        const t = (lines[j] ?? '').trim();
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t === '') {
          commentLines.unshift(lines[j] ?? '');
          /* 空行最多连续跳一行，避免一路吸到文件头。 */
          if (t === '' && commentLines.length > 1) break;
        } else break;
      }
      decls.push({
        name: m[1]!,
        file,
        line: i + 1,
        leadingComment: commentLines.join('\n'),
        isZodInfer: /z\.infer<typeof /.test(lines[i] ?? ''),
      });
    }
  }
  return { decls, sources };
}

/** 一个名字在**其它位置**出现多少次。 */
function usesOutside(decl: Decl, sources: Array<{ file: string; text: string }>): number {
  let n = 0;
  const re = new RegExp(`\\b${decl.name}\\b`, 'g');
  for (const { file, text } of sources) {
    const count = [...text.matchAll(re)].length;
    n += count - (file === decl.file ? 1 : 0);
  }
  return n;
}

/** "我刻意留着它"的标记。 */
const KEEP_MARKER = /(刻意保留|无人引用|未被引用|@public|公共契约|有意保留)/;

test('★★★ 未被引用的类型别名必须写明"为什么留着"', () => {
  const { decls, sources } = scan();

  /* 前置断言：必须真的扫到类型别名（否则"零个问题"是因为没扫到东西）。 */
  assert.ok(
    decls.length >= 30,
    `★ 只扫到 ${decls.length} 个 \`export type\` —— 扫描可能失效了，那样这条什么都没验`,
  );

  const unexplained: string[] = [];
  let checked = 0;
  for (const decl of decls) {
    const uses = usesOutside(decl, sources);
    checked += 1;
    if (uses > 0) continue;
    if (KEEP_MARKER.test(decl.leadingComment)) continue;
    unexplained.push(`${decl.file}:${decl.line}（\`${decl.name}\`${decl.isZodInfer ? '，z.infer 配套' : ''}）`);
  }

  assert.ok(checked >= 30, `★ 只检查了 ${checked} 个`);

  assert.deepEqual(
    unexplained,
    [],
    '★★★ 这些类型别名**全仓无人引用，也没写明为什么留着**：\n' +
      unexplained.map((u) => `      · ${u}`).join('\n') +
      '\n    ⚠️ 第 45 轮的教训：**一个 `type` 别名不产生任何编译错误** ——\n' +
      '    它能安静地烂在那里，而所有人以为它在起作用。\n' +
      '    ✅ 两种处置（**先查清楚是哪一种**）：\n' +
      '       · 若它的注释描述了某个用途 → **去核实那个用途是否存在**。\n' +
      '         ⚠️ `ModelCallFactory` 就是这样：注释说"为了让 `manager` 侧那段胶水\n' +
      '         写得清楚"，而 `manager.ts` 根本没引用它 —— 那叫**注释不实**，应当删掉。\n' +
      '       · 若它是 `z.infer<typeof Schema>` 配套类型 → 保留，并在上方写明\n' +
      '         "刻意保留"（理由：schema 一改它自动跟着改、不会腐化）。',
  );
});

test('★★★ 判据必须能真的报出"无引用且无说明" —— 用人造数据校准', () => {
  /*
   * ⚠️ "探针校准"：上面那条断言 `unexplained` 为空，而**一个什么都没扫到的实现
   * 也返回空数组**。这里用同一套判据跑人造数据，断言它会被报出。
   */
  const decide = (leadingComment: string, isZodInfer: boolean): 'keep' | 'report' => {
    if (KEEP_MARKER.test(leadingComment)) return 'keep';
    return 'report';
  };

  /* ① 无注释的手写类型 → 必须报。 */
  assert.equal(decide('', false), 'report', '★★★ 判据必须能报出无说明的死类型 —— 否则上面那条是在空转');
  /* ② 写明"刻意保留" → 放过。 */
  assert.equal(decide('/** ⚠️ 当前仓库内无人引用 —— 刻意保留。 */', false), 'keep', '★★ 写明理由的不该被报');
  /* ③ 形如 `@public` 的标记 → 放过。 */
  assert.equal(decide('/* @public 跨端契约 */', false), 'keep', '★★ `@public` 标记不该被报');
  /* ④ 空注释 + z.infer 也要报（**必须写明理由**，形态本身不是理由）。 */
  assert.equal(
    decide('', true),
    'report',
    '★★★ `z.infer` 形态**不能自动免检** —— 它只是"可以保留"的理由，仍要写下来',
  );
});

test('★★★ 本轮的四个发现必须都处于"已处置"状态（防回退）', () => {
  /*
   * ⚠️ 这条钉住本轮的**具体结论**，防止有人把删除的加回来、或把说明删掉。
   */
  const { decls, sources } = scan();
  const byName = new Map(decls.map((d) => [d.name, d]));

  /* ① `ModelCallFactory` 必须已删除（它是死代码 + 注释不实）。 */
  assert.ok(
    !byName.has('ModelCallFactory'),
    '★★★ `ModelCallFactory` **不该再出现** —— 它全仓无人引用，且注释描述的用途不存在\n' +
      '    （注释说"为了让 `manager` 侧那段胶水写得清楚"，而 `manager.ts` 用的是 `ModelRouter` 类）。',
  );

  /* ② 那三个 `z.infer` 配套类型必须还在，且写明了保留理由。 */
  for (const name of ['RiskControlConfig', 'DrawdownGuard', 'PromptSections']) {
    const decl = byName.get(name);
    assert.ok(decl, `★★ \`${name}\` 应当保留（它是 schema 的配套契约）`);
    assert.ok(
      decl.isZodInfer,
      `★★ \`${name}\` 应当是 \`z.infer<typeof Schema>\` 形态 —— 换形态会让它开始腐化`,
    );
    assert.ok(
      KEEP_MARKER.test(decl.leadingComment),
      `★★ \`${name}\` 必须写明"刻意保留"的理由 ——\n` +
        '    否则下一个人会以为它是漏删，然后删掉它（那是不可逆的信息损失）。',
    );
    /*
     * ⚠️ **不在这里断言"引用数为 0"** —— 本文件（以及上面那条用例的报错文案）
     * 会**提到这些名字**，于是计数永远 ≥ 1。我第一版就是这么做然后失败的。
     *
     * ⚠️ 这与"守卫命中自己"是同一类问题，而这次的教训更具体：
     * **一个断言"某名字无人引用"的测试，本身就会让那个名字被引用。**
     * 想真验它，得把扫描范围排除测试文件 —— 但那会漏掉"测试里唯一在用"的真情形。
     * 所以这里**放弃这条断言**：上面两条（形态 + 理由）已经足够防回退。
     */
  }
});
