/**
 * 团队输出适配器的测试。
 *
 * 这个适配器是 S3 **能不能真正跑起来**的关键：团队跑完一轮，如果翻译不对，
 * 交易循环解析不到决策 —— **整轮白跑，而且不报错**（只表现为"没有动作"）。
 * 那是最难发现的一种失败，所以这里要把边界钉死。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { extractDecisionArray, extractFirstJsonArray, renderDeskOutcome } from './deskOutput.js';
import type { DeskOutcome, DeskRoleOutput } from './tradingDesk.js';

function role(name: string, raw: string, ok = true): DeskRoleOutput {
  return { role: name, modelId: `stub/${name}`, data: null, raw, latencyMs: 10, ok, ...(ok ? {} : { error: '模拟失败' }) };
}

function outcome(patch: Partial<DeskOutcome> = {}): DeskOutcome {
  return {
    analyses: [],
    bull: null,
    bear: null,
    verdict: null,
    callsUsed: 7,
    truncatedByBudget: false,
    summary: '测试用',
    ...patch,
  };
}

/* -------------------------------------------------------------------------- */
/*  JSON 数组抽取（易错点集中在这里）                                          */
/* -------------------------------------------------------------------------- */

test('★ 能抽出嵌在散文里的决策数组', () => {
  const text = '我的结论如下：\n[{"symbol":"BTCUSDT","action":"open_long"}]\n以上。';
  const r = extractFirstJsonArray(text);
  assert.equal(r.status, 'ok');
  assert.equal(r.decisions?.length, 1);
});

test('★ 嵌套数组不会被贪婪匹配吃掉（正则写法就会错）', () => {
  /*
   * `\[[\s\S]*\]` 会一路匹配到**最后一个** `]`，于是尾巴被吃进来变成非法 JSON。
   * 而模型的输出里嵌套数组很常见。
   */
  const text = '[{"symbol":"BTCUSDT","levels":[1,2,3]},{"symbol":"ETHUSDT","levels":[4]}] 结尾说明';
  const r = extractFirstJsonArray(text);
  assert.equal(r.status, 'ok', '★ 嵌套数组必须能正确闭合');
  assert.equal(r.decisions?.length, 2);
  assert.deepEqual((r.decisions?.[0] as Record<string, unknown>).levels, [1, 2, 3]);
});

test('★ 字符串内部的方括号不参与计数（否则括号会错位）', () => {
  const text = '[{"symbol":"BTCUSDT","reasoning":"买入[区间]是 0.5-0.6"}]';
  const r = extractFirstJsonArray(text);
  assert.equal(r.status, 'ok', '★ 字符串里的方括号不能让计数错位');
  assert.equal(r.decisions?.length, 1);
});

test('★ 字符串里的转义引号不破坏解析', () => {
  const text = '[{"symbol":"BTCUSDT","reasoning":"他说\\"买\\"我就买"}]';
  const r = extractFirstJsonArray(text);
  assert.equal(r.status, 'ok');
});

test('★ 被截断的输出 → bad-json（不是静默当成空）', () => {
  /*
   * 实测：token 上限截断是真实故障形态。截断的输出**必须与"模型说空数组"区分**，
   * 否则运维会以为"模型决定不行动"，而不是"输出被截断了"。
   */
  const text = '[{"symbol":"BTCUSDT","action":"open_long","reasoning":"因';
  const r = extractFirstJsonArray(text);
  assert.equal(r.status, 'bad-json', '★ 截断必须被识别为解析失败');
  assert.ok(r.snippet && r.snippet.length > 0, '要保留片段供排查');
});

test('★ 没有数组 → no-block（与 bad-json 区分）', () => {
  const r = extractFirstJsonArray('我认为现在不宜交易，建议观望。');
  assert.equal(r.status, 'no-block');
  assert.equal(r.decisions, null);
});

