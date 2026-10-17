/**
 * **undici 自己的响应超时必须晚于应用层的模型超时** —— 实盘 P0 回归测试（2026-10-17）。
 *
 * ## 这个 BUG 的形状（线上 `#10`，真实资金）
 *
 * `#10` 连续 8 轮决策失败，日志是：
 *
 * ```
 *   llm:   Cannot reach custom: fetch failed
 *   自检:  AI 服务持续失联近 5 小时，决策循环完全停摆
 * ```
 *
 * 而同一时刻：`curl` 直连那个网关 200 / 2.3 秒；团队模式的 `#11`（提示词只有它的一半）
 * 成功。真正的指纹是"用它的真实提示词复现时**恰好在 300 秒**断"。
 *
 * `llm/http.ts` 的 `guardedDispatcher()` 建 `new Agent({...})` 时只设了
 * `connect.lookup`（DNS rebinding 校验），**没设 `headersTimeout` / `bodyTimeout`**
 * ⇒ undici 用**默认的 300 秒**（`node_modules/undici/lib/dispatcher/client.js`
 * 里写死 `300e3`）⇒ 一次"要推理 5 分钟以上"的调用会被 undici 先 abort
 * ⇒ 抛 `TypeError: fetch failed`（真因 `HeadersTimeoutError` 藏在 `error.cause` 里）
 * ⇒ 应用层把它归类成"连不上" ⇒ **错误信息说谎**，排查被带偏一整圈。
 *
 * ## 这一组用例钉住四件事（全部是**实测出来的行为**，不是读文档推的）
 *
 * 1. **常量契约**：`GUARDED_RESPONSE_TIMEOUT_MS` 必须**严格大于**线上实测的
 *    600 秒模型超时；
 * 2. **这两个参数真的作用在 undici 上**：响应头迟 2 秒才回 + 超时给 200ms
 *    → 必须失败，且 `error.cause` 是 `HeadersTimeoutError`；
 * 3. **它不会误杀慢响应**：同一个服务、超时给足（4 秒）→ 必须成功 200；
 * 4. **没有把它放松成"永远等"**：一个**真的连不上**的端点必须**快速**失败
 *    且是连接类错误 —— 连接建立超时保持 undici 默认的 10 秒，一个字都没改。
 *
 * ⚠️ **一条实测边界（重要，别把它当成"永远准"）**：undici 的超时**不是**
 * 精确到毫秒的—— 实测把超时设成 200ms 时，它大约在 **1000ms** 才触发
 * （检查粒度约 1 秒）。所以本文件用"2000ms 的服务 vs 200ms 的超时"这种
 * **差一个数量级**的配置来取得确定性，而不是用 150ms vs 400ms 那种贴边的配置
 * （那样会因为粒度而**测不出差别**——第一版就是这么写错的）。
 *
 * 全程本地回环 + 零外网 + 零模型调用。
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { fetch as undiciFetch } from 'undici';

import { guardedDispatcher, GUARDED_RESPONSE_TIMEOUT_MS } from './http.js';

/** 线上实测的模型超时（`ai_models.timeout_seconds`，`#10` = 600 秒）。 */
const LIVE_MODEL_TIMEOUT_MS = 600_000;

describe('undici 响应超时：必须晚于应用层', () => {
  it('★★★ 常量必须严格大于线上实测的模型超时（否则 undici 又先 abort、错误信息又说谎）', () => {
    assert.ok(
      GUARDED_RESPONSE_TIMEOUT_MS > LIVE_MODEL_TIMEOUT_MS,
      `★ GUARDED_RESPONSE_TIMEOUT_MS=${GUARDED_RESPONSE_TIMEOUT_MS} 必须大于 ` +
        `${LIVE_MODEL_TIMEOUT_MS}（线上 #10 的 timeout_seconds=600）——` +
        '否则一次"推理超过 300 秒"的调用会被 undici 掐断成 `fetch failed`，' +
        '而日志会说成"连不上"。',
    );
    assert.ok(
      GUARDED_RESPONSE_TIMEOUT_MS <= 60 * 60_000,
      '★ 它该是有限上界，不该被设成"永远等"',
    );
  });
});

/**
 * 一个本地服务：**响应头要等 `delayMs` 才回**（模拟"模型在慢慢推理"）。
 *
 * 这正是线上那次的形状：请求发出后 300 秒内**没有任何响应头**。
 */
function slowHeadersServer(delayMs: number): Promise<{ server: Server; url: string }> {
  return open((_req: IncomingMessage, res: ServerResponse) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, delayMs);
  });
}

/** 头立刻回、**正文**要等 `delayMs` 才结束（bodyTimeout 的场景）。 */
function slowBodyServer(delayMs: number): Promise<{ server: Server; url: string }> {
  return open((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"ok":');
    setTimeout(() => res.end('true}'), delayMs);
  });
}

