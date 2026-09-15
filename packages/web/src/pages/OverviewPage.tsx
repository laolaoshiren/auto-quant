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
import { pnlFormulaText, statsCosts } from '../components/PnlBreakdown';
import { fmtClockOffset, fmtInt, fmtPercent, fmtUsd, fmtUsdSigned, pnlColor, timeAgo } from '../lib/format';

/**
 * System overview.
 *
 * Deliberately a dashboard rather than the bot workbench: it shows the live
 * system banner and a five-row snapshot of the fleet, while every per-bot
 * control lives on the dedicated 「机器人」 page.
 */
export function OverviewPage() {
  useDocumentTitle('总览');
  const navigate = useNavigate();
  const user = useApp((s) => s.user);
  const system = useApp((s) => s.system);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const setTraders = useApp((s) => s.setTraders);
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
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { runOnce, busyId: runOnceBusyId } = useRunOnce();

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

  useEffect(() => {
    const timer = window.setInterval(() => void refreshSystem(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshSystem]);

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

  const runningCount = traders.filter((t) => t.isRunning).length;
  const totalEquity = traders.reduce((sum, trader) => sum + (statsMap[trader.id]?.equity ?? trader.initialEquity), 0);
  const totalOpen = traders.reduce((sum, trader) => sum + (statsMap[trader.id]?.openPositions ?? 0), 0);

  return (
    <div className="space-y-4">
      {/* System banner ---------------------------------------------------- */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            系统
            <Badge tone={socketOpen ? 'up' : 'warn'}>{socketOpen ? '实时推送' : '轮询'}</Badge>
          </span>
        }
        actions={
          <span className="num text-2xs text-ink-faint">
            刷新于 {timeAgo(tradersQuery.updatedAt ? new Date(tradersQuery.updatedAt).toISOString() : null)}
          </span>
        }
        bodyClassName="p-3"
        padded={false}
      >
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Stat
            label="环境"
            value={<span className="text-sm">{system?.environmentLabel ?? '—'}</span>}
            sub={system?.environment}
          />
          <Stat
            label="模式"
            value={system?.dryRun ? '模拟' : '实盘资金'}
            tone={system?.dryRun ? 'text-accent' : 'text-warn'}
            sub={system?.tradingDisabled ? '交易已禁用' : '交易已启用'}
          />
          <Stat label="时钟偏移" value={fmtClockOffset(system?.clockOffsetMs)} sub="本地 − 交易所" />
          <Stat
            label="API 权重"
            value={
              <>
                {fmtInt(system?.weightUsed)}
                <span className="text-ink-faint"> / {fmtInt(system?.weightLimit)}</span>
              </>
            }
            sub="当前分钟"
          />
          <Stat label="可交易对" value={fmtInt(system?.tradableSymbols)} sub="USDT-M 永续" />
          <Stat
            label="机器人"
            value={
              <>
                {runningCount}
                <span className="text-ink-faint"> / {traders.length}</span>
              </>
            }
            sub="运行 / 总数"
          />
        </div>

        {system?.tradingDisabled && (
          <div className="mt-3 rounded border border-down/60 bg-down/15 px-3 py-2">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-down">
              ⚠ 全局交易已禁用
            </div>
            <p className="mt-0.5 text-2xs text-down/90">
              服务端已设置 <span className="num">GLOBAL_TRADING_DISABLED</span>。所有启动请求都会返回 HTTP 503
              被拒绝，且无法下任何订单。要恢复交易，请从环境中移除该变量。
            </p>
          </div>
        )}

        {!system && <Spinner3 label="正在读取系统状态" />}
      </Panel>

      {/* Traders snapshot -------------------------------------------------- */}
      <div>
        <SectionHeading
          title="机器人"
          sub={`已配置 ${traders.length} 个 · ${runningCount} 个运行中循环 · ${totalOpen} 个持仓`}
          right={
            <div className="flex items-center gap-2">
              <span className="num text-2xs text-ink-faint">总权益 {fmtUsd(totalEquity, 2)}</span>
              <Link to="/traders" className="btn btn-ghost">
                管理机器人
              </Link>
              <Button variant="primary" onClick={() => setNewOpen(true)}>
                + 新建机器人
              </Button>
            </div>
          }
        />

        {actionError && <ErrorNote className="mb-2">{actionError}</ErrorNote>}

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
                    <th className="th text-right">最大回撤</th>
                    <th className="th text-right">最近周期</th>
                    <th className="th text-right" />
                  </tr>
                </thead>
                <tbody>
                  {traders.slice(0, 5).map((trader) => {
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
                            /* Net leads, gross follows: the difference is the
                               costs, and on a small account the costs are the
                               whole story. */
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
                        <td className="td num text-right text-down">
                          {stats ? `-${stats.maxDrawdownPercent.toFixed(2)}%` : '—'}
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
                                  busy={runOnceBusyId === trader.id}
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

        {traders.length > 5 && (
          <p className="mt-1 text-2xs text-ink-faint">
            仅显示前 5 个机器人 —{' '}
            <Link to="/traders" className="text-accent hover:underline">
              在「机器人」中查看全部 {traders.length} 个
            </Link>
            。
          </p>
        )}

        {tradersQuery.error && <ErrorNote className="mt-2">{tradersQuery.error}</ErrorNote>}

        <p className="mt-2 text-2xs leading-relaxed text-ink-faint">
          欢迎回来，{user?.username}。启动机器人时总会先执行预检；阻断性失败会以红色显示，并阻止该循环交易。
          停止是立即生效的，会取消待执行的周期。
        </p>
      </div>

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
