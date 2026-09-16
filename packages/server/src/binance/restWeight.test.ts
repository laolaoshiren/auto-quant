import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BinanceRest,
  decayWeight,
  MAX_IN_FLIGHT_REQUESTS,
  WEIGHT_LIMIT_DEFAULT,
  WEIGHT_WINDOW_MS,
} from './rest.js';

/**
 * Request-weight admission control.
 *
 * Two bugs are pinned here, and they are the same bug seen from two sides —
 * the weight budget was read but never *enforced*:
 *
 *  1. **Fan-out ignored the budget.** `respectWeightBudget()` consulted the last
 *     observed `X-MBX-USED-WEIGHT-1M` header. Every member of a `Promise.all`
 *     checked the same stale value before any response came back, so 30–40
 *     concurrent calls (the kline fan-out in `market/service.ts` is 30 symbols ×
 *     4 timeframes) all left at once no matter how much budget was left. The only
 *     remaining backstop was Binance's own 429 — and a 418 after it is an IP ban.
 *
 *  2. **A response without the header stalled the client.** Several responses
 *     legitimately omit `x-mbx-used-weight-1m`; a 429 is the important one,
 *     because that is exactly when the counter is highest. Because only a header
 *     ever reset `usedWeight1m`, the stale high reading survived and *every*
 *     subsequent request slept `min(remaining, 10s)` until some unrelated
 *     header-bearing response happened to arrive.
 *
 * These tests talk to no network: `fetch` is replaced, which is also what makes
 * the concurrency behaviour observable (each fake request stays open until the
 * test releases it, so "in flight" is directly measurable).
 */

interface Deferred {
  resolve: (response: Response) => void;
}

let pending: Deferred[] = [];
let weightHeader: string | null = null;
let originalFetch: typeof globalThis.fetch;
let maxConcurrentlyOpen = 0;
let opened = 0;

function jsonResponse(body: unknown, status = 200): Response {
  const headers = new Headers();
  if (weightHeader !== null) headers.set('x-mbx-used-weight-1m', weightHeader);
  return new Response(JSON.stringify(body), { status, headers });
}

