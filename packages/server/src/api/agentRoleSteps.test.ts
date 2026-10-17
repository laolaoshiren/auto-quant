/**
 * **团队岗位出勤的解析与合并**（2026-10-17 · t111）。
 *
 * ## 这些测试防的那个真实投诉
 *
 * 用户原话：
 * > 「我观察到**很多岗位，似乎从未真正运行过**，页面上也没有显示他们**最新运行时间**」
 *
 * 而线上实测 `supervisor` 在 `team` 域出现 **31 次**（全系统最多）——
 * 也就是说**角色一直在跑，是界面读错了数据源**。
 *
 * 具体机制：看板原来只从 `decision_records.cot_trace` 抽时刻，而那里
 * **只有进了 `<team>` 块的角色**（分析师 / bull / bear / judge）。
 * `supervisor` / `risk_officer` / `reporter` 的出勤写在 `runtime_logs`
 * （`scope='team'`，格式 `[phase] role：note`）—— 那张表从来没人读。
 *
 * ## 为什么这些是纯函数
 *
 * `buildServer()` 要真实交易所连接 / 金库 / 模型客户端才能装配（见
 * `traderStatsNotFound.test.ts` 的注释：为了两行检查搭一整套桩不值得）。
 * 所以把"判据"抽成纯函数放在模块级，**用真实数据形状测它们**，
 * 而不是断言"源码里出现了某个字符串"—— 后者只能证明代码形状，证明不了行为。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeRoleLastSeen, parseCotTraceRoles, parseTeamStepLine } from './server.js';

/* -------------------------------------------------------------------------- */
/*  ① 团队步骤行的解析                                                          */
/* -------------------------------------------------------------------------- */

/**
 * **★★★ 真实格式必须能解析出来**（这是"补上另一半数据源"的入口）。
 *
 * 格式来源：`manager.ts` 的 `onStep` 写的是
 * `` `[${phase}] ${role}：${note}` ``（**中文冒号**）。
 *
 * ⚠️ 这一条必须用**线上真实出现过的行**，不是我编的形状 ——
 * 否则"测试全绿、线上仍然解析不出来"是完全可能的（本仓库记过这类事故）。
 */
test('★★★ 团队的步骤行（[phase] role：note）必须解析出 role 与 phase', () => {
  const cases: Array<[string, string, string]> = [
    ['[dispatch] supervisor：派出 4 个分析师并行调研', 'supervisor', 'dispatch'],
    ['[debate] bull：第 1 轮：构建做多论证', 'bull', 'debate'],
    ['[verdict] judge：汇总辩论并裁决', 'judge', 'verdict'],
    ['[risk] risk_officer：审阅 3 条决策', 'risk_officer', 'risk'],
    ['[report] reporter：完成（1906ms）', 'reporter', 'report'],
    ['[analysis] market_analyst：完成（26000ms）', 'market_analyst', 'analysis'],
  ];
  for (const [line, role, phase] of cases) {
    const got = parseTeamStepLine(line);
    assert.notEqual(got, null, `★ 这一行必须能解析：${line}`);
    assert.equal(got!.role, role, `★ 角色名解析错了：${line}`);
    assert.equal(got!.phase, phase, `★ 阶段名解析错了：${line}`);
  }
});

test('★★ 英文冒号也要认（不同写法的同一行不该丢掉）', () => {
  const got = parseTeamStepLine('[dispatch] supervisor: 派出调研员');
  assert.notEqual(got, null);
  assert.equal(got!.role, 'supervisor');
  assert.equal(got!.note, '派出调研员');
});

/**
 * **★★★ 负向校准：别的日志行【不许】被认成角色。**
 *
 * `runtime_logs` 的 `scope='team'` 里**不止**有团队的步骤行。实测还有：
 * ```
 *   [调研] 新闻未产出：<原因>          ← manager.ts 的猎手日志
 *   [调研] 全部猎手未产出 —— 保留上一份结果
 * ```
 * 若判据放宽成"`[` 开头 + 有冒号"，这些会被认成角色 ——
 * 而界面按 role 归并（`rosterEntries`），**编制表上就会多出一行不存在的人**。
 * 那是凭空造出一次假出勤，比"漏报"更糟（本仓库反复记过这个方向）。
 */
test('★★★ 负向校准：猎手/自检等非步骤行【不许】被认成角色', () => {
  const notSteps = [
    '[调研] 新闻未产出：upstream 502',
    '[调研] 全部猎手未产出 —— 保留上一份结果（若有）',
    '[调研] 堆栈：Error: connect ECONNREFUSED',
    '[自检/ai] 模型输出未能解析成结构化发现（原文已保留）：…',
    '[自检/deterministic] 裸奔仓位｜BTCUSDT｜下一步：立刻挂止损',
    '已被停用：这条不是团队日志',
    '',
  ];
  for (const line of notSteps) {
    assert.equal(
      parseTeamStepLine(line),
      null,
      `★ 这一行不是团队步骤，不该解析出角色：${line}`,
    );
  }
});

