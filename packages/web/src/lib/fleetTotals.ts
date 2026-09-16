/**
 * 舰队级（全部机器人 / 全部交易所账户）合计的**唯一**计算点。
 *
 * ## 为什么要单独一个模块
 *
 * 「账户里有多少钱」和「某个机器人挣了多少」是两个不同的量。它们混在一起时，
 * 共享钱包的同一笔本金会被数很多遍（下面就是实盘量到的数字）。这两个口径的
 * 算术只在这里算一次，页面只负责展示 —— 与「净盈亏只在 `trades.insert()` 里算
 * 一次」是同一个理由（`docs/AGENTS.md` §5.4：金额相关的算术只在一个地方算）。
 *
 * ## 为什么**不能**把归属权益（`TraderStats.equity`）加起来
 *
 * 这是本次修掉的 bug。实盘上量到的数字（三个机器人共用 `exchange_account_id = 1`）：
 *
 * ```
 * #4 测试机器人1    初始 9.9865   本机器人净盈亏 0.000000  → 归属权益  9.9865
 * #5 测试2          初始 9.9865   本机器人净盈亏 0.437526  → 归属权益 10.4240
 * #6 实盘3小时验证  初始 10.2586  本机器人净盈亏 0.000000  → 归属权益 10.2586
 * ──────────────────────────────────────────────────────────────────────────
 * Σ 归属权益 = 30.6690        Σ 初始权益 = 30.2316        账户里实际只有 10.4180
 * ```
 *
 * `Σ 初始权益 − 账户里的钱 = 19.81 USDT`，**就是被数了三遍的那笔本金**（三个机器人
 * 各自都带着同一份起始资金，而钱包只有一个）。于是控制台显示「总归属权益 30.67 USDT」
 * 与「总收益率 +1.45% / 初始投入 $30.23」—— 约为真实资金的 3 倍。
 *
 * 归属权益是**每个机器人**自己的量，它自带一份本金（`初始权益 + 本机器人净盈亏 +
 * 本机器人浮盈`，见 `attributedEquity()`）。共用同一个账户的机器人各自都带着同一笔
 * 本金，所以只有「**每个账户**算一次」才有意义 —— 不是「取第一个」，
 * 而是按 `exchangeAccountId` 分组（不同账户的钱包互不相干，跨账户相加才是对的）。
 *
 * 反过来，**已实现盈亏是可加的**：每个机器人只认自己挂过的订单对应的回合
 * （`docs/AGENTS.md` §2.3 的归属闸门），所以 `Σ(各机器人自己的 net_pnl)` 不会重复。
 */

import type { EquitySnapshot, TraderStats } from '@aq/shared';
import type { TraderRow } from './api';
import type { EquityContributor } from '../components/equityCurve';

/* -------------------------------------------------------------------------- */
/*  按账户分组                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 把机器人按交易所账户分组。
 *
 * 这是整个文件的地基：凡是"账户里的钱"都必须先过这一步，否则共享账户下的
 * 每个机器人都会各自贡献一份本金（19.81 那个 bug 就是这么来的）。
 */
export function groupTradersByAccount(traders: readonly TraderRow[]): Map<number, TraderRow[]> {
  const groups = new Map<number, TraderRow[]>();
  for (const trader of traders) {
    const group = groups.get(trader.exchangeAccountId);
    if (group) group.push(trader);
    else groups.set(trader.exchangeAccountId, [trader]);
  }
  return groups;
}

/**
 * 一个账户的**起始资金**（本金）。
 *
 * 取**最早创建**的那个机器人的 `initialEquity`：它建号时服务端从交易所读到的
 * 钱包余额，就是这个账户被接入监控时的样子（`EquitySource: 'exchange'`）。
 * 后面的机器人读到的余额已经包含了前面机器人的盈亏，把它们的 `initialEquity`
 * 相加就是把同一笔本金数很多遍 —— 那正是本文件顶部那个 3 倍的 bug。
 *
 * 读不到余额时（`EquitySource: 'unavailable'`，早期行可能是 0）退回组内最大的
 * 正值：显示一个偏大的本金也胜过显示 0（后者会让收益率除零或凭空变成无限大）。
 */
export function committedCapitalOf(group: readonly TraderRow[]): number {
  const earliest = [...group].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id,
  )[0];
  if (earliest && Number.isFinite(earliest.initialEquity) && earliest.initialEquity > 0) {
    return earliest.initialEquity;
  }

  const positives = group
    .map((trader) => trader.initialEquity)
    .filter((value) => Number.isFinite(value) && value > 0);
  return positives.length > 0 ? Math.max(...positives) : 0;
}

/* -------------------------------------------------------------------------- */
/*  合计                                                                       */
/* -------------------------------------------------------------------------- */

/** 账户权益是从哪来的 —— 页面据此说明这个数是读数还是推算。 */
export type AccountEquitySource =
  /** 该账户最新一条快照里交易所读到的 `accountEquity`。 */
  | 'snapshot'
  /** 服务端统计里的同一个字段（快照序列还没到）。 */
  | 'stats'
  /** 两边都没有：用「起始资金 + Σ 本机器人净盈亏 + Σ 本机器人浮盈」推算。 */
  | 'derived'
  /** 连起始资金都读不到（还没跑过一轮、也没有余额读数）—— 页面显示 `—`。 */
  | 'capital';

