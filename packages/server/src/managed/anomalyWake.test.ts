import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Kline } from '@aq/shared';

import type { Ai500Candidate } from '../radar/ai500.js';
import {
  ANOMALY_GLOBAL_COOLDOWN_MS,
  ANOMALY_MIN_SINCE_CYCLE_MS,
  ANOMALY_SKIP_IF_NEXT_CYCLE_WITHIN_MS,
  detectBarShock,
  evaluateAnomalyCandidates,
  shouldRunAnomalyScan,
  type BarShockResult,
} from './anomalyWake.js';

function makeFlatBars(count: number, price = 100, rangePct = 0.004): Kline[] {
  const out: Kline[] = [];
  const base = Date.UTC(2026, 10, 26, 0, 0, 0);
  for (let i = 0; i < count; i += 1) {
    const o = price;
    const c = price * (1 + (i % 2 === 0 ? 0.001 : -0.001));
    out.push({
      openTime: base + i * 15 * 60_000,
      closeTime: base + (i + 1) * 15 * 60_000 - 1,
      open: o,
      high: o * (1 + rangePct / 2),
      low: o * (1 - rangePct / 2),
      close: c,
      volume: 1000,
      quoteVolume: 100_000,
      trades: 50,
      takerBuyBase: 500,
      takerBuyQuote: 50_000,
    });
  }
  return out;
}

function makeCandidate(overrides: Partial<Ai500Candidate> = {}): Ai500Candidate {
  return {
    symbol: 'MMTUSDT',
    score: 80,
    bias: 'long',
    tier: 'strong',
    dimensions: { trend: 18, breakout: 18, oiFlow: 11, takerFlow: 12, funding: 10, alphaPosition: 11 },
    tags: ['早期放量起爆', '三周期多头共振'],
    metrics: {
      price: 0.305,
      quoteVolume24h: 120_000_000,
      change1hPct: 3.1,
      change4hPct: 6.2,
      change24hPct: 12.5,
      rsAlpha4hPct: 5.5,
      volRatio15m: 2.4,
      bodyRatio15m: 0.72,
      atr15mPct: 1.8,
      distEma20Atr: 0.9,
      takerBuyRatio1h: 0.62,
      takerBuyRatio4h: 0.59,
      cvdTrend: 'rising',
      openInterestUsd: 40_000_000,
      oiChange1hPct: 4.5,
      oiChange4hPct: 8.0,
      fundingRatePct: 0.01,
    },
    ...overrides,
  };
}

test('★ shouldRunAnomalyScan：防刷屏四道闸门精确拦截与放行', () => {
  const now = 10_000_000;
  const base = {
    mode: 'ai_managed',
    running: true,
    cycleInFlight: false,
    scanInFlight: false,
    nowMs: now,
    lastCycleFinishedAtMs: now - ANOMALY_MIN_SINCE_CYCLE_MS - 1_000,
    lastAnomalyWakeAtMs: now - ANOMALY_GLOBAL_COOLDOWN_MS - 1_000,
    nextCycleAtMs: now + 8 * 60_000,
  };

  assert.equal(shouldRunAnomalyScan(base).run, true);
  assert.equal(shouldRunAnomalyScan({ ...base, mode: 'strategy' }).run, false);
  assert.equal(shouldRunAnomalyScan({ ...base, running: false }).run, false);
  assert.equal(shouldRunAnomalyScan({ ...base, cycleInFlight: true }).run, false);
  assert.equal(shouldRunAnomalyScan({ ...base, scanInFlight: true }).run, false);
  assert.equal(
    shouldRunAnomalyScan({ ...base, lastCycleFinishedAtMs: now - 60_000 }).run,
    false,
    '上轮刚结束 < 3m 不扫',
  );
  assert.equal(
    shouldRunAnomalyScan({ ...base, lastAnomalyWakeAtMs: now - 2 * 60_000 }).run,
    false,
    '全局冷却 < 5m 不扫',
  );
  assert.equal(
    shouldRunAnomalyScan({
      ...base,
      nextCycleAtMs: now + ANOMALY_SKIP_IF_NEXT_CYCLE_WITHIN_MS - 1_000,
    }).run,
    false,
    '常规周期 90 秒内即到时不重复扫',
  );
});

