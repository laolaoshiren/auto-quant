/**
 * **被 `pickKnown` 丢弃的字段必须如实回喂**（外部 issue #152）。
 *
 * ## 缺陷形状
 *
 * `patch.ts:198-215` 的 `pickKnown` 按 `key in target` 过滤 —— 不在配置里的键
 * **静默丢弃**。而 `AgentPatchResult` 只有 `clamps`（结构性守卫改动）与
 * `rejected`（整体拒绝），**没有"哪些字段被丢了"这个通道**。
 *
 * 于是 `tools.ts:612` 的 `applied: patch.rejected === null` 在**全部字段都被丢弃**时
 * 仍然报 `applied: true`：
 *
 * ```
 * patch={"完全不存在":1}                    → applied=true, rejected=null, clamps=[]
 * patch={"riskControl":{"不存在的字段":999}} → applied=true, rejected=null, clamps=[]
 * ```
 *
 * 而模型看到的回执是 `{"applied":true, "note":"补丁已生效。"}` —— **一个字段都没变**。
 *
 * ## 为什么这条值得单独修（而不是"模型写错字段名，活该"）
 *
 * `patch.ts:322-323` 的注释**自己就定义过这是最坏的一类失败**：
 *
 * > **它正确地诊断出了死锁、给出了正确的修复、然后那个修复被静默丢掉。**
 * > 这是最坏的一类失败：**它告诉模型成功了。**
 *
 * 那段注释是为"点号键"那次修复写的 —— 而"全部字段被 `pickKnown` 丢弃仍报成功"
 * 是**同一类失败的另一个入口**，原样留着。
 *
 * 后果是**间接涉及钱**：模型以为风控参数改了而实际没改，它会基于错误前提继续推理
 *（`#79` 实测过的形态）。它不会重试、也不会换个说法再试 —— 因为它以为自己成功了。
 *
 * ## ⚠️ 不改变"不整体拒绝"这个既有行为
 *
 * `dottedPatch.test.ts:83-84` **有意**断言 `{'完全不存在的段.x':1}` 不整体拒绝 ——
 * 那个行为是**对的**（一个坏键不该作废整条补丁，这是本文件反复强调的原则）。
 * 所以缺的不是"拒绝"，而是**如实回喂被丢了哪些字段** —— 与 `clamps` 同一套机制。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultStrategyConfig } from '@aq/shared';
import { applyAgentPatch } from './patch.js';

test('★★★ 全部字段都不存在时必须报出它们 —— 不能只说"补丁已生效"', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { 完全不存在: 1, 另一个也不存在: 2 });

  assert.equal(r.rejected, null, '★ 仍然不该整体拒绝（既有行为，见 dottedPatch.test.ts）');
  assert.deepEqual(
    [...r.dropped].sort(),
    ['另一个也不存在', '完全不存在'].sort(),
    '★★★ 被丢弃的字段必须逐个报出来 —— 否则模型以为补丁生效了，' +
      '而配置一个字段都没变（`patch.ts:322` 自己称这是"最坏的一类失败"）',
  );
});

test('★★★ 嵌套里的未知字段也要报出来', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { riskControl: { 不存在的字段: 999 } });

  assert.equal(r.rejected, null);
  assert.deepEqual(r.dropped, ['riskControl.不存在的字段'], '★★★ 嵌套的未知字段也要能被指出');
});

test('★★ 已知字段生效时，dropped 只列被丢的那些（混合情形）', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, {
    riskControl: { maxPositions: 7, 不存在的字段: 999 },
  });

  assert.equal(r.config.riskControl.maxPositions, 7, '★ 好的字段要生效');
  assert.deepEqual(r.dropped, ['riskControl.不存在的字段'], '★ 只列被丢的那个');
});

test('★★ 没有字段被丢时 dropped 是空数组 —— 不能误报', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { riskControl: { maxPositions: 9 } });

  assert.deepEqual(r.dropped, [], '★★ 没有丢弃就不能报丢弃 —— 否则模型会以为改动没生效');
  assert.equal(r.rejected, null);
});

test('★★ 整条被拒时 dropped 为空（rejected 已经说明了全部）', () => {
  const current = defaultStrategyConfig();
  /* 用一个类型不对的值触发 zod 失败。 */
  const r = applyAgentPatch(current, { riskControl: { maxPositions: '不是数字' } });

  assert.ok(r.rejected !== null, '★ 类型不对应当整体拒绝');
  assert.deepEqual(r.dropped, [], '★ 整体拒绝时不必再列丢弃项（rejected 已说明）');
});

test('★ 点号写法里被丢弃的键也按展开后的路径报告', () => {
  /*
   * `expandDottedKeys` 发生在 `pickKnown` 之前，所以报告应当是**展开后**的路径 ——
   * 否则模型看到 `riskControl.不存在` 却不知道它被展开成了什么。
   */
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { 'riskControl.不存在的字段': 999 });

  assert.equal(r.rejected, null);
  assert.deepEqual(r.dropped, ['riskControl.不存在的字段']);
});
