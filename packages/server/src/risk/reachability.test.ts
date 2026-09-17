/**
 * 配置可达性体检。
 *
 * ## 为什么这些用例存在
 *
 * 这个函数防的是**实测撞到过的一次静默失效**：机器人连续 60 多个周期一笔单没开，
 * 而每轮周期都"成功"、日志干净、状态显示 running。
 *
 * 根因是两条互相矛盾的配置，数字上完全不显眼：
 *
 *     9.11 × 0.5 = 4.55 USDT   ← 名义上限
 *     币安最小名义 ≈ 5 USDT      ← 名义下限
 *     → 4.55 < 5，任何山寨币仓位都不成立
 *
 * **这个检查的价值全在边界上**：它错报"可达"会让机器人继续空转，
 * 错报"不可达"会让一次本来正常的启动被拦下。所以每个条件的**两侧**都钉。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkConfigReachability, EXCHANGE_MIN_NOTIONAL_USD, type ReachabilityInput } from './reachability.js';

/** 实测那次事故的真实参数：9.11 USDT 账户、山寨币比例 0.5、下限 6。 */
const live = (over: Partial<ReachabilityInput> = {}): ReachabilityInput => ({
  equity: 9.11,
  maxMarginUsagePercent: 50,
  ratios: { major: 3, altcoin: 0.5 },
  minPositionSize: 6,
  defaultLeverage: 2,
  maxLeverage: { major: 3, altcoin: 3 },
  ...over,
});

/* -------------------------------------------------------------------------- */
/*  实测那次事故：必须被报出来                                                 */
/* -------------------------------------------------------------------------- */

test('复现实测事故：9.11 USDT + 山寨币比例 0.5 + 下限 6 → 山寨币不可达', () => {
  /*
   * 这是这个函数存在的**唯一理由**。那次机器人空转了 60 多个周期，
   * 而所有既有判据都是 0（无成交、无被拒、权益不动）——
   * 只有这条判据能在启动时把它指出来。
   */
  const r = checkConfigReachability(live());
  const alt = r.findings.find((f) => f.scope === 'altcoin')!;
  assert.equal(alt.reachable, false, '山寨币必须被判为不可达');
  assert.match(alt.detail, /算术上完全不可交易/, '要说清这是算术问题，不是行情问题');
  assert.match(alt.detail, /4\.55/, '理由要带具体数字 —— 4.55 是上限');
});

test('BTC/ETH 在同一配置下仍然可达 —— 不是所有类别都坏', () => {
  /*
   * 这条区分了"整个配置坏了"和"某一大类坏了"。
   * 实测里 BTC/ETH 是能交易的（上限 27.33），只有山寨币不行 ——
   * 而机器人恰恰因为候选池里大多是山寨币而空转。
   */
  const r = checkConfigReachability(live());
  assert.equal(r.ok, true, '至少一类可交易时整体不该判为失败');
  const major = r.findings.find((f) => f.scope === 'major')!;
  assert.equal(major.reachable, true);
  assert.ok(major.range && Math.abs(major.range.max - 27.33) < 0.01, 'BTC/ETH 上限应为 9.11 × 3');
});

test('两类都不可达时整体判为失败，且总结说清后果', () => {
  const r = checkConfigReachability(live({ ratios: { major: 0.1, altcoin: 0.1 } }));
  assert.equal(r.ok, false);
  assert.match(r.summary, /配置错误/, '要把它与"策略判断"区分开');
  assert.match(r.summary, /永远空转/, '要说清后果');
});

/* -------------------------------------------------------------------------- */
/*  第 2 个条件：与交易所下限的交集（最容易漏的一条）                          */
/* -------------------------------------------------------------------------- */

