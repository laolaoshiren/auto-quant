import { lookup } from 'node:dns';
import { Agent, type Dispatcher } from 'undici';
import {
  abortError,
  classifyHttpError,
  classifyMinimaxBaseResp,
  connectionError,
  timeoutError,
} from './errors.js';
import { checkOutboundUrl, checkResolvedAddress, parseHostAllowlist } from './urlGuard.js';
import { env } from '../env.js';
import type { LlmProviderId } from '@aq/shared';
import type { OutboundRequest } from './types.js';
import { mergeOpenAiStreamChunks, readOpenAiStreamLines } from './stream.js';

/** 需要跟着走的重定向状态码。304 不在内 —— 它不是跳转。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 重定向的上限。
 *
 * `fetch` 默认 `redirect: 'follow'`，而**每一次跳转都不再过 `urlGuard`** ——
 * 那层校验只看了我们拼出来的第一个 URL。后果正是 `urlGuard.ts` 文件头要防的
 * 那个升级路径：`baseUrl` 填一个**合法的公网地址**（校验通过），它回一个
 * `302 Location: http://169.254.169.254/latest/meta-data/iam/security-credentials/`，
 * undici 就带着我们的密钥打到云元数据服务上，而没有任何一道闸拦得住。
 *
 * 所以这里改成**手动跟随**：每一跳都重跑 `checkOutboundUrl`。
 * 合法用途（网关换域名、http→https 归一）继续可用，因为它们的目标同样是公网地址；
 * 打到回环 / 链路本地 / RFC1918 的那一跳会被拒绝，与直接填写该地址的结果一致。
 *
 * 上限的存在是为了不让一个互相指向的网关把我们挂死在重定向里。
 */
const MAX_REDIRECTS = 5;

/**
 * **undici 自己的"响应头 / 响应体"超时**（毫秒）—— 实盘 P0，2026-10-17。
 *
 * ## 为什么必须设它（不改的话，错误信息会说谎）
 *
 * `new Agent({...})` 不传这两个值时，undici 用**自己的默认值 300 秒**。
 * 而本项目的模型超时来自 `ai_models.timeout_seconds`（线上那个 `#10` 是 **600 秒**）
 * —— 于是 **undici 比应用层先 abort**：
 *
 * ```
 *   ① undici 在 300s 掐断连接 → 抛 TypeError: fetch failed
 *   ② 应用层把它归类成"连不上" → 日志写「AI 服务不可用」
 *   ③ 自检再概括成「AI 服务持续失联近 5 小时」
 * ```
 *
 * 而真相是"**这次推理比 300 秒慢**"：同一时刻 `curl` 直连那个网关是 200 / 2.3 秒，
 * 团队模式的机器人（提示词只有它的 1/2）也成功。**一条说错方向的错误信息，
 * 让排查绕了整整一圈** —— 这正是本仓反复强调"错误信息必须说实话"的那种代价。
 *
 * ## 为什么是 900 秒（而不是 301 秒）
 *
 * 取值必须**严格大于任何可能的 `timeout_seconds`**：只要应用层的
 * `AbortSignal.timeout(600s)` 先触发，抛出的就是**语义正确**的超时错误
 * （可重试、日志里写"超时"而不是"连不上"）。900 秒给 600 秒留了 50% 余量。
 *
 * ⚠️ **如果哪天把 `ai_models.timeout_seconds` 配到 900 秒以上，这个值必须一起调大** ——
 * 否则又会出现"undici 先断、错误信息说谎"。`undiciResponseTimeout.test.ts`
 * 里有一条判据把这个关系钉住（它断言这里 **大于** 线上实测的 600 秒）。
 *
 * ⚠️ **它不该被理解成"放松了超时闸门"**：
 *   · `connectTimeout`（连接建立）**保持 undici 默认的 10 秒** —— 真连不上的端点
 *     仍然在 10 秒内快速失败，报 `Cannot reach`（负向校准用例二钉住这一条）；
 *   · 真正的"这次调用最多等多久"仍由应用层的 `AbortSignal.timeout` 决定，
 *     而这个值只负责"别比应用层先动手"。
 */
export const GUARDED_RESPONSE_TIMEOUT_MS = 900_000;

