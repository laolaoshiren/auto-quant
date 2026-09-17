/**
 * 智能体三张表的读写。
 *
 * ## 为什么这些用例存在
 *
 * 这三张表是「越跑越厉害」的**唯一落地处**。它们的读写一旦出错，
 * 后果不是"界面显示不对"，而是：
 *
 *  - `agent_experiments` 写错 → AI 看到的历史是假的 → 它基于假事实调参
 *  - 回填漏掉 → AI 只知道"我改过什么"，不知道"改动有没有用" → 反思退化成自述
 *  - `agent_memory` 重复写 → 同一笔平仓有两条互相矛盾的经验
 *
 * 所以这里钉的是**语义**（回填真的落到那一行、重复写真的被挡住），
 * 而不是"函数能跑通"。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { defaultStrategyConfig, STRATEGY_PRESETS, StrategyConfigSchema, type StrategyConfig } from '@aq/shared';

import { closeDb, initDb } from '../db/index.js';
import { agentExperiments, agentMemory, agentRuns } from './agentStore.js';
import { aiModels, exchanges, strategies, traders, trades } from './repositories.js';

/**
 * 造一笔真实成交。
 *
 * `agent_memory.trade_id` 上有指向 `trades(id)` 的外键 —— 一条经验必须挂在一笔
 * 真实平仓上，否则它说的"这笔为什么亏"就是凭空捏造的。所以夹具不能只写个
 * 数字了事，必须先有成交。
 */
function makeTrade(overrides: Partial<Parameters<typeof trades.insert>[0]> = {}): number {
  const at = new Date(Date.UTC(2026, 8, 17, 3, 0, 0)).toISOString();
  return trades.insert({
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
    openedAt: at,
    closedAt: new Date(Date.UTC(2026, 8, 17, 3, 10, 0)).toISOString(),
    source: 'bot',
    ...overrides,
  }).id;
}

const workDir = mkdtempSync(path.join(tmpdir(), 'aq-agentstore-'));
let traderId = 0;

before(() => initDb(path.join(workDir, 'test.sqlite')));

beforeEach(() => {
  const db = initDb(path.join(workDir, 'test.sqlite'));
  db.exec(`
    DELETE FROM agent_experiments; DELETE FROM agent_memory; DELETE FROM agent_runs;
    DELETE FROM trades; DELETE FROM orders; DELETE FROM positions;
    DELETE FROM decision_records; DELETE FROM equity_snapshots;
    DELETE FROM trade_events; DELETE FROM traders; DELETE FROM strategies;
    DELETE FROM ai_models; DELETE FROM exchange_accounts;
  `);

  // 字段形状照抄 autoTrader.test.ts —— 凭记忆写夹具会漏必填项
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
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 120,
    maxRetries: 3,
  });
  const strategy = strategies.create({
    name: 'test',
    description: '',
    config: StrategyConfigSchema.parse({
      ...defaultStrategyConfig(),
      ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>),
    }),
    presetId: null,
  });
  const trader = traders.create({
    name: 'agent',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 3,
    initialEquity: 10,
  });
  traderId = trader.id;
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

test('实验记录：写入后是"待结算"，回填后才算有结果', () => {
  const id = agentExperiments.insert({
    traderId,
    trigger: 'new_result',
    observed: { netPnl: 0.31, trades: 12 },
    patch: { riskControl: { btcEthMaxLeverage: 3 } },
    applied: { riskControl: { btcEthMaxLeverage: 3 } },
    clamps: [],
    reason: '连亏之后把杠杆降下来，先活下来再谈收益。',
    toolCalls: [{ name: 'get_performance', args: { window: '24h' } }],
  });

  const pending = agentExperiments.pending(traderId);
  assert.equal(pending.length, 1, '刚写下的实验必须出现在待结算里');
  assert.equal(pending[0]!.id, id);
  assert.equal(pending[0]!.outcomeEvaluatedAt, null, '还没回填时不得有结算时间');

  // 回填"这次调整之后真实发生了什么"
  agentExperiments.settle(id, { trades: 7, netPnl: -0.42 });

  assert.equal(agentExperiments.pending(traderId).length, 0, '回填后不得再出现在待结算里');
  const settled = agentExperiments.recent(traderId, 1)[0]!;
  assert.equal(settled.outcomeTrades, 7, '回填的笔数必须落到那一行');
  assert.equal(settled.outcomeNetPnl, -0.42);
  assert.ok(settled.outcomeEvaluatedAt, '回填必须记下时间');
  assert.match(settled.reason, /杠杆/, '理由必须原样保留 —— 它是审查这次调参的唯一依据');
  assert.match(settled.patchJson, /btcEthMaxLeverage/, '想让改什么必须可还原');
});

