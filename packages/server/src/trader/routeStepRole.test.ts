/**
 * **路由步骤的 role 必须是"真正发起调用的那个角色"**（t80）。
 *
 * ## 这个测试防的是什么（一次真实的误报）
 *
 * `createTeamDecisionModel` 会把 agent 层（策略师/绩效分析师/归因分析师/复盘员）的调用
 * **转给单模型**，并为此记一条 `onStep`。那条步骤原来硬编码 `role: 'supervisor'` ——
 * 而这条路径**与总管毫无关系**。
 *
 * 界面侧按 role 把步骤归并成编制表的一行（`TeamBoard/roster.ts` 的 `rosterEntries`、
 * `TeamRoster.tsx` 的 `groupByRole`），于是：
 * ```
 *   ① 策略师每一次工具循环调用 → 界面把这一步算进「总管」那一格；
 *   ② 消息里出现「失败/超时/不可用」→ 总管那一格被标成【失败】
 *      （两处判据都是"按措辞判失败"）
 * ```
 * 操作员看到「总管 失败」，会去查一个**不存在**的问题。
 *
 * ## 判据为什么必须走**真实** `runToolLoop` / `runSingleShot`
 *
 * 只写一份"像 system 提示词"的字符串是**自证**：它证明不了
 * "真实循环拼出来的那份 system 能被认出来"。所以这里让真实的循环跑一步，
 * **从它交给模型的 system 里取样**，再把同一份 system 交给团队模型。
 *
 * ## 负向校准（两条，缺一不可）
 *
 * ```
 *   ① 策略师的工具循环 → 这一步【不再】归到 supervisor 名下；
 *   ② 真正的总管失败   → 它【仍然】归到 supervisor（防修成"什么都不标"）
 * ```
 * 第 ② 条用的是 `tradingDesk` 自己写的失败文案 —— 它是"总管"这一格的唯一来源。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelRouter, type CallModel } from '../llm/modelRouter.js';
import { createTeamDecisionModel } from './routedModel.js';
import { runSingleShot, runToolLoop, type LoopModel } from './agent/loop.js';

interface Step {
  role: string;
  phase: string;
  note: string;
}

/**
 * 让真实的 `runToolLoop` 跑一步，并**把它拼给模型的那份 system 原样收下来**。
 *
 * ⚠️ 用真实的循环而不是手写字符串：手写的字符串能通过测试，而真实的那份不一定 ——
 * 那正是这个 BUG 曾经存在的原因（没人核对过真实路径）。
 */
async function strategistSystemViaRealLoop(): Promise<string> {
  let captured: string | null = null;
  const model: LoopModel = {
    complete: async (system) => {
      captured = system;
      return {
        text: '{"thought":"够了","tool":"finish","args":{"summary":"结论"}}',
        usage: { promptTokens: 1, completionTokens: 1 },
        latencyMs: 1,
      };
    },
  };
  await runToolLoop({
    role: 'strategist',
    task: '审视参数',
    facts: '绩效：净 +0.31',
    deps: {} as never,
    model,
    maxSteps: 1,
  });
  assert.ok(captured !== null, '★ 没取到 system —— 判据本身失效了，先修这个');
  return captured;
}

/** 同上，但走**单次结论档**（复盘员）—— 它拼的是另一个标记，两条路径都要被认出来。 */
async function reviewerSystemViaRealSingleShot(): Promise<string> {
  let captured: string | null = null;
  const model: LoopModel = {
    complete: async (system) => {
      captured = system;
      return {
        text: '{"summary":"复盘结论"}',
        usage: { promptTokens: 1, completionTokens: 1 },
        latencyMs: 1,
      };
    },
  };
  await runSingleShot({
    role: 'reviewer',
    task: '复盘这一笔',
    facts: '成交：净 +0.31',
    deps: {} as never,
    model,
  });
  assert.ok(captured !== null, '★ 没取到 system —— 判据本身失效了，先修这个');
  return captured;
}

/** 一个"任何角色都给合法产出"的桩（只在需要真跑交易台时用）。 */
function okCall(): CallModel {
  return async (_modelId, messages) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    if (system.includes('「judge」')) {
      return { text: '结论：不行动。\n[]', latencyMs: 5, usage: { promptTokens: 10, completionTokens: 5 } };
    }
    return { text: '产出。', latencyMs: 5, usage: { promptTokens: 10, completionTokens: 5 } };
  };
}

