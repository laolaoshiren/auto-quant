/**
 * 旧入口 `/settings`。
 *
 * 这里过去用标签页装了三块设置，现在它们各自是侧栏上的一级页面，所以老书签与
 * 外部链接统一转到模型页，而不是撞进 404。**保持重定向**（不改成一个空壳包装页）
 * 是有意的：这一屏没有自己的内容，硬做成页面只会多一个"点进来又得再点一次"的空壳。
 */
import { Navigate } from 'react-router-dom';

export function SettingsPage() {
  return <Navigate to="/models" replace />;
}
