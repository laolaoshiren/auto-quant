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
 *  1. a fenced block inside `<decision>`（裸 JSON）
 *  2. a bare array inside `<decision>`
 *  3. 围栏内容**带前缀说明**时，在围栏内部再找一次平衡 JSON
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
  const fencedText = fenced?.[1]?.trim();
  if (fencedText) {
    /*
     * ⚠️ **围栏里的内容不一定就是裸 JSON**（外部 issue #160）。
     *
     * 模型经常在围栏里先写一句说明再给 JSON：
     *
     * ```text
     *   ```json
     *   分析如下:
     *   [{"symbol":"BTCUSDT","action":"wait"}]
     *   ```
     * ```
     *
     * 原实现把这一整段（含"分析如下:"）当作 JSON 返回，于是 `safeParseJson` 失败
     * → **整轮零决策**，而模型真正要交付的内容就在下一行。
     * 实测：`决策数 = 0`，日志写"模型返回的 JSON 在自动修复之后仍无法解析"。
     *
     * ## 这里原来有一层"死代码兜底"
     *
     * 原来的第 3 步是**同一个正则对同一个 `body`** 再求值一次：
     *
     * ```ts
     * const anyFence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);   // ← 与第 1 步同一正则、同一输入
     * if (anyFence?.[1]?.trim()) { … }                                // ← 永不可达
     * ```
     *
     * `fenced[1] === anyFence[1]` 恒成立：第 1 步的非空判定一旦为假，
     * 第 3 步的同一个判定也为假；一旦为真，第 1 步早已 return。
     * 所以那层"兜底"**一层保护都没提供**，却让人以为容错有三层
     *（issue #160 的原话：后续真要加抢救逻辑时，可能误以为这里已经处理过了）。
     *
     * 现在把**那层原本的意图真正实现**：围栏内容不是裸 JSON 时，
     * **在围栏内部**再找一次平衡 JSON。作用域仍限定在围栏里 ——
     * 不会退化成"去整份响应里乱找"（那正是本函数开头那段注释警告过的坑）。
     */
    if (fencedText.startsWith('[') || fencedText.startsWith('{')) return fencedText;
    const insideFence = findBalancedJson(fencedText);
    if (insideFence) return insideFence;
  }
  const balanced = findBalancedJson(body);
  if (balanced) return balanced;

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
function coerceRawDecision(
  input: unknown,
  /*
   * ⚠️ **降级痕迹的出口**（2026-10-15 加）。
   *
   * 这个函数把"认不出的 `entry_type`"归一成 `undefined`（= 市价）来**保住整条决策**，
   * 但那样一来"模型原本写了什么"就丢了 —— 而 `log.warn` 只进日志、**不进数据库与界面**。
   *
   * 所以这里用一个 out-param 把说明带出去，由调用点写进 `Decision.adjustments`
   *（与"限价缺价退回市价"同一口径）——
   * 否则就是**又一次"注释说留痕、代码没留痕"**（这个仓库反复记过的形态）。
   */
  notes: string[] = [],
): LenientDecision | null {
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
     *
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **非法值必须降级，不能让它把整条决策带走**（2026-10-15 修）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 事故：模型写错一个枚举值，**整条决策凭空消失**
     *
     * 原来这里原样透传字符串，而 `RawDecisionSchema.entry_type` 是
     * `z.enum(['market','limit'])` —— 于是模型写 `"entryType":"skip"` 时：
     * ```
     *   LenientDecisionSchema.safeParse(candidate) 失败
     *   → coerceRawDecision 返回 null
     *   → 调用点 `if (!coerced) continue;`（只有一行 log.debug）
     *   → 【既不入 decisions，也不入 rejected】
     *   ⇒ 界面上只显示"本轮无动作"，而模型明明给了决策
     * ```
     * 实测线上 **12 条命中**（cyc 70 六条、cyc 84 六条，全是 `"entryType":"skip"`），
     * 那两轮的 `decisions_json` 都是 `[]`。
     *
     * ⚠️ **线上恰好只命中 `skip`（损失为零）**，但同样的形状命中开仓就是**丢单**：
     * ```
     *   跑真实代码验证：open_long + entryType:"skip" → decisions=0 rejected=0
     * ```
     *
     * ## 为什么"降级为市价"是正确方向
     *
     * `entry_type` 是"怎么进"的**提示**，不是"要不要进"的**决定**：
     * ```
     *   · 省略它      → 市价（既有行为，schema 注释写明了）
     *   · 给它一个认不出的值 → 与"省略"最接近的语义就是【按默认的市价走】
     *   · 而丢弃整条  → 把"怎么进"的分歧升级成"不进"，那是越权
     * ```
     * 一个 `open_long` 的意图不该因为一个入场方式的拼写问题而消失。
     *
     * ⚠️ 同时**必须留下痕迹** —— 否则"模型给了 skip 而我们按市价开了"
     * 会变成另一件静默的事（这个仓库反复记过这条教训）。
     * 痕迹走 `adjustments`，与"限价缺价退回市价"同一口径。
     */
    entry_type: (() => {
      const raw =
        typeof o.entry_type === 'string'
          ? o.entry_type
          : typeof o.entryType === 'string'
            ? o.entryType
            : undefined;
      if (raw === undefined) return undefined;
      const v = raw.toLowerCase().trim();
      if (v === 'market' || v === 'limit') return v;
      /*
       * ⚠️ 认不出的值 → 归一成 `undefined`（= 市价）。
       * **不能原样返回** —— 那会让 zod 失败、整条决策被丢。
       */
      log.warn('入场方式 entry_type 是认不出的值，已按市价处理', {
        symbol: typeof o.symbol === 'string' ? o.symbol : undefined,
        entry_type: raw,
      });
      /*
       * ⚠️ 痕迹**同时**进 `adjustments`（那才走数据库与界面）——
       * 只写日志等于静默：生产日志级别看不到 debug，而 warn 也不进审计记录。
       * 这一条是我自己第一版的疏漏（注释写着"必须留下痕迹"，代码只写了日志）。
       */
      notes.push(`入场方式 "${raw}" 不是 market/limit 之一，已按市价开盘。`);
      return undefined;
    })(),
    limit_price:
      toFiniteNumber(o.limit_price ?? o.limitPrice ?? o.entry_price ?? o.entryPrice) ?? undefined,
    /*
     * 这一张挂单模型愿意等多久。**必须在 `coerced` 里搬一次** ——
     * 这一段上方已经为 `entry_type` 与 `setup_score` 各写过一次同样的教训：
     * zod 认、而这个白名单里没有的键会被**静默丢掉**，
     * 表现成"模型给了、而统计里永远是 null"。
     */
    wait_minutes: toFiniteNumber(o.wait_minutes ?? o.waitMinutes) ?? undefined,
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
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **`intel_keys` 必须在这里搬一次**（2026-10-15 修 —— 第四次踩同一个坑）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 事故：整条「情报归因 → 信号失效检测」链**从未通电**
     *
     * 上游全都写好了：
     * ```
     *   `decision.ts:233`   RawDecisionSchema 收了 `intel_keys`
     *   `parser.ts:874`     用它构造 `intelKeys`（有去重与过滤）
     *   `repositories.ts`   positions.intel_keys / trades.intel_keys 两列都在
     *   `tradingDesk.ts:2010` 提示词要求裁决官标注
     *   `signalHealth.ts`  按 signalKey 分组算胜率崩塌 / 反应衰减
     * ```
     * 但**这个白名单里没有它** —— 于是 `coerced.intel_keys` 永远是 `undefined`，
     * `parser.ts:874` 那个分支**永远不成立**。实测线上：
     * ```
     *   225 轮 raw_response 里 `intel_keys` 出现 0 次（提示词没要求，见断点②）
     *   trades / positions 的 intel_keys：三个机器人共 500+ 行，【全部为 []】
     *   ⇒ `signalHealth` 永远 insufficient_data
     * ```
     *
     * ## 这正是上面那三段注释各自记过的坑（`entry_type` / `wait_minutes` / `setup_score`）
     *
     * 它们三段的原话都是同一句：
     * > 「zod 认、而这个白名单里没有的键会被**静默丢掉**，
     * >   表现成"模型给了、而统计里永远是 null"」
     *
     * **这是第四次**。所以这一次除了加字段，还加了一条测试从
     * `RawDecisionSchema` 的键**反查**这个白名单（见 `parserCoerceCoverage.test.ts`）——
     * 判据必须能从事实来源自动发现漏项，而不是靠下一个人记得。
     *
     * ⚠️ 它是**字符串数组**，与上面那些数字/字符串字段不同：
     * 要收数组、逐个过滤成非空字符串、并**去重**（模型常重复列同一个键）。
     */
    intel_keys: Array.isArray(o.intel_keys)
      ? o.intel_keys
      : Array.isArray(o.intelKeys)
        ? o.intelKeys
        : undefined,
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
 *
 * ## ⚠️ 为什么用循环求最小值，而不是 `Math.min(...seen)`
 *
 * 展开运算符会把数组长度变成**实参个数**，而实参受 V8 的栈上限约束：
 * 实测（node 22）约 **125219 个**就抛 `RangeError: Maximum call stack size exceeded`。
 *
 * 而 `rawItems` 是**模型返回的决策数组**，长度完全由模型决定 ——
 * 模型输出是不可信输入（docs/AGENTS.md §2.4）。更要命的是本函数在
 * `parseDecisionResponse` 内、**遍历决策之前**被调用，所以异常会让整轮
 * `parsed` 整个拿不到：**一条决策都不会执行**，连续失败还会把机器人推进 `safe_mode`。
 *
 * 一个循环既没有实参上限，也不改变"取最小 = 最早醒"的语义。
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

  let min = seen[0] as number;
  for (const value of seen) {
    if (value < min) min = value;
  }
  return min;
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
    /*
     * ⚠️ `coerceNotes` 收集"宽容转换时做过的降级"（例如认不出的 `entry_type`
     * 被归一成市价）—— 它们必须进 `Decision.adjustments`，**不能只写日志**。
     * 见 `coerceRawDecision` 的 `notes` 参数说明。
     */
    const coerceNotes: string[] = [];
    const coerced = coerceRawDecision(item, coerceNotes);
    if (!coerced) {
      /*
       * ══════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **解析不出来的项也必须进 `rejected`**（2026-10-15 修）
       * ══════════════════════════════════════════════════════════════════════
       *
       * 原来这里只有一行 `log.debug(...)` + `continue` —— 于是那条决策
       * **既不入 `decisions`，也不入 `rejected`**，在界面上表现为
       * "本轮无动作"，而模型其实给了东西。
       *
       * 实测线上 12 条命中（`entryType: "skip"` 让 zod 失败）——
       * 那两轮的 `decisions_json` 都是 `[]`，而 `<decision>` 块里明明有 6 条。
       *
       * ## 为什么这比"拒绝"更糟
       *
       * `rejected` 的用途就是"**说清模型要了什么、而系统为什么没做**"。
       * 一条既不执行、也不解释的决策，让操作员**无法分辨**：
       * ```
       *   ① 模型这一轮没给决策（真的观望）
       *   ② 模型给了，但被我们的解析器吃掉了（BUG）
       * ```
       * 而这两件事的处理方式完全相反。
       *
       * ⚠️ `log.debug` 在这里不够 —— 生产环境的日志级别看不到它，
       * 而 `rejected` 是**进数据库、进界面**的那条路径。
       */
      const loose = (item ?? {}) as Record<string, unknown>;
      const sym = typeof loose['symbol'] === 'string' ? loose['symbol'] : '（未给出标的）';
      log.warn('丢弃了一条无法解析的决策项（已记入 rejected，不再是静默）', { item });
      rejected.push({
        symbol: sym,
        action: typeof loose['action'] === 'string' ? loose['action'] : '（未给出操作）',
        reason:
          '这条决策的字段没能通过解析（例如 entry_type 之类的枚举值不在允许范围内）。' +
          '它**没有被执行**，但也不是"模型没给" —— 原始内容见本轮 rawResponse。',
      });
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
    const entryAdjustments: string[] = [
      /*
       * ⚠️ **宽容转换阶段做的降级排在最前**（2026-10-15）——
       * 它们发生在解析的最早一步，所以顺序上也该最先被看到。
       */
      ...coerceNotes,
    ];
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
      /* 只有限价单才有"等多久"可言 —— 市价单立即成交，等多久无意义。 */
      waitMinutes: entryType === 'limit' ? (coerced.wait_minutes ?? null) : null,
      /*
       * **这条决策依据了哪几条情报**（2026-10-12 新增）。
       *
       * ⚠️ 只在模型真的给了且非空时才带上这个键 ——
       * 纯技术面决策**不写它**，于是 `Decision` 的形状与改动前一致
       *（这是"增量更新"的硬要求：省略时行为完全不变）。
       *
       * ⚠️ **校验留在这里还是留给调用方？**
       * 这里**只做形状校验**（非空字符串、去重）；"是不是我们给过它的情报"
       * 需要**那次调用的情报列表** —— 那个信息不在解析器手上，
       * 所以由调用方用 `filterKnownIntelKeys()` 再校验一遍。
       * 两处分工：解析器保证"格式对"，调用方保证"没编造"。
       */
      ...(Array.isArray(coerced.intel_keys) && coerced.intel_keys.length > 0
        ? { intelKeys: [...new Set(coerced.intel_keys.filter((k) => typeof k === 'string' && k.length > 0))] }
        : {}),
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
