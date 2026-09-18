import {
  isCloseAction,
  isAdjustAction,
  isResizeAction,
  isMajorSymbol,
  isOpenAction,
  type Decision,
  type MarketSnapshot,
  type PositionView,
  type StrategyConfig,
} from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  Environment the engine reasons about                                       */
/* -------------------------------------------------------------------------- */

export interface RiskAccount {
  equity: number;
  availableBalance: number;
  marginUsed: number;
  positionCount: number;
}

/**
 * Everything the risk engine needs. Note that this deliberately contains *no*
 * model output: the engine's job is to judge proposals against facts.
 */
export interface RiskEnvironment {
  config: StrategyConfig;
  account: RiskAccount;
  /** Open positions keyed by symbol. */
  positions: ReadonlyMap<string, PositionView>;
  /** Current market snapshot keyed by symbol, used for fallback stop distances. */
  snapshots: ReadonlyMap<string, MarketSnapshot>;
  /** Exchange-imposed minimum notional for a symbol. */
  minNotionalOf(symbol: string): number;
  /** Rounds a notional to a tradable quantity; returns 0 when unrepresentable. */
  quantityFor(symbol: string, notionalUsd: number, price: number): number;
  /** New entries already taken during the current cycle. */
  entriesThisCycle: number;
  /** New entries taken in the trailing hour. */
  entriesLastHour: number;
  /**
   * 这个标的**往返一次**的手续费占名义价值的比例（小数：0.001 = 0.10%）。
   *
   * 由调用方从**成交记录实测**给出（`trades.performanceSince()` 的 Σ手续费 / Σ名义价值），
   * 而不是写死一个常量 —— 不同标的、不同 VIP 等级的真实费率不同，而写死的数字要么
   * 在某处过松、要么在另一处把本来能做的交易全拒掉。
   *
   * 省略或传 null 时回落到 `riskControl.fallbackRoundTripFeeRate`（只在"这个机器人
   * 还没有任何成交"时会发生）。引擎自己不去查库：仓储负责行字段转换，风控只裁决事实
   * （§5.4），这个字段就是把那个事实递进来的口子。
   */
  roundTripFeeRate?: number | null;
}

export interface RiskRejection {
  decision: Decision;
  reason: string;
}

export interface RiskVerdict {
  approved: Decision[];
  rejected: RiskRejection[];
}

/** Symbols treated as BTC/ETH-class for the looser leverage and size caps. */

