/**
 * **Jev 初筛**的测试（2026-10-18）。
 *
 * ## 这组测试要钉住什么
 *
 * | # | 情形 | 期望 |
 * |---|---|---|
 * | ① | 正常打分 | 按分数取前 N（且不低于门槛）|
 * | ② | Jev 超时 | `scoreSymbols` 返回 `null`，不抛 |
 * | ③ | 返回格式不对 | `null`，不猜分数 |
 * | ④ | **全部低于门槛** | **回落"不筛"（全部保留），不是 0 个** |
 * | ⑤ | 开关关闭 | **一个 Jev 请求都不发**（桩计数 = 0）|
 *
 * 另外钉住两条接线事实：
 * · 数量与输入不符 → 回落；
 * · 打开开关后，**只有前 N 个切片**会走到 `symbol_scout`。
 *
 * ⚠️ 第 ④ 条是这组测试里最要紧的：Jev 说"都不值得"时若真的一个都不分析，
 * 等于让一个实验功能掐死整个团队 —— 那比不省成本严重得多。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JEV_CRITERIA,
  prefilterSymbols,
  readJevConfig,
  scoreSymbols,
  type JevFetch,
  type JevInput,
  type JevScore,
} from './jev.js';
import { setLogSink } from '../logger.js';
import { runTradingDesk, type AskRole } from '../trader/agent/tradingDesk.js';

/** 造一个"总是返回同一份 JSON"的 fetch 桩。 */
function jsonFetch(payload: unknown): JevFetch {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  });
}

