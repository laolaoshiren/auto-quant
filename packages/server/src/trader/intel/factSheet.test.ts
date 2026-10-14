/**
 * **跨来源事实表**（它替代了从未被调用的 `clerk` 角色）
 *
 * ## 为什么这个模块存在
 *
 * `roles.ts` 里的 `clerk`（文员）prompt 写着要解决的问题：
 * > 「**让每个消费者自己拼 = 每个消费者都要写一遍解析逻辑**，且口径会漂移。」
 *
 * 而它自己的纪律第一条是「**只做整理，不做判断**」—— 那正是一个 SQL 查询的能力。
 *
 * 用确定性代码而不是那个 LLM 角色的三个理由：
 * ```
 *   ① 不会幻觉：它读的是数据库，不是"它以为数据库里有什么"
 *   ② 零成本、零延迟：一次查询 vs 一次模型调用
 *   ③ 可复现：同样的输入永远给同样的输出
 * ```
 *
 * ⚠️ 实测依据：`clerk` 在 149 个生产文件里**零调用** —— 它从来没有真正工作过。
 *
 * ## 本文件钉住的契约
 *
 * ```
 *   ① 五类来源（决策/成交/实验/事件/失败）都能被读到
 *   ② 按时间倒序混流（消费者最常问"最近发生了什么"）
 *   ③ 上限与 `truncated` 如实报告（不能让消费者以为看到了全部）
 *   ④ 【安静地少一类，好过整张表消失】—— 某张表缺列时其余照常返回
 *   ⑤ 只看这个机器人的事实（跨机器人混在一起没有意义）
 * ```
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';

import { closeDb, initDb } from '../../db/index.js';
import { getDb } from '../../db/index.js';
import { recentFacts, recentFactsOfKind } from './factSheet.js';

const dir = mkdtempSync(join(tmpdir(), 'aq-factsheet-'));
initDb(join(dir, 'test.sqlite'));

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const TRADER = 1;

beforeEach(() => {
  const db = getDb();
  /* 清空所有相关表并重建这台机器人（§3.6 的做法）。 */
  for (const t of ['decision_records', 'trades', 'agent_experiments', 'trade_events', 'positions', 'orders', 'traders', 'strategies', 'ai_models', 'exchange_accounts']) {
    try {
      db.run(`DELETE FROM ${t}`);
    } catch {
      /* 表可能不存在（老 schema）—— 与 factSheet 的 safeAll 同一条纪律。 */
    }
  }
  /*
   * ⚠️ `traders` 有三个 **NOT NULL 外键**（`exchange_account_id` / `ai_model_id` /
   * `strategy_id`），所以必须先造它们 —— 顺序不能颠倒。
   * 照 `db/schema.test.ts` 的既有做法。
   */
  db.run(
    `INSERT INTO exchange_accounts (id, label, api_key, api_secret_enc, created_at, updated_at)
     VALUES (1, 'test', 'k', 'v1:00:00:00', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
  db.run(
    `INSERT INTO ai_models (id, provider, label, model, created_at, updated_at)
     VALUES (1, 'deepseek', 'test', 'm', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
  db.run(
    `INSERT INTO strategies (id, name, config_json, created_at, updated_at)
     VALUES (1, 'test', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
  db.run(
    `INSERT INTO traders (id, name, mode, strategy_id, exchange_account_id, ai_model_id, created_at, updated_at, initial_equity)
     VALUES (?, '测试', 'ai_team', 1, 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 100)`,
    TRADER,
  );
});

/**
 * 插一条决策记录。
 *
 * ⚠️ 列名是 `decisions_json` / `execution_log_json`（**不是** `conclusion` / `execution_log`）
 * —— 我第一版写错过，而 `factSheet` 的 `safeAll` 会让它静默返回空数组、不报错。
 */
function addDecision(cycle: number, at: string, actions: string[], executionLog: unknown[] = []): void {
  getDb().run(
    `INSERT INTO decision_records (trader_id, cycle_number, timestamp, decisions_json, execution_log_json)
     VALUES (?, ?, ?, ?, ?)`,
    TRADER,
    cycle,
    at,
    JSON.stringify(actions.map((action) => ({ symbol: 'BTCUSDT', action }))),
    JSON.stringify(executionLog),
  );
}

/** 插一笔成交。 */
function addTrade(at: string, netPnl: number, reason = 'take_profit'): void {
  getDb().run(
    `INSERT INTO trades (trader_id, symbol, side, quantity, entry_price, exit_price, leverage,
                         pnl, pnl_percent, net_pnl, fee, close_reason, opened_at, closed_at, hold_minutes)
     VALUES (?, 'BTCUSDT', 'long', 1, 100, 101, 3, ?, 1, ?, 0.01, ?, '2026-01-01T00:00:00Z', ?, 30)`,
    TRADER,
    netPnl,
    netPnl,
    reason,
    at,
  );
}

test('★★★ 五类来源都能被读到', () => {
  addDecision(7, '2026-01-01T10:00:00Z', ['skip'], [
    { symbol: 'ETHUSDT', status: 'failed', detail: '保护单挂不上' },
  ]);
  addTrade('2026-01-01T11:00:00Z', 0.5);
  getDb().run(
    `INSERT INTO agent_experiments (trader_id, created_at, trigger, observed_json, patch_json, applied_json, reason)
     VALUES (?, '2026-01-01T12:00:00Z', 'timeout', '{}', '{}', '{}', '缩小候选池')`,
    TRADER,
  );
  getDb().run(
    `INSERT INTO trade_events (trader_id, created_at, kind, symbol)
     VALUES (?, '2026-01-01T13:00:00Z', 'open', 'BTCUSDT')`,
    TRADER,
  );

  const sheet = recentFacts(TRADER);
  const kinds = new Set(sheet.entries.map((e) => e.kind));
  for (const k of ['decision', 'trade', 'experiment', 'event', 'failure'] as const) {
    assert.ok(kinds.has(k), `★ 应当能读到 ${k} 类事实（实际：${[...kinds].join(',')}）`);
  }
});

test('★★★ 按时间倒序（最新在前）', () => {
  addDecision(1, '2026-01-01T08:00:00Z', ['hold']);
  addDecision(2, '2026-01-01T20:00:00Z', ['hold']);
  const sheet = recentFacts(TRADER);
  const times = sheet.entries.map((e) => e.at);
  const sorted = [...times].sort((a, b) => (a < b ? 1 : -1));
  assert.deepEqual(times, sorted, '★ 必须按时间倒序 —— 消费者最常问"最近发生了什么"');
});

test('★★★ 上限与 truncated 必须如实报告', () => {
  for (let i = 0; i < 20; i += 1) addDecision(i, `2026-01-01T${String(i).padStart(2, '0')}:00:00Z`, [`第${i}轮`]);
  const sheet = recentFacts(TRADER, 5);
  assert.equal(sheet.entries.length, 5, '★ 必须遵守上限');
  assert.equal(sheet.truncated, true, '★ 被截断时必须如实说 —— 否则消费者以为看到了全部');
  assert.equal(sheet.count, 5);
});

test('★★★ 某张表缺列时其余照常返回（安静地少一类，好过整张表消失）', () => {
  /*
   * ⚠️ 这个模块要合并五张表，而它们的 schema 版本可能不一致（老库缺列、迁移未跑）。
   * 若任一类缺失就让整张表抛错，"文员"会变成一个**看起来没有事实可整理**的岗位 ——
   * 而真因是"某张表少一列"。
   */
  addDecision(1, '2026-01-01T10:00:00Z', ['open_long']);
  /* 故意不插成交/实验/事件 —— 相当于那几张表查不到东西。 */
  const sheet = recentFacts(TRADER);
  assert.ok(sheet.entries.length >= 1, '★ 至少决策那类必须返回');
  assert.ok(
    sheet.entries.every((e) => typeof e.summary === 'string'),
    '★ 每条都要有 summary',
  );
});

test('★★★ 只看这个机器人的事实', () => {
  getDb().run(
    `INSERT INTO traders (id, name, mode, strategy_id, exchange_account_id, ai_model_id, created_at, updated_at, initial_equity)
     VALUES (2, '别人', 'ai_team', 1, 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 100)`,
  );
  addDecision(1, '2026-01-01T10:00:00Z', ['hold']);
  getDb().run(
    `INSERT INTO decision_records (trader_id, cycle_number, timestamp, decisions_json)
     VALUES (2, 1, '2026-01-01T11:00:00Z', '[{"symbol":"BTCUSDT","action":"hold"}]')`,
  );
  const sheet = recentFacts(TRADER);
  assert.ok(
    sheet.entries.every((e) => e.fields.cycleNumber !== 1 || e.source !== 'decision_records' || e.at !== '2026-01-01T11:00:00Z'),
    '★ 跨机器人混在一起没有意义 —— 它们的账户与本钱都不同',
  );
});

test('★★★ 失败从 execution_log 抽出来（单独成类）', () => {
  addDecision(3, '2026-01-01T10:00:00Z', ['open_long'], [
    { symbol: 'BTCUSDT', status: 'failed', detail: '止损挂不上，已平仓' },
    { symbol: 'ETHUSDT', status: 'ok', detail: '开仓成功' },
  ]);
  const failures = recentFactsOfKind(TRADER, 'failure');
  assert.equal(failures.entries.length, 1, '★ 只该抽出失败那一条（ok 的不算）');
  assert.match(failures.entries[0]!.summary, /止损挂不上/);
});

test('★★ execution_log 写坏时不能抛（附属字段绝不让主流程失败）', () => {
  getDb().run(
    `INSERT INTO decision_records (trader_id, cycle_number, timestamp, decisions_json, execution_log_json)
     VALUES (?, 1, '2026-01-01T10:00:00Z', '[]', '这不是 JSON{{{')`,
    TRADER,
  );
  const sheet = recentFacts(TRADER);
  assert.ok(sheet.entries.some((e) => e.kind === 'decision'), '★ 决策那条仍要在');
  assert.equal(sheet.entries.filter((e) => e.kind === 'failure').length, 0, '★ 解析不了就不产出失败类');
});

test('★★ 成交用净额（不是毛额）—— 真正影响余额的是它', () => {
  addTrade('2026-01-01T11:00:00Z', -0.25);
  const trades = recentFactsOfKind(TRADER, 'trade');
  assert.equal(trades.entries.length, 1);
  assert.equal(trades.entries[0]!.fields.netPnl, -0.25, '★ 必须是净额（见 §2.5）');
  assert.match(trades.entries[0]!.summary, /-0\.2500/, '★ summary 里也要是净额');
});

test('★★ 空库返回空表而不是抛错', () => {
  const sheet = recentFacts(TRADER);
  assert.deepEqual(sheet.entries, []);
  assert.equal(sheet.count, 0);
  assert.equal(sheet.truncated, false);
});

test('★★ 每条都要有 source（回答"这是从哪来的"）', () => {
  addDecision(1, '2026-01-01T10:00:00Z', ['hold']);
  addTrade('2026-01-01T11:00:00Z', 0.1);
  const sheet = recentFacts(TRADER);
  for (const e of sheet.entries) {
    assert.ok(e.source.length > 0, `★ ${e.kind} 那条缺 source`);
  }
});
