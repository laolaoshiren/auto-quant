/**
 * Gate.io USDT 本位永续的**公开行情**层（对应币安的 `binance/market.ts`）。
 *
 * ## 为什么返回"币安形状"
 *
 * 交易循环（`market/service.ts` 的 `MarketDataService`、`AutoTrader`）目前是按
 * `BinanceMarketData` 的方法与返回类型写成的。接第二个交易所时，两条路：
 *
 *   1. 让上层按交易所分叉 —— 每个消费点都要写一份，必漏；
 *   2. **在这一层把 Gate 的数据映射成同一套形状** —— 上层继续只认一套形状。
 *
 * 选 2。与 `GateBroker` 的做法一致（它也把 Gate 的订单/成交映射成
 * `BinanceOrderResponse` / `BinanceUserTrade`，那里写了同样的理由）。
 * 所以这里的 `Kline` / `BinanceTicker24h` / `BinancePremiumIndex` 不是"币安专有"，
 * 而是**本项目行情领域的公共形状**；差异只存在于本文件与 Gate 之间。
 *
 * ## 与币安的四个真实差异（都在实盘/测试网响应上核对过）
 *
 * 1. **合约命名**：Gate 用 `BTC_USDT`，本项目一律 `BTCUSDT`。
 *    进出用 `symbolToGateContract()` / `gateContractToSymbol()`（`account.ts`）。
 * 2. **数量是"张数"**：K 线的 `v`（成交量）是**合约张数**，要乘
 *    `quanto_multiplier` 才是币数（否则 1 张 BTC_USDT 会被当成 1 BTC，差 10000 倍）。
 * 3. **K 线的形状不同**：`/futures/usdt/candlesticks` 返回的是**对象**
 *    `{ t, v, c, h, l, o, sum }`（实测 2026-11-11 测试网），而 Gate **现货**
 *    candlesticks 才是数组 `[ts, quoteVolume, close, high, low, open, baseVolume]`。
 *    本文件两种都容忍（见 `gateCandleToKline`），但**以对象形状为准**。
 * 4. **没有的字段不编**：24h ticker 不提供 `openTime`/`count`/`lastQty`；
 *    K 线不提供主动买卖量（`takerBuy*`）。这些位置给 0 并在类型注释里写清，
 *    同时 `enableQuantData` 相关的 Gate 侧衍生指标会被明确标注为"不可用"。
 */
import type { Kline, Timeframe } from '@aq/shared';
import { createLogger } from '../logger.js';
import type {
  BinanceOpenInterestHist,
  BinancePremiumIndex,
  BinanceTicker24h,
} from '../binance/types.js';
import { GateContractRegistry, gateContractToSymbol, num, symbolToGateContract } from './account.js';
import type { GateRest } from './rest.js';

const log = createLogger('gate:market');

/* -------------------------------------------------------------------------- */
/*  Raw response shapes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Gate v4 期货 K 线的实际形状（**实测**，2026-11-11 测试网）。
 *
 * ```
 * [{"o":"73949.1","v":52754,"t":1794345600,"c":"73899.1",
 *   "l":"73880.8","h":"73961.2","sum":"389929.55253"}, ...]
 * ```
 *
 * · `t` 是**秒级**开始时间（不是毫秒，也不含 closeTime）
 * · `v` 是成交**张数**（乘 `quanto_multiplier` 才是币数）
 * · `sum` 是成交额（USDT）
 * · 别的字段全是字符串；`v`/`t` 是数字 —— 所以这里统一按 `string | number` 收，
 *   由 `num()` 转，不在类型上假装都是字符串。
 */
export interface GateCandleObject {
  t: string | number;
  o: string | number;
  h: string | number;
  l: string | number;
  c: string | number;
  v: string | number;
  /** 成交额（USDT）。Gate 文档里叫 "sum"。 */
  sum?: string | number;
}

/**
 * Gate **现货** candlesticks 的数组形状 —— 保留成可容忍的输入，因为历史文档/
 * 第三方示例经常拿它当期货格式（两者字段顺序确实不同）。
 *
 * `[timestamp(秒), quoteVolume, close, high, low, open, baseVolume, windowClosed?]`
 */
export type GateCandleTuple = [number, ...Array<string | number>];

