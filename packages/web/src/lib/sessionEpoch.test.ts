/**
 * 安全 P1 #6：会话纪元号（`sessionEpoch`）防护测试。
 *
 * 验证在途请求若跨过登出 / 切换会话 / 改密边界：
 * 1. 旧请求的 `x-refreshed-token` 响应头绝不能把旧令牌写回已登出或新登录会话；
 * 2. 旧请求的 `401` 响应绝不能触发 `onUnauthorized` 误踢新会话；
 * 3. 同会话内的滑动续期与真实 `401` 照常工作。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  api,
  clearToken,
  getSessionEpoch,
  getToken,
  setToken,
  setUnauthorizedHandler,
} from './api';

function installMemoryStorage(): () => void {
  const original = (globalThis as { localStorage?: Storage }).localStorage;
  const map = new Map<string, string>();
  const mock: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: mock,
    configurable: true,
    writable: true,
  });
  return () => {
    if (original === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  };
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('★★★ 登出后到达的在途 x-refreshed-token 不得复活旧令牌', async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  const deferred = makeDeferred<Response>();
  globalThis.fetch = (() => deferred.promise) as typeof fetch;

  try {
    setToken('token-session-1');
    const pending = api.traders();

    /* 请求仍在途时用户退出登录。 */
    clearToken();
    assert.equal(getToken(), null);

    deferred.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-refreshed-token': 'stale-refreshed-token-1',
        },
      }),
    );
    await pending;

    assert.equal(
      getToken(),
      null,
      '★★★ 登出后到达的 x-refreshed-token 绝不能写回 localStorage',
    );
  } finally {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
    restoreStorage();
  }
});

test('★★★ 重新登录后到达的旧会话 x-refreshed-token 不得覆盖新会话令牌', async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  const deferred = makeDeferred<Response>();
  globalThis.fetch = (() => deferred.promise) as typeof fetch;

  try {
    setToken('token-session-A');
    const pending = api.traders();

    /* 用户登出并登录新会话 B。 */
    clearToken();
    setToken('token-session-B');

    deferred.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-refreshed-token': 'stale-refreshed-from-A',
        },
      }),
    );
    await pending;

    assert.equal(
      getToken(),
      'token-session-B',
      '★★★ 旧会话的刷新令牌绝不能覆盖新会话 B 的令牌',
    );
  } finally {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
    restoreStorage();
  }
});

test('★★★ 同会话内的 x-refreshed-token 正常更新令牌，且不误递增 sessionEpoch', async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-refreshed-token': 'token-session-1-refreshed',
      },
    })) as typeof fetch;

  try {
    setToken('token-session-1');
    const epochBefore = getSessionEpoch();
    await api.traders();

    assert.equal(getToken(), 'token-session-1-refreshed', '★ 同会话滑动续期必须生效');
    assert.equal(
      getSessionEpoch(),
      epochBefore,
      '★ 同会话滑动续期不应破坏同会话并发请求的 epoch 校验',
    );
  } finally {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
    restoreStorage();
  }
});

test('★★★ 旧会话的迟到 401 绝不能踢出已经重新登录/换密的新会话', async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  const deferred = makeDeferred<Response>();
  globalThis.fetch = (() => deferred.promise) as typeof fetch;

  let unauthorizedCalls = 0;
  setUnauthorizedHandler(() => {
    unauthorizedCalls += 1;
    clearToken();
  });

  try {
    setToken('token-old-password');
    const pending = api.traders();

    /* 改密或重新登录后换入新令牌，推进 sessionEpoch。 */
    setToken('token-new-password');

    deferred.resolve(
      new Response(JSON.stringify({ error: '登录已过期，请重新登录。' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await assert.rejects(() => pending);
    assert.equal(
      unauthorizedCalls,
      0,
      '★★★ 旧会话的 401 绝不能触发新会话的 onUnauthorized',
    );
    assert.equal(getToken(), 'token-new-password', '★★★ 新会话令牌必须完好保留');
  } finally {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
    restoreStorage();
  }
});

test('★★ 同会话的并发 401 只触发一次 onUnauthorized', async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  const d1 = makeDeferred<Response>();
  const d2 = makeDeferred<Response>();
  let seq = 0;
  globalThis.fetch = (() => (seq++ === 0 ? d1.promise : d2.promise)) as typeof fetch;

  let unauthorizedCalls = 0;
  setUnauthorizedHandler(() => {
    unauthorizedCalls += 1;
    clearToken();
  });

  try {
    setToken('token-expired');
    const p1 = api.traders();
    const p2 = api.system();

    d1.resolve(new Response(JSON.stringify({ error: '请先登录。' }), { status: 401 }));
    await assert.rejects(() => p1);

    d2.resolve(new Response(JSON.stringify({ error: '请先登录。' }), { status: 401 }));
    await assert.rejects(() => p2);

    assert.equal(unauthorizedCalls, 1, '★★ 同会话首次 401 触发登出，后续同批 401 不重复触发');
    assert.equal(getToken(), null);
  } finally {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
    restoreStorage();
  }
});
