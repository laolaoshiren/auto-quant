import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildMarketStreamUrl, resolveEndpoints } from '../binance/endpoints.js';
import { selectPrescreenSymbols, type RadarUniverseRow } from './ai500.js';
import { MarketPulseTracker } from './marketPulse.js';

const BASE_MS = Date.UTC(2026, 10, 26, 8, 0, 0);

test('★ buildMarketStreamUrl：实盘走 /market/stream 路由，Demo/测试网走 /stream', () => {
  const prod = buildMarketStreamUrl(resolveEndpoints('production'), ['!miniTicker@arr']);
  const demo = buildMarketStreamUrl(resolveEndpoints('demo'), ['!miniTicker@arr']);
  assert.equal(prod, 'wss://fstream.binance.com/market/stream?streams=!miniTicker@arr');
  assert.equal(demo, 'wss://demo-fstream.binance.com/stream?streams=!miniTicker@arr');
});

test('★ MarketPulseTracker：秒抓「24h 横盘但最近 5m 突发点火」暗马，同时严守 30M 流动底线与抗插针/透支过滤', () => {
  const tracker = new MarketPulseTracker();

  // 模拟连续 6 分钟的 1s 推送（每分钟喂 2 帧即可构成完整分钟桶）
  for (let m = 0; m < 6; m += 1) {
    const t0 = BASE_MS + m * 60_000;
    const t1 = t0 + 30_000;

    // 1) DARKHORSEUSDT：24h 涨幅仅 +1.8%（24h榜完全不起眼），成交额 60M（分钟均量 41.7K），
    //    前 2 分钟横盘 10.00，后 4 分钟放量 4x 顺滑拉升到 10.22（+2.2%）
    const dhPrice0 = m < 2 ? 10.0 : 10.0 + (m - 1) * 0.05;
    const dhPrice1 = m < 2 ? 10.0 : 10.0 + (m - 1) * 0.055;
    const dhVolBase = 60_000_000 + (m >= 2 ? (m - 1) * 260_000 : m * 30_000);

    // 2) FLUSHUSDT：突然 5m 放量单边急砸 -2.4%（空头暗马）
    const flPrice0 = m < 2 ? 5.0 : 5.0 - (m - 1) * 0.025;
    const flPrice1 = m < 2 ? 5.0 : 5.0 - (m - 1) * 0.03;
    const flVolBase = 80_000_000 + (m >= 2 ? (m - 1) * 320_000 : m * 40_000);

    // 3) TINYLIQUSDT：同样暴涨 +4%，但 24h 成交额仅 12M（<30M 流动性红线 → 必须拦截）
    const tinyPrice = m < 2 ? 1.0 : 1.0 + (m - 1) * 0.012;
    const tinyVol = 12_000_000 + m * 150_000;

    // 4) WHIPSAWUSDT：冲高 +3.5% 又原地砸回 +0.1%（画门插针，效率极低 → 必须拦截）
    const whipPrice0 = m === 4 ? 20.7 : 20.0;
    const whipPrice1 = m === 4 ? 20.02 : 20.01;
    const whipVol = 70_000_000 + m * 300_000;

    // 5) BLOWOFFUSDT：24h 已经暴涨 +72% 的末期妖币（必须拦截）
    const blowPrice = m < 2 ? 1.7 : 1.7 + (m - 1) * 0.01;
    const blowVol = 150_000_000 + m * 500_000;

    // 6) USDCUSDT：稳定币（必须忽略）
    tracker.ingestBatch(
      [
        { s: 'DARKHORSEUSDT', E: t0, c: dhPrice0, o: 10.0, h: 10.3, l: 9.8, q: dhVolBase },
        { s: 'FLUSHUSDT', E: t0, c: flPrice0, o: 5.0, h: 5.1, l: 4.85, q: flVolBase },
        { s: 'TINYLIQUSDT', E: t0, c: tinyPrice, o: 1.0, h: 1.06, l: 0.98, q: tinyVol },
        { s: 'WHIPSAWUSDT', E: t0, c: whipPrice0, o: 20.0, h: 20.8, l: 19.9, q: whipVol },
        { s: 'BLOWOFFUSDT', E: t0, c: blowPrice, o: 1.0, h: 1.8, l: 1.0, q: blowVol },
        { s: 'USDCUSDT', E: t0, c: 1.0, o: 1.0, h: 1.01, l: 0.99, q: 500_000_000 },
      ],
      t0,
    );
    tracker.ingestBatch(
      [
        { s: 'DARKHORSEUSDT', E: t1, c: dhPrice1, o: 10.0, h: 10.3, l: 9.8, q: dhVolBase + (m >= 2 ? 120_000 : 10_000) },
        { s: 'FLUSHUSDT', E: t1, c: flPrice1, o: 5.0, h: 5.1, l: 4.85, q: flVolBase + (m >= 2 ? 140_000 : 10_000) },
        { s: 'TINYLIQUSDT', E: t1, c: tinyPrice * 1.003, o: 1.0, h: 1.06, l: 0.98, q: tinyVol + 80_000 },
        { s: 'WHIPSAWUSDT', E: t1, c: whipPrice1, o: 20.0, h: 20.8, l: 19.9, q: whipVol + 120_000 },
        { s: 'BLOWOFFUSDT', E: t1, c: blowPrice * 1.002, o: 1.0, h: 1.8, l: 1.0, q: blowVol + 200_000 },
      ],
      t1,
    );
  }

  const nowMs = BASE_MS + 5 * 60_000 + 45_000;
  const hot = tracker.getHotSignals({ limit: 8, minQuoteVolume24h: 30_000_000, nowMs });
  const syms = hot.map((h) => h.symbol);

  assert.ok(syms.includes('DARKHORSEUSDT'), `应捕获多头暗马，实际 ${syms.join(',')}`);
  assert.ok(syms.includes('FLUSHUSDT'), `应捕获空头急砸暗马，实际 ${syms.join(',')}`);
  assert.ok(!syms.includes('TINYLIQUSDT'), `低于 30M 成交额的小币绝不可被提名`);
  assert.ok(!syms.includes('WHIPSAWUSDT'), `来回插针画门币不可被提名`);
  assert.ok(!syms.includes('BLOWOFFUSDT'), `24h 已暴涨 72% 的末期透支币不可被提名`);
  assert.ok(!syms.includes('USDCUSDT'), `稳定币不可被提名`);

  const dh = hot.find((h) => h.symbol === 'DARKHORSEUSDT')!;
  const fl = hot.find((h) => h.symbol === 'FLUSHUSDT')!;
  assert.equal(dh.direction, 'long');
  assert.equal(fl.direction, 'short');
  assert.ok(dh.volSurge5m >= 1.8, `多头暗马 5m 放量倍率应 ≥1.8，实际 ${dh.volSurge5m}`);

  // 超过 3 分钟未收到帧后自动失效，不返回陈旧僵尸信号
  const staleHot = tracker.getHotSignals({
    limit: 8,
    minQuoteVolume24h: 30_000_000,
    nowMs: nowMs + 4 * 60_000,
  });
  assert.equal(staleHot.length, 0);
});

