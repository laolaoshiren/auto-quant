import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BinanceRest,
  decayWeight,
  MAX_IN_FLIGHT_REQUESTS,
  preserveBigIds,
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
let urls: string[] = [];
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
  urls = [];
  weightHeader = null;
  opened = 0;
  maxConcurrentlyOpen = 0;

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    opened += 1;
    // 记下 URL：用例要能认出"哪一个是校时探针"，否则它在 `pending` 里的位置
    // 只能靠发出顺序去猜 —— 那会让测试与被测代码的实现细节耦合。
    urls.push(String(input));
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

/* -------------------------------------------------------------------------- */
/*  时钟漂移与下单：两条会直接导致资金损失的路径                                  */
/* -------------------------------------------------------------------------- */

/**
 * 一个永不 resolve 的竞速对手。
 *
 * 用它把"死锁"变成**会失败的测试**，而不是一个挂住的 CI 进程 ——
 * 一个挂住的测试比一个失败的测试更糟：它看起来像"还在跑"。
 */
function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
}

function makeSignedRest(maxRetries: number, maxInFlight = 4): BinanceRest {
  return new BinanceRest({
    environment: 'production',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    maxRetries,
    maxInFlight,
  });
}

test('★ 校时探针不占并发槽位 —— 否则一次时钟跳变会锁死整个 REST 客户端', async () => {
  /*
   * ## 这条测试钉的是一个**闭环死锁**
   *
   * `-1021`（时钟漂移）的处理是在**重试循环内部、持着并发槽位**时调用
   * `syncTime(true)` 的。如果校时探针自己也要排队等槽位，那么：
   *
   *     maxInFlight 个在途签名请求同时被时钟跳变打成 -1021
   *       → 每一个都持着槽位等第 (maxInFlight + 1) 个槽位
   *       → 而槽位只能等它们自己返回才释放
   *       → 谁都不会返回：交易、对账、撤单、挂保护单**全部永久停摆**
   *
   * 把宽度设成 1 就能确定性地复现这个闭环：唯一的槽位被占住时，
   * 探针要么立刻发出（修复后），要么永远排不上（修复前）。
   */
  const rest = makeRest(1);

  // 占住唯一的槽位。它不会自己返回，直到我们在测试末尾放行它。
  const blocker = rest.publicGet('/fapi/v1/hold');
  await settle();
  assert.equal(rest.inFlightCount, 1, '前提：唯一的槽位已经被占住');

  // 强制校时（`force=true` 绕过 60 秒短路）。
  const syncing = rest.syncTime(true);
  await settle();

  const probeIndex = urls.findIndex((url) => url.includes('/fapi/v1/time'));
  assert.ok(
    probeIndex >= 0,
    '校时探针必须能在槽位被占满时发出 —— 它要在持槽的重试路径里被调用',
  );

  pending[probeIndex]?.resolve(jsonResponse({ serverTime: Date.now() }));
  const outcome = await Promise.race([syncing, timeout(2_000)]);
  assert.notEqual(
    outcome,
    'timeout',
    '校时在槽位被占满时也必须能完成；否则 -1021 重试路径会死锁整个客户端',
  );

  // 收尾：放行那个挂着的请求，让槽位归零（也证明槽位账本是平账的）。
  pending[0]?.resolve(jsonResponse({ ok: true }));
  await blocker;
  assert.equal(rest.inFlightCount, 0);
});

test('★ 下单请求遇到"结果未知"时不重发 —— 一次超时不该变成两张仓单', async () => {
  /*
   * ## 为什么这条必须钉住
   *
   * `broker` 的类注释写着 "Never blind-retry an order … An ambiguous outcome is
   * reconciled by client id rather than resent." —— 而实现里 `signedRequest`
   * 对所有请求一视同仁地重试 `maxRetries` 次。
   *
   * 一次传输超时（`AbortSignal.timeout(15_000)`）**不表示"没成交"**，它表示"不知道"。
   * 用同一个 `newClientOrderId` 重发一张市价单：若第一张其实已经成交，
   * 币安不会因 id 重复而拒绝（它只要求 id 在**未成交委托**中唯一）——
   * **仓位直接翻倍，而且多出来的那一半没有保护单。**
   *
   * 所以下单路径传 `avoidAmbiguousRetry: true`：只屏蔽"结果未知"的重试
   * （传输层错误、5xx），而 `-1021` / 429 这类"明确未被接受"的错误仍然重试。
   */
  const attempts: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    attempts.push(String(input));
    throw new Error('socket hang up');
  }) as typeof globalThis.fetch;

  const guarded = makeSignedRest(3);
  await assert.rejects(
    guarded.signedRequest('POST', '/fapi/v1/order', { symbol: 'BTCUSDT' }, { avoidAmbiguousRetry: true }),
  );
  assert.equal(
    attempts.length,
    1,
    '传输错误是"结果未知"：下单必须只尝试一次（重发可能开出第二张无保护的仓位）',
  );

  /* 对照：同一个错误形态下，普通签名请求仍会重试满（这是只读调用，安全）。 */
  attempts.length = 0;
  const plain = makeSignedRest(1);
  await assert.rejects(plain.signedRequest('GET', '/fapi/v1/openOrders', {}));
  assert.equal(attempts.length, 2, '普通请求的重试行为不能被这次改动波及');
});

/* -------------------------------------------------------------------------- */
/*  大整数单号                                                                  */
/* -------------------------------------------------------------------------- */

test('★ 19 位订单号必须原样保留为字符串 —— 否则撤单会打到一个不存在的单号上', () => {
  /*
   * 实测（2026-09-27 ETHUSDT）：币安返回的订单号是 `8389766285736312000`，19 位。
   * `Number.MAX_SAFE_INTEGER` 只有 `9007199254740991`（16 位），所以
   * `JSON.parse` 会把它读成 `8389766285736310000` —— **末几位就错了**。
   *
   * 后果不是"显示不准"：拿它去 `DELETE /fapi/v1/order` 会打到不存在的单号，
   * 币安回 `-2011`，而代码把 `-2011` 当成"它已经不在交易所了"= **撤单成功** ——
   * 于是系统以为撤掉了，那张单其实还挂着（§2.6 的最糟状态）。
   */
  const payload =
    '{"orderId":8389766285736312000,"updateTime":1790342871508,"orderType":"LIMIT","clientOrderId":"entry-abc-BTCUSDT"}';

  const parsed = JSON.parse(preserveBigIds(payload)) as {
    orderId: unknown;
    updateTime: number;
    orderType: string;
  };
  assert.equal(parsed.orderId, '8389766285736312000', '大整数单号必须一字不差地保留');
  assert.equal(typeof parsed.updateTime, 'number', '时间戳（不以 Id 结尾）保持数字不动');
  assert.equal(parsed.orderType, 'LIMIT');

  /* 说明这个保护是必要的：对确实超出安全整数的值，不经保护就会变。 */
  const unsafe = '{"orderId":9007199254740993}'; // 2^53 + 1
  const naive = JSON.parse(unsafe) as { orderId: number };
  assert.notEqual(
    String(naive.orderId),
    '9007199254740993',
    '（对照）2^53+1 无法用 number 表示 —— 这就是这个函数存在的理由',
  );
  assert.equal(
    (JSON.parse(preserveBigIds(unsafe)) as { orderId: string }).orderId,
    '9007199254740993',
    '经保护后原文一字不差',
  );
});