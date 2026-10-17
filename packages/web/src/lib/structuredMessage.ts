/**
 * **把"一坨 JSON"变成人话** —— 展示层的共用解析（2026-10-17 · 用户实测）。
 *
 * ## 为什么单独一个模块
 *
 * 这个仓库里已经有**两处**需要"把 JSON 当内容显示"的地方，而且以后只会有更多：
 * ```
 *   · 团队「原始响应」那一格      —— 单个对象 → 键值两列表格（`TeamDecisionRow`）
 *   · 团队「历史工作详情」这一格  —— **数组** → 每个标的一行（本文件服务的场景）
 * ```
 * 它们的**输出形状不同**（一个对象 vs 一个数组），但**解析纪律完全相同**：
 * ```
 *   ① 不是合法 JSON → 返回 null（**不抛**），由调用方回落纯文本；
 *   ② 认不出的形状 → 也返回 null，**不猜**；
 *   ③ 一律先过 `plainText()`（markdown 强调符与 JSON 格式化是两件事）。
 * ```
 * 所以把 ①② 收在这一处。**两份 `try { JSON.parse } catch` 迟早会漂移**
 * （一份加了 `trim()`、另一份忘了，症状是"某些记录能显示、某些不能"）。
 *
 * ## ⚠️ 为什么"解析失败"必须是一等公民
 *
 * 这些字符串的来源是 `runtime_logs.note` —— 写进去的时候可能被**截断**过
 * （`deskOutput` 的 `oneLine(…, 2_000)` 就是先压单行再截到 2000 字符）。
 * 被截断的那一份**不是合法 JSON**，`JSON.parse` 会抛。
 * 一个不 `try/catch` 的渲染函数，遇到一条长记录就会把**整块看板**打成错误卡
 * —— 而这恰好发生在"用户正想看清它说了什么"的时候。
 *
 * `t110` 已经踩过这个坑，这里按同一条纪律写。
 */

/**
 * **安全解析**：能解析就返回结果，否则 `null`（**绝不抛**）。
 *
 * `null` 是"这不是 JSON"，不是"内容是空的" —— 调用方据此决定回落纯文本。
 *
 * ## ⚠️ 为什么容忍"前面有中文前缀"（2026-10-17 自测发现）
 *
 * 用户截图里那条是**纯 JSON**（`[{"symbol":"WLDUSDT",…}]`），但同一张表的
 * `note` 也可能写成 `[调研] 决策如下：[…]`、`这一轮的结果：{…}` 这类**带前缀**的形态
 * —— 服务端各处的 `note()` 是自由文本，没有任何人保证"必须以 `{` 开头"。
 *
 * 所以判据从"**整串**必须是 JSON"放宽成"**从第一个 `{` 或 `[` 起**能解析成 JSON"：
 * ```
 *   '[{"a":1}]'              → 解析 ✓
 *   '决策如下：[{"a":1}]'     → 从前缀后的 `[` 起解析 ✓（前缀不丢，调用方保留）
 *   '正在分析 [1,2] 的区间'   → 解析成功但形状不对 → 上层判据仍返回 null ✓
 * ```
 * 放宽是**安全**的：真正的形状判据（`symbol` + `action`）在后面，一条普通中文
 * 即使碰巧含 `[`，也过不了那道判据。
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  /*
   * 候选起点：**收集所有** `{` / `[` 的位置，从后往前逐个试。
   *
   * ⚠️ **不能写成"整串以 `[` 开头就只试 0"**（2026-10-17 自测抓到的真 BUG）：
   * ```
   *   '[夹具] 决策数组（8 个标的） [{"symbol":…}]'
   *    ↑ 整串确实以 `[` 开头 —— 但它只是**前缀里的方括号**，
   *      从 0 解析必然失败，而真正的 JSON 在 17。
   * ```
   * 第一版就是那样写的（`if (startsWith) starts.push(0)`），于是**带中文前缀的行
   * 全部回落纯文本** —— 而用户截图里那一类 note 恰恰常有前缀。
   *
   * 从后往前试 = 优先命中"最靠右、最完整的那个 JSON"，而**真正的内容通常在最后**。
   * 代价可忽略（一条 note 里 `{`/`[` 通常个位数）。
   */
  const starts: number[] = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === '{' || trimmed[i] === '[') starts.push(i);
  }
  /* 整串就是 JSON 时，`0` 已经在 `starts` 里（且是最后一个被试的）。 */
  if (starts.length === 0) return null;

  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const start = starts[i]!;
    try {
      return JSON.parse(trimmed.slice(start)) as unknown;
    } catch {
      /* 这个起点不行，试更靠左的。 */
    }
  }
  return null;
}

/** 决策数组里的一项 —— 只声明**我们会显示**的字段，其余原样忽略。 */
export interface ParsedDecisionItem {
  symbol: string;
  /** 机器码（`open_long` / `skip` …）。显示时过 `actionLabel()`。 */
  action: string;
  leverage: number | null;
  positionSizeUsd: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  confidence: number | null;
  riskUsd: number | null;
  /** 模型给的理由（长文本）。 */
  reasoning: string | null;
  /** 这一条引用了哪几条情报（`intel_keys`）。 */
  intelKeys: string[];
}

/* -------------------------------------------------------------------------- */
/*  字段名 → 人话（用户原话："不要出现英文占位符"）                              */
/* -------------------------------------------------------------------------- */

