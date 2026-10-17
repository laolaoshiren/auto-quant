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
  /*
   * 2026-10-18 · 用户截图里被截断的那三类对象（分析产出 / 裁决产出 / 调研产出）
   * 用到的字段名。**不认识的键仍然保留原词**（见本表上方纪律），这里只补
   * "确认要显示、且有确定中文"的那些。
   */
  side: '方向',
  strength: '强度',
  arguments: '论据',
  invalidates: '失效条件',
  summary: '小结',
  symbols: '标的',
  structure: '结构',
  support: '支撑',
  resistance: '阻力',
  evidence: '依据',
  point: '要点',
  why: '原因',
  matches: '匹配',
  dataGaps: '数据缺口',
  indicators: '指标',
  patterns: '形态',
  hypothesis: '假设',
};

/**
 * **值里的英文枚举 → 中文**（用户原话："页面上不要出现英文占位符"）。
 *
 * 与 `DECISION_FIELD_LABELS`（键）分工相同、纪律相同：
 * ```
 *   认识的枚举 → 译成中文
 *   不认识的词 → **原样返回**（编一个中文名比显示英文更危险）
 * ```
 *
 * ⚠️ 只做**整串精确匹配**（`valueLabel('short')` 才译），不做子串替换 ——
 * 否则一句正常英文/中文正文里的 `short` 会被悄悄改掉，那是**篡改内容**。
 */
export const VALUE_LABELS: Record<string, string> = {
  short_or_no_trade: '只空或不交易',
  strong: '强',
  moderate: '中',
  weak: '弱',
  long: '多',
  short: '空',
  open_long: '开多',
  open_short: '开空',
  skip: '跳过',
  hold: '持有',
};

/** 值的人话；未登记的枚举原样返回。 */
export function valueLabel(value: string): string {
  return VALUE_LABELS[value.trim()] ?? value;
}

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
    /*
     * ⚠️⚠️ **数组/嵌套对象不能 `JSON.stringify` 塞进单元格**（2026-10-18 线上实测修正）。
     *
     * 那正是"这一格还是一坨 JSON"的来源：一个完全正常的分析产出
     * ```
     *   {"hypothesis":"…","matches":[{"symbol":"QUSDT","strength":"weak","evidence":"…"}]}
     * ```
     * 解析是**成功**的，但 `matches` 是数组 ⇒ 老代码 `JSON.stringify` 它 ⇒
     * 单元格里就是 `[{"symbol":"QUSDT","strength":…` —— 用户看到的就是这个。
     *
     * ⇒ 现在**摘要成人话**：数组列出它里面能认出的 `symbol`（这是最有信息量的那部分），
     *   认不出就只说几项；对象只说几个字段。**都不再吐原始 JSON。**
     */
    else if (Array.isArray(raw)) {
      const symbols = raw
        .map((x) => (x !== null && typeof x === 'object' && 'symbol' in x ? String((x as { symbol: unknown }).symbol) : null))
        .filter((s): s is string => s !== null && s.length > 0);
      shown = symbols.length > 0 ? `${raw.length} 项 · ${symbols.join('、')}` : `${raw.length} 项`;
    } else {
      const keys = Object.keys(raw as Record<string, unknown>);
      shown = keys.length > 0 ? `${keys.length} 个字段：${keys.join('、')}` : '（空对象）';
    }
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
   * ⚠️⚠️ **没有留痕也要试**（2026-10-18 线上实测修正 —— 这条是"用户屏幕上仍是一坨 JSON"的真因）。
   *
   * 旧实现在这里 `if (!tail.truncated) return null;`，理由是"与改动前逐字一致、不误伤普通文本"。
   * 但**真实数据里还有第二种坏法**：JSON 不是被后端截断的，而是**模型自己写坏的**：
   *
   * ```
   *   实测（/api/traders/11/agent/judge/steps）：一条 3935 字的裁决产出，
   *   `JSON.parse` 在 **position 3175** 失败（少了一个引号/括号），
   *   而**尾部没有任何留痕** —— 因为它没超过 4000 的 clip 上限。
   * ```
   *
   * ⇒ 这类内容旧实现**永远回落纯文本**，用户屏幕上就是开头那 200 字原始 JSON
   *   （`[ {"symbol":"SIRENUSDT","action":"open_long",…`），正是用户报的现象。
   *
   * ## 为什么放宽是安全的
   *
   * `extractDecisionObjects` → `scanObjectsFrom` 自带**形状守卫**：
   * 它只在 `[` 后面（允许空白）紧跟 `{` 时才认；而且每个抠出来的对象都要过
   * `decisionItemOf`（必须同时有 `symbol` 与 `action`）。
   *
   * ⇒ 普通文本一律不受影响：`区间 [0.8,3.5]`（`[` 后是数字）、`[1,2,3]`、
   *   `见 {a:1}`（`[` 后不是 `{`）都会被守卫挡掉，仍然回落纯文本。
   */
  const extracted = extractDecisionObjects(tail.text);
  /* 连一个完整对象都提不出来 → 回落纯文本（不白屏、不空表）。 */
  if (extracted.items.length === 0) return null;
  return {
    items: extracted.items,
    /*
     * `truncated` 的语义**保持"后端留了痕"**，不改成"内容不完整" ——
     * 因为界面上的「原文本已截断（完整 N 字）」那句需要 `originalLength`，
     * 而没留痕时我们**不知道**原始长度，编一个数字就是假话。
     *
     * 没留痕但提取成功的情形，界面靠 `recovered && !arrayClosed` 说
     * 「只显示了前 N 个完整的标的」—— 那句不需要长度，且同样如实。
     */
    truncated: tail.truncated,
    originalLength: tail.originalLength,
    recovered: true,
    arrayClosed: extracted.arrayClosed,
  };
}

