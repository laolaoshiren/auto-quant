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

/* -------------------------------------------------------------------------- */
/*  截断留痕：后端 `clip()` 追加的 `…（已截断，完整 N 字）`                       */
/* -------------------------------------------------------------------------- */

/**
 * 后端截断留痕的形状（`deskOutput.ts` 的 `clip()`，**有意留的，不要改后端**）：
 * ```
 *   `${one.slice(0, limit)}…（已截断，完整 ${s.length} 字）`
 * ```
 *
 * ## 为什么必须认识它（2026-10-18 · 用户实测）
 *
 * 一条 4,750 字的裁决官输出被截到 4,000 字，尾巴多了 `…（已截断，完整 4750 字）`。
 * 那段被截下来的正文本身就是一个**不完整的 JSON 数组**，尾巴又接在它后面 ——
 * 于是 `JSON.parse` 永远失败 → 整条 message 回落纯文本 → 用户屏幕上出现一坨原始 JSON。
 *
 * 这个留痕是**给人看的**（"这不是全部"），所以展示层要做两件事：
 * ```
 *   ① 解析前先剥掉它（它是人话，不是 JSON 的一部分）；
 *   ② 结构化渲染时**把这句话再说一遍**，不能因为剥掉就丢了"被截断"这个事实。
 * ```
 */
export interface TruncationInfo {
  /** 剥掉留痕后的正文；**没有留痕时原样返回同一个字符串**。 */
  text: string;
  /** 原文是否被后端截断过。 */
  truncated: boolean;
  /** 留痕里记录的原始字符数（没有留痕 → `null`）。 */
  originalLength: number | null;
}

/**
 * 只认**末尾**那一条留痕（后端是把它追加在整条 message 的最后）。
 *
 * ⚠️ 末尾允许空白（`join('\n')` 之后可能带换行）。而**一条 message 里出现多条留痕**
 * 说明它是多段内容拼起来的（例如整个 `<team>` 块，每个角色一段留痕）——
 * 那种文本**不是"一个决策数组"**，调用方必须整段回落纯文本，不许从某一段里抠数组。
 * 这条判据在 `parseDecisionListDetailed` 里用 `TRUNCATION_MARKER` 做。
 */
const TRUNCATION_MARKER = '…（已截断，完整 ';
const TRUNCATION_TAIL = /…（已截断，完整 (\d+) 字）\s*$/;

/** 剥掉截断留痕（没有留痕时返回**原字符串**，一个字节都不动）。 */
export function stripTruncationTail(text: string): TruncationInfo {
  const match = TRUNCATION_TAIL.exec(text);
  if (match === null) return { text, truncated: false, originalLength: null };
  return {
    text: text.slice(0, match.index),
    truncated: true,
    originalLength: Number.parseInt(match[1]!, 10),
  };
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
  /* 截断留痕不是 JSON 的一部分 —— 先剥掉再解析（没有留痕时是恒等变换）。 */
  const value = parseJsonLoose(stripTruncationTail(text).text);
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
 *
 * ## 截断的决策数组（2026-10-18 起）
 *
 * 后端会截断长输出并留痕（`…（已截断，完整 N 字）`），被截断的数组**不是合法 JSON**。
 * 本函数不再直接返回 null，而是交给 `parseDecisionListDetailed` 做**容错提取**：
 * 抠出前面完整的 `{…}`，最后那个不完整的丢弃。需要"这条被截断了"这个事实时
 * 用带元信息的 `parseDecisionListDetailed`；只要条目时用本函数即可。
 */
export function parseDecisionList(text: string): ParsedDecisionItem[] | null {
  return parseDecisionListDetailed(text)?.items ?? null;
}

/** 把数组里的一项收成可渲染的决策行；形状不对 → `null`（**不猜**）。 */
function decisionItemOf(raw: unknown): ParsedDecisionItem | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const symbol = strOrNull(row.symbol);
  const action = strOrNull(row.action);
  /* ② 两个字段同时存在，才是"一条决策"的形状。 */
  if (symbol === null || action === null) return null;
  return {
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
  };
}

/* -------------------------------------------------------------------------- */
/*  截断决策数组的**容错提取**（2026-10-18 · 用户实测的那条 4,016/4,750 字）      */
/* -------------------------------------------------------------------------- */

const isJsonSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

