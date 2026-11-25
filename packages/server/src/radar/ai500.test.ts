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

test('★ 路线④：AI500 识别早期放量起爆加分，同时对末期高波动妖币（ATR>4.5% 且 24h>35%）打警示降权', () => {
  // 1) 早期起爆标的：温和震荡蓄势（ATR ≈ 0.9%）后刚离 EMA20（~1.0×ATR）放量实体起爆
  const early15 = makeTrendKlines({
    count: 80,
    startPrice: 10,
    stepPct: 0.0004,
    intervalMs: 15 * 60_000,
    baseQuoteVol: 1_500_000,
    takerBuyRatio: 0.61,
    lastVolMultiplier: 2.4,
    lastBodyRatio: 0.78,
    lastJumpPct: 0.007,
  });
  for (let i = 0; i < early15.length - 1; i += 1) {
    const k = early15[i]!;
    k.high = Math.max(k.high, k.close * 1.0045);
    k.low = Math.min(k.low, k.close * 0.9955);
  }
  const early4h = makeTrendKlines({
    count: 45,
    startPrice: 8.5,
    stepPct: 0.005,
    intervalMs: 4 * 3600_000,
    baseQuoteVol: 25_000_000,
    takerBuyRatio: 0.59,
  });
  const earlyScore = scoreAi500Symbol({
    symbol: 'EARLYUSDT',
    price: early15[early15.length - 1]!.close,
    quoteVolume24h: 180_000_000,
    changePercent24h: 11.5,
    fundingRate: -0.0001,
    klines15m: early15,
    klines4h: early4h,
    openInterestUsd: 60_000_000,
    oiChange1hPct: 3.1,
    oiChange4hPct: 6.5,
    btcReturn1hPct: 0.1,
    btcReturn4hPct: 0.2,
  });

  // 2) 末期高波动妖币：ATR15m > 5% 且 24h 已涨 +58%
  const blowoff15 = makeTrendKlines({
    count: 80,
    startPrice: 1.0,
    stepPct: 0.006,
    intervalMs: 15 * 60_000,
    baseQuoteVol: 2_000_000,
    takerBuyRatio: 0.58,
    lastVolMultiplier: 1.4,
    lastBodyRatio: 0.12, // 极端巨震：totalRange = body/0.12 -> 拉高 ATR > 5%
    lastJumpPct: 0.01,
  });
  // 让最近 30 根整体振幅放大（±3.5%），使 Wilder 平滑后的 ATR15m ≈ 6% (>4.5%)
  for (let i = blowoff15.length - 30; i < blowoff15.length; i += 1) {
    const k = blowoff15[i]!;
    k.high = k.close * 1.036;
    k.low = k.close * 0.964;
  }
  const blowoffScore = scoreAi500Symbol({
    symbol: 'BLOWOFFUSDT',
    price: blowoff15[blowoff15.length - 1]!.close,
    quoteVolume24h: 220_000_000,
    changePercent24h: 58.0,
    fundingRate: -0.0002,
    klines15m: blowoff15,
    klines4h: early4h,
    openInterestUsd: 50_000_000,
    oiChange1hPct: 1.0,
    oiChange4hPct: 2.0,
    btcReturn1hPct: 0.1,
    btcReturn4hPct: 0.2,
  });

  assert.ok(earlyScore.tags.includes('早期放量起爆'), `早期起爆应带标签，实际 ${earlyScore.tags.join(',')}`);
  assert.ok(
    blowoffScore.tags.some((t) => t.startsWith('高波动警示')),
    `ATR>4.5% 且 24h>35% 应打高波动警示，实际 ${blowoffScore.tags.join(',')}`,
  );
  assert.ok(
    earlyScore.score > blowoffScore.score,
    `早期放量起爆(${earlyScore.score})应排在末期高波动妖币(${blowoffScore.score})之前`,
  );
  // 警示标签必须排在 tags 最前面，不被正向标签挤出前 6
  assert.ok(
    blowoffScore.tags[0]?.startsWith('高波动警示'),
    `高波动警示应置顶，实际首位为 ${blowoffScore.tags[0]}`,
  );
});

test('★ AI500 2.0 初筛前沿：早期贴边突破中盘币抢进前排，末期暴涨妖币(+96%)被逐出振幅/费率榜', () => {
  const rows: RadarUniverseRow[] = [
    // 10 个成交额大的主流币（但处于区间中部，无突破）
    ...Array.from({ length: 10 }, (_, i) => ({
      symbol: `MAJOR${i}USDT`,
      price: 100,
      quoteVolume24h: (20 - i) * 100_000_000,
      changePercent24h: 0.8,
      high24h: 102,
      low24h: 98,
      fundingRate: 0.0001,
    })),
    // 末期透支妖币：+96.5% / 振幅 110% / 极端负费率，成交额不高
    {
      symbol: 'MANTRAUSDT',
      price: 1.96,
      quoteVolume24h: 90_000_000,
      changePercent24h: 96.5,
      high24h: 2.1,
      low24h: 1.0,
      fundingRate: -0.0035,
    },
    // 早期突破前沿中盘币：+8.5%，价格贴近 24h 最高点（96% 位置），成交额中等
    {
      symbol: 'FRONTIERUSDT',
      price: 10.85,
      quoteVolume24h: 110_000_000,
      changePercent24h: 8.5,
      high24h: 10.9,
      low24h: 9.8,
      fundingRate: 0.0001,
    },
  ];

  const picked = selectPrescreenSymbols(rows, { limit: 6, alwaysInclude: new Set(['MAJOR0USDT']) });
  assert.ok(picked.includes('FRONTIERUSDT'), `早期贴边突破币应第一时间进入前 6 初筛，实际 ${picked.join(',')}`);
  assert.ok(!picked.includes('MANTRAUSDT'), `末期 +96.5% 透支妖币不应挤占振幅/费率初筛位，实际 ${picked.join(',')}`);
});

