/**
 * **Jev 实验判据**的测试（2026-10-18）。
 *
 * ## 为什么这个计算器必须被钉死
 *
 * 它决定"保留还是移除一个已经接进实盘的功能"。算错了会：
 * ```
 *   把负向判成正向 → 一个在丢机会的功能被永久留下
 *   把正向判成负向 → 一个真有用的功能被误删
 * ```
 *
 * ⇒ 每条边界都要有用例，尤其是"样本不足时说不足"和"两组都平就说没信息"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeVerdict, type SymbolOutcome } from './jevVerdict.js';

const out = (symbol: string, change: number): SymbolOutcome => ({
  symbol,
  change24hPercent: change,
  atrPercent: null,
});

const mkMap = (rows: SymbolOutcome[]): Map<string, SymbolOutcome> =>
  new Map(rows.map((r) => [r.symbol, r]));

test('★★★ 保留组波动明显更大 → positive', () => {
  const v = computeVerdict({
    keptSymbols: ['A', 'B', 'C'],
    dropped: [
      { symbol: 'D', score: 0.3 },
      { symbol: 'E', score: 0.2 },
      { symbol: 'F', score: 0.1 },
    ],
    outcomes: mkMap([
      out('A', -3.0), out('B', 2.5), out('C', -2.0), /* 平均 2.5 */
      out('D', 0.2), out('E', -0.3), out('F', 0.1), /* 平均 0.2 */
    ]),
  });
  assert.equal(v.outcome, 'positive', `★ 实际：${v.outcome} / ${v.reason}`);
  assert.equal(v.keptCount, 3);
});

test('★★★ 筛除组波动明显更大 → negative（这是"该移除"的信号）', () => {
  const v = computeVerdict({
    keptSymbols: ['A', 'B', 'C'],
    dropped: [
      { symbol: 'D', score: 0.3 },
      { symbol: 'E', score: 0.2 },
      { symbol: 'F', score: 0.1 },
    ],
    outcomes: mkMap([
      /* 保留的都是死水（0.1%），筛掉的却在动（3%）—— Jev 把机会丢了。 */
      out('A', 0.1), out('B', -0.2), out('C', 0.1),
      out('D', 3.0), out('E', -3.2), out('F', 2.8),
    ]),
  });
  assert.equal(v.outcome, 'negative', `★ 实际：${v.outcome} / ${v.reason}`);
  assert.ok(v.reason.includes('建议移除'), '负向要给明确建议');
});

test('★★★ 样本不足 → insufficient（不许拿 1-2 个标的下结论）', () => {
  const v = computeVerdict({
    keptSymbols: ['A', 'B'],
    dropped: [{ symbol: 'C', score: 0.2 }],
    outcomes: mkMap([out('A', 5), out('B', 5), out('C', 0.1)]),
  });
  assert.equal(v.outcome, 'insufficient', '★ 两组各需至少 3 个');
  assert.ok(v.reason.includes('继续观察'));
});

test('★★ 两组都平稳 → neutral（这段行情本身没信息）', () => {
  const v = computeVerdict({
    keptSymbols: ['A', 'B', 'C'],
    dropped: [
      { symbol: 'D', score: 0.3 },
      { symbol: 'E', score: 0.2 },
      { symbol: 'F', score: 0.1 },
    ],
    outcomes: mkMap([
      out('A', 0.01), out('B', -0.02), out('C', 0.01),
      out('D', 0.02), out('E', 0.01), out('F', -0.01),
    ]),
  });
  assert.equal(v.outcome, 'neutral', '★ 都几乎不动时，比值不可靠');
  assert.ok(v.reason.includes('没有可比较的信息'), '要说清为什么不下结论');
});

test('★★ 两组接近（未达 1.5 倍）→ neutral（Jev 没提供区分信息）', () => {
  const v = computeVerdict({
    keptSymbols: ['A', 'B', 'C'],
    dropped: [
      { symbol: 'D', score: 0.3 },
      { symbol: 'E', score: 0.2 },
      { symbol: 'F', score: 0.1 },
    ],
    outcomes: mkMap([
      out('A', 1.2), out('B', -1.1), out('C', 1.0), /* 平均 1.1 */
      out('D', 1.0), out('E', -1.0), out('F', 1.1), /* 平均 1.03 */
    ]),
  });
  assert.equal(v.outcome, 'neutral', `★ 实际：${v.outcome}`);
  assert.ok(v.reason.includes('没有提供有效区分信息'));
});

