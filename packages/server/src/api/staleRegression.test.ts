/**
 * **放宽判据时，先想清楚哪些不该被放宽**（2026-10-17 · t114 · P0 假警报）。
 *
 * ## 这份测试接的是什么
 *
 * `t99` 的停摆横幅今天响了**两次，两次 `#10` 都在正常工作**（14:05 / 16:26）。
 * 根因不是"阈值偏小一点点"，而是**判据用错了一个统计量**：
 *
 * ```
 *   staleForMs = 现在 − 上一轮【结束】时间     （last_cycle_at 只在一轮结束时写）
 *   threshold  = 周期 × 2                     （= 30 分钟）
 * ```
 * 而线上实测：`#10` 468 轮、均值 5.2 分钟、**最长 26.5 分钟**；
 * 今天节拍里 `813→814` 达 **68.4 分钟**（长轮次 + 轮间间隔）。
 * ⇒ **一轮从开始到完成经常超过 30 分钟**，正在跑的那一轮被整个算进 `staleForMs`。
 *
 * ## 四条反向校准（队长点名，本文件的主体）
 *
 * | 情形 | 期望 |
 * |---|---|
 * | 真卡住 60 分钟不动 | **仍然报警** |
 * | 一轮跑了 35 分钟但**仍在进行** | **不再报警** |
 * | pending 行存在且**新鲜** | **不报警** |
 * | pending 行**很旧**（2 小时前） | **仍然报警** |
 *
 * ⚠️ 最后两条是同一枚硬币的两面：**只看"有没有 pending" 会让真死掉的机器人永不报警**
 *（`finish()` 落库时 `ai_latency_ms` 可能真是 0，那种行永远"看起来 pending"）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { evaluateTraderHealth, type HealthContext } from './server.js';

const MINUTE = 60_000;

function trader(over: Partial<{ id: number; lastCycleAt: string | null; cycleIntervalMinutes: number }> = {}) {
  return {
    id: 10,
    name: '赚大钱',
    status: 'running' as const,
    lastCycleAt: null,
    cycleIntervalMinutes: 15,
    ...over,
  };
}

/** 线上实测的分布：P95 ≈ 20.9 分钟（468 轮）。 */
const REAL_STATS = { samples: 200, p95Ms: Math.round(20.9 * MINUTE), maxMs: Math.round(26.5 * MINUTE) };

function ctx(over: Partial<{ stats: typeof REAL_STATS; pendingAt: string }> = {}): HealthContext {
  const statsByTrader = new Map([[10, over.stats ?? REAL_STATS]]);
  const pendingAtByTrader = new Map<number, string>();
  if (over.pendingAt !== undefined) pendingAtByTrader.set(10, over.pendingAt);
  return { statsByTrader, pendingAtByTrader };
}

const STARTED = new Map([[10, Date.now() - 6 * 3_600_000]]);

/* -------------------------------------------------------------------------- */
/*  ① 真卡住 → 仍然报警                                                          */
/* -------------------------------------------------------------------------- */

test('★★★ 真卡住 60 分钟不动 → **仍然报警**（放宽不许放过真停摆）', () => {
  /*
   * 这是本任务最重要的一条：阈值被抬高之后，一个**真的死了**的机器人
   * 必须照样判红。60 分钟 > 任何合理阈值（#10 实际约 42 分钟）。
   */
  const now = Date.now();
  const verdict = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 60 * MINUTE).toISOString() })],
    now,
    STARTED,
    ctx(),
  );
  assert.equal(verdict.ok, false, '★★★ 真卡 60 分钟必须判红');
  assert.equal(verdict.stale.length, 1);
  assert.equal(verdict.stale[0]!.traderId, 10);
});

test('★★ 没有分布样本时，阈值退回原来的 30 分钟（老行为不变）', () => {
  /*
   * 新机器人、刚清过库、统计读不到 —— 这些情形不该让判据"凭空变宽"。
   * 45 分钟 > 30 分钟 ⇒ 仍然报警。
   */
  const now = Date.now();
  const verdict = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 45 * MINUTE).toISOString() })],
    now,
    STARTED,
    { statsByTrader: new Map([[10, { samples: 0, p95Ms: null, maxMs: null }]]) },
  );
  assert.equal(verdict.ok, false, '★ 无样本 ⇒ 30 分钟判据仍然生效');
  assert.equal(verdict.stale[0]!.thresholdMs, 30 * MINUTE, '★ 阈值必须如实报出（便于核对）');
});

/* -------------------------------------------------------------------------- */
/*  ② 长轮次正在进行 → 不再报警                                                  */
/* -------------------------------------------------------------------------- */

