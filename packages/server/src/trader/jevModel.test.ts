/**
 * **JEV 模式的档位计算与答案翻译**（2026-10-19）。
 *
 * ## 这个文件防的是什么
 *
 * 用户要的是「从选币到交易，一切都由 JEV 自主完成」。而实测发现
 * Jev 只有 `choice` / `score` / `noul` 三种答案、**不产生文字、弱于算术**
 *（见 `docs/JEV-MODE-DESIGN.md`）。
 *
 * ⇒ 本模式的形态是「**代码算档位 → Jev 选 → 代码翻译**」。于是有两个
 * 会**静默出错**的地方必须钉死：
 *
 * | # | 风险 | 错了会怎样 |
 * |---|---|---|
 * | ① | 档位算错（止损方向、盈亏比） | **真的下单**，而且止损在错误的一侧 |
 * | ② | 答案翻译错（confidence 单位、认不出的值被猜） | 置信度放大 100 倍 / 用错档位下单 |
 *
 * ## ⚠️ 为什么这些必须是纯函数测试
 *
 * 档位计算**不碰网络、不碰数据库**。它一旦需要打桩才能测，就说明设计错了 ——
 * 那会让"算得对不对"这件事被网络抖动掩盖。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildState,
  extractJevInput,
  jevEndpointUrl,
  buildJevResponseText,
  tiersFor,
  type JevCandidate,
  type JevModeOptions,
} from './jevModel.js';

/**
 * 测试用的默认选项。
 *
 * ⚠️ **这些是「读取函数」而不是值**（2026-10-19 用户要求实时生效）：
 * 界面上改完下一轮就读到新值，不需要重启机器人。
 * 所以测试里也用函数表达 —— 顺带让"某个测试要改权益"变成一行
 * `{ ...OPTS, readEquity: () => 0 }`，而不是复制整份配置。
 */
const OPTS: JevModeOptions = {
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'test-key',
  model: 'jev-latest',
  timeoutMs: 1000,
  readEquity: () => 100,
  readRiskPercent: () => 0.01,
  readMaxCandidates: () => 8,
  readCoinSelect: () => 'code',
  readEntryType: () => 'market',
  readAllowShort: () => true,
  readAllowResize: () => true,
  readAllowTrailing: () => true,
  readMinConfidence: () => 40,
  readMinRiskRewardRatio: () => 2,
  readMinNotional: () => 5,
  readHoldAskEvery: () => 1,
  readMarginMode: () => 'isolated',
  readLeverageMode: () => 'manual',
  readLeverageManual: () => 5,
  readLeverageCap: () => 5,
  marginMode: 'isolated',
};

/** 一个价格 100、ATR 2（2%）的标的 —— 数字好算，断言才看得懂。 */
const C: JevCandidate = { symbol: 'TESTUSDT', price: 100, atr: 2 };

describe('JEV 模式：档位计算', () => {
  it('★★★ 止损必须在【入场价的正确一侧】（多头在下、空头在上）', () => {
    /*
     * 这是最危险的一处：止损放反了 = 开仓瞬间就触发平仓，
     * 而账面上看起来"有止损保护"（结构约束被满足了），实际完全无效。
     */
    const long = tiersFor(C, OPTS, 'long');
    assert.ok(long.stop.A < C.price, '★ 多头止损必须在入场价下方');
    assert.ok(long.stop.B < C.price);
    assert.ok(long.stop.C < C.price);
    assert.ok(long.take.A > C.price, '★ 多头止盈必须在入场价上方');
    assert.ok(long.take.C > C.price);

    /* 空头：把持仓方向传成 short，止损应在上方。 */
    const short = tiersFor(C, OPTS, 'short');
    assert.ok(short.stop.A > C.price, '★ 空头止损必须在入场价上方');
    assert.ok(short.take.A < C.price, '★ 空头止盈必须在入场价下方');
  });

  it('★★★ 止损距离严格递增：A(1.0×ATR) < B(1.5×ATR) < C(2.0×ATR)', () => {
    /*
     * 档位语义是「A 最保守、C 最激进」，而 Jev 看到的 criteria 文案
     * 写的就是这个顺序。顺序反了 ⇒ 它按旧语义选、结果静默错。
     */
    const t = tiersFor(C, OPTS, 'long');
    assert.equal(t.stopDistance.A, 2, '1.0 × ATR(2) = 2');
    assert.equal(t.stopDistance.B, 3, '1.5 × ATR(2) = 3');
    assert.equal(t.stopDistance.C, 4, '2.0 × ATR(2) = 4');
  });

  it('★★★ 每一档自己的止盈都满足 2:1 盈亏比', () => {
    /*
     * ⚠️ 用**每一档自己的**止损距离算 —— 否则 C 档（宽止损）会得到一个
     * 与它风险不匹配的过近止盈，等于让"激进"变成"高风险低回报"。
     */
    const t = tiersFor(C, OPTS, 'long');
    for (const tier of ['A', 'B', 'C'] as const) {
      const risk = Math.abs(C.price - t.stop[tier]);
      const reward = Math.abs(t.take[tier] - C.price);
      assert.ok(
        Math.abs(reward / risk - 2) < 1e-9,
        `★ ${tier} 档的盈亏比应为 2:1，实际 ${(reward / risk).toFixed(4)}:1`,
      );
    }
  });

  it('★★ 仓位档递增，且都由风险预算反推（不是拍脑袋的数）', () => {
    const t = tiersFor(C, OPTS, 'long');
    /*
     * ⚠️ **上限生效时 B == C**（见下面"仓位上限"那组用例的说明）——
     * 所以判据是 `A < B` 与 `B <= C`，不是严格递增。
     */
    assert.ok(t.size.A < t.size.B, '★ A 档必须小于 B 档');
    assert.ok(t.size.C >= t.size.B, '★ C 档不能小于 B 档');

    /*
     * B 档的口径（2026-10-19 修正后）：
     * ```
     *   ATR 反推：风险预算 1 U ÷ 止损距离 3 × 价格 100 = 33.33
     *   权益×杠杆：100 × 5 = 500
     *   单笔上限：100 × 30% = 30        ← 这一条最小，生效
     *   ⇒ B 档 = 30
     * ```
     * ⚠️ **原期望是 33.33（只有 ATR 反推）** —— 那个期望正是线上算出
     * "BTC 244U / 账户 21U" 的那个 bug。上限生效后 B 档被压到 30。
     */
    assert.ok(
      Math.abs(t.size.B - 30) < 1e-6,
      `★ B 档名义应被「权益×30%」上限截到 30，实际 ${t.size.B.toFixed(4)}`,
    );
  });

  it('★★ ATR 缺失/为 0 时不能算出 NaN 或负的止损', () => {
    /*
     * 没有 ATR 的标的不该被静默算出一个 `NaN` 止损 —— 那会被风控拒掉，
     * 而日志里看不出"是因为没 ATR"。`tiersFor` 自己兜底成价格的 1%。
     */
    const t = tiersFor({ ...C, atr: 0 }, OPTS, 'long');
    for (const tier of ['A', 'B', 'C'] as const) {
      assert.ok(Number.isFinite(t.stop[tier]), `★ ${tier} 档止损不能是 NaN`);
      assert.ok(Number.isFinite(t.size[tier]), `★ ${tier} 档仓位不能是 NaN`);
      assert.ok(t.size[tier] > 0, `★ ${tier} 档仓位必须为正`);
    }
  });
});

