/**
 * 团队看板工作流区的测试。
 *
 * ## 为什么这些测试存在（每一条都对应一个会骗人的界面）
 *
 * 用户 2026-10-12 的反馈是「**用户无法看清楚 AI 运行状态**」。
 * 而"看不清状态"在实现上有三种典型成因，每一条都能让界面**安静地说假话**：
 *
 *   ① **并行步骤按时间排** → 4 个分析师的步骤互相交错，看不出谁在干什么；
 *   ② **"规划中"和"在岗未参与"混为一谈** → 操作员以为"社区监控有人在看"，
 *      而实际上**根本没有人在看**（`firm.ts` 里那一大段注释就是为这件事写的）；
 *   ③ **把"没有后续步骤"当成"已完成"** → 一个**卡住的**角色被显示成"做完了"。
 *
 * 这三条都是"编译全绿、屏幕上少一句话"的那种 bug，只有断言能拦住。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FIRM_ROLES, firmRoleOf, type FirmRole } from '@aq/shared';
import {
  BATCHED_STATE_LABEL,
  STATE_HINT,
  STATE_LABEL,
  clock,
  isBatchedRole,
  lastSeenFromServer,
  lastSeenOf,
  rosterEntries,
  stateLabelFor,
  stateOfLastStep,
  type TeamStep,
} from './roster.js';

/** 造一条 `cycle_step`。 */
function step(role: string | null, message: string, phase?: string, level = 'info'): TeamStep {
  return {
    at: new Date(Date.UTC(2026, 9, 12, 4, 0, 0)).toISOString(),
    message,
    role,
    phase: phase ?? null,
    level,
  };
}

/* -------------------------------------------------------------------------- */
/*  ① 归并与顺序                                                               */
/* -------------------------------------------------------------------------- */

test('★★ 并行角色的步骤按【岗位】归并，而不是按时间切碎', () => {
  /*
   * 实测日志的真实形状（`tradingDesk.ts` 的 `note()` 并行触发）：
   *
   *   [analysis] technical：完成（4112ms）
   *   [analysis] sentiment：完成（5770ms）
   *   [analysis] newscaster：完成（12018ms）
   *   [analysis] market_analyst：完成（24740ms）
   *
   * 按时间显示会得到 4 行互不相干的消息；按岗位归并才能显示成"编制表"。
   */
  const steps = [
    step('technical', '开始分析', 'analysis'),
    step('sentiment', '开始分析', 'analysis'),
    step('technical', '完成（4112ms）', 'analysis'),
    step('sentiment', '完成（5770ms）', 'analysis'),
  ];
  const entries = rosterEntries(steps, FIRM_ROLES);
  const technical = entries.find((e) => e.role.id === 'technical');
  assert.equal(technical?.stepCount, 2, '★ 同一岗位的两步必须归到一起');
  assert.equal(technical?.state, 'done', '★ 看到"完成"应标记为已完成');
  assert.equal(technical?.latest?.message, '完成（4112ms）', '★ 摘要取【最后一步】，不是第一步');
});

test('★★ 输出顺序按【编制表】固定，某一轮少派了谁也不跳位', () => {
  /*
   * 位置会跳的界面，操作员每轮都要重新找"技术面在哪一行" ——
   * 而团队模式是 7×24 一直跑的，每一轮都重新找一遍是纯粹的浪费。
   */
  const a = rosterEntries([step('judge', '已裁决', 'verdict'), step('technical', '完成', 'analysis')], FIRM_ROLES);
  const b = rosterEntries([step('technical', '完成', 'analysis'), step('judge', '已裁决', 'verdict')], FIRM_ROLES);

  assert.deepEqual(
    a.map((x) => x.role.id),
    b.map((x) => x.role.id),
    '★ 输入顺序不同时输出顺序必须一致（都按编制表）',
  );
  assert.ok(
    a.findIndex((x) => x.role.id === 'supervisor') < a.findIndex((x) => x.role.id === 'technical'),
    '★ 管理在最上面（那是决策链的起点），技术面在后面',
  );
});

