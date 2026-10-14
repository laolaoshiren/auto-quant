/**
 * **猎手并发数：内存才是闸门，核数只是封顶**（2026-10-13 立 · 2026-10-14 修正）
 *
 * ## 为什么单独一条测试
 *
 * 这是一个**"单独跑很快、并发跑就死"**的性能 BUG —— 而且它的表现
 * （"agent 超过 600 秒未返回"）看起来像"任务太难"或"模型太慢"，
 * 完全不像"我把它饿死了"。
 *
 * ## 实测证据
 *
 * ```
 *   单独实测同一个猎手任务： ok=true 耗时 **92.7 秒**（搜到了真实新闻）
 *   线上并发跑四个：        **3 个未产出**（每个都"超过 600 秒未返回"）
 * ```
 * **同一个任务，单独 93 秒，并发 >600 秒** —— 差 6.5 倍。
 *
 * ## ⚠️⚠️ 2026-10-14 修正：那次"饿死"的真因是**内存**，不是 CPU
 *
 * 本文件原来写着「根因：2 核被切成 5–6 份」，并因此**钉住"并发数必须由 CPU 核数推导"**。
 * 那个归因**是错的**，当天实测的服务器状态推翻了它：
 * ```
 *   可用内存        696MB            ← 每个猎手要 150–250MB
 *   Swap 已用      1014MB / 2047MB   ← 已被压到交换区上半场
 *   僵尸进程        7 个 × 66–72MB ≈ 500MB
 *                  （/root/dsh_trade 的 src/bot.mjs：目录已删、日志不存在、
 *                    0 个网络连接、25 天只用 1.5 小时 CPU）
 * ```
 * **清掉那 7 个之后**：可用内存 **696MB → 1039MB**（+49%），swap 回落到 707MB，
 * 并发数从 1 提到 **2** —— **一行代码都没改**。
 *
 * ## 为什么"核数 ÷ 2"是个不成立的模型
 *
 * 猎手这个负载**几乎不烧 CPU**：时间全花在等 claude 进程启动、
 * 等 WebSearch/WebFetch 的网络往返。**按核数给 I/O 密集任务定并发，
 * 是把一个不成立的模型当成了依据。**
 *
 * 所以现在的判据是：
 * ```
 *   byCores  = min(3, cores)                                   ← 只做合理性封顶
 *   byMemory = max(1, floor((MemAvailable − 512MB) / 250MB))    ← 真正的闸门
 *   limit    = min(byCores, byMemory)
 * ```
 *
 * ⚠️ **而本文件下面那几条真正有效的判据一条都没放松**：
 * 不能硬编码 2、只能有一处实现、必须有上限、仍然允许显式覆盖。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { codeOnly } from '../testUtils/sourceText.js';

const MANAGER = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');


const CODE = codeOnly(MANAGER);

test('★★★ 猎手并发数默认不能是硬编码的 2', () => {
  /*
   * ⚠️ 这是那个 BUG 的**直接形状**：`?? 2`。
   * 在 2 核机器上那意味着"每个猎手只分到 1/3 个核"。
   */
  assert.ok(
    !/AQ_HUNTER_CONCURRENCY \?\? ''\) \|\| 2\b/.test(CODE),
    '★ 默认并发不能再是硬编码的 2（那是"全部超时"的直接原因；注释里引用不算）',
  );
  assert.ok(
    MANAGER.includes('AQ_HUNTER_CONCURRENCY'),
    '★ 仍要允许显式覆盖（有更多核时可以调大）',
  );
});

test('★★★ 并发数的闸门必须是【内存】（核数只做封顶）', () => {
  /*
   * ⚠️ 这条在 2026-10-14 被**改写**过：原来是"必须由 CPU 核数推导"。
   * 那条判据基于一个被实测推翻的归因（详见文件头）。
   *
   * 现在的判据是**两个都在、且内存是更严的那个**。
   */
  assert.ok(
    MANAGER.includes('cpus()'),
    '★ 仍要读 CPU 核数（它保留封顶作用）',
  );
  assert.ok(
    /hunterConcurrencyByMemory\(\)/.test(CODE),
    '★ 必须按内存算 —— 那才是"并发超时"的真因',
  );
  assert.ok(
    /return Math\.min\(byCores, hunterConcurrencyByMemory\(\)\)/.test(CODE),
    '★ 最终取两者中更严的那个',
  );
  /*
   * ⚠️ 并且**不能再有"核数 ÷ 2"** —— 那是被推翻的那个模型。
   */
  assert.ok(
    !/Math\.floor\(cores \/ 2\)/.test(CODE),
    '★ 不该再有"核数 ÷ 2"（把 I/O 密集任务当成 CPU 密集）',
  );
});

test('★★★ 必须用 MemAvailable，不能用 MemFree', () => {
  /*
   * ⚠️ `MemFree` 不算可回收的 page cache，在 Linux 上通常小一个数量级
   * （实测同一时刻 `free` 392MB vs `available` 1039MB）——
   * 按它算会得出"内存快没了"的错误结论，从而把并发错误地降到 1。
   */
  assert.ok(
    /MemAvailable/.test(CODE),
    '★ 必须读 MemAvailable',
  );
  assert.ok(
    !/MemFree/.test(CODE),
    '★ 不该用 MemFree（会小一个数量级）',
  );
});

test('★★★ 读不到内存时必须退回"按核数算"，而不是降到 1', () => {
  /*
   * ⚠️ 这是本仓库反复出现的纪律：**读不到某个事实，不该让功能停下来**
   *（与 `exchangeMaxLeverageOf` 返回 null 时退回旧行为同源）。
   */
  assert.ok(
    /if \(availMb === null\) return 3;/.test(CODE),
    '★ 读不到 /proc/meminfo（非 Linux / 权限）时退回按核数算',
  );
});

test('★★★ 并发数只能有【一处】实现（同一个算术写两遍 = 改一处等于没改）', () => {
  /*
   * ⚠️ 这条是**实测教训**：`?? 2` 在文件里出现过**两处**
   *（`refreshResearch` 与另一条调研路径），我只改了第一处 ——
   * 而上面那条断言**当场抓到了第二处**。
   *
   * 所以现在两处都调 `hunterConcurrency()`，而这条测试**钉住"只有一处"**。
   */
  const occurrences = CODE.match(/AQ_HUNTER_CONCURRENCY/g) ?? [];
  assert.equal(
    occurrences.length,
    1,
    `★ AQ_HUNTER_CONCURRENCY 只该在 hunterConcurrency() 里出现一次（实际 ${occurrences.length} 次）`,
  );
  assert.ok(
    /function hunterConcurrency\(\)/.test(CODE),
    '★ 必须有那个唯一的实现',
  );
});

test('★ 并发数有上限 —— 再多会互相饿死', () => {
  /*
   * 16 核上开 8 个 claude 进程也会把内存吃光（每个 150–250MB）。
   * 所以必须封顶。
   */
  assert.ok(
    /Math\.min\(3,/.test(CODE),
    '★ 必须有上限（每个 claude 进程 150–250MB，不能无限开）',
  );
  assert.ok(
    /HUNTER_MEMORY_PER_TASK_MB = 250/.test(CODE),
    '★ 单任务上界按实测的 250MB 计',
  );
  assert.ok(
    /HUNTER_MEMORY_RESERVE_MB = 512/.test(CODE),
    '★ 必须给服务本体/网关留余量 —— 内存耗尽的后果是【所有】猎手一起慢',
  );
});
