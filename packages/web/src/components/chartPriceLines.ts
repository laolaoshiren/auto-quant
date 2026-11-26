import type { OrderRecord, PositionView } from '@aq/shared';

export type ChartPriceLineKind = 'entry' | 'pending_entry' | 'stop_loss' | 'take_profit';

export interface ChartPriceLine {
  id: string;
  kind: ChartPriceLineKind;
  price: number;
  /** 显示在 K 线图水平线上的简短标签（如「开多」「挂单开多」「止损」「止盈1」）。 */
  title: string;
  side?: 'long' | 'short';
}

const TERMINAL_ORDER_STATUSES = new Set([
  'FILLED',
  'CANCELED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
  'EXPIRED_IN_FUTURES',
  'FAILED',
]);

function normalizeSymbol(symbol: string | undefined | null): string {
  return (symbol ?? '').trim().toUpperCase();
}

function isValidPrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isOrderActive(order: OrderRecord): boolean {
  const status = (order.status ?? '').trim().toUpperCase();
  return status.length > 0 && !TERMINAL_ORDER_STATUSES.has(status);
}

function isSamePrice(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) / scale < 1e-6;
}

function classifyOrderKind(order: OrderRecord): ChartPriceLineKind | null {
  if (order.purpose === 'stop_loss') return 'stop_loss';
  if (order.purpose === 'take_profit') return 'take_profit';
  if (order.purpose === 'entry') return 'pending_entry';

  const type = (order.type ?? '').trim().toUpperCase();
  if (type.includes('TAKE_PROFIT')) return 'take_profit';
  if (type.includes('STOP')) return 'stop_loss';
  return null;
}

function effectiveOrderPrice(order: OrderRecord, kind: ChartPriceLineKind): number | null {
  if (kind === 'stop_loss' || kind === 'take_profit') {
    if (isValidPrice(order.stopPrice)) return order.stopPrice;
    if (isValidPrice(order.price)) return order.price;
    return null;
  }
  if (isValidPrice(order.price)) return order.price;
  if (isValidPrice(order.stopPrice)) return order.stopPrice;
  return null;
}

/**
 * 为指定交易对构建 K 线图上的水平参考线（开仓均价 / 挂单开仓 / 止损 / 止盈）。
 *
 * 严格约束：
 * - 仅当该交易对当前存在真实持仓（`quantity > 0`）或有效未成交委托时返回价格线；
 *   其它无持仓、无委托的币种图表一律返回空数组，不画任何干扰线。
 * - 优先取交易所活跃委托里的精确触发价（支持分批多档止盈 `止盈1`/`止盈2` 与挂单开仓），
 *   再用持仓对象上的 `stopLoss`/`takeProfit` 做去重兜底（兼容模拟盘与刚开仓挂保护单瞬间）。
 */
export function buildSymbolChartPriceLines({
  symbol,
  positions,
  openOrders,
}: {
  symbol: string | undefined;
  positions: ReadonlyArray<PositionView>;
  openOrders: ReadonlyArray<OrderRecord>;
}): ChartPriceLine[] {
  const target = normalizeSymbol(symbol);
  if (!target) return [];

  const matchedPositions = positions.filter(
    (p) => normalizeSymbol(p.symbol) === target && Number.isFinite(p.quantity) && p.quantity > 0,
  );
  const matchedOrders = openOrders.filter(
    (o) => normalizeSymbol(o.symbol) === target && isOrderActive(o),
  );

  if (matchedPositions.length === 0 && matchedOrders.length === 0) {
    return [];
  }

  const lines: ChartPriceLine[] = [];

  // 1. 已成交持仓开仓均价线
  for (const pos of matchedPositions) {
    if (!isValidPrice(pos.entryPrice)) continue;
    const prefix = pos.side === 'long' ? '开多' : '开空';
    const title = matchedPositions.length > 1 ? `${prefix}均价` : `${prefix}`;
    lines.push({
      id: `entry:${pos.side}:${pos.entryPrice}`,
      kind: 'entry',
      price: pos.entryPrice,
      title,
      side: pos.side,
    });
  }

  // 2. 活跃委托拆分为：挂单开仓 / 止损 / 止盈（分别按价位去重）
  const pendingEntries: Array<{ price: number; side: 'long' | 'short' }> = [];
  const stopLosses: number[] = [];
  const takeProfits: number[] = [];

  for (const order of matchedOrders) {
    const kind = classifyOrderKind(order);
    if (!kind) continue;
    const price = effectiveOrderPrice(order, kind);
    if (!isValidPrice(price)) continue;

    if (kind === 'pending_entry') {
      const side: 'long' | 'short' = order.side === 'BUY' ? 'long' : 'short';
      if (!pendingEntries.some((x) => x.side === side && isSamePrice(x.price, price))) {
        pendingEntries.push({ price, side });
      }
    } else if (kind === 'stop_loss') {
      if (!stopLosses.some((p) => isSamePrice(p, price))) {
        stopLosses.push(price);
      }
    } else if (kind === 'take_profit') {
      if (!takeProfits.some((p) => isSamePrice(p, price))) {
        takeProfits.push(price);
      }
    }
  }

  // 3. 持仓对象上的 SL / TP 作为去重兜底（若委托列表未覆盖或处于模拟盘/刚开仓瞬间）
  for (const pos of matchedPositions) {
    if (isValidPrice(pos.stopLoss) && !stopLosses.some((p) => isSamePrice(p, pos.stopLoss!))) {
      stopLosses.push(pos.stopLoss);
    }
    if (isValidPrice(pos.takeProfit) && !takeProfits.some((p) => isSamePrice(p, pos.takeProfit!))) {
      takeProfits.push(pos.takeProfit);
    }
  }

  const refEntryPrice = matchedPositions[0]?.entryPrice ?? pendingEntries[0]?.price ?? null;
  const sortByDistance = (arr: number[]) => {
    if (refEntryPrice === null) return [...arr].sort((a, b) => a - b);
    return [...arr].sort(
      (a, b) => Math.abs(a - refEntryPrice) - Math.abs(b - refEntryPrice),
    );
  };

  pendingEntries.forEach((item, idx) => {
    const base = item.side === 'long' ? '挂单开多' : '挂单开空';
    const title = pendingEntries.length > 1 ? `${base}${idx + 1}` : base;
    lines.push({
      id: `pending:${item.side}:${item.price}`,
      kind: 'pending_entry',
      price: item.price,
      title,
      side: item.side,
    });
  });

  const sortedTps = sortByDistance(takeProfits);
  sortedTps.forEach((price, idx) => {
    lines.push({
      id: `tp:${price}`,
      kind: 'take_profit',
      price,
      title: sortedTps.length > 1 ? `止盈${idx + 1}` : '止盈',
    });
  });

  const sortedSls = sortByDistance(stopLosses);
  sortedSls.forEach((price, idx) => {
    lines.push({
      id: `sl:${price}`,
      kind: 'stop_loss',
      price,
      title: sortedSls.length > 1 ? `止损${idx + 1}` : '止损',
    });
  });

  return lines;
}
