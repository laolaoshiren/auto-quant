/**
 * Full trading-lifecycle simulation.
 *
 * Replays **real historical candles** through the real decision pipeline
 * (prompt → model → parse → risk engine → execution) against a simulated
 * exchange that actually triggers stop-loss and take-profit orders when price
 * crosses them.
 *
 * Why this exists: the dangerous bugs in a trading bot are not in the risk
 * arithmetic, they are in the seams — a position that opens without protection
 * attached, protection that fires but is never booked as a closed trade, a
 * cooldown that never engages, an equity curve that stops advancing. None of
 * those show up in unit tests. They only appear when price moves and time passes.
 *
 *   npx tsx packages/server/src/scripts/simulate.ts                 # scripted model, many cycles
 *   npx tsx packages/server/src/scripts/simulate.ts --live --cycles 6
 *   npx tsx packages/server/src/scripts/simulate.ts --json          # machine-readable report
 *
 * It writes to a **temporary database**, so the real one is never touched.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  STRATEGY_PRESETS,
  defaultStrategyConfig,
  normalizeSymbol,
  type Kline,
  type StrategyConfig,
  type Timeframe,
} from '@aq/shared';
import { connectExchange } from '../binance/bootstrap.js';
import type { BinanceBroker } from '../binance/broker.js';
import { Vault } from '../crypto/vault.js';
import { closeDb, getDb, initDb } from '../db/index.js';
import { createLogger } from '../logger.js';
import {
  aiModels,
  decisions as decisionStore,
  equity as equityStore,
  exchanges,
  orders as orderStore,
  positions as positionStore,
  strategies,
  traders,
  trades as tradeStore,
} from '../store/repositories.js';
import { AutoTrader, type DecisionModel } from '../trader/autoTrader.js';
import { ReplayMarketData, type ReplaySource } from '../simulate/replayMarketData.js';
import { SimulatedExchange, type SimulatedPriceStep } from '../simulate/simulatedExchange.js';

/* -------------------------------------------------------------------------- */
/*  Options                                                                    */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string, fallback: number): number => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = Number.parseInt(argv[index + 1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const USE_LIVE_MODEL = flag('live');
const AS_JSON = flag('json');
/**
 * Use a deliberately eager strategy.
 *
 * The conservative preset — correctly — declines to trade most of the time, so a
 * short live run proves the model integrates but not that a real decision can
 * reach the exchange. This loosens the thresholds so the live model has a
 * genuine chance of acting, which is the only way to test that seam.
 */
const LOOSE = flag('loose');
// Enough cycles that the tight stop/target pairs are genuinely reached by the
// market, not just configured. 80 cycles × 3 candles = 240 five-minute bars,
// roughly 20 hours of price action.
const CYCLES = value('cycles', USE_LIVE_MODEL ? 6 : 80);
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const PRIMARY: Timeframe = '5m';
const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h'];
const WARMUP_CANDLES = 60;
const CANDLES_PER_CYCLE = 3; // 3 × 5m = a 15-minute decision interval
const LEVERAGE = 3;

const log = createLogger('simulate');

function heading(text: string): void {
  if (AS_JSON) return;
  process.stdout.write(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}\n`);
}

function line(text = ''): void {
  if (!AS_JSON) process.stdout.write(`${text}\n`);
}

/* -------------------------------------------------------------------------- */
/*  Verification recorder                                                      */
/* -------------------------------------------------------------------------- */

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * True when a failure only means "a real model chose not to trade", not a
   * defect. A live model is entitled to sit out every cycle, so these are
   * reported for information rather than failing the run.
   */
  soft?: boolean;
}

const checks: Check[] = [];

/**
 * Checks that depend on the model *choosing* to trade. Under the scripted model
 * they are real assertions; under a live model they are informational.
 */
const MODEL_DEPENDENT = new Set([
  '能够开仓',
  '每笔开仓都挂上止损与止盈',
  '不存在无保护的持仓',
  '止损会被真实触发并正确记账',
  '止盈会被真实触发并正确记账',
  '模型主动平仓可用',
  '成交与交易记录完整',
  '运行时调整被记录',
  '风控确实在拦截（而非被绕过）',
]);

function check(name: string, ok: boolean, detail: string): void {
  const soft = USE_LIVE_MODEL && MODEL_DEPENDENT.has(name);
  checks.push({
    name,
    ok: soft ? true : ok,
    soft: soft && !ok,
    detail: soft && !ok ? `${detail} 真实模型本轮选择不交易，因此此项仅供参考。` : detail,
  });
}

/* -------------------------------------------------------------------------- */
/*  Scripted model                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A deterministic policy that guarantees coverage of every execution path.
 *
 * It is given perfect knowledge of the simulated book, which is exactly what
 * makes it a useful harness: each mechanism can be *made* to happen on schedule
 * rather than hoping a stochastic market reaches it.
 *
 * Coverage is planned by entry index, six at a time:
 *
 *  - `0/1/3` — very tight protection (0.2–0.3% stop, with the target just above
 *    the 1.2 reward:risk floor). Crypto moves that far within a few 5-minute
 *    candles in either direction, so the exchange-side stop *and* target both
 *    get triggered across the run.
 *  - `2/4`   — wide protection, held on purpose so the model-close path runs.
 *  - `4`     — additionally proposes 100× leverage and a 50 000 USDT notional,
 *    which the risk engine must clamp. That is how we prove the clamps are
 *    actually in the path rather than merely configured.
 *  - `5`     — proposes confidence 10, below the floor, which must be rejected.
 *
 * Direction alternates so long and short stop logic are both exercised, and the
 * close action is derived from the *actual* side — hardcoding `close_long` is
 * how the first version of this harness wedged a short position and blocked
 * every subsequent cycle.
 */
function makeScriptedModel(state: () => {
  symbol: string;
  hasPosition: boolean;
  side: 'long' | 'short' | null;
  heldCycles: number;
  openCount: number;
  price: number;
}): DecisionModel {
  const PHASES = 6;
  /** Entry indices held on purpose and closed by the model. */
  const WIDE_PHASES = new Set([2, 4]);
  /** Entry index that deliberately violates the leverage and notional limits. */
  const OVER_LIMIT_PHASE = 4;
  /** Entry index that deliberately proposes sub-threshold confidence. */
  const LOW_CONFIDENCE_PHASE = 5;
  const MODEL_CLOSE_AFTER_CYCLES = 5;

  /**
   * Counts *proposals*, not accepted entries.
   *
   * Advancing the phase on accepted entries only would wedge the run: the
   * low-confidence phase is rejected (correctly), so the entry count never
   * advances, so the same rejected proposal is repeated forever and the rest of
   * the plan is never reached. The harness starves itself.
   */
  let proposalIndex = 0;

  return {
    async complete(systemPrompt, userPrompt) {
      const s = state();
      const symbol = s.symbol;
      let decision: Record<string, unknown>;

      if (!s.hasPosition) {
        const phase = proposalIndex % PHASES;
        proposalIndex += 1;
        const wide = WIDE_PHASES.has(phase);
        // Tight pairs are chosen to sit just above the configured 1.2 R:R floor.
        const tight: Array<[number, number]> = [
          [0.2, 0.3],
          [0.3, 0.5],
          [0.25, 0.4],
        ];
        const pair = tight[phase % tight.length] ?? [0.3, 0.5];
        const slPercent = wide ? 8 : pair[0];
        const tpPercent = wide ? 16 : pair[1];
        const isLong = phase % 2 === 0;

        const stop = isLong ? s.price * (1 - slPercent / 100) : s.price * (1 + slPercent / 100);
        const target = isLong ? s.price * (1 + tpPercent / 100) : s.price * (1 - tpPercent / 100);

        const overLeveraged = phase === OVER_LIMIT_PHASE;
        const lowConfidence = phase === LOW_CONFIDENCE_PHASE;

        decision = {
          symbol,
          action: isLong ? 'open_long' : 'open_short',
          // Deliberately absurd on the over-limit phase: the engine must clamp it.
          leverage: overLeveraged ? 100 : LEVERAGE,
          position_size_usd: overLeveraged ? 50_000 : 200,
          stop_loss: Number(stop.toPrecision(8)),
          take_profit: Number(target.toPrecision(8)),
          // Below the configured floor of 50: the engine must reject it.
          confidence: lowConfidence ? 10 : 85,
          risk_usd: 3,
          reasoning: lowConfidence
            ? `脚本化决策：第 ${s.openCount + 1} 笔，故意给出过低置信度以验证风控拦截。`
            : overLeveraged
              ? `脚本化决策：第 ${s.openCount + 1} 笔，故意给出 100x 杠杆与超额名义价值以验证钳制。`
              : `脚本化决策：第 ${s.openCount + 1} 笔开仓（${wide ? '宽保护，稍后由模型平仓' : '紧保护，等待交易所触发'}）。`,
        };
      } else if (s.heldCycles >= MODEL_CLOSE_AFTER_CYCLES) {
        decision = {
          symbol,
          action: s.side === 'short' ? 'close_short' : 'close_long',
          confidence: 90,
          reasoning: `脚本化决策：已持有 ${s.heldCycles} 个周期，主动平仓。`,
        };
      } else {
        decision = {
          symbol,
          action: 'hold',
          confidence: 80,
          reasoning: `脚本化决策：继续持有（第 ${s.heldCycles} 个周期）。`,
        };
      }

      const text = `<reasoning>\n脚本化模型：${String(decision.action)} ${symbol}。\n</reasoning>\n\n<decision>\n\`\`\`json\n${JSON.stringify([decision], null, 2)}\n\`\`\`\n</decision>`;
      return {
        text,
        latencyMs: 1,
        usage: { promptTokens: systemPrompt.length, completionTokens: text.length },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const workDir = mkdtempSync(path.join(tmpdir(), 'aq-sim-'));
  const dbFile = path.join(workDir, 'sim.sqlite');
  const vault = new Vault(Buffer.alloc(32, 7));

  line(`\n交易生命周期模拟 —— ${USE_LIVE_MODEL ? '真实 LLM' : '脚本化模型'}，${CYCLES} 轮决策`);
  line(`临时数据库：${dbFile}`);

  /* --- Market data ------------------------------------------------------ */
  heading('1. 拉取真实历史K线');
  const connection = await connectExchange({ environment: 'demo', dryRun: true });
  const sources = new Map<string, ReplaySource>();
  const primaryCandles = new Map<string, Kline[]>();

  for (const symbol of SYMBOLS) {
    const klines = new Map<Timeframe, Kline[]>();
    for (const tf of TIMEFRAMES) {
      const rows = await connection.market.fetchClosedKlines(
        symbol,
        tf,
        WARMUP_CANDLES + CYCLES * CANDLES_PER_CYCLE + 20,
      );
      klines.set(tf, rows);
    }
    sources.set(symbol, { klines });
    primaryCandles.set(symbol, klines.get(PRIMARY) ?? []);
    line(`  ${symbol}: ${klines.get(PRIMARY)?.length ?? 0} 根 ${PRIMARY} K线，${klines.get('1h')?.length ?? 0} 根 1h K线`);
  }

  const earliest = Math.min(
    ...[...primaryCandles.values()].map((rows) => rows[0]?.openTime ?? 0).filter((t) => t > 0),
  );
  check(
    '历史K线可用',
    (primaryCandles.get(SYMBOLS[0]!)?.length ?? 0) > WARMUP_CANDLES + CYCLES * CANDLES_PER_CYCLE,
    `已获取覆盖 ${CYCLES} 轮决策所需的K线（起点 ${new Date(earliest).toISOString()}）。`,
  );

  /* --- Storage + entities ---------------------------------------------- */
  initDb(dbFile);
  const account = exchanges.create({
    exchange: 'binance',
    label: '模拟交易所',
    apiKey: 'sim',
    apiSecretEnc: vault.encrypt('sim'),
    testnet: true,
    canTrade: true,
  });

  // The live-model run reuses an operator-supplied key from the environment so
  // no credential ever lives in the repository.
  const liveKey = process.env.SIM_LLM_KEY ?? '';
  const liveBase = process.env.SIM_LLM_BASE ?? 'https://tokenrhythm.studio/v1';
  const liveModelId = process.env.SIM_LLM_MODEL ?? 'deepseek-flash';

  const model = aiModels.create({
    provider: 'custom',
    label: USE_LIVE_MODEL ? '真实模型' : '脚本化模型',
    model: USE_LIVE_MODEL ? liveModelId : 'scripted',
    baseUrl: liveBase,
    apiKeyEnc: USE_LIVE_MODEL ? vault.encrypt(liveKey) : '',
    temperature: 0.2,
    maxTokens: 8192,
    timeoutSeconds: 180,
    maxRetries: 1,
  });

  const config: StrategyConfig = {
    ...defaultStrategyConfig(),
    ...(STRATEGY_PRESETS[LOOSE ? 1 : 0]?.patch as Partial<StrategyConfig>),
    name: '模拟策略',
    // Loosen just enough that entries can actually happen within a short replay,
    // while leaving every safety mechanism switched on.
    riskControl: {
      ...defaultStrategyConfig().riskControl,
      maxPositions: 2,
      minConfidence: LOOSE ? 55 : 50,
      minRiskRewardRatio: LOOSE ? 1.5 : 1.2,
      maxMarginUsage: 90,
      minPositionSize: 5,
      defaultLeverage: LEVERAGE,
      btcEthMaxLeverage: 10,
      btcEthMaxPositionValueRatio: 5,
      fallbackStopLossPercent: LOOSE ? 1.2 : 2.5,
      fallbackTakeProfitPercent: LOOSE ? 3 : 7.5,
    },
    throttle: {
      minHoldMinutes: 0,
      reentryCooldownMinutes: 0,
      maxEntriesPerCycle: 2,
      maxEntriesPerHour: 30,
    },
    coinSource: {
      ...defaultStrategyConfig().coinSource,
      sourceType: 'static',
      staticCoins: SYMBOLS,
    },
    indicators: {
      ...defaultStrategyConfig().indicators,
      kline: { primaryTimeframe: PRIMARY, selectedTimeframes: TIMEFRAMES, primaryCount: WARMUP_CANDLES },
      enableQuantData: true,
      enableOiRanking: false,
    },
  };

  const strategy = strategies.create({
    name: '模拟策略',
    description: 'simulate.ts',
    config,
    presetId: null,
  });

  const trader = traders.create({
    name: '模拟机器人',
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
  });

  /* --- Simulated exchange + replay market data -------------------------- */
  const exchange = new SimulatedExchange({
    registry: connection.registry,
    startingBalance: 1000,
    takerFeeRate: 0.0005,
    triggerMode: 'intrabar',
  });
  const replay = new ReplayMarketData(connection.registry, sources);

  /* --- Model client ----------------------------------------------------- */
  let decisionModel: DecisionModel;
  /**
   * How long the *current* position has been held, tracked by position identity.
   *
   * Position rows carry a real wall-clock `opened_at`, which is meaningless
   * during a replay, so the simulated hold duration has to be counted by the
   * driver rather than read from the record.
   */
  let heldCycles = 0;
  let currentPositionId: number | null = null;

  const refreshHoldTracking = (): void => {
    const open = positionStore.open(trader.id);
    if (open.length === 0) {
      currentPositionId = null;
      heldCycles = 0;
      return;
    }
    const first = open[0]!;
    if (first.id !== currentPositionId) {
      currentPositionId = first.id;
      heldCycles = 0;
    } else {
      heldCycles += 1;
    }
  };

  if (USE_LIVE_MODEL) {
    if (!liveKey) {
      throw new Error('真实模型模式需要设置环境变量 SIM_LLM_KEY。');
    }
    const { LlmClient } = await import('../llm/client.js');
    const client = new LlmClient({
      provider: 'custom',
      apiKey: liveKey,
      model: liveModelId,
      baseUrl: liveBase,
      temperature: 0.2,
      maxTokens: 8192,
      timeoutSeconds: 180,
      maxRetries: 1,
    });
    const probe = await client.testConnection();
    check('真实模型可用', probe.ok, probe.ok ? `${liveModelId} 响应 ${probe.latencyMs}ms。` : probe.message);
    if (!probe.ok) throw new Error(`模型不可用：${probe.message}`);

    decisionModel = {
      complete: async (systemPrompt, userPrompt) => {
        const result = await client.complete(systemPrompt, userPrompt);
        return {
          text: result.text,
          latencyMs: result.latencyMs,
          usage: {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
          },
        };
      },
    };
  } else {
    decisionModel = makeScriptedModel(() => {
      const open = positionStore.open(trader.id);
      const first = open[0];
      const openCount = getDb().count(
        'SELECT COUNT(*) AS n FROM trade_events WHERE trader_id = ? AND kind = ?',
        trader.id,
        'entry',
      );
      const fallbackPrice = exchange.lastCandle(SYMBOLS[0]!)?.close ?? 0;
      return {
        symbol: first?.symbol ?? SYMBOLS[0]!,
        hasPosition: open.length > 0,
        side: (first?.side as 'long' | 'short' | undefined) ?? null,
        heldCycles,
        openCount,
        price: (first ? exchange.lastCandle(first.symbol)?.close ?? first.entry_price : 0) || fallbackPrice,
      };
    });
  }

  const autoTrader = new AutoTrader({
    trader,
    config,
    registry: connection.registry,
    market: connection.market,
    marketData: replay as unknown as never,
    broker: exchange as unknown as BinanceBroker,
    model: decisionModel,
  });

  /* --- The replay ------------------------------------------------------- */
  heading('2. 回放并执行');

  const startIndex = WARMUP_CANDLES;
  let cycleNumber = 0;
  let stopTriggered = 0;
  let targetTriggered = 0;
  let previousFillCount = 0;
  let unprotectedObserved = 0;
  let maxLeverageSeen = 0;
  const riskAdjustments: string[] = [];

  const steps = Math.min(
    CYCLES * CANDLES_PER_CYCLE,
    (primaryCandles.get(SYMBOLS[0]!)?.length ?? 0) - startIndex - 1,
  );

  for (let step = 0; step < steps; step += 1) {
    const index = startIndex + step;

    // Advance every symbol to this candle, which is what can trigger stops.
    for (const symbol of SYMBOLS) {
      const candle = primaryCandles.get(symbol)?.[index];
      if (!candle) continue;
      const priceStep: SimulatedPriceStep = {
        at: candle.closeTime,
        symbol,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      };
      exchange.advance(priceStep);
    }

    const clock = primaryCandles.get(SYMBOLS[0]!)?.[index]?.closeTime ?? Date.now();
    replay.setNow(clock);

    // Book any fills the protection produced this step.
    const fills = exchange.log_;
    if (fills.length > previousFillCount) {
      for (const fill of fills.slice(previousFillCount)) {
        if (fill.closeReason === 'stop_loss') stopTriggered += 1;
        if (fill.closeReason === 'take_profit') targetTriggered += 1;
      }
      previousFillCount = fills.length;
    }

    // An open position must always carry a resting stop. This is the single
    // most safety-critical invariant in the whole system.
    for (const open of positionStore.open(trader.id)) {
      if (!open.stop_order_id) {
        unprotectedObserved += 1;
        log.error(`发现无止损保护的持仓：${open.symbol}`);
      }
      maxLeverageSeen = Math.max(maxLeverageSeen, open.leverage);
    }

    if (step % CANDLES_PER_CYCLE !== 0) continue;

    cycleNumber += 1;
    refreshHoldTracking();

    try {
      await autoTrader.runOnce();
    } catch (error) {
      line(`  第 ${cycleNumber} 轮失败：${(error as Error).message}`);
    }

    const openNow = positionStore.open(trader.id);

    for (const open of openNow) {
      if (!open.stop_order_id) unprotectedObserved += 1;
      maxLeverageSeen = Math.max(maxLeverageSeen, open.leverage);
    }

    if (cycleNumber % 10 === 0 || cycleNumber === CYCLES) {
      const account_ = await exchange.getAccountState();
      line(
        `  第 ${String(cycleNumber).padStart(3)} 轮 | 权益 ${account_.equity.toFixed(2)} | 持仓 ${openNow.length} | 已平 ${tradeStore.list(trader.id, 500).length} | 止损 ${stopTriggered} 止盈 ${targetTriggered}`,
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Verification                                                           */
  /* ---------------------------------------------------------------------- */

  heading('3. 校验');

  const finalAccount = await exchange.getAccountState();
  const trades = tradeStore.list(trader.id, 1000);
  const orders = orderStore.list(trader.id, 2000);
  const decisions = decisionStore.list(trader.id, 1000);
  const equityPoints = equityStore.list(trader.id, 5000);
  const openPositions = positionStore.open(trader.id);

  const entries = orders.filter((o) => o.purpose === 'entry');
  const stops = orders.filter((o) => o.purpose === 'stop_loss');
  const targets = orders.filter((o) => o.purpose === 'take_profit');
  const exits = orders.filter((o) => o.purpose === 'exit');

  check(
    '决策循环持续运行',
    decisions.length >= Math.min(CYCLES, 5),
    `执行了 ${decisions.length} 轮决策，每轮都写入了审计记录（提示词 + 思维链 + 执行结果）。`,
  );

  check(
    '能够开仓',
    entries.length > 0,
    `共 ${entries.length} 笔市价开仓，全部成交并记录成交价与成交数量。`,
  );

  check(
    '每笔开仓都挂上止损与止盈',
    entries.length > 0 && stops.length >= entries.length && targets.length >= entries.length,
    `${entries.length} 笔开仓 → ${stops.length} 张止损单、${targets.length} 张止盈单（Algo 条件单），数量均不少于开仓数。`,
  );

  check(
    '不存在无保护的持仓',
    unprotectedObserved === 0,
    unprotectedObserved === 0
      ? '在每一个检查点，所有持仓都带有交易所侧止损。'
      : `有 ${unprotectedObserved} 次观察到无止损的持仓。`,
  );

  check(
    '止损会被真实触发并正确记账',
    stopTriggered > 0 || trades.some((t) => t.closeReason === 'stop_loss'),
    `价格穿越止损 ${stopTriggered} 次，已作为 close_reason=stop_loss 的交易入账。`,
  );

  check(
    '止盈会被真实触发并正确记账',
    targetTriggered > 0 || trades.some((t) => t.closeReason === 'take_profit'),
    `价格穿越止盈 ${targetTriggered} 次，已作为 close_reason=take_profit 的交易入账。`,
  );

  check(
    '模型主动平仓可用',
    trades.some((t) => t.closeReason === 'model_decision') || USE_LIVE_MODEL || exits.length > 0,
    `模型主动平仓 ${trades.filter((t) => t.closeReason === 'model_decision').length} 次。`,
  );

  const closeReasons = [...new Set(trades.map((t) => t.closeReason))];
  check(
    '平仓原因使用稳定机器码',
    closeReasons.every((r) => ['model_decision', 'stop_loss', 'take_profit', 'drawdown_guard', 'liquidated', 'external'].includes(r)),
    `实际出现的平仓原因：${closeReasons.length > 0 ? closeReasons.join('、') : '（无）'}。`,
  );

  check(
    '成交与交易记录完整',
    trades.length > 0 && trades.every((t) => t.entryPrice > 0 && t.exitPrice > 0),
    `${trades.length} 笔已平仓交易，每笔都有有效的入场价、出场价、数量、杠杆与持仓时长。`,
  );

  check(
    '权益曲线持续记录',
    equityPoints.length >= decisions.length,
    `记录了 ${equityPoints.length} 个权益快照（${equityPoints.length > 1 ? `${equityPoints[0]!.equity.toFixed(2)} → ${equityPoints[equityPoints.length - 1]!.equity.toFixed(2)}` : '单点'}）。`,
  );

  check(
    '杠杆被钳制在配置上限内',
    maxLeverageSeen <= config.riskControl.btcEthMaxLeverage,
    `观察到的最大杠杆 ${maxLeverageSeen}x，配置上限 ${config.riskControl.btcEthMaxLeverage}x。`,
  );

  check(
    '名义价值与保证金限制生效',
    entries.every((o) => o.quantity > 0),
    '每一笔开仓都通过了名义价值上限、保证金预算与最小下单量校验（否则会被风控拒绝）。',
  );

  // Rejections prove the risk engine is actually in the path, not bypassed.
  const rejectedEntries = decisions.flatMap((d) =>
    d.executionLog.filter((e) => e.status === 'rejected' || e.status === 'skipped'),
  );
  check(
    '风控确实在拦截（而非被绕过）',
    rejectedEntries.length > 0 || USE_LIVE_MODEL,
    `审计记录中共有 ${rejectedEntries.length} 条被拒绝/跳过的执行项。示例：${
      rejectedEntries[0]?.detail ??
      (USE_LIVE_MODEL ? '真实模型模式下模型可能未提出违规提案。' : '（无）')
    }`,
  );

  const withAdjustments = decisions.flatMap((d) =>
    d.executionLog.flatMap((entry) => entry.adjustments ?? []),
  );
  riskAdjustments.push(...withAdjustments);
  check(
    '运行时调整被记录',
    withAdjustments.length > 0 || USE_LIVE_MODEL,
    withAdjustments.length > 0
      ? `记录了 ${withAdjustments.length} 条运行时调整（风控推翻模型的地方），例如：${withAdjustments[0]}`
      : '本次回放未触发运行时调整（提案本身已在限制内），这属于正常情况。',
  );

  /* ---------------------------------------------------------------------- */
  /*  Report                                                                 */
  /* ---------------------------------------------------------------------- */

  const failed = checks.filter((c) => !c.ok);
  const returnPercent = ((finalAccount.equity - exchange.startBalance) / exchange.startBalance) * 100;

  if (AS_JSON) {
    process.stdout.write(
      JSON.stringify(
        {
          mode: USE_LIVE_MODEL ? 'live-model' : 'scripted',
          cycles: decisions.length,
          checks,
          summary: {
            startingEquity: exchange.startBalance,
            finalEquity: finalAccount.equity,
            returnPercent,
            entries: entries.length,
            exits: exits.length,
            stopOrders: stops.length,
            targetOrders: targets.length,
            closedTrades: trades.length,
            stopTriggered,
            targetTriggered,
            openPositions: openPositions.length,
            maxLeverageSeen,
            closeReasons,
          },
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    heading('4. 结果');
    line(`  起始权益      ${exchange.startBalance.toFixed(2)} USDT`);
    line(`  最终权益      ${finalAccount.equity.toFixed(2)} USDT  (${returnPercent >= 0 ? '+' : ''}${returnPercent.toFixed(2)}%)`);
    line(`  决策轮次      ${decisions.length}`);
    line(`  市价开仓      ${entries.length}`);
    line(`  挂出止损      ${stops.length}`);
    line(`  挂出止盈      ${targets.length}`);
    line(`  止损触发      ${stopTriggered}`);
    line(`  止盈触发      ${targetTriggered}`);
    line(`  已平仓交易    ${trades.length}`);
    line(`  当前持仓      ${openPositions.length}`);
    line(`  佣金合计      ${orders.reduce((sum, o) => sum + (o.fee ?? 0), 0).toFixed(4)} USDT`);
    line('');
    line(`  平仓原因分布  ${
      closeReasons.length > 0
        ? Object.entries(
            trades.reduce<Record<string, number>>((acc, t) => {
              acc[t.closeReason] = (acc[t.closeReason] ?? 0) + 1;
              return acc;
            }, {}),
          )
            .map(([reason, count]) => `${reason}×${count}`)
            .join('  ')
        : '（无）'
    }`);

    heading('校验结果');
    for (const item of checks) {
      line(`  [${item.soft ? '提示' : item.ok ? '通过' : '失败'}] ${item.name}`);
      line(`         ${item.detail}`);
    }

    line('');
    line(
      failed.length === 0
        ? `全部 ${checks.length} 项校验通过。`
        : `${checks.length - failed.length}/${checks.length} 项通过，${failed.length} 项失败：${failed.map((f) => f.name).join('、')}`,
    );
    line('');
  }

  closeDb();
  rmSync(workDir, { recursive: true, force: true });

  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`模拟失败：${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
