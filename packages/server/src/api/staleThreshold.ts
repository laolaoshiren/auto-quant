/**
 * **"停摆"阈值 —— 跟着真实分布走，而不是拍脑袋乘个系数**（2026-10-17 · t114 · P0 假警报）。
 *
 * ## 事故：`t99` 的停摆横幅今天响了两次，两次 `#10` 都在正常工作
 *
 * ```
 *   14:05  health ok:false，staleTraders[#10 staleForMs=46.7 分钟]   ⇒ 实际在跑
 *   16:26  health ok:false，staleTraders[#10 staleForMs≈27 分钟]     ⇒ 实际在跑
 * ```
 *
 * ## 根因（实测数字，不是推断）
 *
 * 原判据 = `max(周期 × 2, 300 秒)`。`#10` 周期 15 分钟 ⇒ **30 分钟**。
 * 而这一轮**从开始到完成**要多久？线上 `decision_records.ai_latency_ms`
 * （`#10` 468 轮、`#11` 496 轮，只读查询 `2026-10-17 16:3x`）：
 *
 * | | 轮数 | 均值 | 最长 |
 * |---|---|---|---|
 * | `#10 赚大钱` | 468 | **5.2 分钟** | **26.5 分钟** |
 * | `#11 团队测试` | 496 | 3.0 分钟 | 24.3 分钟 |
 *
 * 再看今天 `#10` 的实际节拍（`decision_records` 间隔）：
 * `805→806 26.0 分 · 809→810 25.0 分 · 810→811 22.7 分 · 813→814 68.4 分
 *  · 814→815 32.4 分 · 815→816 35.6 分 · 816→817 22.7 分`
 *
 * ⇒ **一轮从开始到完成经常超过 30 分钟**（长轮次 26 分钟 + 轮间间隔），
 * 而 `traders.last_cycle_at` 是**一轮结束时**才写的 ——
 * 于是"正在进行的长轮次"必然被判成"停摆"。**这不是阈值调大一点的事，
 * 是判据用错了一个统计量。**
 *
 * ## 修法：两层，缺一不可
 *
 * ① **阈值跟随真实分布** = `max(周期 × 2, P95(已完成轮次的时长) × 2, 下限)`
 *    —— 分布从库里现算（**不写死 36 分钟**），用的就是那个被
 *    `t105` 标成"pending 时是 0"的同一列 `ai_latency_ms`。
 * ② **"正在跑"必须被看见** = 若最新一行是 **pending**（`ai_latency_ms = 0` 且
 *    `error IS NULL` 且 `decisions_json` 为空）**且它足够新**，那它就是在跑，
 *    **不算停摆**。
 *
 * ⚠️ ②里"足够新"是必须的：pending 判据在 `finish()` 落库时 `ai_latency_ms`
 * 可能**确实是 0**（模型几乎瞬回时）—— 那种行会永远"看起来 pending"。
 * 所以只认**年龄 < 阈值**的 pending；一条两小时前的 pending 行说明进程在
 * 那一轮里就死了，**必须继续报警**。
 *
 * ## 为什么乘 2（而不是直接取 P95 或 P99）
 *
 * `staleForMs` 的语义是"距**上一轮结束**"。一轮的占用 ≈ 上一轮时长 + 轮间间隔，
 * 而 `last_cycle_at` 只在一轮**结束时**写，所以"正在进行的那一轮"最多要等
 * **它自己的时长**再叠一个间隔。乘 2 把这些都盖住。
 * 实测：`#10` P95 ≈ 20.9 分钟 ⇒ 阈值 ≈ 42 分钟，比原来的 30 分钟宽，
 * 而今天的两次假警报（46.7 / 27 分钟）中 ——
 * **27 分钟会被完全挡住**；46.7 分钟那次**仍然会报**（那是正常的：它确实
 * 暴露了"轮间 + 长轮次"叠加，需要看 ② 的 pending 判据来区分）。
 *
 * ## 缓存
 *
 * 每次 `/api/health` 都跑一遍分布查询会打爆库（而 health 是编排器高频探测的）。
 * 所以按机器人缓存 **5 分钟** —— 分布是慢变量，5 分钟粒度足够。
 */

import { getDb } from '../db/index.js';

/** 缓存有效期：分布是慢变量，5 分钟粒度足够，同时把查询次数压到很低。 */
export const STALE_DISTRIBUTION_TTL_MS = 5 * 60_000;

