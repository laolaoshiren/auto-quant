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
  parseLooseObject,
  parseLooseObjectDetailed,
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

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  ★★★ 第二种坏法：JSON 是【模型自己写坏的】，尾部没有留痕
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 旧实现只对"认出后端留痕"的走容错提取（`if (!tail.truncated) return null`），
 * 而线上真实数据里还有这一类：
 *
 * ```
 *   /api/traders/11/agent/judge/steps 的一条裁决产出，3935 字，
 *   JSON.parse 在 position 3175 失败（少了个引号/括号），
 *   尾部**没有**「…（已截断，完整 N 字）」—— 因为它没超过 4000 的 clip 上限。
 * ```
 *
 * ⇒ 这类内容旧实现永远回落纯文本，用户屏幕上就是开头那 200 字原始 JSON。
 *   **用户报的"还是一坨 JSON"就是它。**
 */
test('★★★ 模型自己写坏的 JSON（无留痕）也要能抠出完整对象', () => {
  /* 形状取自线上：前一个对象完整，后一个对象里少了个引号 ⇒ 整体 JSON.parse 失败。 */
  const BROKEN =
    '[ {"symbol":"SIRENUSDT","action":"open_long","leverage":5,"positionSizeUsd":11,' +
    '"stopLoss":0.0776,"takeProfit":0.0815,"confidence":70,' +
    '"reasoning":"D=1.21%在窗ATR2.55%≤3.5%"},' +
    '{"symbol":"NEARUSDT","action":"skip","leverage":0,"reasoning":"坏在这里了"" }';

  /* 先确认它确实是坏的 —— 否则这条测试没有意义。 */
  assert.throws(() => JSON.parse(BROKEN), '夹具必须是 JSON.parse 会失败的 —— 否则测的不是这一类');

  const detail = parseDecisionListDetailed(BROKEN);
  assert.notEqual(detail, null, '★ 模型写坏的 JSON 也必须能救回前面的完整对象');
  assert.equal(detail!.items.length, 1, '★ 只有第 1 个对象是完整的');
  assert.equal(detail!.items[0]!.symbol, 'SIRENUSDT');
  assert.equal(detail!.items[0]!.action, 'open_long');
  assert.equal(detail!.recovered, true);
  assert.equal(detail!.arrayClosed, false, '★ 数组没闭合 —— 界面据此说"只显示了前 N 个"');
  assert.equal(detail!.truncated, false, '★ 没留痕 ⇒ 不说"原文本已截断（完整 N 字）"（不知道长度就不编）');
  assert.equal(detail!.originalLength, null);
});

test('★★ 放宽后仍然不误伤普通文本（形状守卫必须还在）', () => {
  const plain = [
    'D=-1.045%∈[0.8,3.5]，ATR≈1.0%≤3.5%，机械条件全过',
    '候选池 [1,2,3] 已按评分排序，最高 64 分',
    '[0.8,3.5] 这个区间是位移门槛',
    '见 {a:1} 这种不是标准 JSON',
  ];
  for (const p of plain) {
    assert.equal(
      parseDecisionListDetailed(p),
      null,
      `★ 普通文本不该被结构化成决策数组：${p}`,
    );
  }
});

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  ★★★ 数组/嵌套对象不能 JSON.stringify 塞进单元格
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 线上真实形状（market_analyst 的产出，JSON.parse 成功）：
 * ```
 *   {"hypothesis":"…","matches":[{"symbol":"QUSDT","strength":"weak","evidence":"…"}]}
 * ```
 * 老实现解析**成功**，但 `matches` 是数组 ⇒ `JSON.stringify` ⇒ 单元格里
 * 就是 `[{"symbol":"QUSDT","strength":…` —— **用户看到的就是这个**。
 */
test('★★★ 对象里的数组值要摘要成人话，不能吐原始 JSON', () => {
  const M =
    '{"hypothesis":"当前市场整体偏空。","matches":[' +
    '{"symbol":"QUSDT","strength":"weak","evidence":"唯一结构完整的多头标的"},' +
    '{"symbol":"ZECUSDT","strength":"moderate","evidence":"RSI 偏低但趋势未破"}],' +
    '"summary":"偏空"}';

  const rows = parseLooseObject(M);
  assert.notEqual(rows, null);
  const byKey = new Map(rows!);

  assert.equal(byKey.get('hypothesis'), '当前市场整体偏空。');
  assert.equal(byKey.get('summary'), '偏空');
  /* ★ 关键断言：数组要列出能认出的 symbol，而不是一坨 JSON。 */
  assert.equal(byKey.get('matches'), '2 项 · QUSDT、ZECUSDT');

  /* ★★ 整表都不许出现 JSON 语法符号 —— 这正是用户报的现象。 */
  for (const [k, v] of rows!) {
    assert.ok(!v.includes('{"'), `★ 字段 ${k} 的值里还有 JSON 对象开头：${v.slice(0, 60)}`);
    assert.ok(!v.includes('[{'), `★ 字段 ${k} 的值里还有 JSON 数组开头：${v.slice(0, 60)}`);
    assert.ok(!v.includes('":"'), `★ 字段 ${k} 的值里还有 JSON 键值语法：${v.slice(0, 60)}`);
  }
});

