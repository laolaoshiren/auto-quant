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

/** 后端截断留痕（`deskOutput.ts:720`，有意留的 —— 不要改后端）。 */
const TAIL = '…（已截断，完整 4750 字）';

/**
 * 在**第三个对象**（BTCUSDT）的 reasoning 字符串中间切开：
 * 前两个对象（WLDUSDT / BTWUSDT）完整，第三个停在半个字符串上。
 */
const FIRST_REASONING = REAL_WORLD.indexOf('"reasoning":"结构不明"');
const CUT_AT =
  REAL_WORLD.indexOf('"reasoning":"结构不明"', FIRST_REASONING + 1) + '"reasoning":"'.length;
const TRUNCATED_ARRAY = `${REAL_WORLD.slice(0, CUT_AT)}${TAIL}`;

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

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ⑧ 截断留痕 + 截断的决策数组（2026-10-18 · 用户实测 4,016/4,750 字）          */
/* ══════════════════════════════════════════════════════════════════════════ */

/*
 * 这次修的是**屏幕上的字**，所以必须在这里（而不是只在新模块的测试里）钉住：
 * 解析层返回了条目，不等于组件真的用了它（见文件开头"变异 C"的教训）。
 */

test('[校准 a] 完整决策数组（无留痕）→ 结构化，且不出现截断说明', () => {
  const html = render(REAL_WORLD);
  assert.equal((html.match(/<li/g) ?? []).length, 8, '8 个标的 → 8 条');
  assert.ok(html.includes('这一轮对'), '完整数组用"这一轮对 N 个标的"');
  assert.ok(!html.includes('原文本已截断'), '没留痕就不该凭空说被截断');
  assert.ok(!html.includes('{"symbol"') && !html.includes('&quot;symbol&quot;'), '不能漏出 JSON');
});

test('[校准 b] 截断的决策数组 + 留痕 → 显示前 2 个完整标的，屏上不出现 {"symbol"', () => {
  /*
   * ⚠️ 负向校准：把 `HumanMessage` 里的 `parseDecisionListDetailed` 换回
   * `parseDecisionList`（或退回"不剥留痕"），这条必红 —— 会回落成原文，
   * HTML 里出现 `[{&quot;symbol&quot;…`，且没有"只显示了前 N 个"。
   */
  assert.ok(FIRST_REASONING > 0 && CUT_AT > FIRST_REASONING, '夹具切点必须落在第三个对象的 reasoning 里');
  const html = render(TRUNCATED_ARRAY);

  /* ① 人话在场：前两个完整标的 + 中文动作。 */
  assert.ok(html.includes('开空'), 'WLDUSDT 的动作必须译成「开空」');
  assert.ok(html.includes('WLDUSDT') && html.includes('BTWUSDT'), '前两个完整标的必须在');
  assert.equal((html.match(/<li/g) ?? []).length, 2, '只渲染 2 条完整决策');
  assert.ok(!html.includes('BTCUSDT'), '不完整的第三个标的不能出现');

  /* ② 屏幕上不出现 JSON 原文（本条的硬判据）。 */
  assert.ok(!html.includes('{"symbol"'), '不能出现序列化片段 {"symbol"');
  assert.ok(!html.includes('&quot;symbol&quot;'), '不能出现转义后的序列化片段');
  assert.ok(!html.includes('"action":') && !html.includes('&quot;action&quot;'), '不能出现 "action":');
  assert.ok(!html.includes('…（已截断'), '留痕尾巴不能原样漏出');

  /* ③ **如实说明"被截断了、只显示了前 N 个"**（不许假装完整）。 */
  assert.ok(html.includes('原文本已截断（完整 4750 字）'), '必须保留留痕的中文语义与原始字数');
  assert.ok(html.includes('只显示了前 2 个完整的标的'), '必须说清只显示了前 N 个');
  assert.ok(!html.includes('这一轮对'), '截断前能看到的不等于"这一轮的全部"');
});

