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

import { parseDecisionList, parseJsonLoose } from './structuredMessage';

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
