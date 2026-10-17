import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStrategyConfig, type WakeTrigger } from '@aq/shared';
import { closeDb, getDb, initDb } from '../db/index.js';
import {
  aiModels,
  computeTraderStats,
  decisions,
  exchanges,
  RUNTIME_LOG_CAP,
  runtimeLogs,
  strategies,
  tradeEvents,
  traders,
  trades as tradeStore,
} from './repositories.js';
import {
  AGENT_EXPERIMENTS_CAP,
  AGENT_RUNS_CAP,
  TRIM_EVERY_WRITES,
  agentExperiments,
  agentRuns,
  trimAgentTables,
} from './agentStore.js';

/**
 * The "growth" contract: every table that is written by the trading loop must be
 * bounded, and the bounding must not happen on the per-row write path.
 *
 * The bugs these tests exist for:
 *
 *  1. `runtime_logs` ran `DELETE … WHERE id NOT IN (… LIMIT 500)` on **every**
 *     inserted line, and `AutoTrader.emit()` calls it per symbol inside loops
 *     (reconcile recovery, protection failure, close failure). One cycle could
 *     fire dozens of full-table DELETEs. `node:sqlite` is synchronous, so each
 *     one blocked the event loop — the event loop that runs the trading cycle.
 *  2. `trade_events` had **no** retention at all while every round-trip writes
 *     two rows, so it grew forever.
 *
 * Follows the AGENTS.md §3.6 pattern: a temp directory, never `data/`.
 */

let workDir: string;
let traderId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-retention-'));
  initDb(path.join(workDir, 'retention.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.run('DELETE FROM runtime_logs');
  db.run('DELETE FROM trade_events');
  db.run('DELETE FROM trades');
});