interface ObjectScan {
  /** 按出现顺序抠出来的**完整**对象原文（最后那个不完整的**不在里面**）。 */
  objects: string[];
  /** 是否扫到了数组的 `]`（= 数组本身其实是完整的，截断发生在它后面）。 */
  closed: boolean;
}

/**
 * 从 `start` 处的 `[` 开始，按**大括号配对**逐个抠出完整的 `{…}`。
 *
 * ## 为什么不能"用逗号切"
 *
 * 决策对象的 `reasoning` 是模型写的长文本，里面**完全可能有逗号、引号、花括号**
 * （实测有理据写 `[0.8,3.5]`、`D=-1.045%`）。所以扫描必须：
 * ```
 *   ① 只数**字符串外**的 `{` / `}`；
 *   ② 认识 `"` 与 `\"` 转义（否则 reasoning 里的引号会让"字符串状态"跑偏）；
 *   ③ 遇到没闭合的对象就**丢弃它**（它正是被截断的那一条），保留前面完整的。
 * ```
 *
 * ## 返回 `null` 与返回 `{ objects: [] }` 的区别
 *
 * ```
 *   null           → 这个 `[` 后面不是"对象数组"（`["a","b"]` / 区间 `[0.8,3.5]`）
 *                    → 这个起点不成立，调用方换更靠左的 `[` 再试
 *   objects: []    → 起点成立，但里面还没有一个完整对象（截断在最前面）
 * ```
 */
function scanObjectsFrom(source: string, start: number): ObjectScan | null {
  if (source[start] !== '[') return null;
  let i = start + 1;
  const objects: string[] = [];

  for (;;) {
    /* 元素之间的空白与逗号 —— 截断可能停在任意位置。 */
    while (i < source.length && (isJsonSpace(source[i]!) || source[i] === ',')) i += 1;
    if (i >= source.length) return { objects, closed: false };
    if (source[i] === ']') return { objects, closed: true };
    /*
     * ⚠️ **不是 `{` 有两种情形，必须分开**（2026-10-18 独立验证打穿后修）：
     *
     * ```
     *   ① 还没抠到任何对象就撞上非 `{`  → 这个起点不成立（`["a","b"]`、区间 `[0.8,3.5]`）
     *                                      ⇒ 返回 null，让调用方换更靠左的 `[` 再试
     *   ② 已经抠到 ≥1 个完整对象才撞上   → **保留已抠到的**，停止扫描
     * ```
     *
     * 第 ② 种是**真实数据的常见形状**：数组被 4000 字上限截断，截断点后面直接接模型自己写的话
     * （实测：`[{"symbol":"WLDUSDT",…},{"symbol":"BTWUSDT",…},* 结论：**开空 WLDUSDT**…（已截断，完整 4750 字）`）
     * —— 数组没有 `]`，第 3 个元素是半句话 `* 结论：`。
     *
     * 老代码在这里一律 `return null`，把**前两个本来完好的对象一起丢掉** ⇒
     * 上层回落纯文本 ⇒ **用户屏幕上又是一坨原始 JSON**（用户报的正是这个）。
     */
    if (source[i] !== '{') {
      return objects.length > 0 ? { objects, closed: false } : null;
    }

    const objectStart = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < source.length; i += 1) {
      const ch = source[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    /* 这个对象没闭合（被截断）→ 丢弃它以及后面的一切。 */
    if (depth !== 0) return { objects, closed: false };
    objects.push(source.slice(objectStart, i));
  }
}

/** 容错提取的结果。 */
interface DecisionExtraction {
  items: ParsedDecisionItem[];
  /**
   * 是否扫到了数组的 `]`。
   * ```
   *   false → 数组被截断在中间：只抠出前 N 个，**必须**说"只显示了前 N 个"
   *   true  → 数组本身完整（截断发生在它**之后**，例如后面还有一段中文）
   *           → 条目是全的，只说"原文本被截断过"，不能谎称丢了几条
   * ```
   */
  arrayClosed: boolean;
}

/**
 * 从"被截断的输出"里尽量抠出**完整的**决策项。
 *
 * 候选起点**从右往左**试（与 `parseJsonLoose` 同一策略）：真正的数组通常是
 * 最靠右那个"后面跟着 `{`"的方括号，而 reasoning 里的 `[0.8,3.5]` 这类区间
 * 后面跟的不是 `{`，会被 `scanObjectsFrom` 判为"起点不成立"直接跳过。
 *
 * ⚠️ **只由 `parseDecisionListDetailed` 在"认出留痕"之后调用** ——
 * 没有留痕的普通文本绝不走这里，保证"改动前怎么显示，现在还怎么显示"。
 */
function extractDecisionObjects(source: string): DecisionExtraction {
  const starts: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '[') starts.push(i);
  }

  for (let k = starts.length - 1; k >= 0; k -= 1) {
    const scan = scanObjectsFrom(source, starts[k]!);
    if (scan === null || scan.objects.length === 0) continue;
    const items: ParsedDecisionItem[] = [];
    for (const fragment of scan.objects) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fragment) as unknown;
      } catch {
        /* 单个对象抠出来却不是合法 JSON → 跳过它，不毁掉别的。 */
        continue;
      }
      const item = decisionItemOf(parsed);
      if (item !== null) items.push(item);
    }
    if (items.length > 0) return { items, arrayClosed: scan.closed };
  }
  return { items: [], arrayClosed: false };
}

