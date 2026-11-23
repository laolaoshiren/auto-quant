/**
 * `magpieGateway.ts` 的回归测试。
 *
 * 覆盖两处核实缺陷：
 *  1. `looksLikeMagpieGateway` 需识别无尾斜杠 `/magpie`（及带查询串），同时不误匹配 `/magpies`；
 *  2. `discoverFromGateway` 必须经 `fetchGuarded` 发起请求，阻止公网地址 302 跳到云元数据并带走 Bearer key。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverFromGateway, looksLikeMagpieGateway } from './magpieGateway.js';

test('★★ looksLikeMagpieGateway 兼容无尾斜杠 /magpie，且不误匹配无关前缀', () => {
  assert.equal(looksLikeMagpieGateway('https://gw.example.com/magpie'), true, '★ 无尾斜杠 /magpie 必须识别');
  assert.equal(looksLikeMagpieGateway('https://gw.example.com/magpie/'), true);
  assert.equal(looksLikeMagpieGateway('https://gw.example.com/mcp/magpie/v1'), true);
  assert.equal(looksLikeMagpieGateway('http://127.0.0.1:3425/v1'), true);
  assert.equal(looksLikeMagpieGateway('https://gw.example.com/magpies/v1'), false, '无关路径前缀不应误匹配');
  assert.equal(looksLikeMagpieGateway('https://api.openai.com/v1'), false);
});

test('★★★ discoverFromGateway 经 fetchGuarded 阻止 302 跳往云元数据并保护 Bearer key', async () => {
  /*
   * 防 bug：旧代码直接裸调 `fetch`，若网关地址返回 302 指向 169.254.169.254，
   * 会跳过 `urlGuard` 重定向防线并把 `Authorization: Bearer ...` 带往云元数据。
   */
  const origFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    seenUrls.push(url);
    return new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });
  }) as unknown as typeof globalThis.fetch;

  try {
    const catalog = await discoverFromGateway({
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-magpie-secret',
      timeoutSeconds: 10,
      maxRetries: 0,
      temperature: 0.2,
    });
    assert.equal(catalog, null, '被重定向防线拦截后应安全返回 null');
    assert.equal(seenUrls.length, 1, '★ 只能发出第一跳，绝不能向 169.254.169.254 发起请求');
    assert.ok(!seenUrls.some((u) => u.includes('169.254')), '云元数据地址绝不可被请求');
  } finally {
    globalThis.fetch = origFetch;
  }
});
