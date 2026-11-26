/**
 * 陈旧挂单结清模块（从 `autoTrader.ts` 阶段 2 纯搬抽出，行为零变化）：
 * - 把交易所已不再挂着的本地非终态委托行推进至终态（§2.2 不删行、不伪造终态）
 * - 条件单 / 限价单 / 普通市价单的终态判定（`resolveFinalOrderStatus`）
 */
import { orderPurposeLabel, type OrderRecord } from '@aq/shared';

import type {
  BinanceAlgoOrderResponse,
  BinanceAlgoStatus,
  BinanceOrderResponse,
} from '../binance/types.js';
import { orders as orderStore, positions as positionStore } from '../store/repositories.js';

/**
 * 结清一张本地委托之前，它至少要有多"老"。
 *
 * 下界 2 分钟远大于任何一次交易所读写的耗时，避免刚挂上去的保护单因读竞态被误判，
 * 又小到让真正已撤销的行不会长期停在界面上。
 */
export const ORDER_SETTLE_GRACE_MS = 2 * 60_000;

/**
 * 走 Algo 端点的条件单类型。
 * 就是 `/fapi/v1/order` 会以 `-4120` 拒掉的那几种，它们的最终状态只能用 `/fapi/v1/algoOrder` 回读。
 */
export const CONDITIONAL_ORDER_TYPES = new Set([
  'STOP',
  'STOP_MARKET',
  'TAKE_PROFIT',
  'TAKE_PROFIT_MARKET',
  'TRAILING_STOP_MARKET',
]);

/**
 * 条件单的 `algoStatus` → `orders.status` 里的订单状态。
 * `FINISHED` 与 `TRIGGERED` 均记为 `FILLED`；`NEW` 不在表里（竞态时留给下一轮）。
 */
export const ALGO_FINAL_ORDER_STATUS: Partial<Record<BinanceAlgoStatus, string>> = {
  FINISHED: 'FILLED',
  TRIGGERED: 'FILLED',
  CANCELED: 'CANCELED',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
};

export interface SettledOrderOutcome {
  status: string;
  filledQty?: number;
  avgPrice?: number;
  rawResponse?: unknown;
}

/**
 * 把交易所已经不挂着的本地委托行结清（§2.2 只要求不删行，从不要求状态停在 `NEW`）。
 *
 * 只改账：既不补撤单、也不重挂保护单。模拟盘以本地持仓行为真相，实盘以交易所挂单列表为真相。
 */
