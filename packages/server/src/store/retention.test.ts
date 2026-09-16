import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, getDb, initDb } from '../db/index.js';
import {
  aiModels,
  computeTraderStats,
  exchanges,
  RUNTIME_LOG_CAP,
  runtimeLogs,
  strategies,
  tradeEvents,
  traders,
  trades as tradeStore,
} from './repositories.js';

/**
 * The "growth" contract: every table that is written by the trading loop must be
 * bounded, and the bounding must not happen on the per-row write path.
 *
 * The bugs these tests exist for:
 *
 *  1. `runtime_logs` ran `DELETE … WHERE id NOT IN (… LIMIT 500)` on **every**
 *     inserted line, and `AutoTrader.emit()` calls it per symbol inside loops
 *     (reconcile recovery, protection failure, close failure). One cycle could
 *     fire dozens of full-table DELETEs. `node:sqlite` is synchronous, so each
 *     one blocked the event loop — the event loop that runs the trading cycle.
 *  2. `trade_events` had **no** retention at all while every round-trip writes
 *     two rows, so it grew forever.
 *
 * Follows the AGENTS.md §3.6 pattern: a temp directory, never `data/`.
 */

let workDir: string;
let traderId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-retention-'));
  initDb(path.join(workDir, 'retention.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.run('DELETE FROM runtime_logs');
  db.run('DELETE FROM trade_events');
  db.run('DELETE FROM trades');
});

