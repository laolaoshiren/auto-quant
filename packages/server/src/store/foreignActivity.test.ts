/**
 * 外部交易活动的归属判定。
 *
 * ## 为什么这些用例存在
 *
 * 实测事故：交易所账户上有 605 笔成交，平台只能归属 46 笔（机器人 #8 自己），
 * 其余 422 笔（手续费 1.86 USDT，占账户全部手续费的 67%）**从未在界面上出现过** ——
 * 归属闸门跳过时写的是 `log.debug`，而那个级别不显示。
 *
 * 后果：操作员看到「机器人赚了 0.32、账户少了 1.56」无法解释，
 * **AI 也只能在错误前提下推理**（以为自己算错了，或以为策略在亏）。
 *
 * 所以这里钉的是**三分类的语义**，而不是「函数能跑通」：
 *
 *   · 本机器人挂的     → 正常，记账
 *   · 本平台别的机器人 → 正常（共用账户），静默跳过
 *   · **两边都不是**   → **外部活动，必须上报**
 *
 * 第二条与第三条的区别是整个功能的全部意义：混为一谈就退回「什么都不说」，
 * 而把第二条错报成第三条会让每个共用账户的多机器人用户天天看到假告警 ——
 * **假告警会让人连真告警一起忽略。**
 *
 * 按 AGENTS.md §3.6：临时目录，绝不碰 `data/`。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { defaultStrategyConfig } from '@aq/shared';

import { closeDb, getDb, initDb } from '../db/index.js';
import { aiModels, exchanges, orders, strategies, traders } from './repositories.js';

let workDir: string;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-foreign-'));
  initDb(path.join(workDir, 'foreign.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const table of ['orders', 'traders', 'strategies', 'ai_models', 'exchange_accounts']) {
    getDb().run(`DELETE FROM ${table}`);
  }
});

function seedTrader(name: string): number {
  const account = exchanges.create({
    exchange: 'binance',
    label: name,
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: name,
    model: 'm',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const strategy = strategies.create({
    name,
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  return traders.create({
    name,
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
  }).id;
}

let seq = 0;
function seedOrder(traderId: number, exchangeOrderId: string | null): number {
  seq += 1;
  return orders.insert({
    traderId,
    exchangeOrderId,
    clientOrderId: `CL-${seq}`,
    symbol: 'SOLUSDT',
    side: 'BUY',
    type: 'MARKET',
    purpose: 'entry',
    quantity: 1,
    price: null,
    stopPrice: null,
    status: 'FILLED',
    avgPrice: 1,
    filledQty: 1,
    rawResponse: {},
  });
}

test('allExchangeOrderIds 跨越全部机器人 —— 这是区分「别的机器人」与「外部」的唯一依据', () => {
  const a = seedTrader('foreign-a');
  const b = seedTrader('foreign-b');
  seedOrder(a, '111');
  seedOrder(a, '222');
  seedOrder(b, '333');

  const all = orders.allExchangeOrderIds();
  assert.ok(all.has('111'), 'A 的单要在里面');
  assert.ok(all.has('222'));
  assert.ok(all.has('333'), 'B 的单也要在里面 —— 全局集合');

  const onlyA = orders.exchangeOrderIds(a);
  assert.ok(onlyA.has('111'));
  assert.ok(!onlyA.has('333'), 'exchangeOrderIds 必须只返回本机器人的');
});

test('不设上限的那个才适合做外部检测 —— 有上限的会把早期成交误报成外部活动', () => {
  const t = seedTrader('foreign-limit');
  seedOrder(t, 'old-1');

  assert.equal(orders.exchangeOrderIds(t, 0).size, 0, 'limit=0 时按机器人过滤的那个看不到任何单');
  assert.ok(orders.allExchangeOrderIds().has('old-1'), '不设上限的那个必须仍然看得到它');
});

test('order id 为空的行不进任何集合 —— 空串不是有效的归属证据', () => {
  const t = seedTrader('foreign-null');
  seedOrder(t, null);

  assert.ok(!orders.allExchangeOrderIds().has(''), '空串不该在集合里');
  assert.ok(!orders.exchangeOrderIds(t).has(''));
});
