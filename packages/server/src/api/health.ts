import { AI_MANAGED_PRESET_MODEL, type Trader, type TraderStatus } from '@aq/shared';
import { recentCycleStats, staleThresholdMs } from './staleThreshold.js';
import { agentRuns as agentStoreRuns } from '../store/agentStore.js';
import { aiModels, decisions, decisions as decisionStore, traders } from '../store/repositories.js';
import { DEFAULT_MAGPIE_URL } from '../trader/teamGateway.js';

/* -------------------------------------------------------------------------- */
/*  Health truth                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 一个机器人多久没走完一轮才算"卡住"——以它的周期为单位的倍数。
 *
 * **2 倍**，理由是把"合法的最慢情况"排除在外：
 *
 *  · `traders.last_cycle_at` 是在**一轮走完之后**才写的
 *    （`store/repositories.ts` 的 `recordCycle()`），所以 1 倍周期时，
 *    每一轮都恰好会在写之前短暂越线 —— 那是必然发生的假警报，不是故障。
 *  · 一轮的墙钟时间 = 周期本身 + 它对模型的调用 + 行情快照。模型的超时上限
 *    就是分钟级的，一个慢周期花掉接近一整个周期的时间是正常的。
 *  · 取 2 倍意味着"连续两轮都没能结束"才报警：单次超时、单次提供商抽风、
 *    单次交易所 503 都不会触发它，而**真正卡死**（事件循环被同步 SQLite 堵住、
 *    网络调用永不返回、循环退出）会在一个有界的时间内必然触发。
 *
 * 为什么不能再大：这个数字同时是运维发现"机器人已经不工作了"的延迟上限。
 * 取 3 倍会让一个 15 分钟的机器人最多沉默 45 分钟才被发现，而它在无保护、
 * 有持仓的情况下沉默的每一分钟都是真金白银的风险。
 */
export const STALE_CYCLE_MULTIPLIER = 2;

/**
 * 启动宽限期：这之后才开始判定"卡住"。
 *
 * 没有它，健康检查会在冷启动时**必然**失败一次：进程起来 → 容器开始探测 →
 * 行情快照 / 合约元数据 / 用户数据流还在加载，第一个周期要几十秒才走完，
 * 而 `last_cycle_at` 这时还是 null。那会让编排器在最不该重启的时候重启容器。
 *
 * 300 秒是一个"足够慢的启动也能走完第一轮"的下限；它也是每个机器人各自计算的
 * 下界（`max(周期 × 2, 300s)`），所以它对周期 1 分钟的机器人同样有效。
 */
export const STARTUP_GRACE_MS = 300_000;

/**
 * **`evaluateTraderHealth` 的可选上下文**（2026-10-17 · t114）。
 *
 * ## 为什么需要它（P0 假警报：`t99` 的横幅今天响了两次，两次都在正常跑）
 *
 * 原来的阈值是 `max(周期 × 2, 300 秒)` = **30 分钟**（`#10` 周期 15 分钟）。
 * 而 `staleForMs` 量的是"**距上一轮结束**"——`last_cycle_at` 是一轮**结束时**
 * 才写的，所以它把"正在进行的那一轮"整个算进去了。
 * 线上实测（只读查库，2026-10-17 16:3x）：
 *
 * ```
 *   #10  468 轮 | 均值 5.2 分钟 | 最长 26.5 分钟
 *   今天节拍：805→806 26.0 分 · 813→814 68.4 分 · 815→816 35.6 分 · 816→817 22.7 分
 * ```
 * ⇒ **一轮从开始到完成经常超过 30 分钟**，于是"正常的长轮次"必然被判成停摆。
 *
 * ## 两个字段各自解决一半
 *
 * | 字段 | 作用 |
 * |---|---|
 * | `stats` | 阈值改成 `max(周期×2, 300 秒, P95(已完成轮次时长) × 2)` —— **跟着真实分布走** |
 * | `pendingAt` | 最新一行是 pending 且**足够新** ⇒ 它明明在跑，**不算停摆** |
 *
 * ⚠️ `pendingAt` 也带年龄上限（由调用方用同一个阈值比）：`finish()` 落库时
 * `ai_latency_ms` 可能**确实是 0**，那种行会永远"看起来 pending"——
 * 一条两小时前的 pending 行必须**继续报警**。
 */
