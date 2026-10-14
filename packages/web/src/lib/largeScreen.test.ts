/**
 * **大屏适配：窗口不该在 2K/4K 上封死**（外部 issue #173）。
 *
 * ## 缺陷（issue 的实测）
 *
 * console 模板把界面装在一个模拟桌面窗口里，尺寸写死：
 *
 * ```css
 * html.aq-console .win { max-width: 1720px; max-height: 1080px; }
 * ```
 *
 * 于是 **2560 与 3840 两个视口下窗口一模一样**（实测内容区都是 1533px）：
 *
 * | 视口 | console | classic |
 * | --- | --- | --- |
 * | 2560×1440 | 1533px（封顶） | 2560px |
 * | 3840×2160 | **1533px（封顶）** | 3628px |
 *
 * 4K 屏上窗口面积只占约 25%，多出来的屏幕全成了背景 —— 而机器人列表、
 * 日志流、决策 feed 都是**越长越有用**的列表。而且没有"放大 / 全屏"的出口。
 *
 * ## ⚠️ 为什么测试是"源码 + 数值"而不是渲染断言
 *
 * `packages/web` 没有 jsdom / React Testing Library（只跑 `tsx --test src/**\/*.test.ts`），
 * 所以无法真渲染。这里改为：
 *
 *   1. **数值断言** —— 用同一套公式算出各视口下的窗口尺寸，钉住"大屏必须跟着长"
 *      与"小屏不溢出"两边；
 *   2. **源码结构断言** —— 确认 CSS 里真的是 `clamp(...)`，且没退回写死 px
 *      或退化成单边 `max()`（那会在小屏溢出）。
 *
 * ⚠️ 断言前**剥掉 CSS 注释** —— 这个仓库的注释会逐字引用被讨论的代码
 *（本次就引用了 `max-width: 1720px` 与 `width: min(...)` 作为反例），
 * 不剥注释会让判据被自己的注释命中。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CONSOLE_CSS = readFileSync(
  new URL('../templates/console/theme.css', import.meta.url),
  'utf8',
);

/** 去掉 CSS 注释 —— 见文件头的说明。 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const CODE = stripCssComments(CONSOLE_CSS);

/** 取 `.win` 规则体（第一个匹配，即基础那条）。 */
function winRule(): string {
  const m = /html\.aq-console\s+\.win\s*\{([^}]*)\}/.exec(CODE);
  assert.ok(m, '找不到 `html.aq-console .win` 规则 —— 结构变了，请更新本测试');
  return m[1]!;
}

/** 从声明里取某个属性的值。 */
function decl(body: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(body);
  return m ? m[1]!.trim() : null;
}

/* -------------------------------------------------------------------------- */
/*  ① 源码：必须是 clamp(下限, 视口比例, 上限)                              */
/* -------------------------------------------------------------------------- */

test('★★★ `.win` 的尺寸上限必须随视口增长 —— 不能写死 1720×1080', () => {
  const body = winRule();
  const maxWidth = decl(body, 'max-width');
  const maxHeight = decl(body, 'max-height');

  assert.ok(maxWidth, '找不到 `max-width`');
  assert.ok(maxHeight, '找不到 `max-height`');

  assert.notEqual(
    maxWidth,
    '1720px',
    '★★★ `max-width` 还是写死的 1720px —— 2560/3840 下窗口不会变（issue #173）',
  );
  assert.notEqual(
    maxHeight,
    '1080px',
    '★★★ `max-height` 还是写死的 1080px —— 4K 下窗口只占约 25% 面积',
  );

  assert.match(
    maxWidth,
    /clamp\(\s*\d+px\s*,\s*\d+vw\s*,\s*\d+px\s*\)/,
    '★★★ 应当是 `clamp(下限px, 比例vw, 上限px)` —— 小屏不溢出、大屏跟着视口长',
  );
  assert.match(
    maxHeight,
    /clamp\(\s*\d+px\s*,\s*\d+vh\s*,\s*\d+px\s*\)/,
    '★★★ 高度同理',
  );
});

