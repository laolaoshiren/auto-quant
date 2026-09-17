/**
 * 端到端接线验证：用桩模型 + 真实数据库跑完整条链路。
 *
 * ## 为什么需要这个用例 —— 单元测试覆盖不到的东西
 *
 * 各模块的单元测试都是"给桩、验逻辑"。它们证明不了**线接上了**：
 *
 * - `agent_runs` 到底有没有被写？
 * - AI 调参之后 `traders.agent_config_json` 真的被写了吗？
 * - 下一次读配置时读到的是 AI 那份吗？
 * - 平仓之后 `agent_memory` 真的多了一行吗？
 * - 等够笔数，`outcome_*` 真的被回填了吗？
 *
 * 这些**每一环都能单独通过、而整体断掉** —— 本会话已经因此踩过两个坑：
 * ① 配置改了却没有实验记录（`recordExperiment` 从没被调用）
 * ② 启动死锁（`isEnabled()` 恒为假，智能体一次都不会被调用）
 *
 * 两个都不报错、不影响机器人"看起来在运行"。**只有真的跑一遍、去看表里有没有行，
 * 才能发现它们。** 这就是本文件存在的理由。
 *
 * 用桩模型而不是真实 LLM：不是为了省钱，是为了**确定性** ——
 * 这个用例要断言的是"线接上了"，而不是"模型会不会调参"。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { defaultStrategyConfig, STRATEGY_PRESETS, StrategyConfigSchema, type StrategyConfig } from '@aq/shared';

import { closeDb, getDb, initDb } from '../../db/index.js';
import { agentExperiments, agentMemory, agentRuns } from '../../store/agentStore.js';
import { aiModels, exchanges, positions, strategies, traders, trades } from '../../store/repositories.js';
import type { LoopModel } from './loop.js';
import { settlePending } from './orchestrator.js';
import { makeAgentPorts } from './ports.js';
import { AgentRuntime } from './runtime.js';

const workDir = mkdtempSync(path.join(tmpdir(), 'aq-e2e-'));

const aiConfig = (): StrategyConfig =>
  StrategyConfigSchema.parse({
    ...defaultStrategyConfig(),
    ...(STRATEGY_PRESETS.find((p) => p.id === 'ai_managed')?.patch as Partial<StrategyConfig>),
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
    label: 't',
    apiKey: 'k',
    apiSecretEnc: 'v1:0:0:0',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'custom',
    label: 'm',
    model: 'x',
    baseUrl: 'http://x',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 120,
    maxRetries: 3,
  });
  // ⚠️ presetId 必须是 ai_managed —— 启用判定靠它（见 runtime.isEnabled 的死锁注释）
  const strategy = strategies.create({
    name: 'AI 托管',
    description: '',
    config: aiConfig(),
    presetId: 'ai_managed',
  });
  traderId = traders.create({
    name: 'ai',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 3,
    initialEquity: 9.1,
  }).id;
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

const modelScript = (replies: string[]): LoopModel => {
  let i = 0;
  return {
    complete: async () => {
      const text = replies[Math.min(i, replies.length - 1)]!;
      i += 1;
      return { text, usage: { promptTokens: 100, completionTokens: 20 }, latencyMs: 5 };
    },
  };
};

const turn = (tool: string, args: unknown = {}) => JSON.stringify({ thought: '因为', tool, args });

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

const runtime = (model: LoopModel) =>
  new AgentRuntime({
    traderId,
    strategyConfig: aiConfig,
    isAiStrategy: () => strategies.get(traders.get(traderId)!.strategyId)?.presetId === 'ai_managed',
    model,
    equityNow: () => 9.1,
  });

const facts = (over: Record<string, unknown> = {}) => (
  {
    tradeId: 1, symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -0.1,
    grossPnl: -0.08, fee: 0.02, peakPnlPercent: 0, holdMinutes: 30,
    entryPrice: 100, exitPrice: 99,
    openedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    ...over,
  }
);

const flush = () => new Promise((r) => setTimeout(r, 30));

/* -------------------------------------------------------------------------- */
/*  第一环：循环真的在转                                                       */
/* -------------------------------------------------------------------------- */

