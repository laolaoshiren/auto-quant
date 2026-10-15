import {
  type DerivativeContext,
  type IndicatorConfig,
  type Kline,
  type MarketSnapshot,
  type OiRankRow,
  type QuantContext,
  type Timeframe,
  type TimeframeIndicators,
} from '@aq/shared';
import type { BinanceMarketData } from '../binance/market.js';
import type { FunnelCandidate } from './funnel.js';
import type { SymbolRegistry } from '../binance/symbols.js';
import { normalizeSymbol } from '../binance/symbols.js';
import type { BinancePremiumIndex, BinanceTicker24h } from '../binance/types.js';
import { createLogger } from '../logger.js';
import { computeTimeframeIndicators } from './indicators.js';
import { rankUniverse, type RankableTicker, type UniverseRankings } from './rankings.js';
import {
  filterByMinOpenInterest,
  growthPercent,
  screenSymbols,
  type ScreenableSymbol,
  type ScreenCriteria,
} from './screening.js';
import { scoreSymbol } from '../strategy/scoring.js';

const log = createLogger('market:service');

/**
 * 「评分用的 15m / 4h 缺失」只告警一次。
 *
 * 这一条会在**每个标的、每一轮**都被触发（配置不会自己变好），所以不加开关的话
 * 日志会被它淹没 —— 而一条淹没在噪音里的告警等于没有告警。
 */
let warnedMissingScoreTimeframes = false;

/* -------------------------------------------------------------------------- */
/*  Universe snapshot                                                          */
/* -------------------------------------------------------------------------- */

interface UniverseSnapshot {
  fetchedAt: number;
  tickers: Map<string, BinanceTicker24h>;
  premiums: Map<string, BinancePremiumIndex>;
}

/** The universe-wide ticker/premium pair is reused for every symbol in a cycle. */
const UNIVERSE_TTL_MS = 20_000;

/**
 * 模型用 `screen_symbols` 一次最多能要几个。
 *
 * 15 行约 900 字符（相对每轮二十几万是零头），而"看一批"这个用途足够了。
 * 上限 30 是**系统把关的那条线**：它可能说"给我看全部"，那会把提示词预算挤爆、
 * 把真正该看的东西挤掉 —— **要哪些由它决定，最多给几个由系统定**。
 */
const SCREEN_DEFAULT_LIMIT = 15;
const SCREEN_MAX_LIMIT = 30;

/* -------------------------------------------------------------------------- */
/*  Service                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Assembles the market picture the model actually sees.
 *
 * Two efficiency decisions matter here:
 *
 *  1. `/fapi/v1/ticker/24hr` and `/fapi/v1/premiumIndex` are fetched **without**
 *     a symbol, returning the whole universe in a single call each. That turns
 *     a 2N-request cycle into 2 requests plus one per configured timeframe.
 *  2. The universe snapshot is cached for a few seconds so that several symbols
 *     in the same cycle — and concurrent traders — share one fetch.
 */
export class MarketDataService {
  private universe: UniverseSnapshot | null = null;
  private readonly klineCache = new Map<string, { at: number; klines: Kline[] }>();

  constructor(
    private readonly market: BinanceMarketData,
    private readonly registry: SymbolRegistry,
  ) {}

  /** Universe-wide tickers and funding/mark prices, cached for a few seconds. */
  private async getUniverse(force = false): Promise<UniverseSnapshot> {
    if (!force && this.universe && Date.now() - this.universe.fetchedAt < UNIVERSE_TTL_MS) {
      return this.universe;
    }

    const [tickers, premiums] = await Promise.all([
      this.market.ticker24h().catch((error) => {
        log.warn(`拉取全市场行情快照失败：${(error as Error).message}`);
        return [] as BinanceTicker24h[];
      }),
      this.market.premiumIndex().catch((error) => {
        log.warn(`拉取全市场标记价与资金费率失败：${(error as Error).message}`);
        return [] as BinancePremiumIndex[];
      }),
    ]);

    const snapshot: UniverseSnapshot = {
      fetchedAt: Date.now(),
      tickers: new Map(tickers.map((t) => [t.symbol, t])),
      premiums: new Map(premiums.map((p) => [p.symbol, p])),
    };
    this.universe = snapshot;
    return snapshot;
  }