test('★ AI500 2.0 1h RS Alpha 灵敏捕获刚起势龙头 + 蓄势箱体放量突破 + 突破缩量回踩保分', () => {
  const k4h = makeTrendKlines({
    count: 45,
    startPrice: 9.0,
    stepPct: 0.0035,
    intervalMs: 4 * 3600_000,
    baseQuoteVol: 25_000_000,
    takerBuyRatio: 0.58,
  });

  // 1) 1h 突发领涨龙头：前 76 根低波横盘微涨（4h 涨幅很小），最后 4 根（1h）刚拉出 +4.2% 且最后 1 根放量实体破箱体
  const squeeze15 = makeTrendKlines({
    count: 80,
    startPrice: 10,
    stepPct: 0.0003,
    intervalMs: 15 * 60_000,
    baseQuoteVol: 1_200_000,
    takerBuyRatio: 0.61,
  });
  // 让前 20 根压成紧致蓄势箱体（±0.4%），最后 4 根逐步走强并在第 80 根放量实体突破
  const basePrice = squeeze15[59]!.close;
  for (let i = 60; i < 76; i += 1) {
    const k = squeeze15[i]!;
    k.open = basePrice;
    k.close = basePrice * (1 + (i % 2 === 0 ? 0.001 : -0.0005));
    k.high = basePrice * 1.003;
    k.low = basePrice * 0.997;
    k.quoteVolume = 1_000_000;
    k.takerBuyQuote = 560_000;
  }
  let p = basePrice;
  for (let i = 76; i < 80; i += 1) {
    const k = squeeze15[i]!;
    const jump = i === 79 ? 0.015 : 0.008;
    k.open = p;
    k.close = p * (1 + jump);
    k.high = k.close * 1.0015;
    k.low = k.open * 0.999;
    k.quoteVolume = i === 79 ? 2_800_000 : 1_500_000;
    k.takerBuyQuote = k.quoteVolume * 0.66;
    p = k.close;
  }

  const squeezeRes = scoreAi500Symbol({
    symbol: 'SQUEEZEUSDT',
    price: squeeze15[79]!.close,
    quoteVolume24h: 160_000_000,
    changePercent24h: 6.5,
    fundingRate: -0.0001,
    klines15m: squeeze15,
    klines4h: k4h,
    openInterestUsd: 55_000_000,
    oiChange1hPct: 3.2,
    oiChange4hPct: 4.5,
    btcReturn1hPct: 0.0,
    btcReturn4hPct: 3.5, // 故意让 4h RS 不占优，验证 1h RS Alpha 独立生效
  });

  assert.ok(
    squeezeRes.metrics.rsAlpha1hPct !== undefined &&
      squeezeRes.metrics.rsAlpha1hPct !== null &&
      squeezeRes.metrics.rsAlpha1hPct >= 3.0,
    `应计算并暴露 rsAlpha1hPct，实际 ${squeezeRes.metrics.rsAlpha1hPct}`,
  );
  assert.ok(
    squeezeRes.tags.some((t) => t.startsWith('1h强势领涨')),
    `1h 领涨龙头应打 1h强势领涨 标签，实际 ${squeezeRes.tags.join(',')}`,
  );
  assert.ok(
    squeezeRes.tags.includes('蓄势放量突破'),
    `紧致箱体首根放量扩张应打 蓄势放量突破 标签，实际 ${squeezeRes.tags.join(',')}`,
  );
  assert.ok(squeezeRes.score >= 78, `蓄势放量起爆龙头应高分，实际 ${squeezeRes.score}`);

  // 2) 黄金缩量回踩确认：在刚才第 80 根大突破后，新增第 81 根缩量窄幅小阴回踩且守在箱体上沿上方
  const retest15 = [...squeeze15];
  const prevBar = squeeze15[79]!;
  retest15.push({
    openTime: prevBar.openTime + 15 * 60_000,
    closeTime: prevBar.closeTime + 15 * 60_000,
    open: prevBar.close,
    close: prevBar.close * 0.997,
    high: prevBar.close * 1.001,
    low: prevBar.close * 0.9955,
    volume: 120_000,
    quoteVolume: prevBar.quoteVolume * 0.45,
    trades: 80,
    takerBuyBase: 65_000,
    takerBuyQuote: prevBar.quoteVolume * 0.45 * 0.56,
  });
  const retestRes = scoreAi500Symbol({
    symbol: 'RETESTUSDT',
    price: retest15[retest15.length - 1]!.close,
    quoteVolume24h: 160_000_000,
    changePercent24h: 6.2,
    fundingRate: -0.0001,
    klines15m: retest15,
    klines4h: k4h,
    openInterestUsd: 55_000_000,
    oiChange1hPct: 3.0,
    oiChange4hPct: 4.5,
    btcReturn1hPct: 0.0,
    btcReturn4hPct: 0.2,
  });

  assert.ok(
    retestRes.tags.includes('突破回踩确认'),
    `放量突破后缩量守位回踩应识别为 突破回踩确认，实际 ${retestRes.tags.join(',')}`,
  );
  assert.ok(
    retestRes.dimensions.breakout >= 14,
    `突破回踩确认的突破量能分不应被误杀，实际 ${retestRes.dimensions.breakout}`,
  );
});

