/**
 * **跨来源事实表** —— 把散落在五张表里的事实汇成**一张**可读、可查询的表。
 *
 * ## 它替代了谁：`ROLES.clerk`（文员）
 *
 * `roles.ts` 里有个 `clerk`（文员）角色，prompt 写得很完整，输出契约是：
 * ```json
 * {"entries":[{"at","kind":"decision|experiment|intel|trade|failure","summary","source","fields"}],
 *  "count":N,"truncated":bool}
 * ```
 * 它要解决的问题（`roles.ts:512` 原文）：
 * > 「**让每个消费者自己拼 = 每个消费者都要写一遍解析逻辑**，且口径会漂移。」
 *
 * ## ⚠️ 为什么用【确定性代码】而不是那个 LLM 角色
 *
 * `clerk` 的 prompt 自己就写着「**只做整理，不做判断**」—— 而"只做整理"正是
 * 一个 SQL 查询的能力，且它有三个 LLM 做不到的性质：
 * ```
 *   ① 不会幻觉：它读的是数据库，不是"它以为数据库里有什么"
 *   ② 零成本、零延迟：一次查询 vs 一次模型调用
 *   ③ 可复现：同样的输入永远给同样的输出（LLM 不能保证）
 * ```
 * 而让一个 LLM 去"整理数据库里的事实"，是在用**概率性的东西替换确定性的查询**，
 * 还要为它付 token。
 *
 * **这是"不重复造轮子"在另一个方向上的应用**：不是"用现成的 LLM 角色"，
 * 而是"用现成的、更合适的工具"。
 *
 * ⚠️ 实测依据：`clerk` 在 149 个生产文件里**零调用**（`docs/FINDING-unwired-roles.md`
 * 有复核脚本）—— 也就是说它从来没有真正工作过。而下面这个函数是可以被直接调用的。
 *
 * ## 五类事实各自的落点
 *
 * | kind | 来源表 | 它回答什么 |
 * | --- | --- | --- |
 * | `decision` | `decision_records` | 这一轮团队决定了什么 |
 * | `trade` | `trades` | 真实成交（钱的实际变化） |
 * | `experiment` | `agent_experiments` | 策略师改了什么参数、之后结果如何 |
 * | `event` | `trade_events` | 成交/平仓等事件流 |
 * | `failure` | `decision_records.execution_log` 里的 failed 项 | 哪个环节失败了 |
 *
 * ⚠️ **`kind` 用的是 `clerk` 契约里的取值**（`decision|experiment|intel|trade|failure`），
 * 但把 `intel` 换成了 `event` —— 因为情报目前**没有独立的表现层落点**
 *（它活在 `intel/` 的内存与 `freshness` 里，不在库里）。**不编造不存在的来源。**
 *
 * ## 用法：回答"跨来源"的问题
 *
 * `roles.ts:512` 举的例子是：
 * ```
 *   "这个信号在过去 20 轮里被引用了几次？引用之后的结果如何？"
 * ```
 * 那需要把 `decision_records`（引用了哪些信号）与 `trades`（结果）**按时间对齐** ——
 * 见 `recent()` 返回的是**按时间倒序的混合流**，调用方可以自己对齐。
 */

import { getDb } from '../../db/index.js';

/** 一条事实。字段与 `ROLES.clerk` 的输出契约一致（见文件头）。 */
export interface FactEntry {
  /** 发生时刻（ISO 8601，UTC）。 */
  at: string;
  kind: 'decision' | 'trade' | 'experiment' | 'event' | 'failure';
  /** 一句话事实。**不含判断** —— 判断是消费者的事。 */
  summary: string;
  /** 这条从哪来（表名），回答"这是从哪来的"。 */
  source: string;
  /** 原始字段（下游要能自己算，而不是靠 summary 里的文字）。 */
  fields: Record<string, unknown>;
}

export interface FactSheet {
  entries: FactEntry[];
  count: number;
  /** 是否因为上限被截断 —— **必须如实报**，否则消费者以为看到了全部。 */
  truncated: boolean;
}

