/**
 * Trader dashboard tables: 当前持仓 / 当前委托 / 历史成交 / 订单记录.
 *
 * The close controls are deliberately *not* wired to an API call — the backend
 * has no manual-close endpoint. Pressing one opens an explanation of how the
 * bot actually closes positions rather than pretending a request was sent.
 */
import { useState } from 'react';
import type { OrderRecord, PositionView, TradeRecord } from '@aq/shared';
import { api } from '../lib/api';
import { useEvents } from '../lib/store';
import { usePolled } from '../lib/hooks';
import { Badge, Button, Empty, Modal, Panel, Spinner3 } from './ui';
import { SideBadge } from './Badges';
import { purposeLabel } from './DecisionAudit';
import { closeReasonLabel } from '../lib/summaries';
import {
  NET_PNL_FORMULA,
  PnlBreakdown,
  pnlFormulaText,
  tradeCosts,
  type PnlCosts,
} from './PnlBreakdown';
import { fmtDateTime, fmtDuration, fmtPercent, fmtPrice, fmtQty, fmtSigned, fmtUsd, fmtUsdSigned, pnlColor } from '../lib/format';

/* -------------------------------------------------------------------------- */
/*  Manual-close notice                                                        */
/* -------------------------------------------------------------------------- */

const CLOSE_EXPLANATION = [
  '本控制台没有手工平仓的功能：后端不提供手动平仓接口。',
  '持仓由机器人自己了结，只有三条路径：模型在下一个决策周期给出平仓决定；交易所侧的止损 / 止盈单被触发；回撤守卫在浮盈大幅回吐时以市价平仓。',
  '如果你想立刻结束某个持仓，请先在交易所手动平掉它，然后停止该机器人 — 机器人检测到持仓消失后会记录为“外部平仓”。',
];

