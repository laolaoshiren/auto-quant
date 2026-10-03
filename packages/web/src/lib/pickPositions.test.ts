import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickPositions } from './pickPositions';

/**
 * 钉住"实时优先、镜像兜底"这一条 —— 它是 2026-10-04 那起**幽灵持仓**事故的根因。
 *
 * 用户当时的话：
 *
 * > 「当前持仓这两笔，我都手动点了平仓（页面显示成功）但是我刷新页面后持仓又出现，
 * >  又点击平仓后提示"本地没有 DOGEUSDT 的持仓"」
 *
 * 那两笔早已真的平掉（交易所空仓），而行只存在于 WebSocket 镜像里 ——
 * 因为持仓表当时的取值顺序反过来，让**停止后永远不再更新**的镜像盖过了实时查询。
 */
test('★ 实时结果为空数组时，绝不能被过期的镜像盖过去', () => {
  /*
   * 这就是事故现场的精确形状：实时查询已经明确回答"没有持仓"（`[]`），
   * 而镜像里还留着停止那一刻的两行。
   *
   * 若这里返回了镜像的两行，用户就会看到"当前持仓 0"旁边摆着两行仓位。
   */
  const staleMirror = [{ symbol: 'DOGEUSDT' }, { symbol: 'SUIUSDT' }];
  assert.deepEqual(
    pickPositions([], staleMirror),
    [],
    '★ 空数组是"交易所确实没有持仓"这个【结论】，不能被还没过期的镜像覆盖',
  );
});

test('★ 实时结果还没到时（undefined）才用镜像 —— 那几百毫秒里它是唯一数据', () => {
  const mirror = [{ symbol: 'BTCUSDT' }];
  assert.deepEqual(
    pickPositions(undefined, mirror),
    mirror,
    'HTTP 还没回来时用镜像是对的：否则页面首屏会闪一下"空仓"',
  );
});

test('两边都没有就是空 —— 但这是"什么都没有"，不是"问过了没有"', () => {
  assert.deepEqual(pickPositions(undefined, undefined), []);
  assert.deepEqual(pickPositions([], undefined), []);
});

test('⚠️ 不许把它写成 `live || mirror` —— 那会把"空仓"这个结论丢掉', () => {
  /*
   * 这条是给下一个人看的：`||` 与 `??` 在这里**语义不同**，
   * 而写错的表现恰好是"幽灵持仓"回来。
   */
  assert.notDeepEqual(
    pickPositions([], [{ symbol: 'GHOSTUSDT' }]),
    [{ symbol: 'GHOSTUSDT' }],
    '`[]` 是 truthy，所以 `live ?? …` 与 `live || …` 在这一点上给出相反的结果',
  );
});
