/**
 * **围栏里的 JSON 带前缀说明时必须能被取出来**（外部 issue #160）。
 *
 * ## 缺陷
 *
 * `extractDecisions()` 原来的第 3 步是**同一个正则对同一个 `body`** 再求值一次：
 *
 * ```ts
 * const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);   // 第 1 步
 * if (fenced?.[1]?.trim()) return fenced[1].trim();
 * …
 * const anyFence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body); // 第 3 步：同一正则、同一输入
 * if (anyFence?.[1]?.trim()) { … }                              // ← 永不可达
 * ```
 *
 * `fenced[1] === anyFence[1]` 恒成立 ⇒ 第 1 步不 return 时第 3 步也不 return。
 * **那层"兜底"一层保护都没提供**，却让读代码的人以为容错有三层。
 *
 * ## 但真正的问题比"死代码"更重
 *
 * 第 3 步**本来想解决的场景是真实存在的**：模型经常在围栏里先写一句说明再给 JSON。
 *
 * ```text
 *   ```json
 *   分析如下:
 *   [{"symbol":"BTCUSDT","action":"wait"}]
 *   ```
 * ```
 *
 * 而原实现把**整段（含"分析如下:"）**当作 JSON 返回 → `safeParseJson` 失败
 * → **整轮零决策**，而模型真正要交付的内容就在下一行。
 *
 * 所以这个 issue 的价值不只是"删掉死代码"，而是**它掩盖了一个真实的容错缺口**。
 *
 * ## 修法
 *
 * 把第 3 步**原本的意图真正实现**：围栏内容不是裸 JSON 时，**在围栏内部**
 * 再找一次平衡 JSON（`findBalancedJson(fencedText)`）。
 *
 * ⚠️ 作用域仍**限定在围栏里** —— 不能退化成"去整份响应里乱找"：
 * `extractDecisions` 开头那段注释记着一个实测事故（#1623），
 * 就是因为从响应里乱找平衡点而返回了"看起来合法、其实是错的"内容。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { extractDecisions, parseDecisionResponse, type ParseContext } from './parser.js';

/** 一个最小的解析上下文。 */
function ctx(): ParseContext {
  return {
    candidateSymbols: new Set(['BTCUSDT', 'ETHUSDT']),
    openPositions: new Map(),
    allowUnlistedCloses: false,
    pendingSymbols: new Set(),
  } as unknown as ParseContext;
}

const DECISION = '[{"symbol":"BTCUSDT","action":"wait","confidence":80}]';

test('★★★ 围栏里的 JSON 带前缀说明时必须能取出来 —— 否则整轮零决策', () => {
  /*
   * ⚠️ 这条是 issue #160 暴露出的**真实容错缺口**（不只是"死代码"）。
   * 修之前：`决策数 = 0`，日志写"模型返回的 JSON 在自动修复之后仍无法解析"。
   */
  const text = `<decision>\n\`\`\`json\n分析如下:\n${DECISION}\n\`\`\`\n</decision>`;

  const extracted = extractDecisions(text);
  assert.ok(extracted, '★★★ 必须能提取出 JSON —— 修之前这里返回的是带前缀的整段文本');
  assert.doesNotMatch(
    extracted,
    /分析如下/,
    '★★★ 取出的内容不能包含前缀说明 —— 那会让 JSON.parse 失败',
  );
  assert.equal(
    JSON.parse(extracted)[0].symbol,
    'BTCUSDT',
    '★ 取出的必须是那段真正的 JSON',
  );

  const parsed = parseDecisionResponse(text, ctx());
  assert.equal(
    parsed.decisions.length,
    1,
    '★★★ 语义层也要拿到 1 条决策 —— 修之前是 0 条（这一轮调用白花）',
  );
});

test('★★★ 中文前缀、多行前缀、无语言标记的围栏都要能取出来', () => {
  const variants: Array<[string, string]> = [
    ['中文说明', `<decision>\n\`\`\`json\n以下是决策：\n${DECISION}\n\`\`\`\n</decision>`],
    ['多行前缀', `<decision>\n\`\`\`json\n先看行情。\n再看仓位。\n${DECISION}\n\`\`\`\n</decision>`],
    ['无语言标记', `<decision>\n\`\`\`\n输出:\n${DECISION}\n\`\`\`\n</decision>`],
    ['前缀带冒号与空行', `<decision>\n\`\`\`json\n reasoned:\n\n${DECISION}\n\`\`\`\n</decision>`],
  ];

  for (const [label, text] of variants) {
    const extracted = extractDecisions(text);
    assert.ok(extracted, `★★★ ${label}：必须能提取`);
    assert.equal(JSON.parse(extracted)[0].symbol, 'BTCUSDT', `★ ${label}：内容正确`);
    assert.equal(parseDecisionResponse(text, ctx()).decisions.length, 1, `★★★ ${label}：语义层拿到 1 条`);
  }
});

test('★ 纯裸 JSON 围栏的行为不变 —— 不要为了容忍前缀而改掉正常路径', () => {
  /* 反向守卫：这是绝大多数响应的形态，必须一字不变。 */
  const text = `<decision>\n\`\`\`json\n${DECISION}\n\`\`\`\n</decision>`;
  assert.equal(extractDecisions(text), DECISION, '★ 裸 JSON 必须原样取出（不做任何加工）');
});

test('★ 裸 JSON（无围栏）的行为不变', () => {
  const text = `<decision>\n${DECISION}\n</decision>`;
  assert.equal(extractDecisions(text), DECISION, '★ 无围栏时走第 2 步，行为不变');
});

test('★★★ 作用域仍限定在围栏内 —— 不能退化成"去整份响应里乱找"', () => {
  /*
   * ⚠️ 这条防的是**修法过宽**。`extractDecisions` 开头那段注释记着实测事故
   * （#1623）：响应前面还有模型的分析草稿 JSON，从整份响应里乱找平衡点
   * 会返回"看起来合法、其实是错的"内容 → 整轮零决策。
   *
   * 所以：围栏内容**全是文字**（没有 JSON）时，不该去围栏外捡别的东西。
   * 它应当回落到后面的步骤（裸数组 / 截断抢救），而不是"成功"返回一段草稿。
   */
  const text = `<decision>\n\`\`\`json\n这段围栏里没有 JSON，只有说明文字。\n\`\`\`\n</decision>`;
  assert.equal(
    extractDecisions(text),
    null,
    '★★★ 围栏内没有 JSON 时不能"顺手"去别处找 —— 那会把草稿当成交付内容',
  );
});

test('★★ 围栏内有【嵌套】JSON 时也要能取出外层完整对象', () => {
  /*
   * `findBalancedJson` 会跳过字符串内部的括号，所以带 `reasoning` 文本的
   * 真实决策对象（可能含 `{`）也能正确配平。这条钉住它。
   */
  const nested = '[{"symbol":"BTCUSDT","action":"wait","reasoning":"价格在 {区间} 内"}]';
  const text = `<decision>\n\`\`\`json\n分析:\n${nested}\n\`\`\`\n</decision>`;
  const extracted = extractDecisions(text);
  assert.ok(extracted, '★★ 必须能提取');
  const parsed = JSON.parse(extracted) as Array<{ reasoning: string }>;
  assert.match(parsed[0]!.reasoning, /区间/, '★ 字符串里的花括号不该让配平提前结束');
});