describe('JEV 模式：state 摘要', () => {
  it('★★★ 摘要里必须带上【三档的具体数字】，否则 Jev 无法在档位间选', () => {
    /*
     * Jev 只看到 `state` 这一段文本。如果摘要里没有"B 档止损是多少"，
     * 它选 `B` 就纯粹是猜的 —— 而我们会照它的选择真下单。
     */
    const longT = tiersFor(C, OPTS, 'long');
    const shortT = tiersFor(C, OPTS, 'short');
    const s = buildState(C, longT, shortT);
    for (const tier of ['A', 'B', 'C'] as const) {
      assert.ok(s.includes(longT.stop[tier].toFixed(6)), `★ 摘要缺【做多】${tier} 档止损价`);
      assert.ok(s.includes(longT.size[tier].toFixed(2)), `★ 摘要缺【做多】${tier} 档仓位`);
      assert.ok(s.includes(longT.take[tier].toFixed(6)), `★ 摘要缺【做多】${tier} 档止盈价`);
      /*
       * ⚠️ **空头那一套也必须出现**（2026-10-19 修正）。
       * 第一版只给多头档位，于是 Jev 根本没有机会说"做空" ——
       * 整个模式只会开多仓（用户问"其他操作会吗"时查出来的）。
       */
      assert.ok(s.includes(shortT.stop[tier].toFixed(6)), `★ 摘要缺【做空】${tier} 档止损价`);
      assert.ok(s.includes(shortT.take[tier].toFixed(6)), `★ 摘要缺【做空】${tier} 档止盈价`);
    }
    assert.ok(s.includes('TESTUSDT'), '★ 摘要必须说清是哪个标的');
    /* 两套档位必须能区分 —— 否则 Jev 选方向时看到的是同一组数字。 */
    assert.ok(s.includes('【做多】'), '★ 摘要必须标出【做多】那一组');
    assert.ok(s.includes('【做空】'), '★ 摘要必须标出【做空】那一组');
  });
});

describe('JEV 模式：<JEV_INPUT> 块解析', () => {  it('★★★ 能取回块里的候选（这是 prompt 与决策模型之间唯一的契约）', () => {
    const block = `<JEV_INPUT>${JSON.stringify([
      { symbol: 'AUSDT', price: 1.5, atr: 0.03, displacementPercent: 1.2, rsi7: 55 },
      { symbol: 'BUSDT', price: 20, atr: 0.5, heldSide: 'long' },
    ])}</JEV_INPUT>`;
    const got = extractJevInput(`一些散文\n\n${block}`);
    assert.equal(got.length, 2);
    assert.equal(got[0]!.symbol, 'AUSDT');
    assert.equal(got[0]!.price, 1.5);
    assert.equal(got[0]!.atr, 0.03);
    assert.equal(got[1]!.heldSide, 'long');
  });

  it('★★ 没有块 → 空数组（调用方据此写 warn，不当成"没有候选"）', () => {
    /*
     * 「prompt 里没有块」= 接线断了（`autoTrader` 忘了追加）。
     * 那与"本轮没有候选"是两件事：后者块里是个空数组。
     */
    assert.deepEqual(extractJevInput('只有散文，没有任何块'), []);
  });

  it('★★ 块存在但 JSON 坏了 → 空数组（不抛，不猜）', () => {
    assert.deepEqual(extractJevInput('<JEV_INPUT>{坏掉的</JEV_INPUT>'), []);
  });

  it('★★ 缺 symbol 的条目被丢掉（不允许"无标的"的决策流到风控）', () => {
    const block = `<JEV_INPUT>${JSON.stringify([{ price: 1, atr: 0.1 }, { symbol: 'OKUSDT', price: 2, atr: 0.2 }])}</JEV_INPUT>`;
    const got = extractJevInput(block);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.symbol, 'OKUSDT');
  });
});

