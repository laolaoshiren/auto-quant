/**
 * `applyAgentPatch()` 的守卫测试。
 *
 * ## 为什么这些用例存在
 *
 * AI 的补丁是**不可信输入**。这里的每一条都对应一种"它会怎么错"：
 * 坏 JSON、未知字段、越界值、以及（最危险）试图关掉"没有止损不开仓"。
 *
 * 守卫一旦失效，**后果不是"收益率变差"，而是账户可以在几秒内被清空**，
 * 所以这些边界值得逐个钉住，而不是靠"它一般不会这么干"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultStrategyConfig,
  STRATEGY_PRESETS,
  StrategyConfigSchema,
  type StrategyConfig,
} from '@aq/shared';

import { applyAgentPatch } from './patch.js';

/*
 * ⚠️ 夹具必须**过一遍 zod**。
 *
 * 直觉写法 `{...defaultStrategyConfig(), ...preset.patch}` 是错的：那是浅展开，
 * preset 里的 `coinSource` 是个部分对象，会**整个替换**掉默认的 `coinSource`，
 * 于是它没提到的字段丢了、由 schema 默认值补齐 —— 而 schema 默认值不等于
 * `defaultStrategyConfig()` 的值（实测 minOpenInterestUsd 5000000 vs 10000000）。
 *
 * 那样构出来的"配置"不是任何真实配置。真实代码里 `strategies.get()` 也会把
 * 读出来的配置重新过一遍 schema（§5.4），所以夹具照做才是同一回事。
 */
const base = (): StrategyConfig =>
  StrategyConfigSchema.parse({
    ...defaultStrategyConfig(),
    ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>),
  }) as StrategyConfig;

test('合法补丁被原样接受，且不产生任何钳制记录', () => {
  const current = base();
  const target = { ...current, coinSource: { ...current.coinSource, coinPoolLimit: 8 } };

  const result = applyAgentPatch(current, { coinSource: { coinPoolLimit: 8 } });

  assert.equal(result.rejected, null);
  assert.deepEqual(result.clamps, [], '没有越界就不应产生钳制记录');
  assert.equal(result.config.coinSource.coinPoolLimit, 8);
  assert.deepEqual(result.config, target, '其余字段必须保持不变');
});

/*
 * 只改一个字段时，**同级的其他字段一个都不能丢**。
 *
 * 这条是实测撞出来的：守卫最早写的是 `{ ...current, ...known }`（浅展开），
 * 于是 `{ coinSource: { coinPoolLimit: 8 } }` 这样的补丁会把整个 `coinSource`
 * 替换掉，同层没提到的字段被 zod 用 schema 默认值补齐 ——
 * 实测**一次补丁重置了 7 个字段**：
 *
 *     sourceType       mixed   → static
 *     staticCoins      [BTC,ETH] → []
 *     useCoinPool      true    → false
 *     useOITop         true    → false
 *     minQuoteVolume24h 100M   → 50M
 *     minOpenInterestUsd 10M   → 5M
 *
 * 这个 bug 的可怕之处是**它看起来完全成功**：AI 以为自己只调了一个参数，
 * 而实际上它把选币策略整个换掉了，然后基于错误的前提继续推理下一轮。
 *
 * 所以这里不比对"结果等于我手工构造的对象"（那太脆），
 * 而是**逐个断言同层字段保持了调用前的值**。
 */
test('深层补丁只改它提到的字段，同层其余字段必须原封不动', () => {
  const current = base();
  const before = structuredClone(current);

  const result = applyAgentPatch(current, { coinSource: { coinPoolLimit: 6 } });

  assert.equal(result.rejected, null);
  assert.equal(result.config.coinSource.coinPoolLimit, 6);
  for (const key of Object.keys(before.coinSource) as Array<keyof typeof before.coinSource>) {
    if (key === 'coinPoolLimit') continue;
    assert.deepEqual(
      result.config.coinSource[key],
      before.coinSource[key],
      `coinSource.${String(key)} 被意外改动了 —— 浅展开的老 bug 会让它回落到 schema 默认值`,
    );
  }
  assert.deepEqual(result.config.riskControl, before.riskControl, '没提到的整块也不得变动');
  assert.deepEqual(result.config.throttle, before.throttle);
});
test('未知字段被丢弃：配置的形状由 schema 决定，不由模型决定', () => {
  const current = base();

  const result = applyAgentPatch(current, {
    coinSource: { coinPoolLimit: 7, 我编的字段: 'x' },
    整个乱写的顶层字段: { a: 1 },
  });

  assert.equal(result.rejected, null);
  assert.equal(result.config.coinSource.coinPoolLimit, 7);
  assert.ok(!('整个乱写的顶层字段' in result.config), '未知顶层字段不得进入配置');
  assert.ok(
    !('我编的字段' in result.config.coinSource),
    '未知嵌套字段不得进入配置',
  );
});

