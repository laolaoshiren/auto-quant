import clsx from 'clsx';
import { X } from 'lucide-react';
import { useEvents } from '../lib/store';
import { fmtTime } from '../lib/format';

const KIND_STYLE: Record<string, string> = {
  order: 'border-base-700 border-l-accent bg-base-900/95',
  trade: 'border-base-700 border-l-up bg-base-900/95',
  error: 'border-down/40 border-l-down bg-base-900/95',
  info: 'border-base-700 border-l-ink-lo bg-base-900/95',
  ok: 'border-up/40 border-l-up bg-base-900/95',
};

const KIND_PILL: Record<string, string> = {
  order: 'bg-accent/12 text-accent',
  trade: 'bg-up/12 text-up',
  error: 'bg-down/12 text-down',
  info: 'bg-base-800 text-ink-mid',
  ok: 'bg-up/12 text-up',
};

const KIND_LABEL: Record<string, string> = {
  order: '委托',
  trade: '成交',
  error: '错误',
  info: '提示',
  ok: '成功',
};

/**
 * 轻量悬浮提示栈：置于顶栏下方右上角（`top-14 right-4`），避免遮挡右下角「最近决策」阅读区；
 * 实时委托/成交弹窗可在整站右上角铃铛按钮一键关闭。
 */
export function Toaster() {
  const toasts = useEvents((s) => s.toasts);
  const dismiss = useEvents((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-14 z-50 flex w-72 flex-col gap-1.5">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={clsx(
            'pointer-events-auto animate-slide-in-right rounded-xl border border-l-[3px] px-3 py-2 shadow-raised backdrop-blur-md transition',
            KIND_STYLE[toast.kind] ?? KIND_STYLE.info,
          )}
        >
          <div className="flex items-center gap-1.5">
            <span
              className={clsx(
                'rounded px-1.5 py-0.5 text-[10.5px] font-semibold leading-none',
                KIND_PILL[toast.kind] ?? KIND_PILL.info,
              )}
            >
              {KIND_LABEL[toast.kind] ?? toast.kind}
            </span>
            <span className="num text-[11px] text-ink-faint">{fmtTime(new Date(toast.at).toISOString())}</span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="关闭通知"
              className="ml-auto rounded p-0.5 text-ink-faint transition hover:bg-base-800 hover:text-ink-hi"
            >
              <X aria-hidden className="h-3 w-3" />
            </button>
          </div>
          <div className="mt-1 truncate text-xs font-medium text-ink-hi">{toast.title}</div>
          {toast.body && <div className="mt-0.5 truncate text-[11.5px] text-ink-lo">{toast.body}</div>}
        </div>
      ))}
    </div>
  );
}
