import type { MarginMode, TradeRecord } from '@aq/shared';
import { api } from '../../lib/api';
import { useEvents } from '../../lib/store';
import { usePolled } from '../../lib/hooks';
import { ErrorNote, Spinner3 } from '../ui';
import { SideBadge } from '../Badges';
import { closeReasonLabel } from '../../lib/summaries';
import {
  NET_PNL_FORMULA,
  PnlBreakdown,
  pnlFormulaText,
  tradeCosts,
  type PnlCosts,
} from '../PnlBreakdown';
import {
  BALANCE_LABEL,
  fmtDateTime,
  fmtDuration,
  fmtPercent,
  fmtPrice,
  fmtQty,
  fmtSigned,
  fmtUsd,
  fmtUsdSigned,
  pnlColor,
} from '../../lib/format';
import { PAGE_LIMIT, useDelayedSpinner, useTablePaging, type TablePaging } from './useTablePaging';
import {
  COLLAPSED_MAX_H,
  EXPANDED_MAX_H,
  MARGIN_USED_TITLE,
  MarginModeCell,
  PageTail,
  SymbolCell,
  TableEmpty,
  TRADE_MARGIN_MODE_TITLE,
  useSymbolTones,
} from './shared';

/**
 * 成交行的保证金占用：服务端字段优先，行数据兜底（`|数量 × 开仓价| ÷ 杠杆`）。
 * 算不出来时返回 `null` → 表格显示 `—`，不伪造数字。
 */
function tradeMarginUsed(trade: TradeRecord): number | null {
  if (typeof trade.marginUsed === 'number' && Number.isFinite(trade.marginUsed)) return trade.marginUsed;
  const { quantity, entryPrice, leverage } = trade;
  if (!Number.isFinite(leverage) || leverage <= 0) return null;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(quantity)) return null;
  if (entryPrice === 0 || quantity === 0) return null;
  return Math.abs(entryPrice * quantity) / Math.max(leverage, 1);
}

/** 对账补录来源只在悬停时给出说明，不在表格中渲染告警徽章或底色。 */
const RECONCILED_TITLE =
  '这笔在机器人未运行期间平仓（例如交易所侧的止盈被触发），成交与盈亏取自交易所的成交历史，是真实记录。';