test('★ 角色名限定小写下划线：中文/大写都不认（避免造出假角色）', () => {
  assert.equal(parseTeamStepLine('[dispatch] 总管：派出调研员'), null);
  assert.equal(parseTeamStepLine('[dispatch] Supervisor：派出调研员'), null);
  /* 但下划线组合是合法的（`market_analyst` / `risk_officer`）。 */
  assert.equal(parseTeamStepLine('[analysis] technical：完成')?.role, 'technical');
});

/* -------------------------------------------------------------------------- */
/*  ② cotTrace 行的解析                                                        */
/* -------------------------------------------------------------------------- */

test('★★ cotTrace 的角色行（- role（model）：）必须解析出角色名', () => {
  const trace = [
    '## 本轮各角色产出',
    '- market_analyst（group/team-analyst）：市场整体震荡',
    '- technical（group/team-grunt）：15m 与 1H 矛盾',
    '- bull（group/team-judge）：做多论证已出',
    '- bear（group/team-judge）：做空论证已出',
    '- judge（group/team-judge）：本轮不行动',
  ].join('\n');
  assert.deepEqual(parseCotTraceRoles(trace), [
    'market_analyst',
    'technical',
    'bull',
    'bear',
    'judge',
  ]);
});

test('★★ 负向校准：cotTrace 正文里的 markdown 列表【不许】被认成角色', () => {
  /*
   * `deskOutput.ts` 的注释里记过这个坑的原始形态：
   * 模型的产出是多行 markdown，它的列表项 `- **实体**：…` 长得像角色行。
   * 判据靠"全小写角色名 + 中文括号包住模型名"把两者分开。
   */
  const trace = [
    '- **实体**：美联储',
    '- **方向**：bullish',
    '- 这是一句普通的中文列表项：带冒号',
    '- BTCUSDT（币安）：价格 60000',
  ].join('\n');
  assert.deepEqual(
    parseCotTraceRoles(trace),
    [],
    '★ 正文里的列表项不是角色行 —— 认错了会让编制表多出英文行（用户明确要求"不要有英文"）',
  );
});

/* -------------------------------------------------------------------------- */
/*  ③ 两路数据源合并（本次修复的核心）                                            */
/* -------------------------------------------------------------------------- */

/**
 * **★★★ 负向校准：角色跑了、但 cotTrace 里没有它 → 改前拿不到、改后拿得到。**
 *
 * 这是本次用户投诉的**可复现最小场景**：
 * ```
 *   ① 只有 cotTrace（旧行为）   → supervisor / risk_officer / reporter 拿不到 ← 复现 bug
 *   ② 叠加 runtime_logs（新）   → 它们必须拿得到                          ← 证明修好
 * ```
 * ⚠️ 两段都要有：只写 ② 只能证明"新参数有用"，证明不了"旧路径确实是坏的"，
 * 而后者才是用户报的那个现象。
 */
