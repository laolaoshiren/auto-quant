/**
 * **零决策的五态文案必须真的渲染出来、而且互不相同**（2026-10-15 · task E）
 *
 * ## 事故背景（这条测试防的是哪一类失败）
 *
 * 后端 `deskOutput.ts` 已经把失败分成了四类并写进审计块，前端
 * `decisionZeroState.ts` 也能把它们分开 —— **但页面只会说一句**
 * 「输出解析失败（模型回复可能被截断）…去查 `max_tokens`」。
 *
 * 后果很具体：**裁决官这一轮没有产出（网关/冷却）也会被说成"可能被截断"**，
 * 于是操作员去查一个不存在的预算问题，真因没人看 ——
 * 与"把故障说成观望"是同一个病的另一种方向。
 *
 * ## 为什么用真实组件渲染（而不是断言常量表）
 *
 * 常量表对了、组件没接上，屏幕上照样是一句旧话 —— 那是**只在屏幕上**存在的 bug
 *（typecheck / build / 单测全绿）。`renderToStaticMarkup` 断言的是**渲染结果里的字**，
 * 这正是要钉住的东西。做法与 `TeamBoard/boardRender.test.ts` 一致。
 *
 * ## ⚠️ 判据不手抄：输入字符串从 `deskOutput.ts` 里读
 *
 * 本测试要的是"真实原文 → 渲染出的文案"。若手抄 fixture，后端改文案后
 * 这里会拿一段**已经不存在的文本**去跑，测试仍然绿 —— 那就变成空转。
 * 所以下面从后端源码抽出真实报告行（与 `decisionZeroState.test.ts` 同一套判据，
 * 那份测试负责"抽取"本身的校准）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { DecisionRecord } from '@aq/shared';

import { classifyZeroDecision, type ZeroDecisionKind } from './decisionZeroState';
import { ZERO_DECISION_COPY } from './decisionZeroStateCopy';
import { DecisionAuditView } from './DecisionDetailPage';

/*
 * ⚠️ `react-router` 的 `MemoryRouter` / `Link` 在服务端渲染时用 `useLayoutEffect`，
 * React 会打印 "useLayoutEffect does nothing on the server" 警告 ——
 * 那是**预期内的**（本测试只做静态渲染、不 hydrate），但每一行渲染都打一条会淹没输出，
 * 让人以为出了别的问题。这里只滤掉这一条，**其它 console.error 原样放行**
 * （吞掉全部错误会让真正的警告也消失 —— 那是这个仓库最怕的那种"安静"）。
 */
const originalConsoleError = console.error;
console.error = (...args: unknown[]): void => {
  if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return;
  originalConsoleError(...args);
};

/* -------------------------------------------------------------------------- */
/*  真实原文：从 deskOutput.ts 抽                                                        */
/* -------------------------------------------------------------------------- */

const DESK = readFileSync(
  fileURLToPath(new URL('../../../server/src/trader/agent/deskOutput.ts', import.meta.url)),
  'utf8',
);

/**
 * 抽出 `lines.push(` 里的候选报告行（含三元两分支）。
 *
 * ⚠️ 与 `decisionZeroState.test.ts` 是**同一套判据**。这里没有共用模块是因为
 * `packages/web/src` 下没有测试工具目录，而为本任务新开一个模块会扩大范围；
 * 若第三处需要它，应当抽到 `src/` 下的非测试模块（与 `configWiringGuard.test.ts` 里
 * 那条"将来抽出去"的注释同一个处理方式）。
 */
