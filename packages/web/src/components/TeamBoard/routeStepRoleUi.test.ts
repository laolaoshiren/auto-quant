/**
 * **「总管」那一格的失败数只能来自真正的总管**（t80 的界面侧验收）。
 *
 * ## 这个测试防的是什么
 *
 * 服务端路由步骤原来硬编码 `role: 'supervisor'`（`routedModel.ts` 的 agent 层分支）。
 * 界面侧按 role 把步骤归并成编制表的一行，于是那条**与总管无关**的步骤
 * 被算进了「总管」那一格 —— 而状态判据是**措辞制**：
 * ```
 *   roster.ts 的 stateOfLastStep：level === 'error' 或消息含 失败|抛错|不可用|超时 → failed
 *                                且 failed 优先级高于 done/active
 * ```
 * ⇒ 只要同一轮里**既跑了真总管、又有一条路由步骤**，而后者的文案带失败措辞
 * （agent 层的失败原因是操作员可以直接看到的那类措辞），
 * 整个「总管」那一格就会显示**失败** —— 而总管其实成功了。
 *
 * ## 为什么判据必须取自**渲染结果**
 *
 * `roster.ts` 里的状态词只证明"常量表里有这个词"，不证明**某一行真的渲染出了它**。
 * 所以与 `boardRender.test.ts` 同一个做法：`renderToStaticMarkup` 渲染 `TeamBoard`，
 * 按 `<li data-role="…">` 把那一行切出来，只看它自己的字。
 *
 * ## 它不是浏览器实测（诚实说明）
 *
 * SSR 不执行 `useEffect`、也不证明布局/对齐（那要 `npm run ui:smoke`）。
 * 它证明的是"**屏幕上的字对不对**"—— 而这次要防的正是"字错了"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TeamBoard } from './TeamBoard.js';
import type { TeamStep } from './roster.js';

/** 渲染看板（`initialShowRest` 摊开，保证每一行都在 HTML 里）。 */
function renderBoard(steps: readonly TeamStep[]): string {
  return renderToStaticMarkup(
    createElement(TeamBoard, {
      steps,
      cycleNumber: 1,
      startedAt: null,
      initialShowRest: true,
    }),
  );
}

/** 取一个岗位那一行的 HTML 片段 —— 与 `boardRender.test.ts` 同一手法。 */
function rowOf(html: string, roleId: string): string {
  const marker = `data-role="${roleId}"`;
  const at = html.indexOf(marker);
  if (at < 0) return '';
  const end = html.indexOf('</li>', at);
  return html.slice(at, end < 0 ? undefined : end);
}

/** 取一段 HTML 的可见文字（剥标签）。 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 头部的计数那一句（"本轮在干 N … 失败 N …"）。 */
function headerCounts(html: string): string {
  const at = html.indexOf('本轮在干');
  if (at < 0) return '';
  const end = html.indexOf('已跑', at);
  return textOf(html.slice(at, end < 0 ? at + 400 : end));
}

const AT = '2026-10-17T03:00:00.000Z';

/** 真总管的步骤（`tradingDesk` 的派发阶段写的，措辞逐字取自源码）。 */
const SUPERVISOR_OK: TeamStep = {
  at: AT,
  level: 'info',
  role: 'supervisor',
  phase: 'dispatch',
  message: '派出 4 个分析师并行调研（退回全派）',
};

/** 真总管**失败**的步骤（同一个位置，措辞是它失败时的形状）。 */
const SUPERVISOR_FAILED: TeamStep = {
  at: AT,
  level: 'info',
  role: 'supervisor',
  phase: 'dispatch',
  message: '技术面分析：失败：角色 technical 超过 120 秒未返回',
};

/**
 * 路由步骤 —— **修改前**的形状（硬编码 supervisor，且文案带失败措辞）。
 *
 * ⚠️ 文案是一个**示例**：真实形状见 `t80` 的报告 ——
 * 服务端写的是固定那句「工具循环调用 → 转给单模型…」。
 * 而这条路径上"失败"之所以会出现，是 agent 层的失败原因被写进同一条步骤里
 * （`onStep` 的 note 由路由层自己拼）。所以这里用同一句话 + 失败措辞，
 * 覆盖"同格被污染"的**后果**，而不是赌某一句具体文案。
 */
const ROUTE_STEP_OLD: TeamStep = {
  at: AT,
  level: 'info',
  role: 'supervisor',
  phase: 'route',
  message: '工具循环调用 → 转给单模型（团队会议只回答交易决策）· 调用失败：网关 502',
};

/** 路由步骤 —— **修改后**的形状（归到真正发起调用的角色）。 */
const ROUTE_STEP_NEW: TeamStep = {
  ...ROUTE_STEP_OLD,
  role: 'strategist',
};

