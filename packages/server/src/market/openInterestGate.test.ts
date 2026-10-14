/**
 * **`minOpenInterestUsd` 必须真的参与筛选**（外部 issue #182）。
 *
 * ## 缺陷形状
 *
 * `minOpenInterestUsd`（界面「最小持仓量（USDT）」、schema 默认 5_000_000）：
 *
 * ```
 * service.ts:447   screenUniverse 的 options 里声明收下
 * service.ts:459   筛选循环只读 minQuoteVolume24h          ← 从不读 minOpenInterestUsd
 * service.ts:630   screenOpenInterestGrowth 转发给它        ← 转发了也没人读
 * autoTrader.ts:2969  写进给操作员的门槛提示                ← 拿它解释一个它没参与的结果
 * ```
 *
 * 全仓 `grep minOpenInterestUsd` 在 `service.ts` 里**只有 3 处**
 *（447 声明、620 声明、630 转发）—— **没有一处读取它做过滤**。
 *
 * ## 为什么这个洞落在最需要它的地方
 *
 * `screenOpenInterestGrowth` 的增长率是：
 *
 * ```ts
 * growth = (last - first) / first * 100
 * ```
 *
 * **分母（窗口起点持仓量）极小时，这个比值天然是噪声** —— 一点点资金进出就是 +300%。
 * 而"最小持仓量"这道护栏**本就是为了把这个路径的假信号挡住**而存在的。
 *
 * 讽刺的是那个函数**自己已经在读 `sumOpenInterest`**（`:641-642`），
 * 数据就在手里，只是没拿来比。
 *
 * ## 为什么抽成纯函数
 *
 * `MarketDataService` 要真实的网络与交易所客户端才能构造，而本文件要验证的是
 * "持仓量门槛有没有被应用"这一条判据。抽出来之后它可被单测 ——
 * 与 `screenSymbols`（`screening.ts`）是同一个做法。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { filterByMinOpenInterest, growthPercent } from './screening.js';

test('★★★ 持仓量低于门槛的标的必须被剔除 —— 它此前从未生效', () => {
  const rows = [
    { symbol: 'BIGUSDT', openInterestUsd: 50_000_000 },
    { symbol: 'MIDUSDT', openInterestUsd: 8_000_000 },
    { symbol: 'TINYUSDT', openInterestUsd: 120_000 }, // ← 分母极小，growth% 是噪声
  ];

  const kept = filterByMinOpenInterest(rows, 5_000_000).map((r) => r.symbol);
  assert.deepEqual(
    kept,
    ['BIGUSDT', 'MIDUSDT'],
    '★★★ 低于 `minOpenInterestUsd` 的必须被剔除 —— 此前这个参数被接收、被转发、' +
      '还被写进给操作员的提示，却从不参与筛选（issue #182）',
  );
});

test('★ 门槛为 0 时不做任何剔除 —— 那是"关掉这条规则"的既有约定', () => {
  const rows = [
    { symbol: 'A', openInterestUsd: 1 },
    { symbol: 'B', openInterestUsd: 0 },
  ];
  assert.deepEqual(
    filterByMinOpenInterest(rows, 0).map((r) => r.symbol),
    ['A', 'B'],
    '★ 门槛 0 = 不筛（与 `pendingEntryTimeoutMinutes = 0` 等同族字段的约定一致）',
  );
});

test('★ 恰好等于门槛的保留 —— 边界是"小于才剔除"', () => {
  const rows = [{ symbol: 'EDGE', openInterestUsd: 5_000_000 }];
  assert.deepEqual(filterByMinOpenInterest(rows, 5_000_000).map((r) => r.symbol), ['EDGE']);
});

test('★ 非有限值（NaN/Infinity）必须被剔除 —— 它们不能被当成"通过了门槛"', () => {
  /*
   * ⚠️ 这一条是**保守方向**：`NaN < 门槛` 是 `false`，所以"直接比较"的写法会
   * **放过 NaN**。而一个读不到持仓量的标的恰恰是最不该进候选池的。
   */
  const rows = [
    { symbol: 'NAN', openInterestUsd: Number.NaN },
    { symbol: 'INF', openInterestUsd: Number.POSITIVE_INFINITY },
    { symbol: 'OK', openInterestUsd: 9_000_000 },
  ];
  assert.deepEqual(
    filterByMinOpenInterest(rows, 5_000_000).map((r) => r.symbol),
    ['OK'],
    '★ NaN / Infinity 不能被当成"通过了门槛"',
  );
});

test('★★ growthPercent 在分母极小时是噪声 —— 这正是需要持仓量门槛的原因', () => {
  /*
   * 这条用例说明"为什么不能只靠 growth 排序"：
   * 两个标的的**绝对**增长量相同（都是 +1000 USDT），
   * 但分母极小那个算出 +1000%，分母大那个算出 +0.002%。
   *
   * 所以"最小持仓量"这道护栏的意义是：**先把分母太小的剔掉**，
   * 否则排名会被噪声主导。
   */
  const tiny = growthPercent(100, 1_100); // 分母 100
  const big = growthPercent(50_000_000, 50_001_000); // 分母 5000 万

  assert.ok(tiny > 900, `★ 分母极小时算出巨大百分比（实际 ${tiny}）—— 那是噪声`);
  assert.ok(big < 0.01, `★ 分母大时同一份绝对增长几乎不可见（实际 ${big}）`);

  /* 而同一条护栏下，tiny 会被剔除、big 会保留。 */
  const kept = filterByMinOpenInterest(
    [
      { symbol: 'TINY', openInterestUsd: 1_100 },
      { symbol: 'BIG', openInterestUsd: 50_001_000 },
    ],
    5_000_000,
  ).map((r) => r.symbol);
  assert.deepEqual(kept, ['BIG'], '★★ 持仓量门槛把"分母太小"的那个挡在外面');
});