test('★ detectBarShock：以历史 ATR 为基准精准抓 2×ATR 急拉/急砸，过滤常规小波动', () => {
  // 正常横盘小波动不触发
  const calm = makeFlatBars(20, 100, 0.005);
  const calmRes = detectBarShock(calm, 'BTCUSDT');
  assert.ok(calmRes && calmRes.shocked === false);

  // BTC 突然一根 15m 急拉 +1.8%（远超 0.5% 基准 ATR 的 2 倍且 ≥ 1.2%）→ 触发
  const btcPump = makeFlatBars(20, 60_000, 0.005);
  const lastBtc = btcPump[btcPump.length - 1]!;
  lastBtc.close = lastBtc.open * 1.018;
  lastBtc.high = lastBtc.open * 1.02;
  const btcRes = detectBarShock(btcPump, 'BTCUSDT');
  assert.ok(btcRes && btcRes.shocked === true && btcRes.direction === 'up');

  // 山寨币单根只涨 1.5%（低于山寨 2.0% 底线）→ 不触发噪音唤醒
  const altSmall = makeFlatBars(20, 10, 0.005);
  const lastAltSmall = altSmall[altSmall.length - 1]!;
  lastAltSmall.close = lastAltSmall.open * 1.015;
  lastAltSmall.high = lastAltSmall.open * 1.016;
  const altSmallRes = detectBarShock(altSmall, 'SOLUSDT');
  assert.ok(altSmallRes && altSmallRes.shocked === false);

  // 山寨币单根急砸 -3.2% → 触发
  const altDump = makeFlatBars(20, 10, 0.008);
  const lastAltDump = altDump[altDump.length - 1]!;
  lastAltDump.close = lastAltDump.open * 0.968;
  lastAltDump.low = lastAltDump.open * 0.965;
  const altDumpRes = detectBarShock(altDump, 'SOLUSDT');
  assert.ok(altDumpRes && altDumpRes.shocked === true && altDumpRes.direction === 'down');
});

test('★ evaluateAnomalyCandidates：优先级 持仓剧变 > BTC剧变 > 新起爆，且严守冷却与去重', () => {
  const now = 20_000_000;
  const shockedBar: BarShockResult = {
    shocked: true,
    multiple: 3.1,
    movePct: -2.8,
    rangePct: 3.2,
    direction: 'down',
  };

  // 1) 新起爆标的正常命中
  const trig1 = evaluateAnomalyCandidates({
    candidates: [makeCandidate({ symbol: 'MMTUSDT', score: 79 })],
    shockBySymbol: new Map(),
    heldSymbols: new Set(),
    pendingSymbols: new Set(),
    cooldownUntilBySymbol: new Map(),
    nowMs: now,
  });
  assert.ok(trig1 && trig1.kind === 'breakout_ignition' && trig1.symbol === 'MMTUSDT');

  // 2) 同标的在 15m 冷却期内或已挂单 → 不重复唤醒
  const trigCooling = evaluateAnomalyCandidates({
    candidates: [makeCandidate({ symbol: 'MMTUSDT', score: 85 })],
    shockBySymbol: new Map(),
    heldSymbols: new Set(),
    pendingSymbols: new Set(),
    cooldownUntilBySymbol: new Map([['MMTUSDT', now + 5 * 60_000]]),
    nowMs: now,
  });
  assert.equal(trigCooling, null);

  const trigPending = evaluateAnomalyCandidates({
    candidates: [makeCandidate({ symbol: 'MMTUSDT', score: 85 })],
    shockBySymbol: new Map(),
    heldSymbols: new Set(),
    pendingSymbols: new Set(['MMTUSDT']),
    cooldownUntilBySymbol: new Map(),
    nowMs: now,
  });
  assert.equal(trigPending, null);

  // 3) 持仓剧变优先于 BTC 剧变与新起爆
  const trigPriority = evaluateAnomalyCandidates({
    candidates: [makeCandidate({ symbol: 'MMTUSDT', score: 88 })],
    shockBySymbol: new Map([
      ['BTCUSDT', shockedBar],
      ['SOLUSDT', shockedBar],
    ]),
    heldSymbols: new Set(['SOLUSDT']),
    pendingSymbols: new Set(),
    cooldownUntilBySymbol: new Map(),
    nowMs: now,
  });
  assert.ok(trigPriority && trigPriority.kind === 'position_shock' && trigPriority.symbol === 'SOLUSDT');

  // 4) 新 AI500 2.0 标签（蓄势放量突破 / 突破回踩确认）触发起爆唤醒，而带高波动/反砸警示的标的被拦截
  const trigSqueeze = evaluateAnomalyCandidates({
    candidates: [
      makeCandidate({
        symbol: 'SQUEEZEUSDT',
        score: 79,
        tags: ['蓄势放量突破', '1h强势领涨(+3.5%)'],
      }),
    ],
    shockBySymbol: new Map(),
    heldSymbols: new Set(),
    pendingSymbols: new Set(),
    cooldownUntilBySymbol: new Map(),
    nowMs: now,
  });
  assert.ok(trigSqueeze && trigSqueeze.kind === 'breakout_ignition' && trigSqueeze.symbol === 'SQUEEZEUSDT');

  const trigWarnBlocked = evaluateAnomalyCandidates({
    candidates: [
      makeCandidate({
        symbol: 'MANTRAUSDT',
        score: 85,
        tags: ['高波动警示(ATR 5.5%)', '早期放量起爆'],
      }),
    ],
    shockBySymbol: new Map(),
    heldSymbols: new Set(),
    pendingSymbols: new Set(),
    cooldownUntilBySymbol: new Map(),
    nowMs: now,
  });
  assert.equal(trigWarnBlocked, null, '带高波动/反砸警示的标的绝不触发异动唤醒');
});
