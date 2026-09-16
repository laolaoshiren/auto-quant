/**
 * 应用外壳：**顶部导航 + 内容区**。
 *
 * 结构按 LAYOUT.md §0/§1：一条 56px 的顶栏（品牌 / 导航链接 / 状态 / 搜索 / 操作员），
 * 下面是内容区，由各页面自己的 `PageShell` 决定一栏还是两栏。
 *
 * 为什么不再有左侧导航：它要吃掉**每一个页面**的 224px 横向空间，而顶部导航
 * 把这段空间还给图表与表格（LAYOUT.md §0 规则 1）。顺带也没有了折叠/展开状态 ——
 * 没有状态，就没有记在 localStorage 里的东西，也没有"首屏按断点猜一次、
 * 之后听用户的"这种两套逻辑打架的麻烦。
 *
 * 几条不能破坏的约束：
 * - **内容区自身滚动**（不是整个窗口），页面里的长表格才不会把顶栏顶走。
 * - **横向不溢出**：`min-w-0` 一路传下去 + 内容区 `overflow-x-hidden`，
 *   表格要横向滚动必须自己套 `.scroll-x`。否则 150% 缩放下会出现整页横向滚动条。
 * - 轮询间隔随推送连接状态变化：socket 断了就靠 REST 快一点兜底。
 */
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { LogOut, Menu, Search, TriangleAlert, X } from 'lucide-react';
import { userRoleLabel } from '@aq/shared';
import { useApp, useEvents } from '../lib/store';
import { fmtClockOffset, fmtInt } from '../lib/format';
import { Badge, Button, Dot, Tooltip, cn } from './ui';
import { Toaster } from './Toaster';
import { CommandPalette } from './CommandPalette';
import { NAV_ITEMS, type NavItem } from './nav';

/** `lg` 断点（见 tailwind.config.js，em 单位）。 */
const DESKTOP_NAV_QUERY = '(min-width: 64em)';

