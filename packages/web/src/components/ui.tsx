/**
 * 共享基础组件库。
 *
 * 两条取舍贯穿整个文件：
 *
 * 1. **能交给 Radix 的绝不手写。** 对话框、开关、折叠区、气泡这些东西手写都会在
 *    边界上翻车：焦点陷阱、Esc、滚动锁定、aria-*、点击外部 —— 少一个就是一个
 *    bug，而且是要用屏幕阅读器或键盘才会发现的 bug。这里只负责外观。
 * 2. **导出的名字与 prop 形状是公开 API。** 40 多个文件 import 它，所以只增不改：
 *    需要改行为时保留旧 prop 并让它继续工作（见 `Button.small`、`NumberInput`）。
 */
import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as LabelPrimitive from '@radix-ui/react-label';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cva } from 'class-variance-authority';
import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Check, ChevronRight, Copy, Inbox, LoaderCircle, TriangleAlert, X } from 'lucide-react';

/**
 * `clsx` + `tailwind-merge`。
 *
 * 只用 clsx 时，`className="h-4 w-4"` 传给一个自带 `h-3.5 w-3.5` 的组件会**两个
 * 类都留下**，谁生效看 CSS 里的先后顺序 —— 结果就是调用方"覆盖不动"尺寸。
 * tailwind-merge 让后传的类真正赢，组件才敢给默认值。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/* -------------------------------------------------------------------------- */
/*  Badges + chips                                                             */
/* -------------------------------------------------------------------------- */

export type Tone = 'neutral' | 'up' | 'down' | 'warn' | 'accent' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-base-600 bg-base-800 text-ink-mid',
  up: 'border-up/40 bg-up/10 text-up',
  down: 'border-down/40 bg-down/10 text-down',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  accent: 'border-accent/40 bg-accent/10 text-accent',
  muted: 'border-base-700 bg-base-850 text-ink-lo',
};

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-mid',
  up: 'text-up',
  down: 'text-down',
  warn: 'text-warn',
  accent: 'text-accent',
  muted: 'text-ink-lo',
};

const TONE_SURFACE: Record<Tone, string> = {
  neutral: 'bg-ink-lo',
  up: 'bg-up',
  down: 'bg-down',
  warn: 'bg-warn',
  accent: 'bg-accent',
  muted: 'bg-ink-faint',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cn('chip', TONE_CLASS[tone], className)}>
      {children}
    </span>
  );
}

/**
 * 状态圆点。
 *
 * `pulse` 走的是 `animate-pulse-soft`（tailwind.config.js 里的 `pulse-soft`）。
 * 注意不是 `animate-pulseSoft` —— 那个类名不存在，Tailwind 对不存在的类不报错，
 * 只会**静默不生成样式**：圆点看着没问题，但永远不会闪。
 */
export function Dot({
  tone = 'neutral',
  pulse = false,
  title,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
        TONE_SURFACE[tone],
        pulse && 'animate-pulse-soft',
        className,
      )}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Buttons                                                                    */
/* -------------------------------------------------------------------------- */

type Variant = 'primary' | 'ghost' | 'danger' | 'success' | 'warn';

/**
 * 变体只映射到 index.css 里的 `.btn-*`。
 *
 * 页面里还有一批 `<Link className="btn btn-ghost">`（跳转用，不能是 `<button>`），
 * 如果这里改用内联工具类，同一个按钮就会有两种长得不一样的实现。
 * 保持单一来源，改 `.btn-*` 两边一起变。
 */
const buttonVariants = cva('btn', {
  variants: {
    variant: {
      primary: 'btn-primary',
      ghost: 'btn-ghost',
      danger: 'btn-danger',
      success: 'btn-success',
      warn: 'btn-warn',
    },
    size: {
      md: '',
      sm: 'btn-xs',
      icon: 'btn-xs px-2',
    },
  },
  defaultVariants: { variant: 'ghost', size: 'md' },
});

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /**
   * 旧写法，保留是因为十几个调用点还在用。
   * 等价于 `size="sm"`；新代码请直接用 `size`。
   */
  small?: boolean;
  size?: 'sm' | 'md' | 'icon';
  block?: boolean;
  busy?: boolean;
}

/**
 * `forwardRef` 是必需的，不是装饰：Radix 的 `asChild`（`Dialog.Close`、
 * `Tooltip.Trigger`）会把 ref 透传给子元素，函数组件接不住就会在控制台刷
 * "Function components cannot be given refs"。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', small = false, size, block = false, busy = false, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      disabled={disabled || busy}
      data-busy={busy ? '' : undefined}
      className={cn(buttonVariants({ variant, size: small ? 'sm' : (size ?? 'md') }), block && 'w-full', className)}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden className={cn('h-3.5 w-3.5 shrink-0 animate-spin opacity-70', className)} />;
}

/* -------------------------------------------------------------------------- */
/*  Form controls                                                              */
/* -------------------------------------------------------------------------- */

