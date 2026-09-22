/**
 * 权益曲线的算术。
 *
 * ## 为什么这一组里最重要的那条是"两处必须一致"
 *
 * "这条曲线算不算平"这个判据在**两个地方各实现了一遍**：
 *
 *   · `components/equityCurve.ts` 的 `hasEquityVariation`（交易页用它决定收起/展开）
 *   · `pages/overviewParts.tsx` 的 `equityShape`（总览页用它决定展开/塌陷）
 *
 * `equityCurve.ts` 的注释写着「**必须逐位一致**……三处阈值如果各写一套，同一条
 * 序列在不同页面上会得到不同结论」。**那句话原来只是一句注释。**
 *
 * 而这类不一致**不会有任何报错**：同一条权益序列，交易页说"值得画"、总览页说"平"，
 * 而两边看起来都在正常工作 —— 正是那种要靠人盯着两个页面比对才能发现的故障。
 * 所以这里把它变成**可执行**的断言。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { axisTicks, hasEquityVariation, rangeSpanMs, EQUITY_BUCKET_MS, CHART_INK } from './equityCurve';
import { leverageRatio } from './LeverageArc';
import { equityShape } from '../pages/overviewParts';
import tailwindConfig from '../../tailwind.config.js';

/* -------------------------------------------------------------------------- */
/*  X 轴刻度：位置必须对得上标签                                                */
/* -------------------------------------------------------------------------- */

/** 一个点够了 —— `axisTicks` 只看首尾的时间。 */
function pointAt(iso: string) {
  return { t: new Date(iso).getTime(), equity: 21, unrealizedPnl: 0, openPositions: 0 };
}

test('★ 多天范围：刻度钉在本地日界上，不按数值均匀摊', () => {
  /*
   * Why this test exists —— 用户的原话：「归属权益曲线上查看历史的时候，
   * 显示不正确」。
   *
   * 我先核了数据：服务器上那条快照 `2026-09-22T01:33:18.427Z` 的权益是
   * `22.12549787`，换算到用户时区正是 tooltip 里的 `09:33:18 / 22.13` ——
   * **数值没有错**。错的是**刻度的位置**：图表库默认把刻度按数值均匀摊开，
   * 再把每个刻度格式化成日期，于是 `09-20 21:12 / 09-21 12:33 / 09-22 03:55`
   * 变成 `09-20 / 09-21 / 09-22` —— **每一个都不在那一天的开始**，
   * 于是按标签定位历史会系统性偏一天。
   *
   * 这个用例钉的就是那件事：这一串刻度里，只要有一个不是本地 00:00，
   * 时间轴就又在骗人。
   */
  const ticks = axisTicks(
    [pointAt('2026-09-20T21:12:15+08:00'), pointAt('2026-09-23T03:26:10+08:00')],
    'ALL',
  );

  assert.ok(ticks.length >= 2, `跨度两天多应当至少有两天日界，实际 ${ticks.length}`);
  for (const t of ticks) {
    const d = new Date(t);
    assert.equal(d.getHours(), 0, `刻度必须落在本地日界，实际是 ${d.toLocaleString('en-GB')}`);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
  }
  // 且必须落在数据跨度**之内** —— 画到曲线外面去会凭空多出一段时间。
  const from = new Date('2026-09-20T21:12:15+08:00').getTime();
  const to = new Date('2026-09-23T03:26:10+08:00').getTime();
  for (const t of ticks) assert.ok(t > from && t <= to, `刻度 ${new Date(t).toISOString()} 跑到跨度外了`);
});

test('一天半以内：刻度落在整点（时钟轴）', () => {
  const ticks = axisTicks(
    [pointAt('2026-09-22T00:10:00+08:00'), pointAt('2026-09-22T18:40:00+08:00')],
    '1D',
  );

  assert.ok(ticks.length > 0, '一天的范围里应当有整点刻度');
  for (const t of ticks) {
    const d = new Date(t);
    assert.equal(d.getMinutes(), 0, `整点刻度的分钟必须是 0，实际 ${d.getMinutes()}`);
    assert.equal(d.getSeconds(), 0);
  }
});

test('跨度不足一个整点时返回空数组 —— 交给图表库的默认行为', () => {
  // 返回一个非空但错误的刻度比返回空更糟：调用方会用它覆盖掉默认轴。
  const ticks = axisTicks(
    [pointAt('2026-09-22T00:10:00+08:00'), pointAt('2026-09-22T00:40:00+08:00')],
    '1D',
  );
  assert.deepEqual(ticks, []);
});

/* -------------------------------------------------------------------------- */
/*  杠杆表盘的比例                                                              */
/* -------------------------------------------------------------------------- */

