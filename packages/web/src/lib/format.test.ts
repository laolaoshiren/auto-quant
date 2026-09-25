/**
 * 格式化函数的口径与边界。
 *
 * ## 为什么这些用例存在
 *
 * `format.ts` 是**所有页面共用的算术** —— 它错了，每个页面都错，而在此之前它
 * 一个测试都没有。这里已经出过一次真实事故：`winRatePercent` 被当成小数又乘了
 * 100，屏幕上显示 **10000%**。
 *
 * 那次的修法是**约定**（服务端统一给 0–100 的百分数，见 `stats.test.ts` 里那条
 * "is a percentage, not a fraction"），而约定只能靠注释与测试守着 —— 前端这一侧
 * 直到现在才补上。
 *
 * 下面每一条钉的都是**一个具体的显示错误**，不是"函数返回什么"：
 *
 *   · `NaN` / `Infinity` 必须显示成 `—`，不能是 `NaN` / `Infinity`
 *   · 回撤是极小值时显示 `0.00%` 而**不是 `-0.00%`**（一个不存在的负数）
 *   · 盈利因子 `null` 必须显示 `∞` 而**不是 `0`**（API 把 `Infinity` 序列化成 null，
 *     那是"还没有亏损成交"，不是"一笔都没赚"）
 *   · 正数永远带 `+` —— 颜色不是所有人都能分辨
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clamp,
  fmtDeltaUsd,
  fmtDrawdownPercent,
  fmtDuration,
  fmtNum,
  fmtPercent,
  fmtProfitFactor,
  fmtSigned,
  fmtUsdSigned,
  isNum,
  marginModeLabel,
  orderMarginMode,
  safeJson,
  sideLabel,
  symbolTone,
  timeAgo,
} from './format';

/* -------------------------------------------------------------------------- */
/*  基础：非有限数                                                                */
/* -------------------------------------------------------------------------- */

test('isNum 把 NaN 与 ±Infinity 排除在外 —— 它们是"没有值"，不是"值是它"', () => {
  assert.equal(isNum(0), true);
  assert.equal(isNum(-1.5), true);
  assert.equal(isNum(NaN), false);
  assert.equal(isNum(Infinity), false);
  assert.equal(isNum(-Infinity), false);
  assert.equal(isNum(null), false);
  assert.equal(isNum(undefined), false);
  assert.equal(isNum('12'), false, '字符串数字不该被当成数字');
});

test('任何非有限输入都渲染成 — ，绝不把 NaN / Infinity 漏到屏幕上', () => {
  /*
   * `(NaN).toFixed(2)` 得到字符串 `"NaN"` —— 它会原样渲染进表格。
   * 一个写着 `NaN` 的盈亏格子比 `—` 糟得多：前者看起来像程序坏了，
   * 后者是"这个数暂时没有"。
   */
  for (const bad of [NaN, Infinity, -Infinity, null, undefined]) {
    assert.equal(fmtNum(bad), '—', `fmtNum(${String(bad)})`);
    assert.equal(fmtPercent(bad), '—', `fmtPercent(${String(bad)})`);
    assert.equal(fmtDrawdownPercent(bad), '—', `fmtDrawdownPercent(${String(bad)})`);
    assert.equal(fmtSigned(bad), '—');
    assert.equal(fmtUsdSigned(bad), '—');
    assert.equal(fmtDeltaUsd(bad), '—');
    assert.equal(fmtDuration(bad), '—');
  }
});

/* -------------------------------------------------------------------------- */
/*  百分比：口径                                                                */
/* -------------------------------------------------------------------------- */

