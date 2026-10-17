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
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { defaultStrategyConfig, STRATEGY_PRESETS, StrategyConfigSchema, type StrategyConfig } from '@aq/shared';

import { firstBalancedObject, intensityFor, parseTurn, runSingleShot, runToolLoop, type LoopModel } from './loop.js';
import type { AgentToolDeps } from './tools.js';

const config = (): StrategyConfig =>
  StrategyConfigSchema.parse({
    ...defaultStrategyConfig(),
    ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>),
  }) as StrategyConfig;

function makeDeps() {
  const cycleIntervals: number[] = [];
  let current = config();
  const deps: AgentToolDeps = {
    currentConfig: () => current,
    saveConfig: (next) => {
      current = next;
    },
    /* 被守卫拒绝的补丁只留痕、不改配置；这个桩不需要记。 */
    recordRejectedPatch: () => {},
    read: {
      performance: () => ({ net: 0.31 }),
      equityCurve: () => [{ equity: 10 }],
      experiments: () => [{ reason: '上次降杠杆', outcomeNetPnl: 0.5 }],
      lessons: () => [{ symbol: 'BTCUSDT', lesson: '止损过紧', tags: ['止损过紧'] }],
      recentDecisions: () => [{ cycle: 1 }],
      marketOverview: () => [{ symbol: 'BTCUSDT' }],
      skippedOutcomes: async () => ({}),
    },
    /* 测试要能看到 AI 改周期这件事。 */
    cycleInterval: () => 3,
    setCycleInterval: (minutes) => { cycleIntervals.push(minutes); return { minutes, clamped: false }; },
  };
  return { deps };
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

/**
 * 线上真实失败形状（t69）：模型一次吐了**两个** JSON 对象。
 *
 * 线上 `agent_runs` 的 detail 原文就是它：
 * ```
 *   单次调用的输出无法解析：无法从回复里解析出 JSON 对象（前 120 字符：{"thought":"先看绩效…
 *   {"thought":"同时看最近的决策与拒绝记录…
 * ```
 */
const TWO_OBJECTS =
  '{"thought":"先看绩效与权益曲线…","state":"亏损中","sampleAdequate":true}\n' +
  '{"thought":"同时看最近的决策与拒绝记录…","state":"亏损中","sampleAdequate":false}';

/** 另一种实测形状：JSON 后面跟了含 `}` 的说明文字（切片会拼出非法 JSON）。 */
const TRAILING_BRACE = '{"state":"亏损中","sampleAdequate":true}\n补充：若权益曲线 {下降} 则另论。';

const GOOD_OBJECT = '{"state":"正常","sampleAdequate":true}';

/** 记下**每一次调用的 user 消息** —— 重试指令只在第二次出现，这要靠它证明。 */
function recording(replies: readonly string[]): {
  model: LoopModel;
  calls: () => number;
  users: string[];
  systems: string[];
} {
  let i = 0;
  const users: string[] = [];
  const systems: string[] = [];
  const model: LoopModel = {
    complete: async (system, user) => {
      systems.push(system);
      users.push(user);
      const text = replies[Math.min(i, replies.length - 1)];
      i += 1;
      if (text === undefined) throw new Error('桩模型没有脚本了');
      return { text, usage: { promptTokens: 1000, completionTokens: 200 }, latencyMs: 500 };
    },
  };
  return { model, calls: () => i, users, systems };
}

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
  /*
   * ⚠️ 两条脚本（t69）：解析失败会**重试一次**，所以桩必须准备第二次回复。
   * 这条用例守的是"**两次都坏**时不许编造结论"—— 语义与原来完全一致，只是多给一次机会。
   */
  const { model } = scripted(['我无法判断。', '我仍然无法判断。']);

  const r = await runSingleShot({ role: 'performance_analyst', task: 'x', facts: 'y', deps, model });

  assert.equal(r.outcome, 'failed');
  assert.equal(r.conclusion, null);
});

/* --- ★ 负向校准 ①（t69）：两个对象 → 必须触发重试，且重试 prompt 含明确要求 --- */

