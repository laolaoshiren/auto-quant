import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, getDb, initDb } from '../db/index.js';
import {
  aiModels,
  clampDecisionLimit,
  DECISION_PAGE_DEFAULT,
  DECISION_PAGE_MAX,
  decisions as decisionStore,
  exchanges,
  strategies,
  traders,
} from './repositories.js';

/**
 * 决策记录的**分页契约**。
 *
 * 这个文件防的是操作者报告的那个事故：决策流一次把整个决策史拉出来
 * （`?limit=999999` 以前会被原样交给 SQL），每条记录又带着完整提示词与原始响应，
 * 页面上千条决策一起渲染、响应也有几十 MB，于是机器一起卡死。
 *
 * 三件事必须被钉住：
 *
 *  1. `limit` 有硬上限，且**钳制而不报错** —— 999999 拿到的是上限条数，不是全部；
 *  2. 游标翻页取到的是"接下来的那些"，不重不漏，最新在前；
 *  3. **两次翻页之间插入一条新记录**，页边界依然不重不漏 —— 这正是选游标
 *     （`before=id`）而不是 `OFFSET` 的唯一理由，所以它必须有一个用例。
 *     用偏移量的话，新记录插在顶部会让第二页的第一条退回到上一页的最后一条上，
 *     用例里断言的就是那个重复。
 *
 * 按 AGENTS.md §3.6：临时目录，绝不碰 `data/`。
 */

let workDir: string;
let traderId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-decisions-'));
  initDb(path.join(workDir, 'decisions.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().run('DELETE FROM decision_records');
});

