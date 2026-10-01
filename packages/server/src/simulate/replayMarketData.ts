import {
  isMajorSymbol,
  type IndicatorConfig,
  type Kline,
  type MarketSnapshot,
  type OiRankRow,
  type QuantContext,
  type Timeframe,
  type TimeframeIndicators,
} from '@aq/shared';
import type { SymbolRegistry } from '../binance/symbols.js';
import type { MarketDataService } from '../market/service.js';
import type { MarketOverviewRow } from '../strategy/prompt.js';
import type { UniverseRankings } from '../market/rankings.js';
import type { ScreenableSymbol } from '../market/screening.js';
import { computeTimeframeIndicators } from '../market/indicators.js';

/* -------------------------------------------------------------------------- */
/*  Replay market data                                                         */
/* -------------------------------------------------------------------------- */

export interface ReplaySource {
  /** Closed candles per timeframe, oldest first, covering the whole replay. */
  klines: Map<Timeframe, Kline[]>;
}

/**
 * A `MarketDataService` backed by recorded candles instead of the live API.
 *
 * Two properties matter for the simulation to be meaningful:
 *
 *  1. **No look-ahead.** At simulated time *t* only candles whose `closeTime`
 *     is at or before *t* are visible, and only the most recent `primaryCount`
 *     of them. The model therefore sees exactly what it would have seen live —
 *     a replay that leaks future candles produces beautiful, meaningless results.
 *  2. **The real indicator code.** Snapshots go through the same
 *     `computeTimeframeIndicators` the live path uses, so a replay exercises the
 *     production maths rather than a parallel implementation that can drift.
 *
 * Derivatives context (funding rate, open interest history) is not replayed and
 * is reported as absent rather than invented — the prompt renders it as `N/A`,
 * and the model is told nothing false.
 */
export class ReplayMarketData {
  private clock = 0;

  constructor(
    private readonly registry: SymbolRegistry,
    private readonly sources: Map<string, ReplaySource>,
  ) {}

  /** Advance the simulated clock. */
  setNow(timestamp: number): void {
    this.clock = timestamp;
  }

  get now(): number {
    return this.clock;
  }

  /** How many candles each timeframe has visible right now. */
  visibleCount(symbol: string, timeframe: Timeframe): number {
    return this.visible(symbol, timeframe).length;
  }

  private visible(symbol: string, timeframe: Timeframe): Kline[] {
    const all = this.sources.get(symbol)?.klines.get(timeframe) ?? [];
    if (this.clock === 0) return all;
    return all.filter((k) => k.closeTime <= this.clock);
  }

  async buildSnapshots(
    symbols: string[],
    config: IndicatorConfig,
    sourcesBySymbol: Map<string, string[]> = new Map(),
  ): Promise<MarketSnapshot[]> {
    const out: MarketSnapshot[] = [];
    for (const symbol of symbols) {
      const snapshot = this.buildOne(symbol, config, sourcesBySymbol.get(symbol) ?? []);
      if (snapshot) out.push(snapshot);
    }
    return out;
  }

  private buildOne(symbol: string, config: IndicatorConfig, sources: string[]): MarketSnapshot | null {
    const timeframes = config.kline.selectedTimeframes;
    const count = config.kline.primaryCount;

    const computed: TimeframeIndicators[] = timeframes.map((tf) =>
      computeTimeframeIndicators(tf, this.visible(symbol, tf).slice(-count), config),
    );

    const primaryIndex = Math.max(0, timeframes.indexOf(config.kline.primaryTimeframe));
    const primary = computed[primaryIndex] ?? computed[0];
    if (!primary || primary.klines.length === 0) return null;

    const price = primary.klines[primary.klines.length - 1]?.close ?? 0;
    if (!(price > 0)) return null;

    // 24h context derived from the primary timeframe's visible window.
    const dayCandles = this.visible(symbol, '1h').slice(-24);
    const first = dayCandles[0]?.open ?? price;
    const quoteVolume24h = dayCandles.reduce((sum, k) => sum + k.quoteVolume, 0);
    const high24h = dayCandles.length > 0 ? Math.max(...dayCandles.map((k) => k.high)) : price;
    const low24h = dayCandles.length > 0 ? Math.min(...dayCandles.map((k) => k.low)) : price;

    return {
      symbol,
      sources,
      price,
      quoteVolume24h,
      priceChangePercent24h: first > 0 ? ((price - first) / first) * 100 : 0,
      high24h,
      low24h,
      primary,
      isMajor: isMajorSymbol(symbol),
      timeframes: computed,
      derivatives: {
        openInterest: null,
        openInterestUsd: null,
        openInterestAvg: null,
        openInterestChangePercent: {},
        // Not replayed: a historical funding/OI feed is a separate data source.
        fundingRate: null,
        nextFundingTime: null,
        markPrice: price,
        indexPrice: price,
      },
      quant: config.enableQuantData ? this.buildQuant(primary) : null,
    };
  }

