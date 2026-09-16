/**
 * 旧入口 `/settings`。
 *
 * 这里过去用标签页装了三块设置，现在它们各自是侧栏上的一级页面，所以老书签与
 * 外部链接统一转到模型页，而不是撞进 404。**保持重定向**（不改成一个空壳包装页）
 * 是有意的：这一屏没有自己的内容，硬做成页面只会多一个"点进来又得再点一次"的空壳。
 *
 * 因此这里**没有 `SectionHeading`**：本页不渲染任何内容，标题无处可挂；
 * 加一个标题意味着要先造一个空页面，正好是上面那段要避免的事。
 * 页面级标题由重定向的目标页（模型页）负责。
 */
import { Navigate } from 'react-router-dom';

export function SettingsPage() {
  return <Navigate to="/models" replace />;
}