/* -------------------------------------------------------------------------- */
/*  ② "规划中" ≠ "在岗未参与" —— 这是最重要的一条                              */
/* -------------------------------------------------------------------------- */

test('★★★ 规划中的岗位必须与「在岗但本轮未参与」分开，否则界面在骗人', () => {
  /*
   * 用户列的理想组织里有**还没实现**的角色。把它们显示成"在岗、这轮没轮到"
   * 会让操作员以为"社区有人在看着" —— 而实际上没有人在看。
   * 反过来，把在岗但没叫的显示成"规划中"会让他以为"这个功能还没做"。
   *
   * 两种误读都会让判断走偏，所以这里钉死。
   */
  const entries = rosterEntries([step('technical', '完成', 'analysis')], FIRM_ROLES);

  const planned = entries.find((e) => e.role.id === 'community_monitor');
  assert.equal(planned?.state, 'planned', '★ 社区监控是【规划中】—— firm.ts 里标的就是 planned');
  assert.equal(planned?.latest, null);

  const idle = entries.find((e) => e.role.id === 'bull');
  assert.equal(idle?.state, 'idle', '★ 多头研究员已实现，但这一轮没叫它 → 在岗未参与');

  assert.notEqual(planned?.state, idle?.state, '★★ 两者绝不能是同一个状态');
});

test('★ 编制表里**每个**已实现岗位在没参与时都是 idle，不是 planned', () => {
  const entries = rosterEntries([], FIRM_ROLES);
  for (const entry of entries) {
    /*
     * ⚠️ 期望值写的是**三态映射**，不是 `planned ? planned : idle` 那个双分支。
     * 双分支正是 2026-10-15 之前的样子：`firm.ts` 新增 `by_code` 之后，
     * 新状态会静默落进 `idle`，于是"数据看门狗"被渲染成"在岗/待命/最近活跃" ——
     * 全是模型出勤的措辞，而它没有模型。这条断言把映射表钉成它应有的形状。
     */
    const expected =
      entry.role.status === 'planned'
        ? 'planned'
        : entry.role.status === 'by_code'
          ? 'by_code'
          : 'idle';
    assert.equal(entry.state, expected, `${entry.role.id} 的状态应当是 ${expected}`);
  }
});

test('★★★ 已由代码承担的岗位不得落进"规划中"，也不得落进"在岗"（判据探针）', () => {
  /*
   * ## 这个测试防的是什么
   *
   * `docs/FINDING-planned-roles-audit.md` §4 ④：`data_sentinel` / `ops_watchdog`
   * 的职责已经在跑（`/api/health` 的 `staleTraders`、`selfcheck.ts` 每 30 分钟），
   * 界面却写"规划中" —— **那是一种说谎**。改成 `staffed` 同样是说谎（会让操作员
   * 以为有模型在盯着，实际是确定性查询）。
   *
   * ## 为什么要有"探针"那一半
   *
   * `docs/FINDING-clerk-unwired.md` 的 2026-10-14 补充记了一条关键教训：
   * 那位维护者的**第一版守卫判据本身是错的**，把实际被调用的两个角色误报成死角色。
   * 所以"守卫要能真的抓到东西"必须**用一个确定会失败的反例校准**。
   * 这里用两个方向做校准：
   *   ① 真正没实现的 `community_monitor` 必须仍然是 `planned`（不能全被改成 by_code）；
   *   ② 在岗但本轮没参与的 `bull` 必须仍然是 `idle`（by_code 不能污染它）。
   */
  const entries = rosterEntries([step('technical', '完成', 'analysis')], FIRM_ROLES);

  for (const id of ['data_sentinel', 'ops_watchdog']) {
    const entry = entries.find((e) => e.role.id === id);
    assert.ok(entry !== undefined, `★ 找不到岗位 ${id}`);
    assert.equal(entry.state, 'by_code', `★ ${id} 的职责在跑（确定性代码承担）—— 不能是 ${entry.state}`);
    assert.notEqual(entry.state, 'planned', `★ ${id} 显示"规划中"就是在说谎`);
    assert.notEqual(entry.state, 'idle', `★ ${id} 没有模型出勤 —— "在岗/待命"是模型出勤的措辞`);
  }

  /* 探针 ①：真正没实现的岗位必须仍然是 planned。 */
  assert.equal(
    entries.find((e) => e.role.id === 'community_monitor')?.state,
    'planned',
    '★★ 社区监控确实还没做 —— 它必须仍然显示"规划中"',
  );
  /* 探针 ②：在岗但本轮没参与的模型岗位仍然是 idle。 */
  assert.equal(
    entries.find((e) => e.role.id === 'bull')?.state,
    'idle',
    '★★ 多头研究员已实现、本轮没叫它 —— 它必须仍然是"在岗未参与"',
  );

  /* 探针 ③（判据校准）：人造一个**不存在的**状态，断言它不会被算成 by_code。 */
  const fake: FirmRole = { ...firmRoleOf('bull')!, status: 'some_unknown_status' as FirmRole['status'] };
  assert.notEqual(
    rosterEntries([], [fake])[0]!.state,
    'by_code',
    '★★ 判据必须能区分"真的 by_code"与"随便一个状态值" —— 否则上面那些断言是空转',
  );
});

