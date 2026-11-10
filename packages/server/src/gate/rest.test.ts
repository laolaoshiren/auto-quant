import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import {
  EMPTY_BODY_SHA512,
  GATE_TIMEOUT_MS,
  GateRest,
  buildQueryString,
  gateSignature,
  gateSignString,
} from './rest.js';
import { GateApiError } from './types.js';

/** 文档给出的空 body 哈希（写死当锚点 —— 我们自己的实现是现算的）。 */
const DOC_EMPTY_SHA512 =
  'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';

test('空 body 的 SHA512 与 Gate 文档给的常量一致', () => {
  assert.equal(EMPTY_BODY_SHA512, DOC_EMPTY_SHA512);
});

test('★ 签名字符串按 Gate 规定的顺序拼接（METHOD\\nURL\\nQUERY\\nSHA512(body)\\nTimestamp）', () => {
  const text = gateSignString({
    method: 'POST',
    url: '/api/v4/futures/usdt/orders',
    query: 'a=1&b=2',
    body: '{"contract":"BTC_USDT"}',
    timestamp: 1700000000,
  });
  const bodyHash = createHash('sha512').update('{"contract":"BTC_USDT"}').digest('hex');
  assert.equal(text, ['POST', '/api/v4/futures/usdt/orders', 'a=1&b=2', bodyHash, '1700000000'].join('\n'));
  /* 无 body 时用空串哈希 —— Gate 的 GET 请求都走这条。 */
  const getText = gateSignString({
    method: 'GET',
    url: '/api/v4/futures/usdt/accounts',
    query: '',
    body: '',
    timestamp: 1700000000,
  });
  assert.equal(getText, ['GET', '/api/v4/futures/usdt/accounts', '', EMPTY_BODY_SHA512, '1700000000'].join('\n'));
});

test('★★★ 签名 = HexEncode(HMAC_SHA512(secret, 签名字符串))，与独立计算逐字节一致', () => {
  const args = {
    method: 'GET' as const,
    url: '/api/v4/futures/usdt/positions',
    query: 'limit=100',
    body: '',
    timestamp: 1700000123,
    secret: 'test-secret',
  };
  const expected = createHmac('sha512', 'test-secret').update(gateSignString(args)).digest('hex');
  assert.equal(gateSignature(args), expected);
});

test('查询串：排序、跳过空值、URL 编码', () => {
  assert.equal(buildQueryString(undefined), '');
  assert.equal(buildQueryString({ b: 2, a: 1, skip: undefined, nil: null }), 'a=1&b=2');
  assert.equal(buildQueryString({ symbol: 'BTC_USDT', 'x y': 'a&b' }), 'symbol=BTC_USDT&x%20y=a%26b');
});

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as unknown as typeof fetch;
}

test('公开接口：拼出完整 URL（含 /api/v4 前缀），不带签名头', async () => {
  let seen = '';
  const rest = new GateRest({
    apiKey: 'k',
    apiSecret: 's',
    fetchImpl: fakeFetch((url, init) => {
      seen = url;
      assert.equal(init?.headers && (init.headers as Record<string, string>).KEY, undefined);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  });
  const out = await rest.publicGet<{ ok: boolean }>('/futures/usdt/contracts', { limit: 5 });
  assert.deepEqual(out, { ok: true });
  assert.equal(seen, 'https://api.gateio.ws/api/v4/futures/usdt/contracts?limit=5');
});

test('★★★ 私有接口：KEY / Timestamp / SIGN 三个头都在，且 SIGN 是对得上签名的', async () => {
  let headers: Record<string, string> = {};
  const rest = new GateRest({
    apiKey: 'my-key',
    apiSecret: 'my-secret',
    fetchImpl: fakeFetch((_url, init) => {
      headers = init?.headers as Record<string, string>;
      return new Response('[]', { status: 200 });
    }),
  });
  await rest.signed('GET', '/futures/usdt/accounts');
  assert.equal(headers.KEY, 'my-key');
  assert.match(headers.Timestamp ?? '', /^\d{10}$/);
  const expected = createHmac('sha512', 'my-secret')
    .update(
      gateSignString({
        method: 'GET',
        url: '/api/v4/futures/usdt/accounts',
        query: '',
        body: '',
        timestamp: Number(headers.Timestamp),
      }),
    )
    .digest('hex');
  assert.equal(headers.SIGN, expected);
});

test('★★★ path 里的 ?query 必须拆开参与签名（联调实测的 INVALID_SIGNATURE）', async () => {
  let headers: Record<string, string> = {};
  let seen = '';
  const rest = new GateRest({
    apiKey: 'k',
    apiSecret: 's',
    fetchImpl: fakeFetch((url, init) => {
      seen = String(url);
      headers = init?.headers as Record<string, string>;
      return new Response('[]', { status: 200 });
    }),
  });
  /* 调用方把 query 写在 path 里 —— 必须被拆开，否则签名 URL 段会带上它 */
  await rest.signed('GET', '/futures/usdt/orders?status=open');
  assert.match(seen, /\?status=open/);
  const expected = createHmac('sha512', 's')
    .update(
      gateSignString({
        method: 'GET',
        url: '/api/v4/futures/usdt/orders',
        query: 'status=open',
        body: '',
        timestamp: Number(headers.Timestamp),
      }),
    )
    .digest('hex');
  assert.equal(headers.SIGN, expected);
});

test('测试网走独立域名（api-testnet.gateapi.io）', async () => {
  let seen = '';
  const rest = new GateRest({
    apiKey: 'k',
    apiSecret: 's',
    environment: 'testnet',
    fetchImpl: fakeFetch((url) => {
      seen = url;
      return new Response('{}', { status: 200 });
    }),
  });
  await rest.publicGet('/futures/usdt/contracts');
  assert.match(seen, /^https:\/\/api-testnet\.gateapi\.io\/api\/v4\//);
});

test('★ 非 2xx 映射成 GateApiError（带状态与 label，消息里保留 Gate 的原始说明）', async () => {
  const rest = new GateRest({
    apiKey: 'k',
    apiSecret: 's',
    fetchImpl: fakeFetch(() =>
      new Response(JSON.stringify({ label: 'INVALID_KEY', message: 'invalid api key' }), { status: 401 }),
    ),
  });
  await assert.rejects(
    () => rest.signed('GET', '/futures/usdt/accounts'),
    (error: unknown) => {
      assert.ok(error instanceof GateApiError);
      assert.equal(error.status, 401);
      assert.equal(error.label, 'INVALID_KEY');
      assert.match(error.message, /INVALID_KEY/);
      assert.match(error.message, /invalid api key/);
      return true;
    },
  );
});

test('★ 超时映射成 GateApiError（status=0），不会把 AbortError 裸露给上层', async () => {
  const rest = new GateRest({
    apiKey: 'k',
    apiSecret: 's',
    timeoutMs: 20,
    fetchImpl: fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    ),
  });
  await assert.rejects(
    () => rest.publicGet('/futures/usdt/contracts'),
    (error: unknown) => error instanceof GateApiError && error.status === 0 && /超时/.test(error.message),
  );
  assert.equal(GATE_TIMEOUT_MS, 15_000);
});
