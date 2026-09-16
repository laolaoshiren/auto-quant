import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, initDb } from '../db/index.js';
import {
  aiModels,
  computeTraderStats,
  equity as equityStore,
  exchanges,
  strategies,
  traders,
  trades as tradeStore,
} from './repositories.js';

/**
 * Statistics contract.
 *
 * The bug these tests exist for: `TraderStats.winRate` carried a percentage
 * (0–100) while three console pages read it as a fraction (0–1) and multiplied
 * by 100 again, so one win out of one trade rendered as **10000.0%**. Two places
 * also *derived* the win/loss counts from that percentage, turning 1 closed trade
 * into "100 盈".
 *
 * The field is now `winRatePercent` and the counts are sent explicitly. These
 * assertions pin the scale and the counts so neither mistake can return silently.
 */

let workDir: string;
let traderId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-stats-'));
  initDb(path.join(workDir, 'stats.sqlite'));
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
    name: 'stats',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;
}

function insertTrade(pnl: number, costs: { entryFee?: number; exitFee?: number; fundingFee?: number } = {}): void {
  tradeStore.insert({
    traderId,
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 0.01,
    entryPrice: 68_000,
    exitPrice: pnl >= 0 ? 68_000 + pnl * 100 : 68_000 + pnl * 100,
    leverage: 3,
    grossPnl: pnl,
    closeReason: 'model_decision',
    openedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...costs,
  });
}

/* -------------------------------------------------------------------------- */
/*  Net accounting                                                             */
/* -------------------------------------------------------------------------- */

test('net PnL subtracts fees and funding from the exchange gross figure', () => {
  traderId = seedTrader();
  clearTrades();

  // Real shape from a live round-trip.
  tradeStore.insert({
    traderId,
    symbol: 'POWERUSDT',
    side: 'long',
    quantity: 131,
    entryPrice: 0.18064,
    exitPrice: 0.18565,
    leverage: 5,
    grossPnl: 0.65631,
    entryFee: 0.01183192,
    exitFee: 0.01216007,
    fundingFee: 0.002,
    closeReason: 'reconciled',
    openedAt: new Date(Date.now() - 7_200_000).toISOString(),
    source: 'reconciled',
  });

  const [trade] = tradeStore.list(traderId, 1);
  assert.ok(trade);
  assert.equal(trade.pnl, 0.65631, 'pnl stays the exchange gross figure');
  assert.ok(Math.abs(trade.fee - (0.01183192 + 0.01216007)) < 1e-9, 'fee is both legs');
  assert.equal(trade.fundingFee, 0.002);
  assert.equal(trade.source, 'reconciled');
  // The number that actually moved the balance.
  const expected = 0.65631 - (0.01183192 + 0.01216007) - 0.002;
  assert.ok(Math.abs(trade.netPnl - expected) < 1e-9, `got ${trade.netPnl}, want ${expected}`);
});

test('a trade that is gross-positive but net-negative counts as a loss', () => {
  traderId = seedTrader();
  clearTrades();

  // Made 0.001 on price, paid 0.02 in commission. Reporting this as a win would
  // flatter both the win rate and the profit factor.
  insertTrade(0.001, { entryFee: 0.01, exitFee: 0.01 });

  const stats = computeTraderStats(traderId);
  assert.equal(stats.totalTrades, 1);
  assert.equal(stats.wins, 0, 'a net loss is a loss');
  assert.equal(stats.losses, 1);
  assert.equal(stats.winRatePercent, 0);
  assert.ok(stats.realizedPnl < 0, `net must be negative, got ${stats.realizedPnl}`);
  assert.ok(Math.abs(stats.grossRealizedPnl - 0.001) < 1e-12, 'gross is still reported separately');
  assert.ok(Math.abs(stats.totalFees - 0.02) < 1e-12);
});

