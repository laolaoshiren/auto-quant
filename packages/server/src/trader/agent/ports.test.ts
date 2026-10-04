/**
 * 真实端口：把编排层接到 SQLite 上。
 *
 * ## 为什么这些用例存在
 *
 * `orchestrator.test.ts` 用桩测的是"流程对不对"；这里测的是"**数据接得对不对**"。
 * 两者必须分开 —— 流程正确但数据接错，系统会安静地基于错误的事实做判断。
 *
 * 这里钉的都是**本会话真实踩过的坑**：
 *  - 时间戳跨格式/跨时区比较（害我读出过"8 分钟新增 769 条"这种数字）
 *  - "上次唤醒"没落库（进程重启后冷却归零，大脑被立刻唤醒 —— 那正是抖动）
 *  - 暂停状态没落库（一个"因为亏太多而主动停手"的决定被一次重启悄悄撤销）
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { defaultStrategyConfig, STRATEGY_PRESETS, StrategyConfigSchema, type StrategyConfig } from '@aq/shared';

import { closeDb, initDb } from '../../db/index.js';
import { agentExperiments, agentRuns } from '../../store/agentStore.js';
import { aiModels, exchanges, strategies, traders, trades } from '../../store/repositories.js';
import { MAX_JSON_CHARS } from './tools.js';
import { leafPaths, makeAgentPorts, markStrategyReview, markWoken, saveMemory } from './ports.js';

const workDir = mkdtempSync(path.join(tmpdir(), 'aq-ports-'));
const config = (): StrategyConfig =>
  StrategyConfigSchema.parse({
    ...defaultStrategyConfig(),
    ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>),
  }) as StrategyConfig;

let traderId = 0;

before(() => initDb(path.join(workDir, 'test.sqlite')));

beforeEach(() => {
  const db = initDb(path.join(workDir, 'test.sqlite'));
  db.exec(`
    DELETE FROM agent_experiments; DELETE FROM agent_memory; DELETE FROM agent_runs;
    DELETE FROM trades; DELETE FROM orders; DELETE FROM positions;
    DELETE FROM decision_records; DELETE FROM equity_snapshots;
    DELETE FROM trade_events; DELETE FROM traders; DELETE FROM strategies;
    DELETE FROM ai_models; DELETE FROM exchange_accounts; DELETE FROM settings;
  `);
  const account = exchanges.create({
    exchange: 'binance',
    label: 'test',
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: 'test',
    model: 'm',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 120,
    maxRetries: 3,
  });
  const strategy = strategies.create({ name: 'test', description: '', config: config(), presetId: null });
  traderId = traders.create({
    name: 'agent',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 3,
    initialEquity: 10,
  }).id;
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

const makeTrade = (over: Partial<Parameters<typeof trades.insert>[0]> = {}): number =>
  trades.insert({
    traderId,
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 1,
    entryPrice: 60000,
    exitPrice: 59900,
    leverage: 5,
    grossPnl: -0.1,
    entryFee: 0.01,
    exitFee: 0.01,
    closeReason: 'stop_loss',
    openedAt: new Date(Date.now() - 600_000).toISOString(),
    closedAt: new Date().toISOString(),
    source: 'bot',
    ...over,
  }).id;

const ports = () => makeAgentPorts({ traderId, strategyConfig: config, hourlyBudget: 40, priceChangeSince: async () => null });

/* -------------------------------------------------------------------------- */
/*  配置                                                                       */
/* -------------------------------------------------------------------------- */

test('没写过 AI 配置时回落到策略配置（老机器人不受影响）', () => {
  const p = ports();
  assert.equal(p.readConfig().riskControl.requireStopLoss, true, '应当拿得到策略里的配置');
});

test('saveConfig 之后 readConfig 拿到的是 AI 那份（非空即 AI 模式）', () => {
  const p = ports();
  const next = { ...p.readConfig(), coinSource: { ...p.readConfig().coinSource, coinPoolLimit: 4 } };
  p.saveConfig(next, { reason: 'x', patch: {}, clamps: [] });

  assert.equal(traders.get(traderId)!.agentConfigJson !== null, true, 'agent_config_json 必须非空 —— AI 模式靠它判定');
  assert.equal(ports().readConfig().coinSource.coinPoolLimit, 4, '新端口实例读到的必须是 AI 那份');
});

test('AI 配置坏掉时回落而不是抛穿', () => {
  /*
   * 一份坏 JSON 不该让机器人停摆 —— 它还有策略里的固定参数可以跑。
   * 但也不能"看起来正常"地用一个空配置继续。
   */
  traders.setAgentConfig(traderId, '{这不是 JSON');
  const p = ports();
  assert.equal(p.readConfig().riskControl.requireStopLoss, true, '应当回落到策略配置');
  assert.ok(p.readConfig().coinSource, '回落之后必须是一份完整可用的配置');
});

