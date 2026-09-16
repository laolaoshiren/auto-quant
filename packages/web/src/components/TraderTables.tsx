/**
 * Trader dashboard tables: 当前持仓 / 当前委托 / 历史成交 / 订单记录.
 *
 * Two rules hold for every table in this file, and both come from DESIGN.md §6:
 *
 * 1. **Never render an unbounded list.** The endpoints answer up to 200 rows;
 *    a long-running bot reaches that in days. Each table renders at most
 *    `MAX_ROWS` and says so in a footer instead of silently dropping rows.
 * 2. **Horizontal scrolling stays inside the table.** Every table sits in a
 *    `.scroll-x` box, so a 13-column order table never pushes the page wide
 *    (the shell has `overflow-x-hidden` and would otherwise clip it).
 *
 * The close controls are deliberately *not* wired to an API call — the backend
 * has no manual-close endpoint. Pressing one opens an explanation of how the
 * bot actually closes positions rather than pretending a request was sent.
 */
import { useState } from 'react';
import type { OrderRecord, PositionView, TradeRecord } from '@aq/shared';
import { orderPurposeLabel, orderStatusLabel, orderTypeLabel } from '@aq/shared';
import { api } from '../lib/api';
import { useEvents } from '../lib/store';
import { usePolled } from '../lib/hooks';
import { Badge, Button, Modal, Panel, Spinner3 } from './ui';
import { SideBadge } from './Badges';
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
/*  Row caps                                                                   */
/* -------------------------------------------------------------------------- */

/** Rows rendered per table. The API can return 200; the DOM gets 100. */
const MAX_ROWS = 100;

/**
 * What a capped table says instead of quietly losing rows.
 *
 * The count is stated because "100 of 200" is itself information — the operator
 * learns the exporter or the API limit is in play, rather than assuming the
 * history ends here.
 */
function CapNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="border-t border-base-800 px-3 py-2 text-xs text-ink-faint">
      只渲染最近 {shown} 行，共 {total} 行 — 更早的记录请在交易所或导出接口查询，避免一次渲染上千行拖慢页面。
    </p>
  );
}

/**
 * 空表格只留一行。
 *
 * 不用 `ui.Empty`：它的 `py-10` 是给整页空状态用的，放进表格里会在面板中间
 * 留出半屏空白 —— 那正是这次改造要修的东西。空表要说的只有"现在没有"，
 * 以及一句"什么情况下会有"。
 */