test('★ fmtPercent 只加符号和百分号，绝不换算 —— 换算是调用方的事', () => {
  /*
   * 这正是 10000% 那次事故的形状：函数以为入参是**已经算好的百分数**
   * （`winRatePercent` 就是 0–100），而调用方给了个小数值。
   *
   * 这条用例把"函数不负责换算"钉死 —— 它不可能知道 `0.5` 想表达的是
   * "0.5%" 还是 "50%"。**要改口径就去改调用方，别改这里。**
   */
  assert.equal(fmtPercent(0.5), '+0.50%', '0.5 就是 0.5%，不是 50%');
  assert.equal(fmtPercent(50), '+50.00%');
  assert.equal(fmtPercent(100), '+100.00%');
  assert.equal(fmtPercent(-3.25), '-3.25%');
  assert.equal(fmtPercent(0), '0.00%', '零不带符号');

  assert.equal(fmtPercent(12.345, 1), '+12.3%', 'digits 透传');
});

test('★ 回撤永远显示为负，但极小值必须显示 0.00% 而不是 -0.00%', () => {
  /*
   * `-0.00%` 不是"很小的回撤"，而是一个**不存在的负数** ——
   * 看起来像格式化 bug，也很廉价。
   *
   * 判定必须用 `toFixed` 之后的字符串：`-0.0001` 显示出来就是 `0.00`，
   * 那么它也该显示成 `0.00%`。用原始值判断（`value === 0`）会漏掉这种情况。
   */
  assert.equal(fmtDrawdownPercent(5), '-5.00%', '回撤固定带负号');
  assert.equal(fmtDrawdownPercent(-5), '-5.00%', '传进来是负数也一样');
  assert.equal(fmtDrawdownPercent(0), '0.00%');
  assert.equal(fmtDrawdownPercent(-0.0001), '0.00%', '不能是 -0.00%');
  assert.equal(fmtDrawdownPercent(0.0001), '0.00%', '不能是 -0.00%');
  assert.equal(fmtDrawdownPercent(0.005, 2), '-0.01%', '四舍五入之后非零就正常加负号');
});

/* -------------------------------------------------------------------------- */
/*  符号                                                                        */
/* -------------------------------------------------------------------------- */

test('正数永远带 + —— 颜色不是所有人都能分辨', () => {
  assert.equal(fmtSigned(1.5), '+1.50');
  assert.equal(fmtSigned(-1.5), '-1.50');
  assert.equal(fmtSigned(0), '0.00', '零不带符号');

  assert.equal(fmtUsdSigned(1.5), '+$1.50');
  assert.equal(fmtUsdSigned(-1.5), '-$1.50');
  assert.equal(fmtUsdSigned(0), '$0.00');

  assert.equal(fmtDeltaUsd(1.5), '+$1.50');
  assert.equal(fmtDeltaUsd(-0.004), '-$0.00', '负零附近的差值仍按负号走（它不是"零"）');
});

test('美元符号在正负号之后 —— `-$1.50` 而不是 `$-1.50`', () => {
  const s = fmtUsdSigned(-1.5);
  assert.ok(s.startsWith('-'), `实际 ${s}`);
  assert.ok(s.includes('$'), `实际 ${s}`);
  assert.equal(s.indexOf('$'), 1, '`$` 必须紧跟在符号后面');
});

/* -------------------------------------------------------------------------- */
/*  盈利因子                                                                    */
/* -------------------------------------------------------------------------- */

test('★ 盈利因子的 null 是"还没有亏损成交"，必须显示 ∞ 而不是 0', () => {
  /*
   * API 把 `Infinity` 序列化成 `null`（JSON 没有 Infinity）。所以 `null` 在这里
   * 的含义是"只赢过、没输过"，**不是"没有盈利"**。
   *
   * 显示成 `0.00` 会把一个最好的结果画成最差的 —— 这是双向的误导。
   */
  assert.equal(fmtProfitFactor(null), '∞');
  assert.equal(fmtProfitFactor(undefined), '∞');
  assert.equal(fmtProfitFactor(Infinity), '∞', '直接传 Infinity 也一样');

  assert.equal(fmtProfitFactor(0), '0.00', '真的 0 就是 0.00');
  assert.equal(fmtProfitFactor(1.5), '1.50');
  assert.equal(fmtProfitFactor(0.8), '0.80');
});

