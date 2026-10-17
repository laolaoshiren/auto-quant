/**
 * **候选链的"死 id"过滤器** —— 负向校准（2026-10-18）。
 *
 * ## 这个文件防的是什么
 *
 * `routedModel.ts` 的 T1/T2/T3 候选链是**手工维护的字符串数组**，文件开头自己写着：
 *
 * > 「链上的 id 会失效，而不会有任何测试因此变红」
 *
 * 实测就打脸了（线上网关 329 个模型）：
 * ```
 *   group/auto-space-bunny-free   → 查无此项（现名 group/auto-space-bunny）
 *   而 T1_LADDER / T2_LADDER 各挂着它 ⇒ 每轮决策先撞一次 404 才轮到下一个候选。
 * ```
 *
 * ## 它钉住的四条边界
 *
 * | # | 场景 | 期望 |
 * |---|---|---|
 * | ① | 清单里有 / 没有 | 没的丢掉，顺序保持 |
 * | ② | **拿不到清单**（`null` / 空数组） | **原样返回**（不筛） |
 * | ③ | **一个都不剩** | **原样返回**（不能把机器人打瘸） |
 * | ④ | 整张表过滤 | 只报告"真的有东西被丢"的角色 |
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAllLadders, resolveLadder } from './ladderResolve.js';

test('★★★ 网关里没有的 id 被丢掉，顺序不变', () => {
  const ladder = ['a/free', 'group/gone', 'b/free', 'group/also-gone'];
  const available = ['a/free', 'b/free', 'c/other'];
  const r = resolveLadder(ladder, available);
  assert.deepEqual(r.ladder, ['a/free', 'b/free'], '★ 保留的必须还是原顺序');
  assert.deepEqual(r.dropped, ['group/gone', 'group/also-gone']);
});

test('★★★ 拿不到清单 → 原样返回，一个都不筛', () => {
  const ladder = ['a/free', 'group/gone'];
  for (const nothing of [null, undefined, [] as string[]]) {
    const r = resolveLadder(ladder, nothing);
    assert.deepEqual(r.ladder, ladder, `★ 清单是 ${JSON.stringify(nothing)} ⇒ 必须原样返回`);
    assert.deepEqual(r.dropped, [], '★ 没清单就不该报告"丢了什么"');
  }
});

test('★★★ 一个都不剩 → 原样返回（宁可撞 404，也不能没有候选）', () => {
  /*
   * 这个场景是真实存在的：`/v1/models` 只返回了第一页（magpie 的响应里有 `has_more`），
   * 或者组名整体改掉了。此时全筛掉会让机器人**完全没有候选模型** ——
   * 那比"撞几次 404"严重得多。
   */
  const ladder = ['group/old-a', 'group/old-b'];
  const r = resolveLadder(ladder, ['completely/different']);
  assert.deepEqual(
    r.ladder,
    ladder,
    '★ 全都不在时必须原样返回 —— 让团队没有候选比慢一点糟得多',
  );
  assert.deepEqual(r.dropped, [], '一个都没留 ⇒ 不报告 dropped（否则日志会误导成"筛过了"）');
});

test('★★ 全部存在 → 原样返回，dropped 为空', () => {
  const ladder = ['a', 'b', 'c'];
  const r = resolveLadder(ladder, ['a', 'b', 'c', 'd']);
  assert.deepEqual(r.ladder, ladder);
  assert.deepEqual(r.dropped, []);
});

test('★★ 整张表过滤：只为真的有东西被丢的角色报告', () => {
  const ladders = {
    market_analyst: ['a/free', 'group/gone'],
    judge: ['b/ok'],
    grunt: ['c/ok', 'd/ok'],
  } as const;
  const r = resolveAllLadders(ladders, ['a/free', 'b/ok', 'c/ok', 'd/ok']);
  assert.deepEqual(r.ladders.market_analyst, ['a/free']);
  assert.deepEqual(r.ladders.judge, ['b/ok']);
  assert.deepEqual(r.ladders.grunt, ['c/ok', 'd/ok']);
  assert.equal(r.droppedByRole.length, 1, '★ 只有 market_analyst 有东西被丢');
  assert.equal(r.droppedByRole[0]!.role, 'market_analyst');
  assert.deepEqual(r.droppedByRole[0]!.dropped, ['group/gone']);
});

test('★★ 真实案例回归：group/auto-space-bunny-free 已改名为不带 -free 的', () => {
  /*
   * 线上网关实测（2026-10-18，329 个模型）：
   * ```
   *   含 space-bunny 的只有：group/auto-space-bunny / opencode-go/space-bunny
   *                          / workbuddy/space-bunny / opencode-zen-free/space-bunny-free
   *   `group/auto-space-bunny-free` 查无此项。
   * ```
   * 这条钉住"过滤器确实能发现它"，**也钉住我们不该靠人工记住这件事**。
   */
  const oldLadder = ['opencode-zen-free/space-bunny-free', 'group/auto-space-bunny-free', 'group/team-grunt'];
  const realLine = ['group/auto-space-bunny', 'opencode-zen-free/space-bunny-free', 'group/team-grunt'];
  const r = resolveLadder(oldLadder, realLine);
  assert.deepEqual(r.dropped, ['group/auto-space-bunny-free'], '★ 这个 id 就是线上失效的那个');
  assert.deepEqual(r.ladder, ['opencode-zen-free/space-bunny-free', 'group/team-grunt']);
});
