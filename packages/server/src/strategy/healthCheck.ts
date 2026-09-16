import {
  closeReasonLabel,
  type Decision,
  type ExecutionLogEntry,
  type MarketSnapshot,
  type RejectedDecision,
  type StrategyConfig,
} from '@aq/shared';
import type { ExchangeConnection } from '../binance/bootstrap.js';
import type { LlmClient } from '../llm/client.js';
import { createLogger } from '../logger.js';
import { MarketDataService } from '../market/service.js';
import { RiskEngine } from '../risk/engine.js';
import { selectCandidates } from './coins.js';
import { parseDecisionResponse, hasDecisionBlock, sortDecisions } from './parser.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  emptyPromptMemory,
  estimateCandidateChars,
  estimateTokens,
  PROMPT_TOKEN_BUDGET,
} from './prompt.js';

const log = createLogger('strategy:check');

/* -------------------------------------------------------------------------- */
/*  Report shapes                                                              */
/* -------------------------------------------------------------------------- */

export interface CheckStage {
  name: string;
  ok: boolean;
  detail: string;
  /** Wall-clock cost of this stage, milliseconds. */
  ms: number;
}

export interface StrategyCheckSample {
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  cotTrace: string;
  /** What the model proposed, after structural validation. */
  decisions: Decision[];
  /** Proposals the validator refused outright. */
  rejected: RejectedDecision[];
  /** What the hard risk engine did with the surviving proposals. */
  approved: Decision[];
  riskRejected: Array<{ action: string; symbol: string; reason: string }>;
  executionLog: ExecutionLogEntry[];
  candidateSymbols: string[];
  /** Simulated account the review ran against. */
  simulatedEquity: number;
}

export interface StrategyCheckResult {
  ok: boolean;
  stages: CheckStage[];
  sample: StrategyCheckSample | null;
  /** One-line verdict for the console header. */
  verdict: string;
}

/* -------------------------------------------------------------------------- */
/*  The check                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Exercise a strategy end to end without touching an exchange or risking funds.
 *
 * The point is to answer the question "would this strategy actually work?" before
 * a trader is ever started, and to separate the two very different failure modes:
 *
 *  - **the model is unreachable or returned something unparseable**, which the
 *    prompt or the model choice has to fix; and
 *  - **the model responded fine but the runtime refused every proposal**, which
 *    means the risk limits are too tight for the strategy's own prompts.
 *
 * Those look identical from the outside (a trader that does nothing), so the
 * report keeps them apart stage by stage.
 *
 * Market data comes from the live public endpoint; the account is **simulated**
 * (a fixed equity) so no exchange credentials are needed at all.
 */
