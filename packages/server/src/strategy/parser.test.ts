import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Decision } from '@aq/shared';
import {
  extractCoTTrace,
  extractDecisions,
  hasDecisionBlock,
  parseDecisionResponse,
  repairEncoding,
  sortDecisions,
  type ParseContext,
} from './parser.js';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function context(overrides: Partial<ParseContext> = {}): ParseContext {
  return {
    candidateSymbols: new Set(['BTCUSDT', 'ETHUSDT']),
    openPositions: new Map(),
    ...overrides,
  };
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    symbol: 'BTCUSDT',
    action: 'hold',
    leverage: 0,
    positionSizeUsd: 0,
    stopLoss: null,
    takeProfit: null,
    confidence: 0,
    riskUsd: 0,
    reasoning: '',
    adjustments: [],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Chain of thought                                                           */
/* -------------------------------------------------------------------------- */

test('extracts the chain of thought from a reasoning tag', () => {
  const raw = '<reasoning>BTC is trending up.\nOI is rising.</reasoning>\n<decision>[]</decision>';
  assert.equal(extractCoTTrace(raw), 'BTC is trending up.\nOI is rising.');
});

test('falls back to the text preceding the decision block', () => {
  const raw = 'I considered the trend carefully.\n<decision>[]</decision>';
  assert.equal(extractCoTTrace(raw), 'I considered the trend carefully.');
});

test('falls back to the whole response when nothing else is present', () => {
  assert.equal(extractCoTTrace('no structure here'), 'no structure here');
});

/* -------------------------------------------------------------------------- */
/*  JSON extraction                                                            */
/* -------------------------------------------------------------------------- */

test('extracts a fenced JSON block inside a decision tag', () => {
  const raw = '<decision>\n```json\n[{"symbol":"BTCUSDT","action":"hold"}]\n```\n</decision>';
  const extracted = extractDecisions(raw);
  assert.ok(extracted, 'should extract JSON from the fenced block');
  assert.ok(extracted.startsWith('['));
  assert.match(extracted, /BTCUSDT/);
});

test('extracts a bare array inside a decision tag', () => {
  const raw = '<decision>[{"symbol":"BTCUSDT","action":"hold"}]</decision>';
  assert.equal(extractDecisions(raw), '[{"symbol":"BTCUSDT","action":"hold"}]');
});

test('extracts a fenced block with no decision tag at all', () => {
  const raw = 'Here you go:\n```json\n[{"symbol":"ETHUSDT","action":"wait"}]\n```\nDone.';
  assert.equal(extractDecisions(raw), '[{"symbol":"ETHUSDT","action":"wait"}]');
});

test('extracts a bare array with surrounding prose', () => {
  const raw = 'Analysis follows. [{"symbol":"BTCUSDT","action":"hold"}] That is all.';
  assert.equal(extractDecisions(raw), '[{"symbol":"BTCUSDT","action":"hold"}]');
});

test('bracket matching ignores brackets inside string literals', () => {
  // A naive indexOf(']') would truncate at the "]" inside the reasoning string.
  const raw = '<decision>[{"symbol":"BTCUSDT","action":"hold","reasoning":"price broke [68000] support ]"}]</decision>';
  const extracted = extractDecisions(raw);
  assert.ok(extracted, 'should extract');
  const parsed = JSON.parse(extracted) as Array<{ reasoning: string }>;
  assert.match(parsed[0]!.reasoning, /broke \[68000\] support \]/);
});

test('returns null when there is no JSON at all', () => {
  assert.equal(extractDecisions('just prose, nothing structured'), null);
});

/* -------------------------------------------------------------------------- */
/*  Encoding repair                                                            */
/* -------------------------------------------------------------------------- */

test('repairs full-width and curly punctuation', () => {
  const broken = '｛"symbol"："BTCUSDT"，"action"："hold"｝';
  const repaired = repairEncoding(broken);
  assert.equal(JSON.parse(repaired).symbol, 'BTCUSDT');
});

test('survives curly quotes around keys and values', () => {
  const raw = '<decision>[{"symbol":"BTCUSDT","action":"hold","reasoning":"it\u2019s fine"}]</decision>';
  const parsed = parseDecisionResponse(raw, context());
  assert.equal(parsed.decisions.length, 1);
});

