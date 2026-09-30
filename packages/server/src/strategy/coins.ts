import { normalizeSymbol, type StrategyConfig } from '@aq/shared';
import type { MarketDataService } from '../market/service.js';
import { createLogger } from '../logger.js';
import { candidateBudget, estimateCandidateChars, PROMPT_TOKEN_BUDGET } from './prompt.js';

const log = createLogger('strategy:coins');

/** 上一次记下的候选池裁剪文案 —— 见下方 log.warn 处的说明。文案没变就不再记。 */
let lastTrimNotice: string | null = null;

export interface CoinSelectionResult {
  symbols: string[];
  /** Which sources nominated each symbol — surfaced to the model as signal strength. */
  sourcesBySymbol: Map<string, string[]>;
  /**
   * How many symbols were dropped by the prompt-token budget, when it bit.
   * The console reports this so a trimmed universe never looks like "the market
   * had nothing" — it means the strategy is too heavy for its own candidate pool.
   */
  trimmedFrom: number | null;
  /** The candidate ceiling the budget produced, for display. */
  budget: number;
}

/**
 * Build the candidate universe for one decision cycle.
 *
 * Mirrors the four documented modes. The important behavioural detail is in
 * `mixed`: a symbol nominated by more than one screen keeps **all** of its
 * source tags, because "the liquidity screen and the open-interest screen both
 * picked this" is genuinely stronger evidence than either alone, and the prompt
 * renders those tags next to the symbol.
 *
 * Symbols with an open position are always included regardless of mode — the
 * model must be able to see and manage what it already holds, even if the
 * symbol has dropped out of the screens.
 */