  /**
   * **一批标的的标记价**（来自全市场 `premiumIndex`，与行情快照同源）。
   *
   * ## 为什么需要它（2026-10-15 修：模拟盘的浮盈被漏算）
   *
   * 浮盈的算式（`ownUnrealizedPnlOf`，见 `store/repositories.ts`）要一个标记价，
   * 而它原来**只从交易所的 `positionRisk` 取**。对 `dry_run`（模拟盘）机器人，
   * 本地那条持仓在交易所**根本不存在** → 恒缺标记价 → 那个仓的浮盈被按 0 计入，
   * 而界面上看不出异样。
   *
   * 线上实测（`#11`，`dry_run=1`）每 5 秒刷一条：
   * ```
   *   这些标的有本地持仓但拿不到标记价，其浮盈未计入首页数字：SOLUSDT
   * ```
   * 而那个 SOLUSDT 空头是**模拟仓** —— 交易所侧本来就没有它。
   *
   * 行情侧的标记价是**行情事实**（对所有机器人相同），借它不引入归属错误 ——
   * 与 `buildEquitySnapshot` 借用交易所 `markPrice` 是同一条理由。
   *
   * ⚠️ 走的是 `getUniverse()` 的缓存（几十秒 TTL）⇒ 连续调用不会重复打币安。
   * 取不到的标的**不进 map**（调用方本来就有"缺标记价"这条路径，不许拿 0 冒充）。
   */
  async markPricesOf(symbols: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (symbols.length === 0) return out;
    try {
      const universe = await this.getUniverse();
      for (const symbol of symbols) {
        const premium = universe.premiums.get(symbol);
        const value = premium ? Number(premium.markPrice) : NaN;
        if (Number.isFinite(value) && value > 0) out.set(symbol, value);
      }
    } catch {
      /* 取不到就返回已拿到的那些 —— "缺标记价"由调用方如实上报，不在这里吞掉。 */
    }
    return out;
  }

  /**
   * Closed klines with a short cache.
   *
   * The live candle is always excluded: feeding a partial candle into EMA/RSI
   * makes indicators jitter on every poll and manufactures phantom crossovers.
   */
  /**
   * 拉某个周期的原始 K 线。
   *
   * 公开：`get_skipped_outcomes` 要用它算"被否掉的标的后来走了多少" ——
   * 那是 AI 唯一能校准入场标准的反馈，而它需要历史价格。
   */
  async getKlines(symbol: string, timeframe: Timeframe, count: number): Promise<Kline[]> {
    const key = `${symbol}:${timeframe}:${count}`;
    const cached = this.klineCache.get(key);
    // A candle closes at most once per timeframe; 15s is safely within that.
    if (cached && Date.now() - cached.at < 15_000) return cached.klines;

    const klines = await this.market.fetchClosedKlines(symbol, timeframe, count);
    this.klineCache.set(key, { at: Date.now(), klines });
    return klines;
  }

  /** Drop caches so the next cycle reads fresh data. */
  invalidate(): void {
    this.universe = null;
    this.klineCache.clear();
  }

