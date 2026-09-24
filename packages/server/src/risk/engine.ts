import {
  isCloseAction,
  isAdjustAction,
  isCancelPendingAction,
  isResizeAction,
  isMajorSymbol,
  isOpenAction,
  type CircuitBreakerKind,
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
  /**
   * 把数量**向上**对齐到交易所的最小变动单位 —— 「上取一档」那个方向。
   *
   * ## 为什么风控需要这个方向
   *
   * 取整必须向下（多买一点就是多冒一点风险），但**向下之后恰好掉到最低名义之下**
   * 属于"差一档"，不是"这笔不成立"。直接拒会白白放掉机会 —— 实测 ETHUSDT 那一笔
   * 差 $0.53，而上取一档只比模型要的多 0.7%。
   *
   * **可选**：不实现时引擎退回旧行为（到门槛之下就拒），所以这个口子可以逐个实现
   * 慢慢接。接到之后**该不该进位仍由引擎判**（它要连带检查名义比例与保证金上限）。
   */
  quantityUpFor?(symbol: string, quantity: number): number;
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
  /**
   * 交易所**实际允许**的最大杠杆（该标的）。
   *
   * ## 为什么它必须从外面递进来
   *
   * `risk.btcEthMaxLeverage` / `altcoinMaxLeverage` 是**我们自己配的上限** —— 而
   * 交易所那边还有一个**独立的**上限，两者取小才是真正能设的值：
   *
   *   · **子账户**：普通用户 2025-08-12 之后新建的子账户，合约杠杆**不超过 5x**（官方 FAQ）；
   *   · **开户未满 30 天**：不超过 20x；
   *   · **名义价值分档**：每个 symbol 有按仓位大小分的档位，档位越高允许的杠杆越低。
   *
   * 在此之前引擎完全不知道这件事：配置写 20x，它就照 20x 批，然后 `setLeverage`
   * 被交易所拒（`-4203` / `-4205` / `-4209`），而**模型那边收到的是一句它无法
   * 预先算出来的拒绝**。
   *
   * ## 为什么是回调而不是一个 Map
   *
   * 与 `minNotionalOf` / `quantityFor` 同一个理由：**引擎只裁决事实，不查数据源**
   * （§5.4）。谁来提供这个数字（缓存、交易所、降级值）是调用方的事。
   *
   * 返回 `null` 表示"不知道" —— 那时**只用配置的上限**，行为与以前完全一致。
   * 这是刻意的：读不到档位不该让交易停下来。
   */
  exchangeMaxLeverageOf?(symbol: string): number | null;
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
     * ⚠️ **漏填金额时不能默认"加满"。**
     *
     * 原来写的是 `requested > 0 ? Math.min(requested, room) : room` —— 模型只要
     * 漏掉 `position_size_usd`（提示词只说"带上 position_size_usd"，没说漏了会怎样），
     * 这笔加仓就被顶到单仓名义上限的剩余额度。**默认值的方向与安全相反**，
     * 而漏填恰恰是模型出错时的样子。
     *
     * 对照新开仓：`reviewOpen` 遇到没给金额时取 `min(上限, 权益 × 10%)` —— 保守的
     * 那一边。加仓用同一个兜底，"模型忘记填金额"在两个动作上得到同一种待遇，
     * 操作员只需要记住一条规则。
     */
    const requested = num(decision.positionSizeUsd, 0);
    const missingAmount = !(requested > 0);
    const fallback = Math.min(room, env.account.equity * 0.1);
    const capped = missingAmount ? fallback : Math.min(requested, room);
    const adjustments = [
      ...(requested > room
        ? [`加仓名义已从 $${requested.toFixed(2)} 削到 $${capped.toFixed(2)}（单仓上限剩余额度）。`]
        : []),
      ...(missingAmount
        ? [
            `模型没有给出加仓金额，已按权益的 10%（$${fallback.toFixed(2)}）执行，` +
              `而不是可用的剩余额度 $${room.toFixed(2)} —— 漏填不等于要加满。`,
          ]
        : []),
    ];

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
      /*
       * ⚠️ **撤单排在最前面，而且总是通过。**
       *
       * 它**只降低风险**：撤掉一张挂着的入场单，等于释放一个已经承诺出去的敞口
       * （那张单成交就会变成持仓）。与 `reduce_position` 同类 —— 不需要过那批
       * "增加风险"的上限（持仓数、保证金、节流）。
       *
       * **必须放在 `isOpenAction` 那条兜底之前**：那个链式分派的最后一个分支
       * 是"当成开仓"，而 `cancel_pending` 掉进去会被当成一笔开仓去审、
       * 甚至真的被当成开仓执行。这个文件里已经为同一个坑写过两次注释。
       */
      if (isCancelPendingAction(decision.action)) {
        approved.push({ ...decision, adjustments: decision.adjustments });
        continue;
      }

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
          /*
           * ⚠️ **必须传当前的滚动计数，不能沿用 `env` 里那个入口值。**
           *
           * `env.entriesThisCycle` 是**进入 `review()` 时**的值，调用点给的是 0
           * （`autoTrader.ts` 里 `entriesThisCycle: 0`）。而加仓最终会走
           * `reviewOpen`，节流判据读的正是这两个数 —— 于是 `maxEntriesPerCycle`
           * 与 `maxEntriesPerHour` **对加仓完全无效**：模型可以在一个周期里
           * 连续加仓，节流一次都数不到。
           *
           * 而提示词明确告诉模型「加仓与新开仓共用同一批上限（杠杆、单仓名义上限、
           * 保证金占用、节流）」—— 它因此以为节流在替它兜底。**它没有。**
           *
           * 两个数都要带上本周期已经用掉的量：`entriesThisCycle` 是局部变量，
           * 它会在下面 `+= 1` 累加；`entriesLastHour` 是入口值，加上本周期已用的
           * 部分才是真实的滚动小时数。
           */
          entriesThisCycle,
          entriesLastHour: env.entriesLastHour + entriesThisCycle,
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

    /*
     * ⚠️ **这笔交易真正的入场价 —— 挂单时是挂单价，不是当前市价。**
     *
     * ## 这是一个真实的 bug，实测代价是"限价入场一次都没成功过"
     *
     * `#116` 的原始记录：
     *
     *     模型提的：open_long BNBUSDT  entry_type=limit  limit_price=800.5
     *               止损 793.5   止盈 821.5
     *     实际结果：rejected — 盈亏比 1:1.82 低于要求的 1:3
     *
     * 算一下就清楚了（当时市价 ≈803.4）：
     *
     * | 按哪个价算 | 上行 / 下行 | 盈亏比 |
     * | --- | --- | --- |
     * | **挂单价 800.5**（模型的本意）| 21.0 / **7.0** | **1:3.00** ✅ 刚好达标 |
     * | 当前市价 803.4（修之前用的）| 18.1 / 9.9 | 1:1.82 ❌ 被拒 |
     *
     * **模型做对了**：它写了 `entry_type: limit` + `limit_price`，而风控没有按
     * 那个价衡量风险收益。于是**限价入场这条链路自上线以来一次都没成功过** ——
     * 每一次都被这条判据拦下，而拦它的理由（"盈亏比不够"）**是基于一个这笔交易
     * 根本不会成交的价位算出来的**。
     *
     * ## 为什么按挂单价算才是对的
     *
     * 挂单价**就是**这笔交易的入场价 —— 那张单要么在那个价位成交、要么不成交。
     * 用当前市价去衡量它，等于在问"如果我现在市价进，风险收益如何" ——
     * **而那不是模型提的这笔交易。**
     *
     * 限价单的意义正是"等一个更好的价位"：那个更好的价位**会改善**盈亏比
     * （止损距离变近、或止盈距离变远）。用市价算就把这个改善抹掉了。
     */
    const entryPrice =
      decision.entryType === 'limit' && (decision.limitPrice ?? 0) > 0
        ? (decision.limitPrice as number)
        : price;

    /* --- 1. Position slots ----------------------------------------------- */
    if (account.positionCount >= risk.maxPositions) {
      return {
        ok: false,
        reason: `已达最大同时持仓数（${account.positionCount}/${risk.maxPositions}）。`,
      };
    }

    /* --- 2. Confidence --------------------------------------------------- */
    /*
     * ⚠️ **`null` 与 `0` 的拒绝理由必须不同。**
     *
     * 实测：模型输出的 JSON 里压根没有 `confidence`，而解析器当时填的是 `0` ——
     * 于是拒绝理由写着「置信度 0 低于要求的最低值 68」。**那句话是错的**：
     * 它会让人（和模型自己）去调低门槛，而真正的问题是这个字段从没被填过。
     *
     * 现在两者分开说：
     *   · `null` → **"你没有给出置信度"** —— 这是格式问题，调门槛没有用；
     *   · 数字   → 照旧报出实际值与门槛，那才是"真的不够自信"。
     *
     * 结果一样是拒绝（不知道把握就不该开仓），但**原因不同、该做的动作也不同**。
     * 一条把格式问题说成"信心不足"的错误理由，会让两边都往错的方向修。
     */
    if (decision.confidence === null) {
      return {
        ok: false,
        reason:
          `这一条决策没有给出置信度（\`confidence\` 字段缺失），无法判断你的把握 —— 因此不予开仓。` +
          `请在每个决策里都带上 0-100 的整数置信度；漏填不会被当作"很有把握"。`,
      };
    }
    if (decision.confidence < risk.minConfidence) {
      return {
        ok: false,
        reason: `置信度 ${decision.confidence} 低于要求的最低值 ${risk.minConfidence}。`,
      };
    }

    /* --- 3. Leverage clamp ----------------------------------------------- */
    /*
     * ⚠️ **两个上限取小**：我们自己配的，与交易所实际允许的。
     *
     * 原来只看配置那一个 —— 于是配置写 20x 就照 20x 批，然后 `setLeverage` 被
     * 交易所拒（子账户是 5x、名义价值分档还会更低）。而模型收到的是一句
     * **它无法预先算出来的**拒绝。
     *
     * `exchangeMaxLeverageOf` 返回 null（读不到）时退回旧行为 —— **读不到档位
     * 不该让交易停下来**。
     */
    const configuredMax = isMajorSymbol(symbol) ? risk.btcEthMaxLeverage : risk.altcoinMaxLeverage;
    const exchangeMax = env.exchangeMaxLeverageOf?.(symbol) ?? null;
    const maxLeverage =
      exchangeMax !== null && exchangeMax > 0 ? Math.min(configuredMax, exchangeMax) : configuredMax;
    let leverage = Math.round(num(decision.leverage, 0));
    if (leverage <= 0) {
      leverage = Math.min(risk.defaultLeverage, maxLeverage);
      adjustments.push(`模型未给出杠杆，已使用默认值 ${leverage}x。`);
    }
    if (leverage > maxLeverage) {
      adjustments.push(
        `杠杆已从 ${leverage}x 压到上限 ${maxLeverage}x` +
          (exchangeMax !== null && exchangeMax < configuredMax
            ? `（交易所对该标的实际允许的上限；配置里写的是 ${configuredMax}x）。`
            : '。'),
      );
      leverage = maxLeverage;
    }

    /* --- 4. Stop loss ---------------------------------------------------- */
    let stopLoss = decision.stopLoss;
    if (stopLoss === null || !(stopLoss > 0)) {
      if (risk.requireStopLoss && risk.fallbackStopLossPercent <= 0) {
        return { ok: false, reason: '未提供止损，且兜底止损已被禁用。' };
      }
      /*
       * ⚠️ 兜底比例按 `entryPrice` —— 挂单时这个止损是相对**挂单价**设的，
       * 而它成交也只会发生在那个价位。按市价设会让止损距离与设计不符。
       */
      const distance = entryPrice * (risk.fallbackStopLossPercent / 100);
      stopLoss = isLong ? entryPrice - distance : entryPrice + distance;
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
      const distance = entryPrice * (risk.fallbackTakeProfitPercent / 100);
      takeProfit = isLong ? entryPrice + distance : entryPrice - distance;
      adjustments.push(
        `模型未给出止盈，已按配置的 ${risk.fallbackTakeProfitPercent}% 兜底比例设为 ${takeProfit.toFixed(6)}。`,
      );
    }

    /* --- 6. Protection must sit on the correct side ---------------------- */
    /*
     * ⚠️ **方向校验按 `entryPrice`，理由与风险距离一样**：挂单那笔交易的失效位
     * 是相对**挂单价**说的。按市价判会把一笔正确的挂单判成"止损在错误的一侧"
     * —— 而那与"这笔亏不亏钱"毫无关系。
     *
     * 错误文案里说的是"未低于当前价" —— 现在它说的是**入场价**，措辞也跟着改。
     */
    if (isLong && !(stopLoss < entryPrice)) {
      return {
        ok: false,
        reason: `多头止损无效：止损价 ${stopLoss} 未低于入场价 ${entryPrice}。`,
      };
    }
    if (!isLong && !(stopLoss > entryPrice)) {
      return {
        ok: false,
        reason: `空头止损无效：止损价 ${stopLoss} 未高于入场价 ${entryPrice}。`,
      };
    }
    if (isLong && !(takeProfit > entryPrice)) {
      return {
        ok: false,
        reason: `多头止盈无效：止盈价 ${takeProfit} 未高于入场价 ${entryPrice}。`,
      };
    }
    if (!isLong && !(takeProfit < entryPrice)) {
      return {
        ok: false,
        reason: `空头止盈无效：止盈价 ${takeProfit} 未低于入场价 ${entryPrice}。`,
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
    /*
     * ⚠️ **风险距离与止损幅度都按"这笔交易真正的入场价"算**（见上面 `entryPrice`）。
     *
     * 挂单价与市价不同时，两者的差距会直接改变"止损够不够远"以及"盈亏比够不够"。
     * 用市价算会让一笔按 800.5 挂单的交易，被按 803.4 去评判 ——
     * 而它永远不会在 803.4 成交。
     */
    const riskDistance = Math.abs(entryPrice - stopLoss);
    const stopDistancePercent = (riskDistance / entryPrice) * 100;
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
    /*
     * ⚠️ **分子分母都按 `entryPrice`** —— 与上面 `riskDistance` 同一口径。
     *
     * 混用（一个按市价、一个按挂单价）会算出一个**毫无意义**的比值，
     * 而它可能恰好落在门槛两侧的任意一边。
     */
    const rewardDistance = Math.abs(takeProfit - entryPrice);
    const rewardRisk = riskDistance > 0 ? rewardDistance / riskDistance : 0;
    /*
     * ⚠️ **容差 1e-9 —— 与上面两处手续费门槛同一个写法，而这条原来漏了。**
     *
     * 实测（`#87`，2026-09-21）：
     *
     *     止损 111   止盈 115.8   市价 112.2
     *     下行 = 112.2 − 111   = 1.2
     *     上行 = 115.8 − 112.2 = 3.6
     *     盈亏比 = 3.6 / 1.2 = 2.999999999999988
     *
     * 而拒绝理由是这么写的：
     *
     *     > 盈亏比 1:3.00 低于要求的 1:3。
     *
     * **显示出来是相等的两个数，而判定是"低于"** —— 因为 `toFixed(2)` 把
     * 2.999999999999988 显示成了 `3.00`，而比较是 `2.999999999999988 < 3`。
     *
     * 于是**一个数学上刚好达标的单被拒了**。而那件事正是提示词要求它做的：
     * 「止盈 ≥ 止损幅度的 3 倍」—— **"刚好 3 倍"是按规则算出来的结果，
     * 而不该因为浮点误差变成拒绝的理由。**
     *
     * 这个文件里另外两条同类判据（`reviewAdjust` 与这里的手续费门槛）**都用了
     * 同一个 1e-9 容差** —— 只有盈亏比这条漏了。**同一个文件里有的地方用容差、
     * 有的没用，本身就是需要统一检查的信号。**
     */
    if (rewardRisk + 1e-9 < risk.minRiskRewardRatio) {
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
    let quantity = env.quantityFor(symbol, notional, price);
    if (quantity <= 0) {
      return {
        ok: false,
        reason: `${symbol} 按交易所最小变动单位取整后为 0 张，请调大 position_size_usd。`,
      };
    }

    // Re-derive the notional from the actually-tradable quantity so that every
    // recorded figure matches what the exchange will really fill.
    let finalNotional = quantity * price;

    /*
     * ⚠️ **向下取整掉到最低名义之下时，先试一档向上 —— 不要直接拒。**
     *
     * 取整方向必须向下（多买一点就是多冒一点风险），但**向下之后恰好掉到门槛之下**
     * 属于"差一档"，不是"这笔不成立"。直接拒会白白放掉一次机会。
     *
     * 实测（用户的原话：「仅仅差了 0.53，这是不是模型计算问题？这种系统是否给
     * 一定容错帮他补齐？（不然导致错失机会？）」）：ETHUSDT 报 $22.00 名义、
     * 价格 2768.18、`stepSize` 0.001 —— `$22 / 2768.18 = 0.007947`，
     * **向下取整 0.007 = $19.47**，差 $0.53 没够到 $20 的门槛，整笔被拒。
     * 而**上取一档是 0.008 = $22.15** —— 只比模型要的多 0.7%。
     *
     * ## 这不是放宽风控
     *
     * 进位后的名义**必须仍然落在这一步之前就已经算好的两个上限之内**：
     * `maxNotionalByRatio`（名义比例上限）与 `spendable`（可用保证金）。
     * 也就是说它只是"在允许的空间里把数量凑到能下单"，一条约束都没动。
     * 而门槛本身（`effectiveMin`）也一个字没改 —— 越过不了就还是拒。
     */
    if (finalNotional < effectiveMin && env.quantityUpFor) {
      const bumped = env.quantityUpFor(symbol, quantity);
      const bumpedNotional = bumped * price;
      const withinRatio = bumpedNotional <= maxNotionalByRatio + 1e-9;
      const withinMargin = bumpedNotional / leverage <= spendable + 1e-9;
      if (bumped > quantity && withinRatio && withinMargin) {
        adjustments.push(
          `数量从 ${quantity} 上取一档到 ${bumped}（名义 $${finalNotional.toFixed(2)} → ` +
            `$${bumpedNotional.toFixed(2)}），以越过最低名义 $${effectiveMin.toFixed(2)}。`,
        );
        quantity = bumped;
        finalNotional = bumpedNotional;
      } else if (bumped > quantity) {
        /*
         * ── 进位**试过了，但它会越界** —— 这一点必须说出来 ────────────────
         *
         * 用户的原话：「连续两次被风控（同一个币种），AI 好像没有记忆？
         * 头一次知道了低于最低要求 $20.00 为什么第二次还是犯错？」
         *
         * 实盘那一对（周期 #233，两次）：BNBUSDT、`$21.00`、价格 785.34、
         * `stepSize` 0.01、门槛 $20、名义上限 $21.97 ——
         *
         *     向下取整 0.02 → $15.71   < 门槛            ✗
         *     上取一档 0.03 → $23.56   > 名义上限 $21.97  ✗
         *
         * **这个标的在那个账户规模下不存在任何合规数量。** 而原来给出的理由
         * 只有前半句（"取整后低于最低要求"），于是模型读到的是"再提一点名义
         * 就行"—— 它照做了（$21 已贴着上限），当然还是被拒。
         *
         * 差距不在模型的记忆：拒绝理由是通过执行回执**回传给它的**。问题是
         * **理由里没有它能采取的行动**，于是它只能反复试同一个尺寸。
         *
         * 所以这里把"为什么进位也不行"和"因此该怎么做"讲全。这不是放宽风控 ——
         * 门槛与上限一个字没动，只是把**同一个拒绝**的真实边界说清楚。
         */
        const ratioCap = maxNotionalByRatio;
        const marginCap = spendable * leverage;
        const cap = Math.min(ratioCap, marginCap);
        const capLabel = ratioCap <= marginCap ? '名义比例上限' : '可用保证金上限';
        return {
          ok: false,
          reason:
            `取整后的数量（${quantity}）价值 $${finalNotional.toFixed(2)}，低于最低要求 $${effectiveMin.toFixed(2)}；` +
            `而上一档数量（${bumped}）价值 $${bumpedNotional.toFixed(2)}，会超过${capLabel} $${cap.toFixed(2)}。` +
            `**这个标的在当前账户规模下不存在任何合规的数量 —— 不要再对它提案，` +
            `换一个价格量级更合适的标的，或者先给账户增加资金。**`,
        };
      }
    }

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
  /**
   * 这个熔断**什么时候自己解除**。
   *
   * ⚠️ **两种熔断的解除方式完全不同，不能用一句话概括。**
   *
   * 原来调用方对所有 `blocked` 都写「熔断按单日结算，跨过零点后自动恢复」——
   * **那句话只对 `daily_loss` 成立**。而 `total_drawdown` 完全没有"按日"的概念：
   * 它比较的是**历史最高水位**与当前权益，要等权益自己涨回门槛以内才解除。
   *
   * 实测后果：一个被总回撤熔断的机器人，每一轮的 `executionLog` 都在告诉操作员
   * 「跨过零点后自动恢复」—— 而它已经这样静默地跳过了 15 个周期。**空仓时权益不会
   * 自己变化，所以它永远等不到那一天。** 这比不写原因更糟：它给的是一个
   * **会让人安心地不去处理**的错误信息。
   *
   * 类型的单一来源在 `@aq/shared`（控制台也要用同一个），这里只是引用它。
   */
  kind: CircuitBreakerKind;
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
        kind: 'total_drawdown',
        reason: `总回撤熔断：权益较最高水位 $${state.highWaterEquity.toFixed(2)} 回撤了 ${drawdown.toFixed(2)}%（上限 ${maxTotalDrawdownPercent}%）。`,
      };
    }
  }

  if (maxDailyLossPercent > 0 && equity > 0 && state.dailyRealizedPnl < 0) {
    const dailyLossPercent = (Math.abs(state.dailyRealizedPnl) / equity) * 100;
    if (dailyLossPercent >= maxDailyLossPercent) {
      return {
        blocked: true,
        kind: 'daily_loss',
        reason: `单日亏损熔断：今日已实现亏损 $${Math.abs(state.dailyRealizedPnl).toFixed(2)}，占权益 ${dailyLossPercent.toFixed(2)}%（上限 ${maxDailyLossPercent}%）。`,
      };
    }
  }

  return { blocked: false, kind: 'none', reason: '' };
}
