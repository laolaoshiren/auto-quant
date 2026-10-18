/**
 * **网关契约自检**的测试（2026-10-18）。
 *
 * ## 为什么这组测试值得存在
 *
 * magpie 是自动更新、一天多版的项目。我们依赖它的**形状**（`/v1/models` 的字段、
 * 端点路径、候选链上的 id）。形状变了不会报错 —— 只会让决策变慢、让输出被截断、
 * 让某个角色静默缺席。
 *
 * ⇒ 这个自检的意义就是"**升级当天就在日志里出现一条**"。
 *   而如果自检本身写错了（比如把正常响应判成漂移），它就会变成噪音，
 *   最后被人忽略 —— 那比没有更糟。所以每一条判据都要钉住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { contractMessages, probeGatewayContract, readGatewayVersion, type ContractReport } from './gatewayContract.js';

const BASE = 'http://gw.test:3425/v1';
const KEY = 'mk-test';

/** 造一个"正常"的 /v1/models 响应。 */
function goodModels(ids: string[]): unknown {
  return {
    data: ids.map((id) => ({ id, context_length: 200_000, owned_by: 'x' })),
  };
}

/** 桩 fetch：按 URL 后缀返回不同响应，并记录调用次数。 */
function stubFetch(
  handlers: Record<string, () => { ok: boolean; status?: number; json: () => Promise<unknown> }>,
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    for (const [suffix, make] of Object.entries(handlers)) {
      if (url.endsWith(suffix)) return make() as never;
    }
    return { ok: false, status: 404, json: async () => ({}) } as never;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test('★★★ 全部正常 → ok=true，没有 mismatch', async () => {
  const { fetchImpl } = stubFetch({
    '/v1/models': () => ({ ok: true, status: 200, json: async () => goodModels(['a/b', 'c/d']) }),
    '/v1/magpie/quotas': () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
  });
  const r = await probeGatewayContract({
    baseUrl: BASE,
    apiKey: KEY,
    ladderIds: ['a/b'],
    fetchImpl,
  });
  assert.equal(r.ok, true, `★ 不该有问题（实际：${JSON.stringify(r.mismatches)}）`);
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.modelCount, 2);
  assert.equal(r.requests, 2, '★ 两个探针各一次请求（成本可见）');
  assert.deepEqual(contractMessages(r), [], '★ 正常时不该写任何日志（否则变成噪音）');
});

test('★★★ /v1/models 返回 500 → 一条 error，且【不抛】', async () => {
  const { fetchImpl } = stubFetch({
    '/v1/models': () => ({ ok: false, status: 500, json: async () => ({}) }),
    '/v1/magpie/quotas': () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
  });
  const r = await probeGatewayContract({ baseUrl: BASE, apiKey: KEY, ladderIds: [], fetchImpl });
  assert.equal(r.ok, false);
  const err = r.mismatches.find((m) => m.probe === 'models.shape');
  assert.ok(err, '★ 必须有一条 models.shape');
  assert.equal(err!.severity, 'error');
  assert.ok(err!.detail.includes('500'), '要把状态码写出来');
  assert.ok(err!.hint.length > 0, '★ 每条 mismatch 都要有行动建议');
});

test('★★★ 候选链上有死 id → 一条 warn，且【列出具体是哪几个】', async () => {
  const { fetchImpl } = stubFetch({
    '/v1/models': () => ({ ok: true, status: 200, json: async () => goodModels(['alive/one']) }),
    '/v1/magpie/quotas': () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
  });
  const r = await probeGatewayContract({
    baseUrl: BASE,
    apiKey: KEY,
    ladderIds: ['alive/one', 'dead/two', 'dead/three'],
    fetchImpl,
  });
  const m = r.mismatches.find((x) => x.probe === 'models.ladderIds');
  assert.ok(m, '★ 死 id 必须被发现');
  assert.equal(m!.severity, 'warn');
  /*
   * 必须**点名**。只说"有 2 个死 id"的话，操作员还得自己去比对 ——
   * 而这条日志存在的全部意义就是省掉那一步。
   */
  assert.ok(m!.detail.includes('dead/two'), '★ 要点名');
  assert.ok(m!.detail.includes('dead/three'), '★ 要点名');
  assert.ok(!m!.detail.includes('alive/one'), '活着的不该被点名');
});

test('★★ 元数据完整度低于 20% → error（预算算不出来会让输出变成空）', async () => {
  const { fetchImpl } = stubFetch({
    '/v1/models': () => ({
      ok: true,
      status: 200,
      json: async () => ({
        /* 10 个里只有 1 个带上下文长度 —— 这就是"字段改名"的形状。 */
        data: Array.from({ length: 10 }, (_, i) => (i === 0 ? { id: `m/${i}`, context_length: 1000 } : { id: `m/${i}` })),
      }),
    }),
    '/v1/magpie/quotas': () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
  });
  const r = await probeGatewayContract({ baseUrl: BASE, apiKey: KEY, ladderIds: [], fetchImpl });
  const m = r.mismatches.find((x) => x.probe === 'models.metadata');
  assert.ok(m, '★ 元数据缺失必须被发现');
  assert.equal(m!.severity, 'error', '★ 低于 20% 是 error（不是 warn）—— 它会让输出变成空内容');
});