/** 默认条数上限。与 `AGENT_MEMORY_CAP` 同量级：够回溯几十轮，且不会撑爆上下文。 */
const DEFAULT_LIMIT = 60;

/**
 * 取最近的事实，**按时间倒序混合五类来源**。
 *
 * @param traderId 只看这个机器人的事实（跨机器人混在一起没有意义 —— 它们的账户与本钱都不同）
 * @param limit    最多返回多少条
 */
export function recentFacts(traderId: number, limit = DEFAULT_LIMIT): FactSheet {
  const db = getDb();
  /*
   * ⚠️ **每类各取 limit 条，再合并后截断。**
   *
   * 为什么不是"总共 limit 条、每类 limit/5 条"：各来源的**频率差几个数量级**
   *（成交很少、事件很多）。按平均配额会让"最近 20 轮里的成交"被事件挤掉 ——
   * 而成交恰恰是最该被看到的那一类（它是钱的实际变化）。
   *
   * 所以每类都取满，交给时间排序去决定谁留下。
   */
  const entries: FactEntry[] = [];
  /*
   * ⚠️ **每类取 `limit + 1` 条，而不是 `limit` 条** —— 那是"能否判断被截断"的关键。
   *
   * 取 `limit` 条时，即使库里有 20 条、`limit = 5`，合并后总数正好是 5，
   * `entries.length > limit` 为假 → `truncated = false` → **消费者以为看到了全部**。
   * 多取一条就能区分"刚好 limit 条"与"还有更多"。
   *
   * （这是 `factSheet.test.ts` 里"上限与 truncated 必须如实报告"那条抓到的。）
   */
  const perSource = limit + 1;

  /* ---------- 决策 ---------- */
  /*
   * ⚠️ **列名必须与 `schema.ts` 一致** —— 我第一版写的是 `conclusion` / `execution_log`，
   * 而真实列名是 `decisions_json` / `execution_log_json`。**它没有报错**：
   * `safeAll` 把"没有这个列"变成了空数组（那正是它存在的理由），
   * 于是决策类**静默地一条都不返回**。
   *
   * 也就是说：那个"为了让某类缺失不影响整体"的设计，反过来掩盖了我自己的错。
   * `factSheet.test.ts` 里有一条**钉住"五类都能读到"**的测试正是为此 ——
   * 没有它，这个模块会以"永远返回空表"的形态上线。
   */
  const decisions = db.all<{
    cycle_number: number;
    timestamp: string;
    decisions_json: string;
    execution_log_json: string;
    success: number;
    error: string | null;
  }>(
    `SELECT cycle_number, timestamp, decisions_json, execution_log_json, success, error
       FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT ?`,
    traderId,
    perSource,
  );
  for (const d of decisions) {
    const summary = summarizeDecisions(d.decisions_json);
    entries.push({
      at: d.timestamp,
      kind: 'decision',
      summary:
        summary.length > 0
          ? `第 ${d.cycle_number} 轮：${summary}`
          : `第 ${d.cycle_number} 轮：${d.success === 0 ? '决策失败' : '没有决策'}`,
      source: 'decision_records',
      fields: {
        cycleNumber: d.cycle_number,
        summary,
        success: d.success === 1,
        ...(d.error === null ? {} : { error: d.error }),
      },
    });
    /*
     * ⚠️ **失败从 `execution_log_json` 里抽** —— 那是"这个环节没跑成"的唯一落点。
     * 与决策分开成 `kind: 'failure'`：消费者常常只关心失败，混在决策里要再解析一次。
     */
    for (const f of failuresIn(d.execution_log_json)) {
      entries.push({
        at: d.timestamp,
        kind: 'failure',
        summary: `第 ${d.cycle_number} 轮 ${f.symbol}：${f.detail.slice(0, 120)}`,
        source: 'decision_records.execution_log',
        fields: { cycleNumber: d.cycle_number, symbol: f.symbol, status: f.status, detail: f.detail },
      });
    }
  }

  /* ---------- 成交（钱的实际变化） ---------- */
  /*
   * ⚠️ 用 `net_pnl` 而不是 `pnl`：后者是毛的（交易所在成交记录里给的那个），
   * 而**真正影响余额的是净的**（见 `docs/AGENTS.md` §2.5）。
   * 这里读的是 `trades` 表的净额列 —— 若该表还没有这一列（老 schema），
   * 下面的 try/catch 会让这一类静默缺席，而不是让整个事实表失败。
   */
  for (const t of safeAll<{
    symbol: string; side: string; net_pnl: number; close_reason: string; closed_at: string; hold_minutes: number;
  }>(
    db,
    `SELECT symbol, side, net_pnl, close_reason, closed_at, hold_minutes
       FROM trades WHERE trader_id = ? ORDER BY id DESC LIMIT ?`,
    traderId,
    perSource,
  )) {
    const net = Number(t.net_pnl ?? 0);
    entries.push({
      at: t.closed_at,
      kind: 'trade',
      summary: `${t.symbol} ${t.side} 平仓 · 净 ${net >= 0 ? '+' : ''}${net.toFixed(4)} · ${t.close_reason}`,
      source: 'trades',
      fields: { symbol: t.symbol, side: t.side, netPnl: net, closeReason: t.close_reason, holdMinutes: t.hold_minutes },
    });
  }

  /* ---------- 策略实验（改了什么、之后结果如何） ---------- */
  for (const e of safeAll<{
    id: number; created_at: string; trigger: string; reason: string; outcome_net_pnl: number | null; outcome_trades: number | null;
  }>(
    db,
    `SELECT id, created_at, trigger, reason, outcome_net_pnl, outcome_trades
       FROM agent_experiments WHERE trader_id = ? ORDER BY id DESC LIMIT ?`,
    traderId,
    perSource,
  )) {
    const settled = e.outcome_net_pnl !== null;
    entries.push({
      at: e.created_at,
      kind: 'experiment',
      summary:
        `#${e.id}（${e.trigger}）${e.reason.slice(0, 80)}` +
        (settled ? ` → 结果 净 ${Number(e.outcome_net_pnl).toFixed(4)}（${e.outcome_trades} 笔）` : ' → 尚未结算'),
      source: 'agent_experiments',
      fields: {
        id: e.id,
        trigger: e.trigger,
        reason: e.reason,
        outcomeNetPnl: e.outcome_net_pnl,
        outcomeTrades: e.outcome_trades,
      },
    });
  }

  /* ---------- 事件流 ---------- */
  /*
   * ⚠️ **`trade_events` 只有 4 列**：`symbol` / `kind` / `created_at`（+ `id`）。
   * 我第一版 SELECT 了 `message` —— 它不存在，而 `safeAll` 让这一类**静默返回空**。
   * 是 `factSheet.test.ts` 里"五类都能读到"那条测试抓到的（第二次抓到同类错误）。
   *
   * 所以摘要由现有列拼出来，**不编造一个不存在的字段**。
   */
  for (const v of safeAll<{ created_at: string; kind: string; symbol: string }>(
    db,
    `SELECT created_at, kind, symbol FROM trade_events
       WHERE trader_id = ? ORDER BY id DESC LIMIT ?`,
    traderId,
    perSource,
  )) {
    entries.push({
      at: v.created_at,
      kind: 'event',
      summary: `${v.symbol} ${v.kind}`,
      source: 'trade_events',
      fields: { eventKind: v.kind, symbol: v.symbol },
    });
  }

  /* 按时间倒序（最新在前）—— 消费者最常问的是"最近发生了什么"。 */
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const truncated = entries.length > limit;
  return { entries: entries.slice(0, limit), count: Math.min(entries.length, limit), truncated };
}

