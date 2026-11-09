import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { TOOLBAR_END_ID, TOOLBAR_START_ID } from '../ids';

/**
 * 页面动作的**统一接口**。
 *
 * ## 它解决什么问题
 *
 * 原来每个页面自己决定「刷新」「新建」这些按钮长在哪：有的塞在标题行右边，
 * 有的放在面板头的 `actions` 槽里，还有的在表格上方单独一行。后果是同一类动作
 * 在不同页面上出现在不同高度、不同位置，而每加一套外壳就要把所有页面再改一遍。
 *
 * 现在页面只说**有什么动作**，不说它**放哪**：
 *
 * ```tsx
 * <PageActions
 *   start={<Button onClick={reload}>刷新</Button>}
 *   end={<Button variant="primary" onClick={create}>新建</Button>}
 * />
 * ```
 *
 * 至于这两个槽最后出现在哪，由模板决定：
 *
 *   · **控制台模板**渲染了工具栏挂载点 → 动作被 portal 进那条 40px 的带子，
 *     位置固定、永远可见、危险动作在最右；
 *   · **经典模板**没有工具栏 → 动作**就地渲染**（`inline` 那个位置），
 *     也就是页面把它写在哪儿它就出现在哪儿。
 *
 * ⚠️ **两条路径都必须能跑，缺一个就是"换模板丢功能"。** 所以这里不是
 * "有挂载点就 portal、没有就渲染到别处" —— 没有挂载点时它渲染的是**同样的
 * 那批按钮**，只是位置由页面决定。
 *
 * ## 就地渲染时**不加包裹层**（这一条踩过）
 *
 * 经典模板没有工具栏，那时这一段渲染的是 `<>{start}{end}</>` —— 直接成为
 * **调用方那个容器**的 flex 子项，而不是自己再套一层 `flex`。
 *
 * 套一层会改掉原版的外观：本仓库里 `<PageActions>` 的落点几乎都是
 * `SectionHeading` 的 `right` 槽或 `Panel` 的 `actions` 槽，那些容器自己
 * 已经是 `flex items-center gap-x`。多一层 `flex flex-wrap gap-1.5` 会把
 * 间距从 `gap-2` 变成 `gap-1.5`、并且多出一个换行断点 —— **页面上只是
 * "有点不一样"，谁也不会去查**。而这套改造的底线是"原版逐字不动"。
 *
 * 代价是：单独用 `PageActions` 且不给容器的调用方，得自己保证它落在
 * 一个有 flex 的父元素里。这是刻意的取舍 —— 它服务的第一目标是**不改变
 * 原版**，不是"在哪都能用"。
 *
 * ## 为什么用 `start` / `end` 两个槽而不是 `children`
 *
 * 破坏性动作必须**永远在最右**。混在一个数组里迟早被误点，而"最右"这件事
 * 不该由每个页面自己记得（`end` 里的动作在两种模板下都靠右）。
 */
/*
 * 两个槽的 id 定义在 `templates/ids.ts` —— 模板要渲染它们、页面要查它们，
 * 而这两边不该互相 import（见那个文件顶部的论证）。这里只是把名字再导出
 * 一次，让"用动作接口"的人只需要记住一个 import 路径。
 */
export { TOOLBAR_END_ID, TOOLBAR_START_ID };

export function PageActions({
  start,
  end,
}: {
  /** 普通动作：刷新、筛选、导出。 */
  start?: ReactNode;
  /** 主操作 / 危险动作：新建、保存、删除。永远靠右。 */
  end?: ReactNode;
}) {
  const [hosts, setHosts] = useState<{ start: HTMLElement | null; end: HTMLElement | null } | null>(null);

  /*
   * 挂载点在**父组件**里渲染（模板渲染工具栏，页面渲染动作），而页面是
   * 在同一个 commit 里先渲染完的 —— 所以拿挂载点必须等到 DOM 提交之后。
   *
   * ⚠️ **必须是 `useLayoutEffect`，不能是 `useEffect`。**
   *
   * 这里容易想当然："工具栏本来就是后画的，晚一帧没关系"。但那一帧里
   * 状态是 `hosts = null`，也就是**走了就地渲染那条分支** —— 动作按钮会先
   * 出现在页面里，然后才被搬进工具栏。`useEffect` 跑在浏览器绘制**之后**，
   * 所以用户真的会看到按钮从页面里跳到工具栏上（每次进页面跳一次）。
   * `useLayoutEffect` 跑在绘制之前，同样的两次渲染只会合成一次可见结果。
   *
   * 代价是它在服务端渲染时会告警 —— 而本应用是纯客户端 SPA
   * （`main.tsx` 里 `createRoot`），没有 SSR 路径。
   */
  useLayoutEffect(() => {
    setHosts({
      start: document.getElementById(TOOLBAR_START_ID),
      end: document.getElementById(TOOLBAR_END_ID),
    });
  }, []);

  /*
   * 没有挂载点 = 当前模板不吃这套 → **就地渲染**。
   *
   * 这一段是"经典模板还能用"的关键：它没有工具栏，如果这里直接 return null，
   * 换回经典模板之后所有页面的动作会**全部消失**，而页面本身看起来完全正常。
   *
   * 不加包裹层：直接成为调用方容器的 flex 子项（理由见文件顶部那段）。
   */
  if (!hosts?.start) {
    if (!start && !end) return null;
    return (
      <>
        {start}
        {end}
      </>
    );
  }

  return (
    <>
      {start && createPortal(start, hosts.start)}
      {end && hosts.end && createPortal(end, hosts.end)}
    </>
  );
}