/** Gate 24h ticker（实测字段见 `gateTickerToBinance` 的测试夹具）。 */
export interface GateTickerRaw {
  contract: string;
  last?: string | number;
  /** 24h 涨跌额（绝对值）。实测 BTC_USDT = "-3037"。 */
  change_price?: string | number;
  /** 24h 涨跌幅（**百分数**，-3.95 表示 -3.95%）。 */
  change_percentage?: string | number;
  high_24h?: string | number;
  low_24h?: string | number;
  /** 成交量：**张数**（不是币数）。 */
  volume_24h?: string | number;
  /** 成交量：基础币种（BTC_USDT 里是 BTC 数量）。 */
  volume_24h_base?: string | number;
  /** 成交量：计价币种（USDT 成交额）。 */
  volume_24h_quote?: string | number;
  /** 成交量：结算币种（USDT）。 */
  volume_24h_settle?: string | number;
  volume_24h_usd?: string | number;
  mark_price?: string | number;
  index_price?: string | number;
  funding_rate?: string | number;
  funding_rate_indicative?: string | number;
  quanto_multiplier?: string | number;
}

/**
 * 合约信息（`/futures/usdt/contracts`）里**映射精度需要的**字段。
 *
 * ⚠️ `gate/types.ts` 里 `GateFuturesContract` 只声明了部分字段，而且把
 * `order_size_min` 声明成字符串 —— 而**实测**返回的是数字（`order_size_min: 1`）。
 * 这里按真实响应收（`string | number`），映射统一走 `num()`；`gate/types.ts`
 * 不在本任务的写范围内，所以不为了这一处去改它。
 */
export interface GateContractRaw {
  name: string;
  status?: string;
  in_delisting?: boolean;
  quanto_multiplier?: string | number;
  /** 价格最小变动（字符串，例如 "0.1"）。 */
  order_price_round?: string | number;
  /** 最小下单张数（实测是 number）。 */
  order_size_min?: string | number;
  /** 最大下单张数（实测是 number）。 */
  order_size_max?: string | number;
  /**
   * Gate 期货合约**没有**张数步长字段（实测响应里没有 `order_size_step`；
   * 永续张数恒为整数）。保留读取只是为了兼容 `gate/types.ts` 的历史声明。
   */
  order_size_step?: string | number;
  /** 是否允许小数张数（个别合约才有）。 */
  enable_decimal?: boolean;
  leverage_max?: string | number;
  taker_fee_rate?: string | number;
  maker_fee_rate?: string | number;
  /** 下一次资金费结算时刻（**秒**）。 */
  funding_next_apply?: string | number;
  interest_rate?: string | number;
  /** 全市场持仓总量（**张数**）。 */
  position_size?: string | number;
}

/** 资金费历史（`/futures/usdt/funding_rate`）：`[{ r, t }]`，t 是**秒**。 */
export interface GateFundingRateRaw {
  t: string | number;
  r: string | number;
}

/* -------------------------------------------------------------------------- */
/*  Interval mapping                                                           */
/* -------------------------------------------------------------------------- */

/** Gate 期货 K 线支持的周期（官方口径，实测 5m/15m/1h 可用）。 */
export type GateInterval = '10s' | '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '8h' | '1d' | '7d' | '30d';

