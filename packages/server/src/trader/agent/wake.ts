/**
 * 什么时候唤醒大脑。
 *
 * ## 这一层决定"事件驱动"是不是真的
 *
 * 之前的模式是定时的：每 3 分钟问一次模型，不管有没有值得问的事。
 * 这个模式按**发生了什么事**决定要不要想 —— 但那带来两个新的失效方式，
 * 而它们都比"多花点钱"严重：
 *
 * 1. **抖动**：每笔平仓都唤醒，而平仓常常是连着来的（止损触发一串）。
 *    那样大脑会被同一件事唤醒五次，看到的是同一份数据，做出的是五次互相矛盾的调整。
 * 2. **饿死**：事件稀疏时大脑长时间不醒。一个连续小亏但每笔都没触发阈值的账户，
 *    会在没有人审视的情况下慢慢失血。
 *
 * 所以触发判据里既有"该醒了"的条件，也有**冷却**（防抖动）
 * 和**兜底超时**（防饿死）。两者缺一不可。
 *
 * ## 为什么是纯函数
 *
 * 判据要能被穷举测试 —— "连亏三笔时会不会醒"、"刚醒过还会不会再醒"、
 * "超预算时怎么降级"，这些都不能靠读一遍代码觉得对（§5.4）。
 */

/* -------------------------------------------------------------------------- */
/*  输入                                                                       */
/* -------------------------------------------------------------------------- */

/** 自上次唤醒以来发生的事。全部由调用方从真实数据算出来，判据本身不查库。 */
export interface WakeFacts {
  /** 距上次唤醒过了多少分钟。 */
  minutesSinceLastWake: number;
  /** 上次唤醒之后新入账的平仓笔数。 */
  newClosedTrades: number;
  /** 上次唤醒之后这几笔的净盈亏合计。 */
  netPnlSinceLastWake: number;
  /** 连续亏损笔数（从最近一笔往前数）。 */
  losingStreak: number;
  /** 权益相对上次唤醒时的变化，百分比（可正可负）。 */
  equityDriftPercent: number;
  /** 上次唤醒之后的周期里，被风控拒绝的决策数。 */
  rejectionsSinceLastWake: number;
  /** 本小时已经调用过几次（含所有角色）。 */
  callsThisHour: number;
  /** 上一次的调参结论是不是"不改" —— 用来避免反复问同一件事。 */
  lastDecisionWasNoChange: boolean;
  /** 当前是否有持仓 —— 有仓位时判断更重要，值得开完整面板。 */
  hasPosition: boolean;
  /** 距上次**策略审视**（不是任意唤醒）过了多久 —— 强度选择的依据。 */
  minutesSinceStrategyReview: number;
  /**
   * 自上次唤醒以来跑了多少个周期，**一个仓位都没开**。
   *
   * ## 为什么需要它（这是一个真实的死循环，实测撞到）
   *
   * 机器人可能一直在"正确地"空转：模型每轮都判断 `wait`，
   * 于是没有成交（`newClosedTrades` 恒为 0）、没有被拒（`rejectionsSinceLastWake` 恒为 0）、
   * 权益也不动（`equityDriftPercent` 恒为 0）——
   * **所有既有判据都是 0，只有 60 分钟兜底会让它醒，而醒来看到的还是同一份数据。**
   *
   * 实测情形：三条门槛叠加（最小止损 0.30%、盈亏比 ≥1:3、置信度 ≥80）
   * 在当前行情下**不可达**，于是机器人永远不交易，而它自己不会主动发现这一点。
   *
   * **而这是最难发现的一类失效**：每轮周期都"成功"、日志干净、
   * 状态显示 `running` —— **只是什么都不做。**
   */
  idleCycles: number;
}

export interface WakePolicy {
  /** 每小时总调用预算。 */
  hourlyBudget: number;
  /** 两次唤醒之间至少隔多少分钟（防抖动）。 */
  cooldownMinutes: number;
  /** 多久没有值得醒的事也要醒一次（防饿死）。 */
  maxIdleMinutes: number;
  /** 连亏多少笔算"值得醒"。 */
  losingStreakThreshold: number;
  /** 权益变化多少个百分点算"值得醒"。 */
  equityDriftThresholdPercent: number;
  /** 连续被拒多少次算"参数与市场脱节"。 */
  rejectionThreshold: number;
  /** 连续多少轮零成交算"参数可能不可达"。 */
  idleCycleThreshold: number;
}