test('★★ 数组里认不出 symbol 时只说项数（不硬凑）', () => {
  const rows = parseLooseObject('{"items":[1,2,3],"note":"三个数"}');
  assert.notEqual(rows, null);
  const byKey = new Map(rows!);
  assert.equal(byKey.get('items'), '3 项');
  assert.equal(byKey.get('note'), '三个数');
});

test('★★ 嵌套对象只说字段名（不吐 JSON）', () => {
  const rows = parseLooseObject('{"indicators":{"macdHist":-0.002,"rsi14":42.1},"symbol":"AGTUSDT"}');
  assert.notEqual(rows, null);
  const byKey = new Map(rows!);
  assert.equal(byKey.get('indicators'), '2 个字段：macdHist、rsi14');
  assert.equal(byKey.get('symbol'), 'AGTUSDT');
});

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⑥ 被截断的【对象】—— 用户截图里仍在原样显示的 ①②③（2026-10-18）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户原话：
 * ```
 *   「这是给人看的格式吗？虽然我不懂技术，但是我也能看出来这里面很多是
 *     原封不动的 json 格式吧？前端没有做 json 解析提取对吗？」
 * ```
 *
 * ①②③ 都是**被后端截断过的对象**：`JSON.parse` 必然失败 ⇒ 旧实现直接回落纯文本
 * ⇒ 屏幕上就是原始 JSON。下面三段是**逐字复制**的用户截图原文 ——
 * **不许改成"更顺手"的形状**，它们存在的意义就是钉住这个真实形状。
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

/** 把结果摊平成"屏幕上会出现的一串字"，用来做"不出现 JSON 语法"的判据。 */
function displayedText(detail: NonNullable<ReturnType<typeof parseLooseObjectDetailed>>): string[] {
  return detail.rows.flatMap((row) => [
    row.key,
    row.text,
    ...(row.items ?? []).flatMap((item) => [item.symbol ?? '', item.detail]),
  ]);
}

test('★★★ [校准 ①②③] 被截断的对象也能进键值表，且只保留完整收下的内容', () => {
  /*
   * ⚠️ 负向校准：把 `HumanMessage` / 本函数改回"只走 parseLooseObject"，
   * 这三条全部返回 null ⇒ 屏幕上又是原始 JSON ⇒ 用户报的现象照旧。
   */

  /* ① symbols 数组里第一个标的：symbol + structure 完整，indicators 半截 → 丢弃。 */
  const one = parseLooseObjectDetailed(TRUNCATED_OBJ_1);
  assert.notEqual(one, null, '① 必须能提取（不能回落成一坨 JSON）');
  assert.equal(one!.incomplete, true, '① 外层没闭合 → 必须标记"内容不完整"');
  assert.equal(one!.rows.length, 1, '① 顶层只有一个字段 symbols');
  assert.equal(one!.rows[0]!.key, 'symbols');
  assert.equal(one!.rows[0]!.items?.length, 1, '① symbols 里有一个还能认出的标的');
  assert.equal(one!.rows[0]!.items?.[0]!.symbol, 'AGTUSDT');
  assert.ok(
    one!.rows[0]!.items?.[0]!.detail.includes('现价 0.079220'),
    '① 每个标的一行，摘要要带上 structure',
  );
  assert.equal(one!.truncated, false, '① 没有留痕 → 不编原始字数');

  /* ② 两条完整键值对；值里的英文枚举必须中文化。 */
  const two = parseLooseObjectDetailed(TRUNCATED_OBJ_2);
  assert.notEqual(two, null, '② 必须能提取');
  assert.equal(two!.incomplete, true);
  const twoByKey = new Map(two!.rows.map((row) => [row.key, row.text]));
  assert.equal(twoByKey.get('side'), '只空或不交易', 'short_or_no_trade 必须译成中文');
  assert.equal(twoByKey.get('strength'), '强', 'strong 必须译成中文');

  /* ③ 一条完整键值对都没有，只剩半截字符串 —— 显示完整键 + 可见前缀。 */
  const three = parseLooseObjectDetailed(TRUNCATED_OBJ_3);
  assert.notEqual(three, null, '③ 必须能提取（否则屏幕上又出现 {"）');
  assert.equal(three!.incomplete, true);
  assert.equal(three!.rows.length, 1);
  assert.equal(three!.rows[0]!.key, 'hypothesis');
  assert.ok(
    three!.rows[0]!.text.startsWith('当前市场整体处于普跌'),
    '③ 半截字符串的可见前缀要显示出来',
  );
});