test('★★ 方向不影响判据（用 |涨跌幅|，因为团队双向都能做）', () => {
  /*
   * 两个场景：保留组全涨 vs 保留组全跌 —— 只要幅度一样，结论必须一样。
   * 团队能做空，所以"跌 3%"与"涨 3%"对"是否有机会"是同价的。
   */
  const build = (sign: number) =>
    computeVerdict({
      keptSymbols: ['A', 'B', 'C'],
      dropped: [
        { symbol: 'D', score: 0.3 },
        { symbol: 'E', score: 0.2 },
        { symbol: 'F', score: 0.1 },
      ],
      outcomes: mkMap([
        out('A', sign * 3), out('B', sign * 2.5), out('C', sign * 2),
        out('D', -sign * 0.2), out('E', sign * 0.3), out('F', -sign * 0.1),
      ]),
    });
  assert.equal(build(1).outcome, 'positive');
  assert.equal(build(-1).outcome, 'positive', '★ 全跌但幅度同样大 ⇒ 同样是"有机会"');
});

test('★★ 缺市场数据的标的被跳过，不算进平均（不编造 0%）', () => {
  const v = computeVerdict({
    keptSymbols: ['A', 'B', 'C', 'NO_DATA'],
    dropped: [
      { symbol: 'D', score: 0.3 },
      { symbol: 'E', score: 0.2 },
      { symbol: 'F', score: 0.1 },
      { symbol: 'ALSO_NO_DATA', score: 0.05 },
    ],
    outcomes: mkMap([
      out('A', 3), out('B', 3), out('C', 3),
      out('D', 0.2), out('E', 0.2), out('F', 0.2),
    ]),
  });
  assert.equal(v.keptCount, 3, '★ 没数据的那个不该被当成 0% 算进平均');
  assert.equal(v.droppedCount, 3);
  assert.equal(v.outcome, 'positive');
});

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  ★★★ 必须用中位数，不能用平均值（2026-10-18 线上实测打脸）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ## 真实数据
 *
 * ```
 *   保留组：Q +92.66%  BR +24.02%  GTC +21.05%  SAND +8.24%  ZEC -1.22%  BTC +0.16%
 *   筛除组：AGT +41.75%  AVA +34.59%  EPIC +21.64%  BTW +17.97%  ICNT -19.09% …
 * ```
 *
 * 三个算法给出三个不同结论：
 * ```
 *   平均值（含极值）   ：24.56% vs 12.65% ⇒ 1.94 倍 ⇒ positive
 *   剔除 Q 这个极值    ：10.94% vs 12.65% ⇒ 0.86 倍 ⇒ NEGATIVE
 *   中位数             ： 8.24% vs  7.81% ⇒ 1.06 倍 ⇒ neutral   ← 真相
 * ```
 *
 * **一个人的翻倍行情就能把"该移除"变成"该保留"。** 加密市场里这很常见。
 *
 * ⇒ 这条测试钉住：**同样的数据，用中位数算必须得出 neutral，不能是 positive**。
 */
test('★★★ 单点极值不能改变结论（平均值会给错答案，中位数不会）', () => {
  const v = computeVerdict({
    keptSymbols: ['QUSDT', 'BRUSDT', 'GTCUSDT', 'SANDUSDT', 'ZECUSDT', 'BTCUSDT'],
    dropped: [
      { symbol: 'AGTUSDT', score: 0.34 },
      { symbol: 'AVAUSDT', score: 0.51 },
      { symbol: 'EPICUSDT', score: 0.52 },
      { symbol: 'BTWUSDT', score: 0.46 },
      { symbol: 'ICNTUSDT', score: 0.43 },
      { symbol: 'TIAUSDT', score: 0.38 },
    ],
    outcomes: mkMap([
      /* 保留组：一个极端值 +92.66%，其余中等 */
      out('QUSDT', 92.66), out('BRUSDT', 24.02), out('GTCUSDT', 21.05),
      out('SANDUSDT', 8.24), out('ZECUSDT', -1.22), out('BTCUSDT', 0.16),
      /* 筛除组：好几个大波动 */
      out('AGTUSDT', 41.75), out('AVAUSDT', 34.59), out('EPICUSDT', 21.64),
      out('BTWUSDT', 17.97), out('ICNTUSDT', -19.09), out('TIAUSDT', -7.81),
    ]),
  });
  /*
   * 中位数：保留组 = (8.24+21.05)/2 = 14.645；筛除组 = (21.64+17.97)/2 = 19.805
   * 比值 ≈ 0.74 —— 这其实是"筛除组略强"，落在 neutral 区（0.67~1.5）。
   * **关键是它绝不能是 positive。**
   */
  assert.notEqual(
    v.outcome,
    'positive',
    '★ 一个 +92.66% 的极端值不能把结论拉成 positive —— 那正是平均值犯的错',
  );
  assert.ok(
    v.keptAvgAbsChange !== null && v.keptAvgAbsChange < 24.56,
    `★ 保留组的值应该是中位数（≈14.6），不是平均值（24.56）；实际 ${v.keptAvgAbsChange}`,
  );
});