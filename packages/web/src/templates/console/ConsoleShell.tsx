/**
 * **控制台模板** —— 一个浮在壁纸上的窗口。
 *
 * ## 五层结构
 *
 * 见 `LAYOUT.md` §0。这一版重做的核心**不是换配色，是换骨架**：
 *
 * ```
 * ┌────────────────────────────────────────────────────────────┐
 * │ 标题栏 38px  品牌 · 文档名 · 全局状态 · 主题 · 操作员      │
 * ├────────────────────────────────────────────────────────────┤
 * │ 菜单栏 30px  交易 / 系统 / 帮助（低频，键盘可达）          │
 * ├────────────────────────────────────────────────────────────┤
 * │ 工具栏 40px  ← 当前页面的动作（由页面 portal 进来）        │
 * ├──────────────┬─────────────────────────────────────────────┤
 * │ 侧栏 208px   │ 工作区：只有这一层滚动                     │
 * │ 分组导航     │                                             │
 * ├──────────────┴─────────────────────────────────────────────┤
 * │ 状态栏 26px  推送 · 环境 · 运行数 · 时钟 · 权重 · 操作员   │
 * └────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## 与经典模板的分工
 *
 * 这个文件里**没有任何业务逻辑**：数据从 `useShell()` 拿，动作由页面自己
 * portal 进工具栏。想看两套外壳的差别，把这个文件与 `../classic/ClassicShell.tsx`
 * 并排读就够了 —— 它们都只依赖同一份 `ShellState`。
 *
 * ## 几条不能破坏的约束
 *
 * - **只有工作区滚动**（`id = MAIN_SCROLL_ID`），窗口本身不动。长表格滚下去时
 *   标题栏、菜单栏、工具栏、状态栏全部钉住。
 * - **横向不溢出**：`min-w-0` 一路传下去 + 内容区 `overflow: hidden` 里的
 *   `overflow: auto`，需要横滚的表格自己套 `.scroll-x`。
 * - **常驻的 `backdrop-filter` 一律不用**（`LAYOUT.md` §4）：它曾导致整页
 *   在部分 GPU / 远程桌面环境下均匀发虚，而布局完全正常，极难定位。
 * - **不要在这里渲染 `<Toaster />` 或调用 `connect()`**：它们由 `ShellRuntime`
 *   统一调度，模板重复做会导致 toast 出两次、或者连上两条 WebSocket。
 */
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ChevronDown, LogOut, Menu, Moon, RefreshCw, Search, Sun, TriangleAlert, X } from 'lucide-react';
import { userRoleLabel } from '@aq/shared';
import { useApp } from '../../lib/store';
import { fmtClockOffset, fmtInt } from '../../lib/format';
import { useTicker } from '../../lib/hooks';
import { Badge, Button, Dot, Tooltip, cn } from '../../components/ui';
import type { NavGroup, NavItem } from '../../components/nav';
import { MAIN_SCROLL_ID, TOOLBAR_END_ID, TOOLBAR_START_ID } from '../ids';
import { useShell } from '../lib/context';
import { APPEARANCE_EVENT, getSkin, setSkin, type Skin } from '../lib/appearance';
import { TemplateSwitcher } from '../lib/TemplateSwitcher';

/**
 * 侧栏／汉堡按钮共用的断点。
 *
 * ⚠️ **它必须与 `theme.css` 里 `@media (max-width: 56em)` 是同一个数。**
 * 两处不一致会在中间那段宽度里出现"侧栏已经收成顶部横条、而汉堡按钮还藏着"
 * 的空档 —— 那一段的用户点不到任何导航。
 *
 * 为什么不用 Tailwind 的 `lg`（64em）：`lg` 与 56em 之间有 128px 的缝，
 * 而侧栏的折叠是 CSS 里的 56em。两套断点混用是这类空档的常见来源。
 */
const DESKTOP_NAV_QUERY = '(min-width: 56em)';

