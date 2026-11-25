/**
 * 机械保护守卫模块（从 `autoTrader.ts` 阶段 2 纯搬抽出，行为零变化）：
 * - 30s 实时守卫执行体（`runMechanicalGuardTick`）
 * - 回撤守卫（`applyDrawdownGuardForTrader`）
 * - 持仓论点硬检查守卫（`applyThesisHardGuardForTrader`）
 * - 保本 / 移动止损守卫（`applyBreakevenGuardForTrader`、`isStopTighter`）
 */
import type { CloseReason, Decision, PositionView, StrategyConfig, Trader } from '@aq/shared';

import type { ExchangePosition } from '../binance/broker.js';
import { evaluateThesisHardCheck, managedThesisStore } from '../managed/thesis.js';
import { shouldMoveStopToBreakeven } from '../risk/breakeven.js';
import { shouldCloseForDrawdown } from '../risk/engine.js';
import { orders as orderStore, positions as positionStore } from '../store/repositories.js';

type PositionRow = ReturnType<typeof positionStore.open>[number];

export type GuardEmitLevel = 'info' | 'warn' | 'error';

/**
 * 一次实时守卫检查的主体步骤：先结清待成交限价单，再回撤守卫（平仓，落袋），
 * 随后 `ai_managed` 持仓论点硬检查，最后保本止损（移止损，让赢的单继续跑）。
 * 顺序与周期里那几步一致（见 `runCycle` 的 "Mechanical protections"）。
 */
export async function runMechanicalGuardTick(input: {
  traderId: number;
  mode: Trader['mode'];
  settlePendingEntries: () => Promise<void>;
  applyDrawdownGuard: () => Promise<number>;
  applyThesisHardGuard: () => Promise<number>;
  applyBreakevenGuard: () => Promise<number>;
  emit: (level: GuardEmitLevel, message: string) => void;
}): Promise<void> {
  /*
   * M1.3（2026-11-24）：30s 实时守卫同步结清待成交限价单，
   * 把限价单成交到挂保护单的裸仓窗口从 10–20 分钟压缩至 ≤30 秒。
   */
  if (positionStore.pending(input.traderId).length > 0) {
    await input.settlePendingEntries().catch(() => undefined);
  }
  const closed = await input.applyDrawdownGuard();
  if (closed > 0) input.emit('info', `回撤守卫（实时检查）平仓 ${closed} 笔`);
  if (input.mode === 'ai_managed') {
    const thesisClosed = await input.applyThesisHardGuard();
    if (thesisClosed > 0) input.emit('info', `持仓论点硬检查（实时守卫）平仓 ${thesisClosed} 笔`);
  }
  await input.applyBreakevenGuard().catch(() => undefined);
}

/**
 * Close positions that have given back too much of their peak profit.
 *
 * Runs before the model is consulted and does not ask permission: protecting
 * realised profit is exactly the judgement models reliably get wrong.
 */
export async function applyDrawdownGuardForTrader(input: {
  traderId: number;
  getEffectivePositions: () => Promise<ExchangePosition[]>;
  toPositionView: (local: PositionRow) => PositionView;
  getEffectiveConfig: () => StrategyConfig;
  closePosition: (decision: Decision, reason: CloseReason) => Promise<unknown>;
  emit: (level: GuardEmitLevel, message: string) => void;
}): Promise<number> {
  const traderId = input.traderId;
  /*
   * ⚠️ 走 `effectivePositions()` —— 直接读 `broker.getPositions()` 在模拟盘上
   * **恒返回空**，于是回撤守卫会**从不触发**（静默失效）。
   */
  const exchangePositions = await input.getEffectivePositions();
  const liveBySymbol = new Map(exchangePositions.map((p) => [p.symbol, p]));
  let closed = 0;

  for (const local of positionStore.open(traderId)) {
    const live = liveBySymbol.get(local.symbol);
    if (!live) continue;

    /*
     * 30s 实时守卫也要刷新峰值浮盈：否则周期内冲高回落时 `peak_pnl_percent` 停在上轮旧值，
     * 30s 监控永远看不到本次尖峰，也就无法在回吐时触发平仓。
     */
    positionStore.updatePeak(traderId, local.symbol, live.unrealizedPnlPercent);
    const peakPnlPercent = Math.max(local.peak_pnl_percent ?? 0, live.unrealizedPnlPercent);

    // Use the exchange's own unrealised PnL for the decision, and the ratcheted
    // peak as the reference point.
    const view: PositionView = {
      ...input.toPositionView(local),
      markPrice: live.markPrice,
      unrealizedPnl: live.unrealizedPnl,
      unrealizedPnlPercent: live.unrealizedPnlPercent,
      peakPnlPercent,
    };

    const verdict = shouldCloseForDrawdown(view, input.getEffectiveConfig());
    if (!verdict.close) continue;

    input.emit('info', verdict.reason);
    try {
      await input.closePosition(
        {
          symbol: local.symbol,
          action: local.side === 'long' ? 'close_long' : 'close_short',
          leverage: local.leverage,
          positionSizeUsd: 0,
          stopLoss: null,
          takeProfit: null,
          confidence: 100,
          riskUsd: 0,
          reasoning: verdict.reason,
          reducePercent: null,
          reduceQuantity: null,
          /* 回撤守卫是机械动作，没有"标的评分"可言 —— 如实留空。 */
          setupScore: null,
          setupScoreBasis: '',
          adjustments: [],
        },
        'drawdown_guard',
      );
      closed += 1;
    } catch (error) {
      input.emit('error', `回撤守卫平仓 ${local.symbol} 失败：${(error as Error).message}`);
    }
  }

  return closed;
}

