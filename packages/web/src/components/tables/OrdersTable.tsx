import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import {
  exchangeErrorLabel,
  orderPurposeLabel,
  orderStatusLabel,
  orderTypeLabel,
  type MarginMode,
  type OrderRecord,
} from '@aq/shared';
import { needsReconcileFlag, reconcileNoteTitle } from '../../lib/orderFlags';
import { isOpenOrder, mergeOrderRows, pickNewerOrder } from '../../lib/orderMerge';
import { Badge, ErrorNote, Spinner3 } from '../ui';
import {
  BALANCE_LABEL,
  elapsedMinutesSince,
  fmtDateTime,
  fmtPendingDuration,
  fmtPrice,
  fmtQty,
  fmtUsd,
} from '../../lib/format';
import { useDelayedSpinner, type TablePaging } from './useTablePaging';
import {
  COLLAPSED_MAX_H,
  EXPANDED_MAX_H,
  MarginModeCell,
  ORDER_MARGIN_MODE_TITLE,
  ORDER_MARGIN_USED_TITLE,
  PageTail,
  SymbolCell,
  TableEmpty,
  useSymbolTones,
} from './shared';

/**
 * 单调合并策略：按 `id` / `exchangeOrderId` 去重，且保证陈旧 REST 轮询绝不把已终态
 * 订单倒退回 `NEW`。
 */
export const ORDER_MERGE_OPTIONS = {
  reconcile: pickNewerOrder,
  mergeAll: mergeOrderRows,
};

export { isOpenOrder };

/**
 * 委托表的「方向」列：开仓/加仓显示做多/做空，止损/止盈显示 `—`，平仓保留买入/卖出。
 */
function OrderSideCell({ order }: { order: OrderRecord }) {
  const long = order.side === 'BUY';

  if (order.purpose === 'stop_loss' || order.purpose === 'take_profit') {
    return (
      <span
        className="text-ink-faint"
        title="止损 / 止盈是「平掉这个仓位」的条件单，方向对它们没有意义 —— 买或卖只是交易所执行平仓用的动词。"
      >
        —
      </span>
    );
  }

  if (order.purpose === 'entry' || order.purpose === 'adjustment') {
    return (
      <span
        className={long ? 'text-up' : 'text-down'}
        title={long ? '买入开仓 = 做多' : '卖出开仓 = 做空'}
      >
        {long ? '做多' : '做空'}
      </span>
    );
  }

  return (
    <span className={long ? 'text-up' : 'text-down'} title={long ? '买入平仓（平掉空头）' : '卖出平仓（平掉多头）'}>
      {long ? '买入' : '卖出'}
    </span>
  );
}

/** 只有开仓/加仓单显示杠杆；保护单显示 `—`（杠杆是仓位属性而非条件单属性）。 */
function LeverageCell({ order }: { order: OrderRecord }) {
  const leverage = order.leverage;
  const owned = order.purpose === 'entry' || order.purpose === 'adjustment';
  if (!owned) {
    return (
      <span className="text-ink-faint" title={`${order.type || '这张单'}不显示杠杆 —— 杠杆是它所属仓位的属性，印在保护单上会被误读成"这张单是 N 倍杠杆"。`}>
        —
      </span>
    );
  }
  if (typeof leverage !== 'number' || leverage <= 0) {
    return (
      <span
        className="text-ink-faint"
        title={`没有 ${order.symbol} 的杠杆读数 —— 本地既没有该标的的持仓行，也没有它的挂单行，所以这个数确实不存在（不补默认值）。`}
      >
        —
      </span>
    );
  }
  return <span title={`${order.symbol} 的杠杆倍数 ${leverage}x（来自本地持仓/挂单行上的设置）。`}>{leverage}x</span>;
}

