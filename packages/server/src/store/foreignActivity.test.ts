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
import { aiModels, exchanges, orders, strategies, traders, trades } from './repositories.js';

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

test('netSince 只算窗口内的 —— 总账校验的两侧必须比同一段', () => {
  /*
   * 这一条是我自己在实现总账校验时踩的坑，值得钉住。
   *
   * 校验的交易所侧来自 `income` 流水，而那个接口**必须给时间窗**
   * （币安限制窗口长度）。所以平台侧也**必须**限定在同一个窗口 ——
   * 否则差额里会混进"窗口之外的历史交易"，而那是**永久误报**。
   *
   * 实测：不按窗口取时，这个账户报出 −0.86 的假差额；
   * 按窗口取是 0.0057（窗口边界的浮点误差）。
   *
   * **一个永久误报的校验比没有校验更糟**：它会训练操作员忽略这条告警，
   * 而这是唯一能自动发现"账本错了"的地方。
   */
  const t = seedTrader('net-since');
  const account = exchanges.create({
    exchange: 'binance',
    label: 'net-since-2',
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });

  /* 窗口之前的一笔（应当被排除）。 */
  trades.insert({
    traderId: t,
    symbol: 'SOLUSDT',
    side: 'long',
    quantity: 1,
    entryPrice: 1,
    exitPrice: 1.1,
    leverage: 1,
    openedAt: '2026-01-01T00:00:00.000Z',
    closedAt: '2026-01-01T00:10:00.000Z',
    closeReason: 'model_decision',
    grossPnl: 10,
    entryFee: 0,
    fundingFee: 0,
    source: 'bot',
  });
  /* 窗口之内的一笔。 */
  trades.insert({
    traderId: t,
    symbol: 'SOLUSDT',
    side: 'long',
    quantity: 1,
    entryPrice: 1,
    exitPrice: 1.01,
    leverage: 1,
    openedAt: '2026-06-01T00:00:00.000Z',
    closedAt: '2026-06-01T00:10:00.000Z',
    closeReason: 'model_decision',
    grossPnl: 1,
    entryFee: 0,
    fundingFee: 0,
    source: 'bot',
  });

  const sinceIso = '2026-05-01T00:00:00.000Z';
  const inWindow = trades.netSince(sinceIso);
  assert.ok(inWindow < 5, `窗口内的净额应当只有那一笔（拿到 ${inWindow}）`);
  assert.ok(
    trades.netSince('2020-01-01T00:00:00.000Z') > inWindow,
    '把窗口放宽到全部历史时，净额必须更大 —— 否则说明 since 根本没生效',
  );
  assert.equal(trades.netSince('2030-01-01T00:00:00.000Z'), 0, '窗口在未来时应当什么都没有');
});

test('netSince 跨全部机器人求和 —— 交易所流水不区分是谁下的单', () => {
  const a = seedTrader('net-multi-a');
  const b = seedTrader('net-multi-b');
  for (const [t, pnl] of [[a, 2], [b, 3]] as Array<[number, number]>) {
    trades.insert({
      traderId: t,
      symbol: 'SOLUSDT',
      side: 'long',
      quantity: 1,
      entryPrice: 1,
      exitPrice: 1.1,
      leverage: 1,
      openedAt: '2026-06-01T00:00:00.000Z',
      closedAt: '2026-06-01T00:10:00.000Z',
      closeReason: 'model_decision',
      grossPnl: pnl,
      entryFee: 0,
      fundingFee: 0,
      source: 'bot',
    });
  }
  const total = trades.netSince('2026-05-01T00:00:00.000Z');
  assert.ok(total >= 5, `两个机器人（2 + 3）都要算进来，拿到 ${total}`);
});