test('★★★ 一轮跑了 35 分钟但**仍在进行** → **不再报警**（今天两次假警报的形状）', () => {
  /*
   * 线上：`last_cycle_at` 停在 35 分钟前，而 `decision_records` 里有一条
   * **12 分钟前开始的 pending 行** —— 它在跑。
   *
   * 判据：pending 的年龄（12 分钟）< 阈值 ⇒ 一轮在进行中 ⇒ 不算停摆。
   */
  const now = Date.now();
  const verdict = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 35 * MINUTE).toISOString() })],
    now,
    STARTED,
    ctx({ pendingAt: new Date(now - 12 * MINUTE).toISOString() }),
  );
  assert.equal(verdict.ok, true, '★★★ 正在进行的长轮次不许判红');
  assert.equal(verdict.stale.length, 0);
  assert.equal(verdict.traders[0]!.cycleInProgress, true, '★ 要如实报出"它在跑"');
});

test('★★★ 分布驱动之后，连"没有 pending 证据"的长间隙也不再误报', () => {
  /*
   * 第二种误报形状：`813→814` 那 68.4 分钟**没有** pending 行（轮间间隔 + 排队）。
   * 分布说 P95 ≈ 20.9 分钟 ⇒ 阈值 ≈ 41.8 分钟，所以 35 分钟**不该**判红。
   * 而 45 分钟 > 41.8 ⇒ **该判红**。
   *
   * 这两条一起证明：阈值是**活的**（跟着分布走），不是"一律放宽到某个常数"。
   */
  const now = Date.now();
  const within = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 35 * MINUTE).toISOString() })],
    now,
    STARTED,
    ctx(),
  );
  assert.equal(within.ok, true, '★ 35 分钟 < 41.8 分钟 ⇒ 不报');
  assert.equal(within.traders[0]!.thresholdMs, Math.round(20.9 * MINUTE * 2), '★ 阈值来自 P95×2');

  const beyond = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 45 * MINUTE).toISOString() })],
    now,
    STARTED,
    ctx(),
  );
  assert.equal(beyond.ok, false, '★★ 45 分钟 > 41.8 分钟 ⇒ 仍然报（阈值不是无限放宽）');
});

/* -------------------------------------------------------------------------- */
/*  ③ pending 新鲜 → 不报警；④ pending 很旧 → 仍然报警                            */
/* -------------------------------------------------------------------------- */

test('★★★ pending 行**很旧**（2 小时前）→ **仍然报警**（防"有 pending 就永不报警"）', () => {
  /*
   * ## 这一条防的是什么
   *
   * `begin()` 写 pending 行，`finish()` 补它。如果进程在那**一轮里**死了，
   * 那条 pending 会**永远**留在库里。只看"有没有 pending"的话，
   * 那个机器人就会**永不报警** —— 比原来的误报危险得多。
   *
   * ## 为什么还必须有年龄上限而不能只靠"有 pending"
   *
   * pending 判据是 `ai_latency_ms = 0 && error IS NULL && decisions_json` 空。
   * 而 `finish()` 落库时 `ai_latency_ms` **可能确实是 0**（模型几乎瞬回），
   * 于是那种**已完成**的行也会永远"看起来 pending"。
   * ⇒ 只有"年龄 < 阈值"的 pending 才算证据。
   */
  const now = Date.now();
  const verdict = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 2 * 60 * MINUTE).toISOString() })],
    now,
    STARTED,
    ctx({ pendingAt: new Date(now - 2 * 60 * MINUTE).toISOString() }),
  );
  assert.equal(verdict.ok, false, '★★★ 2 小时前的 pending 不许被当成"在跑"');
  assert.equal(verdict.stale.length, 1);
  assert.equal(verdict.traders[0]!.cycleInProgress, false, '★ 它不算"在跑"');
});

test('★★★ pending 刚出现（1 分钟前）→ **不报警**，即使距上一轮结束很久', () => {
  /*
   * 这是"在跑"的最强证据：`last_cycle_at` 还停在 50 分钟前，但 1 分钟前刚
   * `begin()` 了新的一轮 —— 它明明在动。
   */
  const now = Date.now();
  const verdict = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 50 * MINUTE).toISOString() })],
    now,
    STARTED,
    ctx({ pendingAt: new Date(now - 1 * MINUTE).toISOString() }),
  );
  assert.equal(verdict.ok, true, '★★★ 刚开始的 pending 行就是"在跑"的铁证');
  assert.equal(verdict.stale.length, 0);
});

test('★★ pending 年龄恰好在阈值边界上 → 判"在跑"（严格小于才排除）', () => {
  /*
   * 边界要明确写出来，避免"差一分钟就翻脸"的模糊地带。
   * 判据：`now - pendingMs < thresholdMs` ⇒ 在跑。恰等于阈值 ⇒ **不算在跑**（保守）。
   */
  const now = Date.now();
  const thresholdMs = Math.round(20.9 * MINUTE * 2);
  const atBoundary = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 90 * MINUTE).toISOString() })],
    now,
    STARTED,
    ctx({ pendingAt: new Date(now - thresholdMs).toISOString() }),
  );
  assert.equal(
    atBoundary.stale.length,
    1,
    '★ 恰好等于阈值的 pending 不再算证据（保守：宁可多报，不可漏报）',
  );

  const justInside = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 90 * MINUTE).toISOString() })],
    now,
    STARTED,
    ctx({ pendingAt: new Date(now - (thresholdMs - MINUTE)).toISOString() }),
  );
  assert.equal(justInside.stale.length, 0, '★ 阈值内 1 分钟 ⇒ 算在跑');
});