test('★ MarketPulse × AI500 初筛联动：24h 平淡的暗马靠 WS 脉冲提名抢进前 6，且绝不绕过流动性/透支护栏', () => {
  const rows: RadarUniverseRow[] = [
    ...Array.from({ length: 12 }, (_, i) => ({
      symbol: `MAJOR${i}USDT`,
      price: 100,
      quoteVolume24h: (30 - i) * 100_000_000,
      changePercent24h: 1.5 + i * 0.5,
      high24h: 105,
      low24h: 95,
      fundingRate: 0.0001,
    })),
    // 24h 涨幅只有 +1.2%、处于区间中部、成交额垫底，没有 WS 脉冲根本进不了前 6
    {
      symbol: 'DARKHORSEUSDT',
      price: 10.12,
      quoteVolume24h: 45_000_000,
      changePercent24h: 1.2,
      high24h: 10.5,
      low24h: 9.8,
      fundingRate: 0.00005,
    },
    // 末期 +85% 妖币就算混进 pulseSymbols 也会被 selectPrescreenSymbols 拦截
    {
      symbol: 'MANTRAUSDT',
      price: 1.85,
      quoteVolume24h: 80_000_000,
      changePercent24h: 85,
      high24h: 2.0,
      low24h: 1.0,
      fundingRate: -0.002,
    },
  ];

  // 无脉冲时 DARKHORSEUSDT 排不进前 6
  const withoutPulse = selectPrescreenSymbols(rows, { limit: 6, alwaysInclude: new Set(['MAJOR0USDT']) });
  assert.ok(!withoutPulse.includes('DARKHORSEUSDT'));

  // 有 WS 脉冲提名时 DARKHORSEUSDT 直接抢进前 6，同时 MANTRAUSDT 与未过流动性过滤的 TINYLIQUSDT 被挡在门外
  const withPulse = selectPrescreenSymbols(rows, {
    limit: 6,
    alwaysInclude: new Set(['MAJOR0USDT']),
    pulseSymbols: ['TINYLIQUSDT', 'MANTRAUSDT', 'DARKHORSEUSDT'],
  });
  assert.ok(withPulse.includes('DARKHORSEUSDT'), `WS 脉冲暗马应进入前 6，实际 ${withPulse.join(',')}`);
  assert.ok(!withPulse.includes('MANTRAUSDT'), `末期透支币即使提名也要被拦截`);
  assert.ok(!withPulse.includes('TINYLIQUSDT'), `未过流动性过滤的币绝不可混入初筛`);
});
