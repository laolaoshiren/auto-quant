import assert from 'node:assert/strict';
import test from 'node:test';
import type { IndicatorConfig, Kline } from '@aq/shared';
import { SymbolRegistry } from '../binance/symbols.js';
import type { MarketPort } from './port.js';
import { MarketDataService } from './service.js';

function makeRegistry(symbols: string[]): SymbolRegistry {
  return new SymbolRegistry(
    symbols.map((symbol) => ({
      symbol,
      baseAsset: symbol.replace(/USDT$/, ''),
      quoteAsset: 'USDT',
      status: 'TRADING',
      pricePrecision: 2,
      quantityPrecision: 3,
      tickSize: 0.01,
      stepSize: 0.001,
      minQty: 0.001,
      maxQty: 100000,
      minNotional: 5,
      contractSize: 1,
    })),
  );
}

function makeKlines(count: number, takerBuyRatio: number): Kline[] {
  const base = 1_700_000_000_000;
  const out: Kline[] = [];
  for (let i = 0; i < count; i += 1) {
    const volume = 100;
    const takerBuyBase = volume * takerBuyRatio;
    out.push({
      openTime: base + i * 5 * 60_000,
      closeTime: base + (i + 1) * 5 * 60_000,
      open: 100 + i * 0.1,
      high: 101 + i * 0.1,
      low: 99 + i * 0.1,
      close: 100.5 + i * 0.1,
      volume,
      quoteVolume: volume * 100,
      trades: takerBuyRatio > 0 ? 50 : 0,
      takerBuyBase,
      takerBuyQuote: takerBuyBase * 100,
    });
  }
  return out;
}

const BASE_INDICATOR_CONFIG: IndicatorConfig = {
  enableQuantData: true,
  enableOi: false,
  enableFundingRate: true,
  enableOiRanking: false,
  kline: {
    primaryTimeframe: '5m',
    primaryCount: 30,
    selectedTimeframes: ['5m', '15m', '4h'],
  },
  emaPeriods: [20],
  rsiPeriods: [14],
  atrPeriod: 14,
  macd: { fast: 12, slow: 26, signal: 9 },
} as unknown as IndicatorConfig;