export function TradesTable({
  traderId,
  refreshToken,
  onSelectSymbol,
  collapsed = false,
  fillHeight = false,
  paging: providedPaging,
  liveMarginModes,
}: {
  traderId: number;
  refreshToken?: number;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
  /** 收起态：只把滚动框的 `max-height` 改小 —— 理由见 `COLLAPSED_MAX_H`。 */
  collapsed?: boolean;
  /** 为真时撑满父容器（手动拖动底部高度时使用）。 */
  fillHeight?: boolean;
  /** 由容器预取好的分页实例。不传时组件内部自己建一套（向后兼容）。 */
  paging?: TablePaging<TradeRecord>;
  /** 「保证金模式」的兜底来源：当前持仓的 `symbol → marginType`。 */
  liveMarginModes?: ReadonlyMap<string, MarginMode> | null;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.trades);
  const query = usePolled((signal) => api.traderTrades(traderId, { limit: PAGE_LIMIT, signal }), {
    intervalMs: 15_000,
    enabled: !providedPaging,
    deps: [traderId, refreshToken],
  });

  const internalPaging = useTablePaging<TradeRecord>(
    traderId,
    api.traderTrades,
    query,
    live,
    (row) => row.closedAt,
  );

  const paging = providedPaging ?? internalPaging;
  const trades: TradeRecord[] = paging.rows;
  const symbolTones = useSymbolTones(trades.map((t) => t.symbol));
  const showSpinner = useDelayedSpinner(paging.loading && !paging.hasLoadedOnce && trades.length === 0);

  if (paging.error !== null && trades.length === 0) {
    return (
      <div className="p-3">
        <ErrorNote>历史成交读取失败（这不等于没有成交）：{paging.error}</ErrorNote>
      </div>
    );
  }

  if (!paging.hasLoadedOnce && trades.length === 0) {
    if (showSpinner) return <Spinner3 label="正在加载成交记录" />;
    return <div className="py-8" aria-hidden />;
  }

  if (trades.length === 0) {
    return <TableEmpty message="暂无历史成交。" hint="每笔平仓都会连同平仓原因一起持久化。" />;
  }

  const wins = trades.filter((trade) => trade.netPnl > 0).length;
  const totals: PnlCosts = trades.reduce<PnlCosts>(
    (sum, trade) => ({
      gross: sum.gross + trade.pnl,
      fees: sum.fees + trade.fee,
      funding: sum.funding - trade.fundingFee,
      net: sum.net + trade.netPnl,
    }),
    { gross: 0, fees: 0, funding: 0, net: 0 },
  );

  return (
    <div className={fillHeight ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      {paging.error !== null && (
        <ErrorNote className="mb-2 shrink-0">
          读取失败，下面是上一次成功读到的记录：{paging.error}
        </ErrorNote>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-base-800 px-3 py-2 text-xs">
        <span className="text-ink-lo">
          {paging.hasMore ? `已加载 ${trades.length} 笔` : `${trades.length} 笔成交`} ·{' '}
          <span className="text-up">{wins} 盈</span> /{' '}
          <span className="text-down">{trades.length - wins} 亏</span>
        </span>
        <PnlBreakdown costs={totals} />
        <span className={`num ml-auto text-base font-semibold ${pnlColor(totals.net)}`} title={NET_PNL_FORMULA}>
          净额 {fmtUsdSigned(totals.net, 2)}
        </span>
      </div>
      <div
        ref={paging.scrollerRef}
        className={`scroll-x ${fillHeight ? 'min-h-0 flex-1' : collapsed ? COLLAPSED_MAX_H : EXPANDED_MAX_H} overflow-y-auto`}
      >
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              <th className="th" title="这笔仓位从开仓到平仓持续了多久。">
                持仓时长
              </th>
              <th className="th" title="这笔仓位被平掉的时间。">
                平仓时间
              </th>
              <th className="th">交易对</th>
              <th className="th">方向 / 杠杆</th>
              <th className="th text-right">数量</th>
              <th className="th text-right" title={MARGIN_USED_TITLE}>
                {BALANCE_LABEL.marginUsed}
              </th>
              <th className="th" title={TRADE_MARGIN_MODE_TITLE.known}>
                保证金模式
              </th>
              <th className="th text-right">开仓价</th>
              <th className="th text-right">平仓价</th>
              <th className="th text-right">盈亏（毛）</th>
              <th className="th text-right">手续费</th>
              <th className="th text-right">净盈亏 / %</th>
              <th className="th">平仓原因</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => {
              const costs = tradeCosts(trade);
              const reconciled = trade.source === 'reconciled' || trade.closeReason === 'reconciled';
              const marginUsed = tradeMarginUsed(trade);
              return (
                <tr
                  key={trade.id}
                  className="row-hover"
                  data-row-id={trade.id}
                >
                  <td className="td whitespace-nowrap num text-ink-mid">
                    {fmtDuration(trade.holdMinutes)}
                  </td>
                  <td className="td whitespace-nowrap text-ink-faint">
                    {fmtDateTime(trade.closedAt)}
                  </td>
                  <td className="td font-semibold text-ink-hi">
                    <div className="flex items-center gap-1.5">
                      <SymbolCell symbol={trade.symbol} onSelect={onSelectSymbol} tone={symbolTones.get(trade.symbol)} />
                    </div>
                  </td>
                  <td className="td whitespace-nowrap">
                    <SideBadge side={trade.side} />
                    <span className="num ml-1 text-ink-faint">{trade.leverage}x</span>
                  </td>
                  <td className="td num text-right">{fmtQty(trade.quantity)}</td>
                  <td className="td num text-right">{fmtUsd(marginUsed, 2)}</td>
                  <td className="td">
                    <MarginModeCell mode={trade.marginType} symbol={trade.symbol} liveBySymbol={liveMarginModes} />
                  </td>
                  <td className="td num text-right">{fmtPrice(trade.entryPrice)}</td>
                  <td className="td num text-right">{fmtPrice(trade.exitPrice)}</td>
                  <td className="td num text-right text-ink-lo" title={pnlFormulaText(costs)}>
                    {fmtUsdSigned(trade.pnl, 2)}
                  </td>
                  <td className="td num text-right text-warn" title={pnlFormulaText(costs)}>
                    {fmtSigned(-trade.fee, 4)}
                    <div className="text-xs text-ink-faint">
                      开 {fmtSigned(-trade.entryFee, 4)} · 平 {fmtSigned(-trade.exitFee, 4)}
                    </div>
                    {trade.fundingFee !== 0 && (
                      <div className={`text-xs ${pnlColor(trade.fundingFee)}`} title="资金费：负数表示支付">
                        资 {fmtSigned(trade.fundingFee, 4)}
                      </div>
                    )}
                  </td>
                  <td
                    className={`td num text-right whitespace-nowrap font-semibold ${pnlColor(trade.netPnl)}`}
                    title={pnlFormulaText(costs)}
                  >
                    {fmtUsdSigned(trade.netPnl, 2)}
                    <span className="font-normal opacity-70"> · {fmtPercent(trade.pnlPercent)}</span>
                  </td>
                  <td className="td" title={reconciled ? RECONCILED_TITLE : undefined}>
                    <span className="text-ink-lo">
                      {closeReasonLabel(trade.closeReason, trade.netPnl)}
                    </span>
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
          noun="成交"
        />
      </div>
    </div>
  );
}