test('★ 状态词必须唯一：不能有两个状态渲染成同一句话', () => {
  /*
   * `by_code`（职责在跑、没有模型）与 `planned`（还没实现）是**相反**的结论。
   * 若它们的文案碰撞，界面上就再也分不出"这个职能在跑"与"这个职能没做" ——
   * 而这正是这次改动要修的那个谎。颜色可以相近，**字必须不同**。
   */
  const labels = Object.values(STATE_LABEL);
  assert.equal(new Set(labels).size, labels.length, `★ 状态词有重复：${labels.join('、')}`);
  assert.notEqual(STATE_LABEL.by_code, STATE_LABEL.planned, '★★ "代码在跑"与"规划中"不能同词');
  assert.notEqual(STATE_LABEL.by_code, STATE_LABEL.idle, '★★ "代码在跑"不能与"在岗"同词');
  assert.ok(STATE_HINT.by_code.includes('没有'), '★ by_code 的说明要点明"没有模型出勤"');
  assert.ok(STATE_HINT.planned.includes('还没有实现'), '★ planned 的说明要点明"还没实现"');
});

/* -------------------------------------------------------------------------- */
/*  ③ 状态判定                                                                 */
/* -------------------------------------------------------------------------- */

test('★★ 失败优先于完成（失败过的角色不能被显示成"已完成"）', () => {
  /*
   * 一个角色可能先失败、随后被重试成功；也可能反过来。
   * 只要这一轮出现过失败，界面上就不能说它"已交出产出" ——
   * 那会让操作员以为结论是完整的。
   */
  assert.equal(
    stateOfLastStep([
      step('newscaster', '失败：新闻数据源不可用', 'analysis', 'error'),
      step('newscaster', '完成', 'analysis'),
    ]),
    'failed',
    '★ error 级别必须赢过"完成"措辞',
  );
  assert.equal(stateOfLastStep([step('newscaster', '失败：新闻数据源不可用', 'analysis')]), 'failed', '★ 措辞也算失败信号');
  assert.equal(stateOfLastStep([step('technical', '完成（4112ms）', 'analysis')]), 'done');
});

test('★★★ 只有"开始"没有"完成"时是【进行中】，不能显示成已完成', () => {
  /*
   * 这一条防的是最糟的一种误读：**一个卡住的角色被显示成"做完了"**。
   * 服务端只推"发生了"，不推"成没成"（见 `tradingDesk.ts` 的 `note()`）——
   * 所以"没有后续步骤"绝不能被解释成"已完成"。
   */
  assert.equal(stateOfLastStep([step('technical', '开始分析', 'analysis')]), 'active');
  assert.equal(stateOfLastStep([]), 'active');
});

