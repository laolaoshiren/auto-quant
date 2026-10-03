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

/** 一个记调用次数、并留下最后一次用户提示词的桩模型。 */
function stubModel(
  reply = JSON.stringify({ tool: 'finish', args: { summary: '看完了' } }),
): LoopModel & { calls: number; lastPrompt: string } {
  const m = {
    calls: 0,
    lastPrompt: '',
    complete: async (_system: string, user: string) => {
      m.calls += 1;
      m.lastPrompt = user;
      return { text: reply, usage: { promptTokens: 10, completionTokens: 5 }, latencyMs: 1 };
    },
  };
  return m;
}

const runtime = (model: LoopModel = stubModel(), isAiStrategy = false) =>
  new AgentRuntime({ traderId, strategyConfig: config, isAiStrategy: () => isAiStrategy, model, equityNow: () => 10, priceChangeSince: async () => null });

/** 等一拍，让 `void` 触发的异步流程走完。 */
const facts = (over: Record<string, unknown> = {}) => (
  {
    tradeId: 1, symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -0.1,
    grossPnl: -0.08, fee: 0.02, peakPnlPercent: 0, leverage: 3, holdMinutes: 30,
    entryPrice: 100, exitPrice: 99,
    /* 开仓时计划的保护位 —— 复盘员靠它区分"按计划被打掉"与"保护位挂错"。 */
    stopLoss: 95, takeProfit: 110,
    openedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    ...over,
  }
);

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
  rt.reviewTrade(facts({ tradeId: 1, symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -0.1 }));
  await flush();

  assert.equal(m.calls, 0, '非 AI 模式下一次模型都不该调');
});

