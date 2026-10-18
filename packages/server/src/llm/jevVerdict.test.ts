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
