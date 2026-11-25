/**
 * 持仓对账与缺失保护单巡检恢复模块（从 `autoTrader.ts` 阶段 2 纯搬抽出，行为零变化）：
 * - 持仓对账与外部手工仓位收养（`reconcilePositionsForTrader`）
 * - 缺失保护单周期巡检与自动补挂（`ensureStopsOnOpenPositionsForTrader`）
 * - 已消失持仓的平仓归因与出场价恢复（`bookVanishedPositionForTrader`、`detectCloseReasonForPosition`、`reasonFromPrice`、`lastFillForSymbol`）
 * - 兜底止损价公式单一来源（`fallbackStopPrice`）
 */
import type { CloseReason } from '@aq/shared';

import type { ExchangePosition } from '../binance/broker.js';
import type { BinanceAlgoOrderResponse, BinanceUserTrade } from '../binance/types.js';
import { positions as positionStore } from '../store/repositories.js';

type PositionRow = ReturnType<typeof positionStore.open>[number];

export interface ReplaceProtectionParams {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  stop: number | null;
  target: number | null;
  traderId: number;
  preserveStop?: { stop: number | null; stopOrderId: string | null };
  preserveTarget?: { target: number | null; tpOrderId: string | null };
}

export interface ReplaceProtectionOutcome {
  stopPlaced: boolean;
  targetPlaced: boolean;
  failures: string[];
}

/**
 * 按**兜底比例**算一个止损价：`基准价 ± 基准价 × 比例%`。
 *
 * §5.4 金额/价格算式单一来源：收养与补挂用 `entryPrice`，加仓用成交价，减仓用减仓价。
 */
export function fallbackStopPrice(
  referencePrice: number,
  isLong: boolean,
  percent: number,
): number {
  const distance = referencePrice * (percent / 100);
  return isLong ? referencePrice - distance : referencePrice + distance;
}

/**
 * 实盘持仓对账：刷新存活仓位峰值浮盈、记账已消失仓位、收养外部手工仓位、最后巡检缺失保护单。
 *
 * 注意：模拟盘早退（`settleDryRunPositions`）在调用方 `AutoTrader.reconcilePositions` 入口处执行。
 */
