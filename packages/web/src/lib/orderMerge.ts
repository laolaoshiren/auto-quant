/**
 * 订单状态判定与单调合并（WS 实时事件 + REST 轮询统一口径）。
 *
 * ## 为什么抽成纯函数模块（审计 P1 #21）
 *
 * 订单在前端有两处同时维护：`useEvents`（WS 推送镜像）与 `TraderTables`
 * （REST 游标分页 + WS 合并）。过去两处各有一个缺陷：
 *
 * 1. `store.ts` 收到 `order` 事件时直接 `[event.order, ...current.orders]` 头部追加，
 *    不做按 `id` / `exchangeOrderId` 去重 —— 同一张单从 `NEW` → `FILLED` 会留两条，
 *    旧的 `NEW` 副本既会被 `openOrders` 误算为挂单，又会在 `for (const row of live)`
 *    顺序写 `Map` 时反过来覆盖最新的 `FILLED`；
 * 2. `TraderTables.tsx` 在合并时把 REST `polled.data` 写在最后无条件覆盖 `live` ——
 *    一次在成交前发出、成交后才返回的陈旧 REST 轮询，会把已终态（`FILLED` / `CANCELED` /
 *    `EXPIRED` / `REJECTED`）的订单倒退回 `NEW`，让已成交单重新冒进「当前委托」。
 *
 * 这里收口为唯一实现：
 * - 按 `id` 与非空 `exchangeOrderId`（同 `traderId`）去重；
 * - 终态永不倒退为非终态；非终态中 `PARTIALLY_FILLED` 永不倒退为 `NEW`；
 * - 同等级按 `updatedAt`（较新胜出）决胜，确保乱序到达的 WS/REST 帧满足单调收敛。
 */
import type { OrderRecord } from '@aq/shared';

/**
 * 订单终态集合 —— 与服务端 `store/repositories.ts` 的 `TERMINAL_ORDER_STATUSES`
 * 保持同一份口径。
 */
export const TERMINAL_ORDER_STATUSES = new Set([
  'FILLED',
  'FINISHED',
  'CANCELED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
  'EXPIRED_IN_FUTURES',
]);

export function isTerminalOrderStatus(status: string): boolean {
  return TERMINAL_ORDER_STATUSES.has(status.toUpperCase());
}

export function isOpenOrder(order: Pick<OrderRecord, 'status'>): boolean {
  return !isTerminalOrderStatus(order.status);
}

function orderStatusRank(status: string): number {
  const upper = status.toUpperCase();
  if (TERMINAL_ORDER_STATUSES.has(upper)) return 2;
  if (upper === 'PARTIALLY_FILLED') return 1;
  return 0;
}

