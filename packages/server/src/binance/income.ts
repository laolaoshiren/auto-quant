/**
 * `/fapi/v1/income` — the account's authoritative income ledger.
 *
 * Every movement that is not an open position's mark-to-market appears here:
 * realised PnL, commission, funding, transfers, referrals. It is the closest
 * thing Binance offers to "what actually happened to my money", which makes it
 * the right source for two jobs the platform cannot do reliably on its own:
 *
 *  1. **Funding fees.** These settle every 8 hours on open positions and are not
 *     part of any fill, so nothing in the order flow reveals them. A position
 *     held across a settlement pays (or receives) money that a fill-based ledger
 *     simply does not see.
 *  2. **Discovering symbols.** A ledger built from locally-booked trades only
 *     knows the symbols it remembers. Income events name every symbol the
 *     account has touched, which is what lets reconciliation notice a position
 *     the platform never recorded at all.
 *
 * The ledger also reconciles exactly to the wallet balance: on the live test
 * account, `REALIZED_PNL 0.347051 + COMMISSION −0.08846734 + TRANSFER 10` equals
 * the reported wallet balance of `10.25858366`. That is a useful property — it
 * means an independent check on the platform's arithmetic is always available.
 */
import type { BinanceRest } from './rest.js';
import type { BinanceIncome } from './types.js';

export interface IncomeSummary {
  /** Gross realised PnL across every symbol. */
  realizedPnl: number;
  /** Commission, as a negative number (Binance reports expenses as negative). */
  commission: number;
  /** Funding, signed: negative when paid, positive when received. */
  fundingFee: number;
  /** Deposits and withdrawals, signed. Excluded from trading performance. */
  transfers: number;
  /**
   * Realised + commission + funding. **Excludes transfers** — a deposit is not
   * profit, and including it would make the account look like a genius on the
   * day it was funded.
   */
  netTradingIncome: number;
  /** Every symbol named by an income event, for reconciliation discovery. */
  symbols: string[];
  byType: Record<string, number>;
}

/** Fetch income events. Binance requires a window and caps it at 7 days per call. */
export async function fetchIncome(
  rest: BinanceRest,
  options: { startTime: number; endTime?: number; symbol?: string; incomeType?: string; limit?: number },
): Promise<BinanceIncome[]> {
  const endTime = options.endTime ?? Date.now();
  const events: BinanceIncome[] = [];

  /*
   * Page forward in 7-day slices. `/fapi/v1/income` silently accepts longer
   * windows but truncates at `limit`, which would look like "no income" rather
   * than "ask for less" — so the slicing is done here deliberately.
   */
  const WINDOW = 7 * 24 * 60 * 60 * 1000;
  let cursor = options.startTime;
  /*
   * ⚠️ 起点必须是数字，否则 `cursor < endTime` 直接把整个循环跳过 ——
   * 于是返回 `[]`，调用方把它读成"这个账户没有流水"。那正是下面那条注释
   * 批评过的形状：**"没读到"伪装成"没有"**。
   */
  if (!Number.isFinite(cursor)) {
    throw new Error(`/fapi/v1/income 的起始时间不是有效数字：${String(options.startTime)}`);
  }
  while (cursor < endTime) {
    const sliceEnd = Math.min(cursor + WINDOW, endTime);
    const page = await rest.signedRequest<BinanceIncome[]>('GET', '/fapi/v1/income', {
      startTime: cursor,
      endTime: sliceEnd,
      ...(options.symbol ? { symbol: options.symbol } : {}),
      ...(options.incomeType ? { incomeType: options.incomeType } : {}),
      limit: options.limit ?? 1000,
    });
    /*
     * ⚠️ **不是数组就抛错，不要当成空。**
     *
     * 这一行原来写的是 `if (Array.isArray(page)) events.push(...page);` ——
     * 一个"响应不是数组"的请求于是**静默变成零条流水**。而
     * `rest.signedRequest()` 在**响应体为空**时正是返回 `undefined`
     * （见 `rest.ts` 的 `if (!text) return undefined as T`）—— 一个 200 加空 body
     * 的网关抽风，看起来和"这个账户什么都没做过"一模一样。
     *
     * 实测代价（部署后立刻撞上）：
     *
     *     22:14:33 ERROR 账目与交易所对不上：平台记录 1.1063 USDT、
     *                    交易所流水 0.0000 USDT，差 1.1063
     *
     * 而同一时刻直接问交易所，同一个窗口是 **58 条、合计 1.10634107** ——
     * 平台记的账一分不差，报错的是**读取**。这条告警的文案是"请先核对再让
     * 机器人继续交易"，也就是它会指着一个完全正确的账本要求人工介入。
     *
     * 抛错之后，`reconcileTradeHistory()` 的 `catch` 会把它记成
     * `incomeReadFailed`，总账校验**整条跳过**（那个标志就是为这件事存在的）。
     */
    if (!Array.isArray(page)) {
      throw new Error(
        `/fapi/v1/income 返回的不是数组（${page === undefined ? '空响应体' : typeof page}）：` +
          `${JSON.stringify(page)?.slice(0, 200)}`,
      );
    }
    events.push(...page);
    cursor = sliceEnd + 1;
  }

  return events;
}

