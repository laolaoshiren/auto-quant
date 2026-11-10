/**
 * GateMarket 的解析与形状测试（mock GateRest，不碰网络）。
 *
 * ## 夹具来源：**测试网实测响应**，不是从文档抄的
 *
 * 下面每个 `REAL_*` 常量都是 2026-11-11 直接请求 Gate **测试网**公开端点得到的
 * 截断版（只保留本项目映射用到的字段）。这条纪律见 docs/AGENTS.md §3.3：
 * 交易所的字段名与形状必须对着真实环境核对，不能靠推理 ——
 * 而这里刚好抓到一个真实差异：**期货 candlesticks 返回的是对象 `{t,v,c,h,l,o,sum}`，
 * 不是现货那种数组**（文件头注释与 `gateCandleToKline` 都记了这一条）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GateContractRegistry } from './account.js';
import {
  GATE_FUNDING_RATE_MAX_LIMIT,
  GATE_KLINE_MAX_LIMIT,
  GateMarket,
  gateCandleToKline,
  gateIntervalOf,
  gateIntervalMs,
  gateTickerToBinance,
  toGateContractInfo,
  type GateCandleObject,
  type GateContractRaw,
  type GateTickerRaw,
} from './market.js';
import type { GateMarketPort } from './connection.js';
import type { GateRest } from './rest.js';

/**
 * **编译期接线守卫**：`GateMarket` 必须能直接当作 `connection.ts` 的行情端口。
 *
 * `GateMarketPort` 是 `Pick<BinanceMarketData, 6 个公共方法>`（见 `connection.ts`），
 * 这一行让"方法名/参数/返回类型对不上"在 `tsc` 阶段就报错，而不是等 manager 接线时
 * 才发现（那时错误会表现成运行时 undefined/形状不符）。
 * 纯类型断言，运行时不执行。
 */
const _assertGateMarketPort: (market: GateMarket) => GateMarketPort = (market) => market;
void _assertGateMarketPort;

/* -------------------------------------------------------------------------- */
/*  Real testnet fixtures (truncated, 2026-11-11)                              */
/* -------------------------------------------------------------------------- */

/** `/futures/usdt/tickers?contract=BTC_USDT`（实测原样，字段顺序未改）。 */
const REAL_TICKER: GateTickerRaw = {
  last: '73940.4',
  low_24h: '71697.3',
  high_24h: '77876',
  volume_24h: '89131760',
  change_percentage: '-3.95',
  change_price: '-3037',
  funding_rate_indicative: '0.0001',
  index_price: '73975',
  volume_24h_base: '8912',
  volume_24h_quote: '658846116',
  contract: 'BTC_USDT',
  volume_24h_settle: '658846116',
  funding_rate: '0.0001',
  mark_price: '73945.68',
  total_size: '60457802232',
  highest_bid: '73947',
  lowest_ask: '73947.1',
  quanto_multiplier: '0.0001',
} as GateTickerRaw;

/** `/futures/usdt/contracts/BTC_USDT`（实测；只保留映射用到的字段）。 */
const REAL_CONTRACT = {
  name: 'BTC_USDT',
  status: 'trading',
  in_delisting: false,
  quanto_multiplier: '0.0001',
  order_price_round: '0.1',
  order_size_min: 1,
  order_size_max: 1000000,
  leverage_max: '125',
  taker_fee_rate: '0.00075',
  maker_fee_rate: '-0.0001',
  funding_next_apply: 1794355200,
  interest_rate: '0.0003',
  position_size: 30228906096,
  // 实测响应里**没有** order_size_step —— 期货张数恒为整数。
};

/** `/futures/usdt/contracts`（两个合约：一个正常、一个已下线）。 */
const REAL_CONTRACTS = [
  REAL_CONTRACT,
  {
    name: 'OLD_USDT',
    status: 'delisted',
    in_delisting: true,
    quanto_multiplier: '1',
    order_price_round: '0.001',
    order_size_min: 1,
    order_size_max: 1000,
    leverage_max: '10',
    funding_next_apply: 0,
    interest_rate: '0',
    position_size: 0,
  },
];