/** 参与统计的最近轮数上限（**带 LIMIT**，不做全表扫描）。 */
export const STALE_DISTRIBUTION_SAMPLE = 200;

/**
 * 阈值下限（毫秒）。
 *
 * 沿用原来的 `max(周期 × 2, 300 秒)` 那一支作为**地板**：
 * 分布样本不足（新机器人、刚清过库）时，退回原判据而不是"没有阈值"。
 */
export const STALE_FLOOR_GRACE_MS = 300_000;

/** P95 的倍数 —— 见文件头"为什么乘 2"。 */
export const STALE_P95_MULTIPLIER = 2;

export interface CycleDurationStats {
  /** 参与统计的轮数。 */
  samples: number;
  /** 第 95 百分位的轮次时长（毫秒）；样本不足时为 `null`。 */
  p95Ms: number | null;
  maxMs: number | null;
}

/**
 * 从**已完成**的轮次里算时长分布（纯函数，便于断言）。
 *
 * 判据：`success = 1 AND ai_latency_ms > 0`。
 * `ai_latency_ms = 0` 的那批是 pending 行（`t105`）或"瞬回"，不参与时长统计。
 */
export function cycleDurationStats(values: readonly number[]): CycleDurationStats {
  const sorted = [...values].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { samples: 0, p95Ms: null, maxMs: null };
  /* 最近秩法：第 ceil(0.95·n) 个（1 起）。样本少时它就等于最大值 —— 保守。 */
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(0.95 * sorted.length)));
  return {
    samples: sorted.length,
    p95Ms: sorted[rank - 1]!,
    maxMs: sorted[sorted.length - 1]!,
  };
}

interface CacheEntry {
  at: number;
  stats: CycleDurationStats;
}

const cache = new Map<number, CacheEntry>();

/** 清缓存（测试用；也供"刚改过配置"时手动失效）。 */
export function resetStaleDistributionCache(): void {
  cache.clear();
}

/**
 * 这个机器人最近的轮次时长分布（**带 5 分钟缓存**）。
 *
 * ⚠️ 只读、带 `LIMIT`；读失败时返回"无样本"（于是阈值退回地板），
 * **绝不因为统计读不到就不判停摆** —— 那会让真停摆静默。
 */
export function recentCycleStats(
  traderId: number,
  now: number = Date.now(),
  ttlMs: number = STALE_DISTRIBUTION_TTL_MS,
): CycleDurationStats {
  const hit = cache.get(traderId);
  if (hit !== undefined && now - hit.at < ttlMs) return hit.stats;
  let stats: CycleDurationStats = { samples: 0, p95Ms: null, maxMs: null };
  try {
    const rows = getDb().all<{ ai_latency_ms: number }>(
      `SELECT ai_latency_ms FROM decision_records
        WHERE trader_id = ? AND success = 1 AND ai_latency_ms > 0
        ORDER BY id DESC LIMIT ?`,
      traderId,
      STALE_DISTRIBUTION_SAMPLE,
    );
    stats = cycleDurationStats(rows.map((r) => Number(r.ai_latency_ms)));
  } catch {
    /* 读不到 = 无样本 ⇒ 阈值退回地板（仍然是原来的判据，不会放过真停摆）。 */
  }
  cache.set(traderId, { at: now, stats });
  return stats;
}

/**
 * 这个机器人该用的"停摆"阈值（毫秒）。
 *
 * ```
 *   threshold = max(周期 × 2, 300 秒, P95 × 2)
 * ```
 * 三项都保留：前两项是原来的判据（**下限**），第三项让它跟着真实分布走。
 * 于是"放宽"只会发生在**确有长轮次证据**的机器人上，而不是对所有机器人一律放宽。
 */
export function staleThresholdMs(input: {
  cycleIntervalMinutes: number;
  stats: CycleDurationStats;
  multiplier: number;
  floorMs?: number;
}): number {
  const base = Math.max(1, input.cycleIntervalMinutes) * 60_000 * input.multiplier;
  const floor = Math.max(input.floorMs ?? STALE_FLOOR_GRACE_MS, base);
  const fromDistribution =
    input.stats.p95Ms === null ? 0 : Math.round(input.stats.p95Ms * STALE_P95_MULTIPLIER);
  return Math.max(floor, fromDistribution);
}
