/**
 * 工具循环的边界。
 *
 * ## 为什么这些用例存在
 *
 * 循环是会**失控**的那种东西：不设上限就一直烧钱（实测单次决策约 5.8 万 tokens），
 * 而静默停下则会让上游把半成品当成完整结论。所以这里钉的全是**边界**：
 * 不收敛、坏输出、工具报错、以及"停下时有没有说清为什么"。
 *
 * 用一个记账的桩模型，不碰网络也不碰数据库。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultStrategyConfig, STRATEGY_PRESETS, StrategyConfigSchema, type StrategyConfig } from '@aq/shared';

import { intensityFor, runSingleShot, runToolLoop, type LoopModel } from './loop.js';
import type { AgentToolDeps } from './tools.js';

const config = (): StrategyConfig =>
  StrategyConfigSchema.parse({
    ...defaultStrategyConfig(),
    ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>),
  }) as StrategyConfig;

function makeDeps() {
  const pauses: string[] = [];
  let current = config();
  const deps: AgentToolDeps = {
    currentConfig: () => current,
    saveConfig: (next) => {
      current = next;
    },
    read: {
      performance: () => ({ net: 0.31 }),
      equityCurve: () => [{ equity: 10 }],
      experiments: () => [{ reason: '上次降杠杆', outcomeNetPnl: 0.5 }],
      recentDecisions: () => [{ cycle: 1 }],
      marketOverview: () => [{ symbol: 'BTCUSDT' }],
    },
    requestPause: (reason) => pauses.push(reason),
  };
  return { deps, pauses };
}

/** 按脚本逐轮回复的桩模型；脚本用完后再被调用会抛错（用来发现意外的额外调用）。 */
function scripted(replies: string[]): { model: LoopModel; calls: () => number } {
  let i = 0;
  const model: LoopModel = {
    complete: async () => {
      const text = replies[i];
      i += 1;
      if (text === undefined) throw new Error(`桩模型被调用了第 ${i} 次，但脚本只有 ${replies.length} 条`);
      return { text, usage: { promptTokens: 100, completionTokens: 20 }, latencyMs: 10 };
    },
  };
  return { model, calls: () => i };
}

const turn = (tool: string, args: unknown = {}, thought = '因为') =>
  JSON.stringify({ thought, tool, args });

test('模型调用 finish 时以 ok 结束，并带出结论', async () => {
  const { deps } = makeDeps();
  const { model, calls } = scripted([turn('finish', { summary: '这轮什么都不改' })]);

  const r = await runToolLoop({ role: 'strategist', task: '审视参数', facts: '绩效：净 +0.31', deps, model });

  assert.equal(r.outcome, 'ok');
  assert.equal(r.conclusion, '这轮什么都不改');
  assert.equal(calls(), 1, 'finish 之后不得再调模型 —— 那是纯粹的浪费');
  assert.equal(r.steps.length, 1);
});

test('不收敛时撞上限，标记 degraded 且**明确说没有结论**', async () => {
  /*
   * 这一条是整份文件里最重要的。
   *
   * `degraded` 与 `ok` 必须分开：前者是"被我们截断了，没有结论"，
   * 后者是"模型说完了，这是结论"。混成同一个 ok，会让一个截断的半成品
   * 被上游当成完整判断去用 —— 而那是一个**静默的**错误。
   */
  const { deps } = makeDeps();
  const { model, calls } = scripted([
    turn('get_performance', { window: '24h' }),
    turn('get_performance', { window: '7d' }),
    turn('get_performance', { window: '30d' }),
  ]);

  const r = await runToolLoop({ role: 'strategist', task: 'x', facts: 'y', deps, model, maxSteps: 3 });

  assert.equal(r.outcome, 'degraded', '撞上限不是成功');
  assert.equal(r.conclusion, null, 'degraded 时不得有结论');
  assert.match(r.detail, /上限/, '必须说清为什么停');
  assert.match(r.detail, /没有结论/, '必须明说没有结论，不能只说"达到上限"');
  assert.equal(calls(), 3, '不得超出上限多调一次');
  assert.equal(r.steps.length, 3);
});

test('模型输出坏掉时宽容一次，第二次失败', async () => {
  const { deps } = makeDeps();
  const { model, calls } = scripted(['我不是 JSON', '我还是不是 JSON', turn('finish', { summary: 'x' })]);

  const r = await runToolLoop({ role: 'trader', task: 'x', facts: 'y', deps, model, maxSteps: 5 });

  assert.equal(r.outcome, 'failed');
  assert.equal(calls(), 2, '坏输出只宽容一次 —— 否则会变成一个不收敛的循环');
  assert.match(r.detail, /无法解析|可解析/, '必须说清失败原因');
});

test('坏输出之后给回纠正提示，模型能自己改对', async () => {
  const { deps } = makeDeps();
  const { model } = scripted(['```\n模型忘了输出 JSON\n```', turn('finish', { summary: '改对了' })]);

  const r = await runToolLoop({ role: 'reviewer', task: 'x', facts: 'y', deps, model, maxSteps: 4 });

  assert.equal(r.outcome, 'ok', '宽容一次是为了让它自我纠正，纠正了就该成功');
  assert.equal(r.conclusion, '改对了');
});

