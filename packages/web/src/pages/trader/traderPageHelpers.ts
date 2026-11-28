import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import type { TraderAccountState } from '../../components/BalanceCells';

export type ChartTab = 'equity' | 'candles';


/**
 * 展开后的权益曲线高度。
 *
 * 220px 在 900px 视口上约 24% 屏高。
 *
 * ⚠️ **这个高度不再随数据变化。** 曲线以前会在"数据太薄"时塌成
 * `EquityMiniStrip` 的 36px 细条，于是同一块版面会随数据变高变矮 ——
 * 用户明确要求"不管有没有数据都保持展开状态一致"（总览页那条的同一句话）。
 * 细条现在只在**用户自己点了「收起」**时出现，那是显式动作，不是数据决定的。
 *
 * 决策流**不再有对应的常量**：它住在右栏，高度由外壳那份"可视区 − 顶栏"给，
 * 页面手算一个视口高度必然算错（见 `DecisionFeed` 顶部注释）。
 */
/*
 * 权益曲线的高度：**跟随视口，而不是写死 220px**。
 *
 * ## 为什么
 *
 * 用户的原话：「这一整块区域，内容你想办法压缩一下，尽最大可能让用户不翻页
 * 就能看完整信息（尽量不出现滚动条翻页）」。
 *
 * 实测 1405x722（主栏可视高度只有 322px，而内容有 622px）：
 *
 *     header 62 + 指标卡 90 + 账户条 37 + 图表面板 321 + 间距 112 = 622
 *
 * 图表面板里的 220px 是写死的，而主栏在 722 高的窗口下只剩这么点地方 ——
 * 它必须能被压。改成 `clamp(120px, 22vh, 260px)` 之后：
 *
 *   · 722 高的窗口 → 115px
 *   · 900 高的窗口 → 144px
 *   · 1080 高的窗口 → 173px（大屏上仍然是一张像样的图）
 *
 * 下限 110px 保证曲线还看得出走势（扣掉 X 轴标签后绘图区约 70px）；
 * 上限 260px 防止 4K 屏上图表变成一块占满半屏的空白。
 *
 * ⚠️ **必须是数字，不能是 `clamp(...)` 这种 CSS 字符串。**
 *
 * 第一版写成 `clamp(110px, 16vh, 260px)`：recharts 的 `ResponsiveContainer`
 * 把 `height` 原样写进内联样式（浏览器认），但它**内部还要把这个值解析成
 * 数字**去算画布尺寸 —— 解析失败就什么都不画。实测症状是容器高度 116px、
 * 里面 `<svg>` 为 `null`、`path` 数量 0：一块**空白的框**，看起来像"没有数据"。
 * 所以改由 `useEquityChartHeight()` 在 JS 里算出像素值。
 */
export const EQUITY_CHART_MIN = 88;
export const EQUITY_CHART_FALLBACK = 220;

/**
 * 实时量测图表的 `flex-1` 弹性宿主高度（像素整数）。
 *
 * 必须接收 callback ref 捕获到的 DOM 节点（而不是 `RefObject`）：`TraderPage` 首屏
 * 在 `tradersQuery.loading` 时会提前返回加载态，若用 `RefObject`，首次 effect 拿到的
 * 是 `null` 且后续节点挂载时依赖不变，导致 `ResizeObserver` 永远挂不上。
 */