export interface HealthContext {
  /** 某机器人最近轮次时长分布（`api/staleThreshold.ts`）；缺省 = 无样本，退回原判据。 */
  statsByTrader?: ReadonlyMap<number, { samples: number; p95Ms: number | null; maxMs: number | null }>;
  /**
   * 某机器人**最新那一行** `decision_records` 的时间戳（ISO）**当且仅当它是 pending**。
   * 没有 pending 行（或该机器人没有记录）时 absence 即可 —— 不传或 `undefined`。
   */
  pendingAtByTrader?: ReadonlyMap<number, string>;
}

/**
 * **组装 `HealthContext`** —— `/api/health` 与 `manager` 的停摆审计**共用这一个**。
 *
 * ## 为什么抽成一个函数而不是各写一遍
 *
 * 两处必须看到**同一份证据**：控制台的横幅读 `/api/health`，而 `[停摆]` 日志由
 * `manager.auditStaleTraders()` 写 —— 若各自拼一遍，迟早一处算了分布、另一处没算，
 * 于是同一个机器人"在横幅里健康、在日志里停摆"。
 * 这正是 `t99` 里已经付出过一次代价的那类问题（两个真相互相矛盾）。
 *
 * ⚠️ 每一步都**不抛**：这是 `/api/health` 的必经路径，它抛一次就等于把实例判死。
 * 读不到就退回"没有证据"（阈值回到地板），而不是让端点 500。
 */
export function healthContext(now: number = Date.now()): HealthContext {
  const statsByTrader = new Map<number, { samples: number; p95Ms: number | null; maxMs: number | null }>();
  const pendingAtByTrader = new Map<number, string>();
  for (const trader of traders.list()) {
    try {
      statsByTrader.set(trader.id, recentCycleStats(trader.id, now));
    } catch {
      /* 统计读不到 ⇒ 这个机器人退回地板阈值（不会因此不判停摆）。 */
    }
    try {
      const latest = decisions.latestWithPending(trader.id);
      if (latest !== undefined && latest.pending) pendingAtByTrader.set(trader.id, latest.timestamp);
    } catch {
      /* 读不到 pending ⇒ 当作"没有证据"，行为与改动前一致。 */
    }
  }
  return { statsByTrader, pendingAtByTrader };
}

/* -------------------------------------------------------------------------- */
/*  团队岗位出勤：从日志文本里认出"谁干了活"（2026-10-17 · t111）                  */
/* -------------------------------------------------------------------------- */

/**
 * 从一条团队步骤日志里抽出 `{ role, phase, note }`。
 *
 * 形如 `[dispatch] supervisor：派出 4 个分析师并行调研`
 * （由 `manager.ts` 的 `onStep` 写成 `[${phase}] ${role}：${note}`）。
 *
 * 解析不出返回 `null` —— **不猜**。
 *
 * ## ⚠️ 为什么 `role` 段必须限定成 `[a-z][a-z_]*`
 *
 * 角色 id 全是小写下划线（`market_analyst` / `risk_officer`）。
 * 若用 `.+?`，中文也会被吃进去 —— 而 `runtime_logs` 里**另有**一种以 `[` 开头的行：
 * ```
 *   [调研] 新闻未产出：<原因>            ← manager.ts 的猎手日志
 *   [自检/ai] 模型输出未能解析…          ← selfcheckRunner
 * ```
 * 用宽判据会把它们认成"一个叫「新闻未产出」的角色"，然后**点亮编制表上不存在的一行**。
 * 那是凭空造出一次假出勤，比漏报更糟。
 */
export function parseTeamStepLine(
  message: string,
): { phase: string; role: string; note: string } | null {
  const m = /^\[([a-z_]+)\] ([a-z][a-z_]*)[：:]([\s\S]*)$/.exec(message);
  if (m === null) return null;
  /*
   * `note` 去首尾空白：中文冒号写法（`role：note`）本来就没有空格，
   * 而英文冒号写法（`role: note`）会留下一个 —— 那个前导空格到了界面上
   * 会让 `[阶段] 产出` 之间多一个缝。两种写法都该得到同一个形状。
   */
  return { phase: m[1]!, role: m[2]!, note: m[3]!.trim() };
}

/**
 * 从 `cot_trace` 里抽出各角色行的角色名。
 *
 * 形如 `- technical（group/team-grunt）：…`（`agent/deskOutput.ts` 造的格式）。
 *
 * ⚠️ **与前端 `roster.ts` 的 `lastSeenOf` 是同一个正则，但刻意各写一遍**：
 * `@aq/web` 与 `@aq/server` 之间没有依赖方向（谁 import 谁都是错的），
 * 所以没法共用。两边各有一条测试钉住这个格式 —— 改格式时两边都会红。
 */