export async function reconcilePositionsForTrader(input: {
  traderId: number;
  exchangeAccountId: number | null | undefined;
  isDryRun: boolean;
  exchangePositions: ExchangePosition[];
  getFallbackStopLossPercent: () => number;
  getOpenAlgoOrders: (symbol: string) => Promise<BinanceAlgoOrderResponse[]>;
  replacePositionProtection: (params: ReplaceProtectionParams) => Promise<ReplaceProtectionOutcome>;
  bookVanishedPosition: (local: PositionRow) => Promise<void>;
  ensureStopsOnOpenPositions: (exchangePositions: ExchangePosition[]) => Promise<void>;
  emit: (level: 'info' | 'warn' | 'error', message: string) => void;
}): Promise<void> {
  const traderId = input.traderId;
  const exchangeBySymbol = new Map(input.exchangePositions.map((p) => [p.symbol, p]));
  const localOpen = positionStore.open(traderId);

  for (const local of localOpen) {
    const live = exchangeBySymbol.get(local.symbol);
    if (live) {
      // Still open: ratchet the peak profit used by the drawdown guard.
      positionStore.updatePeak(traderId, local.symbol, live.unrealizedPnlPercent);
      continue;
    }

    await input.bookVanishedPosition(local);
  }

  // Positions opened outside the bot (a manual trade) are adopted rather than
  // ignored: the model should manage what is actually there.
  // 多机器人共用同一交易所账户时，先排除已被同账户其它机器人持有的标的，
  // 绝不抢占他机仓位或撤改其保护单。
  const accountId = input.exchangeAccountId;
  const otherTraderOpenSymbols =
    typeof accountId === 'number' && accountId > 0
      ? positionStore.openSymbolsForOtherTradersOnAccount(accountId, traderId)
      : new Set<string>();

  for (const live of input.exchangePositions) {
    if (localOpen.some((p) => p.symbol === live.symbol)) continue;
    if (otherTraderOpenSymbols.has(live.symbol)) continue;

    let existingStop: { price: number; orderId: string } | null = null;
    let existingTarget: { price: number; orderId: string } | null = null;
    if (!input.isDryRun) {
      try {
        const openAlgos = await input.getOpenAlgoOrders(live.symbol);
        for (const o of openAlgos) {
          const kind = String((o as { orderType?: string }).orderType ?? '');
          const trigger = Number((o as { triggerPrice?: string | number }).triggerPrice ?? 0);
          const id = String((o as { algoId?: string | number }).algoId ?? '');
          if (!(trigger > 0)) continue;
          if (!existingStop && kind.includes('STOP')) existingStop = { price: trigger, orderId: id };
          if (!existingTarget && kind.includes('TAKE_PROFIT')) {
            existingTarget = { price: trigger, orderId: id };
          }
        }
      } catch {
        /* 查询失败按无已有保护单处理，走下方兜底补挂 */
      }
    }

    input.emit(
      'warn',
      `发现一个未被记录的 ${live.symbol} ${live.side === 'long' ? '多头' : '空头'} 持仓，已收养它以便模型可以管理。`,
    );
    positionStore.insert({
      traderId,
      symbol: live.symbol,
      side: live.side,
      quantity: live.quantity,
      entryPrice: live.entryPrice,
      leverage: live.leverage,
      liquidationPrice: live.liquidationPrice,
      marginUsed: live.marginUsed,
      stopLoss: existingStop?.price ?? null,
      takeProfit: existingTarget?.price ?? null,
      stopOrderId: existingStop?.orderId ?? null,
      tpOrderId: existingTarget?.orderId ?? null,
      openReasoning: '收养：该仓位是在机器人之外开立的。',
    });

    if (existingStop !== null) {
      input.emit(
        'info',
        `收养的 ${live.symbol} 在交易所侧已有止损 ${existingStop.price}` +
          `${existingTarget ? ` 与止盈 ${existingTarget.price}` : ''}，已直接同步至本地记录（保留原手工保护单，不覆盖）。`,
      );
      continue;
    }

    const fallbackPercent = input.getFallbackStopLossPercent();
    const adoptedStop = fallbackStopPrice(live.entryPrice, live.side === 'long', fallbackPercent);

    const protection = await input.replacePositionProtection({
      symbol: live.symbol,
      side: live.side,
      quantity: live.quantity,
      stop: adoptedStop,
      /* 已有手工止盈时传 target: null 并由 preserveTarget 原样保留单号与价位，不撤改交易所原单。 */
      target: null,
      traderId,
      ...(existingTarget
        ? { preserveTarget: { target: existingTarget.price, tpOrderId: existingTarget.orderId } }
        : {}),
    });

    if (protection.stopPlaced) {
      input.emit(
        'info',
        `已为收养的 ${live.symbol} 挂上兜底止损 ${adoptedStop.toFixed(6)}（按 ${fallbackPercent}%）—— 这是系统挑的价位，建议让模型按真实失效位调整一次。`,
      );
    } else {
      input.emit(
        'error',
        `收养的 ${live.symbol} 仓位**没能挂上止损**（${protection.failures.join('；') || '原因未知'}）—— ` +
          '它现在没有交易所侧保护。这是你手动开的仓，系统不会替你平掉，请手动处理。',
      );
    }
  }

  /*
   * 最后再统一检查一遍"持仓还在、但交易所侧没有止损"。
   * 放在收养之后：收养路径刚刚挂过保护单，这一遍不会重复挂。
   */
  await input.ensureStopsOnOpenPositions(input.exchangePositions);
}

/**
 * ⚠️ **持仓还在、交易所侧却没有任何止损/止盈的周期性检查与自动补挂**（§2.6）。
 *
 * 三条不肯定的地方都不动手：
 *   · 挂单列表读失败 → 跳过；
 *   · 止盈方向不对 → 只挂止损；
 *   · 止损落在标记价错误一侧 → 告警而不挂（避免立即市价触发）。
 */