/** 一个交易所账户（共享钱包）的合计。 */
export interface FleetAccount {
  exchangeAccountId: number;
  /** 该账户下的机器人 id（按传入顺序）。 */
  traderIds: number[];
  /**
   * 账户里的钱。**每个账户只算一次** —— 同账户下的机器人读的是同一个钱包。
   */
  accountEquity: number;
  equitySource: AccountEquitySource;
  /** 该账户的起始资金（本金），见 `committedCapitalOf`。 */
  committedCapital: number;
  /** 该账户下各机器人自己的净已实现盈亏之和（可加）。 */
  realizedPnl: number;
  /** 各机器人自己的持仓浮盈之和（可加）。 */
  unrealizedPnl: number;
  openPositions: number;
  wins: number;
  losses: number;
  /**
   * 该账户下各机器人归属权益之和。
   *
   * ⚠️ **它不是账户里的钱**，也不参与任何合计 —— 保留它只为让页面能说清
   * "被多算了多少"（实测：这个账户 30.6690 vs 账户里 10.4180）。
   */
  attributedEquitySum: number;
}

export interface FleetTotals {
  accounts: FleetAccount[];
  /** traderId → 它所属账户的合计，供表格每一行直接引用，免得再分组一次。 */
  byTrader: Record<number, FleetAccount>;

  /** 账户口径的权益合计：**每个账户算一次再相加**。 */
  accountEquityFleet: number;
  /** 账户口径的起始资金合计。 */
  committedCapitalFleet: number;
  /** 账户口径的总收益率（0–100 的百分数；本金为 0 时是 0）。 */
  accountReturnPercent: number;

  /** Σ 各机器人自己的净已实现盈亏 —— 可加，和账户口径无关。 */
  realizedPnlFleet: number;
  unrealizedPnlFleet: number;
  openPositionsFleet: number;
  winsFleet: number;
  lossesFleet: number;

  traderCount: number;
  /** 统计已经回来的机器人数，用于「正在读取 N 个机器人的统计…」。 */
  tradersWithStats: number;
  /**
   * Σ 归属权益。**只能拿来说明"它不等于账户里的钱"**，页面上不得当作余额。
   */
  attributedEquitySumFleet: number;
}

export interface FleetInputs {
  traders: readonly TraderRow[];
  stats: Record<number, TraderStats>;
  /**
   * 每个机器人的快照序列（REST 与 socket 已经合并），只用来读**交易所给的**
   * 账户权益。缺省时退回 `TraderStats.accountEquity`。
   */
  snapshots?: Record<number, EquitySnapshot[]>;
}

/**
 * 该账户最新一次的**账户权益读数**。
 *
 * 同一账户下所有机器人的 `accountEquity` 都是同一个钱包，区别只在读数的时间；
 * 所以这里取**时间最新的那一条快照**，而不是相加、也不是取最大值 —— 取最大值
 * 在账户亏损时会把旧的高点当成当前的钱。
 */
function latestAccountReading(
  group: readonly TraderRow[],
  snapshots: Record<number, EquitySnapshot[]> | undefined,
): number | null {
  let newestAt = Number.NEGATIVE_INFINITY;
  let newestValue: number | null = null;
  if (snapshots) {
    for (const trader of group) {
      for (const snapshot of snapshots[trader.id] ?? []) {
        // 0 表示"这一行没有读到账户权益"（旧行或读取失败），不是"账户里没钱"。
        if (!(snapshot.accountEquity > 0)) continue;
        const at = Date.parse(snapshot.timestamp);
        if (!Number.isFinite(at) || at <= newestAt) continue;
        newestAt = at;
        newestValue = snapshot.accountEquity;
      }
    }
  }
  return newestValue;
}

