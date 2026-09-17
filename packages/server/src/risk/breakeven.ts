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

  if (!stillAtRisk) {
    return {
      move: false,
      newStop: null,
      reason: `止损 ${input.currentStop} 已在开仓价 ${input.entryPrice} 或更好的一侧，无需调整（止损只往有利方向移）。`,
    };
  }

  return {
    move: true,
    newStop: input.entryPrice,
    reason:
      `浮盈 ${input.unrealizedPnlPercent.toFixed(2)}% 已达保本阈值 ${input.triggerPercent}%，` +
      `把止损从 ${input.currentStop} 移到开仓价 ${input.entryPrice}（只往有利方向移，不再退回）。`,
  };
}
