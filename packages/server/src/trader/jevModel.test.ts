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
  tiersFor,
  type JevCandidate,
  type JevModeOptions,
} from './jevModel.js';

const OPTS: JevModeOptions = {
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'test-key',
  model: 'jev-latest',
  timeoutMs: 1000,
  equity: 100,
  riskPercent: 0.01,
  leverage: 5,
  maxCandidates: 8,
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
    const long = tiersFor(C, OPTS);
    assert.ok(long.stop.A < C.price, '★ 多头止损必须在入场价下方');
    assert.ok(long.stop.B < C.price);
    assert.ok(long.stop.C < C.price);
    assert.ok(long.take.A > C.price, '★ 多头止盈必须在入场价上方');
    assert.ok(long.take.C > C.price);

    /* 空头：把持仓方向传成 short，止损应在上方。 */
    const short = tiersFor({ ...C, heldSide: 'short' }, OPTS);
    assert.ok(short.stop.A > C.price, '★ 空头止损必须在入场价上方');
    assert.ok(short.take.A < C.price, '★ 空头止盈必须在入场价下方');
  });

  it('★★★ 止损距离严格递增：A(1.0×ATR) < B(1.5×ATR) < C(2.0×ATR)', () => {
    /*
     * 档位语义是「A 最保守、C 最激进」，而 Jev 看到的 criteria 文案
     * 写的就是这个顺序。顺序反了 ⇒ 它按旧语义选、结果静默错。
     */
    const t = tiersFor(C, OPTS);
    assert.equal(t.stopDistance.A, 2, '1.0 × ATR(2) = 2');
    assert.equal(t.stopDistance.B, 3, '1.5 × ATR(2) = 3');
    assert.equal(t.stopDistance.C, 4, '2.0 × ATR(2) = 4');
  });

  it('★★★ 每一档自己的止盈都满足 2:1 盈亏比', () => {
    /*
     * ⚠️ 用**每一档自己的**止损距离算 —— 否则 C 档（宽止损）会得到一个
     * 与它风险不匹配的过近止盈，等于让"激进"变成"高风险低回报"。
     */
    const t = tiersFor(C, OPTS);
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
    const t = tiersFor(C, OPTS);
    assert.ok(t.size.A < t.size.B, '★ A 档必须小于 B 档');
    assert.ok(t.size.B < t.size.C, '★ B 档必须小于 C 档');

    /*
     * B 档的口径：风险预算 = 100 × 1% = 1 USDT；止损距离 = 3；
     * 数量 = 1/3；名义 = (1/3) × 100 = 33.33。
     */
    assert.ok(
      Math.abs(t.size.B - 100 / 3) < 1e-6,
      `★ B 档名义应按「风险预算 ÷ 止损距离 × 价格」算出，实际 ${t.size.B.toFixed(4)}`,
    );
  });

  it('★★ ATR 缺失/为 0 时不能算出 NaN 或负的止损', () => {
    /*
     * 没有 ATR 的标的不该被静默算出一个 `NaN` 止损 —— 那会被风控拒掉，
     * 而日志里看不出"是因为没 ATR"。`tiersFor` 自己兜底成价格的 1%。
     */
    const t = tiersFor({ ...C, atr: 0 }, OPTS);
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
    const t = tiersFor(C, OPTS);
    const s = buildState(C, t, true);
    for (const tier of ['A', 'B', 'C'] as const) {
      assert.ok(s.includes(t.stop[tier].toFixed(6)), `★ 摘要缺 ${tier} 档止损价`);
      assert.ok(s.includes(t.size[tier].toFixed(2)), `★ 摘要缺 ${tier} 档仓位`);
      assert.ok(s.includes(t.take[tier].toFixed(6)), `★ 摘要缺 ${tier} 档止盈价`);
    }
    assert.ok(s.includes('TESTUSDT'), '★ 摘要必须说清是哪个标的');
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