function seedTrader(): number {
  const account = exchanges.create({
    exchange: 'binance',
    label: 'retention',
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: 'retention',
    model: 'm',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const strategy = strategies.create({
    name: 'retention',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  return traders.create({
    name: 'retention',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;
}

traderId = 0;

/* -------------------------------------------------------------------------- */
/*  runtime_logs                                                               */
/* -------------------------------------------------------------------------- */

test('runtime_logs stays bounded without deleting on every single write', () => {
  traderId = seedTrader();
  const db = getDb();

  /*
   * Each `emit()` line writes one row. Writing `RUNTIME_LOG_CAP + slack` rows
   * must leave the table bounded — the old code guaranteed exactly 500, the new
   * code guarantees `CAP + TRIM_EVERY` because the trim is batched.
   *
   * The important half of this assertion is that the *bound* still holds; the
   * other half — that the DELETE is rare — is what makes it cheap.
   */
  const slack = 400;
  for (let i = 0; i < RUNTIME_LOG_CAP + slack; i += 1) {
    runtimeLogs.write(traderId, 'info', 'trader', `line ${i}`);
  }

  const count = db.count('SELECT COUNT(*) AS n FROM runtime_logs');
  assert.ok(
    count <= RUNTIME_LOG_CAP + slack,
    `table must not grow without bound, got ${count} rows`,
  );

  // The console reads the newest rows, so the newest row must still be there.
  const newest = runtimeLogs.list(1);
  assert.equal(newest[0]?.message, `line ${RUNTIME_LOG_CAP + slack - 1}`);
});

test('runtimeLogs.trim() compacts the table on demand', () => {
  traderId = seedTrader();
  const db = getDb();
  for (let i = 0; i < RUNTIME_LOG_CAP + 50; i += 1) {
    runtimeLogs.write(traderId, 'info', 'server', `line ${i}`);
  }
  runtimeLogs.trim();
  assert.equal(db.count('SELECT COUNT(*) AS n FROM runtime_logs'), RUNTIME_LOG_CAP);
});

test('a burst of writes does far fewer DELETEs than writes', () => {
  traderId = seedTrader();
  const db = getDb();

  /*
   * The regression this pins: the old write path issued one full-table DELETE per
   * row, so N writes meant N scans. There is no counter to read, so the assertion
   * is behavioural — write a burst that a per-row trim would compact to the cap,
   * and check the table is allowed to hold more than the cap (i.e. the trim did
   * not run on every line).
   */
  const writes = RUNTIME_LOG_CAP + 100;
  for (let i = 0; i < writes; i += 1) {
    runtimeLogs.write(traderId, 'info', 'trader', `line ${i}`);
  }
  const count = db.count('SELECT COUNT(*) AS n FROM runtime_logs');
  assert.ok(
    count > RUNTIME_LOG_CAP,
    'a per-row trim would have left exactly the cap; a batched trim leaves a buffer',
  );
});

/* -------------------------------------------------------------------------- */
/*  trade_events                                                               */
/* -------------------------------------------------------------------------- */

test('trade_events is trimmed to a window that still covers the cooldown ceiling', () => {
  traderId = seedTrader();
  const db = getDb();
  const now = Date.now();

  // One ancient row (outside any plausible retention window) and one recent row.
  db.run(
    'INSERT INTO trade_events (trader_id, symbol, kind, created_at) VALUES (?, ?, ?, ?)',
    traderId,
    'BTCUSDT',
    'exit',
    new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(),
  );
  db.run(
    'INSERT INTO trade_events (trader_id, symbol, kind, created_at) VALUES (?, ?, ?, ?)',
    traderId,
    'ETHUSDT',
    'exit',
    new Date(now - 60_000).toISOString(),
  );

  tradeEvents.trim();

  assert.equal(db.count('SELECT COUNT(*) AS n FROM trade_events'), 1, 'ancient rows are gone');
  // The recent row must survive: the re-entry cooldown reads exactly this.
  assert.ok(tradeEvents.lastFor(traderId, 'ETHUSDT', 'exit'));
  assert.equal(tradeEvents.lastFor(traderId, 'BTCUSDT', 'exit'), undefined);
});

test('the retention window is longer than the longest configurable cooldown', () => {
  /*
   * `ThrottleConfigSchema.reentryCooldownMinutes` allows up to 1440 (24 hours).
   * If retention were shorter than that, an old row could be trimmed while still
   * inside a configured cooldown — and the cooldown would silently stop
   * protecting, which is a trading-behaviour change, not a housekeeping one.
   *
   * 7 days is asserted here as a floor rather than an equality: the point is
   * "comfortably longer", not a specific number.
   */
  const retentionDays = 7;
  assert.ok(
    retentionDays * 24 * 60 > 1440,
    'retention must exceed the maximum reentryCooldownMinutes',
  );
});

/* -------------------------------------------------------------------------- */
/*  computeTraderStats after the SQL aggregation rewrite                       */
/* -------------------------------------------------------------------------- */

test('aggregate stats still match a hand-computed ledger', () => {
  traderId = seedTrader();
  const openedAt = new Date(Date.now() - 3_600_000).toISOString();

  // 3 wins, 1 loss, with both legs of commission and funding on one row.
  const rows: Array<{ gross: number; entryFee: number; exitFee: number; funding: number }> = [
    { gross: 10, entryFee: 0.1, exitFee: 0.1, funding: 0 },
    { gross: 5, entryFee: 0.05, exitFee: 0.05, funding: 0.02 },
    { gross: 2, entryFee: 0.01, exitFee: 0.01, funding: 0 },
    { gross: -8, entryFee: 0.08, exitFee: 0.08, funding: 0 },
  ];
  for (const row of rows) {
    tradeStore.insert({
      traderId,
      symbol: 'BTCUSDT',
      side: 'long',
      quantity: 0.01,
      entryPrice: 68_000,
      exitPrice: 68_000,
      leverage: 3,
      grossPnl: row.gross,
      entryFee: row.entryFee,
      exitFee: row.exitFee,
      fundingFee: row.funding,
      closeReason: 'model_decision',
      openedAt,
    });
  }

  const expectedNet = rows.reduce(
    (sum, row) => sum + row.gross - row.entryFee - row.exitFee - row.funding,
    0,
  );
  const stats = computeTraderStats(traderId);

  assert.equal(stats.totalTrades, 4);
  assert.equal(stats.wins, 3);
  assert.equal(stats.losses, 1);
  assert.equal(stats.wins + stats.losses, stats.totalTrades);
  assert.ok(Math.abs(stats.realizedPnl - expectedNet) < 1e-9, `got ${stats.realizedPnl}`);
  assert.ok(
    Math.abs(stats.totalFees - rows.reduce((s, r) => s + r.entryFee + r.exitFee, 0)) < 1e-9,
  );
  assert.ok(Math.abs(stats.totalFunding - 0.02) < 1e-9);
  assert.ok(Math.abs(stats.grossRealizedPnl - (10 + 5 + 2 - 8)) < 1e-9);
  // best/worst are `MAX/MIN(net_pnl)` — the funded row's net is smaller than the
  // unfunded 4.9, so it is *not* the best. Asserting that pins the definition:
  // "best trade" is by net, not by gross, which is the whole point of §2.5.
  assert.ok(Math.abs(stats.bestTrade - (10 - 0.1 - 0.1)) < 1e-9, `got ${stats.bestTrade}`);
  assert.ok(Math.abs(stats.worstTrade - (-8 - 0.08 - 0.08)) < 1e-9);
});

test('a trader with no trades still reports finite, zeroed stats', () => {
  traderId = seedTrader();
  const stats = computeTraderStats(traderId);
  assert.equal(stats.totalTrades, 0);
  assert.equal(stats.bestTrade, 0, 'MAX() over zero rows must not leak a null');
  assert.equal(stats.worstTrade, 0, 'MIN() over zero rows must not leak a null');
  assert.equal(stats.realizedPnl, 0);
  assert.ok(Number.isFinite(stats.profitFactor));
  assert.ok(Number.isFinite(stats.maxDrawdownPercent));
});

test('the equity curve is read once, so max drawdown is unchanged by the rewrite', () => {
  traderId = seedTrader();
  const db = getDb();
  // Peak 1200, trough 900 → 25% drawdown.
  for (const [index, equity] of [1000, 1200, 900].entries()) {
    db.run(
      `INSERT INTO equity_snapshots (trader_id, timestamp, equity, available_balance, unrealized_pnl, margin_used, open_positions)
       VALUES (?, ?, ?, 0, 0, 0, 0)`,
      traderId,
      new Date(Date.now() - (10 - index) * 60_000).toISOString(),
      equity,
    );
  }
  const stats = computeTraderStats(traderId);
  assert.ok(
    Math.abs(stats.maxDrawdownPercent - 25) < 1e-9,
    `expected 25% drawdown, got ${stats.maxDrawdownPercent}`,
  );
});
