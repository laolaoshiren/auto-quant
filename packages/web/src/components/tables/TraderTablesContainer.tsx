import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  ChevronDown,
  ChevronUp,
  FileText,
  History,
  Layers,
  ListOrdered,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import type { MarginMode, OrderRecord, TradeRecord } from '@aq/shared';
import { api } from '../../lib/api';
import { isOpenOrder } from '../../lib/orderMerge';
import { useEvents } from '../../lib/store';
import { usePolled, useTabVisible } from '../../lib/hooks';
import { Button, Panel } from '../ui';
import { pickPositions } from '../../lib/pickPositions';
import { PAGE_LIMIT, useTablePaging } from './useTablePaging';
import { ClosePositionModal } from './ClosePositionModal';
import { PositionsTable } from './PositionsTable';
import { ORDER_MERGE_OPTIONS, OrdersTable } from './OrdersTable';
import { TradesTable } from './TradesTable';

export type TraderTabId = 'positions' | 'orders' | 'trades' | 'history';

const DOCK_HEIGHT_STORAGE_KEY = 'aq.traderDockBodyHeight';
const DOCK_MIN_BODY_H = 72;
const DOCK_MAX_BODY_RATIO = 0.58;

function clampDockBodyHeight(raw: number): number {
  const maxAllowed =
    typeof window !== 'undefined'
      ? Math.max(240, Math.round(window.innerHeight * DOCK_MAX_BODY_RATIO))
      : 520;
  return Math.round(Math.min(maxAllowed, Math.max(DOCK_MIN_BODY_H, raw)));
}

function loadSavedDockBodyHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(DOCK_HEIGHT_STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < DOCK_MIN_BODY_H) return null;
    return clampDockBodyHeight(n);
  } catch {
    return null;
  }
}

function persistDockBodyHeight(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(DOCK_HEIGHT_STORAGE_KEY);
    else window.localStorage.setItem(DOCK_HEIGHT_STORAGE_KEY, String(Math.round(value)));
  } catch {
    /* ignore storage errors */
  }
}