test('空数组是合法结论（"不行动"）', () => {
  /*
   * ⚠️ 2026-10-15：状态从 `ok` 细分成 **`empty`**。
   * 理由：`decisions: []`（模型明确"不行动"）与 `decisions: null`（没抽到）
   * 在调用方是**两种分支** —— 前者是判断，后者要在审计块里报"这一轮为什么没有数组"。
   * 原来两者都返回 `ok`，渲染层于是无法区分，见 `ExtractedDecisions.status` 的说明。
   */
  const r = extractFirstJsonArray('[]');
  assert.equal(r.status, 'empty', '★ 空数组是【模型明确说不行动】，必须与"没抽到"分开');
  assert.deepEqual(r.decisions, []);
});

test('导出的不是数组（是对象）→ bad-json', () => {
  const r = extractFirstJsonArray('{"symbol":"BTCUSDT"}');
  assert.equal(r.status, 'no-block', '没有 `[` 就是 no-block');
  const r2 = extractFirstJsonArray('[{"a":1},"多余的"] 后面还有 [1,2]');
  assert.equal(r2.status, 'ok', '第一个完整数组能被解析即可');
});

/* -------------------------------------------------------------------------- */
/*  渲染成 autoTrader 认的格式                                                */
/* -------------------------------------------------------------------------- */

test('★★ 裁决里的决策必须原样进入 <decision> 块（交易循环唯一认的东西）', () => {
  const out = outcome({
    verdict: role('judge', '结论：\n[{"symbol":"BTCUSDT","action":"open_long","stopLoss":60000}]'),
    analyses: [role('market_analyst', '市场偏多')],
  });
  const text = renderDeskOutcome(out);

  assert.ok(text.includes('<decision>'), '必须有 decision 块');
  assert.ok(text.includes('</decision>'), '必须有闭合');
  assert.ok(text.includes('"action":"open_long"'), '★ 决策内容要原样保留');
  assert.ok(text.includes('BTCUSDT'));
  /* 团队审计信息也要在（用户要求看得见） */
  assert.ok(text.includes('<team>'), '要有团队审计块');
  assert.ok(text.includes('市场偏多'), '各角色产出要附上');
});

test('★ 裁决解析失败时【返回空决策 + 说明原因】，绝不编造动作', () => {
  /*
   * 这条是安全底线：解析不出来时**宁可不行动**，也不能猜一个动作去下单。
   */
  const out = outcome({ verdict: role('judge', '我建议买入，但没写 JSON 数组。') });
  const text = renderDeskOutcome(out);

  assert.ok(text.includes('<decision>\n[]\n</decision>'), '★ 必须是空决策数组');
  assert.ok(text.includes('没有找到 JSON 数组'), '要说清是哪一种失败');
  assert.ok(!text.includes('open_long'), '★ 绝不能凭空造出开仓动作');
});

test('★ 截断的裁决也按"不行动"处理并说清是截断', () => {
  const out = outcome({ verdict: role('judge', '[{"symbol":"BTCUSDT","action":"open_lo') });
  const text = renderDeskOutcome(out);
  assert.ok(text.includes('<decision>\n[]\n</decision>'), '★ 截断必须保守处理');
  assert.ok(text.includes('解析失败'), '要说清是解析失败（可能是截断）');
});

test('★ 裁决缺失（judge 没跑）→ 空决策，而不是崩溃', () => {
  const out = outcome({ verdict: null, truncatedByBudget: true });
  const text = renderDeskOutcome(out);
  assert.ok(text.includes('<decision>\n[]\n</decision>'));
  assert.ok(text.includes('提前收尾'), '★ 受限要如实说明 —— 否则看起来像"模型决定不行动"');
});

test('角色失败时审计块要如实标注，不掩盖', () => {
  const out = outcome({
    verdict: role('judge', '[]'),
    analyses: [role('newscaster', '', false)],
  });
  const text = renderDeskOutcome(out);
  assert.ok(text.includes('失败'), '★ 失败的角色要在审计块里标明');
  assert.ok(text.includes('newscaster'));
});

/* -------------------------------------------------------------------------- */
/*  风控官的应用（用户需求 #3：风控由智能体负责）                                */
/* -------------------------------------------------------------------------- */

