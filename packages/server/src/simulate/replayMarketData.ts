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

  /*
   * ⚠️ **`getKlines` 有真实数据可用** —— 回放源的 K 线就在 `this.visible()` 里
   *（`buildSnapshots` 用的就是它）。
   *
   * ⚠️ 所以这里**不能返回空数组**：`AutoTrader` 用它回答"那张挂单在等待期间
   * 会不会被成交"（`:3332` 附近的 `canceledChecks`）。返回空 ⇒ `after.length === 0`
   * ⇒ **那个检查静默失效**，而它包在 `try/catch` 里，**连日志都没有**。
   *
   * ⚠️ 这正是 `sim` 该验证的接缝之一：一个"永远说不会成交"的回放会让
   * "限价单超时撤销"那条路径**永远不被走到**。
   *
   * `limit` 按 `AutoTrader` 的调用口径截断（它要 500 根）——
   * 与真实 `MarketDataService.getKlines` 的语义一致：**取最近 N 根**。
   */
  async getKlines(symbol: string, timeframe: Timeframe, limit: number): Promise<Kline[]> {
    const all = this.visible(symbol, timeframe);
    return limit >= all.length ? all : all.slice(all.length - limit);
  }

  /*
   * ⚠️ **回放里没有"行情标记价"这个概念** —— 回放的 K 线是**确定性夹具**，
   * 而 `markPricesOf` 的用途是"给交易所没有的本地持仓补一个标记价"
   *（`buildEquitySnapshot` 的回落路径，见那里的注释）。
   *
   * ⚠️ 返回**空 Map** 是**正确**的语义：它表示"查不到"，
   * 于是 `ownUnrealizedPnlOf` 会把那些标的记进 `missingMarkPrice` 并按 0 计浮盈 ——
   * 与回落路径引入之前的行为**完全一致**。
   *
   * ⚠️ 但**不能直接不实现**：`AutoTrader` 会 `await this.deps.marketData.markPricesOf(...)`，
   * 缺了它就是**同步 TypeError**，而 `.catch()` 兜不住 ——
   * `recordEquity` 整个抛错，权益快照一行都写不进去。
   *
   * ⚠️ **实测代价（2026-10-15）**：`npm run sim` 从 18/18 掉到 **17/18**
   *（「权益曲线持续记录：记录了 0 个权益快照（单点）」）——
   * 而**根因不是这个桩**，是下面那条类型断言**从来没生效过**（见文件末）。
   */
  async markPricesOf(): Promise<Map<string, number>> {
    return new Map();
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
 *
 * ## ⚠️⚠️ 但它**从来没生效过**（2026-10-15 实测）
 *
 * 上面那段说明写得很对，**而实现是错的**：
 *
 * ```ts
 * type MissingFromReplay = Exclude<keyof MarketDataService, keyof ReplayMarketData>;
 * export type ReplayMarketDataIsCompatible = MissingFromReplay extends never ? true : never;
 * ```
 *
 * ⚠️ **一个类型别名不产生任何编译错误** —— 它只是"算出来一个类型"，
 * 而这个类型**从没被用在任何变量、参数或返回值上**（我全仓 grep 过：
 * `ReplayMarketDataIsCompatible` **只有定义处**）。
 *
 * 所以"编译期失败"的承诺**是空的**：`MarketDataService` 加了 `markPricesOf` 之后，
 * `typecheck` 照样绿，而 `npm run sim` 掉到 **17/18**
 *（「权益曲线持续记录：记录了 0 个权益快照」）。
 *
 * ⚠️ **这与本仓库反复出现的形态完全同族**：
 * 工具造好了、注释写清了"它会拦住 X"，**而它从没接上** ——
 * 于是所有人以为有防线，实际上没有。
 *
 * ## 修法：把它变成一个**真的会失败的赋值**
 *
 * `const _check: <期望类型> = <值>` 会在不匹配时报 `TS2322` —— 那才是断言。
 *
 * ## ⚠️ 但"全量 `keyof`"这个口径**过严**（我改成真断言之后立刻发现了）
 *
 * 打开断言后它报出 4 个"缺失"：`getKlines` / `buildSnapshot` /
 * `screenUniverseRows` / `switch`。**逐个查过之后只有一个是真问题**：
 *
 * | 成员 | 实情 |
 * | --- | --- |
 * | `getKlines` | ✅ **真缺失** —— `AutoTrader` 真的调它（`:3332` / `:3654`）|
 * | `buildSnapshot`（单数）| ❌ **内部实现细节** —— 只在 `service.ts:301` 被 `buildSnapshots` 自己调用 |
 * | `screenUniverseRows` | ❌ 由 `strategy/coins.ts:193` 调用，**不在 `AutoTrader` 的依赖面上** |
 * | `switch` | ❌ 我的提取正则误抓（它不是 `MarketDataService` 的方法）|
 *
 * ⚠️ **要求回放桩实现"内部实现细节"是错的** —— 那会逼着桩去模仿私有实现，
 * 而它只需要满足**调用方的形状**。所以口径改成"**`AutoTrader` 实际调用的那些**"。
 *
 * ⚠️ 这与本仓库反复出现的"判据过严 → 误报"是同一类（第 24/39/42 轮各一次）：
 * **判据要么漏、要么严，两端都要用真实代码校准。**
 */
type MissingFromReplay = Exclude<keyof AutoTraderMarketDataSurface, keyof ReplayMarketData>;

/**
 * `AutoTrader` 真正会调用的 `MarketDataService` 成员。
 *
 * ⚠️ 这份清单**必须与 `autoTrader.ts` 里的调用点同步** ——
 * 它是"回放桩需要满足的形状"，而不是"`MarketDataService` 的全部 public 成员"。
 *
 * 来源（`grep 'marketData\.' autoTrader.ts`）：
 * `buildSnapshots` / `fullMarketOverview` / `getOiRanking` / `getKlines` /
 * `screenSymbolsForModel` / `markPricesOf`
 */
type AutoTraderMarketDataSurface = Pick<
  MarketDataService,
  | 'buildSnapshots'
  | 'fullMarketOverview'
  | 'getOiRanking'
  | 'getKlines'
  | 'screenSymbolsForModel'
  | 'markPricesOf'
>;

/**
 * ⚠️ **这一行才是断言**（`type` 那行只是算类型）。
 *
 * 它要求"缺失的成员恰好是 `never`" —— 若 `ReplayMarketData` 少实现任何一个
 * `AutoTrader` 会调用的成员，`MissingFromReplay` 就不是 `never`，
 * 这里会报 **`TS2322`**，`npm run typecheck` 当场失败。
 *
 * ⚠️ 故意用 `void` 消费掉它，避免"声明未使用"的 lint 噪音。
 */
const _replayIsCompatible: MissingFromReplay extends never ? true : never = true;
void _replayIsCompatible;

/**
 * 保留这个名字（可能有外部引用），并把它绑到上面那个**真的会检查**的常量上。
 *
 * ⚠️ 单独保留一个 `type` 是**不够的** —— 见上面那段"从来没生效过"的说明。
 */
export type ReplayMarketDataIsCompatible = typeof _replayIsCompatible;
