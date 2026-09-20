/**
 * 编排层端口的真实实现（SQLite + 仓库）。
 *
 * ## 这一层的全部意义
 *
 * `orchestrator.ts` 只认端口，不认数据库。这个文件是**唯一**把端口接到
 * 真实存储上的地方 —— 于是"流程对不对"与"数据接得对不对"是两件事，
 * 前者用桩测（`orchestrator.test.ts`），后者在这里测。
 *
 * ## 算事实（facts）时的两个坑
 *
 * 1. **时间戳一律转 epoch 再比。** 库里存的是 UTC ISO，服务器是 CST ——
 *    本会话已经因为跨格式、跨时区比较各错过一次（读出"8 分钟新增 769 条"
 *    这种不可能的数字、以及误判周期停了）。所以这里不写字符串比较。
 * 2. **"上次唤醒"的时间要落库。** 不能放在内存里：进程重启一次，
 *    冷却与兜底判据就全部归零，大脑会被立刻唤醒一次 —— 那正是抖动。
 */

import type { StrategyConfig } from '@aq/shared';

import { checkCircuitBreakers } from '../../risk/engine.js';
import { agentExperiments, agentMemory, agentRuns } from '../../store/agentStore.js';
import { decisions, equity, positions, runtimeLogs, settings, traders, trades } from '../../store/repositories.js';
import type { OrchestratorPorts } from './orchestrator.js';
import type { WakeFacts } from './wake.js';
import { readAgentConfig } from './config.js';

/** "上次唤醒"落库用的键。 */
const lastWakeKey = (traderId: number) => `agent_last_wake:${traderId}`;
/** 暂停标记落库用的键。 */
const pausedKey = (traderId: number) => `agent_paused:${traderId}`;

/* -------------------------------------------------------------------------- */
/*  时间                                                                       */
/* -------------------------------------------------------------------------- */

/** 一律用 epoch 毫秒比较。**不要在这之外写时间字符串比较。** */
const ms = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
};

/**
 * 距今多少分钟。**没有记录时返回"很久以前"而不是 0。**
 *
 * 这个方向的取舍很重要：0 会让兜底判据以为"刚刚醒过"从而永远不醒，
 * 而实际上它**从来没醒过**。宁可多醒一次，也不要一个永远不审视的账户。
 */
const NEVER = 999_999;
const minutesSince = (fromIso: string | null, nowMs: number): number =>
  fromIso ? Math.max(0, (nowMs - ms(fromIso)) / 60_000) : NEVER;

/* -------------------------------------------------------------------------- */
/*  端口工厂                                                                   */
/* -------------------------------------------------------------------------- */

export interface AgentPortDeps {
  traderId: number;
  /** 当前策略里的配置 —— AI 模式还没写入过配置时的基准。 */
  strategyConfig: () => StrategyConfig;
  /** 本小时的调用预算。 */
  hourlyBudget: number;
}

/**
 * 造一份真实端口。
 *
 * 所有读都走仓库（§5.4：SQL 只在 store 层），这个文件里不出现任何 SQL。
 */
