/**
 * 模板注册表。
 *
 * ## 加一套新模板
 *
 * 1. 建 `src/templates/<你的名字>/<YourShell>.tsx`，导出外壳组件；
 * 2. （可选）在 `src/templates/<你的名字>/theme.css` 里覆盖配色变量；
 * 3. 在下面的 `BUILT_IN` 里加一条。
 *
 * **不需要**动页面、路由、导航表或任何业务代码。
 *
 * ## 为什么要有一个注册表，而不是硬编码两个 if
 *
 * 硬编码意味着每加一套模板都要改 `Layout.tsx`，而它是并发改动最容易冲突的
 * 文件。注册表把"有哪些模板"和"外壳怎么渲染"彻底分开：加模板只碰这个文件
 * 和一个新目录。
 *
 * ## 这是静态数组，不是运行时的 Map
 *
 * 内置模板要参与 Vite 的静态分析（该打包的打包）。运行时注册是给插件式
 * 扩展留的口子，两条路并存。
 */
import type { TemplateDefinition, TemplateId } from './types';
import { ClassicShell } from './classic/ClassicShell';
import { ConsoleShell } from './console/ConsoleShell';
import { QuillShell } from './quill/QuillShell';

export const BUILT_IN: TemplateDefinition[] = [
  {
    id: 'classic',
    label: '经典',
    hint: '顶部导航 + 单列内容区。原版外观，页面动作就地显示。',
    rootClass: 'aq-classic',
    Shell: ClassicShell,
    ownsPalette: false,
  },
  {
    id: 'console',
    label: '控制台',
    hint: '桌面窗口外壳：标题栏 / 菜单栏 / 工具栏 / 侧栏 / 状态栏五层，页面动作统一收进工具栏。',
    rootClass: 'aq-console',
    Shell: ConsoleShell,
    ownsPalette: true,
  },
  {
    id: 'quill',
    label: '静谧',
    hint: '中性克制的桌面工具外观：左侧分组侧栏 + 分段控件双层导航，选中态用浮起而不是上色，深 / 浅两套主题。',
    rootClass: 'aq-quill',
    Shell: QuillShell,
    ownsPalette: true,
  },
];

/** 运行时注册的额外模板（插件 / 第三方）。 */
const extra = new Map<TemplateId, TemplateDefinition>();

/*
 * 注册一套模板。
 *
 * 给"不想 fork 仓库、只想插一套皮肤"的场景用：宿主在启动时调用它，
 * 之后这个 id 就能出现在设置页里。
 *
 * 注意：**同名会覆盖内置模板**（语义见 `listTemplates()` 里那段 —— 代码与
 * 这条文档一度不符，是修过的）。这是故意的：允许下游整体替换内置实现。
 * 但如果你想加的是**新**模板，请用一个不与内置冲突的 id；
 * 来自 `templates/<目录>/` 的自动注册会**跳过**内置 id（见 `themes.ts`），
 * 因为那种情况下自动推出来的 label 会盖掉人写的 label。
 */
export function registerTemplate(definition: TemplateDefinition): void {
  extra.set(definition.id, definition);
}

/**
 * 全部可用模板。内置在前，运行时注册的新模板追加在后面。
 *
 * ## ⚠️ 为什么这里必须是 Map 的语义，不能"先到先得"
 *
 * 第一版写的是遍历 `[...BUILT_IN, ...extra.values()]` 并用 `Set` 去重 ——
 * 那等于**内置赢**。而 `registerTemplate()` 的文档写着"同名会覆盖内置模板，
 * 这是故意的"。**代码和文档对不上，而且没有任何报错**：下游想替换内置实现
 * 时他的定义被静默丢弃，界面上一切正常、只是"改了没效果"。
 *
 * 按 Map 合并就三件事同时成立：
 *
 *   1. id 不重复（设置页上不会出现两张一样的卡）；
 *   2. 同名真能覆盖（`Map.set` 覆盖值），文档说的就是它；
 *   3. 顺序稳定：内置排在自己原来的位置，不会因为被覆盖就跳到末尾
 *      —— 设置页上卡的顺序在切换时不该跳。
 */
export function listTemplates(): TemplateDefinition[] {
  const merged = new Map<TemplateId, TemplateDefinition>();
  for (const item of BUILT_IN) merged.set(item.id, item);
  for (const item of extra.values()) merged.set(item.id, item);
  return [...merged.values()];
}

/** id 不存在时的兜底：保证界面永远能渲染出来。 */
export const FALLBACK_TEMPLATE: TemplateDefinition = BUILT_IN[0]!;

/**
 * 按 id 取模板。
 *
 * ⚠️ **未知 id 不抛异常，回落到默认模板。** 这条很重要：模板 id 存在用户的
 * localStorage 里，而下游删掉一套模板、或用户从别人的分支切回来时，
 * 那个 id 就成了孤儿。抛异常的表现是**整个应用白屏**，而用户根本不知道
 * 自己该做什么 —— 回落到默认模板只是"外观变回去了"，他能自己再选一次。
 */
export function getTemplate(id: TemplateId): TemplateDefinition {
  return listTemplates().find((item) => item.id === id) ?? FALLBACK_TEMPLATE;
}
