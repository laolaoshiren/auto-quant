/**
 * **只有当前进程真的在跑的机器人才参与 stale 判定**（外部 issue #119）。
 *
 * ## 缺陷形状
 *
 * `evaluateTraderHealth()` 原来只看**数据库里的 `status`**：
 *
 * ```ts
 * if (trader.status !== 'running') { return { …, stale: false }; }
 * // running 且 lastCycleAt 过期 → stale: true
 * ```
 *
 * 而 `traders.status` 是**持久化状态**，它说"这个机器人被标记为运行中"，
 * 不保证**当前进程**里真有一个 `AutoTrader` 实例在转。
 *
 * ## 实测后果（issue #119 的实机复现）
 *
 * `npm run seed:demo` 把 62% 的示例机器人标成 `running`，而种子脚本**只写库、
 * 不起运行时**。约 12 分钟后 `/api/health` 从 `ok: true` 翻成 `ok: false`
 * 并**永久保持红色** —— 而在另一台已跑 12.5 小时的实例上，6 个示例机器人的
 * `staleForMs ≈ 6.8 小时`。
 *
 * 于是 `Dockerfile` 与 `deploy/docker-compose.yml` 的 HEALTHCHECK 判 unhealthy，
 * 配上 `restart` 策略会**反复重启** —— 而重启并不能修好它（演示数据还在库里，
 * 12 分钟后再红一次）。
 *
 * ## 为什么"一个永远为真的假阳性"比没有检查更糟
 *
 * 这个端点的立意是「决策循环挂死时容器必须告警」（本文件开头那段注释，
 * 还举了 8.5 小时的实例）。而一个长期亮着的假阳性会让运维对它的告警**脱敏** ——
 * 真挂死那次反而没人看了。
 *
 * ## 修法
 *
 * 判定集合改成「**当前进程持有的实例表**」（`startedAtByTrader`），而不是
 * 「库里的 `status` 行」。这同时解决两类假阳性：
 *
 *   1. 演示数据（写了 `running`，从没有实例）；
 *   2. **库里残留 `running` 但进程没起** —— 在 `GLOBAL_TRADING_DISABLED=true`
 *      或启动失败时同样会出现（issue 作者实测过那个中间窗口）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateTraderHealth,
  STARTUP_GRACE_MS,
  STALE_CYCLE_MULTIPLIER,
} from '../api/server.js';

const MINUTE = 60_000;

function trader(
  overrides: Partial<{
    id: number;
    name: string;
    status: 'running' | 'stopped' | 'starting' | 'error' | 'safe_mode';
    lastCycleAt: string | null;
    cycleIntervalMinutes: number;
  }> = {},
) {
  return {
    id: 1,
    name: 'trader',
    status: 'running' as const,
    lastCycleAt: null,
    cycleIntervalMinutes: 15,
    ...overrides,
  };
}

/** 超过阈值的时间戳（阈值 = max(周期 × 2, 启动宽限)）。 */
function pastThreshold(cycleIntervalMinutes = 15, extraMs = MINUTE): string {
  const thresholdMs = Math.max(
    cycleIntervalMinutes * MINUTE * STALE_CYCLE_MULTIPLIER,
    STARTUP_GRACE_MS,
  );
  return new Date(Date.now() - thresholdMs - extraMs).toISOString();
}

test('★★★ 库里 status=running 但进程没有实例 → 不参与判定（演示数据不该让容器判红）', () => {
  const now = Date.now();
  /*
   * 这正是 `seed:demo` 之后 12 分钟的形态：库里 6 个 `running`、
   * `last_cycle_at` 很旧，而 `runningSince` 是**空的**（种脚本不起运行时）。
   */
  const seeded = [
    trader({ id: 2, name: '[示例] 激进 · 山寨轮动', lastCycleAt: pastThreshold(5) }),
    trader({ id: 5, name: '[示例] 突破 · 波动率', lastCycleAt: pastThreshold(15) }),
  ];

  const verdict = evaluateTraderHealth(seeded, now, new Map());

  assert.equal(
    verdict.ok,
    true,
    '★★★ 当前进程没有这些机器人的实例时，它们**不该**让健康检查判红 ——\n' +
      '    否则装了演示数据的部署会长期红着、并触发无意义的重启循环（issue #119）。',
  );
  assert.equal(verdict.stale.length, 0, '★ 没有实例就没有"卡住的循环"可言');
});

test('★★★ 进程真的持有实例、且它卡住了 → 仍然必须判红（修 #119 不能把真告警关掉）', () => {
  const now = Date.now();
  /*
   * 反向守卫：这是这个端点存在的**唯一理由**（`health.test.ts` 开头记录的
   * 8.5 小时静默停摆事故）。必须在"有实例"的前提下仍然生效。
   */
  const verdict = evaluateTraderHealth(
    [trader({ id: 1, lastCycleAt: pastThreshold(15) })],
    now,
    /* 进程确实在跑它，而且已经跑了足够久。 */
    new Map([[1, now - 60 * MINUTE]]),
  );

  assert.equal(verdict.ok, false, '★★★ 真有实例且真卡住了，必须判红');
  assert.equal(verdict.stale.length, 1);
  assert.equal(verdict.stale[0]?.traderId, 1);
});

test('★★ 进程刚拉起、首轮还没跑完 → 宽限期内不判红', () => {
  const now = Date.now();
  const verdict = evaluateTraderHealth(
    [trader({ id: 1, lastCycleAt: null })],
    now,
    /* 刚启动 1 分钟 —— 远在启动宽限内。 */
    new Map([[1, now - MINUTE]]),
  );
  assert.equal(verdict.ok, true, '★ 启动宽限必须仍然生效');
  assert.equal(verdict.traders[0]?.awaitingFirstCycle, true);
});

test('★★ 上游没给实例表时退化为"不判定" —— 而不是把全部 running 都算成卡住', () => {
  /*
   * `ApiDependencies.manager` 可能是测试桩或第三方嵌入方，没有 `runningSince`。
   * 那时调用点传空 Map（见 `server.ts` 的注释："Missing the map degrades instead
   * of throwing"）—— 于是判定集合为空 = 不判定，**而不是**把库里所有
   * `running` 都当成"该转却没转"。
   *
   * ⚠️ 这一点决定了两条实现路径的取舍：一个**默认判红**的健康检查在
   * 缺能力时会"在启动瞬间判定失败"，而 `health.test.ts` 开头那段注释
   * 明确警告过"误报的检查比没有检查更糟"。
   */
  const now = Date.now();
  const verdict = evaluateTraderHealth(
    [trader({ id: 1, lastCycleAt: pastThreshold(15) })],
    now,
    new Map(),
  );
  assert.equal(verdict.ok, true, '★★ 拿不到实例表时不判定，而不是误报');
  /* 但状态仍然如实列出来（控制台要看得到它们）。 */
  assert.equal(verdict.traders.length, 1);
  assert.equal(verdict.traders[0]?.status, 'running');
});

test('★ 非 running 状态一律不参与 —— 既有边界不变', () => {
  const now = Date.now();
  for (const status of ['stopped', 'safe_mode', 'error', 'starting'] as const) {
    const verdict = evaluateTraderHealth(
      [trader({ id: 1, status, lastCycleAt: pastThreshold(15) })],
      now,
      /* 即便进程里有它（例如停在 starting 的残留），也不判红。 */
      new Map([[1, now - 60 * MINUTE]]),
    );
    assert.equal(verdict.ok, true, `★ ${status} 不该参与 stale 判定`);
  }
});
