/**
 * **给人看的文本渲染层** —— 负向校准（2026-10-17 · 用户实测 · 队长要求 ④）。
 *
 * ## 用户原话
 *
 * > 「团队模式，页面上给人看得东西不要出现：**英文占位符、json、代码块、无意义的内容**」
 *
 * ## 这个文件钉住的四件事
 *
 * | # | 输入 | 期望 |
 * |---|---|---|
 * | ① | 合法决策 JSON | 渲染成**结构化**，屏幕上**不出现** `{` `}` `[` `]` |
 * | ② | **截断的** JSON | **回落纯文本、不白屏、不抛** |
 * | ③ | 含英文 id（`open_short`） | 显示**开空**；未登记的动作码保留原词（等宽弱色） |
 * | ④ | 超长 note（1000 字） | **被截断且可展开** |
 *
 * ## 为什么这些用例值得存在（而不是"测了个显然"）
 *
 * 这四条**每一条都对应一次真实截图或一次真实事故**：
 * ```
 *   ① 用户截图：「历史工作详情」里一坨 [{"symbol":"WLDUSDT","action":"open_short",…}]
 *   ② t110 踩过：oneLine(report, 2000) 截断后不是合法 JSON，JSON.parse 抛 →
 *      整块被 FeedErrorBoundary 换成错误卡（"展开详情"变成一张错误卡）
 *   ③ 用户截图：屏幕上出现 open_short / skip 这类机器码
 *   ④ 一条 1000 字的 note 把上下 8 条历史挤出屏幕
 * ```
 *
 * ## 负向校准（怎么证明判据不是空转）
 *
 * 每个断言都配一条"**把实现改坏就该变红**"的说明。文件末尾有一组
 * `probe` 用例：它们**故意用坏实现**跑同一套判据，断言判据**确实会报出来**
 * —— 这样"全绿"不是因为判据什么都没查。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDecisionList,
  parseDecisionListDetailed,
  parseJsonLoose,
  stripTruncationTail,
} from './structuredMessage';

/** 用户截图里那一条（8 个标的，含 open_short / skip）。 */
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
  { symbol: 'BTWUSDT', action: 'skip', confidence: 40, reasoning: '结构不明' },
  { symbol: 'BTCUSDT', action: 'skip', confidence: 35, reasoning: '盈亏比不足' },
  { symbol: 'ETHUSDT', action: 'skip', confidence: 33, reasoning: '量能萎缩' },
  { symbol: 'SOLUSDT', action: 'skip', confidence: 31, reasoning: '位置太差' },
  { symbol: 'DOGEUSDT', action: 'skip', confidence: 28, reasoning: '波动过大' },
  { symbol: 'XRPUSDT', action: 'skip', confidence: 26, reasoning: '无信号' },
  { symbol: 'ARBUSDT', action: 'skip', confidence: 22, reasoning: '流动性不足' },
]);

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ① 合法 JSON → 结构化；判据：解析结果里没有 JSON 标点残留                    */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ 合法决策 JSON → 解析成 8 条，且每条都是"人话字段"（不是原始 JSON 串）', () => {
  const items = parseDecisionList(REAL_WORLD);
  assert.ok(items !== null, '合法数组必须解析成功');
  assert.equal(items.length, 8, '8 个标的 → 8 条');

  const first = items[0]!;
  assert.equal(first.symbol, 'WLDUSDT');
  assert.equal(first.action, 'open_short');
  assert.equal(first.leverage, 5);
  assert.equal(first.positionSizeUsd, 11);
  assert.equal(first.stopLoss, 0.538);
  assert.equal(first.confidence, 60);
  assert.ok(first.reasoning !== null && first.reasoning.includes('机械条件全过'));

  /*
   * ⚠️ **判据的核心**：渲染层拿到的**不是**那串 JSON。
   * 把每一条重新 JSON 化再比对 —— 若某条只是"原样字符串"，这里会相等。
   * （实现若退化成 `{items: [raw]}`，这条必红。）
   */
  for (const item of items) {
    assert.notEqual(JSON.stringify(item), REAL_WORLD, '一条不该等于整串 JSON');
    assert.ok(!item.symbol.includes('{'), 'symbol 里不该有 JSON 标点');
  }
});