export async function ensureStopsOnOpenPositionsForTrader(input: {
  traderId: number;
  traderName: string;
  isDryRun: boolean;
  exchangePositions: ExchangePosition[];
  getFallbackStopLossPercent: () => number;
  getMinRiskRewardRatio: () => number;
  getBreakevenTriggerPercent: () => number;
  getRequireTakeProfit: () => boolean;
  getOpenOrders: (symbol: string) => Promise<unknown[]>;
  getOpenAlgoOrders: (symbol: string) => Promise<unknown[]>;
  replacePositionProtection: (params: ReplaceProtectionParams) => Promise<ReplaceProtectionOutcome>;
  emit: (level: 'info' | 'warn' | 'error', message: string) => void;
  logWarn: (message: string) => void;
}): Promise<void> {
  /*
   * ⚠️ **模拟盘不走这条检查**（2026-11-09）：
   * 模拟盘的止损真相是本地 `positions.stop_loss`，触发由 `settleDryRunPositions()` 按标记价判。
   */
  if (input.isDryRun) return;

  const traderId = input.traderId;
  const liveBySymbol = new Map(input.exchangePositions.map((position) => [position.symbol, position]));
  /** 什么算"这个仓位有止损"。注意 `TRAILING_STOP_MARKET` 也是止损。 */
  const STOP_TYPES = new Set(['STOP', 'STOP_MARKET', 'TRAILING_STOP_MARKET']);
  /** 什么算"这个仓位有止盈"。止损与止盈分开判。 */
  const TARGET_TYPES = new Set(['TAKE_PROFIT', 'TAKE_PROFIT_MARKET']);

  for (const local of positionStore.open(traderId)) {
    const live = liveBySymbol.get(local.symbol);
    // 仓位已经不在交易所 —— 那是 `reconcilePositions()` 上面那一遍的事。
    if (!live) continue;

    let orderTypes: string[];
    try {
      const [regular, algo] = await Promise.all([
        input.getOpenOrders(local.symbol),
        input.getOpenAlgoOrders(local.symbol),
      ]);
      orderTypes = [...regular, ...algo].map((order) => {
        /*
         * ⚠️ **字段名有两个，必须都看**：普通委托用 `type`，Algo 条件单用 `orderType`。
         */
        const type =
          (order as { orderType?: unknown }).orderType ?? (order as { type?: unknown }).type;
        return String(type ?? '');
      });
    } catch (error) {
      input.logWarn(
        `[${input.traderName}] ${local.symbol} 的挂单列表读取失败，本轮不检查保护单：${(error as Error).message}`,
      );
      continue;
    }

    const hasStop = orderTypes.some((type) => STOP_TYPES.has(type));
    const hasTarget = orderTypes.some((type) => TARGET_TYPES.has(type));

    const isLong = local.side === 'long';
    const mark = live.markPrice > 0 ? live.markPrice : live.entryPrice;

    if (hasStop && hasTarget) continue;

    /* 本地记录的保护位优先（那是模型/系统当初认定的失效位）。 */
    const recordedOk =
      local.stop_loss !== null &&
      local.stop_loss > 0 &&
      (isLong ? local.stop_loss < mark : local.stop_loss > mark);

    const fallbackPercent = input.getFallbackStopLossPercent();
    let stopForRr: number;
    let stopToPlace: number | null = null;
    if (!hasStop) {
      if (recordedOk) {
        stopToPlace = local.stop_loss as number;
      } else {
        const candidateStop = fallbackStopPrice(live.entryPrice, isLong, fallbackPercent);
        if (!(isLong ? candidateStop < mark : candidateStop > mark)) {
          input.emit(
            'error',
            `${local.symbol} 的持仓在交易所侧没有任何止损，而按兜底比例（${fallbackPercent}%）算出的止损 ` +
              `${candidateStop.toFixed(6)} 已落在当前标记价 ${mark} 的**错误一侧** —— 挂上去会立即触发、等于未经决策的市价平仓，` +
              '因此不挂。请人工确认这个仓位。',
          );
          continue;
        }
        stopToPlace = candidateStop;
      }
      stopForRr = stopToPlace;
    } else {
      /* 交易所侧已有活的止损单：只用本地记录或兜底止损作盈亏比参考，绝不撤改活止损。 */
      stopForRr =
        local.stop_loss !== null && local.stop_loss > 0
          ? local.stop_loss
          : fallbackStopPrice(live.entryPrice, isLong, fallbackPercent);
    }

    const rr = Math.max(0.5, input.getMinRiskRewardRatio());
    /* 往返成本约 0.1%（单边 0.05% × 2），乘 3 倍安全边际 = 0.3%。 */
    const minTargetPercent = 0.3;
    /* 浮盈 ROE 百分比（含杠杆），与保本阈值 `breakevenTrigger` 同口径。 */
    const priceMovePercent = isLong
      ? ((mark - local.entry_price) / local.entry_price) * 100
      : ((local.entry_price - mark) / local.entry_price) * 100;
    const unrealizedPercent = priceMovePercent * Math.max(1, local.leverage);
    const breakevenTrigger = Math.max(1, input.getBreakevenTriggerPercent());
    /** 本地记录的目标位（方向必须还在现价之外）。 */
    const recordedTargetOk =
      local.take_profit !== null &&
      local.take_profit > 0 &&
      (isLong ? local.take_profit > mark : local.take_profit < mark);

    let target: number | null = !hasTarget && recordedTargetOk ? (local.take_profit as number) : null;

    /* 仅当策略要求必须设止盈（requireTakeProfit=true）时才自动兜底补目标；无止盈趋势单交给移动止损跟随。 */
    if (target === null && !hasTarget && input.getRequireTakeProfit()) {
      /*
       * 浮盈已超保本点就不补：那种仓位正在奔跑，补固定目标等于设天花板。
       */
      if (unrealizedPercent < breakevenTrigger) {
        const stopDistancePercent = (Math.abs(stopForRr - local.entry_price) / local.entry_price) * 100;
        const targetDistancePercent = Math.max(stopDistancePercent * rr, minTargetPercent);
        const candidate = isLong
          ? local.entry_price * (1 + targetDistancePercent / 100)
          : local.entry_price * (1 - targetDistancePercent / 100);
        if (isLong ? candidate > mark : candidate < mark) {
          target = candidate;
          input.emit(
            'info',
            `${local.symbol} 缺止盈，已按「止损 ${stopDistancePercent.toFixed(2)}% × 盈亏比 ${rr.toFixed(1)}」` +
              `补目标 ${candidate.toFixed(6)}（距离 ${targetDistancePercent.toFixed(2)}%，已确保覆盖往返成本）`,
          );
        } else {
          input.emit(
            'info',
            `${local.symbol} 缺止盈，但算出的目标落在现价错误一侧 —— 不补，交给移动止损。`,
          );
        }
      } else {
        input.emit(
          'info',
          `${local.symbol} 缺止盈，但浮盈 ${unrealizedPercent.toFixed(2)}% 已超保本点 ${breakevenTrigger}% —— ` +
            '不补固定目标（避免设天花板），交给移动止损跟随。',
        );
      }
    }

    /* 已有止损且本轮决定不补固定止盈 → 完全跳过，不碰活止损、不误报无止损。 */
    if (hasStop && target === null) continue;

    if (hasStop && target !== null) {
      const protection = await input.replacePositionProtection({
        symbol: local.symbol,
        side: isLong ? 'long' : 'short',
        quantity: local.quantity,
        stop: null,
        target,
        traderId,
        preserveStop: { stop: local.stop_loss, stopOrderId: local.stop_order_id },
      });
      if (!protection.targetPlaced) {
        input.emit(
          'warn',
          `${local.symbol} 补挂止盈失败（${protection.failures.join('；') || '原因未知'}）—— 现有止损单未受影响。`,
        );
      }
      continue;
    }

    const protection = await input.replacePositionProtection({
      symbol: local.symbol,
      side: isLong ? 'long' : 'short',
      quantity: local.quantity,
      stop: stopToPlace,
      target: hasTarget ? null : target,
      traderId,
      ...(hasTarget
        ? { preserveTarget: { target: local.take_profit, tpOrderId: local.tp_order_id } }
        : {}),
    });

    if (protection.stopPlaced) {
      input.emit(
        'warn',
        `⚠️ ${local.symbol} 的持仓在交易所侧**没有止损**，已自动重挂 ${stopToPlace}` +
          `（${recordedOk ? '用本地记录的保护位' : '用兜底比例'}${protection.targetPlaced ? '，止盈一并恢复' : ''}）` +
          '—— 它此前为什么消失值得查（撤单失败/被替换/交易所侧过期）。',
      );
    } else {
      input.emit(
        'error',
        `${local.symbol} 的持仓没有任何交易所侧止损，且**重挂失败**` +
          `（${protection.failures.join('；') || '原因未知'}）—— 该仓位目前无保护，下一轮会再试。`,
      );
    }
  }
}