  /* ---------------------------------------------------------------------- */
  /*  Snapshot assembly                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Build one symbol's complete market snapshot.
   *
   * Never throws for a single symbol: a data hiccup on one candidate should
   * degrade that candidate, not abort the whole decision cycle.
   */
  async buildSnapshot(
    symbolInput: string,
    config: IndicatorConfig,
    sources: string[] = [],
  ): Promise<MarketSnapshot | null> {
    const symbol = normalizeSymbol(symbolInput);

    let info;
    try {
      info = this.registry.require(symbol);
    } catch {
      log.debug(`跳过未登记的标的 ${symbol}`);
      return null;
    }

    const timeframes = config.kline.selectedTimeframes;
    const count = config.kline.primaryCount;

    const klineResults = await Promise.all(
      timeframes.map(async (tf) => {
        try {
          return { tf, klines: await this.getKlines(symbol, tf, count) };
        } catch (error) {
          log.warn(`拉取 ${symbol} 的 ${tf} K 线失败：${(error as Error).message}`);
          return { tf, klines: [] as Kline[] };
        }
      }),
    );

    const computed: TimeframeIndicators[] = klineResults.map(({ tf, klines }) =>
      computeTimeframeIndicators(tf, klines, config),
    );

    const primaryIndex = Math.max(
      0,
      timeframes.indexOf(config.kline.primaryTimeframe),
    );
    const primary = computed[primaryIndex] ?? computed[0];
    if (!primary || primary.klines.length === 0) {
      log.debug(`no usable klines for ${symbol}`);
      return null;
    }

    const universe = await this.getUniverse();
    const ticker = universe.tickers.get(symbol);
    const premium = universe.premiums.get(symbol);

    const lastClose = primary.klines[primary.klines.length - 1]?.close ?? 0;
    const markPrice = premium ? Number(premium.markPrice) : NaN;
    const price = Number.isFinite(markPrice) && markPrice > 0 ? markPrice : lastClose;

    const derivatives = await this.buildDerivatives(symbol, price, premium, config);

    /*
     * 候选评分。
     *
     * 在这里算而不是在调用方算，是因为**只有这里同时拿得到 15m 与 4h 的原始 K 线** ——
     * 快照里只带算好的指标，带不了 K 线（那会让快照大得多）。
     * 而评分必须两个周期都要：只看小周期会被日内噪声带走，只看大周期会错过入场点。
     *
     * ## ⚠️ 评分固定用 15m + 4h，与 `selectedTimeframes` 无关
     *
     * 这是刻意写死的：评分回答的是"这个标的现在值不值得看"，它需要一组**所有策略
     * 都相同**的尺子 —— 若跟着配置变，两个策略各自的 `minScore` 就不可比了。
     *
     * 但代价是：**配置里如果没选 15m 或 4h，评分恒为 0**（`scoring.ts` 要求
     * 4h ≥ 30 根、15m ≥ 25 根，空数组直接返回 0）。那时任何 `minScore > 0`
     * 都会把全部候选滤掉 —— 而门槛恰恰是 AI 能调的参数，它调完看到"没有机会"，
     * 会以为市场不好，而不是"这个配置下评分根本没有信息量"。
     *
     * 所以对这种组合**记一条明确的告警**（只记一次，否则每个标的每一轮都会刷）。
     */
    const klinesOf = (tf: string): Kline[] => klineResults.find((r) => r.tf === tf)?.klines ?? [];
    const scoreKlines15m = klinesOf('15m');
    const scoreKlines4h = klinesOf('4h');
    if (
      (scoreKlines15m.length === 0 || scoreKlines4h.length === 0) &&
      !warnedMissingScoreTimeframes
    ) {
      warnedMissingScoreTimeframes = true;
      log.warn(
        '候选评分固定使用 15m 与 4h 两根 K 线，而本策略配置的周期集合里缺了其中一个 —— ' +
          '这会让**所有标的的评分恒为 0**，任何「候选评分门槛」（coinSource.minScore > 0）' +
          '都会因此把全部候选滤掉。请把 15m 与 4h 加回 indicators.kline.selectedTimeframes，' +
          '或把 minScore 设为 0（关闭门槛）。',
      );
    }
    const score = scoreSymbol(scoreKlines15m, scoreKlines4h);

    return {
      symbol,
      sources,
      price,
      quoteVolume24h: Number(ticker?.quoteVolume ?? 0),
      priceChangePercent24h: Number(ticker?.priceChangePercent ?? 0),
      high24h: Number(ticker?.highPrice ?? 0),
      low24h: Number(ticker?.lowPrice ?? 0),
      primary,
      isMajor: this.registry.isMajor(symbol),
      timeframes: computed,
      derivatives,
      quant: config.enableQuantData ? await this.buildQuant(symbol, primary) : null,
      score,
    };
  }

