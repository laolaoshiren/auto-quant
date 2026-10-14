/**
 * **辅助文字必须达到 WCAG AA，且四级层级顺序不变**
 *（外部 issue #172 / #177，用户拍板："达标即止、层级顺序不变"）。
 *
 * ## 缺陷
 *
 * `ink-faint` / `ink-lo` 是四级文字层级里最弱的两级，取值只按"视觉层级够弱"挑，
 * **没有按对比度下限挑**。实测（issue #172 自算，我复核过）：
 *
 * ```
 * classic 深色 page #0a0a0a / panel #121212
 *   ink-faint #57545f : 2.676 / 2.532     ← 远低于 4.5
 *   ink-lo    #7d7a8c : 4.746 / 4.491     ← panel 上也差一点
 * console 深色 page #171c22 / panel #1d232b
 *   ink-faint #5a6876 : 3.000 / 2.769     ← 远低于 4.5
 *   ink-lo    #78889a : 4.722 / 4.359     ← panel 上不达
 * quill  深色 ink-faint #94949f : 6.011 / 5.216   ← 通过，不动
 * ```
 *
 * 全仓 `text-ink-faint` 约 300 处，其中不少是 `text-xs`（11px）的说明文字 ——
 * 属 WCAG 1.4.3 的**普通文本**（< 18pt）⇒ 需 4.5。
 *
 * ## ⚠️ 一个必须避开的陷阱：只提 faint 会让它与 lo 重叠
 *
 * 把 classic 的 `ink-faint` 单独提到 4.508 需要 `#7e7b84` ——
 * 而 `ink-lo` 现值 `#7d7a8c` 的对比度是 **4.491**。两者几乎相同 ⇒
 * **四级层级退化成三级**（faint 与 lo 分不出来）。
 *
 * 所以两级**一起提亮**：faint 拉到刚过 4.5，lo 跟着抬、保持与 faint 的间距。
 *
 * ## 这个测试钉什么
 *
 * 1. 每一级在**它实际出现的底色**上都 ≥ 4.5；
 * 2. **四级相对顺序不变**（strong > ink > mid > lo > faint）；
 * 3. 相邻两级**有可辨的间距**（不能退化成一个色）。
 *
 * ⚠️ 判据用的是**深色主题的 panel 底色**（比 page 更浅那一层）—— 那是更严格的一侧
 *（文字落在面板上时对比度更低）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/* ── WCAG 2.x 对比度 ─────────────────────────────────────────────────── */

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace('#', '').trim();
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
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

/**
 * 取**浅色块**里的值 —— 该 token 出现两次时取第二次。
 *
 * ⚠️ 两个取法都要有：`tokenIn` 取深色块、这个取浅色块。
 * 只写一个会让"取到哪个块"变成偶然 —— 我第一版就因此让 console 的
 * `--aq-ink` 取到了**浅色块**的 `#0b1620`，于是"层级顺序"那条判据
 * 报出 `ink(1.028) 必须比 mid(7.115) 更亮` 这种莫名其妙的失败。
 */
function tokenInLightBlock(css: string, token: string): string | null {
  const all = [...css.matchAll(new RegExp(`--aq-${token}:\\s*(#[0-9a-fA-F]{6})`, 'g'))];
  return all.length >= 2 ? all[1]![1]! : tokenIn(css, token);
}

const INDEX = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
const CONSOLE = readFileSync(new URL('../templates/console/theme.css', import.meta.url), 'utf8');
const QUILL = readFileSync(new URL('../templates/quill/theme.css', import.meta.url), 'utf8');

/* -------------------------------------------------------------------------- */
/*  ① classic（`:root`）深色                                                     */
/* -------------------------------------------------------------------------- */

