/**
 * 候选评分的规则测试。
 *
 * ## 为什么这些用例存在
 *
 * 评分是"在花 token 之前先筛一遍"的那道闸门。它错了有两个方向，**两个都会亏钱**：
 *
 * - **太宽**：什么行情都放行 → 白花 token（实测单次 5.8 万），而且模型要在噪声里做判断
 * - **太严**：好机会被拦掉 → 机器人长时间不交易，而**"不交易"也是一种亏损**（错过机会）
 *
 * 所以每个分量**两侧的边界**都要钉住。
 *
 * ⚠️ **夹具是自己构造的 K 线，不是真实行情。** 用真实 K 线做断言会变成
 * "市场数据依赖"的假测试 —— 本会话已经踩过一次（`npm run sim` 的止盈校验
 * 回放真实 K 线，时而通过时而失败）。这里断言的是**规则**，不是市场的脸色。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Kline } from '@aq/shared';

import { SCORE_WEIGHTS, scoreSymbol } from './scoring.js';

/**
 * 造一根 K 线。
 *
 * `volume` 默认给 100 —— 这样"放量"只需要某根给更大的值，
 * 不必在每个用例里都把量写一遍。
 */
function bar(close: number, opts: { high?: number; low?: number; open?: number; volume?: number } = {}): Kline {
  return {
    openTime: 0,
    closeTime: 0,
    open: opts.open ?? close,
    high: opts.high ?? close,
    low: opts.low ?? close,
    close,
    volume: opts.volume ?? 100,
  } as Kline;
}

/** 一段缓缓上行的 K 线（趋势分应当为正）。 */
function uptrend(n: number, step = 0.001): Kline[] {
  return Array.from({ length: n }, (_, i) => {
    const px = 100 * (1 + i * step);
    return bar(px, { open: px / (1 + step), high: px * 1.0005, low: px * 0.9995 });
  });
}

/** 一段缓缓下行的 K 线（趋势分应当为负）。 */
function downtrend(n: number, step = 0.001): Kline[] {
  return Array.from({ length: n }, (_, i) => {
    const px = 100 * (1 - i * step);
    return bar(px, { open: px / (1 - step), high: px * 1.0005, low: px * 0.9995 });
  });
}

/** 一段横盘（趋势分接近 0、整理分高）。 */
function flat(n: number, px = 100): Kline[] {
  return Array.from({ length: n }, () => bar(px, { open: px, high: px * 1.0002, low: px * 0.9998 }));
}

/* -------------------------------------------------------------------------- */
/*  整体                                                                       */
/* -------------------------------------------------------------------------- */

test('分数永远钳在 0–100 —— 越界会让它无法与门槛比较', () => {
  const cases: Array<[Kline[], Kline[]]> = [
    [uptrend(60, 0.02), uptrend(60, 0.02)], // 极端上行
    [downtrend(60, 0.02), downtrend(60, 0.02)], // 极端下行
    [[], []], // 空输入
    [flat(60), flat(60)],
  ];
  for (const [k15, k4] of cases) {
    const s = scoreSymbol(k15, k4);
    assert.ok(s.total >= 0 && s.total <= 100, `分数越界：${s.total}`);
    assert.ok(Number.isFinite(s.total), '分数必须是有限数');
  }
});

test('空输入不抛异常，给 0 分 —— 数据不足时不该猜', () => {
  /*
   * 数据不足和"行情不好"是两件事。**给 0 分会让调用方把它当"不值得看"从而跳过** ——
   * 这正是想要的行为（宁可少看，也不要基于残缺数据下判断）。
   */
  assert.equal(scoreSymbol([], []).total, 0);
  assert.equal(scoreSymbol([bar(100)], [bar(100)]).total, 0);
});

/* -------------------------------------------------------------------------- */
/*  趋势分量：两侧都要钉                                                       */
/* -------------------------------------------------------------------------- */

test('上行趋势给正分，下行趋势给负分 —— 下行是有价值的信息，不能压成 0', () => {
  /*
   * 如果下行也返回 0，它就与"没有趋势"混为一谈，而两者对交易的含义完全不同：
   * 横盘是"等",下行是"考虑做空/回避"。
   */
  const up = scoreSymbol(flat(40), uptrend(60)).parts.trend;
  const down = scoreSymbol(flat(40), downtrend(60)).parts.trend;
  assert.ok(up > 0, `上行趋势分应为正，实际 ${up}`);
  assert.ok(down < 0, `下行趋势分应为负，实际 ${down}`);
  assert.ok(Math.abs(up) <= 1 && Math.abs(down) <= 1, '趋势分应在 −1..1');
});