/* -------------------------------------------------------------------------- */
/*  时间                                                                        */
/* -------------------------------------------------------------------------- */

test('相对时间按档位取整，缺失与非法输入都是"从未"', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  assert.equal(timeAgo(null), '从未');
  assert.equal(timeAgo(undefined), '从未');
  assert.equal(timeAgo(''), '从未');
  assert.equal(timeAgo('not-a-date'), '从未', '解析不了也是"从未"，不是 NaN 天');

  assert.equal(timeAgo(ago(1_000)), '刚刚', '5 秒内算刚刚');
  assert.equal(timeAgo(ago(30_000)), '30 秒前');
  assert.equal(timeAgo(ago(5 * 60_000)), '5 分钟前');
  assert.equal(timeAgo(ago(3 * 3600_000)), '3 小时前');
  assert.equal(timeAgo(ago(2 * 86_400_000)), '2 天前');
});

test('时长入参单位是分钟，超过 60 分进位、超过 24 时进位', () => {
  assert.equal(fmtDuration(0), '0分');
  assert.equal(fmtDuration(59), '59分');
  assert.equal(fmtDuration(60), '1时0分');
  assert.equal(fmtDuration(90), '1时30分');
  assert.equal(fmtDuration(23 * 60 + 59), '23时59分');
  assert.equal(fmtDuration(24 * 60), '1天0时');
  assert.equal(fmtDuration(50 * 60), '2天2时');
  assert.equal(fmtDuration(-5), '0分', '负数被夹到 0，不显示 -5分');
});

/* -------------------------------------------------------------------------- */
/*  数字美化                                                                    */
/* -------------------------------------------------------------------------- */

test('fmtNum 只在大数上转 K / M / B，其余走千分位', () => {
  assert.equal(fmtNum(1234.5), '1,234.50');
  assert.equal(fmtNum(999), '999.00');
  assert.equal(fmtNum(50_000), '50,000.00', '10 万以下不转 K');
  assert.equal(fmtNum(120_000), '120.0K');
  assert.equal(fmtNum(1_500_000), '1.50M');
  assert.equal(fmtNum(2_000_000_000), '2.00B');
  assert.equal(fmtNum(-120_000), '-120.0K', '负数的量级判断用绝对值');
});

/* -------------------------------------------------------------------------- */
/*  杂项                                                                        */
/* -------------------------------------------------------------------------- */

test('sideLabel 只认 long 与 BUY 为多，其余一律为空（含大小写之外的值）', () => {
  assert.equal(sideLabel('long'), '多');
  assert.equal(sideLabel('BUY'), '多');
  assert.equal(sideLabel('short'), '空');
  assert.equal(sideLabel('SELL'), '空');
  assert.equal(sideLabel('buy'), '空', '小写不是约定值 —— 宁可显示"空"也不猜');
});

test('clamp 夹在区间内，且 min > max 时不产生 NaN', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(5, 10, 0), 0, 'Math.min(max, …) 先执行，结果是 max');
});

