/**
 * **经典模板** —— 顶部导航 + 内容区，也就是原版外壳。
 *
 * ## 它是怎么来的
 *
 * 逐行从原来的 `Layout.tsx` 搬过来的，**行为与外观都不变**。搬完之后
 * `Layout.tsx` 只剩"选模板 + 挂运行时"，两个外壳之间的差异全部显式化了。
 *
 * 为什么值得搬而不是就地改：原版是**默认**模板，它必须能被信任。把它放在
 * 一个独立文件里、与另一套外壳并排，任何"顺手改一下"都能被 code review
 * 一眼看见；而混在一个 Layout 里时，改动总会被读成"重设计的一部分"。
 *
 * ## 它没有工具栏
 *
 * 所以页面的 `<PageActions>` 会**就地渲染**（见 `PageActions.tsx` 的兜底
 * 分支）。这是刻意的：原版就是这个样子，强行给它加一条工具栏属于"改了原版"。
 */
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ChevronDown, LogOut, Menu, Search, TriangleAlert, X } from 'lucide-react';
import { userRoleLabel } from '@aq/shared';
import { fmtClockOffset, fmtInt } from '../../lib/format';
import { Badge, Button, Dot, Tooltip, cn } from '../../components/ui';
import { useShell } from '../lib/context';
import { TemplateSwitcher } from '../lib/TemplateSwitcher';
import { MAIN_SCROLL_ID } from '../ids';
import type { NavItem } from '../../components/nav';

/** `lg` 断点（见 tailwind.config.js，em 单位）。 */
const DESKTOP_NAV_QUERY = '(min-width: 64em)';

