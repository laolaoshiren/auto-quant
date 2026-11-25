/**
 * M3.2 持仓战术仪表盘（`packages/server/src/managed/tactics.ts`）
 *
 * 每轮为每个当前持仓预先算好全部专业波段管理数字，直接喂给 LLM（拒绝让模型做心算）：
 *   1. 当前 R 倍数、历史峰值 R、当前逆向偏移（MAE）与时间止损倒计时
 *   2. 距止损位 / 止盈位的 ATR 距离与剩余盈亏比
 *   3. **若金字塔加仓 50% 后的合并均价与零风险保本止损位**（含双边手续费缓冲）
 *   4. 持仓期间 AI500 评分 / OI / Taker 买盘相对入场时的衰减变化
 *   5. 阶段判定（试仓 `trial` / 无风险加仓就绪 `pyramid_ready` / 2R+锁利减仓 `scale_out_lock` / 防守 `defense`）
 */

import type { PositionView } from '@aq/shared';

import type { Ai500Candidate } from '../radar/ai500.js';
import { formatCompactPrice } from '../radar/volumeProfile.js';
import type { PositionThesis } from './thesis.js';

/* -------------------------------------------------------------------------- */
/*  Public Types                                                               */
/* -------------------------------------------------------------------------- */

export type PositionTacticStage =
  | 'trial'
  | 'pyramid_ready'
  | 'scale_out_lock'
  | 'runner_hold'
  | 'defense';

export interface PyramidSimulation {
  /** 若按当前持仓量加仓 50%（总仓位变为 1.5x）后的合并均价。 */
  mergedEntryPrice: number;
  /** 覆盖双边手续费后的零风险保本止损价（触发后整笔合并仓位净盈亏 ≥ 0）。 */
  zeroRiskBreakevenStop: number;
  /** 新保本止损距现价的 ATR 倍数（正数 = 处于安全锁盈侧）。 */
  breakevenBufferAtr: number | null;
  /** 若执行顺势金字塔加仓，建议顺延拓展的新止盈目标价（打破旧静态 TP 对剩余 RR 的束缚）。 */
  suggestedExtendedTp: number;
  /** 是否满足「盈利 ≥ 1R + 新保本止损留足 ≥ 0.7×ATR 呼吸空间 + 动能未退潮 + 非尾仓」的无风险金字塔加仓条件。 */
  canZeroRiskPyramid: boolean;
}

export interface EntryFlowDecay {
  /** 当前 AI500 评分 - 入场时 AI500 评分（负值 = 动能衰减）。 */
  radarScoreDelta: number | null;
  /** 当前 OI 相对入场 OI 的变化百分比（%）。 */
  oiChangePct: number | null;
  /** 当前 1h Taker 买比相对入场时的顺向变化（百分点 pp；负值 = 主动买/卖力减弱）。 */
  favorableTakerDeltaPp: number | null;
  /** 是否出现明显动能衰减警示。 */
  isFading: boolean;
}

export interface PositionTactics {
  symbol: string;
  side: 'long' | 'short';
  currentR: number;
  peakR: number;
  adversePct: number;
  distToStopAtr: number | null;
  distToTpAtr: number | null;
  remainingRr: number | null;
  /** 距论点时间止损的剩余分钟数（负数表示已过期；null 表示未设）。 */
  timeStopRemainingMinutes: number | null;
  pyramid50: PyramidSimulation;
  decay: EntryFlowDecay;
  /** 本笔持仓已执行过的分批减仓次数（用于防碎片化连续对半切）。 */
  partialCloseCount: number;
  /** 是否已进入尾仓/底仓阶段（已减仓 ≥ 2 次，或剩余名义 < 2.2×最小名义），此阶段严禁再切碎。 */
  isTailRunner: boolean;
  stage: PositionTacticStage;
  /** 一句话结构化战术指引（非强制，供 LLM 结合图表做最终拍板）。 */
  guidance: string;
}

