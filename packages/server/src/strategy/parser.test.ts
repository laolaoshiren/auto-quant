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
reducePercent: null,
reduceQuantity: null,
    setupScore: null,
    setupScoreBasis: '',
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

test('★ 响应被截断、且前面还有别的 JSON 片段时，提取必须落在 <decision> 之后', () => {
  /*
   * 实测（#1623，2026-09-28 周期 390）：响应被截断（`reasoning` 字符串写到一半
   * 就没了，连 `</decision>` 都没有），而**前面还有模型自己分析用的 JSON 片段**。
   *
   * `findBalancedJson()` 从**第一个 `[`** 开始扫描 —— 于是它从那个草稿开始、
   * 在**别处**凑巧找到平衡点，返回一段"看起来合法、其实是错的"内容 →
   * `JSON.parse` 失败 → **整轮零决策**，而模型真正要交付的内容就在几十行之下。
   *
   * 所以提取必须先限定在 `<decision>` 之后。
   */
  const truncated =
    '分析如下：候选池 ["BTCUSDT","ETHUSDT"] 里 ETH 的结构更好。\n' +
    '<decision>\n```json\n[\n  {"symbol":"XRPUSDT","action":"hold","reasoning":"结构未坏"},' +
    '{"symbol":"SOLUSDT","action":"open_short","reasoning":"贴'; // ← 在这里被截断

  const extracted = extractDecisions(truncated);
  assert.ok(extracted, '必须能提取出东西');
  assert.ok(
    !extracted.includes('"BTCUSDT"'),
    '★ 不能把 <decision> 之前那段草稿当成决策 —— 那是 #1623 里发生的事',
  );
  const parsed = JSON.parse(extracted) as Array<{ symbol: string }>;
  assert.equal(parsed.length, 1, '只救回完整的那一条');
  assert.equal(parsed[0]!.symbol, 'XRPUSDT', '救回的是模型真正交付的那一条');
});

