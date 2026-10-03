import {
  CLOSE_ACTIONS,
  DecisionActionSchema,
  OPEN_ACTIONS,
  RawDecisionSchema,
  isCloseAction,
  isAdjustAction,
  isCancelPendingAction,
  isResizeAction,
  isOpenAction,
  normalizeSymbol,
  type Decision,
  type DecisionAction,
  type ParsedDecisionSet,
  type RejectedDecision,
} from '@aq/shared';
import { z } from 'zod';
import { createLogger } from '../logger.js';

const log = createLogger('strategy:parser');

/**
 * `RawDecision` but with `action` left as a free string.
 *
 * Validating the action against the enum here would make an unrecognised action
 * fail the whole object and be dropped silently — which is exactly the case an
 * operator most needs to see. The action is validated explicitly below so it can
 * be reported with a reason.
 */
const LenientDecisionSchema = RawDecisionSchema.extend({ action: z.string().min(1) });
type LenientDecision = z.infer<typeof LenientDecisionSchema>;

/* -------------------------------------------------------------------------- */
/*  Text hygiene                                                               */
/* -------------------------------------------------------------------------- */

/** Zero-width and other invisible characters that break `JSON.parse`. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;

function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

/**
 * Repair the punctuation a model reaches for when it "helpfully" localises its
 * output. Chinese/CJK models in particular emit full-width quotes and colons
 * inside JSON strings, which makes the payload unparseable.
 */
export function repairEncoding(text: string): string {
  return text
    .replace(/[\u201C\u201D\u2033\u3003]/g, '"') // curly double quotes
    .replace(/[\u2018\u2019\u2032]/g, "'") // curly single quotes
    .replace(/[\uFF02]/g, '"')
    .replace(/[\uFF3B]/g, '[')
    .replace(/[\uFF3D]/g, ']')
    .replace(/[\uFF5B]/g, '{')
    .replace(/[\uFF5D]/g, '}')
    .replace(/[\uFF1A]/g, ':')
    .replace(/[\uFF0C\u3001]/g, ',')
    .replace(/[\uFF08]/g, '(')
    .replace(/[\uFF09]/g, ')');
}

/**
 * Last-resort JSON repairs, applied only after a strict parse has already
 * failed: trailing commas, and `//` / `#` comments.
 */
function repairJsonStructure(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([}\]"])\s*\/\/[^\n]*$/gm, '$1');
}

/**
 * **把 JSON 字符串内部的裸控制字符转义掉**（换行 / 回车 / 制表 / 其它 < 0x20）。
 *
 * ## 为什么需要它（2026-10-03，实盘抓到"整轮零决策"）
 *
 * 模型在 `reasoning` 字段里写了**多行文字**（它自己的思考习惯），于是那段 JSON
 * 变成这样：
 *
 * ```text
 * "reasoning": "止损幅度 1.30%,RR 2.06,均过线。**
 *   },                        ← 字符串里出现了【真的换行】
 * ```
 *
 * 这在 JSON 规范里是**非法**的（控制字符必须转义成 `\n`），`JSON.parse` 直接抛：
 *
 * ```text
 * Bad control character in string literal in JSON at position 706
 * ```
 *
 * 而 `safeParseJson()` 的两条候选（原文、`repairJsonStructure`）都不管这件事 ——
 * 于是**整轮决策被丢成 `[]`**，界面显示「本周期模型没有给出任何决策」。
 * 实测那一轮模型其实给出了 **2 笔开仓 + 十余条 skip**，全部被静默丢掉
 * （它 40k tokens 的思考与 8.9k 字的结论都白费了）。
 *
 * ## 为什么必须"逐字符走状态机"而不是一条正则
 *
 * 字符串**外面**的换行是合法空白（格式化 JSON 全靠它），无差别替换会把结构改坏。
 * 只有**引号之内**的才需要转义，而且要跳过已经转义过的 `\\` 与 `\"`。
 * （`parser.test.ts` 里那条"字符串里带 `]`"的用例，就是同一类"必须看上下文"
 * 的前车之鉴。）
 */
function escapeControlCharsInsideStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        /* 常见三个写成可读的转义，其余按 \uXXXX —— 都是合法 JSON。 */
        if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * **补上漏写的字符串闭合引号**（模型偶尔会在长 `reasoning` 里漏掉结尾的 `"`）。
 *
 * ## 实盘现场（2026-10-03，周期 #37，与控制字符是**同一轮**）
 *
 * 模型写成：
 *
 * ```text
 * "reasoning": "...止损幅度 1.30%,RR 2.06,均过线。**
 *   },                 ← 换行之后直接是 "}," —— 而值少了一个收尾的 "
 *   {
 *     "symbol": "WLDUSDT",
 * ```
 *
 * 修掉控制字符之后，`JSON.parse` 就卡在这里：
 * `Expected ',' or '}' after property value in JSON at position 724`。
 *
 * ## 为什么这个启发式是安全的
 *
 * 判据是「字符串**未闭合**的状态下，遇到了**行首的 JSON 结构**（`},` / `{` / `]`）」——
 * 也就是"一个值的结束引号丢了"的典型形状。真正的字符串内容里几乎不会出现
 * 「换行 + 两空格 + `},`」这种排版（模型的理由是连续中文散文）。
 *
 * ⚠️ **只在严格解析失败之后才用**（它排在 `candidates` 的最后），所以一个本来
 * 就合法的响应永远不会走到这里；误判的代价被限制在"本已无法解析"的输入上。
 */
function closeUnterminatedStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && ch === '\n') {
      /*
       * 看**换行之后**那一行的开头是不是 JSON 结构 —— 是则说明引号丢了。
       * （`\s*` 允许缩进；最多吃 8 个空格，避免把正常散文里的换行误判。）
       */
      const rest = text.slice(i + 1);
      const m = /^[ \t]{0,8}([}\]])/.exec(rest);
      if (m) {
        out += '"'; // 补上闭合引号
        inString = false;
        out += ch;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function safeParseJson(text: string): unknown {
  /*
   * ⚠️ **顺序在这里是本质的，不是风格问题**（2026-10-03 踩过一次）。
   *
   * `closeUnterminatedStrings` 靠"**遇到真的换行符**"判断一个值是不是漏了收尾引号；
   * 而 `escapeControlCharsInsideStrings` 会把那个换行**变成 `\`+`n` 两个字符**。
   * 先转义再补引号 ⇒ 补引号那一步永远看不到换行 ⇒ **永远不触发**。
   *
   * 实测就是这么失败的：`#37` 的 `reasoning` 同时有「多行」与「漏收尾引号」两个瑕疵，
   * 而两级修复按错误顺序排列，谁也救不回来。
   *
   * 所以**先补引号（要看到原始换行），再统一转义**。
   */
  const candidates = [
    text,
    repairJsonStructure(text),
    /* 先补漏写的收尾引号（必须在控制字符被转义之前 —— 见上面那段顺序说明）。 */
    closeUnterminatedStrings(text),
    escapeControlCharsInsideStrings(closeUnterminatedStrings(text)),
    /* 只有换行、没有漏引号的情形。 */
    escapeControlCharsInsideStrings(text),
    escapeControlCharsInsideStrings(repairJsonStructure(text)),
    /* 全角标点也一并试（模型偶尔用中文标点）。 */
    escapeControlCharsInsideStrings(repairEncoding(text)),
    escapeControlCharsInsideStrings(closeUnterminatedStrings(repairEncoding(text))),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next repair */
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  Chain-of-thought extraction                                                */
/* -------------------------------------------------------------------------- */

/**
 * Strip XML/code-fence scaffolding from a fragment.
 *
 * Needed for the truncated-response case: when a model runs out of output budget
 * mid-reasoning it never emits the closing `</reasoning>`, so the paired regex
 * cannot match and the raw text (with its opening tag) would otherwise be shown
 * to the operator as the chain of thought.
 */
function stripXmlScaffolding(text: string): string {
  return text
    .replace(/<\/?(?:reasoning|thinking|analysis|decision)\b[^>]*>/gi, '')
    .replace(/^\s*```(?:json)?\s*$/gim, '')
    .replace(/\s*```\s*$/g, '')
    .trim();
}

/**
 * Pull the model's reasoning out of its response, trying progressively looser
 * strategies so that a formatting slip never loses the audit trail.
 */
export function extractCoTTrace(response: string): string {
  const text = stripInvisible(response);

  const tagged = /<reasoning>([\s\S]*?)<\/reasoning>/i.exec(text);
  if (tagged?.[1]?.trim()) return tagged[1].trim();

  // Same tag, but never closed — a truncated response.
  const unclosed = /<(?:reasoning|thinking|analysis)>([\s\S]*)$/i.exec(text);
  if (unclosed?.[1]?.trim()) return stripXmlScaffolding(unclosed[1]);

  const beforeDecision = text.split(/<decision>/i)[0];
  if (beforeDecision && beforeDecision.trim() && beforeDecision.trim() !== text.trim()) {
    return stripXmlScaffolding(beforeDecision);
  }

  const beforeJson = text.split(/```json/i)[0];
  if (beforeJson && beforeJson.trim() && beforeJson.trim().length < text.trim().length) {
    return stripXmlScaffolding(beforeJson);
  }

  return stripXmlScaffolding(text);
}

/* -------------------------------------------------------------------------- */
/*  Decision JSON extraction                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Find the first balanced `[...]` or `{...}` region in `text`, respecting
 * string literals and escapes. A naive `indexOf(']')` breaks on any `]` that
 * appears inside a symbol name or a reasoning string.
 */
function findBalancedJson(text: string): string | null {
  const startArray = text.indexOf('[');
  const startObject = text.indexOf('{');

  let start: number;
  let open: string;
  let close: string;

  if (startArray === -1 && startObject === -1) return null;
  if (startArray === -1 || (startObject !== -1 && startObject < startArray)) {
    start = startObject;
    open = '{';
    close = '}';
  } else {
    start = startArray;
    open = '[';
    close = ']';
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extract the JSON payload from a model response, trying in order:
 *  1. a fenced block inside `<decision>`
 *  2. a bare array inside `<decision>`
 *  3. any fenced ```json block
 *  4. the first balanced JSON value in the whole response
 */
export function extractDecisions(response: string): string | null {
  const text = repairEncoding(stripInvisible(response));

  /*
   * ⚠️ **提取必须限定在 `<decision>` 之后 —— 这是实测出来的一条。**
   *
   * 案例（#1623，2026-09-28 周期 390）：响应被截断（`reasoning` 字符串写到一半
   * 就没了，连 `</decision>` 都没有），而**响应前面还有别的 JSON 片段**
   * （模型自己的分析草稿）。`findBalancedJson()` 从**第一个 `[`** 开始扫描，
   * 于是从那个草稿开始、在**别处**凑巧找到了一个平衡点，返回一段
   * **"看起来合法、其实是错的"**内容 —— `JSON.parse` 失败 → **整轮零决策**，
   * 而模型真正要交付的内容就在下面几十行处。
   *
   * 模型承诺交付的东西一定写在 `<decision>` 之后，所以作用域先钉死在那里：
   * 有完整块就用块内，**没有闭合标签（截断）就用到文末**。
   */
  const openTag = /<decision>/i.exec(text);
  const decisionBlock = /<decision>([\s\S]*?)<\/decision>/i.exec(text);
  const body = decisionBlock?.[1] ?? (openTag ? text.slice(openTag.index + openTag[0].length) : text);

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fenced?.[1]?.trim()) return fenced[1].trim();
  const balanced = findBalancedJson(body);
  if (balanced) return balanced;

  const anyFence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (anyFence?.[1]?.trim()) {
    const inner = anyFence[1].trim();
    if (inner.startsWith('[') || inner.startsWith('{')) return inner;
  }

  return findBalancedJson(body) ?? salvageTruncatedDecisions(body);
}

/**
 * ⚠️ **截断抢救：从没写完的 JSON 里取回**已经完整的那些决策对象。
 *
 * ## 为什么需要它（实测：443 轮里 34 轮输出被截断）
 *
 * 2026-09-29 实测：`finish_reason=length`（输出被长度上限截断）出现 **34 次**，
 * 而"调用成功但没有产出任何决策"的轮次有 **41 轮** —— 数量高度吻合。
 *
 * 输出预算**不是我们设小的**（`max_tokens` 已经是 131072），实际在 ~58K tokens
 * 就被截断 —— 那是网关/模型侧的限制，**提高预算这条路走不通**。
 *
 * 而截断的形状是固定的：顶层数组没闭合，但**前面若干个 `{...}` 是完整的**：
 *
 * ```text
 * [{"symbol":"BTCUSDT","action":"wait",…},{"symbol":"ETHUSDT","action":"open_long",
 * ```
 *
 * `findBalancedJson()` 要求括号平衡，于是返回 `null` → **整轮一条决策都没有**。
 * 而前面那几条是模型真金白银推理出来的，丢掉它们等于这次调用白花。
 *
 * ## 它不放宽任何语义
 *
 * 这里只救**结构**：把完整的顶层对象重新拼成一个数组。拼好之后**每一个对象
 * 仍然要过与平时完全一样的语义校验**（未知 action、不在候选池、方向不符……
 * 见 `validateDecisions`）。截断处那个残缺对象**不会被收进来**。
 *
 * 只有"确实没闭合"时才走这条路；正常响应仍然由 `findBalancedJson()` 处理。
 */
function salvageTruncatedDecisions(text: string): string | null {
  const start = text.indexOf('[');
  if (start === -1) return null;
  /*
   * 只处理"以 `[` 开头、但**从未闭合**"的形状。
   * 如果它其实闭合了，`findBalancedJson()` 早就返回了，这里不该再插手。
   */
  const closed = findBalancedJson(text);
  if (closed !== null) return closed;

  const objects: string[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        objects.push(text.slice(objectStart, i + 1));
        objectStart = -1;
      }
      /* 深度塌到负数 = 这个数组其实已经闭合，交给上面那条路处理。 */
      if (depth < 0) return null;
    }
  }

  if (objects.length === 0) return null;
  return `[${objects.join(',')}]`;
}

/**
 * Did the response contain a `<decision>` block at all?
 *
 * Distinguished from "parsed an empty decision array": `[]` is a deliberate,
 * correct answer, whereas a missing block means the model never finished the
 * requested output — usually because it exhausted its output budget while
 * reasoning. Conflating the two hides a real misconfiguration.
 */
export function hasDecisionBlock(response: string): boolean {
  return /<decision>/i.test(stripInvisible(response));
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

export interface ParseContext {
  /** Symbols the model was actually shown this cycle. */
  candidateSymbols: ReadonlySet<string>;
  /** Currently open positions, keyed by symbol. */
  openPositions: ReadonlyMap<string, 'long' | 'short'>;
  /**
   * When true, a close for a symbol with no open position is dropped and the
   * symbol's absence from the candidate list is tolerated (the model may still
   * need to manage a position whose symbol fell out of the universe).
   */
  allowUnlistedCloses?: boolean;
  /**
   * **有挂单在等成交**的标的。
   *
   * ## 为什么 `cancel_pending` 必须豁免"必须在候选池里"那条
   *
   * 一条挂单最需要被撤掉的时候，往往**正是它掉出候选池的时候** ——
   * 那意味着"这一轮它不再是个机会了"，而当初挂它的理由也就不成立了。
   *
   * 原来那道检查只给**持仓**操作开口子（平仓/调保护/加减仓），挂单不在里面，
   * 于是：**标的掉出候选池 → 撤不掉它 → 它一直占着持仓名额。**
   * 这与"减仓/平仓不该受候选池约束"是同一条道理，只是对象从仓位变成了挂单。
   */
  pendingSymbols?: ReadonlySet<string>;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[%,\s]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Coerce one raw object into a `RawDecision`, tolerating the shapes models
 * actually produce: numbers as strings, `size` instead of `position_size_usd`,
 * `sl`/`tp` abbreviations, and so on.
 */
function coerceRawDecision(input: unknown): LenientDecision | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;

  const symbol = typeof o.symbol === 'string' ? o.symbol : typeof o.pair === 'string' ? o.pair : null;
  const action = typeof o.action === 'string' ? o.action.toLowerCase().trim() : null;
  if (!symbol || !action) return null;

  const candidate: Record<string, unknown> = {
    symbol: normalizeSymbol(symbol),
    action,
    leverage: toFiniteNumber(o.leverage ?? o.lev) ?? undefined,
    position_size_usd:
      toFiniteNumber(o.position_size_usd ?? o.positionSizeUsd ?? o.size_usd ?? o.size ?? o.notional) ??
      undefined,
    stop_loss: toFiniteNumber(o.stop_loss ?? o.stopLoss ?? o.sl) ?? undefined,
    take_profit: toFiniteNumber(o.take_profit ?? o.takeProfit ?? o.tp) ?? undefined,
    confidence: toFiniteNumber(o.confidence ?? o.conf) ?? undefined,
    risk_usd: toFiniteNumber(o.risk_usd ?? o.riskUsd ?? o.risk) ?? undefined,
    /*
     * 减仓的两个字段。**接受 camelCase 与下划线两种写法** ——
     * 其他字段都是这样做的（`position_size_usd ?? positionSizeUsd`），
     * 而模型输出哪个纯看它当天的习惯。只认一种的话，另一半写法会被静默丢弃，
     * 减仓会因为"两个都没给"而被拒 —— 而模型明明给了。
     */
    reduce_percent: toFiniteNumber(o.reduce_percent ?? o.reducePercent ?? o.percent) ?? undefined,
    reduce_quantity:
      toFiniteNumber(o.reduce_quantity ?? o.reduceQuantity ?? o.quantity) ?? undefined,
    /*
     * 入场方式。同样**接受两种写法**，理由与减仓那两个字段一样：
     * 模型输出 camelCase 还是下划线纯看它当天的习惯，只认一种就等于一半被静默丢弃。
     *
     * ⚠️ 这里的 `entry_type` 加得比字段本身更要紧 —— **宽容转换函数是解析的入口**，
     * 加在它后面的字段不会被它带出来。第一版我把它加在了调用点，于是 zod 认、
     * 而 `coerced` 里根本没有这两个键，限价入场永远是市价。
     */
    entry_type:
      typeof o.entry_type === 'string'
        ? o.entry_type.toLowerCase().trim()
        : typeof o.entryType === 'string'
          ? o.entryType.toLowerCase().trim()
          : undefined,
    limit_price:
      toFiniteNumber(o.limit_price ?? o.limitPrice ?? o.entry_price ?? o.entryPrice) ?? undefined,
    /*
     * ⚠️ **评分也要在这里搬一次 —— 上面那段注释说的就是这个坑，这是第二次踩。**
     *
     * 这里是解析的**入口**：`LenientDecisionSchema` 认哪些字段不算数，
     * **这个白名单里有什么才算数**。第一版 `entry_type` 加在了调用点，结果是
     * "zod 认、而 `coerced` 里根本没有这个键"；`setup_score` 一模一样 ——
     * 提示词要求模型打分、schema 也收了，而它在这一步被静默丢掉，
     * 于是统计里永远是 `null`，**看起来像"模型不肯打分"**。
     *
     * 同样接受两种写法：模型输出 camelCase 还是下划线，纯看它当天的习惯。
     */
    setup_score: toFiniteNumber(o.setup_score ?? o.setupScore) ?? undefined,
    setup_score_basis:
      typeof o.setup_score_basis === 'string'
        ? o.setup_score_basis
        : typeof o.setupScoreBasis === 'string'
          ? o.setupScoreBasis
          : undefined,
    reasoning: typeof o.reasoning === 'string' ? o.reasoning : typeof o.reason === 'string' ? o.reason : undefined,
  };

  const parsed = LenientDecisionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Parse, validate and normalise a model response into executable decisions.
 *
 * This function is deliberately forgiving about *structure* and strict about
 * *meaning*: a badly formatted response yields no decisions rather than a
 * malformed order. Numeric policy limits (clamping, sizing) belong to the risk
 * engine; anything rejected here is structurally impossible to execute.
 */
/**
 * 从模型输出里提取**它自己要求的"下一次什么时候再看盘"**（分钟）。
 *
 * ## 为什么这是"智能"与"定时机器人"的分界线（2026-10-02）
 *
 * 用户的原话：
 *
 *   「不是系统喂给 AI 什么，AI 就只能**定时定点**的去做，这不是智能，
 *     也不是 AI，这是传统机器人了。」
 *
 * 在此之前机器人只有一个节拍（配置里的 `cycleIntervalMinutes`）。
 * `next_check_in_minutes` 把它交给模型 —— **"什么时候值得再看一眼"
 * 本身就是交易判断的一部分**：等一个正在形成的突破要勤看，死水行情不必。
 *
 * ## 为什么从"任一元素"取、且取**最小**
 *
 * 决策输出是一个数组（每个标的一条），而这层语义是**轮级**的 ——
 * 模型不会（也不该）为每个标的分别指定看盘时间。所以：
 *
 *  · 数组里**任何一个**元素带了它，就视为本轮的要求；
 *  · 有多个时取**最小** —— 那是"最早醒"，也就是最保守的一侧。
 *    取最大会让"某个标的想盯着"被另一条的"两小时后"吞掉，从而**错过**。
 *
 * 返回值**不做边界钳制**（那是 `cycleSchedule.clampNextCheckMinutes` 的职责）——
 * 解析器只如实读出模型说了什么，钳制规则集中在一处。
 */
export function extractNextCheckMinutes(rawItems: readonly unknown[], root?: unknown): number | undefined {
  const seen: number[] = [];
  const read = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const raw = record['next_check_in_minutes'] ?? record['nextCheckInMinutes'];
    if (typeof raw === 'number' && Number.isFinite(raw)) seen.push(raw);
  };
  read(root);
  for (const item of rawItems) read(item);
  if (seen.length === 0) return undefined;
  return Math.min(...seen);
}

export function parseDecisionResponse(raw: string, ctx: ParseContext): ParsedDecisionSet {
  const cotTrace = extractCoTTrace(raw);
  const rejected: RejectedDecision[] = [];
  const decisions: Decision[] = [];

  const jsonText = extractDecisions(raw);
  if (!jsonText) {
    return {
      cotTrace,
      decisions: [],
      rawResponse: raw,
      rejected: [],
    };
  }

  const parsed = safeParseJson(jsonText);
  if (parsed === undefined) {
    log.warn('模型返回的 JSON 在自动修复之后仍无法解析', {
      preview: jsonText.slice(0, 300),
    });
    return { cotTrace, decisions: [], rawResponse: raw, rejected: [] };
  }

  // Accept a bare object, a single-element array, or the expected array.
  const rawItems: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { decisions?: unknown }).decisions)
      ? ((parsed as { decisions: unknown[] }).decisions)
      : [parsed];

  /*
   * ⚠️ **轮级的"下次看盘时间"** —— 在遍历决策之前先提取，
   * 因为它是整轮的属性，不属于任何一个标的（见 `extractNextCheckMinutes`）。
   * 它**不参与**单条决策的风控校验，所以不能等着被判为未知字段而丢掉。
   */
  const nextCheckInMinutes = extractNextCheckMinutes(rawItems, parsed);

  for (const item of rawItems) {
    const coerced = coerceRawDecision(item);
    if (!coerced) {
      log.debug('丢弃了一条无法解析的决策项', { item });
      continue;
    }

    const actionCheck = DecisionActionSchema.safeParse(coerced.action);
    if (!actionCheck.success) {
      rejected.push({
        symbol: coerced.symbol,
        action: coerced.action,
        reason: `未知的操作 "${coerced.action}"。应为以下之一：open_long、open_short、close_long、close_short、hold、wait。`,
      });
      continue;
    }
    const action: DecisionAction = actionCheck.data;

    // --- Symbol must be one the model was shown ---------------------------
    const isListed = ctx.candidateSymbols.has(coerced.symbol);
    const heldSide = ctx.openPositions.get(coerced.symbol);
    /*
     * **已经持有的仓位，即使这个币种不在本轮候选池里，也必须能操作它。**
     *
     * 候选池是"这一轮有什么机会"，而调保护位/平仓是"我手里这笔怎么办" ——
     * 后者不该受前者的约束。原来的条件只给 `isCloseAction` 开了口子，
     * 于是**对持仓调保护位时，币种一旦掉出候选池就会被拒**，
     * 而模型以为它把止损提上来了。
     */
    const isHeldPositionAction =
      Boolean(heldSide) &&
      (isCloseAction(action) || isAdjustAction(action) || isResizeAction(action));
    /*
     * ⚠️ **撤单也豁免候选池检查 —— 理由和平仓/调保护位一模一样。**
     *
     * 一条挂单最需要被撤的时候，往往正是它**掉出候选池**的时候（那意味着
     * 这一轮它不再是个机会，而当初挂它的理由也就不成立了）。
     * 不豁免的话：标的掉出候选池 → 撤不掉 → 它一直占着持仓名额。
     */
    const isPendingCancel =
      isCancelPendingAction(action) && Boolean(ctx.pendingSymbols?.has(coerced.symbol));
    if (!isListed && !(ctx.allowUnlistedCloses && isHeldPositionAction) && !isPendingCancel) {
      rejected.push({
        symbol: coerced.symbol,
        action,
        reason: `${coerced.symbol} 不在本周期的候选池中。`,
      });
      continue;
    }

    // --- Close actions must correspond to a real position -----------------
    if (isCloseAction(action)) {
      if (!heldSide) {
        rejected.push({
          symbol: coerced.symbol,
          action,
          reason: `无法执行 ${action}：${coerced.symbol} 没有可平仓的${action === 'close_long' ? '多头' : '空头'}持仓。`,
        });
        continue;
      }
      const wantsLong = action === 'close_long';
      if (wantsLong !== (heldSide === 'long')) {
        rejected.push({
          symbol: coerced.symbol,
          action,
          reason: `无法执行 ${action}：${coerced.symbol} 当前持仓方向是${heldSide === 'long' ? '多头' : '空头'}。`,
        });
        continue;
      }
    }

    // --- Open actions must not duplicate an existing position -------------
    if (isOpenAction(action) && heldSide) {
      rejected.push({
        symbol: coerced.symbol,
        action,
        reason: `无法 ${action} ${coerced.symbol}：已存在${heldSide === 'long' ? '多头' : '空头'}持仓（每个标的只允许一个仓位）。`,
      });
      continue;
    }

    /*
     * 入场方式。**只在开仓动作上才认它** —— 一个 `reduce_position` 带
     * `entry_type: 'limit'` 是无意义的，静默丢掉比执行一个没定义的行为安全。
     *
     * 缺 `limit_price` 的限价单**在这里就退回市价并说明**，而不是让一个
     * 没有价格的 `LIMIT` 单走到执行层 —— 那样交易所会拒，而错误会更难读。
     */
    const entryAdjustments: string[] = [];
    let entryType: 'market' | 'limit' = 'market';
    let limitPrice: number | null = null;
    if (isOpenAction(action)) {
      if (coerced.entry_type === 'limit') {
        if ((coerced.limit_price ?? 0) > 0) {
          entryType = 'limit';
          limitPrice = coerced.limit_price ?? null;
        } else {
          entryAdjustments.push('限价入场缺少合法的 limit_price，已按市价开盘。');
        }
      }
    }

    decisions.push({
      symbol: coerced.symbol,
      action,
      leverage: coerced.leverage ?? 0,
      positionSizeUsd: coerced.position_size_usd ?? 0,
      stopLoss: coerced.stop_loss ?? null,
      takeProfit: coerced.take_profit ?? null,
      /*
       * ⚠️ **缺失时是 `null`，不是 `0`。**
       *
       * 两者在界面上都会显示成"很低"，但含义相反：`0` 是"模型给了 0 分"，
       * `null` 是"模型根本没给这个字段"。实测模型只输出了
       * `symbol` / `action` / `reasoning`（提示词当时只给了开仓的范例），
       * 而这里填 `0` 让界面显示"置信度 0%"、让风控说着"置信度 0 低于门槛"。
       */
      confidence: coerced.confidence ?? null,
      riskUsd: coerced.risk_usd ?? 0,
      reducePercent: coerced.reduce_percent ?? null,
      reduceQuantity: coerced.reduce_quantity ?? null,
      /* 入场方式 —— 由上面那段算好（`entryAdjustments` 带说明）。 */
      entryType,
      limitPrice,
      reasoning: coerced.reasoning ?? '',
      /*
       * 评分与它的依据 —— **原样带过去，不做任何加工**。
       *
       * 它是模型自己的尺子：系统既不定义多少分算好，也不拿它去卡单
       * （开不开仍由模型的规则与风控决定）。系统只负责让它落库、
       * 并且能被 `get_skipped_outcomes` 取回来做对照。
       */
      setupScore: coerced.setup_score ?? null,
      setupScoreBasis: coerced.setup_score_basis ?? '',
      adjustments: entryAdjustments,
    });
  }

  return {
    cotTrace,
    decisions,
    rawResponse: raw,
    rejected,
    ...(nextCheckInMinutes === undefined ? {} : { nextCheckInMinutes }),
  };
}

