import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionLogEntry } from '@aq/shared';
import { isManagedTrajectoryEntry, resolveManagedStageChips } from './PowerlineTrajectory';

describe('ManagedStageActionBar resolver', () => {
  it('strips redundant plan/finalize on legacy text trajectory and keeps actionable items', () => {
    const entry: ExecutionLogEntry = {
      action: 'wait',
      symbol: '-',
      status: 'data',
      detail: '三段式决策轨迹：plan → note:ZECUSDT → note:SSVUSDT → finalize(4)',
    };
    assert.equal(isManagedTrajectoryEntry(entry), true);
    const chips = resolveManagedStageChips(entry);
    assert.equal(chips.length, 2);
    assert.equal(chips[0]?.label, '笔记 ZEC');
    assert.equal(chips[0]?.symbol, 'ZECUSDT');
    assert.equal(chips[0]?.legacy, true);
    assert.equal(chips[1]?.label, '笔记 SSV');
    assert.equal(chips[1]?.symbol, 'SSVUSDT');
  });

  it('returns empty chips for legacy bare plan -> finalize so UI hides the empty bar', () => {
    const entry: ExecutionLogEntry = {
      action: 'wait',
      symbol: '-',
      status: 'data',
      detail: '三段式决策轨迹：plan → finalize(4)',
    };
    assert.equal(isManagedTrajectoryEntry(entry), true);
    assert.deepEqual(resolveManagedStageChips(entry), []);
  });

  it('renders structured stageSteps with market regime, note trigger, and early check', () => {
    const entry: ExecutionLogEntry = {
      action: 'wait',
      symbol: '-',
      status: 'data',
      detail: '三段式决策轨迹：plan → note:ZECUSDT → finalize(4)',
      stageSteps: [
        {
          kind: 'plan',
          round: 1,
          title: '大盘定调',
          summary: 'BTC 横盘整理，山寨诱多为主',
        },
        {
          kind: 'note',
          round: 1,
          symbol: 'ZECUSDT',
          title: '笔记 ZEC',
          summary: '放量砸破后被收复，空头逻辑失效',
          meta: [
            { label: '方向', value: '偏空' },
            { label: '信心', value: '62%' },
            { label: '触发条件', value: '15m 跌破 755 且量比 >= 1.8x' },
          ],
        },
        {
          kind: 'finalize',
          round: 2,
          title: '提交(4)',
          meta: [
            { label: '工具轮次', value: '2 轮' },
            { label: '下次复查', value: '提前 6 分钟' },
          ],
        },
      ],
    };

    const chips = resolveManagedStageChips(entry);
    assert.equal(chips.length, 3);
    assert.equal(chips[0]?.kind, 'plan');
    assert.ok(chips[0]?.label.startsWith('大盘 · BTC'));
    assert.equal(chips[1]?.kind, 'note');
    assert.equal(chips[1]?.biasDot, 'short');
    assert.equal(chips[1]?.legacy, undefined);
    assert.equal(chips[2]?.kind, 'early_check');
    assert.equal(chips[2]?.label, '提前 6 分钟复查');
  });
});
