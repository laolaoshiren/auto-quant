import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankConsensus } from './consensus.js';

/* -------------------------------------------------------------------------- */
/*  共识标的：多个榜同时指向的                                                 */
/* -------------------------------------------------------------------------- */

test('★ 共识标的：同时出现在多个榜里的，比只在一个榜里的更值得深看', () => {
  /*
   * ## 这一层的用途
   *
   * 第 1 层给出各维度的头部，但**每个榜是独立的** —— 模型看到 5-8 个榜、
   * 每个榜 8 个标的，合起来几十个。而深潜层只能放下 15-20 个。
   *
   * 那么该给谁完整行情？**多个榜同时指向的那个**：
   * 一个标的既在涨幅榜又在波动率榜，说明它"涨得多**且**在剧烈波动" ——
   * 那比只在成交额榜里出现（大盘币人人都能上）更值得看。
   *
   * ⚠️ **它只是"共振度"，不是"推荐"** —— 计数高不等于该做。
   * 选谁做仍然是模型的判断（用户原则：**模型是大脑，系统只是手脚**）。
   */
  const rows = rankConsensus({
    boards: [
      { label: '成交额', symbols: ['BTCUSDT', 'SOLUSDT', 'XYZUSDT'] },
      { label: '涨幅', symbols: ['XYZUSDT', 'ABCUSDT'] },
      { label: '波动率', symbols: ['XYZUSDT', 'ABCUSDT'] },
    ],
    limit: 10,
  });

  assert.equal(rows[0]!.symbol, 'XYZUSDT', '出现在三个榜里的排第一');
  assert.equal(rows[0]!.boards, 3);
  assert.deepEqual(rows[0]!.labels, ['成交额', '涨幅', '波动率'], '要带上依据 —— 模型据此判断');

  const abc = rows.find((r) => r.symbol === 'ABCUSDT')!;
  assert.equal(abc.boards, 2, '两个榜里的排第二');

  const btc = rows.find((r) => r.symbol === 'BTCUSDT')!;
  assert.equal(btc.boards, 1, '只在一个榜里的仍然在（只是排在后面）');
});

test('★ 只在一个榜里的标的不会被丢掉 —— 那正是"要不要看"该由模型决定', () => {
  /*
   * 系统在这里的职责是**排序**，不是**筛选**。
   * 若把单榜标的直接丢掉，等于系统替模型决定了"哪些不值得看" ——
   * 而那正是要修的病。它们排在后面，但仍在名单里。
   */
  const rows = rankConsensus({
    boards: [
      { label: '成交额', symbols: ['AUSDT'] },
      { label: '涨幅', symbols: ['BUSDT'] },
    ],
    limit: 10,
  });
  assert.equal(rows.length, 2, '两个单榜标的都在');
  assert.ok(rows.every((r) => r.boards === 1));
});

test('同分时保持榜内顺序（成交额大的仍在前面）', () => {
  /*
   * 同分时的次序不是随便的：调用方按"成交额榜在前"组织 `boards`，
   * 所以同分时**先出现的榜里的标的**该排前面 —— 那是"更做得动"的那个。
   */
  const rows = rankConsensus({
    boards: [
      { label: '成交额', symbols: ['BIGUSDT', 'MIDUSDT'] },
      { label: '涨幅', symbols: ['MIDUSDT', 'BIGUSDT'] },
    ],
    limit: 10,
  });
  assert.deepEqual(
    rows.map((r) => r.symbol),
    ['BIGUSDT', 'MIDUSDT'],
    '都是 2 个榜 → 按成交额榜的顺序',
  );
});

test('limit 截断，且截断的是共振度最低的那些', () => {
  const rows = rankConsensus({
    boards: [
      { label: 'A', symbols: ['ONEUSDT'] },
      { label: 'B', symbols: ['ONEUSDT', 'TWOUSDT'] },
    ],
    limit: 1,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.symbol, 'ONEUSDT', '★ 截断时保留共振度最高的');
});

test('符号大小写与重复都被规范化，同一个标的不该被数两次', () => {
  const rows = rankConsensus({
    boards: [{ label: 'A', symbols: ['btcusdt', 'BTCUSDT', '  '] }],
    limit: 10,
  });
  assert.equal(rows.length, 1, '同一个榜里的重复与空串不该产生多余条目');
  assert.equal(rows[0]!.symbol, 'BTCUSDT');
  assert.equal(rows[0]!.boards, 1);
});

test('空输入返回空数组', () => {
  assert.deepEqual(rankConsensus({ boards: [], limit: 10 }), []);
  assert.deepEqual(rankConsensus({ boards: [{ label: 'A', symbols: [] }], limit: 10 }), []);
});
