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

/* -------------------------------------------------------------------------- */
/*  ⑥ ★★★ 集合守卫：**每一个** ink 层级都必须有"达标"断言                          */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **这是"同型漏网"的元测试** —— 它不测某个颜色，它测"**这一组有没有被完整守住**"。
 *
 * ## 为什么需要它（两轮漏网的教训）
 *
 * | 轮次 | 组 | 被守住 | **漏网** |
 * | --- | --- | --- | --- |
 * | v0.1.22 | `modelsDev` 的 `X ? X : null` | `toolCall`、`canonicalId` | **`structuredOutput`** |
 * | v0.1.23 | console 文字三级 | `lo`、`faint` | **`mid`** |
 *
 * 两次都**不是"字段没人管"**，而是"**设计上是一组、测试只守了其中一部分**"。
 * 补上漏掉的那一个**并不能防止下一次**：有人加第六级、或者给某个主题加新层级时，
 * 还会漏。所以真正可复用的修法是 —— **钉住"这一组有哪些成员"**。
 *
 * ## 判据
 *
 * 从 CSS 里解析出**每个主题每个色块**声明的 ink 层级集合，断言：
 * 1. 该集合**非空**（解析没失效）；
 * 2. 每一个层级名都**在本文件里被 `contrast(...)` 断言过**（用源码文本检查）。
 *
 * ⚠️ 第 2 条用**源码文本检查**而不是运行时值 —— 因为要验的是
 * "**有没有人为这一级写过断言**"，那是**测试自身的覆盖面**，不是颜色值。
 * 这与 `configWiringGuard.test.ts` 的"每个配置字段都有读取点"是同一个思路。
 *
 * ⚠️ **`ink-strong` / `ink` 不要求达标**：它们是正文与强调文字（对比度天然很高），
 * 而这条守卫针对的是"**辅助文字**"那一组 —— 所以豁免名单要**显式列出并写明理由**，
 * 不是默默跳过。
 */
test('★★★ 每一个 ink 层级都必须有对比度断言 —— 防止再漏一级（同型漏网的元测试）', () => {
  /**
   * 不做达标断言、但**显式豁免**的层级（附理由）。
   *
   * ⚠️ 键是 **`主题.层级`**（与下面 `missing` 的格式一致），**不是**光一个层级名 ——
   * 光用层级名的话，将来某个主题新加一个**生效的** `ink-muted` 会被静默豁免掉，
   * 而那正是这条守卫要防的事。
   */
  const EXEMPT: ReadonlyMap<string, string> = new Map([
    ['classic.ink-strong', '强调文字，对比度天然很高（18.7）—— 不在"辅助文字"这一组里'],
    ['classic.ink', '正文色，对比度天然很高（15.6）—— 同上'],
    ['classic.ink-soft', '别名（`var(--aq-ink-mid)`），与 ink-mid 同值 —— 由 ink-mid 那条覆盖'],
    ['console.ink-strong', '同 classic：强调文字，对比度天然很高（14.8）'],
    ['console.ink', '同 classic：正文色（12.6）'],
    /*
     * ⚠️ console 的**旧命名**（`ink-muted` / `ink-dim`）—— 在同一选择器里
     * 定义得**更靠后的是新命名**（`ink-mid` / `ink-lo`），所以**旧命名不生效**。
     *
     * 它们不需要"达标"断言（值根本用不上），但**必须**有"与新命名同值"的断言。
     * ⚠️ 豁免的是"**达标**断言"，**不是**"一致性断言" —— 后者仍由
     * "两套命名必须一致"那条守着（见下面那条 ★★ 用例）。
     */
    ['console.ink-muted', '旧命名（不生效，新命名 ink-mid 覆盖）—— 由"两套命名同值"那条覆盖'],
    ['console.ink-dim', '旧命名（不生效，新命名 ink-lo 覆盖）—— 同上'],
    ['quill.ink-strong', '同 classic：强调文字（15.7）'],
    ['quill.ink', '同 classic：正文色（13.4）'],
    ['quill.ink-soft', '别名（`var(--aq-ink-mid)`）—— 由 ink-mid 那条覆盖'],
  ]);

  const self = readFileSync(new URL('./contrast.test.ts', import.meta.url), 'utf8');
  /*
   * ⚠️ 剥掉注释再找断言 —— 本文件顶部就引用了大量 token 名（含那些漏网的例子），
   * 不剥会让"注释里提过"被当成"断言过"。
   */
  const selfCode = self
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');

  const themes: Array<[string, string]> = [
    ['classic', INDEX],
    ['console', CONSOLE],
    ['quill', QUILL],
  ];

  const missing: string[] = [];
  let checked = 0;

  for (const [theme, css] of themes) {
    /* 该主题声明的全部 ink 层级（去重）。 */
    const levels = new Set<string>();
    for (const m of css.matchAll(/--aq-(ink(?:-[a-z]+)?):\s*#[0-9a-fA-F]{6}/g)) {
      levels.add(m[1]!);
    }

    /* 前置断言：每个主题都要解析出若干层级。 */
    assert.ok(
      levels.size >= 3,
      `★ ${theme} 只解析出 ${levels.size} 个 ink 层级 —— 解析可能失效了`,
    );

    for (const level of levels) {
      const key = `${theme}.${level}`;
      if (EXEMPT.has(key)) continue;
      checked += 1;
      /*
       * ⚠️ 判据：**这个层级名必须出现在某条 `contrast(...)` 断言里**。
       * 用"该 token 名 + contrast"同现来判定，而不是只找 token 名 ——
       * 因为 `theme.css` 的注释、以及"层级顺序"那条用例都会提到 token 名，
       * 而**提到 ≠ 断言达标**（`ink-mid` 就是这样漏掉的）。
       */
      const asserted = new RegExp(`contrast\\(\\s*${level.replace('-', '\\-')}\\b`).test(selfCode)
        /* 也接受"先取进变量、再断言变量"的写法（本文件的常见写法）。 */
        || new RegExp(`const\\s+\\w+\\s*=\\s*[^;]*--aq-${level}:`).test(selfCode);
      if (!asserted) missing.push(`${theme}.${level}`);
    }
  }

  /* 第二个前置断言：必须真的检查到若干项。 */
  assert.ok(
    checked >= 8,
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