export async function checkStrategy(options: {
  config: StrategyConfig;
  connection: ExchangeConnection;
  client: LlmClient;
  /** Fix the universe to one symbol — useful for a fast, focused check. */
  symbol?: string;
  simulatedEquity?: number;
}): Promise<StrategyCheckResult> {
  const stages: CheckStage[] = [];
  const equity = options.simulatedEquity ?? 1000;

  const record = <T>(name: string, startedAt: number, result: { ok: boolean; detail: string }, extra?: T): T | undefined => {
    stages.push({ name, ok: result.ok, detail: result.detail, ms: Date.now() - startedAt });
    return extra;
  };

  const marketData = new MarketDataService(options.connection.market, options.connection.registry);

  /* --- 1. Exchange connectivity + contract metadata --------------------- */
  let t = Date.now();
  record('交易所连接与合约元数据', t, {
    ok: options.connection.registry.size > 0,
    detail: `${options.connection.endpoints.label}，${options.connection.registry.size} 个可交易合约，时钟偏移 ${options.connection.clockOffsetMs}ms。`,
  });
  if (options.connection.registry.size === 0) {
    return { ok: false, stages, sample: null, verdict: '无法加载合约元数据，请检查网络。' };
  }

  /* --- 2. Candidate selection ------------------------------------------- */
  t = Date.now();
  let symbols: string[];
  let sourcesBySymbol: Map<string, string[]>;
  /** Set when the prompt budget capped the universe, so the stage can say so. */
  let trimmedFrom: number | null = null;
  let candidateCap = 0;
  try {
    if (options.symbol) {
      symbols = [options.symbol];
      sourcesBySymbol = new Map([[options.symbol, ['手动指定']]]);
    } else {
      const selection = await selectCandidates(options.config, marketData);
      symbols = selection.symbols;
      sourcesBySymbol = selection.sourcesBySymbol;
      trimmedFrom = selection.trimmedFrom;
      candidateCap = selection.budget;
    }

    const perCandidateTokens = estimateTokens('x'.repeat(estimateCandidateChars(options.config)));
    record('选出候选标的', t, {
      ok: symbols.length > 0,
      detail:
        symbols.length > 0
          ? `选出 ${symbols.length} 个标的：${symbols.slice(0, 10).join('、')}${symbols.length > 10 ? ' 等' : ''}。` +
            (trimmedFrom
              ? ` 提示词预算把候选池从 ${trimmedFrom} 个裁剪到 ${candidateCap} 个（该策略下每个标的约占 ${perCandidateTokens.toLocaleString('en-US')} tokens）。`
              : ` 该策略下每个标的约占 ${perCandidateTokens.toLocaleString('en-US')} tokens，预算上限 ${candidateCap} 个标的。`)
          : '没有选出任何标的。请检查选币来源、成交量门槛与持仓量门槛。',
    });
  } catch (error) {
    record('选出候选标的', t, { ok: false, detail: `选币失败：${(error as Error).message}` });
    return { ok: false, stages, sample: null, verdict: '选币阶段失败。' };
  }
  if (symbols.length === 0) {
    return { ok: false, stages, sample: null, verdict: '策略没有选出任何候选标的，模型将无事可做。' };
  }

  /* --- 3. Market snapshots + indicators --------------------------------- */
  t = Date.now();
  let snapshots: MarketSnapshot[];
  try {
    snapshots = await marketData.buildSnapshots(symbols, options.config.indicators, sourcesBySymbol);
  } catch (error) {
    record('组装行情与指标', t, { ok: false, detail: `行情获取失败：${(error as Error).message}` });
    return { ok: false, stages, sample: null, verdict: '行情阶段失败。' };
  }

  const missingIndicators = snapshots.filter((s) => s.primary.klines.length === 0);
  record('组装行情与指标', t, {
    ok: snapshots.length > 0,
    detail:
      snapshots.length === 0
        ? '未能构建任何行情快照。'
        : `构建了 ${snapshots.length} 个行情快照，周期 ${options.config.indicators.kline.selectedTimeframes.join('/')}，每个周期 ${options.config.indicators.kline.primaryCount} 根K线。` +
          (missingIndicators.length > 0 ? ` 其中 ${missingIndicators.length} 个缺少K线数据。` : ''),
  });
  if (snapshots.length === 0) {
    return { ok: false, stages, sample: null, verdict: '没有可用的行情数据。' };
  }

  const snapshotBySymbol = new Map(snapshots.map((s) => [s.symbol, s]));

  /* --- 4. Prompt assembly ----------------------------------------------- */
  t = Date.now();
  const oiRanking = options.config.indicators.enableOiRanking
    ? await marketData.getOiRanking(15).catch(() => [])
    : [];

  const promptContext = {
    traderName: '策略体检',
    cycleNumber: 1,
    now: new Date(),
    config: options.config,
    account: {
      equity,
      availableBalance: equity,
      unrealizedPnl: 0,
      marginUsed: 0,
      positionCount: 0,
    },
    positions: [],
    candidates: snapshots,
    /*
     * 体检不连数据库，所以记忆区块是空的 —— 但它必须**存在**：这一段的目的是量出
     * 真实的提示词大小，少一块就等于把报告里的 token 数报低了（见下面的预算检查）。
     */
    memory: emptyPromptMemory(options.config),
    oiRanking,
  };

  const systemPrompt = buildSystemPrompt(promptContext);
  const userPrompt = buildUserPrompt(promptContext);

  /*
   * The prompt size is checked *before* the call, because an oversized prompt is
   * the single most expensive way to fail: the operator waits 40+ seconds only to
   * be told the model returned nothing, when the real problem was visible up
   * front. The budget is the same one candidate selection uses, so this stage
   * reports the truth rather than a separate estimate that can disagree.
   */
  const estimatedTokens = estimateTokens(systemPrompt + userPrompt);
  const overBudget = estimatedTokens > PROMPT_TOKEN_BUDGET;
  record('构建提示词', t, {
    ok: systemPrompt.length > 500 && userPrompt.length > 500 && !overBudget,
    detail:
      `系统提示词 ${systemPrompt.length.toLocaleString('en-US')} 字符，用户提示词 ${userPrompt.length.toLocaleString('en-US')} 字符` +
      `（约 ${estimatedTokens.toLocaleString('en-US')} tokens，实测约 1.7 字符/token）。` +
      (overBudget
        ? ` ⚠️ 超出 ${PROMPT_TOKEN_BUDGET.toLocaleString('en-US')} tokens 的预算 —— 候选标的过多或启用的指标/周期过多，` +
          '模型很可能耗光输出预算后返回空内容。请减少候选数量、时间周期或启用的指标。'
        : ''),
  });

  /* --- 5. Model call ----------------------------------------------------- */
  t = Date.now();
  let rawResponse: string;
  let latencyMs = 0;
  let finishReason = 'unknown';
  let usage = { promptTokens: null as number | null, completionTokens: null as number | null };
  try {
    const result = await options.client.complete(systemPrompt, userPrompt);
    rawResponse = result.text;
    latencyMs = result.latencyMs;
    finishReason = result.finishReason;
    usage = {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
    };

    /*
     * Diagnose an empty response from the evidence, not from a guess.
     *
     * The real failure this replaced: a 128k-token prompt, `finish_reason:
     * length`, and 8 192 completion tokens — the model spent its entire output
     * budget reasoning about an enormous input and never began the answer. The
     * old message blamed the output cap, which was only half the story; raising
     * the cap alone would have made it slower and more expensive without fixing
     * the cause. Naming the input size alongside the truncation points at what
     * actually has to change.
     */
    const truncated = finishReason === 'length';
    const empty = rawResponse.trim().length === 0;
    const usageText =
      usage.promptTokens !== null
        ? `prompt ${usage.promptTokens.toLocaleString('en-US')} / completion ${(usage.completionTokens ?? 0).toLocaleString('en-US')} tokens，`
        : '';

    let detail: string;
    if (empty && truncated) {
      detail =
        `模型返回空内容，并被输出上限截断（finish_reason=length）：${usageText}耗时 ${latencyMs}ms。` +
        `模型在输入为约 ${estimatedTokens.toLocaleString('en-US')} tokens 的情况下，把 ${
          usage.completionTokens?.toLocaleString('en-US') ?? '全部'
        } 个输出 token 全用在推理上，还没开始输出 JSON 就停了。` +
        (overBudget
          ? '**根因是输入过大，不是输出上限太小** —— 请先减少候选标的数量、时间周期或启用的指标，' +
            '把提示词压回预算内；单纯调大「最大输出 Token」只会更慢更贵。'
          : '输入在预算内，因此可以调大「最大输出 Token」；若仍失败，说明该模型不擅长长推理下的结构化输出，建议换模型。');
    } else if (empty) {
      detail =
        `模型返回空内容但未标记截断（finish_reason=${finishReason}）：${usageText}耗时 ${latencyMs}ms。` +
        '这通常意味着接口返回了 2xx 却没有正文，或模型拒答。请检查该模型 id 是否可用、账号余额是否充足。';
    } else if (truncated) {
      detail =
        `模型输出被截断（finish_reason=length）：只返回了 ${rawResponse.length} 个字符。` +
        `${usageText}请在高级设置里调大「最大输出 Token」` +
        (overBudget ? '，并同时把提示词压回预算内。' : '。');
    } else {
      detail =
        `模型在 ${latencyMs}ms 内返回 ${rawResponse.length} 个字符（finish_reason=${finishReason}）` +
        (usage.promptTokens !== null
          ? `，${usageText.replace(/，$/, '')}`
          : '') +
        '。';
    }

    record('调用模型', t, { ok: !empty && !truncated, detail });
  } catch (error) {
    record('调用模型', t, { ok: false, detail: `模型调用失败：${(error as Error).message}` });
    return {
      ok: false,
      stages,
      sample: null,
      verdict: '模型调用失败，请检查 API Key、基础 URL 与模型 id。',
    };
  }
  if (rawResponse.trim().length === 0) {
    return { ok: false, stages, sample: null, verdict: '模型返回空内容。' };
  }

  /* --- 6. Response parsing ---------------------------------------------- */
  t = Date.now();
  const parsed = parseDecisionResponse(rawResponse, {
    candidateSymbols: new Set(snapshots.map((s) => s.symbol)),
    openPositions: new Map(),
    allowUnlistedCloses: true,
  });
  const decisionBlockPresent = hasDecisionBlock(rawResponse);
  record('解析模型输出', t, {
    // Parsing "succeeded" if we found the structure at all — an empty decision
    // array is a legitimate "do nothing" answer.
    ok: decisionBlockPresent || parsed.decisions.length > 0,
    detail: !decisionBlockPresent
      ? `模型没有输出 <decision> 块，因此没有任何可执行决策。它只写了思维链（${parsed.cotTrace.length} 字符）` +
        (finishReason === 'length'
          ? '，并且输出被截断了 —— 调大「最大输出 Token」通常即可解决。'
          : '。这通常是提示词或模型指令跟随能力的问题。')
      : parsed.decisions.length > 0
        ? `解析出 ${parsed.decisions.length} 条决策，思维链 ${parsed.cotTrace.length} 字符。` +
          (parsed.rejected.length > 0 ? ` 另有 ${parsed.rejected.length} 条被结构校验拒绝。` : '')
        : `模型返回了 <decision> 块，内容为空数组 —— 即判断当前没有机会。思维链 ${parsed.cotTrace.length} 字符。`,
  });

  /* --- 7. Hard risk review ---------------------------------------------- */
  t = Date.now();
  const engine = new RiskEngine();
  const verdict = engine.review(sortDecisions(parsed.decisions), {
    config: options.config,
    account: { equity, availableBalance: equity, marginUsed: 0, positionCount: 0 },
    positions: new Map(),
    snapshots: snapshotBySymbol,
    minNotionalOf: (symbol) => options.connection.registry.minNotional(symbol),
    quantityFor: (symbol, notionalUsd, price) =>
      options.connection.registry.notionalToQuantity(symbol, notionalUsd, price),
    entriesThisCycle: 0,
    entriesLastHour: 0,
  });

  const openProposals = parsed.decisions.filter((d) => d.action.startsWith('open_')).length;
  record('硬风控审查', t, {
    ok: true,
    detail:
      openProposals === 0
        ? '没有开仓提案需要通过风控。'
        : `风控通过了 ${verdict.approved.filter((d) => d.action.startsWith('open_')).length}/${openProposals} 个开仓提案` +
          (verdict.rejected.length > 0 ? `，拒绝 ${verdict.rejected.length} 个（原因见下方）。` : '。'),
  });

  /* --- Assemble the sample ---------------------------------------------- */
  const executionLog: ExecutionLogEntry[] = [
    ...parsed.rejected.map((r) => ({
      action: r.action,
      symbol: r.symbol,
      status: 'rejected' as const,
      detail: r.reason,
    })),
    ...verdict.rejected.map((r) => ({
      action: r.decision.action,
      symbol: r.decision.symbol,
      status: 'rejected' as const,
      detail: r.reason,
    })),
    ...verdict.approved
      .filter((d) => d.action.startsWith('open_'))
      .map((d) => ({
        action: d.action,
        symbol: d.symbol,
        status: 'ok' as const,
        detail:
          `可通过风控：名义价值 $${d.positionSizeUsd.toFixed(2)}，${d.leverage}x，` +
          `止损 ${d.stopLoss}，止盈 ${d.takeProfit}，风险 $${d.riskUsd.toFixed(2)}。` +
          (d.adjustments.length > 0 ? ` 运行时调整：${d.adjustments.join(' ')}` : ''),
        ...(d.adjustments.length > 0 ? { adjustments: d.adjustments } : {}),
      })),
  ];

  const approvedOpens = verdict.approved.filter((d) => d.action.startsWith('open_')).length;
  const verdictText = !decisionBlockPresent
    ? finishReason === 'length'
      ? '模型输出被截断，没有产生 <decision> 块 —— 请调大「最大输出 Token」后重试。'
      : '模型没有输出 <decision> 块 —— 请检查提示词或换一个指令跟随能力更强的模型。'
    : approvedOpens > 0
      ? `策略可正常运作：模型给出了 ${approvedOpens} 个可通过风控的开仓提案。`
      : openProposals > 0
        ? `模型能正常输出，但它提出的 ${openProposals} 个开仓全部被风控拒绝 —— 通常是风控太严或策略提示词要求的仓位/盈亏比超出限制。`
        : '策略可正常运作：模型判断当前没有机会，返回了空决策。这是完全正常的答案。';

  log.info(`策略体检完成：${verdictText}`);

  return {
    ok: true,
    stages,
    verdict: verdictText,
    sample: {
      systemPrompt,
      userPrompt,
      rawResponse,
      cotTrace: parsed.cotTrace,
      decisions: parsed.decisions,
      rejected: parsed.rejected,
      approved: verdict.approved,
      riskRejected: verdict.rejected.map((r) => ({
        action: r.decision.action,
        symbol: r.decision.symbol,
        reason: r.reason,
      })),
      executionLog,
      candidateSymbols: snapshots.map((s) => s.symbol),
      simulatedEquity: equity,
    },
  };
}

export { closeReasonLabel };
