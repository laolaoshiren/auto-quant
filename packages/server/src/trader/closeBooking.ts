/**
 * 平仓记账核心模块（从 `autoTrader.ts` 阶段 2b 纯搬抽出，行为零变化）：
 * - 开仓手续费读取（`entryFeeForOrder`）
 * - 模拟盘往返手续费估算（`dryRunRoundTripFeeForTrader`）
 * - 平仓入账与本地仓位关闭（`bookClosedPositionForTrader`）
 * - 持仓窗口资金费与手续费流水读取（`fundingForWindow` / `commissionsForWindow`）
 * - 交易所往返成交定位（`findRoundTripForPosition`）
 */
import {
  closeReasonLabel,
  type CloseReason,
  type StrategyConfig,
  type Trader,
} from '@aq/shared';
import type { BinanceUserTrade } from '../binance/types.js';
import {
  commissionsInWindow,
  fundingInWindow,
  netPnlOf,
} from '../binance/income.js';
import {
  countFundingSettlements,
  estimatePaperFundingFee,
} from '../binance/paperWallet.js';
import { eventBus } from '../events.js';
import { createLogger } from '../logger.js';
import { managedNotesStore } from '../managed/notes.js';
import { managedThesisStore } from '../managed/thesis.js';
import { managedAttributionStore } from '../radar/attribution.js';
import {
  orders as orderStore,
  positions as positionStore,
  runInTransaction,
  shouldTrustReconciledQuantity,
  tradeEvents,
  trades as tradeStore,
} from '../store/repositories.js';
import type { BrokerPort } from './brokerPort.js';
import {
  reconstructRoundTrips,
  roundTripQueryKey,
  type ReconstructedTrade,
} from './roundTrips.js';
import { parseIntelKeysOf, type AgentHook } from './autoTrader.js';

const log = createLogger('trader');

type PositionRow = ReturnType<typeof positionStore.open>[number];

export interface CloseBookingContext {
  trader: Trader;
  isDryRun: boolean;
  effectiveConfig: () => StrategyConfig;
  emit: (level: 'info' | 'warn' | 'error', message: string) => void;
  settlementFeeOf: (fills: readonly BinanceUserTrade[], symbol: string) => number;
  getUserTrades: BrokerPort['getUserTrades'];
  getIncome: BrokerPort['getIncome'];
  getMarkPrice: BrokerPort['getMarkPrice'];
  getFundingRate?: (symbol: string) => Promise<number | null>;
  agent?: AgentHook;
}

export async function entryFeeForOrder(ctx: CloseBookingContext, symbol: string, orderId: string): Promise<number> {
  try {
    const fills = await ctx.getUserTrades(symbol, 20);
    const mine = fills.filter((f) => String(f.orderId) === String(orderId));
    if (mine.length === 0) return 0;
    /* 同上：按结算资产口径取，BNB 抵扣不进 USDT 的 `fee`。 */
    return Math.abs(ctx.settlementFeeOf(mine, symbol));
  } catch {
    /* 拿不到就按 0：宁可这一列暂时空着，也不要让开仓整个失败。 */
    return 0;
  }
}

/**
 * **模拟盘的往返手续费估算** —— `dryRun` 下所有平仓路径共用这一份。
 *
 * ## 为什么模拟盘必须按全额估（2026-11-09，行为变更）
 *
 * 模拟盘没有真实成交回报，`getUserTrades()` 返回空 —— 于是"按成交明细取手续费"
 * 的几条路径（`executeClose` / `emergencyFlatten` / 减仓）全都把手续费记成 **0**，
 * 而 `closeManually` 只记了半程。**成本被系统性低估 = 模拟收益被系统性高估**：
 * 一个在高费率山寨上高频往返的策略，在模拟盘上看起来比实盘好赚得多，
 * 而后续开发**以本地模拟盘为主**（用户 2026-11-09 的指示）—— 那样评估出来的
 * 策略一文不值。
 *
 * ⇒ 统一按策略里已有的 `fallbackRoundTripFeeRate`（默认 0.001 = 0.1%）估算
 * **整趟往返费**，再对半拆到 entry / exit 两侧。**保守口径**：模拟盘宁愿把成本
 * 估高一点，也不要让它看起来比实盘容易赚。
 *
 * ## 口径（与 `settleDryRunPositions` 完全一致）
 *
 * ```
 *   total    = 出场名义价值 × 往返费率
 *   exitFee  = total / 2
 *   entryFee = total − exitFee     （先算整趟再对半拆 → 两侧之和恒等于 total）
 * ```
 *
 * ⚠️ **只在 dry-run 下调用**：实盘的手续费必须来自交易所成交明细，不能估。
 * 调用点一律长成 `if (ctx.isDryRun) { … }`，实盘那一支逐字节不变。
 */
export function dryRunRoundTripFeeForTrader(ctx: CloseBookingContext, exitPrice: number, quantity: number): { entryFee: number; exitFee: number } {
  const total = exitPrice * quantity * ctx.effectiveConfig().riskControl.fallbackRoundTripFeeRate;
  const exitFee = total / 2;
  return { entryFee: total - exitFee, exitFee };
}