const TRADING_TYPES = new Set(['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE']);

export function summarizeIncome(events: readonly BinanceIncome[]): IncomeSummary {
  const byType: Record<string, number> = {};
  const symbols = new Set<string>();

  for (const event of events) {
    const amount = Number(event.income) || 0;
    byType[event.incomeType] = (byType[event.incomeType] ?? 0) + amount;
    if (event.symbol) symbols.add(event.symbol);
  }

  const realizedPnl = byType.REALIZED_PNL ?? 0;
  const commission = byType.COMMISSION ?? 0;
  const fundingFee = byType.FUNDING_FEE ?? 0;
  const transfers = Object.entries(byType)
    .filter(([type]) => !TRADING_TYPES.has(type))
    .reduce((sum, [, amount]) => sum + amount, 0);

  return {
    realizedPnl,
    commission,
    fundingFee,
    transfers,
    netTradingIncome: realizedPnl + commission + fundingFee,
    symbols: [...symbols].sort(),
    byType,
  };
}

/**
 * Funding paid or received on one symbol between two instants.
 *
 * Attributed to a round-trip by its own lifetime, which is the honest window: a
 * position held from 15:00 to 17:00 that spans a 16:00 settlement pays for that
 * settlement, and one that opens at 16:30 does not.
 */
export function fundingInWindow(
  events: readonly BinanceIncome[],
  symbol: string,
  openedAt: string,
  closedAt: string,
): number {
  const from = new Date(openedAt).getTime();
  const to = new Date(closedAt).getTime();
  return events
    .filter(
      (e) =>
        e.incomeType === 'FUNDING_FEE' &&
        e.symbol === symbol &&
        e.time >= from &&
        e.time <= to,
    )
    .reduce((sum, e) => sum + (Number(e.income) || 0), 0);
}

/**
 * **净盈亏的唯一算式**：`毛 + 手续费 + 资金费`。
 *
 * ## ⚠️ 它是加法，而不是 `毛 − 手续费 − 资金费` —— 这一点是实测纠正过来的
 *
 * 交易所的 `/fapi/v1/income` 把**所有**收支都记为**带符号**的 `income`：
 *
 * ```
 * REALIZED_PNL    +1.51209000     ← 毛利（收入为正）
 * COMMISSION      -0.16117470     ← 手续费（支出为负）
 * FUNDING_FEE     -0.00718777     ← 资金费（支出为负）
 * 三类之和         1.34372753     ← 这就是交易所口径的净额
 * ```
 *
 * 所以"净 = 毛 − 手续费 − 资金费"这个写法**只在一半情况下成立**：
 * 它假设手续费与资金费是**正数**（表示支出），而实际拿到的是**负数**。
 * 于是 `− (−0.00718777)` 把**一笔支出加成了收入**。
 *
 * ## 实测代价：每轮都报一条假的账目告警
 *
 * `#9` 的总账校验每轮都报：
 *
 * ```
 * 账目与交易所对不上：平台记录 1.358103、交易所流水 1.343728，差 0.014376
 * ```
 *
 * 而 `0.00718777 × 2 = 0.01437554` —— **差正好是资金费的两倍**。
 * 用交易所真实窗口（`since` 到当下）复算三类之和是 **1.34372753**，
 * 与 `exchangeNet` 只差 4.7e-7（浮点级）。**平台的账本一直是错的，而错的就是这一项。**
 *
 * ## 为什么把这个算式单独抽出来
 *
 * 修之前，同一个算式在仓库里有**五处**副本（`repositories.ts` 两处、
 * `autoTrader.ts` 三处），于是同一个符号错误也复制了五份。
 * §5.4 说"金额相关的算术只在一个地方算" —— 这就是那条规则的用处。
 */
export function netPnlOf(input: {
  /** 交易所报的**毛**已实现盈亏（`realizedPnl`，收入为正）。 */
  grossPnl: number;
  /** 手续费**合计**（`entryFee + exitFee`，支出为正 —— 与 income 的符号相反）。 */
  fee: number;
  /** 资金费，**交易所口径**：支出为负、收入为正。 */
  fundingFee: number;
}): number {
  return input.grossPnl - input.fee + input.fundingFee;
}

