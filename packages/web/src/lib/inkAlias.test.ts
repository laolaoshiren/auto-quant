/**
 * **`--aq-ink-soft` 必须是真的别名，不能是各主题手工复制的字面值**
 *（外部 issue #176 / #177）。
 *
 * ## 缺陷经过
 *
 * `index.css:76` 的注释明说：
 *
 * > `ink-soft` —— **迁移期兼容别名，等于 `ink-mid`**。
 *
 * 而它的实现是**字面值副本**：
 *
 * ```css
 * --aq-ink-mid:  #b0aec0;
 * --aq-ink-soft: #b0aec0;   /* ← 复制了一份值，不是别名 *\/
 * ```
 *
 * 于是每个主题都得**记得手工复制一遍**。实测结果：
 *
 * | 主题 | `ink-mid` | `ink-soft` |
 * | --- | --- | --- |
 * | classic（`:root`） | `#b0aec0` | `#b0aec0` ✅ 手工同步过 |
 * | quill 深色 | `#b4b4bd` | `#b4b4bd` ✅ 手工同步过 |
 * | quill 浅色 | `#4b4b53` | `#4b4b53` ✅ 手工同步过 |
 * | **console 深色/浅色** | `#9fb0c0` / … | **一处都没有** ❌ |
 *
 * console 的 `theme.css` 里 `aq-ink-soft` **出现 0 次**，所以它一路继承
 * `:root` 的值 —— 而 `:root` 是 **classic 深色的紫灰 `#b0aec0`**。
 * 落到 console **浅色**的浅底上，对比度实测 **1.71**（`#b0aec0` on `#e0e5ea`），
 * 是整个 UI 里最差的一处；所有 13 处 `text-ink-soft` 在 console 浅色下都是错的。
 *
 * ## 为什么这个测试断言"结构"而不是"颜色值"
 *
 * 断言"console 浅色下 `ink-soft` 应该等于 `#55677a`"只能修好**这一次**：
 * 下一个主题（或下一个别名）照样会漏。而这条缺陷的**根因**是
 * "别名被实现成了副本" —— 所以断言必须钉住"**它是别名**"这件事：
 *
 *   1. `:root` 里 `--aq-ink-soft` 必须是 `var(--aq-ink-mid)`；
 *   2. **任何**主题块都不得再定义 `--aq-ink-soft` 的字面值
 *      （那会覆盖别名、让两处再次分叉）。
 *
 * 两条合起来 = "`ink-soft` 永远等于 `ink-mid`，且只有一处定义"。
 * 这比逐个主题核对颜色值更强，也不需要在没有浏览器的情况下算对比度。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `packages/web/src` —— 被测的 CSS 都在它下面。 */
const SRC = path.join(HERE, '..');

function read(rel: string): string {
  return readFileSync(path.join(SRC, rel), 'utf8');
}

/**
 * 全部模板目录名（`templates/<id>/`，排除 `lib/`）。
 *
 * 扫目录而不是写死清单：内置模板收敛成一套之后，第三方模板仍可加进来，
 * 而"每套模板都要覆盖 --aq-ink-mid"这条约束对它们同样成立。
 */
function allTemplateIds(): string[] {
  const root = path.join(SRC, 'templates');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'lib')
    .map((entry) => entry.name);
}

/**
 * 剥掉 CSS 注释后再匹配变量定义。
 *
 * ⚠️ **这一步是必需的，不是保险。** 本仓库的 CSS 注释密度很高，
 * 而这些注释**会逐字引用被修掉的旧值**（例如"这里原来是
 * `--aq-ink-soft: #b0aec0`"）—— 直接在原文上正则，会命中注释里那一处，
 * 得出"它还是字面值"的**假结论**。
 *
 * 同一个坑在本仓库出现过三次：`trader/startCancellation.test.ts`
 *（注释里引用了 `await autoTrader.start()`）、
 * `api/traderStatsNotFound.test.ts`（注释里引用了 `computeTraderStats()`），
 * 以及这里。
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 递归收集 `src` 下所有 `.css`。 */
function allCss(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) allCss(full, out);
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

