import assert from 'node:assert/strict';
import test from 'node:test';

import { pairEquityByTrader } from './equityPairing';
import type { EquitySnapshot } from '@aq/shared';

const snap = (traderId: number, equity: number): EquitySnapshot =>
  ({
    traderId,
    equity,
    timestamp: '2026-10-14T00:00:00.000Z',
  }) as unknown as EquitySnapshot;

/**
 * ★★ 按 id 配对，而不是按下标 —— 钉住"机器人改序后张冠李戴"。
 *
 * 缺陷形状（旧写法）：loader 返回 `Promise.all(ids.map(...))` 的**位置数组**，
 * 而 `traders` 当前顺序与请求发出时的 ids 顺序不同时，`data[index]` 会把
 * **A 机器人的曲线配到 B 机器人**上。权益是钱 —— 首屏的账户合计、区间盈亏、
 * 曲线全部跟着错。
 *
 * 本用例证明 id 配对对"顺序不一致"免疫：pairs 的数组顺序与 traders 不同，
 * 每个 id 仍然拿回自己的 rows。
 */
test('★ 顺序不同也按 id 对号入座（位置数组会错配，表不会）', () => {
  /* 请求是按 [7, 9] 发的，结果数组里 7 在前。 */
  const pairs = [
    { id: 7, rows: [snap(7, 100)] },
    { id: 9, rows: [snap(9, 250)] },
  ];
  const byId = pairEquityByTrader(pairs);

  /* traders 当前可能是 [9, 7]（改名/删除后重排）。 */
  const tradersNow = [9, 7];
  const old = { data: pairs.map((p) => p.rows) }; // 旧的位置数组

  /* 按 id：9 号拿到自己的 250。 */
  assert.deepEqual(byId[9], [snap(9, 250)], '9 号必须拿 9 号的曲线');
  assert.deepEqual(byId[7], [snap(7, 100)], '7 号必须拿 7 号的曲线');

  /* 旧的位置写法：traders[0]=9 取 data[0] → 实际是 7 的 100 —— 正是缺陷。 */
  const misplaced = old.data[tradersNow.indexOf(9)];
  assert.equal(misplaced?.[0]?.equity, 100, '位置数组把 100（属于7）配给了 9 —— 这就是被修的 bug');
  /* 而 id 写法对同一个查询给出正确答案： */
  assert.equal(byId[9]?.[0]?.equity, 250, 'id 配对给出 9 号自己的 250');
});

test('★ 空输入得到空表；同一 id 重复以最后一个为准', () => {
  assert.deepEqual(pairEquityByTrader([]), {});
  const once = pairEquityByTrader([
    { id: 3, rows: [snap(3, 1)] },
    { id: 3, rows: [snap(3, 2)] },
  ]);
  assert.equal(once[3]?.[0]?.equity, 2, '重复 id 保留后到的（loader 每轮本就整表重建）');
});
