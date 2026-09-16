import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateTraderHealth,
  STARTUP_GRACE_MS,
  STALE_CYCLE_MULTIPLIER,
} from '../api/server.js';

/**
 * `/api/health` 的真实性契约。
 *
 * 这些用例存在的理由：这个端点是 Dockerfile 与 `deploy/docker-compose.yml` 的
 * **唯一**健康判据，而它原来的实现是无条件 `ok: true`。一个决策循环挂死、
 * 或者事件循环被同步 SQLite 阻塞的进程，在编排器看来永远健康 ——
 * 不告警、不重启，而账户上可能还有持仓。
 *
 * 反过来，一个**误报**的检查比没有检查更糟：容器会被反复重启，而重启会打断
 * 正在进行的一轮决策。所以下面每一条边界都有对应的用例 ——
 * 暂停的机器人、停掉的机器人、正在跑第一轮的机器人，都不许让它变红。
 */

const MINUTE = 60_000;

function trader(
  overrides: Partial<{
    id: number;
    name: string;
    status: 'running' | 'stopped' | 'starting' | 'error' | 'safe_mode';
    lastCycleAt: string | null;
    cycleIntervalMinutes: number;
  }> = {},
) {
  return {
    id: 1,
    name: 'trader',
    status: 'running' as const,
    lastCycleAt: null,
    cycleIntervalMinutes: 15,
    ...overrides,
  };
}

/**
 * 阈值取 `max(周期 × 2, 启动宽限)`，所以对 15 分钟周期的机器人来说，
 * "卡住"的判定要等到 10 分钟——启动宽限是**下界**，不是"启动后 5 分钟内豁免"。
 * 见 `evaluateTraderHealth()`：这样冷启动和长周期机器人用的是同一个规则。
 */
function afterThreshold(cycleIntervalMinutes = 15, extraMs = MINUTE): string {
  const thresholdMs = Math.max(
    cycleIntervalMinutes * MINUTE * STALE_CYCLE_MULTIPLIER,
    STARTUP_GRACE_MS,
  );
  return new Date(Date.now() - thresholdMs - extraMs).toISOString();
}

test('a running trader inside its threshold keeps health green', () => {
  const now = Date.now();
  const verdict = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 5 * MINUTE).toISOString() })],
    now,
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.stale.length, 0);
});

test('a running trader past its max(2 cycles, startup grace) threshold degrades health', () => {
  const now = Date.now();
  // 15-minute cycle → threshold is max(30 min, 5 min) = 30 min.
  const verdict = evaluateTraderHealth(
    [trader({ lastCycleAt: afterThreshold(15) })],
    now,
  );
  assert.equal(verdict.ok, false, 'a hung loop must make /api/health non-200');
  assert.equal(verdict.stale.length, 1);
  assert.equal(verdict.stale[0]?.traderId, 1);
  assert.equal(verdict.stale[0]?.awaitingFirstCycle, false);
});

test('the threshold is 2 cycles, not 1 — a slow cycle must not flap', () => {
  const now = Date.now();
  /*
   * One full cycle plus a little is **not** enough to flag. `last_cycle_at` is
   * written only when a cycle finishes, so a cycle that overruns (slow model,
   * slow exchange) legitimately leaves the timestamp close to one full interval
   * old. Flagging there would alert on every ordinary slow cycle, and an alert
   * that fires on normal operation is an alert operators learn to ignore.
   */
  const justOverOneCycle = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 16 * MINUTE).toISOString() })],
    now,
  );
  assert.equal(justOverOneCycle.ok, true);

  // Just inside the 2-cycle threshold is still green.
  const justUnderTwo = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 29 * MINUTE).toISOString() })],
    now,
  );
  assert.equal(justUnderTwo.ok, true);

  assert.equal(STALE_CYCLE_MULTIPLIER, 2);
});

test('a paused (safe_mode) trader never degrades health', () => {
  const now = Date.now();
  const verdict = evaluateTraderHealth(
    [
      trader({
        status: 'safe_mode',
        lastCycleAt: new Date(now - 10 * 24 * 60 * MINUTE).toISOString(),
      }),
    ],
    now,
  );
  assert.equal(verdict.ok, true, 'safe_mode still runs the loop and reports its own error');
  assert.equal(verdict.traders[0]?.stale, false);
});

