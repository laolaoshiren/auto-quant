import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateTokenCost, resolveFallbackTokenPricing } from '@aq/shared';
import { initDb, getDb } from '../db/index.js';
import { aiModels, decisions as decisionStore, traders as traderStore } from './repositories.js';

initDb(':memory:');

test('★ decisionStore.tokenUsageStats 正确汇总全量与按时间过滤的 Token 用量并钳制异常缓存值', () => {
  const model = aiModels.create({
    label: 'billing-test-model',
    provider: 'deepseek',
    model: 'workbuddy/deepseek-v4.1-flash',
    apiKeyEnc: '',
    baseUrl: 'https://example.invalid/v1',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 0,
  });
  const trader = traderStore.create({
    name: 'billing-test-bot',
    mode: 'ai_managed',
    dryRun: true,
    exchangeAccountId: null,
    aiModelId: model.id,
    strategyId: null,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
    paperStartingBalance: 100,
  });

  // 昨天一轮
  const id1 = decisionStore.log({
    traderId: trader.id,
    cycleNumber: 1,
    systemPrompt: 'sys',
    userPrompt: 'usr',
    cotTrace: 'cot',
    decisions: [],
    rawResponse: '',
    executionLog: [],
    candidateSymbols: [],
    success: true,
    error: null,
    aiLatencyMs: 20_000,
    promptTokens: 30_000,
    completionTokens: 3_000,
    cachedTokens: 15_000,
    reasoningTokens: 1_000,
  });
  getDb().run('UPDATE decision_records SET timestamp = ? WHERE id = ?', '2026-11-25T10:00:00.000Z', id1);

  // 今天一轮（故意测试 cachedTokens > promptTokens 的钳制）
  const id2 = decisionStore.log({
    traderId: trader.id,
    cycleNumber: 2,
    systemPrompt: 'sys',
    userPrompt: 'usr',
    cotTrace: 'cot',
    decisions: [],
    rawResponse: '',
    executionLog: [],
    candidateSymbols: [],
    success: true,
    error: null,
    aiLatencyMs: 25_000,
    promptTokens: 40_000,
    completionTokens: 4_000,
    cachedTokens: 45_000,
    reasoningTokens: 2_000,
  });
  getDb().run('UPDATE decision_records SET timestamp = ? WHERE id = ?', '2026-11-26T02:00:00.000Z', id2);

  // 今天一轮无用量回传（如报错/熔断跳过）
  const id3 = decisionStore.log({
    traderId: trader.id,
    cycleNumber: 3,
    systemPrompt: 'sys',
    userPrompt: 'usr',
    cotTrace: 'cot',
    decisions: [],
    rawResponse: '',
    executionLog: [],
    candidateSymbols: [],
    success: false,
    error: 'timeout',
    aiLatencyMs: 5_000,
    promptTokens: null,
    completionTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  });
  getDb().run('UPDATE decision_records SET timestamp = ? WHERE id = ?', '2026-11-26T03:00:00.000Z', id3);

  const all = decisionStore.tokenUsageStats(trader.id);
  assert.equal(all.totalCycles, 3);
  assert.equal(all.meteredCycles, 2);
  assert.equal(all.promptTokens, 70_000);
  assert.equal(all.cachedTokens, 55_000, '第 2 轮 cachedTokens 45,000 必须钳制到 40,000 → 15,000 + 40,000');
  assert.equal(all.completionTokens, 7_000);
  assert.equal(all.reasoningTokens, 3_000);

  const today = decisionStore.tokenUsageStats(trader.id, '2026-11-25T16:00:00.000Z');
  assert.equal(today.totalCycles, 2);
  assert.equal(today.meteredCycles, 1);
  assert.equal(today.promptTokens, 40_000);
  assert.equal(today.cachedTokens, 40_000);

  const pricing = resolveFallbackTokenPricing(model.model);
  assert.ok(pricing);
  const allCost = calculateTokenCost(all, pricing);
  assert.ok(allCost.totalCostUsd > 0);
});
