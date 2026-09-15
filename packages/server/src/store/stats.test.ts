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