test('the aggregate breakdown adds up to the net figure', () => {
  traderId = seedTrader();
  clearTrades();

  insertTrade(5, { entryFee: 0.1, exitFee: 0.1 });
  insertTrade(-2, { entryFee: 0.08, exitFee: 0.08, fundingFee: 0.02 });
  insertTrade(1, { entryFee: 0.05, exitFee: 0.05 });

  const stats = computeTraderStats(traderId);
  const derived = stats.grossRealizedPnl - stats.totalFees - stats.totalFunding;
  assert.ok(
    Math.abs(stats.realizedPnl - derived) < 1e-9,
    `realizedPnl ${stats.realizedPnl} must equal gross − fees − funding = ${derived}`,
  );
  assert.ok(Math.abs(stats.totalFees - 0.46) < 1e-9, `got ${stats.totalFees}`);
  assert.ok(Math.abs(stats.totalFunding - 0.02) < 1e-9);
});

/** Wipe the trade table between cases. */
function clearTrades(): void {
  initDb(path.join(workDir, 'stats.sqlite')).run('DELETE FROM trades');
}

/* -------------------------------------------------------------------------- */
/*  Circuit-breaker high-water mark                                            */
/* -------------------------------------------------------------------------- */

test('the drawdown watermark ignores unrealised profit', () => {
  /*
   * Why this test exists (D2).
   *
   * The breaker's watermark was `MAX(equity)` over the snapshots, and snapshot
   * `equity` is the **margin balance** — it carries the open positions'
   * unrealised PnL. So one unrealised spike (a price wick on an open position)
   * raised the watermark permanently: when the wick retraced, equity came back to
   * the baseline, and every later cycle computed a drawdown that never happened.
   * `maxTotalDrawdownPercent` then refused to open anything, forever, with only a
   * log line to say why.
   *
   * `equity − unrealized_pnl` is what the balance would be with open positions
   * marked at their entry: it only moves when something is actually closed.
   */
  traderId = seedTrader();
  const db = initDb(path.join(workDir, 'stats.sqlite'));
  db.run('DELETE FROM equity_snapshots');

  const snapshot = (equity: number, unrealizedPnl: number): void =>
    equityStore.insert({
      traderId,
      timestamp: new Date().toISOString(),
      equity,
      availableBalance: equity,
      unrealizedPnl,
      marginUsed: 0,
      openPositions: unrealizedPnl === 0 ? 0 : 1,
      // 高水位读的是**账户**两列（`equity` 自 M4 起是本机器人归属口径），所以
      // fixture 里账户权益就是这里给的 1000/1100/1000，未实现盈亏同理。
      accountEquity: equity,
      accountUnrealizedPnl: unrealizedPnl,
    });

  snapshot(1000, 0);
  snapshot(1100, 100); // the wick: +100 of *unrealised* profit
  snapshot(1000, 0); // it retraces

  assert.equal(
    equityStore.realizedHighWaterMark(traderId),
    1000,
    'a spike in unrealised PnL must not raise the watermark',
  );

  // A genuine realised gain still does raise it — the fix must not defang the
  // breaker, only stop it counting money that was never booked.
  snapshot(1050, 0);
  assert.equal(equityStore.realizedHighWaterMark(traderId), 1050);
});

/* -------------------------------------------------------------------------- */
/*  Attributed equity                                                          */
/* -------------------------------------------------------------------------- */

