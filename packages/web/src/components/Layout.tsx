/**
 * 应用外壳：侧栏 + 顶栏 + 内容区。
 *
 * 结构按 DESIGN.md §4：顶栏固定 56px（账户状态 / 全局操作 / 搜索），
 * 侧栏 224px 可收成 64px 图标态，`md` 以下整体变抽屉。
 *
 * 几条不能破坏的约束：
 * - **内容区自身滚动**（不是整个窗口），页面里的长表格才不会把顶栏顶走。
 * - **横向不溢出**：`min-w-0` 一路传下去 + 内容区 `overflow-x-hidden`，
 *   表格要横向滚动必须自己套 `.scroll-x`。否则 150% 缩放下会出现整页横向滚动条。
 * - 轮询间隔随推送连接状态变化：socket 断了就靠 REST 快一点兜底。
 */
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search, TriangleAlert, X } from 'lucide-react';
import { userRoleLabel } from '@aq/shared';
import { useApp, useEvents } from '../lib/store';
import { fmtClockOffset, fmtInt, timeAgo } from '../lib/format';
import { Badge, Button, Dot, Tooltip, cn } from './ui';
import { Toaster } from './Toaster';
import { CommandPalette } from './CommandPalette';
import { NAV_ITEMS, pageTitleFor, type NavItem } from './nav';

/** localStorage 里存的是**用户的选择**，不是当前尺寸 —— 尺寸由断点决定。 */
const SIDEBAR_KEY = 'aq.shell.sidebar';
/** `lg` 断点（见 tailwind.config.js，em 单位）。 */
const SIDEBAR_EXPANDED_QUERY = '(min-width: 64em)';

/**
 * 首次访问时跟随布局：`md`–`lg` 收成图标态，`lg` 以上展开。
 * 用户点过折叠按钮之后就听用户的（见 `toggleSidebar`）。
 */
function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_KEY);
    if (stored === 'collapsed') return true;
    if (stored === 'expanded') return false;
  } catch {
    /* 隐私模式下 localStorage 可能直接抛异常，按默认布局走即可 */
  }
  return typeof window === 'undefined' ? false : !window.matchMedia(SIDEBAR_EXPANDED_QUERY).matches;
}