test('我们的下限低于交易所下限时，按交易所下限算 —— 只看自己的配置看不出来', () => {
  /*
   * ⚠️ 这一条是最容易漏的：它是**我们与交易所之间**的矛盾，
   * 不是我们自己参数之间的矛盾。`minPositionSize` 设成 1 看起来没问题，
   * 但如果 `equity × ratio` 只有 4，交易所仍会拒单。
   */
  const r = checkConfigReachability(
    live({ equity: 8, ratios: { major: 3, altcoin: 0.5 }, minPositionSize: 1 }),
  );
  const alt = r.findings.find((f) => f.scope === 'altcoin')!;
  // 8 × 0.5 = 4 < 5
  assert.equal(alt.reachable, false, '下限设得再低也救不了"上限低于交易所下限"');
  assert.match(alt.detail, new RegExp(String(EXCHANGE_MIN_NOTIONAL_USD)), '理由要提到交易所下限');
});

test('上限刚好等于交易所下限时可达（边界取"大于等于"）', () => {
  // 10 × 0.5 = 5，恰好等于交易所下限
  const r = checkConfigReachability(live({ equity: 10, ratios: { major: 3, altcoin: 0.5 }, minPositionSize: 1 }));
  const alt = r.findings.find((f) => f.scope === 'altcoin')!;
  assert.equal(alt.reachable, true, '恰好等于应当放行，否则门槛的实际含义与配置不符');
});

test('上限比交易所下限少一分钱就不可达', () => {
  const r = checkConfigReachability(live({ equity: 9.98, ratios: { major: 3, altcoin: 0.5 }, minPositionSize: 1 }));
  assert.equal(r.findings.find((f) => f.scope === 'altcoin')!.reachable, false);
});

/* -------------------------------------------------------------------------- */
/*  第 3 个条件：保证金够不够                                                  */
/* -------------------------------------------------------------------------- */

test('名义区间够但保证金不够时仍不可达', () => {
  /*
   * 这条判的是第三层：即使名义价值在区间内，保证金占用也可能超上限。
   * 实测里没撞到，但它与另两条是同一类"算术上不可能"。
   */
  const r = checkConfigReachability(
    live({
      equity: 20,
      ratios: { major: 3, altcoin: 3 },
      minPositionSize: 50, // 名义下限 50 → 3x 下需保证金 16.67
      maxMarginUsagePercent: 10, // 可用只有 2
      maxLeverage: { major: 3, altcoin: 3 },
    }),
  );
  const all = r.findings.every((f) => !f.reachable);
  assert.equal(all, true, '保证金不够时两类都该不可达');
  assert.match(r.findings[0]!.detail, /保证金/, '理由要指向保证金，而不是笼统说不可达');
});

/* -------------------------------------------------------------------------- */
/*  可达时的输出要有用                                                         */
/* -------------------------------------------------------------------------- */

test('可达时给出区间与余量 —— 余量很小时操作员该知道', () => {
  /*
   * 实测里 AI 自己诊断出"合法区间仅 [5, 5.47]，余量约 9%"并据此调整了比例。
   * 余量是这个检查最有行动价值的部分：区间非空但极窄时，
   * 任何按风险百分比算出来的仓位都会被钳到下限，策略实际上退化成"固定最小仓"。
   */
  const r = checkConfigReachability(live({ ratios: { major: 3, altcoin: 1 }, minPositionSize: 5 }));
  const alt = r.findings.find((f) => f.scope === 'altcoin')!;
  assert.equal(alt.reachable, true);
  assert.ok(alt.range);
  assert.ok(Math.abs(alt.range.max - 9.11) < 0.01);
  assert.match(alt.detail, /余量/, '要写出余量');
});

test('权益为 0 或负数时一律不可达，且不抛异常', () => {
  for (const equity of [0, -1]) {
    const r = checkConfigReachability(live({ equity }));
    assert.equal(r.ok, false, `权益 ${equity} 不该判为可达`);
    for (const f of r.findings) assert.ok(f.detail.length > 20, '每个发现都要有可读的理由');
  }
});

test('每个发现都给出理由 —— 一个静默的体检等于没有体检', () => {
  const r = checkConfigReachability(live());
  for (const f of r.findings) {
    assert.ok(f.detail.length > 20, `${f.scope} 缺少可读的理由`);
  }
  assert.ok(r.summary.length > 10);
});