/**
 * 默认策略。
 *
 * 数字的来处：
 * - `cooldownMinutes: 10` —— 覆铜冷却（默认 20 分钟）量级，保证一次平仓的余波
 *   不会连着唤醒好几次
 * - `maxIdleMinutes: 60` —— 与策略师的"距上次审视 60 分钟"对齐
 * - 预算 40 次/小时是按成本倒推的：完整面板约 4–5 倍单次成本，
 *   实测单次约 5.8 万 tokens
 */
export const DEFAULT_WAKE_POLICY: WakePolicy = {
  hourlyBudget: 40,
  cooldownMinutes: 10,
  maxIdleMinutes: 60,
  losingStreakThreshold: 3,
  equityDriftThresholdPercent: 2,
  rejectionThreshold: 5,
  /*
   * 20 轮 ≈ 1 小时（3 分钟周期）。再长的话，一个"参数不可达"的机器人会安静地
   * 空转几小时才被审视 —— 而那期间它在持续消耗 token。
   */
  idleCycleThreshold: 20,
};

export type WakeTrigger =
  | 'new_result'
  | 'losing_streak'
  | 'drawdown'
  | 'rejections'
  | 'timeout'
  | 'idle'
  | 'manual'
  | 'none';

export interface WakeDecision {
  wake: boolean;
  trigger: WakeTrigger;
  /** 给操作员与日志看的一句话：说清为什么醒/为什么不醒。 */
  why: string;
}

/* -------------------------------------------------------------------------- */
/*  判据                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 决定现在要不要唤醒大脑。
 *
 * 顺序是刻意的，两层：
 *   1. **先看能不能醒**（冷却、预算）—— 这两条是*约束*，不是理由
 *   2. **再看该不该醒**（事件）—— 按"信息量"从高到低排
 *
 * 反过来写（先看事件、再看能不能）会导致日志里出现"因为连亏所以醒（但被冷却挡了）"
 * 这种自相矛盾的记录。
 */
export function decideWake(facts: WakeFacts, policy: WakePolicy = DEFAULT_WAKE_POLICY): WakeDecision {
  /* --- 第一层：约束。挡住的理由必须说清楚，否则看起来像"系统没反应" --- */

  if (facts.callsThisHour >= policy.hourlyBudget) {
    return {
      wake: false,
      trigger: 'none',
      why: `本小时已调用 ${facts.callsThisHour} 次，达到预算上限 ${policy.hourlyBudget}，本轮不唤醒。`,
    };
  }

  if (facts.minutesSinceLastWake < policy.cooldownMinutes) {
    return {
      wake: false,
      trigger: 'none',
      why: `距上次唤醒仅 ${facts.minutesSinceLastWake} 分钟（冷却 ${policy.cooldownMinutes} 分钟），本轮不唤醒。`,
    };
  }

  /* --- 第二层：事件。按信息量从高到低 --- */

  /*
   * 权益显著变化排在最前：它既可能是回撤（要防守）也可能是新高（要重新评估仓位），
   * 而且它是**唯一一个不需要等数据积累**就能判断的信号。
   */
  if (Math.abs(facts.equityDriftPercent) >= policy.equityDriftThresholdPercent) {
    const down = facts.equityDriftPercent < 0;
    return {
      wake: true,
      trigger: 'drawdown',
      why: `权益相对上次判断变化 ${facts.equityDriftPercent.toFixed(2)}%（阈值 ${policy.equityDriftThresholdPercent}%）${down ? '，是回撤，需要重新评估。' : '，是新高，需要重新评估仓位。'}`,
    };
  }

  if (facts.losingStreak >= policy.losingStreakThreshold) {
    return {
      wake: true,
      trigger: 'losing_streak',
      why: `已连续亏损 ${facts.losingStreak} 笔（阈值 ${policy.losingStreakThreshold}），参数可能与当前市场不匹配。`,
    };
  }

  if (facts.rejectionsSinceLastWake >= policy.rejectionThreshold) {
    return {
      wake: true,
      trigger: 'rejections',
      why: `上次唤醒后被风控拒绝 ${facts.rejectionsSinceLastWake} 次（阈值 ${policy.rejectionThreshold}），说明模型在提注定被拒的请求 —— 参数与市场脱节。`,
    };
  }

  /*
   * 长期零成交。
   *
   * 放在"有新结果"**之前**：一个连续 20 轮没开仓的机器人，
   * 比"刚平了一笔"更值得审视 —— 前者说明参数可能根本不可达，
   * 而后者只是一个数据点。
   */
  if (facts.idleCycles >= policy.idleCycleThreshold) {
    return {
      wake: true,
      trigger: 'idle',
      why:
        `已连续 ${facts.idleCycles} 个周期没有任何开仓（阈值 ${policy.idleCycleThreshold}），` +
        '且这期间没有成交、没有被拒、权益也没有变化 —— ' +
        '**所有既有判据都是 0，只有这条能发现"参数可能不可达"**。请检查入场门槛在当前账户规模与行情下是否成立。',
    };
  }

  if (facts.newClosedTrades > 0) {
    /*
     * 有新的真实结果 —— 这是**唯一能产生真实反馈的事件**，也是"学习"的原料。
     *
     * 但它的优先级排在跌倒/连亏/被拒之后：单笔结果的信息量最低（一笔的盈亏
     * 几乎全是噪声），而它出现的频率最高。把它排前面会让大脑每次都醒在
     * "最不值得醒"的时刻。
     */
    return {
      wake: true,
      trigger: 'new_result',
      why: `有 ${facts.newClosedTrades} 笔新的平仓结果（净 ${facts.netPnlSinceLastWake.toFixed(4)}），可以据此更新判断。`,
    };
  }

  /*
   * 兜底：防饿死。
   *
   * 没有这一条，一个"每笔都亏一点点、但从不触发任何阈值"的账户会在没有人
   * 审视的情况下慢慢失血 —— 而那正是最需要有人看一眼的情形。
   */
  if (facts.minutesSinceLastWake >= policy.maxIdleMinutes) {
    return {
      wake: true,
      trigger: 'timeout',
      why: `距上次唤醒已 ${facts.minutesSinceLastWake} 分钟（兜底 ${policy.maxIdleMinutes} 分钟），即使没有新事件也要审视一次，避免长时间无人看管。`,
    };
  }

  return {
    wake: false,
    trigger: 'none',
    why: `没有值得唤醒的事件（新结果 0 笔、连亏 ${facts.losingStreak} 笔、权益变化 ${facts.equityDriftPercent.toFixed(2)}%），且未到兜底时间。`,
  };
}