function reportLines(): string[] {
  const readOperand = (source: string, i: number): [string, number] | null => {
    const quote = source[i]!;
    let piece = '';
    let j = i + 1;
    while (j < source.length) {
      const c = source[j]!;
      if (c === '\\') {
        const next = source[j + 1] ?? '';
        piece += next === 'n' ? '\n' : next;
        j += 2;
        continue;
      }
      if (quote === '`' && c === '$' && source[j + 1] === '{') {
        const close = source.indexOf('}', j);
        if (close < 0) return null;
        piece += '∎';
        j = close + 1;
        continue;
      }
      if (c === quote) return [piece, j + 1];
      if (quote === "'" && c === '\n') return null;
      piece += c;
      j += 1;
    }
    return null;
  };

  const out: string[] = [];
  for (const m of DESK.matchAll(/lines\.push\(/g)) {
    const source = DESK.slice(m.index + m[0].length, m.index + m[0].length + 6_000);
    let i = source.search(/['"`]/);
    if (i < 0) continue;
    let group = '';
    let saw = false;
    while (i < source.length) {
      const ch = source[i]!;
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (/['"`]/.test(ch)) {
        const read = readOperand(source, i);
        if (read === null) break;
        const [piece, next] = read;
        if (piece.startsWith('⚠️ 裁决')) saw = true;
        group += piece;
        i = next;
        continue;
      }
      if (ch === '?' || ch === ':') {
        if (saw && group.length > 0) out.push(group);
        group = '';
        saw = false;
        i += 1;
        continue;
      }
      if (ch === '+') {
        i += 1;
        continue;
      }
      break;
    }
    if (saw && group.length > 0) out.push(group);
    if (out.length >= 12) break;
  }
  return out;
}

const REPORT_LINES = reportLines();

/** 按分类取一条真实原文。找不到就断言失败（而不是返回空串，那会静默假绿）。 */
function rawOf(kind: ZeroDecisionKind): string {
  const hit = REPORT_LINES.find((r) => classifyZeroDecision(r) === kind);
  assert.ok(
    hit !== undefined,
    `★ deskOutput.ts 里找不到分类为 ${kind} 的报告行 —— ` +
      `后端文案或分类器改了。当前抽到 ${REPORT_LINES.length} 条：\n` +
      REPORT_LINES.map((r) => `      · ${classifyZeroDecision(r)}: ${r.slice(0, 50)}…`).join('\n'),
  );
  return hit;
}

/* -------------------------------------------------------------------------- */
/*  夹具与渲染                                                                   */
/* -------------------------------------------------------------------------- */

/** 一个"零决策"的决策记录 —— 只有 `decisions` 与 `rawResponse` 参与本次判据。 */
function emptyDecisionRecord(rawResponse: string): DecisionRecord {
  return {
    id: 1,
    traderId: 11,
    cycleNumber: 42,
    timestamp: new Date(Date.UTC(2026, 9, 15, 9, 50, 21)).toISOString(),
    systemPrompt: '',
    userPrompt: '',
    cotTrace: '',
    decisions: [],
    rawResponse,
    executionLog: [],
    candidateSymbols: [],
    success: true,
    error: null,
    aiLatencyMs: 1000,
    promptTokens: 1,
    completionTokens: 1,
  };
}

/** 渲染单条记录，返回**可见文字**（剥标签 —— 否则会读到属性里的字，判据就变成假绿/假红）。 */
function renderText(rawResponse: string): string {
  /*
   * ⚠️ 必须包一层路由器：`DecisionAuditView` 的头部有个 `<Link>` 回机器人面板，
   * 直接渲染会抛 `Cannot destructure property 'basename' of useContext(...) as it is null`。
   * 用 `MemoryRouter`（`react-router-dom` 在 Node 下可用的入口；v7 的主入口**不导出**
   * `react-router-dom/server`，实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。
   */
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/traders/11/decisions/1'] },
      createElement(DecisionAuditView, { record: emptyDecisionRecord(rawResponse), traderId: 11 }),
    ),
  );
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    /*
     * ⚠️ 去掉 markdown 粗体标记：页面**不渲染 markdown**（这些 `**` 是原样显示的字符）。
     * 断言前两边都归一化，于是判据对"字的改动"敏感、对"只是挪了粗体标记"不敏感。
     */
    .replace(/\*\*/g, '');
}

/* -------------------------------------------------------------------------- */
/*  0. 前置断言：语料与分类都真的可用                                              */
/* -------------------------------------------------------------------------- */

test('★★★ 前置：五态都能从后端真实原文里各取到一条（否则下面是空转或假绿）', () => {
  const kinds: ZeroDecisionKind[] = [
    'bad-json',
    'no-block-truncated',
    'no-block-no-output',
    'not-decisions',
    'no-block-judgment',
  ];
  const missing = kinds.filter((k) => !REPORT_LINES.some((r) => classifyZeroDecision(r) === k));
  assert.deepEqual(
    missing,
    [],
    `★ 这些状态在后端真实原文里取不到样本：${missing.join(', ')} —— 抽取或分类器失效了`,
  );
});

/* -------------------------------------------------------------------------- */
/*  1. 四类故障各渲染出**不同**的文案                                              */
/* -------------------------------------------------------------------------- */

test('★★★ 四类故障必须在界面上说四句不同的话（不是都叫"可能被截断"）', () => {
  /*
   * 每一类都断言"它自己的判别句"必须出现 —— 这是**正向**判据。
   * 只断言"四段文字互不相同"是不够的：把两个状态的文案整体对调，也满足"不同"。
   */
  const expectations: Array<[ZeroDecisionKind, string]> = [
    /* 截断：保留"查 max_tokens"这个正确结论 */
    ['bad-json', '被截断'],
    /* 写到围栏就停：只说现象，不断言 token 上限 */
    ['no-block-truncated', '没有写完数组'],
    /* 无产出：必须指向网关/冷却，而不是预算 */
    ['no-block-no-output', '没有产出'],
    /* 抓错数组：必须说明那不是它的决策 */
    ['not-decisions', '不是决策数组'],
  ];

  for (const [kind, marker] of expectations) {
    const text = renderText(rawOf(kind));
    assert.ok(text.includes(marker), `★ ${kind} 渲染出的文案里缺「${marker}」：\n${text.slice(0, 400)}`);
    /* 它自己的 detail 也必须渲染（否则表里写了、屏幕上没有） */
    const detailMarker = ZERO_DECISION_COPY[kind].detail.replace(/\*\*/g, '').slice(0, 24);
    assert.ok(
      text.includes(detailMarker),
      `★ ${kind} 的说明文字没有渲染出来（缺「${detailMarker}」）`,
    );
  }
});

test('★★★ 预算那句话只能出现在截断类上（否则操作员又被指去查 max_tokens）', () => {
  /*
   * ⚠️ 这是本次任务的核心边界：
   * ```
   *   bad-json             → 查输出预算（对）
   *   no-block-no-output   → 查网关/冷却/额度，**不是预算**（错的指向会误导排查）
   * ```
   * 所以"max_tokens"这个词**只允许**出现在真正与预算有关的那一类里。
   */
  assert.ok(
    renderText(rawOf('bad-json')).includes('max_tokens'),
    '★ 截断类必须保留"查输出预算"这个结论（它是对的）',
  );
  const noOutput = renderText(rawOf('no-block-no-output'));
  assert.ok(
    !noOutput.includes('max_tokens'),
    `★ "裁决官没有产出"不是预算问题 —— 不能把操作员指向 max_tokens：\n${noOutput.slice(0, 400)}`,
  );
  assert.ok(noOutput.includes('网关'), '★ 无产出这一类必须指向网关/冷却/额度');
});

test('★★★ 判断（观望）保持中性，并且不落任何"故障"的文案', () => {
  const text = renderText(rawOf('no-block-judgment'));
  assert.ok(text.includes('观望或持仓'), `★ 判断态应当保持原来那句：\n${text.slice(0, 300)}`);
  /* 判断态不能出现"故障"类字样 */
  for (const bad of ['被截断', '没有产出', '不是决策数组']) {
    assert.ok(!text.includes(bad), `★ 判断态里不该出现故障措辞「${bad}」：\n${text.slice(0, 300)}`);
  }
});

/* -------------------------------------------------------------------------- */
/*  2. 反向守卫：表被改坏/对调必须变红                                             */
/* -------------------------------------------------------------------------- */

test('★★★ 五条文案必须两两不同（对调任意两条都要能被发现）', () => {
  /*
   * ## 为什么这条测试能抓"对调"
   *
   * 上面几条断言的是"某一类**必须**出现某句话"。若有人把 `bad-json` 与
   * `no-block-no-output` 的 headline 对调：
   * ```
   *   bad-json 那一条就再也渲染不出「被截断」        → 上面第 1 条红
   *   no-block-no-output 会渲染出「max_tokens」      → 上面第 2 条红
   * ```
   * 这一条补的是另一类错误：**表内部重复**（两条文案一字不差），
   * 那会让界面上两个不同成因长得一模一样 —— 用户分不出来。
   *
   * ⚠️ 判据取「headline + detail」，且**归一掉 markdown 粗体**：
   * 只有 `**` 位置不同、字面相同的两条，在屏幕上就是同一句话。
   */
  const rendered = (Object.keys(ZERO_DECISION_COPY) as ZeroDecisionKind[]).map((kind) => ({
    kind,
    text: renderText(rawOf(kind)),
  }));
  for (let a = 0; a < rendered.length; a += 1) {
    for (let b = a + 1; b < rendered.length; b += 1) {
      const sameHeadline =
        ZERO_DECISION_COPY[rendered[a]!.kind].headline.replace(/\*\*/g, '') ===
        ZERO_DECISION_COPY[rendered[b]!.kind].headline.replace(/\*\*/g, '');
      assert.ok(
        !sameHeadline,
        `★ ${rendered[a]!.kind} 与 ${rendered[b]!.kind} 的 headline 一字不差 —— 界面上分不出来`,
      );
      assert.notEqual(
        rendered[a]!.text,
        rendered[b]!.text,
        `★ ${rendered[a]!.kind} 与 ${rendered[b]!.kind} 渲染出了完全相同的文字`,
      );
    }
  }
});

test('★★ 渲染出的文案确实随输入变化（不是把某一句话写死在组件里）', () => {
  /*
   * 反向守卫的最小版本：两条**不同成因**的记录，渲染结果必须不同。
   * 若组件里写死了一句 `return <p>输出解析失败（可能被截断）</p>`，这一条会红。
   */
  const a = renderText(rawOf('bad-json'));
  const b = renderText(rawOf('no-block-no-output'));
  assert.notEqual(a, b, '★ 两种成因渲染出了同一段文字 —— 分类没被用上');
});