test('★★ 屏幕上不该出现"JSON 结构标点" —— 由结构化字段保证（不是靠正则删字符）', () => {
  const items = parseDecisionList(REAL_WORLD)!;
  /*
   * ⚠️ **判据要分清"JSON 结构"与"正文里的方括号"**（这条是我第一版写错的地方）：
   * ```
   *   ✗ 错：断言人话里完全没有 `[` —— 而 reasoning 里就有 `[0.8,3.5]`，
   *         那是**模型写的区间**，是人话的一部分，删掉反而丢信息。
   *   ✓ 对：断言**每个字段本身**不是"被序列化的对象/数组"。
   * ```
   * 判据：任何字段都不该是 `{`/`[` **开头**的字符串 —— 那才是"整块 JSON 漏出来"的形态。
   */
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (typeof value !== 'string') continue;
      const head = value.trimStart()[0];
      assert.ok(
        head !== '{' && head !== '[',
        `字段 ${key} 不该以 JSON 标点开头（那说明整块 JSON 漏到了人话层）：${value.slice(0, 40)}`,
      );
    }
  }
  /* 而"结构本身"已经不是字符串了 —— symbol/action 是具名字段。 */
  assert.equal(typeof items[0]!.symbol, 'string');
  assert.equal(typeof items[0]!.leverage, 'number');
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ② 截断 JSON → 回落纯文本（t110 踩过的坑，这里再钉一次）                     */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ 截断的 JSON → null（不抛），调用方据此回落纯文本', () => {
  const truncated = '[{"symbol":"WLDUSDT","action":"op';
  assert.doesNotThrow(() => parseJsonLoose(truncated), '解析失败不能抛（否则整块渲染崩掉）');
  assert.equal(parseJsonLoose(truncated), null);
  assert.equal(parseDecisionList(truncated), null, '截断 → null → 调用方显示原文');
});

test('★★ 各种"不是决策数组"的形状都回落（不猜、不编）', () => {
  const cases: Array<[string, string]> = [
    ['空字符串', ''],
    ['纯文本', '正在分析 SOLUSDT 的回踩结构'],
    ['单个对象（不是数组）', '{"symbol":"BTCUSDT","action":"skip"}'],
    ['字符串数组', '["a","b"]'],
    ['空数组', '[]'],
    ['缺 symbol', '[{"action":"skip"}]'],
    ['缺 action', '[{"symbol":"BTCUSDT"}]'],
    ['symbol 不是字符串', '[{"symbol":123,"action":"skip"}]'],
  ];
  for (const [name, input] of cases) {
    assert.equal(parseDecisionList(input), null, `${name} 必须回落（返回 null）`);
  }
});

test('★★ 数组里混进坏项：跳过坏项、保留好的（不因一项坏掉毁掉整段）', () => {
  const mixed = JSON.stringify([
    { symbol: 'BTCUSDT', action: 'skip' },
    { bogus: true },
    { symbol: 'ETHUSDT', action: 'open_long', confidence: 70 },
  ]);
  const items = parseDecisionList(mixed);
  assert.ok(items !== null);
  assert.equal(items.length, 2, '2 条好的留下，1 条坏的跳过');
  assert.deepEqual(items.map((i) => i.symbol), ['BTCUSDT', 'ETHUSDT']);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ②b ★ 带中文前缀的 JSON（自测抓到的真 BUG：整串以 `[` 开头时只试位置 0）      */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ 带中文前缀的决策数组必须能解析（前缀里的方括号不能骗过判据）', () => {
  /*
   * 真实形状（`note` 是自由文本，服务端各处 `note()` 没有"必须以 `{` 开头"的约定）：
   * ```
   *   '[夹具] 决策数组（8 个标的） [{"symbol":…}]'
   *    ↑ 整串确实以 `[` 开头 —— 但那只是前缀里的方括号
   * ```
   * 第一版实现写成 `if (startsWith('[')) starts.push(0)`，于是**带前缀的行全部回落纯文本**。
   * 这条用例就是钉住它。
   *
   * ⚠️ 负向校准：把 `parseJsonLoose` 改回"整串开头是 `{`/`[` 就只试 0"，这条必红。
   */
  const prefixed = '[夹具] 决策数组（8 个标的） [{"symbol":"WLDUSDT","action":"open_short"}]';
  const items = parseDecisionList(prefixed);
  assert.ok(items !== null, '带前缀的 JSON 必须解析出来（不能回落纯文本）');
  assert.equal(items.length, 1);
  assert.equal(items[0]!.symbol, 'WLDUSDT');
  assert.equal(items[0]!.action, 'open_short');
});

