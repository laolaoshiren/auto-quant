/**
 * 筹码结构 & 清算簇代理引擎（`packages/server/src/radar/volumeProfile.ts`）
 *
 * 将最近 15m/1h K 线的成交额按价格区间分桶，预先算出：
 *   1. POC（筹码最密集价）及相对现价的 % 偏移
 *   2. Value Area（70% 成交额价值区 [VAL, VAH]）与现价所处区位
 *   3. 上方阻力墙（upperWall）& 下方支撑墙（lowerWall）
 *   4. 基于显著波段高低点与常见杠杆（5x / 10x / 20x）估算的上下方止损/清算磁吸区
 *
 * 所有计算纯函数、零 I/O，直接输出给 LLM 可读的结构化数字结论，避免让模型对着原始 K 线做心算。
 */

import type { Kline } from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface PriceWall {
  price: number;
  offsetPct: number;
  /** 该价位档位占总成交额的比例（0–1）。 */
  volumeShare: number;
}

export interface LiquidationZone {
  price: number;
  offsetPct: number;
  /** 磁吸目标方向：short_liq（上方空头止损/爆仓簇）或 long_liq（下方多头止损/爆仓簇）。 */
  kind: 'short_liq' | 'long_liq';
  /** 对应的代表性杠杆簇标签（如 `20x` / `10x` / `5x`）。 */
  leverageLabel: string;
}

export interface VolumeProfileResult {
  price: number;
  /** 筹码最密集价（Point of Control） */
  poc: number;
  pocOffsetPct: number;
  /** 70% 成交额价值区下沿与上沿 */
  val: number;
  vah: number;
  valOffsetPct: number;
  vahOffsetPct: number;
  /** 现价相对价值区的位置 */
  pricePosition: 'above_va' | 'inside_va' | 'below_va';
  /** 现价上方最密集的筹码阻力墙 */
  upperWall: PriceWall | null;
  /** 现价下方最密集的筹码支撑墙 */
  lowerWall: PriceWall | null;
  /** 上方最近空头清算/止损磁吸区（若存在） */
  nearestShortLiq: LiquidationZone | null;
  /** 下方最近多头清算/止损磁吸区（若存在） */
  nearestLongLiq: LiquidationZone | null;
  /** 全部去重后的清算磁吸区（按距现价由近到远） */
  liquidationZones: LiquidationZone[];
}

