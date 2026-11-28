/**
 * 成交历史重建与总账对账模块（从 `autoTrader.ts` 阶段 2b 纯搬抽出，行为零变化）：
 * - 按 `/fapi/v1/userTrades` 与 `/fapi/v1/income` 重建停机期间或遗漏的成交
 * - 修正已有交易的交易所权威手续费/资金费/净盈亏，并执行归属闸门隔离多机器人/外部手工成交
 * - 汇总总账差额（`ledger_check`）与外部活动（`foreign_activity`）供控制台展示
 */
import type { Trader } from '@aq/shared';
import type { ExchangePosition } from '../binance/broker.js';
import type { AccountState } from '../binance/account.js';
import type { SymbolRegistry } from '../binance/symbols.js';
import type { BinanceUserTrade } from '../binance/types.js';
import {
  commissionsInFills,
  commissionsInWindow,
  fundingInWindow,
  fundingSince,
  isSettlementAsset,
  netPnlOf,
  realizedInFills,
  realizedInWindow,
} from '../binance/income.js';
import { eventBus } from '../events.js';
import { createLogger } from '../logger.js';
import {
  equity as equityStore,
  orderIdIn,
  orders as orderStore,
  positions as positionStore,
  settings,
  shouldTrustReconciledQuantity,
  trades as tradeStore,
} from '../store/repositories.js';
import type { BrokerPort } from './brokerPort.js';
import {
  reconstructRoundTrips,
  roundTripKey,
  roundTripQueryKey,
} from './roundTrips.js';
import { ledgerGapTolerance } from './autoTrader.js';

const log = createLogger('trader');

export const RECONCILE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const FULL_RECONCILE_EVERY_PASSES = 24;

type PositionRow = ReturnType<typeof positionStore.open>[number];

export interface TradeHistoryReconcileResult {
  recovered: number;
  corrected: number;
  correctedAttempted: number;
  correctedKept: number;
  funding: number;
  foreignRounds: number;
  foreignNet: number;
}

export interface TradeHistoryReconcileContext {
  trader: Trader;
  isDryRun: boolean;
  registry: SymbolRegistry;
  reversedTripNotices: Set<string>;
  isRunning: () => boolean;
  isCycleInFlight: () => boolean;
  getReconcilePasses: () => number;
  incrementReconcilePasses: () => void;
  emit: (level: 'info' | 'warn' | 'error', message: string) => void;
  emitOnChange: (key: string, level: 'info' | 'warn' | 'error', message: string, stateKey?: string) => void;
  clearStateNotice: (key: string) => void;
  reportForeignFees: (symbol: string, foreign: ReadonlyArray<{ asset: string; amount: number }>) => void;
  leverageFor: (symbol: string) => number;
  getAccountState: BrokerPort['getAccountState'];
  getPositions: BrokerPort['getPositions'];
  getUserTrades: BrokerPort['getUserTrades'];
  getIncome: BrokerPort['getIncome'];
  settleStaleOrders: (onlySymbol?: string, options?: { ignoreGraceWindow?: boolean }) => Promise<number>;
  bookVanishedPosition: (local: PositionRow) => Promise<void>;
  recordEquity: (account: AccountState, positions: ExchangePosition[]) => void;
}

