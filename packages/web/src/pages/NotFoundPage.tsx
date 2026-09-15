/**
 * 404.
 *
 * Rendered inside the app shell, so it must not pretend to be a full page: a
 * dead end in a trading terminal is a moment of uncertainty ("did I break
 * something?"), and the useful answer is the two ways out plus the keyboard
 * shortcut that gets there fastest.
 */
import { Link } from 'react-router-dom';
import { Compass, Home, Search } from 'lucide-react';
import { Panel } from '../components/ui';
import { useDocumentTitle } from '../lib/hooks';

export function NotFoundPage() {
  useDocumentTitle('页面不存在');
  return (
    <Panel className="mx-auto max-w-xl" padded={false}>
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-base-750 bg-base-850 text-ink-lo">
          <Compass aria-hidden className="h-5 w-5" />
        </span>

        <p className="num text-4xl font-semibold leading-none text-ink-strong">404</p>

        <div>
          <h2 className="text-xl font-semibold text-ink-hi">这个地址不存在</h2>
          <p className="mt-1 max-w-md text-base leading-relaxed text-ink-lo">
            控制台里没有对应这个路径的页面。可能是链接过期了，也可能是地址被手改过 ——
            数据没有丢，返回总览即可继续。
          </p>
        </div>

        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <Link to="/" className="btn btn-primary">
            <Home aria-hidden className="h-4 w-4" />
            返回总览
          </Link>
          <Link to="/traders" className="btn btn-ghost">
            打开机器人列表
          </Link>
        </div>

        <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-ink-faint">
          <Search aria-hidden className="h-3.5 w-3.5" />
          或按
          <kbd className="num rounded border border-base-700 bg-base-850 px-1.5 py-0.5 text-2xs text-ink-lo">⌘K</kbd>
          搜索并跳转到任意页面
        </p>
      </div>
    </Panel>
  );
}