export function parseCotTraceRoles(trace: string): string[] {
  const roles: string[] = [];
  for (const m of trace.matchAll(/^- ([a-z_]+)（[^）]*）：/gm)) roles.push(m[1]!);
  return roles;
}

/** 一个岗位最近一次被观察到干活的时刻（含来源，便于核对）。 */
export interface RoleLastSeen {
  role: string;
  at: string;
  source: 'log' | 'cot';
}

/**
 * 把两路数据源**合并**成"每个岗位最后一次露面"。
 *
 * ## 为什么要两路（这是 t111 那条用户投诉的根因）
 *
 * ```
 *   cot_trace        → 只有进了 <team> 块的角色：分析师 / bull / bear / judge
 *   runtime_logs     → supervisor / risk_officer / reporter / system_engineer
 * ```
 * 只读前者，那后三个角色在界面上**永远显示"待命"** ——
 * 而线上实测 `supervisor` 在 team 域出现 **31 次**（全系统最多）。
 *
 * ## 合并规则：**取较晚者**，同一时刻偏好 `log`
 *
 * `log` 是服务端直写的出勤证据（精确到步）；`cot` 是渲染进审计块的文本（精确到轮）。
 * 同一时刻时用 `log` 更准确。
 *
 * ⚠️ **不能"log 无条件覆盖 cot"**：`runtime_logs` 表只有 500 行上限，
 * 里面可能混着比 `cot` 更旧的行 —— 无条件覆盖会把"刚刚活跃"改写成"3 天前"，
 * 症状与本次要修的完全一样，只是方向相反。
 *
 * @param logs  `runtime_logs` 里与**这一个机器人**相关的行（调用方负责过滤 traderId/scope）
 * @param cots  `[{ trace, at }]` —— 每条决策记录的 cotTrace 与时刻
 * @param systemEngineerAt 自检行的时刻（自检日志没有角色名，但确实是 `system_engineer` 在干活）。
 *   由调用方从 `scope='selfcheck'` 的行里取最大时刻；`null` = 没有自检记录。
 */