function CloseNoticeModal({
  symbol,
  onClose,
}: {
  symbol: string | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={symbol !== null}
      onClose={onClose}
      title={symbol === '__all__' ? '全部平仓不可用' : `平仓 ${symbol ?? ''} 不可用`}
      width="max-w-lg"
      footer={<Button onClick={onClose}>知道了</Button>}
    >
      <div className="space-y-2">
        <div className="rounded border border-warn/50 bg-warn/10 px-2.5 py-2 text-xs font-semibold text-warn">
          该按钮不会下任何订单。
        </div>
        {CLOSE_EXPLANATION.map((line) => (
          <p key={line} className="text-xs leading-relaxed text-ink-mid">
            {line}
          </p>
        ))}
        <p className="text-2xs leading-relaxed text-ink-faint">
          这里保留按钮是为了让“我想立刻平掉”这个需求有一个明确的答案，而不是一条静默失败的请求。
        </p>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Positions                                                                  */
/* -------------------------------------------------------------------------- */

function distancePercent(entry: number, level: number | null): string | null {
  if (level === null || entry === 0) return null;
  const percent = ((level - entry) / entry) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

export function PositionsTable({
  traderId,
  onCloseRequest,
}: {
  traderId: number;
  onCloseRequest: (symbol: string) => void;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.positions);
  const query = usePolled((signal) => api.traderPositions(traderId, signal), {
    intervalMs: 5000,
    deps: [traderId],
  });

  const positions: PositionView[] = live ?? query.data ?? [];

  if (query.loading && positions.length === 0) return <Spinner3 label="正在加载持仓" />;
  if (positions.length === 0) {
    return <Empty message="暂无持仓。" hint="模型选择空仓 — 没有符合条件的标时不会下任何订单。" />;
  }

  return (
    <div className="scroll-x">
      <table className="w-full border-collapse">
        <thead className="border-b border-base-800 bg-base-850/60">
          <tr>
            <th className="th">合约 / 方向</th>
            <th className="th text-right">数量 / 价值</th>
            <th className="th text-right">开仓价格 / 标记价格</th>
            <th className="th">止盈 / 止损</th>
            <th className="th text-right">强平价</th>
            <th className="th text-right">未实现盈亏</th>
            <th className="th text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => {
            const missingStop = position.stopLoss === null || position.stopLoss === undefined;
            const stopDistance = position.stopLoss ? distancePercent(position.entryPrice, position.stopLoss) : null;
            const targetDistance = position.takeProfit ? distancePercent(position.entryPrice, position.takeProfit) : null;

            return (
              <tr key={position.id} className="row-hover align-top">
                <td className="td">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-ink-hi">{position.symbol}</span>
                    <SideBadge side={position.side} />
                    <Badge tone="muted">{position.leverage}x</Badge>
                    {missingStop && (
                      <Badge tone="down" title="该持仓没有交易所侧止损。">
                        ⚠ 无止损
                      </Badge>
                    )}
                  </div>
                  <div className="num mt-0.5 text-2xs text-ink-faint">
                    持仓 {fmtDuration((Date.now() - new Date(position.openedAt).getTime()) / 60_000)}
                  </div>
                </td>

                <td className="td num text-right">
                  {fmtQty(position.quantity)}
                  <div className="text-2xs text-ink-faint">{fmtUsd(position.notional, 2)}</div>
                </td>

                <td className="td num text-right">
                  {fmtPrice(position.entryPrice)}
                  <div className="text-2xs text-ink-faint">{fmtPrice(position.markPrice)}</div>
                </td>

                <td className="td">
                  <div className="num text-xs text-up">
                    {position.takeProfit ? fmtPrice(position.takeProfit) : '无'}
                    {targetDistance && <span className="ml-1 text-2xs text-ink-faint">{targetDistance}</span>}
                  </div>
                  <div className={`num text-xs ${missingStop ? 'font-semibold text-down' : 'text-down'}`}>
                    {position.stopLoss ? fmtPrice(position.stopLoss) : '无'}
                    {stopDistance && <span className="ml-1 text-2xs text-ink-faint">{stopDistance}</span>}
                  </div>
                </td>

                <td className={`td num text-right ${position.liquidationPrice ? 'text-warn' : 'text-ink-faint'}`}>
                  {position.liquidationPrice ? fmtPrice(position.liquidationPrice) : '—'}
                </td>

                <td className={`td num text-right ${pnlColor(position.unrealizedPnl)}`}>
                  {fmtUsdSigned(position.unrealizedPnl, 2)}
                  <div className="text-2xs">{fmtPercent(position.unrealizedPnlPercent)}</div>
                </td>

                <td className="td text-right">
                  <Button small variant="danger" onClick={() => onCloseRequest(position.symbol)} title="查看手工平仓的说明">
                    平仓
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Orders (open / all)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Binance order states that will never change again.
 *
 * `NEW` and `PARTIALLY_FILLED` are the only genuinely live ones; everything
 * else is history, so an "open orders" view filters on exactly that.
 */
const TERMINAL_STATUSES = new Set([
  'FILLED',
  'CANCELED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
  'EXPIRED_IN_FUTURES',
]);

export function isOpenOrder(order: OrderRecord): boolean {
  return !TERMINAL_STATUSES.has(order.status.toUpperCase());
}

export function OrdersTable({
  traderId,
  onlyOpen,
  refreshToken,
}: {
  traderId: number;
  onlyOpen: boolean;
  refreshToken?: number;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.orders);
  const query = usePolled((signal) => api.traderOrders(traderId, 200, signal), {
    intervalMs: 15_000,
    deps: [traderId, refreshToken],
  });

  const all: OrderRecord[] = live && live.length > 0 ? live : (query.data ?? []);
  const orders = onlyOpen ? all.filter(isOpenOrder) : all;

  if (query.loading && all.length === 0) return <Spinner3 label="正在加载委托" />;
  if (orders.length === 0) {
    return onlyOpen ? (
      <Empty message="暂无当前委托。" hint="交易所侧的止损 / 止盈单在触发前会出现在这里。" />
    ) : (
      <Empty message="暂无订单记录。" />
    );
  }

  return (
    <div className="scroll-x">
      <table className="w-full border-collapse">
        <thead className="border-b border-base-800 bg-base-850/60">
          <tr>
            <th className="th">时间</th>
            <th className="th">交易对</th>
            <th className="th">用途</th>
            <th className="th">方向</th>
            <th className="th">类型</th>
            <th className="th text-right">数量</th>
            <th className="th text-right">价格</th>
            <th className="th text-right">触发价</th>
            <th className="th text-right">已成交</th>
            <th className="th text-right">均价</th>
            <th className="th">状态</th>
            <th className="th">错误</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id} className="row-hover">
              <td className="td num text-ink-faint">{fmtDateTime(order.createdAt)}</td>
              <td className="td font-semibold text-ink-hi">{order.symbol}</td>
              <td className="td">
                <Badge tone={purposeTone(order.purpose)}>{purposeLabel(order.purpose)}</Badge>
              </td>
              <td className={`td font-semibold ${order.side === 'BUY' ? 'text-up' : 'text-down'}`}>
                {order.side === 'BUY' ? '买入' : '卖出'}
              </td>
              <td className="td text-ink-lo">{order.type}</td>
              <td className="td num text-right">{fmtQty(order.quantity)}</td>
              <td className="td num text-right">{order.price ? fmtPrice(order.price) : '市价'}</td>
              <td className="td num text-right text-ink-lo">{order.stopPrice ? fmtPrice(order.stopPrice) : '—'}</td>
              <td className="td num text-right">{fmtQty(order.filledQty)}</td>
              <td className="td num text-right">{order.avgPrice ? fmtPrice(order.avgPrice) : '—'}</td>
              <td className="td">
                <span
                  className={
                    isOpenOrder(order) ? 'text-up' : /cancel|reject|expired/i.test(order.status) ? 'text-warn' : 'text-ink-mid'
                  }
                >
                  {order.status}
                </span>
              </td>
              <td className="td max-w-[220px] truncate text-down" title={order.error ?? undefined}>
                {order.error ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

/* -------------------------------------------------------------------------- */
/*  Trades                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Why a row carries the 对账补录 badge.
 *
 * The position certainly closed — the exchange's own history says so — but the
 * bot was not running to observe which order did it, so the round-trip was
 * rebuilt afterwards. Seeing the badge means live bookkeeping missed a close,
 * which is exactly the thing an operator should know about.
 */
const RECONCILED_TITLE =
  '该持仓在机器人未运行期间平仓（例如交易所侧止盈被触发），本行由对账从交易所的成交历史补录，实时记账当时漏掉了它。';

export function TradesTable({ traderId, refreshToken }: { traderId: number; refreshToken?: number }) {
  const live = useEvents((s) => s.byTrader[traderId]?.trades);
  const query = usePolled((signal) => api.traderTrades(traderId, 200, signal), {
    intervalMs: 15_000,
    deps: [traderId, refreshToken],
  });

  const trades: TradeRecord[] = live && live.length > 0 ? live : (query.data ?? []);

  if (query.loading && trades.length === 0) return <Spinner3 label="正在加载成交记录" />;
  if (trades.length === 0) {
    return <Empty message="暂无历史成交。" hint="每笔平仓都会连同平仓原因一起持久化。" />;
  }

  /*
   * Counted on 净盈亏, not on the gross.
   *
   * Commission can turn a nominally positive round-trip into a loss (the live
   * account has one: gross +0.0011, net −0.0187), and the backend's own
   * `wins`/`losses` count the net. Counting the gross here made this header
   * disagree with the 胜率 card above it.
   */
  const wins = trades.filter((trade) => trade.netPnl > 0).length;
  const totals: PnlCosts = trades.reduce<PnlCosts>(
    (sum, trade) => ({
      gross: sum.gross + trade.pnl,
      fees: sum.fees + trade.fee,
      funding: sum.funding + trade.fundingFee,
      net: sum.net + trade.netPnl,
    }),
    { gross: 0, fees: 0, funding: 0, net: 0 },
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-base-800 px-3 py-1.5 text-2xs">
        <span className="text-ink-lo">
          {trades.length} 笔成交 · <span className="text-up">{wins} 盈</span> /{' '}
          <span className="text-down">{trades.length - wins} 亏</span>
        </span>
        <PnlBreakdown costs={totals} />
        <span className={`num ml-auto ${pnlColor(totals.net)}`} title={NET_PNL_FORMULA}>
          净额 {fmtUsdSigned(totals.net, 2)}
        </span>
      </div>
      <div className="scroll-x">
        <table className="w-full border-collapse">
          <thead className="border-b border-base-800 bg-base-850/60">
            <tr>
              <th className="th">交易对</th>
              <th className="th">方向</th>
              <th className="th text-right">杠杆</th>
              <th className="th text-right">数量</th>
              <th className="th text-right">开仓价</th>
              <th className="th text-right">平仓价</th>
              <th className="th text-right">盈亏（毛）</th>
              <th className="th text-right">手续费</th>
              <th className="th text-right">净盈亏</th>
              <th className="th text-right">净盈亏 %</th>
              <th className="th">平仓原因</th>
              <th className="th text-right">持仓时长</th>
              <th className="th">平仓时间</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => {
              const costs = tradeCosts(trade);
              const reconciled = trade.source === 'reconciled' || trade.closeReason === 'reconciled';
              return (
                <tr key={trade.id} className={reconciled ? 'row-hover bg-warn/5' : 'row-hover'}>
                  <td className="td font-semibold text-ink-hi">
                    <div className="flex items-center gap-1.5">
                      <span>{trade.symbol}</span>
                      {reconciled && (
                        <Badge tone="warn" title={RECONCILED_TITLE}>
                          对账补录
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="td">
                    <SideBadge side={trade.side} />
                  </td>
                  <td className="td num text-right text-ink-lo">{trade.leverage}x</td>
                  <td className="td num text-right">{fmtQty(trade.quantity)}</td>
                  <td className="td num text-right">{fmtPrice(trade.entryPrice)}</td>
                  <td className="td num text-right">{fmtPrice(trade.exitPrice)}</td>
                  {/* The gross stays visible but muted: it is the input to the
                      arithmetic, not the answer. 净盈亏 is the answer. */}
                  <td className="td num text-right text-ink-lo" title={pnlFormulaText(costs)}>
                    {fmtUsdSigned(trade.pnl, 2)}
                  </td>
                  <td className="td num text-right text-warn" title={pnlFormulaText(costs)}>
                    {fmtSigned(-trade.fee, 4)}
                    <div className="text-2xs text-ink-faint">
                      开 {fmtSigned(trade.entryFee, 4)} · 平 {fmtSigned(trade.exitFee, 4)}
                    </div>
                    {trade.fundingFee !== 0 && (
                      <div className={`text-2xs ${pnlColor(trade.fundingFee)}`} title="资金费：负数表示支付">
                        资 {fmtSigned(trade.fundingFee, 4)}
                      </div>
                    )}
                  </td>
                  <td
                    className={`td num text-right font-semibold ${pnlColor(trade.netPnl)}`}
                    title={pnlFormulaText(costs)}
                  >
                    {fmtUsdSigned(trade.netPnl, 2)}
                  </td>
                  <td className={`td num text-right ${pnlColor(trade.netPnl)}`} title={pnlFormulaText(costs)}>
                    {fmtPercent(trade.pnlPercent)}
                  </td>
                  <td className="td" title={reconciled ? RECONCILED_TITLE : undefined}>
                    <span className={reconciled ? 'text-warn' : 'text-ink-lo'}>
                      {closeReasonLabel(trade.closeReason)}
                    </span>
                  </td>
                  <td className="td num text-right">{fmtDuration(trade.holdMinutes)}</td>
                  <td className="td num text-ink-faint">{fmtDateTime(trade.closedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Container with the toolbar                                                 */
/* -------------------------------------------------------------------------- */

export type TraderTabId = 'positions' | 'orders' | 'trades' | 'history';

export function TraderTables({
  traderId,
  tab,
  onChange,
  positionCount,
  openOrderCount,
  refreshToken,
}: {
  traderId: number;
  tab: TraderTabId;
  onChange: (tab: TraderTabId) => void;
  positionCount: number;
  openOrderCount: number;
  /**
   * Bumped by the caller after a manual 对账, so the tables refetch instead of
   * waiting out their 15-second poll — the numbers the operator just changed
   * should be the numbers on screen.
   */
  refreshToken?: number;
}) {
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [ordersRefreshToken, setOrdersRefreshToken] = useState(0);
  // One token drives both tables: the toolbar ⟳ and the caller's 对账 both mean
  // "these rows are stale".
  const token = (refreshToken ?? 0) + ordersRefreshToken;

  const tabs: Array<{ id: TraderTabId; label: string; count?: number }> = [
    { id: 'positions', label: '当前持仓', count: positionCount },
    { id: 'orders', label: '当前委托', count: openOrderCount },
    { id: 'trades', label: '历史成交' },
    { id: 'history', label: '订单记录' },
  ];

  return (
    <Panel padded={false} bodyClassName="p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-base-800 px-3 py-1.5">
        <div className="flex items-center gap-0.5">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              className={
                tab === item.id
                  ? '-mb-px border-b-2 border-accent px-2.5 py-1 text-xs font-medium text-ink-hi'
                  : '-mb-px border-b-2 border-transparent px-2.5 py-1 text-xs text-ink-lo transition hover:text-ink-mid'
              }
            >
              {item.label}
              {item.count !== undefined && <span className="num ml-1.5 text-2xs text-ink-faint">{item.count}</span>}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            small
            variant="danger"
            disabled={positionCount === 0}
            title={positionCount === 0 ? '当前没有持仓' : '查看手工平仓的说明'}
            onClick={() => setCloseTarget('__all__')}
          >
            全部平仓
          </Button>
          <Button small variant="ghost" onClick={() => setOrdersRefreshToken((n) => n + 1)} title="立即刷新表格数据">
            ⟳ 刷新
          </Button>
        </div>
      </div>

      <div className="min-h-[220px]">
        {tab === 'positions' && <PositionsTable traderId={traderId} onCloseRequest={setCloseTarget} />}
        {tab === 'orders' && <OrdersTable traderId={traderId} onlyOpen refreshToken={token} />}
        {tab === 'trades' && <TradesTable traderId={traderId} refreshToken={token} />}
        {tab === 'history' && <OrdersTable traderId={traderId} onlyOpen={false} refreshToken={token} />}
      </div>

      <CloseNoticeModal symbol={closeTarget} onClose={() => setCloseTarget(null)} />
    </Panel>
  );
}
