import assert from 'node:assert/strict';
import test from 'node:test';
import type { Decision, DecisionRecord } from '@aq/shared';
import {
  isActiveInFlightPending,
  isPendingDecisionRecord,
  preferCompletedDecision,
} from './decisionPending';

function makeDecision(symbol: string, action: Decision['action'], reasoning: string): Decision {
  return {
    symbol,
    action,
    leverage: action === 'open_long' ? 10 : 0,
    positionSizeUsd: action === 'open_long' ? 50 : 0,
    stopLoss: null,
    takeProfit: null,
    confidence: 70,
    riskUsd: 0,
    reasoning,
  } as Decision;
}

function makeRecord(patch: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 5104,
    traderId: 21,
    cycleNumber: 98,
    timestamp: '2026-11-26T02:06:00.000Z',
    systemPrompt: '',
    userPrompt: '',
    cotTrace: '',
    decisions: [],
    rawResponse: '',
    executionLog: [],
    candidateSymbols: [],
    success: true,
    error: null,
    aiLatencyMs: 0,
    promptTokens: null,
    completionTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    ...patch,
  };
}

test('★★★ decisionStore.begin() 刚插入的空白占位行必须被准确识别为 pending', () => {
  const pending = makeRecord();
  assert.equal(isPendingDecisionRecord(pending), true);
});

test('★★★ 任何正常收尾记录（有耗时/有决策/有报错/有skip_cycle/有原文）都不得误判为 pending', () => {
  assert.equal(isPendingDecisionRecord(makeRecord({ aiLatencyMs: 120 })), false);
  assert.equal(
    isPendingDecisionRecord(
      makeRecord({ decisions: [makeDecision('LINKUSDT', 'wait', '观望')] }),
    ),
    false,
  );
  assert.equal(
    isPendingDecisionRecord(makeRecord({ success: false, error: '请求超时' })),
    false,
  );
  assert.equal(
    isPendingDecisionRecord(
      makeRecord({
        executionLog: [{ action: 'skip_cycle', symbol: '-', status: 'skipped', detail: '熔断跳过' }],
      }),
    ),
    false,
  );
  assert.equal(isPendingDecisionRecord(makeRecord({ rawResponse: '{"decisions":[]}' })), false);
});

test('★★★ 运行中周期的 pending 占位行被判为活跃在途（即使刷新丢了 liveCycle 也能恢复转圈）', () => {
  const nowMs = Date.parse('2026-11-26T02:06:09.000Z');
  const pending = makeRecord({ timestamp: '2026-11-26T02:06:00.000Z' });

  assert.equal(
    isActiveInFlightPending(pending, { isRunning: true, liveCycleNumber: 98, nowMs }),
    true,
  );
  // 中途刷新页面（没有 WS liveCycle）但周期刚启动 9 秒 → 仍判为活跃在途
  assert.equal(
    isActiveInFlightPending(pending, { isRunning: true, nowMs }),
    true,
  );
  // 机器人已停止 → 不再作为在途转圈
  assert.equal(
    isActiveInFlightPending(pending, { isRunning: false, nowMs }),
    false,
  );
  // 超过 25 分钟的历史遗留中断占位行 → 不无限转圈
  const oldNow = Date.parse('2026-11-26T02:45:00.000Z');
  assert.equal(
    isActiveInFlightPending(pending, { isRunning: true, nowMs: oldNow }),
    false,
  );
});

test('★★★ 同 id 合并时，已完成终态永远压过旧轮询里的 pending 占位行', () => {
  const pending = makeRecord();
  const finished = makeRecord({
    aiLatencyMs: 32500,
    promptTokens: 41000,
    completionTokens: 3200,
    decisions: [makeDecision('LINKUSDT', 'open_long', '放量突破')],
  });

  // 终态先到（WS）、陈旧 pending 后到（REST）→ 保留终态
  assert.equal(preferCompletedDecision(finished, pending), finished);
  // pending 先到（REST）、终态后到（WS 或下一次 REST）→ 升级为终态
  assert.equal(preferCompletedDecision(pending, finished), finished);
});
