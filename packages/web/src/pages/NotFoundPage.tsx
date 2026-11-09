/**
 * 404.
 *
 * Rendered inside the app shell, so it must not pretend to be a full page: a
 * dead end in a trading terminal is a moment of uncertainty ("did I break
 * something?"), and the useful answer is the two ways out plus the keyboard
 * shortcut that gets there fastest.
 *
 * ## 2026-11-10 按 `.dsh/ui-spec.md` 重排
 *
 * 原版是一个 `Panel`（卡片）+ 区块标题 + 一段说明 + 按钮组 + 底部提示 ——
 * 在一个"什么都没有"的页面上，那个卡片和区块标题只是**给空状态加装饰**。
 * 现在按规范 §1 的页面骨架来：**标题 + 动作紧跟标题 + 一行说明 + 一行快捷键**，
 * 没有卡片、没有区块标题、不留空占位。
 */
import { Link } from 'react-router-dom';
import { Home, Search } from 'lucide-react';
import { useDocumentTitle } from '../lib/hooks';

export function NotFoundPage() {
  useDocumentTitle('页面不存在');
  return (
    <div className="space-y-3">
      {/* 标题 + 动作在同一行：规范 §1「动作按钮永远紧跟标题」 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="num text-2xl font-semibold leading-none text-ink-strong">404</span>
        <h1 className="text-xl font-semibold text-ink-hi">这个地址不存在</h1>
        <Link to="/" className="btn btn-primary btn-sm">
          <Home aria-hidden className="h-3.5 w-3.5" />
          返回总览
        </Link>
        <Link to="/traders" className="btn btn-ghost btn-sm">
          打开机器人列表
        </Link>
      </div>

      <p className="text-base leading-relaxed text-ink-lo">
        控制台里没有对应这个路径的页面。可能是链接过期，也可能是地址被手改过 —— 数据没有丢。
      </p>

      <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
        <Search aria-hidden className="h-3.5 w-3.5" />
        或按
        <kbd className="num rounded border border-base-700 bg-base-850 px-1.5 py-0.5 text-xs text-ink-lo">⌘K</kbd>
        搜索并跳转到任意页面
      </p>
    </div>
  );
}
