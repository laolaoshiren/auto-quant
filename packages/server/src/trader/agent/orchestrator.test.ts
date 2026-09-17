/**
 * 编排层的流程纪律。
 *
 * ## 为什么这些用例存在
 *
 * 这一层是"智能体"能跑起来的地方，也是**最容易静默失效**的地方：
 * 流程少了一步不会报错，只会让系统看起来在自我迭代、实际上没有学到任何东西。
 *
 * 三条纪律各有一个用例把它钉住：
 *  1. 先结算旧实验，再开始新一轮 —— 否则策略师看到的"上次调整"永远没有结果
 *  2. 调参必须落实验记录（含 patch 与 applied 的差异）
 *  3. 任何一步失败都不抛穿 —— 智能体是附加能力，不是交易的前置条件
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultStrategyConfig, STRATEGY_PRESETS, StrategyConfigSchema, type StrategyConfig } from '@aq/shared';

import type { LoopModel } from './loop.js';
import { reviewClosedTrade, runStrategyReview, settlePending, type OrchestratorPorts } from './orchestrator.js';
import type { WakeFacts } from './wake.js';

const config = (): StrategyConfig =>
  StrategyConfigSchema.parse({
    ...defaultStrategyConfig(),
    ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>),
  }) as StrategyConfig;

function makePorts(over: Partial<OrchestratorPorts> = {}) {
  const settled: Array<{ id: number; trades: number; netPnl: number }> = [];
  const experiments: unknown[] = [];
  const runs: unknown[] = [];
  const pauses: string[] = [];
  const savedConfigs: unknown[] = [];
  let current = config();

  const quietFacts = (): Omit<WakeFacts, 'callsThisHour'> => ({
    minutesSinceLastWake: 20,
    newClosedTrades: 0,
    netPnlSinceLastWake: 0,
    losingStreak: 0,
    equityDriftPercent: 0,
    rejectionsSinceLastWake: 0,
    lastDecisionWasNoChange: false,
    hasPosition: false,
    minutesSinceStrategyReview: 5,
  });

  const ports: OrchestratorPorts = {
    readConfig: () => current,
    saveConfig: (next, meta) => {
      current = next;
      savedConfigs.push(meta);
    },
    toolReads: {
      performance: () => ({ net: 0.31 }),
      equityCurve: () => [],
      experiments: () => [],
      recentDecisions: () => [],
      marketOverview: () => [],
    },
    collectFacts: quietFacts,
    callsThisHour: () => 0,
    pendingExperiments: () => [],
    settleExperiment: (id, outcome) => settled.push({ id, ...outcome }),
    recordExperiment: (row) => experiments.push(row),
    recordRun: (row) => runs.push(row),
    requestPause: (reason) => pauses.push(reason),
    ...over,
  };

  return { ports, settled, experiments, runs, pauses, savedConfigs, configNow: () => current, quietFacts };
}

function scripted(replies: string[]): LoopModel {
  let i = 0;
  return {
    complete: async () => {
      const text = replies[i] ?? JSON.stringify({ tool: 'finish', args: { summary: '没有更多要说' } });
      i += 1;
      return { text, usage: { promptTokens: 10, completionTokens: 5 }, latencyMs: 5 };
    },
  };
}

test('没有值得醒的事件时不开跑，且说清为什么没跑', async () => {
  const { ports, runs } = makePorts();
  const r = await runStrategyReview({ ports, model: scripted([]) });

  assert.equal(r.ran, false);
  assert.equal(r.loop, null);
  assert.ok(r.skippedBecause, '必须给出没跑的原因 —— "什么都没发生"和"被挡住了"是两回事');
  assert.match(r.skippedBecause!, /没有值得唤醒/);
  assert.equal(runs.length, 0, '没跑就不该有运行轨迹');
});

test('先结算旧实验，再开始新一轮 —— 否则策略师看到的"上次调整"永远没结果', async () => {
  /*
   * 这一条是「越跑越厉害」能不能成立的前提。
   *
   * 如果新一轮在结算之前开跑，策略师读到的实验历史里，它自己最近那次调整
   * 永远是"还没有结果" —— 那等于让它闭着眼睛调参。
   */
  const order: string[] = [];
  const { ports, quietFacts } = makePorts({
    pendingExperiments: () => [{ id: 7, createdAt: new Date(Date.now() - 3600_000).toISOString(), tradesSince: 9, netPnlSince: -0.4 }],
    settleExperiment: () => order.push('settle'),
    recordRun: () => order.push('run'),
  });

  const r = await runStrategyReview({
    ports,
    model: scripted([JSON.stringify({ tool: 'finish', args: { summary: '看完了' } })]),
    force: true,
    policy: { hourlyBudget: 40, cooldownMinutes: 0, maxIdleMinutes: 60, losingStreakThreshold: 3, equityDriftThresholdPercent: 2, rejectionThreshold: 5 },
  });

  assert.equal(r.ran, true);
  assert.deepEqual(order, ['settle', 'run'], '结算必须发生在这一轮之前');
  assert.ok(quietFacts);
});

test('结果不够笔数的实验不结算 —— 用一两笔判断调参是否有效是在学噪声', () => {
  const { ports, settled } = makePorts({
    pendingExperiments: () => [
      { id: 1, createdAt: new Date().toISOString(), tradesSince: 1, netPnlSince: 5 }, // 笔数不够、时间也不够
      { id: 2, createdAt: new Date().toISOString(), tradesSince: 9, netPnlSince: -0.4 }, // 够了
    ],
  });

  const r = settlePending(ports);

  assert.equal(r.settled, 1, '只该结算够笔数的那一条');
  assert.deepEqual(settled, [{ id: 2, trades: 9, netPnl: -0.4 }]);
});