test('★ 输出被截断时，已经完整的决策要被救回来（而不是整轮丢掉）', () => {
  /*
   * 实测（2026-09-29）：443 轮里 `finish_reason=length`（输出被长度上限截断）
   * 出现 **34 次**，而"调用成功但没有产出任何决策"的轮次有 **41 轮** —— 高度吻合。
   *
   * 预算不是我们设小的（`max_tokens` 已是 131072），实际在 ~58K tokens 就被截断，
   * 那是网关/模型侧的限制。截断的形状固定：顶层数组没闭合，但**前面若干个对象是完整的**。
   * `findBalancedJson()` 要求括号平衡 → 返回 null → **整轮一条决策都没有**。
   *
   * 而前面那几条是模型真金白银推理出来的，丢掉它们等于这次调用白花。
   */
  const truncated =
    '<decision>[{"symbol":"BTCUSDT","action":"wait","reasoning":"等回踩"},' +
    '{"symbol":"ETHUSDT","action":"open_long","reasoning":"突破量能还没走完';
  const extracted = extractDecisions(truncated);

  assert.ok(extracted, '截断也必须能提取出东西 —— 否则整轮白花');
  const parsed = JSON.parse(extracted) as Array<{ symbol: string; action: string }>;
  assert.equal(parsed.length, 1, '★ 只救回完整的那一个：截断处那个残缺对象不能收');
  assert.equal(parsed[0]!.symbol, 'BTCUSDT');
  assert.equal(parsed[0]!.action, 'wait');

  /* 反面：完整的响应仍然由原来的路径处理，长度不变。 */
  const complete = '<decision>[{"symbol":"BTCUSDT","action":"wait","reasoning":"等"}]</decision>';
  assert.equal((JSON.parse(extractDecisions(complete)!) as unknown[]).length, 1);

  /* 反面：连一个完整对象都没有时，仍然返回 null（不凭空造）。 */
  assert.equal(
    extractDecisions('<decision>[{"symbol":"BTCUSDT","action":"wa'),
    null,
    '半个对象都算不上完整，不能硬塞进校验',
  );
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
/*  ★ `skip` 与 `setup_score`：把"我否掉了它"变成可校准的数字                    */
/* -------------------------------------------------------------------------- */

test('★ skip 带着评分一起被解析出来 —— 门槛要靠它才有对错可言', () => {
  /*
   * Why this test exists —— 用户的原话是「复盘不够智能」。
   *
   * 查下去发现：复盘的工具（`get_skipped_outcomes`）齐备，模型也确实在调用它 ——
   * 缺的是**一个可比的量**。它每轮否掉十几个标的，却从不给它们打分，于是那个
   * 工具只能告诉它"这些后来涨了"，回答不了真正的问题：「我的线是不是划高了」。
   *
   * 这个用例钉的是那条链路的第一环：`setup_score` / `setup_score_basis` 必须真的
   * 从模型的 JSON 走到 `Decision` 上。**解析器漏掉它，后面所有校准都是空的** ——
   * 而且不会报错，只会一直返回 `null`，看起来像"模型没给"。
   */
  const raw =
    '<decision>[' +
    '{"symbol":"MUBARAKUSDT","action":"skip","setup_score":58,' +
    '"setup_score_basis":"抛物线中段，止损无处可放","confidence":70,"reasoning":"不追高"},' +
    '{"symbol":"BTCUSDT","action":"wait","setup_score":44,"confidence":60,"reasoning":"箱体震荡"}' +
    ']</decision>';
  const parsed = parseDecisionResponse(
    raw,
    context({ candidateSymbols: new Set(['MUBARAKUSDT', 'BTCUSDT']) }),
  );

  assert.equal(parsed.decisions.length, 2, `两条都该被接受，实际：${JSON.stringify(parsed.rejected)}`);
  const skipped = parsed.decisions.find((d) => d.symbol === 'MUBARAKUSDT')!;
  assert.equal(skipped.action, 'skip');
  assert.equal(skipped.setupScore, 58, '★ 分数必须被解析出来');
  /*
   * 用 `match` 而不是 `equal`：解析器有一条**既有的全角标点修复**
   * （`repairEncoding`），中文逗号会被规范化成半角。那是它的正常工作，
   * 与本次改动无关 —— 这里钉的是"依据原文带过来了"，不是标点形态。
   */
  assert.match(skipped.setupScoreBasis, /抛物线中段/);
  assert.match(skipped.setupScoreBasis, /止损无处可放/);
  /*
   * `confidence` 与 `setup_score` 是**两个问题**，不能互相顶替：
   * 上面对"不追高"这个**决策**很确定（70），而对**这个标的**只给了 58 ——
   * 一个"这次不做、但值得盯着"的正常判断。
   */
  assert.equal(skipped.confidence, 70);

  const waited = parsed.decisions.find((d) => d.symbol === 'BTCUSDT')!;
  assert.equal(waited.setupScore, 44);
  assert.equal(waited.setupScoreBasis, '', '没给依据时是空串，不是 undefined');
});

test('没给 setup_score 时是 null，不是 0', () => {
  // 与 `confidence` 同一条约定：`0` 是"它打了零分"，`null` 是"它没打"。
  // 混起来会让"没要求打分时期的旧记录"在统计里被当成一堆 0 分。
  const parsed = parseDecisionResponse(
    '<decision>[{"symbol":"BTCUSDT","action":"hold"}]</decision>',
    context(),
  );
  assert.equal(parsed.decisions[0]!.setupScore, null);
  assert.equal(parsed.decisions[0]!.setupScoreBasis, '');
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

test('★ 推理里的 JSON 不是决策：没有 <decision> 块时交易路径必须拒绝整轮', () => {
  /*
   * 这条用例来自一次代码审查发现的洞，而那个洞是**真的会让钱出去**的。
   *
   * `parseDecisionResponse` 在找不到 `<decision>` 时会逐步放宽，最后退到
   * "整段回复里第一个括号配平的区域"。那是为**诊断**路径设计的宽容
   * （健康检查要能回答"模型到底吐了什么"），但系统提示词自己就带着两份
   * **字段完整、confidence 82/78** 的决策范例 —— 模型在推理里回显或假设
   * 一个 JSON 非常常见。
   *
   * 于是"响应被截断、没写出 `<decision>`"这一种失败，会变成"从推理里捡出
   * 一个看起来合法的提案送进风控"。交易路径原来没有检查块的存在性（只有
   * `healthCheck.ts` 检查），所以两个路径对同一次失败给出相反的判定。
   *
   * ⚠️ 这条用例钉的是**判据**（`hasDecisionBlock`）。真正的护栏是
   * `autoTrader.ts` 在 parse 之前那段 `throw` —— 删除它，这条用例不会变红。
   * 所以下面加了反证：**说明"不检查"会导致真的解析出一条提案。**
   */
  const leaked = [
    '<reasoning>',
    '我倾向于开多。参考格式：',
    '{"symbol":"BTCUSDT","action":"open_long","confidence":82,"position_size_usd":150,',
    '"stop_loss":79000,"take_profit":83000}',
    '但还没想完就被截断了',
  ].join('\n');

  assert.equal(hasDecisionBlock(leaked), false, '没有 <decision> 块 → 判据必须为 false');

  /*
   * 反证。这条断言**故意断言兜底路径是宽的** —— 它与上面那条一起构成
   * "必须检查块存在性"的完整理由。如果它哪天变成 0 条，说明兜底变严了，
   * 交易路径那道闸就不再是唯一的防线，那时应当重新评估（而不是默默删掉这条）。
   */
  const parsed = parseDecisionResponse(leaked, context());
  assert.ok(
    parsed.decisions.length > 0,
    '兜底没有从推理里捡出提案 —— 若这是有意收紧的，请连同 autoTrader 那道闸一起重新评估',
  );
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

/* -------------------------------------------------------------------------- */
/*  字符串里的【裸换行】：实盘曾让整轮决策被丢成 []                                */
/* -------------------------------------------------------------------------- */

test('★ 字符串内部的换行必须被转义 —— 否则整轮决策被判成"零决策"', () => {
  /*
   * ## 实盘现场（2026-10-03，周期 #37）
   *
   * 模型在 `reasoning` 字段里写了多行文字，于是 JSON 字符串里出现了**真的换行**：
   *
   * ```text
   * "reasoning": "止损幅度 1.30%,RR 2.06,均过线。**
   *   },                        ← 字符串内部的裸换行
   * ```
   *
   * 那在 JSON 规范里非法，`JSON.parse` 抛：
   * `Bad control character in string literal in JSON at position 706`。
   *
   * 而当时的修复链只有两条候选（原文、`repairJsonStructure`），**都不管控制字符** ——
   * 于是**整轮决策被丢成 `[]`**，界面显示「本周期模型没有给出任何决策」。
   * 而那一轮模型其实给出了 **2 笔开仓 + 十余条 skip**：它 40k tokens 的思考、
   * 8.9k 字的结论全部白费，而且**没人知道它做过这些判断**。
   *
   * ## 这条同时钉住两边
   *
   * 字符串**外面**的换行是合法空白（格式化 JSON 全靠它），所以修复器必须"只看
   * 引号之内"。下一条用例守的就是那一半。
   */
  const raw = [
    '<decision>',
    '```json',
    '[',
    '  {',
    '    "symbol": "ZECUSDT",',
    '    "action": "open_short",',
    '    "reasoning": "第一行理由',
    '第二行理由（这里是裸换行，JSON 里非法）',
    '第三行理由"',
    '  },',
    '  {',
    '    "symbol": "WLDUSDT",',
    '    "action": "skip",',
    '    "reasoning": "单行，没问题"',
    '  }',
    ']',
    '```',
    '</decision>',
  ].join('\n');

  const parsed = parseDecisionResponse(raw, context({ candidateSymbols: new Set(['ZECUSDT', 'WLDUSDT']) }));
  assert.equal(
    parsed.decisions.length,
    2,
    '★ 两条决策都必须被解出来 —— 修复前这里会是 0，而那正是"本周期没有给出任何决策"那句话的来源',
  );
  assert.equal(parsed.decisions[0]!.symbol, 'ZECUSDT');
  assert.equal(parsed.decisions[0]!.action, 'open_short');
  /* 换行要**保留在文本里**（转义只是为了让 JSON 合法，不该把内容吃掉）。 */
  assert.ok(
    parsed.decisions[0]!.reasoning.includes('第二行理由'),
    '转义后内容必须完整保留（把 \\n 变成空串会把它的理由吃掉一半）',
  );
});

test('★ 修复器不能碰字符串【外面】的换行 —— 那会把结构改坏', () => {
  /*
   * 反向守卫：`escapeControlCharsInsideStrings` 是逐字符状态机，只看引号之内。
   * 若有人图省事把它换成"全局把 \n 换成 \\n"，格式化过的 JSON 会被压成一行 ——
   * 而这在真实的模型输出里是**常态**（它们几乎总是缩进排版）。
   */
  const pretty = [
    '[',
    '  {',
    '    "symbol": "BTCUSDT",',
    '    "action": "hold",',
    '    "reasoning": "正常的一行"',
    '  }',
    ']',
  ].join('\n');

  const parsed = parseDecisionResponse(`<decision>${pretty}</decision>`, context());
  assert.equal(parsed.decisions.length, 1, '多行缩进的合法 JSON 必须照常解析');
  assert.equal(parsed.decisions[0]!.symbol, 'BTCUSDT');
});

test('★ 两个瑕疵同时出现时，修复顺序是本质的（多行 + 漏收尾引号）', () => {
  /*
   * ## 实盘现场（2026-10-03，周期 #37 真实形状）
   *
   * 那一轮的 `reasoning` 有**两个**瑕疵：
   *
   *   ① 值里有多行（控制字符非法）；
   *   ② 值的**收尾引号漏了**（换行之后直接是 `},`）。
   *
   * ```text
   * "reasoning": "...均过线。**
   *   },                  ← 既跨了行，又少一个 "
   * ```
   *
   * ## 为什么这条用例必须"两个一起"
   *
   * `closeUnterminatedStrings` 靠**遇到真的换行符**来判断漏引号；
   * 而 `escapeControlCharsInsideStrings` 会把那个换行变成 `\`+`n`。
   * **先转义、再补引号 ⇒ 补引号永远看不到换行 ⇒ 永不触发。**
   *
   * 实测就是这么失败的：两级修复都在，顺序错了，谁也救不回来 —— 整轮 20 条决策
   * （含 2 笔开仓）被丢成 `"[]"`，界面显示「本周期模型没有给出任何决策」。
   *
   * 所以：**只测"多行"或只测"漏引号"都无法发现顺序错误**，必须同时给出。
   */
  const raw = [
    '<decision>',
    '```json',
    '[',
    '  {',
    '    "symbol": "ZECUSDT",',
    '    "action": "open_short",',
    '    "reasoning": "第一行理由',
    '第二行理由（裸换行）',
    '第三行理由**', // ← 故意不写收尾引号
    '  },',
    '  {',
    '    "symbol": "WLDUSDT",',
    '    "action": "hold",',
    '    "reasoning": "正常"',
    '  }',
    ']',
    '```',
    '</decision>',
  ].join('\n');

  const parsed = parseDecisionResponse(raw, context({ candidateSymbols: new Set(['ZECUSDT', 'WLDUSDT']) }));
  assert.equal(
    parsed.decisions.length,
    2,
    '★ 多行 + 漏引号必须同时被救回来 —— 顺序写错时这里会是 0，而那正是"没有给出任何决策"的来源',
  );
  assert.equal(parsed.decisions[0]!.symbol, 'ZECUSDT');
  assert.equal(parsed.decisions[0]!.action, 'open_short');
  assert.ok(
    parsed.decisions[0]!.reasoning.includes('第三行理由'),
    '补引号不能把内容截掉（它只能补上缺失的那一个引号）',
  );
});