beforeEach(() => {
  pending = [];
  weightHeader = null;
  opened = 0;
  maxConcurrentlyOpen = 0;

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    opened += 1;
    maxConcurrentlyOpen = Math.max(maxConcurrentlyOpen, opened);
    return new Promise<Response>((resolve) => {
      pending.push({
        resolve: (response) => {
          opened -= 1;
          resolve(response);
        },
      });
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeRest(maxInFlight?: number): BinanceRest {
  return new BinanceRest({
    environment: 'production',
    ...(maxInFlight === undefined ? {} : { maxInFlight }),
  });
}

/** Let the microtask/macrotask queue run so queued requests can take slots. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('fan-out is capped at the configured in-flight width', async () => {
  const rest = makeRest(3);

  // Ten concurrent public calls: the same shape as `buildSnapshots()` fanning out
  // one request per symbol per timeframe.
  const calls = Array.from({ length: 10 }, (_, index) => rest.publicGet(`/fapi/v1/x${index}`));

  await settle();
  assert.equal(
    rest.inFlightCount,
    3,
    'only the cap may be in flight, however wide the caller fans out',
  );
  assert.equal(maxConcurrentlyOpen, 3);
  assert.equal(opened, 3, 'the remaining seven must not have left yet');

  // Release everything; the queue drains and every call resolves.
  while (pending.length > 0) {
    const batch = pending;
    pending = [];
    for (const deferred of batch) deferred.resolve(jsonResponse({ ok: true }));
    await settle();
  }
  await Promise.all(calls);
  assert.equal(rest.inFlightCount, 0, 'every slot must be released');
  assert.equal(opened, 0);
});

test('the default fan-out ceiling is the exported constant', async () => {
  const rest = makeRest();
  assert.equal(rest.maxInFlightPerRequest, MAX_IN_FLIGHT_REQUESTS);
  assert.equal(rest.maxInFlightPerRequest, 6);
});

test('a slot is released on failure, so a failing request cannot wedge the queue', async () => {
  const rest = makeRest(1);

  const first = rest.publicGet('/fapi/v1/fail');
  await settle();
  assert.equal(rest.inFlightCount, 1);

  // A rejected request must free its slot, otherwise one error starves every
  // later request for the life of the process.
  pending.shift()?.resolve(jsonResponse({ code: -1121, msg: 'Invalid symbol.' }, 400));
  await assert.rejects(first);
  await settle();
  assert.equal(rest.inFlightCount, 0, 'a failed request must release its slot');
});

/* -------------------------------------------------------------------------- */
/*  Weight decay (F9)                                                          */
/* -------------------------------------------------------------------------- */

test('a reading decays to zero over its own minute, so a missing header cannot stall forever', () => {
  /*
   * The F9 bug: a response reports weight at the ceiling, then a 429 arrives that
   * (as Binance does) omits `x-mbx-used-weight-1m`. Under the old code nothing
   * ever reset the counter, so *every* later request slept `min(remaining, 10s)`
   * until some unrelated header-bearing response happened to arrive and clear it.
   * A 10-second stall per request is a stalled trading loop.
   */
  const ceiling = WEIGHT_LIMIT_DEFAULT;
  const windowStart = 1_000_000;

  assert.equal(decayWeight(ceiling, windowStart, windowStart), ceiling, 'starts fully charged');

  // Half the window gone → half the charge. This is what lets a request through
  // again instead of waiting for an unrelated response to save it.
  assert.equal(decayWeight(ceiling, windowStart, windowStart + 30_000), ceiling / 2);

  // The window has elapsed: the reading belongs to a closed minute and is no
  // longer charged at all.
  assert.equal(decayWeight(ceiling, windowStart, windowStart + WEIGHT_WINDOW_MS), 0);
  assert.equal(decayWeight(ceiling, windowStart, windowStart + 5 * WEIGHT_WINDOW_MS), 0);
});

test('decay is monotonic and never exceeds the observed reading', () => {
  // The estimate must stay conservative: over-estimating costs a little speed,
  // under-estimating sends a burst straight into a 429 and then a 418 IP ban.
  const windowStart = 5_000_000;
  let previous = Number.POSITIVE_INFINITY;
  for (let elapsed = 0; elapsed <= WEIGHT_WINDOW_MS; elapsed += 5_000) {
    const charge = decayWeight(1_800, windowStart, windowStart + elapsed);
    assert.ok(charge <= 1_800, `charge ${charge} must not exceed the reading`);
    assert.ok(charge <= previous, 'the charge must never increase with elapsed time');
    previous = charge;
  }
  assert.equal(previous, 0);
});

test('an unanchored reading is trusted rather than discarded', () => {
  // No header has ever arrived, so there is no window to decay against. Treating
  // it as zero would let a cold client burst past a limit it has already partly
  // spent.
  assert.equal(decayWeight(700, 0, 123_456), 700);
});

test('a nonsensical reading decays to nothing instead of producing NaN', () => {
  const windowStart = 10_000;
  assert.equal(decayWeight(0, windowStart, windowStart + 1), 0);
  assert.equal(decayWeight(Number.NaN, windowStart, windowStart + 1), 0);
  // A response timestamped "before" the window opened cannot happen, but if the
  // clock steps backwards the reading must not be inflated above its raw value.
  assert.equal(decayWeight(500, windowStart, windowStart - 60_000), 500);
});

test('a lower reading replaces the estimate instead of accumulating on top of it', async () => {
  /*
   * Why this matters: the counter dropping is the only unambiguous signal that
   * Binance opened a new minute. Our own wall-clock minute would be phase-blind —
   * Binance's boundary is not ours — so a rollover must be detected from the
   * value, and the estimate must follow the new value down rather than being
   * averaged or accumulated with the old one. If it did accumulate, a client that
   * had once spent its budget would stay throttled forever.
   *
   * (The *timing* consequence of the old stall — `min(remaining, 10s)` on every
   * request — is covered deterministically by the `decayWeight` cases above; this
   * case pins the value handling, which is what a real client observes as
   * `usedWeight1m`.)
   */
  const rest = makeRest(1);

  weightHeader = '1200';
  const a = rest.publicGet('/fapi/v1/a');
  await settle();
  pending.shift()?.resolve(jsonResponse({}));
  await a;
  assert.equal(rest.usedWeight1m, 1200);

  // A later response reporting far less must lower the estimate, not add to it.
  weightHeader = '40';
  const b = rest.publicGet('/fapi/v1/b');
  await settle();
  pending.shift()?.resolve(jsonResponse({}));
  await b;
  assert.equal(rest.usedWeight1m, 40, 'a lower reading must replace the old one');

  // And a subsequent header-less response (the 429 shape) must not block behind a
  // window that is no longer anywhere near the soft limit.
  const startedAt = Date.now();
  weightHeader = null;
  const c = rest.publicGet('/fapi/v1/c');
  await settle();
  pending.shift()?.resolve(jsonResponse({}));
  await c;
  assert.ok(
    Date.now() - startedAt < 1_000,
    'a reading far below the soft limit must not inherit an old window and block',
  );
});