test('★ 没有角色的步骤不进编制表（普通/智能托管模式的步骤不该混进来）', () => {
  const entries = rosterEntries([step(null, '按需取数 #1'), step('technical', '完成', 'analysis')], FIRM_ROLES);
  const technical = entries.find((e) => e.role.id === 'technical');
  assert.equal(technical?.stepCount, 1, '★ 只有带角色的步骤才算进某个岗位');
  assert.ok(
    entries.every((e) => e.latest === null || e.latest.message !== '按需取数 #1'),
    '★ 无角色步骤不能挂到任何岗位的摘要上',
  );
});

/* -------------------------------------------------------------------------- */
/*  ④ 不丢信息                                                                 */
/* -------------------------------------------------------------------------- */

test('★★ 编制表之外的新角色不会被丢掉（后端加岗位、前端还没登记时）', () => {
  /*
   * 丢掉它们会让"某个角色在干活但界面看不到" —— 比显示成"未登记分工"糟得多。
   */
  const entries = rosterEntries([step('quantum_analyst', '完成', 'analysis')], FIRM_ROLES);
  const extra = entries.find((e) => e.role.id === 'quantum_analyst');
  assert.ok(extra, '★ 未登记的岗位也要显示出来');
  assert.equal(extra?.state, 'done');
  /*
   * ⚠️ 2026-10-17（t108）：文案改过了 —— 原来断言的是 `/还没登记/`。
   *
   * 用户截图里显示的是「界面还没登记这个岗位的分工 —— 但它在工作」：
   * 它把"我们的界面没跟上"这件**内部缺口**推到了操作员面前，
   * 而他真正关心的只有两件事：**它是谁**、**它到底在不在干活**。
   * 所以改成中性表述，并保留"正在工作"这个事实。
   * 这里同时断言**旧措辞不许回来**（那是用户明确报过的形状）。
   */
  assert.match(
    extra?.role.duty ?? '',
    /不在编制表里.*正在工作/,
    '★ 兜底要中性地说"不在编制表里但正在工作"，并指向它的最近动作',
  );
  assert.doesNotMatch(
    extra?.role.duty ?? '',
    /界面还没登记|界面未登记/,
    '★ 旧措辞（把内部缺口暴露给用户）不得回来 —— 用户截图报的就是它',
  );
});

test('★★★ 编制表之外的角色也要给中文名（如果名表里有它）', () => {
  /*
   * 这一条直接对应用户实测（t108）：
   * ```
   *   ▼ strategist  进行中  分析  6 步
   *   ▼ reviewer    进行中  分析  工具…
   * ```
   * 它们**不在 `FIRM_ROLES` 里**（编制表没给它们排工位），但 agent 层会以它们的
   * 名义产出 —— 于是走"编制表之外"这条分支，而那条分支以前把 **id 当标题**。
   *
   * 修法：`label: roleLabel(roleId) ?? roleId`。这里验的就是它真的被用上了。
   */
  const entries = rosterEntries([step('strategist', '定方向', 'analysis')], FIRM_ROLES);
  const strategist = entries.find((e) => e.role.id === 'strategist');
  assert.ok(strategist, '★ strategist 必须在看板上出现（它在干活）');
  assert.equal(strategist?.role.label, '策略师', '★ 标题必须是中文名，不能是英文 id');
  assert.notEqual(strategist?.role.label, 'strategist', '★ 屏幕上不能再出现裸 id');
});

test('★ 用自定义编制表时结果只包含那张表里的岗位（可注入 = 可测）', () => {
  const tiny: FirmRole[] = [firmRoleOf('bull')!, firmRoleOf('bear')!];
  const entries = rosterEntries([step('bull', '第 1 轮：构建做多论证', 'debate')], tiny);
  assert.deepEqual(
    entries.map((e) => e.role.id),
    ['bull', 'bear'],
  );
});

/* -------------------------------------------------------------------------- */
/*  ⑤ 时刻                                                                     */
/* -------------------------------------------------------------------------- */