test('★★★ 负向校准①：解析失败必须重试一次，且重试 prompt 要求「只输出一个 JSON 对象」', async () => {
  const { deps } = makeDeps();
  const { model, calls, users } = recording([TWO_OBJECTS, GOOD_OBJECT]);

  const r = await runSingleShot({ role: 'performance_analyst', task: 'x', facts: 'y', deps, model });

  /* ① 重试被触发：**恰好 2 次**调用（不是 1 次"直接放弃"，也不是 3 次"无限重试"）。 */
  assert.equal(calls(), 2, `★★★ 解析失败后应**恰好重试 1 次**（共 2 次调用），实际 ${calls()} 次`);
  /* ② 重试的那条 user 消息必须含那三句要求（每一句防一种实测形状）。 */
  const retryUser = users[1] ?? '';
  assert.match(retryUser, /只输出一个 JSON 对象/, '重试 prompt 必须要求"只输出一个 JSON 对象"（防多对象）');
  assert.match(retryUser, /不要重复输出/, '重试 prompt 必须要求"不要重复输出"');
  assert.match(retryUser, /不要在 JSON 前后加任何文字/, '重试 prompt 必须要求"不要在 JSON 前后加任何文字"（防切片拼坏）');
  /* ③ **首次** prompt 不许带这段指令 —— 否则正常轮次会多背一段噪音。 */
  assert.doesNotMatch(users[0] ?? '', /只输出一个 JSON 对象/, '首次调用不该带重试指令');
  /* ④ 重试救回来之后，结论与"第一次就成功"完全一致。 */
  assert.equal(r.outcome, 'ok', '★★★ 重试成功后必须是 ok —— 这正是本修复要换来的结果');
  assert.equal(r.conclusion, GOOD_OBJECT, '结论必须来自第二次（成功的那次）');
  assert.equal(r.detail, '单次调用完成。', '成功路径的 detail 必须逐字节不变');
});

test('★★★ 负向校准①b：JSON 后跟含 } 的文字也走同一条重试路径', async () => {
  const { deps } = makeDeps();
  const { model, calls } = recording([TRAILING_BRACE, GOOD_OBJECT]);

  const r = await runSingleShot({ role: 'performance_analyst', task: 'x', facts: 'y', deps, model });

  assert.equal(calls(), 2, `★ 这种形状同样应重试一次，实际调用 ${calls()} 次`);
  assert.equal(r.outcome, 'ok');
});

/* --- ★ 负向校准 ②（t69）：重试仍失败 → failed 且 detail 必须说清"已重试" --- */

test('★★★ 负向校准②：重试仍失败时 detail 必须含「已重试」，不许让人以为第一次就死了', async () => {
  const { deps } = makeDeps();
  const { model, calls } = recording([TWO_OBJECTS, TWO_OBJECTS]);

  const r = await runSingleShot({ role: 'performance_analyst', task: 'x', facts: 'y', deps, model });

  assert.equal(calls(), 2, '★ 重试仍失败也要**恰好 2 次**，不许退化成 3 次以上');
  assert.equal(r.outcome, 'failed');
  assert.equal(r.conclusion, null, '失败时不许编造结论');
  assert.match(r.detail, /已重试 1 次仍失败/, `★★★ detail 必须写明已重试，实际：${r.detail.slice(0, 80)}`);
  assert.match(r.detail, /无法从回复里解析出 JSON 对象/, '★ 底层原因仍要保留（否则排查时看不到真实形状）');
});

/* --- ★ 负向校准 ③（t69）：去掉重试逻辑后测试必须变红（防恒真） --- */

