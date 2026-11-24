/**
 * M2.1 单元测试与离线多币种样本打分验收：AI500 六维选币雷达（`radar/ai500.ts`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Kline } from '@aq/shared';

import {
  aggregate15mTo1h,
  filterRadarUniverse,
  rankAi500Candidates,
  scoreAi500Symbol,
  selectPrescreenSymbols,
  type RadarUniverseRow,
} from './ai500.js';

function makeTrendKlines(options: {
  count: number;
  startPrice: number;
  stepPct: number;
  intervalMs: number;
  baseQuoteVol: number;
  takerBuyRatio: number;
  lastVolMultiplier?: number;
  lastBodyRatio?: number;
  lastUpperWickSpike?: number;
  lastJumpPct?: number;
}): Kline[] {
  const out: Kline[] = [];
  const t0 = Date.UTC(2026, 10, 20, 0, 0, 0);
  let price = options.startPrice;

  for (let i = 0; i < options.count; i += 1) {
    const isLast = i === options.count - 1;
    const step = isLast && options.lastJumpPct !== undefined ? options.lastJumpPct : options.stepPct;
    const open = price;
    const close = open * (1 + step);
    const body = Math.abs(close - open);
    const minSpan = Math.max(body, open * 0.003);
    const ratio = isLast && options.lastBodyRatio !== undefined ? options.lastBodyRatio : 0.72;
    const totalRange = minSpan / Math.max(ratio, 0.1);
    const wickHalf = Math.max(0, (totalRange - body) / 2);

    let high = Math.max(open, close) + wickHalf;
    const low = Math.max(1e-6, Math.min(open, close) - wickHalf);
    if (isLast && options.lastUpperWickSpike) {
      high = Math.max(open, close) + open * options.lastUpperWickSpike;
    }

    const qv = options.baseQuoteVol * (isLast ? (options.lastVolMultiplier ?? 1) : 1);
    const vol = qv / Math.max(close, 1e-6);
    out.push({
      openTime: t0 + i * options.intervalMs,
      closeTime: t0 + (i + 1) * options.intervalMs - 1,
      open,
      high,
      low,
      close,
      volume: vol,
      quoteVolume: qv,
      trades: 100,
      takerBuyBase: vol * options.takerBuyRatio,
      takerBuyQuote: qv * options.takerBuyRatio,
    });
    price = close;
  }
  return out;
}

test('★ M2.1 流动性硬过滤：剔除稳定币、低成交额与低 OI，但豁免 alwaysInclude', () => {
  const rows: RadarUniverseRow[] = [
    { symbol: 'BTCUSDT', price: 68000, quoteVolume24h: 8_000_000_000, changePercent24h: 1.5, high24h: 69000, low24h: 67000, fundingRate: 0.0001, openInterestUsd: 5_000_000_000 },
    { symbol: 'USDCUSDT', price: 1.0, quoteVolume24h: 500_000_000, changePercent24h: 0.01, high24h: 1.001, low24h: 0.999, fundingRate: 0, openInterestUsd: 100_000_000 },
    { symbol: 'TINYUSDT', price: 0.05, quoteVolume24h: 5_000_000, changePercent24h: 12, high24h: 0.06, low24h: 0.04, fundingRate: 0.0001, openInterestUsd: 2_000_000 },
    { symbol: 'LOWOIUSDT', price: 2.0, quoteVolume24h: 60_000_000, changePercent24h: 4, high24h: 2.1, low24h: 1.9, fundingRate: 0.0001, openInterestUsd: 1_500_000 },
    { symbol: 'HELDUSDT', price: 1.2, quoteVolume24h: 2_000_000, changePercent24h: -2, high24h: 1.3, low24h: 1.1, fundingRate: 0, openInterestUsd: 500_000 },
    { symbol: 'SOLUSDT', price: 150, quoteVolume24h: 900_000_000, changePercent24h: 6.5, high24h: 155, low24h: 140, fundingRate: -0.0001, openInterestUsd: 400_000_000 },
  ];

  const filtered = filterRadarUniverse(rows, {
    minQuoteVolume24h: 30_000_000,
    minOpenInterestUsd: 5_000_000,
    alwaysInclude: new Set(['HELDUSDT']),
  });
  const syms = filtered.map((r) => r.symbol);
  assert.deepEqual(syms.sort(), ['BTCUSDT', 'HELDUSDT', 'SOLUSDT']);
});

test('★ M2.1 15m → 1h 聚合成帧时间对齐且成交额守恒', () => {
  const k15 = makeTrendKlines({
    count: 20,
    startPrice: 100,
    stepPct: 0.002,
    intervalMs: 15 * 60_000,
    baseQuoteVol: 1_000_000,
    takerBuyRatio: 0.55,
  });
  const k1h = aggregate15mTo1h(k15);
  assert.equal(k1h.length, 5);
  assert.equal(k1h[4]!.close, k15[19]!.close);
  assert.equal(k1h[4]!.open, k15[16]!.open);
  assert.ok(Math.abs(k1h[4]!.quoteVolume - 4_000_000) < 1e-6);
});

test('★ M2.1 多空双向六维打分验收：干净起爆多头 & 干净破位空头均进强关注(≥75)，追高插针与空心拉盘被降分', () => {
  // 1) 干净多头起爆龙头（三周期共振 + 放量实体突破 + OI 增仓 + Taker 净买 + 负费率轧空 + RS Alpha + 合理 ATR 位置）
  const bull15 = makeTrendKlines({
    count: 80,
    startPrice: 100,
    stepPct: 0.0012,
    intervalMs: 15 * 60_000,
    baseQuoteVol: 2_000_000,
    takerBuyRatio: 0.62,
    lastVolMultiplier: 2.6,
    lastBodyRatio: 0.8,
    lastJumpPct: 0.004,
  });
  const bull4h = makeTrendKlines({
    count: 45,
    startPrice: 80,
    stepPct: 0.006,
    intervalMs: 4 * 3600_000,
    baseQuoteVol: 30_000_000,
    takerBuyRatio: 0.6,
  });
  const bullLeader = scoreAi500Symbol({
    symbol: 'SOLUSDT',
    price: bull15[bull15.length - 1]!.close,
    quoteVolume24h: 850_000_000,
    changePercent24h: 7.2,
    fundingRate: -0.00025,
    klines15m: bull15,
    klines4h: bull4h,
    openInterestUsd: 350_000_000,
    oiChange1hPct: 3.4,
    oiChange4hPct: 6.2,
    btcReturn1hPct: 0.1,
    btcReturn4hPct: 0.2,
  });

  // 2) 干净空头破位龙头（三周期空头共振 + 放量实体破位 + OI 增仓做空 + Taker 净卖 + 正费率挤多）
  const bear15 = makeTrendKlines({
    count: 80,
    startPrice: 50,
    stepPct: -0.0012,
    intervalMs: 15 * 60_000,
    baseQuoteVol: 1_800_000,
    takerBuyRatio: 0.37,
    lastVolMultiplier: 2.5,
    lastBodyRatio: 0.78,
    lastJumpPct: -0.004,
  });
  const bear4h = makeTrendKlines({
    count: 45,
    startPrice: 62,
    stepPct: -0.006,
    intervalMs: 4 * 3600_000,
    baseQuoteVol: 25_000_000,
    takerBuyRatio: 0.39,
  });
  const bearLeader = scoreAi500Symbol({
    symbol: 'AVAXUSDT',
    price: bear15[bear15.length - 1]!.close,
    quoteVolume24h: 420_000_000,
    changePercent24h: -6.8,
    fundingRate: 0.00032,
    klines15m: bear15,
    klines4h: bear4h,
    openInterestUsd: 180_000_000,
    oiChange1hPct: 2.8,
    oiChange4hPct: 5.5,
    btcReturn1hPct: 0.1,
    btcReturn4hPct: 0.2,
  });

  // 3) 末端追高 + 长上影插针 + 极端多头拥挤 + OI 背离
  const chaser15 = makeTrendKlines({
    count: 80,
    startPrice: 10,
    stepPct: 0.0004,
    intervalMs: 15 * 60_000,
    baseQuoteVol: 1_000_000,
    takerBuyRatio: 0.43,
    lastVolMultiplier: 0.6,
    lastBodyRatio: 0.2,
    lastUpperWickSpike: 0.06,
    lastJumpPct: 0.045,
  });
  const chaser4h = makeTrendKlines({
    count: 45,
    startPrice: 9.5,
    stepPct: 0.001,
    intervalMs: 4 * 3600_000,
    baseQuoteVol: 10_000_000,
    takerBuyRatio: 0.47,
  });
  const chaser = scoreAi500Symbol({
    symbol: 'CHASEUSDT',
    price: chaser15[chaser15.length - 1]!.close,
    quoteVolume24h: 120_000_000,
    changePercent24h: 28,
    fundingRate: 0.00065,
    klines15m: chaser15,
    klines4h: chaser4h,
    openInterestUsd: 40_000_000,
    oiChange1hPct: -2.2,
    oiChange4hPct: -5.4,
    btcReturn1hPct: 0.2,
    btcReturn4hPct: 0.5,
  });

  assert.equal(bullLeader.bias, 'long');
  assert.equal(bullLeader.tier, 'strong', `干净多头应 ≥75 分，实际 ${bullLeader.score}`);
  assert.ok(bullLeader.score >= 80, `干净多头应拿到高分，实际 ${bullLeader.score}`);

  assert.equal(bearLeader.bias, 'short');
  assert.equal(bearLeader.tier, 'strong', `干净空头应 ≥75 分，实际 ${bearLeader.score}`);
  assert.ok(bearLeader.score >= 80, `干净空头应拿到高分，实际 ${bearLeader.score}`);

  assert.ok(
    chaser.score < 60 && chaser.tier === 'skip',
    `追高插针 + OI 背离应被压到 skip(<60)，实际 ${chaser.score}`,
  );
  assert.ok(chaser.tags.some((t) => t.includes('追单风险') || t.includes('长上影')));

  const ranked = rankAi500Candidates([chaser, bearLeader, bullLeader], { topN: 2 });
  assert.equal(ranked.strongCount, 2);
  assert.deepEqual(
    ranked.topCandidates.map((c) => c.symbol).sort(),
    ['AVAXUSDT', 'SOLUSDT'],
  );
});

test('★ M2.1 初筛轮询覆盖成交额/涨跌/振幅/费率且永不丢 alwaysInclude', () => {
  const rows: RadarUniverseRow[] = Array.from({ length: 40 }, (_, i) => ({
    symbol: `COIN${i}USDT`,
    price: 10 + i,
    quoteVolume24h: (40 - i) * 10_000_000,
    changePercent24h: (i % 2 === 0 ? 1 : -1) * (i * 1.1),
    high24h: (10 + i) * 1.05,
    low24h: (10 + i) * 0.95,
    fundingRate: (i - 20) * 0.00002,
  }));
  const picked = selectPrescreenSymbols(rows, {
    limit: 12,
    alwaysInclude: new Set(['COIN39USDT']),
  });
  assert.equal(picked.length, 12);
  assert.ok(picked.includes('COIN39USDT'));
});