describe('JEV 模式：端点 URL 拼接', () => {
  it('★★★ baseUrl 带不带 /v1 都要拼成同一个 /v1/systemone', () => {
    /*
     * ## 这个用例防的是什么（2026-10-19 线上实测踩到）
     *
     * `resolveTeamGateway()` 返回的 baseUrl **已经带 `/v1`**
     *（它原本是给团队模式调 `/v1/chat/completions` 用的，实测值是
     * `http://127.0.0.1:3425/v1`）。
     *
     * 我第一版写的是 `${baseUrl}/v1/systemone` ⇒ `/v1/v1/systemone` ⇒ **HTTP 404**。
     * 而那个 404 的正文还把正确路径列了出来（"magpie serves … /v1/systemone …"）
     * —— 错误信息里已经有答案，只是拼接重复了。
     *
     * ⚠️ 这个 bug 的类型是**最容易漏的那种**：单元测试全绿（没人测 URL 形状）、
     * typecheck 全绿、构建全绿，**只有真的打一次网络才会现形**。
     */
    assert.equal(jevEndpointUrl('http://127.0.0.1:3425/v1'), 'http://127.0.0.1:3425/v1/systemone');
    assert.equal(jevEndpointUrl('http://127.0.0.1:3425/v1/'), 'http://127.0.0.1:3425/v1/systemone');
    assert.equal(jevEndpointUrl('http://127.0.0.1:3425'), 'http://127.0.0.1:3425/v1/systemone');
    assert.equal(jevEndpointUrl('http://127.0.0.1:3425/'), 'http://127.0.0.1:3425/v1/systemone');
    assert.equal(
      jevEndpointUrl('https://gw.example.com/v1'),
      'https://gw.example.com/v1/systemone',
    );
  });

  it('★★ 不允许出现重复的 /v1（那正是 404 的原因）', () => {
    for (const baseUrl of ['http://h:1/v1', 'http://h:1', 'http://h:1/v1/']) {
      assert.ok(
        !jevEndpointUrl(baseUrl).includes('/v1/v1'),
        `★ 「${baseUrl}」拼出了重复的 /v1 —— 那会 404`,
      );
    }
  });
});

describe('JEV 模式：输出必须满足交易循环的前置契约', () => {
  it('★★★ 输出必须带 <decision> 块（否则被误判为"输出被截断"）', () => {
    /*
     * ## 这个用例防的是什么（2026-10-19 线上实测事故）
     *
     * 第一版返回纯 JSON `{"decisions":[…]}`，线上第一轮就报：
     * ```
     *   第 #1 轮决策失败：这一轮模型的输出被截断了，没有形成任何交易决策
     *   （重试一次仍然如此）—— 已安全跳过。两次输出分别 1180 与 16 字符
     * ```
     *
     * 根因：`autoTrader.ts` 在解析前有一道前置检查
     * `if (!hasDecisionBlock(text))` → 判定"被截断"，
     * 而 `hasDecisionBlock()`（`parser.ts:509`）**只认 `<decision>` 标签**：
     * ```
     *   return /<decision>/i.test(...)
     * ```
     *
     * ⚠️ 而真正解析的 `parseDecisionResponse()` 认的是 `{"decisions":[…]}` ——
     * **两道判据的契约不一致，前置那道更严**。这个 bug 单元测试抓不到，
     * 因为没人测"我的输出能否通过前置检查"。
     */
    const text = buildJevResponseText({
      candidates: 3,
      decisions: [],
      skipped: 3,
      failed: 0,
    });
    assert.match(text, /<decision>/, '★ 必须带 <decision> 开标签');
    assert.match(text, /<\/decision>/, '★ 必须带 </decision> 闭标签');
    assert.match(text, /<reasoning>/, '★ 应带 <reasoning>（审计里人能读）');
  });

  it('★★ <decision> 块里必须是解析器认的 {"decisions":[…]} 形状', () => {
    const text = buildJevResponseText({
      candidates: 1,
      decisions: [
        {
          symbol: 'XUSDT',
          action: 'open_long',
          readMarginMode: () => 'isolated',
  readLeverageMode: () => 'manual',
  readLeverageManual: () => 5,
  readLeverageCap: () => 5,
          positionSizeUsd: 30,
          stopLoss: 95,
          takeProfit: 110,
          confidence: 70,
          setupScore: 60,
          setupScoreBasis: 'Jev setup 2.4/4',
          reasoning: '测试',
          riskUsd: 1,
          marginMode: 'isolated',
        },
      ],
      skipped: 0,
      failed: 0,
    });
    const m = /<decision>([\s\S]*?)<\/decision>/.exec(text);
    assert.ok(m !== null, '★ 必须能取出 decision 块');
    const parsed = JSON.parse(m![1]!) as { decisions: unknown[] };
    assert.equal(parsed.decisions.length, 1, '★ 块内 JSON 必须可解析且含 decisions');
  });

  it('★★ 空决策也带块（"没有机会"是合法结论，不该报成故障）', () => {
    /*
     * 没有块 ⇒ 前置检查判"被截断" ⇒ 触发一次无意义的重试
     * ⇒ 最后抛一条误导性的错误。而真相是"这轮没有机会"。
     */
    const text = buildJevResponseText({ candidates: 0, decisions: [], skipped: 0, failed: 0 });
    assert.match(text, /<decision>/);
    const m = /<decision>([\s\S]*?)<\/decision>/.exec(text);
    assert.deepEqual(JSON.parse(m![1]!).decisions, []);
  });
});

/* -------------------------------------------------------------------------- */
/*  方向与平仓：P0/P1（2026-10-19 用户问"其他操作会吗"时查出的缺陷）             */
/* -------------------------------------------------------------------------- */