test('safeJson 遇到循环引用时退回 String()，而不是抛穿', () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(safeJson(cyclic), '[object Object]', '不能抛，调用方是渲染路径');

  assert.equal(safeJson({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(safeJson({ a: 1 }, 0), '{"a":1}');
});

test('★ symbolTone 对同一个币种永远给同一个颜色 —— 这是哈希的全部意义', () => {
  /*
   * 按出现顺序分配会让同一个币种在不同表格、翻页之后变色，而颜色的唯一用途
   * 就是让人一眼认出"这是同一个东西"。
   */
  assert.equal(symbolTone('BTCUSDT'), symbolTone('BTCUSDT'));
  assert.equal(symbolTone('ETHUSDT'), symbolTone('ETHUSDT'));

  // 不同币种**允许**撞色（只有 8 档），所以这里不能断言"必不相同" ——
  // 能断言的是：同一批主流币里确实出现了多种颜色（哈希没有退化成常数）。
  const majors = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT'];
  const tones = new Set(majors.map(symbolTone));
  assert.ok(tones.size >= 3, `主流币只取到 ${tones.size} 种颜色，哈希可能退化了`);

  for (const symbol of majors) {
    assert.match(symbolTone(symbol), /^#[0-9a-f]{6}$/i, `${symbol} 的颜色不是合法十六进制`);
  }
});

/* -------------------------------------------------------------------------- */
/*  保证金模式（全仓 / 逐仓）                                                    */
/* -------------------------------------------------------------------------- */

test('★ marginModeLabel：认不出就是 — ，绝不渲染成「全仓」', () => {
  /*
   * 币安官方明文「All contracts and positions are defaulted to the Cross Margin mode」——
   * 所以"没读到"最可能的真相**确实**是全仓。但"最可能是"不是"我们读到了"：
   * 把它渲染成「全仓」，就等于替交易所宣布一个我们没验证过的事实，而且
   * 「不知道」与「确实是全仓」在界面上从此再也分不开。
   *
   * 这个界面在别处已经反复做过同一个选择（`fmtUsd(undefined)` → `—`、
   * 熔断读数缺失就不渲染那一行），这一列不能是例外。
   */
  assert.equal(marginModeLabel('cross'), '全仓');
  assert.equal(marginModeLabel('isolated'), '逐仓');

  for (const missing of [undefined, null, '', 'CROSSED', 'crossed', 'both', 'hedge']) {
    assert.equal(
      marginModeLabel(missing),
      '—',
      `${JSON.stringify(missing)} 必须显示 —：认不出不等于全仓（crossed 是服务端该收口的写法，` +
        '漏到这里也只说明上游没归一，不能替它猜）',
    );
  }
});

test('★ orderMarginMode：落库值优先于当前持仓，且必须说清值是哪来的', () => {
  /*
   * 两个来源的口径**不同**，所以返回值必须带 `source`：
   *
   *   · `'order'`   —— `orders.margin_type`，下单当时的快照，能当历史证据；
   *   · `'position'` —— 当前持仓实时读到的账户配置，**回答不了"那张单当时是什么模式"**。
   *
   * 界面据此写不同的悬停说明。少了这个字段，以后一定会有人拿兜底值当历史证据。
   */
  const live = new Map([['BTCUSDT', 'cross']]);

  // ① 落库值优先 —— 即使当前持仓说的是另一个模式（那张单下完之后模式被改过）。
  assert.deepEqual(
    orderMarginMode({ symbol: 'BTCUSDT', marginType: 'isolated' }, live),
    { mode: 'isolated', source: 'order' },
    '落库的历史快照必须优先：当前持仓说的是"现在"，回答不了"这张单当时"',
  );

  // ② 落库缺失 → 用当前持仓兜底，并且**标出来源**是 position。
  assert.deepEqual(
    orderMarginMode({ symbol: 'BTCUSDT', marginType: undefined }, live),
    { mode: 'cross', source: 'position' },
  );
  assert.deepEqual(orderMarginMode({ symbol: 'BTCUSDT' }, live), { mode: 'cross', source: 'position' });

  // ③ 两个来源都没有 / 都不是合法机器码 → null（界面 `—`），不是"全仓"。
  assert.equal(orderMarginMode({ symbol: 'ETHUSDT' }, live), null, '该标的没有持仓，就没有兜底');
  assert.equal(orderMarginMode({ symbol: 'BTCUSDT' }, undefined), null, '没有兜底来源时不能凭空给值');
  assert.equal(orderMarginMode({ symbol: 'BTCUSDT' }, new Map()), null);
  assert.equal(
    orderMarginMode({ symbol: 'BTCUSDT', marginType: 'crossed' }, new Map([['BTCUSDT', 'CROSSED']])),
    null,
    '两边都是没收口的写法时一律当"不知道" —— 前端不该替上游归一，更不该猜',
  );
});
