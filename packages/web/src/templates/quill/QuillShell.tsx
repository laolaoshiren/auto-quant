/**
 * **quill 模板** —— 一个安静的桌面工具。
 *
 * 设计语言借鉴自 [magpie](https://github.com/yetone/magpie)：中性、克制、
 * 圆润、信息密度高但呼吸均匀。骨架是「侧栏 + 分段控件」双层导航：
 *
 * ```
 * ┌────────────┬──────────────────────────────────────────────────┐
 * │  AutoQuant │  交易 / 机器人 / 策略工作室 / 行情 / 数据与日志    │  ← 分段控件
 * │            ├──────────────────────────────────────────────────┤
 * │  交易       │  刷新 · 筛选            ……            新建机器人   │  ← 工具栏（页面 portal）
 * │   ▸ 总览    ├──────────────────────────────────────────────────┤
 * │   ▸ 机器人② │                                                  │
 * │   ▸ 策略    │  工作区（**唯一滚动层**）                         │
 * │   ▸ 行情    │                                                  │
 * │   ▸ 数据    │                                                  │
 * │            │                                                  │
 * │  系统       │                                                  │
 * │   ▸ AI 模型 │                                                  │
 * │   ▸ 交易所  │                                                  │
 * │            │                                                  │
 * │  ⚙ 操作员   │                                                  │
 * └────────────┴──────────────────────────────────────────────────┘
 * ```
 *
 * ## 这个文件里没有任何业务逻辑
 *
 * 数据从 `useShell()` 拿，动作由页面自己 portal 进工具栏。页面不知道自己在
 * 什么壳里，外壳不知道"机器人"是什么 —— 两者之间只有 `templates/types.ts`
 * 那份接口。想看三套外壳的差别，把这个文件与 `../classic/ClassicShell.tsx`、
 * `../console/ConsoleShell.tsx` 并排读就够了。
 *
 * ## 几条不能破坏的约束
 *
 * - **内容区要有 `id={MAIN_SCROLL_ID}`，且它要是真正的滚动容器**（不是手写
 *   字符串 —— `registry.test.ts` 逐文件断言这一点）。
 * - **必须渲染 `<TemplateSwitcher />`**（同上，漏了用户会被困在这套模板里）。
 * - **不要渲染 `<Toaster />` / `<CommandPalette />`，也不要调 `connect()`** ——
 *   它们由 `ShellRuntime` 统一调度，而那个组件包在模板**外面**。重复做会导致
 *   toast 出两次、连上两条 WebSocket，或者切模板时推送断两秒。
 * - **不许 import `templates/store`** —— store → registry → 外壳 → store 是
 *   一条**求值期闭合**的环，症状是整站白屏（不是某块功能不工作）。
 * - **常驻的 `backdrop-filter` 一律不用**（`LAYOUT.md` §4）：它曾导致整页在
 *   部分 GPU / 远程桌面环境下均匀发虚，而布局完全正常，极难定位。浮层的
 *   临时模糊保留（见 `theme.css` 的 `.q-pop`）。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  ChevronsUpDown,
  LogOut,
  Menu,
  Moon,
  RefreshCw,
  Search,
  Sun,
  TriangleAlert,
  X,
} from 'lucide-react';
import { userRoleLabel } from '@aq/shared';
import { useApp } from '../../lib/store';
import { fmtClockOffset } from '../../lib/format';
import { Badge, Dot, Tooltip, cn } from '../../components/ui';
import type { NavGroup, NavItem } from '../../components/nav';
import { MAIN_SCROLL_ID, TOOLBAR_END_ID, TOOLBAR_START_ID } from '../ids';
import { useShell } from '../lib/context';
import { APPEARANCE_EVENT, getSkin, setSkin, type Skin } from '../lib/appearance';
import { TemplateSwitcher } from '../lib/TemplateSwitcher';

/**
 * 侧栏／汉堡按钮共用的断点。
 *
 * ⚠️ **它必须与 `theme.css` 里 `@media (max-width: 56em)` 是同一个数。**
 * 两处不一致会在中间那段宽度里出现"侧栏已经收起来了、而汉堡按钮还藏着"的
 * 空档 —— 那一段的用户点不到任何导航。
 *
 * 为什么不用 Tailwind 的 `lg`（64em）：`lg` 与 56em 之间有 128px 的缝，
 * 而侧栏的折叠由 CSS 的 56em 决定。两套断点混用是这类空档的常见来源。
 */
