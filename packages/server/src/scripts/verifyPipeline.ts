/**
 * End-to-end pipeline verification against live Binance market data.
 *
 * This exercises everything between "the exchange" and "an approved order"
 * without needing exchange credentials or an LLM API key:
 *
 *   candidate selection → market snapshots → prompt assembly → response parsing
 *   → hard risk review
 *
 * Run it any time you change the strategy engine, the prompt builder, the risk
 * engine or the market-data layer:
 *
 *   npx tsx packages/server/src/scripts/verifyPipeline.ts
 */

import { defaultStrategyConfig, STRATEGY_PRESETS, type StrategyConfig } from '@aq/shared';
import { connectExchange } from '../binance/bootstrap.js';
import { MarketDataService } from '../market/service.js';
import { RiskEngine } from '../risk/engine.js';
import { selectCandidates } from '../strategy/coins.js';
import { parseDecisionResponse, sortDecisions } from '../strategy/parser.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  emptyPromptMemory,
  type PromptContext,
} from '../strategy/prompt.js';

/** A response in the exact shape the prompt asks the model to produce. */
const CANNED_MODEL_RESPONSE = `<reasoning>
BTC is trading below its 4h EMA while the 1h MACD histogram is flattening.
Open interest is expanding on the recent decline, which suggests new shorts
rather than long liquidation. I see no high-conviction long, and a short would
be chasing an extended move, so I will wait rather than force a trade.

For ETH the 15m has reclaimed its EMA20 with rising taker buy flow, so I will
take a small long with a stop below the recent swing low.
</reasoning>

<decision>
\`\`\`json
[
  {
    "symbol": "ETHUSDT",
    "action": "open_long",
    "leverage": 3,
    "position_size_usd": 300,
    "stop_loss": 0,
    "take_profit": 0,
    "confidence": 78,
    "risk_usd": 15,
    "reasoning": "15m EMA20 reclaimed with supportive taker flow."
  },
  {
    "symbol": "BTCUSDT",
    "action": "wait",
    "confidence": 50,
    "reasoning": "No edge; waiting."
  }
]
\`\`\`
</decision>`;

function heading(text: string): void {
  process.stdout.write(`\n${'='.repeat(74)}\n${text}\n${'='.repeat(74)}\n`);
}

