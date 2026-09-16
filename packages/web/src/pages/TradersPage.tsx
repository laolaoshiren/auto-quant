import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ArrowUpRight, MoreHorizontal, Pencil, Play, RotateCw, Square, Trash2 } from 'lucide-react';
import type { TraderStatus } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { useApp, useEvents } from '../lib/store';
import { useSummaries } from '../lib/summaries';
import { committedCapitalOf, groupTradersByAccount } from '../lib/fleetTotals';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { useRunOnce } from '../lib/actions';
import { Button, ErrorNote, Modal, Panel, Spinner3, cn } from '../components/ui';
import { SectionHeading, TraderStatusBadge } from '../components/Badges';
import { Metric, SectionLabel } from '../components/shell';
import { NewTraderModal, StartTraderModal } from '../components/TraderModals';
import { TraderConfigModal } from '../components/TraderConfigModal';
import { NET_PNL_FORMULA, PnlBreakdown, pnlFormulaText, statsCosts, type PnlCosts } from '../components/PnlBreakdown';
import {
  fmtDrawdownPercent,
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
 * 机器人列表。
 *
 * `LAYOUT.md` §0 规则 2 明确说**列表页不套右栏**，内容就是一整张表（也不设最大宽度，见 §2）。
 * 所以这一页只有：页头、一行舰队合计、整宽表格。
 *
 * 之前下半屏空着，是因为表格高度写死 `max-h-[70vh]` 而内容只有几行：面板在
 * 半屏处就结束了，下面是一片页面底色，看起来像页面坏了。现在表格容器**按视口
 * 撑满**（`h-[calc(100vh-22rem)]`），空的地方落在表格内部 —— 那是"表格还有位置"，
 * 而不是"页面到底了"。行高保持一档 `py-2` 的密度。
 *
 * 为什么不换成卡片网格：卡片在只有一两个维护时会排成一行，垂直方向**留白更多**，
 * 想填满就得把卡片拉高 —— 那正是"用大卡片解决空"的老毛病。而且卡片意味着
 * 同一批数字要有第二套渲染和第二个标签词表，列表页没必要付这个代价。
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
  /*
   * ⚠️ 不能把各机器人的「归属权益」求和。
   *
   * 共用同一个交易所账户的机器人，每个人的归属权益里都含**同一笔初始资金**
   * （归属权益 = 初始权益 + 自己的净盈亏 + 自己的浮盈）。求和 = 把同一笔钱
   * 数很多遍 —— 实测三个机器人给出 **30.67**，而钱包里只有 **10.42**，
   * 初始权益被重复计算了 **19.81 USDT**。
   *
   * 首页曾经就是这个错（`OverviewPage` 已修），这里是同一处的另一份实现。
   * 正确的口径：**账户权益每个账户只算一次**（同一账户下所有机器人读的是同一个
   * 钱包余额），账户之间再相加。已实现盈亏是可加的，保持求和。
   *
   * 这一处原来在 tooltip 里写了免责说明来解释"这个合计不等于钱包余额"——
   * 但**把数字改对，比在说明里解释它为什么错要好**。
   */
  const totalEquity = [...groupTradersByAccount(traders).values()].reduce((sum, group) => {
    // 同一账户下所有机器人的 accountEquity 是同一个数（共享钱包），取一个即可。
    const shared = group
      .map((trader) => statsMap[trader.id]?.accountEquity)
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
    return sum + (shared ?? committedCapitalOf(group));
  }, 0);
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
    /*
     * 页面自己负责内边距：外壳（Layout.tsx）刻意不给内容区加 padding —— 两栏页面的
     * 右栏要的是"可视区 − 顶栏"那份确定高度，中间再夹一层边距就说不清了。
     *
     * 也不设 `max-w`：列表页就是**整宽一张表**（LAYOUT.md §0 规则 2 / §2），
     * 宽屏上把空间给表格，不要在两边留白。
     */
    <div className="w-full space-y-3">
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
        舰队合计：**一行紧凑指标，不是四张大卡片**（DESIGN.md §4"不要把所有东西做成一样大"）。
        这一页的主体是下面那张表，四张 `text-2xl` 的卡片会把表格挤下去半屏 ——
        而它们回答的问题（一共几个、跑了几个、总共多少钱）一句话就能说完。
      */}
      <div className="flex flex-wrap items-start gap-x-8 gap-y-2 rounded-lg border border-base-750 bg-base-900/50 px-3.5 py-2.5">
        <Metric
          label="运行中"
          value={
            <>
              {runningCount}
              <span className="text-sm text-ink-faint"> / {traders.length}</span>
            </>
          }
          sub="运行 / 总数"
        />
        <Metric
          label="账户权益合计"
          value={fmtUsd(totalEquity, 2)}
          size="lg"
          tone="strong"
          sub={`${fmtInt(openPositions)} 个未平仓合约`}
          title="按交易所账户合计的权益：同一账户下的多个机器人共用同一个钱包，只算一次；账户之间再相加。表格每一行的「归属权益」是那个机器人自己的贡献。原文：账户里的钱 —— 账户权益见机器人页与交易所凭证页。"
        />
        <Metric
          label="已实现盈亏"
          value={fmtUsdSigned(totalRealized, 2)}
          tone={totalRealized > 0 ? 'up' : totalRealized < 0 ? 'down' : 'default'}
          sub={fleet.known ? <PnlBreakdown costs={fleet.costs} /> : '所有机器人合计'}
          title={`${NET_PNL_FORMULA}。此处为所有机器人已平仓成交的净盈亏合计。`}
        />
        <Metric label="当前持仓" value={fmtInt(openPositions)} sub="所有机器人的未平仓合约数" />
      </div>

      {actionError && <ErrorNote>{actionError}</ErrorNote>}

      <Panel padded={false} bodyClassName="p-0">
        {tradersQuery.loading && traders.length === 0 ? (
          <Spinner3 label="正在加载机器人" />
        ) : traders.length === 0 ? (
          /* 空状态不占位：三行文字说完"现在做什么"，不撑满一屏。 */
          <div className="px-3.5 py-3">
            <p className="text-base text-ink-lo">还没有机器人。</p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">
              先创建一个，再选择模拟或实盘 — 模拟是默认模式，无需交易所密钥即可放心运行。
            </p>
            <Button variant="primary" className="mt-2" onClick={() => setNewOpen(true)}>
              + 新建机器人
            </Button>
          </div>
        ) : (
          <div>
            <SectionLabel
              title="机器人列表"
              count={traders.length}
              className="mb-2 px-3 pt-3"
              actions={
                <Button size="sm" variant="ghost" busy={tradersQuery.loading} onClick={() => void tradersQuery.reload()}>
                  刷新
                </Button>
              }
            />
            {/*
              容器撑满剩余视口高度：行少时下面是表格自己的空白（"还有位置"），
              行多时表体自己滚动，页面不会被顶长。
            */}
            <div className="scroll-x h-[calc(100vh-22rem)] min-h-[16rem] overflow-y-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
                  <tr>
                    <th className="th">机器人</th>
                    <th className="th">状态</th>
                    <th
                      className="th text-right"
                      title="归属权益 = 初始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈。同一账户下其他机器人挣的钱不算在内。"
                    >
                      归属权益
                    </th>
                    <th className="th text-right" title="总收益率 = 归属权益相对起始权益的变化；下面一行是它的构成：净 = 毛 − 手续费 − 资金费。">
                      盈亏
                    </th>
                    <th className="th text-right" title="胜率（winRatePercent，已是 0–100 的百分数）· 盈/亏笔数与盈利因子（∞ = 尚无亏损成交）。">
                      胜率 / PF
                    </th>
                    <th className="th text-right">持仓</th>
                    <th className="th text-right" title="历史最大回撤（账户从高水位回落的最大幅度）。">
                      最大回撤
                    </th>
                    <th className="th text-right" title="已运行时长 / 最近一个决策周期的时间。">
                      运行 / 最近周期
                    </th>
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
                          {/* 整格可点：这一行的职责就是打开这个机器人。名字列有宽度上限，
                              否则一个长名字会把整张表撑到横向滚动。 */}
                          <Link to={`/traders/${trader.id}`} className="group block max-w-[18rem]">
                            <div className="truncate text-base font-semibold text-ink-hi group-hover:text-accent" title={trader.name}>
                              {trader.name}
                            </div>
                            <div className="num truncate text-xs text-ink-faint">
                              #{trader.id} · 周期 {fmtInt(trader.lastCycleNumber)} · 每 {trader.cycleIntervalMinutes}m
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
                          {/*
                            共享钱包单独一行给出。同一个交易所账户下的每个机器人都会
                            显示同一个数 —— 那正是它必须与上面的归属权益分开显示的原因：
                            以前这一个数就是「权益」，于是一个从未成交的机器人显示的是
                            别人挣来的收益率。
                          */}
                          {stats && stats.accountEquity > 0 && (
                            <div
                              className="text-xs text-ink-faint"
                              title="该机器人所属交易所账户（共享钱包）的权益。同一账户下的所有机器人读数是同一个数。"
                            >
                              账户 {fmtUsd(stats.accountEquity, 2)}
                            </div>
                          )}
                        </td>
                        {/*
                          毛 / 净 / PF 三行合成一块（原来分散在「总收益率」和「成交笔数」两列里）：
                          它们是同一个口径下的三个数，分开摆既占宽度又要来回扫。
                          净 first：它才是余额真正发生的变化；毛是它的输入，退一档显示。
                        */}
                        <td className={`td num text-right ${stats ? pnlColor(stats.totalReturnPercent) : ''}`}>
                          {stats ? fmtPercent(stats.totalReturnPercent) : '—'}
                          {stats && (
                            <div
                              className="text-xs text-ink-faint"
                              title={`${pnlFormulaText(statsCosts(stats))}。浮动盈亏 ${fmtUsdSigned(
                                stats.unrealizedPnl,
                                2,
                              )} 未计入本行。`}
                            >
                              净 {fmtUsdSigned(stats.realizedPnl, 2)} · 毛 {fmtUsdSigned(stats.grossRealizedPnl, 2)}
                            </div>
                          )}
                        </td>
                        {/* `winRatePercent` is already 0–100 — never × 100 again.
                            盈/亏是后端给的真实笔数，不由胜率反推。 */}
                        <td className="td num text-right">
                          {stats ? (
                            <>
                              {`${stats.winRatePercent.toFixed(1)}%`}
                              <div
                                className="text-xs text-ink-faint"
                                title={`${fmtInt(stats.totalTrades)} 笔已平仓；盈利因子 ∞ 表示尚无亏损成交。`}
                              >
                                {fmtInt(stats.wins)} 盈 · {fmtInt(stats.losses)} 亏 · PF{' '}
                                {fmtProfitFactor(stats.profitFactor)}
                              </div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="td num text-right">{stats ? fmtInt(stats.openPositions) : '—'}</td>
                        <td className="td num text-right text-down">
                          {stats ? fmtDrawdownPercent(stats.maxDrawdownPercent) : '—'}
                        </td>
                        {/* 运行时长 + 最近周期合成一格：它们是同一个问题的两个方面
                            （还在跑吗、跑到哪了），分两列各占 100px 不值。 */}
                        <td className="td num text-right text-ink-lo">
                          {stats ? fmtDuration(stats.uptimeHours * 60) : '—'}
                          <div className="text-xs text-ink-faint">{timeAgo(trader.lastCycleAt)}</div>
                        </td>
                        <td className="td">
                          {/* 一行、两个常用动作 + 一个溢出菜单。以前这一格把所有动作
                              平铺开，行高被撑起来、宽度也被吃掉。 */}
                          <div className="flex items-center justify-end gap-1">
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
                            <TraderRowMenu
                              trader={trader}
                              onOpen={() => navigate(`/traders/${trader.id}`)}
                              onEdit={() => setEditTarget(trader)}
                              onDelete={() => setPending({ kind: 'delete', trader })}
                            />
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

/* -------------------------------------------------------------------------- */
/*  行的溢出菜单                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 每行一个"更多操作"。
 *
 * 打开面板 / 编辑 / 删除都是低频动作，平铺在行里会把 11 列挤得更紧，而且它们的
 * 存在感与「立即运行」一样强 —— 删除这种危险动作不该和主操作长得一样醒目。
 *
 * 用 Radix Popover 而不是手写的绝对定位 div（DESIGN.md §5）：Esc 关闭、点外部
 * 关闭、焦点管理都已经正确，这里只负责外观 —— 与 `settings/AiModelsSection.tsx`
 * 里的模型选择器同一套做法。
 */
function TraderRowMenu({
  trader,
  onOpen,
  onEdit,
  onDelete,
}: {
  trader: TraderRow;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);

  /** 每个动作做完就收起菜单，否则它会盖住下一行的反馈。 */
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button size="icon" variant="ghost" title="更多操作" aria-label={`${trader.name} 的更多操作`}>
          <MoreHorizontal aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={4}
          role="menu"
          aria-label={`${trader.name} 的操作`}
          className="z-50 w-44 overflow-hidden rounded-md border border-base-600 bg-base-900 py-1 shadow-overlay"
        >
          <RowMenuItem icon={<ArrowUpRight aria-hidden className="h-3.5 w-3.5" />} label="打开面板" onClick={run(onOpen)} />
          <RowMenuItem
            icon={<Pencil aria-hidden className="h-3.5 w-3.5" />}
            label="编辑配置"
            disabled={trader.isRunning}
            title={trader.isRunning ? '请先停止该机器人再修改配置。' : '编辑名称、凭证、模型、策略与周期间隔'}
            onClick={run(onEdit)}
          />
          <RowMenuItem
            icon={<Trash2 aria-hidden className="h-3.5 w-3.5" />}
            label="删除机器人"
            danger
            title={`删除“${trader.name}” — 需要确认`}
            onClick={run(onDelete)}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function RowMenuItem({
  icon,
  label,
  onClick,
  disabled,
  title,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-base transition disabled:cursor-not-allowed disabled:opacity-40',
        danger ? 'text-down hover:bg-down/10' : 'text-ink-mid hover:bg-base-850 hover:text-ink-hi',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
