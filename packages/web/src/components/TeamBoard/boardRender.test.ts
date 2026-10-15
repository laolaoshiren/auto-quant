/**
 * **团队看板实际渲染出来的字**（SSR 断言，2026-10-15）。
 *
 * ## 为什么需要它（本项目已为这个形状付过代价）
 *
 * `docs/FINDING-clerk-unwired.md` 的「2026-10-14 补充」记了一条教训：
 * 那位维护者的**第一版守卫判据本身是错的** —— 它只认 `role: 'xxx'` 一种调用形状，
 * 于是把 `performance_analyst` / `attribution_analyst` **误报成死角色**。
 * 他要的是"守卫能真的抓到东西"，做法是加**探针校准**（拿一个人造 id 跑同一套判据，
 * 断言它会被报出）。
 *
 * 同一个道理在界面上更强：`roster.ts` 里那些 `STATE_LABEL` / `STATE_HINT` 断言
 * 只证明"常量表里有这个词"，**不证明某一行真的渲染出了它**。
 * 而这次要防的正是"新状态没走到正确分支，被渲染成『规划中』"——
 * 那是一个**只在屏幕上**存在的 bug：typecheck 全绿、单测全绿、`npm run build` 全绿。
 *
 * 所以这里把 `TeamBoard` 用 `renderToStaticMarkup` 渲染成 HTML，
 * 直接断言**那两行岗位的字面文案**。
 *
 * ## 判据的边界（诚实说明）
 *
 * · SSR 渲染**不执行** `useEffect`（计时器不跑）—— 但状态词与计数都在首次渲染里，
 *   不受影响；本轮由 SSR 断言的东西全部在首屏。
 * · 它不证明浏览器里的**布局/对齐**（那要用真实浏览器量 `getBoundingClientRect()`，
 *   见 `AGENTS.md` 的 UI 约定）—— 它证明的是"字对不对"，不是"排得齐不齐"。
 * · 所以它**不能**替代 `npm run ui:smoke`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TeamBoard } from './TeamBoard.js';

/** 渲染看板（本轮没有任何步骤 —— 正是"其余岗位"那一批要显示状态的场景）。 */
function renderBoard(): string {
  return renderToStaticMarkup(
    createElement(TeamBoard, {
      steps: [],
      cycleNumber: 1,
      startedAt: null,
      /*
       * ⚠️ 必须摊开「其余岗位」：`data_sentinel` / `ops_watchdog` 本轮没参与，
       * 默认收起时它们的行**根本不在 HTML 里**，断言会退化成"找不到那一行"。
       * 摊开只影响渲染范围，不影响状态判定。
       */
      initialShowRest: true,
    }),
  );
}

/**
 * 取一个岗位那一行的 HTML 片段。
 *
 * ## 为什么不能"在整页 HTML 里搜『规划中』"
 *
 * 那个词在**别的岗位**上是对的（社区监控、链上分析等 5 个确实是规划中），
 * 也在头部计数里出现。在整页搜等于把"某处出现了这个词"当成"这一行错了" ——
 * 那正是本仓库反复记的那种"把注释里的字当代码"的误判。
 *
 * 所以按 `<li data-role="…">` 切：每个岗位一行，切出来只看它自己。
 * ⚠️ 前置断言必须**真的切到那一行**：切不到就返回空串，
 * 而每个调用处都先断言 `row.length > 0`，兜住"判据本身失效"的情形。
 */
function rowOf(html: string, roleId: string): string {
  const marker = `data-role="${roleId}"`;
  const at = html.indexOf(marker);
  if (at < 0) return '';
  const end = html.indexOf('</li>', at);
  return html.slice(at, end < 0 ? undefined : end);
}

