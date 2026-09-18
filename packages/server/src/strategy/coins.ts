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
  options: { mustInclude?: Iterable<string> } = {},
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

  // Majors are always worth a look: they set the context for everything else,
  // and the prompt's BTC overview section depends on BTCUSDT being present.
  if (config.indicators.enableOiRanking || sourcesBySymbol.size === 0) {
    add('BTCUSDT', 'reference');
  }

  const symbols = [...sourcesBySymbol.keys()];

  /*
   * Cap the universe so the prompt fits the token budget.
   *
   * The limit is derived from the strategy itself, not fixed: a candidate costs
   * `timeframes × series × rendered points`, so a 3-timeframe scalping config
   * with every indicator on is several times heavier per symbol than a
   * 2-timeframe one. A fixed cap of 40 therefore allowed a 128k-token prompt,
   * which is the failure mode this replaces — the model spent its whole output
   * budget reasoning about the input and returned nothing at all.
   *
   * Position symbols are never dropped: the model must be able to manage what it
   * already holds, whatever the budget says.
   */
  const budgeted = candidateBudget(config);
  const hardCap = 40;
  const maxCandidates = Math.min(budgeted, hardCap);
  const mustKeep = new Set([...(options.mustInclude ?? [])].map(normalizeSymbol));

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