/**
 * **连接层校验：DNS rebinding 的正解**（外部 issue #126）。
 *
 * ## 为什么 `checkOutboundUrl` 不够
 *
 * 它判的是 URL 里的**字面主机**。一个公开域名（`attacker.example.com`）会被放行 ——
 * 而它在 DNS 里解析到 `169.254.169.254` 时，请求会**真的**打到云元数据服务，
 * 拿回实例临时凭据，再通过 `test-draft` 的探测结果或交易循环的报错信息回显出去。
 *
 * 根因是**时间差**：字面主机在 `fetch` 之前检查，真实 IP 在连接时才确定。
 * 所以唯一封得死的位置就是**这里** —— 解析结果刚出来、socket 还没连上。
 *
 * ## 为什么不走"方案 A"（在 `checkOutboundUrl` 里再 `dns.lookup` 一次）
 *
 * 那是**两次独立的 DNS 查询**，TTL=0 的域名可以在两次之间换答案（经典 rebinding）。
 * 它把门槛从"可控域名"提到"可控域名 + 会颤动的权威 DNS"，但没有封死。
 *
 * ## 这个钩子怎么工作
 *
 * undici 在建立连接前调用 `connect.lookup(hostname, options, cb)` 拿地址。
 * 我们把默认实现换掉：先真的解析，然后**逐个地址**过
 * `checkResolvedAddress()`（与 `checkOutboundUrl` 同一套网段规则）。
 * 有一个地址落在内网就整体拒绝 —— 因为**我们无法控制 undici 选中哪一个**，
 * 只要有一个可能是内网地址，这次连接就是不可信的。
 *
 * ⚠️ **不通过时用 `ENOTFOUND`**：那是 DNS 层的"查不到"，
 * 比自定义错误码更不容易在链路上被当成可重试的服务端错误；
 * 而"连不上"这个语义也正是我们要的（地址被拒绝 = 等效于它不存在）。
 *
 * ## 为什么按 `allowPrivateHosts` 缓存
 *
 * `Agent` 持有连接池，每次请求都新建一个会丢掉 keep-alive（而本项目的
 * 模型调用很密集）。所以按**白名单内容**缓存：同一个白名单配置复用同一个 agent。
 * 白名单在进程内是稳定的（来自环境变量），所以缓存不会失效 —— 但如果将来它变成
 * 可热改的配置，这里必须跟着改，否则改动不会生效。
 */
const agentCache = new Map<string, Dispatcher>();

/** 取一个带连接层校验的 undici `Dispatcher`。 */
export function guardedDispatcher(
  allowPrivateHosts: readonly string[],
  /**
   * 仅用于测试与将来的"按应用超时联动"：覆盖 `headersTimeout` / `bodyTimeout`。
   * 不传 = `GUARDED_RESPONSE_TIMEOUT_MS`（见它上面那段为什么不设会让错误信息说谎）。
   */
  options: { responseTimeoutMs?: number } = {},
): Dispatcher {
  const responseTimeoutMs = options.responseTimeoutMs ?? GUARDED_RESPONSE_TIMEOUT_MS;
  /*
   * ⚠️ **缓存键必须带上超时值**：同一个白名单配不同超时会拿到同一个 agent，
   * 于是"传了参数却不生效"——那正是本仓最忌讳的那种静默失效。
   */
  const key = `${[...allowPrivateHosts].sort().join(',')}|${responseTimeoutMs}`;
  const cached = agentCache.get(key);
  if (cached) return cached;

  const agent = new Agent({
    /*
     * ⚠️⚠️ **这两个值必须由我们给**（见 `GUARDED_RESPONSE_TIMEOUT_MS` 的长注释）：
     * undici 的默认是 300 秒，而应用的模型超时是 600 秒 ⇒ undici 先 abort ⇒
     * `TypeError: fetch failed` ⇒ 日志写"AI 服务不可用" ⇒ 排查方向被带偏。
     */
    headersTimeout: responseTimeoutMs,
    bodyTimeout: responseTimeoutMs,
    connect: {
      lookup: (hostname, options, callback) => {
        /*
         * 先把"字面主机"这一层再过一遍 —— 主机名后缀（`.internal` 等）
         * 与 `localhost` 在这里同样该挡，而它们**不会**被解析结果判据覆盖
         *（`localhost` 也解析到 127.0.0.1，所以两者重叠；但 `.internal`
         * 可能解析到一个公网 IP，那时只有这一层能挡）。
         */
        const literalVerdict = checkOutboundUrl(`http://${hostname}/`, allowPrivateHosts);
        if (!literalVerdict.allowed) {
          const error: NodeJS.ErrnoException = new Error(
            `出站地址被拒绝：${literalVerdict.reason ?? hostname}`,
          );
          error.code = 'ENOTFOUND';
          callback(error, '', 4);
          return;
        }

        lookupAll(hostname, options).then(
          (addresses) => {
            for (const { address } of addresses) {
              /*
               * ⚠️ **必须把原主机名带进白名单匹配**：操作员登记的可能是主机名
               *（`AQ_ALLOW_PRIVATE_LLM_HOSTS=localhost`），而这里是解析结果
               *（`::1` / `127.0.0.1`）。不带的话白名单"登记了却连不上"，
               * 且报错完全指不到白名单（实测形态：IPv4 那侧碰巧放行、IPv6 那侧被拒）。
               */
              const verdict = checkResolvedAddress(address, allowPrivateHosts, hostname);
              if (!verdict.allowed) {
                const error: NodeJS.ErrnoException = new Error(
                  `出站地址被拒绝：${hostname} ${verdict.reason ?? ''}`,
                );
                error.code = 'ENOTFOUND';
                callback(error, '', 4);
                return;
              }
            }
            /*
             * ⚠️ **把校验过的地址原样交给 undici，不让它再解析一次。**
             * 再解析一次就是方案 A 的那个时间差 —— 校验与连接必须是**同一次**结果。
             */
            const first = addresses[0];
            if (!first) {
              const error: NodeJS.ErrnoException = new Error(`无法解析主机名：${hostname}`);
              error.code = 'ENOTFOUND';
              callback(error, '', 4);
              return;
            }
            /*
             * `all: true` 时 undici 要的是数组；否则要 (address, family) 两个参数。
             * 两种形状都支持 —— 判断依据是 `options.all`，与 `dns.lookup` 的约定一致。
             */
            if (options.all) callback(null, addresses);
            else callback(null, first.address, first.family);
          },
          (error: NodeJS.ErrnoException) => callback(error, '', 4),
        );
      },
    },
  });

  agentCache.set(key, agent);
  return agent;
}

