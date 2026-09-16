/**
 * 页面骨架：左指标栏 + 主内容区。
 *
 * 见 `LAYOUT.md`。这里只放**布局原语**，不放业务。
 *
 * 为什么单独一个文件而不是塞进 `ui.tsx`：`ui.tsx` 是通用控件库（按钮、输入框、
 * 徽章），而这里是**页面级骨架**。混在一起会让那个文件既管细节又管宏观，
 * 也让并发改动互相冲突。
 */
import type { ReactNode } from 'react';
import { cn } from './ui';

/* -------------------------------------------------------------------------- */
/*  页面外壳                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 左指标栏 + 主内容区。
 *
 * - `xl` 及以上：左栏 280px 固定，主区占满剩余宽度
 * - `lg` 及以下：左栏塌到内容上方，主区单列
 *
 * `rail` 为空时不渲染左栏（列表页用整宽表格，不该套这个骨架 —— 见 LAYOUT.md §1）。
 */
export function PageShell({
  rail,
  children,
  className,
}: {
  rail?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  if (!rail) {
    return <div className={cn('min-w-0 space-y-4', className)}>{children}</div>;
  }

  return (
    <div className={cn('grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[280px_minmax(0,1fr)] xl:gap-6', className)}>
      <aside className="min-w-0 xl:sticky xl:top-0 xl:self-start">{rail}</aside>
      <div className="min-w-0 space-y-4">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  指标栏                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 指标栏里的一组指标。
 *
 * **分组本身就是层级。** 把所有指标堆成一个列表，等于没有主次 —— 这正是
 * 改造前的问题。组间用一条细线分隔，组名用小字距标签。
 */
export function MetricGroup({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('border-t border-base-800 pt-3 first:border-t-0 first:pt-0', className)}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

/**
 * 单个指标：标签在上、数值在下。
 *
 * `value` 用 `.num`（等宽 + tabular-nums），否则实时数字会让整栏左右抖动。
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
  /** `lg` 只给每个分组里的第一个指标，或整栏最关键的那个。 */
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
      <div className="truncate text-xs text-ink-lo">{label}</div>
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