interface FieldProps {
  label?: string;
  hint?: string;
  error?: string | null;
  className?: string;
  children: ReactNode;
}

/** label 包住控件，靠 HTML 的隐式关联把两者绑起来（不需要自己生成 id）。 */
export function Field({ label, hint, error, className, children }: FieldProps) {
  return (
    <LabelPrimitive.Root className={cn('block', className)}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1 block text-xs text-down">
          {error}
        </span>
      )}
    </LabelPrimitive.Root>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} {...rest} className={cn('input', className)} />;
});

/**
 * 数字输入。
 *
 * 内部维护一份"正在输入的文本"（draft），而不是每敲一个字符就把 prop 里的
 * 数字回写回输入框：`Number("1.")` 是 1，一旦回写，用户敲的小数点会被立刻抹掉，
 * 于是**温度、盈亏比这类小数参数根本没法输入**。
 * draft 只在输入期间存在，失焦后清空，重新跟外部的 value 对齐。
 */
export const NumberInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
    value: number;
    onValueChange: (value: number) => void;
    step?: number | string;
  }
>(function NumberInput({ className, value, onValueChange, step, onBlur, ...rest }, ref) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (Number.isFinite(value) ? String(value) : '');

  return (
    <input
      ref={ref}
      {...rest}
      type="number"
      step={step}
      value={shown}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const next = Number(text);
        onValueChange(text.trim() === '' ? 0 : Number.isFinite(next) ? next : 0);
      }}
      onBlur={(event) => {
        setDraft(null);
        onBlur?.(event);
      }}
      className={cn('input num', className)}
    />
  );
});

/**
 * 下拉选择 —— 保持原生 `<select>`。
 *
 * Radix Select 的契约是 `onValueChange(value: string)` + `Select.Item` 子节点，
 * 而现有调用点全是 `onChange={(e) => set(Number(e.target.value))}` + `<option>`：
 * 换成 Radix 就是 6 个文件、十几处调用点的破坏性改动，收益只有"面板更好看"。
 * 这里改成原生控件并用 `.select` 对齐视觉（同一个背景箭头、同一套边框令牌），
 * 键盘、移动端原生选择器、表单语义也全都免费。
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} {...rest} className={cn('select', className)}>
      {children}
    </select>
  );
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} spellCheck={false} {...rest} className={cn('textarea', className)} />;
});

/**
 * 开关 → Radix Switch。
 *
 * 手写版有三个问题：`<button>` 没有 `role="switch"`（读屏只会念"按钮"）、
 * 没有 `aria-checked`、空格键也不会切换。Radix 这三样都正确。
 *
 * 整行可点：点击落在包裹层上，开关本身的点击用 stopPropagation 拦住，
 * 否则一次点击会被两边各处理一次 —— 开关看起来"点了没反应"。
 */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  className,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      onClick={disabled ? undefined : () => onChange(!checked)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-1 py-1 transition',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-base-850/70',
        className,
      )}
    >
      <SwitchPrimitive.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        onClick={(event) => event.stopPropagation()}
        aria-label={label}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
          'data-[state=checked]:border-up/60 data-[state=checked]:bg-up/25',
          'data-[state=unchecked]:border-base-600 data-[state=unchecked]:bg-base-800',
          'disabled:cursor-not-allowed',
        )}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            'block h-4 w-4 rounded-full transition-transform duration-150 will-change-transform',
            'data-[state=checked]:translate-x-4 data-[state=checked]:bg-up',
            'data-[state=unchecked]:translate-x-0.5 data-[state=unchecked]:bg-ink-lo',
          )}
        />
      </SwitchPrimitive.Root>
      <span className="pointer-events-none min-w-0">
        {label && <span className="block truncate text-base text-ink-mid">{label}</span>}
        {hint && <span className="block truncate text-xs text-ink-faint">{hint}</span>}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Layout primitives                                                          */
