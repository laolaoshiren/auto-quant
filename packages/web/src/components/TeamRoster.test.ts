/**
 * 团队看板的测试 —— 重点钉住"**并行角色归并**"这个易错点。
 *
 * 用户 2026-10-12 要求团队看板「直观显示**有哪些智能体，都是什么分工，都在做什么**」。
 * 而团队是**并行**的：4 个分析师的步骤会交错出现。按时间排会把每个角色的过程切碎，
 * 所以必须按角色归并 —— 这里就是那个归并逻辑的守卫。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MODE_BADGE, groupByRole } from './TeamRoster.js';

/** 造一条 cycle_step。 */
function step(role: string | null, message: string, phase?: string, level = 'info') {
  return { at: new Date(2026, 0, 1, 12, 0, 0).toISOString(), message, role, phase: phase ?? null, level };
}

test('★★ 并行角色的步骤被【按角色归并】，而不是按时间切碎', () => {
  /*
   * 真实日志的形状就是这样交错的（实测）：
   *
   *   [analysis] technical：完成（4112ms）
   *   [analysis] sentiment：完成（5770ms）
   *   [analysis] newscaster：完成（12018ms）
   *   [analysis] market_analyst：完成（24740ms）
   *
   * 按时间显示会得到 4 行互不相干的消息；按角色归并才能显示成"编制表"。
   */
  const steps = [
    step('technical', '完成（4112ms）', 'analysis'),
    step('sentiment', '完成（5770ms）', 'analysis'),
    step('technical', '开始分析', 'analysis'),
    step('sentiment', '开始分析', 'analysis'),
  ];
  const grouped = groupByRole(steps);

  const technical = grouped.find((g) => g.role === 'technical');
  assert.ok(technical, '技术面应当在编制表里');
  assert.equal(technical.steps.length, 2, '★ 同一个角色的两步必须归到一起');
  assert.equal(technical.done, true, '看到"完成"应标记为已完成');
});

test('★ 输出顺序按【编制表】而不是"谁先出现"（位置稳定，不跳）', () => {
  /*
   * 即使某一轮少派了某个角色，剩下的角色位置也不该跳来跳去 ——
   * 否则操作员每轮都要重新找"技术面在哪一行"。
   */
  const a = groupByRole([step('judge', '已裁决', 'verdict'), step('technical', '完成', 'analysis')]);
  const b = groupByRole([step('technical', '完成', 'analysis'), step('judge', '已裁决', 'verdict')]);

  assert.deepEqual(
    a.map((x) => x.role),
    b.map((x) => x.role),
    '★ 输入顺序不同时，输出顺序必须一致（按编制表）',
  );
  /* 编制表里 technical 在 judge 之前 */
  assert.ok(
    a.findIndex((x) => x.role === 'technical') < a.findIndex((x) => x.role === 'judge'),
    '★ 应当按编制表的固定顺序',
  );
});

test('★ 失败的角色被标记（多智能体下"哪个角色挂了"是关键信息）', () => {
  const grouped = groupByRole([
    step('newscaster', '失败：新闻数据源不可用', 'analysis', 'error'),
    step('technical', '完成', 'analysis'),
  ]);
  const news = grouped.find((g) => g.role === 'newscaster');
  assert.equal(news?.failed, true, '★ 失败必须可见 —— 否则整轮"没有结论"时看不出是哪个环节的问题');
  assert.equal(grouped.find((g) => g.role === 'technical')?.failed, false);
});

test('★ 没有角色的步骤不进编制表（普通/智能托管模式的步骤不该混进来）', () => {
  const grouped = groupByRole([
    step(null, '按需取数 #1'),
    step('technical', '完成', 'analysis'),
  ]);
  assert.equal(grouped.length, 1, '★ 只有带角色的步骤才进编制表');
  assert.equal(grouped[0]!.role, 'technical');
});

test('★ 编制表之外的新角色不会被丢掉（未来加角色时不丢信息）', () => {
  /*
   * 后端加了新角色、前端还没登记分工时，不能让它**整个消失** ——
   * 那会让"某个角色在干活但界面看不到"，比显示成"未登记分工"糟得多。
   */
  const grouped = groupByRole([step('onchain_analyst', '完成', 'analysis')]);
  assert.equal(grouped.length, 1, '★ 未登记的角色也要显示出来');
  assert.equal(grouped[0]!.role, 'onchain_analyst');
});

test('空步骤返回空数组（不崩）', () => {
  assert.deepEqual(groupByRole([]), []);
});

test('★ lastAt 是最后一步的时刻（界面显示"最近动作时间"）', () => {
  const grouped = groupByRole([
    { at: '2026-01-01T12:00:00.000Z', message: 'a', role: 'bull', phase: 'debate', level: 'info' },
    { at: '2026-01-01T12:00:05.000Z', message: 'b', role: 'bull', phase: 'debate', level: 'info' },
  ]);
  assert.equal(grouped[0]!.lastAt, '2026-01-01T12:00:05.000Z');
});

/* -------------------------------------------------------------------------- */
/*  模式徽章：每一种模式都要有自己的名字（2026-10-19 用户报"显示不对"）           */
/* -------------------------------------------------------------------------- */

test('★★★ 每一种 TraderMode 都必须有自己的徽章（不许落到兜底分支）', () => {
  /*
   * ## 这个用例防的是什么
   *
   * 用户截图指出：`#13 JEV测试` 的模式徽章显示成「固定策略」。
   *
   * 根因是原来的实现用 `if/if/return` 兜底：
   * ```
   *   if (mode === 'ai_team')    → 「团队」
   *   if (mode === 'ai_managed') → 「智能托管」
   *   return 「固定策略」           ← jev 落到这里
   * ```
   * 兜底 `return` 是**静默错误**：它让"没处理的新值"看起来像另一个模式，
   * 而那个模式的语义完全不同（固定策略 vs Jev 自主判断）。
   *
   * ⇒ 现在用 `Record<TraderMode, …>`，少写一个键就编译不过；
   *   这个用例再从**运行时**钉一遍，防止有人改回 if 链。
   */
  const modes = ['strategy', 'ai_managed', 'ai_team', 'jev'] as const;
  for (const mode of modes) {
    const badge = MODE_BADGE[mode];
    assert.ok(badge !== undefined, `★ ${mode} 没有徽章定义`);
    assert.ok(badge.text.trim().length > 0, `★ ${mode} 的徽章文案不能为空`);
    assert.ok(badge.className.trim().length > 0, `★ ${mode} 的徽章样式不能为空`);
  }

  /*
   * ⚠️ **徽章文案必须互不相同** —— 两个模式显示同一个名字，
   * 等于界面上分不出它们（那正是这个 bug 的本质）。
   */
  const texts = modes.map((m) => MODE_BADGE[m].text);
  assert.equal(
    new Set(texts).size,
    texts.length,
    `★ 徽章文案重复了：${texts.join(' / ')}`,
  );

  /*
   * ⚠️ JEV 模式的徽章**必须标明实验性** —— 用户明确要求这个模式是实验性的，
   * 而它的盈利表现完全未知（`docs/JEV-MODE-DESIGN.md` §八）。
   */
  assert.ok(
    /实验/.test(MODE_BADGE.jev.text),
    '★ JEV 模式的徽章必须标明它是实验性的',
  );
});