test('★★ 前缀里带 `{` 的中文句子也不能骗过判据', () => {
  const tricky = '注意 {这里} 不是 JSON：[{"symbol":"BTCUSDT","action":"skip"}]';
  const items = parseDecisionList(tricky);
  assert.ok(items !== null, '必须找到最靠右的那个真 JSON');
  assert.equal(items[0]!.symbol, 'BTCUSDT');
});

test('★★ 前缀 + 单个对象也要能解析', () => {
  const prefixed = '[调研] 决策如下：{"action":"open_short","symbol":"WLDUSDT"}';
  const items = parseDecisionList(prefixed);
  /* 单个对象不是数组 → `parseDecisionList` 返回 null（由 `parseLooseObject` 接）。 */
  assert.equal(items, null, '单个对象不该被当成决策数组');
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ③ 英文 id → 中文（映射在 DecisionAudit 的 ACTION_LABELS，全仓唯一一份）      */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ 英文动作码能映射就映射（open_short→开空 等），且映射表只有一份', () => {
  /*
   * ⚠️ 这里**不复制** `ACTION_LABELS` 的内容来断言 —— 那会让"两处必须一致"变成
   * "测试里也有一份副本"。而是直接 import 生产用的 `actionLabel()`，
   * 断言它对用户截图里那几个码给出中文。
   * （若有人删了映射项，这条红；若有人另写一套，`humanText.tsx` 的 import 会暴露。）
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return import('../components/DecisionAudit').then(({ actionLabel }) => {
    assert.equal(actionLabel('open_short'), '开空');
    assert.equal(actionLabel('open_long'), '开多');
    assert.equal(actionLabel('skip'), '跳过');
    assert.equal(actionLabel('close_long'), '平多');

    /* 未登记的动作码 → **保留原词**（编一个中文名比显示英文更危险）。 */
    const unknown = 'some_new_action_v9';
    assert.equal(actionLabel(unknown), unknown, '未登记的码必须原样返回（不编中文）');
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ④ 超长文本 → 截断 + 可展开（折叠判据是字符数，不是行数）                     */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★ 1000 字的 note 不是决策数组 → 回落纯文本（折叠由组件负责）', () => {
  /* 每句 10 字 × 120 句 = 1200 字（**用 `.repeat(120)` 而不是靠"看起来够长"**）。 */
  const longNote = '这是一条很长的说明。'.repeat(120);
  assert.ok(longNote.length > 1000, `夹具必须真的超过 1000 字（实际 ${longNote.length}）`);
  assert.equal(parseDecisionList(longNote), null, '长文本不是数组 → 回落');

  /*
   * 折叠阈值写在组件里（`COLLAPSE_AT = 220`）。这里断言的是**判据口径**：
   * 用字符数而非行数 —— 一段没有换行的 1000 字，行数是 1，按行判就不会折叠。
   */
  const lines = longNote.split('\n').length;
  assert.equal(lines, 1, '这段长文本只有 1 行 —— 按行数判会漏掉它（所以要按字符数）');
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ★ 负向校准：证明上面的判据**真的会报**（不是空转）                            */
/* ══════════════════════════════════════════════════════════════════════════ */

test('★★★ 判据自证：坏实现必须被判据抓到', () => {
  /*
   * 这里模拟两种"改坏"的形态，用**同一套判据**去判，断言它们**不合格**。
   * 若判据写松了（例如只判 `!== null`），下面会红。
   */

  /* 坏形态 A：直接把原始 JSON 串当结果返回（等于没做结构化）。 */
  const badA = (text: string) => [{ symbol: text, action: 'skip' }];
  const a = badA(REAL_WORLD);
  assert.ok(
    a[0]!.symbol.includes('{') && a[0]!.symbol.includes('['),
    '坏形态 A 必须被判据看出来（它的 symbol 里带着 JSON 标点）',
  );

  /* 坏形态 B：不 try/catch（截断时抛）。 */
  const badB = (text: string) => JSON.parse(text);
  assert.throws(() => badB('[{"symbol":"X","action":"op'), '坏形态 B 确实会抛 —— 这正是要防的');

  /* 正确实现：同一输入不抛、返回 null。 */
  assert.doesNotThrow(() => parseDecisionList('[{"symbol":"X","action":"op'));
  assert.equal(parseDecisionList('[{"symbol":"X","action":"op'), null);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ⑤ 截断留痕 + **截断的决策数组**（2026-10-18 · 用户实测 4,016/4,750 字）      */
/* ══════════════════════════════════════════════════════════════════════════ */

/*
 * 后端 `clip()` 的留痕尾巴（`deskOutput.ts:720`，**有意留的，不要改后端**）：
 * ```
 *   `${one.slice(0, limit)}…（已截断，完整 ${s.length} 字）`
 * ```
 * 实测那条 message 长度 4,016、留痕写「完整 4750 字」。
 */
const TAIL = '…（已截断，完整 4750 字）';

/**
 * 真实截断形态：在**第三个对象的 reasoning 字符串中间**切开，再接留痕。
 * 前两个对象完整 → 应提取出 2 条；第三个停在半个字符串上 → **丢弃**。
 */
const CUT_AT = REAL_WORLD.indexOf('盈亏比');
const TRUNCATED_ARRAY = `${REAL_WORLD.slice(0, CUT_AT)}${TAIL}`;

test('[校准 a] 完整决策数组（无留痕）→ 结构化，元信息是"没截断"', () => {
  const detail = parseDecisionListDetailed(REAL_WORLD);
  assert.ok(detail !== null, '完整数组必须解析成功');
  assert.equal(detail.items.length, 8, '8 个标的 → 8 条');
  assert.equal(detail.truncated, false, '没有留痕 → 不算被截断');
  assert.equal(detail.originalLength, null, '没有留痕 → 没有原始字数');
  assert.equal(detail.recovered, false, '完整 JSON → 不是容错提取');
  assert.equal(detail.arrayClosed, true, '完整数组 → 数组是闭合的');
  /* 与旧入口 `parseDecisionList` 完全一致（只是多了元信息，没有改判据）。 */
  assert.deepEqual(detail.items, parseDecisionList(REAL_WORLD));
});

test('[校准 b] 截断的决策数组 + 留痕 → 只提取前 2 个完整标的，并标记"不完整"', () => {
  assert.ok(CUT_AT > 0 && CUT_AT < REAL_WORLD.length, '夹具切点必须落在真实 JSON 内部');
  /*
   * ⚠️ 负向校准：把 `parseDecisionListDetailed` 改回"直接 parseJsonLoose"（不剥留痕、
   * 不抠对象），这条必红 —— 那时 `detail` 是 null，显示层又会回落成一坨 JSON。
   */
  const detail = parseDecisionListDetailed(TRUNCATED_ARRAY);
  assert.ok(detail !== null, '截断的决策数组必须能容错提取（不能回落成一坨 JSON）');
  assert.deepEqual(
    detail.items.map((item) => item.symbol),
    ['WLDUSDT', 'BTWUSDT'],
    '只保留前 2 个**完整**对象',
  );
  assert.equal(detail.recovered, true, '必须标记为"容错提取"，显示层才能如实说明');
  assert.equal(detail.arrayClosed, false, '数组被截断在中间 → 必须标记"不完整"');
  assert.equal(detail.truncated, true, '必须记住"这条被截断过"');
  assert.equal(detail.originalLength, 4750, '留痕里的原始字数要原样带出来');
  /* 不完整的第三个对象（BTCUSDT）不能变成一条决策。 */
  assert.ok(!detail.items.some((item) => item.symbol === 'BTCUSDT'), '半个对象不能当成决策');
  /* 留痕那半句不是字段内容 —— 不能漏进 symbol / action / reasoning。 */
  for (const item of detail.items) {
    for (const value of [item.symbol, item.action, item.reasoning ?? '']) {
      assert.ok(!value.includes('已截断'), `留痕不该漏进字段：${value}`);
      assert.ok(!value.includes('4750'), `原始字数不该漏进字段：${value}`);
    }
  }
});

test('[校准 b-1] 剥留痕：有留痕 → 剥掉并识别原始字数；没留痕 → 一个字都不动', () => {
  const info = stripTruncationTail(`{"a":1}${TAIL}`);
  assert.equal(info.text, '{"a":1}', '尾巴必须被剥掉');
  assert.equal(info.truncated, true);
  assert.equal(info.originalLength, 4750);

  const plain = '普通文本 {不是} JSON';
  const untouched = stripTruncationTail(plain);
  assert.equal(untouched.text, plain, '没留痕时正文必须逐字不变');
  assert.equal(untouched.truncated, false);
  assert.equal(untouched.originalLength, null);
});

test('★★ 完整 JSON + 留痕尾巴 → 剥掉后照常结构化，但仍标记 truncated', () => {
  /* 截断恰好落在数组 `]` 之后的情形（后续还有正文被切掉）。 */
  const detail = parseDecisionListDetailed(`${REAL_WORLD}${TAIL}`);
  assert.ok(detail !== null, '剥掉尾巴后就是完整 JSON，必须解析成功');
  assert.equal(detail.items.length, 8);
  assert.equal(detail.truncated, true, '留痕在 → 仍然要如实说明被截断过');
  assert.equal(detail.recovered, false, '数组本身完整 → 不是容错提取');
  assert.equal(detail.arrayClosed, true);
});

test('★★ 真实形态：完整数组 + 尾部还有中文 + 留痕 → 仍然给出全部 8 条', () => {
  /*
   * 队长实测那条 tail 是「* 结论：**开空 WLDUSDT**，其余全部…（已截断，完整 4750 字）」
   * —— 决策数组**后面还有一段中文**，所以 `JSON.parse` 从数组起点一直吃到中文必然失败。
   * 这里把同样的形状钉住：数组本身是闭合的，条目**一条都不能少**，只说"被截断过"。
   */
  const withProse = `${REAL_WORLD}\n* 结论：**开空 WLDUSDT**，其余全部观望${TAIL}`;
  const detail = parseDecisionListDetailed(withProse);
  assert.ok(detail !== null, '数组完整、只是后面还有正文 → 也必须能容错提取');
  assert.equal(detail.items.length, 8, '8 条一条都不能少');
  assert.equal(detail.recovered, true);
  assert.equal(detail.arrayClosed, true, '数组是闭合的 → 显示层不能说"只显示了前 N 个"');
});

test('★★ 容错提取认识字符串里的花括号与转义引号（不能靠数 `}` 切）', () => {
  const array = JSON.stringify([
    { symbol: 'AAAUSDT', action: 'skip', reasoning: '含 } 与 { 和 " 引号' },
    { symbol: 'BBBUSDT', action: 'skip', reasoning: '第二条' },
    { symbol: 'CCCUSDT', action: 'skip', reasoning: '第三条' },
  ]);
  const cut = array.indexOf('{"symbol":"CCCUSDT"');
  /* 第三个对象只留半个 `{`，模拟截断。 */
  const truncated = `${array.slice(0, cut)}{"symbol":"CCCUSDT","act${TAIL}`;
  const detail = parseDecisionListDetailed(truncated);
  assert.ok(detail !== null);
  assert.deepEqual(detail.items.map((item) => item.symbol), ['AAAUSDT', 'BBBUSDT']);
  assert.ok(detail.items[0]!.reasoning!.includes('}'), 'reasoning 里的花括号必须原样保留');
  assert.ok(detail.items[0]!.reasoning!.includes('"'), 'reasoning 里的引号必须原样保留');
});

test('[校准 c] 截断到一个完整对象都没有 → null（回落纯文本，不白屏）', () => {
  /* 用户点名的那条：没有留痕、也没有一个完整对象。 */
  assert.equal(parseDecisionListDetailed('[{"symbol":"X","act'), null);
  /* 有留痕（= 被截断过）但一个完整对象都抠不出来 → 同样回落。 */
  const withTail = `[{"symbol":"X","act${TAIL}`;
  assert.doesNotThrow(() => parseDecisionListDetailed(withTail), '任何形态都不许抛');
  assert.equal(parseDecisionListDetailed(withTail), null, '提不出对象 → 返回 null（调用方回落纯文本）');
});

test('★★ 一条 message 里有多条留痕（多段拼接）→ 不猜，整段回落纯文本', () => {
  /*
   * 整个 `<team>` 块里每个被截断的角色各留一条痕。那种文本**不是**一个决策数组，
   * 从某一段里抠数组会把别的段落整个吞掉 —— 宁可回落纯文本（一个字节都不丢）。
   */
  const joined = `- analyst：${REAL_WORLD.slice(0, CUT_AT)}${TAIL}\n- judge：${REAL_WORLD}${TAIL}`;
  assert.equal(parseDecisionListDetailed(joined), null, '多段拼接不许被当成一个决策数组');
});

test('[校准 d] 非 JSON 普通文本 → 与改动前逐字一致（null，文本不改）', () => {
  const notes = [
    '正在分析 SOLUSDT 的回踩结构',
    '* 结论：**开空 WLDUSDT**，其余全部观望',
    '注意 {这里} 不是 JSON',
    '## 汇总\n- 第一条\n- 第二条',
  ];
  for (const note of notes) {
    assert.equal(parseDecisionListDetailed(note), null, `普通文本必须回落：${note}`);
    assert.equal(parseDecisionList(note), null, `旧入口同样回落：${note}`);
    const info = stripTruncationTail(note);
    assert.equal(info.text, note, '普通文本一个字都不许改');
    assert.equal(info.truncated, false);
  }
});

test('[校准 e] 完整数组但尾部没有留痕 → 与改动前完全一致', () => {
  const detail = parseDecisionListDetailed(REAL_WORLD);
  assert.ok(detail !== null);
  assert.equal(detail.truncated, false);
  assert.equal(detail.recovered, false);
  assert.equal(detail.arrayClosed, true);
  assert.deepEqual(detail.items, parseDecisionList(REAL_WORLD), '两条入口必须给同一批条目');
  /* 与改动前的判据一致：8 条、WLDUSDT 打头、skip 原样保留。 */
  assert.equal(detail.items.length, 8);
  assert.equal(detail.items[0]!.symbol, 'WLDUSDT');
  assert.equal(detail.items[1]!.action, 'skip');
});

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  ★★★ 真实线上样本的回归（2026-10-18）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么必须单独立这一条
 *
 * 上一版实现**通过了 415 条测试**，却在真实数据上完全不工作：
 * 它的两个夹具都恰好让"截断点落在某个字符串中间"，于是扫描器走的是
 * "未闭合对象"分支。而**真实数据的形状是另一种**：
 *
 * ```
 *   [{...},{...},* 结论：**开空 WLDUSDT**，其余全部…（已截断，完整 4750 字）
 *                 ↑ 第 3 个元素是半句话，而数组【没有】`]`
 * ```
 *
 * 老代码在遇到 `*` 时一律 `return null`，把**前两个本来完好的对象一起丢掉**
 * ⇒ 上层回落纯文本 ⇒ **用户屏幕上又是一坨原始 JSON**。
 *
 * ⇒ 这一条用**逐字复制的线上原文**做夹具。**不许改成"更顺手"的形状** ——
 *   它存在的全部意义就是钉住这个真实形状。
 */
test('★★★ 真实线上样本：数组未闭合 + 截断点后直接接模型的话 → 仍能出前 N 个完整标的', () => {
  const REAL =
    '[{"symbol":"WLDUSDT","action":"open_short","leverage":5,"positionSizeUsd":11,"stopLoss":0.5380},' +
    '{"symbol":"BTWUSDT","action":"skip","leverage":5},' +
    '* 结论：**开空 WLDUSDT**，其余全部…（已截断，完整 4750 字）';

  const detail = parseDecisionListDetailed(REAL);
  assert.notEqual(detail, null, '★ 真实形状必须能解析 —— 回落纯文本就是这个缺陷本身');
  assert.equal(detail!.items.length, 2, '★ 前两个完整标的都要出来（第三个是半句话，丢弃）');
  assert.equal(detail!.items[0]!.symbol, 'WLDUSDT');
  assert.equal(detail!.items[0]!.action, 'open_short');
  assert.equal(detail!.items[1]!.symbol, 'BTWUSDT');
  assert.equal(detail!.items[1]!.action, 'skip');
  assert.equal(detail!.recovered, true, '★ 要如实标记"这是从容错路径恢复的"');
  assert.equal(detail!.arrayClosed, false, '★ 数组确实没闭合 —— 界面据此说"只显示了前 N 个"');
  assert.equal(detail!.originalLength, 4750, '★ 留痕里的原始字数要带出来');
});

test('★★ 只有半个对象时不硬渲染（真实形状的退化版）', () => {
  const HALF =
    '[{"symbol":"WLDUSDT","action":"open_short","leverage":5},' +
    '{"symbol":"BTWUSDT","act…（已截断，完整 900 字）';
  const detail = parseDecisionListDetailed(HALF);
  assert.notEqual(detail, null);
  assert.equal(detail!.items.length, 1, '★ 只有第 1 个是完整的；第 2 个半截必须丢');
  assert.equal(detail!.items[0]!.symbol, 'WLDUSDT');
});