/**
 * 把"模拟盘估算的开仓侧手续费"包成 `bookClosedPosition` 的可选参数。
 *
 * `undefined` = 不估（实盘，或该路径没有估算值）→ `bookClosedPosition` 的行为
 * 与改动前逐字节一致。
 */
export function entryFeeExtra(
  entryFee: number | undefined,
): { entryFeeFallback: number } | undefined {
  return entryFee === undefined ? undefined : { entryFeeFallback: entryFee };
}

/** Persist a trade and mark the local position closed. */
export async function bookClosedPositionForTrader(
  ctx: CloseBookingContext,
  local: PositionRow,
  reason: CloseReason,
  exitPriceInput: number,
  exitFeeInput: number,
  /** Exchange fill time, when known. Funding is attributed to the real window. */
  closedAtInput?: string,
  /**
   * 交易所成交明细不可用时的**开仓侧手续费**（回退路径专用）。
   *
   * 实盘回退时它保持缺省 0 —— 真正的开仓费只能从成交明细里取，取不到就不编。
   * 模拟盘没有成交明细，但它的往返成本是按策略费率**估**出来的，于是可以
   * （也应该）把估算值按两侧拆开传进来 —— 见 `settleDryRunPositions()`。
   * 有 `authoritative`（交易所重建值）时本参数被忽略：那时两侧费用以交易所为准。
   */
  extra?: { entryFeeFallback?: number; exitOrderId?: string | null },
): Promise<{ netPnl: number; grossPnl: number; exitPrice: number; quantity: number }> {
  const traderId = ctx.trader.id;

  /*
   * Prefer the exchange's own accounting for this round-trip.
   *
   * Its `realizedPnl` is authoritative, and reconstructing the round-trip from
   * the fills is the only way to see **both** legs' commission — the live path
   * previously recorded just the exit leg, understating costs by about half.
   * Falls back to the local arithmetic when the fills are unavailable.
   */
  const authoritative = await findRoundTripForPosition(ctx, local).catch(() => null);
  const closedAt = authoritative?.closedAt || closedAtInput || new Date().toISOString();

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **离场价优先用【本地已知值】，不是交易所重建值**
   *      （2026-10-20 实盘抓到：日志说亏 18.39，账面只亏 2.55）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 症状
   *
   * ```
   *   10:49:43  订单 BRUSDT SELL MARKET FILLED 数量=88@0.68615     ← 真实成交价
   *   10:49:48  已平仓 BRUSDT 多头 @ 0.50545 → 净 -18.3880 USDT   ← 日志
   *   trades   表：入场 0.71437557 → 离场 0.68615，净 -2.5455      ← 账面
   * ```
   * **日志与账面差 7 倍。** 操作员看到"亏 18.39"会以为账户被打穿了。
   *
   * ## 根因
   *
   * `findRoundTrip()` 从**交易所历史成交**重建往返。而 BRUSDT 是高频标的，
   * 交易所那一侧同时存在**别的回合的成交**（也包括不属于本机器人的成交 ——
   * 见同一轮日志里那条「账户上发现 100 笔不属于本平台的成交」）。
   * 重建把那些混进来，得到一个**不属于这一笔的离场价**（0.50545）。
   *
   * ## 修法
   *
   * 调用方传进来的 `exitPriceInput`（来自即时成交回报 `FILLED 数量=88@0.68615`）
   * 是**这一笔自己的成交价**，它比"从历史里重建"更直接、更可信。
   * ⇒ 顺序倒过来：先用本地已知值，缺失时才回落到重建值。
   *
   * ⚠️ **`grossPnl` 的算法不改**：那里用 `authoritative` 是为了拿到
   * **两条腿的手续费**（见上面那段注释）—— 那是另一个问题，
   * 且它与账面的偏差由 `bookTrade()` 的净额兜底。
   * 这次只修**展示给操作员看的那个价格**。
   */
  let exitPrice = exitPriceInput > 0 ? exitPriceInput : (authoritative?.exitPrice ?? 0);
  if (!(exitPrice > 0)) {
    exitPrice = await ctx.getMarkPrice(local.symbol).catch(() => 0);
  }
  if (!(exitPrice > 0)) {
    ctx.emit('warn', `无法确定 ${local.symbol} 的出场价，改用入场价记账`);
    exitPrice = local.entry_price;
  }

  const isLong = local.side === 'long';
  /*
   * ⚠️ **减过仓的仓位，要把已经记过的那部分减掉。**
   *
   * 「减仓」会当场记一笔（那部分已经实现）。而 `findRoundTrip()` 重建的是
   * **整段往返** —— 它的 grossPnl / entryFee / exitFee 覆盖全部入场与出场。
   * 直接记下去的话，同一笔利润会被记两次。
   *
   * **重复记账比漏记更糟**：漏记让账面比账户差，而重复记账让账面比账户好 ——
   * 后者正是 §2.5 明令禁止的方向（它会让一个亏损账户看起来是赚的）。
   *
   * 已记的部分存在 `positions.realized_partial_pnl`（迁移 M8）。
   * 没有减过仓时它是 0，行为与以前完全一致。
   *
   * ## ⚠️ 2026-10-03：扣的必须是**毛盈亏**，而且手续费也要按比例扣
   *
   * 这里原来是 `grossRaw - partialPnl`，而 `partialPnl` 是**净**盈亏
   * （`grossPnl - exitFee`，见 `positionStore.resize` 的调用点）——
   * **拿毛减净**，等于把已记那部分的平仓手续费**多扣了一次**：
   *
   * ```text
   * 整段往返: 毛 G、开仓费 EF、平仓费 XF
   * 部分平仓: 毛 g、平仓费 xf（已单独记过一行，净 g − xf）
   * 正确:     grossPnl = G − g,  exitFee = XF − xf
   * 原来:     grossPnl = G − (g − xf) = (G − g) + xf   ← 毛被高估 xf
   * ```
   *
   * 同时 `entryFee`/`exitFee` 也一直是**整段**的值，于是那部分手续费
   * 在账上出现两次（部分平仓那行一次、最终平仓这行一次）。
   *
   * 所以这里用**数量比例**把已记那部分的手续费也扣掉 —— `booked_partial_qty`
   * 是同一笔部分平仓记下的数量，两条腿的费率本就一致，按它分摊足够准，
   * 而且不需要新增列去存"那一笔的费"。
   */
  const partialBooked = positionStore.partialBooked(traderId, local.symbol);
  const partialGross = partialBooked.gross;
  const partialQty = partialBooked.qty;

  const grossRaw =
    authoritative?.grossPnl ??
    (isLong ? exitPrice - local.entry_price : local.entry_price - exitPrice) * local.quantity;

  /*
   * 只在**有权威值时**减：那种情况下权威值覆盖整段往返。
   *
   * 而回退公式用的是 `local.quantity` —— 那个数量在减仓之后已经变小了，
   * 所以它本来只覆盖剩余部分，再减一次就会少记。
   *
   * ⚠️ 扣的是**毛**（`partialGross`），不是净 —— 详见上面那段 2026-10-03 的说明。
   */
  const grossPnl = authoritative && partialGross !== 0 ? grossRaw - partialGross : grossRaw;

  // When the fills are unavailable we know only the exit leg's commission, and
  // recording that as zero would be worse than recording half of it — the
  // reconciliation pass corrects it to the true total shortly afterwards.
  /*
   * ⚠️ **已记那部分的手续费要按数量比例扣掉**，否则它在账上出现两次
   * （部分平仓那行一次、这一行一次）。两条腿的费率一致，按数量分摊足够准。
   *
   * ## 🔴 分母曾经是 `local.quantity`，于是手续费被**整个乘掉**
   *
   * 这两个操作数是**互不相交的两块**，不是"部分 / 整体"：
   *
   *   · `partialQty`（`booked_partial_qty`）—— **已减仓并记过账**的数量，单调累加
   *   · `local.quantity`               —— 减仓之后**剩余还开着**的数量
   *
   * 原始总量是 `partialQty + local.quantity`。拿前者的除以后者，减掉一半时
   * `168 / 168 = 1.0` → `Math.min(…, 1)` 夹到 1 → `entryFee` 与 `exitFee`
   * **双双归零**。实测：只要减仓量 ≥ 剩余量（减掉一半或更多），
   * 最终平仓那一行的手续费恒为 0。
   *
   * 而少记手续费的方向正是 §2.5 明令禁止的那一侧 —— **账面净额比交易所好看**，
   * 一个实际亏损的账户能看起来是赚的。同时 `ledger_check` 的 gap 长期不为 0，
   * 会逐渐训练操作员忽略那条唯一能自动发现账本错误的告警。
   *
   * ## 只在有权威值时分摊
   *
   *   · `authoritative` 存在时，`entryFee` / `exitFeeRaw` 覆盖**整段往返**
   *     （见 `findRoundTrip()` 的说明），所以必须按数量比例把已记那部分扣掉；
   *   · `authoritative == null`（走回退）时，`exitFeeInput` 是**剩余腿自己那一笔**
   *     的成交手续费，它本来就不含已减仓的部分 —— 再乘 `(1 - share)` 会
   *     **新引入少记**（把唯一已知的那笔费用也削掉）。
   *
   * `entryFeeRaw` 在**实盘**回退路径上恒为 0（真正的开仓费只能从成交明细取，
   * 取不到就不编）；模拟盘没有成交明细，但往返成本是按策略费率估出来的，
   * 于是把估算值按两侧拆开传进来（`extra.entryFeeFallback`，见
   * `settleDryRunPositions()`）。这里仍统一写成乘以 share，是为了让
   * "只有权威值才分摊"这条规则在两条腿上长得一样。
   */
  const partialShare =
    authoritative && partialQty > 0 && local.quantity > 0
      ? Math.min(partialQty / (partialQty + local.quantity), 1)
      : 0;
  const entryFeeRaw = authoritative?.entryFee ?? extra?.entryFeeFallback ?? 0;
  const exitFeeRaw = authoritative?.exitFee ?? exitFeeInput;
  const entryFee = entryFeeRaw * (1 - partialShare);
  /*
   * 回退路径（`authoritative == null`）**原样**采用 `exitFeeInput`：
   * 那是剩余腿自己那一笔的费用，不参与分摊。
   */
  const exitFee = authoritative ? exitFeeRaw * (1 - partialShare) : exitFeeInput;

  /*
   * ⚠️ **模拟盘估算出来的开仓侧手续费要一并回填那张入场订单行**（2026-11-09）。
   *
   * 模拟盘的成本是按费率**估**的，而 `orders.fee` 那一列在开仓时还是 0
   *（`entryFeeFor()` 读不到成交明细）。如果只改 `trades`，同一笔交易在
   * 「订单」与「成交」两处的费用之和对不上 —— 那正是这个项目一直在消灭的
   * "同一件事有两个数"。
   *
   * 只在 `extra.entryFeeFallback` 存在时执行（= 只有模拟盘会传），实盘一行不动；
   * 而且**不覆盖已有的非零值**（真实成交明细优先）。失败只影响展示，绝不能让
   * 一次已经成交的平仓失败。
   */
  if (extra?.entryFeeFallback !== undefined && entryFee > 0) {
    try {
      const entryOrder = local.entry_order_id
        ? orderStore.findByExchangeOrderId(traderId, String(local.entry_order_id))
        : null;
      if (entryOrder && !(Number(entryOrder.fee) > 0)) {
        orderStore.update(entryOrder.id, { fee: entryFee });
      }
    } catch {
      /* 展示口径的补写失败不值得让平仓记账失败。 */
    }
  }

  /*
   * Funding is read here, at the moment of closing, and not only during the
   * reconciliation pass.
   *
   * Funding settles every 8 hours and appears in **no** fill, so it can only
   * come from `/fapi/v1/income`. It used to be attributed on the reconcile
   * path alone — but that path only touches a row it can match, and a close
   * booked live with figures the reconcile could not match kept
   * `funding_fee = 0` forever. A position held across a settlement then showed
   * a net PnL that was better than the account's, which is exactly the
   * divergence §2.5 forbids.
   */
  const fundingFee = await fundingForWindow(ctx, local.symbol, local.opened_at, closedAt, {
    side: local.side === 'long' ? 'long' : 'short',
    notional: local.quantity * local.entry_price,
  });

  /*
   * 上锁前先问一次：这一回合是不是已经记过账了？
   *
   * 对账（`reconcileTradeHistory`）在周期开头跑，`reconcilePositions` 在周期末尾跑，
   * 两者都可能看到同一个已经消失的仓位。`positionStore.close()` 只能保证**本进程内**
   * 不会重复记账，而这里要保证的是"同一个真实回合在 `trades` 里只有一行"——
   * 所以判定必须在写账之前，用的身份与 `trades.insert()` 里的完全一致
   * （`trades.findDuplicate()` 是同一个实现，不存在两套判据）。
   */
  const closeQuantity =
    partialQty > 0 ? local.quantity : (authoritative?.quantity ?? local.quantity);
  const resolvedEntryOrderId = authoritative?.entryOrderId || local.entry_order_id || null;
  const resolvedExitOrderId = authoritative?.exitOrderId || extra?.exitOrderId || null;
  const alreadyBooked = tradeStore.findDuplicate({
    traderId,
    symbol: local.symbol,
    quantity: closeQuantity,
    entryPrice: local.entry_price,
    /* 出场价——两条记账路径之间唯一同源的字段，见 `findDuplicate()` 的说明。 */
    exitPrice,
    /* 开仓时刻 —— 主判据（两条路径的平仓时刻不同源，差过 11 分钟）。 */
    openedAt: local.opened_at,
    closedAt,
    entryOrderId: resolvedEntryOrderId,
    /*
     * **确定性键。** 同一笔平仓在交易所只有一个 `orderId`，所以"两条路径拿到
     * 同一个单号"就等于"这是同一个回合" —— 不依赖任何容差窗口。
     *
     * 上面那些启发式判据都有边界：实测漏网的一对（ZECUSDT `#107`/`#120`）
     * 共用同一个 `exit_order_id`，却因为平仓时刻差 6 秒（超出 2 秒窗口）
     * 被判成两个回合，账上多记一笔 —— 而那一笔让归属权益比钱包高出 0.015。
     */
    exitOrderId: resolvedExitOrderId,
  });
  if (alreadyBooked !== null) {
    let figuresToApply: {
      grossPnl: number;
      entryFee: number;
      exitFee: number;
      entryPrice: number;
      exitPrice: number;
      quantity: number;
      entryOrderId: string | null;
      exitOrderId: string | null;
    } | null = null;

    if (authoritative) {
      /*
       * 若该持仓此前有部分减仓（`partialQty > 0` 或 `partialGross !== 0`），
       * 上面已经算好了扣减已记部分后的 `grossPnl`/`entryFee`/`exitFee` 与剩余量 `local.quantity`，
       * 必须写扣减后口径，绝不可用整腿原始 `authoritative.*` 覆盖，否则已减仓盈亏会被重复计账。
       */
      if (partialQty > 0 || partialGross !== 0) {
        figuresToApply = {
          grossPnl,
          entryFee,
          exitFee,
          entryPrice: authoritative.entryPrice,
          exitPrice: authoritative.exitPrice,
          quantity: local.quantity,
          entryOrderId: authoritative.entryOrderId || null,
          exitOrderId: authoritative.exitOrderId || null,
        };
      } else {
        let effEntryFee = authoritative.entryFee;
        let effExitFee = authoritative.exitFee;
        const localQuantity = tradeStore.quantityOf(alreadyBooked);
        if (
          localQuantity !== undefined &&
          !shouldTrustReconciledQuantity(localQuantity, authoritative.quantity)
        ) {
          const fees = await commissionsForWindow(ctx, 
            local.symbol,
            authoritative.openedAt,
            authoritative.closedAt,
          );
          if (fees) {
            effEntryFee = fees.entryFee;
            effExitFee = fees.exitFee;
            log.warn(
              `[${ctx.trader.name}] ${local.symbol} 的重建成交量（${authoritative.quantity}）与本地（${localQuantity}）差得太远 —— ` +
                `本回合手续费改用交易所流水（${(effEntryFee + effExitFee).toFixed(6)}，重建算的是 ${(authoritative.entryFee + authoritative.exitFee).toFixed(6)}）。`,
            );
          }
        }
        figuresToApply = {
          grossPnl: authoritative.grossPnl,
          entryFee: effEntryFee,
          exitFee: effExitFee,
          entryPrice: authoritative.entryPrice,
          exitPrice: authoritative.exitPrice,
          quantity: authoritative.quantity,
          entryOrderId: authoritative.entryOrderId || null,
          exitOrderId: authoritative.exitOrderId || null,
        };
      }
    }

    runInTransaction(() => {
      if (figuresToApply) {
        tradeStore.applyExchangeFigures({
          id: alreadyBooked,
          ...figuresToApply,
          fundingFee,
          leverage: local.leverage,
        });
      }
      positionStore.close(local.id);
      tradeEvents.record(traderId, local.symbol, 'exit');
    });
    const recentTrades = tradeStore.list(traderId, 200);
    const existing = recentTrades.find((t) => t.id === alreadyBooked);
    if (ctx.trader.mode === 'ai_managed') {
      try {
        /* 归因按整笔仓位回合合计净盈亏（含此前的分批止盈/减仓），防止尾仓微亏反向惩罚高胜率因子。 */
        const roundTrades = recentTrades.filter(
          (t) => t.symbol === local.symbol && t.openedAt === local.opened_at,
        );
        const roundNetPnl =
          roundTrades.length > 0
            ? roundTrades.reduce((sum, t) => sum + t.netPnl, 0)
            : (existing?.netPnl ?? netPnlOf({ grossPnl, fee: entryFee + exitFee, fundingFee }));
        managedThesisStore.markClosedWithOutcome(traderId, local.symbol, {
          tradeId: alreadyBooked,
          netPnl: roundNetPnl,
          exitPrice: existing?.exitPrice ?? exitPrice,
          closeReason: existing?.closeReason ?? reason,
        });
        managedAttributionStore.recompute(traderId);
      } catch {
        /* 归因更新失败不阻断平仓主流程 */
      }
    }
    ctx.emit(
      'info',
      `${local.symbol} 的平仓此前已入账（第 #${alreadyBooked} 笔），本次不再重复记录；净 ${(existing?.netPnl ?? 0).toFixed(4)} USDT。`,
    );
    return {
      netPnl: existing?.netPnl ?? 0,
      grossPnl: existing?.pnl ?? grossPnl,
      exitPrice: existing?.exitPrice ?? exitPrice,
      quantity: existing?.quantity ?? local.quantity,
    };
  }

  const booked = runInTransaction(() => {
    const inserted = tradeStore.insert({
      traderId,
      symbol: local.symbol,
      side: isLong ? 'long' : 'short',
      quantity: closeQuantity,
      entryPrice: local.entry_price,
      exitPrice,
      leverage: local.leverage,
      grossPnl,
      entryFee,
      exitFee,
      fundingFee,
      closeReason: reason,
      openedAt: local.opened_at,
      closedAt,
      source: 'bot',
      entryOrderId: resolvedEntryOrderId,
      exitOrderId: resolvedExitOrderId,
      /*
       * **把开仓时记下的情报归因搬到成交上**（归因链最后一环，2026-10-12）。
       *
       * `local` 就是那行**仓位记录** —— 开仓时（`positions.insert`）
       * 已把 `decision.intelKeys` 存在它的 `intel_keys` 上。
       * 平仓时**直接搬过来**，不需要回查决策记录
       *（那需要靠 symbol + 时间猜，正是我拒绝过的"猜测式归因"）。
       *
       * ⚠️ 仓位行缺这个字段（老数据、收养的仓位）时 `?? []` ——
       * 语义是"**纯技术面成交**"，与 225 笔历史成交一致。
       *
       * ⚠️ 对账路径（`reconcileTradeHistory`）从交易所历史重建时**拿不到**它 ——
       * 那时为空是**正确的**：那条路径本来就没有决策上下文。
       */
      intelKeys: parseIntelKeysOf(local.intel_keys),
      // 这是一笔真实平仓：先查重，别把同一回合记两次（§2.5 的幂等）。
      idempotent: true,
    });
    positionStore.close(local.id);
    tradeEvents.record(traderId, local.symbol, 'exit');
    return inserted;
  });
  const tradeId = booked.id;

  const recentTrades = tradeStore.list(traderId, 200);
  const record = recentTrades.find((t) => t.id === tradeId);
  if (ctx.trader.mode === 'ai_managed') {
    try {
      /* 归因按整笔仓位回合合计净盈亏（含此前的分批止盈/减仓），防止尾仓微亏反向惩罚高胜率因子。 */
      const roundTrades = recentTrades.filter(
        (t) => t.symbol === local.symbol && t.openedAt === local.opened_at,
      );
      const roundNetPnl =
        roundTrades.length > 0
          ? roundTrades.reduce((sum, t) => sum + t.netPnl, 0)
          : (record?.netPnl ?? netPnlOf({ grossPnl, fee: entryFee + exitFee, fundingFee }));
      /*
       * BUG-3B 修复：分批平仓回合同时按整笔回合净盈亏 ÷ 初始总风险额计算加权 realizedR，
       * 确保 `managed_theses.realized_r` 与 `realized_net_pnl` 始终同口径闭合。
       */
      let roundRealizedR: number | null = null;
      if (roundTrades.length > 1) {
        const activeThesis = managedThesisStore.getActive(traderId, local.symbol);
        const totalRoundQty = roundTrades.reduce((sum, t) => sum + t.quantity, 0);
        if (activeThesis && totalRoundQty > 0) {
          const initialRiskPerUnit = Math.abs(
            activeThesis.entryPrice - activeThesis.initialStopLoss,
          );
          const totalInitialRiskUsd = initialRiskPerUnit * totalRoundQty;
          if (totalInitialRiskUsd > 0) {
            roundRealizedR = roundNetPnl / totalInitialRiskUsd;
          }
        }
      }
      managedThesisStore.markClosedWithOutcome(traderId, local.symbol, {
        tradeId,
        netPnl: roundNetPnl,
        exitPrice: record?.exitPrice ?? exitPrice,
        closeReason: record?.closeReason ?? reason,
        realizedR: roundRealizedR,
      });
      /* BUG-9A 修复：亏损平仓自动给同标的活跃观察笔记记 1 次反例，打通反例衰减闭环。 */
      if (roundNetPnl < 0) {
        managedNotesStore.recordCounterexample(traderId, local.symbol);
      }
      managedAttributionStore.recompute(traderId);
    } catch {
      /* 归因更新失败不阻断平仓主流程 */
    }
  }
  if (record) eventBus.publish({ type: 'trade', traderId, trade: record });

  /*
   * Log the **net** figure: it is what actually moved the balance, and the
   * gross number was what made the console disagree with the account.
   */
  /* ⚠️ 用 
etPnlOf —— 见它的注释（资金费的符号）。 */
  const net = record?.netPnl ?? netPnlOf({ grossPnl, fee: entryFee + exitFee, fundingFee });
  const sign = net >= 0 ? '+' : '';
  const costNote =
    entryFee + exitFee > 0 ? `，含手续费 ${(entryFee + exitFee).toFixed(4)}` : '';
  const fundingNote = fundingFee !== 0 ? `，含资金费 ${fundingFee.toFixed(4)}` : '';
  if (!booked.created) {
    /*
     * 这一回合已经记过账了（对账先补录、运行期后到），`insert()` 把那一行还了回来。
     * 不新增行，也**不再播报一次"已平仓"** —— 否则操作员会以为账户上真的平了两次。
     * 保留的仍是运行期发现的平仓原因（`stop_loss` / `take_profit` 比 `reconciled`
     * 信息多），所以这里只把重复这件事说清楚。
     */
    ctx.emit(
      'info',
      `${local.symbol} 的平仓此前已入账（第 #${tradeId} 笔），本次不再重复记录；净 ${sign}${net.toFixed(4)} USDT。`,
    );
  } else {
    ctx.emit(
      'info',
      `已平仓 ${local.symbol} ${local.side === 'long' ? '多头' : '空头'} @ ${exitPrice} → 净 ${sign}${net.toFixed(4)} USDT（毛 ${grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(4)}${costNote}${fundingNote}，${closeReasonLabel(reason, net)}）`,
    );
  }

  /*
   * --- AI 托管：平仓之后请复盘员写因果结论，并结算参数实验 ------------
   *
   * ⚠️ **只挂在 `booked.created === true` 上**，也就是"这确实是一笔新入账的平仓"。
   *
   * 挂在重复入账上会有两个后果：`agent_memory.trade_id` 有 UNIQUE，
   * 重复写会被幂等跳过（无害）；但**结算**会被多触发一次 ——
   * 而结算依据是"这次调整之后有几笔结果"，重复触发会让它把同一笔数两遍，
   * 于是策略师看到一个比真实更"有依据"的历史。
   *
   * 放在这里而不是三个 `bookClosedPosition` 调用点上：那样漏掉任何一个
   * 都会让一部分平仓永远得不到复盘 —— 而漏掉是静默的。
   */
  if (booked.created && ctx.agent) {
    const agent = ctx.agent;
    // 部分分批减仓（manual_partial）不属于完整一笔交易闭环，跳过单笔复盘以避免噪音与多余模型调用。
    if (reason !== 'manual_partial') {
      // 两个调用都不阻塞平仓路径：复盘要调模型，可能几秒到几十秒。
      agent.reviewTrade({
        tradeId,
        symbol: local.symbol,
        closeReason: reason,
        netPnl: net,
        grossPnl,
        fee: entryFee + exitFee,
        /*
         * 这几项是复盘员**真正需要**的事实，此前没被传出去 ——
         * 于是它的结论只能停在「数据不足」（实测 #1 号记忆就是如此）。
         *
         * `peakPnlPercent` 最关键：没有它，复盘员分不清
         * 「正常波动的保护性离场」与「止盈过晚导致利润回吐」，
         * 而这两者的改法完全相反。
         */
        peakPnlPercent: local.peak_pnl_percent,
        leverage: local.leverage,
        holdMinutes: Math.max(0, (Date.now() - new Date(local.opened_at).getTime()) / 60_000),
        entryPrice: local.entry_price,
        exitPrice,
        openedAt: local.opened_at,
        /*
         * **开仓时计划的保护位** —— 复盘员要靠它区分"止损设错/挂错"与
         * "方向就错"，而以前它拿不到，只能在同标的历史记忆里找一个数，
         * 于是 `#104` 把上一笔（`#275`）的 0.544 当成了本笔的止损。
         * 详见 `ReviewTradeFacts.stopLoss` 的说明。
         *
         * ⚠️ 取**开仓时**的值，而不是当前的：`local` 是平仓那一刻的持仓行，
         * 而移动止损会改写 `stop_loss`（`#280` 就是被改写过的例子）——
         * 但复盘要回答的是"这一笔的保护位是怎么被触发的"，用平仓时的值才是对的
         * （它就是**实际挂在交易所上的那个价**）。开仓原值另有用途，
         * 由 `entry.adjustments` 那条"风控当时记下的调整"覆盖。
         */
        stopLoss: local.stop_loss,
        takeProfit: local.take_profit,
      });
    }
    agent.settleOnly();
  }

  return {
    netPnl: net,
    grossPnl,
    exitPrice,
    quantity: authoritative?.quantity ?? local.quantity,
  };
}

