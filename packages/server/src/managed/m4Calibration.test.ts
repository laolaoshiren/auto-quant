/**
 * M4 回归与集成测试（`packages/server/src/managed/m4Calibration.test.ts`）：
 *   1. M4.3 成交归因纯函数（样本门槛、皮尔逊相关、有界权重校准、总和=100、红线微调）；
 *   2. M4.3 AI500 自定义校准权重计分与基准等价性；
 *   3. M4.3 SQLite v21 论点入场六维快照 → 平仓回填 realizedR → 自动重算持久化闭环；
 *   4. M4.1/M4.2 实盘就绪门禁与主账号红线阻断；
 *   5. M4.1 线上遥测暴露问题回归（笔记双重 `触发[...]` 清洗 + 池外非变更 wait/skip 过滤）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultStrategyConfig, type Kline } from '@aq/shared';

import { closeDb, initDb } from '../db/index.js';
import {
  DEFAULT_AI500_WEIGHTS,
  scoreAi500Symbol,
  type Ai500DimensionScores,
} from '../radar/ai500.js';
import {
  computeAi500Attribution,
  managedAttributionStore,
  MIN_CALIBRATION_SAMPLES,
  type AttributionSample,
} from '../radar/attribution.js';
import { aiModels, strategies, traders } from '../store/repositories.js';
import { normalizeFinalizePayload } from './engine.js';
import { managedNotesStore } from './notes.js';
import { evaluateManagedReadiness, isProtectedMainAccountLabel } from './readiness.js';
import { managedThesisStore } from './thesis.js';

function makeSynthKlines(count: number, startPrice: number, stepPct: number): Kline[] {
  const out: Kline[] = [];
  let p = startPrice;
  const baseTs = Date.parse('2026-11-24T00:00:00Z');
  for (let i = 0; i < count; i++) {
    const open = p;
    const close = open * (1 + stepPct);
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    const quoteVolume = 2_000_000 * (i >= count - 3 ? 2.4 : 1);
    out.push({
      openTime: baseTs + i * 15 * 60_000,
      closeTime: baseTs + (i + 1) * 15 * 60_000 - 1,
      open,
      high,
      low,
      close,
      volume: quoteVolume / close,
      quoteVolume,
      trades: 1200,
      takerBuyBase: (quoteVolume / close) * 0.68,
      takerBuyQuote: quoteVolume * 0.68,
    });
    p = close;
  }
  return out;
}

test('M4.3 成交归因：样本不足维持基准权重，样本达标后按相关性有界校准且总和严格=100', () => {
  const mkSample = (
    idx: number,
    dims: Ai500DimensionScores,
    netPnl: number,
    realizedR: number,
    tier: 'strong' | 'watch' = 'strong',
  ): AttributionSample => ({
    tradeId: idx + 1,
    symbol: `COIN${idx}USDT`,
    side: 'long',
    entryScore: 76,
    entryTier: tier,
    dimensions: dims,
    netPnl,
    realizedR,
    closeReason: netPnl > 0 ? 'take_profit' : 'stop_loss',
    closedAt: '2026-11-24T12:00:00Z',
  });

  // 1) 样本不足（5 笔 < 15）→ 不改权重
  const few = Array.from({ length: 5 }, (_, i) =>
    mkSample(
      i,
      { trend: 16, breakout: 15, oiFlow: 13, takerFlow: 13, funding: 10, alphaPosition: 10 },
      i % 2 === 0 ? 12 : -5,
      i % 2 === 0 ? 2.1 : -1.0,
    ),
  );
  const fewReport = computeAi500Attribution(few);
  assert.equal(fewReport.applied, false);
  assert.equal(fewReport.sampleSize, 5);
  assert.deepEqual(fewReport.weights, DEFAULT_AI500_WEIGHTS);

  // 2) 样本充足（24 笔）：oiFlow / takerFlow 与盈利强正相关，funding 与盈利强负相关
  const rich: AttributionSample[] = [];
  for (let i = 0; i < 24; i++) {
    const isWin = i < 14;
    rich.push(
      mkSample(
        i,
        {
          trend: isWin ? 17 : 13,
          breakout: isWin ? 16 : 14,
          oiFlow: isWin ? 14 : 3,
          takerFlow: isWin ? 14 : 4,
          funding: isWin ? 4 : 14,
          alphaPosition: isWin ? 11 : 9,
        },
        isWin ? 18 : -7,
        isWin ? 2.4 : -1.0,
        isWin ? 'strong' : 'watch',
      ),
    );
  }
  const richReport = computeAi500Attribution(rich);
  assert.equal(richReport.applied, true);
  assert.equal(richReport.sampleSize, 24);
  assert.ok(richReport.sampleSize >= MIN_CALIBRATION_SAMPLES);

  const wSum =
    richReport.weights.trend +
    richReport.weights.breakout +
    richReport.weights.oiFlow +
    richReport.weights.takerFlow +
    richReport.weights.funding +
    richReport.weights.alphaPosition;
  assert.equal(wSum, 100, '校准后六维权重总和必须严格等于 100');

  for (const val of Object.values(richReport.weights)) {
    assert.ok(val >= 8 && val <= 30, `单因子权重必须在 [8, 30] 护栏内，实得 ${val}`);
  }
  assert.ok(
    richReport.weights.oiFlow > DEFAULT_AI500_WEIGHTS.oiFlow,
    `高正相关因子 oiFlow 权重应上调（实得 ${richReport.weights.oiFlow}）`,
  );
  assert.ok(
    richReport.weights.funding < DEFAULT_AI500_WEIGHTS.funding,
    `负相关因子 funding 权重应下调（实得 ${richReport.weights.funding}）`,
  );
  assert.ok(
    richReport.strongThreshold - richReport.watchThreshold >= 8,
    '强关注与观察红线必须维持至少 8 分梯度',
  );
});

test('M4.3 AI500 评分：默认权重与显式传基准权重分值完全一致，校准权重按比例生效', () => {
  const k15 = makeSynthKlines(64, 100, 0.002);
  const k4h = makeSynthKlines(32, 90, 0.004);
  const baseInput = {
    symbol: 'SOLUSDT',
    price: k15[k15.length - 1]!.close,
    quoteVolume24h: 180_000_000,
    changePercent24h: 6.5,
    fundingRate: 0.0001,
    klines15m: k15,
    klines4h: k4h,
    openInterestUsd: 80_000_000,
    oiChange1hPct: 5.5,
    oiChange4hPct: 9.2,
    btcReturn1hPct: 0.2,
    btcReturn4hPct: 0.5,
  };

  const baseline = scoreAi500Symbol(baseInput);
  const explicitBaseline = scoreAi500Symbol(baseInput, { weights: { ...DEFAULT_AI500_WEIGHTS } });
  assert.equal(baseline.score, explicitBaseline.score);
  assert.deepEqual(baseline.dimensions, explicitBaseline.dimensions);

  const tilted = scoreAi500Symbol(baseInput, {
    weights: { trend: 28, breakout: 22, oiFlow: 18, takerFlow: 14, funding: 8, alphaPosition: 10 },
    strongThreshold: 78,
    watchThreshold: 68,
  });
  assert.ok(tilted.score >= 0 && tilted.score <= 100);
  assert.equal(
    tilted.tier,
    tilted.score >= 78 ? 'strong' : tilted.score >= 68 ? 'watch' : 'skip',
  );
});

test('M4.3 SQLite v21 闭环：入场六维快照落库 → 平仓回填 realizedR → 自动重算持久化校准', () => {
  initDb(':memory:');
  try {
    const model = aiModels.create({
      provider: 'custom',
      label: 'M4 Test Model',
      model: 'workbuddy/deepseek-v4.1-flash',
      baseUrl: 'http://127.0.0.1:3425/v1',
      apiKeyEnc: 'enc-dummy',
      temperature: 0.2,
      maxTokens: 4096,
      timeoutSeconds: 60,
      maxRetries: 1,
    });
    const strat = strategies.create({
      name: 'M4 测试策略',
      description: 'test',
      config: defaultStrategyConfig(),
      presetId: null,
      isDefault: false,
    });
    const trader = traders.create({
      name: 'M4 归因测试机',
      exchangeAccountId: null,
      aiModelId: model.id,
      strategyId: strat.id,
      cycleIntervalMinutes: 15,
      initialEquity: 1000,
      mode: 'ai_managed',
      dryRun: true,
    });

    for (let i = 0; i < 16; i++) {
      const sym = `T${i}USDT`;
      const isWin = i % 3 !== 0;
      managedThesisStore.upsertActive({
        traderId: trader.id,
        symbol: sym,
        side: 'long',
        entryPrice: 100,
        initialStopLoss: 98,
        entryBasis: '突破回踩确认',
        entryRadarScore: isWin ? 79 : 66,
        entryTier: isWin ? 'strong' : 'watch',
        entryDimensions: {
          trend: isWin ? 18 : 11,
          breakout: isWin ? 17 : 12,
          oiFlow: isWin ? 14 : 4,
          takerFlow: isWin ? 13 : 5,
          funding: isWin ? 7 : 13,
          alphaPosition: isWin ? 10 : 9,
        },
      });
      managedThesisStore.markClosedWithOutcome(trader.id, sym, {
        tradeId: 1000 + i,
        netPnl: isWin ? 15 : -6,
        exitPrice: isWin ? 105 : 98,
        closeReason: isWin ? 'take_profit' : 'stop_loss',
      });
    }

    const report = managedAttributionStore.recompute(trader.id);
    assert.equal(report.applied, true);
    assert.equal(report.sampleSize, 16);

    const active = managedAttributionStore.getActiveOptions(trader.id);
    assert.equal(active.applied, true);
    assert.equal(active.sampleSize, 16);
    assert.deepEqual(active.weights, report.weights);

    const fetched = managedAttributionStore.get(trader.id);
    assert.equal(fetched.sampleSize, 16);
    assert.equal(fetched.applied, true);
  } finally {
    closeDb();
  }
});

test('M4.1/M4.2 就绪门禁：主账号硬阻断、早期回撤守卫告警、健康子账号全绿通过', () => {
  assert.equal(isProtectedMainAccountLabel('主账号'), true);
  assert.equal(isProtectedMainAccountLabel('Binance 主账户'), true);
  assert.equal(isProtectedMainAccountLabel('gaoshou3'), false);

  const healthyCycles = Array.from({ length: 20 }, (_, i) => ({
    success: true,
    promptChars: 22_500,
    promptTokens: 20_000,
    cachedTokens: 12_000,
    watchOrHoldOnly: i % 2 === 0,
  }));
  const healthyTrades = [
    { netPnl: 12, fee: 0.4, fundingFee: 0, closeReason: 'take_profit' },
    { netPnl: 9, fee: 0.3, fundingFee: 0, closeReason: 'trailing_stop' },
    { netPnl: -4, fee: 0.3, fundingFee: 0, closeReason: 'thesis_mae_stop' },
    { netPnl: 15, fee: 0.5, fundingFee: 0, closeReason: 'take_profit' },
    { netPnl: -5, fee: 0.3, fundingFee: 0, closeReason: 'thesis_time_stop' },
  ];

  const subOk = evaluateManagedReadiness({
    windowHours: 72,
    dryRun: false,
    exchangeAccountLabel: 'gaoshou3',
    exchangeIsTestnet: false,
    drawdownGuardEnabled: false,
    cycles: healthyCycles,
    trades: healthyTrades,
    unprotectedOpenCount: 0,
  });
  assert.equal(subOk.overall, 'pass');
  assert.equal(subOk.metrics.thesisTriggerCount, 2);

  const mainBlocked = evaluateManagedReadiness({
    windowHours: 72,
    dryRun: false,
    exchangeAccountLabel: '主账号',
    exchangeIsTestnet: false,
    drawdownGuardEnabled: false,
    cycles: healthyCycles,
    trades: healthyTrades,
    unprotectedOpenCount: 0,
  });
  assert.equal(mainBlocked.overall, 'fail');
  assert.equal(
    mainBlocked.checks.find((c) => c.id === 'subaccount_safety')?.status,
    'fail',
  );

  const ddWarn = evaluateManagedReadiness({
    windowHours: 72,
    dryRun: true,
    exchangeAccountLabel: null,
    exchangeIsTestnet: false,
    drawdownGuardEnabled: true,
    cycles: healthyCycles,
    trades: healthyTrades,
    unprotectedOpenCount: 0,
  });
  assert.equal(ddWarn.overall, 'warn');
  assert.equal(ddWarn.checks.find((c) => c.id === 'drawdown_guard_off')?.status, 'warn');
});

test('M4.1 遥测缺陷回归：笔记自动剥离双重 触发[...] 包裹；finalize 过滤池外非变更 wait/skip', () => {
  initDb(':memory:');
  try {
    const model = aiModels.create({
      provider: 'custom',
      label: 'M4 Note Model',
      model: 'workbuddy/deepseek-v4.1-flash',
      baseUrl: 'http://127.0.0.1:3425/v1',
      apiKeyEnc: 'enc-dummy',
      temperature: 0.2,
      maxTokens: 4096,
      timeoutSeconds: 60,
      maxRetries: 1,
    });
    const strat = strategies.create({
      name: 'M4 笔记测试',
      description: 'test',
      config: defaultStrategyConfig(),
      presetId: null,
      isDefault: false,
    });
    const trader = traders.create({
      name: 'M4 笔记机',
      exchangeAccountId: null,
      aiModelId: model.id,
      strategyId: strat.id,
      cycleIntervalMinutes: 15,
      initialEquity: 1000,
      mode: 'ai_managed',
      dryRun: true,
    });

    const saved = managedNotesStore.upsertNote({
      traderId: trader.id,
      symbol: 'LISTAUSDT',
      note: '等待放量突破',
      triggerCondition: '触发[触发[15m 收盘站上 0.1147 且量比>1.5x]]',
      bias: 'long',
    });
    assert.equal(saved.ok, true);
    if (saved.ok) {
      assert.equal(saved.note.triggerCondition, '15m 收盘站上 0.1147 且量比>1.5x');
    }
  } finally {
    closeDb();
  }

  const normalized = normalizeFinalizePayload(
    {
      summary: '测试池外过滤',
      decisions: [
        { symbol: 'BTCUSDT', action: 'wait', reasoning: '池内观望' },
        { symbol: 'OUTSIDE1USDT', action: 'wait', reasoning: '榜外观察' },
        { symbol: 'OUTSIDE2USDT', action: 'skip', reasoning: '榜外跳过' },
        { symbol: 'OUTSIDE3USDT', action: 'open_long', reasoning: '越权开仓仍保留给风控审计' },
      ],
    },
    [],
    ['BTCUSDT'],
  );
  assert.ok(normalized.text.includes('BTCUSDT'));
  assert.ok(!normalized.text.includes('OUTSIDE1USDT'), '池外非变更 wait 应被滤除防误报');
  assert.ok(!normalized.text.includes('OUTSIDE2USDT'), '池外非变更 skip 应被滤除防误报');
  assert.ok(normalized.text.includes('OUTSIDE3USDT'), '池外开仓意图必须保留交由风控/解析器拦截');
});