/**
 * Book a local position the exchange no longer holds, and close the row.
 */
export async function bookVanishedPositionForTrader(input: {
  local: PositionRow;
  lastFillFor: (symbol: string) => Promise<{ price: number; fee: number }>;
  getMarkPrice: (symbol: string) => Promise<number>;
  detectCloseReason: (
    symbol: string,
    stopOrderId: string | null,
    tpOrderId: string | null,
    exitPrice: number,
    entryPrice: number,
    stopLoss: number | null,
    takeProfit: number | null,
  ) => Promise<CloseReason>;
  bookClosedPosition: (
    local: PositionRow,
    reason: CloseReason,
    exitPrice: number,
    fee: number,
  ) => Promise<unknown>;
}): Promise<void> {
  const { local } = input;
  const fill = await input.lastFillFor(local.symbol);
  const exitPrice =
    fill.price > 0 ? fill.price : await input.getMarkPrice(local.symbol).catch(() => 0);

  const reason = await input.detectCloseReason(
    local.symbol,
    local.stop_order_id,
    local.tp_order_id,
    exitPrice,
    local.entry_price,
    local.stop_loss,
    local.take_profit,
  );
  await input.bookClosedPosition(local, reason, exitPrice, fill.fee);
}

/**
 * Determine why a position vanished.
 *
 * The authoritative signal is each algo order's own final status — the one
 * that fired is `FINISHED`/`TRIGGERED`, the other is `CANCELED`. `'not-found'`
 * maps to `undefined` so we never fabricate a trigger and instead fall back to
 * exit-price comparison.
 */