/**
 * M3.1 持仓论点 30 秒确定性机器硬检查（`time_stop_at` + `max_adverse_excursion_pct`）。
 * 仅在 `ai_managed` 模式启用，逐仓读取实时标记价、刷新峰值 R / 最大不利偏移，触线即自动平仓。
 */
export async function applyThesisHardGuardForTrader(input: {
  traderId: number;
  mode: Trader['mode'];
  getEffectivePositions: () => Promise<ExchangePosition[]>;
  getMarkPrice: (symbol: string) => Promise<number>;
  closePosition: (decision: Decision, reason: CloseReason) => Promise<unknown>;
  emit: (level: GuardEmitLevel, message: string) => void;
}): Promise<number> {
  if (input.mode !== 'ai_managed') return 0;
  const traderId = input.traderId;
  const openLocals = positionStore.open(traderId);
  if (openLocals.length === 0) return 0;

  const exchangePositions = await input.getEffectivePositions();
  const liveBySymbol = new Map(exchangePositions.map((p) => [p.symbol, p]));
  let closed = 0;

  for (const local of openLocals) {
    const thesis = managedThesisStore.getActive(traderId, local.symbol);
    if (!thesis) continue;

    const live = liveBySymbol.get(local.symbol);
    const markPrice =
      live && live.markPrice > 0
        ? live.markPrice
        : await input.getMarkPrice(local.symbol).catch(() => 0);
    if (!(markPrice > 0)) continue;

    const verdict = evaluateThesisHardCheck(thesis, { markPrice });
    if (
      verdict.nextPeakR > thesis.peakR ||
      verdict.nextWorstAdversePct > thesis.worstAdversePct
    ) {
      managedThesisStore.recordExcursion(
        thesis.id,
        verdict.nextPeakR,
        verdict.nextWorstAdversePct,
      );
    }

    if (!verdict.shouldClose || !verdict.closeReason) continue;

    input.emit('warn', verdict.detail);
    try {
      await input.closePosition(
        {
          symbol: local.symbol,
          action: local.side === 'long' ? 'close_long' : 'close_short',
          leverage: local.leverage,
          positionSizeUsd: 0,
          stopLoss: null,
          takeProfit: null,
          confidence: 100,
          riskUsd: 0,
          reasoning: verdict.detail,
          reducePercent: null,
          reduceQuantity: null,
          setupScore: null,
          setupScoreBasis: '',
          adjustments: [],
        },
        verdict.closeReason,
      );
      closed += 1;
    } catch (error) {
      input.emit('error', `持仓论点硬检查平仓 ${local.symbol} 失败：${(error as Error).message}`);
    }
  }

  return closed;
}

/**
 * **判断新止损是否【比旧止损更紧】**（P2 的最后一道闸 · 2026-10-19）。
 *
 * ```
 *   多头：新止损 > 旧止损（更靠近上方当前价）⇒ 更紧
 *   空头：新止损 < 旧止损（更靠近下方当前价）⇒ 更紧
 * ```
 * 旧止损为 `null` 时**一律拒绝移动** —— 那种情况应走"补挂保护单"路径。
 */