  private buildQuant(primary: TimeframeIndicators): QuantContext | null {
    const klines = primary.klines;
    if (klines.length === 0) return null;

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

    const one = summarise(klines.slice(-12));
    const four = summarise(klines.slice(-48));

    return {
      netflow1h: one.net,
      netflow4h: four.net,
      takerBuyRatio1h: one.buyRatio,
      takerBuyRatio4h: four.buyRatio,
      priceChangePercent: {},
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Screens — not used during a replay                                     */
  /* ---------------------------------------------------------------------- */

  async screenUniverse(): Promise<string[]> {
    return [];
  }

  async screenOpenInterestGrowth(): Promise<string[]> {
    return [];
  }

  async getOiRanking(): Promise<OiRankRow[]> {
    return [];
  }

  /*
   * ⚠️ **下面三个是"第 0/1/3 层"后加上来的，回放桩必须跟上。**
   *
   * 漏掉它们的后果**不是"少一段信息"**，而是每一轮决策都抛
   * `this.deps.marketData.fullMarketOverview is not a function` ——
   * 而那是**同步** TypeError，`autoTrader` 调用点的 `.catch()` **兜不住**
   * （早先在 `autoTrader.test.ts` 里踩过同一个坑）。
   *
   * 实测 2026-10-01：`npm run sim` 从文档记载的"全部通过"退化成 **6/18** ——
   * 80 轮决策全部失败、0 笔开仓，于是保护单、记账、权益曲线、风控拦截
   * **一整套端到端校验同时失效**。也就是说：**我们失去了接缝验证能力，
   * 而它退化的表现只是"分数变低"，看起来像市场安静。**
   *
   * 回放里这些屏幕**没有真实数据可用**，返回空/缺省即可 —— 它们只影响
   * 提示词里那几段渲染，不影响交易路径。
   */
  async fullMarketOverview(): Promise<MarketOverviewRow[]> {
    return [];
  }

  async topRankings(): Promise<UniverseRankings> {
    return { quoteVolume: [], gainers: [], losers: [], volatility: [], fundingExtreme: [] };
  }

  async screenSymbolsForModel(): Promise<ScreenableSymbol[]> {
    return [];
  }

  invalidate(): void {
    /* nothing cached */
  }
}

/**
 * 结构性断言：回放服务必须满足实时服务的**完整形状**。
 *
 * ## 为什么不再是手写清单
 *
 * 这里原来写的是
 *
 *     ReplayMarketData extends Pick<MarketDataService,
 *       'buildSnapshots' | 'getOiRanking' | 'screenUniverse' | 'screenOpenInterestGrowth'>
 *
 * —— 一份**手写的方法清单**。而 `MarketDataService` 会随功能长出新方法
 * （第 0 层加 `fullMarketOverview`、第 1 层加 `topRankings`、第 3 层加 `screenSymbolsForModel`），
 * 清单没人补。于是**类型检查一直绿，而 `npm run sim` 每轮在运行时抛
 * `is not a function`**（2026-10-01：6/18、0 笔开仓）。
 *
 * 所以改成**全量断言**：`ReplayMarketData` 少实现任何一个 public 成员，
 * 这里的 `Exclude` 就非 `never`，类型检查立刻失败。
 *
 * 这正是"一个永远不失败的校验会掩盖真正的回归"的反面用法 ——
 * 让它**在编译期就失败**，而不是在模拟跑完之后。
 */
type MissingFromReplay = Exclude<keyof MarketDataService, keyof ReplayMarketData>;
export type ReplayMarketDataIsCompatible = MissingFromReplay extends never ? true : never;