test('★★★ 负向校准③：把一个"不重试"的实现跑同一套判据，必须报出问题（防恒真）', async () => {
  /*
   * ## 为什么这条不能省
   *
   * 上面两条断言的是"重试**发生了**"。而一个**什么都没做**的实现（或者说：
   * 有人把这轮的重试逻辑删掉）会让 `calls() === 1`、`detail` 里没有"已重试" ——
   * 但那两条断言**本身仍然是有效的**（它们会红）。这一条把"红"这件事**显式证明一遍**：
   *
   * ```
   *   ✗ 只断言"重试发生了" → 读者无从知道"不重试会不会也通过"（万一断言写松了呢）
   *   ✓ 同时对人造的不重试实现断言"必须红" → 判据的有效性被钉住
   * ```
   *
   * ⚠️ 这里**不复刻一份 loop.ts 的实现**（那会立刻漂移）。做法是：用一个
   * **只调一次模型、失败即返回**的桩"实现"，把它喂给同一组判据函数。
   */
  const singleAttempt = async (): Promise<{ calls: number; detail: string }> => {
    const { model, calls } = recording([TWO_OBJECTS]);
    await model.complete('s', 'u'); /* 只调一次，模拟"没有重试" */
    return { calls: calls(), detail: '单次调用的输出无法解析：无法从回复里解析出 JSON 对象' };
  };
  const broken = await singleAttempt();

  /* 同一组判据（与上面两条测试同形）在人造实现上必须失败。 */
  assert.notEqual(broken.calls, 2, '★★★ 校准夹具本身要能演示"不重试"：调用次数不该是 2');
  assert.doesNotMatch(
    broken.detail,
    /已重试 1 次仍失败/,
    '★★★ 校准夹具本身要能演示"detail 里没有已重试"',
  );

  /* 并且：真实实现**不能**是那个形状 —— 这三条一起把"重试真的在"钉死。 */
  const { deps } = makeDeps();
  const { model, calls } = recording([TWO_OBJECTS, TWO_OBJECTS]);
  const real = await runSingleShot({ role: 'performance_analyst', task: 'x', facts: 'y', deps, model });
  assert.equal(calls(), 2, '真实实现必须是 2 次 —— 与上面的"不重试夹具（1 次）"形成对照');
  assert.match(real.detail, /已重试 1 次仍失败/, '真实实现的 detail 必须含"已重试"');
});

test('★★★ token 与 latency 必须**包含**重试那一次（它确实花了钱与时间）', async () => {
  const { deps } = makeDeps();
  const { model } = recording([TWO_OBJECTS, GOOD_OBJECT]);

  const r = await runSingleShot({ role: 'performance_analyst', task: 'x', facts: 'y', deps, model });

  /* 桩每次 1000/200 tokens、500ms ⇒ 两次调用应累加成 2000/400/1000。 */
  assert.equal(r.tokensIn, 2000, `★★ token 必须累计两次调用（实际 ${r.tokensIn}）—— 它决定预算判断`);
  assert.equal(r.tokensOut, 400, `★★ 同上（实际 ${r.tokensOut}）`);
  assert.equal(r.latencyMs, 1000, `★★ 延迟也必须累计（实际 ${r.latencyMs}）`);
  assert.equal(r.steps.length, 0, '★ 重试不产生工具步骤 —— 单次调用档的语义不变');
});