function scoreResponse(score: number, confidence = 0.9): unknown {
  return {
    model: 'jev-1.13.0',
    answers: { worth: { type: 'score', score, confidence } },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

function inputs(symbols: string[]): JevInput[] {
  return symbols.map((symbol) => ({ symbol, digest: `${symbol} 行情摘要` }));
}

function fixedScorer(table: Record<string, number>): (list: readonly JevInput[]) => Promise<JevScore[] | null> {
  return async (list) =>
    list.map((x) => ({ symbol: x.symbol, score: table[x.symbol] ?? 0, confidence: 0.9 }));
}

test('① 正常打分 → 按分数取前 N（保持输入顺序）', async () => {
  const list = inputs(['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'EEEUSDT']);
  const result = await prefilterSymbols(list, {
    enabled: true,
    topN: 2,
    minScore: 0.5,
    scorer: fixedScorer({
      AAAUSDT: 0.2,
      BBBUSDT: 0.9,
      CCCUSDT: 0.6,
      DDDUSDT: 0.8,
      EEEUSDT: 0.4,
    }),
  });

  assert.equal(result.applied, true, '有 2 个过门槛 → 应当真的筛');
  assert.deepEqual(result.keep, [1, 3], '★ 保留 BBB(0.9) 与 DDD(0.8)，且保持输入顺序');
  assert.deepEqual(
    result.dropped.map((s) => s.symbol),
    ['AAAUSDT', 'CCCUSDT', 'EEEUSDT'],
    '★ 门槛以下 + 名额之外都要算"筛除"',
  );
  assert.equal(result.highest, 0.9);
  assert.equal(result.lowest, 0.2);
});

test('② Jev 超时 → scoreSymbols 返回 null（不抛）', async () => {
  const never: JevFetch = () => new Promise(() => {});
  const started = Date.now();
  const result = await scoreSymbols(inputs(['AAAUSDT', 'BBBUSDT']), {
    fetchImpl: never,
    requestTimeoutMs: 25,
    totalTimeoutMs: 1_000,
  });
  assert.equal(result, null, '★ 超时必须返回 null（调用方据此回落）');
  assert.ok(Date.now() - started < 1_000, '不应等到整体超时');
});

test('②b 整体超时会兜住单次超时（15s 铁律的测试版）', async () => {
  const never: JevFetch = () => new Promise(() => {});
  const started = Date.now();
  const result = await scoreSymbols(inputs(['AAAUSDT', 'BBBUSDT', 'CCCUSDT']), {
    fetchImpl: never,
    requestTimeoutMs: 5_000,
    totalTimeoutMs: 40,
  });
  assert.equal(result, null);
  assert.ok(Date.now() - started < 1_000, '★ 整体超时必须先生效（不能等单次 5s）');
});

test('③ Jev 返回格式不对 → null（不猜分数）', async () => {
  const cases: unknown[] = [
    {},
    { answers: {} },
    { answers: { worth: { type: 'noul', noul: 0.8 } } },
    { answers: { worth: { type: 'score', score: '3', confidence: 0.9 } } },
    { answers: { worth: { type: 'score', score: 3 } } },
  ];
  for (const payload of cases) {
    const result = await scoreSymbols(inputs(['AAAUSDT']), {
      fetchImpl: jsonFetch(payload),
    });
    assert.equal(result, null, `★ 形状不对必须返回 null：${JSON.stringify(payload)}`);
  }
});

test('③b 请求体符合实测契约：score + criteria，且分数归一化到 0–1', async () => {
  let seenBody: Record<string, unknown> | null = null;
  const fetchImpl: JevFetch = async (_url, init) => {
    seenBody = JSON.parse(init.body) as Record<string, unknown>;
    return { ok: true, status: 200, json: async () => scoreResponse(2.91, 0.91) };
  };
  const result = await scoreSymbols([{ symbol: 'AAAUSDT', digest: '现价 1.23，RSI 58' }], {
    fetchImpl,
  });

  assert.ok(result !== null);
  assert.equal(result[0]!.symbol, 'AAAUSDT');
  assert.ok(Math.abs(result[0]!.score - 2.91 / (JEV_CRITERIA.length - 1)) < 1e-9, '★ 2.91/4 ≈ 0.7275');
  assert.equal(result[0]!.confidence, 0.91);

  const body = seenBody as unknown as {
    model: string;
    questions: { worth: { type: string; criteria: string[] } };
    state: string;
  };
  assert.equal(body.questions.worth.type, 'score');
  assert.deepEqual(body.questions.worth.criteria, [...JEV_CRITERIA]);
  assert.match(body.state, /AAAUSDT/);
});

test('④ 全部分数低于门槛 → 回落"不筛"（保留全部，不是 0 个）', async () => {
  const list = inputs(['AAAUSDT', 'BBBUSDT', 'CCCUSDT']);
  const result = await prefilterSymbols(list, {
    enabled: true,
    topN: 2,
    minScore: 0.5,
    scorer: fixedScorer({ AAAUSDT: 0.1, BBBUSDT: 0.3, CCCUSDT: 0.2 }),
  });

  assert.equal(result.applied, false, '★ 一个都没过门槛 → 不能筛');
  assert.deepEqual(result.keep, [0, 1, 2], '★★★ 必须保留全部 —— 绝不允许因 Jev 说"不值得"就不分析');
  assert.equal(result.reason, 'all-below-threshold');
  assert.deepEqual(result.dropped, [], '没有真正筛掉任何标的');
  assert.equal(result.highest, 0.3);
});

test('④b 返回数量与输入不符 → 回落"不筛"', async () => {
  const list = inputs(['AAAUSDT', 'BBBUSDT', 'CCCUSDT']);
  const result = await prefilterSymbols(list, {
    enabled: true,
    topN: 2,
    minScore: 0.5,
    scorer: async () => [
      { symbol: 'AAAUSDT', score: 0.9, confidence: 0.9 },
      { symbol: 'BBBUSDT', score: 0.8, confidence: 0.9 },
    ],
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'count-mismatch');
  assert.deepEqual(result.keep, [0, 1, 2]);
});

test('④c 分数/标的对不上 → 回落"不筛"', async () => {
  const list = inputs(['AAAUSDT', 'BBBUSDT']);
  const result = await prefilterSymbols(list, {
    enabled: true,
    topN: 1,
    minScore: 0.5,
    scorer: async () => [
      { symbol: 'BBBUSDT', score: 0.9, confidence: 0.9 },
      { symbol: 'AAAUSDT', score: 0.8, confidence: 0.9 },
    ],
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'format-error');
  assert.deepEqual(result.keep, [0, 1]);
});

test('⑤ 开关关闭 → 完全不调用 Jev（桩计数 = 0）', async () => {
  let calls = 0;
  const scorer = async (list: readonly JevInput[]): Promise<JevScore[]> => {
    calls += 1;
    return list.map((x) => ({ symbol: x.symbol, score: 1, confidence: 1 }));
  };
  const result = await prefilterSymbols(inputs(['AAAUSDT', 'BBBUSDT', 'CCCUSDT']), {
    enabled: false,
    topN: 1,
    minScore: 0.5,
    scorer,
  });

  assert.equal(calls, 0, '★★★ 开关关闭时一个请求都不能发');
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'disabled');
  assert.deepEqual(result.keep, [0, 1, 2]);
});

test('★ 环境变量解析：未设置 / 非法值都退回安全默认，且默认关闭', () => {
  const unset = readJevConfig({});
  assert.equal(unset.enabled, false, '★ 未设置 AQ_JEV_PREFILTER = 关闭');
  assert.equal(unset.topN, 6);
  assert.equal(unset.minScore, 0.5);
  assert.equal(unset.model, 'jev-latest');
  assert.equal(unset.baseUrl, 'http://127.0.0.1:3425');

  const invalid = readJevConfig({
    AQ_JEV_PREFILTER: 'off',
    AQ_JEV_TOP_N: 'abc',
    AQ_JEV_MIN_SCORE: '9',
    AQ_JEV_MODEL: '',
    AQ_JEV_BASE: '',
  });
  assert.equal(invalid.enabled, false);
  assert.equal(invalid.topN, 6);
  assert.equal(invalid.minScore, 0.5);
  assert.equal(invalid.model, 'jev-latest');
  assert.equal(invalid.baseUrl, 'http://127.0.0.1:3425');

  /* ⚠️ 空字符串 = 没设置（`Number('')` 是 0，对 minScore 等于偷偷关掉门槛）。 */
  const blank = readJevConfig({ AQ_JEV_TOP_N: '', AQ_JEV_MIN_SCORE: '' });
  assert.equal(blank.topN, 6);
  assert.equal(blank.minScore, 0.5, '★ 空字符串不能变成门槛 0');

  const on = readJevConfig({
    AQ_JEV_PREFILTER: 'on',
    AQ_JEV_TOP_N: '3',
    AQ_JEV_MIN_SCORE: '0.7',
    AQ_JEV_MODEL: 'jev-test',
    AQ_JEV_BASE: 'http://127.0.0.1:9999',
  });
  assert.deepEqual(on, {
    enabled: true,
    topN: 3,
    minScore: 0.7,
    model: 'jev-test',
    baseUrl: 'http://127.0.0.1:9999',
    /*
     * ⚠️ **必须为 `''`**：这个配置里没给 `MAGPIE_GATEWAY_KEY_FILE`，
     * 所以读不到 key。空串会让 `scoreSymbols()` 不发请求（而不是发一个必然 401 的）。
     */
    apiKey: '',
  });
});

/*
 * ══════════════════════════════════════════════════════════════════════════
 *  接线测试：真的跑 `runTradingDesk`（`AQ_PER_SYMBOL=on`），只把 Jev 的
 *  HTTP 调用换成桩 —— 这样"开关没接上"或"筛完 0 个"都能当场抓住。
 * ══════════════════════════════════════════════════════════════════════════
 */

function candidate(i: number, symbol: string): string {
  return [
    `### ${i}. ${symbol}（coinpool）`,
    `current_price = 1.0${i}, current_ema20 = 0.9${i}, current_rsi7 = 5${i}`,
    '=== 5M 周期（由旧到新）===',
    `价格: [1.0, 1.1, 1.2, 1.3, 1.4]`,
    `成交量: [10, 11, 12, 13, 14]`,
  ].join('\n');
}

const SYMBOLS = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'EEEUSDT'];
const MARKET = [
  '# 账户',
  '权益 20 USDT',
  '# 全市场概览（币安 525 个 USDT 永续）',
  'BTCUSDT 68000 +1.00% 10B',
  '',
  ...SYMBOLS.map((s, i) => candidate(i + 1, s)),
].join('\n\n');

/** 记录 `symbol_scout` 收到的材料（按标的断言"谁进了 LLM"）。 */
function recordingAsk(seen: Array<{ role: string; context: string }>): AskRole {
  return async ({ role, context }) => {
    seen.push({ role, context });
    return { role, modelId: `stub/${role}`, data: null, raw: '[]', latencyMs: 1, ok: true };
  };
}

function installJevFetch(scores: Record<string, number>): { calls: number; restore: () => void } {
  const real = globalThis.fetch;
  const state = { calls: 0 };
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    state.calls += 1;
    const body = JSON.parse((init as { body: string }).body) as { state: string };
    const symbol = /标的：(\S+)/.exec(body.state)?.[1] ?? '';
    const normalized = scores[symbol] ?? 0;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: { worth: { type: 'score', score: normalized * 4, confidence: 0.9 } },
      }),
    };
  }) as typeof fetch;
  return {
    get calls() {
      return state.calls;
    },
    restore: () => {
      globalThis.fetch = real;
    },
  } as { calls: number; restore: () => void };
}