export function makeAgentPorts(deps: AgentPortDeps): OrchestratorPorts {
  const { traderId } = deps;

  /**
   * AI 模式下的配置；没有就回落到策略配置。
   *
   * ⚠️ 走共用的 `readAgentConfig`（**过 zod**），不要在这里 `JSON.parse(...) as`。
   * 断言式读取会让将来新增的、带默认值的安全字段在老配置里读成 `undefined`，
   * 而 `x > 0` 形式的判据随之静默变成 false —— 那等于把那条风控关掉，且不报错。
   * 详见 `config.ts` 顶部。
   */
  const readConfig = (): StrategyConfig =>
    readAgentConfig(traderId, deps.strategyConfig()) ?? deps.strategyConfig();

  return {
    readConfig,

    saveConfig: (config) => {
      // AI 模式靠"这一列非空"来判定，所以这里必须真的写进去。
      traders.setAgentConfig(traderId, JSON.stringify(config));
    },

    toolReads: {
      performance: (window) => {
        const now = Date.now();
        const span =
          window === '24h' ? 86_400_000 : window === '7d' ? 7 * 86_400_000 : window === '30d' ? 30 * 86_400_000 : 0;
        const since = span > 0 ? new Date(now - span).toISOString() : new Date(0).toISOString();
        const rows = trades.list(traderId, 200).filter((t) => ms(t.closedAt) >= ms(since));
        const gross = rows.reduce((s, t) => s + t.pnl, 0);
        const fees = rows.reduce((s, t) => s + t.fee, 0);
        const net = rows.reduce((s, t) => s + t.netPnl, 0);
        const wins = rows.filter((t) => t.netPnl > 0);
        const losses = rows.filter((t) => t.netPnl <= 0);
        const avg = (xs: typeof rows) => (xs.length > 0 ? xs.reduce((s, t) => s + t.netPnl, 0) / xs.length : null);
        return {
          window,
          trades: rows.length,
          grossPnl: gross,
          fees,
          netPnl: net,
          winRatePercent: rows.length > 0 ? (wins.length / rows.length) * 100 : null,
          avgWin: avg(wins),
          avgLoss: avg(losses),
          feeToGrossRatio: Math.abs(gross) > 1e-9 ? fees / Math.abs(gross) : null,
          // 少于 30 笔无法区分"策略有效"与"运气好" —— 让模型自己看到这一点。
          sampleAdequate: rows.length >= 30,
        };
      },

      equityCurve: (limit) =>
        equity.list(traderId, limit).map((s) => ({
          at: s.timestamp,
          equity: s.equity,
          accountEquity: s.accountEquity,
        })),

      /*
       * ⚠️ **散记录不够，还要给出"同一个参数改过几次、合计效果如何"。**
       *
       * 实测的形状：`agent_experiments` 里 `minPositionSize` 被连着改了五次
       * （12→6→6→5.5→5.1），每次理由都是同一句"账户太小、门槛不可达"——
       * **而每次结算的结果都是负的**。
       *
       * 那五条记录一直都在 `get_experiments` 的返回里，只是散在十几条别的改动中间。
       * 要看出"我在原地打转"，得先把它们数出来 —— 而**数这件事该由程序做**，
       * 不该指望模型每次自己从一列散记录里翻。
       *
       * 这与 `get_lessons` 的 `recurringTags` 是同一条思路：单条说的是"这一次"，
       * 聚合说的是"我一直在同一个地方"。
       */
      experiments: (limit) => {
        const rows = agentExperiments.recent(traderId, limit);

        const perField = new Map<
          string,
          { times: number; settled: number; netPnl: number; pending: number }
        >();
        for (const row of rows) {
          for (const field of leafPaths(safeJson(row.patchJson))) {
            const agg = perField.get(field) ?? { times: 0, settled: 0, netPnl: 0, pending: 0 };
            agg.times += 1;
            if (row.outcomeNetPnl === null) agg.pending += 1;
            else {
              agg.settled += 1;
              agg.netPnl += row.outcomeNetPnl;
            }
            perField.set(field, agg);
          }
        }

        return {
          /*
           * ⚠️ **顺序是有意的：`repeatedFields` 必须在 `recent` 之前。**
           *
           * `bound()` 截断时**只保留前 N 个字符**（`preview: text.slice(0, MAX_JSON_CHARS)`），
           * 而 `recent` 每一条都带着完整的 `asked` / `applied` 补丁 JSON —— 十几条就能
           * 吃满预算。第一版把聚合放在 `recent` 后面，于是**最该被看到的那一项正好
           * 落在截断线之外**。
           *
           * 实测代价（真实运行 #121 里模型自己的话）：
           *
           *   「get_experiments 被截断，没看到 repeatedFields（提示词明确要求看它）；
           *     再看最近决策的被拒率。**用最小 limit 避开截断**。」
           *
           * —— 它为此**多花了一轮工具调用**去重读，而那一轮的预算本来就不够用
           * （它最后正是死在"剩余预算不足以再读一类新信息"上）。
           *
           * 一条被自己撑爆的返回，等于没给。
           */
          repeatedFields: [...perField.entries()]
            .filter(([, agg]) => agg.times >= 2)
            .sort((a, b) => b[1].times - a[1].times)
            .map(([field, agg]) => ({
              field,
              times: agg.times,
              settled: agg.settled,
              pending: agg.pending,
              netPnlSince: Math.round(agg.netPnl * 10_000) / 10_000,
            })),
          recent: rows.map((e) => ({
            at: e.createdAt,
            trigger: e.trigger,
            reason: e.reason,
            // 想让改什么、实际生效什么 —— 两者不同时必须看得出来
            asked: safeJson(e.patchJson),
            applied: safeJson(e.appliedJson),
            clamps: safeJson(e.clampsJson),
            // ⚠️ 这三个决定"它能不能学到东西"。null 表示还没结算。
            outcomeTrades: e.outcomeTrades,
            outcomeNetPnl: e.outcomeNetPnl,
          })),
        };
      },

      lessons: (limit) => {
        const rows = agentMemory.recent(traderId, limit);
        const tagCounts = new Map<string, number>();
        for (const row of rows) {
          for (const tag of tagsOf(row.tagsJson)) {
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        }
        return {
          total: agentMemory.count(traderId),
          shown: rows.length,
          /*
           * ⚠️ **这一行是整条闭环里最要紧的。**
           *
           * 单条 `lesson` 说的是"这一笔为什么亏"；而**反复出现的标签**说的是
           * "我一直在这个地方亏" —— 后者才是可行动的诊断。
           */
          recurringTags: [...tagCounts.entries()]
            .filter(([, n]) => n >= 2)
            .sort((a, b) => b[1] - a[1])
            .map(([tag, n]) => `${tag} ×${n}`),
          recent: rows.map((row) => ({
            at: row.createdAt,
            symbol: row.symbol,
            closeReason: row.closeReason,
            netPnl: row.netPnl,
            tags: tagsOf(row.tagsJson),
            // lesson 里含"它没能确定什么、为什么" —— 那是判断的边界，不是套话
            lesson: row.lesson,
          })),
        };
      },

      recentDecisions: (limit) =>
        decisions.list(traderId, limit).map((d) => ({
          cycle: d.cycleNumber,
          at: d.timestamp,
          success: d.success,
          error: d.error,
          decisions: d.decisions.map((x) => ({ symbol: x.symbol, action: x.action })),
          // 被风控拒绝/跳过/失败 —— 这是"参数与市场脱节"的证据
          rejected: d.executionLog
            .filter((e) => e.status !== 'ok')
            .map((e) => ({ symbol: e.symbol, status: e.status, detail: e.detail })),
        })),

      marketOverview: (limit) => {
        const open = positions.open(traderId);
        return {
          heldSymbols: open.map((p) => p.symbol),
          openPositions: open.length,
          note: `当前持仓 ${open.length} 个。候选池的实时行情由交易循环注入，这里只给结构。`,
          requested: limit,
        };
      },
    },

    collectFacts: (): Omit<WakeFacts, 'callsThisHour'> => {
      const now = Date.now();
      const lastWakeIso = settings.get(lastWakeKey(traderId)) ?? null;
      const lastReviewIso = settings.get(`agent_last_review:${traderId}`) ?? null;

      const since = ms(lastWakeIso);
      const recent = trades.list(traderId, 50);
      const sinceWake = recent.filter((t) => ms(t.closedAt) > since);

      // 从最近一笔往前数连亏
      let losingStreak = 0;
      for (const t of recent) {
        if (t.netPnl <= 0) losingStreak += 1;
        else break;
      }

      const latest = equity.latest(traderId);
      const baseline = Number(settings.get(`agent_equity_baseline:${traderId}`) ?? '');
      const equityDriftPercent =
        latest && Number.isFinite(baseline) && baseline > 0
          ? ((latest.equity - baseline) / baseline) * 100
          : 0;

      return {
        /*
         * 没有"上次唤醒"记录时给一个**很大但不是 Infinity** 的值。
         *
         * 语义是"从来没醒过 → 现在就该醒"。用 Infinity 也能触发兜底，
         * 但它会在序列化与算术里变成奇怪的形状；用一个明确的大数更清楚。
         */
        minutesSinceLastWake: minutesSince(lastWakeIso, now),
        newClosedTrades: sinceWake.length,
        netPnlSinceLastWake: sinceWake.reduce((s, t) => s + t.netPnl, 0),
        losingStreak,
        equityDriftPercent,
        // 被风控拒绝的次数：从决策记录的 executionLog 里数，而不是另存一个计数器 ——
        // 计数器会与实际记录不一致，而那个不一致没人会发现。
        rejectionsSinceLastWake: decisions
          .list(traderId, 30)
          .filter((d) => ms(d.timestamp) > since)
          .reduce((n, d) => n + d.executionLog.filter((e) => e.status !== 'ok').length, 0),
        lastDecisionWasNoChange: false,
        hasPosition: positions.open(traderId).length > 0,
        minutesSinceStrategyReview: minutesSince(lastReviewIso, now),
        /*
         * 自上次唤醒以来跑了多少个周期。用来发现"参数不可达"那种静默失效 ——
         * 见 `WakeFacts.idleCycles` 的注释。
         */
        idleCycles: decisions
          .list(traderId, 60)
          .filter((d) => ms(d.timestamp) > since).length,
        /*
         * 熔断是否正在挡住开仓 —— 见 `WakeFacts.breakerBlocked`。
         *
         * ⚠️ **这里自己算，而不是去问 `AutoTrader`。** `ports` 是 runtime 的依赖，
         * 而 runtime 又是 `AutoTrader` 的依赖 —— 反向引用会成环。代价是两趟查询
         * （今日已实现盈亏、历史高水位），但这个函数**每个周期只调一次**，
         * 而且它本来就在做十几趟查询。
         *
         * 配置取 `readConfig()`（AI 托管下是 `agent_config_json`），
         * 与交易循环用的必须是**同一份** —— 否则会出现"审视说没熔断、交易循环却在跳过"。
         */
        breakerBlocked: checkCircuitBreakers(readConfig(), latest?.accountEquity ?? 0, {
          dailyRealizedPnl: trades.realizedPnlToday(traderId),
          highWaterEquity: equity.realizedHighWaterMark(traderId),
        }).blocked,
      };
    },

    callsThisHour: () => agentRuns.countSince(traderId, new Date(Date.now() - 3_600_000).toISOString()),

    pendingExperiments: () =>
      agentExperiments.pending(traderId).map((e) => {
        /*
         * 只数**严格晚于**那次调整的成交。
         *
         * `>` 而不是 `>=` 是刻意的，方向很要紧：与调整同一毫秒平掉的仓
         * 归属是**有歧义**的。少数（用 `>`）只会让结算延后 —— 安全；
         * 多数（用 `>=`）可能把一个"调整之前就平掉的仓"算成调整的后果，
         * 那会让 `outcome_net_pnl` 里混进与这次改动无关的盈亏，
         * 而策略师会照着它学。
         *
         * 同一毫秒的平局在本会话里已经害过一次（`equity.list()` 的
         * `ORDER BY timestamp DESC` 返回了最旧那行，约 1/8 的运行读到错的权益）。
         * 那次是修 bug，这次是**选对方向**。
         */
        const after = trades.list(traderId, 200).filter((t) => ms(t.closedAt) > ms(e.createdAt));
        return {
          id: e.id,
          createdAt: e.createdAt,
          tradesSince: after.length,
          netPnlSince: after.reduce((s, t) => s + t.netPnl, 0),
        };
      }),

    settleExperiment: (id, outcome) => agentExperiments.settle(id, outcome),

    recordExperiment: (row) =>
      void agentExperiments.insert({
        traderId,
        trigger: row.trigger,
        observed: row.observed,
        patch: row.patch,
        applied: row.applied,
        clamps: row.clamps,
        reason: row.reason,
        toolCalls: row.toolCalls,
      }),

    recordRun: (row) =>
      void agentRuns.insert({
        traderId,
        kind: row.kind,
        trigger: row.trigger,
        intensity: row.intensity,
        steps: row.result.steps.length,
        agents: row.result.steps.map((s) => ({ step: s.step, tool: s.tool, thought: s.thought })),
        outcome: row.result.outcome,
        detail: row.result.detail,
        tokensIn: row.result.tokensIn,
        tokensOut: row.result.tokensOut,
        latencyMs: row.result.latencyMs,
      }),

    /*
     * 暂停是**落库**的，不是内存标志。
     *
     * 内存标志在进程重启后会消失 —— 一个"因为亏太多而主动停手"的决定，
     * 不该被一次重启悄悄撤销。
     */
    requestPause: (reason) => {
      settings.set(pausedKey(traderId), JSON.stringify({ at: new Date().toISOString(), reason }));
    },

    /*
     * AI 改自己的决策周期。
     *
     * ## 它为什么不是 `saveConfig` 的一部分
     *
     * 决策周期不活在 `StrategyConfig` 里 —— 它是 `traders` 表上的一列。
     * 理由是调度器要在**配置之外**读它：一轮跑完之后要重新排下一次，
     * 而那一刻手里不一定有策略配置对象。
     *
     * ## 上下限由服务端强制，不信模型报上来的数
     *
     * `1–1440` 必须与 `CreateTraderSchema` 里的约束**保持一致** ——
     * 两处各写一个范围迟早会分叉，而分叉那天没人会发现：
     * AI 在提示词里读到"1–1440"，实际却被另一个更窄的约束默默钳掉。
     *
     * **钳制而不是拒绝**：一个 0.5 分钟的请求变成 1 分钟，比整条工具调用失败有用
     * —— 但必须**回喂实际值**，否则下一轮它会基于错误前提推理。
     */
    setCycleInterval: (minutes, reason) => {
      const requested = Number.isFinite(minutes) ? Math.round(minutes) : 15;
      const clamped = Math.min(1440, Math.max(1, requested));
      const wasClamped = clamped !== requested;

      traders.update(traderId, { cycleIntervalMinutes: clamped });
      runtimeLogs.write(
        traderId,
        'info',
        'agent',
        `AI 把决策周期改为每 ${clamped} 分钟一次` +
          (wasClamped ? `（请求 ${requested}，被限制在 1–1440）` : '') +
          `：${reason}`,
      );

      return { minutes: clamped, clamped: wasClamped };
    },

    /*
     * 读当前的决策周期。
     *
     * `get_current_params` 要把它一起给 AI —— **不知道起点就没法判断该往哪边调**。
     * 读不到时退回 15（schema 的默认值），而不是 0：0 会让 AI 以为
     * "我从不醒来"，而那是错的。
     */
    cycleInterval: () => {
      const row = traders.get(traderId);
      const value = row?.cycleIntervalMinutes;
      return Number.isFinite(value) && (value as number) > 0 ? (value as number) : 15;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  辅助                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 把嵌套的 patch 摊平成**叶子路径**（`riskControl.minPositionSize`）。
 *
 * 只摊平普通对象：**数组与 `null` 都当成叶子** —— `emaPeriods.0` 这种带下标的
 * 路径对模型没有价值，而"`indicators.emaPeriods` 改过 3 次"才是它想问的问题。
 *
 * 摊平是必要的：`patch` 是嵌套的（`{riskControl:{minPositionSize:6}}`），
 * 不摊平的话 `riskControl` 这一层会把**所有**风险参数的改动混成一个计数，
 * 而那正好掩盖了"反复改的是哪一项"。
 */
export function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(...leafPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

/** 行里存的是 JSON 文本；坏了就返回原始文本，而不是抛错让整条流程失败。 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * `agent_memory.tags_json` → 干净的字符串数组。
 *
 * 坏数据（不是 JSON、不是数组、数组里有非字符串）一律**当作没有标签**，
 * 而不是让整个工具失败：一份格式有问题的记忆，不该让 AI 读不到其余的。
 */
function tagsOf(raw: string): string[] {
  const parsed = safeJson(raw);
  return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
}

/** 记下"这一轮唤醒了"。冷却与兜底判据都依赖它，所以必须落库。 */
export function markWoken(traderId: number, equityNow: number | null): void {
  settings.set(lastWakeKey(traderId), new Date().toISOString());
  if (equityNow !== null && Number.isFinite(equityNow)) {
    settings.set(`agent_equity_baseline:${traderId}`, String(equityNow));
  }
}

/** 记下"这一轮做了策略审视"。强度选择依赖它。 */
export function markStrategyReview(traderId: number): void {
  settings.set(`agent_last_review:${traderId}`, new Date().toISOString());
}

/** 读取暂停状态。 */
export function readPause(traderId: number): { at: string; reason: string } | null {
  const raw = settings.get(pausedKey(traderId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { at: string; reason: string };
  } catch {
    return null;
  }
}

/** 清除暂停（由操作员决定恢复，模型没有这个工具）。 */
export function clearPause(traderId: number): void {
  settings.set(pausedKey(traderId), '');
}

/** 复盘写入记忆。 */
export function saveMemory(
  traderId: number,
  memory: { symbol: string; closeReason: string; netPnl: number; lesson: string; tags: string[] },
  tradeId: number,
): boolean {
  return agentMemory.insert({
    traderId,
    tradeId,
    symbol: memory.symbol,
    closeReason: memory.closeReason,
    netPnl: memory.netPnl,
    lesson: memory.lesson,
    tags: memory.tags,
  });
}
