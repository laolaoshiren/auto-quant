import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Pencil, Play, RotateCw, Square, Trash2 } from 'lucide-react';
import type { TraderStatus } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { useApp, useEvents } from '../lib/store';
import { useSummaries } from '../lib/summaries';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { useRunOnce } from '../lib/actions';
import { Badge, Button, Empty, ErrorNote, Modal, Panel, Spinner3, Stat } from '../components/ui';
import { SectionHeading, TraderStatusBadge } from '../components/Badges';
import { NewTraderModal, StartTraderModal } from '../components/TraderModals';
import { TraderConfigModal } from '../components/TraderConfigModal';
import { NET_PNL_FORMULA, PnlBreakdown, pnlFormulaText, statsCosts, type PnlCosts } from '../components/PnlBreakdown';
import {
  fmtDuration,
  fmtInt,
  fmtPercent,
  fmtProfitFactor,
  fmtUsd,
  fmtUsdSigned,
  pnlColor,
  timeAgo,
} from '../lib/format';

/**
 * Rows rendered in the fleet table.
 *
 * The API returns every trader, and an operator with a few dozen of them is
 * expected; the cap keeps the DOM bounded and the note below the table says so
 * rather than losing rows silently.
 */
const MAX_ROWS = 100;

/** Which destructive action a confirmation dialog is currently guarding. */
type PendingAction = { kind: 'stop' | 'delete'; trader: TraderRow } | null;

/**
 * Dedicated bot list.
 *
 * The overview deliberately stays a system dashboard, so the full table with
 * every per-bot control lives here instead of being squeezed into it.
 */
