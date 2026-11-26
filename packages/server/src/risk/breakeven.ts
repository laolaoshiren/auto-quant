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
  /**
   * 追踪止损的最小改善步长（百分比，默认 `0.15` = 0.15%）。
   *
   * 仅在当前止损已处于保本或盈利侧（`!stillAtRisk`）后的增量追踪阶段生效：
   * 防止 30 秒监控因为 0.01% 的微小价格抖动就频繁撤换实盘 STOP_MARKET 保护单，
   * 既避免产生无意义的保护空窗，也避免消耗交易所下单限额。
   * 从亏损侧首次移至保本时不受此限制。设为 `0` 可关闭防抖。
   */
  minStepPercent?: number;
  /**
   * 智能托管 2.0（R 倍数 + ATR 自适应）扩展参数（可选；未传时保持原有 ROE% 口径 100% 向后兼容）：
   * - `breakevenTriggerR`：触发保本所需的最小 R 倍数（如 `1.0` = 达到 1.0R 后才保本）；
   * - `minBreakevenPriceMovePct`：触发保本所需的最小价格顺向幅度（如 `1.5` = 至少走出 1.5%）；
   * - `breakevenFeeBufferPct`：保本位向盈利侧偏移的手续费缓冲（如 `0.12` ≈ 1.2× 往返吃单费）；
   * - `trailTriggerR`：启动追踪止损所需的最小 R 倍数（如 `1.5` = 1.5R 之前仅锁保本、不紧跟追踪）；
   * - `initialStopLoss`：开仓初始止损价（用于计算 1R 风险距离 `|entryPrice - initialStopLoss|`）；
   * - `atr15mPct`：当前 15m ATR%（如 `3.0` = 3%），配合 `trailAtrMultiplier` 计算自适应追踪距。
   */
  breakevenTriggerR?: number;
  minBreakevenPriceMovePct?: number;
  breakevenFeeBufferPct?: number;
  trailTriggerR?: number;
  initialStopLoss?: number | null;
  atr15mPct?: number | null;
  trailAtrMultiplier?: number;
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
    input.entryPrice <= 0 ||
    input.markPrice <= 0
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

  const useRAdaptive =
    input.breakevenTriggerR !== undefined &&
    Number.isFinite(input.breakevenTriggerR) &&
    input.breakevenTriggerR > 0;

  const priceMovePct =
    input.side === 'long'
      ? ((input.markPrice - input.entryPrice) / input.entryPrice) * 100
      : ((input.entryPrice - input.markPrice) / input.entryPrice) * 100;

  const initialStopRef =
    input.initialStopLoss !== undefined &&
    input.initialStopLoss !== null &&
    Number.isFinite(input.initialStopLoss) &&
    input.initialStopLoss > 0
      ? input.initialStopLoss
      : input.currentStop;
  const initialRiskDist =
    initialStopRef !== null && Math.abs(input.entryPrice - initialStopRef) > 0
      ? Math.abs(input.entryPrice - initialStopRef)
      : 0;
  const favorableDist =
    input.side === 'long'
      ? input.markPrice - input.entryPrice
      : input.entryPrice - input.markPrice;
  const currentR = initialRiskDist > 0 ? favorableDist / initialRiskDist : null;

  if (useRAdaptive) {
    const reqR = input.breakevenTriggerR!;
    const reqMovePct =
      input.minBreakevenPriceMovePct !== undefined &&
      Number.isFinite(input.minBreakevenPriceMovePct) &&
      input.minBreakevenPriceMovePct > 0
        ? input.minBreakevenPriceMovePct
        : 1.5;
    const hitR = currentR !== null ? currentR >= reqR : true;
    const hitMove = priceMovePct >= reqMovePct;
    if (!hitR || !hitMove) {
      const rTxt = currentR !== null ? `${currentR.toFixed(2)}R / 需 ≥${reqR}R` : '无初始R基准';
      return {
        move: false,
        newStop: null,
        reason: `当前进展 ${rTxt}、价格走幅 ${priceMovePct.toFixed(2)}%（需 ≥${reqMovePct}%），未达保本条件。`,
      };
    }
  } else if (!(input.unrealizedPnlPercent >= input.triggerPercent)) {
    return {
      move: false,
      newStop: null,
      reason: `浮盈 ${input.unrealizedPnlPercent.toFixed(2)}% 未达保本阈值 ${input.triggerPercent}%。`,
    };
  }

  /*
   * 保本目标位：
   * - 传统模式：`entryPrice`（零偏移）；
   * - R 自适应模式：向盈利侧偏移 `breakevenFeeBufferPct`（默认 `0.12%` ≈ 1.2× 往返吃单费），
   *   避免保本被扫时因为双边手续费反变净亏。
   */
  const feeBufferPct =
    useRAdaptive &&
    input.breakevenFeeBufferPct !== undefined &&
    Number.isFinite(input.breakevenFeeBufferPct) &&
    input.breakevenFeeBufferPct >= 0
      ? input.breakevenFeeBufferPct
      : 0;
  const breakeven =
    feeBufferPct > 0
      ? input.side === 'long'
        ? input.entryPrice * (1 + feeBufferPct / 100)
        : input.entryPrice * (1 - feeBufferPct / 100)
      : input.entryPrice;

  const stillAtRisk =
    input.side === 'long' ? input.currentStop < breakeven : input.currentStop > breakeven;

  /*
   * 追踪距离：
   * - 传统模式：沿用 `input.trailPercent`；
   * - R 自适应模式：仅当 `currentR >= trailTriggerR`（默认 1.5R；无初始 R 时走幅 ≥2.5%）时启动，
   *   追踪距离取 `max(trailPercent, atr15mPct * trailAtrMultiplier)`，防止 1.5% 固定追踪在 3% ATR 山寨中被噪音洗出。
   */
  const baseTrail =
    Number.isFinite(input.trailPercent) && input.trailPercent > 0 && input.trailPercent < 100
      ? input.trailPercent
      : 0;
  let trail = baseTrail;
  if (useRAdaptive) {
    const reqTrailR =
      input.trailTriggerR !== undefined && Number.isFinite(input.trailTriggerR) && input.trailTriggerR > 0
        ? input.trailTriggerR
        : 1.5;
    const trailUnlocked = currentR !== null ? currentR >= reqTrailR : priceMovePct >= 2.5;
    if (!trailUnlocked) {
      trail = 0;
    } else {
      const atrMult =
        input.trailAtrMultiplier !== undefined &&
        Number.isFinite(input.trailAtrMultiplier) &&
        input.trailAtrMultiplier > 0
          ? input.trailAtrMultiplier
          : 2.0;
      const atrTrail =
        input.atr15mPct !== undefined &&
        input.atr15mPct !== null &&
        Number.isFinite(input.atr15mPct) &&
        input.atr15mPct > 0
          ? input.atr15mPct * atrMult
          : 0;
      const adaptiveTrail = Math.max(baseTrail, atrTrail);
      trail = adaptiveTrail > 0 && adaptiveTrail < 50 ? adaptiveTrail : baseTrail;
    }
  }

  if (!stillAtRisk && trail === 0) {
    return {
      move: false,
      newStop: null,
      reason: `止损 ${input.currentStop} 已在保本位 ${breakeven.toFixed(6)} 或更好的一侧，无需调整（止损只往有利方向移）。`,
    };
  }

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
        `浮盈 ${input.unrealizedPnlPercent.toFixed(2)}% 已达保本条件，` +
        `但候选止损 ${candidate.toFixed(6)} 不比现有止损 ${input.currentStop} 更有利 —— ` +
        '止损只往有利方向移（价格回落时不回退）。',
    };
  }

  /*
   * 追踪阶段防抖：止损已在保本或盈利侧时，忽略小于最小步长的微幅改善，
   * 避免每 30 秒因 0.008% 的噪声跳动就撤换实盘保护单。
   */
  if (!stillAtRisk && trail > 0) {
    const minStep =
      input.minStepPercent !== undefined && Number.isFinite(input.minStepPercent) && input.minStepPercent >= 0
        ? input.minStepPercent
        : 0.15;
    if (minStep > 0 && input.currentStop > 0) {
      const stepPct = (Math.abs(candidate - input.currentStop) / input.currentStop) * 100;
      if (stepPct < minStep) {
        return {
          move: false,
          newStop: null,
          reason:
            `候选止损 ${candidate.toFixed(6)} 相对现有止损 ${input.currentStop} 仅改善 ${stepPct.toFixed(3)}%，` +
            `小于最小防抖步长 ${minStep}%，暂不撤换保护单。`,
        };
      }
    }
  }

  /* 合法侧守卫：新止损必须严格位于当前标记价的止损侧，防止微回撤触发交易所 -2021 立即成交。 */
  const onSafeSide =
    input.side === 'long' ? candidate < input.markPrice : candidate > input.markPrice;
  if (!onSafeSide) {
    return {
      move: false,
      newStop: null,
      reason:
        `候选止损 ${candidate.toFixed(6)} 已贴近或越过当前标记价 ${input.markPrice}，` +
        '本轮暂不移动止损以避免触发交易所立即成交拒单。',
    };
  }

  return {
    move: true,
    newStop: candidate,
    reason: useRAdaptive
      ? `进展 ${currentR !== null ? `${currentR.toFixed(2)}R` : `${priceMovePct.toFixed(2)}%`}（价格 ${priceMovePct >= 0 ? '+' : ''}${priceMovePct.toFixed(2)}%），` +
        (trail > 0
          ? `启动自适应宽追踪（回撤距 ${trail.toFixed(2)}%），把止损从 ${input.currentStop} 移到 ${candidate.toFixed(6)}`
          : `移至含费率缓冲保本位 ${breakeven.toFixed(6)}（原止损 ${input.currentStop}）`) +
        '（只往有利方向移，不再退回）。'
      : `浮盈 ${input.unrealizedPnlPercent.toFixed(2)}% 已达保本阈值 ${input.triggerPercent}%，` +
        (trail > 0
          ? `按价格回撤 ${trail}% 追踪，把止损从 ${input.currentStop} 移到 ${candidate.toFixed(6)}`
          : `把止损从 ${input.currentStop} 移到开仓价 ${breakeven}`) +
        '（只往有利方向移，不再退回）。',
  };
}