test('[校准 c] 截断到一个完整对象都没有 → 回落纯文本、不白屏、不空表', () => {
  const input = `[{"symbol":"X","act${TAIL}`;
  assert.doesNotThrow(() => render(input), '任何形态都不许抛（否则整块会变错误卡）');
  const html = render(input);

  /* 原文在（一个字节都不丢），且**没有**走结构化分支。 */
  assert.ok(
    html.includes('[{&quot;symbol&quot;') || html.includes('[{"symbol"'),
    '原文必须仍然可见（不白屏）',
  );
  assert.ok(!html.includes('<li'), '不能渲染成一张空表');
  assert.ok(!html.includes('这一轮对'), '不能被当成决策数组');
  assert.ok(!html.includes('原文本已截断'), '没有结构化就不加那条说明');
  /* 留痕的中文文案仍然在（它是后端有意留的）。 */
  assert.ok(html.includes('已截断，完整 4750 字'), '回落纯文本时留痕文案必须原样保留');
});

test('[校准 d] 非 JSON 普通文本 → 与改动前**逐字一致**（golden HTML）', () => {
  const note = '正在分析 SOLUSDT 的回踩结构，等待确认。';
  /*
   * 这是**改动前**同一组件对同一输入的输出（`renderToStaticMarkup` 逐字）。
   * 之所以比对整串而不是只判 `includes`：要求是"逐字一致" ——
   * 多加一层包裹、多一行说明、多一个空格都会被这个断言抓到。
   *
   * ⚠️ 如果将来**有意**调整纯文本分支的样式（class），同步更新这条 golden；
   * 但**不要**为了让测试变绿而放宽成 `includes`。
   */
  assert.equal(
    render(note),
    '<div class="min-w-0"><div class="border-l-2 border-transparent pl-2"><p class="min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">正在分析 SOLUSDT 的回踩结构，等待确认。</p></div></div>',
  );
});

test('[校准 e] 完整数组但尾部没有留痕 → 与改动前一致', () => {
  const html = render(REAL_WORLD);
  assert.equal((html.match(/<li/g) ?? []).length, 8);
  assert.ok(html.includes('这一轮对'));
  assert.ok(html.includes('开空'));
  assert.ok(!html.includes('原文本已截断'));
  assert.ok(!html.includes('只显示了前'));
});

/* ── 另外两条边界：数组完整但截断在数组之后 / 单个对象 + 留痕 ─────────────── */

test('★★ 完整数组 + 留痕（截断发生在数组之后）→ 照常 8 条，只说被截断不说丢条', () => {
  const html = render(`${REAL_WORLD}${TAIL}`);
  assert.equal((html.match(/<li/g) ?? []).length, 8, '8 条一条都不能少');
  assert.ok(html.includes('原文本已截断（完整 4750 字）'), '仍要如实说明被截断过');
  assert.ok(!html.includes('只显示了前'), '数组本身完整 → 不能说"只显示了前 N 个"');
});

test('★★ 真实形态：完整数组 + 尾部中文 + 留痕 → 8 条全在，不说"只显示了前 N 个"', () => {
  /*
   * 队长实测那条 tail 是「* 结论：**开空 WLDUSDT**，其余全部…（已截断，完整 4750 字）」：
   * 决策数组后面还有一段中文，`JSON.parse` 从数组起点一直吃到中文必然失败。
   * 这里钉住"数组本身完整"这个事实 —— **不能**谎称丢了几条。
   */
  const html = render(`${REAL_WORLD}\n* 结论：**开空 WLDUSDT**，其余全部观望${TAIL}`);
  assert.equal((html.match(/<li/g) ?? []).length, 8, '8 条一条都不能少');
  assert.ok(html.includes('这一轮对'), '数组完整 → 仍是"这一轮对 N 个标的给了决策"');
  assert.ok(html.includes('原文本已截断（完整 4750 字）'), '必须保留截断说明');
  assert.ok(!html.includes('只显示了前'), '数组完整 → 不能说"只显示了前 N 个"');
  assert.ok(!html.includes('{"symbol"') && !html.includes('&quot;symbol&quot;'), '不能漏出 JSON');
});