test('端到端 ①：选了 AI 预设的机器人会被启用（不是启动死锁）', () => {
  assert.equal(traders.get(traderId)!.agentConfigJson, null, '前提：还没调过参');
  assert.equal(runtime(modelScript([])).isEnabled(), true, '选了预设就必须启用，否则智能体永远不会被调用');
});

test('端到端 ②：审视跑完会在 agent_runs 里留下轨迹', async () => {
  const rt = runtime(modelScript([turn('get_performance', { window: '24h' }), turn('finish', { summary: '看完了，不改' })]));
  rt.triggerReview();
  await flush();

  const runs = agentRuns.recent(traderId, 5);
  assert.equal(runs.length, 1, '一次审视必须留一条运行轨迹 —— 这是"它这一步为什么这么做"的唯一依据');
  assert.equal(runs[0]!.outcome, 'ok');
  assert.match(runs[0]!.agentsJson, /get_performance/, '工具调用序列要留档');
  assert.ok(runs[0]!.tokensIn > 0, 'token 要如实累加 —— 预算是硬约束');
});

/* -------------------------------------------------------------------------- */
/*  第二环：调参真的落库                                                       */
/* -------------------------------------------------------------------------- */

test('端到端 ③：AI 调参会同时写下配置、实验记录与钳制信息', async () => {
  /*
   * 这一环是本会话踩过的坑：我把"写配置"和"记实验"分成两个端口，
   * 结果流程里从没调用过 recordExperiment —— AI 调了参，但历史里没有这次调整，
   * 下一轮它读不到"我上次改了什么、之后发生了什么"。**而系统看起来一切正常。**
   */
  const rt = runtime(
    modelScript([
      turn('set_params', { patch: { coinSource: { coinPoolLimit: 6 } }, reason: '候选太多，稀释了注意力' }),
      turn('finish', { summary: '缩小了候选池' }),
    ]),
  );
  rt.triggerReview();
  await flush();

  // ① 配置真的被写进 traders.agent_config_json
  const stored = traders.get(traderId)!.agentConfigJson;
  assert.ok(stored, 'AI 调参必须写入 agent_config_json —— AI 模式靠它判定');
  assert.equal((JSON.parse(stored!) as StrategyConfig).coinSource.coinPoolLimit, 6);

  // ② 实验记录真的被写下，且带理由与 patch
  const exps = agentExperiments.recent(traderId, 5);
  assert.equal(exps.length, 1, '调参必须留下实验记录，否则「越跑越厉害」的机制是断的');
  assert.match(exps[0]!.reason, /候选太多/, 'AI 的理由要原样存档 —— 那是审查这次调参的唯一依据');
  assert.match(exps[0]!.patchJson, /coinPoolLimit/, '想改什么要能还原');
  assert.match(exps[0]!.appliedJson, /coinPoolLimit/, '实际生效什么也要在');

  // ③ 下一条新端口读到的是 AI 那份（而不是策略里的）
  const ports = makeAgentPorts({ traderId, strategyConfig: aiConfig, hourlyBudget: 40 });
  assert.equal(ports.readConfig().coinSource.coinPoolLimit, 6, 'AI 下发的参数必须真的被后续周期用上');
});

/* -------------------------------------------------------------------------- */
/*  第三环：平仓后的复盘                                                       */
/* -------------------------------------------------------------------------- */

