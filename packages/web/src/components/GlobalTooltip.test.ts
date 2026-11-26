import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeTooltipPosition, parseTooltipContent } from './GlobalTooltip';

describe('parseTooltipContent', () => {
  it('handles blank strings as empty', () => {
    assert.deepEqual(parseTooltipContent('   \n  '), { kind: 'empty', text: '' });
  });

  it('renders single-line hints as compact single variant', () => {
    assert.deepEqual(parseTooltipContent('  第 135 轮决策周期  '), {
      kind: 'single',
      text: '第 135 轮决策周期',
    });
  });

  it('parses structured multi-line token billing tooltip with header value, note, and kv rows', () => {
    const raw = [
      '本轮 Token 估算费用：$0.0111（不计入实盘交易盈亏）',
      '· 未缓存输入：16,844 × $0.3/1M = $0.0051',
      '· 缓存命中：24,064 × $0.03/1M = $0.0007',
      '· 输出（含思考）：4,200 × $1.25/1M = $0.0053',
      '· 单价来源：models.dev 实时价格（2026-11-26）',
    ].join('\n');

    const parsed = parseTooltipContent(raw);
    assert.equal(parsed.kind, 'rich');
    if (parsed.kind !== 'rich') return;

    assert.equal(parsed.headerLabel, '本轮 Token 估算费用');
    assert.equal(parsed.headerValue, '$0.0111');
    assert.equal(parsed.headerNote, '不计入实盘交易盈亏');
    assert.deepEqual(parsed.rows, [
      { kind: 'kv', label: '未缓存输入', value: '16,844 × $0.3/1M = $0.0051', isBullet: true },
      { kind: 'kv', label: '缓存命中', value: '24,064 × $0.03/1M = $0.0007', isBullet: true },
      { kind: 'kv', label: '输出（含思考）', value: '4,200 × $1.25/1M = $0.0053', isBullet: true },
      { kind: 'kv', label: '单价来源', value: 'models.dev 实时价格（2026-11-26）', isBullet: true },
    ]);
  });

  it('parses multi-line prose without colons into header + note rows', () => {
    const raw =
      '输入 40,908 tokens 中 24,064 命中前缀缓存（59%）\n命中部分按 1/10 计费并显著加快首字响应';
    const parsed = parseTooltipContent(raw);
    assert.deepEqual(parsed, {
      kind: 'rich',
      headerLabel: '输入 40,908 tokens 中 24,064 命中前缀缓存（59%）',
      headerValue: undefined,
      headerNote: undefined,
      rows: [
        {
          kind: 'note',
          text: '命中部分按 1/10 计费并显著加快首字响应',
          isBullet: false,
        },
      ],
    });
  });

  it('does not falsely split URLs or clock prefixes as ASCII key-value pairs', () => {
    const raw = '链接说明\nhttps: //example.com\n12: 34 备注';
    const parsed = parseTooltipContent(raw);
    assert.equal(parsed.kind, 'rich');
    if (parsed.kind !== 'rich') return;
    assert.equal(
      parsed.rows.every((r) => r.kind === 'note'),
      true,
    );
  });
});

describe('computeTooltipPosition', () => {
  const viewport = { width: 1440, height: 900 };

  it('places tooltip centered above anchor by default', () => {
    const pos = computeTooltipPosition(
      { top: 300, bottom: 324, left: 600, right: 680, width: 80, height: 24 },
      { width: 200, height: 40 },
      viewport,
    );
    assert.equal(pos.placement, 'top');
    assert.equal(pos.top, 300 - 9 - 40);
    assert.equal(pos.left, 640 - 100);
    assert.equal(pos.arrowLeft, 100);
  });

  it('flips to bottom when anchor is close to top edge', () => {
    const pos = computeTooltipPosition(
      { top: 20, bottom: 44, left: 500, right: 580, width: 80, height: 24 },
      { width: 220, height: 80 },
      viewport,
    );
    assert.equal(pos.placement, 'bottom');
    assert.equal(pos.top, 44 + 9);
    assert.equal(pos.arrowLeft, 110);
  });

  it('clamps horizontally near left and right viewport edges while pointing arrow at anchor', () => {
    const leftEdge = computeTooltipPosition(
      { top: 200, bottom: 224, left: 10, right: 40, width: 30, height: 24 },
      { width: 240, height: 48 },
      viewport,
    );
    assert.equal(leftEdge.left, 12);
    assert.equal(leftEdge.arrowLeft, 14);

    const rightEdge = computeTooltipPosition(
      { top: 200, bottom: 224, left: 1390, right: 1430, width: 40, height: 24 },
      { width: 240, height: 48 },
      viewport,
    );
    assert.equal(rightEdge.left, 1440 - 12 - 240);
    assert.equal(rightEdge.arrowLeft, 1410 - rightEdge.left);
  });
});
