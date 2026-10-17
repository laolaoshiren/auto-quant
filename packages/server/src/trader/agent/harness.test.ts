import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { codeOnly } from '../../testUtils/sourceText.js';
import {
  describeTermination,
  harnessFailureHints,
  runAgentTask,
  type AgentTaskInput,
  type AgentTaskResult,
  type SpawnAgent,
} from './harness.js';

/*
 * ⚠️ 这些测试**不真的起 harness 进程**。
 *
 * 两个理由：
 * ① 本机沙箱下 `spawn` + `stdio: 'pipe'` 会 EPERM（见工具说明），
 *    而生产（服务器）没有这个限制 —— 所以"能不能起进程"由服务器实测覆盖，
 *    这里覆盖的是**任务编排与错误语义**；
 * ② 真实 harness 的调用成本与耗时不该进单元测试。
 */

const fake = (r: Partial<AgentTaskResult>, seen?: AgentTaskInput[]): SpawnAgent =>
  async (input) => {
    seen?.push(input);
    return { ok: true, text: '（假产出）', latencyMs: 1, ...r };
  };

test('★ 把任务原样交给 agent（含工具白名单与模型档）', async () => {
  const seen: AgentTaskInput[] = [];
  const out = await runAgentTask(
    {
      task: '查今天 BTC 的三条新闻',
      allowedTools: 'WebSearch,WebFetch',
      model: 'group/team-news',
      fastModel: 'group/team-grunt',
      workdir: '/tmp/x',
      authToken: 'k',
    },
    fake({ ok: true, text: '三条新闻…' }, seen),
  );
  assert.equal(out.ok, true);
  assert.equal(out.text, '三条新闻…');
  assert.equal(seen[0]!.task, '查今天 BTC 的三条新闻');
  assert.equal(seen[0]!.model, 'group/team-news', '★ 该用哪档模型要传下去');
  assert.equal(seen[0]!.allowedTools, 'WebSearch,WebFetch');
});

test('★★★ 任务为空 → 明确失败，不是"静默没干活"', async () => {
  /*
   * 这条防的是"派活的人忘了写任务"。
   *
   * 若不拦，现象会是：agent 起来了、跑了、产出空字符串 ——
   * 而调用方看到的是"这个研究员这轮没产出"，
   * **真正的原因（任务没写）被掩盖**。
   */
  const out = await runAgentTask(
    { task: '   ', workdir: '/tmp/x', authToken: 'k' },
    fake({ ok: true, text: '不该被调用' }),
  );
  assert.equal(out.ok, false);
  assert.ok(out.error?.includes('任务为空'), `错误要说清楚（实际：${out.error ?? ''}）`);
});

test('★★★ 没装 harness 时错误信息要指向"环境没装好"（不能像"这个角色没产出"）', async () => {
  /*
   * 实测过这个坑的形状：一个角色失败，日志只说"失败：…"，
   * 而真相是**服务器上根本没装 harness** —— 排查会走很远。
   *
   * 所以这条断言：错误里必须出现可执行的线索。
   */
  const out = await runAgentTask(
    { task: '查新闻', workdir: '/tmp/x', authToken: 'k' },
    fake({ ok: false, text: '', error: '起不了 harness（/opt/…/claude）：spawn ENOENT —— 需要先安装' }),
  );
  assert.equal(out.ok, false);
  assert.ok(out.error?.includes('harness'), '错误要提到 harness');
  assert.ok(out.error?.includes('安装'), '错误要给出下一步（安装）');
});

test('★ agent 超时 → 标记失败并带上耗时（编排据此决定要不要继续）', async () => {
  const out = await runAgentTask(
    { task: '查新闻', workdir: '/tmp/x', authToken: 'k' },
    fake({ ok: false, text: '', error: 'agent 超过 300 秒未返回', latencyMs: 300_000 }),
  );
  assert.equal(out.ok, false);
  assert.equal(out.latencyMs, 300_000, '耗时必须回传 —— 它是判断"这个角色是不是坏模型"的依据');
});

/* -------------------------------------------------------------------------- */
/*  143 / SIGTERM 与"看起来像故障、其实不是"的两条（2026-10-17 实测加的）          */
/* -------------------------------------------------------------------------- */

test('★★★ 退出码 143 必须说成"被外部 SIGTERM 终止"，而不是让操作员去查猎手', () => {
  /*
   * ## 线上原文（`runtime_logs`，2026-10-17）
   *
   * ```
   *   [调研] 社区猎手 未产出：harness 退出码 143 · [claude-code:unrecognized_model] …
   * ```
   *
   * ## 143 的真相（实测）
   *
   * `143 = 128 + 15 = SIGTERM`。实测那一刻 systemd 正在停服务：
   * ```
   *   journal：10:06:57 Stopping autoquant.service …（部署重启）
   *   KillMode=control-group、KillSignal=15
   * ```
   * 于是 **SIGTERM 发给了整个 cgroup**，猎手（claude 子进程）被一起带走。
   * **它和猎手本身没有任何关系** —— 而"退出码 143"这句话会把人引向相反的方向。
   *
   * ⚠️ 我们自己的两条终止路径（超时、AbortSignal）用 `SIGKILL` 并先 `finish()`，
   * 所以它们走不到这一支 —— 这一支**只可能是外部信号**。
   */
  const byCode = describeTermination(143, null);
  assert.ok(byCode !== null, '★ 143 必须有专门的说明，不能落回通用分支');
  assert.match(byCode!, /SIGTERM/, '★ 要说清是 SIGTERM（而不是"配置错误"）');
  assert.match(byCode!, /systemd|外部|停机|重启/, '★ 要指出信号来自平台停机/重启');
  assert.match(byCode!, /不是猎手自身/, '★ 要明确排除"猎手自己坏了"这个误判方向');

  /* Node 把"被信号杀死"报成 signal 而非 code —— 两条路都要认。 */
  const bySignal = describeTermination(null, 'SIGTERM');
  assert.equal(bySignal, byCode, '★ `signal=SIGTERM` 与 `code=143` 必须给同一句话');
});

