/**
 * **两个分析角色必须真的被调用**（2026-10-14 接线）
 *
 * ## 为什么单独钉这一条
 *
 * `performance_analyst`（绩效）与 `attribution_analyst`（归因）的 prompt
 * **早就写在 `roles.ts` 里**，`AgentRole` 类型里有它们，`ROLES` 表里有它们 ——
 * **唯独没有任何生产代码会去跑它们**：
 * ```
 *   实测：149 个生产文件（排除 .test.ts 与 roles.ts 定义处）里零调用
 *   它们只出现在 roles.ts 的定义与 loop.test.ts 的测试里
 * ```
 * 这与 `roles.ts:405` 记录过的 `engineer` 角色是**同一类缺口**：
 * ```
 *   typecheck 过 · 测试全绿 · 界面上也不报错 —— 只是它永远不会被调用
 * ```
 *
 * 而 `roles.test.ts` 的角色清单检查**会覆盖它们**（它们在 `ROLES` 里），
 * 所以"定义了但没人用"不会让任何既有测试变红。
 *
 * ## 设计意图其实早就写好了
 *
 * `orchestrator.ts` 自己的注释（那段讲"策略师永远走工具循环"的）写着：
 * > 「`single` 档只适用于**分析类**角色（绩效、归因）：那些角色确实只需要
 * >  读一遍数据给个结论。强度选择的真实含义是"要不要**额外**开并行分析"。」
 *
 * **意图存在，实现没做。** 本文件钉住"现在做了"。
 *
 * ## ⚠️ 必须串行（在策略师之后）
 *
 * 我第一版写成并行，测试当场抓到两个问题：
 * ```
 *   ① 策略师的 `set_params` 没被执行（脚本化模型按顺序返回，被分析角色抢走）
 *   ② 轨迹条数从 1 变 3
 * ```
 * ① 不只是测试问题 —— `LlmClient` 有**实例内状态**（`timeoutCount` 驱动思考等级
 * 降档、`streamDisabled`），三路并发共用同一实例时，分析角色的超时会**降低
 * 策略师的思考等级**。所以顺序必须是"策略师先、分析后"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../../testUtils/sourceText.js';

const SRC = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');
const CODE = codeOnly(SRC);
const E2E = readFileSync(new URL('./e2e.test.ts', import.meta.url), 'utf8');

/** 取出 `runPanelAnalysts` 的函数体。 */
function panelBody(): string {
  const at = CODE.indexOf('async function runPanelAnalysts');
  assert.ok(at > 0, '★ 应当能找到 runPanelAnalysts');
  return CODE.slice(at, at + 2500);
}

test('★★★ 两个分析角色必须被真的调用（不能只存在于 ROLES 表里）', () => {
  const body = panelBody();
  assert.ok(
    /'performance_analyst'/.test(body),
    '★ 必须调用绩效分析师 —— 用户需求⑤点名要「分析账户的」',
  );
  assert.ok(
    /'attribution_analyst'/.test(body),
    '★ 必须调用归因分析师',
  );
  assert.ok(
    /runSingleShot\(/.test(body),
    '★ 用单次调用（分析类角色不需要工具循环 —— 见 orchestrator 里那段注释）',
  );
});

test('★★★ 必须在 panel 档才跑（single 档不该白花两次调用）', () => {
  const at = CODE.indexOf('const analysts =');
  assert.ok(at > 0, '★ 应当能找到 analysts 的赋值');
  const line = CODE.slice(at, at + 200);
  assert.ok(
    /chosen\.intensity === 'panel'/.test(line),
    '★ 只在 panel 档跑 —— 强度选择的含义就是"要不要额外开并行分析"',
  );
});

test('★★★ 必须【串行】在策略师之后（并发会抢调用与实例状态）', () => {
  /*
   * ⚠️ 判据：`runToolLoop`（策略师）必须出现在 `runPanelAnalysts` 调用【之前】，
   * 且后者是 `await` 的。
   */
  const strategistAt = CODE.indexOf("role: 'strategist'");
  const analystsAt = CODE.indexOf('const analysts =');
  assert.ok(strategistAt > 0 && analystsAt > 0, '★ 两处都该在');
  assert.ok(
    strategistAt < analystsAt,
    '★ 策略师必须先跑 —— 并发会让分析角色抢走它的调用，并共用 LlmClient 的实例内状态',
  );
  assert.ok(
    /await runPanelAnalysts\(/.test(CODE),
    '★ 必须是 await（串行），不是"先启动后 await"',
  );
});

test('★★★ 分析角色也必须落轨迹（"跑过"必须留痕）', () => {
  /*
   * ⚠️ 没有这条，就回到"接了线但看不出它在跑"—— 而那与"没接线"在运维眼里一样。
   */
  assert.ok(
    /for \(const a of analysts\) \{[\s\S]{0,300}?ports\.recordRun\(/.test(CODE),
    '★ 每个分析角色各落一条轨迹',
  );
});

test('★★★ 分析失败不能拖垮策略师（各自独立 catch）', () => {
  const body = panelBody();
  assert.ok(
    /try \{[\s\S]{0,700}?catch \{/.test(body),
    '★ 必须各自 try/catch 并吞掉异常 —— "因为旁证没跑到就不调参"代价大得多',
  );
  assert.ok(
    /filter\(\(x\): x is/.test(body),
    '★ 失败的要从结果里剔除（而不是塞一个半成品进去）',
  );
});

test('★★ 返回类型必须带上 analysts（调用方要能落轨迹）', () => {
  assert.ok(
    /analysts: Array<\{ role: AgentRole; result: LoopResult \}>;/.test(CODE),
    '★ StrategyReviewOutcome 必须有 analysts 字段',
  );
  assert.ok(
    /analysts: \[\],/.test(CODE),
    '★ 没醒的分支要给空数组（调用方可以无脑遍历）',
  );
});

test('★★ 端到端测试必须钉住"有策略师那条"，而不是"总共只有一条"', () => {
  /*
   * ⚠️ 原判据是 `runs.length === 1` —— 加了 panel 旁证之后它已不成立。
   * 但**原意不能放松**："审视必须留痕"仍然被钉住，只是改成
   * "至少一条 + 其中必有策略师那条（带工具序列与 token）"。
   */
  assert.ok(
    /runs\.length >= 1/.test(E2E),
    '★ 至少一条轨迹',
  );
  assert.ok(
    /runs\.find\(\(r\) => \/get_performance\/\.test\(r\.agentsJson\)\)/.test(E2E),
    '★ 必须能找到策略师那条（靠它的工具调用序列识别）',
  );
});
