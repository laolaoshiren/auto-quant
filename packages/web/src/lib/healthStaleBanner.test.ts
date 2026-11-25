/**
 * 审计 P1 #17 & #20：
 * - P1 #17：`/api/health` 在存在停摆机器人时返回 HTTP 503 + 合法 Health JSON；
 *   `api.health()` 必须解析并返回该载荷，确保 `StaleTraderBanner` 能拿到 `staleTraders` 并渲染；
 *   反向代理/网关吐出的非 Health 503 仍照常抛错。
 * - P1 #20：`api.marketSymbols()` / `api.marketKlines()` 必须支持透传 `exchange` 查询参数
 *   （`'binance' | 'gate'`），避免 Gate 机器人误查币安行情。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, api, isHealthPayload } from './api';
import { staleEntriesFrom } from '../components/StaleTraderBanner';

test('★★★ api.health() 收到带 staleTraders 的 HTTP 503 JSON 时正常解析并可供 StaleTraderBanner 渲染', async () => {
  const originalFetch = globalThis.fetch;
  const payload = {
    ok: false,
    version: '0.2.0',
    uptimeSeconds: 7200,
    hasOwner: true,
    dryRun: false,
    tradingDisabled: false,
    environment: 'production',
    db: 'autoquant.db',
    staleTraders: [
      {
        id: 10,
        name: '赚大钱',
        staleForMs: 2_160_000,
        awaitingFirstCycle: false,
        thresholdMs: 1_800_000,
      },
    ],
    reason: '有 1 个正在运行的机器人已超过各自周期的 2 倍仍未完成一轮决策。',
  };

  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  try {
    const health = await api.health();
    assert.equal(health.ok, false);
    assert.equal(health.staleTraders?.length, 1);
    assert.equal(health.staleTraders?.[0]?.id, 10);

    /* 端到端喂给 StaleTraderBanner 的纯函数判据：确认能产出停摆条目。 */
    const entries = staleEntriesFrom(health, [{ id: 10, dryRun: false }]);
    assert.equal(entries.length, 1, '★★★ 停摆横幅必须从 503 health 载荷中产出告警条目');
    assert.equal(entries[0]!.name, '赚大钱');
    assert.equal(entries[0]!.minutes, 36);
    assert.equal(entries[0]!.thresholdMs, 1_800_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('★★★ api.health() 遇到反向代理 HTML 或非 Health 503 时仍必须抛 ApiError(503)', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const body of ['<html>503 Service Temporarily Unavailable</html>', JSON.stringify({ error: 'upstream unavailable' })]) {
      globalThis.fetch = (async () => new Response(body, { status: 503 })) as typeof fetch;
      await assert.rejects(
        () => api.health(),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.status, 503);
          return true;
        },
      );
    }

    assert.equal(isHealthPayload(null), false);
    assert.equal(isHealthPayload({ error: 'down' }), false);
    assert.equal(isHealthPayload({ ok: false, version: '1.0', uptimeSeconds: 1, hasOwner: true, staleTraders: 'bad' }), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('★★★ api.marketSymbols / api.marketKlines 正确透传 exchange 查询参数', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify([]), { status: 200 });
  }) as typeof fetch;

  try {
    await api.marketSymbols(undefined, 'gate');
    await api.marketSymbols(undefined, 'binance');
    await api.marketSymbols();
    await api.marketKlines('BTCUSDT', '15m', 400, undefined, 'gate');
    await api.marketKlines('ETHUSDT', '1h', 200);

    assert.equal(requestedUrls[0], '/api/market/symbols?exchange=gate');
    assert.equal(requestedUrls[1], '/api/market/symbols?exchange=binance');
    assert.equal(requestedUrls[2], '/api/market/symbols');
    assert.equal(
      requestedUrls[3],
      '/api/market/klines?symbol=BTCUSDT&interval=15m&limit=400&exchange=gate',
    );
    assert.equal(
      requestedUrls[4],
      '/api/market/klines?symbol=ETHUSDT&interval=1h&limit=200',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