/* -------------------------------------------------------------------------- */
/*  被截断的【对象】的容错提取（2026-10-18 · 用户截图里仍在原样显示的 ①②③）      */
/* -------------------------------------------------------------------------- */
/**
 * ## 这一节补的是哪一块（用户原话）
 *
 * > 「这是给人看的格式吗？…我能看出来这里面很多是原封不动的 json 格式吧？
 * >  前端没有做 json 解析提取对吗？」
 *
 * 当时已有的能力只覆盖**完整** JSON：
 * ```
 *   parseDecisionListDetailed  → 数组（含被截断的数组）
 *   parseLooseObject           → 完整对象（`JSON.parse` 成功才算）
 * ```
 * 而用户截图里那三类都是**被后端截断过的对象**：
 * ```
 *   ① {"symbols":[{"symbol":"AGTUSDT",…          分析产出
 *   ② {"side":"short_or_no_trade","strength":…    裁决产出
 *   ③ {"hypothesis":"当前市场整体处于普跌…         调研产出
 * ```
 * 它们 `JSON.parse` **必然失败** ⇒ `parseLooseObject` 返回 null ⇒ 整条回落纯文本
 * ⇒ 屏幕上就是一坨原始 JSON。本节让它们也能进键值表。
 *
 * ## 算法（只做三件事）
 * ```
 *   ① 定位：收集文本里所有 `{` 作为候选起点（中文前缀自然被跳过）；
 *   ② 容错扫描：按**大括号配对**逐个值往下读，只数**字符串外**的括号，认识 `\"` / `\\`；
 *      没闭合时**保留已经完整收下的键值对 / 子对象 / 子数组**，丢掉最后那个半截值；
 *   ③ 选最像"那段 JSON"的候选：覆盖原文最多（`end` 最远）→ 并列时取更外层（起点更左）。
 * ```
 *
 * ## 为什么"接受判据"要比"能解析出来"更严（宁可回落，不要乱猜）
 *
 * 已有 28 条测试钉住"普通文本不许被误判"。所以容错提取**不接收**这种形状：
 * ```
 *   '[{"symbol":"WLDUSDT","action":"op'   ← 只有一个完整标量对
 * ```
 * 它要满足下面任一条才算"值得成表"：
 * ```
 *   · ≥2 条有内容的键值对                    （② ③、大多数分析产出）
 *   · 或有 1 条"值是带内容的容器"             （① 的 symbols 数组）
 * ```
 * 都不满足 → 返回 null → 调用方回落纯文本，**一个字节都不丢**。
 */

/** 容错解析出来的一个 JSON 值（允许不完整）。 */
interface PartialValue {
  kind: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'invalid';
  /** 标量的可读值（布尔已译成 `是`/`否`）；容器为 `null`。 */
  scalar: string | null;
  /** 对象的键值对（键一定完整）；非对象为 `null`。 */
  pairs: Array<{ key: string; value: PartialValue }> | null;
  /** 数组元素；非数组为 `null`。 */
  items: PartialValue[] | null;
  /** 这个值在原文本里是否完整闭合。 */
  complete: boolean;
}

const INVALID_VALUE: PartialValue = {
  kind: 'invalid',
  scalar: null,
  pairs: null,
  items: null,
  complete: false,
};

