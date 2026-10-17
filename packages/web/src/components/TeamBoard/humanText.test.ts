/**
 * **渲染层**的负向校准（2026-10-17 · 用户实测 · 队长要求 ④ 的"改坏要变红"）。
 *
 * ## 为什么解析层的测试不够（这是我自测抓到的真缺口）
 *
 * `structuredMessage.test.ts` 只测了 `parseDecisionList()` —— 它证明"能解析"，
 * **不证明"组件真的用了它"**。实测变异 C：把 `HumanMessage` 里的
 * `const items = parseDecisionList(text)` 改成 `null`（= 不解析、直接显示原文），
 * **379 条测试全绿** —— 因为没有任何一条断言"渲染出来的 HTML 里没有 JSON"。
 *
 * 所以这个文件用 `renderToStaticMarkup` 渲染**真实组件**，直接看 HTML：
 * ```
 *   ✓ 合法决策 JSON → HTML 里出现「开空」「WLDUSDT」「这一轮对 N 个标的」，
 *                     且【不出现】 `{"symbol"` / `"action"` 这类 JSON 片段
 *   ✓ 截断 JSON     → 回落纯文本（HTML 里出现原文，不抛、不白屏）
 *   ✓ 超长文本      → 出现「展开全文」按钮
 *   ✓ markdown      → `**` 不出现在 HTML 里
 * ```
 *
 * ## 它不是浏览器实测（诚实说明）
 *
 * SSR 不执行 `useEffect`、不证明布局/对齐/颜色。它证明的是**"屏幕上的字对不对"** ——
 * 而这一轮用户报的正是"字不对"（出现 JSON / 英文码 / 星号）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { HumanMessage } from './humanText.js';

/** 用户截图里那一条（8 个标的）。 */
const REAL_WORLD = JSON.stringify([
  {
    symbol: 'WLDUSDT',
    action: 'open_short',
    leverage: 5,
    positionSizeUsd: 11,
    stopLoss: 0.538,
    takeProfit: 0.5115,
    confidence: 60,
    riskUsd: 0.17,
    intel_keys: ['www.baiyi.com|bearish|WLDUSDT'],
    reasoning: 'D=-1.045%∈[0.8,3.5]，ATR≈1.0%≤3.5%，末根-0.6%同向，机械条件全过必须开空。',
  },
  ...['BTWUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'ARBUSDT'].map((symbol) => ({
    symbol,
    action: 'skip',
    confidence: 30,
    reasoning: '结构不明',
  })),
]);

const render = (text: string, level?: string): string =>
  renderToStaticMarkup(createElement(HumanMessage, { text, level }));

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ① 合法 JSON → 结构化（HTML 里没有 JSON 片段）                                */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ 合法决策 JSON 渲染成结构化：出现中文动作与标的，不出现 JSON 片段', () => {
  const html = render(REAL_WORLD);

  /* ① 人话在场：动作被译成中文、标的与计数都在。 */
  assert.ok(html.includes('开空'), 'open_short 必须显示成「开空」');
  assert.ok(html.includes('WLDUSDT'), '标的必须在');
  assert.ok(html.includes('这一轮对'), '必须说清"这一轮对 N 个标的"');
  assert.ok(/8<\/span>/.test(html) || html.includes('>8<'), '8 个标的的计数必须在');

  /*
   * ② **JSON 片段不在场** —— 这是本条的核心判据。
   * 用 `{"symbol"` 与 `"action":` 这种"序列化特征"判，而不是判单个 `{`
   *（正文里的区间 `[0.8,3.5]` 是模型写的人话，不能算违规）。
   */
  assert.ok(!html.includes('{"symbol"'), 'HTML 里不该出现序列化片段 {"symbol"');
  assert.ok(!html.includes('"action":'), 'HTML 里不该出现 "action":');
  assert.ok(!html.includes('&quot;symbol&quot;'), 'HTML 转义后的序列化片段也不该出现');

  /* ③ 每个标的都单独成行（8 条 `<li`）。 */
  const liCount = (html.match(/<li/g) ?? []).length;
  assert.equal(liCount, 8, `8 个标的 → 8 个 <li>（实际 ${liCount}）`);
});