test('★ 杠杆表盘的比例：上限不可用时画空槽，而不是画满', () => {
  /*
   * 这条用例存在的理由：真实页面上那台机器人**没有持仓**，有效杠杆恒为 0 ——
   * 「填充段」那条路径在浏览器里根本走不到，而比例算错恰恰是这种图形最常见的
   * 故障（上限为 0 时除出 NaN，弧会画到半圆之外、或者整条消失）。
   *
   * 而 `max` 不可用时**必须返回 0 而不是 1**：画满会被读成"敞口拉满"，
   * 那是最危险的一种误读。
   */
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  assert.ok(close(leverageRatio(0.5, 3), 1 / 6), '0.5x / 上限 3x = 六分之一');
  assert.equal(leverageRatio(3, 3), 1, '刚好到上限 = 满格');
  assert.equal(leverageRatio(5, 3), 1, '超出上限要夹到 1，不能画出半圆之外');
  assert.equal(leverageRatio(0, 3), 0, '零杠杆 = 空槽');

  assert.equal(leverageRatio(1, 0), 0, '上限 0 = 不可用 → 空槽（不能是满格）');
  assert.equal(leverageRatio(1, -1), 0, '负上限 = 不可用 → 空槽');
  assert.equal(leverageRatio(Number.NaN, 3), 0, 'NaN 杠杆 → 空槽');
  assert.equal(leverageRatio(1, Number.NaN), 0, 'NaN 上限 → 空槽');
  assert.equal(leverageRatio(Number.POSITIVE_INFINITY, 3), 0, '无穷杠杆 → 空槽（不是满格）');
});

/* -------------------------------------------------------------------------- */
/*  CHART_INK 与 tailwind 的 token 必须逐位一致                                 */
/* -------------------------------------------------------------------------- */