/* -------------------------------------------------------------------------- */
/*  Execution ordering                                                         */
/* -------------------------------------------------------------------------- */

const ACTION_PRIORITY: Record<DecisionAction, number> = {
  // Freeing capital and cutting risk always comes before committing more.
  close_long: 1,
  close_short: 1,
  /*
   * 调保护位排在开仓**之前**。
   *
   * 理由与"平仓排最前"同源：**先把手里的仓位弄安全，再去冒险。**
   * 一个已经浮盈的仓位，把止损提上来比开新仓更紧急 ——
   * 反过来做的话，模型可能把这一轮的资金与额度用在新仓上，
   * 而那个该保护的老仓位一直裸着。
   */
  adjust_protection: 1,
  /*
   * 减仓与调保护位同层 —— 都是**降低已有仓位风险**的动作。
   *
   * 它排在加仓与新开仓之前：一个该减的仓位先减掉，
   * 再去考虑把资金投到哪里。反过来做的话，可能先加仓、再发现额度不够减仓
   * （虽然减仓不占额度，但顺序影响的是模型的思考顺序与执行日志的可读性）。
   */
  reduce_position: 1,
  /*
   * 撤单与它们同层：**它释放的是"已经承诺出去、但还没变成持仓"的敞口**。
   *
   * 排在开仓之前是刻意的 —— 如果模型这一轮既想撤掉一张等太久的单、
   * 又想在别处开新仓，那应该**先撤**：撤掉的额度可以给新机会用，
   * 而反过来（先开新仓、额度不够再撤）会让两件事互相挤。
   */
  cancel_pending: 1,
  /*
   * 加仓排在**新开仓之后**。
   *
   * 理由：一个新标的的机会是"从零到一"，而加仓是"在一笔已有敞口上再加"——
   * **后者的边际价值更低，风险却更集中**（同一标的的敞口翻倍）。
   * 所以先给新机会留出额度。
   */
  open_long: 2,
  open_short: 2,
  add_to_position: 3,
  hold: 4,
  wait: 4,
  /*
   * `skip` 排在最后 —— 它**什么都不产生**，所以顺序对它没有实质影响。
   *
   * 放在这里而不是省略，是因为类型是 `Record<DecisionAction, number>`：
   * 加动作而忘了给优先级会**编译不过**。那是刻意的 —— 排序是这个文件里
   * 唯一一处"新增动作必须表态"的地方，比注释更能拦住人。
   */
  skip: 5,
};

/**
 * Sort decisions into execution order: closes first, then opens, then no-ops.
 * A stable sort keeps the model's own ordering within each tier.
 */
export function sortDecisions(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => ACTION_PRIORITY[a.action] - ACTION_PRIORITY[b.action]);
}

export { OPEN_ACTIONS, CLOSE_ACTIONS, isOpenAction, isCloseAction };
