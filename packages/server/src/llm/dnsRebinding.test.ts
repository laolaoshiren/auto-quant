/**
 * **DNS rebinding 必须在连接层被封死**（外部 issue #126）。
 *
 * ## 缺口形状
 *
 * `checkOutboundUrl` 判的是 URL 里的**字面主机**。一个公开域名会被放行 ——
 * 而它在 DNS 里解析到 `169.254.169.254` 时，请求会**真的**打到云元数据服务，
 * 拿回实例临时凭据，再通过 `test-draft` 探测结果或交易循环报错回显出去。
 *
 * 根因是**时间差**：字面主机在 `fetch` 之前检查，真实 IP 在连接时才确定。
 *
 * ## ⚠️ 这个测试为什么不满足于"函数返回 false"
 *
 * "判据函数说不行"与"请求真的没发出去"是**两件事**。前者只要接线错一处
 *（例如 dispatcher 忘了传给 `fetch`、或跳转那一跳没带）就完全失效，
 * 而单元测试仍然是绿的。
 *
 * 所以这里做**真实端到端**：起一个本地 HTTP 服务当"内网目标"，
 * 用 `localhost`（字面主机不是 IP、但解析到 127.0.0.1 —— 正是 rebinding 的形状）
 * 去请求它，断言**凭据没有泄露**。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { checkResolvedAddress, checkOutboundUrl } from './urlGuard.js';
import { guardedDispatcher } from './http.js';
import { Agent, fetch as undiciFetch } from 'undici';

/* -------------------------------------------------------------------------- */
/*  ① 判据本身：解析结果按同一套网段规则                                        */
/* -------------------------------------------------------------------------- */

test('★★★ 解析结果落到内网一律拒绝 —— 与字面校验同一套规则', () => {
  /*
   * 这一层的价值：`checkOutboundUrl('http://attacker.example.com/')` 会**放行**
   *（它不是 IP），而它的解析结果必须被拦下。
   */
  for (const [address, why] of [
    ['169.254.169.254', '云元数据（AWS/阿里/GCP）'],
    ['127.0.0.1', '回环'],
    ['10.0.0.5', 'RFC1918'],
    ['172.16.3.4', 'RFC1918'],
    ['192.168.1.1', 'RFC1918'],
    ['100.100.100.200', '阿里云元数据（CGNAT 段）'],
    ['192.0.0.192', 'Oracle Cloud 元数据'],
    ['::1', 'IPv6 回环'],
    ['fd00::1', 'IPv6 ULA'],
  ] as const) {
    const verdict = checkResolvedAddress(address);
    assert.equal(verdict.allowed, false, `★★★ 解析到 ${address}（${why}）必须被拒绝`);
  }
});

test('★ 解析到公网地址放行 —— 不能把正常出站也挡了', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(checkResolvedAddress(address).allowed, true, `${address} 是公网，必须放行`);
  }
});

test('★★ 字面主机这一层仍然放行公开域名 —— 说明缺口确实存在、补的是另一层', () => {
  /*
   * ⚠️ 这条**钉住缺口的形状**：`checkOutboundUrl` 对公开域名返回 allowed。
   * 如果哪天它变成 false（例如有人加了"必须解析"的逻辑），这条会失败 ——
   * 那说明防线位置变了，需要重新审视连接层那一段是否还有意义。
   */
  assert.equal(
    checkOutboundUrl('http://attacker.example.com/v1').allowed,
    true,
    '字面校验放行公开域名（这正是 DNS rebinding 能绕过的原因）',
  );
});

/* -------------------------------------------------------------------------- */
/*  ② 端到端：请求真的没打出去                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 起一个只监听回环的"内网服务"，返回它的端口与关闭句柄。
 *
 * 它回的内容是 `SECRET-…` —— 模拟云元数据的凭据响应体。
 */
async function internalService(): Promise<{ port: number; close: () => void; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('SECRET-INSTANCE-CREDENTIALS');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    close: () => server.close(),
    hits: () => hits,
  };
}

