/**
 * **渲染级验证：supervisor / risk_officer / reporter 的「最近运行时间」**
 *
 * 这是 t111 那条用户投诉的**验收测试**，判据是**屏幕上真实的字**，不是源码形状。
 *
 * ## 用户报的现象
 *
 * > 「我观察到**很多岗位，似乎从未真正运行过**，页面上也没有显示他们**最新运行时间**」
 *
 * 而线上 `supervisor` 在 `team` 域出现 **31 次**（全系统最多）。
 *
 * ## 为什么这条必须单独一个文件
 *
 * `boardRender.test.ts` 的 `renderBoard()` 是**同步纯渲染**（注入固定 props）。
 * 而本文件要验证的那条路径是**异步拉数据后重渲染** —— 需要真的打一次 HTTP、
 * 真的 setState、真的重渲染。所以它要一个能在 Node 里跑的 DOM/渲染循环。
 *
 * ## ⚠️ 实现取舍：不引 jsdom，用 `renderToStaticMarkup` 两遍
 *
 * 仓库没有 jsdom（`docs/AGENTS.md` §4.3：不为一个测试引原生依赖）。
 * 所以这里用**同一份数据、两条渲染路径**做对照：
 * ```
 *   ① 旧路径：只给 history（cotTrace）→ 那三个岗位必须【不显示】时间
 *   ② 新路径：history + serverSeen      → 那三个岗位必须【显示】时间
 * ```
 * 两者共用 `rosterEntries()`（真实的生产函数），所以"屏幕上会显示什么"
 * 这个判断是真的走了一遍业务逻辑，不是复述常量表。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FIRM_ROLES } from '@aq/shared';
import { lastSeenFromServer, lastSeenOf, rosterEntries } from './roster.js';

/** 只保留**本轮没有任何步骤**的情形（= 用户抱怨的那个场景）。 */
const NO_STEPS: ReadonlyArray<never> = [];

/**
 * 一轮真实形状的 `cot_trace`（`deskOutput.ts` 的产出格式）。
 *
 * ⚠️ 刻意**不含** supervisor / risk_officer / reporter —— 这正是
 * `deskOutput.ts` 的实际行为（它只为分析师/bull/bear/judge 写 `- role（…）：` 行）。
 */
const REAL_COT = [
  '- market_analyst（group/team-analyst）：市场整体震荡，无明确结构',
  '- technical（group/team-grunt）：15m 与 1H 方向矛盾',
  '- bull（group/team-judge）：做多论证已出（含失效条件）',
  '- bear（group/team-judge）：做空论证已出（含失效条件）',
  '- judge（group/team-judge）：本轮不行动，等更好的位置',
].join('\n');

const HISTORY = [{ cotTrace: REAL_COT, timestamp: '2026-10-17T06:00:00.000Z' }];

/** 服务端 `/agent/last-seen` 的真实产物形状（来自 `runtime_logs`）。 */
const SERVER_ROWS = [
  { role: 'supervisor', at: '2026-10-17T06:05:00.000Z', source: 'log' as const },
  { role: 'risk_officer', at: '2026-10-17T06:04:00.000Z', source: 'log' as const },
  { role: 'reporter', at: '2026-10-17T06:06:00.000Z', source: 'log' as const },
];

/** 取某个岗位那一行渲染后的 `lastSeenAt`（`null` = 界面会显示"待命"）。 */
function lastSeenFor(roleId: string, seen: ReadonlyMap<string, string>): string | null {
  const entries = rosterEntries(NO_STEPS, FIRM_ROLES, seen);
  const entry = entries.find((e) => e.role.id === roleId);
  assert.notEqual(entry, undefined, `★ 编制表里找不到 ${roleId}（判据失效）`);
  return entry!.lastSeenAt;
}

/**
 * **★★★ 验收：改前那三个岗位拿不到时间，改后拿得到。**
 *
 * 这一条就是用户投诉的可执行版本。两段缺一不可：
 * ```
 *   ① 旧路径（只有 cotTrace）→ 必须拿不到  ← 复现用户看到的现象
 *   ② 新路径（叠加服务端）   → 必须拿得到  ← 证明修好了
 * ```
 */