export async function settleStaleOrdersForTrader(input: {
  traderId: number;
  traderName: string;
  isDryRun: boolean;
  onlySymbol?: string;
  /**
   * 仅当某标的持仓已被确认平仓/消失时置 true：跳过 2 分钟宽限窗口，
   * 立刻向交易所回读该标的刚挂不久的止损/止盈单终态，防止出现「持仓 0、当前委托 2」悬空。
   */
  ignoreGraceWindow?: boolean;
  getOpenOrders: (symbol: string) => Promise<Array<{ orderId: string | number }>>;
  getOpenAlgoOrders: (symbol: string) => Promise<Array<{ algoId: string | number }>>;
  finalStatusOf: (row: OrderRecord) => Promise<SettledOrderOutcome | null>;
  emit: (level: 'info' | 'warn' | 'error', message: string) => void;
  logWarn: (message: string) => void;
}): Promise<number> {
  const traderId = input.traderId;

  /*
   * 只把"够老"的行当候选：`createdBefore` 就是宽限窗口的下界，
   * 窗口取多长、为什么需要，见 `ORDER_SETTLE_GRACE_MS`。
   * 例外：调用方已确认该标的持仓刚刚平掉（`ignoreGraceWindow=true`）时立即结清。
   */
  const cutoff = input.ignoreGraceWindow
    ? new Date(Date.now() + 60_000).toISOString()
    : new Date(Date.now() - ORDER_SETTLE_GRACE_MS).toISOString();
  const candidates = orderStore
    .unsettled(traderId, cutoff)
    .filter((row) => input.onlySymbol === undefined || row.symbol === input.onlySymbol);
  if (candidates.length === 0) return 0;

  /*
   * ⚠️ **只保护"当前正在生效的那张保护单"，不再按标的整体跳过。**
   * `positions.stop_order_id` / `tp_order_id` 指向的才是"现在生效的那一张"。
   * 它缺失 → 由 `ensureStopsOnOpenPositions()` 去重挂并告警（§2.6）；
   * 其余历史保护单行照常走核对 → 结清。
   */
  const activeProtectionIds = new Set<string>();
  for (const position of positionStore.open(traderId)) {
    if (position.stop_order_id) activeProtectionIds.add(String(position.stop_order_id));
    if (position.tp_order_id) activeProtectionIds.add(String(position.tp_order_id));
  }

  /*
   * ⚠️⚠️ **模拟盘：本地账就是唯一真相**（2026-10-14 线上实测抓到的死锁）：
   * 模拟盘的单从未发到交易所，以 `activeProtectionIds` 为界直接结清为 `CANCELED`。
   */
  if (input.isDryRun) {
    let settled = 0;
    const summary: string[] = [];
    for (const row of candidates) {
      /* 当前生效的保护单不碰（与实盘那条路径同一个判据）。 */
      if (activeProtectionIds.has(String(row.exchangeOrderId ?? ''))) continue;
      orderStore.update(row.id, { status: 'CANCELED', cancelSource: 'system_reconcile' });
      settled += 1;
      summary.push(`${row.symbol} ${orderPurposeLabel(row.purpose)}`);
    }
    if (settled > 0) {
      input.emit(
        'info',
        `模拟盘结清了 ${settled} 张本地委托（${summary.slice(0, 8).join('、')}` +
          `${summary.length > 8 ? ' 等' : ''}）：模拟盘的单从未发到交易所，` +
          '仓位平掉后它们的本地行应当收尾 —— 否则界面会一直显示"已挂单"。',
      );
    }
    return settled;
  }

  const symbols = [
    ...new Set(
      candidates
        .filter((row) => !activeProtectionIds.has(String(row.exchangeOrderId ?? '')))
        .map((row) => row.symbol),
    ),
  ];
  if (symbols.length === 0) return 0;

  /*
   * 权威答案在交易所：两个端点都要读（普通单 `/fapi/v1/openOrders` + Algo `/fapi/v1/algoOpenOrders`）。
   */
  const liveBySymbol = new Map<string, Set<string>>();
  for (const symbol of symbols) {
    try {
      const [regular, algo] = await Promise.all([
        input.getOpenOrders(symbol),
        input.getOpenAlgoOrders(symbol),
      ]);
      const live = new Set<string>();
      for (const order of regular) live.add(String(order.orderId));
      for (const order of algo) live.add(String(order.algoId));
      liveBySymbol.set(symbol, live);
    } catch (error) {
      /*
       * 读不到就**什么都不做**：这一轮无法断定它已经不在交易所，下一轮会重新读。
       */
      input.logWarn(
        `[${input.traderName}] ${symbol} 的挂单列表读取失败，本轮不结清该标的的委托记录：${(error as Error).message}`,
      );
    }
  }

  let settled = 0;
  const summary: string[] = [];
  for (const row of candidates) {
    /*
     * 只跳过**当前正在生效**的那张保护单：它不在交易所挂单列表里说明保护真的丢了，
     * 那由 `ensureStopsOnOpenPositions()` 负责重挂并告警（§2.6）。
     */
    if (activeProtectionIds.has(String(row.exchangeOrderId ?? ''))) continue;

    const live = liveBySymbol.get(row.symbol);
    // 三种情况都不是"可以结清"：这个标的一轮没读到、这行没有交易所单号、
    // 或者它**正躺在挂单列表里**（那它当然还活着）。
    if (!live || !row.exchangeOrderId || live.has(row.exchangeOrderId)) continue;

    const outcome = await input.finalStatusOf(row);
    if (!outcome) continue;

    orderStore.update(
      row.id,
      outcome.status === 'CANCELED'
        ? { ...outcome, cancelSource: 'system_reconcile' }
        : outcome,
    );
    settled += 1;
    summary.push(`${row.symbol} ${orderPurposeLabel(row.purpose)}`);
  }

  if (settled > 0) {
    input.emit(
      'info',
      `对账结清了 ${settled} 张交易所已不再挂着的委托（${summary.slice(0, 8).join('、')}` +
        `${summary.length > 8 ? ' 等' : ''}）：这些行此前停在挂单状态，实际早已成交或撤销；交易所侧没有任何改动。`,
    );
  }
  return settled;
}