test('strips zero-width characters that break JSON.parse', () => {
  const raw = '[{"symbol":"BTC\u200BUSDT","action":"hold"}]';
  const parsed = parseDecisionResponse(raw, context());
  assert.equal(parsed.decisions[0]!.symbol, 'BTCUSDT');
});

test('repairs trailing commas', () => {
  const raw = '<decision>[{"symbol":"BTCUSDT","action":"hold",},]</decision>';
  const parsed = parseDecisionResponse(raw, context());
  assert.equal(parsed.decisions.length, 1);
});

/* -------------------------------------------------------------------------- */
/*  Shape tolerance                                                            */
/* -------------------------------------------------------------------------- */

test('accepts a single object where an array was requested', () => {
  const raw = '<decision>{"symbol":"BTCUSDT","action":"hold"}</decision>';
  const parsed = parseDecisionResponse(raw, context());
  assert.equal(parsed.decisions.length, 1);
  assert.equal(parsed.decisions[0]!.action, 'hold');
});

test('accepts a {decisions:[...]} wrapper', () => {
  const raw = '<decision>{"decisions":[{"symbol":"BTCUSDT","action":"hold"}]}</decision>';
  const parsed = parseDecisionResponse(raw, context());
  assert.equal(parsed.decisions.length, 1);
});

test('accepts the model\'s abbreviated field names', () => {
  const raw = `<decision>[{
    "symbol": "btc/usdt",
    "action": "OPEN_LONG",
    "lev": "5",
    "size": "150",
    "sl": 64000,
    "tp": "72000",
    "conf": "82",
    "risk": "12.5",
    "reason": "breakout"
  }]</decision>`;
  const parsed = parseDecisionResponse(raw, context());
  assert.equal(parsed.decisions.length, 1);
  const d = parsed.decisions[0]!;
  assert.equal(d.symbol, 'BTCUSDT', 'symbol should be normalised');
  assert.equal(d.action, 'open_long', 'action should be lower-cased');
  assert.equal(d.leverage, 5);
  assert.equal(d.positionSizeUsd, 150);
  assert.equal(d.stopLoss, 64_000);
  assert.equal(d.takeProfit, 72_000);
  assert.equal(d.confidence, 82);
  assert.equal(d.riskUsd, 12.5);
  assert.equal(d.reasoning, 'breakout');
});

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

test('rejects an unknown action', () => {
  const raw = '<decision>[{"symbol":"BTCUSDT","action":"buy_the_dip"}]</decision>';
  const parsed = parseDecisionResponse(raw, context());
  assert.equal(parsed.decisions.length, 0);
  assert.equal(parsed.rejected.length, 1);
  assert.match(parsed.rejected[0]!.reason, /未知的操作/);
});

test('rejects a symbol outside the candidate universe', () => {
  const raw = '<decision>[{"symbol":"DOGEUSDT","action":"open_long"}]</decision>';
  const parsed = parseDecisionResponse(raw, context());
  assert.equal(parsed.decisions.length, 0);
  assert.match(parsed.rejected[0]!.reason, /不在本周期的候选池中/);
});

test('rejects opening a second position on a symbol already held', () => {
  const raw = '<decision>[{"symbol":"BTCUSDT","action":"open_long"}]</decision>';
  const parsed = parseDecisionResponse(
    raw,
    context({ openPositions: new Map([['BTCUSDT', 'long']]) }),
  );
  assert.equal(parsed.decisions.length, 0);
  assert.match(parsed.rejected[0]!.reason, /每个标的只允许一个仓位/);
});

test('rejects a close when nothing is open', () => {
  const raw = '<decision>[{"symbol":"BTCUSDT","action":"close_long"}]</decision>';
  const parsed = parseDecisionResponse(raw, context());
  assert.equal(parsed.decisions.length, 0);
  assert.match(parsed.rejected[0]!.reason, /没有可平仓的/);
});