test('★ CHART_INK 里的每个十六进制值都必须等于 tailwind 里对应的 token', () => {
  /*
   * `CHART_INK` 的注释写着它们 *"are kept **identical to the tokens** in
   * tailwind.config.js"* —— 而**这句话此前没有任何东西在检查**。
   *
   * 它为什么值得钉住：SVG 的 `stroke` / `fill` 吃不了 Tailwind 类，所以曲线、
   * K 线、杠杆仪表、比例条的底色全是从这里取的字面量。改了 `tailwind.config.js`
   * 却漏了这个文件，界面会变成**两套配色拼在一起** —— 面板换了、图表还是旧的，
   * 而**编译、类型检查、构建全都不会报错**。
   */
  type Colors = {
    up: string;
    down: string;
    warn: string;
    accent: string;
    base: Record<string, string>;
    ink: Record<string, string>;
  };
  const colors = (tailwindConfig as { theme: { extend: { colors: Colors } } }).theme.extend.colors;

  /*
   * 右边写的是**路径**而不是值 —— 这条用例要回答的问题是"两处有没有一起改"，
   * 把值抄进来只会让它变成"值有没有变"（那是另一件事，而且会在改配色时变成噪音）。
   */
  const pairs: Array<[keyof typeof CHART_INK, string, string]> = [
    ['up', colors.up, 'up'],
    ['down', colors.down, 'down'],
    ['warn', colors.warn, 'warn'],
    ['accent', colors.accent, 'accent'],
    ['grid', colors.base['750']!, 'base-750'],
    ['axis', colors.ink.lo!, 'ink-lo'],
    ['rule', colors.base['600']!, 'base-600'],
    ['track', colors.base['700']!, 'base-700'],
    ['surface', colors.base['900']!, 'base-900'],
    ['inkHi', colors.ink.hi!, 'ink-hi'],
  ];

  for (const [chartKey, expected, tokenPath] of pairs) {
    assert.equal(
      CHART_INK[chartKey],
      expected,
      `CHART_INK.${chartKey} 是 ${CHART_INK[chartKey]}，而 tailwind 的 ${tokenPath} 是 ${expected}。` +
        '—— 两处必须一起改；只改一处会让图表与面板变成两套配色，且不会有任何报错。',
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  两处判据必须给出同一个答案                                                  */
/* -------------------------------------------------------------------------- */

test('★ 交易页与总览页对"这条曲线算不算平"必须给出同一个答案', () => {
  /*
   * 覆盖的是**阈值附近**：绝对下限 0.005、相对下限 `|峰值| × 0.0002`、
   * 以及"至少 3 个点"这三条边界的两侧。
   */
  const cases: Array<[string, number[]]> = [
    ['完全平', [10, 10, 10]],
    ['浮点噪声级', [10, 10.000001, 10]],
    ['刚好在绝对阈值下方', [10, 10.004, 10]],
    ['刚好在绝对阈值上方', [10, 10.006, 10]],
    ['恰好等于绝对阈值', [10, 10.005, 10]],
    ['大账户上的微小抖动（相对阈值生效）', [1000, 1000.1, 1000.2]],
    /*
     * ⚠️ **这几条是必须的，而第一版漏了它们。**
     *
     * `|峰值| × 0.0002` 在 1000 的账户上是 **0.2**。上面那条用例的 spread 恰好
     * 也是 0.2 —— 对 0.0002 与 0.0003 **都不成立**，所以两处"仍然一致"：
     * 我把一处阈值改掉去验证这条用例时，**它没有抓住**。
     *
     * 真正能区分两个系数的是 `0.2 < spread <= 0.3` 这一段。**没有落在分歧区间里的
     * 用例，等于没有在测"两处一致"。**
     */
    ['相对阈值附近（分歧区间下沿）', [1000, 1000.21, 1000]],
    ['相对阈值附近（分歧区间中部）', [1000, 1000.25, 1000]],
    ['相对阈值附近（分歧区间上沿）', [1000, 1000.29, 1000]],
    ['大账户上的真实波动', [1000, 1001, 1002]],
    ['全是 0', [0, 0, 0]],
    ['跨零', [-5, 5, 0]],
    ['只有 2 个点', [10, 20]],
    ['只有 1 个点', [10]],
    ['空序列', []],
    ['含非有限值', [10, Number.NaN, 10, Number.POSITIVE_INFINITY, 10]],
  ];

  for (const [label, values] of cases) {
    const tradePage = hasEquityVariation(values);
    const overviewPage = equityShape(values.map((equity, index) => ({ t: index, equity }))).hasShape;
    assert.equal(
      tradePage,
      overviewPage,
      `「${label}」这条序列在两个页面上得到了不同结论：` +
        `交易页 ${tradePage}、总览页 ${overviewPage}（values=${JSON.stringify(values)}）。` +
        '—— 两处的阈值必须逐位一致，改一处就要改另一处。',
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  判据自身的边界                                                              */
/* -------------------------------------------------------------------------- */

test('点数不足时不画曲线 —— 两个点连不成形状，只能连成线段', () => {
  assert.equal(hasEquityVariation([]), false);
  assert.equal(hasEquityVariation([10]), false);
  assert.equal(hasEquityVariation([10, 20]), false);
  assert.equal(hasEquityVariation([10, 20, 30]), true, '三个点且有差距就该画');
});

test('非有限值被剔除，而不是让整条序列失去形状', () => {
  /*
   * `NaN` 参与 `Math.min` / `Math.max` 会**污染整个结果**（`Math.min(1, NaN)` 是 NaN），
   * 于是"含一个坏点"会变成"整条曲线是平的"。剔除之后剩下的点仍然说话。
   *
   * ⚠️ **"至少 3 个点"这条规则在剔除之后才应用**（实现里的顺序是
   * `filter` → `length < minPoints` → 算极差）。所以剔掉坏点后只剩两个的话，
   * 结论是"点太少"，不是"平" —— 两者在界面上是同一件事（都不画），
   * 但把期望值写对才能让这条用例真的在测剔除行为。
   */
  assert.equal(hasEquityVariation([10, Number.NaN, 30]), false, '剔掉 NaN 只剩 2 个点 → 点数不足');
  assert.equal(hasEquityVariation([10, Number.NaN, 30, 25]), true, '剔掉 NaN 还有 3 个点且有差距');
  assert.equal(hasEquityVariation([Number.NaN, Number.NaN, Number.NaN]), false, '全是坏点 = 没有形状');
  assert.equal(hasEquityVariation([10, 10, Number.NaN, 10]), false, '剔掉坏点后有 3 个点，但完全平');
});

test('绝对下限兜住"小账户上任何噪声都算大波动"', () => {
  /*
   * 一个 0.00 附近的账户，几厘的浮点噪声在相对意义上就是"巨大波动" ——
   * 没有绝对下限的话，它会撑起一整张只有噪声的图。
   */
  assert.equal(hasEquityVariation([0.001, 0.004, 0.002]), false, '差距 0.003 < 0.005');
  assert.equal(hasEquityVariation([0.001, 0.02, 0.002]), true, '差距 0.019 > 0.005');
});

/* -------------------------------------------------------------------------- */
/*  时间窗口                                                                    */
/* -------------------------------------------------------------------------- */

test('区间跨度：已知区间给具体值，未知的（含 ALL）是不设限', () => {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  assert.equal(rangeSpanMs('1D'), DAY);
  assert.equal(rangeSpanMs('7D'), 7 * DAY);
  assert.equal(rangeSpanMs('1M'), 30 * DAY);
  assert.equal(rangeSpanMs('3M'), 90 * DAY);
  /*
   * `ALL` 与**任何未知值**都必须落到"不设限" —— 后者是刻意的：
   * 一个拼错的区间 id 应当显示**全部**数据，而不是静默显示一个空窗口。
   */
  assert.equal(rangeSpanMs('ALL'), Number.POSITIVE_INFINITY);
  assert.equal(rangeSpanMs('nonsense'), Number.POSITIVE_INFINITY);
});

test('采样桶是 1 分钟 —— 它决定 1D 窗口里能有多少个点', () => {
  /*
   * `MAX_EQUITY_POINTS` 的取值理由就写在这个关系上（1D = 1440 点）。
   * 改动桶宽会让那条推理失效，所以把它钉住。
   */
  assert.equal(EQUITY_BUCKET_MS, 60_000);
  assert.equal(rangeSpanMs('1D') / EQUITY_BUCKET_MS, 1440);
});
