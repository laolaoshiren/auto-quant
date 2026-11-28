import type { DecisionRecord, ExecutionLogEntry } from '@aq/shared';
import { getDb } from '../db/index.js';
import { clampPageLimit, cursorOf } from './ordersRepo.js';

const now = (): string => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/*  Decision records                                                           */
/* -------------------------------------------------------------------------- */

interface DecisionRow {
  id: number;
  trader_id: number;
  cycle_number: number;
  timestamp: string;
  system_prompt: string;
  user_prompt: string;
  cot_trace: string;
  decisions_json: string;
  raw_response: string;
  execution_log_json: string;
  candidate_symbols_json: string;
  success: number;
  error: string | null;
  ai_latency_ms: number;
  /* 迁移 M24 加的；迁移之前的行或非流式调用为 NULL。 */
  ai_ttft_ms?: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /* 迁移 M9 加的；迁移之前的行是 NULL（= 当时没记，不是没命中）。 */
  cached_tokens: number | null;
  reasoning_tokens: number | null;
}

function toDecisionRecord(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    traderId: row.trader_id,
    cycleNumber: row.cycle_number,
    timestamp: row.timestamp,
    systemPrompt: row.system_prompt,
    userPrompt: row.user_prompt,
    cotTrace: row.cot_trace,
    decisions: safeJsonParse(row.decisions_json, []),
    rawResponse: row.raw_response,
    executionLog: safeJsonParse<ExecutionLogEntry[]>(row.execution_log_json ?? '[]', []),
    candidateSymbols: safeJsonParse<string[]>(row.candidate_symbols_json, []),
    success: row.success === 1,
    error: row.error,
    aiLatencyMs: row.ai_latency_ms,
    aiTtftMs: row.ai_ttft_ms ?? null,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    /*
     * 缓存命中与思考 token。
     *
     * **`?? null` 而不是 `?? 0`**：迁移之前的历史行这两列是 NULL，
     * 而 NULL 的含义是"当时没记"、不是"没命中"。把它们读成 0
     * 会让所有历史记录看起来像缓存全没命中。
     */
    cachedTokens: row.cached_tokens ?? null,
    reasoningTokens: row.reasoning_tokens ?? null,
  };
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * 一次最多回多少条决策记录。
 *
 * 卡住的是**字节数**，不是行数：每条记录都带着完整提示词、思维链与原始响应
 * （单条几十 KB 很常见）。路由以前把 `?limit=999999` 原样交给 SQL，一次请求就能
 * 让服务端拼出几十 MB 的 JSON 占住 event loop，浏览器那侧也会直接卡死 ——
 * 这正是操作者说的"成千上万数据一次加载出来导致系统卡死"。
 * 200 条足够"全部记录"这类页面一次翻完一屏，也不至于把一次请求变成几 MB。
 */
export const DECISION_PAGE_MAX = 200;

/** 不传 `limit` 时返回多少条 —— 与历史行为和 `docs/API.md` 一致。 */
export const DECISION_PAGE_DEFAULT = 50;

/**
 * 把调用方给的 `limit` 收进 `[1, DECISION_PAGE_MAX]`。
 *
 * **钳制而不是报错**：翻页的控制台不该因为页大小写得大一点就收到 400，
 * 而一个手写的 `?limit=999999` 也绝不能真的返回 999999 条。
 * 非有限值（没传 / `NaN` / `Infinity`）回落到默认值，等同于路由原来那半句
 * `Number.isFinite(limit) ? limit : 50`。
 *
 * 实现与订单 / 成交两张表共用同一个 `clampPageLimit`（见该函数的说明）：
 * 三张历史表只有上限与默认值不同，钳制规则必须一模一样。
 */
export function clampDecisionLimit(limit: number): number {
  return clampPageLimit(limit, DECISION_PAGE_MAX, DECISION_PAGE_DEFAULT);
}

/**
 * `decision_records` 的裁剪节流。
 *
 * ⚠️ **裁剪绝不能每写一行都做。** 这一段原来是"INSERT 之后立刻 DELETE 一次"，
 * 而那条 DELETE 是 `WHERE id NOT IN (SELECT id FROM decision_records … LIMIT 500)`
 * —— **一次全表扫描**，而 `decision_records` 的每一行都是几十 KB 的提示词全文。
 * `node:sqlite` 是同步 API：这次扫描直接压在**跑交易循环的那个事件循环**上。
 *
 * 这违反的是本项目自己立下的契约：`runtimeLogs`（同文件）与 `agentStore`
 * 早就改成了"每 N 次写裁剪一次"，只有这里漏了。
 *
 * 每 50 次写裁剪一次：表的上界变成 500 + 50 = 550 行，而任何读取路径都只要
 * 最近 500 行 —— 多留的那部分是纯缓冲，没有消费者依赖它。
 */