export function ConsoleShell() {
  const shell = useShell();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  /*
   * 标题栏上的「文档名」。
   *
   * 在组件里算，而不是抽一个内部函数去读 `useShell()` —— 后者会让"读数据"
   * 藏在一个看起来像纯函数的名字后面（`currentTitle(path)`），而 hooks
   * 的调用位置就不再一眼可见了。
   */
  const docTitle = currentTitle(location.pathname, shell.navItems);

  // 抽屉里点了导航就关掉，否则新页面会被抽屉盖着。
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  /*
   * 转到桌面宽度时把抽屉收起来。
   *
   * 如果宽屏时抽屉还开着，盖住页面的浮层就再也关不掉（遮罩可点，但那时候
   * 没人会想到去点它）。断点一跨过 56em 就自动归位。
   */
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_NAV_QUERY);
    const onChange = () => {
      if (query.matches) setDrawerOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return (
    /*
     * `app-root` 把窗口居中并留出壁纸边距，`win` 是窗口本体 ——
     * 两者的样式都在 `theme.css` 里，且只在这个模板的根类名下生效。
     */
    <div className="app-root">
      <div className="win">
        {/* -------------------------------------------------------------- */}
        {/*  标题栏                                                         */}
        {/* -------------------------------------------------------------- */}
        <header className="titlebar">
          {/*
            窄屏上的汉堡按钮。宽屏时侧栏常驻，这个按钮不存在。

            ⚠️ 断点必须是 `min-[56em]`，与 `theme.css` 里侧栏收成横条的
            媒体查询同源（见 `DESKTOP_NAV_QUERY` 的说明）。
          */}
          <Button
            size="icon"
            variant="ghost"
            className="min-[56em]:hidden"
            aria-label="打开导航"
            aria-expanded={drawerOpen}
            aria-haspopup="dialog"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden className="h-3.5 w-3.5" />
          </Button>

          <Brand />

          {/*
            文档名：当前页面叫什么。这一格是**桌面应用的特征** —— 一个窗口
            总要说清自己现在打开的是什么。它也顺带承担了"路径 → 标题"的
            映射，页面自己不再需要额外渲染一行大标题。
          */}
          <span aria-hidden className="text-ink-faint">
            /
          </span>
          <span className="min-w-0 truncate text-ink-mid">{docTitle}</span>

          <div className="min-w-2 flex-1" />

          {/* 全局风控状态：全屏最重要的一条告警，任何宽度下都留着 */}
          {shell.system?.tradingDisabled && (
            <Badge
              tone="down"
              className="hidden shrink-0 animate-pulse-soft sm:inline-flex"
              title="开仓会被 GLOBAL_TRADING_DISABLED 拦截；平仓与对账仍然可用。"
            >
              <Dot tone="down" />
              交易已禁用
            </Badge>
          )}

          {shell.clockWarn && (
            <Tooltip content="本地时钟与交易所时钟相差超过 2 秒。签名请求会因时间戳超窗被拒绝（-1021），下单与撤单都会失败。请校准服务器时间（NTP）。">
              <Badge tone="warn" className="hidden shrink-0 md:inline-flex">
                <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                时钟偏差 {fmtClockOffset(shell.system?.clockOffsetMs)}
              </Badge>
            </Tooltip>
          )}

          {shell.weightWarn && (
            <Tooltip content="当前分钟已消耗的请求权重接近上限。继续升高会被交易所临时封禁 IP（418），届时所有行情与交易请求都会失败。">
              <Badge tone="warn" className="hidden shrink-0 md:inline-flex">
                <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                API 权重 {shell.weightPercent}%
              </Badge>
            </Tooltip>
          )}

          <SkinToggle />

          {/*
            模板切换器。它就在标题栏上、永远可见 —— 用户不该为了"换一套看看"
            先去找「外观」页藏在侧栏的哪一行（理由见 TemplateSwitcher 的注释）。
            每套外壳都必须渲染它，`registry.test.ts` 逐文件断言。
          */}
          <TemplateSwitcher />

          {/* 搜索入口。写着 ⌘K 是要让人**发现**快捷键，而不是把它藏进文档 */}
          <button
            type="button"
            onClick={() => shell.setPaletteOpen(true)}
            aria-label="打开命令面板"
            className="flex h-6 shrink-0 items-center gap-1.5 rounded border border-base-600 bg-base-800 px-1.5 text-xs text-ink-lo transition hover:text-ink-mid"
            title="打开命令面板（⌘K）—— 快速跳转、切换机器人、启动或停止"
          >
            <Search aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="num hidden min-[56em]:inline">⌘K</span>
          </button>

          <UserMenu onSignOut={shell.signOut} />
        </header>

        {/* -------------------------------------------------------------- */}
        {/*  菜单栏                                                         */}
        {/* -------------------------------------------------------------- */}
        <nav className="menubar" aria-label="主菜单">
          {shell.navGroups.map((group) => (
            <MenuButton key={group.label} group={group} />
          ))}
        </nav>

        {/* -------------------------------------------------------------- */}
        {/*  工具栏（页面 portal 进来的内容）                                */}
        {/* -------------------------------------------------------------- */}
        {/*
          ⚠️ **这一条永远渲染，哪怕当前页面没有动作。**

          条件渲染会让工作区在页面之间跳 40px —— 切换页面时整块内容上下弹
          一下，而"这一页没有工具栏"这件事用户看不出来（他只看到内容跳了）。
          高度恒定、内容为空，是这里唯一正确的做法。

          两个槽的 id 定义在 `templates/ids.ts`：页面用 `<PageActions>` 往里投，
          而**不渲染它们的模板不会丢功能** —— 那种情况下 `PageActions` 会
          把同样的动作就地显示。
        */}
        <div className="toolbar">
          <div id={TOOLBAR_START_ID} className="contents" />
          <span className="min-w-2 flex-1" />
          <div id={TOOLBAR_END_ID} className="contents" />
        </div>

        {/* -------------------------------------------------------------- */}
        {/*  工作区：侧栏 + 内容                                             */}
        {/* -------------------------------------------------------------- */}
        <div className="workbench">
          <nav className="sidebar" aria-label="主导航">
            {shell.navGroups.map((group) => (
              <div key={group.label} className="contents">
                <div className="nav-group-label">{group.label}</div>
                {group.items.map((item) => (
                  <NavItemLink
                    key={item.to}
                    item={item}
                    badge={item.to === '/traders' ? shell.runningCount : 0}
                  />
                ))}
              </div>
            ))}
          </nav>

          {/*
            内容区。`overflow-y-auto` 留在这里（而不是移到每个页面）的原因：
            长表格滚动时标题栏 / 工具栏必须钉住。

            两栏页面的右栏要"填满屏高并独立滚动"，靠的是 `PageShell` 在
            `h-full` 里拿到的确定高度 —— 所以这里绝不能给它加 padding，
            否则那条高度链就断了（内边距由页面自己的 `.page-pad` 负责）。

            ⚠️ **它就是那个滚动容器，而且它有 id。** 页面里有些功能
            （帮助页的目录跟随高亮）要监听它的 `scroll` 事件；没有这个 id
            它们会静默失效，而页面看起来毫无异常。
          */}
          <main id={MAIN_SCROLL_ID} className="content">
            <Outlet />
          </main>
        </div>

        {/* -------------------------------------------------------------- */}
        {/*  状态栏                                                         */}
        {/* -------------------------------------------------------------- */}
        <StatusBar />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/*  窄屏抽屉（`< 56em`：导航链接收进汉堡菜单，LAYOUT.md §1）          */}
      {/* ---------------------------------------------------------------- */}
      <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DialogPrimitive.Portal>
          {/* 对话框的模糊保留：它只在打开时存在，不是常驻的 backdrop-filter（§4） */}
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-overlay backdrop-blur-sm min-[56em]:hidden" />
          <DialogPrimitive.Content className="nav-drawer fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r border-base-700 min-[56em]:hidden">
            <DialogPrimitive.Title className="sr-only">导航</DialogPrimitive.Title>
            <div className="flex items-center gap-2 border-b border-base-700 px-3 py-2.5">
              <Brand />
              <div className="flex-1" />
              <Button size="icon" variant="ghost" aria-label="关闭导航" onClick={() => setDrawerOpen(false)}>
                <X aria-hidden className="h-4 w-4" />
              </Button>
            </div>
            <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
              {shell.navGroups.map((group) => (
                <div key={group.label} className="contents">
                  <div className="nav-group-label">{group.label}</div>
                  {group.items.map((item) => (
                    <NavItemLink
                      key={item.to}
                      item={item}
                      badge={item.to === '/traders' ? shell.runningCount : 0}
                      onNavigate={() => setDrawerOpen(false)}
                    />
                  ))}
                </div>
              ))}
            </nav>
            <div className="border-t border-base-700 p-2">
              <Button block onClick={shell.signOut}>
                <LogOut aria-hidden className="h-3.5 w-3.5" />
                退出登录
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  标题栏零件                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 品牌标记：一条**斜向的权益曲线**，不是两个字母。
 *
 * "AQ" 方块是默认做法，代价是它传递的信息为零 —— 任何产品换成任何缩写都成立。
 * 这里画一条上扬的折线，配合一个端点圆点：它说的是这个产品**做什么**
 * （跟踪一条随时变动的权益曲线），而不是它叫什么。
 */
function Brand() {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-accent/40 bg-accent/15">
        <svg viewBox="0 0 20 20" aria-hidden className="h-3 w-3 text-accent">
          <path
            d="M2 14.5 L7 9.5 L11.5 12.5 L18 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="18" cy="4.5" r="2" fill="currentColor" />
        </svg>
      </span>
      <span className="hidden truncate font-semibold tracking-tight text-ink-hi sm:inline">AutoQuant</span>
    </span>
  );
}

