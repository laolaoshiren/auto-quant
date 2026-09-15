import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useEffect } from 'react';
import clsx from 'clsx';

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
    <span title={title} className={clsx('chip', TONE_CLASS[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone = 'neutral', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  const color: Record<Tone, string> = {
    neutral: 'bg-ink-lo',
    up: 'bg-up',
    down: 'bg-down',
    warn: 'bg-warn',
    accent: 'bg-accent',
    muted: 'bg-ink-faint',
  };
  return <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', color[tone], pulse && 'animate-pulseSoft')} />;
}

/* -------------------------------------------------------------------------- */
/*  Buttons                                                                    */
/* -------------------------------------------------------------------------- */

type Variant = 'primary' | 'ghost' | 'danger' | 'success' | 'warn';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  small?: boolean;
  block?: boolean;
  busy?: boolean;
}

export function Button({
  variant = 'ghost',
  small = false,
  block = false,
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={clsx('btn', `btn-${variant}`, small && 'btn-xs', block && 'w-full', className)}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        'inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent opacity-70',
        className,
      )}
    />
  );
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

export function Field({ label, hint, error, className, children }: FieldProps) {
  return (
    <label className={clsx('block', className)}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && !error && <span className="mt-1 block text-2xs text-ink-faint">{hint}</span>}
      {error && <span className="mt-1 block text-2xs text-down">{error}</span>}
    </label>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={clsx('input', className)} />;
}

export function NumberInput({
  className,
  value,
  onValueChange,
  step,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number;
  onValueChange: (value: number) => void;
  step?: number | string;
}) {
  return (
    <input
      {...rest}
      type="number"
      step={step}
      value={Number.isFinite(value) ? value : ''}
      onChange={(event) => {
        const next = Number(event.target.value);
        onValueChange(Number.isFinite(next) ? next : 0);
      }}
      className={clsx('input num', className)}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={clsx('select', className)}>
      {children}
    </select>
  );
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} spellCheck={false} className={clsx('textarea', className)} />;
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-2 rounded px-1 py-1 text-left transition hover:bg-base-850/70"
    >
      <span
        className={clsx(
          'relative h-4 w-7 shrink-0 rounded-full border transition',
          checked ? 'border-up/60 bg-up/25' : 'border-base-600 bg-base-800',
        )}
      >
        <span
          className={clsx(
            'absolute top-[1px] h-[12px] w-[12px] rounded-full transition-all',
            checked ? 'left-[13px] bg-up' : 'left-[1px] bg-ink-lo',
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs text-ink-mid">{label}</span>
        {hint && <span className="block truncate text-2xs text-ink-faint">{hint}</span>}
      </span>
    </button>
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
    <section className={clsx('panel', className)}>
      {(title || actions) && (
        <header className="panel-head">
          <h2 className="panel-title">{title}</h2>
          {actions && <div className="flex items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={clsx(padded && 'p-3', bodyClassName)}>{children}</div>
    </section>
  );
}

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
    <div title={title} className="rounded border border-base-800 bg-base-850/60 px-2.5 py-2">
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-ink-lo">{label}</div>
      <div className={clsx('num mt-1 text-lg leading-tight', tone ?? 'text-ink-hi')}>{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-ink-faint">{sub}</div>}
    </div>
  );
}

export function Empty({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
      <p className="text-xs text-ink-lo">{message}</p>
      {hint && <p className="text-2xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <div className={clsx('rounded border border-down/40 bg-down/10 px-2.5 py-1.5 text-xs text-down', className)}>
      {children}
    </div>
  );
}

export function Spinner3({ label = '加载中' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-xs text-ink-lo">
      <Spinner />
      {label}…
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Modal                                                                      */
/* -------------------------------------------------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-16 backdrop-blur-sm">
      <div className={clsx('panel w-full animate-slideIn', width)}>
        <header className="panel-head">
          <h3 className="text-sm font-semibold text-ink-hi">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 text-ink-lo transition hover:bg-base-800 hover:text-ink-hi"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-3">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-base-800 px-3 py-2">{footer}</footer>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Key / value + copyable pre block                                           */
/* -------------------------------------------------------------------------- */

export function KV({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-base-850 py-1 last:border-0">
      <span className="text-2xs uppercase tracking-wide text-ink-lo">{label}</span>
      <span className={clsx('num text-xs', tone ?? 'text-ink-hi')}>{value}</span>
    </div>
  );
}

export function CopyButton({ onCopy, copied }: { onCopy: () => void; copied: boolean }) {
  return (
    <Button small onClick={onCopy} variant={copied ? 'success' : 'ghost'}>
      {copied ? '✓ 已复制' : '复制'}
    </Button>
  );
}

export function Collapsible({
  title,
  children,
  defaultOpen = false,
  meta,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  meta?: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group rounded border border-base-800 bg-base-850/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-1.5 text-xs text-ink-mid transition hover:bg-base-800/60">
        <span className="flex items-center gap-1.5">
          <span className="text-ink-faint transition group-open:rotate-90">▶</span>
          {title}
        </span>
        <span className="text-2xs text-ink-faint">{meta}</span>
      </summary>
      <div className="border-t border-base-800 p-2.5">{children}</div>
    </details>
  );
}