test('★★★ :root 的 --aq-ink-soft 必须是 var(--aq-ink-mid)，而不是复制的字面值', () => {
  const css = stripCssComments(read('index.css'));

  /*
   * 找出 `:root` 块里那一行。用宽松匹配：变量名后面的值。
   */
  const match = /--aq-ink-soft:\s*([^;]+);/.exec(css);
  assert.ok(match, 'index.css 里必须定义 --aq-ink-soft（它是兼容别名，不能直接删）');

  const value = match[1]!.trim();
  assert.equal(
    value,
    'var(--aq-ink-mid)',
    `★★★ --aq-ink-soft 必须是 var(--aq-ink-mid)（真别名），实际是 "${value}" —— ` +
      `写成字面值副本就意味着"每个主题都要记得手工同步一遍"，` +
      `而 console 就是这么漏掉的（浅色下对比度 1.71，issue #176）`,
  );
});

test('★★★ 任何主题都不得再定义 --aq-ink-soft 字面值（否则覆盖别名、再次分叉）', () => {
  /*
   * 主题块（`html.aq-console[data-skin='light']` 之类）如果也写了
   * `--aq-ink-soft: #xxxxxx`，就会**覆盖** `:root` 的别名 ——
   * 于是"别名"这个不变量又被打破，下一个主题还会漏。
   *
   * 所以：别名只允许在 `index.css` 的 `:root` 里定义一次。
   */
  const offenders: string[] = [];
  for (const file of allCss()) {
    const rel = path.relative(SRC, file);
    if (rel === 'index.css') continue; // :root 的定义在这里，上面那条已断言
    const css = stripCssComments(readFileSync(file, 'utf8'));
    const re = /--aq-ink-soft(-rgb)?:\s*([^;]+);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) {
      offenders.push(`${rel}: --aq-ink-soft${m[1] ?? ''}: ${m[2]!.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些文件定义了 --aq-ink-soft 的字面值 —— 它会覆盖 :root 的真别名。\n' +
      '    别名应当只定义一次（index.css 的 :root），其余主题靠 var() 自动跟随。\n' +
      `    实际命中：\n      ${offenders.join('\n      ')}`,
  );
});

test('★★★ --aq-ink-soft-rgb 同样必须是别名（RGB 三元组也要跟随）', () => {
  /*
   * `--aq-ink-soft-rgb` 用于 `rgb(var(--aq-ink-soft-rgb) / 0.5)` 这类半透明用法。
   * 它和主值一样是手工副本，所以同一个漏法会同时发生 —— 只修一半的话，
   * 半透明场景（例如 `bg-ink-soft/10`）在 console 浅色下仍然是紫灰底。
   */
  const css = stripCssComments(read('index.css'));
  const match = /--aq-ink-soft-rgb:\s*([^;]+);/.exec(css);
  assert.ok(match, 'index.css 里必须定义 --aq-ink-soft-rgb');
  assert.equal(
    match[1]!.trim(),
    'var(--aq-ink-mid-rgb)',
    '★★★ --aq-ink-soft-rgb 必须是 var(--aq-ink-mid-rgb) —— 否则半透明用法仍是旧主题色',
  );
});

test('★ ink-mid 在每套模板里都有定义 —— 别名依赖它，它缺了别名就失去意义', () => {
  /*
   * 别名指向 `--aq-ink-mid`，所以那个变量必须在每套模板的主题块里存在，
   * 否则 `var(--aq-ink-mid)` 会解析成空值（文字颜色失效 → 继承）。
   *
   * UI 收敛之后内置只剩 `quill` 一套（2026-11-10）；第三方模板通过
   * `templates/<目录>/theme.css` 进来时，这条同样应该覆盖它 —— 所以扫目录而不是写死清单。
   */
  const missing: string[] = [];
  for (const tpl of allTemplateIds()) {
    const file = path.join(SRC, 'templates', tpl, 'theme.css');
    let css = '';
    try {
      css = readFileSync(file, 'utf8');
    } catch {
      /* 模板可以没有 theme.css（用 :root 默认值）—— 算通过。 */
      continue;
    }
    if (!css.includes('--aq-ink-mid:')) missing.push(tpl);
  }
  assert.deepEqual(missing, [], `这些模板的 theme.css 没有定义 --aq-ink-mid：${missing.join(', ')}`);
});
