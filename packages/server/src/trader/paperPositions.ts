/**
 * 模拟盘（dry-run / paper）持仓折算与止损止盈触发结算（从 `autoTrader.ts` 阶段 1 纯搬抽出，行为一致）。
 */
import { normalizeSymbol, type CloseReason, type PositionSide } from '@aq/shared';

import type { ExchangePosition } from '../binance/broker.js';
import { positions as positionStore } from '../store/repositories.js';
import type { BrokerPort } from './brokerPort.js';

type PositionRow = ReturnType<typeof positionStore.open>[number];

/** 模拟盘某个持仓在给定标记价下的保证金口径浮盈百分比。 */
export function dryRunUnrealizedPercent(local: PositionRow, mark: number): number {
  const isLong = local.side === 'long';
  const pnl = (isLong ? mark - local.entry_price : local.entry_price - mark) * local.quantity;
  const margin =
    local.margin_used > 0
      ? local.margin_used
      : (local.entry_price * local.quantity) / Math.max(1, local.leverage);
  return margin > 0 ? (pnl / margin) * 100 : 0;
}

/** 模拟盘本地持仓折算为与 `broker.getPositions()` 同形状的持仓列表。 */
export async function buildDryRunExchangePositions(input: {
  traderId: number;
  broker: BrokerPort;
  symbol?: string;
}): Promise<ExchangePosition[]> {
  const open = positionStore
    .open(input.traderId)
    .filter((p) => input.symbol === undefined || p.symbol === normalizeSymbol(input.symbol));
  if (open.length === 0) return [];

  const out: ExchangePosition[] = [];
  for (const local of open) {
    let mark = 0;
    try {
      mark = await input.broker.getMarkPrice(local.symbol);
    } catch {
      /* 读不到标记价时用入场价兜底（浮盈按 0），保留持仓可见性 */
    }
    const price = mark > 0 ? mark : local.entry_price;
    const isLong = local.side === 'long';
    const pnl = (isLong ? price - local.entry_price : local.entry_price - price) * local.quantity;
    const margin =
      local.margin_used > 0
        ? local.margin_used
        : (local.entry_price * local.quantity) / Math.max(1, local.leverage);

    out.push({
      symbol: local.symbol,
      side: local.side as PositionSide,
      quantity: local.quantity,
      entryPrice: local.entry_price,
      markPrice: price,
      leverage: local.leverage,
      liquidationPrice: local.liquidation_price ?? null,
      unrealizedPnl: pnl,
      unrealizedPnlPercent: margin > 0 ? (pnl / margin) * 100 : 0,
      marginUsed: margin,
      notional: price * local.quantity,
      marginType: 'cross',
    });
  }
  return out;
}

/**
 * 模拟盘持仓保护单结算：对照标记价检查止损/止盈触发（同时穿过时保守止损优先），
 * 返回本轮仍存活持仓的标记价列表供模拟盘钱包折算浮盈。
 */
export async function settleDryRunPositionsForTrader(input: {
  traderId: number;
  broker: BrokerPort;
  dryRunRoundTripFee: (exitPrice: number, quantity: number) => { entryFee: number; exitFee: number };
  bookClosedPosition: (
    local: PositionRow,
    reason: CloseReason,
    exitPrice: number,
    exitFee: number,
    entryFeeFallback: number,
  ) => Promise<unknown>;
  onInfo: (message: string) => void;
  onWarn: (message: string) => void;
}): Promise<Array<{ symbol: string; markPrice: number }>> {
  const open = positionStore.open(input.traderId);
  if (open.length === 0) return [];

  const marks: Array<{ symbol: string; markPrice: number }> = [];

  for (const local of open) {
    let mark = 0;
    try {
      mark = await input.broker.getMarkPrice(local.symbol);
    } catch (error) {
      input.onWarn(
        `模拟盘读不到 ${local.symbol} 的标记价（${(error as Error).message}），本轮不结算它。`,
      );
      continue;
    }
    if (!(mark > 0)) continue;

    const isLong = local.side === 'long';
    const stop = local.stop_loss;
    const target = local.take_profit;

    const hitStop = stop !== null && stop > 0 && (isLong ? mark <= stop : mark >= stop);
    const hitTarget =
      target !== null && target > 0 && (isLong ? mark >= target : mark <= target);

    if (!hitStop && !hitTarget) {
      marks.push({ symbol: local.symbol, markPrice: mark });
      positionStore.updatePeak(input.traderId, local.symbol, dryRunUnrealizedPercent(local, mark));
      continue;
    }

    const reason: CloseReason = hitStop ? 'stop_loss' : 'take_profit';
    const exitPrice = hitStop ? (stop as number) : (target as number);

    input.onInfo(
      `[模拟盘] ${local.symbol} ${isLong ? '多头' : '空头'} 的` +
        `${hitStop ? '止损' : '止盈'} ${exitPrice} 已被标记价 ${mark} 触发，按触发价结算。`,
    );

    const { entryFee, exitFee } = input.dryRunRoundTripFee(exitPrice, local.quantity);
    await input.bookClosedPosition(local, reason, exitPrice, exitFee, entryFee);
  }

  return marks;
}