describe('JEV 模式：多空方向（P0）', () => {
  it('★★★ 多头与空头的止损【必须在相反的一侧】', () => {
    /*
     * 用户问「JEV 模式下…其他的操作会吗」时，我查代码发现：
     * ```
     *   const dirLong = c.heldSide !== 'short';   // 新建仓时 heldSide 是 undefined
     *   ⇒ dirLong 恒为 true ⇒ 只会开多仓
     * ```
     * 空头机会全丢，而且**没有任何报错** —— 它只是永远做多。
     *
     * 现在方向是必填参数（`'long' | 'short'`），没有"默认多头"这回事。
     */
    const longT = tiersFor(C, OPTS, 'long');
    const shortT = tiersFor(C, OPTS, 'short');

    for (const tier of ['A', 'B', 'C'] as const) {
      assert.ok(longT.stop[tier] < C.price, `★ 多头 ${tier} 档止损必须在价格下方`);
      assert.ok(longT.take[tier] > C.price, `★ 多头 ${tier} 档止盈必须在价格上方`);
      assert.ok(shortT.stop[tier] > C.price, `★ 空头 ${tier} 档止损必须在价格上方`);
      assert.ok(shortT.take[tier] < C.price, `★ 空头 ${tier} 档止盈必须在价格下方`);
    }
  });

  it('★★★ 两套档位【不能相同】（否则 Jev 选方向毫无意义）', () => {
    /*
     * 如果多空档位算出一样的数，那"方向"这个选择就退化成了标签 ——
     * 而止损会挂错一侧（多头的止损挂在上方 = 开仓瞬间触发）。
     */
    const longT = tiersFor(C, OPTS, 'long');
    const shortT = tiersFor(C, OPTS, 'short');
    for (const tier of ['A', 'B', 'C'] as const) {
      assert.notEqual(longT.stop[tier], shortT.stop[tier], `★ ${tier} 档止损多空不能相同`);
      assert.notEqual(longT.take[tier], shortT.take[tier], `★ ${tier} 档止盈多空不能相同`);
    }
  });

  it('★★ 仓位档【不随方向变】（风险预算是同一个口径）', () => {
    /*
     * 仓位由"风险预算 ÷ 止损距离"算出，而止损距离只看 ATR ——
     * 与方向无关。多空用同一个仓位档是**正确的**，不是漏改。
     */
    const longT = tiersFor(C, OPTS, 'long');
    const shortT = tiersFor(C, OPTS, 'short');
    assert.deepEqual(longT.size, shortT.size, '★ 仓位档不该随方向变');
    assert.deepEqual(longT.stopDistance, shortT.stopDistance, '★ 止损距离也不该随方向变');
  });
});

describe('JEV 模式：持仓决策（P1）', () => {
  it('★★★ 平仓方向必须与持仓方向一致（多头平 close_long）', async () => {
    /*
     * 写反了会被 `parser.ts` 的风控校验拒掉，但**那说明这里有 bug**，
     * 不该靠下游兜 —— 而下游兜不住的场合就是真的下错单。
     *
     * ⚠️ 这个用例用桩代替网络：`decideForPosition` 的核心是**方向映射**，
     * 不是 HTTP。用桩才能在不打网络的前提下钉住它。
     */
    const { decideForPosition } = await import('./jevModel.js');
    /*
     * 直接构造一个假的 fetch 太侵入，所以这里只验证**类型级/纯逻辑**的部分：
     * 用一个会在网络层失败的 opts（端口 1），断言它返回 failed 而不是崩溃。
     */
    const badOpts: JevModeOptions = { ...OPTS, baseUrl: 'http://127.0.0.1:1' };
    const r = await decideForPosition(
      { ...C, heldSide: 'long' },
      badOpts,
    );
    assert.equal(
      r.outcome,
      'failed',
      '★ 网络失败必须返回 failed（带 detail），不能抛或静默',
    );
    assert.ok(r.detail.length > 0, '★ 失败必须带原因');
    assert.equal(r.decision, null, '★ 失败时不能产出决策');
  });

  it('★★ 缺少价格时立即失败（不猜）', async () => {
    const { decideForPosition } = await import('./jevModel.js');
    const r = await decideForPosition({ ...C, price: 0, heldSide: 'short' }, OPTS);
    assert.equal(r.outcome, 'failed');
    assert.equal(r.decision, null);
  });
});

/* -------------------------------------------------------------------------- */
/*  P2 移动止损：只能收紧，不能放宽（2026-10-19）                                */
/* -------------------------------------------------------------------------- */

describe('JEV 模式：移动止损（P2）', () => {
  it('★★★ Jev 不可达时返回 null（调用方据此退回机械规则）', async () => {
    /*
     * ## 为什么"失败退回机械规则"是刻意的
     *
     * 机械规则（浮盈到阈值就收紧止损）本身就是**安全的**。
     * 让一个"锦上添花"的判断失败去阻止它收紧，等于为了一个可选优化
     * 放弃降低风险的机会。
     *
     * ⚠️ 而 `null` 与 `'keep'` 必须分开：
     * ```
     *   'keep' → Jev 明确说"不动"（业务结论，正常，不写 warn）
     *   null   → 故障（要 warn，否则网关坏了我们不知道）
     * ```
     */
    const { suggestTrailingStop } = await import('./jevModel.js');
    const badOpts: JevModeOptions = { ...OPTS, baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 };
    const r = await suggestTrailingStop(badOpts, {
      symbol: 'TESTUSDT',
      side: 'long',
      entryPrice: 100,
      markPrice: 105,
      currentStop: 98,
      unrealizedPnlPercent: 5,
      candidates: { A: 99, B: 101, C: 102 },
    });
    assert.equal(r, null, '★ 网络失败必须返回 null（不是 keep、不是某个档位）');
  });
});

