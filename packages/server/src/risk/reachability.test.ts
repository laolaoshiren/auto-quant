/**
 * 可交易标的体检。
 *
 * ## 为什么这些用例存在
 *
 * 这个函数防的是一次**实测的静默失效**：机器人连续 60 多个周期一笔单没开，
 * 而每轮周期都"成功"、日志干净、状态显示 running。
 *
 * 而我**写错过它两次**，两次都在这里钉住：
 *
 * 1. **编了一个 `EXCHANGE_MIN_NOTIONAL_USD = 5`**。真值按标的不同
 *    （BTC 50、ETH 20、山寨 5），而且一直就在交易所元数据里。
 * 2. **算上限时漏了 `maxMarginUsage`**。3x 下 27.33 USDT 名义要 9.11 保证金，
 *    而 50% 只给 4.56 —— 真上限 13.68。
 *
 * 所以夹具里的数字**全部来自实测的交易所元数据**，不是我推出来的。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkConfigReachability, type ReachabilityInput, type SymbolConstraint } from './reachability.js';

/** 实测的交易所元数据（`fapi/v1/exchangeInfo` 读出来的原值）。 */
const REAL: Record<string, { minNotional: number; stepSize: number; price: number; isMajor: boolean }> = {
  BTCUSDT: { minNotional: 50, stepSize: 0.001, price: 76_000, isMajor: true },
  ETHUSDT: { minNotional: 20, stepSize: 0.001, price: 2_400, isMajor: true },
  SOLUSDT: { minNotional: 5, stepSize: 0.01, price: 100, isMajor: false },
  HYPEUSDT: { minNotional: 5, stepSize: 0.01, price: 80, isMajor: false },
};

const sym = (name: keyof typeof REAL): SymbolConstraint => {
  const { minNotional, stepSize, price, isMajor } = REAL[name]!;
  return { symbol: name, minNotional, stepSize, price, isMajor };
};

/** 实测那次事故的配置：9.11 USDT、保证金 50%、比例 3/1、下限 5、杠杆 3。 */
const live = (over: Partial<ReachabilityInput> = {}): ReachabilityInput => ({
  equity: 9.11,
  maxMarginUsagePercent: 50,
  ratios: { major: 3, altcoin: 1 },
  minPositionSize: 5,
  maxLeverage: { major: 3, altcoin: 3 },
  symbols: [sym('BTCUSDT'), sym('ETHUSDT'), sym('SOLUSDT'), sym('HYPEUSDT')],
  ...over,
});

const verdict = (r: ReturnType<typeof checkConfigReachability>, name: string) =>
  [...r.tradable, ...r.blocked].find((v) => v.symbol === name)!;

/* -------------------------------------------------------------------------- */
/*  实测结论：BTC 与 ETH 在这个账户上开不出来                                   */
/* -------------------------------------------------------------------------- */

test('BTC 在这个账户上开不出来 —— 交易所要 50，账户最多给 13.68', () => {
  /*
   * 这是实测的事实：日志里每一轮都是
   * `BTCUSDT 仓位名义价值 $6.00 低于最低要求 $50.00`。
   *
   * 它看起来像"策略太保守"，实际是 **BTC 在这个账户规模下不可能**。
   * 这一条把那个区分钉住。
   */
  const v = verdict(checkConfigReachability(live()), 'BTCUSDT');
  assert.equal(v.tradable, false);
  assert.match(v.reason, /开不出来/, '要明确说这是不可能，不是不划算');
  assert.match(v.reason, /50/, '理由里要有交易所的真实下限');
});

test('ETH 同样开不出来 —— 它要 20，而账户的上限是 13.68', () => {
  /*
   * ⚠️ 这一条是我漏过的：ETH 只需要 20，看起来"9.11 × 3 = 27.33 够了"，
   * **但 27.33 是比例上限，不是真上限** —— 保证金那一层把真上限压到 13.68。
   */
  const v = verdict(checkConfigReachability(live()), 'ETHUSDT');
  assert.equal(v.tradable, false, 'ETH 要 20 > 13.68，开不出来');
});