test('a stopped trader never degrades health', () => {
  const now = Date.now();
  const verdict = evaluateTraderHealth(
    [trader({ status: 'stopped', lastCycleAt: new Date(now - 365 * 24 * 60 * MINUTE).toISOString() })],
    now,
  );
  assert.equal(verdict.ok, true, 'stopping a bot is an operator decision, not a fault');
});

test('a starting trader never degrades health', () => {
  const now = Date.now();
  const verdict = evaluateTraderHealth([trader({ status: 'starting', lastCycleAt: null })], now);
  assert.equal(verdict.ok, true);
});

test('an error trader that is not running does not make health red', () => {
  const now = Date.now();
  // `error` is already surfaced through the trader row and /api/system's
  // failedTraders — reporting it as *unhealthy* would restart the container,
  // which does not fix a rejected API key and does interrupt a healthy loop.
  const verdict = evaluateTraderHealth([trader({ status: 'error', lastCycleAt: null })], now);
  assert.equal(verdict.ok, true);
});

test('a trader running its very first cycle is tolerated for the startup grace period', () => {
  const now = Date.now();
  const startedAt = new Map([[1, now - 60_000]]);
  const verdict = evaluateTraderHealth([trader({ lastCycleAt: null })], now, startedAt);
  assert.equal(verdict.ok, true, 'a cold start must not fail the container healthcheck');
  assert.equal(verdict.traders[0]?.awaitingFirstCycle, true);
});

test('a trader that never completes a first cycle eventually degrades health', () => {
  const now = Date.now();
  // Grace is a *floor* on the threshold, so the timeout is
  // max(15 × 2 min, 5 min) = 30 min of running without a single finished cycle.
  const startedAt = new Map([[1, now - (30 * MINUTE + MINUTE)]]);
  const verdict = evaluateTraderHealth([trader({ lastCycleAt: null })], now, startedAt);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.stale[0]?.awaitingFirstCycle, true);
});

test('the grace period is measured per trader, not from process start', () => {
  const now = Date.now();
  // Trader 2 started one minute ago; the process itself has been up for hours.
  // A global uptime anchor would flag it immediately, and would keep flagging
  // every newly started trader for the first five minutes of its life.
  const startedAt = new Map([[2, now - MINUTE]]);
  const verdict = evaluateTraderHealth([trader({ id: 2, lastCycleAt: null })], now, startedAt);
  assert.equal(verdict.ok, true);
});

test('a short-interval trader is still protected by the startup grace floor', () => {
  const now = Date.now();
  /*
   * A 1-minute cycle has a raw threshold of only 2 minutes. Without the 5-minute
   * floor, a cold start would fail the container healthcheck before the first
   * cycle could possibly finish — fetching klines for 20 symbols and calling the
   * model takes longer than two minutes on a slow day.
   */
  const justInside = evaluateTraderHealth(
    [trader({ cycleIntervalMinutes: 1, lastCycleAt: new Date(now - 4 * MINUTE).toISOString() })],
    now,
  );
  assert.equal(justInside.ok, true);

  const justOutside = evaluateTraderHealth(
    [trader({ cycleIntervalMinutes: 1, lastCycleAt: new Date(now - 6 * MINUTE).toISOString() })],
    now,
  );
  assert.equal(justOutside.ok, false);
});

test('only the stale running traders are listed, and every trader is reported', () => {
  const now = Date.now();
  const verdict = evaluateTraderHealth(
    [
      trader({ id: 1, name: 'hung', lastCycleAt: new Date(now - 90 * MINUTE).toISOString() }),
      trader({ id: 2, name: 'fine', lastCycleAt: new Date(now - MINUTE).toISOString() }),
      trader({ id: 3, name: 'off', status: 'stopped', lastCycleAt: null }),
    ],
    now,
  );
  assert.deepEqual(
    verdict.stale.map((entry) => entry.traderId),
    [1],
  );
  assert.equal(verdict.traders.length, 3, 'the full picture stays available for the console');
});