function orderTimestampMs(iso: string | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

/** 两条订单记录是否指向同一张订单（优先按正整数 `id`，其次按同机器人非空 `exchangeOrderId`）。 */
export function isSameOrder(a: OrderRecord, b: OrderRecord): boolean {
  if (a.id > 0 && b.id > 0 && a.id === b.id) return true;
  if (
    a.traderId === b.traderId &&
    a.exchangeOrderId !== null &&
    a.exchangeOrderId !== '' &&
    a.exchangeOrderId === b.exchangeOrderId
  ) {
    return true;
  }
  return false;
}

/**
 * 在代表同一张订单的两份快照里挑出更新、更权威的一份。
 *
 * 铁律：
 * 1. 终态（`FILLED` / `CANCELED` / `EXPIRED` / `REJECTED` 等）永不倒退为非终态；
 * 2. `PARTIALLY_FILLED` 永不倒退为 `NEW`，且已成交量不倒退；
 * 3. 同状态等级时，时间更旧的陈旧快照不能覆盖较新快照。
 */
export function pickNewerOrder(existing: OrderRecord, incoming: OrderRecord): OrderRecord {
  const existingRank = orderStatusRank(existing.status);
  const incomingRank = orderStatusRank(incoming.status);

  if (incomingRank < existingRank) return existing;
  if (incomingRank > existingRank) return incoming;

  /* 同属非终态且同一等级（例如都是 PARTIALLY_FILLED）：已成交量不能倒退。 */
  if (existingRank < 2) {
    const existingFilled = Number.isFinite(existing.filledQty) ? existing.filledQty : 0;
    const incomingFilled = Number.isFinite(incoming.filledQty) ? incoming.filledQty : 0;
    if (incomingFilled < existingFilled) return existing;
    if (incomingFilled > existingFilled) return incoming;
  }

  const existingTs = orderTimestampMs(existing.updatedAt);
  const incomingTs = orderTimestampMs(incoming.updatedAt);
  if (Number.isFinite(existingTs) && Number.isFinite(incomingTs)) {
    if (incomingTs < existingTs) return existing;
    if (incomingTs > existingTs) return incoming;
  }

  /* 时间相同（或均不可解析）时：保留有效正整数 id，优先采纳较新入参以吸收对账补全字段。 */
  if (existing.id > 0 && incoming.id <= 0) return existing;
  return incoming;
}

/**
 * 将 WS 推送的单条订单合入 `TraderLive.orders`（按 `id` / `exchangeOrderId` 去重、
 * 状态单调不倒退、最新在前、长度封顶）。
 */
export function upsertLiveOrder(
  current: readonly OrderRecord[],
  incoming: OrderRecord,
  maxItems: number,
): OrderRecord[] {
  let merged = incoming;
  const rest: OrderRecord[] = [];
  for (const row of current) {
    if (isSameOrder(row, incoming)) {
      merged = pickNewerOrder(row, merged);
    } else {
      rest.push(row);
    }
  }
  return [merged, ...rest].slice(0, maxItems);
}

/**
 * 合并历史已加载页（`loaded`）、WS 实时镜像（`live`）与 REST 轮询第一页（`polledPage`）。
 *
 * - 同时按 `id` 与非空 `exchangeOrderId` 去重；
 * - 冲突时走 `pickNewerOrder`，保证陈旧的 REST 轮询绝不会把已终态订单倒退回 `NEW`；
 * - 输出按 `id` 倒序排列（最新订单在前）。
 */
export function mergeOrderRows(
  loaded: readonly OrderRecord[],
  live: readonly OrderRecord[] | undefined,
  polledPage: readonly OrderRecord[] | undefined,
  traderId: number,
): OrderRecord[] {
  const byId = new Map<number, OrderRecord>();
  const byExchangeId = new Map<string, number>();

  const absorb = (row: OrderRecord): void => {
    if (row.traderId !== traderId) return;

    let existingKey: number | undefined;
    if (row.id > 0 && byId.has(row.id)) {
      existingKey = row.id;
    } else if (row.exchangeOrderId) {
      const mapped = byExchangeId.get(row.exchangeOrderId);
      if (mapped !== undefined && byId.has(mapped)) {
        existingKey = mapped;
      }
    }

    if (existingKey !== undefined) {
      const existing = byId.get(existingKey)!;
      const winner = pickNewerOrder(existing, row);
      if (winner.id !== existingKey) {
        byId.delete(existingKey);
      }
      byId.set(winner.id, winner);
      if (existing.exchangeOrderId) byExchangeId.set(existing.exchangeOrderId, winner.id);
      if (row.exchangeOrderId) byExchangeId.set(row.exchangeOrderId, winner.id);
      if (winner.exchangeOrderId) byExchangeId.set(winner.exchangeOrderId, winner.id);
      return;
    }

    byId.set(row.id, row);
    if (row.exchangeOrderId) {
      byExchangeId.set(row.exchangeOrderId, row.id);
    }
  };

  for (const row of loaded) absorb(row);
  for (const row of live ?? []) absorb(row);
  for (const row of polledPage ?? []) absorb(row);

  return [...byId.values()].sort((a, b) => b.id - a.id);
}