/**
 * 解析主机名的**全部**地址。
 *
 * 用 `all: true` 是刻意的：只校验第一个地址会漏掉"第二个是内网"的情形，
 * 而 undici 会自己挑一个（Happy Eyeballs / 轮询）—— 我们无法预判它挑哪个。
 * 所以**有一个内网就整体拒绝**。
 *
 * `verbatim` 保持 Node 默认（不重排），因为重排会改变 `addresses[0]`，
 * 而那个值是我们要交给 undici 的。
 */
function lookupAll(
  hostname: string,
  options: { family?: number | 'IPv4' | 'IPv6' },
): Promise<Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    lookup(
      hostname,
      { all: true, ...(options.family !== undefined ? { family: options.family as 0 | 4 | 6 } : {}) },
      (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses as Array<{ address: string; family: number }>);
      },
    );
  });
}

/**
 * 发出一次出站请求，并**在每一跳重定向上都重跑出站地址白名单**。
 *
 * ⚠️ **跨主机跳转时不带原始请求头。**
 *
 * 不只是防止密钥进日志 —— 这里的风险是请求头被**转发到另一台主机**：
 * `x-api-key` / `api-key` / `x-goog-api-key` / `Authorization` 都是各家鉴权头，
 * 跳到 `169.254.169.254` 或 `127.0.0.1` 时，它们会被一起带过去。
 * 同主机的 http→https 归一（同一组端点）保留鉴权头，否则那一跳会直接 401。
 */