/* -------------------------------------------------------------------------- */
/*  ⑤ 不传 context 时行为与改动前一致                                            */
/* -------------------------------------------------------------------------- */

test('★★ 不传 `context` ⇒ 行为与改动前**完全一致**（老调用方不受影响）', () => {
  /*
   * `evaluateTraderHealth` 是导出函数，测试桩与第三方嵌入方都可能直接调。
   * 不传 context 时阈值必须是原来的 `max(周期×2, 300 秒)`，且不认 pending。
   */
  const now = Date.now();
  const v = evaluateTraderHealth(
    [trader({ lastCycleAt: new Date(now - 35 * MINUTE).toISOString() })],
    now,
    STARTED,
  );
  assert.equal(v.ok, false, '★ 不传 context ⇒ 35 分钟仍然按老判据报（30 分钟）');
  assert.equal(v.traders[0]!.thresholdMs, 30 * MINUTE);
  assert.equal(v.traders[0]!.cycleInProgress, false, '★ 没有 context 就没有"在跑"的证据');
});

/* -------------------------------------------------------------------------- */
/*  ⑥ 接线：算好了却没人传 ⇒ 修复静默失效                                          */
/* -------------------------------------------------------------------------- */

test('★★★ 两个调用点都必须真的把 `healthContext()` 传进去', () => {
  /*
   * ## 为什么这条必须单独守
   *
   * 上面所有用例都直接调 `evaluateTraderHealth(..., ctx())` ——
   * **它们证明的是"这个函数会按 context 判"，不证明"生产里有人给它 context"**。
   * 若哪天 `/api/health` 或 `manager.auditStaleTraders` 忘了传，判据会退回 30 分钟：
   * **横幅与 `[停摆]` 日志又会双双误报**，而上面 10 条用例照样全绿。
   *
   * （本仓库反复出现的形状：「能力在、没人用」。`t99` 里我刚用同一招守过
   * `await this.auditStaleTraders()` 的接线。）
   */
  const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  assert.match(
    server,
    /evaluateTraderHealth\(traders\.list\(\), Date\.now\(\), runningSince, healthContext\(\)\)/,
    '★★★ `/api/health` 必须传 healthContext()',
  );

  const manager = readFileSync(new URL('../trader/manager.ts', import.meta.url), 'utf8');
  assert.match(
    manager,
    /evaluateTraderHealth\(rows, Date\.now\(\), this\.runningSince\(\), healthContext\(\)\)/,
    '★★★ 停摆审计必须传同一个 healthContext() —— 否则横幅与日志各说各话',
  );
  assert.match(
    manager,
    /const \{[^}]*evaluateTraderHealth,[^}]*healthContext,[^}]*\} =\s*await import/,
    '★ `healthContext` 必须从 `api/server.js` 取（与判据同源）',
  );

  /* ★ 探针：漏传的写法必须被这条判据认出来。 */
  const naive = 'evaluateTraderHealth(traders.list(), Date.now(), runningSince)';
  assert.ok(
    !/healthContext\(\)/.test(naive),
    '★ 探针：三参调用（= 旧写法）必须被判为"没传 context"',
  );
});

test('★★★ `/api/health` 的 `staleTraders` 必须把 `thresholdMs` 带出去', () => {
  /*
   * ## 这条抓的是一个**类型检查抓不到**的真缺口（我这次真踩到了）
   *
   * `thresholdMs` 是 `TraderHealth` 上的**可选**字段，而 `staleTraders` 是
   * 手工映射出来的 —— 忘了放行它，`tsc` 一句都不报，横幅却只能显示
   * `（阈值 NaN 分钟）`。
   *
   * 判据：`staleTraders: health.stale.map(...)` 那一段里必须出现
   * `thresholdMs: entry.thresholdMs`。
   */
  const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  const at = server.indexOf('staleTraders: health.stale.map');
  assert.notEqual(at, -1, '★ 找不到 staleTraders 映射 —— 判据失效');
  const block = server.slice(at, at + 700);
  assert.match(
    block,
    /thresholdMs: entry\.thresholdMs/,
    '★★★ 映射里必须放行 thresholdMs（可选字段 ⇒ 类型检查不会提醒）',
  );

  /* ★ 探针：不带它的样本必须被判违规。 */
  const probe = 'staleTraders: health.stale.map((e) => ({ id: e.traderId, name: e.name }))';
  assert.ok(
    !/thresholdMs: entry\.thresholdMs/.test(probe),
    '★ 探针：漏放行的样本必须被判违规',
  );
});