export async function detectCloseReasonForPosition(input: {
  symbol: string;
  stopOrderId: string | null;
  tpOrderId: string | null;
  exitPrice: number;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  getAlgoOrder: (algoId: string) => Promise<BinanceAlgoOrderResponse | null | 'not-found'>;
  getUserTrades: (symbol: string, limit: number) => Promise<BinanceUserTrade[]>;
}): Promise<CloseReason> {
  const { symbol, stopOrderId, tpOrderId, exitPrice, stopLoss, takeProfit } = input;
  try {
    const [stopOrder, tpOrder] = await Promise.all([
      stopOrderId ? input.getAlgoOrder(stopOrderId) : Promise.resolve(null),
      tpOrderId ? input.getAlgoOrder(tpOrderId) : Promise.resolve(null),
    ]);

    const fired = (status: string | undefined): boolean =>
      status === 'FINISHED' || status === 'TRIGGERED';
    const dead = (status: string | undefined): boolean =>
      status === 'CANCELED' || status === 'EXPIRED' || status === 'REJECTED';

    /*
     * ⚠️ **先把状态抽出来再判**（`getAlgoOrder` 可能返回 `'not-found'`）：
     * `'not-found'` 映射成 `undefined`（落空），不拿分不清的答案猜止损或止盈。
     */
    const statusOf = (o: typeof stopOrder): string | undefined =>
      o === null || o === 'not-found' ? undefined : o.algoStatus;

    if (fired(statusOf(stopOrder))) return 'stop_loss';
    if (fired(statusOf(tpOrder))) return 'take_profit';

    // Both cancelled: the position was closed some other way, so the levels
    // themselves are the tiebreaker.
    if (dead(statusOf(stopOrder)) && dead(statusOf(tpOrder))) {
      const byPrice = reasonFromPrice(exitPrice, stopLoss, takeProfit);
      if (byPrice) return byPrice;
    }

    // Liquidation and ADL fills carry a recognisable client order id.
    const fills = await input.getUserTrades(symbol, 20);
    const latest = fills[fills.length - 1];
    if (latest) {
      const clientId = String((latest as { clientOrderId?: string }).clientOrderId ?? '');
      if (/autoclose|adl/i.test(clientId)) return 'liquidated';
    }

    const byPrice = reasonFromPrice(exitPrice, stopLoss, takeProfit);
    if (byPrice) return byPrice;

    return 'external';
  } catch {
    return 'external';
  }
}

/**
 * Infer the trigger from where the position actually exited.
 */
export function reasonFromPrice(
  exitPrice: number,
  stopLoss: number | null,
  takeProfit: number | null,
): CloseReason | null {
  if (!(exitPrice > 0)) return null;
  const toStop = stopLoss !== null ? Math.abs(exitPrice - stopLoss) : Number.POSITIVE_INFINITY;
  const toTarget =
    takeProfit !== null ? Math.abs(exitPrice - takeProfit) : Number.POSITIVE_INFINITY;
  if (toStop === Number.POSITIVE_INFINITY && toTarget === Number.POSITIVE_INFINITY) return null;
  return toStop <= toTarget ? 'stop_loss' : 'take_profit';
}

/**
 * The most recent fill for a symbol, used to recover the true exit price and
 * commission.
 */
export async function lastFillForSymbol(input: {
  symbol: string;
  getUserTrades: (symbol: string, limit: number) => Promise<BinanceUserTrade[]>;
  settlementFeeOf: (fills: readonly BinanceUserTrade[], symbol: string) => number;
}): Promise<{ price: number; fee: number }> {
  try {
    const fills = await input.getUserTrades(input.symbol, 20);
    const latest = fills[fills.length - 1];
    if (latest) {
      return {
        price: Number(latest.price) || 0,
        /* 单笔成交同样要按结算资产口径：BNB 抵扣的 `commission` 不是 USDT。 */
        fee: input.settlementFeeOf([latest], input.symbol),
      };
    }
  } catch {
    /* caller falls back to the mark price */
  }
  return { price: 0, fee: 0 };
}