test('★★★ 改后：策略师的路由步骤不落在「总管」那一格，总管仍是「进行中」', () => {
  const html = renderBoard([SUPERVISOR_OK, ROUTE_STEP_NEW]);

  const row = rowOf(html, 'supervisor');
  assert.ok(row.length > 0, '★ 渲染结果里找不到 supervisor 那一行（判据失效，先修这个）');
  const text = textOf(row);

  assert.match(text, /派出 4 个分析师/, `★ 总管那一行必须显示它自己的动作：${text}`);
  assert.doesNotMatch(
    text,
    /转给单模型/,
    `★★★ 路由步骤不能出现在总管那一行 —— 它不是总管干的活：${text}`,
  );
  assert.match(text, /进行中/, `★ 总管这一轮跑了、但没写"完成"，所以是「进行中」：${text}`);
  assert.doesNotMatch(text, /失败/, `★★★ 总管那一格不能因为别人的步骤而显示失败：${text}`);
});

test('★★★ 改后：编制表里"界面还没登记"的角色不进头部计数（数字必须能对上编制表）', () => {
  /*
   * `rosterEntries` 会把不在册的 role 追加成一行（`roster.ts:330-353`）——
   * 那是**对的**（丢掉它会让"某个角色在干活但界面看不到"）。
   *
   * 但**计数**是另一回事：`strategist` / `performance_analyst` /
   * `attribution_analyst` / `reviewer` / `trader` 这五个 agent 层角色**都不在编制表里**，
   * 操作员无从对上号。把它们算进「本轮在干 N / 失败 N」，
   * 等于让界面用"自己不认识的东西"去撑一个最该被信任的计数。
   *
   * ⚠️ 这条是"routedModel 把归属修对"之后**才暴露出来**的第二个误报形态：
   * 归属修对了，但那一格变成了一个界面认不出的英文 id。
   */
  const html = renderBoard([SUPERVISOR_OK, ROUTE_STEP_NEW]);

  /* 那一行仍然照常渲染（看得见是硬要求）。 */
  const phantom = rowOf(html, 'strategist');
  assert.ok(
    phantom.length > 0,
    '★ 不在册的角色仍然必须渲染成一行 —— 丢掉它会让"某个角色在干活但界面看不到"',
  );
  assert.match(
    textOf(phantom),
    /strategist/,
    '★ 它必须如实显示自己是谁（未登记岗位用 id 当标题），而不是编一个中文岗位名',
  );

  /* 但它不进计数。 */
  const counts = headerCounts(html);
  assert.doesNotMatch(
    counts,
    /失败 \d+/,
    `★★★ 界面认不出的角色不能撑起"失败"计数（那是这次误报的第二个形态）：${counts}`,
  );
  assert.match(counts, /本轮在干 1/, `★ "本轮在干"只数在册岗位（总管一个）：${counts}`);
});

test('★★★ 改前（对照）：同一个失败措辞落在总管名下时，整个「总管」那一格变成失败', () => {
  /*
   * 这条**不是**在测"旧行为应当保留"，而是把**误报的机制**钉在测试里：
   * 同一轮里"总管成功 + 一条带失败措辞的路由步骤" ⇒ 总管那一格显示失败。
   * 它是上面那条的反面 —— 两条一起才证明"修完真的分开了归属"。
   */
  const html = renderBoard([SUPERVISOR_OK, ROUTE_STEP_OLD]);

  const text = textOf(rowOf(html, 'supervisor'));
  assert.match(
    text,
    /失败/,
    `★ 这一格会显示失败（证明"措辞制判据 + 归错归属"确实会污染总管）：${text}`,
  );
  assert.match(headerCounts(html), /失败 1/, '★ 头部的失败计数也被撑起来了 1');
});

test('★ 负向校准：真正的总管失败，改后仍然显示失败', () => {
  const html = renderBoard([SUPERVISOR_FAILED]);
  const text = textOf(rowOf(html, 'supervisor'));
  assert.match(text, /失败/, `★★★ 真总管的失败不能被改没：${text}`);
  assert.match(headerCounts(html), /失败 1/, '★ 头部必须如实报 1 个失败');
});

test('★ 兜底角色（system_engineer）在编制表里有一行，不是英文 id', () => {
  /*
   * 服务端认不出调用者时会退到 `system_engineer`。界面侧对**不在册**的 role
   * 会追加一行英文 id（`roster.ts` 的"编制表之外的角色"分支），
   * 而"界面上不要有英文"是用户对界面的硬要求。
   */
  const html = renderBoard([{ at: AT, level: 'info', role: 'system_engineer', phase: 'route', message: '工具循环调用 → 转给单模型' }]);
  const text = textOf(rowOf(html, 'system_engineer'));
  assert.match(text, /系统工程师/, `★ 兜底角色必须显示中文岗位名，而不是把 id 当名字：${text}`);
});
