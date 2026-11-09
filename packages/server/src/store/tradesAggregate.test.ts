/**
 * **成交聚合只有一份 SQL** —— `trades.performanceSince()` 不得再抄
 * `aggregateTrades()` 的那 9 个 `SUM` / `COUNT`。
 *
 * ## 为什么这个测试存在
 *
 * 两个入口喂给不同的人：`aggregateTrades()` 喂控制台（终身口径），
 * `performanceSince()` 喂提示词（窗口口径）。它们原来各有一份**逐字相同**的
 * 聚合 SQL，唯一的区别是 `WHERE ... closed_at >= ?` 与多一个 `notional` 字段。
 *
 * 复制体的危险不是"多写几行"：它是**判胜口径**（按净盈亏而不是毛盈亏）。
 * 一旦有人只改了其中一份（例如把 `net_pnl <= 0` 的边界改成 `< 0`，或者加上
 * `pnl >= 0`），控制台上的胜率会与模型看到的胜率说两件事 —— 而模型会照着
 * 那个假的胜率做决策，界面上却没有任何一处能看出不一致。
 *
 * 所以这里钉三件事：
 * ① 窗口覆盖全历史时，两个入口的每一个数字逐项相等（等价重构的验收）；
 * ② 窗口确实只统计窗口内的行（`performanceSince` 自己的职责没被合并弄丢）；
 * ③ 源码里那段聚合 SQL 只出现一次（防下一次"复制一份再改"）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, initDb } from '../db/index.js';
import {
  aiModels,
  exchanges,
  strategies,
  traders,
  trades as tradeStore,
  type TradePerformance,
  type TradeStats,
} from './repositories.js';

let workDir: string;
let traderId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-trade-aggregate-'));
  initDb(path.join(workDir, 'aggregate.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

function seedTrader(): number {
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
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const strategy = strategies.create({
    name: 'test',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  return traders.create({
    name: 'aggregate',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;
}

function clearTrades(): void {
  initDb(path.join(workDir, 'aggregate.sqlite')).run('DELETE FROM trades');
}

function insertTrade(input: {
  grossPnl: number;
  closedAt: string;
  entryFee?: number;
  exitFee?: number;
  fundingFee?: number;
}): void {
  tradeStore.insert({
    traderId,
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 0.5,
    entryPrice: 100,
    exitPrice: 100,
    leverage: 3,
    grossPnl: input.grossPnl,
    closeReason: 'model_decision',
    openedAt: new Date(Date.parse(input.closedAt) - 3_600_000).toISOString(),
    closedAt: input.closedAt,
    ...(input.entryFee === undefined ? {} : { entryFee: input.entryFee }),
    ...(input.exitFee === undefined ? {} : { exitFee: input.exitFee }),
    ...(input.fundingFee === undefined ? {} : { fundingFee: input.fundingFee }),
  });
}

const isClose = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/* -------------------------------------------------------------------------- */
/*  等价重构：窗口覆盖全历史时，两个入口必须逐项相等                                */
/* -------------------------------------------------------------------------- */

test('★★★ 窗口全历史时 performanceSince 与 stats() 逐项一致 —— 合并 SQL 不得改变任何数字', () => {
  traderId = seedTrader();
  clearTrades();

  /*
   * fixture 覆盖全部四种分类：净赚（正）、净亏（负）、毛赚但手续费吃掉（净亏）、
   * 以及带资金费的一笔。这正是两份聚合 SQL 可能分叉的地方。
   */
  const at = (day: number): string => new Date(Date.UTC(2026, 0, day, 12)).toISOString();
  insertTrade({ grossPnl: 5, closedAt: at(1), entryFee: 0.1, exitFee: 0.1 });
  insertTrade({ grossPnl: -2, closedAt: at(2), entryFee: 0.08, exitFee: 0.08, fundingFee: -0.02 });
  insertTrade({ grossPnl: 0.001, closedAt: at(3), entryFee: 0.01, exitFee: 0.01 });
  insertTrade({ grossPnl: 1, closedAt: at(4), entryFee: 0.05, exitFee: 0.05 });

  const stats = tradeStore.stats(traderId);
  const performance = tradeStore.performanceSince(traderId, '1970-01-01T00:00:00.000Z');

  const shared: ReadonlyArray<keyof TradeStats & keyof TradePerformance> = [
    'totalTrades',
    'wins',
    'losses',
    'grossProfit',
    'grossLoss',
    'avgWin',
    'avgLoss',
    'grossPnl',
    'totalFees',
    'totalFunding',
    'netPnl',
  ];
  for (const key of shared) {
    assert.ok(
      isClose(stats[key], performance[key]),
      `★ ${key}: stats()=${stats[key]} 与 performanceSince()=${performance[key]} 不一致 —— ` +
        '两个入口必须说同一件事',
    );
  }

  /* 关键口径：毛赚但净亏的那一笔算亏 —— 合并 SQL 以后仍然如此。 */
  assert.equal(performance.wins, 2, '净赚的两笔（+5 与 +1）才是赢');
  assert.equal(performance.losses, 2, '毛 +0.001 被手续费吃掉的那笔必须算亏');
});

