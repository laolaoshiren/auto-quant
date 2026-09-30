/**
 * 往返成本 —— 模型决定"止损该放哪"时必须知道的数字。
 *
 * ## 为什么它值得一个独立文件
 *
 * 模型自己写了一类「保本/锁盈上移」规则（提示词里的 5.1/5.2），判据是
 * **价格浮盈的百分比**。当它把止损移到"比成本价好一点点"的位置时，
 * 那"一点点"必须**覆盖往返成本**，否则一被扫掉就是净亏 —— 不是判断错，
 * 而是算术上必然如此。
 *
 * 实测（2026-09-30，ZECUSDT 空头，4x）：
 *
 *     入场 1413.00 → 模型把止损从结构位 1427.5 上移到 1412.32
 *     锁住的浮盈  = (1413.00 − 1412.32) / 1413.00 = 0.048%
 *     这笔往返成本 = 手续费 0.0148 ÷ 名义 21.20   = 0.070%
 *     结果：毛 +0.0042、手续费 0.0148 → **净 -0.0106**
 *
 * 而模型**自己的复盘两次**都写下了正确结论
 * （「保本止损必须设在覆盖往返成本之上」「任何小于往返成本的价格波动在扣费后必然为净亏」），
 * 但**决策那一刻它手里没有这个数字** —— 只能靠它想起来。这就是信息缺口，不是能力缺口。
 *
 * ## 这里给的是**事实**，不是规则
 *
 * 系统只报"你最近的往返成本约是 X%"。判据仍然是模型的：
 * 它可以选择把止损放在覆盖成本之上、也可以选择保留结构止损 ——
 * 那是它的取舍（用户的原则：**模型是大脑，系统只是手脚**）。
 */

/** 一笔成交里算成本需要的三个数。 */
export interface CostSample {
  entryPrice: number;
  quantity: number;
  /** **开+平合计**手续费（USDT）—— `TradeRecord.fee` 就是这个口径。 */
  fee: number;
}

/**
 * 从最近的成交反推**往返成本率**（百分比）：`fee ÷ 名义价值 × 100`。
 *
 * @param samples 成交样本，**新的在前**（调用方按 `id DESC` 取）
 * @param limit   只看最近多少笔。默认 20：
 *                maker/taker 的费率差一倍（实测挂单 0.070% / 市价 0.100%），
 *                用全历史会让很久以前的费率主导当前判断。
 * @returns 百分比；**没有任何有效样本时返回 `null`**（调用方据此不渲染这一行）
 *
 * 为什么不用一个"行业标准值"兜底：那是**别处**的成本，不是这个账户的。
 * 宁可不说，也不说一个错的（`docs/AGENTS.md` §3.2）。
 */
export function averageRoundTripCostPercent(
  samples: readonly CostSample[],
  limit = 20,
): number | null {
  const take = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const recent = samples.slice(0, take);

  let sum = 0;
  let n = 0;
  for (const s of recent) {
    const notional = s.entryPrice * s.quantity;
    /*
     * `notional <= 0` 的样本必须丢掉：`entryPrice = 0` 或 `quantity = 0` 会算出
     * `Infinity`/`NaN`，而一个 NaN 会被渲染成"往返成本 ≈NaN%"——
     * 看起来既像数据又像乱码，比不显示更糟。
     */
    if (!Number.isFinite(notional) || notional <= 0) continue;
    if (!Number.isFinite(s.fee)) continue;
    sum += s.fee / notional;
    n += 1;
  }

  if (n === 0) return null;
  return (sum / n) * 100;
}