const DECISION_TRIM_EVERY_WRITES = 50;
/** 距离上次裁剪已写入的行数（裁剪是全局的，不区分 trader）。 */
let decisionWritesSinceTrim = 0;

/**
 * **提示词全文**只保留最近这么多条；更早的记录把提示词字段清空。
 *
 * ## 为什么要有这条（实测：一个字段占了这个库 90% 的体积）
 *
 * 2026-09-29 实测：`decision_records` 占 **88.77 MB**，其中
 * **`user_prompt` 一个字段就占 68.59 MB**（单条最大 **220,295 字符** ——
 * 它是 20 个候选 × 4 个周期 × 10 个指标序列的完整数组）。
 * 保留 500 条 = **稳态约 100 MB**，而且每轮都要往 SQLite 里写 ~200 KB。
 *
 * 而"当时给模型看了什么"**只在复盘最近几轮时有价值**。更早的决策里，
 * 真正有长期价值的是**决定了什么**（`decisions_json`）与**执行结果**
 * （`execution_log_json`）—— 这两样一个字都不动。
 *
 * 所以超期之后**只清空提示词字段、不删行**：决策与执行仍可完整回看，
 * 而体积回到每行不足 1 KB 的量级。
 *
 * 想回看更早的提示词时，值不值得付 100 MB 换，是个可以再讨论的取舍 ——
 * 但默认值不该是"一直存着"。
 */
const DECISION_PROMPT_KEEP = 100;

/**
 * 到点就裁剪 `decision_records`（每 `DECISION_TRIM_EVERY_WRITES` 次新增行一次）。
 *
 * 抽成函数而不是内联：2026-10-17 起**有两个插入点**（`begin()` 与 `log()`），
 * 而裁剪只该跟着"新增行"走 —— 两处复制一份逻辑迟早会漂移（本仓库为此吃过多次亏：
 * 同一个算式曾有五处副本，见 `binance/income.ts` 的 `netPnlOf` 注释）。
 */
function trimDecisionsIfDue(traderId: number): void {
  decisionWritesSinceTrim += 1;
  if (decisionWritesSinceTrim < DECISION_TRIM_EVERY_WRITES) return;
  decisionWritesSinceTrim = 0;
  getDb().run(
    `DELETE FROM decision_records
      WHERE trader_id = ?
        AND id NOT IN (SELECT id FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT 500)`,
    traderId,
    traderId,
  );
  /*
   * ⚠️ **更早的记录只清提示词，不删行** —— 理由见 `DECISION_PROMPT_KEEP`。
   *
   * `LENGTH(user_prompt) > 0` 这个条件让重复执行几乎不花代价：
   * 已经清空过的行不会被再次扫描写入。它同时也是**幂等**的 ——
   * 这条 UPDATE 可以被安全地重复调用。
   */
  getDb().run(
    `UPDATE decision_records
        SET system_prompt = '', user_prompt = '', cot_trace = '', raw_response = ''
      WHERE trader_id = ?
        AND id NOT IN (SELECT id FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT ?)
        AND LENGTH(user_prompt) > 0`,
    traderId,
    traderId,
    DECISION_PROMPT_KEEP,
  );
}

