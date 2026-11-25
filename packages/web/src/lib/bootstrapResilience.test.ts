/**
 * 审计 P1 #19：`bootstrap()` 区分认证失败（401 / 403）与部署重启等临时故障。
 *
 * 服务端滚动重启（通常 3 秒）期间刷新页面会收到 502 / 503 / 断网 / 超时。
 * `bootstrap()` 必须保留本地令牌与会话恢复态并自动重试，绝不能清掉 token 把操作员踢去登录页；
 * 只有在服务端明确返回 401 / 403 时才清空令牌并回到登录页。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, clearToken, getToken, setToken, setUnauthorizedHandler } from './api';
import { cancelBootstrapRetry, isBootstrapAuthError, useApp } from './store';

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

function resetAppState(): void {
  cancelBootstrapRetry();
  useApp.setState({
    status: 'loading',
    user: null,
    health: null,
    healthLoadedAt: null,
    catalog: null,
    system: null,
    traders: [],
    lastError: null,
    systemsLoadedAt: null,
    systemError: null,
  });
}

test('★★ isBootstrapAuthError 仅将 401 / 403 判为认证失败，放过 502 / 503 / 网络 / 超时', () => {
  assert.equal(isBootstrapAuthError(new ApiError(401, '未登录', null)), true);
  assert.equal(isBootstrapAuthError(new ApiError(403, '禁止访问', null)), true);
  assert.equal(isBootstrapAuthError(new ApiError(502, 'Bad Gateway', null)), false);
  assert.equal(isBootstrapAuthError(new ApiError(503, 'Service Unavailable', null)), false);
  assert.equal(isBootstrapAuthError(new ApiError(504, 'Gateway Timeout', null)), false);
  assert.equal(isBootstrapAuthError(new ApiError(0, '无法连接后端', null)), false);
  assert.equal(isBootstrapAuthError(new ApiError(0, '请求超时', null)), false);
  assert.equal(isBootstrapAuthError(new TypeError('Failed to fetch')), false);
});

test('★★★ bootstrap() 遇到 502 / 503 / 断网 / 超时必须保留 token，绝不踢回登录页', async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;

  const transientCases: Array<{ name: string; responder: () => Promise<Response> }> = [
    {
      name: 'HTTP 502 Bad Gateway',
      responder: async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    },
    {
      name: 'HTTP 503 Service Unavailable',
      responder: async () => new Response('<html>503</html>', { status: 503 }),
    },
    {
      name: '网络断开 TypeError',
      responder: async () => {
        throw new TypeError('Failed to fetch');
      },
    },
    {
      name: '请求超时 TimeoutError',
      responder: async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    },
  ];

  try {
    for (const tc of transientCases) {
      resetAppState();
      setToken('valid-operator-jwt');
      globalThis.fetch = (async () => tc.responder()) as typeof fetch;

      await useApp.getState().bootstrap();
      cancelBootstrapRetry();

      assert.equal(
        getToken(),
        'valid-operator-jwt',
        `★★★ [${tc.name}] 临时故障期间绝不能清掉本地 token`,
      );
      assert.equal(
        useApp.getState().status,
        'loading',
        `★★★ [${tc.name}] 临时故障期间绝不能把 status 降为 anonymous（踢去登录页）`,
      );
      assert.ok(
        useApp.getState().lastError && useApp.getState().lastError!.length > 0,
        `★★ [${tc.name}] 应当向界面透出临时错误说明`,
      );
    }
  } finally {
    cancelBootstrapRetry();
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
    clearToken();
    restoreStorage();
  }
});

test('★★★ bootstrap() 遇到 401 或 403 明确认证失败时必须清 token 并回到 anonymous', async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;

  try {
    for (const status of [401, 403] as const) {
      resetAppState();
      setToken('expired-jwt');
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/auth/me')) {
          return new Response(JSON.stringify({ error: '登录已过期' }), { status });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            version: '1.0.0',
            uptimeSeconds: 120,
            hasOwner: true,
            dryRun: true,
            tradingDisabled: false,
            environment: 'testnet',
            db: 'aq.db',
            staleTraders: [],
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      await useApp.getState().bootstrap();
      cancelBootstrapRetry();

      assert.equal(getToken(), null, `★★★ HTTP ${status} 必须清空失效 token`);
      assert.equal(useApp.getState().status, 'anonymous', `★★★ HTTP ${status} 必须回到登录态`);
    }
  } finally {
    cancelBootstrapRetry();
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(null);
    clearToken();
    restoreStorage();
  }
});