/* -------------------------------------------------------------------------- */
/*  窗口语义没有被合并弄丢                                                        */
/* -------------------------------------------------------------------------- */

test('★★★ performanceSince 只统计窗口内的成交（窗口边界含等号）', () => {
  traderId = seedTrader();
  clearTrades();

  const oldIso = '2026-01-01T12:00:00.000Z';
  const edgeIso = '2026-01-02T12:00:00.000Z';
  const newIso = '2026-01-03T12:00:00.000Z';
  insertTrade({ grossPnl: 10, closedAt: oldIso });
  insertTrade({ grossPnl: -1, closedAt: edgeIso });
  insertTrade({ grossPnl: 3, closedAt: newIso });

  const windowed = tradeStore.performanceSince(traderId, edgeIso);
  assert.equal(windowed.totalTrades, 2, '窗口含起点（closed_at >= sinceIso）');
  assert.ok(isClose(windowed.netPnl, 2), `窗口净盈亏应为 -1 + 3 = 2，得到 ${windowed.netPnl}`);

  const lifetime = tradeStore.stats(traderId);
  assert.equal(lifetime.totalTrades, 3, '终身口径仍然是全表');
  assert.ok(isClose(lifetime.netPnl, 12), `终身净盈亏应为 10 - 1 + 3 = 12，得到 ${lifetime.netPnl}`);
});

/* -------------------------------------------------------------------------- */
/*  notional 只在窗口口径里存在，且口径没变                                       */
/* -------------------------------------------------------------------------- */

test('★★ performanceSince 的 notional = Σ|入场价 × 数量|，往返费率 = 总手续费 / notional', () => {
  /*
   * 这个字段支撑 `roundTripFeeRate`（提示词里的"往返成本"），口径是
   * "两个总和相除"而不是"逐笔费率平均" —— 后者会给小额回合不合理的权重。
   * 合并 SQL 时把 `notional` 一起搬过去，这里钉住它的算式。
   */
  traderId = seedTrader();
  clearTrades();

  insertTrade({ grossPnl: 5, closedAt: '2026-01-01T12:00:00.000Z', entryFee: 0.1, exitFee: 0.1 });
  insertTrade({ grossPnl: -2, closedAt: '2026-01-02T12:00:00.000Z', entryFee: 0.05, exitFee: 0.05 });

  const performance = tradeStore.performanceSince(traderId, '1970-01-01T00:00:00.000Z');
  /* 夹具：entryPrice 100 × quantity 0.5 = 50/笔，两笔共 100。 */
  assert.ok(isClose(performance.notional, 100), `notional 应为 100，得到 ${performance.notional}`);
  assert.ok(isClose(performance.totalFees, 0.3), `总手续费应为 0.3，得到 ${performance.totalFees}`);
  assert.ok(
    performance.roundTripFeeRate !== null &&
      isClose(performance.roundTripFeeRate, 0.003),
    `往返费率应为 0.3/100 = 0.003，得到 ${performance.roundTripFeeRate}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  源码守卫：聚合 SQL 只有一份                                                   */
/* -------------------------------------------------------------------------- */

test('★★★ 聚合 SQL 只出现一次 —— performanceSince 不得再复制一份', () => {
  /*
   * ⚠️ 这条防线是给"下一次改动"的：两份副本的危险是有人只改一份。
   * 判据是那段 `SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END)` 在非测试源码里
   * **恰好出现一次**（在 `aggregateTradeTotals()` 里）。
   *
   * 边界（诚实说明）：它抓不住"用别的写法重新实现一遍聚合"；它抓的是最可能
   * 发生的那一种 —— 复制粘贴再改。
   */
  const file = fileURLToPath(new URL('./repositories.ts', import.meta.url));
  const source = readFileSync(file, 'utf8');
  const matches = source.match(/SUM\(CASE WHEN net_pnl >\s+0 THEN 1 ELSE 0 END\)/g) ?? [];
  assert.equal(
    matches.length,
    1,
    '★★★ 成交聚合 SQL 出现了 ' +
      matches.length +
      ' 次 —— 它只该有一份（`aggregateTradeTotals()`）。' +
      '窗口口径与终身口径都从那里取数，否则控制台与提示词的胜率会分叉。',
  );

  /* 前置断言：真的读到了这个文件（否则上面那条是空转）。 */
  assert.ok(source.includes('function aggregateTradeTotals('), '找不到 `aggregateTradeTotals()` —— 文件可能没读到');
});