export function ClassicShell() {
  const shell = useShell();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  /*
   * 顶栏的分组。
   *
   * 九项横排时每一项都又窄又挤，而模型 / 交易所 / 账户三项是**低频的配置
   * 操作** —— 它们和"看机器人现在怎么样"不是同一类动作，却各占一格最贵的
   * 位置。收进一个「设置」下拉之后顶栏剩六项。
   *
   * ⚠️ 分组的判据是"低频配置"，和 `navGroups` 的业务分组（交易/系统/帮助）
   * 不是一回事 —— 所以这一份是**经典模板自己的**，不共用导航表的分组。
   */
  const primaryNav = shell.navItems.filter((item) => item.group !== 'settings');
  const settingsNav = shell.navItems.filter((item) => item.group === 'settings');
  const onSettingsPage = settingsNav.some((item) => item.to === location.pathname);

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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-base-800 bg-base-900 px-4 sm:px-6 lg:px-8">
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
          {primaryNav.map((item) => (
            <NavLinkItem
              key={item.to}
              item={item}
              badge={item.to === '/traders' ? shell.runningCount : 0}
            />
          ))}
          {settingsNav.length > 0 && <SettingsMenu items={settingsNav} active={onSettingsPage} />}
        </nav>

        {/* 弹性空白：把状态区推到最右 */}
        <div className="min-w-0 flex-1" />

        {/* 全局风控状态：这是全屏最重要的一条告警，任何宽度下都留着 */}
        {shell.system?.tradingDisabled && (
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
          {/*
            只留徽章，不留 `币安 USDT 本位合约（实盘）` 那串文字。

            理由：徽章带的是**唯一会变**的信息（`env.dryRun` —— 真钱还是模拟），
            而 `environmentLabel` 是交易所端点的**静态标签**，部署好之后永远不变。
            更要紧的是那串文字末尾**又写了一遍「（实盘）」** —— 和旁边的徽章重复，
            两个来源并列反而让徽章看起来像"两个信号之一"，削弱它的警告作用。

            信息不丢：「打的是哪个端点」在排查异常时有用，放进徽章的悬停里。
          */}
          <Tooltip
            content={
              shell.system?.dryRun
                ? `模拟盘 —— 下单不会真的成交。接口端点：${shell.system?.environmentLabel ?? '连接中…'}`
                : `实盘 —— 下单会动用真实资金。接口端点：${shell.system?.environmentLabel ?? '连接中…'}`
            }
          >
            <Badge tone={shell.system?.dryRun ? 'accent' : 'warn'} className="shrink-0">
              {shell.system?.dryRun ? '模拟' : '实盘'}
            </Badge>
          </Tooltip>

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
          {shell.clockWarn && (
            <Tooltip content="本地时钟与交易所时钟相差超过 2 秒。签名请求会因时间戳超窗被拒绝（-1021），下单与撤单都会失败。请校准服务器时间（NTP）。">
              <Badge tone="warn" className="shrink-0">
                <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                时钟偏差 {fmtClockOffset(shell.system?.clockOffsetMs)}
              </Badge>
            </Tooltip>
          )}

          {shell.weightWarn && (
            <Tooltip content="当前分钟已消耗的请求权重接近上限。继续升高会被交易所临时封禁 IP（418），届时所有行情与交易请求都会失败。">
              <Badge tone="warn" className="shrink-0">
                <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
                API 权重 {shell.weightPercent}%
              </Badge>
            </Tooltip>
          )}

          {/* 运行中的循环数：这是**真的状态**，不是诊断值，所以常驻 */}
          {shell.runningCount > 0 && (
            <span className="num hidden shrink-0 text-xs text-ink-lo sm:inline" title="正在运行的机器人数量">
              运行 <span className="text-ink-mid">{fmtInt(shell.runningCount)}</span>
            </span>
          )}

          {/*
            推送状态**只在异常时出现**。

            原来常驻显示 `● 推送在线`，它和之前从顶栏删掉的 `时钟 +22 ms`、
            `权重 59/2,400` 是同一类东西：99.9% 的时间显示"在线"，而且**断线时
            系统会自动降级成轮询** —— 意思是这个指示器无论亮什么，操作者都不需要做任何事。

            一个你永远不必对它采取行动的指示器，不该占着顶栏。
            现在只在异常时出现，并说清后果（"轮询兜底"）而不是只报状态。
          */}
          {shell.socketStatus !== 'open' && (
            <span
              className="hidden shrink-0 items-center gap-1.5 text-xs text-warn sm:flex"
              title={
                shell.socketBlockedReason !== null
                  ? `${shell.socketBlockedReason}。登录之后会自动重新连接。`
                  : '实时事件连接异常。页面已自动降级为轮询，数据仍会更新，只是延迟更大；无需手动操作，系统会自动重连。'
              }
            >
              <Dot
                tone={shell.socketBlockedReason !== null ? 'down' : shell.socketStatus === 'connecting' ? 'warn' : 'down'}
                pulse={shell.socketBlockedReason === null}
              />
              {shell.socketBlockedReason !== null
                ? shell.socketBlockedReason
                : shell.socketStatus === 'connecting'
                  ? '连接中 · 轮询兜底'
                  : '推送断开 · 轮询兜底'}
            </span>
          )}

          {/*
            **系统状态停更**（2026-10-17 · 台账 FRD-01）。

            与上面那条推送状态同类：正常时完全不出现，出现时带着"N 秒前的读数"
            这个**后果**。它回答的是"顶栏那句『实盘』『运行 1』还能不能信" ——
            在那之前，后端不可达之后这里什么都不说，页面看起来一切正常。
          */}
          {shell.statusStale && (
            <span
              className="hidden shrink-0 items-center gap-1.5 text-xs text-warn sm:flex"
              title={`最近一次读取系统状态失败${shell.statusError ? `：${shell.statusError}` : ''}。页面显示的是上一次成功读到的读数。`}
            >
              <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
              {shell.statusStaleLabel}
            </span>
          )}

          {/*
            模板切换器。原版顶栏里没有这一项，加它属于**必要的新增**：
            没有它，用户切到另一套模板之后就找不到换回来的入口（外观页在侧栏，
            而每套模板的侧栏位置都不一样）。业务行为一律不变 —— 它只改
            `<html>` 上的模板类名，不刷新、不重连。
          */}
          <TemplateSwitcher size="md" />

          {/* 搜索入口。显示 ⌘K 是要让人**发现**快捷键，而不是把快捷键藏在文档里 */}
          <button
            type="button"
            onClick={() => shell.setPaletteOpen(true)}
            aria-label="打开命令面板"
            /*
              收成一个图标按钮，不再是带占位文字的输入框。

              原来那个框占着顶栏最显眼的位置，写着"搜索或跳转"，但它的价值随机器人
              数量增长，而页面跳转这一项本来就和顶部导航重复（9 个导航项全都看得见）。
              真正有用的是"快速启停某个机器人"——那个等机器人多了才成为高频操作。

              所以保留能力、还回空间：⌘K 快捷键照旧可用，图标作为发现入口。
              `title` 里带上快捷键，让不熟悉的人也能发现它。
            */
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-base-700 bg-base-850 text-ink-lo transition hover:border-base-600 hover:text-ink-mid"
            title="打开命令面板（⌘K）—— 快速跳转、切换机器人、启动或停止"
          >
            <Search aria-hidden className="h-4 w-4 shrink-0" />
            <span className="sr-only">打开命令面板（⌘K）</span>
          </button>

          <Tooltip
            content={`${shell.user?.username ?? '—'}${shell.user?.role ? ` · ${userRoleLabel(shell.user.role)}` : ''}`}
            side="bottom"
          >
            <Button size="icon" variant="ghost" aria-label="退出登录" onClick={shell.signOut}>
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
              {shell.navItems.map((item) => (
                <NavLinkItem
                  key={item.to}
                  item={item}
                  className="w-full"
                  badge={item.to === '/traders' ? shell.runningCount : 0}
                  onNavigate={() => setDrawerOpen(false)}
                />
              ))}
            </nav>
            <div className="border-t border-base-800 px-2 py-2">
              <div className="flex items-center justify-between gap-1 rounded-md border border-base-800 bg-base-850/60 px-2 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-xs text-ink-mid">{shell.user?.username ?? '—'}</div>
                  <div className="truncate text-xs text-ink-faint">
                    {userRoleLabel(shell.user?.role ?? '')}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={shell.signOut} className="shrink-0">
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

        ⚠️ **它就是那个滚动容器，而且它有 id。**
        以前它是一个没有 id 的 `<div>`，而本文件别的注释把它称作"Layout 的 `<main>`" ——
        于是 `FaqPage` 照着那句话去 `querySelector('main')`，拿到 `null` 就静默返回，
        目录的跟随高亮**从未绑定过**（而页面看起来完全正常）。
        现在它是真正的 `<main>`，并带一个 id 供需要找滚动容器的组件使用。
      */}
      <main id={MAIN_SCROLL_ID} className="page-pad min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  顶栏零件                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 顶栏的「设置」下拉 —— 收低频的配置类页面（AI 模型 / 交易所 / 操作员账户）。
 *
 * ## 为什么用 popover 而不是自己写一个开关
 *
 * 外部点击关闭、Esc 关闭、焦点管理与 `aria-expanded` —— 自己写这四样一定会漏掉
 * 其中一两样，而漏掉的那一样通常只在特定操作下才现形（比如只用键盘的人打不开）。
 * `AiModelsSection` 里的模型选择器也是这么做的。
 *
 * ## 为什么"当前页就在下拉里"时触发器也要变亮
 *
 * 否则站在 `/models` 上时顶栏看起来**没有任何一项是当前页**。而"我在哪"是顶栏
 * 要回答的第一个问题 —— 下拉收起了链接，但不能把这条信息一起收掉。
 */
function SettingsMenu({ items, active }: { items: NavItem[]; active: boolean }) {
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
            'relative flex h-14 shrink-0 items-center gap-1 whitespace-nowrap px-2.5 text-base font-medium transition',
            active ? 'text-ink-hi' : 'text-ink-lo hover:text-ink-mid',
          )}
        >
          <span>设置</span>
          <ChevronDown aria-hidden className={cn('h-3.5 w-3.5 shrink-0 transition', open && 'rotate-180')} />
          {active && (
            <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />
          )}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 min-w-44 rounded-lg border border-base-700 bg-base-900 p-1 shadow-overlay"
        >
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-2.5 py-2 text-base transition',
                  isActive ? 'bg-base-850 text-ink-hi' : 'text-ink-mid hover:bg-base-850/60 hover:text-ink-hi',
                )
              }
            >
              <item.icon aria-hidden className="h-4 w-4 shrink-0" />
              <span className="min-w-0 truncate">{item.label}</span>
            </NavLink>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

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