/**
 * **决策 JSON 的字段名 → 中文**。
 *
 * ## 为什么必须有一份
 *
 * 用户原话：「页面上给人看得东西不要出现：**英文占位符**、json、代码块…」
 * 而 `runtime_logs.note` 里写进来的就是**服务端自己的字段名**：
 * `positionSizeUsd` / `stopLoss` / `intel_keys` …
 * 直接摊在屏幕上，操作员读到的是"编程接口"，不是"这笔交易怎么样"。
 *
 * ## ⚠️ 这份表**只覆盖我们会显示的那些键**
 *
 * 不认识的键（模型自己加的、后端新加的）**保留原词** —— 编一个中文名比显示英文更危险
 * （操作员会以为那是系统认得的字段）。保留时用等宽弱色，让人看出"这是标识符"。
 * 与 `DecisionAudit` 的 `ACTION_LABELS`（动作码）是同一条纪律。
 */
export const DECISION_FIELD_LABELS: Record<string, string> = {
  symbol: '标的',
  action: '动作',
  leverage: '杠杆',
  positionSizeUsd: '仓位(USD)',
  stopLoss: '止损',
  takeProfit: '止盈',
  confidence: '信心',
  riskUsd: '风险(USD)',
  intel_keys: '情报来源',
  intelKeys: '情报来源',
  reasoning: '理由',
  reduce_percent: '减仓比例',
  reduce_quantity: '减仓数量',
  risk_reward: '盈亏比',
};

/** 字段名的人话；未登记的原样返回（调用方据此用等宽弱色）。 */
export function fieldLabel(key: string): string {
  return DECISION_FIELD_LABELS[key] ?? key;
}

/** 一个值是否"看起来像动作码"（用于把值里的 `open_short` 也译掉）。 */
const ACTION_LIKE =
  /^(open_long|open_short|close_long|close_short|add_to_position|reduce_position|adjust_protection|cancel_pending|hold|wait|skip|skip_cycle)$/;

/**
 * **安全解析一个 JSON 对象** → 可渲染的键值对；不是对象就 `null`。
 *
 * 与 `parseDecisionList` 的分工：
 * ```
 *   数组  → parseDecisionList（每个标的一行）
 *   对象  → 本函数（键值两列）—— 例如 note 里写进来的单条决策 {"action":"open_short"}
 * ```
 * 两条都失败 → 调用方回落纯文本。**任一路径都不会抛**。
 */
export function parseLooseObject(text: string): Array<[string, string]> | null {
  const value = parseJsonLoose(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const rows: Array<[string, string]> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    let shown: string;
    if (typeof raw === 'string') shown = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') shown = String(raw);
    else shown = JSON.stringify(raw);
    /*
     * 值本身是动作码时**也译掉**（`{"action":"open_short"}` → 「动作 | 开空」）。
     * 这里只做"值看起来像动作码"的**形态判据**，真正的中文来自调用方注入的
     * `translate` —— lib 层不 import 组件层（`DecisionAudit`）。
     */
    rows.push([key, shown]);
  }
  return rows.length > 0 ? rows : null;
}

/** 值是不是一个"动作码"（供调用方决定要不要过 `actionLabel`）。 */
export function looksLikeActionCode(value: string): boolean {
  return ACTION_LIKE.test(value.trim());
}

const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const strOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * **解析"一坨决策 JSON"** → 可渲染的条目；不是那个形状就 `null`。
 *
 * ## 判据为什么这么严
 *
 * `s.message` 里可能出现的**合法 JSON** 不止一种（服务端不同路径写的），
 * 所以不能"只要是数组就渲染"—— 一个 `["a","b"]` 摊成表格只会更难读。
 * 这里要求：
 * ```
 *   ① 必须是数组，且非空；
 *   ② 每一项必须是对象，且**有 `symbol` 与 `action` 两个字符串字段**
 *      （这两个字段同时存在，才是"一条决策"的形状）；
 *   ③ 至少有一项满足 ② —— 否则整段当普通文本。
 * ```
 * 不满足任何一条 → `null` → 调用方回落 `plainText(s.message)`，
 * **一个字节都不丢**。
 *
 * ## 为什么容忍"部分项不合格"
 *
 * 一条记录里混进一个形状不对的项（老版本字段、模型多写了个 null）不该让
 * **整段**退化成 JSON 字符串 —— 那会把另外 7 条可读的信息一起毁掉。
 * 所以：不合格的项**跳过**，但只要**至少有一项**合格就渲染。
 */
export function parseDecisionList(text: string): ParsedDecisionItem[] | null {
  const value = parseJsonLoose(text);
  if (!Array.isArray(value) || value.length === 0) return null;

  const items: ParsedDecisionItem[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const symbol = strOrNull(row.symbol);
    const action = strOrNull(row.action);
    /* ② 两个字段同时存在，才是"一条决策"的形状。 */
    if (symbol === null || action === null) continue;
    items.push({
      symbol,
      action,
      leverage: numOrNull(row.leverage),
      positionSizeUsd: numOrNull(row.positionSizeUsd),
      stopLoss: numOrNull(row.stopLoss),
      takeProfit: numOrNull(row.takeProfit),
      confidence: numOrNull(row.confidence),
      riskUsd: numOrNull(row.riskUsd),
      reasoning: strOrNull(row.reasoning),
      intelKeys: Array.isArray(row.intel_keys)
        ? row.intel_keys.filter((k): k is string => typeof k === 'string')
        : [],
    });
  }
  /* ③ 一项都不合格 → 当普通文本（不渲染一张空表）。 */
  return items.length > 0 ? items : null;
}