test('上限取"比例"与"保证金"里更小的那个 —— 哪个绑定取决于资产类别', () => {
  /*
   * 这一条钉住两层算术，并区分两种绑定：
   *
   *   比例上限   = equity × ratio
   *   保证金上限 = equity × maxMarginUsage% × 杠杆
   *
   * 山寨币（ratio 1.0）：比例 9.11 < 保证金 13.66 → **比例绑定**
   * BTC/ETH（ratio 3.0）：比例 27.33 > 保证金 13.66 → **保证金绑定**
   *
   * ⚠️ 我最初只算了比例那一层，于是得出"BTC/ETH 上限 27.33、可行"的错误结论。
   */
  const r = checkConfigReachability(live());

  const sol = verdict(r, 'SOLUSDT');
  assert.ok(sol.range);
  assert.ok(Math.abs(sol.range.max - 9.11) < 0.01, `山寨币上限应为比例给的 9.11，实际 ${sol.range.max}`);

  // BTC 被挡下，但它的 reason 里应当出现保证金那一层算出来的 13.66
  const btc = verdict(r, 'BTCUSDT');
  assert.equal(btc.tradable, false);
  assert.match(btc.reason, /13\.6/, 'BTC 的上限应当体现保证金那一层（13.66），而不是比例的 27.33');
});

/* -------------------------------------------------------------------------- */
/*  实测结论：山寨币可行 —— 这解释了为什么只开出过 SOL                          */
/* -------------------------------------------------------------------------- */

test('最小名义 5 的山寨币可行 —— 这解释了机器人只开出过 SOL', () => {
  const r = checkConfigReachability(live());
  const sol = verdict(r, 'SOLUSDT');
  assert.equal(sol.tradable, true);
  assert.ok(sol.range);
  assert.ok(Math.abs(sol.range.min - 5) < 1e-9, '下限应为交易所的 5');
});

test('报告形式是"哪些标的能交易" —— 那才是能用于决策的答案', () => {
  /*
   * `BTC/ETH 可行吗` 的答案（"BTC 不行、ETH 不行、SOL 行"）没法直接用于决策；
   * **"你能交易 2 个标的，其中 SOL、HYPE"** 可以。
   */
  const r = checkConfigReachability(live());
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.tradable.map((v) => v.symbol).sort(),
    ['HYPEUSDT', 'SOLUSDT'],
    '应当精确报出可交易的标的集合',
  );
  assert.match(r.summary, /可交易/, '总结要说清可交易');
  assert.match(r.summary, /被挡下|开不出来/, '也要说清有多少被挡下');
});

test('全部不可交易时，总结明确指向"配置/账户规模"而不是"策略判断"', () => {
  /*
   * 这个区分是整件事的关键：两者在控制台上长得一模一样，
   * 但前者要改配置，后者才是等机会。混为一谈的代价是几十轮空转。
   */
  const r = checkConfigReachability(live({ equity: 2 }));
  assert.equal(r.ok, false);
  assert.match(r.summary, /配置/, '要指向配置');
  assert.match(r.summary, /不是策略判断/, '要显式排除"策略判断"这个解释');
  assert.match(r.summary, /动态币池/, '要说明这次评的是哪些标的 —— 说得太满会误导操作员');
});

/* -------------------------------------------------------------------------- */
/*  取整：−4164 的成因                                                         */
/* -------------------------------------------------------------------------- */