test('★★ 单个探针超时不影响其它探针', async () => {
  const { fetchImpl } = stubFetch({
    '/v1/models': () => ({ ok: true, status: 200, json: async () => goodModels(['a/b']) }),
    /* quotas 直接抛（模拟超时/不可达）。 */
    '/v1/magpie/quotas': () => {
      throw new Error('timeout');
    },
  });
  const r = await probeGatewayContract({ baseUrl: BASE, apiKey: KEY, ladderIds: ['a/b'], fetchImpl });
  /* quotas 失败只 warn，不该把整体判成 error。 */
  assert.equal(r.ok, true, '★ quotas 是 warn 级，不该让整体失败');
  assert.ok(r.mismatches.some((m) => m.probe === 'quotas.shape' && m.severity === 'warn'));
  /* models 的结果仍然拿到了。 */
  assert.equal(r.modelCount, 1);
});

test('★★★ 没有 apiKey → 一个请求都不发', async () => {
  const { fetchImpl, calls } = stubFetch({});
  const r = await probeGatewayContract({ baseUrl: BASE, apiKey: '   ', ladderIds: [], fetchImpl });
  assert.equal(calls.length, 0, '★ 没 key 就不该发请求（发也是 401，白花时间）');
  assert.equal(r.requests, 0);
  assert.equal(r.ok, true, '没配置不算失败');
  assert.deepEqual(contractMessages(r), [], '★ "未配置"是 info 级，不该写进日志当问题');
});

test('★★ 响应里没有 data 数组 → error（形状变了）', async () => {
  const { fetchImpl } = stubFetch({
    '/v1/models': () => ({ ok: true, status: 200, json: async () => ({ models: [] }) }),
    '/v1/magpie/quotas': () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
  });
  const r = await probeGatewayContract({ baseUrl: BASE, apiKey: KEY, ladderIds: [], fetchImpl });
  assert.equal(r.ok, false);
  assert.ok(r.mismatches.some((m) => m.probe === 'models.shape' && m.severity === 'error'));
});

test('★★ 指纹只由"哪些探针报了什么问题"决定（同问题不重复刷日志）', async () => {
  const mk = async (status: number): Promise<ContractReport> => {
    const { fetchImpl } = stubFetch({
      '/v1/models': () => ({ ok: false, status, json: async () => ({}) }),
      '/v1/magpie/quotas': () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
    });
    return probeGatewayContract({ baseUrl: BASE, apiKey: KEY, ladderIds: [], fetchImpl });
  };
  const a = await mk(500);
  const b = await mk(503);
  assert.equal(
    a.fingerprint,
    b.fingerprint,
    '★ 都是"models.shape 坏了"⇒ 指纹相同（去重才不会每次刷一条）',
  );
});

/*
 * ★★ 网关版本读取（2026-10-18 · "magpie 自动更新"的预警信号）
 *
 * ## 为什么值得一条测试
 *
 * 用户提醒过 magpie 一天多版。**"版本变了"是唯一能提前预警的信号** ——
 * 某天开始出问题时，翻日志能看到"问题是从 0.1.X → 0.1.Y 那次开始的"。
 *
 * 而如果这个函数在"读不到"时**编一个默认版本号**，那条线索就变成假的：
 * 所有日志都会显示同一个版本，永远看不出变化。
 * ⇒ 所以"读不到必须返回 null"是这条测试的核心。
 */
test('★★★ 读不到版本时返回 null（绝不编默认值）', () => {
  assert.equal(
    readGatewayVersion(() => { throw new Error('ENOENT'); }, ['/nope/1', '/nope/2']),
    null,
    '★ 编一个版本号会让"版本变化"这条线索永远消失',
  );
  assert.equal(readGatewayVersion(() => '   ', ['/empty']), null, '空白也算读不到');
});

test('★★ 读到就用它；多个候选路径按顺序取第一个有效的', () => {
  const files: Record<string, string> = {
    '/a': '',
    '/b': 'v0.1.1285\n',
    '/c': 'v0.1.9999',
  };
  const read = (p: string): string => {
    if (!(p in files)) throw new Error('ENOENT');
    return files[p]!;
  };
  assert.equal(readGatewayVersion(read, ['/a', '/b', '/c']), 'v0.1.1285', '★ 跳过空文件，取第一个有效的');
  assert.equal(readGatewayVersion(read, ['/missing', '/c']), 'v0.1.9999', '★ 跳过读不到的路径');
});