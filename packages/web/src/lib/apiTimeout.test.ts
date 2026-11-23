/**
 * `api.ts` 请求超时归类：`TimeoutError` 绝不能被误报为「无法连接后端」。
 *
 * 策略体检 / 立即分析 / 模型测试 / 对账 / 平仓等慢接口可能耗时数十秒；
 * 一旦触发超时，提示必须是「请求超时，服务端可能仍在处理…」，而不是
 * 「无法连接后端」（后者会误导操作员以为后端宕机，并被 `humanErrorText`
 * 改写成「暂时连不上服务」）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, api, classifyFetchError } from './api';
import { humanErrorText } from './hooks';

test('★★★ TimeoutError 不被转成「无法连接后端」，且 humanErrorText 保留超时说明', () => {
  const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const classified = classifyFetchError(timeoutErr, false);

  assert.ok(classified instanceof ApiError, '超时应包装为 ApiError');
  assert.equal(classified.status, 0);
  assert.match(classified.message, /请求超时/, '文案必须明确说是请求超时');
  assert.ok(!/无法连接后端/.test(classified.message), '★ 绝不能转成「无法连接后端」');
  assert.equal(
    humanErrorText(classified),
    classified.message,
    '★ humanErrorText 不得把超时改写成「暂时连不上服务」',
  );
});

test('★★★ 自带 timeoutSignal 触发的 AbortError 同样归类为请求超时；外部取消原样透传', () => {
  const abortErr = new DOMException('The operation was aborted.', 'AbortError');

  const selfTimedOut = classifyFetchError(abortErr, true);
  assert.ok(selfTimedOut instanceof ApiError);
  assert.match(selfTimedOut.message, /请求超时/);
  assert.ok(!/无法连接后端/.test(selfTimedOut.message));

  const callerAborted = classifyFetchError(abortErr, false);
  assert.equal(callerAborted, abortErr, '外部 signal 取消必须原样抛出 AbortError，供 usePolled 静默处理');
});

test('★★ 真实断网 TypeError 仍归类为「无法连接后端」', () => {
  const netErr = new TypeError('Failed to fetch');
  const classified = classifyFetchError(netErr, false);
  assert.ok(classified instanceof ApiError);
  assert.equal(classified.status, 0);
  assert.equal(classified.message, '无法连接后端');
});

test('★★★ 端到端通过 api.system() 验证 fetch 抛 TimeoutError 时不被转成「无法连接后端」', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new DOMException('signal timed out', 'TimeoutError');
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => api.system(),
      (err: unknown) => {
        assert.ok(err instanceof ApiError, '应抛出 ApiError');
        assert.equal(err.status, 0);
        assert.match(err.message, /请求超时/);
        assert.ok(!/无法连接后端/.test(err.message), '★ 绝不能变成「无法连接后端」');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
