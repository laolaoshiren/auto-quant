import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* ============================================================================
 *  全局按需悬停提示层（GlobalTooltipLayer）
 *
 *  设计原则 —— 极度克制，只服务真正有信息增量的显式提示：
 *  - 严格按需（Opt-in）：仅响应显式声明了 `data-aq-tip="..."` 的元素，绝不劫持全站
 *    数百处普通原生 `title`，避免鼠标在看板上滑动时满屏乱弹、遮挡视线；
 *  - 结构化排版：单行提示渲染为精致胶囊；多行 `\n` / `· ` 提示自动识别标题、副标题、
 *    分隔线与左右对齐的键值明细（如 Token 计费公式、缓存说明、盈亏公式拆分）；
 *  - 视口自适应：默认目标上方居中 + 无缝小三角，触顶自动翻转到底部，左右贴边夹紧。
 * ============================================================================ */

export interface TooltipRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface TooltipSize {
  width: number;
  height: number;
}

export interface TooltipViewport {
  width: number;
  height: number;
}

export interface ComputedTooltipPos {
  top: number;
  left: number;
  placement: 'top' | 'bottom';
  arrowLeft: number;
}

export type TooltipRow =
  | { kind: 'kv'; label: string; value: string; isBullet: boolean }
  | { kind: 'note'; text: string; isBullet: boolean };

export type ParsedTooltip =
  | { kind: 'empty'; text: '' }
  | { kind: 'single'; text: string }
  | {
      kind: 'rich';
      headerLabel: string;
      headerValue?: string;
      headerNote?: string;
      rows: TooltipRow[];
    };

const OPEN_DELAY_MS = 240;
const HIDE_GRACE_MS = 60;
const EDGE_MARGIN_PX = 12;
const TARGET_GAP_PX = 9;
const ARROW_INSET_PX = 14;
const TIP_ATTR = 'data-aq-tip';

/**
 * 安全拆分 `标签：值` 或 `Label: Value` 行。
 * 优先识别中文全角冒号 `：`（无 URL/时间歧义）；英文冒号仅匹配 `": "` 且左侧较短、非协议头。
 */
function splitKeyValue(line: string): { label: string; value: string } | null {
  const zhIdx = line.indexOf('：');
  if (zhIdx > 0 && zhIdx <= 26) {
    const label = line.slice(0, zhIdx).trim();
    const value = line.slice(zhIdx + 1).trim();
    if (label && value) return { label, value };
  }

  const enIdx = line.indexOf(': ');
  if (enIdx > 0 && enIdx <= 24) {
    const label = line.slice(0, enIdx).trim();
    const value = line.slice(enIdx + 2).trim();
    if (label && value && !/^https?$/i.test(label) && !/^\d{1,2}$/.test(label)) {
      return { label, value };
    }
  }

  return null;
}

/**
 * 将原始提示字符串解析为单行胶囊或结构化多行卡片数据。
 */
