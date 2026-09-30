/**
 * 挂单成交率 —— **模型看不到的那个反馈**。
 *
 * ## 为什么要算它
 *
 * 用户 2026-10-01 的原话：
 *
 * 「为什么每次开单都是限价单、逐仓，而且经常挂了都无法成交，因为看不了取消记录，
 *   我估计都是挂了又取消根本没成交，怎么奇奇怪怪的感觉，
 *   好像在浪费时间和 token，浪费服务器资源」
 *
 * 拉出真实数据，**他的估计完全正确**：
 *
 *     入场单：LIMIT CANCELED 78 / LIMIT FILLED 44  → **撤单率 64%**
 *             MARKET FILLED 19                     → 市价单 100% 成交
 *
 * 系统**已经告诉过模型**"挂满 `pendingEntryTimeoutMinutes` 分钟会自动撤"，
 * 但它从没看到 **"我过去挂的单六成都没成交"** 这个统计 —— 而这是它调整挂单方式的
 * 唯一依据。于是它每轮都在重复"挂回踩位 → 超时撤掉 → 下一轮再挂"。
 *
 * ## 只给事实
 *
 * 这里算的是成交率与撤单的平均等待时长。要不要改挂法（挂近一点 / 用市价 /
 * 干脆不挂）仍然是模型的判断 —— 用户的原则是**模型是大脑，系统只是手脚**。
 */

/** 一张入场单里统计需要的字段。 */
export interface EntryOrderSample {
  /** `'LIMIT'` 或 `'MARKET'`（大小写不敏感）。 */
  type: string;
  /** 交易所状态：`FILLED` / `CANCELED` / `NEW` / `REJECTED` … */
  status: string | null;
  /** 这张单从挂出到有结论经过了多少分钟。 */
  waitMinutes: number | null;
}

export interface EntryFillStats {
  limitFilled: number;
  limitCanceled: number;
  limitRejected: number;
  marketFilled: number;
  /**
   * **限价单成交率（%）**：`成交 ÷ (成交 + 撤单)`。
   *
   * ⚠️ 分母**不含**被拒与仍在挂着（`NEW`）的：
   *   · 被拒是"没挂上"，不是"没成交"，混进来会冤枉自己；
   *   · `NEW` 还没有结论，算进去会让比例随样本新鲜度漂移。
   *
   * 没有任何"有结论的限价单"时为 **`null`** —— 不是 0%。
   * 0% 说"你全挂了"，`null` 说"你还没挂过"，两者对模型的含义完全不同。
   */
  fillRatePercent: number | null;
  /** 被撤的限价单**平均等了多久** —— 判断"是不是差一点就成交"。 */
  avgCanceledWaitMinutes: number | null;
}

/** 从入场单样本算出成交统计。 */
export function entryFillStats(samples: readonly EntryOrderSample[]): EntryFillStats {
  let limitFilled = 0;
  let limitCanceled = 0;
  let limitRejected = 0;
  let marketFilled = 0;
  let canceledWaitSum = 0;
  let canceledWaitN = 0;

  for (const s of samples) {
    const type = String(s.type ?? '').toUpperCase();
    const status = String(s.status ?? '').toUpperCase();

    if (type === 'MARKET') {
      if (status === 'FILLED') marketFilled += 1;
      continue;
    }
    if (type !== 'LIMIT') continue;

    if (status === 'FILLED') {
      limitFilled += 1;
    } else if (status === 'CANCELED') {
      limitCanceled += 1;
      if (typeof s.waitMinutes === 'number' && Number.isFinite(s.waitMinutes)) {
        canceledWaitSum += s.waitMinutes;
        canceledWaitN += 1;
      }
    } else if (status === 'REJECTED') {
      limitRejected += 1;
    }
    /* `NEW`（还在挂着）与其它中间状态：不计入任何一边。 */
  }

  const decided = limitFilled + limitCanceled;
  return {
    limitFilled,
    limitCanceled,
    limitRejected,
    marketFilled,
    fillRatePercent: decided > 0 ? (limitFilled / decided) * 100 : null,
    avgCanceledWaitMinutes: canceledWaitN > 0 ? canceledWaitSum / canceledWaitN : null,
  };
}
