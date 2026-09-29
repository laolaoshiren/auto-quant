import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankPlatformHistory, type PlatformTradeLike } from './platformHistory.js';

/* -------------------------------------------------------------------------- */
/*  本平台历史榜                                                                 */
/* -------------------------------------------------------------------------- */

const t = (symbol: string, netPnl: number): PlatformTradeLike => ({ symbol, netPnl });

test('★ 本平台历史榜：告诉模型"我在哪些标的上真的赚过、哪些上总是亏"', () => {
  /*
   * ## 为什么这个维度只有平台能做
   *
   * 交易所给的是**市场数据**（价格、成交额、持仓量）。而"**我**在这个标的上做过几笔、
   * 结果如何"是**本平台自己的历史** —— 没有任何外部接口能提供它。
   *
   * ## 为什么两个方向都要给
   *
   * 只列"我赚过的"会让模型反复扑向同一个标的（可能是运气）；
   * 而"**我在这个标的上总是亏**"同样是有用的信号 —— 它可能意味着这个标的的
   * 波动特性与当前策略不合（例如止损总是被扫）。
   */
  const rows = rankPlatformHistory({
    trades: [
      /* SOL：3 笔，2 胜 1 负，净 +0.7 */
      t('SOLUSDT', 0.5),
      t('SOLUSDT', 0.3),
      t('SOLUSDT', -0.1),
      /* BNB：3 笔全负，净 -0.6 */
      t('BNBUSDT', -0.3),
      t('BNBUSDT', -0.2),
      t('BNBUSDT', -0.1),
      /* 只做过 1 笔 —— 样本太少，胜率没有意义，必须被门槛滤掉 */
      t('ONCEUSDT', 9),
    ],
    minTrades: 3,
    limit: 4,
  });

  assert.equal(rows.length, 2, '只做过 1 笔的标的不得入榜');
  assert.deepEqual(
    rows.map((r) => r.symbol),
    ['SOLUSDT', 'BNBUSDT'],
    '按净额降序 —— 赚得最多的在最前，亏得最多的在最后',
  );

  const sol = rows.find((r) => r.symbol === 'SOLUSDT')!;
  assert.equal(sol.trades, 3);
  assert.ok(Math.abs(sol.netPnl - 0.7) < 1e-9, `SOL 净额应为 +0.7，实得 ${sol.netPnl}`);
  assert.ok(Math.abs(sol.winRate - 2 / 3) < 1e-9, `SOL 胜率应为 2/3，实得 ${sol.winRate}`);

  const bnb = rows.find((r) => r.symbol === 'BNBUSDT')!;
  assert.equal(bnb.winRate, 0, '全负的胜率是 0');
  assert.ok(Math.abs(bnb.netPnl + 0.6) < 1e-9);
});

test('★ 每行都带笔数 —— 样本量是"这个胜率可不可信"的唯一线索', () => {
  /*
   * 3 笔里 2 胜（67%）与 30 笔里 20 胜（67%）**完全不是一回事**。
   * 只给胜率而不给笔数，会让模型把噪声当规律 —— 那正是"过度拟合自己的历史"。
   */
  const rows = rankPlatformHistory({
    trades: [
      ...Array.from({ length: 10 }, () => t('BIGUSDT', 0.1)),
      ...Array.from({ length: 3 }, () => t('SMALLUSDT', 0.1)),
    ],
    minTrades: 3,
    limit: 10,
  });
  assert.equal(rows.find((r) => r.symbol === 'BIGUSDT')!.trades, 10);
  assert.equal(rows.find((r) => r.symbol === 'SMALLUSDT')!.trades, 3, '样本量必须如实给出');
});

test('没有足够样本时返回空榜，而不是编一个"胜率 100%"出来', () => {
  const rows = rankPlatformHistory({
    trades: [t('AUSDT', 1), t('BUSDT', 1)],
    minTrades: 3,
    limit: 5,
  });
  assert.equal(rows.length, 0, '都不够门槛时给空数组，让上层决定怎么交代');
});

test('空历史返回空榜', () => {
  assert.equal(rankPlatformHistory({ trades: [], minTrades: 3, limit: 5 }).length, 0);
});

test('limit 截断时优先保留两端（最赚的与最亏的），而不是只留最赚的', () => {
  /*
   * 截断逻辑是有意的：净额排序后取**前 limit/2 与后 limit/2**。
   * 只留头部会让模型看不见"我在这里总是亏"——而那恰恰是最该避开的地方。
   */
  const rows = rankPlatformHistory({
    trades: [
      ...Array.from({ length: 3 }, () => t('WIN1USDT', 1)),
      ...Array.from({ length: 3 }, () => t('WIN2USDT', 0.5)),
      ...Array.from({ length: 3 }, () => t('MIDUSDT', 0)),
      ...Array.from({ length: 3 }, () => t('LOSE1USDT', -0.5)),
      ...Array.from({ length: 3 }, () => t('LOSE2USDT', -1)),
    ],
    minTrades: 3,
    limit: 4,
  });
  const symbols = rows.map((r) => r.symbol);
  assert.ok(symbols.includes('WIN1USDT'), '最赚的要在');
  assert.ok(symbols.includes('LOSE2USDT'), '★ 最亏的也要在 —— 那是"该避开哪里"');
  assert.equal(rows.length, 4);
});
