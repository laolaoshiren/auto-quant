/**
 * 保本止损：浮盈够多时把止损移到开仓价。
 *
 * ## 为什么单独一个纯函数
 *
 * 这段判断有两个容易写错的地方，而**两个都会让一笔赚到钱的单变成亏损单**：
 *
 * 1. **方向**：只做多时"移到开仓价"是抬高止损；做空时是压低。搞反了会在
 *    盈利时把止损设到**亏损侧**，等于主动拉近爆仓距离。
 * 2. **单向棘轮**：止损只能往有利方向移，**永不回退**。允许回退的话，
 *    价格回落时止损会跟着退回原地 —— 那等于没有保本，而且是最难发现的那种
 *    "看起来在工作、其实没生效"。
 *
 * 所以做成纯函数（§5.4）：没有数据库、没有网络、没有时钟，
 * 这两个方向都能被穷举测试。
 *
 * ## 与回撤守卫的分工
 *
 * `shouldCloseForDrawdown()` 是**平仓**：浮盈回吐太多就落袋。
 * 这里是**移止损**：不给利润设上限，只保证这笔不再变成亏损。
 *
 * **两者不冲突，而且是互补的**：移止损负责"锁住不亏"，回撤守卫负责"别贪"。
 * 用户干净室实现里的 `breakeven_trigger` 就是前者 —— 而本系统实测的问题
 * （平均持仓 4.6 分钟、手续费占毛盈亏 38%、赚到钱的单又变回亏损单）
 * 恰好是只有后者、没有前者时会出的病。
 */

export interface BreakevenInput {
  side: 'long' | 'short';
  /** 开仓价。止损将移到这里。 */
  entryPrice: number;
  /** 当前止损价。`null` 表示没有止损（那本身就违反 §2.6，调用方应另行处理）。 */
  currentStop: number | null;
  /** 当前标记价。 */
  markPrice: number;
  /** 交易所口径的未实现盈亏百分比（已含杠杆）。 */
  unrealizedPnlPercent: number;
  /** 触发阈值（百分比）。**0 表示关闭这条规则**（与 `maxDailyLossPercent` 等字段同一约定）。 */
  triggerPercent: number;
  /**
   * **追踪距离**（百分比，按价格算）。达到阈值后，止损跟到"当前价往回退这么多"。
   *
   * ## 为什么需要它（实测的代价）
   *
   * 原来这里只会把止损移到**开仓价**（保本）。那保护的是"不亏"，**锁不住任何利润** ——
   * 而实测 12 笔"保本离场"的账面是这样的：
   *
   *     峰值浮盈合计 52.3%  →  最终落袋 38.2%     回吐 14.1 个百分点（27%）
   *     #113 NEARUSDT  峰值 5.81% → 最终 2.40%（回吐 3.41%）
   *     #132 XRPUSDT   峰值 6.44% → 最终 3.63%（回吐 2.81%）
   *
   * 而同期**唯一一笔真正止盈的单赚了 +0.7204**，比 21 笔止损加起来（+0.2087）还多 ——
   * 用户的原话是「**这不是白玩吗**」。
   *
   * 根因：止损停在成本价，**峰值 6% 的仓位中间那 6% 全是敞口**。
   *
   * ## 怎么实现的（不需要额外记峰值）
   *
   * 每轮算 `价格 × (1 ∓ 距离)`，再与**现有止损取更有利的那个**：
   * 价格涨 → 这个候选值跟着涨 → 止损上移；价格回落 → 候选值回落，
   * 但 `max` 让它**停在已经达到的最有利位置**。**棘轮是取 max 的自然结果**，
   * 所以不必存峰值价，也就不存在"峰值记丢了"这一类状态错误。
   *
   * `0` 表示不追踪 —— 即**退回原来的纯保本行为**（移到开仓价），保持向后兼容。
   */
  trailPercent: number;
}

export interface BreakevenVerdict {
  /** 是否应当把止损移到开仓价。 */
  move: boolean;
  /** 要移到的价格（`move` 为假时无意义）。 */
  newStop: number | null;
  /** 给操作员看的一句话。**无论动不动都要有理由** —— 「为什么没动」同样是信息。 */
  reason: string;
}

/**
 * 判断是否该把止损移到开仓价。
 *
 * 返回 `move: false` 的四种情形，每一种都**不能**当成"该动"：
 *
 * - **阈值关闭**（0）—— 操作员/策略明确不要这条规则
 * - **浮盈不够** —— 还没到值得保本的程度
 * - **已经在保本或更好** —— 重复设置没有意义，而且会产生多余的交易所调用
 * - **数据不完整** —— 没有止损（那该由 §2.6 的路径处理，不是这里）或价格非法
 */
