/**
 * 模板选择的**唯一状态源**。
 *
 * ## 为什么不用 `useState` 放在 `App` 里
 *
 * 选模板这件事有三个互不相干的地方要读写：本模块（持久化）、`Layout`（渲染
 * 外壳）、设置页（选项卡片）。用 React state 就得一路 prop 透传，而"模板"是
 * 一个**全局的、跨路由的**设置 —— 和登录态同一类东西。放进 zustand，
 * 三处都能直接订阅。
 *
 * ## 为什么外面还套一层 `useSyncExternalStore`
 *
 * 不需要 —— zustand 本身就是外部 store，它的 `useStore` 就是
 * `useSyncExternalStore` 的封装。这里直接用它。
 */
import { create } from 'zustand';
import { getTemplate, listTemplates } from './registry';
import type { TemplateDefinition, TemplateId } from './types';

/**
 * 存储键。
 *
 * ⚠️ **这个字符串是两份代码之间的契约**：这里是唯一写入方，而
 * `index.html` 里那段内联脚本要在样式表生效**之前**把它读出来写到 `<html>`
 * 上（否则每次刷新都会先闪一下默认模板）。改这里必须同时改那段脚本。
 *
 * 用 `aq.appearance.v1` 而不是 `aq.template`：外观相关的设置（模板、
 * 亮暗、密度）以后会越来越多，它们应该有一个共同的前缀，将来一起迁移。
 * 带 `v1` 是为了将来结构变了还能分辨旧值。
 */
export const TEMPLATE_KEY = 'aq.appearance.v1';

/**
 * 从 localStorage 读初始值。
 *
 * 隐私模式 / 禁用存储时 `getItem` 会**抛异常**（不是返回 null），
 * 所以整段裹在 try 里 —— 这个函数在模块加载时就会执行，抛出去
 * 整个应用起不来。
 */
function readInitial(): TemplateId {
  try {
    const raw = window.localStorage.getItem(TEMPLATE_KEY);
    if (raw) {
      /*
       * 存的是一个 JSON 对象（见 `persist`），但也要能容忍**裸字符串** ——
       * 早期版本写的是纯文本 id，用户升级上来时那份值还在。
       * 不兼容的话表现是"我选的模板没了"，而没有任何报错。
       */
      const parsed: unknown = raw.startsWith('{') ? (JSON.parse(raw) as { template?: unknown })?.template : raw;
      if (typeof parsed === 'string' && parsed) return parsed;
    }
  } catch {
    /* 存储不可用 / 内容损坏 —— 用默认模板，不拦着应用启动。 */
  }
  return listTemplates()[0]!.id;
}

interface TemplateStore {
  /** 当前模板 id。 */
  id: TemplateId;
  /** 切换模板。会写 localStorage，并在同一个 tick 内更新 `<html>` 上的类。 */
  setId: (id: TemplateId) => void;
  /** 当前模板定义（永远拿得到 —— 未知 id 会回落到默认模板）。 */
  current: () => TemplateDefinition;
}

export const useTemplateStore = create<TemplateStore>((set, get) => ({
  id: readInitial(),
  setId: (id) => {
    set({ id });
    persist(id);
    applyTemplateClass(getTemplate(id));
  },
  current: () => getTemplate(get().id),
}));

/**
 * 把模板的根类名挂到 `<html>` 上。
 *
 * ## 为什么挂在 `<html>` 而不是最外层 `<div>`
 *
 * 挂在 `<div>` 上时，`body` 的背景、`::selection`、滚动条这些**不属于任何
 * 元素**的样式没法按模板区分（它们的宿主是 `html` / `body`）。而模板恰恰
 * 最需要控制的就是"整页底色是什么"。
 *
 * 同时把**上一套**模板的类摘掉：不摘的话两套模板的 CSS 会同时命中，
 * 表现是"颜色对了一半"—— 而且不会有任何报错。 */
export function applyTemplateClass(template: TemplateDefinition): void {
  const root = document.documentElement;
  for (const item of listTemplates()) {
    if (item.rootClass !== template.rootClass) root.classList.remove(item.rootClass);
  }
  root.classList.add(template.rootClass);
  root.dataset.template = template.id;
}

/**
 * 写盘。整体是一个 JSON 对象，给以后的外观设置留位置
 * （亮暗、密度将来也会挪进来）。
 */
function persist(id: TemplateId): void {
  try {
    window.localStorage.setItem(TEMPLATE_KEY, JSON.stringify({ template: id }));
  } catch {
    /* 存储被禁用：这一次选择只在当前会话有效，不弹错。 */
  }
}

/**
 * 启动时调用一次：把已保存的模板类挂上去。
 *
 * `index.html` 里的内联脚本已经做过（为了首帧不闪），这里是幂等的第二道
 * —— 万一内联脚本被 CSP 挡掉、或属性被别的脚本覆盖。
 */
export function applyStoredTemplate(): void {
  applyTemplateClass(getTemplate(useTemplateStore.getState().id));
}