test('★★ 结构化后仍保留关键量：杠杆 / 仓位 / 止损 / 置信', () => {
  const html = render(REAL_WORLD);
  assert.ok(html.includes('5x'), '杠杆 5x 必须在');
  assert.ok(html.includes('$11'), '仓位 $11 必须在');
  assert.ok(html.includes('0.538'), '止损 0.538 必须在');
  assert.ok(html.includes('置信'), '置信度必须在');
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ② 截断 JSON → 回落纯文本（不抛、不白屏）                                     */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ 截断的 JSON 回落纯文本：不抛、内容不丢', () => {
  const truncated = '[{"symbol":"WLDUSDT","action":"op';
  assert.doesNotThrow(() => render(truncated), '截断的 JSON 不能让渲染抛错');
  const html = render(truncated);
  /* 原文在（一个字节都不丢），且**没有**走结构化分支（不出现"这一轮对"）。 */
  assert.ok(html.includes('WLDUSDT'), '原文必须仍然可见');
  assert.ok(!html.includes('这一轮对'), '截断的 JSON 不该被当成决策数组渲染');
});

test('★★ 普通文本原样显示（不被当成 JSON）', () => {
  const note = '正在分析 SOLUSDT 的回踩结构，等待确认。';
  const html = render(note);
  assert.ok(html.includes('正在分析 SOLUSDT'), '普通文本必须原样显示');
  assert.ok(!html.includes('这一轮对'), '普通文本不该走结构化分支');
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ③ markdown 强调符 → 剥掉                                                    */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ markdown 强调符不出现在渲染结果里', () => {
  const html = render('**支撑**：162.4；**止损**：159.8');
  assert.ok(!html.includes('**'), 'HTML 里不该出现 markdown 强调符');
  assert.ok(html.includes('支撑'), '文字本身要在');
  assert.ok(html.includes('162.4'), '数字要在');
});

test('★★ 决策 JSON 里的 reasoning 也剥 markdown', () => {
  const withMd = JSON.stringify([
    { symbol: 'BTCUSDT', action: 'open_long', confidence: 70, reasoning: '**趋势**：上行' },
  ]);
  const html = render(withMd);
  assert.ok(!html.includes('**'), 'reasoning 里的 ** 也必须剥掉');
  assert.ok(html.includes('趋势'), '文字要在');
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ④ 超长文本 → 折叠 + 可展开                                                   */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ 超长文本被折叠，并给出「展开全文」入口', () => {
  const longNote = '这是一条很长的说明。'.repeat(120);
  assert.ok(longNote.length > 1000, `夹具必须超过 1000 字（实际 ${longNote.length}）`);
  const html = render(longNote);
  assert.ok(html.includes('展开全文'), '超长文本必须给「展开全文」');
  assert.ok(html.includes('收起') === false, '默认是收起态（不该显示"收起"）');
  /* 折叠后 HTML 里不该塞进全部 1200 字（那等于没折叠）。 */
  assert.ok(html.length < longNote.length, '折叠后 HTML 应短于原文');
  assert.ok(html.includes('aria-expanded="false"'), '折叠按钮要有 aria-expanded=false');
});

test('★★ 短文本不出现「展开全文」（不留死按钮）', () => {
  const html = render('这一轮没有需要行动的机会。');
  assert.ok(!html.includes('展开全文'), '短文本不该有展开按钮');
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ⑤ 颜色语义：正文不整段染色，只有左侧竖条                                     */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ error 级别：左侧竖条染色，正文保持中性（用户要求"正文不要整段染色"）', () => {
  const html = render('调用失败：网关超时', 'error');
  assert.ok(html.includes('border-down'), '必须有红色左侧竖条');
  /*
   * 正文段落**不能**带 `text-down`（整段染红）。
   * 判据：`text-down` 只允许出现在竖条那一层的 class 里，不能出现在 `<p` 上。
   */
  const pTag = html.match(/<p[^>]*>/g) ?? [];
  for (const tag of pTag) {
    assert.ok(!tag.includes('text-down'), `正文 <p> 不该整段染红：${tag}`);
  }
});

test('★★ info 级别：不染色（透明竖条）', () => {
  const html = render('正在分析…', 'info');
  assert.ok(html.includes('border-transparent'), 'info 用透明竖条（保持对齐、不染色）');
  assert.ok(!html.includes('border-down') && !html.includes('border-warn'), 'info 不该有彩色竖条');
});