test('★ AI500 2.0 识破放量反砸派发（MMT型）与极端日内透支（MANTRA型 +96%）', () => {
  const k4h = makeTrendKlines({
    count: 45,
    startPrice: 1.0,
    stepPct: 0.008,
    intervalMs: 4 * 3600_000,
    baseQuoteVol: 25_000_000,
    takerBuyRatio: 0.55,
  });

  // 1) 冲高后最近 2 根放量反砸大阴线（如 MMTUSDT 0.3279 → 0.2962）
  const dump15 = makeTrendKlines({
    count: 80,
    startPrice: 0.25,
    stepPct: 0.003,
    intervalMs: 15 * 60_000,
    baseQuoteVol: 1_500_000,
    takerBuyRatio: 0.54,
  });
  const peak = dump15[77]!.close;
  // 第 79、80 根连续放量实心大阴线反砸
  dump15[78]!.open = peak;
  dump15[78]!.high = peak * 1.003;
  dump15[78]!.close = peak * 0.975;
  dump15[78]!.low = peak * 0.972;
  dump15[78]!.quoteVolume = 4_000_000;
  dump15[78]!.takerBuyQuote = 1_400_000;

  dump15[79]!.open = dump15[78]!.close;
  dump15[79]!.high = dump15[78]!.close * 1.002;
  dump15[79]!.close = dump15[78]!.close * 0.978;
  dump15[79]!.low = dump15[78]!.close * 0.975;
  dump15[79]!.quoteVolume = 3_800_000;
  dump15[79]!.takerBuyQuote = 1_300_000;

  const dumpRes = scoreAi500Symbol({
    symbol: 'DUMPUSDT',
    price: dump15[79]!.close,
    quoteVolume24h: 180_000_000,
    changePercent24h: 18,
    fundingRate: 0.0001,
    klines15m: dump15,
    klines4h: k4h,
    openInterestUsd: 40_000_000,
    oiChange1hPct: -1.5,
    oiChange4hPct: 2.0,
    btcReturn1hPct: 0.1,
    btcReturn4hPct: 0.2,
  });

  assert.ok(
    dumpRes.tags.includes('放量反砸警惕'),
    `冲高放量反砸应打 放量反砸警惕，实际 ${dumpRes.tags.join(',')}`,
  );
  assert.ok(
    !dumpRes.tags.includes('早期放量起爆'),
    `放量反砸标的绝不可误标 早期放量起爆`,
  );

  // 2) 极端透支妖币（MANTRA型：ATR ~6% 且 24h +96.5%）应被压到 skip(<65) 且双警示置顶
  const mantra15 = makeTrendKlines({
    count: 80,
    startPrice: 1.0,
    stepPct: 0.007,
    intervalMs: 15 * 60_000,
    baseQuoteVol: 3_000_000,
    takerBuyRatio: 0.56,
  });
  for (let i = 50; i < 80; i += 1) {
    const k = mantra15[i]!;
    k.high = k.close * 1.036;
    k.low = k.close * 0.964;
  }
  const mantraRes = scoreAi500Symbol({
    symbol: 'MANTRAUSDT',
    price: mantra15[79]!.close,
    quoteVolume24h: 300_000_000,
    changePercent24h: 96.5,
    fundingRate: -0.0002,
    klines15m: mantra15,
    klines4h: k4h,
    openInterestUsd: 60_000_000,
    oiChange1hPct: 2.0,
    oiChange4hPct: 4.0,
    btcReturn1hPct: 0.1,
    btcReturn4hPct: 0.2,
  });

  assert.ok(
    mantraRes.tags.some((t) => t.startsWith('高波动警示')) &&
      mantraRes.tags.some((t) => t.startsWith('日内透支警示')),
    `MANTRA型妖币应同时打高波动警示与日内透支警示，实际 ${mantraRes.tags.join(',')}`,
  );
  assert.ok(
    mantraRes.score < 70,
    `MANTRA型透支妖币应被阶梯降权至 <70，实际 ${mantraRes.score}`,
  );
});
