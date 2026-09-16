/**
 * 导航表 —— 顶部导航与命令面板共用的**唯一**一份路由清单。
 *
 * 为什么单独放一个文件：顶部导航和命令面板都要"跳页面"，两处各写一份列表就一定会
 * 漂移（加了一个页面，只有导航有；命令面板搜不到）。这里保证两边同源。
 *
 * 标签必须与页面语义一致，不要为了短而改叫法 —— 用户是照着导航记路名的。
 *
 * ⚠️ 这里**只**放导航链接本身。页面级标题由各页面自己的内容区渲染：
 * 应用外壳不再渲染标题（LAYOUT.md §0/§1），所以"路径 → 标题"的映射没有存在的必要了。
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
   * 只给导航里的一级页面。字母取自中文名的英文对位，不是首字母拼音 ——
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