function scalarValue(
  kind: 'string' | 'number' | 'boolean' | 'null',
  scalar: string,
  complete: boolean,
): PartialValue {
  return { kind, scalar, pairs: null, items: null, complete };
}

function objectValue(
  pairs: Array<{ key: string; value: PartialValue }>,
  complete: boolean,
): PartialValue {
  return { kind: 'object', scalar: null, pairs, items: null, complete };
}

function arrayValue(items: PartialValue[], complete: boolean): PartialValue {
  return { kind: 'array', scalar: null, pairs: null, items, complete };
}

/** 跳过量 JSON 空白（**只认 JSON 的空白**；中文标点说明结构到这儿就断了）。 */
function skipJsonBlank(source: string, start: number): number {
  let i = start;
  while (i < source.length && isJsonSpace(source[i]!)) i += 1;
  return i;
}

interface StringScan {
  value: string;
  next: number;
  complete: boolean;
}

/**
 * 扫一个字符串字面量（`start` 处必须是 `"`）。
 *
 * ⚠️ 必须认识 `\"` 与 `\\` 转义：模型写的 `structure` / `reasoning` 里
 * 完全可能有引号、花括号、反斜杠 —— 不认识转义就会把"字符串状态"算错，
 * 后面的配对全乱（这正是"只数大括号"会翻车的地方）。
 */