export interface VolumeProfileOptions {
  /** 价格分桶数量（默认 24 档）。 */
  bins?: number;
  /** 价值区覆盖比例（默认 0.70）。 */
  valueAreaRatio?: number;
  /** 支撑/阻力墙与现价的最小隔离百分比（默认 0.25%，避免把现价本身报成墙）。 */
  wallMinOffsetPct?: number;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function offsetPct(target: number, current: number): number {
  if (!Number.isFinite(target) || !Number.isFinite(current) || current <= 0) return 0;
  return round2(((target - current) / current) * 100);
}

/** 根据价格量级格式化紧凑价格字符串（免出现 0.0000 或多余尾零）。 */
export function formatCompactPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return '0';
  if (price >= 1000) return price.toFixed(1);
  if (price >= 10) return price.toFixed(2);
  if (price >= 1) return price.toFixed(3);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

function fmtSignedPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/* -------------------------------------------------------------------------- */
/*  Volume Profile & Liquidation Proxy                                         */
/* -------------------------------------------------------------------------- */

/**
 * 计算筹码分布（POC / VA / 上下墙）与杠杆清算磁吸代理区。
 */
export function computeVolumeProfile(
  klines: readonly Kline[],
  currentPrice?: number,
  options: VolumeProfileOptions = {},
): VolumeProfileResult | null {
  if (klines.length < 3) return null;

  const valid = klines.filter(
    (k) =>
      Number.isFinite(k.high) &&
      Number.isFinite(k.low) &&
      Number.isFinite(k.close) &&
      k.high > 0 &&
      k.low > 0 &&
      k.high >= k.low,
  );
  if (valid.length < 3) return null;

  const price =
    currentPrice !== undefined && Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : valid[valid.length - 1]!.close;
  if (price <= 0) return null;

  const numBins = Math.max(8, Math.min(60, Math.round(options.bins ?? 24)));
  const vaRatio = Math.max(0.5, Math.min(0.9, options.valueAreaRatio ?? 0.7));
  const wallMinOffsetPct = options.wallMinOffsetPct ?? 0.25;

  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (const k of valid) {
    if (k.low < minLow) minLow = k.low;
    if (k.high > maxHigh) maxHigh = k.high;
  }

  // 全平盘防御：构造微幅区间
  if (maxHigh - minLow < price * 1e-6) {
    return {
      price,
      poc: price,
      pocOffsetPct: 0,
      val: price,
      vah: price,
      valOffsetPct: 0,
      vahOffsetPct: 0,
      pricePosition: 'inside_va',
      upperWall: null,
      lowerWall: null,
      nearestShortLiq: null,
      nearestLongLiq: null,
      liquidationZones: [],
    };
  }

  const step = (maxHigh - minLow) / numBins;
  const bucketVol = new Array<number>(numBins).fill(0);
  let totalVol = 0;

  const binOf = (p: number): number =>
    Math.max(0, Math.min(numBins - 1, Math.floor((p - minLow) / step)));

  for (const k of valid) {
    const vol = Number.isFinite(k.quoteVolume) && k.quoteVolume > 0 ? k.quoteVolume : Math.max(k.volume, 1);
    totalVol += vol;

    const fullStart = binOf(k.low);
    const fullEnd = binOf(k.high);
    const bodyLow = Math.min(k.open, k.close);
    const bodyHigh = Math.max(k.open, k.close);
    const bodyStart = binOf(bodyLow);
    const bodyEnd = binOf(bodyHigh);

    // 60% 成交额按实体区分配，40% 按全振幅分配（相比仅按收盘价分桶更贴合真实筹码分布）
    const fullSpan = fullEnd - fullStart + 1;
    const bodySpan = bodyEnd - bodyStart + 1;
    const fullShare = (vol * 0.4) / fullSpan;
    const bodyShare = (vol * 0.6) / bodySpan;

    for (let i = fullStart; i <= fullEnd; i += 1) bucketVol[i]! += fullShare;
    for (let i = bodyStart; i <= bodyEnd; i += 1) bucketVol[i]! += bodyShare;
  }

  // 1) POC（最大成交额档位中心价）
  let pocIdx = 0;
  for (let i = 1; i < numBins; i += 1) {
    if (bucketVol[i]! > bucketVol[pocIdx]!) pocIdx = i;
  }
  const centerOf = (idx: number): number => minLow + (idx + 0.5) * step;
  const poc = centerOf(pocIdx);

  // 2) Value Area（从 POC 向两侧逐档扩张至累计成交额 >= 70%）
  let left = pocIdx;
  let right = pocIdx;
  let covered = bucketVol[pocIdx]!;
  const targetVol = totalVol * vaRatio;

  while (covered < targetVol && (left > 0 || right < numBins - 1)) {
    const leftVol = left > 0 ? bucketVol[left - 1]! : -1;
    const rightVol = right < numBins - 1 ? bucketVol[right + 1]! : -1;
    if (leftVol >= rightVol && left > 0) {
      left -= 1;
      covered += bucketVol[left]!;
    } else if (right < numBins - 1) {
      right += 1;
      covered += bucketVol[right]!;
    } else {
      break;
    }
  }

  const val = minLow + left * step;
  const vah = minLow + (right + 1) * step;
  const pricePosition: VolumeProfileResult['pricePosition'] =
    price > vah ? 'above_va' : price < val ? 'below_va' : 'inside_va';

  // 3) 上方阻力墙 & 下方支撑墙（现价外侧成交额最集中的单档）
  let bestUpperIdx = -1;
  let bestLowerIdx = -1;
  for (let i = 0; i < numBins; i += 1) {
    const c = centerOf(i);
    const off = ((c - price) / price) * 100;
    if (off >= wallMinOffsetPct) {
      if (bestUpperIdx === -1 || bucketVol[i]! > bucketVol[bestUpperIdx]!) bestUpperIdx = i;
    } else if (off <= -wallMinOffsetPct) {
      if (bestLowerIdx === -1 || bucketVol[i]! > bucketVol[bestLowerIdx]!) bestLowerIdx = i;
    }
  }

  const upperWall: PriceWall | null =
    bestUpperIdx >= 0 && totalVol > 0
      ? {
          price: centerOf(bestUpperIdx),
          offsetPct: offsetPct(centerOf(bestUpperIdx), price),
          volumeShare: round2(bucketVol[bestUpperIdx]! / totalVol),
        }
      : null;

  const lowerWall: PriceWall | null =
    bestLowerIdx >= 0 && totalVol > 0
      ? {
          price: centerOf(bestLowerIdx),
          offsetPct: offsetPct(centerOf(bestLowerIdx), price),
          volumeShare: round2(bucketVol[bestLowerIdx]! / totalVol),
        }
      : null;

  // 4) 清算/止损磁吸代理区：结合近期显著波段高低点 + 20x/10x/5x 杠杆维护保证金距离
  const liquidationZones = estimateLiquidationZones(valid, price);
  const nearestShortLiq =
    liquidationZones.find((z) => z.kind === 'short_liq' && z.offsetPct > 0.3) ?? null;
  const nearestLongLiq =
    liquidationZones.find((z) => z.kind === 'long_liq' && z.offsetPct < -0.3) ?? null;

  return {
    price,
    poc,
    pocOffsetPct: offsetPct(poc, price),
    val,
    vah,
    valOffsetPct: offsetPct(val, price),
    vahOffsetPct: offsetPct(vah, price),
    pricePosition,
    upperWall,
    lowerWall,
    nearestShortLiq,
    nearestLongLiq,
    liquidationZones,
  };
}

/**
 * 基于近期 3-bar 局部波段高低点与常见杠杆倍数（20x≈4.5%、10x≈9.2%、5x≈18.5%）
 * 估算上下方止损/爆仓磁吸簇（按距离现价由近到远排序并合并相邻 0.8% 内的重叠区）。
 */
function estimateLiquidationZones(klines: readonly Kline[], currentPrice: number): LiquidationZone[] {
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  // 找局部 3 根极值点
  for (let i = 1; i < klines.length - 1; i += 1) {
    const prev = klines[i - 1]!;
    const curr = klines[i]!;
    const next = klines[i + 1]!;
    if (curr.high >= prev.high && curr.high >= next.high) swingHighs.push(curr.high);
    if (curr.low <= prev.low && curr.low <= next.low) swingLows.push(curr.low);
  }
  // 兜底窗口绝对高低点
  const recentHigh = Math.max(...klines.map((k) => k.high));
  const recentLow = Math.min(...klines.map((k) => k.low));
  swingHighs.push(recentHigh);
  swingLows.push(recentLow);

  const anchorHigh = Math.max(...swingHighs);
  const anchorLow = Math.min(...swingLows);
  // 取最近显著局部高/低（紧邻止损扫荡位）与主流杠杆清算位
  const raw: LiquidationZone[] = [];

  // 显著高点外侧 +0.35%（空头密集止损区）
  if (anchorHigh > currentPrice * 1.002) {
    const stopSweep = anchorHigh * 1.0035;
    raw.push({
      price: stopSweep,
      offsetPct: offsetPct(stopSweep, currentPrice),
      kind: 'short_liq',
      leverageLabel: '前高止损簇',
    });
  }
  // 显著低点外侧 -0.35%（多头密集止损区）
  if (anchorLow < currentPrice * 0.998) {
    const stopSweep = anchorLow * 0.9965;
    raw.push({
      price: stopSweep,
      offsetPct: offsetPct(stopSweep, currentPrice),
      kind: 'long_liq',
      leverageLabel: '前低止损簇',
    });
  }

  // 常见杠杆（20x/10x/5x）从当前价格中枢和近期高低锚点投射出的清算簇
  const tiers: Array<{ label: string; dist: number }> = [
    { label: '20x', dist: 0.045 },
    { label: '10x', dist: 0.092 },
    { label: '5x', dist: 0.185 },
  ];
  for (const t of tiers) {
    const shortLiqPrice = currentPrice * (1 + t.dist);
    raw.push({
      price: shortLiqPrice,
      offsetPct: offsetPct(shortLiqPrice, currentPrice),
      kind: 'short_liq',
      leverageLabel: `${t.label}空`,
    });
    const longLiqPrice = currentPrice * (1 - t.dist);
    if (longLiqPrice > 0) {
      raw.push({
        price: longLiqPrice,
        offsetPct: offsetPct(longLiqPrice, currentPrice),
        kind: 'long_liq',
        leverageLabel: `${t.label}多`,
      });
    }
  }

  // 按距现价由近到远排序，并合并同侧 0.8% 以内的重叠区
  raw.sort((a, b) => Math.abs(a.offsetPct) - Math.abs(b.offsetPct));
  const deduped: LiquidationZone[] = [];
  for (const zone of raw) {
    const clash = deduped.some(
      (existing) =>
        existing.kind === zone.kind && Math.abs(existing.offsetPct - zone.offsetPct) < 0.8,
    );
    if (!clash) deduped.push(zone);
  }
  return deduped;
}

/**
 * 将筹码结构与清算磁吸区格式化成单行高信息密度结论，直接喂给 LLM。
 */
export function formatVolumeProfileLine(vp: VolumeProfileResult): string {
  const posCn =
    vp.pricePosition === 'above_va'
      ? '价值区上方'
      : vp.pricePosition === 'below_va'
        ? '价值区下方'
        : '价值区内';

  const parts: string[] = [
    `POC ${formatCompactPrice(vp.poc)}(${fmtSignedPct(vp.pocOffsetPct)})`,
    `VA[${formatCompactPrice(vp.val)}~${formatCompactPrice(vp.vah)},${posCn}]`,
  ];

  if (vp.upperWall) {
    parts.push(`上阻力墙 ${formatCompactPrice(vp.upperWall.price)}(${fmtSignedPct(vp.upperWall.offsetPct)})`);
  }
  if (vp.lowerWall) {
    parts.push(`下支撑墙 ${formatCompactPrice(vp.lowerWall.price)}(${fmtSignedPct(vp.lowerWall.offsetPct)})`);
  }
  const liqParts: string[] = [];
  if (vp.nearestShortLiq) {
    liqParts.push(
      `上${formatCompactPrice(vp.nearestShortLiq.price)}(${fmtSignedPct(vp.nearestShortLiq.offsetPct)},${vp.nearestShortLiq.leverageLabel})`,
    );
  }
  if (vp.nearestLongLiq) {
    liqParts.push(
      `下${formatCompactPrice(vp.nearestLongLiq.price)}(${fmtSignedPct(vp.nearestLongLiq.offsetPct)},${vp.nearestLongLiq.leverageLabel})`,
    );
  }
  if (liqParts.length > 0) parts.push(`磁吸 ${liqParts.join(' / ')}`);

  return parts.join(' · ');
}