export function parseTooltipContent(raw: string): ParsedTooltip {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const first = lines[0];
  if (!first) {
    return { kind: 'empty', text: '' };
  }
  if (lines.length === 1) {
    return { kind: 'single', text: first };
  }

  const rest = lines.slice(1);
  const headerSplit = splitKeyValue(first);
  let headerLabel = first;
  let headerValue: string | undefined;
  let headerNote: string | undefined;

  if (headerSplit) {
    const parenMatch = /^([^（(]+?)\s*[（(](.+)[）)]$/.exec(headerSplit.value);
    if (parenMatch && parenMatch[1] && parenMatch[2] && parenMatch[1].trim().length <= 24) {
      headerLabel = headerSplit.label;
      headerValue = parenMatch[1].trim();
      headerNote = parenMatch[2].trim();
    } else if (headerSplit.value.length <= 24) {
      headerLabel = headerSplit.label;
      headerValue = headerSplit.value;
    }
  }

  const rows: TooltipRow[] = rest.map((line) => {
    const bulletMatch = /^[·•\-–]\s*/.exec(line);
    const isBullet = Boolean(bulletMatch);
    const stripped = bulletMatch ? line.slice(bulletMatch[0].length).trim() : line;
    const kv = splitKeyValue(stripped);
    if (kv) {
      return { kind: 'kv', label: kv.label, value: kv.value, isBullet };
    }
    return { kind: 'note', text: stripped || line, isBullet };
  });

  return {
    kind: 'rich',
    headerLabel,
    headerValue,
    headerNote,
    rows,
  };
}

/**
 * 计算提示框在视口内的最终坐标与小三角偏移量。
 * 优先放在目标正上方，顶部空间不足时翻转至下方，左右自动夹紧在安全边距内。
 */
export function computeTooltipPosition(
  anchorRect: TooltipRect,
  tipSize: TooltipSize,
  viewport: TooltipViewport,
  opts?: { gap?: number; margin?: number; arrowInset?: number },
): ComputedTooltipPos {
  const gap = opts?.gap ?? TARGET_GAP_PX;
  const margin = opts?.margin ?? EDGE_MARGIN_PX;
  const arrowInset = opts?.arrowInset ?? ARROW_INSET_PX;

  const topCandidate = anchorRect.top - gap - tipSize.height;
  const bottomCandidate = anchorRect.bottom + gap;
  const spaceAbove = anchorRect.top - margin;
  const spaceBelow = viewport.height - margin - anchorRect.bottom;

  let placement: 'top' | 'bottom' = 'top';
  let top = topCandidate;

  if (topCandidate < margin) {
    if (bottomCandidate + tipSize.height <= viewport.height - margin || spaceBelow > spaceAbove) {
      placement = 'bottom';
      top = bottomCandidate;
    }
  }

  const maxTop = Math.max(margin, viewport.height - margin - tipSize.height);
  top = Math.max(margin, Math.min(top, maxTop));

  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const maxLeft = Math.max(margin, viewport.width - margin - tipSize.width);
  const left = Math.max(margin, Math.min(anchorCenterX - tipSize.width / 2, maxLeft));

  const rawArrowLeft = anchorCenterX - left;
  const arrowLeft =
    tipSize.width <= arrowInset * 2
      ? tipSize.width / 2
      : Math.max(arrowInset, Math.min(rawArrowLeft, tipSize.width - arrowInset));

  return {
    top: Math.round(top),
    left: Math.round(left),
    placement,
    arrowLeft: Math.round(arrowLeft),
  };
}

function findTooltipHost(node: EventTarget | null): Element | null {
  if (!node || !(node instanceof Node)) return null;
  let cur: Element | null = node instanceof Element ? node : node.parentElement;
  while (cur) {
    const raw = cur.getAttribute(TIP_ATTR);
    if (raw && raw.trim().length > 0) return cur;
    cur = cur.parentElement;
  }
  return null;
}

interface ActiveTooltipState {
  host: Element;
  text: string;
  visible: boolean;
  instanceId: number;
}

export function GlobalTooltipLayer() {
  const [state, setState] = useState<ActiveTooltipState | null>(null);
  const [pos, setPos] = useState<ComputedTooltipPos | null>(null);

  const tipRef = useRef<HTMLDivElement | null>(null);
  const activeHostRef = useRef<Element | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const observerRef = useRef<MutationObserver | null>(null);
  const instanceCounterRef = useRef<number>(0);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const detachObserver = useCallback(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
  }, []);

  const hideNow = useCallback(() => {
    clearTimers();
    detachObserver();
    activeHostRef.current = null;
    setState(null);
    setPos(null);
  }, [clearTimers, detachObserver]);

  const activateHost = useCallback(
    (host: Element) => {
      clearTimers();
      detachObserver();

      const rawText = (host.getAttribute(TIP_ATTR) ?? '').trim();
      if (!rawText) {
        hideNow();
        return;
      }

      const isSameHost = activeHostRef.current === host;
      activeHostRef.current = host;

      // 若悬停期间 React 动态更新 `data-aq-tip`，实时同步内容
      const observer = new MutationObserver(() => {
        const updated = (host.getAttribute(TIP_ATTR) ?? '').trim();
        if (!updated) {
          hideNow();
        } else {
          setState((prev) => (prev && prev.host === host ? { ...prev, text: updated } : prev));
        }
      });
      observer.observe(host, { attributes: true, attributeFilter: [TIP_ATTR] });
      observerRef.current = observer;

      setState((prev) => {
        if (prev?.visible && isSameHost) {
          return { ...prev, text: rawText };
        }
        const nextId = ++instanceCounterRef.current;

        openTimerRef.current = window.setTimeout(() => {
          openTimerRef.current = null;
          if (activeHostRef.current !== host || !host.isConnected) return;
          setState((cur) =>
            cur && cur.host === host
              ? { ...cur, visible: true }
              : { host, text: rawText, visible: true, instanceId: nextId },
          );
        }, OPEN_DELAY_MS);

        return { host, text: rawText, visible: false, instanceId: nextId };
      });
    },
    [clearTimers, detachObserver, hideNow],
  );

  useEffect(() => {
    const onPointerOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const host = findTooltipHost(e.target);
      if (!host) return;
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      if (activeHostRef.current === host) return;
      activateHost(host);
    };

    const onPointerOut = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const currentHost = activeHostRef.current;
      if (!currentHost) return;
      const related = e.relatedTarget;
      if (related instanceof Node && currentHost.contains(related)) return;

      const nextHost = findTooltipHost(related);
      if (nextHost && nextHost !== currentHost) {
        activateHost(nextHost);
        return;
      }

      clearTimers();
      hideTimerRef.current = window.setTimeout(() => {
        hideNow();
      }, HIDE_GRACE_MS);
    };

    const onFocusIn = (e: FocusEvent) => {
      const host = findTooltipHost(e.target);
      if (!host) return;
      try {
        if (!host.matches(':focus-visible')) return;
      } catch {
        return;
      }
      activateHost(host);
    };

    const onFocusOut = () => hideNow();
    const onPointerDown = () => hideNow();
    const onScroll = () => {
      if (activeHostRef.current) hideNow();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeHostRef.current) hideNow();
    };
    const onWindowBlur = () => hideNow();
    const onVisibilityChange = () => {
      if (document.hidden) hideNow();
    };

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('resize', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('resize', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearTimers();
      detachObserver();
      activeHostRef.current = null;
    };
  }, [activateHost, clearTimers, detachObserver, hideNow]);

  useLayoutEffect(() => {
    if (!state?.visible || !tipRef.current) return;
    if (!state.host.isConnected) {
      hideNow();
      return;
    }

    const anchorRect = state.host.getBoundingClientRect();
    if (anchorRect.width === 0 && anchorRect.height === 0) {
      hideNow();
      return;
    }

    const tipRect = tipRef.current.getBoundingClientRect();
    const nextPos = computeTooltipPosition(
      anchorRect,
      { width: tipRect.width, height: tipRect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos(nextPos);
  }, [state, hideNow]);

  if (!state?.visible || typeof document === 'undefined') return null;

  const parsed = parseTooltipContent(state.text);
  if (parsed.kind === 'empty') return null;

  const placement = pos?.placement ?? 'top';
  const animClass =
    pos === null
      ? 'opacity-0'
      : placement === 'top'
        ? 'aq-tooltip-in-top'
        : 'aq-tooltip-in-bottom';

  return createPortal(
    <div
      key={state.instanceId}
      ref={tipRef}
      role="tooltip"
      data-placement={placement}
      style={{
        position: 'fixed',
        top: pos ? `${pos.top}px` : '-9999px',
        left: pos ? `${pos.left}px` : '-9999px',
        zIndex: 9999,
      }}
      className={`pointer-events-none select-none aq-tooltip-surface ${animClass} ${
        parsed.kind === 'single'
          ? 'max-w-[min(340px,calc(100vw-24px))] rounded-lg px-2.5 py-1.5 text-[12px] font-medium leading-snug text-ink-hi'
          : 'min-w-[230px] max-w-[min(430px,calc(100vw-24px))] rounded-xl px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-hi'
      }`}
    >
      {parsed.kind === 'single' ? (
        <div className="break-words">{parsed.text}</div>
      ) : (
        <div>
          <div className="mb-2 border-b border-base-700/75 pb-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold tracking-[0.01em] text-ink-strong break-words">
                {parsed.headerLabel}
              </span>
              {parsed.headerValue && (
                <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums text-accent">
                  {parsed.headerValue}
                </span>
              )}
            </div>
            {parsed.headerNote && (
              <div className="mt-0.5 text-[11px] leading-snug text-ink-faint">
                {parsed.headerNote}
              </div>
            )}
          </div>
          <div className="space-y-1">
            {parsed.rows.map((row, idx) =>
              row.kind === 'kv' ? (
                <div
                  key={idx}
                  className="flex items-baseline justify-between gap-3 text-[11.5px] leading-snug"
                >
                  <span className="flex shrink-0 items-center gap-1.5 text-ink-lo">
                    {row.isBullet && (
                      <span
                        aria-hidden="true"
                        className="h-1 w-1 shrink-0 rounded-full bg-ink-faint/80"
                      />
                    )}
                    <span>{row.label}</span>
                  </span>
                  <span className="text-right font-mono tabular-nums text-ink-hi break-words">
                    {row.value}
                  </span>
                </div>
              ) : (
                <div
                  key={idx}
                  className="flex items-start gap-1.5 text-[11.5px] leading-snug text-ink-mid break-words"
                >
                  {row.isBullet && (
                    <span
                      aria-hidden="true"
                      className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-ink-faint/80"
                    />
                  )}
                  <span>{row.text}</span>
                </div>
              ),
            )}
          </div>
        </div>
      )}

      {pos && (
        <span
          aria-hidden="true"
          className={`aq-tooltip-arrow ${
            placement === 'top' ? 'aq-tooltip-arrow-bottom' : 'aq-tooltip-arrow-top'
          }`}
          style={{ left: `${pos.arrowLeft}px` }}
        />
      )}
    </div>,
    document.body,
  );
}