/**
 * 主题切换：一个图标按钮，点一下就翻，`title` 里说清当前是哪一套。
 *
 * ## 为什么不做成设置页里的一项
 *
 * 主题是**随时会切**的东西（白天/夜里、开灯/关灯），把它埋进设置里意味着
 * 每次切都要点三次。一个按钮一次点击，代价只是标题栏上 24px。
 *
 * ## 为什么状态放在 `useState` 而不是 store
 *
 * 真正的值在 `<html data-skin>` 上（CSS 唯一的真相来源），这里只是为了让
 * 图标跟着变而镜像一份。放进全局 store 会多出一条"两处状态要同步"的路径，
 * 而这里读一次初值就够了 —— 外观页改了主题之后会重新挂载到这一页，届时
 * 初值自然是对的。
 */
function SkinToggle() {
  const [skin, setLocalSkin] = useState<Skin>(() => getSkin());

  /*
   * 外观页也能切主题，而它在**同一个外壳里**换页 —— 组件不会重新挂载。
   * 不跟着外部变化的话，图标会一直停在上一次点它时的状态：切了主题、
   * 图标却还是月亮。所以订阅外观变化事件（`appearance.ts` 派发）。
   */
  useEffect(() => {
    const sync = () => setLocalSkin(getSkin());
    window.addEventListener(APPEARANCE_EVENT, sync);
    return () => window.removeEventListener(APPEARANCE_EVENT, sync);
  }, []);

  const toggle = () => {
    const next: Skin = skin === 'dark' ? 'light' : 'dark';
    setSkin(next);
    setLocalSkin(next);
  };

  const dark = skin === 'dark';
  return (
    <Tooltip
      side="bottom"
      content={dark ? '当前：深色外观。点击切到浅色。' : '当前：浅色外观。点击切到深色。'}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={dark ? '切换到浅色外观' : '切换到深色外观'}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-base-600 bg-base-800 text-ink-lo transition hover:text-ink-mid"
      >
        {dark ? <Moon aria-hidden className="h-3.5 w-3.5" /> : <Sun aria-hidden className="h-3.5 w-3.5" />}
      </button>
    </Tooltip>
  );
}