test('★★★ classic 深色的 ink-faint / ink-lo 必须在 panel 底上达到 AA（4.5）', () => {
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
      `★★★ classic 深色 ink-faint ${faint} 在 ${name} ${bg} 上只有 ` +
        `${contrast(faint, bg).toFixed(3)} —— 低于 WCAG AA 的 4.5（issue #172）`,
    );
    assert.ok(
      contrast(lo, bg) >= 4.5,
      `★★★ classic 深色 ink-lo ${lo} 在 ${name} ${bg} 上只有 ` +
        `${contrast(lo, bg).toFixed(3)} —— 低于 4.5（issue #172 的实测里它在 panel 上 4.491）`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  ② console 深色                                                              */
/* -------------------------------------------------------------------------- */

test('★★★ console 深色的 ink-faint / ink-lo 必须在 panel 底上达到 AA', () => {  /*
   * ⚠️ console 的 `ink-faint` 在文件里出现**两次**（深色块与浅色块）——
   * `tokenIn` 取最后一次出现，所以这里单独测浅色块由下面那条负责。
   * 深色块的值取**第一次**出现。
   */
  const firstFaint = /--aq-ink-faint:\s*(#[0-9a-fA-F]{6})/.exec(CONSOLE)![1]!;
  const page = /--aq-base-950:\s*(#[0-9a-fA-F]{6})/.exec(CONSOLE)![1]!;
  const lo = /--aq-ink-lo:\s*(#[0-9a-fA-F]{6})/.exec(CONSOLE)![1]!;
  /* panel 是 base-900（console 深色）—— 从文件里取第一个。 */
  const panel = /--aq-base-900:\s*(#[0-9a-fA-F]{6})/.exec(CONSOLE)![1]!;

  for (const [name, bg] of [
    ['page', page],
    ['panel', panel],
  ] as const) {
    assert.ok(
      contrast(firstFaint, bg) >= 4.5,
      `★★★ console 深色 ink-faint ${firstFaint} 在 ${name} ${bg} 上只有 ` +
        `${contrast(firstFaint, bg).toFixed(3)} —— 低于 4.5（issue #172 实测 3.0/2.769）`,
    );
    assert.ok(
      contrast(lo, bg) >= 4.5,
      `★★★ console 深色 ink-lo ${lo} 在 ${name} ${bg} 上只有 ${contrast(lo, bg).toFixed(3)}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  ③ 四级层级顺序 + 间距（用户拍板："层级顺序不变"）                              */
/* -------------------------------------------------------------------------- */

test('★★★ 四级文字层级的顺序与间距不得因为提亮而退化', () => {
  /*
   * ⚠️ 这是**用户明确要求**的那一条：达标即止，但四级相对顺序不能变。
   *
   * ## 为什么它是个真风险（我算过）
   *
   * classic 的 `ink-faint` 单独提到 4.508 需要 `#7e7b84`，而 `ink-lo` 现值
   * `#7d7a8c` 的对比度是 **4.491** —— 两者几乎相同，**四级退化成三级**。
   * 所以两级必须一起提亮、保持间距。
   */
  for (const [label, css] of [
    ['classic', INDEX],
    ['console', CONSOLE],
  ] as const) {
    const bg = label === 'classic' ? tokenIn(INDEX, 'base-900')! : /--aq-base-900:\s*(#[0-9a-fA-F]{6})/.exec(CONSOLE)![1]!;
    const strong = tokenIn(css, 'ink-strong') ?? (/--aq-ink-strong:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1] ?? null);
    const ink = tokenIn(css, 'ink') ?? (/--aq-ink:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1] ?? null);
    const mid = /--aq-ink-mid:\s*(#[0-9a-fA-F]{6})/.exec(css)![1]!;
    const lo = /--aq-ink-lo:\s*(#[0-9a-fA-F]{6})/.exec(css)![1]!;
    const faint = /--aq-ink-faint:\s*(#[0-9a-fA-F]{6})/.exec(css)![1]!;

    const ladder: Array<[string, string]> = [
      ['strong', strong!],
      ['ink', ink!],
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
/*  ⑤ console 浅色（issue #177）—— 比深色更糟的那一面                             */
/* -------------------------------------------------------------------------- */

test('★★★ console 浅色的三级辅助文字必须达标 —— 用【最暗的底色】当判据', () => {
  /*
   * ## 为什么浅色要单独测，而且判据取"最暗的底色"
   *
   * issue #177 的结论是「**console 浅色主题的辅助文字比深色更糟**」。实测原来
   * （我复核过）：
   *
   * ```
   *   ink-faint #9aa7b4 : page #e8ecf0 上 2.222    ← 浅色下它"更浅"，落在浅底上更看不清
   *   ink-dim   #78889a : 3.287
   *   ink-muted #55677a : 5.273                    ← 唯一达标的那一级
   * ```
   *
   * ⚠️ **判据必须用浅色里最暗的那层底**（`base-950 #e8ecf0`）——
   * 浅色下"底色越暗，浅色文字越看不清"，所以那是最严格的一侧。
   * 我第一版只按 `panel #f1f4f7` 解，得到 `ink-faint #676f78`（在 panel 上 4.615
   * 看起来达标），**而在 `#e8ecf0` 上只有 4.291** —— 不达标。
   * 这正是"在错误的底色上验证"的典型：结论看起来通过，实际没通过。
   */
  const bg = /--aq-base-950:\s*(#[0-9a-fA-F]{6})/.exec(
    CONSOLE.slice(CONSOLE.indexOf("[data-skin='light']")),
  )![1]!;

  /* 三级都要看（浅色下 `ink-muted` 也参与了重新分配，见 theme.css 的注释）。 */
  const lightBlock = CONSOLE.slice(CONSOLE.indexOf("[data-skin='light']"));
  const tokens: Array<[string, string]> = [
    ['ink-muted', /--aq-ink-muted:\s*(#[0-9a-fA-F]{6})/.exec(lightBlock)![1]!],
    ['ink-dim', /--aq-ink-dim:\s*(#[0-9a-fA-F]{6})/.exec(lightBlock)![1]!],
    ['ink-faint', /--aq-ink-faint:\s*(#[0-9a-fA-F]{6})/.exec(lightBlock)![1]!],
  ];

  for (const [name, color] of tokens) {
    assert.ok(
      contrast(color, bg) >= 4.5,
      `★★★ console 浅色 ${name} ${color} 在最暗底 ${bg} 上只有 ` +
        `${contrast(color, bg).toFixed(3)} —— 低于 4.5（issue #177）`,
    );
  }

  /* 层级顺序必须仍然递减（浅色下"越深越强"，所以对比度递减 = 顺序正确）。 */
  for (let i = 1; i < tokens.length; i += 1) {
    const [prevName, prevColor] = tokens[i - 1]!;
    const [name, color] = tokens[i]!;
    const gap = contrast(prevColor, bg) - contrast(color, bg);
    assert.ok(
      gap > 0,
      `★★★ console 浅色层级顺序坏了：${prevName} 必须比 ${name} 更强（对比度更高）`,
    );
    assert.ok(
      gap >= 0.4,
      `★★★ console 浅色的 ${prevName} 与 ${name} 只差 ${gap.toFixed(3)} —— ` +
        '浅色下三级都要过 4.5，但也不能挤成一个色（层级名存实亡）。',
    );
  }
});

test('★★ 浅色块里两套命名（ink-muted/ink-dim 与 ink-mid/ink-lo）必须一致', () => {
  /*
   * ⚠️ console 的浅色块里，同一批语义定义了**两次** —— 旧命名
   * （`ink-muted`/`ink-dim`）与新命名（`ink-mid`/`ink-lo`）。
   * 后者在同一选择器里定义得更靠后，所以**它生效**；而只改一处的后果是
   * 「改的那处不生效、生效的那处没改」，且**静默分叉**。
   *
   * 深色块里也是同一个结构（我在修 #172 时踩过：先改了旧命名那组，
   * 对比度测试仍然失败，因为生效的是新命名那组）。
   */
  const lightBlock = CONSOLE.slice(CONSOLE.indexOf("[data-skin='light']"));
  for (const [oldName, newName] of [
    ['muted', 'mid'],
    ['dim', 'lo'],
  ] as const) {
    const a = new RegExp(`--aq-ink-${oldName}:\\s*(#[0-9a-fA-F]{6})`).exec(lightBlock)![1]!;
    const b = new RegExp(`--aq-ink-${newName}:\\s*(#[0-9a-fA-F]{6})`).exec(lightBlock)![1]!;
    assert.equal(
      a,
      b,
      `★★ 浅色块里 ink-${oldName}(${a}) 与 ink-${newName}(${b}) 必须一致 —— ` +
        '同一个块里两套命名分叉会让"改了一处"看起来生效、实际不生效。',
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  ④ quill 已经达标 → 不动                                                      */
/* -------------------------------------------------------------------------- */

test('★ quill 的 ink-faint 本来就达标 —— 不该被"顺手也改一下"', () => {
  const faint = /--aq-ink-faint:\s*(#[0-9a-fA-F]{6})/.exec(QUILL)![1]!;
  const panel = /--aq-base-900:\s*(#[0-9a-fA-F]{6})/.exec(QUILL)![1]!;
  assert.ok(
    contrast(faint, panel) >= 4.5,
    `★ quill 的 ink-faint ${faint} 实测 ${contrast(faint, panel).toFixed(3)}（issue #172 也确认它通过）`,
  );
});

/* -------------------------------------------------------------------------- */
/*  ⑤ 同型漏网：`mid` 也是"三级一组"里的一级，也必须达标                          */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **这一条是变异测试发现的"同型漏网"**（与 `structuredOutput` 是同一类问题）。
 *
 * `theme.css` 的注释把 `mid` / `lo` / `faint` 写成**一组**：
 *
 * > 修法：三级一起按目标对比度反解（`mid` 6.2 / `lo` 5.3 / `faint` 4.6）——
 * > 互不相同、间距 ≥0.68，**层级顺序不变**
 *
 * ⚠️ 而本文件原本**只测了 `lo` 与 `faint` 两级**：
 * - `mid` 出现在"层级顺序"那条里，但那条只验**相对顺序与间距**，**不验达标**；
 * - 于是把 `--aq-ink-muted` 改成极暗的 `#3a4550`（对比度远低于 4.5）→ **6 条全绿**。
 *
 * ⚠️ 与 `structuredOutput` 完全同型：**设计上是一组，测试只守住其中一部分**。
 * 补法是"**把这一组补齐**"，而不是只补被发现的那一个。
 */
test('★★★ console 的 ink-mid（三级一组里的最高一级）也必须在 panel 底上达标', () => {
  /*
   * ⚠️ 两个块里 `mid` 的**命名不同**（与 lo/faint 一样）：
   * - 深色块：`ink-muted`（第 104 行）与 `ink-mid`（第 194 行）—— 后者生效；
   * - 浅色块：`ink-mid`。
   * 所以取**生效的那一个**（`ink-mid`，它在同选择器里定义得更靠后）。
   */
  const panel = /--aq-base-900:\s*(#[0-9a-fA-F]{6})/.exec(CONSOLE)![1]!;
  const page = /--aq-base-950:\s*(#[0-9a-fA-F]{6})/.exec(CONSOLE)![1]!;

  const mid = /--aq-ink-mid:\s*(#[0-9a-fA-F]{6})/.exec(CONSOLE)![1]!;

  for (const [name, bg] of [
    ['page', page],
    ['panel', panel],
  ] as const) {
    assert.ok(
      contrast(mid, bg) >= 4.5,
      `★★★ console 的 ink-mid ${mid} 在 ${name} ${bg} 上只有 ${contrast(mid, bg).toFixed(3)} ——\n` +
        '    低于 4.5。它是注释里"三级一起反解"的**最高那一级**（目标 6.2），\n' +
        '    ⚠️ 而本文件原本只测了 lo/faint 两级 —— 把它改暗不会让任何测试变红（同型漏网）。',
    );
  }

  /*
   * 反向守卫：确认我们取到的确实是**生效**的那一组。
   * `ink-mid` 必须比 `ink-lo` 亮（层级顺序），否则取错了变量。
   */
  const lo = /--aq-ink-lo:\s*(#[0-9a-fA-F]{6})/.exec(CONSOLE)![1]!;
  assert.ok(
    contrast(mid, panel) > contrast(lo, panel),
    `★ 前提：ink-mid(${contrast(mid, panel).toFixed(3)}) 必须比 ink-lo(${contrast(lo, panel).toFixed(3)}) 亮 —— ` +
      '否则这条测的不是"最高那一级"',
  );
});