const GATE_INTERVAL_MS: Record<GateInterval, number> = {
  '10s': 10_000,
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

/**
 * 本项目的周期 → Gate 周期。
 *
 * ⚠️ **不支持的周期必须抛错，不能"就近映射"**（例如把 2h 映射成 4h）：
 * 那会让指标在 Gate 与币安上算的是**不同的东西**，而界面上看不出来 ——
 * 一条"看起来正常工作"的错误，比一条明确的报错危险得多。
 * Gate 期货只支持 1m/5m/15m/30m/1h/4h/1d（本项目没有 10s/8h/7d/30d 的配置）。
 */
export function gateIntervalOf(timeframe: Timeframe): GateInterval {
  switch (timeframe) {
    case '1m':
    case '5m':
    case '15m':
    case '30m':
    case '1h':
    case '4h':
    case '1d':
      return timeframe;
    default:
      throw new Error(
        `Gate 期货不支持 ${timeframe} 周期（只支持 1m/5m/15m/30m/1h/4h/1d）。` +
          `请在策略的 indicators.kline.selectedTimeframes 里换成支持的周期 —— ` +
          `不要用其他周期近似，那会让指标和币安上算的不是同一个东西。`,
      );
  }
}

export function gateIntervalMs(interval: GateInterval): number {
  return GATE_INTERVAL_MS[interval];
}

/* -------------------------------------------------------------------------- */
/*  Pure mappings (unit-testable without network)                              */
/* -------------------------------------------------------------------------- */

/**
 * Gate 的 K 线 → 本项目的 `Kline`。
 *
 * 两种输入形状都容忍（见文件头说明）：
 * · **对象**（期货实测形状）：`v` 是张数 → `× quantoMultiplier` 换成币数；
 * · **数组**（现货形状，[ts, quoteVol, close, high, low, open, baseVol]）：
 *   最后一个 `baseVol` 已经是**币数**，不再乘 multiplier。
 *
 * 返回 `null` 表示这一行是坏数据（缺价/无时间）—— 调用方丢弃它并记 debug，
 * **不要**用 0 填充：一条被 0 填充的 K 线会让 EMA/ATR 全部失真。
 *
 * @param intervalMs 该周期一根 K 线是多长（用来补出 closeTime；Gate 不给 closeTime）
 * @param quantoMultiplier 一张合约等于多少个币（数组形状不用它）。
 *   **传 0/负数表示"合约信息不可用"** —— 那时对象形状的成交量改用
 *   `成交额 ÷ 收盘价` 反推（量纲正确、近似值），而不是把张数当币数（会差 10000 倍）。
 */
export function gateCandleToKline(
  row: GateCandleObject | GateCandleTuple,
  input: { intervalMs: number; quantoMultiplier: number },
): Kline | null {
  if (Array.isArray(row)) {
    const openTimeSec = num(row[0]);
    const close = num(row[2]);
    const high = num(row[3]);
    const low = num(row[4]);
    const open = num(row[5]);
    if (!(openTimeSec > 0) || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) return null;
    const openTime = openTimeSec * 1000;
    return {
      openTime,
      open,
      high,
      low,
      close,
      volume: num(row[6]),
      closeTime: openTime + input.intervalMs,
      quoteVolume: num(row[1]),
      /* Gate 的 K 线没有成交笔数与主动买卖量 —— 给 0，不编造。 */
      trades: 0,
      takerBuyBase: 0,
      takerBuyQuote: 0,
    };
  }

  const openTimeSec = num(row.t);
  const open = num(row.o);
  const high = num(row.h);
  const low = num(row.l);
  const close = num(row.c);
  if (!(openTimeSec > 0) || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) return null;
  const openTime = openTimeSec * 1000;
  const quoteVolume = num(row.sum);
  /*
   * 成交量（币数）：
   *   · 拿得到合约信息时：`v`（张） × quanto_multiplier —— 与交易所口径一致；
   *   · 拿不到时：用 `成交额 ÷ 收盘价` 反推。量纲仍是对的（币数），只是均价近似；
   *   · **绝不用 `v` 直接当币数** —— 1 张 BTC_USDT 是 0.0001 BTC，直接当币数会差 10000 倍，
   *     而那种错误不会抛、只会让"成交量"整列静默失真。
   */
  const volume =
    input.quantoMultiplier > 0
      ? num(row.v) * input.quantoMultiplier
      : close > 0 && quoteVolume > 0
        ? quoteVolume / close
        : 0;
  return {
    openTime,
    open,
    high,
    low,
    close,
    volume,
    closeTime: openTime + input.intervalMs,
    quoteVolume,
    trades: 0,
    takerBuyBase: 0,
    takerBuyQuote: 0,
  };
}

/** 字符串字段的安全转换：Gate 用字符串传数值，缺失时给 '0' 而不是 'undefined'。 */
function decimalString(value: string | number | undefined): string {
  return String(num(value));
}

/**
 * Gate 24h ticker → `BinanceTicker24h`（本项目的公共行情形状）。
 *
 * ## 字段映射（全部在实测测试网响应上核对过 2026-11-11）
 *
 * ```
 *   contract           → symbol（gateContractToSymbol）
 *   last               → lastPrice
 *   change_price       → priceChange
 *   change_percentage  → priceChangePercent（Gate 已经是百分数，单位一致）
 *   high_24h/low_24h   → highPrice/lowPrice
 *   volume_24h_base    → volume（基础币数量）
 *   volume_24h_quote   → quoteVolume（USDT 成交额）
 * ```
 *
 * `openPrice` 由 `last − change_price` 反推（Gate 不给开盘价，但给了涨跌额）；
 * `weightedAvgPrice` 由 `成交额 ÷ 基础币成交量` 反推。
 *
 * ⚠️ **Gate 不提供的字段**：`lastQty` / `openTime` / `closeTime` / `count` ——
 * 一律给 0。消费方（`market/service.ts`）只读 `quoteVolume` /
 * `priceChangePercent` / `highPrice` / `lowPrice` / `lastPrice`，不依赖这四项。
 */
export function gateTickerToBinance(ticker: GateTickerRaw): BinanceTicker24h {
  const last = num(ticker.last);
  const priceChange = num(ticker.change_price);
  const baseVolume = num(ticker.volume_24h_base);
  /*
   * 成交额取哪个字段？实测 USDT 永续里 `volume_24h_quote` 与
   * `volume_24h_settle` 相等（都是 USDT）；保留一条回落链，避免某个合约
   * 少给其中一个字段时成交额变成 0（会让筛选门槛把标的全部滤掉）。
   */
  const quoteVolume =
    num(ticker.volume_24h_quote) ||
    num(ticker.volume_24h_settle) ||
    num(ticker.volume_24h_usd) ||
    0;
  return {
    symbol: gateContractToSymbol(ticker.contract),
    priceChange: decimalString(priceChange),
    priceChangePercent: decimalString(ticker.change_percentage),
    weightedAvgPrice: baseVolume > 0 && quoteVolume > 0 ? decimalString(quoteVolume / baseVolume) : '0',
    lastPrice: decimalString(last),
    lastQty: '0',
    /* Gate 不给开盘价：last − change 就是 24h 前那个价格。 */
    openPrice: decimalString(last - priceChange),
    highPrice: decimalString(ticker.high_24h),
    lowPrice: decimalString(ticker.low_24h),
    volume: decimalString(baseVolume),
    quoteVolume: decimalString(quoteVolume),
    openTime: 0,
    closeTime: 0,
    count: 0,
  };
}

/** 合约信息 → 本项目的精度描述（与 `binance/symbols.ts` 的 `SymbolInfo` 同口径，但更精简）。 */
export interface GateContractInfo {
  /** 本项目符号，例如 `BTCUSDT`。 */
  symbol: string;
  /** Gate 合约名，例如 `BTC_USDT`。 */
  contract: string;
  /** 价格最小变动（Gate `order_price_round`）。 */
  priceTick: number;
  /** 一张 = 多少个币（Gate `quanto_multiplier`）。 */
  quantoMultiplier: number;
  /** 最小下单张数。 */
  minSize: number;
  /** 最大下单张数。 */
  maxSize: number;
  /** 张数步长（Gate 期货恒为 1 张）。 */
  sizeStep: number;
  /** 交易所允许的最大杠杆。 */
  maxLeverage: number;
  takerFeeRate: number;
  makerFeeRate: number;
  /** 下一次资金费结算时刻（毫秒）；Gate 只给秒级，这里换算好。 */
  nextFundingTime: number;
  /** 资金费利率基准（Gate `interest_rate`）。 */
  interestRate: number;
  /** 全市场持仓总量（**币数**，= `position_size` 张 × multiplier）。 */
  openInterest: number;
  /** 是否已下线（行情/下单都应排除）。 */
  delisting: boolean;
}

export function toGateContractInfo(raw: GateContractRaw): GateContractInfo {
  const multiplier = num(raw.quanto_multiplier);
  const stepRaw = num(raw.order_size_step ?? 1);
  const nextFundingSec = num(raw.funding_next_apply);
  const positionSize = num(raw.position_size);
  return {
    symbol: gateContractToSymbol(raw.name),
    contract: raw.name,
    priceTick: num(raw.order_price_round),
    quantoMultiplier: multiplier > 0 ? multiplier : 1,
    minSize: num(raw.order_size_min) > 0 ? num(raw.order_size_min) : 1,
    maxSize: Math.max(0, num(raw.order_size_max)),
    /* Gate 期货的张数恒为整数；只有个别 `enable_decimal` 合约例外，本层不支持小数张。 */
    sizeStep: stepRaw > 0 ? stepRaw : 1,
    maxLeverage: num(raw.leverage_max),
    takerFeeRate: num(raw.taker_fee_rate),
    makerFeeRate: num(raw.maker_fee_rate),
    nextFundingTime: nextFundingSec > 0 ? nextFundingSec * 1000 : 0,
    interestRate: num(raw.interest_rate),
    openInterest: multiplier > 0 ? positionSize * multiplier : positionSize,
    delisting: raw.in_delisting === true,
  };
}

/* -------------------------------------------------------------------------- */
/*  Market                                                                     */
/* -------------------------------------------------------------------------- */

/** Gate 期货 K 线单次请求上限（官方口径）。 */
export const GATE_KLINE_MAX_LIMIT = 2000;
/** 资金费历史单次上限。 */
export const GATE_FUNDING_RATE_MAX_LIMIT = 1000;

/**
 * Gate 的公开行情读取器（与 `BinanceMarketData` 同形）。
 *
 * 合约信息（张数换算 / 精度 / 资金费时间）来自 `GateContractRegistry` ——
 * 与 `GateBroker` 共用同一个实例，避免两处各建一份 5 分钟缓存。
 */
export class GateMarket {
  constructor(
    private readonly rest: GateRest,
    private readonly contracts: GateContractRegistry,
  ) {}

  /* ------------------------------ K 线 -------------------------------- */

  /**
   * K 线，**含尚未收盘的那一根**（与币安 `klines` 同语义）。
   *
   * · 返回按时间升序（Gate 本来就是升序；这里仍排序，避免依赖交易所细节）；
   * · `limit` 夹在 `[1, 2000]`（Gate 上限 2000）；
   * · 坏行丢弃并记 debug —— **不补 0**（一条 0 价 K 线会污染所有指标）。
   */
  async klines(symbol: string, interval: Timeframe, limit = 100): Promise<Kline[]> {
    const gateInterval = gateIntervalOf(interval);
    const contractName = symbolToGateContract(symbol);
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), GATE_KLINE_MAX_LIMIT));
    const [rows, info] = await Promise.all([
      this.rest.publicGet<Array<GateCandleObject | GateCandleTuple>>('/futures/usdt/candlesticks', {
        contract: contractName,
        interval: gateInterval,
        limit: safeLimit,
      }),
      this.contractInfo(symbol).catch((error) => {
        /*
         * 合约信息读不到时**不能**按 multiplier=1 解析：那会把"张数"当"币数"，
         * 成交量差 10000 倍且不抛错。这里把 multiplier 置 0，交给
         * `gateCandleToKline` 用「成交额 ÷ 收盘价」反推币数（量纲正确、近似值）。
         */
        log.debug(`读取 ${contractName} 合约信息失败，K 线成交量改由成交额反推：${(error as Error).message}`);
        return null;
      }),
    ]);
    if (!Array.isArray(rows)) {
      throw new Error(
        `Gate 行情 /futures/usdt/candlesticks 返回的不是数组（${rows === null ? '空响应体' : typeof rows}）：` +
          `${JSON.stringify(rows)?.slice(0, 200)}`,
      );
    }
    const intervalMs = gateIntervalMs(gateInterval);
    const multiplier = info?.quantoMultiplier ?? 0;
    const klines: Kline[] = [];
    for (const row of rows) {
      const kline = gateCandleToKline(row, { intervalMs, quantoMultiplier: multiplier });
      if (kline === null) {
        log.debug(`丢弃一行无法解析的 ${contractName} ${gateInterval} K 线：${JSON.stringify(row)?.slice(0, 160)}`);
        continue;
      }
      klines.push(kline);
    }
    klines.sort((a, b) => a.openTime - b.openTime);
    return klines;
  }

  /**
   * 去掉**尚未收盘**的那一根 K 线（指标只吃已收盘的，与币安层同一理由：
   * 未收盘的 K 线会让 EMA/RSI 在每次轮询时抖动并产生假交叉）。
   *
   * 多取一根再过滤：Gate 的最后一条就是进行中的那根（与币安一样）。
   */
  async fetchClosedKlines(symbol: string, interval: Timeframe, limit = 100): Promise<Kline[]> {
    const rows = await this.klines(symbol, interval, limit + 1);
    if (rows.length === 0) return [];
    const now = Date.now();
    return rows.filter((k) => k.closeTime < now);
  }

  /* ---------------------------- Tickers ------------------------------- */

  /** 原始 24h ticker（Gate 形状）。内部/测试用；消费方用 `ticker24h`。 */
  async tickers(symbol?: string): Promise<GateTickerRaw[]> {
    const contract = symbol ? symbolToGateContract(symbol) : undefined;
    const response = await this.rest.publicGet<GateTickerRaw[] | GateTickerRaw>(
      '/futures/usdt/tickers',
      contract ? { contract } : {},
    );
    /* Gate 恒返回数组（实测），但防御性接受单对象（与币安那层同一个处理）。 */
    if (Array.isArray(response)) return response;
    if (response && typeof response === 'object' && typeof response.contract === 'string') return [response];
    throw new Error(
      `Gate 行情 /futures/usdt/tickers 返回的不是数组（${response === null ? '空响应体' : typeof response}）：` +
        `${JSON.stringify(response)?.slice(0, 200)}`,
    );
  }

  /** 24h ticker（映射成项目公共的 `BinanceTicker24h` 形状，见 `gateTickerToBinance`）。 */
  async ticker24h(symbol?: string): Promise<BinanceTicker24h[]> {
    const rows = await this.tickers(symbol);
    return rows.map(gateTickerToBinance);
  }

  /* --------------------- Mark price / funding ------------------------- */

  /**
   * 标记价 / 指数价 / 当前资金费率（`BinancePremiumIndex` 形状）。
   *
   * Gate 的 `/futures/usdt/tickers` 一次给全（与币安 `premiumIndex` 的用法一致），
   * 所以不需要单独打 funding_rate 端点。`nextFundingTime` 与 `interestRate` 从
   * 合约信息里补（ticker 不提供），读不到就记 0 —— 不编造时间。
   *
   * `estimatedSettlePrice`：Gate 没有对应概念，给 '0'（消费方不使用）。
   */
  async premiumIndex(symbol?: string): Promise<BinancePremiumIndex[]> {
    const tickers = await this.tickers(symbol);
    /* 合约信息用于补资金费结算时刻；读不到就降级（记 0），不能让行情整体失败。 */
    const infos = await this.contractInfoMap().catch((error) => {
      log.debug(`读取 Gate 合约信息失败，premiumIndex 的资金费时间按 0 处理：${(error as Error).message}`);
      return null;
    });
    const now = Date.now();
    return tickers.map((ticker) => {
      const symbolOfTicker = gateContractToSymbol(ticker.contract);
      const info = infos?.get(symbolOfTicker);
      const fundingRate = ticker.funding_rate ?? ticker.funding_rate_indicative;
      return {
        symbol: symbolOfTicker,
        markPrice: decimalString(ticker.mark_price),
        indexPrice: decimalString(ticker.index_price),
        /* Gate 没有"预估结算价"这个概念。 */
        estimatedSettlePrice: '0',
        lastFundingRate: decimalString(fundingRate),
        nextFundingTime: info?.nextFundingTime ?? 0,
        interestRate: info ? decimalString(info.interestRate) : '0',
        time: now,
      };
    });
  }

  /**
   * 资金费**历史**（`/futures/usdt/funding_rate`），升序（旧 → 新）。
   *
   * 实测响应：`[{"r":"0.0001","t":1794326400}, ...]`（`r` 是费率，`t` 是**秒**）。
   * 这是币安 `premiumIndex` 之外的补充：Gate 的资金费率是 8 小时结算一次
   *（`funding_interval: 28800`），要做"持仓期间资金费"分析必须能读到历史。
   */
  async fundingRate(symbol: string, limit = 100): Promise<Array<{ time: number; fundingRate: number }>> {
    const contract = symbolToGateContract(symbol);
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), GATE_FUNDING_RATE_MAX_LIMIT));
    const rows = await this.rest.publicGet<GateFundingRateRaw[]>('/futures/usdt/funding_rate', {
      contract,
      limit: safeLimit,
    });
    if (!Array.isArray(rows)) {
      throw new Error(
        `Gate 行情 /futures/usdt/funding_rate 返回的不是数组（${rows === null ? '空响应体' : typeof rows}）：` +
          `${JSON.stringify(rows)?.slice(0, 200)}`,
      );
    }
    return rows
      .map((row) => ({ time: num(row.t) * 1000, fundingRate: num(row.r) }))
      .filter((row) => row.time > 0)
      .sort((a, b) => a.time - b.time);
  }

  /* --------------------------- Contracts ------------------------------ */

  /** 所有合约的精度信息（按本项目符号索引）。注册表自带 5 分钟缓存。 */
  async contractInfoMap(force = false): Promise<Map<string, GateContractInfo>> {
    const byContract = await this.contracts.all(force);
    const out = new Map<string, GateContractInfo>();
    for (const raw of byContract.values()) {
      const info = toGateContractInfo(raw as unknown as GateContractRaw);
      out.set(info.symbol, info);
    }
    return out;
  }

  /** 可交易合约列表（排除已下线的）。**这是本项目的 symbols 名单**。 */
  async contractInfos(force = false): Promise<GateContractInfo[]> {
    const map = await this.contractInfoMap(force);
    return [...map.values()].filter((c) => !c.delisting);
  }

  /** 本项目的符号列表，例如 `['BTCUSDT', ...]`（与币安 `registry.symbols()` 同用途）。 */
  async symbols(force = false): Promise<string[]> {
    return (await this.contractInfos(force)).map((c) => c.symbol).sort();
  }

  /** 单个合约的精度信息；合约不存在时抛错（与 `GateContractRegistry.get` 一致）。 */
  async contractInfo(symbol: string): Promise<GateContractInfo> {
    const contractName = symbolToGateContract(symbol);
    const raw = await this.contracts.get(contractName);
    return toGateContractInfo(raw as unknown as GateContractRaw);
  }

  /* ------------------------- Degraded inputs -------------------------- */

  /**
   * 当前持仓量（**币数**）。
   *
   * Gate 没有币安 `/fapi/v1/openInterest` 那种"当前持仓量"端点；contract 里的
   * `position_size` 是**全市场持仓总量（以张计）**，× `quanto_multiplier` 换成
   * 币数后维度与币安一致。⚠️ 它是"合约级总量"，不区分方向；测试网数值可能
   * 异常（实测测试网 BTC_USDT 的 position_size 是 3e10 张量级），**不要用它
   * 做绝对规模判断**，只用于相对变化。读不到返回 null（不编 0）。
   */
  async openInterest(symbol: string): Promise<number | null> {
    try {
      const info = await this.contractInfo(symbol);
      return info.openInterest > 0 ? info.openInterest : null;
    } catch (error) {
      log.debug(`Gate openInterest(${symbol}) 读取失败：${(error as Error).message}`);
      return null;
    }
  }

  /**
   * 持仓量历史 —— **Gate v4 USDT 永续没有对应端点**。
   *
   * 返回空数组（而不是抛错）：`market/service.ts` 在 `enableOi` 打开时会读它，
   * 空数组让"OI 变化率"这一项优雅缺失；抛错会让整个标的的快照失败。
   * 调用方若要 OI 时间序列，需要外部采样并落盘（见 AGENTS §5.6）。
   */
  async openInterestHist(): Promise<BinanceOpenInterestHist[]> {
    return [];
  }

  /**
   * 主动买卖量 —— **Gate 的 K 线没有这个字段**。
   *
   * 返回空数组：`buildQuant` 里由它算出的"主动买/卖占比"在 Gate 上没有数据来源。
   * ⚠️ 不要用"总成交量的一半"之类去填 —— 那是编造，会让模型把噪声当信号。
   */
  async takerBuySellVolume(): Promise<Array<{ buyVol: number; sellVol: number; timestamp: number }>> {
    return [];
  }

  /**
   * 多空账户比 —— Gate v4 期货公开端点没有这个序列（contract 里只有当前
   * `long_users` / `short_users` 快照，没有时间序列）。返回空数组，语义同上。
   */
  async longShortRatio(): Promise<Array<{ longAccount: number; shortAccount: number; timestamp: number }>> {
    return [];
  }
}
