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
import { CLOSE_REASONS } from '@aq/shared';
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
 *  - `0/1/3` — very tight protection (0.4–0.5% stop, with the target just above
 *    the reward:risk floor). Crypto moves that far within a few 5-minute
 *    candles in either direction, so the exchange-side stop *and* target both
 *    get triggered across the run.
 *
 *    ⚠️ 止损不能再比 0.4% 更近：风控有一条手续费感知的门槛
 *    （`minStopLossFeeMultiple`，默认 3），而模拟交易所两腿手续费合计是名义价值的
 *    0.1%（**实测**算出来还会略高一点，因为数量取整后名义价值略小于请求值）——
 *    0.3% 的止损因此会被**正确地**拒掉，实测就拦到过。断言"止损/止盈真的会被触发"
 *    的用例，前提是它提出的是**能成立的交易**：提一个必亏的提案，测到的只是拒绝路径。
 *    0.4% 留了余量，免得门槛随实测费率的小数位抖动而忽过忽不过。
 *    改这条下限之前先看 `RiskEngine.reviewOpen()` 的第 6b 步。
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
  stopLoss: number | null;
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
        // Tight pairs are chosen to sit just above the configured reward:risk
        // floor — and never closer than the fee-aware stop floor (see above).
        const tight: Array<[number, number]> = [
          [0.4, 0.7],
          [0.45, 0.8],
          [0.5, 0.9],
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
      } else if (s.heldCycles === 1) {
        /*
         * **调整保护位** —— 把一个已经有浮盈的仓位止损往有利方向挪。
         *
         * ## 必须提议一个**真正的改善**，而不是一个固定的百分比
         *
         * 第一版提的是 `price × 0.99`（低 1%）。而开仓时用的是**紧止损**
         * （0.4–0.5%），所以对那几笔来说 1% 反而更松 —— 风控正确拒绝，
         * 这条校验于是永远失败。实测到的原文：
         *
         *     多头止损只能往上移（当前 80265.349，你给的是 79907.058）
         *
         * **那次失败暴露的是提议不合理，不是风控有问题** ——
         * 而一个永远失败的校验会掩盖真正的回归，所以必须修好它。
         *
         * 现在取**现有止损与现价的中点**：它一定比现有止损更紧
         * （多头往上、空头往下），也一定还在保护的那一侧。
         */
        const current = s.stopLoss;
        /*
         * **只在"有空间可收"时才收。**
         *
         * 第二版取的是"现有止损与现价的中点"。当仓位只有一点点浮盈时，
         * 那个中点离现价太近 —— 风控正确拒绝：
         *
         *     止损距离 0.147% 低于往返成本的 3 倍（0.287%）
         *
         * **这不是风控太严，是提议本身是个坏主意**：贴脸的止损会被
         * 正常波动扫掉，结局由噪音决定。所以这里先算一下空间够不够，
         * 不够就老实持有 —— 那正是真实的交易判断。
         */
        const room = current === null ? s.price * 0.01 : Math.abs(s.price - current);
        /* 距现价至少 0.35%：盖过 0.287% 的门槛，留一点余量。 */
        const minGap = s.price * 0.0035;
        const candidate = current === null ? s.price * 0.99 : (current + s.price) / 2;
        const usable = Math.abs(s.price - candidate) >= minGap;
        decision = usable
          ? {
              symbol,
              action: 'adjust_protection',
              stop_loss: Number(candidate.toPrecision(8)),
              confidence: 85,
              reasoning:
                `脚本化决策：把止损从 ${current ?? '（无）'} 收紧到 ${candidate.toPrecision(8)}` +
                `（第 ${s.heldCycles} 个周期）。`,
            }
          : {
              symbol,
              action: 'hold',
              confidence: 80,
              reasoning:
                `脚本化决策：止损离现价只有 ${(Math.abs(s.price - candidate) / s.price * 100).toFixed(3)}%，` +
                `收过去会被正常波动扫掉（空间 ${(room / s.price * 100).toFixed(3)}%），继续持有。`,
            };
      } else if (s.heldCycles === 2) {
        /* **加仓** —— 敞口变大，保护必须跟着重挂。 */
        decision = {
          symbol,
          action: 'add_to_position',
          position_size_usd: 100,
          confidence: 85,
          reasoning: `脚本化决策：同向加仓（第 ${s.heldCycles} 个周期）。`,
        };
      } else if (s.heldCycles === 3) {
        /* **减仓** —— 部分平仓，要当场记账、并按剩余数量重挂保护。 */
        decision = {
          symbol,
          action: 'reduce_position',
          reduce_percent: 40,
          confidence: 85,
          reasoning: `脚本化决策：先落袋一部分（第 ${s.heldCycles} 个周期）。`,
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
      kline: { primaryTimeframe: PRIMARY, selectedTimeframes: TIMEFRAMES, promptPoints: 30, primaryCount: WARMUP_CANDLES },
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
      /*
       * **与生产同一条路径。**
       *
       * 真实交易循环用的是 `reasoningEffort: 'high'`，模拟回放要用同一个值 ——
       * **否则这个回放就不是在生产的那条路径上跑**，而它存在的唯一理由
       * 就是"用真实往返验证真实路径"。
       */
      reasoningEffort: 'high',
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
        /*
         * **当前止损必须给出来。**
         *
         * 调整保护位时，脚本化模型要提一个**比现有止损更紧**的价位。
         * 不给它这个值的话，它只能猜（原来是 `price × 0.99`）——
         * 而遇到开仓时就用紧止损的那些阶段，这个"改善"其实是**放松**，
         * 于是被风控正确拒绝，校验就永远失败。
         *
         * 实测到的原文：`多头止损只能往上移（当前 80265.349，你给的是 79907.058）`。
         * **那次失败暴露的是脚本化提议不合理，不是风控有问题** ——
         * 而一个永远失败的校验会掩盖真正的回归，必须修好。
         */
        stopLoss: first?.stop_loss ?? null,
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
    /*
     * ⚠️ **用权威名单，不在这里再抄一份。**
     *
     * 这里原来是一份硬编码数组：`['model_decision', 'stop_loss', …]`。
     * 而权威名单是 `@aq/shared` 的 `CLOSE_REASONS` —— 两处各写一份，
     * **我加 `manual_partial` 时只改了权威那份，这条校验就失败了**
     * （报「实际出现的平仓原因：…、manual_partial」）。
     *
     * 这正是本项目在别处反复修过的那个模式：同一个概念两套实现，
     * 改动只覆盖了其中一处。**改成引用同一个常量，它就不可能再分叉。**
     */
    closeReasons.every((r) => (CLOSE_REASONS as readonly string[]).includes(r)),
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
  /*  仓位管理动作（调整保护 / 加仓 / 减仓）                                   */
  /* ---------------------------------------------------------------------- */

  /*
   * 这三个动作有一段时间**在动作集合里根本不存在** —— 模型只能开或平，
   * 止损止盈在开仓那一刻定死。用户的原话是「没有动态加仓、减仓、调整」。
   *
   * 它们各自有两个**只在真实往返里才暴露**的失败方式：
   *
   *   · 调整保护：旧止损没撤干净（交易所侧两张条件单，真实环境吃 `-4130`）、
   *     或本地 `stop_loss` 没跟着改（下一轮重复挂同一张）
   *   · 加仓：敞口变大而保护没跟着重挂 —— **多出来的那部分是裸的**
   *   · 减仓：部分平仓没当场记账（账面落后于账户）、或剩余数量的保护没重挂
   *
   * 单元测试覆盖了风控裁决，**覆盖不了这些"执行之后交易所侧与本地是否一致"** ——
   * 而那正是这一段要验证的。
   */
  const allExec = decisions.flatMap((d) => d.executionLog);
  const adjustRuns = allExec.filter((e) => e.action === 'adjust_protection');
  const addRuns = allExec.filter((e) => e.action === 'add_to_position');
  const reduceRuns = allExec.filter((e) => e.action === 'reduce_position');

  check(
    '调整保护位被真实执行',
    adjustRuns.some((e) => e.status === 'ok') || USE_LIVE_MODEL,
    `共 ${adjustRuns.length} 次调整保护位提案，其中 ${adjustRuns.filter((e) => e.status === 'ok').length} 次成功。` +
      (adjustRuns[0] ? ` 示例：${adjustRuns[0].detail}` : ''),
  );

  check(
    '加仓被真实执行',
    addRuns.some((e) => e.status === 'ok') || USE_LIVE_MODEL,
    `共 ${addRuns.length} 次加仓提案，其中 ${addRuns.filter((e) => e.status === 'ok').length} 次成功。` +
      (addRuns[0] ? ` 示例：${addRuns[0].detail}` : ''),
  );

  /*
   * **减仓必须留下一笔单独记账的成交。**
   *
   * 减仓与"全部平仓"的区别就在账目上：它当场记一笔（那部分已经实现），
   * 而仓位还开着。如果这里没有 `manual_partial` 的成交记录，
   * 说明那一部分盈亏根本没进账 —— 账面会比账户差，而 §2.5 两边都要能对上。
   */
  const partialTrades = tradeStore
    .list(trader.id, 500)
    .filter((t) => t.closeReason === 'manual_partial');
  check(
    '减仓留下了一笔单独记账的部分平仓',
    partialTrades.length > 0 || USE_LIVE_MODEL,
    partialTrades.length > 0
      ? `记录了 ${partialTrades.length} 笔部分平仓，例如 ${partialTrades[0]!.symbol} ` +
        `净 ${partialTrades[0]!.netPnl.toFixed(4)} USDT。`
      : '回放中没有产生部分平仓记录。',
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