/**
 * 一张已经**不在交易所挂单列表里**的委托，最终是怎么结束的。
 *
 * @returns 要写进那一行的字段；`null` 表示"这一轮不下结论"。
 */
export async function resolveFinalOrderStatus(input: {
  row: OrderRecord;
  getAlgoOrder: (exchangeOrderId: string) => Promise<BinanceAlgoOrderResponse | null | 'not-found'>;
  getOrder: (symbol: string, exchangeOrderId: string) => Promise<BinanceOrderResponse | null>;
}): Promise<SettledOrderOutcome | null> {
  const { row } = input;
  const exchangeOrderId = row.exchangeOrderId;
  if (!exchangeOrderId) return null;

  if (CONDITIONAL_ORDER_TYPES.has(row.type)) {
    const algo = await input.getAlgoOrder(exchangeOrderId);
    /*
     * ⚠️ **交易所说"这张单不存在"（-2013）是一个可判定的答案**（2026-10-14 修死锁）：
     *   · 'not-found'（明确不存在）→ 写 CANCELED（不写成交数字）
     *   · null（网络 / 鉴权 / 限流） → 仍然 return null，什么都不写
     */
    if (algo === 'not-found') {
      return { status: 'CANCELED' };
    }
    if (!algo) return null;
    const status = ALGO_FINAL_ORDER_STATUS[algo.algoStatus];
    // `NEW` 会走到这里：两次读之间的竞态，留给下一轮，不拿矛盾去改账。
    if (!status) return null;

    const filledQty = Number(algo.actualQty ?? 0) || 0;
    const avgPrice = Number(algo.actualPrice ?? 0) || 0;
    return {
      status,
      // 只有交易所确实报了成交数字才写：`0` 会把已有的数字抹掉。
      ...(filledQty > 0 ? { filledQty } : {}),
      ...(avgPrice > 0 ? { avgPrice } : {}),
      // 交易所对这张单的最后一次答复（§2.2：raw_response 留的是交易所的话）。
      rawResponse: algo,
    };
  }

  /*
   * ⚠️ **限价单必须问交易所，不能靠"下单时拿到过的数字"判。**
   */
  if (row.type === 'LIMIT') {
    const limit = await input.getOrder(row.symbol, exchangeOrderId).catch(() => null);
    // 读不到 = 不知道，这一轮不下结论。
    if (!limit) return null;

    const executed = Number(limit.executedQty) || 0;
    const avgPrice = Number(limit.avgPrice) || 0;
    if (executed <= 0) {
      // 成交量为 0 且已不在挂单列表里 —— 被撤或过期，交易所自己说了是哪一个。
      return {
        status: limit.status === 'EXPIRED' ? 'EXPIRED' : 'CANCELED',
        rawResponse: limit,
      };
    }
    return {
      status: executed >= row.quantity * (1 - 1e-9) ? 'FILLED' : 'CANCELED',
      filledQty: executed,
      ...(avgPrice > 0 ? { avgPrice } : {}),
      rawResponse: limit,
    };
  }

  /*
   * 相对容差而不是"浮点相等"。
   */
  const fullyExecuted = row.quantity > 0 && row.filledQty >= row.quantity * (1 - 1e-9);
  return fullyExecuted ? { status: 'FILLED' } : { status: 'CANCELED' };
}