test('★★★ 端到端：公开域名解析到内网时，请求【真的】没有发出去（凭据不泄露）', async () => {
  const target = await internalService();
  try {
    /*
     * `localhost` 就是 `attacker.example.com` 的等价形状：
     * **字面主机不是 IP 字面量**，而它解析到 127.0.0.1。
     */
    const url = `http://localhost:${target.port}/latest/meta-data/iam/security-credentials/`;

    /* 先确认这个形状本身确实能泄露（否则下面的断言是空的）。 */
    const leaked = await undiciFetch(url)
      .then((r) => r.text())
      .catch((e) => `ERR:${String(e).slice(0, 60)}`);
    assert.ok(
      leaked.includes('SECRET'),
      '前置断言：不装连接层校验时，这个形状确实会泄露 —— 否则后面的断言没有意义',
    );

    /*
     * 现在换成**穿过真正防线**的请求：undici + `guardedDispatcher`。
     * ⚠️ 用 `undiciFetch` 而不是全局 `fetch` —— 两者是同一个实现，
     * 而 `undiciFetch` 的类型签名认 `dispatcher`，不需要类型断言。
     */
    const blocked = await undiciFetch(url, { dispatcher: guardedDispatcher([]) })
      .then((r) => r.text())
      .catch((e) => `ERR:${String(e?.cause?.message ?? e?.message ?? e).slice(0, 80)}`);

    assert.ok(
      !blocked.includes('SECRET'),
      '★★★ 装了连接层校验后**凭据仍然泄露了** —— 说明 dispatcher 没有真正接管连接',
    );
    assert.match(blocked, /ERR:/, '★★ 应当是"连接被拒绝"，而不是收到了响应体');
    assert.equal(target.hits(), 1, '★ 只有前置那一次请求真的打到了服务（防线的请求不该到达）');
  } finally {
    target.close();
  }
});

test('★★ 白名单放行时连接层也放行 —— 自建内网网关不能被打死', async () => {
  const target = await internalService();
  try {
    /*
     * `allowPrivateHosts` 里显式登记 `localhost` 后，连接层应当放行 ——
     * 那是操作员的决定（`AQ_ALLOW_PRIVATE_LLM_HOSTS`）。
     */
    const url = `http://localhost:${target.port}/v1/models`;
    const text = await undiciFetch(url, { dispatcher: guardedDispatcher(['localhost']) })
      .then((r) => r.text())
      .catch((e) => `ERR:${String(e?.cause?.message ?? e?.message ?? e).slice(0, 80)}`);

    assert.match(text, /SECRET/, '★★ 显式登记的内网主机必须能连上');
  } finally {
    target.close();
  }
});

/* -------------------------------------------------------------------------- */
/*  ③ 缓存：同一个白名单复用同一个 agent（keep-alive 不被丢掉）                    */
/* -------------------------------------------------------------------------- */

test('★ 同一份白名单复用同一个 dispatcher（否则每次都丢 keep-alive）', () => {
  /*
   * 模型调用很密集，每次新建 `Agent` 会丢掉连接池 —— 那会让每一次调用都重新握手。
   * 缓存键是**排序后的白名单内容**，所以顺序不同但内容相同的两份配置复用一个。
   */
  const a = guardedDispatcher(['gw.corp', '10.0.0.1']);
  const b = guardedDispatcher(['10.0.0.1', 'gw.corp']);
  assert.equal(a, b, '★ 内容相同（顺序不同）必须复用');

  const c = guardedDispatcher(['other.corp']);
  assert.notEqual(a, c, '★ 内容不同必须分开（否则白名单会串）');
});

test('★★ 连接层校验用的是 undici 的 Agent（真的是连接层，不是字符串层）', () => {
  assert.ok(
    guardedDispatcher([]) instanceof Agent,
    '★ 必须是 undici Agent —— 只有它的 `connect.lookup` 能在建立连接前拿到解析结果',
  );
});
