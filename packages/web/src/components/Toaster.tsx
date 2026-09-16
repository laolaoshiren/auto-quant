import clsx from 'clsx';
import { useEvents } from '../lib/store';
import { fmtTime } from '../lib/format';

const KIND_STYLE: Record<string, string> = {
  order: 'border-accent/50 bg-base-850',
  trade: 'border-up/50 bg-base-850',
  error: 'border-down/60 bg-down/10',
  info: 'border-base-600 bg-base-850',
  ok: 'border-up/60 bg-up/10',
};

const KIND_TITLE: Record<string, string> = {
  order: 'text-accent',
  trade: 'text-up',
  error: 'text-down',
  info: 'text-ink-mid',
  ok: 'text-up',
};

const KIND_LABEL: Record<string, string> = {
  order: '委托',
  trade: '成交',
  error: '错误',
  info: '提示',
  ok: '成功',
};

export function Toaster() {
  const toasts = useEvents((s) => s.toasts);
  const dismiss = useEvents((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-1.5">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismiss(toast.id)}
          className={clsx(
            /*
             * `animate-slide-in-right`, not `animate-slideIn`.
             *
             * `slideIn` is not a key defined in tailwind.config.js, and Tailwind
             * emits nothing at all for an unknown class rather than failing the
             * build — so the toasts silently stopped animating in the redesign
             * and nobody noticed, because "no animation" still looks fine.
             * This is the actual toast entrance (bottom-right stack), so it maps
             * onto the config's existing `slide-in-right`.
             */
            'pointer-events-auto animate-slide-in-right rounded border px-2.5 py-2 text-left shadow-panel backdrop-blur transition hover:brightness-125',
            KIND_STYLE[toast.kind] ?? KIND_STYLE.info,
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className={clsx('text-2xs font-semibold uppercase tracking-wide', KIND_TITLE[toast.kind])}>
              {KIND_LABEL[toast.kind] ?? toast.kind}
            </span>
            <span className="num text-2xs text-ink-faint">{fmtTime(new Date(toast.at).toISOString())}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-ink-hi">{toast.title}</div>
          {toast.body && <div className="truncate text-2xs text-ink-lo">{toast.body}</div>}
        </button>
      ))}
    </div>
  );
}
