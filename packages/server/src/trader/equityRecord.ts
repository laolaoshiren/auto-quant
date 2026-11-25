/**
 * 机器人归属权益快照构建、去重与落库（从 `autoTrader.ts` 阶段 1 纯搬抽出，行为逐字节一致）。
 */
import type { EquitySnapshot } from '@aq/shared';

import type { AccountState } from '../binance/account.js';
import type { ExchangePosition } from '../binance/broker.js';
import { eventBus } from '../events.js';
import type { MarketDataService } from '../market/service.js';
import {
  attributedEquity,
  equity as equityStore,
  ownUnrealizedPnlOf,
  positions as positionStore,
  traders as traderStore,
  trades as tradeStore,
} from '../store/repositories.js';

/** 两份权益快照视为"没变化"的容差（USDT）。 */
export const SNAPSHOT_SAME_TOLERANCE = 1e-9;

/** 空仓/无变化时的权益曲线心跳间隔（30 分钟），防止曲线断档同时消灭重复平线。 */
export const SNAPSHOT_HEARTBEAT_MS = 30 * 60 * 1000;

export interface RecordEquityDeps {
  traderId: number;
  account: AccountState;
  exchangePositions: ExchangePosition[];
  marketData: MarketDataService;
  onWarn: (message: string) => void;
}

/** 组装单机器人的归属权益快照（只计自己的平仓净额与持仓浮盈，不混共享钱包）。 */
export async function buildTraderEquitySnapshot(deps: RecordEquityDeps): Promise<EquitySnapshot> {
  const { traderId, account, exchangePositions, marketData, onWarn } = deps;
  const openPositions = positionStore.open(traderId);
  const markPrices = new Map(exchangePositions.map((p) => [p.symbol, p.markPrice]));

  // 交易所未返回的标的（如模拟盘本地仓）回落到行情标记价
  const fromMarket = await marketData.markPricesOf(
    openPositions.map((p) => p.symbol).filter((symbol) => !markPrices.has(symbol)),
  );

  const { unrealizedPnl, missingMarkPrice } = ownUnrealizedPnlOf(
    openPositions,
    (symbol) => markPrices.get(symbol) ?? fromMarket.get(symbol),
  );
  if (missingMarkPrice.length > 0) {
    onWarn(
      `读不到 ${missingMarkPrice.join('、')} 的标记价，这些持仓的浮动盈亏暂按 0 计入归属权益。`,
    );
  }

  return {
    traderId,
    timestamp: new Date().toISOString(),
    equity: attributedEquity(
      traderStore.get(traderId)?.initialEquity ?? 0,
      tradeStore.stats(traderId).netPnl,
      unrealizedPnl,
    ),
    availableBalance: account.availableBalance,
    unrealizedPnl,
    marginUsed: account.marginUsed,
    openPositions: openPositions.length,
    accountEquity: account.equity,
    accountUnrealizedPnl: account.unrealizedPnl,
  };
}

/** 与上一条快照相比是否无实质新信息（相同且距上次未满 30 分钟心跳则跳过）。 */
export function isRedundantEquitySnapshot(next: EquitySnapshot): boolean {
  const [prev] = equityStore.list(next.traderId, 1);
  if (!prev) return false;

  const same =
    prev.openPositions === next.openPositions &&
    Math.abs(prev.unrealizedPnl - next.unrealizedPnl) < SNAPSHOT_SAME_TOLERANCE &&
    Math.abs(prev.equity - next.equity) < SNAPSHOT_SAME_TOLERANCE &&
    Math.abs(prev.accountEquity - next.accountEquity) < SNAPSHOT_SAME_TOLERANCE;
  if (!same) return false;

  const ageMs = Date.parse(next.timestamp) - Date.parse(prev.timestamp);
  return Number.isFinite(ageMs) && ageMs < SNAPSHOT_HEARTBEAT_MS;
}

/** 构建、去重、落库并广播机器人权益快照。 */
export async function recordTraderEquity(deps: RecordEquityDeps): Promise<void> {
  const snapshot = await buildTraderEquitySnapshot(deps);
  if (isRedundantEquitySnapshot(snapshot)) return;
  equityStore.insert(snapshot);
  eventBus.publish({ type: 'equity', traderId: deps.traderId, snapshot });
}