test('横盘的趋势分接近 0', () => {
  const t = scoreSymbol(flat(40), flat(60)).parts.trend;
  assert.ok(Math.abs(t) < 0.2, `横盘不应有强趋势分，实际 ${t}`);
});

test('K 线太少时趋势分给 0，而不是从一个不可靠的斜率外推', () => {
  assert.equal(scoreSymbol(flat(40), uptrend(10)).parts.trend, 0);
});

/* -------------------------------------------------------------------------- */
/*  突破量能：必须"价格与量同时"                                              */
/* -------------------------------------------------------------------------- */

test('只有价格突破、没有放量时不给突破分（插针风险）', () => {
  const base = flat(30);
  const popped = [...base, bar(103, { high: 103.2, low: 102.5, volume: 100 })]; // 量不变
  assert.equal(scoreSymbol(popped, flat(40)).parts.breakoutVolume, 0, '无量突破不给分');
});

test('价格突破 + 显著放量时才给分，且量越大分越高', () => {
  const base = flat(30);
  const mild = [...base, bar(103, { high: 103.2, low: 102.5, volume: 160 })]; // 1.6 倍
  const strong = [...base, bar(103, { high: 103.2, low: 102.5, volume: 320 })]; // 3.2 倍

  const a = scoreSymbol(mild, flat(40)).parts.breakoutVolume;
  const b = scoreSymbol(strong, flat(40)).parts.breakoutVolume;
  assert.ok(a > 0, `1.6 倍量应当给分，实际 ${a}`);
  assert.ok(b > a, `更大的量应当给更高分：${b} 应 > ${a}`);
  assert.ok(b <= 1, '突破分不超过 1');
});

test('向下突破同样算突破 —— 做空和做多是同一个信号的两个方向', () => {
  const base = flat(30);
  const dumped = [...base, bar(97, { high: 97.5, low: 96.8, volume: 300 })];
  assert.ok(scoreSymbol(dumped, flat(40)).parts.breakoutVolume > 0, '放量破位应当给分');
});

/* -------------------------------------------------------------------------- */
/*  波动惩罚：唯一的减分项                                                     */
/* -------------------------------------------------------------------------- */

test('波动越大扣分越多，而且它确实会把总分压下来', () => {
  /*
   * 这是四个分量里唯一的减分项，也是最重要的：它把"什么样的行情不该做"
   * 写成了规则。**只有加分项的话，一个剧烈震荡的行情会被判成"有波动=有机会"。**
   */
  const quietBars = flat(30).map((k) => bar(100, { open: 100, high: 100.1, low: 99.9 }));
  const wildBars = Array.from({ length: 30 }, (_, i) =>
    bar(100 + (i % 2 === 0 ? 3 : -3), { open: 100, high: 105, low: 95 }),
  );

  const quiet = scoreSymbol(quietBars, flat(40));
  const wild = scoreSymbol(wildBars, flat(40));

  assert.ok(wild.parts.volatilityPenalty > quiet.parts.volatilityPenalty, '剧烈波动应当扣更多');
  assert.ok(wild.total < quiet.total, `波动大的总分应当更低：${wild.total} 应 < ${quiet.total}`);
});