test('结构性不变量：requireStopLoss 被强制为真，并如实记录', () => {
  const current = base();
  assert.equal(current.riskControl.requireStopLoss, true, '前提：默认就是真');

  const result = applyAgentPatch(current, { riskControl: { requireStopLoss: false } });

  assert.equal(result.config.riskControl.requireStopLoss, true, '必须被按回真');
  assert.equal(result.clamps.length, 1);
  assert.equal(result.clamps[0]!.field, 'riskControl.requireStopLoss');
  assert.equal(result.clamps[0]!.asked, false, '要记下 AI 想要什么 —— 只记生效值就无法审查');
  assert.equal(result.clamps[0]!.allowed, true);
  assert.ok(result.clamps[0]!.why.length > 10, '钳制理由必须能读懂，它会回喂给 AI');
});

test('熔断阈值可以被 AI 调 —— 它是策略工具，不再是安全网', () => {
  const current = base();

  /*
   * 这一条**故意**断言允许调高。
   *
   * 最初的设计是"用户设上限、AI 只能在上限内调"，产品方最终选择完全交给 AI。
   * 于是熔断阈值降级为策略工具（AI 可以用它主动停手防上头），
   * 真正的安全网搬到 `StrategyConfig` 之外的账户级紧急刹车。
   *
   * 如果哪天有人把熔断也塞进 STRUCTURAL_INVARIANTS，这个用例会红 ——
   * 那时要问的是"紧急刹车还在不在"，而不是把用例改掉。
   */
  const result = applyAgentPatch(current, { circuitBreaker: { maxDailyLossPercent: 25 } });

  assert.equal(result.rejected, null);
  assert.equal(result.config.circuitBreaker.maxDailyLossPercent, 25);
  assert.deepEqual(result.clamps, []);
});

test('越界值得整体拒绝，而不是部分生效', () => {
  const current = base();

  // 杠杆上限由 schema 钉在 125；同时改一个合法字段，用来证明"合法的那个也没生效"。
  const result = applyAgentPatch(current, {
    riskControl: { btcEthMaxLeverage: 9999 },
    coinSource: { coinPoolLimit: 8 },
  });

  assert.notEqual(result.rejected, null, '越界必须被拒绝');
  assert.equal(
    result.config.coinSource.coinPoolLimit,
    current.coinSource.coinPoolLimit,
    '整份拒绝时，合法字段也不得生效 —— 部分生效会让 AI 以为自己改成了它',
  );
  assert.deepEqual(result.config, current, 'rejected 时配置必须与传入的完全一致');
});

test('补丁不是对象 / 是数组时被拒绝，且不抛异常', () => {
  const current = base();

  for (const bad of [null, undefined, 42, 'open_long', [], true]) {
    const result = applyAgentPatch(current, bad);
    assert.notEqual(result.rejected, null, `${JSON.stringify(bad)} 应被拒绝`);
    assert.deepEqual(result.config, current, `${JSON.stringify(bad)} 不得改动配置`);
  }
});

test('空补丁是合法的：AI 有权决定"这轮什么都不改"', () => {
  const current = base();

  const result = applyAgentPatch(current, {});

  assert.equal(result.rejected, null, '空对象不是错误 —— 「不动」是一个正当结论');
  assert.deepEqual(result.config, current);
  assert.deepEqual(result.clamps, []);
});

test('未提及的字段继承当前值（补丁是增量，不是整份替换）', () => {
  const current = base();
  current.riskControl.minConfidence = 71;
  current.throttle.maxEntriesPerHour = 4;

  const result = applyAgentPatch(current, { coinSource: { coinPoolLimit: 5 } });

  assert.equal(result.rejected, null);
  assert.equal(result.config.riskControl.minConfidence, 71, '没提到的字段必须保持原值');
  assert.equal(result.config.throttle.maxEntriesPerHour, 4);
  assert.equal(result.config.coinSource.coinPoolLimit, 5);
});
