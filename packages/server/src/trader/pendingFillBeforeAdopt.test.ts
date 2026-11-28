/**
 * 线上实盘回归防线（2026-11-28 #21 CFGUSDT 实盘值守抓到）：
 *
 * 1. `runCycleBody` 第 12 步收尾调用 `reconcilePositions()` 之前，必须先调用 `settlePendingEntries()`，
 *    避免周期内 LLM 调用期间成交的限价单被收尾对账误当成外部手工仓位收养、挂上错误的 2.5% 兜底止损且丢掉预设止盈。
 * 2. 若因极端竞态或短暂接口异常导致收养仍抢先一步、随后 `promotePendingEntry` 把预设止损/止盈写回账本，
 *    `ensureStopsOnOpenPositionsForTrader` 必须在下一轮检测到收养兜底止损与账本预设止损偏离并真正替换交易所保护单。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, initDb } from '../db/index.js';
import {
  aiModels,
  exchanges,
  positions as positionStore,
  strategies,
  traders,
} from '../store/repositories.js';
import {
  ensureStopsOnOpenPositionsForTrader,
  type ReplaceProtectionParams,
} from './positionReconcile.js';

test('★★★ runCycleBody 第 12 步在 reconcilePositions 前必须先跑 settlePendingEntries', () => {
  const src = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');
  const step12Idx = src.indexOf('/* --- 12. Refresh and snapshot');
  assert.ok(step12Idx > 0, '找不到 runCycleBody 第 12 步');
  const slice = src.slice(step12Idx, step12Idx + 1200);
  const settleIdx = slice.indexOf('await this.settlePendingEntries()');
  const reconcileIdx = slice.indexOf('await this.reconcilePositions(finalPositions)');
  assert.ok(settleIdx > 0, '第 12 步必须调用 settlePendingEntries()');
  assert.ok(reconcileIdx > settleIdx, '第 12 步必须先 settlePendingEntries() 再 reconcilePositions(finalPositions)');
});

test('★★★ 被误收养后合并预设保护位时，ensureStopsOnOpenPositions 必须替换 2.5% 兜底止损并补挂止盈', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aq-adopt-sync-'));
  const file = path.join(dir, 'test.sqlite');
  closeDb();
  initDb(file);
  try {
    const ex = exchanges.create({
      label: 'test',
      exchange: 'binance',
      apiKey: 'k',
      apiSecretEnc: 's',
      testnet: true,
      canTrade: true,
    });
    const model = aiModels.create({
      provider: 'custom',
      label: 'm',
      model: 'm',
      baseUrl: '',
      apiKeyEnc: '',
      temperature: 0.2,
      maxTokens: 1024,
      timeoutSeconds: 30,
      maxRetries: 1,
    });
    const strat = strategies.create({
      name: 's',
      description: '',
      config: defaultStrategyConfig(),
      presetId: null,
    });
    const trader = traders.create({
      name: 't',
      exchangeAccountId: ex.id,
      aiModelId: model.id,
      strategyId: strat.id,
      cycleIntervalMinutes: 15,
      initialEquity: 100,
    });

    // 模拟：先被对账收养并挂了 2.5% 兜底止损 0.063278，随后 promotePendingEntry 把真实止损 0.0618 / 止盈 0.0725 写回账本
    positionStore.insert({
      traderId: trader.id,
      symbol: 'CFGUSDT',
      side: 'long',
      quantity: 400,
      entryPrice: 0.0649,
      leverage: 8,
      liquidationPrice: 0.0576,
      marginUsed: 3.245,
      stopLoss: 0.0618,
      takeProfit: 0.0725,
      stopOrderId: '4000002218072886',
      tpOrderId: null,
      openReasoning: '收养：该仓位是在机器人之外开立的。',
    });

    const calls: ReplaceProtectionParams[] = [];
    await ensureStopsOnOpenPositionsForTrader({
      traderId: trader.id,
      traderName: trader.name,
      isDryRun: false,
      exchangePositions: [
        {
          symbol: 'CFGUSDT',
          side: 'long',
          quantity: 400,
          entryPrice: 0.0649,
          markPrice: 0.0655,
          unrealizedPnl: 0.24,
          unrealizedPnlPercent: 7.4,
          leverage: 8,
          liquidationPrice: 0.0576,
          marginUsed: 3.245,
          notional: 26.2,
          marginType: 'isolated',
        },
      ],
      getFallbackStopLossPercent: () => 2.5,
      getMinRiskRewardRatio: () => 1.5,
      getBreakevenTriggerPercent: () => 10,
      getRequireTakeProfit: () => false,
      getOpenOrders: async () => [],
      getOpenAlgoOrders: async () => [
        {
          algoId: '4000002218072886',
          orderType: 'STOP_MARKET',
          triggerPrice: '0.0632775',
        },
      ],
      replacePositionProtection: async (params) => {
        calls.push(params);
        return { stopPlaced: true, targetPlaced: true, failures: [] };
      },
      emit: () => {},
      logWarn: () => {},
    });

    assert.equal(calls.length, 1, '应触发一次保护单替换');
    assert.equal(calls[0]!.stop, 0.0618, '必须把兜底止损 0.0632775 替换为预设止损 0.0618');
    assert.equal(calls[0]!.target, 0.0725, '必须同时补挂预设止盈 0.0725');
    assert.equal(calls[0]!.preserveStop, undefined, '不能保留错误的兜底止损');
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
