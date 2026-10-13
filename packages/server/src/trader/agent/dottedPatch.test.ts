/**
 * **点号路径的补丁不能被静默丢弃**（2026-10-13）。
 *
 * ## 为什么单独一条测试
 *
 * 这是一个**"它告诉模型成功了"**的失败 —— 最坏的一类：
 * ```
 *   patch_json:   {"riskControl.minPositionSize": 5}
 *   applied_json: minPositionSize = **12**      ← 没改
 *   clamps_json:  []                            ← 也没说"被拒绝"
 * ```
 * 而 `set_params` 的工具文档**推荐的就是点号写法**（原文）：
 * ```
 *   Adjustable: coin selection (coinSource.*), indicators (indicators.*),
 *               how much you risk (riskControl.*, throttle.*, circuitBreaker.*)
 * ```
 * 于是模型改参数 → 看到"补丁已生效" → 下一轮读到**旧值** → 再改一次 → 反复空转。
 *
 * ## 实测现场（`#11` 的策略师，实验 `#79`）
 *
 * 它**正确地诊断出了死锁**（那是本轮最亮眼的一次模型表现）：
 * ```
 *   reason: "DEADLOCK CONFIRMED: minPositionSize(12) > max achievable
 *            notional(equity 20.75 × positionValueRatio 50% = 10.375).
 *            No position can ever be opened — the minimum size exceeds the maximum."
 * ```
 * 而**那个修复被静默丢掉了**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAgentPatch } from './patch.js';
import { defaultStrategyConfig } from '@aq/shared';

test('★★★ 点号路径必须能改到嵌套字段（这是工具文档推荐的写法）', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { 'riskControl.minPositionSize': 5 });
  assert.equal(
    r.config.riskControl.minPositionSize,
    5,
    '★ `{"riskControl.minPositionSize": 5}` 必须真的改到它（而不是被静默丢弃）',
  );
  assert.equal(r.rejected, null, '★ 不该整体拒绝');
});

test('★★★ 嵌套写法仍然有效（旧行为逐字节不变）', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { riskControl: { minPositionSize: 5 } });
  assert.equal(r.config.riskControl.minPositionSize, 5);
});

test('★★★ 两种写法混用时都要生效（合并，不互相覆盖）', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, {
    'riskControl.minPositionSize': 5,
    riskControl: { maxPositions: 7 },
  });
  assert.equal(r.config.riskControl.minPositionSize, 5, '★ 点号那个要生效');
  assert.equal(r.config.riskControl.maxPositions, 7, '★ 嵌套那个也要生效');
});

test('★★★ 多层的点号路径也要能写（`promptSections.entryStandards`）', () => {
  /*
   * ⚠️ 这是最常用的一类：策略师改写自己的规则文本。
   * 若它也只支持一层，模型"改自己的规则"会静默失败。
   */
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { 'promptSections.entryStandards': '新规则' });
  assert.equal(r.config.promptSections.entryStandards, '新规则');
});

test('★★★ 未知字段仍然被丢弃（展开不放宽安全性）', () => {
  /*
   * ⚠️ 这是**安全边界**：展开只解决"写法"，不该让模型往配置里塞东西。
   */
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { 'riskControl.不存在的字段': 999 });
  assert.equal(
    '不存在的字段' in (r.config.riskControl as Record<string, unknown>),
    false,
    '★ 未知字段必须仍被丢弃',
  );
  const r2 = applyAgentPatch(current, { '完全不存在的段.x': 1 });
  assert.equal(r2.rejected, null, '★ 但也不该整体拒绝（一个坏键不该让整条作废）');
});

test('★ 坏输入（空段）被跳过，而不是整条拒绝', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, { 'riskControl..minPositionSize': 5, 'riskControl.maxPositions': 9 });
  assert.equal(r.rejected, null, '★ 不该整条拒绝');
  assert.equal(r.config.riskControl.maxPositions, 9, '★ 好的那个键仍要生效');
});

/*
 * ★★ **原型污染（2026-10-14 外部审查，实测复现后修复）**
 *
 * `patch` 来自不可信的模型输出（`set_params` 的 `validateArgs` 只验"是个对象"，
 * 键名不过滤），而旧版 `expandDottedKeys` 用 `node[part]` 遍历、
 * `node['__proto__']` 返回 `Object.prototype`（typeof 是 'object'，通过类型守卫），
 * 于是 `{"riskControl.__proto__.isAdmin": 1}` 把 `isAdmin` 写上**全局原型**：
 *
 * ```
 *   before: ({}).isAdmin = undefined
 *   after : ({}).isAdmin = 1     ← 进程里每个普通对象都继承了它
 * ```
 *
 * 真正致命的不是那个怪键本身，而是它**反噬本文件的守卫**：`pickKnown` 的
 * "只留已知字段"用 `key in target`，而 `in` 看得见原型链 —— 一个名字一旦上了
 * `Object.prototype`，未知字段过滤与结构性不变量双双放行，全进程任何
 * `x in obj` 都被改变。实测：污染后 `'isAdmin' in {} === true`。
 *
 * 这个用例在修复前会**永久污染测试进程的原型**（node:test 同进程跑多个文件，
 * 危害会外溢到别的测试文件），修复后三类入口全部无效。
 */
test('★★★ 点号路径里的 __proto__ / constructor / prototype 段不得触到全局原型', () => {
  const current = defaultStrategyConfig();

  const probes: Array<[string, unknown]> = [
    ['riskControl.__proto__.pollutedA', 'X'],
    ['__proto__.pollutedB', 'X'],
    ['a.__proto__.pollutedC', 'X'],
    ['riskControl.constructor.prototype.pollutedD', 'X'],
    ['riskControl.prototype.pollutedE', 'X'],
  ];
  for (const [path, value] of probes) {
    applyAgentPatch(current, { [path]: value });
  }

  /* 决定性断言：全局原型上不允许出现任何一个探针键。 */
  for (const [, , key] of [
    ['riskControl.__proto__.pollutedA', 'X', 'pollutedA'],
    ['__proto__.pollutedB', 'X', 'pollutedB'],
    ['a.__proto__.pollutedC', 'X', 'pollutedC'],
    ['riskControl.constructor.prototype.pollutedD', 'X', 'pollutedD'],
    ['riskControl.prototype.pollutedE', 'X', 'pollutedE'],
  ] as Array<[string, string, string]>) {
    assert.equal(
      (Object.prototype as unknown as Record<string, unknown>)[key],
      undefined,
      `Object.prototype.${key} 被污染了`,
    );
    assert.equal(key in {}, false, `'${key}' in {} 必须为 false（否则 pickKnown 的过滤被废）`);
  }

  /* 补丁本身要变成"无生效字段"而不是崩溃或生效。 */
  const r = applyAgentPatch(current, { 'riskControl.__proto__.isAdmin': 1 });
  assert.ok(
    r.rejected === null || typeof r.rejected === 'string',
    '坏键按"跳过这个键"处理：整条补丁其余部分照常（坏输入不作废全补丁的既有原则）',
  );
});

test('★ 危险段只废自己那个键，不作废同批的合法键', () => {
  const current = defaultStrategyConfig();
  const r = applyAgentPatch(current, {
    'riskControl.__proto__.isAdmin': 1,
    'riskControl.minPositionSize': current.riskControl.minPositionSize, // 合法键同批到达
  });
  assert.equal(r.rejected, null, '一个坏键不该让整条补丁被拒');
  assert.equal('isAdmin' in {}, false, '且污染没有发生');
});