test('启动死锁：选了 ai_managed 预设但还没调过参时，必须是启用状态', () => {
  /*
   * 这是我在启动真钱机器人之前才发现的缺陷，而且它**没有任何症状**：
   *
   *     isEnabled()            判据是 agent_config_json 非空
   *     agent_config_json 非空  由 set_params 写入
   *     set_params 被调用       需要 AI 在跑
   *     AI 在跑                需要 isEnabled() 为真
   *
   * 一个刚建的 AI 机器人会周期照跑、日志干净、**但智能体一次都不会被调用**。
   * 所以"选了那个预设"本身就必须算作 AI 模式。
   */
  assert.equal(traders.get(traderId)!.agentConfigJson, null, '前提：还没有任何 AI 配置');
  const rt = runtime(stubModel(), true);
  assert.equal(rt.isEnabled(), true, '选了预设就是要求 AI 托管，哪怕它还没改过参数');
  assert.equal(runtime(stubModel(), false).isEnabled(), false, '没选预设且没有配置时仍然是空转');
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

test('外部平仓不要谎称"记录可能被轮转清理" —— 那本来就不是我们的仓', async () => {
  /*
   * `close_reason: 'external'` 的仓位**不是本平台开的**（操作员手工下的、
   * 或别的程序下的），所以查不到入场理由是**正确的结果**，不是数据缺失。
   *
   * 原来这里一律说"可能已被轮转清理"，把复盘员引去追一个永远不会有的东西 ——
   * 实测记忆 #24（APTUSDT，external）的原文就是这么写的：
   *   「…但入场理由缺失，无法判断是方向本就错、还是止损/出场过紧。」
   */
  traders.setAgentConfig(traderId, JSON.stringify(config()));
  const m = stubModel();
  runtime(m).reviewTrade(facts({ closeReason: 'external', symbol: 'APTUSDT' }));
  await flush();

  assert.ok(m.lastPrompt.includes('不是本平台开的'), '必须说清这个仓不是我们开的');
  assert.ok(!m.lastPrompt.includes('轮转清理'), '不能把"外部仓"说成"记录丢了"');
});

test('查不到记录的普通平仓，原因确实是"记录被轮转"', async () => {
  traders.setAgentConfig(traderId, JSON.stringify(config()));
  const m = stubModel();
  runtime(m).reviewTrade(facts({ closeReason: 'stop_loss', symbol: 'BTCUSDT' }));
  await flush();

  assert.ok(m.lastPrompt.includes('轮转清理'), '普通平仓查不到记录时，原因该是记录被清理');
  assert.ok(!m.lastPrompt.includes('不是本平台开的'), '别把普通平仓说成外部仓');
});

test('复盘失败不抛穿', async () => {
  traders.setAgentConfig(traderId, JSON.stringify(config()));
  const exploding: LoopModel = {
    complete: async () => {
      throw new Error('模型服务挂了');
    },
  };
  runtime(exploding).reviewTrade(facts({ tradeId: 2, symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -0.1 }));
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

/* -------------------------------------------------------------------------- */
/*  浮盈的口径                                                                 */
/* -------------------------------------------------------------------------- */

test('复盘回执必须标出浮盈的口径 —— 否则会被当成价格涨幅读', async () => {
  /*
   * 实测（2026-09-22，持仓 `#95` XRPUSDT 5x，入场 1.513）：
   *
   *     positions.peak_pnl_percent = 3.1456890134116477
   *     那段持仓里交易所最高价        1.5318  → 价格口径只有 +1.24%
   *
   * 而回执里印的是一个**裸的**"最大浮盈 3.146%"，紧挨着它上面那行
   * 「价格变动 X%」又恰好是**价格**口径。模型按最近的口径去读，
   * 反算出 **1.5606** 这个从未出现的价格，于是判定一张
   * **从未被触及**的止盈单（1.5565）该兑现却没兑现，并据此去改离场逻辑。
   *
   * 判据必须落在**只有正确路径才有**的东西上 —— 也就是**换算后的价格数字**：
   * 光断言"提到了对保证金"是不够的，那样把一个仍然没换算的实现也算过。
   */
  traders.setAgentConfig(traderId, JSON.stringify(config()));
  const m = stubModel();
  runtime(m).reviewTrade(facts({ peakPnlPercent: 3.1456890134116477, leverage: 5 }));
  await flush();

  assert.match(
    m.lastPrompt,
    /最大浮盈 3\.146%（\*\*对保证金/,
    '口径必须**紧跟**在数字后面 —— 隔开一段再写，读的时候仍然会把它当价格',
  );
  assert.match(
    m.lastPrompt,
    /折合价格约 0\.629%/,
    '#95 的真实数字必须被换算出来（3.1456890134116477 ÷ 5 = 0.629），否则模型还得自己猜',
  );
  assert.match(m.lastPrompt, /含 5x 杠杆/, '要给杠杆倍数，否则那个换算无从复核');
  assert.match(
    m.lastPrompt,
    /别拿这个去和止盈\/止损价比较/,
    '要明说不能拿它跟价位比 —— 模型上一次正是这么做的',
  );
});

test('止损触发但整体盈利时必须说成「保本离场」—— 否则复盘员看到的是自相矛盾的数据', async () => {
  /*
   * 实测：AI 的记忆里**至少三条**在抱怨同一件事 ——
   *
   *     ETHUSDT  「平仓价 2789.5 高于开仓价 2762.21 却标记为 stop_loss…
   *               推测为移动止损上移触发…但数据不足以确认」
   *     BNBUSDT  「平仓价高于开仓价却标记 stop_loss，离场机制数据不足…」
   *
   * 而系统里早就有 `closeReasonLabel` 专治这件事（它把「止损触发 + 盈利」
   * 说成「移动止损（保本离场）」），`prompt.ts` 也早就用上了 ——
   * 只有复盘回执一直印机器码，于是同一个困惑从操作员身上搬到了复盘员身上。
   *
   * 判据：那句"平仓原因"里**不能再出现机器码**。
   */
  traders.setAgentConfig(traderId, JSON.stringify(config()));
  const m = stubModel();
  runtime(m).reviewTrade(
    facts({
      closeReason: 'stop_loss',
      netPnl: 0.1961, // ETHUSDT 那笔的真实净额 —— 盈利，而原因写着 stop_loss
      entryPrice: 2762.21,
      exitPrice: 2789.5,
      peakPnlPercent: 4.445215814933514,
      leverage: 3,
    }),
  );
  await flush();

  assert.match(
    m.lastPrompt,
    /平仓原因：移动止损（保本离场）/,
    '止损位被上移到成本之上、触发时是赚的 —— 必须说成保本离场',
  );
  assert.ok(
    !/平仓原因：stop_loss/.test(m.lastPrompt),
    '不能再把机器码当平仓原因印出去 —— 那正是"数据自相矛盾"的来源',
  );
});

/* -------------------------------------------------------------------------- */
/*  计划保护位：复盘员靠它区分"按计划被打掉"与"保护位挂错"                          */
/* -------------------------------------------------------------------------- */

test('★ 复盘事实里必须带上【计划的止损与止盈】—— 否则它会去历史记忆里猜，而那是别的交易', async () => {
  /*
   * ## 缺口是怎么被发现的（2026-10-03，AI 自己点名）
   *
   * 复盘员在 `#104`（WLDUSDT）里写下：
   *
   *   「记录的开仓止损应为 0.5440（-2.16%），实际平仓价却是 0.5516（-0.845%），
   *    两者相差约 1.2%，说明实际止损位被收紧/挂错或成交记录有误，
   *    **本次亏损无法区分是『趋势判断错』还是『止损设置/执行错』**。」
   *
   * 而事实是：那笔的止损**就是 0.552**（决策 `c15` 写的 0.552、挂单触发价 0.552、
   * 成交 0.5516 只是 0.07% 的滑点）—— **没有挂错**。
   * 它引用的 `0.544` 是**同一标的上一笔（#275）**的止损，**它把两笔混了**。
   *
   * 它为什么会混：平仓时喂给它的事实里**从来没有"计划的止损"**，
   * 它只能从 `get_lessons` 的同标的历史记忆里翻一个数字 —— 而那个数属于别的交易。
   *
   * 这条用例钉住的正是调用方的责任（本文件顶部的原则）：
   * **「让 AI 说『数据不足』是调用方的责任，不是它的。」**
   */
  traders.setAgentConfig(traderId, JSON.stringify(config()));
  const m = stubModel();
  runtime(m).reviewTrade(
    facts({
      symbol: 'WLDUSDT',
      closeReason: 'stop_loss',
      entryPrice: 0.5563,
      exitPrice: 0.5516,
      stopLoss: 0.552,
      takeProfit: 0.59,
    }),
  );
  await flush();

  assert.match(
    m.lastPrompt,
    /计划保护位：止损 0\.552、止盈 0\.59/,
    '★ 计划的止损/止盈必须出现在喂给复盘员的事实里 —— 否则它只能从同标的历史记忆里猜一个数',
  );
  assert.ok(
    /止损 0\.552/.test(m.lastPrompt),
    '必须是**本笔**的 0.552（它曾经误把上一笔的 0.544 当成本笔的）',
  );
});

test('没有设置保护位时如实说"未设置"，不要漏掉这一行', async () => {
  /*
   * 漏掉一整行会让复盘员以为"这个字段不存在"，而它其实只是没设 ——
   * 那是两种不同的结论（"没保护" vs "没数据"）。
   */
  traders.setAgentConfig(traderId, JSON.stringify(config()));
  const m = stubModel();
  runtime(m).reviewTrade(facts({ stopLoss: null, takeProfit: null }));
  await flush();

  assert.match(m.lastPrompt, /计划保护位：止损 （未设置）、止盈 （未设置）/);
});