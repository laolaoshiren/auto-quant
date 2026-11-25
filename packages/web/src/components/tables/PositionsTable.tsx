import type { PositionView } from '@aq/shared';
import { api } from '../../lib/api';
import { useEvents } from '../../lib/store';
import { usePolled, type QueryState } from '../../lib/hooks';
import { Badge, Button, ErrorNote, Spinner3 } from '../ui';
import { SideBadge } from '../Badges';
import {
  fmtDuration,
  fmtPercent,
  fmtPrice,
  fmtQty,
  fmtUsd,
  fmtUsdSigned,
  marginModeLabel,
  pnlColor,
} from '../../lib/format';
import { pickPositions } from '../../lib/pickPositions';
import { MAX_ROWS, useDelayedSpinner } from './useTablePaging';
import {
  CapNote,
  COLLAPSED_MAX_H,
  EXPANDED_MAX_H,
  SymbolCell,
  TableEmpty,
  useSymbolTones,
} from './shared';

function distancePercent(entry: number, level: number | null): string | null {
  if (level === null || entry === 0) return null;
  const percent = ((level - entry) / entry) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

export function PositionsTable({
  traderId,
  refreshToken = 0,
  query: externalQuery,
  onCloseRequest,
  onSelectSymbol,
  collapsed = false,
  fillHeight = false,
  openOrderCount = 0,
  onOpenOrdersTab,
}: {
  traderId: number;
  /** 手工平仓等写操作后递增，触发持仓表立即重拉，不等待轮询。 */
  refreshToken?: number;
  /** 由外层容器共享的 `/positions` 查询结果；传入后不再另起重复轮询定时器。 */
  query?: QueryState<PositionView[]>;
  onCloseRequest: (symbol: string) => void;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
  collapsed?: boolean;
  /** 为真时撑满父容器（手动拖动底部高度时使用）。 */
  fillHeight?: boolean;
  /** 当前待成交委托数量：空仓但有挂单时提供直达入口。 */
  openOrderCount?: number;
  onOpenOrdersTab?: () => void;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.positions);
  const internalQuery = usePolled((signal) => api.traderPositions(traderId, signal), {
    intervalMs: 10_000,
    enabled: !externalQuery,
    deps: [traderId, refreshToken],
  });
  const query = externalQuery ?? internalQuery;

  // 实时查询优先，WebSocket 镜像只作兜底（与容器角标同源同序）。
  const positions: PositionView[] = pickPositions(query.data, live);
  const showSpinner = useDelayedSpinner(query.loading && query.updatedAt === null && positions.length === 0);
  const symbolTones = useSymbolTones(positions.slice(0, MAX_ROWS).map((p) => p.symbol));

  if (query.updatedAt === null && positions.length === 0) {
    if (query.error !== null) {
      return (
        <ErrorNote>持仓暂时读不到（不代表没有持仓）：{query.error}</ErrorNote>
      );
    }
    if (showSpinner) return <Spinner3 label="正在加载持仓" />;
    return <div className="py-8" aria-hidden />;
  }

  if (positions.length === 0) {
    if (query.error !== null) {
      return (
        <ErrorNote>持仓暂时读不到（不代表没有持仓）：{query.error}</ErrorNote>
      );
    }
    return (
      <TableEmpty
        message="暂无持仓"
        hint={
          openOrderCount > 0
            ? `当前有 ${openOrderCount} 笔待成交委托正在挂单等待入场。`
            : '当前保持空仓，等待满足策略条件时自动开仓。'
        }
        action={
          openOrderCount > 0 && onOpenOrdersTab ? (
            <Button size="sm" variant="ghost" onClick={onOpenOrdersTab}>
              查看 {openOrderCount} 笔当前委托 →
            </Button>
          ) : undefined
        }
      />
    );
  }

  const shown = positions.slice(0, MAX_ROWS);
  const ageSeconds =
    query.updatedAt === null ? null : Math.max(0, Math.round((Date.now() - query.updatedAt) / 1000));

  return (
    <div className={fillHeight ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      {query.error !== null && (
        <ErrorNote className="mb-2 shrink-0">
          持仓暂时读不到{ageSeconds === null ? '' : `，下面是 ${ageSeconds} 秒前的读数`}：{query.error}
        </ErrorNote>
      )}
      <div
        className={`scroll-x ${fillHeight ? 'min-h-0 flex-1' : collapsed ? COLLAPSED_MAX_H : EXPANDED_MAX_H} overflow-y-auto`}
      >
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              <th className="th whitespace-nowrap px-1.5">合约 / 方向</th>
              <th className="th whitespace-nowrap px-1.5">模式</th>
              <th className="th whitespace-nowrap px-1.5 text-right">数量</th>
              <th className="th whitespace-nowrap px-1.5 text-right">名义</th>
              <th className="th whitespace-nowrap px-1.5 text-right">保证金</th>
              <th className="th whitespace-nowrap px-1.5 text-right">开仓价</th>
              <th className="th whitespace-nowrap px-1.5 text-right">标记价</th>
              <th className="th whitespace-nowrap px-1.5 text-right">止盈</th>
              <th className="th whitespace-nowrap px-1.5 text-right">止损</th>
              <th className="th whitespace-nowrap px-1.5 text-right">强平价</th>
              <th className="th whitespace-nowrap px-1.5 text-right">浮盈</th>
              <th className="th sticky right-0 z-10 whitespace-nowrap bg-base-850 px-1.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((position) => {
              const protectionPending = position.protectionPending === true;
              const missingStop =
                !protectionPending && (position.stopLoss === null || position.stopLoss === undefined);
              const stopDistance = position.stopLoss ? distancePercent(position.entryPrice, position.stopLoss) : null;
              const targetDistance = position.takeProfit ? distancePercent(position.entryPrice, position.takeProfit) : null;

              return (
                <tr key={position.id} className="row-hover align-top">
                  <td className="td px-1.5">
                    <div className="flex items-center gap-1.5">
                      <SymbolCell symbol={position.symbol} onSelect={onSelectSymbol} tone={symbolTones.get(position.symbol)} />
                      <SideBadge side={position.side} />
                      <Badge tone="muted" title="该持仓在交易所使用的杠杆倍数。">
                        {position.leverage}x
                      </Badge>
                      {protectionPending && (
                        <Badge
                          tone="muted"
                          title="刚开仓，止损/止盈单正在发往交易所（实测约 2 秒）。这不是「没有保护」，而是还没挂完。"
                        >
                          挂单中
                        </Badge>
                      )}
                      {missingStop && (
                        <Badge tone="down" title="该持仓已开仓超过 1 分钟，交易所侧仍没有止损单。">
                          无止损
                        </Badge>
                      )}
                    </div>
                    <div className="num mt-0.5 text-xs text-ink-faint">
                      持仓 {fmtDuration((Date.now() - new Date(position.openedAt).getTime()) / 60_000)}
                    </div>
                  </td>

                  <td className="td px-1.5">
                    <Badge
                      tone="muted"
                      title={
                        position.marginType
                          ? `该持仓在交易所的保证金模式：${marginModeLabel(position.marginType)}。实时读自交易所。`
                          : '暂时读不到该持仓的保证金模式（机器人未运行、或交易所未返回该字段）。'
                      }
                    >
                      {position.marginType ? marginModeLabel(position.marginType) : '—'}
                    </Badge>
                  </td>

                  <td className="td num whitespace-nowrap px-1.5 text-right">{fmtQty(position.quantity)}</td>

                  <td className="td num whitespace-nowrap px-1.5 text-right">{fmtUsd(position.notional, 2)}</td>

                  <td
                    className="td num whitespace-nowrap px-1.5 text-right"
                    title="该仓位占用的保证金（本金）= 名义价值 ÷ 杠杆。"
                  >
                    {fmtUsd(position.marginUsed, 2)}
                  </td>

                  <td className="td num whitespace-nowrap px-1.5 text-right">{fmtPrice(position.entryPrice)}</td>

                  <td className="td num whitespace-nowrap px-1.5 text-right">{fmtPrice(position.markPrice)}</td>

                  <td className="td num whitespace-nowrap px-1.5 text-right">
                    <div className="text-base text-up">
                      {position.takeProfit
                        ? fmtPrice(position.takeProfit)
                        : protectionPending
                          ? '挂单中'
                          : '无'}
                    </div>
                    {targetDistance && (
                      <div className="text-xs text-ink-faint">{targetDistance}</div>
                    )}
                  </td>

                  <td className="td num whitespace-nowrap px-1.5 text-right">
                    <div className={`text-base ${missingStop ? 'font-semibold' : ''} text-down`}>
                      {position.stopLoss
                        ? fmtPrice(position.stopLoss)
                        : protectionPending
                          ? '挂单中'
                          : '无'}
                    </div>
                    {stopDistance && <div className="text-xs text-ink-faint">{stopDistance}</div>}
                  </td>

                  <td className={`td num whitespace-nowrap px-1.5 text-right ${position.liquidationPrice ? 'text-warn' : 'text-ink-faint'}`}>
                    {position.liquidationPrice ? fmtPrice(position.liquidationPrice) : '—'}
                  </td>

                  <td className={`td num whitespace-nowrap px-1.5 text-right ${pnlColor(position.unrealizedPnl)}`}>
                    {fmtUsdSigned(position.unrealizedPnl, 2)}
                    <div className="text-xs">{fmtPercent(position.unrealizedPnlPercent)}</div>
                  </td>

                  <td className="td sticky right-0 whitespace-nowrap bg-base-900 px-1.5 text-right">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => onCloseRequest(position.symbol)}
                      title="手工平仓该持仓"
                    >
                      平仓
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <CapNote shown={shown.length} total={positions.length} />
    </div>
  );
}
