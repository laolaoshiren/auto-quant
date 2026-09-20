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
  /**
   * 顶栏把这一项收进哪个下拉。不写 = 直接显示在顶栏上。
   *
   * ## 为什么要有这个字段
   *
   * 顶栏横着排九项时，每一项都变得又窄又挤，而其中三项（模型 / 交易所 / 账户）
   * 是**低频的配置操作** —— 它们和"看机器人现在怎么样"不是同一类动作，
   * 却各占一格最贵的位置。
   *
   * ⚠️ **它只影响顶栏的呈现**：小屏抽屉仍然平铺全部（那里是纵向列表，收起
   * 只会多一次点击），命令面板也仍然列出全部（它的价值就是"什么都能搜到"）。
   */
  group?: 'settings';
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '总览', icon: LayoutDashboard, jump: 'o' },
  { to: '/traders', label: '机器人', icon: Bot, jump: 't' },
  { to: '/strategy', label: '策略工作室', icon: FlaskConical, jump: 's' },
  { to: '/market', label: '行情', icon: ChartCandlestick, jump: 'm' },
  { to: '/data', label: '数据与日志', icon: ScrollText, jump: 'd' },
  { to: '/models', label: 'AI 模型', icon: Sparkles, jump: 'a', group: 'settings' },
  { to: '/exchanges', label: '交易所', icon: ArrowLeftRight, jump: 'e', group: 'settings' },
  { to: '/account', label: '操作员账户', icon: UserCog, jump: 'u', group: 'settings' },
  { to: '/faq', label: '帮助', icon: CircleHelp, jump: 'h' },
];