export async function fetchGuarded(url: string, init: RequestInit): Promise<Response> {
  const allowPrivateHosts = parseHostAllowlist(env.allowPrivateLlmHosts);
  /*
   * ⚠️ **每一次跳转都要带上这个 dispatcher**（外部 issue #126）——
   * 它在**连接层**校验解析结果，那才是 DNS rebinding 唯一封得死的位置。
   * 少了它，`checkOutboundUrl` 的字面校验对"公开域名解析到内网"完全无效。
   */
  const dispatcher = guardedDispatcher(allowPrivateHosts);
  let current = url;
  let headers = init.headers;

  for (let hop = 0; ; hop += 1) {
    const verdict = checkOutboundUrl(current, allowPrivateHosts);
    if (!verdict.allowed) {
      throw connectionError('outbound', new Error(`出站地址被拒绝：${verdict.reason ?? current}`));
    }

    /*
     * ⚠️ `dispatcher` 是 **undici 的扩展**，不在标准 `RequestInit` 里 ——
     * 所以要先 `as unknown`。Node 的全局 `fetch` 在运行时确实认这个字段
     *（它就是 undici 的实现），但 `@types/node` 的签名里没有它。
     */
    const response = await fetch(current, {
      ...init,
      headers,
      redirect: 'manual',
      dispatcher,
    } as unknown as RequestInit);

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    /*
     * 从这一行往下，`response` 只是我们要跟着走的中转站 —— 它的 body 必须丢掉：
     * 不消费它，那一跳的连接就一直挂着不释放，而这是一台 7x24 常在的服务器，
     * 跳转次数累积起来就是 fd 泄漏。`cancel()` 失败（已经结束）时忽略即可，
     * 它只是清理，不是业务逻辑。
     *
     * **放在所有提前 return / throw 之前**，是为了让"带个响应体离开这个分支"的
     * 每条路径都经过它 —— 否则迟早会有一条忘了 cancel。
     */
    void response.body?.cancel().catch(() => undefined);

    const location = response.headers.get('location');
    if (!location) return response;
    if (hop >= MAX_REDIRECTS) {
      throw connectionError('outbound', new Error(`重定向超过 ${MAX_REDIRECTS} 跳，已放弃`));
    }

    // 相对 Location 要按当前 URL 解析，否则换路径的网关会丢整段 base。
    const next = new URL(location, current).toString();
    if (new URL(next).host !== new URL(current).host) {
      // 跨主机：丢掉全部请求头（见上面那段为什么）。
      headers = undefined;
    }
    current = next;
  }
}

/**
 * Shared HTTP plumbing for every adapter.
 *
 * Deliberately small: URL joining, JSON body reading, and the translation of
 * transport-level failures into `LlmError`. Retry, backoff and timeout policy
 * live in `client.ts` so all providers share one implementation.
 */

/** Vendors with an trailing slash in their descriptor would otherwise produce `//chat`. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Kimi answers a gateway timeout with an HTML error page (B.7), and OpenRouter
 * masks its 5xx messages, so a JSON parse failure must never mask the status.
 */
export function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Hand the raw text back so error extraction still sees something useful.
    return text;
  }
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  body: unknown;
  rawText: string;
  retryAfterMs: number | null;
}

/**
 * Parse `Retry-After` in both documented forms (delta-seconds and HTTP-date)
 * and clamp it, so a hostile or buggy value cannot stall the bot for hours
 * (B.14 rule 1).
 *
 * ⚠️ **delta-seconds 必须是纯十进制数字（`1*DIGIT`），其余一律不按秒、也不按日期。**
 *
 * 旧写法先 `Number(trimmed)`，于是 `-5` / `0x10` / `1e3` / `+7` / `12.5` 都被当成秒数接受；
 * 而 `-5` 更糟：它 `Number` 有限但 `< 0`，于是落进**日期**分支，被 `Date.parse('-5')`
 * 读成 2001 年——一个早已过去的时间，`max(过去, 0) = 0`。
 * 结果是 `client.ts` 的 `retryAfterMs ?? backoffDelayMs(...)` 取到 **0**，退避形同不存在。
 * 一个行为异常的网关就能让我们以最快节奏连续重打，**方向与全抖动防 IP 封禁的意图完全相反**。
 *
 * 非法数字返回 `null`，让调用点回落到全抖动退避——那才是"对方没给可用的等待提示"时该做的事。
 * （`Retry-After: 0` 仍返回 0：那是 RFC 里合法的"立刻重试"，与 `-5` 这种垃圾值不同。）
 */
export function parseRetryAfter(value: string | null, maxMs = 60_000): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  /* RFC 9110 的 delta-seconds 是 `1*DIGIT` —— 带符号、小数点、指数、十六进制的都不是。 */
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, maxMs);

  /*
   * 能 `Number` 出有限值、又不是纯数字的串（`-5`、`0x10`、`1e3`、`12.5`…）是畸形秒数，
   * **绝不能落进日期分支**（`Date.parse('-5')` 会把 `-5` 读成年份）。直接判非法。
   */
  if (Number.isFinite(Number(trimmed))) return null;

  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), maxMs);
  return null;
}

/**
 * Issue one HTTP call.
 *
 * `failFastOnMinimaxBaseResp` must stay true for MiniMax, which reports errors
 * inside an HTTP 200 body. Any 2xx with a non-zero `base_resp.status_code` is
 * raised as an `LlmError` here rather than being returned as a completion.
 */