  /** Batch variant. Failures yield fewer snapshots rather than an exception. */
  async buildSnapshots(
    symbols: string[],
    config: IndicatorConfig,
    sourcesBySymbol: Map<string, string[]> = new Map(),
  ): Promise<MarketSnapshot[]> {
    const results = await Promise.all(
      symbols.map((symbol) => this.buildSnapshot(symbol, config, sourcesBySymbol.get(symbol) ?? [])),
    );
    return results.filter((s): s is MarketSnapshot => s !== null);
  }

  /* ---------------------------------------------------------------------- */
  /*  Derivatives context                                                    */
  /* ---------------------------------------------------------------------- */

  private async buildDerivatives(
    symbol: string,
    price: number,
    premium: BinancePremiumIndex | undefined,
    config: IndicatorConfig,
  ): Promise<DerivativeContext> {
    const context: DerivativeContext = {
      openInterest: null,
      openInterestUsd: null,
      openInterestAvg: null,
      openInterestChangePercent: {},
      fundingRate: premium ? Number(premium.lastFundingRate) : null,
      nextFundingTime: premium?.nextFundingTime ?? null,
      markPrice: premium ? Number(premium.markPrice) : null,
      indexPrice: premium ? Number(premium.indexPrice) : null,
    };

    if (!config.enableFundingRate) context.fundingRate = null;
    if (!config.enableOi) {
      context.nextFundingTime = null;
      return context;
    }

    const [current, hist] = await Promise.all([
      this.market.openInterest(symbol),
      this.market.openInterestHist(symbol, '1h', 25),
    ]);

    context.openInterest = current;
    if (current !== null && price > 0) context.openInterestUsd = current * price;

    if (hist.length > 0) {
      const values = hist.map((h) => Number(h.sumOpenInterest)).filter((v) => Number.isFinite(v));
      if (values.length > 0) {
        context.openInterestAvg = values.reduce((a, b) => a + b, 0) / values.length;
        const latest = values[values.length - 1] as number;
        context.openInterestUsd = price > 0 ? latest * price : context.openInterestUsd;

        // The history series is hourly and oldest-first, so index arithmetic
        // gives the change over each window directly.
        const changeOver = (hours: number): number | undefined => {
          const idx = values.length - 1 - hours;
          if (idx < 0) return undefined;
          const past = values[idx] as number;
          if (past <= 0) return undefined;
          return ((latest - past) / past) * 100;
        };

        context.openInterestChangePercent = {
          '1h': changeOver(1),
          '4h': changeOver(4),
          '24h': changeOver(24),
        };
      }
    }

    return context;
  }