export interface TacticsInput {
  position: PositionView;
  thesis: PositionThesis | null;
  radar: Ai500Candidate | null;
  /** 15m ATR 绝对价差（可从 `radar.metrics.atr15mPct * mark / 100` 推导）。 */
  atr15m?: number | null;
  /** 双边手续费率（小数，默认 0.001 = 0.10%）。 */
  roundTripFeeRate?: number;
  /** 该标的最小下单名义额（用于判定是否已缩至不可继续拆分的尾仓，默认 12）。 */
  minNotionalUsd?: number;
  /** 本笔持仓已发生过的部分减仓次数（默认 0）。 */
  partialCloseCount?: number;
  nowMs?: number;
}

/* -------------------------------------------------------------------------- */
/*  Pure Computation                                                           */
/* -------------------------------------------------------------------------- */

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function computePositionTactics(input: TacticsInput): PositionTactics {
  const { position: pos, thesis, radar } = input;
  const nowMs = input.nowMs ?? Date.now();
  const feeRate = input.roundTripFeeRate ?? 0.001;
  const dir = pos.side === 'long' ? 1 : -1;

  const entry = pos.entryPrice;
  const mark = pos.markPrice > 0 ? pos.markPrice : entry;
  const initialSl = thesis && thesis.initialStopLoss > 0 ? thesis.initialStopLoss : (pos.stopLoss ?? 0);
  const currentSl = pos.stopLoss ?? initialSl;
  const tp = pos.takeProfit ?? 0;

  const favorableMove = (mark - entry) * dir;
  const adversePct = entry > 0 ? round2((Math.max(0, -favorableMove) / entry) * 100) : 0;

  const initialRisk = initialSl > 0 ? Math.abs(entry - initialSl) : 0;
  const currentR = initialRisk > 0 ? round2(favorableMove / initialRisk) : 0;
  const peakR = round2(Math.max(thesis?.peakR ?? 0, currentR));

  // ATR 15m 价差
  const atrVal =
    input.atr15m && Number.isFinite(input.atr15m) && input.atr15m > 0
      ? input.atr15m
      : radar && radar.metrics.atr15mPct > 0 && mark > 0
        ? (mark * radar.metrics.atr15mPct) / 100
        : null;

  const distToStop = currentSl > 0 ? Math.abs(mark - currentSl) : null;
  const distToTp = tp > 0 ? Math.abs(tp - mark) : null;
  const distToStopAtr = distToStop !== null && atrVal ? round2(distToStop / atrVal) : null;
  const distToTpAtr = distToTp !== null && atrVal ? round2(distToTp / atrVal) : null;
  const remainingRr =
    distToStop !== null && distToStop > 0 && distToTp !== null ? round2(distToTp / distToStop) : null;

  // 时间止损倒计时
  let timeStopRemainingMinutes: number | null = null;
  if (thesis?.timeStopAt) {
    const dl = Date.parse(thesis.timeStopAt);
    if (Number.isFinite(dl)) {
      timeStopRemainingMinutes = Math.round((dl - nowMs) / 60_000);
    }
  }

  // 金字塔加仓 +50% 模拟：合并均价 = (1 * entry + 0.5 * mark) / 1.5
  const mergedEntryPrice = (entry + 0.5 * mark) / 1.5;
  // 零风险保本止损：多头在合并均价上方留 1.2×双边手续费；空头在合并均价下方留 1.2×双边手续费
  const feeBuffer = Math.max(feeRate * 1.2, 0.0012);
  const zeroRiskBreakevenStop =
    pos.side === 'long' ? mergedEntryPrice * (1 + feeBuffer) : mergedEntryPrice * (1 - feeBuffer);
  const breakevenGap = (mark - zeroRiskBreakevenStop) * dir; // >0 说明现价已在保本止损有利一侧
  const breakevenBufferAtr = atrVal && atrVal > 0 ? round2(breakevenGap / atrVal) : null;
  // 顺势金字塔加仓时的动态顺延止盈目标：在现价基础上再外推 max(1.8×初始风险, 3.2×ATR15m)，且优于原 TP
  const tpExtension = Math.max(initialRisk * 1.8, (atrVal ?? mark * 0.012) * 3.2);
  const rawExtendedTp = mark + dir * tpExtension;
  const suggestedExtendedTp =
    tp > 0 && (pos.side === 'long' ? tp > rawExtendedTp : tp < rawExtendedTp)
      ? tp
      : Math.max(1e-8, rawExtendedTp);

  // 持仓期间动能/资金流衰减评估
  const radarScoreDelta =
    thesis?.entryRadarScore !== null &&
    thesis?.entryRadarScore !== undefined &&
    radar !== null
      ? Math.round(radar.score - thesis.entryRadarScore)
      : null;

  const oiChangePct =
    thesis?.entryOiUsd &&
    thesis.entryOiUsd > 0 &&
    radar?.metrics.openInterestUsd &&
    radar.metrics.openInterestUsd > 0
      ? round2(((radar.metrics.openInterestUsd - thesis.entryOiUsd) / thesis.entryOiUsd) * 100)
      : null;

  let favorableTakerDeltaPp: number | null = null;
  if (
    thesis?.entryTakerBuyRatio !== null &&
    thesis?.entryTakerBuyRatio !== undefined &&
    radar !== null
  ) {
    const entryFav = pos.side === 'long' ? thesis.entryTakerBuyRatio : 1 - thesis.entryTakerBuyRatio;
    const nowFav = pos.side === 'long' ? radar.metrics.takerBuyRatio1h : 1 - radar.metrics.takerBuyRatio1h;
    favorableTakerDeltaPp = round1((nowFav - entryFav) * 100);
  }

  const biasFlipped =
    radar !== null &&
    radar.bias !== 'neutral' &&
    ((pos.side === 'long' && radar.bias === 'short') || (pos.side === 'short' && radar.bias === 'long'));
  /*
   * 实盘校准（2026-11-25 5.5h 观察）：趋势中途正常整理常出现 Taker -10pp~-12pp 抖动（如 ADA/HYPE 随后再冲 +1.5R），
   * 收紧衰减门槛至 radarScoreDelta <= -15 或 favorableTakerDeltaPp <= -14 或方向翻转/OI 显著流失，
   * 避免趋势中途误报衰减导致过早切光主波段仓位。
   */
  const isFading =
    biasFlipped ||
    (radarScoreDelta !== null && radarScoreDelta <= -15) ||
    (favorableTakerDeltaPp !== null && favorableTakerDeltaPp <= -14) ||
    (oiChangePct !== null && oiChangePct <= -5);

  const partialCloseCount = Math.max(0, Math.floor(input.partialCloseCount ?? 0));
  const remainingNotional = pos.notional > 0 ? pos.notional : pos.quantity * mark;
  const effectiveMinNotional = Math.max(input.minNotionalUsd ?? 12, 5);
  const isTailRunner =
    partialCloseCount >= 2 ||
    (remainingNotional > 0 && remainingNotional < effectiveMinNotional * 2.2);

  const canZeroRiskPyramid =
    currentR >= 1.0 &&
    breakevenGap > 0 &&
    (breakevenBufferAtr === null ? breakevenGap / mark >= 0.007 : breakevenBufferAtr >= 0.7) &&
    !isFading &&
    !isTailRunner &&
    (radar === null || radar.score >= 65);

  // 战术阶段判定与明确引导（防碎片连切 + 放行顺势金字塔滚仓 + 保护大赢家波段）
  let stage: PositionTacticStage = 'trial';
  let guidance: string;

  if (currentR < 0) {
    stage = 'defense';
    guidance =
      adversePct > 0 && thesis?.maxAdverseExcursionPct
        ? `当前浮亏 ${currentR.toFixed(2)}R（MAE ${adversePct.toFixed(2)}%/${thesis.maxAdverseExcursionPct.toFixed(2)}%）：严禁逆势摊平加仓，核对结构失效位与时间止损，破位即果断离场。`
        : `当前浮亏 ${currentR.toFixed(2)}R：严禁亏损加仓摊平，守住原定结构止损，逻辑否定即果断平仓。`;
  } else if (isTailRunner && currentR >= 0.3) {
    stage = 'runner_hold';
    guidance =
      `已分批锁利 ${partialCloseCount} 次或余仓名义仅 $${remainingNotional.toFixed(1)}（尾仓区）：严禁继续碎片化 reduce_position！` +
      '仅在出现「15m 放量反向吞没 + Taker 反转/结构失效」时一次性全平（close），否则交由结构移动止损与 TP 完整博弈大波段。';
  } else if (canZeroRiskPyramid && currentR < 2.2 && partialCloseCount === 0) {
    stage = 'pyramid_ready';
    guidance =
      `盈利 ${currentR.toFixed(2)}R 且趋势强劲：若放量突破确认，优先用 add_to_position 加仓 35%-50%（合并均价 ${formatCompactPrice(mergedEntryPrice)}），` +
      `同步将 stop_loss 移至零风险保本位 ${formatCompactPrice(zeroRiskBreakevenStop)} 并将 take_profit 顺延拓展至 ${formatCompactPrice(suggestedExtendedTp)}（勿被旧 TP 剩余 RR 束缚）。`;
  } else if (currentR >= 2.0 || (currentR >= 1.0 && isFading)) {
    stage = 'scale_out_lock';
    if (partialCloseCount === 0) {
      guidance = isFading
        ? `已达 ${currentR.toFixed(2)}R 且出现动能衰减，建议执行第 1 批（30%-35%）reduce_position 锁利，保留 65%-70% 主力仓位并将止损沿 15m 结构位移至锁盈侧。`
        : `已达 ${currentR.toFixed(2)}R 大波段盈利区：建议执行第 1 批（30%-35%）reduce_position 锁利，保留 65%-70% 主力仓位顺延博弈更远目标，止损沿 15m 结构位上移（避开整数位）。`;
    } else {
      guidance =
        `已达 ${currentR.toFixed(2)}R（已锁利 1 批）：仅在确有「15m 放量反向吞没/结构破位」时执行最后 1 批减仓或全平，切忌频繁对半切碎大赢家；否则沿结构移损持有看 TP。`;
    }
  } else if (canZeroRiskPyramid) {
    stage = 'pyramid_ready';
    guidance =
      `盈利 ${currentR.toFixed(2)}R 且趋势强劲：若放量突破确认，可用 add_to_position 加仓 35%-50%（合并均价 ${formatCompactPrice(mergedEntryPrice)}），` +
      `同步将 stop_loss 移至零风险保本位 ${formatCompactPrice(zeroRiskBreakevenStop)} 并顺延 take_profit 至 ${formatCompactPrice(suggestedExtendedTp)}。`;
  } else {
    stage = 'trial';
    guidance = `试仓推进中（${currentR.toFixed(2)}R）：耐心让结构展开，未破失效位不惊慌砍单，待 ≥1R 突破确认再评估无风险加仓或移损保本。`;
  }

  return {
    symbol: pos.symbol,
    side: pos.side,
    currentR,
    peakR,
    adversePct,
    distToStopAtr,
    distToTpAtr,
    remainingRr,
    timeStopRemainingMinutes,
    pyramid50: {
      mergedEntryPrice,
      zeroRiskBreakevenStop,
      breakevenBufferAtr,
      suggestedExtendedTp,
      canZeroRiskPyramid,
    },
    decay: {
      radarScoreDelta,
      oiChangePct,
      favorableTakerDeltaPp,
      isFading,
    },
    partialCloseCount,
    isTailRunner,
    stage,
    guidance,
  };
}

