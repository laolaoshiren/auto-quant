/**
 * 模板图标。
 *
 * ## 为什么单独一个文件
 *
 * 同一个 id → 同一个图标要在**两处**出现：外观页的模板卡（大）、顶栏切换器的
 * 触发按钮与菜单项（小）。各自写一份 `Record` 的代价不是重复几行，而是
 * **两处会漂**：新加一套模板只在其中一处注册，另一处就悄悄用回默认图标 ——
 * 界面上完全正常，只是"那个模板的图标怎么跟别的一样"。
 *
 * 它不放在 `registry.ts` 里：那个文件必须保持**纯数据**（不 import 任何
 * 渲染相关的东西），这样它才能在 Node 里被直接单测。图标来自 `lucide-react`，
 * 属于渲染层。
 *
 * ## UI 收敛之后只剩内置的 `quill`
 *
 * 2026-11-10 把三套收敛成一套（见 `registry.ts` 顶部）。这张表仍然保留：
 * 第三方模板通过 `registerTemplate()` / 目录自动发现进来时，可以在这里补一个
 * 图标；没登记的走兜底。
 *
 * 兜底图标是 `PanelsTopLeft`（一个"面板"的中性形状），不是某一个具体模板的
 * 图标：第三方模板没登记图标时，它应该看起来"还没配图"，而不是看起来像内置模板。
 */
import { PanelLeft, PanelsTopLeft } from 'lucide-react';

export type TemplateIconComponent = typeof PanelLeft;

const TEMPLATE_ICON: Record<string, TemplateIconComponent> = {
  /*
   * quill 的骨架是「左侧分组侧栏 + 分段控件」，`PanelLeft` 正好画的是
   * "左边一栏 + 右边内容" —— 图标表存在的意义就是让外观页的卡片一眼能
   * 看出那套模板长什么样，所以挑的是形状而不是隐喻。
   */
  quill: PanelLeft,
};

export function templateIcon(id: string): TemplateIconComponent {
  return TEMPLATE_ICON[id] ?? PanelsTopLeft;
}
