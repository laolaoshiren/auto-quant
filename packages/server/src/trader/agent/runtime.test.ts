/**
 * 运行时：`AutoTrader` 与智能体模块之间的唯一接缝。
 *
 * ## 为什么这些用例存在
 *
 * 这一层的两条纪律如果失效，**交易本身会受影响** —— 而那是不可接受的：
 *
 * 1. **绝不抛穿**。智能体是附加能力。它坏了、模型欠费了、配置坏了 ——
 *    都不该让机器人停止交易。所以"失败不抛异常"必须被钉住。
 * 2. **只在 AI 模式下动作**。`agent_config_json` 为空时它整个空转 ——
 *    老机器人不该因为这一层存在而有任何行为变化。
 *
 * 还有一条不那么显眼但同样要紧的：**防重入**。一次审视要跑几十秒，
 * 而周期是 3 分钟；跨过两个周期的话第二轮会读到同一份数据、再改一遍参数，
 * 结果取决于谁后写。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { defaultStrategyConfig, STRATEGY_PRESETS, StrategyConfigSchema, type StrategyConfig } from '@aq/shared';

import { closeDb, initDb } from '../../db/index.js';
import { aiModels, exchanges, strategies, traders } from '../../store/repositories.js';
import type { LoopModel } from './loop.js';
import { AgentRuntime } from './runtime.js';

const workDir = mkdtempSync(path.join(tmpdir(), 'aq-runtime-'));
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
    DELETE FROM trades; DELETE FROM traders; DELETE FROM strategies;
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
    provider: 'deepseek',
    label: 't',
    model: 'm',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 120,
    maxRetries: 3,
  });
  const strategy = strategies.create({ name: 's', description: '', config: config(), presetId: null });
  traderId = traders.create({
    name: 'ai',
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

/** 一个记调用次数、可注入失败的桩模型。 */
function stubModel(reply = JSON.stringify({ tool: 'finish', args: { summary: '看完了' } })): LoopModel & { calls: number } {
  const m = {
    calls: 0,
    complete: async () => {
      m.calls += 1;
      return { text: reply, usage: { promptTokens: 10, completionTokens: 5 }, latencyMs: 1 };
    },
  };
  return m;
}

const runtime = (model: LoopModel = stubModel()) =>
  new AgentRuntime({ traderId, strategyConfig: config, model, equityNow: () => 10 });

/** 等一拍，让 `void` 触发的异步流程走完。 */
const flush = () => new Promise((r) => setTimeout(r, 20));

/* -------------------------------------------------------------------------- */
/*  模式判定                                                                   */
/* -------------------------------------------------------------------------- */

test('没有 AI 配置时整个空转 —— 老机器人行为不变', async () => {
  /*
   * 这是最基本的一条：`agent_config_json` 为空代表"不在 AI 模式"，
   * 那么这一层必须完全不动作。**任何"顺手也做一点"的行为都会改变老机器人的交易。**
   */
  const m = stubModel();
  const rt = runtime(m);

  assert.equal(rt.isEnabled(), false);
  assert.equal(rt.configOverride(), null, '非 AI 模式不得提供配置覆盖');
  assert.equal(rt.paused(), null);

  rt.triggerReview();
  rt.settleOnly();
  rt.reviewTrade({ tradeId: 1, symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -0.1 });
  await flush();

  assert.equal(m.calls, 0, '非 AI 模式下一次模型都不该调');
});

test('有 AI 配置时启用，并提供配置覆盖', () => {
  const next = { ...config(), coinSource: { ...config().coinSource, coinPoolLimit: 5 } };
  traders.setAgentConfig(traderId, JSON.stringify(next));

  const rt = runtime();
  assert.equal(rt.isEnabled(), true);
  assert.equal(rt.configOverride()?.coinSource.coinPoolLimit, 5, 'AI 下发的参数必须真的能取到');
});

test('AI 配置坏掉时回落成 null，而不是抛穿', () => {
  /*
   * 一份坏 JSON 不该让机器人停摆 —— 调用方拿到 null 就会继续用策略配置。
   * **但也不能"看起来正常"地返回一个半成品配置。**
   */
  traders.setAgentConfig(traderId, '{坏掉的 JSON');
  const rt = runtime();
  assert.equal(rt.isEnabled(), true, '非空即 AI 模式（坏内容不改变这个判定）');
  assert.equal(rt.configOverride(), null, '解析不了必须回落，而不是抛异常或返回半个配置');
});

/* -------------------------------------------------------------------------- */
/*  失败不抛穿                                                                 */
/* -------------------------------------------------------------------------- */

test('审视失败不抛穿 —— 智能体坏了不该让机器人停止交易', async () => {
  traders.setAgentConfig(traderId, JSON.stringify(config()));
  const exploding: LoopModel = {
    complete: async () => {
      throw new Error('模型服务欠费');
    },
  };
  const rt = runtime(exploding);

  // 关键：不抛异常。抛了的话交易循环会被它带崩。
  rt.triggerReview();
  await flush();

  // 走到这里就说明没抛穿
  assert.ok(true);
});

test('复盘失败不抛穿', async () => {
  traders.setAgentConfig(traderId, JSON.stringify(config()));
  const exploding: LoopModel = {
    complete: async () => {
      throw new Error('模型服务挂了');
    },
  };
  runtime(exploding).reviewTrade({ tradeId: 2, symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -0.1 });
  await flush();
  assert.ok(true);
});

test('结算失败不抛穿（它是同步入口，必须自己吞掉异常）', () => {
  traders.setAgentConfig(traderId, JSON.stringify(config()));
  // 结算入口是同步的，抛出来会直接进交易循环的调用点
  runtime().settleOnly();
  assert.ok(true);
});

/* -------------------------------------------------------------------------- */
/*  防重入                                                                     */
/* -------------------------------------------------------------------------- */

test('审视进行中时重复触发被挡住（否则两轮会各改一遍参数）', async () => {
  /*
   * 一次审视要跑几十秒，而周期是 3 分钟。跨过两个周期的话第二轮会
   * **读到同一份数据、再改一遍参数** —— 结果取决于谁后写，而且两次记录都写下了。
   */
  traders.setAgentConfig(traderId, JSON.stringify(config()));

  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  let calls = 0;
  const slow: LoopModel = {
    complete: async () => {
      calls += 1;
      if (calls === 1) await gate; // 第一次调用卡住，模拟"审视还没结束"
      return { text: JSON.stringify({ tool: 'finish', args: { summary: 'x' } }), usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 1 };
    },
  };

  const rt = runtime(slow);
  rt.triggerReview();
  await flush();
  const afterFirst = calls;

  rt.triggerReview(); // 第一次还在跑，这次应当被挡住
  await flush();
  assert.equal(calls, afterFirst, '进行中时重复触发不得再开一轮模型调用');

  resolve();
  await flush();
});
