import {
  CLOSE_ACTIONS,
  DecisionActionSchema,
  OPEN_ACTIONS,
  RawDecisionSchema,
  isCloseAction,
  isOpenAction,
  normalizeSymbol,
  type Decision,
  type DecisionAction,
  type ParsedDecisionSet,
  type RejectedDecision,
} from '@aq/shared';import { z } from 'zod';
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

function safeParseJson(text: string): unknown {
  const candidates = [text, repairJsonStructure(text)];
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

  const decisionBlock = /<decision>([\s\S]*?)<\/decision>/i.exec(text);
  if (decisionBlock?.[1]) {
    const inner = decisionBlock[1];
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(inner);
    if (fenced?.[1]?.trim()) return fenced[1].trim();
    const balanced = findBalancedJson(inner);
    if (balanced) return balanced;
  }

  const anyFence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (anyFence?.[1]?.trim()) {
    const inner = anyFence[1].trim();
    if (inner.startsWith('[') || inner.startsWith('{')) return inner;
  }

  return findBalancedJson(text);
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
    log.warn('model returned JSON that could not be parsed after repair', {
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

  for (const item of rawItems) {
    const coerced = coerceRawDecision(item);
    if (!coerced) {
      log.debug('dropped an unparseable decision entry', { item });
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
    if (!isListed && !(ctx.allowUnlistedCloses && isCloseAction(action) && heldSide)) {
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

    decisions.push({
      symbol: coerced.symbol,
      action,
      leverage: coerced.leverage ?? 0,
      positionSizeUsd: coerced.position_size_usd ?? 0,
      stopLoss: coerced.stop_loss ?? null,
      takeProfit: coerced.take_profit ?? null,
      confidence: coerced.confidence ?? 0,
      riskUsd: coerced.risk_usd ?? 0,
      reasoning: coerced.reasoning ?? '',
      adjustments: [],
    });
  }

  return { cotTrace, decisions, rawResponse: raw, rejected };
}

/* -------------------------------------------------------------------------- */
/*  Execution ordering                                                         */
/* -------------------------------------------------------------------------- */

const ACTION_PRIORITY: Record<DecisionAction, number> = {
  // Freeing capital and cutting risk always comes before committing more.
  close_long: 1,
  close_short: 1,
  open_long: 2,
  open_short: 2,
  hold: 3,
  wait: 3,
};

/**
 * Sort decisions into execution order: closes first, then opens, then no-ops.
 * A stable sort keeps the model's own ordering within each tier.
 */
export function sortDecisions(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => ACTION_PRIORITY[a.action] - ACTION_PRIORITY[b.action]);
}

export { OPEN_ACTIONS, CLOSE_ACTIONS, isOpenAction, isCloseAction };
