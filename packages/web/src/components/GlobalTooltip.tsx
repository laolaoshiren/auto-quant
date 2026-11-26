import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* ============================================================================
 *  全局悬停提示层（GlobalTooltipLayer）
 *
 *  自动接管全站所有原生 `[title]` 属性：
 *  - 零侵入：现有 380+ 处 `title="..."` 自动升级为磨砂玻璃卡片，无需逐个组件改造；
 *  - 不双弹：悬停/聚焦时暂存 `title` 到 `data-aq-title` 并移除原生属性，离开/卸载时恢复，
 *    保持可访问性与单测兼容，且绝不触碰 SVG `<title>` 元素；
 *  - 结构化排版：单行提示渲染为精致胶囊；多行 `\n` / `· ` 提示自动识别标题、分隔线与
 *    左右对齐的键值明细（如 Token 计费公式、缓存说明、盈亏拆分）；
 *  - 视口自适应：默认目标上方居中 + 指示小三角，触顶自动翻转到底部，左右贴边自动夹紧。
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

const COLD_OPEN_DELAY_MS = 220;
const WARM_SWITCH_DELAY_MS = 40;
const WARM_WINDOW_MS = 360;
const HIDE_GRACE_MS = 60;
const EDGE_MARGIN_PX = 12;
const TARGET_GAP_PX = 9;
const ARROW_INSET_PX = 14;
const STASH_ATTR = 'data-aq-title';

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
 * 将原始 `title` 字符串解析为单行胶囊或结构化多行卡片数据。
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
    const parenMatch = /^([^（(]+?)\s*[（(]([^）)]+)[）)]$/.exec(headerSplit.value);
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

function isEligibleElement(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'title') return false;
  if (el.hasAttribute('data-native-tooltip')) return false;
  const raw = el.getAttribute('title') ?? el.getAttribute(STASH_ATTR);
  return Boolean(raw && raw.trim().length > 0);
}

function findTooltipHost(node: EventTarget | null): Element | null {
  if (!node || !(node instanceof Node)) return null;
  let cur: Element | null = node instanceof Element ? node : node.parentElement;
  while (cur) {
    if (isEligibleElement(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function stashTitle(el: Element): string {
  const live = el.getAttribute('title');
  if (live !== null) {
    el.setAttribute(STASH_ATTR, live);
    el.removeAttribute('title');
    return live;
  }
  return el.getAttribute(STASH_ATTR) ?? '';
}

function restoreTitle(el: Element | null): void {
  if (!el) return;
  const saved = el.getAttribute(STASH_ATTR);
  if (saved !== null) {
    if (!el.hasAttribute('title')) {
      el.setAttribute('title', saved);
    }
    el.removeAttribute(STASH_ATTR);
  }
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
  const lastVisibleAtRef = useRef<number>(0);
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

  const hideNow = useCallback(
    (recordWarmTimestamp = true) => {
      clearTimers();
      detachObserver();
      if (activeHostRef.current) {
        restoreTitle(activeHostRef.current);
        activeHostRef.current = null;
      }
      setState((prev) => {
        if (prev?.visible && recordWarmTimestamp) {
          lastVisibleAtRef.current = Date.now();
        }
        return null;
      });
      setPos(null);
    },
    [clearTimers, detachObserver],
  );

  const activateHost = useCallback(
    (host: Element, immediate = false) => {
      clearTimers();

      if (activeHostRef.current && activeHostRef.current !== host) {
        detachObserver();
        restoreTitle(activeHostRef.current);
      }

      const rawText = stashTitle(host).trim();
      if (!rawText) {
        restoreTitle(host);
        activeHostRef.current = null;
        setState(null);
        setPos(null);
        return;
      }

      const isSameHost = activeHostRef.current === host;
      activeHostRef.current = host;

      // 监听 React 在悬停期间动态更新 `title` 属性（如倒计时、状态徽章），实时同步到提示层
      detachObserver();
      const observer = new MutationObserver(() => {
        const updated = host.getAttribute('title');
        if (updated !== null) {
          host.setAttribute(STASH_ATTR, updated);
          host.removeAttribute('title');
          const trimmed = updated.trim();
          if (!trimmed) {
            hideNow(false);
          } else {
            setState((prev) => (prev && prev.host === host ? { ...prev, text: trimmed } : prev));
          }
        }
      });
      observer.observe(host, { attributes: true, attributeFilter: ['title'] });
      observerRef.current = observer;

      const warm =
        immediate ||
        isSameHost ||
        Date.now() - lastVisibleAtRef.current < WARM_WINDOW_MS;

      setState((prev) => {
        const alreadyVisible = Boolean(prev?.visible);
        if (alreadyVisible && isSameHost) {
          return prev ? { ...prev, text: rawText } : null;
        }
        const delay = immediate ? 0 : alreadyVisible || warm ? WARM_SWITCH_DELAY_MS : COLD_OPEN_DELAY_MS;
        const nextId = ++instanceCounterRef.current;

        if (delay === 0) {
          lastVisibleAtRef.current = Date.now();
          return { host, text: rawText, visible: true, instanceId: nextId };
        }

        openTimerRef.current = window.setTimeout(() => {
          openTimerRef.current = null;
          if (activeHostRef.current !== host || !host.isConnected) return;
          lastVisibleAtRef.current = Date.now();
          setState((cur) =>
            cur && cur.host === host ? { ...cur, visible: true } : { host, text: rawText, visible: true, instanceId: nextId },
          );
        }, delay);

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
      activateHost(host, false);
    };

    const onPointerOut = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const currentHost = activeHostRef.current;
      if (!currentHost) return;
      const related = e.relatedTarget;
      if (related instanceof Node && currentHost.contains(related)) return;

      const nextHost = findTooltipHost(related);
      if (nextHost && nextHost !== currentHost) {
        activateHost(nextHost, false);
        return;
      }

      clearTimers();
      hideTimerRef.current = window.setTimeout(() => {
        hideNow(true);
      }, HIDE_GRACE_MS);
    };

    const onFocusIn = (e: FocusEvent) => {
      const host = findTooltipHost(e.target);
      if (!host) return;
      // 仅在键盘导航触发 `:focus-visible` 时弹出，避免鼠标点击按钮后残留提示
      try {
        if (!host.matches(':focus-visible')) return;
      } catch {
        return;
      }
      activateHost(host, false);
    };

    const onFocusOut = () => {
      hideNow(true);
    };

    const onPointerDown = () => {
      hideNow(false);
    };

    const onScroll = () => {
      if (activeHostRef.current) hideNow(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeHostRef.current) {
        hideNow(false);
      }
    };

    const onWindowBlur = () => {
      hideNow(false);
    };

    const onVisibilityChange = () => {
      if (document.hidden) hideNow(false);
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
      restoreTitle(activeHostRef.current);
      activeHostRef.current = null;
    };
  }, [activateHost, clearTimers, detachObserver, hideNow]);

  useLayoutEffect(() => {
    if (!state?.visible || !tipRef.current) return;
    if (!state.host.isConnected) {
      hideNow(false);
      return;
    }

    const anchorRect = state.host.getBoundingClientRect();
    if (anchorRect.width === 0 && anchorRect.height === 0) {
      hideNow(false);
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
