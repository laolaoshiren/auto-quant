/**
 * 全自动智能托管（AI Agent 模式）的三张表。
 *
 * ## 为什么单独一个文件而不是塞进 `repositories.ts`
 *
 * `repositories.ts` 已经 2400+ 行。这个模式的存储访问是一个**自洽的单元**
 * （三张表、九种访问、没有别处依赖），放一起会让那个文件更难导航。
 * 规矩没变：**SQL 只出现在 store 层**，业务代码不直接碰数据库。
 *
 * ## 这三张表在整体里的位置
 *
 * 它们是「越跑越厉害」的**唯一落地处**：
 *
 *  - `agent_experiments` —— 我改了什么 + **之后真实发生了什么**
 *  - `agent_memory`      —— 这笔为什么赚/亏（前车之鉴）
 *  - `agent_runs`        —— 每次循环的完整轨迹（可审计）
 *
 * 没有它们，"AI 自我迭代"只是一段听起来很专业的文字。
 */

import { getDb } from '../db/index.js';

/* -------------------------------------------------------------------------- */
/*  行类型                                                                     */
/* -------------------------------------------------------------------------- */

export interface AgentExperimentRow {
  id: number;
  traderId: number;
  createdAt: string;
  trigger: string;
  observedJson: string;
  patchJson: string;
  appliedJson: string;
  clampsJson: string;
  reason: string;
  toolCallsJson: string;
  /** 回填前是 null。 */
  outcomeTrades: number | null;
  outcomeNetPnl: number | null;
  outcomeEvaluatedAt: string | null;
}

export interface AgentMemoryRow {
  id: number;
  traderId: number;
  tradeId: number;
  createdAt: string;
  symbol: string;
  closeReason: string;
  netPnl: number;
  lesson: string;
  tagsJson: string;
}