export function isStopTighter(
  side: 'long' | 'short',
  oldStop: number | null,
  newStop: number,
  _markPrice: number,
): boolean {
  if (oldStop === null || !Number.isFinite(oldStop)) return false;
  if (!Number.isFinite(newStop) || newStop <= 0) return false;
  return side === 'long' ? newStop > oldStop : newStop < oldStop;
}

/**
 * 浮盈够多时把止损移到开仓价 / 按回撤距离追踪收紧。
 *
 * 顺序：**先撤旧、再挂新**（交易所不允许同一仓位并存两张条件单 `-4130`）；
 * 挂新失败时先尝试恢复安全侧旧止损，若恢复也失败则立即市价紧急平仓（§2.6）。
 */
export async function applyBreakevenGuardForTrader(input: {
  traderId: number;
  threshold: number;
  getTrailPercent: () => number;
  getEffectivePositions: () => Promise<ExchangePosition[]>;
  toPositionView: (local: PositionRow) => PositionView;
  cancelAllStopProtection: (symbol: string) => Promise<number>;
  cancelAlgoOrder: (symbol: string, orderId: string) => Promise<boolean>;
  placeStopOrder: (params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    triggerPrice: number;
    traderId: number;
    quantity: number;
  }) => Promise<string | null>;
  flattenPosition: (
    symbol: string,
    quantity: number,
    exitSide: 'BUY' | 'SELL',
    traderId: number,
  ) => Promise<{ avgPrice: number; fee: number; entryFee?: number } | null>;
  bookClosedPosition: (
    still: PositionRow,
    reason: CloseReason,
    avgPrice: number,
    fee: number,
    closedAt: string,
    entryFee?: number,
  ) => Promise<unknown>;
  emit: (level: GuardEmitLevel, message: string) => void;
  emitOnChange: (key: string, level: GuardEmitLevel, message: string) => void;
  clearStateNotice: (key: string) => void;
}): Promise<number> {
  const traderId = input.traderId;
  const threshold = input.threshold;

  // 阈值为 0 表示关闭这条规则 —— 连行情都不必拉。
  if (!(threshold > 0)) return 0;

  /* ⚠️ 同 `applyDrawdownGuard`：模拟盘上直接读会恒空 → 保本止损从不触发。 */
  const exchangePositions = await input.getEffectivePositions();
  const liveBySymbol = new Map(exchangePositions.map((p) => [p.symbol, p]));
  let moved = 0;

  for (const local of positionStore.open(traderId)) {
    const live = liveBySymbol.get(local.symbol);
    if (!live) continue;

    const view: PositionView = {
      ...input.toPositionView(local),
      markPrice: live.markPrice,
      unrealizedPnl: live.unrealizedPnl,
      unrealizedPnlPercent: live.unrealizedPnlPercent,
    };

    const verdict = shouldMoveStopToBreakeven({
      side: view.side,
      entryPrice: view.entryPrice,
      currentStop: view.stopLoss,
      markPrice: view.markPrice,
      unrealizedPnlPercent: view.unrealizedPnlPercent,
      triggerPercent: threshold,
      trailPercent: input.getTrailPercent(),
    });

    if (!verdict.move || verdict.newStop === null) continue;

    const effectiveStop = verdict.newStop;

    /*
     * ⚠️ **最后一道闸：只接受"比旧止损更靠近当前价"的值**。
     * 放宽止损等于增加风险，绝不信任上游会算对。
     */
    if (!isStopTighter(view.side, view.stopLoss ?? null, effectiveStop, view.markPrice)) {
      input.emitOnChange(
        `stop-not-tighter:${local.id}`,
        'warn',
        `${local.symbol} 算出的新止损 ${effectiveStop} 并不比原止损更紧，本轮不移动（防止放宽风险）。`,
      );
      continue;
    }

    /*
     * ⚠️ **单号保持字符串**（不去 `Number()`）——19 位单号超过 JS 安全整数。
     */
    const oldStopId = local.stop_order_id ? String(local.stop_order_id) : null;
    /*
     * ⚠️ **撤"该标的全部止损"，而不是"DB 里记的那一张"**：
     * 只撤止损、不碰止盈（止盈本函数不重挂，撤掉就永久没了）。
     */
    const oldStopCount = await input.cancelAllStopProtection(local.symbol);
    if (oldStopCount === 0 && oldStopId && oldStopId.length > 0) {
      /*
       * 交易所侧查不到任何止损 —— 回退到"按 DB 里的单号撤一次"。
       */
      const cancelled = await input.cancelAlgoOrder(local.symbol, oldStopId).catch(() => false);
      if (!cancelled) {
        input.emitOnChange(
          `breakeven-cancel-fail:${local.id}`,
          'warn',
          `${local.symbol} 的旧止损 #${oldStopId} 未能撤掉，本轮不移动止损（原有的仍然有效）。`,
        );
        continue;
      }
      orderStore.cancelOpenProtectionBySymbol(traderId, local.symbol, {
        stop: true,
        target: false,
      });
    }

    const newStopId = await input
      .placeStopOrder({
        symbol: local.symbol,
        side: local.side === 'long' ? 'SELL' : 'BUY',
        triggerPrice: effectiveStop,
        traderId,
        quantity: local.quantity,
      })
      .catch(() => null);

    if (!newStopId) {
      /*
       * 撤旧成功、挂新失败（常见于往返间微回撤导致新保本价吃 -2021）：
       * 若旧止损价仍在当前标记价的安全侧，先尝试恢复旧止损，避免把健康仓位直接市价强平。
       */
      const prevStop = local.stop_loss;
      const prevStopSafe =
        prevStop !== null &&
        prevStop > 0 &&
        live.markPrice > 0 &&
        (local.side === 'long' ? prevStop < live.markPrice : prevStop > live.markPrice);
      if (prevStopSafe && prevStop !== null) {
        const restoredId = await input
          .placeStopOrder({
            symbol: local.symbol,
            side: local.side === 'long' ? 'SELL' : 'BUY',
            triggerPrice: prevStop,
            traderId,
            quantity: local.quantity,
          })
          .catch(() => null);
        if (restoredId) {
          positionStore.setProtection(
            traderId,
            local.symbol,
            prevStop,
            local.take_profit,
            restoredId,
            local.tp_order_id,
          );
          input.emit(
            'warn',
            `${local.symbol} 移动止损至 ${effectiveStop} 未挂上，已立即恢复原止损 ${prevStop}（仓位保持受保护，不强平）。`,
          );
          continue;
        }
      }

      /*
       * 撤旧成功、挂新且恢复旧止损均失败 —— **此刻仓位没有止损**。按 §2.6：
       * 一个没有保护的杠杆仓位是最糟糕的状态，宁可立刻退出。
       */
      input.emit(
        'error',
        `为 ${local.symbol} 移动止损时，旧止损已撤但新止损（开仓价 ${effectiveStop}）没挂上。` +
          '为避免留下无保护的敞口，立即平掉该仓位。',
      );
      const exitSide: 'BUY' | 'SELL' = local.side === 'long' ? 'SELL' : 'BUY';
      const flatten = await input
        .flattenPosition(local.symbol, local.quantity, exitSide, traderId)
        .catch(() => null);
      const still = positionStore.getOpenBySymbol(traderId, local.symbol);
      /*
       * ⚠️ **只有交易所确认成交了才记账**（`flatten === null` 表示"没确认"）。
       */
      if (still && flatten) {
        await input.bookClosedPosition(
          still,
          'protection_unavailable',
          flatten.avgPrice,
          flatten.fee,
          new Date().toISOString(),
          flatten.entryFee,
        );
      } else if (still) {
        input.emit(
          'warn',
          `${local.symbol} 的紧急平仓未获确认，本轮不记账（本地持仓保留），交给下一轮对账处理。`,
        );
      }
      moved += 1;
      continue;
    }

    /*
     * 本地记录必须与交易所一致：把 `stop_loss` 也更新成刚挂上去的保本价。
     */
    positionStore.setProtection(
      traderId,
      local.symbol,
      effectiveStop,
      local.take_profit,
      String(newStopId),
      local.tp_order_id,
    );
    input.clearStateNotice(`breakeven-fail:${local.id}`);
    input.emit('info', verdict.reason);
    moved += 1;
  }

  return moved;
}