test('★★★ P1 #14：screenOpenInterestGrowth 按美元持仓量（sumOpenInterestValue / 币数×价格）过滤，不拿币数比美元门槛', async () => {
  const market: MarketPort = {
    ticker24h: async () => [
      {
        symbol: 'BTCUSDT',
        priceChange: '100',
        priceChangePercent: '1.0',
        weightedAvgPrice: '70000',
        lastPrice: '70000',
        lastQty: '1',
        openPrice: '69900',
        highPrice: '71000',
        lowPrice: '69000',
        volume: '10000',
        quoteVolume: '700000000',
        openTime: 0,
        closeTime: 0,
        count: 0,
      },
      {
        symbol: 'MEMEUSDT',
        priceChange: '0.00001',
        priceChangePercent: '10.0',
        weightedAvgPrice: '0.0001',
        lastPrice: '0.0001',
        lastQty: '1',
        openPrice: '0.00009',
        highPrice: '0.00011',
        lowPrice: '0.00009',
        volume: '100000000000',
        quoteVolume: '100000000',
        openTime: 0,
        closeTime: 0,
        count: 0,
      },
      {
        symbol: 'ETHUSDT',
        priceChange: '50',
        priceChangePercent: '2.0',
        weightedAvgPrice: '3000',
        lastPrice: '3000',
        lastQty: '1',
        openPrice: '2950',
        highPrice: '3100',
        lowPrice: '2900',
        volume: '50000',
        quoteVolume: '150000000',
        openTime: 0,
        closeTime: 0,
        count: 0,
      },
    ],
    premiumIndex: async () => [
      { symbol: 'BTCUSDT', markPrice: '70000', indexPrice: '70000', estimatedSettlePrice: '0', lastFundingRate: '0.0001', nextFundingTime: 0, interestRate: '0', time: 0 },
      { symbol: 'MEMEUSDT', markPrice: '0.0001', indexPrice: '0.0001', estimatedSettlePrice: '0', lastFundingRate: '0.0001', nextFundingTime: 0, interestRate: '0', time: 0 },
      { symbol: 'ETHUSDT', markPrice: '3000', indexPrice: '3000', estimatedSettlePrice: '0', lastFundingRate: '0.0001', nextFundingTime: 0, interestRate: '0', time: 0 },
    ],
    klines: async () => [],
    fetchClosedKlines: async () => [],
    openInterest: async () => null,
    takerBuySellVolume: async () => [],
    longShortRatio: async () => [],
    openInterestHist: async (symbol: string) => {
      if (symbol === 'BTCUSDT') {
        /* 币数 80,000 远小于 5,000,000 门槛，但美元持仓量 56 亿美元远高于门槛 */
        return [
          { symbol, sumOpenInterest: '70000', sumOpenInterestValue: '4900000000', timestamp: 1 },
          { symbol, sumOpenInterest: '80000', sumOpenInterestValue: '5600000000', timestamp: 2 },
        ];
      }
      if (symbol === 'ETHUSDT') {
        /* 缺 sumOpenInterestValue 时回落 sumOpenInterest × markPrice（2000 × 3000 = 600 万美元 > 500 万） */
        return [
          { symbol, sumOpenInterest: '1500', sumOpenInterestValue: '', timestamp: 1 },
          { symbol, sumOpenInterest: '2000', sumOpenInterestValue: '', timestamp: 2 },
        ];
      }
      /* MEMEUSDT：币数 1 亿 > 500 万，但美元价值仅 10,000 美元（远低于 500 万美元门槛），必须被剔除 */
      return [
        { symbol, sumOpenInterest: '50000000', sumOpenInterestValue: '5000', timestamp: 1 },
        { symbol, sumOpenInterest: '100000000', sumOpenInterestValue: '10000', timestamp: 2 },
      ];
    },
  };

  const service = new MarketDataService(market, makeRegistry(['BTCUSDT', 'ETHUSDT', 'MEMEUSDT']));
  const picked = await service.screenOpenInterestGrowth({
    limit: 10,
    windowHours: 4,
    minQuoteVolume24h: 1_000_000,
    minOpenInterestUsd: 5_000_000,
  });

  assert.deepEqual(
    picked,
    ['ETHUSDT', 'BTCUSDT'],
    'BTC/ETH（高美元 OI、低币数）必须通过筛选；MEME（高币数、低美元 OI）必须被剔除',
  );
});

test('★★★ P1 #15：K 线缺乏主动买量（如 Gate 全为 0）时 quant 返回 null，不伪造 -100% 净卖出', async () => {
  let ratio = 0;
  const market: MarketPort = {
    ticker24h: async () => [
      {
        symbol: 'BTCUSDT',
        priceChange: '10',
        priceChangePercent: '1.0',
        weightedAvgPrice: '100',
        lastPrice: '100',
        lastQty: '1',
        openPrice: '99',
        highPrice: '102',
        lowPrice: '98',
        volume: '1000',
        quoteVolume: '100000',
        openTime: 0,
        closeTime: 0,
        count: 0,
      },
    ],
    premiumIndex: async () => [
      { symbol: 'BTCUSDT', markPrice: '100', indexPrice: '100', estimatedSettlePrice: '0', lastFundingRate: '0.0001', nextFundingTime: 0, interestRate: '0', time: 0 },
    ],
    klines: async () => makeKlines(30, ratio),
    fetchClosedKlines: async () => makeKlines(30, ratio),
    openInterest: async () => null,
    openInterestHist: async () => [],
    takerBuySellVolume: async () => [],
    longShortRatio: async () => [],
  };

  const service = new MarketDataService(market, makeRegistry(['BTCUSDT']));

  /* Gate 形状：有成交量但所有 K 线 takerBuyBase=0 */
  ratio = 0;
  const gateSnap = await service.buildSnapshot('BTCUSDT', BASE_INDICATOR_CONFIG);
  assert.ok(gateSnap);
  assert.equal(gateSnap.quant, null, '缺主动买入量时 quant 必须为 null，不能伪造 0% 买比 / -100% 净卖出');

  /* 币安形状：有真实 takerBuyBase */
  service.invalidate();
  ratio = 0.6;
  const binanceSnap = await service.buildSnapshot('BTCUSDT', BASE_INDICATOR_CONFIG);
  assert.ok(binanceSnap?.quant);
  assert.ok(Math.abs(binanceSnap.quant.takerBuyRatio1h - 0.6) < 1e-6);
  assert.ok(binanceSnap.quant.netflow1h > 0);
});