export async function executeJsonRequest(
  provider: LlmProviderId | string,
  request: OutboundRequest,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    failFastOnMinimaxBaseResp?: boolean;
  } = {},
): Promise<JsonResponse> {
  /*
   * ⚠️ **响应体的读取要有自己的错误分类，两条路径语义一致。**
   *
   * 原来 `response.text()` 裸抛，落在所有 try 之外，于是"头部已回、body 读到一半
   * 被重置"抛的是原生 `TypeError: fetch failed` —— `isRetryable()` 只认 `LlmError`，
   * 一次本可重试的抖动被判成永久失败。#135 的外部实测坐实它比表面更重：同一故障
   * 注入下，**流式路径保住 `status=429` 与 `Retry-After`（30s 退避），非流式连这两
   * 个一起丢**，只剩一条裸 `TypeError` 给操作员。
   *
   * 分类规则（与流式路径同构，"错误分类只有一份逻辑"）：
   *   · 调用方按下的取消 → `abortError`，**不重试**（重试等于把取消复活）；
   *   · 非 2xx → 状态码已经在手，body 没读到也**照样按 status 分类**
   *     （429 → 可重试、`retryAfterMs` 仍取自响应头）—— 这正是流式的行为；
   *   · 2xx 却没读到 body → 真·传输断裂，`connectionError`（可重试）。
   */
  let response: Response;
  let rawText: string;
  try {
    response = await fetchGuarded(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // An abort raised by our own timeout is a retryable slow generation; an
    // abort raised by the caller is a cancellation and must not be retried.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw timeoutError(String(provider), options.timeoutMs ?? 0);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw abortError(String(provider), error);
    }
    throw connectionError(String(provider), error);
  }

  try {
    rawText = await response.text();
  } catch (error) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    if (options.signal?.aborted) throw abortError(String(provider), error);
    if (!response.ok) {
      const classified = classifyHttpError(String(provider), response.status, null, '');
      classified.retryAfterMs = retryAfterMs;
      throw classified;
    }
    throw connectionError(String(provider), error);
  }

  const body = safeJsonParse(rawText);
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

  if (options.failFastOnMinimaxBaseResp === true) {
    const baseRespError = classifyMinimaxBaseResp(String(provider), body, response.status);
    if (baseRespError) {
      baseRespError.retryAfterMs = retryAfterMs;
      throw baseRespError;
    }
  }

  if (!response.ok) {
    const error = classifyHttpError(String(provider), response.status, body, rawText);
    error.retryAfterMs = retryAfterMs;
    throw error;
  }

  return { status: response.status, ok: response.ok, body, rawText, retryAfterMs };
}

/**
 * ⚠️ **流式版本 —— 响应头一回来就拿到，而不是等整个响应生成完。**
 *
 * ## 为什么需要它（2026-10-01，`HTTP 524`）
 *
 * `executeJsonRequest` 用的是 `await response.text()`：那要等**完整响应**。
 * 而链路上的网关（Cloudflare）等 **100 秒**还没看到**响应头**就发 `HTTP 524` ——
 * 实测我们的请求要 **60–205 秒**（100K tokens 的一次 220 秒），
 * 于是**整轮决策作废**（一轮 8 轮里 4 次）。
 *
 * 流式下源站**一连上就返回响应头**（`200 text/event-stream`），
 * 之后才慢慢吐 token —— 网关的计时不再是问题。而本函数仍然读到流结束才返回，
 * 所以**对上层完全透明**。
 *
 * 返回值与 `executeJsonRequest` 同形状：SSE 分片已经被
 * `mergeOpenAiStreamChunks` **重组成非流式的 JSON 形状**，
 * 因此 `client.ts` 的 `parse()` 一行都不用改。
 *
 * （把客户端 `timeout_seconds` 提到 600 秒解决不了这个问题：
 * 那个计时器在客户端，限制在中间的网关那里。）
 */
