import {
  isCloseAction,
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
      ...decisions.filter((d) => isOpenAction(d.action)),
      ...decisions.filter((d) => !isCloseAction(d.action) && !isOpenAction(d.action)),
    ];

    for (const decision of ordered) {
      if (isCloseAction(decision.action)) {
        const verdict = this.reviewClose(decision, env);
        if (verdict.ok) approved.push(verdict.decision);
        else rejected.push({ decision, reason: verdict.reason });
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
        } else {
          rejected.push({ decision, reason: verdict.reason });
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

    /* --- 7. Reward:risk -------------------------------------------------- */
    const riskDistance = Math.abs(price - stopLoss);
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
