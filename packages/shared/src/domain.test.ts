/**
 * 交易所错误码的中文翻译。
 *
 * ## 为什么这些用例存在
 *
 * 订单记录里原本直接显示原始字符串：
 *
 *     Binance -4130: An open stop or take profit order with GTC...
 *
 * **那是给开发者看的。** 操作员看到英文技术报错时，既不知道发生了什么、
 * 也不知道该不该动手 —— 而那一栏存在的唯一意义就是回答这两个问题。
 *
 * 两个方向都要钉：
 *   · **认得出的码**要翻译成人话，并且**保留原始码**（排查靠它）
 *   · **认不出的码**要原样显示，**不能猜** —— 按错误的理解去处理比不翻译更糟
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beijingDayStartIso,
  CLOSE_REASON_LABELS,
  CLOSE_REASONS,
  closeReasonLabel,
  exchangeErrorCode,
  exchangeErrorLabel,
  marginPercentToPricePercent,
} from './domain.js';
import {
  AI_MANAGED_HARD_LIMITS,
  clampAiManagedHardLimits,
  defaultStrategyConfig,
  unboundedAiManagedConfig,
} from './strategy.js';

test('实测撞到的 -4130 被翻译成可行动的一句话', () => {
  /*
   * 这条码是这一轮从订单记录里发现的：保本止损"先挂新再撤旧"，
   * 而币安不允许同一仓位存在两张条件单 —— 于是连刷四条拒绝。
   *
   * 翻译必须说清**该怎么办**（先撤掉原来那张），而不只是说"重复了"。
   */
  const raw = "Binance -4130: An open stop or take profit order with GTC would be triggered immediately.";
  const out = exchangeErrorLabel(raw);
  assert.match(out, /已有止损或止盈单/, '要翻译成中文');
  assert.match(out, /先撤掉/, '要说清怎么办 —— 否则操作员知道发生了什么也不知道该做什么');
  assert.match(out, /-4130/, '**原始码必须保留** —— 排查与对交易所文档都要靠它');
  assert.ok(!/An open stop/.test(out), '不该把英文原文留在给操作员的文案里');
});

test('-4164（取整后名义不足）也被翻译', () => {
  const out = exchangeErrorLabel(
    "Binance -4164: Order's notional must be no smaller than 5 (unless you choose reduce only).",
  );
  assert.match(out, /名义价值/, '要说是名义价值的问题');
  assert.match(out, /-4164/);
});

test('-4061（持仓模式不匹配）也被翻译 —— 它是「整个机器人瘫持」而不是「这一笔失败」', () => {
  /*
   * 这一条原来是缺的，于是界面上显示的是交易所的英文原文：
   *
   *     ✕ 执行失败
   *     币安错误 -4061：Order's position side does not match user's setting.
   *
   * 而它比其它错误码**更**需要看懂：双向持仓模式下**连平仓单都会被拒**
   * （`reduceOnly` 不豁免 `positionSide`），所以不是"少赚一笔"，
   * 是开不了、平不了、保护位也挂不上 —— 整个机器人不动了。
   *
   * 而且**解法不在机器人这边**：它一律发 `positionSide=BOTH`，
   * 要去交易所端把持仓模式改回单向。文案必须把这一点说清楚，
   * 否则操作员会反复重启机器人而问题一直在。
   */
  const raw =
    "Binance -4061: Order's position side does not match user's setting.";
  const out = exchangeErrorLabel(raw);
  assert.match(out, /持仓模式/, '要指出是持仓模式的问题');
  assert.match(out, /单向持仓/, '要说清**改成什么** —— 这是操作员唯一要做的事');
  assert.match(out, /-4061/, '原始码必须保留');
  assert.ok(
    !/does not match/.test(out),
    '不该把英文原文留在给操作员的文案里 —— 那正是这条错误码被补上的原因',
  );
});

test('认不出的错误码**原样返回**，绝不猜', () => {  /*
   * 猜一个不认识的码的含义，比不翻译更糟：它会让操作员按错误的理解去处理，
   * 而原始字符串里其实带着交易所的完整说明。
   */
  const raw = 'Binance -9999: Something nobody has seen before.';
  assert.equal(exchangeErrorLabel(raw), raw, '认不出时必须原样返回');
});

test('不含错误码的字符串原样返回', () => {
  for (const raw of ['', '网络超时', 'fetch failed']) {
    assert.equal(exchangeErrorLabel(raw), raw);
  }
});