  /* ---------------------------------------------------------------------- */
  /*  Order-flow context                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Taker buy/sell flow derived from candle data we already have.
   *
   * `takerBuyBase` is present on every kline, so this costs zero extra requests
   * and still gives the model a genuine read on which side is aggressing.
   */
  private async buildQuant(
    symbol: string,
    primary: TimeframeIndicators,
  ): Promise<QuantContext | null> {
    const klines = primary.klines;
    if (klines.length === 0) return null;

    const windowFor = (hours: number): Kline[] => {
      const perHour = klinesPerHour(primary.timeframe);
      const count = Math.max(1, Math.round(perHour * hours));
      return klines.slice(-count);
    };

    const summarise = (slice: Kline[]): { net: number; buyRatio: number } => {
      let buy = 0;
      let sell = 0;
      for (const k of slice) {
        buy += k.takerBuyBase;
        sell += k.volume - k.takerBuyBase;
      }
      const total = buy + sell;
      return { net: buy - sell, buyRatio: total > 0 ? buy / total : 0.5 };
    };

    const one = summarise(windowFor(1));
    const four = summarise(windowFor(4));

    const changeOver = (hours: number): number | undefined => {
      const perHour = klinesPerHour(primary.timeframe);
      const bars = Math.max(1, Math.round(perHour * hours));
      const idx = klines.length - 1 - bars;
      if (idx < 0) return undefined;
      const past = klines[idx]?.close ?? 0;
      const latest = klines[klines.length - 1]?.close ?? 0;
      if (past <= 0) return undefined;
      return ((latest - past) / past) * 100;
    };

    return {
      netflow1h: one.net,
      netflow4h: four.net,
      takerBuyRatio1h: one.buyRatio,
      takerBuyRatio4h: four.buyRatio,
      priceChangePercent: {
        '1h': changeOver(1),
        '4h': changeOver(4),
        '24h': changeOver(24),
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Cross-sectional screens                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Liquidity / momentum screen over the whole universe.
   *
   * Returns symbols ordered by the requested ranking, filtered by turnover and
   * open interest so the model never wastes attention on illiquid contracts.
   */
  /**
   * **全量候选行**（不排序、不截断）—— 给**分层漏斗**用。
   *
   * ## 为什么需要它（而不是复用 `screenUniverse`）
   *
   * `screenUniverse` 做的是"**一层**排序 + 截断"，而漏斗要的是
   * "**先拿到全市场**，然后按自己的多层规则逐层收敛"。
   *
   * 两者不能互相替代：
   *
   * | | screenUniverse | 本方法 |
   * |---|---|---|
   * | 返回 | `string[]`（已排序、已截断）| **完整行**（含数值，供漏斗判断）|
   * | 阈值 | 调用方给 | **不设** —— 由漏斗的每一层决定 |
   * | 排序 | 有 | **无** —— 由漏斗的每一层决定 |
   *
   * ⚠️ 若复用 `screenUniverse`，那它的 `minQuoteVolume24h` 会**先砍掉一批**，
   * 而漏斗的第一层**恰恰就是"流动性"** —— 那样漏斗就永远看不到被砍掉的那些，
   * 于是"**每层淘汰了多少**"这个可解释性就没了（它会显示 0）。
   *
   * 走 `getUniverse(false)`（用缓存）：同一轮里 `screenUniverse` 可能已经拉过一次，
   * **不重复强制刷新**（省一次全市场请求）。
   */
  async screenUniverseRows(): Promise<FunnelCandidate[]> {
    const universe = await this.getUniverse(false);
    const rows: FunnelCandidate[] = [];

    for (const [symbol, ticker] of universe.tickers) {
      if (!this.registry.get(symbol)) continue; // 不是可交易的 USDT-M 永续
      const quoteVolume24h = Number(ticker.quoteVolume);
      const changePercent24h = Number(ticker.priceChangePercent);
      const high = Number(ticker.highPrice);
      const low = Number(ticker.lowPrice);
      rows.push({
        symbol,
        quoteVolume24h,
        changePercent24h,
        amplitudePercent: low > 0 && Number.isFinite(high) ? ((high - low) / low) * 100 : Number.NaN,
      });
    }
    return rows;
  }

  /**
   * 按各维度给候选池排序取头部。
   *
   * ## ⚠️ 这里**没有** `minOpenInterestUsd` 参数（外部 issue #182）
   *
   * 它原来在这里被声明接收 —— 但**筛选体从不读它**，因为持仓量根本不在
   * `BinanceTicker24h` 里（那是 24h 行情快照，持仓量要另外调 `openInterestHist`，
   * **每个币一次请求**）。所以在这一层无法生效。
   *
   * "声明了却不读"比"没有这个参数"更糟：调用方以为传了就生效了
   *（`coins.ts` 有四处这么传），而它真正该生效的地方是
   * `screenOpenInterestGrowth` —— 那里**已经**在拉 OI 历史，数据就在手里。
   *
   * 所以参数被移除，而不是留在这里当摆设。门槛现在只在 OI 增长榜生效
   *（见 `filterByMinOpenInterest` 的说明）。
   */
  async screenUniverse(options: {
    rank: 'quote_volume' | 'gainers' | 'losers' | 'volatility' | 'funding_extreme';
    limit: number;
    minQuoteVolume24h: number;
    exclude?: ReadonlySet<string>;
  }): Promise<string[]> {
    const universe = await this.getUniverse(true);

    const candidates: Array<{ symbol: string; score: number }> = [];

    for (const [symbol, ticker] of universe.tickers) {
      if (!this.registry.get(symbol)) continue; // not a tradable USDT-M perp
      if (options.exclude?.has(symbol)) continue;

      const quoteVolume = Number(ticker.quoteVolume);
      if (!Number.isFinite(quoteVolume) || quoteVolume < options.minQuoteVolume24h) continue;

      const high = Number(ticker.highPrice);
      const low = Number(ticker.lowPrice);
      const changePercent = Number(ticker.priceChangePercent);
      if (!Number.isFinite(changePercent)) continue;

      let score: number;
      switch (options.rank) {
        case 'quote_volume':
          score = quoteVolume;
          break;
        case 'gainers':
          score = changePercent;
          break;
        case 'losers':
          score = -changePercent;
          break;
        case 'volatility':
          score = low > 0 ? (high - low) / low : 0;
          break;
        case 'funding_extreme': {
          const funding = Number(universe.premiums.get(symbol)?.lastFundingRate ?? 0);
          score = Number.isFinite(funding) ? Math.abs(funding) : 0;
          break;
        }
        default:
          score = quoteVolume;
      }

      candidates.push({ symbol, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, options.limit).map((c) => c.symbol);
  }

  /**
   * ⚠️ **全市场概览** —— 币安**全部可交易 USDT 永续**的一行摘要（第 0 层「全景」）。
   *
   * ## 为什么需要它（用户 2026-09-30 的原话）
   *
   * > 「币安支持的币种我觉得都应该在模型判断得范围（当然不是一次性给所有币种行情数据）」
   *
   * 在此之前模型的视野**只有候选池那 20 个**（约占全市场 527 个的 **3.8%**），
   * 它无从知道外面还有什么 —— 那正是"只做大盘币、抓不住异动"的根源，
   * 也是"系统替模型做了决定"（用户原则：**模型是大脑，系统只是手脚**）。
   *
   * ## 与 `screenUniverse()` 的关键区别
   *
   * 那个会按成交额/持仓量**门槛过滤**，只留"够格当候选"的；而这里要的是**完整清单** ——
   * 连成交额很小的也要在。因为"这个标的成交额很小"**本身就是模型该知道的事实**，
   * 而不是系统替它藏起来的东西。排序按成交额降序，让它先看到活跃的。
   *
   * 走 `getUniverse()` 的**缓存**（不 force）：同一轮里 `screenUniverse()` 已经拉过一次，
   * 所以这里**不产生额外请求**。
   */
  async fullMarketOverview(): Promise<
    Array<{ symbol: string; price: number; changePercent24h: number; quoteVolume24h: number }>
  > {
    const universe = await this.getUniverse();
    const rows: Array<{
      symbol: string;
      price: number;
      changePercent24h: number;
      quoteVolume24h: number;
    }> = [];
    for (const [symbol, ticker] of universe.tickers) {
      /* 只保留**可交易的 USDT-M 永续** —— `registry` 是这件事的权威。 */
      if (!this.registry.get(symbol)) continue;
      const price = Number(ticker.lastPrice);
      if (!Number.isFinite(price) || price <= 0) continue;
      const changePercent24h = Number(ticker.priceChangePercent);
      const quoteVolume24h = Number(ticker.quoteVolume);
      rows.push({
        symbol,
        price,
        changePercent24h: Number.isFinite(changePercent24h) ? changePercent24h : 0,
        quoteVolume24h: Number.isFinite(quoteVolume24h) ? quoteVolume24h : 0,
      });
    }
    rows.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
    return rows;
  }

  /**
   * 第 1 层「聚焦」：各维度的 Top 榜（成交额/涨幅/跌幅/波动率/资金费极值）。
   *
   * ## 为什么是一个方法，而不是按维度调五次 `screenUniverse()`
   *
   * `screenUniverse()` 内部走 `getUniverse(true)` —— **强制刷新**。
   * 按维度调五次 = **五次全市场 ticker 拉取（weight 40 × 5）**，纯浪费。
   * 这里与 `fullMarketOverview()` 共用**同一份缓存的 universe**，所以**不产生额外请求**，
   * 排序全部在内存里由纯函数 `rankUniverse()` 完成（可穷举测试）。
   *
   * `minQuoteVolume24h` 由**调用方**从策略配置传入：门槛是策略参数，不是市场层的判断。
   */
  async topRankings(
    options: { limit?: number; minQuoteVolume24h?: number } = {},
  ): Promise<UniverseRankings> {
    const universe = await this.getUniverse();
    const tickers: RankableTicker[] = [];
    for (const [symbol, t] of universe.tickers) {
      if (!this.registry.get(symbol)) continue;
      tickers.push({
        symbol,
        price: Number(t.lastPrice),
        low24h: Number(t.lowPrice),
        high24h: Number(t.highPrice),
        changePercent24h: Number(t.priceChangePercent),
        quoteVolume24h: Number(t.quoteVolume),
        fundingRate: Number(universe.premiums.get(symbol)?.lastFundingRate ?? 0),
      });
    }
    return rankUniverse({
      tickers,
      limit: options.limit ?? 8,
      minQuoteVolume24h: options.minQuoteVolume24h ?? 50_000_000,
    });
  }

  /**
   * 第 3 层「索取」：**按模型给的条件筛全市场**。
   *
   * ⚠️ 与 `fullMarketOverview()` / `topRankings()` 共用**同一份缓存的 universe**，
   * 所以**不产生额外请求** —— 模型多要一次筛选的代价只有那几行文本。
   *
   * 上限由这里把关（见 `SCREEN_MAX_LIMIT`）：条件由模型决定，最多给几个由系统定。
   */
  async screenSymbolsForModel(criteria: ScreenCriteria): Promise<ScreenableSymbol[]> {
    const universe = await this.getUniverse();
    const symbols: ScreenableSymbol[] = [];
    for (const [symbol, t] of universe.tickers) {
      if (!this.registry.get(symbol)) continue;
      const low = Number(t.lowPrice);
      const high = Number(t.highPrice);
      symbols.push({
        symbol,
        changePercent24h: Number(t.priceChangePercent),
        quoteVolume24h: Number(t.quoteVolume),
        amplitudePercent: low > 0 ? ((high - low) / low) * 100 : 0,
      });
    }
    return screenSymbols({
      symbols,
      criteria,
      defaultLimit: SCREEN_DEFAULT_LIMIT,
      maxLimit: SCREEN_MAX_LIMIT,
    });
  }

  /**
   * Symbols with the fastest open-interest growth.
   *
   * Open-interest history costs one request per symbol, so this is deliberately
   * bounded: pre-filter to the most liquid symbols, then rank by OI change.
   */
  async screenOpenInterestGrowth(options: {
    limit: number;
    windowHours: number;
    minQuoteVolume24h: number;
    minOpenInterestUsd: number;
    prefilterSize?: number;
    exclude?: ReadonlySet<string>;
  }): Promise<string[]> {
    const prefilterSize = options.prefilterSize ?? Math.max(options.limit * 4, 20);

    const liquid = await this.screenUniverse({
      rank: 'quote_volume',
      limit: prefilterSize,
      minQuoteVolume24h: options.minQuoteVolume24h,
      /*
       * ⚠️ **不再往这里传 `minOpenInterestUsd`**（外部 issue #182）：
       * `screenUniverse` 拿不到持仓量（ticker 里没有），传了也读不到。
       * 门槛在下面的 `filterByMinOpenInterest` 里**真正生效** ——
       * 那时已经拉过 OI 历史，数据就在手里。
       */
      ...(options.exclude ? { exclude: options.exclude } : {}),
    });

    const period = options.windowHours <= 1 ? '5m' : options.windowHours <= 4 ? '1h' : '4h';
    const pointsNeeded = options.windowHours <= 1 ? 13 : options.windowHours <= 4 ? 5 : 7;

    const measured = await Promise.all(
      liquid.map(async (symbol) => {
        const hist = await this.market.openInterestHist(symbol, period, pointsNeeded + 2);
        if (hist.length < 2) return { symbol, growth: 0, openInterestUsd: 0 };
        const first = Number(hist[0]?.sumOpenInterest ?? 0);
        const last = Number(hist[hist.length - 1]?.sumOpenInterest ?? 0);
        return {
          symbol,
          /* 分母不可用时归 0，而不是把 Infinity 传给排序（见 `growthPercent`）。 */
          growth: growthPercent(first, last),
          /*
           * ⚠️ **把持仓量带出来** —— 它正是 `minOpenInterestUsd` 要筛的东西
           *（外部 issue #182）。原来这里只算 growth 就丢掉，于是那道护栏
           * 即使想生效也无从下手。
           */
          openInterestUsd: last,
        };
      }),
    );

    /*
     * ⚠️ **持仓量门槛在这里生效**（外部 issue #182）。
     *
     * `minOpenInterestUsd` 此前被 `screenUniverse` 接收、被本方法转发、
     * 还被 `autoTrader.ts` 写进给操作员的门槛提示 —— 但**筛选体从不读它**。
     *
     * 而它最该生效的就是这里：`growth = (last-first)/first`，
     * **分母极小时那个比值天然是噪声**（一点点资金进出就是 +300%），
     * 这道护栏本就是为了把这类假信号挡住。
     */
    return filterByMinOpenInterest(measured, options.minOpenInterestUsd)
      .filter((m) => m.growth > 0)
      .sort((a, b) => b.growth - a.growth)
      .slice(0, options.limit)
      .map((m) => m.symbol);
  }

  /** Ranking table appended to the prompt when `enableOiRanking` is on. */
  async getOiRanking(limit: number, excludeMajor = false): Promise<OiRankRow[]> {
    const universe = await this.getUniverse();
    const rows: OiRankRow[] = [];

    const symbols = [...universe.tickers.keys()]
      .filter((s) => this.registry.get(s))
      .filter((s) => !excludeMajor || !this.registry.isMajor(s))
      .slice(0, 40);

    const history = await Promise.all(
      symbols.map(async (symbol) => {
        const hist = await this.market.openInterestHist(symbol, '1h', 5).catch(() => []);
        if (hist.length < 2) return null;
        const first = Number(hist[0]?.sumOpenInterest ?? 0);
        const last = Number(hist[hist.length - 1]?.sumOpenInterest ?? 0);
        if (first <= 0) return null;
        const price = Number(universe.tickers.get(symbol)?.lastPrice ?? 0);
        return {
          symbol,
          openInterestUsd: last * price,
          changePercent: ((last - first) / first) * 100,
          priceChangePercent: Number(universe.tickers.get(symbol)?.priceChangePercent ?? 0),
        } satisfies OiRankRow;
      }),
    );

    for (const row of history) {
      if (row) rows.push(row);
    }

    return rows.sort((a, b) => b.changePercent - a.changePercent).slice(0, limit);
  }
}

/** Bars per hour for a timeframe, used to size rolling windows. */
function klinesPerHour(timeframe: Timeframe): number {
  switch (timeframe) {
    case '1m':
      return 60;
    case '3m':
      return 20;
    case '5m':
      return 12;
    case '15m':
      return 4;
    case '30m':
      return 2;
    case '1h':
      return 1;
    case '2h':
      return 0.5;
    case '4h':
      return 0.25;
    case '6h':
      return 1 / 6;
    case '12h':
      return 1 / 12;
    case '1d':
      return 1 / 24;
    default:
      return 12;
  }
}