/* -------------------------------------------------------------------------- */

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
  padded = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  padded?: boolean;
}) {
  return (
    <section className={cn('panel', className)}>
      {(title || actions) && (
        <header className="panel-head">
          {/* min-w-0 + truncate：标题是数据驱动的名字，长名字不能把 actions 挤出去 */}
          <h2 className="panel-title min-w-0 truncate">{title}</h2>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn('min-w-0', padded && 'p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * 指标卡。
 *
 * 数值一档是 `text-2xl`（卡片数值）而不是原来的 `text-lg`：设计规范要求
 * "核心指标明显比次要信息大"，而指标卡和它旁边的说明文字原来几乎一样大，
 * 等于没有重点。label 保持 `text-xs`，差距就出来了。
 */
export function Stat({
  label,
  value,
  tone,
  sub,
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  sub?: ReactNode;
  title?: string;
}) {
  return (
    <div title={title} className="min-w-0 rounded-md border border-base-750 bg-base-850/60 px-3 py-2.5">
      <div className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-ink-lo">{label}</div>
      <div className={cn('num mt-1.5 text-2xl leading-tight', tone ?? 'text-ink-hi')}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-ink-faint">{sub}</div>}
    </div>
  );
}

export function Empty({
  message,
  hint,
  icon,
  action,
}: {
  message: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
      <span className="text-ink-faint opacity-60">{icon ?? <Inbox aria-hidden className="h-5 w-5" />}</span>
      <p className="text-base text-ink-lo">{message}</p>
      {hint && <p className="max-w-md text-xs text-ink-faint">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-base text-down',
        className,
      )}
    >
      <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export function Spinner3({ label = '加载中', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn('flex items-center justify-center gap-2 py-8 text-base text-ink-lo', className)}>
      <Spinner className="h-4 w-4" />
      {label}…
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Modal — Radix Dialog                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 对话框。
 *
 * 原来那版自己监听 `keydown` 关 Esc，其余全靠运气：没有焦点陷阱（Tab 会跑到
 * 背后的页面上）、没有滚动锁定（滚动穿透）、没有 `role="dialog"` /
 * `aria-modal`、也没有"关闭后焦点回到触发元素"。Radix 全部处理掉。
 *
 * 定位用外层 flex 容器而不是 `left-1/2 -translate-x-1/2`：入场动画的 keyframe
 * 自己就在写 `transform`，两者会互相覆盖，弹窗会从屏幕中间"跳"一下。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-lg',
  description,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  description?: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-overlay backdrop-blur-sm" />
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <DialogPrimitive.Content
            className={cn(
              'panel flex max-h-full w-full animate-slide-up flex-col overflow-hidden shadow-overlay',
              width,
            )}
          >
            <header className="panel-head shrink-0">
              <DialogPrimitive.Title className="min-w-0 truncate text-md font-semibold text-ink-hi">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close asChild>
                <Button size="icon" variant="ghost" aria-label="关闭">
                  <X aria-hidden className="h-4 w-4" />
                </Button>
              </DialogPrimitive.Close>
            </header>
            {description && (
              <DialogPrimitive.Description className="px-4 pt-3 text-base text-ink-lo">
                {description}
              </DialogPrimitive.Description>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
            {footer && (
              <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-base-800 px-4 py-2.5">
                {footer}
              </footer>
            )}
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/*  Key / value + copyable pre block                                           */
/* -------------------------------------------------------------------------- */

export function KV({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-base-850 py-1 last:border-0">
      <span className="text-xs uppercase tracking-wide text-ink-lo">{label}</span>
      <span className={cn('num min-w-0 break-words text-right text-base', tone ?? 'text-ink-hi')}>{value}</span>
    </div>
  );
}

export function CopyButton({ onCopy, copied }: { onCopy: () => void; copied: boolean }) {
  return (
    <Button small variant={copied ? 'success' : 'ghost'} onClick={onCopy}>
      {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
      {copied ? '已复制' : '复制'}
    </Button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Collapsible — Radix                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 折叠区 → Radix Collapsible。
 *
 * 原来是 `<details>`：没有动画（CSS 无法对 `height: auto` 过渡），而且
 * `<summary>` 在部分读屏里只被念成"可点击文本"。
 * 高度动画靠 Radix 写进 `--radix-collapsible-content-height` 的真实像素值，
 * 收/合两个方向都有（Radix 的 Presence 会在出场动画结束前保持挂载）。
 */
export function Collapsible({
  title,
  children,
  defaultOpen = false,
  meta,
  open,
  onOpenChange,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  meta?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  return (
    <CollapsiblePrimitive.Root
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      className={cn('group rounded-md border border-base-750 bg-base-850/40', className)}
    >
      <CollapsiblePrimitive.Trigger className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-base text-ink-mid transition hover:bg-base-800/60">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform group-data-[state=open]:rotate-90"
          />
          <span className="truncate">{title}</span>
        </span>
        {meta && <span className="shrink-0 text-xs text-ink-faint">{meta}</span>}
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="collapsible-panel">
        <div className="border-t border-base-800 p-3">{children}</div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/*  Tooltip — Radix                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 提示气泡。
 *
 * 只在"纯图标控件"上用：图标本身说不出自己要干什么，但把说明写成常驻文字
 * 又会挤压数据区。`Provider` 放在组件内部，这样任何地方直接写 `<Tooltip>`
 * 都能用，不需要在应用根部再包一层。
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  if (!content) return <>{children}</>;
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={6}
            className={cn(
              'z-[60] max-w-xs animate-fade-in rounded-md border border-base-700 bg-base-850 px-2 py-1 text-xs text-ink-hi shadow-raised',
              className,
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
