/**
 * 页面骨架：主内容（约 60%）+ 右侧伴随栏（约 40%）。
 *
 * 见 `LAYOUT.md`。这里只放**布局原语**，不放业务。
 *
 * 为什么单独一个文件而不是塞进 `ui.tsx`：`ui.tsx` 是通用控件库（按钮、输入框、
 * 徽章），而这里是**页面级骨架**。混在一起会让那个文件既管细节又管宏观，
 * 也让并发改动互相冲突。
 */
import type { ReactNode } from 'react';
import { cn } from './ui';

/**
 * 两栏页面里**主内容列**的 id。
 *
 * ## 为什么需要它
 *
 * `xl` 及以上时，`PageShell` 让两栏**各自滚动**（主内容一列、右栏一列），
 * 而 `Layout` 的 `<main>` 在那种情况下几乎不滚（实测只剩 14px）。于是"页面在滚"
 * 这件事有两个不同的答案：
 *
 *   · 单栏页面（没有 `aside`）→ 滚的是 `Layout` 的 `<main id="main-scroll">`
 *   · 两栏页面（有 `aside`）  → 滚的是**这一列**
 *
 * 需要监听滚动的组件（例如帮助页目录的跟随高亮）必须按**页面形态**选对容器，
 * 否则会拿到一个永远不动的元素：事件绑上了、回调不触发、功能静默失效，
 * 而页面看起来毫无异常。
 */
export const PAGE_MAIN_ID = 'page-main';

/* -------------------------------------------------------------------------- */
/*  页面外壳                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 主内容区 + 右侧伴随栏。
 *
 * - `xl` 及以上：`3fr / 2fr` 两栏（约 60/40），右栏**自己滚动**，高度撑满可视区
 *   减去顶栏 —— 决策流有几十条，不该把整页撑长（LAYOUT.md §2）；
 * - `lg` 及以下：单列堆叠，右栏落到主内容下面；
 * - 右栏为空时不渲染它：列表页（机器人、策略、行情）就是**整宽一张表**
 *   （LAYOUT.md §0 规则 2）。
 *
 * 为什么用 `flex` 而不是 grid：整宽整高的滚动列要同时满足"撑满屏高"和
 * "内层容器不塌成 0 高"，这需要父级是 flex 子项（`min-h-0` 才有意义）。
 * grid 子项也能做到，但 `items-start` 之类的修饰会顺带破坏另一条约束
 * （撑满屏高），flex 只表达这一件事。
 *
 * ⚠️ 不设最大宽度：宽屏上把空间给图表和表格，不要留白边（LAYOUT.md §2）。
 */
export function PageShell({
  aside,
  children,
  className,
  fillHeight = true,
}: {
  /** 右侧伴随栏。命名不用 `rail`：它现在是"伴随信息"而不是指标栏，内容也不一定是指标。 */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * 两栏是否**撑满可视区高度**。
   *
   * ## 为什么需要这个开关
   *
   * 撑满是为了让右栏能"独立滚动 + 吸顶"：滚到主内容的深处时，右栏（决策流、目录）
   * 仍然钉在视野里。`/traders/:id` 与 `/faq` 需要它。
   *
   * **但内容少的页面会因此空出半屏。** `/exchanges` 与 `/account` 就是这样：
   * 左栏两三张卡、右栏一张卡，加起来不到视口的一半，而 `h-full` 把两栏拉到满高
   * —— 于是下方一大片纯黑。那不是"留白"，是**排版没跟上内容的量**。
   *
   * 所以那一类页面传 `false`：两栏按内容高度，页面自然结束；右栏跟着页面一起滚
   * （它本来也没有需要吸顶的东西）。
   */
  fillHeight?: boolean;
}) {
  if (!aside) {
    return <div className={cn('min-w-0 space-y-4', className)}>{children}</div>;
  }

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-4 xl:flex-row xl:gap-6',
        fillHeight && 'xl:h-full',
        className,
      )}
    >
      {/* 主内容：xl 以下跟着页面一起滚；xl 及以上、且要求撑满时自己滚（两栏各自独立） */}
      <div
        id={PAGE_MAIN_ID}
        className={cn(
          'min-w-0 space-y-4 xl:flex-[3_1_0%] xl:pr-1',
          fillHeight && 'xl:min-h-0 xl:overflow-y-auto',
        )}
      >
        {children}
      </div>

      {/*
        右栏：只有要求撑满时才 `sticky` + 自己滚。`sticky` 需要一个**有界的**滚动
        容器，而"按内容高度"的布局里没有那个界限 —— 那时让它跟着页面滚反而正常。
        再加 `items-start` 那类修饰会把它拉回内容高度，"撑满屏高"就没了。
      */}
      <aside
        className={cn(
          'min-w-0 xl:flex-[2_1_0%]',
          fillHeight && 'xl:sticky xl:top-0 xl:max-h-full xl:overflow-y-auto',
        )}
      >
        {aside}
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  指标                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 一组指标。
 *
 * **分组本身就是层级。** 把所有指标堆成一个列表，等于没有主次 —— 这正是
 * 改造前的问题。组间用一条细线分隔，组名用小字距标签。
 *
 * `layout` 决定指标的排法（LAYOUT.md §0 规则 3）：
 *
 * - `horizontal`（默认）：横排一行，最多 4 个，超过 4 个自动换成两行。
 *   数值都很短，竖着堆会让每个指标白占一整行宽度。
 * - `vertical`：竖排一列，留给真正做侧栏的场景（窄栏里横排会挤到读不出来）。
 *
 * `items-start` 不是美化：grid 默认 `stretch`，会把同一行的指标拉成等高，
 * 短的那个下方留一片空白，看起来就是"错位"（LAYOUT.md §6）。
 */
