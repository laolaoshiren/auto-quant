/**
 * 文字对比度审计（WCAG AA，4.5:1）。
 *
 * ## 这个文件防的是什么
 *
 * 本仓库两次真实事故（外部 issue #172 / #177）都是**辅助文字在小字号下对比度不足**：
 * 徽章、表头、副标题在深底上只有 2.6–4.0，视觉上"有点淡"，但没有任何测试会红。
 * 而这类文字承载的是**内容**（不是占位符），必须达 4.5:1。
 *
 * ## UI 收敛之后测两套色板
 *
 * 2026-11-10 三套模板收敛为唯一的 `quill`（见 `templates/registry.ts`）。
 * 但 `index.css` 的 `:root` 默认色板仍然存在 —— 它是 `index.html` 首帧、
 * 以及第三方模板不覆盖令牌时的基线，所以两套都要守住：
 *
 * | 主题 | 来源 | 说明 |
 * | --- | --- | --- |
 * | `default`（:root） | `index.css` | 默认色板（issue #172 的修复成果） |
 * | `quill` | `templates/quill/theme.css` | 唯一内置模板，深 / 浅两套 |
 *
 * ## 判据用"最亮的底"（深色）与"最暗的底"（浅色）
 *
 * 同一档文字会出现在页面底、面板底、hover 态、侧栏选中块上。深色下最亮的底
 * 是最严格的一侧（淡色文字在亮底上更看不清）；浅色下则相反 —— 最暗的底最严格。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/** WCAG 相对亮度。 */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channel = (offset: number): number => {
    const c = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** 从 CSS 文本里取某个变量**第一次**出现的值（= 该主题的深色块）。 */
function tokenIn(css: string, token: string): string | null {
  const m = new RegExp(`--aq-${token}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  return m ? m[1]! : null;
}

const INDEX = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
const QUILL = readFileSync(new URL('../templates/quill/theme.css', import.meta.url), 'utf8');
/** quill 的浅色块（同一文件里 `[data-skin='light']` 之后）。 */
const QUILL_LIGHT = QUILL.slice(QUILL.indexOf("[data-skin='light']"));

/* -------------------------------------------------------------------------- */
/*  ① 默认色板（:root）—— issue #172 的修复成果                                  */
/* -------------------------------------------------------------------------- */

test('★★★ 默认色板的 ink-faint / ink-lo 必须在 panel 底上达到 AA（4.5）', () => {
  const page = tokenIn(INDEX, 'base-950')!;
  const panel = tokenIn(INDEX, 'base-900')!;
  const faint = tokenIn(INDEX, 'ink-faint')!;
  const lo = tokenIn(INDEX, 'ink-lo')!;

  for (const [name, bg] of [
    ['page', page],
    ['panel', panel],
  ] as const) {
    assert.ok(
      contrast(faint, bg) >= 4.5,
      `★★★ 默认色板 ink-faint ${faint} 在 ${name} ${bg} 上只有 ` +
        `${contrast(faint, bg).toFixed(3)} —— 低于 WCAG AA 的 4.5（issue #172）`,
    );
    assert.ok(
      contrast(lo, bg) >= 4.5,
      `★★★ 默认色板 ink-lo ${lo} 在 ${name} ${bg} 上只有 ` +
        `${contrast(lo, bg).toFixed(3)} —— 低于 4.5（issue #172 的实测里它在 panel 上 4.491）`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  ② quill 深色三级辅助文字（mid / lo / faint）                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ 为什么必须**三级一起**测（而不是只测最弱的两级）：
 *
 * `theme.css` 的注释把 `mid` / `lo` / `faint` 写成**一组**（"三级一起按目标
 * 对比度反解"）。本文件曾经只测 `lo` / `faint`，于是把 `ink-mid` 改暗**不会让
 * 任何测试变红** —— 那是"设计上是一组、测试只守了其中一部分"的典型漏网。
 * 补法是**把这一组补齐**。
 */
test('★★★ quill 深色的 ink-mid / ink-lo / ink-faint 必须在 page 与 panel 底上达标', () => {
  const page = tokenIn(QUILL, 'base-950')!;
  const panel = tokenIn(QUILL, 'base-900')!;
  const mid = tokenIn(QUILL, 'ink-mid')!;
  const lo = tokenIn(QUILL, 'ink-lo')!;
  const faint = tokenIn(QUILL, 'ink-faint')!;

  for (const [name, color] of [
    ['ink-mid', mid],
    ['ink-lo', lo],
    ['ink-faint', faint],
  ] as const) {
    for (const [bgName, bg] of [
      ['page', page],
      ['panel', panel],
    ] as const) {
      assert.ok(
        contrast(color, bg) >= 4.5,
        `★★★ quill 深色 ${name} ${color} 在 ${bgName} ${bg} 上只有 ` +
          `${contrast(color, bg).toFixed(3)} —— 低于 4.5。`,
      );
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  ③ 四级文字层级的顺序与间距（用户拍板："层级顺序不变"）                          */
/* -------------------------------------------------------------------------- */

test('★★★ 四级文字层级的顺序与间距不得因为提亮而退化', () => {
  /*
   * ⚠️ 这是**用户明确要求**的那一条：达标即止，但四级相对顺序不能变。
   *
   * ## 为什么它是个真风险（我算过）
   *
   * 默认色板的 `ink-faint` 单独提到 4.508 需要 `#7e7b84`，而 `ink-lo` 现值
   * `#7d7a8c` 的对比度是 **4.491** —— 两者几乎相同，**四级退化成三级**。
   * 所以两级必须一起提亮、保持间距。
   */
  for (const [label, css] of [
    ['default', INDEX],
    ['quill', QUILL],
  ] as const) {
    const bg = tokenIn(css, 'base-900')!;
    const strong = tokenIn(css, 'ink-strong')!;
    const ink = tokenIn(css, 'ink')!;
    const mid = tokenIn(css, 'ink-mid')!;
    const lo = tokenIn(css, 'ink-lo')!;
    const faint = tokenIn(css, 'ink-faint')!;

    const ladder: Array<[string, string]> = [
      ['strong', strong],
      ['ink', ink],
      ['mid', mid],
      ['lo', lo],
      ['faint', faint],
    ];

    /* ① 顺序：对比度必须严格递减（strong 最亮 → faint 最弱）。 */
    for (let i = 1; i < ladder.length; i += 1) {
      const [prevName, prevColor] = ladder[i - 1]!;
      const [name, color] = ladder[i]!;
      assert.ok(
        contrast(prevColor, bg) > contrast(color, bg),
        `★★★ ${label} 的层级顺序坏了：${prevName}(${contrast(prevColor, bg).toFixed(3)}) ` +
          `必须比 ${name}(${contrast(color, bg).toFixed(3)}) 更亮`,
      );
    }

    /* ② 间距：相邻两级至少差 0.4，否则"四级"名存实亡。 */
    for (let i = 1; i < ladder.length; i += 1) {
      const [prevName, prevColor] = ladder[i - 1]!;
      const [name, color] = ladder[i]!;
      const gap = contrast(prevColor, bg) - contrast(color, bg);
      assert.ok(
        gap >= 0.4,
        `★★★ ${label} 的 ${prevName} 与 ${name} 只差 ${gap.toFixed(3)} —— ` +
          '两级分不出来等于层级退化了。提亮弱级时必须同时抬强级、保持间距。',
      );
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  ④ quill 浅色三级辅助文字 —— 用【最暗的底色】当判据                             */
/* -------------------------------------------------------------------------- */

test('★★★ quill 浅色的三级辅助文字必须达标 —— 用【最暗的底色】当判据', () => {
  /*
   * ⚠️ **判据必须用浅色里最暗的那层底**（`base-950`）——
   * 浅色下"底色越暗，浅色文字越看不清"，所以那是最严格的一侧。
   *
   * 历史上（issue #177）console 浅色就是栽在这里：按 panel 底解出来 4.615
   * 看起来达标，而在更暗的页面底上只有 4.291 —— 不达标。
   */
  const bg = tokenIn(QUILL_LIGHT, 'base-950')!;
  const mid = tokenIn(QUILL_LIGHT, 'ink-mid')!;
  const lo = tokenIn(QUILL_LIGHT, 'ink-lo')!;
  const faint = tokenIn(QUILL_LIGHT, 'ink-faint')!;

  for (const [name, color] of [
    ['ink-mid', mid],
    ['ink-lo', lo],
    ['ink-faint', faint],
  ] as const) {
    assert.ok(
      contrast(color, bg) >= 4.5,
      `★★★ quill 浅色 ${name} ${color} 在最暗底 ${bg} 上只有 ` +
        `${contrast(color, bg).toFixed(3)} —— 低于 4.5。`,
    );
  }

  /* 层级顺序必须仍然递减（浅色下"越深越强"，所以对比度递减 = 顺序正确）。 */
  const ladder: Array<[string, string]> = [
    ['ink-mid', mid],
    ['ink-lo', lo],
    ['ink-faint', faint],
  ];
  for (let i = 1; i < ladder.length; i += 1) {
    const [prevName, prevColor] = ladder[i - 1]!;
    const [name, color] = ladder[i]!;
    const gap = contrast(prevColor, bg) - contrast(color, bg);
    assert.ok(
      gap > 0,
      `★★★ quill 浅色层级顺序坏了：${prevName} 必须比 ${name} 更强（对比度更高）`,
    );
    assert.ok(
      gap >= 0.4,
      `★★★ quill 浅色的 ${prevName} 与 ${name} 只差 ${gap.toFixed(3)} —— ` +
        '浅色下三级都要过 4.5，但也不能挤成一个色（层级名存实亡）。',
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  ⑤ 集合守卫：**每一个** ink 层级都必须有"达标"断言                             */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **这是"同型漏网"的元测试** —— 它不测某个颜色，它测"**这一组有没有被完整守住**"。
 *
 * 两次漏网（`structuredOutput`、console 的 `ink-mid`）都**不是"字段没人管"**，
 * 而是"**设计上是一组、测试只守了其中一部分**"。补上漏掉的那一个并不能防止下一次：
 * 有人加第六级、或者给某个主题加新层级时还会漏。所以钉住"这一组有哪些成员"。
 *
 * 判据：从 CSS 里解析出每个主题声明的 ink 层级集合，断言该集合**非空**，且
 * 每一个层级名都**在本文件里被断言过**（源码文本检查 —— 验的是测试自身的覆盖面）。
 *
 * ⚠️ `ink-strong` / `ink` 不要求达标：它们是正文与强调文字（对比度天然很高），
 * 而这条守卫针对"辅助文字"那一组 —— 豁免要**显式列出并写明理由**。
 */
test('★★★ 每一个 ink 层级都必须有对比度断言 —— 防止再漏一级', () => {
  const EXEMPT: ReadonlyMap<string, string> = new Map([
    ['default.ink-strong', '强调文字，对比度天然很高 —— 不在"辅助文字"这一组里'],
    ['default.ink', '正文色，对比度天然很高 —— 同上'],
    ['default.ink-soft', '别名（`var(--aq-ink-mid)`）—— 由 ink-mid 那条覆盖'],
    ['quill.ink-strong', '同 default：强调文字，对比度天然很高'],
    ['quill.ink', '同 default：正文色'],
    ['quill.ink-soft', '别名（`var(--aq-ink-mid)`）—— 由 ink-mid 那条覆盖'],
  ]);

  const self = readFileSync(new URL('./contrast.test.ts', import.meta.url), 'utf8');
  /* ⚠️ 剥掉注释再找断言 —— 注释里也引用了大量 token 名，不剥会造成假通过。 */
  const selfCode = self
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');

  const themes: Array<[string, string]> = [
    ['default', INDEX],
    ['quill', QUILL],
  ];

  const missing: string[] = [];
  let checked = 0;

  for (const [theme, css] of themes) {
    const levels = new Set<string>();
    for (const m of css.matchAll(/--aq-(ink(?:-[a-z]+)?):\s*#[0-9a-fA-F]{6}/g)) {
      levels.add(m[1]!);
    }

    assert.ok(
      levels.size >= 3,
      `★ ${theme} 只解析出 ${levels.size} 个 ink 层级 —— 解析可能失效了`,
    );

    for (const level of levels) {
      const key = `${theme}.${level}`;
      if (EXEMPT.has(key)) continue;
      checked += 1;
      /*
       * 判据：**这个层级名必须出现在某条达标断言里**。接受三种写法：
       * 直接 `contrast(token, …)`、"先取进变量再断言"（`--aq-<name>:`），
       * 以及本文件常用的 `tokenIn(css, '<name>')` 取法。
       */
      const escaped = level.replace('-', '\\-');
      const asserted =
        new RegExp(`contrast\\(\\s*${escaped}\\b`).test(selfCode) ||
        new RegExp(`const\\s+\\w+\\s*=\\s*[^;]*--aq-${level}:`).test(selfCode) ||
        new RegExp(`const\\s+\\w+\\s*=\\s*tokenIn\\([^)]*['"]${level}['"]`).test(selfCode);
      if (!asserted) missing.push(`${theme}.${level}`);
    }
  }

  /*
   * 内置模板收敛成一套之后，被守卫的"辅助文字层级"是 default(mid/lo/faint)
   * 与 quill(mid/lo/faint) 共 6 项。这个下限防的是"解析失效导致一项都没检查"。
   */
  assert.ok(
    checked >= 6,
    `★ 只检查到 ${checked} 个"辅助文字层级" —— 解析可能不完整`,
  );

  assert.deepEqual(
    missing,
    [],
    '★★★ 这些 ink 层级**没有任何"达标"断言**：\n' +
      missing.map((m) => `      · ${m}`).join('\n') +
      '\n    ⚠️ 这是"同型漏网"：设计上它们是一组（辅助文字），而测试只守了其中一部分。\n' +
      '    已经发生过两次（`structuredOutput`、`ink-mid`）——\n' +
      '    **补一个不够，要钉住这一组。**\n' +
      '    ✅ 若某级确实不该做达标断言，请加进 `EXEMPT` 并**写明理由**。',
  );
});