/* -------------------------------------------------------------------------- */
/*  事实收集                                                                   */
/* -------------------------------------------------------------------------- */

test('从来没有唤醒记录时，minutesSinceLastWake 是一个很大的值（立刻该醒）', () => {
  /*
   * 方向的取舍很重要：给 0 会让兜底判据以为"刚刚醒过"从而**永远不醒**，
   * 而实际上它从来没醒过。宁可多醒一次，也不要一个永远不审视的账户。
   */
  const facts = ports().collectFacts();
  assert.ok(facts.minutesSinceLastWake > 1000, `应当是"很久以前"，实际 ${facts.minutesSinceLastWake}`);
});

test('markWoken 之后：有唤醒记录、有新结果的计数从那时算起', () => {
  const p = ports();
  makeTrade();
  markWoken(traderId, 10);

  const facts = p.collectFacts();
  assert.ok(facts.minutesSinceLastWake < 1, '刚记过唤醒，距今应当接近 0');
  assert.equal(facts.newClosedTrades, 0, '唤醒之前入账的那笔不该算作"上次唤醒之后的新结果"');

  makeTrade({ closedAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(ports().collectFacts().newClosedTrades, 1, '唤醒之后入账的才算新结果');
});

test('连亏计数从最近一笔往前数', () => {
  makeTrade({ grossPnl: -0.1 });
  makeTrade({ grossPnl: -0.2 });
  assert.equal(ports().collectFacts().losingStreak, 2);

  makeTrade({ grossPnl: 0.5, closeReason: 'take_profit' });
  assert.equal(ports().collectFacts().losingStreak, 0, '最近一笔是赚的，连亏应当归零');
});

test('绩效统计用的是净额，且样本不足时自己说出来', () => {
  /*
   * ⚠️ 时间戳跨格式比较是本会话踩过的坑（用 datetime('now') 的空格格式去比
   * 库里的 ISO，字符串比较全为真，读出"8 分钟新增 769 条"）。所以这里
   * 断言的是"窗口是否真的按时间过滤"，而不只是"函数能跑通"。
   */
  makeTrade({ grossPnl: -0.1 });
  makeTrade({ grossPnl: 0.5, closeReason: 'take_profit' });
  // 一笔两天前的，不该进 24h 窗口
  makeTrade({
    grossPnl: -9,
    openedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    closedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  });

  const perf = ports().toolReads.performance('24h') as {
    trades: number;
    netPnl: number;
    sampleAdequate: boolean;
    winRatePercent: number | null;
  };
  assert.equal(perf.trades, 2, '两天前那笔不该进 24 小时窗口');
  // 毛 -0.1 + 0.5 = 0.4，再减去两笔各 0.02 的手续费\n  assert.ok(Math.abs(perf.netPnl - 0.36) < 1e-9, 净额必须是两笔之和减去手续费，实际 );
  assert.equal(perf.sampleAdequate, false, '2 笔远少于 30，必须自己说不充分');
  assert.equal(perf.winRatePercent, 50);
});

test('待结算实验算的是"那次调整之后"的成交，不是全部', () => {
  /*
   * 这一条决定策略师看到的历史是否真实：把全部成交都算进去的话，
   * 它会以为那次调整之后发生了很多事，而实际上可能一笔都没有。
   */
  const id = agentExperiments.insert({
    traderId,
    trigger: 't',
    observed: {},
    patch: {},
    applied: {},
    clamps: [],
    reason: 'x',
    toolCalls: [],
  });
  /*
   * 显式把成交放在调整**之后 1 秒**。
   *
   * 不靠"先 insert 实验再 insert 成交"的调用顺序 —— 两者可能落在同一毫秒，
   * 而判据用的是严格大于（方向是对的：少数只会让结算延后，安全）。
   * 测试若依赖亚毫秒顺序，就会变成一个时快时慢的用例。
   */
  const experiment = agentExperiments.recent(traderId, 1)[0]!;
  const after = new Date(new Date(experiment.createdAt).getTime() + 1000).toISOString();
  makeTrade({ grossPnl: -0.3, closedAt: after });
  // 调整**之前**的一笔不该被算进去
  makeTrade({ grossPnl: -9, closedAt: new Date(new Date(experiment.createdAt).getTime() - 1000).toISOString() });

  const pending = ports().pendingExperiments();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.id, id);
  assert.equal(pending[0]!.tradesSince, 1, '只该数调整之后的那一笔');
  assert.ok(pending[0]!.netPnlSince < -0.3 && pending[0]!.netPnlSince > -0.4, '净额应当是毛额减去费用（约 -0.32）');
});

test('本小时调用次数从运行轨迹算', () => {
  assert.equal(ports().callsThisHour(), 0);
  agentRuns.insert({
    traderId,
    kind: 'strategy',
    trigger: 't',
    intensity: 'single',
    steps: 1,
    agents: [],
    outcome: 'ok',
    detail: '',
    tokensIn: 1,
    tokensOut: 1,
    latencyMs: 1,
  });
  assert.equal(ports().callsThisHour(), 1);
});

test('★ 复盘的最终结论必须落库 —— 否则"我打开网页看到模型在做什么"只看到"自行结束"', () => {
  /*
   * ## 实测（2026-10-02）
   *
   * 线上 26 次 `losing_streak` 复盘：均 4.1 步、**均输出 6,962 tokens**、
   * 单次输入 85K–212K tokens —— 是很重的思考。而 `agent_runs` 里留下的
   * `detail` 是「模型在第 4 步自行结束。」（13 个字符）。
   *
   * 原因：`LoopResult` 同时带 `detail`（**怎么结束的**）与 `conclusion`
   * （**得出了什么**），而 `recordRun` 只写了前者 —— **结论被丢掉了**。
   *
   * 决策轮有 `cot_trace` 可看，而**复盘轮**（它"自我反思、迭代"的那一半）
   * 在界面上是空的。事后也无法回答"它上次为什么决定不改那个参数"。
   */
  const p = ports();
  const conclusion = JSON.stringify({
    lesson: '峰值 6.1% 的仓位只拿到 0.6% —— 锁盈止损被"至少 1×ATR"这条推得太远',
    tags: ['exit', 'trailing'],
  });
  p.recordRun({
    kind: 'strategy',
    trigger: 'losing_streak',
    intensity: 'single',
    result: {
      outcome: 'ok',
      steps: [
        { step: 1, thought: '先看绩效分布', tool: 'get_performance', args: {}, result: {} },
        { step: 2, thought: '再看锁盈规则', tool: 'get_current_params', args: {}, result: {} },
      ],
      conclusion,
      detail: '模型在第 2 步自行结束。',
      tokensIn: 100,
      tokensOut: 200,
      latencyMs: 300,
    } as never,
  });

  const latest = agentRuns.recent(traderId, 5)[0]!;
  assert.match(
    String(latest.detail),
    /峰值 6\.1%/,
    '★ 最终结论必须出现在落库的 detail 里 —— 否则那 7,000 tokens 的思考全丢了',
  );
  assert.match(String(latest.detail), /自行结束/, '原有的"怎么结束"那半句要保留，两者信息互补');
  /* 每一步的思考照旧要存（过程与结果都要）。 */
  assert.equal(latest.steps, 2);
});

test('策略审视时间被记下（强度选择依赖它）', () => {
  markStrategyReview(traderId);
  assert.ok(ports().collectFacts().minutesSinceStrategyReview < 1);
  assert.equal(ports().collectFacts().hasPosition, false);
});

test('记忆写入挂在真实成交上', () => {
  const tradeId = makeTrade();
  const first = saveMemory(traderId, { symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -0.1, lesson: 'x', tags: ['逆势'] }, tradeId);
  assert.equal(first, true);
  const again = saveMemory(traderId, { symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -0.1, lesson: 'y', tags: [] }, tradeId);
  assert.equal(again, false, '同一笔不该写两条互相矛盾的经验');
});

/* -------------------------------------------------------------------------- */
/*  实验的聚合：同一个参数被反复改                                              */
/* -------------------------------------------------------------------------- */

test('leafPaths 摊到叶子字段，数组与 null 不展开', () => {
  /*
   * 摊平是必要的：`patch` 是嵌套的，不摊平的话 `riskControl` 这一层会把**所有**
   * 风险参数的改动混成一个计数 —— 而那正好掩盖了"反复改的是哪一项"。
   */
  assert.deepEqual(leafPaths({ riskControl: { minPositionSize: 6 } }), ['riskControl.minPositionSize']);
  assert.deepEqual(
    leafPaths({ indicators: { emaPeriods: [9, 21] }, customPrompt: null }),
    ['indicators.emaPeriods', 'customPrompt'],
    '数组与 null 都当成叶子 —— `emaPeriods.0` 这种带下标的路径对模型没有价值',
  );
  assert.deepEqual(leafPaths({ a: { b: { c: 1 } } }), ['a.b.c'], '多层要一直摊到底');
  assert.deepEqual(leafPaths({}), [], '空对象没有叶子');
  assert.deepEqual(leafPaths('scalar'), [], '没有前缀的标量不是字段');
});

test('★ repeatedFields 必须落在截断线之内 —— 所以它排在 recent 前面', () => {
  /*
   * `bound()` 截断时**只保留前 N 个字符**，而 `recent` 每一条都带着完整的
   * `asked` / `applied` 补丁 JSON，十几条就吃满预算。
   *
   * 第一版把聚合放在 `recent` **后面**，于是最该被看到的那一项正好落在截断线之外。
   * 实测代价（真实运行 #121 里模型自己的话）：
   *
   *   「get_experiments 被截断，没看到 repeatedFields（提示词明确要求看它）；
   *     再看最近决策的被拒率。**用最小 limit 避开截断**。」
   *
   * 它为此多花了一轮工具调用去重读 —— 而那一轮最后正是死在"剩余预算不足以再读
   * 一类新信息"上。**一条被自己撑爆的返回等于没给。**
   */
  const fat = { riskControl: { minPositionSize: 5.1, note: 'x'.repeat(2_000) } };
  /*
   * ⚠️ **条数与每条的大小都要跟着 `MAX_JSON_CHARS` 走。**
   *
   * 截断线从 6000 提到 40000（见 `tools.ts` 上那段：6000 字符只占新预算的 0.4%），
   * 于是原来"12 条 × 400 字符"的构造够不到线，用例的前提断言会失败。
   *
   * 注意这里取的是 `experiments(20)` —— **`limit` 是 20**，所以条数给再多也只
   * 读到 20 条；真正决定长度的是**每条的大小**，所以把 `note` 加长到 2,000 字符。
   */
  for (let i = 0; i < 40; i += 1) {
    agentExperiments.insert({
      traderId,
      trigger: 'losing_streak',
      observed: {},
      patch: fat,
      applied: fat,
      clamps: [],
      reason: '账户太小、门槛不可达',
      toolCalls: [],
    });
  }

  const text = JSON.stringify(ports().toolReads.experiments(20));

  // 前提断言：这份返回**确实会**被截断，否则这条用例测不到东西。
  assert.ok(
    text.length > MAX_JSON_CHARS,
    `构造的返回只有 ${text.length} 字符，没到截断线（${MAX_JSON_CHARS}），这条用例失去意义`,
  );

  const preview = text.slice(0, MAX_JSON_CHARS);
  assert.match(preview, /repeatedFields/, '聚合字段必须落在截断线之内');
  assert.match(preview, /riskControl\.minPositionSize/);
});

test('★ repeatedFields 数出"同一个参数改过几次、合计结果如何"', () => {
  /*
   * 实测的形状：`minPositionSize` 与 `promptSections.decisionProcess` 是被反复调整的
   * 两项（真实数据：4 次与 5 次），而它们一直散在十几条其它改动中间。要看出"我在同一个
   * 地方反复动手"，得先把它们数出来 —— 而**数这件事该由程序做**。
   *
   * ⚠️ 注意 `netPnlSince` 的语义：它是"**这次改动之后那个窗口的净额**"，**不是这次
   * 改动的因果效果**（账户在动、市场也在动）。真实数据里这两项的窗口净额是 **正的**
   * （+0.65 / +0.27）—— 所以这个字段只能用来提示"改了几次"，不能用来断言"改坏了"。
   */
  const add = (patch: unknown, netPnl: number | null) => {
    const id = agentExperiments.insert({
      traderId,
      trigger: 'losing_streak',
      observed: {},
      patch,
      applied: patch,
      clamps: [],
      reason: '账户太小、门槛不可达',
      toolCalls: [],
    });
    if (netPnl !== null) agentExperiments.settle(id, { trades: 1, netPnl });
    return id;
  };

  // 同一个字段改三次（两次已结算、一次还在等）
  add({ riskControl: { minPositionSize: 6 } }, -0.1);
  add({ riskControl: { minPositionSize: 5.5 } }, -0.2);
  add({ riskControl: { minPositionSize: 5.1 } }, null);
  // 另一个字段只改过一次 —— 那是正常迭代，不该出现在 repeatedFields 里
  add({ riskControl: { leverage: 3 } }, 0.4);

  const out = ports().toolReads.experiments(20) as {
    recent: unknown[];
    repeatedFields: Array<{ field: string; times: number; settled: number; pending: number; netPnlSince: number }>;
  };

  assert.ok(Array.isArray(out.recent), '散记录仍然要给出来');

  const top = out.repeatedFields[0];
  assert.ok(top, '至少该有一项被反复改过');
  assert.equal(top.field, 'riskControl.minPositionSize');
  assert.equal(top.times, 3, '三次都要数上，包括还没结算的那次');
  assert.equal(top.settled, 2, '两次有结果');
  assert.equal(top.pending, 1, '一次还在等结果');
  assert.ok(Math.abs(top.netPnlSince - -0.3) < 1e-9, `合计净额应为 -0.3，实际 ${top.netPnlSince}`);

  assert.ok(
    !out.repeatedFields.some((f) => f.field === 'riskControl.leverage'),
    '只改过一次的字段是正常迭代，不该混进来',
  );
});