test('权益按归属口径现算：没成交过的机器人是平的，共账户的机器人互不影响', () => {
  /*
   * Why this test exists.
   *
   * `equity_snapshots.equity` 曾经直接写共享钱包的余额（`broker.getAccountState()`），
   * `computeTraderStats` 又照读它 —— 同一个交易所账户下的每个机器人因此都显示账户
   * 的数字。实盘上量到：一个 **0 笔平仓、净 0.000000** 的机器人显示 +2.67%，而另一
   * 个机器人显示完全相同的 +2.67%；两者读的是同一个钱包。
   *
   * 这里刻意把两条快照都写成**同一个账户数字**（模拟 M4 之前留下的存量行），断言
   * 权益仍然按各自的账本现算 —— 归属口径不依赖快照里存了什么。
   */
  const traded = seedTrader();
  const idle = seedTrader();
  const db = initDb(path.join(workDir, 'stats.sqlite'));
  db.run('DELETE FROM equity_snapshots');
  db.run('DELETE FROM trades');

  for (const id of [traded, idle]) {
    equityStore.insert({
      traderId: id,
      timestamp: new Date().toISOString(),
      equity: 1200,
      availableBalance: 1200,
      unrealizedPnl: 0,
      marginUsed: 0,
      openPositions: 0,
      accountEquity: 1200,
      accountUnrealizedPnl: 0,
    });
  }

  traderId = traded;
  insertTrade(50);

  const tradedStats = computeTraderStats(traded);
  assert.equal(tradedStats.equity, 1050, '初始 1000 + 本机器人净 50');
  assert.equal(tradedStats.totalReturnPercent, 5);
  // 权益、已实现、浮盈三者必须自洽：equity = initialEquity + realizedPnl + unrealizedPnl。
  assert.equal(
    tradedStats.equity,
    tradedStats.initialEquity + tradedStats.realizedPnl + tradedStats.unrealizedPnl,
  );

  const idleStats = computeTraderStats(idle);
  assert.equal(idleStats.equity, 1000, '没有成交过的机器人必须停在初始权益上');
  assert.equal(idleStats.totalReturnPercent, 0);
  assert.equal(idleStats.realizedPnl, 0);
  assert.equal(idleStats.unrealizedPnl, 0);
  // 账户权益对两个机器人是**同一个数**，所以它必须单独给出，而不是冒充某一个人的权益。
  assert.equal(idleStats.accountEquity, 1200);
  assert.equal(tradedStats.accountEquity, idleStats.accountEquity);
  assert.notEqual(idleStats.accountEquity, idleStats.equity);
});

test('winRatePercent is a percentage, not a fraction', () => {
  traderId = seedTrader();
  clearTrades();

  // The exact shape of the reported bug: one win, one trade.
  insertTrade(5);

  const stats = computeTraderStats(traderId);
  assert.equal(stats.totalTrades, 1);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 0);
  // One win out of one is 100 (percent). It rendered as 10000 before the fix.
  assert.equal(stats.winRatePercent, 100);
  assert.ok(
    stats.winRatePercent <= 100,
    `a win rate must never exceed 100, got ${stats.winRatePercent}`,
  );
});

test('the win and loss counts are the real trade counts', () => {
  traderId = seedTrader();
  clearTrades();

  insertTrade(12);
  insertTrade(7);
  insertTrade(-4);

  const stats = computeTraderStats(traderId);
  assert.equal(stats.totalTrades, 3);
  assert.equal(stats.wins, 2);
  assert.equal(stats.losses, 1);
  assert.equal(stats.wins + stats.losses, stats.totalTrades, 'counts must account for every trade');
  // 2/3 = 66.67%, rounded by the caller for display.
  assert.ok(Math.abs(stats.winRatePercent - 66.6667) < 0.01, `got ${stats.winRatePercent}`);
});

test('a losing-only record reports 0% and not a negative or NaN rate', () => {
  traderId = seedTrader();
  clearTrades();

  insertTrade(-10);

  const stats = computeTraderStats(traderId);
  assert.equal(stats.winRatePercent, 0);
  assert.equal(stats.wins, 0);
  assert.equal(stats.losses, 1);
});

test('a trader with no closed trades reports zeroes rather than dividing by zero', () => {
  traderId = seedTrader();
  clearTrades();

  const stats = computeTraderStats(traderId);
  assert.equal(stats.totalTrades, 0);
  assert.equal(stats.wins, 0);
  assert.equal(stats.losses, 0);
  assert.equal(stats.winRatePercent, 0);
  assert.ok(Number.isFinite(stats.profitFactor), 'profitFactor must not be NaN');
});