test('总分 = 各分量按权重求和 —— 这是唯一能精确测到"惩罚进了总分"的写法', () => {
  /*
   * 这个用例是**两次变异检查都失败**之后才写对的，经过值得记下来。
   *
   * 尝试一：比较 wild.total < quiet.total → 变异（去掉惩罚）后照常通过，
   *         因为整理分/突破分的差异顺手满足了它。**通过的理由是错的。**
   * 尝试二：构造两组历史、只让波动不同 → 也照常通过，
   *         因为四个分量读的是同一份 K 线，整理分（看实体大小）也跟着变了。
   *
   * 根本困难：**四个分量共享输入，"构造两个输入"无法只隔离一个变量。**
   *
   * 正确做法是不构造输入，而是**直接验证那条算式**：
   * 把 parts 按权重算一遍，看它是否等于 total。
   * 惩罚从总分里去掉时，这个等式立刻不成立 —— 精确、且不依赖任何巧合。
   */
  /*
   * ⚠️ 必须包含一个**惩罚项真的非零**的用例。
   *
   * 前两次变异检查都失败，最后发现原因在这里：我给的四个输入全是低波动
   * （flat 的高低差 0.02%、uptrend 每步 0.1%），ATR 远低于 0.3% 的死区，
   * **`volatilityPenalty` 恒为 0** —— 于是"把惩罚乘 0"是个**空操作**，
   * 算式两边本来就相等。
   *
   * **测一个项的时候，那个项必须真的非零**，否则再精确的验证也是空的。
   */
  /*
   * ⚠️ 高波动的那一组必须**同时有强趋势**，这是第三次修正才想明白的。
   *
   * 只用"高波动 + 横盘"的话：有惩罚时 raw = −30、没惩罚时 raw = 0，
   * **两者都被 `Math.max(0, ...)` 钳成 0**，算式验证因此失效
   * （实测 penalty=1.0、total=0、期望=0，差 0）。
   *
   * 要让钳位不参与，就得让两组值都落在 0–100 之内：趋势 +40 减惩罚 −30 = 10，
   * 而没惩罚时是 40 —— **两个都不钳位，差异才暴露得出来。**
   */
  const wildTrending = Array.from({ length: 30 }, (_, i) => {
    const px = 100 * (1 + i * 0.004);
    return bar(px, { open: px * 0.996, high: px * 1.03, low: px * 0.97 });
  });

  const cases: Array<[Kline[], Kline[]]> = [
    [uptrend(40), uptrend(60)],
    [downtrend(40), downtrend(60)],
    [flat(40), flat(60)],
    [flat(30).concat(bar(103, { high: 103.2, low: 102.5, volume: 320 })), flat(60)],
    // 高波动：这一组才让惩罚项非零
    [wildTrending, uptrend(60, 0.004)],
  ];

  // 前提断言：至少要有一个用例的惩罚项非零，否则整个用例是空转的。
  assert.ok(
    cases.some(([k15, k4]) => scoreSymbol(k15, k4).parts.volatilityPenalty > 0),
    '没有任何用例产生非零的波动惩罚 —— 那样这个用例测不到任何东西',
  );

  for (const [k15, k4] of cases) {
    const s = scoreSymbol(k15, k4);
    const expected =
      s.parts.trend * SCORE_WEIGHTS.trend +
      s.parts.breakoutVolume * SCORE_WEIGHTS.breakoutVolume +
      s.parts.consolidation * SCORE_WEIGHTS.consolidation -
      s.parts.volatilityPenalty * SCORE_WEIGHTS.volatilityPenalty;
    const clamped = Math.max(0, Math.min(100, expected));

    assert.ok(
      Math.abs(s.total - clamped) < 0.02,
      `总分与"各分量按权重求和"不一致：total=${s.total} 而算式给出 ${clamped}。` +
        '若两者不等，说明某个分量（最可能是波动惩罚）没有真的进入总分。',
    );
  }
});
test('温和波动不扣分 —— 惩罚要有死区，否则正常的波动也被罚', () => {
  const calm = flat(30).map((k) => bar(100, { open: 100, high: 100.05, low: 99.95 }));
  assert.equal(scoreSymbol(calm, flat(40)).parts.volatilityPenalty, 0);
});

/* -------------------------------------------------------------------------- */
/*  分量的可解释性                                                             */
/* -------------------------------------------------------------------------- */

test('四个分量都返回出来 —— 调参时要看的就是它们，不只是一个总分', () => {
  /*
   * 只给总分的话，AI 改权重时不知道是哪一项在起作用 ——
   * 而"一次只改一项、看结果"是它能不能学到东西的前提。
   */
  const s = scoreSymbol(uptrend(40), uptrend(60));
  for (const key of ['trend', 'breakoutVolume', 'consolidation', 'volatilityPenalty']) {
    assert.ok(key in s.parts, `分量缺少 ${key}`);
  }
});

test('整理分：越安静的横盘越高', () => {
  const quiet = Array.from({ length: 30 }, () => bar(100, { open: 100.02, high: 100.05, low: 99.95 }));
  const noisy = Array.from({ length: 30 }, (_, i) => bar(100, { open: 100 + (i % 2 ? 0.8 : -0.8), high: 101, low: 99 }));
  assert.ok(
    scoreSymbol(quiet, flat(40)).parts.consolidation >
      scoreSymbol(noisy, flat(40)).parts.consolidation,
    '更安静的横盘整理分应更高',
  );
});