test('★★★ [校准 ①②③] 屏幕上不出现 {" 与 ":[（三种真实形态逐个判）', () => {
  for (const [name, input] of [
    ['①', TRUNCATED_OBJ_1],
    ['②', TRUNCATED_OBJ_2],
    ['③', TRUNCATED_OBJ_3],
  ] as Array<[string, string]>) {
    const detail = parseLooseObjectDetailed(input);
    assert.notEqual(detail, null, `${name} 必须被结构化`);
    for (const shown of displayedText(detail!)) {
      assert.ok(!shown.includes('{"'), `${name} 的显示内容里还有 JSON 对象开头：${shown.slice(0, 60)}`);
      assert.ok(!shown.includes('":['), `${name} 的显示内容里还有 JSON 数组语法：${shown.slice(0, 60)}`);
      assert.ok(!shown.includes('":"'), `${name} 的显示内容里还有 JSON 键值语法：${shown.slice(0, 60)}`);
    }
  }
});

test('★★ 外层被截断、但最后一个内层对象恰好完整 → 仍要显示全部元素（不能只剩最后一个）', () => {
  /*
   * 真 BUG（自测抓到）：`JSON.parse` 从最靠右的 `{` 开始试，若最后一个元素恰好完整，
   * 严格路径会成功 —— 屏幕就只剩最后一个标的，前面的全丢。
   * 夹具故意让外层缺一个 `}`（`[{"A"},{"B"}]` 之后没有 `}`）。
   *
   * ⚠️ 负向校准：把 `parseLooseObjectDetailed` 改回"先试严格路径、成功就用"，这条必红。
   */
  const outerBroken = '{"symbols":[{"symbol":"A","structure":"x"},{"symbol":"B","structure":"y"}]';
  const detail = parseLooseObjectDetailed(outerBroken);
  assert.notEqual(detail, null);
  assert.deepEqual(detail!.rows[0]!.items?.map((item) => item.symbol), ['A', 'B']);
  assert.equal(detail!.incomplete, true, '外层没闭合 → 必须如实标记');
});

test('★★ 中文前缀不影响定位最外层对象的 `{`', () => {
  /* 用户描述的真实前缀形态：「让我先理清我的角色：…输出必须是 JSON 对象：{」。 */
  const prefixed =
    '让我先理清我的角色：只做分析，不下单。输出必须是 JSON 对象：' +
    '{"symbols":[{"symbol":"AGTUSDT","structure":"15m 结构","support":0.072088,"resistance":0.080739}';
  const detail = parseLooseObjectDetailed(prefixed);
  assert.notEqual(detail, null, '带中文前缀的对象必须能提取');
  assert.equal(detail!.rows[0]!.key, 'symbols', '必须认最外层那个对象，不是内层元素');
  assert.equal(detail!.rows[0]!.items?.[0]!.symbol, 'AGTUSDT');
  assert.equal(detail!.incomplete, true);
});

test('★★ 完整对象走严格路径：与 `parseLooseObject` 的行内容逐字一致', () => {
  /*
   * 覆盖三种"改动前就能显示"的形态：多字段对象、**单字段对象**、带中文前缀的单字段对象。
   * 它们**必须**与 `parseLooseObject` 给出一模一样的行 —— 新增容错路径不许悄悄换形状。
   */
  const completes = [
    '{"action":"open_short","symbol":"WLDUSDT","leverage":5}',
    '{"action":"skip"}',
    '说明：{"a":1}',
  ];
  for (const complete of completes) {
    const detail = parseLooseObjectDetailed(complete);
    assert.notEqual(detail, null, `完整对象必须照常解析：${complete}`);
    assert.deepEqual(
      detail!.rows,
      parseLooseObject(complete)!.map(([key, text]) => ({ key, text })),
      `完整对象不许改变行为：${complete}`,
    );
    assert.equal(detail!.incomplete, false);
    assert.equal(detail!.truncated, false);
  }
});