export async function reconcileTradeHistoryForTrader(
  ctx: TradeHistoryReconcileContext,
  full = true,
): Promise<{
  recovered: number;
  /** **真的**按交易所口径覆盖了已有行的笔数（不是"尝试过"的笔数）。 */
  corrected: number;
  /**
   * 尝试修正的总笔数（撞上已有行的次数）。
   *
   * ⚠️ 与 `corrected` 分开：`applyExchangeFigures` 在"重建腿边界不可信"时会**整笔
   * 拒绝**，那种情况计入 `correctedKept`。三者满足
   * `correctedAttempted === corrected + correctedKept`。
   */
  correctedAttempted: number;
  /** 因"腿边界存疑、保留本地口径"而**没能覆盖**的笔数（判不出来的那些）。 */
  correctedKept: number;
  funding: number;
  /** 不属于本平台任何机器人的成交笔数（外部活动）。 */
  foreignRounds: number;
  /** 这些外部成交的净额，用来解释「账户为什么在缩水」。 */
  foreignNet: number;
}> {
  const traderId = ctx.trader.id;

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **模拟盘不跑"与交易所对账"这一趟**（2026-11-09）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 这一段做的是"拿交易所的成交/流水去校平台账本"，而模拟盘的成交**从来没发到
   * 交易所**（`BinanceBroker` 的 dry-run 分支全程本地模拟）。于是：
   *
   *   · `getIncome` / `getUserTrades` 在模拟盘下返回空（本层没有信息，见 broker
   *     的 dryRun 守卫）——**空数组被当成"交易所流水是 0"**；
   *   · 只要这台模拟盘**绑定了真实账户**（PR #185 允许），下面那段总账校验就会
   *     拿"平台(模拟)净额 vs 交易所(别人的)流水"相减，**每一轮都报一条假的
   *     「账目与交易所对不上」** —— 一个永久误报的校验会训练操作员忽略这条
   *     唯一能自动发现账本错误的地方。
   *   · 反过来说，"外部活动"也是账户级概念，属于在跑实盘的机器人；模拟盘认领它
   *     只会把别人的盈亏算到自己头上。
   *
   * ⇒ 模拟盘的真相就是**本地台账**，没有可对的一侧。直接返回全零，且**一个
   * 交易所读取都不发**（调用方据此知道"没有发生对账"，而不是"对账结果为 0"）。
   */
  if (ctx.isDryRun) {
    return {
      recovered: 0,
      corrected: 0,
      correctedAttempted: 0,
      correctedKept: 0,
      funding: 0,
      foreignRounds: 0,
      foreignNet: 0,
    };
  }

  const deep = full || ctx.getReconcilePasses() % FULL_RECONCILE_EVERY_PASSES === 0;
  ctx.incrementReconcilePasses();

  const createdSince = new Date(ctx.trader.createdAt).getTime() - 60_000;
  /*
   * The window floor. A deep pass keeps the original "since this trader
   * existed" bound; a routine pass narrows it. `Math.max` with the creation
   * time keeps a *young* trader's window small as well — a trader created an
   * hour ago must not ask the exchange for a month of income history it cannot
   * have.
   */
  const since = deep
    ? createdSince
    : Math.max(createdSince, Date.now() - RECONCILE_WINDOW_MS);
  const sinceIso = new Date(since).toISOString();

  /*
   * The income ledger does double duty here: it supplies funding fees (which no
   * fill mentions) and it names **every symbol the account has touched**, which
   * is how a symbol the platform has no record of at all gets discovered.
   */
  let incomeEvents: Awaited<ReturnType<BrokerPort['getIncome']>> = [];
  /*
   * ⚠️ **"读失败"与"读到空"是两件事，而它们在这里被混成了一件。**
   *
   * 下面那个 `catch` 原来只写 `log.debug`，然后 `incomeEvents` 停在 `[]` ——
   * 于是**总账校验**拿一个空数组算出 `exchangeNet = 0`，再把差额报成
   * "平台的账本可能有漏记或重复记账"。
   *
   * 实测那个账户上报出「平台记录 0.3246、交易所流水 **0.0000**，差 0.3246」——
   * 0.3246 恰好是它的全部净盈亏，而流水是 0，**说明流水根本没读到**。
   * 而同一次运行的落库值 `gap` 只有 0.0057（正常）：**读成功就正常、读失败就报账目错误。**
   *
   * 那正是这段代码下面自己警告过的：「一个永久误报的校验比没有校验更糟 ——
   * 它会训练操作员忽略这条告警，而这是唯一能自动发现『账本错了』的地方」。
   */
  let incomeReadFailed = false;
  try {
    incomeEvents = await ctx.getIncome({ startTime: since });
  } catch (error) {
    incomeReadFailed = true;
    log.debug(`[${ctx.trader.name}] 收入流水读取失败，本次对账跳过资金费与总账校验：${(error as Error).message}`);
  }

  /*
   * Symbols in scope for this pass.
   *
   * Open positions are always included regardless of the window — a position
   * this trader is actually holding must have its fills checked even when its
   * local trade row is older than the window. Only the traded-symbol list is
   * windowed, and only on a routine pass.
   */
  /*
   * 扫描范围 —— **必须是账户级，不是本机器人级**。
   *
   * ## 为什么
   *
   * 这一趟循环做两件事，而它们的范围本来就不同：
   *
   *   1. **恢复本机器人的成交**（下面 `tradeStore.insert`，由 `ownOrders` 闸门把关）；
   *   2. **清点外部活动** —— "不属于本平台任何机器人"的成交，那是个**账户级**概念，
   *      落在哪个符号上与本机器人自己交易过什么毫无关系。
   *
   * 原来两件事共用一份"本机器人"的符号表（`tradedSymbols(traderId)` /
   * `positions.open(traderId)`）。结果一个只交易过少数币种的机器人**看不到账户在
   * 别的币种上的外部活动**：那部分盈亏记不进 `foreignNet`，却实实在在躺在交易所
   * `income` 流水里 —— 于是总账校验报出**账本并没有错**的假差额。
   *
   * ⚠️ 实测：共用同一账户的五个机器人里，三个报 195 笔外部活动、差额 −0.20，
   * 两个报 222/223 笔、差额 ±0.006。**差的就是扫描范围。**
   *
   * 多扫几个符号的代价是几次 `getUserTrades`，而漏扫的代价是一个永久误报的
   * 账本校验 —— 那会训练操作员忽略这条唯一能自动发现"账本错了"的告警。
   *
   * 窗口仍然保留：例行对账只看窗口内交易过的符号，只有深扫才不限。
   */
  const symbols = new Set<string>([
    ...tradeStore.allTradedSymbols(deep ? undefined : sinceIso),
    ...positionStore.allOpenSymbols(),
    ...incomeEvents.map((e) => e.symbol).filter((s): s is string => Boolean(s)),
  ]);

  /*
   * Two indexes over the same rows.
   *
   * `byKey` is the strict key (symbol + qty + entry price + entry order id) and
   * is what prevents one round-trip's exchange figures from being written onto
   * another row: two entries of the same size at the same price are only the
   * same trade if they are the same order.
   *
   * `byDescription` holds rows that carry **no** entry order id — booked before
   * the id was known, or from an adopted position. Those can only be matched on
   * their description, and keeping them in a separate index that is consulted
   * only after the strict lookup fails means the ambiguous match can never
   * shadow an exact one.
   */
  // Bounded the same way: a routine pass only needs the rows it can still match.
  const ledger = tradeStore.ledger(traderId, deep ? undefined : sinceIso);
  const byKey = new Map(
    ledger.map((t) => [
      roundTripKey({
        symbol: t.symbol,
        quantity: t.quantity,
        entryPrice: t.entryPrice,
        entryOrderId: t.entryOrderId,
      }),
      t.id,
    ]),
  );
  const byDescription = new Map(
    ledger
      .filter((t) => !t.entryOrderId)
      .map((t) => [
        roundTripQueryKey({ symbol: t.symbol, quantity: t.quantity, entryPrice: t.entryPrice }),
        t.id,
      ]),
  );

  /*
   * Which exchange orders this trader actually placed.
   *
   * Two traders can share one exchange account, and then the fill history is
   * identical for both — reconciliation would have each of them claim every
   * round-trip, double-counting the account's PnL across the books. Only the
   * local order history can say who traded what, so adoption is gated on it.
   *
   * The live symptom was exactly this: two traders on one credential, and a
   * boot pass that booked the same four trades onto both.
   */
  /* 与下方 allExchangeOrderIds() 保持一致，不截断 2000 条，防止高频老机器人本机订单被误判为他机。 */
  const ownOrders = orderStore.exchangeOrderIds(traderId);
  /*
   * **全局**订单号 —— 用来把「别的机器人」和「外部活动」分开。
   *
   * 两者都"不属于本机器人"，但处置完全相反：前者是多机器人共用账户的
   * 正常情况，静默跳过是对的；后者意味着**账户上有本平台之外的交易**，
   * 那会直接吃掉余额，而账面上看不出来。
   */
  const allOrders = orderStore.allExchangeOrderIds();
  /** 不属于本平台**任何**机器人的成交。函数末尾汇总上报。 */
  const foreign: Array<{ symbol: string; net: number; at: string }> = [];

  let recovered = 0;
  let corrected = 0;
  /**
   * 本轮**尝试**修正的笔数，与其中**被判"边界存疑、保留本地"**的笔数。
   *
   * ## 为什么必须分开数（2026-10-17，用户报「每次都是修正 50 笔」）
   *
   * `corrected` 原来数的是"调用过 `applyExchangeFigures` 几次"，而那个函数**有权
   * 整笔拒绝**（重建出的"腿"边界不可信时不覆盖数量、金额与价位）。于是线上每轮
   * 都报"修正 50 笔"，实际一行都没变 —— 一个恒定的假数字，把"每一轮都在重复
   * 尝试同一批判不出来的回合"这件真事藏了整整一轮迭代。
   *
   * 现在三个数各有意义：
   *   · `correctedAttempted` —— 撞上已有行的次数（**尝试**）；
   *   · `corrected`          —— 真的按交易所口径覆盖了的（**生效**）；
   *   · `keptForBoundary`    —— 因边界存疑整行保留本地的（**判不出来**）。
   *
   * ⚠️ 第三个数是**结论的一部分**，不是噪音：`attempted == keptForBoundary` 意味着
   * 这一轮的修正全军覆没，而日志必须让操作员一眼看见这一点（见函数末尾那条日志）。
   */
  let correctedAttempted = 0;
  let keptForBoundary = 0;
  let fundingTotal = 0;
  /*
   * 诊断计数器 —— 定位"外部净额"与交易所流水那 0.2 差额到底丢在哪一步。
   *
   * 光看汇总值只能知道"差 0.2"，而它可能是：时间窗把某些回合挡在外面、
   * 还是归属闸门把它们判给了别的机器人、还是没有 `entryOrderId` 的成交。
   * 三种原因的修法完全不同，所以把它们分开数。
   */
  const skipDiag = { beforeWindow: 0, otherTrader: 0, foreign: 0, foreignNoId: 0, reversed: 0 };
  /**
   * 反向回合**已经按交易所口径记进账本**的净额合计（2026-10-03 起不再丢弃）。
   *
   * 它只用于日志与诊断 —— 记进账本之后，这笔钱自然进了 `platformSelf`，
   * 不需要在 `platformNet` 里再补一次（那会重复计）。
   */
  let reversedBookedNet = 0;
  /*
   * 本机器人下单时的**意图**（交易所单号 → 用途）—— 用来辨认重建出的回合有没有
   * 把开/平方向搞反。详见 `orders.purposeByExchangeOrderId()` 与下面那段校验。
   */
  const purposeById = orderStore.purposeByExchangeOrderId(traderId);

  /*
   * ⚠️ **本轮对账里"已经被认领过"的成交 id**（2026-10-15 账目差 12.61 的修复）。
   *
   * 为什么需要它：一笔**穿过零的翻转成交**同时属于两个腿（旧腿的平、新腿的开），
   * 所以它会出现在两个 `ReconstructedTrade.fillIds` 里。若两个腿各按自己的
   * `fillIds` 去 `income` 里认领，同一笔 `REALIZED_PNL` 会被计两次 ——
   * 那正是我们要修的那个"账本虚增"形状。
   *
   * 实测对照（三个成交、两个腿）：正确答案是 `10 + 4 = 14`；
   * 不去重会得到 `10 + 10 + 4 = 24`。
   *
   * 范围是**一次对账**：下一轮重新从空集合开始，所以重复执行对账仍然幂等
   *（`platformSelf` 是重算的，不是累加的）。
   */
  const claimedFillIds = new Set<string>();
  const claimedCommissionFillIds = new Set<string>();
  const hasCommissionTradeIds = incomeEvents.some(
    (e) => e.incomeType === 'COMMISSION' && String(e.tradeId ?? '').length > 0,
  );

  for (const symbol of symbols) {
    if (!ctx.registry.get(symbol)) continue;
    let fills;
    try {
      fills = await ctx.getUserTrades(symbol, 500);
    } catch {
      continue; // a symbol we cannot read must not abort the whole pass
    }

    for (const trip of reconstructRoundTrips(fills)) {
      /*
       * 重建出来的**非结算资产手续费**（BNB 抵扣）不会进 `fee` —— 但它也不能
       * 就这样消失（`ReconstructedTrade.foreignFees` 原来没有任何消费方）。
       * 单独报一条，让操作员知道这段差额从哪来（§2.5）。
       */
      ctx.reportForeignFees(trip.symbol, trip.foreignFees);
      /*
       * ⚠️ **先校验方向 —— 反了的回合一个数都不许记。**
       *
       * `reconstructRoundTrips()` 用的是**净头寸法**：按持仓数量的变化判断哪一笔
       * 是开仓、哪一笔是平仓。它拿的是 `getUserTrades(symbol, 500)`（最近 500 笔），
       * 而**"窗口起点时的持仓"这个信息根本不存在** —— 一旦窗口起点落在一个持仓的
       * 中间，第一笔（其实是平仓）会被当成开仓，**整个 leg 的 open/close 就此反向**，
       * 把不同回合的单号配到一起。
       *
       * 实测（2026-09-29，6 笔 `reconciled`）：所谓 `entry_order_id` 在 `orders`
       * 里记的用途是 `exit`、所谓 `exit_order_id` 记的是 `entry`，两者甚至相隔 2 天；
       * 6 笔净额合计 `-0.125559`，**正好等于账目校验的全部缺口**。
       * 也就是说：**账本没错，是重建凭空造出了这些反向回合**（还顺带让
       * `findDuplicate()` 的单号去重判据失效）。
       *
       * 判据用**运行期记下的下单意图**（`orders.purpose`）—— 那是我们当时真正
       * 想做的事，比重建的推测可信。找不到（外部活动/别的机器人）就照原路走。
       */
      const entryPurpose = trip.entryOrderId ? purposeById.get(trip.entryOrderId) : undefined;
      const exitPurpose = trip.exitOrderId ? purposeById.get(trip.exitOrderId) : undefined;
      if (entryPurpose === 'exit' || exitPurpose === 'entry') {
        skipDiag.reversed += 1;
        /*
         * ══════════════════════════════════════════════════════════════════════
         *  ⚠️ **两个单号要按"用途证据"逐个纠正，而不是无条件对调**（2026-10-17）
         * ══════════════════════════════════════════════════════════════════════
         *
         * ## 为什么必须纠正（ACC-07 的剩余危害）
         *
         * 这个分支的定义是"开/平判反了"，所以 `trip.entryOrderId` 其实是**平仓**单、
         * `trip.exitOrderId` 其实是**开仓**单。而 `trades.insert(..., idempotent: true)`
         * 会走 `findDuplicate()`，它的**确定性判据只看 `exit_order_id`**
         *（`repositories.ts:2782-2790`，不看 `entry_order_id`）。
         *
         * 于是：
         *   · 首次记这个反向回合 → 查不到 → 正常插入（没问题）；
         *   · **同一段成交被再次重建** → 拿"所谓的 exitOrderId"（实际是开仓单号）
         *     去查 `trades.exit_order_id` → **查不到**（账本里那个号在 `entry_order_id`）
         *     → **重复插入**。
         *
         * ## 为什么不是"无条件对调"
         *
         * 无条件 `entryOrderId: trip.exitOrderId, exitOrderId: trip.entryOrderId`
         * 在**两个用途都查得到**时是对的（那是铁证：两个单号恰好互换）。
         * 但实测的四例里有**两例只有一半能查到**：
         *
         * ```text
         *   WLDUSDT  入场 23687788340 用途【未知】  出场 23919030401 用途 entry
         *   HYPEUSDT 入场 14270293462 用途【未知】  出场 14295439869 用途 entry
         * ```
         *
         * 这时 `trip.entryOrderId`（那个"未知"的号）**未必**是平仓单 —— 它可能属于
         * 别的机器人、或者被 `Number()` 改写过精度（见 `orderIdIn()` 的注释）。
         * 无条件对调会把一个**来源不明的单号**写进 `exit_order_id`（判重身份），
         * 那就是"用一个猜测去替换一个已知错误"。
         *
         * ## 所以：每个单号**只有拿到正面证据时才改写**
         *
         *   · `exitPurpose === 'entry'` ⇒ 重建的"出场单"确实是开仓单 ⇒ 它才是 `entry_order_id`；
         *   · `entryPurpose === 'exit'` ⇒ 重建的"入场单"确实是平仓单 ⇒ 它才是 `exit_order_id`；
         *   · 用途未知的那一半**保持原样** —— 不引入新的错误（宁可少一条判据，
         *     也不要写一个假身份进去）。
         *
         * ## `exitOrderIds`（复数）为什么不能原样传
         *
         * 它是"这个腿的全部**出场**单号"，而方向反了 ⇒ 它装的是**开仓**单号。
         * 拿它去查 `exit_order_id IN (...)` 只会落空（那些号在 `entry_order_id` 里），
         * 白跑一条 SQL 且给出"没有重复"的假信心。
         * 所以：只有当我们**确知**了真正的平仓单（`entryPurpose === 'exit'`）时，
         * 才把它作为单元素数组传进去；否则传空数组（= 这条判据本轮不参与）。
         */
        const correctedEntryOrderId =
          exitPurpose === 'entry' ? trip.exitOrderId : trip.entryOrderId;
        const correctedExitOrderId =
          entryPurpose === 'exit' ? trip.entryOrderId : trip.exitOrderId;
        /*
         * ⚠️ 只有"真正的平仓单"才进 `exitOrderIds`。`entryPurpose === 'exit'` 时
         * `trip.entryOrderId` 就是它；否则没有可靠来源，传空（不参与判重）。
         */
        const correctedExitOrderIds: string[] =
          entryPurpose === 'exit' && trip.entryOrderId ? [trip.entryOrderId] : [];
        const notice =
          `[${ctx.trader.name}] 重建出的 ${symbol} 回合方向是反的（所谓入场单 ${trip.entryOrderId} ` +
          `实际用途 ${entryPurpose ?? '未知'}、所谓出场单 ${trip.exitOrderId} 实际用途 ${exitPurpose ?? '未知'}）` +
          '—— 开/平方向、数量与价位都不可信，但**净额仍按交易所口径记账**（见下）。' +
          '这通常说明成交历史的窗口起点落在持仓中间，净头寸法把开/平判反了。';
        /*
         * ⚠️ **只告警一次。** 这个回合的成因（窗口起点落在持仓中间）在我们能读到的
         * 历史里是固定的，所以**每一轮都会重建出同一个反向回合** —— 每轮刷 WARN
         * 会让日志像在持续出错，把真正的新问题淹掉。
         */
        const noticeKey = `${trip.entryOrderId}->${trip.exitOrderId}`;
        if (ctx.reversedTripNotices.has(noticeKey)) {
          log.debug(notice);
        } else {
          ctx.reversedTripNotices.add(noticeKey);
          log.warn(notice);
        }

        /*
         * ── 2026-10-03：**不再整笔丢弃，而且金额改走 income 流水** ─────────────
         *
         * 用户在主账户上跑实盘，问「盈亏计算是否正确」。查到 `#9` 的账目与交易所
         * 流水差 **-0.436177**，而差额全部来自这里：方向反了的回合被 `continue`
         * 丢掉 ⇒ `platformSelf` 少了那部分已实现盈亏 ⇒ 页面上的「交易盈亏」偏低、
         * 总账校验每轮报一条「账目与交易所对不上」。
         *
         * ⚠️ **但 `trip.grossPnl` 不能用** —— 这一点是测试当场纠正过来的：
         * 交易所把 `realizedPnl` 记在**平仓那一笔成交**上，而方向一反，那笔就被
         * 当成了开仓、它的 `realizedPnl` 于是走开腿分支被丢掉（实测构造出来的
         * `grossPnl = 0`，而真实是 1.5）。**方向错的不只是元数据，金额也会错配。**
         *
         * 所以金额取**交易所流水**（`incomeEvents` 里的 `REALIZED_PNL`），
         * 按该标的、该回合的生命周期窗口聚合 —— 那是**完全不受重建影响**的权威口径，
         * 与上面 `!trustQuantity` 那条分支把手续费改走 `commissionsInWindow()` 同一个理由。
         */
        {
          /*
           * ⚠️⚠️ **金额按【成交 id】归属，不按"标的 + 时间窗口"**（2026-10-15 修）
           *
           * ## 事故：实盘账本比交易所高 12.61 USDT（而本金只有 100）
           *
           * 实测 `#10`：
           * ```
           *   platformNet  +5.657252      ← 账本
           *   exchangeNet  -6.956285      ← 交易所流水
           *   gap          12.613538
           *
           *   逐项：reconciled_reversed 38 笔 · 净 +13.0577   ← 与 gap 量级吻合
           *   platformSelf − reversedNet = -7.4004（与交易所只差 0.44，差两个数量级）
           * ```
           *
           * ## 根因：窗口聚合把【别人的回合】算进了自己
           *
           * 原来这里是 `realizedInWindow(events, symbol, openedAt, closedAt)` ——
           * 按**标的 + 时间窗口**。而这些回合的窗口**平均 23.1 小时、最大 159.3 小时**
           *（其他平仓类只有 2–3 小时），因为方向判错时 `openedAt` 取自一笔
           * "其实是平仓"的成交，窗口就此跨到别的回合里。实测：
           * ```
           *   ADAUSDT #344 reconciled_reversed  10-06T15:53 → 10-10T17:07（97 小时）
           *   被它包住的真实回合：#250 stop_loss · #281/#283 manual_partial
           *                       · #288 drawdown_guard（共 12 个回合落在别的窗口内部，
           *                       净额合计 +4.5997）
           *   ⇒ 那些盈亏各自已经记过账，却又被这个窗口聚合了一遍
           * ```
           *
           * ## 修法：`income.tradeId` 就是成交的 `id`
           *
           * 实测确认（`NEARUSDT`）：19 条 `REALIZED_PNL` 与 33 笔成交里
           * **19/19 的 `tradeId` 能在成交里找到**。所以"这笔盈亏属于哪个回合"
           * 有精确答案 —— 与手续费那侧早就采用的"按单号而不是按标的"同源
           *（见本文件讲 `openEntryCosts` 的那段）。
           *
           * ⚠️⚠️ **但归属必须用 `fillIds`，不能用 `closeFillIds`**（实测纠正）
           *
           * 这个分支的定义就是「**开/平判反了**」，所以"哪一笔是平腿"这个判断
           * **本身就是错的**。用 `closeFillIds` 会一个数都匹配不到：
           * ```
           *   夹具实测：交易所把 1.5 记在成交 #1 上（那是真实的平仓），
           *   而重建把它误判成【开腿】→ 它在 openFillIds 里
           *   ⇒ 拿 closeFillIds=['2'] 去匹配 → 0（而正确答案是 1.5）
           * ```
           * 所以退回"这个腿的全部成交"，并用 `claimedFillIds` 去重 ——
           * 一个穿过零的翻转成交同时属于两个腿，不去重会重复入账。
           */
          const realizedForTrip =
            trip.fillIds.length > 0
              ? realizedInFills(incomeEvents, trip.fillIds, claimedFillIds)
              : /* 兜底：老版本重建出的回合没有 fillIds（回放/跨版本）→ 退回窗口口径。 */
                realizedInWindow(incomeEvents, symbol, trip.openedAt, trip.closedAt);
          const fundingForTrip = fundingInWindow(incomeEvents, symbol, trip.openedAt, trip.closedAt);
          const feesForTrip =
            trip.fillIds.length > 0 && hasCommissionTradeIds
              ? commissionsInFills(
                  incomeEvents,
                  trip.fillIds,
                  trip.openedAt,
                  trip.closedAt,
                  claimedCommissionFillIds,
                )
              : commissionsInWindow(incomeEvents, symbol, trip.openedAt, trip.closedAt);
          /*
           * 窗口里一条 `REALIZED_PNL` 都没有 ⇒ 这一个"回合"在交易所流水里没有任何
           * 已实现盈亏 —— 那它大概率是重建把两笔平仓拼出来的假回合（金额为 0），
           * 记它只会往账本里塞一行噪声。**宁可不记。**
           */
          if (realizedForTrip === 0 && feesForTrip.entryFee + feesForTrip.exitFee === 0) {
            log.debug(
              `[${ctx.trader.name}] ${symbol} 的反向回合在 income 里没有任何流水 —— 不记账。`,
            );
            continue;
          }
          const netForTrip = netPnlOf({
            grossPnl: realizedForTrip,
            fee: feesForTrip.entryFee + feesForTrip.exitFee,
            fundingFee: fundingForTrip,
          });
          try {
            const bookedReversed = tradeStore.insert({
              traderId,
              symbol,
              side: trip.side,
              quantity: trip.quantity,
              entryPrice: trip.entryPrice,
              exitPrice: trip.exitPrice,
              leverage: ctx.leverageFor(symbol),
              /* 金额来自交易所流水，**不是**重建的推测。 */
              grossPnl: realizedForTrip,
              entryFee: feesForTrip.entryFee,
              exitFee: feesForTrip.exitFee,
              fundingFee: fundingForTrip,
              /* 独立原因码：方向字段不可信，金额来自流水。 */
              closeReason: 'reconciled_reversed',
              openedAt: trip.openedAt,
              closedAt: trip.closedAt,
              source: 'reconciled',
              /*
               * ⚠️ **用纠正过的单号**（见上面那段"逐个纠正"的说明）——
               * 直接传 `trip.*` 会让 `findDuplicate()` 的确定性判据（只看
               * `exit_order_id`）永远查不到，于是同一段成交被再次重建时重复插入。
               */
              entryOrderId: correctedEntryOrderId || null,
              exitOrderId: correctedExitOrderId || null,
              exitOrderIds: correctedExitOrderIds,
              idempotent: true,
            });
            if (bookedReversed.created) {
              reversedBookedNet += netForTrip;
              ctx.emit(
                'info',
                `${symbol} 的一个回合开/平方向不可信（成交历史窗口起点落在持仓中间），` +
                  `已按【交易所流水】记账：净 ${netForTrip >= 0 ? '+' : ''}${netForTrip.toFixed(4)} USDT。` +
                  '该行的方向与数量字段请勿用于胜率统计。',
              );
            }
          } catch (error) {
            log.warn(
              `[${ctx.trader.name}] ${symbol} 的反向回合记账失败（不影响本周期交易）：` +
                `${(error as Error).message}`,
            );
          }
        }
        continue;
      }
      if (new Date(trip.closedAt).getTime() < since) {
        skipDiag.beforeWindow += 1;
        continue;
      }
      const funding = fundingInWindow(incomeEvents, symbol, trip.openedAt, trip.closedAt);
      fundingTotal += funding;
      const key = roundTripKey(trip);

      /*
       * 部分减仓（`manual_partial`）拆分腿专项核算：
       * 交易所重建出的 `trip` 是整腿合并值，绝不可用整腿去覆盖单笔 `manual_partial` 行
       * （减仓 ≥67% 时会覆盖成整腿造成双计，减仓 <67% 时又会因边界拒改而静默丢掉尾仓）。
       * 先查同源拆分行：有尾仓行时只用差额修正尾仓行；停机漏记尾仓时只补录剩余差额。
       */
      const splits = tradeStore.legSplitRows({
        traderId,
        symbol: trip.symbol,
        entryOrderId: trip.entryOrderId,
        exitOrderIds: trip.exitOrderIds,
        openedAt: trip.openedAt,
        closedAt: trip.closedAt,
      });
      const partialRows = splits.filter((r) => r.closeReason === 'manual_partial');
      if (partialRows.length > 0) {
        const finalRows = splits.filter((r) => r.closeReason !== 'manual_partial');
        const partialQty = partialRows.reduce((s, r) => s + r.quantity, 0);
        const partialGross = partialRows.reduce((s, r) => s + r.grossPnl, 0);
        const partialEntryFee = partialRows.reduce((s, r) => s + r.entryFee, 0);
        const partialExitFee = partialRows.reduce((s, r) => s + r.exitFee, 0);
        const partialFunding = partialRows.reduce((s, r) => s + r.fundingFee, 0);
        const remQty = Math.max(0, trip.quantity - partialQty);
        const remGross = trip.grossPnl - partialGross;
        const remEntryFee = Math.max(0, trip.entryFee - partialEntryFee);
        const remExitFee = Math.max(0, trip.exitFee - partialExitFee);
        const remFunding = funding - partialFunding;

        if (finalRows.length === 1) {
          const finalRow = finalRows[0]!;
          if (remQty > Math.max(1e-8, trip.quantity * 1e-4)) {
            correctedAttempted += 1;
            /*
             * BUG-3A 修复：分批平仓回合的尾仓行只覆盖剩余数量 `remQty` 与剩余毛利 `remGross`，
             * 不能把整腿（含历史部分平仓）的加权均价 `trip.exitPrice` 覆写进尾仓行导致 exit_price 与 pnl 矛盾；
             * 按剩余腿毛利反推真实尾仓均价。
             */
            const isShortTrip = trip.side === 'short';
            const derivedRemExit =
              trip.entryPrice > 0
                ? isShortTrip
                  ? trip.entryPrice - remGross / remQty
                  : trip.entryPrice + remGross / remQty
                : trip.exitPrice;
            const remExitPrice =
              Number.isFinite(derivedRemExit) && derivedRemExit > 0
                ? derivedRemExit
                : trip.exitPrice;
            const figureWrite = tradeStore.applyExchangeFigures({
              id: finalRow.id,
              grossPnl: remGross,
              entryFee: remEntryFee,
              exitFee: remExitFee,
              fundingFee: remFunding,
              entryPrice: trip.entryPrice,
              exitPrice: remExitPrice,
              quantity: remQty,
              leverage: ctx.leverageFor(symbol),
              entryOrderId: trip.entryOrderId || null,
              exitOrderId: trip.exitOrderId || null,
            });
            if (figureWrite.applied) corrected += 1;
            else keptForBoundary += 1;
          }
          byKey.set(key, finalRow.id);
          continue;
        }
        if (finalRows.length > 1) {
          continue;
        }
        if (
          remQty > Math.max(1e-8, trip.quantity * 1e-4) &&
          !partialRows.some((r) => r.exitOrderId && r.exitOrderId === trip.exitOrderId)
        ) {
          const bookedRemainder = tradeStore.insert({
            traderId,
            symbol: trip.symbol,
            side: trip.side,
            quantity: remQty,
            entryPrice: trip.entryPrice,
            exitPrice: trip.exitPrice,
            leverage: ctx.leverageFor(symbol),
            grossPnl: remGross,
            entryFee: remEntryFee,
            exitFee: remExitFee,
            fundingFee: remFunding,
            closeReason: 'reconciled',
            openedAt: trip.openedAt,
            closedAt: trip.closedAt,
            source: 'reconciled',
            entryOrderId: trip.entryOrderId || null,
            exitOrderId: trip.exitOrderId || null,
            idempotent: false,
          });
          byKey.set(key, bookedRemainder.id);
          recovered += 1;
          const remNet = netPnlOf({
            grossPnl: remGross,
            fee: remEntryFee + remExitFee,
            fundingFee: remFunding,
          });
          ctx.emit(
            'warn',
            `对账补录了 ${trip.symbol} 减仓后的剩余平仓：${remQty} @ ${trip.entryPrice} → ${trip.exitPrice}，净 ${remNet >= 0 ? '+' : ''}${remNet.toFixed(4)} USDT。`,
          );
        }
        continue;
      }
      /*
       * Exact match first. Only when no row owns this entry order do we fall
       * back to the description-only index, and only for rows that have no
       * entry order id of their own — so an ambiguous row can never be
       * overwritten by, or overwrite, an identified one.
       */
      const existingId =
        byKey.get(key) ??
        byDescription.get(
          roundTripQueryKey({
            symbol: trip.symbol,
            quantity: trip.quantity,
            entryPrice: trip.entryPrice,
          }),
        );

      if (existingId !== undefined) {
        /*
         * ⚠️ **重建错位时，手续费也必须走 income 的权威值 —— 不能只挡住数量。**
         *
         * 实测（2026-09-29，HYPEUSDT）：重建的窗口起点落在持仓中间时，整条序列错位，
         * 它算出来的 `fee` **是按错位后的数量计的**（重建 0.000970 vs 交易所 0.010204）。
         * 只保留本地数量是不够的 —— fee 还是错的，净额照样偏大，gap 依然在（0.0596）。
         *
         * 所以数量不可信时，`entryFee/exitFee` 改从 income 流水取（它的 COMMISSION 是
         * 结算资产计价、且**完全不受重建影响**）。数量本身由 `applyExchangeFigures()`
         * 内部再挡一次（双保险）。
         */
        const localQuantity = tradeStore.quantityOf(existingId);
        const trustQuantity =
          localQuantity === undefined || shouldTrustReconciledQuantity(localQuantity, trip.quantity);
        const fees = trustQuantity
          ? { entryFee: trip.entryFee, exitFee: trip.exitFee }
          : commissionsInWindow(incomeEvents, symbol, trip.openedAt, trip.closedAt);
        if (!trustQuantity) {
          log.warn(
            `[${ctx.trader.name}] ${symbol} 的重建成交量（${trip.quantity}）与本地（${localQuantity}）差得太远 —— ` +
              `本回合的手续费改用交易所流水（${(fees.entryFee + fees.exitFee).toFixed(6)}，` +
              `重建算的是 ${(trip.entryFee + trip.exitFee).toFixed(6)}）。`,
          );
        }

        /*
         * ⚠️ **「修正」的计数必须是"真的改了"，不是"试过了"。**
         *
         * 线上实测（用户报「每次都是修正 50 笔」）：这一行原来无条件 `corrected += 1`，
         * 而 `applyExchangeFigures` 在 `keepLocalQuantity` 为真时**整行都不覆盖**（内部
         * 早退）—— 于是日志每次都说"修正了 50 笔"，而账本一个字都没变。
         * 计数虚报比不计更糟：操作员以为对账在正常工作，就没动机去追
         * 「为什么每一轮都要修正同样那 50 笔」（那 50 笔的"腿边界"每次都不可信）。
         *
         * 所以分成两个数：`corrected` = 真正生效的，`keptForBoundary` = 被判"边界存疑、
         * 保留本地"的。后者不是失败，而是**必须上报的第三种结果** ——
         * 操作员要知道"有多少笔是判不出来的"。
         */
        correctedAttempted += 1;
        const figureWrite = tradeStore.applyExchangeFigures({
          id: existingId,
          grossPnl: trip.grossPnl,
          entryFee: fees.entryFee,
          exitFee: fees.exitFee,
          fundingFee: funding,
          entryPrice: trip.entryPrice,
          exitPrice: trip.exitPrice,
          quantity: trip.quantity,
          leverage: ctx.leverageFor(symbol),
          entryOrderId: trip.entryOrderId || null,
          exitOrderId: trip.exitOrderId || null,
        });
        if (figureWrite.applied) corrected += 1;
        else keptForBoundary += 1;
        /*
         * The row now owns this entry order, so it moves out of the
         * description-only index — otherwise a later identical-looking
         * round-trip could still match it by description.
         */
        byKey.set(key, existingId);
        byDescription.delete(
          roundTripQueryKey({
            symbol: trip.symbol,
            quantity: trip.quantity,
            entryPrice: trip.entryPrice,
          }),
        );
        continue;
      }

      /*
       * Only adopt a round-trip this trader placed.
       *
       * `entryOrderId` comes from the exchange's fill, so an exact match in the
       * local order history proves ownership. A round-trip with no matching
       * order belongs to another trader on the same credential, or to a manual
       * trade — either way it is not ours to claim, and booking it would
       * double-count the account's PnL across the books.
       *
       * No fallback: a trade we cannot prove we opened is skipped. Missing a
       * recovery is a smaller error than inventing one, because a phantom trade
       * corrupts the ledger permanently while a skip corrects itself the moment
       * the order row exists.
       */
      /*
       * 这段"归属闸门"（`ownOrders`）必须先说清楚它管什么、不管什么：
       * 它回答的是"这一回合是不是**本机器人**开的"，用来防止同一个交易所账户下的
       * 多个机器人各自把账户的全部盈亏记到自己账上。
       *
       * 它**不**回答"这一回合是不是已经记过账了"。运行期从本地持仓行记的那一行
       * 完全属于这台机器人，闸门照样放行 —— 于是同一回合被记两次（实盘上
       * SYNUSDT 99/169、LSKUSDT 35 三组，凭空多出 +0.4954）。幂等由
       * `trades.insert()` 内部的身份判定负责（见 `trades.findDuplicate()`），
       * 而不是由这道闸门负责；两者的职责不要混。
       */
      /*
       * ⚠️ **历史行的单号可能被 `Number()` 改写过后三位 —— 用 `orderIdIn` 宽容一次。**
       *
       * 币安新版单号 19 位，而 2026-09-28 之前的解析用 `Number()` → 写进 `orders`
       * 的是被精度改写过的值（实测 `8389766285736312000` vs 真实 `8389766285736311569`）。
       * 严格的字符串相等会让那些回合**永远**被判成「外部活动」→ 账目告警每轮误报。
       * 详见 `orderIdIn()` 的注释。
       */
      const entryId = trip.entryOrderId ?? '';
      if (!orderIdIn(entryId, ownOrders)) {
        /*
         * ⚠️ **这里原来是一句 debug 日志 —— 而 debug 级日志不会被显示。**
         *
         * 于是"账户上有别人的交易"这件事从来没有在界面上出现过：
         * 操作员看到机器人赚了 0.32、账户少了 1.56，无法解释；
         * **AI 也看到同样的矛盾，而它连"账户上有外部交易"都不知道。**
         *
         * 现在按归属分两类，只有真正的外部活动才收集上报：
         * 属于别的机器人的是正常情况（共用账户），不该刷告警。
         */
        if (!orderIdIn(entryId, allOrders)) {
          /*
           * ⚠️ **`net` 必须把资金费算进来 —— 它原来漏了，而那是 0.2 USDT 的假差额。**
           *
           * 外部活动的净额原来写的是 `grossPnl - entryFee - exitFee`，少了
           * `funding`。而另一侧（`exchangeNet`）是对交易所 `income` 流水求和，
           * `FUNDING_FEE` **在里面**。于是总账校验拿两个不同口径去比：
           *
           *     gap = platformNet - exchangeNet = -（外部活动的资金费）
           *
           * 实测三个共用账户的机器人报出 **-0.2026 / -0.1962**，而同一账户上
           * 两个没有外部活动的机器人只有 ±0.006（浮点级）。差额全部来自这一个缺项，
           * 却被报成「平台的账本可能有漏记或重复记账」—— 又是一次**账本明明是对的、
           * 报警说它错了**。
           *
           * `funding` 在上面已经算好（`fundingInWindow`），这里只是把它减掉 ——
           * 与 `trades.insert()` 的 `净 = 毛 − 费 − 资金费` 完全同一个口径。
           */
          if (trip.entryOrderId) skipDiag.foreign += 1;
          else skipDiag.foreignNoId += 1;
          foreign.push({
            symbol,
            net: netPnlOf({ grossPnl: trip.grossPnl, fee: trip.entryFee + trip.exitFee, fundingFee: funding }),
            at: trip.closedAt,
          });
        } else {
          skipDiag.otherTrader += 1;
        }
        log.debug(
          `[${ctx.trader.name}] 跳过非本机器人开立的成交：${symbol} ${trip.quantity} @ ${trip.entryPrice}（入口订单 ${trip.entryOrderId || '未知'}）`,
        );
        continue;
      }

      const booked = tradeStore.insert({
        traderId,
        symbol: trip.symbol,
        side: trip.side,
        quantity: trip.quantity,
        entryPrice: trip.entryPrice,
        exitPrice: trip.exitPrice,
        leverage: ctx.leverageFor(symbol),
        grossPnl: trip.grossPnl,
        entryFee: trip.entryFee,
        exitFee: trip.exitFee,
        fundingFee: funding,
        closeReason: 'reconciled',
        openedAt: trip.openedAt,
        closedAt: trip.closedAt,
        source: 'reconciled',
        entryOrderId: trip.entryOrderId || null,
        exitOrderId: trip.exitOrderId || null,
        /*
         * ⚠️ **这个腿的全部出场单号 —— 判重靠它，不是靠上面那个"最后一个"。**
         *
         * 实测（2026-10-03，`#10` 的 MANAUSDT）：交易所是
         * `BUY 336 → SELL 168 → SELL 168`，**运行期按每次平仓各记了一笔**
         * （`#191` 168 + `#192` 168），而对账把整段看成一个 **336 的腿**。
         * 只看 `trip.exitOrderId`（= 最后一笔的单号）查不到 `#191`
         * （它记的是**第一笔**的单号），于是又插了一行 `#193` —— pnl 恰好
         * 等于前两笔之和，账目凭空多出 **1.5153 USDT**。
         *
         * 传全部单号之后，"任意一个已记账"就能命中，对账回到它该有的语义：
         * **只修正、不重复插入**。
         */
        exitOrderIds: trip.exitOrderIds,
        // 这是从交易所成交重建出的真实回合：同一回合已经记过就只修正，不再插一行。
        idempotent: true,
      });
      /*
       * 无论本次是"新插入"还是"命中已有行"，这条成交都已经被账本认领了，所以
       * 两个索引都要更新 —— 否则同一遍里第二笔长相相同的成交会绕过刚刚建立的
       * 认知（`byKey.set` 原来只在新插入时做，是因为那时没有第二种结果）。
       */
      byKey.set(key, booked.id);

      if (!booked.created) {
        /*
         * 这一回合运行期已经记过账了：`insert()` 认出并返回了那一行。
         * 这里**不算补录、也不播报补录** —— 账本一行没多，"补录了 N 笔"的日志
         * 会让操作员以为发生过漏记，而漏记才是需要警惕的信号。
         *
         * 但要把交易所的权威口径写到那一行上（§2.5 的"只修正"）：运行期是从本地
         * 持仓行记的，数量与手续费口径都比成交记录粗；不修正，账本就停在一个
         * 与账户对不上的数字上。
         */
        const figureWrite = tradeStore.applyExchangeFigures({
          id: booked.id,
          grossPnl: trip.grossPnl,
          entryFee: trip.entryFee,
          exitFee: trip.exitFee,
          fundingFee: funding,
          entryPrice: trip.entryPrice,
          exitPrice: trip.exitPrice,
          quantity: trip.quantity,
          leverage: ctx.leverageFor(symbol),
          entryOrderId: trip.entryOrderId || null,
          exitOrderId: trip.exitOrderId || null,
        });
        /*
         * ⚠️ 与上面那条 `applyExchangeFigures` 同一个口径（见 `correctedAttempted` 的说明）：
         * **只有真的覆盖了才算"生效"**。这一条的日志原来固定说"只修正不重复插入"，
         * 而在"边界存疑"时它其实一个字都没改 —— 一句话把两种完全不同的结果说成了一种。
         */
        correctedAttempted += 1;
        if (figureWrite.applied) corrected += 1;
        else keptForBoundary += 1;
        log.debug(
          `[${ctx.trader.name}] 对账发现 ${symbol} 的这一回合已在账上（第 #${booked.id} 笔）：` +
            (figureWrite.applied
              ? '已按交易所口径修正，不重复插入。'
              : `重建出的腿边界不可信（重建 ${trip.quantity} vs 本地 ${figureWrite.keptLocalQuantity}）—— 本轮未覆盖它，继续保留本地口径。`),
        );
        continue;
      }

      recovered += 1;

      const net = netPnlOf({ grossPnl: trip.grossPnl, fee: trip.fee, fundingFee: funding });
      ctx.emit(
        'warn',
        `对账补录了一笔未被记录的成交：${trip.symbol} ${trip.side === 'long' ? '多头' : '空头'} ` +
          `${trip.quantity} @ ${trip.entryPrice} → ${trip.exitPrice}，净 ${net >= 0 ? '+' : ''}${net.toFixed(4)} USDT。` +
          '（平仓发生在机器人未运行时，已从交易所成交记录恢复）',
      );
    }
  }

  /*
   * Settle local position rows the exchange no longer holds.
   *
   * `reconcilePositions` does this during a cycle, but it needs the position to
   * still be open locally *and* a cycle to run. Doing it here as well means a
   * trader that was stopped mid-position does not come back believing it still
   * holds something.
   *
   * **It must book the round-trip, not merely close the row.** This loop used
   * to call `positionStore.close()` directly and book nothing: the local row
   * disappeared while the exchange still held a finished entry+exit round-trip,
   * so the trade never reached `trades` — a position closed by an exchange-side
   * stop during downtime was dropped from the ledger entirely, and the
   * platform's PnL read better than the account's (§2.3). Worse, this pass runs
   * at the *head* of every cycle, before `reconcilePositions`, so it could
   * swallow a close that the later pass would have booked correctly.
   *
   * Booking it here is idempotent with `reconcilePositions`: closing the row
   * takes it out of `positionStore.open()`, so the later pass cannot book the
   * same round-trip twice.
   */
  /*
   * ⚠️ **读不到持仓 ≠ 交易所上没有仓位。**
   *
   * 这一行原来是 `getPositions().catch(() => [])`，于是**一次网络抖动 / 一次 5xx**
   * 就足以让 `liveSymbols` 变成空集，下面的循环随即把**每一个**本地持仓判成
   * "已在交易所消失" → `bookVanishedPosition()` 给它们各写一行 `trades`
   * （出场价取最近一笔成交、原因多半落到 `stop_loss`），再 `positionStore.close()`
   * 把真实持仓从本地账本抹掉。
   *
   * 两个后果都很重，而且方向相反：
   *   · **凭空记账**会永久污染账本，还会让后续对账的幂等判定（`findDuplicate`）
   *     命中那行假记录 —— `docs/AGENTS.md` §2.3 专门写过「漏记会在下一轮自己修好，
   *     而凭空记一笔会永久污染账本」；
   *   · **本地持仓被抹掉**，而交易所上的敞口还在 —— 机器人下一轮按"空仓"决策，
   *     那正是 §2.6 说的最糟状态。
   *
   * 所以拉不到就**整段跳过**：少记一轮没有代价（下一轮会补上），凭空记一笔没有救。
   *
   * ⚠️ **模拟盘整段跳过**（2026-10-15）—— 见 `reconcilePositions` 顶部那段：
   * 交易所的持仓列表在模拟盘上**不是真相来源**（那里从来没有它的仓位）。
   * 拿它当判据会把每一个本地持仓都判成"已消失"。
   * 模拟盘的持仓结算由 `settleDryRunPositions()` 负责（对着标记价判保护单）。
   */
  let livePositions: ExchangePosition[] | null = null;
  if (!ctx.isDryRun) {
    try {
      livePositions = await ctx.getPositions();
    } catch (error) {
      ctx.emit(
        'warn',
        `读不到交易所持仓（${(error as Error).message}）—— 本轮跳过"持仓消失"的核对，` +
          '避免把网络故障当成已平仓而凭空记账。',
      );
    }
  }

  if (livePositions !== null) {
    const liveSymbols = new Set(livePositions.map((p) => p.symbol));
    for (const local of positionStore.open(traderId)) {
      if (!liveSymbols.has(local.symbol)) {
        await ctx.bookVanishedPosition(local);
      }
    }
  }

  /*
   * Refresh the display snapshot — 但**只给在跑的机器人**刷新。
   *
   * 这一段原来存在的理由：`computeTraderStats` 读最近一条快照，而一个已停止的
   * 机器人不再写快照，于是它的显示权益冻在最后一次周期那一刻。实盘上那次是
   * 显示 9.6213 而真实余额 10.2586 —— 利润是在机器人停下**之后**到的账。所以
   * 「对账时顺手写一条」在当时是对的。
   *
   * 但它同时是一个 bug 的一半：这一遍也会在一个**已停止**的机器人上跑（控制台的
   * 「对账」按钮、以及启动前的这一遍），而它当时写进去的是 `account.equity` ——
   * **共享钱包**的余额。同账户下每个机器人的快照因此都被刷成同一个数：一个从未
   * 成交的机器人显示别人的收益率，而一个已停止的机器人的数字会随着邻居继续交易
   * 而变动。**停止的机器人，历史必须停止移动。**
   *
   * 所以：只有循环是活的（`ctx.isRunning()`）或者这一遍本身就在一个进行中的周期里
   * （`ctx.isCycleInFlight()`）时才写。停止状态下点「对账」不再改动任何机器人快照；
   * 而"账刚对上就要显示新数字"这件事没有丢 —— `computeTraderStats` 在读取时按
   * 归属口径从 `trades` 现算权益，这一遍刚补录的成交立刻就会出现在控制台上，
   * 根本不需要一条新快照。
   */
  if (ctx.isRunning() || ctx.isCycleInFlight()) {
    try {
      const account = await ctx.getAccountState();
      const livePositions = await ctx.getPositions().catch(() => []);
      /*
       * ⚠️ **走 `recordEquity()`，不要直接 `equityStore.insert()`。**
       *
       * 这里原来是直接插入的，于是它绕过了"完全重复的快照不记"那条判定 ——
       * 而它**每一轮深对账都会跑**（`FULL_RECONCILE_EVERY_PASSES = 24`，
       * 外加启动前与控制台按钮），所以它正是那些"连续 64 条一模一样的
       * 21.9669"的主要来源之一。
       *
       * 统一走同一个方法还有第二个好处：它会发 `eventBus` 的 `equity` 事件，
       * 而这条路径原来不发 —— 同一个动作在两个入口下行为不同，是下一类 bug 的温床。
       */
      await ctx.recordEquity(account, livePositions);
    } catch (error) {
      log.debug(`[${ctx.trader.name}] 对账后写入权益快照失败：${(error as Error).message}`);
    }
  }

  /*
   * ⚠️ **这条日志必须能区分三种结果，而不是只报一个笼统的"修正 N 笔"。**
   *
   * 线上实测的形状（用户报「每次都是修正 50 笔」）：`corrected` 原本数的是"试过几次"，
   * 而其中**每一笔都被内部拒掉**（重建腿边界不可信 ⇒ 整行保留本地）—— 于是操作员
   * 看到的是一个恒定的假数字，而真相是"这 50 笔每一轮都判不出来"。
   *
   * 所以：尝试 / 生效 / 判不出来，三个数都要在日志里。第三个数不是失败，而是
   * **需要人来判断的边界**（要么重建窗口不够，要么本地那一行才是对的）——
   * 只要它非零，下一轮还会撞上同一批，这条日志就该让人一眼看出"账本没有被修正"。
   */
  if (recovered > 0 || corrected > 0 || keptForBoundary > 0) {
    log.info(
      `[${ctx.trader.name}] 对账完成：补录 ${recovered} 笔，` +
        `尝试修正 ${correctedAttempted} 笔（生效 ${corrected} 笔 · 因边界存疑保留本地 ${keptForBoundary} 笔），` +
        `资金费合计 ${fundingTotal.toFixed(6)} USDT`,
    );
  }
  if (keptForBoundary > 0 && corrected === 0) {
    /*
     * 全军覆没才升级成 warn：这一轮**号称在修正、实际一笔都没改**。
     * 只报 info 会让它混在正常的"修正 N 笔"里看不出异常（那正是这次要修的病灶）。
     */
    log.warn(
      `[${ctx.trader.name}] 本轮对账尝试修正 ${correctedAttempted} 笔，` +
        `但**一笔都没真的生效** —— 全部因"重建腿边界存疑"保留本地口径。` +
        '这通常意味着成交历史的窗口起点落在持仓中间（重建把开/平判反、整条序列错位），' +
        '或是这些行本来就是对的而重建是错的。请对照交易所成交明细核查，不要当它已经修好了。',
    );
  }

  /*
   * 交易所已经不再挂着的本地委托行，也要在这一遍里结清。
   *
   * 位置放在"消失的持仓已经记账"之后：一张触发成交的止损，先要有人把那一回合记进
   * `trades`，再谈它自己的状态；而"这个标的是否还持仓"正是那一段刚更新过的东西。
   * 详见 `settleStaleOrders()`。
   */
  await ctx.settleStaleOrders().catch((error) => {
    // 记账失败不能影响这一遍对账的结论（它已经写完了），更不能把异常抛给周期。
    log.warn(
      `[${ctx.trader.name}] 结清本地委托记录失败（不影响本周期交易）：${(error as Error).message}`,
    );
  });

  /*
   * ── 外部交易活动 ──────────────────────────────────────────────────
   *
   * 到这一步 foreign 里装的是**不属于本平台任何机器人**的成交。
   * 它们不是"别人的机器人"（那种是共用账户的正常情况），而是这个账户上
   * 有本平台之外的东西在交易 —— **它产生的盈亏直接从余额里进出，而账面看不见**。
   *
   * 这正是「机器人显示一直在挣钱、账户却在缩水」的成因，也是 AI 无法
   * 解释的那个矛盾。所以必须上报，不能只写 debug。
   */
  const foreignNet = Number(foreign.reduce((sum, r) => sum + r.net, 0).toFixed(6));
  const foreignSymbols = [...new Set(foreign.map((r) => r.symbol))];
  /*
   * 持久化：这一页要在**机器人停止之后**仍然能显示它 —— 而停止之后
   * 就不会再跑对账了，只放在内存里等于关掉页面就没了。
   */
  settings.set(
    `foreign_activity:${traderId}`,
    JSON.stringify({
      rounds: foreign.length,
      net: foreignNet,
      symbols: foreignSymbols.slice(0, 20),
      firstAt: foreign[0]?.at ?? null,
      lastAt: foreign[foreign.length - 1]?.at ?? null,
      detectedAt: new Date().toISOString(),
    }),
  );

  /*
   * ── 总账校验 ──────────────────────────────────────────────────────
   *
   * 到这里 `incomeEvents`（交易所权威流水）与 `foreign`（外部活动）都在手上，
   * 正好可以做一次**总账级**的对账 —— 它回答「平台整体记的账，与交易所实际
   * 发生的，能不能对上」。
   *
   * 这是唯一能**自动**发现「机器人显示在挣钱、账户却在缩水」这类故障的地方：
   * 账本自己不会说自己错了，只有拿它和权威流水比才知道。
   */
  /*
   * ⚠️ **非结算资产计价的手续费也要从「交易所侧」排除**（§2.5 同一条口径）。
   *
   * 平台侧（`trades.fee`）已经只含 USDT/USDC；而 `income` 流水的 `COMMISSION`
   * 事件在 BNB 抵扣时 `asset = 'BNB'`、`income` 是 BNB 数量。不过滤的话两边
   * 口径不同，这条本来该报「真的账目错了」的告警会带着一段固定差额永久响，
   * 进而被操作员忽略 —— 那比不校验更糟。
   */
  let foreignCommission = 0;
  const exchangeNet = incomeEvents.reduce((sum, e) => {
    /*
     * 只算交易口径。`TRANSFER`（入金/出金）不是盈亏 ——
     * 把它算进来会让「刚充过钱」看起来像「赚了钱」。
     * 未知的 incomeType 也一并跳过：宁可不计入，也不要凭猜归类。
     */
    if (
      e.incomeType !== 'REALIZED_PNL' &&
      e.incomeType !== 'COMMISSION' &&
      e.incomeType !== 'FUNDING_FEE'
    ) {
      return sum;
    }
    if (e.incomeType === 'COMMISSION' && !isSettlementAsset(e.asset)) {
      foreignCommission += Math.abs(Number(e.income) || 0);
      return sum;
    }
    return sum + (Number(e.income) || 0);
  }, 0);
  if (foreignCommission > 0) {
    ctx.emitOnChange(
      'ledger:foreign-commission',
      'warn',
      `交易所流水里有以非结算资产计价的手续费（合计 ${foreignCommission.toFixed(8)}，通常是 BNB 抵扣），` +
        '已从「交易所净额」中排除。平台侧只记 USDT 口径 —— 两边必须同口径，' +
        '否则这条差额告警会带着一段固定偏差永久响。',
    );
  }
  
  /* 平台侧：所有机器人的已实现净额 + 外部活动净额。 */
  /*
   * ⚠️ **平台侧必须与交易所侧用同一个时间窗。**
   *
   * `incomeEvents` 是 `since` 之后的（币安的收入接口必须给窗口），
   * 所以这里也要用 `netSince(sinceIso)` 而不是"全部历史" ——
   * 否则差额里会混进窗口之外的历史交易，**那会永久误报**。
   *
   * 实测：用全部历史时这个账户报出 −0.86 的假差额，
   * 而真实差值是 0.0057（窗口边界的浮点误差）。
   * **一个永久误报的校验比没有校验更糟** —— 它会训练操作员忽略这条告警，
   * 而这是唯一能自动发现"账本错了"的地方。
   */
  /*
   * 分两项存下来，**不只是为了好看**。
   *
   * 原来这里只有 `platformNet` 一个汇总值。于是当差额出现时，能看到的只有
   * "差 0.2" —— 而它可能是本机器人的成交记错了、也可能是外部活动那侧漏了，
   * 两种原因的修法完全不同，光看汇总值无从判断。
   *
   * 实测的代价：我按"外部活动漏算资金费"改了一版，部署、对账、`checkedAt`
   * 是新的、`gap` 一模一样 —— **因为没有任何一项能告诉我改动到底作用在哪一侧**，
   * 只能再从头推一遍。把分项存下来，这个问题下次当场就答完了。
   */
  /*
   * 纯模拟盘（没有交易所账户）**没有交易所侧可对** —— `netSinceForAccount`
   * 按账户聚合，而没有账户就没有这个维度。这类机器人跳过整段总账校验：
   * 它的账全部来自本地台账，不存在"与交易所流水对不上"这回事。
   *
   * ⚠️ 模拟盘但**绑定了**账户的机器人仍然会走到下面 —— 那时账户是存在的，
   * 只是交易所流水里没有它的单（那些单从来没发出去），所以校验结果会如实地
   * 报出差额。这是对的：它如实描述了"模拟单不在交易所流水里"这个事实。
   */
  const accountId = ctx.trader.exchangeAccountId;
  if (accountId === null) {
    /* 没有账户 = 没有交易所流水可对；外部活动那几项也一并记 0。 */
    return {
      recovered: 0,
      corrected: 0,
      correctedAttempted: 0,
      correctedKept: 0,
      funding: 0,
      foreignRounds: foreign.length,
      foreignNet: foreignNet,
    };
  }
  const platformSelf = tradeStore.netSinceForAccount(accountId, sinceIso);
  /*
   * ⚠️ **未平仓的持有成本必须加在平台侧，否则这个校验会永久误报。**
   *
   * 交易所流水从**开仓那一刻**就有 `COMMISSION`、持仓期间还有 `FUNDING_FEE`；
   * 而 `trades` **只在平仓时**记一笔。只要有持仓，「平台净额」就天然比
   * 「交易所流水」少一个"还拿在手上的那些仓位的持有成本"。
   *
   * 实测：两条告警的差额 `0.0119` / `0.0202` 正好是当时那两个仓位的入场手续费
   * （ETH `0.0118539` + HYPE `0.00837404` = `0.0202`）—— **一个纯粹的口径差
   * 被报成了"账本可能有漏记或重复记账"**。
   *
   * 两侧必须同口径，否则这个校验的每一次响都是假的，而它本该是唯一能自动发现
   * "账本真的错了"的地方（实测它确实抓到过那次 0.17 的重复记账）。
   */
  /**
   * 未平仓仓位的持有成本，**两个符号不同，必须分开返回**。
   *
   * ## ⚠️ 2026-10-03：这里原来把两者相加成一个 `openCosts`，然后在
   * `platformNet` 里用 `+ openCosts` —— **符号对了一半，于是平台侧被高估
   * 两倍的手续费**。
   *
   * 实测现场（`#10`，两个持仓）：
   *
   * ```text
   * 交易所：毛 -0.6479 · 费 0.307327（含未平仓开仓费 0.054795）
   *       ⇒ 已平仓部分费用 = 0.252532，而本地账本的 fee 正是 0.252532
   * 本地已平仓净额 platformSelf = -0.900432
   * 正确：-0.900432 − 0.054795 = -0.955227 = 交易所净额 ✅
   * 实际：-0.900432 + 0.054795 = -0.845637 ⇒ gap 0.109590 = 2 × 0.054795 ❌
   * ```
   *
   * **手续费是支出、正数** ⇒ 要从平台净额里**减**；
   * **资金费在币安 `income` 里本身就是负数**（`FUNDING_FEE -0.013888`）⇒ 用**加**。
   * 混在一个数里用一个符号，必错一个。
   */
  const openHoldings = ((): { entryFees: number; funding: number } => {
    try {
      /*
       * 与 `netSinceForAccount` / `exchangeNet` 同一账户级口径：汇总该交易所账户下
       * 所有机器人当前的未平仓持仓（含同仓位后续加仓的入场手续费与持仓期资金费），
       * 避免多机器人共用账户或加仓后在总账校验里报出假差额。
       */
      const accountId = ctx.trader.exchangeAccountId;
      const openPositions =
        typeof accountId === 'number' && accountId > 0
          ? positionStore.openForAccount(accountId)
          : positionStore.open(traderId);
      const funding = openPositions.reduce(
        (sum, p) => sum + fundingSince(incomeEvents, p.symbol, p.opened_at),
        0,
      );
      return {
        entryFees: orderStore.openEntryCostsForAccount(openPositions),
        funding,
      };
    } catch {
      /* 读不到就按 0：宁可这一轮差一点，也不要让对账整个失败。 */
      return { entryFees: 0, funding: 0 };
    }
  })();
  const openEntryFees = openHoldings.entryFees;
  const openFunding = openHoldings.funding;
  const openCosts = openEntryFees + openFunding;
  /*
   * 手续费**减**、资金费**加**（它本身就是负数）—— 见 `openHoldings` 的说明。
   */
  const platformNet = platformSelf + foreignNet - openEntryFees + openFunding;
  const ledgerGap = Number((platformNet - exchangeNet).toFixed(6));

  /*
   * 权益 —— 容差要随账户规模缩放（见 `ledgerGapTolerance`）。读不到就退回 0，
   * 那时只用绝对容差，而不是让对账本身失败。
   */
  const equityForTolerance = ((): number => {
    try {
      const [latest] = equityStore.list(traderId, 1);
      return typeof latest?.equity === 'number' && Number.isFinite(latest.equity) ? latest.equity : 0;
    } catch {
      return 0;
    }
  })();
  
  /*
   * ⚠️ **容差必须随账户规模缩放 —— 固定 1 美分在两个方向上都是错的。**
   *
   * ## 实测（2026-10-02 03:00）
   *
   * 权益 21.92 的账户报出差额 **0.0101** —— 只比原来那个固定值 0.01 多
   * **0.0001 美元**，却挂起一条 ERROR 级"账目与交易所对不上"。
   * 而它对应的真实相对偏差是 **0.046%**，远在噪声范围里
   * （开仓那一刻的持有成本口径差异就足够产生它）。
   *
   * ## 为什么固定阈值在两端都会失效
   *
   *   · **小账户**：1 美分是 0.046%（$21.92）—— 日常口径噪声就能触发，
   *     于是这条告警变成背景噪声，**真的漏记出现时没人再看它**；
   *   · **大账户**：1 美分是 0.0001%（$10,000）—— 一笔漏记可能远大于它，
   *     但"大于 1 美分"这条线根本拦不住，**该报的没报**。
   *
   * 所以取"绝对 1 美分"与"权益的 0.1%"里**较大**的那个：
   * 小账户按相对值放宽（消除噪声），大账户按相对值收紧（抓住真漏记）。
   *
   * 原来的注释说"任何一笔真实的漏记/错记都大于 0.01"—— 那句话在**这个账户规模**上
   * 曾经成立，但它把"账户有 22 美元"这个前提写死进了阈值。
   */
  const LEDGER_GAP_TOLERANCE = ledgerGapTolerance(equityForTolerance);
  settings.set(
    `ledger_check:${traderId}`,
    JSON.stringify({
      platformNet: Number(platformNet.toFixed(6)),
      exchangeNet: Number(exchangeNet.toFixed(6)),
      gap: ledgerGap,
      /*
       * 两个分项。差额出现时，"本机器人的成交"与"外部活动"哪一侧出的问题，
       * 看这两个数就知道 —— 而它们的修法完全不同。
       */
      platformSelf: Number(platformSelf.toFixed(6)),
      foreignNet: Number(foreignNet.toFixed(6)),
      foreignRounds: foreign.length,
      /* 未平仓的持有成本（加在平台侧的那个数）—— 它长期是差额的主要来源。 */
      openCosts: Number(openCosts.toFixed(6)),
      /*
       * ⚠️ **两个分量要分开存**（2026-10-03）。
       *
       * `openCosts` 是"未平仓入场手续费 + 资金费"相加后的一个数，而**两项的符号
       * 不同**（手续费正、资金费负）—— 只存汇总值时，`gap` 一旦不为 0，
       * 看的人分不清是"这一项没算进去"还是"符号用错"（两者差一个因子 2）。
       * 实测就是栽在这里：`+ openCosts` 让平台侧高估了两倍手续费，
       * 而落库的 `openCosts: 0.054795` 看起来完全正常。
       */
      openEntryFees: Number(openEntryFees.toFixed(6)),
      openFunding: Number(openFunding.toFixed(6)),
      skipDiag,
      /*
       * 反向回合**已记账**的净额合计（2026-10-03 起）。
       *
       * 这些钱已经落在 `platformSelf` 里，所以**不再**加到 `platformNet` 上
       * （加了就是重复计）。它单独存下来只为回答一个问题：
       * 「这一轮账本里有多少来自"方向不可信、金额可信"的行」——
       * 那个数大，说明成交历史窗口覆盖不足，值得去查，而不是账目坏了。
       */
      reversedBookedNet: Number(reversedBookedNet.toFixed(6)),
      // 让落库的数据自己说清这一轮算不算数（读失败时 exchangeNet 是 0，不是"真的 0"）。
      incomeReadFailed,
      checkedAt: new Date().toISOString(),
    }),
  );
  
  /*
   * ⚠️ **读不到流水就不要下"账本错了"这个结论。**
   *
   * `incomeEvents` 为空的两种情况含义完全不同：**账户上真的没有流水**，
   * 与**这一次没读到**。只有前者支持"账目对不上"的判断；后者什么也说明不了 ——
   * 拿 0 去比只会得到一个假差额，而这条告警的价值恰恰在于它稀有一响。
   */
  if (!incomeReadFailed && Math.abs(ledgerGap) > LEDGER_GAP_TOLERANCE) {
    /*
     * ⚠️ **这条告警比外部活动那条更严重。**
     *
     * 外部活动只是"账户上有别人的交易"，而账本本身是对的。
     * 这里是**账本本身与交易所对不上** —— 意味着平台记录的盈亏不可信，
     * 而 AI 正是照着它做决策的。
     *
     * ## 为什么第四个参数是固定的 `'ledger-gap'`
     *
     * 句子里带着四个会变的数字，而 `emitOnChange` 的"状态没变就不再记"是拿
     * **整条文本**比的 —— 于是差额每变一次就重记一条。实测：从 17:17 到 18:32
     * **上百条一模一样的 error**，而它们说的都是同一件事。
     *
     * 传一个稳定键之后：**状态真的解除时由 `clearStateNotice()` 清掉**，
     * 下次再出现才重新记。这既保住了"稀有一响"的分量，也不丢信息 ——
     * 差额的精确数值在 `ledger_check:` 里一直存着。
     */
    ctx.emitOnChange(
      "ledger-gap",
      "error",
      `账目与交易所对不上：平台记录 ${platformNet.toFixed(4)} USDT、` +
        `交易所流水 ${exchangeNet.toFixed(4)} USDT，差 ${ledgerGap.toFixed(4)}。` +
        `（平台侧已含未平仓的持有成本 ${openCosts.toFixed(4)}。）` +
        /*
         * ⚠️ **把两项写进告警本身，而不是只留在 `ledger_check` 里。**
         *
         * 那段注释记着一次真实的返工：「我按'外部活动漏算资金费'改了一版，部署、
         * 对账、`checkedAt` 是新的、`gap` 一模一样 —— **因为没有任何一项能告诉我
         * 改动到底作用在哪一侧**，只能再从头推一遍。」
         *
         * 那句话说的正是这条告警：它只报一个汇总差额，于是读它的人（人也好、AI 也好）
         * **无从判断该查哪一侧** —— 而两侧的修法完全不同：
         *
         *   · **本机器人那一项**偏高/偏低 → 账本真的漏记或重复记账（严重）；
         *   · **外部活动那一项**对不上 → 那是由交易所成交历史**重建**出来的估算，
         *     口径与运行期记账天然不同（多数情况出在这里）。
         *
         * 实测那台机器人：本机器人侧 `1.30048` 与 `trades` 净额合计**一字不差**，
         * 而外部活动估出 `-0.2134`、实际约 `-0.0298` —— 差额全在估算那一侧。
         * 把这两项打在告警里，"哪一侧"这个问题当场就答完了。
         */
        `【本机器人成交 ${platformSelf.toFixed(4)}` +
        (Math.abs(foreignNet) > 1e-9
          ? ` · 账户上不属于本机器人的成交（重建估算）${foreignNet.toFixed(4)}`
          : '') +
        `】` +
        `先看括号里后一项 —— 它由交易所成交历史重建，口径与运行期记账不同，` +
        `偏差通常出在那里；如果**本机器人那一项**与交易所的差也在容差之外，` +
        `才是账本本身漏记或重复。`,
      'ledger-gap',
    );
  } else {
    ctx.clearStateNotice("ledger-gap");
  }
      if (foreign.length > 0) {
    /*
     * 符号列表**排过序**再用 —— 见下面 `emitOnChange` 的说明：
     * 状态键里任何会自己变化的东西都会让"状态没变就不再记"失效。
     */
    const list = [...foreignSymbols].sort().slice(0, 6).join("、");
    const more = foreignSymbols.length > 6 ? " 等" : "";
    /*
     * 按**状态变化**记，不是每轮都记：这是一个会持续成立的状态
     * （外部程序一直在跑），每轮刷一条会把日志淹掉。
     *
     * ⚠️ **但这条规则原来并没有生效**，因为"变化"是按**整条文本**比的
     * （见 `emitOnChange`），而这段文本里带着浮点净额 —— 外部活动一直在发生时
     * 它每轮都在变，于是每一轮都算"变了"。
     *
     * 实测：2000 行日志里同一条警告出现了 **232 次**（五个机器人各报几十次）。
     * 到第 200 次，操作员就再也看不见它了 —— **而那正是真出事时该被看见的那条**。
     *
     * 现在只把**离散量**（笔数 + 排序后的标的）放进文本。净额与完整标的列表
     * 仍然写在 `foreign_activity` 台账里，控制台的「交易所账户」那一行与
     * AI 的提示词读的是那一处 —— 需要精确数字的地方不缺它。
     *
     * 文案也去掉了「请立刻检查账户安全」：控制台那边已经因为"那块警示
     * **假设了恶意**"把它降级成了安静说明（见 `TraderPage.tsx` 里的注释）。
     * 同一个事实在两个地方用两种语气，只会让人不知道该信哪个。
     */
    ctx.emitOnChange(
      "foreign-activity",
      "warn",
      `账户上发现 ${foreign.length} 笔不属于本平台的成交（涉及 ${list}${more}）。` +
        "这些盈亏直接从交易所余额进出、不计入本机器人的绩效。" +
        "标的与净额见控制台的「交易所账户」那一行。",
    );
  } else {
    /* 外部活动消失（或本来就没有）时清掉状态，否则会永远挂着一个旧告警。 */
    ctx.clearStateNotice("foreign-activity");
  }
  
  return {
    recovered,
    corrected,
    correctedAttempted,
    correctedKept: keptForBoundary,
    funding: fundingTotal,
    foreignRounds: foreign.length,
    foreignNet,
  };
}