async function main(): Promise<void> {
  const paperStrategy: StrategyConfig = {
    ...defaultStrategyConfig(),
    ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>),
  };
  // Trim the universe so this script finishes quickly and stays gentle on the
  // public rate limits. The candle count is left at the production default so
  // that indicator warm-up behaves exactly as it does in a real cycle.
  const config: StrategyConfig = {
    ...paperStrategy,
    coinSource: { ...paperStrategy.coinSource, coinPoolLimit: 6, oiTopLimit: 4 },
    indicators: {
      ...paperStrategy.indicators,
      kline: { primaryTimeframe: '5m', selectedTimeframes: ['5m', '15m', '1h'], primaryCount: 60 },
      enableQuantData: true,
      enableOiRanking: true,
    },
  };

  heading('1. 连接币安（Demo 环境）');
  const connection = await connectExchange({ environment: 'demo', dryRun: true });
  process.stdout.write(
    `   交易环境    : ${connection.endpoints.label}\n` +
      `   时钟偏移    : ${connection.clockOffsetMs}ms\n` +
      `   可交易合约  : ${connection.registry.size}\n` +
      `   权重预算    : ${connection.rest.weightLimitPerMinute}/分钟\n`,
  );

  const marketData = new MarketDataService(connection.market, connection.registry);

  heading('2. 选出候选标的池');
  const selection = await selectCandidates(config, marketData);
  process.stdout.write(`   ${selection.symbols.length} candidates:\n`);
  for (const symbol of selection.symbols) {
    process.stdout.write(`     ${symbol.padEnd(12)} ${selection.sourcesBySymbol.get(symbol)?.join(' + ')}\n`);
  }

  heading('3. 组装行情快照（K线 + 指标 + 衍生品）');
  const snapshots = await marketData.buildSnapshots(
    selection.symbols,
    config.indicators,
    selection.sourcesBySymbol,
  );
  process.stdout.write(`   built ${snapshots.length} of ${selection.symbols.length} snapshots\n\n`);

  const header = ['symbol', 'price', 'ema20', 'rsi7', 'atr14', 'funding%', 'OI(USD)'];
  process.stdout.write(`   ${header.map((h) => h.padEnd(12)).join('')}\n`);
  for (const snap of snapshots) {
    const last = <T,>(arr: Array<T | null> | undefined): T | null => {
      if (!arr) return null;
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        const v = arr[i];
        if (v !== null && v !== undefined && Number.isFinite(v)) return v;
      }
      return null;
    };
    const emaKey = Object.keys(snap.primary.ema)[0];
    const rsiKey = Object.keys(snap.primary.rsi)[0];
    const atrKey = Object.keys(snap.primary.atr)[0];
    const row = [
      snap.symbol,
      snap.price.toFixed(4),
      emaKey ? String(last(snap.primary.ema[emaKey])) : 'n/a',
      rsiKey ? (last(snap.primary.rsi[rsiKey]) ?? 0).toFixed(1) : 'n/a',
      atrKey ? String(last(snap.primary.atr[atrKey])) : 'n/a',
      snap.derivatives.fundingRate === null ? 'n/a' : (snap.derivatives.fundingRate * 100).toFixed(4),
      snap.derivatives.openInterestUsd === null ? 'n/a' : Math.round(snap.derivatives.openInterestUsd).toLocaleString('en-US'),
    ];
    process.stdout.write(`   ${row.map((c) => String(c).padEnd(12)).join('')}\n`);
  }

  const missingIndicators = snapshots.filter((s) => s.primary.klines.length === 0);
  if (missingIndicators.length > 0) {
    process.stdout.write(`\n   WARNING: ${missingIndicators.length} snapshot(s) had no klines\n`);
  }

  heading('4. 组装提示词');
  const oiRanking = config.indicators.enableOiRanking
    ? await marketData.getOiRanking(10).catch(() => [])
    : [];

  const context: PromptContext = {
    traderName: 'Verification run',
    cycleNumber: 1,
    now: new Date(),
    config,
    account: {
      equity: 1000,
      availableBalance: 800,
      unrealizedPnl: 5.5,
      marginUsed: 200,
      positionCount: 0,
    },
    positions: [],
    candidates: snapshots,
    recentTrades: [],
    // 这一趟没有账本（不连数据库），所以记忆区块如实表示"还没有任何成交"。
    memory: emptyPromptMemory(config),
    oiRanking,
  };

  const systemPrompt = buildSystemPrompt(context);
  const userPrompt = buildUserPrompt(context);

  process.stdout.write(
    `   system prompt: ${systemPrompt.length.toLocaleString('en-US')} chars (~${Math.round(systemPrompt.length / 4).toLocaleString('en-US')} tokens)\n` +
      `   user prompt  : ${userPrompt.length.toLocaleString('en-US')} chars (~${Math.round(userPrompt.length / 4).toLocaleString('en-US')} tokens)\n` +
      `   OI ranking   : ${oiRanking.length} rows\n`,
  );

  heading('5. 系统提示词（前 1800 个字符）');
  process.stdout.write(`${systemPrompt.slice(0, 1800)}\n   …\n`);

  heading('6. 用户提示词 —— 一个候选标的区块');
  const candidateStart = userPrompt.indexOf('# CANDIDATE COINS');
  process.stdout.write(`${userPrompt.slice(candidateStart, candidateStart + 1500)}\n   …\n`);

  heading('7. 解析一份真实的模型响应');
  const parsed = parseDecisionResponse(CANNED_MODEL_RESPONSE, {
    candidateSymbols: new Set(snapshots.map((s) => s.symbol)),
    openPositions: new Map(),
    allowUnlistedCloses: true,
  });

  process.stdout.write(`   chain of thought: ${parsed.cotTrace.length} chars\n`);
  process.stdout.write(`   decisions parsed: ${parsed.decisions.length}\n`);
  for (const d of parsed.decisions) {
    process.stdout.write(`     ${d.action.padEnd(12)} ${d.symbol.padEnd(12)} confidence=${d.confidence}\n`);
  }
  if (parsed.rejected.length > 0) {
    process.stdout.write(`   rejected:\n`);
    for (const r of parsed.rejected) {
      process.stdout.write(`     ${r.action} ${r.symbol}: ${r.reason}\n`);
    }
  }

  heading('8. 硬风控审查');
  const engine = new RiskEngine();
  const snapshotBySymbol = new Map(snapshots.map((s) => [s.symbol, s]));

  const verdict = engine.review(sortDecisions(parsed.decisions), {
    config,
    account: {
      equity: context.account.equity,
      availableBalance: context.account.availableBalance,
      marginUsed: context.account.marginUsed,
      positionCount: 0,
    },
    positions: new Map(),
    snapshots: snapshotBySymbol,
    minNotionalOf: (symbol) => connection.registry.minNotional(symbol),
    quantityFor: (symbol, notionalUsd, price) =>
      connection.registry.notionalToQuantity(symbol, notionalUsd, price),
    entriesThisCycle: 0,
    entriesLastHour: 0,
  });

  process.stdout.write(`   approved: ${verdict.approved.length}\n`);
  for (const d of verdict.approved) {
    if (d.action === 'wait' || d.action === 'hold') {
      process.stdout.write(`     ${d.action} ${d.symbol}\n`);
      continue;
    }
    process.stdout.write(
      `     ${d.action} ${d.symbol}  notional=$${d.positionSizeUsd.toFixed(2)}  leverage=${d.leverage}x  ` +
        `SL=${d.stopLoss}  TP=${d.takeProfit}  risk=$${d.riskUsd.toFixed(2)}\n`,
    );
    for (const note of d.adjustments) process.stdout.write(`       · ${note}\n`);
  }
  process.stdout.write(`   rejected: ${verdict.rejected.length}\n`);
  for (const r of verdict.rejected) {
    process.stdout.write(`     ${r.decision.action} ${r.decision.symbol}: ${r.reason}\n`);
  }

  heading('结果');
  const ok = snapshots.length > 0 && systemPrompt.length > 2000 && userPrompt.length > 2000;
  process.stdout.write(
    ok
      ? '   PASS — live data flowed through selection, indicators, prompts, parsing and risk review.\n'
      : '   FAIL — the pipeline produced no usable data.\n',
  );
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`验证失败：${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