test('实验记录：patch 与 applied 分开存，钳制时两者不同且看得出来', () => {
  /*
   * 这条是守卫层的延伸：如果只存"实际生效值"，那么守卫钳制了而 AI 以为自己
   * 改成了的话，下一轮它会基于一个**错误前提**继续推理。
   * 所以两者必须都在，且 clamps 要说明改了什么。
   */
  const id = agentExperiments.insert({
    traderId,
    trigger: 'manual',
    observed: {},
    patch: { riskControl: { requireStopLoss: false, btcEthMaxLeverage: 8 } },
    applied: { riskControl: { requireStopLoss: true, btcEthMaxLeverage: 8 } },
    clamps: [
      { field: 'riskControl.requireStopLoss', asked: false, allowed: true, why: '结构性不变量' },
    ],
    reason: '想关掉止损以放宽入场。',
    toolCalls: [],
  });

  const row = agentExperiments.recent(traderId, 1).find((r) => r.id === id)!;
  assert.match(row.patchJson, /"requireStopLoss":false/, 'AI 原本想要什么必须留着');
  assert.match(row.appliedJson, /"requireStopLoss":true/, '实际生效什么必须留着');
  assert.notEqual(row.patchJson, row.appliedJson, '两者不同时必须看得出来');
  assert.match(row.clampsJson, /结构性不变量/, '钳制原因必须可读 —— 它会被回喂给 AI');
});

test('实验记录：按时间倒序返回，最近的在前', () => {
  for (const n of [1, 2, 3]) {
    agentExperiments.insert({
      traderId,
      trigger: `t${n}`,
      observed: {},
      patch: {},
      applied: {},
      clamps: [],
      reason: `第 ${n} 次`,
      toolCalls: [],
    });
  }
  const recent = agentExperiments.recent(traderId, 2);
  assert.equal(recent.length, 2);
  assert.match(recent[0]!.reason, /第 3 次/, '最近的必须排在最前 —— 喂给模型的是"最近发生了什么"');
});

test('记忆：同一笔平仓写不出两条互相矛盾的经验', () => {
  const first = agentMemory.insert({
    traderId,
    tradeId: makeTrade(),
    symbol: 'BTCUSDT',
    closeReason: 'stop_loss',
    netPnl: -0.31,
    lesson: '在 1H 下跌趋势里做多，止损被打掉。',
    tags: ['逆势', '追高'],
  });
  assert.equal(first, true, '第一次写入应当成功');

  const again = agentMemory.insert({
    traderId,
    tradeId: agentMemory.recent(traderId, 1)[0]!.tradeId,
    symbol: 'BTCUSDT',
    closeReason: 'stop_loss',
    netPnl: -0.31,
    lesson: '另一个说法',
    tags: [],
  });
  assert.equal(again, false, '重复写入必须被幂等跳过，而不是抛错把周期搞失败');
  assert.equal(agentMemory.count(traderId), 1);
  assert.match(
    agentMemory.recent(traderId, 1)[0]!.lesson,
    /1H 下跌趋势/,
    '保留下来的必须是第一条，后来的说法不得覆盖它',
  );
});

test('记忆：按标的检索得到的是这个标的的前车之鉴', () => {
  agentMemory.insert({ traderId, tradeId: makeTrade(), symbol: 'BTCUSDT', closeReason: 'stop_loss', netPnl: -1, lesson: 'BTC 逆势', tags: [] });
  agentMemory.insert({ traderId, tradeId: makeTrade({ symbol: 'ETHUSDT' }), symbol: 'ETHUSDT', closeReason: 'take_profit', netPnl: 1, lesson: 'ETH 顺势', tags: [] });
  agentMemory.insert({ traderId, tradeId: makeTrade({ exitPrice: 61000, grossPnl: 1 }), symbol: 'BTCUSDT', closeReason: 'take_profit', netPnl: 2, lesson: 'BTC 顺势', tags: [] });

  const btc = agentMemory.forSymbol(traderId, 'BTCUSDT');
  assert.equal(btc.length, 2, '只应拿到这个标的的');
  assert.ok(btc.every((m) => m.symbol === 'BTCUSDT'));
  assert.equal(btc[0]!.netPnl, 2, '最近的在前');

  assert.equal(agentMemory.forSymbol(traderId, 'DOGEUSDT').length, 0, '没有记忆时返回空数组，不是报错');
});

test('运行轨迹：本小时计数是预算的判据', () => {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const twoHoursAgo = new Date(now.getTime() - 7_200_000).toISOString();

  for (const [kind, intensity] of [
    ['decision', 'single'],
    ['decision', 'panel'],
    ['strategy', 'panel'],
  ] as const) {
    agentRuns.insert({
      traderId,
      kind,
      trigger: 'new_result',
      intensity,
      steps: 3,
      agents: [{ role: 'trader', verdict: 'open_long' }],
      outcome: 'ok',
      detail: '',
      tokensIn: 100,
      tokensOut: 50,
      latencyMs: 1200,
    });
  }

  assert.equal(
    agentRuns.countSince(traderId, hourAgo),
    3,
    '一小时内跑了三次 —— 预算判据必须算得准，它决定还能不能再开面板',
  );
  assert.equal(agentRuns.countSince(traderId, twoHoursAgo), 3);

  const run = agentRuns.recent(traderId, 1)[0]!;
  assert.equal(run.tokensIn, 100);
  assert.equal(run.latencyMs, 1200);
  assert.match(run.agentsJson, /open_long/, '各角色的结论必须留档 —— 这是"这一步为什么这么决定"的唯一依据');
});
