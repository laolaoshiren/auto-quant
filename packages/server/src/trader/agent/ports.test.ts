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
import { clearPause, makeAgentPorts, markStrategyReview, markWoken, readPause, saveMemory } from './ports.js';

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

const ports = () => makeAgentPorts({ traderId, strategyConfig: config, hourlyBudget: 40 });

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

/* -------------------------------------------------------------------------- */
/*  暂停与记忆                                                                 */
/* -------------------------------------------------------------------------- */

test('暂停是落库的，重启之后仍然生效', () => {
  /*
   * 内存标志在进程重启后会消失 —— 一个"因为亏太多而主动停手"的决定，
   * 不该被一次重启悄悄撤销。
   */
  ports().requestPause('连续亏损，先站到一边');
  const read = readPause(traderId);
  assert.ok(read, '暂停必须被记下来');
  assert.match(read!.reason, /连续亏损/);
  assert.ok(read!.at, '要记时间 —— 否则看不出停了多久');

  clearPause(traderId);
  assert.equal(readPause(traderId), null, '操作员可以恢复');
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