test('工具参数不合格时把错误回喂，循环继续（模型可以自己改对）', async () => {
  /*
   * 参数错误是**可恢复的**：把问题原样回喂，模型下一轮通常能改对。
   * 让它整轮失败会浪费掉前面所有工具调用的价值。
   */
  const { deps } = makeDeps();
  const { model } = scripted([
    turn('get_experiments', { limit: 99999 }),
    turn('finish', { summary: '改小了 limit 之后看完了' }),
  ]);

  const r = await runToolLoop({ role: 'strategist', task: 'x', facts: 'y', deps, model, maxSteps: 4 });

  assert.equal(r.outcome, 'ok');
  assert.match(JSON.stringify(r.steps[0]!.result), /不得大于/, '第一步的结果里应当带着参数错误');
});

test('未知工具名被回喂而不是让循环崩掉', async () => {
  const { deps } = makeDeps();
  const { model } = scripted([turn('get_profitability', {}), turn('finish', { summary: '改用正确的工具名' })]);

  const r = await runToolLoop({ role: 'performance_analyst', task: 'x', facts: 'y', deps, model, maxSteps: 4 });

  assert.equal(r.outcome, 'ok');
  assert.match(JSON.stringify(r.steps[0]!.result), /没有名为/, '必须点名它写错的那个工具');
});

test('循环把 thought 一起留档 —— 那是"它当时为什么调这个工具"的唯一依据', async () => {
  const { deps } = makeDeps();
  const { model } = scripted([
    turn('get_performance', { window: '24h' }, '先看最近一天是赚是亏'),
    turn('finish', { summary: 'x' }),
  ]);

  const r = await runToolLoop({ role: 'strategist', task: 'x', facts: 'y', deps, model, maxSteps: 4 });

  assert.equal(r.steps[0]!.thought, '先看最近一天是赚是亏');
  assert.equal(r.steps[0]!.tool, 'get_performance');
});

test('token 与延迟被累加（预算是硬约束，不能估）', async () => {
  const { deps } = makeDeps();
  const { model } = scripted([
    turn('get_performance', { window: '24h' }),
    turn('get_equity_curve', {}),
    turn('finish', { summary: 'x' }),
  ]);

  const r = await runToolLoop({ role: 'strategist', task: 'x', facts: 'y', deps, model, maxSteps: 5 });

  assert.equal(r.tokensIn, 300, '三次调用各 100 输入 token');
  assert.equal(r.tokensOut, 60);
  assert.equal(r.latencyMs, 30, '延迟也要累加 —— 它是"这一轮花了多久"的唯一来源');
});

/* -------------------------------------------------------------------------- */
/*  单次调用档                                                                 */
/* -------------------------------------------------------------------------- */

test('单次调用：直接给结论，不给工具', async () => {
  const { deps } = makeDeps();
  const { model } = scripted([JSON.stringify({ state: '亏损中', sampleAdequate: false })]);

  const r = await runSingleShot({ role: 'performance_analyst', task: 'x', facts: 'y', deps, model });

  assert.equal(r.outcome, 'ok');
  assert.match(r.conclusion ?? '', /sampleAdequate/, '结构化结论必须原样带出来');
  assert.equal(r.steps.length, 0, '单次调用不产生工具步骤');
});

test('单次调用输出坏掉时标记 failed，不编造结论', async () => {
  const { deps } = makeDeps();
  const { model } = scripted(['我无法判断。']);

  const r = await runSingleShot({ role: 'performance_analyst', task: 'x', facts: 'y', deps, model });

  assert.equal(r.outcome, 'failed');
  assert.equal(r.conclusion, null);
});

/* -------------------------------------------------------------------------- */
/*  强度选择                                                                   */
/* -------------------------------------------------------------------------- */

test('强度由程序决定：常规轮次用单次，超预算降级而不是拒绝', () => {
  const base = { callsThisHour: 0, hourlyBudget: 40, hasPosition: false, minutesSinceStrategyReview: 5, equityDriftPercent: 0 };

  assert.equal(intensityFor(base).intensity, 'single', '常规轮次不该开面板 —— 那是 4–5 倍成本');

  assert.equal(
    intensityFor({ ...base, hasPosition: true, equityDriftPercent: 3 }).intensity,
    'panel',
    '有持仓且权益显著变化时值得开面板',
  );

  assert.equal(
    intensityFor({ ...base, minutesSinceStrategyReview: 90 }).intensity,
    'panel',
    '太久没审视策略时要开面板',
  );

  const over = intensityFor({ ...base, callsThisHour: 40, hasPosition: true, equityDriftPercent: 5 });
  assert.equal(over.intensity, 'single', '超预算必须降级');
  assert.match(over.why, /降级/, '降级理由要说清楚');

  /*
   * 关键：超预算是**降级**不是**拒绝**。
   * 一个"因为超预算所以今天不决策"的系统，会在最需要它的时候罢工。
   */
  assert.equal(
    intensityFor({ ...base, callsThisHour: 999, hourlyBudget: 40 }).intensity,
    'single',
    '超预算仍然要给单次调用，而不是什么都不做',
  );
});