/**
 * 把 `decisions_json` 压成一句话。
 *
 * ## 为什么不能直接把 JSON 塞进 `summary`
 *
 * `summary` 是**给人看的一行事实**（契约要求"一句话事实"）。而 `decisions_json`
 * 是数组，元素形如 `{"symbol":"BTCUSDT","action":"open_long","leverage":10,...}`。
 * 原样放进去会让这一行变成几百字符的 JSON —— 那正是本项目反复踩过的
 * 「摘要位显示原始 JSON」那类问题（见 `lib/memberSummary.ts` 的文件头）。
 *
 * ## 产出形状
 *
 * ```
 *   1 条：open_long BTCUSDT ×10（$11）
 *   多条：open_long BTCUSDT ×10（$11）等 3 条
 *   空  ：''（由调用方决定怎么措辞）
 * ```
 *
 * ⚠️ 解析失败返回 `''`，不抛 —— 与 `failuresIn` 同一条纪律。
 */
function summarizeDecisions(decisionsJson: string): string {
  const parsed = parseArray(decisionsJson);
  if (parsed.length === 0) return '';
  const parts = parsed.map((d) => {
    const symbol = String(d.symbol ?? '?');
    const action = String(d.action ?? '?');
    const lev = d.leverage === undefined || d.leverage === null ? '' : ` ×${String(d.leverage)}`;
    const size =
      d.positionSizeUsd === undefined || d.positionSizeUsd === null ? '' : `（$${String(d.positionSizeUsd)}）`;
    return `${action} ${symbol}${lev}${size}`;
  });
  return parsed.length === 1 ? parts[0]! : `${parts[0]!} 等 ${parsed.length} 条`;
}