export function Layout() {
  const user = useApp((s) => s.user);
  const system = useApp((s) => s.system);
  const traders = useApp((s) => s.traders);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const refreshTraders = useApp((s) => s.refreshTraders);
  const logout = useApp((s) => s.logout);
  const socketStatus = useEvents((s) => s.status);
  const connect = useEvents((s) => s.connect);
  const disconnect = useEvents((s) => s.disconnect);

  const location = useLocation();
  const navigate = useNavigate();

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

  /*
   * 转到桌面宽度时把抽屉收起来。
   *
   * 抽屉只在 `< lg` 存在，而 hamburger 在 `lg` 以上就被藏起来了 —— 如果宽屏时
   * 抽屉还开着，盖住页面的浮层就再也关不掉（遮罩可点，但那时候没人会想到去点它）。
   * 断点一跨过 `lg` 就自动归位。
   */
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_NAV_QUERY);
    const onChange = () => {
      if (query.matches) setDrawerOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  /** 导航徽标：以 `/system` 的 runningTraders 为准，列表还没到就用本地列表兜底。 */
  const runningCount = system?.runningTraders.length ?? traders.filter((trader) => trader.isRunning).length;

  /*
   * 两个诊断阈值。见状态区那段的注释：只在越界时才显示。
   *
   * 时钟取绝对值 —— 交易所的时钟快于本地同样会导致 -1021，
   * 只看正数会漏掉一半情况。
   */
  const clockWarn = Math.abs(system?.clockOffsetMs ?? 0) > 2000;
  const weightPercent =
    system?.weightLimit && system.weightLimit > 0
      ? Math.round(((system?.weightUsed ?? 0) / system.weightLimit) * 100)
      : 0;
  // 70% 而不是 100%：请求权重是**按分钟滚动**的，等到 100% 就已经在被拒绝了。
  // 代码里的软上限是 75%，留一点提前量。
  const weightWarn = weightPercent >= 70;

  const signOut = () => {
    logout();
    navigate('/login');
  };

  /** 抽屉与顶栏共用的一套链接渲染，避免两处漂移。 */
  const navLinks = (className?: string, onNavigate?: () => void) =>
    NAV_ITEMS.map((item) => (
      <NavLinkItem
        key={item.to}
        item={item}
        className={className}
        badge={item.to === '/traders' ? runningCount : 0}
        onNavigate={onNavigate}
      />
    ));

  return (
    /*
     * `overflow-x-hidden` 是刻意的：页面里忘记收窄的元素会被裁掉而不是
     * 让整个外壳出现横向滚动条。需要横向滚动的表格自己套 `.scroll-x`。
     */
    <div className="flex h-full min-h-screen flex-col overflow-x-hidden bg-base-950">
      {/*
        顶栏用**不透明**背景，不用 backdrop-blur。

        原来这里是 `bg-base-900/80 backdrop-blur`。毛玻璃在深色界面上几乎看不出来
        （80% 不透明的深色叠在深色页面上 ≈ 纯深色），代价却是实打实的：

        1. **它是整个页面里唯一一个常驻的 backdrop-filter。** Chrome 会为它创建
           "背景根"，在某些 GPU 驱动、远程桌面或虚拟显示环境下，会把整页内容
           错误地提升进滤镜图层 —— 表现为**整页均匀发虚、但布局完全正常**。
           这正是操作者报告过的现象，而且极难从代码上看出来。
        2. 它强制执行一次合成，滚动时每帧都要重算。

        用纯色换掉这两个风险，视觉上几乎没有区别。LAYOUT.md §4 把这条写成了硬规则。
      */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-base-800 bg-base-900 px-3 sm:px-4">
        <Button
          size="icon"
          variant="ghost"
          className="lg:hidden"
          aria-label="打开导航"
          aria-expanded={drawerOpen}
          aria-haspopup="dialog"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu aria-hidden className="h-4 w-4" />
        </Button>

        <Brand />

        {/*
          导航链接。当前项用**文字变亮 + 一条 2px 强调线**表示，不用填充背景块 ——
          h-14 的横条上，大面积色块比文字本身还抢眼，反而看不出当前在哪一页。
        */}
        <nav aria-label="主导航" className="hidden min-w-0 items-center gap-0.5 lg:ml-2 lg:flex">
          {navLinks()}
        </nav>

        {/* 弹性空白：把状态区推到最右 */}
        <div className="min-w-0 flex-1" />

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

        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <div className="hidden items-center gap-2 lg:flex">
            <Badge tone={system?.dryRun ? 'accent' : 'warn'} className="shrink-0">
              {system?.dryRun ? '模拟' : '实盘'}
            </Badge>
            {/* 环境名是长文本，只在宽屏给位置 —— 窄屏它会把导航挤成两行 */}
            <span
              className="hidden max-w-[12rem] truncate text-base text-ink-mid xl:inline"
              title={system?.environmentLabel}
            >
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
            title={`实时事件推送：${socketStatus}`}
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

          <Tooltip content={`${user?.username ?? '—'}${user?.role ? ` · ${userRoleLabel(user.role)}` : ''}`} side="bottom">
            <Button size="icon" variant="ghost" aria-label="退出登录" onClick={signOut}>
              <LogOut aria-hidden className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/*  移动端抽屉（`< lg`：导航链接收进汉堡菜单，LAYOUT.md §1）          */}
      {/* ---------------------------------------------------------------- */}
      <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DialogPrimitive.Portal>
          {/* 对话框的模糊保留：它只在打开时存在，不是常驻的 backdrop-filter（§4） */}
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-overlay backdrop-blur-sm lg:hidden" />
          <DialogPrimitive.Content className="nav-drawer fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r border-base-800 bg-base-900 lg:hidden">
            <DialogPrimitive.Title className="sr-only">导航</DialogPrimitive.Title>
            <Brand onClose={() => setDrawerOpen(false)} />
            <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
              {navLinks('w-full', () => setDrawerOpen(false))}
            </nav>
            <div className="border-t border-base-800 px-2 py-2">
              <div className="flex items-center justify-between gap-1 rounded-md border border-base-800 bg-base-850/60 px-2 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-xs text-ink-mid">{user?.username ?? '—'}</div>
                  <div className="truncate text-xs text-ink-faint">{userRoleLabel(user?.role ?? '')}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={signOut} className="shrink-0">
                  退出
                </Button>
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/*
        内容区。`overflow-y-auto` 留在这里（而不是移到每个页面）的原因与之前一致：
        长表格滚动时顶栏必须钉住。
        两栏页面的右栏要"填满屏高并独立滚动"，靠的是 `PageShell` 在 `h-full` 里拿到的
        那份确定高度 —— 所以这里绝不能给它加 padding，否则那条高度链就断了。
      */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <Outlet />
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <Toaster />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  顶栏零件                                                                   */
/* -------------------------------------------------------------------------- */

function Brand({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-xs font-bold text-accent">
        AQ
      </div>
      <div className="hidden min-w-0 leading-none sm:block">
        <div className="truncate text-base font-semibold tracking-wide text-ink-hi">AutoQuant</div>
        <div className="truncate text-xs text-ink-faint">LLM 合约终端</div>
      </div>
      {onClose && (
        <Button size="icon" variant="ghost" className="ml-auto" aria-label="关闭导航" onClick={onClose}>
          <X aria-hidden className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

/**
 * 一个顶部导航项。
 *
 * 选中态 = 文字变亮 + 底部 2px 强调线。用真实元素画线而不是内联阴影：
 * 写死的颜色在换主题时不会跟着变。
 */
function NavLinkItem({
  item,
  badge,
  className,
  onNavigate,
}: {
  item: NavItem;
  badge: number;
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          // `whitespace-nowrap`：导航项宁可挤，也不要折成两行把 h-14 的横条撑高
          'relative flex h-14 shrink-0 items-center gap-2 whitespace-nowrap px-2.5 text-base font-medium transition',
          isActive ? 'text-ink-hi' : 'text-ink-lo hover:text-ink-mid',
          className,
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon aria-hidden className="h-4 w-4 shrink-0 xl:hidden" />
          <span className="min-w-0 truncate">{item.label}</span>
          {badge > 0 && (
            <span
              className="num hidden shrink-0 rounded bg-up/15 px-1.5 text-xs text-up xl:inline"
              title={`${badge} 个循环在运行`}
            >
              {badge}
            </span>
          )}
          {isActive && <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />}
        </>
      )}
    </NavLink>
  );
}
