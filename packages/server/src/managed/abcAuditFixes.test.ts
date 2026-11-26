/**
 * 智能托管 2.0 深度审计（ABC 全量修复）综合回归单测：
 * - BUG-1：`manager.ts` + `AutoTrader.start()` 重启后首轮前必须已载入 `agent_config_json`（不复活 drawdownGuard）
 * - BUG-2：`AgentRuntime.isEnabled()` 在 `disableLegacyStrategist` 为真时恒为 `false`，且保留 `allowTradeReview`
 * - BUG-3：`managedThesisStore.markClosedWithOutcome` 正确采用全回合加权 `realizedR`
 * - BUG-4：`evaluateTraderManagedReadiness` 不双计 `entry_fee` 且按独立持仓回合聚合分批成交
 * - BUG-5：`managedThesisStore.savePending` + `consumePending` 跨周期/重启保留初始论点与雷达 6 维评分
 * - BUG-8：`updateEntryPrice` 同步加仓均价、`computeAi500Attribution` 小样本不误把补余加回负向弱因子、Prompt 动态渲染校准阈值
 * - BUG-9：`managedNotesStore.upsert` 保留已有 `counterexamples` 不清零
 * - B1：R 倍数 + ATR 自适应保本与宽追踪止损（防 23s 扫保本 & 洗飞主升浪）
 * - B2：`RiskEngine` §9b 下限支持 `minRiskBudgetRatio: 0.35` 放行 50% 试仓底仓
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { defaultStrategyConfig, unboundedAiManagedConfig, type MarketSnapshot } from '@aq/shared';

import { getDb, initDb } from '../db/index.js';
import { shouldMoveStopToBreakeven } from '../risk/breakeven.js';
import { RiskEngine } from '../risk/engine.js';
import { computeAi500Attribution } from '../radar/attribution.js';
import {
  aiModels,
  traders as traderStore,
  trades as tradeStore,
} from '../store/repositories.js';
import { AgentRuntime } from '../trader/agent/runtime.js';
import { managedNotesStore } from './notes.js';
import { buildManagedSystemPrompt } from './prompt.js';
import { evaluateTraderManagedReadiness } from './readiness.js';
import { managedThesisStore } from './thesis.js';

initDb(':memory:');

function createManagedTrader(name: string) {
  const model = aiModels.create({
    label: `model-${name}`,
    provider: 'openai',
    model: 'gpt-test',
    apiKeyEnc: '',
    baseUrl: 'https://example.invalid/v1',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 0,
  });
  const trader = traderStore.create({
    name,
    mode: 'ai_managed',
    dryRun: false,
    exchangeAccountId: null,
    aiModelId: model.id,
    strategyId: null,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
    paperStartingBalance: 100,
  });
  return { trader, model };
}

test('★ BUG-1 源码不变量：manager.ts 构造 AutoTrader 必须传 effectiveConfig，且 AutoTrader.start 启守卫前同步持久化配置', () => {
  const managerSrc = readFileSync(new URL('../trader/manager.ts', import.meta.url), 'utf8');
  const autoTraderSrc = readFileSync(new URL('../trader/autoTrader.ts', import.meta.url), 'utf8');

  assert.match(
    managerSrc,
    /new AutoTrader\(\{\s*trader,\s*config:\s*effectiveConfig,/,
    'manager.ts 必须把解析过 agent_config_json 的 effectiveConfig 传入 AutoTrader',
  );
  const syncIdx = autoTraderSrc.indexOf('this.syncManagedConfigFromDb();');
  const guardIdx = autoTraderSrc.indexOf('this.startGuardWatch();');
  assert.ok(syncIdx > 0 && guardIdx > syncIdx, 'AutoTrader.start() 必须在 startGuardWatch() 之前调用 syncManagedConfigFromDb()');
});

test('★ BUG-2：ai_managed 即使 agent_config_json 非空，disableLegacyStrategist=true 也必须令 AgentRuntime.isEnabled() 返回 false', () => {
  const { trader } = createManagedTrader('bug2-iso');
  const managedCfg = unboundedAiManagedConfig('aggressive');
  traderStore.setAgentConfig(trader.id, JSON.stringify(managedCfg));

  const runtime = new AgentRuntime({
    traderId: trader.id,
    strategyConfig: () => defaultStrategyConfig(),
    isAiStrategy: () => false,
    disableLegacyStrategist: () => true,
    allowTradeReview: () => true,
    model: { complete: async () => ({ text: '', latencyMs: 1, usage: { promptTokens: 0, completionTokens: 0 } }) },
    equityNow: () => 100,
    priceChangeSince: async () => null,
  });

  assert.equal(runtime.isEnabled(), false, 'ai_managed 下旧 1.0 AgentRuntime.isEnabled() 必须为 false');
  assert.equal(runtime.configOverride(), null, 'ai_managed 不再经由旧 AgentRuntime.configOverride() 读配置');
});

test('★ BUG-4：readiness.ts 不得双计 entry_fee，且必须按独立持仓回合聚合分批成交行', () => {
  const { trader } = createManagedTrader('bug4-readiness');
  const openedAt = new Date(Date.now() - 3600_000).toISOString();
  const closedAt1 = new Date(Date.now() - 1800_000).toISOString();
  const closedAt2 = new Date(Date.now() - 600_000).toISOString();

  // 同一笔持仓分 2 批平仓：partial (+0.60, fee 0.05 = entry 0.02 + exit 0.03) + final (+0.40, fee 0.05 = entry 0.02 + exit 0.03)
  tradeStore.insert({
    traderId: trader.id,
    symbol: 'ZECUSDT',
    side: 'short',
    quantity: 0.05,
    entryPrice: 730,
    exitPrice: 718,
    leverage: 10,
    grossPnl: 0.6,
    entryFee: 0.02,
    exitFee: 0.03,
    fundingFee: 0,
    closeReason: 'manual_partial',
    openedAt,
    closedAt: closedAt1,
    source: 'bot',
  });
  tradeStore.insert({
    traderId: trader.id,
    symbol: 'ZECUSDT',
    side: 'short',
    quantity: 0.05,
    entryPrice: 730,
    exitPrice: 722,
    leverage: 10,
    grossPnl: 0.4,
    entryFee: 0.02,
    exitFee: 0.03,
    fundingFee: 0.01,
    closeReason: 'stop_loss',
    openedAt,
    closedAt: closedAt2,
    source: 'bot',
  });

  const report = evaluateTraderManagedReadiness(trader.id, 24);
  assert.equal(report.metrics.closedTrades, 1, '同一 symbol+openedAt 的 2 条拆分行必须聚合为 1 笔独立回合');
  assert.equal(report.metrics.wins, 1);
  assert.equal(report.metrics.totalFees, 0.1, 'totalFees 必须为 0.10（不能再把 0.04 entry_fee 双计成 0.14）');
  assert.equal(report.metrics.totalNetPnl, 0.91);
});

test('★ BUG-5 & BUG-3B & BUG-8A：限价挂单论点持久化跨重启不丢 + 加仓同步均价 + 分批平仓加权 realizedR', () => {
  const { trader } = createManagedTrader('bug5-thesis');
  const dims = { trend: 18, breakout: 17, oiFlow: 13, takerFlow: 12, funding: 11, alphaPosition: 10 };

  managedThesisStore.savePending({
    traderId: trader.id,
    symbol: 'SSVUSDT',
    side: 'long',
    entryPrice: 2.5,
    initialStopLoss: 2.4,
    entryBasis: '放量突破回踩',
    addTrigger: '+1R 放量站稳 2.65 加仓',
    reduceTarget: '+2R 2.70 首减 35%',
    invalidation: '15m 收盘破 2.40',
    timeStopHours: 8,
    minProgressR: 0.4,
    maxAdverseExcursionPct: 3.5,
    entryRadarScore: 81,
    entryOiUsd: 12_000_000,
    entryTakerBuyRatio: 0.62,
    entryDimensions: dims,
    entryTier: 'strong',
  });

  // pending 论点不应混入 active 列表
  assert.equal(managedThesisStore.getActive(trader.id, 'SSVUSDT'), null);

  // 跨周期/重启成交消费 pending 草稿
  const pending = managedThesisStore.consumePending(trader.id, 'SSVUSDT');
  assert.ok(pending, '必须成功读出持久化的 pending 论点草稿');
  assert.equal(pending.addTrigger, '+1R 放量站稳 2.65 加仓');
  assert.equal(pending.entryRadarScore, 81);
  assert.deepEqual(pending.entryDimensions, dims);
  assert.equal(pending.entryTier, 'strong');

  // 转正后加仓更新加权均价
  managedThesisStore.upsertActive({
    traderId: trader.id,
    symbol: 'SSVUSDT',
    side: 'long',
    entryPrice: 2.5,
    initialStopLoss: 2.4,
    entryBasis: pending.entryBasis,
    addTrigger: pending.addTrigger,
    entryRadarScore: pending.entryRadarScore,
    entryDimensions: pending.entryDimensions,
    entryTier: pending.entryTier,
  });
  managedThesisStore.updateEntryPrice(trader.id, 'SSVUSDT', 2.55);
  assert.equal(managedThesisStore.getActive(trader.id, 'SSVUSDT')?.entryPrice, 2.55);

  // 分批平仓传入全回合加权 realizedR
  managedThesisStore.markClosedWithOutcome(trader.id, 'SSVUSDT', {
    tradeId: 999,
    netPnl: 1.8,
    exitPrice: 2.6,
    closeReason: 'stop_loss',
    realizedR: 1.92,
  });
  const closedRow = getDb().get<{ realized_r: number; realized_net_pnl: number }>(
    `SELECT realized_r, realized_net_pnl FROM managed_theses WHERE trader_id = ? AND symbol = 'SSVUSDT' AND status = 'closed' ORDER BY id DESC LIMIT 1`,
    trader.id,
  );
  assert.equal(closedRow?.realized_r, 1.92, '应采用全回合加权 realizedR 而非仅尾仓单价');
});

test('★ BUG-9A：managedNotesStore.upsertNote 未显式传 counterexamples 时必须保留历史反例计数', () => {
  const { trader } = createManagedTrader('bug9-notes');
  managedNotesStore.upsertNote({
    traderId: trader.id,
    symbol: 'INITUSDT',
    note: '首轮观察',
    triggerCondition: '15m 放量站上 0.145 且量比 > 1.8x',
    bias: 'long',
    confidence: 75,
  });
  const afterCe = managedNotesStore.recordCounterexample(trader.id, 'INITUSDT');
  assert.equal(afterCe.counterexamples, 1);

  // 下一轮 LLM 例行更新笔记文案，不传 counterexamples
  const updated = managedNotesStore.upsertNote({
    traderId: trader.id,
    symbol: 'INITUSDT',
    note: '二次修订观察',
    triggerCondition: '15m 放量站上 0.148 且量比 > 1.8x',
    bias: 'long',
    confidence: 72,
  });
  assert.equal(updated.ok, true);
  if (updated.ok) {
    assert.equal(updated.note.counterexamples, 1, '例行 upsert 不得把已有 counterexamples 清零');
  }
});

test('★ BUG-8B/8C：Prompt 动态展示校准阈值 + 归因小样本补余不倒加回负向弱因子', () => {
  const cfg = unboundedAiManagedConfig('aggressive');
  const sysPrompt = buildManagedSystemPrompt({
    traderName: 'test',
    cycleNumber: 10,
    now: new Date(),
    config: cfg,
    account: { equity: 100, availableBalance: 100, marginUsed: 0, unrealizedPnl: 0, positionCount: 0 },
    positions: [],
    pendingEntries: [],
    dossiers: [],
    radarLeaderboard: [],
    btcBenchmarkLine: null,
    cycleIntervalMinutes: 15,
    enableAgenticProtocol: true,
    calibration: { strongThreshold: 78, watchThreshold: 67 },
  });
  assert.match(sysPrompt, /评分 ≥ 78（强关注）/);
  assert.match(sysPrompt, /评分 67–77（观察）/);
  assert.match(sysPrompt, /\+1\.0R 且价格走幅 ≥ 1\.5%/, 'Prompt 必须如实披露 R 倍数保本守卫');
  assert.match(sysPrompt, /仅存在普通未成交限价挂单时请保持默认 15 分钟节拍/);

  // 构造 breakout 明显负相关的小样本（17 笔），验证 breakout 权重确实下调而不是被补余抵消成 0
  const samples = Array.from({ length: 17 }, (_, i) => {
    const win = i < 9;
    return {
      tradeId: i + 1,
      symbol: `COIN${i}USDT`,
      side: 'long' as const,
      entryScore: win ? 79 : 74,
      entryTier: (win ? 'strong' : 'watch') as 'strong' | 'watch',
      dimensions: {
        trend: win ? 18 : 12,
        breakout: win ? 6 : 19, // 明显负相关
        oiFlow: win ? 14 : 9,
        takerFlow: win ? 12 : 9,
        funding: 10,
        alphaPosition: 10,
      },
      netPnl: win ? 1.2 : -0.8,
      realizedR: win ? 1.5 : -1.0,
      closeReason: win ? 'take_profit' : 'stop_loss',
      closedAt: new Date(Date.now() - i * 60_000).toISOString(),
    };
  });
  const attr = computeAi500Attribution(samples);
  assert.equal(attr.applied, true);
  assert.ok(
    attr.weights.breakout < 20,
    `明显负相关的 breakout 权重应下调（实际 ${attr.weights.breakout}）`,
  );
  const weightSum = Object.values(attr.weights).reduce((a: number, b: number) => a + b, 0);
  assert.equal(weightSum, 100);
});

test('★ B1：ai_managed R 倍数 + ATR 自适应保本与宽追踪，彻底防 23s 扫保本与洗飞主升浪', () => {
  // 场景 1：10x 下涨 +0.5%（ROE +5%，但仅 0.17R，远不足 1R/1.5%）→ 严禁提前移保本
  const tooEarly = shouldMoveStopToBreakeven({
    side: 'long',
    entryPrice: 2.71,
    currentStop: 2.615,
    initialStopLoss: 2.615,
    markPrice: 2.724,
    unrealizedPnlPercent: 5.16,
    triggerPercent: 5,
    trailPercent: 2.5,
    breakevenTriggerR: 1.0,
    minBreakevenPriceMovePct: 1.5,
    breakevenFeeBufferPct: 0.12,
    trailTriggerR: 1.5,
    atr15mPct: 3.0,
    trailAtrMultiplier: 2.0,
  });
  assert.equal(tooEarly.move, false, '0.15R / +0.5% 涨幅不应触发保本（避免 23 秒扫保本）');

  // 场景 2：涨到 +1.1R 且价格走幅 +3.8%（≥1.5%，<1.5R）→ 移至含 +0.12% 费率缓冲的保本位，尚未开启紧追踪
  const hitBe = shouldMoveStopToBreakeven({
    side: 'long',
    entryPrice: 2.71,
    currentStop: 2.615,
    initialStopLoss: 2.615,
    markPrice: 2.815,
    unrealizedPnlPercent: 38.7,
    triggerPercent: 5,
    trailPercent: 2.5,
    breakevenTriggerR: 1.0,
    minBreakevenPriceMovePct: 1.5,
    breakevenFeeBufferPct: 0.12,
    trailTriggerR: 1.5,
    atr15mPct: 3.0,
    trailAtrMultiplier: 2.0,
  });
  assert.equal(hitBe.move, true);
  assert.ok(
    hitBe.newStop !== null && Math.abs(hitBe.newStop - 2.71 * 1.0012) < 1e-6,
    `保本位应含 +0.12% 费率缓冲（预期 ${(2.71 * 1.0012).toFixed(6)}，实际 ${hitBe.newStop}）`,
  );

  // 场景 3：主升浪到 +2.8R（现价 2.98，ATR15m=3.0% → 2.0×ATR=6.0% 宽追踪 → 止损 2.98 × 0.94 = 2.8012）
  const hitTrail = shouldMoveStopToBreakeven({
    side: 'long',
    entryPrice: 2.71,
    currentStop: 2.713252,
    initialStopLoss: 2.615,
    markPrice: 2.98,
    unrealizedPnlPercent: 99.6,
    triggerPercent: 5,
    trailPercent: 2.5,
    breakevenTriggerR: 1.0,
    minBreakevenPriceMovePct: 1.5,
    breakevenFeeBufferPct: 0.12,
    trailTriggerR: 1.5,
    atr15mPct: 3.0,
    trailAtrMultiplier: 2.0,
  });
  assert.equal(hitTrail.move, true);
  assert.ok(
    hitTrail.newStop !== null && Math.abs(hitTrail.newStop - 2.98 * 0.94) < 1e-6,
    `3% ATR 山寨应按 6.0% 宽距追踪（预期 ${(2.98 * 0.94).toFixed(6)}，实际 ${hitTrail.newStop}）`,
  );
});

test('★ B2：RiskEngine §9b 在 minRiskBudgetRatio=0.35 下放行 48% 试仓底仓，默认 0.5 仍拒绝', () => {
  const prevFlag = process.env.AQ_ENFORCE_RISK_BUDGET;
  process.env.AQ_ENFORCE_RISK_BUDGET = 'true';
  try {
    const engine = new RiskEngine();
    const config = unboundedAiManagedConfig('aggressive'); // riskPerTradePercent = 2.0 -> budget = $2.00 on $100
    const decision = {
      symbol: 'SSVUSDT',
      action: 'open_long' as const,
      leverage: 5,
      // 止损距离 4% → 名义 $24 对应风险 $0.96（预算 $2.00 的 48%）
      positionSizeUsd: 24,
      stopLoss: 2.4,
      takeProfit: 3.0,
      confidence: 80,
      riskUsd: 0.96,
      reasoning: '50% 试仓底仓',
      reducePercent: null,
      reduceQuantity: null,
      setupScore: 80,
      setupScoreBasis: '',
      adjustments: [],
    };
    const snap = {
      symbol: 'SSVUSDT',
      isMajor: false,
      price: 2.5,
      priceChangePercent24h: 8,
      high24h: 2.6,
      low24h: 2.2,
      volume24h: 1_000_000,
      quoteVolume24h: 20_000_000,
      primary: { timeframe: '15m' as const, klines: [], indicators: {} },
      timeframes: [],
      derivatives: { fundingRate: 0, openInterest: null, openInterestUsd: null, openInterestChangePercent: {} },
      quant: null,
      sources: ['ai500_radar'],
    } as unknown as MarketSnapshot;
    const baseEnv = {
      config,
      account: { equity: 100, availableBalance: 100, marginUsed: 0, positionCount: 0 },
      positions: new Map(),
      snapshots: new Map<string, MarketSnapshot>([['SSVUSDT', snap]]),
      minNotionalOf: () => 5,
      quantityFor: (_s: string, notional: number, price: number) => Math.floor((notional / price) * 100) / 100,
      entriesThisCycle: 0,
      entriesLastHour: 0,
    };

    const strictVerdict = engine.review([decision], baseEnv);
    assert.equal(strictVerdict.approved.length, 0, '默认 0.5 下限应拒绝 48% 风险仓位');

    const managedVerdict = engine.review([decision], {
      ...baseEnv,
      minRiskBudgetRatio: 0.35,
    });
    assert.equal(managedVerdict.approved.length, 1, 'ai_managed 0.35 下限应放行 48% 试仓底仓');
  } finally {
    if (prevFlag === undefined) delete process.env.AQ_ENFORCE_RISK_BUDGET;
    else process.env.AQ_ENFORCE_RISK_BUDGET = prevFlag;
  }
});