export interface AgentRunRow {
  id: number;
  traderId: number;
  createdAt: string;
  kind: string;
  trigger: string;
  intensity: string;
  steps: number;
  agentsJson: string;
  outcome: string;
  detail: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

/* -------------------------------------------------------------------------- */
/*  行映射                                                                     */
/* -------------------------------------------------------------------------- */

interface RawExperiment {
  id: number;
  trader_id: number;
  created_at: string;
  trigger: string;
  observed_json: string;
  patch_json: string;
  applied_json: string;
  clamps_json: string;
  reason: string;
  tool_calls_json: string;
  outcome_trades: number | null;
  outcome_net_pnl: number | null;
  outcome_evaluated_at: string | null;
}

interface RawMemory {
  id: number;
  trader_id: number;
  trade_id: number;
  created_at: string;
  symbol: string;
  close_reason: string;
  net_pnl: number;
  lesson: string;
  tags_json: string;
}

interface RawRun {
  id: number;
  trader_id: number;
  created_at: string;
  kind: string;
  trigger: string;
  intensity: string;
  steps: number;
  agents_json: string;
  outcome: string;
  detail: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
}

const toExperiment = (r: RawExperiment): AgentExperimentRow => ({
  id: r.id,
  traderId: r.trader_id,
  createdAt: r.created_at,
  trigger: r.trigger,
  observedJson: r.observed_json,
  patchJson: r.patch_json,
  appliedJson: r.applied_json,
  clampsJson: r.clamps_json,
  reason: r.reason,
  toolCallsJson: r.tool_calls_json,
  outcomeTrades: r.outcome_trades,
  outcomeNetPnl: r.outcome_net_pnl,
  outcomeEvaluatedAt: r.outcome_evaluated_at,
});

const toMemory = (r: RawMemory): AgentMemoryRow => ({
  id: r.id,
  traderId: r.trader_id,
  tradeId: r.trade_id,
  createdAt: r.created_at,
  symbol: r.symbol,
  closeReason: r.close_reason,
  netPnl: r.net_pnl,
  lesson: r.lesson,
  tagsJson: r.tags_json,
});

const toRun = (r: RawRun): AgentRunRow => ({
  id: r.id,
  traderId: r.trader_id,
  createdAt: r.created_at,
  kind: r.kind,
  trigger: r.trigger,
  intensity: r.intensity,
  steps: r.steps,
  agentsJson: r.agents_json,
  outcome: r.outcome,
  detail: r.detail,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  latencyMs: r.latency_ms,
});

/* -------------------------------------------------------------------------- */
/*  增长上界                                                                    */
/* -------------------------------------------------------------------------- */
/*
 * ## 为什么这三张表必须有上限
 *
 * 仓库自己定的契约（`retention.test.ts` 顶部）：**凡是交易循环写入的表都必须有界，
 * 而且裁剪不能发生在每行的写入路径上**。已实现的两张是 `runtime_logs`（按条数封顶）
 * 与 `trade_events`（按时间保留 + 阈值触发）。
 *
 * 而这三张 agent 表漏了 —— 它们是"AI 托管越跑越厉害"的落地处，写入频率却和
 * 交易量同阶：
 *
 *   · `agent_memory`     每平一笔仓一行
 *   · `agent_runs`       每次审视一行
 *   · `agent_experiments` 每次调参一行，**且每行含整份 StrategyConfig（约 2KB）**
 *
 * 一台跑几个月的机器人会攒下几万行，其中 `agent_experiments` 是空间上的大头。
 * 而读它们的地方全都是"最近 N 条"（`recent` / `forSymbol` / `get_experiments`），
 * 没有任何一处需要全集 —— 所以裁剪不会丢任何被读的信息。
 *
 * ## 为什么按条数而不是按时间
 *
 * 这三张表的价值密度与**交易活动**相关，不是与自然时间相关：一个停了两周的机器人
 * 不该因为"太老"而丢掉它最后一次实验的结果。按条数保留"最近 N 次"才对应
 * "我还记得最近发生过什么"这个真实需求。
 *
 * ## ⚠️ 未结算的实验永远不裁
 *
 * `agent_experiments` 的结算要等结果（5 笔或 24 小时）。一条**还没结算**的记录
 * 被裁掉，就意味着那笔调参的因果永远对不上 —— 而这正是"越跑越厉害"的机制本身。
 * 所以裁剪只作用于 `outcome_evaluated_at IS NOT NULL` 的行，并且**上限只对已结算的
 * 那些计数**。未结算的行数天然很小（同一时刻至多几条），不需要额外封顶。
 */
export const AGENT_MEMORY_CAP = 500;
export const AGENT_RUNS_CAP = 500;
export const AGENT_EXPERIMENTS_CAP = 200;

/**
 * 每写这么多行裁一次。
 *
 * 与 `runtime_logs` 同样的理由：`node:sqlite` 是**同步**的，裁剪会阻塞事件循环 ——
 * 而事件循环正是跑交易周期的那个。所以绝不能在每行写入时裁（那一版真的发生过：
 * 一个周期里几十次全表 DELETE）。
 *
 * ⚠️ 它同时决定**真实上界** = `CAP + TRIM_EVERY_WRITES`：最后一批未满的行会留着。
 * 导出是为了让测试断言真实的上界，而不是一个达不到的理想值 —— `runtime_logs`
 * 的注释里写的是同一个道理（"表的上界变成 CAP + TRIM_EVERY = 700 行"）。
 */
export const TRIM_EVERY_WRITES = 100;
let writesSinceTrim = 0;

/** 把三张表压回各自的上限。写路径按批次调用，不是每行调用。 */
export function trimAgentTables(): void {
  const db = getDb();
  db.run(
    `DELETE FROM agent_memory
      WHERE id NOT IN (SELECT id FROM agent_memory ORDER BY id DESC LIMIT ${AGENT_MEMORY_CAP})`,
  );
  db.run(
    `DELETE FROM agent_runs
      WHERE id NOT IN (SELECT id FROM agent_runs ORDER BY id DESC LIMIT ${AGENT_RUNS_CAP})`,
  );
  /* 只裁已结算的 —— 未结算的带着"待回填"的语义，见上面那段。 */
  db.run(
    `DELETE FROM agent_experiments
      WHERE outcome_evaluated_at IS NOT NULL
        AND id NOT IN (
          SELECT id FROM agent_experiments
           WHERE outcome_evaluated_at IS NOT NULL
           ORDER BY id DESC LIMIT ${AGENT_EXPERIMENTS_CAP}
        )`,
  );
}

/** 写路径按批次触发裁剪。 */
function noteAgentWrite(): void {
  writesSinceTrim += 1;
  if (writesSinceTrim >= TRIM_EVERY_WRITES) {
    writesSinceTrim = 0;
    trimAgentTables();
  }
}

/* -------------------------------------------------------------------------- */
/*  实验（策略层的记忆：我改了什么 + 之后真实结果）                             */
/* -------------------------------------------------------------------------- */

export const agentExperiments = {
  /**
   * 记一次调参。
   *
   * `patchJson` 与 `appliedJson` **分开存**：守卫钳制了而 AI 以为自己改成了的话，
   * 下一轮它会基于错误前提继续推理。两者不同必须一眼可见。
   */
  insert(input: {
    traderId: number;
    trigger: string;
    observed: unknown;
    patch: unknown;
    applied: unknown;
    clamps: unknown;
    reason: string;
    toolCalls: unknown;
  }): number {
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO agent_experiments (
         trader_id, created_at, trigger, observed_json, patch_json, applied_json,
         clamps_json, reason, tool_calls_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      new Date().toISOString(),
      input.trigger,
      JSON.stringify(input.observed ?? null),
      JSON.stringify(input.patch ?? null),
      JSON.stringify(input.applied ?? null),
      JSON.stringify(input.clamps ?? []),
      input.reason,
      JSON.stringify(input.toolCalls ?? []),
    );
    noteAgentWrite();
    return Number(lastInsertRowid);
  },

  /** 最近若干次调参（含结果），喂给策略师。 */
  recent(traderId: number, limit = 10): AgentExperimentRow[] {
    return getDb()
      .all<RawExperiment>(
        'SELECT * FROM agent_experiments WHERE trader_id = ? ORDER BY id DESC LIMIT ?',
        traderId,
        limit,
      )
      .map(toExperiment);
  },

  /** 还没结算的那些 —— 回填扫描用。 */
  pending(traderId: number): AgentExperimentRow[] {
    return getDb()
      .all<RawExperiment>(
        'SELECT * FROM agent_experiments WHERE trader_id = ? AND outcome_evaluated_at IS NULL ORDER BY id ASC',
        traderId,
      )
      .map(toExperiment);
  },

  /**
   * 回填"这次调整之后真实发生了什么"。
   *
   * **这是「越跑越厉害」的关键一步**：没有它，AI 只知道自己改过什么，
   * 不知道改动是否有效 —— 那样的"反思"没有事实可依。
   */
  settle(id: number, outcome: { trades: number; netPnl: number }): void {
    getDb().run(
      `UPDATE agent_experiments
       SET outcome_trades = ?, outcome_net_pnl = ?, outcome_evaluated_at = ?
       WHERE id = ?`,
      outcome.trades,
      outcome.netPnl,
      new Date().toISOString(),
      id,
    );
  },
};

/* -------------------------------------------------------------------------- */
/*  记忆（执行层的记忆：这笔为什么赚/亏）                                       */
/* -------------------------------------------------------------------------- */

export const agentMemory = {
  /**
   * 记一条复盘结论。
   *
   * `trade_id` 上有 UNIQUE —— 重复对账不会写出两条互相矛盾的经验。
   * 已存在时**静默跳过**（幂等），而不是抛错：复盘是附加动作，
   * 不该因为它自己重复就把周期搞失败。
   */
  insert(input: {
    traderId: number;
    tradeId: number;
    symbol: string;
    closeReason: string;
    netPnl: number;
    lesson: string;
    tags: string[];
  }): boolean {
    const existing = getDb().get<{ id: number }>(
      'SELECT id FROM agent_memory WHERE trade_id = ?',
      input.tradeId,
    );
    if (existing) return false;
    getDb().run(
      `INSERT INTO agent_memory (
         trader_id, trade_id, created_at, symbol, close_reason, net_pnl, lesson, tags_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.tradeId,
      new Date().toISOString(),
      input.symbol,
      input.closeReason,
      input.netPnl,
      input.lesson,
      JSON.stringify(input.tags),
    );
    noteAgentWrite();
    return true;
  },

  /** 最近若干条（全局），用于让模型看到"最近学到了什么"。 */
  recent(traderId: number, limit = 10): AgentMemoryRow[] {
    return getDb()
      .all<RawMemory>(
        'SELECT * FROM agent_memory WHERE trader_id = ? ORDER BY id DESC LIMIT ?',
        traderId,
        limit,
      )
      .map(toMemory);
  },

  /**
   * 按标的检索前车之鉴。
   *
   * 决策时用它把"这个标的以前怎么亏的"喂给交易员 —— 这是记忆真正起作用的地方，
   * 而不是把全部历史都塞进提示词。
   */
  forSymbol(traderId: number, symbol: string, limit = 5): AgentMemoryRow[] {
    return getDb()
      .all<RawMemory>(
        'SELECT * FROM agent_memory WHERE trader_id = ? AND symbol = ? ORDER BY id DESC LIMIT ?',
        traderId,
        symbol,
        limit,
      )
      .map(toMemory);
  },

  count(traderId: number): number {
    return (
      getDb().get<{ c: number }>('SELECT COUNT(*) c FROM agent_memory WHERE trader_id = ?', traderId)
        ?.c ?? 0
    );
  },
};

/* -------------------------------------------------------------------------- */
/*  运行轨迹（可审计）                                                         */
/* -------------------------------------------------------------------------- */

export const agentRuns = {
  insert(input: {
    traderId: number;
    kind: string;
    trigger: string;
    intensity: string;
    steps: number;
    agents: unknown;
    outcome: string;
    detail: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
  }): number {
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO agent_runs (
         trader_id, created_at, kind, trigger, intensity, steps,
         agents_json, outcome, detail, tokens_in, tokens_out, latency_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      new Date().toISOString(),
      input.kind,
      input.trigger,
      input.intensity,
      input.steps,
      JSON.stringify(input.agents ?? []),
      input.outcome,
      input.detail,
      input.tokensIn,
      input.tokensOut,
      input.latencyMs,
    );
    noteAgentWrite();
    return Number(lastInsertRowid);
  },

  recent(traderId: number, limit = 20): AgentRunRow[] {
    return getDb()
      .all<RawRun>(
        'SELECT * FROM agent_runs WHERE trader_id = ? ORDER BY id DESC LIMIT ?',
        traderId,
        limit,
      )
      .map(toRun);
  },

  /** 本小时已经跑了几次 —— 预算判据。 */
  countSince(traderId: number, sinceIso: string): number {
    return (
      getDb().get<{ c: number }>(
        'SELECT COUNT(*) c FROM agent_runs WHERE trader_id = ? AND created_at >= ?',
        traderId,
        sinceIso,
      )?.c ?? 0
    );
  },
};