test('★★ 风控官【否决】→ 决策被清空（本轮不行动）', () => {
  /*
   * 这是"风控由智能体负责"的核心：裁决官说开仓，风控官说不许，**结论是不许**。
   * 若这一条不成立，风控智能体就只是"提建议" —— 而调研明确指出
   * "只提建议的风控等于没有风控"（TradingAgents 的教训）。
   */
  const out = outcome({
    verdict: role('judge', '[{"symbol":"BTCUSDT","action":"open_long","positionSizeUsd":200}]'),
  });
  const text = renderDeskOutcome(out, {
    approved: false,
    adjusted: null,
    reason: '当前回撤已达上限，不应再增加敞口。',
    concern: '连续 3 笔亏损',
  });

  const extracted = extractFirstJsonArray(text.slice(text.indexOf('<decision>')));
  /* ⚠️ 2026-10-15：空决策块的状态是 `empty`（模型/系统明确"不行动"），不再是 `ok`。 */
  assert.equal(extracted.status, 'empty');
  assert.deepEqual(extracted.decisions, [], '★ 风控否决必须真的清空决策');
  assert.ok(text.includes('<risk>'), '要有风控审计块');
  assert.ok(text.includes('否决'), '★ 审计块要说清是"否决"');
  assert.ok(text.includes('回撤'), '★ 理由要能读');
});

test('★★ 风控官【削减】→ 用削减后的决策（而不是原决策）', () => {
  const out = outcome({
    verdict: role('judge', '[{"symbol":"BTCUSDT","action":"open_long","positionSizeUsd":200}]'),
  });
  const text = renderDeskOutcome(out, {
    approved: true,
    adjusted: [{ symbol: 'BTCUSDT', action: 'open_long', positionSizeUsd: 100 } as never],
    reason: '仓位减半。',
    concern: null,
  });

  const extracted = extractFirstJsonArray(text.slice(text.indexOf('<decision>')));
  assert.equal(extracted.status, 'ok');
  const first = extracted.decisions?.[0] as Record<string, unknown>;
  assert.equal(first.positionSizeUsd, 100, '★ 必须用削减后的金额，而不是裁决官原本的 200');
  assert.ok(text.includes('削减后放行'), '★ 审计块要标明这是削减过的');
});

test('★★ 风控官【没跑】时必须在审计块里标明（不能静默跳过）', () => {
  /*
   * 静默跳过会让操作员以为"风控看过了" —— 而实际上没有。
   * 用户要求看得见，这里就是最该被看见的一件事。
   */
  const out = outcome({ verdict: role('judge', '[{"symbol":"BTCUSDT","action":"open_long"}]') });
  const text = renderDeskOutcome(out, null);

  assert.ok(text.includes('未经风控官审阅'), '★ 必须明确说没审阅');
  const extracted = extractFirstJsonArray(text.slice(text.indexOf('<decision>')));
  assert.equal(extracted.status, 'ok');
  assert.equal(extracted.decisions?.length, 1, '没审阅时按裁决官结论放行（不擅自拦截）');
});

test('风控官放行时不改动决策', () => {
  const out = outcome({ verdict: role('judge', '[{"symbol":"BTCUSDT","action":"open_long"}]') });
  const text = renderDeskOutcome(out, { approved: true, adjusted: null, reason: '仓位合适。', concern: null });
  const extracted = extractFirstJsonArray(text.slice(text.indexOf('<decision>')));
  assert.equal(extracted.decisions?.length, 1);
  assert.ok(text.includes('放行'));
});

/* -------------------------------------------------------------------------- */
/*  ⚠️ 2026-10-15：空决策的【真实原文】与审计文案分级                          */
/*                                                                            */
/*  为什么这一组测试存在：线上 `#11` 有 37.8% 的轮次是空决策，而审计块曾经把   */
/*  「模型判断不做」与「系统故障」写成同一句（或都没说清），操作员据此排查会    */
/*  走错方向。下面每一条都用**线上 raw_response 的真实文本**，钉住             */
/*  「哪一种失败说哪一句话」，并顺带钉住**不能伪造决策**这条安全底线。          */
/* -------------------------------------------------------------------------- */

