/**
 * 404.
 *
 * Rendered inside the app shell, so it must not pretend to be a full page: a
 * dead end in a trading terminal is a moment of uncertainty ("did I break
 * something?"), and the useful answer is the two ways out plus the keyboard
 * shortcut that gets there fastest.
 *
 * 排版：左对齐 + 紧凑，和其余页面一致（LAYOUT.md §2/§4）。原来是一个居中的
 * 大方块，上下各 40px 空白 —— 在一个 404 上那是纯粹的浪费，而且居中的
 * 区块标题（带延伸线）在视觉上没法成立。
 */
import { Link } from 'react-router-dom';
import { Compass, Home, Search } from 'lucide-react';
import { Panel } from '../components/ui';
import { SectionLabel } from '../components/shell';
import { useDocumentTitle } from '../lib/hooks';

export function NotFoundPage() {
  useDocumentTitle('页面不存在');
  return (
    <Panel className="max-w-lg" padded={false}>
      <div className="px-4 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-base-750 bg-base-850 text-ink-lo">
            <Compass aria-hidden className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="num text-3xl font-semibold leading-none text-ink-strong">404</p>
            <h2 className="mt-1 text-lg font-semibold leading-tight text-ink-hi">这个地址不存在</h2>
          </div>
        </div>

        <p className="mt-3 text-base leading-relaxed text-ink-lo">
          控制台里没有对应这个路径的页面。可能是链接过期了，也可能是地址被手改过 —— 数据没有丢。
        </p>

        <SectionLabel title="从这里继续" className="mt-4 mb-2" />
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/" className="btn btn-primary">
            <Home aria-hidden className="h-4 w-4" />
            返回总览
          </Link>
          <Link to="/traders" className="btn btn-ghost">
            打开机器人列表
          </Link>
        </div>

        <p className="mt-3 flex w-full flex-wrap items-center gap-1.5 border-t border-base-800 pt-3 text-xs text-ink-faint">
          <Search aria-hidden className="h-3.5 w-3.5" />
          或按
          <kbd className="num rounded border border-base-700 bg-base-850 px-1.5 py-0.5 text-xs text-ink-lo">⌘K</kbd>
          搜索并跳转到任意页面
        </p>
      </div>
    </Panel>
  );
}