export function TradersPage() {
  useDocumentTitle('机器人');
  const navigate = useNavigate();
  const system = useApp((s) => s.system);
  const setTraders = useApp((s) => s.setTraders);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const socketOpen = useEvents((s) => s.status) === 'open';
  const liveByTrader = useEvents((s) => s.byTrader);

  const tradersQuery = usePolled((signal) => api.traders(signal), {
    intervalMs: socketOpen ? 8000 : 4000,
  });
  const traders = tradersQuery.data ?? [];

  const statsMap = useSummaries((s) => s.stats);
  const refreshMany = useSummaries((s) => s.refreshMany);

  const [newOpen, setNewOpen] = useState(false);
  const [startTarget, setStartTarget] = useState<TraderRow | null>(null);
  const [editTarget, setEditTarget] = useState<TraderRow | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { runOnce, busyId: busyOnceId } = useRunOnce();

  useEffect(() => {
    if (tradersQuery.data) setTraders(tradersQuery.data);
  }, [tradersQuery.data, setTraders]);

  const traderIds = traders.map((t) => t.id).join(',');

  useEffect(() => {
    const ids = traderIds ? traderIds.split(',').map(Number) : [];
    if (ids.length === 0) return;
    void refreshMany(ids);
    const timer = window.setInterval(() => void refreshMany(ids), socketOpen ? 10_000 : 5000);
    return () => window.clearInterval(timer);
  }, [traderIds, refreshMany, socketOpen]);

  /**
   * Run whichever confirmed action the dialog was opened for.
   *
   * The dialog stays open while the request is in flight: closing it first would
   * leave the operator with no feedback on an action that stops a loop trading
   * real money, and a failure would then have nowhere to report itself.
   */
  const runPending = async () => {
    if (!pending) return;
    const { kind, trader } = pending;
    setBusyId(trader.id);
    setActionError(null);
    try {
      if (kind === 'stop') await api.stopTrader(trader.id);
      else await api.deleteTrader(trader.id);
      await tradersQuery.reload();
      refreshSystem();
      setPending(null);
    } catch (err) {
      setActionError((err as Error).message);
      setPending(null);
    } finally {
      setBusyId(null);
    }
  };

  const runningCount = traders.filter((t) => t.isRunning).length;
  const totalEquity = traders.reduce(
    (sum, trader) => sum + (statsMap[trader.id]?.equity ?? trader.initialEquity),
    0,
  );
  const totalRealized = traders.reduce((sum, trader) => sum + (statsMap[trader.id]?.realizedPnl ?? 0), 0);
  const openPositions = traders.reduce((sum, trader) => sum + (statsMap[trader.id]?.openPositions ?? 0), 0);

  /*
   * Fleet-wide gross → net bridge.
   *
   * Only traders whose stats have actually loaded are counted — `known` keeps an
   * empty table from claiming a confident `毛 0 · 手续费 0`.
   */
  const fleet = traders.reduce<{ costs: PnlCosts; known: boolean }>(
    (acc, trader) => {
      const stats = statsMap[trader.id];
      if (!stats) return acc;
      const row = statsCosts(stats);
      return {
        known: true,
        costs: {
          gross: acc.costs.gross + row.gross,
          fees: acc.costs.fees + row.fees,
          funding: acc.costs.funding + row.funding,
          net: acc.costs.net + row.net,
        },
      };
    },
    { costs: { gross: 0, fees: 0, funding: 0, net: 0 }, known: false },
  );

  const shown = traders.slice(0, MAX_ROWS);

  return (
    <div className="mx-auto w-full max-w-[110rem] space-y-3">
      <SectionHeading
        title="机器人"
        sub="每个机器人 = 一份交易所凭证 + 一个 AI 模型 + 一套策略，按固定间隔循环决策。"
        right={
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            + 新建机器人
          </Button>
        }
      />

      {/*
        The fleet's four headline numbers, at the size DESIGN.md §4 asks for.
        `Stat` rather than a bespoke band: this row and the per-bot page are
        read side by side, and the same figures should not change size between
        them.
      */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat
          label="运行中"
          value={
            <>
              {runningCount}
              <span className="text-xl text-ink-faint"> / {traders.length}</span>
            </>
          }
          sub="运行 / 总数"
        />
        <Stat
          label="总权益"
          value={fmtUsd(totalEquity, 2)}
          sub={`${fmtInt(openPositions)} 个未平仓合约`}
        />
        <Stat
          label="已实现盈亏"
          value={fmtUsdSigned(totalRealized, 2)}
          tone={pnlColor(totalRealized)}
          sub={fleet.known ? <PnlBreakdown costs={fleet.costs} /> : '所有机器人合计'}
          title={`${NET_PNL_FORMULA}。此处为所有机器人已平仓成交的净盈亏合计。`}
        />
        <Stat
          label="当前持仓"
          value={fmtInt(openPositions)}
          sub="所有机器人的未平仓合约数"
        />
      </div>

      {actionError && <ErrorNote>{actionError}</ErrorNote>}

      <Panel padded={false}>
        {tradersQuery.loading && traders.length === 0 ? (
          <Spinner3 label="正在加载机器人" />
        ) : traders.length === 0 ? (
          <Empty
            message="还没有机器人。"
            hint="先创建一个，再选择模拟或实盘 — 模拟是默认模式，无需交易所密钥即可放心运行。"
            action={
              <Button variant="primary" onClick={() => setNewOpen(true)}>
                + 新建机器人
              </Button>
            }
          />
        ) : (
          <div>
            <div className="scroll-x max-h-[70vh] overflow-y-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
                  <tr>
                    <th className="th">机器人</th>
                    <th className="th">状态</th>
                    <th className="th text-right">权益</th>
                    <th className="th text-right">总收益率</th>
                    <th className="th text-right">持仓</th>
                    <th className="th text-right">胜率</th>
                    <th className="th text-right">成交笔数</th>
                    <th className="th text-right">最大回撤</th>
                    <th className="th text-right">运行时长</th>
                    <th className="th text-right">最近周期</th>
                    <th className="th text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((trader) => {
                    const stats = statsMap[trader.id];
                    const live = liveByTrader[trader.id];
                    const status: TraderStatus = live?.status ?? trader.status;
                    const rowBusy = busyId === trader.id;
                    return (
                      <tr key={trader.id} className="row-hover">
                        <td className="td">
                          {/* Whole cell is the link: the row's job is to open the
                              trader, and a name-sized target is not enough. */}
                          <Link to={`/traders/${trader.id}`} className="group block">
                            <div className="text-base font-semibold text-ink-hi group-hover:text-accent">
                              {trader.name}
                            </div>
                            <div className="num text-xs text-ink-faint">
                              #{trader.id} · 周期 {trader.lastCycleNumber} · 每 {trader.cycleIntervalMinutes}m
                            </div>
                          </Link>
                        </td>
                        <td className="td">
                          <TraderStatusBadge status={status} live={trader.isRunning} />
                          {trader.consecutiveFailures > 0 && (
                            <div className="mt-0.5 text-xs text-warn">{trader.consecutiveFailures} 次连续失败</div>
                          )}
                        </td>
                        <td className={`td num text-right ${stats ? 'text-ink-hi' : 'text-ink-faint'}`}>
                          {stats ? fmtUsd(stats.equity, 2) : '—'}
                        </td>
                        <td className={`td num text-right ${stats ? pnlColor(stats.totalReturnPercent) : ''}`}>
                          {stats ? fmtPercent(stats.totalReturnPercent) : '—'}
                          {stats && (
                            /* 净 first: it is what the balance did. 毛 is the
                               input, kept one muted step back so the two are
                               directly comparable. */
                            <div
                              className="text-xs text-ink-faint"
                              title={`${pnlFormulaText(statsCosts(stats))}。浮动盈亏 ${fmtUsdSigned(
                                stats.unrealizedPnl,
                                2,
                              )} 未计入本行。`}
                            >
                              净 {fmtUsdSigned(stats.realizedPnl, 2)} · 毛{' '}
                              {fmtUsdSigned(stats.grossRealizedPnl, 2)}
                            </div>
                          )}
                        </td>
                        <td className="td num text-right">{stats ? fmtInt(stats.openPositions) : '—'}</td>
                        {/* `winRatePercent` is already 0–100 — never × 100 again. */}
                        <td className="td num text-right">{stats ? `${stats.winRatePercent.toFixed(1)}%` : '—'}</td>
                        <td className="td num text-right">
                          {stats ? (
                            <>
                              {fmtInt(stats.totalTrades)}
                              <div className="text-xs text-ink-faint" title="盈利因子（∞ = 尚无亏损成交）">
                                PF {fmtProfitFactor(stats.profitFactor)}
                              </div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="td num text-right text-down">
                          {stats ? `-${stats.maxDrawdownPercent.toFixed(2)}%` : '—'}
                        </td>
                        <td className="td num text-right text-ink-lo">
                          {stats ? fmtDuration(stats.uptimeHours * 60) : '—'}
                        </td>
                        <td className="td num text-right text-ink-lo">{timeAgo(trader.lastCycleAt)}</td>
                        <td className="td text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button size="sm" onClick={() => navigate(`/traders/${trader.id}`)}>
                              打开
                            </Button>
                            {trader.isRunning ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="primary"
                                  busy={busyOnceId === trader.id}
                                  title="立即强制执行一个决策周期"
                                  onClick={() => void runOnce(trader.id, trader.name)}
                                >
                                  <RotateCw aria-hidden className="h-3.5 w-3.5" />
                                  立即运行
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  busy={rowBusy && pending?.kind !== 'delete'}
                                  title="停止循环 — 需要确认"
                                  onClick={() => setPending({ kind: 'stop', trader })}
                                >
                                  <Square aria-hidden className="h-3.5 w-3.5" />
                                  停止
                                </Button>
                              </>
                            ) : (
                              <Button size="sm" variant="success" onClick={() => setStartTarget(trader)}>
                                <Play aria-hidden className="h-3.5 w-3.5" />
                                启动
                              </Button>
                            )}
                            <Button
                              size="sm"
                              onClick={() => setEditTarget(trader)}
                              disabled={trader.isRunning}
                              title={trader.isRunning ? '请先停止该机器人再修改配置。' : '编辑配置'}
                            >
                              <Pencil aria-hidden className="h-3.5 w-3.5" />
                              编辑
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              busy={rowBusy && pending?.kind === 'delete'}
                              title={`删除“${trader.name}” — 需要确认`}
                              aria-label={`删除 ${trader.name}`}
                              onClick={() => setPending({ kind: 'delete', trader })}
                            >
                              <Trash2 aria-hidden className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {traders.length > shown.length && (
              <p className="border-t border-base-800 px-3 py-2 text-xs text-ink-faint">
                只渲染前 {shown.length} 个，共 {traders.length} 个机器人。
              </p>
            )}
          </div>
        )}
      </Panel>

      <p className="text-xs leading-relaxed text-ink-faint">
        启动机器人时总会先执行预检；阻断性失败会以红色显示，并阻止该循环交易。停止是立即生效的。
        {system?.tradingDisabled ? ' 当前服务端已设置 GLOBAL_TRADING_DISABLED，所有启动请求都会被拒绝。' : ''}
      </p>

      {/*
        Destructive actions are confirmed in a real dialog rather than
        `window.confirm`: the native one cannot be styled, cannot show a loading
        state, and blocks the whole tab — and here the confirmation has to state
        the consequence, which a single line of plain text does poorly.
      */}
      <Modal
        open={pending !== null}
        onClose={() => (busyId === null ? setPending(null) : undefined)}
        title={pending?.kind === 'delete' ? `删除“${pending.trader.name}”` : `停止“${pending?.trader.name ?? ''}”`}
        width="max-w-lg"
        footer={
          <>
            <Button onClick={() => setPending(null)} disabled={busyId !== null}>
              取消
            </Button>
            <Button
              variant="danger"
              busy={busyId !== null}
              autoFocus
              onClick={() => void runPending()}
            >
              {pending?.kind === 'delete' ? '确认删除' : '确认停止'}
            </Button>
          </>
        }
      >
        {pending?.kind === 'delete' ? (
          <div className="space-y-2">
            <div className="rounded-md border border-down/50 bg-down/10 px-3 py-2 text-base font-semibold text-down">
              该操作不可撤销。
            </div>
            <p className="text-base leading-relaxed text-ink-mid">
              机器人 <span className="font-semibold text-ink-hi">{pending.trader.name}</span>{' '}
              及其<strong className="font-semibold text-ink-hi">全部</strong>成交记录、委托记录与决策记录（含提示词与思维链）
              会一并从数据库中删除。交易所上的持仓与挂单{' '}
              <strong className="font-semibold text-ink-hi">不会</strong>被平掉 — 它只是不再有人管理。
            </p>
            <p className="text-base leading-relaxed text-ink-mid">
              如果只是想让它停下来，请改用「停止」。
            </p>
            {pending.trader.isRunning && (
              <p className="text-xs text-warn">
                该机器人当前正在运行，删除会立即中断正在执行的决策周期。
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-base leading-relaxed text-ink-mid">
              停止 <span className="font-semibold text-ink-hi">{pending?.trader.name}</span> 会立即结束当前循环。
            </p>
            <p className="text-base leading-relaxed text-ink-mid">
              后果：该机器人不再开新仓，也不再有模型决策；
              <strong className="font-semibold text-ink-hi">已有的持仓与交易所侧挂单保持不变</strong>
              ，不会自动平仓。重新启动后需要再次通过预检。
            </p>
          </div>
        )}
      </Modal>

      <NewTraderModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(trader) => {
          setNewOpen(false);
          void tradersQuery.reload();
          refreshSystem();
          setStartTarget(trader);
        }}
      />

      <TraderConfigModal
        trader={editTarget}
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          void tradersQuery.reload();
        }}
      />

      <StartTraderModal
        trader={startTarget}
        open={startTarget !== null}
        onClose={() => setStartTarget(null)}
        initialDryRun={system?.dryRun ?? true}
        onStarted={() => {
          void tradersQuery.reload();
          refreshSystem();
        }}
      />
    </div>
  );
}