test('★★★ 推理里的 `close[-1]` 不能被当成决策数组（线上 c192 的 `[-1]`）', () => {
  /*
   * ## 事故现场（`#11` · id=2761 · cycle=192 · 2026-10-14T14:57Z）
   *
   * ```
   *   raw_response:  <decision>
   *                  [-1]                     ← 进了交易循环
   *                  </decision>
   * ```
   * 而那个 `[-1]` 根本不是模型给的决策 —— 它是裁决官论证 "最后一根收盘价" 时写的
   * `close[-1]`，被 `extractFirstJsonArray` 当成了数组。
   *
   * ## 为什么这不是"无害的噪声"
   * ```
   *   ① 汇报员拿着它写出：「本轮团队唯一一条决策不带 action 字段……
   *      需操作员核实是否漏发动作」→ 一条【假告警】，而操作员无从核实
   *   ② 审计块唯一的用途是"事后说清当时为什么这么做"，它不能自己造假线索
   * ```
   * 下面这段就是 `c192` 裁决官原文的形状（论证 + 推理里的下标写法）。
   */
  const judgeRaw = [
    '**SOLUSDT 现价 103.5100，开空：**',
    '止损 = 103.5100 × 1.015 = **105.063**；止盈 = 103.5100 × 0.965 = **99.887**',
    '- 序列取值：close[-1] = 2.4831、close[-2] = 2.4753、close[-6] = 2.5218',
    '```json',
    '[-1]',
    '```',
  ].join('\n');

  /* 抽取器层：必须判成"这不是决策"，而不是"抽到了 1 条决策"。 */
  const ex = extractDecisionArray(judgeRaw);
  assert.equal(ex.status, 'not-decisions', '★ 元素没有 action 字段 → 不是决策数组');
  assert.equal(ex.decisions, null, '★ 绝不能把 [-1] 当决策交出去');

  /* 渲染层：决策块必须是空数组（不行动），且文案不能诬告"模型漏发决策"。 */
  const text = renderDeskOutcome(outcome({ verdict: role('judge', judgeRaw) }));
  assert.ok(text.includes('<decision>\n[]\n</decision>'), '★ 必须是空决策数组');
  assert.ok(!text.includes('<decision>\n[-1]'), '★ 垃圾数组不得进入 <decision> 块');
  assert.ok(text.includes('不是决策数组'), '★ 要说清"这段文本不是决策"，而不是"模型漏发了决策"');
  assert.ok(text.includes('裁决') && text.includes('JSON'), '★ 跨目录契约：这两行字样是前端判据的词根');
});

