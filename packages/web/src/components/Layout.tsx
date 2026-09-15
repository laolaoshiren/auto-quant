import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import clsx from 'clsx';
import { useApp, useEvents } from '../lib/store';
import { fmtClockOffset, fmtInt, timeAgo } from '../lib/format';
import { Badge, Dot } from './ui';
import { Toaster } from './Toaster';

const NAV: Array<{ to: string; label: string; glyph: string }> = [
  { to: '/', label: '总览', glyph: '▤' },
  { to: '/traders', label: '机器人', glyph: '◉' },
  { to: '/strategy', label: '策略工作室', glyph: '⚙' },
  { to: '/models', label: 'AI 模型', glyph: '✦' },
  { to: '/exchanges', label: '交易所', glyph: '⇄' },
  { to: '/market', label: '行情', glyph: '▦' },
  { to: '/data', label: '数据与日志', glyph: '≣' },
  { to: '/account', label: '操作员账户', glyph: '⚿' },
  { to: '/faq', label: '帮助', glyph: '?' },
];

export function Layout() {
  const user = useApp((s) => s.user);
  const system = useApp((s) => s.system);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const refreshTraders = useApp((s) => s.refreshTraders);
  const logout = useApp((s) => s.logout);
  const socketStatus = useEvents((s) => s.status);
  const lastEventAt = useEvents((s) => s.lastEventAt);
  const connect = useEvents((s) => s.connect);
  const disconnect = useEvents((s) => s.disconnect);
  const navigate = useNavigate();

  // Keep the shell honest even if the socket is down.
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshSystem();
      void refreshTraders();
    }, socketStatus === 'open' ? 10_000 : 4_000);
    return () => window.clearInterval(timer);
  }, [refreshSystem, refreshTraders, socketStatus]);

  return (
    <div className="flex h-full min-h-screen bg-base-950">
      <aside className="flex w-52 shrink-0 flex-col border-r border-base-800 bg-base-900">
        <div className="flex items-center gap-2 border-b border-base-800 px-3 py-3">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-accent/15 text-xs font-bold text-accent">
            AQ
          </div>
          <div className="leading-none">
            <div className="text-xs font-semibold tracking-wide text-ink-hi">AutoQuant</div>
            <div className="text-2xs text-ink-faint">LLM 合约终端</div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2 rounded px-2 py-1.5 text-xs transition',
                  isActive
                    ? 'bg-accent/12 text-ink-hi shadow-[inset_2px_0_0_0_#4d8dff]'
                    : 'text-ink-lo hover:bg-base-850 hover:text-ink-mid',
                )
              }
            >
              <span className="w-3 text-center text-ink-faint">{item.glyph}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-base-800 px-2 py-2">
          <div className="flex items-center justify-between px-1 py-1">
            <span className="flex items-center gap-1.5 text-2xs text-ink-lo">
              <Dot tone={socketStatus === 'open' ? 'up' : socketStatus === 'connecting' ? 'warn' : 'down'} pulse={socketStatus !== 'open'} />
              {socketStatus === 'open' ? '推送在线' : socketStatus}
            </span>
            <span className="num text-2xs text-ink-faint">
              {timeAgo(lastEventAt ? new Date(lastEventAt).toISOString() : null)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-1 rounded border border-base-800 bg-base-850/60 px-2 py-1">
            <div className="min-w-0">
              <div className="truncate text-2xs text-ink-mid">{user?.username ?? '—'}</div>
              <div className="text-2xs text-ink-faint">{user?.role ?? ''}</div>
            </div>
            <button
              type="button"
              onClick={() => {
                logout();
                navigate('/login');
              }}
              className="rounded border border-base-700 px-1.5 py-0.5 text-2xs text-ink-lo transition hover:border-down/50 hover:text-down"
            >
              退出
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-base-800 bg-base-900/80 px-4 py-2 backdrop-blur">
          <div className="flex items-center gap-2">
            <Badge tone={system?.dryRun ? 'accent' : 'warn'}>
              {system?.dryRun ? '模拟' : '实盘'}
            </Badge>
            <span className="text-xs text-ink-mid">{system?.environmentLabel ?? '连接中…'}</span>
          </div>

          <div className="num flex items-center gap-3 text-2xs text-ink-lo">
            <span title="本地时钟减交易所时钟">
              时钟 <span className={clsx((system?.clockOffsetMs ?? 0) > 2000 ? 'text-warn' : 'text-ink-mid')}>{fmtClockOffset(system?.clockOffsetMs)}</span>
            </span>
            <span title="当前分钟已消耗的请求权重">
              权重{' '}
              <span className="text-ink-mid">
                {fmtInt(system?.weightUsed)}
                <span className="text-ink-faint">/{fmtInt(system?.weightLimit)}</span>
              </span>
            </span>
            <span title="可交易的交易对数量">
              交易对 <span className="text-ink-mid">{fmtInt(system?.tradableSymbols)}</span>
            </span>
            <span title="运行中的循环">
              运行 <span className="text-ink-mid">{system?.runningTraders.length ?? 0}</span>
            </span>
          </div>

          {system?.tradingDisabled && (
            <div className="ml-auto flex items-center gap-2 rounded border border-down/60 bg-down/15 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wide text-down">
              <Dot tone="down" pulse />
              全局交易已禁用 — 开仓被 GLOBAL_TRADING_DISABLED 拦截
            </div>
          )}
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto p-4">
          <Outlet />
        </main>
      </div>

      <Toaster />
    </div>
  );
}
