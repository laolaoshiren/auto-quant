/**
 * 部署版本与"线上是不是最新版"。
 *
 * ## 为什么这些用例存在
 *
 * 这一块有两个**看起来无害、实际很贵**的失效方式，各钉一组：
 *
 * 1. **把"不知道"说成"一致"。** 没有 `build-info.json`、仓库地址读不出来、GitHub
 *    连不上 —— 这些情况下最容易顺手 `return { state: 'up-to-date' }`，因为那个分支
 *    写起来最短。而一个**永远显示"一致"**的版本面板，与实际效果等于把这一页删掉，
 *    同时让人放心地不去部署。所以每个"不知道"的分支都单独钉住。
 *
 * 2. **把凭据转述出去。** `GITHUB_TOKEN` 与仓库地址都会进入请求，而错误消息是给
 *    操作员看的、也可能被复制进 issue。用例断言错误文本里不含 token。
 *
 * 仓库地址的解析单独钉一组：它会被**拼进请求 URL**，所以"看起来能解析"不够，
 * 不能解析出合法 `owner/repo` 的输入必须返回 `null`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  checkForUpdates,
  loadBuildInfoFrom,
  parseRepoSlug,
  readAppVersion,
  resetBuildInfoCache,
  type BuildInfo,
} from './buildInfo.js';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const info = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  commit: 'a'.repeat(40),
  commitShort: 'aaaaaaa',
  branch: 'main',
  subject: 'feat: something',
  committedAt: '2026-09-20T00:00:00Z',
  deployedAt: '2026-09-20T01:00:00Z',
  dirty: false,
  repository: 'https://github.com/example/quant.git',
  ...over,
});

/** Replace `fetch` for one case and always put it back. */
async function withFetch(
  handler: (url: string) => { status?: number; body?: unknown } | Error,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const result = handler(url);
    if (result instanceof Error) throw result;
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.body,
    } as Response;
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

/* -------------------------------------------------------------------------- */
/*  Repository slug                                                            */
/* -------------------------------------------------------------------------- */

test('接受 git remote 实际会产出的各种形状', () => {
  const expected = 'example/quant';
  for (const input of [
    'https://github.com/example/quant.git',
    'https://github.com/example/quant',
    'git@github.com:example/quant.git',
    'ssh://git@github.com/example/quant',
    'git+ssh://git@github.com/example/quant.git',
    'example/quant',
    '  https://github.com/example/quant/  ',
  ]) {
    assert.equal(parseRepoSlug(input), expected, `解析失败：${input}`);
  }
});

test('解析不出合法 owner/repo 时返回 null —— 这个字符串会被拼进请求 URL', () => {
  for (const input of [
    '',
    'example',
    'a/b/c',
    'https://github.com/example/quant/tree/main',
    // 一个"看起来像 URL"但带查询串的输入：任何多余的字符都不该被放行。
    'https://github.com/example/quant?x=1',
    'example/../etc',
    'example/qu ant',
  ]) {
    assert.equal(parseRepoSlug(input), null, `不该被接受：${input}`);
  }
});

/* -------------------------------------------------------------------------- */
/*  Reading build-info                                                         */
/* -------------------------------------------------------------------------- */