export function shouldMoveStopToBreakeven(input: BreakevenInput): BreakevenVerdict {
  if (!(input.triggerPercent > 0)) {
    return { move: false, newStop: null, reason: '保本止损未启用（阈值为 0）。' };
  }

  if (
    !Number.isFinite(input.entryPrice) ||
    !Number.isFinite(input.markPrice) ||
    input.entryPrice <= 0
  ) {
    return { move: false, newStop: null, reason: '价格数据不完整，本轮不调整止损。' };
  }

  if (input.currentStop === null) {
    /*
     * 没有止损是一个**独立的问题**（§2.6：没有保护的杠杆仓位是最糟的状态），
     * 不该由保本逻辑顺手补一个 —— 那会把"缺止损"这个信号掩盖掉。
     * 交给既有的保护单路径处理。
     */
    return { move: false, newStop: null, reason: '该仓位没有止损，应由保护单路径处理，不由保本逻辑代劳。' };
  }

  if (!(input.unrealizedPnlPercent >= input.triggerPercent)) {
    return {
      move: false,
      newStop: null,
      reason: `浮盈 ${input.unrealizedPnlPercent.toFixed(2)}% 未达保本阈值 ${input.triggerPercent}%。`,
    };
  }

  /*
   * 单向棘轮：只有在"当前止损仍在亏损侧"时才移。
   *
   * 做多：止损在开仓价**之下**才算亏损侧；做空反之。
   * 已经等于或好于开仓价时不动 —— 那既避免多余的交易所调用，
   * 也避免把操作员手动设的更紧的止损**往回退**（那是最坏的一种"自作聪明"）。
   */
  const stillAtRisk =
    input.side === 'long' ? input.currentStop < input.entryPrice : input.currentStop > input.entryPrice;

  /*
   * 追踪距离的合法性：必须是正数且小于 100%。
   *
   * `>= 100` 会让候选止损落到价格另一侧（做多时退到 0 以下），
   * 那是比"不追踪"危险得多的一种错 —— 所以这里回退到纯保本，而不是照单全收。
   * `trailPercent = 0`（或 NaN）是**有意保留的旧行为**：只保本、不追踪。
   */
  const trail = Number.isFinite(input.trailPercent) && input.trailPercent > 0 && input.trailPercent < 100
    ? input.trailPercent
    : 0;

  if (!stillAtRisk && trail === 0) {
    return {
      move: false,
      newStop: null,
      reason: `止损 ${input.currentStop} 已在开仓价 ${input.entryPrice} 或更好的一侧，无需调整（止损只往有利方向移）。`,
    };
  }

  /*
   * 候选止损：
   *   · `breakeven` —— 开仓价，**永远是下限**（这条规则至少保证"不再亏"）；
   *   · `trailed`   —— 价格往回退 `trail%` 的位置（只在开启追踪且距离合法时存在）。
   *
   * 两者取**更有利**的那个：做多取大的，做空取小的。
   */
  const breakeven = input.entryPrice;
  const trailed =
    trail > 0
      ? input.side === 'long'
        ? input.markPrice * (1 - trail / 100)
        : input.markPrice * (1 + trail / 100)
      : null;

  const candidate =
    trailed === null
      ? breakeven
      : input.side === 'long'
        ? Math.max(breakeven, trailed)
        : Math.min(breakeven, trailed);

  /*
   * 与现有止损取更有利的一个 —— **这一句就是棘轮**。
   *
   * 价格回落时 `candidate` 会跟着回落，但 `currentStop` 停在历史最有利的位置，
   * 于是 `move` 变成 false：**止损不会往回退**。
   */
  const improved =
    input.side === 'long' ? candidate > input.currentStop : candidate < input.currentStop;

  if (!improved) {
    return {
      move: false,
      newStop: null,
      reason:
        `浮盈 ${input.unrealizedPnlPercent.toFixed(2)}% 已达保本阈值 ${input.triggerPercent}%，` +
        `但候选止损 ${candidate.toFixed(6)} 不比现有止损 ${input.currentStop} 更有利 —— ` +
        '止损只往有利方向移（价格回落时不回退）。',
    };
  }

  return {
    move: true,
    newStop: candidate,
    reason:
      `浮盈 ${input.unrealizedPnlPercent.toFixed(2)}% 已达保本阈值 ${input.triggerPercent}%，` +
      (trail > 0
        ? `按价格回撤 ${trail}% 追踪，把止损从 ${input.currentStop} 移到 ${candidate.toFixed(6)}`
        : `把止损从 ${input.currentStop} 移到开仓价 ${breakeven}`) +
      '（只往有利方向移，不再退回）。',
  };
}
