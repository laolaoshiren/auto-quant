import { test } from 'node:test';
import assert from 'node:assert/strict';
import { figureParts } from './DecisionFeed.js';
import type { Decision } from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  决策行上的关键数字                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 造一条决策 —— 只填测试关心的字段，其余按 Schema 的"空值形态"补齐。
 *
 * 用 `satisfies` 而不是 `as`：字段名或类型写错时 typecheck 会报错，
 * 而不是让测试拿着一个假对象跑出假结论。
 */
function makeDecision(over: Partial<Decision>): Decision {
  return {
    symbol: 'BTCUSDT',
    action: 'hold',
    leverage: 0,
    positionSizeUsd: 0,
    stopLoss: null,
    takeProfit: null,
    confidence: 70,
    riskUsd: 0,
    reducePercent: null,
    reduceQuantity: null,
    entryType: 'market',
    limitPrice: null,
    reasoning: '',
    setupScore: null,
    setupScoreBasis: '',
    adjustments: [],
    ...over,
  } satisfies Decision;
}

test('★ 加仓要显示加了多少钱，减仓要显示减了多少 —— 那是"动仓位"的全部内容', () => {
  /*
   * 用户的追问（2026-10-03）：「最近决策上面会不会显示**仓位调整**？（如果有）
   * 就和我截图给你的别人平台的 UI 一样」。
   *
   * 核实：这两个动作和 `adjust_protection` 一样被 `isOpenAction` 挡在外面，
   * **界面上一个字都不显示**。实测它们**一次都没被用过**（今日 165 条决策里各 0 次），
   * 但"没用过"不等于"不该显示" —— 一被用上，操作员就得看懂它动了多少。
   */
  const add = figureParts(
    makeDecision({ action: 'add_to_position', positionSizeUsd: 30, leverage: 5 }),
    null,
  );
  assert.equal(add.find((p) => p.key === 'size')?.label, '加仓', '加仓要标明这是"加仓"而不是"仓位"');
  assert.match(add.find((p) => p.key === 'size')!.value, /30/);
  assert.equal(add.find((p) => p.key === 'leverage')?.value, '5x');

  const reduce = figureParts(
    makeDecision({ action: 'reduce_position', reducePercent: 50 }),
    null,
  );
  const cut = reduce.find((p) => p.key === 'reduce');
  assert.ok(cut, '★ 减仓必须显示减了多少');
  assert.equal(cut.value, '50.0%', '★ `reducePercent` 是【百分数】：50 就是"卖掉一半"');
});

test('★ 减仓比例的单位必须是百分数 —— 服务端是 `reducePercent / 100`', () => {
  /*
   * 判据在 `risk/engine.ts`：`fraction = reducePercent / 100`。
   *
   * 这条用例专门防一个我自己写出来的 bug：渲染时又除了一次 100，
   * 于是"卖掉一半"显示成 **0.50%** —— 操作员会以为它只象征性减了一点点，
   * 而实际是砍掉一半。**数字差 100 倍，方向听起来一样，后果完全相反。**
   */
  const parts = figureParts(makeDecision({ action: 'reduce_position', reducePercent: 100 }), null);
  assert.equal(
    parts.find((p) => p.key === 'reduce')?.value,
    '100.0%',
    '★ 100 表示全平，不能显示成 1.00%',
  );
});

test('★ 减仓用数量表达时显示数量（归一化后二选一）', () => {
  const parts = figureParts(
    makeDecision({ action: 'reduce_position', reducePercent: null, reduceQuantity: 0.05 }),
    null,
  );
  assert.ok(parts.some((p) => p.key === 'reduce'), '两个字段二选一，有一个就必须显示');
});

test('★ 调整保护位必须显示新的止损价 —— 那是这个动作的全部内容', () => {
  /*
   * ## 用户 2026-10-03 的反馈（附了另一个产品的截图）
   *
   *   「调整止损/止盈一目了然，再看看我们系统感觉杂乱无章」
   *
   * 截图里对方的产品直接写着「调整止损 → 1.3847」，而我们的界面
   * **只剩一个"持有"徽章加一段散文**，模型给出的新价位一个字都没显示。
   *
   * ## 根因
   *
   * `figureParts` 第一行是 `if (!isOpenAction(action)) return []`，
   * 而 `isOpenAction` 只认 `open_*` —— 于是 `adjust_protection` 被整段跳过。
   * 模型把新止损放在 `decision.stopLoss` 里（线上实例可查：`#1651` XRPUSDT
   * `stopLoss: 1.489`），界面把它丢掉了。
   */
  const parts = figureParts(
    makeDecision({ action: 'adjust_protection', symbol: 'XRPUSDT', stopLoss: 1.489 }),
    null,
  );

  const stop = parts.find((p) => p.key === 'stop');
  assert.ok(stop, '★ 调整止损的决策必须带上新的止损价 —— 否则界面只说了"我调整了"，没说"调到哪里"');
  assert.match(stop.value, /1\.489/);
  assert.equal(stop.label, '止损 →', '标签要带箭头，表示"改成了这个价"');
});

test('★ 只调止损时不显示止盈 —— 不能凭空多出一个它没碰的价格', () => {
  /*
   * 线上三条实测（`#1651` / `#1645` / `#1637`）**全部**是 `takeProfit: null`：
   * 模型只是上移止损来锁利。此时渲染一个"止盈 —"会让人以为它动了止盈。
   */
  const parts = figureParts(
    makeDecision({ action: 'adjust_protection', stopLoss: 118.31, takeProfit: null }),
    null,
  );

  assert.deepEqual(
    parts.map((p) => p.key),
    ['stop'],
    '★ 只改了止损，就只显示止损',
  );
});

test('★ 同时调止损与止盈时两个都显示', () => {
  const parts = figureParts(
    makeDecision({ action: 'adjust_protection', stopLoss: 1.3847, takeProfit: 1.5703 }),
    null,
  );
  assert.deepEqual(parts.map((p) => p.key), ['stop', 'target']);
});

test('★ 调整保护位不显示仓位与杠杆 —— 它不改变持仓数量', () => {
  /*
   * 线上那三条的 `leverage` 与 `positionSizeUsd` 都是 **0**：模型的语义是
   * "只改保护单价位"。如果照开仓那条路径渲染，界面会出现「$0.00 · 0x」——
   * 两个凭空捏造的数字。
   */
  const keys = figureParts(makeDecision({ action: 'adjust_protection', stopLoss: 100 }), null).map(
    (p) => p.key,
  );
  assert.ok(!keys.includes('size'), '★ 不该出现仓位金额');
  assert.ok(!keys.includes('leverage'), '★ 不该出现杠杆');
  assert.ok(!keys.includes('entry'), '★ 不该出现开仓价 —— 没有开仓');
});

test('调整保护位一个价都没给时不渲染空行', () => {
  const parts = figureParts(makeDecision({ action: 'adjust_protection' }), 100);
  assert.deepEqual(parts, [], '★ 没有可显示的内容就返回空 —— 一个空行比不渲染更糟');
});

test('观望 / 等待 / 持有不带任何数字', () => {
  for (const action of ['hold', 'wait', 'skip'] as const) {
    assert.deepEqual(
      figureParts(makeDecision({ action }), 100),
      [],
      `${action} 没有数字可谈`,
    );
  }
});