export function Layout() {
  const user = useApp((s) => s.user);
  const system = useApp((s) => s.system);
  const traders = useApp((s) => s.traders);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const refreshTraders = useApp((s) => s.refreshTraders);
  const logout = useApp((s) => s.logout);
  const socketStatus = useEvents((s) => s.status);
  const lastEventAt = useEvents((s) => s.lastEventAt);
  const connect = useEvents((s) => s.connect);
  const disconnect = useEvents((s) => s.disconnect);

  const location = useLocation();
  const navigate = useNavigate();

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Keep the shell honest even if the socket is down.
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    const timer = window.setInterval(
      () => {
        void refreshSystem();
        void refreshTraders();
      },
      socketStatus === 'open' ? 10_000 : 4_000,
    );
    return () => window.clearInterval(timer);
  }, [refreshSystem, refreshTraders, socketStatus]);

  // 抽屉里点了导航就关掉，否则新页面会被抽屉盖着。
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const toggleSidebar = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? 'collapsed' : 'expanded');
    } catch {
      /* 存不下就只在本次会话里生效 */
    }
  }, [collapsed]);

  /** 侧栏徽标：以 `/system` 的 runningTraders 为准，列表还没到就用本地列表兜底。 */
  const runningCount = system?.runningTraders.length ?? traders.filter((trader) => trader.isRunning).length;

  /*
   * 两个诊断阈值。见顶栏那段的注释：只在越界时才显示。
   *
   * 时钟取绝对值 —— 交易所的时钟快于本地同样会导致 -1021，
   * 只看正数会漏掉一半情况。
   */
  const clockWarn = Math.abs(system?.clockOffsetMs ?? 0) > 2000;
  const weightPercent =
    system?.weightLimit && system.weightLimit > 0
      ? Math.round(((system.weightUsed ?? 0) / system.weightLimit) * 100)
      : 0;
  // 70% 而不是 100%：请求权重是**按分钟滚动**的，等到 100% 就已经在被拒绝了。
  // 代码里的软上限是 75%，留一点提前量。
  const weightWarn = weightPercent >= 70;
  const title = pageTitleFor(location.pathname);

  const signOut = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="flex h-full min-h-screen bg-base-950">
      {/* ---------------------------------------------------------------- */}
      {/*  桌面侧栏                                                         */}
      {/* ---------------------------------------------------------------- */}
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-r border-base-800 bg-base-900 transition-[width] duration-150 md:flex',
          collapsed ? 'w-16' : 'w-56',
        )}
      >
        <Brand collapsed={collapsed} />

        <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {NAV_ITEMS.map((item) => (
            <NavRow key={item.to} item={item} collapsed={collapsed} badge={item.to === '/traders' ? runningCount : 0} />
          ))}
        </nav>

        <SidebarStatus
          collapsed={collapsed}
          socketStatus={socketStatus}
          lastEventAt={lastEventAt}
          username={user?.username ?? '—'}
          role={user?.role ?? ''}
          onSignOut={signOut}
        />
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/*  移动端抽屉                                                       */}
      {/* ---------------------------------------------------------------- */}
      <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-overlay backdrop-blur-sm md:hidden" />
          <DialogPrimitive.Content className="nav-drawer fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r border-base-800 bg-base-900 md:hidden">
            <DialogPrimitive.Title className="sr-only">导航</DialogPrimitive.Title>
            <Brand collapsed={false} onClose={() => setDrawerOpen(false)} />
            <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
              {NAV_ITEMS.map((item) => (
                <NavRow key={item.to} item={item} collapsed={false} badge={item.to === '/traders' ? runningCount : 0} />
              ))}
            </nav>
            <SidebarStatus
              collapsed={false}
              socketStatus={socketStatus}
              lastEventAt={lastEventAt}
              username={user?.username ?? '—'}
              role={user?.role ?? ''}
              onSignOut={signOut}
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* ---------------------------------------------------------------- */}
      {/*  主列                                                             */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          顶栏用**不透明**背景，不用 backdrop-blur。
          
          原来这里是 `bg-base-900/80 backdrop-blur`。毛玻璃在深色界面上几乎看不出来
          （80% 不透明的深色叠在深色页面上 ≈ 纯深色），代价却是实打实的：
          
          1. **它是整个页面里唯一一个常驻的 backdrop-filter。** Chrome 会为它创建
             "背景根"，在某些 GPU 驱动、远程桌面或虚拟显示环境下，会把整页内容
             错误地提升进滤镜图层 —— 表现为**整页均匀发虚、但布局完全正常**。
             这正是操作者报告过的现象，而且极难从代码上看出来。
          2. 它强制执行一次合成，滚动时每帧都要重算。
          
          用纯色换掉这两个风险，视觉上几乎没有区别。
        */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-base-800 bg-base-900 px-3 sm:px-4">
          <Button
            size="icon"
            variant="ghost"
            className="md:hidden"
            aria-label="打开导航"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden className="h-4 w-4" />
          </Button>

          <Tooltip content={collapsed ? '展开侧栏' : '收起侧栏'} side="bottom">
            <Button
              size="icon"
              variant="ghost"
              className="hidden md:inline-flex"
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!collapsed}
              onClick={toggleSidebar}
            >
              {collapsed ? (
                <PanelLeftOpen aria-hidden className="h-4 w-4" />
              ) : (
                <PanelLeftClose aria-hidden className="h-4 w-4" />
              )}
            </Button>
          </Tooltip>

          <h1 className="min-w-0 truncate text-md font-semibold text-ink-hi">{title}</h1>

          {/* 全局风控状态：这是全屏最重要的一条告警，任何宽度下都留着 */}
          {system?.tradingDisabled && (
            <Badge
              tone="down"
              className="shrink-0 animate-pulse-soft"
              title="开仓会被 GLOBAL_TRADING_DISABLED 拦截；平仓与对账仍然可用。"
            >
              <Dot tone="down" />
              交易已禁用
            </Badge>
          )}

          <div className="ml-auto flex min-w-0 items-center gap-2">
            <div className="hidden items-center gap-2 lg:flex">
              <Badge tone={system?.dryRun ? 'accent' : 'warn'} className="shrink-0">
                {system?.dryRun ? '模拟' : '实盘'}
              </Badge>
              <span className="max-w-[14rem] truncate text-base text-ink-mid" title={system?.environmentLabel}>
                {system?.environmentLabel ?? '连接中…'}
              </span>
            </div>

            {/*
              诊断指标：**正常时不显示，异常时才出现**。
              
              原来常驻显示 `时钟 +22 ms` 和 `权重 59/2,400`。对操作员来说这两个
              数字在正常运行时永远"没事" —— 看它一百次有九十九次拿不到任何信息，
              却一直占着顶栏最显眼的位置（用户原话："似乎毫无意义"）。
              
              而真正需要它们的时刻，恰恰是它们出问题的时刻：
              
              · 时钟偏差超过 2 秒 → 币安会用 -1021 拒绝每一张签名请求
              · 权重逼近上限    → 再往上就是 418（封 IP），而不是限流
              
              所以改成：正常时消失，异常时带着**后果**出现。数字本身没意义，
              "这会导致什么"才有意义。
            */}
            {clockWarn && (
              <Tooltip content="本地时钟与交易所时钟相差超过 2 秒。签名请求会因时间戳超窗被拒绝（-1021），下单与撤单都会失败。请校准服务器时间（NTP）。">
                <Badge tone="warn" className="shrink-0">
                  <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                  时钟偏差 {fmtClockOffset(system?.clockOffsetMs)}
                </Badge>
              </Tooltip>
            )}

            {weightWarn && (
              <Tooltip content="当前分钟已消耗的请求权重接近上限。继续升高会被交易所临时封禁 IP（418），届时所有行情与交易请求都会失败。">
                <Badge tone="warn" className="shrink-0">
                  <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                  API 权重 {weightPercent}%
                </Badge>
              </Tooltip>
            )}

            {/* 运行中的循环数：这是**真的状态**，不是诊断值，所以常驻 */}
            {runningCount > 0 && (
              <span className="num hidden shrink-0 text-xs text-ink-lo sm:inline" title="正在运行的机器人数量">
                运行 <span className="text-ink-mid">{fmtInt(runningCount)}</span>
              </span>
            )}

            <span
              className="hidden shrink-0 items-center gap-1.5 text-xs text-ink-lo sm:flex"
              title={`实时事件推送：${socketStatus}，最近一条 ${timeAgo(lastEventAt ? new Date(lastEventAt).toISOString() : null)}`}
            >
              <Dot
                tone={socketStatus === 'open' ? 'up' : socketStatus === 'connecting' ? 'warn' : 'down'}
                pulse={socketStatus !== 'open'}
              />
              {socketStatus === 'open' ? '推送在线' : socketStatus}
            </span>

            {/* 搜索入口。显示 ⌘K 是要让人**发现**快捷键，而不是把快捷键藏在文档里 */}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="打开命令面板"
              className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-base-700 bg-base-850 px-2.5 text-ink-lo transition hover:border-base-600 hover:text-ink-mid"
            >
              <Search aria-hidden className="h-4 w-4 shrink-0" />
              <span className="hidden truncate text-base sm:inline">搜索或跳转</span>
              <kbd className="num hidden shrink-0 rounded border border-base-700 bg-base-800 px-1.5 py-0.5 text-xs text-ink-faint sm:inline">
                ⌘K
              </kbd>
            </button>

            <Tooltip content={`${user?.username ?? '—'}${user?.role ? ` · ${user.role}` : ''}`} side="bottom">
              <Button size="icon" variant="ghost" aria-label="退出登录" onClick={signOut}>
                <LogOut aria-hidden className="h-4 w-4" />
              </Button>
            </Tooltip>
          </div>
        </header>

        {/*
         * `overflow-x-hidden` 是刻意的：页面里忘记收窄的元素会被裁掉而不是
         * 让整个外壳出现横向滚动条。需要横向滚动的表格自己套 `.scroll-x`。
         */}
        <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <Toaster />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  侧栏零件                                                                   */