function num(value: number | null | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/* -------------------------------------------------------------------------- */
/*  Risk engine                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The hard risk layer.
 *
 * This is the component the whole design hinges on: the model proposes, the
 * runtime disposes. Every limit here is enforced after the model has spoken and
 * cannot be argued with, because the model's output is untrusted input like any
 * other. Each intervention is recorded on the decision so the account owner can
 * see exactly where the runtime overruled the model.
 */
export class RiskEngine {
  /**
  /**
  /**
   * 审核「加仓」—— 在一个已有持仓上再买一部分。
   *
   * ## 为什么不重写一份判据，而是复用 `reviewOpen`
   *
   * 加仓要守的上限与开仓**完全一样**（杠杆、名义上限、保证金占用、
   * 止损距离、盈亏比、节流）。重写一份意味着**同一批规则有两个实现**，
   * 而它们迟早会分叉 —— 那时同一笔交易在开仓时合格、在加仓时不合格，
   * 而操作员看不出为什么。
   *
   * 所以这里只做**一件事**：把"已有敞口"从额度里扣掉，
   * 然后把扣剩下的额度交给 `reviewOpen` 去判。
   *
   * ## 三个必须扣掉的东西
   *
   *   1. **持仓数**（`positionCount - 1`）—— 这一仓已经占着一个名额，
   *      不扣的话第二次加仓就会被"已达最大持仓数"挡住
   *   2. **保证金**（`marginUsed` 已由调用方传入真实值）—— 加仓要与已有仓位
   *      共享同一个 `maxMarginUsage` 预算
   *   3. **名义价值上限** —— 这里最容易被忽略：`maxNotionalByRatio` 是
   *      **单个仓位**的上限，所以加仓后 `已有 + 新增` 不能超过它。
   *      `reviewOpen` 只会拿"新增"去比，所以本方法先把新增削到剩余额度。
   */
  private reviewAdd(
    decision: Decision,
    env: RiskEnvironment,
  ): { ok: true; decision: Decision } | { ok: false; reason: string } {
    const position = env.positions.get(decision.symbol);
    if (!position) {
      return { ok: false, reason: `${decision.symbol} 没有持仓，不能加仓（要新开请用 open_long/open_short）。` };
    }

    /* 方向必须与已有持仓一致 —— 反向的"加仓"其实是先把仓位平掉再反向开。 */
    const wantsLong = decision.action === 'add_to_position';
    if ((position.side === 'long') !== wantsLong) {
      return {
        ok: false,
        reason: `${decision.symbol} 当前是${position.side === 'long' ? '多头' : '空头'}，` +
          `add_to_position 只能同向加仓；反向要先用 close_${position.side} 平掉。`,
      };
    }

    const snapshot = env.snapshots.get(decision.symbol);
    const price = snapshot?.price ?? position.markPrice;
    if (!(price > 0)) {
      return { ok: false, reason: `${decision.symbol} 没有可用价格，无法计算加仓额度。` };
    }

    /* 单仓名义上限减去已有敞口，剩下的才是这次能加的。 */
    const risk = env.config.riskControl;
    const maxRatio = isMajorSymbol(decision.symbol)
      ? risk.btcEthMaxPositionValueRatio
      : risk.altcoinMaxPositionValueRatio;
    const cap = env.account.equity * maxRatio;
    const room = cap - position.notional;

    if (!(room > 0)) {
      return {
        ok: false,
        reason:
          `${decision.symbol} 的敞口 $${position.notional.toFixed(2)} 已达单仓上限 ` +
          `$${cap.toFixed(2)}（权益的 ${maxRatio} 倍），没有加仓空间。`,
      };
    }

    /*
     * 把新增削到剩余额度，然后交给 `reviewOpen` —— 由它套用全部判据，
     * 并且**由它决定最终名义值**（`positionSizeUsd` 会被它自己的上限逻辑再算一遍）。
     */
    const requested = num(decision.positionSizeUsd, 0);
    const capped = requested > 0 ? Math.min(requested, room) : room;
    const adjustments =
      requested > room
        ? [`加仓名义已从 $${requested.toFixed(2)} 削到 $${capped.toFixed(2)}（单仓上限剩余额度）。`]
        : [];

    const verdict = this.reviewOpen(
      { ...decision, action: wantsLong ? 'open_long' : 'open_short', positionSizeUsd: capped },
      {
        ...env,
        /* 这一仓已占着名额 —— 不扣掉的话加仓会被"最大持仓数"挡住。 */
        account: { ...env.account, positionCount: Math.max(0, env.account.positionCount - 1) },
        /* 加仓不占新的"开仓节流"额度的一部分吗？占 —— 它确实是一笔新的入场。 */
      },
    );

    if (!verdict.ok) return verdict;

    /*
     * 把动作改回 `add_to_position` —— `reviewOpen` 返回的 decision 里
     * action 被换成了 `open_long` / `open_short`，而执行层靠 action 分支。
     * 忘了改回去的话，一笔加仓会被当成**新开一个仓位**去执行，
     * 而那个标的已经有仓了 —— 交易所那一侧会变成加仓（同向），
     * 但本地会插入第二行持仓，账目从此错位。
     */
    return {
      ok: true,
      decision: {
        ...verdict.decision,
        action: 'add_to_position',
        adjustments: [...verdict.decision.adjustments, ...adjustments],
      },
    };
  }

  /**
   * 审核「减仓」—— 平掉已有持仓的一部分。
   *
   * ## 它为什么比加仓简单得多
   *
   * 减仓**只降低风险**：敞口变小、保证金释放、爆仓价变远。
   * 唯一需要守的两条是"有仓可减"和"减的量合法"（大于零、不超过持仓）。
   *
   * ## 参考价必须写进 decision
   *
   * 执行层按 `positionSizeUsd` 换算数量。减仓的"名义价值"= 要减掉的那部分的名义，
   * 所以这里按**现价 × 要减的数量**算出来 —— 让执行层不需要再去猜数量。
   */
  private reviewReduce(
    decision: Decision,
    env: RiskEnvironment,
  ): { ok: true; decision: Decision } | { ok: false; reason: string } {
    const position = env.positions.get(decision.symbol);
    if (!position) {
      return { ok: false, reason: `${decision.symbol} 没有持仓，无法减仓。` };
    }

    const snapshot = env.snapshots.get(decision.symbol);
    const price = snapshot?.price ?? position.markPrice;
    if (!(price > 0)) {
      return { ok: false, reason: `${decision.symbol} 没有可用价格，无法计算减仓数量。` };
    }

    const reduceQty = num(decision.reduceQuantity, 0);
    const reducePercent = num(decision.reducePercent, 0);

    let fraction = 0;
    if (reduceQty > 0) {
      fraction = reduceQty / position.quantity;
    } else if (reducePercent > 0) {
      fraction = reducePercent / 100;
    } else {
      return {
        ok: false,
        reason: '减仓要给出 reduce_percent（1–100）或 reduce_quantity，两个都没给。',
      };
    }

    if (!(fraction > 0)) {
      return { ok: false, reason: '减仓比例必须大于 0。' };
    }
    if (fraction >= 1) {
      return {
        ok: false,
        reason: '减仓比例不能达到 100% —— 要全部平掉请用 close_long / close_short。',
      };
    }

    /*
     * 减完之后不能小于交易所的最小下单量。
     *
     * 否则会出现"减完剩下的这半份根本挂不出去"的局面 —— 保护单下不了、
     * 想再减也下不了，那个残仓只能靠全部平掉来收拾。
     * 与其让操作员事后发现，不如当场拒绝并说清。
     */
    const remaining = position.quantity * (1 - fraction);
    const minQty = env.quantityFor(decision.symbol, env.minNotionalOf(decision.symbol), price);
    if (minQty > 0 && remaining < minQty) {
      return {
        ok: false,
        reason:
          `减 ${(fraction * 100).toFixed(0)}% 之后只剩 ${remaining}，低于该标的的最小下单量 ${minQty} —— ` +
          '那样剩下的残仓既挂不了保护单也减不动。要么少减一点，要么直接全部平掉。',
      };
    }

    return {
      ok: true,
      decision: {
        ...decision,
        /* 执行层按这个换算数量：要减掉的那部分的名义价值。 */
        positionSizeUsd: position.quantity * fraction * price,
        leverage: position.leverage,
      },
    };
  }

  /**
   * 审核「调整保护位」。
   *
   * ## 它为什么需要独立审核，而不是直接放行
   *
   * 这个动作**不改变持仓数量、不占用保证金**，所以它看起来"无害"。
   * 但它能造成两种很坏的后果：
   *
   *   1. **把止损移到错误的一侧** —— 多头止损放到现价之上，
   *      交易所会立刻触发它，等于市价平仓（而模型以为自己只是"设了个止损"）
   *   2. **把止损设得离现价太近** —— 下一根 K 线的正常波动就扫掉它，
   *      于是这笔交易的结局由噪音决定，而不是由判断决定
   *
   * 两个都是 §2.1「模型提议、运行时裁决」要拦的东西：
   * **模型的意图可能是对的（"这笔该保护一下"），而它填的数字可能不成立。**
   *
   * ## 与 `reviewOpen` 共用同一批评据
   *
   * 止损必须在正确一侧、距离必须 ≥ 往返成本的若干倍 —— 这两条在开仓时
   * 已经有一份实现（第 6 条与 `minStopLossFeeMultiple`）。**这里用同一份判断**
   * （同一套 `roundTripFeeRate` 回退逻辑），否则同一个止损在开仓时合格、
   * 移动时不合格，而操作员看不出为什么。
   */
  private reviewAdjust(
    decision: Decision,
    env: RiskEnvironment,
  ): { ok: true; decision: Decision } | { ok: false; reason: string } {
    const position = env.positions.get(decision.symbol);
    if (!position) {
      return { ok: false, reason: `${decision.symbol} 没有持仓，无法调整保护位。` };
    }

    const snapshot = env.snapshots.get(decision.symbol);
    const price = snapshot?.price ?? position.markPrice ?? position.entryPrice;
    if (!(price > 0)) {
      return { ok: false, reason: `${decision.symbol} 拿不到现价，无法判断保护位是否有效。` };
    }

    const isLong = position.side === 'long';
    const stop = decision.stopLoss;
    const target = decision.takeProfit;

    if (stop === null && target === null) {
      return { ok: false, reason: '要调整保护位，但止损和止盈两个都没给。' };
    }

    /*
     * 止损必须在**保护**的一侧。
     *
     * 多头止损 ≥ 现价 意味着"价格一碰就平" —— 那不是保护，是立刻市价平仓。
     * 空头止损 ≤ 现价同理。
     */
    if (stop !== null) {
      if (isLong && !(stop < price)) {
        return { ok: false, reason: `多头止损 ${stop} 必须在现价 ${price} 之下。` };
      }
      if (!isLong && !(stop > price)) {
        return { ok: false, reason: `空头止损 ${stop} 必须在现价 ${price} 之上。` };
      }

      /* 距离必须盖过往返成本 —— 与开仓同一把尺子、同一套回退。 */
      const risk = env.config.riskControl;
      const feeMultiple = risk.minStopLossFeeMultiple;
      const observed = env.roundTripFeeRate;
      const roundTripFeeRate =
        typeof observed === 'number' && Number.isFinite(observed) && observed > 0
          ? observed
          : risk.fallbackRoundTripFeeRate;

      const distancePercent = (Math.abs(price - stop) / price) * 100;
      const minPercent = roundTripFeeRate * feeMultiple * 100;

      /* 容差 1e-9：恰好等于 K × 手续费时必须通过 —— 与 `reviewOpen` 一致。 */
      if (feeMultiple > 0 && distancePercent + 1e-9 < minPercent) {
        return {
          ok: false,
          reason:
            `止损距离 ${distancePercent.toFixed(3)}% 低于往返成本的 ${feeMultiple} 倍` +
            `（${minPercent.toFixed(3)}%）—— 这么近的止损会被正常波动扫掉，` +
            '结局由噪音决定而不是由判断决定。',
        };
      }
    }

    /* 止盈同样必须在目标一侧，否则它一挂上就成交。 */
    if (target !== null) {
      if (isLong && !(target > price)) {
        return { ok: false, reason: `多头止盈 ${target} 必须在现价 ${price} 之上。` };
      }
      if (!isLong && !(target < price)) {
        return { ok: false, reason: `空头止盈 ${target} 必须在现价 ${price} 之下。` };
      }
    }

    /*
     * **移动方向必须对仓位有利。**
     *
     * 多头把止损往上移是收紧保护；往下移是放松保护 ——
     * 后者在一笔已有浮盈的仓位上是**主动扩大风险**。
     * 允许它意味着模型可以把一个已经移到保本的止损再挪回去，
     * 而那正是"浮盈回吐"的成因。
     *
     * 没有旧止损时放行：那是在给一个裸仓位补保护，方向问题不存在。
     */
    if (stop !== null && position.stopLoss !== null && position.stopLoss > 0) {
      if (isLong && stop < position.stopLoss) {
        return {
          ok: false,
          reason:
            `多头止损只能往上移（当前 ${position.stopLoss}，你给的是 ${stop}）` +
            '—— 往下移是主动扩大风险。',
        };
      }
      if (!isLong && stop > position.stopLoss) {
        return {
          ok: false,
          reason:
            `空头止损只能往下移（当前 ${position.stopLoss}，你给的是 ${stop}）` +
            '—— 往上移是主动扩大风险。',
        };
      }
    }

    return {
      ok: true,
      decision: {
        ...decision,
        stopLoss: stop ?? position.stopLoss,
        takeProfit: target ?? position.takeProfit,
        /* 调保护不动数量与杠杆 —— 固定成持仓的真实值，免得下游误读。 */
        positionSizeUsd: position.notional,
        leverage: position.leverage,
      },
    };
  }

  /**
   * Review a full batch of decisions.
   *
   * Closes are always evaluated first and are almost never blocked — reducing
   * exposure is the safe direction, and refusing to close is how a bot turns a
   * small loss into a liquidation. Opens are evaluated against the live budget,
   * which shrinks as earlier opens in the same batch consume margin.
   */
  review(decisions: Decision[], env: RiskEnvironment): RiskVerdict {
    const approved: Decision[] = [];
    const rejected: RiskRejection[] = [];

    // A running view of the budget so that several opens in one batch cannot
    // collectively exceed the account's limits.
    let positionCount = env.account.positionCount;
    let marginUsed = env.account.marginUsed;
    let entriesThisCycle = env.entriesThisCycle;

    const ordered = [
      ...decisions.filter((d) => isCloseAction(d.action)),
      /*
       * 调保护位与减仓排在开仓之前 —— 与 `ACTION_PRIORITY` 同一个理由：
       * **先把手里的仓位弄安全，再去冒险。**
       *
       * ⚠️ **每一个动作都必须落进这个数组的某一个桶里。**
       * 我加这两个动作时只把它们从"其他"那个桶里排除掉，**忘了给它们自己的桶** ——
       * 于是加仓/减仓的决策被整个丢掉：既不放行、也不拒绝，
       * 而模型以为它做了什么。这正是我在 `isResizeAction` 注释里警告过的失效模式，
       * 而它以另一种形式又发生了一次。
       */
      ...decisions.filter((d) => isAdjustAction(d.action)),
      ...decisions.filter((d) => d.action === 'reduce_position'),
      ...decisions.filter((d) => isOpenAction(d.action)),
      ...decisions.filter((d) => d.action === 'add_to_position'),
      ...decisions.filter(
        (d) =>
          !isCloseAction(d.action) &&
          !isOpenAction(d.action) &&
          !isAdjustAction(d.action) &&
          !isResizeAction(d.action),
      ),
    ];

    for (const decision of ordered) {
      if (isCloseAction(decision.action)) {
        const verdict = this.reviewClose(decision, env);
        if (verdict.ok) approved.push(verdict.decision);
        else rejected.push({ decision, reason: verdict.reason });
        continue;
      }

      if (isAdjustAction(decision.action)) {
        const verdict = this.reviewAdjust(decision, env);
        if (verdict.ok) approved.push(verdict.decision);
        else rejected.push({ decision, reason: verdict.reason });
        continue;
      }

      /*
       * 加仓 / 减仓。
       *
       * 加仓**占用额度**（它是新的一笔入场），所以要通过与开仓同一批上限；
       * 减仓只释放风险，不占额度。
       * 两者都并入 `marginUsed` 的滚动视图 —— 同一批里先加仓再算别的仓位时，
       * 那笔保证金必须已经被算进去。
       */
      if (decision.action === 'add_to_position') {
        const verdict = this.reviewAdd(decision, {
          ...env,
          account: { ...env.account, positionCount, marginUsed },
        });
        if (verdict.ok) {
          approved.push(verdict.decision);
          entriesThisCycle += 1;
          const snapshot = env.snapshots.get(decision.symbol);
          const price = snapshot?.price ?? 0;
          if (price > 0) {
            marginUsed += verdict.decision.positionSizeUsd / Math.max(verdict.decision.leverage, 1);
          }
        } else {
          rejected.push({ decision, reason: verdict.reason });
        }
        continue;
      }

      if (decision.action === 'reduce_position') {
        const verdict = this.reviewReduce(decision, env);
        if (verdict.ok) {
          approved.push(verdict.decision);
          /* 减仓释放保证金 —— 让同一批里后面的开仓看得见这部分空间。 */
          const snapshot = env.snapshots.get(decision.symbol);
          const price = snapshot?.price ?? 0;
          if (price > 0) {
            marginUsed = Math.max(
              0,
              marginUsed - verdict.decision.positionSizeUsd / Math.max(verdict.decision.leverage, 1),
            );
          }
        } else {
          rejected.push({ decision, reason: verdict.reason });
        }
        continue;
      }

      if (isOpenAction(decision.action)) {
        const verdict = this.reviewOpen(decision, {
          ...env,
          account: { ...env.account, positionCount, marginUsed },
          entriesThisCycle,
        });
        if (verdict.ok) {
          approved.push(verdict.decision);
          positionCount += 1;
          entriesThisCycle += 1;
          // Charge the prospective margin so the next open in this batch sees it.
          const snapshot = env.snapshots.get(decision.symbol);
          const price = snapshot?.price ?? 0;
          if (price > 0) {
            marginUsed += verdict.decision.positionSizeUsd / Math.max(verdict.decision.leverage, 1);
          }
        } else {          rejected.push({ decision, reason: verdict.reason });
        }
        continue;
      }

      // hold / wait carry no risk.
      approved.push(decision);
    }

    return { approved, rejected };
  }

  /* ---------------------------------------------------------------------- */
  /*  Closes                                                                 */
  /* ---------------------------------------------------------------------- */

  private reviewClose(
    decision: Decision,
    env: RiskEnvironment,
  ): { ok: true; decision: Decision } | { ok: false; reason: string } {
    const position = env.positions.get(decision.symbol);
    if (!position) {
      return { ok: false, reason: `${decision.symbol} 当前没有可平仓的持仓。` };
    }

    const { minHoldMinutes } = env.config.throttle;
    if (minHoldMinutes > 0) {
      const heldMinutes = (Date.now() - new Date(position.openedAt).getTime()) / 60_000;
      if (heldMinutes < minHoldMinutes) {
        return {
          ok: false,
          reason: `未满足最小持仓时间：已持仓 ${heldMinutes.toFixed(1)} 分钟，要求 ${minHoldMinutes} 分钟。`,
        };
      }
    }

    return { ok: true, decision };
  }

  /* ---------------------------------------------------------------------- */
  /*  Opens                                                                  */
  /* ---------------------------------------------------------------------- */

  private reviewOpen(
    decision: Decision,
    env: RiskEnvironment,
  ): { ok: true; decision: Decision } | { ok: false; reason: string } {
    const { config, account } = env;
    const risk = config.riskControl;
    const symbol = decision.symbol;
    const isLong = decision.action === 'open_long';
    const adjustments: string[] = [];

    /* --- 0. Preconditions ------------------------------------------------ */
    if (account.equity <= 0) {
      return { ok: false, reason: '账户权益为 0，无法计算仓位大小。' };
    }

    const snapshot = env.snapshots.get(symbol);
    if (!snapshot || !(snapshot.price > 0)) {
      return { ok: false, reason: `${symbol} 没有可用价格，拒绝在无价格依据的情况下盲目下单。` };
    }
    const price = snapshot.price;

    /* --- 1. Position slots ----------------------------------------------- */
    if (account.positionCount >= risk.maxPositions) {
      return {
        ok: false,
        reason: `已达最大同时持仓数（${account.positionCount}/${risk.maxPositions}）。`,
      };
    }

    /* --- 2. Confidence --------------------------------------------------- */
    if (decision.confidence < risk.minConfidence) {
      return {
        ok: false,
        reason: `置信度 ${decision.confidence} 低于要求的最低值 ${risk.minConfidence}。`,
      };
    }

    /* --- 3. Leverage clamp ----------------------------------------------- */
    const maxLeverage = isMajorSymbol(symbol) ? risk.btcEthMaxLeverage : risk.altcoinMaxLeverage;
    let leverage = Math.round(num(decision.leverage, 0));
    if (leverage <= 0) {
      leverage = Math.min(risk.defaultLeverage, maxLeverage);
      adjustments.push(`模型未给出杠杆，已使用默认值 ${leverage}x。`);
    }
    if (leverage > maxLeverage) {
      adjustments.push(`杠杆已从 ${leverage}x 压到上限 ${maxLeverage}x。`);
      leverage = maxLeverage;
    }

    /* --- 4. Stop loss ---------------------------------------------------- */
    let stopLoss = decision.stopLoss;
    if (stopLoss === null || !(stopLoss > 0)) {
      if (risk.requireStopLoss && risk.fallbackStopLossPercent <= 0) {
        return { ok: false, reason: '未提供止损，且兜底止损已被禁用。' };
      }
      const distance = price * (risk.fallbackStopLossPercent / 100);
      stopLoss = isLong ? price - distance : price + distance;
      adjustments.push(
        `模型未给出止损，已按配置的 ${risk.fallbackStopLossPercent}% 兜底比例设为 ${stopLoss.toFixed(6)}。`,
      );
    }

    /* --- 5. Take profit -------------------------------------------------- */
    let takeProfit = decision.takeProfit;
    if (takeProfit === null || !(takeProfit > 0)) {
      if (risk.requireTakeProfit && risk.fallbackTakeProfitPercent <= 0) {
        return { ok: false, reason: '未提供止盈，且兜底止盈已被禁用。' };
      }
      const distance = price * (risk.fallbackTakeProfitPercent / 100);
      takeProfit = isLong ? price + distance : price - distance;
      adjustments.push(
        `模型未给出止盈，已按配置的 ${risk.fallbackTakeProfitPercent}% 兜底比例设为 ${takeProfit.toFixed(6)}。`,
      );
    }

    /* --- 6. Protection must sit on the correct side ---------------------- */
    if (isLong && !(stopLoss < price)) {
      return {
        ok: false,
        reason: `多头止损无效：止损价 ${stopLoss} 未低于当前价 ${price}。`,
      };
    }
    if (!isLong && !(stopLoss > price)) {
      return {
        ok: false,
        reason: `空头止损无效：止损价 ${stopLoss} 未高于当前价 ${price}。`,
      };
    }
    if (isLong && !(takeProfit > price)) {
      return {
        ok: false,
        reason: `多头止盈无效：止盈价 ${takeProfit} 未高于当前价 ${price}。`,
      };
    }
    if (!isLong && !(takeProfit < price)) {
      return {
        ok: false,
        reason: `空头止盈无效：止盈价 ${takeProfit} 未低于当前价 ${price}。`,
      };
    }

    /* --- 6b. 止损距离必须覆盖往返手续费（提案 §5） ------------------------ */
    /*
     * 一笔止损比往返手续费还近的交易，**即使方向做对了也是亏的**：价格必须先走完
     * 成本，才开始为账户挣钱。原来的风控只有 `minRiskRewardRatio`（要求盈亏比），
     * 而它有个漏洞 —— 一笔盈亏比达标但止损距离小于往返成本的交易，是数学上必亏的：
     * 止损幅度等于手续费时，胜率再高也只是在给交易所打工。
     *
     * 这条规则会拒掉一批"看起来没问题"的交易，而那正是目的：它把"手续费"从模型的
     * 一个考虑项，变成一条由代码强制执行的入场边界。**它只新增拒绝，不放宽任何
     * 既有上限**（§4.2）。
     *
     * 标记成 6b 而不是新增一段 14：源码里的这些数字标记与 `docs/MODULES.md`、
     * `docs/AGENTS.md` 的「14 步检查（源码标记 0–13）」一一对应，重编号会让那两份
     * 文档失准，而本次改动不允许改文档。校验本身是完整的一步，不是附属条件。
     */
    const feeMultiple = risk.minStopLossFeeMultiple;
    const observedFeeRate = env.roundTripFeeRate;
    const roundTripFeeRate =
      typeof observedFeeRate === 'number' && Number.isFinite(observedFeeRate) && observedFeeRate > 0
        ? observedFeeRate
        : risk.fallbackRoundTripFeeRate;
    const riskDistance = Math.abs(price - stopLoss);
    const stopDistancePercent = (riskDistance / price) * 100;
    const minStopDistancePercent = roundTripFeeRate * feeMultiple * 100;

    /*
     * 容差 1e-9：止损幅度**恰好**等于 K × 手续费时必须通过。取"至少 K 倍"的字面意思，
     * 不额外收紧 —— 一个比宣称更严的门槛会让照做的人莫名其妙被拒，那比没有规则更糟。
     */
    if (feeMultiple > 0 && stopDistancePercent + 1e-9 < minStopDistancePercent) {
      const feeSource =
        observedFeeRate === null || observedFeeRate === undefined ? '配置的兜底费率' : '近期成交实测';
      return {
        ok: false,
        reason:
          `止损距离 ${stopDistancePercent.toFixed(3)}%（${price} → ${stopLoss}）不足往返手续费的 ${feeMultiple} 倍：` +
          /*
           * 最小幅度用 4 位小数，实际幅度用 3 位。
           *
           * 实测费率常常不是整数（模拟账户里就是 0.1001%），于是最小幅度是 0.3003% ——
           * 两者都只显示 3 位时会打印成"止损距离 0.300% …… 至少要有 0.300%"，读起来
           * 像一条自相矛盾的规则。数字的精度在这里是给人看的，多一位就没有歧义。
           */
          `按${feeSource}，往返成本约 ${(roundTripFeeRate * 100).toFixed(4)}%，止损幅度至少要有 ${minStopDistancePercent.toFixed(4)}%。` +
          '止损比交易成本还近的交易，方向做对了也是亏的。',
      };
    }
    if (feeMultiple > 0) {
      adjustments.push(
        `止损距离 ${stopDistancePercent.toFixed(3)}% ≥ 往返成本 ${(roundTripFeeRate * 100).toFixed(4)}% 的 ${feeMultiple} 倍。`,
      );
    }

    /* --- 7. Reward:risk -------------------------------------------------- */
    const rewardDistance = Math.abs(takeProfit - price);
    const rewardRisk = riskDistance > 0 ? rewardDistance / riskDistance : 0;
    if (rewardRisk < risk.minRiskRewardRatio) {
      return {
        ok: false,
        reason: `盈亏比 1:${rewardRisk.toFixed(2)} 低于要求的 1:${risk.minRiskRewardRatio}。`,
      };
    }

    /* --- 8. Notional ----------------------------------------------------- */
    const maxRatio = isMajorSymbol(symbol) ? risk.btcEthMaxPositionValueRatio : risk.altcoinMaxPositionValueRatio;
    const maxNotionalByRatio = account.equity * maxRatio;

    let notional = num(decision.positionSizeUsd, 0);

    if (notional <= 0) {
      // Derive from the stated risk budget when available — this is the most
      // faithful reading of the model's intent.
      const riskUsd = num(decision.riskUsd, 0);
      if (riskUsd > 0 && riskDistance > 0) {
        notional = (riskUsd / riskDistance) * price;
        adjustments.push(
          `按模型给出的风险金额 $${riskUsd.toFixed(2)} 反推仓位，名义价值 $${notional.toFixed(2)}。`,
        );
      } else {
        notional = Math.min(maxNotionalByRatio, account.equity * 0.1);
        adjustments.push(
          `模型未给出仓位大小，已默认使用 $${notional.toFixed(2)} 名义价值（权益的 10%）。`,
        );
      }
    }

    if (notional > maxNotionalByRatio) {
      adjustments.push(
        `名义价值已从 $${notional.toFixed(2)} 降至 $${maxNotionalByRatio.toFixed(2)}（上限为权益的 ${maxRatio} 倍）。`,
      );
      notional = maxNotionalByRatio;
    }

    /* --- 9. Margin budget ------------------------------------------------ */
    const requiredMargin = notional / leverage;
    const maxAllowedMargin = account.equity * (risk.maxMarginUsage / 100);
    const marginHeadroom = Math.max(0, maxAllowedMargin - account.marginUsed);
    const spendable = Math.min(marginHeadroom, Math.max(0, account.availableBalance));

    if (requiredMargin > spendable) {
      const reducedNotional = spendable * leverage;
      adjustments.push(
        `名义价值已从 $${notional.toFixed(2)} 降至 $${reducedNotional.toFixed(2)}，以适配可用保证金（$${spendable.toFixed(2)}）。`,
      );
      notional = reducedNotional;
    }

    /* --- 10. Minimums ---------------------------------------------------- */
    const exchangeMin = env.minNotionalOf(symbol);
    const effectiveMin = Math.max(risk.minPositionSize, exchangeMin);
    if (notional < effectiveMin) {
      return {
        ok: false,
        reason: `仓位名义价值 $${notional.toFixed(2)} 低于最低要求 $${effectiveMin.toFixed(2)}。`,
      };
    }
    if (marginHeadroom <= 0) {
      return {
        ok: false,
        reason: `保证金占用已达 ${risk.maxMarginUsage}% 上限，没有空间开新仓。`,
      };
    }

    /* --- 11. Enforce entry throttling ------------------------------------ */
    if (env.entriesThisCycle >= config.throttle.maxEntriesPerCycle) {
      return {
        ok: false,
        reason: `开仓节流：本周期已开 ${env.entriesThisCycle} 仓（上限 ${config.throttle.maxEntriesPerCycle}）。`,
      };
    }
    if (env.entriesLastHour >= config.throttle.maxEntriesPerHour) {
      return {
        ok: false,
        reason: `开仓节流：最近一小时内已开 ${env.entriesLastHour} 仓（上限 ${config.throttle.maxEntriesPerHour}）。`,
      };
    }

    /* --- 12. Tradability ------------------------------------------------- */
    const quantity = env.quantityFor(symbol, notional, price);
    if (quantity <= 0) {
      return {
        ok: false,
        reason: `${symbol} 按交易所最小变动单位取整后为 0 张，请调大 position_size_usd。`,
      };
    }

    // Re-derive the notional from the actually-tradable quantity so that every
    // recorded figure matches what the exchange will really fill.
    const finalNotional = quantity * price;
    if (finalNotional < effectiveMin) {
      return {
        ok: false,
        reason: `取整后的数量（${quantity}）价值 $${finalNotional.toFixed(2)}，低于最低要求 $${effectiveMin.toFixed(2)}。`,
      };
    }
    if (Math.abs(finalNotional - notional) > 1e-9) {
      adjustments.push(
        `名义价值已调整为 $${finalNotional.toFixed(2)} 以匹配交易所最小下单单位（数量 ${quantity}）。`,
      );
    }

    /* --- 13. Snap both protection levels to a valid side of the entry ------ */
    const roundedStop = clampStopLoss(stopLoss, price, isLong);
    const roundedTarget = clampTakeProfit(takeProfit, price, isLong);

    const finalRiskUsd = Math.abs(price - roundedStop) * quantity;
    const riskPercentOfEquity = account.equity > 0 ? (finalRiskUsd / account.equity) * 100 : 0;

    return {
      ok: true,
      decision: {
        ...decision,
        leverage,
        positionSizeUsd: finalNotional,
        stopLoss: roundedStop,
        takeProfit: roundedTarget,
        riskUsd: finalRiskUsd,
        adjustments: [
          ...decision.adjustments,
          ...adjustments,
          `本笔交易风险 $${finalRiskUsd.toFixed(2)}（占权益 ${riskPercentOfEquity.toFixed(2)}%）。`,
        ],
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Keep the stop on the safe side of the entry after rounding.
 *
 * A long stop that lands *above* the entry, or a short stop below it, would be
 * triggered immediately on entry. These helpers clamp in the safe direction
 * only — the take-profit needs the mirror-image clamp, and conflating the two
 * silently inverts the target for every trade.
 */
function clampStopLoss(value: number, price: number, isLong: boolean): number {
  const rounded = Number(value.toPrecision(12));
  return isLong ? Math.min(rounded, price * 0.999999) : Math.max(rounded, price * 1.000001);
}

/** Mirror of `clampStopLoss`: a target must stay beyond the entry, never inside it. */
function clampTakeProfit(value: number, price: number, isLong: boolean): number {
  const rounded = Number(value.toPrecision(12));
  return isLong ? Math.max(rounded, price * 1.000001) : Math.min(rounded, price * 0.999999);
}

/* -------------------------------------------------------------------------- */
/*  Drawdown guard                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The "giveback" rule: a position that has shown a decent profit is closed if it
 * surrenders too much of that peak.
 *
 * This exists because models are systematically bad at protecting open profit —
 * they keep finding reasons to hold a winner that has already turned. The rule
 * is mechanical and outside the model's control.
 */
export function shouldCloseForDrawdown(
  position: PositionView,
  config: StrategyConfig,
): { close: boolean; reason: string } {
  const guard = config.drawdownGuard;
  if (!guard.enabled) return { close: false, reason: '' };

  const peak = position.peakPnlPercent;
  if (peak < guard.activationPercent) return { close: false, reason: '' };

  const current = position.unrealizedPnlPercent;
  if (current <= 0) {
    return {
      close: current < 0 && peak >= guard.activationPercent,
      reason:
        current < 0
          ? `回撤守卫：该仓位最高浮盈 +${peak.toFixed(2)}%，当前已转为亏损（${current.toFixed(2)}%）。`
          : '',
    };
  }

  const giveback = (peak - current) / peak;
  if (giveback >= guard.givebackRatio) {
    return {
      close: true,
      reason: `回撤守卫：最高浮盈 +${peak.toFixed(2)}%，当前 +${current.toFixed(2)}%，已回吐峰值的 ${(giveback * 100).toFixed(0)}%（上限 ${(guard.givebackRatio * 100).toFixed(0)}%）。`,
    };
  }

  return { close: false, reason: '' };
}

/* -------------------------------------------------------------------------- */
/*  Circuit breakers                                                           */
/* -------------------------------------------------------------------------- */

export interface CircuitBreakerState {
  /** Realised PnL since 00:00 UTC. */
  dailyRealizedPnl: number;
  /** Highest equity ever recorded for this trader. */
  highWaterEquity: number;
}

export interface CircuitBreakerVerdict {
  /** When true, no new positions may be opened. */
  blocked: boolean;
  reason: string;
}

/**
 * Stop opening new positions when the account is bleeding.
 *
 * Deliberately does *not* close existing positions — that is the drawdown
 * guard's job. This only prevents digging the hole deeper.
 */
export function checkCircuitBreakers(
  config: StrategyConfig,
  equity: number,
  state: CircuitBreakerState,
): CircuitBreakerVerdict {
  const { maxDailyLossPercent, maxTotalDrawdownPercent } = config.circuitBreaker;

  if (maxTotalDrawdownPercent > 0 && state.highWaterEquity > 0) {
    const drawdown = ((state.highWaterEquity - equity) / state.highWaterEquity) * 100;
    if (drawdown >= maxTotalDrawdownPercent) {
      return {
        blocked: true,
        reason: `总回撤熔断：权益较最高水位 $${state.highWaterEquity.toFixed(2)} 回撤了 ${drawdown.toFixed(2)}%（上限 ${maxTotalDrawdownPercent}%）。`,
      };
    }
  }

  if (maxDailyLossPercent > 0 && equity > 0 && state.dailyRealizedPnl < 0) {
    const dailyLossPercent = (Math.abs(state.dailyRealizedPnl) / equity) * 100;
    if (dailyLossPercent >= maxDailyLossPercent) {
      return {
        blocked: true,
        reason: `单日亏损熔断：今日已实现亏损 $${Math.abs(state.dailyRealizedPnl).toFixed(2)}，占权益 ${dailyLossPercent.toFixed(2)}%（上限 ${maxDailyLossPercent}%）。`,
      };
    }
  }

  return { blocked: false, reason: '' };
}