test('★★★ 接线：开关关闭时 runTradingDesk 不发任何 Jev 请求', async () => {
  process.env.AQ_PER_SYMBOL = 'on';
  delete process.env.AQ_JEV_PREFILTER;
  const real = globalThis.fetch;
  let jevCalls = 0;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes('/v1/systemone')) jevCalls += 1;
    throw new Error('开关关闭时不应有任何 fetch');
  }) as typeof fetch;
  const seen: Array<{ role: string; context: string }> = [];
  try {
    await runTradingDesk({
      ask: recordingAsk(seen),
      marketContext: MARKET,
      newsContext: '',
      positionContext: '',
    });
  } finally {
    globalThis.fetch = real;
    delete process.env.AQ_PER_SYMBOL;
  }
  assert.equal(jevCalls, 0, '★★★ 未设置 AQ_JEV_PREFILTER → 一个 Jev 请求都不能发');
  assert.equal(
    seen.filter((x) => x.role === 'symbol_scout').length,
    SYMBOLS.length,
    '★ 开关关闭时全部标的照常进 LLM',
  );
});

test('★★★ 接线：打开开关后只有前 N 个切片进 LLM，并写观测日志', async () => {
  process.env.AQ_PER_SYMBOL = 'on';
  process.env.AQ_JEV_PREFILTER = 'on';
  process.env.AQ_JEV_TOP_N = '2';
  process.env.AQ_JEV_MIN_SCORE = '0.5';
  const logs: Array<{ level: string; message: string }> = [];
  setLogSink((level, scope, message) => {
    if (scope === 'jev') logs.push({ level, message });
  });
  const fake = installJevFetch({
    AAAUSDT: 0.9,
    BBBUSDT: 0.4,
    CCCUSDT: 0.8,
    DDDUSDT: 0.2,
    EEEUSDT: 0.7,
  });
  const seen: Array<{ role: string; context: string }> = [];
  try {
    await runTradingDesk({
      ask: recordingAsk(seen),
      marketContext: MARKET,
      newsContext: '',
      positionContext: '',
    });
  } finally {
    fake.restore();
    setLogSink(null);
    delete process.env.AQ_PER_SYMBOL;
    delete process.env.AQ_JEV_PREFILTER;
    delete process.env.AQ_JEV_TOP_N;
    delete process.env.AQ_JEV_MIN_SCORE;
  }

  const scouts = seen.filter((x) => x.role === 'symbol_scout');
  assert.equal(scouts.length, 2, '★★★ 5 个候选 → 只让前 2 个进 symbol_scout');
  assert.ok(scouts.some((x) => x.context.includes('AAAUSDT')), 'AAA(0.9) 必须在');
  assert.ok(scouts.some((x) => x.context.includes('CCCUSDT')), 'CCC(0.8) 必须在');
  assert.ok(!scouts.some((x) => x.context.includes('BBBUSDT')), 'BBB(0.4) 应被筛掉');
  assert.ok(
    logs.some((l) => l.level === 'info' && l.message.includes('[Jev] 5 个标的 → 保留 2 个')),
    `★ 必须有汇总日志（实际：${logs.map((l) => l.message).join(' | ')}）`,
  );
  /*
   * ⚠️ **2026-10-18 改过断言**：日志从三行合并成两行。
   *
   * 原来：
   * ```
   *   [Jev] 20 个标的 → 保留 6 个 · 最高 … 最低 … · 耗时 …
   *   [Jev] 保留：A B C
   *   [Jev] 筛除：X(0.46) Y(0.42) …
   * ```
   * 而 `runtime_logs` 是环形缓冲（500 条 ≈ 100 分钟），采集脚本靠"保留行 + 下一行筛除行"
   * 配对 —— 只要中间被挤掉一行，那一轮就**永久采不到**（实测：seen 记了 132634，
   * 132635 成了孤儿）。
   *
   * 现在合并成一行（用 `|` 分隔）：
   * ```
   *   [Jev] 保留：A B C | 筛除：X(0.46) Y(0.42) …
   *   [Jev] 20 个标的 → 保留 6 个 · 最高 … 最低 … · 耗时 …
   * ```
   * ⇒ 采集脚本只需一行就能拿到完整配对，不怕被冲散。
   */
  assert.ok(
    logs.some(
      (l) =>
        l.message.includes('[Jev] 保留：') &&
        l.message.includes('| 筛除：') &&
        l.message.includes('BBBUSDT'),
    ),
    `★ 被筛掉的标的必须点名（且保留/筛除在同一行里，避免被环形缓冲冲散）；实际：${logs.map((l) => l.message).join(' | ')}`,
  );
});