test('★ 时刻是 24 小时制 HH:MM:SS，取不到时是破折号（不是 1970 年）', () => {
  const iso = new Date(2026, 9, 12, 9, 5, 3).toISOString();
  assert.equal(clock(iso), '09:05:03');
  assert.equal(clock(null), '—', '★ 没有时刻就说"没有"，不要显示 08:00:00 那种假值');
  assert.equal(clock('不是时间'), '—');
});

/* -------------------------------------------------------------------------- */
/*  ⑥ 「最近活跃」的数据源必须两路合一（2026-10-17 · t111）                        */
/* -------------------------------------------------------------------------- */

/**
 * **★★★ 负向校准：角色跑了、但它没有 cotTrace 标签 → 改前拿不到时间、改后拿得到。**
 *
 * ## 这是 t111 那条用户投诉的**可复现最小场景**
 *
 * 用户原话：
 * > 「很多岗位，似乎**从未真正运行过**，页面上也没有显示他们**最新运行时间**」
 *
 * 而线上实测 `supervisor` 在 `team` 域出现 **31 次**（全系统最多）。
 *
 * ## 为什么会这样（机制，不是猜测）
 *
 * `cot_trace` 里只有**进了 `<team>` 块的角色**才有 `- <role>（<model>）：` 行，
 * 而 `deskOutput.ts` 只给分析师 / `bull` / `bear` / `judge` 写了这种行。
 * `supervisor` / `risk_officer` / `reporter` 的步骤在 `runtime_logs`（scope='team'），
 * 格式是 `[phase] role：note` —— **界面原来根本没读那张表**。
 *
 * ## 这条测试的判据（两段，缺一不可）
 *
 * ```
 *   ① 只用 cotTrace（旧行为） → 那三个角色**必须拿不到**时刻  ← 复现 bug
 *   ② 叠加服务端 last-seen   → 它们**必须拿得到**            ← 证明修好了
 * ```
 * ⚠️ 只写 ② 是不够的：那只能证明"新参数有用"，证明不了"旧路径确实是坏的"。
 * 而"旧路径是坏的"才是用户报的那个现象。两段都写，这条测试才**可证伪**。
 */
test('★★★ 负向校准：角色跑了但 cotTrace 没有它的标签 —— 改前拿不到时间，改后拿得到', () => {
  /*
   * 编造一轮 cotTrace：**只有**分析师与 judge（这正是 `deskOutput` 的实际形状）。
   * supervisor / risk_officer / reporter **刻意一个都不出现**。
   */
  const cotTrace = [
    '- market_analyst（group/team-analyst）：市场整体震荡，无明确结构',
    '- technical（group/team-grunt）：15m 与 1H 方向矛盾',
    '- bull（group/team-judge）：做多论证已出',
    '- bear（group/team-judge）：做空论证已出',
    '- judge（group/team-judge）：本轮不行动',
  ].join('\n');
  const history = [{ cotTrace, timestamp: '2026-10-17T06:00:00.000Z' }];

  /* ① 旧行为：只喂 cotTrace —— 那三个角色**拿不到**（这就是用户看到的现象）。 */
  const before = lastSeenOf(history);
  for (const role of ['supervisor', 'risk_officer', 'reporter']) {
    assert.equal(
      before.get(role),
      undefined,
      `★ 前提断言：${role} 在 cotTrace 里本来就没有标签 —— 否则这条测试复现不了用户报的现象`,
    );
  }
  /* 对照组：进过 `<team>` 块的角色**必须**能拿到（证明判据本身没坏）。 */
  for (const role of ['market_analyst', 'technical', 'bull', 'bear', 'judge']) {
    assert.equal(before.get(role), '2026-10-17T06:00:00.000Z', `★ ${role} 在 cotTrace 里，必须能拿到时刻`);
  }

  /* ② 叠加服务端 `/agent/last-seen` 的产物 —— 那三个角色**必须拿得到**。 */
  const fromServer = lastSeenFromServer([
    { role: 'supervisor', at: '2026-10-17T06:05:00.000Z' },
    { role: 'risk_officer', at: '2026-10-17T06:04:00.000Z' },
    { role: 'reporter', at: '2026-10-17T06:06:00.000Z' },
  ]);
  const after = lastSeenOf(history, fromServer);
  assert.equal(
    after.get('supervisor'),
    '2026-10-17T06:05:00.000Z',
    '★ 改后 supervisor 必须有最近时刻 —— 否则界面上它还是"待命"，用户报的问题没修',
  );
  assert.equal(after.get('risk_officer'), '2026-10-17T06:04:00.000Z');
  assert.equal(after.get('reporter'), '2026-10-17T06:06:00.000Z');
  /* 对照组不能被服务端那一路覆盖坏。 */
  assert.equal(after.get('judge'), '2026-10-17T06:00:00.000Z');
});