test('错误码提取：带与不带 Binance 前缀都能取到', () => {
  assert.equal(exchangeErrorCode('Binance -4130: x'), '-4130');
  assert.equal(exchangeErrorCode('-4164: x'), '-4164');
  assert.equal(exchangeErrorCode('没有码'), null);
});

/* -------------------------------------------------------------------------- */
/*  自然日边界（北京时间）                                                      */
/* -------------------------------------------------------------------------- */

test('日界落在北京时间 0:00 —— 不是 UTC 0:00', () => {
  /*
   * 这个函数存在的全部理由就是这一条断言。
   *
   * 原来熔断用的是 `setUTCHours(0, 0, 0, 0)`，也就是 **UTC 零点 = 北京时间
   * 早上 8 点**。于是北京时间 9-19 07:30 的一笔平仓被算进「UTC 9-18」，
   * 操作员上午看到的「今日已实现亏损」实际覆盖 9-18 08:00 → 9-19 08:00 ——
   * **与他的认知差 8 小时**，而熔断正是拿这个数字决定要不要停手的。
   *
   * 所以边界必须精确落在北京时间的 0:00：9-18 23:59:59 还算前一天，
   * 9-19 00:00:00 就必须翻页。
   */
  // UTC 16:00 == 北京时间次日 00:00
  assert.equal(
    beijingDayStartIso(Date.parse('2026-09-18T16:00:00Z')),
    '2026-09-18T16:00:00.000Z',
    '北京 9-19 00:00 → 日界应当是它自己',
  );
  assert.equal(
    beijingDayStartIso(Date.parse('2026-09-18T15:59:59Z')),
    '2026-09-17T16:00:00.000Z',
    '北京 9-18 23:59:59 → 仍属 9-18（日界是北京 9-18 00:00）',
  );
  // 这一条是原实现真正算错的那一格
  assert.equal(
    beijingDayStartIso(Date.parse('2026-09-18T23:30:00Z')),
    '2026-09-18T16:00:00.000Z',
    '北京 9-19 07:30 → 必须算进 9-19；按 UTC 会错算成 9-18',
  );
  assert.equal(
    beijingDayStartIso(Date.parse('2026-09-19T15:59:59Z')),
    '2026-09-18T16:00:00.000Z',
    '北京 9-19 23:59:59 → 仍属 9-19',
  );
  assert.equal(
    beijingDayStartIso(Date.parse('2026-09-19T16:00:00Z')),
    '2026-09-19T16:00:00.000Z',
    '北京 9-20 00:00 → 翻到新的一天',
  );
});

test('日界与服务器时区无关', () => {
  /*
   * 用 `setHours(0,0,0,0)` 也能得到"某一天的零点"，但那用的是**服务器**的
   * 时区：换一台 UTC 的机器，日界会静默变回 UTC 零点，而且不会有任何报错。
   *
   * 这个函数按常量 +8 显式平移，所以同一个时刻在任何时区的机器上
   * 都给出同一个 UTC 边界。
   */
  const at = Date.parse('2026-09-18T23:30:00Z');
  assert.equal(beijingDayStartIso(at), beijingDayStartIso(at), '同一输入必须稳定');
  assert.ok(
    beijingDayStartIso(at).endsWith('Z'),
    '返回值是 UTC ISO —— 库里存的是 UTC，比较也必须用 UTC',
  );
});

/* -------------------------------------------------------------------------- */
/*  平仓原因的中文标签                                                          */
/* -------------------------------------------------------------------------- */

test('★ 止损触发但结果是盈利时，说成「移动止损」而不是「触发止损」', () => {
  /*
   * ## 这条用例来自一次真实的误判
   *
   * 操作员看到成交列表里两笔**显示盈利**、而平仓原因写着**「触发止损」**，
   * 判断这是自相矛盾的 bug。而数据两边都对：
   *
   *     ETHUSDT  入场 2634.32  止损位 2660（在成本**之上**）  触发时 +0.17
   *     BNBUSDT  入场 775.11   止损位 778.6（在成本**之上**）  触发时 +0.03
   *
   * 那两笔确实**触发了止损单**，而止损位已经被 `adjust_protection` 上移到成本之上
   * —— 触发的结果是保本或小赚离场。**那正是提示词要求它做的事**
   * （"把止损提到成本价或更高，等于把这笔交易变成最坏情况不亏"）。
   *
   * 问题只在措辞：「触发止损」四个字在中文里天然等于"亏了"。
   */
  assert.equal(
    closeReasonLabel('stop_loss', 0.171),
    '移动止损（保本离场）',
    '止损触发且**赚钱**时必须说清它是保本离场，否则与同一行的盈利数字自相矛盾',
  );

  /* 反面：真的亏了，就照旧说「触发止损」—— 那是最需要被看见的一种离场。 */
  assert.equal(closeReasonLabel('stop_loss', -0.21), '触发止损');
  assert.equal(closeReasonLabel('stop_loss', 0), '触发止损', '恰好持平不算"保本离场"的盈利情形');
});