function TableEmpty({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3.5 py-2.5">
      <span className="text-base text-ink-lo">{message}</span>
      {hint && <span className="text-xs text-ink-faint">{hint}</span>}
    </div>
  );
}

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
        <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base font-semibold text-warn">
          该按钮不会下任何订单。
        </div>
        {CLOSE_EXPLANATION.map((line) => (
          <p key={line} className="text-base leading-relaxed text-ink-mid">
            {line}
          </p>
        ))}
        <p className="text-xs leading-relaxed text-ink-faint">
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
    return <TableEmpty message="暂无持仓。" hint="模型选择空仓 — 没有符合条件的标时不会下任何订单。" />;
  }

  const shown = positions.slice(0, MAX_ROWS);

  return (
    <div>
      {/* max-h as well as the cap: 100 position rows is still taller than any
          screen, and the tab bar above must stay reachable. */}
      <div className="scroll-x max-h-[60vh] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
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
            {shown.map((position) => {
              const missingStop = position.stopLoss === null || position.stopLoss === undefined;
              const stopDistance = position.stopLoss ? distancePercent(position.entryPrice, position.stopLoss) : null;
              const targetDistance = position.takeProfit ? distancePercent(position.entryPrice, position.takeProfit) : null;

              return (
                <tr key={position.id} className="row-hover align-top">
                  <td className="td">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-semibold text-ink-hi">{position.symbol}</span>
                      <SideBadge side={position.side} />
                      <Badge tone="muted" title="该持仓在交易所使用的杠杆倍数。">
                        {position.leverage}x
                      </Badge>
                      {missingStop && (
                        <Badge tone="down" title="该持仓没有交易所侧止损。">
                          无止损
                        </Badge>
                      )}
                    </div>
                    <div className="num mt-0.5 text-xs text-ink-faint">
                      持仓 {fmtDuration((Date.now() - new Date(position.openedAt).getTime()) / 60_000)}
                    </div>
                  </td>

                  <td className="td num text-right">
                    {fmtQty(position.quantity)}
                    <div className="text-xs text-ink-faint">
                      名义 <span className="text-ink-lo">{fmtUsd(position.notional, 2)}</span>
                    </div>
                  </td>

                  <td className="td num text-right">
                    {fmtPrice(position.entryPrice)}
                    <div className="text-xs text-ink-faint">标记 {fmtPrice(position.markPrice)}</div>
                  </td>

                  <td className="td">
                    <div className="num text-base text-up">
                      {position.takeProfit ? fmtPrice(position.takeProfit) : '无'}
                      {targetDistance && <span className="ml-1 text-xs text-ink-faint">{targetDistance}</span>}
                    </div>
                    <div className={`num text-base ${missingStop ? 'font-semibold text-down' : 'text-down'}`}>
                      {position.stopLoss ? fmtPrice(position.stopLoss) : '无'}
                      {stopDistance && <span className="ml-1 text-xs text-ink-faint">{stopDistance}</span>}
                    </div>
                  </td>

                  <td className={`td num text-right ${position.liquidationPrice ? 'text-warn' : 'text-ink-faint'}`}>
                    {position.liquidationPrice ? fmtPrice(position.liquidationPrice) : '—'}
                  </td>

                  <td className={`td num text-right ${pnlColor(position.unrealizedPnl)}`}>
                    {fmtUsdSigned(position.unrealizedPnl, 2)}
                    <div className="text-xs">{fmtPercent(position.unrealizedPnlPercent)}</div>
                  </td>

                  <td className="td text-right">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => onCloseRequest(position.symbol)}
                      title="查看手工平仓的说明"
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
      <TableEmpty message="暂无当前委托。" hint="交易所侧的止损 / 止盈单在触发前会出现在这里。" />
    ) : (
      <TableEmpty message="暂无订单记录。" />
    );
  }

  const shown = orders.slice(0, MAX_ROWS);

  return (
    <div>
      {/* 12 columns: this is the table that most needs its own horizontal
          scroller rather than a page-wide one. */}
      <div className="scroll-x max-h-[60vh] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
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
            {shown.map((order) => (
              <tr key={order.id} className="row-hover">
                <td className="td num text-ink-faint">{fmtDateTime(order.createdAt)}</td>
                <td className="td font-semibold text-ink-hi">{order.symbol}</td>
                <td className="td">
                  <Badge tone={purposeTone(order.purpose)}>{orderPurposeLabel(order.purpose)}</Badge>
                </td>
                <td className={`td font-semibold ${order.side === 'BUY' ? 'text-up' : 'text-down'}`}>
                  {order.side === 'BUY' ? '买入' : '卖出'}
                </td>
                <td className="td text-ink-lo">{orderTypeLabel(order.type)}</td>
                <td className="td num text-right">{fmtQty(order.quantity)}</td>
                <td className="td num text-right">{order.price ? fmtPrice(order.price) : '市价'}</td>
                <td className="td num text-right text-ink-lo">{order.stopPrice ? fmtPrice(order.stopPrice) : '—'}</td>
                <td className="td num text-right">{fmtQty(order.filledQty)}</td>
                <td className="td num text-right">{order.avgPrice ? fmtPrice(order.avgPrice) : '—'}</td>
                <td className="td">
                  {/* `order.status` 是币安自己的机器码（NEW / FILLED / …），
                      中文标签在 `@aq/shared` 的 ORDER_STATUS_LABELS —— 之前这里
                      直接把英文码打在表格里。 */}
                  <span
                    title={order.status}
                    className={
                      isOpenOrder(order) ? 'text-up' : /cancel|reject|expired/i.test(order.status) ? 'text-warn' : 'text-ink-mid'
                    }
                  >
                    {orderStatusLabel(order.status)}
                  </span>
                </td>
                <td className="td max-w-[240px] truncate text-down" title={order.error ?? undefined}>
                  {order.error ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CapNote shown={shown.length} total={orders.length} />
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
    return <TableEmpty message="暂无历史成交。" hint="每笔平仓都会连同平仓原因一起持久化。" />;
  }

  /*
   * Counted on 净盈亏, not on the gross.
   *
   * Commission can turn a nominally positive round-trip into a loss (the live
   * account has one: gross +0.0011, net −0.0187), and the backend's own
   * `wins`/`losses` count the net. Counting the gross here made this header
   * disagree with the 胜率 card above it.
   *
   * Counted over every fetched trade, not just the rendered page: the header is
   * a summary of the history, and a capped table must not change what "12 盈"
   * means.
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

  const shown = trades.slice(0, MAX_ROWS);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-base-800 px-3 py-2 text-xs">
        <span className="text-ink-lo">
          {trades.length} 笔成交 · <span className="text-up">{wins} 盈</span> /{' '}
          <span className="text-down">{trades.length - wins} 亏</span>
        </span>
        {/*
          The gross → net bridge, and it stays inline. Collapsing it into the
          single 净额 figure is the difference between a number the operator
          trusts and one they have to take on faith.
        */}
        <PnlBreakdown costs={totals} />
        <span className={`num ml-auto text-base font-semibold ${pnlColor(totals.net)}`} title={NET_PNL_FORMULA}>
          净额 {fmtUsdSigned(totals.net, 2)}
        </span>
      </div>
      <div className="scroll-x max-h-[60vh] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
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
            {shown.map((trade) => {
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
                    <div className="text-xs text-ink-faint">
                      开 {fmtSigned(trade.entryFee, 4)} · 平 {fmtSigned(trade.exitFee, 4)}
                    </div>
                    {trade.fundingFee !== 0 && (
                      <div className={`text-xs ${pnlColor(trade.fundingFee)}`} title="资金费：负数表示支付">
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
                    {/* `closeReason` is a persisted machine code; the Chinese
                        label lives in CLOSE_REASON_LABELS only. */}
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
      <CapNote shown={shown.length} total={trades.length} />
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
      <div className="flex flex-wrap items-center gap-2 border-b border-base-800 px-3 py-2">
        {/* Real tab semantics, so the arrow keys and the tab order work. */}
        <div role="tablist" aria-label="机器人数据表" className="flex items-center gap-0.5">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => onChange(item.id)}
              className={
                tab === item.id
                  ? '-mb-px border-b-2 border-accent px-3 py-1.5 text-base font-semibold text-ink-hi'
                  : '-mb-px border-b-2 border-transparent px-3 py-1.5 text-base text-ink-lo transition hover:text-ink-mid'
              }
            >
              {item.label}
              {item.count !== undefined && <span className="num ml-1.5 text-xs text-ink-faint">{item.count}</span>}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="danger"
            disabled={positionCount === 0}
            title={positionCount === 0 ? '当前没有持仓' : '查看手工平仓的说明'}
            onClick={() => setCloseTarget('__all__')}
          >
            全部平仓
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOrdersRefreshToken((n) => n + 1)} title="立即刷新表格数据">
            刷新
          </Button>
        </div>
      </div>

      {/* 空表格不占位：`min-h` 曾经给这一区留了 220px，于是"暂无持仓"下面跟着
          一片空白。高度交给内容，有行时才需要滚动。 */}
      <div>
        {tab === 'positions' && <PositionsTable traderId={traderId} onCloseRequest={setCloseTarget} />}
        {tab === 'orders' && <OrdersTable traderId={traderId} onlyOpen refreshToken={token} />}
        {tab === 'trades' && <TradesTable traderId={traderId} refreshToken={token} />}
        {tab === 'history' && <OrdersTable traderId={traderId} onlyOpen={false} refreshToken={token} />}
      </div>

      <CloseNoticeModal symbol={closeTarget} onClose={() => setCloseTarget(null)} />
    </Panel>
  );
}
