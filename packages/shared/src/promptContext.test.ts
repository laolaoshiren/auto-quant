import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPromptPositionContext } from './promptContext.js';

test('extractPromptPositionContext parses managed 2.0 tactical position line', () => {
  const prompt = [
    '## 候选行情',
    '- BTCUSDT 现价 61541.20 (+0.46%) 15m RSI 54',
    '## 当前持仓',
    '- **BTCUSDT 多 10x** | 持仓 2h · 均价 61,330.00 · 浮盈 +0.34% · SL=60,970.00 · TP=62,400.00',
  ].join('\n');

  const ctx = extractPromptPositionContext(prompt, 'btcusdt');
  assert.deepEqual(ctx, {
    entryPrice: 61330,
    previousStopLoss: 60970,
    previousTakeProfit: 62400,
  });
});

test('extractPromptPositionContext parses explicit none/无 SL and TP values as null', () => {
  const prompt = '- **ETHUSDT 空 5x** | 开仓价: $3200.5 · 止损: 无 · 止盈: none';
  const ctx = extractPromptPositionContext(prompt, 'ETHUSDT');
  assert.deepEqual(ctx, {
    entryPrice: 3200.5,
    previousStopLoss: null,
    previousTakeProfit: null,
  });
});

test('extractPromptPositionContext ignores market lines without position markers', () => {
  const prompt = '- SOLUSDT 现价 152.30 24h +5.2% 成交额 1.2B';
  assert.equal(extractPromptPositionContext(prompt, 'SOLUSDT'), null);
});

test('extractPromptPositionContext handles empty inputs safely', () => {
  assert.equal(extractPromptPositionContext(null, 'BTCUSDT'), null);
  assert.equal(extractPromptPositionContext('BTCUSDT 均价 100', ''), null);
});