/** `/futures/usdt/candlesticks?contract=BTC_USDT&interval=5m&limit=3`（实测原样）。 */
const REAL_CANDLES: GateCandleObject[] = [
  { o: '73949.1', v: 52754, t: 1794345600, c: '73899.1', l: '73880.8', h: '73961.2', sum: '389929.55253' },
  { o: '73901.1', v: 37952, t: 1794345900, c: '73940.4', l: '73881.2', h: '73956.4', sum: '280521.76741' },
  { o: '73941.4', v: 2210, t: 1794346200, c: '73937.5', l: '73931.2', h: '73941.4', sum: '16339.94456' },
];

/** `/futures/usdt/funding_rate?contract=BTC_USDT&limit=3`（实测原样）。 */
const REAL_FUNDING = [
  { r: '0.0001', t: 1794326400 },
  { r: '0.0001', t: 1794297600 },
  { r: '0.0001', t: 1794268800 },
];

/* -------------------------------------------------------------------------- */
/*  Mock GateRest                                                              */
/* -------------------------------------------------------------------------- */

interface FakeRoutes {
  tickers?: unknown;
  contracts?: unknown;
  candlesticks?: unknown;
  fundingRate?: unknown;
}

/**
 * 只实现 `publicGet`。`signed` 一调用就抛 —— 行情层**永远不该发签名请求**，
 * 这条断言能抓住"顺手用 signed 取行情"的接线错误。
 */
function fakeRest(routes: FakeRoutes) {
  const calls: Array<{ path: string; params?: Record<string, unknown> }> = [];
  const rest = {
    async publicGet(path: string, params?: Record<string, unknown>) {
      calls.push({ path, ...(params === undefined ? {} : { params }) });
      switch (path) {
        case '/futures/usdt/tickers':
          return routes.tickers;
        case '/futures/usdt/contracts':
          if (routes.contracts instanceof Error) throw routes.contracts;
          return routes.contracts;
        case '/futures/usdt/candlesticks':
          return routes.candlesticks;
        case '/futures/usdt/funding_rate':
          return routes.fundingRate;
        default:
          throw new Error(`unexpected public path: ${path}`);
      }
    },
    async signed() {
      throw new Error('GateMarket 不应调用签名接口');
    },
  } as unknown as GateRest;
  return { rest, calls };
}

function marketOf(routes: FakeRoutes) {
  const { rest, calls } = fakeRest(routes);
  const registry = new GateContractRegistry(rest);
  const market = new GateMarket(rest, registry);
  return { market, calls, registry };
}

function callsTo(calls: Array<{ path: string }>, path: string): number {
  return calls.filter((c) => c.path === path).length;
}

/* -------------------------------------------------------------------------- */
/*  Interval mapping                                                           */
/* -------------------------------------------------------------------------- */

