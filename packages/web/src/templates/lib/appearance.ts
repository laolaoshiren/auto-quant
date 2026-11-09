/**
 * 亮暗主题 + 界面密度。与模板是**正交**的两件事：
 *
 *   · **模板**决定骨架（导航在哪、有没有工具栏、窗口是不是浮着）；
 *   · **亮暗**决定配色；**密度**决定表格行高。
 *
 * 一个模板可以同时支持亮暗（`console` 模板就是这样），也可以自己定死一种
 * （`classic` 模板只有深色）。这两件事混在一起之后，"换个深色版"就会变成
 * "换一套模板"，那是不必要的重复。
 *
 * ## ⚠️ 键名是两份代码之间的契约
 *
 * 这里读写的两个键，`index.html` 的同步内联脚本也要读（它负责在样式表
 * 生效之前把属性写到 `<html>` 上，否则每次刷新都会先闪一下另一种配色）。
 * **改这里必须同时改那段脚本** —— 不一致的表现是"设置存下来了，但下次
 * 打开又回到默认"，不会有任何报错。
 */
export const SKIN_KEY = 'aq.skin';
export const DENSITY_KEY = 'aq.density';

/** 模板切换 / 密度切换时派发的事件名（图表用它重新取色）。 */
export const APPEARANCE_EVENT = 'aq:appearance';

export type Skin = 'dark' | 'light';
export type Density = 'compact' | 'normal' | 'cozy';

export const DEFAULT_SKIN: Skin = 'dark';
export const DEFAULT_DENSITY: Density = 'normal';

export const SKINS: Array<{ id: Skin; label: string; hint: string }> = [
  { id: 'dark', label: '深色', hint: '默认。夜盘与长时间盯盘用这一套，屏幕不会变成一块光源。' },
  { id: 'light', label: '浅色', hint: '白天在强光环境下更清楚。面板是灰白而不是纯白，不刺眼。' },
];

export const DENSITIES: Array<{ id: Density; label: string; hint: string }> = [
  { id: 'compact', label: '紧凑', hint: '表格行 24px —— 同屏最多行，适合看长列表。' },
  { id: 'normal', label: '标准', hint: '表格行 26px。默认。' },
  { id: 'cozy', label: '宽松', hint: '表格行 32px —— 触摸屏或需要更大点击目标时用。' },
];

/**
 * 某个主题选项在当前模板下是否**真的会生效**。
 *
 * ## 这个函数为什么存在（外部 issue #171）
 *
 * 浅色主题是靠 CSS 属性选择器实现的，而**只有 `console` 与 `quill` 写了那套规则**：
 *
 * ```
 * html.aq-console[data-skin='light'] { … }   ← console/theme.css:210
 * html.aq-quill[data-skin='light']   { … }   ← quill/theme.css:215
 * ```
 *
 * `classic/` 目录下 `skin` 零命中 —— 它的定位是"原版外观"，固定深色。
 * 但外观页把「深色 / 浅色」两张卡**原样展示给所有模板**，于是 classic 用户点
 * 「浅色」会：
 *
 *   · 写进 localStorage（设置确实存下来了）
 *   · `<html>` 上写上 `data-skin="light"`（属性也写对了）
 *   · 按钮显示为**已选中**（带勾）
 *   · **而界面一个像素都不变**
 *
 * 这是本仓库反复修过的那类"设置存下来但不生效、且不报任何错"。原来的处理是
 * 在页面底部小字里加一句「经典模板只有深色……切了不会坏，只是看不出来」——
 * 但那是**点击之后**才可能读到的说明，按钮本身仍然承诺"这会生效"。
 *
 * ## 为什么用显式声明而不是复用 `ownsPalette`
 *
 * `ownsPalette` 的语义是"这套模板是否覆盖 CSS 变量"，而"支持几套主题"是**另一件事**
 *（一套模板可以自带配色但只有深色）。拿前者当后者的代理，将来加模板时两者一旦
 * 不同步，就会重现同一类静默失效 —— 所以这里要一个语义精确的独立声明。
 */
export function isSkinSupported(
  supported: readonly Skin[] | undefined,
  skin: Skin,
): boolean {
  /* 没声明 = 不做限制（第三方模板不必知道这个字段）。 */
  if (!supported || supported.length === 0) return true;
  return supported.includes(skin);
}

/**
 * 当前模板下**不生效**的主题选项（用于在界面上把它们标出来/禁用掉）。
 *
 * 返回空数组 = 全部生效（正常情况）。
 */
export function unsupportedSkins(
  supported: readonly Skin[] | undefined,
  all: readonly Skin[] = SKINS.map((s) => s.id),
): Skin[] {
  if (!supported || supported.length === 0) return [];
  return all.filter((s) => !supported.includes(s));
}


function readKey<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
  } catch {
    /* 隐私模式会抛异常 —— 用默认值继续。 */
  }
  return fallback;
}

export function getSkin(): Skin {
  return readKey(SKIN_KEY, ['dark', 'light'] as const, DEFAULT_SKIN);
}

export function getDensity(): Density {
  return readKey(DENSITY_KEY, ['compact', 'normal', 'cozy'] as const, DEFAULT_DENSITY);
}

/**
 * 写属性 + 存盘 + **派发事件**。
 *
 * 派发事件是因为图表拿不到 CSS 变量：canvas 与 SVG 的 `stroke` 需要**当时
 * 算好的字面量**（见 `equityCurve.ts`）。图表订阅这个事件，切配色时重绘一次。
 * 不派发的话图表会一直用着上一次的颜色 —— 而它看起来只是"颜色有点怪"。
 */
export function setSkin(skin: Skin): void {
  document.documentElement.dataset.skin = skin;
  writeKey(SKIN_KEY, skin);
  emit();
}

export function setDensity(density: Density): void {
  document.documentElement.dataset.density = density;
  writeKey(DENSITY_KEY, density);
  emit();
}

function writeKey(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 存储被禁用：这一次选择只在当前会话有效。 */
  }
}

function emit(): void {
  window.dispatchEvent(new Event(APPEARANCE_EVENT));
}

/**
 * 启动时调用一次：把已保存的亮暗与密度写回 `<html>`。
 *
 * 幂等 —— `index.html` 的内联脚本已经做过一次了。
 */
export function applyStoredAppearance(): void {
  const root = document.documentElement;
  root.dataset.skin = getSkin();
  root.dataset.density = getDensity();
}