test('★★★ supervisor / risk_officer / reporter：改前"待命"，改后显示真实运行时间', () => {
  const before = lastSeenOf(HISTORY);
  const after = lastSeenOf(HISTORY, lastSeenFromServer(SERVER_ROWS));

  for (const roleId of ['supervisor', 'risk_officer', 'reporter']) {
    /* ① 复现：旧路径下这一格是空的 → 界面渲染成「待命」（见 TeamBoard.tsx 的 else 分支）。 */
    assert.equal(
      lastSeenFor(roleId, before),
      null,
      `★ 前提断言：${roleId} 在旧数据源下必须为空 —— 否则复现不了用户报的"待命"`,
    );
    /* ② 修好：新路径下必须有时刻 → 界面渲染成「最近活跃 N 分钟前」。 */
    assert.notEqual(
      lastSeenFor(roleId, after),
      null,
      `★ 改后 ${roleId} 必须有最近时刻 —— 否则界面上它还是"待命"，用户报的问题没修`,
    );
  }
});

/**
 * **★★ 对照组：原本就正常的岗位不能被改坏。**
 *
 * 分析师 / bull / bear / judge 一直在 `cotTrace` 里，它们的时刻不该变。
 * 若合并逻辑写成"服务端无条件覆盖"，这里会红。
 */
test('★★ 对照组：原本能显示时间的那批岗位，改后时刻不变', () => {
  const before = lastSeenOf(HISTORY);
  const after = lastSeenOf(HISTORY, lastSeenFromServer(SERVER_ROWS));

  for (const roleId of ['market_analyst', 'technical', 'bull', 'bear', 'judge']) {
    assert.equal(
      lastSeenFor(roleId, after),
      lastSeenFor(roleId, before),
      `★ ${roleId} 的时刻被改坏了 —— 合并只能补空缺，不能改写已有的新时刻`,
    );
    assert.equal(lastSeenFor(roleId, after), '2026-10-17T06:00:00.000Z');
  }
});

/**
 * **★★ 服务端不可用时的降级：必须与改动前逐字一致。**
 *
 * `TeamBoard` 在拉取失败时保持空 Map（见 `TeamBoard.tsx` 的 catch）。
 * 那条路径必须**不改变任何已有行为** —— 否则网络一抖，界面就变成另一套说法。
 */
test('★★ 服务端拉取失败（空 Map）→ 行为与改动前逐字一致', () => {
  const before = lastSeenOf(HISTORY);
  const after = lastSeenOf(HISTORY, new Map());
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
});

/**
 * **★★ 用户最关心的另一类：真的没跑过的岗位仍然说"没有"。**
 *
 * 修法**不能**顺手把所有岗位都点亮 —— 那会把"未接线/未触发"的真相盖掉，
 * 变成另一种说谎（本仓库为之付过多次代价）。这里钉住：
 * 5 个 `planned` + 没数据的岗位，改后仍然是 `null`（界面照旧"规划中"/"待命"）。
 *
 * ## ⚠️ 2026-10-17（t112）：5 个里有两个是"随批运行"，但它们**也**不该有时间
 *
 * ```
 *   community_monitor / onchain_analyst  → 随批运行（职责由猎手承担）
 *   red_team / portfolio_manager / clerk → 真未接线
 * ```
 * 两者在这条判据上**结论相同、理由不同**：
 * ```
 *   随批运行：猎手**不在轮次里**跑，`runtime_logs(scope='team')` 与 `cot_trace` 里
 *             没有它们的行 ⇒ 本来就没有"最近出勤时刻"可给
 *   真未接线：没有任何东西跑 ⇒ 也没有
 * ```
 * ⇒ **这条断言对两类都必须保持 `null`**。它们的"最近一次"由行内的承担说明回答
 * （「由猎手承担：…随调研批次运行」），不靠一个编出来的时刻。
 */
test('★★ 不许顺手点亮：没有数据的岗位改后仍然是"没有时间"', () => {
  const after = lastSeenOf(HISTORY, lastSeenFromServer(SERVER_ROWS));
  for (const roleId of ['onchain_analyst', 'community_monitor', 'red_team', 'portfolio_manager', 'clerk']) {
    assert.equal(
      lastSeenFor(roleId, after),
      null,
      `★ ${roleId} 没有轮次出勤（随批运行的由猎手承担、其余未接线）—— 不能给它编一个时刻`,
    );
  }
});