test('★★★ 不能只用 max(px, vw) —— 小屏下下限大于视口会让窗口【溢出】', () => {
  /*
   * ⚠️ 这条是我第一版的**真实缺陷**，被下面"1280 下窗口必须小于视口"那条当场抓住：
   *
   *   max-width: max(1720px, 96vw)  → 1280 视口下算出 1720 > 1280 ⇒ 窗口溢出
   *
   * 而 `min(2400px, 96vw)`（issue 里建议的那个）走到另一个极端：4K 下仍封在
   * 2400px（只占 62%），"大屏用满"没有真正达成。所以必须 `clamp` —— 两头都约束。
   */
  assert.doesNotMatch(
    decl(winRule(), 'max-width')!,
    /^\s*max\(/,
    '★★★ 只写 max(px, vw) 会在小屏溢出；只写 min() 会在 4K 提前封顶 —— 用 clamp',
  );
});

test('★★★ 不得用带【百分比】的 min() —— 那是布局塌陷', () => {
  /*
   * `.app-root` 是 `place-items: center` 的 grid，`.win` 是它的子项。
   * 用百分比时 `%` 相对包含块，而包含块尺寸又取决于子项 → **互相依赖** →
   * 浏览器算成 0 宽。那是**布局塌陷**：不报错，页面上只看到窗口不见了。
   *
   * `vw`/`vh` 相对视口，不参与那个循环，所以 `clamp(px, vw, px)` 是安全的。
   */
  assert.doesNotMatch(
    winRule(),
    /min\([^)]*%/,
    '★★★ 不能在 `.win` 上用带百分比的 `min()` —— 会塌陷成 0 宽（见规则上方的注释）',
  );
});

/* -------------------------------------------------------------------------- */
/*  ② 数值：大屏必须真的长大、小屏必须不溢出                                    */
/* -------------------------------------------------------------------------- */

/** 解析 `clamp(下限px, 比例vw|vh, 上限px)` 的数值。 */
function parseClamp(value: string, unit: 'vw' | 'vh'): { min: number; ratio: number; max: number } {
  const m = new RegExp(`clamp\\(\\s*(\\d+)px\\s*,\\s*(\\d+)${unit}\\s*,\\s*(\\d+)px\\s*\\)`).exec(value);
  assert.ok(m, `无法解析 clamp：${value}`);
  return { min: Number(m[1]), ratio: Number(m[2]), max: Number(m[3]) };
}

/** 复刻 `clamp(下限, 比例, 上限)` 的计算。 */
function clampSize(view: number, rule: { min: number; ratio: number; max: number }): number {
  return Math.min(rule.max, Math.max(rule.min, (view * rule.ratio) / 100));
}

test('★★★ 4K（3840×2160）下窗口面积必须远大于 2K —— 不能再"两个视口一模一样"', () => {
  const body = winRule();
  const w = parseClamp(decl(body, 'max-width')!, 'vw');
  const h = parseClamp(decl(body, 'max-height')!, 'vh');

  const at2k = { w: clampSize(2560, w), h: clampSize(1440, h) };
  const at4k = { w: clampSize(3840, w), h: clampSize(2160, h) };

  assert.ok(
    at4k.w > at2k.w,
    `★★★ 4K 的窗口宽(${at4k.w.toFixed(0)}) 必须大于 2K(${at2k.w.toFixed(0)}) —— ` +
      'issue #173 的实测里两者一模一样（可用宽都是 1533px）',
  );
  assert.ok(
    at4k.w >= 3840 * 0.9,
    `★★★ 4K 下窗口应至少占屏宽 90%，实际 ${((at4k.w / 3840) * 100).toFixed(1)}%`,
  );
  assert.ok(
    at4k.h >= 2160 * 0.9,
    `★★★ 4K 下窗口应至少占屏高 90%，实际 ${((at4k.h / 2160) * 100).toFixed(1)}%`,
  );
});

test('★★★ 小屏不得溢出：1280 / 1600 / 1920 下窗口必须 ≤ 视口', () => {
  /*
   * ⚠️ 这是第一版 `max(1720px, 96vw)` 栽的地方：1280 视口下算出 1720，窗口比屏幕还宽。
   * 溢出是**布局塌陷**的一种，页面上表现为横向滚动条 + 右侧内容被切掉。
   */
  const w = parseClamp(decl(winRule(), 'max-width')!, 'vw');
  for (const view of [1280, 1366, 1600, 1920]) {
    const size = clampSize(view, w);
    assert.ok(
      size <= view,
      `★★★ ${view} 宽视口下窗口算出 ${size.toFixed(0)}px —— 比视口还宽，会溢出`,
    );
  }
});

test('★★ 1280 下仍留背景边 —— "窗口浮在桌面上"的立意不能丢', () => {
  const w = parseClamp(decl(winRule(), 'max-width')!, 'vw');
  const at720p = clampSize(1280, w);
  assert.ok(
    at720p < 1280,
    `★★ 1280 宽下窗口(${at720p.toFixed(0)}) 必须小于视口 —— 否则窗口感没了`,
  );
});

test('★★ 单调不减 —— 视口变大时窗口不能反而变小', () => {
  /*
   * 反向守卫：`clamp` 的上下限写错时（例如 max < min）会出现"视口更大、窗口更小"
   * 这种反直觉跳变。逐个视口检查单调性。
   */
  const body = winRule();
  const w = parseClamp(decl(body, 'max-width')!, 'vw');
  const h = parseClamp(decl(body, 'max-height')!, 'vh');

  const viewports: Array<[number, number]> = [
    [1280, 720],
    [1600, 1000],
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
  ];
  for (let i = 1; i < viewports.length; i += 1) {
    const prev = viewports[i - 1]!;
    const curr = viewports[i]!;
    const prevW = clampSize(prev[0], w);
    const currW = clampSize(curr[0], w);
    const prevH = clampSize(prev[1], h);
    const currH = clampSize(curr[1], h);
    assert.ok(currW >= prevW, `★★ 视口 ${prev[0]}→${curr[0]} 时窗口宽变小了`);
    assert.ok(currH >= prevH, `★★ 视口高 ${prev[1]}→${curr[1]} 时窗口高变小了`);
  }
});

test('★ 上限与下限的数值本身必须合法（max > min，比例在 (0, 100]）', () => {
  const body = winRule();
  const w = parseClamp(decl(body, 'max-width')!, 'vw');
  const h = parseClamp(decl(body, 'max-height')!, 'vh');
  for (const [label, r] of [
    ['max-width', w],
    ['max-height', h],
  ] as const) {
    assert.ok(r.max > r.min, `★ ${label} 的上限必须大于下限`);
    assert.ok(r.ratio > 0 && r.ratio <= 100, `★ ${label} 的比例必须在 (0, 100]`);
    /* 比例 < 100 表示"四周留背景边" —— 那是这套模板的立意。 */
    assert.ok(r.ratio < 100, `★ ${label} 的比例应 < 100，留出背景边`);
  }
});

test('★ 窄屏（≤56em）仍然全屏铺满 —— 既有的响应式行为不能被破坏', () => {
  /*
   * 既有代码在 `@media (max-width: 56em)` 里把 `.win` 的上下限都设成 `none`。
   * 修大屏时**不能**碰那一段 —— 否则窄屏会重新出现窗口边。
   */
  const narrow = /@media\s*\(max-width:\s*56em\)\s*\{([\s\S]*?)\n\}/.exec(CODE);
  assert.ok(narrow, '找不到 `@media (max-width: 56em)` 块');
  assert.match(
    narrow[1]!,
    /html\.aq-console\s+\.win\s*\{[^}]*max-width:\s*none/,
    '★ 窄屏下 `.win` 必须 `max-width: none`（全屏铺满）',
  );
});