/** 一个新的机器人（每个用例一个，与 `retention.test.ts` 同一种写法）。 */
function seedTrader(name = 'decisions'): number {
  const account = exchanges.create({
    exchange: 'binance',
    label: name,
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: name,
    model: 'm',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const strategy = strategies.create({
    name,
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  return traders.create({
    name,
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;
}

/** 写入一轮决策。内容与本文件无关，只要求"一轮一行、周期号递增"。 */
function logCycle(forTrader: number, cycleNumber: number): number {
  return decisionStore.log({
    traderId: forTrader,
    cycleNumber,
    systemPrompt: 'system',
    userPrompt: 'user',
    cotTrace: 'cot',
    decisions: [],
    rawResponse: 'raw',
    executionLog: [],
    candidateSymbols: [],
    success: true,
    error: null,
    aiLatencyMs: 12,
    promptTokens: 1,
    completionTokens: 1,
  });
}

/** 连续写入 `count` 轮，返回写入的 id（**升序 = 时间顺序**，最后一个是新的）。 */
function seedCycles(count: number, forTrader = traderId): number[] {
  const ids: number[] = [];
  for (let cycle = 1; cycle <= count; cycle += 1) ids.push(logCycle(forTrader, cycle));
  return ids;
}

const idsOf = (records: Array<{ id: number }>): number[] => records.map((record) => record.id);

/* -------------------------------------------------------------------------- */
/*  上限                                                                       */
/* -------------------------------------------------------------------------- */

test('limit 有硬上限：?limit=999999 拿到的是上限条数，而不是全部', () => {
  /*
   * 断言分两层：
   *  · 行为层 —— 要得再多也不会超过 `DECISION_PAGE_MAX`，而且不报错（钳制而不是 400）；
   *  · 政策层 —— 上限本身不能大到等于"没有上限"。只写第一层的话，
   *    有人把上限调到 100000 这个用例照样是绿的，而事故原封不动地回来了。
   */
  traderId = seedTrader();
  // 两页还多：这样"带游标的那一页"下面也还剩够多的行，钳制在那条路径上同样能被观察到。
  seedCycles(DECISION_PAGE_MAX * 2 + 5);

  const page = decisionStore.list(traderId, 999_999);
  assert.equal(page.length, DECISION_PAGE_MAX, '超出上限的 limit 必须被钳到上限');
  assert.ok(
    DECISION_PAGE_MAX <= 200,
    `页大小上限被调到了 ${DECISION_PAGE_MAX} —— 一次请求又能把整个决策史拼进响应里了`,
  );

  // 上限对**带游标的页**同样生效：否则深翻几页之后又能一次拉一大片。
  const cursor = page[page.length - 1]!.id;
  const deeper = decisionStore.list(traderId, 999_999, cursor);
  assert.equal(deeper.length, DECISION_PAGE_MAX, '带游标的页也必须被钳制');
  assert.ok(!idsOf(deeper).includes(cursor), '钳制不能把游标那一页变成"从游标重新开始"');
});

test('limit 的默认值没变，非有限值、小数与 0 都被收进合法区间', () => {
  traderId = seedTrader();
  seedCycles(DECISION_PAGE_DEFAULT + 10);

  // 默认 50 是 `docs/API.md` 里写着的契约，也是老客户端依赖的行为。
  assert.equal(decisionStore.list(traderId).length, DECISION_PAGE_DEFAULT);

  // 路由以前对非有限值是回落到 50（`Number.isFinite(limit) ? limit : 50`），保持一致。
  assert.equal(clampDecisionLimit(Number.NaN), DECISION_PAGE_DEFAULT);
  assert.equal(clampDecisionLimit(Number.POSITIVE_INFINITY), DECISION_PAGE_DEFAULT);
  // 小数（`?limit=20.7`）不该把 SQLite 的 LIMIT 变成一个没人预期过的数。
  assert.equal(clampDecisionLimit(20.7), 20);
  // 0 或负数收进 1 行：`LIMIT 0` 的空数组和"这个机器人没有决策"长得一模一样，
  // 会把一次参数错误伪装成一次空结果。
  assert.equal(clampDecisionLimit(0), 1);
  assert.equal(clampDecisionLimit(-5), 1);
});

/* -------------------------------------------------------------------------- */
/*  游标翻页                                                                   */
/* -------------------------------------------------------------------------- */

test('before=id 取到的正好是下一页：不重、不漏、最新在前', () => {
  traderId = seedTrader();
  const ids = seedCycles(45);
  const newestFirst = [...ids].reverse(); // ids[44] 最新 → ids[0] 最旧

  const page1 = decisionStore.list(traderId, 20);
  assert.deepEqual(idsOf(page1), newestFirst.slice(0, 20), '第一页必须是最新的 20 条，且倒序');

  const page2 = decisionStore.list(traderId, 20, page1[page1.length - 1]!.id);
  assert.deepEqual(idsOf(page2), newestFirst.slice(20, 40), '第二页必须紧接第一页往下取');

  const page3 = decisionStore.list(traderId, 20, page2[page2.length - 1]!.id);
  assert.deepEqual(idsOf(page3), newestFirst.slice(40), '最后一页只有剩下的 5 条');

  // 再往下要：空数组，而不是又从头来一遍 ——
  // 客户端就是靠"这一页不满"判断「已到最早一轮」的。
  const page4 = decisionStore.list(traderId, 20, page3[page3.length - 1]!.id);
  assert.deepEqual(page4, []);

  const all = [...page1, ...page2, ...page3].map((record) => record.id);
  assert.equal(new Set(all).size, 45, '三页合起来必须正好覆盖 45 条，没有重复');
});

test('翻页之间插入一条新记录，页边界依然不重不漏（这就是不用 offset 的理由）', () => {
  /*
   * 真实场景：机器人一直在跑，操作者翻到了第二页，而下一轮决策已经落库。
   *
   * 用 `OFFSET 3` 的话，插入之后 `ORDER BY id DESC LIMIT 3 OFFSET 3` 会从
   * `[new, 10, 9, 8, 7, …]` 里取到 `[8, 7, 6]` —— 8 是上一页的最后一条，
   * 于是决策流里同一轮出现两次（看起来像那轮跑了两次）。
   * 游标 `id < 8` 取到的是 `[7, 6, 5]`，与上一页严丝合缝。
   */
  traderId = seedTrader();
  const ids = seedCycles(10);
  const newestFirst = [...ids].reverse();

  const page1 = decisionStore.list(traderId, 3);
  assert.deepEqual(idsOf(page1), newestFirst.slice(0, 3));
  const cursor = page1[page1.length - 1]!.id;

  // 第二次请求**之前**，新一轮落库（id 更大，落在游标之上）。
  const newId = logCycle(traderId, 11);
  assert.ok(newId > cursor, '新记录的 id 必须比游标大，否则游标语义不成立');

  const page2 = decisionStore.list(traderId, 3, cursor);
  const page2Ids = idsOf(page2);

  assert.equal(page2Ids.length, 3);
  assert.ok(!page2Ids.includes(cursor), '第二页重复了第一页的最后一条 —— 游标退化成 offset 了');
  assert.ok(!page2Ids.includes(newId), '第二页不该包含插到顶部的新记录');
  assert.deepEqual(page2Ids, newestFirst.slice(3, 6), '第二页必须是游标紧邻的那三条');

  // 而"最新一页"仍然是新的：轮询会重新拉第一页，它必须已经包含刚插入的那条。
  assert.equal(decisionStore.list(traderId, 3)[0]!.id, newId);

  // 换个方向再钉一次：从第二页继续往下翻，三页合起来正好覆盖 9 条、无一重复。
  const page3 = decisionStore.list(traderId, 3, page2[page2.length - 1]!.id);
  const seen = new Set([...idsOf(page1), ...page2Ids, ...idsOf(page3)]);
  assert.equal(seen.size, 9);
});

test('游标只作用于本机器人', () => {
  // 多个机器人共用一个库：游标撞上别的机器人的记录时不能把它的行捞出来。
  traderId = seedTrader('mine');
  const other = seedTrader('other');

  // 交替写入，让两个机器人的 id 交错在一起 —— 这样"漏了 trader_id 条件"必然被抓到。
  const mine: number[] = [];
  const theirs: number[] = [];
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    mine.push(logCycle(traderId, cycle));
    theirs.push(logCycle(other, cycle));
  }

  const page = decisionStore.list(traderId, 10);
  assert.deepEqual(idsOf(page), [...mine].reverse());
  assert.ok(page.every((record) => record.traderId === traderId));
  assert.ok(
    theirs.every((id) => !idsOf(page).includes(id)),
    '别的机器人的决策混进来了',
  );

  // 带上游标同样只在本机器人的行里往下走。
  const next = decisionStore.list(traderId, 10, mine[1]);
  assert.deepEqual(idsOf(next), [mine[0]]);
});

/* -------------------------------------------------------------------------- */
/*  begin / finish：提前落库 + 收尾（2026-10-17，SIGTERM 吃轮的修复）              */
/* -------------------------------------------------------------------------- */

test('★★★ begin() 幂等：同一 (trader, cycle) 只插一行，且复用时必须重置成全新 pending', () => {
  /*
   * ## 为什么要"重置"而不是"原样返回"
   *
   * 复用的真实场景正是这次要修的事故：上一轮被 SIGTERM 切断 ⇒
   * `traders.last_cycle_number` 没被推进（`recordCycle()` 只在跑完之后调）⇒
   * 重启后 `cycleNumber` 又走上同一个号 ⇒ 撞上那一行残留的 pending。
   *
   * 只返回 id 而不重置的话，最终记录会是**新一轮的内容 + 上一轮的 timestamp**
   * （以及上一轮零散写进去的字段）—— 一张自相矛盾的行：时间旧、内容新。
   *
   * 契约：`begin()` 之后那一行的形状必须是**干净的 pending**
   * （当前时间、空提示词/决策/执行、success=1、ai_latency_ms=0）。
   */
  traderId = seedTrader();

  const first = decisionStore.begin({ traderId, cycleNumber: 7 });
  assert.equal(first.created, true, '第一次必须是新建');
  assert.equal(decisionStore.count(traderId), 1);

  /* 让那一行看起来像"上一轮写到一半"：塞进内容与一个旧时间戳。 */
  getDb().run(
    `UPDATE decision_records
        SET system_prompt = 'old-system', user_prompt = 'old-user', decisions_json = '[{"x":1}]',
            execution_log_json = '[{"action":"open_long","symbol":"BTCUSDT","status":"ok","detail":"old"}]',
            ai_latency_ms = 1304200, error = 'old error', success = 0,
            timestamp = '2026-10-17T03:00:00.000Z'
      WHERE id = ?`,
    first.id,
  );

  /* 重启后复用同一个周期号。 */
  const again = decisionStore.begin({ traderId, cycleNumber: 7 });
  assert.equal(again.created, false, '★★ 同一 (trader, cycle) 不得插第二行');
  assert.equal(again.id, first.id, '★★ 必须复用同一行');
  assert.equal(decisionStore.count(traderId), 1, '★★★ 账上仍然只有一行');

  const row = decisionStore.get(first.id)!;
  assert.equal(row.systemPrompt, '', '★★ 复用时必须清掉上一轮残留的提示词');
  assert.deepEqual(row.decisions, [], '★★ 决策必须清空 —— 否则新一轮会带着上一轮的决策');
  assert.deepEqual(row.executionLog, [], '★★ 执行日志必须清空');
  assert.equal(row.error, null, '★★ 上一轮的错误不能留在新一轮的 pending 上');
  assert.equal(row.success, true, '★★ pending 的语义是"目前没有失败"');
  assert.equal(row.aiLatencyMs, 0, '★★ pending 的判据之一');
  assert.notEqual(
    row.timestamp,
    '2026-10-17T03:00:00.000Z',
    '★★★ 时间戳必须被刷新成"这一次的开始" —— 否则最终记录会是"时间旧、内容新"的自相矛盾行',
  );

  /* 而且 `latestWithPending` 必须把它认成 pending。 */
  assert.equal(decisionStore.latestWithPending(traderId)?.pending, true);
});

test('★★★ finish() 补完终态；行不存在时必须返回 updated=false（调用方才能留痕）', () => {
  /*
   * 两个方向都要：
   *  ① 正常 → 真的写进去了（否则终态永远停在 pending 形状）；
   *  ② 那一行不在了 → **必须如实说 `updated: false`**。
   *     静默成功会让"审计记录丢了"无从发现 —— 那正是本任务要消灭的观测空洞。
   */
  traderId = seedTrader();
  const { id } = decisionStore.begin({ traderId, cycleNumber: 3 });

  const ok = decisionStore.finish({
    id,
    systemPrompt: 'sys',
    userPrompt: 'usr',
    cotTrace: 'cot',
    decisions: [{ action: 'wait' }],
    rawResponse: 'raw',
    executionLog: [],
    candidateSymbols: ['BTCUSDT'],
    success: false,
    error: '这一轮失败了',
    aiLatencyMs: 1234,
    promptTokens: 10,
    completionTokens: 5,
  });
  assert.equal(ok.updated, true, '★ 正常收尾必须报告"已更新"');

  const row = decisionStore.get(id)!;
  assert.equal(row.systemPrompt, 'sys');
  assert.equal(row.error, '这一轮失败了');
  assert.equal(row.success, false, '★ 失败的一轮 success 必须是 false');
  assert.equal(row.aiLatencyMs, 1234, '★ 耗时必须被写上（它是 pending 判据的另一半）');
  assert.deepEqual(row.candidateSymbols, ['BTCUSDT']);
  assert.equal(decisionStore.latestWithPending(traderId)?.pending, false, '★ 补完之后不再是 pending');

  /* 不存在的 id：必须如实返回 false。 */
  const missing = decisionStore.finish({
    id: 999_999,
    systemPrompt: '', userPrompt: '', cotTrace: '', decisions: [], rawResponse: '',
    executionLog: [], candidateSymbols: [], success: true, error: null,
    aiLatencyMs: 1, promptTokens: null, completionTokens: null,
  });
  assert.equal(
    missing.updated,
    false,
    '★★★ 行不存在时必须返回 updated=false —— 否则"这一轮的决策与执行没落库"会被静默吞掉',
  );
});