test('★★ 两路数据源合并取【较晚者】（不能无条件用服务端覆盖）', () => {
  /*
   * ⚠️ 这一条防的是**修法本身引入的新谎**：
   * 服务端 `runtime_logs` 表有 500 行上限，里面可能混着**更旧**的行。
   * 若无条件覆盖，会把"刚刚活跃"改写成"3 天前" —— 症状与本次要修的一样，
   * 只是方向相反。所以判据必须是"取较晚者"。
   */
  const history = [{ cotTrace: '- judge（group/x）：已裁决', timestamp: '2026-10-17T06:00:00.000Z' }];
  const olderFromServer = lastSeenFromServer([{ role: 'judge', at: '2026-10-14T06:00:00.000Z' }]);
  assert.equal(
    lastSeenOf(history, olderFromServer).get('judge'),
    '2026-10-17T06:00:00.000Z',
    '★ 服务端给出更旧的时刻时，不能把 cotTrace 的较新时刻盖掉',
  );

  const newerFromServer = lastSeenFromServer([{ role: 'judge', at: '2026-10-17T07:00:00.000Z' }]);
  assert.equal(
    lastSeenOf(history, newerFromServer).get('judge'),
    '2026-10-17T07:00:00.000Z',
    '★ 服务端给出更新时刻时必须采用它（它是"刚刚出勤"的直接证据）',
  );
});

test('★ 服务端形状的容错：坏行被跳过，不能让整块时刻变成脏数据', () => {
  /*
   * 服务端响应是**网络来的东西**，不能假设它符合预期形状
   * （旧版本服务、代理截断、字段改名…）。这一条钉住"坏行跳过、好行照收"。
   */
  const map = lastSeenFromServer([
    { role: 'supervisor', at: '2026-10-17T06:05:00.000Z' },
    { role: '', at: '2026-10-17T06:05:00.000Z' },
    { role: 'risk_officer', at: '' },
    { role: 'reporter', at: '2026-10-17T06:06:00.000Z' },
  ]);
  assert.deepEqual(
    [...map.keys()].sort(),
    ['reporter', 'supervisor'],
    '★ 空 role / 空时刻的行必须被丢掉',
  );
  /* 完全没有数据时也必须给出一个可用的空 Map（`undefined` 会让调用方崩）。 */
  assert.equal(lastSeenFromServer(undefined).size, 0);
  assert.equal(lastSeenFromServer(null).size, 0);
});

/* -------------------------------------------------------------------------- */
/*  ⑥ 「随批运行」—— planned 里有一类其实在跑（2026-10-17 · t112）              */
/* -------------------------------------------------------------------------- */