export function TraderTables({
  traderId,
  tab,
  onChange,
  positionCount,
  paper,
  refreshToken,
  onSelectSymbol,
  positionSymbols,
  onPositionsChanged,
  onOpenOrdersChange,
  positions,
}: {
  traderId: number;
  tab: TraderTabId;
  onChange: (tab: TraderTabId) => void;
  positionCount: number;
  /** 这台机器人在不在模拟盘（由页面按 `isPaperView()` 算好传下来）。 */
  paper: boolean;
  /** Bumped by the caller after a manual 对账, so the tables refetch immediately. */
  refreshToken?: number;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
  /** 当前持仓的币种 —— 弹窗用它把"全部"说成"全部 N 个持仓"。 */
  positionSymbols: string[];
  /** 平仓成功后通知页面立刻重取持仓 —— 否则界面还留着刚平掉的那一行。 */
  onPositionsChanged?: () => void;
  /** 将 REST+WS 合并后的当前活跃委托同步给父页（供 K 线图绘制挂单/止损/止盈线，避免重复轮询）。 */
  onOpenOrdersChange?: (orders: OrderRecord[]) => void;
  /** 当前持仓数组 —— 供两张订单表与成交表作为保证金模式兜底映射。 */
  positions?: ReadonlyArray<{ symbol: string; marginType?: MarginMode | null; leverage?: number | null }>;
}) {
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [ordersRefreshToken, setOrdersRefreshToken] = useState(0);
  const [symbolFilter, setSymbolFilter] = useState('');

  const liveMarginModes = useMemo(() => {
    const map = new Map<string, MarginMode>();
    for (const position of positions ?? []) {
      if (position.marginType === 'cross' || position.marginType === 'isolated') {
        map.set(position.symbol, position.marginType);
      }
    }
    return map;
  }, [positions]);

  const token = (refreshToken ?? 0) + ordersRefreshToken;
  const isHeavyTab = tab === 'trades' || tab === 'history';

  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [positionsCollapsed, setPositionsCollapsed] = useState(false);

  const resizeHandleRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const tableAreaRef = useRef<HTMLDivElement | null>(null);

  // 点表格区域之外 → 历史区自动收起（不切标签）。
  useEffect(() => {
    if (!isHeavyTab || historyCollapsed) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      if (manualBodyHeightRef.current !== null) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        resizeHandleRef.current?.contains(target) ||
        toolbarRef.current?.contains(target) ||
        tableAreaRef.current?.contains(target)
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;
      setHistoryCollapsed(true);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [isHeavyTab, historyCollapsed]);

  // 持仓表点外收缩 / 点内放大（仅在 positions 标签页挂监听器；工具栏与拖拽条不算在内）。
  useEffect(() => {
    if (tab !== 'positions') return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      if (manualBodyHeightRef.current !== null) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (resizeHandleRef.current?.contains(target) || toolbarRef.current?.contains(target)) return;
      const inTable = tableAreaRef.current?.contains(target) ?? false;
      setPositionsCollapsed(!inTable);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [tab]);

  const tabVisible = useTabVisible();
  const liveOrders = useEvents((s) => s.byTrader[traderId]?.orders);
  const ordersQuery = usePolled(
    (signal) => api.traderOrders(traderId, { limit: PAGE_LIMIT, signal }),
    { intervalMs: 15_000, enabled: Number.isFinite(traderId) && tabVisible, deps: [traderId, token, tabVisible] },
  );
  const ordersPaging = useTablePaging<OrderRecord>(
    traderId,
    api.traderOrders,
    ordersQuery,
    liveOrders,
    undefined,
    tab,
    ORDER_MERGE_OPTIONS,
  );
  const openOrders = ordersPaging.rows.filter(isOpenOrder);
  const openOrdersSig = openOrders
    .map((o) => `${o.id}:${o.symbol}:${o.status}:${o.purpose}:${o.price ?? ''}:${o.stopPrice ?? ''}`)
    .join('|');
  const openOrdersRef = useRef(openOrders);
  openOrdersRef.current = openOrders;
  useEffect(() => {
    onOpenOrdersChange?.(openOrdersRef.current);
  }, [onOpenOrdersChange, openOrdersSig]);

  const liveTrades = useEvents((s) => s.byTrader[traderId]?.trades);
  const tradesQuery = usePolled(
    (signal) => api.traderTrades(traderId, { limit: PAGE_LIMIT, signal }),
    { intervalMs: 15_000, enabled: Number.isFinite(traderId) && tabVisible, deps: [traderId, token, tabVisible] },
  );
  const tradesPaging = useTablePaging<TradeRecord>(
    traderId,
    api.traderTrades,
    tradesQuery,
    liveTrades,
    (row) => row.closedAt,
    tab,
  );

  // 全页唯一一份 `/positions` 实时轮询，供持仓表、全部平仓按钮与顶栏浮盈同步共用。
  const livePositions = useEvents((s) => s.byTrader[traderId]?.positions);
  const setLivePositions = useEvents((s) => s.setPositions);
  const positionsQuery = usePolled((signal) => api.traderPositions(traderId, signal), {
    intervalMs: 10_000,
    enabled: Number.isFinite(traderId) && tabVisible,
    deps: [traderId, token, tabVisible],
  });
  useEffect(() => {
    const rows = positionsQuery.data;
    if (rows && Number.isFinite(traderId)) setLivePositions(traderId, rows);
  }, [positionsQuery.data, traderId, setLivePositions]);
  const closableCount = pickPositions(positionsQuery.data, livePositions).length;

  const filteredOrdersPaging = useMemo(() => {
    const q = symbolFilter.trim().toUpperCase();
    if (!q || tab !== 'history') return ordersPaging;
    return {
      ...ordersPaging,
      rows: ordersPaging.rows.filter((r) => r.symbol.toUpperCase().includes(q)),
    };
  }, [ordersPaging, symbolFilter, tab]);

  const filteredTradesPaging = useMemo(() => {
    const q = symbolFilter.trim().toUpperCase();
    if (!q || tab !== 'trades') return tradesPaging;
    return {
      ...tradesPaging,
      rows: tradesPaging.rows.filter((r) => r.symbol.toUpperCase().includes(q)),
    };
  }, [tradesPaging, symbolFilter, tab]);

  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [manualBodyHeight, setManualBodyHeight] = useState<number | null>(loadSavedDockBodyHeight);
  const [resizingDock, setResizingDock] = useState(false);
  const hasManualHeight = manualBodyHeight !== null;
  const manualBodyHeightRef = useRef<number | null>(manualBodyHeight);
  manualBodyHeightRef.current = manualBodyHeight;
  const dockCollapsedRef = useRef<boolean>(dockCollapsed);
  dockCollapsedRef.current = dockCollapsed;

  useEffect(() => {
    if (!hasManualHeight) return;
    const onResize = () => setManualBodyHeight((prev) => (prev === null ? null : clampDockBodyHeight(prev)));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [hasManualHeight]);

  const startDockResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = dockCollapsedRef.current
      ? 0
      : (manualBodyHeightRef.current ??
          Math.round(tableAreaRef.current?.getBoundingClientRect().height ?? 160));
    let moved = false;
    let latestHeight: number | null = manualBodyHeightRef.current;

    setResizingDock(true);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: PointerEvent) => {
      const delta = startY - moveEvent.clientY;
      if (!moved && Math.abs(delta) < 3) return;
      moved = true;
      if (dockCollapsedRef.current) setDockCollapsed(false);
      const next = clampDockBodyHeight(startHeight + delta);
      latestHeight = next;
      setManualBodyHeight(next);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      setResizingDock(false);
      if (moved && latestHeight !== null) persistDockBodyHeight(latestHeight);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  }, []);

  const resetDockHeight = useCallback(() => {
    setManualBodyHeight(null);
    persistDockBodyHeight(null);
  }, []);

  const nudgeDockHeight = useCallback((deltaPx: number) => {
    setDockCollapsed(false);
    setManualBodyHeight((prev) => {
      const base = prev ?? Math.round(tableAreaRef.current?.getBoundingClientRect().height ?? 160);
      const next = clampDockBodyHeight(base + deltaPx);
      persistDockBodyHeight(next);
      return next;
    });
  }, []);

  const tabs: Array<{
    id: TraderTabId;
    label: string;
    icon: ReactNode;
    count?: number;
    highlightTone?: 'up' | 'accent';
  }> = [
    {
      id: 'positions',
      label: '当前持仓',
      icon: <Layers aria-hidden className="h-3.5 w-3.5" />,
      count: closableCount,
      highlightTone: 'up',
    },
    {
      id: 'orders',
      label: '当前委托',
      icon: <ListOrdered aria-hidden className="h-3.5 w-3.5" />,
      count: openOrders.length,
      highlightTone: 'accent',
    },
    { id: 'trades', label: '历史成交', icon: <History aria-hidden className="h-3.5 w-3.5" /> },
    { id: 'history', label: '订单记录', icon: <FileText aria-hidden className="h-3.5 w-3.5" /> },
  ];

  const toggleDockCollapse = () => {
    setDockCollapsed((prev) => !prev);
  };

  return (
    <Panel padded={false} bodyClassName="p-0" className="overflow-hidden">
      {/* 顶部上下拖拽条：手动调整底部数据表高度，上方图表与决策区自动弹性伸缩；双击恢复自动高度 */}
      <div
        ref={resizeHandleRef}
        role="separator"
        aria-orientation="horizontal"
        aria-label="上下拖动调整底部数据表高度，双击恢复自动高度"
        aria-valuenow={dockCollapsed ? 0 : (manualBodyHeight ?? undefined)}
        aria-valuemin={DOCK_MIN_BODY_H}
        tabIndex={0}
        title="上下拖动调整底部高度 · 双击恢复自动高度"
        onPointerDown={startDockResize}
        onDoubleClick={resetDockHeight}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            nudgeDockHeight(32);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            nudgeDockHeight(-32);
          } else if (event.key === 'Home') {
            event.preventDefault();
            resetDockHeight();
          }
        }}
        className={`group flex h-2.5 cursor-row-resize select-none items-center justify-center transition-colors ${
          resizingDock ? 'bg-accent/15' : 'bg-base-900 hover:bg-base-850'
        }`}
      >
        <span
          aria-hidden
          className={`h-1 w-12 rounded-full transition-colors ${
            resizingDock ? 'bg-accent' : 'bg-base-600/80 group-hover:bg-accent/80'
          }`}
        />
      </div>

      <div
        ref={toolbarRef}
        className={`flex flex-wrap items-center gap-2 bg-base-900 px-3 pb-2 pt-0.5 ${dockCollapsed ? '' : 'border-b border-base-800'}`}
      >
        <div
          role="tablist"
          aria-label="机器人数据表"
          className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-base-750 bg-base-950 p-0.5"
        >
          {tabs.map((item) => {
            const active = tab === item.id;
            const hasCount = item.count !== undefined && item.count > 0;
            const countClass = hasCount
              ? item.highlightTone === 'up'
                ? 'bg-up/20 text-up'
                : 'bg-accent/20 text-accent'
              : 'bg-base-800 text-ink-faint';
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  onChange(item.id);
                  if (dockCollapsed) setDockCollapsed(false);
                }}
                className={
                  active
                    ? 'inline-flex h-7 items-center gap-1.5 rounded-md bg-base-800 px-2.5 text-xs font-semibold text-ink-strong shadow-sm transition'
                    : 'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-ink-lo transition hover:bg-base-850/70 hover:text-ink-hi'
                }
              >
                <span className={active ? 'text-accent' : 'text-ink-faint'}>{item.icon}</span>
                <span>{item.label}</span>
                {item.count !== undefined && (
                  <span
                    className={`num inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 py-px text-[11px] font-semibold leading-tight ${countClass}`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {isHeavyTab && !dockCollapsed && (
          <div className="relative w-40 sm:w-44">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
            />
            <input
              type="text"
              value={symbolFilter}
              onChange={(e) => setSymbolFilter(e.target.value)}
              placeholder="筛选币种…"
              aria-label="按交易对筛选"
              className="input num !h-7 w-full !pl-8 !pr-7 text-xs"
            />
            {symbolFilter && (
              <button
                type="button"
                onClick={() => setSymbolFilter('')}
                aria-label="清空币种筛选"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-faint hover:text-ink-hi"
              >
                <X aria-hidden className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {closableCount > 0 && (
            <Button
              size="sm"
              variant="danger"
              title="市价平掉当前所有持仓并撤销关联保护单（需二次确认）"
              onClick={() => setCloseTarget('__all__')}
            >
              全部平仓 ({closableCount})
            </Button>
          )}
          {hasManualHeight && !dockCollapsed && (
            <Button
              size="sm"
              variant="ghost"
              title="恢复底部数据表按内容自动适配高度（也可双击顶部拖拽条）"
              onClick={resetDockHeight}
            >
              <RotateCcw aria-hidden className="h-3 w-3" />
              自动高度
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={!dockCollapsed}
            title={dockCollapsed ? '展开底部数据面板' : '收起底部数据面板，给上方图表与决策流留出更多视野'}
            onClick={toggleDockCollapse}
          >
            {dockCollapsed ? (
              <>
                <ChevronUp aria-hidden className="h-3.5 w-3.5" />
                展开
              </>
            ) : (
              <>
                <ChevronDown aria-hidden className="h-3.5 w-3.5" />
                收起
              </>
            )}
          </Button>
        </div>
      </div>

      <div
        ref={tableAreaRef}
        style={!dockCollapsed && hasManualHeight ? { height: manualBodyHeight } : undefined}
        className={
          dockCollapsed
            ? 'max-h-0 overflow-hidden'
            : hasManualHeight
              ? 'flex min-h-0 flex-col overflow-hidden'
              : undefined
        }
        aria-hidden={dockCollapsed || undefined}
      >
        {tab === 'positions' && (
          <PositionsTable
            traderId={traderId}
            refreshToken={token}
            query={positionsQuery}
            onCloseRequest={setCloseTarget}
            onSelectSymbol={onSelectSymbol}
            collapsed={!hasManualHeight && positionsCollapsed}
            fillHeight={hasManualHeight}
            openOrderCount={openOrders.length}
            onOpenOrdersTab={() => onChange('orders')}
          />
        )}
        {(tab === 'orders' || tab === 'history') && (
          <OrdersTable
            paging={filteredOrdersPaging}
            onlyOpen={tab === 'orders'}
            positionCount={positionCount}
            paper={paper}
            onSelectSymbol={onSelectSymbol}
            collapsed={!hasManualHeight && tab === 'history' ? historyCollapsed : undefined}
            fillHeight={hasManualHeight}
            liveMarginModes={liveMarginModes}
          />
        )}
        {tab === 'trades' && (
          <TradesTable
            traderId={traderId}
            refreshToken={token}
            onSelectSymbol={onSelectSymbol}
            collapsed={!hasManualHeight && historyCollapsed}
            fillHeight={hasManualHeight}
            paging={filteredTradesPaging}
            liveMarginModes={liveMarginModes}
          />
        )}
      </div>

      <ClosePositionModal
        traderId={traderId}
        target={closeTarget}
        symbols={positionSymbols}
        onClose={() => setCloseTarget(null)}
        onDone={() => {
          setOrdersRefreshToken((n) => n + 1);
          onPositionsChanged?.();
        }}
      />
    </Panel>
  );
}