/**
 * 取一段 HTML 的**可见文字**（剥掉标签与属性，顺带解开实体）。
 *
 * ## 为什么"状态词"必须在文字上判，而不是在 HTML 上
 *
 * ⚠️ 这里踩过一次（本测试第一版）：我在整段 HTML 上搜"待命"，于是**悬停说明里**
 * 的"待命"（`by_code` 的 `title` 写的是"既没有出勤也没有待命"）被判成了违规 ——
 * **假阳性**。反过来，若某个状态词只出现在 `class` / `title` 里、文字上没有，
 * 在整段 HTML 上搜又会**假阴性**（操作员根本看不见它）。
 *
 * 这正是本仓库记过的那条教训的形状：**判据本身也需要被校准** ——
 * 搜错了地方，守卫会在两种方向上同时出错（`FINDING-clerk-unwired.md` 2026-10-14 补充）。
 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

test('★★★ 已由代码承担的岗位**不能**显示成"规划中"（界面在说的必须是事实）', () => {
  /*
   * `docs/FINDING-planned-roles-audit.md` §4 ④：
   * > `data_sentinel` / `ops_watchdog` —— 建议把它们在 FIRM_ROLES 里标成"已由代码承担"
   * > （而不是 planned），并在界面上说明 —— 否则界面显示"规划中"而实际在跑，
   * > **那本身是一种说谎。**
   *
   * 这条就是那句话的可执行版本。判据取自**渲染结果**，不是源码里的常量表。
   */
  const html = renderBoard();

  for (const id of ['data_sentinel', 'ops_watchdog']) {
    const row = rowOf(html, id);
    assert.ok(row.length > 0, `★ 渲染结果里找不到 ${id} 那一行（判据失效，先修这个）`);
    const text = textOf(row);
    assert.ok(
      text.includes('代码在跑'),
      `★ ${id} 那一行必须显示"代码在跑" —— 实际渲染文字：${text}`,
    );
    assert.ok(
      !text.includes('规划中'),
      `★ ${id} 的职责在跑（/api/health 的 staleTraders、selfcheck.ts 每 30 分钟）—— ` +
        `渲染成"规划中"就是在说谎。实际渲染文字：${text}`,
    );
    /* 也不许退化成模型出勤的措辞（标 staffed 的后果）。 */
    assert.ok(
      !text.includes('待命') && !text.includes('最近活跃'),
      `★ ${id} 没有模型出勤 —— 不能渲染"待命/最近活跃"那种措辞。实际渲染文字：${text}`,
    );
  }
});

test('★★★ 承担者必须写在行内：操作员要能自己去核对那段代码', () => {
  /*
   * "已由代码承担"是一句**无法被核对**的话：没有模型可以打开看。
   * 所以行内必须写出确切的模块/产出 —— `carriedBy` 是那个事实的载体
   * （`firmStatus.test.ts` 还会去仓库里核对它指向的代码真的存在）。
   */
  const html = renderBoard();
  const sentinel = textOf(rowOf(html, 'data_sentinel'));
  const ops = textOf(rowOf(html, 'ops_watchdog'));

  assert.ok(sentinel.includes('staleTraders'), `★ 数据看门狗的承担物/产出必须写出来：${sentinel}`);
  assert.ok(ops.includes('findDeterministicProblems'), `★ 运维看门狗的承担物必须写出来：${ops}`);
});

test('★★★ 头部计数必须把"代码在跑"从"规划中"里分出来', () => {
  /*
   * 头部的计数是操作员**第一眼**看到的东西。若它写"规划中 7"，
   * 那么即使每一行都写对了，这一行仍然在说谎（两个在跑的岗位被算进"还没实现"）。
   * 反过来，若把 by_code 并进"在岗未叫"，操作员会去等两个不会出勤的模型岗位。
   */
  const text = textOf(renderBoard());
  assert.ok(text.includes('代码在跑 2'), `★ 头部必须单列"代码在跑 2"（实际渲染文字里没有这一项）`);
  assert.ok(
    text.includes('已由代码承担 2'),
    `★ 「其余岗位」那一行必须单列"已由代码承担 2"`,
  );
  assert.ok(
    text.includes('规划中 5（还没实现）'),
    `★ 规划中只能是真没做的 5 个（21 个岗位 − 14 在岗 − 2 已由代码承担）`,
  );
});

test('★★ 5 个真正没实现的岗位仍然显示"规划中"（不能顺手全改）', () => {
  /*
   * 反方向：这次改动只把**两个有实测证据**的岗位改成 `by_code`。
   * 剩下的五个职责确实没在跑 —— 把它们也改掉就是另一种说谎，
   * 正是任务里明确警告的"下一次有人顺手全改"。
   */
  const html = renderBoard();
  for (const id of ['onchain_analyst', 'community_monitor', 'red_team', 'portfolio_manager', 'clerk']) {
    const row = rowOf(html, id);
    assert.ok(row.length > 0, `★ 渲染结果里找不到 ${id} 那一行（判据失效，先修这个）`);
    const text = textOf(row);
    assert.ok(text.includes('规划中'), `★ ${id} 的职责确实没在跑 —— 必须仍然显示"规划中"：${text}`);
    assert.ok(!text.includes('代码在跑'), `★ ${id} 不是 by_code 岗位，不能显示"代码在跑"：${text}`);
  }
});