test('★★★ 策略师的工具循环调用，不再被记成「总管」的步骤', async () => {
  const steps: Step[] = [];
  const model = createTeamDecisionModel({
    router: new ModelRouter({ call: okCall() }),
    baseMaxTokens: 4096,
    onStep: (s) => steps.push(s),
  });

  await model.complete(await strategistSystemViaRealLoop(), '## 你的任务\n审视参数');

  const route = steps.filter((s) => s.phase === 'route');
  assert.equal(route.length, 1, '★ 必须有且只有一条路由步骤（它是"转给单模型"的可见性）');
  assert.notEqual(
    route[0]!.role,
    'supervisor',
    '★★★ 路由步骤不能挂在总管名下 —— 它不是总管干的活（t80 的这个 BUG 让界面误报「总管 失败」）',
  );
  assert.equal(
    route[0]!.role,
    'strategist',
    '★★★ 它必须归到**真正发起调用的角色**名下（这一步来自 `role: \'strategist\'` 的工具循环）',
  );
});

test('★★★ 复盘员的单次结论档，也归到复盘员名下', async () => {
  const steps: Step[] = [];
  const model = createTeamDecisionModel({
    router: new ModelRouter({ call: okCall() }),
    baseMaxTokens: 4096,
    onStep: (s) => steps.push(s),
  });

  await model.complete(await reviewerSystemViaRealSingleShot(), '## 你的任务\n复盘');

  const route = steps.filter((s) => s.phase === 'route');
  assert.equal(route.length, 1, '★ `runSingleShot` 也必须被认出来（否则它会跑整个交易台）');
  assert.equal(
    route[0]!.role,
    'reviewer',
    '★★★ 单次结论档的归属也必须是真实角色（它是 agent 层的标记，不是交易台的角色）',
  );
});

test('★ 认不出角色时退到在册岗位，而不是随便一个交易岗位', async () => {
  /*
   * 判据是 `FIRM_ROLES` 里**真实存在**的 id：界面侧对不在册的 role 会追加一行
   * 英文 id 的行（`TeamBoard/roster.ts:330-353`），而"不要有英文"是用户对界面的硬要求。
   *
   * 构造方式：给一个**带 agent 层标记、但不含任何角色提示词**的 system ——
   * 那正是"将来新增一个 agent 角色、而 `ROLES` 还没登记它"的形状。
   */
  const steps: Step[] = [];
  const model = createTeamDecisionModel({
    router: new ModelRouter({ call: okCall() }),
    baseMaxTokens: 4096,
    onStep: (s) => steps.push(s),
  });

  const { AGENT_CALL_MARKER } = await import('./agent/loop.js');
  await model.complete(`一个还没登记进 ROLES 的新角色。\n\n${AGENT_CALL_MARKER}`, '材料');

  const route = steps.filter((s) => s.phase === 'route');
  assert.equal(route.length, 1);
  assert.equal(
    route[0]!.role,
    'system_engineer',
    '★ 兜底必须是"在册"的岗位（否则界面上会多出一行英文 id）',
  );
  assert.match(route[0]!.note, /认不出具体角色/, '★ 兜底时要如实说明"认不出"，不能装作认得');
});

test('★★★ 负向校准：真正的总管失败，仍然记在总管名下', async () => {
  /*
   * ## 为什么必须有这一条
   *
   * 上面三条都只说"不要把别人的活算给总管"。若有人把那个 `onStep` 直接删掉
   * 或改成一个不存在的 role，上面三条**依然全绿** —— 而"总管失败了"这件事
   * 就再也不会出现在界面上。那正是这次修复最容易走偏的方向。
   *
   * ## 判据从哪来
   *
   * 真总管的步骤由 `tradingDesk` 的派发阶段写：`role: 'supervisor'`、`phase: 'dispatch'`，
   * 失败/限流时文案含「失败」「不派」「退回全派」这类措辞
   * （界面就是按这些措辞判它失败/完成的）。
   */
  const steps: Step[] = [];
  const failingCall: CallModel = async () => {
    throw new Error('网关 502');
  };
  const model = createTeamDecisionModel({
    router: new ModelRouter({ call: failingCall }),
    baseMaxTokens: 4096,
    onStep: (s) => steps.push(s),
  });

  /* ⚠️ 这条路径上 `complete()` 可能因为上游在飞的改动而抛错 —— 不影响本测试的取证。 */
  await model.complete('你是交易员。', '材料').catch(() => undefined);

  const supervisorSteps = steps.filter((s) => s.role === 'supervisor');
  assert.ok(
    supervisorSteps.length > 0,
    '★★★ 总管这一格必须仍然有步骤 —— 否则"总管失败了"在界面上永远看不到',
  );
  assert.ok(
    supervisorSteps.some((s) => s.phase === 'dispatch'),
    '★ 总管的步骤在派发阶段（`tradingDesk` 写的就是这个 phase）',
  );
  assert.ok(
    supervisorSteps.some((s) => /失败|不派|退回全派|调用预算不足/.test(s.note)),
    '★ 总管失败/降级的措辞必须留在它自己名下（界面按措辞判失败）',
  );
});