test('rejects a close that contradicts the held direction', () => {
  const raw = '<decision>[{"symbol":"BTCUSDT","action":"close_long"}]</decision>';
  const parsed = parseDecisionResponse(
    raw,
    context({ openPositions: new Map([['BTCUSDT', 'short']]) }),
  );
  assert.equal(parsed.decisions.length, 0);
  assert.match(parsed.rejected[0]!.reason, /当前持仓方向是空头/);
});

test('accepts a close that matches the held direction', () => {
  const raw = '<decision>[{"symbol":"BTCUSDT","action":"close_long"}]</decision>';
  const parsed = parseDecisionResponse(
    raw,
    context({ openPositions: new Map([['BTCUSDT', 'long']]) }),
  );
  assert.equal(parsed.decisions.length, 1);
});

test('allows a close for a held symbol that fell out of the candidate list', () => {
  const raw = '<decision>[{"symbol":"SOLUSDT","action":"close_short"}]</decision>';
  const parsed = parseDecisionResponse(
    raw,
    context({ openPositions: new Map([['SOLUSDT', 'short']]), allowUnlistedCloses: true }),
  );
  assert.equal(parsed.decisions.length, 1);
});

test('hold and wait pass through untouched', () => {
  const raw = '<decision>[{"symbol":"BTCUSDT","action":"hold"},{"symbol":"ETHUSDT","action":"wait"}]</decision>';
  const parsed = parseDecisionResponse(raw, context());
  assert.equal(parsed.decisions.length, 2);
});

test('a totally malformed response yields no decisions but keeps the reasoning', () => {
  const raw = '<reasoning>I could not decide.</reasoning>\n<decision>not json at all</decision>';
  const parsed = parseDecisionResponse(raw, context());
  assert.equal(parsed.decisions.length, 0);
  assert.equal(parsed.cotTrace, 'I could not decide.');
  assert.equal(parsed.rawResponse, raw, 'the raw response must always be retained for audit');
});

/* -------------------------------------------------------------------------- */
/*  Truncated responses                                                        */
/* -------------------------------------------------------------------------- */

test('a truncated reasoning block is cleaned of its XML tag', () => {
  // A model that exhausts its output budget while reasoning never closes the tag.
  // The paired regex cannot match, so without the unclosed-tag fallback the
  // operator would be shown raw XML as the chain of thought.
  const raw = '<reasoning>\n4H 偏空，1H 极度超卖。\n决定观望，不采取动作。';
  const cot = extractCoTTrace(raw);
  assert.equal(cot.startsWith('<reasoning>'), false, 'the opening tag must be stripped');
  assert.match(cot, /4H 偏空/);
});

test('a truncated response is distinguishable from a deliberate empty decision', () => {
  // `[]` inside a <decision> block is a correct "no opportunity" answer.
  assert.equal(hasDecisionBlock('<reasoning>没有机会。</reasoning><decision>[]</decision>'), true);

  // Reasoning with no decision block at all means the model never finished —
  // usually because it ran out of output budget mid-thought.
  assert.equal(hasDecisionBlock('<reasoning>分析到一半就被截断了'), false);

  const parsed = parseDecisionResponse('<reasoning>分析到一半就被截断了', context());
  assert.equal(parsed.decisions.length, 0);
  assert.equal(parsed.cotTrace.startsWith('<reasoning>'), false);
});

/* -------------------------------------------------------------------------- */
/*  Ordering                                                                   */
/* -------------------------------------------------------------------------- */

test('sorts closes before opens before no-ops', () => {
  const sorted = sortDecisions([
    decision({ symbol: 'BTCUSDT', action: 'wait' }),
    decision({ symbol: 'ETHUSDT', action: 'open_long' }),
    decision({ symbol: 'BTCUSDT', action: 'close_long' }),
    decision({ symbol: 'ETHUSDT', action: 'hold' }),
  ]);
  assert.deepEqual(
    sorted.map((d) => d.action),
    ['close_long', 'open_long', 'wait', 'hold'],
  );
});

test('sorting is stable within a tier', () => {
  const sorted = sortDecisions([
    decision({ symbol: 'BTCUSDT', action: 'open_long' }),
    decision({ symbol: 'ETHUSDT', action: 'open_long' }),
  ]);
  assert.deepEqual(
    sorted.map((d) => d.symbol),
    ['BTCUSDT', 'ETHUSDT'],
  );
});