test('★★ 周期映射：支持的周期原样透传，不支持的**必须报错**（不能就近近似）', () => {
  for (const tf of ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const) {
    assert.equal(gateIntervalOf(tf), tf);
  }
  assert.equal(gateIntervalMs('5m'), 300_000);
  assert.equal(gateIntervalMs('4h'), 14_400_000);

  /*
   * 2h/6h/12h/3m 不在 Gate 期货支持列表里。**不能**映射成 4h/1h：
   * 那会让同一个策略在两个交易所上算不同周期的指标，而界面上完全看不出来。
   */
  for (const tf of ['3m', '2h', '6h', '12h'] as const) {
    assert.throws(
      () => gateIntervalOf(tf),
      (error: Error) => /Gate 期货不支持/.test(error.message) && /不要用其他周期近似/.test(error.message),
      `${tf} 必须明确报错`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  Candle parsing                                                             */
/* -------------------------------------------------------------------------- */

test('★★★ K 线对象形状：v 是**张数**，乘 quanto_multiplier 才是币数', () => {
  const kline = gateCandleToKline(REAL_CANDLES[0]!, { intervalMs: 300_000, quantoMultiplier: 0.0001 });
  assert.ok(kline);
  assert.equal(kline!.openTime, 1_794_345_600_000, 'Gate 的 t 是秒 → 毫秒');
  assert.equal(kline!.closeTime, 1_794_345_600_000 + 300_000, 'Gate 不给 closeTime，由周期补');
  assert.equal(kline!.open, 73949.1);
  assert.equal(kline!.high, 73961.2);
  assert.equal(kline!.low, 73880.8);
  assert.equal(kline!.close, 73899.1);
  assert.equal(
    kline!.volume,
    52_754 * 0.0001,
    '实测 v=52754 张 × 0.0001 = 5.2754 币；直接拿 52754 当币数会差 10000 倍',
  );
  assert.equal(kline!.quoteVolume, 389_929.55253, 'sum 是 USDT 成交额');
  /* Gate 期货 K 线没有这些字段：给 0，不编。 */
  assert.equal(kline!.trades, 0);
  assert.equal(kline!.takerBuyBase, 0);
  assert.equal(kline!.takerBuyQuote, 0);
});

test('★★ 兼容 Gate 现货数组形状（[ts, quoteVolume, close, high, low, open, baseVolume]）', () => {
  /*
   * Lead 的任务描述里提到的是数组顺序（那是 Gate **现货** candlesticks 的格式）；
   * 期货实测返回对象。这里两种都接受：数组最后一项已经是**币数**，不再乘 multiplier。
   */
  const row: [number, ...Array<string | number>] = [
    1_794_345_600,
    389_929.55253,
    73_899.1,
    73_961.2,
    73_880.8,
    73_949.1,
    5.2754,
  ];
  const kline = gateCandleToKline(row, { intervalMs: 300_000, quantoMultiplier: 0.0001 });
  assert.ok(kline);
  assert.equal(kline!.volume, 5.2754, '数组形状的 baseVolume 已是币数，不能再乘 multiplier');
  assert.equal(kline!.quoteVolume, 389_929.55253);
  assert.equal(kline!.open, 73_949.1);
});

test('★★ 坏 K 线行返回 null（不用 0 填充 —— 0 价会污染所有指标）', () => {
  const base = { intervalMs: 300_000, quantoMultiplier: 0.0001 };
  assert.equal(gateCandleToKline({ t: 0, o: '1', h: '1', l: '1', c: '1', v: '1' }, base), null);
  assert.equal(
    gateCandleToKline({ t: 1_794_345_600, o: '0', h: '1', l: '1', c: '1', v: '1' } as GateCandleObject, base),
    null,
    'open=0 是坏数据',
  );
  assert.equal(
    gateCandleToKline({ t: 1_794_345_600, o: '1', h: '1', l: '1', v: '1' } as unknown as GateCandleObject, base),
    null,
    '缺 close 是坏数据',
  );
  assert.equal(
    gateCandleToKline([0, '100', '1', '1', '1', '1', '1'] as [number, ...Array<string | number>], base),
    null,
  );
});

/* -------------------------------------------------------------------------- */
/*  Klines through the class                                                   */
/* -------------------------------------------------------------------------- */

test('★★★ klines：合约命名转换 + 参数 + 升序 + 丢弃坏行', async () => {
  const broken = { t: 1_794_345_600, o: '0', h: '0', l: '0', c: '0', v: '0' };
  const { market, calls } = marketOf({
    contracts: REAL_CONTRACTS,
    candlesticks: [REAL_CANDLES[1]!, broken, REAL_CANDLES[0]!, REAL_CANDLES[2]!],
  });

  const rows = await market.klines('btcusdt', '5m', 3);

  const request = calls.find((c) => c.path === '/futures/usdt/candlesticks');
  assert.ok(request, '应当请求 candlesticks');
  assert.equal(request!.params?.contract, 'BTC_USDT', '本项目符号必须转成 Gate 合约名');
  assert.equal(request!.params?.interval, '5m');
  assert.equal(request!.params?.limit, 3);

  assert.equal(rows.length, 3, '坏行（o=0）必须被丢弃，而不是补 0');
  assert.deepEqual(
    rows.map((r) => r.openTime),
    [1_794_345_600_000, 1_794_345_900_000, 1_794_346_200_000],
    '返回必须按时间升序',
  );
  assert.equal(rows[0]!.volume, 5.2754, '成交量已经乘过 quanto_multiplier');
  /* 行情只走 publicGet：mock 的 signed 会抛，这里能跑通即为证明。 */
  assert.equal(callsTo(calls, '/futures/usdt/contracts'), 1, '合约信息读一次（registry 缓存）');
});

test('★★ limit 夹在 [1, 2000]（Gate 单次上限）', async () => {
  const { market, calls } = marketOf({ contracts: REAL_CONTRACTS, candlesticks: REAL_CANDLES });

  await market.klines('BTCUSDT', '5m', 5000);
  await market.klines('BTCUSDT', '5m', 0);

  const limits = calls
    .filter((c) => c.path === '/futures/usdt/candlesticks')
    .map((c) => c.params?.limit);
  assert.deepEqual(limits, [GATE_KLINE_MAX_LIMIT, 1]);
});

test('★★ K 线响应不是数组 → 抛错（不能当成"没有行情"）', async () => {
  const { market } = marketOf({ contracts: REAL_CONTRACTS, candlesticks: { message: 'bad gateway' } });
  await assert.rejects(
    () => market.klines('BTCUSDT', '5m', 3),
    (error: Error) => /返回的不是数组/.test(error.message) && /candlesticks/.test(error.message),
  );
});

test('★★ 合约信息不可用时：成交量由「成交额 ÷ 收盘价」反推，绝不能把张数当币数', async () => {
  /*
   * 张数当币数是这类接入最典型的静默错误：v=52754 张，直接当币数会差 10000 倍，
   * 而不抛错、只是"成交量"整列失真。合约信息读不到（短暂 5xx）时用成交额反推，
   * 量纲仍是对的（币数）。
   */
  const { market } = marketOf({ contracts: new Error('contracts 502'), candlesticks: REAL_CANDLES });
  const rows = await market.klines('BTCUSDT', '5m', 3);

  assert.equal(rows.length, 3, '合约信息失败不该让 K 线整体失败');
  const expected = 389_929.55253 / 73_899.1;
  assert.ok(Math.abs(rows[0]!.volume - expected) < 1e-9, '成交量 = 成交额 ÷ 收盘价');
  assert.ok(rows[0]!.volume < 10, '绝不能是 52754（张数）—— 那会差 10000 倍');
});

test('★★★ fetchClosedKlines：丢掉尚未收盘的那一根（指标只吃已收盘的）', async () => {
  /*
   * 用**动态时间戳**构造：这一条验的是"相对现在"的过滤，固定历史夹具测不了。
   * 价格/成交量用实测数值（不影响本用例的断言）。
   */
  const nowSec = Math.floor(Date.now() / 1000);
  const candle = (startSec: number): GateCandleObject => ({
    t: startSec,
    o: '73949.1',
    h: '73961.2',
    l: '73880.8',
    c: '73899.1',
    v: 52754,
    sum: '389929.55253',
  });
  const rows = [candle(nowSec - 900), candle(nowSec - 600), candle(nowSec - 100)];

  const { market, calls } = marketOf({ contracts: REAL_CONTRACTS, candlesticks: rows });
  const closed = await market.fetchClosedKlines('BTCUSDT', '5m', 3);

  assert.equal(closed.length, 2, '最后一根（closeTime 在未来）必须被丢掉');
  assert.ok(closed.every((k) => k.closeTime < Date.now()));
  const request = calls.find((c) => c.path === '/futures/usdt/candlesticks');
  assert.equal(request!.params?.limit, 4, '多取一根才能保证返回的数量够 limit');
});

test('★ 空 K 线响应 → 返回空数组（这是"没有数据"，不是错误）', async () => {
  const { market } = marketOf({ contracts: REAL_CONTRACTS, candlesticks: [] });
  assert.deepEqual(await market.fetchClosedKlines('BTCUSDT', '5m', 10), []);
});

/* -------------------------------------------------------------------------- */
/*  Tickers / premium                                                          */
/* -------------------------------------------------------------------------- */

test('★★★ ticker24h：实测字段按项目公共形状映射（含 openPrice 反推）', async () => {
  const { market, calls } = marketOf({ contracts: REAL_CONTRACTS, tickers: [REAL_TICKER] });

  const [ticker] = await market.ticker24h('BTCUSDT');
  assert.ok(ticker);
  assert.equal(ticker!.symbol, 'BTCUSDT', 'BTC_USDT → BTCUSDT');
  assert.equal(ticker!.lastPrice, '73940.4');
  assert.equal(ticker!.priceChangePercent, '-3.95', 'Gate 的 change_percentage 本身就是百分数');
  assert.equal(ticker!.priceChange, '-3037');
  assert.equal(ticker!.highPrice, '77876');
  assert.equal(ticker!.lowPrice, '71697.3');
  assert.equal(ticker!.volume, '8912', 'volume_24h_base 是基础币数量');
  assert.equal(ticker!.quoteVolume, '658846116', 'volume_24h_quote 是 USDT 成交额');
  assert.equal(ticker!.openPrice, String(73940.4 + 3037), 'Gate 不给开盘价：last − change_price');
  /* Gate 不提供这三项 → 0，不编造。 */
  assert.equal(ticker!.openTime, 0);
  assert.equal(ticker!.count, 0);
  assert.equal(ticker!.lastQty, '0');

  assert.equal(calls[0]!.path, '/futures/usdt/tickers');
  assert.equal(calls[0]!.params?.contract, 'BTC_USDT', '单个标的必须带 contract 过滤全市场');
});

test('★★ ticker24h：不传 symbol 时不带 contract 参数（全市场一次取回）', async () => {
  const { market, calls } = marketOf({ contracts: REAL_CONTRACTS, tickers: [REAL_TICKER] });
  await market.ticker24h();
  assert.deepEqual(calls[0]!.params, {}, '全市场查询不能带 contract');
});

test('★★ ticker 成交额回落链：quote 缺失时用 settle（否则筛选门槛会误杀标的）', () => {
  const mapped = gateTickerToBinance({
    contract: 'BTC_USDT',
    last: '100',
    volume_24h_settle: '123456',
    volume_24h_base: '0',
  });
  assert.equal(mapped.quoteVolume, '123456');
  assert.equal(mapped.volume, '0');
  assert.equal(mapped.weightedAvgPrice, '0', '基础币成交量为 0 时不除零');
});

test('★★ ticker 响应不是数组 → 抛错', async () => {
  const { market } = marketOf({ contracts: REAL_CONTRACTS, tickers: 'oops' });
  await assert.rejects(
    () => market.ticker24h(),
    (error: Error) => /返回的不是数组/.test(error.message) && /tickers/.test(error.message),
  );
});

test('★★★ premiumIndex：标记价/指数价/资金费率来自 tickers，结算时刻来自合约信息', async () => {
  const { market, calls } = marketOf({ contracts: REAL_CONTRACTS, tickers: [REAL_TICKER] });

  const [premium] = await market.premiumIndex('BTCUSDT');
  assert.ok(premium);
  assert.equal(premium!.symbol, 'BTCUSDT');
  assert.equal(premium!.markPrice, '73945.68');
  assert.equal(premium!.indexPrice, '73975');
  assert.equal(premium!.lastFundingRate, '0.0001');
  assert.equal(
    premium!.nextFundingTime,
    1_794_355_200_000,
    'Gate 的 funding_next_apply 是秒 → 毫秒；ticker 里没有这个字段',
  );
  assert.equal(premium!.interestRate, '0.0003', '合约里的 interest_rate');
  assert.equal(premium!.estimatedSettlePrice, '0', 'Gate 没有"预估结算价"概念');
  assert.ok(premium!.time > 0);
  assert.equal(calls[0]!.params?.contract, 'BTC_USDT');
});

test('★★ premiumIndex：合约信息读不到时降级（资金费时间记 0），不让整个行情失败', async () => {
  const { market } = marketOf({ contracts: new Error('contracts 502'), tickers: [REAL_TICKER] });
  const [premium] = await market.premiumIndex('BTCUSDT');
  assert.ok(premium, '合约信息失败不应让标记价整体失败');
  assert.equal(premium!.markPrice, '73945.68');
  assert.equal(premium!.nextFundingTime, 0, '读不到就是 0，不编造结算时间');
});

/* -------------------------------------------------------------------------- */
/*  Funding rate history                                                       */
/* -------------------------------------------------------------------------- */

test('★★★ fundingRate 历史：秒 → 毫秒、按时间升序、limit 夹到 1000', async () => {
  const { market, calls } = marketOf({ contracts: REAL_CONTRACTS, fundingRate: REAL_FUNDING });

  const rows = await market.fundingRate('BTCUSDT', 5000);
  assert.deepEqual(
    rows.map((r) => r.time),
    [1_794_268_800_000, 1_794_297_600_000, 1_794_326_400_000],
    '实测响应是倒序，返回必须升序（旧 → 新）',
  );
  assert.ok(rows.every((r) => r.fundingRate === 0.0001));
  const request = calls.find((c) => c.path === '/futures/usdt/funding_rate');
  assert.equal(request!.params?.contract, 'BTC_USDT');
  assert.equal(request!.params?.limit, GATE_FUNDING_RATE_MAX_LIMIT);
});

test('★★ fundingRate 响应不是数组 → 抛错', async () => {
  const { market } = marketOf({ contracts: REAL_CONTRACTS, fundingRate: {} });
  await assert.rejects(
    () => market.fundingRate('BTCUSDT'),
    (error: Error) => /返回的不是数组/.test(error.message) && /funding_rate/.test(error.message),
  );
});

/* -------------------------------------------------------------------------- */
/*  Contracts / precision                                                      */
/* -------------------------------------------------------------------------- */

test('★★★ 合约精度映射：价格 tick / 张数换算 / 杠杆 / 费率 / 结算时刻', () => {
  const info = toGateContractInfo(REAL_CONTRACT as unknown as GateContractRaw);
  assert.equal(info.symbol, 'BTCUSDT');
  assert.equal(info.contract, 'BTC_USDT');
  assert.equal(info.priceTick, 0.1);
  assert.equal(info.quantoMultiplier, 0.0001);
  assert.equal(info.minSize, 1);
  assert.equal(info.maxSize, 1_000_000);
  assert.equal(info.sizeStep, 1, 'Gate 期货张数恒为整数（实测没有 order_size_step）');
  assert.equal(info.maxLeverage, 125);
  assert.equal(info.takerFeeRate, 0.00075);
  assert.equal(info.makerFeeRate, -0.0001);
  assert.equal(info.nextFundingTime, 1_794_355_200_000);
  assert.equal(info.interestRate, 0.0003);
  assert.equal(info.openInterest, 30_228_906_096 * 0.0001, 'position_size 张 × multiplier = 币数');
  assert.equal(info.delisting, false);
});

test('★★ contractInfo / symbols：已下线合约不进 symbols；未知合约抛错', async () => {
  const { market } = marketOf({ contracts: REAL_CONTRACTS });

  assert.deepEqual(await market.symbols(), ['BTCUSDT'], 'OLD_USDT 已下线，必须排除');
  const info = await market.contractInfo('btcusdt');
  assert.equal(info.contract, 'BTC_USDT', '本项目的符号大小写都该能查');

  await assert.rejects(
    () => market.contractInfo('NOPEUSDT'),
    (error: Error) => /Gate 合约不存在/.test(error.message),
  );
});

test('★★ openInterest：用全市场持仓张数 × multiplier；读不到返回 null', async () => {
  const normal = marketOf({ contracts: REAL_CONTRACTS });
  assert.equal(
    await normal.market.openInterest('BTCUSDT'),
    30_228_906_096 * 0.0001,
    '维度与币安 openInterest（币数）一致',
  );

  const broken = marketOf({ contracts: new Error('contracts 502') });
  assert.equal(await broken.market.openInterest('BTCUSDT'), null, '读不到就 null，不编 0');
});

test('★★ Gate 没有的衍生数据源：明确返回空（而不是抛错让整轮行情失败）', async () => {
  const { market } = marketOf({ contracts: REAL_CONTRACTS });

  assert.deepEqual(await market.openInterestHist(), [], 'Gate 无 OI 历史端点');
  assert.deepEqual(await market.takerBuySellVolume(), [], 'Gate K 线无主动买卖量');
  assert.deepEqual(await market.longShortRatio(), [], 'Gate v4 期货无多空账户比序列');
});