test('★★★ 第一次就成功时只调用一次（重试不能变成"每轮都多烧一次"）', async () => {
  const { deps } = makeDeps();
  const { model, calls, users } = recording([GOOD_OBJECT]);

  const r = await runSingleShot({ role: 'performance_analyst', task: 'x', facts: 'y', deps, model });

  assert.equal(calls(), 1, `★★★ 正常轮次必须只调用 1 次，实际 ${calls()} 次 —— 否则每一轮都多花一倍 token`);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.detail, '单次调用完成。', '成功路径 detail 逐字节不变');
  assert.equal(r.tokensIn, 1000, '★ token 就是一次调用的量');
  assert.doesNotMatch(users[0] ?? '', /只输出一个 JSON 对象/, '首次 prompt 不带重试指令');
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

/* -------------------------------------------------------------------------- */
/*  原生工具调用方言（实测逼出来的）                                           */
/* -------------------------------------------------------------------------- */

/** 拼那种格式的行。用码点写，避免源码里出现难辨认的全角竖线。 */
const MARK = '\uFF5C\uFF5CDSML\uFF5C\uFF5C';
const nativeTurn = (tool: string, args: Record<string, string>, thought = ''): string =>
  [
    '<' + MARK + ' calls>',
    '<' + MARK + ' invoke name="' + tool + '">',
    ...Object.entries(args).map(([k, v]) => '<' + MARK + ' parameter name="' + k + '" string="true">' + v),
  ].join('\n');

test('循环能吃下模型的**原生工具调用格式** —— 这是实测逼出来的', async () => {
  /*
   * 为什么这条必须有：Command 厂商的 deepseek-v4.1-flash 会用训练时的原生格式
   * 回来，而不是我们提示词里要求的 JSON。
   *
   * 实测后果：整个循环判失败，**烧掉 2,561 输入 + 4,725 输出 tokens**，
   * 只留下一句"模型没输出可解析的工具调用" —— 看起来像模型不听话，
   * 实际是"我们没接住它的话"。
   *
   * 这条用例走的是**完整的 runToolLoop**，不只是解析器 ——
   * 否则测的只是"解析器能跑"，而不是"循环真的用它"。
   */
  const { deps } = makeDeps();
  const { model, calls } = scripted([
    nativeTurn('get_performance', { window: '24h' }, '先看绩效'),
    nativeTurn('finish', { summary: '看完了，不改' }),
  ]);

  const r = await runToolLoop({ role: 'strategist', task: 'x', facts: 'y', deps, model, maxSteps: 4 });

  assert.equal(r.outcome, 'ok', '原生格式必须被接住，而不是判失败');
  assert.equal(r.conclusion, '看完了，不改');
  assert.equal(r.steps[0]!.tool, 'get_performance');
  assert.equal((r.steps[0]!.args as { window?: string }).window, '24h');
  assert.equal(calls(), 2);
});

test('模型一次吐出两个 JSON 对象时只取第一个 —— 实测 31% 的运行死在这里', async () => {
  /*
   * 为什么这条必须有：`agent_runs` 里 **37 次 `failed` 全是这个形状**
   * （占全部运行的 31%，每次烧 2–6 万 tokens 却零结论）。原文：
   *
   *   {"thought":"先看绩效与权益曲线…","tool":"get_performance","args":{"window":"7d"}}
   *   {"thought":"同时看最近的决策与拒绝记录…
   *
   * 而报出来的错是"无法从回复里解析出 JSON 对象"—— 读起来像模型根本没输出 JSON，
   * **实际是它输出了两个**。`parseRoleOutput` 的兜底是"第一个 `{` 到最后一个 `}`"，
   * 两个对象时那一段仍然是两个对象，`JSON.parse` 必然失败。
   *
   * 取第一个而不是把两段合并：与原生方言分支同一条规则，也符合循环的形状
   * （一步一个动作、看到结果再决定下一步）。
   */
  const { deps } = makeDeps();
  const { model, calls } = scripted([
    `${turn('get_performance', { window: '7d' })}\n${turn('get_market_overview', { limit: 15 })}`,
    turn('finish', { summary: '继续了' }),
  ]);

  const r = await runToolLoop({ role: 'strategist', task: 'x', facts: 'y', deps, model, maxSteps: 4 });

  assert.equal(r.outcome, 'ok', '多吐一个对象不该让整轮判失败');
  assert.equal(r.steps[0]!.tool, 'get_performance', '取的是第一个');
  assert.equal((r.steps[0]!.args as { window?: string }).window, '7d');
  assert.equal(calls(), 2, '一次回复只算一步，不是两步');
});

test('配平扫描不被参数里的花括号骗到', async () => {
  /*
   * `args` 里带一段 JSON 文本是很正常的事（`set_params` 的 patch 就是）。
   * 用"找第一个 `}`"会在那里直接截断，所以必须按括号配平扫 ——
   * 与 `strategy/parser.ts` 用的是同一种手法，那里也踩过同一个坑。
   */
  const text = `${turn('set_params', { patch: '{"riskControl":{"minPositionSize":6}}' })}\n${turn('finish', {})}`;
  const first = firstBalancedObject(text);
  assert.ok(first, '应当切出第一个对象');
  const parsed = JSON.parse(first) as { tool?: string; args?: { patch?: string } };
  assert.equal(parsed.tool, 'set_params');
  assert.equal(parsed.args?.patch, '{"riskControl":{"minPositionSize":6}}');
});

test('两种方言混着来也能跑 —— 模型不必前后一致', async () => {
  const { deps } = makeDeps();
  const { model } = scripted([
    turn('get_performance', { window: '24h' }),
    nativeTurn('finish', { summary: '第二次改用了原生格式' }),
  ]);

  const r = await runToolLoop({ role: 'strategist', task: 'x', facts: 'y', deps, model, maxSteps: 4 });
  assert.equal(r.outcome, 'ok');
  assert.equal(r.conclusion, '第二次改用了原生格式');
});

test('原生格式里的工具名同样过校验 —— 只多认格式，不放宽语义', async () => {
  /*
   * §2.4：加的是字段别名，不是放宽语义校验。
   * 一个幻觉出来的工具名，在两种方言下都必须被拒。
   */
  const { deps } = makeDeps();
  const { model } = scripted([
    nativeTurn('set_levrage', { value: '10' }),
    turn('finish', { summary: '改对了' }),
  ]);

  const r = await runToolLoop({ role: 'strategist', task: 'x', facts: 'y', deps, model, maxSteps: 4 });
  assert.equal(r.outcome, 'ok');
  assert.match(JSON.stringify(r.steps[0]!.result as unknown), /没有名为/, '原生格式下的坏工具名照样要被拒');
});

/* -------------------------------------------------------------------------- */
/*  t72：另一个契约的格式（<decision>/<risk>）                                   */
/* -------------------------------------------------------------------------- */

/**
 * 线上失败量最大一类的**真实形状**（`agent_runs` id 670–712，15 条）。
 *
 * ⚠️ 逐字取自线上 `detail` 的「前 120 字符」，包括 `<risk>` 里那句
 * `⚠️ 本轮**未经风控官审阅**（原因未记录）` —— 而那句话是
 * **`deskOutput.ts` 里的字面量**（渲染层产出），**不是模型写的**。
 */
const DESK_OUTPUT =
  '<decision>\n[]\n</decision>\n\n<risk>\n⚠️ 本轮**未经风控官审阅**（原因未记录）—— 决策按裁决官结论直接放行。\n</risk>';

/** 另一种交易格式：`<decision>` 里带决策对象、`<risk>` 里带 JSON。 */
const DECISION_WITH_BODY =
  '<decision>\n[{"symbol":"BTCUSDT","action":"skip","leverage":3,"positionSizeUsd":0}]\n</decision>\n\n<risk>\n否决\n担心：{"verdict":"reject","lossScenarios":[]}\n</risk>';

test('★★★ t72 负向校准①：交易台格式的回复必须被**如实说明**，不再说"无法解析 JSON"', () => {
  /*
   * ## 为什么这条重要（错误信息在说谎）
   *
   * 线上原文：
   * ```
   *   模型连续两轮没有输出可解析的工具调用：无法从回复里解析出 JSON 对象
   *   （前 120 字符：<decision>\n[]\n</decision>\n\n<risk>\n⚠️ 本轮**未经风…
   * ```
   * **"无法解析出 JSON 对象"是错的** —— 那段文本根本不是模型想输出的 JSON：
   * `<decision>` 与 `<risk>` 是**渲染层产出的**（`deskOutput.ts:452-456` 的字面量），
   * 真相是**这次 agent 层调用被交易台接走了**。
   * 一个说错话的错误信息会让人去查解析器 —— 本仓库为这件事付过代价（见本文件其它用例）。
   */
  const r = parseTurn(DESK_OUTPUT);

  /* ★ 判据一点没松：仍然不产生动作。 */
  assert.equal(r.action, null, '★★★ 交易台的输出**绝不能**被当成工具调用 —— 那会把一个角色的结论记到另一个角色名下');
  assert.ok(r.error !== null, '必须有说明');
  assert.match(r.error, /另一个契约的格式/, '★ 必须说清"这是另一个契约的格式"');
  assert.match(r.error, /被交易台接走/, '★ 必须指出真正的原因（调用被交易台接走了）');
  assert.doesNotMatch(
    r.error,
    /无法从回复里解析出 JSON 对象/,
    `★★★ 【不能说谎】那段文本不是模型想输出的 JSON。实际：${r.error.split('\n')[0]}`,
  );
  /* 纠正提示必须给出**可执行的下一步**。 */
  assert.match(r.error, /finish/, '★ 必须告诉它"要给结论就调用 finish"');
});

test('★★★ t72 负向校准①b：<decision> 里带决策对象时，也要指出是另一个契约', () => {
  const r = parseTurn(DECISION_WITH_BODY);
  assert.equal(r.action, null);
  /* 这一支走的是"对象取到了但没有 tool"（`firstBalancedObject` 会切出决策对象）——
   * 原判据（没有 tool 字段）保留，但**必须补上**"另一个契约"的事实。 */
  assert.match(r.error ?? '', /没有 tool 字段/, '★ 原有判据保留（缺 tool 仍是失败）');
  assert.match(r.error ?? '', /另一个契约的格式/, '★ 但要补上真正的原因');
});

test('★★★ t72 负向校准②：真正"不听话"的输出（纯散文）必须**仍然失败**，判据不许被放松', () => {
  /*
   * 防的是"把判据放松成永远通过"：散文不属于任何契约，它**没有**"被交易台接走"
   * 这种解释，所以错误信息必须仍然是那句老话（模型没给可解析的 JSON）。
   */
  const r = parseTurn('我看了一下最近的绩效，感觉不太行，建议先观望。');
  assert.equal(r.action, null, '散文不许被当成动作');
  assert.match(r.error ?? '', /无法从回复里解析出 JSON 对象/, '★ 散文仍然是"没输出可解析的 JSON"');
  assert.doesNotMatch(r.error ?? '', /被交易台接走/, '★ 不许把散文也解释成"被交易台接走"（那是编原因）');
});

test('★★★ t72 负向校准②b：端到端 —— 交易台格式两次后仍然 failed（不收编、不静默）', async () => {
  const { deps } = makeDeps();
  const { model, calls, users } = recording([DESK_OUTPUT, DESK_OUTPUT]);

  const r = await runToolLoop({ role: 'strategist', task: 'x', facts: 'y', deps, model, maxSteps: 5 });

  assert.equal(calls(), 2, '★ 坏输出只宽容一次（第二次仍坏就结束）—— 上限没被改');
  assert.equal(r.outcome, 'failed', '★★★ 仍然 failed：交易台的输出不是策略师的结论，不许当成功收下');
  assert.equal(r.steps.length, 0);
  assert.match(r.detail, /另一个契约的格式/, `★ detail 必须带上真实原因，实际：${r.detail.slice(0, 80)}`);
  /* 第二次的纠正提示必须明确"用 finish 收尾 / 不要用别的模式格式"。 */
  assert.match(users[1] ?? '', /用 finish 收尾/, '★ 纠正提示必须给出正确出路（finish）');
  assert.match(users[1] ?? '', /不要用散文或别的模式的格式/, '★ 并明确禁止换格式');
});

test('★★★ t72 负向校准③：去掉"另一个契约"判据后，上面两条必须变红（防恒真）', () => {
  /*
   * ## 为什么必须证明"去掉会红"
   *
   * 上面两条断言"错误信息里含『另一个契约的格式』"。而**一个什么都没做的实现**
   * 会让错误信息仍是老话 —— 但我不能只靠"读代码觉得它不会"，得把"红"演示一遍：
   * 这里用**旧判据的等价形状**（只有"没有 tool 字段/无法解析 JSON"两条出路）
   * 跑同一个输入，断言它**给不出**那句诊断。
   */
  const OLD_STYLE_ERROR = (text: string): string => {
    /* 旧实现的最后一条出路：parsed.error ?? 没有 tool 字段。这里直接取 parsed.error 的形状。 */
    const parsed = parseRoleOutputForTest(text);
    return parsed ?? `输出里没有 tool 字段（收到 ${text.slice(0, 120)}）`;
  };
  const oldError = OLD_STYLE_ERROR(DESK_OUTPUT);

  assert.doesNotMatch(
    oldError,
    /另一个契约的格式/,
    '★★★ 旧判据给不出"另一个契约"的诊断 —— 所以上面那两条断言确实在测新行为（不是恒真）',
  );
  assert.match(oldError, /无法从回复里解析出 JSON 对象/, '★★ 而旧判据正是那句"说谎"的话');

  /* 真实实现必须给出新诊断 —— 与旧形状形成对照。 */
  const realError = parseTurn(DESK_OUTPUT).error ?? '';
  assert.match(realError, /另一个契约的格式/, '★ 真实实现必须给新诊断');
  assert.notEqual(realError, oldError, '★★ 两者必须是不同的输出 —— 否则说明新判据没生效');
});

/** 测试用的极简复刻：只取"整段/首尾括号"两条旧出路，用来演示旧行为。 */
function parseRoleOutputForTest(text: string): string | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const whole = tryParseObject(cleaned);
  if (whole !== null) return null; /* 旧实现：解析成功但没 tool → 走"没有 tool 字段"，不是 parsed.error */
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start && tryParseObject(cleaned.slice(start, end + 1)) !== null) return null;
  return `无法从回复里解析出 JSON 对象（前 120 字符：${cleaned.slice(0, 120)}）`;
}