/**
 * Funding paid or received on one symbol over a round-trip's own lifetime.
 *
 * Returns 0 — never a guess — when the income ledger cannot be read, and says
 * so in the log. Recording 0 is the honest answer (§2.5: 不要假装算过); the
 * reconcile pass re-reads the ledger later and overwrites the row with the
 * real figure if this read failed.
 */
export async function fundingForWindow(
  ctx: CloseBookingContext,
  symbol: string,
  openedAt: string,
  closedAt: string,
  paperCtx?: { side: 'long' | 'short'; notional: number },
): Promise<number> {
  if (ctx.isDryRun) {
    /*
     * M1.4（2026-11-24）：模拟盘跨过 8 小时整点结算时，按标的真实资金费率估算资金费
     *（可用 `AQ_PAPER_FUNDING_ENABLED=false` 关闭；同 8h 窗口内结算数为 0 直接返回 0）。
     */
    if (process.env.AQ_PAPER_FUNDING_ENABLED === 'false' || !paperCtx) return 0;
    const settlements = countFundingSettlements(Date.parse(openedAt), Date.parse(closedAt));
    if (settlements <= 0) return 0;
    const rate =
      (await ctx.getFundingRate?.(symbol).catch(() => null)) ?? 0.0001;
    return estimatePaperFundingFee({
      side: paperCtx.side,
      notional: paperCtx.notional,
      fundingRate: rate,
      openedAt,
      closedAt,
    });
  }
  try {
    /*
     * The ledger is read from `openedAt`, not from the trader's creation time:
     * a close is a one-off event, and asking for days of history to attribute
     * eight hours of funding would spend weight on every exit for no gain.
     */
    const events = await ctx.getIncome({
      startTime: new Date(openedAt).getTime(),
      endTime: new Date(closedAt).getTime() + 60_000,
    });
    return fundingInWindow(events, symbol, openedAt, closedAt);
  } catch (error) {
    log.warn(
      `[${ctx.trader.name}] ${symbol} 的资金费读取失败，本次记 0，待对账时补齐：${(error as Error).message}`,
    );
    return 0;
  }
}