const DESKTOP_NAV_QUERY = '(min-width: 56em)';

/** 侧栏宽度记在 localStorage（用户拖过就记住）。 */
const SIDE_KEY = 'aq.quill.side';

const SIDE_MIN = 184;
const SIDE_MAX = 320;

export function QuillShell() {
  const shell = useShell();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  /*
   * 当前页面名。
   *
   * 在组件里算，而不是抽一个内部函数去读 `useShell()` —— 后者会让"读数据"
   * 藏在一个看起来像纯函数的名字后面（`currentTitle(path)`），而 hooks
   * 的调用位置就不再一眼可见了。
   */
  const pageLabel = currentTitle(location.pathname, shell.navItems);

  /*
   * 当前分组 —— 分段控件只列**这一组**的页面。
   *
   * 导航是三层结构：侧栏给分组、分段控件给组内页面。当前在哪个组由路由反推
   * （`navGroups` 里哪一组包含当前路径），而不是另存一份状态 —— 那样会出现
   * "状态与 URL 不一致"的中间态（用户用浏览器后退时尤其明显）。
   */
  const activeGroup = useMemo(() => {
    const groups = shell.navGroups;
    for (const group of groups) {
      if (group.items.some((item) => matches(item.to, location.pathname))) return group;
    }
    return groups[0] ?? null;
  }, [shell.navGroups, location.pathname]);

  const side = useSideWidth();

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
    <div className="q-root" style={{ ['--aq-side-w' as string]: `${side.width}px` }}>
      {/* ---------------------------------------------------------------- */}
      {/*  侧栏                                                            */}
      {/* ---------------------------------------------------------------- */}
      <aside className="q-side">
        <div className="q-brand">
          <Brand />
        </div>

        <nav className="q-nav" aria-label="主导航">
          {shell.navGroups.map((group) => (
            <div key={group.label}>
              <div className="q-nav-group">{group.label}</div>
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

        <div className="q-side-foot">
          <UserMenu onSignOut={shell.signOut} />
        </div>

        {/*
          拖拽条。热区 8px 贴在右边缘外侧（1px 的线没人能精确命中）。
          键盘也能调 —— `role="separator"` + 方向键，这样不用鼠标的用户
          同样能改宽度。
        */}
        <div
          className="q-side-edge"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuenow={side.width}
          aria-valuemin={SIDE_MIN}
          aria-valuemax={SIDE_MAX}
          tabIndex={0}
          onPointerDown={side.startDrag}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') side.nudge(-16);
            else if (event.key === 'ArrowRight') side.nudge(16);
            else if (event.key === 'Home') side.reset();
          }}
        />
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/*  主区                                                            */}
      {/* ---------------------------------------------------------------- */}
      <div className="q-main">
        <header className="q-head">
          {/*
            窄屏上的汉堡按钮。宽屏时侧栏常驻，这个按钮不存在。
            ⚠️ 断点必须是 `min-[56em]:hidden`，与 theme.css 里侧栏收起的
            媒体查询同源（见 DESKTOP_NAV_QUERY 的说明）。
          */}
          <button
            type="button"
            /*
             * ⚠️ `is-mobile-only` 这个类**不能省**，而且**不能**只靠
             * `min-[56em]:hidden`。
             *
             * `.q-icon-btn` 在 theme.css 里带 `display: inline-flex`（0,2,1），
             * 而 `min-[56em]:hidden` 是 0,1,0 —— 媒体查询不增加特异性，
             * 所以宽屏上那条 `hidden` 永远输，汉堡按钮会永久可见。
             * theme.css 里有一条 `@media (min-width: 56em)` 的规则负责隐藏
             * 带这个类的东西（与 `DESKTOP_NAV_QUERY` 同断点）。
             */
            className="q-icon-btn is-mobile-only"
            aria-label="打开导航"
            aria-expanded={drawerOpen}
            aria-haspopup="dialog"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden className="h-4 w-4" />
          </button>

          {/*
            当前页面名。**不是大标题** —— 页面自己的内容区会渲染 `<h1>`/`<h2>`
            （`SectionHeading` 是 text-xl），这里只是"我在哪"的一句话。
          */}
          <span className="q-crumb">{pageLabel}</span>

          <div className="q-spring" />

          {/*
            全局风控告警。
            这几条是**诊断值**：正常时完全不出现，异常时带后果（`title` 里
            写清会发生什么）。常驻一个"时钟正常"的绿色徽章只会稀释真正
            需要看的那几条（`LAYOUT.md` §5）。
          */}
          {shell.system?.tradingDisabled && (
            <Tooltip content="开仓会被 GLOBAL_TRADING_DISABLED 拦截；平仓与对账仍然可用。">
              <Badge tone="down" className="hidden shrink-0 animate-pulse-soft sm:inline-flex">
                <Dot tone="down" />
                交易已禁用
              </Badge>
            </Tooltip>
          )}

          {shell.clockWarn && (
            <Tooltip content="本地时钟与交易所时钟相差超过 2 秒。签名请求会因时间戳超窗被拒绝（-1021），下单与撤单都会失败。请校准服务器时间（NTP）。">
              <Badge tone="warn" className="hidden shrink-0 md:inline-flex">
                <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                {fmtClockOffset(shell.system?.clockOffsetMs)}
              </Badge>
            </Tooltip>
          )}

          {shell.weightWarn && (
            <Tooltip content="当前分钟已消耗的请求权重接近上限。继续升高会被交易所临时封禁 IP（418），届时所有行情与交易请求都会失败。">
              <Badge tone="warn" className="hidden shrink-0 md:inline-flex">
                <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                {shell.weightPercent}%
              </Badge>
            </Tooltip>
          )}

          {/*
            **系统状态停更**（2026-10-17 · 台账 FRD-01）。
            与上面几条同类：正常时不出现；出现时说的是"这些读数有多旧"，
            而不是只报一个状态词。
          */}
          {shell.statusStale && (
            <Tooltip
              content={`最近一次读取系统状态失败${shell.statusError ? `：${shell.statusError}` : ''}。页面显示的是上一次成功读到的读数。`}
            >
              <Badge tone="warn" className="hidden shrink-0 md:inline-flex">
                <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                {shell.statusStaleLabel}
              </Badge>
            </Tooltip>
          )}

          {/*
            刷新。全局动作 —— 它不属于任何单独一页，而"数据是不是最新的"
            是盯盘时最常问的问题。放在头部而不是工具栏，是因为工具栏属于
            页面（页面自己的动作在那里）。
          */}
          <Tooltip content="立即刷新系统状态与机器人列表（推送正常时也会自动刷新）">
            <RefreshButton />
          </Tooltip>

          {/*
            搜索入口。写着 ⌘K 是要让人**发现**快捷键，而不是把它藏进文档。
            ⚠️ 这里只开面板，**不渲染 `<CommandPalette>`** —— 它由
            `ShellRuntime` 统一渲染，模板再渲染一次会出现两个面板。
          */}
          <button
            type="button"
            onClick={() => shell.setPaletteOpen(true)}
            aria-label="打开命令面板"
            title="打开命令面板（⌘K）—— 快速跳转、切换机器人、启动或停止"
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-ink-lo transition hover:bg-base-850 hover:text-ink-mid"
          >
            <Search aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="num hidden text-xs min-[64em]:inline">⌘K</span>
          </button>

          <SkinToggle />

          {/* 模板切换器：每套外壳都必须渲染它，`registry.test.ts` 逐文件断言。 */}
          <TemplateSwitcher />
        </header>

        {/* -------------------------------------------------------------- */}
        {/*  分段控件：当前分组的页面                                          */}
        {/* -------------------------------------------------------------- */}
        {activeGroup && activeGroup.items.length > 1 && (
          <div className="q-seg-wrap">
            <GroupSeg group={activeGroup} />
          </div>
        )}

        {/* -------------------------------------------------------------- */}
        {/*  工具栏（页面 portal 进来的内容）                                 */}
        {/* -------------------------------------------------------------- */}
        {/*
          ⚠️ **这一条永远渲染，哪怕当前页面没有动作**（理由见 theme.css 里
          `.q-toolbar` 那段）。两个槽的 id 定义在 `templates/ids.ts`：页面用
          `<PageActions>` 往里投，而**不渲染它们的模板不会丢功能** ——
          那种情况下 `PageActions` 会把同样的动作就地显示。
        */}
        <div className="q-toolbar">
          <div id={TOOLBAR_START_ID} className="contents" />
          <span className="min-w-2 flex-1" />
          <div id={TOOLBAR_END_ID} className="contents" />
        </div>

        {/*
          工作区 —— **整个应用唯一的滚动层**。
          长表格滚动时头部、分段控件、工具栏全部钉住。
        */}
        <main id={MAIN_SCROLL_ID} className="q-work">
          <div className="q-pad">
            <Outlet />
          </div>
        </main>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/*  窄屏抽屉（`< 56em`：侧栏收进汉堡菜单）                            */}
      {/* ---------------------------------------------------------------- */}
      <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DialogPrimitive.Portal>
          {/*
            对话框的模糊保留：它只在打开时存在，不是常驻的 backdrop-filter（§4）。

            ⚠️ 遮罩与内容都带 `q-drawer-overlay` / `q-drawer` —— theme.css 里
            有一条 `@media (min-width: 56em)` 的规则把它们隐藏（理由同上面
            汉堡按钮那段：模板的 `display` 会压过 `min-[56em]:hidden`）。
          */}
          <DialogPrimitive.Overlay className="q-drawer-overlay fixed inset-0 z-50 animate-fade-in bg-overlay backdrop-blur-sm" />
          <DialogPrimitive.Content className="q-drawer">
            <DialogPrimitive.Title className="sr-only">导航</DialogPrimitive.Title>
            <div className="flex items-center gap-2 px-3.5 py-3">
              <Brand />
              <div className="flex-1" />
              <button
                type="button"
                className="q-icon-btn"
                aria-label="关闭导航"
                onClick={() => setDrawerOpen(false)}
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            </div>
            <nav aria-label="主导航" className="q-nav">
              {shell.navGroups.map((group) => (
                <div key={group.label}>
                  <div className="q-nav-group">{group.label}</div>
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
            <div className="q-side-foot">
              <button
                type="button"
                className="q-pop-item"
                onClick={() => {
                  setDrawerOpen(false);
                  shell.signOut();
                }}
              >
                <LogOut aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-lo" />
                退出登录
              </button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  导航                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 一条路由是否命中当前路径。
 *
 * 用前缀匹配而不是全等，因为详情页（`/traders/7`、`/strategy/12`）要让它
 * 所属的列表项保持高亮 —— 否则用户点进详情之后，侧栏会显示"没有任何一项
 * 被选中"，看起来像导航坏了。
 *
 * `/` 必须单独处理：它是所有路径的前缀，`startsWith('/')` 永远为真。
 */
function matches(to: string, pathname: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

function NavItemLink({
  item,
  badge,
  onNavigate,
}: {
  item: NavItem;
  /** 右侧计数（当前只有 `/traders` 用它显示运行中的数量）。0 表示不显示。 */
  badge: number;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      className={({ isActive }) => cn('q-nav-item', isActive && 'is-active')}
      title={`${item.label}（g ${item.jump}）`}
    >
      <Icon aria-hidden className="q-nav-icon" />
      <span className="q-nav-label">{item.label}</span>
      {badge > 0 && (
        <span className="q-nav-count" title={`${badge} 个机器人正在运行`}>
          {badge}
        </span>
      )}
    </NavLink>
  );
}

/**
 * 分段控件 —— 当前分组的页面。
 *
 * ## 它解决什么问题
 *
 * 原版顶栏把九个页面平铺成一行，每一项都又窄又挤。侧栏分组之后，导航有了
 * 层级；但"在「交易」组里从总览跳到行情"仍然要走侧栏（视线要下移、再上移）。
 * 分段控件把**当前分组**的页面放在内容正上方，视线不用离开工作区。
 *
 * ## thumb 为什么要用 JS 驱动
 *
 * 选中背景是一块**独立的、会滑过去的矩形**（magpie 的招牌交互），而不是
 * 每个按钮自己换底色。区别在动效：`transition` 只有作用在**同一个元素**上
 * 才会产生"滑动"这个视觉；按钮各自换底色只能得到"这里暗下去、那里亮起来"。
 *
 * 位置用 `offsetLeft` / `offsetWidth` 量（而不是按 index 算百分比）——
 * 因为中文标签的宽度不一样（「总览」2 字、「策略工作室」5 字），
 * 按等分算会让 thumb 和文字对不齐。
 */
function GroupSeg({ group }: { group: NavGroup }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const location = useLocation();
  const navigate = useNavigate();

  /*
   * 当前项。取 `navGroups` 里的**顺序**而不是路由表 —— 两个来源会漂。
   */
  const activeIndex = group.items.findIndex((item) => matches(item.to, location.pathname));

  const place = useCallback((animate: boolean) => {
    const box = boxRef.current;
    const thumb = thumbRef.current;
    if (!box || !thumb) return;
    const active = box.querySelector<HTMLElement>('.q-seg-item.is-active');
    if (!active) {
      thumb.style.opacity = '0';
      return;
    }
    thumb.style.opacity = '';
    /*
     * 不带动画直接落位：`is-still` 关掉 transition，写完样式后强制一次
     * reflow，再摘掉那个类 —— 否则下一次真正的切换会从"上一次的位置"
     * 开始滑，看起来像多滑了一段。
     */
    if (!animate) thumb.classList.add('is-still');
    thumb.style.transform = `translateX(${active.offsetLeft}px)`;
    thumb.style.width = `${active.offsetWidth}px`;
    if (!animate) {
      // 读一次布局属性，强制浏览器在摘掉类之前应用上面两行。
      void thumb.offsetWidth;
      thumb.classList.remove('is-still');
    }
  }, []);

  /*
   * 首次挂载与切换时定位。
   *
   * `useLayoutEffect` 而不是 `useEffect`：后者跑在浏览器绘制**之后**，
   * 用户会看到 thumb 先出现在左边缘、再滑到当前项 —— 而进页面时那次
   * 滑动是"没有来由的动画"（用户没做任何操作）。
   */
  useLayoutEffect(() => {
    place(true);
  }, [activeIndex, place, group.label]);

  /*
   * 尺寸变化时重新落位（不带滑动的动画）。
   *
   * 字体晚加载、窗口缩放、语言切换都会改变按钮宽度 —— 不重新量的话
   * thumb 会停在旧位置，看起来"高亮错了地方"。
   *
   * `ResizeObserver` 观察**容器**：按钮变宽时容器通常也会变，而观察容器
   * 只需要一个 observer（观察每个按钮要 N 个）。
   */
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(box);
    return () => observer.disconnect();
  }, [place]);

  /*
   * 切换。
   *
   * ⚠️ **thumb 先动，数据后到** —— 这是 magpie 的 `slide()` 里那句
   * 「先把 `.on` 切一遍，然后 `slide()`，最后才 `onPick(id)`」的意思。
   * 在 React 里，这意味着不能等 `navigate()` 触发重渲染之后才动 thumb：
   * 那样会先看到页面内容变了、然后 thumb 才慢慢滑过去，两件事不同步。
   */
  const pick = (to: string) => {
    if (matches(to, location.pathname)) return;
    navigate(to);
  };

  return (
    <div className="q-seg" ref={boxRef} role="tablist" aria-label={`${group.label}组页面`}>
      <span className="q-seg-thumb" ref={thumbRef} aria-hidden />
      {group.items.map((item) => {
        const active = matches(item.to, location.pathname);
        return (
          <button
            key={item.to}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => pick(item.to)}
            className={cn('q-seg-item', active && 'is-active')}
            title={`${item.label}（g ${item.jump}）`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  头部零件                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 品牌标记：一条**上扬的权益曲线**，不是两个字母。
 *
 * "AQ" 方块是默认做法，代价是它传递的信息为零 —— 任何产品换成任何缩写都
 * 成立。这里画一条折线加一个端点圆点：它说的是这个产品**做什么**
 * （跟踪一条随时变动的权益曲线），而不是它叫什么。
 */
function Brand() {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
        <svg viewBox="0 0 20 20" aria-hidden className="h-3.5 w-3.5">
          <path
            d="M2.5 14.5 L7.5 9.5 L11.5 12.5 L17.5 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="17.5" cy="5" r="1.9" fill="currentColor" />
        </svg>
      </span>
      <span className="q-brand-name">AutoQuant</span>
    </span>
  );
}

/**
 * 全局刷新。
 *
 * 它是**唯一带通用动作**的头部按钮 —— 刷新不属于任何单独一页，而"数据是不是
 * 最新的"是盯盘时最常问的问题。转一圈的反馈是刻意的：接口快的时候它几乎
 * 看不见，慢的时候用户知道"它在做事"（`DESIGN.md` §6：超过 300ms 的操作
 * 都要有加载态）。
 *
 * ## ⚠️ `forwardRef` 在这里不是装饰
 *
 * 它被当作 `<Tooltip>` 的子元素用，而 `Tooltip` 内部是
 * `<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>` ——
 * Radix 的 `asChild` 会给子元素**挂一个 ref**，靠它定位气泡。
 *
 * 普通函数组件没有 ref 通道，React 于是打印「Function components cannot be
 * given refs」**并把 ref 丢掉**：气泡失去锚点、位置不再跟着按钮走。这个过程
 * 界面看起来完全正常，只有控制台里那一条警告 —— 属于"没人会去查"的故障。
 * 实测踩到过（真浏览器里抓到的控制台报错），所以这里与 `SkinToggle` 都显式
 * 转发 ref。项目里 `Badge` / `Dot` / `Button` 早就这么写了，理由相同。
 */
const RefreshButton = forwardRef<HTMLButtonElement>(function RefreshButton(_props, ref) {
  const refreshSystem = useApp((s) => s.refreshSystem);
  const refreshTraders = useApp((s) => s.refreshTraders);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await Promise.all([refreshSystem(), refreshTraders()]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => void run()}
      disabled={busy}
      aria-label="刷新数据"
      className="q-icon-btn disabled:opacity-50"
    >
      <RefreshCw aria-hidden className={cn('h-4 w-4', busy && 'animate-spin')} />
    </button>
  );
});

/**
 * 主题切换：一个图标按钮，点一下就翻。
 *
 * ## 为什么不做成设置页里的一项
 *
 * 主题是**随时会切**的东西（白天/夜里、开灯/关灯），把它埋进设置里意味着
 * 每次切都要点三次。一个按钮一次点击，代价只是头部 28px。
 *
 * ## 为什么状态放在 `useState` 而不是 store
 *
 * 真正的值在 `<html data-skin>` 上（CSS 唯一的真相来源），这里只是为了让
 * 图标跟着变而镜像一份。放进全局 store 会多出一条"两处状态要同步"的路径。
 *
 * ## 为什么还要订阅事件
 *
 * 外观页也能切主题，而它在**同一个外壳里**换页 —— 组件不会重新挂载。
 * 不跟着外部变化的话，图标会一直停在上一次点它时的状态：切了主题、
 * 图标却还是月亮。
 *
 * `forwardRef` 的理由同 `RefreshButton`（它也在 `<Tooltip>` 里）。
 */
const SkinToggle = forwardRef<HTMLButtonElement>(function SkinToggle(_props, ref) {
  const [skin, setLocalSkin] = useState<Skin>(() => getSkin());

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
        ref={ref}
        type="button"
        onClick={toggle}
        aria-label={dark ? '切换到浅色外观' : '切换到深色外观'}
        className="q-icon-btn"
      >
        {dark ? <Moon aria-hidden className="h-4 w-4" /> : <Sun aria-hidden className="h-4 w-4" />}
      </button>
    </Tooltip>
  );
});

/**
 * 操作员菜单：身份 + 退出登录。
 *
 * 身份是菜单的**第一行**（看得见），退出在它下面（要点两下）—— 而以前这里是
 * 一个孤零零的退出按钮，身份只写在 `title` 里：想知道"我现在是谁"必须悬停，
 * 想退出只要一次误点。
 *
 * ## 为什么用 Popover 而不是 DropdownMenu
 *
 * `@radix-ui/react-dropdown-menu` **不在依赖里**（见 `packages/web/package.json`），
 * 而 Popover 已经在用。为一个只有两项的菜单多引入一个依赖，代价是每个下游
 * 都要重新 `npm install` —— 而 Popover 提供的"外部点击关闭 / Esc 关闭 /
 * 焦点管理"已经覆盖了全部需要。`role="menu"` 是手动补上的语义。
 */
function UserMenu({ onSignOut }: { onSignOut: () => void }) {
  const user = useApp((s) => s.user);
  const role = user?.role ? userRoleLabel(user.role) : '';
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  // 跳页之后 popover 不会自己知道，得手动关。
  useEffect(() => setOpen(false), [pathname]);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            'q-pop-item w-full gap-2.5',
            open && 'bg-base-850',
          )}
          title={`${user?.username ?? '—'}${role ? ` · ${role}` : ''}`}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent">
            {(user?.username ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-ink-mid">{user?.username ?? '—'}</span>
          <ChevronsUpDown aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          side="top"
          sideOffset={6}
          role="menu"
          className="q-pop z-50 w-60"
        >
          <div className="px-2.5 py-2">
            <div className="truncate text-base text-ink-hi">{user?.username ?? '—'}</div>
            <div className="truncate text-xs text-ink-faint">{role || '未知角色'}</div>
          </div>
          <div className="q-pop-sep" />
          <button
            type="button"
            role="menuitem"
            onClick={onSignOut}
            className="q-pop-item is-danger"
          >
            <LogOut aria-hidden className="h-3.5 w-3.5 shrink-0" />
            退出登录
          </button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/*  侧栏宽度                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 侧栏宽度：可拖拽、可键盘调、记在 localStorage。
 *
 * ## 为什么值得做
 *
 * magpie 的侧栏可以拖 —— 那不是一个"高级功能"，而是**必需**的：侧栏里
 * 放的是中文标签，而"策略工作室"和"数据与日志"的长度不一样；固定宽度在
 * 某些字号/缩放下会把它们截断，而截断的导航项读不出是什么页面。
 *
 * 宽度是 212px 起步（量出来的：三组九个中文标签 + 图标 + 间距，最长的
 * 「策略工作室」在 13px 下约 65px，加上图标 16 + gap 9 + padding 16 ≈ 106px，
 * 212px 留了一倍余量给计数徽章与将来的长标签）。
 *
 * ## 为什么状态在这里而不是 store
 *
 * 它只服务这个外壳（侧栏宽 212 还是 240 对别的模板没有意义）。放进全局
 * store 会让"模板自己的偏好"污染共享状态。
 */
function useSideWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem(SIDE_KEY);
      const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed) && parsed >= SIDE_MIN && parsed <= SIDE_MAX) return parsed;
    } catch {
      /* 隐私模式：用默认宽度，不拦着界面渲染。 */
    }
    return 212;
  });

  const persist = useCallback((next: number) => {
    setWidth(next);
    try {
      window.localStorage.setItem(SIDE_KEY, String(next));
    } catch {
      /* 存储被禁用：这一次调整只在当前会话有效。 */
    }
  }, []);

  /*
   * 拖拽。
   *
   * ⚠️ 三个 `setPointerCapture` 之外的细节，缺一个就会出现"拖到一半丢了"：
   *
   * 1. **捕获指针**（`setPointerCapture`）：不捕获的话，鼠标移出那条 8px
   *    的热区之后事件就不再来了 —— 表现是"拖到 20px 就停住"。
   * 2. **给 `<html>` 加一个类**，让**整页**的光标变成 `col-resize`：
   *    否则鼠标一离开热区光标就变回箭头，看起来像"拖拽已经结束了"。
   * 3. **监听 pointerup 而不是 mouseup**：触屏与手写笔没有 mouse 事件。
   */
  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      const startX = event.clientX;
      const startWidth = width;
      target.setPointerCapture(event.pointerId);
      document.documentElement.classList.add('q-resizing');

      const onMove = (moveEvent: PointerEvent) => {
        const next = Math.min(SIDE_MAX, Math.max(SIDE_MIN, startWidth + (moveEvent.clientX - startX)));
        setWidth(next);
      };
      const onUp = () => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        document.documentElement.classList.remove('q-resizing');
        // 只在松手时写盘：拖动过程每帧写一次 localStorage 是没必要的开销。
        setWidth((current) => {
          persist(current);
          return current;
        });
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    },
    [width, persist],
  );

  const nudge = useCallback(
    (delta: number) => {
      persist(Math.min(SIDE_MAX, Math.max(SIDE_MIN, width + delta)));
    },
    [width, persist],
  );

  const reset = useCallback(() => persist(212), [persist]);

  return { width, startDrag, nudge, reset };
}

/* -------------------------------------------------------------------------- */
/*  工具                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 路径 → 页面名。
 *
 * 详情页（`/traders/7`）落回它所属的列表名 —— 头部显示「机器人」比显示
 * 「7」有用得多（"7"是什么？）。找不到时返回空串，而不是编一个。
 */
function currentTitle(pathname: string, items: NavItem[]): string {
  let best = '';
  let bestLength = 0;
  for (const item of items) {
    if (matches(item.to, pathname) && item.to.length > bestLength) {
      best = item.label;
      bestLength = item.to.length;
    }
  }
  return best;
}

export default QuillShell;