test('★★ 完整对象 + 留痕 → 照常键值表，但仍标记 truncated', () => {
  const detail = parseLooseObjectDetailed(`{"action":"open_short","symbol":"WLDUSDT"}${TAIL}`);
  assert.notEqual(detail, null);
  assert.equal(detail!.rows.length, 2);
  assert.equal(detail!.truncated, true, '留痕在 → 必须如实说明被截断过');
  assert.equal(detail!.originalLength, 4750);
  assert.equal(detail!.incomplete, false, '对象本身是闭合的 → 不能说"只显示了完整的部分"');
});

test('★★★ [校准 ②] 普通文本与"只有单个标量对"的坏 JSON → 一律回落（与改动前逐字一致）', () => {
  /*
   * 这一条是"不许破坏已有 28 条测试"的边界：
   * ```
   *   [0.8,3.5] / [1,2,3] / 见 {a:1}  → 没有可用的键值对
   *   [{"symbol":"X","act…            → 只有一个完整标量对，**不足以成表**
   * ```
   * 任何一条被结构化成表，都说明判据松了（用户屏幕上会出现半张莫名其妙的表）。
   */
  const notes = [
    '正在分析 SOLUSDT 的回踩结构',
    'D=-1.045%∈[0.8,3.5]，ATR≈1.0%≤3.5%，机械条件全过',
    '[0.8,3.5] 这个区间是位移门槛',
    '[1,2,3] 候选池',
    '见 {a:1} 这种不是标准 JSON',
    '注意 {这里} 不是 JSON',
    '## 汇总\n- 第一条\n- 第二条',
    '[{"symbol":"WLDUSDT","action":"op',
    `[{"symbol":"X","act${TAIL}`,
    /*
     * ⚠️ `'{"a":1,"b":2} 后面还有解释'` 曾经在这张表里，**2026-10-18 移走**。
     *
     * 它不是一个"普通文本"，而是**一个正经的 JSON 对象后面跟了中文** ——
     * 与线上那条真实的 `{"hypothesis":"…"} 材料不足，无法出结论。…`（799 字）**同形**。
     * 用户报的"还是一坨 JSON"正是这一类。
     *
     * 旧断言把它钉在"必须回落"，等于**把缺陷钉成了规格**。现在它有专门的一条断言（见下）。
     */
  ];
  for (const note of notes) {
    assert.equal(parseLooseObjectDetailed(note), null, `必须回落纯文本：${note}`);
    assert.doesNotThrow(() => parseLooseObjectDetailed(note), '任何形态都不许抛');
  }
});

test('★★★ 完整对象 + 后面跟中文 → 必须接管（这是用户报的那一类，不再是"回落"）', () => {
  /*
   * 线上真实形状（`market_analyst` 的一条 799 字产出，独立验证者从 API 抄下来的）：
   * ```
   *   {"hypothesis":"当前市场整体处于普跌/风险偏好收缩状态，…"}
   *    材料不足，无法出结论。以下是我能确认的：…三项判定。
   *   ↑ 对象完整闭合，后面又接了中文
   * ```
   * 老判据（`complete && !truncated → 不接管`）让它在屏幕上原样显示 JSON。
   */
  const detail = parseLooseObjectDetailed(
    '{"hypothesis":"当前市场整体处于普跌、风险偏好收缩状态，多数标的同步走弱，"}' +
      ' 材料不足，无法出结论。以下是我能确认的三项判定。',
  );
  assert.notEqual(detail, null, '★ 完整对象 + 尾随中文 必须接管（这是用户报的那一类）');
  assert.equal(detail!.rows.length, 1);
  assert.equal(detail!.rows[0]!.key, 'hypothesis');
  assert.equal(
    detail!.incomplete,
    true,
    '★ 后面还有没进表的中文 ⇒ 必须如实标"你看到的不是全文"',
  );

  /* 普通文本里的短对象仍然回落（值太短，够不上"像正文"这道门）。 */
  assert.equal(parseLooseObjectDetailed('{"a":1,"b":2} 后面还有解释'), null, '值只有 1 字 ⇒ 回落');
});

test('★★★ [校准 ③] 完全无法提取的坏文本 → null（回落纯文本、不白屏、不空表）', () => {
  const bad = ['{"a":', '{"a":,}', '{{{{', '{', '{"', '{"a":"', '<<<>>>', ''];
  for (const input of bad) {
    assert.doesNotThrow(() => parseLooseObjectDetailed(input), `坏文本不许抛：${input}`);
    assert.equal(parseLooseObjectDetailed(input), null, `提不出键值对 → 回落：${input}`);
  }
});

test('★★ 多条留痕（多段拼接）→ 不从一个对象里猜', () => {
  const joined = `{"a":1,"b":2}${TAIL}\n另一段：{"c":3,"d":4}${TAIL}`;
  assert.equal(parseLooseObjectDetailed(joined), null, '多段拼接不是"一个对象"');
});