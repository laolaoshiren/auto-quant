/**
 * 删除机器人 —— 尤其是 **AI 托管**的那一类。
 *
 * ## 这条用例为什么存在
 *
 * 它来自一次真实故障：操作员在界面上逐个删机器人，其他都删掉了，
 * 唯独 AI 托管实盘那个报 `FOREIGN KEY constraint failed`。
 *
 * 他给出的猜测是"是不是最后一个才删不掉" —— 那是个**无法证伪**的猜测，
 * 因为删掉别的之后它确实是最后一个。真正的原因完全不同：
 * `agent_experiments` / `agent_memory` / `agent_runs` 引用 `traders(id)` 时
 * **没有写 `ON DELETE CASCADE`**（而 `trades` / `orders` / `positions` /
 * `equity_snapshots` / `trade_events` / `decision_records` 那六张都写了），
 * 而**只有 AI 托管的机器人**才会往这三张表里写行。
 *
 * ## ⚠️ 夹具必须先往三张表各写一行
 *
 * 不写的话，这条用例测的是"没有任何 agent 数据的机器人能删" —— 而那本来
 * 就能删（`traders` 行一删就完事）。**用例会永远绿、永远抓不到这个 bug。**
 * 这正是它当初没被单元测试挡住的原因。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import {
  defaultStrategyConfig,
  STRATEGY_PRESETS,
  StrategyConfigSchema,
  type StrategyConfig,
} from '@aq/shared';

import { closeDb, getDb, initDb } from '../db/index.js';
import { agentExperiments, agentMemory, agentRuns } from './agentStore.js';
import { aiModels, exchanges, strategies, traders, trades } from './repositories.js';

const workDir = mkdtempSync(path.join(tmpdir(), 'aq-traderdelete-'));
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
  traderId = traders.create({
    name: 'ai-managed',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 3,
    initialEquity: 10,
    mode: 'ai_managed',
  }).id;
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

/** 三张 agent 表各写一行 —— 这才是"AI 托管的机器人"与策略模式的区别。 */
function seedAgentRows(): void {
  const at = new Date(Date.UTC(2026, 8, 17, 3, 10, 0)).toISOString();
  const tradeId = trades.insert({
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
    openedAt: new Date(Date.UTC(2026, 8, 17, 3, 0, 0)).toISOString(),
    closedAt: at,
    source: 'bot',
  }).id;

  agentExperiments.insert({
    traderId,
    trigger: 'periodic',
    observed: {},
    patch: {},
    applied: {},
    clamps: {},
    reason: 'fixture',
    toolCalls: [],
  });
  agentMemory.insert({
    traderId,
    tradeId,
    symbol: 'BTCUSDT',
    closeReason: 'stop_loss',
    netPnl: -0.1,
    lesson: 'fixture',
    tags: [],
  });
  agentRuns.insert({
    traderId,
    kind: 'review',
    trigger: 'periodic',
    intensity: 'normal',
    steps: 1,
    agents: {},
    outcome: 'ok',
    detail: 'fixture',
    tokensIn: 1,
    tokensOut: 1,
    latencyMs: 1,
  });
}

const countRows = (table: string, id: number): number =>
  (
    getDb().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE trader_id = ?`,
      id,
    ) ?? { n: -1 }
  ).n;

test('★ AI 托管的机器人删得掉，三张 agent 表的数据跟着一起走', () => {
  seedAgentRows();

  /*
   * 先确认夹具真的造出了"会拦住删除"的状态。
   * 这三条断言如果有一条不成立，下面的 `remove` 就算通过也说明不了任何事 ——
   * 它可能只是在测一个本来就没有从属数据的机器人。
   */
  assert.equal(countRows('agent_experiments', traderId), 1, '夹具：实验记录要有一行');
  assert.equal(countRows('agent_memory', traderId), 1, '夹具：经验要有一行');
  assert.equal(countRows('agent_runs', traderId), 1, '夹具：运行记录要有一行');

  traders.remove(traderId);

  assert.equal(traders.get(traderId), undefined, '机器人本身要删掉');
  assert.equal(countRows('agent_experiments', traderId), 0, '实验记录要跟着删');
  assert.equal(countRows('agent_memory', traderId), 0, '经验要跟着删');
  assert.equal(countRows('agent_runs', traderId), 0, '运行记录要跟着删');
  /* 级联那六张表也要一路走干净 —— 顺带确认没有把 CASCADE 弄丢。 */
  assert.equal(countRows('trades', traderId), 0, '成交要跟着删（原本就是级联的）');
});

test('★ agent_memory 引用 trades，所以清理顺序不能反', () => {
  seedAgentRows();

  /*
   * `agent_memory` 除 `trader_id` 外还有一列 `trade_id REFERENCES trades(id)`，
   * 而 `trades` 是随 `traders` 级联删的。
   *
   * 顺序反了（先删 `traders`）会让 `agent_memory` 指向一笔已经不存在的成交 ——
   * 同样是外键失败，只是失败的那张表不同。这条用例把顺序钉住：它通过就意味着
   * 清理顺序是对的，而不是"碰巧先清对了表"。
   */
  traders.remove(traderId);

  assert.equal(countRows('agent_memory', traderId), 0);
  assert.equal(countRows('trades', traderId), 0);
});

test('没有 agent 数据的机器人（策略模式）照样删得掉', () => {
  /* 回归护栏：修 CASCADE 问题时不要把"本来就能删"这条路弄坏。 */
  traders.remove(traderId);
  assert.equal(traders.get(traderId), undefined);
});