export const decisions = {
  /**
   * **给某机器人最近一轮决策追加一条执行日志。**
   *
   * ## 为什么需要它（2026-10-08 用户实测）
   *
   * 用户的观察：
   *
   * > 「倒数第二轮有挂单开多，但是最新一轮没有提示撤单，但是挂单消失了？
   * >   是最新一轮决策取消了挂单？？（如果是的话**你得显示上去啊**）」
   *
   * 查下来是**系统**超时撤的单（日志原文「RAYSOLUSDT 的限价挂单已等满 43 分钟
   * （上限 15）仍未成交，已自动撤掉并释放该入场名额」），而它**只走了
   * `this.emit('info', …)`** —— 那是**实时事件流**，页面一刷新就没了，
   * 决策卡片的 `executionLog` 里一个字都没有。
   *
   * ## 这是同一个已知模式的第二个实例
   *
   * 本文件里 `autoTrader` 已经为**一模一样的事**写过注释：
   * "模型主动去要了数据"必须落进审计日志，否则它翻历史查不到 ——
   * 那之前也只走 `emit`。**当时的结论是"实时流 ≠ 审计日志"，而这次漏的是系统侧动作。**
   *
   * 所以补一个入口：把系统动作**追加到最新那一轮**的 `executionLog`，
   * 于是它在决策流里可见、刷新后仍在。追加到最新一轮而不是"发起该挂单的那一轮"，
   * 是因为**用户要回答的问题是"挂单去哪了"，而他是从最新一轮往下看的**。
   */
  appendExecutionLog(traderId: number, entry: ExecutionLogEntry): void {
    const row = getDb().get<{ id: number; execution_log_json: string | null }>(
      'SELECT id, execution_log_json FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT 1',
      traderId,
    );
    if (!row) return;
    const list = safeJsonParse<ExecutionLogEntry[]>(row.execution_log_json ?? '[]', []);
    list.push(entry);
    getDb().run(
      'UPDATE decision_records SET execution_log_json = ? WHERE id = ?',
      JSON.stringify(list),
      row.id,
    );
  },
  /**
   * 某机器人的决策记录，**最新在前**。`before` 是游标：只返回 `id < before` 的记录。
   *
   * ## 为什么用 `before=id` 而不是 `offset`
   *
   * 这个列表是**在顶部持续插入**的：每跑完一轮就多一条新记录。用 `OFFSET 20` 取
   * "第二页"时，第一条新记录一插进来，整个窗口就往下挪一格 —— 第二页的第一条会
   * 和第一页的最后一条**重复**；反过来，如果两次请求之间旧记录被裁掉（见 `log()`），
   * 窗口往上挪一格，中间就会**漏掉**一行。游标锚在一条具体记录的 `id` 上，
   * 新记录拿到的 `id` 一定更大，永远落在游标之上，页与页之间既不重也不漏。
   *
   * ## 为什么排序键也换成 `id`
   *
   * 翻页边界要成立，排序键和游标键必须是同一列：这里用自增主键 `id`。
   * 它等于写入顺序，而 `log()` 每跑完一轮只写一行、周期号单调递增，
   * 所以 `id` 倒序与原来的 `cycle_number DESC` 是同一个顺序（最新的一轮在前）。
   * 索引 `idx_decisions_trader` 建在 `cycle_number` 上，因此这条查询会在按
   * `trader_id` 过滤之后再排序 —— 每个机器人最多留 500 行（见 `log()` 的保留上限），
   * 这点排序代价可以忽略，换来的是页边界不可能漏行或重复。
   */
  list(traderId: number, limit = DECISION_PAGE_DEFAULT, before?: number | null): DecisionRecord[] {
    const pageSize = clampDecisionLimit(limit);
    const cursor = cursorOf(before);

    // 第一页与后续页只有 WHERE 一段不同：分成两条 SQL 是为了两条都能吃到索引，
    // 也不用把 `(? IS NULL OR id < ?)` 这种对优化器不友好的写法塞进热路径。
    if (cursor === null) {
      return getDb()
        .all<DecisionRow>(
          'SELECT * FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT ?',
          traderId,
          pageSize,
        )
        .map(toDecisionRecord);
    }

    return getDb()
      .all<DecisionRow>(
        'SELECT * FROM decision_records WHERE trader_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        traderId,
        cursor,
        pageSize,
      )
      .map(toDecisionRecord);
  },

  get(id: number): DecisionRecord | undefined {
    const row = getDb().get<DecisionRow>('SELECT * FROM decision_records WHERE id = ?', id);
    return row ? toDecisionRecord(row) : undefined;
  },

  /**
   * 汇总某个机器人（全量或自 `sinceIso` 起）的决策周期 Token 用量。
   * 逐行先用 `MIN(cached_tokens, prompt_tokens)` 钳制缓存命中量，保证累计费用与单轮之和严格一致。
   */
  tokenUsageStats(
    traderId: number,
    sinceIso?: string,
  ): {
    totalCycles: number;
    meteredCycles: number;
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
    reasoningTokens: number;
  } {
    const sql = sinceIso
      ? `SELECT
           COUNT(*) AS total_cycles,
           COALESCE(SUM(CASE WHEN prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS metered_cycles,
           COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0) AS prompt_tokens,
           COALESCE(SUM(CASE
             WHEN cached_tokens IS NOT NULL AND prompt_tokens IS NOT NULL THEN MIN(MAX(cached_tokens, 0), MAX(prompt_tokens, 0))
             WHEN cached_tokens IS NOT NULL THEN MAX(cached_tokens, 0)
             ELSE 0
           END), 0) AS cached_tokens,
           COALESCE(SUM(COALESCE(completion_tokens, 0)), 0) AS completion_tokens,
           COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0) AS reasoning_tokens
         FROM decision_records
         WHERE trader_id = ? AND timestamp >= ?`
      : `SELECT
           COUNT(*) AS total_cycles,
           COALESCE(SUM(CASE WHEN prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS metered_cycles,
           COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0) AS prompt_tokens,
           COALESCE(SUM(CASE
             WHEN cached_tokens IS NOT NULL AND prompt_tokens IS NOT NULL THEN MIN(MAX(cached_tokens, 0), MAX(prompt_tokens, 0))
             WHEN cached_tokens IS NOT NULL THEN MAX(cached_tokens, 0)
             ELSE 0
           END), 0) AS cached_tokens,
           COALESCE(SUM(COALESCE(completion_tokens, 0)), 0) AS completion_tokens,
           COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0) AS reasoning_tokens
         FROM decision_records
         WHERE trader_id = ?`;
    const row = (
      sinceIso
        ? getDb().get<Record<string, number>>(sql, traderId, sinceIso)
        : getDb().get<Record<string, number>>(sql, traderId)
    ) ?? {};
    return {
      totalCycles: Number(row['total_cycles'] ?? 0),
      meteredCycles: Number(row['metered_cycles'] ?? 0),
      promptTokens: Number(row['prompt_tokens'] ?? 0),
      cachedTokens: Number(row['cached_tokens'] ?? 0),
      completionTokens: Number(row['completion_tokens'] ?? 0),
      reasoningTokens: Number(row['reasoning_tokens'] ?? 0),
    };
  },

  log(input: {
    traderId: number;
    cycleNumber: number;
    systemPrompt: string;
    userPrompt: string;
    cotTrace: string;
    decisions: unknown;
    rawResponse: string;
    executionLog: ExecutionLogEntry[];
    candidateSymbols: string[];
    success: boolean;
    error: string | null;
    aiLatencyMs: number;
    /** LLM 首字延迟（毫秒，多轮取均值）；`null` 表示非流式或未测到。 */
    aiTtftMs?: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    /** 命中缓存的输入 token，`null` 表示服务商没报。 */
    cachedTokens?: number | null;
    /** 花在思考上的输出 token（已计入 completion）。 */
    reasoningTokens?: number | null;
  }): number {
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO decision_records (trader_id, cycle_number, timestamp, system_prompt, user_prompt, cot_trace, decisions_json, raw_response, execution_log_json, candidate_symbols_json, success, error, ai_latency_ms, ai_ttft_ms, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.cycleNumber,
      now(),
      input.systemPrompt,
      input.userPrompt,
      input.cotTrace,
      JSON.stringify(input.decisions),
      input.rawResponse,
      JSON.stringify(input.executionLog),
      JSON.stringify(input.candidateSymbols),
      input.success,
      input.error,
      input.aiLatencyMs,
      input.aiTtftMs ?? null,
      input.promptTokens,
      input.completionTokens,
      input.cachedTokens ?? null,
      input.reasoningTokens ?? null,
    );
    // Keep the audit trail bounded so the database does not grow without limit.
    // 每 50 次写才裁剪一次 —— 理由见 `DECISION_TRIM_EVERY_WRITES`。
    // （与 `begin()` 共用同一个实现，见 `trimDecisionsIfDue`。）
    trimDecisionsIfDue(input.traderId);
    return lastInsertRowid;
  },

  count(traderId: number): number {
    return getDb().count('SELECT COUNT(*) AS n FROM decision_records WHERE trader_id = ?', traderId);
  },

  /**
   * **提前落一行"本轮已开始"的审计记录**，并返回它的 id。
   *
   * ## 为什么需要它（2026-10-17 线上实测：订单真实存在、审计记录不存在）
   *
   * `decisionStore.log()` 原来只在**轮次末尾**调用一次（`autoTrader.ts` 的
   * `runCycle()` 第 11 步）。而一轮的长度实测到 **1304 秒（21.7 分钟）**
   * （`decision_records.ai_latency_ms`），`SHUTDOWN_DRAIN_TIMEOUT_MS` 只有 **3 分钟** ——
   * 于是每次部署（SIGTERM）都等不到一轮跑完就退出：
   *
   * ```text
   *   05:49:16 SIGTERM  ← 部署；该轮已下 ZECUSDT SELL LIMIT（orders 2005, 05:46:47）
   *   06:04:02 SIGTERM  ← 部署；该轮已下 INJUSDT BUY LIMIT（orders 2012, 06:00:14）
   *   decision_records  ：停在 813（05:21:04）        ← 两个真实订单，零条审计记录
   * ```
   *
   * ⇒ **审计链断裂**：订单真实存在，事后无法解释"这笔单为什么下"。
   *
   * ## 契约
   *
   * 1. **一行一轮**：`(trader_id, cycle_number)` 上有唯一性语义 —— 见
   *    `findByCycle()`。调用方拿到 `recordId` 后，轮次末尾走 `finish()` 更新它，
   *    **不再插第二行**。
   * 2. **字段全部可后补**：这里只写"已经知道的东西"（周期号、开始时间、空占位），
   *    提示词/思维链/决策/执行日志由 `finish()` 补齐。所以提前落库**不会**
   *    让最终记录少任何字段。
   * 3. **`success` 先写 1**：语义是"目前没有失败"。真正的失败由 `finish()` 写 ——
   *    而**轮次被切断时它停在 1**，这恰好是诚实的：那一轮确实没抛错，
   *    它只是**没有跑完**。调用方另有 `pendingSinceMs` 判据（见 `health`
   *    与 `findUnfinished()`）来区分"完成"与"没跑完"。
   */
  begin(input: {
    traderId: number;
    cycleNumber: number;
    /**
     * 幂等键的载体：同一 `(traderId, cycleNumber)` 已经有一行时**不再插新行**，
     * 直接返回既有那一行的 id。
     *
     * ⚠️ 由调用方决定是否走这个判据：正常路径要靠它防"重试一轮 → 两行"，
     * 而测试/回放里可能刻意要造重复行（见 `log()` 的同族说明）。
     */
    idempotent?: boolean;
  }): { id: number; created: boolean } {
    if (input.idempotent !== false) {
      const existing = this.findByCycle(input.traderId, input.cycleNumber);
      if (existing !== undefined) {
        /*
         * ⚠️ **复用那一行时必须把它"重置成全新的 pending"**，不能原样留着。
         *
         * 复用的真实场景就是本任务要修的那个：上一轮被 SIGTERM 切断 ⇒
         * `traders.last_cycle_number` 没被推进（`recordCycle()` 只在跑完之后调）⇒
         * 重启后 `cycleNumber` 又走上同一个号 ⇒ 撞上那一行残留的 pending。
         *
         * 如果只返回它的 id 而不重置，最终记录会是**新一轮的数据配上一轮的
         * `timestamp`**（以及上一轮可能已经写进去的零散字段）—— 一张自相矛盾的行：
         * 时间是旧的、内容却是新的。重置之后语义干净：**这一行代表"第 N 轮最近一次尝试"**，
         * 而"曾经有过一次被切断的尝试"由下面那条 warn 与 `warnUnfinishedAudit` 记录。
         */
        getDb().run(
          `UPDATE decision_records
              SET timestamp = ?, system_prompt = '', user_prompt = '', cot_trace = '',
                  decisions_json = '[]', raw_response = '', execution_log_json = '[]',
                  candidate_symbols_json = '[]', success = 1, error = NULL,
                  ai_latency_ms = 0, ai_ttft_ms = NULL, prompt_tokens = NULL, completion_tokens = NULL,
                  cached_tokens = NULL, reasoning_tokens = NULL
            WHERE id = ?`,
          now(),
          existing,
        );
        return { id: existing, created: false };
      }
    }
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO decision_records (trader_id, cycle_number, timestamp, success)
       VALUES (?, ?, ?, 1)`,
      input.traderId,
      input.cycleNumber,
      now(),
    );
    /*
     * ⚠️ **裁剪必须跟着"新增行"走，不能跟着"补完"走。**
     *
     * 保留策略（500 行 + 每 50 次写裁一次）原来写在 `log()` 里 —— 因为那时
     * `log()` 就是唯一的写入点。2026-10-17 改成"`begin()` 插入 + `finish()` 更新"之后，
     * **插入点变成了 `begin()`**：裁剪留在这里才是对的。
     *
     * 留在 `finish()` 里会有两个后果：
     *   · 行数只在"轮次跑完"时才被裁 —— 一个不断被打断的机器人（正是本任务要修的场景）
     *     会一直只增不裁；
     *   · 更糟的是**自相矛盾**：`finish()` 可能把刚插入、又被裁剪掉的那一行判成"更新失败"
     *     （`{ updated: false }`），于是每次收尾都报一条假 warn。
     */
    trimDecisionsIfDue(input.traderId);
    return { id: lastInsertRowid, created: true };
  },

  /**
   * 把 `begin()` 那一行补成终态。
   *
   * ⚠️ **这是"提前落库 + 后补"唯一允许的收尾入口** —— 不要在别处再写一次
   * `INSERT`，否则一轮两行又会回来（那正是 `runCycle()` 把落库点收敛到一处的理由）。
   *
   * 返回 `{ updated }`：`false` 表示**那一行已经不在了**（被裁剪，或调用方拿错了 id）。
   * 调用方必须把它当真 —— 静默吞掉会让"审计记录丢了"这件事无从发现，
   * 而那正是本任务要消灭的那类观测空洞（参见 `autoTrader.ts` 的 `warnUnfinishedAudit`）。
   */
  finish(input: {
    id: number;
    systemPrompt: string;
    userPrompt: string;
    cotTrace: string;
    decisions: unknown;
    rawResponse: string;
    executionLog: ExecutionLogEntry[];
    candidateSymbols: string[];
    success: boolean;
    error: string | null;
    aiLatencyMs: number;
    aiTtftMs?: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    cachedTokens?: number | null;
    reasoningTokens?: number | null;
  }): { updated: boolean } {
    const { changes } = getDb().run(
      `UPDATE decision_records
          SET system_prompt = ?, user_prompt = ?, cot_trace = ?, decisions_json = ?,
              raw_response = ?, execution_log_json = ?, candidate_symbols_json = ?,
              success = ?, error = ?, ai_latency_ms = ?, ai_ttft_ms = ?,
              prompt_tokens = ?, completion_tokens = ?, cached_tokens = ?, reasoning_tokens = ?
        WHERE id = ?`,
      input.systemPrompt,
      input.userPrompt,
      input.cotTrace,
      JSON.stringify(input.decisions),
      input.rawResponse,
      JSON.stringify(input.executionLog),
      JSON.stringify(input.candidateSymbols),
      input.success ? 1 : 0,
      input.error,
      input.aiLatencyMs,
      input.aiTtftMs ?? null,
      input.promptTokens,
      input.completionTokens,
      input.cachedTokens ?? null,
      input.reasoningTokens ?? null,
      input.id,
    );
    return { updated: changes > 0 };
  },

  /** 某机器人某一轮的那一行（幂等键的读取侧）。 */
  findByCycle(traderId: number, cycleNumber: number): number | undefined {
    const row = getDb().get<{ id: number }>(
      'SELECT id FROM decision_records WHERE trader_id = ? AND cycle_number = ? ORDER BY id DESC LIMIT 1',
      traderId,
      cycleNumber,
    );
    return row?.id;
  },

  /**
   * 某机器人**最新那一行**，连同"它是不是还没补完"。
   *
   * `pending` 的判据：`ai_latency_ms = 0` 且 `error IS NULL` 且 `decisions_json` 为空。
   * `begin()` 写的就是这个形状；`finish()` 之后至少会填上 `ai_latency_ms`
   * （最短的一轮也有几毫秒）或把 `decisions_json` 写成 `[]` 以外的内容 ——
   * 但**真正可靠的那条**是 `ai_latency_ms`：正常路径即使一轮 0 决策也会写实话时。
   *
   * ⚠️ 只用来回答"最近这一轮跑完了吗"，**不要**拿它去改 `traders.last_cycle_at`
   * 之外的任何状态（那是调度器的事，本任务明令不碰）。
   */
  latestWithPending(traderId: number): { id: number; cycleNumber: number; timestamp: string; pending: boolean } | undefined {
    const row = getDb().get<{
      id: number;
      cycle_number: number;
      timestamp: string;
      ai_latency_ms: number;
      error: string | null;
      decisions_json: string;
    }>(
      `SELECT id, cycle_number, timestamp, ai_latency_ms, error, decisions_json
         FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT 1`,
      traderId,
    );
    if (!row) return undefined;
    const pending =
      Number(row.ai_latency_ms) === 0 &&
      row.error === null &&
      (row.decisions_json === '' || row.decisions_json === '[]');
    return {
      id: row.id,
      cycleNumber: row.cycle_number,
      timestamp: row.timestamp,
      pending,
    };
  },
};