test('★ growthPercent 的既有语义不变 —— 分母为 0 或负时返回 0 而不是 Infinity', () => {
  /*
   * 反向守卫：`(last-first)/first` 在 `first = 0` 时是 `Infinity`，
   * 而 `Infinity` 排序后会永远排第一 —— 一个读不到历史的标的不该登顶。
   */
  assert.equal(growthPercent(0, 100), 0, '分母 0 → 0，不是 Infinity');
  assert.equal(growthPercent(-5, 100), 0, '分母为负 → 0');
  assert.equal(growthPercent(100, 100), 0, '没有增长 → 0');
  assert.equal(growthPercent(100, 200), 100, '翻倍 → +100%');
  assert.equal(growthPercent(100, 50), -50, '减半 → -50%');
  /* 非有限输入同样归 0，而不是把 NaN 传下去。 */
  assert.equal(growthPercent(Number.NaN, 100), 0);
  assert.equal(growthPercent(100, Number.NaN), 0);
});

/* -------------------------------------------------------------------------- */
/*  ★★★ 接线：`service.ts` 必须真的调用它们（变异测试发现的盲区）                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **这个文件上面所有用例都只测纯函数，没有测"谁调用它"。**
 *
 * 我是用变异测试发现的：把 `service.ts` 里
 * `return filterByMinOpenInterest(measured, options.minOpenInterestUsd)`
 * 整行换回 `return measured`（即**把 issue #182 的修复完全回退**）——
 * 本文件**仍然 6/6 全绿**。
 *
 * 原因在文件头那段"为什么抽成纯函数"里写得很清楚（`MarketDataService` 要真实网络
 * 与交易所客户端才能构造）—— **那个取舍是合理的**，但代价是
 * **"纯函数被抽出来了，而没人证明它被调用"**。
 *
 * ⚠️ 而 #182 的缺陷形状**正是**"函数/参数都在，就是没人拿来比" ——
 * 所以这一环恰恰是最该被守住的。抽出来的判据 + 没守住的接线 = 同一个 bug 可以再回来一次。
 *
 * ## 为什么用结构断言
 *
 * 要功能性地测 `screenOpenInterestGrowth` 需要构造 `MarketDataService`
 *（真实网络 + 交易所客户端 —— 正是文件头说的那个代价）。
 * 而这里要验的只是"**调用点在不在**"，读源码足够，也正是 `fetchGuardedWiring.test.ts`
 * 与 `receiptAdjustGate.test.ts` 用的同一手法：
 * **接线用结构断言、逻辑用功能测试。**
 *
 * ⚠️ 断言前**剥掉注释** —— 本仓库注释会逐字引用被讨论的代码
 *（本文件头部就引用了 `service.ts:459` 的那一行），不剥会被自己的注释命中。
 */
test('★★★ service.ts 必须真的调用 filterByMinOpenInterest —— 否则 #182 的修复可以无声回退', () => {
  const source = readFileSync(new URL('./service.ts', import.meta.url), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');

  /*
   * ⚠️ 判据是"**以调用形式出现**"（`filterByMinOpenInterest(`）而不是"文件里提到它" ——
   * 后者会被 `import { filterByMinOpenInterest } from './screening.js'` 那一行命中，
   * 于是"导入了但不用"也会通过 —— 而那**恰好就是 #182 的形状**。
   */
  const callSites = [...code.matchAll(/filterByMinOpenInterest\(/g)];
  assert.ok(
    callSites.length >= 1,
    '★★★ `service.ts` 里没有任何 `filterByMinOpenInterest(...)` 的**调用** ——\n' +
      '    持仓量门槛又变成了"参数被接收、被转发、但没人读它"（issue #182 的原始形状）。\n' +
      '    ⚠️ 这个回退**不会**让本文件其它用例变红（它们只测纯函数），所以必须由这条守着。',
  );

  /*
   * ② 而且必须把**配置里的那个值**传进去 —— 传一个常量等于门槛被写死。
   */
  assert.match(
    code,
    /filterByMinOpenInterest\([^)]*minOpenInterestUsd/,
    '★★ 调用时必须把 `minOpenInterestUsd` 传进去 —— 传常量等于门槛被写死，配置改了不起作用',
  );

  /* ③ 反向守卫：确认剥注释真的生效（注释里就引用了这一行）。 */
  assert.doesNotMatch(
    code,
    /筛选循环只读 minQuoteVolume24h/,
    '★ 注释必须被剥掉 —— 否则上面的判据会被文件头那段引用命中',
  );
});