/**
 * 将单个持仓的论点 + 战术仪表盘格式化为紧凑的 2–3 行文本，直接嵌入 `managed/prompt.ts`。
 */
export function formatPositionTacticsLines(
  tactics: PositionTactics,
  thesis: PositionThesis | null,
): string[] {
  const stageCn: Record<PositionTacticStage, string> = {
    trial: '试仓观察',
    pyramid_ready: '★可无风险加仓',
    scale_out_lock: '★锁利/移损区',
    runner_hold: '★底仓奔跑(禁切碎)',
    defense: '防守监控',
  };

  const atrParts: string[] = [];
  if (tactics.distToStopAtr !== null) atrParts.push(`距SL ${tactics.distToStopAtr}×ATR`);
  if (tactics.distToTpAtr !== null) atrParts.push(`距TP ${tactics.distToTpAtr}×ATR`);
  if (tactics.remainingRr !== null) atrParts.push(`剩余RR ${tactics.remainingRr}:1`);

  const decayParts: string[] = [];
  if (tactics.decay.radarScoreDelta !== null) {
    decayParts.push(`AI500 ${tactics.decay.radarScoreDelta >= 0 ? '+' : ''}${tactics.decay.radarScoreDelta}`);
  }
  if (tactics.decay.oiChangePct !== null) {
    decayParts.push(`OI ${tactics.decay.oiChangePct >= 0 ? '+' : ''}${tactics.decay.oiChangePct}%`);
  }
  if (tactics.decay.favorableTakerDeltaPp !== null) {
    decayParts.push(
      `顺向Taker ${tactics.decay.favorableTakerDeltaPp >= 0 ? '+' : ''}${tactics.decay.favorableTakerDeltaPp}pp`,
    );
  }

  const lines: string[] = [
    `  · 战术面板[${stageCn[tactics.stage]}]：R=${tactics.currentR >= 0 ? '+' : ''}${tactics.currentR.toFixed(2)}R (峰值 ${tactics.peakR.toFixed(2)}R${tactics.partialCloseCount > 0 ? `, 已减仓${tactics.partialCloseCount}次` : ''})${atrParts.length > 0 ? ` · ${atrParts.join(' / ')}` : ''} · +50%加仓模拟(均价 ${formatCompactPrice(tactics.pyramid50.mergedEntryPrice)} → 保本SL ${formatCompactPrice(tactics.pyramid50.zeroRiskBreakevenStop)}${tactics.pyramid50.breakevenBufferAtr !== null ? `, 缓冲 ${tactics.pyramid50.breakevenBufferAtr}×ATR` : ''}${tactics.pyramid50.canZeroRiskPyramid ? `, 可顺延TP→${formatCompactPrice(tactics.pyramid50.suggestedExtendedTp)}` : ''})${decayParts.length > 0 ? ` · 入场至今变化(${decayParts.join(', ')}${tactics.decay.isFading ? ' ⚠️衰减' : ''})` : ''}`,
  ];

  if (thesis) {
    const hardParts: string[] = [];
    if (thesis.maxAdverseExcursionPct !== null) {
      hardParts.push(`MAE ${tactics.adversePct.toFixed(2)}%/${thesis.maxAdverseExcursionPct.toFixed(2)}%`);
    }
    if (tactics.timeStopRemainingMinutes !== null) {
      const rem = tactics.timeStopRemainingMinutes;
      const remStr =
        rem <= 0
          ? '已到期'
          : rem >= 60
            ? `剩 ${(rem / 60).toFixed(1)}h`
            : `剩 ${rem}m`;
      hardParts.push(`时间止损(${remStr}, 要求≥${thesis.minProgressR}R)`);
    }
    const detailBits = [
      thesis.entryBasis ? `依据:${thesis.entryBasis.slice(0, 60)}` : '',
      thesis.addTrigger ? `加仓:${thesis.addTrigger.slice(0, 50)}` : '',
      thesis.reduceTarget ? `减仓:${thesis.reduceTarget.slice(0, 50)}` : '',
      thesis.invalidation ? `失效:${thesis.invalidation.slice(0, 50)}` : '',
    ].filter(Boolean);
    lines.push(
      `  · 持仓论点[硬检查:${hardParts.join(' · ') || '默认'}]：${detailBits.join(' | ') || '待补充（可用 update_thesis 完善）'}`,
    );
  }

  lines.push(`  · 战术指引：${tactics.guidance}`);
  return lines;
}
