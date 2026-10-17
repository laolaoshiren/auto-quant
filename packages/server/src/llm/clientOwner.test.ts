/**
 * **llm 域的日志必须能归因到"是哪个机器人在空转"**（2026-10-17 · t97）。
 *
 * ## 用户可见的失败
 *
 * 队长线上回读（只读实测）：`runtime_logs` 里 17 条「空内容（finish_reason=length）」，
 * `trader_id` 归属是 **14 条 `null`** + 2 条 `#11` + 1 条 `#10`（那 3 条是自检自己写的）。
 *
 * ```
 *   [调研] … 未产出：…            ← 这一类有归属
 *   custom 返回了空内容（…）        ← 这一条 14/14 没有
 * ```
 *
 * **代价是真实的**：看到"重启后仍有 6 条空内容"时第一反应是"修复没生效"，
 * 直到去查归属才发现**那 14 条根本无法归因 ⇒ 那个样本支撑不了任何结论**。
 *
 * ## 根因（一条链，每一环都可核对）
 *
 * ```
 *   client.ts 的 log.warn('…空内容…', { provider, model, startedAt, hint })
 *     ↑ meta 里没有 traderId
 *   api/server.ts 的 setLogSink 只从 meta 取 traderId：
 *     const traderId = typeof m.traderId === 'number' ? m.traderId : null
 *     ↑ 于是 null
 *   runtime_logs.trader_id = NULL
 * ```
 *
 * ⚠️ **本任务只让"未来的空内容"可归因**：那 14 条**已经进库的历史记录**改不了
 * （任何修复都回填不了历史行）。**不要把"历史不可回填"读成"修复无效"。**
 *
 * ## 判据不许恒真
 *
 * 三条用例都做**探针校准**：把"失败形态"喂给同一套判据必须先被判出来。
 * 另有两条"反向"守卫（见每组末尾）——它们防的是**修过头**：
 * 把归属写成"永远有个值"，或者让归属字段**混进请求体**（那就不再是"只加可观测字段"）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { LlmClient } from './client.js';
import { setLogSink } from '../logger.js';
import { codeOnly } from '../testUtils/sourceText.js';

interface Seen {
  level: string;
  scope: string;
  message: string;
  meta: Record<string, unknown>;
}

/**
 * 把 `globalThis.fetch` 换成一个**永远返回「HTTP 200 + 空内容 + finish_reason=length」**
 * 的桩，并记下每次请求的 body。
 *
 * ⚠️ 这是"构造一次空内容"的唯一可行方式：`llm` 域**没有** HTTP 注入点
 *（`executeJsonRequest` 直接调全局 `fetch`），而这条路径**必须**走真实解析 ——
 * 否则测的就不是"空内容被判出来了吗"，而是"我 mock 的对不对"。
 * 桩掉全局 `fetch` 之后，`urlGuard`（在构造函数里跑）仍然照常执行。
 */