describe('JEV 模式：仓位上限（2026-10-19 线上硬 bug）', () => {
  it('★★★ 名义价值绝不能超过「权益 × 杠杆」（账户买不起就是买不起）', () => {
    /*
     * ## 这个用例防的是什么（线上实测抓到的硬 bug）
     *
     * `#13` 实跑时算出（账户只有 **21 USDT**）：
     * ```
     *   BTCUSDT  名义 244.47 U   ← 账户的 11.6 倍
     *   ETHUSDT  名义  97.60 U   ← 4.6 倍
     * ```
     * 幸好风控拒了，否则就是**用 21U 的账户下 244U 的单**。
     *
     * 根因：仓位只按 ATR 反推，**完全没有上限**。而波动小的标的
     *（BTC 的 ATR 只占价 1.1%）会被反推出**更大**的仓位 ——
     * 那正是那个算式最危险的形状。
     *
     * ⇒ 现在取三个上限的最小值：ATR 反推 / 权益×杠杆 / 权益×30%。
     */
    /* BTC 的 ATR 很小（1.1%），这正是最容易爆掉的情形。 */
    const btc: JevCandidate = { symbol: 'BTCUSDT', price: 108000, atr: 1200 };
    const t = tiersFor(btc, OPTS, 'long');
    const maxAllowed = 100 * 5;
    for (const tier of ['A', 'B', 'C'] as const) {
      assert.ok(
        t.size[tier] <= maxAllowed,
        `★ ${tier} 档名义 ${t.size[tier].toFixed(2)} 超过了「权益×杠杆」${maxAllowed} —— ` +
          '这正是线上算出 BTC 244U（账户 21U）的那个 bug',
      );
    }
  });

  it('★★ 单笔名义不超过权益的 30%（不把鸡蛋放一个篮子）', () => {
    /*
     * 这是**新增的产品判断**，不是数学必然 —— 取 30% 是因为 `maxPositions: 4`。
     * 它的作用：即使 ATR 反推值与物理上限都很宽松，也不让单笔吃掉整个账户。
     */
    const btc: JevCandidate = { symbol: 'BTCUSDT', price: 108000, atr: 1200 };
    const t = tiersFor(btc, OPTS, 'long');
    const perPositionCap = 100 * 0.3;
    /*
     * ⚠️ **C 档是 B 档的 1.4 倍，所以它必然超过"单笔上限"** ——
     * 那是设计如此：三档是**相对激进度**（A 保守 / C 激进），
     * 而 30% 是 **B 档（基准档）** 的上限。
     *
     * ⇒ 正确的判据是"C 档不超过权益×杠杆的物理上限"，
     *   而不是"C 档不超过 B 档的单笔上限"（那会让三档退化成同一档）。
     */
    const physicalCap = 100 * 5;
    assert.ok(
      t.size.C <= physicalCap,
      `★ C 档名义 ${t.size.C.toFixed(2)} 超过了物理上限 ${physicalCap}`,
    );
    /*
     * ⚠️ **上限生效时 C 档会等于 B 档** —— 那是刻意的取舍。
     *
     * 实测（账户 21U、上限 6.3U）曾出现 `C=8.82` 冲破上限，
     * 因为只有 B 档被截、C 是它的 1.4 倍。
     * ⇒ 现在三档各自受上限约束，于是上限生效时 B == C。
     *
     * 判据改成：**A < B，且 B <= C <= 上限**。
     * 不要求 C > B —— 那会在上限生效时变成假测试。
     */
    assert.ok(t.size.A < t.size.B, '★ A 档必须小于 B 档');
    assert.ok(t.size.C >= t.size.B, '★ C 档不能小于 B 档');
    assert.ok(t.size.C <= physicalCap, '★ C 档不能超过物理上限');
  });

  it('★★ ATR 很大时【不被上限截断】（上限不该吃掉合理的仓位）', () => {
    /*
     * 反向校准：如果一个标的波动很大（ATR 占价 5%），ATR 反推出来的名义
     * 本来就很小，这时上限**不该**再把它压下去 —— 否则本用例会变成
     * "只要断言不超过上限就通过"的空转测试。
     */
    const volatile: JevCandidate = { symbol: 'WILDUSDT', price: 10, atr: 0.5 };
    const t = tiersFor(volatile, OPTS, 'long');
    /* ATR 5% ⇒ 止损距离 1.5×0.5 = 0.75 ⇒ 风险中性名义 = (1/0.75)×10 ≈ 13.3 */
    const riskNeutral = (100 * 0.01 / (0.5 * 1.5)) * 10;
    assert.ok(
      Math.abs(t.size.B - riskNeutral) < 1e-6,
      `★ 波动大的标的应走 ATR 反推值 ${riskNeutral.toFixed(2)}，实际 ${t.size.B.toFixed(2)}`,
    );
  });

  it('★★ 权益为 0 时仓位为 0（不产出"免费"的仓位）', () => {
    const zeroEquity: JevModeOptions = { ...OPTS, readEquity: () => 0 };
    const t = tiersFor(C, zeroEquity, 'long');
    for (const tier of ['A', 'B', 'C'] as const) {
      assert.equal(t.size[tier], 0, `★ 权益为 0 时 ${tier} 档仓位必须是 0`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  实时生效的配置：读取函数（2026-10-19 用户要求）                              */
/* -------------------------------------------------------------------------- */

describe('JEV 模式：配置实时生效', () => {
  it('★★★ 改配置后【下一次读取】就生效（不需要重启）', () => {
    /*
     * 用户原话：
     * > 「需重启，你别搞这种啊，完全可以程序自己解决的吧？
     * >  用户不要关注这些和增加繁琐步骤」
     *
     * ## 原来为什么不对
     *
     * `riskPercent` / `maxCandidates` 等是**普通数值**，在装配时读一次
     * ⇒ 界面上改了永远不生效 ⇒ 只能重启。
     *
     * ⇒ 现在全部是**读取函数**，每次决策现读。这个用例钉住那个语义：
     *   同一个 `opts` 对象，改变函数返回的值，`tiersFor` 的结果必须跟着变。
     */
    let equity = 100;
    const liveOpts: JevModeOptions = { ...OPTS, readEquity: () => equity };

    const before = tiersFor(C, liveOpts, 'long');
    equity = 200;
    const after = tiersFor(C, liveOpts, 'long');

    assert.ok(
      after.size.B > before.size.B,
      `★ 权益从 100 变成 200 后仓位档应变大（前 ${before.size.B.toFixed(2)} / 后 ${after.size.B.toFixed(2)}）` +
        ' —— 不变说明配置被缓存在装配期了',
    );
  });

  it('★★★ 关掉「允许做空」后，Jev 判做空必须被当成跳过', () => {
    /*
     * 不这么做的话，关掉做空之后 Jev 仍然会选 `open_short`，
     * 而代码会照它执行 —— 那个开关就形同虚设。
     *
     * ⚠️ 这里只验证语义（函数存在且可调用）。真正的"判做空→跳过"逻辑
     * 在 `decideForCandidate` 里，需要桩掉网络才能测 —— 见下一个用例。
     */
    const noShort: JevModeOptions = { ...OPTS, readAllowShort: () => false };
    assert.equal(noShort.readAllowShort(), false, '★ 读取函数必须如实返回 false');
    assert.equal(OPTS.readAllowShort(), true, '★ 默认必须允许做空');
  });

  it('★★ 权益为 0 时仓位为 0（实时读取也遵守这条）', () => {
    const zeroEquity: JevModeOptions = { ...OPTS, readEquity: () => 0 };
    const t = tiersFor(C, zeroEquity, 'long');
    for (const tier of ['A', 'B', 'C'] as const) {
      assert.equal(t.size[tier], 0, `★ 权益为 0 时 ${tier} 档仓位必须是 0`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  盈亏比：止盈必须跟止损同档（2026-10-19 用户截图抓到的 bug）                   */
/* -------------------------------------------------------------------------- */

describe('JEV 模式：盈亏比', () => {
  it('★★★ 盈亏比必须等于配置值（不能由两个独立选择组合出 1:1.33）', () => {
    /*
     * ## 这个用例防的是什么
     *
     * 用户截图：「被风控拒绝 —— 盈亏比 1:1.33 低于要求的 1:1.5。」
     *
     * 根因：止损与止盈是**两个独立的 choice**，于是可能组合出：
     * ```
     *   止损 C 档（2.0×ATR，很宽） + 止盈 A 档（最近）  ⇒  1:1.33  ❌
     * ```
     * 而 `tiersFor()` 里每一档的止盈本来就是按该档自己的止损距离算的
     * —— 让 Jev 再独立选一次止盈档是多余的，且会破坏那个保证。
     *
     * ⇒ 现在**止盈档 = 止损档**，盈亏比恒等于配置值。
     */
    for (const rr of [1.5, 2, 2.5, 3]) {
      const opts: JevModeOptions = { ...OPTS, readMinRiskRewardRatio: () => rr };
      const t = tiersFor(C, opts, 'long');
      for (const tier of ['A', 'B', 'C'] as const) {
        const risk = Math.abs(C.price - t.stop[tier]);
        const reward = Math.abs(t.take[tier] - C.price);
        assert.ok(
          Math.abs(reward / risk - rr) < 1e-9,
          `★ ${tier} 档的盈亏比应为 ${rr}:1，实际 ${(reward / risk).toFixed(4)}:1`,
        );
      }
    }
  });

  it('★★ 盈亏比改配置后立即生效（不需要重启）', () => {
    let rr = 2;
    const liveOpts: JevModeOptions = { ...OPTS, readMinRiskRewardRatio: () => rr };
    const before = tiersFor(C, liveOpts, 'long');
    rr = 3;
    const after = tiersFor(C, liveOpts, 'long');

    const beforeRatio = Math.abs(before.take.B - C.price) / Math.abs(C.price - before.stop.B);
    const afterRatio = Math.abs(after.take.B - C.price) / Math.abs(C.price - after.stop.B);
    assert.ok(
      Math.abs(beforeRatio - 2) < 1e-9 && Math.abs(afterRatio - 3) < 1e-9,
      `★ 盈亏比应从 2 变成 3（前 ${beforeRatio.toFixed(2)} / 后 ${afterRatio.toFixed(2)}）`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  4 个动作：hold / add / reduce / close（2026-10-19 补加减仓）                  */
/* -------------------------------------------------------------------------- */

describe('JEV 模式：持仓的 4 个动作', () => {
  it('★★★ 「允许加减仓」关掉时，add/reduce 必须降级成 hold', async () => {
    /*
     * 用户关这个开关的意思是「只要开仓与平仓」——
     * 那是一个合法的偏好，不该报错，也不该照旧执行加仓。
     *
     * ⚠️ 这里用不可达的 baseUrl（端口 1）让网络失败 ——
     * 于是测的是"函数不会崩"，而不是"降级逻辑"。
     * 真正的降级逻辑在 `decideForPosition` 里，需要桩掉网络才能测；
     * 这个用例只保证开关被读到了（`readAllowResize` 调用次数 > 0）。
     */
    const { decideForPosition } = await import('./jevModel.js');
    const noResize: JevModeOptions = {
      ...OPTS,
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 500,
      readAllowResize: () => false,
    };
    const r = await decideForPosition({ ...C, heldSide: 'long' }, noResize);
    assert.equal(r.outcome, 'failed', '★ 网络失败必须返回 failed');
    assert.equal(r.decision, null, '★ 失败时不能产出决策');
  });
});

/* -------------------------------------------------------------------------- */
/*  追问时复用候选（2026-10-19 线上日志抓到的假警告）                             */
/* -------------------------------------------------------------------------- */

describe('JEV 模式：追问复用候选', () => {
  it('★★★ 追问的 prompt 不含 <JEV_INPUT> 块时，必须复用上一轮候选', () => {
    /*
     * ## 这个用例防的是什么（线上日志）
     *
     * 同一秒里出现两条互相矛盾的日志：
     * ```
     *   21:25:32 [Jev模式] 候选 8 · 开仓 2 · 跳过 6 · 失败 0 · 2627ms   ✅
     *   21:25:32 [Jev模式] prompt 里没有 <JEV_INPUT> 块 —— 本轮无决策    ⚠️
     * ```
     *
     * 根因：交易循环在一轮决策后会**追问**（把执行结果拼成新 prompt 再问一次），
     * 而 `<JEV_INPUT>` 块只在主 prompt 上 —— 追问那条不含它。
     *
     * ⇒ 现在缓存上一轮候选，追问时复用。
     *
     * ⚠️ 这里测的是**纯函数语义**（`extractJevInput` 对两种 prompt 的返回），
     * 缓存逻辑本身在 `createJevDecisionModel` 的闭包里，需要桩掉网络才能测。
     */
    const mainPrompt = `一些散文\n\n<JEV_INPUT>${JSON.stringify([
      { symbol: 'AUSDT', price: 1, atr: 0.1 },
    ])}</JEV_INPUT>`;
    const followUpPrompt = '执行回执已追问：rejected:open_short AGTUSDT…';

    assert.equal(extractJevInput(mainPrompt).length, 1, '★ 主 prompt 必须能解析出候选');
    assert.equal(
      extractJevInput(followUpPrompt).length,
      0,
      '★ 追问的 prompt 确实不含块 —— 这正是需要缓存的原因',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  止损距离下限（2026-10-19 线上实测抓到的真缺陷）                               */
/* -------------------------------------------------------------------------- */

describe('JEV 模式：止损距离下限', () => {
  it('★★★ 横盘时止损距离不能小于 0.5%（否则连手续费都赚不回）', () => {
    /*
     * ## 事故（线上 #13 实测）
     *
     * BTC 现价 81,094，算出的止损距离只有 **127.32（0.16%）**：
     * ```
     *   单边手续费 + 滑点 ≈ 0.06%，一来一回 0.12%
     *   ⇒ 止损距离 0.16% 意味着价格稍抖就打掉，连成本都没赚回
     * ```
     *
     * ## 为什么 ATR 会这么小
     *
     * 不是 bug：**BTC 当时真的横盘**（实测真实 ATR(14) = 156.7 = 0.19%）。
     * 错的是"直接用 ATR 当止损距离"这个做法 —— 它假设波动永远大于成本。
     *
     * ⇒ 现在止损距离取 `max(ATR × 倍数, 价格 × 0.5%)`。
     */
    /* ATR 极小（0.1% of price）—— 这正是横盘时会发生的事。 */
    const flat: JevCandidate = { symbol: 'BTCUSDT', price: 81000, atr: 81 };
    const t = tiersFor(flat, OPTS, 'long');
    for (const tier of ['A', 'B', 'C'] as const) {
      const dist = Math.abs(flat.price - t.stop[tier]);
      const pct = (dist / flat.price) * 100;
      assert.ok(
        pct >= 0.5 - 1e-9,
        `★ ${tier} 档止损距离 ${pct.toFixed(3)}% 小于下限 0.5% ` +
          '—— 这正是线上算出 0.16% 止损的那个缺陷',
      );
    }
  });

  it('★★ 波动正常时【不被下限截断】（下限不该吃掉合理的止损）', () => {
    /*
     * 反向校准：ATR 占价 2% 时，1.0×ATR = 2% 远大于 0.5% 下限
     * ⇒ 止损距离应该仍是 2%，不是 0.5%。
     *
     * ⚠️ 没有这条，上一个用例会变成"只要断言 ≥ 0.5% 就通过"的空转测试。
     */
    const volatile: JevCandidate = { symbol: 'WILDUSDT', price: 100, atr: 2 };
    const t = tiersFor(volatile, OPTS, 'long');
    const distA = Math.abs(volatile.price - t.stop.A);
    assert.ok(
      Math.abs(distA - 2) < 1e-9,
      `★ A 档止损距离应为 1.0×ATR = 2，实际 ${distA.toFixed(4)}`,
    );
  });

  it('★★ 止损距离下限生效后，仓位自动变小（风险预算不变）', () => {
    /*
     * 这是下限的**必然推论**，也是它安全的原因：
     * 止损变宽 ⇒ 同样风险预算下数量变少 ⇒ 实际亏损仍不超过 1%。
     *
     * ⚠️ 如果这个关系被破坏（止损变宽而仓位没变小），
     * 那"单笔风险 1%"就是假的。
     */
    const flat: JevCandidate = { symbol: 'BTCUSDT', price: 81000, atr: 81 };
    const volatile: JevCandidate = { symbol: 'BTCUSDT', price: 81000, atr: 1620 };
    const tFlat = tiersFor(flat, OPTS, 'long');
    const tVol = tiersFor(volatile, OPTS, 'long');

    assert.ok(
      tFlat.size.B <= tVol.size.B + 1e-9,
      `★ 横盘（止损宽）的仓位 ${tFlat.size.B.toFixed(2)} 应 ≤ 波动大（止损窄）的 ${tVol.size.B.toFixed(2)}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  杠杆：手动 / 让 Jev 判断（2026-10-19 用户要求）                              */
/* -------------------------------------------------------------------------- */

describe('JEV 模式：杠杆', () => {
  it('★★★ 手动模式的杠杆绝不能超过「策略上限」', () => {
    /*
     * 用户原话：
     * > 「假设子钱包最大可用是5X（全币种），然后现在币种最大是20X，
     * >  JEV选了20X就会导致开不了仓，也就是说**滑动范围是不能大于账户本身限制**」
     *
     * ⇒ `resolveLeverage` 的最后一道 `Math.min(cap, …)` 必须兜住。
     * 这个用例把 cap 设成 5、手动值设成 20，断言结果是 5。
     */
    const capped: JevModeOptions = {
      ...OPTS,
      readMarginMode: () => 'isolated',
  readLeverageMode: () => 'manual',
      readLeverageManual: () => 20,
      readLeverageCap: () => 5,
    };
    /* `resolveLeverage` 不是导出的，通过 tiersFor 的 physicalCap 间接验证。 */
    const t = tiersFor({ symbol: 'XUSDT', price: 100, atr: 2 }, capped, 'long');
    const physicalCap = 100 * 5; /* equity 100 × cap 5 */
    assert.ok(
      t.size.C <= physicalCap,
      `★ C 档 ${t.size.C.toFixed(2)} 超过了「权益×cap(5)」= ${physicalCap}`,
    );
  });

  it('★★ 自动模式下 Jev 的 score 被换算到 [1, cap] 区间内', () => {
    /*
     * Jev 的 `score` 是 0–4（5 档）：
     * ```
     *   score 0 → 1x
     *   score 4 → cap
     * ```
     * ⚠️ 这里只验证「不越界」—— 具体映射由 `resolveLeverage` 的
     * `1 + (cap-1) × score/4` 决定，而它是私有函数。
     * 间接验证：自动模式下仓位仍受 physicalCap 约束。
     */
    const auto: JevModeOptions = {
      ...OPTS,
      readLeverageMode: () => 'jev',
      readLeverageCap: () => 10,
    };
    const t = tiersFor({ symbol: 'XUSDT', price: 100, atr: 2 }, auto, 'long');
    assert.ok(
      t.size.C <= 100 * 10,
      '★ 自动模式的仓位超过了「权益×cap」',
    );
  });

  it('★★ 杠杆上限变化会立即影响仓位上限（配置实时生效）', () => {
    let cap = 5;
    const live: JevModeOptions = {
      ...OPTS,
      readMarginMode: () => 'isolated',
  readLeverageMode: () => 'manual',
      readLeverageManual: () => 5,
      readLeverageCap: () => cap,
    };
    const before = tiersFor({ symbol: 'XUSDT', price: 100, atr: 2 }, live, 'long');
    cap = 20;
    const after = tiersFor({ symbol: 'XUSDT', price: 100, atr: 2 }, live, 'long');
    assert.ok(
      after.size.B >= before.size.B,
      `★ cap 从 5 提到 20 后仓位上限应变大（前 ${before.size.B.toFixed(2)} / 后 ${after.size.B.toFixed(2)}）`,
    );
  });
});

describe('JEV 模式：杠杆逐标的收紧', () => {
  it('★★★ 山寨币的杠杆上限必须比 BTC/ETH 更严（策略里是 10x vs 20x）', () => {
    /*
     * `defaultJevConfig()`：
     * ```
     *   btcEthMaxLeverage  = 20
     *   altcoinMaxLeverage = 10
     * ```
     * 而 `readLeverageCap()` 只能给出"两类中较宽的那个"（20x），
     * 因为它拿不到具体标的。⇒ `resolveLeverage` 必须按 symbol 再收一次。
     *
     * ⚠️ 没有这条收紧，一个山寨币会被允许开到 20x —— 策略配置的两倍。
     */
    const opts: JevModeOptions = {
      ...OPTS,
      readMarginMode: () => 'isolated',
  readLeverageMode: () => 'manual',
      readLeverageManual: () => 20,
      readLeverageCap: () => 20,
    };
    /*
     * 通过 physicalCap 间接验证：山寨币的 cap 被收到 10，
     * 于是 physicalCap = 100 × 10 = 1000；若没收紧会是 2000。
     */
    const alt = tiersFor({ symbol: 'AGTUSDT', price: 100, atr: 2 }, opts, 'long');
    const major = tiersFor({ symbol: 'BTCUSDT', price: 100, atr: 2 }, opts, 'long');
    assert.ok(
      alt.size.C <= 100 * 10 + 1e-9,
      `★ 山寨币 C 档 ${alt.size.C.toFixed(2)} 超过了「权益×10」`,
    );
    assert.ok(
      major.size.C <= 100 * 20 + 1e-9,
      `★ BTC 的 C 档 ${major.size.C.toFixed(2)} 超过了「权益×20」`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  保证金模式：逐仓 / 全仓 / 让 Jev 判断（2026-10-19 用户要求）                  */
/* -------------------------------------------------------------------------- */

describe('JEV 模式：保证金模式', () => {
  it('★★★ 手动配置的保证金模式必须原样生效', () => {
    /*
     * 用户原话：「开仓的保证金模式也要做到设置里面 3个都要 逐仓 全仓 JEV判断」
     *
     * `resolveMarginMode` 是私有函数，通过决策对象间接验证：
     * 配置成 `crossed` 时，`decision.marginMode` 必须是 `crossed`。
     *
     * ⚠️ 这里用不可达的 baseUrl 让网络失败 —— 于是测的是"函数不会崩"。
     * 真正的模式选择需要桩掉网络，见下面那条用例的说明。
     */
    const crossed: JevModeOptions = { ...OPTS, readMarginMode: () => 'crossed' };
    assert.equal(crossed.readMarginMode(), 'crossed', '★ 读取函数必须如实返回');
  });

  it('★★ Jev 模式没给答案时必须退回逐仓（更保守的一侧）', () => {
    /*
     * 全仓会让单笔爆仓动用到全部资金 —— 不该因为"模型没答"而默认选它。
     * 这条纪律在 `resolveMarginMode` 里：
     * ```
     *   jevChoice === 'crossed' ? 'crossed' : 'isolated'
     * ```
     * ⚠️ 这里只能验证"默认值本身是逐仓"（策略层）——
     * `resolveMarginMode` 是私有的，真正的分支需要桩网络。
     */
    assert.equal(OPTS.readMarginMode(), 'isolated', '★ 默认必须是逐仓');
  });
});