test('★★★ 随批运行的判据：planned + carriedBy，缺一不可', () => {
  /*
   * 用户原话：「我观察到**很多岗位，似乎从未真正运行过**」——
   * 其中 `community_monitor` / `onchain_analyst` 是**看板在低估自己**：
   * 它们的职责由批量调研的猎手在跑（`community_hunter` / `flow_hunter`）。
   *
   * 判据是"两个条件同时成立"，这里逐条钉住：
   * ```
   *   planned + 有 carriedBy  → 随批运行（有东西在替它跑）
   *   planned + 无 carriedBy  → 规划中（真的没人干）
   *   staffed / by_code       → 与"随批"无关（走它们自己的分支）
   * ```
   */
  assert.equal(
    isBatchedRole({ status: 'planned', carriedBy: '社区猎手（community_hunter）承担' }),
    true,
    '★ planned + carriedBy 必须是"随批运行"',
  );
  assert.equal(
    isBatchedRole({ status: 'planned' }),
    false,
    '★ planned 但没有承担者 —— 真的没人干，不能算随批运行',
  );
  assert.equal(
    isBatchedRole({ status: 'planned', carriedBy: '   ' }),
    false,
    '★ 空白字符串不算承担者（那会让一个没写清的字段点亮整个岗位）',
  );
  assert.equal(
    isBatchedRole({ status: 'by_code', carriedBy: 'selfcheck.ts 的 findDeterministicProblems()' }),
    false,
    '★ by_code 走它自己的分支（"代码在跑"），不要与随批运行混为一谈',
  );
  assert.equal(
    isBatchedRole({ status: 'staffed', carriedBy: '随便写的' }),
    false,
    '★ staffed 有模型出勤，不算随批运行',
  );
});

test('★★★ 状态词：随批运行显示「随批运行」，真未接线仍显示「规划中」', () => {
  /*
   * ⚠️ 这是 t112 的**用户可见结果**：原来两者都写「规划中」，
   * 而"规划中"这三个字让操作员以为**根本没人干这件事**。
   */
  const batched = { status: 'planned', carriedBy: '社区猎手（community_hunter）承担' };
  const unwired = { status: 'planned' };
  assert.equal(stateLabelFor('planned', false, batched), BATCHED_STATE_LABEL);
  assert.equal(stateLabelFor('planned', true, batched), BATCHED_STATE_LABEL, '★ 回放态也一样（随批运行与轮次无关）');
  assert.equal(stateLabelFor('planned', false, unwired), '规划中');
  assert.notEqual(BATCHED_STATE_LABEL, '规划中', '★ 两个词必须是不同的 —— 否则改了等于没改');

  /* 非 planned 态**不受** carriedBy 影响（by_code 仍显示"代码在跑"）。 */
  assert.equal(stateLabelFor('by_code', false, { status: 'by_code', carriedBy: 'x'.repeat(20) }), '代码在跑');
  assert.equal(stateLabelFor('idle', false, { status: 'staffed' }), '在岗');
});

test('★★ 真实编制表：恰好这两个岗位是随批运行（其余真未接线的不许被点亮）', () => {
  const batched = FIRM_ROLES.filter(isBatchedRole).map((r) => r.id).sort();
  assert.deepEqual(
    batched,
    ['community_monitor', 'onchain_analyst'],
    `★ 随批运行的岗位集合变了：实际 [${batched.join('、')}] —— 每加一个都必须有真实承担者`,
  );
  /* 三个真未接线的：状态词必须仍是「规划中」。 */
  for (const id of ['red_team', 'portfolio_manager', 'clerk']) {
    const role = FIRM_ROLES.find((r) => r.id === id);
    assert.ok(role, `★ 找不到 ${id}`);
    assert.equal(stateLabelFor('planned', false, role), '规划中', `★★ ${id} 没有任何东西在跑，必须仍是"规划中"`);
  }
});

test('★★ 负向校准：随批运行的判据本身就是可证伪的', () => {
  /*
   * 防止把判据写成恒真（本仓库清过一轮恒真断言）。
   * 人造一个"有 carriedBy 但 status 不是 planned"的岗位 → 必须**不**被判成随批运行；
   * 再把人造岗位的 status 改成 planned → 必须**判成**随批运行。
   * ⇒ 证明 `status` 这一维真的在起作用，不是只看 carriedBy。
   */
  const fabric = { status: 'staffed', carriedBy: '社区猎手（community_hunter）承担' };
  assert.equal(isBatchedRole(fabric), false, '★ status 不是 planned 时，carriedBy 再长也不该点亮');
  assert.equal(isBatchedRole({ ...fabric, status: 'planned' }), true, '★ 同一份 carriedBy，status 改成 planned 后应当点亮');
});