function purposeTone(purpose: string): 'accent' | 'neutral' | 'down' | 'up' | 'warn' {
  switch (purpose) {
    case 'entry':
      return 'accent';
    case 'stop_loss':
      return 'down';
    case 'take_profit':
      return 'up';
    case 'adjustment':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function OrdersTable({
  paging,
  onlyOpen,
  positionCount,
  paper,
  onSelectSymbol,
  collapsed = false,
  fillHeight = false,
  liveMarginModes,
}: {
  paging: TablePaging<OrderRecord>;
  onlyOpen: boolean;
  /** 本地持仓数：判断"这张看起来还挂着的单"能不能被相信，见状态列上的标注。 */
  positionCount: number;
  /** 这台机器人在不在模拟盘（`lib/glossary.ts` 的 `isPaperView`）。必填。 */
  paper: boolean;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
  /** 收起态：只把滚动框的 `max-height` 改小，不动 DOM 结构。 */
  collapsed?: boolean;
  /** 为真时撑满父容器（手动拖动底部高度时使用）。 */
  fillHeight?: boolean;
  /** 保证金模式的兜底来源：当前持仓的 `symbol → marginType`。 */
  liveMarginModes?: ReadonlyMap<string, MarginMode> | null;
}) {
  const all: OrderRecord[] = paging.rows;
  const orders = onlyOpen ? all.filter(isOpenOrder) : all;
  const symbolTones = useSymbolTones(orders.map((o) => o.symbol));

  // 当前委托表需要实时刷新「已挂时长」；无活跃挂单时不跑定时器。
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!onlyOpen || orders.length === 0) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [onlyOpen, orders.length]);

  const showSpinner = useDelayedSpinner(paging.loading && !paging.hasLoadedOnce && all.length === 0);

  if (paging.error !== null && all.length === 0) {
    return (
      <div className="p-3">
        <ErrorNote>订单记录读取失败（这不等于没有委托）：{paging.error}</ErrorNote>
      </div>
    );
  }

  if (!paging.hasLoadedOnce && all.length === 0) {
    if (showSpinner) return <Spinner3 label="正在加载委托" />;
    return <div className="py-8" aria-hidden />;
  }

  if (orders.length === 0) {
    return (
      <div>
        {paging.error !== null && (
          <div className="px-3 pt-2">
            <ErrorNote>读取失败，下面是上一次成功读到的状态：{paging.error}</ErrorNote>
          </div>
        )}
        {onlyOpen ? (
          <TableEmpty message="暂无当前委托。" hint="交易所侧的止损 / 止盈单在触发前会出现在这里。" />
        ) : (
          <TableEmpty message="暂无订单记录。" />
        )}
      </div>
    );
  }

  return (
    <div className={fillHeight ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      {paging.error !== null && (
        <ErrorNote className="mb-2 shrink-0">
          读取失败，下面是上一次成功读到的记录：{paging.error}
        </ErrorNote>
      )}
      <div
        ref={paging.scrollerRef}
        className={`scroll-x ${fillHeight ? 'min-h-0 flex-1' : collapsed ? COLLAPSED_MAX_H : EXPANDED_MAX_H} overflow-y-auto`}
      >
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              <th className="th" title="这笔委托被创建的时间。">
                下单时间
              </th>
              {onlyOpen && (
                <th className="th" title="该挂单自创建至今持续等待成交的时长（实时更新）。">
                  已挂时长
                </th>
              )}
              <th className="th">交易对</th>
              <th className="th">用途</th>
              <th className="th">方向</th>
              <th className="th">类型</th>
              <th className="th text-right">数量</th>
              <th className="th text-right" title={ORDER_MARGIN_USED_TITLE}>
                {BALANCE_LABEL.marginUsed}
              </th>
              <th className="th text-right" title="该标的当前的杠杆倍数（来自当前持仓读数，不是下单当时的快照）">
                杠杆
              </th>
              <th className="th" title={ORDER_MARGIN_MODE_TITLE}>
                保证金模式
              </th>
              <th className="th text-right">价格</th>
              <th className="th text-right">触发价</th>
              <th className="th text-right">已成交</th>
              <th className="th text-right">均价</th>
              <th className="th">状态</th>
              <th className="th">错误</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const pendingReconcile = needsReconcileFlag({
                onlyOpen,
                stillOpen: isOpenOrder(order),
                purpose: order.purpose,
                positionCount,
                paper,
              });

              const fullyFilled =
                order.quantity > 0 &&
                order.filledQty >= order.quantity * (1 - 1e-9) &&
                !/cancel|reject|expired/i.test(order.status);

              const pendingMins = onlyOpen ? elapsedMinutesSince(order.createdAt, nowMs) : null;
              const pendingText = onlyOpen ? fmtPendingDuration(order.createdAt, nowMs) : null;

              return (
                <tr key={order.id} className="row-hover" data-row-id={order.id}>
                  <td className="td num text-ink-faint">{fmtDateTime(order.createdAt)}</td>
                  {onlyOpen && (
                    <td
                      className={`td num whitespace-nowrap ${
                        pendingMins !== null && pendingMins >= 60
                          ? 'font-semibold text-warn'
                          : pendingMins !== null && pendingMins >= 30
                            ? 'text-warn'
                            : 'text-ink-mid'
                      }`}
                      title={`已持续挂单 ${pendingText ?? '—'}（下单时间 ${fmtDateTime(order.createdAt)}）`}
                    >
                      <span className="inline-flex items-center gap-1">
                        <Clock aria-hidden className="h-3 w-3 shrink-0 opacity-70" />
                        {pendingText}
                      </span>
                    </td>
                  )}
                  <td className="td font-semibold">
                    <SymbolCell symbol={order.symbol} onSelect={onSelectSymbol} tone={symbolTones.get(order.symbol)} />
                  </td>
                  <td className="td">
                    <Badge tone={purposeTone(order.purpose)}>{orderPurposeLabel(order.purpose)}</Badge>
                  </td>
                  <td className="td font-semibold">
                    <OrderSideCell order={order} />
                  </td>
                  <td className="td text-ink-lo">{orderTypeLabel(order.type)}</td>
                  <td className="td num text-right">{fmtQty(order.quantity)}</td>
                  <td className="td num text-right">{fmtUsd(order.marginUsed, 2)}</td>
                  <td className="td num text-right">
                    <LeverageCell order={order} />
                  </td>
                  <td className="td">
                    <MarginModeCell order={order} liveBySymbol={liveMarginModes} />
                  </td>
                  <td className="td num text-right">{order.price ? fmtPrice(order.price) : '市价'}</td>
                  <td className="td num text-right text-ink-lo">{order.stopPrice ? fmtPrice(order.stopPrice) : '—'}</td>
                  <td className="td num text-right">{fmtQty(order.filledQty)}</td>
                  <td className="td num text-right">{order.avgPrice ? fmtPrice(order.avgPrice) : '—'}</td>
                  <td className="td">
                    <span
                      title={
                        pendingReconcile
                          ? reconcileNoteTitle(order.status)
                          : fullyFilled
                            ? `成交数量 ${fmtQty(order.filledQty)} 已等于下单数量 ${fmtQty(order.quantity)}，所以这一单实质已成交 —— 尽管交易所那一刻返回的状态是 ${order.status}。`
                            : order.status
                      }
                      className={
                        pendingReconcile
                          ? 'text-warn'
                          : isOpenOrder(order)
                            ? 'text-up'
                            : /cancel|reject|expired/i.test(order.status)
                              ? 'text-warn'
                              : 'text-ink-mid'
                      }
                    >
                      {fullyFilled ? '已成交' : orderStatusLabel(order.status)}
                    </span>
                  </td>
                  <td className="td max-w-[240px] truncate text-down" title={order.error ?? undefined}>
                    {order.error ? exchangeErrorLabel(order.error) : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <PageTail
          sentinelRef={paging.sentinelRef}
          hasMore={paging.hasMore}
          moreState={paging.moreState}
          moreError={paging.moreError}
          onRetry={paging.retry}
          noun="订单"
        />
      </div>
    </div>
  );
}