/**
 * 流式请求的**"卡住"阈值**（毫秒）：多久没有收到任何字节才算断了。
 *
 * ## 为什么不是"总时长"（2026-10-10，用户实测）
 *
 * 用户的原话：「我实测换了其他模型\第三方提供商，模型速度慢、有时候不通……只要重试\等待
 * 基本能正常使用的情况下，系统会判定为失败……在我看来不管是什么模型\提供商，
 * **只要请求上游在吐字返回**，偶发失败都是正常情况，系统应当正常运行下去」。
 *
 * 原来的做法是给整条流式请求套一个总时长超时（`AbortSignal.timeout`），
 * 而那个值是按当年的 `v4.1-flash`（约 300 tok/s）设计的。换成约 30 tok/s 的模型，
 * 一次长回答的总时长涨十倍，于是**它一边正常吐字、一边被判超时**。
 *
 * 所以判据换成"**有没有在动**"：只要还收到数据就重置计时器，真的静默这么久才中止。
 * 外层还有轮次硬超时（60 分钟）兜底，不会真的无限等。
 *
 * 180 秒是留足前置（prefill）的：大提示词在慢提供商上可能几十秒才吐第一个字。
 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000;
export async function executeStreamRequest(
  provider: LlmProviderId | string,
  request: OutboundRequest,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<JsonResponse> {
  /*
   * 流式用"卡住超时"而不是"总时长超时" —— 见 `STREAM_IDLE_TIMEOUT_MS` 的说明。
   */
  const idleMs = Math.max(STREAM_IDLE_TIMEOUT_MS, options.timeoutMs ?? 0);
  const stall = new AbortController();
  let idleTimer: NodeJS.Timeout | null = null;
  const bumpIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stall.abort(new Error('stream idle')), idleMs);
    idleTimer.unref?.();
  };
  bumpIdle();
  const signals = options.signal ? [stall.signal, options.signal] : [stall.signal];
  const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

  let response: Response;
  try {
    response = await fetchGuarded(request.url, {
      method: 'POST',
      headers: { ...request.headers, accept: 'text/event-stream' },
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (error) {
    if (idleTimer) clearTimeout(idleTimer);
    /* 我们自己因为"卡住"而中止的算**可重试的超时**（它是慢，不是坏）。 */
    if (stall.signal.aborted) throw timeoutError(String(provider), idleMs);
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw timeoutError(String(provider), options.timeoutMs ?? 0);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw abortError(String(provider), error);
    }
    throw connectionError(String(provider), error);
  }

  /*
   * 非 2xx 时上游发的是普通 JSON 错误体（不是 SSE），所以照 `executeJsonRequest`
   * 那条路解析与分类 —— 错误分类逻辑必须只有一份。
   */
  if (!response.ok) {
    const rawText = await response.text().catch(() => '');
    const error = classifyHttpError(String(provider), response.status, safeJsonParse(rawText), rawText);
    error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    throw error;
  }

  let lines: string[];
  try {
    /* 每收到一块数据就重置"卡住"计时器 —— 慢模型因此不会被总时长误杀。 */
    lines = await readOpenAiStreamLines(response, bumpIdle);
  } catch (error) {
    /*
     * ⚠️ **2xx 流式在读取过程中失败，要与非流式共用同一套分类。**
     *
     * 原来这里只认"卡住"（`stall.signal.aborted`），其余一律 `throw error` 裸抛 ——
     * 于是"头部已 200、SSE 读到一半连接被重置"抛的是原生 `TypeError`，
     * `isRetryable()` 认不出，一次可重试的抖动被判成永久失败
     * （外部实测确认：流式 200 + body 读失败 → `isRetryable=false`）。
     *
     * 补法与上面 fetch 的 catch **完全同构**：卡住→可重试超时；调用方取消→不重试；
     * 其余（连接重置）→可重试连接错误。三条路径的错误分类只有一份逻辑。
     */
    if (stall.signal.aborted) throw timeoutError(String(provider), idleMs);
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw timeoutError(String(provider), options.timeoutMs ?? 0);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw abortError(String(provider), error);
    }
    throw connectionError(String(provider), error);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
  const merged = mergeOpenAiStreamChunks(lines);
  return {
    status: response.status,
    ok: response.ok,
    body: merged,
    rawText: '',
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  };
}

/** Non-throwing variant for `testConnection`, which reports instead of throwing. */export async function executeJsonRequestSafe(
  provider: LlmProviderId | string,
  request: OutboundRequest,
  options: { signal?: AbortSignal; timeoutMs?: number; failFastOnMinimaxBaseResp?: boolean } = {},
): Promise<{ response: JsonResponse | null; error: Error | null }> {
  try {
    return { response: await executeJsonRequest(provider, request, options), error: null };
  } catch (error) {
    return { response: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