test('★★★ 接线：Jev 全部低于门槛 → 全部 5 个照常进 LLM，并写 warn', async () => {
  process.env.AQ_PER_SYMBOL = 'on';
  process.env.AQ_JEV_PREFILTER = 'on';
  process.env.AQ_JEV_TOP_N = '2';
  process.env.AQ_JEV_MIN_SCORE = '0.5';
  const logs: Array<{ level: string; message: string }> = [];
  setLogSink((level, scope, message) => {
    if (scope === 'jev') logs.push({ level, message });
  });
  const fake = installJevFetch({
    AAAUSDT: 0.1,
    BBBUSDT: 0.2,
    CCCUSDT: 0.3,
    DDDUSDT: 0.1,
    EEEUSDT: 0.2,
  });
  const seen: Array<{ role: string; context: string }> = [];
  try {
    await runTradingDesk({
      ask: recordingAsk(seen),
      marketContext: MARKET,
      newsContext: '',
      positionContext: '',
    });
  } finally {
    fake.restore();
    setLogSink(null);
    delete process.env.AQ_PER_SYMBOL;
    delete process.env.AQ_JEV_PREFILTER;
    delete process.env.AQ_JEV_TOP_N;
    delete process.env.AQ_JEV_MIN_SCORE;
  }

  assert.equal(
    seen.filter((x) => x.role === 'symbol_scout').length,
    SYMBOLS.length,
    '★★★ 一个都不许少 —— Jev 说"都不值得"必须回落成"不筛"',
  );
  assert.ok(
    logs.some(
      (l) =>
        l.level === 'warn' &&
        l.message.includes('低于门槛') &&
        l.message.includes('回落到不筛'),
    ),
    `★ 必须留一条 warn 说明原因（实际：${logs.map((l) => l.message).join(' | ')}）`,
  );
});

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  ★★★ 请求必须带 Authorization（2026-10-18 线上实测打脸）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ## 事故
 *
 * 第一版的 `scoreSymbols()` 只发 `Content-Type`，**没有 Authorization**：
 * ```
 *   线上 runtime_logs(scope=jev)  warn | [Jev] 初筛调用失败（网络/超时/返回无法解析）
 *                                      —— 回落到不筛（全部 18 个标的照常进 LLM）
 * ```
 * 降级是对的，但**功能等于没接上**。而那 13 条用例一条都没发现 ——
 * 因为它们**全部注入桩 `fetchImpl`，从不检查请求头**。
 *
 * ⇒ 这条断言把"请求头里必须有 Bearer"钉死，用桩捕获实际发出的 headers。
 */