/**
 * 一个回合的**开仓侧与平仓侧手续费** —— 直接从交易所流水取。
 *
 * ## 为什么需要它（与 `fundingFor()` 同一个理由，但这次是被数量错位带出来的）
 *
 * `reconstructRoundTrips()` 的窗口起点落在持仓中间时整条成交序列会错位，
 * 而它算出来的**手续费是按错位后的数量计的**。实测（2026-09-29，HYPEUSDT）：
 *
 * ```text
 * 重建 0.000970   vs   交易所流水 0.010204      （同一个回合，差 10 倍）
 * ```
 *
 * 只"保留本地数量"是**不够的** —— fee 还是错的，净额照样偏大、账目 gap 依旧是 0.0596。
 * 所以当重建的数量明显不可信时，手续费也走这条**完全不受重建影响**的来源。
 *
 * 读不到时返回 `null`（**退回重建值，而不是记 0** —— 记 0 会让净额更偏）。
 */
export async function commissionsForWindow(
  ctx: CloseBookingContext,
  symbol: string,
  openedAt: string,
  closedAt: string,
): Promise<{ entryFee: number; exitFee: number } | null> {
  try {
    const events = await ctx.getIncome({
      startTime: new Date(openedAt).getTime(),
      endTime: new Date(closedAt).getTime() + 60_000,
    });
    return commissionsInWindow(events, symbol, openedAt, closedAt);
  } catch (error) {
    log.warn(
      `[${ctx.trader.name}] ${symbol} 的手续费读取失败，本次沿用重建值：${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * Find this position's completed round-trip in the exchange's fill history.
 *
 * Matched on the **entry order id** (with symbol + quantity + entry price) —
 * see `roundTripKey` — rather than on time, because the local record's
 * `opened_at` is when the runtime decided and the exchange's is when the order
 * filled.
 *
 * ## ⚠️ 但那个 key **不是唯一的** —— 同标的的两个回合可能撞在一起
 *
 * 实测事故（用户的原话：「机器人未运行时平仓是什么意思？首先我没有关闭过机器人」）：
 *
 *     上一笔 #111  HYPEUSDT 0.21 @ 97.2 → 97.575   opened 01:09  closed 05:21
 *     这一笔 #110  HYPEUSDT 0.21 @ 97.2 → 96.451   opened 05:53  closed 07:54
 *
 * **同样的标的、同样的数量、同样的入场价** —— `roundTripQueryKey` 完全一致，
 * 而 `find(...)` 取到的是时间更早的那个（`#111`）。于是：
 *
 *   · `closedAt` 被替换成 `#111` 的平仓时刻、`exitPrice` 变成 `97.575`；
 *   · 再拿这组**错的**参数去 `findDuplicate()`，`|closedAt − #111.closed_at| = 0`
 *     必然命中 `#111`，于是运行期记账直接跳过（「此前已入账（第 #111 笔）」）；
 *   · 这笔真实成交最后只能由兜底路径补录，**平仓原因被写成 `reconciled`**
 *     —— 界面上就成了「机器人未运行时平仓」，而机器人从头到尾没停过，
 *     WS 把成交推来了、那张止损单在库里是 `FILLED`、本地持仓行也带着
 *     `stop_order_id`：**原因本来完全查得到。**
 *
 * ## 修法：key 仍然只做**筛选**，时间只做**排序**
 *
 * 注释原来给的理由（本地 `opened_at` 是决策时刻、交易所的是成交时刻，两者不同源）
 * 说的是**不能拿时间做等式**，而不是"时间没有用"。所以这里：
 *
 *   · 时间**不参与**过滤（不同源的问题原样保留，行为不会因此变紧）；
 *   · 只在**已通过 key 筛选**的候选里，取开仓时刻最接近 `local.opened_at` 的那个。
 *
 * 两个候选的时间差都落在"不同源误差"之内时，选哪个都对 —— 那说明它们本就同源。
 * 而像上面那种差 4.7 小时的情形，这一步就是决定性的。
 */
export async function findRoundTripForPosition(ctx: CloseBookingContext, local: PositionRow): Promise<ReconstructedTrade | null> {
  const fills = await ctx.getUserTrades(local.symbol, 50);
  const completed = reconstructRoundTrips(fills);

  /*
   * The entry order id is the exact discriminator when it is known, and the
   * local position row does not carry one — so this lookup matches on the
   * descriptive part (symbol + quantity + entry price). That is a **lookup for
   * figures**, not a key for overwriting another row: the strict key is written
   * onto the trade row, and it is the trade row that reconciliation matches on.
   */
  const wanted = roundTripQueryKey({
    symbol: local.symbol,
    quantity: local.quantity,
    entryPrice: local.entry_price,
  });
  const matches = completed.filter(
    (t) =>
      roundTripQueryKey({ symbol: t.symbol, quantity: t.quantity, entryPrice: t.entryPrice }) ===
      wanted,
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;

  const target = new Date(local.opened_at).getTime();
  const distance = (t: ReconstructedTrade): number => Math.abs(new Date(t.openedAt).getTime() - target);
  return matches.reduce((best, t) => (distance(t) < distance(best) ? t : best));
}

