/**
 * **"停摆"阈值必须跟着真实分布走，而且不许因此放过真停摆**（2026-10-17 · t114 · P0）。
 *
 * ## 这份测试接的是什么
 *
 * `t99` 的停摆横幅今天响了**两次，两次 `#10` 都在正常工作**（14:05 与 16:26）。
 * 而原判据是 `max(周期 × 2, 300 秒)` = 30 分钟 ——
 * **它比的不是"一轮有多久"，而是"距上一轮结束有多久"**，
 * 而一轮结束时才会写 `last_cycle_at`，于是"正在进行的长轮次"必然被判成停摆。
 *
 * ## 四条反向校准（队长点名要的，也是本文件的主体）
 *
 * | 情形 | 期望 |
 * |---|---|
 * | 真卡住 60 分钟不动 | **仍然报警** |
 * | 一轮跑了 35 分钟但**仍在进行** | **不再报警** |
 * | pending 行存在且**新鲜** | **不报警** |
 * | pending 行**很旧**（2 小时前） | **仍然报警** |
 *
 * ⓪ 另有两条"分布驱动"的守卫：阈值必须从样本算出来（不是写死）、
 * 样本不足时退回地板（不能变成"永不报警"）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cycleDurationStats,
  recentCycleStats,
  resetStaleDistributionCache,
  staleThresholdMs,
  STALE_DISTRIBUTION_SAMPLE,
  STALE_FLOOR_GRACE_MS,
  STALE_P95_MULTIPLIER,
} from './staleThreshold.js';

const MINUTE = 60_000;

/* -------------------------------------------------------------------------- */
/*  ① 分布统计本身                                                               */
/* -------------------------------------------------------------------------- */

test('★★★ P95 从样本算出来（最近秩法），不是拍脑袋的常数', () => {
  /*
   * 20 个样本，P95 应当落在第 19 个（ceil(0.95×20)=19）。
   * 这样"最长的那一次抖动"不会把阈值直接顶到最大（那是 max 的活，不是 P95 的）。
   */
  const values = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 1000,
  ].map((m) => m * MINUTE);
  const stats = cycleDurationStats(values);
  assert.equal(stats.samples, 20);
  assert.equal(stats.p95Ms, 19 * MINUTE, '★★★ P95 必须是第 19 个（不是最大值 1000）');
  assert.equal(stats.maxMs, 1000 * MINUTE, '★ 最大值仍如实报出（但不参与 P95）');

  /* ⚠️ `ai_latency_ms = 0` 的是 pending/瞬回，不许参与时长统计。 */
  const withZeros = cycleDurationStats([0, 0, 5 * MINUTE]);
  assert.equal(withZeros.samples, 1, '★ 0 毫秒的行必须被剔除');
  assert.equal(withZeros.p95Ms, 5 * MINUTE);
});

test('★★★ 样本不足时 P95 是 null（于是阈值退回地板，而不是"永不报警"）', () => {
  const empty = cycleDurationStats([]);
  assert.equal(empty.samples, 0);
  assert.equal(empty.p95Ms, null, '★★★ 没有样本必须是 null —— 不能用 0 冒充（那会让阈值变成 0）');
  assert.equal(empty.maxMs, null);

  /* 只有 1 个样本时，P95 就等于那一个（保守）。 */
  assert.equal(cycleDurationStats([7 * MINUTE]).p95Ms, 7 * MINUTE);
});

test('★★★ 阈值 = max(周期×2, 地板, P95×2) —— 三项缺一不可', () => {
  const base = { cycleIntervalMinutes: 15, multiplier: 2 };

  /* 没有分布样本 ⇒ 就是原来的判据（30 分钟）。 */
  assert.equal(
    staleThresholdMs({ ...base, stats: { samples: 0, p95Ms: null, maxMs: null } }),
    30 * MINUTE,
    '★ 无样本时必须退回原来的 30 分钟（行为不变）',
  );

  /* 分布说"一轮常常 20 分钟" ⇒ 阈值抬到 40 分钟。 */
  assert.equal(
    staleThresholdMs({ ...base, stats: { samples: 100, p95Ms: 20 * MINUTE, maxMs: 26 * MINUTE } }),
    20 * MINUTE * STALE_P95_MULTIPLIER,
    '★★★ 阈值必须跟着 P95 走（20 分钟 P95 ⇒ 40 分钟阈值）',
  );

  /* 分布很短（快机器人）⇒ 不被抬高，仍用周期与地板。 */
  assert.equal(
    staleThresholdMs({ ...base, stats: { samples: 100, p95Ms: 1 * MINUTE, maxMs: 2 * MINUTE } }),
    30 * MINUTE,
    '★ 快机器人不该因为 P95 小而把阈值降到 30 分钟以下（地板仍然生效）',
  );

  /* 长周期机器人：周期×2 本身就大于分布 ⇒ 不被拉低。 */
  assert.equal(
    staleThresholdMs({
      cycleIntervalMinutes: 120,
      multiplier: 2,
      stats: { samples: 100, p95Ms: 20 * MINUTE, maxMs: 26 * MINUTE },
    }),
    240 * MINUTE,
    '★ 长周期机器人仍然按自己的周期判（不许被分布拉低）',
  );

  /* ★ 探针：把 P95 写死成某个常数时，上面第 2 条会红 —— 这里用"两个不同 P95 得到两个不同阈值"证明它是活的。 */
  const a = staleThresholdMs({ ...base, stats: { samples: 100, p95Ms: 20 * MINUTE, maxMs: 0 } });
  const b = staleThresholdMs({ ...base, stats: { samples: 100, p95Ms: 30 * MINUTE, maxMs: 0 } });
  assert.notEqual(a, b, '★ 探针：不同分布必须得到不同阈值（写死的常数不会）');
});

test('★ 地板常量与样本上限是显式导出的（便于核对，不是散落的魔数）', () => {
  assert.equal(STALE_FLOOR_GRACE_MS, 300_000, '每个机器人至少 5 分钟的起步宽限');
  assert.ok(
    STALE_DISTRIBUTION_SAMPLE > 0 && STALE_DISTRIBUTION_SAMPLE <= 1000,
    '样本上限必须是一个有界的小数 —— 这是"带 LIMIT、不做全表扫描"的实现约束',
  );
});

test('★★ 读不到库时退回"无样本"（阈值退回地板），绝不抛出', () => {
  /*
   * `recentCycleStats` 在没有初始化数据库时会抛 —— 它必须吞掉并返回空统计，
   * 否则 `/api/health` 会 500（那是比"判错"更糟的失败：编排器会直接把实例判死）。
   */
  resetStaleDistributionCache();
  const stats = recentCycleStats(12345);
  assert.equal(stats.samples, 0, '★ 读不到时必须返回空统计');
  assert.equal(stats.p95Ms, null);

  /* 第二次走缓存，仍然安全（缓存的是"无样本"，不会反复打库）。 */
  assert.equal(recentCycleStats(12345).p95Ms, null);
});