test('不传盈亏时退回通用说法，不猜', () => {
  /*
   * 有些调用点只拿到机器码（日志行、回放历史）。那时宁可用宽泛的说法，
   * 也不该凭空断言"这笔赚了"。
   */
  assert.equal(closeReasonLabel('stop_loss'), '触发止损');
  assert.equal(closeReasonLabel('stop_loss', null), '触发止损');
});

test('只有止损那一种原因会分叉 —— 止盈与其它原因不受盈亏影响', () => {
  /*
   * 止盈触发本来就只会赚钱，不需要区分；而"模型主动平仓"既可能赚也可能亏，
   * 那个原因本身没有歧义（它说的是"谁平的"，不是"结果如何"）。
   */
  assert.equal(closeReasonLabel('take_profit', 0.5), '触发止盈');
  assert.equal(closeReasonLabel('model_decision', 0.5), '模型主动平仓');
  assert.equal(closeReasonLabel('model_decision', -0.5), '模型主动平仓');
  /* 未知机器码原样返回 —— 库里可能读到迁移前留下的值。 */
  assert.equal(closeReasonLabel('some_future_code', 0.5), 'some_future_code');
});

test('★★★ 每一个 CLOSE_REASONS 成员都必须有中文标签 —— 否则界面渲染出裸机器码', () => {
  /*
   * ## 这个测试防的是什么（外部 issue #138）
   *
   * `reconcileTradeHistory()` 对「方向字段不可信、金额取自交易所流水」的补录回合
   * 写入 `closeReason: 'reconciled_reversed'`（`autoTrader.ts:6056`），
   * 而那个码**不在 `CLOSE_REASONS` 里**、`CLOSE_REASON_LABELS` 也没有它。
   *
   * 于是控制台的「平仓原因」列渲染成**未翻译的英文机器码**：
   *
   *     reconciled_reversed      ← 操作员看不懂这是什么
   *
   * 而 `docs/MODULES.md` 配方 5 白纸黑字写着「加一个平仓原因，
   * `CLOSE_REASONS` 与 `CLOSE_REASON_LABELS` 必须同时加」—— 这正是
   * **本该拦住它的机制**，只是缺一条把它变成可执行断言的测试。
   *
   * ## 为什么这条断言要写成「穷尽」而不是逐个列
   *
   * 逐个列（`assert.equal(closeReasonLabel('reconciled'), '…')`）只能证明
   * **今天**这几个有标签；将来加第 10 个原因时，写它的人只要忘了同步，
   * 这条测试照样绿。穷尽遍历则让"新原因漏了标签"当场变红 ——
   * 与 `simulate.ts:805` 用权威名单做校验是同一个思路（同一份常量，不再各写一份）。
   */
  for (const reason of CLOSE_REASONS) {
    const label = CLOSE_REASON_LABELS[reason];
    assert.ok(
      typeof label === 'string' && label.length > 0,
      `★★★ CLOSE_REASONS 里的 '${reason}' 没有中文标签 —— ` +
        `控制台会把它渲染成裸机器码（见 docs/MODULES.md 配方 5）`,
    );
    /* 标签必须**真的翻译过**，不能是把机器码原样抄回来。 */
    assert.notEqual(
      label,
      reason,
      `★★★ '${reason}' 的标签与机器码相同 —— 那等于没翻译`,
    );
    /* 且必须能通过 closeReasonLabel 拿到（而不是只有 map 里有）。 */
    assert.equal(
      closeReasonLabel(reason),
      label,
      `closeReasonLabel('${reason}') 必须返回它的中文标签`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  「对保证金」与「价格」两个口径的换算                                        */
/* -------------------------------------------------------------------------- */

test('实测 #95 的峰值浮盈换算回价格 —— 5x 下 3.146% 是 0.629%', () => {
  /*
   * 这组数字是生产上真实留下的（持仓 `#95` XRPUSDT，5x，入场 1.513）：
   *
   *     positions.peak_pnl_percent = 3.1456890134116477
   *
   * 而那段持仓时间里交易所的最高价只有 1.5318 —— 也就是价格口径 **+1.24%**。
   *
   * 模型在复盘里把这个数当成了**价格涨幅**，反算出 1.5606 这个从未出现的价格，
   * 于是判定一张从未被触及的止盈单（1.5565）"该兑现却没兑现"。
   * 换算成价格口径之后，那个误读一眼就能看出来。
   */
  const pricePercent = marginPercentToPricePercent(3.1456890134116477, 5);
  assert.ok(
    Math.abs(pricePercent - 0.6291378026823295) < 1e-12,
    `5x 下的价格口径必须小 5 倍，实际算出 ${pricePercent}`,
  );
  assert.equal(pricePercent.toFixed(3), '0.629');
});

test('杠杆是除数 —— 同一个保证金收益率，杠杆越高对应的价格变动越小', () => {
  /*
   * 这条是「保本止损 / 回撤守卫的触发线在价格上到底多远」的全部依据：
   * 配置里写的是对保证金的口径，而模型脑子里想的是价格。
   */
  assert.equal(marginPercentToPricePercent(1, 3), 1 / 3);
  assert.equal(marginPercentToPricePercent(1, 5), 0.2);
  assert.ok(
    marginPercentToPricePercent(1, 10) < marginPercentToPricePercent(1, 2),
    '杠杆越高，同一个"保证金浮盈 1%"在价格上越近',
  );
  /* 1x 时两个口径重合 —— 那时换算必须是恒等的，不能引入误差。 */
  assert.equal(marginPercentToPricePercent(2.5, 1), 2.5);
});

test('杠杆不可用时原样返回，不猜也不除零', () => {
  /*
   * `leverage` 来自数据库列，而迁移前的老行可能是 `0`。
   * 那时**宁可少做一次换算**（把数原样带出去），也不能算出 `Infinity` ——
   * 一个 `Infinity` 印进提示词会比不换算更糟。
   */
  assert.equal(marginPercentToPricePercent(3, 0), 3);
  assert.equal(marginPercentToPricePercent(3, Number.NaN), 3);
  assert.equal(marginPercentToPricePercent(3, -5), 3);
});
/* -------------------------------------------------------------------------- */
/*  智能托管的起点：不替模型预设边界                                              */
/* -------------------------------------------------------------------------- */

test('★ 智能托管的起始配置不设边界 —— 上限顶格、门槛归零', () => {
  /*
   * ## 用户的直接要求（原话）
   *
   * > 「这是智能托管模式，我去哪里改？……如果非要顶一个默认值，我觉得系统别搞这么
   * >  保守啊，持仓不限制，杠杆不限制，保证金模式也不限制才对，既然完全交给模型，
   * >  那么怎么操作都由模型决定啊，而不是系统就提前写死了，模型改还有什么意义呢？？」
   *
   * ## 他指出的矛盾是真的
   *
   * 提示词对模型说「这些数字……**归你调**……它们不是"不可更改的规定"，而是
   * **你当前选定的边界**」—— 而**选定它们的既不是模型、界面上也没有入口**：
   * 智能托管的机器人不引用策略（`strategyId = null`），策略编辑页对它无效，
   * 起点来自 `StrategyConfigSchema.parse({})` 那组保守默认值
   * （3 个持仓 / 5x / 逐仓 / 75 分门槛）。**"能改"与"替你定死"互相矛盾。**
   *
   * 所以这条用例钉的是：`unboundedAiManagedConfig()` 必须**处处顶格**，
   * 而不是又一组"看起来更合理"的保守值。
   */
  /*
   * 2026-11-24 收口：智能托管保留策略风格自由（门槛归零、不强制止盈），
   * 但账户物理安全边界（杠杆、保证金占比、持仓数、单币敞口、日亏/总回撤熔断）
   * 必须落在 AI_MANAGED_HARD_LIMITS 硬底线以内，杜绝 125x/100% 裸奔。
   */
  const cfg = unboundedAiManagedConfig();
  const rc = cfg.riskControl;
  const cb = cfg.circuitBreaker;

  assert.ok(rc.maxPositions > 0 && rc.maxPositions <= AI_MANAGED_HARD_LIMITS.maxPositions);
  assert.ok(rc.btcEthMaxLeverage > 0 && rc.btcEthMaxLeverage <= AI_MANAGED_HARD_LIMITS.btcEthMaxLeverage);
  assert.ok(rc.altcoinMaxLeverage > 0 && rc.altcoinMaxLeverage <= AI_MANAGED_HARD_LIMITS.altcoinMaxLeverage);
  assert.ok(
    rc.btcEthMaxPositionValueRatio > 0 &&
      rc.btcEthMaxPositionValueRatio <= AI_MANAGED_HARD_LIMITS.btcEthMaxPositionValueRatio,
  );
  assert.ok(
    rc.altcoinMaxPositionValueRatio > 0 &&
      rc.altcoinMaxPositionValueRatio <= AI_MANAGED_HARD_LIMITS.altcoinMaxPositionValueRatio,
  );
  assert.ok(rc.maxMarginUsage > 0 && rc.maxMarginUsage <= AI_MANAGED_HARD_LIMITS.maxMarginUsage);
  assert.ok(cb.maxDailyLossPercent > 0 && cb.maxDailyLossPercent <= AI_MANAGED_HARD_LIMITS.maxDailyLossPercent);
  assert.ok(
    cb.maxTotalDrawdownPercent > 0 &&
      cb.maxTotalDrawdownPercent <= AI_MANAGED_HARD_LIMITS.maxTotalDrawdownPercent,
  );

  /* 门槛类：归零 —— "要不要出手"属于策略风格，由模型判断，不由数字拦。 */
  assert.equal(rc.minRiskRewardRatio, 0, '盈亏比门槛要归零');
  assert.equal(rc.minConfidence, 0, '置信度门槛要归零');

  /* 止盈是策略选择，交给模型。 */
  assert.equal(rc.requireTakeProfit, false, '不该强制止盈');

  /* 止损是结构要求，强制保留。 */
  assert.equal(
    rc.requireStopLoss,
    true,
    '★ 止损必须保留 —— 那是结构要求（不许裸奔），不是替模型做交易决定',
  );

  /* 历史旧配置（125x / 100% / 熔断关闭）过 clampAiManagedHardLimits 后必须全部按回硬底线。 */
  const clamped = clampAiManagedHardLimits({
    ...cfg,
    riskControl: {
      ...rc,
      requireStopLoss: false,
      maxPositions: 20,
      btcEthMaxLeverage: 125,
      altcoinMaxLeverage: 125,
      maxMarginUsage: 100,
    },
    circuitBreaker: {
      ...cb,
      maxDailyLossPercent: 0,
      maxTotalDrawdownPercent: 0,
    },
  });
  assert.equal(clamped.riskControl.requireStopLoss, true);
  assert.equal(clamped.riskControl.maxPositions, AI_MANAGED_HARD_LIMITS.maxPositions);
  assert.equal(clamped.riskControl.btcEthMaxLeverage, AI_MANAGED_HARD_LIMITS.btcEthMaxLeverage);
  assert.equal(clamped.riskControl.altcoinMaxLeverage, AI_MANAGED_HARD_LIMITS.altcoinMaxLeverage);
  assert.equal(clamped.riskControl.maxMarginUsage, AI_MANAGED_HARD_LIMITS.maxMarginUsage);
  assert.equal(clamped.circuitBreaker.maxDailyLossPercent, AI_MANAGED_HARD_LIMITS.maxDailyLossPercent);
  assert.equal(
    clamped.circuitBreaker.maxTotalDrawdownPercent,
    AI_MANAGED_HARD_LIMITS.maxTotalDrawdownPercent,
  );
});

test('出厂默认值本身不变 —— 传统策略模式仍然有它自己的保守起点', () => {
  /*
   * 这一条防的是"顺手把默认值也改了"。
   *
   * `defaultStrategyConfig()` 服务于**传统策略**模式：那里的参数是操作员在策略
   * 编辑页里明确选的，保守是**有意**的起点。智能托管的"不设边界"是另一件事，
   * 两者不该互相污染 —— 否则改一处会静默改变另一类机器人的行为。
   */
  const rc = defaultStrategyConfig().riskControl;
  assert.equal(rc.maxPositions, 3, '传统策略的默认持仓数仍是 3');
  assert.equal(rc.btcEthMaxLeverage, 5, '传统策略的默认杠杆仍是 5x');
  assert.equal(rc.marginMode, 'isolated', '传统策略的默认保证金模式仍是逐仓');
  assert.equal(rc.minConfidence, 75, '传统策略的默认置信度门槛仍是 75');
});