test('手动触发绕过冷却但不绕过预算', async () => {
  /*
   * 操作员点"立即分析"是明确意图，冷却不该挡它。
   * 但预算挡 —— 一个按钮不该能绕过成本上限。
   */
  const { ports } = makePorts({ callsThisHour: () => 999 });
  const r = await runStrategyReview({
    ports,
    model: scripted([JSON.stringify({ tool: 'finish', args: { summary: 'x' } })]),
    force: true,
  });

  /*
   * 预算满时强度降级为 single，但流程仍然跑 —— 因为**超预算是降级不是拒绝**
   * （见 loop.ts 的 intensityFor）。所以这里断言的是"跑了，但用了廉价档"。
   */
  assert.equal(r.ran, true, '超预算不该让手动触发完全没反应');
  assert.equal(r.intensity, 'single', '但必须降级到廉价档');
});

test('调参通过编排层落到实验记录，且带上 patch 与 applied 的差异', async () => {
  const { ports, experiments, configNow } = makePorts();
  const model = scripted([
    JSON.stringify({
      thought: '先看看过去的调整',
      tool: 'set_params',
      args: { patch: { coinSource: { coinPoolLimit: 6 } }, reason: '候选太多，稀释了注意力' },
    }),
    JSON.stringify({ tool: 'finish', args: { summary: '把候选池缩小了' } }),
  ]);

  const r = await runStrategyReview({
    ports,
    model,
    force: true,
    policy: { hourlyBudget: 40, cooldownMinutes: 0, maxIdleMinutes: 60, losingStreakThreshold: 3, equityDriftThresholdPercent: 2, rejectionThreshold: 5 },
  });

  assert.equal(r.ran, true);
  assert.equal(r.loop?.outcome, 'ok');
  assert.equal(configNow().coinSource.coinPoolLimit, 6, '参数应当真的改掉了');
  /*
   * 关键断言：**配置改了却没有实验记录，等于这次改动不存在。**
   *
   * 下一轮策略师读不到"我上次改了什么、之后发生了什么"，于是它只能闭着眼睛调参 ——
   * 而系统看起来一切正常。所以这里必须断言记录真的被写下了。
   */
  assert.equal(experiments.length, 1, '调参必须留下实验记录，否则「越跑越厉害」的机制是断的');
  const exp = experiments[0] as { reason: string; trigger: string; applied: unknown };
  assert.match(exp.reason, /候选太多/, 'AI 的理由必须原样存档 —— 那是审查这次调参的唯一依据');
  assert.equal(exp.trigger, 'manual');
  assert.match(JSON.stringify(exp.applied), /coinPoolLimit/, 'applied 里必须能看出实际生效的值');
});

test('运行轨迹被落下，且带强度与触发原因', async () => {
  const { ports, runs } = makePorts();
  await runStrategyReview({
    ports,
    model: scripted([JSON.stringify({ tool: 'finish', args: { summary: 'x' } })]),
    force: true,
    policy: { hourlyBudget: 40, cooldownMinutes: 0, maxIdleMinutes: 60, losingStreakThreshold: 3, equityDriftThresholdPercent: 2, rejectionThreshold: 5 },
  });

  assert.equal(runs.length, 1);
  const run = runs[0] as { kind: string; trigger: string; intensity: string };
  assert.equal(run.kind, 'strategy');
  assert.equal(run.trigger, 'manual');
  assert.ok(['single', 'panel'].includes(run.intensity));
});

/* -------------------------------------------------------------------------- */
/*  复盘                                                                       */
/* -------------------------------------------------------------------------- */

test('复盘写入记忆，并把决策质量一起打进标签', async () => {
  /*
   * 一笔好决策可能亏钱、一笔坏决策可能赚钱。决策质量不标出来的话，
   * 记忆里会积累"这样做亏过"这种错误教训 —— 而它们以后会被检索出来误导决策。
   */
  const saved: Array<{ lesson: string; tags: string[] }> = [];
  const model = scripted([
    JSON.stringify({
      lesson: '在 1H 下跌趋势里逆势做多，入场点距 15M 阻力位过近。',
      decisionQuality: 'bad',
      outcomeMatchedQuality: true,
      tags: ['逆势', '追高'],
    }),
  ]);

  const r = await reviewClosedTrade({
    model,
    trade: { symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -0.31 },
    facts: '行情：1H 下跌',
    save: (m) => saved.push({ lesson: m.lesson, tags: m.tags }),
  });

  assert.equal(r.ok, true);
  assert.equal(saved.length, 1);
  assert.match(saved[0]!.lesson, /逆势做多/);
  assert.ok(saved[0]!.tags.includes('逆势'));
  assert.ok(
    saved[0]!.tags.some((t) => t.includes('决策质量:bad')),
    '决策质量必须进标签 —— 否则记忆里分不出"决策错"和"运气差"',
  );
});

test('复盘失败不抛穿 —— 它是附加能力，不是交易的前置条件', async () => {
  const model: LoopModel = {
    complete: async () => {
      throw new Error('模型服务挂了');
    },
  };

  const r = await reviewClosedTrade({
    model,
    trade: { symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -0.31 },
    facts: '',
    save: () => assert.fail('失败时不该写记忆'),
  });

  assert.equal(r.ok, false, '失败要被如实报告');
  assert.ok(r.error);
  // 关键：没有抛异常
});

test('复盘输出缺 lesson 时不算成功', async () => {
  const model = scripted([JSON.stringify({ tags: ['x'] })]);
  const r = await reviewClosedTrade({
    model,
    trade: { symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -0.31 },
    facts: '',
    save: () => assert.fail('没有 lesson 时不该写记忆'),
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /lesson/);
});