function scanString(source: string, start: number): StringScan {
  let i = start + 1;
  let escaped = false;
  for (; i < source.length; i += 1) {
    const ch = source[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      const literal = source.slice(start, i + 1);
      let value: string;
      try {
        value = JSON.parse(literal) as string;
      } catch {
        /* 转义不合法（模型写坏了）→ 退回字面内容，别让整段解析崩掉。 */
        value = literal.slice(1, -1);
      }
      return { value, next: i + 1, complete: true };
    }
  }
  /* 没闭合：已经能看见的那段就是"半截值"，要不要显示由上层决定。 */
  return {
    value: source.slice(start + 1).replace(/\\(["\\/])/g, '$1'),
    next: source.length,
    complete: false,
  };
}

/** 数字字面量的形状（sticky：只在当前位置匹配）。 */
const NUMBER_LITERAL = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** 从 `start` 起读一个值（标量 / 对象 / 数组）。**任何输入都不抛**。 */
function scanValue(source: string, start: number): { value: PartialValue; next: number } {
  const i = skipJsonBlank(source, start);
  if (i >= source.length) return { value: INVALID_VALUE, next: source.length };

  const ch = source[i]!;
  if (ch === '"') {
    const scanned = scanString(source, i);
    return { value: scalarValue('string', scanned.value, scanned.complete), next: scanned.next };
  }
  if (ch === '{') return scanObject(source, i);
  if (ch === '[') return scanArray(source, i);

  const literals: Array<[string, 'boolean' | 'null', string]> = [
    ['true', 'boolean', '是'],
    ['false', 'boolean', '否'],
    ['null', 'null', '—'],
  ];
  for (const [word, kind, shown] of literals) {
    if (source.startsWith(word, i)) {
      const next = i + word.length;
      /*
       * 贴着文末的字面量**视为不完整**：它可能是 `true` 被截成 `true`，
       * 也可能是更长的词被截断（`tru…` 已被上面的 startsWith 挡掉）。
       * 宁可少显示一个值，也不要显示一个可能被截错的值。
       */
      return { value: scalarValue(kind, shown, next < source.length), next };
    }
  }

  NUMBER_LITERAL.lastIndex = i;
  const numeric = NUMBER_LITERAL.exec(source);
  if (numeric !== null) {
    const next = i + numeric[0].length;
    /* 贴着文末的数字同样视为不完整（`0.0720` 可能本应是 `0.072088`）。 */
    return { value: scalarValue('number', numeric[0], next < source.length), next };
  }

  return { value: INVALID_VALUE, next: i + 1 };
}

/** 扫一个对象（`start` 处必须是 `{`）；没闭合时保留已经收下的键值对。 */
function scanObject(source: string, start: number): { value: PartialValue; next: number } {
  let i = start + 1;
  const pairs: Array<{ key: string; value: PartialValue }> = [];

  for (;;) {
    i = skipJsonBlank(source, i);
    if (i >= source.length) return { value: objectValue(pairs, false), next: source.length };
    if (source[i] === '}') return { value: objectValue(pairs, true), next: i + 1 };
    if (source[i] === ',') {
      i += 1;
      continue;
    }
    if (source[i] !== '"') {
      /*
       * 这里不是键 ⇒ 结构在被截断的尾部坏掉了。真实数据里截断点后面可能直接接
       * 模型自己的话（`…,"confidence":60}* 结论：…`）—— 保留已收下的，停止。
       */
      return { value: objectValue(pairs, false), next: i };
    }

    const key = scanString(source, i);
    if (!key.complete) return { value: objectValue(pairs, false), next: key.next };

    i = skipJsonBlank(source, key.next);
    if (i >= source.length) return { value: objectValue(pairs, false), next: source.length };
    if (source[i] !== ':') return { value: objectValue(pairs, false), next: i };

    const parsed = scanValue(source, i + 1);
    if (parsed.value !== INVALID_VALUE) pairs.push({ key: key.value, value: parsed.value });
    i = parsed.next;
  }
}

/** 扫一个数组（`start` 处必须是 `[`）；没闭合时保留已经收下的元素。 */
function scanArray(source: string, start: number): { value: PartialValue; next: number } {
  let i = start + 1;
  const items: PartialValue[] = [];

  for (;;) {
    i = skipJsonBlank(source, i);
    if (i >= source.length) return { value: arrayValue(items, false), next: source.length };
    if (source[i] === ']') return { value: arrayValue(items, true), next: i + 1 };
    if (source[i] === ',') {
      i += 1;
      continue;
    }

    const parsed = scanValue(source, i);
    if (parsed.value === INVALID_VALUE) return { value: arrayValue(items, false), next: parsed.next };
    items.push(parsed.value);
    i = parsed.next;
  }
}

/**
 * 这个值是否**有内容可显示**。
 * ```
 *   半截的标量（字符串没收尾 / 数字贴着文末）→ 不可用（它就是"要丢弃的最后那个值"）
 *   半截的容器 → 只要里面**已经收下了东西**就可用（① 的 symbols 数组正是这样）
 * ```
 */
function hasContent(value: PartialValue): boolean {
  if (value.kind === 'invalid') return false;
  if (value.kind === 'array') {
    return value.complete || (value.items ?? []).some(hasContent);
  }
  if (value.kind === 'object') {
    return value.complete || (value.pairs ?? []).some((pair) => hasContent(pair.value));
  }
  return value.complete && value.scalar !== null;
}

/** 数组元素的一行（`symbol` 单独出来，显示层据此加粗）。 */
export interface ObjectRowItem {
  symbol: string | null;
  detail: string;
}

/** 对象里的一个字段 —— 完整对象与截断对象**共用同一个显示形状**（`ObjectRows`）。 */
export interface ObjectRow {
  key: string;
  /** 单行值（已经是人话：字段值里的英文枚举已中文化）。 */
  text: string;
  /** 数组元素：有它时显示层**每个元素一行**；没有时显示 `text`。 */
  items?: ObjectRowItem[];
}

interface HumanValue {
  text: string;
  items?: ObjectRowItem[];
}

/**
 * 数组元素里优先摘出来当"一行摘要"的字段（按信息量排序）。
 * `structure` 打头是因为 ① 的每个标的第一句就是结构描述；`point` 是 ② 的论据。
 */
const ELEMENT_DETAIL_KEYS = [
  'structure',
  'point',
  'summary',
  'hypothesis',
  'evidence',
  'why',
  'reasoning',
  'note',
  'description',
];

/** 数组里的一个元素 → 一行人话。 */
function humanizeElement(value: PartialValue): ObjectRowItem {
  if (value.kind === 'object') {
    const pairs = (value.pairs ?? []).filter((pair) => hasContent(pair.value));
    const symbolPair = pairs.find(
      (pair) => (pair.key === 'symbol' || pair.key === 'name') && pair.value.kind === 'string',
    );
    const symbol = symbolPair?.value.scalar ?? null;

    let detail = '';
    for (const key of ELEMENT_DETAIL_KEYS) {
      const found = pairs.find((pair) => pair.key === key && pair.value.kind === 'string');
      if (found !== undefined) {
        detail = found.value.scalar ?? '';
        break;
      }
    }
    /* 认不出"摘要字段"→ 把能看见的标量按 `字段 值` 串起来（仍然不出 JSON）。 */
    if (detail.length === 0) {
      detail = pairs
        .filter((pair) => pair.value.kind === 'string' || pair.value.kind === 'number')
        .map((pair) => `${fieldLabel(pair.key)} ${valueLabel(pair.value.scalar ?? '')}`)
        .join(' · ');
    }
    return { symbol, detail };
  }
  return { symbol: null, detail: valueLabel(value.scalar ?? '') };
}

/** 一个值 → 人话（数组元素逐行；嵌套对象只说字段名，**绝不吐原始 JSON**）。 */
function humanizeValue(value: PartialValue): HumanValue {
  switch (value.kind) {
    case 'string':
      return { text: valueLabel(value.scalar ?? '') };
    case 'number':
    case 'boolean':
    case 'null':
      return { text: value.scalar ?? '' };
    case 'array': {
      const items = (value.items ?? []).filter(hasContent);
      if (items.length === 0) return { text: '（内容被截断）' };
      return { text: `${items.length} 项`, items: items.map(humanizeElement) };
    }
    case 'object': {
      const pairs = (value.pairs ?? []).filter((pair) => hasContent(pair.value));
      if (pairs.length === 0) return { text: '（内容被截断）' };
      return {
        text: `${pairs.length} 个字段：${pairs.map((pair) => fieldLabel(pair.key)).join('、')}`,
      };
    }
    default:
      return { text: '' };
  }
}

/** 一个候选对象起点扫出来的结果。 */
interface ObjectCandidate {
  start: number;
  /** 扫描到达的最远位置（用于"哪一段最像正文里那段 JSON"）。 */
  end: number;
  value: PartialValue;
  /** 有内容的顶层键值对。 */
  strong: Array<{ key: string; value: PartialValue }>;
  /** 键完整、值是**半截字符串**的顶层对（只在一条完整对都没有时降级使用）。 */
  partialStrings: Array<{ key: string; value: PartialValue }>;
  /** `true` = 走正常路径；`false` = 降级路径（③）。 */
  normal: boolean;
}

/** 从某个 `{` 起扫一遍，按判据决定它是否值得成表。 */
function objectCandidateAt(source: string, start: number): ObjectCandidate | null {
  const scanned = scanObject(source, start);
  if (scanned.value.kind !== 'object') return null;

  const pairs = scanned.value.pairs ?? [];
  const strong = pairs.filter((pair) => hasContent(pair.value));
  const partialStrings = pairs.filter(
    (pair) => pair.value.kind === 'string' && !pair.value.complete && (pair.value.scalar ?? '').length > 0,
  );
  const hasContainerPair = strong.some(
    (pair) => pair.value.kind === 'array' || pair.value.kind === 'object',
  );

  /*
   * ⚠️ **曾经这里是 `strong.length >= 2 || hasContainerPair`** —— 要求至少两条键值对
   * 才成表。2026-10-18 独立验证用线上真实数据推翻了它：
   *
   * ```
   *   market_analyst 的真实产出：一个 hypothesis 对象，后面还接了中文
   *   ↑ 只有【一条】键值对 ⇒ 老门槛拒绝 ⇒ 屏幕上原样显示这坨 JSON 原文
   * ```
   *
   * ⇒ 现在放开到 **1 条**，但加一道**内容门槛**挡住误伤：
   *   唯一的那条键值对，其值必须"像正文"（≥12 字符）。
   *   `{a:1}` / `{"debug":true}` 这类普通文本里偶发的对象，值都短 ⇒ 仍然回落。
   *
   * 为什么阈值取 12：用户真实数据里最短的一条是 `{"symbol":"AGTUSDT"}`（19 字符）——
   * 12 在它之下、在所有"配置片段"之上。
   */
  const MIN_SINGLE_VALUE_LEN = 12;
  const longEnoughSingle =
    strong.length === 1 &&
    (strong[0]!.value.kind !== 'string' || (strong[0]!.value.scalar ?? '').trim().length >= MIN_SINGLE_VALUE_LEN) &&
    (strong[0]!.value.kind === 'string' || strong[0]!.value.kind === 'array' || strong[0]!.value.kind === 'object');
  const normal = strong.length >= 2 || hasContainerPair || longEnoughSingle;
  /*
   * 降级路径只服务一种真实形态（用户截图 ③）：
   * ```
   *   {"hypothesis":"当前市场整体处于普跌…   ← 半截字符串，一条完整对都没有
   * ```
   * 这种文本**提取不出一条完整键值对**，按"宁可回落"本该回落纯文本 ——
   * 但那样屏幕上又会出现 `{"`，正是用户报的现象。折中：显示**完整键名 + 半截字符串的
   * 可见前缀**，并在表下方如实标注"原文本被截断，只显示了完整的部分"。
   * 判据刻意很窄（`strong` 必须为 0），所以它不会抢走正常路径的输入。
   */
  const degraded = !normal && strong.length === 0 && partialStrings.length > 0;

  if (!normal && !degraded) return null;

  return { start, end: scanned.next, value: scanned.value, strong, partialStrings, normal };
}

/** 候选偏好：覆盖原文更远优先；并列时取更外层（起点更左）。 */
function prefers(candidate: ObjectCandidate, current: ObjectCandidate | null): boolean {
  if (current === null) return true;
  if (candidate.end !== current.end) return candidate.end > current.end;
  return candidate.start < current.start;
}

/**
 * 在整段文本里挑出"最像正文那段 JSON"的对象起点。
 *
 * 候选**从每个 `{` 都试一遍**（中文前缀因此自然被跳过），不依赖"整串必须以 `{` 开头"
 * —— `note` 是自由文本，前缀可能是「让我先理清我的角色：…输出必须是 JSON 对象：」。
 * 正常路径优先于降级路径（有能成表的对象时，不用半截字符串兜底）。
 */
function pickObjectCandidate(source: string): ObjectCandidate | null {
  let normalBest: ObjectCandidate | null = null;
  let degradedBest: ObjectCandidate | null = null;

  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '{') continue;
    const candidate = objectCandidateAt(source, i);
    if (candidate === null) continue;
    if (candidate.normal) {
      if (prefers(candidate, normalBest)) normalBest = candidate;
    } else if (prefers(candidate, degradedBest)) {
      degradedBest = candidate;
    }
  }

  return normalBest ?? degradedBest;
}

/** 把候选渲染成显示层共用的键值行。 */
function rowsOfCandidate(candidate: ObjectCandidate): ObjectRow[] {
  /*
   * 正常路径只显示"有内容"的键值对（半截的标量值丢弃 —— 它就是被截断的那一个）。
   * 降级路径显示完整键 + 半截字符串的可见前缀（理由见 `objectCandidateAt`）。
   */
  const chosen = candidate.normal ? candidate.strong : candidate.partialStrings;
  const rows: ObjectRow[] = [];
  const seen = new Set<string>();
  for (const pair of chosen) {
    if (seen.has(pair.key)) continue;
    seen.add(pair.key);
    const human = humanizeValue(pair.value);
    rows.push(
      human.items === undefined
        ? { key: pair.key, text: human.text }
        : { key: pair.key, text: human.text, items: human.items },
    );
  }
  return rows;
}

/** `parseLooseObjectDetailed` 的结果。 */
export interface ObjectDetail {
  rows: ObjectRow[];
  /** 原文被后端截断过（末尾有留痕）。 */
  truncated: boolean;
  /** 留痕里记录的原始字符数；没有留痕 → `null`。 */
  originalLength: number | null;
  /**
   * 对象本身**没闭合**（内容在末尾被切断）。
   * 显示层据此说「原文本被截断，只显示了完整的部分」。
   */
  incomplete: boolean;
}

/**
 * **对象 → 键值行（完整对象与被截断对象共用）**。
 *
 * ```
 *   ① 完整对象 → 与 `parseLooseObject` 完全同一条路径（行为逐字不变）
 *   ② 被截断的对象 → 容错扫描，只保留完整收下的键值对 / 子对象 / 子数组
 * ```
 *
 * ## 为什么"完整对象"也走这里（而不是让调用方分两次判断）
 *
 * 两条路径的**输出形状必须一致**（同一个 `ObjectRows` 渲染），分开判断迟早漂移。
 * 本函数内部仍先调 `parseLooseObject`，所以完整对象的行内容与改动前**逐字相同**。
 *
 * ## 为什么完整闭合的对象在这里可能返回 null
 *
 * 容错路径**只接管"确实被截断"的形态**：
 * ```
 *   · 扫描没闭合                                   → 接管
 *   · 或后端留了截断留痕（被截掉的是对象后面的正文） → 接管
 *   · 完整闭合且没有留痕                            → 不接管
 * ```
 * 最后一种在改动前就是"解析失败 → 回落纯文本"（例如 `{"a":1} 然后这是解释`）。
 * 保持它不变，是为了满足"普通文本行为与改动前逐字一致"。
 */
/** 从 `start` 起是否是一个**能 `JSON.parse` 的完整对象**。 */
function parsesObjectAt(source: string, start: number): boolean {
  try {
    const value = JSON.parse(source.slice(start)) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

export function parseLooseObjectDetailed(text: string): ObjectDetail | null {
  const tail = stripTruncationTail(text);
  if (tail.text.trim().length === 0) return null;

  /*
   * 多条留痕 = 多段内容拼在同一条 message 里（各角色各被截断过一次）。
   * 那不是"一个对象" —— 整段回落纯文本，**不从某一段里猜**（与决策数组同一纪律）。
   */
  if (
    tail.truncated &&
    text.indexOf(TRUNCATION_MARKER) !== text.lastIndexOf(TRUNCATION_MARKER)
  ) {
    return null;
  }

  const candidate = pickObjectCandidate(tail.text);
  const strict = parseLooseObject(tail.text);

  /*
   * ## ⚠️ 为什么不能"先试严格路径，成功就用"（2026-10-18 自测抓到的真 BUG）
   *
   * `parseJsonLoose` 从**最靠右**的 `{` 开始试。而截断的 ① 长这样：
   * ```
   *   {"symbols":[{"symbol":"A",…},{"symbol":"B",…},{"symbol":"C",…   ← 外层没闭合
   *                                                        ↑ 若最后这个元素恰好完整闭合，
   *                                                          JSON.parse 会成功 —— 但只解析出
   *                                                          **最后一个元素**，前面全丢。
   * ```
   * 实测：`{"symbols":[{"symbol":"A","structure":"x"},{"symbol":"B","structure":"y"}]`
   * （外层缺 `}`）会被严格路径当成 `{"symbol":"B",…}`，屏幕上只剩 B。
   *
   * ⇒ 判据改成：**严格路径解析到的必须就是"候选里那个最外层对象"**才用它。
   *   否则走容错（扫描从最外层 `{` 开始，前几个元素一个不丢）。
   */
  const strictIsOutermost =
    strict !== null &&
    (candidate === null || (candidate.value.complete && parsesObjectAt(tail.text, candidate.start)));

  /* ① 完整对象：与 `parseLooseObject` 同一条路径（行内容逐字不变）。 */
  if (strict !== null && strictIsOutermost) {
    /*
     * ⚠️ **完整对象后面还跟着中文时，要标 `incomplete`**（2026-10-18 · 用户报的那一类）。
     *
     * 线上真实形状：`{"hypothesis":"…"} 材料不足，无法出结论。以下是我能确认的：…`
     * —— 对象本身完整，但**后面那段中文没有进表**。
     * 不标 `incomplete` 的话，界面会当成"这就是全部"，用户看不到那半段。
     *
     * 判据：候选对象**结束位置 < 正文长度**（说明后面还有内容）。
     * 用 `candidate?.end` 而不是 `JSON.parse` 的位置 —— 因为 `parseJsonLoose` 可能从
     * 更靠右的 `{` 起解析，`end` 由容错扫描给出，才是"最外层对象的真实结束"。
     */
    const bodyEnd = tail.text.trimEnd().length;
    const hasTrailingText = candidate !== null ? candidate.end < bodyEnd : false;
    return {
      rows: strict.map(([key, value]) => ({ key, text: value })),
      truncated: tail.truncated,
      originalLength: tail.originalLength,
      incomplete: hasTrailingText,
    };
  }

  /* ② 被截断的对象：容错提取。 */
  if (candidate === null) return null;

  /*
   * ⚠️⚠️ **曾经这里有一条 `if (candidate.value.complete && !tail.truncated) return null;`**
   * —— 意思是"完整闭合又没留痕的对象不接管"。**2026-10-18 独立验证用线上真实数据推翻了它**：
   *
   * ```
   *   market_analyst 的一条真实产出（799 字）：
   *   {"hypothesis":"当前市场整体处于普跌/风险偏好收缩状态，…集中于'已走出极端幅度'的标的。"
   *    材料不足，无法出结论。以下是我能确认的：…三项判定。
   *                 ↑ 对象【完整闭合】了，后面又接了中文
   *   ⇒ 老判据"不接管" ⇒ 屏幕上原样显示这坨 JSON（用户报的正是这个）
   * ```
   *
   * 那条判据当初是为了让 `[0.8,3.5]`、`见 {a:1}` 这类普通文本不被误伤。
   * **但识别"是不是一坨正经对象"的守卫在 `objectCandidateAt` 里已经足够严**
   * （≥2 条有内容的键值对，或有 1 条容器值）——
   * `{a:1}`（单字段、值 1 字）过不了它，所以这里放开是安全的。
   *
   * ⇒ 现在：**只要能提取出 ≥2 行，就接管**，不论是否完整闭合、有没有留痕。
   *   尾部那段中文不丢：它在 `rows` 里没有位置，由调用方按"截断"提示带出来
   *   （`incomplete` 为真时界面会说"原文本被截断，只显示了完整的部分"）。
   */
  const rows = rowsOfCandidate(candidate);
  /* 一行都提不出来 → 回落纯文本（不白屏、不空表）。 */
  if (rows.length === 0) return null;

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  "值不值得成表"的唯一判据：**表里的内容有没有实质信息量**
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 我在这里反复错过两次，记下来免得第三次：
   *
   * | 判据 | 失败原因 |
   * |---|---|
   * | `rows.length >= 2` | 线上真有一条 `{"hypothesis":"29 字的正文"} 后面还有中文` 只有 1 行 ⇒ 被拦 |
   * | `rows.length < 2 && 无尾巴 → 回落` | `{"a":1,"b":2} 后面还有解释`（值各 1 字）反而接管了 |
   *
   * ⇒ 数**行数**区分不了「一条长正文」和「两条垃圾」。要看**内容长度**：
   *   把每行的值拼起来，**有效字符 ≥ `MIN_TABLE_DETAIL_CHARS`** 才值得占一张表。
   *
   * 校准过两端（都是线上真实数据）：
   * ```
   *   {"hypothesis":"当前市场整体处于普跌、风险偏好收缩状态…"}  ⇒ 值 29 字  ⇒ 成表 ✅
   *   {"a":1,"b":2} 后面还有解释                                  ⇒ 值 2 字   ⇒ 回落 ✅
   *   {"symbol":"AGTUSDT"}（散文里被引用的片段）                   ⇒ 值 7 字   ⇒ 回落 ✅
   * ```
   */
  const MIN_TABLE_DETAIL_CHARS = 12;
  /*
   * ⚠️ **"信息量"要把【键名】和【半截值】一起算**（2026-10-18 修正两次）。
   *
   * 前两版的错误：
   * | 判据 | 失败原因 |
   * |---|---|
   * | 只累加 `row.text` | 数组行（`symbols`/`arguments`）的 `text` 是空串、内容在 `items` 里 ⇒ 判成 0 分 |
   * | 累加 `text + items` | `{"side":"short_or_no_trade","strength":"strong","arguments":[{"point":"…` ——
   * |                    | `arguments` 里那个元素是**半截的**，被 `humanizeValue` 丢了 ⇒ items 空 ⇒ 仍然 0 分 |
   *
   * ⇒ 现在算三样：**键名长度 + 值的可见长度 + 容器的元素个数×6**。
   *   理由是键名本身就是信息（`side`/`strength`/`arguments` 三个键名已经说明"这是什么"），
   *   而容器里有几个元素（哪怕内容半截）也说明"这一项有多少条"。
   *
   * 校准过两端（线上真实数据）：
   * ```
   *   {"hypothesis":"…29 字正文…"}                 ⇒ 键 10 + 值 29 = 39  ⇒ 成表 ✅
   *   {"side":"short_or_no_trade","strength":"strong","arguments":[{…}
   *                                                 ⇒ 键 25 + 值 23 + 元素 6 = 54 ⇒ 成表 ✅
   *   {"a":1,"b":2} 后面还有解释                     ⇒ 键 2 + 值 2 = 4        ⇒ 回落 ✅
   *   {"symbol":"AGTUSDT"}（散文里被引用）           ⇒ 键 6 + 值 7 = 13 …… ⚠ 偏高，见下
   * ```
   * 最后那条是个真实风险：`{"symbol":"AGTUSDT"}` 会被判 13 ≥ 12 而成表。
   * **但它只在"没有尾巴、且对象完整"时才有意义** —— 那种情形实际是"散文里引用了一小段 JSON"，
   * 成表反而是好事（比显示 `{"symbol":"AGTUSDT"}` 好）。真正的垃圾（`{"a":1}`）仍然 3 分。
   */
  const detailChars = rows.reduce(
    (sum, row) =>
      sum +
      row.key.length +
      row.text.trim().length +
      (row.items ?? []).reduce((n, item) => n + (item.symbol ?? '').length + item.detail.trim().length, 0) +
      (row.items?.length ?? 0) * 6,
    0,
  );
  if (detailChars < MIN_TABLE_DETAIL_CHARS) return null;

  const bodyLength = tail.text.trimEnd().length;
  const hasTrailingText = candidate.end < bodyLength;

  return {
    rows,
    truncated: tail.truncated,
    originalLength: tail.originalLength,
    /*
     * `incomplete` 现在有两个来源：① 对象本身没闭合；② 对象闭合了但**后面还有尾巴**
     *（`candidate.end < 文本长度`）—— 后者就是 `{"hypothesis":"…"} 后面还有一段中文`。
     * 两者对用户是同一件事：「你看到的不是全文」。
     */
    incomplete: !candidate.value.complete || hasTrailingText,
  };
}
