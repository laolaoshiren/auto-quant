import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { TraderStatus } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { useApp, useEvents } from '../lib/store';
import { useSummaries } from '../lib/summaries';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { useRunOnce } from '../lib/actions';
import { Badge, Button, Empty, ErrorNote, Panel, Spinner3, Stat } from '../components/ui';
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

  const stop = async (trader: TraderRow) => {
    setBusyId(trader.id);
    setActionError(null);
    try {
      await api.stopTrader(trader.id);
      await tradersQuery.reload();
      refreshSystem();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (trader: TraderRow) => {
    if (!window.confirm(`删除“${trader.name}”？其成交、委托与决策记录也会一并删除。`)) return;
    setBusyId(trader.id);
    setActionError(null);
    try {
      await api.deleteTrader(trader.id);
      await tradersQuery.reload();
      refreshSystem();
    } catch (err) {
      setActionError((err as Error).message);
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

  return (
    <div className="space-y-3">
      <SectionHeading
        title="机器人"
        sub="每个机器人 = 一份交易所凭证 + 一个 AI 模型 + 一套策略，按固定间隔循环决策。"
        right={
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            + 新建机器人
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat
          label="运行中"
          value={
            <>
              {runningCount}
              <span className="text-ink-faint"> / {traders.length}</span>
            </>
          }
          sub="运行 / 总数"
        />
        <Stat label="总权益" value={fmtUsd(totalEquity, 2)} sub="所有机器人合计" />
        <Stat
          label="已实现盈亏"
          value={fmtUsdSigned(totalRealized, 2)}
          tone={pnlColor(totalRealized)}
          sub={fleet.known ? <PnlBreakdown costs={fleet.costs} /> : '所有机器人合计'}
          title={`${NET_PNL_FORMULA}。此处为所有机器人已平仓成交的净盈亏合计。`}
        />
        <Stat label="当前持仓" value={fmtInt(openPositions)} sub="未平仓合约数" />
      </div>

      {actionError && <ErrorNote>{actionError}</ErrorNote>}

      <Panel padded={false}>
        {tradersQuery.loading && traders.length === 0 ? (
          <Spinner3 label="正在加载机器人" />
        ) : traders.length === 0 ? (
          <Empty
            message="还没有机器人。"
            hint="先创建一个，再选择模拟或实盘 — 模拟是默认模式，无需交易所密钥即可放心运行。"
          />
        ) : (
          <div className="scroll-x">
            <table className="w-full border-collapse">
              <thead className="border-b border-base-800 bg-base-850/60">
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
                {traders.map((trader) => {
                  const stats = statsMap[trader.id];
                  const live = liveByTrader[trader.id];
                  const status: TraderStatus = live?.status ?? trader.status;
                  return (
                    <tr key={trader.id} className="row-hover">
                      <td className="td">
                        <Link to={`/traders/${trader.id}`} className="group block">
                          <div className="text-xs font-semibold text-ink-hi group-hover:text-accent">{trader.name}</div>
                          <div className="num text-2xs text-ink-faint">
                            #{trader.id} · 周期 {trader.lastCycleNumber} · 每 {trader.cycleIntervalMinutes}m
                          </div>
                        </Link>
                      </td>
                      <td className="td">
                        <TraderStatusBadge status={status} live={trader.isRunning} />
                        {trader.consecutiveFailures > 0 && (
                          <div className="mt-0.5 text-2xs text-warn">{trader.consecutiveFailures} 次连续失败</div>
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
                            className="text-2xs text-ink-faint"
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
                      <td className="td num text-right">{stats ? `${stats.winRatePercent.toFixed(1)}%` : '—'}</td>
                      <td className="td num text-right">
                        {stats ? (
                          <>
                            {fmtInt(stats.totalTrades)}
                            <div className="text-2xs text-ink-faint" title="盈利因子（∞ = 尚无亏损成交）">
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
                          <Button small onClick={() => navigate(`/traders/${trader.id}`)}>
                            打开
                          </Button>
                          {trader.isRunning ? (
                            <>
                              <Button
                                small
                                variant="primary"
                                busy={busyOnceId === trader.id}
                                title="立即强制执行一个决策周期"
                                onClick={() => void runOnce(trader.id, trader.name)}
                              >
                                立即运行
                              </Button>
                              <Button small variant="danger" busy={busyId === trader.id} onClick={() => void stop(trader)}>
                                停止
                              </Button>
                            </>
                          ) : (
                            <Button small variant="success" onClick={() => setStartTarget(trader)}>
                              启动
                            </Button>
                          )}
                          <Button
                            small
                            onClick={() => setEditTarget(trader)}
                            disabled={trader.isRunning}
                            title={trader.isRunning ? '请先停止该机器人再修改配置。' : '编辑配置'}
                          >
                            编辑
                          </Button>
                          <Button small variant="ghost" busy={busyId === trader.id} onClick={() => void remove(trader)}>
                            ✕
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="text-2xs leading-relaxed text-ink-faint">
        启动机器人时总会先执行预检；阻断性失败会以红色显示，并阻止该循环交易。停止是立即生效的。
        {system?.tradingDisabled ? ' 当前服务端已设置 GLOBAL_TRADING_DISABLED，所有启动请求都会被拒绝。' : ''}
      </p>

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