/* -------------------------------------------------------------------------- */

function Brand({ collapsed, onClose }: { collapsed: boolean; onClose?: () => void }) {
  return (
    <div className={cn('flex items-center gap-2 border-b border-base-800 py-3', collapsed ? 'justify-center px-2' : 'px-3')}>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-xs font-bold text-accent">
        AQ
      </div>
      {!collapsed && (
        <div className="min-w-0 leading-none">
          <div className="truncate text-base font-semibold tracking-wide text-ink-hi">AutoQuant</div>
          <div className="truncate text-xs text-ink-faint">LLM 合约终端</div>
        </div>
      )}
      {onClose && (
        <Button size="icon" variant="ghost" className="ml-auto" aria-label="关闭导航" onClick={onClose}>
          <X aria-hidden className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

function NavRow({ item, collapsed, badge }: { item: NavItem; collapsed: boolean; badge: number }) {
  const link = (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cn(
          'relative flex items-center gap-2.5 rounded-md py-2.5 text-lg font-medium transition',
          collapsed ? 'justify-center px-0' : 'px-2.5',
          isActive ? 'bg-accent/10 text-ink-hi' : 'text-ink-lo hover:bg-base-850 hover:text-ink-mid',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* 选中标记用真实元素而不是内联阴影：写死的颜色在换主题时不会跟着变 */}
          {isActive && <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />}
          <item.icon aria-hidden className="h-[18px] w-[18px] shrink-0" />
          {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
          {badge > 0 &&
            (collapsed ? (
              <span
                aria-hidden
                className="absolute right-2 top-1.5 h-1.5 w-1.5 rounded-full bg-up"
                title={`${badge} 个循环在运行`}
              />
            ) : (
              <span
                className="num shrink-0 rounded bg-up/15 px-1.5 text-xs text-up"
                title={`${badge} 个循环在运行`}
              >
                {badge}
              </span>
            ))}
        </>
      )}
    </NavLink>
  );

  // 图标态只剩一个图标，文字标签要靠气泡补回来
  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function SidebarStatus({
  collapsed,
  socketStatus,
  lastEventAt,
  username,
  role,
  onSignOut,
}: {
  collapsed: boolean;
  socketStatus: string;
  lastEventAt: number | null;
  username: string;
  role: string;
  onSignOut: () => void;
}) {
  const dot = (
    <Dot
      tone={socketStatus === 'open' ? 'up' : socketStatus === 'connecting' ? 'warn' : 'down'}
      pulse={socketStatus !== 'open'}
    />
  );

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 border-t border-base-800 px-2 py-2">
        <span title={socketStatus === 'open' ? '推送在线' : socketStatus}>{dot}</span>
        <Tooltip content={`${username}${role ? ` · ${role}` : ''} — 退出登录`} side="right">
          <Button size="icon" variant="ghost" aria-label="退出登录" onClick={onSignOut}>
            <LogOut aria-hidden className="h-4 w-4" />
          </Button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="border-t border-base-800 px-2 py-2">
      <div className="flex items-center justify-between px-1 py-1">
        <span className="flex items-center gap-1.5 text-xs text-ink-lo">
          {dot}
          {socketStatus === 'open' ? '推送在线' : socketStatus}
        </span>
        <span className="num text-xs text-ink-faint">
          {timeAgo(lastEventAt ? new Date(lastEventAt).toISOString() : null)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-1 rounded-md border border-base-800 bg-base-850/60 px-2 py-1.5">
        <div className="min-w-0">
          <div className="truncate text-xs text-ink-mid">{username}</div>
          <div className="truncate text-xs text-ink-faint">{userRoleLabel(role)}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={onSignOut} className="shrink-0">
          退出
        </Button>
      </div>
    </div>
  );
}