test('★★ 单个对象 + 留痕 → 键值两列 + 截断说明（不回落原文）', () => {
  const html = render(`{"action":"open_short","symbol":"WLDUSDT"}${TAIL}`);
  assert.ok(html.includes('开空'), '动作码必须译成「开空」');
  assert.ok(!html.includes('open_short'), '不该出现 open_short');
  assert.ok(!html.includes('&quot;action&quot;'), '不该出现序列化片段');
  assert.ok(html.includes('原文本已截断（完整 4750 字）'), '必须保留截断说明');
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ⑨ 被截断的【对象】—— 用户截图里仍在原样显示的 ①②③（2026-10-18）            */
/* ══════════════════════════════════════════════════════════════════════════ */

/*
 * 三段夹具**逐字复制**用户截图原文（①分析产出 ②裁决产出 ③调研产出）。
 * 它们的共同点：都是被后端截断过的 JSON ⇒ `JSON.parse` 失败 ⇒ 老实现回落纯文本
 * ⇒ 屏幕上原样显示 `{"symbols":…`。这个文件测的是"**屏幕上出现的字**"。
 */

/** ① 分析产出：`symbols` 数组里第一个标的的 `indicators` 被截断。 */
const TRUNCATED_OBJ_1 =
  '{"symbols":[{"symbol":"AGTUSDT","structure":"15m: 现价 0.079220 高于 EMA20 0.075848 与 EMA50 0.075082，EMA20>EMA50，MACD 0.001206 且柱 0.000331 为正，RSI14 58.2。","support":0.072088,"resistance":0.080739,"indicators":{"macdHist":"0.00…';

/** ② 裁决产出：`arguments` 数组里第一个论据的 `point` 被截断。 */
const TRUNCATED_OBJ_2 =
  '{"side":"short_or_no_trade","strength":"strong","arguments":[{"point":"GTCUSDT 空头信号是本轮唯一三项机械门槛全通过…';

/** ③ 调研产出：`hypothesis` 字符串被截断（一条完整键值对都没有）。 */
const TRUNCATED_OBJ_3 =
  '{"hypothesis":"当前市场整体处于普跌/风险偏好收缩状态，多数标的同步走弱；…（截断）';

/** 屏幕上**不该出现**的 JSON 语法残片（含 HTML 转义后的形态）。 */
const JSON_LEAKS = ['{"', '&quot;{', '":[', '&quot;:[', '":"', '&quot;:&quot;'];

/** 断言 HTML 里没有任何"整块 JSON 漏出来"的痕迹。 */
function assertNoJsonLeak(html: string, name: string): void {
  for (const token of JSON_LEAKS) {
    assert.ok(!html.includes(token), `${name}：屏幕上出现了 JSON 语法残片 ${token}`);
  }
}

test('★★★ [校准 ①] 被截断的分析产出 ①：标的逐行 + 结构摘要，不出现 {" / ":[', () => {
  /*
   * ⚠️ 负向校准：把 `HumanMessage` 的对象分支换回 `parseLooseObject`（只认完整 JSON），
   * 这条必红 —— HTML 里会出现 `{&quot;symbols&quot;` 与整段原始 JSON。
   */
  const html = render(TRUNCATED_OBJ_1);

  /* 人话在场：字段名中文化、标的一行、结构摘要带上。 */
  assert.ok(html.includes('标的'), '字段名 symbols → 「标的」');
  assert.ok(html.includes('AGTUSDT'), '标的必须在');
  assert.ok(html.includes('15m: 现价 0.079220'), 'structure 摘要必须在');
  assert.equal((html.match(/<li/g) ?? []).length, 1, 'symbols 里一个标的 → 一行');

  /* 截断必须如实标注。 */
  assert.ok(html.includes('原文本被截断，只显示了完整的部分'), '必须说明只显示了完整的部分');

  /* 屏幕上不出现 JSON。 */
  assertNoJsonLeak(html, '①');
});

test('★★★ [校准 ②] 被截断的裁决产出 ②：方向/强度中文化，不出现英文枚举', () => {
  const html = render(TRUNCATED_OBJ_2);

  /* 字段名 + 值里的枚举都必须是中文。 */
  assert.ok(html.includes('方向'), 'side → 方向');
  assert.ok(html.includes('只空或不交易'), 'short_or_no_trade → 只空或不交易');
  assert.ok(html.includes('强度'), 'strength → 强度');
  assert.ok(html.includes('>强<'), 'strong → 强');
  assert.ok(!html.includes('short_or_no_trade'), '不该再出现 short_or_no_trade');
  assert.ok(!html.includes('>strong<'), '不该再出现英文枚举 strong');

  /* 截断说明 + 无 JSON 泄漏。 */
  assert.ok(html.includes('原文本被截断，只显示了完整的部分'));
  assertNoJsonLeak(html, '②');
});

test('★★★ [校准 ③] 被截断的调研产出 ③：完整键名 + 可见前缀，不出现 {"', () => {
  const html = render(TRUNCATED_OBJ_3);

  assert.ok(html.includes('假设'), 'hypothesis → 假设');
  assert.ok(html.includes('当前市场整体处于普跌'), '半截字符串的可见内容必须显示');
  assert.ok(html.includes('原文本被截断，只显示了完整的部分'));
  assertNoJsonLeak(html, '③');
});

test('★★ [校准 ②b] 普通文本（区间/单字段对象）→ 屏幕上仍是原文，行为与改动前一致', () => {
  /*
   * 这一条钉的是"不许误伤"：含区间、含 `{a:1}` 这类普通文本**不能**被当成对象成表。
   * 判据看屏幕：原文在、没有任何表格骨架。
   */
  const notes = [
    'D=-1.045%∈[0.8,3.5]，ATR≈1.0%≤3.5%，机械条件全过',
    '[0.8,3.5] 这个区间是位移门槛',
    '[1,2,3] 候选池已按评分排序',
    '见 {a:1} 这种不是标准 JSON',
  ];
  for (const note of notes) {
    const html = render(note);
    assert.ok(html.includes(note.slice(0, 8)), `原文必须仍然可见：${note}`);
    assert.ok(!html.includes('<table'), `普通文本不该被渲染成表：${note}`);
    assert.ok(!html.includes('只显示了完整的部分'), `普通文本不该加截断说明：${note}`);
  }

  /*
   * **单字段对象**：改动前就能走键值表（`parseLooseObject`），现在必须一模一样 ——
   * 中文化的字段名/动作码都在，且**不能**多出"被截断"的说明。
   */
  const single = render('说明：{"action":"skip"}');
  assert.ok(single.includes('动作') && single.includes('跳过'), '单字段对象照常中文化');
  assert.ok(!single.includes('&quot;action&quot;'), '不能漏出序列化片段');
  assert.ok(!single.includes('只显示了完整的部分'), '完整对象不该加截断说明');

  /* 逐字一致：与改动前同一条 golden（多一层包裹/多一句说明都会被这条抓到）。 */
  const plain = '正在分析 SOLUSDT 的回踩结构，等待确认。';
  assert.equal(
    render(plain),
    '<div class="min-w-0"><div class="border-l-2 border-transparent pl-2"><p class="min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">正在分析 SOLUSDT 的回踩结构，等待确认。</p></div></div>',
  );
});

test('★★★ [校准 ③b] 完全无法提取的坏文本 → 回落纯文本、不白屏、不空表', () => {
  const bad = ['{"a":', '{{{{', '{"a":"'];
  for (const input of bad) {
    assert.doesNotThrow(() => render(input), `坏文本不许抛：${input}`);
    const html = render(input);
    /* 原文仍然可见（转义后），且没有表格骨架 / 空表。 */
    assert.ok(html.includes('&quot;') || html.includes(input), `原文必须仍然可见：${input}`);
    assert.ok(!html.includes('<table'), `不能渲染成空表：${input}`);
    assert.ok(!html.includes('<tbody'), `不能渲染成空表：${input}`);
    assert.ok(!html.includes('只显示了完整的部分'), `没结构化就不加截断说明：${input}`);
  }
});
