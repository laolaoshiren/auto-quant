import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateTokenCost,
  fmtCompactTokens,
  fmtTokenCostUsd,
  formatCycleCostTooltip,
  resolveFallbackTokenPricing,
} from './tokenBilling.js';

test('★ calculateTokenCost 精确拆算未缓存输入、缓存命中、输出费用与缓存节省额', () => {
  const pricing = {
    input: 0.15,
    cacheRead: 0.003,
    output: 0.6,
    source: 'models.dev (deepseek-v4.1-flash)',
  };
  const cost = calculateTokenCost(
    {
      promptTokens: 40_000,
      cachedTokens: 24_000,
      completionTokens: 4_000,
      reasoningTokens: 1_800,
    },
    pricing,
  );

  assert.equal(cost.uncachedInputTokens, 16_000);
  assert.equal(cost.cachedTokens, 24_000);
  assert.ok(Math.abs(cost.inputCostUsd - 0.0024) < 1e-9);
  assert.ok(Math.abs(cost.cacheCostUsd - 0.000072) < 1e-9);
  assert.ok(Math.abs(cost.outputCostUsd - 0.0024) < 1e-9);
  assert.ok(Math.abs(cost.totalCostUsd - 0.004872) < 1e-9);
  assert.ok(Math.abs(cost.savedByCacheUsd - 0.003528) < 1e-9);

  const tip = formatCycleCostTooltip(cost, pricing);
  assert.ok(tip.includes('未缓存输入'));
  assert.ok(tip.includes('缓存省'));
  assert.ok(tip.includes('models.dev'));
});

test('★ cachedTokens 超出 promptTokens 时自动钳制，不产生负数输入费用', () => {
  const cost = calculateTokenCost(
    { promptTokens: 1_000, cachedTokens: 5_000, completionTokens: 200 },
    { input: 1.0, cacheRead: 0.1, output: 4.0, source: 'test' },
  );
  assert.equal(cost.uncachedInputTokens, 0);
  assert.equal(cost.cachedTokens, 1_000);
  assert.equal(cost.inputCostUsd, 0);
  assert.ok(Math.abs(cost.totalCostUsd - 0.0009) < 1e-9);
});

test('★ resolveFallbackTokenPricing 与金额/token 格式化', () => {
  const ds = resolveFallbackTokenPricing('workbuddy/deepseek-v4.1-flash');
  assert.ok(ds);
  assert.equal(ds.input, 0.15);
  assert.equal(ds.output, 0.6);

  const free = resolveFallbackTokenPricing('opencode-zen-free/kimi-free');
  assert.ok(free?.free);
  assert.equal(free?.input, 0);

  assert.equal(resolveFallbackTokenPricing('unknown-custom-xyz'), null);

  assert.equal(fmtTokenCostUsd(0.004872, { approx: true }), '~$0.0049');
  assert.equal(fmtTokenCostUsd(0.428, { approx: true }), '~$0.428');
  assert.equal(fmtTokenCostUsd(1.256, { approx: true }), '~$1.26');
  assert.equal(fmtTokenCostUsd(0), '$0.00');
  assert.equal(fmtCompactTokens(39_697), '39.7K');
  assert.equal(fmtCompactTokens(5_240_000), '5.24M');
});
