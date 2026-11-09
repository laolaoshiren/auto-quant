/**
 * **`trades.intel_keys` 必须有读取侧** —— 这条测试钉住"写了但没接线"的修复。
 *
 * ## 为什么这个测试存在（2026-11-09 审计）
 *
 * 这一列从 M16 起就一直在**写**（开仓写 `positions.intel_keys`，平仓搬到
 * `trades.intel_keys`），但整个仓库**没有一处读它**。直接后果：
 * `signalHealth.assessSignal()` 拿不到"某个信号的历史成交"，
 * 失效检测永远返回 `insufficient_data` —— 代码在跑、测试通过、日志正常，
 * 而它从未生效过。
 *
 * 这里钉住读取侧的四个契约：
 * ① 纯技术面成交（`intel_keys = '[]'`）不进入归因；
 * ② `returnPct` 是**净**收益率的小数比例（`pnl_percent / 100`）；
 * ③ 窗口 + 条数上限生效，且返回按**时间升序**（`signalHealth` 的两条判据
 *    —— 滚动窗口 `slice(-WINDOW)` 与"从最后一笔往前数连续亏损" —— 都假定旧 → 新）；
 * ④ 坏 JSON 不抛错（附属字段绝不让主流程失败）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, getDb, initDb } from '../db/index.js';
import { aiModels, exchanges, strategies, traders, trades as tradeStore } from './repositories.js';
import { SIGNAL_LIMITS } from '../trader/intel/signalHealth.js';
import { signalHealthReportFor } from '../trader/intel/signalHealthReport.js';

let workDir: string;
let traderId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-trade-intel-'));
  initDb(path.join(workDir, 'intel.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

function seedTrader(name: string): number {
  const account = exchanges.create({
    exchange: 'binance',
    label: `${name}-account`,
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: `${name}-model`,
    model: 'm',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const strategy = strategies.create({
    name: `${name}-strategy`,
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

function clearTrades(): void {
  getDb().run('DELETE FROM trades');
}

function insertTrade(input: {
  closedAt: string;
  grossPnl: number;
  intelKeys?: readonly string[];
  traderId?: number;
}): void {
  /* 入场名义 50（100 × 0.5）、杠杆 3 ⇒ margin = 50/3，净收益率 = net / margin。 */
  tradeStore.insert({
    traderId: input.traderId ?? traderId,
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 0.5,
    entryPrice: 100,
    exitPrice: 100,
    leverage: 3,
    grossPnl: input.grossPnl,
    closeReason: 'model_decision',
    openedAt: new Date(Date.parse(input.closedAt) - 3_600_000).toISOString(),
    closedAt: input.closedAt,
    ...(input.intelKeys === undefined ? {} : { intelKeys: input.intelKeys }),
  });
}

const KEY = 'coindesk.com|bullish|BTCUSDT';
const since = '2026-01-01T00:00:00.000Z';
const day = (n: number): string => new Date(Date.UTC(2026, 0, n, 12)).toISOString();

/* -------------------------------------------------------------------------- */
/*  ① 只读"由情报驱动"的成交                                                      */
/* -------------------------------------------------------------------------- */

test('★★★ 纯技术面成交（intel_keys = []）不进入归因；有键的才进', () => {
  traderId = seedTrader('intel-read');
  clearTrades();

  insertTrade({ closedAt: day(1), grossPnl: 1, intelKeys: [KEY] });
  insertTrade({ closedAt: day(2), grossPnl: -1 }); // 纯技术面
  insertTrade({ closedAt: day(3), grossPnl: 2, intelKeys: [KEY] });

  const rows = tradeStore.intelAttributionsSince(traderId, since);
  assert.equal(rows.length, 2, '★ 纯技术面成交不能混进信号归因');
  assert.ok(rows.every((r) => r.intelKeys.includes(KEY)));
});

/* -------------------------------------------------------------------------- */
/*  ② 收益率口径：净的小数比例                                                    */
/* -------------------------------------------------------------------------- */

test('★★★ returnPct 是净收益率的小数比例（0.012 = +1.2%）', () => {
  /*
   * `trades.pnl_percent` 是 `net_pnl / margin × 100`（例如 1.2 表示 +1.2%）。
   * 而 `SignalTrade.returnPct` 的契约是小数（0.012）。差 100 倍会让"盈利/亏损"
   * 的判据完全错位 —— 所以这里用可手算的 fixture 钉住换算。
   *
   * 入场 100 × 0.5 = 50 名义、杠杆 3 ⇒ margin = 50/3 ≈ 16.6667。
   * 毛盈亏 +10、手续费共 0.4 ⇒ 净 9.6 ⇒ pnl_percent = 9.6 / 16.6667 × 100 = 57.6%
   * ⇒ returnPct = 0.576。
   */
  traderId = seedTrader('intel-return');
  clearTrades();

  insertTrade({
    closedAt: day(1),
    grossPnl: 10,
    intelKeys: [KEY],
  });
  /* 上面那笔没有手续费，净 = 毛 ⇒ 10 / 16.6667 × 100 = 60% ⇒ returnPct = 0.6。 */
  const rows = tradeStore.intelAttributionsSince(traderId, since);
  assert.equal(rows.length, 1);
  assert.ok(
    Math.abs(rows[0]!.returnPct - 0.6) < 1e-9,
    `returnPct 应为 0.6（+60%），得到 ${rows[0]!.returnPct} —— 差 100 倍说明口径错位`,
  );
});