test('没有 build-info.json 时返回 null —— "不知道"不能变成一个看起来正常的默认值', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aq-build-'));
  try {
    assert.equal(loadBuildInfoFrom(path.join(dir, 'build-info.json')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('字段不全的文件也当作没有 —— 否则界面会显示 "undefined @ undefined"', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aq-build-'));
  try {
    const file = path.join(dir, 'build-info.json');
    for (const partial of [{}, { commit: '' }, { commit: 'abc' }, { branch: 'main' }]) {
      writeFileSync(file, JSON.stringify(partial));
      assert.equal(loadBuildInfoFrom(file), null, `不该接受：${JSON.stringify(partial)}`);
    }
    // 坏 JSON 同样只是"没有"，不该抛。
    writeFileSync(file, '{ not json');
    assert.equal(loadBuildInfoFrom(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('完整的文件被读出来，且 dirty 只有真的是 true 才算', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aq-build-'));
  try {
    const file = path.join(dir, 'build-info.json');
    writeFileSync(file, JSON.stringify({ ...info(), dirty: 'yes', commitShort: undefined }));
    const parsed = loadBuildInfoFrom(file);
    assert.ok(parsed);
    // 字符串 'yes' 不是 true —— 一个错误的真值会让"工作区干净"变成危险的假象。
    assert.equal(parsed.dirty, false);
    // commitShort 缺失时从 commit 推出来。
    assert.equal(parsed.commitShort, 'aaaaaaa');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/*  Update check —— 每个"不知道"的分支单独钉住                                  */
/* -------------------------------------------------------------------------- */

test('没有版本信息时说"无法判断"，绝不说"一致"', async () => {
  resetBuildInfoCache();
  const result = await checkForUpdates(null);
  assert.equal(result.state, 'unknown');
  assert.match(result.message, /无法判断|没有写出/);
});

test('版本信息里没有仓库地址 → unknown，而不是一次注定失败的请求', async () => {
  resetBuildInfoCache();
  const result = await checkForUpdates(info({ repository: '' }));
  assert.equal(result.state, 'unknown');
  assert.match(result.message, /仓库地址/);
});

test('远端与本地同一个提交 → up-to-date', async () => {
  resetBuildInfoCache();
  const local = info();
  await withFetch(
    () => ({ body: { sha: local.commit, commit: { message: 'feat: x', committer: { date: 'd' } } } }),
    async () => {
      const result = await checkForUpdates(local);
      assert.equal(result.state, 'up-to-date');
      assert.equal(result.latestCommit, local.commit);
    },
  );
});

test('远端有新提交 → behind，并给出差多少个', async () => {
  resetBuildInfoCache();
  const local = info();
  const remoteSha = 'b'.repeat(40);
  await withFetch(
    (url) =>
      url.includes('/compare/')
        ? /*
           * ⚠️ **fixture 里的 `status` 必须是 `ahead`，不是 `behind`。**
           *
           * 这一条原来写的是 `{ status: 'behind', behind_by: 7 }`，而那是**反的**：
           * GitHub 的 `compare/{base}...{head}` 语义是「head 相对 base 怎么样」，
           * 而这里的 base 是线上跑的提交、head 是 GitHub 上的分支。
           *
           *   · `ahead`  ⇒ GitHub 领先线上 ⇒ **服务器落后**（本条用例的场景）
           *   · `behind` ⇒ GitHub 落后线上 ⇒ 本地有提交没推
           *
           * 用真实仓库验证过：`compare/b4b835e...0c1206b` 返回
           * `{"status":"ahead","ahead_by":2,"behind_by":0}` —— 旧的那个在前、
           * 新的那个在后，`ahead` 说的是**第二个参数领先第一个**。
           *
           * **实现和测试当时一起说反了，所以 CI 一直是绿的。** 一条照着重反的
           * 实现写出来的断言证明不了那个方向 —— 它只证明了"两边一致"。
           */
          { body: { status: 'ahead', ahead_by: 7 } }
        : { body: { sha: remoteSha, commit: { message: 'fix: newer\n\nbody', committer: { date: 'd' } } } },
    async () => {
      const result = await checkForUpdates(local);
      assert.equal(result.state, 'behind');
      assert.equal(result.behindBy, 7);
      // 提交信息是多行的，界面只放得下一行 —— 必须取主题行。
      assert.equal(result.latestSubject, 'fix: newer');
    },
  );
});

test('GitHub 落后于线上（本地有提交没推）→ ahead', async () => {
  /*
   * 上一条的反面。两条必须同时存在：只留一条的话，一个把两个方向对调的固定实现
   * 照样能让它通过 —— 而那正是这个文件里曾经发生的事。
   */
  resetBuildInfoCache();
  await withFetch(
    (url) =>
      url.includes('/compare/')
        ? { body: { status: 'behind', behind_by: 3 } }
        : { body: { sha: 'd'.repeat(40), commit: { message: 'old', committer: { date: 'd' } } } },
    async () => {
      const result = await checkForUpdates(info());
      assert.equal(result.state, 'ahead', 'GitHub 落后线上 = 本地有提交没推');
      assert.match(result.message, /领先 GitHub/);
    },
  );
});

test('线上那个提交在远端找不到（改完没推就部署）→ unknown，不猜方向', async () => {
  resetBuildInfoCache();
  await withFetch(
    (url) => {
      if (url.includes('/compare/')) return { status: 404, body: {} };
      return { body: { sha: 'c'.repeat(40), commit: { message: 'x' } } };
    },
    async () => {
      const result = await checkForUpdates(info());
      assert.equal(result.state, 'unknown');
      assert.match(result.message, /推送|找不到/);
    },
  );
});

test('网络失败 → unknown，且错误消息是我们自己的话', async () => {
  resetBuildInfoCache();
  await withFetch(
    () => new Error('connect ETIMEDOUT'),
    async () => {
      const result = await checkForUpdates(info());
      assert.equal(result.state, 'unknown');
      assert.match(result.message, /无法连接 GitHub/);
    },
  );
});

test('绝不转述外部响应体 —— 它可能很长，也可能含有我们不该替它转述的内容', async () => {
  /*
   * 这个用例刻意**不**去运行时改 `GITHUB_TOKEN`：`env` 是在 import 时从
   * `process.env` 求值一次的常量，运行时改环境变量不会影响它 —— 那样写出来的
   * 断言只会在测一个恒为空的分支，是一条**假测试**。
   *
   * 真正该钉的不变量是：无论外部返回什么，回给操作员的文本都只有我们自己写的句子。
   */
  resetBuildInfoCache();
  await withFetch(
    () => ({ status: 500, body: { token: 'LEAK_SENTINEL', detail: 'internal stack trace' } }),
    async () => {
      const result = await checkForUpdates(info());
      assert.equal(result.state, 'unknown');
      const serialised = JSON.stringify(result);
      assert.ok(!serialised.includes('LEAK_SENTINEL'), '把响应体转述了出去');
      assert.ok(!serialised.includes('internal stack trace'), '把响应体转述了出去');
    },
  );
});

test('HTTP 403 被说成"速率受限"，而不是一个裸的状态码', async () => {
  resetBuildInfoCache();
  await withFetch(
    () => ({ status: 403, body: {} }),
    async () => {
      const result = await checkForUpdates(info());
      assert.equal(result.state, 'unknown');
      assert.match(result.message, /速率受限/);
    },
  );
});

test('结果被缓存：反复查看这一页不会反复打 GitHub', async () => {
  resetBuildInfoCache();
  const local = info();
  let calls = 0;
  await withFetch(
    () => {
      calls += 1;
      return { body: { sha: local.commit, commit: { message: 'x' } } };
    },
    async () => {
      await checkForUpdates(local);
      await checkForUpdates(local);
      await checkForUpdates(local);
    },
  );
  // 未认证的 GitHub 限额是 60 次/小时/IP —— 每次刷新都打一次是会把限额烧完的。
  assert.equal(calls, 1);
});

/* -------------------------------------------------------------------------- */
/*  Product version                                                            */
/* -------------------------------------------------------------------------- */

test('产品版本来自 package.json，而不是一个写死的字符串', () => {
  const version = readAppVersion();
  assert.notEqual(version, 'unknown', '读不到 package.json —— 路径或解析有问题');
  assert.match(version, /^\d+\.\d+\.\d+/);
});