export function mergeRoleLastSeen(
  logs: ReadonlyArray<{ message: string; createdAt: string }>,
  cots: ReadonlyArray<{ trace: string; timestamp: string }>,
  systemEngineerAt: string | null = null,
): RoleLastSeen[] {
  const latest = new Map<string, RoleLastSeen>();
  const bump = (role: string, at: string, source: 'log' | 'cot'): void => {
    const prev = latest.get(role);
    if (prev === undefined || at > prev.at || (at === prev.at && source === 'log')) {
      latest.set(role, { role, at, source });
    }
  };

  for (const line of logs) {
    const step = parseTeamStepLine(line.message);
    if (step !== null) bump(step.role, line.createdAt, 'log');
  }
  if (systemEngineerAt !== null) bump('system_engineer', systemEngineerAt, 'log');

  for (const c of cots) {
    for (const role of parseCotTraceRoles(c.trace)) bump(role, c.timestamp, 'cot');
  }

  return [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export interface TraderHealth {
  traderId: number;
  name: string;
  status: TraderStatus;
  /** 距离上一轮结束的毫秒数；从未跑完过一轮时为 null。 */
  staleForMs: number | null;
  /** 该机器人被判定为卡住。只有 status === 'running' 才可能为 true。 */
  stale: boolean;
  /** 已在运行但还没有任何一轮的完成记录（首轮仍在跑）。 */
  awaitingFirstCycle: boolean;
  /**
   * **"一轮正在进行中"**（2026-10-17 · t114）—— 存在一条**足够新的 pending 行**。
   *
   * `true` 时 `stale` 必然为 `false`：卡住的另一面是"明明在跑"，而
   * 旧判据分不出这两者（`last_cycle_at` 只在一轮**结束时**写）。
   * 详见 `HealthContext` 与 `evaluateTraderHealth` 里那一段。
   */
  cycleInProgress?: boolean;
  /**
   * 这个机器人**这一次**用的停摆阈值（毫秒）—— 让操作员能自己核对
   * "为什么它没被判红"，而不必去读源码。分布驱动之后这个数**因机器人而异**。
   */
  thresholdMs?: number;
}

export interface HealthVerdict {
  /** 所有**正在运行**的机器人都还有心跳。注意它与 HTTP 状态码是同一件事。 */
  ok: boolean;
  /** 只有"运行中且已卡住"的机器人。 */
  stale: TraderHealth[];
  /** 所有机器人（含已停止的），便于控制台一眼看到全貌。 */
  traders: TraderHealth[];
}

/**
 * 从 `traders.last_cycle_at` 推导每个机器人的决策新鲜度。
 *
 * 这个函数存在的理由只有一个：**让健康检查说真话**。
 * 原来 `/api/health` 无条件返回 `ok: true`，而 `deploy/docker-compose.yml` 与
 * `Dockerfile` 的 HEALTHCHECK 都以它为准 —— 于是一个决策循环已经挂死、
 * 或者事件循环被同步 SQLite 阻塞的进程，在编排器看来永远"健康"。
 * 没人会收到告警，容器也不会重启，而账户可能还挂着仓位。
 *
 * 三条必须守住的边界（否则这就是一个比原来更糟的检查）：
 *
 *  1. **只有 `running` 参与判定。** `safe_mode` / `error` 仍在跑循环，但它们的
 *     失败是**已经**通过状态和 `last_error` 上报过的；`stopped` 则根本不跑。
 *     把它们算成"不健康"会让一个被刻意停在原地的机器人在编排器眼里永远是坏的。
 *  2. **`starting` 不参与。** AutoTrader 先写 `starting` 再跑首轮，把它算进去
 *     等于在启动瞬间就判定失败。
 *  3. **阈值有下界（启动宽限），且基于该机器人自己的周期。** 见上面两个常量。
 *
 * 纯函数：只依赖传入的列表和 `now`，所以可以直接单测边界（见 `health.test.ts`）。
 */
export function evaluateTraderHealth(
  traderRows: readonly Pick<
    Trader,
    'id' | 'name' | 'status' | 'lastCycleAt' | 'cycleIntervalMinutes'
  >[],
  now: number,
  /**
   * 每个**正在运行**的机器人是什么时候被启动的。
   *
   * 为什么需要它而不是用进程启动时间：宽限期必须按每个机器人自己的年龄算。
   * 用一个全局的"进程已运行多久"会让运行两小时后才启动的机器人在第一轮
   * 卡死时被宽限整整 2 小时；反过来，如果按"第一次看到 null 的时间"算，
   * 一个永远跑不完第一轮的机器人每次探测都重新获得宽限，**永远不会**被判为
   * 卡住 —— 那正是这个检查要抓的情形。
   *
   * 缺省为空时退化为"用进程启动时间"，只是为了让纯函数好测。
   */
  startedAtByTrader: ReadonlyMap<number, number> = new Map(),
  /**
   * **可选上下文**（2026-10-17 · t114）：分布阈值 + "正在跑"的证据。
   *
   * 不传 = 行为与改动前**逐字节一致**（阈值仍是 `max(周期 × 2, 300 秒)`）——
   * 这让老调用方（测试桩、第三方嵌入）不受影响，也让"放宽"只发生在
   * **真的读到了证据**的地方。见 `HealthContext` 的说明。
   */
  context: HealthContext = {},
): HealthVerdict {
  const traders: TraderHealth[] = traderRows.map((trader) => {
    /*
     * ┌─────────────────────────────────────────────────────────────────────┐
     * │ ⚠️ 阈值：三层取最大（2026-10-17 · t114）                            │
     * ├─────────────────────────────────────────────────────────────────────┤
     * │  周期 × 2      —— 原判据，仍是地板                                  │
     * │  300 秒        —— 起步宽限，仍是地板                                │
     * │  P95 × 2       —— **新增**：跟着该机器人真实分布走（读出样本才有）   │
     * └─────────────────────────────────────────────────────────────────────┘
     * 放宽**只发生在确有长轮次证据的机器人上**：没有样本时退回原来那 30 分钟。
     */
    const thresholdMs = staleThresholdMs({
      cycleIntervalMinutes: trader.cycleIntervalMinutes,
      stats: context.statsByTrader?.get(trader.id) ?? { samples: 0, p95Ms: null, maxMs: null },
      multiplier: STALE_CYCLE_MULTIPLIER,
      floorMs: STARTUP_GRACE_MS,
    });
    const lastCycleMs = trader.lastCycleAt ? new Date(trader.lastCycleAt).getTime() : null;
    const valid = lastCycleMs !== null && Number.isFinite(lastCycleMs);

    // Only a `running` trader is judged. See the boundary list above.
    if (trader.status !== 'running') {
      return {
        traderId: trader.id,
        name: trader.name,
        status: trader.status,
        staleForMs: valid ? now - (lastCycleMs as number) : null,
        stale: false,
        awaitingFirstCycle: false,
        /* 不参与判定的分支也如实报出阈值（控制台用来说明"为什么没判它"）。 */
        thresholdMs,
      };
    }

    /*
     * ⚠️ **`running` 还不够 —— 必须当前进程真的持有它的实例**（外部 issue #119）。
     *
     * `traders.status` 是**持久化状态**，它说的是"这个机器人被标记为运行中"，
     * **不保证**当前进程里真有一个 `AutoTrader` 在转。两类假阳性都由此而来：
     *
     *   1. **演示数据**：`seed:demo` 把 62% 的示例机器人标成 `running`，
     *      而种子脚本**只写库、不起运行时** —— 约 12 分钟后 `/api/health`
     *      从 `ok: true` 翻成 `ok: false` 并**永久保持红色**
     *      （实测另一台实例上 6 个示例机器人的 `staleForMs ≈ 6.8 小时`）。
     *      于是 Docker / compose 的 HEALTHCHECK 判 unhealthy、配上 `restart`
     *      会**反复重启**，而重启修不好它（数据还在库里，12 分钟后再红一次）。
     *   2. **库里残留 `running` 但进程没起**：`GLOBAL_TRADING_DISABLED=true`
     *      或启动失败时的中间窗口同样如此。
     *
     * ## 为什么这个假阳性比没有检查更糟
     *
     * 这个端点的立意是「决策循环挂死时容器必须告警」（本函数头部的边界清单，
     * 还记着 8.5 小时的静默停摆事故）。一个**长期亮着**的假阳性会让运维
     * 对它的告警脱敏 —— **真挂死那次反而没人看**。
     *
     * ## 判据：`startedAtByTrader` 里有它
     *
     * 那张表来自 `manager.runningSince()`，即**当前进程真正持有的实例**。
     * 上游没提供它时（测试桩、第三方嵌入方）退化为"不判定" ——
     * 而不是"把库里所有 `running` 都当成卡住"：后者会在缺能力时误报，
     * 而"误报的检查比没有检查更糟"（同样见头部注释）。
     */
    if (!startedAtByTrader.has(trader.id)) {
      return {
        traderId: trader.id,
        name: trader.name,
        status: trader.status,
        /*
         * 仍然如实报出"库里记的最近一轮是什么时候" —— 控制台要能看到它，
         * 只是**不拿它判红**。
         */
        staleForMs: valid ? now - (lastCycleMs as number) : null,
        stale: false,
        awaitingFirstCycle: false,
        thresholdMs,
      };
    }

    if (!valid) {
      /*
       * Running but no completed cycle is tolerated only for the startup grace
       * period, measured from *this trader's* start. `start()` kicks the first
       * cycle off immediately, so either it finished and wrote the timestamp, or
       * it is wedged.
       *
       * `startedAt` 在这里**必然存在** —— 上面那道守卫已经确认
       * `startedAtByTrader.has(trader.id)`（这是 issue #119 的修复）。
       * 所以不再有 `undefined` 的分支：那曾经让一个"没有实例的 running"
       * 被当成"宽限期内"，从而把演示数据判红。
       */
      const startedAt = startedAtByTrader.get(trader.id)!;
      const runningForMs = now - startedAt;
      return {
        traderId: trader.id,
        name: trader.name,
        status: trader.status,
        staleForMs: runningForMs,
        stale: runningForMs !== null && runningForMs > thresholdMs,
        awaitingFirstCycle: true,
        thresholdMs,
      };
    }

    const staleForMs = now - (lastCycleMs as number);
    /*
     * ══════════════════════════════════════════════════════════════════════
     *  ⭐ **"正在进行的一轮"要能被看见**（2026-10-17 · t114）
     * ══════════════════════════════════════════════════════════════════════
     *
     * `staleForMs` 量的是"距上一轮**结束**"，而一轮正在跑时 `last_cycle_at`
     * 还停在上一次 —— 于是**正在跑**与**卡死**在旧判据下长得一模一样。
     * 唯一的区分线索是 `decision_records` 里那条 **pending 行**
     *（`begin()` 写的 `ai_latency_ms = 0 && error IS NULL && decisions_json` 空）。
     *
     * ## ⚠️ 必须带年龄上限（这一步是"不放过真停摆"的关键）
     *
     * pending 判据在 `finish()` 落库时 `ai_latency_ms` 可能**确实是 0**
     *（模型几乎瞬回）—— 那种行会**永远**"看起来 pending"。
     * 若只看"有没有 pending"，一个真死掉的机器人会**永不报警**。
     *
     * 所以只认**年龄 < 阈值**的 pending：它开始于阈值之内 ⇒ 这一轮确实在进行中；
     * 一条 2 小时前的 pending 行说明进程在那一轮里就没了 ⇒ **照常判红**。
     */
    const pendingAt = context.pendingAtByTrader?.get(trader.id);
    const pendingMs = pendingAt === undefined ? null : new Date(pendingAt).getTime();
    const cycleInProgress =
      pendingMs !== null && Number.isFinite(pendingMs) && now - pendingMs < thresholdMs;

    return {
      traderId: trader.id,
      name: trader.name,
      status: trader.status,
      staleForMs,
      stale: !cycleInProgress && staleForMs > thresholdMs,
      awaitingFirstCycle: false,
      /*
       * 让控制台能说清"它是在跑还是卡住了" —— 这正是本批反复出现的
       * 「信号在没人看的地方」的反面：**同一个判据，把区分依据一起报出去**。
       */
      cycleInProgress,
      thresholdMs,
    };
  });

  const stale = traders.filter((t) => t.stale);
  return { ok: stale.length === 0, stale, traders };
}

/**
 * 给团队模式取一个**真实存在**的 `aiModelId` 当占位。
 *
 * ## 为什么需要它（本地实测踩到的坑）
 *
 * `traders.ai_model_id` 是 `NOT NULL` + 外键，而团队模式**不使用**这个字段
 *（它的模型出口是独立的 magpie 网关配置，见 `teamGateway.ts`）。
 * 所以需要写一个"满足外键、但没人读"的值。
 *
 * 第一版硬编码成 `1`，假设"建表时必然有 id=1 的模型"。**那个假设不成立**：
 * 本地库里模型 id 是 `4/5/8/9`（没有 1），于是建团队机器人直接
 * `FOREIGN KEY constraint failed` —— 而那个错误完全指不到真正的原因
 *（看起来像"外键配置错了"，实际是"占位值选错了"）。
 *
 * ## 行为
 *
 * · 有模型 → 优先返回**已经存了 API Key 的那一条**；都没有 key 才退回第一条；
 * · 一条都没有 → 抛**说人话**的错误，而不是让外键去报。
 *
 * ## ⚠️ 为什么优先挑"有 key"的那条（2026-11-10 走查发现）
 *
 * 团队模式**不读**这个字段（模型出口是 magpie 网关），但 `startTrader` 的
 * 通用预检会校验它指向的模型**有没有存储 API Key**。取"第一条"时，如果第一条
 * 恰好是示例/占位模型（没有 key），团队机器人就会在启动时被拒：
 *
 *     AI 模型「[示例] Claude Opus」还没有存储 API Key
 *
 * 而这条错误指向的是"模型 key"，与团队模式毫无关系 —— 排查成本极高。
 */
export function requireAnyModelIdForGateway(): number {
  const all = aiModels.list();
  if (all.length === 0) {
    /*
     * 全新库还没有任何 AI 模型记录时，为走系统 magpie 网关的模式自动写入一条占位记录，
     * 满足 traders.ai_model_id 的外键约束，不再阻断直接新建智能托管 / JEV / 团队机器人。
     */
    const seeded = aiModels.create({
      provider: 'custom',
      label: 'magpie（系统预设）',
      model: AI_MANAGED_PRESET_MODEL,
      baseUrl: DEFAULT_MAGPIE_URL,
      apiKeyEnc: '',
      temperature: 0.2,
      maxTokens: 65536,
      timeoutSeconds: 600,
      maxRetries: 2,
    });
    return seeded.id;
  }
  const presetMatch = all.find((model) => model.model === AI_MANAGED_PRESET_MODEL);
  if (presetMatch) return presetMatch.id;
  const withKey = all.find((model) => (aiModels.getWithSecret(model.id)?.api_key_enc ?? '').length > 0);
  return (withKey ?? all[0]!).id;
}