test('有效下限被抬到步长的整数倍 —— 而不是"取整后不足就判死"', () => {
  /*
   * ⚠️ 这条钉住我写错过的一次：最初的做法是"下限对应数量向下取整，
   * 结果低于交易所下限就判不可交易"。**那会误报**：
   *
   *     HYPE：下限 5 ÷ 价格 80 = 0.0625 → 向下取整 0.06 → 名义 4.80 < 5  ✗
   *     正确做法：向上取到 0.07 → 名义 5.60 ≥ 5  ✅ **完全可以交易**
   *
   * 所以有效下限是"**能达到交易所下限的最小合法数量**"对应的名义价值。
   *
   * LSK 的步长是 1（实测值），价格 3、下限 5：
   *   需要 ceil(5/3/1) = 2 个单位 → 名义 6 USDT
   *   6 ≤ 上限 9.11 → 可交易，但**下限是 6 而不是 5**
   */
  const lsk: SymbolConstraint = { symbol: 'LSKUSDT', minNotional: 5, stepSize: 1, price: 3, isMajor: false };
  const v = verdict(checkConfigReachability(live({ symbols: [lsk] })), 'LSKUSDT');
  assert.equal(v.tradable, true, '步长粗只抬高下限，不该把标的判死');
  assert.ok(v.range);
  assert.ok(Math.abs(v.range.min - 6) < 1e-9, `有效下限应为 6（两个步长单位的 3 USDT），实际 ${v.range.min}`);
});

test('抬升后的有效下限超出上限时，才真的判不可交易', () => {
  /*
   * 这是上一条的另一侧：步长把下限抬得**超过**账户能给的上限时，才是真的开不出来。
   * 两个方向都要钉，否则"过严"与"过松"都测不出来。
   */
  const coarse: SymbolConstraint = { symbol: 'COARSEUSDT', minNotional: 5, stepSize: 1, price: 12, isMajor: false };
  // ceil(5/12/1)=1 → 名义 12 > 上限 9.11
  const v = verdict(checkConfigReachability(live({ symbols: [coarse] })), 'COARSEUSDT');
  assert.equal(v.tradable, false, '抬升后超出上限时应当判不可交易');
  assert.match(v.reason, /超过名义上限|开不出来/, '理由要说清是超出上限');
});

test('取整后刚好达标时放行（边界取"大于等于"）', () => {
  // 下限 5、价格 5、步长 1 → 数量 1 → 名义 5，恰好达标
  const s: SymbolConstraint = { symbol: 'XUSDT', minNotional: 5, stepSize: 1, price: 5, isMajor: false };
  const v = verdict(checkConfigReachability(live({ symbols: [s] })), 'XUSDT');
  assert.equal(v.tradable, true, '恰好等于应当放行');
});

/* -------------------------------------------------------------------------- */
/*  边界与健壮性                                                               */
/* -------------------------------------------------------------------------- */

test('权益为 0 或负数时一律不可交易，且不抛异常', () => {
  for (const equity of [0, -1]) {
    const r = checkConfigReachability(live({ equity }));
    assert.equal(r.ok, false, `权益 ${equity} 不该判为可交易`);
    for (const v of r.blocked) assert.ok(v.reason.length > 20, '每个判定都要有可读的理由');
  }
});

test('空标的列表不炸', () => {
  const r = checkConfigReachability(live({ symbols: [] }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.tradable, []);
});

test('每个判定都给出理由 —— 一个静默的体检等于没有体检', () => {
  const r = checkConfigReachability(live());
  for (const v of [...r.tradable, ...r.blocked]) {
    assert.ok(v.reason.length > 20, `${v.symbol} 缺少可读的理由`);
  }
  assert.ok(r.summary.length > 10);
});

test('下限取"我们自己的"与"交易所的"里更高的那个', () => {
  /*
   * 两个下限都可能成为绑定约束：我们自己设的（防止粉尘仓）与交易所的
   * （低于它直接拒单）。只看其中一个都会给出错误结论。
   */
  const r = checkConfigReachability(live({ minPositionSize: 8 }));
  const sol = verdict(r, 'SOLUSDT');
  assert.equal(sol.tradable, true);
  assert.ok(sol.range);
  assert.ok(Math.abs(sol.range.min - 8) < 1e-9, '我们自己的下限更高时应当用它');

  const r2 = checkConfigReachability(live({ minPositionSize: 1 }));
  const sol2 = verdict(r2, 'SOLUSDT');
  assert.ok(sol2.range);
  assert.ok(Math.abs(sol2.range.min - 5) < 1e-9, '交易所下限更高时应当用它');
});