export async function selectCandidates(
  config: StrategyConfig,
  market: MarketDataService,
  options: {
    mustInclude?: Iterable<string>;
    /**
     * ⚠️ **优先入选** —— 共识标的（多个榜同时指向的）与模型点名的标的。
     *
     * 与 `mustInclude` 的区别**很重要**：
     *   · `mustInclude` 是**必保**（持仓）—— 模型必须能管理自己手上的东西，
     *     裁掉它就只能盲目持有；
     *   · 这一组是**优先** —— 排在候选池最前、最可能进池，但**预算不够时可以让位**。
     *
     * 把它们塞进 `mustInclude` 会让候选池**无声膨胀**：`mustKeep` 替它们占位，
     * 裁剪就再也裁不到它们。实测后果 —— 候选数 20 → 25、
     * 提示词 229,567 → 288,523 字符、决策耗时 145 秒 → 397 秒（6.6 分钟）。
     *
     * **优先 ≠ 必保。**
     */
    preferred?: Iterable<string>;
    /**
     * 提示词 token 预算。省略 = 保守默认（6 万）。
     *
     * 调用方应当传 `promptTokenBudget(model.inputTokenLimit)` —— 候选池的大小
     * 直接由它决定，而模型能吃多大是已知的（见 `ai_models.input_token_limit`）。
     */
    budgetTokens?: number;
  } = {},
): Promise<CoinSelectionResult> {
  const sourcesBySymbol = new Map<string, string[]>();

  const add = (symbolInput: string, source: string): void => {
    const symbol = normalizeSymbol(symbolInput);
    if (!symbol) return;
    const existing = sourcesBySymbol.get(symbol);
    if (existing) {
      if (!existing.includes(source)) existing.push(source);
    } else {
      sourcesBySymbol.set(symbol, [source]);
    }
  };

  /*
   * ⚠️ **模型点名/共识的标的先加** —— `sourcesBySymbol` 的**顺序就是优先级**，
   * 而 `symbols = [...sourcesBySymbol.keys()]` 与后续裁剪都按它走。
   * 放在 switch 之前意味着它们排在系统选出的候选**前面**。
   */
  for (const symbol of options.preferred ?? []) add(symbol, 'ai_requested');

  const { coinSource } = config;

  try {
    switch (coinSource.sourceType) {
      case 'static':
        for (const symbol of coinSource.staticCoins) add(symbol, 'static');
        break;

      case 'coinpool': {
        const symbols = await market.screenUniverse({
          rank: coinSource.coinPoolRank,
          limit: coinSource.coinPoolLimit,
          minQuoteVolume24h: coinSource.minQuoteVolume24h,
          minOpenInterestUsd: coinSource.minOpenInterestUsd,
        });
        for (const symbol of symbols) add(symbol, 'coinpool');
        break;
      }

      case 'oi_top': {
        const symbols = await market.screenOpenInterestGrowth({
          limit: coinSource.oiTopLimit,
          windowHours: coinSource.oiTopWindowHours,
          minQuoteVolume24h: coinSource.minQuoteVolume24h,
          minOpenInterestUsd: coinSource.minOpenInterestUsd,
        });
        for (const symbol of symbols) add(symbol, 'oi_top');
        break;
      }

      case 'mixed': {
        if (coinSource.useCoinPool) {
          const symbols = await market
            .screenUniverse({
              rank: coinSource.coinPoolRank,
              limit: coinSource.coinPoolLimit,
              minQuoteVolume24h: coinSource.minQuoteVolume24h,
              minOpenInterestUsd: coinSource.minOpenInterestUsd,
            })
            .catch((error) => {
              log.warn(`按成交额筛选候选池失败：${(error as Error).message}`);
              return [] as string[];
            });
          for (const symbol of symbols) add(symbol, 'coinpool');
        }

        if (coinSource.useOITop) {
          const symbols = await market
            .screenOpenInterestGrowth({
              limit: coinSource.oiTopLimit,
              windowHours: coinSource.oiTopWindowHours,
              minQuoteVolume24h: coinSource.minQuoteVolume24h,
              minOpenInterestUsd: coinSource.minOpenInterestUsd,
            })
            .catch((error) => {
              log.warn(`按持仓量增长筛选候选池失败：${(error as Error).message}`);
              return [] as string[];
            });
          for (const symbol of symbols) add(symbol, 'oi_top');
        }

        for (const symbol of coinSource.staticCoins) add(symbol, 'static');
        break;
      }
    }
  } catch (error) {
    log.error(`选币失败：${(error as Error).message}`);
  }

  // Existing positions are non-negotiable members of the universe.
  for (const symbol of options.mustInclude ?? []) add(symbol, 'position');

  /*
   * **BTC 无条件加入候选池。**
   *
   * 它不只是"顺带看一眼的大盘"，而是提示词里 `# BTC 市场概览` 那一整块的**唯一来源**：
   * `prompt.ts` 找不到 BTCUSDT 快照就整段不渲染。于是模型会**安静地失去大盘背景**
   * —— 而它不会知道"这块本来应该有"。
   *
   * 原来这里的条件是 `enableOiRanking || sourcesBySymbol.size === 0`，而紧挨着的
   * 注释却写着"majors 永远值得看一眼……BTC 概览依赖它在场"。**注释描述的是无条件，
   * 代码写的是有条件**：用 `coinpool` 或 `mixed` 且开了 OI 排行之外的配置时，
   * BTC 可能压根不在池子里 —— 而那种配置恰恰是最需要大盘背景的（选的是山寨）。
   *
   * 成本是一个候选位的 token；丢掉的是模型对"现在是不是该出手"的整体判断。
   */
  add('BTCUSDT', 'reference');

  const symbols = [...sourcesBySymbol.keys()];

  /*
   * Cap the universe so the prompt fits the token budget.
   *
   * The limit comes **only** from the strategy and the budget: a candidate costs
   * `timeframes × series × rendered points`, so a 3-timeframe scalping config
   * with every indicator on is several times heavier per symbol than a
   * 2-timeframe one. `candidateBudget()` accounts for that.
   *
   * ⚠️ **这里原来还有一个写死的 `hardCap = 40`，已删除。** 它是 `candidateBudget()`
   * 出现之前的兜底（当时的注释写着"A fixed cap of 40 therefore allowed a
   * 128k-token prompt"）—— 而现在预算是按策略算出来的，再叠一个固定上限只会
   * **把已经算准的预算又砍掉**：实测一个 4 周期策略的预算是 7 个候选，而一旦
   * 模型上限被填对、预算升到 20 万，`hardCap` 就成了"40 个封顶"的隐形天花板，
   * 与"让 AI 有得选"直接冲突。
   *
   * 成本的上界由 `PROMPT_TOKEN_CEILING` 负责，不在这一层重复设限。
   *
   * Position symbols are never dropped: the model must be able to manage what it
   * already holds, whatever the budget says.
   */
  const maxCandidates = candidateBudget(config, options.budgetTokens);
  /*
   * ⚠️ **BTC 也要在 `mustKeep` 里，否则上面的"无条件加入"只做了一半。**
   *
   * 实测抓到的：`add('BTCUSDT', 'reference')` 确实把它放进了池子（21 个里有它），
   * 但**裁剪这一步只保护 `mustInclude`（持仓标的）**，于是 BTC 在池子超过预算时
   * 被当成"最弱的那些"丢掉 —— 而它在序列里排第 1，`drop.slice()` 恰好留不下它。
   *
   * 结果与"压根没加"完全一样：`prompt.ts` 的 `# BTC 市场概览` 找不到快照就
   * **整段不渲染**，模型安静地失去大盘背景。而这一条极难从表面发现 ——
   * 候选池里有 7 个标的、周期照常跑、什么错都不报。
   *
   * 所以"无条件入选"必须同时成立两次：**进池子** 与 **过裁剪**。
   */
  const mustKeep = new Set([...(options.mustInclude ?? [])].map(normalizeSymbol));
  mustKeep.add('BTCUSDT');

  let trimmed = symbols;
  if (symbols.length > maxCandidates) {
    const keep: string[] = [];
    const drop: string[] = [];
    for (const symbol of symbols) (mustKeep.has(symbol) ? keep : drop).push(symbol);
    trimmed = [...keep, ...drop.slice(0, Math.max(0, maxCandidates - keep.length))];
    /*
     * 只在**裁剪结果发生变化**时记一条。
     *
     * 这个裁剪在每个周期都会发生（策略配了 25 个候选、预算只容得下 11 个），
     * 按事件每轮写一次的结果是日志被同一句话填满 —— 实测一小时 21 条，
     * 而真正的异常会被埋掉。**一个每轮都响的警告等于没有警告。**
     *
     * 文案里带了具体数字，所以按文案去重等于"数字变了才重新记"，
     * 既不会刷屏，也不会漏掉候选数或预算的实质变化。
     */
    const notice =
      `候选池按提示词预算从 ${symbols.length} 个裁剪到 ${trimmed.length} 个` +
      `（该策略下每个标的约占 ${Math.round(estimateCandidateChars(config) / 1.7)} tokens，` +
      `预算 ${PROMPT_TOKEN_BUDGET} tokens）`;
    if (lastTrimNotice !== notice) {
      lastTrimNotice = notice;
      log.warn(notice);
    }
  }

  // Reported so the caller can tell the operator what the budget did.
  const trimmedFrom = symbols.length > trimmed.length ? symbols.length : null;

  // Final map must only contain the symbols we actually returned.
  const finalSources = new Map<string, string[]>();
  for (const symbol of trimmed) finalSources.set(symbol, sourcesBySymbol.get(symbol) ?? []);

  return { symbols: trimmed, sourcesBySymbol: finalSources, trimmedFrom, budget: maxCandidates };
}