test('★★ SIGKILL(137) 也要认出来（平台停机时 systemd 的最后手段）', () => {
  const hint = describeTermination(137, null);
  assert.ok(hint !== null);
  assert.match(hint!, /SIGKILL/);
  assert.equal(describeTermination(null, 'SIGKILL'), hint);
});

test('★★★ 普通退出码必须返回 null —— 不许把 143 那一支的措辞套到所有失败上', () => {
  /*
   * 这条是**反向守卫**：如果 `describeTermination` 对任意非 0 码都返回一句话，
   * 那么"轮数用尽""模型报错"这些**应该被如实报出来**的失败都会被改写成
   * "被外部终止" —— 那是用一个新谎言盖住一堆真实故障。
   */
  for (const code of [1, 2, 127, 130, 142, 144]) {
    assert.equal(
      describeTermination(code, null),
      null,
      `★ 退出码 ${code} 不该被说成"被信号终止"`,
    );
  }
  assert.equal(describeTermination(0, null), null, '★ 正常退出更不该走这一支');
});

test('★★ "auto mode 分类器不可达"与"unrecognized_model"要被点破（两条都会骗人）', () => {
  /*
   * 两条都是 2026-10-17 实测确认的，且**字面意思都在骗人**：
   *
   * ① `auto mode cannot determine the safety of Bash right now` ——
   *    Claude Code 的 auto mode 用**分类器**判工具安全性，而网关不提供那个模型
   *    （实测该模型名返回 **401**）。这是**间歇性**的，表现为"工具调用被拒"。
   * ② `[claude-code:unrecognized_model]` —— **只是遥测信号**。实测同一个模型名
   *    直接调网关返回 **200** 且会话记录里有真实 token 用量 ⇒ 模型名能用。
   *    排查时正是它被当成了根因。
   */
  const autoMode = harnessFailureHints(
    'claude-sonnet-5 is temporarily unavailable, so auto mode cannot determine the safety of Bash right now.',
  );
  assert.match(autoMode, /分类器/, '★ 要点明是 auto mode 的分类器');
  assert.match(autoMode, /不可达|不提供/, '★ 要说清原因在网关侧（模型不存在）');

  const unrecognized = harnessFailureHints(
    '[claude-code:unrecognized_model] {"model":"group/team-news","query_source":"sdk"}',
  );
  assert.match(unrecognized, /遥测/, '★ 要说明它只是遥测信号');
  assert.match(unrecognized, /不代表模型名不可用/, '★ 要明确否定"模型名不可用"这个误判');

  /* ⚠️ 无关文本不许被贴提示 —— 否则日志里全是噪音，等于没有提示。 */
  assert.equal(
    harnessFailureHints('Error: Reached max turns (24)'),
    '',
    '★ 与这两件事无关的失败不该被贴提示（噪音会让提示失效）',
  );
  assert.equal(harnessFailureHints(''), '', '★ 空 stderr 不许产出"提示："这种空壳');
});

test('★★★ 被杀的那一轮必须仍然判失败（`--print` 的产出不许因此变成"成功"）', () => {
  /*
   * ## 这条防的是什么
   *
   * 给 143 加说明时最容易犯的错：顺手把它当成"环境问题、不算失败"。
   * 那会让**被中断的一轮**被下游当成一份产出（`mergeHunterReports` 数 `r.ok`），
   * 于是界面上写"4/4 个猎手有产出"而内容是空的 —— 本仓库为这个形状付过代价
   * （见 `harness.ts` 里 `text.length > 0` 那一段事故）。
   *
   * ⚠️ **判据不能恒真**：这里从源码里**取出那一支**（`const killed = …` 到下一个
   * `if (hitMaxTurns)`），再断言它内部是 `ok: false`。把 `ok` 改成 `true` 就变红。
   * 末尾的探针证明这个抽取/断言套路确实能报出来。
   */
  const src = codeOnly(
    readFileSync(new URL('./harness.ts', import.meta.url), 'utf8'),
  );
  /* 前置断言：源码真的被读到了（否则下面的"找不到"会静默变成"没问题"）。 */
  assert.ok(src.includes('describeTermination'), '★ 源码里应有 describeTermination');

  const start = src.indexOf('const killed = describeTermination(code, signal);');
  assert.notEqual(start, -1, '★ 找不到被杀那一支 —— 判据失效了（它可能被删了）');
  const end = src.indexOf('if (hitMaxTurns) {', start);
  assert.notEqual(end, -1, '★ 找不到被杀那一支的结尾');
  const branch = src.slice(start, end);
  assert.match(
    branch,
    /ok: false/,
    '★★★ 被杀的一轮必须 `ok: false` —— 否则被中断的轮次会被当成产出',
  );
  assert.ok(
    !/ok: true/.test(branch),
    '★★★ 被杀那一支里不许出现 `ok: true`',
  );

  /* ★ 探针：把 `ok: false` 换成 `ok: true` 的样本必须被判违规。 */
  const probe = branch.replace('ok: false', 'ok: true');
  assert.ok(
    /ok: true/.test(probe) && !/ok: false/.test(probe),
    '★ 探针：变异样本必须落到"违规"那一侧（否则上面的断言是瞎的）',
  );
});