/** 安全地把一段 JSON 解析成对象数组（失败 → 空数组，不抛）。 */
function parseArray(json: string): Array<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(json || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
  } catch {
    return [];
  }
}

/**
 * 从一个决策的 `execution_log_json` 里抽出失败项。
 *
 * ⚠️ **解析失败返回空数组**，不抛 —— 这个字段来自数据库，而"某一行写坏了"
 * 不该让整张事实表消失（与 `parseIntelKeysOf` 同一条纪律：附属字段绝不让主流程失败）。
 */
function failuresIn(executionLogJson: string): Array<{ symbol: string; status: string; detail: string }> {
  return parseArray(executionLogJson)
    .filter((x) => x.status === 'failed' || x.status === 'rejected')
    .map((x) => ({
      symbol: String(x.symbol ?? '?'),
      status: String(x.status ?? '?'),
      detail: String(x.detail ?? x.error ?? ''),
    }));
}

/**
 * 查询**某一类**事实（消费者常常只关心一类）。
 *
 * ⚠️ 它是 `recentFacts` 的过滤视图，**不是第二个数据源** ——
 * 保证"按类查"与"混着查"看到的永远是同一批数据。
 */
export function recentFactsOfKind(traderId: number, kind: FactEntry['kind'], limit = DEFAULT_LIMIT): FactSheet {
  /*
   * 取够多再过滤：混流里某类可能稀疏，按 limit 过滤会漏。
   * 上限取 limit × 5 —— 五类来源里最坏情况下目标类只占 1/5。
   */
  const all = recentFacts(traderId, limit * 5);
  const picked = all.entries.filter((e) => e.kind === kind).slice(0, limit);
  return { entries: picked, count: picked.length, truncated: all.truncated };
}

/**
 * 执行一次查询，**失败返回空数组**。
 *
 * 存在的理由很具体：这张表要合并**五张不同来源的表**，而它们的 schema 版本
 * 可能不一致（老库缺列、迁移未跑）。若任一类缺失就让整张表抛错，
 * 那"文员"就会变成一个**看起来没有事实可整理**的岗位
 * —— 而真因是"某张表少一列"。**安静地少一类，好过整张表消失。**
 */
function safeAll<T>(db: ReturnType<typeof getDb>, sql: string, ...params: unknown[]): T[] {
  try {
    return db.all<T>(sql, ...(params as never[]));
  } catch {
    return [];
  }
}