function seedTrader(): number {
  const account = exchanges.create({
    exchange: 'binance',
    label: 'retention',
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: 'retention',
    model: 'm',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const strategy = strategies.create({
    name: 'retention',
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  return traders.create({
    name: 'retention',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  }).id;
}

traderId = 0;

/* -------------------------------------------------------------------------- */
/*  runtime_logs                                                               */
/* -------------------------------------------------------------------------- */

test('runtime_logs stays bounded without deleting on every single write', () => {
  traderId = seedTrader();
  const db = getDb();

  /*
   * Each `emit()` line writes one row. Writing `RUNTIME_LOG_CAP + slack` rows
   * must leave the table bounded — the old code guaranteed exactly 500, the new
   * code guarantees `CAP + TRIM_EVERY` because the trim is batched.
   *
   * The important half of this assertion is that the *bound* still holds; the
   * other half — that the DELETE is rare — is what makes it cheap.
   */
  const slack = 400;
  for (let i = 0; i < RUNTIME_LOG_CAP + slack; i += 1) {
    runtimeLogs.write(traderId, 'info', 'trader', `line ${i}`);
  }

  const count = db.count('SELECT COUNT(*) AS n FROM runtime_logs');
  assert.ok(
    count <= RUNTIME_LOG_CAP + slack,
    `table must not grow without bound, got ${count} rows`,
  );

  // The console reads the newest rows, so the newest row must still be there.
  const newest = runtimeLogs.list(1);
  assert.equal(newest[0]?.message, `line ${RUNTIME_LOG_CAP + slack - 1}`);
});

test('runtimeLogs.trim() compacts the table on demand', () => {
  traderId = seedTrader();
  const db = getDb();
  for (let i = 0; i < RUNTIME_LOG_CAP + 50; i += 1) {
    runtimeLogs.write(traderId, 'info', 'server', `line ${i}`);
  }
  runtimeLogs.trim();
  assert.equal(db.count('SELECT COUNT(*) AS n FROM runtime_logs'), RUNTIME_LOG_CAP);
});

test('★ runtimeLogs.list() 自己钳制 limit —— 巨值原本会让端点 500', () => {
  /*
   * 复现的是外部 issue #124：`GET /api/logs?limit=<巨值>` 返回
   * **500 datatype mismatch**。
   *
   * 原来的路由只挡了非有限值（`Number.isFinite`），而 `1e21` **是有限数** ——
   * 它顺利通过并直达 SQL 的 `LIMIT ?`，`node:sqlite` 随即抛
   * `ERR_SQLITE_ERROR: datatype mismatch`（不是截断、不是空结果）。
   *
   * 实测的触发条件是 **≥1e21 或非整数**：`1.5` 同样抛；
   * 而 `2**53` 虽然已超出安全整数范围却仍然正常 —— 所以判据不是"超安全整数"。
   *
   * 钳制放在仓储层（与 `clampOrderLimit` 同一个取舍），这样"忘了在路由里写钳制"
   * 不再可能：所有调用点自动受保护。
   */
  traderId = seedTrader();
  for (let i = 0; i < 5; i += 1) runtimeLogs.write(traderId, 'info', 'trader', `钳制 ${i}`);

  // 这两个值原本会让整个端点 500 —— 现在必须正常返回，且不超过一页上限。
  assert.doesNotThrow(() => runtimeLogs.list(1e21), '≥1e21 原本抛 datatype mismatch');
  assert.doesNotThrow(() => runtimeLogs.list(1.5), '非整数原本同样抛 datatype mismatch');
  assert.equal(runtimeLogs.list(1e21).length, 5, '巨值被收成上限，5 行全回');
  assert.equal(runtimeLogs.list(1.5).length, 1, '1.5 取整为 1 行');

  // 负数在 SQLite 里表示**无上限**，会把全表回出去 —— 与"只回一页"的契约相反。
  assert.equal(runtimeLogs.list(-5).length, 1, '负数必须收进 [1, max]，不是无上限');
  assert.equal(runtimeLogs.list(0).length, 1, 'LIMIT 0 的空结果会伪装成"没有日志"');

  // 非有限值回落到默认页大小（与路由原来的 `?? 200` 契约一致）。
  assert.equal(runtimeLogs.list(Number.NaN).length, 5, 'NaN 回落到默认页大小');
  assert.equal(runtimeLogs.list(Number.POSITIVE_INFINITY).length, 5, 'Infinity 回落到默认页大小');

  // 正常值不受影响。
  assert.equal(runtimeLogs.list(3).length, 3, '正常 limit 必须原样生效');
  assert.equal(runtimeLogs.list().length, 5, '不传时用默认页大小');
});

test('a burst of writes does far fewer DELETEs than writes', () => {
  traderId = seedTrader();
  const db = getDb();

  /*
   * The regression this pins: the old write path issued one full-table DELETE per
   * row, so N writes meant N scans. There is no counter to read, so the assertion
   * is behavioural — write a burst that a per-row trim would compact to the cap,
   * and check the table is allowed to hold more than the cap (i.e. the trim did
   * not run on every line).
   */
  const writes = RUNTIME_LOG_CAP + 100;
  for (let i = 0; i < writes; i += 1) {
    runtimeLogs.write(traderId, 'info', 'trader', `line ${i}`);
  }
  const count = db.count('SELECT COUNT(*) AS n FROM runtime_logs');
  assert.ok(
    count > RUNTIME_LOG_CAP,
    'a per-row trim would have left exactly the cap; a batched trim leaves a buffer',
  );
});

/* -------------------------------------------------------------------------- */
/*  trade_events                                                               */
/* -------------------------------------------------------------------------- */

test('trade_events is trimmed to a window that still covers the cooldown ceiling', () => {
  traderId = seedTrader();
  const db = getDb();
  const now = Date.now();

  // One ancient row (outside any plausible retention window) and one recent row.
  db.run(
    'INSERT INTO trade_events (trader_id, symbol, kind, created_at) VALUES (?, ?, ?, ?)',
    traderId,
    'BTCUSDT',
    'exit',
    new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(),
  );
  db.run(
    'INSERT INTO trade_events (trader_id, symbol, kind, created_at) VALUES (?, ?, ?, ?)',
    traderId,
    'ETHUSDT',
    'exit',
    new Date(now - 60_000).toISOString(),
  );

  tradeEvents.trim();

  assert.equal(db.count('SELECT COUNT(*) AS n FROM trade_events'), 1, 'ancient rows are gone');
  // The recent row must survive: the re-entry cooldown reads exactly this.
  assert.ok(tradeEvents.lastFor(traderId, 'ETHUSDT', 'exit'));
  assert.equal(tradeEvents.lastFor(traderId, 'BTCUSDT', 'exit'), undefined);
});

test('the retention window is longer than the longest configurable cooldown', () => {
  /*
   * `ThrottleConfigSchema.reentryCooldownMinutes` allows up to 1440 (24 hours).
   * If retention were shorter than that, an old row could be trimmed while still
   * inside a configured cooldown — and the cooldown would silently stop
   * protecting, which is a trading-behaviour change, not a housekeeping one.
   *
   * 7 days is asserted here as a floor rather than an equality: the point is
   * "comfortably longer", not a specific number.
   */
  const retentionDays = 7;
  assert.ok(
    retentionDays * 24 * 60 > 1440,
    'retention must exceed the maximum reentryCooldownMinutes',
  );
});

/* -------------------------------------------------------------------------- */
/*  computeTraderStats after the SQL aggregation rewrite                       */
/* -------------------------------------------------------------------------- */

test('aggregate stats still match a hand-computed ledger', () => {
  traderId = seedTrader();
  const openedAt = new Date(Date.now() - 3_600_000).toISOString();

  /*
   * 3 wins, 1 loss, with both legs of commission and funding on one row.
   *
   * ⚠️ **`funding` 是交易所口径的带符号值 —— 支出为负。** 这里原来是 `+0.02`
   * （凭直觉写的"支出为正"），而真实观测到的是负数（`#9` 的 `-0.00718777`）。
   * 符号搞错一次会让"一笔支出"被算成"一笔收入"，而表现是**每轮都报一条假的
   * 账目告警**。见 `netPnlOf` 的注释。
   */
  const rows: Array<{ gross: number; entryFee: number; exitFee: number; funding: number }> = [
    { gross: 10, entryFee: 0.1, exitFee: 0.1, funding: 0 },
    { gross: 5, entryFee: 0.05, exitFee: 0.05, funding: -0.02 },
    { gross: 2, entryFee: 0.01, exitFee: 0.01, funding: 0 },
    { gross: -8, entryFee: 0.08, exitFee: 0.08, funding: 0 },
  ];
  for (const row of rows) {
    tradeStore.insert({
      traderId,
      symbol: 'BTCUSDT',
      side: 'long',
      quantity: 0.01,
      entryPrice: 68_000,
      exitPrice: 68_000,
      leverage: 3,
      grossPnl: row.gross,
      entryFee: row.entryFee,
      exitFee: row.exitFee,
      fundingFee: row.funding,
      closeReason: 'model_decision',
      openedAt,
    });
  }

  const expectedNet = rows.reduce(
    /* `+ row.funding` —— 它已经是带符号的（支出为负）。 */
    (sum, row) => sum + row.gross - row.entryFee - row.exitFee + row.funding,
    0,
  );
  const stats = computeTraderStats(traderId);

  assert.equal(stats.totalTrades, 4);
  assert.equal(stats.wins, 3);
  assert.equal(stats.losses, 1);
  assert.equal(stats.wins + stats.losses, stats.totalTrades);
  assert.ok(Math.abs(stats.realizedPnl - expectedNet) < 1e-9, `got ${stats.realizedPnl}`);
  assert.ok(
    Math.abs(stats.totalFees - rows.reduce((s, r) => s + r.entryFee + r.exitFee, 0)) < 1e-9,
  );
  assert.ok(Math.abs(stats.totalFunding - -0.02) < 1e-9, `got ${stats.totalFunding}`);
  assert.ok(Math.abs(stats.grossRealizedPnl - (10 + 5 + 2 - 8)) < 1e-9);
  // best/worst are `MAX/MIN(net_pnl)` — the funded row's net is smaller than the
  // unfunded 4.9, so it is *not* the best. Asserting that pins the definition:
  // "best trade" is by net, not by gross, which is the whole point of §2.5.
  assert.ok(Math.abs(stats.bestTrade - (10 - 0.1 - 0.1)) < 1e-9, `got ${stats.bestTrade}`);
  assert.ok(Math.abs(stats.worstTrade - (-8 - 0.08 - 0.08)) < 1e-9);
});

test('a trader with no trades still reports finite, zeroed stats', () => {
  traderId = seedTrader();
  const stats = computeTraderStats(traderId);
  assert.equal(stats.totalTrades, 0);
  assert.equal(stats.bestTrade, 0, 'MAX() over zero rows must not leak a null');
  assert.equal(stats.worstTrade, 0, 'MIN() over zero rows must not leak a null');
  assert.equal(stats.realizedPnl, 0);
  assert.ok(Number.isFinite(stats.profitFactor));
  assert.ok(Number.isFinite(stats.maxDrawdownPercent));
});

test('the equity curve is read once, so max drawdown is unchanged by the rewrite', () => {
  traderId = seedTrader();
  const db = getDb();
  // Peak 1200, trough 900 → 25% drawdown.
  for (const [index, equity] of [1000, 1200, 900].entries()) {
    db.run(
      `INSERT INTO equity_snapshots (trader_id, timestamp, equity, available_balance, unrealized_pnl, margin_used, open_positions)
       VALUES (?, ?, ?, 0, 0, 0, 0)`,
      traderId,
      new Date(Date.now() - (10 - index) * 60_000).toISOString(),
      equity,
    );
  }
  const stats = computeTraderStats(traderId);
  assert.ok(
    Math.abs(stats.maxDrawdownPercent - 25) < 1e-9,
    `expected 25% drawdown, got ${stats.maxDrawdownPercent}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  AI 的三张表                                                                */
/* -------------------------------------------------------------------------- */

test('★ AI 的运行记录表也有界，不会随交易量无限增长', () => {
  /*
   * 这条用例存在的理由：仓库自己定的契约是「凡是交易循环写入的表都必须有界」
   * （见本文件顶部），而 AI 托管的三张表漏了 —— 它们与交易量同阶增长：
   * 每平一笔写一条经验、每次审视写一条运行记录、每次调参写一条实验
   * （**且每行含整份 StrategyConfig，约 2KB**）。
   *
   * 读它们的地方全都是"最近 N 条"，没有任何一处需要全集 —— 所以裁剪不丢信息。
   */
  const id = seedTrader();

  /* 造够行数触发裁剪（写满一个批次）。 */
  for (let i = 0; i < AGENT_RUNS_CAP + 120; i++) {
    agentRuns.insert({
      traderId: id,
      kind: 'strategy',
      trigger: 'manual',
      /*
       * ⚠️ 原值 `'normal'` 是**早于 `single|panel` 的旧档位名**，现在不在 `Intensity` 里
       * （t61 收窄 `insert()` 时当场变成 TS2322）。
       * 这条用例测的是**表的上界与裁剪批次**，与档位取哪个值无关 —— 换成 `single` 语义不变。
       */
      intensity: 'single',
      steps: 1,
      agents: {},
      outcome: 'ok',
      detail: `seed ${i}`,
      tokensIn: 1,
      tokensOut: 1,
      latencyMs: 1,
    });
  }

  const count =
    getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_runs WHERE trader_id = ?', id)?.n ?? -1;
  /*
   * 断言的是**真实上界** `CAP + TRIM_EVERY_WRITES`，不是 CAP —— 裁剪按批次发生，
   * 最后一批未满的行会留着（与 `runtime_logs` 同一个模式，它的注释里写着
   * "表的上界变成 CAP + TRIM_EVERY = 700 行"）。
   *
   * 第一版这里断言 `<= CAP`，于是它失败了 —— 而那次失败说明的是**断言写错了**，
   * 不是实现错了（实测：插 620 行后是 520，手动裁一次回到 500）。
   */
  assert.ok(
    count <= AGENT_RUNS_CAP + TRIM_EVERY_WRITES,
    `agent_runs 上界应为 ${AGENT_RUNS_CAP + TRIM_EVERY_WRITES}，实际 ${count} —— 超了就是裁剪没在跑`,
  );
  assert.ok(count > AGENT_RUNS_CAP, '夹具本身要能把表顶过上限，否则这条用例什么都没测');
});

test('★ 未结算的实验永远不裁：裁掉它，那笔调参的因果就永远对不上', () => {
  /*
   * `agent_experiments` 的结算要等结果（5 笔成交或 24 小时）。一条**还没结算**的
   * 记录被裁掉，就意味着"我改了什么 → 之后发生了什么"这个环永远断了 ——
   * 而那正是"越跑越厉害"的全部机制。
   *
   * 所以裁剪只作用于已结算的行，且上限只对已结算的那些计数。
   */
  const id = seedTrader();
  /*
   * ⚠️ `trigger` 的类型是 `WakeTrigger`（t61），所以参数不能是裸 `string`。
   * 原夹具调用处给的是 `'timeout'`（合法）与 `'periodic'`（**不合法**，
   * 不在那 8 个取值里）。这里把类型收窄到联合类型 —— 于是 `'periodic'`
   * 这个非法调用点**当场编译不过**，必须改成合法值。
   * 语义不变：这条用例测的是"裁剪不得动未结算的行"，与触发原因无关。
   */
  const seed = (trigger: WakeTrigger) => ({
    traderId: id,
    trigger,
    observed: {},
    patch: {},
    applied: {},
    clamps: {},
    reason: 'seed',
    toolCalls: [],
  });

  const stillPending = agentExperiments.insert(seed('timeout'));

  /* 一批**已结算**的实验，把已结算那部分顶过上限。 */
  for (let i = 0; i < AGENT_EXPERIMENTS_CAP + 30; i++) {
    const settled = agentExperiments.insert(seed('new_result'));
    agentExperiments.settle(settled, { trades: 1, netPnl: 0 });
  }

  /* 直接调一次裁剪（不依赖批次计数），断言的是"未结算的还在"。 */
  trimAgentTables();

  assert.ok(
    agentExperiments.pending(id).some((e) => e.id === stillPending),
    '未结算的那条必须还在 —— 裁掉它，那笔调参的因果就永远对不上',
  );
});

/* -------------------------------------------------------------------------- */
/*  decision_records                                                           */
/* -------------------------------------------------------------------------- */

test('★ decision_records 有界，而且不是每写一行就全表扫一次', () => {
  /*
   * 同一类缺陷的第三处（前两处是 `runtime_logs` 与 `trade_events`）：
   * `decisions.log()` 原来在**每一行** INSERT 之后都跑一次
   * `DELETE … WHERE id NOT IN (… LIMIT 500)` —— 一次全表扫描，而这张表的每一行
   * 都是**几十 KB 的提示词全文**。`node:sqlite` 是同步 API，那次扫描直接压在
   * 跑交易循环的事件循环上。
   *
   * 两条断言各钉一半：
   *   · 上界仍然成立（表不会无限长）；
   *   · 但不是逐行裁剪（否则剩下的会**恰好**是 500，没有缓冲）。
   */
  traderId = seedTrader();
  const db = getDb();

  const writeOne = (cycle: number): void => {
    decisions.log({
      traderId,
      cycleNumber: cycle,
      systemPrompt: 'system',
      userPrompt: 'user',
      cotTrace: '',
      decisions: [],
      rawResponse: '',
      executionLog: [],
      candidateSymbols: [],
      success: true,
      error: null,
      aiLatencyMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
  };

  const writes = 540;
  for (let i = 0; i < writes; i += 1) writeOne(i);

  const count = db.count('SELECT COUNT(*) AS n FROM decision_records');
  assert.ok(count <= 550, `表必须有界（上限 500 + 每 50 次一批），实际 ${count} 行`);
  assert.ok(
    count > 500,
    `逐行裁剪会恰好留下 500 行；批量裁剪会留下缓冲，实际 ${count} 行`,
  );

  /* 控制台读的是最近那些行 —— 最新的那一条必须还在。 */
  assert.equal(decisions.list(traderId, 1)[0]?.cycleNumber, writes - 1);
});

test('★ 提示词全文只保留最近若干条 —— 它是这个库 90% 的体积', () => {
  /*
   * 实测（2026-09-29）：`decision_records` 占 **88.77 MB**，其中 `user_prompt`
   * 一个字段就占 **68.59 MB**（单条最大 **220,295 字符** —— 20 个候选 × 4 个周期
   * × 10 个指标序列的完整数组）。保留 500 条 = **稳态约 100 MB**，
   * 而且每轮都要往 SQLite 写 ~200 KB。
   *
   * 而"当时给模型看了什么"只在**复盘最近几轮**时有价值。更早的决策里真正有
   * 长期价值的是**决定了什么**（`decisions_json`）与**执行结果**
   * （`execution_log_json`）—— 所以超期之后**只清提示词字段、不删行**。
   */
  traderId = seedTrader();
  const db = getDb();

  const writeBig = (cycle: number): void => {
    decisions.log({
      traderId,
      cycleNumber: cycle,
      systemPrompt: 'S'.repeat(2000),
      userPrompt: 'U'.repeat(20000), // 模拟"大提示词"（实盘单条最大 220KB）
      cotTrace: '',
      decisions: [],
      rawResponse: 'R'.repeat(500),
      executionLog: [],
      candidateSymbols: [],
      success: true,
      error: null,
      aiLatencyMs: 1,
      promptTokens: null,
      completionTokens: null,
    });
  };

  const writes = 200;
  for (let i = 0; i < writes; i += 1) writeBig(i);

  const rows = db.all<{ id: number; len: number }>(
    'SELECT id, LENGTH(user_prompt) AS len FROM decision_records WHERE trader_id = ? ORDER BY id',
    traderId,
  ).map((r) => ({ id: r.id, len: Number(r.len) }));
  const kept = rows.filter((r) => r.len > 0).length;

  assert.ok(kept >= 100, `最近 100 条必须保留全文，实际只留 ${kept} 条`);
  assert.ok(
    kept <= 150,
    `更早的必须被清空（否则体积会回到 100 MB），实际留了 ${kept} 条`,
  );
  /* 行数不能少：决策与执行结果要完整可回看。 */
  assert.equal(rows.length, writes, `清空提示词不等于删行，实际 ${rows.length} 行`);
  /* 最新那条必须有全文 —— 复盘正在跑的这几轮靠它。 */
  assert.ok(rows[rows.length - 1]!.len > 0, '最新一条必须有全文');
});

test('★ feesOf() 必须派生 exitFee —— `exit_fee` 不是数据库列', () => {
  /*
   * 原实现写的是 `SELECT entry_fee, exit_fee FROM trades WHERE id = ?`，
   * 而 `exit_fee` **从来不是一列**（`schema.ts` 的迁移只加了 `entry_fee`；
   * 那边 `net_pnl = gross − entry_fee − exit_fee − funding_fee` 只是注释，不是 DDL）。
   *
   * 于是那个查询**必然抛** `no such column: exit_fee`。它此前没有调用者，
   * 所以是一颗没被踩到的哑弹 —— 一旦有人调用就会直接拿到 500
   * （`server.ts` 把非 4xx 一律按 500 处理）。
   *
   * 修法是**派生**，且必须与读出层（`trades.list()` 的
   * `Math.max(0, fee - entry_fee)`）同一个口径 —— 否则全项目会出现两处
   * 各自计算 exitFee 的代码，而它们迟早会分叉。
   */
  traderId = seedTrader();
  const { id } = tradeStore.insert({
    traderId,
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 0.01,
    entryPrice: 68_000,
    exitPrice: 68_000,
    leverage: 3,
    grossPnl: 1,
    entryFee: 0.01183192,
    exitFee: 0.01216007,
    fundingFee: 0,
    closeReason: 'model_decision',
    openedAt: new Date(Date.UTC(2025, 0, 1)).toISOString(),
  });

  assert.doesNotThrow(() => tradeStore.feesOf(id), '不得再抛 no such column: exit_fee');

  const fees = tradeStore.feesOf(id);
  assert.ok(Math.abs(fees.entryFee - 0.01183192) < 1e-12, `entryFee 实际 ${fees.entryFee}`);
  assert.ok(Math.abs(fees.exitFee - 0.01216007) < 1e-9, `派生的 exitFee 实际 ${fees.exitFee}`);
  /* 两侧必须能加回合计 —— 这是"同一件事只有一个口径"的可检形式。 */
  assert.ok(
    Math.abs(fees.entryFee + fees.exitFee - 0.02399199) < 1e-9,
    'entryFee + exitFee 必须等于合计手续费',
  );

  /* 不存在的 id：返回零值，而不是抛。 */
  assert.deepEqual(tradeStore.feesOf(-1), { entryFee: 0, exitFee: 0 });
});

test('★★★ tradeEvents.entriesThisCycle 必须查 timestamp —— decision_records 没有 created_at 列', () => {
  /*
   * ## 这个测试防的是什么（外部 issue #151）
   *
   * `tradeEvents.entriesThisCycle()` 查的是：
   *
   *     SELECT created_at FROM decision_records WHERE trader_id = ? AND cycle_number = ?
   *
   * 而 `decision_records` 的时间列叫 **`timestamp`**（`db/schema.ts:188`）——
   * **`created_at` 在那一张表上不存在**，于是这个方法一被调用就抛
   * `no such column: created_at`（实测）。
   *
   * ## 它为什么至今没爆：没有调用点
   *
   * 全仓 grep `entriesThisCycle` 的命中**全是 `RiskEnvironment` 的同名字段**
   *（`engine.ts` / `autoTrader.ts:3849` 里那个 `entriesThisCycle: 0` 是**风控环境**的字段，
   *  与这个仓储方法同名但无关）。所以它是一颗**没人踩到的哑弹** ——
   * 与本仓库修过的 `feesOf()`（查不存在的 `exit_fee` 列）是同一族：
   * **死方法里查了一个不存在的列**。
   *
   * 这类缺陷值得单独测试的理由：它的"死"是**偶然**的（只是恰好没人调），
   * 而不是设计使然 —— 一旦有人接上它（例如真的要做"本周期已开几仓"的统计），
   * 就是线上 500。
   *
   * ## 为什么现在要修而不是删
   *
   * 它的**语义是有效的**（按 `cycle_number` 找到那一轮的起始时刻，再数之后的开仓事件），
   * 而 `risk/engine.ts` 的 `maxEntriesPerCycle` 判据正需要这类信息
   *（目前 `env.entriesThisCycle` 是由调用点传 0 开始的局部计数）。
   * 所以修列名比删方法更贴近意图。
   */
  traderId = seedTrader();

  /* 造一轮决策记录 + 之后的开仓事件 —— 正是这个方法要数的东西。 */
  const cycleNumber = 42;
  decisions.log({
    traderId,
    cycleNumber,
    systemPrompt: 'S',
    userPrompt: 'U',
    cotTrace: '',
    decisions: [],
    rawResponse: '',
    executionLog: [],
    candidateSymbols: [],
    success: true,
    error: null,
    aiLatencyMs: 1,
    promptTokens: null,
    completionTokens: null,
  });
  tradeEvents.record(traderId, 'BTCUSDT', 'entry');

  /* 决定性断言：不得抛 no such column: created_at。 */
  assert.doesNotThrow(
    () => tradeEvents.entriesThisCycle(traderId, cycleNumber),
    '★★★ 不得再抛 no such column: created_at —— decision_records 的时间列是 timestamp',
  );

  const count = tradeEvents.entriesThisCycle(traderId, cycleNumber);
  assert.equal(count, 1, '那一轮之后记了 1 条开仓事件，就该数到 1');

  /* 不存在的轮次不应抛：查不到行时回落到"最近一分钟"这个保守窗口。 */
  assert.doesNotThrow(
    () => tradeEvents.entriesThisCycle(traderId, 9999),
    '查不到该轮次时也不能抛 —— 它回落到一个保守的默认窗口',
  );
});