/* -------------------------------------------------------------------------- */
/*  ③ 窗口、上限、时间顺序                                                        */
/* -------------------------------------------------------------------------- */

test('★★★ 窗口按 closed_at 过滤，返回按时间升序', () => {
  traderId = seedTrader('intel-window');
  clearTrades();

  insertTrade({ closedAt: '2025-12-01T12:00:00.000Z', grossPnl: 1, intelKeys: [KEY] }); // 窗口外
  insertTrade({ closedAt: day(1), grossPnl: 1, intelKeys: [KEY] });
  insertTrade({ closedAt: day(3), grossPnl: -1, intelKeys: [KEY] });
  insertTrade({ closedAt: day(2), grossPnl: 2, intelKeys: [KEY] });

  const rows = tradeStore.intelAttributionsSince(traderId, since);
  assert.equal(rows.length, 3, '窗口外的行不能返回');
  assert.deepEqual(
    rows.map((r) => r.closedAt),
    [day(1), day(2), day(3)],
    '★ 必须按时间升序 —— signalHealth 的连续亏损/滚动窗口都假定旧 → 新',
  );
});

test('★★ limit 取的是**最新** N 条（内部按时间倒序取，再反转）', () => {
  traderId = seedTrader('intel-limit');
  clearTrades();

  for (let d = 1; d <= 5; d += 1) {
    insertTrade({ closedAt: day(d), grossPnl: d, intelKeys: [KEY] });
  }

  const rows = tradeStore.intelAttributionsSince(traderId, since, 2);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.closedAt),
    [day(4), day(5)],
    '★ 上限截断必须留下最新的两笔（而不是最旧的两笔）',
  );
});

/* -------------------------------------------------------------------------- */
/*  ④ 容错与归属                                                                 */
/* -------------------------------------------------------------------------- */

test('★★★ 坏 JSON 不抛错 —— 附属统计字段不该让读取失败', () => {
  traderId = seedTrader('intel-corrupt');
  clearTrades();

  insertTrade({ closedAt: day(1), grossPnl: 1, intelKeys: [KEY] });
  /* 直接改库模拟"被截断/手改过"的行（`<> '[]'` 会选中它）。 */
  getDb().run(
    "INSERT INTO trades (trader_id, symbol, side, quantity, entry_price, exit_price, leverage, pnl, pnl_percent, fee, close_reason, opened_at, closed_at, hold_minutes, entry_fee, funding_fee, net_pnl, source, intel_keys) VALUES (?, 'ETHUSDT', 'long', 1, 100, 100, 3, 1, 1, 0, 'model_decision', ?, ?, 60, 0, 0, 1, 'bot', 'not-json')",
    traderId,
    day(2),
    day(2),
  );

  const rows = tradeStore.intelAttributionsSince(traderId, since);
  assert.equal(rows.length, 2, '坏 JSON 那行仍应被读出（只是键为空），绝不能抛错');
  const corrupt = rows.find((r) => r.closedAt === day(2));
  assert.ok(corrupt, '坏 JSON 那行应存在');
  assert.deepEqual(corrupt.intelKeys, [], '坏 JSON 降级成空键');
});

test('★★ 只返回指定机器人的归因成交', () => {
  traderId = seedTrader('intel-mine');
  const other = seedTrader('intel-other');
  clearTrades();

  insertTrade({ closedAt: day(1), grossPnl: 1, intelKeys: [KEY] });
  insertTrade({ closedAt: day(1), grossPnl: 1, intelKeys: [KEY], traderId: other });

  const rows = tradeStore.intelAttributionsSince(traderId, since);
  assert.equal(rows.length, 1, '另一个机器人的成交不能混进来');
});

/* -------------------------------------------------------------------------- */
/*  ⑤ 端到端：仓储读取 + 报告判定，整条链接通                                       */
/* -------------------------------------------------------------------------- */

test('★★★ 端到端：仓储读出 intel_keys → signalHealth 得出真实结论（不是 insufficient_data）', () => {
  /*
   * 这条测试存在的理由：上面每一条都只测链条的一半 —— 仓储能读、报告能算。
   * 而 2026-11-09 之前的 bug 恰恰是"两半都存在、但中间没有接线"：
   * `intel_keys` 没人读，`assessSignal()` 拿不到输入，永远 `insufficient_data`。
   *
   * 这里从 `trades.insert()`（真实写入路径）走到 `signalHealthReportFor()`
   * （生产调用路径），断言它能**越过 MIN_SAMPLES 并给出结论**。
   */
  traderId = seedTrader('intel-e2e');
  clearTrades();

  for (let i = 0; i < SIGNAL_LIMITS.MIN_SAMPLES; i += 1) {
    insertTrade({ closedAt: day(i + 1), grossPnl: 1, intelKeys: [KEY] });
  }

  const report = signalHealthReportFor(traderId, { windowStart: since });
  assert.equal(report.attributedTrades, SIGNAL_LIMITS.MIN_SAMPLES);
  assert.equal(report.signals.length, 1, '★ 整条链必须把信号喂到判定层');
  assert.equal(report.signals[0]!.signalKey, KEY);
  assert.equal(report.signals[0]!.verdict.health, 'effective');
  assert.ok(report.summary !== null && report.summary.includes('有效'), `摘要：${report.summary}`);
});