/** 舰队合计。见本文件顶部：账户口径与机器人归属口径在这一处分开。 */
export function fleetTotals({ traders, stats, snapshots }: FleetInputs): FleetTotals {
  const accounts: FleetAccount[] = [];
  const byTrader: Record<number, FleetAccount> = {};

  let accountEquityFleet = 0;
  let committedCapitalFleet = 0;
  let realizedPnlFleet = 0;
  let unrealizedPnlFleet = 0;
  let openPositionsFleet = 0;
  let winsFleet = 0;
  let lossesFleet = 0;
  let tradersWithStats = 0;
  let attributedEquitySumFleet = 0;

  for (const [exchangeAccountId, group] of groupTradersByAccount(traders)) {
    let realizedPnl = 0;
    let unrealizedPnl = 0;
    let openPositions = 0;
    let wins = 0;
    let losses = 0;
    let attributedEquitySum = 0;

    for (const trader of group) {
      const row = stats[trader.id];
      if (row) tradersWithStats += 1;
      realizedPnl += row?.realizedPnl ?? 0;
      unrealizedPnl += row?.unrealizedPnl ?? 0;
      openPositions += row?.openPositions ?? 0;
      wins += row?.wins ?? 0;
      losses += row?.losses ?? 0;
      // 还没有统计时退回该机器人的起始权益：宁可显示"已知的本金"，
      // 也不要让这一格在第一帧读成 0（页面随后会被统计覆盖）。
      attributedEquitySum += row?.equity ?? trader.initialEquity;
    }

    const committedCapital = committedCapitalOf(group);

    /*
     * 账户权益的三个来源，按可信度排序。
     *
     * 「起始资金 + Σ 本机器人净盈亏 + Σ 本机器人浮盈」这条推算与归属权益用的是
     * 同一个恒等式，只是**本金只取一次** —— 这正是它和 Σ归属权益 的区别。
     */
    let accountEquity = latestAccountReading(group, snapshots);
    let equitySource: AccountEquitySource = 'snapshot';

    if (accountEquity === null) {
      const fromStats = group.reduce(
        (max, trader) => Math.max(max, stats[trader.id]?.accountEquity ?? 0),
        0,
      );
      if (fromStats > 0) {
        accountEquity = fromStats;
        equitySource = 'stats';
      }
    }

    if (accountEquity === null && committedCapital > 0) {
      accountEquity = committedCapital + realizedPnl + unrealizedPnl;
      equitySource = 'derived';
    }

    if (accountEquity === null) {
      // 连本金都没有：这个账户还没有任何可信读数。0 在这里的含义是"未知"，
      // 页面据此显示 `—`，不要把它渲染成"账户是空的"（LAYOUT.md §7）。
      accountEquity = committedCapital;
      equitySource = 'capital';
    }

    const account: FleetAccount = {
      exchangeAccountId,
      traderIds: group.map((trader) => trader.id),
      accountEquity,
      equitySource,
      committedCapital,
      realizedPnl,
      unrealizedPnl,
      openPositions,
      wins,
      losses,
      attributedEquitySum,
    };
    accounts.push(account);
    for (const trader of group) byTrader[trader.id] = account;

    accountEquityFleet += accountEquity;
    committedCapitalFleet += committedCapital;
    realizedPnlFleet += realizedPnl;
    unrealizedPnlFleet += unrealizedPnl;
    openPositionsFleet += openPositions;
    winsFleet += wins;
    lossesFleet += losses;
    attributedEquitySumFleet += attributedEquitySum;
  }

  return {
    accounts,
    byTrader,
    accountEquityFleet,
    committedCapitalFleet,
    accountReturnPercent:
      committedCapitalFleet > 0
        ? ((accountEquityFleet - committedCapitalFleet) / committedCapitalFleet) * 100
        : 0,
    realizedPnlFleet,
    unrealizedPnlFleet,
    openPositionsFleet,
    winsFleet,
    lossesFleet,
    traderCount: traders.length,
    tradersWithStats,
    attributedEquitySumFleet,
  };
}

/* -------------------------------------------------------------------------- */
/*  账户口径的权益曲线                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 把「每机器人一份快照」重排成「每账户一份」的贡献者，交给 `mergeEquityCurves`。
 *
 * 每个账户只贡献**一条序列**：把该账户下所有机器人的快照合并成一条时间线，
 * 每条快照的金额换成交易所给的 `accountEquity`（共享钱包权益）。同账户下的
 * 机器人读数是同一个数，所以"桶对齐后取最近一条"就是正确做法；`mergeEquityCurves`
 * 随即将**账户之间**求和 —— 不同账户是不同的钱包，跨账户相加才是对的，
 * 错的是把同一个钱包数 N 遍（本文件顶部那 19.81）。
 *
 * `baseline` 用该账户的起始资金，于是曲线在第一条快照之前是一条平线，
 * 而不是从 0 开始 —— 也不会是"三个机器人的本金之和"。
 *
 * 两个字段在账户口径下没有意义，因此明确置空而不是沿用某个机器人的值：
 * `openPositions` 是**本机器人**的持仓数（账户口径下应看交易所的净持仓，
 * 不是把各机器人的持仓相加）；浮盈换成账户的总浮盈 `accountUnrealizedPnl`。
 */
export function accountEquityContributor(
  traders: readonly TraderRow[],
  snapshots: Record<number, EquitySnapshot[]>,
): EquityContributor {
  const series: Record<number, EquitySnapshot[]> = {};
  const baseline: Record<number, number> = {};

  for (const [exchangeAccountId, group] of groupTradersByAccount(traders)) {
    const timeline: EquitySnapshot[] = [];
    for (const trader of group) {
      for (const snapshot of snapshots[trader.id] ?? []) {
        // 见 `latestAccountReading`：0 是"没读到"，画进曲线会把账户拉到底。
        if (!(snapshot.accountEquity > 0)) continue;
        timeline.push({
          ...snapshot,
          equity: snapshot.accountEquity,
          unrealizedPnl: snapshot.accountUnrealizedPnl,
          openPositions: 0,
        });
      }
    }
    if (timeline.length > 0) series[exchangeAccountId] = timeline;
    baseline[exchangeAccountId] = committedCapitalOf(group);
  }

  return { series, baseline };
}
