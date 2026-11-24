/**
 * M2.3 单元测试：15 分钟环比增量追踪器（`radar/deltaTracker.ts`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeRadarDelta,
  formatRadarDeltaLine,
  RadarDeltaTracker,
  type RadarSnapshotPoint,
} from './deltaTracker.js';

test('★ M2.3 首轮基准 → 15m 加速 → 15m 退潮 → 方向反转 → 超时重置', () => {
  const tracker = new RadarDeltaTracker(90 * 60_000);
  const t0 = Date.UTC(2026, 10, 24, 10, 0, 0);

  const p0: RadarSnapshotPoint = {
    symbol: 'SOLUSDT',
    timestampMs: t0,
    score: 70,
    bias: 'long',
    price: 150,
    openInterestUsd: 200_000_000,
    takerBuyRatio1h: 0.54,
    pocOffsetPct: -0.8,
  };
  const d0 = tracker.observe(p0);
  assert.equal(d0.state, 'initial');
  assert.equal(d0.scoreDelta, null);
  assert.match(formatRadarDeltaLine(d0), /首轮观测/);

  // 15m 后加速走强
  const d1 = tracker.observe({
    ...p0,
    timestampMs: t0 + 15 * 60_000,
    score: 79,
    price: 153,
    openInterestUsd: 206_000_000,
    takerBuyRatio1h: 0.6,
    pocOffsetPct: -1.6,
  });
  assert.equal(d1.state, 'accelerating');
  assert.equal(d1.elapsedMinutes, 15);
  assert.equal(d1.scoreDelta, 9);
  assert.equal(d1.priceDeltaPct, 2);
  assert.equal(d1.oiDeltaPct, 3);
  assert.equal(d1.takerBuyDeltaPp, 6);
  const line1 = formatRadarDeltaLine(d1);
  assert.match(line1, /AI500 \+9\(加速\)/);
  assert.match(line1, /OI \+3\.00%/);
  assert.match(line1, /Taker买比 \+6\.0pp/);

  // 再过 15m 动能退潮
  const d2 = tracker.observe({
    ...p0,
    timestampMs: t0 + 30 * 60_000,
    score: 71,
    price: 152,
    openInterestUsd: 201_000_000,
    takerBuyRatio1h: 0.51,
    pocOffsetPct: -0.9,
  });
  assert.equal(d2.state, 'fading');
  assert.equal(d2.scoreDelta, -8);

  // 方向反转
  const d3 = tracker.observe({
    ...p0,
    timestampMs: t0 + 45 * 60_000,
    score: 74,
    bias: 'short',
    price: 147,
    openInterestUsd: 204_000_000,
    takerBuyRatio1h: 0.4,
    pocOffsetPct: 1.2,
  });
  assert.equal(d3.state, 'reversing');
  assert.equal(d3.biasChanged, true);

  // 超过 90m 断档后应重置为首轮基准，不输出陈旧增量
  const d4 = computeRadarDelta(tracker.peek('SOLUSDT'), {
    ...p0,
    timestampMs: t0 + 200 * 60_000,
    score: 80,
  });
  assert.equal(d4.state, 'initial');
  assert.equal(d4.scoreDelta, null);
});