test('★★ 认不出的级别当 info（不染色）—— 宁可少标，不要错标', () => {
  const html = render('某种未知级别', 'critical-ish');
  assert.ok(html.includes('border-transparent'), '未知级别 → info（不染色）');
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ⑦ 英文 id → 中文（用户："不要出现英文占位符"）                                */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ 单个对象 {"action":"open_short"} → 屏幕上出现「开空」，不是 open_short', () => {
  /*
   * 用户截图里那类 note 的第二形态：**不是数组，是单个对象**。
   * 若只做数组分支，这一条会原样显示 `{"action":"open_short"}` —— 英文占位符照旧。
   *
   * ⚠️ 负向校准：把 `HumanMessage` 里的 `parseLooseObject` 分支删掉，这条必红
   *（会退化成纯文本，HTML 里出现 `open_short` 与 `&quot;action&quot;`）。
   */
  const html = render('{"action":"open_short","symbol":"WLDUSDT","leverage":5}');

  assert.ok(html.includes('开空'), '动作码必须译成「开空」');
  assert.ok(!html.includes('open_short'), 'HTML 里不该再出现 open_short');
  assert.ok(!html.includes('&quot;action&quot;'), 'HTML 里不该出现序列化片段');

  /* 字段名也要中文化。 */
  assert.ok(html.includes('动作'), '字段名 action → 「动作」');
  assert.ok(html.includes('标的'), '字段名 symbol → 「标的」');
  assert.ok(html.includes('杠杆'), '字段名 leverage → 「杠杆」');
  assert.ok(!html.includes('>symbol<'), '不该出现裸字段名 symbol');
  assert.ok(!html.includes('>leverage<'), '不该出现裸字段名 leverage');
});

test('★★★ 未登记的动作码/字段名：保留原词但用等宽弱色（不编中文）', () => {
  const html = render('{"action":"teleport_position","weirdField":1}');
  /* 保留原词 —— 编一个中文名比显示英文更危险。 */
  assert.ok(html.includes('teleport_position'), '未登记的码必须原样保留');
  assert.ok(html.includes('weirdField'), '未登记的字段名必须原样保留');
  /* 但要标出"这是标识符"：等宽 + 弱化色。 */
  assert.ok(html.includes('font-mono'), '未登记的标识符必须用等宽字体');
  assert.ok(html.includes('text-ink-faint'), '未登记的标识符必须用弱化色');
});

test('★★ 决策数组里的英文动作码同样译成中文（数组分支）', () => {
  const html = render(JSON.stringify([{ symbol: 'BTCUSDT', action: 'open_long', confidence: 70 }]));
  assert.ok(html.includes('开多'), 'open_long → 开多');
  assert.ok(!html.includes('open_long'), '不该出现 open_long');
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ⑥ 负向校准：坏实现必须被判据抓到                                            */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ 判据自证：把"结构化"退化成"直接显示原文"，上面那些断言会红', () => {
  /*
   * 模拟变异 C：渲染原文（不解析）。用**同一套判据**去判它，断言不合格。
   * 若判据写松了（例如只断言 `html.includes('WLDUSDT')`），这里会红。
   */
  const degraded = renderToStaticMarkup(
    createElement('p', null, REAL_WORLD), // ← 等价于"没走 HumanMessage"
  );
  assert.ok(
    degraded.includes('{"symbol"') || degraded.includes('&quot;symbol&quot;'),
    '退化形态必须能被"JSON 片段"判据抓到 —— 否则那条判据是空转',
  );
  /*
   * ⚠️ **不能用 `!degraded.includes('开空')` 判**（我第一版就是这么写的，然后红了）：
   * 原始 JSON 的 `reasoning` 里本来就有「必须开空」这几个字 ——
   * 那说明"文本里出现某个词"根本不是"结构化成功"的证据。
   * 真正的证据是**结构**：逐条 `<li>`、以及中文动作标签单独成元素。
   */
  assert.equal((degraded.match(/<li/g) ?? []).length, 0, '退化形态没有逐条 <li>');
  assert.ok(!degraded.includes('这一轮对'), '退化形态没有"这一轮对 N 个标的"这句摘要');
  /* 而正确实现这三条都满足（与上面 ① 的断言一致）。 */
  const good = render(REAL_WORLD);
  assert.equal((good.match(/<li/g) ?? []).length, 8);
  assert.ok(good.includes('这一轮对'));
});
