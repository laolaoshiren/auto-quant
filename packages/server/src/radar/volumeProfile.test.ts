/**
 * M2.2 单元测试：筹码结构（POC / VA / 支撑阻力墙）与清算簇代理引擎（`radar/volumeProfile.ts`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Kline } from '@aq/shared';

import { computeVolumeProfile, formatVolumeProfileLine } from './volumeProfile.js';

function bar(
  idx: number,
  open: number,
  high: number,
  low: number,
  close: number,
  quoteVolume: number,
): Kline {
  return {
    openTime: Date.UTC(2026, 10, 24, 0, 0, 0) + idx * 15 * 60_000,
    closeTime: Date.UTC(2026, 10, 24, 0, 15, 0) + idx * 15 * 60_000 - 1,
    open,
    high,
    low,
    close,
    volume: quoteVolume / close,
    quoteVolume,
    trades: 50,
    takerBuyBase: (quoteVolume / close) * 0.5,
    takerBuyQuote: quoteVolume * 0.5,
  };
}

test('★ M2.2 POC 精准落在最大成交额价格带，且 VA 包含 POC 并准确输出上下筹码墙与清算磁吸', () => {
  const klines: Kline[] = [];
  // 在 100 附近密集换手（POC 应落在 100 附近）
  for (let i = 0; i < 20; i += 1) {
    klines.push(bar(i, 99.6, 100.4, 99.4, 100.2, 5_000_000));
  }
  // 下方 92 有一道次高支撑墙
  for (let i = 20; i < 26; i += 1) {
    klines.push(bar(i, 91.7, 92.4, 91.5, 92.2, 3_500_000));
  }
  // 上方 108 有一道阻力墙
  for (let i = 26; i < 32; i += 1) {
    klines.push(bar(i, 107.6, 108.4, 107.4, 108.1, 3_200_000));
  }
  // 过渡小成交量 K 线，当前现价 103
  for (let i = 32; i < 38; i += 1) {
    klines.push(bar(i, 102.5, 103.5, 102.0, 103.0, 400_000));
  }

  const vp = computeVolumeProfile(klines, 103.0);
  assert.ok(vp, '应成功产出筹码结构');
  assert.ok(Math.abs(vp.poc - 100) <= 1.2, `POC 应在 100 附近，实际 ${vp.poc}`);
  assert.ok(vp.val <= vp.poc && vp.poc <= vp.vah, 'VA 区间必须包含 POC');
  assert.ok(vp.pocOffsetPct < 0, 'POC(100) 在现价(103) 下方，偏移应为负');
  assert.ok(vp.upperWall && vp.upperWall.price > 106, `上阻力墙应在 108 附近，实际 ${vp.upperWall?.price}`);
  assert.ok(vp.lowerWall && vp.lowerWall.price < 101, `下支撑墙应在 100 附近，实际 ${vp.lowerWall?.price}`);
  assert.ok(vp.nearestShortLiq && vp.nearestShortLiq.offsetPct > 0);
  assert.ok(vp.nearestLongLiq && vp.nearestLongLiq.offsetPct < 0);

  const line = formatVolumeProfileLine(vp);
  assert.match(line, /POC/);
  assert.match(line, /VA\[/);
  assert.match(line, /上阻力墙/);
  assert.match(line, /下支撑墙/);
  assert.match(line, /磁吸/);
});

test('★ M2.2 边界防御：少于 3 根返回 null；纯平盘不产生 NaN', () => {
  assert.equal(computeVolumeProfile([bar(0, 10, 11, 9, 10, 1000)]), null);

  const flat = [
    bar(0, 50, 50, 50, 50, 1000),
    bar(1, 50, 50, 50, 50, 1000),
    bar(2, 50, 50, 50, 50, 1000),
  ];
  const vp = computeVolumeProfile(flat, 50);
  assert.ok(vp);
  assert.equal(vp.poc, 50);
  assert.equal(vp.pocOffsetPct, 0);
  assert.equal(vp.pricePosition, 'inside_va');
});