export function MetricGroup({
  title,
  children,
  layout = 'horizontal',
  columns = 4,
  className,
}: {
  title: string;
  children: ReactNode;
  layout?: 'horizontal' | 'vertical';
  /**
   * `horizontal` 下的列数上限。
   *
   * ⚠️ **列数是按视口断点算的，不是按容器宽度。** 把 `MetricGroup` 放进
   * `PageShell` 的右栏（只占视口的 40%）时，`xl:grid-cols-4` 照样生效 ——
   * 4 个指标被塞进半个屏幕，每列只剩约 150px，而 `Metric` 的数值是 `truncate`
   * 的：`main @ 222ae15` 被切掉一半、`2026-09-20 03:33` 变成 `2026-09-20 03:…`。
   * 界面上看起来只是"有点挤"，实际是**信息被静默丢掉了**。
   *
   * 所以放进窄栏时**必须显式降列**，或者干脆用 `layout="vertical"`。
   * 更省事的做法是别把状态信息放进窄栏 —— 横排占整宽才放得下长值。
   */
  columns?: 1 | 2 | 3 | 4;
  className?: string;
}) {
  const gridClass =
    columns === 1
      ? 'grid grid-cols-1 gap-y-2.5'
      : columns === 2
        ? 'grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2'
        : columns === 3
          ? 'grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3'
          : // 2 列 → 3 列 → 4 列；4 是上限，再多就该拆成两组了
            'grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3 xl:grid-cols-4';

  return (
    <section className={cn('border-t border-base-800 pt-3 first:border-t-0 first:pt-0', className)}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">{title}</h3>
      <div className={cn('items-start', layout === 'vertical' ? 'space-y-2.5' : gridClass)}>
        {children}
      </div>
    </section>
  );
}

/**
 * 单个指标：标签在上、数值在下。
 *
 * `value` 用 `.num`（等宽 + tabular-nums），否则实时数字会让整组左右抖动。
 * `sub` 放次要信息（基准、占比、说明）——**不要**把次要信息做成第二个大数字。
 */
export function Metric({
  label,
  value,
  sub,
  tone = 'default',
  size = 'md',
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'strong' | 'up' | 'down' | 'warn';
  /** `lg` 只给每个分组里的第一个指标，或整组最关键的那个。 */
  size?: 'md' | 'lg';
  title?: string;
}) {
  const toneClass =
    tone === 'strong' ? 'text-ink-strong'
      : tone === 'up' ? 'text-up'
        : tone === 'down' ? 'text-down'
          : tone === 'warn' ? 'text-warn'
            : 'text-ink-hi';

  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-xs font-medium uppercase tracking-wider text-ink-lo">{label}</div>
      <div
        className={cn(
          'num truncate leading-tight',
          size === 'lg' ? 'text-2xl' : 'text-lg',
          toneClass,
        )}
      >
        {value}
      </div>
      {sub !== undefined && <div className="num mt-0.5 truncate text-xs text-ink-faint">{sub}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  区块                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 主内容区里的区块标题（小字距标签 + 右侧延伸线）。
 *
 * ⚠️ 与 Badges.tsx 的 SectionHeading 区分：那个是**页面级大标题**（text-xl），
 * 这个是**区块级小标签**。两者语义不同，改名前一度同名，容易导错。
 *
 * 标题右侧一条延伸的细线，把标题和内容在视觉上绑在一起 —— 没有它，
 * 多个区块堆叠时读者分不清哪段内容属于哪个标题。
 *
 * `actions` 放右侧操作（刷新、导出等），与标题同一基线。
 */
export function SectionLabel({
  title,
  count,
  actions,
  className,
}: {
  title: string;
  count?: number | string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 flex items-center gap-3', className)}>
      <h2 className="shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-ink-lo">
        {title}
        {count !== undefined && <span className="num ml-2 text-ink-faint">{count}</span>}
      </h2>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-base-800" />
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}