test('★★★ 空决策的四种失败必须【各说各的事实】,不能都叫"可能被截断"', () => {
  /*
   * ## 事故：一句笼统文案把 70 条"判断"说成"故障嫌疑"
   *
   * 线上 108 条空决策逐条重放（见 `deskOutput.ts` 里那段实测分布）：
   * ```
   *   no-block 70 条（65%）← 裁决官全程没写 `[`：62 条是【文字判断不做】，8 条是【没产出】
   *   bad-json  5 条（ 5%）← 真截断（有未闭合的 `[`）
   * ```
   * 而文案对 `bad-json` 一律写「JSON 解析失败（可能被截断）」，
   * 又把"没产出"与"文字判断不做"说成同一句 —— 操作员无法判断该不该去查。
   */
  const text = (verdict: DeskRoleOutput | null): string =>
    renderDeskOutcome(outcome(verdict === null ? { verdict: null } : { verdict }));

  /* ① judge 写了 ` ```json ` 就停（线上 c137 的形状：模型自己停，不是 token 顶格）。 */
  const fenceStop = text(role('judge', '我对 BAT 触发无异议。\n\n```json'));
  assert.ok(/没有闭合|解析失败/.test(fenceStop), '★ 截断要说"没有闭合/解析失败"');
  assert.ok(fenceStop.includes('被截断'), '★ 真截断必须明说"被截断"（让操作员去查预算）');
  /*
   * ⚠️ 这条是**跨目录契约**：前端 `decisionZeroState.ts` 用
   * 「裁决官写到 json 代码块就停」把这一态认成 `no-block-truncated`。
   * 只有能把"模型停在自己开的围栏前"与"输出被 token 截掉"分开，
   * 才谈得上给操作员正确的排查方向。
   */
  assert.ok(fenceStop.includes('裁决官写到 json 代码块就停'), '★ 跨目录契约：这一态的判别词根');

  /* ② 未闭合的 `[`（确凿的 token 截断，judgeBudget.test.ts 记录过的那种）。 */
  const truncated = text(role('judge', '结论：\n[{"symbol":"WUSDT","action":"skip","reasoning":"急跌后短修复但1'));
  assert.ok(truncated.includes('没有闭合'), '★ 有未闭合 `[` → 必须说"没有闭合"');

  /* ③ 裁决官有产出、但以散文说"不行动" → 这是【判断】，不是故障。 */
  const proseOnly = text(role('judge', '## Judge结论：**不行动**\n\n我不同意做多方…'));
  assert.ok(proseOnly.includes('裁决里没有找到 JSON 数组'), '★ 保留既有词根（前端判据要用）');
  assert.ok(proseOnly.includes('判断'), '★ 必须明说这是【判断】，不是故障');
  assert.ok(!proseOnly.includes('被截断'), '★ 判断态【不能】说"被截断"（那会把操作员带去查预算）');

  /* ④ 裁决官这一轮没有产出 → 这是【故障】，要查网关/冷却/额度。 */
  const noOutput = text(role('judge', '档位 T2_mid 的候选链全部处于冷却期', false));
  assert.ok(noOutput.includes('没有产出'), '★ 无产出必须与"文字判断"分开说');
  assert.ok(noOutput.includes('故障'), '★ 定性为故障（否则操作员不会去查）');
  assert.ok(!noOutput.includes('被截断'), '★ 无产出不能诬告成截断');

  /* ⑤ 模型【真的】写了 `[]` → 合法结论，**不应该有任何告警**。 */
  const emptyArray = text(role('judge', '```json\n[]\n```'));
  assert.ok(!emptyArray.includes('没有找到 JSON 数组'), '★ 真空数组是合法结论，不该报警');
  assert.ok(!emptyArray.includes('被截断'), '★ 更不该说截断');
  assert.ok(emptyArray.includes('<decision>\n[]\n</decision>'));
  /*
   * ⚠️ 而 `verdict === null`（整条链路连裁决都没跑）也走"没有产出"这一支 ——
   * 它与"裁决官说散文"必须分开，见 `outcome.verdict === null` 的判据。
   */
  const noVerdict = text(null);
  assert.ok(noVerdict.includes('没有产出'), '★ 连裁决都没有 = 没产出（故障）');
});

test('★★ 形态校验失败时【绝不补一个动作】—— 它只能变成"没抽到"', () => {
  /*
   * ⚠️ 这是本次改动的安全红线。
   *
   * "把不是数组的东西丢掉"很容易顺手写成"丢掉之后补一个 hold/skip"——
   * 那是**伪造一个模型从未做出的决定**，比空数组糟得多（审计块会说"模型决定不做"，
   * 而模型其实什么都没说）。所以本条的断言是：
   * ```
   *   形态不合格 → <decision>[]</decision>（不行动）
   *   ✗ 不允许出现任何 action（哪怕 hold/skip）
   * ```
   * 与既有的「裁决解析失败时返回空决策 + 说明原因，绝不编造动作」是同一条底线，
   * 只是触发条件换成了"抽到的东西不像决策"。
   */
  const judgeRaw = '推理：close[-1]=2.4831、close[-6]=2.5218，位移 1.5%。\n```json\n[-1]\n```';
  const text = renderDeskOutcome(outcome({ verdict: role('judge', judgeRaw) }));
  assert.ok(text.includes('<decision>\n[]\n</decision>'), '★ 只能是不行动');
  assert.ok(!/"action"/.test(text.slice(text.indexOf('<decision>'), text.indexOf('</decision>'))), '★ 决策块里绝不能有动作');
  assert.ok(!text.includes('"hold"') && !text.includes('"skip"'), '★ 更不能补一个 hold/skip');
});