/** `parseDecisionListDetailed` 的结果 —— 除条目外还带"这条被截断过"的元信息。 */
export interface DecisionListDetail {
  items: ParsedDecisionItem[];
  /** 原文被后端截断过（末尾有留痕）。 */
  truncated: boolean;
  /** 留痕里记录的原始字符数；没有留痕 → `null`。 */
  originalLength: number | null;
  /**
   * `true` = 原文**不是**合法 JSON，是靠"逐个抠完整对象"容错提取出来的。
   * 此时显示层必须如实说明被截断过；`arrayClosed === false` 时还要说"只显示了前 N 个"。
   */
  recovered: boolean;
  /**
   * 决策数组本身是否完整。
   * ```
   *   false → 数组被截断在中间（最后那个对象不完整，已丢弃）
   *   true  → 数组完整，被截掉的只是它后面的内容
   * ```
   * 非 `recovered` 路径恒为 `true`（原文就是完整 JSON）。
   */
  arrayClosed: boolean;
}

/**
 * **`parseDecisionList` 的带元信息版**。
 *
 * 判据与 `parseDecisionList` 完全一致，只多两步：
 * ```
 *   ① 解析前剥掉留痕尾巴（`stripTruncationTail`）；
 *   ② 若原文被截断、且整体解析失败 → 逐个抠完整对象（`extractDecisionObjects`）；
 *      一个都抠不出来 → 返回 null（调用方回落纯文本，不白屏、不空表）。
 * ```
 *
 * ⚠️ **没有留痕的输入不走 ②**：`[{"symbol":"X","act`（没尾巴）仍然返回 null，
 * 与改动前逐字一致。
 */
export function parseDecisionListDetailed(text: string): DecisionListDetail | null {
  const tail = stripTruncationTail(text);

  /*
   * 多条留痕 = 多段内容拼在同一条 message 里（各角色各被截断过一次）。
   * 那不是"一个决策数组" —— 整段回落纯文本，**不从某一段里猜**。
   */
  if (tail.truncated && text.indexOf(TRUNCATION_MARKER) !== text.lastIndexOf(TRUNCATION_MARKER)) {
    return null;
  }

  const value = parseJsonLoose(tail.text);
  if (Array.isArray(value) && value.length > 0) {
    const items: ParsedDecisionItem[] = [];
    for (const raw of value) {
      const item = decisionItemOf(raw);
      if (item !== null) items.push(item);
    }
    /* ③ 一项都不合格 → 当普通文本（不渲染一张空表）—— 与改动前一致。 */
    if (items.length === 0) return null;
    return {
      items,
      truncated: tail.truncated,
      originalLength: tail.originalLength,
      recovered: false,
      arrayClosed: true,
    };
  }

  /*
   * 只有**确实被截断过**才做容错提取。没有留痕 → 一律按原判据回落，
   * 这样普通文本（哪怕碰巧含 `{`）的行为与改动前**逐字一致**。
   */
  if (!tail.truncated) return null;

  const extracted = extractDecisionObjects(tail.text);
  /* 连一个完整对象都提不出来 → 回落纯文本（不白屏、不空表）。 */
  if (extracted.items.length === 0) return null;
  return {
    items: extracted.items,
    truncated: true,
    originalLength: tail.originalLength,
    recovered: true,
    arrayClosed: extracted.arrayClosed,
  };
}