function tryParseObject(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

test('★★★ t72 保住宿主链路：正常工具调用与原生方言仍逐字节不变', () => {
  /* 正常的工具调用不许被新的"另一个契约"判据误伤。 */
  const ok = parseTurn(turn('get_performance', { window: '7d' }));
  assert.ok(ok.action !== null, '★ 正常调用被判失败：' + String(ok.error));
  assert.equal(ok.action!.tool, 'get_performance');

  /*
   * ⚠️ **合法的工具调用里可以带 `<decision>`**（策略师能改 `promptSections`/`customPrompt`）。
   * 判据必须在"能抽出动作"之后才生效 —— 否则会误伤。
   */
  const withTag = parseTurn(
    JSON.stringify({ thought: '把入场标准改成 <decision> 那段', tool: 'set_params', args: { patch: {} } }),
  );
  assert.ok(withTag.action !== null, '★★ 字符串里带 <decision> 的**合法调用**不许被误判：' + String(withTag.error));
  assert.equal(withTag.action!.tool, 'set_params');
});

test('★★★ t72：PROTOCOL 必须说清"本轮不需要工具时"该输出什么（H2 的提示词修法）', () => {
  /*
   * H2 判定（见任务 output）：模型套用了另一个模式的格式 ⇒ 修**工具循环的提示词**，
   * 明确说明「本轮不需要工具时该输出什么」。这条钉住那句话真的在协议里。
   */
  const loopSrc = readFileSync(new URL('./loop.ts', import.meta.url), 'utf8');
  assert.match(loopSrc, /本轮不需要工具时/, '★ 协议里必须有"本轮不需要工具时"这一节');
  assert.match(loopSrc, /调用 finish/, '★ 并给出正确出路：调用 finish');
  assert.match(loopSrc, /不要\*\*用下面这些方式代替 finish/, '★ 并明确禁止换格式');
  /* ⚠️ 不能放宽"多对象必须失败"——那不是本层该改的（roles.ts 的判据保持原样）。 */
  const rolesSrc = readFileSync(new URL('./roles.ts', import.meta.url), 'utf8');
  assert.match(
    rolesSrc,
    /多对象在这里\*\*必须失败\*\*/,
    '★★ roles.ts 的"多对象必须失败"必须原样保留（本任务不得放宽解析层）',
  );
});