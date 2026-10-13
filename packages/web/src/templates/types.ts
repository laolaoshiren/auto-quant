/**
 * 模板系统的**公开契约**。
 *
 * ## 这套东西是干什么的
 *
 * 界面外壳（导航长什么样、窗口怎么排、颜色是什么）和业务页面（表格、表单、
 * 图表）是两件事。原来它们缠在一起：想换一套外壳，就得改 `Layout.tsx`、
 * 改 `nav.ts`、改一堆页面里"动作放哪"的写法。
 *
 * 现在拆开了：
 *
 *   · **页面**（`src/pages/*`）只描述"这一页有什么"，不决定"它在屏幕上放哪"；
 *   · **模板**（`src/templates/<名字>/`）只描述外壳与配色，不含任何业务逻辑；
 *   · 两者之间的接口就是这个文件。
 *
 * ## 想加一套自己的模板？只需要两件事
 *
 * ```tsx
 * // src/templates/mytheme/MyShell.tsx
 * export function MyShell() {
 *   const s = useShellState();      // 外壳需要的全部数据，都在这儿
 *   return (
 *     <div className="my-root">
 *       <my-header>…</my-header>
 *       <main id={MAIN_SCROLL_ID}><Outlet /></main>
 *       // ⚠️ 命令面板与 toast **不在这里** —— ShellRuntime 已经渲染了（见 §3 ③）
 *     </div>
 *   );
 * }
 * ```
 *
 * 然后把它注册进 `registry.ts`。**不需要**改任何页面、不需要复制业务代码、
 * 不需要重写导航表 —— 数据、路由、动作、命令面板、推送连接全都在下面这些
 * 接口里给好了。
 *
 * ## 三条必须遵守的约束
 *
 * 1. **内容区必须有 id = `MAIN_SCROLL_ID` 并且是真正的滚动容器。**
 *    页面里有些功能（帮助页的目录跟随高亮）靠这个 id 找滚动容器 ——
 *    找不到时它们**静默失效**，页面看起来毫无异常。
 * 2. **工具栏挂载点要有 id = `TOOLBAR_START_ID`（以及 `TOOLBAR_END_ID`）。**
 *    它们定义在 `./ids`，**不要**手写字符串字面量：`PageActions` 查的就是
 *    那两个常量，写错一个字母的表现是"按钮留在页面里"而不是报错。
 *    页面用 `<PageActions>` 把「刷新 / 新建」这类动作投进来。没有这两个挂载
 *    点的模板会退化成"动作就地显示"（`PageActions` 的兜底），功能不会丢，
 *    但布局就不是你能控制的了。
 * 3. **不要自己渲染 `<Toaster />` 或调用 `useEvents().connect()`。**
 *    它们由外壳调度统一处理（见 `Layout.tsx`），模板重复做会导致 toast 出两次、
 *    或 WebSocket 被连上两条。
 */

import type { ComponentType } from 'react';
import type { NavGroup, NavItem } from '../components/nav';
import type { ShellData } from './lib/useShellData';

/*
 * 三个挂载点常量在这里**再导出**一次，让"写一套模板"只需要记住一个 import
 * 路径（`templates/types`）。它们真正的定义在 `./ids` —— 页面也依赖那份，
 * 见那个文件顶部关于双向依赖的论证。
 */
export { MAIN_SCROLL_ID, TOOLBAR_END_ID, TOOLBAR_START_ID } from './ids';

/*
 * 读外壳数据的那把钩子也在这里再导出，理由同上：模板作者应该只需要 import
 * `templates/types` 一处。
 *
 * ⚠️ 这是**运行时**导出（不是 `import type`），所以它把 `lib/context.tsx`
 * 拉进了任何 import 本文件的模块图里 —— 这正是 `registry.ts` 刻意不 import
 * 本文件（只用 `import type`）的原因，见那个文件顶部的注释：Node 里跑注册表
 * 时必须避开 React 组件图。
 */
export { useShell } from './lib/context';

/**
 * 模板 id。
 *
 * 用 `string` 而不是联合字面量：第三方模板通过 `registerTemplate()` 在运行时
 * 注册，编译器不可能提前知道它们叫什么。内置的两个是 `'classic'` 与 `'console'`。
 */
export type TemplateId = string;

/**
 * 一套模板。
 *
 * `Shell` 是唯一必须实现的东西。它渲染整个外壳（含 `<Outlet />`），
 * 页面内容由路由器注进去 —— 见 `Layout.tsx` 的 `TemplateHost`。
 */
export interface TemplateDefinition {
  /** 稳定标识。存进 localStorage，**不要**在发布后改它，改了等于把用户的设置清空。 */
  id: TemplateId;
  /** 设置页上显示的短名（两到四个字）。 */
  label: string;
  /** 一句话说明这套模板适合什么场景。显示在设置页的卡片上。 */
  hint: string;
  /**
   * 需要挂到 `<html>` 上的类名。
   *
   * 模板自己的 CSS 全部挂在这个类下面（例如 `.aq-console .panel { … }`），
   * 这样多套模板的样式可以同时存在于一个 bundle 里而互不干扰 ——
   * **切换模板不需要重新加载页面，也不需要重新构建**。
   */
  rootClass: string;
  /** 外壳组件。渲染导航 + 内容区 + 命令面板。 */
  Shell: ComponentType;
  /**
   * 是否由模板自己管理配色（覆盖 CSS 变量）。
   *
   * `false` = 用 `index.css` 里 `:root` 的默认色板（也就是原版配色）。
   * 内置的 `classic` 是 `false`，`console` 是 `true`。
   */
  ownsPalette: boolean;
}

/**
 * 外壳组件能拿到的全部东西。由 `useShell()` 提供（见 `lib/context.tsx`）。
 *
 * 这是模板作者需要读的**唯一**一份文档：想要什么数据、想触发什么行为，
 * 都在这里；不在的东西说明它不该由外壳管。
 */
export interface ShellState extends ShellData {
  /** 导航表：扁平的全部项（命令面板、抽屉用）。 */
  navItems: NavItem[];
  /** 导航表：分组的（侧栏 / 菜单栏用）。 */
  navGroups: NavGroup[];
  /** 退出登录并跳回登录页。 */
  signOut: () => void;
  /** 命令面板的开关。外壳负责渲染触发按钮，状态由这里给。 */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /**
   * 模板选择的**运行时视图**：当前是哪一套、有哪些套、怎么换。
   *
   * ## 为什么它挂在 context 上，而不是让顶栏直接去 import store
   *
   * `templates/store.ts` 在**模块求值时**就要读 localStorage 拿初始值，
   * 而那条路径要经过 `registry.ts`。于是任何被注册表静态 import 的文件
   * （也就是每一套外壳）一旦反过来 import store，就形成
   *
   *     store → registry → 外壳 → （外壳引用到的东西）→ store
   *
   * 的环。它在**模块求值期**闭合时是真的会炸的：`registry.ts` 会撞上
   * `Cannot access 'BUILT_IN' before initialization`，整个应用白屏 ——
   * 而不是某一块功能不工作。顶栏上的模板切换器差一点就踩中它。
   *
   * 所以外壳**不读全局 store**：数据由 `Layout` 通过 context 递下来。
   * 这也是 `lib/context.tsx` 本来就写明的分工 ——「模板只管画；需要数据就读
   * context，需要触发行为就调 context 里的函数」。
   */
  templateId: TemplateId;
  setTemplateId: (id: TemplateId) => void;
  /** 全部可用模板（内置 + 运行时注册），与「外观」页用的是同一份列表。 */
  templates: TemplateDefinition[];
}