/* -------------------------------------------------------------------------- */
/*  回填：把"之后真实发生了什么"结算掉                                          */
/* -------------------------------------------------------------------------- */

/** 一条等待结算的实验，只需要这几个字段就够判断能不能结算。 */
export interface PendingExperiment {
  id: number;
  createdAt: string;
}

export interface SettleDecision {
  settle: boolean;
  why: string;
}

/**
 * 判断一条实验能不能结算了。
 *
 * **为什么必须等够笔数再结算**：调参之后的第一笔恰好赚钱，不代表那次调参是对的。
 * 拿一两笔去结算，会把噪声写进 `outcome_net_pnl`，而那个数字**会被回喂给策略师
 * 当作"上次这么改的效果"** —— 于是它学到的是一堆噪声。
 *
 * 所以宁可晚一点结算：等够 `minTrades` 笔，或者等到超过 `maxWaitMinutes`
 * （哪怕不够笔数也要给个交代，否则这条实验会永远挂在待结算里）。
 */
export function decideSettle(
  pending: PendingExperiment,
  stats: { tradesSince: number; netPnlSince: number; nowMs: number },
  policy: { minTrades: number; maxWaitMinutes: number } = { minTrades: 5, maxWaitMinutes: 24 * 60 },
): SettleDecision & { outcome?: { trades: number; netPnl: number } } {
  const waited = (stats.nowMs - new Date(pending.createdAt).getTime()) / 60_000;

  if (stats.tradesSince >= policy.minTrades) {
    return {
      settle: true,
      why: `已有 ${stats.tradesSince} 笔结果（门槛 ${policy.minTrades}），可以结算。`,
      outcome: { trades: stats.tradesSince, netPnl: stats.netPnlSince },
    };
  }

  if (waited >= policy.maxWaitMinutes) {
    return {
      settle: true,
      why: `等了 ${Math.round(waited)} 分钟仍只有 ${stats.tradesSince} 笔结果（门槛 ${policy.minTrades}），照实结算并标明样本不足 —— 让它一直挂着比一个不精确的数字更糟。`,
      outcome: { trades: stats.tradesSince, netPnl: stats.netPnlSince },
    };
  }

  return {
    settle: false,
    why: `只有 ${stats.tradesSince} 笔结果（门槛 ${policy.minTrades}），等够了再结算 —— 用一两笔去判断调参是否有效是在学噪声。`,
  };
}