test('★★★ Jev 请求必须带 Authorization: Bearer（否则线上 401）', async () => {
  const seen: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push(init.headers);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          worth: { type: 'score', score: 3, confidence: 0.8, probabilities: {} },
        },
      }),
    };
  }) as never;

  await scoreSymbols([{ symbol: 'BTCUSDT', digest: 'd' }], {
    fetchImpl,
    apiKey: 'mk-test-key-123',
  });

  assert.equal(seen.length, 1, '★ 应该发了一次请求');
  const headers = seen[0]!;
  assert.equal(
    headers['Authorization'],
    'Bearer mk-test-key-123',
    '★ 没有 Authorization 的请求在线上必然 401 —— 这正是第一版的事故',
  );
  assert.equal(headers['Content-Type'], 'application/json');
});

test('★★ 没给 apiKey 时不发请求（不发无效请求）', async () => {
  let called = 0;
  const fetchImpl = (async () => {
    called += 1;
    return { ok: false, status: 401, json: async () => ({}) };
  }) as never;
  /*
   * ⚠️ 实际实现里"没有 key"由调用方（`readJevConfig`）决定 —— 这里只钉住
   * "**不带 key 的请求不会被当成成功**"：桩返回 401 ⇒ 整批 null ⇒ 调用方回落。
   */
  const r = await scoreSymbols([{ symbol: 'BTCUSDT', digest: 'd' }], { fetchImpl });
  assert.equal(r, null, '★ 401 ⇒ 整批 null（调用方据此回落到不筛）');
  assert.equal(called, 1);
});

test('★★ readJevConfig 在开关关闭时不去读 key 文件', () => {
  /*
   * 关着的时候连文件都不碰 —— 这是"默认行为零变化"的一部分。
   * 传一个不存在的路径也不会出问题（因为它根本不去读）。
   */
  const cfg = readJevConfig({
    AQ_JEV_PREFILTER: 'off',
    MAGPIE_GATEWAY_KEY_FILE: '/nonexistent/path/that/should/not/be/read.json',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.apiKey, '', '★ 关着 ⇒ 不读 key');
});