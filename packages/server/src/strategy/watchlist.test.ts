import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addToWatchlist,
  decayWatchlist,
  watchlistSymbols,
  type WatchlistEntry,
} from './watchlist.js';

/* -------------------------------------------------------------------------- */
/*  模型的"点名"清单                                                             */
/* -------------------------------------------------------------------------- */

const e = (symbol: string, remaining: number): WatchlistEntry => ({ symbol, remaining });

test('★ 模型点名之后，下一轮它要的标的就在清单里', () => {
  /*
   * ## 这一层的用途（用户 2026-09-30 的原话）
   *
   * > 「**模型是大脑，系统只是他的手脚**」
   *
   * 第 0/1 层让它**看见**市场，`screen_symbols` 让它**自己筛**。
   * 而筛出来之后它还得说"下一轮把 A、B、C 给我完整行情" —— 那就是这个清单。
   *
   * 没有它，模型每一轮都从零开始看那 15-20 个系统选的候选，
   * 上一轮的发现**当场作废**。那正是"系统替它决定看什么"。
   */
  const rows = addToWatchlist({
    current: [],
    symbols: ['btcusdt', 'ETHUSDT'],
    reason: '成交额放大',
    ttlRounds: 3,
    maxSize: 10,
  });
  assert.deepEqual(
    rows.map((r) => r.symbol),
    ['BTCUSDT', 'ETHUSDT'],
    '符号要规范化成大写',
  );
  assert.equal(rows[0]!.remaining, 3, 'TTL 由调用方给');
  assert.equal(rows[0]!.reason, '成交额放大');
  assert.deepEqual(watchlistSymbols(rows), ['BTCUSDT', 'ETHUSDT']);
});

test('★ 重复点名不会堆出两行，而是把它续期', () => {
  /*
   * 模型很可能连续几轮都点同一个标的（"我还在盯它"）。
   * 若每次都追加一行，清单会迅速膨胀 —— 而它表达的意思只是"继续看着"。
   */
  const rows = addToWatchlist({
    current: [e('SOLUSDT', 1)],
    symbols: ['SOLUSDT'],
    ttlRounds: 3,
    maxSize: 10,
  });
  assert.equal(rows.length, 1, '★ 同标的只该有一行');
  assert.equal(rows[0]!.remaining, 3, '续期到新的 TTL');
});

test('★ 清单有上限 —— 点名太多时挤掉最旧的那些', () => {
  /*
   * 上限由**系统**把关（"手脚"的职责）：它可能一次点名 30 个，
   * 那会把提示词预算挤爆、把真正该看的东西挤掉。**要哪些由它定，最多几个由系统定。**
   */
  const current = Array.from({ length: 3 }, (_, i) => e(`OLD${i}USDT`, 2));
  const rows = addToWatchlist({
    current,
    symbols: ['NEW1USDT', 'NEW2USDT'],
    ttlRounds: 3,
    maxSize: 4,
  });
  assert.equal(rows.length, 4, '不得超过上限');
  assert.ok(
    watchlistSymbols(rows).includes('NEW1USDT'),
    '新点名的必须在（那是它这一轮的意思）',
  );
  assert.ok(!watchlistSymbols(rows).includes('OLD0USDT'), '挤掉的应是最旧的');
});

test('★ 一次点名超出上限时，只收下装得下的那些', () => {
  const rows = addToWatchlist({
    current: [],
    symbols: ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT'],
    ttlRounds: 2,
    maxSize: 2,
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(watchlistSymbols(rows), ['AUSDT', 'BUSDT'], '按它给的顺序收下');
});

test('★ 每过一轮就减一，到期的自动消失 —— 名单不该永远留着', () => {
  /*
   * TTL 是必要的：模型的"临时兴趣"不该变成永久候选。
   * 而它是**递减**而不是"用完即清"——因为它很可能连续几轮都在看同一个标的，
   * 每轮都重新点名是多余的（而且它不一定记得）。
   */
  const rows = decayWatchlist([e('AUSDT', 2), e('BUSDT', 1)]);
  assert.deepEqual(
    rows.map((r) => [r.symbol, r.remaining]),
    [['AUSDT', 1]],
    '到期的被移除，未到期的减一',
  );
  assert.deepEqual(decayWatchlist([]), []);
});

test('无效符号被跳过，而不是变成一行空字符串', () => {
  const rows = addToWatchlist({
    current: [],
    symbols: ['', '  ', 'OKUSDT'],
    ttlRounds: 2,
    maxSize: 10,
  });
  assert.deepEqual(watchlistSymbols(rows), ['OKUSDT']);
});