test('★★★ 负向校准：supervisor/risk_officer/reporter 只在 runtime_logs 里 —— 必须被合并进来', () => {
  /* cotTrace 是 `deskOutput` 的真实形状：只有分析师与 bull/bear/judge。 */
  const cot = [
    '- market_analyst（group/team-analyst）：震荡',
    '- technical（group/team-grunt）：方向矛盾',
    '- bull（group/team-judge）：做多论证已出',
    '- bear（group/team-judge）：做空论证已出',
    '- judge（group/team-judge）：不行动',
  ].join('\n');
  const cots = [{ trace: cot, timestamp: '2026-10-17T06:00:00.000Z' }];

  /* ① 旧行为：只喂 cotTrace（等价于不传 logs）—— 那三个角色**拿不到**。 */
  const before = mergeRoleLastSeen([], cots, null);
  const beforeRoles = new Set(before.map((r) => r.role));
  for (const role of ['supervisor', 'risk_officer', 'reporter']) {
    assert.ok(
      !beforeRoles.has(role),
      `★ 前提断言：${role} 不该出现在 cotTrace 的合并结果里 —— 否则复现不了用户报的现象`,
    );
  }
  /* 对照组：进过 `<team>` 块的角色必须在（证明判据本身没坏）。 */
  for (const role of ['market_analyst', 'technical', 'bull', 'bear', 'judge']) {
    assert.ok(beforeRoles.has(role), `★ ${role} 在 cotTrace 里，必须被解析出来`);
  }

  /* ② 叠加 runtime_logs —— 那三个角色**必须**出现。 */
  const logs = [
    { message: '[dispatch] supervisor：派出 4 个分析师并行调研', createdAt: '2026-10-17T06:05:00.000Z' },
    { message: '[risk] risk_officer：审阅 3 条决策', createdAt: '2026-10-17T06:04:00.000Z' },
    { message: '[report] reporter：完成（1906ms）', createdAt: '2026-10-17T06:06:00.000Z' },
  ];
  const after = mergeRoleLastSeen(logs, cots, null);
  const byRole = new Map(after.map((r) => [r.role, r]));

  assert.equal(
    byRole.get('supervisor')?.at,
    '2026-10-17T06:05:00.000Z',
    '★ 改后 supervisor 必须有最近时刻 —— 否则界面还是显示"待命"，用户报的问题没修',
  );
  assert.equal(byRole.get('risk_officer')?.at, '2026-10-17T06:04:00.000Z');
  assert.equal(byRole.get('reporter')?.at, '2026-10-17T06:06:00.000Z');
  /* 来源必须如实标注（排障时要能区分"日志直写"与"审计块文本"）。 */
  assert.equal(byRole.get('supervisor')?.source, 'log');
  assert.equal(byRole.get('judge')?.source, 'cot');
});

test('★★ 自检行归到 system_engineer（它没有角色名，但确实是它在干活）', () => {
  /*
   * `scope='selfcheck'` 的行形如 `[自检/ai] …`，解析不出角色名。
   * 但自检的 AI 层用的就是 `tierForRole('system_engineer')`
   * （`manager.ts` 的 `buildSelfCheckAsk`）—— 不归到它名下，
   * 「系统工程师」就会永远显示"从未运行"（用户这次报的 7 个之一）。
   */
  const out = mergeRoleLastSeen([], [], '2026-10-17T07:00:00.000Z');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.role, 'system_engineer');
  assert.equal(out[0]!.at, '2026-10-17T07:00:00.000Z');
});

/**
 * **★★ 合并必须取【较晚者】** —— 这条防的是**修法本身引入的新谎**。
 *
 * `runtime_logs` 只有 500 行上限，里面可能混着比 cotTrace 更旧的行。
 * 若"日志无条件覆盖"，"刚刚活跃"会被改写成"3 天前"——
 * 症状与本次要修的完全一样，只是方向相反。
 */
test('★★ 合并取较晚者：日志更旧时不许盖掉 cotTrace 的较新时刻', () => {
  const cots = [{ trace: '- judge（group/x）：已裁决', timestamp: '2026-10-17T06:00:00.000Z' }];

  /* 日志更旧 → 保留 cot 的 06:00。 */
  const older = mergeRoleLastSeen(
    [{ message: '[verdict] judge：汇总辩论并裁决', createdAt: '2026-10-14T06:00:00.000Z' }],
    cots,
    null,
  );
  assert.equal(older.find((r) => r.role === 'judge')?.at, '2026-10-17T06:00:00.000Z');

  /* 日志更新 → 采用日志的 08:00。 */
  const newer = mergeRoleLastSeen(
    [{ message: '[verdict] judge：汇总辩论并裁决', createdAt: '2026-10-17T08:00:00.000Z' }],
    cots,
    null,
  );
  assert.equal(newer.find((r) => r.role === 'judge')?.at, '2026-10-17T08:00:00.000Z');
});

test('★ 输出按时刻倒序（界面"最近活跃"要能一眼看最新的）', () => {
  const out = mergeRoleLastSeen(
    [
      { message: '[dispatch] supervisor：派发', createdAt: '2026-10-17T06:01:00.000Z' },
      { message: '[report] reporter：完成', createdAt: '2026-10-17T06:09:00.000Z' },
    ],
    [{ trace: '- judge（group/x）：裁决', timestamp: '2026-10-17T06:05:00.000Z' }],
    null,
  );
  assert.deepEqual(
    out.map((r) => r.role),
    ['reporter', 'judge', 'supervisor'],
  );
});

test('★ 空输入不炸（新机器人、刚部署、日志被裁剪都走这条路）', () => {
  assert.deepEqual(mergeRoleLastSeen([], [], null), []);
  /* 全是无法解析的行 → 也是空，**不许**凭空造角色。 */
  assert.deepEqual(
    mergeRoleLastSeen([{ message: '[调研] 未产出：502', createdAt: '2026-10-17T06:00:00.000Z' }], [], null),
    [],
  );
});