function open(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1/chat/completions` });
    });
  });
}

describe('超时参数真的作用在 undici 上（不是"写了等于没写"）', () => {
  let slowHeaders: { server: Server; url: string };

  before(async () => {
    /* 2000ms 才回头：比下面那个 200ms 的超时大一个数量级（粒度约 1s）。 */
    slowHeaders = await slowHeadersServer(2_000);
  });

  after(() => {
    slowHeaders.server.close();
  });

  it('★★★ 响应头迟 2 秒才回 + 超时 200ms → 必须失败，且 cause 是 HeadersTimeoutError', async () => {
    const dispatcher = guardedDispatcher(['127.0.0.1'], { responseTimeoutMs: 200 });

    await assert.rejects(
      () => undiciFetch(slowHeaders.url, { dispatcher }),
      (error: unknown) => {
        /*
         * ⚠️ **这就是线上那句误导性错误信息的出处**：message 是 `fetch failed`，
         * 而真因在 `cause` 里（`HeadersTimeoutError`）。
         * 断言 cause —— 那正是"必须让应用层先动手、才能给出正确语义"的理由。
         */
        const cause = (error as { cause?: { constructor?: { name?: string }; code?: string } }).cause;
        const name = cause?.constructor?.name ?? cause?.code ?? '';
        assert.match(
          name,
          /HeadersTimeout/,
          `★ 必须是 undici 的响应头超时（实际 cause=${name}）—— 否则这个参数根本没传下去`,
        );
        return true;
      },
      '★ 200ms 的超时必须真的掐断这个 2 秒不回头的请求',
    );
  });

  it('★★ 同一个服务、超时给足（4 秒）→ 必须成功 200（不误杀慢响应）', async () => {
    const dispatcher = guardedDispatcher(['127.0.0.1'], { responseTimeoutMs: 4_000 });

    const response = await undiciFetch(slowHeaders.url, { dispatcher });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it('★★ 正文慢（头已回）时由 bodyTimeout 收口 —— 参数真的同时设了两个', async () => {
    const slow = await slowBodyServer(2_000);
    try {
      const dispatcher = guardedDispatcher(['127.0.0.1'], { responseTimeoutMs: 200 });
      await assert.rejects(
        () => undiciFetch(slow.url, { dispatcher }).then((r) => r.text()),
        (error: unknown) => {
          const cause = (error as { cause?: { constructor?: { name?: string } } }).cause;
          assert.match(
            cause?.constructor?.name ?? '',
            /BodyTimeout/,
            `★ 正文慢时该由 bodyTimeout 收口（实际 cause=${cause?.constructor?.name ?? '-'}）`,
          );
          return true;
        },
      );
    } finally {
      slow.server.close();
    }
  });

  it('★ 缓存键必须带上超时值 —— 否则"传了参数却不生效"（同一个 agent 被复用）', () => {
    const a = guardedDispatcher(['127.0.0.1'], { responseTimeoutMs: 200 });
    const b = guardedDispatcher(['127.0.0.1'], { responseTimeoutMs: 200 });
    const c = guardedDispatcher(['127.0.0.1'], { responseTimeoutMs: 4_000 });

    assert.equal(a, b, '同一白名单 + 同一超时 → 复用（keep-alive 不能被丢掉）');
    assert.notEqual(a, c, '★ 不同超时必须是不同的 agent —— 否则后者拿到的是前者的超时');
  });
});

describe('负向校准：没有把超时闸门放松成"永远等"', () => {
  it('★★★ 真的连不上的端点 → 仍快速失败，且是连接类错误', async () => {
    const dispatcher = guardedDispatcher(['127.0.0.1']);
    const started = Date.now();

    await assert.rejects(
      () => undiciFetch('http://127.0.0.1:65533/v1/chat/completions', { dispatcher }),
      (error: unknown) => {
        assert.match(
          String(error),
          /fetch failed|ECONNREFUSED|connect/i,
          `★ 连不上时必须是连接类错误（实际：${String(error)}）`,
        );
        return true;
      },
      '★ 连不上的端点必须失败 —— 这一条防的是"把闸门放松成永远等"',
    );

    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 5_000,
      `★ 连不上必须**快速**失败（实际 ${elapsed}ms）—— connectTimeout 保持 undici 默认的 10 秒，没有被动过`,
    );
  });

  it('★★ 正常小请求的行为逐字节不变（默认 dispatcher + 快服务 → 200）', async () => {
    const fast = await open((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const dispatcher = guardedDispatcher(['127.0.0.1']);
      const response = await undiciFetch(fast.url, { dispatcher });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    } finally {
      fast.server.close();
    }
  });
});