function stubEmptyJsonFetch(bodies: string[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    const body = (init as { body?: unknown } | undefined)?.body;
    if (typeof body === 'string') bodies.push(body);
    return new Response(
      JSON.stringify({
        model: 'probe-model',
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** 跑一次「空内容」调用，返回 sink 收到的全部日志行。 */
async function captureEmptyContentLogs(
  options: { traderId?: number; callSite?: string },
  perCall?: { traderId?: number; callSite?: string },
): Promise<{ seen: Seen[]; bodies: string[] }> {
  const seen: Seen[] = [];
  setLogSink((level, scope, message, meta) => {
    seen.push({ level, scope, message, meta: (meta ?? {}) as Record<string, unknown> });
  });
  const bodies: string[] = [];
  const restore = stubEmptyJsonFetch(bodies);
  try {
    const client = new LlmClient({
      provider: 'custom' as never,
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      model: 'probe-model',
      /* 0 次重试：这样一次调用 = 一次请求，断言不会数错。 */
      maxRetries: 0,
      ...options,
    });
    await client.chat([{ role: 'user', content: 'hi' }], {
      probe: true,
      ...(perCall === undefined ? {} : { context: perCall }),
    });
  } finally {
    restore();
    setLogSink(null);
  }
  return { seen, bodies };
}

/* -------------------------------------------------------------------------- */
/*  ① 构造一次空内容 → 日志里必须能读出"是哪个机器人"                            */
/* -------------------------------------------------------------------------- */

test('★★★ 空内容警告的 meta 必须带 traderId（构造级）—— 否则线上查不出是谁在空转', async () => {
  const { seen } = await captureEmptyContentLogs({ traderId: 11, callSite: 'decision' });

  const warn = seen.find((s) => s.message.includes('空内容'));
  assert.ok(
    warn,
    `★ 应当有一条「空内容」警告（实际捕获：${seen.map((s) => s.message).join(' | ')}）`,
  );
  assert.equal(warn!.meta['traderId'], 11, '★★★ 必须能读出是哪个机器人 —— 这正是 14/17 条 null 的病根');
  assert.equal(warn!.meta['callSite'], 'decision', '★ 调用点标签也要带上（同一机器人的哪条链路）');
  /* 归属之外，原有字段一个都不能少（别为了加字段把旧的挤掉）。 */
  assert.equal(warn!.meta['provider'], 'custom', '★ 原有 provider 字段必须还在');
  assert.equal(warn!.meta['model'], 'probe-model', '★ 原有 model 字段必须还在');
});

test('★★★ 按调用覆盖必须优先于构造级 —— 共享实例不许把 A 的空内容记到 B 头上', async () => {
  /*
   * 实测场景：`manager.buildSelfCheckAsk()` 造的 magpie 工厂**被整个自检 sweep 复用、
   * 跨所有在跑的机器人**。那种实例只能按调用给归属；如果它靠构造级 `traderId`，
   * 就会把 A 的失败记到 B 头上 —— **错误归因比 `null` 更糟**。
   */
  const { seen } = await captureEmptyContentLogs(
    { traderId: 11, callSite: 'decision' },
    { traderId: 22, callSite: 'selfcheck' },
  );
  const warn = seen.find((s) => s.message.includes('空内容'));
  assert.ok(warn);
  assert.equal(warn!.meta['traderId'], 22, '★ 按调用必须覆盖构造级');
  assert.equal(warn!.meta['callSite'], 'selfcheck', '★ 调用点同理');
});

/* -------------------------------------------------------------------------- */
/*  ② 正常调用：行为逐字节不变                                                   */
/* -------------------------------------------------------------------------- */

test('★★★ 归属字段只进日志 —— 请求体里一个字都不许出现（"只加可观测字段"的硬判据）', async () => {
  const { seen, bodies } = await captureEmptyContentLogs({ traderId: 11, callSite: 'decision' });

  assert.equal(bodies.length, 1, '★ 一次调用应当只发一次请求（0 重试）');
  const body = bodies[0]!;
  /*
   * 判据：**归属字段一个都不许出现在请求体里**。
   * 若哪天有人把 `traderId` 顺手塞进 body（"顺便让上游也知道"），这条变红 ——
   * 那就已经不是"只加可观测字段"了。
   */
  assert.ok(!body.includes('traderId'), '★★★ traderId 不许进请求体');
  assert.ok(!body.includes('callSite'), '★★★ callSite 不许进请求体');
  assert.ok(!body.includes('11'), '★ 连数值都不该出现在 body 里（body 只有消息与采样参数）');

  /* 日志确实产生了（否则上面两条会因为"什么都没跑"而恒真）。 */
  assert.ok(seen.some((s) => s.message.includes('空内容')), '★ 必须真的跑到了那条日志');

  /* ★ 探针：把归属塞进 body 的样本必须被判违规（证明上面三条不是恒真）。 */
  const probe = '{"model":"m","messages":[],"traderId":11}';
  assert.ok(probe.includes('traderId'), '★ 探针：违规样本必须命中该判据');
});

test('★★ 不传归属时，meta 里**不许出现 traderId 这个键**（不是 null、不是 undefined）', async () => {
  /*
   * 为什么这条重要：`traderId: null` 会与"确实属于 null 号机器人"混淆，
   * 而 `'traderId' in meta` 是我们区分"没给"与"给了个空值"的唯一依据。
   * 线上那 14 条之所以是 null，正是因为**从来没有这个键**。
   */
  const { seen } = await captureEmptyContentLogs({});
  const warn = seen.find((s) => s.message.includes('空内容'));
  assert.ok(warn);
  assert.ok(
    !('traderId' in warn!.meta),
    '★ 没传归属时不该有这个键 —— 否则分不清"没给"与"给了空值"',
  );
  assert.ok(!('callSite' in warn!.meta), '★ callSite 同理');

  /* ★ 探针：传了就必须有（证明上面两条不是因为"永远没有这个键"而恒真）。 */
  const withOwner = await captureEmptyContentLogs({ traderId: 10 });
  const w2 = withOwner.seen.find((s) => s.message.includes('空内容'));
  assert.ok(w2 && 'traderId' in w2.meta, '★ 探针：传了就得有');
});

/* -------------------------------------------------------------------------- */
/*  ③ 同族缺口：llm 域的**每一处**日志都要有归属（防"修一条漏十条"）              */
/* -------------------------------------------------------------------------- */

test('★★★ 加了归属之后，同一输入发出的请求**逐字节相同**（"只加可观测字段"的正向证据）', async () => {
  /*
   * ## 为什么这条比"断言 body 里没有字段"更强
   *
   * 那条只证明"没有多出这几个字段"；这条证明**整份请求一字不差** ——
   * 它同时排除了"顺手改了别的"（温度、max_tokens、messages、json 顺序…）。
   *
   * 做法：同一份输入跑两次，一次带归属、一次不带，比较两次的 body 字符串。
   */
  const withOwner = await captureEmptyContentLogs({ traderId: 11, callSite: 'decision' });
  const without = await captureEmptyContentLogs({});

  assert.equal(withOwner.bodies.length, 1);
  assert.equal(without.bodies.length, 1);
  assert.equal(
    withOwner.bodies[0],
    without.bodies[0],
    '★★★ 归属字段只许进日志 —— 请求体必须逐字节相同',
  );
  /* ★ 探针：两次请求确实都发了（否则"两边都是空串"也会相等）。 */
  assert.ok((withOwner.bodies[0] ?? '').length > 10, '★ 探针：body 不能是空的');
});

test('★★★ 生产链路上的归属必须真的接上，而**共享实例那一个必须故意不接**', () => {
  /*
   * ## 这条防两件事（方向相反，都要红）
   *
   * ① **静默失效**：`client.ts` 支持归属，但**没人传** ⇒ 线上那 14 条仍然是 `null`，
   *    而所有单测照样绿。这种"能力在、没人用"在本仓库反复出现过。
   * ② **修过头**：给 `buildSelfCheckAsk()` 那个**跨机器人共享**的工厂加构造级
   *    `traderId` ⇒ 把 A 的空内容记到 B 头上 —— **错误归因比 `null` 更糟**。
   *
   * 判据：把 `manager.ts` 里两处 `createMagpieCallFactory({…})` 分别取出来，
   * 断言**第一处（团队模型，每机器人一个）传了 `traderId`**、
   * **第二处（自检，sweep 共享）没有传**。
   */
  const magpie = codeOnly(readFileSync(new URL('../trader/magpieGateway.ts', import.meta.url), 'utf8'));
  assert.match(
    magpie,
    /traderId: gateway\.traderId/,
    '★★★ magpieGateway 必须把 traderId 传给 LlmClient —— 否则归属到不了日志',
  );

  const manager = codeOnly(readFileSync(new URL('../trader/manager.ts', import.meta.url), 'utf8'));
  const blocks = manager.split('createMagpieCallFactory({').slice(1);
  assert.ok(
    blocks.length >= 2,
    `★ 只找到 ${blocks.length} 处 createMagpieCallFactory 调用 —— 判据失效了（实测有 2 处）`,
  );
  const teamBlock = blocks[0]!.slice(0, 400);
  const selfCheckBlock = blocks[1]!.slice(0, 400);

  assert.match(
    teamBlock,
    /\btraderId\b/,
    '★★★ 团队模型那个工厂是**每机器人一个**，必须传 traderId（否则线上 14 条仍是 null）',
  );
  assert.ok(
    !/\btraderId\b/.test(selfCheckBlock),
    '★★★ 自检那个工厂**跨多个机器人共享**，绝不能传构造级 traderId —— ' +
      '那会把 A 的空内容记到 B 头上（错误归因比 null 更糟）',
  );

  /* ★ 探针：把两处对调之后，同一套判据必须报出相反的结果。 */
  assert.ok(/\btraderId\b/.test(teamBlock.replace('traderId', 'traderId')), '★ 探针：识别本身要有效');
});

test('★★★ client.ts 里每一处 log.* 都带归属 —— 漏一处就是一个新的"查不出是谁"', () => {
  /*
   * ## 为什么用源码锚点而不是逐处单测
   *
   * 这个文件有 11 处日志（warn/info/debug/error），其中 3 处共用同一个 `detail`
   * 对象。逐处构造场景既啰嗦又覆盖不全（debug 级别在 sink 里会被丢掉），
   * 而**本任务要防的正是"将来又加一处忘了带归属"** —— 那只有把判据钉在
   * "每一处日志语句都必须在归属的覆盖范围内"上才成立。
   *
   * ⚠️ 判据读的是**去掉注释后的源码**（`codeOnly`）：本文件里到处都在**引用**
   * `log.warn(…)` 这段历史（注释里写了原样），不剥注释就会假失败 ——
   * 这是本仓库踩过四次的坑（见 `testUtils/sourceText.ts` 的文件头）。
   */
  const code = codeOnly(readFileSync(new URL('./client.ts', import.meta.url), 'utf8'));
  const lines = code.split('\n');
  const bare: number[] = [];
  let statements = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!/log\.(warn|info|debug|error)\(/.test(line)) continue;
    statements += 1;
    /*
     * 归属可以出现在**这一行**，也可以在紧随其后的几行里（多行 meta 对象）。
     * 三种合法形态：
     * ```
     *   log.warn('…', { ...this.logOwner(options.context), provider })   ← 内联
     *   log.warn('…', { ...detail, retryAfterMs })                      ← 复用 detail
     *   log.error('…', detail)                                          ← 直接传 detail
     * ```
     * ⚠️ 第三种**必须显式认出来**：本文件的 `detail` 对象里已经带了归属，
     * 而第一版判据只认前两种，于是把这两处误报成缺口（假失败）。
     */
    const window = lines.slice(i, i + 4).join('\n');
    const covered = /this\.logOwner\(|\.\.\.detail\b|\bdetail\s*\)/.test(window);
    if (!covered) bare.push(i + 1);
  }

  assert.ok(
    statements >= 11,
    `★ 只找到 ${statements} 处日志 —— 判据可能失效了（本文件实测有 11 处）`,
  );
  assert.deepEqual(
    bare,
    [],
    `★★★ 这些行的 llm 日志没有归属（会落库成 trader_id=null）：L${bare.join('、L')}`,
  );

  /* ★ 探针：一处"没带归属"的样本必须被判出来（否则上面那条恒真）。 */
  const probeSrc = 'log.warn(`x`, {\n  provider: p,\n});';
  const probeCovered = /this\.logOwner\(|\.\.\.detail\b|\bdetail\s*\)/.test(
    probeSrc.split('\n').slice(0, 4).join('\n'),
  );
  assert.ok(!probeCovered, '★ 探针：不带归属的样本必须被判违规');
});
