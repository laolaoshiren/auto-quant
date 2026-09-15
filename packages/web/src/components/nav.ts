/**
 * 导航表 —— 侧栏与命令面板共用的**唯一**一份路由清单。
 *
 * 为什么单独放一个文件：侧栏和命令面板都要"跳页面"，两处各写一份列表就一定会
 * 漂移（加了一个页面，只有侧栏有；命令面板搜不到）。这里保证两边同源。
 *
 * 标签必须与页面语义一致，不要为了短而改叫法 —— 用户是照着侧栏记路名的。
 */
import {
  ArrowLeftRight,
  Bot,
  ChartCandlestick,
  CircleHelp,
  FlaskConical,
  LayoutDashboard,
  ScrollText,
  Sparkles,
  UserCog,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /**
   * `g` 前缀快捷键的第二段（例如 `g` `t` → 机器人）。
   *
   * 只给侧栏里的一级页面。字母取自中文名的英文对位，不是首字母拼音 ——
   * 拼音首字母在"策略/数据"和"模型/行情"上会打架。
   */
  jump: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '总览', icon: LayoutDashboard, jump: 'o' },
  { to: '/traders', label: '机器人', icon: Bot, jump: 't' },
  { to: '/strategy', label: '策略工作室', icon: FlaskConical, jump: 's' },
  { to: '/models', label: 'AI 模型', icon: Sparkles, jump: 'a' },
  { to: '/exchanges', label: '交易所', icon: ArrowLeftRight, jump: 'e' },
  { to: '/market', label: '行情', icon: ChartCandlestick, jump: 'm' },
  { to: '/data', label: '数据与日志', icon: ScrollText, jump: 'd' },
  { to: '/account', label: '操作员账户', icon: UserCog, jump: 'u' },
  { to: '/faq', label: '帮助', icon: CircleHelp, jump: 'h' },
];

/**
 * 顶栏标题。
 *
 * 详情页（机器人 / 决策 / 策略编辑）不在侧栏里，所以按前缀单独判定；
 * 顺序要紧：`/traders/:id/decisions/:recordId` 必须先于 `/traders/:id`，
 * 否则详情页会显示成"机器人详情"。
 */
export function pageTitleFor(pathname: string): string {
  if (pathname === '/') return '总览';
  if (/^\/traders\/[^/]+\/decisions\//.test(pathname)) return '决策详情';
  if (/^\/traders\/[^/]+/.test(pathname)) return '机器人详情';
  if (/^\/strategy\/[^/]+/.test(pathname)) return '策略编辑器';
  // 旧链接：三个设置页已经是一级导航，但这条路由仍然要能打开。
  if (pathname.startsWith('/settings')) return '设置';

  return NAV_ITEMS.find((item) => item.to !== '/' && pathname.startsWith(item.to))?.label ?? '页面不存在';
}
