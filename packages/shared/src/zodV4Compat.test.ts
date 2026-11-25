import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StrategyConfigSchema,
  defaultStrategyConfig,
  resolvePreset,
} from './strategy.js';

test('★★★ Zod v4 嵌套对象 .prefault({}) 在空对象与历史部分 JSON 下都能补齐深层默认值', () => {
  const empty = StrategyConfigSchema.parse({});
  assert.equal(empty.coinSource.sourceType, 'static');
  assert.deepEqual(empty.coinSource.staticCoins, []);
  assert.equal(empty.indicators.kline.primaryTimeframe, '5m');
  assert.equal(empty.indicators.kline.promptPoints, 30);
  assert.equal(empty.riskControl.maxPositions, 3);
  assert.equal(empty.riskControl.marginMode, 'isolated');
  assert.equal(empty.drawdownGuard.enabled, true);
  assert.equal(empty.throttle.minHoldMinutes, 3);
  assert.equal(empty.circuitBreaker.maxDailyLossPercent, 5);
  assert.equal(empty.promptSections.roleDefinition, '');

  /* 历史数据库行：只有部分分区，缺少新字段与 kline/drawdownGuard/promptSections */
  const legacyDbJson = {
    name: '老实盘策略',
    riskControl: { maxPositions: 4, btcEthMaxLeverage: 8 },
    indicators: { enableEma: false },
  };
  const parsed = StrategyConfigSchema.parse(legacyDbJson);
  assert.equal(parsed.name, '老实盘策略');
  assert.equal(parsed.riskControl.maxPositions, 4);
  assert.equal(parsed.riskControl.btcEthMaxLeverage, 8);
  assert.equal(parsed.riskControl.requireStopLoss, true);
  assert.equal(parsed.indicators.enableEma, false);
  assert.equal(parsed.indicators.kline.primaryCount, 60);
  assert.equal(parsed.drawdownGuard.givebackRatio, 0.5);
  assert.equal(parsed.coinSource.excludeStablecoins, false);

  /* 每次 parse 必须返回独立对象/数组实例，避免共享可变默认引用 */
  const a = StrategyConfigSchema.parse({});
  const b = StrategyConfigSchema.parse({});
  a.coinSource.staticCoins.push('BTCUSDT');
  assert.deepEqual(b.coinSource.staticCoins, []);

  /* 默认策略工厂与预设解析保持正常 */
  const def = defaultStrategyConfig();
  assert.ok(def.coinSource.staticCoins.length > 0);
  const cons = resolvePreset('conservative');
  assert.equal(cons.riskControl.breakevenTriggerPercent, 8);
});
