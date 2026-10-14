import { useEffect, useState, type ReactNode } from 'react';
import { ModeBadge } from '../components/TeamRoster';
import { Link, useNavigate } from 'react-router-dom';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ArrowUpRight, MoreHorizontal, Pencil, Play, RotateCw, Square, Trash2 } from 'lucide-react';
import type { EquitySnapshot, TraderStatus } from '@aq/shared';
import { api, type TraderRow } from '../lib/api';
import { useApp, useEvents } from '../lib/store';
import { useSummaries, type TraderSummary } from '../lib/summaries';
import {
  attributedEquityOf,
  committedCapitalOf,
  fleetTotals,
  groupTradersByAccount,
  isLedgerSuspect,
  realizedPnlOf,
} from '../lib/fleetTotals';
import { pairEquityByTrader } from '../lib/equityPairing';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { useRunOnce } from '../lib/actions';
import { Button, ErrorNote, Modal, Panel, Spinner3, cn } from '../components/ui';
import { SectionHeading, TraderStatusBadge } from '../components/Badges';
import { Metric, SectionLabel } from '../components/shell';
import { PageActions } from '../templates/lib/PageActions';
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
 * 半屏处就结束了，下面是一片页面底色，看起来像页面坏了。现在表格容器**撑满
 * 面板剩下的高度**，空的地方落在表格内部 —— 那是"表格还有位置"，
 * 而不是"页面到底了"。行高保持一档 `py-2` 的密度。
 *
 * ## ⚠️ 为什么是 `flex-1` 而不是 `h-[calc(100vh-22rem)]`
 *
 * 那个算式是**猜**出来的：它假设"页头 + 合计条 + 面板头 + 页脚"正好 22rem。
 * 实际在 1600×1000 下多 79px，在 2564×1225 下多 180px —— 于是表格把页面
 * 顶长，用户必须滚动才能看到最后一行和面板底边，而**下面明明还有空**。
 * 屏幕越高、比例越宽，猜错的量越大。
 *
 * 撑满必须由**布局**算，不能由算式猜：页面 `page-fill`、面板 `flex-1`、
 * 表格体再 `flex-1`，剩下的高度是多少就占多少。这样任何视口、任何一行合计条
 * 换行的情况下都成立。
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

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️ **必须把快照喂给 `fleetTotals`，否则它只能"取最大值"兜底**
   *      （2026-10-14 自查发现我上一轮修得不完整）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 上一轮我把手算的 `.find()` 换成 `fleetTotals({ traders, stats })` ——
   * **但没传 `snapshots`**。而 `fleetTotals` 拿不到快照时会走这条兜底：
   * ```
   *   const fromStats = group.reduce((max, t) => Math.max(max, stats[t.id]?.accountEquity ?? 0), 0);
   * ```
   * 「取组内最大值」在**账户亏损时会把旧的高点当成当前的钱** ——
   * 正是 `latestAccountReading()` 的注释里点明要避免的那种错。
   *
   * 所以这里照搬 `OverviewPage` 的成熟做法（它一直是传快照的）：
   * 两个来源合并 —— REST 的 `traderEquity` + socket 推来的新点。
   *
   * ⚠️ 间隔用 60 秒（不是 `traders` 的 4–8 秒）：快照只在**决策周期结束时**
   * 写一次（分钟级），按列表的节奏轮询等于每个机器人都多花几倍请求去重画同一条线。
   */
  const equityQuery = usePolled<Record<number, EquitySnapshot[]>>(
    async (signal) => {
      const ids = traders.map((t) => t.id);
      const pairs = await Promise.all(
        ids.map(async (id) => ({ id, rows: await api.traderEquity(id, 360, signal) })),
      );
      return pairEquityByTrader(pairs);
    },
    { intervalMs: 60_000, enabled: traders.length > 0, deps: [traders.map((t) => t.id).join(',')] },
  );
  const equitySnapshots: Record<number, EquitySnapshot[]> = {};
  for (const trader of traders) {
    equitySnapshots[trader.id] = [
      ...(equityQuery.data?.[trader.id] ?? []),
      ...(liveByTrader[trader.id]?.equity ?? []),
    ];
  }

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
   * ⚠️⚠️ **不能把各机器人的「归属权益」求和** —— 也**不能**"同账户取第一个"。
   *
   * 共用同一个交易所账户的机器人，每个人的归属权益里都含**同一笔初始资金**
   * （归属权益 = 初始权益 + 自己的净盈亏 + 自己的浮盈）。求和 = 把同一笔钱
   * 数很多遍 —— 实测三个机器人给出 **30.67**，而钱包里只有 **10.42**。
   *
   * ## 2026-10-14 修：这里原来取的是"第一个有效读数"，而不是"最新的"
   *
   * 原实现：
   * ```
   *   const shared = group
   *     .map((trader) => statsMap[trader.id]?.accountEquity)
   *     .find((value) => ...);       // ← find 取【第一个】，不是最新
   * ```
   * `group` 按 id 排序，于是**取到了 id 最小那台机器人的快照** ——
   * 而它可能是**几周前**的。线上实测（账户 #2 挂着 #9 与 #11）：
   * ```
   *   #9  accountEquity = 20.8585 @2026-10-03  ← 43 天前（旧）
   *   #11 accountEquity = 20.7519 @2026-10-13  ← 最新
   *   → find() 取 #9 的 20.8585 → 合计 114.97
   *   → 正确（取最新）        → 合计 114.86
   * ```
   * 用户看到的就是这个："盈亏计算有问题，和实际对不上"。
   *
   * ## 根治：改用 `fleetTotals()`，而不是在这里手算第二遍
   *
   * `fleetTotals.ts` 里已经有正确的 `latestAccountReading()`（**取时间最新**）——
   * 而这里手算了一遍、且算错了。**同一个算术写在两个地方，改一处等于没改**
   *（`docs/MAINTENANCE.md` §3.4 记的就是这一类）。
   * 所以不再"修对这份手算"，而是**让它调用共享库**。
   */
  const fleetTotal = fleetTotals({
    traders,
    stats: statsMap,
    snapshots: equitySnapshots,
    /*
     * ⚠️ `dryRun` 要传进来 —— 模拟盘上 exchangeNet 恒为 0，
     * 拿它校准会把正确的账本替换成 0（见 `isLedgerSuspect`）。
     */
    dryRun: Object.fromEntries(
      traders.map((t) => [t.id, statsMap[t.id]?.dryRun ?? null]),
    ),
  });
  const totalEquity = fleetTotal.accountEquityFleet;
  /** 读数已过期的账户（机器人全停了 → 没有新快照）。见上面那个 Metric 的说明。 */
  const staleAccounts = fleetTotal.accounts.filter((a) => a.accountEquityStale);
  /*
   * WARNING: 这三个函数已移到 lib/fleetTotals.ts（2026-10-14）。
   *
   * 原因：用户报「你做事情只做一半？？」—— 同一个"账本 vs 交易所"的判据
   * 原先散在四个地方（本页两处、首页一处、详情页一处），我上一轮只修了
   * 其中两处，首页就漏了。根因是判据被复制了四份。
   *
   * 现在它们是共享库里的单一实现：
   *   isLedgerSuspect    -> fleetTotals.isLedgerSuspect(ledger)
   *   realizedPnlOf      -> fleetTotals.realizedPnlOf(trader, stats)
   *   attributedEquityOf -> fleetTotals.attributedEquityOf(trader, stats)
   *
   * 共享版比原来多两道判据：
   *   · incomeReadFailed 为真时不校准 —— 那时 exchangeNet 是残缺读数；
   *   · **模拟盘（dryRun）一律不校准**（2026-10-15 加）—— 那时 exchangeNet 恒为 0，
   *     拿它校准会把正确的账本替换成 0。见 `isLedgerSuspect` 的事故说明。
   */
  const dryRunOf = (id: number): boolean | null | undefined => statsMap[id]?.dryRun;

  const equityOf = (trader: TraderRow, stats: TraderSummary): number =>
    attributedEquityOf(trader, stats, dryRunOf(trader.id));

  const calibratedOf = (
    trader: TraderRow,
    stats: TraderSummary,
  ): { realizedPnl: number; returnPercent: number } => {
    const realizedPnl = realizedPnlOf(trader, stats, dryRunOf(trader.id));
    const returnPercent =
      trader.initialEquity > 0 ? (realizedPnl / trader.initialEquity) * 100 : 0;
    return { realizedPnl, returnPercent };
  };

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **顶部汇总也必须用同一套校准**（2026-10-14 用户报"只做一半"）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事实（线上）
   *
   * ```
   *   顶部「已实现盈亏」显示  +5.91（账本合计）
   *   交易所口径真实          -7.03
   *   → 差 12.9 USDT（显示盈利，实际亏损）
   * ```
   *
   * ## 为什么这里要用 `calibratedOf`
   *
   * 它是**逐机器人**的校准（与本页表格那一列、详情页「交易盈亏」同一个判据）——
   * 然后**求和**。这样：
   * ```
   *   顶部合计 = 各行之和（用户能自己加出来）
   *   与本页每一行、与详情页三处一致
   * ```
   * ⚠️ 直接对 `equityOf` 求和是**错的**（共享账户会把本金数多遍，见 `fleetTotals`）；
   * 而净已实现盈亏是可加的 —— 所以这一项可以求和。
   */
  const totalRealized = traders.reduce(
    (sum, trader) => {
      const s = statsMap[trader.id];
      return sum + (s ? calibratedOf(trader, s).realizedPnl : 0);
    },
    0,
  );
  const openPositions = traders.reduce((sum, trader) => sum + (statsMap[trader.id]?.openPositions ?? 0), 0);

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️ **账本不可信时，归属权益改用交易所校准值**（2026-10-14）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 用户的原话
   *
   * > 「和里面数据不一致为什么还没修复？……列表和详情要正确对齐数字，
   * >   别整无意义的垃圾数据」
   *
   * ## 事实（线上 `#10`）
   *
   * ```
   *   列表页「归属权益」  $104.89  ← 起始 100.05 + trades.net_pnl +4.84（账本推算）
   *   详情页「账户余额」  $92.34   ← 交易所真实读数
   *   差 12.56
   * ```
   * 差额的来源：`trades.net_pnl` **被对账重建写坏了** ——
   * 39 笔 `source='reconciled'` 的记录里 16 笔 `pnl=0`（本该有盈亏），合计虚高 9.13。
   *
   * ## 为什么必须在这里修，而不是加说明
   *
   * 我上一轮只是在指标卡加了一行「账目与交易所差 +12.55」—— **那是错的**。
   * 本项目反复记着同一条原则：
   * > **「把数字改对，比在说明里解释它为什么错要好。」**
   *
   * ## 判据与详情页**完全一致**（`TraderPage` 的 `realized = ledger.exchangeNet`）
   *
   * ```
   *   ledger.gap 超容差（≥ 0.01）→ 用交易所的成交流水（exchangeNet）为准
   *   否则                        → 用账本（它与交易所一致，没必要绕）
   * ```
   * ⚠️ **同一个判据写在两个页面**是有意的（而不是各自发明一套）：
   * 两个页面必须给出同一个数，而"同一个数"的唯一保证是**同一套判据**。
   * 阈值 0.01 与详情页的 `ledgerSuspect` 一字不差 —— 改一处必须改两处。
   */

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
    <div className="page-fill w-full gap-3">
      <SectionHeading
        title="机器人"
        sub="每个机器人 = 一份交易所凭证 + 一个 AI 模型 + 一套策略，按固定间隔循环决策。"
        right={
          /*
           * 动作走**统一接口**（`templates/lib/PageActions.tsx`）：
           *
           *   · 控制台模板有工具栏 → 这两个按钮被 portal 进那条 40px 的带子，
           *     位置固定、永远可见，破坏性的「新建」靠右；
           *   · 经典模板没有工具栏 → **就地渲染**，也就是这一行原来的样子。
           *
           * 页面只说"有什么动作"，不说"放哪"。两种模板下渲染的是同一批按钮，
           * 所以切模板不会丢功能。
           */
          <PageActions
            end={
              <Button variant="primary" onClick={() => setNewOpen(true)}>
                + 新建机器人
              </Button>
            }
          />
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
          /*
           * ⚠️ **读数过期时必须说出来**（2026-10-14）。
           *
           * 快照在每次决策周期结束时写一条。若某账户下的机器人**全都停了**，
           * "最新快照"也可能是几周前的 —— 而那个数字**看起来和实时值一模一样**。
           * `#9` 就是这种情况：停了 10 天、快照是 43 天前的。
           *
           * 判据来自 `fleetTotals` 的 `accountEquityStale`（> 60 分钟）。
           * 有任何一个账户过期，这里就标出来 —— 而不是让操作员以为它是实时的。
           */
          sub={
            staleAccounts.length > 0
              ? `⚠️ ${staleAccounts.length} 个账户的读数已过期（机器人未在运行）`
              : `${fmtInt(openPositions)} 个未平仓合约`
          }
          title={
            staleAccounts.length > 0
              ? `⚠️ 其中 ${staleAccounts.map((a) => `#${a.exchangeAccountId}`).join('、')} 的权益读数是**旧的** —— ` +
                '那些账户下的机器人都不在运行，所以没有新快照。这个数字是最后一次读到的值，不代表现在的钱包。'
              : '按交易所账户合计的权益：同一账户下的多个机器人共用同一个钱包，只算一次；账户之间再相加。表格每一行的「归属权益」是那个机器人自己的贡献。'
          }
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

      <Panel
        padded={false}
        /*
         * 面板撑满页面剩余高度，表格体再撑满面板剩余高度（见下面 `flex-1`）。
         * `min-h-0` 是必须的：flex 子项默认 `min-height:auto`，不加它表格会被
         * 内容顶高、永远不产生内部滚动条，`flex-1` 就白写了。
         */
        className="flex min-h-0 flex-1 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col p-0"
      >
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
                <PageActions
                  start={
                    <Button size="sm" variant="ghost" busy={tradersQuery.loading} onClick={() => void tradersQuery.reload()}>
                      刷新
                    </Button>
                  }
                />
              }
            />
            {/*
              容器撑满剩余视口高度：行少时下面是表格自己的空白（"还有位置"），
              行多时表体自己滚动，页面不会被顶长。
            */}
            <div className="scroll-x min-h-[16rem] flex-1 overflow-y-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
                  <tr>
                    <th className="th">机器人</th>
                    <th className="th">状态</th>
                    <th
                      className="th text-right"
                      title={
                        '归属权益 = 起始权益 + 本机器人净已实现盈亏 + 本机器人持仓浮盈。' +
                        '同一账户下其他机器人挣的钱不算在内。' +
                        '⚠️ 当平台账本与交易所对不上时（`ledger.gap`），这一列改用交易所的' +
                        '成交流水校准 —— 否则账本里记错的笔数会让它虚高，而那个数字' +
                        '与详情页的「账户余额」对不上。'
                      }
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
                            <div className="flex items-center gap-1.5">
                              <span
                                className="truncate text-base font-semibold text-ink-hi group-hover:text-accent"
                                title={trader.name}
                              >
                                {trader.name}
                              </span>
                              {/*
                                ⚠️ **模式徽章**（用户 2026-10-12 要求）。

                                原话：「既然现在有 3 种模式了（普通、智能、团队），
                                那么 **UI 上面也要加上相应的显示**」。

                                在此之前列表里**看不出模式区别** —— 用户截图里三台机器人
                                只有名字和数字不同，看不出哪台是团队模式。
                                而三种模式的**行为差别极大**（团队模式背后是一支分工的智能体队伍），
                                列表作为第一落点必须能一眼分辨。
                              */}
                              <ModeBadge mode={trader.mode} />
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
                          {/*
                            ══════════════════════════════════════════════════════════
                            ⚠️⚠️ **这一格原来并列两个互相矛盾的数**（2026-10-14 用户报）
                            ══════════════════════════════════════════════════════════

                            ## 用户的原话

                            > 「和里面数据不一致为什么还没修复？图3上面那个数字到底是啥意思？
                            >   别画蛇添足，列表和详情要正确对齐数字，别整无意义的垃圾数据」

                            ## 原来显示什么（图3）

                            ```
                              $104.89        ← 归属权益（本地账本推算）
                              账户 $92.34    ← 交易所真实权益
                            ```
                            两个数差 12.56，而**没有任何解释**。用户看到两个数并列，
                            第一反应是"到底哪个是我的钱"。

                            ## 为什么上面那个是错的

                            ```
                              归属权益 = 起始权益 + trades.net_pnl + 浮盈
                              而 trades.net_pnl 【被对账重建写坏了】：
                                39 笔 source='reconciled' 的记录里 16 笔 pnl=0
                                （本该有盈亏），合计虚高 9.13
                              → 归属权益 104.89 而账户真实 92.34
                            ```
                            ⚠️ 这正是本项目反复说的那条原则：
                            **「把数字改对，比在说明里解释它为什么错要好」** ——
                            我上一轮只是在指标卡加了一行「账目与交易所差 +12.55」的说明，
                            **那是错的**：说明不能替代正确的数字。

                            ## 修法：用交易所校准值（与详情页同一个口径）

                            详情页早就这么做了（`TraderPage` 的 `realized = ledger.exchangeNet`）：
                            ```
                              ledger.gap 超容差 → 用交易所的成交流水（exchangeNet）为准
                              否则           → 用账本（它与交易所一致，没必要绕）
                            ```
                            这里复刻同一个判据，于是**列表页与详情页给出同一个数**。

                            ## 为什么不再并列显示「账户」

                            那个小字原本是为了区分"归属"与"账户钱包"两个概念。
                            但在**账本不可信**时，那个区分传达的不是信息而是困惑 ——
                            用户要的是"这个机器人有多少钱"，而那应该是**一个**数。
                            共享钱包的事实仍由上面「账户权益合计」那张卡表达
                            （它按账户去重，那才是它该在的地方）。
                          */}
                          {stats ? fmtUsd(equityOf(trader, stats), 2) : '—'}
                          {/*
                            ══════════════════════════════════════════════════════════
                            ⚠️ **这里不能写行话**（2026-10-14 用户报）
                            ══════════════════════════════════════════════════════════

                            ## 用户的原话

                            > 「『账本有差 · 已按交易所校准』什么鬼意思？这是做给人看的？」

                            **他说得对**：`账本` / `交易所校准` 是我们内部的词，
                            而这一行面对的是操作员 —— 他关心的不是"我怎么算的"，
                            而是**"这个数准不准"**。

                            ## 措辞的选择

                            ```
                            ✗ 账本有差 · 已按交易所校准    ← 内部词，且像一句警告
                            ✓ 按交易所实际成交计            ← 说明"这个数从哪来"
                            ```
                            ⚠️ 用 `text-ink-faint` 而不是之前的 `text-warn`：
                            这是**口径说明**，不是"出问题了" ——
                            用警示色会让操作员以为账目坏了（而它恰恰是**更准**的那个数）。

                            ⚠️ 详细原因保留在 `title` 里（想深究的人能查到），
                            但**可见的那一行只放结论**。
                          */}
                          {stats && isLedgerSuspect(trader.ledger) && (
                            <div
                              className="text-xs text-ink-faint"
                              title={
                                '这个数按交易所的实际成交算，不是按平台自己的记录 —— ' +
                                `平台记录与交易所差 ${fmtUsdSigned(trader.ledger!.gap, 4)}（平台有几笔记错了）。` +
                                '详情页的「交易盈亏」用的是同一个数。'
                              }
                            >
                              按交易所实际成交计
                            </div>
                          )}
                        </td>
                        {/*
                          毛 / 净 / PF 三行合成一块（原来分散在「总收益率」和「成交笔数」两列里）：
                          它们是同一个口径下的三个数，分开摆既占宽度又要来回扫。
                          净 first：它才是余额真正发生的变化；毛是它的输入，退一档显示。
                        */}
                        <td className={`td num text-right ${stats ? pnlColor(calibratedOf(trader, stats).returnPercent) : ''}`}>
                          {/*
                            ══════════════════════════════════════════════════════════
                            ⚠️⚠️ **这一列也必须用交易所校准值**（2026-10-14 用户报）
                            ══════════════════════════════════════════════════════════

                            ## 用户的原话

                            > 「盈亏计算也不对啊！！！你做事情只做一半？？」

                            ## 事实（线上 `#10`）

                            ```
                              列表页显示  +5.65%（账本：净 +5.66）
                              交易所真实   -6.99%（净 -7.00）
                              → 差 12.6 个百分点：【显示盈利，实际亏损】
                            ```
                            而"归属权益"那一格我上一轮已经校准过了 ——
                            **同一行里两个数用两套口径**，那就是"只做一半"。

                            ## 根因：`stats.totalReturnPercent` 是服务端按**坏账本**算的

                            ```
                              repositories.ts:4209
                                totalReturnPercent = (equityNow − initial) / initial × 100
                              而 equityNow 用了 trades.net_pnl（对账重建写坏的那份）
                            ```

                            ## 修法：整行的收益率 / 净额 / 颜色都从**同一个校准值**派生

                            ```
                              校准后的净额 = ledger.exchangeNet（账本可信时用账本）
                              校准后的收益率 = 校准净额 / 起始权益 × 100
                            ```
                            ⚠️ **必须整行一致**：只改收益率而留下面的净额，就是同一个错的另一面。
                          */}
                          {stats ? fmtPercent(calibratedOf(trader, stats).returnPercent) : '—'}
                          {stats && (
                            <div
                              className="text-xs text-ink-faint"
                              title={
                                (isLedgerSuspect(trader.ledger)
                                  ? '平台账本与交易所的成交流水对不上，所以这一行改用**交易所**的流水校准。'
                                  : `${pnlFormulaText(statsCosts(stats))}。`) +
                                `浮动盈亏 ${fmtUsdSigned(stats.unrealizedPnl, 2)} 未计入本行。`
                              }
                            >
                              净 {fmtUsdSigned(calibratedOf(trader, stats).realizedPnl, 2)} · 毛{' '}
                              {fmtUsdSigned(stats.grossRealizedPnl, 2)}
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
                                  /*
                                   * ⚠️ 文案是「立即分析」，**不是「立即运行」**。
                                   *
                                   * 它做的是"强制执行一个决策周期"（跑一轮分析、可能下单），
                                   * 而旧名字读起来像"启动这台机器人"。详情页早就改了
                                   * （`TraderPage.tsx` 那段注释写着「旧名字『立即运行』把
                                   * 这两件事混成一件」），这一页和总览页当时漏了。
                                   *
                                   * 总览页那个**已经删除**（那里和「停止」并排放着，看起来
                                   * 就是一对启动/停止开关，而且总览页本来就不该放这个动作）。
                                   * 这一页保留：每行一台机器、用来快速跑一轮，位置合理 ——
                                   * 错的只是名字。
                                   */
                                  title="立即分析一次：强制执行一个决策周期，不等间隔。它不会启动机器人 —— 要开始交易请用「启动」。"
                                  onClick={() => void runOnce(trader.id, trader.name)}
                                >
                                  <RotateCw aria-hidden className="h-3.5 w-3.5" />
                                  立即分析
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