export function useMeasuredHeight(
  el: HTMLDivElement | null,
  minHeight = EQUITY_CHART_MIN,
  fallback = EQUITY_CHART_FALLBACK,
): number {
  const [height, setHeight] = useState(fallback);

  useLayoutEffect(() => {
    if (!el) return;

    const measure = () => {
      const next = Math.max(minHeight, Math.floor(el.clientHeight));
      setHeight((prev) => (prev === next ? prev : next));
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, minHeight]);

  return height;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Narrow the untyped `/traders/:id/account` payload.
 *
 * The endpoint returns the exchange's own account object, whose shape is owned
 * by the backend; only the balance fields are read here, and anything missing
 * stays `undefined` so the panel shows `—` instead of a fabricated zero.
 */
export function toAccountState(raw: Record<string, unknown> | null): TraderAccountState | null {
  if (!raw) return null;
  const equity = num(raw.equity);
  const walletBalance = num(raw.walletBalance);
  const availableBalance = num(raw.availableBalance);
  if (equity === undefined || walletBalance === undefined || availableBalance === undefined) {
    return null;
  }
  return {
    equity,
    walletBalance,
    availableBalance,
    unrealizedPnl: num(raw.unrealizedPnl) ?? 0,
    marginUsed: num(raw.marginUsed) ?? 0,
    openOrderMargin: num(raw.openOrderMargin),
  };
}

/**
 * The running-bot dashboard.
 *
 * 版式按 `LAYOUT.md` §0/§2/§3：**左边主内容（约 60%）+ 右边决策栏（约 40%）**。
 *
 * - 主栏内部顺序固定：对象头 → 指标行 → 图表 → 表格（§3）。页头只留一行
 *   "我是谁、什么状态、能做什么"；变化很慢的配置收进 `ConfigSummary`。
 * - 指标从 280px 的**竖排**左栏改成**横排 4 张卡**（§0 规则 3）：竖排会让每个指标
 *   白占一整行宽度，而它们的数值都很短。
 * - **决策流搬到右栏**并自己撑满屏高、自己滚动（§2）—— 它是这一页最该被盯着的
 *   部分，以前被一张占 40% 屏高的平线权益图挤到了页面底部。
 * - 权益曲线只在**真有形状**时才画成图表，否则压成 36px 的缩略条。
 */
/*
 * 「最近错误」的收起状态。
 *
 * ## 为什么记的是**消息指纹**，而不是一个"关过没"的布尔值
 *
 * 存一个布尔值最容易写 —— 而那意味着**关一次之后就再也看不到新错误了**，
 * 那是另一种谎，而且更危险：真出问题时页面上安安静静。
 *
 * 所以存的是**这一条消息**被关过。新的一条（内容不同）指纹不同，照常显示。
 * 放在 `sessionStorage` 而不是 `localStorage`：关掉标签页就忘掉，
 * 下次打开还能看见当前这条 —— 收起是"这一会儿不想看"，不是"永远别看"。
 */
export const ERROR_DISMISS_KEY = 'aq.traderErrorDismissed';
export const INTEL_SPLIT_HEIGHT_KEY = 'aq.traderIntelHeight.v1';
export const INTEL_MIN_H = 72;
/** 图表卡片真实最小可用高度（标题栏 ~44 + 统计行 ~28 + 内边距 18 + 曲线最小高 88 + 边框/余量 10 = 188px），防止被压扁后 SVG 溢出遮挡拖动条 */
export const CHART_PANEL_MIN_H = 188;
export const SPLIT_HANDLE_H = 14;

export function loadSavedIntelHeight(): number | null {
  try {
    const raw = localStorage.getItem(INTEL_SPLIT_HEIGHT_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= INTEL_MIN_H ? Math.round(parsed) : null;
  } catch {
    return null;
  }
}

export function saveIntelHeight(value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(INTEL_SPLIT_HEIGHT_KEY);
    else localStorage.setItem(INTEL_SPLIT_HEIGHT_KEY, String(Math.round(value)));
  } catch {
    /* 隐私模式或配额受限时静默忽略，仅保持当前会话态。 */
  }
}

export function dismissedFingerprint(): string {
  try {
    return sessionStorage.getItem(ERROR_DISMISS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function dismissError(message: string): void {
  try {
    sessionStorage.setItem(ERROR_DISMISS_KEY, message);
  } catch {
    /* 存不了就让它在这次渲染里消失也行 —— 不值得为它报错。 */
  }
}

