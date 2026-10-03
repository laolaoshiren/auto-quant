/**
 * **"空仓时，账户卡上那几个数字该显示什么"** 的判定。
 *
 * ## 背景（2026-10-04，用户报的两个 BUG，其实是同一个）
 *
 * > 「**明明现在没有持仓和挂单，但是居然显示：保证金占用（USDT）23.63**」
 * > 「**可用 74.57，和交易所里面实际的也对不上**」
 *
 * 现场那两个数字**同源**：
 *
 * ```text
 * 钱包 97.94 · 可用 74.57 · 快照      ← 97.94 − 74.57 = 23.37 ≈ 占用的 23.63
 * ```
 *
 * 它们都来自**某个时刻的账户快照**（`account.marginUsed` / `account.availableBalance`），
 * 而机器人停止后那个快照不再刷新 —— 于是它永久停在"当时还持有两笔仓"的样子。
 * 讽刺的是**紧挨着的副行写着「当前无持仓」**（那个来自实时持仓），
 * 一张卡上两个时效、互相矛盾。
 *
 * ## 为什么可以推算，而不是"猜一个数"
 *
 * 服务端的口径是：
 *
 * ```text
 * marginUsed = totalPositionInitialMargin + openOrderMargin
 * ```
 *
 * **两项都由持仓与挂单产生** —— 所以"实时持仓为空、挂单为空"时，
 * **占用必然是 0**；而会计恒等式 `可用 = 钱包 − 占用` 给出 `可用 = 钱包`。
 * 这是定义推出来的结论，**比一个二十几分钟前的快照更准确**。
 *
 * ## 两条纪律
 *
 *   1. **持仓与挂单必须【都】空**才走推算 —— 只判持仓会把"只有挂单"的情形
 *      误报成 0（2026-09-29 踩过：两笔限价挂单在手，卡片显示「占用 10.24 / 当前无持仓」）。
 *   2. **读不到时返回 `null`（界面显示 `—`），绝不返回 0。**
 *      `—` 是"我们不知道"，`0` 是"我们问过了，是零" —— 这两件事不能混，
 *      本界面在别处已经反复做过同一个选择。
 */

export interface AccountDisplayInput {
  /** 账户读数是否**不可用**（机器人停止 / 交易所读不到）—— 那时一律 `—`。 */
  liveUnavailable: boolean;
  /** **实时**持仓数量（`positions.length`）。 */
  positionCount: number;
  /** **实时**挂单数量（`openOrders.length`）。 */
  openOrderCount: number;
  /** 账户快照里的占用 —— 只在"确实有仓位或挂单"时才用它。 */
  snapshotMarginUsed: number | null;
  /** 账户快照里的可用余额。 */
  snapshotAvailableBalance: number | null;
  /** 账户快照里的钱包余额（推算可用时要用）。 */
  walletBalance: number | null;
}

/** 没有任何持仓与挂单 —— 占用必然为 0 的那个前提。 */
function nothingOpen(input: AccountDisplayInput): boolean {
  return input.positionCount === 0 && input.openOrderCount === 0;
}

/** 卡片上的「保证金占用」：空仓时是 0，否则用快照，读不到给 `null`（界面 `—`）。 */
export function displayMarginUsed(input: AccountDisplayInput): number | null {
  if (input.liveUnavailable) return null;
  if (nothingOpen(input)) return 0;
  return input.snapshotMarginUsed;
}

/** 卡片上的「可用余额」：空仓时等于钱包（占用为 0），否则用快照。 */
export function displayAvailable(input: AccountDisplayInput): number | null {
  if (input.liveUnavailable) return null;
  if (nothingOpen(input)) return input.walletBalance;
  return input.snapshotAvailableBalance;
}