/**
 * 操作员菜单：身份 + 退出登录。
 *
 * 以前这里是**一个孤零零的退出按钮**，而身份只写在 `title` 里 ——
 * 也就是说：想知道"我现在是谁"必须悬停，而想退出只要一次误点。
 * 现在身份是菜单的第一行（看得见），退出在它下面（要点两下）。
 *
 * ## 为什么用 Popover 而不是 DropdownMenu
 *
 * `@radix-ui/react-dropdown-menu` **不在依赖里**（见 `package.json`），
 * 而 Popover 已经在用（顶栏的设置下拉、机器人行的溢出菜单）。为一个菜单
 * 多引入一个依赖，代价是每个下游都要重新 `npm install` —— 而这个菜单
 * 只有两项，Popover 提供的"外部点击关闭 / Esc 关闭 / 焦点管理"已经覆盖了
 * 全部需要。`role="menu"` 是本文件手动补上的语义。
 */
function UserMenu({ onSignOut }: { onSignOut: () => void }) {
  const user = useApp((s) => s.user);
  const role = user?.role ? userRoleLabel(user.role) : '';
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  // 跳页之后 popover 不会自己知道，得手动关（与顶栏的设置下拉同一处处理）。
  useEffect(() => setOpen(false), [pathname]);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1.5 rounded border border-transparent px-1.5 text-xs text-ink-lo transition hover:border-base-600 hover:bg-base-800 hover:text-ink-mid"
          title={`${user?.username ?? '—'}${role ? ` · ${role}` : ''}`}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[10px] font-semibold text-accent">
            {(user?.username ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden max-w-24 truncate lg:inline">{user?.username ?? '—'}</span>
          <ChevronDown aria-hidden className="h-3 w-3 shrink-0" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={4}
          role="menu"
          className="z-50 min-w-52 rounded-md border border-base-700 bg-base-900 p-1 shadow-overlay"
        >
          <div className="px-2.5 py-1.5">
            <div className="truncate text-base text-ink-hi">{user?.username ?? '—'}</div>
            <div className="truncate text-xs text-ink-faint">{role || '未知角色'}</div>
          </div>
          <div className="my-1 h-px bg-base-700" />
          <button
            type="button"
            role="menuitem"
            onClick={onSignOut}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left text-base text-ink-mid transition hover:bg-accent-soft hover:text-accent-hi"
          >
            <LogOut aria-hidden className="h-3.5 w-3.5 shrink-0" />
            退出登录
          </button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * 菜单栏上的一组下拉。
 *
 * 菜单栏的**职责边界**：只放"偶尔点、但必须随时能找到"的东西 ——
 * 视图跳转、全局刷新、帮助。高频动作（新建、筛选）属于工具栏；
 * 全局状态（连接、环境）属于状态栏。三者的分工写在 `LAYOUT.md` §0。
 */
function MenuButton({ group }: { group: NavGroup }) {
  const navigate = useNavigate();
  const refreshSystem = useApp((s) => s.refreshSystem);
  const refreshTraders = useApp((s) => s.refreshTraders);
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            'rounded px-2 py-0.5 text-base text-ink-mid transition hover:bg-accent-soft hover:text-accent-hi',
            open && 'bg-accent-soft text-accent-hi',
          )}
        >
          {group.label}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={2}
          role="menu"
          className="z-50 min-w-56 rounded-md border border-base-700 bg-base-900 p-1 shadow-overlay"
        >
          {group.items.map((item) => (
            <button
              key={item.to}
              type="button"
              role="menuitem"
              onClick={() => navigate(item.to)}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left text-base text-ink-mid transition hover:bg-accent-soft hover:text-accent-hi"
            >
              <item.icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <kbd className="num shrink-0 text-xs text-ink-faint">g {item.jump}</kbd>
            </button>
          ))}

          {/*
            「交易」是唯一带通用动作的一组 —— 刷新不属于任何单独一页，
            而它又是"我必须能立刻做"的那一个。
          */}
          {group.label === '交易' && (
            <>
              <div className="my-1 h-px bg-base-700" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void refreshSystem();
                  void refreshTraders();
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left text-base text-ink-mid transition hover:bg-accent-soft hover:text-accent-hi"
              >
                <RefreshCw aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                立即刷新数据
              </button>
            </>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * 状态栏。
 *
 * ## 它装的是"全局的、只读的事实"
 *
 * 推送连接、环境（模拟/实盘）、运行中的循环数、时钟偏差、API 权重、操作员、
 * 当前时间。这些数字以前挤在顶栏右侧和操作按钮抢空间。放到最底下一行之后
 * 它们不占任何内容高度，但需要时永远在同一个位置 —— **知道去哪看，
 * 和看得到同样重要**。
 *
 * ⚠️ 越界项（时钟、权重）在这里只**变色**，告警本身在标题栏 ——
 * 状态栏只有 26px，塞不下"后果"那句话，而一个不带后果的红色数字只会让人
 * 焦虑（`LAYOUT.md` §5）。
 */
function StatusBar() {
  const shell = useShell();
  // 秒针：`useTicker` 每 1000ms 触发一次重渲染 —— 只有这一格会变。
  const now = useTicker(1000);

  const clockWarn = Math.abs(shell.system?.clockOffsetMs ?? 0) > 2000;
  const online = shell.socketStatus === 'open';

  return (
    <footer className="statusbar">
      <span
        className="cell"
        title={
          shell.socketBlockedReason !== null
            ? `${shell.socketBlockedReason}。登录之后会自动重新连接。`
            : online
              ? '实时事件推送已连接，行情与委托变化会立即推到这个页面。'
              : '实时推送不可用，页面已自动降级为轮询：数据仍会更新，只是延迟更大。无需手动操作，系统会自动重连。'
        }
      >
        <Dot
          tone={online ? 'up' : shell.socketStatus === 'connecting' ? 'warn' : 'down'}
          pulse={online === false && shell.socketBlockedReason === null}
        />
        {shell.socketBlockedReason !== null
          ? shell.socketBlockedReason
          : online
            ? '推送在线'
            : shell.socketStatus === 'connecting'
              ? '连接中'
              : '轮询兜底'}
      </span>

      {/*
        **系统状态停更**（2026-10-17 · 台账 FRD-01）。
        状态栏只有 26px，所以这里只放这一句短话 —— 后果写在 `title` 里，
        与"越界项只变色、告警在标题栏"的既有约定一致（见上面那段注释）。
      */}
      {shell.statusStale && (
        <span
          className="cell text-warn"
          title={`最近一次读取系统状态失败${shell.statusError ? `：${shell.statusError}` : ''}。下面这些读数（推送/环境/运行数）都是上一次成功读到的，可能已经过期。`}
        >
          <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
          {shell.statusStaleLabel}
        </span>
      )}

      <span className="cell" title={`接口端点：${shell.system?.environmentLabel ?? '连接中…'}`}>
        <Dot tone={shell.system?.dryRun ? 'accent' : 'warn'} />
        {shell.system?.dryRun ? '模拟盘' : '实盘'}
      </span>

      <span className="cell num" title="正在运行的机器人数量">
        运行 {fmtInt(shell.runningCount)}
      </span>

      <span className={cn('cell num', clockWarn && 'text-warn')} title="本地时钟与交易所时钟的偏差">
        时钟 {fmtClockOffset(shell.system?.clockOffsetMs)}
      </span>

      {shell.weightPercent > 0 && (
        <span
          className={cn('cell num hidden md:flex', shell.weightWarn && 'text-warn')}
          title="当前分钟已消耗的交易所请求权重"
        >
          权重 {shell.weightPercent}%
        </span>
      )}

      <span className="cell grow" />

      <span className="cell hidden min-[56em]:flex">{shell.user?.username ?? '—'}</span>
      <span className="cell num">{new Date(now).toLocaleString('zh-CN', { hour12: false })}</span>
    </footer>
  );
}

/**
 * 一个导航项（侧栏与抽屉共用）。
 *
 * 选中态由 `.nav-item.active` 负责 —— 底色 + 边框 + 阴影 + **左侧 3px 主色条**。
 * 四样东西同时标记，是因为侧栏是渐变底：只换底色的话，"选中"和"hover"
 * 看起来一样。
 */
function NavItemLink({
  item,
  badge,
  onNavigate,
}: {
  item: NavItem;
  badge: number;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      className={({ isActive }) => cn('nav-item', isActive && 'active')}
    >
      {({ isActive }) => (
        <>
          <item.icon
            aria-hidden
            className={cn('h-4 w-4 shrink-0', isActive ? 'text-accent' : 'text-ink-faint')}
          />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {badge > 0 && (
            <span
              className="num shrink-0 rounded-full border border-up/40 bg-up/10 px-1.5 text-xs text-up"
              title={`${badge} 个循环在运行`}
            >
              {badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

/**
 * 路径 → 标题栏里显示的文档名。
 *
 * ⚠️ **它只服务标题栏，不服务页面标题。** 页面自己的大标题由各页面的
 * `SectionHeading` 渲染 —— 两处都要有，因为它们回答的是不同的问题：
 * 标题栏说"这个窗口现在打开的是什么"，页面标题说"这一屏要你干什么"。
 *
 * 详情页（`/traders/12`）落回所属列表的名字：显示 `#12` 对读者没有意义，
 * 而"机器人"至少说清了他在哪一类页面上。
 */
function currentTitle(pathname: string, items: NavItem[]): string {
  const exact = items.find((item) => item.to === pathname);
  if (exact) return exact.label;
  const prefix = items.filter((item) => item.to !== '/').find((item) => pathname.startsWith(`${item.to}/`));
  if (prefix) return prefix.label;
  if (pathname.startsWith('/settings')) return '设置';
  return 'AutoQuant';
}