test('端到端 ④：平仓后会写下一条挂在真实成交上的因果结论', async () => {
  const tradeId = makeTrade();
  const rt = runtime(
    modelScript([
      JSON.stringify({
        lesson: '在 1H 下跌趋势里逆势做多，入场点距 15M 阻力位过近。',
        decisionQuality: 'bad',
        outcomeMatchedQuality: true,
        tags: ['逆势', '追高'],
      }),
    ]),
  );
  rt.reviewTrade(
    facts({
      tradeId,
      symbol: 'BTCUSDT',
      closeReason: 'stop_loss',
      netPnl: -0.1,
      /* 造出一个"曾浮盈但最终亏损"的轨迹 —— 那正是复盘最该抓住的形状。 */
      peakPnlPercent: 1.8,
    }),
  );
  await flush();

  const rows = agentMemory.recent(traderId, 5);
  assert.equal(rows.length, 1, '平仓后必须写一条记忆 —— 那是「前车之鉴」的来源');
  assert.equal(rows[0]!.tradeId, tradeId, '记忆必须挂在真实成交上');
  assert.match(rows[0]!.lesson, /逆势做多/);
  assert.match(rows[0]!.tagsJson, /决策质量:bad/, '决策质量要进标签 —— 否则分不出"决策错"和"运气差"');
});

/* -------------------------------------------------------------------------- */
/*  第四环：结果回填                                                           */
/* -------------------------------------------------------------------------- */

test('端到端 ⑤：等够笔数后 outcome_* 被回填，策略师下次能读到真实后果', async () => {
  /*
   * 这是「越跑越厉害」能不能成立的关口：没有回填，AI 只知道自己改过什么、
   * 不知道改动有没有用。
   */
  const ports = makeAgentPorts({ traderId, strategyConfig: aiConfig, hourlyBudget: 40 });
  const id = agentExperiments.insert({
    traderId,
    trigger: 'new_result',
    observed: {},
    patch: { coinSource: { coinPoolLimit: 6 } },
    applied: { coinSource: { coinPoolLimit: 6 } },
    clamps: [],
    reason: '缩小候选池',
    toolCalls: [],
  });

  // 调整之后成交 5 笔（门槛就是 5）
  const base = Date.now();
  for (let i = 0; i < 5; i += 1) {
    makeTrade({ closedAt: new Date(base + 1000 * (i + 1)).toISOString(), grossPnl: i % 2 === 0 ? 0.3 : -0.2 });
  }
  // 调整之前的一笔不该被算进去
  makeTrade({ closedAt: new Date(base - 60_000).toISOString(), grossPnl: -9 });

  const pending = ports.pendingExperiments();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.tradesSince, 5, '只数调整之后的成交');

  const r = settlePending(ports);
  assert.equal(r.settled, 1, '够笔数就该结算');

  const after = agentExperiments.recent(traderId, 5).find((e) => e.id === id)!;
  assert.equal(after.outcomeTrades, 5, '回填的笔数要落到那一行');
  assert.ok(after.outcomeEvaluatedAt, '要记结算时间');
  assert.ok(after.outcomeNetPnl !== null, '净额要被回填 —— 那是策略师唯一的"效果"依据');

  // 回填之后它不再出现在待结算里
  assert.equal(ports.pendingExperiments().length, 0);
});

/* -------------------------------------------------------------------------- */
/*  一条贯穿的断言：全程不碰既有数据的账目                                     */
/* -------------------------------------------------------------------------- */

test('端到端 ⑥：整条链路不写 trades（智能体不改账）', async () => {
  /*
   * 智能体可以改参数、可以停手、可以写记忆与实验记录 ——
   * **但它不该碰账目**。账目只由交易路径写（§2.3）。
   */
  const before = getDb().get<{ c: number }>('SELECT COUNT(*) c FROM trades')!.c;

  const rt = runtime(
    modelScript([
      turn('get_performance', { window: '24h' }),
      turn('set_params', { patch: { throttle: { maxEntriesPerHour: 1 } }, reason: '降低频率' }),
      turn('pause_trading', { reason: '市场在横盘' }),
      turn('finish', { summary: '降频并停手' }),
    ]),
  );
  rt.triggerReview();
  await flush();

  const after = getDb().get<{ c: number }>('SELECT COUNT(*) c FROM trades')!.c;
  assert.equal(after, before, '智能体不得写入任何成交记录');

  // 停手是落库的，不是内存标志
  assert.ok(rt.paused(), 'pause_trading 必须被记下来 —— 重启后仍应生效');
  assert.equal(positions.open(traderId).length, 0, '智能体不得建仓');
});
